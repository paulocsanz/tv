use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::RwLock;

#[derive(Serialize, Deserialize)]
struct StoredCredentials {
    username: String,
    password_hash: String,
}

pub struct AuthState {
    username: String,
    password_hash: String,
    sessions: RwLock<HashSet<String>>,
}

impl AuthState {
    /// Uses a fixed username/password (e.g. from environment variables).
    /// Nothing is persisted to disk — the hash lives only in memory.
    pub fn from_credentials(username: String, password: &str) -> Self {
        Self {
            username,
            password_hash: hash_password(password),
            sessions: RwLock::new(HashSet::new()),
        }
    }

    /// Loads credentials from `path` if present, otherwise generates a fresh
    /// admin username/password and logs the plaintext password once — only
    /// the argon2 hash is ever persisted to disk.
    pub fn load_or_generate(path: &Path) -> Self {
        if let Some(stored) = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoredCredentials>(&raw).ok())
        {
            tracing::info!(username = %stored.username, "Loaded existing admin credentials");
            return Self {
                username: stored.username,
                password_hash: stored.password_hash,
                sessions: RwLock::new(HashSet::new()),
            };
        }

        let username = "admin".to_string();
        let password = generate_password();
        let password_hash = hash_password(&password);

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("failed to create auth data directory");
        }
        let stored = StoredCredentials {
            username: username.clone(),
            password_hash: password_hash.clone(),
        };
        std::fs::write(path, serde_json::to_string_pretty(&stored).unwrap())
            .expect("failed to persist generated credentials");

        tracing::info!(
            "\n==================== ADMIN LOGIN CREDENTIALS ====================\n\
             username: {username}\n\
             password: {password}\n\
             Shown once — only the hash is stored on disk from now on.\n\
             ==================================================================="
        );

        Self {
            username,
            password_hash,
            sessions: RwLock::new(HashSet::new()),
        }
    }

    pub fn verify(&self, username: &str, password: &str) -> bool {
        if username != self.username {
            return false;
        }
        let Ok(parsed) = PasswordHash::new(&self.password_hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    pub fn create_session(&self) -> String {
        let token = generate_token();
        self.sessions.write().unwrap().insert(token.clone());
        token
    }

    pub fn is_valid(&self, token: &str) -> bool {
        self.sessions.read().unwrap().contains(token)
    }

    pub fn revoke(&self, token: &str) {
        self.sessions.write().unwrap().remove(token);
    }
}

fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("failed to hash password")
        .to_string()
}

fn generate_password() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..20)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn generate_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
