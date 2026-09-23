#!/bin/bash
# Emergency rollback. Runs ON THE VPS. Inputs (env): DIR, PM2, PREV
#
# Only ever invoked when a deploy's smoke check FAILED. With production
# auto-deploying on merge there is no human watching, so a bad merge must not
# be able to leave production down until someone notices. Used by deploy.yml's
# production job AND by deploy-drift.yml's heal (same composite action).
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"; : "${PREV:?}"

LOCK_OWNER=remote-rollback.sh
# >>> deploy-lock — keep byte-identical in remote-deploy.sh and remote-rollback.sh
# (scripts/test-deploy-scripts.js pins the two copies)
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

cd "$DIR" || exit 1
echo "::group::ROLLING BACK $PM2 to $PREV"
TARGET=$(git rev-parse --verify -q "$PREV^{commit}") || { echo "::error::$PREV is not a commit in this clone"; exit 1; }

# ── Record the commit that failed verification ──────────────────────────────
# The drift marker names the one main commit that no automatic path may deploy
# again. After a failed verification, what happens next is a human's call.
# Written FIRST, like the heal's own marker: if the rollback dies halfway, the
# commit is still recorded. Fail-closed.
FAILED=$(git rev-parse HEAD)
if [ "$FAILED" != "$TARGET" ]; then
	if printf '%s' "$FAILED" > "$DIR/.drift-heal-attempted"; then
		echo "drift marker set to $FAILED — deploy-drift.yml will not deploy it again automatically"
	else
		echo "::warning::could not write the drift marker — deploy-drift.yml is not told about $FAILED"
	fi
fi

git checkout -- client/package-lock.json package-lock.json 2>/dev/null || true
git checkout --detach "$TARGET" || { echo "::error::cannot check out $TARGET"; exit 1; }

NODE_BIN=$(pm2 jlist 9>&- | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$PM2")
case "$NODE_BIN" in ""|node) NODE_BIN=$(command -v node) ;; esac
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH

npm install --silent --no-audit --no-fund
node -e "require('better-sqlite3')" >/dev/null 2>&1 || npm rebuild better-sqlite3
npm run build:client --silent
if [ -f ecosystem.config.js ] && grep -q "name: '$PM2'" ecosystem.config.js; then
	pm2 restart ecosystem.config.js --update-env --silent 9>&-
else
	pm2 restart "$PM2" --silent 9>&-
fi
echo "::endgroup::"

PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
for _ in $(seq 1 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" || true)
	if [ "$code" = "200" ]; then echo "ROLLBACK OK — $PM2 serving 200 on :$PORT at $TARGET"; exit 0; fi
	sleep 2
done
echo "::error::ROLLBACK FAILED — $PM2 is not serving at $TARGET either. MANUAL INTERVENTION REQUIRED."
exit 1
