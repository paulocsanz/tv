#!/usr/bin/env node

/**
 * Backfill TMDB episode metadata (title/overview/thumbnail) for TV episodes
 * the download pipeline has already uploaded, so the video player's episode
 * picker can show real titles and stills instead of bare "Episode N".
 *
 * The pipeline names files like "Ep 05 - Dead Freight - <italian title>.mp4"
 * without a season tag, and a show's downloaded files aren't guaranteed to
 * start at season 1 (e.g. only Breaking Bad's final season is in the library
 * today, numbered Ep 01-16 for what is actually S05E01-E16) - so position
 * can't be trusted to infer the season. Instead this matches each local file
 * to a TMDB episode by season/episode number when the filename carries a
 * scene-release "SxxEyy" tag (e.g. "Ted.Lasso.S03E01.720p...-GROUP.mkv"),
 * falling back to matching by parsed title (season-agnostic) for the
 * pipeline's own "Ep NN - Title" naming, which has no season tag at all.
 *
 * Read-only against enriched_400.json (see backfill-collections.js for why:
 * a live download pipeline writes to that file continuously). Output goes to
 * backend/data/episode_metadata_backfill.json, a side file the backend
 * merges onto items at load time (see main.rs).
 *
 * Only processes shows that already have s3_keys - re-run this after the
 * pipeline downloads episodes for a show that isn't covered yet.
 */

import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const OUTPUT_FILE = path.join(process.cwd(), "backend/data/episode_metadata_backfill.json");
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

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mirrors parseEpisode() in frontend/components/VideoPlayer.tsx - keep in
// sync if that logic changes.
function parseLocalEpisodeTitle(s3Key) {
  const filename = s3Key.split("/").pop() ?? s3Key;
  const withoutExt = filename.replace(/\.[^./]+$/, "");
  const numberMatch = withoutExt.match(/^Ep\s*(\d+)/i);
  const parts = withoutExt.split(" - ");
  const title = numberMatch && parts.length > 1 ? parts[1].trim() : withoutExt;
  return title;
}

// Scene-release rips carry an explicit season/episode tag - mirrors the
// same regex in parseEpisode() in frontend/components/VideoPlayer.tsx.
function parseLocalSeasonEpisode(s3Key) {
  const filename = s3Key.split("/").pop() ?? s3Key;
  const match = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (!match) return null;
  return { season_number: parseInt(match[1], 10), episode_number: parseInt(match[2], 10) };
}

async function fetchAllEpisodes(tmdbId) {
  const show = await tmdbFetch(`/tv/${tmdbId}`);
  const seasonNumbers = (show.seasons ?? [])
    .map((s) => s.season_number)
    .filter((n) => n > 0); // skip "specials" (season 0)

  const episodes = [];
  for (const seasonNumber of seasonNumbers) {
    const season = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);
    for (const ep of season.episodes ?? []) {
      episodes.push({
        season_number: ep.season_number,
        episode_number: ep.episode_number,
        name: ep.name || null,
        overview: ep.overview || null,
        still_url: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
        normalized_name: ep.name ? normalizeTitle(ep.name) : null,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return episodes;
}

async function main() {
  const data = readEnrichedFile();
  const targets = data.items.filter(
    (i) => i.content_type === "tv" && i.tmdb_id && i.s3_keys && i.s3_keys.length > 0
  );
  console.log(`${targets.length} TV shows with downloaded episodes to match\n`);

  const backfill = {};
  for (const item of targets) {
    console.log(`--- ${item.title} (${item.s3_keys.length} files) ---`);
    let allEpisodes;
    try {
      allEpisodes = await fetchAllEpisodes(item.tmdb_id);
    } catch (error) {
      console.log(`  ERROR fetching TMDB episodes: ${error.message}`);
      continue;
    }

    const matched = [];
    let matchCount = 0;
    item.s3_keys.forEach((s3Key, index) => {
      const sxe = parseLocalSeasonEpisode(s3Key);
      const hit =
        (sxe &&
          allEpisodes.find(
            (e) => e.season_number === sxe.season_number && e.episode_number === sxe.episode_number
          )) ||
        allEpisodes.find((e) => e.normalized_name === normalizeTitle(parseLocalEpisodeTitle(s3Key)));
      if (hit) {
        matchCount++;
        matched.push({
          episode: index + 1,
          season_number: hit.season_number,
          episode_number: hit.episode_number,
          name: hit.name,
          overview: hit.overview,
          still_url: hit.still_url,
        });
        console.log(`  [${index + 1}] ${s3Key.split("/").pop()} -> S${hit.season_number}E${hit.episode_number} "${hit.name}"`);
      } else {
        console.log(`  [${index + 1}] ${s3Key.split("/").pop()} -> NO MATCH`);
      }
    });

    const matchRate = matchCount / item.s3_keys.length;
    if (matchRate < 0.5) {
      console.log(`  Skipping ${item.title}: only ${matchCount}/${item.s3_keys.length} episodes matched (<50%)`);
      continue;
    }
    backfill[item.id] = matched;
    console.log(`  ${matchCount}/${item.s3_keys.length} episodes matched\n`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backfill, null, 2));
  console.log(`\n✅ Done! Written to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
