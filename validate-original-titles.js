#!/usr/bin/env node

/**
 * Cross-check the tmdb_id-based original_title backfill against a fresh
 * title+year search on TMDB. If the two disagree on which tmdb_id the item
 * actually is, the catalog's stored tmdb_id is suspect (confirmed happening
 * for at least "Behind the Sun" -> "Things Behind the Sun" and "Stomachache"
 * -> an unrelated 2025 entry) - flag rather than silently trust either.
 */

import fs from "fs";

const TMDB_API_KEY = process.env.TMDB_API_KEY;

async function tmdbFetch(urlPath) {
  const res = await fetch(`https://api.themoviedb.org/3${urlPath}`, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function typePath(contentType) {
  return contentType === "movie" ? "movie" : "tv";
}

async function searchCandidate(item) {
  const path = typePath(item.content_type);
  const yearParam = item.year ? `&${path === "movie" ? "year" : "first_air_date_year"}=${item.year}` : "";
  const data = await tmdbFetch(`/search/${path}?query=${encodeURIComponent(item.title)}${yearParam}`);
  return data.results?.[0] || null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync("backend/data/enriched_400.json", "utf-8"));
  const priorResults = JSON.parse(fs.readFileSync("original-titles-dry-run.json", "utf-8"));
  const byId = new Map(data.items.map((i) => [i.id, i]));

  const confirmed = [];
  const suspicious = [];
  const notFound = [];

  for (let i = 0; i < priorResults.length; i++) {
    const r = priorResults[i];
    const item = byId.get(r.id);
    if (!r.original_title) {
      notFound.push(r);
      console.log(`[${i + 1}/${priorResults.length}] ${r.title} -> (not found, skip)`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }

    try {
      const candidate = await searchCandidate(item);
      const candidateTmdbId = candidate?.id;
      const storedTmdbId = item.tmdb_id;

      if (candidateTmdbId && storedTmdbId && candidateTmdbId !== storedTmdbId) {
        console.log(`[${i + 1}/${priorResults.length}] ${r.title} -> SUSPICIOUS: stored tmdb_id=${storedTmdbId} ("${r.original_title}") vs fresh search tmdb_id=${candidateTmdbId} ("${candidate.original_title || candidate.original_name}")`);
        suspicious.push({
          id: r.id,
          title: r.title,
          stored_tmdb_id: storedTmdbId,
          stored_original_title: r.original_title,
          search_tmdb_id: candidateTmdbId,
          search_original_title: candidate.original_title || candidate.original_name,
        });
      } else {
        console.log(`[${i + 1}/${priorResults.length}] ${r.title} -> confirmed: ${r.original_title}`);
        confirmed.push(r);
      }
    } catch (error) {
      console.log(`[${i + 1}/${priorResults.length}] ${r.title} -> validation error: ${error.message} (keeping unvalidated)`);
      confirmed.push(r);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  fs.writeFileSync("original-titles-confirmed.json", JSON.stringify(confirmed, null, 2));
  fs.writeFileSync("original-titles-suspicious.json", JSON.stringify(suspicious, null, 2));

  console.log(`\n✅ Done! Confirmed: ${confirmed.length} | Suspicious (need review): ${suspicious.length} | Not found: ${notFound.length}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
