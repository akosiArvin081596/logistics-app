# replica:pull, the start of the program the server runs (bash, read from ssh's
# stdin; scripts/replica/pull.sh streams it: the variables below, this file, the
# step scripts as here-documents, then finish.sh). Nothing is installed or left
# on the server: everything happens in one temporary folder, created mode 700
# with umask 077, and a trap removes that folder if any step fails. On success
# the folder stays for pull.sh to download, and pull.sh removes it afterwards
# (its own trap does that even when the download fails).
#
# Set by pull.sh before this file: STAMP, APP, NODE, TMP_PARENT.
set -euo pipefail
umask 077
case "$STAMP" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) echo "replica-remote: bad stamp" >&2; exit 2 ;;
esac
[ "$TMP_PARENT" = /root/logisx-replica-tmp ] || { echo "replica-remote: unexpected temporary folder" >&2; exit 2; }
TMP="$TMP_PARENT/$STAMP"
REPLICA_REMOTE_OK=0
replica_remote_cleanup() {
  rc=$?
  if [ "$REPLICA_REMOTE_OK" != 1 ]; then
    rm -rf -- "$TMP"
    rmdir -- "$TMP_PARENT" 2>/dev/null || true
    echo "replica-remote: a step failed; the temporary folder was removed" >&2
  fi
  exit "$rc"
}
trap replica_remote_cleanup EXIT
trap 'exit 130' INT TERM HUP
[ -f "$APP/app.db" ] || { echo "replica-remote: no database at $APP/app.db" >&2; exit 2; }
[ -x "$NODE" ] || { echo "replica-remote: no node at $NODE" >&2; exit 2; }
# A folder an earlier pull could not remove (its connection dropped before its
# cleanup ran) goes now: only stamp-named folders directly in $TMP_PARENT,
# never a symlink, and only when older than 6 hours, so a pull still running
# elsewhere keeps its own.
if [ -d "$TMP_PARENT" ] && [ ! -L "$TMP_PARENT" ]; then
  stale=0
  while IFS= read -r -d '' old; do
    name="${old##*/}"
    case "$name" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) continue ;; esac
    [ -L "$old" ] && continue
    rm -rf -- "$old"
    stale=$((stale + 1))
  done < <(find "$TMP_PARENT" -mindepth 1 -maxdepth 1 -type d -mmin +360 -print0)
  [ "$stale" = 0 ] || echo "replica-remote: removed $stale stale temporary folder(s) left by earlier pulls"
fi
mkdir -p -m 700 -- "$TMP_PARENT"
mkdir -m 700 -- "$TMP"
echo "replica-remote: temporary folder created ($TMP)"
