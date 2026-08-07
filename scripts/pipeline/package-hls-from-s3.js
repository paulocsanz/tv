#!/usr/bin/env node
/**
 * Download a catalog title from S3, package as HLS AES-128 VOD, upload under
 * videos/{id}/hls/, set hls_playlist_s3_key + encrypted=true on the catalog.
 *
 * Usage:
 *   set -a && source .env.caixote && set +a
 *   node scripts/pipeline/package-hls-from-s3.js --id the-matrix-1999-movie
 *   node scripts/pipeline/package-hls-from-s3.js --ids a,b,c
 *
 * Env: S3_* + ENCRYPTION_CATALOG_KEY (32-byte base64)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const require = createRequire(import.meta.url);
const { parseCatalogKey, decryptBuffer, isEncryptedBuffer } = require("../../lib/media-encryption.cjs");
const { packageHlsAes128 } = require("../../lib/hls-package.cjs");

const CATALOG_PATH =
  process.env.ENRICHED_DATA_PATH ||
  path.join("backend", "data", "enriched_400.json");

function parseArgs(argv) {
  const out = {
    ids: [],
    keepLocal: false,
    all: false,
    /** only single-file titles (default for --all) */
    singleOnly: true,
    limit: null,
    skipExisting: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.ids.push(argv[++i]);
    else if (a === "--ids")
      out.ids.push(
        ...String(argv[++i])
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (a === "--all") out.all = true;
    else if (a === "--include-series") out.singleOnly = false;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--force") out.skipExisting = false;
    else if (a === "--keep-local") out.keepLocal = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

/** Titles that still need HLS packaging. */
function pickPendingIds(catalog, { singleOnly, skipExisting, limit }) {
  const ids = [];
  for (const x of catalog.items) {
    if (!x || !x.s3_key) continue;
    if (skipExisting && x.hls_playlist_s3_key) continue;
    const multi = x.s3_keys && x.s3_keys.length > 1;
    if (singleOnly && multi) continue;
    ids.push(x.id);
    if (limit && ids.length >= limit) break;
  }
  return ids;
}

function loadBucketCreds() {
  const c = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (!c.accessKeyId || !c.secretAccessKey || !c.bucketName || !c.endpoint) {
    throw new Error("Missing S3_* env — source .env.caixote first");
  }
  return c;
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
}

function makeS3(creds) {
  return new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: creds.urlStyle === "path",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 30_000,
      requestTimeout: 600_000,
    }),
  });
}

async function downloadToFile(client, bucket, key, dest) {
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const total = head.ContentLength ?? 0;
  console.log(`  ↓ ${key} (${(total / 1e6).toFixed(1)} MB)`);
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  await pipeline(res.Body, createWriteStream(dest));
}

async function uploadFile(client, bucket, key, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return body.length;
}

/** Upload many objects with bounded concurrency. */
async function uploadMany(client, bucket, jobs, concurrency = 12) {
  let done = 0;
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      const job = jobs[idx];
      await uploadFile(client, bucket, job.key, job.filePath, job.contentType);
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        console.log(`  ↑ ${done}/${jobs.length}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );
}

async function packageOne(client, creds, catalog, catalogKey, id, opts) {
  const item = catalog.items.find((x) => x && x.id === id);
  if (!item) throw new Error(`catalog id not found: ${id}`);
  const srcKey = item.s3_key || (item.s3_keys && item.s3_keys[0]);
  if (!srcKey) throw new Error(`${id}: no s3_key`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-"));
  const localIn = path.join(workDir, "source.mp4");
  const hlsDir = path.join(workDir, "hls");

  console.log(`\n▶ HLS-AES package ${item.title || id} (${id})`);
  try {
    // If already SSESENC1, we need plaintext — for P0 assume source is
    // progressive MP4 or use the original progressive object. For already-
    // encrypted progressive SSESENC1 titles, download is ciphertext; detect
    // magic and refuse with a clear error (re-package from plaintext backup
    // or decrypt offline first — P1).
    await downloadToFile(client, creds.bucketName, srcKey, localIn);
    let mediaPath = localIn;
    const raw = fs.readFileSync(localIn);
    if (isEncryptedBuffer(raw)) {
      console.log("  🔓 SSESENC1 → plaintext for packaging…");
      const plain = decryptBuffer(raw, catalogKey);
      mediaPath = path.join(workDir, "plain.mp4");
      fs.writeFileSync(mediaPath, plain);
      // free memory ASAP
      raw.fill(0);
    }

    console.log("  ⚙ ffmpeg HLS AES-128…");
    const { playlistPath, segmentFiles } = packageHlsAes128({
      inputPath: mediaPath,
      outDir: hlsDir,
      catalogKey32: catalogKey,
      segmentSeconds: 4,
    });
    console.log(`  ✓ ${segmentFiles.length} segments`);

    const prefix = `videos/${id}/hls`;
    const playlistKey = `${prefix}/index.m3u8`;
    const jobs = segmentFiles.map((seg) => ({
      key: `${prefix}/${path.basename(seg)}`,
      filePath: seg,
      contentType: "video/mp2t",
    }));
    console.log(`  ↑ uploading ${jobs.length} segments (parallel)…`);
    await uploadMany(client, creds.bucketName, jobs, 16);
    await uploadFile(
      client,
      creds.bucketName,
      playlistKey,
      playlistPath,
      "application/vnd.apple.mpegurl",
    );
    console.log(`  ↑ ${playlistKey}`);

    // Re-read catalog before save so a concurrent reencrypt worker doesn't
    // wipe our field with a stale in-memory copy.
    const fresh = loadCatalog();
    const freshItem = fresh.items.find((x) => x && x.id === id);
    if (!freshItem) throw new Error(`catalog id vanished before save: ${id}`);
    freshItem.hls_playlist_s3_key = playlistKey;
    freshItem.encrypted = true;
    saveCatalog(fresh);
    // keep caller's catalog in sync
    item.hls_playlist_s3_key = playlistKey;
    item.encrypted = true;
    console.log(`\n✓ catalog: ${id} hls_playlist_s3_key=${playlistKey}`);
    return { id, playlistKey, segments: segmentFiles.length };
  } finally {
    if (!opts.keepLocal) {
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`  kept ${workDir}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.all && opts.ids.length === 0)) {
    console.log(`Usage:
  node scripts/pipeline/package-hls-from-s3.js --id <catalog-id>
  node scripts/pipeline/package-hls-from-s3.js --ids id1,id2
  node scripts/pipeline/package-hls-from-s3.js --all [--limit N] [--include-series] [--force]
Env: S3_* ENCRYPTION_CATALOG_KEY`);
    process.exit(opts.help ? 0 : 1);
  }

  const catalogKey = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
  if (!catalogKey) throw new Error("ENCRYPTION_CATALOG_KEY missing/invalid");
  const creds = loadBucketCreds();
  const client = makeS3(creds);
  let catalog = loadCatalog();

  if (opts.all) {
    opts.ids = pickPendingIds(catalog, opts);
    console.log(
      `── --all: ${opts.ids.length} title(s) pending HLS` +
        (opts.limit ? ` (limit ${opts.limit})` : ""),
    );
  }

  const results = [];
  for (const id of opts.ids) {
    catalog = loadCatalog(); // refresh between titles
    try {
      if (opts.skipExisting) {
        const cur = catalog.items.find((x) => x && x.id === id);
        if (cur?.hls_playlist_s3_key) {
          console.log(`skip ${id} (already has HLS)`);
          results.push({ id, skipped: true });
          continue;
        }
      }
      results.push(await packageOne(client, creds, catalog, catalogKey, id, opts));
    } catch (e) {
      console.error(`FAIL ${id}:`, e.message || e);
      results.push({ id, error: String(e.message || e) });
    }
  }
  console.log("\n── summary ──");
  let ok = 0,
    fail = 0,
    skip = 0;
  for (const r of results) {
    if (r.error) {
      fail++;
      console.log(`  fail ${r.id}: ${r.error}`);
    } else if (r.skipped) {
      skip++;
    } else {
      ok++;
      console.log(`  ok   ${r.id} → ${r.playlistKey} (${r.segments} segs)`);
    }
  }
  console.log(`  totals: ok=${ok} fail=${fail} skip=${skip}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
