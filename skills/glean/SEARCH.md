# Search

Search across your company's knowledge via `glean search`. The primary read command — use it whenever the user asks about internal docs, policies, wikis, or company information.

## Basic search

```bash
glean search "vacation policy"
glean search "Q1 planning" --datasource confluence --page-size 5
glean search "docs" --fields "results.document.title,results.document.url"
glean search "onboarding" | jq '.results[].title'
```

`--query` is the positional arg and is **required**. The payload is `{"results":[...], "queryMetadata": {...}}` — each result has a top-level `title` and a nested `.document` (with `url`, `datasource`, text, etc.).

## Flags

| Flag | Description |
|------|-------------|
| `--query` | Search query (positional) — **required** |
| `--datasource` / `-d` | Filter by datasource (repeatable): `confluence`, `jira`, `gdrive`, `slack`, … |
| `--type` / `-t` | Filter by document type (repeatable) |
| `--page-size` | Results per page (default 10) |
| `--fields` | Dot-path projection — **prefix with `results.`** |
| `--output` / `--format` | `json` (default) / `ndjson` / `text` |
| `--json` | Raw SDK request body (overrides all flags) |
| `--dry-run` | Print request body without sending |
| `--timeout` | Request timeout in ms (default 30000) |
| `--tab` | Filter by result tab IDs (repeatable) |
| `--disable-query-autocorrect` | Turn off automatic query corrections |
| `--disable-spellcheck` | Turn off spellcheck |
| `--facet-bucket-size` | Max facet buckets per result (default 10) |
| `--fetch-all-datasource-counts` | Return counts for all datasources |
| `--return-llm-content` | Return expanded LLM-friendly content |
| `--response-hints` | Response hints (default `[RESULTS QUERY_METADATA]`) |

## Stream large result sets (NDJSON)

```bash
glean search "engineering docs" --output ndjson --page-size 50 | jq .title
```

`ndjson` emits one `SearchResult` object per line — ideal for piping into `jq`/scripts without buffering a huge JSON array.

## Raw request body (`--json` overrides all flags)

```bash
glean search --json '{"query":"onboarding","pageSize":3,"datasources":["confluence"]}'
glean search --dry-run --json '{"query":"test"}'   # preview, don't send
```

When you need filters not exposed as flags (facets, tabs, custom ranges), build the full SDK body and pass `--json`.

## Preview before sending

```bash
glean search --dry-run --datasource confluence "Q1 planning"
```

## Discovering the exact shape

```bash
glean schema search | jq '.flags | keys'
glean schema search | jq '.flags["--fields"]'
```
