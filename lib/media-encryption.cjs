/**
 * Shared AES-256-GCM chunked media encryption (SSESENC1).
 *
 * Used by the acquisition pipeline (Node) and mirrored in the browser
 * (frontend/lib/crypto/media.ts). Keep the on-disk layout in lockstep.
 *
 * Layout:
 *   magic[8] = "SSESENC1"
 *   version u8 = 1
 *   reserved[3] = 0
 *   chunk_size u32 BE  (plaintext bytes per chunk)
 *   plaintext_size u64 BE
 *   then for each chunk:
 *     iv[12]
 *     ciphertext[chunk_len]
 *     tag[16]
 */

const crypto = require("crypto");

const MAGIC = Buffer.from("SSESENC1", "ascii");
const VERSION = 1;
const HEADER_SIZE = 16; // 8 + 1 + 3 + 4
const PLAIN_SIZE_FIELD = 8;
const FULL_HEADER = HEADER_SIZE + PLAIN_SIZE_FIELD; // 24
const IV_LEN = 12;
const TAG_LEN = 16;
const DEFAULT_CHUNK = 1024 * 1024; // 1 MiB plaintext

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

function encryptFileSync(plainPath, outPath, key, chunkSize = DEFAULT_CHUNK) {
  const fs = require("fs");
  const plain = fs.readFileSync(plainPath);
  const encrypted = encryptBuffer(plain, key, chunkSize);
  fs.writeFileSync(outPath, encrypted);
  return encrypted.length;
}

function encryptBuffer(plain, key, chunkSize = DEFAULT_CHUNK) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("catalog key must be 32-byte Buffer");
  }
  const chunks = [];
  const header = Buffer.alloc(FULL_HEADER);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 8);
  header.writeUInt32BE(chunkSize, 12);
  header.writeBigUInt64BE(BigInt(plain.length), 16);
  chunks.push(header);

  for (let offset = 0; offset < plain.length; offset += chunkSize) {
    const slice = plain.subarray(offset, Math.min(offset + chunkSize, plain.length));
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(slice), cipher.final()]);
    const tag = cipher.getAuthTag();
    chunks.push(iv, ct, tag);
  }
  return Buffer.concat(chunks);
}

function decryptBuffer(encrypted, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("catalog key must be 32-byte Buffer");
  }
  if (encrypted.length < FULL_HEADER) throw new Error("encrypted blob too short");
  if (!encrypted.subarray(0, 8).equals(MAGIC)) throw new Error("not SSESENC1");
  const version = encrypted.readUInt8(8);
  if (version !== VERSION) throw new Error(`unsupported SSESENC1 version ${version}`);
  const chunkSize = encrypted.readUInt32BE(12);
  const plainSize = Number(encrypted.readBigUInt64BE(16));
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
  return out;
}

function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(MAGIC);
}

module.exports = {
  MAGIC,
  VERSION,
  FULL_HEADER,
  IV_LEN,
  TAG_LEN,
  DEFAULT_CHUNK,
  parseCatalogKey,
  encryptFileSync,
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
};
