#!/usr/bin/env node
/**
 * Which Node the two refresh scripts run refresh-env.js with, on the VPS.
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
 *      transferred (refresh-local.sh) or installed (refresh-staging.sh), and
 *      no remote temp dir is left.
 *   §4 SOURCE PINS. The pick-node block is byte-identical in both scripts, its
 *      jlist parse is remote-deploy.sh's, no line parses exec_interpreter with
 *      sed or probes with a bare require, and refresh-local.sh empties
 *      PICK_NODE before reading the block and refuses unless it arrived.
 *   §5 MUTANTS. The old greedy sed, a bare-require probe, a jlist parse that
 *      cannot see past pm2's notice, and dropping PATH's node each turn this
 *      runner red.
 *
 * The REAL scripts run under bash against a sandbox standing in for the VPS:
 * their /var/www and /opt/node22 are rebased onto it (asserted to apply), each
 * interpreter is a wrapper around this Node that carries an ABI, a stub
 * better-sqlite3 opens a database only under the ABI it was built for, and the
 * ssh stub runs every command "on the VPS" under bash with that machine's PATH
 * and nothing from this one. Stub git/npm/pm2/scp and refresh-env.js; no
 * network, no VPS, no real app.db.
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
const mk = (...parts) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };
const writeExec = (p, body) => { mk(path.dirname(p)); fs.writeFileSync(p, body, { mode: 0o755 }); };
const readIf = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
mk(LOGS);

// The interpreters on the sandbox VPS: this Node under other names, each
// carrying the ABI (NODE_MODULE_VERSION) of the Node it stands for.
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
function stubSqlite(dir, builtFor) {
	const m = mk(dir, "node_modules", "better-sqlite3");
	fs.writeFileSync(path.join(m, "index.js"), `"use strict";
module.exports = class Database {
	constructor() {
		const abi = process.env.STUB_NODE_ABI || "(this machine's)";
		if (abi !== "${builtFor}") {
			throw new Error("The module '${m}/build/Release/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION ${builtFor}. This version of Node.js requires NODE_MODULE_VERSION " + abi + ".");
		}
	}
	close() {}
};
`);
}

// refresh-env.js as the wrappers see it: says which node ran it in which mode,
// and in the two modes that open SQLite it opens a database, as the real one does.
const STUB_REFRESH_ENV = `"use strict";
const fs = require("fs");
const a = process.argv.slice(2);
const mode = a.includes("--check-env-only") ? "check-env-only" : a.includes("--sanitize-only") ? "sanitize-only"
	: a.includes("--verify") ? "verify" : a.includes("--from-sanitized") ? "install-sanitized" : "install";
console.log("[stub-refresh-env] mode=" + mode + " node=" + (process.env.STUB_NODE_ID || "laptop"));
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
// line of JSON, as pm2 does. Everything else is a no-op.
writeExec(path.join(VPS_BIN, "pm2"), `#!/bin/bash
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
writeExec(path.join(VPS_BIN, "npm"), "#!/bin/bash\nexit 0\n");
// GNU stat -c %s (refresh-local.sh's disk preflight), on macOS too.
writeExec(path.join(VPS_BIN, "stat"), `#!/bin/bash
if [ "$1" = -c ] && [ "$2" = %s ]; then wc -c < "$3" | tr -d ' '; exit 0; fi
exec /usr/bin/stat "$@"
`);

// The laptop: a checkout holding the rebased refresh-local.sh, and the
// commands it reaches the VPS with.
const APP = mk(LAPTOP, "app");
fs.writeFileSync(path.join(mk(APP, "scripts"), "refresh-env.js"), STUB_REFRESH_ENV);
fs.writeFileSync(path.join(APP, ".env"), "PORT=3931\nSPREADSHEET_ID=sandbox-local-sheet\n");
const LAPTOP_BIN = mk(LAPTOP, "bin");
writeExec(path.join(LAPTOP_BIN, "git"), GIT_STUB);
writeExec(path.join(LAPTOP_BIN, "npm"), "#!/bin/bash\nexit 0\n");
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
		procs: box({ prod: P.system.path, stage: P.system.path }), local: "opt22", staging: "opt22",
	},
	notListed: {
		what: "§3 pm2 does not list the process: /opt/node22",
		procs: box({ listed: false }), local: "opt22", staging: "opt22",
	},
	noPm2: {
		what: "§3 no pm2 on PATH: /opt/node22, and set -e does not abort the pick",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), pm2: false, local: "opt22", staging: "opt22",
	},
	pathOnly: {
		what: "§3 only PATH's node can open a database (the module was rebuilt under it): PATH's node",
		procs: box({ prod: P.prodPin.path, stage: P.stagePin.path }), moduleAbi: "115", local: "system", staging: "system",
	},
	noneCanOpen: {
		what: "§3 no candidate can open a database (pm2's is the system Node, no /opt/node22)",
		procs: box({ prod: P.system.path, stage: P.system.path }), opt22: false, local: null, staging: null,
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
	setPresent(path.join(VPS_BIN, "pm2"), s.pm2 !== false);
	setPresent(P.opt22.path, s.opt22 !== false);
	for (const f of fs.readdirSync(LOGS)) fs.rmSync(path.join(LOGS, f), { force: true });
	fs.rmSync(path.join(APP, "app.db"), { force: true });
	fs.rmSync(path.join(STAGING_DIR, "app.db"), { force: true });
}
const stubRuns = (out) => [...out.matchAll(/^\[stub-refresh-env\] mode=(\S+) node=(\S+)$/gm)].map((m) => ({ mode: m[1], node: m[2] }));
const tail = (out) => out.split("\n").filter(Boolean).slice(-4).join(" | ");

function runLocal(src) {
	fs.writeFileSync(path.join(APP, "scripts", "refresh-local.sh"), src, { mode: 0o755 });
	const r = spawnSync("/bin/bash", [path.join(APP, "scripts", "refresh-local.sh")], {
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
	};
}
function runStaging(src) {
	const script = path.join(STAGING_DIR, "scripts", "refresh-staging.sh");
	fs.writeFileSync(script, src, { mode: 0o755 });
	const r = spawnSync("/bin/bash", [script, "--yes"], {
		cwd: STAGING_DIR, encoding: "utf8", timeout: 30000,
		env: { PATH: VPS_PATH, HOME: mk(VPS, "root"), LC_ALL: "C" },
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	return {
		code: r.status, out,
		installedWith: stubRuns(out).filter((x) => x.mode === "install").map((x) => x.node),
		reported: (out.match(/^\[refresh-staging\] node: (\S+) \(/m) || [])[1] || null,
		wrote: fs.existsSync(path.join(STAGING_DIR, "app.db")),
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
	if (s.staging === null) {
		return [[x.code !== 0 && /no node on this box can open a better-sqlite3 database/.test(x.out) && x.installedWith.length === 0 && !x.wrote,
			`exit ${x.code}, install ran under [${x.installedWith}], app.db written ${x.wrote}`]];
	}
	const want = P[s.staging].path;
	return [[x.code === 0 && x.installedWith.length === 1 && x.installedWith[0] === s.staging && x.reported === want && x.wrote,
		`exit ${x.code}, install ran under [${x.installedWith}], reported ${idOf(x.reported)}, want ${s.staging}${x.code === 0 ? "" : ` — ${tail(x.out)}`}`]];
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
		for (const [ok, detail] of stagingVerdict(s, runStaging(SRC.staging))) check(`refresh-staging.sh — ${s.what}`, ok, detail);
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
	const jlistParse = (text) => {
		const m = /node -e '([^']*exec_interpreter[^']*)'/.exec(text || "");
		return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n") : null;
	};
	const deployParse = jlistParse(fs.readFileSync(DEPLOY_SH, "utf8"));
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
} catch (e) {
	check("runner crashed", false, e && e.stack ? e.stack : String(e));
} finally {
	console.log(`\n${"-".repeat(74)}\n${pass + fail} assertions · ${fail} failed`);
	console.log(fail === 0 ? "=== ALL CHECKS PASSED ===" : "=== FAILURES ABOVE ===");
	if (KEEP) console.log(`sandbox kept at ${T}`);
	else fs.rmSync(T, { recursive: true, force: true });
	process.exitCode = fail === 0 ? 0 : 1;
}
