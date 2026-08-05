# Storage Encryption & Key Bootstrap

**Status:** In Progress  
**Updated:** 2026-08-05

## Background

- Bucket objects (movies, trailers) are stored and served as plaintext today. Playback goes
  through presigned S3 URLs with no content-level protection beyond URL expiry.
- A large plaintext library already exists — any scheme must coexist (optional encrypt for new
  uploads; migrate later).
- Auth is session + Argon2id password hashes; no media-key material on the server.

## Problems This Solves

- **Bucket content has no protection beyond URL expiry**
- **No per-account decrypt capability without server custody of the key**
- **New accounts need a path to shared decrypt access** (invite handoff still P1)

## Proposed Solution

- AES-256-GCM chunked format **SSESENC1** (`lib/media-encryption.cjs` + `frontend/lib/crypto/media.ts`)
- Shared catalog key, wrapped per-user under a password-derived wrap key (PBKDF2-SHA-256 in
  the browser — WebCrypto-native for Smart TV browsers; server login hash stays Argon2id)
- Pipeline encrypts new greenfield uploads when `ENCRYPT_UPLOADS=true` + `ENCRYPTION_CATALOG_KEY`
- Catalog field `encrypted: bool` on items
- Server stores only wrap blobs (`users.catalog_key_wrap` / `catalog_key_wrap_salt`)

## Delivery slices

### P0 — must ship first
- [x] **P0.1** SSESENC1 encrypt/decrypt (Node + browser) — status: `done`
- [x] **P0.2** Catalog `encrypted` flag + pipeline optional encrypt path — status: `done`
- [x] **P0.3** Per-user wrap storage + `/api/crypto/*` + Account bootstrap UI — status: `done`
- [x] **P0.4** Login unlock into IndexedDB + VideoPlayer decrypt path — status: `done`

### P1 — next
- [ ] **P1.1** Invite-link key handoff (URL fragment, non-custodial) — status: `todo`
- [ ] **P1.2** Logout policy for IndexedDB key (wipe vs keep) — status: `todo`
- [ ] **P1.3** Streaming decrypt (MSE / range) instead of full download — status: `todo`

### P2 — later
- [ ] **P2.1** Batch re-encrypt existing plaintext library — status: `todo`
- [ ] **P2.2** Cast/AirPlay path for encrypted titles (custom receiver or pre-decrypt) — status: `todo`

## Status (living)

| ID | Band | Title | Status | Updated |
|----|------|-------|--------|---------|
| P0.1 | p0 | SSESENC1 codec | done | 2026-08-05 |
| P0.2 | p0 | Pipeline optional encrypt | done | 2026-08-05 |
| P0.3 | p0 | Wrap storage + bootstrap UI | done | 2026-08-05 |
| P0.4 | p0 | Login unlock + player | done | 2026-08-05 |
| P1.1 | p1 | Invite handoff | todo | 2026-08-05 |
| P1.2 | p1 | Logout key policy | todo | 2026-08-05 |
| P1.3 | p1 | Streaming decrypt | todo | 2026-08-05 |
| P2.1 | p2 | Re-encrypt library | todo | 2026-08-05 |
| P2.2 | p2 | Encrypted cast | todo | 2026-08-05 |

## Acceptance Criteria

- **Tests:** Node roundtrip on SSESENC1; cargo check for crypto routes
- **Telemetry:** none (personal app)
- **Documentation:** this RFC + Account UI copy for pipeline env
- **Screenshots:** n/a backend-heavy

## Out of scope

- Encrypting Postgres fields
- Server-side decryption of media
