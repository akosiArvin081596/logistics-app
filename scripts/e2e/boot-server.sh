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
#   E2E_MAINTENANCE_NOTICE=1  boot with the investor maintenance notice ON
#                 (MAINTENANCE_NOTICE_ENABLED=true, audience investor), for the
#                 E2E's M1. Anything else, or unset: the notice stays off.
#   E2E_FAKE_GMAIL=1  boot with a stand-in for Gmail, for the invoice section's I14
#                 and I14b: obviously fake Gmail credentials, and the server alone
#                 preloads scripts/e2e/fake-gmail.cjs (NODE_OPTIONS), which captures
#                 each IMAP APPEND (a Gmail draft) in <work dir>/fake-gmail (0700)
#                 and refuses SMTP, so nothing reaches Gmail. Refused when
#                 fake-gmail.cjs is missing. Anything else, or unset: Gmail blanked.
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

# The maintenance notice: off unless asked for. It shows a popup and a banner to
# investors and sends nothing anywhere; the audience is pinned so M1 has one.
NOTICE=false
if [ "${E2E_MAINTENANCE_NOTICE:-}" = "1" ]; then NOTICE=true; fi
echo "maintenance notice: $([ "$NOTICE" = true ] && echo 'ON (investor audience)' || echo off)"

# The rate-con Drive folder. server.js reads RATECON_DRIVE_FOLDER_ID with a
# fallback: an EMPTY value (or none) means production's rate-con folder, which is
# hardcoded there. So it cannot be blanked like the keys below: it is set to a
# value that names no Drive folder, and a Drive call against it (the mirror of a
# dropped rate-con PDF, the rate-con lookups) would name no real folder.
NO_DRIVE_FOLDER=logisx-e2e-no-drive-folder
echo "rate-con Drive folder: RATECON_DRIVE_FOLDER_ID=$NO_DRIVE_FOLDER (names no folder; an empty value would mean production's)"

# Gmail: blanked, unless E2E_FAKE_GMAIL=1 asks for the fake. Its credentials are
# obviously fake (.invalid is a reserved name), and fake-gmail.cjs, preloaded into
# the server alone, answers every IMAP APPEND by capturing the draft in the work dir
# and refuses SMTP. Without the module those credentials would be tried against the
# real Gmail, so a missing module refuses the boot.
G_USER=; G_PASS=; FAKE_DIR=; FAKE_MOD=
if [ "${E2E_FAKE_GMAIL:-}" = "1" ]; then
  FAKE_MOD="$HERE/fake-gmail.cjs"
  [ -f "$FAKE_MOD" ] || refuse "E2E_FAKE_GMAIL=1, but $FAKE_MOD is missing"
  case "$FAKE_MOD" in *'"'*|*'\'*) refuse "the path $FAKE_MOD cannot be passed in NODE_OPTIONS";; esac
  FAKE_DIR="$WORK/fake-gmail"
  [ ! -L "$FAKE_DIR" ] || refuse "$FAKE_DIR is a symlink"
  mkdir -p "$FAKE_DIR"
  chmod 700 "$FAKE_DIR"
  G_USER=e2e-fake@logisx.invalid
  G_PASS=e2e-fake-app-password
  echo "gmail: FAKE (GMAIL_USER=$G_USER; the server preloads $FAKE_MOD, which captures each draft in $FAKE_DIR and refuses SMTP)"
else
  echo "gmail: blanked (no mail target: an approve answers preview only)"
fi

cd "$WT"
# The fake is preloaded into the server alone: nothing below this line but the
# server runs node.
if [ -n "$FAKE_MOD" ]; then export NODE_OPTIONS="--require \"$FAKE_MOD\""; fi
# dotenv never overrides a variable that is already set, so every value below,
# including the empty ones, wins over .env.
env PORT="$PORT" BIND_HOST=127.0.0.1 DATABASE_PATH="$DB" NODE_ENV=development \
  SPREADSHEET_ID="$SHEET" \
  GMAIL_USER="$G_USER" GMAIL_APP_PASSWORD="$G_PASS" E2E_FAKE_GMAIL_DIR="$FAKE_DIR" \
  N8N_INVOICE_WEBHOOK_URL= GEMINI_API_KEY= \
  RATECON_DRIVE_FOLDER_ID="$NO_DRIVE_FOLDER" \
  GOOGLE_MAPS_API_KEY= GOOGLE_MAPS_BROWSER_KEY= \
  ROUTEMATE_API_KEY= SCANKIT_API_KEY= LINXUP_WEBHOOK_TOKEN= \
  ROUTEMATE_ENABLED=false LINXUP_ENABLED=false SCANKIT_ENABLED=false \
  INVOICE_AUTOGEN_ENABLED=false PERIOD_FINALIZE_ENABLED=false FUEL_GALLONS_RECOVERY_ENABLED=false \
  RATECON_RECONCILE_ENABLED=false RATECON_INDEX_APPLY_ENABLED=false FUEL_EVENTS_ENABLED=false CHAT_ORPHAN_SWEEP_ENABLED=false \
  ELD_STALE_ALERT_ENABLED=false FUEL_LOW_ALERT_ENABLED=false EXPENSE_DUPLICATE_ALERT_ENABLED=false \
  INVOICE_UNDATED_ALERT_ENABLED=false RATECON_EXTRACT_ALERT_ENABLED=false \
  MAINTENANCE_NOTICE_ENABLED="$NOTICE" MAINTENANCE_NOTICE_AUDIENCE=investor \
  nohup "$NODE_BIN" server.js >"$LOG" 2>&1 &
PID=$!
# Line 1: the PID. Line 2: the worktree it runs from (stop-server.sh checks both).
printf '%s\n%s\n' "$PID" "$WT" >"$PIDFILE"
echo "started pid $PID on 127.0.0.1:$PORT from $WT (log: $LOG)"

# Wait until it answers (the boot reads the sheet first, and exits if it cannot).
for i in $(seq 1 90); do
  if ! kill -0 "$PID" 2>/dev/null; then echo "server exited; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)"
  if [ "$code" = "200" ]; then
    # With the fake credentials, the server must also show the fake's hooks in
    # place; otherwise an approve would try the real Gmail. It is stopped instead.
    if [ -n "$FAKE_MOD" ] && ! grep -qF 'fake-gmail: imap.gmail.com goes to a fake IMAP server' "$LOG"; then
      kill "$PID"; rm -f "$PIDFILE"
      refuse "the server answers, but its log does not show fake-gmail.cjs in place; it was stopped (see $LOG)"
    fi
    [ -z "$FAKE_MOD" ] || grep -F 'fake-gmail: imap.gmail.com goes to a fake IMAP server' "$LOG" | head -1
    echo "ready after ${i}s"; exit 0
  fi
  sleep 1
done
echo "not ready after 90s; see $LOG. It is still running: stop it with stop-server.sh $PORT" >&2
exit 1
