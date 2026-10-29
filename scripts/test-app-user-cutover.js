#!/usr/bin/env node
/**
 * Runs scripts/ops/app-user-cutover.sh for real, on a made-up box in a temp folder: an app
 * checkout, a made-up account, root's pm2 with other clients' processes beside ours, a crontab with
 * other jobs. pm2, chown, chmod, getfacl, setfacl, getent, runuser, flock, systemctl,
 * systemd-tmpfiles, crontab, curl, du, df and the clock are recording stubs on a PATH that holds
 * nothing else that could reach this machine's own services. Arvin runs the script on the box;
 * nothing here does.
 *
 *   §1 the target: an environment and a mode are required before anything is read or run.
 *   §2 --dry-run lists every check and action and changes nothing.
 *   §3 --apply: owners; modes that keep execute bits, set while root still owns the tree; the 0600
 *      list (the key file and every untracked top-level file); the ACL kept; Chromium; the tmpfiles
 *      entry; the account's pm2 (one app, a cleared environment); root's pm2; the backup line.
 *   §4 --rollback, beside other clients' processes in root's pm2: the backup line and the tmpfiles
 *      entry go back before root's pm2 starts; owners and modes go back.
 *   §5 root's pm2 around the rollback's start: only our one new entry may differ, statuses don't
 *      count, and any other difference stops before pm2 save, printing no other process's name.
 *   §6 the account's pm2 after the start: exactly one app, the expected one, or a stop before save.
 *   §7 root's saved pm2 list, compared last: a difference stops and asks, and the copy is never put back.
 *   §8 the preconditions: sockets 7 days, the transport, the test and drill dates, the ACL, old
 *      settings copies, the backup hour, the crontab, the stopgap's trees.
 *   §9 the locks: root's held through --apply; the account's taken only as the account in --rollback;
 *      the account's lock folder read back exactly 0700.
 *   §10 the tree check before a rollback, read as the account.
 *   §11 a rollback after an --apply that stopped part way.
 *   §12 the names it shares with sibling PRs, checked against their files once those are in this
 *       tree: the lock folder (B10), staging's definition file (B11), the socket units (B9), the
 *       AppArmor profile's caches (B8).
 *   §13 source pins.
 *   §14 mutants: each property, broken on purpose, turns its case red.
 *
 * Made-up names and values only; temp folders only.
 *   node scripts/test-app-user-cutover.js
 *   CUTOVER_TEST_VERBOSE=1 node scripts/test-app-user-cutover.js   (also prints what each run printed)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT_REL = "scripts/ops/app-user-cutover.sh";
const SCRIPT = path.join(ROOT, SCRIPT_REL);
const SOURCE = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : "";

const NOW = Date.UTC(2026, 11, 21, 15, 0, 0) / 1000;
const DAY = 86400;
const daysAgo = (n) => new Date((NOW - n * DAY) * 1000).toISOString().slice(0, 10);
// Neutral stand-ins for the app's settings file and the Google key file.
const SETTINGS = "app-settings.conf";
const KEY = "svc-key-fixture.json";
const SETTINGS_SENTINEL = "settings-sentinel-6d1f0c";
const PM2_ENV_SENTINEL = "pm2-env-sentinel-91be2a";
const CALLER_SENTINEL = "caller-shell-sentinel-3c77";
const CRON_SENTINEL = "cron-sentinel-71a9";
const TENANTS = ["tenant-sentinel-alpha", "tenant-sentinel-bravo", "tenant-sentinel-charlie"];
const SECRETS = [SETTINGS_SENTINEL, PM2_ENV_SENTINEL, CALLER_SENTINEL, CRON_SENTINEL];
const ENVS = {
	production: {
		app: "/var/www/logistics-app", name: "logistics-app", def: "ecosystem.config.js", acct: "logisx-prd", port: 3000,
		other: "logisx-staging", otherDef: "ecosystem.staging.config.js",
		sockets: ["logisx-prd-receipts.socket", "logisx-prd-photos.socket"],
	},
	staging: {
		app: "/var/www/logisx-staging", name: "logisx-staging", def: "ecosystem.staging.config.js", acct: "logisx-stg", port: 3003,
		other: "logistics-app", otherDef: "ecosystem.config.js",
		sockets: ["logisx-stg-receipts.socket", "logisx-stg-photos.socket"],
	},
};
const OUR_CRON = "0 2 * * * /var/www/logistics-app/backup.sh >> /var/www/logistics-app/backups/backup.log 2>&1";
const ROOT_CRON = [
	"# m h dom mon dow command",
	"MAILTO=\"\"",
	"15 3 * * * /var/www/other-client/backup.sh >> /var/log/other-client.log 2>&1",
	OUR_CRON,
	`*/5 * * * * /usr/local/bin/other-client-job --tag ${CRON_SENTINEL}`,
	"0 4 * * 0 /var/www/logistics-app-old/backup.sh",
].join("\n") + "\n";

// ── the runner's own reporting ─────────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function report(lines) {
	for (const l of lines) {
		if (l.note) { console.log(`  note  ${l.note}`); continue; }
		if (l.ok) { pass++; continue; }
		failures.push(l.label);
		console.log(`  FAIL  ${l.label}${l.detail ? `\n          ${String(l.detail).slice(-1200).replace(/\n/g, "\n          ")}` : ""}`);
	}
}
function tally() {
	const t = [];
	return {
		lines: t,
		note: (note) => { t.push({ note, ok: true }); },
		ok: (label, cond, detail) => { t.push({ label, ok: !!cond, detail: cond ? "" : detail }); return !!cond; },
		eq: (label, actual, expected) => {
			const a = JSON.stringify(actual), e = JSON.stringify(expected);
			t.push({ label, ok: a === e, detail: a === e ? "" : `expected ${e}\n actual   ${a}` });
			return a === e;
		},
	};
}

// ── the made-up box ────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-cutover-"));
const BIN = path.join(TMP, "bin");
const TOOLS = path.join(TMP, "tools");
fs.mkdirSync(BIN);
fs.mkdirSync(TOOLS);
// The executable on PATH, never a shell builtin's bare name (test, true, false).
const which = (cmd) => {
	for (const d of (process.env.PATH || "").split(path.delimiter)) {
		if (!d) continue;
		const p = path.join(d, cmd);
		try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ }
	}
	return "";
};
// Only these real tools are reachable: a missing stub fails as "not found", never as the real thing.
for (const t of ["bash", "sh", "env", "cat", "cp", "mv", "rm", "mkdir", "ln", "ls", "find", "stat", "awk", "sed", "grep",
	"sort", "uniq", "head", "tail", "tr", "wc", "cut", "cmp", "diff", "xargs", "mktemp", "basename", "dirname", "touch",
	"test", "true", "false", "git", "id", "tee", "readlink", "seq", "od"]) {
	const p = which(t);
	if (p) fs.symlinkSync(p, path.join(TOOLS, t));
}
fs.symlinkSync(process.execPath, path.join(TOOLS, "node"));
const REAL_CHMOD = ["/bin/chmod", "/usr/bin/chmod"].find((p) => fs.existsSync(p));
const REAL_DATE = ["/bin/date", "/usr/bin/date"].find((p) => fs.existsSync(p));
const REAL_SLEEP = ["/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
const PATH_FOR_SCRIPT = `${BIN}${path.delimiter}${TOOLS}`;

const LOG = 'log() { local IFS=$\'\\x1f\'; printf \'%s\\n\' "$*" >> "$STUB_STATE/calls.log"; }';
const stubs = {
	chown: `#!/bin/bash\n${LOG}\nlog chown "\${STUB_AS:--}" "$@"\n[ ! -e "$STUB_STATE/fail-chown" ] || exit 1\nexit 0\n`,
	chmod: `#!/bin/bash\n${LOG}\nlog chmod "\${STUB_AS:--}" "$@"\nexec ${REAL_CHMOD} "$@"\n`,
	setfacl: `#!/bin/bash\n${LOG}\nlog setfacl "\${STUB_AS:--}" "$@"\nexit 0\n`,
	getfacl: `#!/bin/bash
${LOG}
log getfacl "\${STUB_AS:--}" "$@"
p=\${@: -1}
u=$(awk -F'\\t' -v p="\${p#"$CUTOVER_TEST_ROOT"}" '$1 == p { print $2 }' "$STUB_STATE/acl" 2>/dev/null)
m=$(stat -c %a "$p" 2>/dev/null || stat -f %Lp "$p")
g=\${m:\${#m}-2:1}; o=\${m:\${#m}-1:1}
bits() { local d=$1 s=""; [ $((d & 4)) -ne 0 ] && s=r || s=-; [ $((d & 2)) -ne 0 ] && s=\${s}w || s=\${s}-; [ $((d & 1)) -ne 0 ] && s=\${s}x || s=\${s}-; printf '%s' "$s"; }
echo "user::rwx"
if [ -n "$u" ]; then
	if [ $((g & 1)) -ne 0 ]; then echo "user:$u:--x"; else printf 'user:%s:--x\\t#effective:---\\n' "$u"; fi
fi
echo "group::$(bits "$g")"
[ -z "$u" ] || echo "mask::$(bits "$g")"
echo "other::$(bits "$o")"
`,
	getent: `#!/bin/bash\n${LOG}\nlog getent "\${STUB_AS:--}" "$@"\ncase "$1" in passwd|group) grep -m 1 "^$2:" "$STUB_STATE/$1" || exit 2 ;; *) exit 1 ;; esac\n`,
	runuser: `#!/bin/bash
${LOG}
log runuser "\${STUB_AS:--}" "$@"
if [ "$1" != -u ] || [ "$3" != -- ]; then echo "runuser stub: only runuser -u <user> -- <command>" >&2; exit 2; fi
u=$2; shift 3
if [ "$1" = test ] && [ -f "$STUB_STATE/deny-$u" ] && grep -qxF -- "\${@: -1}" "$STUB_STATE/deny-$u"; then exit 1; fi
STUB_AS=$u exec "$@"
`,
	flock: `#!/bin/bash
${LOG}
log flock "\${STUB_AS:--}" "$@"
if [ "$#" = 2 ] && [ "$1" = -n ]; then [ ! -e "$STUB_STATE/held-fd" ] || exit 1; exit 0; fi
if [ "$1" = -n ] && [ "$#" -ge 3 ]; then shift 2; [ ! -e "$STUB_STATE/held-file" ] || exit 1; exec "$@"; fi
exit 2
`,
	"systemd-tmpfiles": `#!/bin/bash
${LOG}
log systemd-tmpfiles "\${STUB_AS:--}" "$@"
[ "$1" = --create ] || exit 2
while read -r t p m u g rest; do
	[ "$t" = d ] || continue
	mkdir -p "$CUTOVER_TEST_ROOT$p" || exit 1
	mode=$m
	[ ! -f "$STUB_STATE/tmpfiles-mode" ] || mode=$(cat "$STUB_STATE/tmpfiles-mode")
	${REAL_CHMOD} "$mode" "$CUTOVER_TEST_ROOT$p" || exit 1
done < "$2"
`,
	crontab: `#!/bin/bash
${LOG}
log crontab "\${STUB_AS:--}" "$@"
if [ "$1" != -u ]; then echo "crontab stub: -u <user> is required" >&2; exit 2; fi
u=$2; shift 2
f=$STUB_STATE/crontabs/$u
case "$1" in
	-l) [ -f "$f" ] || { echo "no crontab for $u" >&2; exit 1; }; cat "$f" ;;
	*) [ ! -e "$STUB_STATE/fail-crontab-$u" ] || exit 1; cat "$1" > "$f" ;;
esac
`,
	curl: `#!/bin/bash\n${LOG}\nlog curl "\${STUB_AS:--}" "$@"\nurl=\${@: -1}\nport=\${url#http://127.0.0.1:}\nport=\${port%%/*}\ncode=200\n[ ! -f "$STUB_STATE/curl-$port" ] || code=$(cat "$STUB_STATE/curl-$port")\nprintf '%s' "$code"\n`,
	// Short, but long enough that the account lock's holder answers well inside the script's wait.
	sleep: `#!/bin/bash\nexec ${REAL_SLEEP} 0.03\n`,
	date: `#!/bin/bash
now=$(cat "$STUB_STATE/now")
fmt=+%c
for a in "$@"; do case "$a" in -u) ;; +*) fmt=$a ;; *) echo "date stub: $a" >&2; exit 2 ;; esac; done
if ${REAL_DATE} -u -r 0 +%s >/dev/null 2>&1; then exec ${REAL_DATE} -u -r "$now" "$fmt"; else exec ${REAL_DATE} -u -d "@$now" "$fmt"; fi
`,
	du: `#!/bin/bash\n${LOG}\nlog du "\${STUB_AS:--}" "$@"\nprintf '%s\\t%s\\n' "$(cat "$STUB_STATE/du-kb" 2>/dev/null || echo 524288)" "\${@: -1}"\n`,
	df: `#!/bin/bash\n${LOG}\nlog df "\${STUB_AS:--}" "$@"\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fixture 104857600 52428800 $(cat "$STUB_STATE/df-avail-kb" 2>/dev/null || echo 52428800) 50% /"\n`,
	// A unit's state, active-since time (epoch) and enablement are files in stub-state/units.
	systemctl: `#!/bin/bash
${LOG}
log systemctl "\${STUB_AS:--}" "$@"
d=$STUB_STATE/units
case "$1" in
	show)
		u=\${@: -1}
		case "$3" in
			ActiveState) cat "$d/$u.state" 2>/dev/null || echo inactive ;;
			ActiveEnterTimestamp)
				[ -f "$d/$u.since" ] || { echo; exit 0; }
				s=$(cat "$d/$u.since")
				if ${REAL_DATE} -u -r 0 +%s >/dev/null 2>&1; then ${REAL_DATE} -u -r "$s" "+%a %Y-%m-%d %H:%M:%S UTC"; else ${REAL_DATE} -u -d "@$s" "+%a %Y-%m-%d %H:%M:%S UTC"; fi ;;
		esac ;;
	is-enabled) if [ -f "$d/$2.enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
	disable) rm -f "$d/$2.enabled" ;;
	*) exit 2 ;;
esac
`,
	// pm2: one daemon per HOME (root's, or the account's), its list in HOME/.pm2/stub-live.json.
	pm2: `#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const home = process.env.HOME || "";
let st = process.env.STUB_STATE || "";
for (let d = home; !st && d && d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, "stub-state"))) st = path.join(d, "stub-state");
const user = path.basename(home);
const args = process.argv.slice(2);
const cmd = args[0];
const named = args.slice(1).find((x) => !x.startsWith("-"));
fs.appendFileSync(path.join(st, "calls.log"), ["pm2", user, ...args].join("\\x1f") + "\\n");
fs.appendFileSync(path.join(st, "pm2-env.log"), [user, cmd, Object.keys(process.env).sort().join(",")].join("\\x1f") + "\\n");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const scen = readJson(path.join(st, "pm2.json"), {});
const u = (scen.users && scen.users[user]) || {};
const dir = path.join(home, ".pm2");
const liveFile = path.join(dir, "stub-live.json");
const live = readJson(liveFile, { next: 0, list: [] });
const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(liveFile, JSON.stringify(live)); };
const entry = (name, status) => { const id = live.next++; return { pm_id: id, name, status, pid: 4000 + id, pm_uptime: 1 }; };
const envOf = () => ({ SECRET_SENTINEL: scen.envSentinel || "" });
const toJ = (e) => ({ pid: e.pid, name: e.name, pm_id: e.pm_id, pm2_env: { status: e.status, pm_uptime: e.pm_uptime, restart_time: 0, exec_interpreter: "/opt/node22/bin/node", env: envOf() }, monit: { memory: 1, cpu: 0 } });
const toDump = (e) => ({ name: e.name, pm_id: e.pm_id, status: e.status, exec_interpreter: "/opt/node22/bin/node", env: envOf() });
const bump = (k) => { const f = path.join(st, "count-" + user + "-" + k); const n = Number(readJson(f, 0)) + 1; fs.writeFileSync(f, String(n)); return n; };
const answer = (name) => { const port = (scen.ports || {})[name]; if (port && u.answerAfterStart !== undefined) fs.writeFileSync(path.join(st, "curl-" + port), String(u.answerAfterStart)); };
function mutate(m, started) {
	if (m.add) live.list.push(entry(m.add, "online"));
	if (m.addOurs && started) live.list.push(entry(started, "online"));
	if (m.removeStarted && started) live.list = live.list.filter((e) => e.name !== started);
	if (m.removeId !== undefined) live.list = live.list.filter((e) => e.pm_id !== m.removeId);
	if (m.renameId !== undefined) for (const e of live.list) if (e.pm_id === m.renameId) e.name = m.to;
	if (m.reId !== undefined) for (const e of live.list) if (e.pm_id === m.reId) e.pm_id = live.next++;
	if (m.drift) for (const e of live.list) if (e.name !== started) { e.status = e.status === "online" ? "errored" : "online"; e.pid += 7; e.pm_uptime += 100; }
}
switch (cmd) {
	case "jlist": {
		const n = bump("jlist");
		if (u.unreadable) { process.stdout.write("[PM2] this is not a list\\n"); break; }
		if (scen.notice) process.stdout.write(">>>> In-memory PM2 is out-of-date, do:\\n>>>> $ pm2 update\\nIn memory PM2 version: 5.3.0\\nLocal PM2 version: 6.0.8\\n");
		process.stdout.write(JSON.stringify(live.list.map(toJ)) + "\\n");
		if (u.strayAfterJlist === n) { live.list.push(entry("stray-app", "online")); save(); }
		break;
	}
	case "start": {
		if (u.startNoop) break;
		const file = named;
		delete require.cache[require.resolve(file)];
		const apps = (require(file).apps) || [];
		let started = "";
		for (const app of apps) {
			started = app.name;
			const e = live.list.find((x) => x.name === app.name);
			if (e) { e.status = "online"; e.pm_uptime++; } else live.list.push(entry(app.name, "online"));
			answer(app.name);
		}
		for (const m of u.afterStart || []) mutate(m, started);
		save();
		if (scen.alivePid) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "pm2.pid"), String(scen.alivePid)); }
		break;
	}
	case "stop": case "restart": case "delete": {
		const hits = live.list.filter((x) => x.name === named);
		if (!hits.length) { process.stderr.write("[PM2][ERROR] Process or Namespace " + named + " not found\\n"); process.exit(1); }
		if (cmd === "delete") live.list = live.list.filter((x) => x.name !== named);
		else for (const h of hits) { h.status = cmd === "stop" ? "stopped" : "online"; h.pm_uptime++; if (cmd === "restart") answer(named); }
		save();
		break;
	}
	case "save": {
		if (u.saveFails) process.exit(1);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "dump.pm2"), JSON.stringify(live.list.map(toDump), null, 2));
		break;
	}
	case "startup": {
		fs.writeFileSync(path.join(st, "units", "pm2-" + args[args.indexOf("-u") + 1] + ".enabled"), "");
		break;
	}
	default: process.exit(2);
}
`,
};
for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(BIN, name), body, { mode: 0o755 });

const PROD_DEF = fs.readFileSync(path.join(ROOT, "ecosystem.config.js"), "utf8");
// Staging's own definition file, from this tree once B11 adds it; a made-up one until then.
const STAGING_DEF_REPO = path.join(ROOT, "ecosystem.staging.config.js");
const STAGING_DEF = fs.existsSync(STAGING_DEF_REPO) ? fs.readFileSync(STAGING_DEF_REPO, "utf8")
	: "module.exports = { apps: [{ name: \"logisx-staging\", script: \"server.js\", cwd: \"/var/www/logisx-staging\", interpreter: \"/opt/node22/bin/node\" }] };\n";

const GIT_ENV = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" });
function git(cwd, home, ...args) {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV(home), encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}
function put(base, rel, content, mode) {
	const p = path.join(base, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
	fs.chmodSync(p, mode);
	return p;
}
const mkdir = (p, mode) => { fs.mkdirSync(p, { recursive: true }); if (mode !== undefined) fs.chmodSync(p, mode); return p; };

// A case: its own box (fs/), its stubs' state (stub-state/) and temp folder (tmp/).
function makeCase(envName, o = {}) {
	const E = ENVS[envName];
	const dir = fs.mkdtempSync(path.join(TMP, `${envName}-`));
	const F = path.join(dir, "fs");
	const S = mkdir(path.join(dir, "stub-state"));
	mkdir(path.join(S, "crontabs"));
	mkdir(path.join(dir, "tmp"));
	const app = mkdir(F + E.app, 0o755);
	// The made-up checkout's tracked files, [content, mode] by name. The app's own files are never read here.
	const tracked = {
		"server.js": ["// the app\n", 0o644],
		"ecosystem.config.js": [PROD_DEF, 0o644],
		"ecosystem.staging.config.js": [STAGING_DEF, 0o644],
		"backup.sh": ["#!/bin/bash\necho backup\n", 0o755],
		"lib/a.js": ["module.exports = 1;\n", 0o644],
		"lib/chromium-drop.sh": ["#!/bin/sh\nexit 0\n", 0o755],
		"scripts/deploy/remote-deploy.sh": ["#!/bin/bash\nexit 0\n", 0o755],
		"package.json": ["{}\n", 0o644],
		"client/index.html": ["<div id=\"app\"></div>\n", 0o644],
		[`${SETTINGS}.example`]: ["RENDER_CHILD_TRANSPORT=fork\n", 0o644],
	};
	for (const [rel, [body, mode]] of Object.entries(tracked)) put(app, rel, body, mode);
	git(app, dir, "init", "-q");
	git(app, dir, "add", ".");
	git(app, dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
	git(app, dir, "update-ref", "refs/logisx/verified-deploy", "HEAD");
	put(app, "app.db", "made-up database", 0o600);
	put(app, "app.db-wal", "", 0o600);
	put(app, "app.db-shm", "", 0o600);
	put(app, SETTINGS, `SESSION_SECRET=${SETTINGS_SENTINEL}\n${o.transportLine ?? "RENDER_CHILD_TRANSPORT=socket"}\n`, 0o600);
	put(app, KEY, `{"private_key":"${SETTINGS_SENTINEL}"}\n`, 0o600);
	put(app, "app.db.pre-20261001", "made-up copy", 0o644);
	put(app, "app.db.copy-set/app.db", "made-up copy", 0o644);
	fs.chmodSync(path.join(app, "app.db.copy-set"), 0o755);
	put(app, ".drift-heal-attempted", "made-up", 0o644);
	mkdir(path.join(app, "uploads"), 0o750);
	put(app, "uploads/a.pdf", "a", 0o640);
	put(app, "uploads/b.jpg", "b", 0o644);
	put(app, "uploads/run-me.sh", "#!/bin/sh\n", 0o755);
	mkdir(path.join(app, "uploads/sub"), 0o750);
	put(app, "uploads/sub/c.pdf", "c", 0o640);
	mkdir(path.join(app, "storage"), 0o700);
	put(app, "storage/s.pdf", "s", 0o640);
	mkdir(path.join(app, "evidence-archive"), 0o700);
	put(app, "evidence-archive/e.json", "{}", 0o600);
	mkdir(path.join(app, ".cache"), 0o755);
	put(app, ".cache/x", "x", 0o644);
	mkdir(path.join(app, "backups"), 0o755);
	put(app, "backups/app.db.20261220.gz", "gz", 0o644);
	put(app, "backups/backup.log", "log", 0o644);
	mkdir(path.join(app, "backups/trees"), 0o700);
	mkdir(path.join(app, "backups/trees/20261220"), o.treesNightMode ?? 0o700);
	put(app, "backups/trees/20261220/uploads/a.pdf", "a", 0o640);
	put(app, "node_modules/.bin/tool", "#!/bin/sh\n", 0o755);
	put(app, "node_modules/pkg/index.js", "module.exports = 2;\n", 0o644);
	if (envName === "staging" || o.settingsCopy) put(app, `${SETTINGS}.bak-20260901`, "old", 0o644);
	if (!o.noNode) { mkdir(F + "/opt/node22/bin"); fs.symlinkSync(process.execPath, F + "/opt/node22/bin/node"); }
	put(F, "var/cache/logisx-puppeteer/chrome/linux-140.0.7339.0/chrome-linux64/chrome", "#!/bin/sh\n", 0o755);
	put(F, "var/cache/logisx-puppeteer/chrome/linux-140.0.7339.0/chrome-linux64/libfixture.so", "so", 0o644);
	for (const a of ["logisx-prd", "logisx-stg"]) mkdir(F + `/home/${a}`, 0o750);
	mkdir(F + "/etc/tmpfiles.d", 0o755);
	mkdir(F + "/run", 0o755);
	mkdir(F + "/root/.pm2", 0o700);

	const uid = process.getuid();
	const gid = fs.statSync(app).gid;
	const acctUid = o.acctUid ?? uid;
	fs.writeFileSync(path.join(S, "passwd"), [
		`root:x:${uid}:${gid}:root:/root:/bin/bash`,
		...(o.noAccount ? [] : [`logisx-prd:x:${acctUid}:${gid}::/home/logisx-prd:/bin/bash`, `logisx-stg:x:${acctUid}:${gid}::/home/logisx-stg:/bin/bash`]),
		"logisx-prd-render:x:4243:4243::/nonexistent:/usr/sbin/nologin",
		"logisx-stg-render:x:4244:4244::/nonexistent:/usr/sbin/nologin",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(S, "group"), `logisx-prd:x:${gid}:\nlogisx-stg:x:${gid}:\n`);
	if (!o.noAcl) fs.writeFileSync(path.join(S, "acl"), `${E.app}\t${E.acct}-render\n`);
	fs.writeFileSync(path.join(S, "now"), String(o.now ?? NOW));
	mkdir(path.join(S, "units"));
	E.sockets.forEach((u, i) => {
		fs.writeFileSync(path.join(S, "units", `${u}.state`), "active\n");
		fs.writeFileSync(path.join(S, "units", `${u}.since`), String(NOW - ((o.socketDays && o.socketDays[i]) ?? o.socketAge ?? 13) * DAY));
	});
	if (envName === "production") fs.writeFileSync(path.join(S, "crontabs/root"), o.rootCron ?? ROOT_CRON);
	const otherStatus = o.tenantCharlie ?? "errored";
	const list = [
		{ pm_id: 0, name: TENANTS[0], status: "online", pid: 101, pm_uptime: 1 },
		{ pm_id: 1, name: TENANTS[1], status: "online", pid: 102, pm_uptime: 1 },
		{ pm_id: 2, name: E.other, status: "online", pid: 103, pm_uptime: 1 },
		{ pm_id: 3, name: E.name, status: "online", pid: 104, pm_uptime: 1 },
		{ pm_id: 4, name: TENANTS[2], status: otherStatus, pid: 105, pm_uptime: 1 },
	];
	fs.writeFileSync(F + "/root/.pm2/stub-live.json", JSON.stringify({ next: 5, list }));
	fs.writeFileSync(F + "/root/.pm2/dump.pm2", JSON.stringify(list.map((e) => ({ name: e.name, pm_id: e.pm_id, status: e.status, env: { SECRET_SENTINEL: PM2_ENV_SENTINEL } })), null, 2));
	fs.writeFileSync(F + "/root/.pm2/pm2.pid", String(process.pid));
	fs.writeFileSync(path.join(S, "pm2.json"), JSON.stringify({
		envSentinel: PM2_ENV_SENTINEL, alivePid: process.pid, ports: { "logistics-app": 3000, "logisx-staging": 3003 }, ...(o.pm2 || {}),
	}));
	return paths({ env: envName, E, dir, uid, gid });
}
function paths(c) {
	c.F = path.join(c.dir, "fs");
	c.S = path.join(c.dir, "stub-state");
	c.app = c.F + c.E.app;
	c.acctHome = c.F + `/home/${c.E.acct}`;
	c.state = c.F + `/root/logisx-cutover/${c.env}`;
	return c;
}
// A copy of a whole case, every mode and link kept, so each rollback case starts from the same cut-over
// box without an --apply of its own. (fs.cpSync doesn't keep folders' modes.)
function copyTree(src, dst) {
	const st = fs.lstatSync(src);
	if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dst); return; }
	if (st.isDirectory()) {
		fs.mkdirSync(dst);
		for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n));
	} else {
		fs.copyFileSync(src, dst);
	}
	fs.chmodSync(dst, st.mode & 0o7777);
}
function copyCase(src) {
	const dir = fs.mkdtempSync(path.join(TMP, `${src.env}-`));
	for (const n of fs.readdirSync(src.dir)) copyTree(path.join(src.dir, n), path.join(dir, n));
	return paths({ env: src.env, E: src.E, dir, uid: src.uid, gid: src.gid });
}
// One --apply per environment, with the script in this tree, that the rollback cases copy.
const templates = new Map();
function template(envName) {
	if (!templates.has(envName)) {
		templates.set(envName, (async () => {
			const c = makeCase(envName, { socketAge: 7 });
			const before = snap(c.app);
			const r = await runScript(c, "--apply", { answers: answersFor(c) });
			return { c, r, before };
		})());
	}
	return templates.get(envName);
}
async function cutOver(envName) {
	const tpl = await template(envName);
	if (tpl.r.code !== 0) throw new Error(`the ${envName} --apply the rollback cases start from exited ${tpl.r.code}:\n${tpl.r.all.slice(-1200)}`);
	return copyCase(tpl.c);
}

function readCalls(c) {
	let t = "";
	try { t = fs.readFileSync(path.join(c.S, "calls.log"), "utf8"); } catch (e) { return []; }
	return t.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
}
// CUTOVER_TEST_VERBOSE=1 prints every run's output, to read what the script says.
const VERBOSE = process.env.CUTOVER_TEST_VERBOSE === "1";
// The calls this run made: the log is the case's, shared by its runs.
function runScript(c, mode, { answers = [], env = {}, script = SCRIPT, argv } = {}) {
	const seen = readCalls(c).length;
	return new Promise((resolve) => {
		const child = spawn("bash", [script, ...(argv || [c.env, mode])], {
			cwd: c.dir,
			env: {
				PATH: PATH_FOR_SCRIPT, HOME: c.dir, TMPDIR: path.join(c.dir, "tmp"), LANG: "C",
				CUTOVER_TEST_ROOT: c.F, CUTOVER_TEST_PATH: PATH_FOR_SCRIPT, CUTOVER_TEST_SETTINGS_NAME: SETTINGS,
				STUB_STATE: c.S, CALLER_SENTINEL, ...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		child.stdin.on("error", () => {});
		child.stdin.end(answers.map((a) => `${a}\n`).join(""));
		const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (VERBOSE) console.log(`\n── ${path.basename(c.dir)}: ${(argv || [c.env, mode]).join(" ")} → exit ${code}\n${out}${err}`);
			resolve({ code, out, err, all: out + err, calls: readCalls(c).slice(seen) });
		});
	});
}
const answersFor = (c, extra = []) => (c.env === "production" ? [daysAgo(3), daysAgo(3), ...extra, "yes", "yes", "yes"] : [daysAgo(3), ...extra, "yes", "yes", "yes"]);
const apply = (c, opts = {}) => runScript(c, "--apply", { answers: answersFor(c), ...opts });
const rollback = (c, opts = {}) => runScript(c, "--rollback", opts);
const dry = (c, opts = {}) => runScript(c, "--dry-run", opts);

function snap(root) {
	const m = new Map();
	(function walk(p) {
		let st;
		try { st = fs.lstatSync(p); } catch (e) { return; }
		m.set(path.relative(root, p) || ".", { mode: (st.mode & 0o7777).toString(8), type: st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : "f", size: st.size, mtime: st.mtimeMs });
		if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
	})(root);
	return m;
}
const modesOf = (m) => [...m].map(([k, v]) => `${k} ${v.type} ${v.mode}`).sort();
function diffSnaps(a, b, { modesOnly = false } = {}) {
	const out = [];
	for (const [k, v] of a) {
		const w = b.get(k);
		if (!w) { out.push(`gone: ${k}`); continue; }
		if (v.mode !== w.mode || v.type !== w.type || (!modesOnly && (v.size !== w.size || v.mtime !== w.mtime))) out.push(`changed: ${k} ${v.mode}->${w.mode}`);
	}
	for (const k of b.keys()) if (!a.has(k)) out.push(`new: ${k}`);
	return out;
}
const modeAt = (p) => { try { return (fs.lstatSync(p).mode & 0o7777).toString(8); } catch (e) { return "missing"; } };
const readOr = (p, d = null) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return d; } };
const liveOf = (home) => (JSON.parse(readOr(path.join(home, ".pm2/stub-live.json"), "{\"list\":[]}")).list || []);
const dumpOf = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, ".pm2/dump.pm2"), "utf8")); } catch (e) { return null; } };
const named = (l, n) => l.filter((e) => e.name === n);
const MUTATING = (call) => {
	const [cmd, , ...a] = call;
	if (["chown", "chmod", "setfacl", "systemd-tmpfiles", "flock"].includes(cmd)) return true;
	if (cmd === "crontab") return !a.includes("-l");
	if (cmd === "systemctl") return a[0] === "disable" || a[0] === "enable";
	if (cmd === "pm2") return a[0] !== "jlist";
	if (cmd === "runuser") return !["test", "env"].includes(a[3]) || (a[3] === "env" && !a.includes("jlist") && !a.includes("git"));
	return false;
};
const pm2Calls = (r, user, verb) => r.calls.filter((x) => x[0] === "pm2" && (!user || x[1] === user) && (!verb || x[2] === verb));
// Nothing the script prints names a secret, a crontab line of another job, another client's process,
// the settings file or the key file.
function noLeak(t, label, r) {
	const hits = [...SECRETS, ...TENANTS, SETTINGS, KEY, "other-client"].filter((s) => r.all.includes(s));
	t.ok(`${label}: prints no secret, crontab line, other client's process or settings and key file name (${hits.join(", ") || "none"})`, hits.length === 0, r.all.slice(-1500));
}

// ── the cases ──────────────────────────────────────────────────────────────────────────────────
const CASES = [];
const kase = (name, fn) => { CASES.push({ name, fn }); return name; };

kase("§1 the target is required", async (t, script) => {
	for (const cmd of ["pm2", "crontab", "systemctl", "runuser", "chown", "setfacl", "getfacl", "flock", "systemd-tmpfiles", "curl"]) {
		t.ok(`§1 (the runner) ${cmd} is a stub on the script's PATH, never this machine's own`, fs.existsSync(path.join(BIN, cmd)) && !fs.existsSync(path.join(TOOLS, cmd)));
	}
	const c = makeCase("production");
	for (const [label, argv] of [
		["no arguments", []], ["only the environment", ["production"]], ["only a mode", ["--dry-run"]],
		["an unknown environment", ["prod", "--apply"]], ["an unknown mode", ["production", "--force"]],
		["three arguments", ["production", "--apply", "--rollback"]], ["the mode first", ["--apply", "production"]],
	]) {
		const r = await runScript(c, null, { argv, script });
		const lines = r.err.split("\n").filter(Boolean);
		t.eq(`§1 ${label}: exit 2`, r.code, 2);
		t.ok(`§1 ${label}: says what is needed, then the usage line`, lines.length === 2 && /refused/.test(lines[0]) && /^usage: /.test(lines[1]), r.err);
		t.ok(`§1 ${label}: before any command or output (${r.calls.length} calls)`, r.calls.length === 0 && r.out === "", r.all);
	}
	const asUser = await runScript(c, null, { argv: ["production", "--dry-run"], script, env: { CUTOVER_TEST_ROOT: "" } });
	t.eq("§1 not root, and no test tree: exit 2", asUser.code, 2);
	t.ok("§1 …\"run it as root\", before any command", /run it as root/.test(asUser.err) && asUser.calls.length === 0, asUser.all);
	const rel = await runScript(c, null, { argv: ["production", "--dry-run"], script, env: { CUTOVER_TEST_ROOT: "relative/tree" } });
	t.ok("§1 a relative test tree is refused, exit 2, before any command", rel.code === 2 && rel.calls.length === 0, rel.all);
});

kase("§2 the dry run changes nothing", async (t, script) => {
	for (const envName of ["production", "staging"]) {
		const c = makeCase(envName);
		const before = snap(c.F);
		const r = await dry(c, { script });
		t.eq(`§2 ${envName} --dry-run: exit 0`, r.code, 0);
		const would = r.out.split("\n").filter((l) => l.startsWith("would "));
		const steps = ["1. save", "2. copy root", "3. pm2 stop", "4. modes", "chmod 0750", "chmod -R g-w,o-rwx", "chmod 0600", "chmod -R go-rwx",
			"chmod 0700 backups", "5. chown -hR", "6. as ", "7. write", "systemd-tmpfiles --create", "8. as ", "pm2 save", "pm2 startup", "9. pm2 delete", "last: compare"];
		if (envName === "production") steps.push("10. move the backup line");
		const missing = steps.filter((s) => !would.some((l) => l.includes(s)));
		t.ok(`§2 ${envName}: it lists every action (${missing.join("; ") || "all"})`, missing.length === 0, would.join("\n"));
		t.ok(`§2 ${envName}: it lists every question --apply asks`, (r.out.match(/^ask /gm) || []).length === (envName === "production" ? 5 : 4), r.out);
		t.eq(`§2 ${envName}: the tree is untouched`, diffSnaps(before, snap(c.F)), []);
		const muts = r.calls.filter(MUTATING).map((x) => x.join(" "));
		t.eq(`§2 ${envName}: no command that changes anything ran`, muts, []);
		t.ok(`§2 ${envName}: no saved state and no lock folder`, !fs.existsSync(c.state) && fs.readdirSync(c.F + "/run").length === 0);
		t.ok(`§2 ${envName}: pm2 runs only as root, only to read`, r.calls.filter((x) => x[0] === "pm2").every((x) => x[1] === "root" && x[2] === "jlist"), r.calls.filter((x) => x[0] === "pm2").join("\n"));
		noLeak(t, `§2 ${envName}`, r);
		if (envName === "staging") t.ok("§2 staging: no crontab is read", !r.calls.some((x) => x[0] === "crontab"));
	}
});

// One production cutover and its rollback, beside another client's processes and staging's app.
kase("§3 §4 production: --apply, then --rollback", async (t, script) => {
	const { c, r, before } = await template("production");
	t.eq("§3 production --apply: exit 0", r.code, 0);
	t.ok("§3 …and says it is done", /Done: logistics-app runs as logisx-prd/.test(r.out), r.all);
	t.ok("§8 sockets exactly 7 days old pass, with no question", (r.out.match(/^ok +logisx-prd-(receipts|photos)\.socket: active since .*, 7 days$/gm) || []).length === 2 && !/go-live date in the rule-F/.test(r.out), r.out);
	const chowns = r.calls.filter((x) => x[0] === "chown").map((x) => x.slice(2).join(" "));
	t.eq("§3 one chown, of the whole folder, not following links", chowns, [`-hR -- logisx-prd:logisx-prd ${c.app}`]);
	const firstChmod = r.calls.findIndex((x) => x[0] === "chmod");
	const firstChown = r.calls.findIndex((x) => x[0] === "chown");
	t.ok("§3 every mode is set before the chown, while root still owns the tree", firstChmod >= 0 && firstChown > firstChmod && r.calls.slice(firstChown).every((x) => x[0] !== "chmod" || x.slice(2).join(" ").includes("tmpfiles.d")), r.calls.map((x) => x[0]).join(" "));
	const want = {
		".": "750", "uploads": "750", "uploads/a.pdf": "640", "uploads/b.jpg": "640", "uploads/run-me.sh": "750", "uploads/sub": "750",
		"storage": "700", "storage/s.pdf": "640", "evidence-archive/e.json": "600", ".cache": "750", ".cache/x": "640",
		"app.db": "600", "app.db-wal": "600", "app.db-shm": "600", [SETTINGS]: "600", [KEY]: "600", "app.db.pre-20261001": "600",
		".drift-heal-attempted": "600", "app.db.copy-set": "700", "app.db.copy-set/app.db": "600",
		"backups": "700", "backups/app.db.20261220.gz": "600", "backups/backup.log": "600",
		"backups/trees": "700", "backups/trees/20261220": "700", "backups/trees/20261220/uploads/a.pdf": "640",
		"server.js": "644", "backup.sh": "755", "lib/chromium-drop.sh": "755", "scripts/deploy/remote-deploy.sh": "755",
		"node_modules/.bin/tool": "755", "node_modules/pkg/index.js": "644", [`${SETTINGS}.example`]: "644", "ecosystem.config.js": "644",
	};
	const got = Object.fromEntries(Object.keys(want).map((k) => [k, modeAt(path.join(c.app, k))]));
	t.eq("§3 modes: data without group write or other access, execute bits kept; 0600 for the key file and every untracked top-level file; code as checked out", got, want);
	t.ok("§3 the render account's traverse ACL is still effective on the 0750 folder", /ok +logisx-prd-render can traverse/.test(r.out) && /0750 with the ACL/.test(r.out), r.out);
	t.eq("§3 setfacl never runs: the ACL is 4A's", r.calls.filter((x) => x[0] === "setfacl").length, 0);
	t.eq("§3 Chromium, in the account's own cache", modeAt(c.acctHome + "/.cache/puppeteer/chrome/linux-140.0.7339.0/chrome-linux64/chrome"), "755");
	t.ok("§3 …copied as the account", r.calls.some((x) => x[0] === "runuser" && x[2] === "-u" && x[3] === "logisx-prd" && x[5] === "cp"), r.calls.filter((x) => x[0] === "runuser").join("\n"));
	t.eq("§3 the tmpfiles entry has exactly its two lines", readOr(c.F + "/etc/tmpfiles.d/logisx-deploy-logisx-prd.conf"),
		`# The deploy lock folder for logisx-prd, which only it can write (app-user-cutover.sh).\nd /run/logisx-deploy-${c.uid} 0700 logisx-prd logisx-prd -\n`);
	t.ok("§3 …applied at once, and its folder read back 0700", r.calls.some((x) => x[0] === "systemd-tmpfiles" && x[2] === "--create") && modeAt(c.F + `/run/logisx-deploy-${c.uid}`) === "700");
	const acctLive = liveOf(c.acctHome);
	t.eq("§3 the account's pm2: exactly logistics-app, online", acctLive.map((e) => `${e.name} ${e.status}`), ["logistics-app online"]);
	t.eq("§3 …saved", (dumpOf(c.acctHome) || []).map((e) => e.name), ["logistics-app"]);
	t.ok("§3 …and its boot unit enabled", fs.existsSync(path.join(c.S, "units/pm2-logisx-prd.enabled")));
	// macOS adds __CF_USER_TEXT_ENCODING to every process it starts; nothing else may appear.
	const envLog = readOr(path.join(c.S, "pm2-env.log"), "").split("\n").filter(Boolean).map((l) => l.split("\x1f"))
		.map(([u, verb, names]) => [u, verb, names.split(",").filter((n) => !n.startsWith("__CF_")).join(",")]);
	const acctStart = envLog.find((x) => x[0] === "logisx-prd" && x[1] === "start");
	t.eq("§3 the account's pm2 starts with only HOME, LANG and PATH", acctStart && acctStart[2], "HOME,LANG,PATH");
	t.ok("§3 …so the caller's environment never reaches it", envLog.every((x) => !x[2].includes("CALLER_SENTINEL") && !x[2].includes("CUTOVER_TEST")), envLog.join("\n"));
	const rootLive = liveOf(c.F + "/root");
	t.eq("§3 root's pm2 no longer lists logistics-app, and the others are as they were",
		rootLive.map((e) => `${e.pm_id} ${e.name} ${e.status}`), [`0 ${TENANTS[0]} online`, `1 ${TENANTS[1]} online`, "2 logisx-staging online", `4 ${TENANTS[2]} errored`]);
	t.eq("§3 root's saved list too", (dumpOf(c.F + "/root") || []).map((e) => e.name), [TENANTS[0], TENANTS[1], "logisx-staging", TENANTS[2]]);
	t.eq("§3 root's crontab: only our line is gone, the rest byte for byte", readOr(path.join(c.S, "crontabs/root")), ROOT_CRON.replace(`${OUR_CRON}\n`, ""));
	t.eq("§3 the account's crontab: our line", readOr(path.join(c.S, "crontabs/logisx-prd")), `${OUR_CRON}\n`);
	t.ok("§3 the move prints line numbers and counts only", /line 4 of 6 in root's crontab is now in logisx-prd's; root's other 5 lines/.test(r.out), r.out);
	const names = r.calls.filter((x) => ["pm2", "runuser", "systemctl"].includes(x[0])).map((x) => x.join(" "));
	t.ok("§3 production never names staging's definition file or app", names.every((s) => !s.includes("ecosystem.staging.config.js") && !/\blogisx-staging\b/.test(s)), names.join("\n"));
	t.ok("§3 pm2 is never given all, or a pm2 id", r.calls.filter((x) => x[0] === "pm2").every((x) => !x.slice(2).some((a) => a === "all" || /^[0-9]+$/.test(a))));
	t.ok("§9 --apply holds root's deploy lock (the fd form, as root)", r.calls.some((x) => x[0] === "flock" && x[1] === "-" && x[2] === "-n" && x[3] === "9"), r.calls.filter((x) => x[0] === "flock").join("\n"));
	t.ok("§9 …says which lock it holds, at the deploy scripts' path", r.out.includes(`holding root's deploy lock /run/logisx-deploy-${c.uid}/logisx-deploy_var_www_logistics-app.lock`), r.out);
	t.ok("§9 …and to flip VPS_USER only with no Deploy or drift run in flight", /next +Arvin: set production's VPS_USER to logisx-prd, with its key, only while no Deploy or drift run is in flight/.test(r.out), r.out);
	t.ok("§9 the lock file carries this run's holder note", /by=app-user-cutover\.sh/.test(readOr(c.F + `/run/logisx-deploy-${c.uid}/logisx-deploy_var_www_logistics-app.lock`, "")));
	t.ok("§3 the saved state records each step", /apply\.10 /.test(readOr(c.state + "/progress", "")) && /apply\.done /.test(readOr(c.state + "/progress", "")));
	noLeak(t, "§3 production --apply", r);

	const rc = copyCase(c);
	const r2 = await rollback(rc, { script });
	t.eq("§4 production --rollback: exit 0", r2.code, 0);
	t.ok("§4 …and says it is done", /Done: logistics-app runs under root again/.test(r2.out), r2.all);
	t.eq("§4 every mode is back as it was, and nothing in the tree is new or gone", diffSnaps(before, snap(rc.app), { modesOnly: true }), []);
	t.ok("§4 owners: chown -hR root:root, not following links", r2.calls.some((x) => x[0] === "chown" && x.slice(2).join(" ") === `-hR -- root:root ${rc.app}`), r2.calls.filter((x) => x[0] === "chown").join("\n"));
	t.eq("§4 root's crontab is back byte for byte, our line at its old place", readOr(path.join(rc.S, "crontabs/root")), ROOT_CRON);
	t.eq("§4 the account's crontab is empty again", readOr(path.join(rc.S, "crontabs/logisx-prd")), "");
	t.ok("§4 the tmpfiles entry is removed", !fs.existsSync(rc.F + "/etc/tmpfiles.d/logisx-deploy-logisx-prd.conf"));
	t.eq("§4 the account's pm2 no longer lists logistics-app", named(liveOf(rc.acctHome), "logistics-app").length, 0);
	t.ok("§4 its boot unit is disabled", !fs.existsSync(path.join(rc.S, "units/pm2-logisx-prd.enabled")));
	const rl = liveOf(rc.F + "/root");
	t.eq("§4 root's pm2 lists logistics-app once, online, beside the others unchanged",
		rl.map((e) => `${e.name} ${e.status}`), [`${TENANTS[0]} online`, `${TENANTS[1]} online`, "logisx-staging online", `${TENANTS[2]} errored`, "logistics-app online"]);
	t.ok("§4 root's list is saved with it", named(dumpOf(rc.F + "/root") || [], "logistics-app").length === 1);
	t.ok("§4 the state moves aside", !fs.existsSync(rc.state) && fs.readdirSync(rc.F + "/root/logisx-cutover").some((n) => /^production\.rolled-back\.[0-9]{8}T[0-9]{6}Z$/.test(n)));
	const order = r2.calls.map((x) => (x[0] === "crontab" && !x.includes("-l") ? "cron" : x[0] === "pm2" && x[1] === "root" && x[2] === "start" ? "start" : "")).filter(Boolean);
	t.ok("§4 the backup line goes back before root's pm2 starts", order.indexOf("cron") >= 0 && order.indexOf("cron") < order.indexOf("start"), order.join(" "));
	const acctLock = r2.calls.find((x) => x[0] === "flock" && x[2] === "-n" && x[3] && x[3].endsWith("logisx-deploy_var_www_logistics-app.lock"));
	t.ok("§9 --rollback takes the account's lock as the account (runuser, then flock on its file)", !!acctLock && acctLock[1] === "logisx-prd" &&
		r2.calls.some((x) => x[0] === "runuser" && x[3] === "logisx-prd" && x[5] === "flock"), r2.calls.filter((x) => ["flock", "runuser"].includes(x[0])).join("\n"));
	t.ok("§9 …and root's, as root", r2.calls.some((x) => x[0] === "flock" && x[1] === "-" && x.slice(2).join(" ") === "-n 9"));
	t.ok("§10 the tree check reads git as the account", r2.calls.some((x) => x[0] === "runuser" && x[3] === "logisx-prd" && x.includes("git") && x.includes("status")), r2.calls.filter((x) => x[0] === "runuser").join("\n"));
	t.ok("§4 VPS_USER back to root, with nothing in flight", /next +Arvin: set production's VPS_USER back to root \(root's key is still authorized\), only while no Deploy or drift run is in flight/.test(r2.out), r2.out);
	noLeak(t, "§4 production --rollback", r2);
});

kase("§3 §4 staging: --apply, then --rollback beside production's app", async (t, script) => {
	const { c, r } = await template("staging");
	t.eq("§3 staging --apply: exit 0", r.code, 0);
	const names = r.calls.filter((x) => ["pm2", "runuser", "systemctl"].includes(x[0])).map((x) => x.join(" "));
	t.ok("§3 staging never names ecosystem.config.js or logistics-app", names.every((s) => !/\becosystem\.config\.js\b/.test(s) && !/\blogistics-app\b/.test(s)), names.join("\n"));
	t.ok("§3 staging starts from its own definition file", pm2Calls(r, "logisx-stg", "start").some((x) => x[3] === `${c.app}/ecosystem.staging.config.js`));
	t.eq("§3 staging's old settings copy is made 0600 too", modeAt(path.join(c.app, `${SETTINGS}.bak-20260901`)), "600");
	t.eq("§3 staging has no crontab move", r.calls.filter((x) => x[0] === "crontab").length, 0);
	t.eq("§3 the account's pm2: exactly logisx-staging", liveOf(c.acctHome).map((e) => e.name), ["logisx-staging"]);
	noLeak(t, "§3 staging --apply", r);
	const rc = copyCase(c);
	const r2 = await rollback(rc, { script });
	t.eq("§5 staging --rollback beside production's app and other clients' processes: exit 0", r2.code, 0);
	t.eq("§5 …root lists logisx-staging once more, the rest as it was",
		liveOf(rc.F + "/root").map((e) => `${e.pm_id} ${e.name}`), [`0 ${TENANTS[0]}`, `1 ${TENANTS[1]}`, "2 logistics-app", `4 ${TENANTS[2]}`, "5 logisx-staging"]);
	noLeak(t, "§5 staging --rollback", r2);
});

const setScenario = (c, users, extra = {}) => {
	const s = JSON.parse(readOr(path.join(c.S, "pm2.json")));
	fs.writeFileSync(path.join(c.S, "pm2.json"), JSON.stringify({ ...s, ...extra, users: { ...(s.users || {}), ...users } }));
};

kase("§5 the rollback passes with pm2's out-of-date notice ahead of its list", async (t, script) => {
	const c = await cutOver("production");
	setScenario(c, {}, { notice: true });
	const r2 = await rollback(c, { script });
	t.eq("§5 with pm2's notice ahead of jlist's JSON, beside other clients' processes and staging's app, the rollback runs to its end", r2.code, 0);
	t.eq("§5 …logistics-app listed once under root", named(liveOf(c.F + "/root"), "logistics-app").length, 1);
});

kase("§5 statuses, pids and uptimes changing between the reads don't count", async (t, script) => {
	const c = await cutOver("production");
	setScenario(c, { root: { afterStart: [{ drift: true }] } });
	const r2 = await rollback(c, { script });
	t.ok("§5 the start's compare passes and root's list is saved", /ok +logistics-app runs under root again, answers on :3000, and root's list is saved/.test(r2.out), r2.all);
	t.eq("§7 the saved-list compare then stops and asks (exit 3)", r2.code, 3);
	noLeak(t, "§5 statuses changed", r2);
});

const REFUSALS = [
	["our app missing after the start", { startNoop: true }],
	["our app listed twice", { afterStart: [{ addOurs: true }] }],
	["another app added", { afterStart: [{ add: "intruder-sentinel" }] }],
	["an entry from before the start gone", { afterStart: [{ removeId: 0 }] }],
	["an entry from before the start under another id", { afterStart: [{ reId: 1 }] }],
	["another name under an id from before the start", { afterStart: [{ renameId: 1, to: "renamed-sentinel" }] }],
];
for (const [label, scen] of REFUSALS) {
	kase(`§5 the rollback refuses ${label}`, async (t, script) => {
		const c = await cutOver("production");
		setScenario(c, { root: scen });
		const dumpBefore = readOr(c.F + "/root/.pm2/dump.pm2");
		const r2 = await rollback(c, { script });
		t.eq(`§5 ${label}: stops to ask (exit 3)`, r2.code, 3);
		t.ok(`§5 ${label}: before pm2 save`, pm2Calls(r2, "root", "save").length === 0 && readOr(c.F + "/root/.pm2/dump.pm2") === dumpBefore, pm2Calls(r2, "root").join("\n"));
		t.ok(`§5 ${label}: the backup line is already back in root's crontab`, readOr(path.join(c.S, "crontabs/root")) === ROOT_CRON);
		const leaked = ["intruder-sentinel", "renamed-sentinel"].filter((s) => r2.all.includes(s));
		t.ok(`§5 ${label}: names no other process (${leaked.join(", ") || "none"})`, leaked.length === 0);
		noLeak(t, `§5 ${label}`, r2);
	});
}

kase("§5 our app already in root's list before the rollback", async (t, script) => {
	const c = await cutOver("production");
	const live = JSON.parse(readOr(c.F + "/root/.pm2/stub-live.json"));
	live.list.push({ pm_id: 9, name: "logistics-app", status: "online", pid: 900, pm_uptime: 1 });
	fs.writeFileSync(c.F + "/root/.pm2/stub-live.json", JSON.stringify(live));
	const before = snap(c.F);
	const r2 = await rollback(c, { script });
	t.eq("§5 already listed: refused (exit 1)", r2.code, 1);
	t.ok("§5 …it says already listed, with its pm2 id and status", /already listed in root's pm2 \(pm2 id 9, online\)/.test(r2.out), r2.out);
	t.eq("§5 …before any change", diffSnaps(before, snap(c.F)).filter((d) => !/stub-live|\.lock$/.test(d)), []);
	t.eq("§5 …no command that changes anything ran", r2.calls.filter(MUTATING).filter((x) => !(x[0] === "flock")).map((x) => x.join(" ")), []);
});

for (const [label, scen] of [["lists nothing", { list: [] }], ["can't be read", { unreadable: true }]]) {
	kase(`§5 root's list ${label} before the rollback`, async (t, script) => {
		const c = await cutOver("production");
		if (scen.list) fs.writeFileSync(c.F + "/root/.pm2/stub-live.json", JSON.stringify({ next: 9, list: [] }));
		else setScenario(c, { root: { unreadable: true } });
		const r2 = await rollback(c, { script });
		t.eq(`§5 root's list ${label}: refused (exit 1)`, r2.code, 1);
		t.ok(`§5 …before any change: no start, no save`, pm2Calls(r2, "root").every((x) => x[2] === "jlist") && r2.calls.every((x) => x[0] !== "chown"), r2.calls.join("\n"));
	});
}

kase("§7 a changed tenant entry in root's saved list: the rollback still finishes, then stops and asks", async (t, script) => {
	const c = await cutOver("production");
	const live = JSON.parse(readOr(c.F + "/root/.pm2/stub-live.json"));
	for (const e of live.list) if (e.name === TENANTS[2]) e.status = "online";
	fs.writeFileSync(c.F + "/root/.pm2/stub-live.json", JSON.stringify(live));
	const r2 = await rollback(c, { script });
	t.eq("§7 stops to ask (exit 3)", r2.code, 3);
	t.ok("§7 …after the backup line moved back", readOr(path.join(c.S, "crontabs/root")) === ROOT_CRON);
	t.ok("§7 …and the tmpfiles entry went", !fs.existsSync(c.F + "/etc/tmpfiles.d/logisx-deploy-logisx-prd.conf"));
	t.ok("§7 …by count and pm2 id only", /unmatched by name and status: 1 before, 1 after \(pm2 ids 4\)/.test(r2.out), r2.out);
	noLeak(t, "§7 rollback compare", r2);
});

kase("§7 --apply: a changed tenant entry in root's saved list stops and asks; the copy is never put back", async (t, script) => {
	const c = makeCase("production", { tenantCharlie: "online" });
	const dump = JSON.parse(readOr(c.F + "/root/.pm2/dump.pm2"));
	const live = JSON.parse(readOr(c.F + "/root/.pm2/stub-live.json"));
	for (const e of live.list) if (e.name === TENANTS[2]) e.status = "errored";
	fs.writeFileSync(c.F + "/root/.pm2/stub-live.json", JSON.stringify(live));
	const r = await apply(c, { script });
	t.eq("§7 stops to ask (exit 3)", r.code, 3);
	t.ok("§7 …after the cutover and the backup line's move", readOr(path.join(c.S, "crontabs/logisx-prd")) === `${OUR_CRON}\n` && /apply\.done/.test(readOr(c.state + "/progress", "")));
	t.ok("§7 …the copy from step 2 is kept, and never put back", JSON.stringify(JSON.parse(readOr(c.state + "/root-dump.before"))) === JSON.stringify(dump) &&
		named(dumpOf(c.F + "/root"), "logistics-app").length === 0, readOr(c.F + "/root/.pm2/dump.pm2"));
	t.ok("§7 …by count and pm2 id only", /unmatched by name and status: 1 before, 1 after \(pm2 ids 4\)/.test(r.out), r.out);
	noLeak(t, "§7 apply compare", r);
});

for (const [label, scen, extra = {}] of [
	["no app after the start", { startNoop: true }, { rollback: true }],
	["two apps after the start", { afterStart: [{ add: "second-app" }] }],
	["one app, under another name", { afterStart: [{ removeStarted: true }, { add: "other-name" }] }],
	["a second app listed before the start", { strayAfterJlist: 1 }, { daemonUp: true, rollback: true }],
	["no answer on its port", { answerAfterStart: "000" }, { rootAnswers: true, rollback: true, env: true }],
]) {
	kase(`§6 step 8 refuses ${label}`, async (t, script) => {
		const users = { "logisx-prd": scen, ...(extra.rootAnswers ? { root: { answerAfterStart: "200" } } : {}) };
		const c = makeCase("production", { pm2: { users } });
		if (extra.daemonUp) {
			mkdir(c.acctHome + "/.pm2");
			fs.writeFileSync(c.acctHome + "/.pm2/pm2.pid", String(process.pid));
			fs.writeFileSync(c.acctHome + "/.pm2/stub-live.json", JSON.stringify({ next: 0, list: [] }));
		}
		const r = await apply(c, { script });
		t.eq(`§6 ${label}: stops to ask (exit 3)`, r.code, 3);
		t.ok(`§6 ${label}: before the account's pm2 save`, pm2Calls(r, "logisx-prd", "save").length === 0 && dumpOf(c.acctHome) === null, pm2Calls(r, "logisx-prd").join("\n"));
		t.ok(`§6 ${label}: root's pm2 still lists logistics-app`, named(liveOf(c.F + "/root"), "logistics-app").length === 1);
		t.ok(`§6 ${label}: no backup line moved`, readOr(path.join(c.S, "crontabs/root")) === ROOT_CRON);
		noLeak(t, `§6 ${label}`, r);
		if (extra.env) {
			// macOS adds __CF_USER_TEXT_ENCODING to every process it starts; nothing else may appear.
			const starts = readOr(path.join(c.S, "pm2-env.log"), "").split("\n").filter(Boolean).map((l) => l.split("\x1f"))
				.filter((x) => x[0] === "logisx-prd" && x[1] === "start").map((x) => x[2].split(",").filter((n) => !n.startsWith("__CF_")).join(","));
			t.eq("§3 the account's pm2 starts with only HOME, LANG and PATH: nothing of the caller's shell", starts, ["HOME,LANG,PATH"]);
		}
		if (!extra.rollback) return;
		const r2 = await rollback(c, { script });
		t.eq(`§11 after it, --rollback finishes (exit 0)`, r2.code, 0);
		t.ok(`§11 …logistics-app is back online under root, under its old pm2 id, with no save`, liveOf(c.F + "/root").some((e) => e.pm_id === 3 && e.name === "logistics-app" && e.status === "online") &&
			pm2Calls(r2, "root", "save").length === 0 && pm2Calls(r2, "root", "start").length === 0, pm2Calls(r2, "root").join("\n"));
		t.eq(`§11 …the account's pm2 lists no logistics-app`, named(liveOf(c.acctHome), "logistics-app").length, 0);
		t.eq(`§11 …root's crontab as it was`, readOr(path.join(c.S, "crontabs/root")), ROOT_CRON);
	});
}

kase("§8 sockets at 6 days: the rule-F go-live date decides", async (t, script) => {
	const c = makeCase("production", { socketDays: [6, 13] });
	const d = await dry(c, { script });
	t.ok("§8 the dry run asks for the rule-F date for the 6-day socket only", /^ask +logisx-prd-receipts\.socket: active since .*, 6 day\(s\), under 7/m.test(d.out) && /^ok +logisx-prd-photos\.socket: active since .*, 13 days$/m.test(d.out), d.out);
	const young = await apply(c, { script, answers: [daysAgo(3), daysAgo(3), daysAgo(6), "yes", "yes", "yes"] });
	t.eq("§8 6 days, and a rule-F date 6 days ago: refused (exit 1)", young.code, 1);
	t.ok("§8 …before any change", !fs.existsSync(c.state) && young.calls.filter(MUTATING).length === 0, young.calls.filter(MUTATING).join("\n"));
	const old = await apply(c, { script, answers: [daysAgo(3), daysAgo(3), daysAgo(8), "no"] });
	t.ok("§8 6 days, and a rule-F date 8 days ago: that check passes", /ok +the sockets went live on .* by the rule-F report, 8 days ago/.test(old.out) && old.code === 1, old.out);
});

for (const [label, line] of [["fork", "RENDER_CHILD_TRANSPORT=fork"], ["missing (fork is the default)", "# no transport line"], ["socket, then fork later in the file", "RENDER_CHILD_TRANSPORT=socket\nRENDER_CHILD_TRANSPORT=fork"]]) {
	kase(`§8 the transport ${label} is refused`, async (t, script) => {
		const c = makeCase("production", { transportLine: line });
		const d = await dry(c, { script });
		t.ok(`§8 transport ${label}: the dry run fails it (exit 1)`, d.code === 1 && /FAIL +the render transport setting isn't socket/.test(d.out), d.out);
		noLeak(t, `§8 transport ${label}`, d);
		if (!label.startsWith("fork")) return;
		const r = await apply(c, { script });
		t.eq(`§8 transport ${label}: --apply refuses (exit 1)`, r.code, 1);
		t.ok(`§8 …before any change`, !fs.existsSync(c.state) && r.calls.filter(MUTATING).length === 0);
	});
}
kase("§8 quoted and exported socket lines read as socket", async (t, script) => {
	for (const line of ["export RENDER_CHILD_TRANSPORT=\"socket\"", "RENDER_CHILD_TRANSPORT = 'socket'  # the render services"]) {
		const c = makeCase("staging", { transportLine: line });
		const d = await dry(c, { script });
		t.ok(`§8 ${line}: socket`, /ok +the render transport setting is socket/.test(d.out), d.out);
	}
});

kase("§8 the test and drill dates: 7 days pass, 8 don't", async (t, script) => {
	const c = makeCase("production");
	const seven = await apply(c, { script, answers: [daysAgo(7), daysAgo(7), "no"] });
	t.ok("§8 a test and a drill 7 days ago pass", /ok +The date of the last monthly restore test: .*, 7 day\(s\) ago/.test(seven.out) && /ok +The date of the real-path drill: .*, 7 day\(s\) ago/.test(seven.out) && seven.code === 1, seven.out);
	for (const [label, answers, want] of [
		["a test 8 days ago", [daysAgo(8)], /8 days ago, more than 7/], ["a drill 8 days ago", [daysAgo(1), daysAgo(8)], /drill: .* 8 days ago, more than 7/],
		["a test in the future", [daysAgo(-1)], /is in the future/], ["no date", ["soon"], /"soon" isn't a date/],
		["the transport not confirmed", [daysAgo(1), daysAgo(1), "no"], /must have stayed socket/],
		["shared credentials answered other than yes", [daysAgo(1), daysAgo(1), "yes", "yes", "y"], /must share no credential/],
	]) {
		const r = await apply(c, { script, answers });
		t.ok(`§8 ${label}: refused (exit 1), before any change`, r.code === 1 && want.test(r.out) && !fs.existsSync(c.state) && r.calls.filter(MUTATING).length === 0, r.out);
	}
});

kase("§8 the account must be able to run our node and pm2: checked with test -x, never by starting pm2", async (t, script) => {
	const c = makeCase("production");
	fs.writeFileSync(path.join(c.S, "deny-logisx-prd"), `${c.F}/opt/node22/bin/node\n`);
	const d = await dry(c, { script });
	t.ok("§8 the account can't execute /opt/node22/bin/node: the dry run fails it", d.code === 1 && /FAIL +logisx-prd can't execute \/opt\/node22\/bin\/node/.test(d.out), d.out);
	t.ok("§8 …it asked with test -x as the account, and never ran pm2 as the account", d.calls.some((x) => x[0] === "runuser" && x[3] === "logisx-prd" && x[5] === "test" && x[6] === "-x") &&
		!d.calls.some((x) => x[0] === "pm2" && x[1] === "logisx-prd"), d.calls.filter((x) => ["runuser", "pm2"].includes(x[0])).join("\n"));
});

kase("§8 a missing ACL is refused before any chmod", async (t, script) => {
	const c = makeCase("production", { noAcl: true });
	const before = snap(c.F);
	const r = await apply(c, { script });
	t.eq("§8 no ACL: refused (exit 1)", r.code, 1);
	t.ok("§8 …saying why", /FAIL +logisx-prd-render's traverse ACL isn't on \/var\/www\/logistics-app/.test(r.out), r.out);
	t.eq("§8 …and no chmod ran", r.calls.filter((x) => x[0] === "chmod").length, 0);
	t.eq("§8 …the tree is untouched", diffSnaps(before, snap(c.F)), []);
});

kase("§8 old settings copies stop production, not staging", async (t, script) => {
	const c = makeCase("production", { settingsCopy: true });
	const d = await dry(c, { script });
	t.ok("§8 production with an old settings copy: the dry run fails it", d.code === 1 && /FAIL +old copies of the settings file remain \(1 at the top level, 0 in backups\/\)/.test(d.out), d.out);
	const s = makeCase("staging");
	const ds = await dry(s, { script });
	t.ok("§8 staging with one: a note, and the dry run passes", ds.code === 0 && /1 old copies of the settings file: made 0600/.test(ds.out), ds.out);
	noLeak(t, "§8 settings copies", d);
});

kase("§8 the backup hour, the crontab and the stopgap's trees", async (t, script) => {
	const late = makeCase("production", { now: Date.UTC(2026, 11, 21, 1, 30, 0) / 1000 });
	const r = await apply(late, { script });
	t.ok("§8 01:30: refused (exit 1), within an hour of the nightly backup", r.code === 1 && /within an hour of 02:00/.test(r.out) && !fs.existsSync(late.state), r.out);
	for (const [label, cron, want] of [
		["no backup line", ROOT_CRON.replace(`${OUR_CRON}\n`, ""), /holds 0\)/],
		["two backup lines", `${ROOT_CRON}30 2 * * * cd /var/www/logistics-app && ./backup.sh\n`, /holds 2, lines 4 7\)/],
	]) {
		const c = makeCase("production", { rootCron: cron });
		const x = await apply(c, { script });
		t.ok(`§8 ${label} in root's crontab: refused (exit 1) before any change`, x.code === 1 && want.test(x.out) && x.calls.filter(MUTATING).length === 0, x.out);
		noLeak(t, `§8 ${label}`, x);
	}
	const has = makeCase("production");
	fs.writeFileSync(path.join(has.S, "crontabs/logisx-prd"), `${OUR_CRON}\n`);
	const y = await dry(has, { script });
	t.ok("§8 the account's crontab already holding the line: the dry run fails it", y.code === 1 && /logisx-prd's crontab already holds a backup line/.test(y.out), y.out);
	const trees = makeCase("production", { treesNightMode: 0o755 });
	const z = await dry(trees, { script });
	t.ok("§8 a stopgap night folder that isn't 0700: the dry run fails it", z.code === 1 && /backups\/trees: 1 of its folders aren't 0700/.test(z.out), z.out);
	const ok = makeCase("production");
	const w = await dry(ok, { script });
	t.ok("§8 the dry run counts the stopgap's files", /backups\/trees: its folders are 0700 \(1 files\)/.test(w.out), w.out);
});

kase("§9 locks: held elsewhere, and the folders' modes", async (t, script) => {
	const c = makeCase("production");
	fs.writeFileSync(path.join(c.S, "held-fd"), "");
	const r = await apply(c, { script });
	t.eq("§9 root's lock held by a deploy: --apply refuses (exit 1)", r.code, 1);
	t.ok("§9 …before any change", !fs.existsSync(c.state) && r.calls.filter(MUTATING).every((x) => x[0] === "flock"), r.calls.filter(MUTATING).join("\n"));
	const wide = makeCase("production");
	mkdir(wide.F + `/run/logisx-deploy-${wide.uid}`, 0o755);
	const r2 = await apply(wide, { script });
	t.ok("§9 root's lock folder at 0755: refused (exit 1), exactly 0700 wanted", r2.code === 1 && /mode exactly 0700/.test(r2.out) && !fs.existsSync(wide.state), r2.out);
	const tf = makeCase("production");
	fs.writeFileSync(path.join(tf.S, "tmpfiles-mode"), "0755");
	const r3 = await apply(tf, { script });
	t.eq("§9 the account's lock folder read back 0755 after systemd-tmpfiles: stops to ask (exit 3)", r3.code, 3);
	t.ok("§9 …saying the redeploy would refuse it, and before the account's pm2 starts", /isn't a folder logisx-prd owns, mode exactly 0700/.test(r3.out) && pm2Calls(r3, "logisx-prd", "start").length === 0, r3.out);
	const rb = await cutOver("production");
	fs.writeFileSync(path.join(rb.S, "held-file"), "");
	const before = snap(rb.app);
	const r4 = await rollback(rb, { script });
	t.eq("§9 the account's lock held by a deploy as the account: --rollback refuses (exit 1)", r4.code, 1);
	t.ok("§9 …before any change", diffSnaps(before, snap(rb.app)).length === 0 && named(liveOf(rb.acctHome), "logistics-app").length === 1, r4.out);
});

kase("§10 the tree check before a rollback", async (t, script) => {
	for (const [label, change, want] of [
		["a tracked file changed", (c) => fs.appendFileSync(path.join(c.app, "server.js"), "// changed\n"), /1 tracked file\(s\) changed/],
		["HEAD off the verified deploy", (c) => git(c.app, c.dir, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "--allow-empty", "-m", "unverified"), /isn't the verified deploy/],
		["git's config changed", (c) => fs.appendFileSync(path.join(c.app, ".git/config"), "[core]\n\tfsmonitor = made-up\n"), /git's config differ/],
		["a hook added", (c) => put(c.app, ".git/hooks/post-checkout", "#!/bin/sh\n", 0o755), /git's 1 hook file\(s\) differ/],
	]) {
		const c = await cutOver("production");
		change(c);
		const before = snap(c.app);
		const no = await rollback(c, { script, answers: ["no"] });
		t.ok(`§10 ${label}: it says so, and refuses unless told to go on (exit 1)`, no.code === 1 && want.test(no.out), no.out);
		t.ok(`§10 ${label}: …before any change`, diffSnaps(before, snap(c.app)).length === 0 && named(liveOf(c.acctHome), "logistics-app").length === 1 &&
			readOr(path.join(c.S, "crontabs/logisx-prd")) === `${OUR_CRON}\n`);
		if (label === "a tracked file changed") {
			const yes = await rollback(c, { script, answers: ["ROLLBACK ANYWAY"] });
			t.eq("§10 told to go on: the rollback runs to its end", yes.code, 0);
		}
	}
});

kase("§12 the sibling PRs' names", async (t) => {
	// The names this script uses, each checked against its own PR's file once that is in this tree.
	t.ok("§12 the deploy lock: one folder per account, /run/logisx-deploy-<uid>, one file per app folder (B10's layout)",
		SOURCE.includes("lock_name() { printf 'logisx-deploy%s.lock' \"$(printf '%s' \"$1\" | tr -c 'A-Za-z0-9._-' '_')\"; }") &&
		SOURCE.includes("ROOT_LOCK_DIR_BOX=/run/logisx-deploy-$ROOT_UID") && SOURCE.includes("ACCT_LOCK_DIR_BOX=/run/logisx-deploy-$ACCT_UID"));
	t.ok("§12 each environment's definition file: ecosystem.config.js for production, ecosystem.staging.config.js for staging (B11)",
		/APP_BOX=\/var\/www\/logistics-app\n\tNAME=logistics-app\n\tDEF=ecosystem\.config\.js\n/.test(SOURCE) &&
		/APP_BOX=\/var\/www\/logisx-staging\n\tNAME=logisx-staging\n\tDEF=ecosystem\.staging\.config\.js\n/.test(SOURCE));
	t.ok("§12 each environment's two socket units (B9)", SOURCE.includes('SOCKETS="logisx-prd-receipts.socket logisx-prd-photos.socket"') &&
		SOURCE.includes('SOCKETS="logisx-stg-receipts.socket logisx-stg-photos.socket"'));
	t.ok("§12 the account's Puppeteer cache: /home/<account>/.cache/puppeteer (B8's profile)", SOURCE.includes("ACCT_CACHE_BOX=$ACCT_HOME_BOX/.cache/puppeteer") &&
		SOURCE.includes("ACCT_HOME_BOX=/home/$ACCT"));
	const deploy = readOr(path.join(ROOT, "scripts/deploy/remote-deploy.sh"), "");
	if (/LOCK_DIR=\$\{DEPLOY_LOCK_DIR:-\/run\/logisx-deploy-\$LOCK_UID\}/.test(deploy)) {
		t.ok("§12 B10: the deploy scripts' lock file is the one this script takes",
			deploy.includes("LOCK_FILE=\"$LOCK_DIR/logisx-deploy$(printf '%s' \"$DIR\" | tr -c 'A-Za-z0-9._-' '_').lock\""));
	} else {
		t.note("§12 B10's per-account lock folder isn't in this tree yet: the script follows its layout (/run/logisx-deploy-<uid>)");
	}
	if (fs.existsSync(STAGING_DEF_REPO)) {
		delete require.cache[require.resolve(STAGING_DEF_REPO)];
		const apps = (require(STAGING_DEF_REPO).apps || []).map((a) => a.name);
		t.eq("§12 B11: staging's definition file declares exactly logisx-staging", apps, ["logisx-staging"]);
	} else {
		t.note("§12 B11's ecosystem.staging.config.js isn't in this tree yet: a made-up one stands in");
	}
	const others = fs.readdirSync(ROOT).filter((n) => /^ecosystem\..+\.config\.js$/.test(n) && n !== "ecosystem.staging.config.js");
	t.eq("§12 no other environment definition file this script would not know", others, []);
	const unitsDir = path.join(ROOT, "scripts/deploy/systemd");
	if (fs.existsSync(unitsDir)) {
		const units = fs.readdirSync(unitsDir);
		const ours = [...ENVS.production.sockets, ...ENVS.staging.sockets];
		t.ok(`§12 B9: every socket unit this script reads is in ${path.relative(ROOT, unitsDir)}`, ours.every((u) => units.includes(u)), units.join(", "));
	} else {
		t.note("§12 B9's socket units aren't in this tree yet: the script reads the names proposed for them");
	}
	const profile = path.join(ROOT, "scripts/deploy/apparmor/logisx-chromium");
	if (fs.existsSync(profile)) {
		const p = fs.readFileSync(profile, "utf8");
		t.ok("§12 B8: the AppArmor profile covers both accounts' Puppeteer caches", ["home/logisx-prd/.cache/puppeteer", "home/logisx-stg/.cache/puppeteer"].every((s) => p.includes(s)));
	} else {
		t.note("§12 B8's AppArmor profile isn't in this tree yet: the copy goes to /home/<account>/.cache/puppeteer");
	}
});

kase("§13 source pins", async (t) => {
	const code = SOURCE.split("\n").filter((l) => !/^\s*#/.test(l));
	const pm2Lines = code.filter((l) => /"\$PM2_BIN" ("\$@"|startup)/.test(l));
	t.eq("§13 pm2 runs only through the two cleared-environment wrappers and the startup line", pm2Lines.length, 3);
	t.ok("§13 …each one under env -i with HOME, PATH and LANG only", pm2Lines.every((l) => /env -i HOME="\$(ROOT|ACCT)_HOME" PATH="\$PATH" LANG=C\.UTF-8 "\$PM2_BIN"/.test(l)), pm2Lines.join("\n"));
	t.ok("§13 …and each one through x, which closes the lock descriptors 7, 8 and 9, so no daemon pm2 starts keeps a lock",
		pm2Lines.every((l) => /\bx (env -i|runuser -u)/.test(l)) && code.some((l) => l.trim() === 'x() { "$@" 7<&- 8>&- 9>&-; }') &&
		code.some((l) => l.trim() === 'as_acct() { x runuser -u "$ACCT" -- "$@"; }'), pm2Lines.join("\n"));
	const execs = code.filter((l) => /\bexec [0-9]+[<>]/.test(l)).map((l) => l.trim());
	t.ok("§13 the only descriptors opened: root's lock as root (fd 9), the account's lock through runuser as the account (fd 8)",
		execs.length === 2 && execs[0].startsWith("exec 9<>\"$ROOT_LOCK_FILE\" ") && execs[1].startsWith("exec 8> >(runuser -u \"$ACCT\" -- flock -n \"$ACCT_LOCK_FILE\" "), execs.join("\n"));
	t.ok("§13 no pkill, killall, pm2 all, pm2 kill or a pm2 id", !/\bpkill\b|\bkillall\b|"\$PM2_BIN" .*\ball\b|pm2_(root|acct) (kill|.* all\b)/.test(code.join("\n")));
	t.ok("§13 the box's own paths only, never a host address", !/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(code.join("\n").replace(/127\.0\.0\.1/g, "")));
});

// ── mutants ────────────────────────────────────────────────────────────────────────────────────
// [what is broken, the case that must turn red, the script's text, the text put in its place]
const MUTANTS = [
	["§14 H1: \"exactly one app\" put back on root's daemon", "§5 the rollback passes with pm2's out-of-date notice ahead of its list",
		'v=$(js root-diff "$STATE/rollback-root.before" "$TMPD/rb.root.after" "$NAME")',
		'if one_app "$TMPD/rb.root.after" >/dev/null; then v=ok; else v=differs; fi'],
	["§14 statuses compared around the rollback's start", "§5 statuses, pids and uptimes changing between the reads don't count",
		"const key = (r) => r.id + \"\\t\" + r.name;", "const key = (r) => r.id + \"\\t\" + r.name + \"\\t\" + r.status;"],
	["§14 step 8 built on a before-and-after diff", "§6 step 8 refuses a second app listed before the start",
		'v=$(one_app "$TMPD/acct.after") || acct_ok=0',
		'v=$(js root-diff "$TMPD/acct.before" "$TMPD/acct.after" "$NAME"); [ "${v%%$\'\\n\'*}" = ok ] || acct_ok=0'],
	["§14 the backup line moved back after root's pm2 starts", "§5 the rollback refuses our app missing after the start",
		"\trb3_cron\n\trb4_tmpfiles\n\trb5_root\n", "\trb5_root\n\trb3_cron\n\trb4_tmpfiles\n"],
	["§14 the account's pm2 inherits the caller's environment", "§6 step 8 refuses no answer on its port",
		'pm2_acct() { x runuser -u "$ACCT" -- env -i HOME="$ACCT_HOME" PATH="$PATH" LANG=C.UTF-8 "$PM2_BIN" "$@"; }',
		'pm2_acct() { x runuser -u "$ACCT" -- env HOME="$ACCT_HOME" PATH="$PATH" LANG=C.UTF-8 "$PM2_BIN" "$@"; }'],
	["§14 no ACL check", "§8 a missing ACL is refused before any chmod",
		"\tif acl_ok; then okay \"$RENDER can traverse", "\tif true; then okay \"$RENDER can traverse"],
	["§14 a lock folder that is 0755 accepted", "§9 locks: held elsewhere, and the folders' modes",
		'lock_dir_ok() { real_dir "$1" && [ "$(uid_of "$1")" = "$2" ] && [ "$(mode_of "$1")" = 700 ]; }',
		'lock_dir_ok() { real_dir "$1" && [ "$(uid_of "$1")" = "$2" ]; }'],
	["§14 an empty root list accepted before the rollback's start", "§5 root's list lists nothing before the rollback",
		"\telif [ \"${sum%% *}\" = 0 ]; then\n\t\tneed \"root's pm2 lists nothing: a save would drop every other saved entry\"\n",
		"\telif false; then\n\t\t:\n"],
];

// ── running it ─────────────────────────────────────────────────────────────────────────────────
async function pool(items, n, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
	}));
	return out;
}
async function runCase(k, script) {
	const t = tally();
	try { await k.fn(t, script); } catch (e) { t.ok(`${k.name}: threw ${e && e.message}`, false, e && e.stack); }
	return t.lines;
}

(async () => {
	const concurrency = Math.max(2, Math.min(6, os.cpus().length - 1));
	const started = Date.now();
	try {
		if (!SOURCE) {
			console.log(`  FAIL  ${SCRIPT_REL} is missing`);
			failures.push("script missing");
		}
		const results = await pool(CASES, concurrency, (k) => runCase(k, SCRIPT));
		CASES.forEach((k, i) => { console.log(k.name); report(results[i]); });
		console.log("§14 mutants");
		const mutantResults = await pool(MUTANTS, concurrency, async ([label, caseName, from, to]) => {
			const n = SOURCE.split(from).length - 1;
			if (n !== 1) return { label, ok: false, detail: `the mutant's source line is there ${n} time(s), not once: update the mutant` };
			const k = CASES.find((x) => x.name === caseName || x.name.includes(caseName));
			if (!k) return { label, ok: false, detail: `no case named ${caseName}` };
			const file = path.join(TMP, `mutant-${label.replace(/[^a-z0-9]+/gi, "-")}.sh`);
			fs.writeFileSync(file, SOURCE.replace(from, to), { mode: 0o755 });
			const lines = await runCase(k, file);
			const red = lines.filter((l) => !l.ok).length;
			return { label: `${label}: turns "${k.name}" red (${red} failing)`, ok: red > 0, detail: "the case still passes with the mutant" };
		});
		report(mutantResults);
	} finally {
		fs.rmSync(TMP, { recursive: true, force: true });
	}
	console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	if (failures.length) process.exit(1);
})().catch((e) => {
	fs.rmSync(TMP, { recursive: true, force: true });
	console.error(e && e.stack);
	process.exit(1);
});
