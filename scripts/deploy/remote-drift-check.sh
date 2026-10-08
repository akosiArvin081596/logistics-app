#!/bin/bash
# Reports whether a deployed app is behind origin/main, and whether it is safe
# to heal automatically AS FAR AS THE BOX CAN TELL. Runs ON THE VPS.
# Inputs (env): DIR, PM2
#
# Prints DRIFT_*=... lines for the workflow to parse. Read-only: it never writes
# the marker it reads, nor the verified-deploy record. The one file it writes is
# its holder note in the deploy lock file, while it holds the lock (below).
#
# ⚠️ `behind-healable` is the box's view only, NOT permission to heal: the box
# cannot see whether main's commit passed staging.
# scripts/deploy/drift-gate.js asks GitHub before any heal.
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"
cd "$DIR" || exit 1

# main's tip, read without writing anything into the clone (no fetch), bounded
# at 30 s where timeout(1) exists. ls-remote matches a pattern against ref
# TAILS, so refs/heads/a/refs/heads/main would match too: only the exact ref
# counts, and a remote lists each ref once. (No `exit` in the awk program:
# scripts/test-deploy-scripts.js §11 reads every `exit` in this file.)
ls_main() {
	if command -v timeout >/dev/null 2>&1; then
		timeout 30 git ls-remote origin refs/heads/main
	else
		git ls-remote origin refs/heads/main
	fi
}
REMOTE=$(ls_main 2>/dev/null | awk '$2=="refs/heads/main"{print $1}')
# ⚠️ No stand-in. Compared with the clone's last-fetched origin/main, a box
# that cannot reach origin would read as in-sync while main moved on. And a box
# that cannot reach origin cannot fetch for its next deploy either: an alarm.
if ! [[ "$REMOTE" =~ ^[0-9a-f]{40}$ ]]; then
	echo "could not read main's tip from origin (git ls-remote)"
	echo "DRIFT_STATE=remote-unreadable"
	exit 0
fi

# ⚠️ THE DEPLOY LOCK. The drift check has its own queue in Actions
# (deploy-drift.yml, invariant 1), so it can run while a deploy of this
# directory is mid-flight, with HEAD and the records half-changed. So it reads
# them under the box lock every deploy, rollback and record step takes: the
# same LOCK_FILE as remote-deploy.sh's deploy-lock block
# (scripts/test-deploy-scripts.js pins the two lines identical), with flock -n.
# If a deploy holds it, the check reads nothing more and reports
# `deploy-in-progress` (a notice), or `deploy-lock-stuck` (an alarm) once the
# holder's note is over 30 minutes old: no deploy takes that long.
# It holds the lock only while it reads local refs and the marker
# (milliseconds), never across ls-remote or the HTTP probe. Whatever meets it
# there waits for it (remote-deploy.sh's deploy-lock block): a deploy because
# the note names this script, a rollback or record step for any holder.
LOCK_DIR=${DEPLOY_LOCK_DIR:-/var/lock}
LOCK_FILE="$LOCK_DIR/logisx-deploy$(printf '%s' "$DIR" | tr -c 'A-Za-z0-9._-' '_').lock"
if ! command -v flock >/dev/null 2>&1; then
	echo "::error::flock(1) is not installed on this host — refusing to read the box without the deploy lock"
	exit 1
fi
# `<>` opens read-write WITHOUT truncating: the holder's note stays readable.
if ! exec 9<>"$LOCK_FILE"; then
	echo "::error::cannot open the deploy lock $LOCK_FILE"
	exit 1
fi
if ! flock -n 9; then
	echo "deploy lock $LOCK_FILE is held: $(head -1 "$LOCK_FILE" 2>/dev/null | tr -cd 'A-Za-z0-9=:./_ -')"
	echo "DRIFT_REMOTE=$REMOTE"
	# The holder writes its note when it takes the lock, so the file's age is
	# how long it has held it. find -mmin reads that the same way on GNU and BSD.
	if [ -n "$(find "$LOCK_FILE" -mmin +30 2>/dev/null)" ]; then
		echo "DRIFT_STATE=deploy-lock-stuck"
	else
		echo "DRIFT_STATE=deploy-in-progress"
	fi
	exit 0
fi
printf 'pid=%s since=%s by=remote-drift-check.sh\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE" 2>/dev/null || true

HEAD_SHA=$(git rev-parse HEAD)

# >>> verified-record — keep byte-identical in remote-deploy.sh,
# remote-drift-check.sh and remote-drift-heal.sh (scripts/test-deploy-scripts.js
# pins the copies)
#
# The commit this box last VERIFIED. remote-record-verified.sh writes it once a
# deploy's restart AND smoke check (and public edge check, where the job has
# one) have passed, and remote-rollback.sh once a rollback serves again. HEAD
# cannot tell this: it moves at checkout, BEFORE install, build and restart, so
# a deploy that dies after its checkout leaves HEAD on a commit that never ran.
#
# A git ref, so it lives inside .git: never in the working tree or in
# `git status`, never swept by `git clean`, written atomically by
# `git update-ref`, and it keeps its commit alive through `git gc`.
#
#   ok            VERIFIED is a commit HEAD contains: HEAD is it, or HEAD moved
#                 past it without being verified.
#   missing       no record yet: the first deploy after the record was
#                 introduced, or a fresh clone. Readers fall back to HEAD.
#   inconsistent  the record names something HEAD does not contain, or no
#                 commit at all: HEAD was moved back past it (by hand, or by
#                 a manual deploy of an older ref that died after its
#                 checkout). Nothing trusts it; the drift check alarms.
VERIFIED_REF=refs/logisx/verified-deploy
VERIFIED=""
if ! git show-ref --verify -q "$VERIFIED_REF"; then
	VERIFIED_STATE=missing
elif VERIFIED=$(git rev-parse --verify -q "$VERIFIED_REF^{commit}") && git merge-base --is-ancestor "$VERIFIED" HEAD; then
	VERIFIED_STATE=ok
else
	VERIFIED=""
	VERIFIED_STATE=inconsistent
fi
# <<< verified-record

# What production runs, as far as the box can tell: its last VERIFIED deploy.
# Comparing HEAD with main would read a deploy that died after its checkout as
# in-sync while the old code serves, and the heal could never see it. With no
# record yet (the first drift tick after the record was introduced, before the
# merge's own deploy has written one), HEAD, exactly as before. An inconsistent
# record alarms below; LOCAL is HEAD there only so the report stays readable.
if [ "$VERIFIED_STATE" = ok ]; then LOCAL=$VERIFIED; else LOCAL=$HEAD_SHA; fi

# ⚠️ One automatic heal PER COMMIT, tracked by a marker on the box. Without this
# a genuinely broken deploy would be retried on every schedule tick, restarting
# production in a loop. Transport failures are worth one retry; a deploy that
# actually landed and failed verification is not.
#
# The marker names the ONE main commit drift must not auto-deploy. It has three
# writers, and all three mean "a human decides now":
#   remote-drift-heal.sh  a heal of that commit was already attempted
#   remote-rollback.sh    production verification rejected it and rolled back
#   remote-deploy.sh      a human pinned production to another ref while main
#                         was at it (a manual rollback, or a hotfix)
MARKER="$DIR/.drift-heal-attempted"
LAST=$(cat "$MARKER" 2>/dev/null || echo "")
# Refs and the marker are read: let a deploy have the box before the probe.
exec 9>&-

# Up to 8 s, so never under the lock. A deploy that takes the lock after this
# point restarts the app only after its install and build, well after the
# probe. One that has already released the lock left main checked out, so HEAD
# reads main, and the gate (drift-gate.js) asks GitHub whether main's Deploy
# run is still running before it calls a box behind and not answering an
# incident: the app boots for 2–16 s after the restart.
PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/api/config/maintenance" || true)

echo "DRIFT_LOCAL=$LOCAL"
echo "DRIFT_HEAD=$HEAD_SHA"
echo "DRIFT_RECORD=$VERIFIED_STATE"
echo "DRIFT_REMOTE=$REMOTE"
echo "DRIFT_HTTP=$CODE"
echo "DRIFT_MARKER=$LAST"
if [ "$VERIFIED_STATE" = inconsistent ]; then
	# HEAD was moved back past the verified commit outside these scripts (a
	# checkout by hand), a manual deploy of an older ref died after its
	# checkout, or the record came from another clone. Which commit serves is
	# unknown, so a human decides: never a heal.
	echo "DRIFT_STATE=verified-record-inconsistent"
elif [ "$LOCAL" = "$REMOTE" ]; then
	echo "DRIFT_STATE=in-sync"
elif [ "$LAST" = "$REMOTE" ]; then
	# Already tried once for this SHA — do not restart production again.
	echo "DRIFT_STATE=behind-already-attempted"
elif [ "$CODE" != "200" ]; then
	# Behind AND unhealthy is not a missed deploy, it is an incident. Healing
	# would paper over it; alarm instead.
	echo "DRIFT_STATE=behind-and-unhealthy"
else
	# Behind main and serving. Either a deploy never reached the box, or one
	# reached it and died after its checkout (HEAD moved, the record did not).
	# The same staging gate decides both; a heal redeploys main's commit in full.
	echo "DRIFT_STATE=behind-healable"
fi
