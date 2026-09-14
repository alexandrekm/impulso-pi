---
name: obsidian
description: Read, search, create, and edit notes in the Obsidian vault via the official Obsidian CLI — daily notes, meeting notes, tasks, tags/properties, search, backlinks. The CLI is an IPC client to the running Obsidian desktop app. Use when working with the Motive vault or any Obsidian note workflow.
author: alexandre.mendonca
tags: [obsidian, notes, vault, docs]
---

# Obsidian

Interact with the Obsidian vault via the official `obsidian` CLI (shipped with
the desktop app, v1.12+). The CLI is an **IPC client to the running Obsidian
app**, not a file reader: the app resolves names, updates backlinks/indexes,
and runs plugin processing (templates, tasks) on every write. Prefer it over
editing vault files on disk directly.

**Requires** the Obsidian app running and *Settings → General → Advanced →
Command line interface* enabled. Verify before first use:

```bash
obsidian version          # e.g. 1.13.7 (installer 1.13.7)
obsidian vaults verbose   # Motive   /Users/<user>/Documents/Obsidian/Motive
```

- `obsidian: command not found` → the PATH symlink is missing:
  `ln -sf "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli" ~/.local/bin/obsidian`
- "Command line interface is not enabled" → the user must toggle it in the app
  (Settings → General → Advanced). No terminal equivalent.

Announce at start: "I'm using the obsidian skill to …"

## Rules

1. **Ask before writing.** Reads are free; confirm before `create`, `append`,
   `prepend`, `move`, `rename`, `delete`, `property:set`, `property:remove`,
   `template:insert`. Exception: the user explicitly requested that exact write
   (e.g. "add X to today's daily note" → `daily:append` is fine).
2. **Always pass an explicit `file=` or `path=` on writes.** Most commands
   default to the **active file** in the app UI when omitted — an append
   without a target lands in whatever the user has open. Never rely on that
   default.
3. **`delete` goes to trash by default.** Never add `permanent` unless the
   user asked.
4. **One vault: `Motive`.** The CLI targets the most recently active vault;
   prefix `vault="Motive"` only if more vaults ever appear.
5. **`format=json` for anything you'll parse.** `tags`, `tasks`, `search`,
   `backlinks` and friends all support `format=json|tsv|csv`.

## Syntax

- Parameters are bare `key=value` (no dashes), quoted when they contain spaces:
  `obsidian search query="meeting notes" limit=10`
- `file=<name>` resolves like a **wikilink** (basename, no `.md` needed);
  `path=<path>` is exact (`path="meetings/weekly-summaries/x.md"`). Prefer
  `path=` for writes — `file=` can hit an unexpected note with the same name.
- Newlines/tabs in `content=` are literal `\n` / `\t`:
  `content="# Title\n\nBody"`.
- `obsidian help <command>` is authoritative for every flag.

## Quick command reference

| Operation | Command |
|-----------|---------|
| Vault info | `obsidian vault info=path` · `vaults verbose` |
| List files / folders | `obsidian files` · `files folder="meetings"` · `folders` |
| Read note | `obsidian read path="meetings/note.md"` |
| Search (paths) | `obsidian search query="…" limit=10 format=json` |
| Search (with lines) | `obsidian search:context query="…"` |
| Daily note | `obsidian daily:path` · `daily:read` · `daily:append content="…"` · `daily:prepend` |
| Create note | `obsidian create path="folder/Note" content="…"` (`template=Name`, `open` to focus it) |
| Append / prepend | `obsidian append path="…" content="…"` · `prepend` |
| Move / rename | `obsidian move path="a.md" to="folder/b.md"` · `rename file="x" name="y"` |
| Delete | `obsidian delete path="…"` (trash; `permanent` only on request) |
| Tasks | `obsidian tasks todo` · `tasks daily` · `task path="n.md" line=12 toggle` |
| Tags | `obsidian tags counts sort=count` · `tag name="meetings" verbose` |
| Properties | `obsidian properties path="n.md" format=json` · `property:set path=… name=status value=active type=text` |
| Link graph | `obsidian backlinks file="Note" counts` · `links` · `orphans` · `unresolved` · `deadends` |
| Outline | `obsidian outline path="…" format=md` |
| Templates | `obsidian templates` · `template:read name="…"` · `template:insert name="…"` (active file) |
| Word count | `obsidian wordcount path="…"` |
| Versions | `obsidian history path="…"` · `history:read version=2` · `diff file=… from=1 to=3` |

**Avoid unless the user asks** (destructive or app-level): `eval`,
`command id=…`, `restart`, `sync off`, `sync:restore`, `plugin:*`, `theme:*`,
`dev:*`, `delete … permanent`.

## Vault notes

- Daily notes live at the vault root (`YYYY-MM-DD.md`); get the current one
  with `daily:path` — it returns the path even if the note doesn't exist yet.
- Weekly meeting summaries live under `meetings/weekly-summaries/`.
- Machine-local vault specifics (folders, note ids) belong in an unversioned
  `skills/obsidian/LAYOUT.md` companion (see the non-clobber section in
  AGENTS.md) — add one if this skill starts hardcoding paths.
