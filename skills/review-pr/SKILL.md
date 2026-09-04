---
name: review-pr
description: Troubleshooting companion for the /review-pr prompt template — error handling and common mistakes. Not a workflow skill.
disable-model-invocation: true
---

This skill is only a container for `TROUBLESHOOTING.md`, the failure-mode
companion of the **`/review-pr` prompt template** (user-invocation command,
`prompts/review-pr.md`). The workflow itself is the prompt template — invoke
it with `/review-pr <number-or-url>`, not `/skill:review-pr`. Read
`skills/review-pr/TROUBLESHOOTING.md` (path relative to the pi config dir)
only when a step in that flow fails or you want the common-mistakes checklist.
