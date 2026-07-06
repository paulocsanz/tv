import { ContinueWatchingItem } from "@/lib/types";
import { ContentCard } from "./ContentCard";

export function ContinueWatchingRow({ items }: { items: ContinueWatchingItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="py-4">
      <div className="mb-3 flex items-center justify-between px-4 sm:px-8">
        <h2 className="text-lg font-semibold text-zinc-100 sm:text-xl">Continue Watching</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto px-4 pb-2 sm:px-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <ContentCard key={`${item.id}-${item.episode}`} item={item} progressFraction={item.progress_fraction} />
        ))}
      </div>
    </section>
  );
}
