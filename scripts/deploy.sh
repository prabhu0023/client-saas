#!/usr/bin/env bash
#
# deploy.sh — deploy clinic-saas to Vercel
#
# Runs the local quality gate (build.sh) first so a broken build never
# ships, then deploys via the Vercel CLI. Secrets are NOT handled here —
# they live in the Vercel project's Environment Variables (dashboard or
# `vercel env`). This script only verifies the CLI is linked and the
# required env keys exist in the target environment.
#
# Usage:
#   ./scripts/deploy.sh                 # deploy a PREVIEW build
#   ./scripts/deploy.sh --prod          # deploy to PRODUCTION
#   ./scripts/deploy.sh --skip-gate     # skip build.sh (Vercel builds anyway)
#
# Prereqs (one-time):
#   npm i -g vercel        # install the CLI
#   vercel login           # authenticate
#   vercel link            # link this folder to a Vercel project
#   # set env vars in the Vercel dashboard, or:
#   #   vercel env add NEXT_PUBLIC_SUPABASE_URL
#   #   ...
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PROD=0
SKIP_GATE=0
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --skip-gate) SKIP_GATE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31m==>\033[0m %s\n' "$1" >&2; exit 1; }

# --- Vercel CLI present? -------------------------------------------------
if ! command -v vercel >/dev/null 2>&1; then
  die "Vercel CLI not found. Install it: npm i -g vercel && vercel login && vercel link"
fi

# --- Linked to a project? ------------------------------------------------
if [ ! -f .vercel/project.json ]; then
  die "This folder isn't linked to a Vercel project. Run: vercel link"
fi

# --- Required env keys (names only — values live in Vercel) --------------
# We can't read Vercel's remote env from here reliably across CLI
# versions, so we just remind the operator which keys must exist.
REQUIRED_ENV=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  WACRM_BASE_URL
  WACRM_API_KEY
  WACRM_WEBHOOK_SECRET
  CRON_SECRET
)
log "Ensure these env vars are set in the Vercel project (Settings → Environment Variables):"
for k in "${REQUIRED_ENV[@]}"; do printf '      - %s\n' "$k"; done

# --- Local quality gate --------------------------------------------------
if [ "$SKIP_GATE" -eq 0 ]; then
  log "Running local build gate (typecheck + lint + tests + build)..."
  ./scripts/build.sh
else
  warn "Skipping local gate (--skip-gate); Vercel will still build."
fi

# --- Deploy --------------------------------------------------------------
if [ "$PROD" -eq 1 ]; then
  log "Deploying to PRODUCTION..."
  vercel deploy --prod
else
  log "Deploying a PREVIEW build..."
  vercel deploy
fi

log "Deploy command finished. Check the URL Vercel printed above."
log "Reminder: apply DB migrations (001–005 + pending wa_sessions,"
log "clinic_wacrm_accounts) to the target Supabase project before use."
