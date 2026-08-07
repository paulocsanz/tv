#!/usr/bin/env node

/**
 * Live TUI dashboard for download-picked-torrents.js.
 *
 * Reads pipeline-events.jsonl (structured, one-event-per-line) rather than
 * parsing the human-readable log text - concurrent workers writing to the
 * same redirected stdout produce buffered, interleaved output that reads
 * misleadingly out of order (confirmed the hard way while building the
 * pipeline itself), so a trustworthy monitor needs its own unambiguous feed.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const EVENTS_FILE = path.join(process.cwd(), "pipeline-events.jsonl");
const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const MAX_RECENT = 8;

const state = {
  pipelineInfo: null,
  startedAt: null,
  activeDownloads: new Map(), // id -> event
  activeTranscodes: new Map(), // id::file -> event
  activeUploads: new Map(), // id::file -> event
  recentErrors: [],
  recentCompletions: [],
  counts: {
    downloadsDone: 0, downloadsError: 0,
    transcodesDone: 0,
    uploadsDone: 0, uploadsError: 0,
    itemsDone: 0, itemsFailed: 0,
  },
  uploadedBytesLog: [], // { ts, bytes } sliding window for throughput
};

function pushRecent(arr, item) {
  arr.push(item);
  if (arr.length > 50) arr.shift(); // keep a bit of backlog; render slices to MAX_RECENT
}

function handleEvent(e) {
  const key = e.id !== undefined ? `${e.id}::${e.file || ""}` : null;
  switch (e.type) {
    case "pipeline_start":
      state.pipelineInfo = e;
      state.startedAt = e.ts;
      break;
    case "download_start":
      state.activeDownloads.set(e.id, e);
      break;
    case "download_done":
      state.activeDownloads.delete(e.id);
      state.counts.downloadsDone++;
      break;
    case "download_error":
      state.activeDownloads.delete(e.id);
      state.counts.downloadsError++;
      pushRecent(state.recentErrors, e);
      break;
    case "transcode_start":
      state.activeTranscodes.set(key, e);
      break;
    case "transcode_done":
      state.activeTranscodes.delete(key);
      state.counts.transcodesDone++;
      break;
    case "upload_start":
      state.activeUploads.set(key, e);
      break;
    case "upload_done":
      state.activeUploads.delete(key);
      state.counts.uploadsDone++;
      state.uploadedBytesLog.push({ ts: e.ts, bytes: (e.sizeMB || 0) * 1024 * 1024 });
      break;
    case "upload_error":
      state.activeUploads.delete(key);
      state.counts.uploadsError++;
      pushRecent(state.recentErrors, e);
      break;
    case "file_error":
      state.activeTranscodes.delete(key);
      state.activeUploads.delete(key);
      pushRecent(state.recentErrors, e);
      break;
    case "item_done":
      state.counts.itemsDone++;
      pushRecent(state.recentCompletions, e);
      break;
    case "item_failed":
      state.counts.itemsFailed++;
      break;
  }
}

let readOffset = 0;
function pollEvents() {
  let stat;
  try {
    stat = fs.statSync(EVENTS_FILE);
  } catch {
    return; // pipeline hasn't started/emitted yet
  }
  if (stat.size < readOffset) readOffset = 0; // file rotated/truncated
  if (stat.size === readOffset) return;

  const fd = fs.openSync(EVENTS_FILE, "r");
  const length = stat.size - readOffset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, readOffset);
  fs.closeSync(fd);
  readOffset = stat.size;

  for (const line of buffer.toString("utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      handleEvent(JSON.parse(line));
    } catch {}
  }
}

function readEnrichedStats() {
  try {
    const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
    const withTorrents = data.items.filter((i) => i.torrent_options && i.torrent_options.length > 0);
    const done = withTorrents.filter((i) => i.s3_key);
    const movies = withTorrents.filter((i) => i.content_type === "movie");
    const moviesDone = movies.filter((i) => i.s3_key);
    return { total: withTorrents.length, done: done.length, movies: movies.length, moviesDone: moviesDone.length };
  } catch {
    return null;
  }
}

function isPipelineRunning() {
  try {
    execSync("pgrep -f 'download-picked-torrents\\.js'", { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m", white: "\x1b[37m",
};

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function progressBar(frac, width = 30) {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function render() {
  const now = Date.now();
  const cols = process.stdout.columns || 100;
  const lines = [];

  lines.push(`${C.bold}${C.cyan}📼  Torrent Pipeline Monitor${C.reset}`);

  const running = isPipelineRunning();
  const statusText = running ? `${C.green}● RUNNING${C.reset}` : `${C.red}○ NOT RUNNING${C.reset}`;
  const elapsedText = state.startedAt ? `  |  elapsed ${fmtElapsed(now - state.startedAt)}` : "";
  lines.push(`Status: ${statusText}${elapsedText}`);
  if (state.pipelineInfo) {
    lines.push(`${C.dim}Concurrency: ${state.pipelineInfo.concurrency} file(s) at once${C.reset}`);
  }
  lines.push("");

  const stats = readEnrichedStats();
  if (stats) {
    const frac = stats.total ? stats.done / stats.total : 0;
    lines.push(
      `${C.bold}Items:${C.reset} ${stats.done}/${stats.total} (${(frac * 100).toFixed(1)}%)  ` +
      `${C.green}${progressBar(frac)}${C.reset}`
    );
    if (stats.movies) {
      const mFrac = stats.movies ? stats.moviesDone / stats.movies : 0;
      lines.push(`${C.dim}  movies: ${stats.moviesDone}/${stats.movies} (${(mFrac * 100).toFixed(1)}%)${C.reset}`);
    }
  } else {
    lines.push(`${C.dim}Catalog stats unavailable${C.reset}`);
  }

  const windowMs = 60000;
  const recentBytes = state.uploadedBytesLog
    .filter((x) => now - x.ts < windowMs)
    .reduce((s, x) => s + x.bytes, 0);
  const mbps = recentBytes / (windowMs / 1000) / 1024 / 1024;
  lines.push(`${C.bold}Upload throughput:${C.reset} ${mbps.toFixed(2)} MB/s (60s avg)`);
  lines.push("");

  const nameWidth = Math.max(20, Math.min(50, cols - 30));

  lines.push(`${C.bold}Active downloads (${state.activeDownloads.size})${C.reset}`);
  if (state.activeDownloads.size === 0) lines.push(`${C.dim}  (none)${C.reset}`);
  for (const d of state.activeDownloads.values()) {
    const sizeGB = d.sizeBytes ? (d.sizeBytes / 1024 ** 3).toFixed(1) + "GB" : "?";
    lines.push(`  ${C.magenta}⬇${C.reset} ${truncate(d.item, nameWidth)} (${sizeGB}, ${fmtElapsed(now - d.ts)})`);
  }
  lines.push("");

  lines.push(`${C.bold}Active transcodes (${state.activeTranscodes.size})${C.reset}`);
  if (state.activeTranscodes.size === 0) lines.push(`${C.dim}  (none)${C.reset}`);
  for (const t of state.activeTranscodes.values()) {
    lines.push(`  ${C.yellow}⚙${C.reset} ${truncate(`${t.item} - ${t.file}`, nameWidth)} (${fmtElapsed(now - t.ts)})`);
  }
  lines.push("");

  lines.push(`${C.bold}Active uploads (${state.activeUploads.size})${C.reset}`);
  if (state.activeUploads.size === 0) lines.push(`${C.dim}  (none)${C.reset}`);
  for (const u of state.activeUploads.values()) {
    const mb = (u.sizeMB || 0).toFixed(0);
    lines.push(`  ${C.cyan}↑${C.reset} ${truncate(`${u.item} - ${u.file}`, nameWidth)} (${mb}MB, ${fmtElapsed(now - u.ts)})`);
  }
  lines.push("");

  lines.push(`${C.bold}Recent completions${C.reset}`);
  const completions = state.recentCompletions.slice(-MAX_RECENT).reverse();
  if (completions.length === 0) lines.push(`${C.dim}  (none yet)${C.reset}`);
  for (const c of completions) {
    lines.push(`  ${C.green}✓${C.reset} ${truncate(c.item, nameWidth)} (${c.fileCount} file(s))`);
  }
  lines.push("");

  const errCount = state.counts.downloadsError + state.counts.uploadsError;
  lines.push(`${C.bold}Recent errors (${errCount} total)${C.reset}`);
  const errors = state.recentErrors.slice(-MAX_RECENT).reverse();
  if (errors.length === 0) lines.push(`${C.dim}  (none)${C.reset}`);
  for (const e of errors) {
    const where = e.file ? `${e.item} - ${e.file}` : e.item;
    lines.push(`  ${C.red}✗${C.reset} [${e.type}] ${truncate(where, nameWidth)}: ${truncate(e.error || "", 60)}`);
  }
  lines.push("");

  const c = state.counts;
  lines.push(
    `${C.dim}downloads ${c.downloadsDone}✓/${c.downloadsError}✗  ·  ` +
    `transcodes ${c.transcodesDone}✓  ·  ` +
    `uploads ${c.uploadsDone}✓/${c.uploadsError}✗  ·  ` +
    `items ${c.itemsDone}✓/${c.itemsFailed}✗${C.reset}`
  );
  lines.push(`${C.dim}Refreshing every 1s · press q or Ctrl+C to exit${C.reset}`);

  // Cursor-home + clear-to-end, inside the alternate screen buffer (entered
  // below) - clearing the *main* buffer with 2J on every frame is what
  // caused the wall of blank-line frames scrolling the real terminal.
  process.stdout.write("\x1b[H\x1b[J" + lines.join("\n") + "\n");
}

process.stdout.write("\x1b[?1049h"); // enter alternate screen buffer
process.stdout.write("\x1b[?25l"); // hide cursor

let cleaningUp = false;
function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdout.write("\x1b[?1049l"); // leave alternate screen buffer (restores prior terminal contents)
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// 'q' to quit, in addition to Ctrl+C - raw mode is needed to read a single
// keypress without the user having to press Enter.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "Q" || key === "") cleanup(); //  = Ctrl+C
  });
}

pollEvents();
render();
const interval = setInterval(() => {
  pollEvents();
  render();
}, 1000);
interval.unref?.(); // don't hold the process open if something else stops it first
