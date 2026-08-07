#!/usr/bin/env node

/**
 * `title`/`plot`/`genres`/`rated` are sourced from OMDb (see enrichment.rs),
 * which has no localization at all - always English, regardless of the
 * title's origin. TMDB's own details endpoint accepts `language=pt-BR` and
 * returns a real Portuguese translation when one exists for a title
 * (title/overview/genre names), falling back to an empty string/list when
 * it doesn't - never a translation we invented ourselves. This backfills
 * `title_pt`/`plot_pt`/`genres_pt`/`rated_pt` (see models.rs's EnrichedItem)
 * for the existing catalog; new items get the same fields automatically
 * going forward via enrichment.rs's `fetch_tmdb`.
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
  console.error("TMDB_API_KEY not set (run with: node --env-file=.env backfill-pt-translations.js)");
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

async function ptTranslation(tmdbId, typePath) {
  const details = await tmdbFetch(`/${typePath}/${tmdbId}`, { language: "pt-BR" });
  const title = typePath === "movie" ? details.title : details.name;
  const genres = (details.genres ?? []).map((g) => g.name).filter(Boolean);
  return {
    title_pt: title && title.trim() ? title : null,
    plot_pt: details.overview && details.overview.trim() ? details.overview : null,
    genres_pt: genres,
  };
}

async function brRating(tmdbId, typePath) {
  if (typePath === "movie") {
    const data = await tmdbFetch(`/movie/${tmdbId}/release_dates`);
    const br = (data.results ?? []).find((c) => c.iso_3166_1 === "BR");
    const cert = br?.release_dates?.map((d) => d.certification).find((c) => c);
    return cert || null;
  }
  const data = await tmdbFetch(`/tv/${tmdbId}/content_ratings`);
  const br = (data.results ?? []).find((c) => c.iso_3166_1 === "BR");
  return br?.rating || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const targets = catalog.filter((i) => i.tmdb_id && (i.content_type === "movie" || i.content_type === "tv"));
  console.log(`${targets.length} items with a tmdb_id to check.\n`);

  const updates = {};
  let translated = 0;
  let checked = 0;

  for (const item of targets) {
    checked++;
    const typePath = item.content_type === "movie" ? "movie" : "tv";
    try {
      const [pt, rated_pt] = await Promise.all([
        ptTranslation(item.tmdb_id, typePath),
        brRating(item.tmdb_id, typePath),
      ]);
      const hasAny = pt.title_pt || pt.plot_pt || pt.genres_pt.length > 0 || rated_pt;
      if (hasAny) {
        updates[item.id] = { ...pt, rated_pt };
        translated++;
        console.log(`[${checked}/${targets.length}] ${item.title} -> pt-BR data found`);
      } else {
        console.log(`[${checked}/${targets.length}] ${item.title} -> nothing on TMDB, unchanged`);
      }
    } catch (error) {
      console.log(`[${checked}/${targets.length}] ${item.title} -> ERROR: ${error.message}`);
    }
    await sleep(150);
  }

  console.log(`\n${translated} items have pt-BR data available.`);

  if (DRY_RUN) {
    console.log("--dry-run: not writing anything.");
    return;
  }
  if (translated === 0) {
    console.log("Nothing to update.");
    return;
  }

  const fresh = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  let applied = 0;
  for (const item of fresh.items) {
    const update = updates[item.id];
    if (!update) continue;
    if (update.title_pt) item.title_pt = update.title_pt;
    if (update.plot_pt) item.plot_pt = update.plot_pt;
    if (update.genres_pt.length > 0) item.genres_pt = update.genres_pt;
    if (update.rated_pt) item.rated_pt = update.rated_pt;
    applied++;
  }
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(fresh, null, 2));
  console.log(`Applied ${applied} pt-BR updates to ${ENRICHED_FILE}.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
