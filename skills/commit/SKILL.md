---
name: commit
description: Use this when doing a commit on a Motive/KeepTruckin repo.
author: alexandre.mendonca
tags: [git, commit, commitlint, conventional-commits, motive]
---

# Commit

Make **one** git commit with a message that passes the repo's `commitlint` /
`commit-msg` hook on the first try. Use this for any commit you make on your own
— follow-ups on an open PR, CI fixes, iteration — not the end-to-end PR flow
(that's `create-pr`).

The two things that get commit messages rejected most often are:

1. **Wrong type or missing/Jira-less scope** — `chore` is not allowed; scope must
   be a Jira key like `AICPE-107`, not a free word.
2. **Special characters in the subject** — after `type(SCOPE): ` the description
   must contain only letters, numbers, spaces, and `- _ / ( ) . ,`. No extra
   colons, backticks, square brackets, or `key: value` inline.

Get both right before you run `git commit`. Do not rely on the hook to catch
them — compose a conforming message up front.

Announce at start: "I'm using the commit skill to write a commitlint-compliant commit message."

## 0. commitlint rules — check the repo's config first

```bash
cat commitlint.config.js 2>/dev/null || cat .commitlintrc* 2>/dev/null
```

If the repo's config differs from the table below, **follow the repo's config**
and flag the discrepancy to the user. Otherwise apply:

| Rule | Requirement |
|------|-------------|
| `type-enum` | One of: `feat, fix, docs, style, refactor, perf, test, revert, build, ci` — **never `chore`** |
| `scope-empty` | Never — scope is **required** |
| `scope-case` | Upper-case — scope is a Jira key (e.g. `DEVPRD-1234`) |
| `valid-jira-scope` | Scope must match `^[A-Z][A-Z0-9]*-\d+$` |
| `subject-full-stop` | Never end the subject with `.` |
| `subject-empty` / `type-empty` | Never empty |
| `header-max-length` / `body-max-line-length` / `footer-max-line-length` | 200 chars |
| `no-special-chars-in-subject` | After `type(SCOPE): ` only letters, numbers, spaces, and `- _ / ( ) . ,`. **No colons, backticks, brackets, or `key: value`.** A trailing GitHub cherry-pick suffix like ` (#30614)` is stripped before checking. |
| `ignores` | Skip validation for a commit whose first line (lowercased) is exactly `initial plan` |

Semver mapping: `feat` → MINOR, `fix`/`perf` → PATCH, `BREAKING CHANGE` footer (any type) → MAJOR. All other types produce no release.

| Type | Use |
|------|-----|
| feat | New feature |
| fix | Bug fix |
| docs | Documentation only |
| style | Formatting, no code change |
| refactor | Code restructuring, no behavior change |
| perf | Performance |
| test | Adding/fixing tests |
| revert | Reverts a previous commit |
| build | Build system / dependencies |
| ci | CI configuration |

Format: `type(JIRA-123): lowercase description`
Example: `feat(AICPE-107): add xgboost model for sbv cbb`

## 1. Resolve the Jira key (the scope)

```bash
git branch --show-current
```

Extract `[A-Z]+-\d+` from the branch name → `JIRA_KEY`
(e.g. `feat-AICPE-107-xgboost-sbv-cbb` → `AICPE-107`). No key extractable → load
the `jira` skill (`read skill://jira`) section B to find/create a ticket and
return `JIRA_KEY`. Every commit traces to a Jira ticket — no exceptions.

## 2. Stage

If files aren't already staged:

```bash
git status --short
git add -A
```

Show what's staged. If the user already staged a specific subset, respect it —
don't `git add -A` over a deliberate partial stage.

## 3. Compose the message

```bash
git diff --staged --stat
git diff --staged
```

Analyze the diff. Pick `type` + write a terse lowercase imperative `description`
per §0. Compose:

```
type(JIRA_KEY): lowercase description
```

If several logical changes are staged, split into one commit per logical change,
each conforming to §0. This skill handles one commit at a time — loop per
logical change.

## 4. Self-check BEFORE committing (this is the important step)

Run this checklist against your proposed message. If **any** answer is wrong,
rewrite before `git commit`:

- [ ] Type is one of `feat fix docs style refactor perf test revert build ci` — **not `chore`**?
- [ ] Scope is exactly `JIRA_KEY` from §1 (matches `[A-Z]+-\d+`), uppercase, no extra word?
- [ ] Header is `type(JIRA_KEY): description` with a single `: ` after the scope's `)`?
- [ ] Description after `) ` has **only** letters, numbers, spaces, and `- _ / ( ) . ,` — no `:`, no backticks, no `[ ]`, no `key: value`?
- [ ] No trailing `.` on the subject?
- [ ] Header ≤ 200 chars?
- [ ] Subject describes what the diff does, lowercase imperative, not a full sentence?

Only when every box passes, go to §5.

## 5. Commit

```bash
git commit -m "type(JIRA_KEY): description"
```

## 6. If the commit-msg / commitlint hook rejects it

Do not abandon the commit. The hook prints the exact rule that failed.

1. Read the hook output — it names the failing rule (e.g.
   `no-special-chars-in-subject`, `type-enum`, `scope-empty`).
2. Map it back to the §0 table and rewrite the message so it passes §4.
3. Retry: `git commit -m "type(JIRA_KEY): corrected description"`
4. Pre-commit (code) hook failures are separate from commitlint (message)
   failures. For pre-commit: show output, auto-fix
   (`git diff --staged --name-only | xargs pre-commit run --files`), re-stage
   (`git add -u`), retry once. Fails again → stop, report what needs manual
   fixing.
5. commitlint fails twice on the same rule → stop. Show the message, the rule,
   and your correction, and ask the user before retrying again. Don't loop.

## 7. Report

Output the commit hash and final message. Done — do not push or open a PR from
this skill; that's `create-pr`'s job.
