#!/bin/bash
# Writes the one-attempt-per-SHA marker, then hands off to the normal deploy.
# Runs ON THE VPS. Inputs (env): DIR, PM2, REF
#
# The marker is written BEFORE the deploy, deliberately: if the deploy dies
# halfway the marker still records that this SHA was attempted, so the next
# schedule tick alarms instead of retrying. Fail-closed, not fail-open.
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"; : "${REF:?}"
cd "$DIR" || exit 1
TARGET=$(git rev-parse origin/main 2>/dev/null || echo "$REF")
printf '%s' "$TARGET" > "$DIR/.drift-heal-attempted"
echo "marker written: $TARGET (one automatic heal per commit)"
