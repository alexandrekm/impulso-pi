#!/usr/bin/env bash
# migrate-pi-official — move an existing `pi` install out of Homebrew's world
# into a fully user-owned managed install (official pi.dev installer,
# releases-v1 layout).
#
# Why: with Homebrew's node, `npm install -g` lands in a prefix Homebrew owns
# (/opt/homebrew/lib/node_modules/ on Apple Silicon, /usr/local on Intel), so
# pi "lives in brew's world" even though it was never a brew formula. The
# managed layout instead stages every release under ~/.pi/agent/install/
# releases/<version>/, puts the launcher at ~/.pi/agent/bin/ and a `pi`
# symlink in ~/.local/bin — nothing in Homebrew's prefix, old releases stay
# staged (which is what makes the install.sh version pin instant: switching
# versions is a current-version flip, no download).
#
# What it detects and does (default: report only; --apply to act):
#
#   pi on PATH resolves to ~/.pi/agent/bin/pi (or any managed releases/
#   layout)          → already managed, nothing to do
#   .../lib/node_modules/@earendil-works/...  → npm-global install (any
#                      prefix): --apply uninstalls it and runs the official
#                      installer's managed mode
#   .../Cellar/...    → an actual Homebrew formula: --apply brew-uninstalls
#                      it, then the same official managed install
#   no pi on PATH     → nothing to migrate: plain ./install.sh already
#                      installs pi via the official npm command
#   anything else     → refuses (unknown install method — migrate by hand)
#
# Usage:
#   scripts/utils/migrate-pi-official.sh           # report what it found
#   scripts/utils/migrate-pi-official.sh --apply   # do the migration
#
# The official installer is fetched fresh from https://pi.dev/install.sh and
# run with PI_CODING_AGENT_DIR stripped and PI_EXPERIMENTAL=1: a pi session
# exports PI_CODING_AGENT_DIR, which would misdirect the managed install into
# the active profile dir — so this script is safe to run from inside pi.
# Live pi sessions keep running during the migration; restart them after.
# Then re-run ./install.sh <target> to resync (it picks up the new location
# with its detect-first logic and offers any package updates).
#
# See AGENTS.md → Prerequisites → "Migrating a machine off a Homebrew-prefix
# pi" for the background.

set -euo pipefail

PI_PACKAGE="@earendil-works/pi-coding-agent"
INSTALLER_URL="https://pi.dev/install.sh"
APPLY=0

usage() {
  sed -n '/^# Usage:/,/^# See/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    -h | --help) usage 0 ;;
    *) usage 1 ;;
  esac
  shift
done

# realpath that works on macOS (no GNU readlink -f): python3 is everywhere
# we run. Falls back to the raw path when python3 is unavailable.
realpath_of() {
  local p="${1:?}"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$p"
  else
    printf '%s\n' "$p"
  fi
}

die() {
  printf 'migrate-pi-official: %s\n' "$*" >&2
  exit 1
}

# ── detect ───────────────────────────────────────────────────────────────────

if ! command -v pi >/dev/null 2>&1; then
  echo "No 'pi' on PATH — nothing to migrate."
  echo "A fresh machine doesn't need this script: plain ./install.sh installs"
  echo "pi via the official npm command when it's missing."
  exit 0
fi

PI_BIN="$(command -v pi)"
PI_REAL="$(realpath_of "$PI_BIN")"

managed_marker_for() {
  # Launcher lives at <agentDir>/bin/pi → marker at <agentDir>/install/.
  local agent_dir
  agent_dir="$(dirname "$(dirname "$1")")"
  printf '%s\n' "$agent_dir/install/managed-install.json"
}

if [[ -f "$(managed_marker_for "$PI_REAL")" ]] ||
  [[ "$PI_REAL" =~ /install/releases/[^/]+/node_modules/\.bin/pi$ ]]; then
  echo "pi is already a managed install:"
  echo "  on PATH:   $PI_BIN"
  echo "  resolves:  $PI_REAL"
  pi --version || true
  echo "Nothing to do."
  exit 0
fi

if [[ "$PI_REAL" == */Cellar/* ]]; then
  KIND="brew-formula"
  echo "Found an actual Homebrew formula install:"
elif [[ "$PI_REAL" == */lib/node_modules/$PI_PACKAGE/* ]]; then
  KIND="npm-global"
  echo "Found an npm-global install in a Homebrew-owned prefix:"
else
  echo "pi resolves to an unknown install method:"
  echo "  on PATH:   $PI_BIN"
  echo "  resolves:  $PI_REAL"
  echo "This script only migrates npm-global (*/lib/node_modules/) and brew"
  echo "formula (*/Cellar/) installs — migrate by hand per AGENTS.md."
  exit 1
fi

echo "  on PATH:   $PI_BIN"
echo "  resolves:  $PI_REAL"
pi --version || true
echo
if [[ "$APPLY" -eq 0 ]]; then
  echo "Dry run (pass --apply to migrate): would"
  case "$KIND" in
    brew-formula) echo "  1. brew-uninstall the formula" ;;
    npm-global) echo "  1. npm uninstall -g $PI_PACKAGE" ;;
  esac
  echo "  2. fetch $INSTALLER_URL and run it with PI_CODING_AGENT_DIR"
  echo "     stripped and PI_EXPERIMENTAL=1 (managed, user-owned layout)"
  echo "  3. verify pi resolves under ~/.local/bin and prints a version"
  echo "  4. remind you to restart pi sessions and re-run ./install.sh"
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────

command -v npm >/dev/null 2>&1 || die "npm not found on PATH"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

case "$KIND" in
  brew-formula)
    FORMULA="$(brew list --formula 2>/dev/null | grep -ix 'pi\|pi-coding-agent' || true)"
    [[ -n "$FORMULA" ]] || die "could not identify the brew formula for $PI_REAL — uninstall it by hand, then re-run"
    echo "==> brew uninstall $FORMULA"
    brew uninstall "$FORMULA"
    ;;
  npm-global)
    echo "==> npm uninstall -g $PI_PACKAGE"
    npm uninstall -g "$PI_PACKAGE"
    ;;
esac

INSTALLER="$(mktemp "${TMPDIR:-/tmp}/pi-official-install.XXXXXX")"
trap 'rm -f "$INSTALLER"' EXIT
echo "==> fetching $INSTALLER_URL"
curl -fsSL "$INSTALLER_URL" -o "$INSTALLER" || die "failed to download the official installer"
echo "==> running the official installer (managed mode, PI_CODING_AGENT_DIR stripped)"
# env -u: safe to run from inside a pi session (it exports PI_CODING_AGENT_DIR,
# which would misdirect the managed install into the active profile dir).
if ! env -u PI_CODING_AGENT_DIR PI_EXPERIMENTAL=1 sh "$INSTALLER"; then
  die "official installer failed — pi may be uninstalled now; re-run this script or ./install.sh to recover"
fi

hash -r 2>/dev/null || true
NEW_BIN="$(command -v pi || true)"
if [[ -z "$NEW_BIN" ]]; then
  echo "WARNING: no 'pi' on PATH after the migration." >&2
  echo "The managed install symlinks into ~/.local/bin — is that on PATH?" >&2
  echo "Restart your shell, then re-run ./install.sh." >&2
  exit 1
fi
NEW_REAL="$(realpath_of "$NEW_BIN")"
if [[ ! -f "$(managed_marker_for "$NEW_REAL")" ]]; then
  echo "WARNING: pi still resolves to a non-managed install: $NEW_REAL" >&2
  echo "Check what shadowed it (PATH order) and re-run." >&2
  exit 1
fi

echo "==> migration complete:"
echo "    on PATH:   $NEW_BIN"
echo "    resolves:  $NEW_REAL"
pi --version
echo
echo "Restart your pi sessions, then re-run ./install.sh <target> to resync"
echo "(it will pick up the new location and offer any package updates)."
