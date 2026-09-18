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

---

# Outcome — verdict: KEEP + FIX (2026-09-18)

Written after the investigation; numbers from the stats DB (`~/.pi/agent/
pi-omp-stats*.db`), not memory.

## What the data said

Tool calls since the 2026-09-09 enablement cutoff (2026-09-18):

| tool | calls | | tool | calls |
| --- | --- | --- | --- | --- |
| bash | 7,641 | | find | 138 |
| read | 1,405 | | **zvec_search** | **2** |
| edit | 1,037 | | **zvec_index** | **1** |
| grep | 155 | | | |

Both `zvec_search` calls were post-cutoff: one was rollout testing in
impulso-pi/zvec-2; the ONE organic call (2026-09-17, devboxes, GLM-5.3) was a
perfect use case ("where is devbox tooling handled") that **failed on argument
validation** — the model passed `{limit, root}` with no query (every query
field was optional in the schema), got `isError`, fell back to `bash grep`,
and never touched zvec again. First-try failure kills adoption.

Deeper structural finding: **every workspace in the umbrella-repo workflow
(Orca worktrees of mtv-inference, and mtv-ai-infra) had a 4-file index** —
zg 0.2.x hard-skips nested git repos when indexing (verified empirically:
`--no-ignore` and explicit `-g` globs cannot include them), so an umbrella
index can only ever contain root-level files, and that stub *shadows* real
leaf-repo indexes (zg resolves the nearest ancestor index — a session in
`lib-py-inference-client/examples` resolved up to the 4-file mtv-inference
index). Meanwhile a 4.1 GB `~/code` index (built by a session with cwd
`~/code`, resolved to by every `~/code/*` session) was corrupt — racing
autoIndex builds from concurrent sessions ("crash residue", read-only-mode
IDMap errors on every `zg status`). `zg query --rg` (the fts path) searches
nested-repo content live and works without any index.

So "unused" was three fixable causes stacked, not a verdict on the concept:
(1) an un-failable schema was failable, (2) umbrella sessions structurally
had nothing to search, (3) nothing routed the models (96% GLM-5.3; one
guideline line among 16-17 tools) to zvec before their grep habit.

## What shipped (impulso-pi + fork)

1. **Fork `git:github.com/alexandrekm/pi-zvec-grep`** (v0.4.0, from upstream
   v0.3.1) replaces `npm:@luminascale/pi-zvec-grep` in profiles.jsonc:
   - `zvec_search.query` is **required** — the empty-call failure mode is
     unrepresentable; description and guideline say so.
   - Root policy (`rootPolicy` config: `allowRoots`, `maxNestedRepos`=3):
     `zvec_index` (tool + autoIndex) refuses `$HOME` and umbrella roots with
     an explanatory error; `/zg` (human-typed) stays unguarded.
   - Cross-process autoIndex lock (`locks/autoindex.lock`, stale 10 min).
   - `normalizeRoot` now expands `~`; test suite green on macOS (was 6
     pre-existing failures here, incl. a racy wait).
   Upstream PR desirable once validated in daily use.
2. **zvec-guard v2** (`extensions/zvec-guard/`): mirrors the same policy at
   pi's tool_call layer — defense in depth, same config file.
3. **Dropped the bad indexes** (2026-09-18): `~/code/.zvec-grep` (4.1 GB,
   corrupt), `~/code/mtv/mtv-inference/.zvec-grep` (4 files), and the 4-file
   indexes in devboxes / triton-images / local-dev / tf-inference-module /
   mtv-ai-infra worktrees. Umbrella sessions now run index-free — fts
   searches still cover submodule content; semantic gets a clean
   "no index" hint instead of empty results.
4. **`config/APPEND_SYSTEM.md`** (core resource → `<profile>/APPEND_SYSTEM.md`):
   a ~2-line search-routing nudge in every system prompt — work repos'
   AGENTS.md files say nothing about zvec, and GLM-5.3 doesn't read tool
   guidelines closely. Context-record ratchet re-run (CI gate).

## What to watch next

The Search Adoption panel (`?since=1788912000000`, the 2026-09-09 cutoff) is
the scoreboard: expect zvec_search calls to appear in plain-repo sessions
(docs/triton, impulso-pi worktrees). Umbrella worktrees will stay near zero
by design — structural, until zg grows nested-repo indexing; if that lands,
revisit whether umbrella roots should be allowlisted. If adoption stays ~0
in plain repos for another few weeks with the schema/prompt fixes live, the
honest verdict flips to retire (the ~4.1k schema chars + this machinery
would then be dead weight) — this doc is the evidence trail for that call.

---

# Round 2 — umbrella/worktree workflow (2026-09-18, same day)

User push-back on "umbrella sessions run index-free": umbrella repos are the
main way they work; they wanted `~/code/mtv/*` roots indexable (but NOT
`~/code/mtv` itself, and not `~/code`), and clarified the worktree flow —
base indexes live on the main checkouts (reindexed by their own command
after pulls), worktrees should get seeded copies that update as they go and
never write back to the main.

New zg 0.2.2 facts, all verified empirically (see fork HANDOFF round 2):

- `zg index <explicit-root>` HONORS the explicit root even when an ancestor
  is indexed — worktree builds can never write back into the main checkout.
- But cwd-based `status`/`query`/`index` resolve the NEAREST ANCESTOR index:
  an index at a container/umbrella root makes every repo below it
  permanently un-indexable (they resolve up to the stub; even a no-arg
  `zg index` from below lands on the ancestor). This is why allowlisting
  `~/code/mtv/*` umbrella roots would backfire — the 4-file stub at
  mtv-inference would lock out triton-inference, lib-py-inference-client,
  etc. It's also the mechanism that froze every repo under the 4.1 GB
  ~/code index after Sep 9.
- Worktree seeding works: copy the main checkout's `.zvec-grep` + rewrite
  manifest rootPaths → turn-1 search; a following `zg index <worktree>`
  updates it in place. Verified end-to-end with real git + real zg (seed →
  update → main untouched → semantic finds worktree-only AND base content).

Design that shipped (fork 2484ed7): umbrella/container roots stay BLOCKED
(now with the correct reason — ancestor shadowing, not just "useless
stub"); autoIndex resolves the NEAREST ENCLOSING git repo (one index per
repo/worktree, never per-subdir stubs, never the main checkout); worktrees
without an index are seeded from their main's base (2 GB cap) then updated
in background; a missing own manifest builds directly so an ancestor's
"ready" can no longer suppress leaf/worktree builds. Sessions at an
umbrella root get semantic via `root=<submodule>` in zvec_search (pins cwd,
bypasses the walk-up — taught in APPEND_SYSTEM.md) or fts/rg index-free.

Net for the user's workflow: `~/code` and `~/code/mtv` blocked (the huge
containers, exactly as asked); every repo and worktree under them gets its
own real index (new — previously frozen by the mega-index); fresh worktrees
start searchable from the base; the main checkout's index is never touched
by worktree sessions.
