import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  getContentById,
  getMeOrNull,
  getProgress,
} from "@/lib/api";
import { posterSrc } from "@/lib/types";
import { VideoPlayer } from "@/components/VideoPlayer";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { localizeItem } from "@/lib/i18n/content";

export const dynamic = "force-dynamic";

export default async function TvTitlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getMeOrNull();
  if (!me) redirect("/tv");

  const { id } = await params;
  const raw = await getContentById(id);
  if (!raw) notFound();

  const locale = await getLocale();
  const t = getDictionary(locale);
  const item = localizeItem(raw, locale);
  const heroImage = item.backdrop_url ?? posterSrc(item);
  const hasStream = Boolean(item.s3_key || item.s3_keys.length > 0);

  return (
    <div className="px-8 pb-16">
      <div className="mb-6 flex items-center gap-4">
        <Link
          href="/tv/home"
          data-tv-focus
          tabIndex={0}
          className="rounded-full bg-white/10 px-5 py-2 text-sm outline-none focus-visible:ring-4 focus-visible:ring-[#f5c518]"
        >
          ← {t.common.goHome}
        </Link>
        <h1 className="text-2xl font-bold">{item.title}</h1>
        <span className="text-zinc-500">{item.year}</span>
      </div>

      {hasStream ? (
        <VideoPlayer
          id={item.id}
          title={item.title}
          s3Keys={item.s3_keys.length > 0 ? item.s3_keys : [item.s3_key!]}
          initialProgress={await getProgress(item.id)}
          subtitles={item.subtitles}
          episodeMetadata={item.episodes}
          preferredSubtitleLang={me.default_subtitle_lang ?? null}
          autoplayNext={me.autoplay_next ?? true}
          posterUrl={heroImage}
          numberedTitles={item.content_type === "course"}
          encrypted={Boolean(item.encrypted)}
        />
      ) : (
        <div className="flex aspect-video max-h-[70vh] items-center justify-center rounded-2xl bg-zinc-900 text-zinc-400">
          {t.titlePage.notAvailableYet}
        </div>
      )}

      {item.plot && (
        <p className="mt-6 max-w-4xl text-lg leading-relaxed text-zinc-300">{item.plot}</p>
      )}
    </div>
  );
}
