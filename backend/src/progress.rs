use serde::Serialize;
use sqlx::PgPool;

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
