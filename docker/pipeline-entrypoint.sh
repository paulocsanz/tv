#!/bin/sh
set -eu

mkdir -p /data/downloads /data/backend/data

# Seed catalog onto the persistent volume on first boot so progress survives
# restarts. Never overwrite a volume copy that already has live progress.
if [ ! -f /data/backend/data/enriched_400.json ]; then
  echo "[entrypoint] seeding enriched_400.json onto data volume"
  cp /app/backend/data/enriched_400.json /data/backend/data/enriched_400.json
fi

# Required S3 env (set as caixote secrets). Fail fast with a clear message.
for var in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET_NAME S3_ENDPOINT; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "[entrypoint] missing required env: $var" >&2
    exit 1
  fi
done

exec "$@"
