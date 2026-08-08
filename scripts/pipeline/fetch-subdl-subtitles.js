#!/usr/bin/env node

/**
 * Backfill missing subtitles from SubDL.com — unlimited source covering
 * both movies AND TV shows (unlike Yifysubtitles which is movies-only).
 *
 * Why this exists: OpenSubtitles caps downloads at ~86/day and Yifysubtitles
 * doesn't cover TV series. SubDL has no download quota and covers 15,500+
 * TV shows with free SRT downloads, server-rendered pages (no JS needed).
 *
 * Flow per eligible title:
 *   - Search SubDL by IMDB ID → get sd{ID} page
 *   - Parse season/language pages for dl.subdl.com/subtitle/{id}.zip links
 *   - For movies: download from the title's language page
 *   - For TV: download per-season, matching episodes to s3_keys
 *   - Extract .srt from zip, convert to WebVTT, upload, record
 *
 * Usage:
 *   node scripts/pipeline/fetch-subdl-subtitles.js [--limit N] [--dry-run] [--id some-id]
 *   node scripts/pipeline/fetch-subdl-subtitles.js --langs eng,por,spa
 */

import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { execSync } from "child_process";
import {
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { convertSubtitleFileToVtt } from "./transcode.js";

const S3_PREFIX = (id) => `videos/${id}/`;
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/subtitle_backfill.json");
const TMP_DIR = path.join(os.tmpdir(), "tv-subdl-subs");
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
const LANG_SLUGS = {
  por: ["portuguese", "brazilian-portuguese"],
  eng: ["english"],
  spa: ["spanish"],
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_URL = "https://subdl.com";

const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const UPLOAD_RETRIES = 3;
const SLEEP_BETWEEN_MS = 3000;

const SEASON_WORDS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth",
];

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

function uniqueTrackId(lang, existingIds) {
  if (!existingIds.has(lang)) return lang;
  let n = 2;
  while (existingIds.has(`${lang}-${n}`)) n++;
  return `${lang}-${n}`;
}

/**
 * Search SubDL by title to find the sd{ID} page URL.
 * Returns { sdId, slug } or null.
 */
async function findSubDlPage(searchQuery) {
  const res = await fetch(`${BASE_URL}/search/${encodeURIComponent(searchQuery)}`, {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();
  // Look for first subtitle page link: /subtitle/sd{id}/{slug}
  // Skip "minisodes", "best moments", etc. — match the exact title
  const matches = [...html.matchAll(/href="\/subtitle\/(sd\d+)\/([a-z0-9-]+)"/gi)];
  for (const m of matches) {
    return { sdId: m[1], slug: m[2] };
  }
  return null;
}

/**
 * Fetch a SubDL page and extract download links.
 * Returns array of { dlUrl, episode (SxxExx or null), release }
 */
async function parseSubDlPage(sdId, slug, langSlug) {
  const url = `${BASE_URL}/subtitle/${sdId}/${slug}/${langSlug}`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "follow",
  });
  if (!res.ok) return [];
  const html = await res.text();

  const results = [];
  // Find all download links: dl.subdl.com/subtitle/{id}.zip
  // They appear alongside episode info like S01E07
  const dlRegex = /dl\.subdl\.com\/subtitle\/([0-9-]+)\.zip/gi;
  // Also find SxxExx patterns near each download
  const lines = html.split("\n");
  let currentEp = null;
  for (const line of lines) {
    const epMatch = line.match(/S(\d{1,2})E(\d{1,2})/i);
    if (epMatch) {
      currentEp = {
        season: parseInt(epMatch[1], 10),
        episode: parseInt(epMatch[2], 10),
      };
    }
    let dlMatch;
    const dlRe = /dl\.subdl\.com\/subtitle\/([0-9-]+)\.zip/gi;
    while ((dlMatch = dlRe.exec(line)) !== null) {
      results.push({
        dlUrl: `https://dl.subdl.com/subtitle/${dlMatch[1]}.zip`,
        episode: currentEp,
      });
    }
  }
  return results;
}

/**
 * Fetch a SubDL season page and extract download links with episode numbers.
 */
async function parseSubDlSeasonPage(sdId, slug, langSlug, seasonNum) {
  const seasonWord = SEASON_WORDS[seasonNum - 1];
  if (!seasonWord) return [];
  const url = `${BASE_URL}/subtitle/${sdId}/${slug}/${seasonWord}-season/${langSlug}`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "follow",
  });
  if (!res.ok) return [];
  const html = await res.text();

  const results = [];
  const lines = html.split("\n");
  let currentEp = null;
  for (const line of lines) {
    const epMatch = line.match(/S(\d{1,2})E(\d{1,2})/i);
    if (epMatch) {
      currentEp = {
        season: parseInt(epMatch[1], 10),
        episode: parseInt(epMatch[2], 10),
      };
    }
    const dlRe = /dl\.subdl\.com\/subtitle\/([0-9-]+)\.zip/gi;
    let dlMatch;
    while ((dlMatch = dlRe.exec(line)) !== null) {
      results.push({
        dlUrl: `https://dl.subdl.com/subtitle/${dlMatch[1]}.zip`,
        episode: currentEp,
      });
    }
  }
  return results;
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

async function downloadSubDlZip(dlUrl, destPath, referer) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(dlUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: referer || BASE_URL,
      },
      redirect: "follow",
    });
    if (res.ok) {
      const zipBuf = Buffer.from(await res.arrayBuffer());
      extractSubFromZip(zipBuf, destPath);
      return destPath;
    }
    if (res.status === 429 && attempt < 3) {
      // Rate limited — wait and retry with exponential backoff
      const wait = 10_000 * (attempt + 1);
      process.stdout.write(`(429, waiting ${wait / 1000}s…) `);
      await sleep(wait);
      continue;
    }
    throw new Error(`subdl download ${res.status}`);
  }
  throw new Error("subdl download: max retries exhausted");
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

  const candidates = data.items.filter((item) => {
    if (ONLY_ID && item.id !== ONLY_ID) return false;
    if (!item.s3_key && !(item.s3_keys?.length > 0)) return false;
    if (!imdbIdFull(item)) return false;
    return true;
  });

  // Sort: missing Portuguese first, then by title
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
    `Scanning ${candidates.length} titles (SubDL)` +
      (ONLY_ID ? ` (filter id=${ONLY_ID})` : "") +
      ` for missing langs: ${[...WANT_LANGS].join(",")}`,
  );

  let processed = 0;
  let uploaded = 0;
  let skipped = 0;

  for (const item of candidates) {
    if (processed >= LIMIT) break;

    const imdbFull = imdbIdFull(item);
    const isMovie = item.content_type === "movie";
    const entry = backfill[item.id] || { subtitles: [] };

    // Determine which episodes need subs
    let epsToCover;
    if (isMovie || !(item.s3_keys?.length > 1)) {
      epsToCover = [{ episode: 0, season: 1, ep: null, epIndex: 0 }];
    } else {
      const meta = item.episodes || [];
      if (meta.length > 0) {
        epsToCover = meta.map((e, i) => ({
          episode: e.episode,
          season: e.season_number,
          ep: e.episode_number,
          epIndex: i,
        }));
      } else {
        // No episode metadata — use positional 1..N within season 1
        // SubDL season pages list subs by SxxExx; we'll try to match by
        // episode number, falling back to first-N downloads.
        const numEps = item.s3_keys?.length || 1;
        epsToCover = Array.from({ length: numEps }, (_, i) => ({
          episode: i + 1,
          season: 1,
          ep: i + 1,
          epIndex: i,
        }));
      }
    }
    if (epsToCover.length === 0) { skipped++; continue; }
    const hasEpisodeMeta = (item.episodes || []).length > 0;

    // Check what's missing
    const missingByEp = new Map();
    for (const { episode } of epsToCover) {
      const have = existingLangsForEpisode(item, episode, entry.subtitles);
      const missing = new Set([...WANT_LANGS].filter((l) => !have.has(l)));
      if (missing.size > 0) missingByEp.set(episode, missing);
    }
    if (missingByEp.size === 0) { skipped++; continue; }

    process.stdout.write(`  [${item.title}] missing on ${missingByEp.size} episode(s)… `);

    // Find SubDL page
    let page;
    try {
      page = await findSubDlPage(item.title);
    } catch (e) {
      console.log(`search failed: ${e.message}`);
      skipped++;
      continue;
    }
    if (!page) {
      console.log(`not found on SubDL`);
      skipped++;
      continue;
    }

    const usedIds = new Set([
      ...(item.subtitles || []).map((t) => t.id),
      ...entry.subtitles.map((t) => t.id),
    ]);

    let itemDidWork = false;

    for (const [episode, missingLangs] of missingByEp) {
      if (uploaded >= LIMIT * 3) break; // safety

      for (const lang of [...missingLangs].sort((a, b) =>
        ({ por: 0, eng: 1, spa: 2 }[a] ?? 9) - ({ por: 0, eng: 1, spa: 2 }[b] ?? 9),
      )) {
        const langSlug = LANG_SLUGS[lang]?.[0];
        if (!langSlug) continue;

        // Get download links for this language
        let dlLinks = [];
        try {
          const epInfo = epsToCover.find((e) => e.episode === episode);
          if (isMovie) {
            dlLinks = await parseSubDlPage(page.sdId, page.slug, langSlug);
          } else if (epInfo?.season) {
            dlLinks = await parseSubDlSeasonPage(page.sdId, page.slug, langSlug, epInfo.season);
            // If we have a real episode number, try to filter
            if (epInfo.ep) {
              const matched = dlLinks.filter(
                (d) => d.episode && d.episode.season === epInfo.season && d.episode.episode === epInfo.ep,
              );
              // Fall back to positional if no SxxExx match (no metadata case)
              if (matched.length > 0) dlLinks = matched;
              else if (!hasEpisodeMeta) dlLinks = [dlLinks[epInfo.epIndex]].filter(Boolean);
            }
          } else {
            dlLinks = await parseSubDlPage(page.sdId, page.slug, langSlug);
          }
        } catch (e) {
          // continue
        }

        if (dlLinks.length === 0) continue;
        // Take first available
        const pick = dlLinks[0];

        const trackId = uniqueTrackId(`${lang}-${episode}`, usedIds);
        usedIds.add(trackId);
        const rawPath = path.join(TMP_DIR, `${item.id}.${episode}.${trackId}.src`);
        const vttPath = path.join(TMP_DIR, `${item.id}.${episode}.${trackId}.vtt`);
        const s3Key = `${S3_PREFIX(item.id)}subdl.${episode}.${trackId}.vtt`;
        const label = isMovie ? item.title : `${item.title} ep${episode}`;

        if (DRY_RUN) {
          console.log(`\n    (dry run) ${lang} ep${episode} → ${s3Key}`);
          itemDidWork = true;
          continue;
        }

        try {
          const referer = `${BASE_URL}/subtitle/${page.sdId}/${page.slug}/${langSlug}`;
          await downloadSubDlZip(pick.dlUrl, rawPath, referer);
          await convertSubtitleFileToVtt(rawPath, vttPath);
          const ok = await uploadToS3(s3Client, bucketName, vttPath, s3Key, `${label} [${trackId}]`);
          if (!ok) continue;

          entry.subtitles.push({
            episode,
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
          console.log(`\n    ⚠ ${lang} ep${episode} failed: ${e.message}`);
        } finally {
          fs.rmSync(rawPath, { force: true });
          fs.rmSync(vttPath, { force: true });
        }
      }
    }

    if (itemDidWork) {
      console.log(`  [${item.title}] done`);
      backfill[item.id] = entry;
      if (!DRY_RUN) saveBackfill(backfill);
      processed++;
    } else {
      // Only print if we printed "missing" earlier
      console.log(` (nothing downloadable)`);
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
