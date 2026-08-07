#!/usr/bin/env node
/**
 * Poll caixote serial logs for torrent-pipeline and print a progress table.
 * Usage: node scripts/ops/monitor-pipeline-caixote.mjs [--once] [--interval=15]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalSec = Number((args.find((a) => a.startsWith("--interval=")) || "").split("=")[1]) || 15;

const API = process.env.CAIXOTE_URL || "https://portaria.up.railway.app";
const ORG = process.env.CAIXOTE_ORG || "admin-9d6b3dff";
const PROJECT = process.env.CAIXOTE_PROJECT || "vete-pipeline";
const SERVICE = process.env.CAIXOTE_SERVICE || "torrent-pipeline";

function loadSession() {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/caixote/config.json"), "utf8")
  );
  return cfg.session_id;
}

async function api(pathname) {
  const session = loadSession();
  const res = await fetch(`${API}${pathname}`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
  return res.json();
}

async function resolveScfg() {
  const body = await api(`/api/orgs/${ORG}/service-configs`);
  const list = body.data || body;
  const matches = (Array.isArray(list) ? list : []).filter(
    (s) => s.service_name === SERVICE || s.name === SERVICE
  );
  // Prefer the vete-pipeline project when multiple exist
  const hit =
    matches.find((s) => s.project_id) ||
    matches[0];
  // Filter by listing with project if possible - caixote CLI uses project filter
  // but API may return all. Prefer running ones with our image.
  const preferred = matches
    .filter((s) => (s.image || "").includes("tv-torrent-pipeline"))
    .sort((a, b) => (b.status === "running") - (a.status === "running"));
  return preferred[0] || hit;
}

function parseLogs(entries) {
  const state = {
    startedAt: null,
    alreadyOnS3: null,
    ready: null,
    fast: null,
    risky: null,
    active: new Map(), // title -> { percent, speed, size, seeders, updatedAt, status }
    done: [],
    failed: [],
    skipped: [],
    uploaded: [],
    lastTs: null,
  };

  for (const e of entries) {
    const m = (e.message || "").replace(/\r/g, "");
    const ts = e.timestamp || null;
    if (ts) state.lastTs = ts;

    let match;
    if ((match = m.match(/Already on S3:\s*(\d+)/))) state.alreadyOnS3 = Number(match[1]);
    if ((match = m.match(/Ready to download:\s*(\d+)\s*\((\d+)\s*fast-lane,\s*(\d+)\s*risky/))) {
      state.ready = Number(match[1]);
      state.fast = Number(match[2]);
      state.risky = Number(match[3]);
    }
    if ((match = m.match(/Started at:\s*(.+)/))) state.startedAt = match[1].trim();

    if ((match = m.match(/\[download\s+(\d+)\/(\d+)\]\s+\(([\d.]+)%\)\s+(.+)/))) {
      const title = match[4].trim();
      state.active.set(title, {
        percent: 0,
        speed: null,
        size: null,
        seeders: null,
        queue: `${match[1]}/${match[2]}`,
        updatedAt: ts,
        status: "queued",
      });
    }

    if ((match = m.match(/\[([^\]]+)\]\s+(\d+)%(?:\s+on disk\s+([\d.]+)MB)?(?:\s+\(([^)]+)\/s\))?/))) {
      const title = match[1];
      const cur = state.active.get(title) || { queue: "?", size: null, seeders: null };
      cur.percent = Number(match[2]);
      if (match[3]) cur.diskMB = Number(match[3]);
      cur.speed = match[4] || cur.speed;
      cur.updatedAt = ts;
      cur.status = cur.percent >= 100 ? "downloaded" : "downloading";
      state.active.set(title, cur);
    }
    // Disk-only heartbeat: "[Title] 12.3MB on disk 12.3MB (1.2MiB/s)"
    if ((match = m.match(/\[([^\]]+)\]\s+([\d.]+)MB on disk(?:\s+([\d.]+)MB)?\s+\(([^)]+)\/s\)/))) {
      const title = match[1];
      const cur = state.active.get(title) || { queue: "?", size: null, seeders: null, percent: 0 };
      cur.diskMB = Number(match[2]);
      cur.speed = match[4] || match[3] || cur.speed;
      cur.updatedAt = ts;
      cur.status = "downloading";
      state.active.set(title, cur);
    }
    if ((match = m.match(/\[([^\]]+)\]\s+(.+)\s+\(idle/))) {
      const title = match[1];
      const cur = state.active.get(title);
      if (cur) {
        cur.speed = "0B";
        cur.updatedAt = ts;
        cur.status = "stalled";
      }
    }

    if ((match = m.match(/Seeders:\s*(\d+)\s*\|\s*Size:\s*(.+)/))) {
      // FIFO: seeders lines follow claimed items in the same order
      // (download N, then option header, then Seeders: for that claim).
      for (const [title, cur] of state.active.entries()) {
        if (cur.seeders == null && cur.status !== "skipped") {
          cur.seeders = Number(match[1]);
          cur.size = match[2].trim();
          cur.updatedAt = ts;
          break;
        }
      }
    }

    if ((match = m.match(/\[([^\]]+)\]\s+Downloading\.\.\./))) {
      const title = match[1];
      const cur = state.active.get(title) || { percent: 0, queue: "?", size: null, seeders: null };
      cur.status = "downloading";
      cur.updatedAt = ts;
      state.active.set(title, cur);
    }

    if ((match = m.match(/✗\s*\[([^\]]+)\]\s*(.+)/))) {
      const title = match[1];
      const reason = match[2].trim();
      state.active.delete(title);
      if (/0 seeders/i.test(reason)) state.skipped.push({ title, reason, ts });
      else state.failed.push({ title, reason, ts });
    }

    if ((match = m.match(/✅?\s*\[?([^\]]+)\]?\s*(?:fully )?uploaded|item_done|Items fully uploaded:\s*(\d+)/i))) {
      // keep simple
    }
    if ((match = m.match(/\[([^\]]+)\]\s+(\d+)%\s+\(([\d.]+)KiB\/s\)/))) {
      // upload progress
      const title = match[1];
      const cur = state.active.get(title) || { queue: "?", size: null, seeders: null };
      cur.percent = Number(match[2]);
      cur.speed = `${match[3]}KiB`;
      cur.status = "uploading";
      cur.updatedAt = ts;
      state.active.set(title, cur);
    }

    if (/transcod/i.test(m) && (match = m.match(/\[([^\]]+)\]/))) {
      const title = match[1];
      const cur = state.active.get(title);
      if (cur) {
        cur.status = "transcoding";
        cur.updatedAt = ts;
      }
    }

    if ((match = m.match(/✅\s*(.+)|Complete!|Items fully uploaded:\s*(\d+)/))) {
      // no-op aggregate
    }
    if ((match = m.match(/\[([^\]]+)\].*uploaded|Upload complete|✓.*\[([^\]]+)\]/i))) {
      const title = match[1] || match[2];
      if (title && !/download|720p|1080p|bootstrap|supervisor/i.test(title)) {
        state.uploaded.push({ title, ts });
        state.active.delete(title);
      }
    }
  }

  return state;
}

function pad(s, n) {
  s = String(s ?? "");
  if (s.length > n) return s.slice(0, n - 1) + "…";
  return s.padEnd(n);
}
function rpad(s, n) {
  s = String(s ?? "");
  if (s.length > n) return s.slice(0, n);
  return s.padStart(n);
}

function bar(pct, width = 12) {
  if (pct == null || Number.isNaN(pct)) return " ".repeat(width);
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function age(ts) {
  if (!ts) return "?";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function render(svc, state) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push(`torrent-pipeline @ caixote  ${now}`);
  lines.push(
    `status=${svc?.status || "?"} runtime=${svc?.runtime_state || "?"} mem=${svc?.memory_mb || "?"}MB disk=${svc?.disk_mb || "?"}MB ip=${svc?.ip_v4 || "?"}`
  );
  lines.push(
    `catalog: already_s3=${state.alreadyOnS3 ?? "?"} ready=${state.ready ?? "?"} (fast=${state.fast ?? "?"} risky=${state.risky ?? "?"}) started=${state.startedAt ?? "?"}`
  );
  lines.push(`last_log=${state.lastTs || "?"} (${age(state.lastTs)} ago)`);
  lines.push("");

  const rows = [...state.active.entries()]
    .map(([title, cur]) => ({ title, ...cur }))
    .sort((a, b) => (b.percent || 0) - (a.percent || 0));

  if (rows.length === 0) {
    lines.push("(no active items parsed from recent logs)");
  } else {
    lines.push(
      `${pad("ITEM", 34)} ${rpad("%", 4)} ${pad("BAR", 10)} ${pad("DISK", 9)} ${pad("SPEED", 10)} ${pad("SIZE", 10)} ${rpad("SEEDS", 5)} ${pad("STATUS", 12)} ${pad("AGE", 7)}`
    );
    lines.push("-".repeat(110));
    for (const r of rows) {
      const disk = r.diskMB != null ? `${r.diskMB}MB` : "—";
      lines.push(
        `${pad(r.title, 34)} ${rpad(r.percent ?? "?", 3)}% ${bar(r.percent ?? 0, 10)} ${pad(disk, 9)} ${pad(r.speed ? `${r.speed}/s` : "—", 10)} ${pad(r.size || "—", 10)} ${rpad(r.seeders ?? "—", 5)} ${pad(r.status || "?", 12)} ${pad(age(r.updatedAt), 7)}`
      );
    }
  }

  if (state.skipped.length) {
    lines.push("");
    lines.push(`skipped (0 seeders): ${state.skipped.length}`);
    for (const s of state.skipped.slice(-5)) lines.push(`  - ${s.title}`);
  }
  if (state.failed.length) {
    lines.push("");
    lines.push(`failed: ${state.failed.length}`);
    for (const s of state.failed.slice(-5)) lines.push(`  - ${s.title}: ${s.reason.slice(0, 80)}`);
  }
  if (state.uploaded.length) {
    lines.push("");
    lines.push(`uploaded this run (parsed): ${state.uploaded.length}`);
    for (const s of state.uploaded.slice(-5)) lines.push(`  - ${s.title}`);
  }

  return lines.join("\n");
}

async function tick() {
  const svc = await resolveScfg();
  if (!svc) {
    console.log("No torrent-pipeline service found");
    return;
  }
  const logs = await api(`/api/orgs/${ORG}/service-configs/${svc.id}/logs?limit=500`);
  const entries = logs.data?.entries || logs.entries || [];
  const state = parseLogs(entries);
  // clear screen when interactive
  if (process.stdout.isTTY && !once) {
    process.stdout.write("\x1b[2J\x1b[H");
  } else {
    console.log("\n" + "=".repeat(72));
  }
  console.log(render(svc, state));
}

async function main() {
  await tick();
  if (once) return;
  setInterval(() => {
    tick().catch((err) => console.error("monitor error:", err.message));
  }, intervalSec * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
