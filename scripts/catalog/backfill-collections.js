#!/usr/bin/env node

/**
 * Backfill TMDB "collection" membership (franchise groupings, e.g. "The
 * Matrix Collection") for movies in the catalog, so the frontend can show
 * prequels/sequels on the title page.
 *
 * Read-only against enriched_400.json - a live download pipeline
 * (download-picked-torrents.js) writes to that file continuously, so this
 * script never touches it. Output goes to backend/data/collections_backfill
 * .json, a small side file the backend merges onto items at load time
 * (see main.rs), avoiding any risk of racing the pipeline's writes.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/collections_backfill.json");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set in environment");
  process.exit(1);
}

// enriched_400.json is being written by a live process; a read caught
// mid-write can yield truncated JSON. Retry a few times rather than crash.
function readEnrichedFile() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
    } catch (error) {
      if (attempt === 5) throw error;
    }
  }
}

async function tmdbFetch(urlPath) {
  const res = await fetch(`https://api.themoviedb.org/3${urlPath}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const data = readEnrichedFile();
  const targets = data.items.filter((i) => i.content_type === "movie" && i.tmdb_id);
  console.log(`${targets.length} movies with a tmdb_id to check\n`);

  const backfill = {};
  let found = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    try {
      const details = await tmdbFetch(`/movie/${item.tmdb_id}`);
      const collection = details.belongs_to_collection;
      if (collection) {
        backfill[item.id] = { collection_id: collection.id, collection_name: collection.name };
        found++;
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> ${collection.name}`);
      } else {
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> (no collection)`);
      }
    } catch (error) {
      console.log(`[${i + 1}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // gentle on TMDB's rate limit
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  console.log(`\n✅ Done! ${found}/${targets.length} movies belong to a collection. Written to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
