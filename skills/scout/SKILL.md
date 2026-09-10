---
name: scout
description: Read-only scout subagent delegation — when the user says "scout", delegate reconnaissance to the scout subagent instead of doing it yourself.
author: alexandre.mendonca
tags: [subagents, scout, recon, read-only]
---

# Scout subagent

When the user mentions **scout**, the intended path is to delegate
read-only reconnaissance to the `scout` **subagent** (a pi-subagents role,
not a file-finder), then let the parent synthesize the result.

This skill is only a pointer: the authoritative contract is the canonical
agent definition at `agents/scout.md` (synced into every managed profile as
`<configDir>/agents/scout.md`). Read that file for the full rules before
launching.

## When to use

There is no judgment call — the delegation rule is mechanical:

- Any question that spans **more than one repo/submodule** → always scout,
  regardless of how cheap it looks.
- Recon expected to exceed **~3 tool calls** → scout.
- **Mid-task:** if inline reconnaissance passes either threshold, stop and
  re-delegate the remaining investigation to scout. Never let incremental
  scope creep keep a growing task inline.
- Still inline: single-file or single-repo lookups that fit within ~3 tool
  calls, or files the parent already holds anchors for.

Of course, the user saying **scout** always means scout, regardless of the
above.

## How to invoke

Launch exactly one scout via the subagent tool with `agent: "scout"` (or
`/run scout <task>`). It runs **fresh-context, asynchronous, and read-only**:

- **Tools:** `read`, `grep`, `find`, `ls`, `zvec_search`, `zvec_status`, and
  `contact_supervisor` (the latter only for necessary clarification, a
  material blocker, or a concise material progress update).
- **Cannot:** `bash`, `write`, `edit`, `subagent`, or any workspace changes.
- **Depth:** `maxSubagentDepth: 1` — it cannot spawn children.
- **Context:** fresh (no parent memory), but inherits the project context.

Give it a narrow, verifiable question with explicit "do not change anything"
scope. It returns a compact evidence-based handoff (verified findings, paths
and symbols, risks, next steps); the parent decides and performs any change.

## First-use check

If the scout has never been validated on this machine, run one bounded smoke
task first and confirm `git status --short` is unchanged afterwards before
trusting it for real work.