#!/usr/bin/env bash
# Continuous re-encrypt worker: processes unencrypted single-file movies
# one at a time until none remain (or MAX is hit).
#
#   set -a && source .env.caixote && set +a
#   nohup ./reencrypt-worker.sh >> /tmp/reencrypt-worker.log 2>&1 &
#
# Env:
#   MAX_MB     skip objects larger than this (default 1200)
#   MAX_TITLES stop after N successful encrypts this run (default unlimited)
#   SLEEP_SEC  pause between titles (default 2)

set -euo pipefail
cd "$(dirname "$0")"

MAX_MB="${MAX_MB:-1200}"
MAX_TITLES="${MAX_TITLES:-0}"
SLEEP_SEC="${SLEEP_SEC:-2}"
LOG_PREFIX="[worker $(date +%H:%M:%S)]"

if [[ -z "${ENCRYPTION_CATALOG_KEY:-}" ]]; then
  echo "$LOG_PREFIX ENCRYPTION_CATALOG_KEY missing — source .env.caixote first"
  exit 1
fi
if [[ -z "${S3_ACCESS_KEY_ID:-}" ]]; then
  echo "$LOG_PREFIX S3 creds missing — source .env.caixote first"
  exit 1
fi

# Wait for any other reencrypt-from-s3.js (not this worker's children after we start them)
wait_for_peer() {
  while pgrep -f "node reencrypt-from-s3.js" >/dev/null 2>&1; do
    # If the only match is about to be ours, break — we check before spawn
    echo "$LOG_PREFIX waiting for existing reencrypt-from-s3.js …"
    sleep 30
  done
}

pick_next_id() {
  node --input-type=module -e '
import fs from "fs";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const maxMb = Number(process.env.MAX_MB || 1200);
const d = JSON.parse(fs.readFileSync("backend/data/enriched_400.json", "utf8"));
const c = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: (process.env.S3_URL_STYLE || "") === "path",
});

const candidates = d.items.filter(
  (x) =>
    x &&
    x.s3_key &&
    !x.encrypted &&
    (x.content_type === "movie" || !x.content_type) &&
    (!x.s3_keys || x.s3_keys.length <= 1),
);

// Probe a rolling window; pick the smallest that fits under MAX_MB.
const sample = candidates.slice(0, 40);
const sized = [];
for (const m of sample) {
  try {
    const h = await c.send(
      new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: m.s3_key,
      }),
    );
    const mb = h.ContentLength / 1e6;
    if (mb <= maxMb) sized.push({ id: m.id, mb });
  } catch {
    /* missing object */
  }
}
sized.sort((a, b) => a.mb - b.mb);
if (!sized.length) {
  process.exit(2); // nothing left in this window
}
console.log(sized[0].id);
'
}

done_count=0
fail_streak=0

echo "$LOG_PREFIX start MAX_MB=$MAX_MB MAX_TITLES=${MAX_TITLES:-∞}"

while true; do
  wait_for_peer

  if ! id="$(pick_next_id 2>/dev/null)"; then
    # Either nothing under MAX_MB in first 40, or catalog exhausted.
    # Try once more with a shuffled offset by temporarily not filtering —
    # if still empty, we're done for this MAX_MB.
    remaining="$(node -e '
      const d=require("./backend/data/enriched_400.json");
      const n=d.items.filter(x=>x&&x.s3_key&&!x.encrypted&&(x.content_type==="movie"||!x.content_type)&&(!x.s3_keys||x.s3_keys.length<=1)).length;
      console.log(n);
    ')"
    if [[ "$remaining" -eq 0 ]]; then
      echo "$LOG_PREFIX all single-file movies encrypted. exiting."
      exit 0
    fi
    echo "$LOG_PREFIX no title ≤ ${MAX_MB}MB in sample window ($remaining remain). raising MAX_MB by 500."
    MAX_MB=$((MAX_MB + 500))
    export MAX_MB
    fail_streak=$((fail_streak + 1))
    if [[ $fail_streak -gt 10 ]]; then
      echo "$LOG_PREFIX too many empty windows — stop"
      exit 0
    fi
    sleep 5
    continue
  fi

  fail_streak=0
  echo "$LOG_PREFIX encrypting $id …"
  if node reencrypt-from-s3.js --id "$id"; then
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
