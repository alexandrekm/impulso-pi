# Troubleshooting

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `pup: command not found` | `brew tap datadog-labs/pack && brew install datadog-labs/pack/pup` (or build from source / grab a release binary) |
| Not authenticated / 401 | `pup auth login`; if OAuth2/DCR unavailable on your site, `export DD_API_KEY` + `DD_APP_KEY` |
| 403 Forbidden | app key lacks the scope. **Read 403** → add the relevant `*_read` scope (`dashboards_read`, `monitors_read`, `slos_read`, `logs_read`, `events_read`, `synthetics_read`, `apm_read`/`trace_read`). **`metrics query`/`timeseries` 403 but `metrics list`/`metadata`/`tags` work** → you have `metrics_read` but are missing the separate `timeseries_query` permission. **Write 403** → add `*_write`. (Scopes only apply to API-key auth; OAuth2 scopes are set at `pup auth login`.) |
| Wrong region / empty results | `DD_SITE` mismatch — US1 org uses `datadoghq.com`; check Organization Settings. `pup auth status` shows the active site |
| Dashboard edit wiped widgets | `pup dashboards update` replaces the whole dashboard — always `get` to a fresh file first, keep the full `widgets[]`, only change what you need |
| Editing a stale `dash.json` | re-`get` before editing if the dashboard may have changed since your last fetch |
| `metrics query` returns no series | timeframe has no data, or metric name/tags wrong — `pup metrics list --filter=…` to confirm the name, widen `--from` |
| `metrics timeseries` 400 / empty | `from`/`to` must be **milliseconds** (v2); v1 `metrics search`/`query` use `--from="1h"` relative strings |
| Wrong query field on a widget | legacy widgets use `requests[].q`; new formula widgets use `requests[].queries[].query` + `formulas[]` — check the `get` output |
| `--jq` filters return nothing | `--jq` runs on the **raw payload**, which is NOT always a bare array. Per command: `dashboards list` → `.dashboards[]`, `monitors list` → `.[]`, `slos list` → `.data[]`, `metrics list` → `.metrics[]`. Inspect with `pup <cmd> \| head` first, then write the jq path. (In agent mode the payload is what appears under `.data` in the envelope.) |
| Prompt blocks a write in a script | agent mode auto-approves under `PI_CODING_AGENT`; otherwise add `-y`/`--yes` or `DD_AUTO_APPROVE=true` |
| `pup profiling …` does nothing | not implemented — use the Datadog MCP server (`?toolsets=core,profiling`) |
| `workflows …` 401 | workflow commands require `DD_API_KEY`+`DD_APP_KEY`; OAuth2 bearer tokens aren't accepted for workflows |
| Site host not trusted | set `PUP_TRUST_SITE=1` for one call, or add the host to `trusted_sites` in `~/.config/pup/config.yaml` |
| macOS keychain prompt every run | unsigned/dev builds re-prompt; install the signed Homebrew build, or `DD_TOKEN_STORAGE=file` |
| `pup dashboards url` errors "relative URL without a base" | broken in pup 1.12.1 — build the URL manually from the `url` field (see `skill://datadog/DASHBOARDS.md`) |
| `pup apm services list` errors "required arguments not provided: --env" | `--env <ENV>` is **required** on `services list` (and the stats/operations/resources subcommands) |
| `pup logs aggregate` rejects `--file` | `aggregate` is flag-based in 1.12.1: `--query --compute --group-by --limit --storage` (no `--file`) |
| `pup events post --type=…` unknown flag | the event-type flag is `--source-type-name`, not `--type` |
| `pup monitors list --group-states=…` unknown flag | not a pup flag in 1.12.1 — filter via `--tags`/`--name`, or use `pup monitors search` |
