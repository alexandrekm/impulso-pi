# Profiles: tagged resource sets per pi profile

Layer [pi-profiles](https://github.com/chaychoong/pi-profiles) (`ppi`) on top of
this repo so one machine can run several pi configs (work-dev, work-infra,
personal-general, ...) and each profile gets exactly the skills / extensions /
npm packages tagged for it.

See also: [EXTENSIONS.md](EXTENSIONS.md), [ORCHESTRATION.md](ORCHESTRATION.md).

## How the pieces compose

| Layer | Owns | Owned by |
| --- | --- | --- |
| Profile dir + launcher | `~/.pi/profiles/<name>/`, `ppi use <name>` | **pi-profiles (`ppi`)** |
| Auth + models symlinks | `<profile>/auth.json`, `models.json` → `~/.pi/agent/` | `ppi` (symlinked by default) |
| **Which resources go in a profile** | extensions, skills, npm packages per tag | **this repo's `profiles.jsonc` + `install.sh`** |
| Non-clobber sync | per-file hash manifest inside each profile dir | `install.sh` (existing logic) |

`ppi` manages whole agentDirs and launching; it has **no notion of tags or
partial install**. This repo fills in that gap: it reads `profiles.jsonc`,
decides which resources belong on a profile, and syncs them into that profile's
dir (reusing the existing hash-manifest sync so live edits inside a profile
are never clobbered).

`ppi` works entirely through the documented `PI_CODING_AGENT_DIR` env var — pi
itself is unaware it's wrapped. We compose with it the same way:
`PI_AGENT_DIR=~/.pi/profiles/<name> ./install.sh <name>`.

## `profiles.jsonc` (JSONC, comments allowed)

Lives at repo root. JSONC so we can annotate; parsed by a zero-dep Node helper
(`scripts/profiles.mjs`) that strips comments before `JSON.parse`.

```jsonc
{
  // Install rule: a resource lands on a profile if it has "core" OR any tag
  // in the profile's "tags". "core" is implicit on every profile.
  "tags": [
    "work-dev", "work-infra", "work-docs", "work-general",
    "personal-dev", "personal-infra", "personal-general",
    "core"
  ],

  // Groups let `./install.sh work` sync every profile in the group at once.
  // Declared explicitly (not derived from name prefix) so it's lintable.
  "groups": {
    "work":     ["work-dev", "work-infra", "work-docs", "work-general"],
    "personal": ["personal-dev", "personal-infra", "personal-general"]
  },

  "profiles": {
    "work-dev":          { "tags": ["work-dev"] },
    "work-infra":        { "tags": ["work-infra"] },
    "work-docs":         { "tags": ["work-docs"] },
    "work-general":      { "tags": ["work-general"] },
    "personal-dev":      { "tags": ["personal-dev"] },
    "personal-infra":     { "tags": ["personal-infra"] },
    "personal-general":  { "tags": ["personal-general"] }
  },

  "resources": {
    // "core" baseline = everything currently in this repo. Always installed.
    "extensions/footer/footer-widgets.ts": { "tags": ["core"] },
    "extensions/footer/pi-footer.json":     { "tags": ["core"] },
    "npm:pi-footer":                        { "tags": ["core"] }

    // Future tagged resources, e.g.:
    // "skills/jira/":              { "tags": ["work-dev", "personal-dev"] },
    // "skills/infra-ansible/":     { "tags": ["work-infra", "personal-infra"] },
    // "npm:@pi-stef/atlassian":    { "tags": ["work-dev"] }
  }
}
```

### Resource key forms

| Key | Kind | Lands at |
| --- | --- | --- |
| `extensions/<feature>/<file>.ts` | extension file | `<profile>/extensions/<file>` (flat, as today) |
| `extensions/<feature>/<file>.json` | extension config | `<profile>/extensions/<file>` |
| `skills/<name>/` (trailing slash) | skill dir | `<profile>/skills/<name>/` |
| `npm:<pkg>` | npm package | appended to `<profile>/settings.json` `packages[]` |

Multi-tag resources are installed on every profile matching any of their tags.

## Install rule

For profile `P` with declared tags `P.tags`:

```
resource is on P  ⟺  "core" ∈ resource.tags  OR  resource.tags ∩ P.tags ≠ ∅
```

`core` is implicit on every profile; you don't list it in a profile's `tags`.

## Installer (Node)

The installer is rewritten in Node (`scripts/install.mjs`, zero dependencies).
`install.sh` is now a thin shim that execs it, so existing muscle memory and
CI invocations (`./install.sh install ...`) keep working. JSONC (comments)
doesn't parse in bash, and the per-profile sync needs real file/hash work, so a
Node rewrite is cleaner than threading a Node helper behind a bash front.

`scripts/profiles.mjs` holds the pure logic shared by the installer and CI:
JSONC stripping, `profiles.jsonc` loading, schema validation, resource
classification, and tag→profile matching.

### Commands

```
./install.sh                       # interactive: prompt for a target
./install.sh <profile>             # sync one profile, e.g. work-dev
./install.sh <group>                # sync every profile in the group, e.g. work
./install.sh --all                  # sync every profile in profiles.jsonc
./install.sh --base                 # escape hatch: sync raw ~/.pi/agent (all resources)
./install.sh -y/--yes [target]    # non-interactive: install all missing deps
./install.sh status [target]       # per-file sync state, no changes
./install.sh pull   [target]       # promote local edits back into the repo
```

`<target>` is a profile name or a group name; `--all` hits every profile.
`status`/`pull` take the same targets. No target + non-interactive stdin is an
error (CI passes `--yes --base` explicitly).

### Dependency review

Before the file sync, `install` reviews dependencies and asks which to
install:

- **`ppi` (pi-profiles)** — listed if missing and the target is a profile /
  group / `--all` (required to create profile dirs). Installed via
  `npm install -g pi-profiles`. **Deselecting it aborts** — profiles can't be
  created without it.
- **`npm:` packages** from `profiles.jsonc` (union across the target
  profiles). Already-installed-and-up-to-date packages are **hidden**; a
  package with a newer version on npm is shown as `update (X -> Y)` so you can
  choose to run `pi update`.

```
==> Dependencies
   1. ppi (pi-profiles)             not installed  [required]
   2. npm:pi-footer                 not installed
   3. npm:@pi-stef/atlassian        update (1.2.0 -> 1.3.0)
Install which? [all/<numbers>/none] (default: all):
```

`-y` / `--yes` is non-interactive: install all **missing** deps, skip the
version checks (no `npm view`) and skip updates. Used by CI.

### What "sync a profile" does

1. Ensure the profile dir exists. If `~/.pi/profiles/<name>` is missing, run
   `ppi create <name>` (blank scaffold; auth/models symlinked by `ppi`).
2. **Review + install dependencies** (above): `ppi` if missing, and the
   profile's `npm:` packages (interactive, or all-missing under `--yes`).
3. Compute the file/dir resource subset for that profile from `profiles.jsonc`.
4. Copy each into `<profile>/extensions|skills/`, guarded by the hash manifest
   so locally-edited files are skipped (same install/pull/status semantics as
   before).

### `--all` creates missing profiles

`--all` runs `ppi create` for any profile in `profiles.jsonc` that doesn't yet
exist locally, then syncs. (Confirmed behavior.)

### `--base` escape hatch

`./install.sh --base` targets `${PI_AGENT_DIR:-~/.pi/agent}` directly and
installs **all** resources (no tag filter) — the original single-target
behavior, preserved for power users and CI. (Confirmed behavior.)

### Manifest location

The hash manifest lives **inside each target dir**:
`<dir>/.impulso-pi-manifest.tsv`, keyed by the `profiles.jsonc` resource key.
Mirrors the prior design (manifest lives in the agentDir), just scoped per
profile (or per `--base`).

## CI

- `check:json` extended to validate `profiles.jsonc` via the JSONC stripper.
- New check: every resource key in `profiles.jsonc` exists on disk (or is a
  known `npm:` spec); every profile is a defined tag; every group references
  defined profiles.
- `shellcheck` on updated `install.sh`; install smoke test extended to a
  profile target.

## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi`
```

## Prerequisites

```bash
npm install -g pi-profiles   # provides `ppi`
```
