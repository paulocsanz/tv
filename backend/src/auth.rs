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
    pub display_name: Option<String>,
    pub default_subtitle_lang: Option<String>,
    pub autoplay_next: bool,
    pub ui_locale: String,
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: i64,
    username: String,
    password_hash: String,
    is_admin: bool,
    display_name: Option<String>,
    default_subtitle_lang: Option<String>,
    autoplay_next: bool,
    ui_locale: String,
}

const USER_COLUMNS: &str = "id, username, password_hash, is_admin, display_name, \
     default_subtitle_lang, autoplay_next, ui_locale";

impl From<UserRow> for UserRecord {
    fn from(row: UserRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            is_admin: row.is_admin,
            display_name: row.display_name,
            default_subtitle_lang: row.default_subtitle_lang,
            autoplay_next: row.autoplay_next,
            ui_locale: row.ui_locale,
        }
    }
}

#[derive(sqlx::FromRow, Serialize)]
pub struct UserSummary {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub display_name: Option<String>,
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
    let row: UserRow = sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE username = $1"))
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
        "SELECT u.id, u.username, u.password_hash, u.is_admin, u.display_name, \
                u.default_subtitle_lang, u.autoplay_next, u.ui_locale \
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
    let result: Result<UserRow, sqlx::Error> = sqlx::query_as(&format!(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) \
         RETURNING {USER_COLUMNS}"
    ))
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
    sqlx::query_as("SELECT id, username, is_admin, display_name FROM users ORDER BY id")
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

/// Opaque AES-GCM wrap of the shared catalog media key, plus the salt used
/// to derive the wrap key from the user's password (client-side only).
/// Server never sees the plaintext catalog key — see RFC 0006.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogKeyWrap {
    /// Hex of: 12-byte IV || ciphertext || 16-byte GCM tag
    pub wrapped_hex: String,
    /// Hex of the wrap-key salt (16+ bytes)
    pub salt_hex: String,
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Returns this user's stored wrap, if they have been bootstrapped for
/// encrypted playback.
pub async fn get_catalog_key_wrap(
    pool: &PgPool,
    user_id: i64,
) -> Result<Option<CatalogKeyWrap>, sqlx::Error> {
    let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT catalog_key_wrap, catalog_key_wrap_salt FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let Some((Some(wrap), Some(salt))) = row else {
        return Ok(None);
    };
    Ok(Some(CatalogKeyWrap {
        wrapped_hex: bytes_to_hex(&wrap),
        salt_hex: bytes_to_hex(&salt),
    }))
}

/// Stores (or replaces) the caller's own catalog-key wrap. The bytes are
/// opaque to the server — we only validate non-empty length.
pub async fn set_catalog_key_wrap(
    pool: &PgPool,
    user_id: i64,
    wrapped: &[u8],
    salt: &[u8],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users SET catalog_key_wrap = $1, catalog_key_wrap_salt = $2 WHERE id = $3",
    )
    .bind(wrapped)
    .bind(salt)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// True if at least one user already has a wrap — used so only the first
/// admin bootstrap generates a fresh catalog key; later users must receive
/// a handoff (invite fragment, RFC 0006 P1) or have an admin re-wrap offline.
pub async fn any_catalog_key_wrap_exists(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE catalog_key_wrap IS NOT NULL)",
    )
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

pub fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

pub async fn change_password(
    pool: &PgPool,
    user_id: i64,
    current_password: &str,
    new_password: &str,
) -> Result<(), ChangePasswordError> {
    let row: UserRow =
        sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
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

/// Updates the self-serve profile fields together (RFC 0001 P2 display name,
/// RFC 0002 P1 preferences) - one form on /account, one call. `None` for
/// display_name/default_subtitle_lang clears that field rather than leaving
/// it untouched, matching how the account form submits its current values
/// (including empty ones) every time rather than only the changed field.
pub async fn update_preferences(
    pool: &PgPool,
    user_id: i64,
    display_name: Option<&str>,
    default_subtitle_lang: Option<&str>,
    autoplay_next: bool,
    ui_locale: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users SET display_name = $1, default_subtitle_lang = $2, autoplay_next = $3, \
         ui_locale = $4 WHERE id = $5",
    )
    .bind(display_name)
    .bind(default_subtitle_lang)
    .bind(autoplay_next)
    .bind(ui_locale)
    .bind(user_id)
    .execute(pool)
    .await?;
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

/// Attach a client-sealed catalog-key envelope to an unused invite created by
/// this admin. Opaque bytes only — server never decrypts them.
pub async fn set_invite_media_key_envelope(
    pool: &PgPool,
    created_by: i64,
    token: &str,
    envelope: &[u8],
) -> Result<(), SetInviteEnvelopeError> {
    if envelope.len() < 28 || envelope.len() > 512 {
        return Err(SetInviteEnvelopeError::BadEnvelope);
    }
    let result = sqlx::query(
        "UPDATE invites SET media_key_envelope = $1 \
         WHERE token_hash = $2 AND created_by = $3 \
           AND used_at IS NULL AND expires_at > now()",
    )
    .bind(envelope)
    .bind(hash_token(token))
    .bind(created_by)
    .execute(pool)
    .await
    .map_err(SetInviteEnvelopeError::Database)?;

    if result.rows_affected() == 0 {
        return Err(SetInviteEnvelopeError::NotFound);
    }
    Ok(())
}

pub enum SetInviteEnvelopeError {
    NotFound,
    BadEnvelope,
    Database(sqlx::Error),
}

pub enum RedeemInviteError {
    InvalidOrExpired,
    UsernameTaken,
    Database(sqlx::Error),
}

/// Result of a successful invite redemption. `media_key_envelope` is the
/// one-shot sealed catalog key (if the inviter attached one); it is cleared
/// on the invite row in the same transaction so it cannot be fetched again.
pub struct RedeemInviteResult {
    pub user: UserRecord,
    pub media_key_envelope: Option<Vec<u8>>,
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
    display_name: Option<&str>,
) -> Result<RedeemInviteResult, RedeemInviteError> {
    let token_hash = hash_token(token);
    let mut tx = pool.begin().await.map_err(RedeemInviteError::Database)?;

    let row: Option<(i64, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT created_by, media_key_envelope FROM invites \
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() \
         FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(RedeemInviteError::Database)?;

    let Some((_created_by, media_key_envelope)) = row else {
        return Err(RedeemInviteError::InvalidOrExpired);
    };

    let password_hash = hash_password(password);
    let result: Result<UserRow, sqlx::Error> = sqlx::query_as(&format!(
        "INSERT INTO users (username, password_hash, is_admin, display_name) \
         VALUES ($1, $2, FALSE, $3) RETURNING {USER_COLUMNS}"
    ))
    .bind(username)
    .bind(password_hash)
    .bind(display_name)
    .fetch_one(&mut *tx)
    .await;

    let user: UserRecord = match result {
        Ok(row) => row.into(),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(RedeemInviteError::UsernameTaken)
        }
        Err(e) => return Err(RedeemInviteError::Database(e)),
    };

    // Mark used and wipe envelope in one update (one-shot handoff).
    sqlx::query(
        "UPDATE invites SET used_at = now(), used_by = $1, media_key_envelope = NULL \
         WHERE token_hash = $2",
    )
    .bind(user.id)
    .bind(&token_hash)
    .execute(&mut *tx)
    .await
    .map_err(RedeemInviteError::Database)?;

    tx.commit().await.map_err(RedeemInviteError::Database)?;

    Ok(RedeemInviteResult {
        user,
        media_key_envelope,
    })
}

/// Human-typeable alphabet for pairing codes - excludes 0/O and 1/I, which
/// are easy to mis-type from a TV remote's on-screen keyboard or misread on
/// a TV-distance display.
const PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LEN: usize = 6;

fn generate_pairing_code() -> String {
    let mut rng = rand::thread_rng();
    (0..PAIRING_CODE_LEN)
        .map(|_| PAIRING_CODE_ALPHABET[rng.gen_range(0..PAIRING_CODE_ALPHABET.len())] as char)
        .collect()
}

/// Strips any display formatting (e.g. "ABC-234") and case before hashing,
/// so it doesn't matter how the claim form's input happens to be typed.
fn normalize_pairing_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

pub struct TvPairing {
    pub code: String,
    pub poll_token: String,
    /// Postgres-formatted timestamp text - same not-parsed-further rationale
    /// as `Invite::expires_at`.
    pub expires_at: String,
}

/// Starts a TV device-pairing flow (a code the TV displays + a private poll
/// token only the TV holds) instead of asking someone to type a password
/// with a remote control - same shape Netflix/YouTube-style "enter this code
/// on your phone" flows use. Retries on the astronomically unlikely event of
/// a code collision (32^6 possible codes) rather than widening the alphabet
/// or code length for a risk this small.
pub async fn start_tv_pairing(pool: &PgPool) -> Result<TvPairing, sqlx::Error> {
    let mut last_err = None;
    for _ in 0..5 {
        let code = generate_pairing_code();
        let poll_token = generate_token();
        let result: Result<String, sqlx::Error> = sqlx::query_scalar(
            "INSERT INTO tv_pairings (code_hash, poll_token_hash, expires_at) \
             VALUES ($1, $2, now() + interval '10 minutes') RETURNING expires_at::text",
        )
        .bind(hash_token(&code))
        .bind(hash_token(&poll_token))
        .fetch_one(pool)
        .await;

        match result {
            Ok(expires_at) => {
                return Ok(TvPairing {
                    code,
                    poll_token,
                    expires_at,
                })
            }
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                last_err = Some(sqlx::Error::Database(e));
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.expect("loop always sets last_err before exhausting retries"))
}

pub enum ClaimPairingError {
    InvalidOrExpired,
    Database(sqlx::Error),
}

/// Claims a pairing code on behalf of the signed-in user who typed it in
/// (on their phone/laptop, not the TV) - the TV never sees or handles a
/// password. Single-use: `claimed_by IS NULL` in the WHERE clause means a
/// second claim attempt of the same code fails just like an expired one.
pub async fn claim_tv_pairing(
    pool: &PgPool,
    code: &str,
    user_id: i64,
) -> Result<(), ClaimPairingError> {
    let result = sqlx::query(
        "UPDATE tv_pairings SET claimed_by = $1 \
         WHERE code_hash = $2 AND claimed_by IS NULL AND expires_at > now()",
    )
    .bind(user_id)
    .bind(hash_token(&normalize_pairing_code(code)))
    .execute(pool)
    .await
    .map_err(ClaimPairingError::Database)?;

    if result.rows_affected() == 0 {
        return Err(ClaimPairingError::InvalidOrExpired);
    }
    Ok(())
}

pub enum PairingPollResult {
    Pending,
    Claimed { token: String },
}

#[derive(sqlx::FromRow)]
struct PairingRow {
    claimed_by: Option<i64>,
}

/// Polled by the TV every few seconds with the private poll token from
/// `start_tv_pairing`. Returns `None` once the row is gone (expired, or
/// never existed) so the TV knows to restart pairing with a fresh code.
/// Mints the session and deletes the row in the same call that first
/// observes `claimed_by` set, so the code can't be "claimed" twice over by
/// two racing poll requests each minting their own session.
pub async fn poll_tv_pairing(
    pool: &PgPool,
    poll_token: &str,
) -> Result<Option<PairingPollResult>, sqlx::Error> {
    let row: Option<PairingRow> = sqlx::query_as(
        "SELECT claimed_by FROM tv_pairings WHERE poll_token_hash = $1 AND expires_at > now()",
    )
    .bind(hash_token(poll_token))
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let Some(user_id) = row.claimed_by else {
        return Ok(Some(PairingPollResult::Pending));
    };

    let token = create_session(pool, user_id).await?;
    sqlx::query("DELETE FROM tv_pairings WHERE poll_token_hash = $1")
        .bind(hash_token(poll_token))
        .execute(pool)
        .await?;

    Ok(Some(PairingPollResult::Claimed { token }))
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

    #[tokio::test]
    async fn create_invite_then_redeem_succeeds() {
        let pool = test_pool().await;
        let creator_username = unique_username("invite_creator");
        let creator = create_user(&pool, &creator_username, "creator-pass-123", true)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let invite = create_invite(&pool, creator.id)
            .await
            .expect("create_invite should succeed for an existing user");

        let invitee_username = unique_username("invitee");
        let redeemed = redeem_invite(
            &pool,
            &invite.token,
            &invitee_username,
            "invitee-pass-123",
            Some("Invitee Display"),
        )
        .await
        .ok()
        .expect("redeem_invite should succeed for a fresh, unused invite");

        assert_eq!(redeemed.user.username, invitee_username);
        assert_eq!(
            redeemed.user.display_name.as_deref(),
            Some("Invitee Display")
        );
        assert!(
            !redeemed.user.is_admin,
            "invited users should never be created as admins"
        );
        assert!(
            redeemed.media_key_envelope.is_none(),
            "invite without envelope should return none"
        );

        cleanup_user(&pool, &invitee_username).await;
        cleanup_user(&pool, &creator_username).await;
    }

    #[tokio::test]
    async fn redeem_invite_twice_fails_the_second_time() {
        let pool = test_pool().await;
        let creator_username = unique_username("invite_creator2");
        let creator = create_user(&pool, &creator_username, "creator-pass-123", true)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let invite = create_invite(&pool, creator.id)
            .await
            .expect("create_invite should succeed for an existing user");

        let first_username = unique_username("invitee_first");
        redeem_invite(&pool, &invite.token, &first_username, "pass-123456", None)
            .await
            .ok()
            .expect("the first redemption of a fresh invite should succeed");

        let second_username = unique_username("invitee_second");
        let second_result =
            redeem_invite(&pool, &invite.token, &second_username, "pass-123456", None).await;
        assert!(
            matches!(second_result, Err(RedeemInviteError::InvalidOrExpired)),
            "redeeming an already-used invite should fail as InvalidOrExpired, not succeed"
        );

        cleanup_user(&pool, &first_username).await;
        cleanup_user(&pool, &creator_username).await;
    }

    #[tokio::test]
    async fn redeem_invite_with_a_token_that_was_never_issued_fails() {
        let pool = test_pool().await;
        let result = redeem_invite(
            &pool,
            "this-token-was-never-issued-by-create-invite",
            &unique_username("nobody"),
            "pass-123456",
            None,
        )
        .await;
        assert!(matches!(result, Err(RedeemInviteError::InvalidOrExpired)));
    }

    /// Exercises the `FOR UPDATE` row lock in redeem_invite directly: five
    /// concurrent redemptions of the *same* single-use invite should let
    /// exactly one through, not create five accounts or silently drop the
    /// single-use constraint under contention.
    #[tokio::test]
    async fn concurrent_redemption_of_the_same_invite_only_lets_one_through() {
        let pool = test_pool().await;
        let creator_username = unique_username("invite_creator3");
        let creator = create_user(&pool, &creator_username, "creator-pass-123", true)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let invite = create_invite(&pool, creator.id)
            .await
            .expect("create_invite should succeed for an existing user");

        let usernames: Vec<String> = (0..5).map(|i| unique_username(&format!("racer{i}"))).collect();
        let results = futures::future::join_all(usernames.iter().map(|username| {
            let pool = pool.clone();
            let token = invite.token.clone();
            let username = username.clone();
            async move { redeem_invite(&pool, &token, &username, "racer-pass-123", None).await }
        }))
        .await;

        let succeeded = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            succeeded, 1,
            "exactly one concurrent redemption of a single-use invite should succeed, not {succeeded}"
        );

        for (username, result) in usernames.iter().zip(results.iter()) {
            if result.is_ok() {
                cleanup_user(&pool, username).await;
            }
        }
        cleanup_user(&pool, &creator_username).await;
    }

    #[tokio::test]
    async fn start_claim_then_poll_tv_pairing_succeeds() {
        let pool = test_pool().await;
        let username = unique_username("tv_pair_owner");
        let user = create_user(&pool, &username, "pairer-pass-123", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let pairing = start_tv_pairing(&pool)
            .await
            .expect("start_tv_pairing should succeed");

        claim_tv_pairing(&pool, &pairing.code, user.id)
            .await
            .ok()
            .expect("claiming a fresh pairing code should succeed");

        let result = poll_tv_pairing(&pool, &pairing.poll_token)
            .await
            .expect("poll_tv_pairing should succeed");

        match result {
            Some(PairingPollResult::Claimed { token }) => {
                let looked_up = session_user(&pool, &token).await;
                assert!(
                    looked_up.is_some(),
                    "poll should mint a valid session for the claiming user"
                );
                assert_eq!(looked_up.unwrap().id, user.id);
            }
            _ => panic!("expected poll to report Claimed after the code was claimed"),
        }

        cleanup_user(&pool, &username).await;
    }

    #[tokio::test]
    async fn poll_tv_pairing_before_claim_is_pending() {
        let pool = test_pool().await;

        let pairing = start_tv_pairing(&pool)
            .await
            .expect("start_tv_pairing should succeed");

        let result = poll_tv_pairing(&pool, &pairing.poll_token)
            .await
            .expect("poll_tv_pairing should succeed");

        assert!(matches!(result, Some(PairingPollResult::Pending)));
    }

    #[tokio::test]
    async fn poll_tv_pairing_with_unknown_token_returns_none() {
        let pool = test_pool().await;

        let result = poll_tv_pairing(&pool, "this-poll-token-was-never-issued")
            .await
            .expect("poll_tv_pairing should succeed");

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn claiming_an_already_claimed_code_fails() {
        let pool = test_pool().await;
        let first_username = unique_username("tv_pair_first");
        let first_user = create_user(&pool, &first_username, "pairer-pass-123", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");
        let second_username = unique_username("tv_pair_second");
        let second_user = create_user(&pool, &second_username, "pairer-pass-456", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let pairing = start_tv_pairing(&pool)
            .await
            .expect("start_tv_pairing should succeed");

        claim_tv_pairing(&pool, &pairing.code, first_user.id)
            .await
            .ok()
            .expect("the first claim of a fresh pairing code should succeed");

        let second_claim = claim_tv_pairing(&pool, &pairing.code, second_user.id).await;
        assert!(
            matches!(second_claim, Err(ClaimPairingError::InvalidOrExpired)),
            "claiming an already-claimed pairing code should fail as InvalidOrExpired"
        );

        cleanup_user(&pool, &first_username).await;
        cleanup_user(&pool, &second_username).await;
    }

    #[tokio::test]
    async fn claiming_with_a_code_that_was_never_issued_fails() {
        let pool = test_pool().await;
        let username = unique_username("tv_pair_noone");
        let user = create_user(&pool, &username, "pairer-pass-123", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let result = claim_tv_pairing(&pool, "ZZZ999", user.id).await;
        assert!(matches!(result, Err(ClaimPairingError::InvalidOrExpired)));

        cleanup_user(&pool, &username).await;
    }

    #[tokio::test]
    async fn poll_after_claim_is_single_use() {
        let pool = test_pool().await;
        let username = unique_username("tv_pair_singleuse");
        let user = create_user(&pool, &username, "pairer-pass-123", false)
            .await
            .ok()
            .expect("create_user should succeed for a new username");

        let pairing = start_tv_pairing(&pool)
            .await
            .expect("start_tv_pairing should succeed");
        claim_tv_pairing(&pool, &pairing.code, user.id)
            .await
            .ok()
            .expect("claim should succeed");

        let first_poll = poll_tv_pairing(&pool, &pairing.poll_token)
            .await
            .expect("poll_tv_pairing should succeed");
        assert!(matches!(first_poll, Some(PairingPollResult::Claimed { .. })));

        let second_poll = poll_tv_pairing(&pool, &pairing.poll_token)
            .await
            .expect("poll_tv_pairing should succeed");
        assert!(
            second_poll.is_none(),
            "polling again after the pairing row was consumed should return None"
        );

        cleanup_user(&pool, &username).await;
    }
}
