#!/usr/bin/env bash
# setup_worktree — initialize a git worktree for daily work: parallel
# submodule init/update/reset, nested-submodule recursion, and direnv/
# pre-commit hooks.
#
# Versioned in impulso-pi (config/setup_worktree.sh) and synced by install.sh
# to <profile>/bin/setup_worktree.sh — pi puts that dir at the front of the
# shell PATH, so this is invocable as `setup_worktree` from any session. It
# operates on the CURRENT work tree (cd's to its toplevel), so a repo-tracked
# copy (e.g. ~/code/mtv/mtv-inference/setup_worktree.sh) and the PATH copy
# behave identically; keep them in sync.
#
# Smart about shape:
#   - no .gitmodules / no submodules → submodule steps are skipped, the rest
#     still runs (skill linking over nothing, WORKTREE_READY marker)
#   - submodule branch configurable via SETUP_WORKTREE_BRANCH (default: master)
#   - zvec-grep: nothing to do here — pi-zvec-grep's autoIndex seeds worktree
#     indexes from the main checkout's bases at the first session start (with
#     the manifest rootPaths rewrite + background update). Hand-copying
#     .zvec-grep from the parent is harmful: without the rewrite the copy is
#     a frozen snapshot of the main, and an umbrella-root stub would shadow
#     every submodule index in the worktree. Bases live at
#     <main>/<submodule>/.zvec-grep (reindexed after pulls), never at the
#     superproject root.
#
# Re-run by deleting WORKTREE_READY in the worktree root.

set -euo pipefail

MAIN_BRANCH="${SETUP_WORKTREE_BRANCH:-master}"

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "setup_worktree: not inside a git work tree — run it from the worktree" >&2
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"
ROOT="$(pwd -P)"
READY_FILE="$ROOT/WORKTREE_READY"

if [[ -f "$READY_FILE" ]]; then
  echo "Worktree already set up. Remove $READY_FILE to re-run."
  exit 0
fi

# Submodule paths — empty (and non-fatal) when there is no .gitmodules.
# while/read instead of mapfile: macOS system bash (3.2) has no mapfile.
dirs=()
while IFS= read -r dir; do
  [[ -n "$dir" ]] && dirs+=("$dir")
done < <(git config --file .gitmodules --get-regexp path 2>/dev/null | awk '{print $2}')

if [[ ${#dirs[@]} -gt 0 ]]; then
  LOG_DIR=$(mktemp -d)
  pids=()

  for dir in "${dirs[@]}"; do
    (
      git submodule update --init "$dir"
      cd "$dir"
      git submodule update --init
      git fetch origin "$MAIN_BRANCH"
      git checkout "$MAIN_BRANCH"
      git reset --hard "origin/$MAIN_BRANCH"
      if [[ -f .envrc ]] && command -v direnv &>/dev/null; then
        direnv allow
      elif [[ -f .pre-commit-config.yaml ]]; then
        pre-commit install
      fi
    ) > "$LOG_DIR/$dir.log" 2>&1 &
    pids+=($!)
  done

  failed=()
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "OK: ${dirs[$i]}"
    else
      echo "FAIL: ${dirs[$i]}"
      failed+=("${dirs[$i]}")
    fi
  done

  if [[ ${#failed[@]} -gt 0 ]]; then
    echo ""
    echo "=== ERRORS ==="
    for dir in "${failed[@]}"; do
      echo "--- $dir ---"
      cat "$LOG_DIR/$dir.log"
      echo ""
    done
    rm -rf "$LOG_DIR"
    exit 1
  fi

  rm -rf "$LOG_DIR"
else
  echo "No submodules — skipping submodule setup."
fi

touch "$READY_FILE"
echo "WORKTREE_READY"
