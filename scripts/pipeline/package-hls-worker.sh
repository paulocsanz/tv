#!/usr/bin/env bash
# Continuous HLS-AES packager for the existing library (RFC 0009 P1.1).
# One title at a time until every single-file s3 title has hls_playlist_s3_key.
#
#   set -a && source .env.caixote && set +a
#   nohup ./scripts/pipeline/package-hls-worker.sh >> /tmp/package-hls-worker.log 2>&1 &
#
# Env:
#   MAX_TITLES  stop after N successes this run (default 0 = unlimited)
#   SLEEP_SEC   pause between titles (default 2)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MAX_TITLES="${MAX_TITLES:-0}"
SLEEP_SEC="${SLEEP_SEC:-2}"
LOG_PREFIX="[hls-worker $(date +%H:%M:%S)]"

if [[ -z "${ENCRYPTION_CATALOG_KEY:-}" ]]; then
  echo "$LOG_PREFIX ENCRYPTION_CATALOG_KEY missing — source .env.caixote first"
  exit 1
fi
if [[ -z "${S3_ACCESS_KEY_ID:-}" ]]; then
  echo "$LOG_PREFIX S3 creds missing — source .env.caixote first"
  exit 1
fi

pick_next_id() {
  node --input-type=module -e '
import fs from "fs";
const d = JSON.parse(fs.readFileSync("backend/data/enriched_400.json", "utf8"));
const next = d.items.find(
  (x) =>
    x &&
    x.s3_key &&
    !x.hls_playlist_s3_key &&
    (!x.s3_keys || x.s3_keys.length <= 1),
);
if (!next) process.exit(2);
console.log(next.id);
'
}

done_count=0
echo "$LOG_PREFIX start MAX_TITLES=${MAX_TITLES:-∞}"

while true; do
  if ! id="$(pick_next_id 2>/dev/null)"; then
    remaining="$(node -e '
      const d=require("./backend/data/enriched_400.json");
      const n=d.items.filter(x=>x&&x.s3_key&&!x.hls_playlist_s3_key&&(!x.s3_keys||x.s3_keys.length<=1)).length;
      console.log(n);
    ')"
    if [[ "$remaining" -eq 0 ]]; then
      echo "$LOG_PREFIX all single-file titles have HLS. exiting."
      exit 0
    fi
    echo "$LOG_PREFIX no pick ($remaining remain) — sleep and retry"
    sleep 30
    continue
  fi

  echo "$LOG_PREFIX packaging $id …"
  if node scripts/pipeline/package-hls-from-s3.js --id "$id"; then
    done_count=$((done_count + 1))
    echo "$LOG_PREFIX ok $id (run total $done_count)"
  else
    echo "$LOG_PREFIX FAIL $id — continue"
  fi

  if [[ "$MAX_TITLES" -gt 0 && "$done_count" -ge "$MAX_TITLES" ]]; then
    echo "$LOG_PREFIX hit MAX_TITLES=$MAX_TITLES — stop"
    exit 0
  fi
  sleep "$SLEEP_SEC"
done
