---
name: whats-next
description: Figure out what to work on next in this project. Scans in-progress work, catalog data-quality gaps, code TODOs/stubs, test gaps, and plan/RFC gaps; produces a prioritized action queue with a concrete "start here" per item. Repairs vague plan docs before reporting, and appends what it learned to its own Run Log. Use when the user asks "what's next", "what should I work on", or wants a prioritized backlog for this project.
argument-hint: "[--category=in-progress|catalog|stubs|tests|plans] [--limit=N]"
allowed-tools: Read, Glob, Grep, Bash, Agent, Edit, Write
---

# What's Next

Scans this project (a personal media-catalog app: Rust backend, Next.js frontend, a torrent
acquisition pipeline, and a curated `backend/data/enriched_400.json` catalog) to produce a
prioritized queue of what's worth doing next: unfinished in-progress work, catalog data-quality
gaps, code stubs/TODOs, test gaps, and plan (RFC) gaps.

**Does NOT run tests, build, or touch the live pipeline.** Static analysis + read-only catalog
inspection — fast, synthesis-focused. If the download/upload pipeline's health is in question,
delegate to the `pipeline-status` skill instead of re-implementing that check here.

Adapted from a `whats-next` skill in a sibling project (`../caixote`) — same phase structure and
doc-repair discipline, rescoped for a solo personal project instead of a company platform. The
self-improving Run Log (Phase 8) is new: nothing in the source skill wrote back to its own
instructions, only to the docs it was auditing.

## Usage

```
/whats-next                        # Full scan, all categories
/whats-next --category=in-progress # Only: uncommitted work, stale locks, running processes
/whats-next --category=plans       # Only: Draft RFCs in rfcs/, partial implementations
/whats-next --category=stubs       # Only: TODO/FIXME/unimplemented!()/@ts-ignore
/whats-next --category=tests       # Only: #[ignore], skipped/thin test coverage
/whats-next --category=catalog     # Only: catalog data-quality gaps (backfills, mismatches, missing torrents)
/whats-next --limit=5              # Show only top N items across all categories
```

---

## Execution

Run Phase 0 first (it mutates `rfcs/` files and must complete before Phase 2 reads them). Run
Phases 1-5 in parallel (via `Agent`, one per phase, unless `--category` narrows scope) since
they're independent read-only scans. Then Phase 6 (doc repair), Phase 7 (synthesis), Phase 8
(self-improvement) run in that order, sequentially, on the main thread.

---

## Phase 0: Plan Housekeeping (always runs first)

If `rfcs/` doesn't exist yet, skip this phase entirely — there's nothing to fix on a first run.

Otherwise, for every file in `rfcs/`:

```bash
for f in rfcs/*.md; do
  checked=$(grep -c "^\- \[x\]" "$f" 2>/dev/null || echo 0)
  open=$(grep -c "^\- \[ \]" "$f" 2>/dev/null || echo 0)
  status=$(grep -m1 "^\*\*Status:\*\*" "$f" | head -1)
  echo "$f | checked=$checked | open=$open | $status"
done
```

- **Auto-promote:** Status is `Draft`/`In Progress` and zero unchecked boxes remain (or the only
  open ones are explicitly low-priority) → update Status to `Implemented`. Log the change.
- **Leave alone:** `open > 0` — the status isn't wrong.
- **Superseded detection:** scan for `Supersedes:` headers or a newer RFC covering the same
  feature with `Status: Implemented`; mark the older one `Superseded by RFC <name>`.
- Skip any RFC updated in this phase from Phase 2's gap reporting — its open boxes are dead history.
- Prepend a collapsible "Plan Housekeeping (auto-fixed)" section to the output listing every
  change. Omit the section entirely if nothing was fixed.

---

## Phase 1: In-Progress Work

**Always highest priority** — unfinished work blocks other things.

```bash
git status --short
git diff --stat
git log --oneline -10
cat .download-picked-torrents.lock 2>/dev/null; echo
ps aux | grep -E "[n]ode download-picked|[a]ria2c|[f]fmpeg"
```

- Uncommitted/staged changes: what area are they in, do they look finished or mid-flight?
- Any `*.bak-pre-*` snapshot files lying around — these mark an in-flight or abandoned cleanup pass.
- Last commit message like "wip" or a partial description → flag it.
- If the pipeline lock file exists or a `download-picked-torrents.js` process is running, note it's
  active and point at `pipeline-status` for a real health check rather than duplicating it here.

---

## Phase 2: Plan (RFC) Gaps

Skip any RFC whose status Phase 0 already resolved.

```bash
grep -rl "Status.*Draft\|Status.*In Progress" rfcs/ 2>/dev/null
grep -rn "^\- \[ \]" rfcs/ 2>/dev/null
```

For each surviving Draft/In-Progress RFC: read its requirements, grep for whether the feature
already has code, and classify as not-started / partially-started / mostly-done-but-doc-stale.

If `rfcs/` doesn't exist at all, this phase's only output is a note for Phase 6: "no plan docs
exist yet — the first Draft RFC this project needs is probably X" (infer X from Phase 5's findings).

---

## Phase 3: Code Stubs and Technical Debt

```bash
# Rust — hard stubs that will panic at runtime
grep -rn "unimplemented!()\|todo!()\|panic!(\"not implemented\|panic!(\"TODO" \
    --include="*.rs" --exclude-dir="target" backend/src \
    | grep -v "#\[cfg(test)\]\|mod tests"

# FIXME / urgent TODOs across the whole stack
grep -rn "FIXME\|TODO(.*important\|TODO(.*critical\|// HACK\|// XXX" \
    --include="*.rs" --include="*.ts" --include="*.tsx" \
    --exclude-dir="target" --exclude-dir="node_modules" --exclude-dir=".next" \
    backend/src frontend

# TypeScript stubs / escape hatches
grep -rn "throw new Error(\"not implemented\|TODO\|FIXME\|// @ts-ignore\|as any" \
    --include="*.ts" --include="*.tsx" \
    --exclude-dir="node_modules" --exclude-dir=".next" \
    frontend/app frontend/components frontend/lib \
    | grep -v "\.test\.\|\.spec\."
```

A `todo!()` on the hot request path (video playback, auth) is a real risk. A `// TODO: nicer empty
state` in an admin page is noise — apply judgment, don't flag every hit equally.

---

## Phase 4: Test Gaps

```bash
grep -rn "#\[ignore\]" --include="*.rs" --exclude-dir="target" backend/src
find frontend -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" | grep -v node_modules
git log --oneline --since="30 days ago" --diff-filter=A -- "*.rs" "*.ts" "*.tsx" | head -20
```

Note whether recently-added surfaces (new API routes, new components) have any test coverage at
all — this project has thin test coverage generally, so the bar is "does anything cover the
critical path" (auth, video URL signing, progress tracking), not "is coverage complete."

---

## Phase 5: Catalog Data-Quality Gaps

This is this project's real backlog engine — the curated 400-item catalog is a living dataset,
not just code. Treat gaps here with the same weight as code gaps.

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('backend/data/enriched_400.json', 'utf-8'));
const items = data.items || data;
const noTorrents = items.filter(i => !(i.torrent_options_720p||[]).length && !i.s3_key).length;
const noS3 = items.filter(i => !i.s3_key && !(i.episodes||[]).some(e=>e.s3_key)).length;
console.log('items with zero torrent options found:', noTorrents);
console.log('items not yet on S3:', noS3);
"
ls *-flagged.json *-suspicious.json *-dry-run*.json 2>/dev/null
cat .download-picked-torrents.lock 2>/dev/null && echo " (pipeline lock present)"
```

- Any `*-flagged.json` / `*-suspicious.json` file sitting untouched is a queue of items awaiting a
  human decision — count them, don't just note they exist.
- Any backfill script (`backfill-*.js`) whose corresponding field isn't populated across the
  catalog yet is unfinished work, not a completed one-off.
- The "197 items with no torrent options" gap (as of 2026-07-09) is a search-coverage problem, not
  a pipeline failure — don't conflate it with actual `item_failed` pipeline events (see Phase 8
  Run Log below for why).

---

## Phase 6: Documentation Repair

**Rule: every item in the final queue must have a crisp "Start here." If you can't write one, the
plan doc is the problem — fix it first.**

- For a vague/incomplete Draft RFC found in Phase 2: rewrite the ambiguous parts based on what the
  codebase already implies, sharpen the requirements list, add an Implementation Plan if missing,
  write it back with `Edit`.
- For an obvious gap from Phase 5 with no RFC covering it: create `rfcs/NNNN-name.md` (next number
  from `ls rfcs/ | sort -V | tail -1`, or `0001` if the directory doesn't exist yet — create it).
  Use the minimal RFC format from `/rfc`: **Background**, **Problems This Solves**, **Proposed
  Solution** only — no Risk/Metrics/Conclusions sections, bullets over prose.
- Don't gold-plate: a 15-line stub RFC that unblocks work beats a polished one that takes an hour.
- Don't rewrite Implemented RFCs unless Phase 2 found genuinely stale future-tense language in them.

---

## Phase 7: Synthesis

| Priority | Meaning |
|----------|---------|
| **P0 — Fix Now** | Blocks other work or risks data loss (uncommitted work at risk, a stub on the video-playback hot path, a stale `.bak` about to be mistaken for current data) |
| **P1 — Next** | Planned work clearly in-flight (partially-checked RFC, a backfill script that's run dry-run only and is ready to apply) |
| **P2 — Queue** | Solid backlog (Draft RFCs not started, catalog gaps with a clear fix, missing test coverage on a real path) |
| **P3 — Nice** | Opportunity, not urgent |

```markdown
# What's Next

> Scanned on: <date>
> In-progress: N | Plan gaps: N | Stubs: N | Test gaps: N | Catalog gaps: N

## P0 — Fix Now
### 1. [Category] <title>
**Files/data:** ...
**What's happening:** ...
**Start here:** ...

## P1 — Next
## P2 — Queue
## P3 — Nice

## Summary
| Category | Count | Highest Priority |
|----------|-------|-------------------|

**Suggested starting point:** ...
```

---

## Phase 8: Self-Improvement (Run Log)

After producing the queue, append one dated entry to the **Run Log** section at the bottom of
*this file* via `Edit`. Each entry is 1-4 bullets: what signal was real vs noise this run, any
check that should be added/tightened/dropped, any false-positive pattern hit. This is how the
skill gets better at *this specific project* over time instead of re-learning the same lessons
every run.

- Keep the Run Log to the **8 most recent entries**. When adding a 9th, fold the oldest into a
  single "Earlier lessons" bullet at the top of the section instead of deleting it outright.
- Only log something a future run would actually need to know — not a summary of what was found
  (that belongs in the queue output, not here).
- If a run finds nothing worth learning, skip Phase 8 silently rather than writing a filler entry.

### Run Log

- **2026-07-09** — `item_failed` events in `pipeline-events.jsonl` are frequently transient: of 20
  distinct failed items checked, 19 later succeeded on retry and 1 was mid-upload at check time.
  Before flagging a pipeline item as stuck, check for a later `item_done` for the same `id`, and
  cross-check `current_torrent_index_720p` against `torrent_options_720p.length` in
  `enriched_400.json` — only exhausted-options items are genuinely stuck.
- **2026-07-09** — First full run. Phase 3's stub grep only covers `backend/src` and
  `frontend/{app,components,lib}`; it misses the repo-root one-off pipeline/tooling scripts
  (`backfill-*.js`, `download-picked-torrents.js`, etc.). That's fine — those are one-off tooling,
  not request-serving code, so they're legitimately out of scope for hot-path risk — but don't
  mistake "zero hits" for "scanned everything."
- **2026-07-09** — Phase 5 should also check for near-duplicate catalog entries (same title/year
  under two different ids), not just missing-field gaps. Found one today by accident:
  `once-upon-a-time-was-i-veronica-2012-movie` vs `once-upon-a-time-veronica-2012-movie` — the
  second already has correct `original_title`/`tmdb_id`, the first is dead weight. A fuzzy
  title+year match across all items would catch this class of gap on purpose next time.

---

## Honesty Rules

- **Don't over-flag.** A TODO in an admin-only page is not an emergency.
- **Don't under-flag.** A stub on the auth or video-signing path is.
- **Don't invent features** unrelated to what's already built or clearly implied by existing patterns.
- **If you can't determine whether something is a gap, that IS the gap** — fix the doc (Phase 6),
  don't output "unclear" as a finding.
- **Never report open checkboxes in a superseded/implemented RFC as gaps.**
- **Never trust a Status line alone — count the boxes.** Phase 0 fixes are free wins; always apply them.
- **Uncommitted work and live processes go first** — they're the most reversible to lose.
