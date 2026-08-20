# Collections

Manage curated document collections via `glean collections`. Subcommands: `list`, `get`, `create`, `update`, `delete`, `add-items`, `delete-item`.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all collections |
| `get` | Get a specific collection |
| `create` | Create a new collection |
| `update` | Update an existing collection |
| `delete` | Delete a collection |
| `add-items` | Add documents to a collection |
| `delete-item` | Remove a document from a collection |

All take `--json`, `--output`, `--fields`, `--dry-run`.

## list / get

```bash
glean collections list
glean collections list --fields "results.id,results.name"
glean collections get --json '{"id":"<id>"}'      # or the form your build expects — check schema
```

## create / update

```bash
glean collections create --json '{"name":"My Collection","description":"Onboarding essentials"}'
glean collections create --dry-run --json '{"name":"My Collection"}'   # preview
# update: fetch the current shape first, modify, then:
glean collections update --json '{"id":"<id>","name":"Renamed","description":"…"}'
```

`update` semantics: prefer fetching the current collection (`get`), modifying the fields you care about, and passing the full body. Inspect the exact `--json` field names with `glean schema collections` — they follow the Glean Collections API.

## add-items / delete-item

```bash
glean collections add-items --json '{"id":"<collectionId>","documentIds":["https://…","https://…"]}'
glean collections delete-item --json '{"id":"<collectionId>","documentId":"https://…"}'
```

`documentIds` are the same URLs/IDs returned by `glean search` results (`results[].document.url` or the document ID). A typical flow: `search` for docs → collect URLs → `add-items` to a collection.

## delete

```bash
glean collections delete --json '{"id":"<id>"}'
```

Destructive — always `--dry-run` first.
