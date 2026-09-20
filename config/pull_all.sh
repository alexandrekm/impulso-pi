#!/usr/bin/env bash
# pull_all — update every submodule of the current work tree in parallel,
# then refresh the zvec-grep base indexes and push the updated submodule
# pointers.
#
# Versioned in impulso-pi (config/pull_all.sh) and synced by install.sh to
# the pi root (~/.pi/pull_all.sh, a piRootDest resource) — run it from
# inside the checkout; it operates on the current work tree's toplevel, so
# the repo-tracked copies (~/code/mtv/*/pull_all.sh) and the pi-root copy
# behave identically. scripts/utils/check-script-drift.sh flags drift.
#
# The reindex targets the SUBMODULE repos — the bases that worktree seeding
# and the umbrella fan-out rely on — and NEVER the umbrella root itself:
# zg cannot index nested repos, and an ancestor index there locks out every
# repo below it (nearest-ancestor resolution). Reindexes run sequentially:
# each zg process loads the local embedding model.
#
# No .gitmodules (plain repo) → the submodule loop is skipped, the pointer
# commit step still runs.

set -euo pipefail

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "pull_all: not inside a git work tree — run it from the checkout" >&2
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"

# Submodule paths — empty (and non-fatal) when there is no .gitmodules.
dirs=()
while IFS= read -r dir; do
  [[ -n "$dir" ]] && dirs+=("$dir")
done < <(git config --file .gitmodules --get-regexp path 2>/dev/null | awk '{print $2}')

if [[ ${#dirs[@]} -gt 0 ]]; then
  LOG_DIR=$(mktemp -d)
  pids=()

  for dir in "${dirs[@]}"; do
    (
      cd "$dir"
      default_branch=$(git remote show origin | awk '/HEAD branch/ {print $NF}')
      git checkout "$default_branch"
      git pull
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
  echo "All submodules updated."

  # Refresh the zvec-grep BASE indexes in each submodule checkout (never
  # the umbrella root — see the header). Sequential: each zg process loads
  # the local embedding model.
  if command -v zg &>/dev/null; then
    reindexed=0
    for dir in "${dirs[@]}"; do
      if (cd "$dir" && zg index --embedding local/potion-code-16m-v2 >/dev/null 2>&1); then
        reindexed=$((reindexed + 1))
      else
        echo "WARN: zvec reindex failed for $dir" >&2
      fi
    done
    echo "zvec-grep base indexes updated ($reindexed/${#dirs[@]})."
  else
    echo "zg not installed — skipping the zvec-grep reindex."
  fi

  # Stage updated submodule pointers (ignoreSubmodules affects display only)
  git add "${dirs[@]}"
else
  echo "No submodules — nothing to pull."
fi

if git diff --cached --quiet; then
  echo "No submodule pointer changes — nothing to commit."
else
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  git commit -m "chore: update submodule pointers"
  git push origin "$current_branch"
  echo "Pushed updated submodule pointers to origin."
fi
