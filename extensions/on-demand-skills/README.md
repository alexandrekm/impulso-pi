# on-demand-skills

Keep skills out of the always-on system prompt and inject a pointer only when
the user's message actually mentions them.

## Why

Skills listed in the system prompt (`<available_skills>`) cost context on every
turn even when never used. Pi's `disable-model-invocation: true` frontmatter key
removes a skill from that block (the skill stays registered, so `/skill:<name>`
still works and its files are still readable) — but then the model has no idea
the skill exists. This extension bridges that gap: it watches each user message
for configured keywords and, on a match, appends a tiny pointer telling the model
to `read` the skill file. No match, no injection.

## How it works

On `before_agent_start`:

1. Read `extensions/on-demand-skills/config.json` → map of `skill name → { keywords, hint }`.
2. For each configured skill, look it up in `event.systemPromptOptions.skills`
   to get its on-disk `filePath` (skip if not installed on this profile).
3. Case-insensitive, word-boundary match `event.prompt` against the skill's
   `keywords`.
4. For every matched skill, build a small `<on_demand_skills>` block (the
   `hint` with `{path}` replaced by the skill's `filePath`) and inject it.

Injection is robust against the optional `system-prompt` extension (which
rebuilds the whole prompt from `systemPromptOptions` and would otherwise
overwrite us, or be overwritten by us, depending on load order) using the same
dual-channel trick as the `gws` extension:

- **Channel 1** — mutate `opts.appendSystemPrompt` so a `system-prompt`
  extension that runs *after* us re-emits the pointer when it rebuilds.
- **Channel 2** — return `{ systemPrompt: event.systemPrompt + block }` so a
  `system-prompt` extension that already ran (or native pi with no
  `system-prompt` extension) still gets the pointer.

The block is self-delimiting (`<on_demand_skills>…</on_demand_skills>`) and is
**stripped before re-injection** every turn, so there is never a stale or
duplicate pointer even though `opts` is reused across turns (channel 1) and
`event.systemPrompt` may carry a stale block from the previous turn (channel 2).
`opts.appendSystemPrompt` is recomputed from its *stripped* (original) value
each turn, so nothing accumulates.

## Config

`config.json` (live next to `index.ts`; edit and `/reload`):

```jsonc
{
  "triggers": {
    "datadog": {
      "keywords": ["datadog", "dashboard", "metric", "monitor", "pup", "slo", "synthetics", "apm"],
      "hint": "The user mentioned Datadog. Read the Datadog skill file at {path} with the `read` tool to learn the `pup` CLI (dashboards, metrics, monitors, logs, SLOs, synthetics, APM), then proceed with the task."
    }
  }
}
```

- `keywords` — matched as case-insensitive word boundaries. Keep them specific
  enough to avoid false positives (e.g. `logs`/`trace` are intentionally
  omitted — too generic).
- `hint` — the pointer text. `{path}` is replaced with the skill's `filePath`.
- A trigger only fires if the named skill is actually loaded on the current
  profile (e.g. `datadog` is `work`-tagged, so on `personal` the trigger no-ops).

## Adding a skill

1. Add `disable-model-invocation: true` to the skill's `SKILL.md` frontmatter
   (so it's dropped from the always-on `<available_skills>` block).
2. Add an entry under `triggers` in `config.json`.
3. `/reload` (or just send a message — config is read fresh each turn).

## Toggle

`/settings` → Pi → System prompt → **On-demand skills (keyword)**. Off = the
extension registers nothing and adds no context.
