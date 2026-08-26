---
name: jira
description: Resolve, find, create, and manage Jira tickets via acli.
author: alexandre.mendonca
tags: [jira, acli, ticket, workflow]
---

# Jira

Resolve a Jira ticket for current work, search tickets, create tickets, transition, and manage sprints — via the `acli` CLI. Every piece of work must trace to a Jira ticket. No JIRA_KEY = no branch = no PR.

**Requires `acli`** installed and authenticated. Verify before first use:

```bash
acli auth status   # must show ✓ Authenticated + site k2labs.atlassian.net
```

If `acli` is missing, install it and run `acli auth login`. The REST fallback (`FALLBACK.md`) needs two env vars — `JIRA_EMAIL` (your `@gomotive.com` address) and `ATLASSIAN_API_KEY` (already in env). You only need them when `acli` is unavailable or for the no-`acli` operations (sprint-add, story points, createmeta); a healthy `acli auth status` means you do **not** have to set them.

If `acli` is unavailable or fails, REST API fallbacks are in `skill://jira/FALLBACK.md` — load it on demand. Some operations (sprint-add, story points, createmeta) have no `acli` equivalent and always need REST.

Full command reference: `skill://jira/REFERENCE.md` — load it when you need flags or commands not covered below.

If something goes wrong, check `skill://jira/TROUBLESHOOTING.md` for common mistakes.

Announce at start: "I'm using the jira skill to resolve the Jira ticket."

## Quick command reference

| Operation | Command |
|-----------|---------|
| Search | `acli jira workitem search --jql "..." --json --limit 20` |
| View | `acli jira workitem view KEY-123 --fields "*all" --json` |
| Create | `acli jira workitem create --summary "..." --description "..." --project "..." --type "Task" --assignee "@me" --parent "EPIC-1" --label "mlp"` |
| Edit | `acli jira workitem edit --key "KEY-123" --summary "..." --description "..." --yes` |
| Transition | `acli jira workitem transition --key "KEY-123" --status "In Progress" --yes` |
| Assign | `acli jira workitem assign --key "KEY-123" --assignee "@me"` |
| Comment | `acli jira workitem comment create --key "KEY-123" --body "..."` |
| List projects | `acli jira project list --json` |
| List boards | `acli jira board search --project "..." --type scrum --json` |
| Active sprints | `acli jira board list-sprints --id <BOARD_ID> --state active --json` |

Key flags: `--json` (always prefer for parsing), `--yes` (skip prompts in non-interactive use), `--paginate` (fetch all results).

`workitem search` valid `--fields`: `issuetype,key,assignee,priority,status,summary` only — `project` is **not** allowed. Infer project from key prefix.

## A. Find a ticket

### Ticket ID lookup

Input matches `[A-Z]+-\d+` → direct view:

```bash
acli jira workitem view <KEY> --fields "key,issuetype,summary,status,priority,assignee,reporter,description" --json
```

Output:
```
AICPE-107    Task   In Progress  Add XGBoost model for SBV CBB

Description:
  Implement XGBoost-based model for predicting SBV CBB outcomes...

Priority:  High
Reporter:  Jane Smith
URL:       https://k2labs.atlassian.net/browse/AICPE-107
```

Description up to ~5 lines, truncate with `…`. Omit empty fields.

### Natural language → JQL

```bash
acli jira workitem search --jql "<JQL>" --json --limit 20
```

Default to `assignee = currentUser()` when no assignee specified and context is personal. Include `labels = mlp` by default for epics or when user mentions "mlp".

**JQL translation:**

| Intent | JQL |
|---|---|
| my tickets | `assignee = currentUser()` |
| open / not done | `status not in (Done, Closed, Resolved)` |
| current sprint | `sprint in openSprints()` |
| blocked | `status = Blocked` |
| in review | `status = "In Review"` |
| to do | `status = "To Do"` |
| project X | `project = X` |
| about X | `text ~ "X"` |
| epics | `issuetype = Epic AND labels = mlp` |
| bugs | `issuetype = Bug` |
| backlog | `sprint not in openSprints() AND status not in (Done, Closed, Resolved)` |
| high priority | `priority in (High, Highest)` |
| recently updated | `updated >= -1w` |
| today | `updated >= -1d` |
| done | `status in (Done, Closed, Resolved)` |

Combine with `AND`. Examples:

| User says | JQL |
|---|---|
| "my open sprint tickets" | `assignee = currentUser() AND sprint in openSprints() AND status not in (Done, Closed, Resolved)` |
| "blocked tickets in AICPE" | `project = AICPE AND status = Blocked` |

**Search output:**
```
KEY       TYPE   STATUS       SUMMARY
──────────────────────────────────────────────────────────────────
AICPE-107    Task   In Progress  Add XGBoost model for SBV CBB
AICPE-91     Bug    To Do        Handle expired refresh tokens
```

SUMMARY truncated at 60 chars. No results → `No tickets found.`

## B. Attach a Jira ticket to current work

Resolve a Jira ticket for the current work and return `JIRA_KEY` for branch names, commits, and PRs. After resolving (B1 or B2), always run B3 to make the ticket ready for work — transition, sprint, description check, story points — regardless of whether the ticket was found or just created.

### B1. Search for an existing ticket

Search in priority order:
1. Current sprint: `assignee = currentUser() AND sprint in openSprints() AND status not in (Done, Closed, Resolved)`
2. If none, all open: `assignee = currentUser() AND status not in (Done, Closed, Resolved)`

Present results using the `ask_user_question` tool — one option per ticket, each with key, summary, and status:
```
ask_user_question(questions=[{
  question: "Found these tickets — which is the right one?",
  header: "Jira ticket",
  options: [
    { label: "AICPE-3621", description: "Add GitHub repos for aisafety foundation model inference [In Progress]" },
    { label: "AICPE-3589", description: "Some other task [To Do]" },
    { label: "None — create new", description: "No suitable ticket found" }
  ]
}])
```

**REQUIRED: Use `ask_user_question` for explicit confirmation. Never silently pick a ticket.**

### B2. Create a ticket (if none exists)

Load the `jira-authoring` skill (`read skill://jira-authoring`) and follow it to create the ticket under an existing epic. It handles ticket type selection, description templates, AICPE required fields, and epic parent assignment. Do not create epics — that's a human decision.

### B3. Ensure the ticket is ready for work

Run this for **every** ticket that current work will trace to — whether it was *found* in B1 or *created* in B2. Do all four checks in order. Skip a check only when it's already satisfied (already In Progress, already in the active sprint, real description, points set). Never skip silently when a check *fails* — fix it or surface it.

#### a. Transition to In Progress

```bash
acli jira workitem transition --key "<JIRA_KEY>" --status "In Progress" --yes
```
If `acli` fails with "invalid transition", load `skill://jira/FALLBACK.md` for REST transition ID discovery + execution. Already `In Progress` or further along (e.g. `In Review`) → skip.

#### b. Add to current sprint

`acli` has no direct command. Load `skill://jira/FALLBACK.md` for the REST sprint-add procedure (uses `acli` for board/sprint ID discovery, REST for the sprint assignment). Already in an active sprint → skip. No active sprint → skip and note to user (do not create a sprint).

#### c. Verify the description is real (not a placeholder)

AICPE requires a description on all issue types, so tickets always have *something* — but it's often an unfilled template. Fetch and inspect it:

```bash
acli jira workitem view <KEY> --fields "key,summary,description" --json
```

Treat the description as a **placeholder** if any of these are true:
- Still contains template markers: `<...>`, `<one sentence...>`, `<criterion 1>`, `<step 1>`, etc.
- Contains literal `TODO`, `TBD`, `placeholder`, `FIXME`, `???`
- A required section (`## What` / `## Why` / `## Acceptance Criteria` for Story/Task; `## Bug Description` / `## Reproduction Steps` for Bug) is empty or only the heading
- Trivially short relative to the summary (restates it with no added detail)

Real description → skip. Placeholder → **rewrite it** from the available context (the summary, the epic's goal, the task the user described, and — mid-PR — the diff/commits) using the templates in `skill://jira-authoring`, then update:

```bash
acli jira workitem edit --key "<JIRA_KEY>" --description "<real description>" --yes
```

If `acli` is unavailable, load `skill://jira/FALLBACK.md` for the REST `PUT /rest/api/2/issue/<KEY>` fallback. Note the rewrite to the user (one line). Do not block on a prompt — fix it and report.

#### d. Ensure story points are set

`workitem view` does not display story points; check via REST (`customfield_10004` = Story Points on k2labs Jira):

```bash
curl -s "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>?fields=customfield_10004" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}"
```

Points set (non-null, > 0) → skip. Missing or `0`/`null` → **ask the user** with `ask_user_question`, suggesting Fibonacci values sized to the work. Put your recommended value first, marked `(Recommended)`. Base the recommendation on scope (touch → 1, small → 2, normal → 3, medium → 5, large → 8, very large → 13):

```
ask_user_question(questions=[{
  question: "AICPE-107 has no story points. How many should we set?",
  header: "Story points",
  options: [
    { label: "3 (Recommended)", description: "Normal task — a few files, straightforward change" },
    { label: "2", description: "Small change — one or two files, low risk" },
    { label: "5", description: "Medium — multiple files, some design decisions" },
    { label: "8", description: "Large — cross-cutting, needs careful testing" }
  ]
}])
```

Adjust the four options to fit the actual work (Fibonacci: 1, 2, 3, 5, 8, 13). Then set them:

```bash
curl -s -X PUT "https://k2labs.atlassian.net/rest/api/2/issue/<KEY>" \
  -u "${JIRA_EMAIL}:${ATLASSIAN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"customfield_10004": <N>}}'
```

On create you can instead pass points via `--from-json` with `additionalAttributes` (`{ "additionalAttributes": { "customfield_10004": 3 }, ... }`). In a non-interactive run where you cannot ask, infer a value from scope, set it, and note it.

### B4. Return JIRA_KEY

Return `JIRA_KEY` (e.g., `AICPE-107`) to the calling workflow, with a one-line status of the B3 checks — e.g. `AICPE-107: In Progress, in Sprint 42, description updated, points=3`.

## C. Link a PR to its Jira ticket

When a PR is created for a ticket, post a comment on the Jira with the PR title and link so the ticket reflects the review. Run this immediately after `gh pr create` returns the PR URL.

```bash
acli jira workitem comment create --key "<JIRA_KEY>" --body "PR: <PR_TITLE>
<PR_URL>"
```

If `acli` is unavailable, load `skill://jira/FALLBACK.md` and use the REST comment endpoint (`POST /rest/api/2/issue/<KEY>/comment` with `{"body": "..."}`).

- `JIRA_KEY` = the key extracted from the branch name (`[A-Z]+-\d+`), the same one the PR title's scope uses.
- `PR_TITLE` = the exact title passed to `gh pr create` (e.g. `feat(AICPE-107): add xgboost model for sbv cbb`).
- `PR_URL` = the URL `gh pr create` prints.
- One comment per PR. If the ticket already has a comment containing this PR URL, skip — don't duplicate on re-runs.
- Do not transition the ticket here; keep it In Progress while review is open unless told otherwise.
