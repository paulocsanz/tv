#!/usr/bin/env node

/**
 * Turn the resolved Best Picture nominee list
 * (backend/data/oscars_best_picture_resolved.json, written by
 * resolve-oscars.js) into the structured awards side file the backend
 * merges onto catalog items at boot (see apply_awards_backfill in
 * backend/src/main.rs).
 *
 * Run this AFTER `cargo run --bin enrich` has processed the newly-added
 * movies resolve-oscars.js appended to data/top_400_curated.json - entries
 * in the resolved file that only carry a tmdb_id (not yet in the catalog
 * when resolve-oscars.js ran) need their now-assigned catalog id looked up
 * here.
 *
 * Read-only against enriched_400.json - see backfill-collections.js for why.
 * Output: backend/data/awards_backfill.json, a map of catalog id -> award
 * entries, in the shape apply_awards_backfill expects.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const RESOLVED_FILE = path.join(process.cwd(), "backend/data/oscars_best_picture_resolved.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/awards_backfill.json");

function main() {
  const catalog = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8")).items;
  const resolved = JSON.parse(fs.readFileSync(RESOLVED_FILE, "utf-8"));

  const tmdbIdToCatalogId = new Map();
  for (const item of catalog) {
    if (item.content_type === "movie" && item.tmdb_id != null) {
      tmdbIdToCatalogId.set(item.tmdb_id, item.id);
    }
  }

  const backfill = {};
  const unresolved = [];
  let applied = 0;

  for (const entry of resolved) {
    let catalogId = entry.catalog_id;
    if (!catalogId && entry.tmdb_id != null) {
      catalogId = tmdbIdToCatalogId.get(entry.tmdb_id);
    }
    if (!catalogId) {
      unresolved.push(entry);
      continue;
    }

    if (!backfill[catalogId]) backfill[catalogId] = [];
    backfill[catalogId].push({
      event: "Academy Awards",
      category: "Best Picture",
      year: entry.ceremony_year,
      won: entry.won,
    });
    applied++;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));

  console.log(`Resolved entries: ${resolved.length}`);
  console.log(`Applied to ${Object.keys(backfill).length} catalog items (${applied} award entries)`);
  console.log(`Written to ${OUTPUT_FILE}`);
  if (unresolved.length) {
    console.log(`\nWARNING: ${unresolved.length} resolved entries had no matching catalog item:`);
    for (const u of unresolved) {
      console.log(`  - ${u.title} (tmdb_id=${u.tmdb_id ?? "?"}, catalog_id=${u.catalog_id ?? "?"})`);
    }
    console.log(`These films did not end up in enriched_400.json - check for enrich failures.`);
  }
}

main();
