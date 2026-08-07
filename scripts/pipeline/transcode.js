import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

// A synchronous child_process call with no timeout means one hung ffprobe
// (confirmed live: froze indefinitely on a completed download, on caixote)
// blocks the entire Node event loop forever - not just this item, but every
// other in-flight download/transcode too, since their own progress timers
// can't fire while the main thread is stuck waiting on this call to return.
// -show_format/-show_streams read container metadata only (no decoding), so
// even a large file should return in well under a second; 30s is generous
// headroom, not a tight budget.
const FFPROBE_TIMEOUT_MS = 30000;

function runFfprobeSync(args) {
  try {
    return execFileSync("ffprobe", args, { maxBuffer: 1024 * 1024 * 50, timeout: FFPROBE_TIMEOUT_MS });
  } catch (error) {
    if (error.killed || error.signal) {
      throw new Error(`ffprobe timed out after ${FFPROBE_TIMEOUT_MS / 1000}s (likely a corrupt/incomplete file)`);
    }
    throw error;
  }
}

function probeStreams(filePath) {
  const output = runFfprobeSync([
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(output).streams;
}

function pickVideoStream(streams) {
  return streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
}

function pickAudioStream(streams) {
  const audio = streams.filter((s) => s.codec_type === "audio");
  return audio.find((s) => s.tags?.language === "eng") || audio[0];
}

export function probeVideoHeight(filePath) {
  const video = pickVideoStream(probeStreams(filePath));
  if (!video) throw new Error("no video stream found");
  return video.height;
}

// Duration is a container-level property, not a stream one - needs
// -show_format rather than -show_streams.
export function probeDurationSeconds(filePath) {
  const output = runFfprobeSync([
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    filePath,
  ]);
  const duration = JSON.parse(output).format?.duration;
  return duration ? parseFloat(duration) : null;
}

// `trackChild` is the caller's registry of live spawned processes (same one
// it uses for its own aria2c children) so a shutdown handler there can kill
// an in-flight ffmpeg the same way - left untracked, killing the parent
// process orphans ffmpeg exactly like an untracked aria2c did (confirmed
// separately), just wasting CPU on a `.part` file nothing will ever rename
// into place, instead of corrupting anything.
function runFfmpeg(args, trackChild) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    trackChild?.add(ff);
    let stderrTail = "";
    ff.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-800);
    });
    ff.on("close", (code) => {
      trackChild?.delete(ff);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderrTail.trim().split("\n").pop()}`));
    });
    ff.on("error", (error) => {
      trackChild?.delete(ff);
      reject(error);
    });
  });
}

// Prefer VideoToolbox on macOS (fast hardware encode); fall back to software
// libx264 everywhere else (Linux caixote workers have no VideoToolbox).
// Override with FFMPEG_H264_ENCODER if needed.
function h264EncoderArgs(bitrate) {
  const forced = process.env.FFMPEG_H264_ENCODER;
  const encoder = forced || (process.platform === "darwin" ? "h264_videotoolbox" : "libx264");
  if (encoder === "libx264") {
    // preset+crf-ish bitrate mode: -b:v with libx264 still works; use a
    // fast preset so software encode doesn't dominate wall-clock on the VM.
    return ["-c:v", "libx264", "-preset", process.env.FFMPEG_X264_PRESET || "veryfast", "-b:v", bitrate];
  }
  return ["-c:v", encoder, "-b:v", bitrate];
}

// Re-encodes to a browser-playable MP4: H.264 video (hardware-accelerated via
// VideoToolbox on macOS when re-encoding is needed at all, libx264 on Linux;
// straight-copied when the source is already H.264 and no downscale is
// requested - copying is ~30x realtime vs ~20x for a hardware re-encode, so
// it's worth the branch), stereo AAC audio (multi-channel AAC in a plain
// <video> tag is unreliable on some browsers/devices), single video+audio
// track (drops cover-art "video" streams, extra dub tracks, and all subtitle
// tracks), faststart for progressive playback. Returns the source video's
// original height so callers can decide whether a further downscaled tier is
// even worth making.
export async function transcodeForBrowser(inputPath, outputPath, { maxHeight, trackChild } = {}) {
  const streams = probeStreams(inputPath);
  const video = pickVideoStream(streams);
  if (!video) throw new Error("no video stream found");
  const audio = pickAudioStream(streams);

  const needsScale = maxHeight && video.height > maxHeight;
  const videoIsH264 = video.codec_name === "h264";

  // Written to a `.part` sibling and renamed into place only once ffmpeg
  // fully finishes, so `outputPath` existing is always a reliable signal
  // that this exact transcode already completed - callers use that to skip
  // redoing a 10s-of-minutes ffmpeg encode after a restart (confirmed this
  // was happening: an interrupted run left a directly-written, truncated
  // outputPath that looked done but wasn't).
  const partPath = `${outputPath}.part`;

  const args = ["-y", "-i", inputPath, "-map", `0:${video.index}`];
  if (audio) args.push("-map", `0:${audio.index}`);

  // The bitrate tier must key off the *output* height, not just whether
  // this branch happens to be downscaling - a source already at or below
  // 720p that still needs a codec re-encode (e.g. HEVC -> H.264) is just as
  // much "720p output" as one that got scaled down to it, and should get
  // the same 2200k budget instead of the 1080p-tier 5000k. Bug found: an
  // already-720p HEVC source was landing in the `else` branch below and
  // getting re-encoded at 5000k, producing files ~2x the intended size for
  // no quality benefit (confirmed: a 632MB 720p HEVC source came out at
  // 2744MB - almost exactly what 5000k/59min predicts, vs the ~1.3GB
  // 2200k should have produced).
  const outputHeight = needsScale ? maxHeight : video.height;
  const bitrateFor = (height) => (height >= 1080 ? "5000k" : "2200k");

  if (needsScale) {
    args.push("-vf", `scale=-2:${maxHeight}`, ...h264EncoderArgs(bitrateFor(outputHeight)));
  } else if (videoIsH264) {
    args.push("-c:v", "copy");
  } else {
    args.push(...h264EncoderArgs(bitrateFor(outputHeight)));
  }

  if (audio) {
    // Always re-encode audio (cheap) rather than copy-when-already-aac, so
    // channel count is normalized to stereo regardless of source.
    args.push("-c:a", "aac", "-ac", "2", "-b:a", "160k");
  }

  // ffmpeg picks the output container by sniffing the file extension, and
  // `partPath` ends in `.part` rather than `.mp4` - without an explicit
  // format it fails immediately with "Unable to choose an output format" /
  // "Error opening output files: Invalid argument" (confirmed by
  // reproducing outside the pipeline), silently breaking every transcode
  // since the `.part`-then-rename scheme above was added.
  args.push("-f", "mp4", "-movflags", "+faststart", "-sn", partPath);

  try {
    await runFfmpeg(args, trackChild);
  } catch (error) {
    if (!needsScale && videoIsH264) {
      // Fast-path remux failed (some sources have subtly non-conformant
      // streams a straight copy chokes on) - fall back to a full re-encode.
      const fallbackArgs = ["-y", "-i", inputPath, "-map", `0:${video.index}`];
      if (audio) fallbackArgs.push("-map", `0:${audio.index}`, "-c:a", "aac", "-ac", "2", "-b:a", "160k");
      fallbackArgs.push(...h264EncoderArgs(bitrateFor(video.height)), "-f", "mp4", "-movflags", "+faststart", "-sn", partPath);
      await runFfmpeg(fallbackArgs, trackChild);
    } else {
      throw error;
    }
  }

  fs.renameSync(partPath, outputPath);
  return { sourceHeight: video.height };
}

export function browserMp4Name(originalFilename) {
  return `${path.basename(originalFilename, path.extname(originalFilename))}.mp4`;
}

// Codecs ffmpeg can losslessly convert to WebVTT text. PGS/VobSub
// (`hdmv_pgs_subtitle`, `dvd_subtitle`) are pre-rendered bitmap subtitles -
// ffmpeg can't turn those into text without OCR, so tracks in those codecs
// are silently skipped rather than attempted and failed.
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "ass", "ssa", "mov_text", "text", "webvtt"]);

const LANGUAGE_LABELS = {
  eng: "English", spa: "Spanish", fre: "French", fra: "French", ger: "German", deu: "German",
  ita: "Italian", por: "Portuguese", rus: "Russian", jpn: "Japanese", kor: "Korean",
  chi: "Chinese", zho: "Chinese", ara: "Arabic", dut: "Dutch", nld: "Dutch", swe: "Swedish",
  nor: "Norwegian", dan: "Danish", fin: "Finnish", pol: "Polish", tur: "Turkish",
  heb: "Hebrew", hin: "Hindi", gre: "Greek", ell: "Greek", ces: "Czech", cze: "Czech",
};

function subtitleLabel(lang, forced) {
  const base = LANGUAGE_LABELS[lang] || (lang === "und" ? "Unknown" : lang.toUpperCase());
  return forced ? `${base} (Forced)` : base;
}

// This catalog's audience only reads Portuguese, English, or Spanish -
// everything else (Greek, Hungarian, Polish, Romanian, ...) is pure upload/
// storage noise and clutters the player's captions menu for no one. "und"
// (no language tag at all) is kept rather than dropped: plenty of scene
// releases just omit the tag on an English or Portuguese track, and losing a
// usable caption to an over-eager filter is worse than one extra untagged
// option in the menu.
const KEPT_SUBTITLE_LANGS = new Set(["eng", "spa", "por"]);

// Extracts every text-based subtitle track in `inputPath` (in a kept
// language, see KEPT_SUBTITLE_LANGS) as a standalone WebVTT file.
// transcodeForBrowser drops subtitles entirely (`-sn`) since a plain <video>
// tag can't render embedded tracks the way it renders embedded audio - a
// browser needs each track as a separate WebVTT resource wired up via
// <track> instead, so this has to run against the original source before
// that source is discarded, not against the already-stripped transcode output.
export async function extractSubtitles(inputPath, outputDir, baseName, { trackChild } = {}) {
  const streams = probeStreams(inputPath);
  const subtitleStreams = streams.filter((s) => {
    if (s.codec_type !== "subtitle" || !TEXT_SUBTITLE_CODECS.has(s.codec_name)) return false;
    const lang = s.tags?.language || "und";
    return lang === "und" || KEPT_SUBTITLE_LANGS.has(lang);
  });
  if (subtitleStreams.length === 0) return [];

  const langCounts = new Map();
  const tracks = subtitleStreams.map((s) => {
    const lang = s.tags?.language || "und";
    const count = (langCounts.get(lang) || 0) + 1;
    langCounts.set(lang, count);
    const id = count > 1 ? `${lang}-${count}` : lang;
    const forced = s.disposition?.forced === 1;
    return {
      streamIndex: s.index,
      id,
      lang,
      label: subtitleLabel(lang, forced),
      forced,
      partPath: path.join(outputDir, `${baseName}.${id}.vtt.part`),
      outPath: path.join(outputDir, `${baseName}.${id}.vtt`),
    };
  });

  // Each output needs its own explicit `-f webvtt` immediately before its
  // path: ffmpeg picks a muxer by sniffing the *next* output's extension,
  // and every path here ends in `.part` rather than `.vtt` (see partPath/
  // outPath below) - same "Unable to choose an output format" failure as
  // transcodeForBrowser's single-output case, just recurring once per track
  // instead of once per file since this command can write several outputs.
  const args = ["-y", "-i", inputPath];
  for (const t of tracks) args.push("-map", `0:${t.streamIndex}`, "-c:s", "webvtt", "-f", "webvtt", t.partPath);

  try {
    await runFfmpeg(args, trackChild);
  } catch {
    // A single malformed track (e.g. corrupt timing) shouldn't lose every
    // other track in the same file - fall back to converting each stream in
    // its own ffmpeg invocation so one bad track can't take the rest down.
    for (const t of tracks) {
      try {
        await runFfmpeg(["-y", "-i", inputPath, "-map", `0:${t.streamIndex}`, "-c:s", "webvtt", "-f", "webvtt", t.partPath], trackChild);
      } catch {
        t.failed = true;
      }
    }
  }

  const results = [];
  for (const t of tracks) {
    if (t.failed || !fs.existsSync(t.partPath)) continue;
    fs.renameSync(t.partPath, t.outPath);
    results.push({ id: t.id, lang: t.lang, label: t.label, forced: t.forced, filePath: t.outPath });
  }
  return results;
}

// Scene releases and YIFY packs often ship softsubs as sidecar files next
// to the video (Movie.srt, Movie.eng.srt, Subs/Portuguese.srt) rather than
// muxing them into the container. extractSubtitles only sees embedded
// streams; these helpers cover the sidecar path so we don't throw usable
// captions away as "cruft" when finalizeItem cleans the itemDir.
const SIDECAR_SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);

// Filename language heuristics for the languages this catalog keeps. Order
// matters: more specific Portuguese/Brazilian markers before bare `pt`/`en`
// so "pt-BR" doesn't get misread as English via a coincidental `.en` later.
const FILENAME_LANG_PATTERNS = [
  // "Portuguese" / "português" / "pt-BR" — optional trailing e so the
  // English spelling ("Portuguese") matches, not just the stem "portugues".
  [/\b(pt[-_.]?br|brazili?an|portugu[eê]se?|portugues)\b/i, "por"],
  [/\b(por|pt)\b/i, "por"],
  [/\b(spa|es|spanish|espa[nñ]ol|espanol)\b/i, "spa"],
  [/\b(eng|en|english)\b/i, "eng"],
];

export function guessSubtitleLangFromFilename(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  for (const [re, lang] of FILENAME_LANG_PATTERNS) {
    if (re.test(base)) return lang;
  }
  return "und";
}

// Convert any text subtitle ffmpeg can demux (SRT/ASS/SSA/VTT) to WebVTT
// for <track> playback. Bitmap .sub/idx pairs are not handled - same OCR
// wall as embedded PGS. Atomic .part rename so a killed convert never
// leaves a half-written .vtt the next run treats as complete.
export async function convertSubtitleFileToVtt(inputPath, outputPath, { trackChild } = {}) {
  const partPath = `${outputPath}.part`;
  try {
    await runFfmpeg(["-y", "-i", inputPath, "-f", "webvtt", partPath], trackChild);
  } catch (error) {
    fs.rmSync(partPath, { force: true });
    throw error;
  }
  fs.renameSync(partPath, outputPath);
}

// Walk `searchDir` (typically the video's parent dir, or the whole itemDir)
// for text subtitle sidecars. Prefers files whose basename matches the
// video's stem (Movie.eng.srt next to Movie.mkv); also accepts language-
// named files in a Subs/ subfolder. Skips languages outside KEPT_SUBTITLE_LANGS
// (except "und"). Returns candidates ready for convertSubtitleFileToVtt.
export function findSidecarSubtitles(videoPath, searchDir = path.dirname(videoPath)) {
  const videoStem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const found = [];

  function walk(dir, depth) {
    if (depth > 2 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Common release layouts put all captions under Subs/ or Subtitles/.
        if (/^(subs?|subtitles?|captions?)$/i.test(ent.name)) walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!SIDECAR_SUBTITLE_EXTS.has(ext)) continue;
      // .sub alone is often half of a VobSub pair (bitmap) - only keep it if
      // there's no matching .idx (text MicroDVD .sub has no .idx sibling).
      if (ext === ".sub") {
        const idx = full.slice(0, -4) + ".idx";
        if (fs.existsSync(idx)) continue;
      }
      const stem = path.basename(ent.name, ext).toLowerCase();
      // Same-folder: require the subtitle filename to start with the video
      // stem (Movie.srt / Movie.eng.srt) so a multi-file release doesn't
      // attach Episode2's captions to Episode1. Inside a Subs/ folder the
      // convention is freer (just "English.srt"), so accept any kept-lang
      // name there.
      const inSubsFolder = /[\\/](subs?|subtitles?|captions?)[\\/]/i.test(full);
      if (!inSubsFolder && !stem.startsWith(videoStem) && stem !== videoStem) continue;
      const lang = guessSubtitleLangFromFilename(ent.name);
      // Inside Subs/ the filename is the only language signal (English.srt,
      // Portuguese.srt). Untagged files there are usually junk or an
      // unknown language — skip rather than pollute the menu as "Unknown".
      // Next to the video, an untagged Movie.srt is kept as "und" (same
      // rationale as embedded tracks with no language tag).
      if (lang === "und") {
        if (inSubsFolder) continue;
      } else if (!KEPT_SUBTITLE_LANGS.has(lang)) {
        continue;
      }
      found.push({ filePath: full, lang, forced: /\bforced\b/i.test(ent.name) });
    }
  }

  walk(searchDir, 0);
  return found;
}

// Convert every sidecar next to `videoPath` into WebVTT under outputDir,
// assigning stable ids (eng, eng-2, …) that don't collide with already-
// claimed ids from embedded extraction (pass those via `usedIds`).
export async function extractSidecarSubtitles(
  videoPath,
  outputDir,
  baseName,
  { trackChild, searchDir, usedIds = new Set() } = {},
) {
  const candidates = findSidecarSubtitles(videoPath, searchDir ?? path.dirname(videoPath));
  if (candidates.length === 0) return [];

  const langCounts = new Map();
  // Seed counters from already-used ids so a sidecar eng doesn't overwrite
  // the embedded eng track's id in the catalog.
  for (const id of usedIds) {
    const m = /^(.*)-(\d+)$/.exec(id);
    if (m) {
      const n = parseInt(m[2], 10);
      langCounts.set(m[1], Math.max(langCounts.get(m[1]) || 0, n));
    } else {
      langCounts.set(id, Math.max(langCounts.get(id) || 0, 1));
    }
  }

  const results = [];
  for (const cand of candidates) {
    const count = (langCounts.get(cand.lang) || 0) + 1;
    langCounts.set(cand.lang, count);
    const id = count > 1 ? `${cand.lang}-${count}` : cand.lang;
    const outPath = path.join(outputDir, `${baseName}.sidecar.${id}.vtt`);
    try {
      await convertSubtitleFileToVtt(cand.filePath, outPath, { trackChild });
      results.push({
        id,
        lang: cand.lang,
        label: subtitleLabel(cand.lang, cand.forced),
        forced: cand.forced,
        filePath: outPath,
      });
    } catch (error) {
      console.log(`  ⚠ sidecar ${path.basename(cand.filePath)} → vtt failed: ${error.message}`);
      fs.rmSync(outPath, { force: true });
      fs.rmSync(`${outPath}.part`, { force: true });
    }
  }
  return results;
}
