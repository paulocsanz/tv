#!/usr/bin/env node

/**
 * Resolve the sourced Best Picture nominee list (data/oscars_best_picture.json)
 * against the catalog. For each nominee:
 *  - If a movie with the same (normalized title, year) already exists in the
 *    catalog, record its existing catalog id directly.
 *  - Otherwise, TMDB-search for it (mirroring enrichment.rs's title+year,
 *    title-only-fallback approach), fetch its director via TMDB credits, and
 *    append it to data/top_400_curated.json so the next `cargo run --bin
 *    enrich` pass turns it into a real catalog entry.
 *
 * Matching is done locally by title/year first, deliberately NOT by
 * cross-referencing a fresh TMDB search against each catalog item's stored
 * tmdb_id - this catalog has documented cases of a stored tmdb_id being wrong
 * for older/ambiguous titles (see validate-original-titles.js, commits
 * dafb436 and 8dd489a), and a tmdb_id-equality check would silently add a
 * duplicate for any such item instead of recognizing it's already owned.
 *
 * Read-only against enriched_400.json - see backfill-collections.js for why
 * (a live download pipeline writes to that file continuously).
 *
 * Outputs:
 *  - data/top_400_curated.json: new movies appended (existing entries
 *    untouched).
 *  - backend/data/oscars_best_picture_resolved.json: every nominee, each
 *    entry carrying either a `catalog_id` (already owned) or a `tmdb_id`
 *    (newly added - its catalog id doesn't exist until enrich runs and
 *    assigns a slug).
 *  - backend/data/oscars_low_confidence_matches.json: newly-added entries
 *    whose TMDB match is uncertain (title-only fallback fired, or the
 *    returned title differs substantially from the source title) - review
 *    this before running enrich.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const CURATED_FILE = path.join(process.cwd(), "data/top_400_curated.json");
const OSCARS_FILE = path.join(process.cwd(), "data/oscars_best_picture.json");
const RESOLVED_FILE = path.join(process.cwd(), "backend/data/oscars_best_picture_resolved.json");
const LOW_CONFIDENCE_FILE = path.join(process.cwd(), "backend/data/oscars_low_confidence_matches.json");

const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY not set in environment (run with: node --env-file=.env resolve-oscars.js)");
  process.exit(1);
}

function normalizeTitle(title) {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Small Levenshtein distance for flagging suspicious TMDB matches.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function titlesLookSuspicious(sourceTitle, tmdbTitle) {
  const a = normalizeTitle(sourceTitle);
  const b = normalizeTitle(tmdbTitle);
  if (a === b) return false;
  const dist = editDistance(a, b);
  return dist > Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.3));
}

async function tmdbFetch(urlPath, params) {
  const url = new URL(`https://api.themoviedb.org/3${urlPath}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function searchMovie(title, year) {
  const byYear = await tmdbFetch("/search/movie", { query: title, year: String(year) });
  if (byYear.results?.length) return { result: byYear.results[0], usedFallback: false };
  const titleOnly = await tmdbFetch("/search/movie", { query: title });
  if (titleOnly.results?.length) return { result: titleOnly.results[0], usedFallback: true };
  return null;
}

async function fetchDirector(tmdbId) {
  const credits = await tmdbFetch(`/movie/${tmdbId}/credits`);
  const director = (credits.crew ?? []).find((c) => c.job === "Director");
  return director ? director.name : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const oscars = JSON.parse(fs.readFileSync(OSCARS_FILE, "utf-8"));
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const catalogMovies = catalog.filter((i) => i.content_type === "movie");

  // Index catalog movies by normalized title -> [{id, year, tmdb_id}]
  const byTitle = new Map();
  for (const item of catalogMovies) {
    const key = normalizeTitle(item.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(item);
  }

  const curated = JSON.parse(fs.readFileSync(CURATED_FILE, "utf-8"));
  const curatedTitleYears = new Set(
    curated.movies.map((m) => `${normalizeTitle(m.title)}::${m.year}`)
  );

  const resolved = [];
  const lowConfidence = [];
  const newMovies = [];
  const seenNewTmdbIds = new Set();
  let matchedExisting = 0;
  let addedNew = 0;
  let skippedDuplicateSource = 0;
  let failed = 0;

  const seenSource = new Set();

  for (let i = 0; i < oscars.length; i++) {
    const nom = oscars[i];
    const sourceKey = `${normalizeTitle(nom.title)}::${nom.film_year}`;
    if (seenSource.has(sourceKey)) {
      skippedDuplicateSource++;
      continue;
    }
    seenSource.add(sourceKey);

    const progress = `[${i + 1}/${oscars.length}]`;
    const key = normalizeTitle(nom.title);
    const candidates = byTitle.get(key) ?? [];

    // Prefer an exact year match; fall back to +/-1 year (some catalog
    // entries use US wide-release year, which can differ by a year from a
    // film's festival/production year).
    let localMatch =
      candidates.find((c) => c.year === nom.film_year) ??
      candidates.find((c) => Math.abs(c.year - nom.film_year) <= 1);

    if (localMatch) {
      matchedExisting++;
      resolved.push({
        catalog_id: localMatch.id,
        title: nom.title,
        ceremony_year: nom.ceremony_year,
        won: nom.won,
      });
      if (localMatch.year !== nom.film_year) {
        lowConfidence.push({
          reason: "yearMismatch",
          source_title: nom.title,
          source_film_year: nom.film_year,
          catalog_id: localMatch.id,
          catalog_year: localMatch.year,
        });
      }
      console.log(`${progress} ${nom.title} (${nom.film_year}) -> already in catalog (${localMatch.id})`);
      continue;
    }

    // Not in the catalog locally - resolve via TMDB and queue for addition.
    try {
      const found = await searchMovie(nom.title, nom.film_year);
      if (!found) {
        failed++;
        lowConfidence.push({
          reason: "notFoundOnTmdb",
          source_title: nom.title,
          source_film_year: nom.film_year,
        });
        console.log(`${progress} ${nom.title} (${nom.film_year}) -> NOT FOUND on TMDB`);
        await sleep(250);
        continue;
      }

      const { result, usedFallback } = found;
      if (seenNewTmdbIds.has(result.id)) {
        // Two source rows resolved to the same film (shouldn't normally
        // happen for Best Picture, but guard against it).
        skippedDuplicateSource++;
        continue;
      }
      seenNewTmdbIds.add(result.id);

      const suspicious = titlesLookSuspicious(nom.title, result.title);
      if (usedFallback || suspicious) {
        lowConfidence.push({
          reason: usedFallback ? "titleOnlyFallback" : "titleMismatch",
          source_title: nom.title,
          source_film_year: nom.film_year,
          tmdb_id: result.id,
          tmdb_title: result.title,
          tmdb_release_date: result.release_date ?? null,
        });
      }

      let director = null;
      try {
        director = await fetchDirector(result.id);
      } catch (error) {
        console.log(`${progress}   credits ERROR: ${error.message}`);
      }

      const alreadyCurated = curatedTitleYears.has(`${normalizeTitle(nom.title)}::${nom.film_year}`);
      if (!alreadyCurated) {
        newMovies.push({
          title: nom.title,
          year: nom.film_year,
          director,
          imdb_rating: result.vote_average ?? 6.0,
          origin: "International",
        });
        curatedTitleYears.add(`${normalizeTitle(nom.title)}::${nom.film_year}`);
      }

      resolved.push({
        tmdb_id: result.id,
        title: nom.title,
        ceremony_year: nom.ceremony_year,
        won: nom.won,
      });
      addedNew++;
      console.log(
        `${progress} ${nom.title} (${nom.film_year}) -> NEW, tmdb_id=${result.id}${usedFallback ? " [fallback]" : ""}${suspicious ? " [SUSPICIOUS]" : ""}`
      );
    } catch (error) {
      failed++;
      lowConfidence.push({
        reason: "error",
        source_title: nom.title,
        source_film_year: nom.film_year,
        error: error.message,
      });
      console.log(`${progress} ${nom.title} (${nom.film_year}) -> ERROR: ${error.message}`);
    }

    await sleep(250);
  }

  curated.movies.push(...newMovies);
  fs.writeFileSync(CURATED_FILE, JSON.stringify(curated, null, 2));
  fs.writeFileSync(RESOLVED_FILE, JSON.stringify(resolved, null, 2));
  fs.writeFileSync(LOW_CONFIDENCE_FILE, JSON.stringify(lowConfidence, null, 2));

  console.log(`\nDone.`);
  console.log(`  Source nominees: ${oscars.length} (skipped ${skippedDuplicateSource} duplicate rows)`);
  console.log(`  Already in catalog: ${matchedExisting}`);
  console.log(`  Newly added to ${CURATED_FILE}: ${newMovies.length}`);
  console.log(`  Not found on TMDB: ${failed}`);
  console.log(`  Low-confidence entries needing review: ${lowConfidence.length} -> ${LOW_CONFIDENCE_FILE}`);
  console.log(`  Resolved mapping written to ${RESOLVED_FILE} (${resolved.length} entries)`);
  console.log(`\nNext: review ${LOW_CONFIDENCE_FILE}, then cd backend && cargo run --bin enrich`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
