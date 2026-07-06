"use client";

import { useEffect, useRef, useState } from "react";
import type { ProgressEntry } from "@/lib/types";

type Episode = {
  key: string;
  /** 1-based index into the original s3Keys array — what the backend expects. */
  originalIndex: number;
  number: number;
  title: string;
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
}: {
  id: string;
  s3Keys: string[];
  initialProgress: ProgressEntry[];
}) {
  const hasEpisodes = s3Keys.length > 1;
  // s3Keys isn't guaranteed to be in episode order; sort a copy for display
  // while keeping each episode's original index for the stream request,
  // since the backend indexes into s3Keys as stored.
  const episodes = hasEpisodes
    ? s3Keys.map(parseEpisode).sort((a, b) => a.number - b.number)
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
          }}
          onWaiting={() => setStatus("loading")}
          onPlaying={() => setStatus("ready")}
          onCanPlay={() => setStatus("ready")}
          onError={() => setStatus("error")}
        >
          <source src={streamUrl} type="video/mp4" />
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
      </div>

      {hasEpisodes && (
        <div className="flex max-h-80 flex-col overflow-hidden rounded-lg ring-1 ring-white/10 lg:max-h-[28rem] lg:w-72 lg:shrink-0">
          <div className="shrink-0 border-b border-white/10 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Episodes · {episodes.length}
          </div>
          <div className="overflow-y-auto">
            {episodes.map((ep) => {
              const isActive = selectedIndex === ep.originalIndex;
              return (
                <button
                  key={ep.key}
                  onClick={() => setSelectedIndex(ep.originalIndex)}
                  className={`flex w-full items-center gap-3 border-b border-white/5 px-4 py-2.5 text-left last:border-b-0 ${
                    isActive ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-medium ${
                      isActive ? "bg-white text-black" : "bg-white/10 text-zinc-400"
                    }`}
                  >
                    {isActive ? "▶" : ep.number}
                  </span>
                  <span
                    className={`truncate text-sm ${
                      isActive ? "font-medium text-white" : "text-zinc-300"
                    }`}
                  >
                    {ep.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
