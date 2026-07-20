"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/LocaleProvider";

// Plot summaries vary wildly in length - clamped to a few lines by default
// so a long one doesn't push the actual video player far down the page,
// with an explicit toggle rather than guessing a "safe" length.
const COLLAPSED_LINE_CLAMP = "line-clamp-3";

export function Synopsis({ plot, actors }: { plot: string | null; actors: string[] }) {
  const t = useT();
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

  if (!plot && actors.length === 0) return null;

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
              {expanded ? t.synopsis.showLess : t.synopsis.showMore}
            </button>
          )}
        </div>
      )}

      {actors.length > 0 && (
        <p className="mt-4 text-sm text-zinc-400">
          <span className="text-zinc-500">{t.synopsis.starring}</span>
          {actors.join(", ")}
        </p>
      )}
    </div>
  );
}
