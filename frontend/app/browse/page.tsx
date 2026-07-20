import { Suspense } from "react";
import { getContent, getMeta } from "@/lib/api";
import { ContentCard } from "@/components/ContentCard";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const query = {
    type: first(sp.type),
    origin: first(sp.origin),
    search: first(sp.search),
    min_rating: first(sp.min_rating),
    genre: first(sp.genre),
    keyword: first(sp.keyword),
    decade: first(sp.decade),
    sort: first(sp.sort),
    page: first(sp.page),
    page_size: "30",
  };

  const [meta, content, t] = await Promise.all([getMeta(), getContent(query), getDictionary(await getLocale())]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="px-4 pt-8 sm:px-8">
        <h1 className="text-2xl font-bold text-white">{t.browse.heading}</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {content.total} {content.total === 1 ? t.browse.titleCountOne : t.browse.titleCountMany}
          {query.search && <> {t.browse.matching} &ldquo;{query.search}&rdquo;</>}
        </p>
      </div>

      <Suspense>
        <FilterBar meta={meta} />
      </Suspense>

      {content.items.length === 0 ? (
        <p className="px-4 py-16 text-center text-zinc-500 sm:px-8">{t.browse.noResults}</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 px-4 sm:grid-cols-3 sm:px-8 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {content.items.map((item) => (
            <ContentCard key={item.id} item={item} fluid />
          ))}
        </div>
      )}

      <Suspense>
        <Pagination page={content.page} totalPages={content.total_pages} />
      </Suspense>
    </div>
  );
}
