# Raw API

`glean api` — raw authenticated HTTP access to any Glean REST API endpoint, for things not covered by a dedicated subcommand. Paths are **relative to `/rest/api/v1/`**.

## Basic call

```bash
glean api search --method POST --raw-field '{"query":"rust","pageSize":3}'
glean api /search --method POST --raw-field '{"query":"test"}'
```

`<endpoint>` is the path after `/rest/api/v1/` (e.g. `search`, `documents`, `entities`). `--method` defaults to the appropriate verb per endpoint but set it explicitly for POST/PUT/DELETE. `--raw-field` is the JSON request body.

## Preview (dry-run)

```bash
glean api --preview search --method POST --raw-field '{"query":"test"}'
```

`--preview` is the raw-API equivalent of `--dry-run` — prints the request (method, URL, body, headers minus the token) without sending. **Always use it before a write/delete.**

## When to use `glean api` vs. a typed subcommand

- Prefer the typed subcommand (`glean search`, `glean documents summarize`, …) whenever it exists — it handles auth, the body envelope, and output formatting for you.
- Use `glean api` only for endpoints without a typed command, or when you need an exact request shape the typed command doesn't expose (rare headers, experimental endpoints, beta fields).
- You can discover the endpoint path from the Glean REST API docs (https://developers.glean.com) — then call it here with auth handled automatically.

## Output

Same discipline as the rest of the CLI: stdout is the JSON response body only; errors go to stderr with a non-zero exit. Pipe to `jq` freely:

```bash
glean api search --method POST --raw-field '{"query":"onboarding","pageSize":5}' | jq '.results[].title'
```

## Auth & env

`glean api` uses the same credentials as every other command (keyring / `GLEAN_API_TOKEN` + `GLEAN_SERVER_URL` / config). No separate setup.
