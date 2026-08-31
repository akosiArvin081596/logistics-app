#!/bin/bash
# Nightly app.db backup (cron: 0 2 * * *).
#
# Delegates to scripts/backup-db.js. It previously did:
#
#     cp /var/www/logistics-app/app.db "$BACKUP_DIR/app.db.$(date ...)"
#
# app.db runs in WAL mode, so committed transactions sit in app.db-wal until a
# checkpoint. `cp` copies the main file only — not -wal, not -shm — so every
# snapshot could be stale AND internally inconsistent. When this was fixed the
# -wal file was 89 MB, i.e. that much committed data was missing from each
# backup, and nothing would have surfaced it until a restore.
#
# backup-db.js uses SQLite's Online Backup API (consistent snapshot of a live
# DB, WAL included), verifies it with PRAGMA integrity_check BEFORE keeping it,
# gzips it, and prunes >30 days. It exits non-zero on failure so failures land
# in backups/backup.log instead of passing silently.
set -uo pipefail

APP_DIR="/var/www/logistics-app"
cd "$APP_DIR" || { echo "[backup] FAILED: cannot cd to $APP_DIR"; exit 1; }

echo "[backup] ---- $(date '+%Y-%m-%d %H:%M:%S %Z') ----"

# ⚠️ A BARE `node` IS THE WRONG NODE ON THIS BOX, AND IT FAILS SILENTLY-ISH.
#
# cron's PATH resolves `node` to /usr/bin/node — 20.20.1, apt/nodesource, owned
# by the ~23 other tenants on this shared VPS, NOT by us. Since the 2026-08-25
# migration pm2 runs this app on /opt/node22 (22.23.2) and better-sqlite3 in
# ./node_modules is compiled for THAT ABI. Under the system node the require()
# dies at load:
#
#     NODE_MODULE_VERSION 127 ... this version of Node.js requires 115
#
# which is the same native-module ABI trap CLAUDE.md documents for the deploy,
# just pointing the other way. It cost SIX consecutive nightly backups
# (2026-08-26 .. 2026-08-31): the cron fired every night, the failure was real
# and non-zero, and it landed only in backups/backup.log, which nothing reads.
#
# So do not hardcode a path — CAPABILITY-TEST the candidates and take the first
# interpreter that can actually load the native module. That is self-correcting:
# repinning pm2, a Node upgrade, or a rebuild all keep working with no edit here,
# and it cannot drift the way a hardcoded /opt/node22 would.
pick_node() {
  local cand
  for cand in \
    "$(pm2 jlist 2>/dev/null | sed -n 's/.*"exec_interpreter":"\([^"]*\)".*/\1/p' | head -1)" \
    /opt/node22/bin/node \
    "$(command -v node 2>/dev/null)"
  do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if (cd "$APP_DIR" && "$cand" -e 'require("better-sqlite3")') >/dev/null 2>&1; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_node)" || {
  echo "[backup] FAILED: no node on this box can load better-sqlite3 from $APP_DIR/node_modules."
  echo "[backup]   tried pm2 exec_interpreter, /opt/node22/bin/node, and \$PATH node."
  echo "[backup]   fix: npm rebuild better-sqlite3 (under the interpreter pm2 runs the app with)."
  exit 1
}
echo "[backup] node: $NODE_BIN ($("$NODE_BIN" -v))"

# cd above matters: backup-db.js requires better-sqlite3 from ./node_modules.
"$NODE_BIN" "$APP_DIR/scripts/backup-db.js" --db "$APP_DIR/app.db" --out "$APP_DIR/backups" --keep-days 30
rc=$?
if [ $rc -ne 0 ]; then
  echo "[backup] backup FAILED with exit code $rc"
  exit $rc
fi
echo "[backup] completed: $(date)"
