import Link from "next/link";
import { Section } from "@/lib/types";
import { ContentCard } from "./ContentCard";

export function ContentRow({ section }: { section: Section }) {
  if (section.items.length === 0) return null;

  const browseHref = sectionToBrowseHref(section.key);

  return (
    <section className="py-2">
      <div className="mb-2 flex items-center justify-between px-4 sm:px-8">
        <h2 className="text-base font-semibold text-zinc-100 sm:text-lg">{section.title}</h2>
        {browseHref && (
          <Link href={browseHref} className="text-xs text-zinc-400 hover:text-white">
            See all →
          </Link>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-1 sm:px-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {section.items.map((item) => (
          <ContentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function sectionToBrowseHref(key: string): string | null {
  switch (key) {
    case "top_movies":
      return "/browse?type=movie";
    case "top_tv":
      return "/browse?type=tv";
    case "brazilian_movies":
      return "/browse?type=movie&origin=Brazilian";
    case "brazilian_tv":
      return "/browse?type=tv&origin=Brazilian";
    case "international_classics":
      return "/browse?origin=International&sort=year_asc";
    case "modern_hits":
      return "/browse?sort=year_desc";
    case "hidden_gems":
      return "/browse?sort=rating_desc";
    default:
      return "/browse";
  }
}
