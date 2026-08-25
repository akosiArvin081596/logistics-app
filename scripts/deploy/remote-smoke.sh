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
	if [ "$code" = "200" ]; then echo "smoke OK on :$PORT after $((i*2))s"; exit 0; fi
	sleep 2
done
echo "::error::smoke check failed — no HTTP 200 from :$PORT/api/config/maintenance within 60s"
# ⚠️ Read the timestamps before believing this dump. `pm2 logs --nostream` tails
# the error log whether or not anything new was written, so an error from days
# ago prints here and reads exactly like a fresh regression.
echo "--- pm2 error log tail (MAY BE STALE — check the dates against the deploy time) ---"
pm2 logs "$PM2" --nostream --lines 40 --err 2>/dev/null || true
exit 1
