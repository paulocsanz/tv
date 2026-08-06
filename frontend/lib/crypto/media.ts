/**
 * Browser-side SSESENC1 (chunked AES-256-GCM) — must match lib/media-encryption.cjs.
 *
 * Supports:
 * - Full-buffer decrypt (tests / fallback)
 * - Streaming decrypt of a remote URL (chunk-by-chunk as bytes arrive)
 * - Optional gzip of the encrypted payload (compression flag in header)
 * - Live playback via Media Source Extensions (fMP4) when codecs are known
 */

const MAGIC = new TextEncoder().encode("SSESENC1");
const VERSION = 1;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;
const FULL_HEADER = 24;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Fresh ArrayBuffer copy — avoids TS BufferSource/SharedArrayBuffer friction. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

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
  const hi = readU32BE(buf, offset);
  const lo = readU32BE(buf, offset + 4);
  return hi * 2 ** 32 + lo;
}

export type Ssesenc1Header = {
  version: number;
  compression: number;
  chunkSize: number;
  plainSize: number;
};

export function isSsesenc1(buf: ArrayBuffer | Uint8Array): boolean {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== MAGIC[i]) return false;
  }
  return true;
}

export function parseSsesenc1Header(buf: ArrayBuffer | Uint8Array): Ssesenc1Header {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < FULL_HEADER) throw new Error("encrypted blob too short for header");
  if (!isSsesenc1(u8)) throw new Error("not SSESENC1");
  if (u8[8] !== VERSION) throw new Error(`unsupported SSESENC1 version ${u8[8]}`);
  const compression = u8[9] ?? 0;
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_GZIP) {
    throw new Error(`unsupported SSESENC1 compression ${compression}`);
  }
  return {
    version: VERSION,
    compression,
    chunkSize: readU32BE(u8, 12),
    plainSize: readU64BE(u8, 16),
  };
}

export async function decryptSsesenc1(
  encrypted: ArrayBuffer,
  catalogKey: CryptoKey,
): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(encrypted);
  const { compression, chunkSize, plainSize } = parseSsesenc1Header(u8);
  const out = new Uint8Array(plainSize);
  let readAt = FULL_HEADER;
  let writeAt = 0;

  while (writeAt < plainSize) {
    const thisLen = Math.min(chunkSize, plainSize - writeAt);
    const iv = toArrayBuffer(u8.subarray(readAt, readAt + IV_LEN));
    readAt += IV_LEN;
    const ctAndTag = toArrayBuffer(u8.subarray(readAt, readAt + thisLen + TAG_LEN));
    readAt += thisLen + TAG_LEN;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      catalogKey,
      ctAndTag,
    );
    out.set(new Uint8Array(plain), writeAt);
    writeAt += plain.byteLength;
  }

  if (compression === COMPRESSION_GZIP) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("gzip payload requires DecompressionStream");
    }
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    await writer.write(out);
    await writer.close();
    return new Response(ds.readable).arrayBuffer();
  }
  return out.buffer;
}

/**
 * Byte-buffer that grows as network chunks arrive; used to pull complete
 * encrypted frames (iv + ct + tag) without re-allocating on every byte.
 */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(chunk: Uint8Array) {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  get size() {
    return this.length;
  }

  /** Copy and consume `n` bytes (throws if not enough). */
  take(n: number): Uint8Array {
    if (n > this.length) throw new Error("ByteQueue underflow");
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0]!;
      const need = n - written;
      if (head.byteLength <= need) {
        out.set(head, written);
        written += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), written);
        this.chunks[0] = head.subarray(need);
        written += need;
      }
    }
    this.length -= n;
    return out;
  }

  peek(n: number): Uint8Array {
    if (n > this.length) throw new Error("ByteQueue underflow");
    const out = new Uint8Array(n);
    let written = 0;
    let i = 0;
    while (written < n) {
      const head = this.chunks[i]!;
      const need = n - written;
      if (head.byteLength <= need) {
        out.set(head, written);
        written += head.byteLength;
        i++;
      } else {
        out.set(head.subarray(0, need), written);
        written += need;
      }
    }
    return out;
  }
}

export type DecryptProgress = {
  /** Encrypted bytes fetched so far. */
  loaded: number;
  /** Encrypted Content-Length when known. */
  total: number | null;
  /** Plaintext (post-decrypt, pre-gunzip) bytes emitted. */
  plainEmitted: number;
  plainSize: number;
};

/**
 * Fetch an SSESENC1 URL and yield a ReadableStream of the decrypted
 * (and gunzipped, when flagged) media bytes. Decrypts each AES-GCM chunk
 * as soon as it is fully buffered — no full-file wait.
 */
export async function openDecryptedMediaStream(
  streamUrl: string,
  catalogKey: CryptoKey,
  onProgress?: (p: DecryptProgress) => void,
): Promise<{
  mediaStream: ReadableStream<Uint8Array>;
  header: Ssesenc1Header;
  encryptedTotal: number | null;
}> {
  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`failed to fetch encrypted media (${res.status})`);
  const encryptedTotal = Number(res.headers.get("content-length")) || null;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response body is not readable");

  const queue = new ByteQueue();
  let loaded = 0;
  let header: Ssesenc1Header | null = null;
  let plainEmitted = 0;
  let plainRemaining = 0;

  async function fill(minBytes: number) {
    while (queue.size < minBytes) {
      const { done, value } = await reader!.read();
      if (done) break;
      if (value) {
        queue.push(value);
        loaded += value.byteLength;
        if (header) {
          onProgress?.({
            loaded,
            total: encryptedTotal,
            plainEmitted,
            plainSize: header.plainSize,
          });
        }
      }
    }
  }

  await fill(FULL_HEADER);
  if (queue.size < FULL_HEADER) throw new Error("truncated encrypted stream");
  header = parseSsesenc1Header(queue.take(FULL_HEADER));
  plainRemaining = header.plainSize;
  onProgress?.({
    loaded,
    total: encryptedTotal,
    plainEmitted: 0,
    plainSize: header.plainSize,
  });

  const chunkSize = header.chunkSize;
  const key = catalogKey;

  // Stream of decrypted payload bytes (still gzip-compressed if flagged).
  const decryptedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (plainRemaining <= 0) {
        controller.close();
        return;
      }
      const thisLen = Math.min(chunkSize, plainRemaining);
      const frameLen = IV_LEN + thisLen + TAG_LEN;
      await fill(frameLen);
      if (queue.size < frameLen) {
        controller.error(new Error("truncated encrypted chunk"));
        return;
      }
      const frame = queue.take(frameLen);
      const iv = toArrayBuffer(frame.subarray(0, IV_LEN));
      const ctAndTag = toArrayBuffer(frame.subarray(IV_LEN));
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          ctAndTag,
        );
        const u8 = new Uint8Array(plain);
        plainEmitted += u8.byteLength;
        plainRemaining -= thisLen;
        onProgress?.({
          loaded,
          total: encryptedTotal,
          plainEmitted,
          plainSize: header!.plainSize,
        });
        controller.enqueue(u8);
        if (plainRemaining <= 0) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  });

  let mediaStream: ReadableStream<Uint8Array> = decryptedStream;
  if (header.compression === COMPRESSION_GZIP) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("gzip payload requires DecompressionStream");
    }
    // DecompressionStream is a generic Binary stream; cast through unknown.
    mediaStream = decryptedStream.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }

  return { mediaStream, header, encryptedTotal };
}

/**
 * Collect a decrypted media stream into a Blob URL (full download).
 * Used as fallback when MSE / fMP4 is unavailable.
 */
export async function streamToBlobUrl(
  mediaStream: ReadableStream<Uint8Array>,
  mime = "video/mp4",
): Promise<{ url: string; revoke: () => void }> {
  const res = new Response(mediaStream);
  const buf = await res.arrayBuffer();
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
  return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
}

/**
 * Live playback: decrypt (+ gunzip) from S3 as bytes arrive and append into
 * a MediaSource SourceBuffer. Requires fragmented MP4 (fMP4) and a codecs
 * string the browser accepts (e.g. "avc1.64001F, mp4a.40.2").
 *
 * Resolves as soon as the first media chunk is appended (playback can start
 * while the rest of the stream is still decrypting). Continues appending in
 * the background until endOfStream.
 *
 * Falls back to full-blob decrypt when MSE is not supported or append fails
 * before the first successful chunk.
 */
export async function attachStreamingPlayback(
  video: HTMLVideoElement,
  streamUrl: string,
  catalogKey: CryptoKey,
  opts: {
    codecs?: string | null;
    onProgress?: (p: DecryptProgress) => void;
    /** Prefer MSE when possible; default true. */
    preferMse?: boolean;
  } = {},
): Promise<{ url: string; revoke: () => void; mode: "mse" | "blob" }> {
  const preferMse = opts.preferMse !== false;
  const codecs = (opts.codecs || "").trim();
  const mime = codecs ? `video/mp4; codecs="${codecs}"` : "video/mp4";

  const canMse =
    preferMse &&
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(mime);

  if (!canMse) {
    const { mediaStream } = await openDecryptedMediaStream(
      streamUrl,
      catalogKey,
      opts.onProgress,
    );
    const blob = await streamToBlobUrl(mediaStream);
    video.src = blob.url;
    return { ...blob, mode: "blob" };
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  // Direct assignment — do not also put a <source> child pointing here.
  video.src = objectUrl;

  let cancelled = false;
  const revoke = () => {
    cancelled = true;
    try {
      if (video.src === objectUrl) {
        video.removeAttribute("src");
        video.load();
      }
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(objectUrl);
  };

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      mediaSource.removeEventListener("sourceopen", onOpen);
      resolve();
    };
    mediaSource.addEventListener("sourceopen", onOpen);
    mediaSource.addEventListener(
      "error",
      () => reject(new Error("MediaSource error")),
      { once: true },
    );
  });

  let sourceBuffer: SourceBuffer;
  try {
    sourceBuffer = mediaSource.addSourceBuffer(mime);
    // Segments arrive in decode order from a single fMP4 stream.
    sourceBuffer.mode = "sequence";
  } catch {
    revoke();
    const retry = await openDecryptedMediaStream(streamUrl, catalogKey, opts.onProgress);
    const blob = await streamToBlobUrl(retry.mediaStream);
    video.src = blob.url;
    return { ...blob, mode: "blob" };
  }

  let appendChain: Promise<void> = Promise.resolve();
  function append(chunk: Uint8Array): Promise<void> {
    appendChain = appendChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (cancelled || mediaSource.readyState !== "open") {
            resolve();
            return;
          }
          const onUpdate = () => {
            sourceBuffer.removeEventListener("updateend", onUpdate);
            sourceBuffer.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            sourceBuffer.removeEventListener("updateend", onUpdate);
            sourceBuffer.removeEventListener("error", onErr);
            reject(new Error("SourceBuffer error"));
          };
          sourceBuffer.addEventListener("updateend", onUpdate);
          sourceBuffer.addEventListener("error", onErr);
          try {
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            sourceBuffer.appendBuffer(copy);
          } catch (err) {
            sourceBuffer.removeEventListener("updateend", onUpdate);
            sourceBuffer.removeEventListener("error", onErr);
            reject(err);
          }
        }),
    );
    return appendChain;
  }

  // Open the decrypt stream only after MSE is ready so we don't buffer
  // decrypted media with nowhere to put it.
  const { mediaStream } = await openDecryptedMediaStream(
    streamUrl,
    catalogKey,
    opts.onProgress,
  );
  const reader = mediaStream.getReader();

  // Pump in the background; resolve this function once the first append
  // succeeds so the UI can drop the "Decrypting…" overlay and start play.
  let firstAppendDone = false;
  let resolveFirst!: () => void;
  let rejectFirst!: (e: unknown) => void;
  const firstAppend = new Promise<void>((res, rej) => {
    resolveFirst = res;
    rejectFirst = rej;
  });

  (async () => {
    try {
      for (;;) {
        if (cancelled) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await append(value);
          if (!firstAppendDone) {
            firstAppendDone = true;
            resolveFirst();
          }
        }
      }
      await appendChain;
      if (!cancelled && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          /* already ended */
        }
      }
      if (!firstAppendDone) {
        rejectFirst(new Error("encrypted stream produced no media bytes"));
      }
    } catch (e) {
      if (!firstAppendDone) rejectFirst(e);
      // Mid-stream MSE failure after playback started: leave what we have;
      // the video element will surface an error if it can't continue.
      console.warn("MSE append stream ended with error", e);
    }
  })();

  try {
    await firstAppend;
    return { url: objectUrl, revoke, mode: "mse" };
  } catch {
    revoke();
    reader.cancel().catch(() => undefined);
    const retry = await openDecryptedMediaStream(streamUrl, catalogKey, opts.onProgress);
    const blob = await streamToBlobUrl(retry.mediaStream);
    video.src = blob.url;
    return { ...blob, mode: "blob" };
  }
}

/**
 * Fetch a (possibly encrypted) media URL and return a playable object URL.
 * Streaming MSE path when `encrypted` + codecs; otherwise full decrypt blob
 * or passthrough for plaintext.
 */
export async function resolvePlayableUrl(
  streamUrl: string,
  encrypted: boolean,
  catalogKey: CryptoKey | null,
  onProgress?: (loaded: number, total: number | null) => void,
  opts?: { codecs?: string | null; video?: HTMLVideoElement | null },
): Promise<{ url: string; revoke: () => void; mode?: "mse" | "blob" | "direct" }> {
  if (!encrypted) {
    return { url: streamUrl, revoke: () => undefined, mode: "direct" };
  }
  if (!catalogKey) {
    throw new Error("this title is encrypted but no catalog key is unlocked");
  }

  const progress = (p: DecryptProgress) => {
    onProgress?.(p.loaded, p.total);
  };

  // Live MSE when the caller hands us a <video> + codecs (fMP4 path).
  if (opts?.video && opts.codecs) {
    return attachStreamingPlayback(opts.video, streamUrl, catalogKey, {
      codecs: opts.codecs,
      onProgress: progress,
    });
  }

  // Streaming decrypt → blob (starts only after full media is ready, but
  // decrypt happens as bytes arrive so peak memory is one copy, not two
  // full encrypted+plain buffers held after the fact).
  const { mediaStream } = await openDecryptedMediaStream(streamUrl, catalogKey, progress);
  const blob = await streamToBlobUrl(mediaStream);
  return { ...blob, mode: "blob" };
}
