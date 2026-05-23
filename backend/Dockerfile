# ---------------------------------------------------------------------------
# OmniForm analyzer - production image for Google Cloud Run
#
#   Store the secret in Secret Manager once:
#     echo -n "$GEMINI_API_KEY" | gcloud secrets create omniform-gemini --data-file=-
#     gcloud secrets add-iam-policy-binding omniform-gemini \
#       --member="serviceAccount:$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
#       --role="roles/secretmanager.secretAccessor"
#
#   Then deploy:
#     gcloud run deploy omniform-analyzer \
#       --source . \
#       --region us-central1 \
#       --allow-unauthenticated \
#       --update-secrets=GEMINI_API_KEY=omniform-gemini:latest \
#       --update-secrets=DEMO_TOKEN=omniform-demo-token:latest \
#       --set-env-vars=ALLOWED_ORIGIN=https://YOUR-FRONTEND-URL
#
#   See SECURITY.md for the full secret-handling rationale (/cso finding 6).
# ---------------------------------------------------------------------------
FROM node:20-slim

# Cloud Run injects PORT at runtime; default to 8080 for local parity.
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source.
COPY . .

# Ensure the served asset directories exist + are writable by the non-root user.
RUN mkdir -p /app/public/videos /app/public/audio \
    && chown -R node:node /app

# Cloud Run best practice: don't run as root inside the container.
USER node

EXPOSE 8080

CMD ["node", "index.js"]
