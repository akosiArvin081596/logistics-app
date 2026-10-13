#!/bin/bash
# Emergency rollback. Runs ON THE VPS.
# Inputs (env): DIR, PM2, PREV (the full commit to return to: the deploy's
#   DEPLOYED_FROM), RECORD_STATE (the deploy's DEPLOY_RECORD_STATE), and
#   DEPLOY_RESULT (the deploy's DEPLOY_RESULT: an unbuilt deploy restarted
#   nothing, which changes when this rollback may restart, below).
#
# Only ever invoked when a deploy FAILED: its smoke or edge check failed, pm2
# did not prove its restart, or its install or build failed after its checkout
# (DEPLOY_RESULT=unbuilt). Nobody approves a production deploy (the production
# environment has no required reviewer) or watches one finish, so a bad merge
# must not be able to leave production down until someone notices. Used by
# deploy.yml's production job AND by deploy-drift.yml's heal (same composite
# action).
#
# It ends "ROLLBACK OK" (exit 0) only when the app serves again: the API
# answers 200 AND / is the app's own page, not the 503 "being updated" page,
# AND that page is PREV's own client build (its .build-commit stamp).
# Anything else ends "::error::ROLLBACK FAILED … MANUAL INTERVENTION REQUIRED."
# with exit 1, which fails the action's Auto-rollback step, and records nothing.
set -uo pipefail
: "${DIR:?}"; : "${PM2:?}"; : "${PREV:?}"
RECORD_STATE=${RECORD_STATE:-}
DEPLOY_RESULT=${DEPLOY_RESULT:-}
# Validate before touching anything, including the lock.
if ! [[ "$PREV" =~ ^[0-9a-f]{40}$ ]]; then
	echo "::error::PREV must be a full 40-character lowercase commit id (got '$PREV') — nothing was changed"
	exit 1
fi

LOCK_OWNER=remote-rollback.sh
# A rollback runs inside a job that already holds the Actions production slot,
# so no other deploy of this directory can be running through Actions: it
# waits (bounded) for whatever holds the lock, the drift check's read included.
LOCK_WAITS_FOR=any
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
LOCK_DIR=${DEPLOY_LOCK_DIR:-/var/lock}
LOCK_FILE="$LOCK_DIR/logisx-deploy$(printf '%s' "$DIR" | tr -c 'A-Za-z0-9._-' '_').lock"
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

cd "$DIR" || exit 1
echo "::group::ROLLING BACK $PM2 to $PREV"
TARGET=$(git rev-parse --verify -q "$PREV^{commit}") || { echo "::error::$PREV is not a commit in this clone"; exit 1; }

# ── Record the commit that failed verification ──────────────────────────────
# The drift marker names the one main commit that no automatic path may deploy
# again. After a failed verification, what happens next is a human's call.
# Written FIRST, like the heal's own marker: if the rollback dies halfway, the
# commit is still recorded. Fail-closed. Even when the target is that same
# commit (a deploy with no record to return to, or a redeploy of the verified
# commit): it still failed verification.
#
# ⚠️ One marker is never replaced. deploy-drift.yml only ever deploys main's
# tip, so the marker blocks something only while it names that tip. A marker
# that already names main's tip (a manual pin's, or a heal's) stays when the
# failed commit is not main's tip: drift can never deploy that commit anyway,
# and replacing the marker would let drift deploy main over the pin.
FAILED=$(git rev-parse HEAD)
MAIN_TIP=$(git rev-parse --verify -q origin/main || true)
MARKED=$(cat "$DIR/.drift-heal-attempted" 2>/dev/null || true)
if [ -n "$MAIN_TIP" ] && [ "$MARKED" = "$MAIN_TIP" ] && [ "$FAILED" != "$MAIN_TIP" ]; then
	echo "drift marker kept on main's tip $MAIN_TIP — $FAILED is not main's tip, so deploy-drift.yml cannot deploy it anyway"
elif printf '%s' "$FAILED" > "$DIR/.drift-heal-attempted"; then
	echo "drift marker set to $FAILED — deploy-drift.yml will not deploy it again automatically"
else
	echo "::warning::could not write the drift marker — deploy-drift.yml is not told about $FAILED"
fi
if [ "$FAILED" = "$TARGET" ]; then
	echo "::warning::the rollback target $TARGET is the commit that just failed verification: this rollback restarts it, and never records it as verified"
fi

# Build with the Node pm2 runs the app with, read as remote-deploy.sh reads it,
# and BEFORE the checkout: when it cannot be read, refuse with nothing touched
# rather than build with PATH's node (the box's system Node 20) and restart a
# rollback that dies on boot.
NODE_BIN=$(pm2 jlist 9>&- | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let l=[];try{l=JSON.parse(d.slice(d.lastIndexOf("\n[")+1));}catch(e){}
    const p=Array.isArray(l)?l.find(x=>x&&x.name===process.argv[1]):null;
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$PM2")
case "$NODE_BIN" in
	node) NODE_BIN=$(command -v node) ;;
	"")
		echo "::error::ROLLBACK FAILED — cannot read the interpreter pm2 runs $PM2 with, so nothing was checked out, built or restarted. MANUAL INTERVENTION REQUIRED."
		exit 1 ;;
esac
echo "pm2 interpreter: $NODE_BIN"

git checkout -- client/package-lock.json package-lock.json 2>/dev/null || true
git checkout --detach "$TARGET" || { echo "::error::cannot check out $TARGET"; exit 1; }

PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH

# A rollback restarts whatever it managed to build, because a partial rollback
# that serves beats none. But only a clean install and build may be recorded
# as VERIFIED below, so every step's outcome is kept. A client build that
# fails leaves client/dist as it was (client_build); whether that is TARGET's
# client is checked after it. Only a box left with no client/dist/index.html
# at all serves the 503 "being updated" page, and the page check below fails
# that rollback.
BUILD_OK=1
# Without writing the lockfiles back, as remote-deploy.sh installs.
npm_config_save=false npm install --silent --no-audit --no-fund || BUILD_OK=0
# ⚠️ OPEN a database: require() alone passes under an ABI-mismatched Node (the
# native binding loads lazily). Same probe as remote-deploy.sh, before and
# after the rebuild.
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
	npm rebuild better-sqlite3
	node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1 || BUILD_OK=0
fi
# ⚠️ After a deploy that was never built (DEPLOY_RESULT=unbuilt) nothing was
# restarted: the process serving is still the code from before that deploy,
# and it never stopped serving. A restart is worth it only with TARGET's
# server installed. When this install or the native module failed, a restart
# could take the API down too, where nothing was down, so stop here, before
# the client build and the restart.
if [ "$DEPLOY_RESULT" = unbuilt ] && [ "$BUILD_OK" != 1 ]; then
	echo "::error::ROLLBACK FAILED — the deploy of $FAILED was never built, so $PM2 still runs the code from before it, but this rollback's own install of $TARGET failed (npm install, or better-sqlite3 cannot open a database). Not restarting: a restart could take the API down too. HEAD is $TARGET and node_modules may be part-installed, which the next restart of any kind would start. Nothing was restarted or recorded. MANUAL INTERVENTION REQUIRED."
	exit 1
fi
# >>> client-build — keep byte-identical in remote-deploy.sh and remote-rollback.sh
# (scripts/test-deploy-scripts.js pins the copies)
#
# client_build builds the client BESIDE the build the running process serves,
# and swaps it in only once it is whole. Vite empties its output folder before
# it writes, so a build straight into client/dist left the running process
# with no client/dist/index.html for the whole build: every page was
# server.js's 503 "being updated" page, and after a failed build it stayed
# that way, with nothing to bring the app's pages back.
#
# It runs client/'s own build script (what the root's build:client runs) with
# only Vite's --outDir changed, to client/dist.next, so CI, the replica, the
# e2e servers and a developer still build into client/dist. Only a build that
# exited 0 and left a whole build replaces client/dist: an index.html, and
# every /assets bundle file it names, none of them empty (client_whole). An
# index.html that names none is not whole either: Vite's entry is always one.
# "Names" means a src= or href= attribute whose value is that path, as Vite
# writes them, so a comment or another site's URL that happens to hold
# /assets/ never counts.
# The build is stamped first with the commit it was built from (.build-commit:
# express.static never serves a dotfile), then swapped in by two renames (the
# box's coreutils predates mv --exchange): client/dist is missing for the
# moment between them, not for the length of a build. The build it replaces is
# KEPT, with its stamp, in client/dist.prev until the next swap, so a rollback
# whose own build fails can put its commit's build back (remote-rollback.sh).
# A failed build leaves client/dist and client/dist.prev as they were. Returns
# 0 only once the new build is in place. client_stamp DIR prints the commit
# DIR's build was made from, or nothing for a build with no stamp.
#
# ⚠️ A run cut short between the two renames leaves no client/dist and the
# whole previous build in client/dist.prev: before anything else, client_build
# puts it back, so the next build never starts by losing the only good copy.
#
# ⚠️ The kept build loses its stamp BEFORE it is deleted. The rollback puts a
# kept build back by its stamp, and rm -rf deletes in no set order, so a
# delete cut short could otherwise leave part of a build still stamped whole.
client_stamp() { head -n 1 "$1/.build-commit" 2>/dev/null || true; }
client_whole() {
	local a n=0
	[ -f "$1/index.html" ] || return 1
	for a in $(grep -oE '(src|href)="/assets/[A-Za-z0-9._-]+\.(js|css)"' "$1/index.html" | sort -u); do
		a=${a#*\"}
		a=${a%\"}
		[ -s "$1$a" ] || return 1
		n=$((n + 1))
	done
	[ "$n" -gt 0 ]
}
client_build() {
	if [ ! -e client/dist ] && [ -f client/dist.prev/index.html ]; then
		mv client/dist.prev client/dist && echo "::warning::client/dist was missing and client/dist.prev held a whole build (a swap cut short): put it back"
	fi
	rm -rf client/dist.next
	if ! (cd client && npm run build --silent -- --outDir dist.next); then
		echo "::warning::the client build failed — client/dist is left as it was"
	elif ! client_whole client/dist.next; then
		echo "::warning::the client build left no whole build (no index.html, or not every /assets file it names) — client/dist is left as it was"
	elif ! git rev-parse HEAD > client/dist.next/.build-commit; then
		echo "::warning::could not stamp the new build with its commit — client/dist is left as it was"
	elif ! rm -f client/dist.prev/.build-commit || ! rm -rf client/dist.prev || { [ -e client/dist ] && ! mv client/dist client/dist.prev; }; then
		echo "::warning::could not move client/dist aside — client/dist is left as it was"
	elif ! mv client/dist.next client/dist; then
		echo "::warning::could not move the new build into client/dist — putting the previous build back"
		[ ! -e client/dist.prev ] || mv client/dist.prev client/dist
	else
		return 0
	fi
	rm -rf client/dist.next
	return 1
}
# <<< client-build
client_build || BUILD_OK=0
# ⚠️ Which commit's client TARGET's server is about to serve. A client build
# of TARGET that failed left client/dist as it was, and after a deploy whose
# build was swapped in (its checks failed, or its restart was unproven) that
# is the FAILED commit's client, which the page check below would pass. So
# when client/dist is not TARGET's build and the build kept in
# client/dist.prev is (client_build keeps the one it replaced), that one goes
# back in place, but only when it is whole as well (client_whole): a build
# kept by an older deploy was only ever checked for its index.html. When
# neither is, this rollback ends ROLLBACK FAILED below, naming the client that
# serves.
if [ "$(client_stamp client/dist)" != "$TARGET" ] && [ "$(client_stamp client/dist.prev)" = "$TARGET" ] && client_whole client/dist.prev; then
	rm -rf client/dist.next
	if { [ ! -e client/dist ] || mv client/dist client/dist.next; } && mv client/dist.prev client/dist; then
		echo "::warning::client/dist was not $TARGET's build: put the build of $TARGET kept in client/dist.prev back in place"
	else
		[ -e client/dist ] || [ ! -e client/dist.next ] || mv client/dist.next client/dist
		echo "::warning::could not put the build of $TARGET kept in client/dist.prev back in place"
	fi
	rm -rf client/dist.next
fi
CLIENT_AT=$(client_stamp client/dist)
# >>> pm2-restart — keep byte-identical in remote-deploy.sh and remote-rollback.sh
# (scripts/test-deploy-scripts.js pins the copies)
#
# Restarts the ONE process named $PM2, then proves the restart took: pm2 must
# exit 0 AND the process's pm_uptime (when pm2 last started it) must change. A
# restart that silently did nothing leaves the OLD process serving, and every
# check after it would read that old process: the commit just built would be
# marked started, and later recorded as verified, without ever having run.
# Sets RESTART_OK=1 only when both hold, and PM2_STATUS to pm2's status after.
#
# ⚠️ Name-scoped, ALWAYS. This VPS hosts ~23 other pm2 processes for other
# clients. `pm2 restart all` or a numeric id would take those down too. The
# proof reads this process BY NAME from `pm2 jlist` (JSON, parsed with node;
# never `pm2 describe`, whose box-drawing columns shift with the values, and
# never jq), so no other process can stand in for it. pm2 can print its own
# notices on stdout ahead of the JSON (a daemon older than the CLI: "In-memory
# PM2 is out-of-date"), and jlist's JSON is always one line, so only the last
# line that starts with "[" is parsed.
#
# ⚠️ Production is restarted through ecosystem.config.js, NOT by name, because
# it carries five pm2-level settings — NODE_OPTIONS (the 4 GB heap that exists
# because it was OOM-ing at 2 GB), kill_timeout, max_restarts, min_uptime and
# restart_delay. A plain by-name restart re-reads the dump and keeps them, but
# going through the file is what makes a CHANGED setting take effect.
pm2_state() {
	pm2 jlist 9>&- | node -e '
	  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
	    let l=[];try{l=JSON.parse(d.slice(d.lastIndexOf("\n[")+1));}catch(e){}
	    const p=Array.isArray(l)?l.find(x=>x&&x.name===process.argv[1]):null;
	    const e=(p&&p.pm2_env)||{};
	    const n=(v)=>Number.isFinite(v)?String(v):"none";
	    process.stdout.write(n(e.pm_uptime)+" "+n(e.restart_time)+" "+String(e.status||"missing").replace(/[^A-Za-z0-9 _-]/g,"?"));
	  });' "$PM2"
}
read -r UPTIME_BEFORE _ <<<"$(pm2_state)"
if [ -f ecosystem.config.js ] && grep -q "name: '$PM2'" ecosystem.config.js; then
	pm2 restart ecosystem.config.js --update-env --silent 9>&-
else
	pm2 restart "$PM2" --silent 9>&-
fi
RESTART_RC=$?
read -r UPTIME_AFTER PM2_RESTARTS PM2_STATUS <<<"$(pm2_state)"
UPTIME_BEFORE=${UPTIME_BEFORE:-none}
UPTIME_AFTER=${UPTIME_AFTER:-none}
PM2_STATUS=${PM2_STATUS:-missing}
echo "restarting $PM2: pm2 returned $RESTART_RC, start time $UPTIME_BEFORE -> $UPTIME_AFTER, status $PM2_STATUS, restarts ${PM2_RESTARTS:-none}"
RESTART_OK=0
if [ "$RESTART_RC" != 0 ]; then
	echo "::error::pm2 exited $RESTART_RC restarting $PM2 — the restart is not proven"
elif [ "$UPTIME_BEFORE" = none ] || [ "$UPTIME_AFTER" = none ]; then
	echo "::error::pm2 gave no start time for $PM2 (before: $UPTIME_BEFORE, after: $UPTIME_AFTER) — the restart is not proven"
elif [ "$UPTIME_AFTER" = "$UPTIME_BEFORE" ]; then
	echo "::error::the restart of $PM2 did not take: pm2 still reports the start time from before it ($UPTIME_AFTER)"
else
	RESTART_OK=1
fi
# <<< pm2-restart
# An unproven restart means whatever answers next may still be the process of
# the commit that just failed. Polling it would read that process as the
# rollback's, so stop here: nothing is marked started or recorded.
if [ "$RESTART_OK" != 1 ]; then
	echo "::error::ROLLBACK FAILED — the restart of $PM2 at $TARGET is not proven, so the process serving may still be $FAILED. Nothing was marked started or recorded. MANUAL INTERVENTION REQUIRED."
	exit 1
fi
# TARGET is what runs now: mark it started, as remote-deploy.sh does (see LIVE
# there). Whether it serves is checked next.
git update-ref --create-reflog -m "logisx: started (rollback)" refs/logisx/started-deploy "$TARGET" \
	|| echo "::warning::could not mark $TARGET as started"
echo "::endgroup::"

PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
for _ in $(seq 1 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" || true)
	if [ "$code" = "200" ]; then break; fi
	sleep 2
done
if [ "$code" != "200" ]; then
	echo "::error::ROLLBACK FAILED — $PM2 is not serving at $TARGET either. MANUAL INTERVENTION REQUIRED."
	exit 1
fi
# The API answers. A rollback whose build left no client/dist/index.html
# answers every page with the 503 "being updated" page, which is down for
# everyone using the app: that is a failed rollback, not a recovery, and it is
# never recorded.
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
if [ "$PAGE_OK" != 1 ]; then
	echo "::error::ROLLBACK FAILED — $PM2 answers its API at $TARGET, but :$PORT/ gave $PAGE_CODE without the app's page (no id=\"app\"). A 503 there is the \"being updated\" page: client/dist/index.html is missing, so the app is down. Nothing was recorded as verified. MANUAL INTERVENTION REQUIRED."
	exit 1
fi
# Its pages, but whose client? Only TARGET's own build is a rollback.
if [ "$CLIENT_AT" != "$TARGET" ]; then
	echo "::error::ROLLBACK FAILED — $PM2 serves its pages at $TARGET, but with the client build of ${CLIENT_AT:-an unknown commit (client/dist has no .build-commit stamp)}, not $TARGET's: this rollback's own client build failed and no whole build of $TARGET was kept. Nothing was recorded as verified. MANUAL INTERVENTION REQUIRED."
	exit 1
fi
echo "ROLLBACK OK — $PM2 serving 200 on :$PORT at $TARGET"
# Serving again at TARGET: record it as the verified deploy (the
# verified-record block in remote-deploy.sh), still under the lock, but
# only when TARGET is not the commit that just failed verification
# (restarting that commit proves nothing its checks did not), came from
# a consistent record (the deploy's LIVE commit; with no record it was
# only HEAD, never verified), AND this rollback built it cleanly.
# Otherwise the record stays as it was.
if [ "$TARGET" = "$FAILED" ]; then
	echo "::warning::not recording $TARGET as verified: it is the commit that just failed verification"
elif [ "$RECORD_STATE" != ok ]; then
	echo "::warning::not recording $TARGET as verified: the deploy reported the verified-deploy record as '${RECORD_STATE:-unknown}', so $TARGET was only its HEAD"
elif [ "$BUILD_OK" != 1 ]; then
	echo "::warning::not recording $TARGET as verified: its install or build did not complete cleanly, although it serves"
elif git update-ref --create-reflog -m "logisx: rollback verified" refs/logisx/verified-deploy "$TARGET"; then
	echo "verified deploy recorded: $TARGET"
else
	echo "::warning::could not record $TARGET as the verified deploy — the drift check reads the previous record"
fi
exit 0
