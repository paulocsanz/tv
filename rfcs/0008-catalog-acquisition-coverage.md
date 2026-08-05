# Catalog Acquisition Coverage

**Status:** In Progress  
**Updated:** 2026-08-05

## Background

- Product completeness is gated more by **how much of the catalog is playable** than by missing
  app features. RFCs 0001–0004 (accounts, UX, admin, Oscars) are Implemented; the living-room
  player (Cast/AirPlay, pairing) shipped under RFC 0007 P1.
- As of 2026-08-05 the catalog has **1031** items (`backend/data/enriched_400.json`):
  - **265 on S3** (~26% playable end-to-end)
  - **183** with a torrent picked but not yet uploaded (queue for the pipeline)
  - **583** with neither torrent nor S3 (almost all movies — largely Oscar metadata-only adds
    from RFC 0004, which deliberately did not run acquisition)
- By type: all **5 courses** on S3; **TV** 85/198 on S3 (113 torrent-only); **movies** 175/828
  on S3, 70 torrent-only, **583 with no acquisition path at all**.
- Pipeline deploy-as-code for caixote (`caixote.config.ts`, `Dockerfile.pipeline`,
  `scripts/deploy-pipeline-caixote.sh`) exists uncommitted — the worker is how the 183-item
  torrent queue becomes playable.

## Problems This Solves

- **Most titles are browseable but not watchable** — empty player state, not a code bug.
- **Oscar expansion inflated the "no torrent" queue** without a plan for which titles to
  actually acquire (RFC 0004 explicitly deferred this).
- **Pipeline capacity / host** — local lock + ad-hoc runs don't scale to hundreds of remaining
  downloads; remote worker packaging is half-done.

## Proposed Solution

- [ ] **P0** Keep the acquisition pipeline healthy and draining the **183** torrent-ready items
      (movies + TV already picked). Prefer the caixote worker over a laptop run when disk/CPU
      allow. Sync `s3_key`/`s3_keys`/`subtitles` back into `enriched_400.json` after each batch
      (pattern already used — see uncommitted catalog delta for Life on Earth, etc.).
      **2026-08-05:** local lock cleared; caixote `torrent-pipeline` is **running** again
      (after restart; logs API still flaky 502). ENCRYPT_UPLOADS left off so this drain stays
      plaintext until encryption is bootstrapped intentionally.
- [ ] **P1** For the **583** no-torrent movies: define a triage policy (must-have / nice / skip),
      then re-search via `/admin/catalog` Re-search or `pick-best-torrents.js` only for the
      must-have set. Do not treat "every Best Picture nominee on S3" as the definition of done.
- [ ] **P1** Finish and commit caixote pipeline packaging (Dockerfile, bootstrap, monitor script,
      `caixote.config.ts`) so restarts are declarative, not tribal knowledge.
- [ ] **P2** TV series completeness: many of the 85 "on S3" shows have only a handful of
      episodes uploaded — track partial series (e.g. `< N` episodes vs expected) separately from
      "has any s3_key" so the queue targets full seasons, not one-off eps.
- [ ] **P2** Drop or regenerate stale review files (`original-titles-flagged.json` currently
      references 0 live catalog ids) so admin queues aren't noise.
