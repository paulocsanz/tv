#!/usr/bin/env node

/**
 * Step 1c: Backfill torrents for Brazilian movies via Torrentio's aggregated
 * stream API (queries by IMDB id, aggregates many trackers server-side -
 * including ones dead/blocked when hit directly from this network, and a
 * "brazuca" config tuned for Brazilian content specifically).
 *
 * Scoped to Brazilian movies only for now - Torrentio's TV results are
 * per-episode/season-pack oriented and would need separate handling to fit
 * this catalog's "one torrent per item" model.
 */

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");

const TORRENTIO_BASE = "https://torrentio.strem.fun/brazuca";

// allowFallback only on the 720p tier: pre-2000s Brazilian films mostly
// predate the 1080p/720p labeling convention entirely (real streams exist,
// just tagged "DVDRip" or nothing at all) - so if no true 720p-tagged result
// exists, fall back to the best-seeded result regardless of tag rather than
// leaving the item with nothing. The pipeline already downscales/passes
// through to a 720p cap based on the source's real probed height, not its
// filename, so this doesn't break anything technically - it's honest about
// capability, not a hard requirement. The 1080p tier stays strict: a
// DVDRip is definitely not 1080p, so it should never be filed as one.
const QUALITIES = [
  { label: "1080p", regex: /1080p/i, optionsKey: "torrent_options", indexKey: "current_torrent_index", allowFallback: false },
  { label: "720p", regex: /720p/i, optionsKey: "torrent_options_720p", indexKey: "current_torrent_index_720p", allowFallback: true },
];

// Standard public trackers to append - Torrentio gives a bare infoHash (BT
// DHT can find peers without trackers at all, but including a few well-known
// ones speeds up peer discovery same as any other magnet we build).
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];

function buildMagnet(infoHash, title) {
  const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&${tr}`;
}

// Torrentio packs seeders/size/source into a second title line like:
// "👤 12 💾 1.4 GB ⚙️ ThePirateBay" - no separate structured fields for these.
function parseStreamMeta(stream) {
  const lines = (stream.title || "").split("\n");
  const releaseTitle = lines[0] || stream.title;
  const metaLine = lines[1] || "";
  const seedMatch = metaLine.match(/👤\s*(\d+)/);
  const sizeMatch = metaLine.match(/💾\s*([\d.]+\s*\w+)/);
  const sourceMatch = metaLine.match(/⚙️\s*(.+)$/);
  return {
    title: releaseTitle,
    seeders: seedMatch ? parseInt(seedMatch[1], 10) : 0,
    size: sizeMatch ? sizeMatch[1].trim() : null,
    source: sourceMatch ? sourceMatch[1].trim() : "Torrentio",
  };
}

// Same lesson as pick-best-torrents.js's findTorrentsForContent: a shared
// public instance under load can return a technically-successful but empty
// {streams: []} body for a title that has real results seconds later on
// retry (confirmed directly - Bye Bye Brasil came back empty in a full run,
// 2 streams on an immediate manual re-check). So an empty result gets
// retried the same as a network error before it's trusted.
const FETCH_RETRIES = 3;

function toOption(s) {
  const meta = parseStreamMeta(s);
  return {
    title: meta.title,
    magnet: buildMagnet(s.infoHash, meta.title),
    seeders: meta.seeders,
    size: meta.size,
    provider: `Torrentio/${meta.source}`,
  };
}

async function findTorrentioOptions(imdbId, quality) {
  const url = `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const streams = json.streams || [];

      let matched = streams.filter((s) => quality.regex.test(s.title || ""));
      let usedFallback = false;
      if (matched.length === 0 && quality.allowFallback && streams.length > 0) {
        matched = streams;
        usedFallback = true;
      }

      const options = matched
        .map(toOption)
        .sort((a, b) => b.seeders - a.seeders)
        .slice(0, 5)
        .map((o) => {
          // A fallback pick that happens to carry some other real quality
          // tag (1080p, 2160p/4K) isn't actually unlabeled SD - only flag
          // the ones with no resolution info at all.
          const hasQualityTag = /\b(1080p|720p|2160p|4k)\b/i.test(o.title);
          return usedFallback && !hasQualityTag ? { ...o, title: `[SD/unlabeled] ${o.title}` } : o;
        });

      if (options.length > 0 || attempt === FETCH_RETRIES) return options;
    } catch (error) {
      if (attempt === FETCH_RETRIES) {
        console.error(`    Torrentio fetch failed: ${error.message}`);
        return [];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  return [];
}

// Sequential with a short gap - hammering the endpoint concurrently returned
// empty bodies / 502s during testing (rate limiting), a plain delay cleared
// it up.
const REQUEST_GAP_MS = 2000;

// Dry run only - reads enriched_400.json but NEVER writes back to it (the
// downloader may be running concurrently against that file). Results go to
// a separate JSON file for review; nothing gets applied until a deliberate
// follow-up pass merges reviewed results in.
const DRY_RUN_OUTPUT = path.join(process.cwd(), "torrentio-dry-run-results.json");

async function main() {
  console.log("Loading enriched data (read-only - no writes in this script)...");
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));

  const targets = data.items.filter(
    (i) =>
      i.origin === "Brazilian" &&
      i.content_type === "movie" &&
      i.imdb_id &&
      !(i.torrent_options && i.torrent_options.length) &&
      !(i.torrent_options_720p && i.torrent_options_720p.length)
  );

  console.log(`${targets.length} Brazilian movies still missing a torrent (with an imdb_id)\n`);

  let recovered = 0;
  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    console.log(`[${i + 1}/${targets.length}] ${item.title} (${item.imdb_id})`);

    const entry = { id: item.id, title: item.title, imdb_id: item.imdb_id, options: {} };
    let foundAny = false;
    for (const quality of QUALITIES) {
      const options = await findTorrentioOptions(item.imdb_id, quality);
      entry.options[quality.optionsKey] = options;
      if (options.length > 0) {
        foundAny = true;
        console.log(`  ✓ ${quality.label}: ${options.length} option(s), top seeders=${options[0].seeders}`);
        options.forEach((o) => console.log(`      - ${o.title} (${o.provider}, ${o.seeders} seeders, ${o.size || "?"})`));
      } else {
        console.log(`  ⚠ ${quality.label}: none`);
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
    }
    if (foundAny) recovered++;
    results.push(entry);

    if ((i + 1) % 10 === 0) {
      fs.writeFileSync(DRY_RUN_OUTPUT, JSON.stringify(results, null, 2));
      console.log(`[Dry-run results saved so far: ${recovered} recovered]\n`);
    }
  }

  fs.writeFileSync(DRY_RUN_OUTPUT, JSON.stringify(results, null, 2));
  console.log(`\n✅ Dry run done! ${recovered}/${targets.length} recovered.`);
  console.log(`Results written to ${DRY_RUN_OUTPUT} - enriched_400.json was NOT modified.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
