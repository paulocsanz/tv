import { test } from "node:test";
import assert from "node:assert/strict";
import { hlsAes128KeyFromCatalogKey } from "./hls-aes-decrypt.js";
import { rewritePlaylistClear } from "./lan-decrypt-relay.js";

test("hlsAes128KeyFromCatalogKey takes first 16 bytes", () => {
  const key32 = Buffer.alloc(32, 0xab);
  const k = hlsAes128KeyFromCatalogKey(key32);
  assert.equal(k.length, 16);
  assert.equal(k[0], 0xab);
});

test("rewritePlaylistClear strips EXT-X-KEY and rewrites segment URLs", () => {
  const src = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"sessao-key:catalog\"",
    "#EXTINF:4.0,",
    "seg0001.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const out = rewritePlaylistClear(src, "http://192.168.1.10:8787/");
  assert.ok(!out.includes("#EXT-X-KEY"));
  assert.ok(out.includes("http://192.168.1.10:8787/seg0001.ts"));
});
