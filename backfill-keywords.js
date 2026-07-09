#!/usr/bin/env node

/**
 * Backfill TMDB thematic keywords (e.g. "heist", "based on a true story",
 * "dystopia") for every title, powering the browse-page keyword filter (and
 * the keyword tags shown on the title page).
 *
 * Read-only against enriched_400.json - see backfill-collections.js for why
 * (a live download pipeline writes to that file continuously). Output goes
 * to backend/data/keywords_backfill.json, a side file the backend merges
 * onto items at load time (see main.rs).
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/keywords_backfill.json");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set in environment");
  process.exit(1);
}

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
  const targets = data.items.filter((i) => i.tmdb_id);
  console.log(`${targets.length} items with a tmdb_id to check\n`);

  const backfill = {};
  let withKeywords = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const typePath = item.content_type === "movie" ? "movie" : "tv";
    try {
      const res = await tmdbFetch(`/${typePath}/${item.tmdb_id}/keywords`);
      const raw = item.content_type === "movie" ? res.keywords : res.results;
      const keywords = (raw ?? []).map((k) => k.name);

      if (keywords.length > 0) {
        backfill[item.id] = keywords;
        withKeywords++;
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> ${keywords.length} keywords`);
      } else {
        console.log(`[${i + 1}/${targets.length}] ${item.title} -> (none)`);
      }
    } catch (error) {
      console.log(`[${i + 1}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // gentle on TMDB's rate limit
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  console.log(`\n✅ Done! ${withKeywords}/${targets.length} items got keywords. Written to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
