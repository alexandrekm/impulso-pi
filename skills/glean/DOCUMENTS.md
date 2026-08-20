# Documents

Retrieve, summarize, and inspect permissions on Glean documents via `glean documents`. Subcommands: `get`, `get-by-facets`, `get-permissions`, `summarize`.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `get` | Retrieve document metadata by URL or ID |
| `get-by-facets` | Retrieve documents matching facet filters |
| `get-permissions` | Inspect who has access to a document |
| `summarize` | Generate an AI summary of a document |

All take `--json` (request body), `--output`, `--fields`, `--dry-run`.

## get / summarize (by URL or ID)

```bash
glean documents get --json '{"documentSpecs":[{"url":"https://..."}]}'
glean documents summarize --json '{"documentSpecs":[{"url":"https://..."}]}' | jq -r '.summary.text'
```

`documentSpecs` is an array — pass multiple URLs/IDs to batch. `summarize` returns an AI-generated summary; `get` returns full metadata (title, datasource, body text, permissions info, etc.).

## get-by-facets

```bash
glean documents get-by-facets --json '{"facetFilters":[{"fieldName":"datasource","values":["confluence"]}],"query":"onboarding"}'
```

Use when you want documents matching structured facet filters rather than a free-text query. Inspect the exact field names with `glean schema documents` first.

## get-permissions

```bash
glean documents get-permissions --json '{"documentSpecs":[{"url":"https://..."}]}'
```

Returns who can access the document — useful for access audits before sharing or pinning.

## Preview before sending

```bash
glean documents summarize --dry-run --json '{"documentSpecs":[{"url":"https://..."}]}'
```

## Typical flow: search → get → summarize

```bash
# 1. find the doc
glean search "onboarding guide" --fields "results.document.title,results.document.url" | jq '.results[0].document.url'
# 2. fetch full metadata
glean documents get --json '{"documentSpecs":[{"url":"<URL>"}]}'
# 3. summarize
glean documents summarize --json '{"documentSpecs":[{"url":"<URL>"}]}'
```
