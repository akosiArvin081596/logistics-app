#!/bin/bash
# Remote smoke check. Runs ON THE VPS. Inputs (env): DIR, PM2
set -uo pipefail
: "${DIR:?DIR is required}"
: "${PM2:?PM2 is required}"
cd "$DIR" || exit 1

# ⚠️ The trailing `|| true` is load-bearing and has already broken a production
# deploy once. Production's .env has NO `PORT=` line — it relies on server.js
# defaulting to 3000 — so grep matches nothing and exits 1, and under `set -e`
# that would abort BEFORE the ${PORT:-3000} fallback could run. It passed on
# staging only because staging DOES set PORT=3003.
PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
echo "resolved port: $PORT"

# /api/config/maintenance is unauthenticated and returns module constants only —
# no DB, no Sheets, no billed API. It proves the process booted and Express is
# serving, and costs nothing. Poll: boot runs schema migrations first.
for i in $(seq 1 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" || true)
	if [ "$code" = "200" ]; then break; fi
	sleep 2
done
# Then the page, once: a process that answered has every route registered.
# >>> app-page — keep byte-identical in remote-smoke.sh, remote-rollback.sh and
# remote-drift-check.sh (scripts/test-deploy-scripts.js pins the copies)
#
# The API answering proves the process serves, not that it serves the app.
# Without client/dist/index.html (a build that failed or left nothing) every
# page is server.js's 503 "being updated" page (lib/app-updating-page.js)
# while /api/config/maintenance still answers 200. So / must answer 200 AND
# carry the SPA's mount point, id="app" from client/index.html, which that
# page never carries. Sets PAGE_CODE, and PAGE_OK=1 only when both hold.
# Only no answer at all (000: a stall right after the API's 200) is asked
# again, 3 tries in all, 2 s apart. Any answer is final at once, the 503 page
# and a 200 without the mount point included.
PAGE_BODY=$(mktemp)
for PAGE_TRY in 1 2 3; do
	PAGE_CODE=$(curl -s -o "$PAGE_BODY" -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" || true)
	PAGE_CODE=${PAGE_CODE:-000}
	if [ "$PAGE_CODE" != "000" ] || [ "$PAGE_TRY" = 3 ]; then break; fi
	sleep 2
done
PAGE_OK=0
if [ "$PAGE_CODE" = "200" ] && grep -q 'id="app"' "$PAGE_BODY"; then
	PAGE_OK=1
fi
rm -f "$PAGE_BODY"
# <<< app-page
if [ "$code" != "200" ]; then
	echo "::error::smoke check failed — no HTTP 200 from :$PORT/api/config/maintenance within 60s"
elif [ "$PAGE_OK" != 1 ]; then
	echo "::error::smoke check failed — :$PORT/api/config/maintenance answers 200, but :$PORT/ gave $PAGE_CODE without the app's page (no id=\"app\"). A 503 there is the \"being updated\" page: client/dist/index.html is missing"
else
	echo "smoke OK on :$PORT after $((i*2))s: the API answers 200 and / is the app's page"
	exit 0
fi
# ⚠️ Read the timestamps before believing this dump. `pm2 logs --nostream` tails
# the error log whether or not anything new was written, so an error from days
# ago prints here and reads exactly like a fresh regression.
echo "--- pm2 error log tail (MAY BE STALE — check the dates against the deploy time) ---"
# The log is the app's text, not this script's, so it prints with workflow
# commands switched off: no line in it becomes an annotation or an output on
# the runner (deploy-drift.yml reads a failed staging job's annotations). The
# token is random per run, as GitHub's docs advise, so no log line can switch
# commands back on, and tr keeps each log line a single plain line.
# scripts/test-deploy-scripts.js pins this shape and runs it.
tok=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "::stop-commands::$tok"
pm2 logs "$PM2" --nostream --lines 40 --err 2>/dev/null | tr -d '\r' || true
echo "::$tok::"
exit 1
