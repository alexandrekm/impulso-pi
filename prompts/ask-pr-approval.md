---
description: Post the current PR to the team Slack channel asking for review/approval, via slackcli
argument-hint: "[priority]"
---

# Ask PR approval

Post an approval request for the current branch's PR to the team Slack channel using the `slack` skill's CLI (`slackcli`).

Announce at start: "I'm using the /ask-pr-approval command to post your PR for approval."

## 1. Resolve the priority

The optional `$1` argument is the urgency: `low` / `medium` / `high` / `critical` (case-insensitive). Missing or empty → default `medium`. Map to emoji:

| Priority | Emoji |
|----------|-------|
| Low      | 🟢 |
| Medium   | 🟡 |
| High     | 🟠 |
| Critical | 🔴 |

Unknown value → ask the user to pick one of the four via `ask_user_question`.

## 2. Resolve the channel

```bash
echo "${SLACK_PR_CHANNEL:?unset}"
```

The channel name comes from the `SLACK_PR_CHANNEL` env var (set in the user's local shell config — never in git). If unset or empty, ask the user for the channel name for this run and remind them to export `SLACK_PR_CHANNEL` locally to make it permanent.

Resolve the channel ID live (never hardcode it):

```bash
slackcli search channels "<channel>" --json | jq -r '.channels[] | select(.name=="<channel>") | .id'
```

## 3. Find the PR

```bash
gh pr view --json url,title,number,headRefName,baseRefName,additions,deletions,changedFiles
```

No PR for the current branch → stop and say so (offer /create-pr).

## 4. Compose and confirm

The message format is FIXED — a bold header line, then three labeled fields (*What:*, *Scope:*, *Diff:*), nothing else:

```
{EMOJI} *Priority: {PRIORITY}* — *<{PR_URL}|{repo}#{number}> approval requested*
*What:* {one sentence — what the PR changes}
*Scope:* {one sentence — the key behavioral effect / blast radius}
*Diff:* +{additions} / −{deletions} across {changedFiles} files
```

Rules:

- `{repo}` is the repo NAME only (e.g. `mlplatform-test-inference`), resolved from `gh repo view --json name` — the link text `repo#N` must make it obvious which repo and PR this maps to.
- *What:* and *Scope:* are one sentence each, derived from the actual diff (`gh pr diff`), not just the PR title. Together they cover what changed and the key behavioral effect (gates added/removed, scope, migration).
- *Diff:* comes straight from `gh pr view` additions/deletions/changedFiles — never hand-counted.
- Slack hyperlink syntax: `<URL|{repo}#{number}>` — bolded together with the priority, before " approval requested".
- No Jira line, no extra links, no bullet lists, no trailing commentary.

**Confirm via the `ask_user_question` tool before sending** — never send without it. Show the exact message text and target channel in the question, with options "Confirm" / "Deny" / "Another channel". On "Another channel", ask which channel (custom-answer row), re-resolve its ID per §2, and confirm again the same way. On "Deny", stop without posting. Only proceed to §5 after an explicit "Confirm".

## 5. Send

```bash
slackcli messages send --recipient-id=<C-ID> --message="<confirmed text>" --json
```

Report the posted permalink (or channel + ts). If `slackcli` fails with an auth error, follow the auth-expired recovery in the slack skill (`skill://slack/SETUP.md`) — do not retry blindly.
