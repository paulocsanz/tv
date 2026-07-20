use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct RawMovie {
    pub title: String,
    pub year: i32,
    pub director: Option<String>,
    pub imdb_rating: f64,
    pub origin: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawTvSeries {
    pub title: String,
    pub year: i32,
    pub creator: Option<String>,
    pub imdb_rating: f64,
    pub origin: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CuratedList {
    pub movies: Vec<RawMovie>,
    #[serde(rename = "tvSeries")]
    pub tv_series: Vec<RawTvSeries>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    Movie,
    Tv,
    /// A self-hosted course: manually cataloged (no TMDB/OMDb match - see
    /// enrichment.rs), lessons live in `s3_keys` like a TV series' episodes,
    /// with `attachments` for downloadable extras (PDFs, spreadsheets) that
    /// don't belong in the video stream itself.
    Course,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichedItem {
    pub id: String,
    pub title: String,
    /// Original-language title (e.g. Portuguese for Brazilian content), when
    /// TMDB reports one different from `title`. Used to make search work in
    /// the source language, not just the (often English) display title.
    pub original_title: Option<String>,
    pub year: i32,
    pub content_type: ContentType,
    pub origin: String,
    pub director: Option<String>,
    pub creator: Option<String>,
    pub curated_imdb_rating: f64,

    // Enrichment fields (best-effort; may be None if lookup failed)
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub plot: Option<String>,
    pub genres: Vec<String>,
    pub runtime: Option<String>,
    pub actors: Vec<String>,
    pub awards: Option<String>,
    pub rated: Option<String>,
    /// TMDB `language=pt-BR` title, when TMDB has a Portuguese translation
    /// for this item - unlike `title` (fixed at curation time) and
    /// `original_title` (the source-language title), this is specifically
    /// the localized-for-Brazil variant. `None` when TMDB has no pt-BR
    /// translation; the frontend falls back to `title` in that case. See
    /// backfill-pt-translations.js and enrichment.rs's `fetch_tmdb`.
    #[serde(default)]
    pub title_pt: Option<String>,
    /// TMDB `language=pt-BR` overview, filling the same role `plot` plays
    /// for English (OMDb has no localization at all, so this is TMDB-only).
    /// `None` when untranslated on TMDB.
    #[serde(default)]
    pub plot_pt: Option<String>,
    /// TMDB genre names in pt-BR, keyed by the same genre the item already
    /// has in `genres` - not a translation of the OMDb genre strings, but
    /// TMDB's own localized genre list for this title. Empty when unknown;
    /// the frontend falls back to `genres`.
    #[serde(default)]
    pub genres_pt: Vec<String>,
    /// Brazilian classificação indicativa (TMDB release_dates/content_ratings
    /// filtered to `BR`), distinct from `rated`'s US MPAA/TV rating. `None`
    /// when TMDB has no BR certification for this title.
    #[serde(default)]
    pub rated_pt: Option<String>,
    pub imdb_rating: Option<f64>,
    pub imdb_votes: Option<String>,
    pub rotten_tomatoes: Option<String>,
    pub metacritic: Option<String>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i64>,
    /// TMDB "collection" this movie belongs to (e.g. a franchise), if any.
    /// Used to surface prequels/sequels on the title page. Movies only.
    #[serde(default)]
    pub collection_id: Option<i64>,
    #[serde(default)]
    pub collection_name: Option<String>,
    pub trailer_key: Option<String>,
    pub enrichment_status: EnrichmentStatus,
    #[serde(default)]
    pub torrent_file: Option<String>,
    #[serde(default)]
    pub s3_key: Option<String>,
    /// Per-episode object keys for TV series with more than one file uploaded;
    /// empty for movies and single-file series, which use `s3_key` instead.
    #[serde(default)]
    pub s3_keys: Vec<String>,
    /// Subtitle tracks extracted from source files during the download
    /// pipeline, before the transcode step (which drops embedded subtitles
    /// entirely) discards its input.
    #[serde(default)]
    pub subtitles: Vec<SubtitleTrack>,
    /// TMDB episode details (title/overview/thumbnail) for downloaded TV
    /// episodes, matched by parsing the episode title out of each s3_key's
    /// filename - the pipeline doesn't tag files with season/episode
    /// numbers, so position alone can't be trusted. Empty until backfilled;
    /// the frontend falls back to filename parsing where an entry is missing.
    #[serde(default)]
    pub episodes: Vec<EpisodeMetadata>,
    /// TMDB thematic keywords (e.g. "heist", "based on a true story"),
    /// powering the browse-page keyword filter. See backfill-keywords.js.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Structured award/festival nominations (e.g. Academy Awards Best
    /// Picture), distinct from the free-text OMDb `awards` summary above.
    /// Generic across events so a future pass (Cannes, etc.) is just more
    /// data here, not a schema change. See resolve-oscars.js and
    /// generate-awards-backfill.js.
    #[serde(default)]
    pub award_entries: Vec<AwardEntry>,
    /// Self-hosted copy of the trailer (see download-trailers.js), when one
    /// has been downloaded - lets the frontend play it directly instead of
    /// embedding YouTube, which enforces regional licensing client-side and
    /// is unavailable in some countries for some trailers. `None` until the
    /// backfill catches up; the frontend falls back to the YouTube iframe
    /// (via `trailer_key` above) in that case.
    #[serde(default)]
    pub trailer_s3_key: Option<String>,
    /// Captions for the self-hosted trailer, in whatever languages YouTube
    /// had natively (not machine-translated). Reuses `SubtitleTrack` even
    /// though `episode` doesn't apply here (always 0, the same sentinel
    /// movies already use for "no episode") rather than a near-identical
    /// parallel struct for one unused field.
    #[serde(default)]
    pub trailer_subtitles: Vec<SubtitleTrack>,
    /// Downloadable extras that aren't part of the video stream (course
    /// PDFs/spreadsheets). Empty for movies and TV.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// Self-hosted poster image, when one's been generated (currently: a
    /// frame extracted from a course's first lecture - courses have no
    /// TMDB/OMDb entry to source a real poster from). `None` falls back to
    /// `poster_url`'s external link. Same presigned-redirect shape as
    /// `trailer_s3_key` rather than a public bucket URL - Railway buckets
    /// don't support public objects.
    #[serde(default)]
    pub poster_s3_key: Option<String>,
}

/// A downloadable extra alongside a course's lessons (PDF workbook, xlsx
/// worksheet, etc.) - not a video, so it doesn't belong in `s3_keys`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub label: String,
    pub filename: String,
    pub s3_key: String,
}

/// One nomination or win at an awards event/festival.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AwardEntry {
    /// e.g. "Academy Awards" (future: "Cannes Film Festival", etc.)
    pub event: String,
    /// e.g. "Best Picture"
    pub category: String,
    /// Ceremony year, e.g. 2024 for the 96th Academy Awards - not
    /// necessarily the film's release year.
    pub year: i32,
    pub won: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodeMetadata {
    /// 1-based index into `s3_keys` - matches `SubtitleTrack.episode` and
    /// the backend's stream/progress indexing.
    pub episode: i32,
    pub season_number: i32,
    pub episode_number: i32,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub still_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleTrack {
    /// 0 for movies/single-file series; otherwise the 1-based index into
    /// `s3_keys` that the frontend/watch-progress already use as the
    /// episode number.
    pub episode: i32,
    /// Stable per-(item, episode) identifier - the language code, or
    /// `<lang>-2` etc. when a file has more than one track in the same
    /// language.
    pub id: String,
    /// ISO 639-2 language code as reported by the source file (e.g. "eng").
    pub lang: String,
    pub label: String,
    #[serde(default)]
    pub forced: bool,
    pub s3_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnrichmentStatus {
    Ok,
    Partial,
    Failed,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnrichedCache {
    pub items: Vec<EnrichedItem>,
}

/// A title surfaced in a "Sequels & Prequels" or "More Like This" row.
/// Covers both catalog titles (`id` set, clickable to a title page) and
/// titles TMDB knows about that aren't in the library (`id` is None -
/// nothing to stream, so the frontend links out to TMDB instead).
#[derive(Debug, Clone, Serialize)]
pub struct RelatedTitle {
    pub id: Option<String>,
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub content_type: ContentType,
    /// IMDb rating for catalog titles, TMDB's vote average otherwise -
    /// same 0-10 scale either way.
    pub rating: Option<f64>,
}

/// One entry in a TMDB collection's full `parts` list (see
/// backfill-collection-parts.js) - every movie in the franchise, not just
/// the ones in the catalog.
#[derive(Debug, Clone, Deserialize)]
pub struct CollectionPart {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub rating: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollectionParts {
    pub name: String,
    pub parts: Vec<CollectionPart>,
}

/// One TMDB recommendation/similar-title result (see backfill-similar.js) -
/// kept even when it isn't in the catalog, unlike the old catalog-only
/// format.
#[derive(Debug, Clone, Deserialize)]
pub struct SimilarEntry {
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub rating: Option<f64>,
    pub content_type: ContentType,
}
