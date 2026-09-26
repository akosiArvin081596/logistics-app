#!/usr/bin/env bash
# Make a worktree bootable for the browser harness WITHOUT npm install / npm ci
# there (either would rewrite client/package-lock.json):
#   - symlink node_modules, client/node_modules, .env and service-account-key.json
#     from the main checkout (all gitignored, so the worktree stays clean)
#   - warn if the worktree's dependency manifests differ from the main checkout's,
#     because then the linked node_modules may be missing a package
#   - build the client (client/dist, gitignored)
#
#   scripts/e2e/prep-worktree.sh [<worktree>]     (default: the checkout this script is in)
#
# Env:
#   NODE_BIN       the node to build with (default: `node` on PATH; .nvmrc's version expected)
#   MAIN_CHECKOUT  the main checkout (default: the parent of git's common dir)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
WT="$(cd "${1:-$REPO}" 2>/dev/null && pwd -P)" || { echo "no such directory: ${1:-$REPO}"; exit 2; }
[ -f "$WT/server.js" ] || { echo "no server.js in $WT"; exit 2; }
if [ -n "${MAIN_CHECKOUT:-}" ]; then
  MAIN="$(cd "$MAIN_CHECKOUT" && pwd -P)"
else
  COMMON="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)"
  MAIN="$(cd "$(dirname "$COMMON")" && pwd -P)"
fi
[ "$WT" != "$MAIN" ] || { echo "refusing: $WT is the main checkout, which has its own installs (build it with npm run build:client)"; exit 2; }
echo "worktree: $WT"
echo "main checkout: $MAIN"

missing=0
link() {
  local rel="$1"
  if [ -e "$WT/$rel" ] || [ -L "$WT/$rel" ]; then echo "exists:  $rel"
  elif [ -e "$MAIN/$rel" ]; then ln -s "$MAIN/$rel" "$WT/$rel"; echo "linked:  $rel -> $MAIN/$rel"
  else echo "MISSING: the main checkout has no $rel"; missing=1; fi
}
link node_modules
link client/node_modules
link .env
link service-account-key.json
[ "$missing" = 0 ] || { echo "prep-worktree: set up the main checkout first (the files marked MISSING)"; exit 2; }

for f in package.json package-lock.json client/package.json client/package-lock.json; do
  if ! cmp -s "$WT/$f" "$MAIN/$f"; then
    echo "WARNING: $f differs from the main checkout; the linked node_modules may lack a dependency this branch needs."
  fi
done

# A NODE_BIN path brings its own npm (the same bin directory).
case "$NODE_BIN" in */*) PATH="$(cd "$(dirname "$NODE_BIN")" && pwd):$PATH"; export PATH;; esac
WANT=22.23.2
if [ -f "$REPO/.nvmrc" ]; then WANT="$(tr -d '[:space:]' < "$REPO/.nvmrc")"; fi
WANT="v${WANT#v}"
HAVE="$(node -v)"
echo "node $HAVE"
[ "$HAVE" = "$WANT" ] || echo "WARNING: node is $HAVE, but .nvmrc pins $WANT. Run under it: fnm exec --using=${WANT#v} $0 $*"
cd "$WT"
npm run build:client 2>&1 | tail -5
