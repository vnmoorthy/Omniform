# ---------------------------------------------------------------------------
# OmniForm frontend - production image for Google Cloud Run (Next.js standalone)
#   Build & deploy (point it at your deployed backend):
#     gcloud run deploy omniform-frontend \
#       --source . \
#       --region us-central1 \
#       --allow-unauthenticated \
#       --build-arg NEXT_PUBLIC_API_URL=https://YOUR-BACKEND-URL/api/analyze
# ---------------------------------------------------------------------------

# --- Dependencies ---
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

# --- Build ---
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are baked into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Runtime ---
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Cloud Run best practice: don't run as root inside the container.
RUN chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "server.js"]
