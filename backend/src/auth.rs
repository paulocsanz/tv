use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::Rng;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

#[derive(Debug, Clone, Serialize)]
pub struct UserRecord {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: i64,
    username: String,
    password_hash: String,
    is_admin: bool,
}

impl From<UserRow> for UserRecord {
    fn from(row: UserRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            is_admin: row.is_admin,
        }
    }
}

#[derive(sqlx::FromRow, Serialize)]
pub struct UserSummary {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
}

pub enum CreateUserError {
    UsernameTaken,
    Database(sqlx::Error),
}

/// Seeds the fixed admin account from ADMIN_USERNAME/ADMIN_PASSWORD on first
/// boot, if no user with that username exists yet - keeps the pre-existing
/// login working now that users/sessions live in Postgres instead of
/// in-memory state.
pub async fn seed_admin(pool: &PgPool, username: &str, password: &str) -> Result<(), sqlx::Error> {
    let password_hash = hash_password(password);
    sqlx::query(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE) \
         ON CONFLICT (username) DO NOTHING",
    )
    .bind(username)
    .bind(password_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn verify_login(pool: &PgPool, username: &str, password: &str) -> Option<UserRecord> {
    let row: UserRow = sqlx::query_as(
        "SELECT id, username, password_hash, is_admin FROM users WHERE username = $1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await
    .ok()??;

    let parsed = PasswordHash::new(&row.password_hash).ok()?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .ok()?;
    Some(row.into())
}

pub async fn create_session(pool: &PgPool, user_id: i64) -> Result<String, sqlx::Error> {
    let token = generate_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)")
        .bind(hash_token(&token))
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(token)
}

pub async fn session_user(pool: &PgPool, token: &str) -> Option<UserRecord> {
    let row: UserRow = sqlx::query_as(
        "SELECT u.id, u.username, u.password_hash, u.is_admin \
         FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = $1",
    )
    .bind(hash_token(token))
    .fetch_optional(pool)
    .await
    .ok()??;

    Some(row.into())
}

pub async fn revoke_session(pool: &PgPool, token: &str) {
    let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(hash_token(token))
        .execute(pool)
        .await;
}

pub async fn create_user(
    pool: &PgPool,
    username: &str,
    password: &str,
    is_admin: bool,
) -> Result<UserRecord, CreateUserError> {
    let password_hash = hash_password(password);
    let result: Result<UserRow, sqlx::Error> = sqlx::query_as(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) \
         RETURNING id, username, password_hash, is_admin",
    )
    .bind(username)
    .bind(password_hash)
    .bind(is_admin)
    .fetch_one(pool)
    .await;

    match result {
        Ok(row) => Ok(row.into()),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            Err(CreateUserError::UsernameTaken)
        }
        Err(e) => Err(CreateUserError::Database(e)),
    }
}

pub async fn list_users(pool: &PgPool) -> Result<Vec<UserSummary>, sqlx::Error> {
    sqlx::query_as("SELECT id, username, is_admin FROM users ORDER BY id")
        .fetch_all(pool)
        .await
}

fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("failed to hash password")
        .to_string()
}

/// Sessions store only this hash, never the raw token - mirrors never
/// storing raw passwords, so a DB leak alone can't hand out live sessions.
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn generate_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
