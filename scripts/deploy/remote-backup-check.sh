#!/bin/bash
# Reports whether the nightly app.db snapshot is actually fresh and usable.
# Runs ON THE VPS. Inputs (env): DIR. Strictly read-only.
#
# ⚠️ WHY THIS EXISTS. backup.sh can only ever report a failure into
# backups/backup.log, and nothing reads that file. It has now cost TWO silent
# outages of the only backup of a 411 MB database holding every SSN, EIN and
# bank routing number:
#     2026-08-26..08-31  six nights   (cron PATH resolved the wrong Node)
#     2026-09-15..09-19  five nights  (pm2 jlist picked another tenant's Node)
# Both were fixed in backup.sh. Neither fix makes the NEXT cause self-reporting,
# which is the whole point of checking snapshot age from OUTSIDE the box.
#
# Prints BACKUP_*=... lines for the workflow to parse.
set -uo pipefail
: "${DIR:?}"
BK="$DIR/backups"
# cron is 02:00 daily and this runs at 04:00, so after a missed night the newest
# snapshot is ~25h59m old — 25 in the whole hours AGE_H floors to. A limit of 26
# let that pass, and caught the miss a day late.
MAX_AGE_H=${MAX_AGE_H:-25}
MIN_BYTES=${MIN_BYTES:-1048576} # a real snapshot is ~68 MB gzipped

cd "$BK" 2>/dev/null || { echo "BACKUP_STATE=missing"; echo "BACKUP_REASON=no backups dir at $BK"; exit 0; }

# Newest scheduled snapshot. Deliberately matches only the dated nightly shape
# (app.db.YYYYMMDD_HHMMSS.gz) so a PINNED pre-operation snapshot in
# .retention-keep can never masquerade as a fresh nightly one.
NEWEST=$(ls -1t app.db.[0-9]*_[0-9]*.gz 2>/dev/null | head -1)
if [ -z "$NEWEST" ]; then
	echo "BACKUP_STATE=missing"
	echo "BACKUP_REASON=no app.db.<date>_<time>.gz in $BK"
	exit 0
fi

NOW=$(date +%s)
MTIME=$(stat -c %Y "$NEWEST" 2>/dev/null || echo 0)
AGE_H=$(( (NOW - MTIME) / 3600 ))
SIZE=$(stat -c %s "$NEWEST" 2>/dev/null || echo 0)
PREV=$(ls -1t app.db.[0-9]*_[0-9]*.gz 2>/dev/null | sed -n 2p)
PREV_SIZE=$(stat -c %s "$PREV" 2>/dev/null || echo 0)

# Last outcome recorded by backup.sh, so the alarm can say WHY, not just "stale".
# ⚠️ Read the LAST RUN BLOCK, not a count over the tail. A hand-run snapshot
# (someone ssh'ing in and running backup.sh) makes the newest file look fresh
# while the 02:00 cron is still broken — which is the exact state this box was
# in on 2026-09-19. That must still alarm, hence BACKUP_STATE=degraded below.
LAST_RUN=$(grep -E '^\[backup\] ---- ' backup.log 2>/dev/null | tail -1 | sed 's/^\[backup\] ---- //;s/ ----$//')
LAST_NODE=$(grep -E '^\[backup\] node: ' backup.log 2>/dev/null | tail -1 | sed 's/^\[backup\] node: //')
LAST_BLOCK=$(awk '/^\[backup\] ---- /{buf=""} {buf=buf"\n"$0} END{print buf}' backup.log 2>/dev/null || true)
# A failure is written TWO ways: "[backup] FAILED: <why>" (backup-db.js, or
# backup.sh when it cannot even start — no node that loads better-sqlite3, no
# app dir) and "[backup] backup FAILED with exit code N" (backup.sh, after the
# snapshot step fails). Match both. `[]]` is a literal "]" in POSIX EREs, for
# grep and awk alike, without the stray-backslash warning newer GNU grep prints
# for `\]`.
FAILED_RE='[]] (backup )?FAILED'
if printf '%s' "$LAST_BLOCK" | grep -qE "$FAILED_RE"; then
	LAST_OK=no
elif printf '%s' "$LAST_BLOCK" | grep -q '^\[backup\] completed:'; then
	LAST_OK=yes
else
	LAST_OK=unknown
fi
# Failed RUNS, not failure lines: a snapshot that fails writes both lines above
# into the same run, so lines are grouped by the run header and a run counts once.
COUNT_FAILED_RUNS='/^\[backup\] ---- /{ n += bad; bad = 0; next } /[]] (backup )?FAILED/{ bad = 1 } END{ print n + bad }'
# No log: mawk prints nothing, gawk still runs END and prints 0 — both end as 0.
FAILS=$(awk "$COUNT_FAILED_RUNS" backup.log 2>/dev/null)
FAILS=${FAILS:-0}

echo "BACKUP_NEWEST=$NEWEST"
echo "BACKUP_AGE_HOURS=$AGE_H"
echo "BACKUP_SIZE=$SIZE"
echo "BACKUP_PREV_SIZE=$PREV_SIZE"
echo "BACKUP_LAST_RUN=$LAST_RUN"
echo "BACKUP_LAST_NODE=$LAST_NODE"
echo "BACKUP_LAST_RUN_OK=$LAST_OK"
echo "BACKUP_TOTAL_FAILURES=$FAILS"

if [ "$AGE_H" -ge "$MAX_AGE_H" ]; then
	echo "BACKUP_STATE=stale"
	echo "BACKUP_REASON=newest snapshot is ${AGE_H}h old (limit ${MAX_AGE_H}h); last logged run $LAST_RUN used $LAST_NODE"
elif [ "$SIZE" -lt "$MIN_BYTES" ]; then
	echo "BACKUP_STATE=too-small"
	echo "BACKUP_REASON=newest snapshot is ${SIZE} bytes (floor ${MIN_BYTES})"
elif ! gzip -t "$NEWEST" 2>/dev/null; then
	# Catches a truncated write that age and size both pass.
	echo "BACKUP_STATE=corrupt"
	echo "BACKUP_REASON=gzip -t failed on $NEWEST"
elif [ "$LAST_OK" = "no" ]; then
	# Fresh file, broken schedule — someone ran it by hand. Still an alarm.
	echo "BACKUP_STATE=degraded"
	echo "BACKUP_REASON=$NEWEST is fresh (${AGE_H}h) but the last SCHEDULED run at $LAST_RUN FAILED using $LAST_NODE — cron is still broken"
else
	echo "BACKUP_STATE=fresh"
	echo "BACKUP_REASON=${NEWEST} is ${AGE_H}h old, $((SIZE/1048576)) MB, gzip ok; last scheduled run $LAST_RUN succeeded"
fi
