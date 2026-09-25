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
# be able to sign in, give ONE Super Admin a password through this script's
# environment, never argv, and never `export` it in your shell: a later
# `pm2 restart --update-env` from that shell would copy it into the running
# staging process (see scripts/README-env-refresh.md):
#   unset REFRESH_OPERATOR_PASSWORD; read -rs REFRESH_OPERATOR_PASSWORD
#   REFRESH_OPERATOR_PASSWORD="$REFRESH_OPERATOR_PASSWORD" ./scripts/refresh-staging.sh --yes
#   unset REFRESH_OPERATOR_PASSWORD    # REFRESH_OPERATOR_USER defaults to super_admin
set -euo pipefail

STAGING_DIR="/var/www/logisx-staging"
PROD_BACKUPS="/var/www/logistics-app/backups"
PM2_NAME="logisx-staging"
PROD_SHEET_ID="1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"

say() { echo "[refresh-staging] $*"; }
die() { echo "[refresh-staging] FAILED: $*" >&2; exit 1; }

# --- operator access: handed to refresh-env.js and to NOTHING else -----------
# Moved out of the environment before this script starts any child, then passed
# to the two refresh-env.js calls below, the preflight and the install. Left
# exported, every child would inherit it: `npm install` runs third-party
# lifecycle scripts, and `pm2 restart --update-env` copies this shell's
# environment into the running staging process — where the password would
# persist and `pm2 env` would show it. ⚠️ `export -n` too: assigning to a name
# the caller had already exported (an OPERATOR_PASSWORD of its own), or under
# an inherited allexport, keeps that name exported.
OPERATOR_PASSWORD="${REFRESH_OPERATOR_PASSWORD-}"
OPERATOR_USER="${REFRESH_OPERATOR_USER-}"
export -n OPERATOR_PASSWORD OPERATOR_USER
unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER
OPERATOR_REQUESTED=0
[ -z "$OPERATOR_PASSWORD$OPERATOR_USER" ] || OPERATOR_REQUESTED=1

# The operator variables came from the calling shell's environment, where this
# script cannot unset them. If they are exported there, a `pm2 restart
# --update-env` run from that shell later would copy them into staging, so
# the operator is told how to drop them.
remind_unset() {
  [ "$OPERATOR_REQUESTED" = "1" ] || return 0
  say ""
  say "The operator variables reached this script from your shell. If they are exported there, unset them"
  say "before you run anything else from that shell (a pm2 restart --update-env would copy them into staging):"
  say "  unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER"
}

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

# --- 1c. install + build, under the Node pm2 runs $PM2_NAME with --------------
# ⚠️ A bare `npm` here is the WRONG npm. On this box PATH resolves node and npm
# to the system Node 20 (ABI 115, the other tenants'), while pm2 runs
# $PM2_NAME under /opt/node22 (ABI 127). An install that fetches or rebuilds
# better-sqlite3 under Node 20 leaves a module staging cannot load, and its
# next restart dies with "NODE_MODULE_VERSION 115 ... requires 127".
#
# So this is scripts/deploy/remote-deploy.sh's install, step for step — the
# way production and staging's own deploys already build:
#   1. the interpreter pm2 runs $PM2_NAME with, read BY NAME from jlist's JSON
#      (pm2_interpreter, in the pick-node block just below). pm2's default, a
#      bare `node`, means PATH's node; unreadable means refuse, never a guess.
#   2. that Node's directory first on PATH, so npm and every install script
#      run under it.
#   3. npm install, then a probe that OPENS an in-memory database; if it
#      fails, `npm rebuild better-sqlite3` and probe again. npm tracks package
#      versions, not ABI, so an install alone never repairs a module built for
#      another Node.
#   4. still failing: stop. Nothing is built, the database is not replaced,
#      and --restart does not restart.
# PATH is put back afterwards: `pm2 restart --update-env` copies this shell's
# environment into the running process, and pick_node's last candidate is
# PATH's own node. (scripts/test-refresh-remote-node.js §6 runs every step.)
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
PM2_NODE="$(pm2_interpreter "$PM2_NAME" 2>/dev/null || true)"
case "$PM2_NODE" in
  node) PM2_NODE="$(command -v node 2>/dev/null || true)" ;;
esac
if [ -z "$PM2_NODE" ] || [ ! -x "$PM2_NODE" ]; then
  die "cannot read the interpreter pm2 runs $PM2_NAME with, so refusing to install with a guess (PATH's node here is the system Node 20, and a build under it does not load under pm2's Node 22). The code is updated; nothing was installed, built or restarted, and the database was not touched."
fi
SAVED_PATH="$PATH"
PATH="$(dirname "$PM2_NODE"):$PATH"
export PATH
say "pm2 runs $PM2_NAME with $PM2_NODE"
say "installing dependencies with $(command -v node) $(node --version) / npm $(npm --version)…"
npm install --silent --no-audit --no-fund
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
  say "native ABI mismatch detected — rebuilding better-sqlite3 for $(node --version)"
  npm rebuild better-sqlite3
  node -e "new (require('better-sqlite3'))(':memory:').close()" \
    || die "better-sqlite3 still cannot open a database under $(node --version) after the rebuild, so $PM2_NAME would not boot on it. The code and node_modules are updated; NOT restarted, the client was not built and the database was not touched."
fi
say "native modules OK under $(node --version)"
say "building client…"
npm run build:client --silent
PATH="$SAVED_PATH"
export PATH

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
# pick_node (in the pick-node block, above step 1c) takes the first candidate
# that can open a database, so a repin or rebuild needs no edit here; after
# 1c built the module for pm2's own Node, that is pm2's Node. It fails closed —
# refresh-env.js never runs, so nothing is written, when none can.
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
  # --update-env copies the environment of whoever runs it into the running
  # process, so the command handed out drops the operator variables from it:
  # whatever the shell it is run from has exported, they never reach staging.
  # (scripts/test-refresh-sign-in.js runs this line from a shell that exports them.)
  say "When ready:  env -u REFRESH_OPERATOR_PASSWORD -u REFRESH_OPERATOR_USER pm2 restart $PM2_NAME --update-env"
fi
remind_unset
