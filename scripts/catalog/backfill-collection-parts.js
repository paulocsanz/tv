#!/usr/bin/env node

/**
 * Backfill each TMDB collection's full membership list (every movie in the
 * franchise, not just the ones already in the catalog) so the "Sequels &
 * Prequels" row can show the whole series - including titles you don't
 * have - rather than only what happens to already be in the library.
 *
 * Reads the distinct collection ids out of collections_backfill.json (see
 * backfill-collections.js), then fetches each collection's `parts` list.
 * Output goes to backend/data/collection_parts.json, which the backend
 * loads directly (see main.rs) - not merged onto enriched_400.json, which a
 * live download pipeline writes to continuously.
 */

import fs from "fs";
import path from "path";

const COLLECTIONS_FILE = path.join(process.cwd(), "backend/data/collections_backfill.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/collection_parts.json");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set in environment");
  process.exit(1);
}

async function tmdbFetch(urlPath) {
  const res = await fetch(`https://api.themoviedb.org/3${urlPath}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const collectionsBackfill = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, "utf-8"));
  const collectionIds = [...new Set(Object.values(collectionsBackfill).map((v) => v.collection_id))];
  console.log(`${collectionIds.length} distinct collections to expand\n`);

  const output = {};
  for (let i = 0; i < collectionIds.length; i++) {
    const collectionId = collectionIds[i];
    try {
      const collection = await tmdbFetch(`/collection/${collectionId}`);
      const parts = (collection.parts ?? []).map((p) => ({
        tmdb_id: p.id,
        title: p.title,
        year: p.release_date ? parseInt(p.release_date.slice(0, 4), 10) : null,
        poster_url: p.poster_path ? `https://image.tmdb.org/t/p/w500${p.poster_path}` : null,
        rating: typeof p.vote_average === "number" ? p.vote_average : null,
      }));
      output[collectionId] = { name: collection.name, parts };
      console.log(`[${i + 1}/${collectionIds.length}] ${collection.name} -> ${parts.length} movies`);
    } catch (error) {
      console.log(`[${i + 1}/${collectionIds.length}] collection ${collectionId} -> ERROR: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // gentle on TMDB's rate limit
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done! Written to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
