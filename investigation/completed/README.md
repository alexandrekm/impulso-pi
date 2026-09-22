# Completed investigations

Investigations and plans whose question was answered or whose plan shipped.
Kept for provenance; nothing here is active work.

Living documents stay in the parent `investigation/` directory:

- `PROFILES.md` — the repo's full design doc (linked from AGENTS.md)
- `EXTENSIONS.md` / `OMP-MAPPING.md` / `ORCHESTRATION.md` — living
  ecosystem reference catalogs, cross-linked to each other
- `context-measurement.json` — active data, written by
  `npm run measure:context -- --record` and read by CI
- `CONTEXT-*.md` / `ZVEC-ADOPTION-REVIEW.md` — pending handoffs

## Contents

- `CACHE-OPTIMIZERS.md` — Aug 2026 evaluation of
  `jiangge/pi-cache-optimizer`. Verdict: legit and honestly engineered, but
  the repo built its own `extensions/cache-ttl/` (PI_CACHE_RETENTION bridge)
  instead; see the cache-ttl entry in AGENTS.md.

- `CONTEXT-RECORDER-V2.md` — the context-recorder v2 handoff (cache-bust
  hashes, record history, prompt attribution). Shipped 2026-09-22 as all
  three items; see the context-measure entry in AGENTS.md and PR #116.
- `SUBAGENT-SCOUT-ORCA-PLAN.md` — the scout-subagent implementation plan.
  Shipped: pi-subagents pinned core with pruned bundled skills, scout
  delegation only, Orca passive observation; see the pi-subagents entry in
  `profiles.jsonc` and the scout skill.
- `slack-mcp/oauth-test.py` — one-shot OAuth PKCE probe against Slack's
  official MCP server, from the Slack integration investigation. The
  shipped integration went the `slackcli` route instead (`skills/slack/`).
