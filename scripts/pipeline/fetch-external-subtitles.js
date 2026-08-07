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
 *   - Search OpenSubtitles by IMDB id (+ season/episode for TV)
 *   - Download one best file per missing language
 *   - Convert SRT/ASS → WebVTT via ffmpeg (same path as pipeline sidecars)
 *   - Upload under videos/<id>/….<lang>.vtt
 *   - Record into backend/data/subtitle_backfill.json (side file - same
 *     rationale as trailer_backfill.json: a live pipeline rewrites
 *     enriched_400.json continuously and would clobber direct edits)
 *
 * The backend merges that side file on boot (apply_subtitle_backfill).
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
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { convertSubtitleFileToVtt } from "./transcode.js";

const S3_PREFIX = (id) => `videos/${id}/`;
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/subtitle_backfill.json");
const TMP_DIR = path.join(os.tmpdir(), "tv-subtitle-backfill");
fs.mkdirSync(TMP_DIR, { recursive: true });

const DRY_RUN = process.argv.includes("--dry-run");
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

// Exactly one file per language: highest download_count, non-HI preferred.
// Sync quality is not measured (OpenSubtitles has no reliable auto-check
// without moviehash); popularity is the practical proxy.
function pickBestPerLang(results, missingLangs) {
  const candidates = [];
  for (const row of results || []) {
    const attrs = row.attributes || row;
    const langTag = (attrs.language || attrs.language_code || "").toLowerCase();
    const lang = OS_TO_LANG[langTag];
    if (!lang || !missingLangs.has(lang)) continue;
    const files = attrs.files || [];
    const fileId = files[0]?.file_id ?? attrs.file_id;
    if (!fileId) continue;
    candidates.push({
      lang,
      fileId,
      fileName: files[0]?.file_name || attrs.release || `${lang}.srt`,
      downloads: attrs.download_count || 0,
      hi: Boolean(attrs.hearing_impaired),
      // fps/from_trusted are soft signals when present
      fps: attrs.fps || 0,
      fromTrusted: Boolean(attrs.from_trusted || attrs.ai_translated === false),
    });
  }
  // Sort: non-HI first, then downloads desc, then trusted.
  candidates.sort((a, b) => {
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

async function searchSubtitles({ imdb, languages, season, episode }) {
  const params = new URLSearchParams();
  params.set("imdb_id", imdb);
  params.set("languages", languages.join(","));
  // Prefer moviehash-unrelated but well-downloaded releases; order is a
  // soft signal, we re-rank client-side anyway.
  params.set("order_by", "download_count");
  params.set("order_direction", "desc");
  if (season != null) params.set("season_number", String(season));
  if (episode != null) params.set("episode_number", String(episode));
  const data = await osFetch(`/subtitles?${params.toString()}`);
  return data?.data || [];
}

async function downloadSubtitleFile(fileId, token, destPath) {
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
      process.stdout.write(`  [${label}] search missing=${[...missing].join(",")}… `);

      let results;
      try {
        results = await searchSubtitles({
          imdb,
          languages: osLangs,
          season,
          episode: ep,
        });
      } catch (e) {
        console.log(`search failed: ${e.message}`);
        continue;
      }

      const picks = pickBestPerLang(results, missing);
      // Prefer Portuguese first so a mid-item quota cut still leaves the
      // language this audience actually wants on by default.
      const langOrder = { por: 0, eng: 1, spa: 2 };
      picks.sort((a, b) => (langOrder[a.lang] ?? 9) - (langOrder[b.lang] ?? 9));
      if (picks.length === 0) {
        console.log(`no results (${results.length} rows)`);
        continue;
      }
      console.log(`found ${picks.map((p) => p.lang).join(",")}`);

      const usedIds = new Set([
        ...(item.subtitles || [])
          .filter((t) => (t.episode ?? 0) === episode)
          .map((t) => t.id),
        ...entry.subtitles.filter((t) => (t.episode ?? 0) === episode).map((t) => t.id),
      ]);

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
          console.log(`    (dry run) would download file_id=${pick.fileId} → ${s3Key}`);
          itemDidWork = true;
          continue;
        }

        try {
          await downloadSubtitleFile(pick.fileId, token, rawPath);
          await convertSubtitleFileToVtt(rawPath, vttPath);
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
            label: LANG_LABELS[pick.lang] || pick.lang.toUpperCase(),
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
