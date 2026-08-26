#!/usr/bin/env python3
"""gws-doc-style.py — compile a declarative edit plan into a Google Docs
batchUpdate requests array, so the agent calls this script instead of
hand-writing (or hand-authoring) Python for every Doc-authoring session.

Pure stdlib (json/argparse/sys). No dependencies. Outputs ``{"requests": [...]}``
JSON to stdout (or a file), with index-based requests sorted highest-index-first
so earlier indices stay valid within one batchUpdate. Optionally calls
``gws docs documents batchUpdate`` directly via ``--apply``.

The plan is a JSON object ``{"ops": [ ... ]}``. Each op becomes one batchUpdate
request. Ops that touch a range use ``match`` (substring of a paragraph's text,
resolved to absolute indices via the ``documents.get`` dump) or explicit
``start``/``end`` indices or a ``paragraph`` index.

Flow this enables (taught in SKILL.md):
  gws docs documents create --json '{"title":"T"}'      # once
  gws docs +write --document ID --text '...all prose...'# bulk plain text
  gws docs documents get --params '{"documentId":"ID"}' > doc.json
  # write plan.json: {"ops":[{"heading":2,"match":"Architecture"}, ...]}
  python3 gws-doc-style.py --doc doc.json --plan plan.json -o reqs.json
  gws docs documents batchUpdate --params '{"documentId":"ID"}' --json "$(cat reqs.json)"

Or in one step:
  python3 gws-doc-style.py --doc doc.json --plan plan.json --apply ID

Plan ops
  {"heading": 1|2|3, "match": "..."}            HEADING_1/2/3 (updateParagraphStyle)
  {"heading": 1|2|3, "paragraph": 3}            by 0-based paragraph index
  {"title": true, "match": "..."}               TITLE style
  {"normal": true, "match": "..."}              NORMAL_TEXT (reset)
  {"link": {"url": "..."}, "match": "..."}      hyperlink the matched text
  {"link": {"url": "...", "style": "subtle"}, "match": "..."}
                                                 link + italic 9pt blue (for "↗")
  {"bold": true, "match": "..."}                bold the matched text
  {"italic": true, "match": "..."}              italic
  {"insert": {"text": "..."}, "after": "match"} insertText after the matched
                                                 paragraph (or at "index": N)
  {"delete": {"match": "..."}}                  deleteContentRange on the match
  {"delete": {"start": S, "end": E}}            deleteContentRange by index
  {"replace": {"find": "...", "with": "..."}}   replaceAllText (index-free;
                                                 optional "matchCase": true)

Exit codes: 0 ok, 2 plan/schema error, 3 gws invocation failed (with --apply).
"""

import argparse
import json
import subprocess
import sys
from typing import Any

# ─── documents.get parsing ──────────────────────────────────────────────────


def paragraphs(doc: dict) -> list[dict]:
    """Flatten body.content[] into a list of paragraph descriptors:
    {start, end, style, text, index}. `end` is the Docs API endIndex
    (exclusive, includes the paragraph's trailing newline)."""
    out: list[dict] = []
    content = (doc.get("body") or {}).get("content") or []
    pidx = 0
    for el in content:
        p = el.get("paragraph")
        if not p:
            continue
        elems = p.get("elements") or []
        if not elems:
            continue
        start = elems[0].get("startIndex", 1)
        end = elems[-1].get("endIndex", start)
        text = "".join((e.get("textRun") or {}).get("content", "") for e in elems)
        style = (p.get("paragraphStyle") or {}).get("namedStyleType", "NORMAL_TEXT")
        out.append(
            {"start": start, "end": end, "style": style, "text": text, "index": pidx}
        )
        pidx += 1
    return out


def find_match(pars: list[dict], needle: str) -> tuple[int, int, dict]:
    """Return (absStart, absEnd, paragraph) for the first paragraph whose text
    contains `needle`. absStart/absEnd bound the *substring* (not the whole
    paragraph). Errors if not found."""
    for p in pars:
        off = p["text"].find(needle)
        if off != -1:
            return p["start"] + off, p["start"] + off + len(needle), p
    sys.exit(f"plan error: no paragraph contains match text {needle!r}")


def para_for_match(pars: list[dict], needle: str) -> dict:
    """Return the first paragraph whose text contains `needle` (whole-paragraph
    ops like heading/title use the paragraph range, not the substring)."""
    for p in pars:
        if needle in p["text"]:
            return p
    sys.exit(f"plan error: no paragraph contains match text {needle!r}")


# ─── request builders ───────────────────────────────────────────────────────


def paragraph_style(start: int, end: int, named: str) -> dict:
    return {
        "updateParagraphStyle": {
            "range": {"startIndex": start, "endIndex": end},
            "paragraphStyle": {"namedStyleType": named},
            "fields": "namedStyleType",
        }
    }


def text_style(start: int, end: int, style: dict, fields: str) -> dict:
    return {
        "updateTextStyle": {
            "range": {"startIndex": start, "endIndex": end},
            "textStyle": style,
            "fields": fields,
        }
    }


HEADING_NAMES = {1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3"}


def build_op(op: dict, pars: list[dict]) -> dict:
    """Compile one plan op into a batchUpdate request dict."""
    # ── Paragraph styles ──────────────────────────────────────────────────
    if "heading" in op:
        named = HEADING_NAMES.get(op["heading"])
        if not named:
            sys.exit(f"plan error: heading level must be 1|2|3, got {op['heading']!r}")
        if "match" in op:
            p = para_for_match(pars, op["match"])
        elif "paragraph" in op:
            p = pars[op["paragraph"]]
        else:
            sys.exit("plan error: heading op needs 'match' or 'paragraph'")
        return paragraph_style(p["start"], p["end"], named)

    if op.get("title"):
        p = para_for_match(pars, op["match"])
        return paragraph_style(p["start"], p["end"], "TITLE")

    if op.get("normal"):
        p = para_for_match(pars, op["match"])
        return paragraph_style(p["start"], p["end"], "NORMAL_TEXT")

    # ── Text styles ───────────────────────────────────────────────────────
    if "link" in op:
        s, e, _ = find_match(pars, op["match"])
        url = op["link"].get("url", "")
        ts: dict[str, Any] = {"link": {"url": url}}
        fields = "link"
        if op["link"].get("style") == "subtle":
            ts.update(
                {
                    "italic": True,
                    "foregroundColor": {
                        "color": {"rgbColor": {"red": 0.13, "green": 0.45, "blue": 0.86}}
                    },
                    "fontSize": {"magnitude": 9, "unit": "PT"},
                    "weightedFontFamily": {"fontFamily": "Arial", "weight": 400},
                }
            )
            fields = "link,italic,foregroundColor,fontSize,weightedFontFamily"
        return text_style(s, e, ts, fields)

    if op.get("bold"):
        s, e, _ = find_match(pars, op["match"])
        return text_style(s, e, {"bold": True}, "bold")

    if op.get("italic"):
        s, e, _ = find_match(pars, op["match"])
        return text_style(s, e, {"italic": True}, "italic")

    # ── insertText ────────────────────────────────────────────────────────
    if "insert" in op:
        ins = op["insert"]
        text = ins.get("text", "")
        if "after" in ins:  # insert at the end of the matched paragraph
            p = para_for_match(pars, ins["after"])
            idx = p["end"] - 1  # before the paragraph's trailing newline
        elif "before" in ins:
            p = para_for_match(pars, ins["before"])
            idx = p["start"]
        elif "index" in ins:
            idx = ins["index"]
        else:
            sys.exit("plan error: insert needs 'after', 'before', or 'index'")
        return {"insertText": {"location": {"index": idx}, "text": text}}

    # ── deleteContentRange ────────────────────────────────────────────────
    if "delete" in op:
        d = op["delete"]
        if "match" in d:
            s, e, _ = find_match(pars, d["match"])
        elif "start" in d and "end" in d:
            s, e = d["start"], d["end"]
        else:
            sys.exit("plan error: delete needs 'match' or 'start'+'end'")
        return {"deleteContentRange": {"range": {"startIndex": s, "endIndex": e}}}

    # ── replaceAllText (index-free) ───────────────────────────────────────
    if "replace" in op:
        r = op["replace"]
        return {
            "replaceAllText": {
                "replaceText": r.get("with", ""),
                "containsText": {
                    "text": r.get("find", ""),
                    "matchCase": bool(r.get("matchCase", False)),
                },
            }
        }

    sys.exit(f"plan error: unrecognized op: {json.dumps(op)}")


# ─── sorting (highest index first; index-free last) ────────────────────────


def op_index(req: dict) -> int | None:
    """The primary index an index-based request touches, for descending sort.
    Returns None for index-free requests (replaceAllText)."""
    if "insertText" in req:
        return req["insertText"]["location"]["index"]
    if "deleteContentRange" in req:
        return req["deleteContentRange"]["range"]["startIndex"]
    if "updateTextStyle" in req:
        return req["updateTextStyle"]["range"]["startIndex"]
    if "updateParagraphStyle" in req:
        return req["updateParagraphStyle"]["range"]["startIndex"]
    return None


def sort_requests(reqs: list[dict]) -> list[dict]:
    indexed = [r for r in reqs if op_index(r) is not None]
    free = [r for r in reqs if op_index(r) is None]
    indexed.sort(key=op_index, reverse=True)  # highest index first
    return indexed + free  # index-free (replaceAllText) run after


# ─── main ───────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compile a declarative plan into a Google Docs batchUpdate "
        "requests array (pure JSON builder; pairs with the gws CLI)."
    )
    ap.add_argument("--doc", help="path to a `gws docs documents get` JSON dump")
    ap.add_argument(
        "--plan",
        help='path to a plan JSON {"ops":[...]} (or "-" for stdin)',
    )
    ap.add_argument("-o", "--out", help="write requests JSON here (default: stdout)")
    ap.add_argument(
        "--apply",
        metavar="DOC_ID",
        help="run `gws docs documents batchUpdate` with the built requests directly",
    )
    args = ap.parse_args()

    plan_raw = sys.stdin.read() if args.plan == "-" else None
    if plan_raw is None:
        if not args.plan:
            ap.error("--plan is required")
        with open(args.plan, "r", encoding="utf-8") as f:
            plan_raw = f.read()
    try:
        plan = json.loads(plan_raw)
    except json.JSONDecodeError as e:
        sys.exit(f"plan error: invalid plan JSON: {e}")
    ops = plan.get("ops") if isinstance(plan, dict) else None
    if not isinstance(ops, list):
        sys.exit("plan error: expected {\"ops\": [ ... ]}")

    pars: list[dict] = []
    if args.doc:
        try:
            with open(args.doc, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            sys.exit(f"doc error: could not read --doc: {e}")
        pars = paragraphs(doc)

    reqs = [build_op(op, pars) for op in ops]
    body = json.dumps({"requests": sort_requests(reqs)}, ensure_ascii=False)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(body + "\n")
    else:
        print(body)

    if args.apply:
        cmd = [
            "gws",
            "docs",
            "documents",
            "batchUpdate",
            "--params",
            json.dumps({"documentId": args.apply}),
            "--json",
            body,
        ]
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError as e:
            sys.exit(f"gws batchUpdate failed (exit {e.returncode})")
        except FileNotFoundError:
            sys.exit("gws not found on PATH (needed for --apply)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
