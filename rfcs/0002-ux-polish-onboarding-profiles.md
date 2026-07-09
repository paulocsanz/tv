# UX Polish: Onboarding & Self-Serve Profiles

**Status:** Implemented

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

- [x] **P0** First-login onboarding: a short in-app walkthrough covering Continue Watching,
      search, and playback controls — shown once, skippable.
      Implemented 2026-07-09: `OnboardingWalkthrough` on the home page. "Shown once" is
      per-browser (localStorage), not per-account — there's no backend field for it yet.
- [x] **P0** Self-serve `/account` page: change own password, view own watch history.
      Implemented 2026-07-09: `/account` page (linked from Header) + `POST /api/account/password`.
      Reuses the existing continue-watching query for "watch history" rather than a new table.
- [x] **P1** User preferences on the same page: default subtitle language, autoplay-next-episode.
      Implemented 2026-07-09: `PreferencesForm` on `/account`, wired into `VideoPlayer` (subtitle
      default and auto-advance to the next episode on end).
- [x] **P1** Real empty states: zero search results, empty Continue Watching, a title with no
      streamable file yet (surface something more useful than a blank/broken player).
      Search (already had one) and "no streamable file" (title page) got real empty states.
      Empty Continue Watching stays hidden rather than showing a placeholder row — matching
      how it already behaved, and how most catalog UIs handle it; the "new user with nothing
      watched yet" case is covered by the onboarding walkthrough instead.
- [x] **P2** Visual consistency pass across login/browse/title pages — shared spacing scale,
      typography, and color tokens layered onto the existing Tailwind setup.
      Audited 2026-07-09: container widths, headings, and form styling were already consistent
      (new pages this session followed existing patterns throughout). One real duplication
      found and fixed: the "Not authorized" admin-gate markup, copy-pasted identically across
      3 admin pages, extracted into a shared `NotAuthorized` component.
