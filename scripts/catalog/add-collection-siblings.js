#!/usr/bin/env node

/**
 * One-off: append the "not in library" movies surfaced by the Sequels &
 * Prequels feature (backend/data/collection_parts.json) to the curated
 * source list (data/top_400_curated.json), so the enrich pipeline picks
 * them up and they become real catalog entries.
 *
 * Excludes:
 *  - The "Midnight Run Collection" (tmdb collection 633215) entirely - our
 *    catalog's "Midnight" (1998) was mismatched to the wrong TMDB title
 *    during original enrichment (a pre-existing bug, not caused by this
 *    feature), which would otherwise drag 3 unrelated 90s American TV
 *    movies into the catalog mislabeled as Brazilian.
 *  - Parts with no release year yet (unreleased/announced, e.g. "Gladiator
 *    III", "Heat 2") - nothing to enrich or torrent for those.
 *
 * Origin is inherited from whichever catalog sibling already belongs to the
 * same collection (e.g. a Star Wars film not yet owned gets "International"
 * because Star Wars (1977) is). Director comes from a TMDB credits lookup
 * per movie, since the collection `parts` summary doesn't include crew.
 *
 * Read-only against enriched_400.json. Writes only to
 * data/top_400_curated.json (the curated *source* list, not the enriched
 * cache) - run `cargo run --bin enrich` afterward to actually enrich these
 * into backend/data/enriched_400.json.
 */

import fs from "fs";
import path from "path";

const BAD_COLLECTION_IDS = new Set([633215]); // Midnight Run Collection - see header

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const COLLECTIONS_BACKFILL_FILE = path.join(process.cwd(), "backend/data/collections_backfill.json");
const COLLECTION_PARTS_FILE = path.join(process.cwd(), "backend/data/collection_parts.json");
const CURATED_FILE = path.join(process.cwd(), "data/top_400_curated.json");
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

async function fetchDirector(tmdbId) {
  const credits = await tmdbFetch(`/movie/${tmdbId}/credits`);
  const director = (credits.crew ?? []).find((c) => c.job === "Director");
  return director ? director.name : null;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const catalogMovieIds = new Set(
    catalog.filter((i) => i.content_type === "movie" && i.tmdb_id).map((i) => i.tmdb_id)
  );

  const collectionsBackfill = JSON.parse(fs.readFileSync(COLLECTIONS_BACKFILL_FILE, "utf-8"));
  const collectionOrigin = {};
  for (const [itemId, v] of Object.entries(collectionsBackfill)) {
    const catalogItem = catalog.find((i) => i.id === itemId);
    if (catalogItem) collectionOrigin[v.collection_id] = catalogItem.origin;
  }

  const collectionParts = JSON.parse(fs.readFileSync(COLLECTION_PARTS_FILE, "utf-8"));
  const toAdd = [];
  const seen = new Set();
  for (const [cidStr, c] of Object.entries(collectionParts)) {
    const cid = parseInt(cidStr, 10);
    if (BAD_COLLECTION_IDS.has(cid)) continue;
    const origin = collectionOrigin[cid] ?? "International";
    for (const p of c.parts) {
      if (catalogMovieIds.has(p.tmdb_id) || seen.has(p.tmdb_id) || p.year == null) continue;
      seen.add(p.tmdb_id);
      toAdd.push({ tmdb_id: p.tmdb_id, title: p.title, year: p.year, rating: p.rating, origin, collection: c.name });
    }
  }

  console.log(`${toAdd.length} movies to add\n`);

  const newMovies = [];
  for (let i = 0; i < toAdd.length; i++) {
    const m = toAdd[i];
    let director = null;
    try {
      director = await fetchDirector(m.tmdb_id);
    } catch (error) {
      console.log(`[${i + 1}/${toAdd.length}] ${m.title} -> credits ERROR: ${error.message}`);
    }
    newMovies.push({
      title: m.title,
      year: m.year,
      director,
      imdb_rating: m.rating ?? 6.0,
      origin: m.origin,
    });
    console.log(`[${i + 1}/${toAdd.length}] ${m.title} (${m.year}) [${m.origin}] dir. ${director ?? "?"} - from ${m.collection}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const curated = JSON.parse(fs.readFileSync(CURATED_FILE, "utf-8"));
  curated.movies.push(...newMovies);
  fs.writeFileSync(CURATED_FILE, JSON.stringify(curated, null, 2));

  console.log(`\n✅ Done! Appended ${newMovies.length} movies to ${CURATED_FILE}`);
  console.log(`Curated list now has ${curated.movies.length} movies total.`);
  console.log(`Next: cd backend && cargo run --bin enrich`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
