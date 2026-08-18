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

Full commitlint rule table, format patterns, and the type list: `skill://create-pr/REFERENCE.md` — load it if a message is rejected or you need the exact rule behind a regex. If anything goes wrong (pre-commit failures, diverged push, non-conforming commits): `skill://create-pr/TROUBLESHOOTING.md`.

Announce at start: "I'm using the create-pr skill to commit and create your PR."

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

Pre-commit hooks fire automatically. Failure → `skill://create-pr/TROUBLESHOOTING.md`.

## 7. Validate all commit messages

Required: `type(JIRA_KEY): description` (lowercase by convention)
```
^(feat|fix|docs|style|refactor|perf|test|chore|revert|build|ci)\([A-Z][A-Z0-9]*-\d+\): .+$
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

## 10. Update Jira ticket

Update the Jira description to reflect the work done in the PR:

```bash
acli jira workitem edit --key "<JIRA_KEY>" --description "<updated description summarizing the PR work>" --yes
```

If `acli` is unavailable, load `skill://jira/FALLBACK.md` for the REST fallback. For other Jira operations (transition, story points, sprint), load `skill://jira`.

If it deviates significantly, use the `ask_user_question` tool to confirm before updating.

## 11. Create PR

```bash
gh pr create --title "type(JIRA_KEY): lowercase description" --body "<filled-in body>"
```

Never use `gh pr create --fill` — always the company template.

## 12. Report

Output the PR URL.
