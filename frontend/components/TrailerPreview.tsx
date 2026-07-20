"use client";

import { useEffect, useState } from "react";
import type { SubtitleTrack } from "@/lib/types";
import { useT } from "@/lib/i18n/LocaleProvider";

// Same 3-letter -> 2-letter mapping VideoPlayer.tsx uses for <track srcLang>
// - trimmed to just what download-trailers.js ever actually requests
// (en/pt), not the full catalog-wide language list.
const BCP47: Record<string, string> = { eng: "en", por: "pt" };

// Small click-to-expand trailer thumbnail instead of an always-embedded
// iframe - a full-size trailer competes with the main video for attention
// and pushes everything else down the page. Collapsed by default; opens a
// modal on click.
export function TrailerPreview({
  id,
  trailerKey,
  trailerS3Key,
  trailerSubtitles = [],
  title,
  posterUrl,
  className = "",
}: {
  id: string;
  trailerKey: string;
  trailerS3Key?: string | null;
  trailerSubtitles?: SubtitleTrack[];
  title: string;
  posterUrl?: string | null;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // The homepage Hero's "▶ Watch Trailer" button links to /title/[id]#trailer
  // expecting the trailer to actually play, not just scroll to a thumbnail -
  // auto-open the modal in that case so that entry point still works the way
  // it looks like it should.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.location.hash === "#trailer") setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <button
        id="trailer"
        type="button"
        onClick={() => setOpen(true)}
        className={`group relative shrink-0 scroll-mt-24 overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/10 transition hover:ring-white/25 ${className || "w-28 sm:w-36"}`}
        aria-label={t.trailer.playFor.replace("{title}", title)}
      >
        <span className="relative block aspect-video w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={posterUrl || `https://img.youtube.com/vi/${trailerKey}/mqdefault.jpg`}
            alt=""
            className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/10">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-xs text-white backdrop-blur-sm transition-transform group-hover:scale-110">
              ▶
            </span>
          </span>
        </span>
        <span className="block truncate px-1.5 py-1 text-left text-[11px] font-medium text-zinc-400 group-hover:text-zinc-200">
          {t.trailer.label}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            // resize-x: drag the right/bottom-right edge to make the modal
            // bigger or smaller. Height isn't independently resizable - the
            // video area below stays `aspect-video`, so it always matches
            // whatever width the box is dragged to instead of ending up
            // stretched or letterboxed.
            className="w-[min(90vw,48rem)] min-w-[280px] max-w-[min(95vw,160vh)] resize-x overflow-hidden rounded-lg bg-zinc-950 shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="truncate text-sm font-medium text-zinc-300">
                {title} — {t.trailer.label}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.trailer.close}
                className="shrink-0 rounded-full p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="aspect-video w-full bg-black">
              {trailerS3Key ? (
                // Self-hosted: a plain <video>, same as the main player -
                // sidesteps YouTube's client-side regional licensing
                // entirely, since this streams from our own bucket.
                <video className="h-full w-full" controls autoPlay>
                  <source src={`/api/trailer-stream/${id}`} type="video/mp4" />
                  {trailerSubtitles.map((t) => (
                    <track
                      key={t.id}
                      kind="subtitles"
                      src={`/api/trailer-subtitles/${id}/${t.id}`}
                      srcLang={BCP47[t.lang] ?? t.lang}
                      label={t.label}
                    />
                  ))}
                </video>
              ) : (
                <iframe
                  className="h-full w-full"
                  src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1`}
                  title={t.trailer.iframeTitle.replace("{title}", title)}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
