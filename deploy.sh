#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OmniForm — one-command deploy to Google Cloud Run (backend + frontend).
#
# Prerequisites:
#   * gcloud CLI installed and authenticated:  gcloud auth login
#   * Billing enabled on the target project.
#   * backend/.env populated with GEMINI_API_KEY (and optionally
#     GOOGLE_TTS_API_KEY for the Chirp 3 voice).
#
# Usage:
#   PROJECT_ID=your-gcp-project ./deploy.sh
#   PROJECT_ID=your-gcp-project REGION=us-central1 ./deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=my-proj ./deploy.sh}"
REGION="${REGION:-us-central1}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/backend/.env"

read_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

GEMINI_API_KEY="$(read_env GEMINI_API_KEY)"
GOOGLE_TTS_API_KEY="$(read_env GOOGLE_TTS_API_KEY)"
DEMO_TOKEN="${DEMO_TOKEN:-$(openssl rand -hex 16)}"

[ -n "$GEMINI_API_KEY" ] || { echo "ERROR: GEMINI_API_KEY missing in backend/.env"; exit 1; }
[ -n "$GOOGLE_TTS_API_KEY" ] || GOOGLE_TTS_API_KEY="$GEMINI_API_KEY"

echo "==> Project: $PROJECT_ID   Region: $REGION"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling required Google Cloud APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  texttospeech.googleapis.com \
  generativelanguage.googleapis.com >/dev/null

PROJNUM="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA="${PROJNUM}-compute@developer.gserviceaccount.com"

echo "==> Storing secrets in Secret Manager"
put_secret() {
  local name="$1" val="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf "%s" "$val" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else
    printf "%s" "$val" | gcloud secrets create "$name" --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
}
put_secret omniform-gemini      "$GEMINI_API_KEY"
put_secret omniform-tts         "$GOOGLE_TTS_API_KEY"
put_secret omniform-demo-token  "$DEMO_TOKEN"

echo "==> Deploying backend (omniform-analyzer)"
gcloud run deploy omniform-analyzer \
  --source "$ROOT/backend" \
  --region "$REGION" \
  --allow-unauthenticated \
  --update-secrets=GEMINI_API_KEY=omniform-gemini:latest,GOOGLE_TTS_API_KEY=omniform-tts:latest,DEMO_TOKEN=omniform-demo-token:latest \
  --set-env-vars=GEMINI_MODEL=gemini-3.5-flash >/dev/null
BACKEND_URL="$(gcloud run services describe omniform-analyzer --region "$REGION" --format='value(status.url)')"
echo "    backend: $BACKEND_URL"

# NEXT_PUBLIC_* is inlined at build time. NEXT_PUBLIC_API_URL is passed as a
# Docker build-arg (the frontend Dockerfile declares it); the demo token is
# written to .env.production, which `next build` reads from the build context.
echo "==> Writing frontend build env"
cat > "$ROOT/frontend/.env.production" <<EOF
NEXT_PUBLIC_API_URL=$BACKEND_URL/api/analyze
NEXT_PUBLIC_DEMO_TOKEN=$DEMO_TOKEN
EOF

echo "==> Building frontend image with NEXT_PUBLIC_API_URL baked in"
REPO_PATH="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy"
IMAGE="$REPO_PATH/omniform-frontend:latest"
gcloud artifacts repositories create cloud-run-source-deploy \
  --repository-format=docker --location="$REGION" >/dev/null 2>&1 || true
CLOUDBUILD="$(mktemp)"
cat > "$CLOUDBUILD" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build','--build-arg','NEXT_PUBLIC_API_URL=$BACKEND_URL/api/analyze','-t','$IMAGE','.']
images: ['$IMAGE']
EOF
gcloud builds submit "$ROOT/frontend" --config="$CLOUDBUILD" >/dev/null
rm -f "$CLOUDBUILD"

echo "==> Deploying frontend (omniform-frontend)"
gcloud run deploy omniform-frontend \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated >/dev/null
FRONTEND_URL="$(gcloud run services describe omniform-frontend --region "$REGION" --format='value(status.url)')"
echo "    frontend: $FRONTEND_URL"

echo "==> Locking backend CORS to the frontend origin"
gcloud run services update omniform-analyzer --region "$REGION" \
  --update-env-vars=ALLOWED_ORIGIN="$FRONTEND_URL" >/dev/null

echo ""
echo "Deploy complete."
echo "  App:        $FRONTEND_URL"
echo "  API:        $BACKEND_URL"
echo "  Health:     $BACKEND_URL/health"
echo "  Demo token: $DEMO_TOKEN"
echo ""
echo "Open the App URL on a phone, allow camera + mic, hold to analyze."
