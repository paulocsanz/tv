import { ContinueWatchingItem } from "@/lib/types";
import { ContentCard } from "./ContentCard";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

export async function ContinueWatchingRow({ items }: { items: ContinueWatchingItem[] }) {
  if (items.length === 0) return null;

  const t = getDictionary(await getLocale());

  return (
    <section className="py-2">
      <div className="mb-2 flex items-center justify-between px-4 sm:px-8">
        <h2 className="text-base font-semibold text-zinc-100 sm:text-lg">{t.sections.continueWatching}</h2>
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-1 sm:px-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <ContentCard key={`${item.id}-${item.episode}`} item={item} progressFraction={item.progress_fraction} />
        ))}
      </div>
    </section>
  );
}
