#!/usr/bin/env node

/**
 * Backfill missing subtitles from Yifysubtitles.ch — an unlimited source
 * that doesn't share the OpenSubtitles daily download quota.
 *
 * Why this exists: OpenSubtitles REST API caps anonymous downloads at
 * ~86/day. When that quota is exhausted, this script fills the gap for
 * movies (Yifysubtitles is movie-only, synced to YIFY/YTS releases).
 *
 * Flow per eligible movie:
 *   - Visit https://yifysubtitles.ch/movie-imdb/{imdb_id} (gets session cookie)
 *   - Parse subtitle links for brazilian-portuguese / english / spanish
 *   - Download the .zip with cookie + Referer header (required by CF)
 *   - Extract .srt from zip, convert to WebVTT
 *   - Upload under videos/<id>/yify.<lang>.vtt
 *   - Record into backend/data/subtitle_backfill.json (same side file)
 *
 * Usage:
 *   node scripts/pipeline/fetch-yifysubtitles.js [--limit N] [--dry-run] [--id some-id]
 *   node scripts/pipeline/fetch-yifysubtitles.js --langs eng,por,spa
 */

import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { execSync } from "child_process";
import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { convertSubtitleFileToVtt } from "./transcode.js";

const S3_PREFIX = (id) => `videos/${id}/`;
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/subtitle_backfill.json");
const TMP_DIR = path.join(os.tmpdir(), "tv-yify-subs");
fs.mkdirSync(TMP_DIR, { recursive: true });

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const idArg = process.argv.indexOf("--id");
const ONLY_ID = idArg !== -1 ? process.argv[idArg + 1] : null;
const langsArg = process.argv.indexOf("--langs");
const WANT_LANGS = new Set(
  (langsArg !== -1 ? process.argv[langsArg + 1] : "eng,por,spa")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const LANG_LABELS = { eng: "English", por: "Portuguese", spa: "Spanish" };

// Yifysubtitles URL language slug patterns
const LANG_SLUGS = {
  por: ["brazilian-portuguese", "brazilian", "portuguese"],
  eng: ["english"],
  spa: ["spanish"],
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_URL = "https://yifysubtitles.ch";

const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const UPLOAD_RETRIES = 3;
const SLEEP_BETWEEN_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveBackfill(backfill) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
}

function imdbIdFull(item) {
  const m = String(item.imdb_id || "").match(/(tt\d+)/);
  return m ? m[1] : null;
}

function existingLangsForEpisode(item, episode, backfillTracks) {
  const langs = new Set();
  for (const t of item.subtitles || []) {
    if ((t.episode ?? 0) === episode && t.lang) langs.add(t.lang);
  }
  for (const t of backfillTracks || []) {
    if ((t.episode ?? 0) === episode && t.lang) langs.add(t.lang);
  }
  return langs;
}

/**
 * Fetch the yifysubtitles movie page and parse subtitle download links.
 * Returns a map of lang → subtitle path (e.g. "/subtitle/...zip").
 */
async function fetchYifySubLinks(imdbFull, missingLangs) {
  // Get session cookie by visiting the listing page first
  const listRes = await fetch(`${BASE_URL}/movie-imdb/${imdbFull}`, {
    headers: { "User-Agent": BROWSER_UA },
  });
  if (!listRes.ok) {
    throw new Error(`yifysubtitles listing ${listRes.status} for ${imdbFull}`);
  }
  // Extract cookies from the response
  const cookies = listRes.headers.getSetCookie?.() || [];
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
  const html = await listRes.text();

  const picks = {};
  for (const lang of missingLangs) {
    const slugs = LANG_SLUGS[lang];
    if (!slugs) continue;
    // Find first subtitle link matching any of the language slugs
    let found = null;
    for (const slug of slugs) {
      // Match: href="/subtitles/...{slug}..."
      const re = new RegExp(`href="(/subtitles/[^"]*${slug}[^"]*)"`, "i");
      const m = html.match(re);
      if (m) {
        found = m[1];
        break;
      }
    }
    if (found) {
      // Convert subtitle page path to download path:
      // /subtitles/the-matrix-1999-english-yify-119099
      // → /subtitle/the-matrix-1999-english-yify-119099.zip
      const dlPath = found.replace("/subtitles/", "/subtitle/") + ".zip";
      picks[lang] = { subPath: found, dlPath, cookieStr };
    }
  }
  return picks;
}

/**
 * Download and extract .srt from a yifysubtitles .zip
 */
async function downloadYifyZip(dlPath, cookieStr, destPath, refererPath) {
  const res = await fetch(`${BASE_URL}${dlPath}`, {
    headers: {
      "User-Agent": BROWSER_UA,
      Cookie: cookieStr,
      Referer: `${BASE_URL}${refererPath}`,
    },
  });
  if (!res.ok) throw new Error(`yify download ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  extractSubFromZip(zipBuf, destPath);
  return destPath;
}

const SUB_EXTS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];

function extractSubFromZip(zipBuf, destPath) {
  const buf = Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD not found");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let off = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("latin1");
    off += 46 + nameLen + extraLen + commentLen;
    if (!SUB_EXTS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const compMethod = buf.readUInt16LE(localOff + 8);
    const rawData = buf.slice(dataOff, dataOff + compSize);
    let fileData;
    if (compMethod === 0) {
      fileData = rawData;
    } else if (compMethod === 8) {
      fileData = zlib.inflateRawSync(rawData);
    } else {
      throw new Error(`ZIP: unsupported compression ${compMethod}`);
    }
    fs.writeFileSync(destPath, fileData);
    return destPath;
  }
  throw new Error("ZIP: no subtitle file found");
}

async function uploadToS3(s3Client, bucketName, filePath, s3Key, label) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}`;
      process.stdout.write(`    [${label}] ${prefix} ${sizeMB}MB... `);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucketName,
          Key: s3Key,
          Body: fs.createReadStream(filePath),
          ContentType: "text/vtt; charset=utf-8",
        },
        queueSize: 4,
        partSize: 32 * 1024 * 1024,
      });
      await upload.done();
      console.log("✓");
      return true;
    } catch (error) {
      console.log(`✗ (${error.message})`);
      if (attempt < UPLOAD_RETRIES) await sleep(10_000 * attempt);
    }
  }
  return false;
}

function uniqueTrackId(lang, existingIds) {
  if (!existingIds.has(lang)) return lang;
  let n = 2;
  while (existingIds.has(`${lang}-${n}`)) n++;
  return `${lang}-${n}`;
}

async function main() {
  const data = loadJson(ENRICHED_FILE, null);
  if (!data?.items) {
    console.error(`Could not load ${ENRICHED_FILE}`);
    process.exit(1);
  }
  const backfill = loadJson(OUTPUT_FILE, {});

  let s3Client = null;
  let bucketName = null;
  if (!DRY_RUN) {
    const bucketCreds = JSON.parse(
      execSync("railway bucket credentials --bucket convenient-pannikin --json").toString(),
    );
    s3Client = new S3Client({
      region: bucketCreds.region,
      endpoint: bucketCreds.endpoint,
      forcePathStyle: bucketCreds.urlStyle !== "virtual-host",
      credentials: {
        accessKeyId: bucketCreds.accessKeyId,
        secretAccessKey: bucketCreds.secretAccessKey,
      },
      requestHandler: new NodeHttpHandler({
        requestTimeout: UPLOAD_STALL_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      }),
    });
    bucketName = bucketCreds.bucketName;
  }

  // Only movies with IMDB id and video on S3
  const candidates = data.items.filter((item) => {
    if (ONLY_ID && item.id !== ONLY_ID) return false;
    if (item.content_type !== "movie") return false;
    if (!item.s3_key && !(item.s3_keys?.length > 0)) return false;
    if (!imdbIdFull(item)) return false;
    return true;
  });

  // Sort: missing Portuguese first
  candidates.sort((a, b) => {
    const aBack = backfill[a.id]?.subtitles || [];
    const bBack = backfill[b.id]?.subtitles || [];
    const aHave = existingLangsForEpisode(a, 0, aBack);
    const bHave = existingLangsForEpisode(b, 0, bBack);
    const aMissPor = WANT_LANGS.has("por") && !aHave.has("por") ? 0 : 1;
    const bMissPor = WANT_LANGS.has("por") && !bHave.has("por") ? 0 : 1;
    return aMissPor - bMissPor || a.title.localeCompare(b.title);
  });

  console.log(
    `Scanning ${candidates.length} movies (Yifysubtitles)` +
      (ONLY_ID ? ` (filter id=${ONLY_ID})` : "") +
      ` for missing langs: ${[...WANT_LANGS].join(",")}`,
  );

  let processed = 0;
  let uploaded = 0;
  let skipped = 0;

  for (const item of candidates) {
    if (processed >= LIMIT) break;

    const imdbFull = imdbIdFull(item);
    const entry = backfill[item.id] || { subtitles: [] };
    const have = existingLangsForEpisode(item, 0, entry.subtitles);
    const missing = new Set([...WANT_LANGS].filter((l) => !have.has(l)));
    if (missing.size === 0) {
      skipped++;
      continue;
    }

    process.stdout.write(`  [${item.title}] missing=${[...missing].join(",")}… `);

    let picks;
    try {
      picks = await fetchYifySubLinks(imdbFull, missing);
    } catch (e) {
      console.log(`fetch failed: ${e.message}`);
      skipped++;
      continue;
    }

    const foundLangs = Object.keys(picks);
    if (foundLangs.length === 0) {
      console.log(`no subtitles found`);
      skipped++;
      continue;
    }
    console.log(`found ${foundLangs.join(",")}`);

    // Prefer por first
    const langOrder = { por: 0, eng: 1, spa: 2 };
    foundLangs.sort((a, b) => (langOrder[a] ?? 9) - (langOrder[b] ?? 9));

    const usedIds = new Set([
      ...(item.subtitles || []).filter((t) => (t.episode ?? 0) === 0).map((t) => t.id),
      ...entry.subtitles.filter((t) => (t.episode ?? 0) === 0).map((t) => t.id),
    ]);

    let itemDidWork = false;

    for (const lang of foundLangs) {
      const pick = picks[lang];
      const trackId = uniqueTrackId(lang, usedIds);
      usedIds.add(trackId);
      const rawPath = path.join(TMP_DIR, `${item.id}.${trackId}.src`);
      const vttPath = path.join(TMP_DIR, `${item.id}.${trackId}.vtt`);
      const s3Key = `${S3_PREFIX(item.id)}yify.${trackId}.vtt`;

      if (DRY_RUN) {
        console.log(`    (dry run) would download ${pick.dlPath} → ${s3Key}`);
        itemDidWork = true;
        continue;
      }

      try {
        await downloadYifyZip(pick.dlPath, pick.cookieStr, rawPath, pick.subPath);
        await convertSubtitleFileToVtt(rawPath, vttPath);

        const ok = await uploadToS3(s3Client, bucketName, vttPath, s3Key, `${item.title} [${trackId}]`);
        if (!ok) continue;

        entry.subtitles.push({
          episode: 0,
          id: trackId,
          lang,
          label: LANG_LABELS[lang] || lang.toUpperCase(),
          forced: false,
          s3_key: s3Key,
        });
        uploaded++;
        itemDidWork = true;
        await sleep(SLEEP_BETWEEN_MS);
      } catch (e) {
        console.log(`    ⚠ ${lang} failed: ${e.message}`);
      } finally {
        fs.rmSync(rawPath, { force: true });
        fs.rmSync(vttPath, { force: true });
      }
    }

    if (itemDidWork) {
      backfill[item.id] = entry;
      if (!DRY_RUN) saveBackfill(backfill);
      processed++;
    } else {
      skipped++;
    }
  }

  if (!DRY_RUN) saveBackfill(backfill);
  console.log(
    `\nDone. items_updated=${processed} tracks_uploaded=${uploaded} skipped=${skipped}` +
      (DRY_RUN ? " (dry-run)" : ` → ${OUTPUT_FILE}`),
  );
  console.log("Restart the backend so apply_subtitle_backfill picks up new tracks.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
