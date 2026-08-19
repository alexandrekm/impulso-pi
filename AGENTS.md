# impulso-pi

Personal [pi](https://pi.dev) customizations: extensions, skills, and setup
scripts. Layered on top of [pi-profiles](https://github.com/chaychoong/pi-profiles)
(`ppi`) so one machine can run several independent pi configs.

**Full design doc:** [`investigation/PROFILES.md`](investigation/PROFILES.md).
This file is the short version for agents working in this repo.

## Reference sources (`reference-impl/`)

The source code of **pi** and **omp** (oh-my-pi) is checked out locally under
[`reference-impl/`](reference-impl/) (gitignored), inside this repo so
everything stays in one place:

- **`reference-impl/pi/`** — clone of the [pi](https://pi.dev) agent harness
  source (`@earendil-works/pi-coding-agent` and friends, under
  `pi/packages/`). Read-only reference: consult it to understand pi's extension
  API, tool system, TUI, etc. when developing extensions or skills.
- **`reference-impl/oh-my-pi/`** (a.k.a. **omp**) — a fork of pi
  (`@oh-my-pi/pi-coding-agent`, see https://omp.sh) by can1357. Substantially
  extended/different codebase: Rust core in `oh-my-pi/crates/`, TypeScript
  packages in `oh-my-pi/packages/`, docs in `oh-my-pi/docs/`.

Both are **read-only references** — don't commit changes there as part of
normal work here; treat them purely as a source to search, read, and adapt
from.

### If `reference-impl/` is missing

The `reference-impl/` directory is gitignored, so it won't be present on a
fresh clone. If it (or one of its subdirs) is missing when you need to consult
the source, **ask the user whether they want you to clone it** before doing
so, then:

```bash
mkdir -p reference-impl
git clone https://github.com/earendil-works/pi-coding-agent.git reference-impl/pi
git clone https://github.com/can1357/oh-my-pi.git reference-impl/oh-my-pi
```

(Confirm the correct upstream URLs with the user before cloning — these are
the canonical repos but may have moved.)

## How to install / sync resources

Resources (extensions, skills, npm packages) are declared in
[`profiles.jsonc`](profiles.jsonc) and synced into target dirs by
[`./install.sh`](install.sh) (a shim over `scripts/install.mjs`).

```bash
./install.sh                       # interactive: prompt for a target
./install.sh <profile>             # sync one profile, e.g. work
./install.sh --all                 # sync every profile in profiles.jsonc
./install.sh --base                # escape hatch: sync raw ~/.pi/agent (ALL resources)
./install.sh -y/--yes [target]    # non-interactive: install all missing deps (CI)
./install.sh status [target]       # per-file sync state, no changes
./install.sh pull   [target]       # promote local edits back into the repo
```

`<target>` is a profile name (`work` / `personal`), `--all`,
or `--base`. Profiles live at `~/.pi/profiles/<name>/`; the raw global agent
dir is `~/.pi/agent/` (the `--base` target).

## Tagging model (the important part)

A resource lands on a profile when:

```
resource is on P  ⟺  "core" ∈ resource.tags  OR  resource.tags ∩ P.tags ≠ ∅
```

- **`core`** is implicit on every profile (never list it in a profile's
  `tags`) and also lands on `--base`. Use `core` for baseline resources that
  every profile needs.
- Any other tag (`work`, `personal`) lands the resource only on the profile
  that declares that tag.
- **`base`** is a pseudo-tag no profile declares: a resource tagged only
  `base` lands **only** on the `--base` target (`~/.pi/agent`). Use it for
  machine-global files that must not be copied into profiles (e.g. the
  pi-droid-styling config, which the extension reads from a hardcoded global
  path). Synced via `./install.sh --base` (note: `--all` syncs profiles only,
  not `--base`).

### Adding a resource

1. Add its key to the `resources` object in [`profiles.jsonc`](profiles.jsonc)
   with the right `tags`.
2. Run `./install.sh <target>` (or `--all` / `--base`) to sync.

Resource key forms:

| Key | Lands at |
| --- | --- |
| `extensions/<feature>/<file>.ts` | `<profile>/extensions/<file>` |
| `extensions/<feature>/<file>.json` | `<profile>/extensions/<file>` |
| `skills/<name>/` (trailing slash) | `<profile>/skills/<name>/` |
| `npm:<pkg>` | appended to `<profile>/settings.json` `packages[]` |
| `git:<host>/<owner>/<repo>` | appended to `<profile>/settings.json` `packages[]` |

`npm:` and `git:` are both package resources (installed via `pi install`);
`git:` is for packages not published to npm (e.g. pi-droid-styling). Update
checks only apply to `npm:` (git packages have no registry version).

File resources may set an optional `"dest"` (path relative to the profile
dir) to land at a nested path — e.g. an extension's config file. If several
selected keys share a `dest`, tag-specific (non-core) keys beat core ones;
remaining ties go to the alphabetically-first key and losers are flagged as
`shadowed` (this happens on `--base`, which selects everything). Example:
the `command-guard` configs in `profiles.jsonc`, where work and
personal variants both map to `extensions/command-guard/command-guard.json`
and never collide because no profile has both tags.

### Shared settings

The optional top-level `"settings"` object in `profiles.jsonc` is merged
into every target's `settings.json` on install (all profiles and `--base`).
Only declared keys are written; `packages[]` and any other existing keys are
preserved. `"packages"` is rejected there — use `npm:`/`git:` resources
instead. Currently used for `"hideThinkingBlock": true` and the shared
`"theme": "catppuccin-mocha"` (from the pi-themes package).

### Global vs. per-profile

- **Global (`--base`):** syncs **all** resources (no tag filter) into
  `~/.pi/agent/`. Use for the machine-wide default config. A bare
  `pi install npm:<pkg>` is the manual equivalent of adding an `npm:` resource
  and running `--base`, but it bypasses `profiles.jsonc` — prefer the declared
  path so the repo stays the source of truth.
- **Per-profile:** syncs only resources whose tags match that profile (plus
  all `core`).

### Standalone tools (global CLIs)

The optional top-level `"tools"` object in `profiles.jsonc` declares
**standalone npm packages that live in this repo and are installed globally**
(`npm i -g`) by `./install.sh`. These are **not pi resources**: they are not
synced into any profile dir, not loaded by pi, and not installed via
`pi install`. They're regular global CLI tools that happen to be versioned
alongside the repo.

```jsonc
"tools": {
  "pi-omp-stats": { "path": "packages/pi-omp-stats" }
}
```

`path` is relative to the repo root; the bin name and version are read from
the tool's `package.json`. On install, `install.sh` runs `npm install` (builds
`dist/` via `prepare`) then `npm i -g .` for each tool, **every run** — these
packages are checked out from git rather than published, so a plain
version-string comparison can't detect a `git pull`/merge that changed the
source without bumping `version`; both npm commands are cheap/idempotent when
nothing changed, so always rebuilding is what keeps the global bin in sync.
Currently the only tool is `pi-omp-stats` (see `packages/pi-omp-stats/`).

## Non-clobber sync

`install.sh` tracks a hash of every synced file in
`<dir>/.impulso-pi-manifest.tsv`. Locally-edited files are never overwritten:
repo-changed/untouched → copy; local-changed/repo-untouched → skip (use
`./install.sh pull` to promote); both-changed → conflict, flagged.

## Current core resources

- `extensions/command-guard/` — bash command-guard (default-allow glob policy)
- `npm:@juanbenjumea/pi-dynamic-footer` — dynamic footer with live
  observability (context gauge, TPS, tokens, cost, cache %, git branch + diff,
  thinking level, fast-mode indicator, subscription quota bars for 8
  providers); owns the footer via pi's native `setFooter()`. Commands:
  `/obs`, `/obs-toggle`, `/obs-settings`. Replaced `pi-droid-styling` (which
  baked its footer into the BoxEditor with no disable flag) and
  `footer-status-widgets` (whose toks/cost/cache widgets duplicated this
  footer's). Persists session summaries under `~/.pi/agent/observability/`
- `git:github.com/sting8k/pi-themes` — companion themes (incl. catppuccin-mocha)
- `npm:@juicesharp/rpiv-ask-user-question` — ask-user-question tool
- `npm:@ff-labs/pi-fff` — FFF file finder; replaces pi's built-in
  `find`/`grep` (override mode, home-dir indexing off; both pinned by
  `extensions/fff/fff-env.ts`)
- `npm:pi-hashline-edit` — hash-anchored `read`/`edit` override; every line
  carries a `LINE#HASH:` anchor edits target instead of raw text, so stale
  reads/concurrent writes can't land an edit on the wrong line. Config
  (`extensions/hashline/hashline.json` → profile-root `hashline.json`) pins
  `grep: false` so it doesn't collide with FFF's `grep` override; it reads
  via pi's `getAgentDir()`, so the config is per-profile
- `npm:pi-provider-litellm` — LiteLLM proxy native Provider extension;
  discovers models from a self-hosted LiteLLM proxy and registers them under
  pi providers (default `litellm`, aliases via `litellm.providers` in
  settings.json); supports `/login litellm`, LiteLLM MCP tools, and LiteLLM
  Skills Gateway prompt injection

## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi` (auto-installed by ./install.sh if missing)
```
