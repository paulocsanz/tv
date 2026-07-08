export type ContentType = "movie" | "tv";
export type EnrichmentStatus = "ok" | "partial" | "failed";

export interface ContentItem {
  id: string;
  title: string;
  original_title: string | null;
  year: number;
  content_type: ContentType;
  origin: string;
  director: string | null;
  creator: string | null;
  curated_imdb_rating: number;
  poster_url: string | null;
  backdrop_url: string | null;
  plot: string | null;
  genres: string[];
  runtime: string | null;
  actors: string[];
  awards: string | null;
  rated: string | null;
  imdb_rating: number | null;
  imdb_votes: string | null;
  rotten_tomatoes: string | null;
  metacritic: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  collection_id: number | null;
  collection_name: string | null;
  trailer_key: string | null;
  enrichment_status: EnrichmentStatus;
  torrent_file: string | null;
  s3_key: string | null;
  s3_keys: string[];
  subtitles: SubtitleTrack[];
  episodes: EpisodeMetadata[];
  keywords: string[];
}

export interface EpisodeMetadata {
  /** 1-based index into s3_keys - matches SubtitleTrack.episode. */
  episode: number;
  season_number: number;
  episode_number: number;
  name: string | null;
  overview: string | null;
  still_url: string | null;
}

export interface SubtitleTrack {
  /** 0 for movies/single-file series; otherwise the 1-based index into s3_keys. */
  episode: number;
  id: string;
  lang: string;
  label: string;
  forced: boolean;
  s3_key: string;
}

// A title shown in a "Sequels & Prequels" or "More Like This" row. `id` is
// null when TMDB knows about the title but it isn't in the library - there's
// nothing to link to locally, so the frontend links out to TMDB instead.
export interface RelatedTitle {
  id: string | null;
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  content_type: ContentType;
  rating: number | null;
}

export interface Section {
  key: string;
  title: string;
  items: ContentItem[];
}

export interface ContentResponse {
  items: ContentItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface ProgressEntry {
  episode: number;
  position_seconds: number;
  duration_seconds: number | null;
  finished: boolean;
}

export interface MeResponse {
  username: string;
  is_admin: boolean;
}

export interface UserSummary {
  id: number;
  username: string;
  is_admin: boolean;
}

export interface ContinueWatchingItem extends ContentItem {
  episode: number;
  progress_fraction: number;
}

export interface MetaResponse {
  total: number;
  movies: number;
  tv_series: number;
  brazilian: number;
  international: number;
  genres: string[];
  keywords: string[];
  year_min: number;
  year_max: number;
}

export function displayRating(item: ContentItem): number {
  return item.imdb_rating ?? item.curated_imdb_rating;
}
