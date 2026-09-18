# Handoff: the zvec adoption question — is it earning its slot?

Status: not started · Written: 2026-09-17 · Prerequisite reading: AGENTS.md
"Current core resources" (zvec-grep section), the Search Adoption panel
(http://127.0.0.1:3847 → Search Adoption).

## Why

The Context Budget panel surfaced a contradiction with an assumption this
repo has been operating on:

- `zvec_search` costs 2,175 schema chars in **every request** (plus
  `zvec_index` 1,466 and `zvec_status` 461 — ~4.1k chars total for the trio).
- Actual calls in the last 30 days: **work 2, personal 0, all 2**.
- Yet zvec has a dedicated settings group, an autoIndex session hook, a
  home-index guard extension (from a real past outage), a global `zg` CLI
  installed by install.sh, and a whole Search Adoption panel built (Sept
  2026) to answer "did investigation time drop after zvec worked".

Two hypotheses, and only one of them survives the data:

1. **Range artifact** — the 30d window used by the Context panel cuts off
   the adoption period. The zvec enablement cutoff in the Search Adoption
   panel defaults to 2026-09-09 (the home-index fix); if most zvec usage
   happened in a narrow band after that, a 30d view could miss it.
2. **Adoption collapse** — the model genuinely stopped calling zvec
   (tool drift, bad results, or grep/find being good enough), and the
   ~4.1k chars/request are dead weight on every profile.

This is exactly the "retire with evidence" discipline from the improvement
loop: if the data says unused, the honest move is to shrink its footprint,
not to keep paying for the option.

## Task

1. **Get the full timeline.** Query the Search Adoption panel's own API
   with wider ranges (`/api/stats/search-adoption?range=365d`, and the
   `?since=` parameter moves the split cutoff). Pull the per-day adoption
   timeseries and per-session zvec usage. Also check the Context panel
   join at `range=365d` for `zvec_*` call counts.
2. **Look for the failure mode before concluding.** If calls exist but are
   followed by grep/find fallbacks, that's the "zvec returns weren't good
   enough" pattern the Search Mix stats were built to detect
   (`searchMix.fallbackRate`). If calls simply stopped, check whether
   something changed around that date (model switch, skill/prompt changes,
   index freshness — `zvec_status` calls would tell).
3. **Decide with the improvement-loop rules** (human picks, evidence closes):
   - **Keep**: if usage is real on any profile in a longer window and the
     fallback rate is low → leave it, but consider hiding the trio's schema
     via whatever mechanism `CONTEXT-SUBAGENT-COST.md` establishes for
     session-opt-in tools (zvec is a local extension wrapper +
     `npm:@luminascale/pi-zvec-grep`, so a session-scoped toggle is more
     tractable than for subagents).
   - **Shrink**: if personal is genuinely at 0 → drop the zvec resources
     from the personal profile's tags in `profiles.jsonc` (autoIndex config,
     the npm package; keep `zvec-guard` core — it's tiny and protective).
   - **Retire**: if both profiles are near-zero across a long window →
     remove the npm resource + config + /settings entries entirely, keep
     `zvec-guard` (or remove it too if nothing can index anymore), and
     record the decision here with the numbers.
4. **Whatever the outcome**: if `profiles.jsonc`/`extensions/`/`skills/`
   change, the CI ratchet fires — run `npm run measure:context -- --record`
   and commit the updated record with the change.

## Acceptance

- A dated usage timeline (calls per week for zvec_search/index/status vs
  grep/find) for at least 6 months, from the DB not memory.
- A written verdict (keep/shrink/retire) with the supporting numbers in
  this file, and the corresponding profiles.jsonc / features.ts changes if
  any — or an explicit "no change" with reasons.
- If anything was removed: the measurement record updated and committed
  (the per-profile toolSchemaChars drop should show up in the diff).

## Gotchas

- Don't trust single-range queries: the Context panel's `requests` and the
  adoption panel's sessions are range-filtered, and the zvec-enablement
  story has a mid-September break. Always compare multiple ranges before
  concluding "unused".
- zvec usage may concentrate in *other* workspaces (Orca worktrees where the
  index was copied in — see AGENTS.md). Session folders in the DB tell you
  where zvec calls actually happened; check per-folder before declaring
  personal-profile retirement.
- If shrinking to session-opt-in, remember the trio is one npm package
  (`npm:@luminascale/pi-zvec-grep`) + config: hiding means hiding all its
  tools, and `zvec-guard`/autoIndex make sense only while the tools exist.
- The zg home-index outage history is real (2026-09) — if the verdict is
  "keep", don't remove `zvec-guard` as part of this work.
