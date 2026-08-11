#!/usr/bin/env bash
# Syncs impulso-pi customizations between this repo and the local pi agent
# directory (~/.pi/agent by default, override with PI_AGENT_DIR).
#
# Tracks a hash of each file as of its last sync in
# $AGENT_DIR/.impulso-pi-manifest.tsv, so "install" never clobbers local
# edits you made directly in ~/.pi/agent (e.g. via `/footer`) — it only
# fast-forwards files that are unchanged since the last sync. Use "pull" to
# explicitly promote local edits back into the repo.
#
# Usage:
#   ./install.sh [install]   repo -> agent (default; skips locally modified files)
#   ./install.sh status      show per-file sync state, no changes made
#   ./install.sh pull        agent -> repo (promote local edits to upstream)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
MANIFEST="$AGENT_DIR/.impulso-pi-manifest.tsv"
CMD="${1:-install}"

hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
hash_dir() {
  # Deterministic hash of a directory's contents (order-independent).
  find "$1" -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'
}
hash_of() { [ -d "$1" ] && hash_dir "$1" || hash_file "$1"; }

manifest_get() {
  # $1 = repoPath
  [ -f "$MANIFEST" ] || return 0
  awk -F'\t' -v k="$1" '$2 == k {print $1}' "$MANIFEST" | tail -n1
}

manifest_set() {
  # $1 = hash, $2 = repoPath, $3 = localPath
  local tmp
  tmp="$(mktemp)"
  [ -f "$MANIFEST" ] && awk -F'\t' -v k="$2" '$2 != k' "$MANIFEST" > "$tmp" || true
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$tmp"
  mkdir -p "$(dirname "$MANIFEST")"
  mv "$tmp" "$MANIFEST"
}

copy_entry() {
  # $1 = src, $2 = dest
  if [ -d "$1" ]; then
    rm -rf "$2"
    cp -R "$1" "$2"
  else
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
  fi
}

# Populate two parallel arrays: REPO_PATHS (abs) and LOCAL_PATHS (abs),
# covering every tracked entry (extensions/<feature>/*.{ts,json} files,
# skills/<name>/ directories).
REPO_PATHS=()
LOCAL_PATHS=()

if [ -d "$REPO_DIR/extensions" ]; then
  while IFS= read -r src; do
    REPO_PATHS+=("$src")
    LOCAL_PATHS+=("$AGENT_DIR/extensions/$(basename "$src")")
  done < <(find "$REPO_DIR/extensions" -mindepth 1 -maxdepth 2 \( -name "*.ts" -o -name "*.json" \) | LC_ALL=C sort)
fi

if [ -d "$REPO_DIR/skills" ]; then
  while IFS= read -r src; do
    REPO_PATHS+=("$src")
    LOCAL_PATHS+=("$AGENT_DIR/skills/$(basename "$src")")
  done < <(find "$REPO_DIR/skills" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
fi

relpath() { echo "${1#"$REPO_DIR"/}"; }

do_status() {
  printf '%-45s %s\n' "FILE" "STATE"
  for i in "${!REPO_PATHS[@]}"; do
    local repo="${REPO_PATHS[$i]}" local="${LOCAL_PATHS[$i]}"
    local rp; rp="$(relpath "$repo")"
    local repoHash; repoHash="$(hash_of "$repo")"
    if [ ! -e "$local" ]; then
      printf '%-45s %s\n' "$rp" "new (not installed)"
      continue
    fi
    local localHash; localHash="$(hash_of "$local")"
    local lastHash; lastHash="$(manifest_get "$rp")"
    if [ "$localHash" = "$repoHash" ]; then
      printf '%-45s %s\n' "$rp" "in sync"
    elif [ "$lastHash" = "$localHash" ]; then
      printf '%-45s %s\n' "$rp" "upstream updated (safe to install)"
    elif [ "$lastHash" = "$repoHash" ]; then
      printf '%-45s %s\n' "$rp" "locally modified (run 'pull' to promote)"
    else
      printf '%-45s %s\n' "$rp" "CONFLICT (both changed independently)"
    fi
  done
}

do_install() {
  echo "==> Ensuring required pi packages are installed"
  pi install npm:pi-footer

  echo "==> Syncing repo -> $AGENT_DIR"
  mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills"
  for i in "${!REPO_PATHS[@]}"; do
    local repo="${REPO_PATHS[$i]}" local="${LOCAL_PATHS[$i]}"
    local rp; rp="$(relpath "$repo")"
    local repoHash; repoHash="$(hash_of "$repo")"

    if [ ! -e "$local" ]; then
      copy_entry "$repo" "$local"
      manifest_set "$repoHash" "$rp" "$local"
      echo "  [new]       $rp"
      continue
    fi

    local localHash; localHash="$(hash_of "$local")"
    local lastHash; lastHash="$(manifest_get "$rp")"

    if [ "$localHash" = "$repoHash" ]; then
      manifest_set "$repoHash" "$rp" "$local"
      echo "  [in sync]   $rp"
    elif [ "$lastHash" = "$localHash" ]; then
      copy_entry "$repo" "$local"
      manifest_set "$repoHash" "$rp" "$local"
      echo "  [updated]   $rp"
    elif [ "$lastHash" = "$repoHash" ]; then
      echo "  [skipped]   $rp (locally modified — run './install.sh pull' to promote, or './install.sh status' for details)"
    else
      echo "  [CONFLICT]  $rp (both repo and local changed since last sync — resolve manually)"
    fi
  done

  echo
  echo "Done. Reload pi (/reload) or start a new session to pick up changes."
}

do_pull() {
  echo "==> Pulling local edits from $AGENT_DIR into repo"
  local pulled=0
  for i in "${!REPO_PATHS[@]}"; do
    local repo="${REPO_PATHS[$i]}" local="${LOCAL_PATHS[$i]}"
    local rp; rp="$(relpath "$repo")"

    [ -e "$local" ] || continue

    local localHash; localHash="$(hash_of "$local")"
    local repoHash; repoHash="$(hash_of "$repo")"
    local lastHash; lastHash="$(manifest_get "$rp")"

    if [ "$localHash" = "$repoHash" ]; then
      continue
    elif [ "$lastHash" = "$repoHash" ] || [ -z "$lastHash" ]; then
      copy_entry "$local" "$repo"
      manifest_set "$localHash" "$rp" "$local"
      echo "  [pulled]    $rp"
      pulled=$((pulled + 1))
    elif [ "$lastHash" = "$localHash" ]; then
      : # local unchanged since last sync, nothing to pull
    else
      echo "  [CONFLICT]  $rp (both repo and local changed since last sync — resolve manually)"
    fi
  done

  echo
  if [ "$pulled" -gt 0 ]; then
    echo "Pulled $pulled file(s). Review with 'git diff' and commit in $REPO_DIR."
  else
    echo "Nothing to pull — no locally-diverged files found."
  fi
}

if ! command -v pi >/dev/null 2>&1 && [ "$CMD" = "install" ]; then
  echo "error: 'pi' CLI not found on PATH. Install pi first: https://pi.dev" >&2
  exit 1
fi

case "$CMD" in
  install) do_install ;;
  status) do_status ;;
  pull) do_pull ;;
  *)
    echo "Usage: $0 [install|status|pull]" >&2
    exit 1
    ;;
esac
