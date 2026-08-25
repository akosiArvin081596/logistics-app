#!/bin/bash
# Emergency rollback. Runs ON THE VPS. Inputs (env): DIR, PM2, PREV
#
# Only ever invoked when a deploy's smoke check FAILED. With production
# auto-deploying on merge there is no human watching, so a bad merge must not
# be able to leave production down until someone notices.
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"; : "${PREV:?}"
cd "$DIR" || exit 1
echo "::group::ROLLING BACK $PM2 to $PREV"
git checkout -- client/package-lock.json package-lock.json 2>/dev/null || true
git checkout --detach "$PREV" || { echo "::error::cannot check out $PREV"; exit 1; }

NODE_BIN=$(pm2 jlist | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$PM2")
case "$NODE_BIN" in ""|node) NODE_BIN=$(command -v node) ;; esac
export PATH="$(dirname "$NODE_BIN"):$PATH"

npm install --silent --no-audit --no-fund
node -e "require('better-sqlite3')" >/dev/null 2>&1 || npm rebuild better-sqlite3
npm run build:client --silent
if [ -f ecosystem.config.js ] && grep -q "name: '$PM2'" ecosystem.config.js; then
	pm2 restart ecosystem.config.js --update-env --silent
else
	pm2 restart "$PM2" --silent
fi
echo "::endgroup::"

PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
for i in $(seq 1 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" || true)
	if [ "$code" = "200" ]; then echo "ROLLBACK OK — $PM2 serving 200 on :$PORT at $PREV"; exit 0; fi
	sleep 2
done
echo "::error::ROLLBACK FAILED — $PM2 is not serving at $PREV either. MANUAL INTERVENTION REQUIRED."
exit 1
