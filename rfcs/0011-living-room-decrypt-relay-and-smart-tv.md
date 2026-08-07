# Living-room playback: decrypt relay + Smart TV without store hell

**Status:** draft  
**Updated:** 2026-08-07

<!-- OFICINA_RFC_SLICES
[
  {"id":"P0.1","band":"p0","title":"RFC drafted and harness-approvable","status":"done"},
  {"id":"P0.2","band":"p0","title":"PC LAN decrypt relay for one HLS title","status":"todo"},
  {"id":"P0.3","band":"p0","title":"TV pair / play-via-sala opens relay feed","status":"todo"},
  {"id":"P0.4","band":"p0","title":"Relay stop shows recoverable TV error","status":"todo"},
  {"id":"P1.1","band":"p1","title":"Phone WebRTC decrypt feed into TV","status":"todo"},
  {"id":"P1.2","band":"p1","title":"Multi-ep relay (hls/e{n}/)","status":"todo"},
  {"id":"P1.3","band":"p1","title":"Optional session-license API for Cast/third-party","status":"todo"},
  {"id":"P1.4","band":"p1","title":"Jellyfin-beside vs pure Sessão decision","status":"todo"},
  {"id":"P2.1","band":"p2","title":"Native phone LAN HTTP relay","status":"todo"},
  {"id":"P2.2","band":"p2","title":"Custom Cast receiver","status":"todo"},
  {"id":"P2.3","band":"p2","title":"Android TV store client","status":"todo"},
  {"id":"P2.4","band":"p2","title":"Tizen/webOS store packaging","status":"todo"}
]
-->

## Background

- Sessão already plays in the **browser**: HLS AES-128 (RFC 0009) with the
  catalog key unlocked client-side (RFC 0006). Pairing for TV shell exists
  (RFC 0007).
- Smart TV **app stores** (Tizen, webOS, Android TV) approve thin clients,
  not “private Netflix with custom crypto.” Jellyfin/Plex/Emby ship **clients
  that talk to a server the user configures**; certification targets the
  client, not the library.
- Default **Chromecast / CAF receivers** do not run our `hls.js` key loader
  (`sessao-key:catalog`). Encrypted titles therefore cannot Cast the same way
  plaintext progressive URLs can.
- Store-native approval of a full Sessão app is multi-quarter work (device
  matrix, UX scenario, content policy, demo accounts). The group needs a
  living-room path **before** that.
- Constraint we want to keep: **S3 stays ciphertext**; the web backend should
  not become a permanent custodian of the raw catalog key if we can avoid it.

This RFC captures the plan discussed for “TV burra + phone/PC holds the key,”
including optional integration with already-approved clients—**not** the
incident of missing `hls_playlist_s3_key` flags or packager races.

**Not docs-only.** Implementation lands under `packages/**` (new
`packages/sala-relay` package for the LAN decrypt proxy) plus integration in
`frontend/` and `backend/`. Pipeline path-proof is via `packages/sala-relay`.

## Problems This Solves

- **Smart TV has no usable Sessão icon / player** without years of store work
- **Cast fails** for HLS-AES titles under non-custodial key-in-browser
- **Catalog key must not live on the TV OEM stack** (or on a third-party app
  we do not control)
- Need a path that feels like “Jellyfin in the living room” without running
  full Jellyfin unless we choose to

## Proposed Solution

### Principle

Treat the **phone or computer with an unlocked catalog key** as the
**decryptor of the room**. The TV only receives a **clear feed** (or a
same-origin licensed playlist), via local network, pairing, or an already
approved shell (browser / Cast path once license exists).

```
S3 (HLS AES ciphertext)
        │
        ▼
Phone/PC (Sessão session + catalog key in IndexedDB / local relay)
        │  decrypt segments, re-serve plain HLS or WebRTC
        ▼
TV browser / LAN player / (later) Cast with session license
```

Backend remains **matchmaking + auth** (pair codes, relay registration).
It does **not** decrypt media in P0/P1 of this RFC.

### Three product tracks (pick order, not exclusive)

1. **Decrypt relay (core of this RFC)**  
   Unlocked phone/PC decrypts and feeds the TV.
2. **Approved-client integration (optional side door)**  
   e.g. Jellyfin server beside Sessão for stock TV apps; or later a
   session-license API so third-party/Cast clients can pull from Sessão.
3. **Own store app (explicitly deferred)**  
   Android TV first if we ever certify; Tizen/webOS later. Not blocking
   living-room use.

### Decrypt relay modes

| Mode | Decryptor | TV gets | Notes |
|------|-----------|---------|--------|
| **A. PC LAN HTTP relay** | Node package on PC | `http://lan-ip:port/...` plain HLS | Easiest P0; phone browser cannot listen on a port |
| **B. Phone → TV WebRTC** | Browser tab / PWA on phone | WebRTC media or remuxed stream | No HTTP listen on phone; fits pair UX |
| **C. Phone native mini-server** | Capacitor/Android later | LAN HTTP like A | Best sofa UX; more app surface |

### “Internal redirect”

- TV UI: user hits Play → shows “Aguardando o decryptor da sala…”
- Phone/PC registers a **relay session** after pair (local base URL or
  WebRTC offer).
- Backend stores **only** routing hints (relay id, pair binding, expiry)—not
  keys, not plaintext media.
- TV navigates / loads the feed the relay announced (LAN URL or WebRTC
  answer). Not a 302 to S3 ciphertext.

### Relation to existing RFCs

- **0006** — catalog key wraps, invite envelope (no `#mk=` raw key)
- **0007** — multi-device / Cast / TV shell (this RFC extends living-room)
- **0009** — HLS AES-128 at rest (ciphertext source for the relay)

### Planned code surfaces (P0)

| Area | Paths |
|------|--------|
| LAN decrypt relay package | `packages/sala-relay/` (`package.json`, `src/lan-decrypt-relay.js`, `src/hls-aes-decrypt.js`) |
| Relay unit tests | `packages/sala-relay/src/lan-decrypt-relay.test.js` |
| Fixtures | `packages/sala-relay/fixtures/` |
| Relay registry API | `backend/src/main.rs` + `backend/src/auth.rs` (`/api/tv/relay/*` next to existing `/api/tv/pair/*`) |
| Next proxies | `frontend/app/api/tv/relay/**` |
| TV shell UX | `frontend/app/tv/title/[id]/page.tsx`, `frontend/app/tv/TvPairClient.tsx` |
| Phone “be the decryptor” | `frontend/app/pair/page.tsx` or new sala UI |
| E2E | `frontend/e2e/sala-relay.spec.ts` |

## Delivery slices

### P0 — must ship first (useful in one house tonight)

- [x] **P0.1** Spec + this RFC agreed — status: `done`
- [ ] **P0.2** User can start a **PC LAN decrypt relay** for one HLS title
  (clear HLS on LAN; catalog key only on PC; package under `packages/sala-relay`) — status: `todo`
- [ ] **P0.3** TV shell (or phone) shows **pair / “play via sala”** and opens
  the relay URL after registration — status: `todo`
- [ ] **P0.4** Relay dies cleanly when PC stops; TV shows a recoverable error
  — status: `todo`

### P1 — next

- [ ] **P1.1** Phone **WebRTC** (or equivalent) decrypt feed into TV `/tv`
  without a PC — status: `todo`
- [ ] **P1.2** Relay supports **episode index** (multi-ep `hls/e{n}/`) — status: `todo`
- [ ] **P1.3** Optional **session-license** endpoint (auth → 16-byte AES key
  for playlist) so Cast default / third-party clients can work **if** we
  accept light custody for that session — status: `todo`
- [ ] **P1.4** Decision record: run **Jellyfin beside** Sessão for stock TV
  apps vs pure Sessão relay only — status: `todo`

### P2 — later

- [ ] **P2.1** Phone **native** LAN HTTP relay (Capacitor) — status: `todo`
- [ ] **P2.2** Custom Cast receiver using same license/relay model — status: `todo`
- [ ] **P2.3** Own **Android TV** store client (only if relay/Jellyfin path
  is insufficient) — status: `todo`
- [ ] **P2.4** Tizen / webOS store packaging of the web shell — status: `todo`

## Status

| ID | Band | Title | Status | Task / PR | Updated |
|----|------|-------|--------|-----------|---------|
| P0.1 | p0 | RFC drafted | done | this doc | 2026-08-07 |
| P0.2 | p0 | PC LAN decrypt relay (`packages/sala-relay`) | todo | — | 2026-08-07 |
| P0.3 | p0 | TV pair → open relay feed | todo | — | 2026-08-07 |
| P0.4 | p0 | Relay stop = clear TV error | todo | — | 2026-08-07 |
| P1.1 | p1 | Phone WebRTC to TV | todo | — | 2026-08-07 |
| P1.2 | p1 | Multi-ep relay | todo | — | 2026-08-07 |
| P1.3 | p1 | Session-license API (optional) | todo | — | 2026-08-07 |
| P1.4 | p1 | Jellyfin-beside decision | todo | — | 2026-08-07 |
| P2.1 | p2 | Native phone LAN server | todo | — | 2026-08-07 |
| P2.2 | p2 | Custom Cast receiver | todo | — | 2026-08-07 |
| P2.3 | p2 | Android TV store app | todo | — | 2026-08-07 |
| P2.4 | p2 | Tizen/webOS store | todo | — | 2026-08-07 |

## Acceptance Criteria

### Tests

Concrete commands/files (to exist as each slice lands; run from repo root unless noted).
**Not docs-only** — primary code under `packages/sala-relay/**`.

1. **P0.2 — LAN relay unit (segment decrypt + plain playlist rewrite)**  
   - Files:  
     - `packages/sala-relay/src/hls-aes-decrypt.js`  
     - `packages/sala-relay/src/lan-decrypt-relay.js`  
     - `packages/sala-relay/src/lan-decrypt-relay.test.js`  
   - Command:  
     `node --test packages/sala-relay/src/lan-decrypt-relay.test.js`  
   - Fixture: tiny AES-128 MPEG-TS sample under `packages/sala-relay/fixtures/` (or generate in-test with `crypto`). Assert: decrypted segment bytes match fixture plaintext; rewritten `index.m3u8` has **no** `#EXT-X-KEY` and segment URLs point at the relay host.

2. **P0.2 — Manual LAN smoke (optional local)**  
   - Command (example):  
     `ENCRYPTION_CATALOG_KEY=… node packages/sala-relay/src/lan-decrypt-relay.js --title-id matrix-1999-movie --port 8787`  
   - Then open `http://<lan-ip>:8787/index.m3u8` in VLC or a TV browser. TV must play without holding the catalog key.

3. **P0.3 — Relay registry + pair binding**  
   - Files: `backend/src/main.rs` (handlers next to `tv_pair_*`), `backend/src/auth.rs`, `frontend/app/api/tv/relay/**`  
   - Commands:  
     `cd backend && cargo test tv_relay`  
     `cd frontend && npx tsc --noEmit`  
   - Behavior: after pair claim, phone/PC `POST`s relay base URL; TV `GET` receives that URL for the bound session.

4. **P0.3 / P0.4 — E2E (Playwright)**  
   - File: `frontend/e2e/sala-relay.spec.ts` (patterned on `frontend/e2e/encrypted-playback.spec.ts`)  
   - Command:  
     `cd frontend && npx playwright test e2e/sala-relay.spec.ts`  
   - Cases:  
     - From TV shell after pair, reach playing state **without** typing catalog key on TV.  
     - Kill/stop relay mid-session → UI leaves loading and shows offline/retry within a few seconds (P0.4).

5. **P1.x (when landed)**  
   - WebRTC path: unit tests under `frontend/lib/` + same Playwright suite extended.  
   - Multi-ep: `node --test packages/sala-relay/src/lan-decrypt-relay.test.js` covers `--episode N` / `hls/e{n}/`.  
   - Session-license: `cd backend && cargo test session_license`.

### Telemetry / Analytics

None — personal app; optional local relay logs only (`packages/sala-relay`).

### Documentation

This RFC; short “Sala / relay” section in `README.md` or `DEPLOYMENT.md` when P0.2 ships (how to run the PC relay from `packages/sala-relay`, env vars, LAN firewall note).

### Screenshots

TV shell “Aguardando o decryptor da sala…” + playing frame (when P0.3 ships).

## Threat model (honest)

| Asset | P0 relay |
|-------|----------|
| S3 objects | Remain AES-128 HLS ciphertext |
| Backend | Pairing + relay registry only; no raw catalog key in P0 |
| PC/phone with unlocked key | Can decrypt; plain feed on LAN while relay runs |
| LAN sniffers | Can see plaintext media phone/PC → TV |
| TV OEM / store apps | Never hold catalog key in P0 |

Session-license (P1.3) **weakens** non-custodial guarantees for the duration of
a session; call that out before implementing.

## Out of scope

- Full Widevine/FairPlay / Hollywood DRM
- Guaranteeing Cast works with **zero** server-visible key material (needs
  custom receiver + client crypto; P2.2)
- Replacing HLS packaging (RFC 0009) or invite envelope design (RFC 0006)
- Hosting a public multi-tenant “Sessão cloud” for strangers
- Docs-only work (this RFC expects code under `packages/sala-relay/**`,
  `frontend/`, `backend/`)

## Open questions

1. Is **LAN-only** enough for the group, or do we need remote friends
   watching without a house PC? (If remote: session-license or full
   custodial path.)
2. Prefer **PC relay first** (fast) or **phone WebRTC first** (no PC)?
3. Is a **side Jellyfin** acceptable operationally for stock TV apps, or must
   everything stay under the Sessão brand?
