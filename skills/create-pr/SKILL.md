---
name: create-pr
description: Commit and create a PR on Motive/KeepTruckin repos with Conventional Commit format, branch validation, and Jira integration.
disable-model-invocation: true
author: alexandre.mendonca
tags: [git, commit, pr, jira, github, motive]
---

# Create PR

Commit changes, then create a PR — one continuous workflow. Enforces Jira ticket, Conventional Commit format, branch naming, and the repo PR template.

If anything goes wrong (pre-commit failures, diverged push, non-conforming commits): `skill://create-pr/TROUBLESHOOTING.md`.

Announce at start: "I'm using the create-pr skill to commit and create your PR."

## 0. Commitlint rules — apply these while composing, not after rejection

The Motive-standard `commitlint.config.js` rules (`@commitlint/config-conventional` + custom rules). Get the message right the first time — do not rely on commit/PR rejection to catch violations.

| Rule | Requirement |
|------|-------------|
| `type-enum` | One of: `feat, fix, docs, style, refactor, perf, test, revert, build, ci` — **never `chore`** (see semver mapping below) |
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

Only these trigger a semver release; the rest describe work but produce no version bump:

| Type | Semver bump |
|------|-------------|
| `feat` | MINOR |
| `fix`, `perf` | PATCH |
| `BREAKING CHANGE` footer (any type) | MAJOR |
| `docs`, `style`, `refactor`, `test`, `build`, `ci`, `revert` | none (no release) |

| Type | Use |
|------|-----|
| feat | New feature |
| fix | Bug fix |
| docs | Documentation only |
| style | Formatting, no code change |
| refactor | Code restructuring |
| perf | Performance |
| test | Adding/fixing tests |
| revert | Reverts a previous commit |
| build | Build system / dependencies |
| ci | CI configuration |

| Item | Pattern | Example |
|------|---------|---------|
| Commit message | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| PR title | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| Branch name | `type-JIRA-123-description` | `feat-AICPE-107-xgboost-sbv-cbb` |

## 1. Validate branch name

Required: `type-JIRA_KEY-short-description`
```
^(feat|fix|docs|style|refactor|perf|test|revert|build|ci)-[A-Z]+-\d+-.+$
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

Analyze the diff and pick type + description per the §0 rules above. Compose: `type(JIRA_KEY): lowercase description`.

## 5. Proposed commit message

Show the proposed commit message `type(KEY): lowercase description` in your response, then proceed to commit (§6). No approval gate — do not call `ask_user_question` here.

## 6. Commit

```bash
git commit -m "type(KEY): description"
```

Pre-commit hooks fire automatically. Failure → `skill://create-pr/TROUBLESHOOTING.md`.

## 7. Validate all commit messages

Required: `type(JIRA_KEY): description` (lowercase by convention)
```
^(feat|fix|docs|style|refactor|perf|test|revert|build|ci)\([A-Z][A-Z0-9]*-\d+\): .+$
```

Subject: only letters, numbers, spaces, and `- _ / ( ) . ,` after the `type(SCOPE): ` prefix. **No colons, backticks, brackets, or `key: value` inline.** Skip any commit whose first line, lowercased, is exactly `initial plan` (Copilot cloud-agent placeholder).

```bash
# Base branch
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git merge-base HEAD develop 2>/dev/null
# Commits on branch
git log <base>..HEAD --oneline
```

Check each against the format (after excluding "Initial Plan" commits). Non-conforming commit(s) → `skill://create-pr/TROUBLESHOOTING.md`.

**Do NOT push until all commits conform.**

## 8. Push

```bash
git push -u origin <branch-name>
```

Remote branch diverged → `skill://create-pr/TROUBLESHOOTING.md`.

## 9. Generate PR content

```bash
git diff <base>...HEAD
git log <base>..HEAD --format="%s%n%b"
cat .github/pull_request_template.md
```

- **Title:** `type(JIRA_KEY): lowercase description` (type + key from steps 2 and 4; summarize the change)
- **Body:** fill the repo template from diff + commit history. Append `Jira: https://k2labs.atlassian.net/browse/JIRA_KEY` if not already present.

Proceed directly to create the PR (§11) with the generated title and body — no approval gate. Show the title and body in your response.

## 10. Update Jira ticket

Update the Jira description to reflect the work done in the PR:

```bash
acli jira workitem edit --key "<JIRA_KEY>" --description "<updated description summarizing the PR work>" --yes
```

If `acli` is unavailable, load `skill://jira/FALLBACK.md` for the REST fallback. For other Jira operations (transition, story points, sprint), load `skill://jira`.

If it deviates significantly, note the deviation in the update body rather than blocking with a prompt.

## 11. Create PR

```bash
gh pr create --title "type(JIRA_KEY): lowercase description" --body "<filled-in body>"
```

Never use `gh pr create --fill` — always the company template.

## 12. Report

Output the PR URL.
