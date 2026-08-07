# tv (vete)

Private streaming catalog: **Next.js** frontend, **Rust** backend, and a
**torrent → transcode → S3** acquisition pipeline.

## Layout

```
backend/                 Rust API + catalog JSON (backend/data/)
frontend/                Next.js app
lib/                     Shared Node helpers (encryption, HLS packaging)
scripts/
  pipeline/              Acquisition: pick, download, transcode, HLS, reencrypt
  catalog/               One-shot TMDB/metadata backfills & data fixes
  ops/                   Deploy / monitor the caixote pipeline worker
docker/                  Pipeline image entrypoint helpers
rfcs/                    Design docs
data/                    Curated seed lists (not the live catalog)
caixote.config.ts        Pipeline worker IaC
Dockerfile.pipeline      Pipeline container image
```

Run all Node scripts **from the repo root** (`process.cwd()` resolves
`backend/data/` and `downloads/`).

## App

```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend
cd backend && cargo run
```

## Acquisition pipeline

```bash
# 1. Pick magnets for catalog titles
npm run pipeline:pick
# or: node scripts/pipeline/pick-best-torrents.js

# 2. Download → transcode → upload (long-running)
npm run pipeline
# or: node scripts/pipeline/download-picked-torrents.js

# Live TUI against pipeline-events.jsonl
npm run pipeline:monitor
```

Remote worker (caixote):

```bash
./scripts/ops/deploy-pipeline-caixote.sh
node scripts/ops/monitor-pipeline-caixote.mjs
```

Other pipeline tools (from repo root):

| Script | Purpose |
|--------|---------|
| `scripts/pipeline/pick-torrentio.js` | Brazilian titles via Torrentio |
| `scripts/pipeline/package-hls-from-s3.js` | HLS AES-128 packaging |
| `scripts/pipeline/reencrypt-from-s3.js` | At-rest re-encryption |
| `scripts/pipeline/fetch-external-subtitles.js` | OpenSubtitles backfill |
| `scripts/pipeline/download-trailers.js` | Self-host trailers on S3 |

## Catalog maintenance

One-shot backfills live under `scripts/catalog/` (TMDB collections, keywords,
translations, Oscars, poster fixes, etc.). Run only when you know you need
them — they touch `backend/data/*.json`.

## Requirements

- Node 20+
- `aria2c` and `ffmpeg` for the pipeline
- S3 credentials (`S3_*` env) and, for encrypted uploads, `ENCRYPTION_CATALOG_KEY`
