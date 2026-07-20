use crate::models::{ContentType, EnrichedItem, EnrichmentStatus};
use anyhow::Result;
use serde::Deserialize;
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct OmdbKeyPool {
    keys: Vec<String>,
    cursor: AtomicUsize,
}

impl OmdbKeyPool {
    pub fn new(keys: Vec<String>) -> Self {
        Self {
            keys,
            cursor: AtomicUsize::new(0),
        }
    }

    pub fn next_key(&self) -> &str {
        let idx = self.cursor.fetch_add(1, Ordering::Relaxed) % self.keys.len();
        &self.keys[idx]
    }
}

#[derive(Debug, Deserialize)]
struct OmdbRating {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Value")]
    value: String,
}

#[derive(Debug, Deserialize, Default)]
struct OmdbResponse {
    #[serde(rename = "Rated")]
    rated: Option<String>,
    #[serde(rename = "Runtime")]
    runtime: Option<String>,
    #[serde(rename = "Genre")]
    genre: Option<String>,
    #[serde(rename = "Actors")]
    actors: Option<String>,
    #[serde(rename = "Plot")]
    plot: Option<String>,
    #[serde(rename = "Awards")]
    awards: Option<String>,
    #[serde(rename = "Poster")]
    poster: Option<String>,
    #[serde(rename = "Ratings")]
    ratings: Option<Vec<OmdbRating>>,
    #[serde(rename = "imdbRating")]
    imdb_rating: Option<String>,
    #[serde(rename = "imdbVotes")]
    imdb_votes: Option<String>,
    #[serde(rename = "imdbID")]
    imdb_id: Option<String>,
    #[serde(rename = "Metascore")]
    metascore: Option<String>,
    #[serde(rename = "Response")]
    response: Option<String>,
}

async fn fetch_omdb_once(
    client: &reqwest::Client,
    key: &str,
    title: &str,
    year: Option<i32>,
    omdb_type: &str,
) -> Result<OmdbResponse> {
    let mut query: Vec<(&str, String)> = vec![
        ("apikey", key.to_string()),
        ("t", title.to_string()),
        ("type", omdb_type.to_string()),
        ("plot", "short".to_string()),
    ];
    if let Some(y) = year {
        query.push(("y", y.to_string()));
    }
    let resp: OmdbResponse = client
        .get("https://www.omdbapi.com/")
        .query(&query)
        .send()
        .await?
        .json()
        .await?;
    Ok(resp)
}

async fn fetch_omdb(
    client: &reqwest::Client,
    pool: &OmdbKeyPool,
    title: &str,
    year: i32,
    content_type: &ContentType,
) -> Option<OmdbResponse> {
    let omdb_type = match content_type {
        ContentType::Movie => "movie",
        ContentType::Tv => "series",
        ContentType::Course => unreachable!("courses are cataloged manually, never enriched via OMDb"),
    };

    let key = pool.next_key();
    if let Ok(resp) = fetch_omdb_once(client, key, title, Some(year), omdb_type).await {
        if resp.response.as_deref() == Some("True") {
            return Some(resp);
        }
    }

    // Fallback: retry without the year constraint (title-only match).
    let key = pool.next_key();
    if let Ok(resp) = fetch_omdb_once(client, key, title, None, omdb_type).await {
        if resp.response.as_deref() == Some("True") {
            return Some(resp);
        }
    }

    None
}

/// Look up OMDb directly by IMDb ID. Far more reliable than title+year
/// matching, which can land on an unrelated same-titled work (e.g. a
/// documentary short released the same year as the real feature).
async fn fetch_omdb_by_imdb_id(
    client: &reqwest::Client,
    key: &str,
    imdb_id: &str,
) -> Option<OmdbResponse> {
    let resp: OmdbResponse = client
        .get("https://www.omdbapi.com/")
        .query(&[("apikey", key), ("i", imdb_id), ("plot", "short")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    if resp.response.as_deref() == Some("True") {
        Some(resp)
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
struct TmdbSearchResult {
    id: i64,
    backdrop_path: Option<String>,
    #[serde(alias = "name")]
    title: Option<String>,
    #[serde(alias = "original_name")]
    original_title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TmdbSearchResponse {
    results: Vec<TmdbSearchResult>,
}

#[derive(Debug, Deserialize)]
struct TmdbExternalIds {
    imdb_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TmdbCollection {
    id: i64,
    name: String,
}

#[derive(Debug, Deserialize, Default)]
struct TmdbMovieDetails {
    belongs_to_collection: Option<TmdbCollection>,
}

#[derive(Debug, Deserialize)]
struct TmdbVideo {
    key: String,
    site: String,
    #[serde(rename = "type")]
    kind: String,
    official: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TmdbVideosResponse {
    results: Vec<TmdbVideo>,
}

#[derive(Debug, Deserialize)]
struct TmdbGenre {
    name: String,
}

// `language=pt-BR` on the same details endpoint `fetch_tmdb` already calls
// for `belongs_to_collection` - title/overview/genres come back localized
// when TMDB has a pt-BR translation for this title, empty string/list
// otherwise (never an error, so a missing translation can't fail enrichment).
#[derive(Debug, Deserialize, Default)]
struct TmdbDetailsPt {
    #[serde(alias = "name")]
    title: Option<String>,
    overview: Option<String>,
    #[serde(default)]
    genres: Vec<TmdbGenre>,
}

#[derive(Debug, Deserialize)]
struct TmdbReleaseDateEntry {
    certification: String,
}

#[derive(Debug, Deserialize)]
struct TmdbReleaseDatesCountry {
    iso_3166_1: String,
    release_dates: Vec<TmdbReleaseDateEntry>,
}

#[derive(Debug, Deserialize)]
struct TmdbReleaseDatesResponse {
    results: Vec<TmdbReleaseDatesCountry>,
}

#[derive(Debug, Deserialize)]
struct TmdbContentRatingEntry {
    iso_3166_1: String,
    rating: String,
}

#[derive(Debug, Deserialize)]
struct TmdbContentRatingsResponse {
    results: Vec<TmdbContentRatingEntry>,
}

#[derive(Default)]
struct TmdbPtData {
    title_pt: Option<String>,
    plot_pt: Option<String>,
    genres_pt: Vec<String>,
    rated_pt: Option<String>,
}

/// Best-effort Brazilian localization for one title: pt-BR title/overview/
/// genre names from the details endpoint, plus the BR classificação
/// indicativa from the release-dates (movie) or content-ratings (TV)
/// endpoint. Every step swallows its own errors - a rate limit or missing
/// translation here must never fail the (otherwise successful) enrichment
/// of the item's English fields.
async fn fetch_tmdb_pt(
    client: &reqwest::Client,
    token: &str,
    video_path: &str,
    tmdb_id: i64,
) -> TmdbPtData {
    let details_url = format!("https://api.themoviedb.org/3/{video_path}/{tmdb_id}");
    let details_resp = client
        .get(&details_url)
        .bearer_auth(token)
        .query(&[("language", "pt-BR")])
        .send()
        .await
        .ok();
    let details: TmdbDetailsPt = match details_resp {
        Some(r) => r.json::<TmdbDetailsPt>().await.unwrap_or_default(),
        None => TmdbDetailsPt::default(),
    };

    let rated_pt = if video_path == "movie" {
        let url = format!("https://api.themoviedb.org/3/movie/{tmdb_id}/release_dates");
        let resp = client.get(&url).bearer_auth(token).send().await.ok();
        let parsed: Option<TmdbReleaseDatesResponse> = match resp {
            Some(r) => r.json().await.ok(),
            None => None,
        };
        parsed.and_then(|resp| {
            resp.results
                .into_iter()
                .find(|c| c.iso_3166_1 == "BR")
                .and_then(|c| {
                    c.release_dates
                        .into_iter()
                        .map(|d| d.certification)
                        .find(|cert| !cert.is_empty())
                })
        })
    } else {
        let url = format!("https://api.themoviedb.org/3/tv/{tmdb_id}/content_ratings");
        let resp = client.get(&url).bearer_auth(token).send().await.ok();
        let parsed: Option<TmdbContentRatingsResponse> = match resp {
            Some(r) => r.json().await.ok(),
            None => None,
        };
        parsed.and_then(|resp| {
            resp.results
                .into_iter()
                .find(|c| c.iso_3166_1 == "BR")
                .map(|c| c.rating)
                .filter(|r| !r.is_empty())
        })
    };

    TmdbPtData {
        title_pt: details.title.filter(|t| !t.is_empty()),
        plot_pt: details.overview.filter(|o| !o.is_empty()),
        genres_pt: details.genres.into_iter().map(|g| g.name).collect(),
        rated_pt,
    }
}

struct TmdbData {
    backdrop_url: Option<String>,
    trailer_key: Option<String>,
    tmdb_id: Option<i64>,
    imdb_id: Option<String>,
    original_title: Option<String>,
    collection_id: Option<i64>,
    collection_name: Option<String>,
    title_pt: Option<String>,
    plot_pt: Option<String>,
    genres_pt: Vec<String>,
    rated_pt: Option<String>,
}

async fn fetch_tmdb(
    client: &reqwest::Client,
    token: &str,
    title: &str,
    year: i32,
    content_type: &ContentType,
) -> Option<TmdbData> {
    let (search_path, year_param, video_path) = match content_type {
        ContentType::Movie => ("search/movie", "year", "movie"),
        ContentType::Tv => ("search/tv", "first_air_date_year", "tv"),
        ContentType::Course => unreachable!("courses are cataloged manually, never enriched via TMDB"),
    };

    let search_url = format!("https://api.themoviedb.org/3/{search_path}");
    let search: TmdbSearchResponse = client
        .get(&search_url)
        .bearer_auth(token)
        .query(&[("query", title), (year_param, &year.to_string())])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let first = match search.results.into_iter().next() {
        Some(f) => f,
        None => {
            let retry: TmdbSearchResponse = client
                .get(&search_url)
                .bearer_auth(token)
                .query(&[("query", title)])
                .send()
                .await
                .ok()?
                .json()
                .await
                .ok()?;
            retry.results.into_iter().next()?
        }
    };

    let backdrop_url = first
        .backdrop_path
        .map(|p| format!("https://image.tmdb.org/t/p/w1280{p}"));
    let original_title = first
        .original_title
        .filter(|t| Some(t) != first.title.as_ref());

    let videos_url = format!("https://api.themoviedb.org/3/{video_path}/{}/videos", first.id);
    let trailer_key = client
        .get(&videos_url)
        .bearer_auth(token)
        .send()
        .await
        .ok()?
        .json::<TmdbVideosResponse>()
        .await
        .ok()
        .and_then(|v| {
            v.results
                .iter()
                .find(|r| r.site == "YouTube" && r.kind == "Trailer" && r.official.unwrap_or(false))
                .or_else(|| v.results.iter().find(|r| r.site == "YouTube" && r.kind == "Trailer"))
                .map(|r| r.key.clone())
        });

    let external_ids_url = format!(
        "https://api.themoviedb.org/3/{video_path}/{}/external_ids",
        first.id
    );
    let imdb_id = client
        .get(&external_ids_url)
        .bearer_auth(token)
        .send()
        .await
        .ok()?
        .json::<TmdbExternalIds>()
        .await
        .ok()
        .and_then(|e| e.imdb_id)
        .filter(|id| !id.is_empty());

    // Collections (franchise groupings, e.g. "The Matrix Collection") only
    // exist for movies in TMDB's data model - skip the extra call for TV.
    let (collection_id, collection_name) = match content_type {
        ContentType::Movie => {
            let details_url = format!("https://api.themoviedb.org/3/movie/{}", first.id);
            let details: Option<TmdbMovieDetails> = match client
                .get(&details_url)
                .bearer_auth(token)
                .send()
                .await
            {
                Ok(resp) => resp.json().await.ok(),
                Err(_) => None,
            };
            let collection = details.and_then(|d| d.belongs_to_collection);
            match collection {
                Some(c) => (Some(c.id), Some(c.name)),
                None => (None, None),
            }
        }
        ContentType::Tv => (None, None),
        ContentType::Course => unreachable!("courses are cataloged manually, never enriched via TMDB"),
    };

    let pt = fetch_tmdb_pt(client, token, video_path, first.id).await;

    Some(TmdbData {
        backdrop_url,
        trailer_key,
        tmdb_id: Some(first.id),
        imdb_id,
        original_title,
        collection_id,
        collection_name,
        title_pt: pt.title_pt,
        plot_pt: pt.plot_pt,
        genres_pt: pt.genres_pt,
        rated_pt: pt.rated_pt,
    })
}

pub struct EnrichInput {
    pub id: String,
    pub title: String,
    pub year: i32,
    pub content_type: ContentType,
    pub origin: String,
    pub director: Option<String>,
    pub creator: Option<String>,
    pub curated_imdb_rating: f64,
}

pub async fn enrich_one(
    client: &reqwest::Client,
    omdb_pool: &OmdbKeyPool,
    tmdb_token: &str,
    input: EnrichInput,
) -> EnrichedItem {
    let tmdb = fetch_tmdb(client, tmdb_token, &input.title, input.year, &input.content_type).await;

    // Prefer looking OMDb up by the IMDb ID TMDB gave us: it's an authoritative
    // match, whereas title+year search can land on an unrelated same-titled
    // work (e.g. a "making of" documentary released the same year).
    let omdb = match tmdb.as_ref().and_then(|t| t.imdb_id.as_deref()) {
        Some(imdb_id) => {
            let key = omdb_pool.next_key();
            match fetch_omdb_by_imdb_id(client, key, imdb_id).await {
                Some(resp) => Some(resp),
                None => fetch_omdb(client, omdb_pool, &input.title, input.year, &input.content_type).await,
            }
        }
        None => fetch_omdb(client, omdb_pool, &input.title, input.year, &input.content_type).await,
    };

    let mut status = EnrichmentStatus::Failed;

    let (
        poster_url,
        plot,
        genres,
        runtime,
        actors,
        awards,
        rated,
        imdb_rating,
        imdb_votes,
        rotten_tomatoes,
        metacritic,
        imdb_id,
    ) = if let Some(o) = omdb {
        status = EnrichmentStatus::Ok;
        let genres = o
            .genre
            .as_deref()
            .map(|g| {
                g.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| s != "N/A" && !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let actors = o
            .actors
            .as_deref()
            .map(|a| {
                a.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| s != "N/A" && !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let imdb_rating = o.imdb_rating.as_deref().and_then(|s| s.parse::<f64>().ok());
        let rt = o.ratings.as_ref().and_then(|rs| {
            rs.iter()
                .find(|r| r.source == "Rotten Tomatoes")
                .map(|r| r.value.clone())
        });
        let mc = o.ratings.as_ref().and_then(|rs| {
            rs.iter()
                .find(|r| r.source == "Metacritic")
                .map(|r| r.value.clone())
        });
        let poster = o
            .poster
            .filter(|p| p != "N/A")
            .map(|p| p.to_string());

        (
            poster,
            o.plot.filter(|p| p != "N/A"),
            genres,
            o.runtime.filter(|r| r != "N/A"),
            actors,
            o.awards.filter(|a| a != "N/A"),
            o.rated.filter(|r| r != "N/A"),
            imdb_rating,
            o.imdb_votes.filter(|v| v != "N/A"),
            rt,
            mc.or(o.metascore).filter(|m| m != "N/A"),
            o.imdb_id,
        )
    } else {
        (
            None, None, Vec::new(), None, Vec::new(), None, None, None, None, None, None, None,
        )
    };

    let (
        backdrop_url,
        trailer_key,
        tmdb_id,
        original_title,
        tmdb_imdb_id,
        collection_id,
        collection_name,
        title_pt,
        plot_pt,
        genres_pt,
        rated_pt,
    ) = if let Some(t) = tmdb {
        if status == EnrichmentStatus::Failed {
            status = EnrichmentStatus::Partial;
        }
        (
            t.backdrop_url,
            t.trailer_key,
            t.tmdb_id,
            t.original_title,
            t.imdb_id,
            t.collection_id,
            t.collection_name,
            t.title_pt,
            t.plot_pt,
            t.genres_pt,
            t.rated_pt,
        )
    } else {
        (
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Vec::new(),
            None,
        )
    };

    if status == EnrichmentStatus::Ok && (poster_url.is_none() || trailer_key.is_none()) {
        status = EnrichmentStatus::Partial;
    }

    EnrichedItem {
        id: input.id,
        title: input.title,
        original_title,
        year: input.year,
        content_type: input.content_type,
        origin: input.origin,
        director: input.director,
        creator: input.creator,
        curated_imdb_rating: input.curated_imdb_rating,
        poster_url,
        backdrop_url,
        plot,
        genres,
        runtime,
        actors,
        awards,
        rated,
        title_pt,
        plot_pt,
        genres_pt,
        rated_pt,
        imdb_rating,
        imdb_votes,
        rotten_tomatoes,
        metacritic,
        imdb_id: imdb_id.or(tmdb_imdb_id),
        tmdb_id,
        collection_id,
        collection_name,
        trailer_key,
        enrichment_status: status,
        torrent_file: None,
        s3_key: None,
        s3_keys: Vec::new(),
        subtitles: Vec::new(),
        episodes: Vec::new(),
        keywords: Vec::new(),
        award_entries: Vec::new(),
        trailer_s3_key: None,
        trailer_subtitles: Vec::new(),
        attachments: Vec::new(),
        poster_s3_key: None,
    }
}
