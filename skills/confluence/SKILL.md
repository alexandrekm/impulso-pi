---
name: confluence
description: Publish and manage Confluence pages via md2cf + REST + acli — spaces, page trees, markdown publishing, in-place updates, and URL pitfalls.
author: alexandre.mendonca
tags: [confluence, md2cf, acli, publish, docs]
---

# Confluence

Publish markdown to Confluence Cloud and manage spaces/pages. Three tools, each with a job:

| Tool | Use for |
|------|---------|
| `acli confluence` | Read-only: `page view --id <id> [--json]`, `space list/view`. Also `space create/update`, `blog create`. **No page create/update** (not even in 1.3.36). |
| `uvx md2cf` | Markdown → Confluence storage format; create and update pages. |
| `curl` REST | The gaps: parent-page creation, CQL search for page ids, verification. |

Announce at start: "I'm using the confluence skill to publish/manage Confluence pages."

## Auth

All site/personal values come from env vars — nothing is hardcoded. If any is unset, stop and ask the user instead of guessing:

| Var | Meaning | Example shape |
|-----|---------|---------------|
| `ATLASSIAN_SITE` | Site base URL | `https://<site>.atlassian.net` |
| `ATLASSIAN_EMAIL` | Account email for basic auth | `<you>@<company>.com` |
| `ATLASSIAN_API_KEY` | API token for basic auth | token |

- REST + md2cf: basic auth `$ATLASSIAN_EMAIL` + `$ATLASSIAN_API_KEY`. Verify:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_KEY" \
  "$ATLASSIAN_SITE/wiki/rest/api/space?limit=1"   # → 200
```

- acli: OAuth (global), `acli auth status` must show ✓ for the site in `$ATLASSIAN_SITE`.

## Local layout (optional)

Concrete values for this machine/projects — default space key, page-tree ids, helper-script paths like the banner patcher — live in `skill://confluence/LAYOUT.md` (machine-local, unversioned; not every install has one). Read it before the first publish in a project. Regardless: **page ids go stale — always re-resolve them via CQL before use.**

## URL rules (dead-link pitfalls)

- Every browser URL needs the `/wiki` context path: `$ATLASSIAN_SITE/wiki/spaces/<SPACE_KEY>/pages/<id>`. Without `/wiki` it is a hard 404 ("Oops, you've found a dead link") — no redirect happens.
- When building URLs from REST results, join `_links.base` (includes `/wiki`) + `_links.webui`, never host + webui.
- md2cf's `-o` must be the full REST base: `$ATLASSIAN_SITE/wiki/rest/api` — it urljoins the path onto the host, so a bare site URL silently hits the wrong route (404).

## Publish markdown (md2cf)

**Before every publish, run the unslop pass over the edited markdown** (em dashes, filler, AI vocabulary; table placeholder `| — |` cells and the `🚨`/`⚠️` banner markers are functional and stay).

```bash
# New page under a parent (use -A <parent_page_id>; use --top-level for space root):
uvx md2cf -o "$ATLASSIAN_SITE/wiki/rest/api" \
  -u "$ATLASSIAN_EMAIL" -p "$ATLASSIAN_API_KEY" \
  -s <SPACE_KEY> -A <PARENT_ID> -t "Page title" --strip-top-header -m "Change note" file.md

# Update in place (keeps the page id/URL stable):
#   same command with -i <PAGE_ID> instead of -A

# Dry run (validates conversion + space access, creates nothing): add --dry-run
```

- `--strip-top-header`: removes the markdown H1 when passing `-t` (else the title renders twice).
- Only-changed republish: `--only-changed` (adds a content hash to the update message).
- Images: local files referenced in the markdown are attached automatically. Hosted links (Drive etc.) stay plain links — export PNGs into the repo first if they must render inline.
- Diagrams: keep mermaid sources (`.mmd`) beside the markdown, render to PNG (`mmdc -i x.mmd -o x.png -w 1600 -b white`), and reference the PNG as a relative path (`![alt](./images/x.png)`) — md2cf attaches and embeds it on publish.
- Converting markdown edits into a page always overwrites in-browser edits; git is the source of truth — confirm before republishing a page someone may have edited via the UI.

**Red/yellow banners (panel macros):** md2cf mangles raw `<ac:structured-macro>` XHTML, so banners use a marker convention in the markdown — a blockquote starting with `🚨` becomes a red `error` panel, `⚠️` becomes a yellow `warning` panel. md2cf flattens them back to blockquotes on every publish, so **run the patcher after every publish**:

```bash
python3 <BANNER_PATCHER> <PAGE_ID> [<PAGE_ID> ...]
```

The patcher is project-specific — its path is in `skill://confluence/LAYOUT.md` if the project has one; if not, panels simply stay as blockquotes (ask the user whether a patcher exists). It is idempotent (skips pages with no markers) and bumps the page version. Git markdown keeps the emoji blockquote, so the marker survives round-trips.

## REST one-shots (curl)

```bash
AUTH="$ATLASSIAN_EMAIL"
BASE="$ATLASSIAN_SITE/wiki/rest/api"

# Create a parent page (md2cf can't make plain stub pages):
curl -s -X POST -u "$AUTH:$ATLASSIAN_API_KEY" -H "Content-Type: application/json" "$BASE/content" -d '{
  "type": "page", "title": "Parent title", "space": {"key": "<SPACE_KEY>"},
  "ancestors": [{"id": "<GRANDPARENT_ID>"}],
  "body": {"storage": {"value": "<p>Blurb.</p>", "representation": "storage"}}}'

# Find a page id — CQL text search (exact-title search FAILS on titles with —/em-dashes):
curl -s -u "$AUTH:$ATLASSIAN_API_KEY" \
  "$BASE/content/search?cql=space=<SPACE_KEY>%20AND%20type=page%20AND%20text~%22<SEARCH_TERM>%22&limit=10"

# Verify after publish (version + rendered body):
curl -s -u "$AUTH:$ATLASSIAN_API_KEY" "$BASE/content/<PAGE_ID>?expand=version,body.view,ancestors"

# Page URL for links:
# $ATLASSIAN_SITE/wiki + _links.webui from the page's GET
```

## Folders (real page-tree folders)

Folders are a separate content type from pages. The v2 API covers create, get-by-id, and delete only; there is **no list-folders endpoint**, and search/Glean don't index empty folders. If a folder id is unknown, ask the user to open the folder and paste its URL (`/spaces/<KEY>/folder/<id>`).

```bash
# Create a folder (optionally nested under a parent folder or page):
curl -s -X POST -u "$AUTH:$ATLASSIAN_API_KEY" -H "Content-Type: application/json" \
  "$ATLASSIAN_SITE/wiki/api/v2/folders" \
  -d '{"spaceId": "<SPACE_ID>", "title": "Folder title", "parentId": "<PARENT_ID>"}'

# Move a page into a folder (or reparent under any content):
# PUT, not POST (POST returns 405). The pages API cannot create pages directly under
# folders, so create the page first, then move it.
curl -s -X PUT -o /dev/null -w "%{http_code}\n" -u "$ATLASSIAN_API_KEY" \
  "$ATLASSIAN_SITE/wiki/rest/api/content/<PAGE_ID>/move/append/<FOLDER_ID>"

# Delete a folder (to trash):
curl -s -X DELETE -o /dev/null -w "%{http_code}\n" -u "$ATLASSIAN_API_KEY" \
  "$ATLASSIAN_SITE/wiki/api/v2/folders/<FOLDER_ID>"
```

- A folder cannot share a title with another folder in the space (400 on collision).
- Moving a page does not change its id or URL; embedded links survive.
- Deleting a page does not delete its children; move children out first.

## Common mistakes

- 404 on publish → `-o` missing `/wiki/rest/api`.
- "Dead link" page → URL missing `/wiki`.
- Title search returns nothing but the page exists → em-dash/special chars; use CQL `text~"..."`.
- CQL results missing just-created pages → search index lag (~seconds); wait or query `/content?spaceKey=&title=` with a plain title.
- md2cf "File does not exist" → pass an absolute path; the tool's cwd is wherever the shell is, not the doc dir.
- Moving a page into a folder → POST `/move/append/...` returns 405; it is a PUT.
- Trying to find a folder by title → no list endpoint exists; ask for the URL (the id is in it).
- Using a page id from LAYOUT.md or an earlier session without re-resolving → ids go stale; CQL-search the title first.
