"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { EpisodeMetadata, ProgressEntry, SubtitleTrack } from "@/lib/types";

// HTML <track srclang> wants a BCP 47 tag; source files report ISO 639-2
// (3-letter) codes via ffprobe, which some browsers render captions-menu
// labels for less predictably than the 2-letter ISO 639-1 form. Only the
// languages actually seen in this catalog need mapping - everything else
// falls back to the 3-letter code as-is, which is still a valid tag.
const BCP47: Record<string, string> = {
  eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de",
  ita: "it", por: "pt", rus: "ru", jpn: "ja", kor: "ko", chi: "zh", zho: "zh",
  ara: "ar", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi",
  pol: "pl", tur: "tr", heb: "he", hin: "hi", gre: "el", ell: "el",
};

type Episode = {
  key: string;
  /** 1-based index into the original s3Keys array — what the backend expects. */
  originalIndex: number;
  number: number;
  /** Only set from real TMDB metadata - lets the sort account for season
   * boundaries once a show has more than one season downloaded. */
  seasonNumber?: number;
  title: string;
  overview?: string | null;
  stillUrl?: string | null;
};

function parseEpisode(s3Key: string, originalIndex: number): Episode {
  const filename = s3Key.split("/").pop() ?? s3Key;
  const withoutExt = filename.replace(/\.[^./]+$/, "");
  const numberMatch = withoutExt.match(/^Ep\s*(\d+)/i);
  // Split on " - " (spaced hyphen) rather than any "-" so titles containing
  // a bare hyphen (e.g. "Fifty-One") aren't truncated.
  const parts = withoutExt.split(" - ");
  const title = numberMatch && parts.length > 1 ? parts[1].trim() : withoutExt;
  return {
    key: s3Key,
    originalIndex,
    number: numberMatch ? parseInt(numberMatch[1], 10) : originalIndex + 1,
    title,
  };
}

// Prefers real TMDB episode data (title/overview/still) when the backfill
// has matched this episode; falls back to parsing the filename otherwise.
function buildEpisode(
  s3Key: string,
  originalIndex: number,
  episodeMetadata: EpisodeMetadata[]
): Episode {
  const parsed = parseEpisode(s3Key, originalIndex);
  const meta = episodeMetadata.find((m) => m.episode === originalIndex + 1);
  if (!meta) return parsed;
  return {
    ...parsed,
    number: meta.episode_number,
    seasonNumber: meta.season_number,
    title: meta.name ?? parsed.title,
    overview: meta.overview,
    stillUrl: meta.still_url,
  };
}

// Defaults the episode picker to wherever watching was left off, rather
// than always the first episode - the point of tracking progress at all.
// Progress rows key on originalIndex+1 (matching the backend's stream
// indexing), not the parsed display number, since s3Keys order isn't
// guaranteed to match narrative order.
function resumeOriginalIndex(progress: ProgressEntry[], fallback: number): number {
  const candidates = progress.filter((p) => !p.finished && p.position_seconds > 0 && p.episode > 0);
  if (candidates.length === 0) return fallback;
  const maxEpisode = candidates.reduce((max, p) => Math.max(max, p.episode), 0);
  return maxEpisode - 1;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function SkipButton({ direction, onClick }: { direction: "back" | "forward"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "back" ? "Skip back 10 seconds" : "Skip forward 10 seconds"}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
    >
      <svg
        viewBox="0 0 24 24"
        className={`h-6 w-6 ${direction === "forward" ? "-scale-x-100" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 8v4h4" />
        <path d="M4.5 12a7.5 7.5 0 1 0 2.1-5.2" />
      </svg>
      <span className="pointer-events-none absolute text-[9px] font-bold">10</span>
    </button>
  );
}

function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3z" />
      {muted ? (
        <path
          d="M16.5 9.5l4 5M20.5 9.5l-4 5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ) : (
        <>
          <path
            d="M15.5 8.5a4.5 4.5 0 0 1 0 7"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
          <path
            d="M18 6a8 8 0 0 1 0 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            opacity={0.6}
          />
        </>
      )}
    </svg>
  );
}

function SubtitlesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M7 10.5h3M7 13.5h5M14 10.5h3M14 13.5h3" strokeLinecap="round" />
    </svg>
  );
}

function FullscreenIcon({ isFullscreen, className }: { isFullscreen: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {isFullscreen ? (
        <path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4" />
      ) : (
        <path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4" />
      )}
    </svg>
  );
}

function AirPlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M12 19.5l4.5 4.5h-9l4.5-4.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CastIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M2.5 13.5a8 8 0 0 1 8 8" />
      <path d="M2.5 9a12.5 12.5 0 0 1 12.5 12.5" />
      <path d="M2.5 17.5v2.5h2.5a2.5 2.5 0 0 0-2.5-2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// The Cast SDK's CastContext/RemotePlayer represent the one browser-tab-wide
// cast session - kept at module scope (not per-VideoPlayer-instance state) so
// navigating between titles reuses the same session instead of constructing
// a fresh RemotePlayerController - and its own internal listeners - on every
// mount.
let castRemotePlayer: RemotePlayer | null = null;
let castRemotePlayerController: RemotePlayerController | null = null;

function getCastController(): { player: RemotePlayer; controller: RemotePlayerController } | null {
  if (!window.cast?.framework || !window.chrome?.cast) return null;
  if (!castRemotePlayer || !castRemotePlayerController) {
    window.cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    castRemotePlayer = new window.cast.framework.RemotePlayer();
    castRemotePlayerController = new window.cast.framework.RemotePlayerController(castRemotePlayer);
  }
  return { player: castRemotePlayer, controller: castRemotePlayerController };
}

type BufferedRange = { start: number; end: number };

// Grabs a real frame from the video at the hovered time, via a second
// <video> + <canvas> hidden off the visible controls - not <img> thumbnails,
// since there's no pre-generated sprite sheet from the transcode pipeline.
// Reuses the same (range-request-capable, S3-backed) stream URL as the main
// player, so scrubbing the hover position just issues ordinary byte-range
// fetches for whatever moment is under the cursor.
function ScrubPreview({
  streamUrl,
  hoverFraction,
  duration,
}: {
  streamUrl: string;
  hoverFraction: number | null;
  duration: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingTime = useRef<number | null>(null);
  const visible = hoverFraction !== null && duration > 0;
  const previewTime = hoverFraction !== null ? hoverFraction * duration : 0;

  // Coalesce rapid mousemoves into whichever position was last requested
  // once the in-flight seek (a real network fetch) resolves, rather than
  // queuing a seek per pixel of mouse movement.
  useEffect(() => {
    if (!visible) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.seeking) {
      pendingTime.current = previewTime;
      return;
    }
    if (Math.abs(video.currentTime - previewTime) > 0.5) {
      video.currentTime = previewTime;
    }
  }, [previewTime, visible]);

  useEffect(() => {
    if (!visible) pendingTime.current = null;
  }, [visible]);

  // Source changed (new episode) - drop the stale frame so the preview
  // doesn't briefly show the previous episode's thumbnail.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, [streamUrl]);

  function handleSeeked() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (video && canvas && ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (video && pendingTime.current !== null) {
      const next = pendingTime.current;
      pendingTime.current = null;
      if (Math.abs(video.currentTime - next) > 0.5) video.currentTime = next;
    }
  }

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute bottom-full z-10 mb-3 -translate-x-1/2 overflow-hidden rounded-md bg-black shadow-lg ring-1 ring-white/20 transition-opacity duration-100 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      style={{ left: `clamp(80px, ${(hoverFraction ?? 0) * 100}%, calc(100% - 80px))` }}
    >
      {/* Mounted only while actually hovered, not for the player's whole
          lifetime - a persistent third <video> decoder session (on top of
          the main player) is a real resource cost for no benefit to anyone
          who never hovers, and some browsers get flaky about metadata/seeks
          on background video elements the longer they sit around unused.
          `opacity-0` + explicit size (not `hidden`/display:none) - Safari
          doesn't reliably load metadata for display:none <video>s. */}
      {visible && (
        <video
          ref={videoRef}
          src={streamUrl}
          muted
          playsInline
          preload="metadata"
          onSeeked={handleSeeked}
          className="absolute h-px w-px opacity-0"
        />
      )}
      <canvas ref={canvasRef} width={160} height={90} className="block h-[90px] w-40 object-cover" />
      <span className="block bg-black/85 px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums text-white">
        {formatTime(previewTime)}
      </span>
    </div>
  );
}

function SeekBar({
  currentTime,
  duration,
  buffered,
  streamUrl,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  buffered: BufferedRange[];
  streamUrl: string;
  onSeek: (seconds: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  function fractionFromEvent(e: React.PointerEvent) {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (duration <= 0) return;
    const fraction = fractionFromEvent(e);
    setDragFraction(fraction);
    onSeek(fraction * duration);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const fraction = fractionFromEvent(e);
    if (duration > 0) setHoverFraction(fraction);
    if (dragFraction === null) return;
    setDragFraction(fraction);
    onSeek(fraction * duration);
  }

  function handlePointerUp() {
    setDragFraction(null);
  }

  function handlePointerLeave() {
    setHoverFraction(null);
  }

  const fraction = duration > 0 ? (dragFraction ?? Math.min(1, currentTime / duration)) : 0;

  return (
    <div
      ref={barRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      className="group/seek relative flex h-4 w-full cursor-pointer items-center"
    >
      <ScrubPreview streamUrl={streamUrl} hoverFraction={hoverFraction} duration={duration} />
      <div className="relative h-1 w-full rounded-full bg-white/25 transition-[height] group-hover/seek:h-1.5">
        {duration > 0 &&
          buffered.map((range, i) => (
            <div
              key={i}
              className="absolute inset-y-0 rounded-full bg-white/45"
              style={{
                left: `${(range.start / duration) * 100}%`,
                width: `${((range.end - range.start) / duration) * 100}%`,
              }}
            />
          ))}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[#f5c518]"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <div
        className="absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full bg-[#f5c518] opacity-0 shadow transition-opacity group-hover/seek:opacity-100"
        style={{ left: `${fraction * 100}%` }}
      />
    </div>
  );
}

type Status = "loading" | "ready" | "error";

const REPORT_INTERVAL_MS = 10_000;
const CONTROLS_HIDE_DELAY_MS = 2800;

export function VideoPlayer({
  id,
  title = null,
  s3Keys,
  initialProgress,
  subtitles,
  episodeMetadata = [],
  preferredSubtitleLang = null,
  autoplayNext = true,
  posterUrl = null,
}: {
  id: string;
  /** Movie/show title - only used as Cast metadata so the receiver's screen
   * shows something more useful than the bare content id. */
  title?: string | null;
  s3Keys: string[];
  initialProgress: ProgressEntry[];
  subtitles: SubtitleTrack[];
  episodeMetadata?: EpisodeMetadata[];
  preferredSubtitleLang?: string | null;
  autoplayNext?: boolean;
  /** Falls back to the title's backdrop when the current episode has no
   * still image of its own - a plain <video> just shows black before
   * playback starts (many films/episodes fade in from black), which reads
   * as broken rather than "not started yet". */
  posterUrl?: string | null;
}) {
  const hasEpisodes = s3Keys.length > 1;
  // s3Keys isn't guaranteed to be in episode order; sort a copy for display
  // while keeping each episode's original index for the stream request,
  // since the backend indexes into s3Keys as stored.
  const episodes = hasEpisodes
    ? s3Keys
        .map((key, i) => buildEpisode(key, i, episodeMetadata))
        .sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || a.number - b.number)
    : [];
  const [selectedIndex, setSelectedIndex] = useState(() =>
    hasEpisodes ? resumeOriginalIndex(initialProgress, episodes[0]?.originalIndex ?? 0) : 0
  );
  const [status, setStatus] = useState<Status>("loading");
  const [retry, setRetry] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [airplayAvailable, setAirplayAvailable] = useState(false);
  const [castAvailable, setCastAvailable] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [castDeviceName, setCastDeviceName] = useState<string | null>(null);
  const streamUrl = hasEpisodes
    ? `/api/stream/${id}?episode=${selectedIndex + 1}`
    : `/api/stream/${id}`;
  const progressUrl = `/api/progress/${id}`;
  // 0 is the movie/no-episode sentinel, matching the backend schema.
  const episodeNumber = hasEpisodes ? selectedIndex + 1 : 0;
  const currentEpisode = hasEpisodes ? episodes.find((ep) => ep.originalIndex === selectedIndex) : null;
  const effectivePoster = currentEpisode?.stillUrl ?? posterUrl ?? undefined;
  const savedProgress = initialProgress.find((p) => p.episode === episodeNumber) ?? null;
  const episodeSubtitles = subtitles.filter((t) => t.episode === episodeNumber);
  // The user's preferred language wins if this episode has it; otherwise
  // fall back to non-forced English, then any non-forced track. Forced
  // tracks (foreign-dialogue-only) are opt-in, never a default.
  const defaultSubtitleId =
    ((preferredSubtitleLang
      ? episodeSubtitles.find((t) => t.lang === preferredSubtitleLang && !t.forced)
      : undefined) ??
      episodeSubtitles.find((t) => t.lang === "eng" && !t.forced) ??
      episodeSubtitles.find((t) => !t.forced))?.id ?? null;
  const [selectedSubtitleId, setSelectedSubtitleId] = useState(defaultSubtitleId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const seekReportTimer = useRef<number | null>(null);
  const [seeked, setSeeked] = useState(false);

  // Cast media is (re)loaded from a CastContext session-state event, which
  // fires asynchronously - long after whichever render wired up the
  // listener. Reading these straight from that render's closure would load
  // whatever episode/poster was current when the cast button was first set
  // up, not whichever one is actually selected when a session starts.
  const latestPlaybackRef = useRef({ streamUrl, title, effectivePoster, episodeTitle: currentEpisode?.title });
  latestPlaybackRef.current = { streamUrl, title, effectivePoster, episodeTitle: currentEpisode?.title };

  // Manual resize (drag the handle in the control bar). Not CSS `resize`:
  // this element is a `flex-1` flex item (fills whatever space isn't taken
  // by the episode list/sidebar) - `flex-1`'s flex-basis:0% means the flex
  // algorithm recomputes its width on every layout pass from flex-grow,
  // silently overwriting whatever width native `resize` sets. Once the user
  // actually drags, we detach from flex-grow entirely (inline width + `flex:
  // none`) so nothing fights the size they chose; height still just follows
  // from `aspect-video` on the <video> itself, so it can't end up stretched.
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const resizeStart = useRef<{ pointerX: number; width: number; maxWidth: number } | null>(null);

  function handleResizePointerDown(e: React.PointerEvent) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const currentWidth = rect.width;
    // Cap at the viewport, not just this row's own share of the page
    // column - every row between here and the page root is `flex-wrap`, so
    // anything this pushes out of the way (episode list, facts sidebar)
    // simply wraps onto its own line below rather than being squeezed or
    // covered, the same way YouTube's embed-size preview lets you drag a
    // player out to the full width of the page. Measured from the
    // element's own left edge (not a flat viewport width) since the page
    // centers it with side padding - growing from `rect.left` is what
    // actually keeps the right edge (and the fullscreen button) on-screen.
    const maxWidth = window.innerWidth - rect.left - 16;
    resizeStart.current = { pointerX: e.clientX, width: currentWidth, maxWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handleResizePointerMove(e: React.PointerEvent) {
    const start = resizeStart.current;
    if (!start) return;
    const next = Math.min(start.maxWidth, Math.max(240, start.width + (e.clientX - start.pointerX)));
    setCustomWidth(next);
  }

  function handleResizePointerUp() {
    resizeStart.current = null;
  }

  // Reset to "loading" whenever the source changes, without an effect (which
  // would run after a stale-status frame paints first) - this is React's
  // documented pattern for adjusting state during render.
  const [trackedUrl, setTrackedUrl] = useState(streamUrl);
  if (streamUrl !== trackedUrl) {
    setTrackedUrl(streamUrl);
    setStatus("loading");
    setSeeked(false);
    setCurrentTime(0);
    setDuration(0);
    setSelectedSubtitleId(defaultSubtitleId);
    setBuffered([]);
  }

  function updateBuffered(video: HTMLVideoElement) {
    const ranges: BufferedRange[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
    }
    setBuffered(ranges);
  }

  // `override` is how cast playback reports progress - the position lives on
  // the remote player, not the (paused, frozen) local <video> element, while
  // a session is active.
  function reportProgress(useBeacon: boolean, override?: { positionSeconds: number; durationSeconds: number }) {
    const video = videoRef.current;
    const positionSeconds = override?.positionSeconds ?? video?.currentTime;
    const durationSeconds = override?.durationSeconds ?? video?.duration;
    if (positionSeconds === undefined || !durationSeconds || Number.isNaN(durationSeconds)) return;

    const payload = JSON.stringify({
      episode: episodeNumber,
      position_seconds: positionSeconds,
      duration_seconds: durationSeconds,
    });

    if (useBeacon) {
      navigator.sendBeacon(progressUrl, new Blob([payload], { type: "application/json" }));
    } else {
      fetch(progressUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }

  // Seeking/skipping only updated currentTime, never reported it - a seek
  // right before a refresh (no pause, no 10s interval tick yet) was
  // silently lost, resuming from the pre-seek position instead. Debounced
  // rather than reporting on every event: the seek bar's onSeek fires
  // continuously while dragging, and reporting on each of those would spam
  // the backend with a request per pixel of drag movement.
  function scheduleProgressReport(override?: { positionSeconds: number; durationSeconds: number }) {
    if (seekReportTimer.current) window.clearTimeout(seekReportTimer.current);
    seekReportTimer.current = window.setTimeout(() => reportProgress(false, override), 800);
  }

  // Throttled reporting while actually playing; torn down on pause/episode
  // change via the effect cleanup, not left to drift across remounts. Skips
  // while casting - the cast-progress effect below reports from the remote
  // player's position instead, since the local <video> is paused and frozen
  // for the duration of the session.
  useEffect(() => {
    if (!isPlaying || isCasting) return;
    const intervalId = window.setInterval(() => reportProgress(false), REPORT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isCasting, streamUrl]);

  useEffect(() => {
    if (!isPlaying || !isCasting) return;
    const intervalId = window.setInterval(() => {
      if (!castRemotePlayer) return;
      reportProgress(false, {
        positionSeconds: castRemotePlayer.currentTime,
        durationSeconds: castRemotePlayer.duration,
      });
    }, REPORT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isCasting, streamUrl]);

  // Best-effort flush when the tab closes/backgrounds - fetch during unload
  // is unreliable, sendBeacon is the standard fix.
  useEffect(() => {
    function handlePageHide() {
      reportProgress(true);
    }
    document.addEventListener("pagehide", handlePageHide);
    return () => document.removeEventListener("pagehide", handlePageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  // Native <track> cues still render through the browser - we just drive
  // which one is active ourselves instead of relying on the browser's own
  // (now-removed, since `controls` is gone) captions menu.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      const trackId = episodeSubtitles[i]?.id;
      track.mode = trackId && trackId === selectedSubtitleId ? "showing" : "hidden";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubtitleId, episodeNumber, episodeSubtitles.length]);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // AirPlay only exists on Safari/WebKit - the availability-changed event is
  // how a page finds out whether to show the button at all, rather than
  // assuming the API means there's actually a receiver nearby.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof video.webkitShowPlaybackTargetPicker !== "function") return;
    function handleAvailabilityChanged(e: Event) {
      setAirplayAvailable((e as unknown as { availability: string }).availability === "available");
    }
    video.addEventListener("webkitplaybacktargetavailabilitychanged", handleAvailabilityChanged);
    return () =>
      video.removeEventListener("webkitplaybacktargetavailabilitychanged", handleAvailabilityChanged);
  }, [streamUrl, retry]);

  async function loadCastMedia() {
    const session = window.cast?.framework.CastContext.getInstance().getCurrentSession();
    if (!session || !window.chrome?.cast) return;
    const { streamUrl: latestStreamUrl, title: latestTitle, effectivePoster: latestPoster, episodeTitle } =
      latestPlaybackRef.current;
    const res = await fetch(`${latestStreamUrl}${latestStreamUrl.includes("?") ? "&" : "?"}resolve=1`);
    if (!res.ok) return;
    const { url } = (await res.json()) as { url: string };
    const mediaInfo = new window.chrome.cast.media.MediaInfo(url, "video/mp4");
    mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = episodeTitle && latestTitle ? `${latestTitle} — ${episodeTitle}` : (latestTitle ?? episodeTitle);
    if (latestPoster) mediaInfo.metadata.images = [{ url: latestPoster }];
    const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = videoRef.current?.currentTime ?? 0;
    await session.loadMedia(request).catch(() => {});
  }

  // Sets up the Cast SDK's listeners exactly once per mount (not once per
  // dependency change) - session-state events fire long after this effect
  // runs, so freshness for the actual media loaded comes from
  // latestPlaybackRef, not from re-subscribing whenever streamUrl changes.
  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;

    function attach() {
      if (cancelled) return;
      const castApi = getCastController();
      const cast = window.cast;
      if (!castApi || !cast) return;
      const { player, controller } = castApi;

      function handleConnectedChanged() {
        setIsCasting(player.isConnected);
        if (player.isConnected) {
          videoRef.current?.pause();
          const session = cast!.framework.CastContext.getInstance().getCurrentSession();
          setCastDeviceName(session?.getCastDevice().friendlyName ?? null);
        } else if (videoRef.current && player.currentTime > 0) {
          videoRef.current.currentTime = player.currentTime;
          setCurrentTime(player.currentTime);
        }
      }
      function handlePausedChanged() {
        setIsPlaying(!player.isPaused);
      }
      function handleCurrentTimeChanged() {
        setCurrentTime(player.currentTime);
      }
      function handleDurationChanged() {
        setDuration(player.duration);
      }
      function handleSessionStateChanged(event: { sessionState?: string }) {
        const started =
          event.sessionState === cast!.framework.SessionState.SESSION_STARTED ||
          event.sessionState === cast!.framework.SessionState.SESSION_RESUMED;
        if (started) loadCastMedia();
      }
      function handleCastStateChanged() {
        setCastAvailable(context.getCastState() !== cast!.framework.CastState.NO_DEVICES_AVAILABLE);
      }

      const context = cast.framework.CastContext.getInstance();
      controller.addEventListener(cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED, handleConnectedChanged);
      controller.addEventListener(cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED, handlePausedChanged);
      controller.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, handleCurrentTimeChanged);
      controller.addEventListener(cast.framework.RemotePlayerEventType.DURATION_CHANGED, handleDurationChanged);
      context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, handleSessionStateChanged);
      context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, handleCastStateChanged);
      setCastAvailable(context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE);

      detach = () => {
        controller.removeEventListener(cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED, handleConnectedChanged);
        controller.removeEventListener(cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED, handlePausedChanged);
        controller.removeEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, handleCurrentTimeChanged);
        controller.removeEventListener(cast.framework.RemotePlayerEventType.DURATION_CHANGED, handleDurationChanged);
        context.removeEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, handleSessionStateChanged);
        context.removeEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, handleCastStateChanged);
      };
    }

    if (window.cast?.framework) {
      attach();
    } else {
      window.__onGCastApiAvailable = (isAvailable) => {
        if (isAvailable) attach();
      };
    }

    return () => {
      cancelled = true;
      detach?.();
      delete window.__onGCastApiAvailable;
    };
  }, []);

  // Close the subtitle menu on an outside click rather than only via its own
  // toggle button, matching how every other dropdown on the page behaves.
  useEffect(() => {
    if (!subtitleMenuOpen) return;
    function handleClick() {
      setSubtitleMenuOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [subtitleMenuOpen]);

  function scheduleHideControls() {
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    hideControlsTimer.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS);
  }

  function stopHideControls() {
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    setShowControls(true);
  }

  function handleActivity() {
    setShowControls(true);
    if (isPlaying) scheduleHideControls();
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;
    // Seeding currentTime only works once metadata has loaded - setting it
    // right after the initial fetch resolves is commonly ignored by the
    // browser.
    if (video && savedProgress && !savedProgress.finished && !seeked) {
      video.currentTime = savedProgress.position_seconds;
    }
    if (video) setDuration(video.duration);
    setSeeked(true);
  }

  function skip(deltaSeconds: number) {
    if (isCasting) {
      seekTo(Math.min(duration || Infinity, Math.max(0, currentTime + deltaSeconds)));
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration || Infinity;
    video.currentTime = Math.min(dur, Math.max(0, video.currentTime + deltaSeconds));
    setCurrentTime(video.currentTime);
    scheduleProgressReport();
  }

  function seekTo(seconds: number) {
    if (isCasting) {
      if (!castRemotePlayer || !castRemotePlayerController) return;
      castRemotePlayer.currentTime = seconds;
      castRemotePlayerController.seek();
      setCurrentTime(seconds);
      scheduleProgressReport({ positionSeconds: seconds, durationSeconds: castRemotePlayer.duration });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    setCurrentTime(seconds);
    scheduleProgressReport();
  }

  function togglePlay() {
    if (isCasting) {
      castRemotePlayerController?.playOrPause();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  function handleVolumeChange(next: number) {
    const video = videoRef.current;
    setVolume(next);
    if (video) {
      video.volume = next;
      video.muted = next === 0;
    }
    setMuted(next === 0);
  }

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen();
  }

  function requestAirplay() {
    videoRef.current?.webkitShowPlaybackTargetPicker?.();
  }

  function requestCast() {
    if (isCasting) {
      window.cast?.framework.CastContext.getInstance().getCurrentSession()?.endSession(true);
      return;
    }
    window.cast?.framework.CastContext.getInstance().requestSession().catch(() => {});
  }

  // `episodes` is sorted for display, which isn't the same order as
  // `selectedIndex` (an index into the original s3Keys array) - "next" means
  // the next one in display/narrative order, not originalIndex + 1.
  function playNextEpisode() {
    if (!autoplayNext || !hasEpisodes) return;
    const currentPos = episodes.findIndex((ep) => ep.originalIndex === selectedIndex);
    const next = episodes[currentPos + 1];
    if (next) setSelectedIndex(next.originalIndex);
  }

  // Left/Right skip ±10s, Space toggles play/pause. There's no native
  // `controls` bar anymore to defer to, so these are the only handlers for
  // these keys - active whenever an input/textarea doesn't have focus.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;

      if (e.key === "ArrowLeft") {
        skip(-10);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        skip(10);
        e.preventDefault();
      } else if (e.key === " ") {
        togglePlay();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function progressFractionFor(originalIndex: number): number {
    const p = initialProgress.find((entry) => entry.episode === originalIndex + 1);
    if (!p) return 0;
    if (p.finished) return 1;
    if (!p.duration_seconds || p.duration_seconds <= 0) return 0;
    return Math.min(1, p.position_seconds / p.duration_seconds);
  }

  const controlsVisible = showControls || !isPlaying || subtitleMenuOpen;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap">
      <Script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1" strategy="afterInteractive" />
      <div
        ref={containerRef}
        onMouseMove={handleActivity}
        style={customWidth ? { width: customWidth, flex: "none" } : undefined}
        className={`group relative min-w-[240px] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/50 ring-1 ring-white/10 ${
          customWidth ? "" : "max-w-[1600px] lg:min-w-[320px] lg:flex-1"
        }`}
      >
        <video
          ref={videoRef}
          key={`${streamUrl}-${retry}`}
          className="aspect-video w-full"
          poster={effectivePoster}
          onClick={togglePlay}
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onProgress={(e) => updateBuffered(e.currentTarget)}
          onPlay={() => {
            setIsPlaying(true);
            scheduleHideControls();
          }}
          onPause={() => {
            setIsPlaying(false);
            stopHideControls();
            reportProgress(false);
          }}
          onEnded={() => {
            setIsPlaying(false);
            stopHideControls();
            reportProgress(false);
            playNextEpisode();
          }}
          onWaiting={() => setStatus("loading")}
          onPlaying={() => setStatus("ready")}
          onCanPlay={() => setStatus("ready")}
          onError={() => setStatus("error")}
        >
          <source src={streamUrl} type="video/mp4" />
          {episodeSubtitles.map((t) => (
            <track
              key={t.id}
              kind="subtitles"
              src={`/api/subtitles/${id}/${t.id}${hasEpisodes ? `?episode=${episodeNumber}` : ""}`}
              srcLang={BCP47[t.lang] ?? t.lang}
              label={t.label}
            />
          ))}
        </video>

        {status === "loading" && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30"
          >
            <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/15 border-t-[#f5c518]" />
            <span className="animate-pulse text-xs font-medium text-zinc-400">Loading…</span>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center">
            <span aria-hidden className="text-2xl">
              😕
            </span>
            <p className="text-sm text-zinc-300">
              This video isn&apos;t available right now — it may still be processing.
            </p>
            <button
              onClick={() => {
                setStatus("loading");
                setRetry((r) => r + 1);
              }}
              className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/20"
            >
              Try again
            </button>
          </div>
        )}

        {status === "ready" && !isPlaying && !isCasting && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors hover:bg-black/20"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/20 backdrop-blur-sm">
              <PlayIcon className="h-8 w-8 translate-x-0.5" />
            </span>
          </button>
        )}

        {isCasting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
            <CastIcon className="h-10 w-10 text-[#f5c518]" />
            <p className="text-sm text-zinc-300">
              Casting to <span className="font-medium text-white">{castDeviceName ?? "device"}</span>
            </p>
          </div>
        )}

        {status === "ready" && (
          <div
            className={`absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-2.5 pt-8 transition-opacity duration-200 ${
              controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <SeekBar
              currentTime={currentTime}
              duration={duration}
              buffered={buffered}
              streamUrl={streamUrl}
              onSeek={seekTo}
            />

            <div className="flex items-center gap-1.5 text-zinc-200">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white"
              >
                {isPlaying ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
              </button>

              <SkipButton direction="back" onClick={() => skip(-10)} />
              <SkipButton direction="forward" onClick={() => skip(10)} />

              <div className="group/volume flex items-center">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute" : "Mute"}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white"
                >
                  <VolumeIcon muted={muted} className="h-5 w-5" />
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  aria-label="Volume"
                  className="w-0 cursor-pointer opacity-0 transition-all duration-150 group-hover/volume:w-16 group-hover/volume:opacity-100 group-focus-within/volume:w-16 group-focus-within/volume:opacity-100"
                />
              </div>

              <span className="ml-0.5 shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-300">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="flex-1" />

              {episodeSubtitles.length > 0 && (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSubtitleMenuOpen((v) => !v);
                    }}
                    aria-label="Subtitles"
                    className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white ${
                      selectedSubtitleId ? "text-[#f5c518]" : ""
                    }`}
                  >
                    <SubtitlesIcon className="h-5 w-5" />
                  </button>
                  {subtitleMenuOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-full right-0 mb-2 w-48 overflow-hidden rounded-lg bg-zinc-900/95 py-1 shadow-xl ring-1 ring-white/10 backdrop-blur-sm"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSubtitleId(null);
                          setSubtitleMenuOpen(false);
                        }}
                        className={`block w-full px-3 py-2 text-left text-sm ${
                          selectedSubtitleId === null
                            ? "bg-white/10 font-medium text-white"
                            : "text-zinc-300 hover:bg-white/5"
                        }`}
                      >
                        Off
                      </button>
                      {episodeSubtitles.map((t) => (
                        <button
                          type="button"
                          key={t.id}
                          onClick={() => {
                            setSelectedSubtitleId(t.id);
                            setSubtitleMenuOpen(false);
                          }}
                          className={`block w-full truncate px-3 py-2 text-left text-sm ${
                            selectedSubtitleId === t.id
                              ? "bg-white/10 font-medium text-white"
                              : "text-zinc-300 hover:bg-white/5"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {airplayAvailable && (
                <button
                  type="button"
                  onClick={requestAirplay}
                  aria-label="AirPlay"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white"
                >
                  <AirPlayIcon className="h-5 w-5" />
                </button>
              )}

              {castAvailable && (
                <button
                  type="button"
                  onClick={requestCast}
                  aria-label={isCasting ? "Stop casting" : "Cast"}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white ${
                    isCasting ? "text-[#f5c518]" : ""
                  }`}
                >
                  <CastIcon className="h-5 w-5" />
                </button>
              )}

              {/* Drag to resize - docked at the actual bottom-right of the
                  UI, in the control row itself, rather than floating over
                  the video. Desktop-only (`lg:`): there's no pointer to
                  drag with on a touch-only viewport. */}
              <div
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerUp}
                role="separator"
                aria-label="Resize player"
                aria-orientation="vertical"
                className="hidden h-9 w-9 shrink-0 cursor-ew-resize touch-none items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white lg:flex"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                  <path d="M10 3L3 10M13 6L6 13" />
                </svg>
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10 hover:text-white"
              >
                <FullscreenIcon isFullscreen={isFullscreen} className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {hasEpisodes && (
        <div className="flex max-h-80 flex-col overflow-hidden rounded-2xl bg-zinc-950/60 shadow-xl shadow-black/30 ring-1 ring-white/10 lg:max-h-[28rem] lg:w-72 lg:shrink-0">
          <div className="shrink-0 border-b border-white/10 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Episodes · {episodes.length}
          </div>
          <div className="overflow-y-auto">
            {episodes.map((ep) => {
              const isActive = selectedIndex === ep.originalIndex;
              const fraction = progressFractionFor(ep.originalIndex);
              return (
                <button
                  key={ep.key}
                  onClick={() => setSelectedIndex(ep.originalIndex)}
                  className={`relative flex w-full items-start gap-3 border-b border-white/5 py-2.5 pr-4 text-left transition-colors last:border-b-0 ${
                    isActive
                      ? "border-l-2 border-l-[#f5c518] bg-white/10 pl-3.5"
                      : "border-l-2 border-l-transparent pl-3.5 hover:bg-white/5"
                  }`}
                >
                  {ep.stillUrl ? (
                    <span className="relative h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-black/40 ring-1 ring-white/5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ep.stillUrl} alt="" className="h-full w-full object-cover" />
                      {isActive && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-[#f5c518]">
                          ▶
                        </span>
                      )}
                    </span>
                  ) : (
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                        isActive ? "bg-[#f5c518] text-black" : "bg-white/10 text-zinc-400"
                      }`}
                    >
                      {isActive ? "▶" : ep.number}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${
                        isActive ? "font-medium text-white" : "text-zinc-300"
                      }`}
                    >
                      {ep.number}. {ep.title}
                    </span>
                    {ep.overview && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">
                        {ep.overview}
                      </span>
                    )}
                  </span>
                  {fraction > 0 && (
                    <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10">
                      <div
                        className="h-full bg-[#f5c518]"
                        style={{ width: `${Math.round(fraction * 100)}%` }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
