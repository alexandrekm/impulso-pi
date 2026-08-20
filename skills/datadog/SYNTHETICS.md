# Synthetics

Run and manage Datadog Synthetic tests, locations, and suites via `pup synthetics`. Reads need `synthetics_read`; writes/running tests need `synthetics_write` (and `pup synthetics tests run` requires `DD_API_KEY` + `DD_APP_KEY`).

## Commands (1.12.1)
`tests`, `locations`, `suites`, `multistep`, `downtime`.

## Tests
```bash
pup synthetics tests list
pup synthetics tests list --jq '.tests[] | {id, name, type, status}'    # payload is {"tests":[...], "total":N}
pup synthetics tests get <TEST_ID>
pup synthetics tests search --query="api"
pup synthetics tests run <TEST_ID>                 # trigger a run ad-hoc (the real trigger command)
# results:
pup synthetics tests list-latest-results <TEST_ID>
pup synthetics tests get-result <TEST_ID> --result-id <RESULT_ID>
pup synthetics tests get-browser-result <TEST_ID> --result-id <RESULT_ID>
```

## Locations
```bash
pup synthetics locations list
```

## Suites (V2)
```bash
pup synthetics suites list
pup synthetics suites get <SUITE_ID>
pup synthetics suites create --file suite.json
pup synthetics suites update <SUITE_ID> --file suite.json
pup synthetics suites delete <SUITE_ID>
```

## Downtime (mute synthetic tests)
```bash
pup synthetics downtime list
pup synthetics downtime create --file dt.json
pup synthetics downtime delete <DT_ID>
```
