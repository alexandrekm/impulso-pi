#!/usr/bin/env bash
# check-script-drift — flag machine copies of the versioned workflow scripts
# that differ from the reference versions in this repo.
#
# Several scripts exist in two worlds: the canonical copy versioned here
# (config/<name>.sh, installed at the pi root by install.sh --base via
# piRootDest) and repo-tracked copies in the umbrella checkouts on this
# machine (~/code/mtv/*/…). Copies drift — a fix lands here, someone pulls
# only one repo, another repo keeps the old version (that is exactly how
# five of six setup_worktree.sh copies ended up stale, one of them still
# hand-copying .zvec-grep into worktrees).
#
# This script finds every copy and compares it against the reference:
#   IN SYNC   identical to the reference
#   DRIFTED   differs — copy the reference over it (see the fix hint)
#   MISSING   expected copy not found (e.g. ~/.pi/<name>: run install.sh --base)
#
# Read-only by design — it never modifies anything. Exit 1 when any copy is
# drifted or missing, so it can run as a reminder in any flow.
#
# Usage:
#   scripts/utils/check-script-drift.sh [--root DIR]... [--script NAME]...
#
#   --root DIR     search root for repo-tracked copies (default: ~/code/mtv;
#                  repeatable). The pi root (~/.pi) is always checked.
#   --script NAME  script basename to check (repeatable; default:
#                  setup_worktree.sh pull_all.sh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PI_ROOT="${PPI_PI_ROOT:-$HOME/.pi}"

ROOTS=("$PI_ROOT" "$HOME/code/mtv")
SCRIPTS=(setup_worktree.sh pull_all.sh)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOTS+=("${2:?--root needs a value}"); shift ;;
    # --script scopes the check: the first use replaces the default list
    --script)
      if [[ -z "${SCRIPTS_EXPLICIT:-}" ]]; then SCRIPTS=(); SCRIPTS_EXPLICIT=1; fi
      SCRIPTS+=("${2:?--script needs a value}")
      shift
      ;;
    -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

drifted=0
missing=0
checked=0

# One report line per copy of one script.
report() { # status reference copy
  local status=$1 ref=$2 copy=$3
  checked=$((checked + 1))
  case "$status" in
    in-sync) echo "IN SYNC: $copy" ;;
    drifted)
      drifted=$((drifted + 1))
      echo "DRIFTED: $copy  (reference: $ref)" ;;
    missing)
      missing=$((missing + 1))
      echo "MISSING: $copy  (reference: $ref)" ;;
  esac
}

for name in "${SCRIPTS[@]}"; do
  ref="$REPO_DIR/config/$name"
  if [[ ! -f "$ref" ]]; then
    echo "no reference for '$name' in config/ — skipping" >&2
    continue
  fi

  # the pi-root copy is expected (installed by install.sh --base)
  if [[ -f "$PI_ROOT/$name" ]]; then
    if cmp -s "$ref" "$PI_ROOT/$name"; then report in-sync "$ref" "$PI_ROOT/$name"; else report drifted "$ref" "$PI_ROOT/$name"; fi
  else
    report missing "$ref" "$PI_ROOT/$name"
  fi

  # repo-tracked copies under each search root (the search roots themselves
  # and their immediate children — the umbrella-checkout layout)
  shopt -s nullglob
  for root in "${ROOTS[@]}"; do
    [[ "$root" == "$PI_ROOT" ]] && continue
    for copy in "$root/$name" "$root"/*/"$name"; do
      [[ -f "$copy" ]] || continue
      if cmp -s "$ref" "$copy"; then report in-sync "$ref" "$copy"; else report drifted "$ref" "$copy"; fi
    done
  done
  shopt -u nullglob
done

echo ""
if ((drifted > 0 || missing > 0)); then
  echo "drift found: $drifted drifted, $missing missing ($checked copies checked)."
  echo "fix: install.sh --base (refreshes the pi-root copies), then copy the"
  echo "     reference over each drifted repo copy — e.g."
  echo "     cp \"$PI_ROOT/<script-name>\" <repo-dir>/"
  exit 1
fi
echo "no drift: all $checked copies match the references."
