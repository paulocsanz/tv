# Subtitle Acquisition Coverage

**Status:** In Progress  
**Updated:** 2026-08-07

## Background

- The **player already has a full captions system**: custom CC menu in
  `VideoPlayer`, `<track kind="subtitles">` wired to `/api/subtitles/:id/:trackId`,
  backend proxy from S3, user preference `default_subtitle_lang` on `/account`
  (RFC 0002 P1).
- The download pipeline extracts **embedded text** subtitle streams
  (`extractSubtitles` in `transcode.js`) into WebVTT and stores them on
  `item.subtitles`. Languages kept: eng / spa / por.
- Coverage gap as of 2026-08-07 (`backend/data/enriched_400.json`):
  - **~269** titles with video on S3
  - **~85** of those with at least one subtitle track
  - **~184** playable titles with **zero** captions (including The Matrix
    1999 and most YIFY rips)
- The CC button is intentionally hidden when `episodeSubtitles.length === 0`,
  so users correctly report "can't choose subtitles" on those titles — it's a
  data gap, not a missing control.

## Problems This Solves

- **YIFY / WEB-DL rips ship no softsubs.** English audio, no muxed text
  tracks, no sidecar `.srt`. Embedded extraction finds nothing.
- **Sidecar files were treated as cruft.** finalizeItem deleted the whole
  `itemDir` after upload, including any `.srt` the torrent did bundle, and
  nothing converted them to WebVTT first.
- **No path to fill historical gaps.** Titles already on S3 (source deleted
  locally) can't be re-extracted; they need an external source keyed by
  IMDB id.

## Proposed Solution

- [x] **P0** Harvest torrent **sidecar** `.srt`/`.ass`/`.ssa`/`.vtt` next to
      the video (and under `Subs/`) during `processOneVideo`, convert to
      WebVTT, upload, record on `item.subtitles`. Implemented 2026-08-07:
      `findSidecarSubtitles` / `extractSidecarSubtitles` in `transcode.js`,
      wired in `download-picked-torrents.js`.
- [x] **P0** External backfill via **OpenSubtitles.com REST API** for
      titles that still lack eng/por/spa after pipeline extraction.
      Implemented 2026-08-07: `fetch-external-subtitles.js` writes
      `backend/data/subtitle_backfill.json`; backend
      `apply_subtitle_backfill` merges on boot (same side-file pattern as
      trailers).
- [ ] **P1** Run backfill for must-watch titles (start with Matrix + other
      top movies missing por/eng). Requires `OPENSUBTITLES_API_KEY` and a
      backend restart so the merge is visible.
      ```
      export OPENSUBTITLES_API_KEY=...
      # optional higher quota:
      # export OPENSUBTITLES_USERNAME=... OPENSUBTITLES_PASSWORD=...
      node fetch-external-subtitles.js --id the-matrix-1999-movie
      node fetch-external-subtitles.js --limit 50 --langs eng,por
      ```
- [ ] **P1** Prefer torrent options that advertise softsubs (or ship
      multi-lang packs) in `pick-best-torrents.js` / Torrentio ranking so
      new acquisitions need less external fetch.
- [ ] **P2** TV series: only episodes with `episodes[]` metadata (season +
      number) are queried on OpenSubtitles — finish episode-metadata
      backfill coverage so series captions aren't skipped.
- [ ] **P2** Optional UX: show a disabled CC control with "Sem legendas"
      when tracks are empty, so the absence is discoverable rather than
      invisible.

## Non-Goals

- OCR of PGS/VobSub bitmap tracks (expensive, quality-variable).
- Auto-fetching on every play (quota + latency); batch backfill is enough.
- Languages outside eng/por/spa (matches existing `KEPT_SUBTITLE_LANGS`).

## Notes

- OpenSubtitles free tier: limited downloads/day; login raises the cap.
  Consumer API key: https://www.opensubtitles.com/en/consumers
- Side file `subtitle_backfill.json` is required because the live pipeline
  rewrites `enriched_400.json` continuously (same rationale as
  `trailer_backfill.json`).
