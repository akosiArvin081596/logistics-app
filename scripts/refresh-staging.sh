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

# ---------------------------------------------------------------------------
# THIS SCRIPT RESETS THE WORKING TREE IT LIVES IN.
#
# `git reset --hard origin/main` below rewrites every tracked file, including
# this one and scripts/refresh-env.js. bash reads a script incrementally, so a
# file that changes underneath it executes garbage — and if the running branch
# does not yet contain these scripts (the normal case the first time, before the
# refresh PR merges) they are DELETED mid-run and the node call that follows
# fails with "cannot find module".
#
# So: stash refresh-env.js first and run that copy instead.
#
# The stash goes in an UNTRACKED directory INSIDE the staging tree, not in
# /tmp. Two reasons, both load-bearing:
#   - `git reset --hard` rewrites tracked files but leaves untracked ones alone
#     (only `git clean` would remove these), so the copy survives the reset;
#   - node resolves require() from the MODULE's own directory upwards, so a copy
#     in /tmp would fail on `require("better-sqlite3")`. Inside the staging tree
#     it finds ./node_modules exactly as it would in scripts/.
# ---------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STASH="$STAGING_DIR/.env-refresh-tmp"
mkdir -p "$STASH"
trap 'rm -rf "$STASH"' EXIT
if [ "$SELF_DIR" = "$STASH" ]; then
  # Already running FROM the stash (how you bootstrap this before the scripts
  # exist on main). Nothing to copy — `cp` onto itself is an error under set -e.
  [ -f "$STASH/refresh-env.js" ] || die "refresh-env.js must sit beside this script in $STASH."
elif [ -f "$SELF_DIR/refresh-env.js" ]; then
  cp "$SELF_DIR/refresh-env.js" "$STASH/refresh-env.js"
elif [ -f "$STAGING_DIR/scripts/refresh-env.js" ]; then
  cp "$STAGING_DIR/scripts/refresh-env.js" "$STASH/refresh-env.js"
else
  die "refresh-env.js not found beside this script ($SELF_DIR) or in $STAGING_DIR/scripts."
fi
REFRESH_ENV="$STASH/refresh-env.js"

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
# $REFRESH_ENV is the pre-reset copy — see the note at the top of this file.
node "$REFRESH_ENV" --from "$LATEST" --to "$STAGING_DIR/app.db" --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

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
