# Deployment

## App (Railway)

Infrastructure lives in `.railway/railway.ts` (frontend + backend).

- Backend: `backend/` (Rust/Axum), catalog at `backend/data/enriched_400.json`
- Frontend: `frontend/` (Next.js)

Link and deploy via the Railway CLI / dashboard as usual.

## Acquisition pipeline (caixote)

The torrent → transcode → S3 worker is a separate caixote service:

```bash
# Build/push image + apply IaC
./scripts/ops/deploy-pipeline-caixote.sh

# Tail progress
node scripts/ops/monitor-pipeline-caixote.mjs
# or: caixote logs torrent-pipeline
```

Config: `caixote.config.ts`, image: `Dockerfile.pipeline`.

## Local pipeline

From the **repo root**:

```bash
npm run pipeline:pick    # pick magnets
npm run pipeline         # download → transcode → upload
npm run pipeline:monitor # TUI
```

See `README.md` for the full layout and script map.
