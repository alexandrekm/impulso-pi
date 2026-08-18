# Commit/PR Rule Reference

Load this file when a commit message is rejected, or when you need the exact rule behind one of the regexes in `SKILL.md`.

## Motive commitlint rules

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

## Format patterns

| Item | Pattern | Example |
|------|---------|---------|
| Commit message | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| PR title | `type(JIRA-123): description` | `feat(AICPE-107): add xgboost model for sbv cbb` |
| Branch name | `type-JIRA-123-description` | `feat-AICPE-107-xgboost-sbv-cbb` |

## Type list

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
