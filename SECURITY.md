# Security — Omniform

This file documents the security posture of the OmniForm Ambient Biomechanics Lab, with the trade-offs explicit so hackathon judges and post-event reviewers can audit the demo's footprint quickly.

This file is the narrative security summary plus the known-vulnerability log for `@google/adk`.

## Trust model

| Boundary | Treatment |
|---|---|
| Browser → `/api/analyze` | Untrusted. `X-Demo-Token` (when configured) + per-IP rate limit + CORS allowlist. |
| Backend → Gemini (Interactions API) | Multimodal user content (video bytes) and bounded numeric grounding flow in. JSON-schema-constrained output flows back. |
| Backend → Google Cloud TTS | Coaching script flows in (LLM-bounded). MP3 saved to short-lived public path. |
| `/public/audio/*` | Public read, UUID-named, swept every 15 minutes for clips older than 1 hour. |
| Recorded video | **Never persisted server-side.** The frontend replays the in-memory blob via `URL.createObjectURL`. |

## Guardrails in code

| Risk | Where |
|---|---|
| Unauthenticated/expensive endpoint abuse | `express-rate-limit` (10/min/IP) + optional `X-Demo-Token` middleware in [backend/index.js](backend/index.js) |
| CORS wildcard | Bounded to `ALLOWED_ORIGIN` env (comma-separated) — defaults to `localhost:3000` and `localhost:8080` for dev |
| Prompt injection via `metrics` | `sanitizeMetrics()` rejects non-finite or out-of-range values before any user-controlled text reaches the agent instruction |
| User PII at public URLs | Server-side video echo dropped entirely. TTS audio swept after 1 hour. |
| Root-in-container | Both `backend/Dockerfile` and `frontend/Dockerfile` end with `USER node` |
| Secrets in deploy command | `backend/Dockerfile` comment shows `--update-secrets` (Secret Manager) instead of `--set-env-vars` |
| Cloud Run signal handling | `SIGTERM`/`SIGINT` handlers drain in-flight requests up to 9s before exit |

## Deploy checklist

Before deploying to a public Cloud Run service:

1. `gcloud secrets create omniform-gemini --data-file=- <<< "$GEMINI_API_KEY"`
2. `gcloud secrets create omniform-demo-token --data-file=- <<< "$(openssl rand -hex 16)"`
3. Set `ALLOWED_ORIGIN` to your frontend's `https://omniform-frontend-xxxx.run.app` URL (no trailing slash)
4. Set `DEMO_TOKEN` from the same secret as `NEXT_PUBLIC_DEMO_TOKEN` on the frontend build
5. Deploy with `--update-secrets=GEMINI_API_KEY=omniform-gemini:latest,DEMO_TOKEN=omniform-demo-token:latest`

## Known vulnerability exposure

### `@google/adk@^1.1.0` transitive CVE chain

`npm audit` in `backend/` reports **4 high-severity** and **moderate** advisories in the ADK's transitive dependency tree:

| Package | Severity | Path |
|---|---|---|
| `@mikro-orm/sqlite` → `sqlite3` | high | `@google/adk` session storage adapter (unused — we use `InMemorySessionService`) |
| `cacache` → `tar` | high | `@google/adk` build/cache plumbing |
| `@google-cloud/storage` → `retry-request`, `teeny-request`, `uuid` | moderate | `@google/adk` artifact service (unused — no GCS configured) |
| `gaxios`, `googleapis`, `@google-cloud/opentelemetry-cloud-monitoring-exporter` | moderate | telemetry exporters (unused) |

**Reachability assessment:** the vulnerable code paths are in storage/sqlite/telemetry modules that our pipeline never imports. We use only `LlmAgent`, `SequentialAgent`, `FunctionTool`, `InMemorySessionService`, and `Runner` from the ADK. Each surface was verified against `backend/agents/director.js` imports.

**`fixAvailable`** points to `@google/adk@0.1.2` — a major-version rollback that lacks `LlmAgent`/`SequentialAgent`/`Runner` and would break the pipeline. We've accepted the latent exposure for the demo.

**Post-demo TODO:**
- File an issue at <https://github.com/google/adk-js> requesting an audit-clean patch release on the `1.x` line.
- If unaddressed, add `npm overrides` in `backend/package.json` to force-bump `tar`, `sqlite3`, `uuid` to fixed versions and verify ADK still loads.

### Frontend MediaPipe WASM via jsdelivr CDN

[frontend/app/components/PoseOverlay.tsx:24](frontend/app/components/PoseOverlay.tsx#L24) loads `@mediapipe/tasks-vision` WASM from `cdn.jsdelivr.net`. Compromise of that CDN would inject WASM into the user's browser with access to the camera/mic streams. Acceptable for a hackathon demo; for production, mirror the WASM into `public/` or a first-party CDN.

## Things that are *not* hardened (by design, for the demo)

- No persistent storage / no DB / no auth-server / no user accounts. Each session is fully ephemeral on the client; the backend never sees a user identity.
- No CAPTCHA / bot-detection on `/api/analyze`. The rate limit + token cover the threat model for a hackathon demo URL but not a production SaaS.
- No Cloud Armor / WAF in front of Cloud Run.
- No structured Cloud Logging — `console.log` only. Fine for demo; add `@google-cloud/logging` for prod.

## Privacy

The recorded video stays in browser memory only. It is base64-encoded and sent to Gemini for analysis, but never written to a server disk. TTS audio (synthesized from the LLM's text output, no user voice content) is written to `/public/audio/<uuid>.mp3` and deleted within an hour. No user-identifying fields are logged.
