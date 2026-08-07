# Living-room playback: decrypt relay + Smart TV without store hell

**Status:** in-progress  
**Updated:** 2026-08-07

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
| **A. PC LAN HTTP relay** | Node (or similar) on PC | `http://lan-ip:port/...` plain HLS | Easiest P0; phone browser cannot listen on a port |
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

## Delivery slices (mandatory)

### P0 — must ship first (useful in one house tonight)

- [x] **P0.1** Spec + this RFC agreed — status: `done`
- [x] **P0.2** User can start a **PC LAN decrypt relay** for one HLS title
  (clear HLS on LAN; catalog key only on PC) — status: `done`
- [x] **P0.3** TV shell (or phone) shows **pair / “play via sala”** and opens
  the relay URL after registration — status: `done`
- [x] **P0.4** Relay dies cleanly when PC stops; TV shows a recoverable error
  — status: `done`

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

## Status (living)

| ID | Band | Title | Status | Task / PR | Updated |
|----|------|-------|--------|-----------|---------|
| P0.1 | p0 | RFC drafted | done | this doc | 2026-08-07 |
| P0.2 | p0 | PC LAN decrypt relay | done | scripts/relay/sala-relay.js | 2026-08-07 |
| P0.3 | p0 | TV play via sala | done | SalaRelayBanner + /api/sala/relay | 2026-08-07 |
| P0.4 | p0 | Relay stop = clear TV error | done | plainHls fatal → onPlainHlsError | 2026-08-07 |
| P1.1 | p1 | Phone WebRTC to TV | todo | — | 2026-08-07 |
| P1.2 | p1 | Multi-ep relay | todo | — | 2026-08-07 |
| P1.3 | p1 | Session-license API (optional) | todo | — | 2026-08-07 |
| P1.4 | p1 | Jellyfin-beside decision | todo | — | 2026-08-07 |
| P2.1 | p2 | Native phone LAN server | todo | — | 2026-08-07 |
| P2.2 | p2 | Custom Cast receiver | todo | — | 2026-08-07 |
| P2.3 | p2 | Android TV store app | todo | — | 2026-08-07 |
| P2.4 | p2 | Tizen/webOS store | todo | — | 2026-08-07 |

## Acceptance Criteria

- **Tests**
  - P0.2: package Matrix (or any HLS title); PC relay serves plain playlist;
    VLC or TV browser on LAN plays end-to-end without catalog key on the TV
  - P0.3: from TV shell after pair, user reaches playing state without typing
    the catalog key on the TV
  - P0.4: kill relay → TV UI leaves “loading” and shows a clear offline/retry
    state within a few seconds
- **Telemetry / Analytics:** none — personal app; optional local relay logs only
- **Documentation:** this RFC; short “Sala / relay” note in README or
  `DEPLOYMENT.md` when P0.2 ships
- **Screenshots:** TV shell “aguardando decryptor” + playing frame (when P0.3
  ships)

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

## Open questions

1. Is **LAN-only** enough for the group, or do we need remote friends
   watching without a house PC? (If remote: session-license or full
   custodial path.)
2. Prefer **PC relay first** (fast) or **phone WebRTC first** (no PC)?
3. Is a **side Jellyfin** acceptable operationally for stock TV apps, or must
   everything stay under the Sessão brand?
