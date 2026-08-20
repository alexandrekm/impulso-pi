# Glean CLI Reference

Install + auth + server URL + global flags + full command index. Canonical source: `glean --help`, `glean <command> --help`, and `glean schema [command]` (machine-readable). Online: https://github.com/gleanwork/glean-cli

## Install

```bash
# Homebrew (recommended)
brew install gleanwork/tap/glean-cli

# Manual
curl -fsSL https://raw.githubusercontent.com/gleanwork/glean-cli/main/install.sh | sh
```

Pre-built binaries for macOS, Linux, Windows are on the [Releases](https://github.com/gleanwork/glean-cli/releases) page.

## Auth

```bash
glean auth login     # interactive — auto-detects the best method (browser / device code / API token)
glean auth status    # verify credentials, host, token expiry
glean auth logout    # remove all stored credentials
```

`auth login` tries each method in order and uses the first that works — you don't choose:

| Method | When it's used | What happens |
|--------|---------------|--------------|
| Browser login | Default for most instances | Opens browser, you approve, done |
| Device code login | Orgs using an external IdP (e.g. Okta) | Prints a URL + code — open URL, enter code |
| API token | Instances without OAuth support | Prompts you to paste a token from Glean Admin |

Tokens are stored in the system keyring and refreshed automatically.

### API token (CI/CD / non-interactive)

```bash
export GLEAN_API_TOKEN=your-token
export GLEAN_SERVER_URL=https://your-server-url
glean search "test"
```

Generate a token from **Glean Admin → Settings → API Tokens** (scoped to an individual user). How to find your server URL: https://developers.glean.com/get-started/authentication

### Credential resolution order

env vars (`GLEAN_API_TOKEN`, `GLEAN_SERVER_URL`) → system keyring → `~/.glean/config.json`.

## Global flags

| Flag | Effect |
|------|--------|
| `-o, --output` / `--format` | `json` (default) / `ndjson` (one result per line) / `text` |
| `--fields '<paths>'` | Dot-path field projection. For `search`, prefix with `results.` (e.g. `results.document.title,results.document.url`) |
| `--json '<body>'` | Complete SDK request body as JSON — **overrides all other flags** |
| `--dry-run` | Print the request body without sending |
| `-h, --help` | Per-command help |

Notes:
- `--json` overrides every individual flag — don't mix `--json` with `--datasource`/`--page-size`/etc.; put everything in the JSON body instead.
- `--fields` is a client-side projection over the JSON payload. For `search` the payload is `{"results":[...]}`, so paths start `results.`. For other commands, inspect with `glean <cmd> | head` first.
- Namespace commands (agents, documents, entities, …) all accept `--json`, `--output`, `--fields`, `--dry-run`.

## Schema introspection

Always call `glean schema <command>` before invoking a command you haven't used before.

```bash
glean schema | jq '.commands'          # list all commands
glean schema search | jq '.flags'      # flags for search
glean schema search | jq '.flags["--output"]'
```

## Env vars

`GLEAN_API_TOKEN`, `GLEAN_SERVER_URL`. Env vars take precedence over stored config.

## Exit codes & output discipline

`0` = success; `1` = general error (auth failure, API error, invalid input). **Stdout is structured output only** (JSON/NDJSON/text); all errors go to stderr — safe to pipe to `jq`/scripts.

## Command index

Pattern: `glean <command> [subcommand] [flags]`. All namespace commands accept `--json`, `--output`, `--fields`, `--dry-run`.

| Command | Subcommands | Description |
|---------|-------------|-------------|
| auth | login, status, logout | Authenticate with Glean |
| search | — | Search across company knowledge |
| chat | — | Chat with Glean Assistant (streams to stdout; reads stdin if no message) |
| api | `<endpoint>` | Raw authenticated HTTP to any Glean REST endpoint (relative to `/rest/api/v1/`) |
| schema | `[command]` | Machine-readable JSON schema for commands |
| completion | bash, zsh, fish | Shell completions |
| agents | list, get, schemas, run | Manage & invoke Glean AI agents |
| answers | list, get, create, update, delete | Curated Q&A pairs |
| announcements | create, update, delete | Time-bounded company announcements |
| collections | list, get, create, update, delete, add-items, delete-item | Curated document collections |
| documents | get, summarize, get-by-facets, get-permissions | Document retrieval & summarization |
| entities | list, read-people | People, teams, custom entities |
| insights | get | Search & usage analytics |
| messages | get | Indexed messages (Slack, Teams, …) |
| pins | list, get, create, update, remove | Promoted search results |
| shortcuts | list, get, create, update, delete | Go-links / memorable short URLs |
| tools | list, run | Glean platform tools |
| verification | list, verify, remind | Document verification & review |
| activity | report, feedback | User activity reporting |

## Interactive TUI

`glean` with no args opens a full-screen chat (Glean Assistant). `glean --continue` resumes the last session. In-agent, prefer the non-interactive `glean chat`/`glean search` commands instead.

## Agent workflow

```bash
# 1. Discover commands
glean schema | jq '.commands'
# 2. Inspect a command's flags
glean schema search | jq '.flags | keys'
# 3. Preview the exact request
glean shortcuts create --dry-run --json '{"data":{"inputAlias":"test","destinationUrl":"https://example.com"}}'
# 4. Execute and parse
glean search "engineering values" | jq '.results[].title'
# 5. Stream large result sets as NDJSON
glean search "all docs" --output ndjson --page-size 50 | jq .title
```
