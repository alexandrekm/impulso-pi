#!/usr/bin/env bash
# Installs impulso-pi customizations into the local pi agent directory
# (~/.pi/agent by default, override with PI_AGENT_DIR).
#
# Idempotent: safe to re-run after pulling updates from this repo.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="$AGENT_DIR/extensions"
SKILLS_DIR="$AGENT_DIR/skills"

echo "impulso-pi installer"
echo "  repo:  $REPO_DIR"
echo "  agent: $AGENT_DIR"
echo

if ! command -v pi >/dev/null 2>&1; then
  echo "error: 'pi' CLI not found on PATH. Install pi first: https://pi.dev" >&2
  exit 1
fi

mkdir -p "$EXT_DIR" "$SKILLS_DIR"

# --- third-party packages this repo depends on -----------------------------
echo "==> Ensuring required pi packages are installed"
pi install npm:pi-footer

# --- extensions --------------------------------------------------------------
# Every extensions/<feature>/*.ts and *.json file is copied flat into
# ~/.pi/agent/extensions/ (pi's extension discovery does not recurse into
# subdirectories without an index.ts, and pi-footer's config file must live
# directly in the extensions dir).
echo "==> Installing extensions"
if [ -d "$REPO_DIR/extensions" ]; then
  find "$REPO_DIR/extensions" -mindepth 1 -maxdepth 2 \( -name "*.ts" -o -name "*.json" \) | while read -r src; do
    dest="$EXT_DIR/$(basename "$src")"
    cp "$src" "$dest"
    echo "  $(basename "$src") -> $dest"
  done
fi

# --- skills ------------------------------------------------------------------
echo "==> Installing skills"
if [ -d "$REPO_DIR/skills" ]; then
  find "$REPO_DIR/skills" -mindepth 1 -maxdepth 1 -type d | while read -r src; do
    dest="$SKILLS_DIR/$(basename "$src")"
    rm -rf "$dest"
    cp -R "$src" "$dest"
    echo "  $(basename "$src") -> $dest"
  done
fi

echo
echo "Done. Reload pi (/reload) or start a new session to pick up changes."
