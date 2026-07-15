# Trailer Storage Cost & Scrub-Preview Thumbnail Strategy

**Status:** Draft

## Background

- `c218ce6` (Self-host trailers on S3 instead of embedding YouTube) added a second class of S3-hosted
  video per title, alongside the main feature/episode files.
- `RFC 0001`'s cost-sharing/visibility feature explicitly dropped bytes-served metering ("streaming
  goes through presigned S3 redirects the app doesn't meter directly") and estimates per-user cost
  from watch-time as a proxy. That model was written before trailers existed as a storage/bandwidth
  cost source and has not been revisited since.
- The video player's hover scrub-preview (added 2026-07-11) grabs thumbnails by seeking a second
  hidden `<video>` against the full-resolution S3 stream and drawing the live frame to a canvas -
  there's no pre-generated sprite sheet from the transcode pipeline. The code comment at
  `frontend/components/VideoPlayer.tsx:195-199` calls this out directly as the reason for the current
  approach, not as a considered final design.

## Problems This Solves

- **Cost model blind spot** - trailer storage/bandwidth isn't accounted for anywhere in the
  cost-sharing estimate a Pro/cost-sharing user would see, understating real per-user cost as trailer
  coverage grows across the catalog.
- **Scrub-preview cost/scale question undecided** - live-seeking the full video stream per hover
  works today but issues a real S3 range request (and, after 2026-07-11's fix, a fresh connection)
  every time a user starts scrubbing. Whether that's fine forever or needs a pre-generated sprite
  sheet (cheaper per-hover, extra transcode-pipeline work and storage) has no written decision.

## Proposed Solution

- [ ] **P1** Decide whether trailer storage/bandwidth should be folded into RFC 0001's per-user cost
      estimate, and if so, add it to whatever computes that estimate today.
- [ ] **P2** Decide live-seek vs. sprite-sheet for scrub previews. If sprite-sheet: scope the
      transcode-pipeline work (extract N thumbnails per title, pack into a sprite + VTT-style index)
      and the storage cost across the catalog. If live-seek: leave as-is and close this item.
