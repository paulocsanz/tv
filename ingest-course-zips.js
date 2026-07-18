#!/usr/bin/env node

/**
 * One-off ingestion for locally-downloaded course zips (Google Drive
 * exports, not torrents): transcodes each lesson to a browser-playable
 * 720p MP4 and uploads it - plus attachments as-is - to the exact s3_keys
 * already recorded on the course's catalog entry in enriched_400.json (see
 * scratchpad/build_course_entries.py). Raw files must already be extracted
 * into downloads/<course-id>/raw/ (see scratchpad/extract_course_zips.py -
 * plain `unzip` can't handle these zips' UTF-8 filenames).
 *
 * Idempotent: HeadObject-checks the bucket before doing any work, so a
 * restart after an interruption just skips whatever's already uploaded.
 *
 * Transcode and upload run as two independent worker pools connected by a
 * queue (not one combined per-item pipeline) - upload to this bucket is the
 * real bottleneck (a single connection tops out around ~150-300KB/s, see
 * download-picked-torrents.js), so keeping several files uploading at once
 * while others are still transcoding matters far more than transcode
 * concurrency alone. Both pool sizes match that script's own tested caps for
 * this exact machine/bucket instead of guessing new ones.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { transcodeForBrowser, extractSubtitles } from "./transcode.js";

const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
// NOT downloads/.transcoded - that directory is also used by
// download-picked-torrents.js, which sweeps it on every startup and deletes
// any file whose id prefix isn't one of *its own* in-flight torrent items
// (confirmed live: it silently deleted an already-transcoded, mid-retry
// "7.1 - Entrevista..." course file out from under this script when it
// restarted). A dedicated directory means that pipeline has no idea this
// one exists and can never sweep it.
const TRANSCODE_TMP_DIR = path.join(DOWNLOADS_DIR, ".course-transcoded");
fs.mkdirSync(TRANSCODE_TMP_DIR, { recursive: true });

const COURSE_IDS = ["historia-da-arte-2026-course", "cultivo-de-maconha-2026-course"];
const TRANSCODE_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 4;

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

function loadEnrichedData() {
  return JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
}

function saveEnrichedData(data) {
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2) + "\n");
}

async function existsOnS3(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

const UPLOAD_RETRIES = 3;

async function uploadToS3(filePath, s3Key, label, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      console.log(`  [${label}] ${prefix} ${sizeMB}MB...`);
      const upload = new Upload({
        client: s3Client,
        params: { Bucket: BUCKET_NAME, Key: s3Key, Body: fs.createReadStream(filePath), ContentType: contentType },
        queueSize: 4,
        partSize: 32 * 1024 * 1024,
      });
      await upload.done();
      console.log(`  [${label}] uploaded`);
      return true;
    } catch (error) {
      console.log(`  [${label}] upload failed: ${error.message}`);
      if (attempt < UPLOAD_RETRIES) {
        const delaySeconds = 10 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  }
  return false;
}

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Producer/consumer queue, same shape as download-picked-torrents.js's
// createChannel - safe for multiple concurrent consumers since push/next
// never await between checking and mutating state.
function createChannel() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (waiters.length) waiters.shift()({ value: item, done: false });
      else items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    async next() {
      if (items.length) return { value: items.shift(), done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve) => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return { next: () => this.next() };
    },
  };
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const item = items[next++];
      // One item's failure (bad ffmpeg exit, transient VideoToolbox
      // contention, etc.) must not take down every other in-flight
      // transcode - confirmed live: an uncaught rejection here previously
      // crashed the whole process mid-run via main()'s top-level catch,
      // losing progress on every lesson concurrently being transcoded
      // alongside the one that actually failed.
      try {
        await worker(item);
      } catch (error) {
        console.log(`  ✗ ${JSON.stringify(item.s3Key ?? item)}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
}

async function main() {
  const data = loadEnrichedData();
  const uploadChannel = createChannel();

  // Attachments need no transcode - fed straight to the upload channel so
  // they don't wait behind the (much slower) video transcode pool at all.
  const attachmentWork = [];
  const lessonWork = [];
  for (const courseId of COURSE_IDS) {
    const item = data.items.find((i) => i.id === courseId);
    if (!item) {
      console.log(`⚠ ${courseId} not found in enriched_400.json, skipping`);
      continue;
    }
    console.log(`${item.title}: ${item.s3_keys.length} lessons, ${item.attachments.length} attachments`);
    for (const s3Key of item.s3_keys) lessonWork.push({ courseId, s3Key, item });
    for (const attachment of item.attachments) attachmentWork.push({ courseId, attachment });
  }

  for (const { courseId, attachment } of attachmentWork) {
    const label = `${courseId} - ${attachment.filename}`;
    const rawPath = path.join(DOWNLOADS_DIR, courseId, "raw", attachment.filename);
    uploadChannel.push({
      label,
      rawPath,
      s3Key: attachment.s3_key,
      contentType: CONTENT_TYPES[path.extname(attachment.filename).toLowerCase()] || "application/octet-stream",
      afterUpload: () => {},
    });
  }

  async function transcodeWorker(work) {
    const { courseId, s3Key, item } = work;
    const filename = path.basename(s3Key);
    const label = `${courseId} - ${filename}`;

    if (await existsOnS3(s3Key)) {
      console.log(`  [${label}] already on S3, skipping`);
      return;
    }

    const rawPath = path.join(DOWNLOADS_DIR, courseId, "raw", filename);
    if (!fs.existsSync(rawPath)) {
      console.log(`  [${label}] ⚠ raw file not found at ${rawPath}, skipping`);
      return;
    }

    const tmpPath = path.join(TRANSCODE_TMP_DIR, `${courseId}__${filename}`);
    if (fs.existsSync(tmpPath)) {
      console.log(`  [${label}] reusing already-transcoded file`);
    } else {
      // Retried, not just try/caught: a hardware VideoToolbox encode session
      // can transiently fail to open under contention from other concurrent
      // ffmpeg processes (confirmed live: "2.6 Cultivo Mineral..." failed
      // once mid-run with several other transcodes competing, then
      // succeeded cleanly re-run alone) - worth a couple retries before
      // giving up on a file that's otherwise perfectly readable.
      const TRANSCODE_RETRIES = 3;
      let lastError;
      for (let attempt = 1; attempt <= TRANSCODE_RETRIES; attempt++) {
        try {
          if (attempt === 1) console.log(`  [${label}] transcoding...`);
          else console.log(`  [${label}] transcoding (retry ${attempt - 1}/${TRANSCODE_RETRIES - 1})...`);
          await transcodeForBrowser(rawPath, tmpPath, { maxHeight: 720 });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          console.log(`  [${label}] transcode failed: ${error.message}`);
          if (attempt < TRANSCODE_RETRIES) await new Promise((resolve) => setTimeout(resolve, 10000 * attempt));
        }
      }
      if (lastError) throw lastError;
      console.log(`  [${label}] transcode done`);
    }

    let subtitleTracks = [];
    try {
      const base = path.basename(filename, ".mp4");
      const extracted = await extractSubtitles(rawPath, TRANSCODE_TMP_DIR, `${courseId}__${base}`);
      for (const sub of extracted) {
        const subKey = `videos/${courseId}/${base}.${sub.id}.vtt`;
        const subOk = await uploadToS3(sub.filePath, subKey, `${label} [${sub.id}]`, "text/vtt; charset=utf-8");
        fs.rmSync(sub.filePath, { force: true });
        if (subOk) subtitleTracks.push({ id: sub.id, lang: sub.lang, label: sub.label, forced: sub.forced, s3_key: subKey });
      }
    } catch (error) {
      console.log(`  [${label}] subtitle extraction failed: ${error.message}`);
    }

    uploadChannel.push({
      label,
      rawPath: tmpPath,
      s3Key,
      contentType: "video/mp4",
      afterUpload: () => {
        fs.unlinkSync(rawPath);
        if (subtitleTracks.length > 0) {
          const episode = item.s3_keys.indexOf(s3Key) + 1;
          item.subtitles = item.subtitles || [];
          for (const sub of subtitleTracks) item.subtitles.push({ episode, ...sub });
        }
        // Saved after every lesson (not just at the end) so a crash mid-run
        // doesn't lose subtitle sidecar bookkeeping for lessons already
        // uploaded - the video itself is separately safe via the HeadObject
        // skip above.
        saveEnrichedData(data);
      },
    });
  }

  async function uploadWorker() {
    for await (const work of uploadChannel) {
      if (await existsOnS3(work.s3Key)) {
        console.log(`  [${work.label}] already on S3, skipping`);
        fs.rmSync(work.rawPath, { force: true });
        continue;
      }
      if (!fs.existsSync(work.rawPath)) {
        console.log(`  [${work.label}] ⚠ file not found at ${work.rawPath}, skipping`);
        continue;
      }
      const ok = await uploadToS3(work.rawPath, work.s3Key, work.label, work.contentType);
      if (ok) {
        // work.rawPath is always safe to delete once its upload succeeds:
        // for a video it's the transcoded .transcoded/ temp copy, for an
        // attachment it's the extracted raw/ file itself. afterUpload
        // handles anything beyond that (the video's *original* raw source,
        // subtitle bookkeeping) - it used to be the only cleanup that ran,
        // which silently left every uploaded transcode sitting in
        // .transcoded/ forever (confirmed: 27GB of already-uploaded
        // História da Arte output never got deleted).
        fs.rmSync(work.rawPath, { force: true });
        work.afterUpload();
      }
    }
  }

  await Promise.all([
    runPool(lessonWork, transcodeWorker, TRANSCODE_CONCURRENCY).then(() => uploadChannel.close()),
    ...Array.from({ length: UPLOAD_CONCURRENCY }, () => uploadWorker()),
  ]);

  for (const courseId of COURSE_IDS) {
    const rawDir = path.join(DOWNLOADS_DIR, courseId, "raw");
    if (fs.existsSync(rawDir) && fs.readdirSync(rawDir).length === 0) {
      fs.rmSync(rawDir, { recursive: true, force: true });
    }
  }

  console.log("\n✅ All courses processed.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
