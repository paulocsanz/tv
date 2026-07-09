# Admin/Ops Dashboard

**Status:** Draft

## Background

- All catalog and pipeline operations happen via one-off Node scripts run from a terminal
  (`backfill-*.js`, `clean-adult-mismatches.js`, `download-picked-torrents.js`, and friends),
  diagnosed by reading `pipeline-events.jsonl` and ad hoc `ps`/log inspection — now formalized as
  the `pipeline-status` and `whats-next` Claude Code skills, but still CLI-only.
- The only web admin surface is `/admin/users` — an account list and create-user form. There's
  nothing for catalog health, pipeline status, or the data-quality review backlog.
- Data-quality review currently lives in local JSON files on the admin's laptop
  (`original-titles-flagged.json`, `bloated-uploads.json`, etc.) — invisible to anyone else and
  gone the moment they're cleaned up.

## Problems This Solves

- **Pipeline health is invisible without a terminal** — no way to see "is it stuck," "what's
  uploading right now," or "how much disk is left" without shell access to the host.
- **The data-quality backlog has no UI** — flagged title mismatches, items with zero torrent
  options, and items that exhausted retries all live in scratch files, not a reviewable queue.
- **No audit trail for catalog edits** — backfill scripts write directly to `enriched_400.json`
  with no record of who changed what or why beyond git commit messages.

## Proposed Solution

- [x] **P0** `/admin/pipeline` page: surface the same signals `pipeline-status` already checks —
      process alive, last event timestamp, items done/failed this run — via a small backend
      endpoint that reads `pipeline-events.jsonl`. Implemented 2026-07-09: `GET /api/admin/pipeline`
      + `/admin/pipeline` page. Disk usage deliberately left out of this cut — `du -sh downloads`
      over hundreds of GB is too slow for a page-load request; the `infra-usage` skill already
      covers that separately.
- [ ] **P1** `/admin/catalog` page: a reviewable queue of items needing a human decision — zero
      torrent options, flagged title mismatches, exhausted retries — replacing the current
      read-a-JSON-file-on-disk workflow.
- [ ] **P2** Trigger the most-repeated one-off actions (e.g. re-run torrent search for a single
      title) from the dashboard instead of the terminal.
- [ ] **P2** Log catalog edits made through the dashboard (who, what field, old/new value) as a
      lightweight audit trail, distinct from git history which only shows bulk script runs.
