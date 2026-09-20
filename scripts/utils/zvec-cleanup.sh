#!/usr/bin/env bash
# zvec-cleanup — sweep stale zvec-grep indexes under given roots.
#
# Leftover indexes are per-workspace state — install.sh cannot clean them —
# and three kinds are actively harmful (see the zvec notes in AGENTS.md):
#
#   frozen copies   a .zvec-grep hand-copied into a worktree by the OLD
#                   setup_worktree.sh: its manifest still points at the main
#                   checkout, so `zg status` reports "ready" against the
#                   MAIN's unchanged paths and autoIndex never fixes it —
#                   the worktree searches a frozen snapshot forever.
#   umbrella roots  an index at a root holding >= NESTED_REPOS nested git
#                   repos (~/code, ~/code/mtv, an umbrella checkout root):
#                   zg cannot index nested repos, and because zg resolves
#                   the NEAREST ANCESTOR index, one here makes every repo
#                   below it permanently un-indexable.
#   home root       an index at $HOME makes every zg call stat the entire
#                   home tree to compute freshness — minutes of hang.
#
# Healthy indexes (manifest matches their own location, root not an
# umbrella) are left untouched. Residue without a manifest (locks/, models/)
# is reported only — it is inert.
#
# Usage:
#   scripts/utils/zvec-cleanup.sh [--apply] [--depth N] [root ...]
#
#   --apply     actually drop the harmful indexes (default: dry-run report)
#   --depth N   find depth per root (default: 4)
#   root ...    roots to scan (default: $HOME)
#
# Dropped worktrees re-seed automatically on their next session (autoIndex).
# Run once per machine after pulling the zvec changes.

set -euo pipefail

APPLY=0
DEPTH=4
ROOTS=()
NESTED_REPOS=3

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --depth) DEPTH="${2:?--depth needs a value}"; shift ;;
    -h | --help) usage 0 ;;
    -*) echo "unknown flag: $1" >&2; usage 1 ;;
    *) ROOTS+=("$1") ;;
  esac
  shift
done
[[ ${#ROOTS[@]} -gt 0 ]] || ROOTS=("$HOME")

# Count nested git repos at depth <= 2 under a root (mirrors the guard's
# heuristic): a child dir carrying .git counts, else its child dirs are
# checked. Noise dirs are skipped by name; hidden dirs never match */.
count_nested_repos() {
  local dir=$1 count=0 child grandchild
  for child in "$dir"/*/; do
    [[ -e "${child}.git" ]] && count=$((count + 1)) && continue
    for grandchild in "$child"*/; do
      [[ -e "${grandchild}.git" ]] && count=$((count + 1))
    done
  done
  echo "$count"
}

# Classify one index against its workspace root (manifest-based checks in
# node: realpath-safe, no python/jq dependency). Prints keep|drop:<reason>.
classify_index() {
  local manifest=$1 parent=$2
  PARENT="$parent" HOME_ROOT="$HOME" node -e '
    const fs = require("fs"), path = require("path");
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const parent = process.env.PARENT, home = process.env.HOME_ROOT;
    if (real(parent) === real(home)) { console.log("drop:home-rooted index (stats the whole home tree)"); process.exit(0); }
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const roots = (manifest.rootPaths || []).map((r) => r && r.absolutePath).filter(Boolean);
    if (!roots.some((r) => real(r) === real(parent))) {
      console.log("drop:frozen copy (manifest points at " + (roots.join(", ") || "?") + ")");
      process.exit(0);
    }
    console.log("keep");
  ' "$manifest"
}

shopt -s nullglob
found=0
dropped=0

for root in "${ROOTS[@]}"; do
  if [[ ! -d "$root" ]]; then
    echo "skip (not a dir): $root" >&2
    continue
  fi
  while IFS= read -r -d '' idx; do
    found=$((found + 1))
    parent="$(cd "$(dirname "$idx")" && pwd -P)"
    manifest="$idx/manifest.json"

    if [[ ! -f "$manifest" ]]; then
      echo "residue (no manifest), left alone: $idx"
      continue
    fi

    verdict="$(classify_index "$manifest" "$parent")"
    if [[ "$verdict" == keep ]]; then
      nested="$(count_nested_repos "$parent")"
      if [[ "$nested" -ge "$NESTED_REPOS" ]]; then
        verdict="drop:umbrella/container root ($nested nested git repos)"
      fi
    fi

    if [[ "$verdict" == drop:* ]]; then
      reason="${verdict#drop:}"
      if [[ $APPLY -eq 1 ]]; then
        rm -rf "$idx"
        dropped=$((dropped + 1))
        echo "DROPPED: $idx — $reason"
      else
        echo "WOULD DROP (dry run): $idx — $reason"
      fi
    else
      echo "ok: $idx"
    fi
  done < <(find "$root" -maxdepth "$DEPTH" -name .zvec-grep -type d -print0 2>/dev/null)
done

if [[ $APPLY -eq 1 ]]; then
  echo "done: $dropped of $found index(es) dropped"
else
  echo "dry run (rerun with --apply to drop) — $found index(es) checked"
fi
