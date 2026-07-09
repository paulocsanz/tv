# UX Polish: Onboarding & Self-Serve Profiles

**Status:** Draft

## Background

- Recent feature work (Continue Watching row, per-episode progress bars, skip/keyboard controls,
  subtitle support) added real functionality, but the surrounding shell hasn't kept pace: a bare
  login page, a single `/browse` page, per-title pages, and an unstyled `/admin/users`.
- New users are handed a username/password with zero in-app guidance on first login.
- There's no self-serve place for a user to manage their own account.

## Problems This Solves

- **New users land with no guidance** — no onboarding moment explaining Continue Watching, search,
  or how playback/subtitles work.
- **No self-serve profile/settings** — a user can't change their own password, see their own watch
  history, or set preferences (default subtitle language, autoplay-next) without asking the admin.
- **Empty and edge-case states are minimal** — zero-result search, an empty Continue Watching row,
  and a title with no working stream yet all render as barely-styled defaults.
- **No defined visual identity** — spacing, typography, and color usage are inconsistent across
  login/browse/title pages; it reads as a dev tool rather than a product.

## Proposed Solution

- [ ] **P0** First-login onboarding: a short in-app walkthrough covering Continue Watching,
      search, and playback controls — shown once, skippable.
- [x] **P0** Self-serve `/account` page: change own password, view own watch history.
      Implemented 2026-07-09: `/account` page (linked from Header) + `POST /api/account/password`.
      Reuses the existing continue-watching query for "watch history" rather than a new table.
- [ ] **P1** User preferences on the same page: default subtitle language, autoplay-next-episode.
- [ ] **P1** Real empty states: zero search results, empty Continue Watching, a title with no
      streamable file yet (surface something more useful than a blank/broken player).
- [ ] **P2** Visual consistency pass across login/browse/title pages — shared spacing scale,
      typography, and color tokens layered onto the existing Tailwind setup.
