#!/usr/bin/env bash
# npm run replica:pull [-- --force]
#
# Refreshes the local copy of production in ~/LogisX-replica/ (README "Local
# replica of production"): the database, every tab of the Google Sheets, the
# uploaded files and the non-secret settings, as of now.
#
#   LOGISX_PROD_SSH=<root@host or ssh config Host> [LOGISX_PROD_SSH_KEY=<identity file>] npm run replica:pull [-- --force]
#
# The production host is never written in this repository: it comes from
# LOGISX_PROD_SSH. Without --force a snapshot younger than 24 hours is kept.
#
# Production is only read, over one ssh connection the whole pull shares (a key
# that asks for Touch ID asks once; "the shared ssh connection" below). On the
# server, one program (scripts/replica/remote/, streamed over ssh's stdin, so
# nothing is deployed or installed there) works in a temporary folder,
# /root/logisx-replica-tmp/<stamp>/ (mode 700, umask 077):
#   1. the live app.db, copied read-only with VACUUM INTO (snapshot.js);
#   2. in that copy, sessions and stored tokens cleared (scrub.js); the
#      non-secret settings from .env (settings.js); every tab of the
#      spreadsheets, read with a spreadsheets.readonly client and the server's
#      own key, which never leaves the server (sheets-export.js); the manifest
#      (manifest.js); then app.db and sheets.json compressed with zstd level 6,
#      one thread, each original's size and SHA-256 recorded in compress.json
#      (compress.js).
# Then, from here:
#   3. the folder is downloaded with rsync, whole (compressed data leaves rsync
#      nothing to match), with a progress line;
#   4. the server's temporary folder is deleted, compressed files included, also
#      when any step fails or the pull is interrupted (a trap here, and one in
#      the server program);
#   5. the .zst files are decompressed here and must match the server's sizes
#      and SHA-256s, and the database must pass quick_check, before anything
#      replaces the clean snapshot (pull-local.js unpack, verify);
#   6. uploads/, storage/ and evidence-archive/ are copied with rsync (only what
#      changed, after the first time), with a progress line. They are updated in
#      place, so a pull that fails from here on says they may be newer than the
#      clean snapshot. The shared connection is closed after them;
#   7. the new snapshot replaces the clean one, then its settings are written to
#      ~/LogisX-replica/settings.env (mode 600). A pull interrupted between the
#      two renames of that swap puts the previous clean snapshot back.
# Everything local is mode 700/600. Only names and counts are printed: the
# progress lines never show a file name.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
ROOT="${HOME:?HOME is not set}/LogisX-replica"
APP="${LOGISX_PROD_APP_DIR:-/var/www/logistics-app}"
REMOTE_NODE="${LOGISX_PROD_NODE:-/opt/node22/bin/node}"
TMP_PARENT=/root/logisx-replica-tmp
MAX_AGE_HOURS=24
# Seconds the shared ssh connection stays open after its last session ends,
# when nothing closes it ("the shared ssh connection" below).
CONN_PERSIST_S=60
REMOTE_FILES=(replica-rules.js snapshot.js scrub.js settings.js sheets-export.js manifest.js compress.js)
EOF_MARK=__LOGISX_REPLICA_FILE__

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "replica:pull: $*" >&2; exit 1; }

FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done

[ -n "${LOGISX_PROD_SSH:-}" ] || die "set LOGISX_PROD_SSH to the production ssh destination (user@host); it is never stored in the repo"
case "$LOGISX_PROD_SSH" in *[!A-Za-z0-9@._:-]*|-*) die "LOGISX_PROD_SSH must look like user@host" ;; esac
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
if [ -n "${LOGISX_PROD_SSH_KEY:-}" ]; then
  KEY="${LOGISX_PROD_SSH_KEY/#\~/$HOME}"
  [ -f "$KEY" ] || die "LOGISX_PROD_SSH_KEY names no file"
  case "$KEY" in *[!A-Za-z0-9/._@+-]*) die "LOGISX_PROD_SSH_KEY: the path may hold letters, digits and / . _ @ + - only" ;; esac
  SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)
fi

# The copy lives outside the repo and outside Documents (iCloud), never inside a checkout.
case "$ROOT/" in "$REPO/"*) die "refusing: $ROOT is inside the repository" ;; esac
mkdir -p "$ROOT"
chmod 700 "$ROOT"
for d in clean logs uploads storage evidence-archive work; do mkdir -p "$ROOT/$d"; chmod 700 "$ROOT/$d"; done

NODE_BIN="$(command -v node)" || die "node is not on PATH (use the .nvmrc version: fnm use)"

# Fresh enough?
if [ "$FORCE" != 1 ] && [ -f "$ROOT/clean/manifest.json" ]; then
  AGE_MIN="$("$NODE_BIN" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(Math.floor((Date.now() - Date.parse(m.snapshotAt)) / 60000)));
  ' "$ROOT/clean/manifest.json" 2>/dev/null || echo "")"
  if [ -n "$AGE_MIN" ] && [ "$AGE_MIN" -lt $((MAX_AGE_HOURS * 60)) ]; then
    echo "replica:pull: the clean snapshot is fresh ($((AGE_MIN / 60)) h $((AGE_MIN % 60)) min old, under ${MAX_AGE_HOURS} h); nothing to do. Use --force to refresh it now."
    exit 0
  fi
fi

# The local steps need Node's zstd (22.15+) and the repo's better-sqlite3 built
# for this Node (its binary loads only when a database opens, so one is opened
# in memory): checked now, before production does any work.
"$NODE_BIN" -e 'if (typeof require("zlib").createZstdDecompress !== "function") process.exit(3); new (require(process.argv[1]))(":memory:").close();' "$REPO/node_modules/better-sqlite3" 2>/dev/null \
  || die "this Node ($("$NODE_BIN" -v)) can't run the local steps: they need zstd (Node 22.15+) and the better-sqlite3 built for the .nvmrc version (fnm use)"

# One pull at a time.
LOCK="$ROOT/.pull.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  other="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then die "another replica:pull (pid $other) is running"; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"

# Unique per run (time, then 8 random hex digits), in the shape the server
# program and the production-write guard accept.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
case "$STAMP" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) die "could not make a stamp" ;; esac
LOG="$ROOT/logs/pull-$STAMP.log"
INCOMING="$ROOT/clean.incoming"
REMOTE_STARTED=0
FILES_STARTED=0
SETTINGS_DONE=0
RESTORED=0
CONN_DIR=""
CONN_SOCK=""
START_TS=$(date +%s)

log() { echo "$*" | tee -a "$LOG"; }

# --- the shared ssh connection ----------------------------------------------------------
# One connection to production carries every ssh and rsync of the pull, so a
# key that asks for Touch ID asks once. It is OpenSSH's connection
# sharing, with each of its settings given on the command line so that nothing
# in ~/.ssh/config changes them:
#   - it is opened first (ControlMaster=yes, -N -f: no command, in the
#     background, in a session of its own, so a Ctrl-C reaches the pull and its
#     steps but not the connection the trap still needs). Every later ssh, and
#     rsync through -e, joins it (ControlMaster=no) by its socket;
#   - the socket is in a folder made for this pull (mktemp -d, mode 700) in
#     ~/LogisX-replica. While the socket exists, programs running as this user
#     can open sessions to production through it as well, so it exists only
#     while the pull runs: it is closed (ssh -O exit) and its folder removed
#     after the last upload, or by the trap once the trap's own server cleanup
#     has used it;
#   - a pull killed outright runs no trap: its connection then ends by itself
#     CONN_PERSIST_S seconds after its last session (ControlPersist), and the
#     next pull closes and removes any folder one left. 60 s is far above the
#     longest pause between two steps that use it (decompressing and checking
#     the database: under 1 s for 392 MiB, measured 2026-10-11);
#   - each step checks first that the connection is open, and the pull fails,
#     saying so, when it has closed (the network dropped, or no step ran for
#     CONN_PERSIST_S seconds). Only the trap's server cleanup then lets ssh make
#     a new connection (a second Touch ID), so the server's folder still goes;
#   - keepalive belongs to the connection, so it covers the downloads too:
#     after 15 s of quiet ssh asks the server for an answer, and it gives up
#     after 40 unanswered (10 minutes). rsync had no keepalive before, because a
#     download once went quiet long enough for a shorter limit to end it.
prod_ssh() {
  ssh "${SSH_OPTS[@]}" -o ControlMaster=no -o "ControlPath=${CONN_SOCK:-none}" "$@"
}
conn_open() {
  [ -n "$CONN_SOCK" ] && ssh "${SSH_OPTS[@]}" -o "ControlPath=$CONN_SOCK" -O check "$LOGISX_PROD_SSH" >/dev/null 2>&1
}
need_conn() {
  conn_open || die "the shared ssh connection to production closed before $1 (the network dropped, or no step ran for ${CONN_PERSIST_S} s); nothing was replaced. Run the pull again"
}
open_conn() {
  local t0
  t0=$(date +%s)
  CONN_DIR="$(mktemp -d "$ROOT/.pull-conn.XXXXXX")" || die "could not create a folder for the shared ssh connection"
  CONN_SOCK="$CONN_DIR/s"
  case "$CONN_SOCK" in *[!A-Za-z0-9/._-]*) die "the shared ssh connection's folder: the path to $ROOT may hold letters, digits and / . _ - only" ;; esac
  # ssh creates the socket at its path plus 17 characters and renames it, and
  # macOS takes a socket path of at most 103.
  [ "${#CONN_SOCK}" -le 86 ] || die "the shared ssh connection's socket path would be ${#CONN_SOCK} characters, over the 86 macOS allows: the path to $ROOT is too long"
  if ! ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o "ControlPath=$CONN_SOCK" -o "ControlPersist=$CONN_PERSIST_S" \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=40 -N -f "$LOGISX_PROD_SSH" </dev/null >/dev/null 2>"$CONN_DIR/open.err" \
      || ! conn_open; then
    "$NODE_BIN" "$HERE/pull-local.js" progress ssh "$LOG" <"$CONN_DIR/open.err" || true
    die "could not open the ssh connection to production (Touch ID declined or timed out, the key refused, or the host unreachable)"
  fi
  rm -f "$CONN_DIR/open.err"
  RSH="ssh ${SSH_OPTS[*]} -o ControlMaster=no -o ControlPath=$CONN_SOCK"
  log "shared ssh connection open: $(( $(date +%s) - t0 )) s; every step below uses it"
}
close_conn() {
  [ -n "$CONN_DIR" ] || return 0
  if [ -n "$CONN_SOCK" ] && ssh "${SSH_OPTS[@]}" -o "ControlPath=$CONN_SOCK" -O exit "$LOGISX_PROD_SSH" >/dev/null 2>&1; then
    log "shared ssh connection closed"
  fi
  rm -rf -- "$CONN_DIR"
  CONN_DIR=""
  CONN_SOCK=""
}
# A folder a killed pull left (no trap ran): its connection, if still open, is
# closed and the folder goes. This pull holds the lock, so none is in use.
sweep_conn_dirs() {
  local d n=0
  for d in "$ROOT"/.pull-conn.*; do
    case "${d##*/}" in *[!A-Za-z0-9._-]*) continue ;; esac
    if [ ! -d "$d" ] || [ -L "$d" ]; then continue; fi
    ssh "${SSH_OPTS[@]}" -o "ControlPath=$d/s" -O exit "$LOGISX_PROD_SSH" >/dev/null 2>&1 || true
    rm -rf -- "$d"
    n=$((n + 1))
  done
  if [ "$n" != 0 ]; then log "removed $n shared ssh connection folder(s) a stopped pull left"; fi
}

# Removes the server's temporary folder and confirms it is gone; returns
# non-zero when it cannot confirm that, which fails the pull.
remote_cleanup() {
  if prod_ssh "$LOGISX_PROD_SSH" "rm -rf -- '$TMP_PARENT/$STAMP'; rmdir -- '$TMP_PARENT' 2>/dev/null; test ! -e '$TMP_PARENT/$STAMP'" </dev/null; then
    echo "replica:pull: the server's temporary folder is removed"
    return 0
  fi
  echo "replica:pull: ERROR: could not confirm the server's temporary folder $TMP_PARENT/$STAMP is removed (the next pull removes it once it is an hour old)" >&2
  return 1
}
new_snapshot_in_place() {
  grep -qsF "\"$STAMP\"" "$ROOT/clean/manifest.json"
}
# What a failed pull left in place, for its last line.
failure_outcome() {
  local s
  if new_snapshot_in_place; then
    if [ "$SETTINGS_DONE" = 1 ]; then echo "the new clean snapshot and its settings are in place"
    else echo "the new clean snapshot is in place, but settings.env is still the previous pull's (run the pull again with --force)"; fi
    return 0
  fi
  case "$RESTORED" in
    1) s="the swap was interrupted, so the previous clean snapshot was put back; settings.env was left as it was" ;;
    failed) s="clean/ is missing and could not be put back: the previous clean snapshot is in clean.old/" ;;
    *) s="the clean snapshot and settings.env were left as they were" ;;
  esac
  if [ "$FILES_STARTED" = 1 ]; then s="$s; uploads/, storage/ and evidence-archive/ were being updated and may be newer than the snapshot"; fi
  echo "$s"
}
on_exit() {
  rc=$?
  if [ "$REMOTE_STARTED" = 1 ]; then
    conn_open || echo "replica:pull: the shared ssh connection has closed; removing the server's temporary folder takes a new one (Touch ID)" >&2
    remote_cleanup || rc=1
  fi
  close_conn
  # Interrupted between the swap's two renames: the previous snapshot goes back.
  if [ ! -e "$ROOT/clean" ] && [ -d "$ROOT/clean.old" ]; then
    if mv "$ROOT/clean.old" "$ROOT/clean"; then RESTORED=1; else RESTORED=failed; fi
  fi
  if [ "$rc" != 0 ]; then
    rm -rf "$INCOMING"
    if new_snapshot_in_place; then rm -rf "$ROOT/clean.old"; fi
    echo "replica:pull: FAILED (exit $rc); $(failure_outcome). Log: $LOG" >&2
  fi
  rm -rf "$LOCK"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

log "replica:pull $STAMP: production $APP over ssh (destination from LOGISX_PROD_SSH)"

# --- 1-2: the server program ---------------------------------------------------
remote_program() {
  printf 'STAMP=%s\nAPP=%s\nNODE=%s\nTMP_PARENT=%s\n' "$STAMP" "$APP" "$REMOTE_NODE" "$TMP_PARENT"
  cat "$HERE/remote/begin.sh"
  for f in "${REMOTE_FILES[@]}"; do
    src="$HERE/remote/$f"
    [ "$f" = replica-rules.js ] && src="$REPO/lib/replica-rules.js"
    if grep -q "$EOF_MARK" "$src"; then echo "replica:pull: $f contains the here-document marker" >&2; return 1; fi
    printf "cat > \"\$TMP/%s\" <<'%s'\n" "$f" "$EOF_MARK"
    cat "$src"
    printf '\n%s\n' "$EOF_MARK"
  done
  cat "$HERE/remote/finish.sh"
}
case "$APP$REMOTE_NODE" in *[!A-Za-z0-9/._-]*) die "LOGISX_PROD_APP_DIR / LOGISX_PROD_NODE: paths may hold letters, digits and / . _ - only" ;; esac
sweep_conn_dirs
open_conn
T0=$(date +%s)
REMOTE_STARTED=1
remote_program | prod_ssh "$LOGISX_PROD_SSH" 'bash -s' 2>&1 | tee -a "$LOG"
log "server steps: $(( $(date +%s) - T0 )) s"

# --- 3: download --------------------------------------------------------------------
# rsync's progress goes through pull-local.js progress: one status line, no
# file names; its stats and errors reach the log.
T0=$(date +%s)
need_conn "the download"
rm -rf "$INCOMING"
mkdir -p "$INCOMING"
chmod 700 "$INCOMING"
rsync -rlt --delete --stats --progress --exclude="*.js" -e "$RSH" "$LOGISX_PROD_SSH:$TMP_PARENT/$STAMP/" "$INCOMING/" 2>&1 | "$NODE_BIN" "$HERE/pull-local.js" progress download "$LOG"
chmod -R go-rwx "$INCOMING"
log "download: $(( $(date +%s) - T0 )) s"

# --- 4: the server's temporary folder goes now (and in the trap on any failure) --------
need_conn "removing the server's temporary folder"
remote_cleanup 2>&1 | tee -a "$LOG"
REMOTE_STARTED=0

# --- 5: decompressed and checked against the server's checksums before it replaces the clean snapshot
"$NODE_BIN" "$HERE/pull-local.js" unpack "$INCOMING" 2>&1 | tee -a "$LOG"
"$NODE_BIN" "$HERE/pull-local.js" verify "$INCOMING" 2>&1 | tee -a "$LOG"

# --- 6: uploaded files, updated in place; then the shared connection closes ------------
T0=$(date +%s)
for d in uploads storage evidence-archive; do
  need_conn "copying $d/"
  FILES_STARTED=1
  rsync -rlt --delete --stats --progress -e "$RSH" "$LOGISX_PROD_SSH:$APP/$d/" "$ROOT/$d/" 2>&1 | "$NODE_BIN" "$HERE/pull-local.js" progress "$d/" "$LOG"
  chmod -R go-rwx "$ROOT/$d"
done
log "files: $(( $(date +%s) - T0 )) s"
close_conn

# --- 7: the swap, then the settings ----------------------------------------------------------
"$NODE_BIN" "$HERE/pull-local.js" finish "$INCOMING" | tee -a "$LOG"
rm -rf "$ROOT/clean.old"
mv "$ROOT/clean" "$ROOT/clean.old"
mv "$INCOMING" "$ROOT/clean"
install -m 600 "$ROOT/clean/settings.env" "$ROOT/settings.env"
SETTINGS_DONE=1
rm -rf "$ROOT/clean.old"
chmod -R go-rwx "$ROOT"
log "replica:pull $STAMP done in $(( $(date +%s) - START_TS )) s; clean snapshot: $ROOT/clean"
