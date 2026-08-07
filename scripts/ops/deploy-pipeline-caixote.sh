#!/usr/bin/env bash
# Build + push the torrent pipeline image and apply caixote IaC.
#
# Env vars flow through IaC → IntentSync → OCI config.json automatically.
# No manual env injection needed (caixote env-sync bug fixed in fec491a1).
#
# Usage (from repo root):
#   ./scripts/ops/deploy-pipeline-caixote.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-ghcr.io/paulocsanz/tv-torrent-pipeline:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
PROJECT="${PROJECT:-vete-pipeline}"
SERVICE="${SERVICE:-torrent-pipeline}"

echo "==> Fetching Railway bucket credentials"
CREDS="$(railway bucket credentials --bucket convenient-pannikin --json)"
export S3_ACCESS_KEY_ID="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.accessKeyId)" "$CREDS")"
export S3_SECRET_ACCESS_KEY="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.secretAccessKey)" "$CREDS")"
export S3_BUCKET_NAME="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.bucketName)" "$CREDS")"
export S3_ENDPOINT="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.endpoint)" "$CREDS")"
export S3_REGION="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.region||'auto')" "$CREDS")"
export S3_URL_STYLE="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.urlStyle||'virtual-host')" "$CREDS")"

echo "==> Loading encryption key from .env.caixote"
if [ -f .env.caixote ]; then
  set -a; source .env.caixote; set +a
fi
export ENCRYPTION_CATALOG_KEY="${ENCRYPTION_CATALOG_KEY:-}"
export ENCRYPT_UPLOADS="${ENCRYPT_UPLOADS:-true}"

echo "==> ghcr.io login + build/push $IMAGE"
if [ -z "${GH_TOKEN:-}" ]; then GH_TOKEN="$(gh auth token)"; fi
echo "$GH_TOKEN" | docker login ghcr.io -u paulocsanz --password-stdin
docker buildx build --platform "$PLATFORM" -f Dockerfile.pipeline -t "$IMAGE" --push .

echo "==> Stop local pipeline leftovers"
pkill -f "node scripts/pipeline/download-picked-torrents.js" 2>/dev/null || true
pkill -x aria2c 2>/dev/null || true
rm -f .download-picked-torrents.lock

echo "==> caixote iac apply"
caixote iac apply -f caixote.config.ts --auto-approve

echo "==> Done. Watch with:"
echo "    caixote logs $SERVICE"
echo "    caixote service list --project $PROJECT --human"
