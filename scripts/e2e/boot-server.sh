#!/usr/bin/env bash
# Boot the LogisX server for a browser E2E run — LOCAL ONLY, every outbound effect off.
#
#   scripts/e2e/boot-server.sh <worktree> <port> <db>
#
# Starts `node server.js` from <worktree> against <db>, a copy setup-db.cjs made
# inside the work dir, in the background, bound to 127.0.0.1. The log is
# <work dir>/server-<port>.log, and the PID is recorded in <work dir>/server-<port>.pid.
# stop-server.sh <port> kills exactly that process.
#
# No real key and no .env: the server's settings are the made-up values and the
# overrides below, all on its command line (no settings file is read). It preloads
# scripts/e2e/fake-google.cjs, so require("googleapis") answers a stand-in: Sheets
# come from <db>.sheets.json, a copy of the made-up fixture scripts/e2e/fixtures/
# e2e-sheets.json made at the first boot on <db> (setup-db.cjs removes it with the
# database, and a restart on the same <db> keeps what the run wrote), Drive refuses
# every call, and dotenv loads nothing. The boot is refused when <worktree> holds a
# .env or a service-account-key.json, and the server is stopped when its log does
# not show the stand-in in place.
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
#   INVESTOR_LEASE_PAYOUTS_ENABLED  the lease payout flag, passed to the server as
#                 given; unset or empty boots it OFF (the E2E's lease section and
#                 payout-parity.mjs set it explicitly).
#   E2E_NO_CLIENT=1  boot without client/dist: for an API-only run
#                 (payout-parity.mjs), which never requests a page.
#   E2E_DRIVER_INSTRUCTIONS_DENY=<made-up value>  boot with the rate-con driver
#                 instructions ON (RATECON_DRIVER_INSTRUCTIONS_ENABLED=true) and this
#                 value as the only CARRIER_ACCOUNT_NUMBERS_DENY_SECRET entry, for the
#                 E2E's instructions section. Use an invented value (e.g. T8273641),
#                 never a real one; it is set in this server's environment only and
#                 never printed. Unset or empty: both off and blank. The driver
#                 screen flag and the Drive uploader stay off.
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
if [ "${E2E_NO_CLIENT:-}" = "1" ]; then
  echo "client: not required (E2E_NO_CLIENT=1, an API-only run)"
else
  [ -d "$WT/client/dist" ] || refuse "no client/dist in $WT (run prep-worktree.sh, which builds it)"
fi
[ -e "$WT/node_modules" ] || refuse "no node_modules in $WT (run prep-worktree.sh, which links it)"
# A real .env or Google key in the worktree is never used: the server's dotenv would
# read the .env from its cwd if the stand-in were ever missing. Nothing here opens
# either file; their presence alone refuses the boot.
for f in .env service-account-key.json; do
  if [ -e "$WT/$f" ] || [ -L "$WT/$f" ]; then
    refuse "$WT holds $f; the e2e server runs on the made-up settings below and the Google stand-in only. Remove that link or file from the worktree (prep-worktree.sh no longer makes it)"
  fi
done

# The settings a .env used to give the server, made-up values only (no real key,
# sheet, folder, inbox or account; scripts/test-e2e-no-real-keys.js checks them).
# They go on the server's command line below with the other overrides, so whatever
# the caller exported is never used for them.
#   SHEET          the made-up fixture's book (fixtures/e2e-sheets.json), which the
#                  stand-in answers. Never empty: server.js refuses to start without
#                  one (lib/sheet-id.js); only old exported builds (REF_A in
#                  payout-parity.mjs) fell back to PRODUCTION's sheet on an empty value
#   ARCHIVE_SHEET  a made-up archive book (the stand-in answers 404), so production's
#                  archive id (server.js's default) is never named
#   DRIVE_FOLDER   blank: no Drive folder
#   SESSION_VALUE  a made-up session signing value
#   ZONE           the business time zone
SHEET=e2e-made-up-sheet
ARCHIVE_SHEET=e2e-made-up-archive
DRIVE_FOLDER=
SESSION_VALUE=e2e-made-up-session
ZONE=America/New_York
echo "settings: made-up, on the command line (SPREADSHEET_ID=$SHEET, ARCHIVE_SPREADSHEET_ID=$ARCHIVE_SHEET); no settings file is read"
if [ "${SPREADSHEET_ID+set}" = set ] && [ "$SPREADSHEET_ID" != "$SHEET" ]; then
  echo "sheet: the exported SPREADSHEET_ID is ignored (not printed); the server gets the fixture's book"
fi

# The Google stand-in and its Sheets copy, beside the database in the work dir.
FAKE_GOOGLE="$HERE/fake-google.cjs"
FIXTURE="$HERE/fixtures/e2e-sheets.json"
[ -f "$FAKE_GOOGLE" ] || refuse "$FAKE_GOOGLE is missing"
[ -f "$FIXTURE" ] && [ ! -L "$FIXTURE" ] || refuse "$FIXTURE is missing or a symlink"
SHEETS_COPY="$DB.sheets.json"
if [ -L "$SHEETS_COPY" ]; then refuse "$SHEETS_COPY is a symlink"; fi
if [ ! -e "$SHEETS_COPY" ]; then
  cp "$FIXTURE" "$SHEETS_COPY"
  chmod 600 "$SHEETS_COPY"
  echo "sheet: a fresh copy of the made-up fixture at $SHEETS_COPY"
else
  echo "sheet: the run's copy of the made-up fixture at $SHEETS_COPY (setup-db.cjs on a new database starts it again)"
fi
echo "google: a stand-in (fake-google.cjs): Sheets read and write that copy, Drive refuses, no key is read and nothing goes to Google"

# The maintenance notice: off unless asked for. It shows a popup and a banner to
# investors and sends nothing anywhere; the audience is pinned so M1 has one.
NOTICE=false
if [ "${E2E_MAINTENANCE_NOTICE:-}" = "1" ]; then NOTICE=true; fi
echo "maintenance notice: $([ "$NOTICE" = true ] && echo 'ON (investor audience)' || echo off)"

# The lease payout flag (a money flag that ships off): as the caller set it, else off.
LEASE="${INVESTOR_LEASE_PAYOUTS_ENABLED:-false}"
echo "lease payouts: INVESTOR_LEASE_PAYOUTS_ENABLED=$LEASE"

# Rate-con driver instructions: off and blank unless the caller passes a made-up
# deny value. The value is never echoed.
DI_ENABLED=false
DI_DENY="${E2E_DRIVER_INSTRUCTIONS_DENY:-}"
if [ -n "$DI_DENY" ]; then DI_ENABLED=true; fi
echo "driver instructions: $([ "$DI_ENABLED" = true ] && echo 'ON (with the caller'"'"'s made-up deny value; not printed)' || echo 'off (deny list blank)'); driver screen off; Drive uploader blank"

# The mail recipients. server.js and lib/broker-invoice.js have no default for
# them, so the run names example.test inboxes (a reserved name nothing delivers
# to), whatever the caller exported: the admin notifications have a recipient, and an
# invoice draft (captured by the fake Gmail, or answered as a preview without
# it) is addressed as it would be in production, never to a real inbox.
ADMIN_TO=admin@example.test
BISON_TO=bison-ap@example.test
DEFAULT_TO=ap@example.test
echo "mail recipients: ADMIN_NOTIFY_EMAIL=$ADMIN_TO BISON_INVOICE_EMAIL=$BISON_TO DEFAULT_INVOICE_EMAIL=$DEFAULT_TO"

# The rate-con Drive folder. server.js has no default for RATECON_DRIVE_FOLDER_ID:
# blanked like the keys below, the rate-con Drive features are off and no Drive
# call is made (the mirror of a dropped rate-con PDF, the rate-con lookups).
echo "rate-con Drive folder: blanked (RATECON_DRIVE_FOLDER_ID empty: the rate-con Drive features are off)"

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
# The fakes are preloaded into the server alone: nothing below this line but the
# server runs node. fake-google.cjs always; fake-gmail.cjs with E2E_FAKE_GMAIL=1.
case "$FAKE_GOOGLE" in *'"'*|*'\'*) refuse "the path $FAKE_GOOGLE cannot be passed in NODE_OPTIONS";; esac
PRELOAD="--require \"$FAKE_GOOGLE\""
if [ -n "$FAKE_MOD" ]; then PRELOAD="$PRELOAD --require \"$FAKE_MOD\""; fi
export NODE_OPTIONS="$PRELOAD"
# Every value below wins over the caller's environment, the empty ones included. The
# server's dotenv loads nothing (fake-google.cjs).
env PORT="$PORT" BIND_HOST=127.0.0.1 DATABASE_PATH="$DB" NODE_ENV=development \
  SPREADSHEET_ID="$SHEET" ARCHIVE_SPREADSHEET_ID="$ARCHIVE_SHEET" GOOGLE_DRIVE_FOLDER_ID="$DRIVE_FOLDER" \
  SESSION_SECRET="$SESSION_VALUE" APP_TIMEZONE="$ZONE" GOOGLE_APPLICATION_CREDENTIALS= \
  E2E_FAKE_SHEETS_FILE="$SHEETS_COPY" \
  GMAIL_USER="$G_USER" GMAIL_APP_PASSWORD="$G_PASS" E2E_FAKE_GMAIL_DIR="$FAKE_DIR" \
  ADMIN_NOTIFY_EMAIL="$ADMIN_TO" BISON_INVOICE_EMAIL="$BISON_TO" DEFAULT_INVOICE_EMAIL="$DEFAULT_TO" \
  N8N_INVOICE_WEBHOOK_URL= GEMINI_API_KEY= \
  RATECON_DRIVE_FOLDER_ID= \
  GOOGLE_MAPS_API_KEY= GOOGLE_MAPS_BROWSER_KEY= \
  ROUTEMATE_API_KEY= SCANKIT_API_KEY= LINXUP_WEBHOOK_TOKEN= \
  ROUTEMATE_ENABLED=false LINXUP_ENABLED=false SCANKIT_ENABLED=false \
  INVOICE_AUTOGEN_ENABLED=false PERIOD_FINALIZE_ENABLED=false FUEL_GALLONS_RECOVERY_ENABLED=false \
  RATECON_RECONCILE_ENABLED=false RATECON_INDEX_APPLY_ENABLED=false FUEL_EVENTS_ENABLED=false CHAT_ORPHAN_SWEEP_ENABLED=false \
  ELD_STALE_ALERT_ENABLED=false FUEL_LOW_ALERT_ENABLED=false EXPENSE_DUPLICATE_ALERT_ENABLED=false \
  INVOICE_UNDATED_ALERT_ENABLED=false RATECON_EXTRACT_ALERT_ENABLED=false \
  MAINTENANCE_NOTICE_ENABLED="$NOTICE" MAINTENANCE_NOTICE_AUDIENCE=investor \
  INVESTOR_LEASE_PAYOUTS_ENABLED="$LEASE" \
  RATECON_DRIVER_INSTRUCTIONS_ENABLED="$DI_ENABLED" CARRIER_ACCOUNT_NUMBERS_DENY_SECRET="$DI_DENY" CARRIER_ACCOUNT_NUMBERS_DENY= \
  DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED=false RATECON_DRIVE_UPLOADER_EMAIL= \
  nohup "$NODE_BIN" server.js >"$LOG" 2>&1 &
PID=$!
# Line 1: the PID. Line 2: the worktree it runs from (stop-server.sh checks both).
printf '%s\n%s\n' "$PID" "$WT" >"$PIDFILE"
echo "started pid $PID on 127.0.0.1:$PORT from $WT (log: $LOG)"

# Wait until it answers (the boot reads the sheet copy first, and exits if it cannot).
for i in $(seq 1 90); do
  if ! kill -0 "$PID" 2>/dev/null; then echo "server exited; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)"
  if [ "$code" = "200" ]; then
    # The Google stand-in must be in place; otherwise the server would have looked
    # for a key. It is stopped instead.
    if ! grep -qF 'fake-google: googleapis is a stand-in' "$LOG"; then
      kill "$PID"; rm -f "$PIDFILE"
      refuse "the server answers, but its log does not show fake-google.cjs in place; it was stopped (see $LOG)"
    fi
    grep -F 'fake-google: googleapis is a stand-in' "$LOG" | head -1
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
