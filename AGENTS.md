# impulso-pi

Personal [pi](https://pi.dev) customizations: extensions, skills, and setup
scripts. Layered on top of [pi-profiles](https://github.com/chaychoong/pi-profiles)
(`ppi`) so one machine can run several independent pi configs.

**Full design doc:** [`investigation/PROFILES.md`](investigation/PROFILES.md).
This file is the short version for agents working in this repo.

## How to install / sync resources

Resources (extensions, skills, npm packages) are declared in
[`profiles.jsonc`](profiles.jsonc) and synced into target dirs by
[`./install.sh`](install.sh) (a shim over `scripts/install.mjs`).

```bash
./install.sh                       # interactive: prompt for a target
./install.sh <profile>             # sync one profile, e.g. work-dev
./install.sh <group>               # sync every profile in a group, e.g. work
./install.sh --all                 # sync every profile in profiles.jsonc
./install.sh --base                # escape hatch: sync raw ~/.pi/agent (ALL resources)
./install.sh -y/--yes [target]    # non-interactive: install all missing deps (CI)
./install.sh status [target]       # per-file sync state, no changes
./install.sh pull   [target]       # promote local edits back into the repo
```

`<target>` is a profile name, a group name (`work` / `personal`), `--all`,
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
- Any other tag (`work-dev`, `personal-infra`, …) lands the resource only on
  profiles that declare that tag.

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

File resources may set an optional `"dest"` (path relative to the profile
dir) to land at a nested path — e.g. an extension's config file. If several
selected keys share a `dest`, tag-specific (non-core) keys beat core ones;
remaining ties go to the alphabetically-first key and losers are flagged as
`shadowed` (this happens on `--base`, which selects everything). Example:
the `pi-permission-system` configs in `profiles.jsonc`, where work and
personal variants both map to `extensions/pi-permission-system/config.json`
and never collide because every profile belongs to exactly one group.

### Shared settings

The optional top-level `"settings"` object in `profiles.jsonc` is merged
into every target's `settings.json` on install (all profiles and `--base`).
Only declared keys are written; `packages[]` and any other existing keys are
preserved. `"packages"` is rejected there — use `npm:` resources instead.
Currently used for `"hideThinkingBlock": true`.

### Global vs. per-profile

- **Global (`--base`):** syncs **all** resources (no tag filter) into
  `~/.pi/agent/`. Use for the machine-wide default config. A bare
  `pi install npm:<pkg>` is the manual equivalent of adding an `npm:` resource
  and running `--base`, but it bypasses `profiles.jsonc` — prefer the declared
  path so the repo stays the source of truth.
- **Per-profile:** syncs only resources whose tags match that profile (plus
  all `core`).

## Non-clobber sync

`install.sh` tracks a hash of every synced file in
`<dir>/.impulso-pi-manifest.tsv`. Locally-edited files are never overwritten:
repo-changed/untouched → copy; local-changed/repo-untouched → skip (use
`./install.sh pull` to promote); both-changed → conflict, flagged.

## Current core resources

- `extensions/footer/footer-widgets.ts` — footer widget extension
- `extensions/footer/pi-footer.json` — footer layout config
- `npm:pi-footer` — the footer renderer
- `npm:@juicesharp/rpiv-ask-user-question` — ask-user-question tool

## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi` (auto-installed by ./install.sh if missing)
```
