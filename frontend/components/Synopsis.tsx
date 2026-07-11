"use client";

import { useState } from "react";
import Link from "next/link";
import type { AwardEntry } from "@/lib/types";

// Plot summaries vary wildly in length - clamped to a few lines by default
// so a long one doesn't push the actual video player far down the page,
// with an explicit toggle rather than guessing a "safe" length.
const COLLAPSED_LINE_CLAMP = "line-clamp-3";

export function Synopsis({
  plot,
  actors,
  awards,
  awardEntries,
  keywords,
}: {
  plot: string | null;
  actors: string[];
  awards: string | null;
  awardEntries: AwardEntry[];
  keywords: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (!plot && actors.length === 0 && !awards && awardEntries.length === 0 && keywords.length === 0) {
    return null;
  }

  return (
    <div className="mt-8 max-w-3xl">
      {plot && (
        <div>
          <p className={`text-base leading-relaxed text-zinc-300 ${expanded ? "" : COLLAPSED_LINE_CLAMP}`}>
            {plot}
          </p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 text-sm font-medium text-zinc-400 hover:text-white"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      )}

      {actors.length > 0 && (
        <p className="mt-4 text-sm text-zinc-400">
          <span className="text-zinc-500">Starring: </span>
          {actors.join(", ")}
        </p>
      )}

      {awards && (
        <p className="mt-4 text-sm text-zinc-400">
          <span className="text-zinc-500">Awards: </span>
          {awards}
        </p>
      )}

      {awardEntries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {awardEntries.map((award, i) => (
            <span
              key={`${award.event}-${award.category}-${award.year}-${i}`}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                award.won
                  ? "bg-amber-500/15 text-amber-300 ring-amber-400/30"
                  : "bg-white/5 text-zinc-400 ring-white/10"
              }`}
            >
              {award.won ? "🏆 Won" : "Nominated"} · {award.category} · {award.event} {award.year}
            </span>
          ))}
        </div>
      )}

      {keywords.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {keywords.slice(0, 8).map((keyword) => (
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
  );
}
