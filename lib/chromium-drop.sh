#!/bin/bash -p
# Puppeteer runs this as the browser while the app is root (lib/pdf-browser.js,
# CHROMIUM_UNPRIVILEGED_ENABLED): it hands the fresh profile folder to the
# account and becomes Chromium under it. setpriv replaces this process in
# place, so the control pipe (fds 3 and 4) and the process-group kill still
# reach Chromium; sudo would close those fds. Every check runs before anything
# changes, and a failed one exits 1 (scripts/test-chromium-drop.js).
set -u

SETPRIV=/usr/bin/setpriv
PROFILE_NAME_RE='^puppeteer_dev_chrome_profile-[A-Za-z0-9]{6}$'
ACCOUNT_RE='^[a-z_][a-z0-9_-]{0,31}$'

die() {
	printf 'chromium-drop: %s\n' "$*" >&2
	exit 1
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
case $profile in
	/*) ;;
	*) die "the profile folder is not an absolute path" ;;
esac
case $profile in
	*//* | */./* | */../* | */. | */..) die "the profile folder is not a plain path" ;;
esac
[[ ${HOME-} == "$profile" ]] || die "HOME is not the profile folder"
[[ ${profile##*/} =~ $PROFILE_NAME_RE ]] || die "the profile folder is not a Puppeteer profile folder"
[[ -d $profile && ! -L $profile && ! -L ${profile%/*} ]] || die "the profile folder is not a real folder"
[[ -O $profile ]] || die "the profile folder is not owned by this user"
shopt -s nullglob dotglob
entries=("$profile"/*)
((${#entries[@]} == 0)) || die "the profile folder is not empty"

command -p chown "$uid:$gid" "$profile" || die "the profile folder's owner could not be set"
exec "$SETPRIV" --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all -- "$binary" "$@"
