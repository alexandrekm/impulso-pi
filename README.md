# impulso-pi

Personal [pi](https://pi.dev) customizations: extensions, skills, and setup scripts.

## Install

This repo layers on top of [pi-profiles](https://github.com/chaychoong/pi-profiles)
(`ppi`), which manages independent pi profile directories at
`~/.pi/profiles/<name>/`. Repo-root [`profiles.jsonc`](profiles.jsonc) (JSONC) tags
each extension / skill / npm package; a resource lands on a profile if it has
the `core` tag or any tag the profile declares. `core` is implicit on every
profile. See [investigation/PROFILES.md](investigation/PROFILES.md) for the full
design.

```bash
npm install -g pi-profiles   # provides `ppi` (auto-installed by ./install.sh if missing)
./install.sh                  # interactive: prompt for a target
./install.sh work             # sync one profile
./install.sh --all            # sync every profile in profiles.jsonc
./install.sh --base           # escape hatch: sync raw ~/.pi/agent (all resources)
./install.sh -y --base        # non-interactive: install all missing deps (CI)
./install.sh status [target]  # show per-file sync state, no changes made
./install.sh pull   [target]  # promote local edits upstream
```

`<target>` is a profile name (`work` / `personal`), `--all`, or
`--base`. For profile targets, `install` first reviews dependencies — `ppi` if
missing, and the target's `npm:` packages — and asks which to install
(default: all; hide up-to-date packages, flag newer versions as updates).
`-y` / `--yes` is non-interactive: install all missing, no version checks.
Missing profiles are created via `ppi create` on first sync.

Profiles: `work` and `personal`.

Override the pi root with `PPI_PI_ROOT=/path` (profiles dir) or the raw agent
dir with `PI_AGENT_DIR=/path` (used by `--base`).

Then launch a profile with `ppi use <name>` (or `ppi` for the default).

### Local edits are never clobbered

You will often tweak things live in a profile dir (e.g. `/footer`'s config UI
rewrites `pi-footer.json` directly). The installer tracks a hash of every file
as of its last sync in `<dir>/.impulso-pi-manifest.tsv` and only fast-forwards
a file from the repo if the local copy is **unchanged** since that sync:

| State | `install` behavior |
| --- | --- |
| in sync | no-op |
| repo changed, local untouched | copies repo → local |
| local changed, repo untouched | **skipped** — run `./install.sh pull <target>` to promote the local edit into the repo instead |
| both changed independently | **conflict**, flagged, nothing touched — resolve manually |

Run `./install.sh status <target>` any time to see the state of every tracked
file before installing or pulling.

## Contents

### `extensions/command-guard/` — default-allow bash gate

In-repo replacement for `@gotgenes/pi-permission-system`. Glob `ask`/`deny`
lists, wrapper peeling (`timeout`, `xargs`, `env`, `bash -c`), and a hardcoded
`.env` deny. Work also asks on mutating Anyscale and AWS CLI commands.
`./install.sh` uninstalls the old npm package so both gates cannot run at once.

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
npm test              # command-guard engine unit tests
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
