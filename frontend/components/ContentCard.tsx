import Link from "next/link";
import { ContentItem, isStreamable, posterSrc } from "@/lib/types";
import { RatingRow } from "./RatingBadges";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { localizeItem } from "@/lib/i18n/content";

export function PosterPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950 p-3 text-center">
      <span className="text-sm font-medium leading-snug text-zinc-400">{title}</span>
    </div>
  );
}

export async function ContentCard({
  item: rawItem,
  fluid = false,
  progressFraction,
}: {
  item: ContentItem;
  fluid?: boolean;
  progressFraction?: number;
}) {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const item = localizeItem(rawItem, locale);
  const poster = posterSrc(item);
  const streamable = isStreamable(item);
  return (
    <Link
      href={`/title/${item.id}`}
      aria-label={
        streamable
          ? item.title
          : `${item.title} — ${t.contentCard.unavailable}`
      }
      className={`group block ${fluid ? "w-full" : "w-40 shrink-0 sm:w-44"} ${
        streamable ? "" : "opacity-70"
      }`}
    >
      <div
        className={`relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/5 ${
          streamable
            ? "transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:ring-white/20"
            : "ring-white/5"
        }`}
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={item.title}
            loading="lazy"
            className={`h-full w-full object-cover ${streamable ? "" : "grayscale-[40%]"}`}
          />
        ) : (
          <PosterPlaceholder title={item.title} />
        )}
        {!streamable && (
          <div className="absolute inset-0 bg-black/45" aria-hidden />
        )}
        <div className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-200 backdrop-blur-sm">
          {item.content_type === "movie"
            ? t.contentType.movie
            : item.content_type === "tv"
              ? t.contentType.tv
              : t.contentType.course}
        </div>
        {item.origin === "Brazilian" && (
          <div className="absolute right-1.5 top-1.5 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            BR
          </div>
        )}
        {!streamable ? (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 rounded bg-zinc-950/90 px-1.5 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-200 ring-1 ring-white/10 backdrop-blur-sm">
            {t.contentCard.unavailable}
          </div>
        ) : item.torrent_file ? (
          <div className="absolute bottom-1.5 right-1.5 rounded bg-amber-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            📥
          </div>
        ) : null}
        {typeof progressFraction === "number" && streamable && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div
              className="h-full bg-[#f5c518]"
              style={{ width: `${Math.round(progressFraction * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1">
        <h3
          className={`line-clamp-1 text-sm font-medium ${
            streamable
              ? "text-zinc-100 group-hover:text-white"
              : "text-zinc-400"
          }`}
        >
          {item.title}
        </h3>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">{item.year}</span>
          {streamable ? (
            <RatingRow item={item} />
          ) : (
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              {t.contentCard.unavailable}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
