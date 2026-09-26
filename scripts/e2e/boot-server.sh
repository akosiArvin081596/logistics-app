#!/usr/bin/env bash
# Boot the LogisX server for a browser E2E run — LOCAL ONLY, every outbound effect off.
#
#   scripts/e2e/boot-server.sh <worktree> <port> <db>
#
# Starts `node server.js` from <worktree> (dotenv reads .env from the cwd, and the
# Google key is ./service-account-key.json; prep-worktree.sh links both) against
# <db>, a copy setup-db.cjs made inside the work dir, in the background, bound to
# 127.0.0.1. The log is <work dir>/server-<port>.log, and the PID is recorded in
# <work dir>/server-<port>.pid. stop-server.sh <port> kills exactly that process.
#
# Env:
#   NODE_BIN      the node to run (default: `node` on PATH). Expected: .nvmrc's
#                 version, e.g. run this script under `fnm exec --using=22.23.2`.
#   E2E_WORK_DIR  the work dir (default: $TMPDIR/logisx-e2e; see paths.cjs)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
refuse() { echo "boot-server: refusing: $*" >&2; exit 2; }

WT_ARG="${1:?usage: boot-server.sh <worktree> <port> <db>}"
PORT="${2:?usage: boot-server.sh <worktree> <port> <db>}"
DB_ARG="${3:?usage: boot-server.sh <worktree> <port> <db>}"

case "$PORT" in ''|*[!0-9]*) refuse "port must be a number, got '$PORT'";; esac
case "$PORT" in 3000|5173) refuse "port $PORT is reserved (3000 is production on the VPS, 5173 is Vite)";; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then refuse "something already listens on $PORT"; fi

WANT=22.23.2
if [ -f "$REPO/.nvmrc" ]; then WANT="$(tr -d '[:space:]' < "$REPO/.nvmrc")"; fi
WANT="v${WANT#v}"
HAVE="$("$NODE_BIN" -v 2>/dev/null)" || refuse "no node at NODE_BIN=$NODE_BIN"
if [ "$HAVE" != "$WANT" ]; then
  echo "boot-server: WARNING: $NODE_BIN is $HAVE, but .nvmrc pins $WANT (better-sqlite3's ABI); the server may not start." \
    "Run under it: fnm exec --using=${WANT#v} $0 $*" >&2
fi

# The work dir and the DB, by the same rules every script uses (paths.cjs).
WORK="$("$NODE_BIN" "$HERE/paths.cjs" work-dir)"
DB="$("$NODE_BIN" "$HERE/paths.cjs" work-file "$DB_ARG")"
WT="$(cd "$WT_ARG" 2>/dev/null && pwd -P)" || refuse "no such directory: $WT_ARG"
LOG="$WORK/server-$PORT.log"
PIDFILE="$WORK/server-$PORT.pid"

[ -f "$WT/server.js" ] || refuse "no server.js in $WT"
[ -d "$WT/client/dist" ] || refuse "no client/dist in $WT (run prep-worktree.sh, which builds it)"
[ -e "$WT/node_modules" ] || refuse "no node_modules in $WT (run prep-worktree.sh, which links it)"
[ -e "$WT/service-account-key.json" ] || refuse "no service-account-key.json in $WT (run prep-worktree.sh, which links it)"
[ -e "$WT/.env" ] || refuse "no .env in $WT (run prep-worktree.sh, which links it)"

# The sheet the server will really use. dotenv never overrides a variable that is
# already set, so an exported SPREADSHEET_ID (even an empty one) beats .env; and
# server.js falls back to PRODUCTION's sheet when the value is empty. The value
# checked here is passed to the server explicitly below, so what was checked is
# what runs. It is never printed.
PROD_SHEET=1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo
if [ "${SPREADSHEET_ID+set}" = set ]; then
  SHEET="$SPREADSHEET_ID"; SHEET_FROM="the environment"
else
  SHEET="$("$NODE_BIN" -e '
    const path = require("path"), fs = require("fs"), { createRequire } = require("module")
    const wt = process.argv[1]
    const dotenv = createRequire(path.join(wt, "package.json"))("dotenv")
    process.stdout.write(dotenv.parse(fs.readFileSync(path.join(wt, ".env"))).SPREADSHEET_ID ?? "")
  ' "$WT")" || refuse "could not read $WT/.env with the app's dotenv"
  SHEET_FROM="$WT/.env"
fi
SHEET_TRIMMED="$(printf '%s' "$SHEET" | tr -d '[:space:]')"
[ -n "$SHEET_TRIMMED" ] || refuse "SPREADSHEET_ID is unset or empty in $SHEET_FROM; server.js would fall back to PRODUCTION's sheet"
[ "$SHEET_TRIMMED" != "$PROD_SHEET" ] || refuse "SPREADSHEET_ID in $SHEET_FROM is PRODUCTION's sheet"
echo "sheet: SPREADSHEET_ID from $SHEET_FROM is set and is not production's"

cd "$WT"
# dotenv never overrides a variable that is already set, so every value below,
# including the empty ones, wins over .env.
env PORT="$PORT" BIND_HOST=127.0.0.1 DATABASE_PATH="$DB" NODE_ENV=development \
  SPREADSHEET_ID="$SHEET" \
  GMAIL_USER= GMAIL_APP_PASSWORD= \
  N8N_INVOICE_WEBHOOK_URL= GEMINI_API_KEY= \
  GOOGLE_MAPS_API_KEY= GOOGLE_MAPS_BROWSER_KEY= \
  ROUTEMATE_API_KEY= SCANKIT_API_KEY= LINXUP_WEBHOOK_TOKEN= \
  ROUTEMATE_ENABLED=false LINXUP_ENABLED=false SCANKIT_ENABLED=false \
  INVOICE_AUTOGEN_ENABLED=false PERIOD_FINALIZE_ENABLED=false FUEL_GALLONS_RECOVERY_ENABLED=false \
  RATECON_RECONCILE_ENABLED=false RATECON_INDEX_APPLY_ENABLED=false FUEL_EVENTS_ENABLED=false CHAT_ORPHAN_SWEEP_ENABLED=false \
  ELD_STALE_ALERT_ENABLED=false FUEL_LOW_ALERT_ENABLED=false EXPENSE_DUPLICATE_ALERT_ENABLED=false \
  INVOICE_UNDATED_ALERT_ENABLED=false RATECON_EXTRACT_ALERT_ENABLED=false \
  MAINTENANCE_NOTICE_ENABLED=false \
  nohup "$NODE_BIN" server.js >"$LOG" 2>&1 &
PID=$!
# Line 1: the PID. Line 2: the worktree it runs from (stop-server.sh checks both).
printf '%s\n%s\n' "$PID" "$WT" >"$PIDFILE"
echo "started pid $PID on 127.0.0.1:$PORT from $WT (log: $LOG)"

# Wait until it answers (the boot reads the sheet first, and exits if it cannot).
for i in $(seq 1 90); do
  if ! kill -0 "$PID" 2>/dev/null; then echo "server exited; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)"
  if [ "$code" = "200" ]; then echo "ready after ${i}s"; exit 0; fi
  sleep 1
done
echo "not ready after 90s; see $LOG. It is still running: stop it with stop-server.sh $PORT" >&2
exit 1
