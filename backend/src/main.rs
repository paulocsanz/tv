use axum::{
    extract::{Extension, Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use std::path::PathBuf;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tv_backend::auth::{self, UserRecord};
use tv_backend::models::{ContentType, EnrichedCache, EnrichedItem};
use tv_backend::progress;

struct S3Config {
    client: aws_sdk_s3::Client,
    bucket: String,
}

struct AppState {
    items: Vec<EnrichedItem>,
    db: PgPool,
    s3: Option<S3Config>,
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
    let cache: EnrichedCache = serde_json::from_str(&raw).expect("invalid enriched data JSON");

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
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let public_routes = Router::new()
        .route("/health", get(health))
        .route("/api/login", post(login));

    let protected_routes = Router::new()
        .route("/api/meta", get(get_meta))
        .route("/api/sections", get(get_sections))
        .route("/api/content", get(get_content))
        .route("/api/content/:id", get(get_content_by_id))
        .route("/api/content/:id/torrent", get(get_torrent_file))
        .route("/api/content/:id/stream", get(get_stream_url))
        .route("/api/content/:id/progress", get(get_progress_handler).post(post_progress_handler))
        .route("/api/logout", post(logout))
        .route("/api/me", get(get_me))
        .route("/api/admin/users", get(list_users_handler).post(create_user_handler))
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
    brazilian: usize,
    international: usize,
    genres: Vec<String>,
    year_min: i32,
    year_max: i32,
}

async fn get_meta(State(state): State<Arc<AppState>>) -> Json<MetaResponse> {
    let items = &state.items;
    let mut genres: Vec<String> = items
        .iter()
        .flat_map(|i| i.genres.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    genres.sort();

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
        brazilian: items.iter().filter(|i| i.origin == "Brazilian").count(),
        international: items.iter().filter(|i| i.origin == "International").count(),
        genres,
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
    items.sort_by(|a, b| effective_rating(b).partial_cmp(&effective_rating(a)).unwrap());
    items.truncate(n);
    items
}

async fn get_sections(State(state): State<Arc<AppState>>) -> Json<Vec<Section>> {
    let items = &state.items;
    let clone_items = |v: Vec<&EnrichedItem>| v.into_iter().cloned().collect::<Vec<_>>();

    let featured = top_n(items.iter().collect(), 12);

    let brazilian_movies = top_n(
        items
            .iter()
            .filter(|i| i.origin == "Brazilian" && i.content_type == ContentType::Movie)
            .collect(),
        18,
    );
    let brazilian_tv = top_n(
        items
            .iter()
            .filter(|i| i.origin == "Brazilian" && i.content_type == ContentType::Tv)
            .collect(),
        18,
    );
    let international_classics = top_n(
        items
            .iter()
            .filter(|i| i.origin == "International" && i.year <= 1980)
            .collect(),
        18,
    );
    let modern_hits = top_n(items.iter().filter(|i| i.year >= 2015).collect(), 18);
    let top_tv = top_n(
        items
            .iter()
            .filter(|i| i.content_type == ContentType::Tv)
            .collect(),
        18,
    );
    let top_movies = top_n(
        items
            .iter()
            .filter(|i| i.content_type == ContentType::Movie)
            .collect(),
        18,
    );
    let hidden_gems = top_n(
        items
            .iter()
            .filter(|i| {
                let r = effective_rating(i);
                (7.0..8.3).contains(&r)
            })
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

    if let Some(decade) = q.decade {
        filtered.retain(|i| i.year >= decade && i.year < decade + 10);
    }

    match q.sort.as_deref().unwrap_or("rating_desc") {
        "rating_asc" => {
            filtered.sort_by(|a, b| effective_rating(a).partial_cmp(&effective_rating(b)).unwrap())
        }
        "year_desc" => filtered.sort_by(|a, b| b.year.cmp(&a.year)),
        "year_asc" => filtered.sort_by(|a, b| a.year.cmp(&b.year)),
        "title_asc" => filtered.sort_by(|a, b| a.title.cmp(&b.title)),
        _ => filtered.sort_by(|a, b| effective_rating(b).partial_cmp(&effective_rating(a)).unwrap()),
    }

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

#[derive(Serialize)]
struct MeResponse {
    username: String,
    is_admin: bool,
}

async fn get_me(Extension(user): Extension<UserRecord>) -> Json<MeResponse> {
    Json(MeResponse {
        username: user.username,
        is_admin: user.is_admin,
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
