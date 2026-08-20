# Logs

Search, list, query, aggregate, and find patterns in Datadog logs via `pup logs`. All reads need `logs_read` on your app key.

## Commands (1.12.1)
`search` (v1), `list` (v2), `query` (v2), `aggregate` (v2), `patterns` (v1), `saved-views`, `archives`, `custom-destinations`, `metrics` (log-based metrics), `restriction-queries`.

## Search (v1)
```bash
pup logs search --query="service:api status:error" --from="1h" [--limit 50] [--sort desc] [--cursor <cursor>]
pup logs search --query="service:api @http.status_code:500" --from="7d" --storage=flex
```
`--query` is the Logs UI Lucene-ish syntax (`service:api`, `@error.code:500`, faceted `@`-filters, `*`). `--from`/`--to` accept `15m`, `1h`, `7d`, RFC3339, unix ts, or `now`. `--storage`: `auto` (default) / `indexes` / `online-archives` / `flex` — long lookbacks may require `flex` or `online-archives`. `--cursor` paginates.

## query / list (v2)
```bash
pup logs query --query="service:api" --from="1h"        # v2 API
pup logs list --query="service:api" --from="1h"          # v2 listing
```

## aggregate (v2 — flag-based, not a file)
```bash
pup logs aggregate \
  --query="service:api" --from="24h" \
  --compute="count,avg(@duration),percentile(@duration,95)" \
  --group-by="service,@http.status_code" --limit 10
```
`--compute` is comma-separated: `count`, `avg(@field)`, `min/max/sum(@field)`, `percentile(@field,95)`, `cardinality(@field)`. `--group-by` is comma-separated facets. `--storage` as above. Drop `--group-by` for a single aggregate.

## patterns (v1 — cluster similar log lines)
```bash
pup logs patterns --query="status:error" --pattern-field="message" --from="1h" \
  [--sample-limit 50] [--event-limit 10000] [--index main,security]
```
`--query` and `--pattern-field` are **required**.

## saved-views
```bash
pup logs saved-views list
pup logs saved-views get <view-id>
pup logs saved-views create --file view.json
pup logs saved-views delete <view-id>
```
