#!/usr/bin/env node

/**
 * Backfill missing original_title (Portuguese title) for Brazilian catalog
 * items via TMDB, using the same source the original enrichment (backend/src/
 * enrichment.rs) pulled it from. Read-only against enriched_400.json until
 * the final write - safe to run standalone.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
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

function tmdbTypePath(contentType) {
  return contentType === "movie" ? "movie" : "tv";
}

async function getOriginalTitle(item) {
  const typePath = tmdbTypePath(item.content_type);

  if (item.tmdb_id) {
    const data = await tmdbFetch(`/${typePath}/${item.tmdb_id}`);
    return data.original_title || data.original_name || null;
  }

  if (item.imdb_id) {
    const data = await tmdbFetch(`/find/${item.imdb_id}?external_source=imdb_id`);
    const hit = (typePath === "movie" ? data.movie_results : data.tv_results)?.[0];
    return hit ? hit.original_title || hit.original_name || null : null;
  }

  // Last resort: title search (only 3 items in this catalog need this)
  const data = await tmdbFetch(`/search/${typePath}?query=${encodeURIComponent(item.title)}`);
  const hit = data.results?.[0];
  return hit ? hit.original_title || hit.original_name || null : null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const targets = data.items.filter((i) => i.origin === "Brazilian" && !i.original_title);
  console.log(`${targets.length} Brazilian items missing original_title\n`);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    try {
      const originalTitle = await getOriginalTitle(item);
      console.log(`[${i + 1}/${targets.length}] ${item.title} -> ${originalTitle || "(not found)"}`);
      results.push({ id: item.id, title: item.title, original_title: originalTitle });
    } catch (error) {
      console.log(`[${i + 1}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
      results.push({ id: item.id, title: item.title, original_title: null, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // gentle on TMDB's rate limit
  }

  fs.writeFileSync("original-titles-dry-run.json", JSON.stringify(results, null, 2));
  const found = results.filter((r) => r.original_title).length;
  console.log(`\n✅ Done! ${found}/${targets.length} found. Results in original-titles-dry-run.json (enriched_400.json NOT modified).`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
