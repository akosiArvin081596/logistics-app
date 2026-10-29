#!/bin/bash
# scripts/backup-trees.sh: nightly on-box copies of the app's file trees.
#
#   bash scripts/backup-trees.sh --app-dir=<dir>
#
# backup.sh runs it after the database snapshot, so root's crontab keeps its one
# line. --app-dir is required; there is no default (exit 2 without it).
#
# OFF UNLESS <app-dir>/backups/.trees-enabled EXISTS. Without that file the script
# prints nothing, changes nothing and exits 0, so backup.log reads as it did
# before this script existed.
#   Switch on (as root, owner-only):  printf 'keep=30\n' > backups/.trees-enabled
#                                     chmod 600 backups/.trees-enabled
#   Switch off: remove the file. The job stops from the next night. The copies
#   already made stay; removing backups/trees/ is a separate decision.
# The switch file is also the config: one optional line keep=<N>, the nights to
# keep (1-9999, default 14). An unreadable keep line fails the night and changes
# nothing, rather than guessing which nights to delete.
#
# WHAT IT PROTECTS AGAINST: a deleted or overwritten file; a bad deploy, script
# or data fix. WHAT IT DOES NOT: losing the box or its disk, or someone with root
# on the box. The copies sit on the same disk as the originals.
#
# WHAT IS COPIED: uploads/, storage/ (voice notes included) and evidence-archive/.
# Left out: storage/receipt-images/ and storage/receipt-pdfs/, regenerable caches.
#
# EACH NIGHT, per tree:
#   rsync -a --delete --link-dest=backups/trees/<previous night>/<tree> \
#         <tree>/ backups/trees/.in-progress/<tree>/
# then .in-progress is renamed to backups/trees/<YYYYMMDD> (UTC). A file unchanged
# since the previous night is a hard link to it, so a night costs only what
# changed, and every night still restores as plain files. A night folder exists
# only once all three trees copied; a run that stops part-way leaves .in-progress,
# which the next run reuses. If tonight's folder already exists (a second run the
# same day) it is left exactly as it is: a later run must never overwrite a good
# copy with a tree that has since been damaged.
# backups/trees/, .in-progress and each night's folder are 0700; -a keeps the
# owners and modes of everything inside, which a restore needs.
#
# FREE-SPACE FLOOR. The box is shared, so this job must never fill the disk.
# Before copying, the night is skipped (FAILED, exit 1, nothing changed) when free
# space is under max(5 GiB, 10% of the disk), or when a full copy of the three
# trees would take it under that floor. A full copy is an upper bound: with hard
# links a night usually costs far less.
#
# PRUNING runs only after a night copied in full. It keeps the newest N night
# folders, never fewer than the newest 3 whatever N says, and never tonight's
# (should the clock run behind the newest names). It considers only
# real folders (not links) named YYYYMMDD under backups/trees/; anything else
# there is left alone and listed in the log. A failed night prunes nothing.
#
# REFUSALS (FAILED, exit 1, nothing changed): backups/ or backups/trees/ (or
# .in-progress) is a symbolic link, a tree is missing, or df/du/rsync cannot be
# read. Copying or deleting through a link would act on a folder this script
# does not own.
#
# A DELETED FILE IS NOT GONE AT ONCE. A file removed from a tree (a voice note
# past its retention, a deleted upload or document) stays in every night that
# already holds it, so on this box it lasts up to the keep window (N nights)
# after it was deleted. Removing it sooner means removing it from those nights
# too, which is a deletion on the box and needs the owner's go-ahead.
#
# RESTORE. Every restore is a production write: it needs approval and a window.
#   One file:   cp -a backups/trees/<date>/<tree>/<path> <tree>/<path>
#               Copy it; never move it, and never edit a file inside a night.
#               Nights share inodes, so an edit inside one changes every night
#               that holds that file.
#   A tree:     1. rsync -a backups/trees/<date>/<tree>/ <scratch>/<tree>/
#               2. compare file counts and sizes with the night;
#               3. swap it in during a window, after a pre-restore copy of the
#                  live tree.
#
# LOGGING: "[backup-trees] ..." lines on stdout, which backup.sh's cron line
# appends to backups/backup.log. Failures read "night FAILED" or "prune FAILED",
# never "] FAILED": scripts/deploy/remote-backup-check.sh reads that pattern as a
# failed DATABASE backup, and a tree failure must not be reported as one. That
# check does not read these lines yet; until it does, a failure shows in
# backup.log and in backup.sh's exit status.
#
# Exit: 0 copied, off, or tonight's copy already there; 1 failed; 2 usage.
set -uo pipefail
umask 077
shopt -s nullglob dotglob

APP_DIR=""
for a in "$@"; do
  case "$a" in
    --app-dir=*) APP_DIR="${a#*=}" ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "[backup-trees] unknown argument: $a" >&2; exit 2 ;;
  esac
done
if [ -z "${APP_DIR//[[:space:]]/}" ]; then
  echo "[backup-trees] REFUSED: no application directory: pass --app-dir=<dir>. There is no default." >&2
  exit 2
fi

TREE_NAMES="uploads storage evidence-archive"
DEFAULT_KEEP=14
MIN_KEEP=3
DIR_MODE=700
FLOOR_MIN_KIB=$((5 * 1024 * 1024))
FLOOR_PCT=10
NIGHT_RE='^20[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$'

say()  { echo "[backup-trees] $*"; }
fail() { echo "[backup-trees] night FAILED: $*"; exit 1; }
human() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GiB", k / 1048576; else printf "%.1f MiB", k / 1024 }'; }

# The off switch comes first, so with no switch file nothing below runs.
[ -f "$APP_DIR/backups/.trees-enabled" ] || exit 0

APP_DIR="$(cd "$APP_DIR" 2>/dev/null && pwd -P)" || fail "cannot open the application directory"
BACKUPS="$APP_DIR/backups"
SWITCH="$BACKUPS/.trees-enabled"
TREES="$BACKUPS/trees"
WORK="$TREES/.in-progress"

if [ -L "$BACKUPS" ]; then
  fail "refused: backups/ is a symbolic link; nothing was copied or removed"
fi
if [ -L "$TREES" ]; then
  fail "refused: backups/trees/ is a symbolic link; nothing was copied or removed"
fi
if [ -L "$WORK" ]; then
  fail "refused: backups/trees/.in-progress is a symbolic link; nothing was copied or removed"
fi
if [ -e "$TREES" ] && [ ! -d "$TREES" ]; then
  fail "backups/trees exists and is not a folder; nothing was copied or removed"
fi

[ -r "$SWITCH" ] || fail "cannot read backups/.trees-enabled; nothing was copied or removed"
KEEP=$DEFAULT_KEEP
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line//[[:space:]]/}"
  [ -z "$line" ] && continue
  case "$line" in
    keep=*)
      if [[ "${line#keep=}" =~ ^[1-9][0-9]{0,3}$ ]]; then
        KEEP="${line#keep=}"
      else
        fail "the keep line in backups/.trees-enabled is not a number from 1 to 9999; nothing was copied or removed"
      fi
      ;;
    *) say "WARNING: ignored a line in backups/.trees-enabled that is not keep=<N>" ;;
  esac
done < "$SWITCH"
keep_n=$KEEP
if [ "$keep_n" -lt "$MIN_KEEP" ]; then keep_n=$MIN_KEEP; fi

NIGHT="$(date -u +%Y%m%d)"
[[ "$NIGHT" =~ $NIGHT_RE ]] || fail "could not read today's date (UTC); nothing was copied or removed"
command -v rsync >/dev/null 2>&1 || fail "rsync is not installed; nothing was copied or removed"

if [ -e "$TREES/$NIGHT" ] || [ -L "$TREES/$NIGHT" ]; then
  say "tonight's copy backups/trees/$NIGHT is already there; left as it is, nothing copied or removed"
  exit 0
fi

# Real night folders, newest first. A link or any other name is never a night.
nights_newest_first() {
  local p n
  for p in "$TREES"/*; do
    n="${p##*/}"
    if [[ "$n" =~ $NIGHT_RE ]] && [ -d "$p" ] && [ ! -L "$p" ]; then echo "$n"; fi
  done | sort -r
}

for t in $TREE_NAMES; do
  [ -d "$APP_DIR/$t" ] || fail "$t/ is missing; nothing was copied or removed (older nights keep their copies)"
done

df_line="$(df -Pk "$BACKUPS" 2>/dev/null | awk 'NR == 2')"
total_kib="$(echo "$df_line" | awk '{ print $2 }')"
avail_kib="$(echo "$df_line" | awk '{ print $4 }')"
if ! [[ "$total_kib" =~ ^[0-9]+$ && "$avail_kib" =~ ^[0-9]+$ ]] || [ "$total_kib" -eq 0 ]; then
  fail "could not read the disk's free space (df); nothing was copied or removed"
fi
floor_kib=$((total_kib * FLOOR_PCT / 100))
if [ "$floor_kib" -lt "$FLOOR_MIN_KIB" ]; then floor_kib=$FLOOR_MIN_KIB; fi
est_kib=0
for t in $TREE_NAMES; do
  k="$(du -sk "$APP_DIR/$t/" 2>/dev/null | awk 'END { print $1 }')"
  [[ "$k" =~ ^[0-9]+$ ]] || fail "could not measure $t/ (du); nothing was copied or removed"
  est_kib=$((est_kib + k))
done

say "night $NIGHT: keep $KEEP (never fewer than the newest $MIN_KEEP); copying uploads/ storage/ evidence-archive/ (storage/receipt-images/ and storage/receipt-pdfs/ left out)"
say "space: $(human "$avail_kib") free of $(human "$total_kib"); floor $(human "$floor_kib"); a full copy is $(human "$est_kib")"
if [ "$avail_kib" -lt "$floor_kib" ]; then
  fail "free space $(human "$avail_kib") is under the floor $(human "$floor_kib"); night skipped, nothing was copied or removed"
fi
if [ $((avail_kib - est_kib)) -lt "$floor_kib" ]; then
  fail "a full copy ($(human "$est_kib")) would take free space $(human "$avail_kib") under the floor $(human "$floor_kib"); night skipped, nothing was copied or removed"
fi

if [ ! -d "$TREES" ]; then
  mkdir -m "$DIR_MODE" "$TREES" || fail "cannot create backups/trees/; nothing was copied or removed"
fi
chmod "$DIR_MODE" "$TREES" || fail "cannot set backups/trees/ to $DIR_MODE; nothing was copied or removed"
if [ -e "$WORK" ]; then
  [ -d "$WORK" ] || fail "backups/trees/.in-progress is not a folder; nothing was copied or removed"
  say "reusing backups/trees/.in-progress from a run that did not finish"
else
  mkdir -m "$DIR_MODE" "$WORK" || fail "cannot create backups/trees/.in-progress; nothing was copied or removed"
fi
chmod "$DIR_MODE" "$WORK" || fail "cannot set backups/trees/.in-progress to $DIR_MODE; nothing was copied or removed"

prev="$(nights_newest_first | head -n 1)"
for t in $TREE_NAMES; do
  args=(-a --delete)
  if [ "$t" = "storage" ]; then args+=(--exclude=/receipt-images/ --exclude=/receipt-pdfs/); fi
  if [ -n "$prev" ] && [ -d "$TREES/$prev/$t" ] && [ ! -L "$TREES/$prev/$t" ]; then
    args+=("--link-dest=$TREES/$prev/$t")
  fi
  out="$(rsync "${args[@]}" "$APP_DIR/$t/" "$WORK/$t/" 2>&1)"
  rc=$?
  # 24: files vanished during the copy, normal on a live tree.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 24 ]; then
    printf '%s\n' "$out" | head -n 20 | sed 's/^/[backup-trees]   rsync: /'
    fail "rsync of $t/ exited $rc; tonight's copy was not kept (.in-progress is reused next run), nothing removed"
  fi
  if [ "$rc" -eq 24 ]; then say "$t/: copied (some files vanished during the copy)"; else say "$t/: copied"; fi
done

if [ -e "$TREES/$NIGHT" ] || [ -L "$TREES/$NIGHT" ]; then
  fail "backups/trees/$NIGHT appeared during the copy; left as it is, nothing removed"
fi
mv "$WORK" "$TREES/$NIGHT" || fail "could not rename .in-progress to $NIGHT; nothing removed"
chmod "$DIR_MODE" "$TREES/$NIGHT" || fail "cannot set backups/trees/$NIGHT to $DIR_MODE; nothing removed"
say "kept backups/trees/$NIGHT${prev:+ (unchanged files hard-linked to $prev)}"

prune_failed=0
i=0
while IFS= read -r n; do
  [ -n "$n" ] || continue
  i=$((i + 1))
  [ "$i" -le "$keep_n" ] && continue
  # A clock behind the newest names must not cost the copy just made.
  [ "$n" = "$NIGHT" ] && continue
  if rm -rf -- "${TREES:?}/$n"; then
    say "pruned $n (beyond the newest $keep_n)"
  else
    say "WARNING: could not remove backups/trees/$n"
    prune_failed=1
  fi
done < <(nights_newest_first)

others=""
for p in "$TREES"/*; do
  n="${p##*/}"
  if ! { [[ "$n" =~ $NIGHT_RE ]] && [ -d "$p" ] && [ ! -L "$p" ]; }; then others="$others $n"; fi
done
[ -n "$others" ] && say "left alone (not a night folder):$others"

held=$(nights_newest_first | wc -l | tr -d ' ')
used_kib="$(du -sk "$TREES/" 2>/dev/null | awk 'END { print $1 }')"
say "backups/trees/ holds $held night(s), $(human "${used_kib:-0}") on disk"

if [ "$prune_failed" -ne 0 ]; then
  echo "[backup-trees] prune FAILED: night $NIGHT was kept, but an old night could not be removed (above)"
  exit 1
fi
say "OK: night $NIGHT"
exit 0
