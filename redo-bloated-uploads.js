#!/usr/bin/env node

/**
 * Applies the results of find-bloated-uploads.js: clears s3_key/s3_keys for
 * the confirmed-affected items so download-picked-torrents.js treats them
 * as not-yet-done and re-downloads/re-transcodes (now with the fixed
 * transcode.js bitrate)/re-uploads them, overwriting the bloated S3 object
 * at the same deterministic key.
 *
 * MUST run while the pipeline is stopped (same file-write race as any
 * other script that touches enriched_400.json directly - see
 * backfill-collections.js's header for the full rationale).
 *
 * Leaves `subtitles` entries alone - they're extracted from the untouched
 * original source and aren't affected by the video bitrate bug, and their
 * s3_key naming is deterministic so a re-upload overwrites the same object
 * anyway.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const BLOATED_FILE = path.join(process.cwd(), "bloated-uploads.json");

function main() {
  const affected = JSON.parse(fs.readFileSync(BLOATED_FILE, "utf-8"));
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const affectedIds = new Set(affected.map((a) => a.id));

  let cleared = 0;
  for (const item of data.items) {
    if (affectedIds.has(item.id)) {
      item.s3_key = undefined;
      item.s3_keys = [];
      cleared++;
      console.log(`Cleared s3_key/s3_keys for ${item.title} - will be re-downloaded/re-transcoded/re-uploaded`);
    }
  }

  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Done! ${cleared}/${affectedIds.size} affected items reset for reprocessing.`);
}

main();
