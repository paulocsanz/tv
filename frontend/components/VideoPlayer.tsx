"use client";

import { useState } from "react";

function episodeLabel(s3Key: string, index: number): string {
  const filename = s3Key.split("/").pop() ?? s3Key;
  const withoutExt = filename.replace(/\.[^./]+$/, "");
  const match = withoutExt.match(/^Ep\s*\d+\s*-\s*([^-]+)/i);
  return match ? `${index + 1}. ${match[1].trim()}` : `Episode ${index + 1}`;
}

type Status = "loading" | "ready" | "error";

export function VideoPlayer({ id, s3Keys }: { id: string; s3Keys: string[] }) {
  const [episode, setEpisode] = useState(1);
  const [status, setStatus] = useState<Status>("loading");
  const [retry, setRetry] = useState(0);
  const hasEpisodes = s3Keys.length > 1;
  const streamUrl = hasEpisodes ? `/api/stream/${id}?episode=${episode}` : `/api/stream/${id}`;

  // Reset to "loading" whenever the source changes, without an effect (which
  // would run after a stale-status frame paints first) - this is React's
  // documented pattern for adjusting state during render.
  const [trackedUrl, setTrackedUrl] = useState(streamUrl);
  if (streamUrl !== trackedUrl) {
    setTrackedUrl(streamUrl);
    setStatus("loading");
  }

  return (
    <div>
      {hasEpisodes && (
        <div className="mb-3 flex flex-wrap gap-2">
          {s3Keys.map((key, i) => (
            <button
              key={key}
              onClick={() => setEpisode(i + 1)}
              className={`rounded-md px-3 py-1.5 text-sm ring-1 ring-inset ring-white/10 ${
                episode === i + 1
                  ? "bg-white text-black"
                  : "bg-white/10 text-zinc-200 hover:bg-white/20"
              }`}
            >
              {episodeLabel(key, i)}
            </button>
          ))}
        </div>
      )}
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        <video
          key={`${streamUrl}-${retry}`}
          className="aspect-video w-full"
          controls
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
    </div>
  );
}
