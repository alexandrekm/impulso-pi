# system-prompt

Owns the **fixed** parts of pi's system prompt while keeping the **dynamic**
parts flowing from pi.

## Why

Pi assembles its system prompt from a mix of fixed text (the intro, the
always-on guidelines, Pi documentation instructions) and dynamic content (the
active tools list, tool-contributed guidelines, `--append-system-prompt`,
loaded `<project_context>` files, skills, cwd). This extension lets you rewrite
the fixed parts without losing the dynamic ones — so tool activation, AGENTS.md
loading, skill discovery, `/append`, etc. keep working unchanged.

The default customization replaces Pi's verbose always-on documentation block
with a one-line pointer to the model-invocable `pi-development` skill. The full
Pi modification workflow is then loaded only for Pi-specific work.

## How it works

In the `before_agent_start` hook, the extension reassembles the prompt from
`event.systemPromptOptions` (the structured pieces pi already computed),
substituting our own constants for the fixed text:

| Part | Source |
| --- | --- |
| Intro ("You are an expert coding assistant…") | `INTRO` constant |
| "In addition to the tools above…" line | `TOOLS_FOOTER` constant |
| Always-on guidelines | `ALWAYS_ON_GUIDELINES` |
| Pi-development pointer | `PI_DEVELOPMENT_SKILL_POINTER`, when that skill is loaded |
| Available tools list | `opts.selectedTools` + `opts.toolSnippets` |
| Tool-contributed guidelines | `opts.promptGuidelines` |
| `--append-system-prompt` / `APPEND_SYSTEM.md` | `opts.appendSystemPrompt` |
| `<project_context>` (AGENTS.md etc.) | `opts.contextFiles` |
| Skills block | `opts.skills` |
| cwd | `opts.cwd` |

The intro, footer, and guidelines match Pi defaults. Replacing Pi's
documentation block with the skill pointer is an intentional divergence.

## Safety

- **Respects user overrides:** if `opts.customPrompt` is set (`SYSTEM.md` /
  `--system-prompt`), the handler returns nothing — pi's custom-prompt branch
  is left alone.
- **Toggleable:** guards on `isFeatureEnabled("system-prompt")`, so `/settings`
  (feature id `system-prompt`, Pi tab) can turn it off → pi's stock prompt is
  used verbatim after `/reload`.

## Customizing the fixed parts

Edit the constants at the top of `system-prompt.ts`
(`INTRO`, `TOOLS_FOOTER`, `ALWAYS_ON_GUIDELINES`,
`PI_DEVELOPMENT_SKILL_POINTER`) and `/reload`. The dynamic parts keep flowing
from pi automatically. Edit `skills/pi-development/SKILL.md` to change the
on-demand Pi-development instructions.

## Tracking upstream drift

`scripts/check-upstream-prompt.mjs` snapshots Pi's default system prompt
(deterministic inputs, runtime-resolved paths + cwd redacted) into
`upstream-prompt.golden` and compares it to the installed development dependency.

The system-prompt extension intentionally differs from that baseline by replacing
the Pi documentation block; the golden check reports changes to the **upstream**
prompt only.

Run the full checks after updating the prompt or skill:
```bash
npm run typecheck && npm run lint && npm run check:json && npm test
```
