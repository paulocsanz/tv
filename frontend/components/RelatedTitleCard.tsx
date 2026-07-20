import Link from "next/link";
import { RelatedTitle } from "@/lib/types";
import { PosterPlaceholder } from "./ContentCard";
import { StarIcon } from "./RatingBadges";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

// Used by the "Sequels & Prequels" and "More Like This" rows, which - unlike
// every other poster grid in the app - can include titles TMDB knows about
// that aren't in the library. Those have no `id` and nothing to stream, so
// they render dimmed and link out to TMDB instead of a local title page.
// Note: `title.title` itself isn't localized here (this comes from TMDB's
// collection/recommendation endpoints as plain English, not the enriched
// catalog's title_pt) - a smaller, secondary display where that's an
// acceptable gap for now.
export async function RelatedTitleCard({
  title,
  current = false,
}: {
  title: RelatedTitle;
  current?: boolean;
}) {
  const t = getDictionary(await getLocale());
  const inLibrary = title.id !== null;
  const poster = (
    <div
      className={`relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-zinc-900 transition-transform duration-200 ease-out group-hover:-translate-y-1 ${
        current
          ? "ring-2 ring-[#f5c518]"
          : inLibrary
            ? "ring-1 ring-white/5 group-hover:ring-white/20"
            : "opacity-60 ring-1 ring-white/5 group-hover:opacity-80"
      }`}
    >
      {title.poster_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={title.poster_url}
          alt={title.title}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <PosterPlaceholder title={title.title} />
      )}
      <div className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-200 backdrop-blur-sm">
        {title.content_type === "movie" ? t.contentType.movie : t.contentType.tv}
      </div>
      {!inLibrary && (
        <div className="absolute bottom-1.5 left-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-center text-[10px] font-medium text-zinc-300 backdrop-blur-sm">
          {t.related.notInLibrary}
        </div>
      )}
    </div>
  );

  const info = (
    <div className="mt-2 space-y-1">
      <h3 className="line-clamp-1 text-sm font-medium text-zinc-100 group-hover:text-white">
        {title.title}
      </h3>
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">{title.year ?? ""}</span>
        {title.rating != null && (
          <span className="inline-flex items-center gap-1 rounded-md bg-[#f5c518] px-1.5 py-0.5 text-xs font-semibold text-black">
            <StarIcon />
            {title.rating.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );

  if (inLibrary) {
    return (
      <Link href={`/title/${title.id}`} className="group block w-40 shrink-0 sm:w-44">
        {poster}
        {info}
      </Link>
    );
  }

  return (
    <a
      href={`https://www.themoviedb.org/${title.content_type === "movie" ? "movie" : "tv"}/${title.tmdb_id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group block w-40 shrink-0 sm:w-44"
    >
      {poster}
      {info}
    </a>
  );
}
