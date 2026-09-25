#!/usr/bin/env node
// scripts/test-refresh-sign-in.js — who can sign in to a refreshed copy, and how.
//
// A refreshed LOCAL or STAGING database accepts no password anybody knows in
// advance; scripts/test-sanitize-before-transfer.js proves that of
// refresh-env.js itself. This runner covers the two ways back in, and the flow
// the docs describe:
//
//   §1 prepare-test-fixtures.js — the LOCAL way in, for test-suite.js — refuses
//      a deployed database by path, NODE_ENV and a missing opt-in, and on a
//      local one sets its known password on exactly one account per role.
//   §2 …and refuses a deployed database by any OTHER name the file has: a
//      symlink, a linked directory, a hardlink, the DATABASE_PATH a deployed
//      .env names, and a deployed root that is itself a symlink. /var/www
//      cannot be created here, so this runs a copy whose DEPLOYED_ROOT is
//      rebased onto a scratch directory — and asserts the rebase applied, so
//      the section cannot go quietly vacuous.
//   §3 the documented local flow, end to end: refresh -> no account accepts
//      the local test password; prepare -> exactly one per role does; and
//      refresh-env.js --verify then REFUSES the result, so a prepared copy can
//      never pass for a sanitized one.
//   §4 the wrappers hand REFRESH_OPERATOR_PASSWORD to exactly two commands,
//      the refresh-env.js preflight and the refresh-env.js install, and to
//      NOTHING else: not npm (third-party lifecycle scripts), not git, not
//      ssh/scp (it must never reach the VPS), not `pm2 restart --update-env`
//      (which would copy it into the running staging process), not the
//      --verify call, and not the `dirname` refresh-local.sh runs first. The
//      REAL scripts run under bash with those commands, and node itself,
//      behind recording stubs; every stub records its argv and its whole
//      environment, so the log shows exactly which commands the password
//      reached, and the installed database proves it did reach refresh-env.js.
//      That holds too when the caller already exports an OPERATOR_PASSWORD
//      or OPERATOR_USER of its own (bash keeps an inherited export across an
//      assignment; the wrappers `export -n` their copies). refresh-local.sh
//      moves it out of its environment before its first command (pinned in
//      its source too), says so when --code-only ignores it, and stops before
//      running any command at all on a password typed as an argument, with a
//      flag or as a bare word. Both stop BEFORE anything slow or remote (no
//      ssh, no npm, no pm2) on a too-short operator password or a stray mode
//      flag. And since neither can unset the caller's own copy: both remind
//      the operator to, and the restart command refresh-staging.sh hands out
//      without --restart, run from a shell that still EXPORTS the password,
//      gives pm2 none of it.
//   §5 mutants: each guard above, removed, must turn this runner red.
//
// Hermetic: a mkdtemp sandbox; stubbed git/npm/pm2/ssh/scp/sleep and
// recording dirname/node; the real refresh-env.js, prepare-test-fixtures.js
// and wrappers. No network, no VPS, no app.db outside the sandbox, and npm
// resolves only to the stub, even with pm2's interpreter directory first on
// PATH (asserted before either wrapper runs).
//
// Usage: node scripts/test-refresh-sign-in.js [--keep]
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REFRESH = path.join(__dirname, "refresh-env.js");
const PREPARE = path.join(__dirname, "prepare-test-fixtures.js");
const STAGING_SH = path.join(__dirname, "refresh-staging.sh");
const LOCAL_SH = path.join(__dirname, "refresh-local.sh");
const KEEP = process.argv.includes("--keep");
// Resolved: macOS keeps tmpdir behind the /var -> /private/var symlink, and the
// staging wrapper compares `pwd` against a path, so every sandbox path is real.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-sign-in-test.")));

// Resolved, never composed — see the same block in test-sanitize-before-transfer.js
// (a git worktree has no node_modules of its own).
const NODE_MODULES = (() => {
	try { return path.resolve(path.dirname(require.resolve("better-sqlite3/package.json")), ".."); }
	catch { return null; }
})();

// Restated, not read from the scripts under test, so a check cannot share a
// mistake with the code it grades.
const LOCAL_TEST_PASSWORD = "Password123!";          // what prepare-test-fixtures.js sets, LOCALLY
const OPERATOR_PW = "op-Harbour-Kestrel-Quill-82";    // what these tests hand the wrappers
const LOCAL_SHEET = "156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0";
const STAGING_SHEET = "1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y";

// Never inherit an operator password, or a production NODE_ENV, from the shell
// that runs this: every child below would pick it up.
const BASE_ENV = { ...process.env };
delete BASE_ENV.REFRESH_OPERATOR_PASSWORD;
delete BASE_ENV.REFRESH_OPERATOR_USER;
delete BASE_ENV.NODE_ENV;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(n) { console.log(`\n${n}`); }
function finish() {
	console.log("\n" + "-".repeat(74));
	console.log(`${pass + fail} assertions · ${fail} failed`);
	console.log(fail === 0 ? "=== ALL CHECKS PASSED ===" : "=== FAILURES ABOVE ===");
	if (KEEP) console.log(`\nscratch kept at ${ROOT}`);
	else fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(fail === 0 ? 0 : 1);
}

function runNode(script, args, { cwd, env = {} } = {}) {
	const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, env: { ...BASE_ENV, ...env } });
	return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const refusal = (out) => (out.match(/REFUSING: .*/) || out.match(/No database at .*/) || [""])[0].slice(0, 120);
const sha = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return "(absent)"; } };
const mkdirp = (...parts) => { const d = path.join(ROOT, ...parts); fs.mkdirSync(d, { recursive: true }); return d; };

// ---------------------------------------------------------------------------
// The fixture: a small production-shaped users table. Six accounts, one per
// role the suite signs in as plus the ones it must NOT touch — a second Super
// Admin, a Driver, and demo_viewer. Every password hash is a distinct fake;
// admin.one starts with a forced password change pending.
// ---------------------------------------------------------------------------
const ACCOUNTS = [
	[1, "admin.one", "Super Admin", 1],
	[2, "admin.two", "Super Admin", 0],
	[3, "inv.one", "Investor", 0],
	[4, "disp.one", "Dispatcher", 0],
	[5, "drv.one", "Driver", 0],
	[6, "demo_viewer", "Super Admin", 0],
];
const priorHash = (u) => "$2a$10$" + ("prior" + u).replace(/[^a-z]/g, "").padEnd(53, "0").slice(0, 53);

function seedDb(dbPath) {
	const Database = require("better-sqlite3");
	const db = new Database(dbPath);
	db.pragma("journal_mode = DELETE");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
			role TEXT NOT NULL, email TEXT DEFAULT '', must_change_password INTEGER DEFAULT 0);
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
	`);
	const ins = db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)");
	for (const [id, u, role, mc] of ACCOUNTS) ins.run(id, u, priorHash(u), role, mc);
	db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("sid-live", '{"user":{"id":1}}', 9999999999);
	db.close();
}
function openDb(p) { return new (require("better-sqlite3"))(p, { readonly: true }); }
function accepting(dbPath, pw) {
	const bcrypt = require("bcryptjs");
	const db = openDb(dbPath);
	try {
		return db.prepare("SELECT username, password_hash AS h FROM users ORDER BY id").all()
			.filter((r) => { try { return bcrypt.compareSync(pw, r.h); } catch { return false; } })
			.map((r) => r.username);
	} finally { db.close(); }
}
function hashOf(dbPath, username) {
	const db = openDb(dbPath);
	try { const r = db.prepare("SELECT password_hash h FROM users WHERE username = ?").get(username); return r ? r.h : null; }
	finally { db.close(); }
}
function count(dbPath, sql) {
	const db = openDb(dbPath);
	try { return db.prepare(sql).get().c; } finally { db.close(); }
}

// A copy of a script with some of its text replaced — each replacement
// asserted to match EXACTLY ONCE, so a rename in the original turns the copy
// into a loud failure instead of a silently unmodified (and so vacuous) one.
function rewrite(srcPath, edits) {
	let src = fs.readFileSync(srcPath, "utf8");
	for (const [from, to] of edits) {
		const hits = src.split(from).length - 1;
		if (hits !== 1) return { src: null, err: `anchor matched ${hits} times, not once: ${from.slice(0, 70)}` };
		src = src.replace(from, () => to);
	}
	return { src, err: "" };
}

// ===========================================================================
(function runAll() {
	console.log(`refresh sign-in — scratch root ${ROOT}\n`);
	if (!NODE_MODULES) {
		console.log("CANNOT RUN — better-sqlite3 does not resolve from this checkout. Run `npm install`.");
		console.log("  Nothing was tested. This is a missing dependency, not a failing assertion.");
		fs.rmSync(ROOT, { recursive: true, force: true });
		process.exit(1);
	}

	const seed = path.join(mkdirp("seed"), "seed.db");
	seedDb(seed);
	const snapshotGz = path.join(mkdirp("backups"), "app.db.20260809_020001.gz");
	fs.writeFileSync(snapshotGz, zlib.gzipSync(fs.readFileSync(seed)));
	const freshDb = (...parts) => { const p = path.join(mkdirp(...parts), "app.db"); fs.copyFileSync(seed, p); return p; };

	// =======================================================================
	section("1. prepare-test-fixtures.js — refuses what is not a local database");
	{
		const db = freshDb("s1");
		const before = sha(db);
		let r = runNode(PREPARE, [db]);
		check("refuses without --yes-local-db, and writes nothing", r.code === 1 && /pass --yes-local-db/.test(r.out) && sha(db) === before, refusal(r.out));
		for (const v of ["production", " Production "]) {
			r = runNode(PREPARE, ["--yes-local-db", db], { env: { NODE_ENV: v } });
			check(`refuses NODE_ENV=${JSON.stringify(v)}, and writes nothing`, r.code === 1 && /NODE_ENV=production/.test(r.out) && sha(db) === before, refusal(r.out));
		}
		// None of these needs to exist: the lexical refusal comes before anything is opened.
		for (const p of ["/var/www/logistics-app/app.db", "/var/www/logisx-staging/app.db",
			"/tmp/../var/www/logistics-app/app.db", "//var/www/logisx-staging/app.db", "/var/www"]) {
			r = runNode(PREPARE, ["--yes-local-db", p]);
			check(`refuses ${p}`, r.code === 1 && /is a deployed path/.test(r.out), refusal(r.out));
		}
		const missing = path.join(ROOT, "s1-missing", "app.db");
		r = runNode(PREPARE, ["--yes-local-db", missing]);
		check("refuses a database that does not exist, and creates none", r.code === 1 && !fs.existsSync(missing), refusal(r.out));

		r = runNode(PREPARE, ["--yes-local-db", db]);
		check("accepts a local scratch database", r.code === 0, r.code === 0 ? "" : refusal(r.out));
		const got = accepting(db, LOCAL_TEST_PASSWORD);
		check("…and sets the local test password on exactly one account per role the suite signs in as",
			JSON.stringify(got) === JSON.stringify(["admin.one", "inv.one", "disp.one"]), JSON.stringify(got));
		check("…leaving the other Super Admin and the Driver exactly as they were",
			hashOf(db, "admin.two") === priorHash("admin.two") && hashOf(db, "drv.one") === priorHash("drv.one"));
		check("…deleting demo_viewer and every session",
			count(db, "SELECT COUNT(*) c FROM users WHERE username = 'demo_viewer'") === 0 && count(db, "SELECT COUNT(*) c FROM sessions") === 0);
		check("…and printing a run command that covers the dispatcher login too, which has no default",
			/TEST_ADMIN_USER='admin\.one'/.test(r.out) && /TEST_INVESTOR_USER='inv\.one'/.test(r.out)
				&& /TEST_DISPATCHER_USER='disp\.one'/.test(r.out) && /TEST_DISPATCHER_PASS='/.test(r.out));
	}

	// =======================================================================
	section("2. prepare-test-fixtures.js — refuses a deployed database by ANY name it has");
	const fakeRoot = mkdirp("var-www");
	const deployed = freshDb("var-www", "logisx-staging");
	const deployedBackup = path.join(mkdirp("var-www", "logistics-app", "backups"), "app.db.20260101_020001");
	fs.copyFileSync(seed, deployedBackup);
	const served = freshDb("elsewhere");                     // served via DATABASE_PATH, outside the root
	fs.writeFileSync(path.join(fakeRoot, "logisx-staging", ".env"), `SPREADSHEET_ID=${STAGING_SHEET}\nDATABASE_PATH="${served}"\n`);
	const rootAnchor = 'const DEPLOYED_ROOT = "/var/www";';
	function rebasedPrepare(name, root, extraEdits = []) {
		const dir = mkdirp("tools", name, "scripts");
		const { src, err } = rewrite(PREPARE, [[rootAnchor, `const DEPLOYED_ROOT = ${JSON.stringify(root)};`], ...extraEdits]);
		if (!src) return { script: null, err };
		const script = path.join(dir, "prepare-test-fixtures.js");
		fs.writeFileSync(script, src);
		try { fs.symlinkSync(NODE_MODULES, path.join(dir, "..", "node_modules"), "dir"); } catch {}
		return { script, err: "" };
	}
	const innocent = mkdirp("innocent");
	const link = path.join(innocent, "link.db");
	fs.symlinkSync(path.join(fakeRoot, "logisx-staging", "app.db"), link);
	const linkToBackup = path.join(innocent, "backup-link.db");
	fs.symlinkSync(deployedBackup, linkToBackup);
	const linkedDir = path.join(ROOT, "innocent-dir");
	fs.symlinkSync(path.join(fakeRoot, "logisx-staging"), linkedDir, "dir");
	const hard = path.join(innocent, "hard.db");
	fs.linkSync(deployed, hard);
	const linkToServed = path.join(innocent, "served-link.db");
	fs.symlinkSync(served, linkToServed);
	const plain = path.join(innocent, "plain.db");
	fs.copyFileSync(seed, plain);
	const CASES = {
		direct: [deployed, /is a deployed path/],
		symlink: [link, /resolves to .*, a deployed path|same file as the deployed database/],
		backupSymlink: [linkToBackup, /resolves to .*, a deployed path/],
		linkedDir: [path.join(linkedDir, "app.db"), /resolves to .*, a deployed path|same file as the deployed database/],
		hardlink: [hard, /same file as the deployed database/],
		databasePath: [served, /same file as the deployed database .*served|same file as the deployed database .*elsewhere/],
		databasePathLink: [linkToServed, /same file as the deployed database/],
	};
	const protectedFiles = [deployed, deployedBackup, served];
	const protectedSha = () => protectedFiles.map(sha).join(",");
	{
		const tool = rebasedPrepare("rebased", fakeRoot);
		check("the rebased copy was made — DEPLOYED_ROOT matched exactly once", !!tool.script, tool.err);
		if (tool.script) {
			for (const [name, [target, re]] of Object.entries(CASES)) {
				const before = protectedSha();
				const r = runNode(tool.script, ["--yes-local-db", target]);
				check(`refuses the ${name} case`, r.code === 1 && re.test(r.out) && protectedSha() === before, refusal(r.out));
			}
			const r = runNode(tool.script, ["--yes-local-db", plain]);
			check("CONTROL: the same copy still accepts an ordinary local database", r.code === 0, refusal(r.out));
		}
		// A deployed root that is itself a symlink: the resolved root counts too.
		const rootLink = path.join(ROOT, "var-www-link");
		fs.symlinkSync(fakeRoot, rootLink, "dir");
		const viaLinkRoot = rebasedPrepare("rebased-link-root", rootLink);
		if (viaLinkRoot.script) {
			const before = protectedSha();
			const r = runNode(viaLinkRoot.script, ["--yes-local-db", deployed]);
			check("refuses a database under the RESOLVED deployed root when the root is a symlink",
				r.code === 1 && /is a deployed path/.test(r.out) && protectedSha() === before, refusal(r.out));
		} else check("refuses a database under the RESOLVED deployed root when the root is a symlink", false, viaLinkRoot.err);
	}

	// =======================================================================
	section("3. The documented local flow — refresh, then prepare, then the suite");
	{
		const dir = mkdirp("flow");
		fs.writeFileSync(path.join(dir, ".env"), `PORT=3911\nSPREADSHEET_ID=${LOCAL_SHEET}\nNODE_ENV=development\n`);
		const target = path.join(dir, "app.db");
		const refreshed = runNode(REFRESH, ["--from", snapshotGz, "--to", target, "--yes-non-prod", "--no-backup"]);
		check("refresh-env.js installs a refreshed copy", refreshed.code === 0, refreshed.code === 0 ? "" : refusal(refreshed.out));
		check("…on which NO account accepts the local test password", fs.existsSync(target) && accepting(target, LOCAL_TEST_PASSWORD).length === 0);
		check("…and which verifies clean", runNode(REFRESH, ["--verify", target]).code === 0);

		const prepared = runNode(PREPARE, ["--yes-local-db", target]);
		const got = prepared.code === 0 ? accepting(target, LOCAL_TEST_PASSWORD) : [];
		check("prepare-test-fixtures.js then makes exactly one account per suite role sign-in-able",
			prepared.code === 0 && JSON.stringify(got) === JSON.stringify(["admin.one", "inv.one", "disp.one"]), JSON.stringify(got));
		check("…none of them held back by a forced password change (the refresh cleared it)",
			count(target, "SELECT COUNT(*) c FROM users WHERE username IN ('admin.one','inv.one','disp.one') AND must_change_password <> 0") === 0);
		check("…and nobody else: the other Super Admin and the Driver still accept nothing known",
			accepting(target, LOCAL_TEST_PASSWORD).every((u) => u !== "admin.two" && u !== "drv.one"));

		const v = runNode(REFRESH, ["--verify", target]);
		check("--verify REFUSES the prepared copy — it can never pass for a sanitized one",
			v.code === 1 && /3 account\(s\) accept a password published/.test(v.out) && /3 account\(s\) share a password hash/.test(v.out),
			(v.out.match(/^ {11}\d+ account.*$/gm) || []).map((s) => s.trim()).join(" | "));
	}

	// =======================================================================
	section("4. The wrappers hand REFRESH_OPERATOR_PASSWORD to refresh-env.js and to nothing else");
	// Every stub appends its name, argv and WHOLE environment to $STUB_LOG, then
	// answers just enough for the wrapper to carry on. dirname and node record
	// too and then run the real thing: dirname is the first command
	// refresh-local.sh runs, and node is how every refresh-env.js call starts,
	// so the log shows exactly which of those calls the password reaches.
	const REAL_DIRNAME = ["/usr/bin/dirname", "/bin/dirname"].find((p) => fs.existsSync(p));
	const pm2InterpreterIn = (bin) => path.join(bin, "node");
	function writeStubs(bin) {
		fs.mkdirSync(bin, { recursive: true });
		const stub = (name, body) => fs.writeFileSync(path.join(bin, name),
			`#!/bin/bash\n{ printf 'CALL %s' '${name}'; printf ' <%s>' "$@"; printf '\\n'; env; printf 'END\\n'; } >> "$STUB_LOG"\n${body}\nexit 0\n`,
			{ mode: 0o755 });
		stub("git", 'case "$1 $2" in\n  "rev-parse --abbrev-ref") echo feature ;;\n  "rev-parse --short") echo abc1234 ;;\nesac');
		stub("npm", ":");
		stub("sleep", ":");
		stub("dirname", `exec ${JSON.stringify(REAL_DIRNAME)} "$@"`);
		stub("node", `exec ${JSON.stringify(process.execPath)} "$@"`);
		// pm2 runs logisx-staging with the node stub above. refresh-staging.sh
		// installs with the directory of pm2's interpreter first on PATH, and
		// this directory holds the npm stub, never a real npm.
		const jlist = JSON.stringify([{ name: "logisx-staging", pm2_env: { name: "logisx-staging", status: "online", exec_interpreter: pm2InterpreterIn(bin) } }]);
		stub("pm2", `case "$1" in\n  jlist) echo '${jlist}' ;;\n  describe) echo "status online"; echo "restarts 0" ;;\nesac`);
		stub("ssh", 'for cmd; do :; done\ncase "$cmd" in\n  *"ls -1t"*) echo "/var/www/logistics-app/backups/app.db.20260809_020001.gz" ;;\n  *"mktemp -d"*) echo "/var/tmp/logisx-sanitize.TESTTEST" ;;\nesac');
		stub("scp", 'for last; do :; done\ncase "$last" in\n  *:*) : ;;\n  *) cp "$STUB_ARTIFACT" "$last" ;;\nesac');
	}
	// No directory with a real node (and so a real npm) beside it: node is the
	// recording stub, which runs this Node by its full path.
	const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const wrapperPath = (bin) => [bin, ...SYSTEM_DIRS].join(":");
	const readLog = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
	const calls = (log, name) => (log.match(new RegExp(`^CALL ${name}\\b.*$`, "gm")) || []);
	// The log as one entry per command: its CALL line (name and argv) and its environment.
	const entries = (log) => log.split("\nEND\n").filter((b) => /^CALL /m.test(b))
		.map((b) => ({ call: (b.match(/^CALL .*$/m) || [""])[0], text: b }));
	// The only two commands meant to receive the operator password.
	const isPreflight = (c) => /^CALL node <scripts\/refresh-env\.js> <--check-env-only>/.test(c);
	const isInstall = (c) => /^CALL node <scripts\/refresh-env\.js> <--from> /.test(c) && /<--yes-non-prod>/.test(c);
	function passwordReach(log) {
		const es = entries(log);
		const got = es.filter((e) => e.text.includes(OPERATOR_PW));
		return {
			inspected: es.length,
			delivered: got.filter((e) => isPreflight(e.call) || isInstall(e.call)).map((e) => (isPreflight(e.call) ? "preflight" : "install")),
			leakedTo: [...new Set(got.filter((e) => !isPreflight(e.call) && !isInstall(e.call)).map((e) => (e.call.match(/^CALL (\S+)/) || ["", "?"])[1]))],
			inArgv: es.some((e) => e.call.includes(OPERATOR_PW)),
			dirnameRan: es.some((e) => /^CALL dirname /.test(e.call)),
		};
	}
	const reachDetail = (x) => (x.leakedTo.length || x.inArgv
		? `LEAKED to: ${x.leakedTo.join(", ") || "(an argv)"}`
		: `delivered to [${x.delivered}], ${x.inspected} call(s) inspected`);
	{
		// A real npm reached from a sandbox would run a genuine install against
		// the node_modules the sandboxes link to. refresh-staging.sh puts the
		// directory of pm2's interpreter first on PATH for its install, so npm
		// must resolve to the stub on the wrappers' PATH AND with that directory
		// in front of it — or neither wrapper runs.
		const bin = mkdirp("npm-probe", "bin");
		writeStubs(bin);
		const want = path.join(bin, "npm");
		const got = [wrapperPath(bin), `${path.dirname(pm2InterpreterIn(bin))}:${wrapperPath(bin)}`]
			.map((p) => (spawnSync("/bin/bash", ["-c", "command -v npm"], { encoding: "utf8", env: { PATH: p } }).stdout || "").trim());
		const safe = got.every((g) => g === want) && !!REAL_DIRNAME;
		check("npm resolves only to the stub, on the wrappers' PATH and with pm2's interpreter directory in front; and there is a real dirname to record in front of",
			safe, safe ? "" : `npm resolves to [${got}]${REAL_DIRNAME ? "" : "; no dirname found"}`);
		if (!safe) finish();
	}

	// -- refresh-staging.sh -------------------------------------------------------
	// It hardcodes /var/www paths and refuses to run anywhere but its own
	// directory, so the copy's two path constants are rebased onto the sandbox.
	function stageStaging(name, extraEdits = []) {
		const sb = mkdirp(name);
		const stagingDir = mkdirp(name, "staging", "scripts").replace(/\/scripts$/, "");
		const backups = mkdirp(name, "backups");
		fs.copyFileSync(snapshotGz, path.join(backups, path.basename(snapshotGz)));
		fs.copyFileSync(REFRESH, path.join(stagingDir, "scripts", "refresh-env.js"));
		fs.symlinkSync(NODE_MODULES, path.join(stagingDir, "node_modules"), "dir");
		fs.writeFileSync(path.join(stagingDir, ".env"), `PORT=3903\nSPREADSHEET_ID=${STAGING_SHEET}\nNODE_ENV=development\n`);
		const { src, err } = rewrite(STAGING_SH, [
			['STAGING_DIR="/var/www/logisx-staging"', `STAGING_DIR="${stagingDir}"`],
			['PROD_BACKUPS="/var/www/logistics-app/backups"', `PROD_BACKUPS="${backups}"`],
			...extraEdits,
		]);
		if (!src) return { err };
		const script = path.join(stagingDir, "scripts", "refresh-staging.sh");
		fs.writeFileSync(script, src, { mode: 0o755 });
		writeStubs(path.join(sb, "bin"));
		return { sb, stagingDir, script, bin: path.join(sb, "bin"), log: path.join(sb, "stub.log"), err: "" };
	}
	function runStaging(s, env, args = [], { restart = true } = {}) {
		const r = spawnSync("bash", [s.script, "--yes", ...(restart ? ["--restart"] : []), ...args], {
			cwd: s.stagingDir, encoding: "utf8",
			env: { PATH: wrapperPath(s.bin), HOME: s.sb, TMPDIR: mkdirp(path.basename(s.sb), "tmp"), STUB_LOG: s.log, ...env },
		});
		return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
	}

	// -- refresh-local.sh -----------------------------------------------------------
	// Runs UNMODIFIED: APP_DIR comes from its own location and VPS_HOST/VPS_KEY from
	// the environment. The ssh/scp stubs play the VPS; scp "downloads" a real
	// artifact produced by the real --sanitize-only, so --verify and the install
	// that follow are the real thing.
	const artifact = path.join(mkdirp("artifact"), "sanitized.db.gz");
	const made = runNode(REFRESH, ["--sanitize-only", "--from", snapshotGz, "--emit", artifact]);
	function stageLocal(name, extraEdits = []) {
		const sb = mkdirp(name);
		const app = mkdirp(name, "app", "scripts").replace(/\/scripts$/, "");
		fs.copyFileSync(REFRESH, path.join(app, "scripts", "refresh-env.js"));
		fs.symlinkSync(NODE_MODULES, path.join(app, "node_modules"), "dir");
		fs.writeFileSync(path.join(app, ".env"), `PORT=3911\nSPREADSHEET_ID=${LOCAL_SHEET}\nNODE_ENV=development\n`);
		const { src, err } = extraEdits.length ? rewrite(LOCAL_SH, extraEdits) : { src: fs.readFileSync(LOCAL_SH, "utf8"), err: "" };
		if (!src) return { err };
		const script = path.join(app, "scripts", "refresh-local.sh");
		fs.writeFileSync(script, src, { mode: 0o755 });
		writeStubs(path.join(sb, "bin"));
		return { sb, app, script, bin: path.join(sb, "bin"), log: path.join(sb, "stub.log"), err: "" };
	}
	function runLocal(s, env, args = []) {
		const r = spawnSync("bash", [s.script, ...args], {
			cwd: s.app, encoding: "utf8",
			env: {
				PATH: wrapperPath(s.bin), HOME: s.sb, TMPDIR: mkdirp(path.basename(s.sb), "tmp"), STUB_LOG: s.log,
				STUB_ARTIFACT: artifact, VPS_HOST: "stub@vps.invalid", VPS_KEY: "/dev/null", ...env,
			},
		});
		return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
	}
	const OPERATOR_ENV = { REFRESH_OPERATOR_PASSWORD: OPERATOR_PW, REFRESH_OPERATOR_USER: "admin.two" };
	// A caller that already exports names of the wrappers' own: bash keeps an
	// inherited export across an assignment, so without `export -n` the real
	// password would land in an exported variable that every child inherits.
	const DECOY_ENV = { ...OPERATOR_ENV, OPERATOR_PASSWORD: "decoy-exported-by-the-caller", OPERATOR_USER: "decoy-user" };
	const REMINDER = (tag) => new RegExp(`^\\[${tag}\\] {3}unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER$`, "m");
	// The restart command refresh-staging.sh hands out without --restart, run
	// the way an operator would: from a shell that still EXPORTS the password.
	function runHint(out, name) {
		const m = /^\[refresh-staging\] When ready:\s+(.+)$/m.exec(out);
		if (!m) return { hint: null, restarted: false, leaked: false };
		const bin = mkdirp(name, "bin");
		writeStubs(bin);
		const log = path.join(ROOT, name, "stub.log");
		spawnSync("/bin/bash", ["-c", m[1]], {
			encoding: "utf8",
			env: { PATH: wrapperPath(bin), HOME: path.join(ROOT, name), STUB_LOG: log, ...OPERATOR_ENV },
		});
		const restarts = entries(readLog(log)).filter((e) => /^CALL pm2 <restart> <logisx-staging> <--update-env>$/.test(e.call));
		return { hint: m[1], restarted: restarts.length === 1, leaked: restarts.some((e) => e.text.includes(OPERATOR_PW)) };
	}
	{
		const s = stageStaging("wrap-staging");
		check("refresh-staging.sh: the sandbox copy was made — both path constants matched exactly once", !s.err, s.err);
		if (!s.err) {
			const r = runStaging(s, OPERATOR_ENV);
			const log = readLog(s.log);
			check("refresh-staging.sh --yes --restart runs to completion in the sandbox", r.code === 0,
				r.code === 0 ? "" : r.out.split("\n").filter(Boolean).slice(-3).join(" | "));
			check("…really running npm, git and `pm2 restart --update-env` (so the next check has something to read)",
				calls(log, "npm").length >= 2 && calls(log, "git").length >= 2 && calls(log, "pm2").some((c) => /<restart>.*<--update-env>/.test(c)),
				`${calls(log, "npm").length} npm, ${calls(log, "git").length} git, ${calls(log, "pm2").length} pm2`);
			const reach = passwordReach(log);
			check("the operator password reaches exactly the two refresh-env.js calls meant for it, the preflight and the install, and no other command's argv or environment: npm, git, pm2 and every other node call included",
				reach.leakedTo.length === 0 && !reach.inArgv && JSON.stringify(reach.delivered) === JSON.stringify(["preflight", "install"]),
				reachDetail(reach));
			const who = accepting(path.join(s.stagingDir, "app.db"), OPERATOR_PW);
			check("…yet it DID reach refresh-env.js: exactly admin.two accepts it on the installed copy",
				JSON.stringify(who) === JSON.stringify(["admin.two"]), JSON.stringify(who));
			check("…and the wrapper's own output never shows it", !r.out.includes(OPERATOR_PW));
			check("…but tells the operator to unset both variables in their own shell, which it cannot do for them",
				REMINDER("refresh-staging").test(r.out));
		}
		{
			// Without --restart the script hands out the restart command instead.
			// --update-env copies the caller's environment into staging, so the
			// command must drop the operator variables whatever that shell exports.
			const s4 = stageStaging("wrap-staging-hint");
			const r4 = s4.err ? null : runStaging(s4, OPERATOR_ENV, [], { restart: false });
			const h = r4 && r4.code === 0 ? runHint(r4.out, "wrap-staging-hint-shell") : null;
			check("without --restart, the restart command it hands out gives pm2 none of the operator variables, even run from a shell that still exports the password",
				!!h && h.restarted && !h.leaked,
				h ? `hint: ${h.hint || "(none printed)"}${h.leaked ? " — pm2 RECEIVED the password" : ""}${h.restarted ? "" : " — it did not run pm2 restart"}` : (s4.err || `exit ${r4 && r4.code}`));
			check("…and the unset reminder is printed on that path too", !!r4 && REMINDER("refresh-staging").test(r4.out));
		}
		{
			const s5 = stageStaging("wrap-staging-decoy");
			const r5 = s5.err ? null : runStaging(s5, DECOY_ENV);
			const reach5 = r5 ? passwordReach(readLog(s5.log)) : null;
			check("with an OPERATOR_PASSWORD and OPERATOR_USER of the caller's already exported, refresh-staging.sh still hands the password to the preflight and the install only",
				!!r5 && r5.code === 0 && reach5.leakedTo.length === 0 && !reach5.inArgv
					&& JSON.stringify(reach5.delivered) === JSON.stringify(["preflight", "install"]),
				r5 ? `exit ${r5.code}, ${reachDetail(reach5)}` : s5.err);
		}
		// The early gate: judged with the checkout current, before npm and pm2 run.
		{
			const s2 = stageStaging("wrap-staging-argv");
			const r2 = s2.err ? null : runStaging(s2, {}, ["--operator-password=" + OPERATOR_PW]);
			const log2 = s2.err ? "" : readLog(s2.log);
			// The one command that may see it is the preflight that refuses it.
			const sawIt = entries(log2).filter((e) => e.text.includes(OPERATOR_PW));
			check("a password typed as an argument stops refresh-staging.sh BEFORE npm or pm2 run, unechoed",
				!!r2 && r2.code !== 0 && /looks like a password given on the command line/.test(r2.out)
					&& calls(log2, "npm").length === 0 && calls(log2, "pm2").length === 0
					&& sawIt.every((e) => isPreflight(e.call)) && !r2.out.includes(OPERATOR_PW),
				r2 ? `exit ${r2.code}, ${calls(log2, "npm").length} npm, ${calls(log2, "pm2").length} pm2` : s2.err);
			const s3 = stageStaging("wrap-staging-short");
			const r3 = s3.err ? null : runStaging(s3, { REFRESH_OPERATOR_PASSWORD: "too-short" });
			check("…and so does a too-short operator password",
				!!r3 && r3.code !== 0 && /shorter than 16 characters/.test(r3.out) && calls(readLog(s3.log), "npm").length === 0,
				r3 ? `exit ${r3.code}` : s3.err);
		}

		const l = stageLocal("wrap-local");
		check("refresh-local.sh: a real sanitized artifact was prepared for the stub VPS to hand back", made.code === 0 && fs.existsSync(artifact), refusal(made.out));
		const r = runLocal(l, OPERATOR_ENV);
		const log = readLog(l.log);
		check("refresh-local.sh runs to completion in the sandbox", r.code === 0,
			r.code === 0 ? "" : r.out.split("\n").filter(Boolean).slice(-3).join(" | "));
		check("…really running ssh, scp, git and npm (so the next check has something to read)",
			calls(log, "ssh").length >= 5 && calls(log, "scp").length === 2 && calls(log, "git").length >= 1 && calls(log, "npm").length >= 2,
			`${calls(log, "ssh").length} ssh, ${calls(log, "scp").length} scp, ${calls(log, "git").length} git, ${calls(log, "npm").length} npm`);
		const reach = passwordReach(log);
		check("the operator password reaches exactly the two refresh-env.js calls meant for it, the preflight and the install, and no other command: not the dirname the script runs first, git, npm, ssh, scp (it never goes near the VPS) or the --verify call",
			reach.dirnameRan && reach.leakedTo.length === 0 && !reach.inArgv && JSON.stringify(reach.delivered) === JSON.stringify(["preflight", "install"]),
			reach.dirnameRan ? reachDetail(reach) : "dirname never ran, so this check saw nothing");
		{
			// Pinned in the source as well: no command can run above the capture.
			const lines = fs.readFileSync(LOCAL_SH, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
			const at = lines.indexOf("set -euo pipefail");
			check("refresh-local.sh moves it out of the environment before its first command: the capture is the first code after `set -euo pipefail`, and un-exports its own copies",
				at >= 0 && lines[at + 1] === 'OPERATOR_PASSWORD="${REFRESH_OPERATOR_PASSWORD-}"'
					&& lines[at + 2] === 'OPERATOR_USER="${REFRESH_OPERATOR_USER-}"'
					&& lines[at + 3] === "export -n OPERATOR_PASSWORD OPERATOR_USER"
					&& lines[at + 4] === "unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER",
				at >= 0 ? `found: ${lines.slice(at + 1, at + 5).join(" | ").slice(0, 200)}` : "no `set -euo pipefail`");
		}
		const who = accepting(path.join(l.app, "app.db"), OPERATOR_PW);
		check("…yet it DID reach the local install: exactly admin.two accepts it", JSON.stringify(who) === JSON.stringify(["admin.two"]), JSON.stringify(who));
		check("…the output never shows it, and points at prepare-test-fixtures.js for test-suite.js",
			!r.out.includes(OPERATOR_PW) && /prepare-test-fixtures\.js --yes-local-db/.test(r.out));
		check("…and it tells the operator to unset both variables in their own shell, where `npm run dev` would inherit them",
			REMINDER("refresh-local").test(r.out));
		{
			const l7 = stageLocal("wrap-local-decoy");
			const r7 = runLocal(l7, DECOY_ENV);
			const reach7 = passwordReach(readLog(l7.log));
			check("with an OPERATOR_PASSWORD and OPERATOR_USER of the caller's already exported, refresh-local.sh still hands the password to the preflight and the install only",
				r7.code === 0 && reach7.dirnameRan && reach7.leakedTo.length === 0 && !reach7.inArgv
					&& JSON.stringify(reach7.delivered) === JSON.stringify(["preflight", "install"])
					&& JSON.stringify(accepting(path.join(l7.app, "app.db"), OPERATOR_PW)) === JSON.stringify(["admin.two"]),
				`exit ${r7.code}, ${reachDetail(reach7)}`);
		}

		// The preflight runs before the first connection, so a bad password costs nothing.
		const l2 = stageLocal("wrap-local-short");
		const r2 = runLocal(l2, { REFRESH_OPERATOR_PASSWORD: "too-short" });
		check("a too-short operator password stops refresh-local.sh BEFORE any ssh connection",
			r2.code !== 0 && /shorter than 16 characters/.test(r2.out) && calls(readLog(l2.log), "ssh").length === 0,
			`exit ${r2.code}, ${calls(readLog(l2.log), "ssh").length} ssh call(s)`);

		// ⚠️ The database options are embedded in the remote ssh command, so a
		// password typed as an argument must be refused HERE, before it can
		// cross to the VPS. refresh-local.sh accepts only the options it knows,
		// so it refuses one before running any command at all, whatever its shape.
		const refusedUnechoed = (r, log) => r.code !== 0 && /argument 1 is not an option refresh-local\.sh accepts/.test(r.out)
			&& entries(log).length === 0 && !r.out.includes(OPERATOR_PW);
		const l3 = stageLocal("wrap-local-argv");
		const r3 = runLocal(l3, {}, ["--operator-password=" + OPERATOR_PW]);
		const log3 = readLog(l3.log);
		check("a password typed as an argument stops refresh-local.sh before it runs any command at all, unechoed",
			refusedUnechoed(r3, log3), `exit ${r3.code}, ${entries(log3).length} command(s) run`);
		const l5 = stageLocal("wrap-local-bare");
		const r5 = runLocal(l5, {}, [OPERATOR_PW]);
		const log5 = readLog(l5.log);
		check("…and so does one typed as a bare word, which no flag check can recognise",
			refusedUnechoed(r5, log5), `exit ${r5.code}, ${entries(log5).length} command(s) run`);
		const l4 = stageLocal("wrap-local-mode");
		const r4 = runLocal(l4, {}, ["--verify", artifact]);
		check("…and so does a stray mode flag, which would otherwise turn the preflight into a --verify",
			r4.code !== 0 && /argument 1 is not an option refresh-local\.sh accepts/.test(r4.out) && entries(readLog(l4.log)).length === 0, `exit ${r4.code}`);

		// --code-only installs no database, so the password has nowhere to go:
		// said, not silently dropped, and handed to nothing.
		const l6 = stageLocal("wrap-local-code-only");
		const r6 = runLocal(l6, OPERATOR_ENV, ["--code-only"]);
		const log6 = readLog(l6.log);
		const reach6 = passwordReach(log6);
		check("--code-only says REFRESH_OPERATOR_PASSWORD is ignored rather than dropping it silently, hands it to no command, and reminds the operator to unset it",
			r6.code === 0 && /REFRESH_OPERATOR_PASSWORD \/ REFRESH_OPERATOR_USER are ignored with --code-only/.test(r6.out)
				&& calls(log6, "npm").length >= 2 && reach6.delivered.length === 0 && reach6.leakedTo.length === 0
				&& !reach6.inArgv && !r6.out.includes(OPERATOR_PW) && REMINDER("refresh-local").test(r6.out),
			`exit ${r6.code}, ${calls(log6, "npm").length} npm, ${reachDetail(reach6)}`);
	}

	// =======================================================================
	section("5. Mutants — each guard above, removed, turns this runner red");
	{
		// prepare-test-fixtures.js. Each is applied to a REBASED copy and driven
		// with the one case ONLY that guard can see, so a neighbouring guard
		// cannot hide it (a symlink to a live app.db is caught twice over; one to
		// a backup, or a hardlink, is caught exactly once).
		const prepareMutant = (id, label, edit, caseName) => {
			const tool = rebasedPrepare(`mutant-${id}`, fakeRoot, [edit]);
			check(`${id}: ${label} — actually mutated the shipped source`, !!tool.script, tool.err);
			if (!tool.script) { check(`${id}: ${label} — is caught`, false, "not evaluated"); return; }
			const [target] = CASES[caseName];
			const before = protectedSha();
			const r = runNode(tool.script, ["--yes-local-db", target]);
			check(`${id}: ${label} — is caught`, r.code === 0 && protectedSha() !== before,
				r.code === 0 ? `the ${caseName} case was written to — section 2 fails` : `SURVIVED — ${refusal(r.out)}`);
		};
		prepareMutant("P1", "prepare's resolved-path check removed", ["if (isDeployedPath(realPath)) {", "if (false) {"], "backupSymlink");
		prepareMutant("P2", "prepare's same-file check removed (hardlink)", ["if (twin) {", "if (false) {"], "hardlink");
		prepareMutant("P3", "prepare's same-file check removed (DATABASE_PATH)", ["if (twin) {", "if (false) {"], "databasePath");

		// The wrappers.
		const UNSET = "unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER\n";
		{
			const s = stageStaging("mutant-W1", [[UNSET, ""]]);
			const r = s.err ? null : runStaging(s, OPERATOR_ENV);
			const log = s.err ? "" : readLog(s.log);
			const pm2Leak = log.split("\nEND\n").some((blk) => /^CALL pm2 <restart>/m.test(blk) && blk.includes(OPERATOR_PW));
			check("W1: refresh-staging.sh no longer unsets it — actually mutated the shipped source", !s.err, s.err);
			check("W1: refresh-staging.sh no longer unsets it — is caught", !!r && pm2Leak,
				pm2Leak ? "`pm2 restart --update-env` received the password — section 4 fails" : "SURVIVED");
		}
		{
			const s = stageStaging("mutant-W2", [['REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \\\n  "$NODE_BIN"', '"$NODE_BIN"']]);
			const r = s.err ? null : runStaging(s, OPERATOR_ENV);
			const who = r && r.code === 0 ? accepting(path.join(s.stagingDir, "app.db"), OPERATOR_PW) : null;
			check("W2: refresh-staging.sh stops handing it to refresh-env.js — actually mutated the shipped source", !s.err, s.err);
			check("W2: refresh-staging.sh stops handing it to refresh-env.js — is caught", !!who && who.length === 0,
				who && who.length === 0 ? "no account accepts it — section 4 fails" : `SURVIVED — ${JSON.stringify(who)}`);
		}
		{
			// W6: the early gate disabled — the argv password is then judged only by
			// the final install, after npm and the client build have run.
			const s = stageStaging("mutant-W6", [['"$PRE_NODE" scripts/refresh-env.js --check-env-only', "true"]]);
			const r = s.err ? null : runStaging(s, {}, ["--operator-password=" + OPERATOR_PW]);
			const npmRan = s.err ? 0 : calls(readLog(s.log), "npm").length;
			check("W6: refresh-staging.sh's early gate disabled — actually mutated the shipped source", !s.err, s.err);
			check("W6: refresh-staging.sh's early gate disabled — is caught", !!r && npmRan > 0,
				npmRan > 0 ? `npm ran ${npmRan}× with a password in the wrapper's argv — section 4 fails` : `SURVIVED — exit ${r && r.code}`);
		}
		{
			const s = stageLocal("mutant-W3", [[UNSET, ""]]);
			const r = s.err ? null : runLocal(s, OPERATOR_ENV);
			const log = s.err ? "" : readLog(s.log);
			const leakedTo = [...new Set(log.split("\nEND\n").filter((blk) => blk.includes(OPERATOR_PW))
				.map((blk) => (blk.match(/^CALL (\S+)/m) || ["", "?"])[1]))];
			check("W3: refresh-local.sh no longer unsets it — actually mutated the shipped source", !s.err, s.err);
			check("W3: refresh-local.sh no longer unsets it — is caught", !!r && leakedTo.includes("ssh"),
				leakedTo.length ? `received by: ${leakedTo.join(", ")} — section 4 fails` : "SURVIVED");
		}
		{
			const s = stageLocal("mutant-W4", [[
				'REFRESH_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" REFRESH_OPERATOR_USER="$OPERATOR_USER" \\\n  node scripts/refresh-env.js --from',
				"node scripts/refresh-env.js --from",
			]]);
			const r = s.err ? null : runLocal(s, OPERATOR_ENV);
			const who = r && r.code === 0 ? accepting(path.join(s.app, "app.db"), OPERATOR_PW) : null;
			check("W4: refresh-local.sh stops handing it to the install — actually mutated the shipped source", !s.err, s.err);
			check("W4: refresh-local.sh stops handing it to the install — is caught", !!who && who.length === 0,
				who && who.length === 0 ? "no account accepts it — section 4 fails" : `SURVIVED — ${JSON.stringify(who)}`);
		}
		{
			// W5: refresh-local.sh's argument allowlist removed — a password typed
			// as a bare word (no flag for refresh-env.js to recognise) then rides
			// the remote ssh command to the VPS. (That the preflight still sees
			// the same options as the remote call is test-refresh-remote-node.js's
			// M9.)
			const s = stageLocal("mutant-W5", [['*) refuse_argument "$argn" ;;', '*) EXTRA_ARGS+=("$1") ;;']]);
			const r = s.err ? null : runLocal(s, {}, [OPERATOR_PW]);
			const log = s.err ? "" : readLog(s.log);
			const sshLeak = log.split("\nEND\n").some((blk) => /^CALL ssh/m.test(blk) && blk.includes(OPERATOR_PW));
			check("W5: refresh-local.sh's argument allowlist removed — actually mutated the shipped source", !s.err, s.err);
			check("W5: refresh-local.sh's argument allowlist removed — is caught", !!r && sshLeak,
				sshLeak ? "a password typed as a bare word reached the ssh command line — section 4 fails" : `SURVIVED — exit ${r && r.code}`);
		}
		{
			// W7: the capture moved back below the APP_DIR line — the `dirname`
			// there then runs with the password still in its environment. The
			// whole block moves, so nothing left above the APP_DIR line reads
			// the variables before they exist.
			const CAPTURE = [
				'OPERATOR_PASSWORD="${REFRESH_OPERATOR_PASSWORD-}"',
				'OPERATOR_USER="${REFRESH_OPERATOR_USER-}"',
				"export -n OPERATOR_PASSWORD OPERATOR_USER",
				"unset REFRESH_OPERATOR_PASSWORD REFRESH_OPERATOR_USER",
				"OPERATOR_REQUESTED=0",
				'[ -z "$OPERATOR_PASSWORD$OPERATOR_USER" ] || OPERATOR_REQUESTED=1',
			].join("\n") + "\n";
			const s = stageLocal("mutant-W7", [[CAPTURE, ""], ['cd "$APP_DIR"\n', `cd "$APP_DIR"\n${CAPTURE}`]]);
			const r = s.err ? null : runLocal(s, OPERATOR_ENV);
			const leakedTo = s.err ? [] : passwordReach(readLog(s.log)).leakedTo;
			check("W7: refresh-local.sh captures it only after its first command — actually mutated the shipped source", !s.err, s.err);
			check("W7: refresh-local.sh captures it only after its first command — is caught", !!r && leakedTo.includes("dirname"),
				leakedTo.includes("dirname") ? "dirname received the password — section 4 fails" : `SURVIVED — leaked to [${leakedTo}]`);
		}
		// W8/W9: `export -n` removed — with a caller that already exports an
		// OPERATOR_PASSWORD of its own, the real password then reaches every child.
		const EXPORT_N = "export -n OPERATOR_PASSWORD OPERATOR_USER\n";
		for (const [id, stage, run, label] of [
			["W8", stageLocal, runLocal, "refresh-local.sh"],
			["W9", stageStaging, runStaging, "refresh-staging.sh"],
		]) {
			const s = stage(`mutant-${id}`, [[EXPORT_N, ""]]);
			const r = s.err ? null : run(s, DECOY_ENV);
			const leakedTo = s.err ? [] : passwordReach(readLog(s.log)).leakedTo;
			check(`${id}: ${label} no longer un-exports its copies — actually mutated the shipped source`, !s.err, s.err);
			check(`${id}: ${label} no longer un-exports its copies — is caught`, !!r && leakedTo.length > 0,
				leakedTo.length ? `the password reached: ${leakedTo.join(", ")} — section 4 fails` : "SURVIVED");
		}
		{
			// W10: the restart hint as it was — a bare `pm2 restart --update-env`.
			const s = stageStaging("mutant-W10", [[
				'say "When ready:  env -u REFRESH_OPERATOR_PASSWORD -u REFRESH_OPERATOR_USER pm2 restart $PM2_NAME --update-env"',
				'say "When ready:  pm2 restart $PM2_NAME --update-env"',
			]]);
			const r = s.err ? null : runStaging(s, OPERATOR_ENV, [], { restart: false });
			const h = r && r.code === 0 ? runHint(r.out, "mutant-W10-shell") : null;
			check("W10: refresh-staging.sh hands out a bare `pm2 restart --update-env` — actually mutated the shipped source", !s.err, s.err);
			check("W10: refresh-staging.sh hands out a bare `pm2 restart --update-env` — is caught", !!h && h.restarted && h.leaked,
				h && h.leaked ? "pm2 received the password from the operator's shell — section 4 fails" : `SURVIVED — ${h ? h.hint : `exit ${r && r.code}`}`);
		}
	}

	finish();
})();
