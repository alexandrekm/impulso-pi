---
name: slack
description: Read, search, and send Slack messages via the slackcli CLI (browser-session auth, no Slack app needed).
author: alexandre.mendonca
tags: [slack, chat, messaging, slackcli]
---

# Slack

Read channels/DMs/threads, search the workspace, check unreads, send/reply/react — via the `slackcli` CLI, authenticated as **your own user** with browser-session tokens (no Slack app, no admin approval). Two workspaces are enrolled (an org grid + a classic team); see `slackcli auth list` for names/IDs.

**Requires `slackcli`** installed and authenticated. Verify before first use:

```bash
slackcli auth list   # must list the workspace(s), Auth: 🌐 Browser
```

If it fails or shows no workspaces, auth has expired (SSO session rotation). Re-auth is one command, run **by the user** (it opens a browser for SSO):

```bash
SLACKCLI_BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" slackcli auth login-auto
```

Brave is required for re-auth (other browsers on this machine don't work with `login-auto`). See `skill://slack/SETUP.md` for reinstall instructions.

Announce at start: "I'm using the slack skill to …"

## Rules

1. **Ask before writing.** Reads are cheap and reversible; posts are not. ALWAYS confirm with the user before `messages send`, `messages edit`, `messages draft`, or reacting — show the exact channel and text first. Exception: the user explicitly asked you to send that specific message.
2. **You ARE the user.** Every action is attributed to the user's personal account (and can create drafts, see private channels they're in). Act with their judgment, not a bot's.
3. **`--json` for anything you'll parse.** Human output is for humans; pipe JSON to `jq`.
4. **Permalinks are first-class.** Anywhere a channel ID or timestamp is wanted, paste a Slack permalink instead. `conversations read --permalink=<link>` reads that message's thread; `messages send --permalink=<link>` replies in-thread.
5. **Multi-workspace:** one workspace is the default (see `auth list`). Add `--workspace=<id-or-name>` for any other.

## Quick command reference

| Operation | Command |
|-----------|---------|
| What did I miss | `slackcli conversations unread --json` |
| Read channel | `slackcli conversations read <C-ID\|permalink> --limit=50 --json` |
| Read thread | `slackcli conversations read --permalink="<msg-link>" --json` |
| Search messages | `slackcli search messages "<query>" --in=<channel> --from=<user> --limit=20 --json` |
| Find channel | `slackcli search channels "<name>"` |
| Find person | `slackcli search people "<name-or-email>"` |
| Send message | `slackcli messages send --recipient-id=<C-or-U-ID> --message="…" --json` |
| Reply in thread | `slackcli messages send --permalink="<msg-link>" --message="…"` |
| React | `slackcli messages react --permalink="<msg-link>" --emoji=+1` |
| Edit | `slackcli messages edit --channel-id=<C-ID> --timestamp=<ts> --message="…"` |
| Draft (no send) | `slackcli messages draft --recipient-id=<ID> --message="…"` |
| Upload file | `slackcli messages send --recipient-id=<ID> --file=./path --message="…"` |
| Read canvas | `slackcli canvas read <F-ID>` (renders to Markdown) |
| File info/download | `slackcli files info <F-ID>` / `slackcli files download <F-ID> --output ./f` |
| DM a user | `messages send --recipient-id=<U-ID> …` (user ID = DM to that user) |

`slackcli <group> --help` is authoritative for flags. Notes:

- **Channel IDs** start with `C` (public), `G` (private), `D` (DM); user IDs with `U`. Resolve names via `search channels` / `search people` first.
- Large `--limit` values are rate-limited (the client throttles to avoid Slack's anomaly detection) — prefer small pages and `--permalink` targeting.
- Timestamps in output (`ts`) plus channel ID identify any message for edit/react.

- **Never hardcode workspace/channel/user IDs in the repo** — they are environment-specific. Resolve them live: `slackcli auth list` (workspaces), `slackcli search channels "<name>"`, `slackcli search people "<name>"`. If a task needs a stable channel reference, ask the user for a permalink or channel name, not an ID.
