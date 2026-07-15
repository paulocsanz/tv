# Multi-Device Playback Support (Casting & Smart TVs)

**Status:** Draft

## Background

- The app is browser-only today: `frontend/components/VideoPlayer.tsx` plays video via a plain
  `<video>` element sourced from `/api/stream/[id]` (`frontend/app/api/stream/[id]/route.ts`), which
  redirects to a presigned S3 URL served as progressive MP4 over HTTP range requests. No HLS/DASH, no
  adaptive bitrate, no casting.
- `frontend/components/WebTorrentPlayer.tsx` covers in-progress downloads via client-side WebTorrent -
  a browser-only mechanism (WebRTC-based) with no path onto TV hardware or native TV apps.
- A multi-agent research pass (23 primary sources, adversarially verified) looked at how to reach
  smart TVs and casting devices with the least engineering effort. Findings below are effort-ranked,
  not exhaustive - see Open Questions for what the verification pass could **not** confirm.

## Problems This Solves

- **No way to get content onto a TV at all** - every viewing session today is stuck on whatever
  screen the browser tab is on (laptop, phone, tablet).
- **No casting support** - neither Google Cast nor AirPlay is wired up, despite both being reachable
  as sender-side-only additions to the existing `<video>` element with no server changes for basic
  playback.
- **No smart TV app** - Samsung Tizen, LG webOS, Roku, Fire TV/Android TV, and Apple TV are all
  unreachable natively.
- **Stream URL model doesn't extend to casting** - `/api/stream/[id]` only ever hands back an HTTP
  redirect; a Cast receiver needs the actual resolved absolute S3 URL to fetch the media directly,
  which nothing today exposes as data.

## Proposed Solution

- [ ] **P1 - Casting (Google Cast + AirPlay)**
  - Add AirPlay via `video.webkitShowPlaybackTargetPicker()` on the existing `<video>` element - no
    SDK, no server change, works with the current progressive MP4 as-is.
  - Add Google Cast via the Cast Web Sender SDK - sender-side JS only; the receiver is Google's own
    hosted CAF app, so no custom receiver to build or host.
  - Expose the resolved absolute presigned S3 URL from `/api/stream/[id]` (today only reachable via
    HTTP redirect) so the Cast receiver can fetch the media directly.
  - Note: AirPlay reaches Roku devices/TVs too (Roku OS has shipped AirPlay 2 + HomeKit support since
    Roku OS 9.4, 2020) - Google Cast does not, Roku has no native Cast protocol support at all.
- [ ] **P2 - LG webOS wrapper**
  - webOS is a standards-based, Chromium-powered web-app platform. Jellyfin's `jellyfin-webos` client
    shows the minimum viable investment is a thin native wrapper/login-shim around the existing hosted
    web app, not a rewrite - same approach applies to this app's existing Next.js frontend.
- [ ] **P3 - HLS packaging**
  - Only needed for AirPlay-2-direct-to-smart-TV and native tvOS playback, not basic Safari AirPlay or
    Cast (both already work against plain progressive MP4).
  - Apple's HLS spec requires fMP4/MPEG-TS containers - the current progressive MP4 doesn't conform,
    so this is a real transcode/segment pipeline addition, not a config change.
  - The current presigned-URL-per-request model (`/api/stream/[id]` redirect) doesn't cleanly extend
    to a manifest referencing many segment URLs - needs its own design.
- [ ] **P4 - Native Roku channel / native tvOS app**
  - Roku: BrightScript/SceneGraph is a genuinely separate codebase, language, and UI paradigm from the
    web frontend - no code or component reuse.
  - tvOS: Apple deprecated the TVMLKit hybrid (web-ish) model at WWDC 2024 in favor of SwiftUI/UIKit -
    there is no web-hosted path onto tvOS anymore, only a fully native Swift app.
  - Both are the most expensive tier; defer until P1-P3 are shipped and real usage justifies it.

## Open Questions

- Whether Samsung Tizen and Amazon Fire TV are actually as web-app-friendly as their official docs
  suggest - claims to this effect did not survive adversarial verification and need targeted
  follow-up, not just a re-read of the docs.
- What Plex, Emby, and Stremio actually do differently (or the same) across Roku, tvOS, and Fire TV -
  no claims about their client architecture survived verification, so there's no confirmed prior-art
  comparison beyond Jellyfin/webOS.
