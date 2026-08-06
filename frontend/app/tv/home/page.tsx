import { redirect } from "next/navigation";
import { getContinueWatching, getMeOrNull, getSections } from "@/lib/api";
import { FocusRow } from "@/components/tv/FocusRow";
import { TvCard } from "@/components/tv/TvCard";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { localizeItem } from "@/lib/i18n/content";

export const dynamic = "force-dynamic";

export default async function TvHomePage() {
  const me = await getMeOrNull();
  if (!me) redirect("/tv");

  const locale = await getLocale();
  const t = getDictionary(locale);
  const [sections, continueWatching] = await Promise.all([
    getSections(),
    getContinueWatching(),
  ]);

  const featured = sections.find((s) => s.key === "featured");
  const rows = sections.filter((s) => s.key !== "featured");
  const hero = featured?.items[0] ? localizeItem(featured.items[0], locale) : null;

  const firstFocus = { current: true };
  const takeFocus = () => {
    if (!firstFocus.current) return false;
    firstFocus.current = false;
    return true;
  };

  return (
    <div className="pb-16">
      <header className="mb-6 flex items-center justify-between px-8">
        <h1 className="text-2xl font-bold tracking-tight">
          Sess<span className="text-[#f5c518]">ão</span>
        </h1>
        <p className="text-sm text-zinc-500">{me.display_name ?? me.username}</p>
      </header>

      {hero && (
        <div className="relative mb-10 px-8">
          <div className="relative aspect-[21/9] max-h-[42vh] overflow-hidden rounded-2xl bg-zinc-900">
            {(hero.backdrop_url || hero.poster_url) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={hero.backdrop_url ?? hero.poster_url!}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 p-8">
              <p className="mb-2 text-sm uppercase tracking-widest text-[#f5c518]">
                {t.sections.featured}
              </p>
              <h2 className="mb-4 max-w-2xl text-4xl font-bold drop-shadow-lg">{hero.title}</h2>
              <a
                href={`/tv/title/${hero.id}`}
                data-tv-focus
                tabIndex={0}
                autoFocus={takeFocus()}
                className="inline-block rounded-full bg-[#f5c518] px-8 py-3 text-lg font-semibold text-black outline-none focus-visible:ring-4 focus-visible:ring-white"
              >
                {t.player.play}
              </a>
            </div>
          </div>
        </div>
      )}

      {continueWatching.length > 0 && (
        <FocusRow label={t.sections.continueWatching}>
          {continueWatching.map((item) => (
            <TvCard
              key={`${item.id}-${item.episode}`}
              item={item}
              href={`/tv/title/${item.id}`}
              progress={item.progress_fraction}
              autoFocus={takeFocus()}
            />
          ))}
        </FocusRow>
      )}

      {rows.map((section) => (
        <FocusRow key={section.key} label={section.title}>
          {section.items.map((raw) => {
            const item = localizeItem(raw, locale);
            return (
              <TvCard
                key={item.id}
                item={item}
                href={`/tv/title/${item.id}`}
                autoFocus={takeFocus()}
              />
            );
          })}
        </FocusRow>
      ))}
    </div>
  );
}
