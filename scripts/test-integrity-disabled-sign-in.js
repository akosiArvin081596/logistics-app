#!/usr/bin/env node
/**
 * Check 11 of the daily integrity check (lib/integrity-check.js
 * disabledAccountSignIns()): a disabled account whose last sign-in is later than
 * its disable is reported by the first run after that sign-in. Only code that
 * ignores the disable lets a disabled account sign in, so a finding means such
 * code ran (a rollback). Report only.
 *
 * WHAT IS ASSERTED:
 *   §1 the check: named, a disabled account signed in after its disable; not
 *      named, one signed in before it, one never signed in, an enabled one
 *   §2 the email and the log line name the account by id and role, never by
 *      username, with both instants on the business clock
 *   §3 once per sign-in: the next recorded run does not name it again; a later
 *      sign-in is named again; a run whose email failed is repeated and names
 *      it; the lib writes no table of its own for it
 *   §4 a users table with no disabled_at column: nothing named, nothing said,
 *      and a clean run's log line does not mention the check
 *
 * Hermetic: in-memory SQLite, made-up accounts and one made-up load.
 *   node scripts/test-integrity-disabled-sign-in.js    # exits 1 on failure
 */
"use strict";

const SRC = require("./lib/server-source").serverSource();

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const ic = require("../lib/integrity-check");

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const periodDef = SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/);
if (!periodDef) { console.error("FAILED: EXPENSE_PERIOD_EXPR not found in server.js"); process.exit(1); }
const EXPENSE_PERIOD_EXPR = JSON.parse(periodDef[1]);
const ADMIN = "admin@example.test";
const JT = Object.freeze({
	headers: ["Load ID", "Pickup Appointment", "Assigned Date"],
	data: [{ _rowIndex: 2, "Load ID": "QA-LOAD-1", "Pickup Appointment": "10/20/2026 8:00 AM", "Assigned Date": "10/19/2026 9:00:00" }],
});

function makeDb({ disableColumns = true } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT NOT NULL DEFAULT 'd', type TEXT NOT NULL DEFAULT 'Fuel',
			amount REAL NOT NULL DEFAULT 10, date TEXT NOT NULL, status TEXT DEFAULT 'Pending',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, last_login_at TEXT DEFAULT ''
			${disableColumns ? ", disabled_at TEXT DEFAULT NULL, disabled_by INTEGER DEFAULT NULL, disabled_reason TEXT DEFAULT NULL" : ""});
	`);
	const ins = db.prepare("INSERT INTO users (id, username, role, last_login_at) VALUES (?, ?, ?, ?)");
	ins.run(7, "owner_named", "Super Admin", "2026-10-21T16:30:00.000Z");
	ins.run(8, "arvin_named", "Super Admin", "2026-10-19T12:00:00.000Z");
	ins.run(9, "desk_sa", "Super Admin", "2026-10-21T09:00:00.000Z");
	ins.run(20, "desk_one", "Dispatcher", "");
	if (disableColumns) {
		const dis = db.prepare("UPDATE users SET disabled_at = ?, disabled_by = 9 WHERE id = ?");
		dis.run("2026-10-20T14:00:00.000Z", 7); // signed in after its disable: named
		dis.run("2026-10-20T14:00:00.000Z", 8); // signed in before it: not named
		dis.run("2026-10-20T14:00:00.000Z", 20); // never signed in: not named
	}
	return db;
}
function mailSpy(result = true) {
	const calls = [];
	const fn = async (to, subject, html) => { calls.push({ to, subject, html }); return result; };
	fn.calls = calls;
	return fn;
}
function quietLog() {
	const lines = [];
	return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}
async function run(db, { now = "2026-10-22T12:00:30Z", sendEmail = mailSpy(), write = true } = {}) {
	const log = quietLog();
	const result = await ic.runIntegrityCheck({
		db, now: new Date(now), write, sendEmail, to: ADMIN, log,
		readJobTracking: async () => JT,
		expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		appZone: "America/New_York",
	});
	return { result, log, sendEmail };
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const named = (r) => ((r.result.report || {}).disabledSignIns || { accounts: [] }).accounts.map((a) => a.id);

(async () => {
	const present = typeof ic.disabledAccountSignIns === "function";
	ok("§1 disabledAccountSignIns() is exported", present);
	if (!present) return;

	console.log("§1 the check");
	{
		const db = makeDb();
		const r = ic.disabledAccountSignIns(db);
		ok("§1 named: the disabled account that signed in after its disable, by id and role",
			JSON.stringify(r.accounts.map((a) => [a.id, a.role, a.disabledAt, a.lastLoginAt])) ===
				JSON.stringify([[7, "Super Admin", "2026-10-20T14:00:00.000Z", "2026-10-21T16:30:00.000Z"]]), r.accounts);
		ok("§1 not named: signed in before its disable, never signed in, or enabled", !r.accounts.some((a) => [8, 9, 20].includes(a.id)));
		ok("§1 a sign-in no later than `since` is not named again",
			ic.disabledAccountSignIns(db, { since: "2026-10-21T16:30:00.000Z" }).accounts.length === 0 &&
			ic.disabledAccountSignIns(db, { since: "2026-10-21T16:29:59.999Z" }).accounts.length === 1);
	}

	console.log("§2 the email and the log line");
	{
		const db = makeDb();
		const first = await run(db);
		const html = first.sendEmail.calls.length ? first.sendEmail.calls[0].html : "";
		const text = first.result.mail ? first.result.mail.text : "";
		ok("§2 one email to ADMIN_NOTIFY_EMAIL with the section and its count",
			first.sendEmail.calls.length === 1 && first.sendEmail.calls[0].to === ADMIN && /Disabled account signed in \(1\)/.test(html), first.sendEmail.calls.length);
		ok("§2 the line names the account by id and role, with both instants in Eastern time",
			/Account #7 \(Super Admin\)/.test(text) && /Oct(ober)? 20, 2026/.test(text) && /10:00\s?AM/.test(text) && /12:30\s?PM/.test(text), text);
		ok("§2 ...and never its username", !/owner_named/.test(text) && !/owner_named/.test(html));
		const line = first.log.lines.join("\n");
		ok("§2 the log line names the account by id", /disabled account signed in after its disable: account #7/.test(line), line);
	}

	console.log("§3 once per sign-in");
	{
		const db = makeDb();
		const before = tables(db);
		const first = await run(db);
		ok("§3 the first run names it", JSON.stringify(named(first)) === JSON.stringify([7]), named(first));
		ok("§3 the lib writes no table of its own for this check",
			tables(db).filter((t) => !before.includes(t)).every((t) => /^integrity_check_(loads|receipts|invoiced_payments|reissue_gave_up|invoice_rates)$/.test(t)), tables(db));
		const second = await run(db, { now: "2026-10-23T12:00:30Z" });
		ok("§3 the next recorded run does not name it again", named(second).length === 0 && !/Account #7/.test(second.result.mail ? second.result.mail.text : ""), named(second));
		db.prepare("UPDATE users SET last_login_at = ? WHERE id = 7").run("2026-10-23T18:00:00.000Z");
		const third = await run(db, { now: "2026-10-24T12:00:30Z" });
		ok("§3 a later sign-in is named again", JSON.stringify(named(third)) === JSON.stringify([7]), named(third));

		const retryDb = makeDb();
		await run(retryDb);
		retryDb.prepare("UPDATE users SET last_login_at = ? WHERE id = 7").run("2026-10-22T18:00:00.000Z");
		const failed = await run(retryDb, { now: "2026-10-23T12:00:30Z", sendEmail: mailSpy(false) });
		const retried = await run(retryDb, { now: "2026-10-23T12:15:30Z" });
		ok("§3 a run whose email failed is not recorded, and its retry names the sign-in",
			failed.result.ok === false && JSON.stringify(named(retried)) === JSON.stringify([7]) && retried.sendEmail.calls.length === 1, named(retried));
	}

	console.log("§4 an older users table");
	{
		const db = makeDb({ disableColumns: false });
		const r = ic.disabledAccountSignIns(db);
		ok("§4 no disabled_at column: nothing named", r.accounts.length === 0, r);
		const clean = await run(db);
		const line = clean.log.lines.join("\n");
		ok("§4 ...nothing said, in the email or the log line", clean.sendEmail.calls.length === 0 && !/disabled account/i.test(line), line);
		const none = makeDb();
		none.prepare("UPDATE users SET disabled_at = NULL").run();
		const quiet = await run(none);
		ok("§4 with no finding the log line does not mention the check", !/disabled account/i.test(quiet.log.lines.join("\n")), quiet.log.lines);
	}
})().then(() => {
	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
}, (e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
