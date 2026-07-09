---
name: pipeline-status
description: Check on, diagnose, and (if needed) restart the torrent-to-S3 acquisition pipeline (download-picked-torrents.js). Use whenever the user asks "check progress", "is it stuck", "status", "are we uploading", or anything about the download/transcode/upload pipeline's health.
argument-hint: "[--restart] [--watch]"
---

# Pipeline Status Skill

Diagnoses the state of `download-picked-torrents.js`, the background process that downloads
picked torrents, transcodes them to browser-playable MP4, and uploads them to the Railway S3
bucket. This process is meant to run unattended for hours, so its most common failure modes are
silent: it looks alive in `ps` but has actually stalled, or two copies end up running at once and
collide.

## What "healthy" looks like

- Exactly one `node download-picked-torrents.js` process, PID matching `.download-picked-torrents.lock`.
- `pipeline-events.jsonl` has gotten a new line within the last ~10 minutes.
- At least one `aria2c` or `ffmpeg` child is burning real CPU (not stuck at ~0%).

## Step 1: Process check

```bash
ps aux | grep -E "[n]ode download-picked|[a]ria2c|[f]fmpeg"
cat /Users/paulo/software/tv/.download-picked-torrents.lock 2>/dev/null; echo
```

- **No node process, but lockfile exists with a dead PID** → stale lock, safe to delete and restart.
- **More than one `node download-picked-torrents.js`** → this has happened before (an orphaned
  instance from a prior session survived past the lockfile check, or two terminals raced before
  the lock existed) and causes real damage: both instances download the same items into the same
  `downloads/<id>/` directory and transcode into the same deterministic temp filename
  (`downloads/.transcoded/<id>__<name>.mp4`), so they delete each other's in-progress files out
  from under themselves. Kill all but the one matching the lockfile PID immediately.

## Step 2: Staleness check

```bash
tail -5 /Users/paulo/software/tv/pipeline-events.jsonl
ls -la /Users/paulo/software/tv/pipeline-events.jsonl
date
```

Compare the last event's `ts` (epoch ms) to now. If it's more than ~10 minutes stale while the
process is still "running", it's not making progress even though it looks alive.

To tell a genuine stall (not just one slow item) from real-but-slow progress, check whether the
live aria2c/ffmpeg children are actually consuming CPU:

```bash
ps -p <pid1> -p <pid2> -o pid,%cpu,time
sleep 8
ps -p <pid1> -p <pid2> -o pid,%cpu,time
```

If `TIME` hasn't moved across that window, it's frozen (this has happened after long unattended
runs — suspected stale DHT/peer connections after a sleep/wake cycle; a full connectivity check
with `ping`/`curl` will show the internet itself is fine). The fix is a clean restart, not waiting
longer.

## Step 3: Read the run summary

```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('/Users/paulo/software/tv/pipeline-events.jsonl','utf-8').trim().split('\n').map(JSON.parse);
const lastStart = [...lines].reverse().find(e => e.type === 'pipeline_start');
console.log('run started:', new Date(lastStart.ts).toISOString(), lastStart);
console.log('items fully done (all-time):', lines.filter(e => e.type === 'item_done').length);
console.log('items failed (all-time):', lines.filter(e => e.type === 'item_failed').length);
"
```

`pipeline_start` logs `picked`/`fastQueued`/`riskyQueued` counts — sanity-check that riskyQueued
isn't the whole queue (would mean the seeder-threshold split is misfiring).

## Step 4: Diagnose repeat offenders (optional, if something looks looped)

If the same title keeps appearing in `download_error`/`item_failed` across many `pipeline_start`
boundaries, check its current option index against how many options it has:

```bash
node -e "
const data = JSON.parse(require('fs').readFileSync('/Users/paulo/software/tv/backend/data/enriched_400.json', 'utf-8'));
const item = data.items.find(i => i.title.includes('TITLE HERE'));
console.log('index:', item.current_torrent_index_720p, '/ options:', item.torrent_options_720p?.length);
console.log('s3_key:', item.s3_key);
"
```

If the index is already at the last option, there's nothing left to fall back to — it'll keep
retrying the same doomed torrent forever until either a seed count improves or someone manually
resets the index / picks a different option. Note: `content_type === "movie"` items only need
**one** file to succeed to be marked done (a bundled bonus file that's permanently broken, e.g. a
second-resolution rip that never transcodes, no longer blocks the whole item) — TV items still
need every episode.

## Step 5: Restart cleanly (only if Step 1-2 show it's actually stuck/orphaned)

**Never edit `backend/data/enriched_400.json` while the process is still alive** — its own
periodic `fs.writeFileSync` will clobber your edit with its stale in-memory copy on the next save.
Kill first, edit second, restart third.

```bash
kill <pid>
sleep 5
ps -p <pid>                                    # confirm it's gone
cat /Users/paulo/software/tv/.download-picked-torrents.lock 2>/dev/null; echo   # confirm lock cleared
```

If it doesn't exit within ~5-10s (the shutdown handler waits for in-flight uploads to finish
rather than killing them mid-transfer — that's intentional, an interrupted upload throws away
every byte already sent), give it more time before escalating to `kill -9`.

Then restart detached so it survives the terminal closing:

```bash
cd /Users/paulo/software/tv
nohup node download-picked-torrents.js > pipeline-console.log 2>&1 &
disown
sleep 5
ps aux | grep "[n]ode download-picked"
tail -20 pipeline-console.log
```

For live-tailing without touching the pipeline itself, point the user at:

```bash
tail -f /Users/paulo/software/tv/pipeline-console.log
```

`Ctrl+C` on that `tail` only stops watching — it's a separate process from the pipeline.

## Step 6: Report

Summarize in plain terms: is it running, is it stuck, what's it working on right now, how many
items have been fully uploaded this run vs all-time, and whether anything needs the user's
attention (e.g. an item permanently stuck with no fallback options left, or disk filling up —
`df -h .` and `du -sh downloads` are worth a glance if uploads seem to be lagging behind
downloads).
