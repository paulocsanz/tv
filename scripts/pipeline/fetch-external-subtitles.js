#!/usr/bin/env node

/**
 * Backfill missing softsubs from OpenSubtitles.com for catalog titles that
 * already have video on S3 but no (or incomplete) subtitle tracks.
 *
 * Why this exists: the pipeline extracts embedded text tracks and sidecar
 * .srt/.ass from the torrent, but most YIFY/WEB-DL rips ship English audio
 * with zero softsubs. The player already has a captions menu - it only
 * shows when `item.subtitles` has tracks for the current episode - so the
 * gap is acquisition, not UI. See rfcs/0010-subtitle-acquisition.md.
 *
 * For each eligible item (has s3_key/s3_keys, has imdb_id, missing at least
 * one of eng/por/spa for a given episode):
 *   - Hash the S3 video (OpenSubtitles moviehash: first+last 64KiB) so we
 *     can prefer subtitles indexed against *this exact rip*, not just IMDB id
 *   - Search OpenSubtitles by moviehash + IMDB id (+ season/episode for TV)
 *   - Download one best file per missing language (hash-match first)
 *   - Convert SRT/ASS → WebVTT; optional duration sanity check vs catalog runtime
 *   - Upload under videos/<id>/external.<episode>.<lang>.vtt
 *   - Record into backend/data/subtitle_backfill.json (side file - same
 *     rationale as trailer_backfill.json: a live pipeline rewrites
 *     enriched_400.json continuously and would clobber direct edits)
 *
 * The backend merges that side file on boot (apply_subtitle_backfill) and
 * collapses to one track per language.
 *
 * Requires:
 *   OPENSUBTITLES_API_KEY   - free key from https://www.opensubtitles.com/en/consumers
 *   Optional login for higher daily download quota:
 *     OPENSUBTITLES_USERNAME / OPENSUBTITLES_PASSWORD
 *   S3 credentials via `railway bucket credentials` (same as download-trailers.js)
 *
 * Usage:
 *   node scripts/pipeline/fetch-external-subtitles.js [--limit N] [--dry-run] [--id the-matrix-1999-movie]
 *   node scripts/pipeline/fetch-external-subtitles.js --langs eng,por
 *   node scripts/pipeline/fetch-external-subtitles.js --require-hash   # skip IMDB-only fallback
 *   node scripts/pipeline/fetch-external-subtitles.js --skip-duration-check
 */

import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { execSync } from "child_process";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { convertSubtitleFileToVtt } from "./transcode.js";

const S3_PREFIX = (id) => `videos/${id}/`;
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/subtitle_backfill.json");
const TMP_DIR = path.join(os.tmpdir(), "tv-subtitle-backfill");
fs.mkdirSync(TMP_DIR, { recursive: true });

const DRY_RUN = process.argv.includes("--dry-run");
// Only accept OpenSubtitles rows that match our file's moviehash (rip-level
// sync). Without a hash we still fall back to IMDB unless this is set.
const REQUIRE_HASH = process.argv.includes("--require-hash");
// Reject VTT whose last cue is wildly off the catalog runtime (±25%).
const CHECK_DURATION = !process.argv.includes("--skip-duration-check");
const limitArg = process.argv.findIndex((a) => a === "--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const idArg = process.argv.findIndex((a) => a === "--id");
const ONLY_ID = idArg !== -1 ? process.argv[idArg + 1] : null;
const langsArg = process.argv.findIndex((a) => a === "--langs");
const WANT_LANGS = new Set(
  (langsArg !== -1 ? process.argv[langsArg + 1] : "eng,por,spa")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const LANG_LABELS = { eng: "English", por: "Portuguese", spa: "Spanish" };
// OpenSubtitles REST API uses IETF tags; catalog stores ISO 639-2 to match
// ffprobe / existing SubtitleTrack entries.
const LANG_TO_OS = { eng: "en", por: "pt-br", spa: "es" };
const OS_TO_LANG = {
  en: "eng",
  eng: "eng",
  pt: "por",
  "pt-br": "por",
  "pt-pt": "por",
  por: "por",
  es: "spa",
  spa: "spa",
};

const API_BASE = "https://api.opensubtitles.com/api/v1";
const API_KEY = process.env.OPENSUBTITLES_API_KEY;
const USER_AGENT = process.env.OPENSUBTITLES_USER_AGENT || "tv-platform v1.0";

const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const UPLOAD_RETRIES = 3;
// Free tier is tight on downloads/day; stay polite between items.
const SLEEP_BETWEEN_DOWNLOADS_MS = 1500;

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
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  } catch (error) {
    console.error(`  ⚠ failed to save ${OUTPUT_FILE}: ${error.message}`);
  }
}

function imdbNumeric(imdbId) {
  // Catalog stores "tt0133093"; OpenSubtitles wants the bare number.
  if (!imdbId) return null;
  const m = String(imdbId).match(/(\d+)/);
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

function episodesToCover(item) {
  // Movies and single-file items use episode 0 (catalog convention).
  if (item.content_type === "movie" || !(item.s3_keys?.length > 1)) {
    return [{ episode: 0, season: null, ep: null }];
  }
  // Prefer TMDB-backed episode metadata when present so OpenSubtitles gets
  // real season/episode numbers instead of filename guesses.
  const meta = item.episodes || [];
  if (meta.length > 0) {
    return meta.map((e) => ({
      episode: e.episode,
      season: e.season_number,
      ep: e.episode_number,
    }));
  }
  // Fall back to positional 1..N without S/E - OpenSubtitles won't match
  // well without season/episode, so skip TV that has no metadata rather
  // than burning quota on junk queries.
  return [];
}

async function osFetch(urlPath, { method = "GET", body, token } = {}) {
  const headers = {
    "Api-Key": API_KEY,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || res.statusText;
    throw new Error(`OpenSubtitles ${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  return data;
}

async function loginIfConfigured() {
  const user = process.env.OPENSUBTITLES_USERNAME;
  const pass = process.env.OPENSUBTITLES_PASSWORD;
  if (!user || !pass) return null;
  const data = await osFetch("/login", {
    method: "POST",
    body: { username: user, password: pass },
  });
  return data?.token || null;
}

// OpenSubtitles movie hash: filesize + sum of first/last 64KiB as little-endian
// uint64 words (classic OSDB algorithm). Matching this to a result means the
// subtitle was indexed against the *same bytes* as our S3 object — the only
// practical way to get rip-level sync without guessing.
const OS_HASH_CHUNK = 64 * 1024;

function sumUInt64LE(buf) {
  let sum = 0n;
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = view.length - (view.length % 8);
  for (let i = 0; i < len; i += 8) {
    sum += view.readBigUInt64LE(i);
  }
  return sum & 0xffffffffffffffffn;
}

/** @param {Buffer} head first 64KiB @param {Buffer} tail last 64KiB @param {number} fileSize */
function openSubtitlesMovieHash(head, tail, fileSize) {
  let hash = BigInt(fileSize);
  hash = (hash + sumUInt64LE(head)) & 0xffffffffffffffffn;
  hash = (hash + sumUInt64LE(tail)) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Hash an S3 object without downloading the whole file (two Range GETs). */
async function movieHashFromS3(s3Client, bucket, key) {
  const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const fileSize = Number(head.ContentLength || 0);
  if (fileSize < OS_HASH_CHUNK * 2) {
    throw new Error(`object too small for moviehash (${fileSize} bytes)`);
  }
  const first = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${OS_HASH_CHUNK - 1}`,
    }),
  );
  const last = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${fileSize - OS_HASH_CHUNK}-${fileSize - 1}`,
    }),
  );
  const headBuf = await streamToBuffer(first.Body);
  const tailBuf = await streamToBuffer(last.Body);
  return {
    hash: openSubtitlesMovieHash(headBuf, tailBuf, fileSize),
    fileSize,
  };
}

/** s3_key for this catalog episode index (0 = movie / single file). */
function s3KeyForEpisode(item, episode) {
  if (episode > 0 && item.s3_keys?.length) {
    return item.s3_keys[episode - 1] || item.s3_key || null;
  }
  return item.s3_key || item.s3_keys?.[0] || null;
}

/** Catalog runtime string ("136 min") → seconds, or null. */
function runtimeSeconds(item) {
  const r = item.runtime;
  if (!r) return null;
  const m = String(r).match(/(\d+)\s*min/i);
  if (m) return parseInt(m[1], 10) * 60;
  const h = String(r).match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
  if (h) return parseInt(h[1], 10) * 3600 + (h[2] ? parseInt(h[2], 10) * 60 : 0);
  return null;
}

/** Last cue end time in a WebVTT file (seconds), or null. */
function vttLastCueSeconds(vttPath) {
  const text = fs.readFileSync(vttPath, "utf8");
  // 00:01:02.000 --> 00:01:05.500  or  01:02.000 --> 01:05.500
  const re = /(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*((\d{2}:)?\d{2}:\d{2}[.,]\d{3})/g;
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m[2];
  }
  if (!last) return null;
  const parts = last.replace(",", ".").split(":");
  let sec = 0;
  if (parts.length === 3) {
    sec = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    sec = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  return sec;
}

/**
 * One file per language. Prefer moviehash matches (same rip as our S3
 * object), then non-HI, then download_count.
 */
function pickBestPerLang(results, missingLangs, { preferHashMatch = true } = {}) {
  const candidates = [];
  for (const row of results || []) {
    const attrs = row.attributes || row;
    const langTag = (attrs.language || attrs.language_code || "").toLowerCase();
    const lang = OS_TO_LANG[langTag];
    if (!lang || !missingLangs.has(lang)) continue;
    const files = attrs.files || [];
    const fileId = files[0]?.file_id ?? attrs.file_id;
    if (!fileId) continue;
    // API may flag hash match on the row or nested feature details.
    const hashMatch = Boolean(
      attrs.moviehash_match === true ||
        attrs.moviehash_match === "true" ||
        attrs.feature_details?.moviehash_match,
    );
    candidates.push({
      lang,
      fileId,
      legacySubId: attrs.legacy_subtitle_id || null,
      fileName: files[0]?.file_name || attrs.release || `${lang}.srt`,
      downloads: attrs.download_count || 0,
      hi: Boolean(attrs.hearing_impaired),
      hashMatch,
      fromTrusted: Boolean(attrs.from_trusted),
    });
  }
  candidates.sort((a, b) => {
    if (preferHashMatch && a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1;
    if (a.hi !== b.hi) return a.hi ? 1 : -1;
    if (b.downloads !== a.downloads) return b.downloads - a.downloads;
    if (a.fromTrusted !== b.fromTrusted) return a.fromTrusted ? -1 : 1;
    return 0;
  });
  const byLang = new Map();
  for (const c of candidates) {
    if (!byLang.has(c.lang)) byLang.set(c.lang, c);
  }
  return [...byLang.values()];
}

async function searchSubtitles({ imdb, languages, season, episode, moviehash }) {
  const params = new URLSearchParams();
  if (imdb) params.set("imdb_id", imdb);
  params.set("languages", languages.join(","));
  params.set("order_by", "download_count");
  params.set("order_direction", "desc");
  if (season != null) params.set("season_number", String(season));
  if (episode != null) params.set("episode_number", String(episode));
  // When we have a hash, ask for matches against that exact file first.
  if (moviehash) {
    params.set("moviehash", moviehash);
    // "include" returns hash hits ranked high; still includes non-hash rows.
    params.set("moviehash_match", "include");
  }
  const data = await osFetch(`/subtitles?${params.toString()}`);
  return data?.data || [];
}

const SUB_EXTS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];

/** Extract the first subtitle file from a ZIP buffer to destPath. */
function extractSubFromZip(zipBuf, destPath) {
  // Minimal central-directory ZIP parse: find .srt/.ass/.vtt entry.
  const buf = Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf);
  // Find End of Central Directory record
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
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("latin1");
    // Advance to next CD entry
    off += 46 + nameLen + extraLen + commentLen;
    if (!SUB_EXTS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    // Read local file header to find data offset
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
      throw new Error(`ZIP: unsupported compression method ${compMethod}`);
    }
    fs.writeFileSync(destPath, fileData);
    return destPath;
  }
  throw new Error("ZIP: no subtitle file (.srt/.ass/.vtt) found inside");
}

async function downloadSubtitleFile(fileId, token, destPath, legacySubId) {
  // Primary: REST API /download endpoint (has daily quota for anon API key).
  try {
    const data = await osFetch("/download", {
      method: "POST",
      body: { file_id: fileId },
      token,
    });
    const link = data?.link;
    if (!link) throw new Error("download response missing link");
    const res = await fetch(link, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`subtitle file GET ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return destPath;
  } catch (e) {
    // Fallback: legacy direct download URL (dl.opensubtitles.org) which
    // returns a ZIP and has separate/looser limits. Used when the REST
    // API /download quota is exhausted (401 "missing token").
    if (!legacySubId || !/401|missing token|quota/i.test(e.message)) throw e;
    const legacyUrl = `https://dl.opensubtitles.org/en/download/sub/${legacySubId}`;
    const res = await fetch(legacyUrl, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`legacy download GET ${res.status}: ${e.message}`);
    const zipBuf = Buffer.from(await res.arrayBuffer());
    extractSubFromZip(zipBuf, destPath);
    return destPath;
  }
}

async function uploadToS3(s3Client, bucketName, filePath, s3Key, label, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      process.stdout.write(`    [${label}] ${prefix} ${sizeMB}MB... `);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucketName,
          Key: s3Key,
          Body: fs.createReadStream(filePath),
          ContentType: contentType,
        },
        queueSize: 4,
        partSize: 32 * 1024 * 1024,
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        let lastProgressAt = Date.now();
        upload.on("httpUploadProgress", () => {
          lastProgressAt = Date.now();
        });
        const stallCheck = setInterval(() => {
          if (!settled && Date.now() - lastProgressAt > UPLOAD_STALL_TIMEOUT_MS) {
            settled = true;
            clearInterval(stallCheck);
            upload.abort().catch(() => {});
            reject(new Error(`stalled - no upload progress for ${UPLOAD_STALL_TIMEOUT_MS / 60000}m`));
          }
        }, 15000);
        upload.done().then(
          (result) => {
            if (!settled) {
              settled = true;
              clearInterval(stallCheck);
              resolve(result);
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              clearInterval(stallCheck);
              reject(error);
            }
          },
        );
      });
      console.log("✓");
      return true;
    } catch (error) {
      console.log(`✗ (${error.message})`);
      if (attempt < UPLOAD_RETRIES) {
        await sleep(10_000 * attempt);
      }
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
  if (!API_KEY) {
    console.error(
      "OPENSUBTITLES_API_KEY is required.\n" +
        "Create a free consumer key at https://www.opensubtitles.com/en/consumers\n" +
        "then: export OPENSUBTITLES_API_KEY=...",
    );
    process.exit(1);
  }

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

  console.log("Logging into OpenSubtitles (optional)…");
  let token = null;
  try {
    token = await loginIfConfigured();
    console.log(token ? "  logged in (higher quota)" : "  anonymous (API key only)");
  } catch (e) {
    console.log(`  login failed (${e.message}) — continuing with API key only`);
  }

  const candidates = data.items.filter((item) => {
    if (ONLY_ID && item.id !== ONLY_ID) return false;
    if (!item.s3_key && !(item.s3_keys?.length > 0)) return false;
    if (!imdbNumeric(item.imdb_id)) return false;
    return true;
  });

  // Movies first (one episode = fewer quota hits), then single-file, then
  // multi-ep series. Within each band prefer titles still missing Portuguese.
  const rank = (item) => {
    const entry = backfill[item.id]?.subtitles || [];
    const have = existingLangsForEpisode(item, item.content_type === "movie" ? 0 : 0, entry);
    for (const t of item.subtitles || []) {
      if ((t.episode ?? 0) === 0 && t.lang) have.add(t.lang);
    }
    const missPor = WANT_LANGS.has("por") && !have.has("por") ? 0 : 1;
    const typeRank =
      item.content_type === "movie" ? 0 : (item.s3_keys?.length || 0) <= 1 ? 1 : 2;
    return typeRank * 10 + missPor;
  };
  candidates.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));

  console.log(
    `Scanning ${candidates.length} playable items with imdb_id` +
      (ONLY_ID ? ` (filter id=${ONLY_ID})` : "") +
      ` for missing langs: ${[...WANT_LANGS].join(",")}`,
  );

  let processed = 0;
  let uploaded = 0;
  let skipped = 0;
  let quotaExhausted = false;

  // Free OpenSubtitles accounts are ~20 downloads / 24h — stop immediately
  // on 406 quota so we don't thrash every remaining title with doomed POSTs.
  function isQuotaError(message) {
    return /allowed \d+ subtitles|quota will be renewed|download limit/i.test(message);
  }

  for (const item of candidates) {
    if (processed >= LIMIT || quotaExhausted) break;

    const imdb = imdbNumeric(item.imdb_id);
    const eps = episodesToCover(item);
    if (eps.length === 0) {
      skipped++;
      continue;
    }

    const entry = backfill[item.id] || { subtitles: [] };
    let itemDidWork = false;

    for (const { episode, season, ep } of eps) {
      if (processed >= LIMIT || quotaExhausted) break;
      const have = existingLangsForEpisode(item, episode, entry.subtitles);
      const missing = new Set([...WANT_LANGS].filter((l) => !have.has(l)));
      if (missing.size === 0) continue;

      const osLangs = [...missing].map((l) => LANG_TO_OS[l]).filter(Boolean);
      const label = ep != null ? `${item.title} S${season}E${ep}` : item.title;
      const videoKey = s3KeyForEpisode(item, episode);

      // Hash *our* S3 bytes so search can prefer subtitles for this rip.
      let moviehash = null;
      if (s3Client && bucketName && videoKey && !DRY_RUN) {
        try {
          const hashed = await movieHashFromS3(s3Client, bucketName, videoKey);
          moviehash = hashed.hash;
        } catch (e) {
          console.log(`  [${label}] moviehash failed (${e.message}) — IMDB-only search`);
        }
      } else if (DRY_RUN && videoKey) {
        moviehash = "(dry-run-no-hash)";
      }

      process.stdout.write(
        `  [${label}] search missing=${[...missing].join(",")}` +
          (moviehash && moviehash !== "(dry-run-no-hash)" ? ` hash=${moviehash}` : "") +
          `… `,
      );

      let results = [];
      try {
        results = await searchSubtitles({
          imdb,
          languages: osLangs,
          season,
          episode: ep,
          moviehash: moviehash && moviehash !== "(dry-run-no-hash)" ? moviehash : null,
        });
      } catch (e) {
        console.log(`search failed: ${e.message}`);
        continue;
      }

      let picks = pickBestPerLang(results, missing, { preferHashMatch: true });
      if (REQUIRE_HASH) {
        const before = picks.length;
        picks = picks.filter((p) => p.hashMatch);
        if (picks.length < before) {
          console.log(`(dropped ${before - picks.length} non-hash match(es) — --require-hash)`);
        }
      }
      // Prefer Portuguese first so a mid-item quota cut still leaves the
      // language this audience actually wants on by default.
      const langOrder = { por: 0, eng: 1, spa: 2 };
      picks.sort((a, b) => (langOrder[a.lang] ?? 9) - (langOrder[b.lang] ?? 9));
      if (picks.length === 0) {
        console.log(`no results (${results.length} rows)`);
        continue;
      }
      const hashHits = picks.filter((p) => p.hashMatch).length;
      console.log(
        `found ${picks.map((p) => p.lang + (p.hashMatch ? "*" : "")).join(",")}` +
          (hashHits ? ` (${hashHits} hash-match)` : " (IMDB popularity only — sync not guaranteed)"),
      );

      const usedIds = new Set([
        ...(item.subtitles || [])
          .filter((t) => (t.episode ?? 0) === episode)
          .map((t) => t.id),
        ...entry.subtitles.filter((t) => (t.episode ?? 0) === episode).map((t) => t.id),
      ]);

      const expectedDuration = runtimeSeconds(item);

      for (const pick of picks) {
        if (quotaExhausted) break;
        const trackId = uniqueTrackId(pick.lang, usedIds);
        usedIds.add(trackId);
        const rawPath = path.join(TMP_DIR, `${item.id}.${episode}.${trackId}.src`);
        const vttPath = path.join(TMP_DIR, `${item.id}.${episode}.${trackId}.vtt`);
        // Name mirrors pipeline convention so assets stay co-located and
        // human-greppable next to the mp4 key.
        const s3Key = `${S3_PREFIX(item.id)}external.${episode}.${trackId}.vtt`;

        if (DRY_RUN) {
          console.log(
            `    (dry run) would download file_id=${pick.fileId}` +
              (pick.hashMatch ? " [hash-match]" : " [imdb-only]") +
              ` → ${s3Key}`,
          );
          itemDidWork = true;
          continue;
        }

        try {
          await downloadSubtitleFile(pick.fileId, token, rawPath, pick.legacySubId);
          await convertSubtitleFileToVtt(rawPath, vttPath);

          // Soft check: last cue should be near catalog runtime (movies).
          // Series episodes often lack per-ep runtime — skip when unknown.
          if (CHECK_DURATION && expectedDuration && episode === 0) {
            const lastCue = vttLastCueSeconds(vttPath);
            if (lastCue != null) {
              const ratio = lastCue / expectedDuration;
              if (ratio < 0.75 || ratio > 1.15) {
                console.log(
                  `    ⚠ ${pick.lang} duration mismatch ` +
                    `(vtt~${Math.round(lastCue)}s vs runtime~${expectedDuration}s, ratio=${ratio.toFixed(2)}) — skip`,
                );
                continue;
              }
            }
          }

          const ok = await uploadToS3(
            s3Client,
            bucketName,
            vttPath,
            s3Key,
            `${label} [${trackId}]`,
            "text/vtt; charset=utf-8",
          );
          if (!ok) continue;
          entry.subtitles.push({
            episode,
            id: trackId,
            lang: pick.lang,
            label:
              (LANG_LABELS[pick.lang] || pick.lang.toUpperCase()) +
              (pick.hashMatch ? "" : ""),
            forced: false,
            s3_key: s3Key,
          });
          uploaded++;
          itemDidWork = true;
          await sleep(SLEEP_BETWEEN_DOWNLOADS_MS);
        } catch (e) {
          console.log(`    ⚠ ${pick.lang} failed: ${e.message}`);
          if (isQuotaError(e.message)) {
            quotaExhausted = true;
            console.log(
              "  ⛔ OpenSubtitles daily quota exhausted — stopping. Re-run after it renews.",
            );
          }
        } finally {
          fs.rmSync(rawPath, { force: true });
          fs.rmSync(vttPath, { force: true });
          fs.rmSync(`${vttPath}.part`, { force: true });
        }
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
      (quotaExhausted ? " quota_exhausted=true" : "") +
      (DRY_RUN ? " (dry-run)" : ` → ${OUTPUT_FILE}`),
  );
  console.log(
    "Restart the backend (or wait for next deploy) so apply_subtitle_backfill picks up new tracks.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
