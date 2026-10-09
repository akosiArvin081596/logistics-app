#!/usr/bin/env node
/**
 * The driver app shows each invoice at the total the invoice itself carries:
 * the computed total_earnings plus the admin adjustment, worked out by the
 * server. Before this, the driver app's invoice list showed total_earnings
 * alone, so an adjusted week read $1,500.00 in the list and $1,200.00 on its
 * PDF ("Total Due"), on the admin Invoices screen and in the payment report.
 *
 * WHAT IS ASSERTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import) and run against
 * an in-memory SQLite:
 *   §1 THE ONE DEFINITION. invoiceTotalDue(row) is total_earnings plus the
 *      adjustment, rounded to the cent; a missing adjustment adds nothing.
 *   §2 THE DRIVER APP'S LIST (GET /api/driver/:driverName). Every row carries
 *      total_due, equal to invoiceTotalDue() and to the payment report's
 *      total_due for the same invoice, for a negative, a positive and no
 *      adjustment; total_earnings is still served unchanged and `driver` is
 *      still not returned.
 *   §3 THE PAYMENT REPORT is unchanged: its total_due and its summary still
 *      include the adjustment, through the same invoiceTotalDue().
 *   §4 THE DRIVER APP DISPLAYS THE SERVER FIGURE. The invoice card and the
 *      invoice action sheet show `total_due`; no driver-app file reads
 *      total_earnings or an adjustment, so no total is computed in the browser.
 *   §5 MUTANTS — the list dropping the adjustment, and the definition ignoring
 *      it, must each flip at least one assertion above.
 *
 * Pure: no server, no app.db, no network, no Sheets.
 * Run: node scripts/test-driver-invoice-total-due.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// ───────────────────────────────────────────────────────────────── lifting
// Anchored on a newline and counted, so a mention in a comment is never taken
// for the definition and a second copy fails the run. A top-level function ends
// at the first column-0 "}" line.
function liftFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 function ${name}() in server.js, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", a);
	if (end < 0) throw new Error(`no end after function ${name}()`);
	return src.slice(a, end + 2);
}
// The driver app's list is one statement inside GET /api/driver/:driverName.
const DRIVER_APP_LIST_ANCHOR = "const driverInvoices = db.prepare(";
function liftDriverAppList(src) {
	const hits = src.split(DRIVER_APP_LIST_ANCHOR).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 driver app invoice list in server.js, found ${hits}`);
	const a = src.indexOf(DRIVER_APP_LIST_ANCHOR);
	const end = src.indexOf(";\n", a);
	return src.slice(a, end + 2);
}

function harness(src) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE,
		driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0,
		rate_per_load REAL NOT NULL DEFAULT 250, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'Draft', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '',
		adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', deleted_at TEXT DEFAULT '', is_manual INTEGER DEFAULT 0)`);
	// §1 asserts invoiceTotalDue() exists; the other batteries run without it,
	// so a tree that lacks it still shows what its driver list serves.
	const hasTotalDue = src.includes("\nfunction invoiceTotalDue(");
	const fns = new Function("db",
		[liftFn(src, "normalizeDriverName"), hasTotalDue ? liftFn(src, "invoiceTotalDue") : "const invoiceTotalDue = undefined;",
			liftFn(src, "buildPaymentReport"),
			"return { normalizeDriverName, invoiceTotalDue, buildPaymentReport };"].join("\n"))(db);
	const list = new Function("db", "normalizeDriverName", "driverNameNorm", "invoiceTotalDue",
		`${liftDriverAppList(src)}\nreturn driverInvoices;`);
	return {
		db,
		...fns,
		driverAppList: (name) => list(db, fns.normalizeDriverName, fns.normalizeDriverName(name), fns.invoiceTotalDue),
	};
}

function insertInvoice(db, row) {
	const r = {
		week_end: "", loads_count: 3, total_earnings: 0, expenses_total: 0, status: "Submitted",
		adjustment: 0, adjustment_note: "", deleted_at: "", ...row,
	};
	db.prepare(
		`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, total_earnings, expenses_total, status, adjustment, adjustment_note, deleted_at)
		 VALUES (@invoice_number, @driver, @week_start, @week_end, @loads_count, @total_earnings, @expenses_total, @status, @adjustment, @adjustment_note, @deleted_at)`
	).run(r);
}

// ───────────────────────────────────────────────────────────────── batteries
function batteryDefinition(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const { invoiceTotalDue } = harness(src);
	t("§1 server.js defines invoiceTotalDue() once", typeof invoiceTotalDue, "function");
	if (typeof invoiceTotalDue !== "function") return out;
	t("§1 total_earnings plus a negative adjustment", invoiceTotalDue({ total_earnings: 1500, adjustment: -300 }), 1200);
	t("§1 …plus a positive adjustment", invoiceTotalDue({ total_earnings: 600, adjustment: 75.5 }), 675.5);
	t("§1 …no adjustment adds nothing (0, null, missing)",
		[invoiceTotalDue({ total_earnings: 900, adjustment: 0 }), invoiceTotalDue({ total_earnings: 900, adjustment: null }), invoiceTotalDue({ total_earnings: 900 })],
		[900, 900, 900]);
	t("§1 …rounded to the cent", invoiceTotalDue({ total_earnings: 0.1, adjustment: 0.2 }), 0.3);
	t("§1 …an empty row is $0", invoiceTotalDue({}), 0);
	return out;
}

const W40 = { start: "2026-09-26", end: "2026-10-02" };
const W39 = { start: "2026-09-19", end: "2026-09-25" };
const W38 = { start: "2026-09-12", end: "2026-09-18" };

function seed(w) {
	insertInvoice(w.db, { invoice_number: "INV-SK-2026W40-01", driver: "Soren King", week_start: W40.start, week_end: W40.end, total_earnings: 1500, adjustment: -300, adjustment_note: "Sunday corrected" });
	insertInvoice(w.db, { invoice_number: "INV-SK-2026W39-01", driver: "soren  king", week_start: W39.start, week_end: W39.end, total_earnings: 1200, adjustment: 150.25, status: "Approved" });
	insertInvoice(w.db, { invoice_number: "INV-SK-2026W38-01", driver: "SOREN KING", week_start: W38.start, week_end: W38.end, total_earnings: 1050, status: "Paid" });
	insertInvoice(w.db, { invoice_number: "INV-HR-2026W40-01", driver: "Hal Rowe", week_start: W40.start, week_end: W40.end, total_earnings: 800, adjustment: 50 });
}

function batteryDriverList(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = harness(src);
	seed(w);
	const list = w.driverAppList("Soren King");
	const byNo = Object.fromEntries(list.map((r) => [r.invoice_number, r]));
	const report = w.buildPaymentReport("Soren King", "2026-09-01", "2026-10-31");
	const reportDue = Object.fromEntries(report.invoices.map((r) => [r.invoice_number, r.total_due]));
	t("§2 the driver's own invoices, in every stored spelling",
		list.map((r) => r.invoice_number).sort(), ["INV-SK-2026W38-01", "INV-SK-2026W39-01", "INV-SK-2026W40-01"]);
	t("§2 a negative adjustment: the list's total_due is the invoice's Total Due ($1,500.00 - $300.00)",
		byNo["INV-SK-2026W40-01"].total_due, 1200);
	t("§2 a positive adjustment: total_due includes it", byNo["INV-SK-2026W39-01"].total_due, 1350.25);
	t("§2 no adjustment: total_due is total_earnings", byNo["INV-SK-2026W38-01"].total_due, 1050);
	t("§2 every row's total_due equals the payment report's total_due for the same invoice",
		list.map((r) => [r.invoice_number, r.total_due]).sort(),
		list.map((r) => [r.invoice_number, reportDue[r.invoice_number]]).sort());
	t("§2 every row's total_due equals invoiceTotalDue() of the stored invoice",
		typeof w.invoiceTotalDue === "function" &&
			list.every((r) => r.total_due === w.invoiceTotalDue(w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.id))), true);
	t("§2 total_earnings is still served unchanged", byNo["INV-SK-2026W40-01"].total_earnings, 1500);
	t("§2 `driver` is still not returned", list.every((r) => !("driver" in r)), true);
	return out;
}

function batteryReport(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = harness(src);
	seed(w);
	const report = w.buildPaymentReport("Soren King", "2026-09-01", "2026-10-31");
	const due = Object.fromEntries(report.invoices.map((r) => [r.invoice_number, r.total_due]));
	t("§3 the payment report's total_due includes each adjustment",
		[due["INV-SK-2026W40-01"], due["INV-SK-2026W39-01"], due["INV-SK-2026W38-01"]], [1200, 1350.25, 1050]);
	t("§3 …and so does its summary (pending, paid, payable)",
		[report.summary.totalPending, report.summary.totalPaid, report.summary.totalPayable], [2550.25, 1050, 3600.25]);
	t("§3 buildPaymentReport() takes total_due from invoiceTotalDue()",
		/total_due: invoiceTotalDue\(r\),/.test(liftFn(src, "buildPaymentReport")), true);
	return out;
}

const DRIVER_APP_FILES = [
	...fs.readdirSync(path.join(ROOT, "client/src/components/driver")).filter((f) => f.endsWith(".vue")).map((f) => `client/src/components/driver/${f}`),
	"client/src/views/DriverView.vue",
	"client/src/stores/driver.js",
];
function batteryDisplay() {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
	const card = read("client/src/components/driver/InvoiceCard.vue");
	const tab = read("client/src/components/driver/InvoiceTab.vue");
	t("§4 the invoice card shows the server's total_due", /\{\{\s*\(invoice\.total_due \|\| 0\)\.toFixed\(2\)\s*\}\}/.test(card), true);
	t("§4 the invoice action sheet shows the server's total_due", /selectedInvoice\.total_due\?\.toFixed\(2\)/.test(tab), true);
	t("§4 no driver-app file reads total_earnings",
		DRIVER_APP_FILES.filter((f) => /total_earnings/.test(read(f))), []);
	t("§4 no driver-app file reads an invoice adjustment (no total is computed in the browser)",
		DRIVER_APP_FILES.filter((f) => /\.adjustment\b|\badjustment\s*\|\||\+\s*\(?\s*\w+\.adjustment/.test(read(f))), []);
	return out;
}

const BATTERIES = [
	["definition", batteryDefinition],
	["driver list", batteryDriverList],
	["payment report", batteryReport],
];

// Each mutant rewrites the fix back to a narrower rule and must flip at least
// one assertion. A test that passes on both has not tested anything.
const MUTANTS = [
	["the driver app's list drops the adjustment",
		"total_due: invoiceTotalDue(rest)", "total_due: rest.total_earnings"],
	["invoiceTotalDue() ignores the adjustment",
		"return Math.round(((row.total_earnings || 0) + (row.adjustment || 0)) * 100) / 100;",
		"return Math.round((row.total_earnings || 0) * 100) / 100;"],
];

// ───────────────────────────────────────────────────────────────── runner
let pass = 0;
const failures = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function report(checks) {
	for (const [label, actual, expected] of checks) {
		if (same(actual, expected)) { pass++; console.log(`ok    ${label}`); }
		else {
			failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
			console.log(`FAIL  ${label}\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`);
		}
	}
}
function run(label, battery, src) {
	try { report(battery(src)); }
	catch (err) {
		failures.push(`${label} threw: ${err.message}`);
		console.log(`FAIL  ${label} threw: ${err.message}`);
	}
}

for (const [name, battery] of BATTERIES) run(name, battery, SRC);
run("display", batteryDisplay);

console.log("\n§5 MUTANTS — each must flip at least one assertion above");
for (const [label, find, replace] of MUTANTS) {
	const hits = SRC.split(find).length - 1;
	if (hits !== 1) { report([[`MUTANT ${label}: its target appears once in server.js`, hits, 1]]); continue; }
	const src = SRC.replace(find, replace);
	const flipped = [];
	const threw = [];
	for (const [name, battery] of BATTERIES) {
		try { flipped.push(...battery(src).filter(([, a, e]) => !same(a, e)).map(([l]) => l)); }
		catch (err) { threw.push(`${name}: ${err.message}`); }
	}
	report([[`MUTANT ${label} → ${threw.length ? `a battery THREW (${threw[0]})` : flipped.length ? flipped[0] : "NOTHING fails"}`,
		threw.length === 0 && flipped.length > 0, true]]);
}

console.log("\n" + "-".repeat(60));
if (failures.length) {
	console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log(`OK — ${pass} assertions passed`);
