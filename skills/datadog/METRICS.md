# Metrics

Query, list, and submit Datadog metrics via `pup metrics`. `list`/`metadata`/`tags` need `metrics_read`; `query`/`timeseries` need the separate `timeseries_query` permission — if you get 403 on those, your app key lacks it (see `skill://datadog/TROUBLESHOOTING.md`).

## query vs search vs timeseries
- `pup metrics query --query="…" --from="1h"` — v2 single-query timeseries, relative `--from`/`--to`. **Default.**
- `pup metrics search --query="…" --from="1h"` — v1 classic API (kept for parity; prefer `query`).
- `pup metrics timeseries --file req.json` — v2, multiple queries + formulas + any data source. `from`/`to` in **ms**.

## Quick single-metric fetch
```bash
pup metrics query --query="avg:system.cpu.user{*}" --from="1h"
```
`--from` accepts `1h`, `30m`, `7d`, `now`, or a unix timestamp. Query is `<aggr>:<metric>{<tags>}` where aggr is `avg`/`max`/`sum`/`min`, e.g. `max:system.mem.used{host:web-1,env:prod}`. Add `--to="2h"` to end at a non-now time.

## Multi-query / formulas (timeseries via file)
```bash
pup metrics timeseries --file req.json
```
Reference queries by `name` (a, b, c…); functions go in `formulas`:
```json
{
  "data": {"type": "timeseries_request", "attributes": {
    "from": 1636625471000, "to": 1636629071000, "interval": 60000,
    "queries": [
      {"data_source": "metrics", "name": "a", "query": "avg:system.cpu.user{*}"},
      {"data_source": "metrics", "name": "b", "query": "avg:system.cpu.idle{*}"}
    ],
    "formulas": [{"formula": "a / (a + b) * 100"}]
  }}
}
```
Formula functions: `topk(a, 10)`, `bottomk`, `anomaly(a)`, `outliers(a)`, `robust_anomaly(a)`, `cumsum(a)`, `diff(a)`, `ewma(a, 1)`, `absent(a)`, `clamp_max(a, 100)`, arithmetic `a / b`, `a * 100`. One entry per formula in `formulas[]`.

`data_source` can also be `logs`, `spans`, `rum`, `apm_resource_stats`, `apm_metrics`, `apm_dependency_stats`, `slo`, `process`, `container`, `network`, `security_signals`, `profiles`, `audit`, `events`, `ci_tests`, `ci_pipelines`, `cloud_cost`. Events-based query shapes (logs/APM/SLO/process/container) are documented in the Datadog API docs; the `compute`/`search`/`group_by` fields mirror the v2 query API.

## List / discover metrics
```bash
pup metrics list --filter="system.*"            # {"from","metrics":[...]} — jq '.metrics[]'
pup metrics metadata get <metric_name>          # {description, type} (e.g. type: "distribution")
pup metrics tags list <metric_name> [--window-seconds=3600]   # active tag values (default 3600s, max 2592000s)
```

## Submit a custom metric
```bash
pup metrics submit --name my.app.requests --value 42 --tags env:prod,service:web [--type gauge|count|rate] [--host web-1]
```
Needs only `DD_API_KEY` (no app key). `--type` default `gauge`; for `count`/`rate` add `--interval <seconds>`. Multi-point via `--file points.json`.
