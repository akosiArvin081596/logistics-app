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
#   EXPECT  the production HEAD the drift check saw
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
NOW=$(git rev-parse HEAD)
[ "$NOW" = "$EXPECT" ] || not_ready "production moved from $EXPECT to $NOW since the drift check; the next tick re-reads it"
[ "$(cat "$MARKER" 2>/dev/null || true)" != "$TARGET" ] || not_ready "an automatic attempt at $TARGET is already recorded in $MARKER"
git merge-base --is-ancestor "$TARGET" origin/main 2>/dev/null || not_ready "$TARGET is no longer on origin/main"

printf '%s' "$TARGET" > "$MARKER" || { echo "::error::cannot write $MARKER — not healing without the one-attempt marker"; exit 1; }
echo "marker written: $TARGET (one automatic heal per commit)"
echo "HEAL_READY=yes"
