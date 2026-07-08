import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getContentById, getProgress, getRelatedContent, getSimilarContent } from "@/lib/api";
import { ImdbBadge, RottenTomatoesBadge } from "@/components/RatingBadges";
import { PosterPlaceholder } from "@/components/ContentCard";
import { RelatedTitleCard } from "@/components/RelatedTitleCard";
import { VideoPlayer } from "@/components/VideoPlayer";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const item = await getContentById(id);
  if (!item) return { title: "Not found" };
  return {
    title: `${item.title} (${item.year})`,
    description: item.plot ?? undefined,
  };
}

export default async function TitlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await getContentById(id);
  if (!item) notFound();

  const related = item.collection_id ? await getRelatedContent(id) : [];
  const similar = await getSimilarContent(id);

  const backdrop = item.backdrop_url;

  return (
    <div>
      <div className="relative h-[40vh] min-h-[260px] w-full overflow-hidden">
        {backdrop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={backdrop}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 to-black" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/30" />
      </div>

      <div className="mx-auto -mt-32 max-w-5xl px-4 pb-16 sm:-mt-40 sm:px-8">
        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="relative aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-lg bg-zinc-900 shadow-2xl ring-1 ring-white/10 sm:w-56">
            {item.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.poster_url} alt={item.title} className="h-full w-full object-cover" />
            ) : (
              <PosterPlaceholder title={item.title} />
            )}
          </div>

          <div className="flex flex-1 flex-col justify-end gap-3 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-zinc-300">
                {item.content_type === "movie" ? "Movie" : "TV Series"}
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-300">
                {item.origin}
              </span>
              {item.rated && (
                <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-300">
                  {item.rated}
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">{item.title}</h1>
            {item.original_title && (
              <p className="text-sm italic text-zinc-500">{item.original_title}</p>
            )}
            <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-400">
              <span>{item.year}</span>
              {item.runtime && <span>· {item.runtime}</span>}
              {item.genres.length > 0 && <span>· {item.genres.join(", ")}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ImdbBadge item={item} size="lg" />
              <RottenTomatoesBadge item={item} size="lg" />
              {item.metacritic && (
                <span className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-sm font-semibold text-zinc-100 ring-1 ring-inset ring-white/10">
                  Metacritic {item.metacritic}
                </span>
              )}
            </div>
            {(item.director || item.creator) && (
              <p className="text-sm text-zinc-400">
                <span className="text-zinc-500">
                  {item.content_type === "movie" ? "Director: " : "Creator: "}
                </span>
                {item.director ?? item.creator}
              </p>
            )}
          </div>
        </div>

        {item.plot && (
          <p className="mt-8 max-w-3xl text-base leading-relaxed text-zinc-300">{item.plot}</p>
        )}

        {item.actors.length > 0 && (
          <p className="mt-4 text-sm text-zinc-400">
            <span className="text-zinc-500">Starring: </span>
            {item.actors.join(", ")}
          </p>
        )}

        {item.awards && (
          <p className="mt-4 text-sm text-zinc-400">
            <span className="text-zinc-500">Awards: </span>
            {item.awards}
          </p>
        )}

        {item.keywords.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {item.keywords.slice(0, 8).map((keyword) => (
              <Link
                key={keyword}
                href={`/browse?keyword=${encodeURIComponent(keyword)}`}
                className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-inset ring-white/10 hover:bg-white/10 hover:text-zinc-200"
              >
                {keyword}
              </Link>
            ))}
          </div>
        )}

        {related.length > 0 && (
          <div className="mt-10">
            <h2 className="mb-3 text-lg font-semibold text-white">
              {item.collection_name ?? "Related Titles"}
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {related.map((title) => (
                <RelatedTitleCard key={title.tmdb_id} title={title} current={title.id === item.id} />
              ))}
            </div>
          </div>
        )}

        {similar.length > 0 && (
          <div className="mt-10">
            <h2 className="mb-3 text-lg font-semibold text-white">More Like This</h2>
            <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {similar.map((title) => (
                <RelatedTitleCard key={title.tmdb_id} title={title} />
              ))}
            </div>
          </div>
        )}

        {item.s3_key || item.s3_keys.length > 0 ? (
          <div id="video-player" className="mt-10 scroll-mt-24">
            <h2 className="mb-3 text-lg font-semibold text-white">Watch</h2>
            <VideoPlayer
              id={item.id}
              s3Keys={item.s3_keys.length > 0 ? item.s3_keys : [item.s3_key!]}
              initialProgress={await getProgress(item.id)}
              subtitles={item.subtitles}
              episodeMetadata={item.episodes}
            />
          </div>
        ) : item.torrent_file ? (
          <p className="mt-4 inline-block rounded-lg bg-amber-600/20 px-3 py-1.5 text-sm text-amber-300">
            📥 Available locally: <code className="text-xs font-mono">{item.torrent_file}</code>
          </p>
        ) : null}

        {item.trailer_key && (
          <div id="trailer" className="mt-10 scroll-mt-24">
            <h2 className="mb-3 text-lg font-semibold text-white">Trailer</h2>
            <div className="aspect-video w-full max-w-3xl overflow-hidden rounded-lg bg-zinc-900">
              <iframe
                className="h-full w-full"
                src={`https://www.youtube.com/embed/${item.trailer_key}`}
                title={`${item.title} trailer`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>
        )}

        <div className="mt-10 flex flex-wrap gap-4 text-xs text-zinc-600">
          {item.imdb_id && (
            <a
              href={`https://www.imdb.com/title/${item.imdb_id}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-400"
            >
              View on IMDb ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
