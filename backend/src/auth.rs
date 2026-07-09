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

pub enum ChangePasswordError {
    WrongCurrentPassword,
    Database(sqlx::Error),
}

pub async fn change_password(
    pool: &PgPool,
    user_id: i64,
    current_password: &str,
    new_password: &str,
) -> Result<(), ChangePasswordError> {
    let row: UserRow =
        sqlx::query_as("SELECT id, username, password_hash, is_admin FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(ChangePasswordError::Database)?;

    let parsed = PasswordHash::new(&row.password_hash)
        .map_err(|_| ChangePasswordError::WrongCurrentPassword)?;
    Argon2::default()
        .verify_password(current_password.as_bytes(), &parsed)
        .map_err(|_| ChangePasswordError::WrongCurrentPassword)?;

    let new_hash = hash_password(new_password);
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(new_hash)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(ChangePasswordError::Database)?;

    Ok(())
}

pub struct Invite {
    pub token: String,
    /// Postgres-formatted timestamp text (not parsed further - callers only
    /// display it, never compute with it).
    pub expires_at: String,
}

/// Invites are single-use and expire after 7 days (RFC 0001) - there's no
/// admin UI to configure this yet, and a fixed short window is safer to
/// default to than an indefinitely-valid link.
pub async fn create_invite(pool: &PgPool, created_by: i64) -> Result<Invite, sqlx::Error> {
    let token = generate_token();
    let expires_at: String = sqlx::query_scalar(
        "INSERT INTO invites (token_hash, created_by, expires_at) \
         VALUES ($1, $2, now() + interval '7 days') RETURNING expires_at::text",
    )
    .bind(hash_token(&token))
    .bind(created_by)
    .fetch_one(pool)
    .await?;

    Ok(Invite { token, expires_at })
}

pub enum RedeemInviteError {
    InvalidOrExpired,
    UsernameTaken,
    Database(sqlx::Error),
}

/// Redeems a single-use invite and creates the invitee's account in one
/// transaction, `FOR UPDATE`-locking the invite row so two concurrent
/// redemptions of the same link can't both pass the used_at/expires_at
/// check before either commits.
pub async fn redeem_invite(
    pool: &PgPool,
    token: &str,
    username: &str,
    password: &str,
) -> Result<UserRecord, RedeemInviteError> {
    let token_hash = hash_token(token);
    let mut tx = pool.begin().await.map_err(RedeemInviteError::Database)?;

    let valid: Option<i64> = sqlx::query_scalar(
        "SELECT created_by FROM invites \
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() \
         FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(RedeemInviteError::Database)?;

    if valid.is_none() {
        return Err(RedeemInviteError::InvalidOrExpired);
    }

    let password_hash = hash_password(password);
    let result: Result<UserRow, sqlx::Error> = sqlx::query_as(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, FALSE) \
         RETURNING id, username, password_hash, is_admin",
    )
    .bind(username)
    .bind(password_hash)
    .fetch_one(&mut *tx)
    .await;

    let user: UserRecord = match result {
        Ok(row) => row.into(),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(RedeemInviteError::UsernameTaken)
        }
        Err(e) => return Err(RedeemInviteError::Database(e)),
    };

    sqlx::query("UPDATE invites SET used_at = now(), used_by = $1 WHERE token_hash = $2")
        .bind(user.id)
        .bind(&token_hash)
        .execute(&mut *tx)
        .await
        .map_err(RedeemInviteError::Database)?;

    tx.commit().await.map_err(RedeemInviteError::Database)?;

    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Connects to a real Postgres instance for integration testing, driven
    /// by the same DATABASE_URL convention main.rs uses (see connect_db in
    /// main.rs) - these tests exercise real queries/constraints (unique
    /// usernames, ON DELETE CASCADE, etc.) rather than mocking sqlx, so a
    /// mock pool wouldn't catch what we actually care about here.
    ///
    /// Requires DATABASE_URL to point at a disposable Postgres database
    /// (never point this at a production database - tests create/delete
    /// rows in `users`/`sessions`). Migrations are applied on every call,
    /// which is a no-op if already up to date, so this is safe to call from
    /// every test.
    async fn test_pool() -> PgPool {
        let database_url = std::env::var("DATABASE_URL").expect(
            "DATABASE_URL must be set to a real Postgres instance to run auth tests, e.g.:\n  \
             DATABASE_URL=postgres://postgres@127.0.0.1:5432/tv_test cargo test",
        );
        let pool = PgPool::connect(&database_url)
            .await
            .expect("failed to connect to test DATABASE_URL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("failed to run migrations against test database");
        pool
    }

    /// Every test uses a random per-run username instead of a fixed one so
    /// concurrent test threads (the default test harness behavior) and
    /// repeated `cargo test` runs against the same persistent database don't
    /// collide on the `users.username` UNIQUE constraint.
    fn unique_username(label: &str) -> String {
        let suffix: u64 = rand::thread_rng().gen();
        format!("test_{label}_{suffix:x}")
    }

    /// Deletes a test user (and, via ON DELETE CASCADE, its sessions) so
    /// repeated test runs don't leave junk rows behind in a shared test DB.
    async fn cleanup_user(pool: &PgPool, username: &str) {
        let _ = sqlx::query("DELETE FROM users WHERE username = $1")
            .bind(username)
            .execute(pool)
            .await;
    }

    #[tokio::test]
    async fn create_user_then_verify_login() {
        let pool = test_pool().await;
        let username = unique_username("verify_login");

        create_user(&pool, &username, "correct-horse-battery-staple", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let ok = verify_login(&pool, &username, "correct-horse-battery-staple").await;
        assert!(ok.is_some(), "verify_login should succeed with the right password");
        assert_eq!(ok.unwrap().username, username);

        let wrong = verify_login(&pool, &username, "wrong-password").await;
        assert!(wrong.is_none(), "verify_login should fail with the wrong password");

        cleanup_user(&pool, &username).await;
    }

    #[tokio::test]
    async fn create_session_then_session_user_returns_the_right_user() {
        let pool = test_pool().await;
        let username = unique_username("session_user");

        let user = create_user(&pool, &username, "hunter2-hunter2", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let token = create_session(&pool, user.id)
            .await
            .expect("create_session should succeed for an existing user");

        let looked_up = session_user(&pool, &token).await;
        assert!(looked_up.is_some(), "session_user should find a freshly created session");
        let looked_up = looked_up.unwrap();
        assert_eq!(looked_up.id, user.id);
        assert_eq!(looked_up.username, username);

        cleanup_user(&pool, &username).await;
    }

    #[tokio::test]
    async fn revoke_session_then_session_user_returns_none() {
        let pool = test_pool().await;
        let username = unique_username("revoke_session");

        let user = create_user(&pool, &username, "revoke-me-please", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let token = create_session(&pool, user.id)
            .await
            .expect("create_session should succeed for an existing user");

        assert!(
            session_user(&pool, &token).await.is_some(),
            "sanity check: session should be valid before revocation"
        );

        revoke_session(&pool, &token).await;

        let after_revoke = session_user(&pool, &token).await;
        assert!(
            after_revoke.is_none(),
            "session_user should return None once the session has been revoked"
        );

        cleanup_user(&pool, &username).await;
    }

    #[tokio::test]
    async fn seed_admin_is_idempotent() {
        let pool = test_pool().await;
        let username = unique_username("seed_admin");

        seed_admin(&pool, &username, "first-password")
            .await
            .expect("seed_admin should succeed on first call");
        seed_admin(&pool, &username, "second-password")
            .await
            .expect("seed_admin should succeed (no-op) on second call, not error");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = $1")
            .bind(&username)
            .fetch_one(&pool)
            .await
            .expect("count query should succeed");
        assert_eq!(count, 1, "seed_admin should not duplicate the admin user");

        // Confirms the second call really was a no-op: the original password
        // still verifies, proving seed_admin didn't overwrite it either.
        let login = verify_login(&pool, &username, "first-password").await;
        assert!(
            login.is_some(),
            "the original admin password should still work after the second seed_admin call"
        );

        cleanup_user(&pool, &username).await;
    }
}
