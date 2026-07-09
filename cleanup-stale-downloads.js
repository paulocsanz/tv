#!/usr/bin/env node

/**
 * One-off cleanup: delete only download attempts aria2c itself has not
 * marked complete (a `.aria2` control file still exists for that target),
 * skipping whatever the currently-live aria2c processes are actively
 * writing to. A `.aria2` file with no live process behind it can never
 * resume (its parent download-picked-torrents.js run is gone), and the
 * data underneath it is unverified by aria2c regardless of what size it
 * looks like on disk (aria2 preallocates full file size upfront).
 *
 * Deletes at the granularity of the individual .aria2-marked target (a
 * subfolder or a root-level file), NOT the whole item directory - a single
 * item dir can hold one finished download (no .aria2, keep) sitting right
 * next to a different, abandoned attempt (has .aria2, delete just that one).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");

const livePids = execSync(`ps aux | grep aria2c | grep -v grep | awk '{print $2}'`)
  .toString().trim().split("\n").filter(Boolean);

const liveCwds = new Set();
for (const pid of livePids) {
  try {
    const out = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`).toString();
    const match = out.match(/\/\S.*$/);
    if (match) liveCwds.add(match[0].trim());
  } catch {}
}
console.log("Live aria2c working directories (protected):", [...liveCwds]);

let freedBytes = 0;
const deletedTargets = [];

for (const itemDir of fs.readdirSync(DOWNLOADS_DIR)) {
  if (itemDir === ".transcoded") continue;
  const itemPath = path.join(DOWNLOADS_DIR, itemDir);
  if (!fs.statSync(itemPath).isDirectory()) continue;

  const isLive = liveCwds.has(itemPath);
  const entries = fs.readdirSync(itemPath);
  const aria2Files = entries.filter((e) => e.endsWith(".aria2"));

  if (entries.length === 0) {
    fs.rmdirSync(itemPath);
    console.log(`DELETED (empty dir): ${itemDir}`);
    continue;
  }

  for (const aria2File of aria2Files) {
    const targetName = aria2File.slice(0, -".aria2".length);
    const targetPath = path.join(itemPath, targetName);

    if (isLive) {
      console.log(`SKIP (live download target): ${itemDir}/${targetName}`);
      continue;
    }

    const aria2Path = path.join(itemPath, aria2File);
    let size = 0;
    try {
      size = parseInt(execSync(`du -sk "${aria2Path}" "${targetPath}" 2>/dev/null | awk '{sum+=$1} END {print sum}'`).toString().trim() || "0", 10) * 1024;
    } catch {}
    freedBytes += size;

    fs.rmSync(aria2Path, { force: true });
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
    deletedTargets.push(`${itemDir}/${targetName}`);
    console.log(`DELETED (abandoned, aria2c never marked complete): ${itemDir}/${targetName}`);
  }

  // Clean up now-empty item dirs (everything inside was abandoned attempts).
  if (!isLive && fs.readdirSync(itemPath).length === 0) {
    fs.rmdirSync(itemPath);
    console.log(`DELETED (now-empty item dir): ${itemDir}`);
  }
}

console.log(`\nDeleted ${deletedTargets.length} abandoned target(s), freed ~${(freedBytes / 1024 / 1024 / 1024).toFixed(1)}GB`);
