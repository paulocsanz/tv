#!/usr/bin/env node

/**
 * Self-host trailers on S3 instead of embedding them as YouTube iframes.
 * YouTube enforces per-video regional licensing client-side - some trailers
 * are simply unavailable to viewers in some countries (confirmed: Brazil).
 * Downloading our own copy and serving it from this app's own bucket makes
 * that a non-issue, since the viewer streams from us, not YouTube.
 *
 * For each catalog item with a `trailer_key` (YouTube video ID, picked
 * during enrichment - see enrichment.rs's fetch_tmdb) and no existing entry
 * in the output backfill file:
 *   - yt-dlp downloads the trailer at up to 720p H.264 (explicitly NOT
 *     AV1/VP9 - YouTube's higher-resolution formats are often AV1 by
 *     default, which has spotty Safari support; forcing avc1 matches what
 *     transcode.js already does for the main content, for the same reason),
 *     plus English/Portuguese captions where YouTube actually has them
 *     natively (not auto-translated - machine-translated captions are
 *     noticeably lower quality, not worth the complexity for what's a
 *     supplementary feature here).
 *   - Both get uploaded via the same uploadToS3 pattern
 *     download-picked-torrents.js already uses (multipart, queueSize 4,
 *     32MB parts - that tuning exists because of this bucket's measured
 *     per-connection throughput ceiling), under the same videos/<id>/
 *     prefix the main video/subtitles already use, so a whole item's
 *     assets stay co-located.
 *
 * Read-only against enriched_400.json - see backfill-collections.js for why
 * (a live download pipeline writes to that file continuously). Output:
 * backend/data/trailer_backfill.json, keyed by catalog id:
 *   { [id]: { s3_key, subtitles: [{lang, label, s3_key}, ...] } }
 *
 * Resumable: already-populated ids in the output file are skipped, so a
 * killed/interrupted run can just be restarted.
 *
 * Usage: node download-trailers.js [--limit N] [--dry-run]
 */

import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import os from "os";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const S3_PREFIX = (id) => `videos/${id}/`;
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/trailer_backfill.json");
const TMP_DIR = path.join(os.tmpdir(), "tv-trailer-downloads");
fs.mkdirSync(TMP_DIR, { recursive: true });

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.findIndex((a) => a === "--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Prefer H.264 explicitly (not AV1/VP9 - see header comment); falls back to
// whatever combined progressive format is available (usually 360p) on the
// rare video where no separate avc1 video-only stream exists to merge.
const FORMAT_SELECTOR =
  "bv*[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a]/best[ext=mp4][height<=720]";

const LANG_LABELS = { eng: "English", por: "Portuguese", spa: "Spanish" };
// yt-dlp reports ISO 639-1 (2-letter); the catalog's existing SubtitleTrack
// model uses ISO 639-2 (3-letter, matching ffprobe's convention elsewhere in
// this repo) - normalize so trailer subtitle entries look like every other
// subtitle entry already in the catalog.
const LANG_TO_ISO_639_2 = { en: "eng", pt: "por", es: "spa" };

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

const UPLOAD_RETRIES = 3;

async function uploadToS3(filePath, s3Key, label, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      process.stdout.write(`    [${label}] ${prefix} ${sizeMB}MB... `);
      const upload = new Upload({
        client: s3Client,
        params: { Bucket: BUCKET_NAME, Key: s3Key, Body: fs.createReadStream(filePath), ContentType: contentType },
        queueSize: 4,
        partSize: 32 * 1024 * 1024,
      });
      await upload.done();
      console.log("✓");
      return true;
    } catch (error) {
      console.log(`✗ (${error.message})`);
      if (attempt < UPLOAD_RETRIES) {
        const delaySeconds = 10 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  }
  return false;
}

function saveBackfill(backfill) {
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  } catch (error) {
    console.error(`  ⚠ failed to save ${OUTPUT_FILE}: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadTrailer(item) {
  const outBase = path.join(TMP_DIR, item.id);
  // Clean slate - a previous failed attempt may have left partial files.
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (f.startsWith(item.id + ".")) fs.rmSync(path.join(TMP_DIR, f), { force: true });
  }

  try {
    execFileSync(
      "yt-dlp",
      [
        "-f", FORMAT_SELECTOR,
        "--merge-output-format", "mp4",
        "--write-subs",
        "--write-auto-sub",
        "--sub-langs", "en,pt",
        "--convert-subs", "vtt",
        // YouTube rate-limits the caption endpoint specifically (confirmed:
        // HTTP 429 on back-to-back requests) - without --ignore-errors, a
        // single failed subtitle fetch aborts the whole invocation, losing
        // the video too. --sleep-subtitles/--sleep-requests cut down on
        // actually hitting that limit in the first place.
        "--ignore-errors",
        "--sleep-subtitles", "2",
        "--sleep-requests", "0.5",
        "--no-progress",
        "-o", `${outBase}.%(ext)s`,
        `https://youtube.com/watch?v=${item.trailer_key}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 5 * 60 * 1000 }
    );
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString().split("\n").slice(-3).join(" ") : error.message;
    throw new Error(`yt-dlp failed: ${stderr}`);
  }

  const mp4Path = `${outBase}.mp4`;
  if (!fs.existsSync(mp4Path)) throw new Error("yt-dlp produced no mp4 output");

  const subtitlePaths = fs
    .readdirSync(TMP_DIR)
    .filter((f) => f.startsWith(item.id + ".") && f.endsWith(".vtt"))
    .map((f) => path.join(TMP_DIR, f));

  return { mp4Path, subtitlePaths };
}

async function processOne(item, backfill) {
  console.log(`[${item.id}] ${item.title}`);

  let mp4Path, subtitlePaths;
  try {
    ({ mp4Path, subtitlePaths } = await downloadTrailer(item));
  } catch (error) {
    console.log(`  ✗ ${error.message}`);
    return false;
  }

  if (DRY_RUN) {
    const sizeMB = (fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1);
    console.log(`  (dry run) would upload ${sizeMB}MB + ${subtitlePaths.length} subtitle track(s)`);
    fs.rmSync(mp4Path, { force: true });
    for (const p of subtitlePaths) fs.rmSync(p, { force: true });
    return true;
  }

  const videoKey = `${S3_PREFIX(item.id)}trailer.mp4`;
  const videoOk = await uploadToS3(mp4Path, videoKey, "video", "video/mp4");
  fs.rmSync(mp4Path, { force: true });
  if (!videoOk) {
    for (const p of subtitlePaths) fs.rmSync(p, { force: true });
    return false;
  }

  const subtitles = [];
  for (const subPath of subtitlePaths) {
    // yt-dlp names these <id>.<lang>.vtt (or <id>.<lang>.<something>.vtt for
    // auto-generated tracks) - the language code is always the first
    // dot-segment after the base name.
    const rest = path.basename(subPath).slice(item.id.length + 1);
    const lang2 = rest.split(".")[0];
    const lang3 = LANG_TO_ISO_639_2[lang2] ?? lang2;
    const subKey = `${S3_PREFIX(item.id)}trailer.${lang3}.vtt`;
    const ok = await uploadToS3(subPath, subKey, `sub:${lang3}`, "text/vtt; charset=utf-8");
    fs.rmSync(subPath, { force: true });
    if (ok) {
      subtitles.push({ lang: lang3, label: LANG_LABELS[lang3] ?? lang3.toUpperCase(), s3_key: subKey });
    }
  }

  backfill[item.id] = { s3_key: videoKey, subtitles };
  console.log(`  ✓ done (${subtitles.length} subtitle track(s))`);
  return true;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const targets = catalog.filter((i) => i.trailer_key);

  const backfill = fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8")) : {};
  const pending = targets.filter((i) => !backfill[i.id]).slice(0, LIMIT);

  console.log(
    `${targets.length} items have a trailer_key, ${Object.keys(backfill).length} already done, ${pending.length} to process${DRY_RUN ? " (DRY RUN)" : ""}.\n`
  );

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    process.stdout.write(`[${i + 1}/${pending.length}] `);
    const success = await processOne(item, backfill);
    if (success) ok++;
    else failed++;

    if (!DRY_RUN && (i + 1) % 10 === 0) saveBackfill(backfill);
    // Small delay between downloads - not hammering YouTube back-to-back
    // across hundreds of requests.
    await sleep(1500);
  }
  if (!DRY_RUN) saveBackfill(backfill);

  console.log(`\nDone. OK: ${ok} | Failed: ${failed}${DRY_RUN ? " | (dry run, nothing uploaded)" : ""}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
