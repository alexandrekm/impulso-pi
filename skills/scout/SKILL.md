---
name: scout
description: Read-only scout subagent delegation — when the user says "scout", delegate reconnaissance to the scout subagent instead of doing it yourself.
disable-model-invocation: true
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

- The user says "scout", "use the scout", "scout this repo", or asks for a
  read-only investigation of a codebase, dependency, or config.
- A task needs evidence-based reconnaissance that the parent shouldn't do
  inline (large tree, many files, or a side analysis that would derail the
  main thread).

## How to invoke

Launch exactly one scout via the subagent tool with `agent: "scout"` (or
`/run scout <task>`). It runs **fresh-context, asynchronous, and read-only**:

- **Tools:** `read`, `grep`, `find`, `ls`, and `contact_supervisor` (the
  latter only for necessary clarification, a material blocker, or a concise
  material progress update).
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