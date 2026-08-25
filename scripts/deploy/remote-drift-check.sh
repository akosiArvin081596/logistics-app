#!/bin/bash
# Reports whether a deployed app is behind origin/main, and whether it is safe
# to heal automatically. Runs ON THE VPS. Inputs (env): DIR, PM2
#
# Prints DRIFT_*=... lines for the workflow to parse. Read-only apart from the
# heal marker, which is written by remote-drift-heal.sh, not here.
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"
cd "$DIR" || exit 1

git fetch --quiet --prune origin 2>/dev/null || true
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/api/config/maintenance" || true)

# ⚠️ One automatic heal PER COMMIT, tracked by a marker on the box. Without this
# a genuinely broken deploy would be retried on every schedule tick, restarting
# production in a loop. Transport failures are worth one retry; a deploy that
# actually landed and failed verification is not.
MARKER="$DIR/.drift-heal-attempted"
LAST=$(cat "$MARKER" 2>/dev/null || echo "")

echo "DRIFT_LOCAL=$LOCAL"
echo "DRIFT_REMOTE=$REMOTE"
echo "DRIFT_HTTP=$CODE"
echo "DRIFT_MARKER=$LAST"
if [ "$LOCAL" = "$REMOTE" ]; then
	echo "DRIFT_STATE=in-sync"
elif [ "$LAST" = "$REMOTE" ]; then
	# Already tried once for this SHA — do not restart production again.
	echo "DRIFT_STATE=behind-already-attempted"
elif [ "$CODE" != "200" ]; then
	# Behind AND unhealthy is not a missed deploy, it is an incident. Healing
	# would paper over it; alarm instead.
	echo "DRIFT_STATE=behind-and-unhealthy"
else
	echo "DRIFT_STATE=behind-healable"
fi
