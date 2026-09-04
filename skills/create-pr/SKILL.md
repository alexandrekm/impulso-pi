---
name: create-pr
description: Troubleshooting companion for the /create-pr prompt template — pre-commit failures, non-conforming commits, diverged push. Not a workflow skill.
disable-model-invocation: true
---

This skill is only a container for `TROUBLESHOOTING.md`, the failure-mode
companion of the **`/create-pr` prompt template** (user-invocation command,
`prompts/create-pr.md`). The workflow itself is the prompt template — invoke
it with `/create-pr`, not `/skill:create-pr`. Read
`skills/create-pr/TROUBLESHOOTING.md` (path relative to the pi config dir)
only when a step in that flow fails.
