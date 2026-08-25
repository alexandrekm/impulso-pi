---
name: create-pr-personal
description: Commit and create a PR on personal repos using Conventional Commits. Simple workflow — no Jira, no strict commitlint, just a clean conventional commit and a PR describing what was done and why.
disable-model-invocation: true
author: alexandre.mendonca
tags: [git, commit, pr, github, conventional-commits]
---

# Create PR (personal)

Commit your changes and open a PR in one go. Uses Conventional Commits for the
commit and PR title, and writes a short PR body describing what changed and why.
No ticket linkage, no branch-naming enforcement beyond "get off the protected
branch" — keep it simple.

Announce at start: "I'm using the create-pr-personal skill to commit and create your PR."

## 0. Conventional Commits

Format: `type: description` — scope is optional, `type(scope): description` when
it genuinely helps.

| Type   | Use                                   |
|--------|---------------------------------------|
| feat   | New feature                           |
| fix    | Bug fix                               |
| docs   | Documentation only                    |
| style  | Formatting, no logic change           |
| refactor | Restructure, no behavior change     |
| perf   | Performance improvement               |
| test   | Adding/fixing tests                   |
| chore  | Tooling, deps, misc                   |
| build  | Build system / dependencies           |
| ci     | CI configuration                      |
| revert | Reverts a previous commit             |

Rules:

- Lowercase imperative subject, no trailing `.` — `feat: add dark mode toggle`.
- Subject ≤ 72 chars; wrap body lines around 100.
- Breaking change: `feat!: drop support for X`, or add a `BREAKING CHANGE:` footer.
- Describe what the diff actually does — don't overstate.

## 1. Get off a protected branch

```bash
git branch --show-current
```

On `main` / `master` / `develop` / `trunk` → ask for a type + short description,
then create a branch before staging:

```bash
git checkout -b <type>-<short-description>
```

Branch naming: `<type>-<short-description>`, kebab-case — e.g.
`feat-dark-mode-toggle`. No ticket prefix needed. If the current branch already
has a reasonable name, just use it.

## 2. Stage

```bash
git status --short
git add -A
```

Show the user what's staged.

## 3. Compose the commit message

```bash
git diff --staged --stat
git diff --staged
```

Pick a type from §0 and write a concise description. Compose:
`type: description` (or `type(scope): description` if a scope clarifies things).

If there are several logical changes already staged, split into one commit per
logical change, each conforming to §0.

## 4. Self-check BEFORE committing

Run this checklist against your proposed message. If **any** answer is wrong,
rewrite before `git commit`:

- [ ] Type is one of `feat fix docs style refactor perf test chore build ci revert`?
- [ ] Subject is lowercase imperative, no trailing `.` — e.g. `feat: add dark mode toggle`?
- [ ] Subject ≤ 72 chars?
- [ ] Scope (if used) is short and clarifies the change — not a free-word dumping ground?
- [ ] Subject describes what the diff actually does, not overstated?

Only when every box passes, go to §5.

## 5. Commit

Show the proposed message, then commit — no approval gate:

```bash
git commit -m "type: description"
```

Pre-commit hooks fire automatically. On failure: show the output, auto-fix what
you can (`pre-commit run --files $(git diff --staged --name-only)`), re-stage,
retry once. Fails again → stop and report what needs manual fixing.

## 6. Push

```bash
git push -u origin <branch-name>
```

Diverged → inform the user and ask whether to force-push or reconcile. Never
force-push without asking first.

## 7. Generate PR content

```bash
git diff <base>...HEAD
git log <base>..HEAD --format="%s%n%b"
```

`<base>` = `main`, `master`, `develop`, or `trunk` — detect with `git branch -a`.

- **Title:** conventional-commit form. Single commit → reuse its subject.
  Multiple commits → summarize the overall change as `type: summary`.
- **Body:** short, plain description of what changed and why. Default shape:

  ```markdown
  ## What
  <one or two lines on the change>

  ## Why
  <motivation>

  ## Notes
  <anything reviewers should know — optional>
  ```

  If the repo has a `.github/pull_request_template.md`, use that template
  instead and fill it from the diff + commit history.

Show the title and body in your response, then create the PR — no approval gate.

## 8. Create PR

```bash
gh pr create --title "type: description" --body "<body>"
```

Pass `--body` explicitly with the content you composed — don't rely on
`gh pr create --fill`'s auto-summary.

## 9. Report

Output the PR URL. Done.
