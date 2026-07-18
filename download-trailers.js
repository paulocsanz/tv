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
import httpsProxyAgentPkg from "https-proxy-agent";
const { HttpsProxyAgent } = httpsProxyAgentPkg;
import { NodeHttpHandler } from "@smithy/node-http-handler";

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
// See download-picked-torrents.js's UPLOAD_STALL_TIMEOUT_MS for why every
// client gets an explicit requestTimeout - a hung proxy/connection can leave
// a request's socket ESTABLISHED with zero bytes ever moving again, and
// requestTimeout is Node's own socket-level *idle* timeout (no activity for
// this long, not "the whole request must finish by X"), so it fires on a
// genuinely dead connection without punishing a legitimately slow-but-active
// upload.
const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000;

function s3ClientConfig(httpsAgent) {
  return {
    region: bucketCreds.region,
    endpoint: bucketCreds.endpoint,
    forcePathStyle: bucketCreds.urlStyle !== "virtual-host",
    credentials: {
      accessKeyId: bucketCreds.accessKeyId,
      secretAccessKey: bucketCreds.secretAccessKey,
    },
    requestHandler: new NodeHttpHandler({ httpsAgent, requestTimeout: UPLOAD_STALL_TIMEOUT_MS }),
  };
}
const s3Client = new S3Client(s3ClientConfig());
const BUCKET_NAME = bucketCreds.bucketName;

// See download-picked-torrents.js's loadProxyClients for why this exists -
// same bucket, same home-ISP route penalty, same ~3.7x-per-connection win
// from routing through a third-party proxy instead. Kept as an independent
// copy rather than a shared import since these two scripts already don't
// share any module and this one is small enough not to be worth factoring
// out for.
const PROXY_LIST_FILE = path.join(os.homedir(), ".config/tv-pipeline/webshare-proxies.txt");
function loadProxyClients() {
  let lines;
  try {
    lines = fs.readFileSync(PROXY_LIST_FILE, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((line) => {
    const [ip, port, user, pass] = line.split(":");
    const agent = new HttpsProxyAgent(`http://${user}:${pass}@${ip}:${port}`);
    return new S3Client(s3ClientConfig(agent));
  });
}
const proxyClients = loadProxyClients();
// See download-picked-torrents.js's pickS3Client for why this starts random
// (a fixed 0 means one bad proxy near the top of the file gets hit first on
// every restart) and why bad proxies get quarantined for the rest of the run
// instead of trusted to self-heal via retry alone (requestTimeout isn't
// reliable against a hung proxy CONNECT tunnel specifically).
let nextProxyIndex = proxyClients.length > 0 ? Math.floor(Math.random() * proxyClients.length) : 0;
const badProxyIndices = new Set();
function pickS3Client() {
  if (proxyClients.length === 0) return { client: s3Client, index: -1 };
  for (let tries = 0; tries < proxyClients.length; tries++) {
    const index = nextProxyIndex % proxyClients.length;
    nextProxyIndex++;
    if (!badProxyIndices.has(index)) return { client: proxyClients[index], index };
  }
  return { client: s3Client, index: -1 };
}
function quarantineProxy(index) {
  if (index >= 0) badProxyIndices.add(index);
}
console.log(
  proxyClients.length > 0
    ? `Using ${proxyClients.length} proxies for uploads (round-robin).`
    : `No proxy list found at ${PROXY_LIST_FILE} - uploading directly.`
);

const UPLOAD_RETRIES = 3;

async function uploadToS3(filePath, s3Key, label, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      process.stdout.write(`    [${label}] ${prefix} ${sizeMB}MB... `);
      const { client, index: proxyIndex } = pickS3Client();
      const upload = new Upload({
        client,
        params: { Bucket: BUCKET_NAME, Key: s3Key, Body: fs.createReadStream(filePath), ContentType: contentType },
        queueSize: 4,
        partSize: 32 * 1024 * 1024,
      });
      // See download-picked-torrents.js's identical race for why this is a
      // hard client-side timeout independent of the SDK/socket ever
      // noticing the hang.
      let timedOut = false;
      await Promise.race([
        upload.done(),
        new Promise((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            upload.abort().catch(() => {});
            reject(new Error(`stalled - no completion after ${UPLOAD_STALL_TIMEOUT_MS / 60000}m`));
          }, UPLOAD_STALL_TIMEOUT_MS)
        ),
      ]).catch((error) => {
        if (timedOut) quarantineProxy(proxyIndex);
        throw error;
      });
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
  let completed = 0;
  let nextIndex = 0;

  // PARALLELISM=3 (2026-07-11) triggered YouTube's account-level anti-bot
  // detection ("Sign in to confirm you're not a bot") partway through a
  // run - not simple rate-limiting, a real lockout that failed ~380
  // consecutive items until it cleared on its own. Back to strictly
  // sequential (one item at a time, no worker pool) until there's a safer
  // way to get real parallelism (e.g. rotating egress IPs) - the S3
  // upload-throughput win isn't worth risking another lockout for.
  const PARALLELISM = 1;

  async function worker() {
    while (nextIndex < pending.length) {
      const myIndex = nextIndex++;
      const item = pending[myIndex];
      process.stdout.write(`[${myIndex + 1}/${pending.length}] `);
      const success = await processOne(item, backfill);
      completed++;
      if (success) ok++;
      else failed++;

      if (!DRY_RUN && completed % 10 === 0) saveBackfill(backfill);
      await sleep(2000);
    }
  }

  await Promise.all(Array.from({ length: PARALLELISM }, () => worker()));
  if (!DRY_RUN) saveBackfill(backfill);

  console.log(`\nDone. OK: ${ok} | Failed: ${failed}${DRY_RUN ? " | (dry run, nothing uploaded)" : ""}`);
  // The S3 client keeps its HTTP keep-alive pool open, which otherwise
  // leaves the process hanging indefinitely after main() resolves (all
  // work genuinely done, 0% CPU, nothing left to do) instead of exiting.
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
