---
name: create-pr
description: Commit and create a PR on Motive/KeepTruckin repos with Conventional Commit format, branch validation, and Jira integration.
disable-model-invocation: true
author: alexandre.mendonca
tags: [git, commit, pr, jira, github, motive]
---

# Create PR

> This is a **command**, not an agent-invocable skill. It is hidden from the
> system prompt, so the agent will not load it on its own. Run it explicitly
> with `/skill:create-pr`.

Commit changes, then create a PR — one continuous workflow. Enforces Jira ticket, Conventional Commit format, branch naming, and the repo PR template, matching the `commitlint.config.js` rules used across Motive repos. No shortcuts.

Announce at start: "I'm using the create-pr skill to commit and create your PR."

## 0. Motive commit rules (reference)

The Motive-standard `commitlint.config.js` rules (`@commitlint/config-conventional` + custom rules). Apply them as written — do not invent stricter or looser rules.

| Rule | Requirement |
|------|-------------|
| `type-enum` | One of: `feat, fix, docs, style, refactor, perf, test, chore, revert, build, ci` |
| `scope-empty` | Never — scope is **required** |
| `scope-case` | Upper-case — scope is a Jira key (e.g. `DEVPRD-1234`) |
| `valid-jira-scope` | Scope must match `^[A-Z][A-Z0-9]*-\d+$` |
| `subject-case` | Not enforced (avoids false failures on terms like IAM, SQL, HTTP/2) — use lowercase imperative by convention |
| `subject-full-stop` | Never end the subject with `.` |
| `subject-empty` / `type-empty` | Never empty |
| `header-max-length` / `body-max-line-length` / `footer-max-line-length` | 200 chars (room for Jira scope + merge-queue `(#NNNNN)` suffix) |
| `no-special-chars-in-subject` | Only letters (unicode), numbers (unicode), spaces, and `- _ / ( ) . ,` after the `type(SCOPE): ` prefix. **No colons, backticks, brackets, or `key: value` inline.** A trailing GitHub cherry-pick suffix like ` (#30614)` is stripped before checking. |
| `ignores` | Skip validation for a commit whose first line (lowercased) is exactly `initial plan` (Copilot cloud-agent placeholder commit) |

If the current repo's `commitlint.config.js` differs from this table, follow the repo's own config and flag the discrepancy to the user.

## 1. Validate branch name

Required: `type-JIRA_KEY-short-description`
```
^(feat|fix|docs|style|refactor|perf|test|chore|revert|build|ci)-[A-Z]+-\d+-.+$
```

- On `main`/`master`/`develop` → ask for type + description, create: `git checkout -b type-JIRA_KEY-short-description` before staging anything.
- Doesn't match → offer rename: `git branch -m <new-name>`
- Matches → proceed.

## 2. Resolve Jira key

```bash
git branch --show-current
```

Extract `[A-Z]+-\d+` from the branch name → `JIRA_KEY` (e.g. `feat-AICPE-107-xgboost-sbv-cbb` → `AICPE-107`).

No key extractable → load the `jira` skill (`read skill://jira`) and follow section B (Attach a Jira ticket) to find or create a ticket and return `JIRA_KEY`. This ensures every commit traces to a Jira ticket — no exceptions.

## 3. Stage

```bash
git status --short
git add -A
```

Show the user what's staged.

## 4. Generate commit message

```bash
git diff --staged --stat
git diff --staged
```

Analyze the diff:
- **type**: feat / fix / docs / style / refactor / perf / test / chore / revert / build / ci
- **description**: concise lowercase summary, no special characters beyond `- _ / ( ) . ,`

Compose: `type(JIRA_KEY): lowercase description`

## 5. Approve

Use the `ask_user_question` tool:
```
ask_user_question(questions=[{
  question: "Proposed commit message: type(KEY): description. Approve or edit?",
  header: "Commit message",
  options: [
    { label: "Approve (Recommended)", description: "Commit with this message" },
    { label: "Edit", description: "I'll provide a different message" }
  ]
}])
```

## 6. Commit

```bash
git commit -m "type(KEY): description"
```

Pre-commit hooks fire automatically.

## 7. Handle pre-commit failures

Commit succeeds → report hash + message, proceed to step 8.

Pre-commit fails:
1. Show which hooks failed + output
2. Auto-fix: `git diff --staged --name-only | xargs pre-commit run --files`
3. Re-stage: `git add -u`
4. Retry once: `git commit -m "type(KEY): description"`
5. Fails again → show remaining errors, stop. Tell user which violations need manual fixing. Do not retry again.

## 8. Validate all commit messages

Required: `type(JIRA_KEY): description` (lowercase by convention)
```
^(feat|fix|docs|style|refactor|perf|test|chore|revert|build|ci)\([A-Z][A-Z0-9]*-\d+\): .+$
```

Subject rules (commitlint `no-special-chars-in-subject`, see §0): only letters, numbers, spaces, and `- _ / ( ) . ,` after the `type(SCOPE): ` prefix. **No colons, backticks, brackets, or `key: value` inline.**

Skip any commit whose first line, lowercased, is exactly `initial plan` (matches the repo's commitlint `ignores` rule for Copilot cloud-agent placeholder commits).

```bash
# Base branch
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git merge-base HEAD develop 2>/dev/null
# Commits on branch
git log <base>..HEAD --oneline
```

Check each against the format (after excluding "Initial Plan" commits).

- Single non-conforming → amend: `git commit --amend -m "type(JIRA_KEY): corrected description"`
- Multiple → show which fail + corrected messages for each; suggest interactive rebase to reword.

**Do NOT push until all commits conform.**

## 9. Push

```bash
git push -u origin <branch-name>
```

Remote branch diverged → inform user, ask force-push or reconcile.

## 10. Generate PR content

```bash
git diff <base>...HEAD
git log <base>..HEAD --format="%s%n%b"
cat .github/pull_request_template.md
```

- **Title:** `type(JIRA_KEY): lowercase description` (type + key from steps 2 and 4; summarize the change)
- **Body:** fill the repo template from diff + commit history. Append `Jira: https://k2labs.atlassian.net/browse/JIRA_KEY` if not already present.

Use the `ask_user_question` tool to present title + body for approval:
```
ask_user_question(questions=[{
  question: "PR title and body generated. Approve or edit?",
  header: "PR content",
  options: [
    { label: "Approve (Recommended)", description: "Create PR with this title and body" },
    { label: "Edit", description: "I'll provide changes" }
  ]
}])
```

## 11. Update Jira ticket

Update the Jira description to reflect the work done in the PR:

```bash
acli jira workitem edit --key "<JIRA_KEY>" --description "<updated description summarizing the PR work>" --yes
```

If `acli` is unavailable, load `skill://jira/FALLBACK.md` for the REST fallback. For other Jira operations (transition, story points, sprint), load `skill://jira`.

If it deviates significantly, use the `ask_user_question` tool to confirm before updating.

## 12. Create PR

```bash
gh pr create --title "type(JIRA_KEY): lowercase description" --body "<filled-in body>"
```

Never use `gh pr create --fill` — always the company template.

## 13. Report

Output the PR URL.

## Format reference

| Item | Pattern | Example |
|------|---------|---------|
| Commit message | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| PR title | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| Branch name | `type-JIRA-123-description` | `feat-AICPE-107-xgboost-sbv-cbb` |

| Type | Use |
|------|-----|
| feat | New feature |
| fix | Bug fix |
| docs | Documentation only |
| style | Formatting, no code change |
| refactor | Code restructuring |
| perf | Performance |
| test | Adding/fixing tests |
| chore | Maintenance, dependencies, CI config auxiliary tools |
| revert | Reverts a previous commit |
| build | Build system / dependencies |
| ci | CI configuration |

## Red flags

| Thought | Reality |
|---------|---------|
| "I'll add the Jira ticket later" | No. Resolve it first — needed for commits, branch, and PR. |
| "Commit format is close enough" | Close enough will be blocked by commitlint. Match the regex exactly (§0/§8). |
| "Skip the pre-commit retry" | Run it — catches auto-fixable issues like trailing whitespace. |
| "Push and fix the PR body later" | Present PR content for review first. Always. |
| "Small change, skip the template" | Every PR uses the template. No exceptions. |
| "Branch name doesn't matter" | `type-JIRA_KEY-description` is enforced. |
| "Special chars in subject are fine" | No colons/backticks/brackets after `type(SCOPE): ` prefix — commitlint's `no-special-chars-in-subject` blocks the PR. |
| "200 chars is generous, no need to check" | Still enforced — long AI-generated subjects get rejected too. |
| "Assume §0 applies as-is" | Check the repo's own `commitlint.config.js` first — follow it if it differs. |
