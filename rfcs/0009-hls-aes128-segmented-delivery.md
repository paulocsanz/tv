# HLS AES-128 Segmented Delivery

**Status:** In Progress  
**Updated:** 2026-08-07

## Background

- Encrypted titles today use **SSESENC1** (chunked AES-256-GCM) as a single
  progressive object. The player decrypts linearly into MSE.
- Seek only works inside already-decrypted buffer; network drops kill one long
  `fetch` and stall playback (poor UX on Matrix-scale files).
- Catalog key remains non-custodial (per-user wrap, invite handoff — RFC 0006).

## Problems This Solves

- **Cannot scrub to unbuffered time** on encrypted titles
- **Fragile reconnect** after network blips mid-stream
- **No segment-level retry** (whole-file progressive pipeline)

## Proposed Solution

- Package titles as **HLS VOD** (≈4s MPEG-TS segments) encrypted with
  **AES-128-CBC** via standard `#EXT-X-KEY` (ffmpeg `hls_key_info_file`)
- Segment key = first **16 bytes** of the 32-byte catalog media key (domain:
  same shared catalog key; server never stores it)
- Playlist key URI is a client-only sentinel `sessao-key:catalog` — **hls.js**
  custom loader injects the key from IndexedDB; S3 never holds the raw key
- S3 layout: `videos/{id}/hls/index.m3u8` + `segNNNN.ts`
- Backend rewrites playlist segment lines to **presigned** S3 URLs (auth
  gate); ciphertext segments are useless without the catalog key
- Catalog: `hls_playlist_s3_key` + keep `encrypted: true` when HLS-AES is used
- SSESENC1 progressive path remains for titles not yet re-packaged

## Delivery slices (mandatory)

### P0 — must ship first (one title end-to-end)
- [x] **P0.1** RFC + catalog field `hls_playlist_s3_key` + backend playlist rewrite — status: `done`
- [x] **P0.2** Packaging tool (ffmpeg HLS AES-128) + S3 upload — status: `done`
- [x] **P0.3** VideoPlayer hls.js path + `sessao-key:catalog` loader — status: `done`
- [x] **P0.4** Package Matrix (or one classic) and verify seek past buffer + reconnect — status: `done`

### P1 — next
- [ ] **P1.1** Batch `package-hls-from-s3.js` worker for all encrypted single-file movies — status: `todo`
- [ ] **P1.2** Per-episode HLS for series (`…/hls/e{n}/`) — status: `todo`
- [ ] **P1.3** Pipeline greenfield: new uploads emit HLS-AES instead of SSESENC1 — status: `todo`

### P2 — later
- [ ] **P2.1** Multi-bitrate ladders + master playlist — status: `todo`
- [ ] **P2.2** Cast/AirPlay for HLS encrypted (custom receiver or clear key path) — status: `todo`
- [ ] **P2.3** Retire SSESENC1 progressive for fully migrated titles — status: `todo`

## Status (living)

| ID | Band | Title | Status | Updated |
|----|------|-------|--------|---------|
| P0.1 | p0 | Catalog + playlist API | done | 2026-08-07 |
| P0.2 | p0 | Packaging tool | done | 2026-08-07 |
| P0.3 | p0 | hls.js player | done | 2026-08-07 |
| P0.4 | p0 | One title packaged in prod | done | 2026-08-07 |
| P1.1 | p1 | Batch packager worker | todo | 2026-08-07 |
| P1.2 | p1 | Series episodes | todo | 2026-08-07 |
| P1.3 | p1 | Pipeline greenfield HLS | todo | 2026-08-07 |
| P2.1 | p2 | ABR ladders | todo | 2026-08-07 |
| P2.2 | p2 | Cast/AirPlay HLS | todo | 2026-08-07 |
| P2.3 | p2 | Retire SSESENC1 | todo | 2026-08-07 |

## Acceptance Criteria

- **Tests:** Package a short sample locally; playlist rewrite unit-ish check; manual seek to mid-film on Matrix HLS
- **Telemetry:** none (personal app)
- **Documentation:** this RFC; Account copy unchanged (same catalog key)
- **Screenshots:** seek bar jumps past previously-undecrypted region after P0.4

## Out of scope

- Widevine / FairPlay / commercial DRM
- Server-side custody of catalog key
- Changing per-user wrap / invite model (still RFC 0006)
