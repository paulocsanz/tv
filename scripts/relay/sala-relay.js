#!/usr/bin/env node
/**
 * Sessão "sala" decrypt relay (RFC 0011 P0.2).
 *
 * Runs on a PC that holds ENCRYPTION_CATALOG_KEY. Fetches encrypted HLS
 * from S3, decrypts AES-128-CBC segments, serves clear HLS on the LAN.
 * Optionally registers with the Sessão backend so a paired TV can discover
 * http://<lan-ip>:<port>/play/{id}/index.m3u8
 *
 * Usage:
 *   set -a && source .env.caixote && set +a
 *   export SESSAO_API_URL=https://backend-production-fbcca.up.railway.app
 *   export SESSAO_TOKEN='…'   # session token from login (optional for registry)
 *   node scripts/relay/sala-relay.js --port 8787
 *   # then open http://<this-machine-lan-ip>:8787/play/the-matrix-1999-movie/index.m3u8
 *
 * Env: S3_* ENCRYPTION_CATALOG_KEY  [SESSAO_API_URL SESSAO_TOKEN]
 */

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { createRequire } from "module";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const require = createRequire(import.meta.url);
const { parseCatalogKey } = require("../../lib/media-encryption.cjs");

const CATALOG_PATH =
  process.env.ENRICHED_DATA_PATH ||
  path.join("backend", "data", "enriched_400.json");

function parseArgs(argv) {
  const out = { port: 8787, host: "0.0.0.0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = parseInt(argv[++i], 10);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function lanIPv4() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const addr of list || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function loadBucket() {
  const c = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (!c.accessKeyId || !c.secretAccessKey || !c.bucketName || !c.endpoint) {
    throw new Error("Missing S3_* — source .env.caixote");
  }
  return c;
}

function makeS3(creds) {
  return new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: creds.urlStyle === "path",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 15_000,
      requestTimeout: 120_000,
    }),
  });
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function resolvePlaylistKey(item, episode) {
  const ref = item.hls_playlist_s3_key;
  if (!ref) return null;
  if (ref.endsWith(".m3u8")) return ref;
  const ep = episode && episode > 0 ? episode : 1;
  return `${ref.replace(/\/$/, "")}/e${ep}/index.m3u8`;
}

async function getObjectBytes(client, bucket, key) {
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseKeyIv(playlistText) {
  // #EXT-X-KEY:METHOD=AES-128,URI="...",IV=0x...
  const m = playlistText.match(/#EXT-X-KEY:([^\n]+)/);
  if (!m) return { method: "NONE", iv: null };
  const line = m[1];
  const method = /METHOD=([^,]+)/.exec(line)?.[1] || "NONE";
  let iv = null;
  const ivm = /IV=0x([0-9a-fA-F]+)/.exec(line);
  if (ivm) iv = Buffer.from(ivm[1].padStart(32, "0").slice(0, 32), "hex");
  return { method, iv };
}

function decryptSegment(cipherBuf, key16, iv) {
  if (!iv || iv.length !== 16) {
    throw new Error("HLS segment decrypt needs 16-byte IV");
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", key16, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
}

function rewritePlaylist(text, publicBase, id, episode) {
  const epPart = episode ? `e/${episode}/` : "";
  const base = `${publicBase}/play/${id}/${epPart}`;
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        // Strip key line — plaintext segments need no EXT-X-KEY
        if (t.startsWith("#EXT-X-KEY:")) return null;
        return line;
      }
      if (/^https?:\/\//i.test(t)) {
        // Should not happen for our S3-relative playlists
        const name = path.posix.basename(new URL(t).pathname);
        return `${base}seg/${name}`;
      }
      const name = path.posix.basename(t.replace(/\\/g, "/"));
      return `${base}seg/${name}`;
    })
    .filter((l) => l !== null)
    .join("\n");
}

async function registerRelay(baseUrl) {
  const api = process.env.SESSAO_API_URL;
  const token = process.env.SESSAO_TOKEN;
  if (!api || !token) {
    console.log("  (no SESSAO_API_URL/SESSAO_TOKEN — skip backend registry)");
    return;
  }
  const url = `${api.replace(/\/$/, "")}/api/sala/relay`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ base_url: baseUrl }),
    });
    if (!res.ok) {
      console.warn(`  registry POST failed ${res.status}: ${await res.text()}`);
    } else {
      console.log(`  registered with backend as ${baseUrl}`);
    }
  } catch (e) {
    console.warn(`  registry error: ${e.message}`);
  }
}

async function heartbeatRelay() {
  const api = process.env.SESSAO_API_URL;
  const token = process.env.SESSAO_TOKEN;
  if (!api || !token) return;
  try {
    await fetch(`${api.replace(/\/$/, "")}/api/sala/relay/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* ignore */
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node scripts/relay/sala-relay.js [--port 8787] [--host 0.0.0.0]`);
    process.exit(0);
  }

  const catalogKey32 = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
  if (!catalogKey32) throw new Error("ENCRYPTION_CATALOG_KEY required");
  const key16 = catalogKey32.subarray(0, 16);

  const creds = loadBucket();
  const s3 = makeS3(creds);
  const catalog = loadCatalog();
  const lan = lanIPv4();
  const publicBase = `http://${lan}:${opts.port}`;

  // Cache: playlistKey -> { text, method, iv, prefix }
  const playlistCache = new Map();

  async function loadPlaylistMeta(itemId, episode) {
    const cacheKey = `${itemId}:${episode || 0}`;
    if (playlistCache.has(cacheKey)) return playlistCache.get(cacheKey);
    const item = catalog.items.find((x) => x && x.id === itemId);
    if (!item) throw Object.assign(new Error("title not found"), { status: 404 });
    const playlistKey = resolvePlaylistKey(item, episode);
    if (!playlistKey) {
      throw Object.assign(new Error("title has no HLS playlist"), { status: 404 });
    }
    const buf = await getObjectBytes(s3, creds.bucketName, playlistKey);
    const text = buf.toString("utf8");
    const { method, iv } = parseKeyIv(text);
    const prefix = playlistKey.includes("/")
      ? playlistKey.slice(0, playlistKey.lastIndexOf("/") + 1)
      : "";
    const meta = { text, method, iv, prefix, playlistKey };
    playlistCache.set(cacheKey, meta);
    return meta;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/health" || url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "sessao-sala-relay",
            publicBase,
            playExample: `${publicBase}/play/the-matrix-1999-movie/index.m3u8`,
          }),
        );
        return;
      }

      // /play/:id/index.m3u8  or  /play/:id/e/:ep/index.m3u8
      // /play/:id/seg/:name   or  /play/:id/e/:ep/seg/:name
      const mPlay = url.pathname.match(
        /^\/play\/([^/]+)\/(?:e\/(\d+)\/)?(index\.m3u8|seg\/([^/]+))$/,
      );
      if (!mPlay) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const id = decodeURIComponent(mPlay[1]);
      const episode = mPlay[2] ? parseInt(mPlay[2], 10) : null;
      const kind = mPlay[3];
      const segName = mPlay[4];

      const meta = await loadPlaylistMeta(id, episode);

      if (kind === "index.m3u8") {
        const body = rewritePlaylist(meta.text, publicBase, id, episode);
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      // segment
      const segKey = `${meta.prefix}${segName}`;
      const cipher = await getObjectBytes(s3, creds.bucketName, segKey);
      let plain = cipher;
      if (meta.method === "AES-128") {
        if (!meta.iv) throw new Error("missing IV for AES-128 playlist");
        plain = decryptSegment(cipher, key16, meta.iv);
      }
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Cache-Control": "public, max-age=60",
        "Content-Length": plain.length,
      });
      res.end(plain);
    } catch (e) {
      const status = e.status || 500;
      console.error("relay error", e.message || e);
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(e.message || "error");
    }
  });

  server.listen(opts.port, opts.host, async () => {
    console.log(`sala-relay listening on ${opts.host}:${opts.port}`);
    console.log(`  LAN base: ${publicBase}`);
    console.log(`  health:   ${publicBase}/health`);
    console.log(
      `  example:  ${publicBase}/play/the-matrix-1999-movie/index.m3u8`,
    );
    await registerRelay(publicBase);
    setInterval(heartbeatRelay, 10_000);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
