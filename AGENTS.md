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
| `config/<file>` | `<profile>/<file>` (pi-root config, e.g. `config/models.json` → `<profile>/models.json`; `dest` optional override; `piRootDest` + `tags: ["base"]` instead lands at the pi root `~/.pi/<name>` — machine-global, one copy, synced only by `--base`) |
| `skills/<name>/` (trailing slash) | `<profile>/skills/<name>/` |
| `agents/<name>.md` | `<profile>/agents/<name>.md` |
| `prompts/<name>.md` | `<profile>/prompts/<name>.md` |
| `npm:<pkg>` | appended to `<profile>/settings.json` `packages[]` |
| `git:<host>/<owner>/<repo>` | appended to `<profile>/settings.json` `packages[]` |

`npm:` and `git:` are both package resources (installed via `pi install`);
`git:` is for packages not published to npm (e.g. pi-droid-styling). Update
checks only apply to `npm:` (git packages have no registry version).

An `npm:` resource may also set an optional `"prune": [<paths relative to
the installed package root>]` — install.sh deletes those paths from
`<target>/npm/node_modules/<pkg>/` on **every** sync (idempotent), so pi
package updates can't resurrect them. Use it to hide package-shipped
resources pi force-loads with no per-item blacklist. Currently:
`npm:pi-subagents@0.64.0` prunes `skills/council-mode` and
`skills/pi-subagents` (we delegate to the scout subagent only; pi
auto-registers every skill a package's `pi.skills` manifest declares).

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
  `compactAfterTokensRatio: 0.6`) so the proactive auto-compaction
  trigger doesn't fire at the default 81k-token threshold on
  large-context models,
  and for `litellm.skills.enabled: false`, which stops pi-provider-litellm
  from registering the LiteLLM Skills Gateway tools
  (`litellm_skill_list/create/delete`) and injecting the proxy's skill
  registry into the system prompt (toggleable at /settings → Providers →
  LiteLLM → Skills Gateway tools).
  The `/settings` "Compaction trigger mode" toggle can still flip it back to
  `calibrated` — install only fills these when absent, never resets them.

  This is why `observational-memory.*` keys are safe to expose as `pi-setting`
  features in `features.ts`: install.sh never resets them (it only fills the
  two compaction defaults when absent), so `/settings` toggles persist across
  syncs. Keys removed from `settingsDefaults` are left as-is (non-clobber).
- **`profiles.profiles.<name>.settingsDefaults` (PROFILE-LAYERED):** a
  profile entry may declare its own DEFAULTS, merged **over** the global ones
  for that target only (plain objects deep-merge leaf-by-leaf; scalars and
  arrays replace the global value wholesale — a model shortlist is a whole
  list, not a union). `--base` gets the global defaults only. This is where
  the work model seed lives (`defaultProvider`/`defaultModel`/
  `enabledModels`): the OpenRouter GLM/Kimi pair plus the anthropic claude
  shortlist (sonnet/opus-5, fable-5-1).
- **`profiles.machines.<variant>.profileDefaults` (MACHINE-LAYERED):** seeds
  that are a property of the **machine**, not the profile. The personal
  profile runs on both machines — on the work laptop it uses the same
  models as work; on the personal machine it uses the LiteLLM proxy
  (`litellm/gpt-5.6-*`, `litellm/deepseek-flash` — explicit `litellm/`
  prefixes so OpenRouter's lookalike `openai/gpt-5.6-*` ids never match).
  install.sh picks the variant from the `IS_WORK` env var (`true` →
  `machines.work`, anything else → `machines.personal`) and layers its
  per-profile defaults **over** the profile layer; `--base` is never
  machine-seeded. Order: global → profile → machine (later wins).

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
Besides usage/cost/tool stats, it now also tracks **compaction** events,
**observational-memory** events (observations/reflections/drops + the
`om.folded` snapshot carried through compactions), and **guard blocks**
(commit-guard / command-guard `tool_call` blocks, recovered from the error
tool results pi persists for them — guard, kind, model, blocked command,
reason), all parsed from session JSONL with no upstream pi change. New
`compaction_stats` + `memory_events` + `guard_events` tables and
`/api/stats/compaction*` + `/api/stats/memory*` + `/api/stats/guards*`
routes feed a Compaction panel, an Observational Memory panel (with a
searchable memory browser), and a Guards panel (with a searchable list of
blocked commands) in the dashboard. The `/api/stats/pins` route feeds
the **Session Pins** panel (openrouter-session-pin observability): it
live-joins each profile's `openrouter-session-pin-state.json` (session id
→ model → backend tag, written by the extension) with per-session usage
from the messages table — session ids are embedded in pi's session-file
basenames — to show requests/tokens/cost per backend, a per-day stacked
chart, recent sessions with their pin, and the configured rotation lists;
sessions predating the extension (or pruned from the 30-day state file)
surface as `(unpinned)`, giving a before/after baseline. No DB schema
change: the pin is session state, not history. The `/api/stats/search-adoption`
route feeds the **Search Adoption** panel (zvec enablement tracking):
per-session search-tool usage from `tool_calls`, sessions split at the
zvec-enablement cutoff (`?since=` epoch-ms or ISO date; default 2026-09-09,
the home-index fix) and compared on turns, wall-clock (first→last user
message, 12h cap), tokens, and zvec vs grep/find call mix, plus a per-day
adoption chart — answers "did investigation time drop after zvec worked". The
`/api/stats/context` route feeds the **Context Budget** panel: it reads the
first-call measurement record (`context-measurement.json`, see
`extensions/context-measure/`; `npm run measure:context -- --record` writes
the repo copy AND drops a machine-local copy next to the stats DB where
this route finds it), shows per-target first-call cost (tool schema vs
system prompt chars, ×stock multiplier), and joins per-tool schema chars
with actual `tool_calls` usage: paid = schema × requests in range,
per-call = paid ÷ calls — the hide-it-or-keep-it ranking (current winner:
`subagent`, 21k schema chars, single-digit monthly calls). Join target:
the profile's own record row, else `base` ("all" view);
`PI_STATS_CONTEXT_RECORD` overrides the record path.
A schema-version sentinel in `meta`
resets file offsets once on upgrade so the new tables backfill from existing
sessions.
`install.sh` always rebuilds + reinstalls the `pi-omp-stats` global bin
(a version check isn't safe for git-checked-out packages), and when the
background service is already registered it also **restarts** it
(`pi-omp-stats service restart`) so the running launchd/systemd process picks
up the freshly-built binary — without this, KeepAlive keeps the old process
alive forever and the dashboard serves stale assets after an upgrade. In
profiles mode it re-runs `service install` first to re-bake
`PI_STATS_PROFILES_DIR` into the plist/unit, then restarts.

The tools section hits the npm registry (real downloads, no overall
timeout), so CI's install.sh smoke test sets `IMPULSO_SKIP_TOOLS=1` to skip
it — a registry stall there hung the smoke-test step past the job's 10m
cap twice (impulso-pi#100). The smoke test verifies file-sync logic, not
tool installs, so skipping removes the step's entire network surface.

## Non-clobber sync

`install.sh` tracks a hash of every synced file in
`<dir>/.impulso-pi-manifest.tsv`. Locally-edited files are never overwritten:
repo-changed/untouched → copy; local-changed/repo-untouched → skip (use
`./install.sh pull` to promote); both-changed → conflict, flagged.

For **directory resources** (skills), the local side is hashed against the
repo's file list, so machine-local extras inside a synced dir are invisible
to sync: they never conflict, are never overwritten by an install
(merge-copy, nothing deleted), and never promoted by `pull`. Use this for
unversioned per-machine companions, e.g. `skills/confluence/LAYOUT.md`
(concrete space keys, page-tree ids, helper-script paths that must not be
versioned).

## Current core resources

- `extensions/command-guard/` — bash command-guard (default-allow glob policy)
- `npm:@juanbenjumea/pi-dynamic-footer` — dynamic footer with live
  observability (context gauge, TPS, tokens, cost, cache %, cache TTL
  retention + expiry countdown (local segment, tracks the cache-ttl
  extension's PI_CACHE_RETENTION), git branch + diff, thinking level,
  fast-mode indicator, subscription quota bars for 8
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
- `extensions/cache-ttl/` — prompt-cache TTL control. pi only exposes
  extended prompt caching via the `PI_CACHE_RETENTION` env var (no
  settings.json key); this extension reads `<configDir>/cache-ttl.json`
  (`{ "retention": "short" | "long" }`) at load and sets the env var when
  `long` is selected (Anthropic 1h vs 5m, OpenAI 24h vs in-memory, Bedrock
  1h). Default `short` leaves the env untouched and preserves/restores any
  shell-provided value. Toggled in `/settings` → Providers → Prompt
  caching (a `config` feature); `/reload` applies.
- `extensions/context-measure/` — **first-call context recorder**: a `measure`
  provider (`measure/measure-model`) whose `streamSimple` receives pi's
  fully composed request (`{ systemPrompt, messages, tools }`), appends a
  per-request summary (system-prompt chars, per-tool schema chars, tool
  count) to `<configDir>/context-measure.jsonl`, and answers locally with
  `ok` — no network, no local server (the pi-native replacement for
  SpecPi's synthetic-HTTP-provider method; pi aliases `@earendil-works/pi-ai`
  imports in extensions to its bundled copy, so the provider IS the
  endpoint). Zero request footprint: registers no tools, no prompt text, so
  it ships `core` everywhere — live sessions can switch to
  `measure/measure-model` any moment (records land in the jsonl), and
  subagent children are captured too. `npm run measure:context` measures
  stock vs. work/personal/base and writes the committed record
  `investigation/context-measurement.json` (counts pi's intermediate
  request representation, NOT the wire format — comparable across profiles
  and time, not to wire-format charts). CI `npm run check:context-record`
  fails when a PR changes profiles.jsonc / extensions/ / skills/ without
  updating the record: the context-budget ratchet. Current numbers: stock
  5.4k chars / 4 tools; profiles ~55-58k / 16-17 tools (~10.8x stock; the
  `subagent` tool alone is 21k).
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

- `git:github.com/alexandrekm/pi-zvec-grep` (our fork of
  MikkelKappelPersson/pi-zvec-grep v0.3.1, see `investigation/ZVEC-ADOPTION-
  REVIEW.md`) + `extensions/pi-zvec-grep/config.json` + `tools: @zvec/zvec-grep`
  — zvec-grep (`zg`) hybrid semantic + keyword search as native pi tools
  (`zvec_search` / `zvec_index` / `zvec_status`, `/zg` command). Additive:
  FFF keeps `find`/`grep` for exact strings; `zvec_search` (whose `query`
  param is **required** — the fork's adoption fix; the one organic call in
  the wild died on an all-optional schema) is for meaning-based /
  location-unknown questions. Indexes live per-workspace at
  `<root>/.zvec-grep` (gitignored); the global `zg` CLI is installed by
  install.sh's `tools` section. User config at
  `<configDir>/pi-zvec-grep/config.json` — autoIndex on + `rootPolicy`,
  toggled in `/settings` → Search. The fork + `extensions/zvec-guard/`
  (mirrors the policy at pi's tool_call layer) enforce a **root policy**:
  `$HOME` and umbrella roots (≥ `maxNestedRepos`, default 3, nested git
  repos at depth ≤ 2) are never indexed — zg 0.2.x cannot index nested
  repos at all, so an umbrella index is a near-empty stub that shadows
  real leaf-repo indexes for sessions below it; `rootPolicy.allowRoots` is
  the escape hatch, never unlocks `$HOME`, and drop always passes. The
  fork's autoIndex also takes a cross-process lock
  (`<root>/.zvec-grep/locks/autoindex.lock`, stale after 10 min) — racing
  builds from concurrent sessions corrupted a 4.1 GB `~/code` index once.
  **Why umbrella roots stay blocked even though they're the main way we
  work** (verified against zg 0.2.2): `zg index <explicit-root>` honors the
  root, but cwd-based `status`/`query`/`index` resolve the NEAREST ANCESTOR
  index — so an index at an umbrella/container root makes every repo below
  it permanently un-indexable, and an ancestor's "ready" suppresses leaf
  builds. Instead the fork's autoIndex (a) resolves the NEAREST ENCLOSING
  git repo of the session cwd (`.git` dir or worktree gitfile — a session
  in a worktree or a repo subdir indexes that repo, one index per repo,
  never a per-subdir stub, never the main checkout), (b) SEEDS a worktree
  without an index from its main checkout's base index (manifest rootPaths
  rewritten, 2 GB cap) before updating it in the background — turn-1 search
  on fresh worktrees, then update-as-we-go, never write-back — and (c)
  builds directly when the root's own manifest is missing (an ancestor's
  "ready" can no longer shadow leaf/worktree builds). Keep base indexes on
  the main checkouts reindexed after pulls (user's own command). Sessions
  at an umbrella root works OUT OF THE BOX: the fork's autoIndex indexes
  the depth-1 submodule repos in the background (seeded from the main
  checkout's submodule bases when present), and `zvec_search` from the
  root automatically FANS OUT across every indexed submodule — one call
  searches every repo under the umbrella (merged, per-repo headers,
  ≤40 repos, 5 concurrent, ≤5 hits each). `root=<submodule>` still works
  to scope a search to one repo, and `fts` (`zg query --rg`) covers
  submodule content index-free. A short global
  search-routing nudge ships as `config/APPEND_SYSTEM.md` (pi appends
  `<agentDir>/APPEND_SYSTEM.md` to every system prompt) because work repos'
  AGENTS.md files say nothing about zvec. Worktrees: autoIndex SEEDS a fresh
  worktree at the first session start — it copies the main checkout's base
  `.zvec-grep` in, REWRITES `manifest.json` rootPaths to the worktree, and
  updates it in the background (turn-1 search from the seed, correct
  content from the update; never writes back to the main). For umbrella
  repos the bases must live in the SUBMODULE checkouts of the main
  (`<main>/<submodule>/.zvec-grep`), never at the superproject root —
  that's what seeds each submodule inside a worktree, and the user's
  after-pull reindex command targets those. Do NOT hand-copy
  `.zvec-grep` into worktrees (e.g. from a setup script): without the
  rootPaths rewrite the copy is a frozen snapshot of the main, and an
  umbrella-root copy would shadow every submodule repo in the worktree.

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

## Work-profile resources

- `config/models.work.json` → `models.json` — **pi-root model overrides**
  (work-only). Real per-model costs and display names for the OpenRouter
  models we use; routing is NOT pinned here (see openrouter-session-pin
  below — static compat pins concentrated every session on one backend and
  hit rate limits). pi reads it from the profile dir root. The `config/`
  resource namespace (see the key table above) lands repo files at the
  target root. Base (`~/.pi/agent`) and personal deliberately stay
  unpinned — plain `pi` runs keep pi's built-in model catalog. The empty
  `config/models.base.json` exists only to shadow the work variant on
  `--base` (which selects every resource): it wins the shared-dest
  alphabetical tie-break and installs `{"providers":{}}` — zero
  overrides, a no-op. `models-store.json` is pi's own runtime cache —
  never user config.

- `extensions/openrouter-session-pin/` — **per-session OpenRouter backend
  pinning** (work-only). At session start each configured model (GLM-5.3,
  Kimi K3) gets ONE backend picked randomly from the candidate list in
  `<configDir>/openrouter-session-pin.json`; every request the session
  sends carries `provider:{only:[tag],allow_fallbacks:false}` via the
  `before_provider_request` hook (same request field models.json's old
  `compat.openRouterRouting` produced, but chosen per session). Keeps
  each session's prompt cache warm while spreading concurrent sessions
  across backends (BaseTen fp8/fp4, Modal, Fireworks…). Pins persist by
  session id in `openrouter-session-pin-state.json` (30-day pruning; requests
  touch a per-model `lastRequestAt`) so `/reload` and `pi -c` reuse the
  backend. Idle re-roll: a request after `idleRerollMinutes` (default 10,
  0 = off, in the config JSON) re-rolls off the current backend — by then
  the backend's prefix cache has expired anyway, so long-lived sessions keep
  spreading instead of freezing on their first pick and move off a slow or
  rate-limited backend after a break. `/orpin` lists pins, `/orpin reroll`
  re-picks. Also patches the live model's name/cost so the footer shows the
  actual backend. Toggled in `/settings` → Providers → OpenRouter.

- `extensions/openrouter-cost/` — **real-cost accrual for OpenRouter** (core).
  pi computes per-request cost from the model catalog's static rates
  (`calculateCost` in `packages/ai/src/models.ts`) and discards the real
  amount OpenRouter reports — which depends on the serving backend and its
  cache pricing (verified 2026-09: OpenRouter's endpoints API reports
  `cache_read: 0` for backends that bill $0.007-0.03/Mtok). This extension
  captures the `x-generation-id` response header via
  `after_provider_response`, then at `message_end` polls the Generation API
  (`GET /api/v1/generation?id=…`, record appears ~2-5s after the response)
  and rewrites the message's `usage.cost` with the actual `total_cost`,
  distributed across pi's cost buckets proportionally by token share — the
  same pattern pi-provider-litellm uses for `x-litellm-response-cost`.
  Bounded poll (4 × 1.5s, early-exit); on timeout/error the message keeps
  pi's locally-calculated cost, so models.json and pin-config cost tables
  remain as fallbacks. No-op without OpenRouter credentials in `auth.json`.
  Trade-off: up to ~5s added per model response while the record appears
  (pi awaits message_end handlers). Toggled in `/settings` → Providers →
  OpenRouter. /reload applies.

- `extensions/commit-guard/` — **commitlint enforcement on every `git commit`**
  (work-only). Hooks the bash `tool_call` (same pattern as command-guard),
  parses the commit message, blocks `--no-verify`/`-n`, and validates the
  message by running the repo's own `node_modules/.bin/commitlint` when
  present (exactly what CI runs) or the built-in Motive rules otherwise
  (`rules.ts`: `type` ∈ {feat,fix,docs,style,refactor,perf,test,revert,
  build,ci}, Jira-key scope, no special chars in subject, ≤200 chars). A
  non-compliant commit is blocked before it is created — no CI round-trip or
  history rewrite. `--amend` with `-m` is validated; `--amend` without `-m`
  and force-push pass through (a true pre-tool "warn" isn't expressible in
  the `tool_call` hook). Reuses `command-guard/engine.ts` (core) for shell
  peeling/splitting. Toggled in `/settings` → Tools & Safety → Commit guard.

- `skills/slack/` — Slack read/search/send via the `slackcli` CLI,
  authenticated as the user's browser session (no Slack app needed). Auth
  needs Brave and a locally patched binary; install/recovery steps in
  `skills/slack/SETUP.md`. Skill enforces ask-before-writing; no workspace
  IDs hardcoded — resolved live from the local config. The binary is
  installed manually (`~/.local/bin`), not via install.sh.

## Complexity gates (legibility budget)

CI enforces three per-function complexity metrics over `extensions/`
(excluding vendored, upstream-managed dirs):

| Metric | Gate | Tool |
| --- | --- | --- |
| Cyclomatic complexity | < 22 | ESLint built-in `complexity` (max 21) |
| Cognitive complexity | < 22 | `sonarjs/cognitive-complexity` (max 21) |
| Halstead difficulty | < 80 | `npm run check:halstead` → `scripts/check-halstead.mjs` |

All three run in CI via the existing `npm run lint` step plus one
`npm run check:halstead` step; locally use the same two commands.

- **Cyclomatic** counts independent paths (each `if`/`case`/loop/`&&`/ternary
  adds 1). High = untestable branch soup.
- **Cognitive** is the same count weighted for *nesting* (SonarSource): an
  `if` inside three loops costs far more than three flat `if`s. High = code
  a human can't hold in their head. This is the metric most directly tied
  to legibility.
- **Halstead difficulty** ≈ `(unique operators / 2) × (total operands / unique
  operands)`: high means dense, heterogeneous code where every line
  introduces new vocabulary.

The Halstead script is vendored (`scripts/check-halstead.mjs`) because no
maintained ESLint rule exists — `eslint-plugin-metrics` last shipped 2022 and
its companion halstead plugin never published; `ts-complex` (2022) misses
arrow functions and methods. The script scores every function-like node on
its own body (nested functions count separately) via the TypeScript API
already in devDependencies. Excluded dirs must stay in sync with
`eslint.config.js` ignores and `tsconfig.json` exclude.

When a function exceeds a gate: prefer extracting helpers/switch-dispatch
over `eslint-disable` — the point of the gate is legibility, not the number.

## Coverage and CRAP gates (test-quality budget)

Two more CI gates tie complexity to tests:

| Metric | Gate | Tool |
| --- | --- | --- |
| Coverage (logic modules) | ≥ 90% stmts/branches/funcs/lines | `npm run check:coverage` (c8) |
| CRAP | < 25 | `npm run check:crap` → `scripts/check-crap.mjs` |

- **Coverage** is scoped to the modules held to the bar — the `--include`
  list in the `check:coverage` npm script (currently the guard engines,
  the impulso-settings trio, subagent-telemetry, gws, system-prompt,
  openrouter-session-pin, and the two border extensions; all ≥90%
  statements+branches). Thresholds
  apply to the *aggregate* of the included files. The remaining first-party
  modules (search_docs, modes, payload-exporter, on-demand-skills,
  cache-ttl, feature-flag, the guard entry files, editor.ts) have tests but
  sit below 90% branches — they're gated through CRAP (below) instead.
  When a module clears 90%, add its `--include` and move on.
- **CRAP** = `comp² × (1 − coverage)³ + comp` per function: complexity is
  allowed only when paid for with tests. comp ≤ 4 passes with no tests
  (4² + 4 = 20); comp 9 untested fails (90). Fully covered functions score
  exactly their comp, already gated at < 22 by ESLint. The script (vendored;
  no maintained JS tool computes CRAP) runs `npm test` under
  `NODE_V8_COVERAGE`, merges the per-process V8 dumps, and joins per-function
  coverage with per-function complexity from the same AST lib the Halstead
  gate uses (`scripts/lib/ts-metrics.mjs`).

The CRAP gate is a **ratchet** repo-wide over first-party extensions (the
vendored 3rd-party dirs — orca-integration, herdr, pi-dynamic-footer — are
excluded from all gates, and cursor/fff/hashline/pi-droid-styling/
pi-zvec-grep are env/config shims with no logic). Every first-party
function currently passes: `scripts/crap-exemptions.json` is **empty**. If
a new violation appears, either write tests or regenerate the list with
`npm run check:crap -- --update-exemptions` — the checked-in list is
reviewable in the PR diff, the gate fails on unlisted violations AND on
stale entries, so it only ever shrinks back to empty.

Caveat: V8 reports block coverage, not branch coverage — CRAP is a risk
heuristic, not proof of test strength; a mutation-testing gate (surviving
mutants = 0) would be the stronger follow-up.



## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi` (auto-installed by ./install.sh if missing)
```

The `pi` CLI itself is **not** a manual prerequisite anymore: `./install.sh`
installs it when missing via the official method (`npm install -g
--ignore-scripts @earendil-works/pi-coding-agent`) and **never overwrites an
existing install** — any `pi` already on PATH (npm global, pi.dev installer,
managed install, distro package) is reported and left untouched. The only
update path is the opt-in self-update offered during the dependency review.
Alternative installers (pi.dev `install.sh`, which also supports an
experimental managed install under `~/.pi/agent/install` + a
`~/.local/bin` symlink) work fine too — install.sh's detect-first logic
picks them up like any other install.

**Version pin (emergency rollback lever):** declare `"pi": { "pin":
"<version>" }` at the top level of `profiles.jsonc` and install.sh enforces
it — installs that exact version when pi is missing, switches to it when the
running version drifts (managed installs: stage the release dir + flip
`install/current-version`; npm-global: install the exact version), and
suppresses the self-update offer while set. The managed layout keeps old
releases staged under `install/releases/`, so switching back is instant.
Unpin by removing the key. A hand-run `pi update` ignores the pin — re-run
`./install.sh` to enforce it back. See the commented-out example in
`profiles.jsonc`.

### Migrating a machine off a Homebrew-prefix pi

With Homebrew's node, `npm install -g` lands in `/opt/homebrew/lib/
node_modules/` — a prefix Homebrew owns, so pi "lives in brew's world"
even though it was never a brew formula. To move an existing install to a
fully user-owned managed one (the work laptop did this on 2026-09-20), run
the helper — report-only by default, `--apply` to migrate:

```bash
scripts/utils/migrate-pi-official.sh            # report what it found
scripts/utils/migrate-pi-official.sh --apply   # do the migration
```

It detects the current install (npm-global in any prefix, an actual brew
formula, already-managed, absent, or unknown → refuses), removes the old
copy, fetches the official pi.dev installer, and runs it in managed mode
with `PI_CODING_AGENT_DIR` stripped (a pi session exports it and would
misdirect the managed install into the active profile dir — so the script
is safe to run from inside pi). Result: releases under
`~/.pi/agent/install/releases/<version>/`, launcher at `~/.pi/agent/bin/`,
`pi` symlink in `~/.local/bin`; old releases stay staged, which is what
makes the version pin instant. After it finishes: restart pi sessions,
then re-run `./install.sh <target>` — it detects the new pi, syncs
resources, and offers package updates (e.g. it caught pi-observational-
memory 3.1.4 with the streamSimple fix).

On a fresh machine none of this is needed: `./install.sh` installs pi via
the official npm command when missing — the managed-layout migration is
only for moving an existing install out of Homebrew's prefix.

If `npm install -g` fails with a permissions error (user can't write to the
global npm prefix), the root-free fix is to point npm at a user-owned prefix
(`mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`, then add
`~/.npm-global/bin` to PATH) — or re-run with `sudo ./install.sh <args>`.
`./install.sh` detects the permission failure and prints these hints itself.

## Known upstream bugs (local patches)

### pi-observational-memory ≤ 3.1.3 crashes pi ≥ 0.85 (detached streamSimple)

`resolveWorkerStreamSimple` in the package's `src/agents/worker-stream.ts`
pulls `modelRegistry.streamSimple` out as a bare function reference and calls
it later **without the receiver**. pi's `ModelRegistry.streamSimple` is a
prototype method reading `this.runtime` (the facade shipped in the 0.85/0.86
line — verified absent at v0.84.1), so the detached call runs with
`this === undefined` → `TypeError: Cannot read properties of undefined
(reading 'runtime')`, thrown inside a background memory worker →
`uncaughtException` → **pi exits**. The same detachment exists in its
`getRegisteredProviderConfig` fallback path.

**RESOLVED upstream in 3.1.4** (2026-09-20): the registry path now calls
`registryStream.call(modelRegistry, …)`. The local bind-patch was removed by
the 3.1.4 update. The `getRegisteredProviderConfig` fallback still returns
`composed` detached, but registered-provider configs are closures — no
receiver needed — so it's low-risk. Kept here as the record + the recipe for
future detached-method crashes: identify the bare method extraction, re-bind
the receiver in the installed copies, and note it in this section — plus the
two levers that made this incident survivable:

- **Version pin** (see Prerequisites): when a pi upgrade breaks something
  with no local patch available, pin back to the last known-good version —
  for this bug that was **0.84.1** (last release without the
  `ModelRegistry.streamSimple` facade). The managed install keeps old
  releases staged, so switching is instant.
- **Package-level bind-patch**: the installed copies live under
  `<profile>/npm/node_modules/<pkg>/`; a patch there survives syncs (npm
  packages are only touched when missing or on update) and is overwritten
  by the next `pi update` — check upstream for the real fix first.

## Machine-global pi-root files (`piRootDest`)

A `config/` resource tagged exactly `["base"]` may set `piRootDest` to a
relative path under the pi root (`~/.pi`) instead of a per-profile `dest`:
the file lands at `~/.pi/<piRootDest>` — one machine-global copy, synced
only by `./install.sh --base` (profiles never select it). Currently used by
`config/setup_worktree.sh` → `~/.pi/setup_worktree.sh`: the worktree
bootstrap script (parallel submodule init/update/reset on
`SETUP_WORKTREE_BRANCH` (default master), nested submodules, direnv /
pre-commit hooks, `WORKTREE_READY` marker; no-submodule repos are fine —
the submodule steps are skipped; run it from inside the worktree, it
operates on the work tree's toplevel), and
`config/pull_all.sh` → `~/.pi/pull_all.sh`: the after-pull update
(parallel per-submodule checkout+pull of the origin default branch,
sequential zvec reindex of each SUBMODULE checkout — the bases worktree
seeding and umbrella fan-out rely on, never the umbrella root — then
stage/commit/push of the updated submodule pointers). It deliberately does NOT touch
zvec-grep — autoIndex seeds worktree indexes at the first session start;
hand-copying `.zvec-grep` is actively harmful (frozen snapshot without the
rootPaths rewrite, or an umbrella stub shadowing every submodule index).
The repo-tracked copies (~/code/mtv/*/setup_worktree.sh, pull_all.sh) are
kept identical to the references;
`scripts/utils/check-script-drift.sh` compares every copy against
`config/{setup_worktree,pull_all}.sh` and the pi-root installs, flagging
DRIFTED / MISSING (exit 1; read-only — `install.sh --base` plus a `cp`
fixes what it finds). Stale-index sweep (per machine, after pulling these
changes):
`scripts/utils/zvec-cleanup.sh` reports, and `--apply` drops, the three
harmful leftovers — frozen worktree copies, umbrella/container-root
indexes, home-rooted indexes; healthy indexes are untouched. Indexes on
network filesystems are always FLAGGED and dropped only with the
additional `--network` flag (opt-in: a network mount may hold the only
copy of something).
