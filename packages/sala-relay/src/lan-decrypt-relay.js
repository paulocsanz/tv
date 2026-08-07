/**
 * LAN HTTP relay: rewrites playlist (strip #EXT-X-KEY) and serves decrypted segments.
 * CLI entry for P0.2 (RFC 0011).
 */
import { hlsAes128KeyFromCatalogKey } from "./hls-aes-decrypt.js";

export function rewritePlaylistClear(m3u8, relayBaseUrl) {
  const lines = m3u8.split("\n").filter((l) => !l.startsWith("#EXT-X-KEY"));
  return lines
    .map((line) => {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith("http")) {
        return new URL(t, relayBaseUrl.endsWith("/") ? relayBaseUrl : relayBaseUrl + "/").href;
      }
      return line;
    })
    .join("\n");
}

// CLI reserved for P0.2
if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("sala-relay: implement P0.2 after RFC approve");
  process.exit(1);
}

export { hlsAes128KeyFromCatalogKey };
