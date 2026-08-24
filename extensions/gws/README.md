# gws — Google Workspace skills (mode-gated)

Vendors [Google Workspace CLI][gws] agent skills for **Docs, Sheets, Drive,
and Gmail** and gates them behind a `/gws` mode so they stay out of context
until you opt in.

[gws]: https://github.com/googleworkspace/cli

## Why mode-gated?

The `gws` repo ships 100+ skills. Loading all of them into every session
would bloat the system prompt for anyone not actively using Workspace. This
extension vendors only the four services you care about (plus the shared
auth/flags reference and each service's granular helper sub-skills) and keeps
them off pi's skill-discovery paths, so pi never loads them automatically.
They enter context **only** after you run `/gws on`.

## Usage

```
/gws on        enable gws skills for the rest of the session
/gws off       disable them again
/gws toggle    flip the mode
/gws           show status
```

State persists in `<configDir>/gws.json` (`{ enabled: boolean }`), default
off. The mode is read fresh on every turn, so toggling takes effect on your
next message — no `/reload` needed.

You can also toggle the whole extension off from `/settings` → Tools &
Safety → Google Workspace (feature id `gws`); that requires `/reload`.

## What gets injected

When enabled, the extension parses the **5 primary** SKILL.md files and lists
them in the system prompt's `<available_skills>` block:

| Skill | Description |
| --- | --- |
| `gws-shared` | auth, global flags, output formatting |
| `gws-docs` | Read and write Google Docs |
| `gws-sheets` | Read and write spreadsheets |
| `gws-drive` | Manage files, folders, and shared drives |
| `gws-gmail` | Send, read, and manage email |

The granular helper sub-skills (`gws-gmail-send`, `gws-docs-write`,
`gws-sheets-read`, `gws-drive-upload`, …) are **on disk as siblings** but not
listed in the prompt — the primary skills link to them via relative paths
(`../gws-gmail-send/SKILL.md`), and the model loads them on demand with the
`read` tool, exactly like any other skill. This keeps context minimal while
preserving full functionality.

## Prerequisites

The `gws` binary must be on `$PATH` and authenticated. See the upstream
[Quick Start](https://github.com/googleworkspace/cli#quick-start):

```bash
gws auth setup     # one-time: creates a Cloud project, enables APIs, logs you in
gws auth login     # subsequent logins
```

The skills themselves only tell the model how to call `gws`; they don't
install or authenticate it.

## How injection works (implementation note)

`before_agent_start` does two things when the mode is on:

1. **Mutates `event.systemPromptOptions.skills`** — pushes the 5 skill objects
   in, so the optional `system-prompt` extension (which rebuilds the whole
   prompt from `systemPromptOptions`) re-emits them if it runs after us.
2. **Appends an `<available_skills>` block to `event.systemPrompt`** — so the
   skills appear even if `system-prompt` already ran or is disabled.

At most one copy survives: if `system-prompt` rebuilds after us it overwrites
our append and re-emits skills from `opts.skills` (with ours); if it ran
before us or is absent, our append is the sole copy.

## Vendored source

`skills/gws-*/SKILL.md` are copied verbatim from
`https://github.com/googleworkspace/cli/tree/main/skills` at upstream
metadata **version 0.22.5** (Apache-2.0). Re-vendor with:

```bash
for d in gws-shared gws-docs gws-docs-write gws-sheets gws-sheets-append \
         gws-sheets-read gws-drive gws-drive-upload gws-gmail gws-gmail-forward \
         gws-gmail-read gws-gmail-reply-all gws-gmail-reply gws-gmail-send \
         gws-gmail-triage gws-gmail-watch; do
  curl -sfL "https://raw.githubusercontent.com/googleworkspace/cli/main/skills/$d/SKILL.md" \
    -o "extensions/gws/skills/$d/SKILL.md"
done
```
