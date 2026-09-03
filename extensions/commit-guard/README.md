# commit-guard

A **work-profile** pi extension that enforces commitlint on every `git commit`
the agent makes — so a non-conventional commit message is blocked *before* the
commit is created, instead of failing CI and forcing a history rewrite.

## Why

The `commit` skill teaches the agent to write commitlint-compliant messages,
but it's guidance-only and depends on the target repo having a `commit-msg`
hook. In practice the agent often writes a message that doesn't match the repo's
`commitlint.config.js`, CI fails, and you have to amend + force-push to fix it.

commit-guard closes that gap the same way `command-guard` does: pi's `bash`
tool goes through a `tool_call` hook, so **every** `git commit` the agent runs
is intercepted. A non-compliant message is blocked with the exact failing rule,
and the model retries with a fixed message — no CI round-trip.

## What it enforces

1. **`--no-verify` / `-n` is blocked.** Those flags skip the repo's own
   pre-commit / commit-msg hooks. Drop the flag and let the hooks run; if a
   hook fails, fix the cause rather than bypassing it.
2. **The commit message is validated**, in this order:
   - If the repo has a **runnable** commitlint (`node_modules/.bin/commitlint`),
     it runs on the message via stdin — exactly what CI does — and a non-zero
     exit blocks the commit, surfacing commitlint's report. This keeps local
     validation identical to CI.
   - Otherwise, the **built-in Motive rules** in `rules.ts` apply (the policy
     from `skills/commit/SKILL.md` §0): `type` ∈
     `{feat,fix,docs,style,refactor,perf,test,revert,build,ci}` (never
     `chore`), scope is a Jira key `^[A-Z][A-Z0-9]*-\d+$`, subject uses only
     letters/numbers/spaces and `- _ / ( ) . ,` (no colons, backticks,
     brackets, or `key: value`), no trailing `.`, ≤200 chars per line, and
     `initial plan` is ignored.
3. **`--amend`** with a `-m` message is validated like any other commit.
   `--amend` without `-m` (reuses the prior message) is allowed through —
   there's no new message to lint. Force-push is **not** blocked: a true
   pre-tool "warn" isn't expressible in the `tool_call` hook (it can only
   allow or block), and blocking it would break legitimate rebases.

## How it parses

`parse.ts` reuses `command-guard`'s shell engine to peel wrappers
(`cd … &&`, `bash -c`, `timeout`, `env`, `xargs`, …) and split `&&`/`;`/`|`
chains, so `cd repo && git commit -m "…"` is caught just like a bare
`git commit`. It then tokenizes the `git commit` segment (handling single/double
quotes and backslash escapes) and collects the message from `-m` / `--message`
/ `-F` (multiple `-m` become paragraphs joined by a blank line, matching git).

**Known limitation:** combined short flags like `-am "msg"` are not split into
`-a` + `-m`; the agent almost always uses a plain `git commit -m "…"`, and
`--no-verify`'s short form `-n` is recognized.

## Install / profile placement

Declared in `profiles.jsonc` and synced by `install.sh` as a directory
extension (`extensions/commit-guard/index.ts`). **Tagged `work` only** — it
lands on the work profile, where the Motive commitlint rules apply. Not on
personal / `--base`.

Toggled in `/settings` → Tools & Safety → **Commit guard** (a `local` feature;
the factory guards on `isFeatureEnabled("commit-guard")`, so `/reload` applies
after toggling).

## Files

- `commit-guard.ts` — the factory (installed as `index.ts`); the `tool_call`
  hook + commitlint runner.
- `parse.ts` — `git commit` extraction + shell tokenizer.
- `rules.ts` — built-in Motive commitlint rules + `validateMessage`.
- `commit-guard.test.ts` — `node --test` unit tests.

## Observability

Blocks are visible in the `pi-omp-stats` dashboard's **Guards** panel: pi
persists every `tool_call` block as an error tool result whose first text
block is the `[commit-guard]` reason, and `pi-omp-stats` parses those into
`guard_events` rows (guard, kind, model, blocked command, reason) served via
`/api/stats/guards*` — no upstream pi change and no explicit emit needed
here.
