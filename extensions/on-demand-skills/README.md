# on-demand-skills

Keep skills out of the always-on system prompt and inject a pointer only when
the user's message actually mentions them — appended to the **user message**,
not the system prompt.

## Why

Skills listed in the system prompt (`<available_skills>`) cost context on every
turn even when never used. Pi's `disable-model-invocation: true` frontmatter key
removes a skill from that block (the skill stays registered, so `/skill:<name>`
still works and its files are still readable) — but then the model has no idea
the skill exists. This extension bridges that gap: it watches each user message
for configured keywords and, on a match, **appends a small pointer to the user's
own message text** telling the model to `read` the skill file. No match, no
append, zero cost. The system prompt is never modified.

## How it works

On pi's `input` event (which fires before the user message is built):

1. Read `extensions/on-demand-skills/config.json` → map of `skill name → { keywords, hint }`.
2. For each configured skill, resolve `<configDir>/skills/<name>/SKILL.md` and
   skip silently if it isn't present (the skill isn't installed on this profile).
3. Case-insensitive, word-boundary match the user's text against the skill's
   `keywords` (a trailing `s` is tolerated: `dashboard` → `dashboards`).
4. For every matched skill, replace `{path}` in its `hint` with the skill's
   `SKILL.md` path and append all matched hints to the user's text inside a
   `<skill_hint>…</skill_hint>` block.
5. Return `{ action: "transform", text }` so pi uses the augmented text as the
   user message content.

Slash-command inputs (text starting with `/`) are passed through untouched, so
the extension never interferes with command routing or `/skill:<name>`
expansion (which already loads the skill inline).

## Why the `input` hook, not `before_agent_start`

The hint is part of the **user message**, not the system prompt, so it reads as
the user's turn ("use this skill to do this") rather than global instructions.
`before_agent_start` can't do this: by the time it fires the user message is
already built, and its result can only replace the system prompt or add a
separate "custom" role message. The `input` event is the one hook that rewrites
the submitted text itself.

## What the model sees

For a message like `check the latency on the payments dashboard`, the user
message content becomes:

```
check the latency on the payments dashboard

<skill_hint>
Use the Datadog skill at /Users/.../skills/datadog/SKILL.md — load it with the `read` tool for how to interact with Datadog via the `pup` CLI (dashboards, metrics, monitors, logs, SLOs, synthetics, APM).
</skill_hint>
```

For `fix the typo in the README` (no keyword match), the message is unchanged.

### Repeats are cheap (no de-dup)

The hint is ~45 tokens, so if a later message also mentions a keyword (e.g.
`now tweak the dashboard`) the pointer is just appended again — no history
scan. The model won't re-read a file it already has in context, and after a
compaction a fresh append is exactly what's wanted (the prior hint and skill
content were folded into the summary).
## Config

`config.json` (live next to `index.ts`; read fresh each turn, so edits apply on
the next message — no `/reload` needed for config changes):

```jsonc
{
  "triggers": {
    "datadog": {
      "keywords": ["datadog", "dashboard", "metric", "monitor", "pup", "slo", "synthetics", "apm"],
      "hint": "Use the Datadog skill at {path} — load it with the `read` tool ..."
    }
  }
}
```

- `keywords` — matched as case-insensitive word boundaries. Keep them specific
  enough to avoid false positives (e.g. `logs`/`trace` are intentionally
  omitted — too generic).
- `hint` — the pointer text appended to the user message. `{path}` is replaced
  with the skill's `SKILL.md` path.
- A trigger only fires if `<configDir>/skills/<name>/SKILL.md` exists on the
  current profile (e.g. `datadog` is `work`-tagged, so on `personal` it no-ops).

## Adding a skill

1. Add `disable-model-invocation: true` to the skill's `SKILL.md` frontmatter
   (so it's dropped from the always-on `<available_skills>` block).
2. Add an entry under `triggers` in `config.json`.
3. Send a message (config is read fresh each turn).

**Note on package-provided skills:** path resolution assumes the skill lives at
`<configDir>/skills/<name>/SKILL.md`, which is true for all repo-local skills
synced by `install.sh`. Skills shipped inside npm packages live elsewhere; to
trigger one of those, set its `hint` to the known absolute path instead of
relying on `{path}`.

## Toggle

`/settings` → Pi → System prompt → **On-demand skills (keyword)**. Off = the
extension registers nothing and adds no context.
