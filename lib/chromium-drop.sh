#!/bin/bash -p
# Puppeteer runs this as the browser while the app is root (lib/pdf-browser.js,
# CHROMIUM_UNPRIVILEGED_ENABLED): it hands the fresh profile folder to the
# account and becomes Chromium under it. setpriv replaces this process in
# place, so the control pipe (fds 3 and 4) and the process-group kill still
# reach Chromium; sudo would close those fds. Every check runs before anything
# changes, and a failed one exits 1 (scripts/test-chromium-drop.js).
#
# --remove-profile <folder>: the app's removal of that folder afterwards. A
# folder handed over is removed as the account, through the same setpriv line;
# one never handed over is removed only when empty; a link in its place is left.
set -u

SETPRIV=/usr/bin/setpriv
PROFILE_NAME_RE='^puppeteer_dev_chrome_profile-[A-Za-z0-9]{6}$'
ACCOUNT_RE='^[a-z_][a-z0-9_-]{0,31}$'

die() {
	printf 'chromium-drop: %s\n' "$*" >&2
	exit 1
}

# A plain absolute path whose last part has Puppeteer's profile-folder shape.
plain_profile_path() {
	case $1 in
		/*) ;;
		*) die "the profile folder is not an absolute path" ;;
	esac
	case $1 in
		*//* | */./* | */../* | */. | */..) die "the profile folder is not a plain path" ;;
	esac
	[[ ${1##*/} =~ $PROFILE_NAME_RE ]] || die "the profile folder is not a Puppeteer profile folder"
}

binary=${LOGISX_CHROMIUM_BINARY-}
account=${LOGISX_CHROMIUM_ACCOUNT-}
unset LOGISX_CHROMIUM_BINARY LOGISX_CHROMIUM_ACCOUNT
# Bash adds these on its own; Chromium gets the environment pdf-browser.js chose.
unset PWD OLDPWD

# The account: a plain account name that exists and isn't root.
[[ $account =~ $ACCOUNT_RE ]] || die "the account is missing or is not a plain account name"
uid=$(command -p id -u "$account" 2>/dev/null) || die "the account does not exist"
gid=$(command -p id -g "$account" 2>/dev/null) || die "the account's group could not be read"
[[ $uid =~ ^[0-9]+$ && $gid =~ ^[0-9]+$ ]] || die "the account's ids could not be read"
((uid != 0 && gid != 0)) || die "the account is root"

if [[ ${1-} == --remove-profile ]]; then
	(($# == 2)) || die "--remove-profile takes one folder"
	profile=$2
	plain_profile_path "$profile"
	[[ ! -L ${profile%/*} ]] || die "the profile folder's parent is a link"
	[[ -e $profile || -L $profile ]] || exit 0
	[[ ! -L $profile ]] || die "the profile folder is a link; it is left in place"
	if [[ -n $(command -p find "$profile" -maxdepth 0 -user "$uid" -print 2>/dev/null) ]]; then
		exec "$SETPRIV" --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all -- /bin/rm -rf -- "$profile"
	fi
	[[ -d $profile && -O $profile ]] || die "the profile folder belongs to another account; it is left in place"
	command -p rmdir -- "$profile" 2>/dev/null || die "the profile folder was never handed over and is not empty; it is left in place"
	exit 0
fi

# The browser: an absolute path to an executable file, already resolved.
[[ $binary == /* ]] || die "the browser path is missing or not absolute"
[[ -f $binary && -x $binary && ! -L $binary ]] || die "the browser path is not an executable file"

# The profile folder: exactly one --user-data-dir, the same folder as HOME, a
# plain absolute path to an empty folder of Puppeteer's profile shape, owned by
# this user, and neither it nor its parent a link.
profile=""
count=0
for arg in "$@"; do
	case $arg in
		--user-data-dir=*)
			profile=${arg#--user-data-dir=}
			count=$((count + 1))
			;;
	esac
done
((count == 1)) || die "expected exactly one --user-data-dir"
plain_profile_path "$profile"
[[ ${HOME-} == "$profile" ]] || die "HOME is not the profile folder"
[[ -d $profile && ! -L $profile && ! -L ${profile%/*} ]] || die "the profile folder is not a real folder"
[[ -O $profile ]] || die "the profile folder is not owned by this user"
shopt -s nullglob dotglob
entries=("$profile"/*)
((${#entries[@]} == 0)) || die "the profile folder is not empty"

command -p chown "$uid:$gid" "$profile" || die "the profile folder's owner could not be set"
exec "$SETPRIV" --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all -- "$binary" "$@"
