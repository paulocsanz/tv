import type { AwardEntry } from "@/lib/types";

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

export function AwardsCard({
  awards,
  awardEntries,
}: {
  awards: string | null;
  awardEntries: AwardEntry[];
}) {
  const awardsClauses = awards ? splitAwardsText(awards) : [];
  if (awardsClauses.length === 0 && awardEntries.length === 0) return null;

  return (
    <div className="rounded-lg bg-white/5 px-4 py-3 ring-1 ring-inset ring-white/10">
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
  );
}
