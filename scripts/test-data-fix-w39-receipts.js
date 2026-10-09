#!/usr/bin/env node
/**
 * scripts/data-fix-w39-receipts.js: its decisions, its September comparison,
 * its command line and its lift of server.js.
 *
 *   §1 plan(), on a file database with the production schema of the tables it
 *      reads and a fictional driver: a fresh plan adds both receipts after the
 *      invoice's own, with the sum as the new receipts total, and leaves Total
 *      Due alone; each of these refuses, named: a paid, processing, rejected,
 *      deleted or manual invoice; a receipt that is pending, rejected, another
 *      amount, another date, another driver's, or on another invoice already;
 *      a recorded receipts total that is not the receipts' sum; a paid payout;
 *      a reopened month; a PDF file another invoice names; changed Financials
 *      settings; the state after a full apply is "already applied", a partial
 *      one refuses; the fingerprint a re-check inside the transaction compares
 *      moves with any row the plan read;
 *   §2 compareSeptember(): the correction alone passes; each of these fails,
 *      named: another invoice changed, the invoice changed beyond its receipt
 *      record, the wrong receipts or total, a frozen item changed, a payout
 *      moved, the month not finalized again, a receipt changed;
 *   §3 the command line refuses (exit 2, nothing opened): an unknown option,
 *      neither or both of --dry-run and --apply, no --db, no sheet, an apply
 *      without --expect-receipts-total or with one that is not dollars, a
 *      database outside the app directory and the temp directory;
 *   §4 the lift: every root and the reopen route resolve in this checkout's
 *      server.js, reach none of the denied names, and the lifted code compiles.
 *
 * The run on a copy of production's database (reopen, receipts, close,
 * comparison, PDF) is the script's own --dry-run; the rehearsal on the local
 * copy is in the PR.
 *
 * Pure: a temp directory, child processes of the script itself, no server, no
 * network. Run: node scripts/test-data-fix-w39-receipts.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-w39-receipts.js");
const fix = require(SCRIPT);
const { closure } = require("./lib/server-lift");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
// The server's own driver-name key and receipt filter, as plan() gets them.
const real = new Function(`${closure(SRC, { roots: ["normalizeDriverName", "EXPENSE_PNL_FILTER"], provided: [], denied: [] }).text}\nreturn { normalizeDriverName, EXPENSE_PNL_FILTER };`)();

// ── §1 plan() ─────────────────────────────────────────────────────────────────
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const SCHEMA = `
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT '2026-10-09 05:00:00');
CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'owed' CHECK(status IN ('owed','processing','paid')), processed_at TEXT, processed_by TEXT, paid_at TEXT, paid_by TEXT, notes TEXT DEFAULT '', created_at DATETIME DEFAULT '2026-10-01 05:00:00', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', finalized_at TEXT DEFAULT '', finalized_amount REAL, finalized_breakdown TEXT DEFAULT '', statement_pdf_file_name TEXT DEFAULT '', UNIQUE(owner_id, period));
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT '2026-10-03 00:00:00', processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '');
CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL, load_id TEXT DEFAULT '', type TEXT NOT NULL, amount REAL NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL, status TEXT DEFAULT 'Pending', owner_id INTEGER DEFAULT 0, posted_period TEXT DEFAULT '');
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT '2026-10-08 05:00:25');
CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, adjusts TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '', cents INTEGER NOT NULL, load_id TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT '', truck TEXT NOT NULL DEFAULT '', expense_id INTEGER, source_id INTEGER, expense_type TEXT NOT NULL DEFAULT '', pay_type TEXT NOT NULL DEFAULT '', pickup_state TEXT NOT NULL DEFAULT '', delivery_state TEXT NOT NULL DEFAULT '', freeze_id TEXT NOT NULL, frozen_at TEXT NOT NULL);
CREATE TABLE financials_ledger_freezes (freeze_id TEXT PRIMARY KEY, period TEXT NOT NULL, source TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL DEFAULT 'system', item_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '', released_at TEXT NOT NULL DEFAULT '');`;
const SETTINGS = { costs: { fuel: true }, overheadMonthly: 0 };
const api = (settings = SETTINGS) => ({ ...real, closedMonthSettings: () => new Map([["2026-09", SETTINGS]]), financialsSettings: () => settings });
const NAME = fix.CORRECTION.invoiceNumber;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "w39r-plan-"));
let n = 0;
function fixture(mutate) {
	const file = path.join(tmp, `p${++n}.db`);
	const db = new Database(file);
	db.exec(SCHEMA);
	const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, expense_ids, render_data)
		VALUES (@id, @invoice_number, @driver, @week_start, @week_end, 5, 300, 1500, @expenses_total, @status, @pdf_file_name, @expense_ids, '{"totalDue":1500,"__templateName":"service_invoice"}')`);
	inv.run({ id: 608, invoice_number: NAME, driver: "test driver", week_start: "2026-09-26", week_end: "2026-10-02", expenses_total: 120.5, status: "Approved", pdf_file_name: `${NAME}.pdf`, expense_ids: "[247,253]" });
	inv.run({ id: 640, invoice_number: "INV-SK-2026W40-01", driver: "test driver", week_start: "2026-10-03", week_end: "2026-10-09", expenses_total: 0, status: "Submitted", pdf_file_name: "INV-SK-2026W40-01.pdf", expense_ids: "[]" });
	const exp = db.prepare("INSERT INTO expenses (id, driver, type, amount, date, status, owner_id) VALUES (?, ?, ?, ?, ?, ?, 5)");
	exp.run(247, "Test  Driver", "Fuel", 100, "2026-09-27", "Approved");
	exp.run(253, "test driver", "Other", 20.5, "2026-09-29", "Approved");
	exp.run(254, "Test Driver", "Other", 5.25, "2026-09-28", "Approved");
	exp.run(255, "Test Driver", "Other", 15.25, "2026-09-28", "Approved");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-09T04:51:51Z', 'script:data-fix-september-sunday-invoices')").run();
	const fz = "2026-09:close:2026-10-09T04:51:51Z:2";
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, item_count, summary, settings) VALUES (?, '2026-09', 'close', '2026-10-09T04:51:51Z', 2, '{}', ?)").run(fz, JSON.stringify(SETTINGS));
	const item = db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, expense_id, freeze_id, frozen_at) VALUES ('2026-09', 5, 'trip', '2026-09-28', ?, ?, ?, '2026-10-09T04:51:51Z')");
	item.run(525, 254, fz);
	item.run(1525, 255, fz);
	db.prepare("INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, finalized_at, finalized_amount) VALUES (27, 5, '2026-09', 5346, '2026-10-30', 'owed', '2026-10-09T04:51:51Z', 5346)").run();
	if (mutate) mutate(db);
	db.close();
	return file;
}
function planOf(file, a = api()) {
	const db = new Database(file, { readonly: true });
	try { return { p: fix.plan(db, a) }; } catch (err) { return { err }; } finally { db.close(); }
}
const fresh = planOf(fixture());
{
	const p = fresh.p;
	check("§1 a fresh plan", p && !p.alreadyApplied, fresh.err && fresh.err.message);
	if (p) {
		check("§1 the receipts go in at their date, as the generator orders them", JSON.stringify(p.after.ids) === "[247,254,255,253]", JSON.stringify(p.after.ids));
		check("§1 the receipts total is the sum", p.after.total === 141 && p.before.total === 120.5, `${p.before.total} -> ${p.after.total}`);
		check("§1 both receipts are in September's ledger", p.inLedger.every(Boolean));
		check("§1 the driver is read from the invoice", p.driver === "test driver");
	}
}
const refusals = [
	["a paid invoice", (db) => db.prepare("UPDATE invoices SET status = 'Paid', paid_at = '2026-10-09' WHERE id = 608").run(), /is paid/],
	["a paid stamp on an approved invoice", (db) => db.prepare("UPDATE invoices SET paid_at = '2026-10-09' WHERE id = 608").run(), /is paid/],
	["a processing invoice", (db) => db.prepare("UPDATE invoices SET status = 'Processing' WHERE id = 608").run(), /is Processing/],
	["a rejected invoice", (db) => db.prepare("UPDATE invoices SET status = 'Rejected' WHERE id = 608").run(), /is Rejected/],
	["a deleted invoice", (db) => db.prepare("UPDATE invoices SET deleted_at = '2026-10-09' WHERE id = 608").run(), /is deleted/],
	["a manual invoice", (db) => db.prepare("UPDATE invoices SET is_manual = 1 WHERE id = 608").run(), /manual invoice/],
	["a pending receipt", (db) => db.prepare("UPDATE expenses SET status = 'Pending' WHERE id = 254").run(), /#254 is Pending, not Approved/],
	["a rejected receipt", (db) => db.prepare("UPDATE expenses SET status = 'Rejected' WHERE id = 255").run(), /#255 is Rejected/],
	["another amount", (db) => db.prepare("UPDATE expenses SET amount = 6 WHERE id = 254").run(), /#254 is \$6\.00, not the \$5\.25/],
	["another date", (db) => db.prepare("UPDATE expenses SET date = '2025-09-28' WHERE id = 254").run(), /dated 2025-09-28/],
	["another driver's receipt", (db) => db.prepare("UPDATE expenses SET driver = 'Someone Else' WHERE id = 255").run(), /not INV-SK-2026W39-01's driver's/],
	["a receipt already on another invoice", (db) => db.prepare("UPDATE invoices SET expense_ids = '[254]', expenses_total = 5.25 WHERE id = 640").run(), /#254 is already on INV-SK-2026W40-01/],
	["a receipts total that is not the receipts' sum", (db) => db.prepare("UPDATE invoices SET expenses_total = 99 WHERE id = 608").run(), /receipts total \$99\.00 is not the sum/],
	["a receipt the invoice names that does not exist", (db) => db.prepare("UPDATE invoices SET expense_ids = '[247,253,999]' WHERE id = 608").run(), /do not exist: 999/],
	["a paid payout", (db) => db.prepare("UPDATE investor_payouts SET status = 'paid', paid_at = '2026-10-09' WHERE id = 27").run(), /payout is paid/],
	["a reopened month", (db) => db.prepare("UPDATE period_locks SET status = 'reopened', reopen_reason = 'other' WHERE period = '2026-09'").run(), /2026-09 is reopened/],
	["a PDF file another invoice names", (db) => db.prepare("UPDATE invoices SET pdf_file_name = ? WHERE id = 640").run(`${NAME.toLowerCase()}.pdf`), /PDF file is also INV-SK-2026W40-01's/],
	["a month never finalized", (db) => db.prepare("DELETE FROM period_locks").run(), /2026-09 is not finalized/],
	["an owner-operator invoice", (db) => db.prepare("UPDATE invoices SET render_data = '{\"__templateName\":\"service_invoice_owner_op\"}' WHERE id = 608").run(), /not a day-rate invoice/],
	["an invoice with no snapshot", (db) => db.prepare("UPDATE invoices SET render_data = '{}' WHERE id = 608").run(), /not a day-rate invoice/],
	["a receipt outside September's frozen ledger", (db) => db.prepare("DELETE FROM financials_ledger_items WHERE expense_id = 255").run(), /#255 are not in September's frozen ledger/],
	["one of the two receipts already on the invoice", (db) => db.prepare("UPDATE invoices SET expense_ids = '[247,253,254]', expenses_total = 125.75 WHERE id = 608").run(), /part of this correction is on record/],
];
for (const [name, mutate, re] of refusals) {
	const r = planOf(fixture(mutate));
	check(`§1 refuses: ${name}`, r.err instanceof fix.Refusal && re.test(r.err.message), r.err ? r.err.message : "planned");
}
{
	for (const status of ["Draft", "Submitted"]) {
		const ok = planOf(fixture((db) => db.prepare("UPDATE invoices SET status = ? WHERE id = 608").run(status)));
		check(`§1 a ${status} invoice is corrected too`, ok.p && !ok.p.alreadyApplied, ok.err && ok.err.message);
	}
	const deletedOther = planOf(fixture((db) => db.prepare("UPDATE invoices SET expense_ids = '[254]', expenses_total = 5.25, deleted_at = '2026-10-05' WHERE id = 640").run()));
	check("§1 a receipt on a deleted invoice only is allowed", deletedOther.p && !deletedOther.p.alreadyApplied, deletedOther.err && deletedOther.err.message);
	const changed = planOf(fixture(), api({ ...SETTINGS, overheadMonthly: 500 }));
	check("§1 refuses changed Financials settings", changed.err instanceof fix.Refusal && /settings changed/.test(changed.err.message), changed.err && changed.err.message);
	// After a full apply: the receipts on the invoice with this script's audit
	// row, September finalized again by it.
	const applied = (db, { audit = true, receipts = true } = {}) => {
		if (receipts) db.prepare("UPDATE invoices SET expense_ids = '[247,254,255,253]', expenses_total = 141 WHERE id = 608").run();
		if (audit) db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('t', 0, ?, 'system', 'correct_invoice', 'invoice', '608', ?)").run(fix.ACTOR, `x [${fix.REF}]`);
		db.prepare("UPDATE period_locks SET finalized_by = ?, reopened_at = 't', reopened_by = ?, reopen_reason = ? WHERE period = '2026-09'").run(fix.ACTOR, fix.ACTOR, fix.CORRECTION.reason);
	};
	const done = planOf(fixture((db) => applied(db)));
	check("§1 after a full apply: already applied", done.p && done.p.alreadyApplied === true, done.err && done.err.message);
	const noAudit = planOf(fixture((db) => applied(db, { audit: false })));
	check("§1 the receipts on the invoice without this script's record refuses", noAudit.err instanceof fix.Refusal && /part of this correction is on record/.test(noAudit.err.message), noAudit.err ? noAudit.err.message : "planned");
	const noReceipts = planOf(fixture((db) => applied(db, { receipts: false })));
	check("§1 the month finalized by this script without the receipts refuses", noReceipts.err instanceof fix.Refusal && /part of this correction is on record/.test(noReceipts.err.message), noReceipts.err ? noReceipts.err.message : "planned");

	const fp = fix.planFingerprint(fresh.p);
	check("§1 the same rows give the same fingerprint", fix.planFingerprint(planOf(fixture()).p) === fp);
	const moved = [
		["an invoice field", (db) => db.prepare("UPDATE invoices SET submitted_at = 'x' WHERE id = 608").run()],
		["a receipt", (db) => db.prepare("UPDATE expenses SET type = 'Fuel' WHERE id = 255").run()],
		["the payout row", (db) => db.prepare("UPDATE investor_payouts SET due_date = '2026-10-31' WHERE id = 27").run()],
	];
	for (const [name, mutate] of moved) {
		const m = planOf(fixture(mutate));
		check(`§1 a changed ${name} moves the fingerprint`, m.p && fix.planFingerprint(m.p) !== fp, m.err && m.err.message);
	}
}

// ── §2 compareSeptember() ─────────────────────────────────────────────────────
{
	const inv = (over = {}) => ({ id: 608, invoice_number: NAME, status: "Approved", total_earnings: 1500, adjustment: 0, expense_ids: "[247,253]", expenses_total: 120.5, render_data: "{}", ...over });
	const pay = (over = {}) => ({ id: 27, owner_id: 5, amount: 5346, status: "owed", paid_at: null, finalized_at: "2026-10-09T04:51:51Z", finalized_amount: 5346, finalized_breakdown: "{}", ...over });
	const state = (over = {}) => ({
		lock: { period: "2026-09", status: "locked", reopen_reason: "" },
		payouts: [pay()],
		items: ["a", "b"],
		freezes: [{ source: "close", frozen_by: "x", item_count: 2, summary: "{}", settings: "{}" }],
		invoices: [inv(), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 10 }],
		excluded: [],
		unchanged: { receipts: "r", otherInvoices: "o" },
		...over,
	});
	const want = { invoiceId: 608, ids: [247, 253, 254, 255], total: 141, reason: fix.CORRECTION.reason };
	const after = (over = {}) => state({
		lock: { period: "2026-09", status: "locked", reopen_reason: fix.CORRECTION.reason },
		payouts: [pay({ finalized_at: "2026-10-09T05:37:44Z" })],
		freezes: [{ source: "close", frozen_by: fix.ACTOR, item_count: 2, summary: "{}", settings: "{}" }],
		invoices: [inv({ expense_ids: "[247,253,254,255]", expenses_total: 141 }), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 10 }],
		...over,
	});
	const ok = fix.compareSeptember(state(), after(), want);
	check("§2 the correction alone passes", ok.ok, ok.problems.join("; "));
	check("§2 it reports the invoice's receipts", ok.changes.some((c) => c.what === "invoice" && c.after.total === 141 && c.before.total === 120.5 && c.after.due === 1500));
	const fails = [
		["another invoice changed", after({ invoices: [inv({ expense_ids: "[247,253,254,255]", expenses_total: 141 }), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 11 }] }), /invoice INV-SK-2026W38-01 changed/],
		["the invoice's total changed", after({ invoices: [inv({ expense_ids: "[247,253,254,255]", expenses_total: 141, total_earnings: 1200 }), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 10 }] }), /total_earnings changed/],
		["the wrong receipts", after({ invoices: [inv({ expense_ids: "[247,253,254]", expenses_total: 141 }), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 10 }] }), /its receipts are \[247,253,254\]/],
		["the wrong receipts total", after({ invoices: [inv({ expense_ids: "[247,253,254,255]", expenses_total: 140 }), { id: 582, invoice_number: "INV-SK-2026W38-01", expenses_total: 10 }] }), /receipts total is \$140\.00/],
		["a frozen item changed", after({ items: ["a", "c"] }), /frozen items changed/],
		["the Financials summary changed", after({ freezes: [{ source: "close", frozen_by: fix.ACTOR, item_count: 2, summary: "{\"revenue\":1}", settings: "{}" }] }), /freeze: summary changed/],
		["a payout moved", after({ payouts: [pay({ amount: 5356, finalized_amount: 5356, finalized_at: "t" })] }), /payout: amount changed/],
		["a payout not finalized again", after({ payouts: [pay({ finalized_at: "" })] }), /not finalized after the run/],
		["the month not finalized again", after({ lock: { period: "2026-09", status: "reopened", reopen_reason: fix.CORRECTION.reason } }), /not finalized after the run/],
		["another reopen reason", after({ lock: { period: "2026-09", status: "locked", reopen_reason: "other" } }), /reopen reason/],
		["a receipt changed", after({ unchanged: { receipts: "r2", otherInvoices: "o" } }), /receipts changed/],
		["an override added", after({ excluded: [{ driver_name: "x" }] }), /overrides changed/],
	];
	for (const [name, a, re] of fails) {
		const r = fix.compareSeptember(state(), a, want);
		check(`§2 fails: ${name}`, !r.ok && r.problems.some((p) => re.test(p)), r.problems.join("; ") || "passed");
	}
}

// ── §3 the command line ───────────────────────────────────────────────────────
{
	const db = path.join(tmp, "cli.db");
	fs.writeFileSync(db, "");
	const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "" } });
	const cli = [
		["an unknown option", ["--db", db, "--dry-run", "--force"], /unknown option/],
		["neither --dry-run nor --apply", ["--db", db], /--dry-run or --apply/],
		["both --dry-run and --apply", ["--db", db, "--dry-run", "--apply"], /--dry-run or --apply/],
		["no --db", ["--dry-run"], /--db is required/],
		["no sheet", ["--db", db, "--dry-run"], /--sheet-id \(or --values-json\) is required/],
		["an apply without --expect-receipts-total", ["--db", db, "--values-json", db, "--apply"], /--apply needs --expect-receipts-total/],
		["an --expect-receipts-total that is not dollars", ["--db", db, "--values-json", db, "--apply", "--expect-receipts-total", "2,310.95"], /--expect-receipts-total=<dollars>/],
		["a database outside the app directory and the temp directory", ["--db", path.join(ROOT, "scripts", "app.db"), "--dry-run", "--values-json", db], /opens its own app directory's database/],
	];
	for (const [name, args, re] of cli) {
		const r = run(args);
		check(`§3 refuses ${name}`, r.status === 2 && re.test(r.stderr), `exit ${r.status}: ${r.stderr.trim().slice(0, 300)}`);
	}
	check("§3 nothing was opened", fs.statSync(db).size === 0);
}

// ── §4 the lift ───────────────────────────────────────────────────────────────
{
	let lifted = null;
	try {
		lifted = closure(SRC, { roots: fix.ROOTS, routes: [fix.REOPEN_HEAD], provided: fix.PROVIDED, denied: fix.DENIED });
	} catch (err) {
		check("§4 the lift resolves", false, err.message.slice(0, 500));
	}
	if (lifted) {
		for (const name of [...fix.ROOTS, "reconcileInvestorPayouts", "writeLedgerFreeze", "closingFingerprint", "writeInvoiceFileAtomically"]) {
			check(`§4 lifts ${name}`, lifted.names.includes(name));
		}
		check("§4 reaches no denied name", fix.DENIED.every((x) => !lifted.names.includes(x)));
		check("§4 the reopen route handler is lifted", lifted.text.includes(fix.REOPEN_HEAD));
		let compiles = true;
		try { new Function(...fix.PROVIDED.filter((x) => x !== "getJobTrackingCached" && x !== "jtCacheInvalidate"), "__sheetData", `${lifted.text}\nfunction getJobTrackingCached() {}\nfunction jtCacheInvalidate() {}`); } catch (err) { compiles = err.message; }
		check("§4 the lifted code compiles", compiles === true, compiles);
	}
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-data-fix-w39-receipts: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
