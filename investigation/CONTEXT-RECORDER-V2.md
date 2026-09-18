# Handoff: context-recorder v2 — hashes, history, prompt composition

Status: not started · Written: 2026-09-17 · Prerequisite reading: the
context-measure bullet in AGENTS.md "Current core resources", and
`extensions/context-measure/context-measure.ts`.

Three small, independent recorder/dashboard upgrades. They can be done
together or separately; each closes a metric gap that v1 (committed in
`61291f9`) left open.

## 1. Stability hashes → cache-bust events

**Why.** The prompt cache (see `extensions/cache-ttl/`) is only worth
something while the request prefix stays byte-identical. If any extension
injects or mutates the system prompt / tool list mid-session, every later
request pays a full re-read. Nobody currently measures how often that
happens.

**Task.**
- In `summarizeContext()` (`context-measure.ts`), add `systemPromptSha256`
  and `toolsSha256` (sha256 of the serialized strings) to each record line.
  Cheap: the strings are already in hand.
- pi-omp-stats: the live-session jsonl (`<configDir>/context-measure.jsonl`)
  needs a reader — add a `context_measure_events` ingestion path OR (simpler
  for v2) a route that reads the jsonl directly and reports, per session
  boundary (timestamps), how many distinct `systemPromptSha256`/`toolsSha256`
  values appeared. Model it on how `/api/stats/context` reads the record
  file (live read, no DB).
- Dashboard: a "cache-bust events" stat on the Context tab. Note the
  existing `payload-exporter` (Tools & Safety) overlaps here — check
  `payloads.ts` helpers before building new plumbing.

**Acceptance.** A session where the model/provider is switched mid-run
shows a hash change; a steady session shows one hash pair. Test in
`context-measure.test.ts` (pure function — trivial to cover; the file is
in the 90% coverage include list).

## 2. Record history → first-call trend chart

**Why.** `investigation/context-measurement.json` is a point-in-time
snapshot. The Context panel can't show the line moving as subagent-cost work
lands (see `CONTEXT-SUBAGENT-COST.md`) because history lives only in git.

**Task.**
- pi-omp-stats DB: new table `context_records (id, measured_at, target,
  tool_count, system_prompt_chars, tool_schema_chars, context_chars, tool_chars_json)`.
  Ingest in `aggregator.ts` on sync (find the record file the same way
  `getContextBudgetStats` does — `getContextRecordPath()`; `INSERT OR IGNORE`
  keyed on measured_at+target so re-measures don't duplicate).
- Route + panel: extend `/api/stats/context` with `history`, draw a simple
  line chart (per-target contextChars over time) on the Context tab.
  Follow the schema-version sentinel pattern (`meta` table) used for the
  compaction/memory tables so the new table backfills cleanly on upgrade.

**Acceptance.** Re-running `npm run measure:context -- --record` twice
produces two points; the chart renders them; schema bump resets offsets
once (see how `compaction_stats` did it).

## 3. Prompt composition attribution

**Why.** The 8–10k system-prompt chars per profile are unattributed. Skill
discovery metadata (`<available_skills>`) and AGENTS guidance ride in every
first call; nobody knows what each skill or doc costs.

**Task.**
- Recorder: when `PI_CONTEXT_MEASURE_DEBUG` (or a config key) is set, also
  dump the full `systemPrompt` text to a sibling file
  (`context-measure-prompt.txt`). Local-only, opt-in; never include it in
  the committed record.
- A small analysis step (script or dashboard section) that attributes
  segments: compare with/without a skill or resource disabled (measure →
  toggle → re-measure via the existing `impulso-settings` flags), or parse
  known markers (`<available_skills>`, AGENTS section headers) out of the
  dumped text.
- Output: a per-resource cost table for AGENTS.md (and the panel if it
  proves useful).

**Acceptance.** A dumped prompt from the work profile can be attributed to
at least: pi core prompt, AGENTS guidance, skills list, extension
contributions. Method documented where the numbers are reported.

## Gotchas (all three)

- Any change to `extensions/context-measure/**` triggers the CI ratchet:
  run `npm run measure:context -- --record` and commit the record with the
  change.
- `summarizeContext` is pure and tested — keep it that way; hashing belongs
  inside it, file writes stay in `appendRecord`.
- Gates: complexity (cyclomatic/cognitive < 22, Halstead < 80) and CRAP
  (< 25) run over `extensions/`; pi-omp-stats (`packages/`) is outside the
  gates but keep the aggregator functions small anyway.
- Sync flow after extension changes: `node scripts/install.mjs --yes --all`
  then `--base` (this also rebuilds the pi-omp-stats global bin and
  restarts the service — the dashboard picks changes up automatically).
- pi internals verified during v1: extensions must import
  `@earendil-works/pi-ai` (pi aliases it to its bundled copy at runtime);
  `registerProvider` config form requires a `baseUrl` even when
  `streamSimple` never fetches (we use `http://127.0.0.1:9/measure`).
