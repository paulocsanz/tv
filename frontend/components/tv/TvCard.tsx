"use client";

import Link from "next/link";
import { posterSrc, type ContentItem } from "@/lib/types";
import { tvFocusClass } from "./FocusRow";

export function TvCard({
  item,
  href,
  progress,
  autoFocus,
}: {
  item: Pick<ContentItem, "id" | "title" | "year" | "poster_url" | "poster_s3_key" | "content_type">;
  href: string;
  progress?: number;
  autoFocus?: boolean;
}) {
  const poster = posterSrc(item as ContentItem);

  return (
    <Link
      href={href}
      data-tv-focus
      tabIndex={0}
      autoFocus={autoFocus}
      className={tvFocusClass(
        "group relative w-40 shrink-0 overflow-hidden rounded-xl bg-zinc-900 sm:w-44",
      )}
    >
      <div className="aspect-[2/3] w-full bg-zinc-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-500">
            {item.title}
          </div>
        )}
      </div>
      {progress != null && progress > 0 && progress < 1 && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
          <div className="h-full bg-[#f5c518]" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="truncate px-2 py-2 text-sm text-zinc-200 group-focus-visible:text-white">
        {item.title}
      </div>
    </Link>
  );
}
