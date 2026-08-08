/**
 * Durable index of titles packaged as HLS AES-128.
 *
 * The acquisition pipeline and other catalog writers load enriched_400.json
 * into memory and periodically rewrite the whole file. Without this sidecar
 * they clobber hls_playlist_s3_key set by package-hls-from-s3.js.
 *
 * Any catalog save path should call applyHlsIndex(catalog) before write.
 */

const fs = require("fs");
const path = require("path");

const INDEX_PATH =
  process.env.HLS_INDEX_PATH ||
  path.join("backend", "data", "hls_packaged.json");

function loadHlsIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveHlsIndex(index) {
  const dir = path.dirname(INDEX_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n");
  fs.renameSync(tmp, INDEX_PATH);
}

/** Record one title as packaged. Returns updated index. */
function recordHlsPackaged(id, playlistKey) {
  if (!id || !playlistKey) return loadHlsIndex();
  const index = loadHlsIndex();
  index[id] = playlistKey;
  saveHlsIndex(index);
  return index;
}

/**
 * Seed index from a catalog snapshot (one-shot bootstrap / recovery).
 * Does not remove entries that are only in the index.
 */
function seedHlsIndexFromCatalog(catalog) {
  const index = loadHlsIndex();
  let added = 0;
  for (const item of catalog.items || []) {
    if (item?.id && item.hls_playlist_s3_key && !index[item.id]) {
      index[item.id] = item.hls_playlist_s3_key;
      added++;
    }
  }
  if (added > 0) saveHlsIndex(index);
  return { index, added };
}

/**
 * Mutate catalog items so every index entry has hls_playlist_s3_key + encrypted.
 * Returns number of items repaired.
 */
function applyHlsIndex(catalog) {
  const index = loadHlsIndex();
  const byId = new Map(
    (catalog.items || []).filter(Boolean).map((x) => [x.id, x]),
  );
  let repaired = 0;
  for (const [id, key] of Object.entries(index)) {
    const item = byId.get(id);
    if (!item) continue;
    if (item.hls_playlist_s3_key !== key || !item.encrypted) {
      item.hls_playlist_s3_key = key;
      item.encrypted = true;
      repaired++;
    }
  }
  return repaired;
}

module.exports = {
  INDEX_PATH,
  loadHlsIndex,
  saveHlsIndex,
  recordHlsPackaged,
  seedHlsIndexFromCatalog,
  applyHlsIndex,
};
