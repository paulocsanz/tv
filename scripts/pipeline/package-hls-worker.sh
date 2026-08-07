#!/usr/bin/env bash
# Continuous HLS-AES packager for the existing library (RFC 0009).
# Packages single-file titles first, then multi-episode series.
#
#   set -a && source .env.caixote && set +a
#   nohup ./scripts/pipeline/package-hls-worker.sh >> /tmp/package-hls-worker.log 2>&1 &
#
# Env:
#   MAX_TITLES     stop after N successes (default 0 = unlimited)
#   SLEEP_SEC      pause between titles (default 2)
#   INCLUDE_SERIES set to 1 to process multi-ep after singles are done (default 1)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MAX_TITLES="${MAX_TITLES:-0}"
SLEEP_SEC="${SLEEP_SEC:-2}"
INCLUDE_SERIES="${INCLUDE_SERIES:-1}"
LOG_PREFIX="[hls-worker $(date +%H:%M:%S)]"

if [[ -z "${ENCRYPTION_CATALOG_KEY:-}" ]]; then
  echo "$LOG_PREFIX ENCRYPTION_CATALOG_KEY missing — source .env.caixote first"
  exit 1
fi
if [[ -z "${S3_ACCESS_KEY_ID:-}" ]]; then
  echo "$LOG_PREFIX S3 creds missing — source .env.caixote first"
  exit 1
fi

# Prefer single-file titles; when none left and INCLUDE_SERIES=1, pick series.
pick_next_id() {
  INCLUDE_SERIES="$INCLUDE_SERIES" node --input-type=module -e '
import fs from "fs";
const d = JSON.parse(fs.readFileSync("backend/data/enriched_400.json", "utf8"));
const includeSeries = process.env.INCLUDE_SERIES === "1";
function keys(x) {
  if (x.s3_keys && x.s3_keys.length) return x.s3_keys;
  if (x.s3_key) return [x.s3_key];
  return [];
}
const pending = d.items.filter((x) => x && keys(x).length && !x.hls_playlist_s3_key);
const single = pending.find((x) => keys(x).length === 1);
if (single) { console.log(single.id); process.exit(0); }
if (includeSeries) {
  const multi = pending.find((x) => keys(x).length > 1);
  if (multi) { console.log(multi.id); process.exit(0); }
}
process.exit(2);
'
}

done_count=0
echo "$LOG_PREFIX start MAX_TITLES=${MAX_TITLES:-∞} INCLUDE_SERIES=$INCLUDE_SERIES"

while true; do
  if ! id="$(pick_next_id 2>/dev/null)"; then
    remaining="$(node -e '
      const d=require("./backend/data/enriched_400.json");
      const keys=x=>(x.s3_keys&&x.s3_keys.length)?x.s3_keys:(x.s3_key?[x.s3_key]:[]);
      console.log(d.items.filter(x=>x&&keys(x).length&&!x.hls_playlist_s3_key).length);
    ')"
    if [[ "$remaining" -eq 0 ]]; then
      echo "$LOG_PREFIX all titles with S3 media have HLS. exiting."
      exit 0
    fi
    echo "$LOG_PREFIX no pick ($remaining remain, series skipped?) — sleep"
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
