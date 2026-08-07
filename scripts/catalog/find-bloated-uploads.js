#!/usr/bin/env node

/**
 * Identify already-uploaded items hit by the transcode.js bitrate bug (see
 * conversation/commit: a 720p-tier source that wasn't H.264 was landing in
 * the `else` branch and getting re-encoded at the 1080p-tier 5000k bitrate
 * instead of 720p's 2200k - roughly 2.3x the intended file size for no
 * quality gain).
 *
 * Source files are deleted after upload, so there's no way to re-probe the
 * actual encoded resolution/codec after the fact. This uses the same
 * signal the pipeline itself used to decide there was no downscaling to
 * do: whichever torrent option was actually picked (qualityTier() in
 * download-picked-torrents.js prefers the 720p tier whenever it has
 * options) tagged as HEVC/x265 in its release title. A 1080p+ source
 * always downscales to 720p regardless of codec, and always got the
 * correct bitrate (the needsScale branch already keyed off maxHeight,
 * which is hardcoded to 720 everywhere this pipeline calls it) - so only
 * the 720p tier can have hit this.
 *
 * Read-only: writes the affected id list to bloated-uploads.json for
 * review. A separate deliberate step clears s3_key/s3_keys for the
 * confirmed set so the (now-fixed) pipeline re-downloads/re-transcodes/
 * re-uploads them - never done automatically by this script.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "bloated-uploads.json");
const HEVC_TAG = /\b(x265|h\.?265|hevc)\b/i;

function qualityTier(item) {
  if (item.torrent_options_720p && item.torrent_options_720p.length > 0) {
    return { label: "720p", optionsKey: "torrent_options_720p", indexKey: "current_torrent_index_720p" };
  }
  return { label: "1080p", optionsKey: "torrent_options", indexKey: "current_torrent_index" };
}

function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const uploaded = data.items.filter((i) => i.s3_key || (i.s3_keys && i.s3_keys.length > 0));
  console.log(`${uploaded.length} items already uploaded (out of ${data.items.length})\n`);

  const affected = [];
  for (const item of uploaded) {
    const tier = qualityTier(item);
    if (tier.label !== "720p") continue; // 1080p+ sources always downscale correctly regardless of codec
    const options = item[tier.optionsKey] || [];
    const idx = item[tier.indexKey] ?? 0;
    const picked = options[idx];
    if (!picked) continue;
    if (HEVC_TAG.test(picked.title)) {
      affected.push({
        id: item.id,
        title: item.title,
        content_type: item.content_type,
        episodeCount: item.s3_keys?.length || (item.s3_key ? 1 : 0),
        pickedTorrentTitle: picked.title,
      });
    }
  }

  console.log(`${affected.length} items likely affected (720p-tier HEVC/x265 source, no downscale = hit the bug):\n`);
  for (const a of affected) {
    console.log(`  ${a.title} (${a.content_type}, ${a.episodeCount} file(s)) <- ${a.pickedTorrentTitle}`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(affected, null, 2));
  console.log(`\nWritten to ${OUTPUT_FILE}. enriched_400.json was NOT modified.`);
}

main();
