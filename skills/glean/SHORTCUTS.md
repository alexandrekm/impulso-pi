# Shortcuts (go-links)

Manage Glean shortcuts — memorable short URLs / go-links — via `glean shortcuts`. Subcommands: `list`, `get`, `create`, `update`, `delete`.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all shortcuts |
| `get` | Get a specific shortcut |
| `create` | Create a new shortcut |
| `update` | Update an existing shortcut |
| `delete` | Delete a shortcut |

All take `--json`, `--output`, `--fields`, `--dry-run`.

## list / get

```bash
glean shortcuts list | jq '.shortcuts[].inputAlias'   # payload is {"shortcuts":[...], "facetResults":..., "meta":...}
glean shortcuts get --json '{"data":{"inputAlias":"onboarding"}}'
```

The list payload is `{"results":[...]}`; each shortcut has `inputAlias` (the go-link slug), `destinationUrl` or `urlTemplate`, and metadata.

## create (static destination)

```bash
glean shortcuts create --json '{"data":{"inputAlias":"onboarding","destinationUrl":"https://wiki.example.com/onboarding"}}'
```

## create (variable template — go-link with an argument)

```bash
glean shortcuts create --json '{"data":{"inputAlias":"jira","urlTemplate":"https://jira.example.com/browse/{arg}"}}'
```

With `urlTemplate`, visiting `go/jira/PROJ-123` expands `{arg}` → `https://jira.example.com/browse/PROJ-123`. Use this for deep-link generators (Jira, GitHub PRs, dashboards with an ID parameter).

## update / delete

```bash
glean shortcuts update --json '{"data":{"inputAlias":"onboarding","destinationUrl":"https://new-url..."}}'
glean shortcuts delete --json '{"data":{"inputAlias":"onboarding"}}'
```

## Preview before writing

```bash
glean shortcuts create --dry-run --json '{"data":{"inputAlias":"test","destinationUrl":"https://example.com"}}'
```

## Gotcha

The request body is wrapped in `"data": {...}` (matches the Glean Shortcuts API). Omitting the `data` wrapper is the most common create/update failure — if you get a 400/validation error, check the wrapper.
