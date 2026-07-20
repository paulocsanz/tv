use axum::{
    extract::{Extension, Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::path::PathBuf;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tv_backend::audit;
use tv_backend::auth::{self, UserRecord};
use tv_backend::models::{
    AwardEntry, CollectionParts, ContentType, EnrichedCache, EnrichedItem, EpisodeMetadata,
    RelatedTitle, SimilarEntry, SubtitleTrack,
};
use tv_backend::progress;

struct S3Config {
    client: aws_sdk_s3::Client,
    bucket: String,
}

struct AppState {
    items: Vec<EnrichedItem>,
    db: PgPool,
    s3: Option<S3Config>,
    /// item id -> ranked TMDB recommendations, in or out of the catalog.
    /// See backfill-similar.js.
    similar: HashMap<String, Vec<SimilarEntry>>,
    /// TMDB collection id (as a string key) -> that franchise's full movie
    /// list, in or out of the catalog. See backfill-collection-parts.js.
    collection_parts: HashMap<String, CollectionParts>,
}

async fn connect_db(database_url: &str) -> PgPool {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(10))
            .connect(database_url)
            .await
        {
            Ok(pool) => return pool,
            Err(e) if attempt < 10 => {
                tracing::warn!(
                    "database connection attempt {attempt} failed: {e} - retrying in 2s"
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => panic!("failed to connect to database after {attempt} attempts: {e}"),
        }
    }
}

fn load_s3_config() -> Option<S3Config> {
    let access_key = std::env::var("AWS_ACCESS_KEY_ID").ok()?;
    let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY").ok()?;
    let endpoint = std::env::var("AWS_ENDPOINT_URL").ok()?;
    let bucket = std::env::var("AWS_S3_BUCKET_NAME").ok()?;
    let region = std::env::var("AWS_DEFAULT_REGION").unwrap_or_else(|_| "auto".to_string());

    let credentials =
        aws_sdk_s3::config::Credentials::new(access_key, secret_key, None, None, "railway-bucket");
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .region(aws_sdk_s3::config::Region::new(region))
        .endpoint_url(endpoint)
        .credentials_provider(credentials)
        .force_path_style(false)
        .build();

    Some(S3Config {
        client: aws_sdk_s3::Client::from_conf(config),
        bucket,
    })
}

fn effective_rating(item: &EnrichedItem) -> f64 {
    item.imdb_rating.unwrap_or(item.curated_imdb_rating)
}

// `year` is the only date-like field the catalog tracks (see models.rs) -
// no month/day, so this only catches strictly-future years, not "released
// earlier this year." The s3_key/s3_keys check is a safety net: if a
// playable file actually exists, it's demonstrably available no matter
// what the future-dated metadata says.
fn is_unreleased(item: &EnrichedItem, current_year: i32) -> bool {
    item.year > current_year && item.s3_key.is_none() && item.s3_keys.is_empty()
}

// total_cmp, not partial_cmp().unwrap() - see the comment on top_n for why.
// Unreleased matches (only reachable via search - get_content drops them
// from unfiltered browsing before this ever runs) always sort after every
// released match regardless of `sort` - they're the least relevant result
// by definition, since there's nothing to actually watch yet. Within that
// group (and within the released group) the chosen `sort` still applies,
// so a better match by that heuristic still ranks first relative to its
// own group.
fn sort_content(items: &mut [&EnrichedItem], sort: Option<&str>, current_year: i32) {
    items.sort_by(|a, b| {
        is_unreleased(a, current_year)
            .cmp(&is_unreleased(b, current_year))
            .then_with(|| match sort.unwrap_or("rating_desc") {
                "rating_asc" => effective_rating(a).total_cmp(&effective_rating(b)),
                "year_desc" => b.year.cmp(&a.year),
                "year_asc" => a.year.cmp(&b.year),
                "title_asc" => a.title.cmp(&b.title),
                _ => effective_rating(b).total_cmp(&effective_rating(a)),
            })
    });
}

#[derive(Debug, Deserialize)]
struct CollectionBackfill {
    collection_id: i64,
    collection_name: String,
}

/// Merges in TMDB collection membership for items enriched before that field
/// existed, from a side file (see backfill-collections.js at the repo root).
/// Kept separate from enriched_400.json because that file is written to
/// continuously by the download pipeline - overwriting it here risks
/// clobbering in-flight torrent/upload state.
fn apply_collections_backfill(items: &mut [EnrichedItem], enriched_data_path: &str) {
    let Some(backfill_path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join("collections_backfill.json"))
    else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&backfill_path) else {
        return;
    };
    let map: HashMap<String, CollectionBackfill> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", backfill_path.display());
            return;
        }
    };

    let mut applied = 0;
    for item in items.iter_mut() {
        if item.collection_id.is_none() {
            if let Some(c) = map.get(&item.id) {
                item.collection_id = Some(c.collection_id);
                item.collection_name = Some(c.collection_name.clone());
                applied += 1;
            }
        }
    }
    tracing::info!(
        "Applied collection backfill to {applied} items from {}",
        backfill_path.display()
    );
}

/// Merges in TMDB episode titles/overviews/thumbnails for already-downloaded
/// TV episodes, from a side file (see backfill-episode-metadata.js). Same
/// separate-file rationale as `apply_collections_backfill`. Re-run that
/// script after the download pipeline adds episodes to a show that isn't
/// covered yet - this only fills in what's here at load time.
fn apply_episode_metadata_backfill(items: &mut [EnrichedItem], enriched_data_path: &str) {
    let Some(backfill_path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join("episode_metadata_backfill.json"))
    else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&backfill_path) else {
        return;
    };
    let map: HashMap<String, Vec<EpisodeMetadata>> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", backfill_path.display());
            return;
        }
    };

    let mut applied = 0;
    for item in items.iter_mut() {
        if item.episodes.is_empty() {
            if let Some(eps) = map.get(&item.id) {
                item.episodes = eps.clone();
                applied += 1;
            }
        }
    }
    tracing::info!(
        "Applied episode metadata backfill to {applied} items from {}",
        backfill_path.display()
    );
}

/// Merges in TMDB thematic keywords (see backfill-keywords.js). Same
/// separate-file rationale as `apply_collections_backfill`.
fn apply_keywords_backfill(items: &mut [EnrichedItem], enriched_data_path: &str) {
    let Some(backfill_path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join("keywords_backfill.json"))
    else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&backfill_path) else {
        return;
    };
    let map: HashMap<String, Vec<String>> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", backfill_path.display());
            return;
        }
    };

    let mut applied = 0;
    for item in items.iter_mut() {
        if item.keywords.is_empty() {
            if let Some(kw) = map.get(&item.id) {
                item.keywords = kw.clone();
                applied += 1;
            }
        }
    }
    tracing::info!(
        "Applied keywords backfill to {applied} items from {}",
        backfill_path.display()
    );
}

/// Merges in structured award/festival nominations (see resolve-oscars.js
/// and generate-awards-backfill.js). Same separate-file rationale as
/// `apply_collections_backfill`. Only Academy Awards Best Picture data is
/// populated today, but the shape is generic - a future event (Cannes,
/// etc.) is just more rows in the same backfill file, no code change.
fn apply_awards_backfill(items: &mut [EnrichedItem], enriched_data_path: &str) {
    let Some(backfill_path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join("awards_backfill.json"))
    else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&backfill_path) else {
        return;
    };
    let map: HashMap<String, Vec<AwardEntry>> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", backfill_path.display());
            return;
        }
    };

    let mut applied = 0;
    for item in items.iter_mut() {
        if item.award_entries.is_empty() {
            if let Some(awards) = map.get(&item.id) {
                item.award_entries = awards.clone();
                applied += 1;
            }
        }
    }
    tracing::info!(
        "Applied awards backfill to {applied} items from {}",
        backfill_path.display()
    );
}

#[derive(Debug, Deserialize)]
struct TrailerSubtitleEntry {
    lang: String,
    label: String,
    s3_key: String,
}

#[derive(Debug, Deserialize)]
struct TrailerBackfillEntry {
    s3_key: String,
    #[serde(default)]
    subtitles: Vec<TrailerSubtitleEntry>,
}

/// Merges in self-hosted trailer video/captions (see download-trailers.js).
/// Same separate-file rationale as `apply_collections_backfill`. The
/// backfill file's subtitle entries are a slimmer shape than the shared
/// `SubtitleTrack` struct (no `episode`/`id` - neither is meaningful for a
/// trailer), so this constructs full `SubtitleTrack` values here rather
/// than widening that struct's required fields for every other caller.
fn apply_trailer_backfill(items: &mut [EnrichedItem], enriched_data_path: &str) {
    let Some(backfill_path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join("trailer_backfill.json"))
    else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&backfill_path) else {
        return;
    };
    let map: HashMap<String, TrailerBackfillEntry> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", backfill_path.display());
            return;
        }
    };

    let mut applied = 0;
    for item in items.iter_mut() {
        if item.trailer_s3_key.is_none() {
            if let Some(entry) = map.get(&item.id) {
                item.trailer_s3_key = Some(entry.s3_key.clone());
                item.trailer_subtitles = entry
                    .subtitles
                    .iter()
                    .map(|s| SubtitleTrack {
                        episode: 0,
                        id: s.lang.clone(),
                        lang: s.lang.clone(),
                        label: s.label.clone(),
                        forced: false,
                        s3_key: s.s3_key.clone(),
                    })
                    .collect();
                applied += 1;
            }
        }
    }
    tracing::info!(
        "Applied trailer backfill to {applied} items from {}",
        backfill_path.display()
    );
}

/// Loads a side file sitting next to enriched_400.json into a HashMap,
/// tolerating a missing or unparsable file (logs and returns empty) - these
/// backfills are all best-effort enhancements, never required to boot.
fn load_side_file<T: serde::de::DeserializeOwned>(
    enriched_data_path: &str,
    filename: &str,
) -> HashMap<String, T> {
    let Some(path) = std::path::Path::new(enriched_data_path)
        .parent()
        .map(|p| p.join(filename))
    else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    match serde_json::from_str(&raw) {
        Ok(m) => {
            tracing::info!("Loaded {}", path.display());
            m
        }
        Err(e) => {
            tracing::warn!("failed to parse {}: {e}", path.display());
            HashMap::new()
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let data_path =
        std::env::var("ENRICHED_DATA_PATH").unwrap_or_else(|_| "data/enriched_400.json".to_string());
    let raw = std::fs::read_to_string(&data_path)
        .unwrap_or_else(|e| panic!("failed to read enriched data at {data_path}: {e}"));
    let mut cache: EnrichedCache = serde_json::from_str(&raw).expect("invalid enriched data JSON");
    apply_collections_backfill(&mut cache.items, &data_path);
    apply_episode_metadata_backfill(&mut cache.items, &data_path);
    apply_keywords_backfill(&mut cache.items, &data_path);
    apply_awards_backfill(&mut cache.items, &data_path);
    apply_trailer_backfill(&mut cache.items, &data_path);
    let similar: HashMap<String, Vec<SimilarEntry>> =
        load_side_file(&data_path, "similar_backfill.json");
    let collection_parts: HashMap<String, CollectionParts> =
        load_side_file(&data_path, "collection_parts.json");

    tracing::info!("Loaded {} items from {}", cache.items.len(), data_path);

    let database_url = std::env::var("DATABASE_URL").expect(
        "DATABASE_URL must be set - the account system and watch progress require Postgres",
    );

    let db = connect_db(&database_url).await;
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .expect("failed to run database migrations");

    if let (Ok(username), Ok(password)) = (
        std::env::var("ADMIN_USERNAME"),
        std::env::var("ADMIN_PASSWORD"),
    ) {
        auth::seed_admin(&db, &username, &password)
            .await
            .expect("failed to seed admin account");
        tracing::info!(username = %username, "Seeded admin account from ADMIN_USERNAME/ADMIN_PASSWORD (no-op if it already exists)");
    }

    let s3 = load_s3_config();
    if s3.is_none() {
        tracing::warn!(
            "S3 bucket credentials not set (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_ENDPOINT_URL/AWS_S3_BUCKET_NAME) - /stream endpoint disabled"
        );
    }

    let state = Arc::new(AppState {
        items: cache.items,
        db,
        s3,
        similar,
        collection_parts,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let public_routes = Router::new()
        .route("/health", get(health))
        .route("/api/login", post(login))
        .route("/api/signup", post(signup_handler))
        .route("/api/tv/pair/start", post(tv_pair_start_handler))
        .route("/api/tv/pair/poll", get(tv_pair_poll_handler));

    let protected_routes = Router::new()
        .route("/api/meta", get(get_meta))
        .route("/api/sections", get(get_sections))
        .route("/api/content", get(get_content))
        .route("/api/content/:id", get(get_content_by_id))
        .route("/api/content/:id/related", get(get_related_content))
        .route("/api/content/:id/similar", get(get_similar_content))
        .route("/api/content/:id/torrent", get(get_torrent_file))
        .route("/api/content/:id/stream", get(get_stream_url))
        .route("/api/content/:id/attachment/:index", get(get_attachment_url))
        .route("/api/content/:id/subtitles/:track_id", get(get_subtitle_content))
        .route("/api/content/:id/trailer-stream", get(get_trailer_stream_url))
        .route("/api/content/:id/poster", get(get_poster_url))
        .route(
            "/api/content/:id/trailer-subtitles/:track_id",
            get(get_trailer_subtitle_content),
        )
        .route("/api/content/:id/progress", get(get_progress_handler).post(post_progress_handler))
        .route("/api/continue-watching", get(get_continue_watching))
        .route("/api/logout", post(logout))
        .route("/api/me", get(get_me))
        .route("/api/admin/users", get(list_users_handler).post(create_user_handler))
        .route("/api/admin/pipeline", get(get_pipeline_status_handler))
        .route("/api/admin/invites", post(create_invite_handler))
        .route("/api/tv/pair/claim", post(tv_pair_claim_handler))
        .route("/api/admin/catalog", get(get_catalog_review_handler))
        .route("/api/admin/catalog/:id/research", post(retrigger_torrent_search_handler))
        .route("/api/account/password", post(change_password_handler))
        .route("/api/account/preferences", post(update_preferences_handler))
        .route("/api/usage-summary", get(usage_summary_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let app = Router::new()
        .merge(public_routes)
        .merge(protected_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("Listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
}

async fn login(State(state): State<Arc<AppState>>, Json(body): Json<LoginRequest>) -> impl IntoResponse {
    let Some(user) = auth::verify_login(&state.db, &body.username, &body.password).await else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid username or password" })),
        )
            .into_response();
    };

    match auth::create_session(&state.db, user.id).await {
        Ok(token) => Json(LoginResponse { token }).into_response(),
        Err(e) => {
            tracing::error!("failed to create session: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = bearer_token(&headers) {
        auth::revoke_session(&state.db, token).await;
    }
    StatusCode::NO_CONTENT
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn require_auth(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let user = match bearer_token(req.headers()) {
        Some(token) => auth::session_user(&state.db, token).await,
        None => None,
    };

    match user {
        Some(user) => {
            req.extensions_mut().insert(user);
            Ok(next.run(req).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

#[derive(Serialize)]
struct MetaResponse {
    total: usize,
    movies: usize,
    tv_series: usize,
    courses: usize,
    brazilian: usize,
    international: usize,
    genres: Vec<String>,
    /// Thematic keywords shared by at least a few titles - most TMDB
    /// keywords are one-offs and would make a useless, noisy filter list,
    /// so those are left out (a title can still carry them; they just
    /// aren't offered as a browse filter).
    keywords: Vec<String>,
    year_min: i32,
    year_max: i32,
}

/// Keywords appearing on fewer titles than this are too obscure to be a
/// useful browse filter (most TMDB keywords are one-offs).
const MIN_KEYWORD_FREQUENCY: usize = 5;

async fn get_meta(State(state): State<Arc<AppState>>) -> Json<MetaResponse> {
    let items = &state.items;
    let mut genres: Vec<String> = items
        .iter()
        .flat_map(|i| i.genres.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    genres.sort();

    let mut keyword_counts: HashMap<String, usize> = HashMap::new();
    for keyword in items.iter().flat_map(|i| i.keywords.iter()) {
        *keyword_counts.entry(keyword.clone()).or_insert(0) += 1;
    }
    let mut keywords: Vec<String> = keyword_counts
        .into_iter()
        .filter(|(_, count)| *count >= MIN_KEYWORD_FREQUENCY)
        .map(|(keyword, _)| keyword)
        .collect();
    keywords.sort();

    let year_min = items.iter().map(|i| i.year).min().unwrap_or(0);
    let year_max = items.iter().map(|i| i.year).max().unwrap_or(0);

    Json(MetaResponse {
        total: items.len(),
        movies: items
            .iter()
            .filter(|i| i.content_type == ContentType::Movie)
            .count(),
        tv_series: items
            .iter()
            .filter(|i| i.content_type == ContentType::Tv)
            .count(),
        courses: items
            .iter()
            .filter(|i| i.content_type == ContentType::Course)
            .count(),
        brazilian: items.iter().filter(|i| i.origin == "Brazilian").count(),
        international: items.iter().filter(|i| i.origin == "International").count(),
        genres,
        keywords,
        year_min,
        year_max,
    })
}

#[derive(Serialize)]
struct Section {
    key: String,
    title: String,
    items: Vec<EnrichedItem>,
}

fn top_n<'a>(mut items: Vec<&'a EnrichedItem>, n: usize) -> Vec<&'a EnrichedItem> {
    // total_cmp, not partial_cmp().unwrap() - imdb_rating is parsed from an
    // external OMDb string (enrichment.rs), and f64::parse happily accepts
    // "NaN" as valid input. partial_cmp returns None for NaN, which would
    // panic here; total_cmp gives NaN a well-defined (if arbitrary) place in
    // the order instead of crashing every request that hits a bad rating.
    items.sort_by(|a, b| effective_rating(b).total_cmp(&effective_rating(a)));
    items.truncate(n);
    items
}

async fn get_sections(State(state): State<Arc<AppState>>) -> Json<Vec<Section>> {
    let current_year = chrono::Utc::now().year();
    // Homepage sections are pure browsing, never a search - unreleased
    // titles (see is_unreleased) only earn a place once someone actually
    // looks for them, so they're dropped from the shared pool every
    // section below is built from.
    let items: Vec<&EnrichedItem> = state
        .items
        .iter()
        .filter(|i| !is_unreleased(i, current_year))
        .collect();
    let clone_items = |v: Vec<&EnrichedItem>| v.into_iter().cloned().collect::<Vec<_>>();

    let featured = top_n(items.to_vec(), 12);

    let brazilian_movies = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.origin == "Brazilian" && i.content_type == ContentType::Movie)
            .collect(),
        18,
    );
    let brazilian_tv = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.origin == "Brazilian" && i.content_type == ContentType::Tv)
            .collect(),
        18,
    );
    let international_classics = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.origin == "International" && i.year <= 1980)
            .collect(),
        18,
    );
    let modern_hits = top_n(items.iter().copied().filter(|i| i.year >= 2015).collect(), 18);
    let top_tv = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.content_type == ContentType::Tv)
            .collect(),
        18,
    );
    let top_movies = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.content_type == ContentType::Movie)
            .collect(),
        18,
    );
    let hidden_gems = top_n(
        items
            .iter()
            .copied()
            .filter(|i| {
                let r = effective_rating(i);
                (7.0..8.3).contains(&r)
            })
            .collect(),
        18,
    );
    let best_picture = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.award_entries.iter().any(|a| a.category == "Best Picture"))
            .collect(),
        18,
    );
    let courses = top_n(
        items
            .iter()
            .copied()
            .filter(|i| i.content_type == ContentType::Course)
            .collect(),
        18,
    );

    let sections = vec![
        Section {
            key: "featured".into(),
            title: "Featured".into(),
            items: clone_items(featured),
        },
        Section {
            key: "top_movies".into(),
            title: "Top Rated Movies".into(),
            items: clone_items(top_movies),
        },
        Section {
            key: "top_tv".into(),
            title: "Top Rated TV Series".into(),
            items: clone_items(top_tv),
        },
        Section {
            key: "courses".into(),
            title: "Courses".into(),
            items: clone_items(courses),
        },
        Section {
            key: "brazilian_movies".into(),
            title: "Brazilian Cinema".into(),
            items: clone_items(brazilian_movies),
        },
        Section {
            key: "brazilian_tv".into(),
            title: "Brazilian TV Series".into(),
            items: clone_items(brazilian_tv),
        },
        Section {
            key: "international_classics".into(),
            title: "International Classics".into(),
            items: clone_items(international_classics),
        },
        Section {
            key: "modern_hits".into(),
            title: "Modern Hits (2015+)".into(),
            items: clone_items(modern_hits),
        },
        Section {
            key: "hidden_gems".into(),
            title: "Hidden Gems".into(),
            items: clone_items(hidden_gems),
        },
        Section {
            key: "best_picture".into(),
            title: "Best Picture Winners & Nominees".into(),
            items: clone_items(best_picture),
        },
    ];

    Json(sections)
}

#[derive(Deserialize)]
struct ContentQuery {
    #[serde(rename = "type")]
    content_type: Option<String>,
    origin: Option<String>,
    search: Option<String>,
    min_rating: Option<f64>,
    genre: Option<String>,
    keyword: Option<String>,
    /// Filter to items with an award_entries row in this category, e.g.
    /// "Best Picture" - matches any event (currently just "Academy Awards").
    award_category: Option<String>,
    /// When true (and combined with award_category), only items that WON in
    /// that category - otherwise nominees and winners are both included.
    award_won: Option<bool>,
    decade: Option<i32>,
    sort: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
}

#[derive(Serialize)]
struct ContentResponse {
    items: Vec<EnrichedItem>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
}

async fn get_content(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ContentQuery>,
) -> Json<ContentResponse> {
    let mut filtered: Vec<&EnrichedItem> = state.items.iter().collect();

    if let Some(ct) = &q.content_type {
        let want = match ct.to_lowercase().as_str() {
            "movie" => Some(ContentType::Movie),
            "tv" => Some(ContentType::Tv),
            "course" => Some(ContentType::Course),
            _ => None,
        };
        if let Some(want) = want {
            filtered.retain(|i| i.content_type == want);
        }
    }

    if let Some(origin) = &q.origin {
        filtered.retain(|i| i.origin.eq_ignore_ascii_case(origin));
    }

    if let Some(search) = &q.search {
        let search_lower = search.to_lowercase();
        filtered.retain(|i| {
            i.title.to_lowercase().contains(&search_lower)
                || i.original_title
                    .as_deref()
                    .map(|t| t.to_lowercase().contains(&search_lower))
                    .unwrap_or(false)
                || i.director
                    .as_deref()
                    .map(|d| d.to_lowercase().contains(&search_lower))
                    .unwrap_or(false)
                || i.creator
                    .as_deref()
                    .map(|c| c.to_lowercase().contains(&search_lower))
                    .unwrap_or(false)
                || i.actors.iter().any(|a| a.to_lowercase().contains(&search_lower))
        });
    }

    if let Some(min_rating) = q.min_rating {
        filtered.retain(|i| effective_rating(i) >= min_rating);
    }

    if let Some(genre) = &q.genre {
        filtered.retain(|i| i.genres.iter().any(|g| g.eq_ignore_ascii_case(genre)));
    }

    if let Some(keyword) = &q.keyword {
        filtered.retain(|i| i.keywords.iter().any(|k| k.eq_ignore_ascii_case(keyword)));
    }

    if let Some(category) = &q.award_category {
        let won_only = q.award_won.unwrap_or(false);
        filtered.retain(|i| {
            i.award_entries
                .iter()
                .any(|a| a.category.eq_ignore_ascii_case(category) && (!won_only || a.won))
        });
    }

    if let Some(decade) = q.decade {
        filtered.retain(|i| i.year >= decade && i.year < decade + 10);
    }

    let current_year = chrono::Utc::now().year();
    if q.search.is_none() {
        // Undirected browsing (no search term) never surfaces unreleased
        // titles - they only earn a place once someone actually looks for
        // them by name, via the sort tie-break in sort_content below.
        filtered.retain(|i| !is_unreleased(i, current_year));
    }

    sort_content(&mut filtered, q.sort.as_deref(), current_year);

    let total = filtered.len();
    let page_size = q.page_size.unwrap_or(24).clamp(1, 100);
    let page = q.page.unwrap_or(1).max(1);
    let total_pages = total.div_ceil(page_size).max(1);
    let start = (page - 1) * page_size;
    let page_items: Vec<EnrichedItem> = filtered
        .into_iter()
        .skip(start)
        .take(page_size)
        .cloned()
        .collect();

    Json(ContentResponse {
        items: page_items,
        total,
        page,
        page_size,
        total_pages,
    })
}

async fn get_content_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.items.iter().find(|i| i.id == id) {
        Some(item) => Json(item.clone()).into_response(),
        None => (StatusCode::NOT_FOUND, "content not found").into_response(),
    }
}

/// Builds a `RelatedTitle` for a TMDB (tmdb_id, content_type) pair, preferring
/// the catalog's own data (and a clickable `id`) when we happen to have that
/// title, falling back to the raw TMDB fields (no `id` - nothing to stream)
/// otherwise.
fn resolve_related_title(
    state: &AppState,
    tmdb_id: i64,
    content_type: ContentType,
    title: String,
    year: Option<i32>,
    poster_url: Option<String>,
    rating: Option<f64>,
) -> RelatedTitle {
    let catalog_item = state
        .items
        .iter()
        .find(|i| i.tmdb_id == Some(tmdb_id) && i.content_type == content_type);

    match catalog_item {
        Some(i) => RelatedTitle {
            id: Some(i.id.clone()),
            tmdb_id,
            title: i.title.clone(),
            year: Some(i.year),
            poster_url: i.poster_url.clone(),
            content_type: i.content_type.clone(),
            rating: Some(effective_rating(i)),
        },
        None => RelatedTitle {
            id: None,
            tmdb_id,
            title,
            year,
            poster_url,
            content_type,
            rating,
        },
    }
}

async fn get_related_content(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let Some(collection_id) = item.collection_id else {
        return Json(Vec::<RelatedTitle>::new()).into_response();
    };

    let mut related: Vec<RelatedTitle> = match state.collection_parts.get(&collection_id.to_string()) {
        Some(parts) => parts
            .parts
            .iter()
            .map(|p| {
                resolve_related_title(
                    &state,
                    p.tmdb_id,
                    ContentType::Movie,
                    p.title.clone(),
                    p.year,
                    p.poster_url.clone(),
                    p.rating,
                )
            })
            .collect(),
        // Full collection membership hasn't been backfilled yet - fall back
        // to whatever catalog items happen to point at this collection_id,
        // so the row (at least featuring this item) still renders.
        None => state
            .items
            .iter()
            .filter(|i| i.collection_id == Some(collection_id))
            .filter_map(|i| {
                i.tmdb_id.map(|tmdb_id| {
                    resolve_related_title(
                        &state,
                        tmdb_id,
                        i.content_type.clone(),
                        i.title.clone(),
                        Some(i.year),
                        i.poster_url.clone(),
                        Some(effective_rating(i)),
                    )
                })
            })
            .collect(),
    };
    related.sort_by(|a, b| a.year.cmp(&b.year));

    Json(related).into_response()
}

async fn get_similar_content(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let Some(entries) = state.similar.get(&id) else {
        return Json(Vec::<RelatedTitle>::new()).into_response();
    };

    // Skip anything already surfaced by the collection (sequels/prequels)
    // row, so the two sections don't repeat the same poster.
    let collection_tmdb_ids: Vec<i64> = item
        .collection_id
        .and_then(|collection_id| state.collection_parts.get(&collection_id.to_string()))
        .map(|parts| parts.parts.iter().map(|p| p.tmdb_id).collect())
        .unwrap_or_default();

    let similar: Vec<RelatedTitle> = entries
        .iter()
        .filter(|e| {
            Some(e.tmdb_id) != item.tmdb_id && !collection_tmdb_ids.contains(&e.tmdb_id)
        })
        .map(|e| {
            resolve_related_title(
                &state,
                e.tmdb_id,
                e.content_type.clone(),
                e.title.clone(),
                e.year,
                e.poster_url.clone(),
                e.rating,
            )
        })
        .collect();

    Json(similar).into_response()
}

async fn get_torrent_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.items.iter().find(|i| i.id == id) {
        Some(item) => {
            match &item.torrent_file {
                Some(torrent_filename) => {
                    let full_filename = format!("{}.torrent", torrent_filename);
                    let torrent_path = PathBuf::from("downloads").join(&full_filename);
                    match std::fs::read(&torrent_path) {
                        Ok(content) => {
                            let headers = [
                                (header::CONTENT_TYPE, "application/x-torrent"),
                                (
                                    header::CONTENT_DISPOSITION,
                                    &format!("attachment; filename=\"{}\"", full_filename),
                                ),
                            ];
                            (StatusCode::OK, headers, content).into_response()
                        }
                        Err(_) => (StatusCode::NOT_FOUND, "torrent file not found").into_response(),
                    }
                }
                None => (StatusCode::BAD_REQUEST, "no torrent file for this content").into_response(),
            }
        }
        None => (StatusCode::NOT_FOUND, "content not found").into_response(),
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    episode: Option<usize>,
}

async fn get_stream_url(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<StreamQuery>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "video storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let key = if !item.s3_keys.is_empty() {
        let episode = q.episode.unwrap_or(1);
        match episode.checked_sub(1).and_then(|i| item.s3_keys.get(i)) {
            Some(key) => key,
            None => return (StatusCode::NOT_FOUND, "episode not found").into_response(),
        }
    } else {
        match &item.s3_key {
            Some(key) => key,
            None => {
                return (StatusCode::NOT_FOUND, "no video available for this content")
                    .into_response()
            }
        }
    };

    let presign_config =
        match aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(4 * 3600)) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("failed to build presigning config: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "failed to build stream url")
                    .into_response();
            }
        };

    match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(key)
        .presigned(presign_config)
        .await
    {
        Ok(presigned) => Redirect::temporary(presigned.uri()).into_response(),
        Err(e) => {
            tracing::error!("failed to presign stream url: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build stream url").into_response()
        }
    }
}

// Same presigned-redirect shape as get_stream_url, indexed into
// `attachments` instead of `s3_keys` - course extras (PDFs, spreadsheets)
// aren't video, so they don't go through the episode-numbered stream path.
async fn get_attachment_url(
    State(state): State<Arc<AppState>>,
    Path((id, index)): Path<(String, usize)>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let Some(attachment) = item.attachments.get(index) else {
        return (StatusCode::NOT_FOUND, "attachment not found").into_response();
    };

    let presign_config =
        match aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(4 * 3600)) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("failed to build presigning config: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "failed to build attachment url")
                    .into_response();
            }
        };

    match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(&attachment.s3_key)
        .presigned(presign_config)
        .await
    {
        Ok(presigned) => Redirect::temporary(presigned.uri()).into_response(),
        Err(e) => {
            tracing::error!("failed to presign attachment url: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build attachment url").into_response()
        }
    }
}

#[derive(Deserialize)]
struct SubtitleQuery {
    episode: Option<i32>,
}

// Proxies the WebVTT bytes directly rather than a presigned redirect like
// get_stream_url - subtitle files are KB-sized (unlike video, no benefit to
// a range-request-capable redirect), and a <track> element's fetch is
// subject to CORS, which the bucket has no config for. Serving it from this
// same origin sidesteps that entirely.
async fn get_subtitle_content(
    State(state): State<Arc<AppState>>,
    Path((id, track_id)): Path<(String, String)>,
    Query(q): Query<SubtitleQuery>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "video storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let episode = q.episode.unwrap_or(0);
    let Some(track) = item
        .subtitles
        .iter()
        .find(|t| t.id == track_id && t.episode == episode)
    else {
        return (StatusCode::NOT_FOUND, "subtitle track not found").into_response();
    };

    let object = match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(&track.s3_key)
        .send()
        .await
    {
        Ok(object) => object,
        Err(e) => {
            tracing::error!("failed to fetch subtitle object: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "failed to fetch subtitle").into_response();
        }
    };

    match object.body.collect().await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/vtt; charset=utf-8")],
            bytes.into_bytes().to_vec(),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("failed to read subtitle body: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to read subtitle").into_response()
        }
    }
}

// Same presigned-redirect shape as get_stream_url - no episode query, a
// trailer is one file per item, not per-episode.
async fn get_trailer_stream_url(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "video storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    // 404, not 503 like get_stream_url's missing-config case - "no
    // self-hosted trailer downloaded yet" is an expected, common state
    // while download-trailers.js works through the catalog, not a config
    // error. The frontend falls back to the YouTube iframe on a 404 here.
    let Some(key) = &item.trailer_s3_key else {
        return (StatusCode::NOT_FOUND, "no self-hosted trailer for this content").into_response();
    };

    let presign_config =
        match aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(4 * 3600)) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("failed to build presigning config: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "failed to build stream url")
                    .into_response();
            }
        };

    match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(key)
        .presigned(presign_config)
        .await
    {
        Ok(presigned) => Redirect::temporary(presigned.uri()).into_response(),
        Err(e) => {
            tracing::error!("failed to presign trailer stream url: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build stream url").into_response()
        }
    }
}

// Same presigned-redirect shape as get_trailer_stream_url - poster_s3_key
// is None until a poster's been generated (see extract-course-posters.mjs),
// so 404 rather than 503 lets the frontend fall back to poster_url's
// external link, matching the trailer fallback's own reasoning exactly.
async fn get_poster_url(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "image storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let Some(key) = &item.poster_s3_key else {
        return (StatusCode::NOT_FOUND, "no self-hosted poster for this content").into_response();
    };

    let presign_config =
        match aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(4 * 3600)) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("failed to build presigning config: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "failed to build poster url")
                    .into_response();
            }
        };

    match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(key)
        .presigned(presign_config)
        .await
    {
        Ok(presigned) => Redirect::temporary(presigned.uri()).into_response(),
        Err(e) => {
            tracing::error!("failed to presign poster url: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build poster url").into_response()
        }
    }
}

// Same direct-proxy rationale as get_subtitle_content (CORS - the bucket has
// no config for it, and these are tiny KB-sized files with no benefit to a
// range-request-capable redirect).
async fn get_trailer_subtitle_content(
    State(state): State<Arc<AppState>>,
    Path((id, track_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let Some(s3) = &state.s3 else {
        return (StatusCode::SERVICE_UNAVAILABLE, "video storage not configured").into_response();
    };

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    let Some(track) = item.trailer_subtitles.iter().find(|t| t.id == track_id) else {
        return (StatusCode::NOT_FOUND, "trailer subtitle track not found").into_response();
    };

    let object = match s3
        .client
        .get_object()
        .bucket(&s3.bucket)
        .key(&track.s3_key)
        .send()
        .await
    {
        Ok(object) => object,
        Err(e) => {
            tracing::error!("failed to fetch trailer subtitle object: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "failed to fetch subtitle").into_response();
        }
    };

    match object.body.collect().await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/vtt; charset=utf-8")],
            bytes.into_bytes().to_vec(),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("failed to read trailer subtitle body: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to read subtitle").into_response()
        }
    }
}

#[derive(Serialize)]
struct MeResponse {
    username: String,
    is_admin: bool,
    display_name: Option<String>,
    default_subtitle_lang: Option<String>,
    autoplay_next: bool,
    ui_locale: String,
}

async fn get_me(Extension(user): Extension<UserRecord>) -> Json<MeResponse> {
    Json(MeResponse {
        username: user.username,
        is_admin: user.is_admin,
        display_name: user.display_name,
        default_subtitle_lang: user.default_subtitle_lang,
        autoplay_next: user.autoplay_next,
        ui_locale: user.ui_locale,
    })
}

async fn list_users_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }
    match auth::list_users(&state.db).await {
        Ok(users) => Json(users).into_response(),
        Err(e) => {
            tracing::error!("failed to list users: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct CreateUserRequest {
    username: String,
    password: String,
}

async fn create_user_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Json(body): Json<CreateUserRequest>,
) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }

    match auth::create_user(&state.db, &body.username, &body.password, false).await {
        Ok(created) => (StatusCode::CREATED, Json(created)).into_response(),
        Err(auth::CreateUserError::UsernameTaken) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "username already taken" })),
        )
            .into_response(),
        Err(auth::CreateUserError::Database(e)) => {
            tracing::error!("failed to create user: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

async fn change_password_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Json(body): Json<ChangePasswordRequest>,
) -> impl IntoResponse {
    match auth::change_password(&state.db, user.id, &body.current_password, &body.new_password)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(auth::ChangePasswordError::WrongCurrentPassword) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "current password is incorrect" })),
        )
            .into_response(),
        Err(auth::ChangePasswordError::Database(e)) => {
            tracing::error!("failed to change password: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdatePreferencesRequest {
    display_name: Option<String>,
    default_subtitle_lang: Option<String>,
    autoplay_next: bool,
    #[serde(default)]
    ui_locale: Option<String>,
}

async fn update_preferences_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Json(body): Json<UpdatePreferencesRequest>,
) -> impl IntoResponse {
    let ui_locale = match body.ui_locale.as_deref() {
        Some("en") => "en",
        _ => "pt-BR",
    };
    match auth::update_preferences(
        &state.db,
        user.id,
        body.display_name.as_deref().filter(|s| !s.is_empty()),
        body.default_subtitle_lang.as_deref().filter(|s| !s.is_empty()),
        body.autoplay_next,
        ui_locale,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("failed to update preferences: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Any signed-in user can see the group's usage split (RFC 0001 P1) - it's
/// meant to inform an offline cost conversation among people who already
/// know each other, not a private admin metric.
async fn usage_summary_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match progress::usage_by_user(&state.db).await {
        Ok(usage) => Json(usage).into_response(),
        Err(e) => {
            tracing::error!("failed to compute usage summary: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Serialize)]
struct InviteResponse {
    token: String,
    expires_at: String,
}

async fn create_invite_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }

    match auth::create_invite(&state.db, user.id).await {
        Ok(invite) => Json(InviteResponse {
            token: invite.token,
            expires_at: invite.expires_at,
        })
        .into_response(),
        Err(e) => {
            tracing::error!("failed to create invite: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Serialize)]
struct TvPairStartResponse {
    code: String,
    poll_token: String,
    expires_at: String,
}

/// Public - the TV hasn't signed in yet at this point, that's the entire
/// premise of the pairing flow.
async fn tv_pair_start_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match auth::start_tv_pairing(&state.db).await {
        Ok(pairing) => Json(TvPairStartResponse {
            code: pairing.code,
            poll_token: pairing.poll_token,
            expires_at: pairing.expires_at,
        })
        .into_response(),
        Err(e) => {
            tracing::error!("failed to start tv pairing: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct TvPairPollQuery {
    poll_token: String,
}

/// Public - authenticated by possession of the poll token itself (mirrors
/// how a presigned URL or invite token is the credential), not a session,
/// since the TV has no session until this call succeeds.
async fn tv_pair_poll_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TvPairPollQuery>,
) -> impl IntoResponse {
    match auth::poll_tv_pairing(&state.db, &q.poll_token).await {
        Ok(None) => (
            StatusCode::GONE,
            Json(serde_json::json!({ "error": "pairing code expired or invalid" })),
        )
            .into_response(),
        Ok(Some(auth::PairingPollResult::Pending)) => StatusCode::ACCEPTED.into_response(),
        Ok(Some(auth::PairingPollResult::Claimed { token })) => {
            Json(LoginResponse { token }).into_response()
        }
        Err(e) => {
            tracing::error!("failed to poll tv pairing: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct TvPairClaimRequest {
    code: String,
}

async fn tv_pair_claim_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Json(body): Json<TvPairClaimRequest>,
) -> impl IntoResponse {
    match auth::claim_tv_pairing(&state.db, &body.code, user.id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(auth::ClaimPairingError::InvalidOrExpired) => (
            StatusCode::GONE,
            Json(serde_json::json!({ "error": "pairing code is invalid, expired, or already used" })),
        )
            .into_response(),
        Err(auth::ClaimPairingError::Database(e)) => {
            tracing::error!("failed to claim tv pairing: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct SignupRequest {
    token: String,
    username: String,
    password: String,
    display_name: Option<String>,
}

async fn signup_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SignupRequest>,
) -> impl IntoResponse {
    let user = match auth::redeem_invite(
        &state.db,
        &body.token,
        &body.username,
        &body.password,
        body.display_name.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    {
        Ok(user) => user,
        Err(auth::RedeemInviteError::InvalidOrExpired) => {
            return (
                StatusCode::GONE,
                Json(serde_json::json!({ "error": "invite link is invalid or expired" })),
            )
                .into_response()
        }
        Err(auth::RedeemInviteError::UsernameTaken) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "username already taken" })),
            )
                .into_response()
        }
        Err(auth::RedeemInviteError::Database(e)) => {
            tracing::error!("failed to redeem invite: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match auth::create_session(&state.db, user.id).await {
        Ok(token) => Json(LoginResponse { token }).into_response(),
        Err(e) => {
            tracing::error!("failed to create session after signup: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct ProgressUpdateRequest {
    episode: i32,
    position_seconds: f64,
    duration_seconds: Option<f64>,
}

async fn get_progress_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match progress::get_progress(&state.db, user.id, &id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::error!("failed to fetch progress: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn post_progress_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Path(id): Path<String>,
    Json(body): Json<ProgressUpdateRequest>,
) -> impl IntoResponse {
    match progress::upsert_progress(
        &state.db,
        user.id,
        &id,
        body.episode,
        body.position_seconds,
        body.duration_seconds,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("failed to save progress: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Serialize)]
struct ContinueWatchingItem {
    #[serde(flatten)]
    item: EnrichedItem,
    episode: i32,
    progress_fraction: f64,
}

fn pipeline_events_path() -> String {
    std::env::var("PIPELINE_EVENTS_PATH").unwrap_or_else(|_| "pipeline-events.jsonl".to_string())
}

fn pipeline_lock_path() -> String {
    std::env::var("PIPELINE_LOCK_PATH")
        .unwrap_or_else(|_| ".download-picked-torrents.lock".to_string())
}

/// Shells out to `ps` rather than pulling in a process-inspection crate -
/// this is a personal-project admin page, not something worth a new
/// dependency for. Only meaningful when the backend runs on the same
/// machine as the download pipeline (local dev); in a real deployment
/// there's no lock file to find and `running` is simply false.
fn pid_alive(pid: i32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Serialize, Default)]
struct PipelineStatusResponse {
    running: bool,
    lock_pid: Option<i32>,
    last_event: Option<serde_json::Value>,
    seconds_since_last_event: Option<i64>,
    current_run: Option<PipelineRunSummary>,
}

#[derive(Serialize)]
struct PipelineRunSummary {
    started_ts: i64,
    picked: i64,
    total: i64,
    done_this_run: usize,
    failed_this_run: usize,
}

/// Reads whatever the download pipeline has written to `pipeline-events.jsonl`
/// and the lock file next to it - see the `pipeline-status` Claude Code skill,
/// which this mirrors for the web admin UI (RFC 0003). Read-only; never
/// touches `enriched_400.json` itself, so it's safe to call while the
/// pipeline is running.
async fn get_pipeline_status_handler(Extension(user): Extension<UserRecord>) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }

    let lock_pid = pipeline_lock_pid();
    let running = lock_pid.map(pid_alive).unwrap_or(false);

    let Ok(raw) = std::fs::read_to_string(pipeline_events_path()) else {
        return Json(PipelineStatusResponse {
            running,
            lock_pid,
            ..Default::default()
        })
        .into_response();
    };

    let events: Vec<serde_json::Value> = raw
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    let last_event = events.last().cloned();
    let seconds_since_last_event = last_event
        .as_ref()
        .and_then(|e| e.get("ts"))
        .and_then(|v| v.as_i64())
        .map(|ts| (now_ms() - ts) / 1000);

    fn event_type(e: &serde_json::Value) -> Option<&str> {
        e.get("type").and_then(|v| v.as_str())
    }
    fn event_ts(e: &serde_json::Value) -> i64 {
        e.get("ts").and_then(|v| v.as_i64()).unwrap_or(0)
    }

    let last_start = events
        .iter()
        .rev()
        .find(|e| event_type(e) == Some("pipeline_start"));

    let current_run = last_start.map(|start| {
        let started_ts = event_ts(start);
        let picked = start.get("picked").and_then(|v| v.as_i64()).unwrap_or(0);
        let total = start.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
        let done_this_run = events
            .iter()
            .filter(|e| event_ts(e) >= started_ts && event_type(e) == Some("item_done"))
            .count();
        let failed_this_run = events
            .iter()
            .filter(|e| event_ts(e) >= started_ts && event_type(e) == Some("item_failed"))
            .count();
        PipelineRunSummary {
            started_ts,
            picked,
            total,
            done_this_run,
            failed_this_run,
        }
    });

    Json(PipelineStatusResponse {
        running,
        lock_pid,
        last_event,
        seconds_since_last_event,
        current_run,
    })
    .into_response()
}

#[derive(Serialize)]
struct CatalogGapItem {
    id: String,
    title: String,
    content_type: ContentType,
}

#[derive(Serialize)]
struct CatalogReviewResponse {
    no_torrent_options: Vec<CatalogGapItem>,
    recent_edits: Vec<audit::CatalogEditEntry>,
}

/// Replaces reading *-flagged.json/bloated-uploads.json off disk (RFC 0003
/// P1) - items with zero torrent options at either quality are exactly the
/// review queue those files were standing in for.
async fn get_catalog_review_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }

    let no_torrent_options: Vec<CatalogGapItem> = state
        .items
        .iter()
        .filter(|i| i.s3_key.is_none() && i.s3_keys.is_empty())
        .filter(|i| i.torrent_file.is_none())
        .map(|i| CatalogGapItem {
            id: i.id.clone(),
            title: i.title.clone(),
            content_type: i.content_type.clone(),
        })
        .collect();

    let recent_edits = match audit::recent_catalog_edits(&state.db, 50).await {
        Ok(edits) => edits,
        Err(e) => {
            tracing::error!("failed to fetch catalog edit log: {e}");
            Vec::new()
        }
    };

    Json(CatalogReviewResponse {
        no_torrent_options,
        recent_edits,
    })
    .into_response()
}

/// Re-runs the torrent picker for exactly one title (RFC 0003 P2) - the
/// same escape hatch `pick-best-torrents.js <quality> <title-filter>`
/// offers from the terminal, exposed as a button instead.
///
/// The pre-flight lock check below is just a fast-fail for the UI - it
/// can't close the race against the download pipeline starting *between*
/// this check and the child actually running (TOCTOU). The real protection
/// is that `pick-best-torrents.js` now acquires the same lock file itself
/// at startup, same as the pipeline does, so whichever of the two actually
/// gets there first wins and the other refuses to start. Belt and
/// suspenders: this check gives a fast, specific error instead of waiting
/// for the child to spawn and fail.
async fn retrigger_torrent_search_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !user.is_admin {
        return StatusCode::FORBIDDEN.into_response();
    }

    let Some(item) = state.items.iter().find(|i| i.id == id) else {
        return (StatusCode::NOT_FOUND, "content not found").into_response();
    };

    if pipeline_lock_pid().is_some_and(pid_alive) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "the download pipeline is currently running - stop it first, \
                          re-running the torrent picker at the same time would corrupt \
                          enriched_400.json"
            })),
        )
            .into_response();
    }

    let project_root = std::env::var("PROJECT_ROOT").unwrap_or_else(|_| ".".to_string());
    let child = tokio::process::Command::new("node")
        .arg("pick-best-torrents.js")
        .arg("720p")
        .arg(&item.title)
        .current_dir(&project_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Kills the child if the timeout below drops this future before it
        // resolves - otherwise a hung `node` process (the exact failure mode
        // the pipeline itself hit earlier tonight) would outlive the request
        // and keep the lock file held indefinitely.
        .kill_on_drop(true)
        .spawn();

    let output = match child {
        Ok(child) => {
            match tokio::time::timeout(std::time::Duration::from_secs(90), child.wait_with_output())
                .await
            {
                Ok(result) => result,
                Err(_) => {
                    tracing::error!("pick-best-torrents.js timed out after 90s for {id}");
                    return (StatusCode::GATEWAY_TIMEOUT, "torrent search timed out after 90s")
                        .into_response();
                }
            }
        }
        Err(e) => Err(e),
    };

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let found = stdout.contains("✓");
            let detail = if found { "found new options" } else { "no options found" };
            if let Err(e) =
                audit::log_catalog_edit(&state.db, user.id, &id, "retrigger_torrent_search", Some(detail))
                    .await
            {
                tracing::error!("failed to log catalog edit: {e}");
            }
            Json(serde_json::json!({ "found": found })).into_response()
        }
        Ok(out) => {
            tracing::error!(
                "pick-best-torrents.js exited non-zero: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "torrent search failed").into_response()
        }
        Err(e) => {
            tracing::error!("failed to spawn pick-best-torrents.js: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "couldn't run the torrent picker here (needs Node + this project's root on the \
                 same machine as the backend)",
            )
                .into_response()
        }
    }
}

fn pipeline_lock_pid() -> Option<i32> {
    std::fs::read_to_string(pipeline_lock_path())
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

async fn get_continue_watching(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<UserRecord>,
) -> impl IntoResponse {
    match progress::continue_watching(&state.db, user.id).await {
        Ok(rows) => {
            let items: Vec<ContinueWatchingItem> = rows
                .into_iter()
                .filter_map(|r| {
                    // Skip rows whose title fell out of the catalog (e.g. a
                    // regenerated enriched_400.json) rather than erroring.
                    let item = state.items.iter().find(|i| i.id == r.content_id)?.clone();
                    let progress_fraction = r
                        .duration_seconds
                        .filter(|d| *d > 0.0)
                        .map(|d| (r.position_seconds / d).clamp(0.0, 1.0))
                        .unwrap_or(0.0);
                    Some(ContinueWatchingItem {
                        item,
                        episode: r.episode,
                        progress_fraction,
                    })
                })
                .collect();
            Json(items).into_response()
        }
        Err(e) => {
            tracing::error!("failed to fetch continue watching: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod backfill_tests {
    use super::*;

    fn test_item(id: &str) -> EnrichedItem {
        EnrichedItem {
            id: id.to_string(),
            title: id.to_string(),
            original_title: None,
            year: 2000,
            content_type: ContentType::Movie,
            origin: "International".to_string(),
            director: None,
            creator: None,
            curated_imdb_rating: 7.0,
            poster_url: None,
            backdrop_url: None,
            plot: None,
            genres: Vec::new(),
            runtime: None,
            actors: Vec::new(),
            awards: None,
            rated: None,
            title_pt: None,
            plot_pt: None,
            genres_pt: Vec::new(),
            rated_pt: None,
            imdb_rating: None,
            imdb_votes: None,
            rotten_tomatoes: None,
            metacritic: None,
            imdb_id: None,
            tmdb_id: None,
            collection_id: None,
            collection_name: None,
            trailer_key: None,
            enrichment_status: tv_backend::models::EnrichmentStatus::Ok,
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

    /// Each test gets its own throwaway directory (rather than a shared temp
    /// path) so concurrent test threads - the default `cargo test` harness
    /// behavior - don't race on the same awards_backfill.json / fake
    /// enriched_400.json path, mirroring the unique-per-test-run approach
    /// auth.rs's tests use for usernames.
    fn temp_data_dir() -> std::path::PathBuf {
        use rand::Rng;
        let suffix: u64 = rand::thread_rng().gen();
        let dir = std::env::temp_dir().join(format!("awards_backfill_test_{suffix:x}"));
        std::fs::create_dir_all(&dir).expect("failed to create temp test dir");
        dir.join("enriched_400.json")
    }

    #[test]
    fn merges_awards_onto_matching_items_only() {
        let enriched_data_path = temp_data_dir();
        let backfill_path = std::path::Path::new(&enriched_data_path)
            .parent()
            .unwrap()
            .join("awards_backfill.json");
        std::fs::write(
            &backfill_path,
            serde_json::json!({
                "the-godfather-1972-movie": [
                    {"event": "Academy Awards", "category": "Best Picture", "year": 1973, "won": true}
                ]
            })
            .to_string(),
        )
        .unwrap();

        let mut items = vec![
            test_item("the-godfather-1972-movie"),
            test_item("the-lion-king-1994-movie"),
        ];
        apply_awards_backfill(&mut items, enriched_data_path.to_str().unwrap());

        assert_eq!(items[0].award_entries.len(), 1);
        assert_eq!(items[0].award_entries[0].category, "Best Picture");
        assert!(items[0].award_entries[0].won);
        // The item with no matching backfill row (e.g. an unrelated title a
        // bad TMDB search match could have collided with) must stay
        // untouched - regression guard for exactly that class of bug hit
        // while sourcing the Oscars dataset (a "Lion" (2016) search briefly
        // resolved to "The Lion King" (1994) before being caught).
        assert!(items[1].award_entries.is_empty());
    }

    #[test]
    fn does_not_overwrite_existing_award_entries() {
        let enriched_data_path = temp_data_dir();
        let backfill_path = std::path::Path::new(&enriched_data_path)
            .parent()
            .unwrap()
            .join("awards_backfill.json");
        std::fs::write(
            &backfill_path,
            serde_json::json!({
                "parasite-2019-movie": [
                    {"event": "Academy Awards", "category": "Best Picture", "year": 2020, "won": true}
                ]
            })
            .to_string(),
        )
        .unwrap();

        let mut item = test_item("parasite-2019-movie");
        item.award_entries.push(AwardEntry {
            event: "Cannes Film Festival".to_string(),
            category: "Palme d'Or".to_string(),
            year: 2019,
            won: true,
        });
        let mut items = vec![item];
        apply_awards_backfill(&mut items, enriched_data_path.to_str().unwrap());

        // Already had an entry, so the (empty-check-gated) backfill must
        // leave it alone rather than appending/overwriting - matches
        // apply_keywords_backfill's semantics exactly.
        assert_eq!(items[0].award_entries.len(), 1);
        assert_eq!(items[0].award_entries[0].event, "Cannes Film Festival");
    }

    #[test]
    fn missing_backfill_file_is_tolerated() {
        let enriched_data_path = temp_data_dir();
        let mut items = vec![test_item("some-movie-2000-movie")];
        apply_awards_backfill(&mut items, enriched_data_path.to_str().unwrap());
        assert!(items[0].award_entries.is_empty());
    }

    /// Exercises the real repo data (data/enriched_400.json +
    /// data/awards_backfill.json), the same load path `server` uses at
    /// boot - the closest thing to hitting a running /api/content without a
    /// Postgres instance available (the full `server` binary requires
    /// DATABASE_URL, see main() below). Asserts on the actual Oscars
    /// dataset rather than a synthetic fixture.
    #[test]
    fn real_data_best_picture_backfill_is_sane() {
        let data_path = "data/enriched_400.json";
        let raw = std::fs::read_to_string(data_path).expect("data/enriched_400.json must exist");
        let mut cache: EnrichedCache = serde_json::from_str(&raw).expect("valid enriched cache JSON");
        apply_awards_backfill(&mut cache.items, data_path);

        let by_id = |id: &str| cache.items.iter().find(|i| i.id == id);

        let godfather = by_id("the-godfather-1972-movie").expect("The Godfather must be in the catalog");
        assert!(
            godfather
                .award_entries
                .iter()
                .any(|a| a.category == "Best Picture" && a.won),
            "The Godfather should carry a won Best Picture entry"
        );

        let lion = by_id("lion-2016-movie").expect("Lion (2016) must be in the catalog");
        assert!(
            lion.award_entries
                .iter()
                .any(|a| a.category == "Best Picture" && !a.won),
            "Lion (2016) should carry a nominated (not won) Best Picture entry"
        );

        // Regression guard for the exact join-drift bug hit while building
        // this dataset: an ambiguous TMDB search for "Lion"+2016 briefly
        // resolved to The Lion King (1994) before being caught and fixed -
        // The Lion King's own catalog entry must never pick up a Best
        // Picture nomination.
        if let Some(lion_king) = by_id("the-lion-king-1994-movie") {
            assert!(
                lion_king.award_entries.is_empty(),
                "The Lion King must not have any award_entries"
            );
        }

        let best_picture_count = cache
            .items
            .iter()
            .filter(|i| i.award_entries.iter().any(|a| a.category == "Best Picture"))
            .count();
        assert!(
            best_picture_count > 600,
            "expected 600+ Best Picture nominees/winners in the catalog, got {best_picture_count}"
        );
    }

    #[test]
    fn is_unreleased_for_future_year_without_a_stream() {
        let mut item = test_item("future-movie-2027-movie");
        item.year = 2027;
        assert!(is_unreleased(&item, 2026));
    }

    #[test]
    fn is_unreleased_false_when_a_stream_already_exists() {
        // Future-dated in the catalog, but a playable file exists (sourced
        // early) - actually available, so it must not be treated as
        // unreleased no matter what the year says.
        let mut item = test_item("early-copy-2027-movie");
        item.year = 2027;
        item.s3_keys.push("videos/early-copy-2027-movie/movie.mp4".to_string());
        assert!(!is_unreleased(&item, 2026));
    }

    #[test]
    fn is_unreleased_false_for_current_or_past_year() {
        let mut current = test_item("this-year-2026-movie");
        current.year = 2026;
        assert!(!is_unreleased(&current, 2026));

        let past = test_item("old-movie-2000-movie");
        assert!(!is_unreleased(&past, 2026));
    }

    #[test]
    fn sort_content_always_ranks_unreleased_titles_last() {
        // Alphabetically "Aaa Unreleased" would sort first under title_asc -
        // the grouping in sort_content must still put every released title
        // ahead of it regardless of the chosen `sort`.
        let mut released = test_item("zzz-released-2020-movie");
        released.title = "Zzz Released".to_string();
        released.year = 2020;

        let mut unreleased = test_item("aaa-unreleased-2027-movie");
        unreleased.title = "Aaa Unreleased".to_string();
        unreleased.year = 2027;

        let mut items = vec![&unreleased, &released];
        sort_content(&mut items, Some("title_asc"), 2026);

        assert_eq!(items[0].id, "zzz-released-2020-movie");
        assert_eq!(items[1].id, "aaa-unreleased-2027-movie");
    }

    #[test]
    fn sort_content_preserves_the_chosen_heuristic_within_each_group() {
        let mut released_low = test_item("released-low-2020-movie");
        released_low.year = 2020;
        released_low.curated_imdb_rating = 5.0;

        let mut released_high = test_item("released-high-2020-movie");
        released_high.year = 2020;
        released_high.curated_imdb_rating = 9.0;

        let mut unreleased_low = test_item("unreleased-low-2028-movie");
        unreleased_low.year = 2028;
        unreleased_low.curated_imdb_rating = 1.0;

        let mut unreleased_high = test_item("unreleased-high-2027-movie");
        unreleased_high.year = 2027;
        unreleased_high.curated_imdb_rating = 10.0;

        let mut items = vec![&unreleased_low, &released_low, &unreleased_high, &released_high];
        sort_content(&mut items, None, 2026); // default rating_desc

        assert_eq!(
            items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec![
                "released-high-2020-movie",
                "released-low-2020-movie",
                "unreleased-high-2027-movie",
                "unreleased-low-2028-movie",
            ]
        );
    }
}
