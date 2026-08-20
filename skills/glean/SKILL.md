---
name: glean
description: Use Glean via the glean CLI — search company knowledge, chat with Glean Assistant, look up people, manage collections/shortcuts/pins/agents.
author: alexandre.mendonca
tags: [glean, search, knowledge, cli]
---

# Glean (glean CLI)

Use Glean via the **`glean` CLI** — Glean's agent-first CLI that exposes the full Glean REST API surface with structured JSON output, `--dry-run` previews, and `glean schema` introspection. Install/auth/server setup lives in `skill://glean/REFERENCE.md`.

Announce at start: "I'm using the glean skill to <task>."

## Usage

Command pattern: `glean <command> [subcommand] [flags]` (e.g. `glean search "…"`, `glean documents summarize --json '{…}'`). Run `glean <command> --help` or `glean schema <command>` for exact flags.

Key global flags: `--output json|ndjson|text` (default `json`), `--fields '<dot-paths>'` (project fields — for search, prefix with `results.`), `--json '<body>'` (raw SDK request body, overrides all other flags), `--dry-run` (print request body without sending).

## Feature files (load on demand)

Each area is a self-contained file — `read skill://glean/<FILE>` only when the task needs it.

| Need | Load |
|------|------|
| **Search** (query, datasource/type filters, NDJSON streaming, field projection) | `skill://glean/SEARCH.md` |
| **Chat** (Glean Assistant — ask, summarize, pipe stdin) | `skill://glean/CHAT.md` |
| **Documents** (get, summarize, get-by-facets, get-permissions) | `skill://glean/DOCUMENTS.md` |
| **Entities / People** (list, read-people — teams & org lookup) | `skill://glean/ENTITIES.md` |
| **Agents** (list, get, schemas, run — Glean AI agents) | `skill://glean/GLEAN-AGENTS.md` |
| **Collections** (curated doc collections: CRUD + add/delete items) | `skill://glean/COLLECTIONS.md` |
| **Shortcuts** (go-links / memorable URLs, incl. {arg} templates) | `skill://glean/SHORTCUTS.md` |
| **Curation** (pins, answers, announcements) | `skill://glean/CURATION.md` |
| **Platform** (tools, verification, insights, messages, activity) | `skill://glean/PLATFORM.md` |
| **Raw API** (any Glean REST endpoint, `--method`/`--raw-field`) | `skill://glean/API.md` |
| Install + auth + server URL + global flags + full command index | `skill://glean/REFERENCE.md` |
| Common mistakes | `skill://glean/TROUBLESHOOTING.md` |
