/**
 * Browser-side SSESENC1 (chunked AES-256-GCM) — must match lib/media-encryption.js.
 */

const MAGIC = new TextEncoder().encode("SSESENC1");
const VERSION = 1;
const FULL_HEADER = 24;
const IV_LEN = 12;
const TAG_LEN = 16;

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

function readU64BE(buf: Uint8Array, offset: number): number {
  // Plaintext media sizes fit comfortably in JS safe integers.
  const hi = readU32BE(buf, offset);
  const lo = readU32BE(buf, offset + 4);
  return hi * 2 ** 32 + lo;
}

export function isSsesenc1(buf: ArrayBuffer | Uint8Array): boolean {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== MAGIC[i]) return false;
  }
  return true;
}

export async function decryptSsesenc1(
  encrypted: ArrayBuffer,
  catalogKey: CryptoKey,
): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(encrypted);
  if (!isSsesenc1(u8)) throw new Error("not SSESENC1");
  if (u8[8] !== VERSION) throw new Error(`unsupported SSESENC1 version ${u8[8]}`);
  const chunkSize = readU32BE(u8, 12);
  const plainSize = readU64BE(u8, 16);
  const out = new Uint8Array(plainSize);
  let readAt = FULL_HEADER;
  let writeAt = 0;

  while (writeAt < plainSize) {
    const thisLen = Math.min(chunkSize, plainSize - writeAt);
    const iv = u8.subarray(readAt, readAt + IV_LEN);
    readAt += IV_LEN;
    const ctAndTag = u8.subarray(readAt, readAt + thisLen + TAG_LEN);
    readAt += thisLen + TAG_LEN;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      catalogKey,
      ctAndTag,
    );
    out.set(new Uint8Array(plain), writeAt);
    writeAt += plain.byteLength;
  }
  return out.buffer;
}

/** Fetch a (possibly encrypted) media URL and return a playable object URL. */
export async function resolvePlayableUrl(
  streamUrl: string,
  encrypted: boolean,
  catalogKey: CryptoKey | null,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<{ url: string; revoke: () => void }> {
  if (!encrypted) {
    return { url: streamUrl, revoke: () => undefined };
  }
  if (!catalogKey) {
    throw new Error("this title is encrypted but no catalog key is unlocked");
  }

  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`failed to fetch encrypted media (${res.status})`);
  const total = Number(res.headers.get("content-length")) || null;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    const plain = await decryptSsesenc1(buf, catalogKey);
    const blobUrl = URL.createObjectURL(new Blob([plain], { type: "video/mp4" }));
    return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
  }
  const encryptedBuf = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    encryptedBuf.set(c, offset);
    offset += c.byteLength;
  }
  const plain = await decryptSsesenc1(encryptedBuf.buffer, catalogKey);
  const blobUrl = URL.createObjectURL(new Blob([plain], { type: "video/mp4" }));
  return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
}
