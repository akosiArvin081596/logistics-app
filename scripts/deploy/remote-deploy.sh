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
#               DEPLOYED_FROM so it can roll back to it without guessing), and
#               DEPLOY_NOOP=1 when the box already runs a newer main commit.
# Exit codes:   0 deployed (or a no-op), 75 another deploy holds the box lock,
#               anything else a failure. 75 is deliberately not an ssh transport
#               code (255), so ssh-retry.sh does not retry it.
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

cd "$DIR" || { echo "::error::$DIR does not exist"; exit 1; }

PREV=$(git rev-parse HEAD)
echo "::group::pre-deploy state"
echo "current HEAD: $PREV"
echo "deploy lock:  $LOCK_FILE (held)"

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
	# A newer MAIN commit is already live (runs finished out of order, or an old
	# run was re-run). Never move backwards; there is nothing to do.
	if [ "$SHA" != "$PREV" ] && git merge-base --is-ancestor "$SHA" "$PREV" \
		&& git merge-base --is-ancestor "$PREV" origin/main; then
		echo "HEAD $PREV already contains $SHA — a newer main commit is live. Not moving backwards; nothing to deploy."
		echo "::endgroup::"
		echo "DEPLOY_NOOP=1"
		echo "DEPLOYED_FROM=$PREV"
		echo "DEPLOYED_TO=$PREV"
		exit 0
	fi
	# Checked BEFORE the checkout: if local main is already past $SHA, the
	# fast-forward would "succeed" on a different commit, with HEAD moved first.
	if ! git merge-base --is-ancestor main "$SHA"; then
		echo "::error::local main ($(git rev-parse main 2>/dev/null)) cannot fast-forward to $SHA — nothing was changed"
		exit 1
	fi
	if ! { git checkout main && git merge --ff-only "$SHA"; }; then
		echo "::error::could not fast-forward main to $SHA — nothing was built or restarted"
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
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
	echo "native ABI mismatch detected — rebuilding better-sqlite3 for $(node --version)"
	npm rebuild better-sqlite3
	node -e "require('better-sqlite3')" || { echo "::error::better-sqlite3 still fails to load after rebuild"; exit 1; }
fi
echo "native modules OK under $(node --version)"
npm run build:client --silent
test -f client/dist/index.html || { echo "::error::build produced no client/dist/index.html"; exit 1; }
echo "::endgroup::"

echo "::group::restart"
# ⚠️ Name-scoped, ALWAYS. This VPS hosts ~23 other pm2 processes for other
# clients. `pm2 restart all` or a numeric id would take those down too.
#
# ⚠️ Production is restarted through ecosystem.config.js, NOT by name, because
# it carries five pm2-level settings — NODE_OPTIONS (the 4 GB heap that exists
# because it was OOM-ing at 2 GB), kill_timeout, max_restarts, min_uptime and
# restart_delay. A plain by-name restart re-reads the dump and keeps them, but
# going through the file is what makes a CHANGED setting take effect.
if [ -f ecosystem.config.js ] && grep -q "name: '$PM2'" ecosystem.config.js; then
	pm2 restart ecosystem.config.js --update-env --silent 9>&-
else
	pm2 restart "$PM2" --silent 9>&-
fi
# Parse jlist, never `pm2 describe` — describe renders a box-drawing table whose
# column widths shift with the value, so a sed against it silently stops
# matching. jlist is JSON and stable.
pm2 jlist 9>&- | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    if(!p){console.error("::error::pm2 process "+process.argv[1]+" not found after restart");process.exit(1);}
    console.log("pm2 status: "+p.pm2_env.status+"  restarts: "+p.pm2_env.restart_time);
    if(p.pm2_env.status!=="online"){console.error("::error::pm2 reports status="+p.pm2_env.status);process.exit(1);}
  });' "$PM2"
echo "::endgroup::"

echo "DEPLOYED_FROM=$PREV"
echo "DEPLOYED_TO=$NEW"
