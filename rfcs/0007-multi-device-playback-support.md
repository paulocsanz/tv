# Multi-Device Playback Support (Casting & Smart TVs)

**Status:** In Progress  
**Updated:** 2026-08-05

## Background

- The app plays progressive MP4 from S3 via a presigned URL (`/api/stream/[id]` → backend stream
  endpoint). No HLS/DASH, no adaptive bitrate.
- `frontend/components/WebTorrentPlayer.tsx` covers in-progress downloads via client-side WebTorrent -
  browser-only (WebRTC), not useful on TV hardware.
- A multi-agent research pass (23 primary sources, adversarially verified) ranked paths onto smart
  TVs / casting by effort - see Open Questions for what verification could **not** confirm.

## Problems This Solves

- **Getting content onto a living-room screen** - laptop/phone browser alone is not the goal.
- **Smart TV native apps still missing** - Samsung Tizen, LG webOS, Roku, Fire TV, Apple TV are not
  packaged as installable apps yet (casting covers many living-room cases without them).

## Proposed Solution

- [x] **P1 - Casting (Google Cast + AirPlay)** — Implemented (commit `3cb262b` + follow-ups).
  - AirPlay via `video.webkitShowPlaybackTargetPicker()` on the existing `<video>` element.
  - Google Cast via Cast Web Sender SDK (default CAF receiver; no custom receiver).
  - `/api/stream/[id]` returns the resolved absolute presigned S3 URL as JSON for Cast receivers
    (see comment in `frontend/app/api/stream/[id]/route.ts`).
  - TV device pairing (`/pair` + `POST /api/tv/pair/*`) lets a phone claim a session code shown on
    a TV browser — separate from Cast/AirPlay, same "watch on the big screen" goal.
- [x] **P1b - In-browser TV shell** — 2026-08-05
  - `/tv` pairing → `/tv/home` 10-foot UI (rows, D-pad focus, overscan padding)
  - `/tv/title/[id]` full-screen player without desktop chrome
  - Root layout hides header/footer when `x-sessao-shell: tv` (middleware)
- [ ] **P2 - LG webOS wrapper**
  - webOS is Chromium-based. Jellyfin's `jellyfin-webos` shows the MVP is a thin native
    wrapper/login-shim around the hosted web app, not a rewrite.
  - **Start here:** package `/tv` as the webOS start URL; pairing remains cold-start.
- [ ] **P3 - HLS packaging**
  - Only needed for AirPlay-2-direct-to-smart-TV and native tvOS playback, not basic Safari AirPlay
    or Cast (both work against progressive MP4).
  - Requires fMP4/MPEG-TS segment pipeline + a stream model that can mint many segment URLs from
    one auth session — not a config change.
  - **Start here:** only pick this up if P2/webOS or a real tvOS need forces it; otherwise leave.
- [ ] **P4 - Native Roku channel / native tvOS app**
  - Roku (BrightScript/SceneGraph) and tvOS (SwiftUI only post-WWDC 2024) are full rewrites.
  - Defer until P1–P2 are used in practice and living-room demand is clear.
  - **Start here:** do nothing until usage justifies it.

## Open Questions

- Whether Samsung Tizen and Amazon Fire TV are actually as web-app-friendly as their official docs
  suggest - claims to this effect did not survive adversarial verification and need targeted
  follow-up, not just a re-read of the docs.
- What Plex, Emby, and Stremio actually do differently (or the same) across Roku, tvOS, and Fire TV -
  no claims about their client architecture survived verification, so there's no confirmed prior-art
  comparison beyond Jellyfin/webOS.
