# Monitors (alert rules)

List, get, create, update, diff, delete, and search Datadog monitors via `pup monitors`. Read access needs `monitors_read`; writes need `monitors_write`.

## List (bare array — jq `.[]`)
```bash
pup monitors list --tags="env:prod"            # filter by tag (comma-separated)
pup monitors list --name="cpu" --limit 50      # filter by name; --limit max 1000 (default 200), --page 0-indexed
pup monitors list --jq '.[] | {id, name, state: .overall_state}'
```

## Search (dict response; uses --per-page, not --limit)
```bash
pup monitors search --query="cpu" [--per-page 30] [--page 0] [--sort <sort>]
```

## Get one monitor
```bash
pup monitors get <MONITOR_ID>          # full definition: type, query, options, thresholds, message, tags
```

## Create
```bash
pup monitors create --file monitor.json
```
```json
{
  "type": "metric alert",
  "name": "High CPU",
  "query": "avg(last_5m):avg:system.cpu.user{*} > 80",
  "message": "CPU > 80% for 5m. @slack-alerts @you@company.com",
  "priority": 3,
  "options": {"notify_no_data": false, "renotify_interval": 60, "thresholds": {"critical": 80, "warning": 70}},
  "tags": ["env:prod", "team:infra"]
}
```
`type`: `metric alert`, `service check`, `event alert`, `query alert`, `synthetics alert`, `log alert`. `query` uses the monitor form `avg(last_5m):<metric query> <threshold>` (note the rolling-window prefix — different from a raw metric query).

## Update
```bash
pup monitors get <MONITOR_ID> > mon.json
# edit mon.json
pup monitors diff <MONITOR_ID> --file mon.json
pup monitors update <MONITOR_ID> --file mon.json
```

## Delete
```bash
pup monitors delete <MONITOR_ID>          # auto-approved in agent mode; add --yes for shell
```

## Mute / downtime
Monitor mute/unmute isn't a `pup monitors` subcommand in 1.12.1 — use `pup downtime` to schedule a mute window:
```bash
pup downtime list
pup downtime get <DOWNTIME_ID>
pup downtime cancel <DOWNTIME_ID>
# create: check `pup downtime create --help` for the monitor-scope flags on your build
```

## Validate a query before creating
If `create`/`update` fails on the query, confirm the metric+tags resolve with `pup metrics query --query="avg(last_5m):avg:system.cpu.user{*} > 80"` (the metric portion), then keep the monitor-form wrapper.
