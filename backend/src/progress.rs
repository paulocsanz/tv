use serde::Serialize;
use sqlx::PgPool;

#[derive(sqlx::FromRow, Serialize)]
pub struct UserUsage {
    pub user_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub watch_minutes: f64,
}

/// Per-user share of total watch time (RFC 0001: "per-user attribution ...
/// derivable from existing sessions", used to inform cost-splitting - not a
/// billing engine). There's no file-size field on catalog items to attribute
/// actual bytes served, and streaming goes through presigned S3 redirects
/// the backend never sees the byte count for anyway - watch time from the
/// progress table already tracked for Continue Watching is the honest
/// signal actually available, not an approximation bolted on separately.
/// `position_seconds` is each episode's last-saved position, which
/// undercounts rewatches, but overcounting via naive duration sums would be
/// worse (a barely-started episode would count as fully watched).
pub async fn usage_by_user(pool: &PgPool) -> Result<Vec<UserUsage>, sqlx::Error> {
    sqlx::query_as(
        "SELECT u.id AS user_id, u.username, u.display_name, \
                COALESCE(SUM(w.position_seconds) / 60.0, 0.0) AS watch_minutes \
         FROM users u \
         LEFT JOIN watch_progress w ON w.user_id = u.id \
         GROUP BY u.id, u.username, u.display_name \
         ORDER BY watch_minutes DESC",
    )
    .fetch_all(pool)
    .await
}

#[derive(sqlx::FromRow, Serialize)]
pub struct ProgressRow {
    pub episode: i32,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub finished: bool,
}

pub async fn get_progress(
    pool: &PgPool,
    user_id: i64,
    content_id: &str,
) -> Result<Vec<ProgressRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT episode, position_seconds, duration_seconds, finished \
         FROM watch_progress WHERE user_id = $1 AND content_id = $2 ORDER BY episode",
    )
    .bind(user_id)
    .bind(content_id)
    .fetch_all(pool)
    .await
}

#[derive(sqlx::FromRow)]
pub struct ContinueWatchingRow {
    pub content_id: String,
    pub episode: i32,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
}

/// Ordered by recency (most recently watched first) - the query does the
/// ordering rather than exposing updated_at to callers, since nothing on
/// the frontend needs the raw timestamp, just an already-sorted list.
///
/// One row per content_id, not per episode - a title with progress on
/// several episodes (a course lecture list in particular: easy to scrub
/// through a few before settling on one) used to surface as that many
/// separate "Continue Watching" cards for the same title (confirmed live:
/// two "Cultivo de Maconha" cards, one per in-progress lecture). The inner
/// DISTINCT ON picks each content_id's single most-recent row; the outer
/// query re-sorts *those* by recency since DISTINCT ON's own ordering is
/// grouped by content_id, not true recency across titles.
pub async fn continue_watching(
    pool: &PgPool,
    user_id: i64,
) -> Result<Vec<ContinueWatchingRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT content_id, episode, position_seconds, duration_seconds FROM ( \
           SELECT DISTINCT ON (content_id) content_id, episode, position_seconds, duration_seconds, updated_at \
           FROM watch_progress \
           WHERE user_id = $1 AND finished = false AND position_seconds > 0 \
           ORDER BY content_id, updated_at DESC \
         ) sub \
         ORDER BY updated_at DESC \
         LIMIT 20",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// Upserts one episode's progress. The update is monotonic (GREATEST /
/// OR-in-finished) rather than a blind overwrite, because three independent
/// write paths - a ~10s throttle, a pause/ended flush, and a best-effort
/// sendBeacon on page unload - can race and arrive out of order.
pub async fn upsert_progress(
    pool: &PgPool,
    user_id: i64,
    content_id: &str,
    episode: i32,
    position_seconds: f64,
    duration_seconds: Option<f64>,
) -> Result<(), sqlx::Error> {
    let finished = duration_seconds
        .map(|d| d > 0.0 && position_seconds >= d * 0.9)
        .unwrap_or(false);

    sqlx::query(
        "INSERT INTO watch_progress \
             (user_id, content_id, episode, position_seconds, duration_seconds, finished) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (user_id, content_id, episode) DO UPDATE SET \
             position_seconds = GREATEST(watch_progress.position_seconds, EXCLUDED.position_seconds), \
             duration_seconds = COALESCE(EXCLUDED.duration_seconds, watch_progress.duration_seconds), \
             finished = watch_progress.finished OR EXCLUDED.finished, \
             updated_at = now()",
    )
    .bind(user_id)
    .bind(content_id)
    .bind(episode)
    .bind(position_seconds)
    .bind(duration_seconds)
    .bind(finished)
    .execute(pool)
    .await?;

    Ok(())
}
