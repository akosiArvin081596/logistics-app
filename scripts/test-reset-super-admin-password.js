#!/usr/bin/env node
/**
 * scripts/reset-super-admin-password.js resets ONE Super Admin's password: it
 * ends that account's sessions only, writes one system audit row, and has a
 * dry run that writes nothing.
 *
 *   §1 the default target is super_admin: the e2e harness's call (a database
 *      path and NEW_PASSWORD, scripts/e2e/setup-db.cjs) still works and still
 *      prints its "OK" and "user id=" lines
 *   §2 --dry-run prints the id, the role and the sessions a reset would end,
 *      needs no NEW_PASSWORD and leaves the file byte for byte as it was
 *   §3 --id and --username each change that one account's password only
 *   §4 only that account's sessions end; every other account stays signed in
 *   §5 one system audit row: user 0, "system: reset-super-admin-password",
 *      role system, action reset_password_script, the account id, no password
 *      and no hash
 *   §6 refusals write nothing: a target that is not a Super Admin, an unknown
 *      id or username, --id with --username, a NEW_PASSWORD under 16
 *      characters, a database with no audit_trail table
 *   §7 no output, in any mode, holds the password
 *
 * Hermetic: made-up accounts in a scratch database under the OS temp folder,
 * the script run as a child process. No app.db, no network.
 * Run: node scripts/test-reset-super-admin-password.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "reset-super-admin-password.js");
const SRC = require("./lib/server-source").serverSource();
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-reset-sa."));
const NEW_PASSWORD = "Reset-Made-Up-Pass-2026!";
const OLD = { 1: "Shared-Old-Pass-1!", 7: "Owner-Old-Pass-7!", 8: "Arvin-Old-Pass-8!", 20: "Disp-Old-Pass-20!" };
const AUDIT_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) throw new Error("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
})();

let n = 0;
function makeDb({ withAudit = true } = {}) {
	const file = path.join(SANDBOX, `app-${++n}.db`);
	const db = new Database(file);
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL,
		driver_name TEXT DEFAULT '', email TEXT DEFAULT '', must_change_password INTEGER DEFAULT 0)`);
	db.exec("CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT)");
	if (withAudit) db.exec(AUDIT_CREATE);
	const u = db.prepare("INSERT INTO users (id, username, password_hash, role, email) VALUES (?, ?, ?, ?, ?)");
	u.run(1, "super_admin", bcrypt.hashSync(OLD[1], 4), "Super Admin", "boss@example.test");
	u.run(7, "owner_named", bcrypt.hashSync(OLD[7], 4), "Super Admin", "boss@example.test");
	u.run(8, "arvin_named", bcrypt.hashSync(OLD[8], 4), "Super Admin", "arvin@example.test");
	u.run(20, "disp.one", bcrypt.hashSync(OLD[20], 4), "Dispatcher", "disp@example.test");
	const s = db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)");
	const sess = (id) => JSON.stringify({ cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 3600000).toISOString() }, user: { id } });
	s.run("sid-1a", sess(1), new Date(Date.now() + 3600000).toISOString());
	s.run("sid-7a", sess(7), new Date(Date.now() + 3600000).toISOString());
	s.run("sid-7b", sess(7), new Date(Date.now() + 3600000).toISOString());
	s.run("sid-8a", sess(8), new Date(Date.now() + 3600000).toISOString());
	s.run("sid-20a", sess(20), new Date(Date.now() + 3600000).toISOString());
	db.close();
	return file;
}
function run(args, { password = NEW_PASSWORD } = {}) {
	const env = { ...process.env };
	delete env.NEW_PASSWORD;
	if (password !== null) env.NEW_PASSWORD = password;
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 60000 });
	return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function read(file) {
	const db = new Database(file, { readonly: true });
	try {
		return {
			hashes: Object.fromEntries(db.prepare("SELECT id, password_hash FROM users").all().map((r) => [r.id, r.password_hash])),
			sessions: db.prepare("SELECT sid FROM sessions ORDER BY sid").all().map((r) => r.sid),
			audit: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_trail'").get()
				? db.prepare("SELECT * FROM audit_trail ORDER BY id").all() : [],
		};
	} finally { db.close(); }
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const isNew = (hash) => !!hash && bcrypt.compareSync(NEW_PASSWORD, hash);
const isOld = (hashes, id) => bcrypt.compareSync(OLD[id], hashes[id]);
const outputs = [];

try {
	console.log("§1 the default target");
	{
		const file = makeDb();
		const r = run([file]);
		outputs.push(r.out);
		const after = read(file);
		ok(r.status === 0, `§1 the e2e harness's call succeeds (exit ${r.status}: ${r.out.slice(0, 200)})`);
		ok(isNew(after.hashes[1]) && isOld(after.hashes, 7) && isOld(after.hashes, 8) && isOld(after.hashes, 20),
			"§1 ...resetting super_admin's password and no other");
		ok(r.out.split("\n").some((l) => /^OK/.test(l.trim())) && /user id=1, role=Super Admin/.test(r.out),
			"§1 ...printing the OK and user id= lines setup-db.cjs logs");
	}

	console.log("§2 --dry-run");
	{
		const file = makeDb();
		const before = sha(file);
		const r = run(["--dry-run", "--id", "7", file], { password: null });
		outputs.push(r.out);
		ok(r.status === 0, `§2 a dry run succeeds without NEW_PASSWORD (exit ${r.status}: ${r.out.slice(0, 200)})`);
		ok(/id=7/.test(r.out) && /Super Admin/.test(r.out) && /end:? 2\b/.test(r.out), `§2 ...printing the id, the role and the 2 sessions a reset would end: ${JSON.stringify(r.out)}`);
		ok(sha(file) === before, "§2 ...and the database file is byte for byte unchanged");
		const d = run(["--dry-run", file], { password: null });
		outputs.push(d.out);
		ok(d.status === 0 && /id=1/.test(d.out), "§2 a dry run with no target names super_admin");
	}

	console.log("§3 --id and --username");
	{
		const file = makeDb();
		const r = run(["--id", "7", file]);
		outputs.push(r.out);
		const after = read(file);
		ok(r.status === 0 && isNew(after.hashes[7]), `§3 --id 7 resets #7 (exit ${r.status}: ${r.out.slice(0, 200)})`);
		ok(isOld(after.hashes, 1) && isOld(after.hashes, 8) && isOld(after.hashes, 20), "§3 ...and no other account");

		const file2 = makeDb();
		const r2 = run(["--username", "arvin_named", file2]);
		outputs.push(r2.out);
		const after2 = read(file2);
		ok(r2.status === 0 && isNew(after2.hashes[8]) && isOld(after2.hashes, 1) && isOld(after2.hashes, 7),
			`§3 --username arvin_named resets #8 only (exit ${r2.status})`);
		const r3 = run(["--id=8", file2]);
		outputs.push(r3.out);
		ok(r3.status === 0, "§3 --id=8 is the same as --id 8");

		console.log("§4 only that account's sessions");
		ok(JSON.stringify(after.sessions) === JSON.stringify(["sid-1a", "sid-20a", "sid-8a"]),
			`§4 resetting #7 ends #7's two sessions and no other: ${JSON.stringify(after.sessions)}`);
		ok(/Ended 2 session/.test(r.out), "§4 ...and says how many it ended");

		console.log("§5 one system audit row");
		const rows = after.audit;
		const a = rows[0] || {};
		ok(rows.length === 1, `§5 one audit row per reset (got ${rows.length})`);
		ok(a.user_id === 0 && a.username === "system: reset-super-admin-password" && a.role === "system" &&
			a.action === "reset_password_script" && a.entity === "user" && a.entity_id === "7",
			`§5 ...a system row naming the account by id: ${JSON.stringify(a)}`);
		ok(/sessions ended: 2/.test(a.details || ""), `§5 ...with the sessions it ended: ${JSON.stringify(a.details)}`);
		ok(!String(a.details).includes(NEW_PASSWORD) && !/\$2[aby]\$/.test(String(a.details)), "§5 ...and no password and no hash");
	}

	console.log("§6 refusals write nothing");
	for (const [label, args, opts] of [
		["a Dispatcher (--id 20)", ["--id", "20"], {}],
		["an unknown id", ["--id", "99"], {}],
		["an unknown username", ["--username", "nobody_here"], {}],
		["--id with --username", ["--id", "7", "--username", "arvin_named"], {}],
		["a NEW_PASSWORD under 16 characters", ["--id", "7"], { password: "Short-Pass-1!" }],
		["no NEW_PASSWORD", ["--id", "7"], { password: null }],
	]) {
		const file = makeDb();
		const before = sha(file);
		const r = run([...args, file], opts);
		outputs.push(r.out);
		ok(r.status !== 0 && sha(file) === before, `§6 ${label}: refused, the file unchanged (exit ${r.status}: ${r.out.slice(0, 160)})`);
	}
	{
		const file = makeDb({ withAudit: false });
		const before = sha(file);
		const r = run(["--id", "7", file]);
		outputs.push(r.out);
		ok(r.status !== 0 && sha(file) === before && /audit/i.test(r.out),
			`§6 a database with no audit_trail table: refused, nothing written (exit ${r.status}: ${r.out.slice(0, 160)})`);
	}

	console.log("§7 the output");
	ok(outputs.length > 0 && outputs.every((o) => !o.includes(NEW_PASSWORD) && !o.includes("Short-Pass-1!")),
		"§7 no output in any mode holds the password");
} finally {
	fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
