#!/usr/bin/env node

/**
 * Transcodes and uploads already-downloaded Yale lecture videos
 * (yale_lectures/, populated by download_yale_lectures.sh) to the
 * convenient-pannikin Railway bucket. Each lecture's raw mp4, transcoded
 * mp4, and sidecar .vtt are deleted locally as soon as that lecture's
 * upload succeeds, so disk usage never holds more than one lecture's
 * working set at a time. Idempotent: HeadObject-checks the bucket first,
 * so re-running after an interruption just skips what's already up.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  S3Client,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { transcodeForBrowser } from "./transcode.js";

const [, , sourceDirArg, courseIdArg] = process.argv;
const SOURCE_DIR = path.join(process.cwd(), sourceDirArg || "yale_lectures");
const TMP_DIR = path.join(SOURCE_DIR, ".transcoded");
fs.mkdirSync(TMP_DIR, { recursive: true });

const COURSE_ID = courseIdArg || "milton-yale-lectures";
const UPLOAD_RETRIES = 5;

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
  // Default is 3 - too low for this connection's observed flakiness on
  // large sustained transfers. Each multipart part is a small, cheap,
  // independently-retryable chunk (see partSize below), so it's worth
  // letting the SDK exhaust many part-level retries on its own before
  // escalating to our own outer retry, which re-reads and re-sends the
  // *entire* file instead of just the one flaky part.
  maxAttempts: 8,
  // Without this, a stalled socket (connection open, zero bytes moving)
  // never throws - it just hangs forever, since Node's http client has no
  // default timeout. Confirmed happening: uploads sat with no error and no
  // log growth for 10+ minutes straight until an external watchdog noticed
  // and killed them. A real timeout turns that into a fast, retryable error
  // instead of a silent multi-minute hang every single attempt.
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 30000,
  }),
});
const BUCKET_NAME = bucketCreds.bucketName;

async function existsOnS3(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

const PART_SIZE = 8 * 1024 * 1024;
const PART_CONCURRENCY = 4;

// @aws-sdk/lib-storage's Upload needs its whole Body upfront to be
// retry-safe (a stream can't be rewound - see the git history on this
// function for the "not seekable" error that caused). Buffering the entire
// file solved that but meant each concurrent upload held its full size
// (700MB-1GB) resident in memory - with 2 lectures at once, that's ~2GB+ of
// Node heap, which lines up exactly with a run of "node process killed,
// nothing else touched" events that started right after that fix landed:
// classic signature of macOS's memory-pressure killer picking off whichever
// process is using the most RAM. Reading and uploading one bounded part at
// a time keeps memory at PART_CONCURRENCY x PART_SIZE (~32MB) regardless of
// file size, while each part (a fresh Buffer read fresh from disk) is still
// trivially retryable on its own.
async function multipartUpload(filePath, fileSize, s3Key, contentType) {
  const { UploadId } = await s3Client.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: s3Key, ContentType: contentType })
  );

  const fd = fs.openSync(filePath, "r");
  try {
    const partSpecs = [];
    for (let start = 0, partNumber = 1; start < fileSize; start += PART_SIZE, partNumber++) {
      partSpecs.push({ partNumber, start, size: Math.min(PART_SIZE, fileSize - start) });
    }

    const parts = new Array(partSpecs.length);
    let next = 0;
    async function worker() {
      while (next < partSpecs.length) {
        const { partNumber, start, size } = partSpecs[next++];
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, start);
        const result = await s3Client.send(
          new UploadPartCommand({ Bucket: BUCKET_NAME, Key: s3Key, UploadId, PartNumber: partNumber, Body: buf })
        );
        parts[partNumber - 1] = { ETag: result.ETag, PartNumber: partNumber };
      }
    }
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partSpecs.length) }, worker));

    await s3Client.send(
      new CompleteMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: s3Key, UploadId, MultipartUpload: { Parts: parts } })
    );
  } catch (error) {
    await s3Client
      .send(new AbortMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: s3Key, UploadId }))
      .catch(() => {});
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

async function uploadToS3(filePath, s3Key, label, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      console.log(`  [${label}] ${prefix} ${sizeMB}MB...`);
      await multipartUpload(filePath, fileSize, s3Key, contentType);
      console.log(`  [${label}] uploaded`);
      return true;
    } catch (error) {
      console.log(`  [${label}] upload failed: ${error.message}`);
      if (attempt < UPLOAD_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt * 1000));
      }
    }
  }
  return false;
}

// yt-dlp picks the merge container based on the source video/audio codecs -
// h264+aac progressive streams land directly as .mp4, but some lectures only
// have vp9/av1+opus available, which merges into .webm instead. transcodeForBrowser
// re-encodes non-h264 sources anyway, so any of these containers works as input.
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv"];

function findLectures() {
  return fs.readdirSync(SOURCE_DIR)
    .filter((f) => VIDEO_EXTENSIONS.includes(path.extname(f)))
    .sort()
    .map((videoFile) => {
      const base = path.basename(videoFile, path.extname(videoFile));
      const vtt = `${base}.en.vtt`;
      return {
        base,
        mp4Path: path.join(SOURCE_DIR, videoFile),
        vttPath: fs.existsSync(path.join(SOURCE_DIR, vtt)) ? path.join(SOURCE_DIR, vtt) : null,
      };
    });
}

async function processLecture({ base, mp4Path, vttPath }) {
  const videoKey = `videos/${COURSE_ID}/${base}.mp4`;
  const subKey = `videos/${COURSE_ID}/${base}.en.vtt`;

  if (await existsOnS3(videoKey)) {
    console.log(`[${base}] already on S3, skipping`);
    fs.rmSync(mp4Path, { force: true });
    if (vttPath) fs.rmSync(vttPath, { force: true });
    return;
  }

  const tmpPath = path.join(TMP_DIR, `${base}.mp4`);
  console.log(`[${base}] transcoding...`);
  await transcodeForBrowser(mp4Path, tmpPath, { maxHeight: 720 });
  console.log(`[${base}] transcode done`);

  const videoOk = await uploadToS3(tmpPath, videoKey, base, "video/mp4");
  if (!videoOk) {
    console.log(`[${base}] ✗ giving up after ${UPLOAD_RETRIES} attempts, leaving local files in place`);
    return;
  }

  if (vttPath) {
    await uploadToS3(vttPath, subKey, `${base} [en]`, "text/vtt; charset=utf-8");
  }

  fs.rmSync(mp4Path, { force: true });
  fs.rmSync(tmpPath, { force: true });
  if (vttPath) fs.rmSync(vttPath, { force: true });
  console.log(`[${base}] ✅ done\n`);
}

// Transcoding here is a fast copy-remux (source is already H.264) and
// upload is the network-bound step, so running a few lectures concurrently
// overlaps one lecture's upload with the next one's transcode instead of
// idling on the network between them. Kept low (not higher) because each
// lecture's Upload already runs its own multipart queueSize in parallel -
// 3 lectures x 4 parts each meant up to 12 simultaneous large HTTP streams
// to the bucket endpoint, which was saturating the connection and causing
// widespread EPIPE resets instead of the isolated one-off blips seen at
// lower concurrency.
const CONCURRENCY = 2;

async function runPool(items, worker, concurrency) {
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
}

async function main() {
  const lectures = findLectures();
  console.log(`Found ${lectures.length} lecture(s) ready to process.\n`);

  await runPool(lectures, processLecture, CONCURRENCY);

  console.log("🎉 All available lectures processed.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
