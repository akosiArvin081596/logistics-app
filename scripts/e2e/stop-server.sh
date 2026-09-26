#!/usr/bin/env bash
# Stop the server boot-server.sh started on <port>: that recorded PID only, never pkill.
#   scripts/e2e/stop-server.sh <port>
# Env: NODE_BIN (default: node on PATH), E2E_WORK_DIR (where boot-server.sh wrote the pid file).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
PORT="${1:?usage: stop-server.sh <port>}"
WORK="$("$NODE_BIN" "$HERE/paths.cjs" work-dir)"
PIDFILE="$WORK/server-$PORT.pid"
[ -f "$PIDFILE" ] || { echo "stop-server: no pid file for port $PORT in $WORK; nothing killed"; exit 1; }
PID="$(sed -n 1p "$PIDFILE")"
WT="$(sed -n 2p "$PIDFILE")"
case "$PID" in ''|*[!0-9]*) echo "stop-server: $PIDFILE holds no PID; nothing killed"; exit 1;; esac

# Kill it only while that PID is still OUR server: a server.js process whose
# working directory is the worktree it was booted from. PIDs get reused, and
# other worktrees run their own `node server.js`.
CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
if [[ "$CMD" == *server.js* ]] && [ -n "$WT" ] && [ "$CWD" = "$WT" ]; then
  kill "$PID"
  # Gone, or a zombie (it has exited; only its parent has not reaped it yet).
  gone() { case "$(ps -p "$PID" -o stat= 2>/dev/null || true)" in ''|Z*) return 0;; *) return 1;; esac; }
  for _ in $(seq 1 20); do gone && break; sleep 0.5; done
  if ! gone; then echo "stop-server: pid $PID is still alive after SIGTERM; pid file kept" >&2; exit 1; fi
  echo "stopped pid $PID (port $PORT, $WT)"
else
  echo "stop-server: pid $PID is no longer the server booted from ${WT:-?} (command: ${CMD:-none}; cwd: ${CWD:-none}); nothing killed"
fi
rm -f "$PIDFILE"
