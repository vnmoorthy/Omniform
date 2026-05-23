// OmniForm live smoke test — validates the Google AI stack against your keys.
//
//   Run from the backend directory:
//     node --env-file=.env smoke-test.mjs
//
// Checks three independent paths and prints PASS/FAIL for each:
//   1. Gemini generateContent  (the resilient fallback analysis path)
//   2. Interactions API        (the call the ADK multi-agent pipeline uses)
//   3. Cloud Text-to-Speech    (the Chirp 3: HD coaching voice)
// Exits non-zero if any check fails.
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ttsKey = process.env.GOOGLE_TTS_API_KEY || apiKey;
const ttsVoice = process.env.GOOGLE_TTS_VOICE || "en-US-Chirp3-HD-Charon";

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log("  PASS  " + m);
  pass++;
};
const no = (m) => {
  console.log("  FAIL  " + m);
  fail++;
};
const short = (e) => (e?.message || String(e)).slice(0, 200);

if (!apiKey) {
  console.error(
    "No GEMINI_API_KEY found. Run from backend/:  node --env-file=.env smoke-test.mjs"
  );
  process.exit(2);
}

const ai = new GoogleGenAI({ apiKey });
const prompt =
  "Return a compact JSON object with a single key named ok set to boolean true, and nothing else.";

console.log(`\nOmniForm smoke test — model ${MODEL}\n`);

// 1. generateContent — direct single-call path (the route's fallback tier).
try {
  const r = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const txt = (r.text || "").trim();
  JSON.parse(txt);
  ok(`generateContent -> ${txt.slice(0, 60)}`);
} catch (e) {
  no(`generateContent -> ${short(e)}`);
}

// 2. Interactions API — the primitive the ADK MathAgent tool calls.
try {
  const it = await ai.interactions.create({
    model: MODEL,
    input: [{ type: "text", text: prompt }],
    response_format: { type: "text", mime_type: "application/json" },
    generation_config: { temperature: 0 },
  });
  const steps = it.steps || [];
  let txt = "";
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.type === "model_output" && Array.isArray(s.content)) {
      const t = s.content.find(
        (c) => c?.type === "text" && typeof c.text === "string"
      );
      if (t?.text) {
        txt = t.text;
        break;
      }
    }
  }
  if (!txt) throw new Error("no model_output text found in interaction.steps");
  ok(`interactions.create (status ${it.status}) -> ${txt.trim().slice(0, 60)}`);
} catch (e) {
  no(`interactions.create -> ${short(e)}`);
}

// 3. Cloud Text-to-Speech — the agent's voice.
try {
  const resp = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${ttsKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: "OmniForm voice check." },
        voice: { languageCode: "en-US", name: ttsVoice },
        audioConfig: { audioEncoding: "MP3" },
      }),
    }
  );
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  }
  const data = await resp.json();
  if (!data.audioContent) throw new Error("no audioContent in response");
  ok(`Cloud TTS (${ttsVoice}) -> ${data.audioContent.length} base64 chars`);
} catch (e) {
  no(`Cloud TTS -> ${short(e)}`);
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail ? 1 : 0);
