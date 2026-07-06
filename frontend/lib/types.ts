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
  trailer_key: string | null;
  enrichment_status: EnrichmentStatus;
  torrent_file: string | null;
  s3_key: string | null;
  s3_keys: string[];
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

export interface MetaResponse {
  total: number;
  movies: number;
  tv_series: number;
  brazilian: number;
  international: number;
  genres: string[];
  year_min: number;
  year_max: number;
}

export function displayRating(item: ContentItem): number {
  return item.imdb_rating ?? item.curated_imdb_rating;
}
