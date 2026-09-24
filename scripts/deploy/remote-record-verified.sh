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
# >>> deploy-lock — keep byte-identical in remote-deploy.sh, remote-rollback.sh
# and remote-record-verified.sh (scripts/test-deploy-scripts.js pins the copies)
#
# One deploy per app directory, whatever started it: deploy.yml, the drift heal,
# an auto-rollback, or a human with ssh. Two at once in the same directory
# would be two pulls, two npm installs and two builds into one client/dist,
# then two restarts.
#
# ⚠️ The lock file lives OUTSIDE the repo tree on purpose (default /var/lock,
# i.e. /run/lock: tmpfs, root-writable, cleared at boot). A file inside $DIR
# could be clobbered by a checkout, and would mean nothing to a second clone.
#
# ⚠️ flock -n: a held lock FAILS FAST with exit 75. It never queues. Waiting
# would start this deploy on top of whatever the other one leaves behind.
#
# ⚠️ FD 9 is inherited by every child. flock(1) locks the open file description,
# so a long-lived child holding FD 9 would hold the lock after this script has
# exited. That is why every command that may spawn a daemon (pm2 starts its God
# daemon when none is running; git may start a credential-cache daemon) runs
# with `9>&-`.
LOCK_DIR=${DEPLOY_LOCK_DIR:-/var/lock}
LOCK_FILE="$LOCK_DIR/logisx-deploy$(printf '%s' "$DIR" | tr -c 'A-Za-z0-9._-' '_').lock"
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
	echo "::error::another deploy of $DIR is running — lock $LOCK_FILE is held. Refusing to overlap it."
	echo "lock holder: $(cat "$LOCK_FILE" 2>/dev/null || echo unknown)"
	echo "(if nothing is actually deploying, find the holder with: fuser -v $LOCK_FILE)"
	exit 75
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
