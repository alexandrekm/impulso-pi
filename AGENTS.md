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
3. **Update the settings page.** Every user-facing feature (npm/git
   package, local extension, or a pi built-in setting worth surfacing)
   must be registered in `extensions/impulso-settings/features.ts` so it
   shows up in `/settings` (the impulso page). Add a `Feature` entry with
   the right `tab`/`group`/`kind`:
   - `package` — npm/git spec, toggled via `packages[]` autoload.
   - `local` — a local extension under `extensions/`; the extension's
     factory must guard on `isFeatureEnabled(id)` from `feature-flag.ts`.
   - `pi-setting` — a safe `settings.json` key (booleans cycle on/off;
     enums cycle `values[]`). Only keys NOT managed by `profiles.jsonc`
     `settings` are safe here (install.sh would reset managed keys).
   - `config` — a top-level key in a *package's own* JSON config file under
     `<configDir>` (e.g. `pi-btw.json`, `pi-vision-handoff.json`), set via
     `configFile` + `key`. Use this when a package reads its own config file
     and exposes no config command to `launch`. Booleans cycle on/off;
     enums cycle `values[]` (include `""` as the first value to mean
     "key absent / use default", rendered as "same as main"); set `picker:
     true` for large/dynamic lists (e.g. a model drawn from the registry) so
     the row opens a searchable nested overlay instead of cycling. The
     overlay is built in `index.ts`'s `makePick(modelRegistry, ui)` keyed by
     feature id — add a branch there for a new picker feature.
   - `launch` — a row that opens a package's *own* config command
     (`/vision-handoff`, `/obs-settings`, …) via `pi.sendUserMessage` with
     `expandPromptTemplates`. Only extension commands are launchable — pi
     built-ins (`/settings`, `/login`) are hardcoded in the editor's
     onSubmit and unreachable from inside the overlay. If the package has a
     config file but no command, use `config` instead.
   Forgetting this step means the feature is installed but has no toggle in
   the UI — a regression of the settings page's promise that every feature
   is enable/disable-able from one place. Run `npm run typecheck && npm run
   lint` after editing `features.ts`.

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

Two optional top-level objects in `profiles.jsonc` are merged into every
target's `settings.json` on install (all profiles and `--base`), with
deliberately different semantics:

- **`"settings"` (MANAGED):** repo-owned keys that are **overwritten** on every
  sync. `packages[]` and any other existing keys are preserved; `"packages"`
  is rejected here — use `npm:`/`git:` resources instead. Currently used for
  `"hideThinkingBlock": true` and the shared `"theme": "catppuccin-mocha"`
  (from the pi-themes package).
- **`"settingsDefaults"` (DEFAULTS):** deep **fill-only** — a key (and its
  nested sub-keys) is written **only when absent** in `settings.json`, so
  user overrides made via `/settings` survive sync. Use this to seed safe
  initial values for extension-managed namespaces on fresh machines without
  clobbering per-user tuning. Currently used for `observational-memory`
  compaction thresholds (`compactAfterTokensMode: "ratio"`,
  `compactAfterTokensRatio: 0.9`) so the proactive auto-compaction trigger
  doesn't fire at the default 81k-token threshold on large-context models.
  The `/settings` "Compaction trigger mode" toggle can still flip it back to
  `calibrated` — install only fills these when absent, never resets them.

  This is why `observational-memory.*` keys are safe to expose as `pi-setting`
  features in `features.ts`: install.sh never resets them (it only fills the
  two compaction defaults when absent), so `/settings` toggles persist across
  syncs. Keys removed from `settingsDefaults` are left as-is (non-clobber).

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
- `npm:@narumitw/pi-btw` — `/btw` side-thread command: ask context-aware
  questions in a separate thread without derailing the main conversation
  (`/btw <question>` starts one; `/btw` opens a manager; `Ctrl+R` brings
  selected context back to the main editor). Side Q&A stays out of the main
  transcript by default. Uses the session's current model+creds, or an
  independent choice stored in `<configDir>/pi-btw.json` (`model` in
  `provider/model-id` form, `thinkingLevel`, `rememberThinkingLevelChanges`).
  That file is managed from `/settings` → Tools → **pi-btw** group: a
  searchable model picker (`config`+`picker`, sourced from the registry),
  a thinking-level enum, and a remember toggle — all write to `pi-btw.json`,
  read fresh each `/btw` so no `/reload` is needed for model changes

- `extensions/impulso-settings/` — `/impulso` AND `/settings` settings page:
  an OMP-style tabbed TUI (built on `@earendil-works/pi-tui`) that lists every
  feature declared in `extensions/impulso-settings/features.ts` grouped into
  tabs/sections and toggles them. npm/git packages flip
  `settings.json` `packages[]` between string and `{source, autoload:false}`;
  local extensions flip an entry in `<configDir>/impulso-settings.json` and
  each local extension's factory guards on `isFeatureEnabled(id)` from
  `feature-flag.ts` (so `/reload` applies); a safe subset of pi built-in
  settings (compaction/retry/quietStartup/etc., not the profiles.jsonc-
  managed ones) edit settings.json directly. Add a `Feature` entry in
  `features.ts` and it appears here automatically. Changes persist
  immediately; the footer hints `/reload` to apply.
  - `/settings` override: pi hardcodes `/settings` → its native menu in the
    editor's onSubmit (runs before extension commands parse) and exposes no
    API to open that menu, so `editor.ts` installs a `CustomEditor` via
    `ctx.ui.setEditorComponent` at `session_start`; its `onSubmit` wrapper
    (an instance accessor that captures pi's assignment) routes bare
    `/settings` to the impulso page and `/settings pi` (or `/pi-settings`)
    to pi's original onSubmit → pi's native menu. `/impulso` also works.
    Trade-off: the custom editor owns the editor factory session-wide.
  - `launch` features: rows that open a package's own config UI (e.g. the
    vision-handoff model picker via `/vision-handoff`, footer segments via
    `/obs-settings`, cache graph via `/cache`). On activate they close the
    impulso overlay then dispatch the command via
    `pi.sendUserMessage(cmd, { expandPromptTemplates: true })`, which routes
    through the extension-command path. The row's value reads the package's
    own JSON config (e.g. `extensions/pi-vision-handoff.json` → `visionModel`).
    Only extension commands are launchable this way — pi built-ins like
    `/settings`/`/login` are hardcoded in the editor's onSubmit and not
    reachable from inside an overlay; for pi-native settings (theme, thinking
    level, model, transport, image settings…) use `/settings pi`. Pi-native
    settings are owned by pi's SettingsManager and aren't duplicated here.


## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi` (auto-installed by ./install.sh if missing)
```
