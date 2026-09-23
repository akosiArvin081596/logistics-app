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
PM2_APP_NAME="logistics-app"   # matched exactly — never restart/select by numeric id on this shared box
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
#
# ⚠️ AND IT HAPPENED AGAIN — 2026-09-15..09-19, five nights — for two NEW reasons
# the version above could not catch. Both are fixed below; keep BOTH.
#
#   1. `pm2 jlist` prints the entire process array on ONE line, so
#      `sed -n 's/.*"exec_interpreter":"\([^"]*\)".*/\1/p'` was greedy: `.*` ate
#      as much as it could and the capture landed on an ARBITRARY entry, not
#      ours. On this shared box that resolved to /usr/bin/node (v20) — an
#      interpreter belonging to one of the ~23 OTHER tenants. `logistics-app`
#      sat at index 6 with /opt/node22/bin/node and was never consulted. It had
#      worked until 09-14 purely on pm2 list ordering, which then shifted.
#      => Select OUR process BY NAME, with a real JSON parse. Parsing JSON needs
#         no native module, so any node on the box can safely do that step.
#
#   2. The capability test was too shallow. `require("better-sqlite3")` PASSES
#      under the wrong Node, because the native binding loads LAZILY — only
#      `new Database()` trips the ABI error, which is exactly what backup-db.js
#      then does. Measured 2026-09-19:
#         /usr/bin/node        v20.20.1   require() PASS   new Database() FAIL
#         /opt/node22/bin/node v22.23.2   require() PASS   new Database() PASS
#      => OPEN A DATABASE in the probe, don't just require the module.
#
# Neither fix makes this self-reporting. That is deliberately NOT this script's
# job: .github/workflows/backup-freshness.yml watches snapshot age from outside
# the box, because a failure here can only ever land in backups/backup.log --
# and as both outages proved, nothing reads that.

# Any node can parse JSON; that needs no native module, so it is safe to use
# before we know which interpreter is the right one.
json_node() {
  local n
  for n in /opt/node22/bin/node "$(command -v node 2>/dev/null)"; do
    [ -n "$n" ] && [ -x "$n" ] && { echo "$n"; return 0; }
  done
  return 1
}

# cron's PATH usually cannot see pm2 — look in the usual places before giving up.
pm2_bin() {
  local p
  for p in "$(command -v pm2 2>/dev/null)" /usr/local/bin/pm2 /usr/bin/pm2 /opt/node22/bin/pm2; do
    [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# The interpreter pm2 actually runs OUR app with — matched BY NAME, never by position.
pm2_interpreter() {
  local pb jn
  pb="$(pm2_bin)" || return 1
  jn="$(json_node)" || return 1
  "$pb" jlist 2>/dev/null | "$jn" -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const want = process.argv[1];
        const proc = JSON.parse(s).find((p) => p && p.name === want);
        const interp = proc && proc.pm2_env && proc.pm2_env.exec_interpreter;
        if (interp && interp !== "none") process.stdout.write(String(interp));
      } catch { /* pm2 absent or bad JSON — fall through to the next candidate */ }
    });' "$PM2_APP_NAME"
}

pick_node() {
  local cand
  for cand in \
    "$(pm2_interpreter)" \
    /opt/node22/bin/node \
    "$(command -v node 2>/dev/null)"
  do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    # ⚠️ OPEN a database. `require()` alone passes under an ABI-mismatched Node.
    if (cd "$APP_DIR" && "$cand" -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1; then
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
