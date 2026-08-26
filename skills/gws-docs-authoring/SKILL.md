---
name: gws-docs-authoring
description: Author and evolve long-form Google Docs via the gws CLI. Primary edit path is the docx round-trip (export → edit locally → re-upload to the same documentId, preserving the URL). Surgical path is the shipped `gws_doc_style.py` helper for targeted batchUpdate edits. Never delete/recreate a doc; insert PNG images from Drive manually when org policy blocks public sharing. Use when building or maintaining Docs one-pagers, TDDs, or design docs programmatically.
author: alexandre.mendonca
tags: [gws, docs, authoring, google-docs, drive]
---

# Google Docs Authoring via gws

Two ways to edit a Google Doc with `gws`, in order of simplicity:

1. **The docx round-trip** (primary) — `drive files export` to `.docx`, edit the
   local file, `drive files update --upload` it back to the **same** documentId.
   Preserves the URL, replaces the content. No index math, formatting
   (headings/bold/lists/links) round-trips natively through docx. Best for
   evolving or restructuring a doc.
2. **`documents.batchUpdate` via the helper script** (surgical) — for a small
   targeted change (reword one span, restyle one heading, one insert) where you
   must not touch the rest of the doc (e.g. collaborators are editing). Uses
   `scripts/gws_doc_style.py` so you write a small plan, not Python.

`gws` has one Docs authoring helper — `docs +write` — and it appends **plain
text** verbatim (no Markdown parsing; `## x` stays literal). It's a quick
plain-text append, not an authoring surface. For formatted content use the
round-trip (or batchUpdate).

Two rules caused real problems and are worth loading before any session:

1. **Never delete and recreate a document — edit it in place.** Both paths below
   preserve the documentId; `files.update --upload` keeps the same ID, and
   `batchUpdate` is by definition in-place.
2. **PNG images stored in Google Drive cannot be embedded via the Docs API when
   org policy blocks public sharing — insert them manually from the browser.**

Load `skill://gws-docs/SKILL.md` and `skill://gws-shared/SKILL.md` for the base
read/write commands, auth, and global flags.

---

## Path 1 — The docx round-trip (primary)

Verified end-to-end: `files.update --upload doc.docx` on an existing Google Doc
replaces its content **and keeps the same documentId/URL/mimeType**. So
"export, edit, re-upload" is a real in-place edit, not a delete-and-recreate.

```bash
DOC=<the stable documentId>

# 1. Export the live doc to a local .docx (10 MB export cap).
gws drive files export \
  --params "{\"fileId\":\"$DOC\",\"mimeType\":\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\"}" \
  -o doc.docx

# 2. Edit doc.docx locally — see "Editing a .docx" below.

# 3. Push it back to the SAME doc (content replaced, ID/URL/sharing preserved).
gws drive files update --params "{\"fileId\":\"$DOC\"}" --upload doc.docx
```

### Creating a new doc from a .docx

```bash
DOC=$(gws drive files create \
  --json '{"name":"Project Brief","mimeType":"application/vnd.google-apps.document"}' \
  --upload draft.docx 2>/dev/null | jq -r .id)
```

The `mimeType` in `--json` **must** be `application/vnd.google-apps.document` to
trigger conversion — omit it and you get a plain `.docx` file in Drive, not a
Google Doc. The uploaded docx must be a valid Word file; a hand-rolled
minimal docx can be rejected with `conversionUnsupportedConversionPath`, so
build it with `python-docx` or start from an exported one.

### Exporting to read, not edit

`drive files export` also supports `text/markdown`, `text/html`,
`application/pdf` (10 MB cap). Exporting to markdown is a great way to get a
readable copy to plan edits against — but **push back via `.docx`**, not
markdown; the docx path is the reliable round-trip.

### Editing a .docx (no pandoc required)

If `pandoc` isn't installed, edit the docx as a zip of XML (verified works):

```bash
mkdir work && cd work && unzip -q ../doc.docx
# Text lives in word/document.xml as <w:t>…</w:t> runs. Swap a string:
sed -i '' 's/old wording/new wording/' word/document.xml
# (macOS sed: use `sed -i ''`. Linux: `sed -i`. Avoid breaking XML entities.)
cd .. && zip -qr edited.docx work/   # rezip from the work dir root
gws drive files update --params "{\"fileId\":\"$DOC\"}" --upload edited.docx
```

For structured edits (add a heading, insert a table, restyle many runs) use
`python-docx` (`pip install python-docx`) — it's a library *call*, not authoring
a one-off orchestration script. The round-trip is two `gws` commands plus your
edit; there is no batchUpdate JSON to build.

### Round-trip caveats

- **Full replace, not surgical.** `files.update --upload` replaces the doc's
  entire content. If a collaborator is editing simultaneously, you overwrite
  their changes. For concurrent-edit situations use Path 2 (batchUpdate).
- **Formatting fidelity** through docx is very good for headings/bold/italic/
  lists/links but not pixel-perfect for exotic Docs features. Verify with a
  `documents.get` or a browser glance after a big round-trip.
- **Images**: a docx with an *embedded* image uploads bytes under your own auth
  (like the browser does), so it **bypasses the org-policy block** that breaks
  `insertInlineImage`. Verified: an inline PNG pushed via `files.update --upload`
  lands as a real inline image object (`inlineObjects`/`inlineObjectElement`) in
  the live doc. This is the preferred image path under org policy — see
  "Rule 2" below.

---

## Path 2 — batchUpdate via the helper script (surgical)

For a small, targeted change where you must not rewrite the whole doc. You write
a declarative **plan** (JSON) and `scripts/gws_doc_style.py` compiles it into a
correctly-sorted `{"requests":[...]}` array, resolving text matches to indices
from a `documents.get` dump. **Call the script; do not author Python.**

```bash
DOC=<the stable documentId>
gws docs documents get --params "{\"documentId\":\"$DOC\"}" > doc.json 2>/dev/null
cat > plan.json <<'JSON'
{"ops": [
  {"replace": {"find": "old wording", "with": "new wording", "matchCase": true}},
  {"heading": 2, "match": "Architecture"},
  {"bold": true, "match": "must not"},
  {"link": {"url": "https://drive.google.com/file/d/FILE_ID/view", "style": "subtle"},
   "match": "Open full size ↗"}
]}
JSON
python3 "$(skill_dir)/scripts/gws_doc_style.py" --doc doc.json --plan plan.json -o reqs.json
gws docs documents batchUpdate --params "{\"documentId\":\"$DOC\"}" --json "$(cat reqs.json)"
```

`$(skill_dir)` is this skill's directory (parent of `SKILL.md`). The script
sorts index-based ops highest-index-first (so earlier indices stay valid in one
batch) and runs index-free `replaceAllText` last. `--apply DOC_ID` makes it call
`gws` directly instead of writing a file.

### Plan ops

| Op | Meaning |
| --- | --- |
| `{"heading": 1\|2\|3, "match": "..."}` | `updateParagraphStyle` → HEADING_1/2/3 |
| `{"heading": 1\|2\|3, "paragraph": 3}` | by 0-based paragraph index |
| `{"title": true, "match": "..."}` / `{"normal": true, "match": "..."}` | TITLE / reset NORMAL_TEXT |
| `{"link": {"url": "...", "style": "subtle"}, "match": "..."}` | hyperlink (+ italic 9pt blue for "↗") |
| `{"bold": true, "match": "..."}` / `{"italic": true, "match": "..."}` | bold / italic the matched text |
| `{"insert": {"text": "..."}, "after": "match"}` | `insertText` after a paragraph (`before`/`index` also work) |
| `{"delete": {"match": "..."}}` / `{"delete": {"start": S, "end": E}}` | `deleteContentRange` |
| `{"replace": {"find": "...", "with": "...", "matchCase": true}}` | `replaceAllText` (**global** — all occurrences) |

### Surgical-path gotchas

- **Insert-then-style is two passes.** Match resolution runs against the
  pre-update `doc.json`, so an op matching *newly inserted* text won't find it.
  To add a styled section: `insert` it in one batchUpdate, re-`get`, then
  `heading`/`bold` it in a second. (The round-trip path avoids this entirely.)
- **`replace` is global** (`replaceAllText`). To change one occurrence, use
  `delete` + `insert` at that range, or just use the round-trip.
- **Verify after applying** — re-`get` and confirm the change landed before
  telling the user it's done.

---

## Rule 1 — Edit in place, never delete the document

Every `documents.create` / `files create` returns a **new document ID / URL**.
If you rebuild a doc from scratch on each edit and delete the old one:

- The doc URL changes every time → any link the user opened, bookmarked, or
  shared in chat is now dead.
- It is surprising and wasteful — the user reasonably expects a single, stable
  doc to evolve.
- Collaborators who had the old URL lose access silently.

**A doc ID is a stable contract. Treat it as immutable once shared.** Both
paths above preserve it: `files.update --upload` keeps the ID; `batchUpdate` is
in-place by definition. Never `files delete` a doc you've already handed the
user a URL for.

### Inspecting a doc

```bash
gws docs documents get --params '{"documentId":"DOC_ID"}' > doc.json 2>/dev/null
# or, for a readable copy to plan edits:
gws drive files export --params '{"fileId":"DOC_ID","mimeType":"text/markdown"}' -o doc.md
```

Each `body.content[].paragraph` exposes `elements[0].startIndex`,
`elements[-1].endIndex`, and `paragraphStyle.namedStyleType`. Inline images
appear as `inlineObjectElement` with an `inlineObjectId`; metadata lives in the
top-level `inlineObjects` map.

---

## Rule 2 — PNG images from Google Drive

### The limitation (verified, not assumed)

The Docs API inserts images via `insertInlineImage`, which takes a **URL** (not
a Drive file ID). Google's insertion servers fetch that URL **without your
credentials** and re-check the Drive file's sharing ACL — so the URL must be
**publicly shareable**. When org policy blocks "anyone with link" sharing
(`publishOutNotPermitted`), every embed attempt fails:

```
Invalid requests[N].insertInlineImage: Access to the provided image was forbidden.
```

There is **no** `insertInlineImage`-by-file-ID request in the Docs API.

### What works — render, store in Drive, insert manually

1. **Render the diagram to PNG locally** (`mermaid-cli` works well):
   ```bash
   npm install -g @mermaid-js/mermaid-cli          # one-time; needs puppeteer
   npm install -g --allow-scripts=puppeteer @mermaid-js/mermaid-cli  # fetch browser
   mmdc -i diagram.mmd -o diagram.png --backgroundColor white -w 1600
   ```
2. **Upload the PNG to Drive** and share it company-wide (so the "Open full
   size ↗" link and the Drive source are reachable by colleagues — public
   `anyone` sharing is blocked by org policy, but `domain` sharing is allowed):
   ```bash
   FID=$(gws drive +upload diagram.png --parent FOLDER_ID --name "diagram.png" \
     2>/dev/null | jq -r .id)
   # Derive the company domain from your own account (e.g. gomotive.com):
   DOMAIN=$(gws drive about get --params '{"fields":"user"}' 2>/dev/null \
     | jq -r '.user.emailAddress' | sed 's/.*@//')
   # Share with the whole company as readers (link-only; +allowFileDiscovery
   # true would also make it searchable in colleagues' Drive):
   gws drive permissions create --params "{\"fileId\":\"$FID\"}" \
     --json "{\"role\":\"reader\",\"type\":\"domain\",\"domain\":\"$DOMAIN\"}"
   gws drive files get --params "{\"fileId\":\"$FID\"}" 2>/dev/null \
     | jq -r .webViewLink   # use this URL in the "Open full size" link
   ```
   Note: this Drive sharing is *not* needed for the image to appear in the
   doc — the docx-embed path (below) bakes the bytes into the doc, so doc
   readers see the image regardless. Drive sharing is for the full-size link
   and for anyone who wants the source PNG.
3. **Put a clearly-marked placeholder in the Doc** where the image should go,
   with the Drive file name and link, styled so it's easy to spot:
   ```
   ⟪ Insert image: diagram.png — https://drive.google.com/file/d/FILE_ID/view ⟫
   ```
   The user opens the Doc in a browser and uses **Insert → Image → Drive → My
   Drive** to drop the PNG in at that spot. The browser uploads bytes under the
   user's own auth, so no public URL is ever required.
4. Optionally add an **"Open full size ↗"** hyperlink beneath each inserted
   image so readers can view the full-resolution PNG (Docs renders inline
   images small). Use Path 2's `link` op with `"style": "subtle"` to style it.

**Verified bypass:** embedding the PNG *inside* a `.docx` and pushing it via
Path 1's `files.update --upload` lands it as a real inline image in the live
doc — it bypasses the org-policy block, because the bytes are sent under your
own auth (like the browser path), not fetched by Google's insertion servers
from a public URL. This is now the preferred image path under org policy:
render → embed in a docx (or build with `python-docx`) → `files.update --upload`
to the doc. No manual browser step needed.

To verify an image landed after upload, `documents.get` and check the
top-level `inlineObjects` map (or `inlineObjectElement` in `body.content`).

### When the API *can* embed directly

Only when an image URL is genuinely public (e.g. a throwaway public host with
short expiry). Do not assume this works inside a corporate workspace — test
with a throwaway doc first, and prefer the manual-insert path to stay within
org policy.

---

## batchUpdate schema gotchas (Path 2)

- The image request type is **`insertInlineImage`**, not `insertImage`
  (the API rejects `insertImage` with "Unknown property").
- Paragraph style field is **`namedStyleType`**, not `namedStyleId`
  (values: `TITLE`, `HEADING_1`, `HEADING_2`, `NORMAL_TEXT`, …).
- `updateTextStyle.fields` must list every style sub-field you set. The helper
  script fills this in; if you ever build a request by hand, use e.g.
  `"weightedFontFamily,fontSize"` or
  `"link,italic,foregroundColor,fontSize,weightedFontFamily"`.
- `gws` prints a `Using keyring backend…` line on stderr and the JSON on
  stdout. When scripting, redirect stderr away: `gws … > out.json 2>/dev/null`.
- `--json` takes a literal string (no `@file` syntax), so pipe a built file
  with `"$(cat reqs.json)"` — or use the script's `--apply DOC_ID`.
