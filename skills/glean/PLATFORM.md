# Platform: tools, verification, insights, messages, activity

Read and admin surfaces beyond search/chat. All take `--json`, `--output`, `--fields`, `--dry-run` (except thin list-only commands).

## tools (Glean platform tools)

Subcommands: `list`, `run`.

```bash
glean tools list
glean tools run --json '{"toolId":"<id>","input":{…}}'
```

List available Glean platform tools, then run one. Inspect each tool's input shape before `run` — check the Glean Tools API docs or `glean schema tools`.

## verification (document verification & review)

Subcommands: `list`, `verify`, `remind`.

```bash
glean verification list --json '{"query":"…"}'    # documents pending verification
glean verification verify --json '{"documentIds":["https://…"]}'   # mark verified
glean verification remind --json '{"documentIds":["https://…"]}'   # nudge owners to review
```

Verification is Glean's doc-freshness review loop — docs whose content may be stale get flagged for an owner to confirm. Use `list` to find stale docs, `remind` to nudge owners, `verify` to mark them current.

## insights (search & usage analytics)

Subcommands: `get`.

```bash
glean insights get --json '{"type":"SEARCHES","range":"PAST_7_DAYS"}'
```

Returns analytics (top searches, no-result searches, usage) over a range. Exact field names (`type`, `range`, filters) follow the Glean Insights API — run `glean schema insights` for the current shape.

## messages (indexed messages)

Subcommands: `get`.

```bash
glean messages get --json '{"query":"deploy","datasource":"slack"}'
```

Retrieves indexed messages from sources like Slack / Teams. Useful for finding a decision or context that lives in chat, not docs.

## activity (user activity reporting)

Subcommands: `report`, `feedback`.

```bash
glean activity report --json '{"range":"PAST_30_DAYS"}'
glean activity feedback --json '{"query":"…"}'
```

`report` = user activity over a range; `feedback` = collected feedback signals. Both are analytics reads — inspect `glean schema activity` for current parameters.
