#!/usr/bin/env bash
#
# Build & run helper for clinic-saas.
#
# Usage:
#   ./scripts/run.sh <command>
#
# Commands:
#   setup      Install dependencies (npm install)
#   env        Create .env.local from the example if missing
#   check      Typecheck + lint + tests (CI-style gate)
#   test       Run the test suite once
#   dev        Start the dev server (foreground; Ctrl+C to stop)
#   build      Production build
#   start      Run the production server (needs `build` first)
#   seed       Seed the demo clinic (needs Supabase creds in .env.local)
#   verify     Full local gate: setup -> check -> build
#   help       Show this help
#
set -euo pipefail

# Always operate from the project root (parent of this script's dir).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

log()  { printf '\033[1;36m[run]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[run]\033[0m %s\n' "$*" >&2; exit 1; }

require_node() {
  command -v node >/dev/null 2>&1 || die "node not found on PATH"
  command -v npm  >/dev/null 2>&1 || die "npm not found on PATH"
}

require_deps() {
  if [ ! -d node_modules ]; then
    warn "node_modules missing — running setup first"
    cmd_setup
  fi
}

# .env.local must exist AND carry the two required Supabase vars.
require_env() {
  [ -f .env.local ] || die ".env.local not found — run './scripts/run.sh env' and fill it in"
  local missing=0
  for key in NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    if ! grep -qE "^\s*${key}\s*=\s*.+" .env.local; then
      warn "missing ${key} in .env.local"
      missing=1
    fi
  done
  [ "${missing}" -eq 0 ] || die "fill the required vars in .env.local first"
}

cmd_setup() { require_node; log "installing dependencies..."; npm install; }

cmd_env() {
  if [ -f .env.local ]; then
    log ".env.local already exists — leaving it untouched"
  else
    cp .env.local.example .env.local
    log "created .env.local from example — fill in your values"
  fi
}

cmd_check() {
  require_deps
  log "typecheck..."; npm run typecheck
  log "lint...";      npm run lint || warn "lint reported issues"
  log "tests...";     npm run test
  log "check passed"
}

cmd_test()  { require_deps; npm run test; }

cmd_dev() {
  require_deps
  [ -f .env.local ] || warn "no .env.local — the app will fail at runtime without Supabase creds"
  log "starting dev server (Ctrl+C to stop)..."
  npm run dev
}

cmd_build() { require_deps; log "production build..."; npm run build; }

cmd_start() {
  require_deps
  [ -d .next ] || die "no build found — run './scripts/run.sh build' first"
  log "starting production server..."
  npm run start
}

cmd_seed() {
  require_deps
  require_env
  log "seeding demo clinic..."
  npm run seed
}

cmd_verify() {
  cmd_setup
  cmd_check
  cmd_build
  log "verify complete — ready to run"
}

cmd_help() {
  # Print the leading comment block (usage/commands), stripping the
  # leading '#'. Stops at the first non-comment line.
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' \
    "${BASH_SOURCE[0]}"
}

main() {
  local command="${1:-help}"
  case "${command}" in
    setup)  cmd_setup ;;
    env)    cmd_env ;;
    check)  cmd_check ;;
    test)   cmd_test ;;
    dev)    cmd_dev ;;
    build)  cmd_build ;;
    start)  cmd_start ;;
    seed)   cmd_seed ;;
    verify) cmd_verify ;;
    help|-h|--help) cmd_help ;;
    *) die "unknown command: ${command} (try 'help')" ;;
  esac
}

main "$@"
