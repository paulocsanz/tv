#!/usr/bin/env node
/**
 * Download a catalog title from S3, remux to fMP4, optionally gzip, encrypt
 * SSESENC1, put the ciphertext back on the same key, mark catalog encrypted.
 *
 * Usage:
 *   set -a && source .env.caixote && set +a
 *   export ENCRYPTION_CATALOG_KEY='…'   # 32-byte base64
 *   node scripts/pipeline/reencrypt-from-s3.js --id city-lights-1931-movie
 *   node scripts/pipeline/reencrypt-from-s3.js --id city-lights-1931-movie --no-compress
 *   node scripts/pipeline/reencrypt-from-s3.js --id city-lights-1931-movie --no-fmp4
 *   node scripts/pipeline/reencrypt-from-s3.js --s3-key videos/…/file.mp4 --catalog-id city-lights-1931-movie
 *
 * Env (same as the pipeline):
 *   S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET_NAME S3_ENDPOINT
 *   S3_REGION S3_URL_STYLE ENCRYPTION_CATALOG_KEY
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const require = createRequire(import.meta.url);
const {
  parseCatalogKey,
  encryptFile,
  COMPRESSION_GZIP,
  mseCodecsFromFfprobe,
} = require("../../lib/media-encryption.cjs");

const CATALOG_PATH =
  process.env.ENRICHED_DATA_PATH ||
  path.join("backend", "data", "enriched_400.json");

function parseArgs(argv) {
  const out = {
    id: null,
    ids: [],
    s3Key: null,
    catalogId: null,
    compress: true,
    fmp4: true,
    keepLocal: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.ids.push(argv[++i]);
    else if (a === "--ids") {
      // Comma-separated batch: --ids a,b,c
      out.ids.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (a === "--s3-key") out.s3Key = argv[++i];
    else if (a === "--catalog-id") out.catalogId = argv[++i];
    else if (a === "--no-compress") out.compress = false;
    else if (a === "--no-fmp4") out.fmp4 = false;
    else if (a === "--keep-local") out.keepLocal = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  // Back-compat: first --id also sets .id
  if (out.ids.length === 1) out.id = out.ids[0];
  else if (out.ids.length > 1) out.id = null;
  if (out.catalogId && !out.ids.includes(out.catalogId)) out.ids.push(out.catalogId);
  return out;
}

function loadBucketCreds() {
  const fromEnv = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (
    fromEnv.accessKeyId &&
    fromEnv.secretAccessKey &&
    fromEnv.bucketName &&
    fromEnv.endpoint
  ) {
    return fromEnv;
  }
  throw new Error(
    "Missing S3_* env. `set -a && source .env.caixote && set +a` then retry.",
  );
}

function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  if (!raw.items || !Array.isArray(raw.items)) {
    throw new Error(`${CATALOG_PATH}: expected { items: [...] }`);
  }
  return raw;
}

function findItem(catalog, id) {
  const item = catalog.items.find((x) => x && x.id === id);
  if (!item) throw new Error(`catalog item not found: ${id}`);
  return item;
}

function resolveKeys(item, explicitKey) {
  if (explicitKey) return [explicitKey];
  // Movies sometimes have bloated duplicate rips in s3_keys (e.g. Rear Window
  // 33MB primary + 1.1GB secondary). Only encrypt the primary playback key.
  // TV/courses need every episode key.
  const isMovie = item.content_type === "movie" || !item.content_type;
  if (isMovie && item.s3_key) return [item.s3_key];
  if (item.s3_keys && item.s3_keys.length) return [...item.s3_keys];
  if (item.s3_key) return [item.s3_key];
  throw new Error(`item ${item.id} has no s3_key/s3_keys`);
}

async function streamToFile(body, destPath, onProgress) {
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let loaded = 0;
    body.on("data", (chunk) => {
      loaded += chunk.length;
      onProgress?.(loaded);
    });
    body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    body.pipe(ws);
  });
}

async function downloadObject(s3, bucket, key, destPath) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const total = head.ContentLength || 0;
  console.log(`  ↓ ${key} (${(total / 1e6).toFixed(1)} MB)`);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  let lastPct = -1;
  await streamToFile(res.Body, destPath, (loaded) => {
    if (!total) return;
    const pct = Math.floor((loaded / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stdout.write(`\r  ↓ ${pct}%`);
    }
  });
  if (total) process.stdout.write("\r  ↓ 100%\n");
  return total;
}

const PART_SIZE = 8 * 1024 * 1024;
const PART_CONCURRENCY = 4;

async function uploadFile(s3, bucket, key, filePath, contentType) {
  const size = fs.statSync(filePath).size;
  console.log(`  ↑ ${key} (${(size / 1e6).toFixed(1)} MB) as ${contentType}`);
  if (size <= PART_SIZE) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType,
      }),
    );
    return;
  }
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    }),
  );
  const partSpecs = [];
  for (let start = 0, partNumber = 1; start < size; start += PART_SIZE, partNumber++) {
    const len = Math.min(PART_SIZE, size - start);
    partSpecs.push({ partNumber, start, len });
  }
  const completed = new Map();
  let uploadedBytes = 0;
  let lastPct = -1;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      let cursor = 0;
      async function uploadOne(spec) {
        const buf = Buffer.alloc(spec.len);
        fs.readSync(fd, buf, 0, spec.len, spec.start);
        const result = await s3.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId,
            PartNumber: spec.partNumber,
            Body: buf,
          }),
        );
        completed.set(spec.partNumber, result.ETag);
        uploadedBytes += spec.len;
        const pct = Math.floor((uploadedBytes / size) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  ↑ ${pct}%`);
        }
      }
      // Simple pool of PART_CONCURRENCY workers.
      const workers = Array.from({ length: PART_CONCURRENCY }, async () => {
        while (cursor < partSpecs.length) {
          const i = cursor++;
          await uploadOne(partSpecs[i]);
        }
      });
      await Promise.all(workers);
    } finally {
      fs.closeSync(fd);
    }
    process.stdout.write("\r  ↑ 100%\n");
    const parts = [...completed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (e) {
    await s3
      .send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
        }),
      )
      .catch(() => undefined);
    throw e;
  }
}

function remuxToFmp4(inPath, outPath) {
  console.log("  ⚙ remux → fMP4 (copy, no re-encode)…");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inPath,
      "-c",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      outPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function probeCodecs(filePath) {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,profile,level,codec_tag_string",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  return mseCodecsFromFfprobe(parsed.streams || []);
}

async function processOneKey(s3, bucket, key, workDir, opts, catalogKey) {
  const base = path.basename(key).replace(/[^\w.\-]+/g, "_") || "media.mp4";
  const plainPath = path.join(workDir, `plain-${base}`);
  const fmp4Path = path.join(workDir, `fmp4-${base}`);
  const encPath = path.join(workDir, `enc-${base}.ssesenc1`);

  // Cheap HEAD-range: download first 8 bytes via full download then check —
  // for already-encrypted objects, still download once; skip re-encrypt after.
  await downloadObject(s3, bucket, key, plainPath);

  // Already SSESENC1? Treat as success (idempotent re-run after partial batch).
  const headBuf = Buffer.alloc(8);
  const fd = fs.openSync(plainPath, "r");
  fs.readSync(fd, headBuf, 0, 8, 0);
  fs.closeSync(fd);
  if (headBuf.toString("ascii") === "SSESENC1") {
    console.log(`  ⏭  already SSESENC1 — skip re-encrypt`);
    let codecs = "";
    try {
      // Can't probe ciphertext; leave codecs to catalog if already set.
    } catch {
      /* ignore */
    }
    return { codecs, result: { skipped: true }, alreadyEncrypted: true };
  }

  let mediaPath = plainPath;
  let codecs = "";
  if (opts.fmp4) {
    remuxToFmp4(plainPath, fmp4Path);
    mediaPath = fmp4Path;
    try {
      codecs = probeCodecs(fmp4Path);
      console.log(`  🎞 codecs: ${codecs || "(unknown)"}`);
    } catch (e) {
      console.warn(`  ⚠ ffprobe failed: ${e.message}`);
    }
  } else {
    try {
      codecs = probeCodecs(plainPath);
      console.log(`  🎞 codecs: ${codecs || "(unknown)"}`);
    } catch {
      /* progressive fallback */
    }
  }

  console.log(
    `  🔒 encrypt SSESENC1${opts.compress ? " (try gzip)" : ""}…`,
  );
  const result = await encryptFile(mediaPath, encPath, catalogKey, {
    compress: opts.compress,
  });
  const compressionNote =
    result.compression === COMPRESSION_GZIP ? "gzip" : "none";
  console.log(
    `  ✓ encrypted ${(result.outBytes / 1e6).toFixed(1)} MB` +
      ` (payload ${compressionNote}, ratio ${(result.ratio * 100).toFixed(1)}%)`,
  );

  await uploadFile(s3, bucket, key, encPath, "application/octet-stream");

  return { codecs, result };
}

async function processItem(s3, bucket, catalog, itemId, opts, catalogKey) {
  const item = findItem(catalog, itemId);
  if (item.encrypted) {
    console.log(`\n⏭  ${item.id} already encrypted — skip`);
    return { skipped: true };
  }
  const keys = resolveKeys(item, opts.s3Key);
  console.log(
    `\n▶ Re-encrypt ${item.title} (${item.id}) — ${keys.length} object(s)`,
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssesenc-"));
  console.log(`  workdir ${workDir}`);

  let lastCodecs = "";
  try {
    for (const key of keys) {
      console.log(`\n=== ${key} ===`);
      const { codecs } = await processOneKey(
        s3,
        bucket,
        key,
        workDir,
        opts,
        catalogKey,
      );
      if (codecs) lastCodecs = codecs;
    }
    item.encrypted = true;
    if (lastCodecs) item.media_codecs = lastCodecs;
    // Persist after each title so a crash mid-batch keeps progress.
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
    console.log(
      `\n✓ catalog updated: ${item.id} encrypted=true` +
        (lastCodecs ? ` media_codecs=${lastCodecs}` : ""),
    );
    return { skipped: false, id: item.id };
  } finally {
    if (!opts.keepLocal) {
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`  kept local workdir: ${workDir}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage:
  node scripts/pipeline/reencrypt-from-s3.js --id <catalog-id> [--no-compress] [--no-fmp4]
  node scripts/pipeline/reencrypt-from-s3.js --ids id1,id2,id3
  node scripts/pipeline/reencrypt-from-s3.js --id a --id b --id c`);
    process.exit(0);
  }

  const catalogKey = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
  if (!catalogKey) {
    throw new Error(
      "ENCRYPTION_CATALOG_KEY required (32-byte base64). Generate with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  const creds = loadBucketCreds();
  const s3 = new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    forcePathStyle: creds.urlStyle !== "virtual-host",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    requestHandler: new NodeHttpHandler({
      requestTimeout: 15 * 60 * 1000,
      throwOnRequestTimeout: true,
    }),
  });

  const catalog = loadCatalog();
  let idList = [...opts.ids];
  if (opts.s3Key && !idList.length && opts.catalogId) {
    idList = [opts.catalogId];
  }
  if (!idList.length && !opts.s3Key) {
    throw new Error("pass --id <catalog-id> (or --ids a,b,c)");
  }
  if (opts.limit && opts.limit > 0) {
    idList = idList.slice(0, opts.limit);
  }

  const results = { ok: [], skipped: [], failed: [] };
  for (const id of idList) {
    try {
      const r = await processItem(s3, creds.bucketName, catalog, id, opts, catalogKey);
      if (r.skipped) results.skipped.push(id);
      else results.ok.push(id);
    } catch (e) {
      console.error(`\n✗ ${id}: ${e.message || e}`);
      results.failed.push(id);
    }
  }

  console.log("\n── batch summary ──");
  console.log(`  ok:      ${results.ok.length} ${results.ok.join(", ")}`);
  console.log(`  skipped: ${results.skipped.length}`);
  console.log(`  failed:  ${results.failed.length} ${results.failed.join(", ")}`);
  if (results.failed.length) process.exit(1);
}

main().catch((e) => {
  console.error("\n✗", e.message || e);
  process.exit(1);
});
