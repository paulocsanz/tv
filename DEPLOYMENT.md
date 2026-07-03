# Deployment Guide

## Git Setup

Repository initialized at `/Users/paulo/software/tv`. To push to a remote:

```bash
# Add remote (choose one):
git remote add origin https://github.com/YOUR_USERNAME/tv.git          # GitHub
git remote add origin https://gitlab.com/YOUR_USERNAME/tv.git          # GitLab
git remote add origin git@github.com:YOUR_USERNAME/tv.git              # GitHub SSH

# Push to remote
git branch -M main
git push -u origin main
```

## Railway Deployment

The `.railway/railway.ts` (Infrastructure as Code) automatically defines two services:

### Backend (Rust + Axum)
- Reads from `backend/Dockerfile` (multi-stage build)
- Serves API on port 8080
- Uses enriched_400.json (generated locally via `backend/target/release/enrich`)
- Health check: `/health`

### Frontend (Next.js 14)
- Runs `npm run build` and `npm start`
- Connects to backend via `NEXT_PUBLIC_API_URL` environment variable
- Serves on port 3000

### Local Data (Torrents)
- **Not in git** — torrents stay local in `/downloads`
- `backend/data/` is gitignored
- Before deploying backend, generate enriched data locally:
  ```bash
  cd backend
  ./target/release/enrich  # generates backend/data/enriched_400.json
  ```

### To Deploy via Railway
1. Push code to git (see Git Setup above)
2. Link project to Railway IaC:
   ```bash
   railway link  # or use GUI
   ```
3. Railway will read `.railway/railway.ts` and create/update services
4. Services build and deploy automatically on git push

### Environment Variables

Set these in Railway:
- **Backend**: `ENRICHED_DATA_PATH` (optional, defaults to `data/enriched_400.json`)
- **Frontend**: `NEXT_PUBLIC_API_URL` (points to deployed backend URL)

Both are typically auto-configured by Railway when services are linked.
