#!/bin/bash
# Remote half of the deploy. Runs ON THE VPS, fed to `bash -s` over ssh.
#
# Lives in the repo rather than inline in deploy.yml so it is reviewable,
# diffable and shared by the staging and production jobs — the two must not
# drift, and a copy-paste in YAML is exactly how they would.
#
# Inputs (env): DIR, PM2, REF
# Prints:       DEPLOYED_FROM=<sha> / DEPLOYED_TO=<sha>  (the workflow captures
#               DEPLOYED_FROM so it can roll back to it without guessing)
set -uo pipefail

: "${DIR:?DIR is required}"
: "${PM2:?PM2 is required}"
: "${REF:?REF is required}"

cd "$DIR" || { echo "::error::$DIR does not exist"; exit 1; }

PREV=$(git rev-parse HEAD)
echo "::group::pre-deploy state"
echo "current HEAD: $PREV"

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

echo "::group::fetch + checkout $REF"
git fetch --prune origin
if [ "$REF" = "main" ]; then
	git checkout main && git pull --ff-only origin main
else
	git checkout --detach "$REF" 2>/dev/null || git checkout --detach "origin/$REF"
fi
NEW=$(git rev-parse HEAD)
echo "new HEAD: $NEW"
echo "::endgroup::"

echo "::group::resolve the Node this app actually runs on"
# ⚠️ Build with the SAME Node pm2 executes the app with, not whatever is on
# PATH. Native modules (better-sqlite3) are compiled per NODE_MODULE_VERSION;
# installing under one major and running under another is ERR_DLOPEN_FAILED on
# boot. pm2's interpreter is the single source of truth so the two cannot drift.
NODE_BIN=$(pm2 jlist | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    process.stdout.write(p && p.pm2_env ? (p.pm2_env.exec_interpreter||"") : "");
  });' "$PM2")
case "$NODE_BIN" in
	""|node) NODE_BIN=$(command -v node) ;;
esac
export PATH="$(dirname "$NODE_BIN"):$PATH"
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
	pm2 restart ecosystem.config.js --update-env --silent
else
	pm2 restart "$PM2" --silent
fi
# Parse jlist, never `pm2 describe` — describe renders a box-drawing table whose
# column widths shift with the value, so a sed against it silently stops
# matching. jlist is JSON and stable.
pm2 jlist | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const p=JSON.parse(d).find(x=>x.name===process.argv[1]);
    if(!p){console.error("::error::pm2 process "+process.argv[1]+" not found after restart");process.exit(1);}
    console.log("pm2 status: "+p.pm2_env.status+"  restarts: "+p.pm2_env.restart_time);
    if(p.pm2_env.status!=="online"){console.error("::error::pm2 reports status="+p.pm2_env.status);process.exit(1);}
  });' "$PM2"
echo "::endgroup::"

echo "DEPLOYED_FROM=$PREV"
echo "DEPLOYED_TO=$NEW"
