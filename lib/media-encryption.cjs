/**
 * Shared AES-256-GCM chunked media encryption (SSESENC1).
 *
 * Used by the acquisition pipeline (Node) and mirrored in the browser
 * (frontend/lib/crypto/media.ts). Keep the on-disk layout in lockstep.
 *
 * Layout:
 *   magic[8] = "SSESENC1"
 *   version u8 = 1
 *   compression u8 = 0 none | 1 gzip (of the payload before chunking)
 *   reserved[2] = 0
 *   chunk_size u32 BE  (plaintext bytes per chunk — after optional gzip)
 *   plaintext_size u64 BE  (size of the chunked payload; gzip size if compressed)
 *   then for each chunk:
 *     iv[12]
 *     ciphertext[chunk_len]
 *     tag[16]
 *
 * Playback path: stream-decrypt chunks → optional gunzip stream → fMP4/MSE.
 */

const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

const MAGIC = Buffer.from("SSESENC1", "ascii");
const VERSION = 1;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;
const HEADER_SIZE = 16; // 8 + 1 + 1 + 2 + 4
const PLAIN_SIZE_FIELD = 8;
const FULL_HEADER = HEADER_SIZE + PLAIN_SIZE_FIELD; // 24
const IV_LEN = 12;
const TAG_LEN = 16;
const DEFAULT_CHUNK = 1024 * 1024; // 1 MiB plaintext per chunk

function parseCatalogKey(envValue) {
  if (!envValue) return null;
  const buf = Buffer.from(envValue, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_CATALOG_KEY must be 32 bytes base64 (got ${buf.length} bytes after decode)`,
    );
  }
  return buf;
}

function writeHeader(chunkSize, plainSize, compression = COMPRESSION_NONE) {
  const header = Buffer.alloc(FULL_HEADER);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 8);
  header.writeUInt8(compression, 9);
  // reserved 10-11 already 0
  header.writeUInt32BE(chunkSize, 12);
  header.writeBigUInt64BE(BigInt(plainSize), 16);
  return header;
}

function readHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FULL_HEADER) {
    throw new Error("encrypted blob too short for header");
  }
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error("not SSESENC1");
  const version = buf.readUInt8(8);
  if (version !== VERSION) throw new Error(`unsupported SSESENC1 version ${version}`);
  const compression = buf.readUInt8(9);
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_GZIP) {
    throw new Error(`unsupported SSESENC1 compression ${compression}`);
  }
  const chunkSize = buf.readUInt32BE(12);
  const plainSize = Number(buf.readBigUInt64BE(16));
  return { version, compression, chunkSize, plainSize };
}

/**
 * Gzip a file to `outPath`. Returns compressed size.
 * Video already-compressed payloads often don't shrink; callers may skip.
 */
async function gzipFile(inPath, outPath) {
  await pipeline(
    fs.createReadStream(inPath),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(outPath),
  );
  return fs.statSync(outPath).size;
}

/**
 * Encrypt a file on disk without loading the whole thing into RAM.
 * Optionally gzip first (streamed to a temp sibling path).
 *
 * @returns {{ outBytes: number, payloadBytes: number, compression: number, ratio: number }}
 */
async function encryptFile(plainPath, outPath, key, opts = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("catalog key must be 32-byte Buffer");
  }
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const wantCompress = Boolean(opts.compress);

  let payloadPath = plainPath;
  let compression = COMPRESSION_NONE;
  let tmpGzip = null;

  if (wantCompress) {
    tmpGzip = `${outPath}.payload.gz`;
    const gzSize = await gzipFile(plainPath, tmpGzip);
    const plainSize = fs.statSync(plainPath).size;
    const ratio = gzSize / plainSize;
    // Skip gzip if it expands (typical for H.264/AAC).
    if (ratio >= 0.98) {
      fs.rmSync(tmpGzip, { force: true });
      tmpGzip = null;
      payloadPath = plainPath;
      compression = COMPRESSION_NONE;
    } else {
      payloadPath = tmpGzip;
      compression = COMPRESSION_GZIP;
    }
  }

  const payloadBytes = fs.statSync(payloadPath).size;
  const fdIn = fs.openSync(payloadPath, "r");
  const fdOut = fs.openSync(outPath, "w");
  try {
    fs.writeSync(fdOut, writeHeader(chunkSize, payloadBytes, compression));
    const plainBuf = Buffer.alloc(chunkSize);
    let remaining = payloadBytes;
    while (remaining > 0) {
      const thisLen = Math.min(chunkSize, remaining);
      const read = fs.readSync(fdIn, plainBuf, 0, thisLen, null);
      if (read !== thisLen) throw new Error("short read while encrypting");
      const slice = plainBuf.subarray(0, thisLen);
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(slice), cipher.final()]);
      const tag = cipher.getAuthTag();
      fs.writeSync(fdOut, iv);
      fs.writeSync(fdOut, ct);
      fs.writeSync(fdOut, tag);
      remaining -= thisLen;
    }
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
    if (tmpGzip) fs.rmSync(tmpGzip, { force: true });
  }

  const outBytes = fs.statSync(outPath).size;
  const originalBytes = fs.statSync(plainPath).size;
  return {
    outBytes,
    payloadBytes,
    compression,
    ratio: outBytes / originalBytes,
  };
}

/** In-memory encrypt (small files / tests). */
function encryptBuffer(plain, key, chunkSize = DEFAULT_CHUNK, compression = COMPRESSION_NONE) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("catalog key must be 32-byte Buffer");
  }
  let payload = plain;
  if (compression === COMPRESSION_GZIP) {
    payload = zlib.gzipSync(plain);
  }
  const chunks = [writeHeader(chunkSize, payload.length, compression)];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const slice = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(slice), cipher.final()]);
    const tag = cipher.getAuthTag();
    chunks.push(iv, ct, tag);
  }
  return Buffer.concat(chunks);
}

/** Sync helper kept for the acquisition pipeline. */
function encryptFileSync(plainPath, outPath, key, chunkSize = DEFAULT_CHUNK) {
  const plain = fs.readFileSync(plainPath);
  const encrypted = encryptBuffer(plain, key, chunkSize, COMPRESSION_NONE);
  fs.writeFileSync(outPath, encrypted);
  return encrypted.length;
}

function decryptBuffer(encrypted, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("catalog key must be 32-byte Buffer");
  }
  const { compression, chunkSize, plainSize } = readHeader(encrypted);
  const out = Buffer.alloc(plainSize);
  let readAt = FULL_HEADER;
  let writeAt = 0;
  while (writeAt < plainSize) {
    const thisLen = Math.min(chunkSize, plainSize - writeAt);
    const iv = encrypted.subarray(readAt, readAt + IV_LEN);
    readAt += IV_LEN;
    const ct = encrypted.subarray(readAt, readAt + thisLen);
    readAt += thisLen;
    const tag = encrypted.subarray(readAt, readAt + TAG_LEN);
    readAt += TAG_LEN;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    plain.copy(out, writeAt);
    writeAt += plain.length;
  }
  if (compression === COMPRESSION_GZIP) {
    return zlib.gunzipSync(out);
  }
  return out;
}

function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(MAGIC);
}

/**
 * Map ffprobe streams → MSE codec string (e.g. "avc1.64001F, mp4a.40.2").
 * Best-effort; callers should treat as a hint.
 */
function mseCodecsFromFfprobe(streams) {
  const parts = [];
  for (const s of streams || []) {
    if (s.codec_name === "h264" || s.codec_tag_string === "avc1") {
      // High=0x64, Main=0x4d, Baseline=0x42
      let profile = 0x64;
      const p = String(s.profile || "").toLowerCase();
      if (p.includes("baseline")) profile = 0x42;
      else if (p.includes("main")) profile = 0x4d;
      else if (p.includes("high")) profile = 0x64;
      const level = Number(s.level) || 31;
      const hex = (n) => n.toString(16).padStart(2, "0");
      parts.push(`avc1.${hex(profile)}00${hex(level)}`);
    } else if (s.codec_name === "hevc" || s.codec_name === "h265") {
      parts.push("hvc1.1.6.L93.B0");
    } else if (s.codec_name === "aac") {
      // LC is by far the most common in our library.
      parts.push("mp4a.40.2");
    } else if (s.codec_name === "mp3") {
      parts.push("mp4a.40.34");
    }
  }
  return parts.join(", ");
}

module.exports = {
  MAGIC,
  VERSION,
  COMPRESSION_NONE,
  COMPRESSION_GZIP,
  FULL_HEADER,
  IV_LEN,
  TAG_LEN,
  DEFAULT_CHUNK,
  parseCatalogKey,
  writeHeader,
  readHeader,
  gzipFile,
  encryptFile,
  encryptFileSync,
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  mseCodecsFromFfprobe,
};
