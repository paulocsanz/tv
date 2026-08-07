/**
 * HLS AES-128-CBC segment decrypt (RFC 0011 / RFC 0009).
 * Key = first 16 bytes of the 32-byte catalog media key.
 * Implemented in P0.2 — this file is the package surface for path-proof.
 */
export function hlsAes128KeyFromCatalogKey(catalogKey32) {
  if (!catalogKey32 || catalogKey32.length < 16) {
    throw new Error("catalog key must be at least 16 bytes");
  }
  return catalogKey32.subarray(0, 16);
}

export function decryptSegmentAes128Cbc(_key16, _iv16, ciphertext) {
  // P0.2: crypto.createDecipheriv('aes-128-cbc', key, iv)
  throw new Error("not implemented — land in P0.2 after RFC approve");
}
