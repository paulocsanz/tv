---
name: infra-usage
description: Check Railway bucket storage size, project compute usage, and disk space for this project. Use when the user asks about storage size, bucket usage, billing, disk space, or "how much are we using".
argument-hint: ""
---

# Infra Usage Skill

Reports on the resources this project actually consumes: the S3-compatible bucket that holds
transcoded videos, Railway project compute, and local disk space used by the download pipeline.

## Bucket storage (video files)

```bash
railway bucket list --json
railway bucket info --bucket convenient-pannikin --json
```

Returns `objects` (file count) and `storage` / `storageBytes` — this is the actual video library
size sitting in S3.

## Railway compute usage

```bash
railway status --json
railway metrics --all --json --since 30d
```

`metrics --all` gives current CPU/memory utilization and volume usage per service (db, frontend,
backend) — it's a live snapshot, not cumulative billing. `status --json` lists services, volumes,
and the Postgres volume's `currentSizeMB` / `sizeMB` cap.

**There is no CLI command for dollar billing totals.** `railway usage` doesn't exist and
`metrics` only reports resource utilization, not cost. For an actual bill, the answer is always
"check the dashboard" — offer to run `railway open` to take the user there rather than guessing.

## Local disk (download pipeline staging area)

```bash
df -h /Users/paulo/software/tv
du -sh /Users/paulo/software/tv/downloads 2>/dev/null
du -sh /Users/paulo/software/tv/downloads/.transcoded 2>/dev/null
```

`downloads/` holds in-flight torrent downloads (cleaned up per-item once fully uploaded — see
`pipeline-status` skill); `.transcoded/` holds finished transcodes waiting to upload (also
reused across restarts rather than being redone, so it's normal for this to hold several GB at
once during a long run). Large sustained growth here without matching upload progress is worth
flagging — see `pipeline-status` for diagnosing a pipeline that's downloading faster than it
uploads.

## Report format

State plainly: bucket size + object count, Postgres volume usage vs its cap, current compute
utilization (should be near-idle for this app's traffic), and local disk headroom. Flag anything
approaching a limit (e.g. Postgres volume nearing its `sizeMB` cap, local disk getting tight
during a big pipeline run).
