#!/usr/bin/env bash
# scripts/refresh-staging.sh — bring the VPS `logisx-staging` process to
# origin/main and rebuild its app.db from the latest sanitized production
# snapshot.
#
# RUN THIS ON THE VPS, from /var/www/logisx-staging:
#   cd /var/www/logisx-staging && ./scripts/refresh-staging.sh --yes
#   ./scripts/refresh-staging.sh --yes --restart      # also restarts pm2
#
# The pm2 restart is OPT-IN. Staging is a shared environment; someone may be
# mid-test on it. Without --restart the new code and database are staged on disk
# and the running process keeps the old ones until you restart it yourself.
set -euo pipefail

STAGING_DIR="/var/www/logisx-staging"
PROD_BACKUPS="/var/www/logistics-app/backups"
PM2_NAME="logisx-staging"
PROD_SHEET_ID="1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"

say() { echo "[refresh-staging] $*"; }
die() { echo "[refresh-staging] FAILED: $*" >&2; exit 1; }

CONFIRMED=0; RESTART=0; EXTRA_ARGS=()
for a in "$@"; do
  case "$a" in
    --yes) CONFIRMED=1 ;;
    --restart) RESTART=1 ;;
    *) EXTRA_ARGS+=("$a") ;;
  esac
done
[ "$CONFIRMED" = "1" ] || die "pass --yes to confirm you are refreshing STAGING (this replaces its database)."

# --- refuse to be pointed at production -------------------------------------
# A path check is not enough on its own: what makes a directory production is
# the sheet its .env resolves to, not its name. The staging sheet is even
# TITLED "logisx-production" — identify by ID, never by name.
[ "$(pwd)" = "$STAGING_DIR" ] || die "run this from $STAGING_DIR (currently $(pwd))."
[ -f .env ] || die "$STAGING_DIR/.env not found."
SHEET="$(grep -E '^SPREADSHEET_ID=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
[ -n "$SHEET" ] || die ".env has no SPREADSHEET_ID — server.js would fall through to the PRODUCTION sheet."
[ "$SHEET" != "$PROD_SHEET_ID" ] || die ".env points at the PRODUCTION sheet. Refusing."
say "staging sheet: $SHEET (not production)"

# --- 1. code ----------------------------------------------------------------
say "current: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
git fetch origin --prune
# Staging historically sat on `develop`, 89 commits behind. main is what ships,
# so main is what staging must mirror — otherwise it validates code nobody will
# deploy.
git checkout main
git reset --hard origin/main
say "now: main @ $(git rev-parse --short HEAD)"

say "installing dependencies…"
npm install --silent --no-audit --no-fund
say "building client…"
npm run build:client --silent

# --- 2. data ----------------------------------------------------------------
LATEST="$(ls -1t $PROD_BACKUPS/app.db.*.gz 2>/dev/null | head -1 || true)"
[ -n "$LATEST" ] || die "no nightly snapshot in $PROD_BACKUPS"
say "snapshot: $LATEST"

# --from is on the same box, so this is a local read of a file with no writer.
node scripts/refresh-env.js --from "$LATEST" --to "$STAGING_DIR/app.db" --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

# --- 3. restart -------------------------------------------------------------
if [ "$RESTART" = "1" ]; then
  say "restarting $PM2_NAME…"
  pm2 restart "$PM2_NAME" --update-env
  sleep 3
  pm2 describe "$PM2_NAME" | grep -E 'status|restarts' || true
else
  say ""
  say "NOT restarted. New code + database are on disk; the running process still holds the old ones."
  say "When ready:  pm2 restart $PM2_NAME --update-env"
fi
