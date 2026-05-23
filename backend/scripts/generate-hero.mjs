// One-shot generator: produces the OmniForm hero/architecture imagery via
// Google Imagen (the same @google/genai SDK we use everywhere else). Run once,
// commit the PNGs into docs/, never need to re-run unless the design changes.
//
//   cd backend
//   node --env-file=.env scripts/generate-hero.mjs
//
// Reads GEMINI_API_KEY from .env. Writes:
//   docs/hero.png            — landing-page hero shot
//   docs/architecture.png    — labeled architecture (best-effort; Imagen text
//                              is imperfect, so we still keep the ASCII diagram
//                              in about.html as the source of truth)
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

const IMAGEN_FALLBACK_ORDER = [
  "imagen-4.0-ultra-generate-001",
  "imagen-4.0-generate-001",
  "imagen-3.0-generate-002",
];

async function generate({ name, prompt, aspectRatio }) {
  let lastErr;
  for (const model of IMAGEN_FALLBACK_ORDER) {
    try {
      console.log(`[imagen] ${name} → trying ${model}…`);
      const resp = await ai.models.generateImages({
        model,
        prompt,
        config: {
          numberOfImages: 1,
          aspectRatio: aspectRatio || "16:9",
          personGeneration: "allow_adult",
        },
      });
      const img = resp.generatedImages?.[0]?.image;
      const b64 = img?.imageBytes;
      if (!b64) throw new Error("no imageBytes in response");
      const outPath = path.join(DOCS_DIR, `${name}.png`);
      fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
      console.log(`[imagen] ✓ wrote ${outPath} (${Buffer.from(b64, "base64").length} bytes, ${model})`);
      return { model, path: outPath };
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      console.warn(`[imagen] ${model} failed: ${msg.slice(0, 200)}`);
      if (!/model|not found|unsupported|preview|denied|404|400/i.test(msg)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error("no imagen model accepted the request");
}

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  // 1. Landing-page hero — abstract, no text needed, beautiful
  await generate({
    name: "hero",
    aspectRatio: "16:9",
    prompt:
      "Cinematic technical illustration of an athlete performing a soccer strike, " +
      "frozen mid-motion. Overlaid on the athlete's body: glowing cyan vector lines " +
      "tracing the skeletal kinetic chain (hip, knee, ankle), with magenta warning " +
      "rings on key joints and yellow velocity arrows showing rotational force. " +
      "Background: dark navy gradient with soft volumetric lighting from above. " +
      "Style: clean modern UI design language, neon glow effects, holographic data " +
      "visualization aesthetic. No text, no captions, no UI chrome.",
  });

  // 2. Architecture diagram — best-effort. Imagen struggles with text labels,
  // so this is a stylized illustration rather than a literal diagram.
  await generate({
    name: "architecture",
    aspectRatio: "16:9",
    prompt:
      "Abstract data-flow visualization, flat technical illustration style. " +
      "A smartphone on the left captures a person's silhouette outlined in glowing " +
      "cyan skeletal lines. An arrow flows right into a stack of rounded panels " +
      "(neon blue, teal, magenta) representing AI processing layers. Another arrow " +
      "flows back to a video frame on the right showing the same person with " +
      "highlighted joints. Dark navy background with subtle grid texture, soft " +
      "rim lighting on the panels. Minimalist, no readable text or labels.",
  });

  console.log("");
  console.log("Done. Embed via:");
  console.log('  <img src="./hero.png" alt="OmniForm — athlete motion analysis with AI overlays">');
  console.log('  <img src="./architecture.png" alt="Data flow: phone → AI stack → annotated playback">');
})();
