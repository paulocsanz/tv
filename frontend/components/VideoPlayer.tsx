"use client";

import { useEffect, useRef, useState } from "react";
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

type Status = "loading" | "ready" | "error";

const REPORT_INTERVAL_MS = 10_000;

export function VideoPlayer({
  id,
  s3Keys,
  initialProgress,
  subtitles,
  episodeMetadata = [],
  preferredSubtitleLang = null,
  autoplayNext = true,
}: {
  id: string;
  s3Keys: string[];
  initialProgress: ProgressEntry[];
  subtitles: SubtitleTrack[];
  episodeMetadata?: EpisodeMetadata[];
  preferredSubtitleLang?: string | null;
  autoplayNext?: boolean;
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
  const streamUrl = hasEpisodes
    ? `/api/stream/${id}?episode=${selectedIndex + 1}`
    : `/api/stream/${id}`;
  const progressUrl = `/api/progress/${id}`;
  // 0 is the movie/no-episode sentinel, matching the backend schema.
  const episodeNumber = hasEpisodes ? selectedIndex + 1 : 0;
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [seeked, setSeeked] = useState(false);

  // Reset to "loading" whenever the source changes, without an effect (which
  // would run after a stale-status frame paints first) - this is React's
  // documented pattern for adjusting state during render.
  const [trackedUrl, setTrackedUrl] = useState(streamUrl);
  if (streamUrl !== trackedUrl) {
    setTrackedUrl(streamUrl);
    setStatus("loading");
    setSeeked(false);
  }

  function reportProgress(useBeacon: boolean) {
    const video = videoRef.current;
    if (!video || !video.duration || Number.isNaN(video.duration)) return;

    const payload = JSON.stringify({
      episode: episodeNumber,
      position_seconds: video.currentTime,
      duration_seconds: video.duration,
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

  // Throttled reporting while actually playing; torn down on pause/episode
  // change via the effect cleanup, not left to drift across remounts.
  useEffect(() => {
    if (!isPlaying) return;
    const intervalId = window.setInterval(() => reportProgress(false), REPORT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, streamUrl]);

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

  function handleLoadedMetadata() {
    const video = videoRef.current;
    // Seeding currentTime only works once metadata has loaded - setting it
    // right after the initial fetch resolves is commonly ignored by the
    // browser.
    if (video && savedProgress && !savedProgress.finished && !seeked) {
      video.currentTime = savedProgress.position_seconds;
    }
    setSeeked(true);
  }

  function skip(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const duration = video.duration || Infinity;
    video.currentTime = Math.min(duration, Math.max(0, video.currentTime + deltaSeconds));
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

  // Left/Right skip ±10s, Space toggles play/pause - but only when the
  // video element itself doesn't already have focus. Browsers bind their
  // own versions of these same shortcuts to a focused <video>, and we can't
  // reliably suppress that native handling, so deferring to it there avoids
  // double-seeking; this still covers the common case of the page (not the
  // video specifically) having focus.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (document.activeElement === videoRef.current) return;

      if (e.key === "ArrowLeft") {
        skip(-10);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        skip(10);
        e.preventDefault();
      } else if (e.key === " ") {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) video.play();
        else video.pause();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function progressFractionFor(originalIndex: number): number {
    const p = initialProgress.find((entry) => entry.episode === originalIndex + 1);
    if (!p) return 0;
    if (p.finished) return 1;
    if (!p.duration_seconds || p.duration_seconds <= 0) return 0;
    return Math.min(1, p.position_seconds / p.duration_seconds);
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="relative overflow-hidden rounded-lg bg-black lg:min-w-0 lg:flex-1">
        <video
          ref={videoRef}
          key={`${streamUrl}-${retry}`}
          className="aspect-video w-full"
          controls
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            reportProgress(false);
          }}
          onEnded={() => {
            setIsPlaying(false);
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
              default={t.id === defaultSubtitleId}
            />
          ))}
        </video>

        {status === "loading" && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center">
            <p className="text-sm text-zinc-300">
              This video isn&apos;t available right now — it may still be processing.
            </p>
            <button
              onClick={() => {
                setStatus("loading");
                setRetry((r) => r + 1);
              }}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/20"
            >
              Try again
            </button>
          </div>
        )}

        {status === "ready" && (
          <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => skip(-10)}
              aria-label="Skip back 10 seconds"
              className="pointer-events-auto rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur-sm hover:bg-black/80"
            >
              ◀ 10
            </button>
            <button
              type="button"
              onClick={() => skip(10)}
              aria-label="Skip forward 10 seconds"
              className="pointer-events-auto rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur-sm hover:bg-black/80"
            >
              10 ▶
            </button>
          </div>
        )}
      </div>

      {hasEpisodes && (
        <div className="flex max-h-80 flex-col overflow-hidden rounded-lg ring-1 ring-white/10 lg:max-h-[28rem] lg:w-72 lg:shrink-0">
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
                  className={`relative flex w-full items-start gap-3 border-b border-white/5 px-4 py-2.5 text-left last:border-b-0 ${
                    isActive ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {ep.stillUrl ? (
                    <span className="relative h-10 w-16 shrink-0 overflow-hidden rounded bg-black/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ep.stillUrl} alt="" className="h-full w-full object-cover" />
                      {isActive && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">
                          ▶
                        </span>
                      )}
                    </span>
                  ) : (
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-medium ${
                        isActive ? "bg-white text-black" : "bg-white/10 text-zinc-400"
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
