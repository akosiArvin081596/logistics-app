#!/bin/bash
# Records the deploy that was just VERIFIED. Runs ON THE VPS, fed to `bash -s`
# over ssh by .github/actions/vps-deploy, and ONLY after remote-deploy.sh
# restarted the app AND the smoke check passed (and the public edge check,
# where the job has one). deploy.yml's staging and production jobs and
# deploy-drift.yml's heal all reach it through that one action.
#
# Inputs (env): DIR, SHA (the commit remote-deploy.sh reported as DEPLOYED_TO)
# Prints:       VERIFIED_RECORDED=<sha>
# Exit codes:   0 recorded, 75 another deploy holds the box lock, 1 anything
#               else. None is 255, so ssh-retry.sh retries none of them.
#
# WHY: HEAD moves at checkout, before install, build and restart, so it cannot
# tell which commit the app actually runs. This record can, and
# remote-deploy.sh's no-op check, its rollback target and remote-drift-check.sh
# read it instead of HEAD. It is the ref named in the verified-record block of
# remote-deploy.sh; remote-rollback.sh is the only other writer.
set -uo pipefail
: "${DIR:?DIR is required}"
SHA=${SHA:-}
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
	echo "::error::SHA must be the full 40-character commit the deploy reported (got '$SHA') — nothing was recorded"
	exit 1
fi

LOCK_OWNER=remote-record-verified.sh
# The record step runs inside the deploy's own job, which holds the Actions
# queue for this environment: it waits (bounded) for whatever holds the lock,
# the drift check's read included.
LOCK_WAITS_FOR=any
# >>> deploy-lock — keep byte-identical in remote-deploy.sh, remote-rollback.sh
# and remote-record-verified.sh (scripts/test-deploy-scripts.js pins the copies)
#
# One deploy per app directory, whatever started it: deploy.yml, the drift heal,
# an auto-rollback, or a human with ssh. Two at once in the same directory
# would be two pulls, two npm installs and two builds into one client/dist,
# then two restarts.
#
# ⚠️ The lock file lives OUTSIDE the repo tree on purpose, in a folder only the
# deploying account can write (the lock-folder block below; on /run, a tmpfs
# cleared at boot). A file inside $DIR could be clobbered by a checkout, and
# would mean nothing to a second clone.
#
# ⚠️ flock -n: a held lock FAILS FAST with exit 75 when another deploy, rollback
# or record step holds it. It never queues behind one: that would start this
# run on top of whatever the other one leaves behind. Two bounded waits
# (DEPLOY_LOCK_WAIT_S, default 20 s) are the exceptions:
#   - LOCK_WAITS_FOR=any (the rollback and the record step): they run inside a
#     job that already holds the Actions production slot, so no other deploy of
#     this directory runs through Actions; whatever holds the lock is the drift
#     check's read (milliseconds) or a human, and failing would leave a broken
#     deploy unrolled-back or a good one unrecorded.
#   - LOCK_WAITS_FOR=drift-check (the deploy): it waits only when the holder's
#     note says remote-drift-check.sh, which holds the lock just long enough to
#     read refs and the marker.
#
# ⚠️ FD 9 is inherited by every child. flock(1) locks the open file description,
# so a long-lived child holding FD 9 would hold the lock after this script has
# exited. That is why every command that may spawn a daemon (pm2 starts its God
# daemon when none is running; git may start a credential-cache daemon) runs
# with `9>&-`.
# >>> lock-folder — keep byte-identical in remote-deploy.sh, remote-rollback.sh,
# remote-record-verified.sh and remote-drift-check.sh
# (scripts/test-deploy-scripts.js pins the copies)
#
# The deploy lock lives in a folder only the deploying account can write: one
# folder per account, named by its uid. It must be a folder, not a link, that
# this account owns and that neither its group nor other accounts can write.
# Anything else is refused, and the lock is never taken in another folder. A
# missing one is made 0700 where its parent allows it (root can, under /run); an
# account that cannot make it there gets it from a systemd-tmpfiles entry.
LOCK_UID=$(id -u)
LOCK_DIR=${DEPLOY_LOCK_DIR:-/run/logisx-deploy-$LOCK_UID}
LOCK_DIR_BAD=""
if ! [[ "$LOCK_UID" =~ ^[0-9]+$ ]]; then
	LOCK_DIR_BAD="this account's uid could not be read"
elif [[ "$LOCK_DIR" != /* || "$LOCK_DIR" == */ ]]; then
	LOCK_DIR_BAD="it must be an absolute path with no trailing slash"
else
	[ -e "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ] || mkdir -m 0700 "$LOCK_DIR" 2>/dev/null
	if [ -L "$LOCK_DIR" ] || { [ -e "$LOCK_DIR" ] && [ ! -d "$LOCK_DIR" ]; }; then
		LOCK_DIR_BAD="it is not a folder"
	elif [ ! -d "$LOCK_DIR" ]; then
		LOCK_DIR_BAD="it is missing, and this account cannot create it there"
	elif [ -z "$(find "$LOCK_DIR" -maxdepth 0 -user "$LOCK_UID" 2>/dev/null)" ]; then
		LOCK_DIR_BAD="another account owns it"
	elif [ -z "$(find "$LOCK_DIR" -maxdepth 0 ! -perm -020 ! -perm -002 2>/dev/null)" ]; then
		LOCK_DIR_BAD="its group or other accounts can write it"
	fi
fi
if [ -n "$LOCK_DIR_BAD" ]; then
	echo "::error::refusing the deploy lock folder $LOCK_DIR: $LOCK_DIR_BAD. It must be a folder this account (uid $LOCK_UID) owns and no other account can write. Nothing was changed."
	exit 1
fi
LOCK_FILE="$LOCK_DIR/logisx-deploy$(printf '%s' "$DIR" | tr -c 'A-Za-z0-9._-' '_').lock"
# <<< lock-folder
LOCK_WAIT_S=${DEPLOY_LOCK_WAIT_S:-20}
if ! command -v flock >/dev/null 2>&1; then
	echo "::error::flock(1) is not installed on this host — refusing to run without the box-level deploy lock"
	exit 1
fi
# `<>` opens read-write WITHOUT truncating: a contender must not wipe the
# holder's note before it finds out the lock is taken.
if ! exec 9<>"$LOCK_FILE"; then
	echo "::error::cannot open the deploy lock $LOCK_FILE"
	exit 1
fi
if ! flock -n 9; then
	LOCK_HOLDER=$(head -1 "$LOCK_FILE" 2>/dev/null || echo unknown)
	if [ "$LOCK_WAITS_FOR" = any ] || [[ "$LOCK_HOLDER" == *"by=remote-drift-check.sh"* ]]; then
		echo "deploy lock $LOCK_FILE is held ($LOCK_HOLDER); waiting up to ${LOCK_WAIT_S}s"
		LOCK_GOT=0
		flock -w "$LOCK_WAIT_S" 9 && LOCK_GOT=1
	else
		LOCK_GOT=0
	fi
	if [ "$LOCK_GOT" != 1 ]; then
		echo "::error::another deploy of $DIR is running — lock $LOCK_FILE is held. Refusing to overlap it."
		echo "lock holder: $(cat "$LOCK_FILE" 2>/dev/null || echo unknown)"
		echo "(if nothing is actually deploying, find the holder with: fuser -v $LOCK_FILE)"
		exit 75
	fi
fi
printf 'pid=%s since=%s by=%s ref=%s sha=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	"$LOCK_OWNER" "${REF:-}" "${SHA:-}" > "$LOCK_FILE" 2>/dev/null || true
# <<< deploy-lock

cd "$DIR" || { echo "::error::$DIR does not exist"; exit 1; }

# Under the deploy lock nothing else moves the box, so this comparison is
# final: record exactly the commit that was deployed AND verified, never one a
# later deploy has put there since.
NOW=$(git rev-parse HEAD)
if [ "$NOW" != "$SHA" ]; then
	echo "::error::HEAD is $NOW, not the verified $SHA — the box changed after that deploy. Nothing was recorded."
	exit 1
fi
if ! git update-ref --create-reflog -m "logisx: deploy verified" refs/logisx/verified-deploy "$SHA"; then
	echo "::error::could not record $SHA as the verified deploy"
	exit 1
fi
echo "verified deploy recorded: $SHA (git reflog show refs/logisx/verified-deploy lists every one)"
echo "VERIFIED_RECORDED=$SHA"
