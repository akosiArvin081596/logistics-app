#!/bin/bash
# Waits for CI's `check · unit · build` on ONE commit. Runs ON THE GITHUB
# RUNNER, inside deploy.yml's staging job (push runs only), after the staging
# smoke check. Production deploys only after it passes.
#
# Why: branch protection no longer requires a PR to be up to date with main, so
# the commit a merge creates on main can be a combination no PR run tested.
# ci.yml's push run is the first CI verdict on it, and production waits for it.
#
# Inputs (env):
#   REPO      owner/name
#   SHA       the full commit SHA to wait for
#   GH_TOKEN  a token with checks: read (the job's github.token)
#   CHECK_NAME   default "check · unit · build" (ci.yml's job name, and the
#                check branch protection requires)
#   CI_WAIT_S    how long to wait in all, default 1200 (20 min: ci.yml's
#                15-minute job timeout plus room for its runner queue)
#   CI_POLL_S    seconds between reads, default 15
#
# Passes only on the newest GitHub Actions check run of that name on that
# commit (the highest id: a queued re-run has no start time yet) concluding
# `success`. Any other conclusion (failure, cancelled, timed_out, skipped, ...)
# fails at once; no check run, or one still queued or running, is polled until
# CI_WAIT_S runs out, then fails. A read GitHub answers with a 4xx fails at
# once, since waiting will not fix a missing permission, except a 429 or a 403
# that names a rate limit. Any other failed read is retried until the deadline.
#
# scripts/test-release-gate.js runs this script against a stub `gh`.
set -uo pipefail
: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"
CHECK_NAME=${CHECK_NAME:-check · unit · build}
WAIT_S=${CI_WAIT_S:-1200}
POLL_S=${CI_POLL_S:-15}
if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
	echo "::error title=CI on main not confirmed::want REPO as owner/name and a full 40-character SHA (got '$REPO', '$SHA'). Production not deployed."
	exit 1
fi

deadline=$((SECONDS + WAIT_S))
url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/commit/$SHA/checks"
# One line per read: "<status> <conclusion> <html_url>", or "none".
JQ='[.check_runs[] | select(.app.slug == "github-actions")] | if length == 0 then "none" else (sort_by(.id) | last | "\(.status) \(.conclusion // "none") \(.html_url)") end'
last=""
while :; do
	if out=$(gh api -X GET "repos/$REPO/commits/$SHA/check-runs" -f check_name="$CHECK_NAME" -f filter=latest --jq "$JQ" 2>&1); then
		read -r status conclusion link <<<"$out"
		case "$status $conclusion" in
			"completed success")
				echo "CI '$CHECK_NAME' passed on $SHA: $link"
				exit 0
				;;
			completed\ *)
				echo "::error title=CI on main failed::'$CHECK_NAME' concluded '$conclusion' on $SHA. Production not deployed. $link"
				exit 1
				;;
			none\ *|queued\ *|in_progress\ *|waiting\ *|requested\ *|pending\ *)
				now="${status}"
				;;
			*)
				now="unreadable answer '$out'"
				;;
		esac
	else
		if printf '%s' "$out" | grep -qE 'HTTP 4([0-1][0-9]|2[0-8]|[3-9][0-9])' && ! printf '%s' "$out" | grep -qiE 'rate limit'; then
			echo "::error title=CI on main not confirmed::GitHub refused the check-run read: $(printf '%s' "$out" | head -1). Production not deployed."
			exit 1
		fi
		now="read failed: $(printf '%s' "$out" | head -1)"
	fi
	if [ "$now" != "$last" ]; then
		echo "CI '$CHECK_NAME' on $SHA: $now"
		last=$now
	fi
	if [ $((deadline - SECONDS)) -le 0 ]; then
		echo "::error title=CI on main not confirmed::'$CHECK_NAME' gave no verdict on $SHA within ${WAIT_S}s (last: $now). Production not deployed. $url"
		exit 1
	fi
	sleep "$POLL_S"
done
