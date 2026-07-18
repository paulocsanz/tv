import Link from "next/link";
import { ContentItem, posterSrc } from "@/lib/types";
import { RatingRow } from "./RatingBadges";

export function Hero({ item }: { item: ContentItem }) {
  const backdrop = item.backdrop_url ?? posterSrc(item);

  return (
    <div className="relative h-[40vh] min-h-[300px] w-full overflow-hidden sm:h-[45vh] md:h-[50vh] lg:h-[55vh]">
      {backdrop && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

      <div className="relative flex h-full flex-col justify-end gap-4 px-4 pb-10 sm:px-8 sm:pb-14">
        <h1 className="max-w-2xl text-3xl font-bold text-white drop-shadow sm:text-5xl">
          {item.title}
        </h1>
        <div className="flex items-center gap-3 text-sm text-zinc-300">
          <span>{item.year}</span>
          {item.runtime && <span>· {item.runtime}</span>}
          {item.genres.length > 0 && <span>· {item.genres.slice(0, 3).join(", ")}</span>}
        </div>
        <RatingRow item={item} size="lg" />
        {item.plot && (
          <p className="max-w-xl text-sm text-zinc-300 line-clamp-3 sm:text-base">{item.plot}</p>
        )}
        <div className="flex gap-3 pt-2">
          <Link
            href={`/title/${item.id}`}
            className="rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
          >
            View Details
          </Link>
          {item.trailer_key && (
            <Link
              href={`/title/${item.id}#trailer`}
              className="rounded-md bg-white/10 px-5 py-2.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/20 transition hover:bg-white/20"
            >
              ▶ Watch Trailer
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
