---
name: jira-authoring
description: Create Jira tickets (stories, tasks, bugs) under existing epics with AICPE templates.
author: alexandre.mendonca
tags: [jira, acli, ticket, authoring, aicpe]
---

# Jira Ticket Authoring

Create well-structured Jira tickets under existing epics. Every piece of work must trace to a Jira ticket, and every ticket must have an epic parent. Epics already exist — this skill never creates them.

**Requires `acli`** installed and authenticated. If unavailable, REST fallbacks are in `skill://jira/FALLBACK.md`.

If something goes wrong, check `skill://jira-authoring/TROUBLESHOOTING.md` for common mistakes.

Announce at start: "I'm using the jira-authoring skill to create the Jira ticket."

## AICPE required fields

| Field | Required on |
|-------|-------------|
| Summary | All |
| Description | All (AICPE enforces this) |
| Project | All |
| Reporter | Task, Bug, Sub-task (auto-set to current user) |

Story has the fewest required fields — no reporter required. Use Story when possible for smoothest creation.

## Ticket description templates

### Story / Task

```
## What
<one sentence: what needs to be done>

## Why
<one sentence: why it matters / which epic it supports>

## Acceptance Criteria
- [ ] <criterion 1>
- [ ] <criterion 2>

## Technical Notes
<any implementation hints, file paths, API references>
```

### Bug

```
## Bug Description
<what's broken>

## Reproduction Steps
1. <step 1>
2. <step 2>

## Expected Behavior
<what should happen>

## Actual Behavior
<what actually happens>

## Impact
<who/what is affected>
```

## Process

### 1. Determine ticket type

| Situation | Type | Why |
|-----------|------|-----|
| User-facing feature | Story | Fewest required fields |
| Engineering work | Task | Needs reporter (auto-set) |
| Something broken | Bug | Needs reproduction steps |

### 2. Find the parent epic

Epics already exist — search for one to attach the ticket to:

```bash
acli jira workitem search --jql "project = AICPE AND type = Epic AND status != Done" --json --limit 20
```

Present epics using the `ask_user_question` tool, let user pick → `EPIC_KEY`.

If no suitable epic exists, ask the user which epic to use. Do not create epics — that's a human decision.

### 3. Create the ticket under the epic

#### Story / Task

```bash
acli jira workitem create \
  --summary "<summary>" \
  --description "<description from template>" \
  --project "AICPE" \
  --type "Story" \
  --assignee "@me" \
  --parent "<EPIC_KEY>" \
  --label "mlp"
```

Use `Task` instead of `Story` if it's engineering work.

#### Bug

```bash
acli jira workitem create \
  --summary "<summary>" \
  --description "<bug description from template>" \
  --project "AICPE" \
  --type "Bug" \
  --assignee "@me" \
  --parent "<EPIC_KEY>" \
  --label "mlp"
```

### 4. Transition + add to sprint

```bash
acli jira workitem transition --key "<JIRA_KEY>" --status "In Progress" --yes
```

For sprint assignment, load `skill://jira` (section B3) — it has the REST sprint-add procedure.

### 5. Report

```
Ticket created: AICPE-XXX
  Type: Story
  Epic: AICPE-YYY — "<epic name>"
  Sprint: AICPE Sprint N
  URL: https://k2labs.atlassian.net/browse/AICPE-XXX
```
