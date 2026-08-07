/**
 * Tiny pre-flight before scripts/pipeline/download-picked-torrents.js:
 * - seed enriched catalog onto the data path on first boot
 * - fail fast with a clear message if S3 env is missing
 * - force stdout/stderr unbuffered-ish writes for microVM serial logs
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { runNetworkDiagnostics } from "./network-diag.mjs";

// Make console output more likely to flush for serial capture.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
if (process.stderr._handle?.setBlocking) process.stderr._handle.setBlocking(true);

console.log(`[bootstrap] starting torrent pipeline pid=${process.pid} platform=${process.platform}`);

const dataDir = process.env.PIPELINE_DATA_DIR || "/data/backend/data";
const downloadsDir = process.env.DOWNLOADS_DIR || "/data/downloads";
const enriched = process.env.ENRICHED_FILE || path.join(dataDir, "enriched_400.json");
const seed = "/app/backend/data/enriched_400.json";

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });

if (!fs.existsSync(enriched)) {
  console.log(`[bootstrap] seeding ${enriched} from image`);
  fs.copyFileSync(seed, enriched);
} else {
  console.log(`[bootstrap] using existing catalog at ${enriched}`);
}

// Env vars arrive natively via caixote's IntentSync transport (portaria →
// federation → caixote → runc config.json). The previous .env.caixote
// fallback was a workaround for a portaria-reconciler mTLS bug fixed
// 2026-07-25: the reconciler was missing its mTLS env vars (CAIXOTE_MTLS,
// FAROL_*, MTLS_*) and fell back to plaintext HTTP against a TLS-only
// federation-api, so every reprovision/state-sync call failed and
// containers never received their env. Now that the reconciler bootstraps
// an mTLS identity, the native path works and the fallback is unnecessary.

for (const key of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_NAME", "S3_ENDPOINT"]) {
  if (!process.env[key]) {
    console.error(`[bootstrap] missing required env: ${key}`);
    process.exit(1);
  }
}

console.log(`[bootstrap] S3 endpoint=${process.env.S3_ENDPOINT} bucket set, launching pipeline`);

// Every torrent this run has been stalling at 0B/s regardless of seeder
// count — run a quick DNS/HTTPS/DHT-UDP probe up front so caixote logs show
// whether this is a network egress problem before blaming the swarm again.
await runNetworkDiagnostics().catch((err) =>
  console.error(`[bootstrap] network diagnostics failed to run: ${err.message}`),
);

// Hand off to the real pipeline (same process so signals stay correct).
await import(
  pathToFileURL(path.resolve("/app/scripts/pipeline/download-picked-torrents.js")).href,
);
