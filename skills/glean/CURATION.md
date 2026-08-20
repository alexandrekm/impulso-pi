# Curation: pins, answers, announcements

Promote search results (pins), curate Q&A pairs (answers), and post time-bounded announcements — all via `glean <namespace>`. Each is a thin CRUD surface; all take `--json`, `--output`, `--fields`, `--dry-run`.

## Pins (promoted search results)

Subcommands: `list`, `get`, `create`, `update`, `remove`.

```bash
glean pins list
glean pins create --json '{"queries":["onboarding"],"documentId":"https://…"}'
glean pins update --json '{"id":"<pinId>","queries":["onboarding","new-hire"]}'
glean pins remove --json '{"id":"<pinId>"}'
```

A pin boosts a specific document to the top for one or more queries. `documentId` is the URL/ID from `glean search` results. `create` takes `queries[]` (repeatable query strings) + `documentId`.

## Answers (curated Q&A pairs)

Subcommands: `list`, `get`, `create`, `update`, `delete`.

```bash
glean answers list
glean answers create --json '{"question":"How do I request time off?","answer":"See the PTO policy…","sourceUrl":"https://…"}'
glean answers get --json '{"id":"<id>"}'
glean answers update --json '{"id":"<id>","answer":"Updated answer…"}'
glean answers delete --json '{"id":"<id>"}'
```

Answers surface authoritative Q&A in Glean search & Assistant. Inspect exact field names with `glean schema answers` — the create body mirrors the Glean Answers API.

## Announcements (time-bounded company announcements)

Subcommands: `create`, `update`, `delete` (no `list`/`get` — manage via Glean Admin UI).

```bash
glean announcements create --json '{"title":"Office closure","body":"Offices closed Jul 4.","startTime":1719792000,"endTime":1719878400}'
glean announcements update --json '{"id":"<id>","body":"Updated text"}'
glean announcements delete --json '{"id":"<id>"}'
```

`startTime`/`endTime` are unix timestamps (seconds). Announcements appear in Glean for the window, then expire. Always `--dry-run` before creating — these are company-visible.
