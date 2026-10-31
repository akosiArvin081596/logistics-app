#!/usr/bin/env node
/**
 * scripts/owner-operator-report.js, the read-only counts to run on production data
 * before each owner-operator switch-on.
 *
 *   §1 refusals (exit 2): no --db, --db with no path, a missing file, a database
 *      outside the temp directory and the app's own; nothing is created
 *   §2 every count on a made-up database built with the module's own schema
 *   §3 the output, text and JSON, holds counts, statuses and hashes only: no
 *      made-up name, VIN, plate or address
 *   §4 read-only: the file is byte-for-byte unchanged and no sidecar appears
 *   §5 a database from before the tables: each reads absent and the run succeeds
 *   §6 the fingerprints move with a live invoice's total or a closed month's item,
 *      and not with an open month's
 *
 * Databases are made-up, in a mkdtemp folder under the temp directory.
 * Run: node scripts/test-owner-operator-report.js   # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "owner-operator-report.js");
let oo = null;
try { oo = require(path.join(ROOT, "lib", "owner-operator.js")); } catch { oo = null; }

let passed = 0;
let failed = 0;
const ok = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok    ${name}`); return; }
	failed++;
	console.log(`  FAIL  ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oo-report-test-")));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const run = (args) => {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, timeout: 30000 });
	return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
};
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Values that must never reach the output.
const PRIVATE = ["Jordan Madeup", "Casey Sampleton", "Riley Fixture", "Sky Testcase", "Morgan Percent", "Avery Fixed", "12 Madeup Lane",
	"1M8GDM9AXKP042788", "MADEUP1", "3AKJHHDR5JSJV4321", "OOX4821", "Madeup Hauling LLC", "1FUJGLDR7CLBP8834", "PLT7781", "Quinn Madeup"];

function buildDb(file, { ownerOperatorTables }) {
	const db = new Database(file);
	db.pragma("journal_mode = DELETE");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, owner_id INTEGER DEFAULT 0, truck_unit TEXT DEFAULT '');
		CREATE TABLE job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT, position TEXT NOT NULL, status TEXT DEFAULT 'New', deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, pay_type TEXT DEFAULT 'fixed', address TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Draft',
			total_earnings REAL NOT NULL DEFAULT 0, adjustment REAL DEFAULT 0, personal_total REAL NOT NULL DEFAULT 0, personal_share_total REAL NOT NULL DEFAULT 0,
			correction_lines_total REAL NOT NULL DEFAULT 0, is_manual INTEGER DEFAULT 0, render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', owner_id INTEGER DEFAULT 0);
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL);
		CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
			cents INTEGER NOT NULL, driver TEXT NOT NULL DEFAULT '', freeze_id TEXT NOT NULL, frozen_at TEXT NOT NULL);
		CREATE TABLE financials_ledger_freezes (freeze_id TEXT PRIMARY KEY, period TEXT NOT NULL, source TEXT NOT NULL, frozen_at TEXT NOT NULL, released_at TEXT NOT NULL DEFAULT '');
	`);
	const app = db.prepare("INSERT INTO job_applications (full_name, position, status, deleted_at) VALUES (?, ?, ?, ?)");
	app.run("Jordan Madeup", "Owner Operator", "New", null);
	app.run("Casey Sampleton", " owner operator ", "Accepted", null);
	app.run("Riley Fixture", "Company Driver", "New", null);
	app.run("Sky Testcase", "Owner Operator", "Rejected", "2026-10-01 00:00:00");
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, address) VALUES (?, ?, ?)");
	dir.run("Morgan Percent", "percentage", "12 Madeup Lane");
	dir.run("Avery Fixed", "fixed", "");
	const inv = db.prepare("INSERT INTO invoices (invoice_number, driver, status, total_earnings, adjustment, correction_lines_total, render_data, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	inv.run("INV-1001", "Morgan Percent", "Approved", 500.25, 0, 0, JSON.stringify({ __templateName: "service_invoice_owner_op" }), "");
	inv.run("INV-1002", "Avery Fixed", "Paid", 1250, 10.5, 2.25, "{}", "");
	inv.run("INV-1003", "Avery Fixed", "Draft", 99, 0, 0, "{}", "2026-10-02T12:00:00.000Z");
	inv.run("INV-S-0001", "Avery Fixed", "Draft", 0, 0, 0, "{}", "");
	const truck = db.prepare("INSERT INTO trucks (unit_number, vin, license_plate) VALUES (?, ?, ?)");
	truck.run("101", "1M8GDM9AXKP042788", "MADEUP1");
	truck.run("OO-9001-A", "3AKJHHDR5JSJV4321", "OOX4821");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, ?, ?)").run("2026-09", "locked", "2026-10-08T12:00:00.000Z");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, ?, ?)").run("2026-10", "reopened", "2026-11-08T12:00:00.000Z");
	const item = db.prepare("INSERT INTO financials_ledger_items (period, kind, cents, driver, freeze_id, frozen_at) VALUES (?, ?, ?, ?, ?, ?)");
	item.run("2026-09", "revenue", 12345, "Morgan Percent", "f-2026-09", "2026-10-08T12:00:00.000Z");
	item.run("2026-10", "revenue", 777, "Avery Fixed", "f-2026-10", "2026-11-08T12:00:00.000Z");
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at) VALUES (?, ?, ?, ?)").run("f-2026-09", "2026-09", "close", "2026-10-08T12:00:00.000Z");
	db.prepare("INSERT INTO expenses (driver, amount, date) VALUES (?, ?, ?)").run("Avery Fixed", 42.5, "2026-10-12");
	if (ownerOperatorTables && oo) {
		db.exec(oo.OO_SCHEMA_SQL);
		for (const sql of oo.OO_EXPENSE_COLUMN_SQL) db.exec(sql);
		db.prepare("INSERT INTO expenses (driver, amount, date, filed_by_role, filed_by_user_id) VALUES (?, ?, ?, ?, ?)").run("Avery Fixed", 23.75, "2026-11-18", "Dispatcher", 7);
		db.prepare("INSERT INTO owner_operators (user_id, business_name, created_at) VALUES (?, ?, ?)").run(91001, "Madeup Hauling LLC", "2026-11-02T15:00:00.000Z");
		db.prepare("INSERT INTO owner_operator_applications (application_id, truck_vin, truck_plate, registered_owner, business_name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(2, "1FUJGLDR7CLBP8834", "PLT7781", "Quinn Madeup", "Madeup Hauling LLC", "2026-11-01T15:00:00.000Z");
	}
	db.close();
}

// ── §1 ───────────────────────────────────────────────────────────────────────
console.log("§1 refusals");
{
	const before = fs.readdirSync(TMP).sort();
	const none = run([]);
	ok("§1 no --db: exit 2, naming --db", none.code === 2 && /--db/.test(none.err), `exit ${none.code}: ${none.err.trim().slice(0, 120)}`);
	const bare = run(["--db"]);
	ok("§1 --db with no path: exit 2", bare.code === 2, `exit ${bare.code}`);
	const missing = run([`--db=${path.join(TMP, "missing.db")}`]);
	ok("§1 a missing file: exit 2", missing.code === 2, `exit ${missing.code}: ${missing.err.trim().slice(0, 120)}`);
	// Neither the app's own database nor a copy under the temp directory (never created).
	const elsewhere = path.join(ROOT, "scripts", "fixtures", "owner-operator-report-absent.db");
	const other = run([`--db=${elsewhere}`]);
	ok("§1 a database outside the temp directory and the app's own: exit 2, by scope", other.code === 2 && /a copy under the temp directory/.test(other.err), `exit ${other.code}: ${other.err.trim().slice(0, 160)}`);
	ok("§1 no refusal printed a report", !none.out && !bare.out && !missing.out && !other.out);
	eq("§1 nothing was created", fs.readdirSync(TMP).sort(), before);
	ok("§1 ...nor in the repository", !fs.existsSync(elsewhere));
}

// ── §2-§4 ────────────────────────────────────────────────────────────────────
const dbFile = path.join(TMP, "made-up.db");
buildDb(dbFile, { ownerOperatorTables: true });
const shaBefore = sha(dbFile);
const listBefore = fs.readdirSync(TMP).sort();
const json = run([`--db=${dbFile}`, "--json"]);
const text = run([`--db=${dbFile}`]);
let report = null;
try { report = JSON.parse(json.out); } catch { report = null; }

console.log("\n§2 every count");
ok("§2 the JSON run exits 0", json.code === 0 && !!report, `exit ${json.code}: ${(json.err || json.out).trim().slice(0, 200)}`);
ok("§2 the text run exits 0", text.code === 0, `exit ${text.code}: ${(text.err || text.out).trim().slice(0, 200)}`);
if (report) {
	eq("§2 the database is a copy", report.database, "copy");
	const tables = report.tables || {};
	eq("§2 the eight tables, present, with their rows", Object.fromEntries(Object.entries(tables).map(([t, v]) => [t, [v.present, v.rows]])), {
		owner_operator_applications: [true, 1], owner_operators: [true, 1], owner_operator_trucks: [true, 0], owner_operator_charges: [true, 0],
		owner_operator_settlement_lines: [true, 0], owner_operator_escrow_uses: [true, 0], owner_operator_toll_notices: [true, 0], owner_operator_ledger_exits: [true, 0],
	});
	eq("§2 the two filed-by columns, present, with their stamped rows", report.expenseColumns, { filed_by_role: { present: true, stamped: 1 }, filed_by_user_id: { present: true, stamped: 1 } });
	eq("§2 applications reading \"Owner Operator\": live by status, and deleted", report.applications, { live: { Accepted: 1, New: 1 }, deleted: 1 });
	eq("§2 drivers on the percentage pay type", report.percentageDrivers, 1);
	eq("§2 invoices on the percentage template", report.percentageInvoices, { live: 1, deleted: 0 });
	eq("§2 numbering collisions", report.collisions, { invoicesNumberedS: 1, trucksNumberedOO: 1 });
	const fp = report.fingerprints || {};
	eq("§2 live invoices: 3, total due $1,763.00 (the server's own total due)", fp.liveInvoices && [fp.liveInvoices.count, fp.liveInvoices.totalDueCents], [3, 176300]);
	eq("§2 closed months' frozen books: one month, one item, one freeze", fp.closedMonths && [fp.closedMonths.periods, fp.closedMonths.items, fp.closedMonths.freezes], [1, 1, 1]);
	ok("§2 each fingerprint is a sha256", /^[0-9a-f]{64}$/.test(String(fp.liveInvoices && fp.liveInvoices.sha256)) && /^[0-9a-f]{64}$/.test(String(fp.closedMonths && fp.closedMonths.sha256)));
	ok("§2 flag states are left to the start-up line, never the settings file", /start-up line/.test(String(report.flags)));
}
ok("§2 the text names each table and the collision counts", /owner_operator_ledger_exits present, 0 row/.test(text.out) && /invoices numbered INV-S-: 1/.test(text.out) && /trucks numbered OO-: 1/.test(text.out), text.out.slice(0, 300));

console.log("\n§3 counts only");
const leaked = PRIVATE.filter((v) => json.out.includes(v) || text.out.includes(v) || json.err.includes(v) || text.err.includes(v));
eq("§3 no made-up name, VIN, plate or address in either output", leaked, []);

console.log("\n§4 read-only");
eq("§4 the database is byte-for-byte unchanged", sha(dbFile), shaBefore);
eq("§4 no sidecar or journal appeared", fs.readdirSync(TMP).sort(), listBefore);

// ── §5 ───────────────────────────────────────────────────────────────────────
console.log("\n§5 before the tables exist");
{
	const oldFile = path.join(TMP, "before-tables.db");
	buildDb(oldFile, { ownerOperatorTables: false });
	const r = run([`--db=${oldFile}`, "--json"]);
	let rep = null;
	try { rep = JSON.parse(r.out); } catch { rep = null; }
	ok("§5 the run exits 0", r.code === 0 && !!rep, `exit ${r.code}: ${(r.err || r.out).trim().slice(0, 200)}`);
	if (rep) {
		ok("§5 every new table reads absent", Object.values(rep.tables || {}).length === 8 && Object.values(rep.tables).every((t) => t.present === false && t.rows === 0));
		eq("§5 the filed-by columns read absent", rep.expenseColumns, { filed_by_role: { present: false, stamped: 0 }, filed_by_user_id: { present: false, stamped: 0 } });
	}
}

// ── §6 ───────────────────────────────────────────────────────────────────────
console.log("\n§6 the fingerprints");
{
	const fp = (file) => {
		const r = run([`--db=${file}`, "--json"]);
		try { return JSON.parse(r.out).fingerprints; } catch { return null; }
	};
	const base = path.join(TMP, "fp.db");
	buildDb(base, { ownerOperatorTables: true });
	const a = fp(base);
	const edit = (sql) => { const db = new Database(base); try { db.prepare(sql).run(); } finally { db.close(); } };
	edit("UPDATE financials_ledger_items SET cents = 778 WHERE period = '2026-10'");
	const b = fp(base);
	ok("§6 an open month's item leaves the closed months' fingerprint alone", !!a && !!b && a.closedMonths.sha256 === b.closedMonths.sha256);
	edit("UPDATE financials_ledger_items SET cents = 12346 WHERE period = '2026-09'");
	const c = fp(base);
	ok("§6 a closed month's item moves it", !!b && !!c && b.closedMonths.sha256 !== c.closedMonths.sha256);
	edit("UPDATE invoices SET adjustment = 11.5 WHERE invoice_number = 'INV-1002'");
	const d = fp(base);
	ok("§6 a live invoice's total due moves the invoices' fingerprint", !!c && !!d && c.liveInvoices.sha256 !== d.liveInvoices.sha256 && d.liveInvoices.totalDueCents === 176400);
	edit("UPDATE invoices SET adjustment = 50 WHERE invoice_number = 'INV-1003'");
	const e = fp(base);
	ok("§6 a deleted invoice moves nothing", !!d && !!e && d.liveInvoices.sha256 === e.liveInvoices.sha256);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
