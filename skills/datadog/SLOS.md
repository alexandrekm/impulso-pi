# SLOs (Service Level Objectives)

List, inspect, check status, and manage SLOs via `pup slos`. Read access needs `slos_read`; writes need `slos_write`.

## List (payload is {"data":[...]} — jq `.data[]`)
```bash
pup slos list
pup slos list --jq '.data[] | {id, name, type}'
```

## Get (returns {"data":{...}})
```bash
pup slos get <SLO_ID>
```

## Status (requires --from and --to, both required)
```bash
FROM=$(($(date +%s)-86400)); TO=$(date +%s)
pup slos status <SLO_ID> --from=$FROM --to=$TO
```
`--from`/`--to` are **required** (unix timestamps). Returns current status, error budget, burn rate over the window.

## Create / update / diff / delete
```bash
pup slos create --file slo.json
pup slos get <SLO_ID> > slo.json
# edit slo.json
pup slos diff <SLO_ID> --file slo.json
pup slos update <SLO_ID> --file slo.json
pup slos delete <SLO_ID>
```
```json
{
  "type": "metric",
  "name": "api-availability",
  "target": 99.9,
  "timeframe": "30d",
  "query": {"numerator": "sum:http.requests{code:!5xx}.as_count()",
            "denominator": "sum:http.requests{*}.as_count()"},
  "tags": ["team:api", "env:prod"]
}
```
`type` can also be `monitor` (uses a monitor id) or `time_slice`. Check `pup slos create --help` for exact field names on your build.
