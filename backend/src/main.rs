use axum::{
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tv_backend::auth::AuthState;
use tv_backend::models::{ContentType, EnrichedCache, EnrichedItem};

struct AppState {
    items: Vec<EnrichedItem>,
    auth: AuthState,
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

    let auth_path =
        std::env::var("AUTH_DATA_PATH").unwrap_or_else(|_| "data/auth_credentials.json".to_string());
    let auth = AuthState::load_or_generate(std::path::Path::new(&auth_path));

    let state = Arc::new(AppState {
        items: cache.items,
        auth,
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
        .route("/api/logout", post(logout))
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
    if state.auth.verify(&body.username, &body.password) {
        let token = state.auth.create_session();
        Json(LoginResponse { token }).into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid username or password" })),
        )
            .into_response()
    }
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = bearer_token(&headers) {
        state.auth.revoke(token);
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
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let authorized = bearer_token(req.headers())
        .map(|token| state.auth.is_valid(token))
        .unwrap_or(false);

    if authorized {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
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
