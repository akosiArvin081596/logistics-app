#!/usr/bin/env bash
# scripts/secure-backups.sh — close local read access to the backup directory,
# get the .env snapshots out of it, and account for the stray database copies
# sitting loose in the application directory.
#
#   ./scripts/secure-backups.sh                       # DRY RUN (default) — changes nothing
#   ./scripts/secure-backups.sh --apply               # modes + move the .env snapshots
#   ./scripts/secure-backups.sh --apply --adopt-strays  # ALSO move app.db.bak* into backups/
#
# Run it on the VPS as root. It can also be run without landing a file:
#   ssh <vps> 'bash -s -- --dry-run' < scripts/secure-backups.sh
#
# -----------------------------------------------------------------------------
# WHAT THIS IS FOR
#
#   Every file in backups/ is a complete copy of every SSN, EIN, bank routing
#   and account number in the business. They are mode 644 in a mode 755
#   directory, on a box with four non-root login accounts (ubuntu, nodeapp,
#   deploy, postgres). Any of them can read the lot — no exploit, just `cp`.
#
#   Encrypting them was assessed in PR #231 and is the right long-term answer,
#   but it costs key management and a restore drill, and it is worthless against
#   the reader who is already on the box. `chmod` is worth more, today, for
#   nothing: it is the difference between "four accounts can read every SSN" and
#   "root can", and root can read app.db anyway.
#
#   THREE SEPARATE PROBLEMS, deliberately kept separate:
#
#   1. modes — backups/ 755 and its contents 644.
#   2. .env snapshots inside backups/ — they are already 600, so this is not
#      about read access. It is about LOCATION: backups/ is the one directory
#      whose entire purpose is to be copied off the box. The current
#      refresh-local.sh globs app.db.*.gz so it misses them, but a `scp -r
#      backups/` or a tarball takes SESSION_SECRET, GMAIL_APP_PASSWORD,
#      GEMINI_API_KEY and LINXUP_WEBHOOK_TOKEN with it. A secret that survives a
#      wide copy because of a narrow glob is surviving by luck.
#   3. strays — app.db.bak* in the application directory itself, from April and
#      May, managed by nothing. scripts/backup-db.js manages ONE directory by
#      design, so these are outside its remit until they are moved into it.
#
# -----------------------------------------------------------------------------
# ⚠️ --adopt-strays IS A DELETION DECISION IN DISGUISE.
#
#   Moving app.db.bak* into backups/ hands them to the retention pruner. Their
#   names start with "app.db." so the prefix rule adopts them immediately, and
#   their April/May dates are far past any sane --keep-days, so the very next
#   nightly run deletes them. That is almost certainly what you want for a
#   four-month-old copy nothing references — but decide it, do not discover it.
#   To keep one, pin it in backups/.retention-keep BEFORE adopting.
# -----------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/logistics-app}"
ENV_SNAP_DIR="${ENV_SNAP_DIR:-/root/logisx-env-snapshots}"
DIR_MODE=700
FILE_MODE=600

APPLY=0
ADOPT=0
for a in "$@"; do
  case "$a" in
    --apply)         APPLY=1 ;;
    --dry-run)       APPLY=0 ;;
    --adopt-strays)  ADOPT=1 ;;
    --app-dir=*)     APP_DIR="${a#*=}" ;;
    --env-snapshots-dir=*) ENV_SNAP_DIR="${a#*=}" ;;
    -h|--help) sed -n '2,50p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

BACKUP_DIR="$APP_DIR/backups"
say()  { echo "[secure-backups] $*"; }
act()  { if [ "$APPLY" = "1" ]; then echo "  DO          $*"; else echo "  WOULD       $*"; fi; }
skip() { echo "  ok          $*"; }
note() { echo "              $*"; }

# The VPS is GNU; a developer testing --apply against a scratch tree first is on
# BSD stat. Shipping an --apply path nobody could rehearse is how it gets run
# for the first time on the only copy that matters.
if stat -c %a . >/dev/null 2>&1; then
  st_mode() { stat -c %a "$1"; }; st_size() { stat -c %s "$1"; }; st_day() { stat -c %y "$1" | cut -d' ' -f1; }
else
  st_mode() { stat -f %Lp "$1"; }; st_size() { stat -f %z "$1"; }; st_day() { stat -f %Sm -t %Y-%m-%d "$1"; }
fi

[ -d "$APP_DIR" ]    || { echo "[secure-backups] FAILED: no such directory: $APP_DIR" >&2; exit 1; }
[ -d "$BACKUP_DIR" ] || { echo "[secure-backups] FAILED: no such directory: $BACKUP_DIR" >&2; exit 1; }

# Writability, not uid 0. Same requirement stated in terms of what is actually
# needed, and it lets --apply be rehearsed against a scratch tree by a normal
# user before it is ever pointed at the real one.
if [ "$APPLY" = "1" ] && [ ! -w "$BACKUP_DIR" ]; then
  echo "[secure-backups] FAILED: --apply cannot write $BACKUP_DIR (root-owned — run as root)." >&2
  exit 1
fi

say "app dir:       $APP_DIR"
say "backups:       $BACKUP_DIR"
say "env snapshots: $ENV_SNAP_DIR"
say "mode:          $([ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN — nothing will be changed')"
echo

changed=0
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

# =============================================================================
say "1. directory mode"
cur="$(st_mode "$BACKUP_DIR")"
if [ "$cur" != "$DIR_MODE" ]; then
  act "chmod $DIR_MODE $BACKUP_DIR    (currently $cur — group/other can list every snapshot)"
  [ "$APPLY" = "1" ] && chmod "$DIR_MODE" "$BACKUP_DIR"
  changed=$((changed + 1))
else
  skip "$BACKUP_DIR is already $DIR_MODE"
fi
echo

# =============================================================================
say "2. file modes inside backups/"
# Every file, not just app.db.* — the .json exports are business data and the
# log records paths. A blanket rule needs no maintenance when a new kind of
# file appears, which is exactly how the .env snapshots got in here unnoticed.
n=0; bytes=0
while IFS= read -r -d '' f; do
  m="$(st_mode "$f")"
  [ "$m" = "$FILE_MODE" ] && continue
  sz="$(st_size "$f")"
  n=$((n + 1)); bytes=$((bytes + sz))
  act "chmod $FILE_MODE $(basename "$f")   ($m, $(human "$sz"))"
  [ "$APPLY" = "1" ] && chmod "$FILE_MODE" "$f"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -print0)
if [ "$n" = "0" ]; then
  skip "every file in backups/ is already $FILE_MODE"
else
  note "$n file(s), $(human "$bytes") of world-readable data"
  changed=$((changed + n))
fi
echo

# =============================================================================
say "3. .env snapshots out of the backup directory"
n=0
while IFS= read -r -d '' f; do
  n=$((n + 1))
  if [ "$n" = "1" ]; then
    if [ ! -d "$ENV_SNAP_DIR" ]; then
      act "mkdir -m $DIR_MODE $ENV_SNAP_DIR"
      [ "$APPLY" = "1" ] && mkdir -m "$DIR_MODE" -p "$ENV_SNAP_DIR"
    fi
  fi
  b="$(basename "$f")"
  if [ -e "$ENV_SNAP_DIR/$b" ]; then
    note "SKIP $b — already present in $ENV_SNAP_DIR (not overwriting)"
    continue
  fi
  act "mv $b -> $ENV_SNAP_DIR/   (holds SESSION_SECRET / GMAIL_APP_PASSWORD / API keys)"
  if [ "$APPLY" = "1" ]; then
    mv "$f" "$ENV_SNAP_DIR/$b"
    chmod "$FILE_MODE" "$ENV_SNAP_DIR/$b"
  fi
  changed=$((changed + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '.env*' -print0)
[ "$n" = "0" ] && skip "no .env* snapshots in backups/"
echo

# =============================================================================
say "4. stray database copies in the application directory"
# The live database and its sidecars are never candidates.
stray_n=0; stray_bytes=0
while IFS= read -r -d '' f; do
  b="$(basename "$f")"
  case "$b" in
    app.db|app.db-wal|app.db-shm) continue ;;
  esac
  sz="$(st_size "$f")"; m="$(st_mode "$f")"
  stray_n=$((stray_n + 1)); stray_bytes=$((stray_bytes + sz))
  if [ "$ADOPT" = "1" ]; then
    if [ -e "$BACKUP_DIR/$b" ]; then
      note "SKIP $b — a file of that name already exists in backups/"
      continue
    fi
    act "mv $b -> backups/   ($m, $(human "$sz")) — becomes prunable, see the warning in this file's header"
    if [ "$APPLY" = "1" ]; then
      mv "$f" "$BACKUP_DIR/$b"
      chmod "$FILE_MODE" "$BACKUP_DIR/$b"
    fi
    changed=$((changed + 1))
  else
    echo "  REPORT      $b   ($m, $(human "$sz"), mtime $(st_day "$f"))"
  fi
done < <(find "$APP_DIR" -maxdepth 1 -type f \( -name 'app.db.bak*' -o -name 'app.db.*-wal' -o -name 'app.db.*-shm' \) -print0)

if [ "$stray_n" = "0" ]; then
  skip "no stray app.db.bak* in $APP_DIR"
elif [ "$ADOPT" != "1" ]; then
  note ""
  note "$stray_n file(s), $(human "$stray_bytes"). Nothing manages these: backup-db.js"
  note "owns backups/ only, so they have no expiry and no owner. Each is a full"
  note "copy of the database as it stood in April/May."
  note "Re-run with --adopt-strays to move them under retention — READ the warning"
  note "at the top of this script first, it is effectively a delete."
fi
echo

# =============================================================================
say "-------------------------------------------------------------------"
if [ "$APPLY" = "1" ]; then
  say "applied $changed change(s)."
else
  say "$changed change(s) planned. Nothing was modified."
  say "Re-run with --apply to make them."
fi
say ""
say "NOT addressed here, on purpose:"
say "  * the backups are still unencrypted — see the encryption-at-rest section"
say "    of PR #231. This closes local read access, which is cheaper and has no"
say "    catastrophic failure mode; it is not a substitute."
say "  * uploads/ still holds unredacted signed W-9s and receipt scans."
say "  * app.db itself is 644. Changing that is a live-service decision, not a"
say "    backup one, so it is deliberately out of scope for this script."
