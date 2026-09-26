#!/bin/bash
# ssh to the VPS, retrying on TRANSPORT failure only. Runs ON THE GITHUB RUNNER,
# not the VPS. The single copy used by .github/actions/vps-deploy (every deploy,
# smoke check and rollback) and deploy-drift.yml (the check and the heal prep),
# so every connection to the box gets the same transport retry.
#
# Usage: ssh-retry.sh <user@host> <remote command>
#   The payload (a script for the remote `bash -s`) arrives on stdin and is
#   replayed in full on every attempt. Needs ~/.ssh/deploy_key and
#   ~/.ssh/known_hosts, written by ssh-setup.sh.
#
# Retry ONLY on ssh transport failure. ssh reserves exit 255 for its own
# errors; any other status is the REMOTE script's and passes through. A deploy
# that genuinely fails must fail once and loudly, not five times. That includes
# 75, "another deploy holds the box lock": retrying it would queue this deploy
# behind one whose outcome it cannot see.
#
# ⚠️ THE BUDGET IS SIZED FROM A MEASURED OUTAGE, not picked round.
# Runner→VPS connectivity drops occasionally: 2 of 25 deploy runs on
# 2026-08-25 (8%) hit "Connection timed out" — a network-level SYN
# blackhole, not the host (fail2ban clear, no sshd drops, load 0.2).
# The first budget was 3 attempts over ~70 s and it was EXHAUSTED at
# 13:19:29 / 13:19:59 / 13:20:39. Five attempts with escalating backoff
# spans ~5 min (5×20 s connect + 15+30+60+90 s waiting), which covers
# that blip with room to spare and still sits inside the job timeouts.
#
# This matters because nobody watches a deploy finish (a reviewer
# approves production's start, since 2026-09-25, not its end): a
# transport failure means production silently stays behind main until
# someone looks at the Actions tab.
#
# SSH_RETRY_BACKOFF (space-separated seconds) overrides the waits. Tests only.
set -uo pipefail

DEST=${1:?usage: ssh-retry.sh <user@host> <remote command>}
REMOTE_CMD=${2:?usage: ssh-retry.sh <user@host> <remote command>}
PAYLOAD=$(cat)
BACKOFF=${SSH_RETRY_BACKOFF-15 30 60 90}

total=1
for _ in $BACKOFF; do total=$((total + 1)); done

attempt=0
for wait in $BACKOFF ""; do
	attempt=$((attempt + 1))
	printf '%s' "$PAYLOAD" | ssh -i ~/.ssh/deploy_key -o BatchMode=yes \
		-o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
		"$DEST" "$REMOTE_CMD"
	rc=$?
	[ "$rc" -ne 255 ] && exit "$rc"
	if [ -n "$wait" ]; then
		echo "::warning::ssh transport failure (255), attempt $attempt/$total — retrying in ${wait}s"
		sleep "$wait"
	fi
done
# ⚠️ This exact line is how deploy-drift.yml tells a staging job that never
# reached the VPS (re-run it once) from one that failed (alarm):
# scripts/deploy/drift-gate.js reads it back as a check-run annotation, by the
# title, or by the message prefix alone for Deploy runs from before the title.
# Keep both stable. Printed only here, after the LAST attempt, so a deploy that
# connected and failed never carries it. scripts/test-deploy-scripts.js pins it.
echo "::error title=VPS unreachable::ssh failed to connect after $total attempts — runner→VPS network, not the deploy"
exit 255
