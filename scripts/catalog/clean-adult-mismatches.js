#!/usr/bin/env node

/**
 * pick-best-torrents.js does a bare keyword search against public tracker
 * indexes (ThePirateBay/Limetorrents), not a lookup tied to imdb/tmdb id -
 * confirmed concretely on "Elena" (a Brazilian telenovela): every single
 * result in both quality tiers was unrelated adult content that happens to
 * use "Elena" as a performer name. Existing code already guards against one
 * false-positive shape (a movie matching a TV episode); this guards against
 * another - a title colliding with adult-content indexing conventions.
 *
 * Read-only scan: reports which items have torrent_options entries whose
 * title trips adult-content signal words, for review before
 * clean-adult-mismatches.js --apply strips just those entries (not
 * necessarily the whole item - a title could have a mix of legitimate and
 * contaminated results).
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");

// Site/brand names and content markers common in adult-content torrent
// release naming, not in mainstream movie/TV releases.
// Deliberately no \b word-boundary requirement: these are compound
// brand/site tags that get run together with no separator in release names
// ("TeenageAnalSluts", "FamilyTherapyXXX") - a trailing boundary check
// would silently fail to match "teenageanal" inside "teenageanalsluts"
// (confirmed: this exact miss let one of Elena's 5 bad options through the
// first pass). A plain substring test is fine here since these tokens are
// distinctive brand names, not generic words that could false-positive on
// a legitimate title.
const ADULT_SIGNAL = /xxx|onlyfans|nubiles|brazzers|povd|ilovepov|teenageanal|familytherapyxxx|povlife|blacked|naughtyamerica|bangbros|realitykings|mofos|digitalplayground|pornhub|analtherapy|missax|wowgirls|sexmex|maturenl|groupsexgames|meetmadden|interracialvision|taboo\s?heat|allover30|fetish|anal\s?sluts/i;

const OPTION_KEYS = [
  { optionsKey: "torrent_options", indexKey: "current_torrent_index" },
  { optionsKey: "torrent_options_720p", indexKey: "current_torrent_index_720p" },
];

function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const apply = process.argv.includes("--apply");

  let itemsAffected = 0;
  let optionsRemoved = 0;

  for (const item of data.items) {
    let touchedThisItem = false;
    for (const { optionsKey, indexKey } of OPTION_KEYS) {
      const options = item[optionsKey];
      if (!options || options.length === 0) continue;

      const clean = options.filter((o) => !ADULT_SIGNAL.test(o.title));
      const removed = options.length - clean.length;
      if (removed === 0) continue;

      if (!touchedThisItem) {
        console.log(`\n${item.title} (${item.id})`);
        touchedThisItem = true;
      }
      console.log(`  ${optionsKey}: removing ${removed}/${options.length}`);
      options.filter((o) => ADULT_SIGNAL.test(o.title)).forEach((o) => console.log(`    - ${o.title}`));

      optionsRemoved += removed;
      if (apply) {
        item[optionsKey] = clean;
        // Selected index may now point past the end, or at a shifted
        // element - reset to 0 (the highest-scored remaining option, since
        // pick-best-torrents.js already sorts by score) rather than risk
        // silently pointing at the wrong title.
        if (clean.length > 0) item[indexKey] = 0;
        else item[indexKey] = undefined;
      }
    }
    if (touchedThisItem) itemsAffected++;
  }

  console.log(`\n${itemsAffected} item(s) had at least one contaminated option, ${optionsRemoved} option(s) total.`);
  if (apply) {
    fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
    console.log("Applied - enriched_400.json updated.");
  } else {
    console.log("Dry run only - rerun with --apply to write changes.");
  }
}

main();
