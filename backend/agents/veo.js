// ---------------------------------------------------------------------------
// OmniForm Veo helper — Google's video generation model via
// @google/genai's ai.models.generateVideos() long-running operation.
//
//   * Text-to-video: prompt only.
//   * Image-to-video: prompt + reference image (e.g. the first frame of the
//     user's clip), so Veo animates the SAME athlete in the SAME setting
//     executing the corrected technique. This is the "I see myself doing it
//     right" loop — the most psychologically effective coaching feedback.
//
// Model preference order (env-overridable via VEO_MODEL):
//   1. veo-3.1-fast-generate-preview  — Veo 3.1, fast tier (Google I/O 2026)
//   2. veo-3.0-generate-001            — Veo 3 stable
//   3. veo-2.0-generate-001            — Veo 2 stable (SDK example default)
//
// Why async: Veo generation is 20-90s — too long to block the user's initial
// /api/analyze response. Kickoff returns a short opId; frontend polls.
//
// Why local proxy: Veo on Gemini API returns a `https://generativelanguage
// .googleapis.com/v1beta/files/...:download?alt=media` URI that requires the
// API key to fetch. The browser can't auth to that. We download server-side
// (with the key) and serve the mp4 via /public/corrections/{id}.mp4.
// ---------------------------------------------------------------------------

const VEO_MODEL_FALLBACK_ORDER = [
  "veo-3.1-fast-generate-preview",
  "veo-3.0-generate-001",
  "veo-2.0-generate-001",
];

// In-memory map of opId → operation metadata. Sweep stale entries after 10
// minutes so a forgotten kickoff doesn't leak indefinitely.
const inflight = new Map();
const OP_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of inflight.entries()) {
    if (now - entry.startedAt > OP_TTL_MS) inflight.delete(id);
  }
}, 60 * 1000).unref();

/**
 * Build a GenerateVideos params object. If `referenceImageBytes` is provided
 * (i.e. we have a still extracted from the user's video), we configure I2V:
 * pass the image and set personGeneration to allow Veo to render the person
 * who appears in the reference frame.
 */
function buildVeoParams({ model, prompt, referenceImageBytes, referenceMime }) {
  const params = {
    model,
    prompt,
    config: {
      numberOfVideos: 1,
      durationSeconds: 8,
      aspectRatio: "9:16", // phone-first; matches the OmniForm UI
      // For I2V we MUST allow person generation, otherwise Veo strips the
      // person out of the reference frame. For T2V we still allow adults so
      // the generated clip can include an athlete.
      personGeneration: "allow_adult",
      negativePrompt:
        "text overlays, captions, watermarks, blurry, distorted anatomy, chaotic crowds, duplicated limbs",
    },
  };
  if (referenceImageBytes && referenceImageBytes.length) {
    params.image = {
      imageBytes: referenceImageBytes.toString("base64"),
      mimeType: referenceMime || "image/jpeg",
    };
  }
  return params;
}

/**
 * Kick off a Veo generation. Returns the opId + the model actually accepted.
 * Walks the fallback list — if the preferred model isn't recognized (e.g. Veo
 * 3.1 not enabled on the user's project), drops to the next.
 *
 * @param {object} opts
 * @param {GoogleGenAI} opts.ai             - initialized genai client
 * @param {string}     opts.prompt          - Veo prompt
 * @param {string}     opts.opId            - caller-chosen short id
 * @param {Buffer=}    opts.referenceImageBytes  - first frame of the user's clip (optional)
 * @param {string=}    opts.referenceMime   - mime of the reference image (default image/jpeg)
 * @param {string=}    opts.model           - explicit model override
 */
export async function kickoffCorrectionVideo({
  ai,
  prompt,
  opId,
  referenceImageBytes,
  referenceMime,
  model,
}) {
  if (!ai) throw new Error("Veo: no genai client configured");
  if (!prompt || typeof prompt !== "string" || prompt.length < 10) {
    throw new Error("Veo: prompt too short");
  }

  const explicit = model || process.env.VEO_MODEL || null;
  const tryModels = explicit
    ? [explicit, ...VEO_MODEL_FALLBACK_ORDER.filter((m) => m !== explicit)]
    : VEO_MODEL_FALLBACK_ORDER;

  let lastErr;
  for (const m of tryModels) {
    try {
      const params = buildVeoParams({
        model: m,
        prompt,
        referenceImageBytes,
        referenceMime,
      });
      const operation = await ai.models.generateVideos(params);
      inflight.set(opId, {
        operation,
        startedAt: Date.now(),
        prompt,
        model: m,
        hadReferenceImage: Boolean(referenceImageBytes?.length),
      });
      return { opId, model: m, mode: referenceImageBytes ? "image-to-video" : "text-to-video" };
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      // Walk down only for "model not found / unsupported" type errors.
      // Anything else (quota, RAI, auth) is a real failure.
      if (!/model|not found|unsupported|invalid|preview|denied/i.test(msg)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error("Veo: no model accepted the request");
}

/**
 * Fetch a Gemini Files API URI using the configured API key. The URL returned
 * by Veo on the Gemini API is of the form:
 *   https://generativelanguage.googleapis.com/v1beta/files/<id>:download?alt=media
 * which requires the API key as either ?key= or Authorization header.
 */
async function fetchVeoUriBytes(uri, apiKey) {
  if (!apiKey) throw new Error("VEO uri requires GEMINI_API_KEY to download");
  const sep = uri.includes("?") ? "&" : "?";
  const authed = `${uri}${sep}key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(authed);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Veo URI fetch ${resp.status}: ${body.slice(0, 200)}`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Poll a previously-kicked-off operation. When the underlying Veo response
 * comes back as a URI (vs. inline bytes), we download it server-side using
 * the API key and return the bytes — frontends can't authenticate to the
 * Gemini Files URL directly.
 *
 * Returns one of:
 *   { status: "pending", elapsedMs, model }
 *   { status: "done",    videoBytes: Buffer, mimeType, model, elapsedMs }
 *   { status: "missing"  }
 *   { status: "error",   error, model? }
 */
export async function pollCorrectionVideo({ ai, opId, apiKey }) {
  const entry = inflight.get(opId);
  if (!entry) return { status: "missing" };
  const elapsedMs = Date.now() - entry.startedAt;

  let fresh;
  try {
    fresh = await ai.operations.getVideosOperation({ operation: entry.operation });
  } catch (err) {
    return {
      status: "error",
      error: err?.message || String(err),
      model: entry.model,
      elapsedMs,
    };
  }
  entry.operation = fresh;

  if (!fresh?.done) {
    return { status: "pending", elapsedMs, model: entry.model };
  }

  const r = fresh.response;
  if (r?.raiMediaFilteredCount && r.raiMediaFilteredCount > 0) {
    inflight.delete(opId);
    return {
      status: "error",
      error: `Veo RAI filter blocked the generation: ${(r.raiMediaFilteredReasons || []).join("; ") || "no reason provided"}`,
      model: entry.model,
      elapsedMs,
    };
  }

  const generated = r?.generatedVideos?.[0]?.video;
  const inlineB64 = generated?.videoBytes;
  const uri = generated?.uri;
  const mimeType = generated?.mimeType || "video/mp4";

  if (!inlineB64 && !uri) {
    inflight.delete(opId);
    return {
      status: "error",
      error: "Veo finished but returned no video payload",
      model: entry.model,
      elapsedMs,
    };
  }

  let videoBytes;
  if (inlineB64) {
    videoBytes = Buffer.from(inlineB64, "base64");
  } else {
    // URI path — fetch with the API key so the browser doesn't have to auth.
    try {
      videoBytes = await fetchVeoUriBytes(uri, apiKey);
    } catch (err) {
      inflight.delete(opId);
      return {
        status: "error",
        error: err?.message || String(err),
        model: entry.model,
        elapsedMs,
      };
    }
  }

  inflight.delete(opId);
  return {
    status: "done",
    videoBytes,
    mimeType,
    model: entry.model,
    elapsedMs,
    prompt: entry.prompt,
    hadReferenceImage: entry.hadReferenceImage,
  };
}

/** Diagnostic — how many ops are currently tracked. */
export function inflightSize() {
  return inflight.size;
}
