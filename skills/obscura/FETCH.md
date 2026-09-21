# Extraction: fetch, evaluate, scrape

## `obscura fetch <URL>` — one page, rendered with real JS

Output via `--dump` (default `html`):

| `--dump` | Output |
|----------|--------|
| `text` | visible body text |
| `html` | rendered HTML (after JS) |
| `links` | all links |
| `markdown` | DOM→Markdown conversion |
| `assets` | NDJSON, one record per sub-resource URL the page would fetch |
| `original` | raw response body verbatim, binary-safe — **bypasses the JS/DOM layer**. Use for images, JSON, JS, CSS, or any non-HTML resource |

```bash
obscura fetch https://example.com --dump text
obscura fetch https://example.com --eval "document.title"
obscura fetch https://news.ycombinator.com --dump html --output page.html   # -o file for dump/eval output
obscura fetch https://example.com --dump assets
obscura fetch https://picsum.photos/200/300 --dump original > photo.jpg
```

## Waiting / timing

| Flag | Meaning |
|------|---------|
| `--wait-until load\|domcontentloaded\|networkidle0` | navigation milestone (default `load`; `networkidle0` for SPAs) |
| `--selector <css>` | wait for a CSS selector to appear |
| `--wait N` | fixed post-load delay in seconds (omit = adaptive settling, ≤5s) |
| `--timeout N` | max navigation time in seconds (default 30) |

## `obscura scrape <URL...>` — many URLs in parallel

Worker processes (`obscura-worker` must sit next to the `obscura` binary); workers inherit the global proxy.

```bash
obscura scrape url1 url2 url3 --concurrency 25 --eval "document.querySelector('h1').textContent" --format json
obscura scrape https://example.com --quiet --format json   # --quiet suppresses stderr progress
```

Flags: `--concurrency` (default 10), `--eval <js>`, `--format json|text`, `--quiet`, `--proxy` (global, inherited).

## `--eval` — run JavaScript, get the result

One expression evaluated on the settled page; the result prints to stdout:

```bash
obscura fetch https://example.com --eval "Array.from(document.querySelectorAll('a')).map(a => a.href).join('\n')"
```

## Proxy / robots / private network

```bash
obscura --proxy socks5://127.0.0.1:1080 fetch https://example.com --dump text   # HTTP or SOCKS, global flag
obscura fetch http://127.0.0.1:3000 --allow-private-network --dump text           # localhost/LAN (SSRF guard)
```

Heavy pages: raise the script-execution budget (`OBSCURA_SCRIPT_DEADLINE_MS`, default 30000) or V8 heap (`--v8-flags "--max-old-space-size=4096"`) — see `skill://obscura/REFERENCE.md`.
