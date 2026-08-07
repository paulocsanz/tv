/**
 * Package a progressive MP4 (or any ffmpeg-readable video) as HLS VOD with
 * AES-128-CBC segment encryption (RFC 0009).
 *
 * Key material: first 16 bytes of the 32-byte catalog media key (same key
 * used for SSESENC1). Playlist uses URI "sessao-key:catalog" so the browser
 * injects the key via hls.js — never stored as a public S3 object.
 *
 * Layout written under outDir:
 *   index.m3u8
 *   seg0000.ts, seg0001.ts, …
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const KEY_URI = "sessao-key:catalog";
const DEFAULT_SEGMENT_SECONDS = 4;

/**
 * @param {Buffer} catalogKey32 - 32-byte catalog AES key
 * @returns {Buffer} 16-byte AES-128 key for HLS
 */
function hlsAes128KeyFromCatalog(catalogKey32) {
  if (!Buffer.isBuffer(catalogKey32) || catalogKey32.length !== 32) {
    throw new Error(`catalog key must be 32-byte Buffer (got ${catalogKey32?.length})`);
  }
  return catalogKey32.subarray(0, 16);
}

/**
 * Run ffmpeg HLS package with AES-128 encryption.
 *
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.outDir - created if missing
 * @param {Buffer} opts.catalogKey32
 * @param {number} [opts.segmentSeconds=4]
 * @param {boolean} [opts.reencode=false] - if true, re-encode H.264/AAC; else stream-copy when possible
 * @returns {{ playlistPath: string, segmentFiles: string[], segmentSeconds: number }}
 */
function packageHlsAes128(opts) {
  const {
    inputPath,
    outDir,
    catalogKey32,
    segmentSeconds = DEFAULT_SEGMENT_SECONDS,
    reencode = false,
  } = opts;
  if (!fs.existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
  fs.mkdirSync(outDir, { recursive: true });

  const key16 = hlsAes128KeyFromCatalog(catalogKey32);
  const keyPath = path.join(outDir, ".hls.key");
  const keyInfoPath = path.join(outDir, ".hls.keyinfo");
  fs.writeFileSync(keyPath, key16);
  // keyinfo: URI\npath\n[IV hex optional — omit so ffmpeg uses media sequence IV]
  fs.writeFileSync(keyInfoPath, `${KEY_URI}\n${keyPath}\n`);

  const playlistPath = path.join(outDir, "index.m3u8");
  const segmentPattern = path.join(outDir, "seg%04d.ts");

  const ffArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath];
  if (reencode) {
    ffArgs.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    );
  } else {
    // Copy video when possible; re-encode audio to AAC for broad HLS compatibility.
    ffArgs.push("-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  }
  ffArgs.push(
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    segmentPattern,
    "-hls_key_info_file",
    keyInfoPath,
    playlistPath,
  );

  try {
    execFileSync("ffmpeg", ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // Copy may fail on non-H.264; retry with re-encode once.
    if (!reencode) {
      return packageHlsAes128({ ...opts, reencode: true });
    }
    const err = e.stderr?.toString?.() || e.message;
    throw new Error(`ffmpeg hls package failed: ${err}`);
  } finally {
    try {
      fs.unlinkSync(keyPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(keyInfoPath);
    } catch {
      /* ignore */
    }
  }

  // Normalize key URI in playlist (ffmpeg sometimes absolutizes the path).
  let playlist = fs.readFileSync(playlistPath, "utf8");
  playlist = playlist.replace(
    /#EXT-X-KEY:METHOD=AES-128,URI="[^"]+"/g,
    `#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI}"`,
  );
  fs.writeFileSync(playlistPath, playlist);

  const segmentFiles = fs
    .readdirSync(outDir)
    .filter((f) => /^seg\d+\.ts$/i.test(f))
    .sort()
    .map((f) => path.join(outDir, f));

  if (segmentFiles.length === 0) {
    throw new Error("ffmpeg produced no HLS segments");
  }

  return { playlistPath, segmentFiles, segmentSeconds };
}

/**
 * Rewrite an m3u8 so each relative segment filename becomes an absolute URL.
 * Lines that are already absolute http(s) are left alone. EXT-X-KEY URI is preserved.
 *
 * @param {string} playlistText
 * @param {(segmentFileName: string) => string} urlForSegment
 */
function rewritePlaylistSegmentUrls(playlistText, urlForSegment) {
  return playlistText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (/^https?:\/\//i.test(trimmed)) return line;
      // Relative segment path (e.g. seg0000.ts)
      const base = path.posix.basename(trimmed.replace(/\\/g, "/"));
      return urlForSegment(base);
    })
    .join("\n");
}

module.exports = {
  KEY_URI,
  DEFAULT_SEGMENT_SECONDS,
  hlsAes128KeyFromCatalog,
  packageHlsAes128,
  rewritePlaylistSegmentUrls,
};
