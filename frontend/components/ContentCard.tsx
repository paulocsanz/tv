import Link from "next/link";
import { ContentItem, posterSrc } from "@/lib/types";
import { RatingRow } from "./RatingBadges";

export function PosterPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950 p-3 text-center">
      <span className="text-sm font-medium leading-snug text-zinc-400">{title}</span>
    </div>
  );
}

export function ContentCard({
  item,
  fluid = false,
  progressFraction,
}: {
  item: ContentItem;
  fluid?: boolean;
  progressFraction?: number;
}) {
  const poster = posterSrc(item);
  return (
    <Link
      href={`/title/${item.id}`}
      className={`group block ${fluid ? "w-full" : "w-40 shrink-0 sm:w-44"}`}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/5 transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:ring-white/20">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <PosterPlaceholder title={item.title} />
        )}
        <div className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-200 backdrop-blur-sm">
          {item.content_type === "movie" ? "Movie" : item.content_type === "tv" ? "TV" : "Course"}
        </div>
        {item.origin === "Brazilian" && (
          <div className="absolute right-1.5 top-1.5 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            BR
          </div>
        )}
        {item.torrent_file && (
          <div className="absolute bottom-1.5 right-1.5 rounded bg-amber-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            📥
          </div>
        )}
        {typeof progressFraction === "number" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div
              className="h-full bg-[#f5c518]"
              style={{ width: `${Math.round(progressFraction * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1">
        <h3 className="line-clamp-1 text-sm font-medium text-zinc-100 group-hover:text-white">
          {item.title}
        </h3>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">{item.year}</span>
          <RatingRow item={item} />
        </div>
      </div>
    </Link>
  );
}
