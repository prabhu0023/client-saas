#!/usr/bin/env bash
#
# build.sh — production build for clinic-saas
#
# Steps:
#   1. Verify Node >= 20 and dependencies are installed
#   2. Type-check (tsc --noEmit)
#   3. Lint
#   4. Run tests
#   5. Next.js production build
#
# Usage:
#   ./scripts/build.sh            # full build with all checks
#   ./scripts/build.sh --fast     # skip lint + tests, build only
#   SKIP_TESTS=1 ./scripts/build.sh

set -euo pipefail

# Resolve repo root (parent of this script's dir) regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }

# --- Node version check --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not on PATH." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node >= 20 required (found $(node -v))." >&2
  exit 1
fi

# --- Dependencies --------------------------------------------------------
if [ ! -d node_modules ]; then
  log "Installing dependencies (npm ci)"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
fi

# --- Checks --------------------------------------------------------------
log "Type-checking"
npm run typecheck

if [ "$FAST" -eq 0 ]; then
  log "Linting"
  npm run lint

  if [ "${SKIP_TESTS:-0}" != "1" ]; then
    log "Running tests"
    npm run test
  else
    log "Skipping tests (SKIP_TESTS=1)"
  fi
else
  log "Fast mode: skipping lint and tests"
fi

# --- Build ---------------------------------------------------------------
log "Building (next build)"
npm run build

log "Build complete."
