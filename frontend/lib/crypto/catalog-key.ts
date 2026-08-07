/**
 * Per-user wrap of the shared catalog media key (RFC 0006).
 *
 * Wrap KDF is PBKDF2-SHA-256 (WebCrypto native) so Smart TV browsers don't
 * need a WASM Argon2 dependency. Domain-separated from the server-side
 * login hash (which is Argon2id in auth.rs).
 */

const IDB_NAME = "sessao-crypto";
const IDB_STORE = "keys";
const IDB_KEY = "catalog";
const PBKDF2_ITERATIONS = 600_000;
const SALT_LEN = 16;
const IV_LEN = 12;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Fresh ArrayBuffer copy — avoids TS BufferSource/SharedArrayBuffer friction. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveWrapKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateCatalogKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportCatalogKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/**
 * Import raw catalog key bytes.
 * @param extractable - must be true when the caller will wrap/export the key
 *   (bootstrap, invite accept). Use false for decrypt-only (player).
 */
export async function importCatalogKeyRaw(
  raw: ArrayBuffer | Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/** Wrap catalog key under password-derived key. Returns hex fields for the API. */
export async function wrapCatalogKey(
  catalogKey: CryptoKey,
  password: string,
): Promise<{ wrapped_hex: string; salt_hex: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const wrapKey = await deriveWrapKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const raw = await exportCatalogKeyRaw(catalogKey);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, toArrayBuffer(raw)),
  );
  // Wire format: iv || ciphertext+tag
  const combined = new Uint8Array(IV_LEN + ct.length);
  combined.set(iv, 0);
  combined.set(ct, IV_LEN);
  return { wrapped_hex: toHex(combined), salt_hex: toHex(salt) };
}

/** Decrypt wrap → raw 32-byte catalog key (before CryptoKey import). */
export async function unwrapCatalogKeyRaw(
  wrappedHex: string,
  saltHex: string,
  password: string,
): Promise<Uint8Array> {
  const salt = fromHex(saltHex);
  const combined = fromHex(wrappedHex);
  if (combined.length < IV_LEN + 16) throw new Error("wrap too short");
  const iv = toArrayBuffer(combined.subarray(0, IV_LEN));
  const ct = combined.subarray(IV_LEN);
  const wrapKey = await deriveWrapKey(password, salt);
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      wrapKey,
      toArrayBuffer(ct),
    ),
  );
  if (raw.length !== 32) throw new Error(`unwrapped key must be 32 bytes (got ${raw.length})`);
  return raw;
}

/**
 * Decrypt wrap → CryptoKey.
 * @param extractable - true when caller will store/export/wrap (login, invite)
 */
export async function unwrapCatalogKey(
  wrappedHex: string,
  saltHex: string,
  password: string,
  extractable = true,
): Promise<CryptoKey> {
  const raw = await unwrapCatalogKeyRaw(wrappedHex, saltHex, password);
  return importCatalogKeyRaw(raw, extractable);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb open failed"));
  });
}

/**
 * Persist catalog key material in IndexedDB as raw bytes (ArrayBuffer).
 *
 * Storing a CryptoKey object is flaky across browsers (Safari throws
 * "A parameter or an operation is not supported by the underlying object"
 * on export of non-extractable keys, and structured-clone of CryptoKey
 * fails in some TV WebViews). Raw 32 bytes are portable; we re-import
 * on load with the extractable flag the caller needs.
 */
export async function storeCatalogKeyLocal(key: CryptoKey | Uint8Array): Promise<void> {
  const raw =
    key instanceof Uint8Array ? key : await exportCatalogKeyRaw(key);
  if (raw.length !== 32) throw new Error(`catalog key must be 32 bytes (got ${raw.length})`);
  const payload = toArrayBuffer(raw);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(payload, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb put failed"));
  });
  db.close();
}

/**
 * Load catalog key from IndexedDB.
 * @param extractable - true for wrap/export (invite); false for player decrypt
 */
export async function loadCatalogKeyLocal(extractable = false): Promise<CryptoKey | null> {
  const db = await openDb();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb get failed"));
  });
  db.close();
  if (stored == null) return null;

  // Legacy: CryptoKey was stored directly (pre-raw-bytes storage).
  if (typeof CryptoKey !== "undefined" && stored instanceof CryptoKey) {
    if (extractable && !stored.extractable) {
      // Can't re-export; caller should re-unlock via password.
      return null;
    }
    return stored;
  }

  let bytes: Uint8Array | null = null;
  if (stored instanceof ArrayBuffer) bytes = new Uint8Array(stored);
  else if (stored instanceof Uint8Array) bytes = stored;
  if (!bytes || bytes.length !== 32) return null;
  return importCatalogKeyRaw(bytes, extractable);
}

export async function clearCatalogKeyLocal(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb delete failed"));
  });
  db.close();
}

/**
 * After password login: fetch wrap from API, unwrap with password, cache in IDB.
 * Returns null if user has no wrap yet (plaintext-only library is fine).
 */
export async function unlockCatalogKeyFromLogin(password: string): Promise<CryptoKey | null> {
  const res = await fetch("/api/crypto/catalog-key");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`catalog-key fetch failed (${res.status})`);
  const { wrapped_hex, salt_hex } = (await res.json()) as {
    wrapped_hex: string;
    salt_hex: string;
  };
  // Store raw bytes (not CryptoKey) — avoids Safari export/IDB failures.
  const raw = await unwrapCatalogKeyRaw(wrapped_hex, salt_hex, password);
  await storeCatalogKeyLocal(raw);
  return importCatalogKeyRaw(raw, true);
}

/** First-admin bootstrap: mint catalog key, wrap under password, PUT to server. */
export async function bootstrapCatalogKey(password: string): Promise<{
  key: CryptoKey;
  /** Base64 raw key — put this on the pipeline as ENCRYPTION_CATALOG_KEY. */
  pipelineKeyB64: string;
}> {
  const key = await generateCatalogKey();
  const raw = await exportCatalogKeyRaw(key);
  const wrap = await wrapCatalogKey(key, password);
  const res = await fetch("/api/crypto/catalog-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...wrap, bootstrap: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `bootstrap failed (${res.status})`,
    );
  }
  await storeCatalogKeyLocal(key);
  // base64 for pipeline env
  let binary = "";
  for (let i = 0; i < raw.length; i++) binary += String.fromCharCode(raw[i]!);
  const pipelineKeyB64 = btoa(binary);
  return { key, pipelineKeyB64 };
}

/** Export catalog key as base64 for invite links (#mk=). Client-side only. */
export async function exportCatalogKeyBase64(key: CryptoKey): Promise<string> {
  // Prefer raw path if key isn't extractable (shouldn't happen after raw IDB storage).
  let raw: Uint8Array;
  try {
    raw = await exportCatalogKeyRaw(key);
  } catch {
    const reloaded = await loadCatalogKeyLocal(true);
    if (!reloaded) throw new Error("catalog key not exportable — unlock again from Account");
    raw = await exportCatalogKeyRaw(reloaded);
  }
  let binary = "";
  for (let i = 0; i < raw.length; i++) binary += String.fromCharCode(raw[i]!);
  return btoa(binary);
}

/**
 * Admin bootstrap with an EXISTING key (content already encrypted on S3
 * under it). Imports the raw key, wraps under password, PUTs bootstrap=true.
 * Use when migrating from a hardcoded env key to per-account wraps.
 */
export async function bootstrapWithExistingKey(
  rawKeyB64: string,
  password: string,
): Promise<CryptoKey> {
  const binary = atob(rawKeyB64.trim());
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  if (raw.length !== 32) throw new Error(`catalog key must be 32 bytes (got ${raw.length})`);
  // extractable: wrapCatalogKey needs exportKey
  const key = await importCatalogKeyRaw(raw, true);
  const wrap = await wrapCatalogKey(key, password);
  const res = await fetch("/api/crypto/catalog-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...wrap, bootstrap: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `bootstrap failed (${res.status})`,
    );
  }
  await storeCatalogKeyLocal(key);
  return key;
}

/**
 * Invite handoff (RFC 0006 P1.1): new member receives the catalog key via
 * invite URL fragment (#mk=base64). After signup (which also logs them in),
 * wrap the key under their password and PUT to the server — so future logins
 * unlock via the normal password unwrap path. Key never touches the server
 * in plaintext; the URL fragment stays client-side.
 */
export async function acceptInviteKey(
  rawKeyB64: string,
  password: string,
): Promise<CryptoKey> {
  const binary = atob(rawKeyB64.trim());
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  if (raw.length !== 32) throw new Error(`invite key must be 32 bytes (got ${raw.length})`);
  // extractable: wrapCatalogKey needs exportKey
  const key = await importCatalogKeyRaw(raw, true);
  const wrap = await wrapCatalogKey(key, password);
  // Non-bootstrap PUT: any authenticated user can upsert their own wrap.
  const res = await fetch("/api/crypto/catalog-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...wrap, bootstrap: false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `invite key store failed (${res.status})`,
    );
  }
  await storeCatalogKeyLocal(key);
  return key;
}
