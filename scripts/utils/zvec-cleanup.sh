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
#   --network   also drop indexes on network filesystems (always flagged;
#               deletion is opt-in via this flag)
#   --depth N   find depth per root (default: 6)
#   root ...    roots to scan (default: $HOME)
#
# Dropped worktrees re-seed automatically on their next session (autoIndex).
# Run once per machine after pulling the zvec changes.

set -euo pipefail

APPLY=0
# Also drop indexes on network filesystems (NFS/SMB/sshfs/…). They are
# always FLAGGED; deletion additionally requires this flag — a network
# mount may hold the only copy of something, so it is opt-in.
DROP_NETWORK=0
# Default depth 6 covers the Orca worktree layout, where the interesting
# indexes live deep: ~/orca/workspaces/<repo>/<worktree>/.zvec-grep (5) and
# its submodule fan-out indexes (6). Depth 4 would miss exactly the frozen
# worktree copies this sweep exists for.
DEPTH=6
ROOTS=()
NESTED_REPOS=3

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --network) DROP_NETWORK=1 ;;
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

# ---- network-filesystem detection (mirrors the netfs rule in the fork) ----
# The mount table is parsed once into point<TAB>type lines, longest-prefix
# match against the (realpathed) index root. Fail-open: an unparseable
# mount table simply flags nothing.

MOUNT_TABLE="$(mktemp)"
trap 'rm -f "$MOUNT_TABLE"' EXIT
# regexes in variables: bash's [[ =~ ]] tokenizer chokes on parens in
# inline patterns (the ) inside the character class ends the conditional)
RE_LINUX_MOUNT='^(.+) on (.+) type ([^[:space:]]+) \('
RE_MACOS_MOUNT='^(.+) on (.+) \(([a-zA-Z][[:alnum:]._-]*)[,)]'
while IFS= read -r line; do
  # util-linux mount(8): `<dev> on <point> type <fstype> (<opts>)`
  if [[ "$line" =~ $RE_LINUX_MOUNT ]]; then
    printf '%s\t%s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  # macOS mount(8): `<dev> on <point> (<fstype>, <opts>…)` — type may be alone
  elif [[ "$line" =~ $RE_MACOS_MOUNT ]]; then
    printf '%s\t%s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  fi
done < <(mount 2>/dev/null) >"$MOUNT_TABLE"

is_network_type() {
  case "$1" in
    nfs | nfs4 | nfs5 | cifs | smbfs | smbfs2 | sshfs | fuse.sshfs | afpfs | davfs | davfs2 | webdav | 9p | ncpfs | afs | ceph | cephfs | fuse.ceph | lustre | glusterfs | gpfs | vboxsf | vmhgfs | prl_fs | nts) return 0 ;;
    *) return 1 ;;
  esac
}

mount_type_for() {
  local target=$1 best_pt='' best_ty='' pt ty
  while IFS=$'\t' read -r pt ty; do
    if [[ "$target" == "$pt" || "$target" == "$pt"/* ]]; then
      if ((${#pt} > ${#best_pt})); then best_pt=$pt; best_ty=$ty; fi
    fi
  done <"$MOUNT_TABLE"
  # always exit 0: callers run under set -e, and an unmatched target is a
  # normal outcome (fail open), not an error
  [[ -n "$best_pt" ]] && echo "$best_ty"
  return 0
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
    # network-fs indexes: always flagged; dropped only with --network
    nettype="$(mount_type_for "$parent")"
    if [[ -n "$nettype" ]] && is_network_type "$nettype"; then
      if [[ $DROP_NETWORK -eq 1 ]]; then
        verdict="drop:network filesystem ($nettype)"
      else
        echo "FLAGGED (network fs: $nettype — drop with --network): $idx"
        continue
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
