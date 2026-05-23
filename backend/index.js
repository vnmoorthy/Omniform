import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { runOmniformPipeline } from "./agents/director.js";
import {
  kickoffCorrectionVideo,
  pollCorrectionVideo,
} from "./agents/veo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const NODE_ENV = process.env.NODE_ENV || "development";

// ---------------------------------------------------------------------------
// Structured logger — Cloud Run auto-parses JSON stdout into Cloud Logging
// with the `severity` field mapped to the entry's level. Local dev keeps the
// JSON line as-is; `gcloud run logs read --format=json` (or the Cloud Logs
// Explorer) renders it cleanly. Setting LOG_FORMAT=pretty falls back to a
// single-line summary for terminal readability.
// ---------------------------------------------------------------------------
const LOG_FORMAT = process.env.LOG_FORMAT || (NODE_ENV === "development" ? "pretty" : "json");
function emitLog(severity, message, extras) {
  const entry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    service: "omniform-analyzer",
    ...(extras || {}),
  };
  if (LOG_FORMAT === "json") {
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const extra = extras ? " " + JSON.stringify(extras) : "";
    process.stdout.write(`[${severity}] ${message}${extra}\n`);
  }
}
const log = {
  debug: (m, x) => emitLog("DEBUG", m, x),
  info: (m, x) => emitLog("INFO", m, x),
  warn: (m, x) => emitLog("WARNING", m, x),
  error: (m, x) => emitLog("ERROR", m, x),
};

// ---------------------------------------------------------------------------
// Static asset folder. Holds short-lived TTS audio clips + Veo-generated
// correction reference videos. The user's recorded video is replayed from
// the frontend's in-memory blob and is never persisted server-side.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const AUDIO_DIR = path.join(PUBLIC_DIR, "audio");
const CORRECTIONS_DIR = path.join(PUBLIC_DIR, "corrections");
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(CORRECTIONS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Data pipeline — BigQuery-shape JSONL log of every analyze call. Production
// deployment: a Cloud Function listens on this directory (or a GCS bucket
// when DATA_BUCKET is set) and streams rows into BigQuery via the storage
// write API. For the hackathon demo, the JSONL itself IS the data flywheel:
// one append-only file, ready to `bq load --source_format=NEWLINE_DELIMITED_JSON`.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const ANALYSES_JSONL = path.join(DATA_DIR, "analyses.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });

function logAnalysisToPipeline(row) {
  try {
    fs.appendFileSync(ANALYSES_JSONL, JSON.stringify(row) + "\n");
  } catch (err) {
    // Never let pipeline-log failures break the user-facing request.
    log.error("pipeline log failed", { error: err?.message || String(err) });
  }
}

// Asset retention: synthesized voice clips + Veo correction videos hold
// derived user data. Sweep anything older than RETENTION_MS every SWEEP_MS to
// bound the on-disk window.
const RETENTION_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_MS = 15 * 60 * 1000; // 15 minutes
function sweepDir(dir, label) {
  const now = Date.now();
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > RETENTION_MS) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // file disappeared between readdir and stat — fine
    }
  }
  if (removed) log.info(`${label} sweep removed expired files`, { removed });
}
setInterval(() => {
  sweepDir(AUDIO_DIR, "audio");
  sweepDir(CORRECTIONS_DIR, "corrections");
}, SWEEP_MS).unref();

// ---------------------------------------------------------------------------
// Google Gen AI client
//   - Vertex AI mode (Google Cloud):  GOOGLE_GENAI_USE_VERTEXAI=true
//     + GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION (uses ADC credentials)
//   - Gemini Developer API mode:      GEMINI_API_KEY=<key>
// ---------------------------------------------------------------------------
const useVertex =
  String(process.env.GOOGLE_GENAI_USE_VERTEXAI).toLowerCase() === "true";
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

let ai = null;
let aiMode = "mock";

if (useVertex && process.env.GOOGLE_CLOUD_PROJECT) {
  ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
  });
  aiMode = "vertex-ai";
} else if (apiKey) {
  ai = new GoogleGenAI({ apiKey });
  aiMode = "gemini-api";
}

// ---------------------------------------------------------------------------
// Google Cloud Text-to-Speech (the agent's voice)
//   Needs an API key with the Cloud Text-to-Speech API enabled.
//   Falls back to the browser's SpeechSynthesis on the client if unset.
// ---------------------------------------------------------------------------
const ttsApiKey = process.env.GOOGLE_TTS_API_KEY || apiKey;
// Default to Google's newest Chirp 3: HD voices; override per .env if needed.
const TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Chirp3-HD-Charon";

// ---------------------------------------------------------------------------
// Security guardrails (see /cso findings 1, 4, 7)
//   - ALLOWED_ORIGIN — comma-separated origins that may call the API. Default
//     allows localhost dev. Set this in prod to your frontend URL.
//   - DEMO_TOKEN     — shared secret the frontend includes as X-Demo-Token.
//     Optional in local dev; required in any environment that sets it.
//   - rate limit     — per-IP request cap on /api/analyze.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ||
  "http://localhost:3000,http://localhost:8080")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEMO_TOKEN = process.env.DEMO_TOKEN || "";

function requireDemoToken(req, res, next) {
  if (!DEMO_TOKEN) return next(); // local dev: no token configured, allow
  if (req.get("X-Demo-Token") === DEMO_TOKEN) return next();
  return res.status(401).json({ error: "Missing or invalid X-Demo-Token." });
}

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests per minute per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Try again in a minute." },
});

// Veo generation is expensive per request — apply a tighter cap.
const veoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3, // 3 kickoffs/min/IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Veo generation rate limit exceeded. Try again in a minute." },
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // Cloud Run sits behind a proxy; trust X-Forwarded-For for rate limit keying
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: false,
    maxAge: 86400,
  })
);
// Serve clips with a cross-origin resource policy so the frontend's pose
// overlay can draw the playback onto a canvas without tainting it.
app.use(
  "/public",
  express.static(PUBLIC_DIR, {
    setHeaders: (res) =>
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
  })
);

// In-memory multipart handling for the incoming video + audio blobs
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB safety cap
});

// Used when no model is configured or the call fails - keeps the demo alive.
const FALLBACK = {
  agentAudioScript:
    "Your kinetic chain sequences cleanly from hip to ankle, but power leaks slightly at plant-foot contact where the knee over-extends. Drive your core rotation through the strike to convert more angular velocity into the follow-through.",
  omniVideoPrompt:
    "Overlay glowing cyan vector lines tracing the hip, knee, and ankle joints, add a rotating force arc at the plant foot, and streak a velocity gradient along the kicking leg through full follow-through.",
  overlayPlan: [
    { joint: "leftHip", treatment: "vector", color: "yellow", label: "Rotation" },
    { joint: "leftKnee", treatment: "highlight", color: "cyan", label: "Kinetic chain" },
    { joint: "leftAnkle", treatment: "warning", color: "magenta", label: "Plant foot" },
  ],
  correctionVideoPrompt:
    "An athlete demonstrating the corrected soccer-strike technique in slow-motion side profile: driving the hip through the strike with even bilateral knee extension, plant foot firmly grounded with the kicking leg following through cleanly above shoulder height. Cinematic instructional tone, smooth athletic form, no text overlays.",
};

// Strip the incoming JSON down to a fixed set of bounded numeric fields. Any
// non-finite or out-of-range value is dropped silently. This is the boundary
// that prevents user-controlled string content from reaching the LLM's
// instruction (see /cso finding 4 — prompt injection via metrics).
function sanitizeMetrics(raw) {
  if (!raw || typeof raw !== "object") return null;
  const inRange = (v, min, max) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const out = {};
  if (inRange(raw.leftKneeAngle, 0, 360))
    out.leftKneeAngle = Math.round(raw.leftKneeAngle);
  if (inRange(raw.rightKneeAngle, 0, 360))
    out.rightKneeAngle = Math.round(raw.rightKneeAngle);
  if (inRange(raw.peakAngularVelocity, 0, 5000))
    out.peakAngularVelocity = Math.round(raw.peakAngularVelocity);
  return Object.keys(out).length ? out : null;
}

function buildGroundingText(metrics) {
  if (!metrics) return "";
  const bits = [];
  if (metrics.leftKneeAngle != null)
    bits.push(`left knee angle ${metrics.leftKneeAngle} degrees`);
  if (metrics.rightKneeAngle != null)
    bits.push(`right knee angle ${metrics.rightKneeAngle} degrees`);
  if (metrics.peakAngularVelocity != null)
    bits.push(`peak knee angular velocity ${metrics.peakAngularVelocity} deg/s`);
  if (bits.length === 0) return "";
  return ` Measured on-device via MediaPipe pose estimation: ${bits.join(
    ", "
  )}. Treat these measured values as ground truth and reference them in your assessment; do not invent contradicting numbers.`;
}

const SYSTEM_PROMPT = `You are an expert sports kinematics engine. Analyze this video clip of an athletic movement (such as a soccer strike). Calculate the angular velocity and force vectors using standard physics equations. Output a strict JSON object containing two fields:
   1. 'agentAudioScript': A concise, authoritative 2-sentence coaching feedback assessing the kinetic chain and power transfer.
   2. 'omniVideoPrompt': A descriptive visual generation prompt outlining how to overlay glowing vector lines precisely onto the subject's joints.`;

// Direct single-call Gemini path (generateContent). Used as the resilient
// middle-tier fallback when the ADK multi-agent pipeline (which routes through
// the experimental Interactions API) is unavailable or errors.
async function runAnalysis({ videoFile, audioFile, metrics }) {
  if (!ai) {
    log.warn("no model configured, returning mock feedback", {
      hint: "set GEMINI_API_KEY or Vertex AI vars",
    });
    return { ...FALLBACK };
  }

  const parts = [
    {
      text:
        "Analyze the attached athletic motion clip and accompanying audio narration. Respond with ONLY the JSON object defined in the system instruction." +
        buildGroundingText(metrics),
    },
  ];
  if (videoFile) {
    parts.push({
      inlineData: {
        mimeType: videoFile.mimetype || "video/webm",
        data: videoFile.buffer.toString("base64"),
      },
    });
  }
  if (audioFile) {
    parts.push({
      inlineData: {
        mimeType: audioFile.mimetype || "audio/webm",
        data: audioFile.buffer.toString("base64"),
      },
    });
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      temperature: 0.4,
    },
  });

  const parsed = JSON.parse((response.text ?? "").trim());
  return {
    agentAudioScript: parsed.agentAudioScript || FALLBACK.agentAudioScript,
    omniVideoPrompt: parsed.omniVideoPrompt || FALLBACK.omniVideoPrompt,
    // The direct generateContent path doesn't ask the model for an overlay
    // plan or correction-video prompt, so we reuse the static fallback to
    // keep the response shape stable.
    overlayPlan: FALLBACK.overlayPlan,
    correctionVideoPrompt: FALLBACK.correctionVideoPrompt,
    mathFindings: null,
  };
}

// Synthesize the coaching script into speech with Google Cloud Text-to-Speech.
// Returns a public MP3 URL, or null so the client can fall back to browser TTS.
async function synthesizeSpeech(text, req) {
  if (!ttsApiKey || !text) return null;
  try {
    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${ttsApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "en-US", name: TTS_VOICE },
          audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0 },
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const projectMatch = body.match(/projects?[\/\s]+(\d+)/i);
      const project = projectMatch?.[1];
      if (body.includes("SERVICE_DISABLED") || body.includes("API has not been used")) {
        const enableUrl = project
          ? `https://console.developers.google.com/apis/api/texttospeech.googleapis.com/overview?project=${project}`
          : "https://console.developers.google.com/apis/library/texttospeech.googleapis.com";
        log.error("Cloud TTS API disabled, falling back to browser SpeechSynthesis", {
          remediation: enableUrl,
          project,
        });
      } else if (body.includes("API_KEY_SERVICE_BLOCKED") || body.includes("are blocked")) {
        const credUrl = project
          ? `https://console.cloud.google.com/apis/credentials?project=${project}`
          : "https://console.cloud.google.com/apis/credentials";
        log.error(
          "Cloud TTS blocked by API key restrictions, falling back to browser SpeechSynthesis",
          {
            remediation: credUrl,
            hint: "or set GOOGLE_TTS_API_KEY to a separate unrestricted key",
            project,
          }
        );
      } else {
        log.error("Cloud TTS failed", { status: resp.status, body });
      }
      return null;
    }
    const data = await resp.json();
    if (!data.audioContent) return null;
    const filename = `${randomUUID()}.mp3`;
    fs.writeFileSync(
      path.join(AUDIO_DIR, filename),
      Buffer.from(data.audioContent, "base64")
    );
    return `${req.protocol}://${req.get("host")}/public/audio/${filename}`;
  } catch (err) {
    log.error("Cloud TTS error", { error: err?.message || String(err) });
    return null;
  }
}

// Health probe (Cloud Run readiness + liveness). /healthz alias matches the
// k8s convention some platforms probe by default.
function healthHandler(_req, res) {
  res.json({
    status: "ok",
    model: MODEL,
    mode: aiMode,
    tts: Boolean(ttsApiKey),
  });
}
app.get("/health", healthHandler);
app.get("/healthz", healthHandler);

app.post(
  "/api/analyze",
  requireDemoToken,
  analyzeLimiter,
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]),
  async (req, res) => {
    const startedAt = Date.now();
    const analysisId = randomUUID();
    let source = "static-fallback";
    try {
      const videoFile = req.files?.video?.[0] || null;
      const audioFile = req.files?.audio?.[0] || null;

      // Sanitize metrics at the boundary. Dropped if not finite-numeric and
      // in-range — keeps user-controlled strings out of the agent instruction.
      let metrics = null;
      if (req.body?.metrics) {
        let raw;
        try {
          raw = JSON.parse(req.body.metrics);
        } catch {
          raw = null;
        }
        metrics = sanitizeMetrics(raw);
      }

      // No server-side video echo: the frontend replays its own captured blob
      // via URL.createObjectURL, so user PII never persists on the server.

      let analysis;
      if (ai) {
        try {
          analysis = await runOmniformPipeline({
            ai,
            model: MODEL,
            videoFile,
            audioFile,
            metricsContext: buildGroundingText(metrics),
          });
          source = "adk-interactions";
        } catch (adkErr) {
          log.error("ADK pipeline failed, falling back to direct generateContent", {
            error: adkErr?.message || String(adkErr),
            analysisId,
          });
          try {
            analysis = await runAnalysis({ videoFile, audioFile, metrics });
            source = "direct-generatecontent";
          } catch (genErr) {
            log.error("direct analysis failed, using static fallback", {
              error: genErr?.message || String(genErr),
              analysisId,
            });
            analysis = { ...FALLBACK, mathFindings: null };
            source = "static-fallback";
          }
        }
      } else {
        analysis = await runAnalysis({ videoFile, audioFile, metrics });
        source = "mock-no-key";
      }

      const agentAudioUrl = await synthesizeSpeech(
        analysis.agentAudioScript,
        req
      );

      const overlayPlan =
        Array.isArray(analysis.overlayPlan) && analysis.overlayPlan.length
          ? analysis.overlayPlan
          : FALLBACK.overlayPlan;

      const latencyMs = Date.now() - startedAt;

      res.json({
        analysisId,
        agentAudioScript: analysis.agentAudioScript,
        omniVideoPrompt: analysis.omniVideoPrompt,
        overlayPlan,
        correctionVideoPrompt: analysis.correctionVideoPrompt || null,
        agentAudioUrl,
        model: MODEL,
        source,
        latencyMs,
      });

      log.info("analyze completed", {
        analysisId,
        source,
        latencyMs,
        ttsEnabled: Boolean(agentAudioUrl),
        joints: overlayPlan.length,
        veoPromptEmitted: Boolean(analysis.correctionVideoPrompt),
      });

      // BigQuery-shape pipeline log. Append-only; never blocks the response.
      logAnalysisToPipeline({
        analysis_id: analysisId,
        timestamp_iso: new Date().toISOString(),
        model: MODEL,
        source,
        latency_ms: latencyMs,
        client_metrics: metrics,
        math_findings: analysis.mathFindings,
        director_output: {
          agentAudioScript: analysis.agentAudioScript,
          omniVideoPrompt: analysis.omniVideoPrompt,
          overlayPlan,
          correctionVideoPrompt: analysis.correctionVideoPrompt || null,
        },
        had_video: Boolean(videoFile?.buffer?.length),
        had_audio: Boolean(audioFile?.buffer?.length),
        tts_audio_url_emitted: Boolean(agentAudioUrl),
      });
    } catch (err) {
      log.error("/api/analyze error", {
        error: err?.message || String(err),
        analysisId,
      });
      res.status(500).json({
        error: "Analysis failed.",
        analysisId,
        agentAudioScript: FALLBACK.agentAudioScript,
        omniVideoPrompt: FALLBACK.omniVideoPrompt,
        overlayPlan: FALLBACK.overlayPlan,
        agentAudioUrl: null,
      });
      logAnalysisToPipeline({
        analysis_id: analysisId,
        timestamp_iso: new Date().toISOString(),
        model: MODEL,
        source: "error",
        latency_ms: Date.now() - startedAt,
        error: err?.message || String(err),
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Veo correction-video endpoints — kick off + poll a long-running Veo
// generation. The Director Agent emits `correctionVideoPrompt`; the frontend
// POSTs it here, polls until ready, then embeds the mp4 alongside the user's
// clip on the result screen.
// ---------------------------------------------------------------------------
app.post(
  "/api/correction-clip",
  requireDemoToken,
  veoLimiter,
  // 1MB JSON limit — the frontend includes a base64-encoded first frame of
  // the user's clip (~50-300KB) as the Veo image-to-video reference.
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      if (!ai) {
        return res.status(503).json({ error: "Veo unavailable: no Gemini client configured." });
      }
      const prompt = (req.body?.prompt || "").toString().trim();
      if (prompt.length < 20 || prompt.length > 1500) {
        return res
          .status(400)
          .json({ error: "prompt must be 20-1500 chars" });
      }

      // Optional reference image for image-to-video. Accepts either a data URI
      // ("data:image/jpeg;base64,...") or { data: base64String, mimeType }.
      let referenceImageBytes = null;
      let referenceMime = "image/jpeg";
      const ref = req.body?.referenceImage;
      if (ref) {
        if (typeof ref === "string" && ref.startsWith("data:")) {
          const [meta, b64] = ref.split(",");
          referenceMime = (meta.match(/^data:([^;]+);base64$/)?.[1]) || "image/jpeg";
          referenceImageBytes = Buffer.from(b64 || "", "base64");
        } else if (ref && typeof ref === "object" && ref.data) {
          referenceMime = ref.mimeType || "image/jpeg";
          referenceImageBytes = Buffer.from(ref.data, "base64");
        }
        if (referenceImageBytes && referenceImageBytes.length > 800 * 1024) {
          return res.status(413).json({
            error: "reference image too large (max 800KB after base64-decoding)",
          });
        }
      }

      const opId = randomUUID();
      const { model: veoModel, mode } = await kickoffCorrectionVideo({
        ai,
        prompt,
        opId,
        referenceImageBytes,
        referenceMime,
      });
      log.info("veo kickoff", {
        opId,
        model: veoModel,
        mode,
        promptLen: prompt.length,
        referenceImageBytes: referenceImageBytes?.length || 0,
      });
      res.json({ opId, model: veoModel, mode, status: "pending" });
    } catch (err) {
      log.error("veo kickoff failed", {
        error: err?.message || String(err),
      });
      res.status(502).json({
        error: "Veo kickoff failed",
        detail: err?.message || String(err),
      });
    }
  }
);

app.get("/api/correction-clip", requireDemoToken, async (req, res) => {
  try {
    if (!ai) {
      return res.status(503).json({ error: "Veo unavailable: no Gemini client configured." });
    }
    const opId = (req.query?.id || "").toString();
    if (!opId) return res.status(400).json({ error: "missing id param" });

    const result = await pollCorrectionVideo({ ai, opId, apiKey });

    if (result.status === "missing") {
      return res.status(404).json({ error: "operation not found or expired" });
    }
    if (result.status === "error") {
      log.error("veo poll error", { opId, error: result.error, model: result.model });
      return res.status(502).json({
        status: "error",
        error: result.error,
        model: result.model,
        elapsedMs: result.elapsedMs,
      });
    }
    if (result.status === "pending") {
      return res.json({
        status: "pending",
        elapsedMs: result.elapsedMs,
        model: result.model,
      });
    }

    // status === "done" — write the mp4 + return a backend-served URL.
    const filename = `${opId}.mp4`;
    const fullPath = path.join(CORRECTIONS_DIR, filename);
    fs.writeFileSync(fullPath, result.videoBytes);
    const videoUrl = `${req.protocol}://${req.get("host")}/public/corrections/${filename}`;
    log.info("veo complete", {
      opId,
      model: result.model,
      elapsedMs: result.elapsedMs,
      bytes: result.videoBytes.length,
      hadReferenceImage: result.hadReferenceImage,
    });
    res.json({
      status: "done",
      videoUrl,
      model: result.model,
      mimeType: result.mimeType,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    log.error("/api/correction-clip GET error", {
      error: err?.message || String(err),
    });
    res.status(500).json({ error: "poll failed", detail: err?.message || String(err) });
  }
});

// Explicit 0.0.0.0 bind — Cloud Run requires the container to listen on all
// interfaces, not just localhost.
const server = app.listen(PORT, "0.0.0.0", () => {
  log.info("omniform analyzer online", {
    port: PORT,
    model: MODEL,
    mode: aiMode,
    tts_enabled: Boolean(ttsApiKey),
    node_env: NODE_ENV,
    log_format: LOG_FORMAT,
  });
});

// Graceful shutdown: Cloud Run sends SIGTERM ~10s before SIGKILL during
// scale-down. Drain in-flight requests, close keep-alive sockets, then exit.
function shutdown(signal) {
  log.info("shutdown signal received, draining server", { signal });
  server.close((err) => {
    if (err) {
      log.error("server.close error", { error: err?.message || String(err) });
      process.exit(1);
    }
    log.info("server drained, exiting cleanly");
    process.exit(0);
  });
  // Hard cap so a stuck connection can't block the SIGKILL deadline.
  setTimeout(() => {
    log.warn("drain timeout, forcing exit");
    process.exit(1);
  }, 9000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
