# impulso-pi

Personal [pi](https://pi.dev) customizations: extensions, skills, and setup scripts.

## Install

```bash
./install.sh
```

Copies everything into `~/.pi/agent/` (override with `PI_AGENT_DIR=/path ./install.sh`)
and installs required third-party pi packages. Safe to re-run after `git pull`.

Then reload pi (`/reload`) or start a new session.

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

## Updating

After changing an extension in `~/.pi/agent/extensions/` during a pi session,
copy it back into this repo (`extensions/<feature>/`) and commit, or re-run
`install.sh` to push repo changes back out to `~/.pi/agent/`.
