#!/usr/bin/env bash
#
# start.sh — start clinic-saas
#
# Pairs with build.sh. Verifies env, ensures a production build exists
# (builds if missing), then starts the server. Use --dev for the hot-
# reload dev server instead of the production server.
#
# Usage:
#   ./scripts/start.sh              # production: build if needed, then `next start`
#   ./scripts/start.sh --dev        # development: `next dev` (hot reload)
#   ./scripts/start.sh --rebuild    # force a fresh production build first
#   PORT=4000 ./scripts/start.sh    # override the port (default 3000)

set -euo pipefail

# Resolve repo root (parent of this script's dir) regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

MODE="prod"
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --rebuild) REBUILD=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$1" >&2; }

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
  log "Installing dependencies"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

# --- Env check -----------------------------------------------------------
# Runtime needs Supabase; warn loudly rather than hard-fail so the server
# can still boot for a static page / health check during setup.
if [ ! -f .env.local ]; then
  warn "no .env.local found — copy .env.local.example and fill it in, or the app will fail at runtime"
else
  for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
    if ! grep -qE "^\s*${key}\s*=\s*.+" .env.local; then
      warn "missing ${key} in .env.local — runtime will fail without it"
    fi
  done
fi

PORT="${PORT:-3000}"

# --- Development mode ----------------------------------------------------
if [ "$MODE" = "dev" ]; then
  log "Starting dev server on port ${PORT} (Ctrl+C to stop)"
  exec npm run dev -- --port "${PORT}"
fi

# --- Production mode -----------------------------------------------------
if [ "$REBUILD" -eq 1 ] || [ ! -d .next ]; then
  if [ "$REBUILD" -eq 1 ]; then
    log "Rebuilding (forced)"
  else
    log "No build found — building first"
  fi
  ./scripts/build.sh
fi

log "Starting production server on port ${PORT}"
exec npm run start -- --port "${PORT}"
