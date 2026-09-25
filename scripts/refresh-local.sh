#!/usr/bin/env bash
# scripts/refresh-local.sh — bring THIS machine's checkout to origin/main and
# rebuild app.db from the latest production snapshot, SANITIZED ON THE VPS.
#
# Run it from the repository root:
#   ./scripts/refresh-local.sh                      # code + data
#   ./scripts/refresh-local.sh --code-only          # skip the database
#   ./scripts/refresh-local.sh --telemetry-all      # full-fidelity telemetry (bigger, slower)
#   ./scripts/refresh-local.sh --telemetry-days 90  # a longer telemetry window (default 45)
#   ./scripts/refresh-local.sh --scan-legacy        # look for pre-2026-08-09 unsanitized copies
#   ./scripts/refresh-local.sh --help               # every option; anything else is refused
#
# Every account on the refreshed copy gets a random password nobody knows.
# Before running test-suite.js against it:
#   node scripts/prepare-test-fixtures.js --yes-local-db
# To sign in as one Super Admin instead, put REFRESH_OPERATOR_PASSWORD (and
# optionally REFRESH_OPERATOR_USER) in the ENVIRONMENT — never argv; see
# scripts/README-env-refresh.md. It is applied here, at install, and is never
# sent to the VPS.
#
# It never touches production data. The database source is the NIGHTLY SNAPSHOT
# (scripts/backup-db.js output), not the live production app.db, so nothing here
# opens a file production is writing to.
#
# -----------------------------------------------------------------------------
# ORDER OF OPERATIONS, AND WHY IT IS THE ORDER
#
#   Until 2026-08-09 this script did:
#
#       scp <production snapshot> -> laptop        # unredacted
#       node refresh-env.js --from … --to app.db   # redact, here
#
#   The sanitizer was real and its assertions held. It just ran one step too
#   late: by the time the first SSN was overwritten, a complete plaintext copy
#   of every SSN, EIN, bank routing and account number in the business was
#   already on a laptop's disk — and the intermediate lived in $TMPDIR, removed
#   by a `trap … EXIT` that a crash, a SIGKILL or a closed lid does not run.
#
#   So the redaction now happens on the VPS and only the redacted artifact
#   crosses the network:
#
#     1. gates       — locally, judging the LOCAL .env, before any connection
#     2. code        — git + npm + client build
#     3. sanitize    — ON THE VPS, into a mode-700 temp dir, asserted there
#     4. transfer    — the sanitized .gz only
#     5. clean       — remove the remote temp dir, always, pass or fail
#     6. verify      — re-assert on the received file, on this machine
#     7. install     — swap it in
#
#   Step 1 before step 3 is the load-bearing part: an .env that would boot
#   against the production sheet, or send real mail, or auto-submit invoices,
#   stops the run while the data is still on the server.
#
#   There is deliberately NO fall back to sanitizing locally. If step 3 cannot
#   run, that is a reason to stop, not a reason to copy the unredacted file and
#   redact it here — that is precisely the behaviour being removed.
# -----------------------------------------------------------------------------
set -euo pipefail

# Operator access — REFRESH_OPERATOR_PASSWORD (and REFRESH_OPERATOR_USER) —
# moves out of the environment FIRST, before this script runs a single
# command, and is handed only to the two LOCAL refresh-env.js calls that use
# it: the preflight and the install. Left exported, every child would inherit
# it: `npm install` runs third-party lifecycle scripts, and ssh would carry it
# toward the VPS. ⚠️ Keep these three lines above everything that starts a
# child, the `$(dirname …)` that finds APP_DIR below included.
# (scripts/test-refresh-sign-in.js pins both: nothing runs above them, and no
# command but those two refresh-env.js calls ever sees the value.)
OPERATOR_PASSWORD="${REFRESH_OPERATOR_PASSWORD-}"
OPERATOR_USER="${REFRESH_OPERATOR_USER-}"
unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER

VPS_HOST="${VPS_HOST:-root@76.13.22.110}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/abedubas_vps}"
PROD_BACKUPS="/var/www/logistics-app/backups"
PROD_APP_DIR="/var/www/logistics-app"
PROD_PM2_NAME="logistics-app"   # the pm2 process whose build $PROD_APP_DIR/node_modules is
LOCAL_SHEET_ID="156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0"   # "Dispatch Management (LOCAL)"
PROD_SHEET_ID="1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"

# /var/tmp, NOT /tmp. /tmp on this VPS is a 3.9 GB tmpfs and the box runs with
# swap already ~90% used; materializing a ~313 MB database there (plus SQLite's
# VACUUM scratch, plus the gzip output) would take ~700 MB out of RAM on a
# production host. /var/tmp is on /dev/sda1 with ~23 GB free and survives no
# worse — this directory is deleted explicitly, not by reboot semantics.
REMOTE_TMP_ROOT="${REMOTE_TMP_ROOT:-/var/tmp}"

say() { echo "[refresh-local] $*"; }
die() { echo "[refresh-local] FAILED: $*" >&2; exit 1; }

usage() {
  echo "usage: ./scripts/refresh-local.sh [--telemetry-days N | --telemetry-all] [--allow-mail] [--dry-run] [--no-backup]"
  echo "       ./scripts/refresh-local.sh --code-only      # code only: the database is left alone"
  echo "       ./scripts/refresh-local.sh --scan-legacy    # report pre-2026-08-09 unsanitized copies"
  echo "Operator access: REFRESH_OPERATOR_PASSWORD [REFRESH_OPERATOR_USER] in the ENVIRONMENT, never"
  echo "as an argument (scripts/README-env-refresh.md, 'Signing in to a refreshed copy')."
}
# Names the argument by POSITION only. Its text is never repeated: an argument
# this script does not know may be a password typed on the command line.
refuse_argument() {
  {
    echo "[refresh-local] FAILED: argument $1 is not an option refresh-local.sh accepts. Nothing was run."
    echo "[refresh-local]   It is not repeated here, in case it is a secret. If it is a password, treat it as"
    echo "[refresh-local]   exposed (argv lands in shell history and in ps) and choose another: the operator"
    echo "[refresh-local]   password is read from REFRESH_OPERATOR_PASSWORD in the ENVIRONMENT only."
    usage
  } >&2
  exit 1
}

# =============================================================================
# 0. ARGUMENTS — every one known, or the run stops before any command starts
#
# The database options are handed to refresh-env.js three times: the local
# preflight, the sanitize ON THE VPS (inside an ssh command, which the VPS's
# shell parses again) and the local install. So only options that mean the
# same thing to all three are accepted, and each crosses to the VPS quoted as
# exactly one word (REMOTE_EXTRA_ARGS, below). Anything else is refused here,
# while nothing has run: refresh-env.js skips an argument it does not know, so
# a mistyped --code-only would otherwise run a full refresh, and a bare word
# would be carried to the VPS in the ssh command line.
# (scripts/test-refresh-remote-node.js §7 runs every form.)
# =============================================================================
CODE_ONLY=0
SCAN_LEGACY=0
EXTRA_ARGS=()   # the database options, handed to refresh-env.js exactly as given
DB_OPTS=""      # the same, on one line, for the messages below
argn=0
while [ $# -gt 0 ]; do
  argn=$((argn + 1))
  case "$1" in
    --code-only)   CODE_ONLY=1 ;;
    --scan-legacy) SCAN_LEGACY=1 ;;
    -h|--help)     usage; exit 0 ;;
    --telemetry-all|--allow-mail|--dry-run|--no-backup)
      EXTRA_ARGS+=("$1"); DB_OPTS="$DB_OPTS $1" ;;
    --telemetry-days)
      case "${2-}" in
        ''|*[!0-9]*|??????*) die "--telemetry-days (argument $argn) takes a whole number of days, at most 5 digits, as the next argument: e.g. --telemetry-days 45." ;;
      esac
      EXTRA_ARGS+=("$1" "$2"); DB_OPTS="$DB_OPTS $1 $2"
      shift; argn=$((argn + 1)) ;;
    *) refuse_argument "$argn" ;;
  esac
  shift
done

if [ "$CODE_ONLY" = "1" ] && [ "$SCAN_LEGACY" = "1" ]; then
  die "--code-only and --scan-legacy are separate runs: pass one of them."
fi
if [ "$CODE_ONLY" = "1" ] || [ "$SCAN_LEGACY" = "1" ]; then
  if [ "$CODE_ONLY" = "1" ]; then ONLY_FLAG=--code-only; else ONLY_FLAG=--scan-legacy; fi
  [ -z "$DB_OPTS" ] || die "$ONLY_FLAG installs no database, so${DB_OPTS} would do nothing: drop them, or drop $ONLY_FLAG."
  # Operator access is applied only where a database is installed, which
  # neither of these does. Said rather than silently dropped, as refresh-env.js
  # says it in its own modes that install nothing.
  if [ -n "$OPERATOR_PASSWORD$OPERATOR_USER" ]; then
    say "WARNING: REFRESH_OPERATOR_PASSWORD / REFRESH_OPERATOR_USER are ignored with $ONLY_FLAG: operator access is applied only where a database is installed."
  fi
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -i "$VPS_KEY")
SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=20 -i "$VPS_KEY")

# =============================================================================
# --scan-legacy — the copies the OLD flow left behind
#
# Reports, never deletes. Removing a database this script did not create is not
# a decision a refresh script gets to make: one of these paths is your working
# app.db, another may be the only copy of a state someone is mid-debug on.
# =============================================================================
if [ "$SCAN_LEGACY" = "1" ]; then
  say "scanning for database copies of unknown provenance…"
  say ""
  say "1. full-database copies in \$TMPDIR, from TWO different producers:"
  say "   - prod-snapshot.gz / app.db.*.gz — intermediates of the old refresh flow"
  say "     (removed on a clean exit only; a crash, a SIGKILL or a closed lid kept them)"
  say "   - app_backup-*.db — the per-request temp copy GET /api/db/download makes"
  say "     (server.js, os.tmpdir(), app_backup-<ms>-<hex>.db). It is unlinked after"
  say "     a completed response, so every ABORTED download leaves one behind: a full"
  say "     ~313 MB unsanitized database each, gitignored so nothing else notices."
  find "${TMPDIR:-/tmp}" -maxdepth 3 \( -name 'prod-snapshot.gz' -o -name 'app.db.*.gz' -o -name 'app_backup-*.db' \) 2>/dev/null \
    | while read -r f; do echo "     $(du -h "$f" 2>/dev/null | cut -f1)  $f"; done || true
  say ""
  say "2. pre-refresh backups in this checkout (refresh-env.js renames the old"
  say "   app.db aside on every run; the FIRST one predates any sanitizing):"
  find "$APP_DIR" -maxdepth 1 -name 'app.db.pre-refresh-*' -o -maxdepth 1 -name 'app.db.bak*' 2>/dev/null \
    | while read -r f; do echo "     $(du -h "$f" 2>/dev/null | cut -f1)  $f"; done || true
  say ""
  say "3. the working database itself: $APP_DIR/app.db"
  say ""
  say "Classify any of them — read-only, prints no values, exits 1 if dirty:"
  say "    node scripts/refresh-env.js --verify <path>"
  say ""
  say "Then delete what --verify calls NOT sanitized. Deliberately not automatic:"
  say "see 'Already-downloaded copies' in scripts/README-env-refresh.md."
  exit 0
fi

# =============================================================================
# 1. GATES — locally, before a single connection is opened
# =============================================================================
if [ ! -f .env ]; then
  die ".env not found. Create one with SPREADSHEET_ID=$LOCAL_SHEET_ID before refreshing."
fi
CURRENT_SHEET="$(grep -E '^SPREADSHEET_ID=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
if [ -z "$CURRENT_SHEET" ]; then
  die ".env has no SPREADSHEET_ID — server.js would use the PRODUCTION sheet. Set SPREADSHEET_ID=$LOCAL_SHEET_ID"
fi
if [ "$CURRENT_SHEET" = "$PROD_SHEET_ID" ]; then
  die ".env points at the PRODUCTION sheet. Refusing."
fi
say "local sheet: $CURRENT_SHEET"

# The bash check above is a fast, readable duplicate of ONE gate. This is all
# three, run by the same code that will run them again at install time — sheet,
# mail-capability and INVOICE_AUTOGEN_ENABLED — and it happens here so a refusal
# costs nothing and, crucially, leaks nothing.
if [ "$CODE_ONLY" != "1" ]; then
  say "checking the target environment (sheet / mail / auto-invoice)…"
  # The operator password rides along so a too-short one is refused HERE,
  # before the VPS round trip rather than after it. So do the database options:
  # this preflight judges exactly the arguments the remote sanitize and the
  # install are handed (--allow-mail, above all), and anything refresh-env.js
  # refuses is refused on this machine, before any connection. (The parser at
  # the top has already refused every argument that is not one of them.)
  REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \
    node scripts/refresh-env.js --check-env-only --to "$APP_DIR/app.db" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
    || die "target environment gates refused. Nothing was copied. Fix .env and re-run."
fi

# =============================================================================
# 2. CODE
# =============================================================================
say "fetching origin…"
git fetch origin --prune
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  git pull --ff-only origin main
  say "main is now $(git rev-parse --short HEAD)"
else
  say "on branch '$BRANCH' — not pulling. origin/main is $(git rev-parse --short origin/main); rebase when ready."
fi

say "installing dependencies…"
npm install --silent --no-audit --no-fund
say "building client…"
npm run build:client --silent

if [ "$CODE_ONLY" = "1" ]; then
  say "--code-only: database left alone. Done."
  exit 0
fi

# =============================================================================
# 3. SANITIZE — on the VPS
# =============================================================================
say "locating the newest production snapshot…"
LATEST="$("${SSH[@]}" "$VPS_HOST" "ls -1t $PROD_BACKUPS/app.db.*.gz 2>/dev/null | head -1")"
[ -n "$LATEST" ] || die "no nightly snapshot found in $PROD_BACKUPS on $VPS_HOST"
say "snapshot: $LATEST"

# An abandoned temp dir holds an unsanitized copy. Report loudly; do not delete
# — this script is not the owner of somebody else's interrupted run.
STALE="$("${SSH[@]}" "$VPS_HOST" "find $REMOTE_TMP_ROOT -maxdepth 1 -name 'logisx-sanitize.*' -mmin +180 2>/dev/null | head -5" || true)"
if [ -n "$STALE" ]; then
  say "WARNING: abandoned sanitize directories on the VPS (each may hold a database copy):"
  echo "$STALE" | sed 's/^/                 /'
  say "         inspect, then: ssh <vps> 'rm -rf <dir>'"
fi

REMOTE_TMP="$("${SSH[@]}" "$VPS_HOST" "umask 077 && d=\$(mktemp -d $REMOTE_TMP_ROOT/logisx-sanitize.XXXXXXXX) && chmod 700 \"\$d\" && echo \"\$d\"")"
case "$REMOTE_TMP" in
  "$REMOTE_TMP_ROOT"/logisx-sanitize.*) : ;;
  *) die "unexpected remote temp path '$REMOTE_TMP' — refusing to continue (the cleanup below would rm it)." ;;
esac

# Cleanup is a local trap, not a remote one: a remote `trap … EXIT` only fires
# inside the ssh session that set it, so a dropped connection would leave the
# unsanitized working copy behind — the exact failure this change exists to fix.
cleanup_remote() {
  local rc=$?
  if [ -n "${REMOTE_TMP:-}" ]; then
    "${SSH[@]}" "$VPS_HOST" "rm -rf -- '$REMOTE_TMP'" >/dev/null 2>&1 \
      || echo "[refresh-local] WARNING: could not remove $REMOTE_TMP on the VPS — remove it by hand." >&2
  fi
  return $rc
}
trap cleanup_remote EXIT

say "remote workspace: $REMOTE_TMP (mode 700)"

# Ship THIS checkout's sanitizer rather than trusting the one deployed on the
# VPS. Production tracks main; a developer running this from a feature branch
# would otherwise sanitize with an older scrub list than the one their branch
# asserts against, and the mismatch would be invisible.
"${SCP[@]}" scripts/refresh-env.js "$VPS_HOST:$REMOTE_TMP/refresh-env.js" \
  || die "could not copy the sanitizer to $VPS_HOST"

# Preflight: the snapshot expands to roughly 5x its gzipped size, VACUUM needs
# about as much again, and the emitted artifact adds a compressed copy.
"${SSH[@]}" "$VPS_HOST" "
set -e
gz=\$(stat -c %s '$LATEST')
need=\$(( gz * 12 / 1024 ))                       # ~12x gzipped, in KiB
avail=\$(df -Pk '$REMOTE_TMP' | awk 'NR==2{print \$4}')
if [ \"\$avail\" -lt \"\$need\" ]; then
  echo \"[refresh-local] FAILED: need ~\$((need/1024)) MiB free for the sanitize, have \$((avail/1024)) MiB on $REMOTE_TMP_ROOT\" >&2
  exit 1
fi
" || die "remote disk preflight failed"

say "sanitizing on the VPS (nothing has been transferred yet)…"
REMOTE_ART="$REMOTE_TMP/sanitized.db.gz"
# node_modules as a symlink beside the script: `require` resolves from the
# script's own directory upward, so this is what makes better-sqlite3 and
# bcryptjs load without copying anything into the production tree.
#
# ⚠️ RESOLVE THE REMOTE INTERPRETER — a bare `node` over ssh is the WRONG node.
# The symlinked node_modules belongs to the production tree, where
# better-sqlite3 is compiled for the Node pm2 runs the app with (/opt/node22,
# ABI 127 since 2026-08-25). A non-login ssh PATH resolves `node` to
# /usr/bin/node — 20.20.1, ABI 115 — and opening the database dies with
# "NODE_MODULE_VERSION 127 ... requires 115", exactly as backup.sh did.
#
# ⚠️ AND THE FIRST FIX (#339) FAILED THE SAME WAY on 2026-09-25, for the two
# reasons backup.sh had already been fixed for in #366:
#   1. `pm2 jlist` prints every process on ONE line, so a greedy
#      `sed 's/.*"exec_interpreter":…/'` took the LAST process's interpreter —
#      another tenant's /usr/bin/node on this shared box. It had only worked
#      while a LogisX process happened to be last. => read $PROD_PM2_NAME BY
#      NAME, with a real JSON parse.
#   2. `require("better-sqlite3")` passed under that node, because the binding
#      loads lazily. => the probe OPENS an in-memory database.
# pick_node takes the first candidate that can open a database through this
# symlink, so a repin needs no edit here. It is refresh-staging.sh's block,
# sent as a quoted heredoc: nothing in it expands on this machine, so the VPS
# runs exactly this text. PICK_NODE is emptied first and checked after, so a
# heredoc that fails cannot leave an inherited value to run there. Fails
# closed — the || die below still guarantees nothing is transferred if no
# interpreter works.
PICK_NODE=''
IFS= read -r -d '' PICK_NODE <<'EOF_PICK_NODE' || true
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
EOF_PICK_NODE
case "$PICK_NODE" in
  *'pick_node() {'*) : ;;
  *) die "could not read the pick-node block (bash could not create a here-document). Nothing was transferred." ;;
esac
# The database options, each as ONE word for the VPS's shell. The command
# below is parsed again over there, so each is single-quoted (a ' inside is
# written '\''): refresh-env.js on the VPS then receives exactly the arguments
# the preflight did and the install will, whatever characters they hold.
# POSIX quoting on purpose: `printf %q` writes bash-only $'…' for some
# characters, and nothing here should depend on the remote login shell.
sq() {
  local q="'" s="$1" out="'" head
  while :; do
    case $s in
      *$q*)
        head=${s%%$q*}
        out="$out$head$q\\$q$q"
        s=${s#*$q}
        ;;
      *)
        out="$out$s$q"
        break
        ;;
    esac
  done
  printf '%s' "$out"
}
REMOTE_EXTRA_ARGS=""
for a in "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"; do
  REMOTE_EXTRA_ARGS="$REMOTE_EXTRA_ARGS $(sq "$a")"
done
"${SSH[@]}" "$VPS_HOST" "
set -e
umask 077
cd '$REMOTE_TMP'
ln -sfn '$PROD_APP_DIR/node_modules' node_modules
$PICK_NODE
NODE_BIN=\$(pick_node '$REMOTE_TMP' '$PROD_PM2_NAME') || {
  echo 'REFUSING: no node on the VPS can open a better-sqlite3 database from the production node_modules.' >&2
  echo '  fix: npm rebuild better-sqlite3 in $PROD_APP_DIR under the interpreter pm2 runs $PROD_PM2_NAME with.' >&2
  exit 1
}
echo \"[refresh] remote node: \$NODE_BIN (\$(\"\$NODE_BIN\" -v))\"
\"\$NODE_BIN\" refresh-env.js --sanitize-only --from '$LATEST' --emit '$REMOTE_ART'$REMOTE_EXTRA_ARGS
" || die "remote sanitize failed. NOTHING was transferred. Do not work around this by copying the raw snapshot."

# =============================================================================
# 4. TRANSFER — the sanitized artifact, and only it
# =============================================================================
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; cleanup_remote' EXIT
chmod 700 "$TMP"
say "downloading the sanitized artifact…"
"${SCP[@]}" "$VPS_HOST:$REMOTE_ART" "$TMP/sanitized.db.gz" || die "download failed"
say "received $(du -h "$TMP/sanitized.db.gz" | cut -f1)"

# =============================================================================
# 5/6. VERIFY on this machine, then INSTALL
# =============================================================================
say "verifying the received artifact…"
node scripts/refresh-env.js --verify "$TMP/sanitized.db.gz" \
  || die "the received artifact did not pass the sanitization assertions. It has NOT been installed."

say "installing…"
REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \
  node scripts/refresh-env.js --from "$TMP/sanitized.db.gz" --to "$APP_DIR/app.db" \
  --from-sanitized --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
unset OPERATOR_PASSWORD OPERATOR_USER

say ""
say "Done. Start the stack in two terminals:"
say "  SPREADSHEET_ID=$CURRENT_SHEET npm run dev"
say "  npm run dev:client"
say ""
say "Every account on the new copy has a random password nobody knows. Before"
say "running test-suite.js against it:  node scripts/prepare-test-fixtures.js --yes-local-db"
say ""
say "If you refreshed before 2026-08-09, this machine may still hold an"
say "UNSANITIZED copy from the old flow. Find them with:"
say "  ./scripts/refresh-local.sh --scan-legacy"
