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
    pub imdb_rating: Option<f64>,
    pub imdb_votes: Option<String>,
    pub rotten_tomatoes: Option<String>,
    pub metacritic: Option<String>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i64>,
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
