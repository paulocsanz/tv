#!/usr/bin/env node

/**
 * One-off follow-up to clean-adult-mismatches.js: two more items were found
 * live with adult content whose *actual delivered filename* (s3_key)
 * carries the signal, even though their recorded torrent_options titles
 * don't (found by scanning real s3_key/s3_keys instead of option titles -
 * see conversation).
 *
 * - Medusa: the one bad option that produced this has already been
 *   stripped by clean-adult-mismatches.js, so a redownload has nothing
 *   left to pull from until pick-best-torrents.js is re-run for it.
 * - Heat (1995): all recorded option titles are legitimate ("Heat (1995)
 *   1080p BrRip x264 - YIFY" etc, well-seeded, normal release groups) yet
 *   the delivered file was adult content anyway - the torrent's actual
 *   payload didn't match its own advertised name/metadata. No title-based
 *   filter can catch that. Bumping current_torrent_index to the next
 *   option is a precaution in case index 0 specifically is the
 *   mismatched/poisoned torrent, not a confirmed diagnosis.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");

function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));

  const medusa = data.items.find((i) => i.id === "medusa-2021-movie");
  if (medusa) {
    console.log("Medusa before:", medusa.s3_key);
    medusa.s3_key = undefined;
    medusa.s3_keys = [];
  }

  const heat = data.items.find((i) => i.id === "heat-1995-movie");
  if (heat) {
    console.log("Heat before:", heat.s3_key);
    heat.s3_key = undefined;
    heat.s3_keys = [];
    if (heat.torrent_options && heat.torrent_options.length > 1) {
      heat.current_torrent_index = ((heat.current_torrent_index ?? 0) + 1) % heat.torrent_options.length;
      console.log(`Heat: bumped current_torrent_index to ${heat.current_torrent_index} (${heat.torrent_options[heat.current_torrent_index].title})`);
    }
    if (heat.torrent_options_720p && heat.torrent_options_720p.length > 1) {
      heat.current_torrent_index_720p = ((heat.current_torrent_index_720p ?? 0) + 1) % heat.torrent_options_720p.length;
      console.log(`Heat: bumped current_torrent_index_720p to ${heat.current_torrent_index_720p}`);
    }
  }

  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
  console.log("\nDone. Both cleared for re-download; flagged for the user to double-check once re-uploaded given Heat's root cause (mismatched torrent payload) isn't fully understood.");
}

main();
