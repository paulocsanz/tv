# Storage Encryption & Key Bootstrap

**Status:** Draft

## Background

- Bucket objects (movies, trailers) are stored and served as plaintext today. Playback goes
  through presigned S3 URLs / direct bucket downloads with no content-level protection beyond
  the URL's own expiry - anyone who obtains a URL (leaked link, misconfigured bucket policy,
  logged access) can read the bytes.
- 589 of 801 catalog titles are already self-hosted on S3 as of `bc42b58` (plaintext), with the
  remainder still landing via the acquisition pipeline. Any encryption scheme has to coexist with
  this large existing plaintext library, not require re-uploading it.
- `backend/src/auth.rs` is session-based: passwords are hashed with Argon2id (`hash_password`,
  ~154-160) and never stored raw; sessions are opaque 32-byte tokens, only a SHA-256 hash of the
  token is persisted (`generate_token`/`hash_token`, ~164-173). There is no encryption/KMS/keypair
  code anywhere in the backend or frontend today - Argon2id and SHA-256 are used only for
  authentication, not for protecting content.
- The existing invite system (`create_invite`/`redeem_invite`, ~235-322, from `RFC 0001`) issues
  single-use, 7-day-expiry tokens purely to gate account creation. It carries no secret material
  today beyond the token itself.

## Problems This Solves

- **Bucket content has no protection beyond URL expiry** - a leaked presigned URL or bucket
  misconfiguration exposes full movie/trailer files with nothing else standing in the way.
- **No mechanism to gate decrypt access per account** - even encrypting new uploads solves
  nothing unless there's a way for each account to independently obtain the ability to decrypt,
  without the server itself ever holding a plaintext key.
- **New accounts have no path to shared decrypt access** - the invite flow creates a login today,
  but has no concept of handing off a secret the invitee needs to actually watch anything.

## Proposed Solution

- [ ] **P0** Support AES-256-GCM encryption under one shared catalog key as a per-upload option in
      the acquisition pipeline, not a mandatory default - some new uploads may still land as
      plaintext (e.g. faster path when the extra client-side decrypt step isn't wanted for a given
      title). Add an `encrypted: bool` column to the catalog so the player knows whether to run a
      title through client-side decryption or stream it as-is, regardless of whether it's old or
      newly added. The existing 801-title library stays plaintext and playable unchanged - no
      backfill/re-encryption required by this RFC.
- [ ] **P0** Backend stores, per user, the catalog key wrapped by a key derived from that user's
      password via Argon2id - using a separate salt/domain from the login-verification hash in
      `auth.rs`, so the login hash can never be used to unwrap it. The server persists only the
      wrapped blob and can never decrypt it itself.
- [ ] **P0** On login, the browser independently derives the wrap key from the password
      client-side, fetches its wrapped catalog-key blob, and unwraps it locally. The unwrapped key
      is imported as a non-extractable WebCrypto `CryptoKey` (`extractable: false`) and persisted
      in IndexedDB - not raw bytes in `localStorage` - so it survives reloads without ever
      exposing key material to JS/XSS.
- [ ] **P1** Extend `create_invite`/`redeem_invite` to bootstrap new accounts: the inviting
      user's browser (already holding the unwrapped catalog key) wraps a fresh copy under a
      one-time secret carried only in the invite link's URL fragment, which is never sent to or
      stored by the server. On redemption, the invitee's browser reads the fragment, unwraps the
      catalog key, and re-wraps it under their own new password for storage. Non-custodial
      handoff, no plaintext key ever crosses the server.
- [ ] **P1** Decide whether logout wipes the IndexedDB `CryptoKey` entry (tying local decrypt
      capability to the existing session/`revoke_session` lifecycle) or leaves it until the
      browser profile is cleared. Undecided - needs a call before implementation.
- **Accepted cost, not a bug**: password change or an admin-driven reset via
  `/api/account/password` can restore login but not decrypt access, since the wrap key is
  re-derivable only from the actual password. An account that loses its password with no other
  existing member available to re-invite it loses access to encrypted content permanently. Same
  zero-knowledge tradeoff as Bitwarden/Signal-style key sharing, and intentional.
- **Out of scope**: Postgres-stored data (`watch_progress`, `catalog_edit_log`, profile fields)
  is unaffected - this RFC covers bucket media content only.
