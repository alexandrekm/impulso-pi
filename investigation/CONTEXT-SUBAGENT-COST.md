# Handoff: attack the subagent tool cost

Status: not started · Written: 2026-09-17 · Depends on: nothing (evidence already committed)

## Why

The Context Budget panel (`http://127.0.0.1:3847` → Context, `/api/stats/context`)
quantified what every request pays for pi-subagents' tool schemas:

| tool | schema chars / request | calls / 30d (work · personal · all) |
| --- | --- | --- |
| `subagent` | 21,025 | 8 · 3 · 11 |
| `bg_wait` | 4,299 | 1 · 1 · 2 |
| `subagent_supervisor` | 466 | — |

Together ~26k chars = **45% of every profile's first call** (profiles are
~55–58k chars, ~10.8x stock pi's 5,394). With ~18k requests/30d on the work
profile, that is hundreds of millions of characters of pure schema carriage
per month for a feature invoked single-digit times. The 21k is mostly the
`workflowScript` documentation embedded in the `subagent` tool description.

## Current state

- `npm:pi-subagents@0.64.0` is a pinned core resource in `profiles.jsonc`,
  already `prune`d of its bundled skills (`skills/council-mode`,
  `skills/pi-subagents`). Installed copies live in
  `<profile>/npm/node_modules/pi-subagents/` (and `~/.pi/agent/npm/node_modules/`).
- Usage evidence: Context Budget panel (chars-per-use join), Subagents panel
  (`/api/stats/subagents`, `subagent_runs` table in pi-omp-stats).
- The measurement record `investigation/context-measurement.json` is the
  committed baseline; re-measure with `npm run measure:context -- --record`
  after any change (CI ratchet `npm run check:context-record` fails if
  `profiles.jsonc`/`extensions/`/`skills/` change without a record update).

## Task, in escalation order

1. **Config check.** Read the installed package source
   (`~/.pi/agent/npm/node_modules/pi-subagents/`) for a config surface that
   defers tool registration (env var, config file, `pi.settings` key, or a
   lazy-register hook). The `/settings` entry for pi-subagents (impulso
   page, Tools & Safety → Subagents) only flips `packages[]` autoload —
   which disables the whole package, not just the tools. We want: tools
   absent until a session command opts in (SpecPi's `/delegate on` pattern).
2. **Upstream trim.** If no config surface exists, open an issue/PR upstream
   (pin release preflighted against Pi 0.84.4 per `profiles.jsonc` comment)
   proposing: (a) move the `workflowScript` docs out of the tool description
   into the package's own skill/docs the parent reads on demand, and/or
   (b) a session-scoped enable command. The 21k description is the thing to
   cut; even halving it wins 10k+ chars/request on every profile.
3. **Local stopgap** (only if 1–2 fail): keep the package but consider
   dropping it from the `personal` profile tags if panel data shows near-zero
   use there (currently 3 calls/30d). Changing `profiles.jsonc` tags is the
   supported lever; remember the ratchet + re-measure.
4. Whatever lands: `./install.sh --all` (and `--base`) to sync, then
   `npm run measure:context -- --record` and commit the updated record
   together with the change.

## Acceptance

- `subagent`+`bg_wait`+`subagent_supervisor` schema chars measurably reduced
  in `investigation/context-measurement.json` (report the before/after
  contextChars per profile in the PR description), or a documented upstream
  issue link with the local decision recorded in this file.
- All repo gates pass (`typecheck`, `lint`, `test`, `check:crap`,
  `check:halstead`, `format:check`) and the record update is in the same PR.

## Gotchas

- pi has **no API to unregister another package's tools** from an extension;
  that's why 3 (tag removal) is the only fully-local lever. Verify this
  claim against the pi source in `reference-impl/pi/` before relying on it.
- If pinning a new pi-subagents release, re-check the scout behavior noted in
  `profiles.jsonc` (strict read/search tool allowlist, fresh start) and the
  `prune` list still applies.
- Don't "fix" this by editing the installed package in place — install.sh
  sync would resurrect the original on every package update.
