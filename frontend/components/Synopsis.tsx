"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AwardEntry } from "@/lib/types";

// Plot summaries vary wildly in length - clamped to a few lines by default
// so a long one doesn't push the actual video player far down the page,
// with an explicit toggle rather than guessing a "safe" length.
const COLLAPSED_LINE_CLAMP = "line-clamp-3";

// OMDb's awards blurb is one dense run-on sentence (e.g. "Won 1 Oscar. 44
// wins & 38 nominations total."). Splitting it into separate clauses reads
// far easier than one long line - this doesn't try to parse *meaning* out of
// it (too many real-world formats to handle reliably), just breaks it up.
function splitAwardsText(awards: string): string[] {
  return awards
    .split(/\.\s+/)
    .map((clause) => clause.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

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
  const plotRef = useRef<HTMLParagraphElement>(null);
  // Only true once we've measured that the clamped paragraph actually clips
  // text - otherwise a short plot that already fits in 3 lines would still
  // show a "Show more" toggle that reveals nothing new when clicked.
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    const el = plotRef.current;
    if (el) setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [plot]);

  if (!plot && actors.length === 0 && !awards && awardEntries.length === 0 && keywords.length === 0) {
    return null;
  }

  const awardsClauses = awards ? splitAwardsText(awards) : [];

  return (
    <div className="mt-8 max-w-3xl">
      {plot && (
        <div>
          <p
            ref={plotRef}
            className={`text-base leading-relaxed text-zinc-300 ${expanded ? "" : COLLAPSED_LINE_CLAMP}`}
          >
            {plot}
          </p>
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 text-sm font-medium text-zinc-400 hover:text-white"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {actors.length > 0 && (
        <p className="mt-4 text-sm text-zinc-400">
          <span className="text-zinc-500">Starring: </span>
          {actors.join(", ")}
        </p>
      )}

      {(awardsClauses.length > 0 || awardEntries.length > 0) && (
        <div className="mt-4 rounded-lg bg-white/5 px-4 py-3 ring-1 ring-inset ring-white/10">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
            <span aria-hidden>🏆</span> Awards
          </div>
          {awardsClauses.length > 0 && (
            <p className="mt-1.5 text-sm text-zinc-400">{awardsClauses.join(" · ")}</p>
          )}
          {awardEntries.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${awardsClauses.length > 0 ? "mt-3" : "mt-1.5"}`}>
              {awardEntries.map((award, i) => (
                <span
                  key={`${award.event}-${award.category}-${award.year}-${i}`}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                    award.won
                      ? "bg-amber-500/15 text-amber-300 ring-amber-400/30"
                      : "bg-white/10 text-zinc-300 ring-white/15"
                  }`}
                >
                  {award.won ? "🏆 Won" : "🎗️ Nominated"} · {award.category} · {award.event} {award.year}
                </span>
              ))}
            </div>
          )}
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
