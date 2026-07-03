use futures::stream::{self, StreamExt};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tv_backend::enrichment::{enrich_one, EnrichInput, OmdbKeyPool};
use tv_backend::models::{ContentType, CuratedList, EnrichedCache, EnrichedItem};

const CONCURRENCY: usize = 8;
const SAVE_EVERY: usize = 20;

fn slugify(title: &str, year: i32, content_type: &ContentType) -> String {
    let type_str = match content_type {
        ContentType::Movie => "movie",
        ContentType::Tv => "tv",
    };
    format!("{}-{}-{}", slug::slugify(title), year, type_str)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    // Load env from repo root .env (backend/ is one level down).
    let _ = dotenvy::from_path("../.env");
    let _ = dotenvy::dotenv();

    let tmdb_token = std::env::var("TMDB_API_KEY").expect("TMDB_API_KEY must be set");
    let omdb_keys: Vec<String> = std::env::var("OMDB_API_KEYS")
        .expect("OMDB_API_KEYS must be set")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let omdb_pool = Arc::new(OmdbKeyPool::new(omdb_keys));

    let curated_path = "../data/top_400_curated.json";
    let curated_raw = std::fs::read_to_string(curated_path)
        .unwrap_or_else(|e| panic!("failed to read {curated_path}: {e}"));
    let curated: CuratedList = serde_json::from_str(&curated_raw)?;

    let output_path = "data/enriched_400.json";
    let existing: Arc<std::collections::HashMap<String, EnrichedItem>> =
        Arc::new(if Path::new(output_path).exists() {
            let raw = std::fs::read_to_string(output_path)?;
            let cache: EnrichedCache = serde_json::from_str(&raw)?;
            cache.items.into_iter().map(|i| (i.id.clone(), i)).collect()
        } else {
            std::collections::HashMap::new()
        });

    println!(
        "Loaded {} movies, {} tv series. {} already cached.",
        curated.movies.len(),
        curated.tv_series.len(),
        existing.len()
    );

    let mut inputs: Vec<EnrichInput> = Vec::new();
    for m in &curated.movies {
        let id = slugify(&m.title, m.year, &ContentType::Movie);
        if existing.contains_key(&id) {
            continue;
        }
        inputs.push(EnrichInput {
            id,
            title: m.title.clone(),
            year: m.year,
            content_type: ContentType::Movie,
            origin: m.origin.clone(),
            director: m.director.clone(),
            creator: None,
            curated_imdb_rating: m.imdb_rating,
        });
    }
    for t in &curated.tv_series {
        let id = slugify(&t.title, t.year, &ContentType::Tv);
        if existing.contains_key(&id) {
            continue;
        }
        inputs.push(EnrichInput {
            id,
            title: t.title.clone(),
            year: t.year,
            content_type: ContentType::Tv,
            origin: t.origin.clone(),
            director: None,
            creator: t.creator.clone(),
            curated_imdb_rating: t.imdb_rating,
        });
    }

    println!("{} items need enrichment.", inputs.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let results = Arc::new(Mutex::new(Vec::<EnrichedItem>::new()));
    let done_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let total = inputs.len();

    stream::iter(inputs)
        .for_each_concurrent(CONCURRENCY, |input| {
            let client = client.clone();
            let omdb_pool = omdb_pool.clone();
            let tmdb_token = tmdb_token.clone();
            let results = results.clone();
            let done_count = done_count.clone();
            let existing = existing.clone();
            async move {
                let title = input.title.clone();
                let item = enrich_one(&client, &omdb_pool, &tmdb_token, input).await;
                let status = format!("{:?}", item.enrichment_status);
                {
                    let mut r = results.lock().await;
                    r.push(item);
                }
                let n = done_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                println!("[{n}/{total}] {title} -> {status}");

                if n % SAVE_EVERY == 0 {
                    let r = results.lock().await;
                    save_partial(output_path, &existing, &r);
                }
            }
        })
        .await;

    let new_items = Arc::try_unwrap(results).unwrap().into_inner();
    let mut existing = Arc::try_unwrap(existing).expect("all clones dropped after stream completes");
    for item in new_items {
        existing.insert(item.id.clone(), item);
    }

    let mut all: Vec<EnrichedItem> = existing.into_values().collect();
    all.sort_by(|a, b| b.curated_imdb_rating.partial_cmp(&a.curated_imdb_rating).unwrap());

    let cache = EnrichedCache { items: all };
    std::fs::write(output_path, serde_json::to_string_pretty(&cache)?)?;

    let ok = cache.items.iter().filter(|i| matches!(i.enrichment_status, tv_backend::models::EnrichmentStatus::Ok)).count();
    let partial = cache.items.iter().filter(|i| matches!(i.enrichment_status, tv_backend::models::EnrichmentStatus::Partial)).count();
    let failed = cache.items.iter().filter(|i| matches!(i.enrichment_status, tv_backend::models::EnrichmentStatus::Failed)).count();
    println!("\nDone. Total: {} | OK: {ok} | Partial: {partial} | Failed: {failed}", cache.items.len());

    Ok(())
}

fn save_partial(
    path: &str,
    existing: &std::collections::HashMap<String, EnrichedItem>,
    new_items: &[EnrichedItem],
) {
    let mut merged: std::collections::HashMap<String, EnrichedItem> = existing.clone();
    for item in new_items {
        merged.insert(item.id.clone(), item.clone());
    }
    let items: Vec<EnrichedItem> = merged.into_values().collect();
    let cache = EnrichedCache { items };
    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(path, json);
    }
}
