# Handoff: per-turn context analysis from payload-exporter files

Status: not started · Written: 2026-09-17 · Prerequisite reading: AGENTS.md
sections on pi-omp-stats and the context-measure resource; the Context
Budget panel (http://127.0.0.1:3847 → Context).

## Why

Everything measured so far is the *first* request. What's unmeasured:
what each later request costs (mid-session growth), what a compaction
actually re-sends, and how much of a session's requests share a cacheable
prefix. The infrastructure for this already exists — **the recorder is not
needed for any of it**:

- `extensions/payload-exporter/` (core resource, Tools & Safety in /settings,
  `/payload-exporter on|off|toggle|status`) saves **every real provider
  request payload + response** under `<configDir>/payloads/` — wire format,
  exactly what the provider billed.
- pi-omp-stats already reads that directory: `payloads.ts` exports
  `resolvePayloadRoots(profile)`, `listPayloadDates/Sessions/Files`,
  `readPayloadFile`, `readPayloadErrors`; the Payloads tab exists.
- The DB already has `compaction_stats` (compaction events with timestamps)
  and `messages` (per-request token usage) to correlate against.

So this is a read-and-join job, not an instrumentation job.

## Task

1. **Explore the payload format first** — turn the exporter on for a session
   (or find existing files under `~/.pi/agent/payloads/` /
   `~/.pi/profiles/*/payloads/`), inspect the wire request JSON (system
   prompt, tools, messages), and confirm stable fields for: total body
   size, system-prompt segment, tools segment, message-history length.
2. **New aggregator function + route** (`packages/pi-omp-stats/src/`,
   follow `getCompactionDashboardStats` as the pattern):
   `/api/stats/context/turns?session=&profile=` returning, for one session
   from payloads: per-request `totalChars`, `systemChars`, `toolsChars`,
   `historyChars`, plus a prefix-stability indicator (e.g. sha256 of the
   system+tools segment, same idea as the recorder v2 hashes).
3. **Compaction cost view**: join payload request sizes with
   `compaction_stats` timestamps (same session) → show context size
   before/after each compaction and the re-send delta. This complements the
   existing Compaction panel (which shows *events*; this shows *bytes*).
4. **Dashboard**: extend the Context tab with a per-session view (select a
   session → line chart of request chars over the turn sequence, compaction
   markers overlaid). Keep it behind a "has payloads" check like the
   Payloads tab's existence probe (`/api/payloads`).

## Acceptance

- For a session with at least one compaction and ≥5 requests, the view
  shows: request-size trend, the compaction drop, and the re-send delta.
- Payloads absent → the view degrades to the current first-call panel with
  a hint (never an error).
- Numbers from payloads are labeled as **wire-format characters** — do NOT
  mix them into the first-call bars (those count pi's intermediate
  representation, ~5.4k for stock vs ~6.5k wire). Two scales, two labels.

## Gotchas

- Wire-format counts are not comparable to the recorder's intermediate
  counts (this bit SpecPi too: their chart counts OpenAI envelope JSON).
  Keep the data sources visually separate on the panel.
- The exporter is opt-in; sessions without payloads simply don't appear.
  Consider whether the Search-Adoption-style "existence probe" UX is
  enough, or whether to enable the exporter on one profile by default for a
  measurement period (privacy: payloads contain full conversation content —
  local-only files, but disk grows; check retention/cleanup story first).
- pi-omp-stats is outside the complexity/CRAP gates but is a global
  installed tool: after changes run
  `node scripts/install.mjs --yes --all` (rebuilds the bin and restarts
  the service) and verify at the live dashboard.
- Frontend conventions: single `dashboard.html`, vanilla JS, `table()` /
  `card()` / `ensureChart` / `baseChartOpts` helpers, Chart.js from CDN
  with local fallback. Prettier formats the HTML — run
  `npx prettier --write packages/pi-omp-stats/src/dashboard.html` before
  committing or `npm run format:check` fails.
