#!/usr/bin/env node

/**
 * Step 1: Pick the best torrents for each content item
 * Dynamic approach: get as much content as possible (complete series first, then seasons, then episodes)
 * Store multiple options per item, ranked by content volume
 */

import fs from "fs";
import path from "path";
import TorrentSearchAPI from "torrent-search-api";

const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");

// Shares download-picked-torrents.js's own lockfile rather than a separate
// one - both scripts write enriched_400.json, so either one running while
// the other starts causes the exact same in-progress-file clobbering this
// lock already exists to prevent. Checking this script's own callers for
// "is the pipeline running" (e.g. the admin dashboard's re-search button)
// only closes the race in one direction; both scripts actually acquiring
// the same lock at their own startup closes it in both.
const LOCK_FILE = path.join(process.cwd(), ".download-picked-torrents.lock");
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (fs.existsSync(LOCK_FILE)) {
  const existingPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10);
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Another instance (pipeline or picker) is already running (pid ${existingPid}). Refusing to start - it would race on enriched_400.json.`);
    process.exit(1);
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {}
});

// Enable working providers
// Torrent9 + ThePirateBay alone missed 170/404 catalog items. Turns out
// Torrent9's hardcoded domain in this package is dead (getaddrinfo ENOTFOUND
// torrent9.ninja) and has been contributing nothing - confirmed by probing
// every provider this package supports against a known-popular title
// ("Inception"): 1337x, KickassTorrents, Rarbg, TorrentProject, Torrentz2,
// and Yts are each dead, empty, or (TorrentProject) unreliable spam in this
// package's current state. Only ThePirateBay and Limetorrents actually
// returned real results.
TorrentSearchAPI.enableProvider("ThePirateBay");
TorrentSearchAPI.enableProvider("Limetorrents");

// Score how much content a torrent contains
function scoreContentVolume(title) {
  const lowerTitle = title.toLowerCase();

  // Complete series/collection
  if (/complete|full series|all seasons?|collection/i.test(lowerTitle)) {
    return 1000;
  }

  // Multi-season range (S01-S05)
  const multiSeasonMatch = lowerTitle.match(/s(\d+)-s(\d+)/);
  if (multiSeasonMatch) {
    const start = parseInt(multiSeasonMatch[1]);
    const end = parseInt(multiSeasonMatch[2]);
    return 500 + (end - start) * 50;
  }

  // Single season (but not episode)
  if (/^(?!.*e\d{2}).*s\d{2}(?!-)/i.test(lowerTitle)) {
    return 200;
  }

  // Multiple episodes (S01-S10 or similar episode range)
  if (/e\d+-e\d+/i.test(lowerTitle)) {
    return 150;
  }

  // Single episode
  if (/s\d{2}e\d{2}/i.test(lowerTitle)) {
    return 10;
  }

  // Default (assume full content if no season/episode markers)
  return 800;
}

// Each quality writes to its own fields so picking a lower quality never
// touches (or requires re-picking) another one already stored on the item.
const QUALITIES = [
  { label: "1080p", regex: /1080p/i, optionsKey: "torrent_options", indexKey: "current_torrent_index" },
  { label: "720p", regex: /720p/i, optionsKey: "torrent_options_720p", indexKey: "current_torrent_index_720p" },
];

// A confirmed-empty search isn't necessarily a real "no torrents exist" -
// Schindler's List returned nothing here under SEARCH_CONCURRENCY=8 load,
// yet an isolated single query against the same providers immediately after
// found 15+ well-seeded results. These scrapers (not an official API) choke
// under concurrent pressure and fail silently rather than erroring, so an
// empty result gets one retry after backing off before it's trusted.
const SEARCH_RETRIES = 3;

// This is a bare keyword search against public tracker indexes, not a lookup
// tied to the actual title/IMDB id - a query for "City of God" also surfaces
// an unrelated "City of God: The Fight Rages On" TV miniseries, which shares
// enough of the search string to pass but is a completely different work.
// scoreContentVolume already deprioritizes episode-shaped results for TV
// picks, but a *movie* should never accept one at all, regardless of score -
// there's no legitimate reading of "single TV episode" as "the movie" to pad
// a short results list with (confirmed: 41 movies in this catalog ended up
// with a wrong-show episode mixed into their option list this way, one of
// which - City of God - was one retry away from actually downloading and
// serving it as the film).
// A stricter subset of scoreContentVolume's own TV-shaped patterns - reused
// here as a hard exclusion for movies, not just a ranking signal (confirmed
// useful: a "Psycho" search surfaced an unrelated "[Commie] Psycho-Pass
// 1-22 Complete [BD 1080p FLAC]" batch - no "S01E01"-shaped marker, but
// scoreContentVolume already tags "complete series" titles like this one).
// Deliberately drops scoreContentVolume's bare "collection" trigger though -
// that one's a real, common false positive for movies specifically
// ("Criterion Collection" is a legitimate, well-regarded Blu-ray label, not
// a TV box set), where being a ranking-only signal never mattered before
// but a hard exclusion would have silently dropped a good result.
function isTvShaped(title) {
  const lower = title.toLowerCase();
  return (
    /complete|full series|all seasons?/i.test(lower) ||
    /s(\d+)-s(\d+)/.test(lower) ||
    /^(?!.*e\d{2}).*s\d{2}(?!-)/i.test(lower) ||
    /e\d+-e\d+/i.test(lower) ||
    /s\d{2}e\d{2}/i.test(lower)
  );
}
// Fansub-style releases (HorribleSubs/SubsPlease-type anime groups) number
// single episodes as a bare "- 05" rather than "S01E05", which scoreContentVolume
// doesn't recognize as TV-shaped at all (confirmed: the same Psycho search
// also surfaced a single PSYCHO-PASS episode released this way).
const BARE_EPISODE_PATTERN = /-\s?\d{1,3}\s?[[(]/;

// A second, independent signal: if the candidate title mentions a year at
// all, it should be within a year of the catalog's release year - catches
// same-title-different-work mismatches that aren't shaped like a TV episode
// at all (confirmed: a "WALL-E" (2008) search surfaced an unrelated "The
// Occupy Wall Street Collaborative Film 2013" documentary, matched on the
// word "Wall" alone). A candidate with no year mentioned isn't rejected on
// this basis - most legitimate releases do include one, but plenty of older
// or minimal-tag releases don't, and that alone isn't evidence of anything.
function hasYearMismatch(title, year) {
  if (!year) return false;
  const years = title.match(/\b(19|20)\d{2}\b/g);
  if (!years) return false;
  return !years.some((y) => Math.abs(parseInt(y, 10) - year) <= 1);
}

// A single movie is never legitimately labeled with a year *range* - only a
// franchise box set spans multiple release years (confirmed live: "The
// Terminator" (1984) search surfaced "The Terminator Collection 1984-2019"
// and "The Terminator Movies 1-6 1984-2019", both bundling all six films in
// one torrent). hasYearMismatch alone doesn't catch these - it only
// requires *any* mentioned year to be close enough, and the range's first
// year is the correct one. This mattered more than the Criterion Collection
// false positive that made isTvShaped drop the bare "collection" keyword:
// unlike a mislabeled year, a multi-movie bundle plus this catalog's
// "any one successful upload completes a movie" rule means whichever film in
// the pack happens to transcode/upload fastest silently becomes the
// permanent file for a *different* film's catalog entry.
const YEAR_RANGE_PATTERN = /\b(19|20)\d{2}\s*-\s*(19|20)\d{2}\b/;

// A bare keyword search against public trackers can surface adult content
// for any catalog title that happens to share a common word with a
// performer name or studio release (confirmed live: a search for "Elizabeth
// R" - a 1971 BBC historical drama - surfaced an unrelated adult film
// credited to a performer also named Elizabeth; "Heat", "The Cove", and
// "Reality Z" all turned up similar false matches). Unlike the movie-only
// checks above, this applies to every content type - nothing about a
// keyword collision like this is specific to movies vs TV.
const ADULT_CONTENT_PATTERN =
  /\b(xxx|milf|sexart|brazzers|reality kings|naughty america|bangbros|digital playground|vixen|blacked|tushy|metart|propertysex|twistys|wicked pictures|dorcel|jacquie et michel|nubile|teamskeet|mofos|babes\.com|femjoy|zero tolerance|erito|onlyfans|pornhub|interracial|kink|sexandsubmission|bdsm|hardcore|gangbang|anal|deepthroat|creampie|cumshot)\b/i;

function isMismatchedMovieResult(title, contentType, year) {
  if (contentType !== "movie") return false;
  return (
    isTvShaped(title) ||
    BARE_EPISODE_PATTERN.test(title) ||
    YEAR_RANGE_PATTERN.test(title) ||
    hasYearMismatch(title, year)
  );
}

async function findTorrentsForContent(title, qualityRegex, contentType, year) {
  for (let attempt = 1; attempt <= SEARCH_RETRIES; attempt++) {
    try {
      console.log(attempt === 1 ? "  Searching..." : `  Retry ${attempt - 1}/${SEARCH_RETRIES - 1}...`);
      const results = await TorrentSearchAPI.search(title, "All", 20);

      const topRaw = (results || [])
        .filter((t) => qualityRegex.test(t.title) && parseInt(t.seeds || 0) >= 5)
        .filter((t) => !ADULT_CONTENT_PATTERN.test(t.title))
        .filter((t) => !isMismatchedMovieResult(t.title, contentType, year))
        .sort((a, b) => scoreContentVolume(b.title) - scoreContentVolume(a.title))
        .slice(0, 5); // Keep top 5 before resolving magnets

      // Not every provider's search hit includes a ready .magnet - Limetorrents
      // only gives a .torrent-file URL, and saving that as-is left `magnet:
      // undefined` in every Limetorrents-sourced option (aria2c then failed
      // outright: "URI protocol not recognized"). getMagnet() resolves
      // whichever form the provider gave into a real magnet URI. Only doing
      // this for the 5 being kept, not all 20 raw hits.
      const candidates = [];
      for (const t of topRaw) {
        let magnet = t.magnet;
        if (!magnet) {
          try {
            magnet = await TorrentSearchAPI.getMagnet(t);
          } catch (error) {
            console.error(`    getMagnet failed for "${t.title}": ${error.message}`);
            continue;
          }
        }
        if (!magnet) continue;
        candidates.push({
          title: t.title,
          magnet,
          seeders: parseInt(t.seeds || 0),
          size: t.size,
          provider: t.provider,
          contentScore: scoreContentVolume(t.title),
        });
      }

      if (candidates.length > 0 || attempt === SEARCH_RETRIES) return candidates;
    } catch (error) {
      console.error(`    Search error (attempt ${attempt}): ${error.message}`);
      if (attempt === SEARCH_RETRIES) return [];
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  return [];
}

// How many (item, quality) lookups run concurrently. Each lookup is a
// network scrape against Torrent9/ThePirateBay, not local CPU, so the old
// one-at-a-time loop left almost all of that latency idle - fanning out
// hides it. Kept well under provider-rate-limit territory; all workers pull
// from one in-process task list, so - unlike download-picked-torrents.js -
// there's no cross-process file race to worry about here.
const SEARCH_CONCURRENCY = 8;

async function pickBestTorrents() {
  console.log("Loading enriched data...");
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));

  console.log(`Processing ${data.items.length} items\n`);

  const requestedQuality = process.argv[2];
  // Optional 3rd arg:
  //   plain string  → title contains (case-insensitive), single stuck item
  //   --band=must|nice → only ids from backend/data/acquisition-triage.json
  //   --ids=id1,id2    → explicit catalog ids
  const filterArg = process.argv[3];
  let titleFilter = null;
  let idFilter = null;
  if (filterArg && filterArg.startsWith("--band=")) {
    const band = filterArg.slice("--band=".length);
    const triagePath = path.join(DATA_DIR, "acquisition-triage.json");
    const triage = JSON.parse(fs.readFileSync(triagePath, "utf-8"));
    const rows = band === "must" ? triage.must : band === "nice" ? triage.nice : null;
    if (!rows) {
      console.error(`Unknown band "${band}". Use must or nice.`);
      process.exit(1);
    }
    idFilter = new Set(rows.map((r) => r.id));
    console.log(`Band filter: ${band} (${idFilter.size} ids from acquisition-triage.json)\n`);
  } else if (filterArg && filterArg.startsWith("--ids=")) {
    idFilter = new Set(filterArg.slice("--ids=".length).split(",").filter(Boolean));
    console.log(`Id filter: ${idFilter.size} id(s)\n`);
  } else if (filterArg) {
    titleFilter = filterArg;
  }
  const qualities = requestedQuality
    ? QUALITIES.filter((q) => q.label === requestedQuality)
    : QUALITIES;
  if (requestedQuality && qualities.length === 0) {
    console.error(`Unknown quality "${requestedQuality}". Valid: ${QUALITIES.map((q) => q.label).join(", ")}`);
    process.exit(1);
  }
  console.log(`Qualities: ${qualities.map((q) => q.label).join(", ")}\n`);
  if (titleFilter) console.log(`Title filter: "${titleFilter}"\n`);

  let itemsWithTorrents = 0;
  let totalTorrents = 0;
  let processedCount = 0;

  const tasks = [];
  for (const item of data.items) {
    if (idFilter && !idFilter.has(item.id)) continue;
    if (titleFilter && !item.title.toLowerCase().includes(titleFilter.toLowerCase())) continue;
    for (const quality of qualities) tasks.push({ item, quality });
  }
  if (tasks.length === 0) {
    console.error("No items matched the filter — nothing to search.");
    process.exit(1);
  }
  console.log(`Queued ${tasks.length} (item, quality) lookup(s)\n`);

  // Plain index counter, incremented synchronously with no `await` between
  // the read and the increment - safe for concurrent workers same as
  // createChannel() in download-picked-torrents.js.
  let nextTaskIndex = 0;
  function nextTask() {
    return nextTaskIndex < tasks.length ? tasks[nextTaskIndex++] : null;
  }

  async function worker() {
    let task;
    while ((task = nextTask())) {
      const { item, quality } = task;
      process.stdout.write(`[${nextTaskIndex}/${tasks.length}] ${item.title} (${quality.label})\n`);

      // Stored options are a one-time snapshot - seeder counts and even
      // which releases exist at all drift over weeks/months (confirmed
      // live: a re-search turned up several 150+ seed options for an item
      // whose stored last-resort option had 91, itself stale enough to
      // connect to peers but never actually exchange data). FORCE_REFRESH
      // re-searches anyway instead of skipping, but only alongside
      // titleFilter - a global refresh would re-hit every one of ~200
      // items against the same rate-limited providers for no reason when
      // only a handful are actually known-stuck.
      // Band/id filters also count as "targeted" for FORCE_REFRESH.
      const forceRefresh =
        process.env.FORCE_REFRESH === "1" && !!(titleFilter || idFilter);
      if (!forceRefresh && item[quality.optionsKey] && item[quality.optionsKey].length > 0) {
        console.log(`  (already picked - ${item[quality.optionsKey].length} options)\n`);
        itemsWithTorrents++;
        totalTorrents += item[quality.optionsKey].length;
        continue;
      }

      let torrents = await findTorrentsForContent(item.title, quality.regex, item.content_type, item.year);
      // Trackers - especially Brazilian-content ones - frequently only list
      // the original-language title, not whatever English title TMDB/IMDB
      // catalogued. Confirmed directly: Torrentio found nothing for
      // "Stomachache" but plenty for its real title "Estômago".
      if (torrents.length === 0 && item.original_title && item.original_title !== item.title) {
        console.log(`  (no results for "${item.title}", trying original title "${item.original_title}")`);
        torrents = await findTorrentsForContent(item.original_title, quality.regex, item.content_type, item.year);
      }

      if (torrents.length > 0) {
        item[quality.optionsKey] = torrents;
        item[quality.indexKey] = 0; // Start with the most complete option

        console.log(`  ✓ [${item.title}] Found ${torrents.length} options:`);
        torrents.forEach((t, idx) => {
          console.log(`    ${idx + 1}. ${t.title}`);
          console.log(`       Score: ${t.contentScore} | Seeders: ${t.seeders} | Size: ${t.size}`);
        });

        itemsWithTorrents++;
        totalTorrents += torrents.length;
      } else {
        console.log(`  ⚠ [${item.title}] No ${quality.label} torrents found`);
      }

      console.log("");

      // Rate limit, per worker - still gives each provider breathing room
      // between requests from any single "thread" while SEARCH_CONCURRENCY
      // workers overlap in wall-clock time.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Save progress every 10 lookups
      processedCount++;
      if (processedCount % 10 === 0) {
        fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
        console.log(`[Progress saved: ${itemsWithTorrents} items, ${totalTorrents} total torrents]\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, () => worker()));

  // Final save
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`  Items with torrents: ${itemsWithTorrents}/${data.items.length}`);
  console.log(`  Total torrent options: ${totalTorrents}`);
  console.log(`\nNext: node scripts/pipeline/download-picked-torrents.js`);
}

pickBestTorrents().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
