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
#
# Every account on the refreshed copy gets a random password nobody knows. To
# be able to sign in, give ONE Super Admin a password through the environment
# (never argv; see scripts/README-env-refresh.md):
#   read -rs REFRESH_OPERATOR_PASSWORD && export REFRESH_OPERATOR_PASSWORD
#   ./scripts/refresh-staging.sh --yes            # REFRESH_OPERATOR_USER defaults to super_admin
#   unset REFRESH_OPERATOR_PASSWORD
set -euo pipefail

STAGING_DIR="/var/www/logisx-staging"
PROD_BACKUPS="/var/www/logistics-app/backups"
PM2_NAME="logisx-staging"
PROD_SHEET_ID="1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"

say() { echo "[refresh-staging] $*"; }
die() { echo "[refresh-staging] FAILED: $*" >&2; exit 1; }

# --- operator access: handed to refresh-env.js and to NOTHING else -----------
# Moved out of the environment before this script starts any child, then passed
# to the single refresh-env.js call below. Left exported, every child would
# inherit it: `npm install` runs third-party lifecycle scripts, and
# `pm2 restart --update-env` copies this shell's environment into the running
# staging process — where the password would persist and `pm2 env` would show it.
OPERATOR_PASSWORD="${REFRESH_OPERATOR_PASSWORD-}"
OPERATOR_USER="${REFRESH_OPERATOR_USER-}"
unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER

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

# --- 1b. gates, before the slow part ------------------------------------------
# The checks the install below will run anyway — the .env (sheet / mail /
# auto-invoice), the operator password's length, and the extra arguments (a
# password typed as one, a stray mode flag) — run here first, with the checkout
# already current, so a refusal costs seconds rather than an npm install and a
# client build with any such argument sitting in this script's argv on a shared
# box. --check-env-only loads no native module, so any node will do; the
# ABI-matched one is picked below, for the step that needs it.
PRE_NODE="$(command -v node 2>/dev/null || true)"
[ -n "$PRE_NODE" ] && [ -x "$PRE_NODE" ] || PRE_NODE=/opt/node22/bin/node
REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \
  "$PRE_NODE" scripts/refresh-env.js --check-env-only --to "$STAGING_DIR/app.db" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
  || die "target environment gates refused. The code is updated; the database was not touched."

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
# with (ABI 127), so refresh-env.js dies opening the database:
#
#     NODE_MODULE_VERSION 127 ... this version of Node.js requires 115
#
# ⚠️ AND THAT PICK (#339's, copied here in #342) HAD TWO HOLES OF ITS OWN,
# found when refresh-local.sh failed with exactly that error on 2026-09-25.
# backup.sh was fixed for both in #366; the two refresh scripts were missed:
#   1. `pm2 jlist` prints every process on ONE line, so a greedy
#      `sed 's/.*"exec_interpreter":…/'` took the LAST process's interpreter —
#      another tenant's /usr/bin/node on this shared box. It had only worked
#      while a LogisX process happened to be last. => read $PM2_NAME BY NAME
#      (its build is the node_modules loaded here), with a real JSON parse.
#   2. `require("better-sqlite3")` passes under the wrong Node, because the
#      binding loads lazily. => the probe OPENS an in-memory database.
# The first candidate that can open a database wins, so a repin or rebuild
# needs no edit here. It fails closed — refresh-env.js never runs, so nothing
# is written, when none can.
# >>> pick-node - keep byte-identical in refresh-local.sh and refresh-staging.sh
# (scripts/test-refresh-remote-node.js pins the copies, and pins the jlist
# parse to scripts/deploy/remote-deploy.sh's)
#
# pick_node DIR NAME prints the first node that can OPEN a better-sqlite3
# database from DIR's node_modules: the interpreter pm2 runs the process NAME
# with, then /opt/node22, then PATH's node. pm2_interpreter reads NAME from
# jlist's JSON (one line; pm2 can print a notice ahead of it). Any node can
# parse JSON; only better-sqlite3 cares about the ABI.
pm2_interpreter() {
  pm2 jlist 2>/dev/null | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let l=[];try{l=JSON.parse(d.slice(d.lastIndexOf("\n[")+1));}catch(e){}
    const p=Array.isArray(l)?l.find(x=>x&&x.name===process.argv[1]):null;
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$1"
}
pick_node() {
  local cand
  for cand in "$(pm2_interpreter "$2" 2>/dev/null)" /opt/node22/bin/node "$(command -v node 2>/dev/null)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if (cd "$1" && "$cand" -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1; then
      echo "$cand"; return 0
    fi
  done
  return 1
}
# <<< pick-node
NODE_BIN="$(pick_node "$STAGING_DIR" "$PM2_NAME")" || die "no node on this box can open a better-sqlite3 database from $STAGING_DIR/node_modules — run: npm rebuild better-sqlite3 (under the interpreter pm2 runs $PM2_NAME with)"
say "node: $NODE_BIN ($("$NODE_BIN" -v))"

# --from is on the same box, so this is a local read of a file with no writer.
# The operator variables reach this one process only (see the top of the file).
REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \
  "$NODE_BIN" scripts/refresh-env.js --from "$LATEST" --to "$STAGING_DIR/app.db" --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
unset OPERATOR_PASSWORD OPERATOR_USER

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
