# impulso-pi

Personal [pi](https://pi.dev) customizations: extensions, skills, and setup scripts.

## Install

```bash
./install.sh          # repo -> ~/.pi/agent (install pi-footer, sync files)
./install.sh status    # show per-file sync state, no changes made
./install.sh pull      # ~/.pi/agent -> repo (promote local edits upstream)
```

Override the target with `PI_AGENT_DIR=/path ./install.sh ...`.

Then reload pi (`/reload`) or start a new session.

### Local edits are never clobbered

You will often tweak things live in `~/.pi/agent/` (e.g. `/footer`'s config UI
rewrites `pi-footer.json` directly). `install.sh` tracks a hash of every file
as of its last sync in `~/.pi/agent/.impulso-pi-manifest.tsv` and only
fast-forwards a file from the repo if the local copy is **unchanged** since
that sync:

| State | `install` behavior |
| --- | --- |
| in sync | no-op |
| repo changed, local untouched | copies repo → local |
| local changed, repo untouched | **skipped** — run `./install.sh pull` to promote the local edit into the repo instead |
| both changed independently | **conflict**, flagged, nothing touched — resolve manually |

Run `./install.sh status` any time to see the state of every tracked file
before installing or pulling.

## Contents

### `extensions/footer/` — powerline-style status footer

Built on top of [`pi-footer`](https://github.com/wobondar/pi-footer) (installed
automatically by `install.sh` via `pi install npm:pi-footer`), which renders the
footer from `~/.pi/agent/extensions/pi-footer.json`.

- **`footer-widgets.ts`** — a pi extension publishing values pi-footer's built-in
  widgets can't produce, via `pi.events.emit("pi-footer:update-widget", ...)`:
  - `toks` — average output tok/s (output tokens ÷ wall-clock span from the
    first to the last completed assistant message)
  - `cost` — session cost to 2 decimal places (e.g. `$6.12`)
  - `ctxpct` — context window usage as a whole-number percent (e.g. `25%`)
  - `pr` — current branch's GitHub PR status via `gh pr view` (e.g. `#1234 open`),
    empty when there's no PR for the branch (requires `gh` installed + authenticated)
- **`pi-footer.json`** — the footer layout: git branch and PR status as
  auto-hiding flat segments on either end, a powerline block in the middle
  (model + thinking level, context bar, cache hit rate, tokens, tok/s, cost).

To tweak colors/layout further, run `/footer` inside pi for the interactive
config UI (writes back to `~/.pi/agent/extensions/pi-footer.json`).

## Development

```bash
npm install
npm run lint          # eslint on extensions/
npm run typecheck     # tsc --noEmit on extensions/
npm run format        # prettier --write
npm run format:check  # prettier --check
npm run check:json    # validate every extensions/**/*.json parses
```

CI (`.github/workflows/ci.yml`) runs all of the above plus `gitleaks`,
`shellcheck` on `install.sh`, and an `install.sh` smoke test (idempotency +
file-landing check against a stubbed `pi` CLI) on every push/PR.

A PR review bot (`.github/workflows/pr-agent.yml`, config in
`.pr_agent.toml`) automatically reviews PRs for functional issues specific to
this repo (extension shape, pi-footer config correctness, install.sh sync
safety). It runs `pr-agent` via `pip` (not the Docker-based GitHub Action,
since the `impulso-pi-runners` self-hosted runner has no Docker daemon)
against a LiteLLM endpoint. It needs a `LITELLM_API_KEY` secret set on the
repo to run.

## Updating

- Made an intentional upstream change in this repo? Commit it, then run
  `./install.sh` on each machine to fast-forward.
- Tweaked something live in `~/.pi/agent/` (e.g. via `/footer`) and want to
  keep it? Run `./install.sh pull`, review the diff, and commit.
