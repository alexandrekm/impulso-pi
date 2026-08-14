#!/usr/bin/env bash
# Link shared-but-ignored dirs (e.g. reference-impl/) from the main worktree
# into the current worktree. Git worktrees only check out tracked files, so
# anything gitignored is left behind — this restores the shared copies via
# symlinks so they're present without being committed or duplicated on disk.
#
# Idempotent and safe:
#   - main worktree: no-op (the canonical copy already lives there)
#   - linked worktree missing the dir: creates a symlink to the main copy
#   - symlink already pointing at the right place: no-op
#   - real dir/file already present (user's own copy): left alone, warns
#
# Intended to be called from .envrc (direnv) so entering any worktree
# auto-links, but can also be run on demand: `./scripts/link-shared.sh`.
#
# To share more ignored dirs, add their top-level names to SHARED_DIRS below.

set -euo pipefail

# Top-level gitignored dirs that should be shared across worktrees.
SHARED_DIRS=(reference-impl)

# Resolve the main worktree root: parent dir of the shared .git common dir.
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || {
  echo "link-shared: not inside a git worktree/repo; skipping" >&2
  exit 0
}
main_root="$(cd "$(dirname "$common_dir")" && pwd)" # .../repo/.git -> .../repo

# Determine the current worktree's own root.
top_root="$(git rev-parse --show-toplevel 2>/dev/null)" || top_root="$PWD"

# `readlink -f` needs GNU coreutils on macOS; fall back to the slow-but-portable
# python resolver. Resolves to an absolute, symlink-free canonical path.
canon_path() {
  if readlink -f "$1" >/dev/null 2>&1; then
    readlink -f "$1"
  else
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
  fi
}

in_main=0
if [ "$(canon_path "$top_root")" = "$(canon_path "$main_root")" ]; then
  in_main=1
fi

for name in "${SHARED_DIRS[@]}"; do
  source="$main_root/$name"
  target="$top_root/$name"

  # Canonical location; nothing to link.
  if [ "$in_main" -eq 1 ]; then
    continue
  fi

  # No canonical copy to link from — skip silently (AGENTS.md tells agents
  # to ask the user to clone it).
  if [ ! -e "$source" ]; then
    continue
  fi

  # Missing here: create the symlink.
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    ln -s "$source" "$target"
    rel="$(cd "$top_root" && python3 -c 'import os,sys; print(os.path.relpath(os.path.realpath(sys.argv[1])))' "$target")"
    echo "link-shared: linked $name -> $rel"
    continue
  fi

  # Already a symlink: check where it points.
  if [ -L "$target" ]; then
    resolved="$(readlink "$target")"
    # readlink may be relative; resolve it against the target's directory.
    case "$resolved" in
      /*) real="$resolved" ;;
      *) real="$(cd "$(dirname "$target")" && cd "$(dirname "$resolved")" && pwd)/$(basename "$resolved")" ;;
    esac
    if [ "$(canon_path "$real")" = "$(canon_path "$source")" ]; then
      # Already correctly linked.
      continue
    fi
    echo "link-shared: $name is a symlink but points elsewhere ($resolved); leaving as-is" >&2
    continue
  fi

  # A real dir/file the user placed there — never clobber.
  if [ -d "$target" ]; then
    echo "link-shared: $name exists as a real directory; leaving as-is (remove it to re-link)" >&2
  else
    echo "link-shared: $name exists as a real file; leaving as-is (remove it to re-link)" >&2
  fi
done
