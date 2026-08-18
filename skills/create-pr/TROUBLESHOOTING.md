# Troubleshooting

Load this file when something in the main flow doesn't go as expected. Rule details live in `SKILL.md` §0.

## Pre-commit hook failures (step 6)

Commit succeeds → report hash + message, proceed to step 7 in `SKILL.md`.

Pre-commit fails:
1. Show which hooks failed + output
2. Auto-fix: `git diff --staged --name-only | xargs pre-commit run --files`
3. Re-stage: `git add -u`
4. Retry once: `git commit -m "type(KEY): description"`
5. Fails again → show remaining errors, stop. Tell user which violations need manual fixing. Do not retry again.

## Non-conforming commit messages (step 7)

- Single non-conforming → amend: `git commit --amend -m "type(JIRA_KEY): corrected description"`
- Multiple → show which fail + corrected messages for each; suggest interactive rebase to reword.

## Diverged remote branch (step 8)

Remote branch diverged → inform user, ask force-push or reconcile. Never force-push without asking first.

## Red flags

| Thought | Reality |
|---------|---------|
| "I'll add the Jira ticket later" | No. Resolve it first — needed for commits, branch, and PR. |
| "Commit format is close enough" | Close enough will be blocked by commitlint. Match the rules in `SKILL.md` §0 exactly. |
| "Skip the pre-commit retry" | Run it — catches auto-fixable issues like trailing whitespace. |
| "Push and fix the PR body later" | Present PR content for review first. Always. |
| "Small change, skip the template" | Every PR uses the template. No exceptions. |
| "Branch name doesn't matter" | `type-JIRA_KEY-description` is enforced. |
| "Special chars in subject are fine" | No colons/backticks/brackets after `type(SCOPE): ` prefix — commitlint's `no-special-chars-in-subject` blocks the PR. |
| "200 chars is generous, no need to check" | Still enforced — long AI-generated subjects get rejected too. |
| "Assume §0's rules apply as-is" | Check the repo's own `commitlint.config.js` first — follow it if it differs. |
