#!/usr/bin/env node

/**
 * One-off: delete subtitle tracks in languages outside this catalog's
 * audience (Portuguese/English/Spanish - see KEPT_SUBTITLE_LANGS in
 * transcode.js, which now filters these out at extraction time going
 * forward). This cleans up tracks uploaded before that filter existed.
 *
 * "und" (untagged) tracks are kept, same rationale as the extraction-time
 * filter: an untagged track is often actually English or Portuguese without
 * proper metadata, and losing a usable caption is worse than one extra
 * untagged option in the menu.
 *
 * Deletes the S3 objects, then removes the corresponding entries from
 * item.subtitles in enriched_400.json. Only ever touches the `subtitles`
 * array - s3_key/s3_keys (the actual video/audio) are never read or written.
 *
 * Read-only against enriched_400.json until the final write - see
 * backfill-collections.js for why (a live download pipeline writes to that
 * file continuously). Re-reads immediately before writing to keep the
 * window where a concurrent pipeline write could be overwritten as small as
 * possible.
 *
 * Run with --dry-run first to see what would be deleted without touching
 * anything.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const KEPT_SUBTITLE_LANGS = new Set(["eng", "spa", "por"]);
const DRY_RUN = process.argv.includes("--dry-run");

function shouldDelete(lang) {
  return lang !== "und" && !KEPT_SUBTITLE_LANGS.has(lang);
}

function findTracksToDelete(items) {
  const toDelete = []; // { itemId, s3_key, lang, id, episode }
  for (const item of items) {
    for (const sub of item.subtitles ?? []) {
      if (shouldDelete(sub.lang)) {
        toDelete.push({ itemId: item.id, title: item.title, ...sub });
      }
    }
  }
  return toDelete;
}

async function deleteFromS3(keys) {
  if (keys.length === 0) return;

  const bucketCreds = JSON.parse(
    execSync("railway bucket credentials --bucket convenient-pannikin --json").toString()
  );
  const s3Client = new S3Client({
    region: bucketCreds.region,
    endpoint: bucketCreds.endpoint,
    forcePathStyle: bucketCreds.urlStyle !== "virtual-host",
    credentials: {
      accessKeyId: bucketCreds.accessKeyId,
      secretAccessKey: bucketCreds.secretAccessKey,
    },
  });
  const BUCKET_NAME = bucketCreds.bucketName;

  // DeleteObjectsCommand caps at 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
      })
    );
    console.log(`  Deleted ${res.Deleted?.length ?? 0}/${batch.length} objects from S3.`);
    if (res.Errors?.length) {
      console.log(`  ${res.Errors.length} deletion errors:`);
      for (const e of res.Errors) console.log(`    ${e.Key}: ${e.Code} ${e.Message}`);
    }
  }
}

function main() {
  const raw = fs.readFileSync(ENRICHED_FILE, "utf-8");
  const cache = JSON.parse(raw);
  const toDelete = findTracksToDelete(cache.items);

  if (toDelete.length === 0) {
    console.log("Nothing to clean up - no non-pt/en/es subtitle tracks found.");
    return Promise.resolve();
  }

  const byLang = {};
  for (const t of toDelete) byLang[t.lang] = (byLang[t.lang] ?? 0) + 1;
  console.log(`Found ${toDelete.length} tracks to delete across ${new Set(toDelete.map((t) => t.itemId)).size} items:`);
  console.log(byLang);
  for (const t of toDelete) {
    console.log(`  [${t.lang}] ${t.title} (${t.itemId}) ep${t.episode} -> ${t.s3_key}`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: not deleting anything.");
    return Promise.resolve();
  }

  return deleteFromS3(toDelete.map((t) => t.s3_key)).then(() => {
    // Re-read immediately before writing, minimizing the window where a
    // concurrent pipeline write to this file could be overwritten.
    const fresh = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
    let removed = 0;
    for (const item of fresh.items) {
      if (!item.subtitles?.length) continue;
      const before = item.subtitles.length;
      item.subtitles = item.subtitles.filter((s) => !shouldDelete(s.lang));
      removed += before - item.subtitles.length;
    }
    fs.writeFileSync(ENRICHED_FILE, JSON.stringify(fresh, null, 2));
    console.log(`\nRemoved ${removed} subtitle entries from ${ENRICHED_FILE}.`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
