#!/usr/bin/env node

/**
 * Download specific TV shows: Weeds, The Blacklist, Scandal, Billions
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import os from "os";
import TorrentSearchAPI from "torrent-search-api";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const BUCKET_NAME = "convenient-pannikin";

// Enable torrent search
TorrentSearchAPI.enableProvider("Torrent9");
TorrentSearchAPI.enableProvider("ThePirateBay");

const s3Client = new S3Client({
  region: "iad",
  credentials: fromNodeProviderChain(),
});

const TARGET_SHOWS = {
  "Weeds": "Weeds",
  "The Blacklist": "The Blacklist",
  "Scandal": "Scandal",
  "Billions": "Billions",
  "Psych": "Psych" // TV series, not the movie Psycho
};

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/[\d.]+\s*(GB|MB|TB|KB|B)/i);
  if (!match) return 0;
  const value = parseFloat(match[0]);
  const unit = match[1].toUpperCase();
  const units = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
  return Math.ceil(value * (units[unit] || 1));
}

function getAvailableSpace() {
  try {
    const stat = os.statfs(DOWNLOADS_DIR);
    return stat.bavail * stat.bsize;
  } catch {}
  return null;
}

async function findTorrentsForShow(title) {
  try {
    // For Psych, search for "Psych TV series" to avoid matching Psycho the movie
    const searchTerm = title === "Psych" ? "Psych TV series" : title;
    const results = await TorrentSearchAPI.search(searchTerm, "All", 15);
    if (!results || results.length === 0) return [];

    return results
      .filter((t) => /1080p/i.test(t.title) && parseInt(t.seeds || 0) >= 5)
      .map((t) => ({
        title: t.title,
        magnet: t.magnet,
        seeders: parseInt(t.seeds || 0),
        size: t.size,
        provider: t.provider,
      }))
      .slice(0, 3);
  } catch (error) {
    console.error(`  Search error: ${error.message}`);
    return [];
  }
}

async function downloadViaAria2c(magnetLink) {
  return new Promise((resolve, reject) => {
    let hasOutput = false;
    const startTime = Date.now();

    const aria2 = spawn("aria2c", [
      "--max-connection-per-server=16",
      "--split=16",
      "--lowest-speed-limit=100K",
      "--bt-enable-lpd=true",
      "--enable-dht=true",
      "--continue=true",
      magnetLink,
    ], {
      cwd: DOWNLOADS_DIR,
    });

    aria2.stdout.on("data", () => {
      hasOutput = true;
      process.stdout.write(".");
    });

    aria2.stderr.on("data", () => {
      hasOutput = true;
    });

    const timeout = setTimeout(() => {
      if (!hasOutput) {
        aria2.kill();
        reject(new Error("No seeders"));
      }
    }, 120000);

    aria2.on("close", (code) => {
      clearTimeout(timeout);
      const duration = ((Date.now() - startTime) / 1000).toFixed(0);
      if (code === 0 || hasOutput) {
        console.log(` ✓ (${duration}s)`);
        resolve();
      } else {
        reject(new Error(`exit ${code}`));
      }
    });

    aria2.on("error", reject);
  });
}

function getVideoFiles() {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const exts = [".mp4", ".mkv", ".avi", ".mov", ".webm"];
    return files.filter((f) => exts.some((ext) => f.toLowerCase().endsWith(ext)));
  } catch {
    return [];
  }
}

async function uploadToS3(filePath, s3Key) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  try {
    const stream = fs.createReadStream(filePath);
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: stream,
    });

    process.stdout.write(`  Uploading ${sizeMB}MB... `);
    await s3Client.send(command);
    console.log("✓");
    return true;
  } catch (error) {
    console.log(`✗ (${error.message})`);
    return false;
  }
}

async function downloadShowsFromList() {
  console.log(`Downloading: ${Object.keys(TARGET_SHOWS).join(", ")}\n`);

  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const shows = data.items.filter((i) =>
    Object.keys(TARGET_SHOWS).some((s) => i.title.toLowerCase() === s.toLowerCase())
  );

  console.log(`Found ${shows.length} shows\n`);

  let uploaded = 0;

  for (const show of shows) {
    if (show.s3_url) {
      console.log(`${show.title} - already on S3 ✓\n`);
      uploaded++;
      continue;
    }

    console.log(`${show.title}`);
    console.log(`  Searching...`);

    const torrents = await findTorrentsForShow(show.title);
    if (torrents.length === 0) {
      console.log(`  ⚠ No 1080p torrents found\n`);
      continue;
    }

    const torrent = torrents[0];
    console.log(`  Found: ${torrent.title}`);
    console.log(`  Seeders: ${torrent.seeders}`);

    // Check space
    const needed = parseSize(torrent.size) * 1.2;
    const available = getAvailableSpace();
    if (available && needed > available) {
      console.log(`  ⚠ Not enough space\n`);
      continue;
    }

    try {
      process.stdout.write(`  Downloading... `);
      await downloadViaAria2c(torrent.magnet);

      const videos = getVideoFiles();
      if (videos.length === 0) {
        console.log(`  ⚠ No video found`);
        continue;
      }

      let largest = videos[0];
      let largestSize = fs.statSync(path.join(DOWNLOADS_DIR, largest)).size;
      for (const v of videos) {
        const sz = fs.statSync(path.join(DOWNLOADS_DIR, v)).size;
        if (sz > largestSize) {
          largest = v;
          largestSize = sz;
        }
      }

      const videoPath = path.join(DOWNLOADS_DIR, largest);
      const s3Key = `videos/${show.id}/${largest}`;

      if (await uploadToS3(videoPath, s3Key)) {
        show.s3_url = `https://${BUCKET_NAME}.s3.railway.app/${s3Key}`;
        uploaded++;

        for (const v of videos) {
          fs.unlinkSync(path.join(DOWNLOADS_DIR, v));
        }
        console.log(`  🗑 Cleaned up\n`);
      }
    } catch (error) {
      console.log(`  ✗ ${error.message}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));

  console.log(`✅ Complete! Uploaded ${uploaded}/${shows.length}`);
}

downloadShowsFromList().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
