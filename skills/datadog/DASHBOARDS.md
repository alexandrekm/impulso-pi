# Dashboards

List, get, edit, create, and share Datadog dashboards via `pup dashboards`. Read access needs `dashboards_read` on your app key.

**Edit a single widget → use `pup dashboards widgets`** (lighter than rewriting the whole dashboard). **Edit many widgets / restructure → get the whole dashboard JSON, patch, `update`.** `update` replaces the dashboard entirely, so always start from a fresh `get` and preserve `id`, `author_handle`, `template_variables`, `tabs`, and the widgets you're not touching.

## List (find one by name)
```bash
pup dashboards list --jq '.dashboards[].title'     # titles only (payload is {"dashboards":[...]})
pup dashboards list -o table                       # with ids
```
Each item: `id`, `title`, `author_handle`, `is_read_only`, `layout_type`, `url` (relative path).

## Get (full JSON → file)
```bash
pup dashboards get <DASHBOARD_ID> > dash.json
```
Top-level keys include `widgets` (top-level array), `tabs`, `template_variables`, `layout_type`, `title`.

## Edit a single widget — `pup dashboards widgets` (preferred)
```bash
pup dashboards widgets list <DASHBOARD_ID>                 # index, id, type, title, layout
pup dashboards widgets get <DASHBOARD_ID> --widget-id 210  # one widget's full JSON (--index <N> also works)
pup dashboards widgets types                                # all supported widget type strings
pup dashboards widgets schema timeseries                    # ready-to-edit skeleton JSON for a type
pup dashboards widgets add <DASHBOARD_ID> --file widget.json       # append a widget ('-' for stdin)
pup dashboards widgets update <DASHBOARD_ID> --widget-id 210 --file widget.json   # replace one
pup dashboards widgets remove <DASHBOARD_ID> --widget-id 210       # delete one
```
Use `schema <type>` to scaffold a new widget, then `add`.

## Edit the whole dashboard (get → patch file → diff → update)
```bash
pup dashboards get <DASHBOARD_ID> > dash.json
# edit dash.json:
#   - rename:                       top-level "title"
#   - a widget's query (new):       widgets[].definition.requests[].queries[].query
#   - a widget's query (legacy):    widgets[].definition.requests[].q
#   - add a widget:                 append to widgets[]
#   - remove a widget:              drop its entry (or use `widgets remove`)
pup dashboards diff <DASHBOARD_ID> --file dash.json   # preview changes
pup dashboards update <DASHBOARD_ID> --file dash.json # push
```

## Create
```bash
pup dashboards create --file new-dash.json
```
```json
{
  "title": "My new dashboard",
  "layout_type": "ordered",
  "widgets": [
    {"definition": {"type": "timeseries", "requests": [{"q": "avg:system.cpu.user{*}"}], "title": "CPU"}}
  ]
}
```

## Shareable URL
`pup dashboards url <ID> [--from=now-1w --to=now --live=true]` exists but is **broken in pup 1.12.1** (errors: "relative URL without a base"). Until fixed, build it manually from the `url` field returned by `get`/`list`: prepend your site's app host —
`https://app.datadoghq.com/dashboard/<id>/<slug>` (US1 / EU uses `app.datadoghq.eu`; US3/US5/AP1/UK1 use `us3.datadoghq.com` / `us5.datadoghq.com` / `ap1.datadoghq.com` / `uk1.datadoghq.com` with no `app.` prefix). Add `?from=<unix-s>&to=<unix-s>&live=true` for a time-scoped live link.

## Other
`delete <ID>`; `annotations list|get-page|create|update|delete`. Shared/public dashboards, restore-deleted, and usage stats aren't exposed as subcommands in 1.12.1 — use `pup api` (raw authenticated request) or the REST endpoints in `skill://datadog/REFERENCE.md`.
