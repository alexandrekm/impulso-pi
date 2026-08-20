# Entities & People

Look up people, teams, and custom entities via `glean entities`. Subcommands: `list`, `read-people`. `--json` is **required** on both.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List entities by type and query |
| `read-people` | Get detailed people profiles |

## list (entities by type)

```bash
glean entities list --json '{"entityType":"PEOPLE","query":"engineering"}'
```

Returns `{cursor, facetResults, sortOptions, totalCount}` — **facet buckets + a total count, not a flat list of people.** Use `totalCount` to gauge volume and `facetResults[]` for filterable dimensions (datasource, team, etc.). `entityType` is required — `PEOPLE` is the common one; `TEAM` and custom types depend on your Glean setup. Inspect allowed types with `glean schema entities`.


## read-people (detailed profiles)

```bash
glean entities read-people --json '{"query":"smith"}' | jq '.[].name'
glean entities read-people --json '{"query":"alex mendonca"}'
```

Returns a **bare array** of rich people profiles — name, email, title, manager, team, photo, etc. `query` matches on name/email; partial matches work. **Needs a token with people/profile scopes** — a minimal-scope API token returns `403 insufficient_scope` (see `skill://glean/TROUBLESHOOTING.md`); re-login or generate a token with the required scopes in Glean Admin.

## Common uses

- **"Who owns X?" / "Who's on the Y team?"** → `read-people` with a name, or `list` with `entityType:PEOPLE` + a team query.
- **Find someone's manager / reports** → `read-people`, then read the `manager`/`reports` fields from the result.
- **Org lookup before pinging/assigning** — combine with the jira skill (assignee search) or chat (context for Glean Assistant).

## Preview

```bash
glean entities read-people --dry-run --json '{"query":"smith"}'
```
