use serde::Serialize;
use sqlx::PgPool;

/// Records an admin action against a catalog item - distinct from git
/// history, which only shows bulk script runs, not who clicked what and
/// when through the dashboard (RFC 0003 P2).
pub async fn log_catalog_edit(
    pool: &PgPool,
    user_id: i64,
    content_id: &str,
    action: &str,
    detail: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO catalog_edit_log (user_id, content_id, action, detail) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(content_id)
    .bind(action)
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow, Serialize)]
pub struct CatalogEditEntry {
    pub username: String,
    pub content_id: String,
    pub action: String,
    pub detail: Option<String>,
    pub created_at: String,
}

pub async fn recent_catalog_edits(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<CatalogEditEntry>, sqlx::Error> {
    sqlx::query_as(
        "SELECT u.username, l.content_id, l.action, l.detail, l.created_at::text \
         FROM catalog_edit_log l JOIN users u ON u.id = l.user_id \
         ORDER BY l.created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}
