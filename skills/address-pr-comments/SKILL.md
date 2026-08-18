---
name: address-pr-comments
description: Address all PR review comments — Copilot and human — in one pass.
disable-model-invocation: true
---

# Address PR Comments

Fetch, evaluate, and act on every PR review comment — automated (Copilot/bots) and human — in one pass.

> This is a **command**, not an agent-invocable skill. It is hidden from the
> system prompt, so the agent will not load it on its own. Run it explicitly
> with `/skill:address-pr-comments`.

**Principle:** Assess before acting. Bot suggestions aren't orders; human comments carry intent. Evaluate each technically before fixing.

If something goes wrong (no PR, no comments, rate limited, auth) or you want the common-mistakes checklist: `skill://address-pr-comments/TROUBLESHOOTING.md`.

Announce at start: "I'm using the address-pr-comments skill to review and address PR comments."

## Process

```
1. DETECT   Find PR from current branch
2. FETCH    Reviews + inline comments + thread IDs
3. SUMMARIZE  Table grouped by source (bot vs human)
4. ITERATE  Per comment: assess, propose fix, ask user — collect decisions, don't edit yet
5. APPLY    Batch-apply approved fixes
6. COMMIT   Stage, commit (Conventional Commits + Jira scope), push
7. REPLY    Reply to every thread; resolve per rules
8. REPORT   Summary table
```

## 1. Detect PR

```bash
gh pr view --json number,url,title,headRefName,baseRefName
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

Use the PR from the current branch only. No PR → stop: "No open PR found for this branch."

## 2. Fetch Reviews, Comments, Threads

Set `REPO=owner/name`, `PR_NUMBER`, split `REPO` → `OWNER`, `REPO_NAME`.

**Reviews**
```bash
gh api "repos/<REPO>/pulls/<PR_NUMBER>/reviews" --paginate \
  --jq '.[] | {id, state, body, reviewer: .user.login, is_bot: (.user.type == "Bot")}'
```

**Inline comments**
```bash
gh api "repos/<REPO>/pulls/<PR_NUMBER>/comments" --paginate \
  --jq '.[] | {id, path, line, body, diff_hunk, reviewer: .user.login, is_bot: (.user.type == "Bot"), in_reply_to_id}'
```

**Threads** (node IDs for resolving in step 7)
```bash
gh api graphql --paginate -f query='
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}' -f owner="<OWNER>" -f repo="<REPO_NAME>" -F number=<PR_NUMBER> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | {thread_id: .id, is_resolved: .isResolved, root_comment_id: .comments.nodes[0].databaseId}'
```

Build: reviews list, inline comments list, `root_comment_id → thread_id` map (step 7).

Classify:
- `is_bot == true`, login matches `copilot`/`copilot[bot]` → **Copilot**
- `is_bot == false` → **Human**
- Group human inline comments by `in_reply_to_id`; address the root only.

No comments → report and stop.

## 3. Present Summary

```
## PR Review Summary
PR: #123 — "Add user authentication"

Copilot (2):
| # | File        | Line | Preview                        |
|---|-------------|------|--------------------------------|
| 1 | src/auth.ts | 42   | "Consider sanitizing input..." |

Human — alice (CHANGES_REQUESTED), bob (COMMENTED):
| # | Reviewer | File         | Line | Preview                            |
|---|----------|--------------|------|------------------------------------|
| 3 | alice    | src/auth.ts  | 78   | "Can we extract this to a helper?" |
```

## 4. Iterate — Copilot First, Then Human

Copilot per comment: show file/line/diff hunk/full text. Assess validity + exact fix + severity (Critical / Recommended / Optional). Wrong → say so.

Use the `ask_user_question` tool:

```
ask_user_question(questions=[{
  question: "Comment #N (Copilot) — <file>:<line>: <preview>. Apply the proposed fix?",
  header: "Copilot fix",
  multiSelect: false,
  options: [
    { label: "Accept (Recommended)", description: "Apply the proposed fix" },
    { label: "Deny", description: "Skip — reply 'Not applicable'" },
    { label: "Custom", description: "I'll provide different instructions" }
  ]
}])
```

Human per comment: show reviewer/time/file/line/diff hunk/full thread. Read intent (bug / nit / design / clarification / blocking). Assess correctness + exact fix. Reviewer mistaken → say so, propose reply.

Use the `ask_user_question` tool:

```
ask_user_question(questions=[{
  question: "Comment #N (@reviewer) — <file>:<line>: <preview>. What should we do?",
  header: "Action",
  multiSelect: false,
  options: [
    { label: "Fix it (Recommended)", description: "Apply the proposed fix" },
    { label: "Reply only", description: "No code change — post an explanation" },
    { label: "Fix and reply", description: "Apply fix and post a reply" },
    { label: "Skip", description: "Ignore this comment" },
    { label: "Discuss", description: "Talk through before deciding" }
  ]
}])
```

**Do NOT edit files during iteration.** Collect all decisions first.

## 5. Apply Fixes

Read each affected file → Edit tool → show each change.

## 6. Commit and Push

Stage modified files. Conventional Commits with Jira scope: `type(JIRA-123): description`. Extract Jira key from branch name (`[A-Z]+-\d+`). Use commit skill if available.

```bash
git add <modified files>
git commit -m "type(JIRA-123): address PR review feedback"
git push
```

## 7. Reply to ALL Comments + Resolve

Every comment gets a reply. Resolve rules:

- **Copilot threads** — always resolve after replying, any action.
- **Human threads** — resolve only when issue closed (Fixed / Not applicable / By design). "Reply only" leaves thread open for the reviewer.

```bash
# Reply to inline comment
gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --method POST \
  --field body="<reply>" --field in_reply_to=<COMMENT_ID>

# Resolve thread (thread_id from step 2 map)
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } }
}' -f threadId="<THREAD_NODE_ID>"

# PR-level review (no thread) — issue comment
gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --method POST --field body="<reply>"
```

**Reply format:**

| Source | Action | Reply | Resolve? |
|--------|--------|-------|----------|
| Copilot | Accept | `Fixed: <one line>` | Yes |
| Copilot | Deny | `Not applicable: <one line reason>` | Yes |
| Copilot | Custom | `<what was done instead>` | Yes |
| Human | Fixed | `Fixed: <one line>` | Yes |
| Human | Fix and reply | `Fixed: <what changed>. <context>` | Yes |
| Human | Reply only | `<explanation — no change because...>` | No |
| Human | Skipped (invalid) | `Not applicable: <one line reason>` | Yes |
| Human | Skipped (intentional) | `By design: <one line>` | Yes |

Replies ≤ 2 sentences. Every comment must get a reply before the PR is done.

## 8. Report

```
## Results
Copilot: 1 fixed, 1 skipped
Human:   2 fixed, 1 replied, 0 skipped
Changes pushed to feature/auth (PR #123)

| # | Source  | File         | Line | Action      | Summary                |
|---|---------|--------------|------|-------------|------------------------|
| 1 | Copilot | src/auth.ts  | 42   | Fixed       | Added input sanitization |
| 3 | alice   | src/auth.ts  | 78   | Fixed+Reply | Extracted buildAuthPayload() |
```

Offer to re-request review: `gh pr edit ${PR_NUMBER} --add-reviewer <reviewer>`.
