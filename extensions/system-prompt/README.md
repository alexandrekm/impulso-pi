# system-prompt

Owns the **fixed** parts of pi's system prompt while keeping the **dynamic**
parts flowing from pi.

## Why

Pi assembles its system prompt from a mix of fixed text (the intro, the
"Pi documentation" block, the always-on guidelines) and dynamic content (the
active tools list, tool-contributed guidelines, `--append-system-prompt`,
loaded `<project_context>` files, skills, cwd). This extension lets you
rewrite the fixed parts without losing the dynamic ones — so tool
activation, AGENTS.md loading, skill discovery, `/append`, etc. keep working
unchanged.

## How it works

In the `before_agent_start` hook, the extension reassembles the prompt from
`event.systemPromptOptions` (the structured pieces pi already computed),
substituting our own constants for the fixed text:

| Part | Source |
| --- | --- |
| Intro ("You are an expert coding assistant…") | `INTRO` constant |
| "In addition to the tools above…" line | `TOOLS_FOOTER` constant |
| Always-on guidelines | `ALWAYS_ON_GUIDELINES` |
| Pi-docs block prose | `PI_DOCS_BLOCK` template |
| Pi-docs block paths (readme/docs/examples) | extracted from pi's prompt (kept dynamic) |
| Available tools list | `opts.selectedTools` + `opts.toolSnippets` |
| Tool-contributed guidelines | `opts.promptGuidelines` |
| `--append-system-prompt` / `APPEND_SYSTEM.md` | `opts.appendSystemPrompt` |
| `<project_context>` (AGENTS.md etc.) | `opts.contextFiles` |
| Skills block | `opts.skills` |
| cwd | `opts.cwd` |

The constants are currently **byte-identical** to pi's defaults, so behaviour
is unchanged until you deliberately edit them.

## Safety

- **Respects user overrides:** if `opts.customPrompt` is set (`SYSTEM.md` /
  `--system-prompt`), the handler returns nothing — pi's custom-prompt branch
  is left alone.
- **Safe no-op:** if it can't extract the doc paths from the prompt
  (unexpected shape / older pi), it bails and leaves pi's prompt untouched.
- **Toggleable:** guards on `isFeatureEnabled("system-prompt")`, so `/settings`
  (feature id `system-prompt`, Pi tab) can turn it off → pi's stock prompt is
  used verbatim after `/reload`.

## Customizing the fixed parts

Edit the constants at the top of `system-prompt.ts`
(`INTRO`, `TOOLS_FOOTER`, `ALWAYS_ON_GUIDELINES`, `PI_DOCS_BLOCK`) and
`/reload`. The dynamic parts keep flowing from pi automatically.

## Tracking upstream drift

`scripts/check-upstream-prompt.mjs` snapshots pi's default system prompt
(deterministic inputs, runtime-resolved paths + cwd redacted) into
`upstream-prompt.golden` and compares on every CI run. If pi changes any
fixed text, CI fails with a diff.

When that happens:

1. Review the diff.
2. If you want to track upstream, update the constants in `system-prompt.ts`
   to match.
3. Update the golden baseline:
   ```bash
   node scripts/check-upstream-prompt.mjs --update
   ```
4. Re-run: `npm run typecheck && npm run lint && npm test`

If you've **intentionally** diverged your constants from pi's defaults, you
don't need to touch them — just update the golden so the drift baseline
reflects the new upstream:
```bash
node scripts/check-upstream-prompt.mjs --update
```
