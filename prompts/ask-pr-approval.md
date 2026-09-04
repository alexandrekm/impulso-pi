---
description: Post the current PR to the team Slack channel asking for review/approval, via slackcli
---

# Ask PR approval

Post a review request for the current branch's PR to the team Slack channel using the `slack` skill's CLI (`slackcli`).

Announce at start: "I'm using the /ask-pr-approval command to post your PR for review."

## 1. Resolve the channel

```bash
echo "${SLACK_PR_CHANNEL:?unset}"
```

The channel name comes from the `SLACK_PR_CHANNEL` env var (set in the user's local shell config — never in git). If unset or empty, ask the user for the channel name for this run and remind them to export `SLACK_PR_CHANNEL` locally to make it permanent.

Resolve the channel ID live (never hardcode it):

```bash
slackcli search channels "<channel>" --json | jq -r '.channels[] | select(.name=="<channel>") | .id'
```

## 2. Find the PR

```bash
gh pr view --json url,title,number,headRefName,baseRefName,additions,deletions,changedFiles
```

No PR for the current branch → stop and say so (offer /create-pr).

## 3. Compose and confirm

Draft a short message:

```
:eyes: PR review requested: <title>
<url>
<one-line summary of what changed — from the diff, not just the title>
```

**Show the exact message and target channel to the user and wait for confirmation before sending.** Adjust tone/content if they ask.

## 4. Send

```bash
slackcli messages send --recipient-id=<C-ID> --message="<confirmed text>" --json
```

Report the posted permalink (or channel + ts). If `slackcli` fails with an auth error, follow the auth-expired recovery in the slack skill (`skill://slack/SETUP.md`) — do not retry blindly.
