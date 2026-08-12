#!/usr/bin/env bash
# Thin shim — the real installer is scripts/install.mjs (Node, zero deps).
# Kept as install.sh so existing muscle memory and CI invocations work.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/install.mjs" "$@"
