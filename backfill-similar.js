#!/usr/bin/env node

/**
 * Backfill "More Like This" recommendations for every title. Uses TMDB's
 * recommendations endpoint (falling back to its similar-titles endpoint
 * when empty) and keeps the full result - title/year/poster/rating - even
 * when it isn't something in the library. The backend resolves each result
 * against the catalog at request time (see main.rs's resolve_related_title)
 * and links out to TMDB for anything that isn't in the library, rather than
 * only ever suggesting what you can already stream.
 *
 * Read-only against enriched_400.json - see backfill-collections.js for why
 * (a live download pipeline writes to that file continuously). Output goes
 * to backend/data/similar_backfill.json, a side file the backend loads
 * directly (see main.rs) rather than merging onto items, since this is a
 * many-to-many relation, not a per-item scalar field.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/similar_backfill.json");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set in environment");
  process.exit(1);
}
const MAX_RESULTS = 10;

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

function tmdbTypePath(contentType) {
  return contentType === "movie" ? "movie" : "tv";
}

async function main() {
  const data = readEnrichedFile();
  const targets = data.items.filter((i) => i.tmdb_id);
  console.log(`${targets.length} items with a tmdb_id to check\n`);

  const backfill = {};
  let withMatches = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const typePath = tmdbTypePath(item.content_type);
    try {
      let results = (await tmdbFetch(`/${typePath}/${item.tmdb_id}/recommendations`)).results ?? [];
      if (results.length === 0) {
        results = (await tmdbFetch(`/${typePath}/${item.tmdb_id}/similar`)).results ?? [];
      }

      const entries = results.slice(0, MAX_RESULTS).map((r) => ({
        tmdb_id: r.id,
        title: r.title || r.name,
        year: (r.release_date || r.first_air_date) ? parseInt((r.release_date || r.first_air_date).slice(0, 4), 10) : null,
        poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        rating: typeof r.vote_average === "number" ? r.vote_average : null,
        content_type: item.content_type,
      }));

      if (entries.length > 0) {
        backfill[item.id] = entries;
        withMatches++;
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> ${entries.length} results`);
      } else {
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> (no results)`);
      }
    } catch (error) {
      console.log(`[${i + 1}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // gentle on TMDB's rate limit
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  console.log(`\n✅ Done! ${withMatches}/${targets.length} items got recommendations. Written to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
