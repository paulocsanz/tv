import type { AwardEntry } from "@/lib/types";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

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

export async function AwardsCard({
  awards,
  awardEntries,
}: {
  awards: string | null;
  awardEntries: AwardEntry[];
}) {
  const t = getDictionary(await getLocale());
  const awardsClauses = awards ? splitAwardsText(awards) : [];
  if (awardsClauses.length === 0 && awardEntries.length === 0) return null;

  return (
    <div className="rounded-lg bg-white/5 px-4 py-3 ring-1 ring-inset ring-white/10">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
        <span aria-hidden>🏆</span> {t.awards.heading}
      </div>
      {awardsClauses.length > 0 && (
        <p className="mt-1.5 text-sm text-zinc-400">{awardsClauses.join(" · ")}</p>
      )}
      {awardEntries.length > 0 && (
        // Stacked blocks, not inline pills: this card lives in a narrow
        // (320px) sidebar, and "Nominated · Best Picture · Academy Awards
        // 1991" wrapping mid-line inside a rounded-full pill looked broken -
        // a pill shape only reads cleanly on one line. A rounded-md block
        // with the category on its own line wraps like normal text instead.
        <div className={`flex flex-col gap-1.5 ${awardsClauses.length > 0 ? "mt-3" : "mt-1.5"}`}>
          {awardEntries.map((award, i) => (
            <div
              key={`${award.event}-${award.category}-${award.year}-${i}`}
              className={`rounded-md px-2.5 py-1.5 text-xs ring-1 ring-inset ${
                award.won ? "bg-amber-500/15 ring-amber-400/30" : "bg-white/10 ring-white/15"
              }`}
            >
              <div className={`font-semibold ${award.won ? "text-amber-300" : "text-zinc-300"}`}>
                {award.won ? `🏆 ${t.awards.won}` : `🎗️ ${t.awards.nominated}`} · {award.category}
              </div>
              <div className={award.won ? "text-amber-300/70" : "text-zinc-500"}>
                {award.event} {award.year}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
