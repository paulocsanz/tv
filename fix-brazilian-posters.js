#!/usr/bin/env node

/**
 * `poster_url` is sourced from OMDb (see enrichment.rs), which mirrors
 * IMDb's poster choice - almost always the US/English-market release
 * poster, marketing text and all, even for foreign films (confirmed:
 * City of God's OMDb poster carries an English NYT review quote baked into
 * the art). For Brazilian-origin titles specifically, that reads as wrong
 * to a Brazilian audience. TMDB carries per-language poster art
 * (`/movie|tv/{id}/images`) - this swaps in the best-voted Portuguese
 * poster where one exists, leaving everything else untouched.
 *
 * Read-only against enriched_400.json until the final write - see
 * backfill-collections.js for why (a live download pipeline writes to that
 * file continuously). Re-reads immediately before writing to keep that
 * window small.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set (run with: node --env-file=.env fix-brazilian-posters.js)");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");

async function tmdbFetch(urlPath, params) {
  const url = new URL(`https://api.themoviedb.org/3${urlPath}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function bestPortuguesePoster(tmdbId, contentType) {
  const typePath = contentType === "movie" ? "movie" : "tv";
  const data = await tmdbFetch(`/${typePath}/${tmdbId}/images`, { include_image_language: "pt,null" });
  const ptPosters = (data.posters ?? []).filter((p) => p.iso_639_1 === "pt");
  if (ptPosters.length === 0) return null;
  ptPosters.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0) || (b.vote_count ?? 0) - (a.vote_count ?? 0));
  return `https://image.tmdb.org/t/p/w500${ptPosters[0].file_path}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const targets = catalog.filter((i) => i.origin === "Brazilian" && i.tmdb_id);
  console.log(`${targets.length} Brazilian-origin items to check.\n`);

  const updates = {};
  let found = 0;
  let checked = 0;

  for (const item of targets) {
    checked++;
    try {
      const posterUrl = await bestPortuguesePoster(item.tmdb_id, item.content_type);
      if (posterUrl && posterUrl !== item.poster_url) {
        updates[item.id] = posterUrl;
        found++;
        console.log(`[${checked}/${targets.length}] ${item.title} -> found PT poster`);
      } else {
        console.log(`[${checked}/${targets.length}] ${item.title} -> no PT poster, unchanged`);
      }
    } catch (error) {
      console.log(`[${checked}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
    }
    await sleep(150);
  }

  console.log(`\n${found} items have a Portuguese poster available.`);

  if (DRY_RUN) {
    console.log("--dry-run: not writing anything.");
    return;
  }
  if (found === 0) {
    console.log("Nothing to update.");
    return;
  }

  const fresh = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  let applied = 0;
  for (const item of fresh.items) {
    if (updates[item.id]) {
      item.poster_url = updates[item.id];
      applied++;
    }
  }
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(fresh, null, 2));
  console.log(`Applied ${applied} poster updates to ${ENRICHED_FILE}.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
