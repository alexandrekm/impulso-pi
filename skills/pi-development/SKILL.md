---
name: pi-development
description: Develop, modify, or investigate pi itself, including its SDK, extensions, skills, themes, TUI, prompt templates, providers, models, packages, settings, or keybindings. Load before acting on a pi-specific task.
---

# Pi Development

Use this skill for work on pi itself or its customization surface. Prefer pi's documented extension, skill, template, theme, and package mechanisms over modifying pi internals unless the user explicitly needs a core change.

## 1. Locate the installed documentation

Resolve the installed package root rather than treating `docs/...` or `examples/...` as paths relative to the current project:

```bash
PI_ROOT="$(node -e 'const fs = require("node:fs"); const path = require("node:path"); console.log(path.dirname(path.dirname(fs.realpathSync(process.argv[1]))));' "$(command -v pi)")"
printf 'README: %s\nDocs: %s\nExamples: %s\n' "$PI_ROOT/README.md" "$PI_ROOT/docs" "$PI_ROOT/examples"
```

- Main documentation: `$PI_ROOT/README.md`
- Additional documentation: `$PI_ROOT/docs/`
- Working examples: `$PI_ROOT/examples/`

Read the relevant document **completely** before implementing, then follow its relevant Markdown links. Read matching examples as well when they exist.

## 2. Choose the right customization mechanism

- **Extension**: behavior, tools, commands, event interception, provider integration, custom UI, rendering, or session behavior. Read `docs/extensions.md` and relevant `examples/extensions/`.
- **Skill**: an on-demand specialized workflow or domain instructions. Read `docs/skills.md`.
- **Prompt template**: reusable user-invoked prompt. Read `docs/prompt-templates.md`.
- **Theme or TUI component**: appearance or custom terminal UI. Read `docs/themes.md` and/or `docs/tui.md`; follow their linked examples.
- **Package**: distribute extensions, skills, prompts, or themes. Read `docs/packages.md`.
- **Provider or model**: custom provider/auth/API or model catalog configuration. Read `docs/custom-provider.md` and/or `docs/models.md`.

For Pi SDK work, read `docs/sdk.md` and `examples/sdk/`. For settings, keybindings, environment, compaction, session format, RPC, or tools, start with the correspondingly named file under `docs/`.

## 3. Topic index

| Task | Read first |
| --- | --- |
| Extension | `docs/extensions.md`, `examples/extensions/` |
| Skill | `docs/skills.md` |
| Theme | `docs/themes.md` |
| Prompt template | `docs/prompt-templates.md` |
| TUI component | `docs/tui.md` |
| Keybinding | `docs/keybindings.md` |
| SDK integration | `docs/sdk.md`, `examples/sdk/` |
| Custom provider | `docs/custom-provider.md` |
| Models | `docs/models.md` |
| Pi package | `docs/packages.md` |
| Environment variable | `docs/environment-variables.md` |

## 4. Source-level work

If source behavior, internals, or undocumented implementation details matter, inspect a source checkout if the project provides one. Follow the project's instructions on its location and whether it is read-only. Do not clone or alter a reference checkout without the user's approval when the project instructions require it.

After making a pi customization, run the project's relevant validation and reload/test it using the documented workflow.
