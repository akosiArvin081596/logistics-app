#!/usr/bin/env node
/**
 * scripts/shared-login-report.js, the read-only report before the named-login
 * flags go on (--mode=before-flags) and before the shared login is disabled
 * (--mode=before-disable, checks C1-C6).
 *
 *   §1 before-flags on a made-up database: the Super Admins by id (created,
 *      last sign-in, must change password); emails on several accounts (by
 *      role, staff ids only); a username that is another account's email;
 *      usernames that differ only in case; sign-ins to expect a day; the rows
 *      that would read "shared login"; 0 rows the POST change touches
 *   §2 before-disable: every check passes on a database ready for it, and
 *      each check fails when its own condition breaks (C2 fails only with C1,
 *      which implies it; C6 only with C1, which needs the same account; C4
 *      reports the shared login's live sessions and never fails)
 *   §3 the output holds ids and counts only: no username, email, IP or
 *      browser, in text or JSON, in either mode
 *   §4 read-only: the database file is byte for byte unchanged; a bad argument
 *      is refused (exit 2)
 *
 * Hermetic: a scratch database under the OS temp folder, the script run as a
 * child process. Made-up accounts, example.test emails, a 203.0.113.x address.
 * Run: node scripts/test-shared-login-report.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "shared-login-report.js");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const Database = require("better-sqlite3");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-shared-login-report."));
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const tableDdl = (name) => {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
};
// What must never be printed.
const SECRETS = ["super_admin", "owner_named", "arvin_named", "spare_admin", "disp.one", "disp.two", "dan.driver", "inv.one",
	"example.test", "boss@", "203.0.113.", "NamedLoginsTest"];

// A database ready for the disable: #7 and #8 named, signed in, password
// changed; #1 (the shared login) unused for 20 days; a spare Super Admin #9.
let n = 0;
function makeDb(tweak = () => {}) {
	const file = path.join(SANDBOX, `app-${++n}.db`);
	const db = new Database(file);
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL,
		driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP, must_change_password INTEGER DEFAULT 0, last_login_at TEXT DEFAULT '')`);
	db.exec("CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT)");
	db.exec(tableDdl("audit_trail"));
	db.exec("CREATE TABLE invoices (id INTEGER PRIMARY KEY, created_by TEXT DEFAULT '')");
	const u = db.prepare("INSERT INTO users (id, username, password_hash, role, email, full_name, must_change_password, last_login_at) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)");
	u.run(1, "super_admin", "Super Admin", "boss@example.test", "Shared Login", 0, iso(20 * DAY));
	u.run(7, "owner_named", "Super Admin", "Boss@Example.test", "Owner Person", 0, iso(1 * DAY));
	u.run(8, "arvin_named", "Super Admin", "arvin@example.test", "Arvin Person", 0, iso(2 * DAY));
	u.run(9, "spare_admin", "Super Admin", "", "", 0, "");
	u.run(20, "disp.one", "Dispatcher", "disp@example.test", "", 0, iso(3 * DAY));
	u.run(21, "Disp.One", "Dispatcher", "", "", 0, "");
	u.run(30, "dan.driver", "Driver", "disp@example.test", "Dan Driver", 0, iso(1 * DAY));
	u.run(40, "inv.one", "Investor", "", "", 0, "");
	u.run(41, "arvin@example.test", "Investor", "", "", 0, "");
	const s = db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)");
	const sess = (id, role, signedInAgo, maxAge = DAY) => {
		const expires = Date.now() - signedInAgo + maxAge;
		return [JSON.stringify({ cookie: { originalMaxAge: maxAge, expires: new Date(expires).toISOString() }, user: { id, role } }), new Date(expires).toISOString()];
	};
	s.run("s1", ...sess(7, "Super Admin", 2 * 60 * 60 * 1000));
	s.run("s2", ...sess(20, "Dispatcher", 3 * 60 * 60 * 1000));
	s.run("s3", ...sess(30, "Driver", 5 * 60 * 60 * 1000));
	s.run("s4", ...sess(1, "Super Admin", 30 * 60 * 60 * 1000)); // expired: signed in 30 h ago, a 24 h cookie
	const a = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)");
	a.run(iso(40 * DAY), 1, "super_admin", "Super Admin", "create_user", "x", "made up");
	a.run(iso(10 * DAY), 0, "super_admin", "Super Admin", "update_user", "y", "made up");
	a.run(iso(5 * DAY), 7, "owner_named", "Super Admin", "login", "7", "Signed in by username");
	db.prepare("INSERT INTO invoices (created_by) VALUES ('super_admin'), (' Super_Admin '), ('owner_named')").run();
	tweak(db);
	db.close();
	return file;
}
function run(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60000 });
	return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "" };
}
function json(r) {
	try { return JSON.parse(r.stdout); } catch { return null; }
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const leaks = (text) => SECRETS.filter((s) => text.toLowerCase().includes(s.toLowerCase()));
const outputs = [];

try {
	ok(fs.existsSync(SCRIPT), "scripts/shared-login-report.js must exist");

	console.log("§1 before-flags");
	{
		const file = makeDb();
		const before = sha(file);
		const r = run([`--db=${file}`, "--mode=before-flags", "--json"]);
		const t = run([`--db=${file}`, "--mode=before-flags"]);
		outputs.push(r.out, t.out);
		const o = json(r) || {};
		ok(r.status === 0 && t.status === 0, `§1 runs (exit ${r.status}/${t.status}: ${r.out.slice(0, 200)})`);
		const sa = (o.superAdmins || []).map((x) => x.id);
		ok(JSON.stringify(sa) === "[1,7,8,9]", `§1 the Super Admins by id: ${JSON.stringify(sa)}`);
		const s7 = (o.superAdmins || []).find((x) => x.id === 7) || {};
		ok(!!s7.lastSignIn && s7.mustChangePassword === false && "created" in s7, `§1 ...with created, last sign-in and must change password: ${JSON.stringify(s7)}`);
		const se = o.sharedEmails || {};
		ok(se.groups === 2 && se.accounts === 4 && JSON.stringify(se.staffIds) === "[1,7,20]" && se.byRole && se.byRole.Driver === 1,
			`§1 emails on several accounts: 2 emails, 4 accounts, staff ids 1, 7, 20 and the driver counted only: ${JSON.stringify(se)}`);
		const ue = o.usernameIsAnothersEmail || {};
		ok(ue.pairs === 1 && JSON.stringify(ue.staffIds) === "[8]", `§1 a username that is another account's email: ${JSON.stringify(ue)}`);
		const cv = o.usernamesDifferingOnlyInCase || {};
		ok(cv.accounts === 2 && JSON.stringify(cv.staffIds) === "[20,21]", `§1 usernames that differ only in case: ${JSON.stringify(cv)}`);
		const e = o.expectedSignInRowsPerDay || {};
		ok(e.sessionsStartedLast24h === 3 && e.staffNetworkRecords === 2 && e.byRole && e.byRole.Driver === 1,
			`§1 sign-ins to expect a day, from the sessions started in 24 h: ${JSON.stringify(e)}`);
		const sl = o.sharedLoginRows || {};
		ok(sl.audit_trail === 2 && sl.audit_trail_without_account_id === 1 && sl["invoices.created_by"] === 2 && sl["investor_payout_basis.created_by"] === null,
			`§1 the rows that would read "shared login", per table: ${JSON.stringify(sl)}`);
		ok(o.existingRowsThePostChangeTouches === 0, "§1 ...and the existing rows the POST change touches: 0");
		ok(sha(file) === before, "§4 before-flags leaves the database file unchanged");
	}

	console.log("§2 before-disable");
	const disable = (tweak, named = "7,8") => {
		const file = makeDb(tweak);
		const before = sha(file);
		const r = run([`--db=${file}`, "--mode=before-disable", `--named=${named}`, "--json"]);
		const t = run([`--db=${file}`, "--mode=before-disable", `--named=${named}`]);
		outputs.push(r.out, t.out);
		const o = json(r) || { checks: {} };
		const pass = Object.fromEntries(Object.entries(o.checks || {}).map(([k, v]) => [k, v.pass]));
		return { r, t, o, pass, unchanged: sha(file) === before };
	};
	const only = (got, failing) => ["C1", "C2", "C3", "C4", "C5", "C6"].every((k) => got[k] === !failing.includes(k));
	{
		const d = disable();
		ok(d.r.status === 0 && only(d.pass, []), `§2 a database ready for the disable: every check passes, exit 0 (exit ${d.r.status}, ${JSON.stringify(d.pass)})`);
		ok(d.o.checks.C4 && d.o.checks.C4.liveSessions === 0, `§2 C4 reports the shared login's live sessions (its only session expired): ${JSON.stringify(d.o.checks.C4)}`);
		ok(/C1 PASS/.test(d.t.out) && /All checks pass/.test(d.t.out), "§2 ...and the text says so");
		ok(d.unchanged, "§4 before-disable leaves the database file unchanged");
	}
	for (const [label, tweak, failing, named] of [
		["C1: a named account must still change its password", (db) => db.prepare("UPDATE users SET must_change_password = 1 WHERE id = 8").run(), ["C1"]],
		["C1: a named account last signed in 10 days ago", (db) => db.prepare("UPDATE users SET last_login_at = ? WHERE id = 8").run(iso(10 * DAY)), ["C1"]],
		["C1 and C2: no named account signed in within 7 days", (db) => {
			db.prepare("UPDATE users SET last_login_at = ? WHERE id IN (7, 8)").run(iso(10 * DAY));
			db.prepare("DELETE FROM audit_trail WHERE action = 'login'").run();
		}, ["C1", "C2"]],
		["C3: the shared login signed in 3 days ago", (db) => db.prepare("UPDATE users SET last_login_at = ? WHERE id = 1").run(iso(3 * DAY)), ["C3"]],
		["C3: a `login` row for the shared login 5 days ago", (db) => db.prepare(
			"INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', 'login', 'user', '1', 'Signed in by email')").run(iso(5 * DAY)), ["C3"]],
		["C5: one named account and no spare", (db) => db.prepare("DELETE FROM users WHERE id IN (8, 9)").run(), ["C5"], "7"],
		["C1 and C6: a named id the reset script cannot find", () => {}, ["C1", "C6"], "7,99"],
	]) {
		const d = disable(tweak, named);
		ok(d.r.status === 1 && only(d.pass, failing), `§2 ${label}: ${failing.join(" and ")} fail${failing.length === 1 ? "s" : ""}, every other check passes, exit 1 (exit ${d.r.status}, ${JSON.stringify(d.pass)})`);
		ok(failing.every((k) => new RegExp(`${k} FAIL`).test(d.t.out)) && /A check failed/.test(d.t.out), `§2 ${label}: ...and the text says which`);
	}
	{
		const d = disable((db) => {
			const sess = JSON.stringify({ cookie: { originalMaxAge: DAY, expires: new Date(Date.now() + DAY / 2).toISOString() }, user: { id: 1, role: "Super Admin" } });
			db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s5', ?, ''), ('s6', ?, '')").run(sess, sess);
		});
		ok(d.o.checks.C4 && d.o.checks.C4.liveSessions === 2 && d.pass.C4 === true && d.pass.C3 === true,
			`§2 C4 counts the shared login's live sessions and never fails on them: ${JSON.stringify(d.o.checks.C4)}`);
	}

	console.log("§3 ids and counts only");
	const all = outputs.join("\n");
	ok(outputs.length >= 10 && leaks(all).length === 0, `§3 no output holds a username, email, name, IP or browser (found ${JSON.stringify(leaks(all))})`);

	console.log("§4 refused arguments");
	const file = makeDb();
	for (const [label, args] of [
		["no --db", ["--mode=before-flags"]],
		["an unknown mode", [`--db=${file}`, "--mode=after"]],
		["before-disable without --named", [`--db=${file}`, "--mode=before-disable"]],
		["--named that is not ids", [`--db=${file}`, "--mode=before-disable", "--named=owner_named"]],
		["the shared login named", [`--db=${file}`, "--mode=before-disable", "--named=1,7"]],
		["a stray argument", [`--db=${file}`, "--mode=before-flags", "extra"]],
	]) {
		const r = run(args);
		ok(r.status === 2, `§4 ${label}: refused, exit 2 (exit ${r.status}: ${r.out.slice(0, 120)})`);
	}
} finally {
	fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
