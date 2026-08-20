# Events

Post and fetch Datadog infrastructure events (deployments, alerts, notable occurrences) via `pup events`. Reads (list/search/get) need `events_read`; posting needs only `DD_API_KEY`.

## Post an event
```bash
pup events post "Deployed api v1.4.2" "Shipped XGBoost scoring fix. Commit: abc123" \
  --tags="env:prod,service:api,source:pi" \
  --alert-type=success \
  --aggregation-key="application:web" \
  --source-type-name=my_apps
```
Positional args are `<TITLE> [MESSAGE]` (message optional). Flags: `--alert-type` (`error|warning|info|success`), `--aggregation-key`, `--source-type-name` (the event type), `--tags` (comma-separated), `--priority`, `--host`, `--no-host`, `--date-happened`, `--handle`, `--device-name`, `--related-event-id`.

## Get / list / search
```bash
pup events get <EVENT_ID>
pup events list --from="1h" [--tags="service:api"]
pup events search --query="service:api" --from="24h"      # v2 events-platform facets: service:api, env:prod, @user.id:12345 (NOT tags:…)
pup events list --from="1h" --jq '.[] | {title, alert_type, url}'
```
`search` uses the **v2 events-platform** query syntax (`service:api`, `env:prod`, `@user.id:12345`, `*`) — NOT the legacy v1 `tags:service:api` form, which 400s.
