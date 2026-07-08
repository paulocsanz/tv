import { ContentItem, displayRating } from "@/lib/types";

export function StarIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z" />
    </svg>
  );
}

function TomatoIcon({ fresh }: { fresh: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
      <circle cx="10" cy="11" r="7" fill={fresh ? "#fa320a" : "#4c9c2e"} />
      <path d="M7 5c1-2 5-2 6 0" stroke="#4c9c2e" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function ImdbBadge({ item, size = "sm" }: { item: ContentItem; size?: "sm" | "lg" }) {
  const rating = displayRating(item);
  const big = size === "lg";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-[#f5c518] font-semibold text-black ${
        big ? "px-2.5 py-1 text-sm" : "px-1.5 py-0.5 text-xs"
      }`}
      title="IMDb rating"
    >
      <StarIcon />
      {rating.toFixed(1)}
    </span>
  );
}

export function RottenTomatoesBadge({ item, size = "sm" }: { item: ContentItem; size?: "sm" | "lg" }) {
  if (!item.rotten_tomatoes) return null;
  const pct = parseInt(item.rotten_tomatoes, 10);
  const fresh = pct >= 60;
  const big = size === "lg";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-white/10 font-semibold text-zinc-100 ring-1 ring-inset ring-white/10 ${
        big ? "px-2.5 py-1 text-sm" : "px-1.5 py-0.5 text-xs"
      }`}
      title="Rotten Tomatoes score"
    >
      <TomatoIcon fresh={fresh} />
      {item.rotten_tomatoes}
    </span>
  );
}

export function RatingRow({ item, size = "sm" }: { item: ContentItem; size?: "sm" | "lg" }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ImdbBadge item={item} size={size} />
      <RottenTomatoesBadge item={item} size={size} />
    </div>
  );
}
