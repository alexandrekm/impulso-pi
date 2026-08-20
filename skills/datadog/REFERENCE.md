# Pup CLI Reference

Install + auth + sites + global flags + full command index. Canonical source: `pup --help` and `pup <domain> <action> --help`, or `pup agent schema --compact` for machine-readable. Online: https://github.com/DataDog/pup/blob/main/docs/COMMANDS.md

## Install

```bash
brew tap datadog-labs/pack
brew install datadog-labs/pack/pup
```
No Homebrew → build from source (`git clone https://github.com/DataDog/pup && cd pup && cargo build --release`) or grab a binary from [GitHub releases](https://github.com/DataDog/pup/releases/latest).

## Auth

Priority (highest first): `DD_ACCESS_TOKEN` (stateless bearer) → OAuth2 token from `pup auth login` → API keys `DD_API_KEY` + `DD_APP_KEY`.

| Method | Setup | Notes |
|--------|-------|-------|
| OAuth2 (preferred) | `pup auth login` (browser, PKCE, scoped, auto-refresh) | needs DCR enabled on site; tokens in keychain |
| API keys (fallback) | `export DD_API_KEY=… DD_APP_KEY=…` | long-lived; scope the app key in the UI |
| Bearer token | `export DD_ACCESS_TOKEN=…` | headless/WASM; no keychain |

Multi-account: `pup auth login --org <name> [--site <site>]` then `pup <cmd> --org <name>`. `pup auth list` shows sessions; `pup auth refresh --org <name>`; `pup auth logout --org <name>`.

## Sites (`DD_SITE`, default `datadoghq.com`)

| `DD_SITE` | Region |
|-----------|--------|
| `datadoghq.com` | US1 |
| `us3.datadoghq.com` | US3 |
| `us5.datadoghq.com` | US5 |
| `datadoghq.eu` | EU |
| `ap1.datadoghq.com` / `ap2.datadoghq.com` | AP1 / AP2 |
| `uk1.datadoghq.com` | UK1 |
| `ddog-gov.com` / `us2.ddog-gov.com` | US1-FED / US2-FED |

SAML/SSO vanity host: pass the full host via `--site` at login (e.g. `acme.datadoghq.com`).

## Global flags

| Flag | Effect |
|------|--------|
| `-o, --output` | `json` (default) / `table` / `yaml` |
| `--jq '<expr>'` | jq filter applied to the **raw payload** before formatting |
| `-y, --yes` | skip confirmation prompts |
| `--read-only` | block all write ops (create/update/delete) |
| `--site <site>` | override site for this call |
| `--org <name>` | use a named session |
| `--agent` / `--no-agent` | force agent mode on/off (auto-on under `PI_CODING_AGENT`) |
| `-h, --help` | per-command help |

### `--jq` notes
- Expression runs against the **payload** (what appears under `.data` in agent mode) — write `.[]`, not `.data[]`.
- 0 outputs → `null`; 1 → unwrapped; 2+ → array.
- Commands that print directly (`auth login`, some runbook steps) ignore `--jq`.

## Env vars

`DD_ACCESS_TOKEN`, `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`, `DD_ORG`, `DD_AUTO_APPROVE` (true/false), `DD_TOKEN_STORAGE` (`keychain`|`file`), `PUP_TRUST_SITE` (trust a non-DD host for one call), `FORCE_AGENT_MODE`.

## Command index (curated)

Pattern: `pup <domain> <action> [options]` or `pup <domain> <subgroup> <action> [options]`.

| Domain | Actions |
|--------|---------|
| auth | login, logout, status, refresh, list, test |
| metrics | query, list, search, timeseries, metadata, tags, submit |
| logs | search, list, aggregate, patterns, saved-views (list/get/create/delete) |
| traces | metrics (list/get/create/update/delete) |
| monitors | list, get, create, update, delete, search, diff |
| dashboards | list, get, create, update, diff, delete, url, annotations (list/get-page/create/update/delete) |
| slos | list, get, create, update, diff, delete, status |
| notebooks | list, get, create, update, diff, delete, annotations |
| synthetics | tests, locations, suites, downtime |
| downtime | list, get, cancel |
| events | post, list, search, get |
| infrastructure | hosts (list, get) |
| containers | list, images (list) |
| processes | list |
| tags | list, get, add, update, delete |
| network | flows, devices, interfaces |
| apm | services (list/stats/operations/resources), entities, dependencies, flow-map, troubleshooting |
| service-catalog / idp | list, get / assist, find, owner, deps, register |
| error-tracking | issues (search, get) |
| incidents | list, get, attachments, settings, handles, postmortem-templates |
| on-call | teams (CRUD+memberships), pages (list/get/create) |
| cases | create, get, search, assign, archive, move, jira, servicenow |
| security | rules, signals, findings, content-packs, risk-scores |
| audit-logs | list, search |
| users / organizations | list, get, roles / get, list |
| api-keys / app-keys | list, get, create, update, delete |
| usage | summary, hourly |
| costs | datadog (projected/attribution/by-org/aws-config/azure-config/gcp-config), ccm (custom-costs/tags/budgets/commitments) |
| cicd | pipelines, events, tests, dora, flaky-tests |
| code-coverage | branch-summary, commit-summary |
| workflows | get, create, update, diff, delete, run, instances, connections |
| runbooks | list, describe, run, import, validate |
| investigations | list, get, trigger |
| change-requests / change-stories | create/get/update/create-branch/decisions / list |
| skills | list, install, path |
| acp | serve |
| ddsql | table, time-series, spec, schema |
| obs-pipelines | list, get, create, update, diff, delete, validate |
| llm-obs | projects, experiments, datasets, spans, patterns, agent-insights, annotation-queues |
| cloud | aws, gcp, azure, oci |
| integrations | slack, pagerduty, webhooks, jira, servicenow, google-chat, ms-teams |

Not implemented: `profiling` (use the Datadog MCP server), Session Replay, Powerpacks.

## Runbooks (multi-step ops)
YAML procedures in `~/.config/pup/runbooks/` with `pup`/`shell`/`http`/`datadog-workflow`/`confirm` steps, `{{VAR}}` interpolation via `--arg KEY=VALUE`, `--dry-run`. `pup runbooks list` / `describe` / `run` / `import` / `validate`.
