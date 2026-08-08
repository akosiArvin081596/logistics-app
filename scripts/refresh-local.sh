#!/usr/bin/env bash
# scripts/refresh-local.sh — bring THIS machine's checkout to origin/main and
# rebuild app.db from the latest sanitized production snapshot.
#
# Run it from the repository root:
#   ./scripts/refresh-local.sh                 # code + data
#   ./scripts/refresh-local.sh --code-only     # skip the database
#   ./scripts/refresh-local.sh --telemetry-all # full-fidelity telemetry (bigger, slower)
#
# It never touches production. The database source is the NIGHTLY SNAPSHOT
# (scripts/backup-db.js output), not the live production app.db, so nothing here
# opens a file production is writing to.
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@76.13.22.110}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/abedubas_vps}"
PROD_BACKUPS="/var/www/logistics-app/backups"
LOCAL_SHEET_ID="156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0"   # "Dispatch Management (LOCAL)"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

CODE_ONLY=0
EXTRA_ARGS=()
for a in "$@"; do
  case "$a" in
    --code-only) CODE_ONLY=1 ;;
    *) EXTRA_ARGS+=("$a") ;;
  esac
done

say() { echo "[refresh-local] $*"; }
die() { echo "[refresh-local] FAILED: $*" >&2; exit 1; }

# --- the sheet gate, before anything else -----------------------------------
# server.js falls through to the PRODUCTION sheet when SPREADSHEET_ID is unset,
# so a local checkout without an override is a production writer. Check it here
# as well as inside refresh-env.js: this is the file people forget.
if [ ! -f .env ]; then
  die ".env not found. Create one with SPREADSHEET_ID=$LOCAL_SHEET_ID before refreshing."
fi
CURRENT_SHEET="$(grep -E '^SPREADSHEET_ID=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
if [ -z "$CURRENT_SHEET" ]; then
  die ".env has no SPREADSHEET_ID — server.js would use the PRODUCTION sheet. Set SPREADSHEET_ID=$LOCAL_SHEET_ID"
fi
if [ "$CURRENT_SHEET" = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo" ]; then
  die ".env points at the PRODUCTION sheet. Refusing."
fi
say "local sheet: $CURRENT_SHEET"

# --- 1. code ----------------------------------------------------------------
say "fetching origin…"
git fetch origin --prune
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  git pull --ff-only origin main
  say "main is now $(git rev-parse --short HEAD)"
else
  say "on branch '$BRANCH' — not pulling. origin/main is $(git rev-parse --short origin/main); rebase when ready."
fi

say "installing dependencies…"
npm install --silent --no-audit --no-fund
say "building client…"
npm run build:client --silent

if [ "$CODE_ONLY" = "1" ]; then
  say "--code-only: database left alone. Done."
  exit 0
fi

# --- 2. data ----------------------------------------------------------------
say "locating the newest production snapshot…"
LATEST="$(ssh -i "$VPS_KEY" "$VPS_HOST" "ls -1t $PROD_BACKUPS/app.db.*.gz 2>/dev/null | head -1")"
[ -n "$LATEST" ] || die "no nightly snapshot found in $PROD_BACKUPS on $VPS_HOST"
say "snapshot: $LATEST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "downloading (~60 MB)…"
scp -q -i "$VPS_KEY" "$VPS_HOST:$LATEST" "$TMP/prod-snapshot.gz"

say "rebuilding app.db (trim + sanitize)…"
node scripts/refresh-env.js --from "$TMP/prod-snapshot.gz" --to "$APP_DIR/app.db" --yes-non-prod "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

say ""
say "Done. Start the stack in two terminals:"
say "  SPREADSHEET_ID=$CURRENT_SHEET npm run dev"
say "  npm run dev:client"
