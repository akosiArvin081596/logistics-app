#!/bin/bash
# Staging smoke check. Runs ON THE GITHUB RUNNER, inside deploy.yml's staging
# job, right after the deploy. Production deploys only after it passes.
# Input: the origin to check (https://staging-app.logisx.com in the workflow),
# as the first argument or in BASE. Any running copy of the app can be checked
# the same way, a local replica included.
#
# Read-only and signed out: GETs only, no cookie, nothing that writes or bills.
# Each check names what it proves:
#   1. health      /api/config/maintenance answers 200 with the app's JSON
#                  through the public edge (nginx, TLS, the restarted process)
#   2. login page  /login answers 200 with the SPA's index.html
#   3. bundle      every /assets file that index.html names answers 200 with
#                  its own content type. The SPA fallback answers ANY unknown
#                  path with index.html and a 200, so a status alone would pass
#                  a bundle that is missing.
#   4. API auth    /api/tabs answers 401 without a session
#   5. live updates the Socket.IO handshake admits the app's own Origin (200)
#                  and refuses a foreign one (403). Each run leaves one
#                  "LIVE-UPDATE: … refused … Origin=https://example.invalid"
#                  line in staging's log; that line is this check.
#
# Retries: a request is retried ONLY while it has no answer (000) or a 5xx,
# 3 tries in all, 5 s apart. A definite wrong answer fails at once. The whole
# check stops at SMOKE_DEADLINE_S (default 100 s) so it ends inside the step's
# 2-minute timeout with its own error message.
#
# scripts/test-release-gate.js runs this script against a local stub server.
set -uo pipefail
# The base URL comes from the first argument or BASE, so a local run against
# any copy of the app is one command:
#   bash scripts/deploy/staging-smoke.sh http://127.0.0.1:3905
BASE=${1:-${BASE:-}}
: "${BASE:?pass the base URL as the first argument or in BASE}"
if ! [[ "$BASE" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
	echo "::error::staging smoke: BASE must be a bare origin like https://staging-app.logisx.com"
	exit 1
fi
DEADLINE=$((SECONDS + ${SMOKE_DEADLINE_S:-100}))
PAUSE=${SMOKE_RETRY_PAUSE_S:-5}
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

fail() {
	echo "::error title=Staging smoke failed::$1"
	exit 1
}

# ask URL [curl args...]: sets CODE and CTYPE; the body lands in $BODY. Never
# run in a subshell, so `fail` ends the whole check.
CODE=""
CTYPE=""
ask() {
	local url=$1 out try left
	shift
	for try in 1 2 3; do
		left=$((DEADLINE - SECONDS))
		[ "$left" -gt 0 ] || fail "out of time (${SMOKE_DEADLINE_S:-100} s) before $url answered"
		[ "$left" -lt 15 ] || left=15
		out=$(curl -s -o "$BODY" -w '%{http_code} %{content_type}' --max-time "$left" "$@" "$url" || true)
		CODE=${out%% *}
		CTYPE=${out#* }
		[ "$CTYPE" != "$out" ] || CTYPE=""
		case "$CODE" in
			000|5??|"")
				CODE=${CODE:-000}
				if [ "$try" -lt 3 ] && [ $((DEADLINE - SECONDS)) -gt "$PAUSE" ]; then
					echo "  $url -> $CODE, retrying in ${PAUSE}s ($try/3)"
					sleep "$PAUSE"
				fi
				;;
			*) break ;;
		esac
	done
}

# 1. health
ask "$BASE/api/config/maintenance"
echo "health      $BASE/api/config/maintenance -> $CODE"
[ "$CODE" = 200 ] || fail "health: /api/config/maintenance gave $CODE (want 200)"
grep -q '"enabled"' "$BODY" || fail "health: /api/config/maintenance answered 200 without the app's JSON"

# 2. login page
ask "$BASE/login"
echo "login page  $BASE/login -> $CODE $CTYPE"
[ "$CODE" = 200 ] || fail "login page: /login gave $CODE (want 200)"
[[ "$CTYPE" == text/html* ]] || fail "login page: /login answered '$CTYPE' (want text/html)"
grep -q 'id="app"' "$BODY" || fail "login page: /login is not the app's index.html (no #app mount point)"
assets=$(grep -oE '/assets/[A-Za-z0-9._-]+\.(js|css)' "$BODY" | sort -u || true)
[ -n "$assets" ] || fail "login page: index.html names no /assets bundle"

# 3. bundle
n=0
for a in $assets; do
	case "$a" in
		*.js) want='^(application|text)/javascript' ;;
		*) want='^text/css' ;;
	esac
	ask "$BASE$a"
	size=$(wc -c < "$BODY" | tr -d ' ')
	echo "bundle      $a -> $CODE $CTYPE, $size bytes"
	[ "$CODE" = 200 ] || fail "bundle: $a gave $CODE (want 200)"
	[[ "$CTYPE" =~ $want ]] || fail "bundle: $a answered '$CTYPE', not its own file (a missing bundle falls through to index.html)"
	[ "$size" -gt 0 ] || fail "bundle: $a is empty"
	n=$((n + 1))
done

# 4. API auth
ask "$BASE/api/tabs"
echo "API auth    $BASE/api/tabs (no session) -> $CODE"
[ "$CODE" = 401 ] || fail "API auth: /api/tabs without a session gave $CODE (want 401)"

# 5. live updates
ask "$BASE/socket.io/?EIO=4&transport=polling" -H "Origin: $BASE"
echo "handshake   own Origin -> $CODE"
[ "$CODE" = 200 ] || fail "live-update handshake: the app's own Origin gave $CODE (want 200)"
ask "$BASE/socket.io/?EIO=4&transport=polling" -H "Origin: https://example.invalid"
echo "handshake   foreign Origin -> $CODE"
[ "$CODE" = 403 ] || fail "live-update handshake: a foreign Origin gave $CODE (want 403)"

echo "staging smoke OK: health 200, login page 200, $n bundle files 200, API 401 without a session, handshake 200/403"
