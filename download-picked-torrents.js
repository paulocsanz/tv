#!/usr/bin/env node

/**
 * Step 2: Download and upload picked torrents
 */

import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import os from "os";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { transcodeForBrowser, browserMp4Name, extractSubtitles, probeDurationSeconds } from "./transcode.js";

// Single browser-playable MP4 tier per file, capped at 720p. Raw torrent
// rips are frequently MKV containers with HEVC video or EAC3/DTS audio, none
// of which play in a plain <video> tag - see transcode.js. There used to
// also be an untouched-resolution "primary" tier, but uploading two tiers
// per file doubled total upload time (the actual bottleneck - see
// uploadToS3) for a difference most viewers won't notice, so it was dropped.
// Any subtitle tracks extracted from the same source (see extractSubtitles
// in transcode.js) land under this same prefix as sibling `.<lang>.vtt`
// files rather than their own prefix, so a whole item's assets stay
// co-located.
const S3_PREFIX = (id) => `videos/${id}/`;

// Optional at-rest encryption (RFC 0006). When ENCRYPT_UPLOADS is truthy AND
// ENCRYPTION_CATALOG_KEY is a 32-byte base64 key, new uploads for titles that
// aren't already on S3 as plaintext land as SSESENC1. Existing plaintext
// library stays playable; flip the flag only for greenfield/migration runs.
const ENCRYPT_UPLOADS =
  process.env.ENCRYPT_UPLOADS === "1" ||
  process.env.ENCRYPT_UPLOADS === "true" ||
  process.env.ENCRYPT_UPLOADS === "yes";
let encryptionCatalogKey = null;
if (ENCRYPT_UPLOADS) {
  try {
    const { parseCatalogKey } = require("./lib/media-encryption.cjs");
    encryptionCatalogKey = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
    if (!encryptionCatalogKey) {
      console.warn(
        "ENCRYPT_UPLOADS is set but ENCRYPTION_CATALOG_KEY is missing — uploads stay plaintext",
      );
    } else {
      console.log(
        "ENCRYPT_UPLOADS enabled — new greenfield uploads will be HLS AES-128 (RFC 0009)",
      );
    }
  } catch (e) {
    console.warn(`ENCRYPT_UPLOADS key load failed (${e.message}) — uploads stay plaintext`);
    encryptionCatalogKey = null;
  }
}

function shouldEncryptItem(item) {
  if (!encryptionCatalogKey) return false;
  // Keep a title consistent: once any plaintext object exists, keep writing
  // plaintext; once marked encrypted, keep encrypting.
  if (item.encrypted) return true;
  const existing = (item.s3_keys && item.s3_keys.length) || item.s3_key;
  if (existing) return false;
  return true;
}

// Paths are env-overridable so the same script can run on a Mac laptop or a
// caixote worker with a large attached volume at /data. Defaults keep the
// historical on-laptop layout (cwd-relative downloads/ + backend/data/).
const DATA_DIR = process.env.PIPELINE_DATA_DIR || path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = process.env.ENRICHED_FILE || path.join(DATA_DIR, "enriched_400.json");
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(process.cwd(), "downloads");
const TRANSCODE_TMP_DIR = path.join(DOWNLOADS_DIR, ".transcoded");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TRANSCODE_TMP_DIR, { recursive: true });

// A second concurrent instance downloads the same items into the same
// downloads/<id>/ directories and transcodes into the same deterministic tmp
// path (see TRANSCODE_TMP_DIR usage below), so the two instances delete each
// other's in-progress files out from under themselves - confirmed live: an
// orphaned instance and a freshly started one both had aria2c children for
// the same torrents, and one instance's cleanup produced ENOENT errors in
// the other. A lockfile makes a second launch refuse to start instead of
// silently colliding.
const LOCK_FILE = process.env.PIPELINE_LOCK_FILE || path.join(process.cwd(), ".download-picked-torrents.lock");
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (fs.existsSync(LOCK_FILE)) {
  const existingPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10);
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Another instance is already running (pid ${existingPid}). Refusing to start a second one - kill it first if that's stale.`);
    process.exit(1);
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {}
});

// Structured, machine-readable event log for monitor.js (a separate TUI
// dashboard) to tail. The human-readable console/log output above is prone
// to misleading interleaving when multiple concurrent workers write to the
// same redirected stdout at once (confirmed the hard way during development
// - buffered writes from different workers can appear merged out of order),
// so a real monitor needs its own unambiguous, one-event-per-line source of
// truth instead of parsing that text.
const EVENTS_FILE = process.env.PIPELINE_EVENTS_FILE || path.join(process.cwd(), "pipeline-events.jsonl");
function emit(type, data = {}) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: Date.now(), type, ...data }) + "\n");
  } catch {}
}

// In-place progress footer for concurrent downloads when stdout is a TTY.
// On caixote (serial logs, no TTY) ANSI redraws are invisible to the log
// collector - nothing after "Downloading..." ever shows up. Fall back to
// plain console.log progress lines in that case so remote monitors can see %.
const useProgressFooter = Boolean(process.stdout.isTTY);
const footerRows = new Map(); // label -> current line text
let footerLineCount = 0;
const rawConsoleLog = console.log.bind(console);
// Throttle non-TTY progress lines: one per key per 5% or 30s, whichever first.
const lastPlainProgress = new Map(); // key -> { percent, at }

function clearFooter() {
  if (!useProgressFooter || footerLineCount === 0) return;
  process.stdout.write(`\x1b[${footerLineCount}A\x1b[0J`);
  footerLineCount = 0;
}

function drawFooter() {
  if (!useProgressFooter || footerRows.size === 0) return;
  process.stdout.write([...footerRows.values()].join("\n") + "\n");
  footerLineCount = footerRows.size;
}

console.log = (...args) => {
  clearFooter();
  rawConsoleLog(...args);
  drawFooter();
};

function setFooterLine(key, text, { percent, speed, force } = {}) {
  if (useProgressFooter) {
    footerRows.set(key, text);
    clearFooter();
    drawFooter();
    return;
  }
  // Serial/log mode: emit a real line so caixote logs / monitors can parse it.
  const now = Date.now();
  const prev = lastPlainProgress.get(key) || { percent: -1, at: 0 };
  const pct = typeof percent === "number" ? percent : prev.percent;
  if (!force) {
    if (pct === prev.percent && now - prev.at < 30000 && pct !== 100) return;
    if (pct !== 100 && pct - prev.percent < 5 && now - prev.at < 30000) return;
  } else if (now - prev.at < 8000 && pct === prev.percent && !String(text).includes("on disk")) {
    return;
  }
  lastPlainProgress.set(key, { percent: pct, at: now });
  rawConsoleLog(text);
  emit("download_progress", { item: key, percent: pct, speed: speed || null });
}

function clearFooterLine(key) {
  footerRows.delete(key);
  lastPlainProgress.delete(key);
  clearFooter();
  drawFooter();
}

// Number of files that can be *scheduled* (transcode-then-upload) at once.
// Briefly raised to 200 on the theory that the bucket host (not the home
// uplink) was the constraint - it wasn't the bucket, but pushing that many
// concurrent multipart connections through one constrained/lossy home
// uplink caused real, sustained per-part failures under contention
// ("Request body is not seekable, cannot retry" - the SDK can't resume a
// Node stream body mid-transfer after a failure), not just a lack of speed
// gain like expected: confirmed live, 0 items uploaded across 320+ minutes
// with 390+ of these failures.
//
// Even the "proven-stable" value of 4 turned out not to be: tonight, 4
// simultaneous multi-GB Six Feet Under uploads produced repeated
// `write EPIPE` errors (a real socket failure, not just the stall
// watchdog) and a pileup of 19+ established connections to the bucket -
// the same signature as an earlier 40-minute stall incident. Dropped to 2
// to give each upload a bigger share of this connection.
const UPLOAD_CONCURRENCY = 2;

// Transcoding is CPU/hardware-encoder bound (h264_videotoolbox is one
// physical encode engine), unlike uploads which are network-bound and
// scale with more connections - raising UPLOAD_CONCURRENCY without a
// separate cap here let 8+ ffmpeg processes stack up fighting over the
// same encoder and CPU, since every worker used to transcode *and* upload
// in one uninterrupted sequence. Capped at 4 to match download
// concurrency instead of the encoder silently thrashing.
const TRANSCODE_CONCURRENCY = 4;
let activeTranscodes = 0;

async function acquireTranscodeSlot() {
  while (activeTranscodes >= TRANSCODE_CONCURRENCY) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  activeTranscodes++;
}

function releaseTranscodeSlot() {
  activeTranscodes--;
}

// If N items in a row give up having written literally zero bytes to disk
// (not "slow," not "one bad torrent" - *nothing* ever landed, regardless of
// seeder count), that's a network-level failure, not a torrent-quality
// problem (confirmed live: a 155-seeder item failed identically to a
// 6-seeder one). Grinding through the rest of a 100-item queue at
// 6-15min-per-attempt-x-8-attempts each, for hours, when the whole class of
// failure is already proven, just burns time for zero benefit - so this
// pauses new downloads instead once the pattern is unambiguous. In-flight
// items keep retrying (a stall isn't proof of the same thing until *it*
// also exhausts its retries with zero bytes), and transcode/upload of
// anything already downloaded keeps draining normally.
const NETWORK_CIRCUIT_THRESHOLD = 5;
let consecutiveZeroByteFailures = 0;
let networkCircuitOpen = false;

function dirHasBytes(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".aria2")) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory() ? dirHasBytes(p) : st.size > 0) return true;
    }
  } catch {}
  return false;
}

// Torrents are split into two independent pools by seeder count, predicted
// *before* anything starts downloading rather than reacting after a slot is
// already stuck - a reactive "demote once it proves slow" scheme doesn't
// actually bound anything: if several fast workers each happen to grab a
// low-seeder item before the one demotion slot is free, they just sit
// blocked in their own slots anyway (confirmed this would happen: 3
// simultaneously-stalled torrents already did exactly this once with plain
// equal-priority slots). A hard, separate cap per pool is the only thing
// that actually guarantees low-seeder items can never eat more than
// RISKY_DOWNLOAD_CONCURRENCY slots, no matter how many of them queue up.
// Combined total capped at 4 concurrent downloads - more than that
// competing for the same home uplink and disk headroom is exactly what fed
// the backlog that filled the disk (see pendingUploadBytes below for the
// rest of that incident).
// Lowered from 3 on caixote: confirmed live on 2026-07-30 that 4 concurrent
// downloads (3 fast + 1 risky) on the caixote worker's volume produced a real
// aria2c exit 9 (out of disk space) on Spider-Man mid-download, immediately
// followed by another concurrent item (The Man Who Copied) completing a
// ~1.1GB file at full speed - i.e. the disk really was momentarily
// oversubscribed by simultaneous downloads, not any single item's own size
// math being wrong. Fewer concurrent downloads means less simultaneous
// reserved+actual disk usage at once.
const FAST_DOWNLOAD_CONCURRENCY = 2;
const RISKY_DOWNLOAD_CONCURRENCY = 1;
// Below this, tonight's evidence: Fellowship (5), Spider-Man's bad option
// (10), A Dog's Will (8) all repeatedly stalled/failed. At or above:
// City of God (15), Seven Samurai (48) downloaded fine. Not a guarantee
// (seeders don't capture geography/ISP shaping), just the best signal
// available before a download actually starts.
const SEEDER_THRESHOLD = 12;

// Prefer explicit env vars (how the caixote worker is configured) so the
// pipeline doesn't need the Railway CLI installed. Fall back to
// `railway bucket credentials` for local laptop runs where the CLI is already
// authenticated. These buckets aren't reachable at a static AWS-style URL.
function loadBucketCreds() {
  const fromEnv = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (fromEnv.accessKeyId && fromEnv.secretAccessKey && fromEnv.bucketName && fromEnv.endpoint) {
    return fromEnv;
  }
  return JSON.parse(
    execSync("railway bucket credentials --bucket convenient-pannikin --json").toString()
  );
}
const bucketCreds = loadBucketCreds();

// A dead connection can leave a request's socket ESTABLISHED with zero
// bytes ever moving again, and the SDK's own retry/abort logic doesn't
// reliably detect or recover from that on its own. throwOnRequestTimeout is
// required for requestTimeout to actually abort anything - without it,
// requestTimeout alone just logs a warning and lets a stalled request keep
// running forever (confirmed live).
//
// This one governs the higher-level per-attempt stall watchdog in
// uploadToS3 (the stallCheck interval below) - it correctly resets on every
// real httpUploadProgress/part completion, so it only fires on genuine
// inactivity. Kept short since it's meant to catch a truly-dead connection
// fast.
const UPLOAD_STALL_TIMEOUT_MS = 3 * 60 * 1000;

// This one is NodeHttpHandler's own requestTimeout - despite its name, this
// is a flat deadline for one HTTP request's total duration, *not* a
// resettable idle timer the way the comment here used to claim (confirmed
// live: a part upload got killed by this while parts were still actively
// succeeding - completedParts kept growing across retries - so nothing was
// actually idle). Reusing UPLOAD_STALL_TIMEOUT_MS's 3 minutes here was
// wrong: an 8MB part only needs ~65s at this connection's typical
// throughput, but this connection's real per-part time varies a lot
// (packet loss/retransmission), and a flat 3-minute cutoff kills any part
// that's just having a slow-but-healthy moment. Set far more generously
// since it's now just a backstop against a truly hung request - the
// stallCheck watchdog above is what actually catches real staleness.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const s3Client = new S3Client({
  region: bucketCreds.region,
  endpoint: bucketCreds.endpoint,
  forcePathStyle: bucketCreds.urlStyle !== "virtual-host",
  credentials: {
    accessKeyId: bucketCreds.accessKeyId,
    secretAccessKey: bucketCreds.secretAccessKey,
  },
  requestHandler: new NodeHttpHandler({ requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true }),
});

const BUCKET_NAME = bucketCreds.bucketName;
const OVERHEAD_BUFFER = 1.2; // 20% overhead buffer

function getAvailableSpace() {
  try {
    // Try using os.statfs if available (Node.js 16.17+)
    const stat = os.statfs(DOWNLOADS_DIR);
    return stat.bavail * stat.bsize;
  } catch {}

  return null;
}

// Producer/consumer channel between the download phase and the upload
// worker pool. Safe for multiple concurrent consumers: next() either
// synchronously shifts from `items` or queues a waiter, with no `await`
// between the check and the mutation, so concurrent callers can't race.
function createChannel() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (waiters.length) waiters.shift()({ value: item, done: false });
      else items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    async next() {
      if (items.length) return { value: items.shift(), done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve) => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return { next: () => this.next() };
    },
  };
}

// The pipeline always transcodes down to a 720p-capped MP4 (see
// transcodeForBrowser below), so downloading a 1080p source only to
// immediately throw away that resolution wastes download bandwidth and
// forces a full re-encode instead of the cheap h264 copy path. Prefer
// whichever 720p options pick-best-torrents.js found; fall back to the
// 1080p field only for items with no 720p option at all.
function qualityTier(item) {
  if (item.torrent_options_720p && item.torrent_options_720p.length > 0) {
    return { label: "720p", optionsKey: "torrent_options_720p", indexKey: "current_torrent_index_720p" };
  }
  return { label: "1080p", optionsKey: "torrent_options", indexKey: "current_torrent_index" };
}

function hasTorrentOptions(item) {
  return (item.torrent_options_720p && item.torrent_options_720p.length > 0) ||
    (item.torrent_options && item.torrent_options.length > 0);
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/[\d.]+\s*(GB|MB|TB|KB|B)/i);
  if (!match) return 0;

  const value = parseFloat(match[0]);
  const unit = match[1].toUpperCase();

  const units = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
  return Math.ceil(value * (units[unit] || 1));
}

// aria2c's own progress summary line looks like:
// "[#2089b0 285KiB/1.4GiB(6%) CN:16 SD:22 DL:5.2MiB]"
// - stable format, documented in `man aria2c`. Pull percent/speed out of it
// instead of discarding the line for a plain ".".
function parseAria2Progress(text) {
  const percentMatch = text.match(/\((\d+)%\)/);
  if (!percentMatch) return null;
  // \w* (not \S*) so this stops at aria2c's closing "]" instead of
  // swallowing it into the speed string (was rendering as "0B]/s").
  const speedMatch = text.match(/DL:([\d.]+\w*)/);
  return { percent: parseInt(percentMatch[1], 10), speed: speedMatch ? speedMatch[1] : null };
}

// A connected-but-stalled aria2c (peers found, transfer never actually
// moves) keeps emitting its 2s summary line forever at "0B/s" - real
// output, so the startup timeout below never fires, but zero bytes ever
// move (confirmed live: City of God sat at "0% (0B/s)" for 2+ hours,
// burning ~5s of CPU total, before someone had to notice and kill it by
// hand). parseFloat("0B") / parseFloat("5.2MiB") both work here since any
// unit times a nonzero leading number is nonzero - no need to parse units.
//
// Raised hard on 2026-07-30 after days of "desiste e apaga progresso":
// 6m/15m was far too aggressive for sparse Brazilian swarms and for
// caixote microVM NAT cold-starts that need longer to find the first
// working peer. Only fire on genuine zero-throughput; any disk growth
// already resets lastActiveAt in the diskPulse below.
const STALL_TIMEOUT_MS = 30 * 60 * 1000;
const STALL_CHECK_INTERVAL_MS = 30 * 1000;

// Below-SEEDER_THRESHOLD swarms don't just have less throughput once
// connected - a live socket-level check tonight showed most of their
// candidate peers resolve back to a couple of shared VPN/CGNAT exit hosts
// (e.g. a NordVPN exit node) that never complete a handshake, each costing
// up to ~75s (the OS's own TCP connect timeout) before aria2c moves to the
// next candidate. A well-seeded swarm finds a reachable peer within that
// budget; a sparse one can easily burn half an hour on bad luck alone
// while still genuinely trying - and bumpOption() then used to wipe real
// partials and advance to a *worse*-seeded option, compounding the
// problem. Risky items get a full hour of runway before we even call it
// a stall.
const RISKY_STALL_TIMEOUT_MS = 60 * 60 * 1000;

// Number of times to retry the *same* torrent option (same magnet) before
// giving up on it. A stall or a transient aria2c error doesn't mean the
// torrent is dead - see the retry loop around downloadViaAria2c below.
//
// Raised from 3→8→12: the event log shows items that ever failed took ~3
// failures on average before eventually succeeding (58 distinct items
// failed at least once, 55 of them succeeded anyway). Retries are cheap
// now that progress carries over instead of being deleted. Even after
// retries are exhausted we no longer wipe partials (see the catch path
// around bumpOption) - this count only decides when to try a *different*
// magnet, and only when the current attempt wrote zero bytes.
const DOWNLOAD_OPTION_RETRIES = 12;

// Tracks every in-flight aria2c child so a Ctrl+C can kill them along with
// the parent - left untracked, a `spawn()` child outlives its parent's exit,
// keeps writing into `downloads/<id>/` with nobody around to transcode/
// upload/mark it done, and can collide with that item's next-run download
// into the same directory (confirmed: this exact race corrupted a completed
// download into an ENOENT mid-upload, poisoning the whole item's s3_key).
const activeChildren = new Set();

// SIGTERM alone isn't reliable against a genuinely hung aria2c (e.g. stuck
// in a blocking syscall on a dead connection - the exact failure mode that
// stalled the whole pipeline earlier). Without escalation, a kill() that
// doesn't land leaves the process running past its worker slot moving on to
// a new download, so observed concurrency creeps above the configured
// FAST_DOWNLOAD_CONCURRENCY + RISKY_DOWNLOAD_CONCURRENCY cap even though the
// JS-level worker loop itself never exceeds it.
function forceKillAria2(aria2) {
  aria2.kill();
  setTimeout(() => {
    if (activeChildren.has(aria2)) aria2.kill("SIGKILL");
  }, 5000);
}

// [NETDIAG] (see docker/network-diag.mjs) found outbound DHT dead against
// router.bittorrent.com:6881 and dht.transmissionbt.com:6881 and initially
// read that as "UDP is blocked." Verified live against this exact host that
// this was wrong: NTP:123, a UDP tracker "connect" (BEP-15) against 7 of 8
// real public UDP trackers on varied ports (80, 451, 1337, 6969), and a DHT
// ping against dht.libtorrent.org on its non-default port 25401 ALL got real
// replies. Only destination port 6881 specifically fails - the one port both
// the conventional DHT bootstrap nodes and aria2's own default DHT/listen
// port use, and the single most recognizable default BitTorrent port (a
// common, narrow target for ISP/router P2P filtering). Confirmed end to end
// live: aria2c with the entry point + listen port below pulled a real peer
// and 1.3MiB of Ubuntu's official torrent in ~15s. So DHT/UDP trackers do
// work here - they just can't touch port 6881 to get in or out.
// IP, not hostname: this NETDIAG-adjacent DNS resolver has shown intermittent
// EAI_AGAIN failures live (see the recurring "getaddrinfo EAI_AGAIN" lines in
// this same log stream) - the single bootstrap entry point DHT depends on
// entirely to ever get in is not something to leave hostage to a flaky
// resolver. 185.157.221.247 is dht.libtorrent.org as of 2026-07-28 (`dig
// +short dht.libtorrent.org`); re-resolve and update here if this ever stops
// working and DNS isn't the culprit.
const DHT_ENTRY_POINT = "185.157.221.247:25401";
// A range, not a single port: FAST_DOWNLOAD_CONCURRENCY + RISKY_DOWNLOAD_CONCURRENCY
// spawn multiple aria2c child processes at once, each its own OS process - a
// single fixed port here means only the first one to start can actually bind
// it, and every sibling silently runs with no DHT at all (confirmed live:
// all 4 concurrent downloads sat at 0B/s with the single-port version, same
// as before this whole fix). aria2c tries ports across a given range in
// order until one binds, same mechanism as --listen-port.
const DHT_LISTEN_PORT = "6890-6999";

// Live-tested (BEP-15 UDP "connect" got a real reply) against this host, one
// port each so a single blocked port can't take out every announce.
const UDP_TRACKERS = [
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://open.demonii.com:1337/announce",
].join(",");

async function downloadViaAria2c(magnetLink, targetDir, label, stallTimeoutMs = STALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let hasOutput = false;
    let stderrTail = "";
    let lastPercent = -1;
    let lastActiveAt = Date.now();
    const startTime = Date.now();

    // On a TTY aria2c prints live summaries; on caixote (serial logs, no
    // TTY) glibc fully buffers stdout so parseAria2Progress never sees a
    // line until the process exits - the whole download looks stuck at 0%
    // in remote logs. Prefer stdbuf -oL (coreutils on Debian) so each
    // summary-interval line flushes immediately.
    const aria2Args = [
      "--max-connection-per-server=16",
      "--split=16",
      // Was 100K - that killed any slow-but-alive seeder (common on sparse
      // BR swarms that crawl at 10-50 KiB/s for minutes then surge). The
      // JS stall watchdog already covers genuine 0B/s; don't also have
      // aria2c abort partial progress just for being slow.
      "--lowest-speed-limit=1K",
      "--bt-enable-lpd=true",
      "--enable-dht=true",
      `--dht-entry-point=${DHT_ENTRY_POINT}`,
      `--dht-listen-port=${DHT_LISTEN_PORT}`,
      `--bt-tracker=${UDP_TRACKERS}`,
      "--continue=true",
      // Season packs get their episode files deleted right after they
      // upload (see the upload worker), so a resumed download always finds
      // some files already present with no matching *.aria2 control file.
      // Without this, aria2 refuses the whole torrent ("file exists but no
      // control file, refusing to risk truncating it to 0") and exits
      // non-zero - which used to get misread as success below.
      "--allow-overwrite=true",
      "--seed-time=0",
      "--seed-ratio=0.0",
      // Default is 60s - far too coarse to show live % on anything but the
      // biggest season packs.
      "--summary-interval=2",
      "--show-console-readout=true",
      // Prefer peers that already have the whole file; helps sparse swarms
      // where most "seeders" in the announce are actually incomplete.
      "--bt-max-peers=80",
      "--bt-request-peer-speed-limit=0",
      magnetLink,
    ];
    const useStdbuf = fs.existsSync("/usr/bin/stdbuf") || fs.existsSync("/bin/stdbuf");
    const aria2 = useStdbuf
      ? spawn("stdbuf", ["-oL", "-eL", "aria2c", ...aria2Args], { cwd: targetDir })
      : spawn("aria2c", aria2Args, { cwd: targetDir });
    activeChildren.add(aria2);

    aria2.stdout.on("data", (data) => {
      hasOutput = true;
      const progress = parseAria2Progress(data.toString());
      if (progress) {
        if ((progress.speed ? parseFloat(progress.speed) : 0) > 0) lastActiveAt = Date.now();
        if (progress.percent !== lastPercent) {
          lastPercent = progress.percent;
          const speed = progress.speed ? ` (${progress.speed}/s)` : "";
          setFooterLine(label, `  [${label}] ${progress.percent}%${speed}`, {
            percent: progress.percent,
            speed: progress.speed || null,
          });
        }
      }
    });

    aria2.stderr.on("data", (data) => {
      hasOutput = true;
      stderrTail = (stderrTail + data.toString()).slice(-500);
    });

    // Heartbeat independent of aria2c console output (which is often fully
    // buffered when stdout is not a TTY, even with stdbuf on some builds).
    // Walk the download dir every 10s and report bytes-on-disk so caixote
    // serial logs always show movement.
    let lastDiskBytes = 0;
    let lastDiskAt = Date.now();
    function dirBytes(dir) {
      let total = 0;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith(".aria2")) continue;
          const p = path.join(dir, name);
          try {
            const st = fs.statSync(p);
            if (st.isDirectory()) total += dirBytes(p);
            else total += st.size;
          } catch {}
        }
      } catch {}
      return total;
    }
    const diskPulse = setInterval(() => {
      if (!activeChildren.has(aria2)) return;
      const bytes = dirBytes(targetDir);
      if (bytes > 0) hasOutput = true;
      if (bytes > lastDiskBytes) {
        lastActiveAt = Date.now();
        const delta = bytes - lastDiskBytes;
        const dt = Math.max(0.001, (Date.now() - lastDiskAt) / 1000);
        const speedBps = delta / dt;
        const speed =
          speedBps > 1024 * 1024
            ? `${(speedBps / 1024 / 1024).toFixed(1)}MiB`
            : `${(speedBps / 1024).toFixed(0)}KiB`;
        lastDiskBytes = bytes;
        lastDiskAt = Date.now();
        // Prefer aria2's own percent when we have it; otherwise show MB on disk.
        const mb = (bytes / 1024 / 1024).toFixed(1);
        const pctLabel = lastPercent >= 0 ? `${lastPercent}%` : `${mb}MB`;
        setFooterLine(label, `  [${label}] ${pctLabel} on disk ${mb}MB (${speed}/s)`, {
          percent: lastPercent >= 0 ? lastPercent : 0,
          speed,
          force: true,
        });
      } else if (Date.now() - lastDiskAt > 15000) {
        // Still alive, no growth - keep the monitor's "last log" fresh.
        const mb = (bytes / 1024 / 1024).toFixed(1);
        setFooterLine(label, `  [${label}] ${lastPercent >= 0 ? lastPercent + "%" : mb + "MB"} (idle 0B/s)`, {
          percent: lastPercent >= 0 ? lastPercent : 0,
          speed: "0B",
          force: true,
        });
        lastDiskAt = Date.now();
      }
    }, 10000);

    // Give it 5 minutes to produce any output at all - covers the "magnet
    // never resolves any peers" case. 2 minutes was too short on caixote
    // NAT cold-starts where DHT bootstrap alone can take a while.
    const timeout = setTimeout(() => {
      if (!hasOutput) {
        forceKillAria2(aria2);
        reject(new Error("Timeout - no seeders found"));
      }
    }, 5 * 60 * 1000);

    // Separately covers the "connected and chattering, but zero throughput"
    // case above, which the startup timeout can't see since it only checks
    // for output existing at all, not output showing real progress.
    const stallCheck = setInterval(() => {
      if (Date.now() - lastActiveAt > stallTimeoutMs) {
        forceKillAria2(aria2);
        reject(new Error(`Stalled - 0B/s for ${Math.round(stallTimeoutMs / 60000)}m`));
      }
    }, STALL_CHECK_INTERVAL_MS);

    aria2.on("close", (code) => {
      activeChildren.delete(aria2);
      clearInterval(diskPulse);
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearFooterLine(label);
      const duration = ((Date.now() - startTime) / 1000).toFixed(0);

      if (code === 0) {
        console.log(`  [${label}] ✓ (${duration}s)`);
        resolve();
      } else {
        reject(new Error(`aria2c exit ${code}${stderrTail ? `: ${stderrTail.trim().split("\n").pop()}` : ""}`));
      }
    });

    aria2.on("error", (error) => {
      activeChildren.delete(aria2);
      clearInterval(diskPulse);
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearFooterLine(label);
      reject(error);
    });
  });
}

// aria2c honors SIGTERM with a clean shutdown (flushes its .aria2 control
// file so --continue can resume next run), so give it a moment before
// escalating to SIGKILL - otherwise the next run's resume attempt can find a
// half-written file with no matching control file (see --allow-overwrite
// above for what that already breaks once).
let shuttingDown = false;
async function shutdownAndExit(signal) {
  if (shuttingDown) {
    // Second Ctrl+C: stop being polite, including to in-flight uploads.
    for (const child of activeChildren) child.kill("SIGKILL");
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\n\nReceived ${signal} - stopping ${activeChildren.size} in-flight download/transcode process(es) before exiting...`);
  for (const child of activeChildren) child.kill("SIGTERM");

  const deadline = Date.now() + 5000;
  while (activeChildren.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const child of activeChildren) child.kill("SIGKILL");

  if (activeUploads > 0) {
    console.log(`  Waiting for ${activeUploads} in-flight upload(s) to finish - killing now would throw away that transfer entirely. Ctrl+C again to force quit anyway.`);
    while (activeUploads > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  process.exit(1);
}
process.on("SIGINT", () => shutdownAndExit("SIGINT"));
process.on("SIGTERM", () => shutdownAndExit("SIGTERM"));

// Scene releases routinely bundle a short "Sample.mp4"/"-sample.mkv" preview
// clip alongside the real file - harmless when the real file also uploads
// fine, but dangerous on its own: finalizeItem marks a movie complete off
// *any* successfully uploaded file, so if only the real file's upload fails
// (confirmed live: City of God's real 2GB file failed after retries while
// its bundled 21MB Sample.mp4 succeeded), the sample would become the
// item's entire `s3_key` and get served as if it were the movie.
const JUNK_VIDEO_PATTERN = /\bsample\b/i;

function getVideoFiles(dir) {
  const exts = [".mp4", ".mkv", ".avi", ".mov", ".webm"];
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        exts.some((ext) => entry.name.toLowerCase().endsWith(ext)) &&
        !JUNK_VIDEO_PATTERN.test(entry.name)
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// Retries used to mean re-uploading the whole file from byte 0 each time,
// so 3 was already expensive on a multi-GB file. Now that failed attempts
// resume from their last completed part instead of restarting (see
// completedParts in uploadToS3), an extra retry only costs whatever few
// parts were still in flight when it failed - cheap enough to spend more
// of them riding out a bad stretch (confirmed live: one file failed 3/3
// attempts back to back, each one saving real progress but not enough
// attempts left to survive the streak).
const UPLOAD_RETRIES = 8;

// Unlike an aria2c/ffmpeg child, an in-flight S3 multipart upload can't be
// killed and resumed later - killing the process mid-upload throws away
// every byte already transferred (confirmed: a 2.3GB near-finished upload
// got wiped by a Ctrl+C, forcing a full re-upload from 0%). shutdownAndExit
// waits for this to hit 0 instead of exiting out from under it.
let activeUploads = 0;

// A direct connection from this machine to this bucket's host tops out
// around ~150-300KB/s regardless of client (confirmed with a raw curl PUT
// too) - the path to this host is latency/loss-bound per TCP connection.
// Splitting a file into several concurrently-uploaded parts works around
// some of that ceiling per file, and running several files concurrently
// (see UPLOAD_CONCURRENCY) works around the rest.
//
// Small parts, not the @aws-sdk/lib-storage `Upload` helper's default 32MB
// ones: `write EPIPE` (the remote closing a connection we're still writing
// to, not a client-side timeout) kept happening even after dropping
// UPLOAD_CONCURRENCY from 4 to 2, with effectively 1 real upload in
// flight - at this connection's real throughput, a 32MB part can take
// minutes to land, long enough to plausibly trip a server-side/gateway
// timeout on an individual part PUT before it finishes. 8MB parts land
// fast enough to mostly stay under whatever that untunable limit is.
const PART_SIZE = 8 * 1024 * 1024;
const PART_CONCURRENCY = 2;

async function uploadSmallFile(filePath, s3Key, label, contentType, sizeMB) {
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
      process.stdout.write(`  [${label}] ${prefix} ${sizeMB}MB... `);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
          Body: fs.createReadStream(filePath),
          ContentType: contentType,
        })
      );
      console.log(`[${label}] ✓`);
      return true;
    } catch (error) {
      console.log(`[${label}] ✗ (${error.message})`);
      if (attempt < UPLOAD_RETRIES) {
        const delaySeconds = 10 * attempt;
        console.log(`  ⏳ [${label}] Retrying in ${delaySeconds}s...`);
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  }
  return false;
}

async function uploadToS3(filePath, s3Key, label, contentType = "video/mp4") {
  activeUploads++;
  try {
    const fileSize = fs.statSync(filePath).size;
    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    // A file this small isn't worth a multipart upload (S3 requires every
    // part but the last to be >=5MB anyway) and has nothing worth resuming
    // - a plain PutObject retried whole is simplest.
    if (fileSize <= PART_SIZE) {
      return await uploadSmallFile(filePath, s3Key, label, contentType, sizeMB);
    }

    const parts = [];
    for (let start = 0, partNumber = 1; start < fileSize; start += PART_SIZE, partNumber++) {
      const end = Math.min(start + PART_SIZE, fileSize) - 1;
      parts.push({ partNumber, start, end, size: end - start + 1 });
    }

    let uploadId = null;
    // PartNumber -> ETag, kept outside the retry loop so a late failure
    // resumes from here instead of resending everything from byte 0
    // (confirmed live: an 88%-complete 4GB upload hit one write EPIPE and
    // the old Upload-helper-based retry restarted it from scratch, wasting
    // ~3.6GB of already-sent data over one bad part).
    const completedParts = new Map();

    for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
      // One controller shared by every part in this attempt - if any part
      // fails (or the stall watchdog below fires), aborting it cancels
      // every other in-flight part for this attempt too, instead of
      // leaving a sibling part running unobserved in the background after
      // Promise.all has already moved on to the next retry (which would
      // race the next attempt's own part uploads over the same
      // completedParts/uploadedBytes state).
      const attemptAbort = new AbortController();
      try {
        const prefix = attempt === 1 ? "Uploading" : `Retry ${attempt - 1}/${UPLOAD_RETRIES - 1}`;
        const resumeNote = completedParts.size > 0 ? ` (resuming, ${completedParts.size}/${parts.length} parts done)` : "";
        process.stdout.write(`  [${label}] ${prefix} ${sizeMB}MB${resumeNote}... `);

        if (!uploadId) {
          const created = await s3Client.send(
            new CreateMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: s3Key, ContentType: contentType })
          );
          uploadId = created.UploadId;
        }

        let uploadedBytes = [...completedParts.keys()].reduce((sum, pn) => sum + parts[pn - 1].size, 0);
        let lastLoggedPercent = Math.round((uploadedBytes / fileSize) * 100);
        let lastLoggedAt = Date.now();
        let lastProgressAt = Date.now();
        let stalledError = null;

        // Same hard backstop as before: fires on its own clock regardless
        // of what the SDK/socket notices on its own, so a genuinely dead
        // connection can't hang the retry loop forever.
        const stallCheck = setInterval(() => {
          if (!stalledError && Date.now() - lastProgressAt > UPLOAD_STALL_TIMEOUT_MS) {
            stalledError = new Error(`stalled - no upload progress for ${UPLOAD_STALL_TIMEOUT_MS / 60000}m`);
            attemptAbort.abort();
          }
        }, 15000);

        try {
          const pending = parts.filter((p) => !completedParts.has(p.partNumber));
          let nextIndex = 0;
          const worker = async () => {
            while (nextIndex < pending.length) {
              if (stalledError) throw stalledError;
              const part = pending[nextIndex++];
              const partStart = Date.now();
              const result = await s3Client.send(
                new UploadPartCommand({
                  Bucket: BUCKET_NAME,
                  Key: s3Key,
                  UploadId: uploadId,
                  PartNumber: part.partNumber,
                  Body: fs.createReadStream(filePath, { start: part.start, end: part.end }),
                  ContentLength: part.size,
                }),
                { abortSignal: attemptAbort.signal }
              );
              completedParts.set(part.partNumber, result.ETag);
              uploadedBytes += part.size;
              lastProgressAt = Date.now();
              const percent = Math.round((uploadedBytes / fileSize) * 100);
              const elapsedSec = (Date.now() - partStart) / 1000;
              const speed = elapsedSec > 0 ? part.size / 1024 / elapsedSec : 0;
              if (percent - lastLoggedPercent >= 10 || Date.now() - lastLoggedAt >= 30000) {
                console.log(`  [${label}] ${percent}% (${speed.toFixed(0)}KiB/s)`);
                lastLoggedPercent = percent;
                lastLoggedAt = Date.now();
              }
            }
          };
          const workers = Array.from({ length: Math.min(PART_CONCURRENCY, pending.length) }, worker);
          try {
            await Promise.all(workers);
          } catch (workerError) {
            // Fail fast on the first rejection, but abort immediately so a
            // still-in-flight sibling part doesn't keep running unobserved
            // in the background after this attempt has already moved on
            // to a retry - it would otherwise race the next attempt's own
            // part uploads over the same completedParts/uploadedBytes
            // state. (Promise.all itself still attaches a handler to every
            // worker promise, so the aborted sibling's eventual rejection
            // is never a real unhandled-rejection crash - this is purely
            // about not leaving it running.)
            attemptAbort.abort();
            throw workerError;
          }
        } finally {
          clearInterval(stallCheck);
        }

        const sortedParts = [...completedParts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
        await s3Client.send(
          new CompleteMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            UploadId: uploadId,
            MultipartUpload: { Parts: sortedParts },
          })
        );

        console.log(`[${label}] ✓`);
        return true;
      } catch (error) {
        console.log(`[${label}] ✗ (${error.message})`);
        // "does not exist"/NoSuchUpload from one failed part doesn't
        // necessarily mean the whole multipart session is dead - confirmed
        // live: this error fired mid-run, but the very next retry using
        // the *same* uploadId still landed more parts than before it (a
        // transient blip, not permanent loss - looks like occasional
        // routing inconsistency on the bucket's side rather than a real
        // idle-timeout abort). Blindly discarding uploadId/completedParts
        // on the first occurrence would throw away real, already-uploaded
        // progress on a false alarm. ListPartsCommand asks the bucket
        // directly instead of guessing from one failed request: if the
        // session is genuinely gone, list fails too and it's safe to
        // start over; if it succeeds, trust its part list over our local
        // one (authoritative) and keep going with the same uploadId.
        if (uploadId && (error.name === "NoSuchUpload" || /does not exist|NoSuchUpload/i.test(error.message))) {
          try {
            const { Parts = [] } = await s3Client.send(
              new ListPartsCommand({ Bucket: BUCKET_NAME, Key: s3Key, UploadId: uploadId })
            );
            completedParts.clear();
            for (const p of Parts) completedParts.set(p.PartNumber, p.ETag);
            console.log(`  [${label}] Upload session still valid - ${completedParts.size} part(s) confirmed by the bucket, continuing`);
          } catch {
            uploadId = null;
            completedParts.clear();
            console.log(`  ⚠ [${label}] Upload session confirmed gone - starting a fresh multipart upload next attempt`);
          }
        }
        if (attempt < UPLOAD_RETRIES) {
          const delaySeconds = 10 * attempt;
          console.log(`  ⏳ [${label}] Retrying in ${delaySeconds}s...`);
          await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
        }
      }
    }

    // Every retry exhausted - clean up the abandoned multipart upload
    // rather than leaving it on the bucket forever (S3 keeps incomplete
    // multipart parts around indefinitely otherwise, silently costing
    // storage for data that will never be completed).
    if (uploadId) {
      await s3Client
        .send(new AbortMultipartUploadCommand({ Bucket: BUCKET_NAME, Key: s3Key, UploadId: uploadId }))
        .catch(() => {});
    }
  } finally {
    activeUploads--;
  }
  return false;
}

async function processPickedTorrents() {
  console.log("Loading enriched data...");
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));

  // A full disk must not crash the whole pipeline over a single progress
  // save - confirmed live: an ENOSPC here, thrown from a bare
  // fs.writeFileSync with nothing to catch it, took down every in-flight
  // download/transcode/upload in one shot (including several nowhere near
  // the disk being the actual problem) and left their aria2c/ffmpeg
  // children orphaned instead of cleanly killed, since a crash skips
  // shutdownAndExit entirely. Losing one save just means a restart repeats
  // slightly more work, which is already the pipeline's normal recovery
  // story for any interruption.
  function saveEnrichedData() {
    try {
      fs.writeFileSync(ENRICHED_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.log(`  ⚠ Failed to save ${ENRICHED_FILE}: ${error.message}`);
    }
  }

  const withTorrents = data.items.filter(hasTorrentOptions);
  const alreadyUploaded = withTorrents.filter((i) => i.s3_key);
  // force_priority items (e.g. a series being reprocessed for a fix) jump
  // the whole queue; otherwise movies first, since a movie is one file and a
  // series is a whole season pack that can take weeks at this upload speed.
  // Sort is stable, so within each group items keep their original order.
  function sortRank(item) {
    if (item.force_priority) return -1;
    return item.content_type === "movie" ? 0 : 1;
  }
  const picked = withTorrents
    .filter((i) => !i.s3_key)
    .sort((a, b) => sortRank(a) - sortRank(b));

  // Split by the CURRENTLY selected option's seeders (not the item's best
  // option overall - a bumped-to fallback can be worse or better than the
  // one that just failed) into two independently-capped queues - see
  // FAST_DOWNLOAD_CONCURRENCY/RISKY_DOWNLOAD_CONCURRENCY above for why this
  // is predicted upfront rather than reacted to after the fact.
  function currentSeeders(item) {
    const { optionsKey, indexKey } = qualityTier(item);
    const options = item[optionsKey];
    if (!options || options.length === 0) return 0;
    return options[item[indexKey] || 0]?.seeders ?? 0;
  }
  let fastQueue = picked.filter((i) => currentSeeders(i) >= SEEDER_THRESHOLD);
  let riskyQueue = picked.filter((i) => currentSeeders(i) < SEEDER_THRESHOLD);

  emit("pipeline_start", {
    alreadyUploaded: alreadyUploaded.length,
    picked: picked.length,
    fastQueued: fastQueue.length,
    riskyQueued: riskyQueue.length,
    total: withTorrents.length,
    concurrency: UPLOAD_CONCURRENCY,
    fastDownloadConcurrency: FAST_DOWNLOAD_CONCURRENCY,
    riskyDownloadConcurrency: RISKY_DOWNLOAD_CONCURRENCY,
  });

  console.log(`Status:`);
  console.log(`  Already on S3: ${alreadyUploaded.length}`);
  console.log(`  Ready to download: ${picked.length} (${fastQueue.length} fast-lane, ${riskyQueue.length} risky/low-seeder)`);
  console.log(`  Total with torrents: ${withTorrents.length}`);
  console.log(`  Download concurrency: ${FAST_DOWNLOAD_CONCURRENCY} fast + ${RISKY_DOWNLOAD_CONCURRENCY} risky torrent(s) at once`);
  console.log(`  Upload concurrency: ${UPLOAD_CONCURRENCY} files at once\n`);

  let downloaded = 0;
  let uploaded = 0;
  let itemsDone = 0;
  const startTime = Date.now();
  const startDate = new Date().toLocaleString();

  console.log(`Started at: ${startDate}\n`);

  const channel = createChannel();
  // Per-item bookkeeping shared across upload workers: a season pack's
  // episodes are flattened into individual channel entries (see
  // downloadPhase) so multiple episodes can upload concurrently, but the
  // item is only "done" (s3_key set, itemDir removed) once every one of its
  // files reports back. Plain object mutation is safe here - everything
  // below is synchronous between await points, and JS has no true
  // parallelism, so concurrent workers can't corrupt a tracker.
  const trackers = new Map();

  // With DOWNLOAD_CONCURRENCY > 1, a plain getAvailableSpace() check isn't
  // enough: two workers can both sample the same free-space number before
  // either has written a byte and both pass, overcommitting the disk. This
  // tracks space already handed out to in-flight downloads (reserved here,
  // released once that download's aria2c process exits - see downloadPhase)
  // so later checks see it as spoken-for even though the OS hasn't observed
  // any usage yet.
  let reservedBytes = 0;

  // A fixed floor kept free at all times, regardless of any single
  // torrent's own size math - many individually-small downloads can still
  // collectively fill the disk from backlog alone (confirmed live: disk hit
  // 100% full multiple times in one night even though each download's own
  // requiredSpace check passed at the time it started - the accumulated
  // *unprocessed* backlog from earlier downloads, sitting on disk waiting
  // for a slow transcode+upload stage to catch up, was never accounted for
  // by any single item's own check).
  // 40GB floor was calibrated for the Mac's 926GB disk. On a caixote worker
  // with a smaller root/volume, override via MIN_FREE_GB (e.g. 5).
  const MIN_FREE_BYTES = (Number(process.env.MIN_FREE_GB) || 40) * 1024 * 1024 * 1024;

  // Real backpressure between the download and upload sides, which
  // otherwise run as two fully independent loops with nothing connecting
  // them - downloads keep claiming new items and finishing in minutes while
  // uploads to this bucket crawl at ~150-300KB/s per connection, so the
  // download side just keeps racing ahead, piling up raw un-uploaded files
  // on disk with no limit. This tracks the total size of every video file
  // currently sitting downloaded-but-not-yet-uploaded (queued in the
  // channel or actively being transcoded/uploaded right now), incremented
  // when a file is queued (see downloadPhase) and decremented once it's
  // been fully handled, success or failure (see processOneVideo).
  //
  // Used to tolerate up to a 20GB backlog before pausing new downloads, on
  // the theory that keeping the upload workers fed was worth some raw files
  // sitting on disk. That theory cost a full disk: several big TV season
  // packs finishing around the same time blew past whatever headroom was
  // left, and transcoding needs its own full-size temp copy on top of the
  // still-present source file, so "20GB of backlog" could still walk the
  // disk straight into a real "No space left on device" mid-transcode
  // (confirmed live: Rome/This Is Us failed transcodes this way). Now zero
  // tolerance - a new download can't start while *anything* is still
  // downloaded-but-not-yet-uploaded, so the pipeline downloads a batch of at
  // most FAST_DOWNLOAD_CONCURRENCY + RISKY_DOWNLOAD_CONCURRENCY items, then
  // fully drains it (every file transcoded and uploaded) before touching
  // disk again.
  //
  // This counter alone only tracks backlog *this process* creates - it
  // resets to 0 on every restart, with no memory of raw/transcoded files a
  // previous run left on disk (confirmed live: restarting straight into 4
  // fresh downloads on top of an existing 270GB of untouched downloads/ +
  // .transcoded backlog, because the fresh process genuinely had no idea
  // that backlog existed). requeueExistingDownloads (below) closes that gap
  // by incrementing this exact counter for whatever it finds already on
  // disk, the same way a fresh download normally does - a restart now has
  // to drain whatever's really on disk, not just whatever it personally
  // downloaded since it started.
  //
  // A first version of this seeded the counter from a blind `du -sk` of the
  // whole DOWNLOADS_DIR instead. That double-counted: a "Reusing
  // already-transcoded file" item has *two* copies of the same logical
  // video on disk at once (the raw source in downloads/<id>/ *and* its
  // already-finished output in .transcoded/), so `du` counted both, but
  // only the raw source's size ever gets subtracted back out in
  // processOneVideo's decrement - the .transcoded copy's bytes had nothing
  // to decrement them. Every such item left a permanent, un-drainable
  // residual, so pendingUploadBytes could never reach 0 again and every
  // future download stayed blocked forever (confirmed live: the pipeline
  // sat fully idle - no process CPU, no aria2c/ffmpeg children, nothing new
  // in pipeline-events.jsonl - for 21+ hours, deadlocked on a backlog number
  // that no longer corresponded to anything real still needing to drain).
  let pendingUploadBytes = 0;

  async function waitForUploadBacklog(label) {
    let waited = false;
    while (pendingUploadBytes > 0) {
      if (!waited) {
        const pendingGB = (pendingUploadBytes / 1024 / 1024 / 1024).toFixed(1);
        console.log(`  ⏳ [${label}] Waiting - ${pendingGB}GB still downloaded and not yet uploaded, not starting a new download until it's fully drained`);
        waited = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }

  // Checked once, immediately, no waiting - if there isn't room, this item
  // is skipped for this run entirely (picked up again on the next restart)
  // rather than blocking a download slot indefinitely or overcommitting the
  // disk (confirmed: the previous wait-in-a-loop version had already caused
  // real ENOSPC crashes since "eventually there's room" isn't guaranteed
  // when disk pressure is systemic, not transient).
  function hasEnoughSpace(requiredSpace, label) {
    const availableSpace = getAvailableSpace();
    if (availableSpace === null) return true; // statfs unsupported - can't check, don't block
    const effectiveAvailable = availableSpace - reservedBytes;
    // Require room for the download itself *and* a full same-size copy for
    // the transcode's temporary output, which can rival the source's size
    // even after downscaling (10-bit HEVC sources in particular don't
    // shrink much converting to 720p H.264) - both copies exist on disk
    // simultaneously during that step.
    const required = requiredSpace * 2;
    if (required <= effectiveAvailable - MIN_FREE_BYTES) {
      reservedBytes += requiredSpace;
      return true;
    }
    const availableGB = (effectiveAvailable / 1024 / 1024 / 1024).toFixed(1);
    const requiredGB = (required / 1024 / 1024 / 1024).toFixed(1);
    console.log(`  ⏭ [${label}] Skipping - not enough disk space (need ~${requiredGB}GB incl. transcode headroom + ${MIN_FREE_BYTES / 1024 / 1024 / 1024}GB floor, have ${availableGB}GB free)`);
    return false;
  }

  // waitForUploadBacklog blocks every claimed item until pendingUploadBytes
  // drains to 0 - correct for items that still need a fresh aria2c download
  // (that's the whole point), but a restart's `picked` list also contains
  // items a previous run already fully downloaded into downloads/<id>/
  // before getting interrupted (killed, or crashed on ENOSPC mid-transcode
  // - see pendingUploadBytes' startup seed above). Those files are exactly
  // what needs to be drained; they can't drain themselves while every
  // download worker is blocked waiting for them to drain, which is a real
  // deadlock (confirmed live: a restart sat at 4/4 workers stuck on
  // "waiting - 218.4GB..." with no aria2c/ffmpeg process running at all,
  // because nothing was left to feed the upload side). This runs once,
  // synchronously, before any worker starts: anything already sitting on
  // disk skips the backlog wait and goes straight into the same channel a
  // completed download would, and is pulled out of fastQueue/riskyQueue so
  // a worker doesn't also try to re-download it from scratch.
  // aria2c keeps a `<torrent-name>.aria2` control file alongside a download
  // until the *entire* torrent finishes - for a multi-file torrent that's
  // one file covering every piece across all its files, not one per file,
  // and it only gets deleted on full completion. A file that already looks
  // done by extension can still be sitting mid-download if the whole
  // torrent got interrupted before finishing (confirmed live: a killed run
  // left "Terminator Dark Fate...mp4" at 1.1GB - actually a 72%-complete,
  // truncated file - and requeueExistingDownloads swept it up as "already
  // downloaded, ready for transcode" anyway, since getVideoFiles only checks
  // file extension, not completeness; the resulting transcode predictably
  // failed with "ffmpeg exit 228: Conversion failed!"). This walks the same
  // tree getVideoFiles does, just looking for that control file instead.
  function hasIncompleteAria2Download(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (hasIncompleteAria2Download(fullPath)) return true;
      } else if (entry.name.endsWith(".aria2")) {
        return true;
      }
    }
    return false;
  }

  function requeueExistingDownloads() {
    let requeuedCount = 0;
    for (const item of picked) {
      const itemDir = path.join(DOWNLOADS_DIR, item.id);
      if (!fs.existsSync(itemDir)) continue;
      if (hasIncompleteAria2Download(itemDir)) {
        // Leave it in fastQueue/riskyQueue untouched - its normal
        // runDownload -> downloadViaAria2c call will resume it via aria2c's
        // own --continue=true using exactly the bytes already here, instead
        // of either wrongly transcoding a truncated file or (worse)
        // restarting the whole download from 0% and throwing that progress
        // away.
        continue;
      }
      let videos = getVideoFiles(itemDir);
      if (videos.length === 0) continue;

      // Same dedup as the fresh-download path below - a bundled bonus file
      // must not become a movie's primary (and only) file.
      if (item.content_type === "movie" && videos.length > 1) {
        const bySize = videos.map((v) => ({ path: v, size: fs.statSync(v).size })).sort((a, b) => b.size - a.size);
        videos = [bySize[0].path];
      }

      console.log(`  [${item.title}] ${videos.length} file(s) already on disk from a previous run - queuing for transcode/upload, not re-downloading`);
      trackers.set(item.id, {
        item,
        itemDir,
        remaining: videos.length,
        newKeys: [...new Set(item.s3_keys || [])],
        allOk: true,
      });
      for (const videoPath of videos) {
        // Mirrors exactly what a fresh download's push does (see
        // downloadPhase) - same counter, same decrement path in
        // processOneVideo, so there's nothing left uncounted.
        const sizeBytes = fs.statSync(videoPath).size;
        pendingUploadBytes += sizeBytes;
        channel.push({ item, videoPath, sizeBytes });
      }
      requeuedCount++;
    }
    if (requeuedCount > 0) {
      const pendingGB = (pendingUploadBytes / 1024 / 1024 / 1024).toFixed(1);
      console.log(`  Requeued ${requeuedCount} already-downloaded item(s) for processing (${pendingGB}GB) - draining that before any new download starts.\n`);
      fastQueue = fastQueue.filter((i) => !trackers.has(i.id));
      riskyQueue = riskyQueue.filter((i) => !trackers.has(i.id));
    }

    // .transcoded/ can also hold tmp output with no live tracker at all this
    // run - an item that finished on a *different* torrent release since
    // (see processOneVideo - tmpPath is keyed by exact filename, so a bumped
    // option's file never matches the old tmp's name), or one dropped from
    // the catalog entirely (confirmed live: a leftover tmp for a movie no
    // longer even present in enriched_400.json). Nothing above ever queues
    // these, so nothing will ever delete them either unless this does -
    // nothing ties them to pendingUploadBytes since they were never queued.
    let reclaimedBytes = 0;
    for (const name of fs.readdirSync(TRANSCODE_TMP_DIR)) {
      const id = name.split("__")[0];
      if (trackers.has(id)) continue; // legitimately in flight this run - leave it for the reuse shortcut
      const fullPath = path.join(TRANSCODE_TMP_DIR, name);
      try {
        reclaimedBytes += fs.statSync(fullPath).size;
        fs.rmSync(fullPath, { force: true });
      } catch {}
    }
    if (reclaimedBytes > 0) {
      console.log(`  Cleared ${(reclaimedBytes / 1024 / 1024 / 1024).toFixed(2)}GB of orphaned transcoded file(s) not tied to any item this run.\n`);
    }
  }

  async function downloadPhase() {
    // Two independent cursors, each claimed synchronously (no `await`
    // between the check and the increment) so concurrent workers can't
    // double-claim the same item - same pattern as createChannel() above.
    // `claimedCount` spans both queues purely for the "[download N/Total]"
    // display to still read as one continuous progress count.
    let nextFastIndex = 0;
    let nextRiskyIndex = 0;
    let claimedCount = 0;

    function claimRisky() {
      // Once a shutdown signal has been received, stop handing out new
      // items - otherwise a worker whose current aria2c just got killed (see
      // shutdownAndExit) immediately claims the next one and spawns a fresh
      // child during the grace window, so the process never actually winds
      // down (confirmed: it kept starting new downloads minutes after
      // receiving SIGTERM).
      if (shuttingDown || networkCircuitOpen) return null;
      if (nextRiskyIndex >= riskyQueue.length) return null;
      claimedCount++;
      return riskyQueue[nextRiskyIndex++];
    }

    function claimFast() {
      if (shuttingDown || networkCircuitOpen) return null;
      if (nextFastIndex < fastQueue.length) {
        claimedCount++;
        return fastQueue[nextFastIndex++];
      }
      // Fast queue drained - nothing predicted-quick left to do, so help
      // drain the risky queue instead of sitting idle. This is what lets
      // "risky" concurrency grow past RISKY_DOWNLOAD_CONCURRENCY once there's
      // nothing fast left competing for slots.
      return claimRisky();
    }

    async function runDownload(item) {
      const position = claimedCount; // already incremented by whichever claim call handed this out
      const pct = (((position - 1) / picked.length) * 100).toFixed(1);
      console.log(`\n[download ${position}/${picked.length}] (${pct}%) ${item.title}`);

      await waitForUploadBacklog(item.title);

      const { label: qualityLabel, optionsKey, indexKey } = qualityTier(item);
      const options = item[optionsKey];
      if (!options || options.length === 0) {
        console.log(`  ⚠ No torrent options`);
        return;
      }

      const torrentIndex = item[indexKey] || 0;
      const torrent = options[torrentIndex];

      console.log(`  [${qualityLabel}] Option ${torrentIndex + 1}/${options.length}: ${torrent.title}`);
      console.log(`  Seeders: ${torrent.seeders} | Size: ${torrent.size}`);

      // Each item downloads into its own subdirectory rather than the shared
      // DOWNLOADS_DIR root, so getVideoFiles can never scoop up an unrelated
      // item's leftover files (e.g. from a prior run that crashed before
      // uploading them) and misattribute them to whatever downloads next.
      const itemDir = path.join(DOWNLOADS_DIR, item.id);
      fs.mkdirSync(itemDir, { recursive: true });

      // Advances to the next torrent option (if any). Only wipes itemDir
      // when there is nothing worth resuming: partial bytes against the
      // *same* magnet are exactly what --continue=true needs, and wiping
      // them on every stall was the live cause of "5 days of zero
      // progress" (retries kept progress, then bumpOption deleted it all
      // the moment retries ran out). Different magnets can't resume each
      // other's files, so we still clean when actually switching options
      // *and* the current dir has no useful bytes - or when the caller
      // forces a wipe (wrong content / runtime mismatch / no video).
      function bumpOption(reason, { forceWipe = false } = {}) {
        console.log(`  ✗ [${item.title}] ${reason}`);
        emit("download_error", { item: item.title, id: item.id, error: reason });
        const hasPartial = dirHasBytes(itemDir);
        const canAdvance = torrentIndex < options.length - 1;
        // Keep partials unless the caller insists (content is wrong) or
        // we're moving to a different magnet *and* the dir is empty
        // anyway. Never throw away real bytes just because the swarm went
        // quiet - next run resumes the same option from disk.
        const shouldWipe = forceWipe || (!hasPartial && canAdvance);
        if (shouldWipe) {
          try {
            // maxRetries/retryDelay handle the documented Node.js race where a
            // recursive rmSync throws ENOTEMPTY/EBUSY because something else
            // (a just-killed aria2c/ffmpeg child releasing its file handle,
            // another worker still touching a sibling file in the same
            // itemDir) is mid-write at the exact instant this runs. The outer
            // try/catch is a second layer on top of that - even a retried-out
            // failure here must not crash the whole pipeline (confirmed live:
            // an uncaught ENOTEMPTY from this exact call took the entire
            // process down with it, and it stayed dead for ~15 hours before
            // anyone noticed - a bad cleanup for one item is not worth that).
            fs.rmSync(itemDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          } catch (cleanupError) {
            console.log(`  ⚠ [${item.title}] Failed to clean up ${itemDir}: ${cleanupError.message} (leaving it - will retry cleanup next time this item is attempted)`);
          }
        } else if (hasPartial) {
          console.log(`  💾 [${item.title}] Keeping ${itemDir} partials on disk for --continue resume (not wiping after: ${reason})`);
        }
        // Only advance the option index when there is no partial to resume
        // *or* the content is proven wrong. With real bytes on disk, stay
        // on the same magnet so the next attempt/run picks up mid-file.
        if (canAdvance && (forceWipe || !hasPartial)) {
          item[indexKey] = torrentIndex + 1;
          console.log(`  → [${item.title}] Will retry with option ${item[indexKey] + 1} next time`);
          // Switching magnets: any leftover from the previous magnet is
          // unusable and must go, even if somehow hasPartial was true
          // under forceWipe (wrong content / runtime mismatch).
          if (forceWipe && hasPartial) {
            try {
              fs.rmSync(itemDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch (cleanupError) {
              console.log(`  ⚠ [${item.title}] Failed to clean up ${itemDir}: ${cleanupError.message}`);
            }
          }
        } else if (hasPartial && !forceWipe) {
          console.log(`  → [${item.title}] Staying on option ${torrentIndex + 1}/${options.length} so partial progress can resume`);
        }
        saveEnrichedData();
      }

      // A 0-seeder torrent has no complete copy anywhere in the swarm - no
      // amount of retrying, patience, or connection quality can ever finish
      // it. Confirmed live: 41 of 92 remaining items (44.5%) were sitting on
      // a 0-seeder option, each burning up to DOWNLOAD_OPTION_RETRIES
      // attempts x a 6-15min stall timeout before giving up. Skip
      // immediately (after bumpOption exists so itemDir cleanup is safe).
      if (Number(torrent.seeders) === 0) {
        bumpOption("0 seeders - no complete copy exists in the swarm, skipping without attempting");
        return;
      }

      const torrentSizeBytes = parseSize(torrent.size);
      const requiredSpace = Math.ceil(torrentSizeBytes * OVERHEAD_BUFFER);
      if (!hasEnoughSpace(requiredSpace, item.title)) {
        emit("download_skipped", { item: item.title, id: item.id, reason: "insufficient disk space" });
        return;
      }

      emit("download_start", { item: item.title, id: item.id, sizeBytes: torrentSizeBytes });
      try {
        console.log(`  [${item.title}] Downloading...`);
        const stallTimeoutMs = torrent.seeders < SEEDER_THRESHOLD ? RISKY_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
        try {
          // Retries the *same* magnet before giving up on this option -
          // bumpOption's cleanup deletes itemDir unconditionally on any
          // failure, which used to run even for a plain transient stall,
          // throwing away everything already downloaded and forcing a
          // restart from 0% on the next attempt (confirmed live: this was
          // the actual cause of "no progress for days" on large/risky
          // items - every stall permanently destroyed real progress
          // instead of just trying the identical magnet again, even though
          // aria2c's own --continue=true would have resumed it for free).
          // No cleanup between attempts here since it's the same magnet -
          // the partial files on disk are exactly what --continue=true
          // needs to pick back up where it left off.
          let lastError;
          for (let attempt = 1; attempt <= DOWNLOAD_OPTION_RETRIES; attempt++) {
            try {
              await downloadViaAria2c(torrent.magnet, itemDir, item.title, stallTimeoutMs);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < DOWNLOAD_OPTION_RETRIES) {
                console.log(`  ⏳ [${item.title}] Attempt ${attempt}/${DOWNLOAD_OPTION_RETRIES} failed (${error.message}) - retrying the same torrent, progress kept`);
                await new Promise((resolve) => setTimeout(resolve, 15000));
              }
            }
          }
          if (lastError) {
            // aria2c exit 9 is disk space, not this torrent (confirmed via
            // the aria2 manual: "there was not enough disk space
            // available") - confirmed live on 2026-07-30, Spider-Man hit
            // this on every one of 8 attempts, each after aria2c's own
            // progress reported 100%. bumpOption's job is "try a different
            // torrent", which fixes nothing here (a different magnet still
            // needs disk space) and its unconditional rmSync would throw
            // away real, mostly-complete, --continue=true-resumable bytes
            // just to start an unrelated swarm from zero. Leave the torrent
            // choice and partial download exactly as they are instead - the
            // next full pipeline run resumes this same magnet from wherever
            // it left off, ideally after other concurrent items have
            // finished and freed real disk space.
            if (/aria2c exit 9\b/.test(lastError.message)) {
              console.log(`  ⏸ [${item.title}] Out of disk space after ${DOWNLOAD_OPTION_RETRIES} attempts on this torrent - leaving it as-is (same option, partial bytes kept) instead of discarding progress`);
              emit("download_skipped", { item: item.title, id: item.id, reason: "insufficient disk space mid-download" });
              return;
            }
            throw lastError;
          }
        } finally {
          // Real bytes are on disk now (or every attempt is over) - the
          // OS's own free-space number covers it from here on, so this
          // item no longer needs to hold a reservation on top of that.
          reservedBytes -= requiredSpace;
        }
        downloaded++;

        let videos = getVideoFiles(itemDir);
        if (videos.length === 0) {
          // Whatever landed isn't a video we can use - wipe and try next magnet.
          bumpOption("no video files found", { forceWipe: true });
          return;
        }

        // A movie's torrent can bundle bonus content (deleted scenes,
        // trailers, making-of featurettes) as separate video files
        // alongside the real feature - all of which transcode/upload
        // successfully, all of which end up in s3_keys, breaking both the
        // "one file" assumption and the frontend's episode picker for
        // movies with more than one entry (confirmed live: One Flew Over
        // the Cuckoo's Nest ended up with a documentary short as its
        // primary file and a broken "episode" list of bonus features). The
        // real feature is essentially always the largest file by a wide
        // margin - TV items legitimately have one video per episode and
        // must keep them all, so this only applies to movies.
        if (item.content_type === "movie" && videos.length > 1) {
          const bySize = videos.map((v) => ({ path: v, size: fs.statSync(v).size })).sort((a, b) => b.size - a.size);
          const dropped = bySize.slice(1);
          console.log(`  [${item.title}] Keeping largest file, ignoring ${dropped.length} bonus/extra file(s): ${dropped.map((d) => path.basename(d.path)).join(", ")}`);
          videos = [bySize[0].path];
        }

        // A wildly-off runtime means the actual file doesn't match its own
        // (otherwise convincing) torrent title - undetectable from the
        // title alone (confirmed live: a "Back to the Future (1985)"
        // labeled torrent's real file was Part III; a "The Pianist" labeled
        // torrent's real file ran 59 minutes against a real ~150 minute
        // runtime). Tolerance is generous - director's cuts/extended
        // editions can legitimately run longer - this is only meant to
        // catch "this is a different, unrelated file," not flag every
        // re-edit.
        if (item.content_type === "movie" && item.runtime) {
          const expectedMinutes = parseInt(item.runtime, 10);
          if (expectedMinutes > 0) {
            const actualSeconds = probeDurationSeconds(videos[0]);
            const actualMinutes = actualSeconds ? actualSeconds / 60 : null;
            if (actualMinutes && Math.abs(actualMinutes - expectedMinutes) > Math.max(20, expectedMinutes * 0.4)) {
              // Wrong content - partials are for the wrong file, must wipe.
              bumpOption(`runtime mismatch: expected ~${expectedMinutes}min, file is ~${Math.round(actualMinutes)}min`, { forceWipe: true });
              return;
            }
          }
        }

        emit("download_done", { item: item.title, id: item.id, fileCount: videos.length });
        trackers.set(item.id, {
          item,
          itemDir,
          remaining: videos.length,
          newKeys: [...new Set(item.s3_keys || [])],
          allOk: true,
        });
        for (const videoPath of videos) {
          const sizeBytes = fs.statSync(videoPath).size;
          pendingUploadBytes += sizeBytes;
          channel.push({ item, videoPath, sizeBytes });
        }
      } catch (error) {
        const wroteAnyBytes = dirHasBytes(itemDir);
        // Stall/timeout after real partials: keep bytes, stay on same option
        // (bumpOption handles that via hasPartial). Only zero-byte failures
        // advance the option index and count toward the network circuit.
        bumpOption(error.message, { forceWipe: false });
        if (wroteAnyBytes) {
          consecutiveZeroByteFailures = 0;
        } else {
          consecutiveZeroByteFailures++;
          // High-seeder items that write zero bytes are a stronger signal
          // of network failure than sparse-swarm stalls - open the circuit
          // after fewer of those so we don't grind the whole queue for hours.
          const seeders = Number(torrent.seeders) || 0;
          const threshold = seeders >= SEEDER_THRESHOLD ? 2 : NETWORK_CIRCUIT_THRESHOLD;
          if (consecutiveZeroByteFailures >= threshold && !networkCircuitOpen) {
            networkCircuitOpen = true;
            console.log(
              `\n🛑 ${consecutiveZeroByteFailures} items in a row wrote zero bytes before giving up` +
                (seeders >= SEEDER_THRESHOLD ? ` (including well-seeded swarms)` : ``) +
                ` - this looks like a network problem (not bad torrents). Pausing new downloads; anything already in flight finishes normally. ` +
                `Check [NETDIAG] output and this host's outbound network before restarting.\n`,
            );
            emit("network_circuit_open", { consecutiveZeroByteFailures, lastSeeders: seeders });
          }
        }
      }
    }

    async function fastWorker() {
      let item;
      while ((item = claimFast())) await runDownload(item);
    }
    async function riskyWorker() {
      let item;
      while ((item = claimRisky())) await runDownload(item);
    }

    await Promise.all([
      ...Array.from({ length: FAST_DOWNLOAD_CONCURRENCY }, () => fastWorker()),
      ...Array.from({ length: RISKY_DOWNLOAD_CONCURRENCY }, () => riskyWorker()),
    ]);
    channel.close();
  }

  function finalizeItem(tracker) {
    const { item, itemDir, newKeys, allOk } = tracker;

    if (newKeys.length > 0) item.s3_keys = newKeys;
    // A movie's torrent can bundle extra junk alongside the actual film - a
    // second-resolution bonus rip, a sample clip - that can be permanently
    // broken for reasons unrelated to the real file (confirmed: Spider-Man's
    // 1080p companion file has never once transcoded, while its 720p file
    // uploads fine every time). Requiring every file in the torrent to
    // succeed was blocking a fully watchable movie from ever being marked
    // done over a bonus file nobody needed, forcing it onto its last, worse
    // torrent option forever once the good option's "failure" burned it. A
    // series still needs every episode before it's considered done.
    const isComplete = item.content_type === "movie" ? newKeys.length > 0 : (allOk && newKeys.length > 0);
    item.s3_key = isComplete ? newKeys[0] : undefined;

    if (isComplete) {
      item[qualityTier(item).indexKey] = 0; // Reset to first option if successful
      uploaded++;
      // Everything for this item lives under its own itemDir (see
      // downloadPhase), so once every file is uploaded the whole thing -
      // including any .nfo/.jpg/.srt cruft the torrent bundled - can go.
      // Same ENOTEMPTY race as bumpOption's cleanup below, and this one
      // runs on every single successful item, not just failures - equally
      // must not crash the whole pipeline over one item's tidy-up.
      try {
        fs.rmSync(itemDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cleanupError) {
        console.log(`  ⚠ [${item.title}] Failed to clean up ${itemDir}: ${cleanupError.message}`);
      }
      console.log(`  🗑 [${item.title}] Cleaned up, ${newKeys.length} video(s) on S3`);
      emit("item_done", { item: item.title, id: item.id, fileCount: newKeys.length });
    } else {
      console.log(`  ⚠ [${item.title}] ${newKeys.length} video(s) on S3, some still failed — will retry next run`);
      emit("item_failed", { item: item.title, id: item.id, fileCount: newKeys.length });
    }

    itemsDone++;
    trackers.delete(item.id);
    // Save progress after every item (each one can represent a whole
    // season's worth of slow uploads, so losing progress to a restart is
    // too expensive to batch this).
    saveEnrichedData();
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const donePct = ((itemsDone / picked.length) * 100).toFixed(1);
    console.log(`  [${itemsDone}/${picked.length} item(s) fully done (${donePct}%), ${uploaded} uploaded, ${elapsed}m elapsed]\n`);
  }

  // One file failing outright (bad probe, transcode error, etc.) must not
  // take down the whole pipeline or the other files/workers - see the
  // try/catch below, added after an unhandled ENOENT here previously killed
  // an in-progress run.
  async function processOneVideo({ item, videoPath, sizeBytes }) {
    const label = `${item.title} - ${path.basename(videoPath, path.extname(videoPath))}`;
    const tracker = trackers.get(item.id);

    try {
      const filename = path.basename(videoPath);
      const mp4Name = browserMp4Name(filename);
      const s3Key = `${S3_PREFIX(item.id)}${mp4Name}`;

      if (new Set(item.s3_keys || []).has(s3Key)) {
        fs.unlinkSync(videoPath);
        return;
      }

      const tmpPath = path.join(TRANSCODE_TMP_DIR, `${item.id}__${mp4Name}`);
      const sourceSizeMB = fs.statSync(videoPath).size / 1024 / 1024;
      if (fs.existsSync(tmpPath)) {
        // transcodeForBrowser only renames into tmpPath on full success (see
        // transcode.js), so its presence means a prior run already finished
        // this exact transcode and got interrupted before/during upload -
        // reuse it instead of redoing what can be 10s of minutes of ffmpeg
        // work for nothing on every restart (confirmed: 16GB of these were
        // sitting unused in TRANSCODE_TMP_DIR, some redone from scratch
        // more than once).
        console.log(`  [${label}] Reusing already-transcoded file`);
      } else {
        await acquireTranscodeSlot();
        try {
          process.stdout.write(`  [${label}] Transcoding... `);
          emit("transcode_start", { item: item.title, id: item.id, file: mp4Name, sourceSizeMB });
          await transcodeForBrowser(videoPath, tmpPath, { maxHeight: 720, trackChild: activeChildren });
          console.log(`[${label}] ✓`);
          emit("transcode_done", { item: item.title, id: item.id, file: mp4Name, outSizeMB: fs.statSync(tmpPath).size / 1024 / 1024 });
        } finally {
          releaseTranscodeSlot();
        }
      }
      const outSizeMB = fs.statSync(tmpPath).size / 1024 / 1024;

      // Must run against `videoPath` (the original source) before it's
      // deleted below, not `tmpPath` - transcodeForBrowser already stripped
      // every subtitle track out of tmpPath. Best-effort: a source with no
      // text-based subtitle tracks, or a corrupt one, must not block the
      // video itself from uploading.
      let subtitleTracks = [];
      if (fs.existsSync(videoPath)) {
        try {
          const mp4Base = path.basename(mp4Name, ".mp4");
          const extracted = await extractSubtitles(videoPath, TRANSCODE_TMP_DIR, `${item.id}__${mp4Base}`, { trackChild: activeChildren });
          for (const sub of extracted) {
            const subKey = `${S3_PREFIX(item.id)}${mp4Base}.${sub.id}.vtt`;
            const subOk = await uploadToS3(sub.filePath, subKey, `${label} [${sub.id}]`, "text/vtt; charset=utf-8");
            fs.rmSync(sub.filePath, { force: true });
            if (subOk) subtitleTracks.push({ id: sub.id, lang: sub.lang, label: sub.label, forced: sub.forced, s3_key: subKey });
          }
          if (extracted.length > 0) {
            emit("subtitles_extracted", { item: item.title, id: item.id, file: mp4Name, found: extracted.length, uploaded: subtitleTracks.length });
          }
        } catch (error) {
          console.log(`  ⚠ [${label}] subtitle extraction failed: ${error.message}`);
        }
      }

      let uploadPath = tmpPath;
      let uploadContentType = "video/mp4";
      let encryptedThis = false;
      let hlsPlaylistKey = null;
      // Greenfield encrypt (RFC 0009): package HLS AES-128 from the local
      // browser MP4 and upload segments — no "upload plain → re-download →
      // re-encrypt" loop. Progressive SSESENC1 is skipped for new titles.
      if (shouldEncryptItem(item)) {
        const { packageHlsAes128 } = require("./lib/hls-package.cjs");
        const hlsDir = `${tmpPath}.hls`;
        fs.mkdirSync(hlsDir, { recursive: true });
        process.stdout.write(`  [${label}] Package HLS AES-128… `);
        try {
          const { playlistPath, segmentFiles } = packageHlsAes128({
            inputPath: tmpPath,
            outDir: hlsDir,
            catalogKey32: encryptionCatalogKey,
            segmentSeconds: 4,
          });
          const episode =
            item.content_type === "movie" ? 0 : tracker.newKeys.length + 1;
          const hlsPrefix =
            item.content_type === "movie" || episode <= 0
              ? `${S3_PREFIX(item.id)}hls`
              : `${S3_PREFIX(item.id)}hls/e${episode}`;
          hlsPlaylistKey = `${hlsPrefix}/index.m3u8`;
          // Bounded parallel segment uploads.
          const concurrency = 12;
          let segOk = 0;
          let cursor = 0;
          async function segWorker() {
            while (cursor < segmentFiles.length) {
              const i = cursor++;
              const seg = segmentFiles[i];
              const name = path.basename(seg);
              const ok = await uploadToS3(
                seg,
                `${hlsPrefix}/${name}`,
                `${label} hls/${name}`,
                "video/mp2t",
              );
              if (ok) segOk++;
            }
          }
          await Promise.all(
            Array.from(
              { length: Math.min(concurrency, segmentFiles.length) },
              () => segWorker(),
            ),
          );
          const plOk = await uploadToS3(
            playlistPath,
            hlsPlaylistKey,
            `${label} hls/index.m3u8`,
            "application/vnd.apple.mpegurl",
          );
          fs.rmSync(hlsDir, { recursive: true, force: true });
          if (!plOk || segOk < segmentFiles.length) {
            throw new Error(
              `HLS upload incomplete (${segOk}/${segmentFiles.length} segs, playlist=${plOk})`,
            );
          }
          console.log(`[${label}] ✓ ${segmentFiles.length} segs → ${hlsPlaylistKey}`);
          encryptedThis = true;
          // Movies: store full playlist key. Series: store prefix so the
          // playlist API can resolve e{n}/index.m3u8 per episode.
          if (item.content_type === "movie" || episode <= 0) {
            item.hls_playlist_s3_key = hlsPlaylistKey;
          } else {
            item.hls_playlist_s3_key = `${S3_PREFIX(item.id)}hls`;
          }
          // Keep progressive upload for s3_key / cast fallback: still the
          // browser MP4 (unencrypted only if we chose not to encrypt — here
          // we upload progressive as application/octet is skipped; use mp4
          // under s3_key so "has stream" stays true). Progressive is NOT
          // the primary player path when hls_playlist_s3_key is set.
        } catch (e) {
          fs.rmSync(hlsDir, { recursive: true, force: true });
          console.log(`[${label}] HLS package failed (${e.message}) — falling back to progressive upload`);
          hlsPlaylistKey = null;
          encryptedThis = false;
        }
      }

      const uploadSizeMB = fs.statSync(uploadPath).size / 1024 / 1024;
      emit("upload_start", {
        item: item.title,
        id: item.id,
        file: mp4Name,
        sizeMB: uploadSizeMB,
        encrypted: encryptedThis,
        hls: Boolean(hlsPlaylistKey),
      });
      // When HLS is primary, skip progressive plaintext upload — that was the
      // "send normal then re-encrypt later" anti-pattern. s3_key is still
      // recorded so pipeline completion / hasStream keep working; player
      // uses hls_playlist_s3_key.
      let uploadOk = true;
      if (encryptedThis && hlsPlaylistKey) {
        console.log(`  [${label}] skip progressive upload (HLS is primary)`);
      } else {
        uploadOk = await uploadToS3(uploadPath, s3Key, label, uploadContentType);
      }
      fs.rmSync(tmpPath, { force: true });
      if (uploadPath !== tmpPath) fs.rmSync(uploadPath, { force: true });

      if (uploadOk) {
        // Position in `newKeys` at the moment of push is exactly the
        // 1-based episode number the frontend/backend already use
        // (originalIndex+1 into s3_keys) - computed here, synchronously
        // with the push and with no `await` in between, since concurrent
        // upload workers can otherwise interleave between reading a
        // "next index" and claiming it.
        const episode = item.content_type === "movie" ? 0 : tracker.newKeys.length + 1;
        tracker.newKeys.push(s3Key);
        if (encryptedThis) item.encrypted = true;
        fs.unlinkSync(videoPath);
        if (subtitleTracks.length > 0) {
          item.subtitles = item.subtitles || [];
          for (const sub of subtitleTracks) {
            if (!item.subtitles.some((existing) => existing.s3_key === sub.s3_key)) {
              item.subtitles.push({ episode, ...sub });
            }
          }
        }
        emit("upload_done", {
          item: item.title,
          id: item.id,
          file: mp4Name,
          sizeMB: uploadSizeMB,
          encrypted: encryptedThis,
          hls: Boolean(hlsPlaylistKey),
        });
      } else {
        tracker.allOk = false;
        emit("upload_error", { item: item.title, id: item.id, file: mp4Name, error: "upload failed after retries" });
      }
    } catch (error) {
      console.log(`  ✗ [${label}] ${error.message}`);
      emit("file_error", { item: item.title, id: item.id, file: path.basename(videoPath), error: error.message });
      // ENOENT means this path vanished between the directory walk and now -
      // a stale leftover from an earlier failed/interrupted attempt into the
      // same itemDir, not a file that was actually part of this download.
      // Letting a ghost file fail the whole item blocks the real file(s)
      // from ever getting marked done, forcing a full re-download of an
      // already-uploaded torrent on every subsequent run (confirmed via
      // pipeline-events.jsonl on The Two Towers: the real file uploaded fine
      // but a stale sibling file's ENOENT poisoned the item anyway).
      if (error.code !== "ENOENT") tracker.allOk = false;
    } finally {
      // Runs on every exit from the try above - the early "already
      // uploaded" return, a clean success, and a caught error alike - so
      // the backlog this file represented is always released exactly
      // once, regardless of which path got taken.
      pendingUploadBytes -= sizeBytes;
    }

    tracker.remaining--;
    if (tracker.remaining === 0) finalizeItem(tracker);
  }

  async function uploadWorker() {
    for await (const work of channel) {
      await processOneVideo(work);
    }
  }

  requeueExistingDownloads();

  // downloadPhase's first "Waiting - not starting a new download..." line
  // always prints before any requeued item's "Transcoding..."/"Uploading..."
  // line, no matter which is listed first here - downloadPhase's workers
  // reach their console.log with zero `await`s in between, while
  // uploadWorker's `for await (const work of channel)` needs at least one
  // microtask tick just to receive its first item, and Node runs all
  // pending synchronous code before yielding to that microtask. Cosmetic
  // only: the actual gating is correct either way (those downloads really
  // are blocked on the backlog, not running) - not worth chasing a specific
  // print order for.
  await Promise.all([
    downloadPhase(),
    ...Array.from({ length: UPLOAD_CONCURRENCY }, () => uploadWorker()),
  ]);

  // Final save
  saveEnrichedData();

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const endDate = new Date().toLocaleString();

  console.log(`\n\n✅ Complete!`);
  console.log(`\nSummary:`);
  console.log(`  Started: ${startDate}`);
  console.log(`  Ended: ${endDate}`);
  console.log(`  Total time: ${totalTime} minutes`);
  console.log(`  Downloaded: ${downloaded}/${picked.length}`);
  console.log(`  Items fully uploaded: ${uploaded}`);
  console.log(`\nNote: Restart anytime - script will skip already uploaded items and continue.`);

  // The S3 client's HTTP keep-alive pool otherwise leaves the process
  // hanging indefinitely after
  // main() resolves, all work genuinely done, 0% CPU, nothing left to do -
  // download-trailers.js hit this exact issue first (see its own comment
  // here). Confirmed live 2026-07-18: a run finished (queue genuinely
  // exhausted, "Complete!" banner printed) and then just sat alive doing
  // nothing for the rest of the time until manually killed - looked
  // identical to a healthy idle process from the outside, wasting real
  // wall-clock time it could've spent on a fresh restart instead.
  process.exit(0);
}

processPickedTorrents().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
