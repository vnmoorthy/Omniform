// ---------------------------------------------------------------------------
// OmniForm director — Math service + ADK Director Agent.
//
//   user ─▶ runOmniformPipeline
//                ├─ runMathStep (Interactions API, multimodal video pass)
//                │       └─ ai.interactions.create() on gemini-3.5-flash
//                └─ DirectorAgent (ADK LlmAgent with outputSchema)
//                        └─ composes final coaching + overlay plan
//
// Why no LlmAgent for the math step: ADK's LlmAgent shortcuts the tool call
// when the LLM thinks it can answer from prompt context. To guarantee the
// multimodal pass actually runs, we invoke the Interactions API directly
// and hand the structured findings to the Director Agent as its user input.
// The Director Agent is a real ADK LlmAgent with outputSchema enforcement —
// that's where the agentic structured-output story lives.
// ---------------------------------------------------------------------------
import {
  LlmAgent,
  InMemorySessionService,
  Runner,
} from "@google/adk";
import { z } from "zod/v3";

const APP_NAME = "omniform-analyzer";
const SESSION_USER = "athlete";

// Math step output — what the Interactions API returns and what the Director
// agent consumes.
const BIOMECHANICS_SCHEMA = z.object({
  kineticChainSummary: z.string(),
  primaryFinding: z.string(),
  powerLeakLocation: z.string().optional(),
  jointHighlights: z.array(z.string()),
});

// Overlay plan — server-computed visualization directives the frontend renders
// on top of MediaPipe-detected joint positions. Joint enum maps 1:1 to
// MediaPipe BlazePose landmarks (23–28).
const OVERLAY_JOINT = z.enum([
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
]);
const OVERLAY_TREATMENT = z.enum(["highlight", "warning", "vector"]);
const OVERLAY_COLOR = z.enum(["cyan", "magenta", "yellow"]);

const OVERLAY_ENTRY_SCHEMA = z.object({
  joint: OVERLAY_JOINT,
  treatment: OVERLAY_TREATMENT,
  color: OVERLAY_COLOR,
  label: z.string().max(40).optional(),
  // Optional corrective "ghost path": the DIRECTION the joint should move,
  // as a fraction of frame size (dx, dy in roughly -0.15..0.15). Drawn by the
  // frontend as an arrow anchored to the REAL MediaPipe joint position, so it
  // can never float off the body — it's directional guidance, not a guessed
  // coordinate.
  correction: z
    .object({
      dx: z.number(),
      dy: z.number(),
      note: z.string().max(40).optional(),
    })
    .optional(),
});

const FINAL_OUTPUT_SCHEMA = z.object({
  agentAudioScript: z.string().min(10).max(400),
  omniVideoPrompt: z.string().min(10).max(600),
  overlayPlan: z.array(OVERLAY_ENTRY_SCHEMA).max(6),
  // Prompt that the Veo video model uses to generate the "correct technique"
  // reference clip the user is auto-shown after analysis. When the user's own
  // video is passed to Veo as an image-to-video reference, this prompt should
  // animate THEM doing the corrected motion. Optional so a partial Director
  // run still parses through the schema.
  correctionVideoPrompt: z.string().min(20).max(1000).optional(),
});

// The Interactions API rejects mime types outside this enum. Curl uploads
// often come in as application/octet-stream; default to video/webm (what
// MediaRecorder ships) when we get anything unexpected.
const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);
function normalizeVideoMime(mime) {
  return ALLOWED_VIDEO_MIMES.has(mime) ? mime : "video/webm";
}

// The Interactions API has no top-level text field — model output lives in
// `steps` as `model_output` steps whose `content` is an array of typed parts.
function extractInteractionText(interaction) {
  const steps = interaction?.steps;
  if (!Array.isArray(steps)) return "";
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type === "model_output" && Array.isArray(step.content)) {
      const textPart = step.content.find(
        (c) => c?.type === "text" && typeof c.text === "string"
      );
      if (textPart?.text) return textPart.text;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Math step — the multimodal pass. Called once per request, before the
// Director Agent. Returns BIOMECHANICS_SCHEMA-shaped findings.
// ---------------------------------------------------------------------------
async function runMathStep({ ai, model, videoFile, metricsContext }) {
  const input = [
    {
      type: "text",
      text:
        "You are a human-movement biomechanics engine. Analyze the attached video clip of a person moving — this could be ANY activity: an athletic skill (soccer strike, golf swing, jump shot, deadlift, sprint), a gait pattern (walking, running, climbing stairs), a posture (sitting, standing, lifting), or a rehab/PT movement. " +
        "Detect what movement is being performed, then assess kinetic-chain quality for THAT movement. " +
        "Identify the single most actionable finding (e.g. asymmetric load, forward head posture, premature heel-strike, knee valgus, shoulder elevation, overstriding). " +
        "Locate any power-leak or load-imbalance and list the joints whose markers an overlay should emphasize. " +
        "Joint names MUST be one of: leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle. " +
        "Respond with ONLY a JSON object matching: " +
        '{"kineticChainSummary": string, "primaryFinding": string, "powerLeakLocation"?: string, "jointHighlights": string[]}. ' +
        "The kineticChainSummary should name the activity in its first clause (e.g. \"Walking gait shows…\", \"Squat descent shows…\", \"Soccer strike kinetic chain shows…\"). " +
        (metricsContext || ""),
    },
  ];

  if (videoFile?.buffer?.length) {
    input.push({
      type: "video",
      data: videoFile.buffer.toString("base64"),
      mime_type: normalizeVideoMime(videoFile.mimetype),
    });
  }

  const interaction = await ai.interactions.create({
    model,
    input,
    response_format: { type: "text", mime_type: "application/json" },
    generation_config: { temperature: 0.4 },
  });

  const raw = extractInteractionText(interaction);
  if (!raw) {
    throw new Error("Interactions API returned no model_output text.");
  }
  const findings = BIOMECHANICS_SCHEMA.parse(JSON.parse(raw));
  process.stdout.write(
    JSON.stringify({
      severity: "INFO",
      message: "math step ran",
      service: "omniform-analyzer",
      jointHighlights: findings.jointHighlights.length,
      timestamp: new Date().toISOString(),
    }) + "\n"
  );
  return findings;
}

// ---------------------------------------------------------------------------
// DirectorAgent — ADK LlmAgent. Consumes math findings (passed via the user
// message), emits FINAL_OUTPUT_SCHEMA-shaped coaching + overlay plan.
// ---------------------------------------------------------------------------
function buildDirectorAgent({ model }) {
  return new LlmAgent({
    name: "director_agent",
    description:
      "Composes the final coaching script, visual overlay prompt, and concrete overlay plan from biomechanics findings.",
    model,
    instruction: `You are the Director Agent in the OmniForm pipeline. The user message contains the Math service's biomechanics findings as JSON (kineticChainSummary, primaryFinding, powerLeakLocation, jointHighlights). The movement could be ANY human activity — a sport skill, a gait pattern, a posture, a lift, rehab work. Read kineticChainSummary's opening clause to know what activity you're coaching.

Produce a SINGLE compact JSON object (no markdown fences, no commentary, total ≤ 1800 tokens) with exactly four fields:

1. "agentAudioScript" (string, 1-2 sentences): authoritative coaching feedback addressed to the person performing the movement (use "your" — works for sport, gait, posture, lift). Reference measured numbers verbatim when present.

2. "omniVideoPrompt" (string, ≤ 80 words): how the overlay of glowing vector lines should emphasize the joint highlights.

3. "overlayPlan" (array of 2-5 entries): render directives drawn on MediaPipe joint positions. Each entry { joint, treatment, color, label?, correction? }:
   - joint: "leftHip" | "rightHip" | "leftKnee" | "rightKnee" | "leftAnkle" | "rightAnkle"
   - treatment: "highlight" (focus) | "warning" (issue) | "vector" (force/motion arrow)
   - color: "cyan" (focus) | "magenta" (warning/asymmetry) | "yellow" (power/velocity)
   - label (optional, ≤ 40 chars): e.g. "120°", "Power leak"
   - correction (optional, only for the 1-2 most actionable joints): { dx, dy, note? } where dx/dy ∈ -0.15..0.15 fractions of frame size (dx>0 right, dy>0 down). note ≤ 40 chars.
   Use warning+magenta (with correction) for asymmetries, highlight+cyan for measured-value markers, vector+yellow for velocity/force. Joints must come from Math service's jointHighlights.

4. "correctionVideoPrompt" (string, 30-150 words): a Veo image-to-video prompt. The user's first video frame is passed as the reference image, so describe the SAME PERSON in the SAME SETTING executing the corrected version of the SAME activity (sport skill, walk, sit-to-stand, squat, whatever was detected). Cover:
   - the specific corrected biomechanics that fix primaryFinding (e.g. "even bilateral knee extension to 145°", "engaged hip rotation through the strike", "midfoot strike with relaxed shoulders", "neutral pelvis throughout the descent")
   - cinematic side-profile camera, smooth slow-motion, instructional tone
   - explicit "no text overlays, no captions, no watermarks"
   Open with: "The same person from the reference frame performs the corrected [activity]: ..."

Output ONLY the JSON object.`,
    // outputSchema intentionally OMITTED — ADK serializes it into the model's
    // context which bloats token budget; we validate manually in
    // runOmniformPipeline below.
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    generateContentConfig: {
      temperature: 0.6,
      responseMimeType: "application/json",
      // Hard cap so a runaway generation can't blow the JSON parser.
      maxOutputTokens: 2048,
    },
  });
}

// ---------------------------------------------------------------------------
// Public entrypoint — invoked once per /api/analyze request.
// ---------------------------------------------------------------------------
export async function runOmniformPipeline({
  ai,
  model,
  videoFile,
  audioFile, // accepted for API symmetry; not sent to Interactions API (mime not in enum)
  metricsContext,
}) {
  // Step 1: Math service. Heavy multimodal pass via the Interactions API.
  const findings = await runMathStep({ ai, model, videoFile, metricsContext });

  // Step 2: Director Agent (ADK LlmAgent). Composes structured final output.
  const directorAgent = buildDirectorAgent({ model });
  const runner = new Runner({
    appName: APP_NAME,
    agent: directorAgent,
    sessionService: new InMemorySessionService(),
  });

  const events = runner.runEphemeral({
    userId: SESSION_USER,
    newMessage: {
      role: "user",
      parts: [
        {
          text: `Math service findings (JSON):\n${JSON.stringify(findings)}`,
        },
      ],
    },
  });

  let finalText = "";
  for await (const event of events) {
    const parts = event.content?.parts ?? [];
    for (const part of parts) {
      if (part.text && event.author === "director_agent") {
        finalText = part.text;
      }
    }
  }

  if (!finalText) {
    throw new Error("Director agent produced no output.");
  }

  const directorOutput = FINAL_OUTPUT_SCHEMA.parse(JSON.parse(finalText));
  return {
    ...directorOutput,
    mathFindings: findings,
  };
}
