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

# ⚠️ THE THIRD VICTIM OF THE SAME ABI TRAP. backup.sh and refresh-local.sh were
# fixed in #339; this one was missed and failed the moment it was next run.
# A bare `node` resolves to /usr/bin/node — 20.20.1, ABI 115 — while staging's
# own node_modules/better-sqlite3 is built for the /opt/node22 that pm2 runs it
# with (ABI 127), so refresh-env.js dies at require():
#
#     NODE_MODULE_VERSION 127 ... this version of Node.js requires 115
#
# Same capability test as the other two: take the first interpreter that can
# actually load the module, so a repin or rebuild needs no edit here. It fails
# closed — refresh-env.js REFUSES rather than half-writing a database.
pick_node() {
  local cand
  for cand in \
    "$(pm2 jlist 2>/dev/null | sed -n 's/.*"exec_interpreter":"\([^"]*\)".*/\1/p' | head -1)" \
    /opt/node22/bin/node \
    "$(command -v node 2>/dev/null)"
  do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if (cd "$STAGING_DIR" && "$cand" -e 'require("better-sqlite3")') >/dev/null 2>&1; then
      echo "$cand"; return 0
    fi
  done
  return 1
}
NODE_BIN="$(pick_node)" || die "no node on this box can load better-sqlite3 from $STAGING_DIR/node_modules — run: npm rebuild better-sqlite3"
say "node: $NODE_BIN ($("$NODE_BIN" -v))"

# --from is on the same box, so this is a local read of a file with no writer.
"$NODE_BIN" scripts/refresh-env.js --from "$LATEST" --to "$STAGING_DIR/app.db" --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

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
