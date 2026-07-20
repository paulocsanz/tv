export type ContentType = "movie" | "tv" | "course";
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
  // Self-hosted poster (currently: a frame extracted from a course's first
  // lecture, since courses have no TMDB/OMDb entry to source a real poster
  // from) - null falls back to poster_url's external link. Served through
  // /api/poster/<id> (presigned redirect), not this key directly - Railway
  // buckets don't support public objects.
  poster_s3_key: string | null;
  backdrop_url: string | null;
  plot: string | null;
  genres: string[];
  runtime: string | null;
  actors: string[];
  awards: string | null;
  rated: string | null;
  // TMDB `language=pt-BR` variants of the fields above, sourced from the
  // real TMDB translation (never machine-translated) - null/empty when
  // TMDB has no Portuguese data for this title. See lib/i18n/content.ts's
  // localizeItem, which is what every display component should read
  // title/plot/genres/rated through instead of these directly.
  title_pt: string | null;
  plot_pt: string | null;
  genres_pt: string[];
  rated_pt: string | null;
  imdb_rating: number | null;
  imdb_votes: string | null;
  rotten_tomatoes: string | null;
  metacritic: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  collection_id: number | null;
  collection_name: string | null;
  trailer_key: string | null;
  // Self-hosted copy of the trailer, when download-trailers.js has gotten
  // to this item - null falls back to the YouTube iframe (trailer_key
  // above), which enforces regional licensing client-side and is
  // unavailable in some countries for some trailers.
  trailer_s3_key: string | null;
  trailer_subtitles: SubtitleTrack[];
  enrichment_status: EnrichmentStatus;
  torrent_file: string | null;
  s3_key: string | null;
  s3_keys: string[];
  subtitles: SubtitleTrack[];
  episodes: EpisodeMetadata[];
  keywords: string[];
  award_entries: AwardEntry[];
  attachments: Attachment[];
}

// Prefers the self-hosted poster (proxied through /api/poster/<id>, which
// presigns a fresh S3 URL server-side - Railway buckets don't support
// public objects, so poster_s3_key alone isn't a usable <img src>) over the
// external poster_url. Both can be null (poster_s3_key while nothing's been
// generated yet, poster_url for a handful of items TMDB/OMDb has no art
// for either) - callers still need their own placeholder for that case.
export function posterSrc(item: ContentItem): string | null {
  return item.poster_s3_key ? `/api/poster/${item.id}` : item.poster_url;
}

// A downloadable extra alongside a course's lessons (PDF workbook, xlsx
// worksheet, etc.) - not a video, so it isn't part of s3_keys.
export interface Attachment {
  label: string;
  filename: string;
  s3_key: string;
}

// A nomination or win at an awards event/festival (e.g. Academy Awards Best
// Picture). Distinct from the free-text `awards` OMDb summary above. Generic
// across events - only Academy Awards data is populated today, but a future
// event (Cannes, etc.) needs no shape change here.
export interface AwardEntry {
  event: string;
  category: string;
  year: number;
  won: boolean;
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
  display_name: string | null;
  default_subtitle_lang: string | null;
  autoplay_next: boolean;
  ui_locale: string;
}

export interface UserSummary {
  id: number;
  username: string;
  is_admin: boolean;
  display_name: string | null;
}

export interface InviteResponse {
  token: string;
  expires_at: string;
}

export interface UserUsage {
  user_id: number;
  username: string;
  display_name: string | null;
  watch_minutes: number;
}

export interface CatalogGapItem {
  id: string;
  title: string;
  content_type: ContentType;
}

export interface CatalogEditEntry {
  username: string;
  content_id: string;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface CatalogReviewResponse {
  no_torrent_options: CatalogGapItem[];
  recent_edits: CatalogEditEntry[];
}

export interface PipelineRunSummary {
  started_ts: number;
  picked: number;
  total: number;
  done_this_run: number;
  failed_this_run: number;
}

export interface PipelineStatusResponse {
  running: boolean;
  lock_pid: number | null;
  // Raw pipeline-events.jsonl line - shape varies by event type, so this
  // stays loosely typed rather than mirroring every event variant.
  last_event: Record<string, unknown> | null;
  seconds_since_last_event: number | null;
  current_run: PipelineRunSummary | null;
}

export interface ContinueWatchingItem extends ContentItem {
  episode: number;
  progress_fraction: number;
}

export interface MetaResponse {
  total: number;
  movies: number;
  tv_series: number;
  courses: number;
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
