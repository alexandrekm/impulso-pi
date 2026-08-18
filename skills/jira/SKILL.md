---
name: jira
description: Resolve, find, create, and manage Jira tickets via acli.
author: alexandre.mendonca
tags: [jira, acli, ticket, workflow]
---

# Jira

Resolve a Jira ticket for current work, search tickets, create tickets, transition, and manage sprints — via the `acli` CLI. Every piece of work must trace to a Jira ticket. No JIRA_KEY = no branch = no PR.

**Requires `acli`** installed and authenticated (`acli auth login`).

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

Resolve a Jira ticket for the current work and return `JIRA_KEY` for branch names, commits, and PRs.

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

### B3. Transition + add to sprint

**Transition to In Progress:**
```bash
acli jira workitem transition --key "<JIRA_KEY>" --status "In Progress" --yes
```
If `acli` fails with "invalid transition", load `skill://jira/FALLBACK.md` for REST transition ID discovery + execution.

**Add to current sprint** — `acli` has no direct command. Load `skill://jira/FALLBACK.md` for the REST sprint-add procedure (uses `acli` for board/sprint ID discovery, REST for the sprint assignment).

No active sprint → skip silently, note to user.

### B4. Return JIRA_KEY

Return `JIRA_KEY` (e.g., `AICPE-107`) to the calling workflow.

### Story points

`acli` has no `--story-points` flag. On create, use `--from-json` with `additionalAttributes`:
```json
{ "additionalAttributes": { "customfield_10004": 3 }, "projectKey": "AICPE", "summary": "...", "type": "Story" }
```
To set story points after creation, load `skill://jira/FALLBACK.md` for the REST procedure (`PUT /rest/api/2/issue/<KEY>` with `customfield_10004`).
