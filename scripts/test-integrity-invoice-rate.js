#!/usr/bin/env node
/**
 * Check 8 of the daily integrity check (lib/integrity-check.js
 * invoiceRateMismatches()): a driver's weekly invoice billed at a daily rate
 * that differs from that driver's daily rate in the drivers directory is
 * flagged (2026-10-14: "until the owner answers, any invoice whose daily rate
 * differs from the driver's directory rate is flagged"). Report only.
 *
 * WHAT IS ASSERTED:
 *   §1 the check over one database: a live daily-rate weekly invoice whose rate
 *      differs from the directory's is raised, the driver matched across case
 *      and spacing and the directory row read as server.js reads it (the first
 *      by id under the key); not raised: an equal rate, a directory rate not
 *      set (0) or no directory row, an owner-operator's invoice (its
 *      rate_per_load is a percentage), a deleted invoice, a manual or
 *      correction invoice; counted, not raised: a week touching a closed month
 *      (closed months are final as recorded), a week date that can't be read,
 *      an invoice that records no pay type
 *   §2 the email and the log line: the section, one line per invoice with both
 *      rates, the notes for what was counted
 *   §3 once per invoice: a recorded run names each invoice with its two rates
 *      once (integrity_check_invoice_rates, in the run's transaction); the next
 *      run counts it in one note and sends nothing for it; a new directory rate
 *      names it again; a failed send records nothing; the print run (write
 *      false) writes nothing
 *   §4 no lock table to read: every differing invoice is counted as
 *      "can't be placed", none raised; an invoices table without the rate
 *      columns skips the check and says so, and the other checks still run
 *   §4b a drivers directory without its pay_daily column skips the check (no
 *      throw; the daily run still completes and says so); an invoice billed at
 *      the directory's rate is passed over before its snapshot is parsed
 *   §5 it only reads: invoices, the directory and the locks are byte-identical
 *      after every run (no money figure or rate changes)
 *   §6 one rule, not a copy: defaultDriverKey() answers as server.js's
 *      normalizeDriverName(); every column the check reads is in server.js's
 *      invoices, drivers_directory and period_locks schema
 *
 * Hermetic: in-memory SQLite, made-up names and numbers; no network.
 *   node scripts/test-integrity-invoice-rate.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

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
const SERVICE = JSON.stringify({ __templateName: "service_invoice", days: {} });
const OWNER_OP = JSON.stringify({ __templateName: "service_invoice_owner_op", payPercentage: 88 });
// A daily-rate snapshot marked so §4b can tell whether it was ever parsed: the
// invoices carrying it bill the directory's own rate, so the check needs no
// snapshot to pass them over.
const EQUAL_PROBE = JSON.stringify({ __templateName: "service_invoice", days: {}, probe: "equal-rate" });

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT NOT NULL DEFAULT 'd', type TEXT NOT NULL DEFAULT 'Fuel',
			amount REAL NOT NULL DEFAULT 10, date TEXT NOT NULL, status TEXT DEFAULT 'Pending',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL,
			week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0,
			rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', render_data TEXT DEFAULT '{}',
			deleted_at TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, is_correction INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT NOT NULL, pay_type TEXT DEFAULT 'fixed',
			pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
	`);
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?)");
	dir.run(1, "Driver One", "fixed", 0, 350);
	dir.run(2, "Driver  One", "fixed", 0, 0); // a spacing variant added later: shadowed, as getDriverPayStructures() ignores it
	dir.run(3, "Driver Two", "fixed", 0, 300);
	dir.run(4, "Driver Three", "fixed", 0, 0); // no daily rate set: the truck's rate applies
	dir.run(5, "Owner Op", "percentage", 88, 400);
	db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-09', 'locked'), ('2026-08', 'unlocked')").run();
	const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, rate_per_load, status, render_data, deleted_at, is_manual, is_correction)
		VALUES (@id, @num, @driver, @ws, @we, @rate, @status, @rd, @del, @manual, @corr)`);
	const add = (o) => inv.run({ status: "Draft", rd: SERVICE, del: "", manual: 0, corr: 0, ws: "2026-10-03", we: "2026-10-09", ...o });
	add({ id: 1, num: "INV-T1-A", driver: "driver one", rate: 300 });                                      // raised
	add({ id: 2, num: "INV-T2-B", driver: "driver two", rate: 300, rd: EQUAL_PROBE });                    // equal
	add({ id: 3, num: "INV-T3-C", driver: "driver three", rate: 250 });                                    // directory not set
	add({ id: 4, num: "INV-T4-D", driver: "owner op", rate: 88, rd: OWNER_OP });                          // percentage
	add({ id: 5, num: "INV-T1-E", driver: "driver one", rate: 300, ws: "2026-09-26", we: "2026-10-02" }); // touches closed September
	add({ id: 6, num: "INV-T1-F", driver: "driver one", rate: 300, ws: "2026-10-10", we: "2026-10-16", del: "2026-10-11T00:00:00Z" });
	add({ id: 7, num: "INV-M-T1-G", driver: "driver one", rate: 300, ws: "2026-10-10", we: "2026-10-16", manual: 1, corr: 1 });
	add({ id: 8, num: "INV-T1-H", driver: "driver one", rate: 300, ws: "2026-10-17", we: "2026-10-23", rd: "{}" }); // no pay type recorded
	add({ id: 9, num: "INV-T9-I", driver: "nobody here", rate: 300 });                                     // no directory row
	add({ id: 10, num: "INV-T1-J", driver: "driver one", rate: 300, ws: "not a date", we: "2026-10-30" });  // week can't be placed
	add({ id: 11, num: "INV-T1-K", driver: " Driver   ONE ", rate: 325.5, status: "Approved", ws: "2026-08-01", we: "2026-08-07" }); // spacing, case; an unlocked lock row is open
	add({ id: 12, num: "INV-T1-L", driver: "driver one", rate: 350.004, ws: "2026-10-24", we: "2026-10-30", rd: EQUAL_PROBE }); // the same rate in cents
	return db;
}

function jt() {
	return { headers: ["Load ID", "Pickup Appointment", "Assigned Date"], data: [{ _rowIndex: 2, "Load ID": "1", "Pickup Appointment": "p", "Assigned Date": "" }] };
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
async function run(db, { now = "2026-10-15T12:00:30Z", sendEmail = mailSpy(), write = true, to = ADMIN } = {}) {
	const log = quietLog();
	const result = await ic.runIntegrityCheck({
		db, now: new Date(now), write, sendEmail, to, log,
		readJobTracking: async () => jt(),
		expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		appZone: "America/New_York",
	});
	return { result, log, sendEmail };
}
const snapshot = (db) => JSON.stringify(["invoices", "drivers_directory", "period_locks"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
const reportedRows = (db) => db.prepare(`SELECT invoice_id, invoice_rate_cents, directory_rate_cents FROM ${ic.INVOICE_RATES_TABLE} ORDER BY invoice_id, invoice_rate_cents`).all();

(async () => {
	const fnPresent = typeof ic.invoiceRateMismatches === "function";
	ok("§1 invoiceRateMismatches() is exported", fnPresent);
	if (!fnPresent) return;

	console.log("§1 the check over one database");
	const db = makeDb();
	const before = snapshot(db);
	const r = ic.invoiceRateMismatches(db);
	const ids = r.mismatches.map((m) => m.invoiceId);
	ok("§1 raised: the daily-rate invoice at $300 against the directory's $350, and the one at $325.50 under a spacing and case variant of the name", ids.join() === "1,11", ids);
	ok("§1 the rates are carried in cents, the invoice's and the directory's (the first row by id, not the shadow at 0)",
		r.mismatches.every((m) => m.directoryCents === 35000) && r.mismatches[0].invoiceCents === 30000 && r.mismatches[1].invoiceCents === 32550, r.mismatches);
	ok("§1 not raised: an equal rate, the same rate a fraction of a cent off, no directory rate, no directory row, an owner-operator's percentage, a deleted invoice, a correction invoice",
		![2, 3, 4, 6, 7, 9, 12].some((id) => ids.includes(id)));
	ok("§1 counted, not raised: one week touching closed September", r.closed === 1, r);
	ok("§1 counted, not raised: one week date that can't be read", r.unknownMonth === 1, r);
	ok("§1 counted, not raised: one invoice that records no pay type", r.noPayType === 1, r);
	ok("§1 nothing reported earlier, nothing skipped", r.reportedOpen === 0 && r.skipped === "", r);

	console.log("§2 the email and the log line");
	const first = await run(db);
	const mail = first.sendEmail.calls[0];
	ok("§2 one email to ADMIN_NOTIFY_EMAIL", first.sendEmail.calls.length === 1 && mail.to === ADMIN, first.sendEmail.calls.map((c) => c.to));
	ok("§2 the section title and its count", /Invoice daily rate differs from the drivers directory \(2\)/.test(mail.html), mail.html);
	ok("§2 one line per invoice with both rates",
		mail.html.includes("Invoice INV-T1-A (driver driver one, week 2026-10-03 to 2026-10-09, Draft): billed at $300.00 a day; the drivers directory rate is $350.00 a day.") &&
		mail.html.includes("Invoice INV-T1-K (driver Driver ONE, week 2026-08-01 to 2026-08-07, Approved): billed at $325.50 a day; the drivers directory rate is $350.00 a day."), mail.html);
	const text = first.result.mail.text;
	ok("§2 the notes count the closed-month, unplaced and no-pay-type invoices",
		/1 invoice whose daily rate differs from the drivers directory is in a closed month, final as recorded, so it was not raised\./.test(text) &&
		/1 invoice whose daily rate differs from the drivers directory could not be placed in an open or a closed month/.test(text) &&
		/1 invoice with a rate different from the drivers directory records no pay type, so it was not compared\./.test(text), text);
	const line = first.log.lines.join("\n");
	ok("§2 the log line names the invoices and the counts",
		/invoice daily rate differs from the drivers directory: invoice INV-T1-A, INV-T1-K/.test(line) &&
		/invoice daily rates not raised: 1 in a closed month, 1 whose month can't be told, 1 with no pay type recorded/.test(line), line);

	console.log("§3 once per invoice");
	ok("§3 the recorded run named both invoices with their two rates",
		JSON.stringify(reportedRows(db)) === JSON.stringify([{ invoice_id: 1, invoice_rate_cents: 30000, directory_rate_cents: 35000 }, { invoice_id: 11, invoice_rate_cents: 32550, directory_rate_cents: 35000 }]), reportedRows(db));
	const second = await run(db, { now: "2026-10-16T12:00:30Z" });
	ok("§3 the next run names neither again and sends nothing for them",
		second.result.report.invoiceRates.mismatches.length === 0 && second.sendEmail.calls.length === 0, second.result.report.invoiceRates);
	ok("§3 ...and counts them in one note and in the log line",
		second.result.report.notes.some((n) => n === "2 invoices whose daily rate differs from the drivers directory, reported earlier, are still as reported.") &&
		/2 such invoices reported earlier/.test(second.log.lines.join("\n")), [second.result.report.notes, second.log.lines]);
	db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE id = 1").run();
	const third = await run(db, { now: "2026-10-17T12:00:30Z" });
	const thirdIds = third.result.report.invoiceRates.mismatches.map((m) => m.invoiceId);
	ok("§3 a new directory rate ($300): the invoice now equal to it is not raised; the $325.50 one is named again and the $350 one is named, both against $300",
		thirdIds.join() === "11,12" && third.result.report.invoiceRates.mismatches.every((m) => m.directoryCents === 30000) &&
		third.result.report.invoiceRates.reportedOpen === 0 && third.sendEmail.calls.length === 1, third.result.report.invoiceRates);
	db.prepare("UPDATE drivers_directory SET pay_daily = 350 WHERE id = 1").run();

	const db2 = makeDb();
	const failed = await run(db2, { sendEmail: mailSpy(false) });
	ok("§3 a failed send records nothing, so the next run names them again",
		failed.result.ok === false && reportedRows(db2).length === 0, reportedRows(db2));
	const retried = await run(db2);
	ok("§3 ...the retry names both", retried.result.report.invoiceRates.mismatches.length === 2 && reportedRows(db2).length === 2);
	const db3 = makeDb();
	const printed = await run(db3, { write: false });
	ok("§3 the print run (write false) names them and writes nothing",
		printed.result.report.invoiceRates.mismatches.length === 2 && !db3.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(ic.INVOICE_RATES_TABLE));
	const lib = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	const commitAt = lib.indexOf("function commitState(");
	const txBody = commitAt < 0 ? "" : lib.slice(lib.indexOf("db.transaction(() => {", commitAt), lib.indexOf("})();", commitAt));
	ok("§3 the invoice rates are recorded in the run's one transaction", /markRate\.run\(/.test(txBody), txBody);

	console.log("§4 what it can't read");
	const db4 = makeDb();
	db4.exec("DROP TABLE period_locks");
	const noLocks = ic.invoiceRateMismatches(db4);
	ok("§4 no lock table: nothing raised, every differing invoice counted as unplaced",
		noLocks.mismatches.length === 0 && noLocks.unknownMonth === 5 && noLocks.closed === 0, noLocks);
	const db5 = new Database(":memory:");
	db5.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT NOT NULL DEFAULT 'd', type TEXT NOT NULL DEFAULT 'Fuel',
			amount REAL NOT NULL DEFAULT 10, date TEXT NOT NULL, status TEXT DEFAULT 'Pending',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
	`);
	db5.prepare("INSERT INTO expenses (id, status, date, created_at) VALUES (7, 'Approved', '2026-10-01', '2026-10-01 10:00:00')").run();
	const skipped = await run(db5);
	ok("§4 invoices without the rate columns: the check is skipped and says so; the receipt check still reports",
		skipped.result.report.invoiceRates.skipped === "invoices record no daily rate" &&
		skipped.result.report.notes.includes("Invoice daily rates were not checked: invoices record no daily rate.") &&
		/#7/.test(skipped.result.mail.html) && /invoice daily rates not checked \(invoices record no daily rate\)/.test(skipped.log.lines.join("\n")), skipped.result.report.notes);

	console.log("§4b a directory without a daily rate column, and the snapshot read");
	{
		const dbNoRate = makeDb();
		dbNoRate.exec("ALTER TABLE drivers_directory DROP COLUMN pay_daily");
		let threw = null;
		let res = null;
		try { res = ic.invoiceRateMismatches(dbNoRate); } catch (e) { threw = e; }
		ok("§4b no pay_daily column: the check does not throw, raises nothing and says it was skipped",
			threw === null && res && res.mismatches.length === 0 && res.skipped === "the drivers directory has no daily rate column", threw ? threw.message : res);
		let daily = null;
		try { daily = await run(dbNoRate); } catch (e) { daily = { error: e.message }; }
		ok("§4b ...and the daily run still completes, saying so in its notes",
			daily && daily.result && daily.result.ok === true && daily.result.report.notes.includes("Invoice daily rates were not checked: the drivers directory has no daily rate column."), daily && (daily.error || daily.result.report.notes));
		const realParse = JSON.parse;
		const parsed = [];
		JSON.parse = function (text, ...rest) { parsed.push(String(text)); return realParse.call(this, text, ...rest); };
		try { ic.invoiceRateMismatches(makeDb()); } finally { JSON.parse = realParse; }
		ok("§4b an invoice billed at the directory's rate is passed over before its snapshot is parsed",
			parsed.length > 0 && !parsed.some((t) => t.includes("equal-rate")), parsed.filter((t) => t.includes("equal-rate")).length);
	}

	console.log("§5 it only reads");
	ok("§5 invoices, the directory and the locks are unchanged by the check and three recorded runs (but the one directory edit this test made and undid)", snapshot(db) === before);
	ok("§5 the lib writes no invoice, directory or lock row",
		!/\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(invoices|drivers_directory|period_locks)\b/i.test(lib));

	console.log("§6 one rule, not a copy");
	const fnSrc = SRC.match(/\nfunction normalizeDriverName\(s\) \{\n([\s\S]*?)\n\}/);
	ok("§6 server.js's normalizeDriverName() found", !!fnSrc);
	if (fnSrc) {
		const serverKey = new Function("s", fnSrc[1]);
		const samples = ["Driver One", "  driver   ONE ", "Driver\tOne", "Ana  María López", "", "x"];
		ok("§6 defaultDriverKey() answers as server.js's normalizeDriverName() on every sample",
			samples.every((s) => ic.defaultDriverKey(s) === serverKey(s)), samples.map((s) => [ic.defaultDriverKey(s), serverKey(s)]));
	}
	const ddl = (table) => {
		const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\)`));
		const alters = [...SRC.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN (\\w+)`, "g"))].map((x) => x[1]);
		return `${m ? m[1] : ""} ${alters.join(" ")}`;
	};
	const has = (table, cols) => cols.every((c) => new RegExp(`\\b${c}\\b`).test(ddl(table)));
	ok("§6 every invoices column the check reads is in server.js's schema",
		has("invoices", ["id", "invoice_number", "driver", "week_start", "week_end", "status", "rate_per_load", "render_data", "deleted_at", "is_manual", "is_correction"]));
	ok("§6 ...and every drivers_directory and period_locks column", has("drivers_directory", ["id", "driver_name", "pay_daily"]) && has("period_locks", ["period", "status"]));
	ok("§6 a daily-rate invoice is the service_invoice template, an owner-operator's service_invoice_owner_op, as server.js names them",
		/templateName = "service_invoice";/.test(SRC) && /templateName = "service_invoice_owner_op";/.test(SRC));

	console.log("§7 under the daily-rate rule (DRIVER_RATE_ONLY): each grid day it prices against the driver's own rate, else $250");
	{
		const rdb = makeDb();
		rdb.prepare("DELETE FROM invoices").run();
		rdb.prepare("DELETE FROM period_locks").run();
		const grid = (cells) => JSON.stringify({ __templateName: "service_invoice", days: cells });
		const cell = (load, total) => ({ loadBol: load, total, completed: true });
		const inv = rdb.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, rate_per_load, status, render_data)
			VALUES (?, ?, ?, ?, ?, ?, 'Submitted', ?)`);
		// Driver Three has no directory rate: his truck's $150 was billed.
		inv.run(21, "INV-R3-W40", "driver three", "2026-10-03", "2026-10-09", 150, grid({ Monday: cell("L1", 150), Tuesday: cell("L1", 150) }));
		// Driver Two's own $300, billed as such.
		inv.run(22, "INV-R2-W40", "driver two", "2026-10-03", "2026-10-09", 300, grid({ Monday: cell("L2", 300) }));
		// A week straddling FROM: Thu 10/1 on a load assigned in September (not the
		// rule's), Fri 10/2 on an October load (the rule's).
		inv.run(23, "INV-R3-W39", "driver three", "2026-09-26", "2026-10-02", 150, grid({ Thursday: cell("L9", 150), Friday: cell("L3", 150) }));
		const rule = { from: "2026-10", appliesTo: (m) => m >= "2026-10", payMonthOf: (day, loads) => (loads.includes("L9") ? "2026-09" : day.slice(0, 7)) };
		const on = ic.invoiceRateMismatches(rdb, { dailyRateRule: rule });
		const byId = Object.fromEntries(on.mismatches.map((m) => [m.invoiceId, m]));
		ok("§7 raised: Driver Three's W40 at $150 against the $250 default, both days named",
			!!byId[21] && byId[21].invoiceCents === 15000 && byId[21].directoryCents === 25000 && byId[21].defaultRate === true && JSON.stringify(byId[21].days) === JSON.stringify(["2026-10-05", "2026-10-06"]), on.mismatches);
		ok("§7 not raised: Driver Two at his own $300", !byId[22], on.mismatches);
		ok("§7 the straddling week: only Fri 10/2 (an October load) is compared; Thu 10/1 (a September load) is not",
			!!byId[23] && JSON.stringify(byId[23].days) === JSON.stringify(["2026-10-02"]), on.mismatches);
		const off = ic.invoiceRateMismatches(rdb);
		ok("§7 the rule off: as today, a driver with no directory rate is not compared", off.mismatches.length === 0, off.mismatches);
		const r = await ic.runIntegrityCheck({
			db: rdb, now: new Date("2026-10-15T12:00:30Z"), write: false, sendEmail: mailSpy(), to: ADMIN, log: quietLog(),
			readJobTracking: async () => jt(), expensePeriodExpr: EXPENSE_PERIOD_EXPR, appZone: "America/New_York",
			dailyRateRuleFor: () => rule,
		});
		ok("§7 the email names the days and the $250 default",
			r.mail && r.mail.text.includes("Invoice INV-R3-W40 (driver driver three, week 2026-10-03 to 2026-10-09, Submitted): billed at $150.00 a day on 2026-10-05, 2026-10-06; no daily rate is set in the drivers directory, so the daily rate is the $250.00 default."),
			r.mail && r.mail.text);
		ok("§7 server.js hands the daily run the rule while DRIVER_RATE_ONLY is on",
			SRC.includes("dailyRateRuleFor: DRIVER_RATE_ONLY_FROM ? driverRateOnlyDayRule : null,"));
	}
})().then(() => {
	if (failures.length) {
		console.error(`\n${passed} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n${passed} passed, 0 failed`);
}).catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
