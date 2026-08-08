"use client";

import Link from "next/link";
import { isStreamable, posterSrc, type ContentItem } from "@/lib/types";
import { tvFocusClass } from "./FocusRow";

export function TvCard({
  item,
  href,
  progress,
  autoFocus,
  unavailableLabel = "Indisponível",
}: {
  item: Pick<
    ContentItem,
    | "id"
    | "title"
    | "year"
    | "poster_url"
    | "poster_s3_key"
    | "content_type"
    | "s3_key"
    | "s3_keys"
    | "hls_playlist_s3_key"
  >;
  href: string;
  progress?: number;
  autoFocus?: boolean;
  unavailableLabel?: string;
}) {
  const poster = posterSrc(item as ContentItem);
  const streamable = isStreamable(item as ContentItem);

  return (
    <Link
      href={href}
      data-tv-focus
      tabIndex={0}
      autoFocus={autoFocus}
      aria-label={
        streamable ? item.title : `${item.title} — ${unavailableLabel}`
      }
      className={tvFocusClass(
        `group relative w-40 shrink-0 overflow-hidden rounded-xl bg-zinc-900 sm:w-44 ${
          streamable ? "" : "opacity-70"
        }`,
      )}
    >
      <div className="relative aspect-[2/3] w-full bg-zinc-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt=""
            className={`h-full w-full object-cover ${streamable ? "" : "grayscale-[40%]"}`}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-500">
            {item.title}
          </div>
        )}
        {!streamable && (
          <>
            <div className="absolute inset-0 bg-black/45" aria-hidden />
            <div className="absolute bottom-1.5 left-1.5 right-1.5 rounded bg-zinc-950/90 px-1.5 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-200 ring-1 ring-white/10">
              {unavailableLabel}
            </div>
          </>
        )}
      </div>
      {progress != null && progress > 0 && progress < 1 && streamable && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
          <div className="h-full bg-[#f5c518]" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div
        className={`truncate px-2 py-2 text-sm group-focus-visible:text-white ${
          streamable ? "text-zinc-200" : "text-zinc-500"
        }`}
      >
        {item.title}
      </div>
    </Link>
  );
}
