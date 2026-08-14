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
# cd above matters: backup-db.js requires better-sqlite3 from ./node_modules.
node "$APP_DIR/scripts/backup-db.js" --db "$APP_DIR/app.db" --out "$APP_DIR/backups" --keep-days 30
rc=$?
if [ $rc -ne 0 ]; then
  echo "[backup] backup FAILED with exit code $rc"
  exit $rc
fi
echo "[backup] completed: $(date)"
