import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getContentById, getMeOrNull, getProgress, getRelatedContent, getSimilarContent } from "@/lib/api";
import { ImdbBadge, RottenTomatoesBadge } from "@/components/RatingBadges";
import { PosterPlaceholder } from "@/components/ContentCard";
import { RelatedTitleCard } from "@/components/RelatedTitleCard";
import { VideoPlayer } from "@/components/VideoPlayer";
import { TrailerPreview } from "@/components/TrailerPreview";
import { Synopsis } from "@/components/Synopsis";
import { AwardsCard } from "@/components/AwardsCard";

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
  const me = await getMeOrNull();

  const heroImage = item.backdrop_url ?? item.poster_url;
  const hasStream = Boolean(item.s3_key || item.s3_keys.length > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-8">
      {/* Hero row: the video (or its poster art, unplayable) is the primary
          visual - no separate static cover competing with it for space -
          alongside a compact facts sidebar, so both are visible together on
          wider screens instead of everything stacking one block per row. */}
      <div className="flex flex-col gap-6 xl:flex-row xl:flex-wrap xl:items-start">
        <div className="min-w-0 flex-1">
          {/* The player itself is resizable (drag its top-right handle) -
              flex-wrap above means the info sidebar drops below instead of
              overlapping if it's resized wider than the space they'd
              normally share. */}
          {hasStream ? (
            <VideoPlayer
              id={item.id}
              s3Keys={item.s3_keys.length > 0 ? item.s3_keys : [item.s3_key!]}
              initialProgress={await getProgress(item.id)}
              subtitles={item.subtitles}
              episodeMetadata={item.episodes}
              preferredSubtitleLang={me?.default_subtitle_lang ?? null}
              autoplayNext={me?.autoplay_next ?? true}
              posterUrl={heroImage}
            />
          ) : (
            <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-zinc-900 shadow-2xl shadow-black/50 ring-1 ring-white/10">
              {heroImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={heroImage} alt="" className="h-full w-full object-cover" />
              ) : (
                <PosterPlaceholder title={item.title} />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
                {item.torrent_file ? (
                  <p className="rounded-lg bg-amber-600/20 px-3 py-1.5 text-sm text-amber-300">
                    📥 Available locally: <code className="text-xs font-mono">{item.torrent_file}</code>
                  </p>
                ) : (
                  <p className="text-sm text-zinc-300">
                    Not available to stream yet — it&apos;s still in the acquisition queue.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 xl:w-80 xl:shrink-0">
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
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{item.title}</h1>
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
          {item.trailer_key && (
            <TrailerPreview trailerKey={item.trailer_key} title={item.title} className="w-full" />
          )}
          {/* Awards + keywords live in the sidebar rather than stacked below
              the video - the sidebar already has empty space next to the
              (usually taller) player, so this uses it instead of adding
              more vertical scroll under the fold. */}
          <AwardsCard awards={item.awards} awardEntries={item.award_entries ?? []} />
          {item.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
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
        </div>
      </div>

      <Synopsis plot={item.plot} actors={item.actors} />

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
  );
}
