#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");

// Railway S3 configuration
const s3Client = new S3Client({
  region: "iad",
  credentials: fromNodeProviderChain(),
  endpoint: process.env.RAILWAY_BUCKET_ENDPOINT || "https://s3.railway.app",
});

const BUCKET_NAME = "convenient-pannikin";

async function loadEnrichedData() {
  const raw = fs.readFileSync(ENRICHED_FILE, "utf-8");
  return JSON.parse(raw);
}

async function saveEnrichedData(data) {
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
}

function downloadTorrent(torrentPath) {
  return new Promise((resolve, reject) => {
    const torrentFilename = path.basename(torrentPath);
    console.log(`Downloading: ${torrentFilename}`);

    const aria2 = spawn("aria2c", [
      "--max-connection-per-server=16",
      "--split=16",
      "--lowest-speed-limit=1K",
      "--bt-enable-lpd=true",
      "--enable-dht=true",
      "--dht-listen-port=6881-6999",
      "--continue=true",
      "--allow-overwrite=true",
      torrentFilename,  // Just filename, aria2c will find it in cwd
    ], {
      cwd: DOWNLOADS_DIR,
    });

    let output = "";
    aria2.stdout.on("data", (data) => {
      output += data.toString();
      process.stdout.write(".");
    });

    aria2.stderr.on("data", (data) => {
      output += data.toString();
      process.stdout.write(".");
    });

    aria2.on("close", (code) => {
      if (code === 0) {
        console.log(" ✓");
        resolve();
      } else {
        console.log(` ✗ (exit ${code})`);
        console.log("Output:", output.slice(-200));
        reject(new Error(`Download failed with code ${code}`));
      }
    });

    aria2.on("error", (err) => {
      console.log(` ✗ (${err.message})`);
      reject(err);
    });
  });
}

async function uploadToRailway(filePath, s3Key) {
  try {
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;

    console.log(`  Uploading to S3: ${s3Key} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileStream,
      ContentType: "video/mp4",
    });

    await s3Client.send(command);
    console.log(`  ✓ Uploaded: ${s3Key}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Upload failed: ${error.message}`);
    return false;
  }
}

function getVideoFile(baseDir) {
  // Find the first video file in the directory
  const files = fs.readdirSync(baseDir);
  const videoExts = [".mp4", ".mkv", ".avi", ".mov", ".webm"];
  return files.find((f) => videoExts.some((ext) => f.toLowerCase().endsWith(ext)));
}

async function processAllTorrents() {
  console.log("Loading enriched data...");
  const enrichedData = await loadEnrichedData();

  const itemsWithTorrents = enrichedData.items.filter((item) => item.torrent_file);
  console.log(
    `Found ${itemsWithTorrents.length} items with torrents to download`
  );

  let processed = 0;
  let uploaded = 0;

  for (const item of itemsWithTorrents) {
    console.log(`\n[${++processed}/${itemsWithTorrents.length}] ${item.title}`);

    const torrentPath = path.join(DOWNLOADS_DIR, `${item.torrent_file}.torrent`);

    if (!fs.existsSync(torrentPath)) {
      console.log("  ⚠ Torrent file not found, skipping");
      continue;
    }

    try {
      // Download the torrent
      await downloadTorrent(torrentPath);

      // Find downloaded video file
      const videoFile = getVideoFile(DOWNLOADS_DIR);
      if (!videoFile) {
        console.log("  ⚠ No video file found after download");
        continue;
      }

      const videoPath = path.join(DOWNLOADS_DIR, videoFile);
      const s3Key = `videos/${item.id}/${videoFile}`;

      // Upload to Railway S3
      const uploadSuccess = await uploadToRailway(videoPath, s3Key);

      if (uploadSuccess) {
        // Update enriched data with S3 URL
        const s3Url = `https://${BUCKET_NAME}.s3.railway.app/${s3Key}`;
        item.s3_url = s3Url;
        item.torrent_file = null; // Remove torrent reference

        // Delete local file to save space
        fs.unlinkSync(videoPath);
        console.log(`  🗑 Deleted local file`);
        uploaded++;
      }
    } catch (error) {
      console.error(`  Error: ${error.message}`);
    }
  }

  // Save updated enriched data
  console.log("\nSaving updated metadata...");
  await saveEnrichedData(enrichedData);

  console.log(
    `\n✅ Complete! Uploaded ${uploaded}/${itemsWithTorrents.length} items`
  );
}

// Check for required tools
function checkDependencies() {
  try {
    execSync("aria2c --version", { stdio: "ignore" });
  } catch {
    console.error(
      "aria2c not found. Install with: brew install aria2 (macOS) or apt-get install aria2 (Linux)"
    );
    process.exit(1);
  }
}

checkDependencies();
processAllTorrents().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
