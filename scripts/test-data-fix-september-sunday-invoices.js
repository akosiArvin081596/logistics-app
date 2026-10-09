#!/usr/bin/env node
/**
 * scripts/data-fix-september-sunday-invoices.js: its decisions, its September
 * comparison, its command line and its lift of server.js.
 *
 *   §1 invoiceCorrection(): a billed Sunday comes off the stored snapshot (the
 *      day line cleared, Total Due, the day count and the total less one daily
 *      rate; nothing else in the snapshot moves); an invoice already corrected
 *      by this script is "done"; every uncertain invoice is skipped with why: a
 *      paid, processing, rejected, deleted, manual or adjusted invoice, a day
 *      outside the week or not a Sunday, a line naming another load, a day line
 *      that is not billed, totals that disagree, a percentage-pay snapshot;
 *   §2 compareSeptember(): the correction alone passes and reports the
 *      investor's payout, the items removed and the Financials figures; each of
 *      these fails, named: another invoice changed, a corrected invoice changed
 *      beyond its day line and total, another frozen item gone, another
 *      owner's payout moved, the investor's driver pay moved by a different
 *      amount, a status changed, the month not finalized again, a receipt
 *      changed, an override the run did not add;
 *   §3 the command line refuses (exit 2, nothing opened): an unknown option,
 *      neither or both of --dry-run and --apply, no --db, no sheet, an apply
 *      without --expect-payout or with one that is not dollars, a database
 *      outside the app directory and the temp directory, --data-dir with the
 *      app's own database;
 *   §4 the lift: every root and both route handlers resolve in this checkout's
 *      server.js, reach none of the denied names (the HTTP server, the Sheets
 *      writer, the mailer, the sheet ID), and the lifted code compiles;
 *   §5 plan(), on a file database with the production schema of the tables it
 *      reads and a fictional driver: a fresh plan lists both invoices, both
 *      overrides and both frozen days; a correction possibly on record
 *      elsewhere refuses (an audit row or an adjustment note of the cancelled
 *      October-credit fix, an adjustment on the investor's September or a later
 *      payout row, an adjustment on another of the driver's invoices from the
 *      first corrected week on); so do a paid payout, a reopened month, an
 *      override someone else wrote, a PDF file another invoice also names,
 *      changed Financials settings and a frozen day at another rate; the state
 *      after a full apply is "already applied", a partial one refuses; the
 *      fingerprint a re-check inside the transaction compares moves with any
 *      row the plan read.
 *
 * The run on a copy of production's database (reopen, overrides, invoices,
 * close, comparison, PDFs) is the script's own --dry-run; the rehearsal on the
 * local copy is in the PR.
 *
 * Pure: a temp directory, child processes of the script itself, no server, no
 * network. Run: node scripts/test-data-fix-september-sunday-invoices.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-september-sunday-invoices.js");
const fix = require(SCRIPT);
const { closure } = require("./lib/server-lift");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// ── §1 invoiceCorrection ──────────────────────────────────────────────────────
const W37 = fix.CORRECTION.invoices[0];
function days(spec) {
	const out = {};
	for (const d of ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
		out[d] = spec[d] ? { loadBol: spec[d], total: 300, completed: true } : { loadBol: "", total: 0, completed: false };
	}
	return out;
}
const SIX = days({ Sunday: "567844619", Monday: "567844619", Tuesday: "567844619", Wednesday: "568073441, 567850506", Thursday: "568073441, 567850506", Friday: "567850506" });
function invoice(over = {}, renderOver = {}) {
	const render = { driverName: "Test Driver", invoiceNumberSuffix: "SK-2026W37-01", submissionDate: "Sep 19, 2026", totalDue: 1800, adjustment: 0, adjustmentNote: "", days: SIX, __templateName: "service_invoice", ...renderOver };
	return {
		id: 537, invoice_number: W37.invoiceNumber, driver: "test driver", week_start: "2026-09-12", week_end: "2026-09-18", loads_count: 6, rate_per_load: 300,
		total_earnings: 1800, expenses_total: 1761.44, status: "Submitted", paid_at: "", deleted_at: "", is_manual: 0, adjustment: 0, render_data: JSON.stringify(render), ...over,
	};
}
{
	const r = fix.invoiceCorrection(invoice(), W37);
	check("§1 a billed Sunday is corrected", r.state === "correct", r.why);
	const after = JSON.parse(r.renderData);
	check("§1 the Sunday line is cleared", after.days.Sunday.completed === false && after.days.Sunday.total === 0 && after.days.Sunday.loadBol === "");
	check("§1 Total Due, days and total drop by one daily rate", after.totalDue === 1500 && r.after.total === 1500 && r.after.loadsCount === 5);
	const before = JSON.parse(invoice().render_data);
	const strip = (x) => { const c = { ...x, days: { ...x.days } }; delete c.days.Sunday; delete c.totalDue; return JSON.stringify(c); };
	check("§1 nothing else in the snapshot moves", strip(after) === strip(before));
	check("§1 the remaining days are listed", r.after.days.join(",") === "Monday,Tuesday,Wednesday,Thursday,Friday");

	const corrected = invoice({ loads_count: 5, total_earnings: 1500, render_data: r.renderData });
	check("§1 already corrected by this script is done", fix.invoiceCorrection(corrected, W37, { applied: true }).state === "done");
	const notOurs = fix.invoiceCorrection(corrected, W37, { applied: false });
	check("§1 a Sunday that is off the invoice without this script's record is skipped", notOurs.state === "skip" && /did not take it off/.test(notOurs.why), notOurs.why);

	const skips = [
		["paid", invoice({ status: "Paid", paid_at: "2026-10-09T00:00:00Z" }), /paid/],
		["paid stamp on an approved invoice", invoice({ status: "Approved", paid_at: "2026-10-09T00:00:00Z" }), /paid/],
		["processing", invoice({ status: "Processing" }), /Processing/],
		["rejected", invoice({ status: "Rejected" }), /Rejected/],
		["deleted", invoice({ deleted_at: "2026-10-01" }), /deleted/],
		["manual", invoice({ is_manual: 1 }), /manual/],
		["adjusted", invoice({ adjustment: -300 }), /adjustment/],
		["a day outside the week", invoice({ week_start: "2026-09-19", week_end: "2026-09-25" }), /not in/],
		["a line naming another load", invoice({}, { days: days({ Sunday: "111", Monday: "567844619", Tuesday: "567844619", Wednesday: "1", Thursday: "1", Friday: "1" }) }), /not 567844619/],
		["totals that disagree", invoice({ total_earnings: 2100 }), /do not agree/],
		["a Total Due that disagrees", invoice({}, { totalDue: 1700 }), /do not agree/],
		["a percentage-pay snapshot", invoice({}, { __templateName: "service_invoice_owner_op" }), /no day-rate/],
		["no snapshot", invoice({ render_data: "{}" }), /no day-rate/],
		["missing", null, /not found/],
	];
	for (const [name, row, re] of skips) {
		const s = fix.invoiceCorrection(row, W37);
		check(`§1 ${name} is skipped`, s.state === "skip" && re.test(s.why), s.why);
	}
	const monday = fix.invoiceCorrection(invoice(), { ...W37, day: "2026-09-14" });
	check("§1 a day that is not a Sunday is skipped", monday.state === "skip" && /not a Sunday/.test(monday.why), monday.why);
	check("§1 weekdayOf reads the calendar day", fix.weekdayOf("2026-09-13") === "Sunday" && fix.weekdayOf("2026-09-27") === "Sunday" && fix.weekdayOf("2026-09-28") === "Monday");
}

// ── §2 compareSeptember ───────────────────────────────────────────────────────
function item(o) {
	return JSON.stringify({ owner_id: 5, kind: "driver_pay", adjusts: "", day: "", cents: 30000, load_id: "", driver: "test driver", truck: "T-1", expense_id: null, source_id: null, expense_type: "", pay_type: "fixed", pickup_state: "", delivery_state: "", ...o });
}
function breakdown(driverPay, netProfit, share) {
	return JSON.stringify({ revenue: 1000, driverPay, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit, splitPct: 50, monthShare: share, lossCarriedIn: 0, lossDeferred: 0 });
}
function state(over = {}) {
	const inv = JSON.parse(JSON.stringify(invoice()));
	const base = {
		lock: { period: "2026-09", status: "locked", finalized_at: "2026-10-08T05:00:25Z", finalized_by: "system", reopened_at: "", reopened_by: "", reopen_reason: "" },
		payouts: [
			{ id: 27, owner_id: 5, amount: 400, due_date: "2026-10-30", status: "owed", processed_at: null, paid_at: null, notes: "", adjustment: 0, adjustment_note: "", reopened_at: "", reopen_reason: "", finalized_at: "2026-10-08T05:00:25Z", finalized_amount: 400, finalized_breakdown: breakdown(600, 250, 400), statement_pdf_file_name: "" },
			{ id: 28, owner_id: 41, amount: 0, due_date: "2026-10-30", status: "owed", processed_at: null, paid_at: null, notes: "", adjustment: 0, adjustment_note: "", reopened_at: "", reopen_reason: "", finalized_at: "2026-10-08T05:00:25Z", finalized_amount: 0, finalized_breakdown: breakdown(0, 0, 0), statement_pdf_file_name: "" },
		],
		items: [item({ day: "2026-09-13", load_id: "L1" }), item({ day: "2026-09-14", load_id: "L1" }), item({ kind: "revenue", cents: 100000, load_id: "L1" })].sort(),
		freezes: [{ source: "close", frozen_by: "system", item_count: 3, summary: JSON.stringify({ revenue: 1000, driverPay: 600, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 250 }), settings: "{}" }],
		invoices: [inv, { ...inv, id: 540, invoice_number: "INV-HR-2026W37-01", driver: "other driver" }],
		excluded: [],
		unchanged: { receipts: "a", maintenanceFund: "b", complianceFees: "c", otherMonthsPayouts: "d", otherMonthsItems: "e", otherMonthsFreezes: "f", otherMonthsLocks: "g", otherInvoices: "h", otherOverrides: "i", trucksAndPay: "j" },
	};
	return { ...base, ...over };
}
const REMOVED = [item({ day: "2026-09-13", load_id: "L1" })];
const OVERRIDES = [{ driver_name: "test driver", excluded_date: "2026-09-13", action: "remove" }];
const REASON = fix.CORRECTION.reason;
function goodAfter() {
	const b = state();
	const r = fix.invoiceCorrection(b.invoices[0], W37);
	return state({
		lock: { ...b.lock, finalized_at: "2026-10-09T05:00:00Z", finalized_by: fix.ACTOR, reopened_at: "2026-10-09T04:59:59Z", reopened_by: fix.ACTOR, reopen_reason: REASON },
		payouts: [
			{ ...b.payouts[0], amount: 550, finalized_amount: 550, finalized_at: "2026-10-09T05:00:00Z", finalized_breakdown: breakdown(300, 550, 550) },
			{ ...b.payouts[1], finalized_at: "2026-10-09T05:00:00Z" },
		],
		items: b.items.filter((x) => x !== REMOVED[0]),
		freezes: [{ ...b.freezes[0], frozen_by: fix.ACTOR, item_count: 2, summary: JSON.stringify({ revenue: 1000, driverPay: 300, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 550 }) }],
		invoices: [{ ...b.invoices[0], loads_count: 5, total_earnings: 1500, render_data: r.renderData }, b.invoices[1]],
		excluded: OVERRIDES.map((o) => ({ ...o, reason: "x", excluded_by: fix.ACTOR })),
	});
}
const OPTS = { corrected: [{ id: 537, weekday: "Sunday" }], removed: REMOVED, ownerId: 5, overrides: OVERRIDES, reason: REASON };
{
	const ok = fix.compareSeptember(state(), goodAfter(), OPTS);
	check("§2 the correction alone passes", ok.ok, ok.problems.join("; "));
	const pay = ok.changes.find((c) => c.what === "payout");
	check("§2 the investor's payout is reported", pay && pay.before.amount === 400 && pay.after.amount === 550);
	check("§2 the removed items are reported", ok.changes.find((c) => c.what === "items").removed.length === 1);

	const variants = [
		["another invoice changed", (a) => { a.invoices[1] = { ...a.invoices[1], total_earnings: 1 }; }, /INV-HR-2026W37-01 changed/],
		["a corrected invoice changed beyond its day and total", (a) => { a.invoices[0] = { ...a.invoices[0], expenses_total: 1 }; }, /expenses_total changed/],
		["a corrected invoice's snapshot changed elsewhere", (a) => { const r = JSON.parse(a.invoices[0].render_data); r.submissionDate = "Oct 9, 2026"; a.invoices[0] = { ...a.invoices[0], render_data: JSON.stringify(r) }; }, /snapshot changed/],
		["another frozen item gone", (a) => { a.items = a.items.slice(1); }, /frozen items differ/],
		["another owner's payout moved", (a) => { a.payouts[1] = { ...a.payouts[1], amount: 5, finalized_amount: 5 }; }, /owner 41's September payout changed/],
		["the investor's driver pay moved by a different amount", (a) => { a.payouts[0] = { ...a.payouts[0], finalized_breakdown: breakdown(0, 850, 550) }; }, /driverPay is/],
		["the investor's payout moved by more than its share of the removed pay", (a) => { a.payouts[0] = { ...a.payouts[0], amount: 700, finalized_amount: 700, finalized_breakdown: breakdown(300, 550, 700) }; }, /moved by \$300\.00, not by about \$150\.00/],
		["a payout status changed", (a) => { a.payouts[0] = { ...a.payouts[0], status: "paid" }; }, /status changed/],
		["the month not finalized again", (a) => { a.lock = { ...a.lock, status: "reopened" }; }, /not finalized/],
		["a receipt changed", (a) => { a.unchanged = { ...a.unchanged, receipts: "z" }; }, /receipts changed/],
		["an override the run did not add", (a) => { a.excluded = [...a.excluded, { driver_name: "x", excluded_date: "2026-09-20", action: "remove" }]; }, /overrides are not/],
		["Financials moved beyond the day", (a) => { a.freezes = [{ ...a.freezes[0], summary: JSON.stringify({ revenue: 999, driverPay: 300, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 549 }) }]; }, /Financials revenue/],
	];
	for (const [name, mutate, re] of variants) {
		const a = goodAfter();
		mutate(a);
		const r = fix.compareSeptember(state(), a, OPTS);
		check(`§2 fails: ${name}`, !r.ok && r.problems.some((p) => re.test(p)), r.problems.join("; ") || "passed");
	}
	check("§2 the driver's pay sums its driver-pay items", fix.driverPayIn(state().items, "test driver") === 600 && fix.driverPayIn(goodAfter().items, "test driver") === 300);
}

// ── §3 the command line ───────────────────────────────────────────────────────
{
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ssi-test-"));
	const db = path.join(tmp, "app.db");
	fs.writeFileSync(db, "");
	const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "" } });
	const refusals = [
		["an unknown option", ["--db", db, "--dry-run", "--force"], /unknown option/],
		["neither --dry-run nor --apply", ["--db", db], /--dry-run or --apply/],
		["both --dry-run and --apply", ["--db", db, "--dry-run", "--apply"], /--dry-run or --apply/],
		["no --db", ["--dry-run"], /--db is required/],
		["no sheet", ["--db", db, "--dry-run"], /--sheet-id \(or --values-json\) is required/],
		["an apply without --expect-payout", ["--db", db, "--values-json", db, "--apply"], /--apply needs --expect-payout/],
		["an --expect-payout that is not dollars", ["--db", db, "--values-json", db, "--apply", "--expect-payout", "5,346"], /--expect-payout=<dollars>/],
		["a database outside the app directory and the temp directory", ["--db", path.join(ROOT, "scripts", "app.db"), "--dry-run", "--values-json", db], /opens its own app directory's database/],
		["--data-dir with the app's own database", ["--db", path.join(ROOT, "app.db"), "--dry-run", "--values-json", db, "--data-dir", tmp], /--data-dir/],
	];
	for (const [name, args, re] of refusals) {
		const r = run(args);
		check(`§3 refuses ${name}`, r.status === 2 && re.test(r.stderr), `exit ${r.status}: ${r.stderr.trim().slice(0, 300)}`);
	}
	check("§3 nothing was opened", fs.statSync(db).size === 0);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── §4 the lift ───────────────────────────────────────────────────────────────
{
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	let lifted = null;
	try {
		lifted = closure(SRC, { roots: fix.ROOTS, routes: [fix.REOPEN_HEAD, fix.EXCLUDE_HEAD], provided: fix.PROVIDED, denied: fix.DENIED });
	} catch (err) {
		check("§4 the lift resolves", false, err.message.slice(0, 500));
	}
	if (lifted) {
		for (const n of [...fix.ROOTS, "reconcileInvestorPayouts", "writeLedgerFreeze", "closingFingerprint", "excludedDayGate", "writeInvoiceFileAtomically"]) {
			check(`§4 lifts ${n}`, lifted.names.includes(n));
		}
		check("§4 reaches no denied name", fix.DENIED.every((n) => !lifted.names.includes(n)));
		check("§4 the two route handlers are lifted", lifted.text.includes(fix.REOPEN_HEAD) && lifted.text.includes(fix.EXCLUDE_HEAD));
		let compiles = true;
		try { new Function(...fix.PROVIDED.filter((n) => n !== "getJobTrackingCached" && n !== "jtCacheInvalidate"), "__sheetData", `${lifted.text}\nfunction getJobTrackingCached() {}\nfunction jtCacheInvalidate() {}`); } catch (err) { compiles = err.message; }
		check("§4 the lifted code compiles", compiles === true, compiles);
	}
}

// ── §5 plan() ─────────────────────────────────────────────────────────────────
{
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const SCHEMA = `
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'owed' CHECK(status IN ('owed','processing','paid')), processed_at TEXT, processed_by TEXT, paid_at TEXT, paid_by TEXT, notes TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', finalized_at TEXT DEFAULT '', finalized_amount REAL, finalized_breakdown TEXT DEFAULT '', statement_pdf_file_name TEXT DEFAULT '', UNIQUE(owner_id, period));
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '');
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, adjusts TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '', cents INTEGER NOT NULL, load_id TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT '', truck TEXT NOT NULL DEFAULT '', expense_id INTEGER, source_id INTEGER, expense_type TEXT NOT NULL DEFAULT '', pay_type TEXT NOT NULL DEFAULT '', pickup_state TEXT NOT NULL DEFAULT '', delivery_state TEXT NOT NULL DEFAULT '', freeze_id TEXT NOT NULL, frozen_at TEXT NOT NULL);
CREATE TABLE financials_ledger_freezes (freeze_id TEXT PRIMARY KEY, period TEXT NOT NULL, source TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL DEFAULT 'system', item_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '', released_at TEXT NOT NULL DEFAULT '');
CREATE TABLE excluded_driver_days (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL, excluded_date TEXT NOT NULL, reason TEXT DEFAULT '', excluded_by TEXT DEFAULT '', excluded_at DATETIME DEFAULT CURRENT_TIMESTAMP, action TEXT DEFAULT 'remove', UNIQUE(driver_name, excluded_date));`;
	const SETTINGS = { costs: { fuel: true }, overheadMonthly: 0 };
	const api = (settings = SETTINGS) => ({ closedMonthSettings: () => new Map([["2026-09", SETTINGS]]), financialsSettings: () => settings });
	const W39 = fix.CORRECTION.invoices[1];
	const SIX39 = days({ Sunday: "569820951", Monday: "569820951", Tuesday: "569820951, 570008279", Wednesday: "570008279", Thursday: "570351713", Friday: "570351713" });
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ssi-plan-"));
	let n = 0;
	function fixture(mutate) {
		const file = path.join(tmp, `p${++n}.db`);
		const db = new Database(file);
		db.exec(SCHEMA);
		const inv = (o) => db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data)
			VALUES (@id, @invoice_number, @driver, @week_start, @week_end, @loads_count, @rate_per_load, @total_earnings, @status, @pdf_file_name, @render_data)`).run(o);
		const base = invoice();
		inv({ ...base, pdf_file_name: "INV-SK-2026W37-01.pdf" });
		inv({ ...base, id: 608, invoice_number: W39.invoiceNumber, week_start: "2026-09-26", week_end: "2026-10-02", status: "Approved", pdf_file_name: "INV-SK-2026W39-01.pdf",
			render_data: JSON.stringify({ ...JSON.parse(base.render_data), invoiceNumberSuffix: "SK-2026W39-01", days: SIX39 }) });
		inv({ ...base, id: 582, invoice_number: "INV-SK-2026W38-01", week_start: "2026-09-19", week_end: "2026-09-25", pdf_file_name: "INV-SK-2026W38-01.pdf" });
		db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T05:00:25Z', 'system')").run();
		const fz = "2026-09:close:2026-10-08T05:00:25Z:1";
		db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, item_count, summary, settings) VALUES (?, '2026-09', 'close', '2026-10-08T05:00:25Z', 3, '{}', ?)").run(fz, JSON.stringify(SETTINGS));
		const item = db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at) VALUES ('2026-09', ?, 'driver_pay', ?, ?, ?, 'test driver', 'T-1', 'fixed', ?, '2026-10-08T05:00:25Z')");
		item.run(5, "2026-09-13", 30000, "567844619", fz);
		item.run(5, "2026-09-27", 30000, "569820951", fz);
		item.run(5, "2026-09-14", 30000, "567844619", fz);
		db.prepare("INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, finalized_at, finalized_amount) VALUES (27, 5, '2026-09', 5046, '2026-10-30', 'owed', '2026-10-08T05:00:25Z', 5046)").run();
		if (mutate) mutate(db);
		db.close();
		return file;
	}
	function planOf(file, a = api()) {
		const db = new Database(file, { readonly: true });
		try { return { p: fix.plan(db, a) }; } catch (err) { return { err }; } finally { db.close(); }
	}
	const fresh = planOf(fixture());
	check("§5 a fresh plan", fresh.p && !fresh.p.alreadyApplied && fresh.p.fixes.length === 2 && fresh.p.overrides.length === 2 && fresh.p.removed.length === 2, fresh.err && fresh.err.message);
	check("§5 its overrides are the driver's two Sundays", fresh.p && fresh.p.overrides.map((o) => `${o.driver_name} ${o.excluded_date} ${o.action}`).join(",") === "test driver 2026-09-13 remove,test driver 2026-09-27 remove");
	const refusals = [
		["an audit row of the October-credit fix", (db) => db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, details) VALUES ('t', 0, ?, 'system', 'adjust_invoice', 'invoice', 'x')").run(fix.OCTOBER_CREDIT_ACTOR), /may already be on record.*October-credit/],
		["an October-credit token in another actor's audit row", (db) => db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, details) VALUES ('t', 1, 'someone', 'Super Admin', 'adjust_invoice', 'invoice', '[SPD-20260927 driver -300.00 INV-SK-2026W40-01]')").run(), /may already be on record/],
		["an October-credit note on a later invoice", (db) => db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, adjustment, adjustment_note) VALUES ('INV-SK-2026W40-01', 'test driver', '2026-10-03', '2026-10-09', 0, 'Ref SPD-20260927')").run(), /adjustment note names the October-credit/],
		["an adjustment on the investor's September payout", (db) => db.prepare("UPDATE investor_payouts SET adjustment = 150 WHERE id = 27").run(), /owner 5's 2026-09 payout carries an adjustment/],
		["an adjustment on a later payout row", (db) => db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, adjustment) VALUES (5, '2026-10', 100, '2026-11-27', 150)").run(), /owner 5's 2026-10 payout carries an adjustment/],
		["an adjustment on another of the driver's invoices", (db) => db.prepare("UPDATE invoices SET adjustment = -300 WHERE id = 582").run(), /INV-SK-2026W38-01 carries an adjustment/],
		["a paid payout", (db) => db.prepare("UPDATE investor_payouts SET status = 'paid', paid_at = '2026-10-09' WHERE id = 27").run(), /payout is paid/],
		["a reopened month", (db) => db.prepare("UPDATE period_locks SET status = 'reopened', reopen_reason = 'other' WHERE period = '2026-09'").run(), /2026-09 is reopened/],
		["an override someone else wrote", (db) => db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by) VALUES ('test driver', '2026-09-13', 'x', 'super_admin')").run(), /override this script did not write/],
		["a PDF file another invoice names", (db) => db.prepare("UPDATE invoices SET pdf_file_name = 'inv-sk-2026w37-01.pdf' WHERE id = 582").run(), /PDF file is also INV-SK-2026W38-01's/],
		["a frozen day at another rate", (db) => db.prepare("UPDATE financials_ledger_items SET cents = 25000 WHERE day = '2026-09-27'").run(), /frozen 2026-09-27 is \$250\.00/],
		["a frozen day missing", (db) => db.prepare("DELETE FROM financials_ledger_items WHERE day = '2026-09-13'").run(), /0 driver-pay item/],
		["a paid invoice", (db) => db.prepare("UPDATE invoices SET status = 'Paid', paid_at = '2026-10-09' WHERE id = 537").run(), /INV-SK-2026W37-01 is paid/],
	];
	for (const [name, mutate, re] of refusals) {
		const r = planOf(fixture(mutate));
		check(`§5 refuses: ${name}`, r.err instanceof fix.Refusal && re.test(r.err.message), r.err ? r.err.message : "planned");
	}
	const changed = planOf(fixture(), api({ ...SETTINGS, overheadMonthly: 500 }));
	check("§5 refuses changed Financials settings", changed.err instanceof fix.Refusal && /settings changed/.test(changed.err.message), changed.err && changed.err.message);

	// After a full apply: both invoices corrected with this script's audit rows,
	// both overrides its own, September finalized again by it.
	function applied(db, { overrides = 2 } = {}) {
		const p = fresh.p;
		for (const f of p.fixes) {
			db.prepare("UPDATE invoices SET loads_count = ?, total_earnings = ?, render_data = ? WHERE id = ?").run(f.after.loadsCount, f.after.total, f.renderData, f.row.id);
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('t', 0, ?, 'system', 'correct_invoice', 'invoice', ?, ?)").run(fix.ACTOR, String(f.row.id), `x [${fix.REF}]`);
		}
		for (const o of p.overrides.slice(0, overrides)) db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by, action) VALUES (?, ?, ?, ?, 'remove')").run(o.driver_name, o.excluded_date, o.reason, fix.ACTOR);
		db.prepare("UPDATE period_locks SET finalized_by = ?, reopened_at = 't', reopened_by = ?, reopen_reason = ? WHERE period = '2026-09'").run(fix.ACTOR, fix.ACTOR, fix.CORRECTION.reason);
	}
	const done = planOf(fixture((db) => applied(db)));
	check("§5 after a full apply: already applied", done.p && done.p.alreadyApplied === true, done.err && done.err.message);
	const partial = planOf(fixture((db) => applied(db, { overrides: 1 })));
	check("§5 a partial state refuses", partial.err instanceof fix.Refusal && /part of this correction is on record/.test(partial.err.message), partial.err ? partial.err.message : "planned");

	const fp = fix.planFingerprint(fresh.p);
	check("§5 the same rows give the same fingerprint", fix.planFingerprint(planOf(fixture()).p) === fp);
	const moved = planOf(fixture((db) => db.prepare("UPDATE invoices SET submitted_at = 'x' WHERE id = 608").run()));
	check("§5 a changed invoice row moves the fingerprint", moved.p && fix.planFingerprint(moved.p) !== fp);
	const payMoved = planOf(fixture((db) => db.prepare("UPDATE investor_payouts SET due_date = '2026-10-31' WHERE id = 27").run()));
	check("§5 a changed payout row moves the fingerprint", payMoved.p && fix.planFingerprint(payMoved.p) !== fp);
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`test-data-fix-september-sunday-invoices: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
