# Troubleshooting

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `glean: command not found` | `brew install gleanwork/tap/glean-cli` (or `curl -fsSL https://raw.githubusercontent.com/gleanwork/glean-cli/main/install.sh \| sh`) |
| Not authenticated / 401 | `glean auth login`; for CI set `GLEAN_API_TOKEN` + `GLEAN_SERVER_URL` |
| 403 Forbidden / `insufficient_scope` | token lacks the scope for that endpoint. **`entities read-people` is a common one** — minimal-scope API tokens 403 with `insufficient_scope`; re-`glean auth login` (OAuth grants broader scopes) or generate a token with people/profile scopes in Glean Admin → Settings → API Tokens. API tokens are per-user, so the user account must also have access to the datasource/feature |
| `--fields` returns nothing (search) | paths must be prefixed with `results.` — `results.document.title`, not `document.title`. Inspect with `glean search "…" \| jq 'keys'` first |
| `--fields` returns nothing (shortcuts/collections) | payload key differs per command: `shortcuts list` → `.shortcuts[]` (not `.results[]`), `agents list` → `.agents[]`, `search` → `.results[]`, `entities list` → no flat list (returns `facetResults`+`totalCount`). Inspect with `glean <cmd> \| jq 'keys'` first |
| `--json` flags silently ignored | `--json` **overrides all other flags** — don't mix `--json` with `--datasource`/`--page-size`; put everything in the JSON body |
| `glean chat` hangs with no output | no message arg → it reads **stdin until EOF (Ctrl+D)**. Pipe input (`echo "…" \| glean chat`) or pass the message positionally |
| `documents summarize` jq returns parse error / empty | the summary is nested: `.summary.text` (a string), not `.summary`. Use `\| jq -r '.summary.text'` |
| shortcuts create/update 400 | the body must be wrapped in `"data": {...}` — `{"data":{"inputAlias":"…","destinationUrl":"…"}}`, not the fields at the top level |
| entities 400 / "required" | `--json` is **required** on `entities list`/`read-people` — there are no flag shortcuts; build the JSON body |
| Unknown flag on a namespace command | namespace commands share `--json`/`--output`/`--fields`/`--dry-run`; per-subcommand flags are few. Run `glean schema <command> \| jq '.flags'` for the authoritative list |
| Output isn't valid JSON | only stdout is structured; errors print to **stderr**. If you piped `2>&1`, separate them. Exit code 0 = success, 1 = error |
| Want to preview a write before sending | add `--dry-run` (typed commands) or `--preview` (`glean api`) — prints the request body without sending |
| Don't know the exact request shape | `glean schema <command>` → machine-readable flags; for `--json` bodies, check the Glean REST API docs at https://developers.glean.com |
| Large search result buffers forever | use `--output ndjson --page-size 50` — streams one result per line instead of one big array |
| `glean api <endpoint>` 404 | path is relative to `/rest/api/v1/` — pass just `search`, not `/rest/api/v1/search`. Confirm the path in the REST API docs |
| Pasting an API token into the prompt | **never** echo `GLEAN_API_TOKEN` or secrets in outputs — set them as env vars; `glean auth status` reports expiry, not the token value |
