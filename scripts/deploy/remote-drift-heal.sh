#!/bin/bash
# Heal PREP for deploy-drift.yml. Runs ON THE VPS, after the drift check AND the
# staging gate have both said "heal". It re-reads the box, then writes the
# one-attempt-per-SHA marker. The deploy itself is the normal
# remote-deploy.sh, pinned to TARGET, run through .github/actions/vps-deploy
# (smoke check, edge check and auto-rollback included).
#
# Inputs (env):
#   DIR     app directory
#   TARGET  the full SHA the staging gate approved (main's tip at check time)
#   EXPECT  what the drift check reported as production (DRIFT_LOCAL): the
#           box's last verified deploy, or HEAD while there is no record
# Prints HEAL_READY=yes, or HEAL_READY=no plus HEAL_REASON=..., and exits 0 in
# both cases. Non-zero only when it could not do its job at all.
#
# The marker is written BEFORE the deploy, deliberately: if the deploy dies
# halfway the marker still records that this SHA was attempted, so the next
# schedule tick alarms instead of retrying. Fail-closed, not fail-open.
set -uo pipefail
: "${DIR:?}"; : "${TARGET:?}"; : "${EXPECT:?}"
cd "$DIR" || exit 1
MARKER="$DIR/.drift-heal-attempted"

not_ready() {
	echo "HEAL_READY=no"
	echo "HEAL_REASON=$1"
	echo "::warning::not healing — $1"
	exit 0
}

# Minutes can pass between the check and this step (the staging gate asks the
# GitHub API). Whatever changed in between wins: re-read, do not trust the check.
git fetch --quiet --prune origin || not_ready "git fetch failed on the box; the next tick re-checks"

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

# Read production exactly as remote-drift-check.sh reported it: the last
# verified deploy, or HEAD while there is no record. An inconsistent record
# never heals (the drift check alarms on it).
case "$VERIFIED_STATE" in
	ok) NOW=$VERIFIED ;;
	missing) NOW=$(git rev-parse HEAD) ;;
	*) not_ready "the verified-deploy record does not match this clone's history; a human decides" ;;
esac
[ "$NOW" = "$EXPECT" ] || not_ready "production moved from $EXPECT to $NOW since the drift check; the next tick re-reads it"
[ "$(cat "$MARKER" 2>/dev/null || true)" != "$TARGET" ] || not_ready "an automatic attempt at $TARGET is already recorded in $MARKER"
git merge-base --is-ancestor "$TARGET" origin/main 2>/dev/null || not_ready "$TARGET is no longer on origin/main"

printf '%s' "$TARGET" > "$MARKER" || { echo "::error::cannot write $MARKER — not healing without the one-attempt marker"; exit 1; }
echo "marker written: $TARGET (one automatic heal per commit)"
echo "HEAL_READY=yes"
