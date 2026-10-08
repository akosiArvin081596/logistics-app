#!/usr/bin/env bash
# npm run replica:pull [-- --force]
#
# Refreshes the local copy of production in ~/LogisX-replica/ (README "Local
# replica of production"): the database, every tab of the Google Sheets, the
# uploaded files and the non-secret settings, as of now.
#
#   LOGISX_PROD_SSH=<user@host> [LOGISX_PROD_SSH_KEY=<identity file>] npm run replica:pull [-- --force]
#
# The production host is never written in this repository: it comes from
# LOGISX_PROD_SSH. Without --force a snapshot younger than 24 hours is kept.
#
# Production is only read. On the server, one program (scripts/replica/remote/,
# streamed over ssh's stdin, so nothing is deployed or installed there) works in
# a temporary folder, /root/logisx-replica-tmp/<stamp>/ (mode 700, umask 077):
#   1. the live app.db, copied read-only with VACUUM INTO (snapshot.js);
#   2. in that copy, sessions and stored tokens cleared (scrub.js); the
#      non-secret settings from .env (settings.js); every tab of the
#      spreadsheets, read with a spreadsheets.readonly client and the server's
#      own key, which never leaves the server (sheets-export.js); the manifest
#      (manifest.js).
# Then, from here:
#   3. the folder is downloaded with rsync into ~/LogisX-replica/clean/ (only
#      what changed, after the first time);
#   4. the server's temporary folder is deleted, also when any step fails (a
#      trap here, and one in the server program);
#   5. uploads/, storage/ and evidence-archive/ are copied with rsync (only what
#      changed, after the first time);
#   6. the settings are written to ~/LogisX-replica/settings.env (mode 600).
# Everything local is mode 700/600. Only names and counts are printed.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
ROOT="${HOME:?HOME is not set}/LogisX-replica"
APP="${LOGISX_PROD_APP_DIR:-/var/www/logistics-app}"
REMOTE_NODE="${LOGISX_PROD_NODE:-/opt/node22/bin/node}"
TMP_PARENT=/root/logisx-replica-tmp
MAX_AGE_HOURS=24
REMOTE_FILES=(replica-rules.js snapshot.js scrub.js settings.js sheets-export.js manifest.js)
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
# rsync gets no keepalive options: openrsync can go quiet long enough on a large
# file for ssh to call the server unresponsive. The server program gets them.
RSH="ssh ${SSH_OPTS[*]}"
SSH_OPTS+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=8)

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
START_TS=$(date +%s)

# Removes the server's temporary folder and confirms it is gone; returns
# non-zero when it cannot confirm that, which fails the pull.
remote_cleanup() {
  if ssh "${SSH_OPTS[@]}" "$LOGISX_PROD_SSH" "rm -rf -- '$TMP_PARENT/$STAMP'; rmdir -- '$TMP_PARENT' 2>/dev/null; test ! -e '$TMP_PARENT/$STAMP'" </dev/null; then
    echo "replica:pull: the server's temporary folder is removed"
    return 0
  fi
  echo "replica:pull: ERROR: could not confirm the server's temporary folder $TMP_PARENT/$STAMP is removed (the next pull removes it once it is 6 hours old)" >&2
  return 1
}
on_exit() {
  rc=$?
  if [ "$REMOTE_STARTED" = 1 ] && ! remote_cleanup; then rc=1; fi
  if [ "$rc" != 0 ]; then rm -rf "$INCOMING"; echo "replica:pull: FAILED (exit $rc); the clean snapshot was left as it was. Log: $LOG" >&2; fi
  rm -rf "$LOCK"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

log() { echo "$*" | tee -a "$LOG"; }
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
T0=$(date +%s)
REMOTE_STARTED=1
remote_program | ssh "${SSH_OPTS[@]}" "$LOGISX_PROD_SSH" 'bash -s' 2>&1 | tee -a "$LOG"
log "server steps: $(( $(date +%s) - T0 )) s"

# --- 3: download --------------------------------------------------------------------
T0=$(date +%s)
rm -rf "$INCOMING"
mkdir -p "$INCOMING"
chmod 700 "$INCOMING"
# Seeded with the last snapshot (an APFS clone, no extra space) so rsync sends only what changed.
if [ -n "$(ls -A "$ROOT/clean" 2>/dev/null)" ]; then cp -cR "$ROOT/clean/." "$INCOMING/" 2>/dev/null || cp -R "$ROOT/clean/." "$INCOMING/"; fi
rsync -rlt --delete --stats --exclude="*.js" -e "$RSH" "$LOGISX_PROD_SSH:$TMP_PARENT/$STAMP/" "$INCOMING/" 2>&1 | tee -a "$LOG"
chmod -R go-rwx "$INCOMING"
log "download: $(( $(date +%s) - T0 )) s"

# --- 4: the server's temporary folder goes now (and in the trap on any failure) --------
remote_cleanup 2>&1 | tee -a "$LOG"
REMOTE_STARTED=0

# The download is whole before it replaces the clean snapshot.
"$NODE_BIN" "$HERE/pull-local.js" verify "$INCOMING" | tee -a "$LOG"

# --- 5: uploaded files ---------------------------------------------------------------
T0=$(date +%s)
for d in uploads storage evidence-archive; do
  rsync -rlt --delete --stats -e "$RSH" "$LOGISX_PROD_SSH:$APP/$d/" "$ROOT/$d/" 2>&1 | tee -a "$LOG"
  chmod -R go-rwx "$ROOT/$d"
done
log "files: $(( $(date +%s) - T0 )) s"

# --- 6: settings, and the swap -------------------------------------------------------------
install -m 600 "$INCOMING/settings.env" "$ROOT/settings.env"
"$NODE_BIN" "$HERE/pull-local.js" finish "$INCOMING" | tee -a "$LOG"
rm -rf "$ROOT/clean.old"
mv "$ROOT/clean" "$ROOT/clean.old"
mv "$INCOMING" "$ROOT/clean"
rm -rf "$ROOT/clean.old"
chmod -R go-rwx "$ROOT"
log "replica:pull $STAMP done in $(( $(date +%s) - START_TS )) s; clean snapshot: $ROOT/clean"
