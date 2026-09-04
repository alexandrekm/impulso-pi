---
description: Review someone else's PR interactively — show-me visual walkthrough first, findings triage via ask_user_question, then post one GitHub review with line + general comments after confirmation
---

# Review PR (as Reviewer)

Review a PR authored by someone else. Understand first, find issues second, post last.

**Principle:** See before judging. Never post a comment the user hasn't approved. One review, one API call — no comment-by-comment drip.

If something goes wrong (no argument, PR not found, auth, 422 on line comments, rate limited) or you want the common-mistakes checklist: `read skills/review-pr/TROUBLESHOOTING.md` (path relative to the pi config dir).

Announce at start: "I'm using the /review-pr command to review this PR."

## Process

```
1. RESOLVE   PR number/URL from the REQUIRED argument
2. FETCH     Metadata, changed files, diff, head SHA
3. SHOW      Visual show-me walkthrough of the PR — pause for the user
4. REVIEW    Full findings pass (severity + file:line + proposed comment text)
5. TRIAGE    Interactive pick: line comment / general body / skip / reword
6. DRAFT     Final review draft: event, body, line-comment table
7. POST      One gh api reviews call — only after explicit confirmation
8. REPORT    Summary of what was posted
```

## 1. Resolve PR

The argument is REQUIRED: `/review-pr 123` or `/review-pr https://github.com/org/repo/pull/123`.

- No argument → stop: "Which PR? Pass a number or URL: `/review-pr 123`". Do NOT fall back to the current branch — this flow reviews other people's PRs, which rarely match your own branch.
- Bare number → resolve the repo from cwd: `gh repo view --json nameWithOwner --jq '.nameWithOwner'`. Not inside a repo → ask for `owner/repo` or a full URL.
- URL → parse `owner/repo` and the number from it; cwd doesn't need to be the repo.

Set `REPO=owner/name`, `PR_NUMBER`, split `REPO` → `OWNER`, `REPO_NAME`.

## 2. Fetch PR Data

```bash
gh pr view <PR_NUMBER> --repo <REPO> --json number,url,title,author,baseRefName,headRefName,headRefOid,body,additions,deletions,changedFiles,reviews,labels
```

**Per-file diffs** (paginated, includes patch hunks):

```bash
gh api "repos/<REPO>/pulls/<PR_NUMBER>/files" --paginate \
  --jq '.[] | {filename, status, additions, deletions, patch}'
```

Save `headRefOid` — required as `commit_id` when posting the review in step 7.

Large PRs: if the diff doesn't fit comfortably, fetch per-file patches in batches, and skim generated/lock files (`*.lock`, `package-lock.json`, snapshots, minified assets) — mark them as skipped in the walkthrough.

When a hunk needs more surrounding context than the patch shows, fetch the full file at the head SHA (read-only — do NOT `gh pr checkout` into the user's worktree):

```bash
gh api "repos/<REPO>/contents/<PATH>?ref=<HEAD_SHA>" --jq '.content' | base64 -d
```

## 3. SHOW — Visual Walkthrough (show-me pass)

Before reviewing anything, show the user what the PR *is*. Read the show-me prompt template and apply its visual vocabulary to the PR content:

```
read prompts/show-me.md   # path relative to the pi config dir
```

Present, using its formats (file trees, diff-shaped sketches, call trees, Mermaid — pick the smallest set that makes the PR clear):

- **Header:** title, author, base ← head, +additions/−deletions, changed-files count, labels, existing review states.
- **Intent:** 2–3 sentences on what the PR claims to do (from the body) vs. what it actually does (from the diff) — call out mismatches.
- **Shape:** file tree of changed files grouped by area/purpose, each annotated with what the change is for.
- **Flow:** for behavior changes, a call tree or Mermaid sequence of the new/changed path.
- **Key hunks:** the 1–3 diffs that carry the core of the change, shown as diffs.

Then STOP and use the `ask_user_question` tool:

```
ask_user_question(questions=[{
  question: "That's the PR. Ready for the review pass, or do you want to steer first?",
  header: "Walkthrough",
  multiSelect: false,
  options: [
    { label: "Start reviewing (Recommended)", description: "Run the full findings pass over the diff" },
    { label: "Focus areas", description: "I'll name files/concerns to prioritize before the pass" },
    { label: "Questions first", description: "I have questions about the PR before any review" }
  ]
}])
```

Honor focus areas and questions before continuing.

## 4. REVIEW — Findings Pass

Review the diff as a reviewer, not a linter. Look for:

- **Correctness:** logic errors, off-by-one, broken edge cases, race conditions, error-handling gaps, regression risk against the PR's stated intent.
- **Contract breaks:** changed APIs/props/schemas without updated callers, missing migrations, behavior changes outside the PR's stated scope.
- **Security:** injection, secrets, unsafe deserialization, missing auth checks.
- **Consistency:** deviations from patterns visible in surrounding code (fetch full files per step 2 when unsure).
- **Tests:** missing coverage for new branches; changed behavior without updated tests.
- **Clarity:** misleading names, dead code, uncommented non-obvious logic. Nits only when genuinely worth the author's time.

For each finding produce: severity (Blocker / Major / Minor / Nit / Question), file, target line, one-line summary, and the exact comment text you'd post.

**Line-target rule:** a line comment can only anchor to a line that appears in the diff (RIGHT side for added/changed lines, LEFT for removed). Findings about untouched code can't be line comments — mark them `commentable: no` and treat them as general-body candidates with `path:line` references.

Present the full findings table:

```
## Findings (N)

| # | Severity | File        | Line | Commentable | Summary                    |
|---|----------|-------------|------|-------------|----------------------------|
| 1 | Blocker  | src/auth.ts | 42   | yes         | Token expiry never checked |
| 2 | Question | src/api.ts  | —    | no → body   | Why drop the retry policy? |
```

Zero findings → say so and jump to step 6 — an APPROVE or a plain COMMENT review may still be appropriate; ask the user.

## 5. TRIAGE — Interactive Selection

Use the `ask_user_question` tool. Batch up to 4 questions per call; loop for more.

First, one multiSelect over all findings:

```
ask_user_question(questions=[{
  question: "Which findings should go into the review? (selected = included)",
  header: "Findings",
  multiSelect: true,
  options: [
    { label: "#1 Blocker auth.ts:42", description: "Token expiry never checked — line comment" },
    { label: "#2 Question api.ts", description: "Why drop the retry policy? — goes into review body" }
  ]
}])
```

- Selected commentable findings become **line comments**; selected non-commentable findings fold into the **general body** automatically.
- The user may reword any proposed comment via the "Type something." row — use their wording verbatim for that comment.
- The user may add brand-new comments (line or general) that weren't findings — accept `path:line` + text and validate the line against the diff (step 4 rule).

Then ask about the general body:

```
ask_user_question(questions=[{
  question: "Add a general review comment? (overall assessment, praise, non-line findings)",
  header: "General body",
  multiSelect: false,
  options: [
    { label: "Yes, draft one (Recommended)", description: "Overall assessment + selected non-commentable findings" },
    { label: "Findings only", description: "Body = only the selected non-commentable findings" },
    { label: "No body", description: "Line comments only (a minimal body is still sent — GitHub requires one)" }
  ]
}])
```

## 6. DRAFT — Final Review Preview

Ask the review event:

```
ask_user_question(questions=[{
  question: "Submit the review as…",
  header: "Review event",
  multiSelect: false,
  options: [
    { label: "Comment (Recommended)", description: "Neutral — feedback without approval state" },
    { label: "Approve", description: "LGTM — body + optional comments" },
    { label: "Request changes", description: "Blocking — only when Blocker/Major findings were selected" }
  ]
}])
```

Then show the complete draft: event, full body text, and a table of line comments (file, line, exact comment text). Nothing has been posted yet.

## 7. POST — One Review, One Call

Only after the user explicitly confirms the draft (final `ask_user_question`: Post / Edit / Abort):

Write the payload to a temp file (avoids shell-quoting issues):

```json
{
  "commit_id": "<HEAD_SHA>",
  "body": "<general body>",
  "event": "COMMENT",
  "comments": [
    { "path": "src/auth.ts", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
```

```bash
gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --method POST --input /tmp/review-${PR_NUMBER}.json \
  --jq '{id, state, html_url}'
```

- `event` ∈ `COMMENT` / `APPROVE` / `REQUEST_CHANGES`.
- Multi-line comment: add `"start_line": <first>, "start_side": "RIGHT"` alongside `line` (the last line of the range).
- Commenting on a removed line: `"side": "LEFT"`, `line` = the old file's line number.
- 422 "line must be part of the diff" → drop the offending comment into the body as `path:line` + text, retry once, and tell the user it moved.
- Delete the temp file after a successful post.

## 8. REPORT

```
## Review posted
PR #123 — COMMENT — https://github.com/org/repo/pull/123#pullrequestreview-456

| # | File        | Line | Severity | Posted as    |
|---|-------------|------|----------|--------------|
| 1 | src/auth.ts | 42   | Blocker  | line comment |
| 2 | src/api.ts  | —    | Question | body         |
```

Mention anything skipped, reworded, or moved to the body.
