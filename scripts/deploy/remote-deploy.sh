#!/bin/bash
# Remote half of the deploy. Runs ON THE VPS, fed to `bash -s` over ssh.
#
# Lives in the repo rather than inline in deploy.yml so it is reviewable,
# diffable and shared by the staging and production jobs — the two must not
# drift, and a copy-paste in YAML is exactly how they would. deploy-drift.yml's
# heal runs this same file through the same composite action.
#
# Inputs (env): DIR, PM2, REF, and optionally SHA
#   SHA  a full 40-character commit to deploy EXACTLY (REF must be main). Every
#        push-triggered deploy passes the commit that triggered it, and the
#        drift heal passes the commit whose staging job passed. Without it,
#        REF=main means origin/main's tip at pull time.
# Prints:       DEPLOYED_FROM=<sha> / DEPLOYED_TO=<sha>  (the workflow captures
#               DEPLOYED_FROM so it can roll back to it without guessing: code
#               that ran here, see ROLLBACK_TO below, or HEAD while there is no
#               consistent record), DEPLOY_RECORD_STATE=ok|missing|inconsistent,
#               DEPLOY_HANDSHAKE_GUARD=1|0 (whether the commit now serving
#               refuses a foreign Origin), and, always LAST, DEPLOY_RESULT=
#               deployed|noop (noop: a newer live main commit already contains
#               SHA; DEPLOY_NOOP=1 is printed too, for people). The workflow
#               takes the last line of each, so no earlier output can stand in.
# Exit codes:   0 deployed (or a no-op), 75 another deploy holds the box lock,
#               anything else a failure. 75 is deliberately not an ssh transport
#               code (255), so ssh-retry.sh does not retry it.
#
# ⚠️ This script never records its own deploy as verified: it cannot know. The
# record is written by remote-record-verified.sh, which .github/actions/vps-deploy
# runs only after the restart AND the smoke check (and the public edge check,
# where the job has one) passed. See the verified-record block below.
set -uo pipefail

: "${DIR:?DIR is required}"
: "${PM2:?PM2 is required}"
: "${REF:?REF is required}"
SHA=${SHA:-}

# Validate before touching anything, including the lock.
if [ -n "$SHA" ]; then
	if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
		echo "::error::SHA must be a full 40-character lowercase commit id (got '$SHA') — nothing was changed"
		exit 1
	fi
	if [ "$REF" != "main" ]; then
		echo "::error::SHA pins a commit ON main, so REF must be main (got REF=$REF) — to deploy another ref, pass it as REF with no SHA"
		exit 1
	fi
fi

LOCK_OWNER=remote-deploy.sh
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

PREV=$(git rev-parse HEAD)
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

# ── LIVE: the commit the app runs now, as far as the box can tell ────────────
# The record lags a deploy whose restart and checks passed but whose SEPARATE
# record step then failed (ssh gave up, the job timed out): that commit serves
# while the record still names the one before. So every commit this script or
# a rollback STARTS is marked too (refs/logisx/started-deploy, written only
# once pm2 has proven the restart took, see the pm2-restart block). That mark
# is live when it follows the record and HEAD still contains it; otherwise the
# record is live. LIVE is the no-op floor and the floor main may move back to;
# the drift check keeps reading the record, so an unrecorded deploy still gets
# its one heal.
#
# ⚠️ LIVE never depends on whether the app answers. A started commit RAN, and a
# check that happens to miss (a slow moment, a blocked event loop) must never
# let a deploy of an older commit move main back over it while the job goes
# green. The answer below chooses the rollback target and nothing else.
PORT=$(grep -oE '^PORT=[0-9]+' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
PORT=${PORT:-3000}
# Does the app answer, before this deploy changes anything? Polled like
# remote-smoke.sh, but only 3 tries, 2 s apart: a deploy of an app that is
# down should not wait long to fix it.
SERVING=""
for try in 1 2 3; do
	SERVING=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" || true)
	if [ "$SERVING" = "200" ] || [ "$try" = 3 ]; then break; fi
	sleep 2
done
STARTED=$(git rev-parse --verify -q "refs/logisx/started-deploy^{commit}" || true)
LIVE=""
if [ "$VERIFIED_STATE" = ok ]; then
	LIVE=$VERIFIED
	if [ -n "$STARTED" ] && git merge-base --is-ancestor "$VERIFIED" "$STARTED" && git merge-base --is-ancestor "$STARTED" HEAD; then
		LIVE=$STARTED
	fi
fi

# The rollback target: code that ran here. HEAD may be a commit a failed deploy
# checked out and never started, and rolling back to that would restore code
# that never ran. So the record, or the started commit while the app answers
# now: a started commit that does not answer may be exactly what broke. With
# no consistent record, HEAD, as before. Once the checkout is done it is also
# never the commit this run's checks will judge, unless that commit is the
# record (see NEW below, and the no-op).
if [ -z "$LIVE" ]; then
	ROLLBACK_TO=$PREV
elif [ "$LIVE" != "$VERIFIED" ] && [ "$SERVING" != "200" ]; then
	ROLLBACK_TO=$VERIFIED
else
	ROLLBACK_TO=$LIVE
fi

echo "::group::pre-deploy state"
echo "current HEAD:    $PREV"
echo "verified deploy: ${VERIFIED:-none} (record $VERIFIED_STATE)"
echo "started deploy:  ${STARTED:-none} (app answers ${SERVING:-nothing})"
echo "live commit:     ${LIVE:-unknown}"
echo "rollback target: $ROLLBACK_TO"
echo "deploy lock:     $LOCK_FILE (held)"
if [ "$VERIFIED_STATE" = inconsistent ]; then
	echo "::warning::the verified-deploy record does not match this clone's history — no no-op, a full deploy; the record is rewritten once this deploy is verified"
fi
# Whatever HEAD holds past the rollback target never ran here (or ran and was
# never recorded), and a rollback of this deploy drops it: say which commits.
DROPPED=$(git log --oneline "$ROLLBACK_TO..$PREV" 2>/dev/null | tr '\n' ';' | sed 's/;$//')
if [ -n "$DROPPED" ]; then
	echo "::warning::a rollback of this deploy returns to $ROLLBACK_TO and drops these commits HEAD holds past it: $DROPPED"
fi

# ── The load-bearing lockfile reset ──────────────────────────────────────────
# The box's npm strips the `"libc": [...]` field a newer npm writes onto
# optional platform deps, so EVERY install here leaves the lockfile modified.
# `git pull --ff-only` refuses to overwrite a modified tracked file, so without
# this the first PR touching it aborts the deploy.
#
# ⚠️ Moving the build to Node 22 did NOT fix this — it still happens under
# npm 10.9.8, and got larger (15 deletions 2026-08-17 -> 81 on 2026-08-25).
# Safe to discard: npm regenerates it below and nothing reads it at runtime.
for f in client/package-lock.json package-lock.json; do
	if ! git diff --quiet -- "$f" 2>/dev/null; then
		echo "resetting npm-skew drift on $f"
		git checkout -- "$f"
	fi
done

# ── Refuse to clobber an unexpected local change ─────────────────────────────
# Anything ELSE modified is a hand-applied hotfix. A blanket `git checkout -- .`
# would destroy it silently, which is why CLAUDE.md forbids one here.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
	echo "::error::$DIR has local modifications beyond the lockfiles — refusing to deploy over them:"
	echo "$DIRTY"
	exit 1
fi
echo "::endgroup::"

echo "::group::fetch + checkout $REF${SHA:+ @ $SHA}"
# ⚠️ Every git step below is CHECKED. This script runs without `set -e`, so an
# unchecked failure would fall through to the build and restart the commit
# already live. A deploy that did not move must fail.
git fetch --prune origin 9>&- || echo "::warning::git fetch failed — whatever the checkout needs must already be in this clone"
if [ -n "$SHA" ]; then
	if ! git cat-file -e "$SHA^{commit}" 2>/dev/null; then
		echo "::error::$SHA is not in this clone even after fetching — nothing was changed"
		exit 1
	fi
	if ! git merge-base --is-ancestor "$SHA" origin/main; then
		echo "::error::$SHA is not on origin/main — refusing to deploy a commit main does not contain. Nothing was changed."
		exit 1
	fi
	# A newer main commit is already LIVE (runs finished out of order, or an old
	# run was re-run). Never move backwards; there is nothing to do.
	# ⚠️ Judged by LIVE, NOT HEAD. HEAD may be a commit a failed deploy checked
	# out and never started; a no-op against it would pass the smoke check on
	# the old process and count a commit as deployed that never ran. No
	# consistent record means no no-op at all: a full deploy.
	if [ -n "$LIVE" ] && [ "$SHA" != "$LIVE" ] && git merge-base --is-ancestor "$SHA" "$LIVE" \
		&& git merge-base --is-ancestor "$LIVE" origin/main; then
		echo "the live deploy $LIVE already contains $SHA — a newer main commit is live. Not moving backwards; nothing to deploy."
		# A no-op changes nothing, so the checks after it judge what runs now:
		# LIVE. Like a deploy's (see NEW below), its rollback never returns to
		# the very commit those checks judge unless it is the verified record.
		# A started LIVE that fails them may be exactly what broke, and after a
		# half-finished deploy (HEAD past LIVE) a rollback to it would even
		# record it as verified.
		if [ "$ROLLBACK_TO" = "$LIVE" ] && [ "$VERIFIED" != "$LIVE" ]; then
			ROLLBACK_TO=$VERIFIED
			echo "::warning::the live commit $LIVE was started here and is not the verified deploy $VERIFIED — if the checks after this no-op fail, the rollback returns to $VERIFIED, not to $LIVE"
		fi
		echo "::endgroup::"
		if git grep -q 'allowRequest: liveUpdateHandshakeAllowed' "$LIVE" -- server.js 2>/dev/null; then GUARD=1; else GUARD=0; fi
		echo "DEPLOY_NOOP=1"
		echo "DEPLOYED_FROM=$ROLLBACK_TO"
		echo "DEPLOYED_TO=$LIVE"
		echo "DEPLOY_RECORD_STATE=$VERIFIED_STATE"
		echo "DEPLOY_HANDSHAKE_GUARD=$GUARD"
		echo "DEPLOY_RESULT=noop"
		exit 0
	fi
	# Checked BEFORE the checkout: if local main is already past $SHA, the
	# fast-forward would "succeed" on a different commit, with HEAD moved first.
	if git merge-base --is-ancestor main "$SHA"; then
		if ! { git checkout main && git merge --ff-only "$SHA" 9>&-; }; then
			echo "::error::could not fast-forward main to $SHA — nothing was built or restarted"
			exit 1
		fi
	elif [ -n "$LIVE" ] && git merge-base --is-ancestor "$LIVE" "$SHA" \
		&& { [ -z "$STARTED" ] || ! git merge-base --is-ancestor "$STARTED" HEAD || git merge-base --is-ancestor "$STARTED" "$SHA"; } \
		&& git merge-base --is-ancestor main origin/main; then
		# Local main is past $SHA only by commits past the last LIVE deploy: the
		# live commit is at or before $SHA, so whatever main holds beyond it was
		# checked out by a deploy that never started it. Moving main back to
		# $SHA drops no commit the app has run since its last live one, and
		# nothing only this clone has (main is contained in origin/main); the
		# pre-deploy warning above names what HEAD held past the live commit.
		# ⚠️ Nor a started commit HEAD contains, whatever the app answered: $SHA
		# must contain that too. LIVE already covers a started commit that
		# follows the record; the middle clause also covers one that does not,
		# which HEAD can still hold through a merge.
		# Without a record there is no such proof, so this never happens then:
		# the refusal below stands.
		echo "local main ($(git rev-parse main)) is past $SHA only by commits past the last live deploy $LIVE — moving main back to $SHA"
		if ! git checkout -B main "$SHA"; then
			echo "::error::could not move main back to $SHA — nothing was built or restarted"
			exit 1
		fi
	else
		echo "::error::local main ($(git rev-parse main 2>/dev/null)) is past $SHA, and with the verified-deploy record $VERIFIED_STATE this box cannot prove main's extra commits never ran, so it will not move main back (live commit ${LIVE:-unknown}, started deploy ${STARTED:-none}). Nothing was changed. To deploy main's tip, run Deploy with ref=main; to run exactly this commit, run Deploy with ref=$SHA (a pin)."
		exit 1
	fi
elif [ "$REF" = "main" ]; then
	if ! { git checkout main && git pull --ff-only origin main 9>&-; }; then
		echo "::error::could not fast-forward main to origin/main — nothing was built or restarted"
		exit 1
	fi
else
	if ! { git checkout --detach "$REF" 2>/dev/null || git checkout --detach "origin/$REF"; }; then
		echo "::error::cannot check out $REF — nothing was built or restarted"
		exit 1
	fi
	# A deliberate pin OFF main (a manual rollback, or a hotfix ref) is a human
	# decision. Record main's tip in the drift marker so deploy-drift.yml raises
	# an alarm and does not deploy main over the pin. The next deploy of main (a
	# push, or a dispatch with ref=main) ends the pin.
	PIN_MAIN=$(git rev-parse --verify -q origin/main || true)
	if [ -n "$PIN_MAIN" ] && [ "$PIN_MAIN" != "$(git rev-parse HEAD)" ]; then
		if printf '%s' "$PIN_MAIN" > "$DIR/.drift-heal-attempted"; then
			echo "pinned off main: drift marker set to $PIN_MAIN (deploy-drift.yml will alarm, not auto-deploy it)"
		else
			echo "::warning::could not write the drift marker — deploy-drift.yml does not know about this pin"
		fi
	fi
fi
NEW=$(git rev-parse HEAD)
if [ -n "$SHA" ] && [ "$NEW" != "$SHA" ]; then
	echo "::error::HEAD is $NEW after checkout, expected exactly $SHA — refusing to build it"
	exit 1
fi
echo "new HEAD: $NEW"
# ⚠️ A rollback never returns to the very commit this deploy restarts, unless
# that commit is the verified record. LIVE can be a started commit that is not
# the record: one whose own checks failed while its rollback never ran (ssh
# gave up, the job timed out). A drift heal or a re-run of that commit would
# otherwise name it as its own rollback target, and when its checks failed
# again the rollback would restart the same commit and, serving, record it as
# verified. The record is the last commit that PASSED its checks.
if [ "$ROLLBACK_TO" = "$NEW" ] && [ -n "$VERIFIED" ] && [ "$VERIFIED" != "$NEW" ]; then
	ROLLBACK_TO=$VERIFIED
	echo "::warning::$NEW is the commit this deploy restarts, and the verified deploy is $VERIFIED — a rollback of this deploy returns to $VERIFIED instead, and drops: $(git log --oneline "$VERIFIED..$NEW" 2>/dev/null | tr '\n' ';' | sed 's/;$//')"
fi
echo "::endgroup::"

echo "::group::resolve the Node this app actually runs on"
# ⚠️ Build with the SAME Node pm2 executes the app with, not whatever is on
# PATH. Native modules (better-sqlite3) are compiled per NODE_MODULE_VERSION;
# installing under one major and running under another is ERR_DLOPEN_FAILED on
# boot. pm2's interpreter is the single source of truth so the two cannot drift.
NODE_BIN=$(pm2 jlist 9>&- | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$PM2")
case "$NODE_BIN" in
	""|node) NODE_BIN=$(command -v node) ;;
esac
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
echo "pm2 interpreter: $NODE_BIN"
echo "building with:   $(command -v node) $(node --version) / npm $(npm --version)"
echo "::endgroup::"

echo "::group::install + build"
npm install --silent --no-audit --no-fund
# npm tracks package VERSIONS, not ABI — it reports "up to date" and skips the
# rebuild when only the Node major changed. Probe, then rebuild only on failure.
#
# ⚠️ The probe OPENS a database. require('better-sqlite3') alone passes under an
# ABI-mismatched Node, because the native binding loads lazily, on the first
# `new Database()`. Measured on the VPS 2026-09-19: /usr/bin/node v20 passes
# require() and fails new Database(). backup.sh's probe was fixed the same way;
# scripts/test-deploy-scripts.js §9 pins both.
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
	echo "native ABI mismatch detected — rebuilding better-sqlite3 for $(node --version)"
	npm rebuild better-sqlite3
	node -e "new (require('better-sqlite3'))(':memory:').close()" || { echo "::error::better-sqlite3 still fails to load after rebuild"; exit 1; }
fi
echo "native modules OK under $(node --version)"
npm run build:client --silent
test -f client/dist/index.html || { echo "::error::build produced no client/dist/index.html"; exit 1; }
echo "::endgroup::"

echo "::group::restart"
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
if [ "$RESTART_OK" != 1 ]; then
	echo "::error::$NEW is not marked started, and this deploy fails so that nothing records it as verified: the process serving may still be the one from before it"
	exit 1
fi
# Not online is reported, not fatal: the smoke check next decides (and on
# production rolls back). It only means this commit is NOT marked started.
if [ "$PM2_STATUS" = online ]; then
	# Started: it is running now, whether or not the record step later gets to
	# record it as verified (see LIVE above).
	git update-ref --create-reflog -m "logisx: started" refs/logisx/started-deploy "$NEW" \
		|| echo "::warning::could not mark $NEW as started"
else
	echo "::error::pm2 reports status=$PM2_STATUS for $PM2 after the restart — $NEW is not marked started"
fi
echo "::endgroup::"

# The live-update Origin check only exists in server.js since it gained
# liveUpdateHandshakeAllowed; the public edge check asks a foreign Origin for a
# 403 only when the commit deployed has it (a rollback by hand may not).
if git grep -q 'allowRequest: liveUpdateHandshakeAllowed' "$NEW" -- server.js 2>/dev/null; then GUARD=1; else GUARD=0; fi
# The workflow reads each of these from the LAST line of its kind, and
# DEPLOY_RESULT is always the final line.
echo "DEPLOYED_FROM=$ROLLBACK_TO"
echo "DEPLOYED_TO=$NEW"
echo "DEPLOY_RECORD_STATE=$VERIFIED_STATE"
echo "DEPLOY_HANDSHAKE_GUARD=$GUARD"
echo "DEPLOY_RESULT=deployed"
