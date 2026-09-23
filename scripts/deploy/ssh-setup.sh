#!/bin/bash
# Writes the deploy key and the PINNED host key that ssh-retry.sh uses.
# Runs ON THE GITHUB RUNNER, not the VPS. Shared by .github/actions/vps-deploy
# and deploy-drift.yml so the two cannot drift apart.
#
# Inputs (env): VPS_SSH_KEY, VPS_SSH_KNOWN_HOSTS — passed through env, never
# interpolated into the script text.
#
# Host key is PINNED from a secret, never discovered with ssh-keyscan —
# keyscan trusts whatever answers first, and this step hands that host a key
# that can restart production.
set -euo pipefail

key=${VPS_SSH_KEY:-}
known=${VPS_SSH_KNOWN_HOSTS:-}
# ⚠️ Test the VALUE, not the written file: `printf '%s\n' "$secret"` writes one
# newline byte even for an empty secret, so a file-size test (`test -s`)
# cannot see it.
if [ -z "${known//[[:space:]]/}" ]; then
	echo "::error::VPS_SSH_KNOWN_HOSTS is empty — refusing to ssh without a pinned host key"
	exit 1
fi
if [ -z "${key//[[:space:]]/}" ]; then
	echo "::error::VPS_SSH_KEY is empty"
	exit 1
fi

umask 077
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' "$key" > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
printf '%s\n' "$known" > ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts
