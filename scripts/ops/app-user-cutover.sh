#!/bin/bash
# Moves one LogisX app from root to its own account, and back. Runs ON THE BOX as root, from a
# pinned copy installed from a merged commit, and only Arvin runs it.
#
#   app-user-cutover.sh <staging|production> --dry-run    every check and action; changes nothing
#   app-user-cutover.sh <staging|production> --apply      the cutover, in the order below
#   app-user-cutover.sh <staging|production> --rollback   back to root, undoing what --apply recorded
#
# Exit codes: 0 done; 1 refused, nothing changed; 2 a usage error, nothing read; 3 stopped after a
# change, to ask Arvin. What ran is in the run's progress file, and --rollback undoes exactly that.
#
# Output: counts, actions, labels and this script's own paths. Never a settings value, a key, a
# crontab line, the settings or key file's name, or another client's process name (counts and pm2
# ids instead).
#
# --apply, in order. Root's deploy lock is held from step 1 to the end, so no deploy, rollback or
# drift heal of this app can run meanwhile (CI deploys as root until VPS_USER flips).
#   1. the checks, Arvin's confirmations, then a root-only copy of today's modes, owners and git config
#   2. a copy of root's saved pm2 list
#   3. pm2 stop <app> in root's pm2
#   4. modes, while root still owns the tree: the folder 0750 (its render ACL kept), the data folders
#      g-w,o-rwx, untracked top-level files 0600 and folders go-rwx, backups/ 0700 and its files 0600
#   5. chown -hR <account>:<account> <app folder>
#   6. Chromium, copied as the account into its own Puppeteer cache
#   7. the account's deploy-lock folder: a systemd-tmpfiles entry, applied and read back
#   8. as the account, in a cleared environment: pm2 start, exactly one app that answers, pm2 save;
#      then pm2 startup for its boot unit
#   9. pm2 delete <app> and pm2 save in root's pm2
#  10. production: the backup line moves from root's crontab to the account's
#  Last, root's saved pm2 list is compared with step 2's copy.
#
# --rollback, holding the account's deploy lock (taken as the account) and root's: the tree check
# (read as the account), the account's pm2 entry and boot unit, owners and modes, the backup line
# and the tmpfiles entry, then root's pm2: start, compare with root's list from just before, save,
# and the saved-list compare.
set -uo pipefail

usage() { echo "usage: app-user-cutover.sh <staging|production> --dry-run|--apply|--rollback" >&2; }
refuse_usage() {
	echo "app-user-cutover: refused: $1 Nothing was read or changed." >&2
	usage
	exit 2
}
[ "$#" -eq 2 ] || refuse_usage "name the environment (staging or production) and one mode."
ENVN=$1
MODE=$2
case "$ENVN" in staging|production) ;; *) refuse_usage "the environment must be staging or production." ;; esac
case "$MODE" in --dry-run|--apply|--rollback) ;; *) refuse_usage "the mode must be --dry-run, --apply or --rollback." ;; esac

# The test runner's own tree and tools. Never honoured as root, so no stray setting can move a real run.
FS=""
SETTINGS_NAME=.env
if [ -n "${CUTOVER_TEST_ROOT:-}" ]; then
	if [ "$EUID" -eq 0 ] || [[ "$CUTOVER_TEST_ROOT" != /* ]] || [ -z "${CUTOVER_TEST_PATH:-}" ]; then
		echo "app-user-cutover: refused: CUTOVER_TEST_ROOT is for the test runner only. Nothing was read or changed." >&2
		exit 2
	fi
	FS=$CUTOVER_TEST_ROOT
	PATH=$CUTOVER_TEST_PATH
	SETTINGS_NAME=${CUTOVER_TEST_SETTINGS_NAME:-$SETTINGS_NAME}
elif [ "$EUID" -ne 0 ]; then
	echo "app-user-cutover: refused: run it as root. Nothing was read or changed." >&2
	exit 2
else
	PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi
export PATH LC_ALL=C
umask 077
LIVE=1
[ "$MODE" != --dry-run ] || LIVE=0

# Each environment's own names, never the other's: pm2 name, folder, definition file, account, sockets.
if [ "$ENVN" = production ]; then
	APP_BOX=/var/www/logistics-app
	NAME=logistics-app
	DEF=ecosystem.config.js
	ACCT=logisx-prd
	PORT=3000
	SOCKETS="logisx-prd-receipts.socket logisx-prd-photos.socket"
	CHECK=health
else
	APP_BOX=/var/www/logisx-staging
	NAME=logisx-staging
	DEF=ecosystem.staging.config.js
	ACCT=logisx-stg
	PORT=3003
	SOCKETS="logisx-stg-receipts.socket logisx-stg-photos.socket"
	CHECK=smoke
fi
RENDER=$ACCT-render
APP=$FS$APP_BOX
ACCT_HOME_BOX=/home/$ACCT
ACCT_HOME=$FS$ACCT_HOME_BOX
ACCT_CACHE_BOX=$ACCT_HOME_BOX/.cache/puppeteer
ACCT_CACHE=$FS$ACCT_CACHE_BOX
ROOT_HOME_BOX=/root
ROOT_HOME=$FS$ROOT_HOME_BOX
NODE22_BOX=/opt/node22/bin/node
NODE22=$FS$NODE22_BOX
SHARED_CACHE_BOX=/var/cache/logisx-puppeteer
SHARED_CACHE=$FS$SHARED_CACHE_BOX
STATE_ROOT_BOX=/root/logisx-cutover
STATE_ROOT=$FS$STATE_ROOT_BOX
STATE_BOX=$STATE_ROOT_BOX/$ENVN
STATE=$FS$STATE_BOX
TMPFILES_BOX=/etc/tmpfiles.d/logisx-deploy-$ACCT.conf
TMPFILES_FILE=$FS$TMPFILES_BOX

# The JSON, tree and date work, in our own pinned Node. Reads never follow a link or wait on a pipe.
HELPER_JS='
"use strict";
const fs = require("fs");
const path = require("path");
const C = fs.constants;
const [cmd, ...args] = process.argv.slice(1);
const say = (s) => process.stdout.write(s + "\n");
const safe = (v) => String(v === undefined || v === null ? "" : v).replace(/[^A-Za-z0-9._@:+-]/g, "?");
const MiB = 1024 * 1024;
function readSmall(file, max) {
	let fd;
	try { fd = fs.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch (e) { return null; }
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > max) return null;
		const buf = Buffer.alloc(st.size);
		let n = 0;
		while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (r <= 0) break; n += r; }
		return buf.subarray(0, n);
	} catch (e) { return null; } finally { fs.closeSync(fd); }
}
// pm2 jlist output, or a saved list: the last line that starts with "[" (pm2 may print a notice first).
function entries(file) {
	const b = readSmall(file, 256 * MiB);
	if (b === null) return null;
	const d = b.toString("utf8");
	let l;
	try { l = JSON.parse(d.slice(d.lastIndexOf("\n[") + 1)); } catch (e) { return null; }
	if (!Array.isArray(l)) return null;
	return l.map((x) => {
		const o = x && typeof x === "object" ? x : {};
		const e = o.pm2_env && typeof o.pm2_env === "object" ? o.pm2_env : o;
		return {
			id: safe(o.pm_id !== undefined ? o.pm_id : e.pm_id),
			name: safe(o.name !== undefined ? o.name : e.name),
			status: safe(e.status !== undefined ? e.status : o.status),
		};
	});
}
const rows = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
	const [id, name, status] = l.split("\t");
	return { id, name, status };
});
const idList = (l) => [...new Set(l)].join(", ");
function walk(root, fn) {
	const stack = [root];
	while (stack.length) {
		const p = stack.pop();
		let st;
		try { st = fs.lstatSync(p); } catch (e) { continue; }
		fn(p, st);
		if (!st.isDirectory()) continue;
		let names = [];
		try { names = fs.readdirSync(p); } catch (e) { continue; }
		for (const n of names) stack.push(path.join(p, n));
	}
}
const dayOf = (s) => {
	if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s || "")) return NaN;
	const t = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
	return new Date(t).toISOString().slice(0, 10) === s ? t : NaN;
};
const T = {
	// <file> <out> <name>: "id<TAB>name<TAB>status" per entry into <out>, then prints how many entries,
	// how many times the name is listed, and each of those as id:status. Exit 3 when it is no list.
	list() {
		const e = entries(args[0]);
		if (e === null) process.exit(3);
		fs.writeFileSync(args[1], e.map((r) => r.id + "\t" + r.name + "\t" + r.status + "\n").join(""));
		const m = e.filter((r) => r.name === args[2]);
		say([String(e.length), String(m.length), ...m.map((r) => r.id + ":" + r.status)].join(" "));
	},
	// <before> <after> <name>: root daemon, around our start. Only ids and names are compared: statuses,
	// pids and uptimes change on their own between two reads.
	"root-diff"() {
		const before = rows(args[0]), after = rows(args[1]), me = args[2];
		const key = (r) => r.id + "\t" + r.name;
		const afterKeys = new Set(after.map(key));
		const afterIds = new Set(after.map((r) => r.id));
		const beforeIds = new Set(before.map((r) => r.id));
		const gone = before.filter((r) => !afterIds.has(r.id)).map((r) => r.id);
		const renamed = before.filter((r) => afterIds.has(r.id) && !afterKeys.has(key(r))).map((r) => r.id);
		const added = after.filter((r) => !beforeIds.has(r.id));
		const mine = after.filter((r) => r.name === me);
		const others = added.filter((r) => r.name !== me).map((r) => r.id);
		const good = gone.length === 0 && renamed.length === 0 && others.length === 0 && mine.length === 1 && added.length === 1;
		say(good ? "ok" : "differs");
		say(me + " listed " + mine.length + " time(s)" + (mine.length ? " (" + mine.map((r) => "pm2 id " + r.id + ", " + r.status).join("; ") + ")" : ""));
		say("other entries: " + before.filter((r) => r.name !== me).length + " before the start, " + after.filter((r) => r.name !== me).length + " after");
		if (gone.length) say("gone since the start: " + gone.length + " (pm2 ids " + idList(gone) + ")");
		if (renamed.length) say("another name under the same pm2 id: " + renamed.length + " (pm2 ids " + idList(renamed) + ")");
		if (others.length) say("other entries added: " + others.length + " (pm2 ids " + idList(others) + ")");
	},
	// <before> <after> <name> <removed|added>: two saved lists, by name and status; ours by name only.
	"dump-diff"() {
		const b = entries(args[0]), a = entries(args[1]), me = args[2], want = args[3];
		if (b === null || a === null) { say("differs"); say("a saved list can not be read (" + (b === null ? "before" : "after") + ")"); return; }
		const others = (l) => l.filter((r) => r.name !== me);
		const bag = (l) => { const m = new Map(); for (const r of others(l)) { const k = r.name + "\t" + r.status; m.set(k, (m.get(k) || 0) + 1); } return m; };
		const bb = bag(b), ab = bag(a);
		let gone = 0, added = 0;
		const ids = [];
		for (const k of new Set([...bb.keys(), ...ab.keys()])) {
			const x = bb.get(k) || 0, y = ab.get(k) || 0;
			if (x === y) continue;
			gone += Math.max(0, x - y);
			added += Math.max(0, y - x);
			for (const r of [...others(b), ...others(a)]) if (r.name + "\t" + r.status === k) ids.push(r.id);
		}
		const mb = b.filter((r) => r.name === me).length, ma = a.filter((r) => r.name === me).length;
		const oursOk = want === "removed" ? ma === 0 : ma === 1;
		say(gone + added === 0 && oursOk ? "ok" : "differs");
		say(me + ": saved " + mb + " time(s) before, " + ma + " after (" + (want === "removed" ? "0" : "1") + " expected after)");
		say("other saved entries: " + others(b).length + " before, " + others(a).length + " after; " + (gone + added
			? "unmatched by name and status: " + gone + " before, " + added + " after (pm2 ids " + idList(ids) + ")" : "all match by name and status"));
	},
	// <app> <tracked.nul> <settings name> <root uid> <root gid> <out>: what the cutover changes, as lists in
	// <out>, and the modes and owners --rollback puts back.
	plan() {
		const [app, trackedFile, settings, ruid, rgid, out] = args;
		const tracked = new Set(fs.readFileSync(trackedFile, "utf8").split("\0").filter(Boolean).map((p) => p.split("/")[0]));
		const DATA = ["uploads", "storage", "evidence-archive", ".cache"];
		const n = { files: 0, db: 0, dbcopy: 0, settings: 0, settingscopy: 0, otherfile: 0, dirs: 0, links: 0, odd: 0, datalinks: 0,
			bfiles: 0, bsettings: 0, bodd: 0, treesfiles: 0, treesbad: 0, entries: 0, notroot: 0, dataentries: 0, direntries: 0 };
		const files = [], dirs = [], data = [], bfiles = [];
		let backups = "absent", trees = "absent", gitdir = "absent";
		const isCopy = (name) => name.length > settings.length && name.startsWith(settings);
		for (const name of fs.readdirSync(app).sort()) {
			const p = path.join(app, name);
			const st = fs.lstatSync(p);
			if (DATA.includes(name)) { if (st.isDirectory()) data.push(p); else n.datalinks++; continue; }
			if (name === "backups") { backups = st.isDirectory() ? "dir" : "bad"; continue; }
			if (name === ".git") { gitdir = st.isDirectory() ? "dir" : "bad"; continue; }
			if (name === "node_modules" || tracked.has(name)) continue;
			if (st.isSymbolicLink()) { n.links++; continue; }
			if (st.isFile()) {
				files.push(p);
				n.files++;
				if (name === "app.db" || name === "app.db-wal" || name === "app.db-shm") n.db++;
				else if (name.startsWith("app.db")) n.dbcopy++;
				else if (name === settings) n.settings++;
				else if (isCopy(name)) n.settingscopy++;
				else n.otherfile++;
				continue;
			}
			if (st.isDirectory()) {
				dirs.push(p);
				n.dirs++;
				if (isCopy(name)) n.settingscopy++;
				else if (name.startsWith("app.db")) n.dbcopy++;
				continue;
			}
			n.odd++;
		}
		const bdir = path.join(app, "backups");
		if (backups === "dir") {
			for (const name of fs.readdirSync(bdir).sort()) {
				const p = path.join(bdir, name);
				const st = fs.lstatSync(p);
				if (st.isFile()) { bfiles.push(p); n.bfiles++; if (name === settings || isCopy(name)) n.bsettings++; continue; }
				if (name === "trees") {
					trees = st.isDirectory() ? "dir" : "bad";
					if (!st.isDirectory()) continue;
					if ((st.mode & 0o777) !== 0o700) n.treesbad++;
					for (const night of fs.readdirSync(p)) {
						const s2 = fs.lstatSync(path.join(p, night));
						if (!s2.isDirectory() || (s2.mode & 0o777) !== 0o700) n.treesbad++;
					}
					walk(p, (q, s) => { if (s.isFile()) n.treesfiles++; });
					continue;
				}
				if (!st.isDirectory()) n.bodd++;
			}
		}
		// What --rollback puts back is kept relative to the app folder.
		const rel = (p) => path.relative(app, p) || ".";
		const owners = [];
		walk(app, (p, st) => {
			n.entries++;
			if (String(st.uid) !== ruid || String(st.gid) !== rgid) { n.notroot++; owners.push(st.uid + ":" + st.gid, rel(p)); }
		});
		const modes = new Map();
		const rec = (p, st) => {
			if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return;
			const m = (st.mode & 0o7777).toString(8).padStart(4, "0");
			if (!modes.has(m)) modes.set(m, []);
			modes.get(m).push(rel(p));
		};
		rec(app, fs.lstatSync(app));
		for (const d of data) walk(d, (p, st) => { n.dataentries++; rec(p, st); });
		for (const d of dirs) walk(d, (p, st) => { n.direntries++; rec(p, st); });
		for (const f of files) rec(f, fs.lstatSync(f));
		if (backups === "dir") { rec(bdir, fs.lstatSync(bdir)); for (const f of bfiles) rec(f, fs.lstatSync(f)); }
		const nul = (l) => l.map((s) => s + "\0").join("");
		fs.mkdirSync(path.join(out, "modes"), { recursive: true });
		fs.writeFileSync(path.join(out, "files.nul"), nul(files));
		fs.writeFileSync(path.join(out, "dirs.nul"), nul(dirs));
		fs.writeFileSync(path.join(out, "data.nul"), nul(data));
		fs.writeFileSync(path.join(out, "bfiles.nul"), nul(bfiles));
		fs.writeFileSync(path.join(out, "owners.nul"), nul(owners));
		for (const [m, l] of modes) fs.writeFileSync(path.join(out, "modes", m + ".nul"), nul(l));
		for (const [k, v] of Object.entries(n)) say(k + "=" + v);
		say("data=" + data.map((p) => path.basename(p)).join(","));
		say("backups=" + backups);
		say("trees=" + trees);
		say("gitdir=" + gitdir);
	},
	// <app> <modes folder>: each saved mode back on its path, never through a link and only on a file or folder.
	"restore-modes"() {
		const [app, dir] = args;
		let done = 0, links = 0, missing = 0, other = 0;
		for (const f of fs.readdirSync(dir).sort()) {
			const m = /^([0-7]{4})\.nul$/.exec(f);
			if (!m) continue;
			for (const r of fs.readFileSync(path.join(dir, f), "utf8").split("\0").filter(Boolean)) {
				if (path.isAbsolute(r) || r.split("/").includes("..")) { other++; continue; }
				const p = path.join(app, r);
				let st;
				try { st = fs.lstatSync(p); } catch (e) { missing++; continue; }
				if (st.isSymbolicLink()) { links++; continue; }
				if (!st.isFile() && !st.isDirectory()) { other++; continue; }
				let fd;
				try { fd = fs.openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch (e) { missing++; continue; }
				try {
					const s2 = fs.fstatSync(fd);
					if (s2.ino !== st.ino || s2.dev !== st.dev) { other++; continue; }
					fs.fchmodSync(fd, parseInt(m[1], 8));
					done++;
				} finally { fs.closeSync(fd); }
			}
		}
		say(done + " restored, " + missing + " gone since, " + links + " now links and " + other + " of another kind left alone");
	},
	// <settings file>: whether its one render-transport line says socket. Prints no value.
	transport() {
		const b = readSmall(args[0], 4 * MiB);
		if (b === null) { say("unreadable"); return; }
		let v = null;
		for (const line of b.toString("utf8").split(/\r?\n/)) {
			const m = line.match(/^\s*(?:export\s+)?RENDER_CHILD_TRANSPORT\s*=\s*(.*)$/);
			if (!m) continue;
			let s = m[1].trim();
			const q = s[0];
			if ((q === "\"" || q === "\x27" || q === "`") && s.indexOf(q, 1) > 0) s = s.slice(1, s.indexOf(q, 1));
			else s = s.replace(/\s+#.*$/, "").trim();
			v = s;
		}
		say(v === "socket" ? "socket" : "not-socket");
	},
	// <from YYYY-MM-DD> <to YYYY-MM-DD>: whole days between two calendar dates; exit 2 when one is not a date.
	days() {
		const x = dayOf(args[0]), y = dayOf(args[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) process.exit(2);
		say(String(Math.round((y - x) / 86400000)));
	},
	// <now, epoch seconds> <systemd timestamp, UTC>...: whole days since each, one a line; "x" when unreadable.
	age() {
		const now = Number(args[0]);
		for (const ts of args.slice(1)) {
			const m = String(ts).match(/([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) UTC$/);
			if (!m || !Number.isFinite(now)) { say("x"); continue; }
			const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000;
			say(String(Math.floor((now - t) / 86400)));
		}
	},
	// <saved .git copy> <live .git>: git config and hooks, byte for byte.
	"git-same"() {
		const [saved, live] = args;
		const same = (x, y) => { const p = readSmall(x, 16 * MiB), q = readSmall(y, 16 * MiB); return p !== null && q !== null && p.equals(q); };
		const diffs = [];
		if (!same(path.join(saved, "config"), path.join(live, "config"))) diffs.push("config");
		const names = (d) => {
			try { if (!fs.lstatSync(d).isDirectory()) return []; return fs.readdirSync(d).sort(); } catch (e) { return null; }
		};
		const hs = names(path.join(saved, "hooks")), hl = names(path.join(live, "hooks"));
		let hooks = 0;
		if ((hs === null) !== (hl === null)) hooks++;
		else if (hs !== null) for (const h of new Set([...hs, ...hl])) if (!same(path.join(saved, "hooks", h), path.join(live, "hooks", h))) hooks++;
		if (hooks) diffs.push(hooks + " hook file(s)");
		say(diffs.length ? "differs: " + diffs.join(" and ") : "ok");
	},
	// <pid file>: the pid it names, when it is a small regular file holding one.
	pid() {
		const b = readSmall(args[0], 64);
		const s = b === null ? "" : b.toString("utf8").trim();
		if (/^[0-9]+$/.test(s)) say(s);
	},
};
if (!T[cmd]) { process.stderr.write("app-user-cutover helper: unknown command\n"); process.exit(2); }
T[cmd]();
'

row() { printf '%-6s %s\n' "$1" "$2"; }
okay() { row ok "$*"; }
note() { row "" "$*"; }
act() { if [ "$LIVE" = 1 ]; then row "do" "$*"; else row would "$*"; fi; }
FAILS=0
# A failed check: listed by a dry run, and a refusal before any change otherwise.
need() {
	row FAIL "$*"
	FAILS=$((FAILS + 1))
	if [ "$LIVE" = 1 ]; then
		echo "app-user-cutover: refused: nothing was changed." >&2
		exit 1
	fi
}
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
progress() { printf '%s %s\n' "$1" "$(stamp)" >> "$STATE/progress"; }
ran() { [ -f "$STATE/progress" ] && awk -v k="$1" '$1 == k { f = 1 } END { exit !f }' "$STATE/progress"; }
# A stop after a change: what ran stays recorded, so --rollback undoes exactly that.
stop_ask() {
	row STOP "$1"
	[ ! -d "$STATE" ] || progress "${MODE#--}.stopped"
	if [ "$MODE" = --apply ]; then
		echo "app-user-cutover: stopped to ask Arvin. What ran is in $STATE_BOX/progress; --rollback undoes exactly that." >&2
	else
		echo "app-user-cutover: stopped to ask Arvin. What ran is in $STATE_BOX/progress; another --rollback carries on from there." >&2
	fi
	exit 3
}
ANSWER=""
ask() {
	printf '?      %s: ' "$1"
	IFS= read -r ANSWER || ANSWER=""
	[ -t 0 ] || printf '\n'
}
confirm() { ask "$1? (yes/no)"; [ "$ANSWER" = yes ]; }

# A command that may leave a process behind (pm2 starts a daemon) runs without this run's lock
# descriptors, or the locks would outlive the run.
x() { "$@" 7<&- 8>&- 9>&-; }
as_acct() { x runuser -u "$ACCT" -- "$@"; }
# pm2 gets only HOME, PATH and LANG: nothing from the caller's shell reaches an app's saved environment.
pm2_root() { x env -i HOME="$ROOT_HOME" PATH="$PATH" LANG=C.UTF-8 "$PM2_BIN" "$@"; }
pm2_acct() { x runuser -u "$ACCT" -- env -i HOME="$ACCT_HOME" PATH="$PATH" LANG=C.UTF-8 "$PM2_BIN" "$@"; }
git_acct() { as_acct env -i HOME="$ACCT_HOME" PATH="$PATH" LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -C "$APP" "$@"; }
js() { "$NODE22" -e "$HELPER_JS" -- "$@"; }

if stat -c %a / >/dev/null 2>&1; then
	mode_of() { stat -c %a -- "$1" 2>/dev/null; }
	uid_of() { stat -c %u -- "$1" 2>/dev/null; }
else
	mode_of() { stat -f %Lp -- "$1" 2>/dev/null; }
	uid_of() { stat -f %u -- "$1" 2>/dev/null; }
fi
real_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
real_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
count_lines() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
passwd_of() {
	local l u g h
	l=$(getent passwd "$1" 2>/dev/null | head -n 1)
	[ -n "$l" ] || return 1
	IFS=: read -r _ _ u g _ h _ <<<"$l"
	[[ "$u" =~ ^[0-9]+$ && "$g" =~ ^[0-9]+$ ]] || return 1
	printf '%s %s %s\n' "$u" "$g" "$h"
}

# The deploy scripts' lock layout: one folder per deploying account, and one file per app folder.
lock_name() { printf 'logisx-deploy%s.lock' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"; }
lock_dir_ok() { real_dir "$1" && [ "$(uid_of "$1")" = "$2" ] && [ "$(mode_of "$1")" = 700 ]; }
# Reads a pm2 daemon's pid file only: a missing daemon is never started to look.
daemon_up() { local pid; pid=$(js pid "$1/pm2.pid"); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
# $1 the list file: prints "<entries> <times our app is listed> <id:status ...>", and fails on no list.
root_list() { pm2_root jlist > "$TMPD/jlist.raw" 2>/dev/null; js list "$TMPD/jlist.raw" "$1" "$NAME"; }
acct_list() { pm2_acct jlist > "$TMPD/jlist.raw" 2>/dev/null; js list "$TMPD/jlist.raw" "$1" "$NAME"; }
# The account's own daemon, $1 its list file: 0 when it holds exactly one app, ours. Prints its names
# and statuses, which are ours to print: no other client runs there.
one_app() {
	awk -F'\t' -v me="$NAME" '{ n++; s = s (s == "" ? "" : "; ") $2 " " $3; if ($2 == me) m++ }
		END { printf "%d%s\n", n, (n ? " (" s ")" : ""); exit !(n == 1 && m == 1) }' "$1"
}
unit_enabled() { [ "$(x systemctl is-enabled "$1" 2>/dev/null)" = enabled ]; }
# The smoke check's API probe, $1 tries 2 s apart.
answers() {
	local i=0 code
	while [ "$i" -lt "$1" ]; do
		code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/config/maintenance" 2>/dev/null) || code=000
		[ "$code" != 200 ] || return 0
		i=$((i + 1))
		[ "$i" -ge "$1" ] || sleep 2
	done
	return 1
}
# The render account's traverse entry on the app folder, and still effective under the folder's mask.
acl_ok() {
	local l perm eff
	l=$(x getfacl -p -c -- "$APP" 2>/dev/null | awk -v u="user:$RENDER:" 'index($0, u) == 1 { print; exit }')
	[ -n "$l" ] || return 1
	perm=${l#"user:$RENDER:"}
	perm=${perm%%[[:space:]]*}
	[ "${perm:2:1}" = x ] || return 1
	case "$l" in
		*"#effective:"*) eff=${l##*#effective:}; [ "${eff:2:1}" = x ] ;;
		*) return 0 ;;
	esac
}
# The nightly backup runs at 02:00 by the box's clock; a re-own then would leave it files of the wrong owner.
in_backup_window() {
	case "$(date +%H):$(date -u +%H)" in 01:*|02:*|*:01|*:02) return 0 ;; esac
	return 1
}
read_crontab() {
	if x crontab -u "$1" -l > "$2" 2>"$TMPD/crontab.err"; then return 0; fi
	if grep -qi 'no crontab for' "$TMPD/crontab.err"; then : > "$2"; return 0; fi
	return 1
}
# Our backup line: not a comment, names the app folder as a whole path, and the backup.
cron_lines() { awk -v d="$APP_BOX" '$0 !~ /^[[:space:]]*#/ && $0 ~ (d "(/|[[:space:]]|$)") && index($0, "backup") { print NR }' "$1"; }
cron_vars() { awk '$0 ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ { n++ } END { print n + 0 }' "$1"; }

make_plan() {
	mkdir -p -- "$1" || return 1
	git -C "$APP" ls-files -z > "$1/tracked.nul" 2>/dev/null || return 1
	js plan "$APP" "$1/tracked.nul" "$SETTINGS_NAME" "$ROOT_UID" "$ROOT_GID" "$1" > "$1/counts"
}
load_plan() {
	local k v
	while IFS='=' read -r k v; do
		[[ "$k" =~ ^[a-z]+$ ]] || continue
		eval "P_$k=\$v"
	done < "$1/counts"
}
P_files=0 P_db=0 P_dbcopy=0 P_settings=0 P_settingscopy=0 P_otherfile=0 P_dirs=0 P_links=0 P_odd=0 P_datalinks=0
P_bfiles=0 P_bsettings=0 P_bodd=0 P_treesfiles=0 P_treesbad=0 P_entries=0 P_notroot=0 P_dataentries=0 P_direntries=0
P_data="" P_backups=absent P_trees=absent P_gitdir=absent CACHE_MIB=unknown
# "6:online 9:stopped" as "pm2 id 6, online; pm2 id 9, stopped".
fmt_ours() {
	local t out=""
	for t in $1; do out="${out:+$out; }pm2 id ${t%%:*}, ${t#*:}"; done
	printf '%s' "$out"
}

# ── Identity, read-only, every mode ─────────────────────────────────────────────────────────────
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/logisx-cutover.XXXXXX") || {
	echo "app-user-cutover: refused: no temporary folder. Nothing was changed." >&2
	exit 1
}
trap 'rm -rf -- "$TMPD"' EXIT
case "$MODE" in --dry-run) WHAT="a dry run: nothing is changed" ;; --apply) WHAT="apply" ;; *) WHAT="rollback" ;; esac
row "" "app-user-cutover $ENVN, $WHAT. App folder $APP_BOX, account $ACCT, pm2 name $NAME."
if ! [ -x "$NODE22" ]; then
	echo "app-user-cutover: refused: $NODE22_BOX is missing, and the checks run in it. Nothing was changed." >&2
	exit 1
fi
NOW=$(date -u +%s)
TODAY=$(date -u +%Y-%m-%d)
ROOT_UID=""
ROOT_GID=""
ACCT_UID=""
ACCT_GID=""
ACCT_HOME_GOT=""
read -r ROOT_UID ROOT_GID _ <<<"$(passwd_of root)"
read -r ACCT_UID ACCT_GID ACCT_HOME_GOT <<<"$(passwd_of "$ACCT")"
if [ -z "$ROOT_UID" ]; then
	echo "app-user-cutover: refused: root's account can't be read. Nothing was changed." >&2
	exit 1
fi
if [ -n "$ACCT_UID" ]; then
	okay "$ACCT is uid $ACCT_UID"
	[ "$ACCT_UID" != 0 ] || need "$ACCT must not be uid 0"
	[ "$ACCT_HOME_GOT" = "$ACCT_HOME_BOX" ] || need "$ACCT's home must be $ACCT_HOME_BOX, the path the Chromium profile covers (it is ${ACCT_HOME_GOT:-unset})"
	g=$(getent group "$ACCT" 2>/dev/null | head -n 1 | cut -d: -f3)
	[ "$g" = "$ACCT_GID" ] || need "$ACCT's own group must be its primary group"
	real_dir "$ACCT_HOME" && [ "$(uid_of "$ACCT_HOME")" = "$ACCT_UID" ] || need "$ACCT_HOME_BOX must be a folder $ACCT owns"
else
	need "the account $ACCT doesn't exist (4A's sitting creates it)"
	ACCT_UID=none
fi
passwd_of "$RENDER" >/dev/null || need "the render account $RENDER doesn't exist"
PM2_BIN=$(command -v pm2 2>/dev/null) || PM2_BIN=""
[ -n "$PM2_BIN" ] || { [ ! -x "$FS/opt/node22/bin/pm2" ] || PM2_BIN=$FS/opt/node22/bin/pm2; }
[ -n "$PM2_BIN" ] || { echo "app-user-cutover: refused: no pm2 binary. Nothing was changed." >&2; exit 1; }
PM2_NODE=$(command -v node 2>/dev/null) || PM2_NODE=""
ROOT_LOCK_DIR_BOX=/run/logisx-deploy-$ROOT_UID
ROOT_LOCK_DIR=$FS$ROOT_LOCK_DIR_BOX
ROOT_LOCK_FILE=$ROOT_LOCK_DIR/$(lock_name "$APP_BOX")
ACCT_LOCK_DIR_BOX=/run/logisx-deploy-$ACCT_UID
ACCT_LOCK_DIR=$FS$ACCT_LOCK_DIR_BOX
ACCT_LOCK_FILE=$ACCT_LOCK_DIR/$(lock_name "$APP_BOX")
ACCT_LOCK_FILE_BOX=$ACCT_LOCK_DIR_BOX/$(lock_name "$APP_BOX")
ROOT_LOCK_FILE_BOX=$ROOT_LOCK_DIR_BOX/$(lock_name "$APP_BOX")

# ── Locks ─────────────────────────────────────────────────────────────────────────────────────────
# Root's lock: the one every deploy, rollback, record step and drift check of this app takes while CI
# deploys as root. Held on fd 9 until this run ends.
take_root_lock() {
	if [ ! -e "$ROOT_LOCK_DIR" ] && [ ! -L "$ROOT_LOCK_DIR" ]; then mkdir -m 0700 -- "$ROOT_LOCK_DIR" 2>/dev/null; fi
	lock_dir_ok "$ROOT_LOCK_DIR" "$ROOT_UID" || need "root's deploy lock folder $ROOT_LOCK_DIR_BOX must be a folder root owns, mode exactly 0700"
	exec 9<>"$ROOT_LOCK_FILE" || need "root's deploy lock $ROOT_LOCK_FILE_BOX can't be opened"
	flock -n 9 || need "root's deploy lock for $APP_BOX is held: a deploy, rollback or drift check of this app is running. Wait for it, then run this again"
	printf 'pid=%s since=%s by=app-user-cutover.sh ref= sha=\n' "$$" "$(stamp)" > "$ROOT_LOCK_FILE" 2>/dev/null || true
	okay "holding root's deploy lock $ROOT_LOCK_FILE_BOX until this run ends: a deploy, rollback or drift heal of $APP_BOX meanwhile fails fast"
}
# The account's lock, taken only as the account, never by opening its file as root. A process of the
# account holds it while its input stays open: fd 8 here, closed when this run ends.
take_acct_lock() {
	if [ ! -e "$ACCT_LOCK_DIR" ] && [ ! -L "$ACCT_LOCK_DIR" ]; then
		okay "$ACCT has no deploy lock folder, so no deploy can run as $ACCT"
		return 0
	fi
	if ! lock_dir_ok "$ACCT_LOCK_DIR" "$ACCT_UID"; then
		okay "$ACCT_LOCK_DIR_BOX isn't a 0700 folder $ACCT owns, so a deploy as $ACCT refuses there"
		return 0
	fi
	local state=$TMPD/acct-lock i=0 s
	: > "$state"
	exec 8> >(runuser -u "$ACCT" -- flock -n "$ACCT_LOCK_FILE" sh -c 'printf "pid=%s since=%s by=app-user-cutover.sh ref= sha=\n" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$1" 2>/dev/null; echo held >&3; exec cat >/dev/null' sh "$ACCT_LOCK_FILE" 3>"$state" 7<&- 9>&- || echo busy >"$state")
	while [ "$i" -lt 150 ]; do
		s=$(cat "$state" 2>/dev/null)
		case "$s" in
			held*) okay "holding $ACCT's deploy lock $ACCT_LOCK_FILE_BOX, taken as $ACCT, until this run ends"; return 0 ;;
			busy*) need "$ACCT's deploy lock for $APP_BOX is held: a deploy or drift check as $ACCT is running. Wait for it, then run this again" ;;
		esac
		i=$((i + 1))
		sleep 0.1
	done
	need "$ACCT's deploy lock couldn't be taken (no answer)"
}

# ── --apply's checks (also the dry run's) ─────────────────────────────────────────────────────────
SOCKETS_YOUNG=""
apply_checks() {
	local n ours total sum u st ts age lines k sizekb availkb needkb floorkb chrome c
	if real_dir "$APP" && [ "$(uid_of "$APP")" = "$ROOT_UID" ]; then okay "$APP_BOX is a folder root owns"; else need "$APP_BOX must be a folder root owns"; fi
	real_dir "$APP/.git" || need "$APP_BOX/.git must be a folder: the tree is a checkout"
	if real_file "$APP/$DEF"; then okay "the definition file: $APP_BOX/$DEF"; else need "the definition file $APP_BOX/$DEF is missing"; fi

	if ! daemon_up "$ROOT_HOME/.pm2"; then
		need "root's pm2 daemon isn't running from $ROOT_HOME_BOX/.pm2 (this script never starts one to look)"
	elif ! sum=$(root_list "$TMPD/root.now"); then
		need "root's pm2 list can't be read"
	else
		read -r total n ours <<<"$sum"
		if [ "$n" = 1 ] && [ "${ours#*:}" = online ]; then
			okay "root's pm2 lists $NAME once (pm2 id ${ours%%:*}, online), beside $((total - 1)) other entries"
		else
			need "root's pm2 must list $NAME once, online (it lists it $n time(s)${ours:+: $ours})"
		fi
	fi
	if answers 3; then okay "$NAME answers on :$PORT"; else need "$NAME doesn't answer on :$PORT"; fi

	if [ "$ACCT_UID" != none ]; then
		if [ -e "$ACCT_HOME/.pm2/dump.pm2" ] || [ -L "$ACCT_HOME/.pm2/dump.pm2" ]; then
			if sum=$(js list "$ACCT_HOME/.pm2/dump.pm2" "$TMPD/acct.dump" "$NAME") && [ "${sum%% *}" = 0 ]; then
				okay "$ACCT's saved pm2 list is empty"
			else
				need "$ACCT's saved pm2 list isn't empty, or can't be read: an earlier run? Nothing may run as $ACCT yet"
			fi
		fi
		! unit_enabled "pm2-$ACCT" || need "pm2-$ACCT is enabled already: an earlier run? Nothing may start as $ACCT yet"
		if daemon_up "$ACCT_HOME/.pm2"; then
			if sum=$(acct_list "$TMPD/acct.now") && [ "${sum%% *}" = 0 ]; then
				okay "$ACCT's pm2 daemon runs and lists nothing"
			else
				need "$ACCT's pm2 daemon already lists processes (or can't be read): nothing may run as $ACCT yet"
			fi
		else
			okay "$ACCT's pm2 daemon isn't running yet (the start below starts it)"
		fi
		if as_acct test -x "$NODE22"; then okay "$ACCT can execute $NODE22_BOX"; else need "$ACCT can't execute $NODE22_BOX"; fi
		if as_acct test -x "$PM2_BIN"; then okay "$ACCT can execute pm2 ($PM2_BIN)"; else need "$ACCT can't execute pm2 ($PM2_BIN)"; fi
		if [ -n "$PM2_NODE" ] && as_acct test -x "$PM2_NODE"; then okay "$ACCT can execute the node that runs pm2 ($PM2_NODE)"
		else need "$ACCT can't execute the node that runs pm2 (${PM2_NODE:-none on PATH})"; fi
	fi
	if acl_ok; then okay "$RENDER can traverse $APP_BOX through its ACL"; else need "$RENDER's traverse ACL isn't on $APP_BOX (4A's sitting adds it): no mode changes without it"; fi

	# Each socket: active, and since when (in UTC); then every age in one go.
	local units="" stamps=() ages i=0
	for u in $SOCKETS; do
		st=$(x env TZ=UTC systemctl show -p ActiveState --value "$u" 2>/dev/null)
		if [ "$st" != active ]; then need "the socket $u isn't active (${st:-unknown})"; continue; fi
		units="$units $u"
		stamps[${#stamps[@]}]=$(x env TZ=UTC systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)
	done
	if [ -n "$units" ]; then
		ages=$(js age "$NOW" "${stamps[@]}")
		for u in $units; do
			ts=${stamps[$i]}
			age=$(printf '%s\n' "$ages" | sed -n "$((i + 1))p")
			i=$((i + 1))
			if ! [[ "$age" =~ ^[0-9]+$ ]]; then
				need "the socket $u's active-since time can't be read"
			elif [ "$age" -ge 7 ]; then
				okay "$u: active since $ts, $age days"
			else
				SOCKETS_YOUNG="$SOCKETS_YOUNG $u"
				row ask "$u: active since $ts, $age day(s), under 7. A reboot or a socket restart resets it, so --apply asks for the go-live date in the rule-F report"
			fi
		done
	fi
	case "$(js transport "$APP/$SETTINGS_NAME")" in
		socket) okay "the render transport setting is socket" ;;
		unreadable) need "the settings file can't be read for the render transport setting" ;;
		*) need "the render transport setting isn't socket (fork is the default): the sockets carry the renders for 7 days first" ;;
	esac

	if make_plan "$TMPD/plan"; then
		load_plan "$TMPD/plan"
		okay "today's tree: $P_entries entries, $P_notroot of them not root:root (--rollback puts those owners back)"
		[ "$P_datalinks" = 0 ] || need "$P_datalinks of uploads/, storage/, evidence-archive/ and .cache/ aren't folders (a link?)"
		[ "$P_backups" != bad ] || need "backups/ isn't a folder"
		[ "$P_gitdir" = dir ] || need ".git isn't a folder"
		[ "$P_odd" = 0 ] || need "$P_odd top-level entries are neither files, folders nor links"
		[ "$P_links" = 0 ] || note "$P_links untracked top-level links are left as they are"
		if [ "$ENVN" = production ]; then
			if [ "$((P_settingscopy + P_bsettings))" = 0 ]; then okay "no old copy of the settings file remains"
			else need "old copies of the settings file remain ($P_settingscopy at the top level, $P_bsettings in backups/): they go before production's cutover"; fi
		elif [ "$((P_settingscopy + P_bsettings))" != 0 ]; then
			note "$((P_settingscopy + P_bsettings)) old copies of the settings file: made 0600 and re-owned with the rest"
		fi
		if [ "$P_trees" = dir ]; then
			if [ "$P_treesbad" = 0 ]; then okay "backups/trees: its folders are 0700 ($P_treesfiles files)"; else need "backups/trees: $P_treesbad of its folders aren't 0700"; fi
		fi
		[ "$P_bodd" = 0 ] || note "$P_bodd entries in backups/ are neither files nor folders: re-owned, modes left as they are"
		if [ -e "$ACCT_CACHE" ]; then note "$ACCT_CACHE_BOX exists already: the copy refreshes it"; fi
	else
		need "today's tree couldn't be listed (git ls-files, or the walk)"
	fi

	chrome=""
	for c in "$SHARED_CACHE"/chrome/linux-*/chrome-linux64/chrome; do
		real_file "$c" && [ -x "$c" ] && chrome=$c
	done
	if real_dir "$SHARED_CACHE" && [ -n "$chrome" ]; then
		okay "Chromium is in $SHARED_CACHE_BOX"
		[ "$ACCT_UID" = none ] || as_acct test -r "$chrome" || need "$ACCT can't read Chromium in $SHARED_CACHE_BOX"
	else
		need "no Chromium build in $SHARED_CACHE_BOX (the cache move puts it there)"
	fi
	{ [ ! -L "$ACCT_HOME/.cache" ] && [ ! -L "$ACCT_CACHE" ]; } || need "$ACCT_HOME_BOX/.cache and $ACCT_CACHE_BOX must not be links"
	needkb=$(du -sk -- "$SHARED_CACHE" 2>/dev/null | awk 'NR == 1 { print $1 }')
	read -r sizekb availkb <<<"$(df -Pk -- "$ACCT_HOME" 2>/dev/null | awk 'NR == 2 { print $2, $4 }')"
	if [[ "${needkb:-}" =~ ^[0-9]+$ && "${sizekb:-}" =~ ^[0-9]+$ && "${availkb:-}" =~ ^[0-9]+$ ]]; then
		CACHE_MIB=$((needkb / 1024))
		floorkb=$((sizekb / 10))
		[ "$floorkb" -ge 5242880 ] || floorkb=5242880
		if [ $((availkb - needkb)) -ge "$floorkb" ]; then
			okay "free space: $((availkb / 1024)) MiB, and the copy takes $CACHE_MIB MiB"
		else
			need "free space: $((availkb / 1024)) MiB, and the copy takes $CACHE_MIB MiB: that leaves less than $((floorkb / 1024)) MiB (5 GiB or a tenth of the disk) on a shared box"
		fi
	else
		CACHE_MIB=unknown
		need "the free space for the Chromium copy can't be read"
	fi

	if [ "$ENVN" = production ]; then
		if read_crontab root "$TMPD/root.cron"; then
			lines=$(cron_lines "$TMPD/root.cron")
			n=$(count_lines "$lines")
			total=$(wc -l < "$TMPD/root.cron" | tr -d ' ')
			if [ "$n" = 1 ]; then
				okay "root's crontab: the backup line is line $lines of $total ($(cron_vars "$TMPD/root.cron") variable lines stay with root)"
			else
				need "root's crontab must hold exactly one backup line for $APP_BOX (it holds $n${lines:+, lines ${lines//$'\n'/ }})"
			fi
		else
			need "root's crontab can't be read"
		fi
		if [ "$ACCT_UID" = none ]; then
			:
		elif read_crontab "$ACCT" "$TMPD/acct.cron"; then
			[ "$(count_lines "$(cron_lines "$TMPD/acct.cron")")" = 0 ] || need "$ACCT's crontab already holds a backup line"
		else
			need "$ACCT's crontab can't be read"
		fi
	fi

	if in_backup_window; then need "it is within an hour of 02:00 (box time or UTC), when the nightly backup runs: run it outside that hour"
	else okay "clear of the nightly backup's hour"; fi
	if [ -e "$ROOT_LOCK_DIR" ] || [ -L "$ROOT_LOCK_DIR" ]; then
		if lock_dir_ok "$ROOT_LOCK_DIR" "$ROOT_UID"; then okay "root's deploy lock folder $ROOT_LOCK_DIR_BOX is root's, 0700"
		else need "root's deploy lock folder $ROOT_LOCK_DIR_BOX must be a folder root owns, mode exactly 0700"; fi
	else
		okay "root's deploy lock folder $ROOT_LOCK_DIR_BOX is made 0700 when the lock is taken"
	fi
	if [ -e "$TMPFILES_FILE" ] || [ -L "$TMPFILES_FILE" ]; then note "$TMPFILES_BOX exists already: it must hold exactly the entry below"; fi
}

date_within_week() {
	local d
	ask "$1 (YYYY-MM-DD)"
	if ! d=$(js days "$ANSWER" "$TODAY"); then need "$1: \"$ANSWER\" isn't a date"; return; fi
	if [ "$d" -lt 0 ]; then need "$1: $ANSWER is in the future"
	elif [ "$d" -gt 7 ]; then need "$1: $ANSWER is $d days ago, more than 7"
	else okay "$1: $ANSWER, $d day(s) ago"; fi
}
apply_questions() {
	local d
	if [ "$LIVE" = 0 ]; then
		row ask "the date of the last monthly restore test: within 7 calendar days"
		[ "$ENVN" != production ] || row ask "the date of the real-path drill: within 7 calendar days"
		row ask "the render transport has stayed socket since its go-live, with no rollback"
		row ask "the lead's nginx check found no root or alias inside $APP_BOX"
		row ask "staging and production share no credential, checked from the names only"
		return 0
	fi
	date_within_week "The date of the last monthly restore test"
	[ "$ENVN" != production ] || date_within_week "The date of the real-path drill"
	if [ -n "$SOCKETS_YOUNG" ]; then
		ask "The sockets' go-live date in the rule-F report (YYYY-MM-DD)"
		if d=$(js days "$ANSWER" "$TODAY") && [ "$d" -ge 7 ]; then
			okay "the sockets went live on $ANSWER by the rule-F report, $d days ago:$SOCKETS_YOUNG were restarted since"
		else
			need "the sockets' go-live date must be 7 or more days ago (\"$ANSWER\")"
		fi
	fi
	confirm "The render transport has stayed socket since its go-live, with no rollback" || need "the transport must have stayed socket since its go-live"
	confirm "The lead's nginx check found no root or alias inside $APP_BOX" || need "the lead's nginx check must come first"
	confirm "Staging and production share no credential (checked from the names only)" || need "staging and production must share no credential"
}

# ── --apply's steps ───────────────────────────────────────────────────────────────────────────────
step1_save() {
	act "1. save today's modes, owners and git config to $STATE_BOX (root only), for --rollback"
	[ "$LIVE" = 1 ] || return 0
	if [ ! -e "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ]; then mkdir -m 0700 -- "$STATE_ROOT" || need "$STATE_ROOT_BOX can't be made"; fi
	lock_dir_ok "$STATE_ROOT" "$ROOT_UID" || need "$STATE_ROOT_BOX must be a folder root owns, mode exactly 0700"
	[ ! -e "$STATE" ] && [ ! -L "$STATE" ] || need "$STATE_BOX exists: an earlier --apply. Run --rollback first"
	mkdir -m 0700 -- "$STATE" || need "$STATE_BOX can't be made"
	if ! make_plan "$STATE/plan"; then
		stop_ask "today's tree couldn't be listed into $STATE_BOX: nothing else was changed"
	fi
	mkdir -p -- "$STATE/git" && cp -p -- "$APP/.git/config" "$STATE/git/config" || stop_ask "git's config couldn't be copied: nothing else was changed"
	if real_dir "$APP/.git/hooks"; then cp -pR -- "$APP/.git/hooks" "$STATE/git/hooks" || stop_ask "git's hooks couldn't be copied: nothing else was changed"; fi
	printf 'environment=%s\napp=%s\naccount=%s\nuid=%s\nname=%s\ndefinition=%s\nhead=%s\n' "$ENVN" "$APP_BOX" "$ACCT" "$ACCT_UID" "$NAME" "$DEF" \
		"$(git -C "$APP" rev-parse --verify -q HEAD 2>/dev/null)" > "$STATE/meta"
	progress apply.1
	okay "saved: $STATE_BOX"
}
step2_root_dump() {
	act "2. copy root's saved pm2 list ($ROOT_HOME_BOX/.pm2/dump.pm2), for the compare at the end"
	[ "$LIVE" = 1 ] || return 0
	local n total sum
	if real_file "$ROOT_HOME/.pm2/dump.pm2"; then
		cp -p -- "$ROOT_HOME/.pm2/dump.pm2" "$STATE/root-dump.before" || stop_ask "root's saved pm2 list couldn't be copied: nothing else was changed"
		if sum=$(js list "$STATE/root-dump.before" "$STATE/root-dump.before.list" "$NAME"); then
			read -r total n _ <<<"$sum"
			okay "root's saved pm2 list: $total entries, $NAME among them $n time(s)"
		else
			note "root's saved pm2 list can't be read: the compare at the end says so"
		fi
	else
		note "root has no saved pm2 list"
		: > "$STATE/root-dump.before"
	fi
	progress apply.2
}
step3_stop() {
	act "3. pm2 stop $NAME in root's pm2 (its exact name)"
	[ "$LIVE" = 1 ] || return 0
	local n st sum
	progress apply.3.begin
	pm2_root stop "$NAME" --silent >/dev/null 2>&1 || stop_ask "pm2 stop $NAME failed in root's pm2"
	sum=$(root_list "$TMPD/root.stopped") || stop_ask "root's pm2 list can't be read after the stop"
	read -r _ n st <<<"$sum"
	[ "$n" = 1 ] && [ "${st#*:}" = stopped ] || stop_ask "$NAME isn't stopped in root's pm2 (listed $n time(s)${st:+: $st})"
	progress apply.3
	okay "$NAME is stopped in root's pm2"
}
# Modes go on while root still owns the tree, so no path can be swapped under a chmod.
step4_modes() {
	act "4. modes, while root still owns the tree:"
	act "   chmod 0750 $APP_BOX (the render account's traverse ACL stays effective)"
	act "   chmod -R g-w,o-rwx on ${P_data:-none} ($P_dataentries entries)"
	act "   chmod 0600 on $P_files untracked top-level files: $P_db database, $P_settings settings, $P_settingscopy settings copies, $P_dbcopy database copies, $P_otherfile other"
	act "   chmod -R go-rwx on $P_dirs untracked top-level folders ($P_direntries entries)"
	[ "$P_backups" != dir ] || act "   chmod 0700 backups/, and 0600 on its $P_bfiles files$( [ "$P_trees" != dir ] || printf '; backups/trees keeps its modes (%s files)' "$P_treesfiles")"
	act "   code, node_modules and .git: left as checked out, execute bits included"
	[ "$LIVE" = 1 ] || return 0
	local now=$TMPD/now d bad
	acl_ok || stop_ask "the render account's ACL isn't on $APP_BOX: no mode was changed"
	make_plan "$now" || stop_ask "today's tree couldn't be listed again: no mode was changed"
	load_plan "$now"
	progress apply.4.begin
	chmod -- 0750 "$APP" || stop_ask "chmod 0750 $APP_BOX failed"
	while IFS= read -r -d '' d; do chmod -R -- g-w,o-rwx "$d" || stop_ask "chmod -R g-w,o-rwx failed on a data folder"; done < "$now/data.nul"
	[ ! -s "$now/files.nul" ] || xargs -0 chmod -- 0600 < "$now/files.nul" || stop_ask "chmod 0600 failed on an untracked top-level file"
	while IFS= read -r -d '' d; do chmod -R -- go-rwx "$d" || stop_ask "chmod -R go-rwx failed on an untracked top-level folder"; done < "$now/dirs.nul"
	if [ "$P_backups" = dir ]; then
		chmod -- 0700 "$APP/backups" || stop_ask "chmod 0700 backups/ failed"
		[ ! -s "$now/bfiles.nul" ] || xargs -0 chmod -- 0600 < "$now/bfiles.nul" || stop_ask "chmod 0600 failed in backups/"
	fi
	[ "$(mode_of "$APP")" = 750 ] && acl_ok || stop_ask "$APP_BOX isn't 0750 with the render account's traverse ACL effective"
	bad=0
	while IFS= read -r -d '' d; do
		[ -e "$d" ] || continue
		[ "$(mode_of "$d")" = 600 ] || bad=$((bad + 1))
	done < <(cat "$now/files.nul" "$now/bfiles.nul")
	while IFS= read -r -d '' d; do
		[ -z "$(find "$d" ! -type l \( -perm -020 -o -perm -004 -o -perm -002 -o -perm -001 \) -print 2>/dev/null | head -n 1)" ] || bad=$((bad + 1))
	done < "$now/data.nul"
	while IFS= read -r -d '' d; do
		[ -z "$(find "$d" ! -type l \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \) -print 2>/dev/null | head -n 1)" ] || bad=$((bad + 1))
	done < "$now/dirs.nul"
	[ "$P_backups" != dir ] || [ "$(mode_of "$APP/backups")" = 700 ] || bad=$((bad + 1))
	[ "$bad" = 0 ] || stop_ask "$bad of the paths above don't read back with their new modes"
	progress apply.4
	okay "modes read back: $APP_BOX 0750 with the ACL; the files 0600; the data folders without group write or other access"
}
step5_owners() {
	act "5. chown -hR $ACCT:$ACCT $APP_BOX ($P_entries entries; no link is followed)"
	[ "$LIVE" = 1 ] || return 0
	local left
	progress apply.5.begin
	chown -hR -- "$ACCT:$ACCT" "$APP" || stop_ask "chown -hR $ACCT:$ACCT $APP_BOX failed"
	left=$(find "$APP" ! -user "$ACCT_UID" -print 2>/dev/null | head -n 1)
	[ -z "$left" ] || stop_ask "some of $APP_BOX isn't owned by $ACCT after the chown"
	progress apply.5
	okay "$APP_BOX and everything in it is owned by $ACCT"
}
step6_chromium() {
	act "6. as $ACCT, copy Chromium from $SHARED_CACHE_BOX into $ACCT_CACHE_BOX, the path its AppArmor profile covers ($CACHE_MIB MiB)"
	[ "$LIVE" = 1 ] || return 0
	local c got=0
	progress apply.6.begin
	as_acct mkdir -p -- "$ACCT_CACHE" || stop_ask "$ACCT couldn't make $ACCT_CACHE_BOX"
	as_acct cp -a -- "$SHARED_CACHE/." "$ACCT_CACHE/" || stop_ask "$ACCT couldn't copy Chromium into $ACCT_CACHE_BOX"
	for c in "$ACCT_CACHE"/chrome/linux-*/chrome-linux64/chrome; do
		real_file "$c" && [ -x "$c" ] && [ "$(uid_of "$c")" = "$ACCT_UID" ] && got=$((got + 1))
	done
	[ "$got" -ge 1 ] || stop_ask "no Chromium that $ACCT owns and can execute in $ACCT_CACHE_BOX after the copy"
	progress apply.6
	okay "Chromium is in $ACCT_CACHE_BOX, owned by $ACCT"
}
step7_tmpfiles() {
	local entry="d $ACCT_LOCK_DIR_BOX 0700 $ACCT $ACCT -"
	act "7. write $TMPFILES_BOX: \"$entry\""
	act "   apply it now (systemd-tmpfiles --create), then read $ACCT_LOCK_DIR_BOX back: a folder $ACCT owns, mode exactly 0700"
	[ "$LIVE" = 1 ] || return 0
	local want=$TMPD/tmpfiles
	printf '# The deploy lock folder for %s, which only it can write (app-user-cutover.sh).\n%s\n' "$ACCT" "$entry" > "$want"
	progress apply.7.begin
	if [ -e "$TMPFILES_FILE" ] || [ -L "$TMPFILES_FILE" ]; then
		real_file "$TMPFILES_FILE" && cmp -s "$want" "$TMPFILES_FILE" || stop_ask "$TMPFILES_BOX exists with other content: it was left as it is"
	else
		cp -- "$want" "$TMPFILES_FILE.new" && chmod -- 0644 "$TMPFILES_FILE.new" && mv -- "$TMPFILES_FILE.new" "$TMPFILES_FILE" || stop_ask "$TMPFILES_BOX couldn't be written"
	fi
	x systemd-tmpfiles --create "$TMPFILES_FILE" >/dev/null 2>&1 || stop_ask "systemd-tmpfiles --create $TMPFILES_BOX failed"
	lock_dir_ok "$ACCT_LOCK_DIR" "$ACCT_UID" || stop_ask "$ACCT_LOCK_DIR_BOX isn't a folder $ACCT owns, mode exactly 0700: the redeploy as $ACCT would refuse its lock"
	progress apply.7
	okay "$ACCT_LOCK_DIR_BOX: a folder $ACCT owns, 0700"
}
step8_start() {
	act "8. as $ACCT, with only HOME, PATH and LANG: pm2 start $APP_BOX/$DEF"
	act "   then $ACCT's pm2 must list exactly one app, $NAME, and it must answer on :$PORT; otherwise stop before pm2 save"
	act "   as $ACCT: pm2 save; as root: pm2 startup systemd -u $ACCT --hp $ACCT_HOME_BOX (its boot unit)"
	[ "$LIVE" = 1 ] || return 0
	local v sum acct_ok=1
	if daemon_up "$ACCT_HOME/.pm2" && sum=$(acct_list "$TMPD/acct.before"); then
		note "$ACCT's pm2 listed ${sum%% *} entries before the start"
	else
		: > "$TMPD/acct.before"
	fi
	progress apply.8.begin
	pm2_acct start "$APP/$DEF" --silent >/dev/null 2>&1 || note "pm2 start answered non-zero; its list decides"
	acct_list "$TMPD/acct.after" >/dev/null || stop_ask "$ACCT's pm2 list can't be read after the start: nothing was saved"
	v=$(one_app "$TMPD/acct.after") || acct_ok=0
	note "$ACCT's pm2 after the start lists ${v%%$'\n'*}"
	[ "$acct_ok" = 1 ] || stop_ask "$ACCT's pm2 must list exactly one app, $NAME: nothing was saved"
	answers 30 || stop_ask "$NAME doesn't answer on :$PORT as $ACCT: nothing was saved"
	pm2_acct save --silent >/dev/null 2>&1 || stop_ask "pm2 save failed as $ACCT"
	js list "$ACCT_HOME/.pm2/dump.pm2" "$TMPD/acct.saved" "$NAME" >/dev/null && one_app "$TMPD/acct.saved" >/dev/null \
		|| stop_ask "$ACCT's saved pm2 list isn't exactly $NAME"
	x env -i HOME="$ROOT_HOME" PATH="$PATH" LANG=C.UTF-8 "$PM2_BIN" startup systemd -u "$ACCT" --hp "$ACCT_HOME_BOX" >/dev/null 2>&1 \
		|| stop_ask "pm2 startup for $ACCT failed"
	unit_enabled "pm2-$ACCT" || stop_ask "pm2-$ACCT isn't enabled after pm2 startup"
	acct_list "$TMPD/acct.final" >/dev/null && one_app "$TMPD/acct.final" >/dev/null \
		|| stop_ask "$ACCT's pm2 no longer lists exactly $NAME after pm2 startup"
	progress apply.8
	okay "$NAME runs as $ACCT, answers on :$PORT, is saved, and pm2-$ACCT starts it at boot"
}
step9_root_delete() {
	act "9. pm2 delete $NAME in root's pm2 (its exact name), then pm2 save as root"
	[ "$LIVE" = 1 ] || return 0
	local n sum
	progress apply.9.begin
	pm2_root delete "$NAME" --silent >/dev/null 2>&1 || stop_ask "pm2 delete $NAME failed in root's pm2"
	sum=$(root_list "$TMPD/root.deleted") || stop_ask "root's pm2 list can't be read after the delete"
	read -r _ n _ <<<"$sum"
	[ "$n" = 0 ] || stop_ask "$NAME is still listed in root's pm2 after the delete"
	pm2_root save --silent >/dev/null 2>&1 || stop_ask "pm2 save failed in root's pm2"
	progress apply.9
	okay "$NAME is no longer in root's pm2, and root's list is saved"
}
step10_cron() {
	[ "$ENVN" = production ] || return 0
	act "10. move the backup line from root's crontab to $ACCT's, then compare both: only that line moved"
	[ "$LIVE" = 1 ] || return 0
	local lines k total
	read_crontab root "$STATE/root-crontab.before" || stop_ask "root's crontab can't be read: nothing was moved"
	read_crontab "$ACCT" "$STATE/acct-crontab.before" || stop_ask "$ACCT's crontab can't be read: nothing was moved"
	lines=$(cron_lines "$STATE/root-crontab.before")
	[ "$(count_lines "$lines")" = 1 ] || stop_ask "root's crontab holds $(count_lines "$lines") backup lines now, not one: nothing was moved"
	[ "$(count_lines "$(cron_lines "$STATE/acct-crontab.before")")" = 0 ] || stop_ask "$ACCT's crontab holds a backup line already: nothing was moved"
	k=$lines
	total=$(wc -l < "$STATE/root-crontab.before" | tr -d ' ')
	sed -n "${k}p" "$STATE/root-crontab.before" > "$STATE/cron.line"
	printf '%s\n' "$k" > "$STATE/cron.position"
	awk -v n="$k" 'NR != n' "$STATE/root-crontab.before" > "$TMPD/root.cron.new"
	{ awk 1 "$STATE/acct-crontab.before"; cat "$STATE/cron.line"; } > "$TMPD/acct.cron.new"
	progress apply.10.begin
	x crontab -u root "$TMPD/root.cron.new" || stop_ask "root's crontab couldn't be written: compare it with $STATE_BOX/root-crontab.before"
	x crontab -u "$ACCT" "$TMPD/acct.cron.new" || stop_ask "$ACCT's crontab couldn't be written; the line is saved in $STATE_BOX, and --rollback puts it back"
	read_crontab root "$TMPD/root.cron.after" && cmp -s "$TMPD/root.cron.new" "$TMPD/root.cron.after" \
		|| stop_ask "root's crontab isn't its old lines less line $k: compare it with $STATE_BOX/root-crontab.before"
	read_crontab "$ACCT" "$TMPD/acct.cron.after" && cmp -s "$TMPD/acct.cron.new" "$TMPD/acct.cron.after" \
		|| stop_ask "$ACCT's crontab isn't its old lines plus the backup line"
	progress apply.10
	okay "the backup line moved: line $k of $total in root's crontab is now in $ACCT's; root's other $((total - 1)) lines are byte for byte as before"
}
# Last, since nothing can undo a save: root's saved list must have lost our entry and nothing else.
apply_dump_compare() {
	act "last: compare root's saved pm2 list with step 2's copy: only $NAME may be gone (names and statuses; other entries by count and pm2 id)"
	[ "$LIVE" = 1 ] || return 0
	local v
	v=$(js dump-diff "$STATE/root-dump.before" "$ROOT_HOME/.pm2/dump.pm2" "$NAME" removed)
	printf '%s\n' "$v" | tail -n +2 | while IFS= read -r l; do note "$l"; done
	if [ "${v%%$'\n'*}" = ok ]; then
		okay "root's saved pm2 list lost $NAME and nothing else"
		return 0
	fi
	return 1
}

apply_main() {
	if [ -e "$STATE" ] || [ -L "$STATE" ]; then
		need "$STATE_BOX exists: an earlier --apply. Read its progress file, then --rollback"
	fi
	apply_checks
	apply_questions
	if [ "$LIVE" = 0 ]; then
		row "" "--apply, after its questions, holds root's deploy lock ($ROOT_LOCK_FILE_BOX) and runs:"
		step1_save; step2_root_dump; step3_stop; step4_modes; step5_owners; step6_chromium; step7_tmpfiles; step8_start
		step9_root_delete; step10_cron; apply_dump_compare
		if [ "$FAILS" -gt 0 ]; then
			row "" "--apply would refuse: $FAILS check(s) failed. Nothing was changed."
			exit 1
		fi
		row "" "Every check passed. Nothing was changed."
		exit 0
	fi
	! in_backup_window || need "it is now within an hour of 02:00 (box time or UTC): run it outside that hour"
	take_root_lock
	local sum n ours
	sum=$(root_list "$TMPD/root.locked") || need "root's pm2 list can't be read"
	read -r _ n ours <<<"$sum"
	[ "$n" = 1 ] && [ "${ours#*:}" = online ] || need "root's pm2 no longer lists $NAME once, online"
	step1_save; step2_root_dump; step3_stop; step4_modes; step5_owners; step6_chromium; step7_tmpfiles; step8_start
	step9_root_delete; step10_cron
	progress apply.done
	local same=1
	apply_dump_compare || same=0
	row next "Arvin: set $ENVN's VPS_USER to $ACCT, with its key, only while no Deploy or drift run is in flight (around the flip, root and $ACCT lock different files for one run)"
	row next "the lead: a same-commit redeploy (deploy.yml, target $ENVN), then the $CHECK check"
	row next "if a check fails: app-user-cutover.sh $ENVN --rollback, then VPS_USER back to root"
	if [ "$same" = 0 ]; then
		stop_ask "root's saved pm2 list changed beyond $NAME (above). The cutover itself is done. The copy from step 2 is $STATE_BOX/root-dump.before (root only); it is never put back by itself, because it still holds $NAME"
	fi
	row "" "Done: $NAME runs as $ACCT."
	exit 0
}

# ── --rollback ────────────────────────────────────────────────────────────────────────────────────
TREE_DIFF=""
# Read as the account, before root takes the tree back: HEAD is the verified deploy, no tracked file
# changed, and git's config and hooks are as --apply saved them (root runs git here again afterwards).
tree_check() {
	local head rec dirty same
	TREE_DIFF=""
	head=$(git_acct rev-parse --verify -q HEAD 2>/dev/null) || head=""
	rec=$(git_acct rev-parse --verify -q 'refs/logisx/verified-deploy^{commit}' 2>/dev/null) || rec=""
	if [ -z "$head" ] || [ -z "$rec" ]; then TREE_DIFF="HEAD or the verified-deploy record can't be read"
	elif [ "$head" != "$rec" ]; then TREE_DIFF="HEAD ${head:0:12} isn't the verified deploy ${rec:0:12}"; fi
	if dirty=$(git_acct status --porcelain --untracked-files=no 2>/dev/null); then
		[ -z "$dirty" ] || TREE_DIFF="${TREE_DIFF:+$TREE_DIFF; }$(count_lines "$dirty") tracked file(s) changed"
	else
		TREE_DIFF="${TREE_DIFF:+$TREE_DIFF; }git status failed"
	fi
	real_dir "$APP/.git" || TREE_DIFF="${TREE_DIFF:+$TREE_DIFF; }.git isn't a folder"
	if real_dir "$STATE/git"; then
		same=$(js git-same "$STATE/git" "$APP/.git")
		[ "$same" = ok ] || TREE_DIFF="${TREE_DIFF:+$TREE_DIFF; }git's ${same#differs: } differ from --apply's copy"
	fi
	[ -z "$TREE_DIFF" ]
}
rb_tree_question() {
	if ! ran apply.5.begin || ran rollback.2; then return 0; fi
	if tree_check; then
		okay "the tree, read as $ACCT: HEAD is the verified deploy, no tracked file changed, git's config and hooks as saved"
		return 0
	fi
	row ask "the tree, read as $ACCT: $TREE_DIFF"
	[ "$LIVE" = 1 ] || return 0
	ask "Root would run this tree. Type ROLLBACK ANYWAY to go on, anything else stops"
	[ "$ANSWER" = "ROLLBACK ANYWAY" ] || need "the tree check found a difference"
	okay "Arvin goes on despite the tree check"
}
rb1_account() {
	act "account: pm2 delete $NAME and pm2 save as $ACCT (when listed), then systemctl disable pm2-$ACCT"
	[ "$LIVE" = 1 ] || return 0
	ran rollback.1 && return 0
	local n sum
	progress rollback.1.begin
	if ! ran apply.8.begin; then
		okay "--apply never started $NAME as $ACCT"
	elif daemon_up "$ACCT_HOME/.pm2"; then
		sum=$(acct_list "$TMPD/acct.now") || stop_ask "$ACCT's pm2 list can't be read"
		read -r _ n _ <<<"$sum"
		if [ "$n" != 0 ]; then
			pm2_acct delete "$NAME" --silent >/dev/null 2>&1 || stop_ask "pm2 delete $NAME failed as $ACCT"
			pm2_acct save --silent >/dev/null 2>&1 || stop_ask "pm2 save failed as $ACCT"
			sum=$(acct_list "$TMPD/acct.gone") || stop_ask "$ACCT's pm2 list can't be read after the delete"
			read -r _ n _ <<<"$sum"
			[ "$n" = 0 ] || stop_ask "$NAME is still listed in $ACCT's pm2"
			okay "$NAME deleted from $ACCT's pm2, and its list saved"
		else
			okay "$NAME isn't listed in $ACCT's pm2"
		fi
	else
		note "$ACCT's pm2 daemon isn't running: its saved list stays as it is, and its boot unit is disabled next"
	fi
	if unit_enabled "pm2-$ACCT"; then
		x systemctl disable "pm2-$ACCT" >/dev/null 2>&1 || stop_ask "systemctl disable pm2-$ACCT failed"
		! unit_enabled "pm2-$ACCT" || stop_ask "pm2-$ACCT is still enabled"
		okay "pm2-$ACCT is disabled: $ACCT's pm2 no longer starts at boot"
	else
		okay "pm2-$ACCT isn't enabled"
	fi
	progress rollback.1
}
rb2_tree() {
	act "tree: chown -hR root:root $APP_BOX (no link followed), then the owners and modes --apply saved (never through a link)"
	[ "$LIVE" = 1 ] || return 0
	ran rollback.2 && return 0
	local o p r
	if ! ran apply.4.begin && ! ran apply.5.begin; then
		okay "--apply never changed an owner or a mode"
		progress rollback.2
		return 0
	fi
	progress rollback.2.begin
	chown -hR -- root:root "$APP" || stop_ask "chown -hR root:root $APP_BOX failed"
	while IFS= read -r -d '' o && IFS= read -r -d '' p; do
		case "/$p/" in */../*) continue ;; esac
		[ -e "$APP/$p" ] || [ -L "$APP/$p" ] || continue
		chown -h -- "$o" "$APP/$p" || stop_ask "an owner --apply saved couldn't be put back"
	done < "$STATE/plan/owners.nul"
	r=$(js restore-modes "$APP" "$STATE/plan/modes") || stop_ask "the saved modes couldn't be put back"
	okay "modes put back: $r"
	[ "$(uid_of "$APP")" = "$ROOT_UID" ] || stop_ask "$APP_BOX isn't root's after the chown"
	acl_ok || note "$RENDER's traverse ACL isn't effective on $APP_BOX now"
	progress rollback.2
	okay "$APP_BOX is root's again, with its saved modes"
}
rb3_cron() {
	[ "$ENVN" = production ] || return 0
	act "cron: the backup line back from $ACCT's crontab to root's, at its old place, then compare both"
	[ "$LIVE" = 1 ] || return 0
	ran rollback.3 && return 0
	local r a rn an k src
	if ! ran apply.10.begin; then okay "--apply never moved the backup line"; progress rollback.3; return 0; fi
	read_crontab root "$TMPD/rb.root.cron" || stop_ask "root's crontab can't be read: nothing was moved"
	read_crontab "$ACCT" "$TMPD/rb.acct.cron" || stop_ask "$ACCT's crontab can't be read: nothing was moved"
	r=$(cron_lines "$TMPD/rb.root.cron"); rn=$(count_lines "$r")
	a=$(cron_lines "$TMPD/rb.acct.cron"); an=$(count_lines "$a")
	case "$rn:$an" in
		1:0) okay "the backup line is in root's crontab already"; progress rollback.3; return 0 ;;
		0:1) sed -n "${a}p" "$TMPD/rb.acct.cron" > "$TMPD/rb.line"; src=account ;;
		0:0) real_file "$STATE/cron.line" && [ -s "$STATE/cron.line" ] || stop_ask "the backup line is in neither crontab, and none is saved"
			cp -- "$STATE/cron.line" "$TMPD/rb.line"; src=saved ;;
		*) stop_ask "root's crontab holds $rn backup lines and $ACCT's holds $an: nothing was moved" ;;
	esac
	k=$(head -n 1 "$STATE/cron.position" 2>/dev/null)
	[[ "$k" =~ ^[0-9]+$ ]] || k=999999
	awk -v n="$k" -v f="$TMPD/rb.line" 'NR == n { while ((getline l < f) > 0) print l; done = 1 } { print } END { if (!done) while ((getline l < f) > 0) print l }' "$TMPD/rb.root.cron" > "$TMPD/rb.root.new"
	progress rollback.3.begin
	if [ "$src" = account ]; then
		awk -v n="$a" 'NR != n' "$TMPD/rb.acct.cron" > "$TMPD/rb.acct.new"
		x crontab -u "$ACCT" "$TMPD/rb.acct.new" || stop_ask "$ACCT's crontab couldn't be written: nothing was moved"
		read_crontab "$ACCT" "$TMPD/rb.acct.after" && cmp -s "$TMPD/rb.acct.new" "$TMPD/rb.acct.after" || stop_ask "$ACCT's crontab isn't its old lines less the backup line"
	fi
	x crontab -u root "$TMPD/rb.root.new" || stop_ask "root's crontab couldn't be written; the line is saved in $STATE_BOX, and another --rollback puts it back"
	read_crontab root "$TMPD/rb.root.after" && cmp -s "$TMPD/rb.root.new" "$TMPD/rb.root.after" || stop_ask "root's crontab isn't its old lines plus the backup line"
	progress rollback.3
	okay "the backup line is back in root's crontab, at line $(cron_lines "$TMPD/rb.root.after"); its other lines are byte for byte as before"
}
rb4_tmpfiles() {
	act "tmpfiles: remove $TMPFILES_BOX ($ACCT_LOCK_DIR_BOX itself goes at the next boot)"
	[ "$LIVE" = 1 ] || return 0
	ran rollback.4 && return 0
	if ran apply.7.begin && { [ -e "$TMPFILES_FILE" ] || [ -L "$TMPFILES_FILE" ]; }; then
		rm -f -- "$TMPFILES_FILE" || stop_ask "$TMPFILES_BOX couldn't be removed"
		[ ! -e "$TMPFILES_FILE" ] || stop_ask "$TMPFILES_BOX is still there"
		okay "$TMPFILES_BOX removed"
	else
		okay "no tmpfiles entry of --apply's to remove"
	fi
	progress rollback.4
}
# Root's daemon also runs other clients' processes, so only our one new entry may differ around the start.
rb5_root() {
	act "root: pm2 start $APP_BOX/$DEF as root, with only HOME, PATH and LANG; root's list then differs from just before only by $NAME, once"
	act "   it must answer on :$PORT; then pm2 save, and the saved list compared: only $NAME back"
	[ "$LIVE" = 1 ] || return 0
	ran rollback.5 && return 0
	local n ours v sum total
	if ! ran apply.9.begin; then
		sum=$(root_list "$TMPD/rb.root.now") || stop_ask "root's pm2 list can't be read"
		read -r _ n ours <<<"$sum"
		[ "$n" = 1 ] || stop_ask "$NAME is listed $n time(s) in root's pm2, and --apply never removed it"
		if [ "${ours#*:}" != online ]; then
			progress rollback.5.begin
			pm2_root restart "$NAME" --silent >/dev/null 2>&1 || stop_ask "pm2 restart $NAME failed in root's pm2"
		fi
		answers 30 || stop_ask "$NAME doesn't answer on :$PORT under root"
		progress rollback.5
		okay "$NAME runs under root again (root's saved list was never changed)"
		return 0
	fi
	if ! ran rollback.5.begin; then
		sum=$(root_list "$STATE/rollback-root.before") || stop_ask "root's pm2 list can't be read just before the start: nothing was started"
		read -r total n ours <<<"$sum"
		[ "$total" != 0 ] || stop_ask "root's pm2 lists nothing: a save now would drop every other saved entry. Nothing was started"
		[ "$n" = 0 ] || stop_ask "$NAME is already listed in root's pm2 ($(fmt_ours "$ours")): nothing was started"
		if real_file "$ROOT_HOME/.pm2/dump.pm2"; then cp -p -- "$ROOT_HOME/.pm2/dump.pm2" "$STATE/rollback-root-dump.before"; else : > "$STATE/rollback-root-dump.before"; fi
		progress rollback.5.begin
		pm2_root start "$APP/$DEF" --silent >/dev/null 2>&1 || note "pm2 start answered non-zero; its list decides"
	fi
	root_list "$TMPD/rb.root.after" >/dev/null || stop_ask "root's pm2 list can't be read after the start: nothing was saved"
	v=$(js root-diff "$STATE/rollback-root.before" "$TMPD/rb.root.after" "$NAME")
	printf '%s\n' "$v" | tail -n +2 | while IFS= read -r l; do note "$l"; done
	[ "${v%%$'\n'*}" = ok ] || stop_ask "root's pm2 list changed beyond $NAME's one new entry: nothing was saved. Check root's list yourself (it names other clients' processes: don't paste it), then pm2 save as root if it is right"
	answers 30 || stop_ask "$NAME doesn't answer on :$PORT under root: nothing was saved"
	pm2_root save --silent >/dev/null 2>&1 || stop_ask "pm2 save failed in root's pm2"
	progress rollback.5
	okay "$NAME runs under root again, answers on :$PORT, and root's list is saved"
	v=$(js dump-diff "$STATE/rollback-root-dump.before" "$ROOT_HOME/.pm2/dump.pm2" "$NAME" added)
	printf '%s\n' "$v" | tail -n +2 | while IFS= read -r l; do note "$l"; done
	[ "${v%%$'\n'*}" = ok ] || DUMP_DIFFERS=1
}

rollback_main() {
	local n ours sum total
	DUMP_DIFFERS=0
	real_dir "$STATE" || need "no saved state at $STATE_BOX: this script has nothing to roll back"
	note "recorded so far: $(awk '{ print $1 }' "$STATE/progress" 2>/dev/null | tr '\n' ' ')"
	if ! daemon_up "$ROOT_HOME/.pm2"; then
		need "root's pm2 daemon isn't running from $ROOT_HOME_BOX/.pm2 (this script never starts one to look)"
	elif ! sum=$(root_list "$TMPD/root.now"); then
		need "root's pm2 list can't be read"
	elif [ "${sum%% *}" = 0 ]; then
		need "root's pm2 lists nothing: a save would drop every other saved entry"
	else
		read -r total n ours <<<"$sum"
		if ran apply.9.begin && ! ran rollback.5.begin && [ "$n" != 0 ]; then
			need "$NAME is already listed in root's pm2 ($(fmt_ours "$ours")), though --apply removed it"
		else
			okay "root's pm2: $total entries; $NAME listed $n time(s)${ours:+ ($(fmt_ours "$ours"))}"
		fi
	fi
	if [ "$LIVE" = 0 ]; then
		rb_tree_question
		row "" "--rollback holds $ACCT's deploy lock (taken as $ACCT) and root's, then runs:"
		rb1_account; rb2_tree; rb3_cron; rb4_tmpfiles; rb5_root
		row "" "then $STATE_BOX moves aside, as $STATE_BOX.rolled-back.<time>"
		if [ "$FAILS" -gt 0 ]; then row "" "--rollback would refuse: $FAILS check(s) failed. Nothing was changed."; exit 1; fi
		row "" "Nothing was changed."
		exit 0
	fi
	! in_backup_window || note "it is within an hour of 02:00, the nightly backup's hour: a rollback still goes ahead"
	take_acct_lock
	take_root_lock
	rb_tree_question
	rb1_account
	rb2_tree
	rb3_cron
	rb4_tmpfiles
	rb5_root
	progress rollback.done
	mv -- "$STATE" "$STATE.rolled-back.$(date -u +%Y%m%dT%H%M%SZ)" || note "$STATE_BOX couldn't be moved aside"
	row next "Arvin: set $ENVN's VPS_USER back to root (root's key is still authorized), only while no Deploy or drift run is in flight"
	if [ "$DUMP_DIFFERS" = 1 ]; then
		row STOP "root's saved pm2 list changed beyond $NAME (above). The rollback itself is done, and its saved state moved aside. Nothing is put back by itself"
		echo "app-user-cutover: stopped to ask Arvin about root's saved pm2 list. The rollback itself is done." >&2
		exit 3
	fi
	row "" "Done: $NAME runs under root again."
	exit 0
}

case "$MODE" in
	--apply) apply_main ;;
	--rollback) rollback_main ;;
	*) if [ -e "$STATE" ]; then rollback_main; else apply_main; fi ;;
esac
