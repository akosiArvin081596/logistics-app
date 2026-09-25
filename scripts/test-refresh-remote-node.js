#!/usr/bin/env node
/**
 * What the two refresh scripts run on the VPS: which Node runs refresh-env.js
 * there, which Node staging's npm install runs under, and which arguments the
 * remote refresh-env.js receives.
 *
 * WHY IT EXISTS. On 2026-09-25 refresh-local.sh's remote sanitize died with
 * "NODE_MODULE_VERSION 127 ... requires 115": it had run refresh-env.js under
 * another tenant's system Node 20. Both refresh scripts still had the two holes
 * backup.sh was fixed for in #366 (test-deploy-scripts.js §9 pins its probe):
 *   §1 BY NAME, NOT POSITION. `pm2 jlist` is one line of JSON, and a greedy sed
 *      took the LAST process's interpreter. The pick is the interpreter of the
 *      process whose node_modules gets loaded (logistics-app for
 *      refresh-local.sh, logisx-staging for refresh-staging.sh) wherever it
 *      sits: past a last process whose DIFFERENT Node could open the database
 *      too, and past the notice pm2 can print ahead of the JSON.
 *   §2 THE PROBE OPENS A DATABASE. require('better-sqlite3') passes under the
 *      wrong Node, because the binding loads lazily. A pm2 interpreter that can
 *      require the module but not open a database is passed over.
 *   §3 FALLBACK, AND FAIL-CLOSED. pm2 absent, or not listing the process:
 *      /opt/node22. PATH's node when it is the only one that can open a
 *      database. When none can, refresh-env.js never runs: nothing is
 *      transferred and no remote temp dir is left. (refresh-staging.sh reaches
 *      its pick only after §6 has built the module for pm2's own Node, and
 *      refuses before installing when pm2 cannot say which Node that is.)
 *   §4 SOURCE PINS. The pick-node block is byte-identical in both scripts, its
 *      jlist parse is remote-deploy.sh's, no line parses exec_interpreter with
 *      sed or probes with a bare require, and refresh-local.sh empties
 *      PICK_NODE before reading the block and refuses unless it arrived.
 *   §5 MUTANTS. The old greedy sed, a bare-require probe, a jlist parse that
 *      cannot see past pm2's notice, and dropping PATH's node each turn this
 *      runner red.
 *   §6 STAGING INSTALLS WITH pm2's NODE. refresh-staging.sh ran a bare
 *      `npm install`, the box's system Node 20, in a checkout pm2 runs under
 *      /opt/node22, so an install that fetched or rebuilt better-sqlite3 left a
 *      module staging could not load. It now installs as remote-deploy.sh
 *      does: npm under the interpreter pm2 runs logisx-staging with (read by
 *      name; pm2's bare `node` means PATH's), a probe that opens a database,
 *      `npm rebuild better-sqlite3` when it cannot, and a refusal (nothing
 *      built, no database, no restart) when it still cannot or when pm2 cannot
 *      say which Node that is. The stub npm acts as real npm does under the
 *      Node that runs it: `rebuild` builds for that Node's ABI, and so does an
 *      `install` that fetches the module. Four mutants, one per step.
 *   §7 ARGUMENTS REACH THE REMOTE refresh-env.js EXACTLY AS TYPED.
 *      refresh-local.sh hands its database options to refresh-env.js three
 *      times (the preflight, the sanitize inside the ssh command, which the
 *      VPS's shell parses again, and the install), and all three receive the
 *      same argument vector. Anything that is not one of those options is
 *      refused before any command runs, and never repeated. The quoting is
 *      proven on its own as well: in a copy with the refusal turned off,
 *      arguments holding spaces, quotes, a newline and shell syntax still reach
 *      the VPS as exactly those arguments. Mutants: the preflight without the
 *      options, and the old unquoted join. (The refusal's own mutant is W5 in
 *      test-refresh-sign-in.js, with a password typed as a bare word.)
 *
 * The REAL scripts run under bash against a sandbox standing in for the VPS:
 * their /var/www and /opt/node22 are rebased onto it (asserted to apply), each
 * interpreter is a wrapper around this Node that carries an ABI, a stub
 * better-sqlite3 opens a database only under the ABI it was built for, and the
 * ssh stub runs every command "on the VPS" under bash with that machine's PATH
 * and nothing from this one. Stub git/npm/pm2/scp/sleep and refresh-env.js; no
 * network, no VPS, no real app.db, and no real npm anywhere on a sandbox PATH
 * (asserted before anything runs).
 *
 * Run: node scripts/test-refresh-remote-node.js [--keep]
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL_SH = path.join(__dirname, "refresh-local.sh");
const STAGING_SH = path.join(__dirname, "refresh-staging.sh");
const DEPLOY_SH = path.join(__dirname, "deploy", "remote-deploy.sh");
const KEEP = process.argv.includes("--keep");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);

// ───────────────────────────────────────────────────────────────── sandbox
// Resolved: macOS keeps tmpdir behind /var -> /private/var, and
// refresh-staging.sh compares `pwd` against its STAGING_DIR.
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-refresh-node-")));
const VPS = path.join(T, "vps");
const LAPTOP = path.join(T, "laptop");
const LOGS = path.join(T, "logs");
const ARGV_LOG = path.join(LOGS, "refresh-env-argv.log");   // every stub refresh-env.js run, laptop and VPS
const mk = (...parts) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };
const writeExec = (p, body) => { mk(path.dirname(p)); fs.writeFileSync(p, body, { mode: 0o755 }); };
const readIf = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
mk(LOGS);

// The interpreters on the sandbox VPS: this Node under other names, each
// carrying the ABI (NODE_MODULE_VERSION) of the Node it stands for. Each sits
// in a directory that holds it and nothing else — no npm (see section 0).
const NODES = {
	system: { path: `${VPS}/usr/bin/node`, abi: "115" },                          // apt's Node 20, the other tenants'
	opt22: { path: `${VPS}/opt/node22/bin/node`, abi: "127" },                    // the fallback
	prodPin: { path: `${VPS}/opt/node-v22.23.2-linux-x64/bin/node`, abi: "127" }, // pm2 names prod's install directly
	stagePin: { path: `${VPS}/opt/node-v22.24.0-linux-x64/bin/node`, abi: "127" },// ...and staging canaries a patch release
	tenant: { path: `${VPS}/opt/tenant-node/bin/node`, abi: "127" },              // another client's own Node 22
};
for (const [id, n] of Object.entries(NODES)) {
	writeExec(n.path, `#!/bin/bash\nexport STUB_NODE_ID=${id} STUB_NODE_ABI=${n.abi}\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
}
const idOf = (p) => (Object.entries(NODES).find(([, n]) => n.path === p) || ["(none)"])[0];

// A better-sqlite3 built for one ABI. Like the real module, require() never
// touches the binding; only opening a database does.
function sqliteStubSource(m, builtFor) {
	return `"use strict";
module.exports = class Database {
	constructor() {
		const abi = process.env.STUB_NODE_ABI || "(this machine's)";
		if (abi !== "${builtFor}") {
			throw new Error("The module '${m}/build/Release/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION ${builtFor}. This version of Node.js requires NODE_MODULE_VERSION " + abi + ".");
		}
	}
	close() {}
};
`;
}
function stubSqlite(dir, builtFor) {
	const m = mk(dir, "node_modules", "better-sqlite3");
	fs.writeFileSync(path.join(m, "index.js"), sqliteStubSource(m, builtFor));
}
// What a native build does, for the stub npm below: rebuild DIR's
// better-sqlite3 for one ABI (the ABI of the Node npm runs under).
const REBUILD_JS = path.join(T, "stub-build-sqlite.js");
fs.writeFileSync(REBUILD_JS, `"use strict";
const fs = require("fs");
const path = require("path");
${sqliteStubSource.toString()}
const [dir, abi] = process.argv.slice(2);
const m = path.join(dir, "node_modules", "better-sqlite3");
fs.mkdirSync(m, { recursive: true });
fs.writeFileSync(path.join(m, "index.js"), sqliteStubSource(m, abi));
`);

// refresh-env.js as the wrappers see it: says which node ran it in which mode,
// records its whole argv (the log path is baked in, because on the VPS it runs
// under `env -i`), and in the two modes that open SQLite it opens a database,
// as the real one does.
const STUB_REFRESH_ENV = `"use strict";
const fs = require("fs");
const a = process.argv.slice(2);
const mode = a.includes("--check-env-only") ? "check-env-only" : a.includes("--sanitize-only") ? "sanitize-only"
	: a.includes("--verify") ? "verify" : a.includes("--from-sanitized") ? "install-sanitized" : "install";
const node = process.env.STUB_NODE_ID || "laptop";
console.log("[stub-refresh-env] mode=" + mode + " node=" + node);
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ mode, node, argv: a }) + "\\n");
if (mode === "sanitize-only" || mode === "install") {
	try { new (require("better-sqlite3"))(":memory:").close(); }
	catch (e) { console.error("[refresh] REFUSING: " + e.message); process.exit(1); }
	fs.writeFileSync(a[a.indexOf(mode === "sanitize-only" ? "--emit" : "--to") + 1], "stub " + mode + " output\\n", { mode: 0o600 });
}
`;

// /var/www and /opt/node22 are the VPS's own paths; everything else stays.
const rebase = (text) => text.split("/var/www/").join(`${VPS}/var/www/`).split("/opt/node22/").join(`${VPS}/opt/node22/`);

// The VPS: production's node_modules and nightly snapshot, a staging checkout,
// /var/tmp, and its commands.
const PROD_DIR = mk(VPS, "var", "www", "logistics-app");
stubSqlite(PROD_DIR, "127");
fs.writeFileSync(path.join(mk(PROD_DIR, "backups"), "app.db.20260925_020001.gz"), "stub snapshot\n");
const STAGING_DIR = mk(VPS, "var", "www", "logisx-staging");
stubSqlite(STAGING_DIR, "127");
fs.writeFileSync(path.join(mk(STAGING_DIR, "scripts"), "refresh-env.js"), STUB_REFRESH_ENV);
fs.writeFileSync(path.join(STAGING_DIR, ".env"), "PORT=3932\nSPREADSHEET_ID=sandbox-staging-sheet\n");
const REMOTE_TMP_ROOT = mk(VPS, "var", "tmp");
const VPS_BIN = mk(VPS, "bin");
const PM2_STATE = mk(VPS, "pm2-state");
const VPS_PATH = `${VPS_BIN}:${VPS}/usr/bin:/usr/bin:/bin`;
// jlist prints the scenario's notice (if any), then its process list as ONE
// line of JSON, as pm2 does. Every call is logged; everything else is a no-op.
writeExec(path.join(VPS_BIN, "pm2"), `#!/bin/bash
echo "$*" >> '${LOGS}/pm2.log'
if [ "$1" = jlist ]; then cat '${PM2_STATE}/notice' 2>/dev/null; cat '${PM2_STATE}/jlist.json'; fi
exit 0
`);
const GIT_STUB = `#!/bin/bash
case "$1 $2" in
	"rev-parse --abbrev-ref") echo feature ;;
	"rev-parse --short") echo abc1234 ;;
esac
exit 0
`;
writeExec(path.join(VPS_BIN, "git"), GIT_STUB);
// npm as real npm behaves under the Node that runs it: npm is a node script,
// so it runs under PATH's first node, whose id and ABI this stub asks for and
// logs with every call. `rebuild` builds better-sqlite3 for that ABI (unless
// the scenario's rebuild cannot help), and so does an `install` when the
// scenario's install fetches the module (a version bump).
writeExec(path.join(VPS_BIN, "npm"), `#!/bin/bash
who=$(node -e 'process.stdout.write((process.env.STUB_NODE_ID||"none")+" "+(process.env.STUB_NODE_ABI||"none"))' 2>/dev/null) || who="none none"
id=\${who% *}; abi=\${who#* }
echo "$1 node=$id" >> '${LOGS}/npm.log'
case "$1" in
	--version) echo 10.9.8 ;;
	rebuild) [ -e '${PM2_STATE}/rebuild-broken' ] || node '${REBUILD_JS}' "$PWD" "$abi" ;;
	install) if [ -e '${PM2_STATE}/install-fetches' ]; then node '${REBUILD_JS}' "$PWD" "$abi"; fi ;;
esac
exit 0
`);
writeExec(path.join(VPS_BIN, "sleep"), "#!/bin/bash\nexit 0\n");
// GNU stat -c %s (refresh-local.sh's disk preflight), on macOS too.
writeExec(path.join(VPS_BIN, "stat"), `#!/bin/bash
if [ "$1" = -c ] && [ "$2" = %s ]; then wc -c < "$3" | tr -d ' '; exit 0; fi
exec /usr/bin/stat "$@"
`);

// The laptop: a checkout holding the rebased refresh-local.sh, and the
// commands it reaches the VPS with. git and npm log, so §7 can tell that a
// refused run started nothing.
const APP = mk(LAPTOP, "app");
fs.writeFileSync(path.join(mk(APP, "scripts"), "refresh-env.js"), STUB_REFRESH_ENV);
fs.writeFileSync(path.join(APP, ".env"), "PORT=3931\nSPREADSHEET_ID=sandbox-local-sheet\n");
const LAPTOP_BIN = mk(LAPTOP, "bin");
writeExec(path.join(LAPTOP_BIN, "git"), GIT_STUB.replace("#!/bin/bash\n", `#!/bin/bash\necho "git $*" >> '${LOGS}/laptop.log'\n`));
writeExec(path.join(LAPTOP_BIN, "npm"), `#!/bin/bash\necho "npm $*" >> '${LOGS}/laptop.log'\nexit 0\n`);
// ssh: drop the options and the host, then run the command on the VPS, under
// bash with the VPS's PATH and HOME and nothing else from this machine.
writeExec(path.join(LAPTOP_BIN, "ssh"), `#!/bin/bash
while [ $# -gt 0 ]; do
	case "$1" in -o|-i|-p|-l|-F) shift 2 ;; -*) shift ;; *) break ;; esac
done
shift
printf '%s\\n----\\n' "$*" >> '${LOGS}/ssh.log'
exec /usr/bin/env -i PATH='${VPS_PATH}' HOME='${mk(VPS, "root")}' LC_ALL=C /bin/bash -c "$*"
`);
// scp: HOST:PATH is PATH on the VPS, i.e. a path in this sandbox.
writeExec(path.join(LAPTOP_BIN, "scp"), `#!/bin/bash
while [ $# -gt 0 ]; do
	case "$1" in -o|-i|-P|-F) shift 2 ;; -*) shift ;; *) break ;; esac
done
src=$1; dst=$2
case "$src" in *:*) src=\${src#*:} ;; esac
case "$dst" in *:*) dst=\${dst#*:} ;; esac
echo "$1 -> $2" >> '${LOGS}/scp.log'
exec cp "$src" "$dst"
`);

// ─────────────────────────────────────────────────────────────── scenarios
const PROD = "logistics-app";
const STAGE = "logisx-staging";
const proc = (name, interp, i) => ({
	pid: 4100 + i, name, pm_id: i, monit: { memory: 94371840, cpu: 0 },
	pm2_env: { name, status: "online", exec_interpreter: interp, pm_exec_path: `/var/www/${name}/server.js`, pm_uptime: 1758760000000 + i, restart_time: 0, env: { NODE_ENV: "production" } },
});
// The shared box: 24 processes, mostly other clients' on the system Node, ours
// in the middle and another client's LAST.
function box({ prod, stage, last = NODES.system.path, listed = true }) {
	const procs = Array.from({ length: 24 }, (_, i) => proc(`tenant-${String.fromCharCode(97 + i)}-api`, NODES.system.path, i));
	if (listed) { procs[3] = proc(STAGE, stage, 3); procs[6] = proc(PROD, prod, 6); }
	procs[23] = proc("tenant-last-web", last, 23);
	return procs;
}
const NOTICE = ">>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\nIn memory PM2 version: 5.3.0\nLocal PM2 version: 6.0.8\n";
const P = NODES;
// local:   the Node refresh-local.sh's remote sanitize must run under (null: it must refuse).
// staging: the Node refresh-staging.sh must install, build the module for AND
//          refresh under, which is always the one pm2 runs staging with (§6);
//          "unreadable": pm2 cannot say which, so it must refuse before installing.
// stagingWhat: what the same box means for refresh-staging.sh, where it differs.
const SCENARIOS = {
	incident: {
		what: "the shared box as on 2026-09-25: both LogisX processes on /opt/node22, the system Node last",
		procs: box({ prod: P.opt22.path, stage: P.opt22.path }), local: "opt22", staging: "opt22",
	},
	byName: {
		what: "§1 by NAME: each process on its own install, and the last process's Node 22 could open the database too",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path, last: P.tenant.path }), local: "prodPin", staging: "stagePin",
	},
	notice: {
		what: "§1 through the out-of-date notice pm2 prints ahead of jlist's JSON",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), notice: true, local: "prodPin", staging: "stagePin",
	},
	probeOpens: {
		what: "§2 pm2 runs the process on a Node that can require the module but not open a database",
		stagingWhat: "§6 pm2 runs staging on a Node its module was not built for: rebuilt for that Node, and refreshed under it",
		procs: box({ prod: P.system.path, stage: P.system.path }), local: "opt22", staging: "system",
	},
	notListed: {
		what: "§3 pm2 does not list the process: /opt/node22",
		stagingWhat: "§6 pm2 does not list staging: refused before the install, nothing built or written",
		procs: box({ listed: false }), local: "opt22", staging: "unreadable",
	},
	noPm2: {
		what: "§3 no pm2 on PATH: /opt/node22, and set -e does not abort the pick",
		stagingWhat: "§6 no pm2 on PATH: refused before the install (the refusal, not a set -e abort)",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), pm2: false, local: "opt22", staging: "unreadable",
	},
	pathOnly: {
		what: "§3 only PATH's node can open a database (the module was rebuilt under it): PATH's node",
		stagingWhat: "§6 the module was built for PATH's node, not pm2's: rebuilt for pm2's, and refreshed under it",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), moduleAbi: "115", local: "system", staging: "stagePin",
	},
	noneCanOpen: {
		what: "§3 no candidate can open a database (pm2's is the system Node, no /opt/node22)",
		stagingWhat: "§6 pm2 runs staging on the system Node, and there is no /opt/node22: built for, and refreshed under, the system Node",
		procs: box({ prod: P.system.path, stage: P.system.path }), opt22: false, local: null, staging: "system",
	},
};
// refresh-staging.sh only (§6).
const STAGING_ONLY = {
	installFetches: {
		what: "§6 an install that fetches better-sqlite3 (a version bump) builds it for pm2's Node, not the system Node 20",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), installFetches: true, staging: "stagePin",
	},
	bareNode: {
		what: "§6 pm2's own default interpreter, a bare `node`, means PATH's node",
		procs: box({ prod: P.prodPin.path, stage: "node" }), staging: "system",
	},
	rebuildBroken: {
		what: "§6 a rebuild that does not help: refused with --restart given, and nothing built, written or restarted",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), moduleAbi: "115", rebuildBroken: true,
		staging: "stillBroken", args: ["--yes", "--restart"],
	},
};

// Present or moved aside, never deleted: every scenario sets the whole box.
function setPresent(p, present) {
	const aside = `${p}.absent`;
	if (present && fs.existsSync(aside)) fs.renameSync(aside, p);
	if (!present && fs.existsSync(p)) fs.renameSync(p, aside);
}
function setBox(s) {
	stubSqlite(PROD_DIR, s.moduleAbi || "127");
	stubSqlite(STAGING_DIR, s.moduleAbi || "127");
	fs.writeFileSync(path.join(PM2_STATE, "jlist.json"), `${JSON.stringify(s.procs)}\n`);
	if (s.notice) fs.writeFileSync(path.join(PM2_STATE, "notice"), NOTICE);
	else fs.rmSync(path.join(PM2_STATE, "notice"), { force: true });
	for (const [flag, on] of [["install-fetches", s.installFetches], ["rebuild-broken", s.rebuildBroken]]) {
		if (on) fs.writeFileSync(path.join(PM2_STATE, flag), "");
		else fs.rmSync(path.join(PM2_STATE, flag), { force: true });
	}
	setPresent(path.join(VPS_BIN, "pm2"), s.pm2 !== false);
	setPresent(P.opt22.path, s.opt22 !== false);
	for (const f of fs.readdirSync(LOGS)) fs.rmSync(path.join(LOGS, f), { force: true });
	fs.rmSync(path.join(APP, "app.db"), { force: true });
	fs.rmSync(path.join(STAGING_DIR, "app.db"), { force: true });
}
const stubRuns = (out) => [...out.matchAll(/^\[stub-refresh-env\] mode=(\S+) node=(\S+)$/gm)].map((m) => ({ mode: m[1], node: m[2] }));
const tail = (out) => out.split("\n").filter(Boolean).slice(-4).join(" | ");
const argvLog = () => readIf(ARGV_LOG).split("\n").filter(Boolean).map((l) => JSON.parse(l));

function runLocal(src, args = []) {
	fs.writeFileSync(path.join(APP, "scripts", "refresh-local.sh"), src, { mode: 0o755 });
	const r = spawnSync("/bin/bash", [path.join(APP, "scripts", "refresh-local.sh"), ...args], {
		cwd: APP, encoding: "utf8", timeout: 30000,
		env: {
			PATH: `${LAPTOP_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: mk(LAPTOP, "home"), TMPDIR: mk(LAPTOP, "tmp"), LC_ALL: "C",
			VPS_HOST: "stub@vps.invalid", VPS_KEY: "/dev/null", REMOTE_TMP_ROOT,
		},
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	const runs = stubRuns(out);
	const ran = (mode) => runs.filter((x) => x.mode === mode).map((x) => x.node);
	return {
		code: r.status, out,
		sanitizedWith: ran("sanitize-only"),
		reported: (out.match(/^\[refresh\] remote node: (\S+) \(/m) || [])[1] || null,
		installed: ran("install-sanitized").length > 0,
		downloaded: readIf(path.join(LOGS, "scp.log")).split("\n").some((l) => /^stub@vps\.invalid:/.test(l)),
		leftover: fs.readdirSync(REMOTE_TMP_ROOT).filter((f) => f.startsWith("logisx-sanitize.")),
		sshLog: readIf(path.join(LOGS, "ssh.log")),
		laptop: readIf(path.join(LOGS, "laptop.log")),
		argv: argvLog(),
	};
}
function runStaging(src, args = ["--yes"]) {
	const script = path.join(STAGING_DIR, "scripts", "refresh-staging.sh");
	fs.writeFileSync(script, src, { mode: 0o755 });
	const r = spawnSync("/bin/bash", [script, ...args], {
		cwd: STAGING_DIR, encoding: "utf8", timeout: 30000,
		env: { PATH: VPS_PATH, HOME: mk(VPS, "root"), LC_ALL: "C" },
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	const npm = readIf(path.join(LOGS, "npm.log")).split("\n").filter(Boolean);
	const npmUnder = (cmd) => npm.filter((l) => l.startsWith(`${cmd} node=`)).map((l) => l.slice(`${cmd} node=`.length));
	return {
		code: r.status, out,
		installedWith: stubRuns(out).filter((x) => x.mode === "install").map((x) => x.node),
		reported: (out.match(/^\[refresh-staging\] node: (\S+) \(/m) || [])[1] || null,
		wrote: fs.existsSync(path.join(STAGING_DIR, "app.db")),
		npmInstalls: npmUnder("install"),
		npmRebuilds: npmUnder("rebuild"),
		npmBuilds: npmUnder("run").length,
		restarted: /^restart /m.test(readIf(path.join(LOGS, "pm2.log"))),
		// Can the process staging runs as open a database with the module left behind?
		opens: (id) => fs.existsSync(P[id].path)
			&& spawnSync(P[id].path, ["-e", "new (require('better-sqlite3'))(':memory:').close()"], { cwd: STAGING_DIR }).status === 0,
	};
}

// One scenario through refresh-local.sh; [ok, detail] per assertion.
function localVerdict(s, x) {
	if (s.local === null) {
		return [[x.code !== 0 && /REFUSING: no node on the VPS can open a better-sqlite3 database/.test(x.out)
			&& /remote sanitize failed\. NOTHING was transferred/.test(x.out)
			&& x.sanitizedWith.length === 0 && !x.downloaded && !x.installed && x.leftover.length === 0,
		`exit ${x.code}, sanitize ran under [${x.sanitizedWith}], downloaded ${x.downloaded}, installed ${x.installed}, left behind [${x.leftover}]`]];
	}
	const want = P[s.local].path;
	return [[x.code === 0 && x.sanitizedWith.length === 1 && x.sanitizedWith[0] === s.local && x.reported === want
		&& x.downloaded && x.installed && x.leftover.length === 0,
	`exit ${x.code}, sanitize ran under [${x.sanitizedWith}], reported ${idOf(x.reported)}, want ${s.local}${x.code === 0 ? "" : ` — ${tail(x.out)}`}`]];
}
function stagingVerdict(s, x) {
	const seen = `npm install under [${x.npmInstalls}], rebuild under [${x.npmRebuilds}], ${x.npmBuilds} build(s), refresh-env.js under [${x.installedWith}], app.db written ${x.wrote}`;
	if (s.staging === "unreadable") {
		return [[x.code !== 0 && /cannot read the interpreter pm2 runs logisx-staging with, so refusing to install with a guess/.test(x.out)
			&& x.npmInstalls.length === 0 && x.npmBuilds === 0 && x.installedWith.length === 0 && !x.wrote,
		`exit ${x.code}, ${seen}`]];
	}
	if (s.staging === "stillBroken") {
		return [[x.code !== 0 && /still cannot open a database under .* after the rebuild/.test(x.out)
			&& x.npmRebuilds.length === 1 && x.npmBuilds === 0 && x.installedWith.length === 0 && !x.wrote && !x.restarted,
		`exit ${x.code}, ${seen}, restarted ${x.restarted}`]];
	}
	const want = P[s.staging].path;
	return [[x.code === 0 && x.npmInstalls.length === 1 && x.npmInstalls[0] === s.staging
		&& x.npmRebuilds.every((n) => n === s.staging) && x.npmBuilds === 1
		&& x.installedWith.length === 1 && x.installedWith[0] === s.staging && x.reported === want && x.wrote && x.opens(s.staging),
	`exit ${x.code}, ${seen}, reported ${idOf(x.reported)}, the module opens under ${s.staging}: ${x.opens(s.staging)}; want all under ${s.staging}${x.code === 0 ? "" : ` — ${tail(x.out)}`}`]];
}

// §7: the operator's options as each of the three refresh-env.js calls got
// them, i.e. its argv past the fixed arguments the wrapper puts first.
const FIXED = { "check-env-only": 3, "sanitize-only": 5, "install-sanitized": 6 };
function optionVectors(x) {
	return Object.fromEntries(Object.entries(FIXED).map(([mode, n]) => {
		const runs = x.argv.filter((r) => r.mode === mode);
		return [mode, runs.length === 1 ? runs[0].argv.slice(n) : `${runs.length} runs`];
	}));
}
function sameVectors(x, typed) {
	const v = optionVectors(x);
	const ok = x.code === 0 && Object.values(v).every((got) => JSON.stringify(got) === JSON.stringify(typed))
		&& x.argv.some((r) => r.mode === "sanitize-only" && r.node !== "laptop");
	return [ok, ok ? "" : `exit ${x.code}; typed ${JSON.stringify(typed)}; got ${JSON.stringify(v)}${x.code === 0 ? "" : ` — ${tail(x.out)}`}`];
}
// A copy of a script with one piece of its text replaced, asserted to match
// EXACTLY ONCE, so a rename in the original fails loudly instead of silently
// testing the unmodified source.
function once(text, from, to) {
	const hits = text.split(from).length - 1;
	return hits === 1 ? text.replace(from, () => to) : null;
}

// ─────────────────────────────────────────────────────────────── the run
const ORIG = { local: fs.readFileSync(LOCAL_SH, "utf8"), staging: fs.readFileSync(STAGING_SH, "utf8") };
const SRC = { local: rebase(ORIG.local), staging: rebase(ORIG.staging) };
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l));

try {
	console.log(`refresh remote node — sandbox ${T}`);

	section("0. The sandbox stands in for the VPS (so nothing below is vacuous)");
	check("refresh-local.sh's production paths are rebased onto the sandbox",
		SRC.local.includes(`PROD_APP_DIR="${PROD_DIR}"`) && SRC.local.includes(`PROD_BACKUPS="${PROD_DIR}/backups"`));
	check("refresh-staging.sh's paths are rebased onto the sandbox",
		SRC.staging.includes(`STAGING_DIR="${STAGING_DIR}"`) && SRC.staging.includes(`PROD_BACKUPS="${PROD_DIR}/backups"`));
	check("…and so is /opt/node22, in each script's code and not only its comments",
		[SRC.local, SRC.staging].every((t) => code(t).some((l) => l.includes(P.opt22.path))));
	{
		const r = spawnSync(P.system.path, ["-e", "new (require('better-sqlite3'))(':memory:')"], { cwd: PROD_DIR, encoding: "utf8" });
		const q = spawnSync(P.system.path, ["-e", "require('better-sqlite3')"], { cwd: PROD_DIR, encoding: "utf8" });
		const o = spawnSync(P.opt22.path, ["-e", "new (require('better-sqlite3'))(':memory:').close()"], { cwd: PROD_DIR, encoding: "utf8" });
		check("the stub module reproduces the trap: the system Node require()s it but cannot open a database; /opt/node22 can",
			q.status === 0 && r.status !== 0 && /NODE_MODULE_VERSION 127\. This version of Node\.js requires NODE_MODULE_VERSION 115/.test(r.stderr) && o.status === 0,
			`require ${q.status}, open ${r.status}, /opt/node22 open ${o.status}`);
	}
	{
		// refresh-staging.sh puts the directory of pm2's interpreter first on
		// PATH for its install. A real npm there would run a genuine install in
		// this sandbox, so from every interpreter's directory the only npm on
		// reach must be the stub — or nothing below runs.
		const stray = [VPS_PATH, ...Object.values(NODES).map((n) => `${path.dirname(n.path)}:${VPS_PATH}`)]
			.map((p) => [p, (spawnSync("/bin/bash", ["-c", "command -v npm"], { encoding: "utf8", env: { PATH: p } }).stdout || "").trim()])
			.filter(([, npm]) => npm !== path.join(VPS_BIN, "npm"));
		check("the only npm the sandbox VPS can reach, from any interpreter's directory, is the stub", stray.length === 0,
			stray.map(([p, npm]) => `${npm || "(none)"} via ${p.split(":")[0]}`).join("; "));
		if (stray.length) throw new Error("a real npm is reachable from the sandbox VPS — refusing to run the scripts");
	}

	section("1-3. The real scripts, one scenario at a time");
	for (const s of Object.values(SCENARIOS)) {
		setBox(s);
		if (s.pm2 === false) {
			// "No pm2" must mean command-not-found, never a real pm2 this machine happens to have.
			const found = spawnSync("/bin/bash", ["-c", "command -v pm2"], { encoding: "utf8", env: { PATH: VPS_PATH } });
			check("the no-pm2 scenario has no pm2 to reach on the sandbox VPS's PATH", found.status !== 0, (found.stdout || "").trim());
			if (found.status === 0) continue;
		}
		for (const [ok, detail] of localVerdict(s, runLocal(SRC.local))) check(`refresh-local.sh — ${s.what}`, ok, detail);
		setBox(s);
		for (const [ok, detail] of stagingVerdict(s, runStaging(SRC.staging))) check(`refresh-staging.sh — ${s.stagingWhat || s.what}`, ok, detail);
	}

	section("4. Source pins");
	const block = (text) => {
		const a = text.indexOf("# >>> pick-node");
		const b = text.indexOf("# <<< pick-node");
		return a >= 0 && b > a && text.indexOf("# >>> pick-node", a + 1) < 0 ? text.slice(a, b) : null;
	};
	const bl = block(ORIG.local);
	const bs = block(ORIG.staging);
	check("the pick-node block appears once in each script and is byte-identical in both", !!bl && bl === bs,
		!bl || !bs ? "a marker is missing or repeated" : bl === bs ? "" : "the copies differ");
	const DEPLOY = fs.readFileSync(DEPLOY_SH, "utf8");
	const jlistParse = (text) => {
		const m = /node -e '([^']*exec_interpreter[^']*)'/.exec(text || "");
		return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n") : null;
	};
	const deployParse = jlistParse(DEPLOY);
	check("its jlist parse is remote-deploy.sh's, token for token", !!deployParse && jlistParse(bl) === deployParse,
		deployParse ? "" : "no exec_interpreter parse found in remote-deploy.sh");
	for (const [name, text] of [["refresh-local.sh", ORIG.local], ["refresh-staging.sh", ORIG.staging]]) {
		const lines = code(text);
		const sed = lines.filter((l) => /exec_interpreter/.test(l) && /\bsed\b/.test(l));
		check(`${name}: no line parses exec_interpreter with sed`, sed.length === 0, sed.join(" | ").slice(0, 120));
		const probes = lines.filter((l) => /-e\s+\\?["'][^\n]*require\(\s*\\?["']better-sqlite3\\?["']\s*\)/.test(l));
		const opens = probes.filter((l) => /new \(require\(\s*\\?["']better-sqlite3\\?["']\s*\)\)\(\s*\\?["']:memory:\\?["']\s*\)\.close\(\)/.test(l));
		check(`${name}: every better-sqlite3 probe opens a database, not just require()s it`, probes.length > 0 && opens.length === probes.length,
			`${opens.length} of ${probes.length}`);
	}
	{
		// A heredoc that fails leaves `read` unrun: only this keeps an inherited
		// PICK_NODE from being sent to the VPS. The failure itself cannot be
		// staged portably (bash 5.1+ feeds a small heredoc through a pipe).
		const lines = code(ORIG.local);
		const reset = lines.findIndex((l) => l.trim() === "PICK_NODE=''");
		const read = lines.findIndex((l) => l.includes("read -r -d '' PICK_NODE <<'EOF_PICK_NODE'"));
		const guard = lines.findIndex((l) => l.includes('case "$PICK_NODE" in'));
		check("refresh-local.sh empties PICK_NODE before reading the block and refuses unless it arrived",
			reset >= 0 && read > reset && guard > read && /pick_node\(\) \{/.test(lines[guard + 1] || ""),
			`reset ${reset}, read ${read}, guard ${guard}`);
	}
	{
		// §6's install is remote-deploy.sh's: the same probe text, before and
		// after the rebuild, and npm only between pm2's Node going first on PATH
		// and PATH being put back.
		const PROBE = `node -e "new (require('better-sqlite3'))(':memory:').close()"`;
		const n = (text, s) => text.split(s).length - 1;
		check("refresh-staging.sh probes with remote-deploy.sh's exact probe, before and after its rebuild",
			n(DEPLOY, PROBE) === 2 && n(ORIG.staging, PROBE) === 2 && n(ORIG.staging, "npm rebuild better-sqlite3\n") === 1,
			`remote-deploy.sh ${n(DEPLOY, PROBE)}, refresh-staging.sh ${n(ORIG.staging, PROBE)}`);
		const lines = code(ORIG.staging);
		const first = lines.findIndex((l) => l.trim() === 'PATH="$(dirname "$PM2_NODE"):$PATH"');
		const back = lines.findIndex((l) => l.trim() === 'PATH="$SAVED_PATH"');
		const npmAt = lines.map((l, i) => (/^\s*npm\s/.test(l) ? i : -1)).filter((i) => i >= 0);
		check("refresh-staging.sh runs npm only while pm2's Node is first on PATH",
			first >= 0 && back > first && npmAt.length >= 3 && npmAt.every((i) => i > first && i < back),
			`pm2's Node first at ${first}, PATH put back at ${back}, npm at [${npmAt}]`);
	}

	section("5. Mutants — each hole, reopened in the shipped source, turns this runner red");
	const MUTANTS = [
		["M1 the greedy sed that picked another tenant's Node", "byName",
			'"$(pm2_interpreter "$2" 2>/dev/null)"',
			`"$(pm2 jlist 2>/dev/null | sed -n 's/.*"exec_interpreter":"\\([^"]*\\)".*/\\1/p' | head -1)"`],
		["M2 a bare-require probe", "probeOpens",
			`'new (require("better-sqlite3"))(":memory:").close()'`, `'require("better-sqlite3")'`],
		["M3 a jlist parse that cannot see past pm2's notice", "notice",
			'JSON.parse(d.slice(d.lastIndexOf("\\n[")+1))', "JSON.parse(d)"],
		["M4 PATH's node dropped from the candidates", "pathOnly",
			'/opt/node22/bin/node "$(command -v node 2>/dev/null)"; do', "/opt/node22/bin/node; do"],
	];
	for (const [label, scenario, from, to] of MUTANTS) {
		const mutated = rebase(ORIG.local.split(from).join(to));
		const changed = mutated !== SRC.local;
		check(`${label} — actually changed refresh-local.sh`, changed, changed ? "" : "the anchor no longer matches: update the mutant");
		if (!changed) continue;
		setBox(SCENARIOS[scenario]);
		const caught = localVerdict(SCENARIOS[scenario], runLocal(mutated)).some(([ok]) => !ok);
		check(`${label} — is caught by the '${scenario}' scenario`, caught, caught ? "" : "SURVIVED");
	}

	section("6. refresh-staging.sh installs with the Node pm2 runs logisx-staging with");
	for (const s of Object.values(STAGING_ONLY)) {
		setBox(s);
		for (const [ok, detail] of stagingVerdict(s, runStaging(SRC.staging, s.args))) check(`refresh-staging.sh — ${s.what}`, ok, detail);
	}
	const ALL_STAGING = { ...SCENARIOS, ...STAGING_ONLY };
	const STAGING_MUTANTS = [
		["M5 npm run under PATH's node, the bare npm (pm2's Node not put first on PATH)", "installFetches",
			'PATH="$(dirname "$PM2_NODE"):$PATH"\n', ""],
		["M6 no probe and rebuild after the install", "pathOnly",
			`if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then`, "if false; then"],
		["M7 a rebuild that did not help no longer stops the run", "rebuildBroken",
			'|| die "better-sqlite3 still cannot open a database', '|| say "better-sqlite3 still cannot open a database'],
		["M8 pm2's interpreter unreadable: a guess instead of a refusal", "notListed",
			'if [ -z "$PM2_NODE" ] || [ ! -x "$PM2_NODE" ]; then\n  die', 'if [ -z "$PM2_NODE" ] || [ ! -x "$PM2_NODE" ]; then\n  PM2_NODE="$(command -v node)"; say'],
	];
	for (const [label, scenario, from, to] of STAGING_MUTANTS) {
		const mutated = once(ORIG.staging, from, to);
		check(`${label} — actually changed refresh-staging.sh`, !!mutated, mutated ? "" : "the anchor does not match exactly once: update the mutant");
		if (!mutated) continue;
		const s = ALL_STAGING[scenario];
		setBox(s);
		const caught = stagingVerdict(s, runStaging(rebase(mutated), s.args)).some(([ok]) => !ok);
		check(`${label} — is caught by the '${scenario}' scenario`, caught, caught ? "" : "SURVIVED");
	}

	section("7. Arguments reach the remote refresh-env.js exactly as typed");
	// Every option refresh-local.sh hands on, in one run.
	const OPTIONS = ["--telemetry-days", "30", "--telemetry-all", "--allow-mail", "--dry-run", "--no-backup"];
	setBox(SCENARIOS.incident);
	{
		const [ok, detail] = sameVectors(runLocal(SRC.local, OPTIONS), OPTIONS);
		check("7a every accepted option reaches the preflight, the sanitize ON THE VPS and the install as one and the same argument vector: the one typed", ok, detail);
	}
	// The quoting on its own: a copy whose refusal passes every argument on.
	const REFUSAL_ARM = '*) refuse_argument "$argn" ;;';
	const PASS_ARM = '*) EXTRA_ARGS+=("$1") ;;';
	const open = once(ORIG.local, REFUSAL_ARM, PASS_ARM);
	check("7b the copy with the refusal turned off was made (its anchor matched exactly once)", !!open);
	const RAN = (tag) => path.join(T, `ran-${tag}`);
	// The lone ' goes last: under the old join it opens a quote that never
	// closes, and anywhere earlier it would hide what the words before it do.
	const HARD = ["with space", '"double"', `$(touch ${RAN("subst")})`, `x; touch ${RAN("semicolon")}`,
		`\`touch ${RAN("backtick")}\``, "*", "back\\slash", "~", "$HOME", "line1\nline2", "", "it's"];
	const ranAny = () => ["subst", "semicolon", "backtick"].filter((t) => fs.existsSync(RAN(t)));
	if (open) {
		setBox(SCENARIOS.incident);
		const x = runLocal(rebase(open), HARD);
		const [ok, detail] = sameVectors(x, HARD);
		const ran = ranAny();
		check("7b …and then ANY argument, holding spaces, quotes, a newline or shell syntax, reaches the VPS's refresh-env.js as exactly that argument, and the VPS runs none of it",
			ok && ran.length === 0, ok ? (ran.length ? `ran: ${ran}` : "") : detail);
	}
	// Refused before any command runs, and never repeated.
	const REFUSED = [
		["an option refresh-local.sh does not know", ["--no-such-option"], /argument 1 is not an option refresh-local\.sh accepts\. Nothing was run\./, "no-such-option"],
		["a bare word", ["Harbour-Kestrel-bare-word"], /argument 1 is not an option refresh-local\.sh accepts/, "Harbour-Kestrel"],
		["a known option in --name=value form", ["--telemetry-days=30"], /argument 1 is not an option refresh-local\.sh accepts/, "--telemetry-days=30"],
		["a mode flag of refresh-env.js's own", ["--dry-run", "--verify", "x.gz"], /argument 2 is not an option refresh-local\.sh accepts/, "x.gz"],
		["--telemetry-days with a value that is not a whole number", ["--telemetry-days", "30; x"], /--telemetry-days \(argument 1\) takes a whole number of days/, "30; x"],
		["--telemetry-days with no value", ["--telemetry-days"], /--telemetry-days \(argument 1\) takes a whole number of days/, null],
		["--telemetry-days with more than 5 digits", ["--telemetry-days", "123456"], /at most 5 digits/, "123456"],
		["a database option with --code-only", ["--code-only", "--telemetry-all"], /--code-only installs no database, so --telemetry-all would do nothing/, null],
		["a database option with --scan-legacy", ["--scan-legacy", "--no-backup"], /--scan-legacy installs no database, so --no-backup would do nothing/, null],
		["--code-only together with --scan-legacy", ["--code-only", "--scan-legacy"], /separate runs/, null],
	];
	for (const [label, args, re, secret] of REFUSED) {
		setBox(SCENARIOS.incident);
		const x = runLocal(SRC.local, args);
		const quiet = x.sshLog === "" && x.laptop === "" && x.argv.length === 0;
		check(`7c refused before any command runs: ${label}`,
			x.code === 1 && re.test(x.out) && quiet && (!secret || !x.out.includes(secret)),
			`exit ${x.code}; ssh ${x.sshLog ? "RAN" : "no"}, git/npm ${x.laptop ? "RAN" : "no"}, refresh-env.js runs ${x.argv.length}${secret && x.out.includes(secret) ? ", and the argument was REPEATED" : ""}${re.test(x.out) ? "" : ` — ${tail(x.out)}`}`);
	}
	{
		setBox(SCENARIOS.incident);
		const x = runLocal(SRC.local, ["--help"]);
		check("7c --help prints every option and runs nothing",
			x.code === 0 && /usage: \.\/scripts\/refresh-local\.sh \[--telemetry-days N \| --telemetry-all\] \[--allow-mail\] \[--dry-run\] \[--no-backup\]/.test(x.out)
				&& x.sshLog === "" && x.laptop === "" && x.argv.length === 0, `exit ${x.code}`);
	}
	{
		const PREFLIGHT = '--check-env-only --to "$APP_DIR/app.db" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \\';
		const mv = once(ORIG.local, PREFLIGHT, '--check-env-only --to "$APP_DIR/app.db" \\');
		check("M9 the preflight no longer receives the options — actually changed refresh-local.sh", !!mv);
		if (mv) {
			setBox(SCENARIOS.incident);
			const [ok] = sameVectors(runLocal(rebase(mv), OPTIONS), OPTIONS);
			check("M9 the preflight no longer receives the options — is caught by 7a", !ok, ok ? "SURVIVED" : "");
		}
		const JOINED = once(open || "", "'$REMOTE_ART'$REMOTE_EXTRA_ARGS", "'$REMOTE_ART' ${EXTRA_ARGS[*]+${EXTRA_ARGS[*]}}");
		check("M10 the old unquoted join into the remote command — actually changed the 7b copy", !!JOINED);
		if (JOINED) {
			setBox(SCENARIOS.incident);
			const x = runLocal(rebase(JOINED), HARD);
			const [ok] = sameVectors(x, HARD);
			const ran = ranAny();
			check("M10 the old unquoted join into the remote command — is caught by 7b", !ok || ran.length > 0,
				!ok || ran.length ? `the VPS received other arguments${ran.length ? `, and ran: ${ran}` : ""}` : "SURVIVED");
			for (const t of ["subst", "semicolon", "backtick"]) fs.rmSync(RAN(t), { force: true });
		}
	}
} catch (e) {
	check("runner crashed", false, e && e.stack ? e.stack : String(e));
} finally {
	console.log(`\n${"-".repeat(74)}\n${pass + fail} assertions · ${fail} failed`);
	console.log(fail === 0 ? "=== ALL CHECKS PASSED ===" : "=== FAILURES ABOVE ===");
	if (KEEP) console.log(`sandbox kept at ${T}`);
	else fs.rmSync(T, { recursive: true, force: true });
	process.exitCode = fail === 0 ? 0 : 1;
}
