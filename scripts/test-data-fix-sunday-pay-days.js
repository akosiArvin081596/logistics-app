#!/usr/bin/env node
/**
 * scripts/data-fix-sunday-pay-days.js, end to end on small file databases
 * under a temp directory (the production schema of the tables it reads and
 * writes, with a fictional driver), through its command line and, where a
 * command line cannot reach, its exported parts:
 *
 *   §1 the dry run's handle is read-only (a write through it throws) and the
 *      run writes nothing (file bytes and every table unchanged); it prints
 *      both lines with exact amounts and the corrections already on record;
 *   §2 the apply writes exactly the two lines (the invoice adjustment, the
 *      payout adjustment and its history row) and two system audit rows, with
 *      the exact amounts; the closed month's rows do not move;
 *   §3 a second apply writes nothing and says the lines are already applied;
 *   §4 the two days are independent and combine on the same targets; the
 *      second day's investor amount is replayed after the first (138 + 137 at
 *      $275 a day); tokens are grouped by owner as well as period;
 *   §5 a missing October home is skipped with when to re-run;
 *   §6 a paid invoice, a paid payout and a closed October are refused;
 *   §7 uncertain amounts are skipped: an invoice/ledger mismatch, a replay that
 *      does not reproduce the settlement (and the dry run does not call it
 *      exact), an adjustment the script did not write;
 *   §8 a day already corrected by hand (an adjustment on the source invoice or
 *      on the closed month's payout row), a rejected or deleted source
 *      invoice, a Settlement adjustment among the frozen items, a ledger not
 *      frozen by the close: nothing is written;
 *   §9 the settlement replay: a loss carried in reproduces and posts; a month
 *      that absorbed its whole share, a loss month and a changed loss carried
 *      past the month are skipped; a lease month posts nothing;
 *   §10 the route's limits: a Total Due below $0 (the claw-back is not moved to
 *      another invoice), the $10,000 cap, never inverted, the note length;
 *   §11 all or nothing: a failure on the second write rolls back the first and
 *      its audit row; closed-month triggers that cannot be installed refuse the
 *      run before any write;
 *   §12 refusals: an unapproved case (even with its --approval), an unlisted
 *      day, a missing or wrong --approval, an unknown option, a database
 *      outside the temp directory, a source month that is not closed;
 *   §13 re-runs: a skip that needs a decision offers no re-run command and says
 *      not to re-run; a hand adjustment on any of the driver's invoices from
 *      the source week on (a paid one, a manual one) or on another of the
 *      investor's payout rows skips that line, so a re-run never takes the day
 *      back twice; an earliest October invoice past Draft or Submitted is never
 *      passed over for a later week (a re-run after it is approved, or a first
 *      apply, stops for a decision); skips that only wait keep their re-run
 *      command; a write that does not read back as written rolls the run back.
 *
 * Pure: a temp directory, child processes of the script itself, no server, no
 * network. Run: node scripts/test-data-fix-sunday-pay-days.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-sunday-pay-days.js");
const ACTOR = "script:data-fix-sunday-pay-days";

let pass = 0, fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }
const fix = require(SCRIPT);
const financialsCalc = require("../lib/financials-calc");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sunday-fix-test-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// The production schema of every table the script reads or writes.
const SCHEMA = `
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'owed' CHECK(status IN ('owed','processing','paid')), processed_at TEXT, processed_by TEXT, paid_at TEXT, paid_by TEXT, notes TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', finalized_at TEXT DEFAULT '', finalized_amount REAL, finalized_breakdown TEXT DEFAULT '', statement_pdf_file_name TEXT DEFAULT '', UNIQUE(owner_id, period));
CREATE TABLE investor_payout_history (id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER, owner_id INTEGER NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'recompute', old_amount REAL, new_amount REAL, delta REAL, detail TEXT DEFAULT '', breakdown TEXT DEFAULT '', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '');
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, adjusts TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '', cents INTEGER NOT NULL, load_id TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT '', truck TEXT NOT NULL DEFAULT '', expense_id INTEGER, source_id INTEGER, expense_type TEXT NOT NULL DEFAULT '', pay_type TEXT NOT NULL DEFAULT '', pickup_state TEXT NOT NULL DEFAULT '', delivery_state TEXT NOT NULL DEFAULT '', freeze_id TEXT NOT NULL, frozen_at TEXT NOT NULL);
CREATE TABLE financials_ledger_freezes (freeze_id TEXT PRIMARY KEY, period TEXT NOT NULL, source TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL DEFAULT 'system', item_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '', released_at TEXT NOT NULL DEFAULT '');
CREATE TABLE investor_config (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(owner_id, key));
CREATE TABLE pay_rate_history (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL CHECK(subject IN ('truck','driver')), subject_key TEXT NOT NULL, rate REAL NOT NULL, effective_from TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'change');
CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL, owner_id INTEGER DEFAULT 0, driver_pay_daily REAL DEFAULT 0, status TEXT DEFAULT 'Active');
`;

const DRIVER = "pat sample";
const FREEZE = "2026-09:close:2026-10-08T05:00:25.792Z:1";
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function renderData(totals, loads) {
	const days = {};
	WEEK.forEach((name, i) => { days[name] = { loadBol: loads[i] || "", total: totals[i], completed: totals[i] > 0 }; });
	return JSON.stringify({ driverName: "Pat Sample", totalDue: totals.reduce((a, b) => a + b, 0), days, adjustment: 0, adjustmentNote: "", __templateName: "service_invoice" });
}

const auditRow = (db, details) => db.prepare(
	"INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-10-10T12:00:00.000Z', 0, ?, 'system', 'adjust_invoice', 'invoice', '640', ?)"
).run(ACTOR, details);

function buildFixture(name, opts = {}) {
	const o = {
		rate: 300, extraRevenueCents: 0, extraFixedCents: 0,
		october: true, octoberStatus: "owed", octoberAmount: 4321, octoberAdjustment: null,
		w40: "Submitted", w40Total: null, w40Adjustment: null, w41: false,
		lockOctober: false, ledgerSundayCents: null, shareSkew: 0, septemberLocked: true,
		w39Adjustment: 0, w39Status: "Submitted", w39Deleted: false, septAdjustment: 0,
		settlementAdj: null, freezeSource: "close", carriedIn: 0, lease: false,
		failPayoutUpdate: false, payoutsAsView: false, ownLines: [],
		manualAdjustment: null, novemberAdjustment: null, tamperNote: false,
		...opts,
	};
	const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	const r = o.rate;
	const rc = Math.round(r * 100);
	if (o.septemberLocked) db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-08T05:00:25.792Z')").run();
	if (o.lockOctober) db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-10', 'locked', '2026-11-08T06:00:00.000Z')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'settlement_grace_days', '7'), (0, 'investor_split_pct', '50')").run();
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id, driver_pay_daily) VALUES (11, 'Logisx-#91', 5, ?)").run(r);
	db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES ('truck', '11', ?, '2026-10-03T03:00:20.343Z', 'seed'), ('driver', ?, ?, '2026-10-03T03:00:20.343Z', 'seed')").run(r, DRIVER, r);

	// The frozen September ledger for owner 5.
	const items = [
		{ kind: "revenue", day: "2026-09-14", cents: 1200000 + o.extraRevenueCents, load: "567844619" },
		{ kind: "revenue", day: "2026-09-28", cents: 345679, load: "569820951" },
		{ kind: "driver_pay", day: "2026-09-13", cents: rc, load: "567484733" },
		{ kind: "driver_pay", day: "2026-09-14", cents: rc, load: "567844619" },
		{ kind: "driver_pay", day: "2026-09-27", cents: o.ledgerSundayCents == null ? rc : o.ledgerSundayCents, load: "569820951" },
		{ kind: "driver_pay", day: "2026-09-28", cents: rc, load: "569820951" },
		{ kind: "fixed", day: "", cents: 304333 + o.extraFixedCents, load: "" },
		{ kind: "trip", day: "2026-09-20", cents: 100125, load: "567850506" },
	];
	if (o.settlementAdj) items.push({ kind: "settlement_adjustment", adjusts: o.settlementAdj.adjusts, day: "", cents: o.settlementAdj.cents, load: "" });
	const ins = db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, adjusts, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at) VALUES ('2026-09', 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-08T05:00:25.792Z')");
	for (const it of items) {
		const named = it.kind !== "fixed" && it.kind !== "settlement_adjustment";
		ins.run(it.kind, it.adjusts || "", it.day, it.cents, it.load, named ? DRIVER : "", "Logisx-#91", it.kind === "driver_pay" ? "fixed" : "", FREEZE);
	}
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, item_count) VALUES (?, '2026-09', ?, '2026-10-08T05:00:25.792Z', ?)").run(FREEZE, o.freezeSource, items.length);
	const fig = financialsCalc.monthFiguresFromItems(items.map((i) => ({ ...i, month: "2026-09" })))["2026-09"];
	let breakdown, amount;
	if (o.lease) {
		amount = 3000;
		breakdown = { ...fig, splitPct: null, monthShare: 3000, payoutBasis: { type: "lease", leaseAmount: 3000, paidAmount: 3000, coveredDays: 30, daysInMonth: 30, reason: null } };
	} else {
		const share = Math.round(fig.netProfit * 0.5) + o.shareSkew;
		const carried = share > 0 ? o.carriedIn : 0;
		amount = share > 0 ? share - carried : 0;
		breakdown = { ...fig, splitPct: 50, monthShare: share, lossCarriedIn: carried, lossDeferred: share < 0 ? -share : 0 };
	}
	db.prepare(
		`INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, finalized_at, finalized_amount, finalized_breakdown, adjustment)
		 VALUES (27, 5, '2026-09', ?, '2026-10-30', 'owed', '2026-10-08T05:00:25.792Z', ?, ?, ?)`
	).run(amount, amount, JSON.stringify(breakdown), o.septAdjustment);
	if (o.october) {
		const adj = o.octoberAdjustment;
		db.prepare("INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, adjustment, adjustment_note, adjusted_by) VALUES (31, 5, '2026-10', ?, '2026-11-27', ?, ?, ?, ?)")
			.run(o.octoberAmount, o.octoberStatus, adj ? adj.amount : 0, adj ? adj.note : "", adj ? ACTOR : "");
	}

	const insInv = db.prepare(
		`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, load_ids, render_data, paid_at, adjustment, adjustment_note, adjusted_by, deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const sixDays = [0, r, r, r, r, r, r];
	insInv.run(537, "INV-SK-2026W37-01", DRIVER, "2026-09-12", "2026-09-18", 6, r, 6 * r, "Submitted",
		JSON.stringify(["#540935268", "567484733", "567844619", "568073441", "567850506"]),
		renderData(sixDays, ["", "567844619", "567844619", "567844619", "568073441, 567850506", "568073441, 567850506", "567850506"]), "", 0, "", "", "");
	insInv.run(608, "INV-SK-2026W39-01", DRIVER, "2026-09-26", "2026-10-02", 6, r, 6 * r, o.w39Status,
		JSON.stringify(["569246552", "569820951", "569139441", "570008279"]),
		renderData(sixDays, ["", "569820951", "569820951, 569139441", "569820951, 569139441, 570008279", "570008279", "570008279", "570008279"]), "",
		o.w39Adjustment, o.w39Adjustment ? "late deduction" : "", o.w39Adjustment ? "super_admin" : "", o.w39Deleted ? "2026-10-05T10:00:00.000Z" : "");
	if (o.w40) {
		const adj = o.w40Adjustment;
		const total = o.w40Total == null ? 5 * r : o.w40Total;
		insInv.run(640, "INV-SK-2026W40-01", DRIVER, "2026-10-03", "2026-10-09", 5, r, total, o.w40,
			JSON.stringify(["570351713"]), renderData([0, 0, r, r, r, r, r], ["", "", "570351713", "570351713", "570351713", "570351713", "570351713"]),
			o.w40 === "Paid" ? "2026-10-12T15:00:00.000Z" : "", adj ? adj.amount : 0, adj ? adj.note : "", adj ? (adj.by || "super_admin") : "", "");
	}
	if (o.w41) {
		insInv.run(650, "INV-SK-2026W41-01", DRIVER, "2026-10-10", "2026-10-16", 5, r, 5 * r, "Submitted",
			JSON.stringify(["570400000"]), renderData([0, 0, r, r, r, r, r], ["", "", "570400000", "570400000", "570400000", "570400000", "570400000"]), "", 0, "", "", "");
	}
	if (o.manualAdjustment) {
		db.prepare(
			`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, total_earnings, status, adjustment, adjustment_note, adjusted_by, is_manual)
			 VALUES (660, 'INV-SK-MANUAL-01', ?, ?, ?, 0, 'Submitted', ?, ?, 'super_admin', 1)`
		).run(DRIVER, o.manualAdjustment.start || "2026-10-01", o.manualAdjustment.end || "2026-10-05", o.manualAdjustment.amount, o.manualAdjustment.note);
	}
	if (o.novemberAdjustment) {
		db.prepare("INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, adjustment, adjustment_note, adjusted_by) VALUES (35, 5, '2026-11', 0, '2026-12-25', 'owed', ?, ?, 'super_admin')")
			.run(o.novemberAdjustment.amount, o.novemberAdjustment.note);
	}
	for (const details of o.ownLines) auditRow(db, details);
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-09-28T19:59:42.061Z', 1, 'super_admin', 'Super Admin', 'dispatch_load', 'load', '569820951', 'Assigned driver Pat Sample to load 569820951')").run();
	if (o.failPayoutUpdate) {
		db.exec("CREATE TRIGGER test_fail_payout_update BEFORE UPDATE ON investor_payouts BEGIN SELECT RAISE(ABORT, 'forced failure on the second write'); END;");
	}
	if (o.tamperNote) {
		// Changes what was written, after the write: the read-back must refuse it.
		db.exec("CREATE TRIGGER test_tamper_note AFTER UPDATE OF adjustment ON invoices BEGIN UPDATE invoices SET adjustment_note = 'tampered' WHERE id = NEW.id; END;");
	}
	if (o.payoutsAsView) {
		db.exec("ALTER TABLE investor_payouts RENAME TO investor_payouts_data; CREATE VIEW investor_payouts AS SELECT * FROM investor_payouts_data;");
	}
	db.close();
	return file;
}

function run(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, env: { ...process.env } });
	return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function tableDump(file) {
	const db = new Database(file, { readonly: true });
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
	const dump = {};
	for (const t of tables) dump[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
	db.close();
	return dump;
}
const hashOf = (x) => crypto.createHash("sha256").update(typeof x === "string" || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest("hex");
const fileHash = (file) => hashOf(fs.readFileSync(file));
const tablesHash = (file) => hashOf(tableDump(file));
function rowOf(file, sql, ...params) {
	const db = new Database(file, { readonly: true });
	const row = db.prepare(sql).get(...params);
	db.close();
	return row;
}
function rowsOf(file, sql, ...params) {
	const db = new Database(file, { readonly: true });
	const rows = db.prepare(sql).all(...params);
	db.close();
	return rows;
}
const septemberRows = (file) => hashOf({
	payout: rowsOf(file, "SELECT * FROM investor_payouts WHERE period = '2026-09'"),
	items: rowsOf(file, "SELECT * FROM financials_ledger_items"),
	freezes: rowsOf(file, "SELECT * FROM financials_ledger_freezes"),
	invoices: rowsOf(file, "SELECT * FROM invoices WHERE id IN (537, 608)"),
});
const invAdj = (file, id = 640) => rowOf(file, "SELECT adjustment FROM invoices WHERE id = ?", id).adjustment;
const octAdj = (file) => rowOf(file, "SELECT adjustment FROM investor_payouts WHERE id = 31").adjustment;

// C2 is not approved, so its apply runs only through the module with an
// approved copy of the case: the combination logic is pinned without any
// command-line way to apply an unapproved case.
const C2_APPROVED = { ...fix.CASES["2026-09-13"], approved: true };
function applyModule(file, day, kase, approval) {
	const db = fix.openDatabase(file, { dryRun: false });
	try { return fix.applyCase(db, day, kase, approval); } finally { db.close(); }
}

const APPLY_27 = ["--day", "2026-09-27", "--approval", "C1"];
const DRY_27 = ["--day", "2026-09-27", "--dry-run"];

// A run that must write nothing: exit code, tables unchanged, and the output.
function noWrite(file, args, expectCode = 0) {
	const before = tablesHash(file);
	const r = run([...args, `--db=${file}`]);
	return { ...r, unchanged: tablesHash(file) === before && r.code === expectCode };
}

// ═══════════════════════════════════════════════════ §1 the dry run
console.log("§1 the dry run's handle is read-only and it writes nothing");
{
	const file = buildFixture("dry");
	const h = fix.openDatabase(file, { dryRun: true });
	let threw = "";
	try { h.prepare("UPDATE invoices SET adjustment = 1 WHERE id = 640").run(); } catch (e) { threw = e.message; }
	check(h.readonly === true && /readonly/i.test(threw), "the dry run's handle is read-only: a write through it throws", `${h.readonly} ${threw}`);
	h.close();
	const beforeFile = fileHash(file);
	const beforeTables = tablesHash(file);
	const r = run([...DRY_27, `--db=${file}`]);
	check(r.code === 0, "the dry run exits 0", r.err || r.out.slice(-400));
	check(fileHash(file) === beforeFile && tablesHash(file) === beforeTables, "the database file and every table are unchanged");
	check(/Mode: DRY RUN\. The database handle is read-only; nothing is written\./.test(r.out) && /Nothing was written\./.test(r.out), "it says its handle is read-only and it wrote nothing");
	check(/Line 1 of 2: Pat Sample's driver pay, -\$300\.00/.test(r.out) && /Line 2 of 2: investor 5's payout, \+\$150\.00/.test(r.out),
		"it prints both lines with their exact signed amounts", r.out.split("\n").filter((l) => /^Line/.test(l)).join(" | "));
	check(/Before: adjustment \+\$0\.00, Total Due \+\$1,500\.00\. After: adjustment -\$300\.00, Total Due \+\$1,200\.00\./.test(r.out), "it prints the invoice's before and after");
	check(/Before: amount \+\$4,321\.00, adjustment \+\$0\.00, effective payout \+\$4,321\.00\. After: amount \+\$4,321\.00, adjustment \+\$150\.00, effective payout \+\$4,471\.00\./.test(r.out),
		"it prints the payout row's before and after");
	check(/x 0\.50 = \+\$5,106\.105, rounded to \+\$5,106\.00/.test(r.out) && /That is the settled row exactly/.test(r.out) && /\+\$5,256\.00 - \+\$5,106\.00 = \+\$150\.00/.test(r.out),
		"it shows the settlement arithmetic, with its rounding");
	check(/Corrections already on record: INV-SK-2026W39-01 carries an adjustment of \+\$0\.00; September 2026's payout row 27 for investor 5 carries an adjustment of \+\$0\.00\./.test(r.out),
		"it prints the adjustments already on the source invoice and the closed month's payout row");
	check(/2 line\(s\) would be written/.test(r.out) && /--day 2026-09-27 --approval C1/.test(r.out), "it counts the lines and prints the apply command");
	check(run([...DRY_27, `--db=${file}`]).out === r.out, "a second dry run prints the same plan");
}

// ═══════════════════════════════════════════════════ §2 the apply, §3 a second apply
console.log("§2 the apply writes exactly the two lines; §3 a second apply is a no-op");
{
	const file = buildFixture("apply");
	const sept = septemberRows(file);
	const r = run([...APPLY_27, `--db=${file}`]);
	check(r.code === 0, "the apply exits 0", r.err || r.out.slice(-400));
	const inv = rowOf(file, "SELECT * FROM invoices WHERE id = 640");
	check(inv.adjustment === -300 && inv.adjusted_by === ACTOR && /^\d{4}-\d{2}-\d{2}T/.test(inv.adjusted_at) && inv.total_earnings === 1500,
		"INV-SK-2026W40-01: adjustment -300.00 by the script, total earnings untouched", JSON.stringify({ a: inv.adjustment, by: inv.adjusted_by }));
	check(/^Sunday 9\/27\/2026 is not a pay day: load 569820951 was dispatched Monday 9\/28\. Its \$300\.00 was paid on INV-SK-2026W39-01\. Ref SPD-20260927$/.test(inv.adjustment_note),
		"the invoice note names the day, the dispatch, the source invoice and the reference", inv.adjustment_note);
	const oct = rowOf(file, "SELECT * FROM investor_payouts WHERE id = 31");
	check(oct.adjustment === 150 && oct.amount === 4321 && oct.adjusted_by === ACTOR && oct.status === "owed",
		"October payout: adjustment +150.00 beside an unchanged amount", JSON.stringify({ a: oct.adjustment, amount: oct.amount }));
	check(/^Correction to September 2026: Sunday 9\/27 driver pay \(\$300\.00, load 569820951, truck Logisx-#91\) removed; your share \+\$150\.00\. Ref SPD-20260927$/.test(oct.adjustment_note),
		"the payout note says what changed in plain words", oct.adjustment_note);
	const hist = rowsOf(file, "SELECT * FROM investor_payout_history");
	check(hist.length === 1 && hist[0].payout_id === 31 && hist[0].kind === "adjustment" && hist[0].old_amount === 4321 && hist[0].new_amount === 4471 && hist[0].delta === 150 && hist[0].actor === ACTOR,
		"one payout history row, as the route records it", JSON.stringify(hist));
	const audits = rowsOf(file, "SELECT * FROM audit_trail WHERE username = ? ORDER BY id", ACTOR);
	check(audits.length === 2 && audits.every((a) => a.user_id === 0 && a.role === "system"), "two audit rows, user 0, role system", JSON.stringify(audits.map((a) => a.action)));
	check(audits[0].action === "adjust_invoice" && audits[0].entity === "invoice" && audits[0].entity_id === "640" &&
		audits[0].details.includes("INV-SK-2026W40-01: adjustment 0.00 → -300.00") && audits[0].details.includes("approval C1") && audits[0].details.includes("[SPD-20260927 driver -300.00 INV-SK-2026W40-01]"),
		"the invoice audit row: the route's action and shape, the approval and the reference", audits[0] && audits[0].details);
	check(audits[1].action === "investor_payout_adjust" && audits[1].entity === "investor_payout" && audits[1].entity_id === "31" &&
		audits[1].details.includes("owner 5 2026-10: adjustment 0.00 -> 150.00") && audits[1].details.includes("[SPD-20260927 investor +150.00 5:2026-10]"),
		"the payout audit row: the route's action and shape, and a reference keyed by owner and period", audits[1] && audits[1].details);
	check(septemberRows(file) === sept, "September's payout row, its frozen ledger and its invoices did not move");
	check(/2 line\(s\) written \(audit rows \d+, \d+\)/.test(r.out) && /Mode: APPLY/.test(r.out), "the apply reports what it wrote");

	const again = noWrite(file, APPLY_27);
	check(again.unchanged, "a second apply writes nothing", again.err || again.out.slice(-300));
	check((again.out.match(/Already applied/g) || []).length === 2 && /2 already applied/.test(again.out) && /still carries it/.test(again.out),
		"it says both lines are already applied and still in place");
}

// ═══════════════════════════════════════════════════ §4 independent days
console.log("§4 9/13 and 9/27 are independent, combine, and replay in order");
{
	const file = buildFixture("independent");
	const r27 = run([...APPLY_27, `--db=${file}`]);
	check(r27.code === 0 && invAdj(file) === -300 && octAdj(file) === 150, "9/27 applies on its own", r27.err || r27.out.slice(-300));
	const ro = fix.openDatabase(file, { dryRun: true });
	const dry13 = fix.buildPlan(ro, "2026-09-13", fix.CASES["2026-09-13"]);
	ro.close();
	check(dry13.lines.every((l) => l.status === "write") && !dry13.lines.some((l) => l.status === "applied"), "9/13 is not marked applied by 9/27");
	const res = applyModule(file, "2026-09-13", C2_APPROVED, "C2");
	const inv = rowOf(file, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	const oct = rowOf(file, "SELECT adjustment, adjustment_note FROM investor_payouts WHERE id = 31");
	check(res.written.length === 2 && inv.adjustment === -600 && /Ref SPD-20260927 \| Sunday 9\/13\/2026 .* Ref SPD-20260913$/.test(inv.adjustment_note),
		"the invoice sums both days and appends the note", JSON.stringify(inv));
	check(oct.adjustment === 300 && /Ref SPD-20260927 \| Correction .* Ref SPD-20260913$/.test(oct.adjustment_note), "the payout sums both days", JSON.stringify(oct));
	check(rowsOf(file, "SELECT id FROM audit_trail WHERE username = ?", ACTOR).length === 4, "four audit rows, one per line per day");
	const text = fix.render(res.plan, { dbFile: file, dryRun: false, readonlyHandle: false, written: res.written, applyCommand: "" });
	check(/names load 567844619 and the frozen ledger's day names load 567484733/.test(text) && /Already corrected by this script on the investor's side: 2026-09-27/.test(text),
		"9/13 explains its two load numbers and replays after 9/27");

	const solo = buildFixture("solo-13");
	applyModule(solo, "2026-09-13", C2_APPROVED, "C2");
	const soloInv = rowOf(solo, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	check(soloInv.adjustment === -300 && /Ref SPD-20260913$/.test(soloInv.adjustment_note) && !/SPD-20260927/.test(soloInv.adjustment_note), "9/13 alone carries only its own reference");
	const dry27 = run([...DRY_27, `--db=${solo}`]);
	check(/2 line\(s\) would be written/.test(dry27.out) && /already carries this script's own earlier line/.test(dry27.out), "9/27 then combines with 9/13's lines", dry27.out.slice(-300));

	// A rate whose half is not whole dollars: the second day replays after the first.
	const odd = buildFixture("odd-rate", { rate: 275 });
	run([...APPLY_27, `--db=${odd}`]);
	const first = octAdj(odd);
	const second = applyModule(odd, "2026-09-13", C2_APPROVED, "C2");
	check(first === 138 && octAdj(odd) === 275 && second.plan.lines[1].cents === 13700, "at $275 a day: 9/27 +138, then 9/13 +137, together +275 (the joint replay)", JSON.stringify({ first, both: octAdj(odd) }));

	// Tokens are grouped by owner and period: another owner's lines are not this owner's.
	const other = buildFixture("other-owner", { ownLines: [
		"other owner [SPD-20260913 investor +150.00 41:2026-10]",
		"other owner [SPD-20260927 investor +150.00 41:2026-10]",
	] });
	const dryOther = run([...DRY_27, `--db=${other}`]);
	check(/2 line\(s\) would be written/.test(dryOther.out) && !/Already applied/.test(dryOther.out) && !/Already corrected by this script/.test(dryOther.out),
		"another owner's lines for the same period are neither applied nor prior here", dryOther.out.slice(-300));
}

// ═══════════════════════════════════════════════════ §5 a missing October home
console.log("§5 a missing October home is skipped");
{
	const r = noWrite(buildFixture("no-home", { w40: null, october: false }), APPLY_27);
	check(r.unchanged, "the apply exits 0 and writes nothing", r.err || r.out.slice(-300));
	check(/Skipped: Pat Sample has no weekly invoice for a week inside October 2026 yet\./.test(r.out) &&
		/the first week inside October 2026 is 2026-10-03 to 2026-10-09/.test(r.out) && /- Re-run this command once that invoice exists\./.test(r.out),
		"the driver line says its home does not exist yet and when to re-run");
	check(/Skipped: investor 5 has no October 2026 payout row yet\./.test(r.out) && /- Re-run this command between 2026-11-01 and 2026-11-07/.test(r.out),
		"the investor line says its row does not exist yet and when to re-run");
	check(/0 line\(s\) written/.test(r.out) && /Re-run command for the skipped line\(s\)/.test(r.out), "it counts nothing written and prints the re-run command");
}

// ═══════════════════════════════════════════════════ §6 closed or paid targets
console.log("§6 a paid invoice, a paid payout and a closed October are refused");
{
	const r = noWrite(buildFixture("paid", { w40: "Paid", octoberStatus: "paid" }), APPLY_27);
	check(r.unchanged, "nothing is written", r.err || r.out.slice(-300));
	check(/Skipped \(uncertain\): INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09\) is Paid, paid 2026-10-12T15:00:00.000Z\. Posting the claw-back now would pass it over/.test(r.out) &&
		/Do not re-run this command for this line/.test(r.out), "the paid earliest October invoice is named, and the line needs a decision", r.out.slice(-700));
	check(/payout row 31 \(October 2026\) is paid; the correction has to land before it is settled/.test(r.out), "the paid payout row is refused");
	const r2 = noWrite(buildFixture("closed", { lockOctober: true }), APPLY_27);
	check(r2.unchanged && (r2.out.match(/October 2026 is closed, so/g) || []).length === 2, "a closed October: both lines refused, nothing written", r2.out.slice(-600));
}

// ═══════════════════════════════════════════════════ §7 uncertain amounts
console.log("§7 uncertain amounts are skipped");
{
	const r = noWrite(buildFixture("mismatch", { ledgerSundayCents: 25000 }), APPLY_27);
	check(r.unchanged && (r.out.match(/the amounts disagree: INV-SK-2026W39-01 bills the day at \+\$300\.00, the frozen ledger pays it \+\$250\.00\./g) || []).length === 2,
		"an invoice/ledger mismatch: both lines skipped, nothing written");

	const skew = buildFixture("skew", { shareSkew: 1 });
	const dry = run([...DRY_27, `--db=${skew}`]);
	check(/the replay does not reproduce September 2026 as settled/.test(dry.out) && !/That is the settled row exactly/.test(dry.out),
		"a replay that does not reproduce the settlement is skipped, and the dry run does not call it exact");
	run([...APPLY_27, `--db=${skew}`]);
	check(octAdj(skew) === 0 && invAdj(skew) === -300, "the investor line is skipped; the driver line still applies on its own");

	const foreign = buildFixture("foreign", { w40Adjustment: { amount: 50, note: "fuel advance repaid" } });
	const r3 = run([...APPLY_27, `--db=${foreign}`]);
	const inv = rowOf(foreign, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	check(r3.code === 0 && inv.adjustment === 50 && inv.adjustment_note === "fuel advance repaid" &&
		/INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09, Submitted\) carries \+\$50\.00 \(note: "fuel advance repaid", by super_admin\)\. That adjustment was not written by this script/.test(r3.out),
		"an adjustment the script did not write is left alone, and the reason is given", JSON.stringify(inv));
	check(octAdj(foreign) === 150, "the investor line still applies");
}

// ═══════════════════════════════════════════════════ §8 already corrected, or not certain
console.log("§8 a day corrected by hand, a rejected or deleted source, a Settlement adjustment, another freeze");
{
	const w39 = noWrite(buildFixture("w39-adjusted", { w39Adjustment: -300 }), APPLY_27);
	check(w39.unchanged && (w39.out.match(/INV-SK-2026W39-01 already carries an adjustment of -\$300\.00 \(note: "late deduction", by super_admin\): the day may already have been corrected by hand\./g) || []).length === 2,
		"the source invoice already adjusted: both lines skipped, nothing written", w39.out.slice(-500));
	const w39dry = run([...DRY_27, `--db=${buildFixture("w39-adjusted-dry", { w39Adjustment: -300 })}`]);
	check(/Corrections already on record: INV-SK-2026W39-01 carries an adjustment of -\$300\.00; September 2026's payout row 27 for investor 5 carries an adjustment of \+\$0\.00\./.test(w39dry.out),
		"the dry run prints both values");
	const sept = noWrite(buildFixture("sept-adjusted", { septAdjustment: 150 }), APPLY_27);
	check(sept.unchanged && (sept.out.match(/September 2026's payout row 27 for investor 5 already carries an adjustment of \+\$150\.00/g) || []).length === 2,
		"the closed month's payout row already adjusted: both lines skipped, nothing written", sept.out.slice(-500));
	const rejected = noWrite(buildFixture("w39-rejected", { w39Status: "Rejected" }), APPLY_27);
	check(rejected.unchanged && /INV-SK-2026W39-01 is Rejected, so the day may never have been paid on it\./.test(rejected.out), "a rejected source invoice: nothing written");
	const deleted = noWrite(buildFixture("w39-deleted", { w39Deleted: true }), APPLY_27);
	check(deleted.unchanged && /INV-SK-2026W39-01 is deleted \(2026-10-05T10:00:00\.000Z\)/.test(deleted.out), "a deleted source invoice: nothing written");

	const settleAdj = buildFixture("settlement-adjustment", { settlementAdj: { adjusts: "driver_pay", cents: -30000 } });
	const sa = run([...APPLY_27, `--db=${settleAdj}`]);
	check(sa.code === 0 && octAdj(settleAdj) === 0 && /include 1 Settlement adjustment line\(s\) \(driver_pay -\$300\.00\), so the settled figures are not the line items/.test(sa.out),
		"a Settlement adjustment among the frozen items: the investor line is skipped and says why", sa.out.slice(-600));
	const oneTime = noWrite(buildFixture("one-time-freeze", { freezeSource: "one-time" }), APPLY_27);
	check(oneTime.unchanged && /ledger was frozen by "one-time", not by the month's own close/.test(oneTime.out), "a ledger not frozen by the month's own close: nothing written");
}

// ═══════════════════════════════════════════════════ §9 the settlement replay
console.log("§9 the settlement replay: carry, loss months, leases");
{
	const carry = buildFixture("carry-in", { carriedIn: 1000 });
	const dry = run([...DRY_27, `--db=${carry}`]);
	check(/loss carried in \+\$1,000\.00, deferred \+\$0\.00; payout \+\$4,106\.00\. That is the settled row exactly/.test(dry.out) && /\+\$4,256\.00 - \+\$4,106\.00 = \+\$150\.00/.test(dry.out),
		"a loss carried in: the replay reproduces the settled payout and the difference", dry.out.slice(-900));
	run([...APPLY_27, `--db=${carry}`]);
	check(octAdj(carry) === 150, "and the apply posts it");

	const whole = noWrite(buildFixture("whole-share", { carriedIn: 5106 }), DRY_27);
	check(whole.unchanged && /absorbed \+\$5,106\.00 of earlier losses out of a share of \+\$5,106\.00; the loss carried into it is not known exactly/.test(whole.out),
		"a month that absorbed its whole share is skipped");
	const loss = noWrite(buildFixture("loss-month", { extraFixedCents: 2000000 }), DRY_27);
	check(loss.unchanged && /settled a share of -\$4,894\.00; a loss month moves the loss carried into open months/.test(loss.out), "a loss month is skipped", loss.out.slice(-400));
	const moved = fix.compareSettlements({ deficitOut: 0, payable: 0 }, { deficitOut: 40, payable: 0 }, "2026-09");
	const same = fix.compareSettlements({ deficitOut: 0, payable: 5106 }, { deficitOut: 0, payable: 5256 }, "2026-09");
	check(/changes the loss carried past September 2026 \(\+\$0\.00 to \+\$40\.00\)/.test(moved.problem || "") && moved.cents === undefined && same.cents === 15000 && !same.problem,
		"a changed loss carried past the month is refused; an unchanged one gives the payout difference", JSON.stringify({ moved, same }));
	const leaseFile = buildFixture("lease-month", { lease: true });
	const lr = run([...APPLY_27, `--db=${leaseFile}`]);
	check(lr.code === 0 && /Nothing to post: September 2026 was settled as a lease, which pays as settled whatever its costs\./.test(lr.out) && octAdj(leaseFile) === 0 && invAdj(leaseFile) === -300,
		"a lease month posts nothing to the investor; the driver line still applies", lr.out.slice(-400));
}

// ═══════════════════════════════════════════════════ §10 the route's limits
console.log("§10 the route's limits");
{
	const neg = buildFixture("negative-total", { w40Total: 200, w41: true });
	const r = run([...APPLY_27, `--db=${neg}`]);
	check(r.code === 0 && invAdj(neg) === 0 && invAdj(neg, 650) === 0 &&
		/would take INV-SK-2026W40-01's Total Due from \+\$200\.00 to -\$100\.00, below \$0\. The claw-back is not moved to another invoice\./.test(r.out),
		"a Total Due below $0 is skipped, and the claw-back is not moved to the next invoice", r.out.slice(-500));
	check(octAdj(neg) === 150, "the investor line still applies");

	const cap = noWrite(buildFixture("cap", { rate: 20100, extraRevenueCents: 10000000 }), APPLY_27);
	check(cap.unchanged && /the adjustment would be -\$20,100\.00, beyond the route's \$10,000 cap/.test(cap.out) && /the adjustment would be \+\$10,050\.00, which the route would not take/.test(cap.out),
		"amounts beyond the $10,000 cap are skipped on both lines", cap.out.slice(-600));
	const invert = buildFixture("invert", { octoberAmount: -500 });
	const ir = run([...APPLY_27, `--db=${invert}`]);
	check(ir.code === 0 && octAdj(invert) === 0 && /\+\$150\.00 would take the -\$500\.00 payout below \$0, which the route refuses/.test(ir.out),
		"never inverted: the payout row is not written, and the reason is given", ir.out.slice(-400));
	const longNote = buildFixture("note-length", {
		w40Adjustment: { amount: -300, note: `${"x".repeat(450)} Ref SPD-20260913`, by: ACTOR },
		octoberAdjustment: { amount: 150, note: `${"y".repeat(450)} Ref SPD-20260913` },
		ownLines: [
			"seeded [SPD-20260913 driver -300.00 INV-SK-2026W40-01]",
			"seeded [SPD-20260913 investor +150.00 5:2026-10]",
		],
	});
	const nl = noWrite(longNote, APPLY_27);
	check(nl.unchanged && (nl.out.match(/the combined note would be \d+ characters, beyond the route's 500/g) || []).length === 2,
		"a combined note over 500 characters is skipped on both lines", nl.out.slice(-600));
}

// ═══════════════════════════════════════════════════ §11 all or nothing
console.log("§11 all or nothing");
{
	const failing = buildFixture("rollback", { failPayoutUpdate: true });
	const before = tablesHash(failing);
	const r = run([...APPLY_27, `--db=${failing}`]);
	check(r.code === 1 && /forced failure on the second write\. Nothing was written\./.test(r.err), "a failure on the second write exits 1", `${r.code} ${r.err}`);
	check(tablesHash(failing) === before && invAdj(failing) === 0 && rowsOf(failing, "SELECT id FROM audit_trail WHERE username = ?", ACTOR).length === 0,
		"the first write and its audit row are rolled back: nothing was written");
	const view = buildFixture("no-triggers", { payoutsAsView: true });
	const v = noWrite(view, APPLY_27, 2);
	check(v.unchanged && /REFUSED: the closed-month triggers could not be installed on this connection/.test(v.err) && invAdj(view) === 0,
		"closed-month triggers that cannot be installed: refused before any write", `${v.code} ${v.err}`);
}

// ═══════════════════════════════════════════════════ §12 refusals
console.log("§12 refusals");
{
	const file = buildFixture("refusals");
	const before = tablesHash(file);
	const c2 = run(["--day", "2026-09-13", "--approval", "C2", `--db=${file}`]);
	check(c2.code === 2 && /2026-09-13 is not approved \(decision C2, not approved/.test(c2.err), "an unapproved case is refused even with its --approval", `${c2.code} ${c2.err}`);
	let threw = null;
	try { applyModule(file, "2026-09-13", fix.CASES["2026-09-13"], "C2"); } catch (e) { threw = e; }
	check(threw instanceof fix.Refusal && /not approved/.test(threw.message), "applyCase refuses an unapproved case too");
	const c2dry = run(["--day", "2026-09-13", "--dry-run", `--db=${file}`]);
	check(c2dry.code === 0 && /Result: 2 line\(s\) would be written once approved\./.test(c2dry.out) && /This case is not approved, so it has no apply command/.test(c2dry.out) && !/Apply command:/.test(c2dry.out),
		"an unapproved case still dry-runs: its lines would be written once approved, and it has no apply command");
	const cases = [
		[["--day", "2026-09-20", "--dry-run", `--db=${file}`], /not a listed case/, "an unlisted day"],
		[["--day", "2026-09-27", `--db=${file}`], /needs --approval C1/, "an apply without --approval"],
		[["--day", "2026-09-27", "--approval", "C2", `--db=${file}`], /needs --approval C1/, "an apply with another case's approval"],
		[["--day", "2026-09-27", "--dryrun", `--db=${file}`], /unknown option --dryrun/, "a mistyped --dry-run"],
		[["--day", "2026-09-27", "--dry-run=yes", `--db=${file}`], /takes no value/, "--dry-run with a value"],
		[["--day", "2026-09-27", "--dry-run", `--db=${path.join(ROOT, "scripts", "fixtures", "app.db")}`], /opens its own app directory's database/, "a database outside the app directory and the temp directory"],
	];
	for (const [args, re, label] of cases) {
		const r = run(args);
		check(r.code === 2 && re.test(r.err), `refused: ${label}`, `${r.code} ${r.err}`);
	}
	check(tablesHash(file) === before, "no refusal wrote anything");
	const open = noWrite(buildFixture("open-september", { septemberLocked: false }), APPLY_27, 2);
	check(open.unchanged && /REFUSED: September 2026 is not closed/.test(open.out), "a September that is not closed is refused, nothing written", open.out.slice(-300));
}

// ═══════════════════════════════════════════════════ §13 re-runs
console.log("§13 a re-run never takes the day back twice or moves a claw-back");
{
	const setInvoice = (file, sql, ...params) => { const db = new Database(file); db.prepare(sql).run(...params); db.close(); };

	// Repro 1: W40 carries someone else's +$50, W41 exists. The first run skips
	// the driver line and offers no re-run; the admin then takes the day back on
	// W40 by hand and W40 is paid; a re-run must not claw it back again on W41.
	const one = buildFixture("repro-1", { w40Adjustment: { amount: 50, note: "fuel advance repaid" }, w41: true });
	const dry = run([...DRY_27, `--db=${one}`]);
	check(/Apply command:/.test(dry.out) && /It writes only the other line\(s\): line 1 needs a decision first \(see above\), and is not to be re-run for it\./.test(dry.out),
		"repro 1, dry run: the apply command says it writes only the investor line and is not to be re-run for the driver line", dry.out.slice(-500));
	const first = run([...APPLY_27, `--db=${one}`]);
	check(first.code === 0 && invAdj(one) === 50 && invAdj(one, 650) === 0 && octAdj(one) === 150, "repro 1, first run: the driver line is skipped, the investor line is written", first.out.slice(-400));
	check(!/Re-run command/.test(first.out) && /Do not re-run this command for this line/.test(first.out) && /No re-run command: line 1 needs a decision first \(see above\)\. Ask before running this script for 2026-09-27 again\./.test(first.out),
		"repro 1, first run: no re-run command, and the skipped line says not to re-run", first.out.slice(-500));
	setInvoice(one, "UPDATE invoices SET adjustment = -300, adjustment_note = 'Sunday 9/27 taken back by hand', adjusted_by = 'super_admin', status = 'Paid', paid_at = '2026-10-16T15:00:00.000Z' WHERE id = 640");
	const again = run([...APPLY_27, `--db=${one}`]);
	check(again.code === 0 && invAdj(one, 650) === 0 && invAdj(one) === -300, "repro 1, re-run after the hand claw-back: W41 is not clawed back again", JSON.stringify({ w40: invAdj(one), w41: invAdj(one, 650) }));
	check(/INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09, Paid\) carries -\$300\.00 \(note: "Sunday 9\/27 taken back by hand", by super_admin\)/.test(again.out) && /Already applied: \+\$150\.00/.test(again.out),
		"repro 1, re-run: it names the hand adjustment, even on a passed-over paid invoice", again.out.slice(-600));

	// A hand claw-back on a later, already approved week counts while W40 is
	// still open, whatever that later invoice's status.
	const later = buildFixture("later-week-adjusted", { w41: true });
	setInvoice(later, "UPDATE invoices SET adjustment = -300, adjustment_note = 'Sunday 9/27 by hand', adjusted_by = 'super_admin', status = 'Approved' WHERE id = 650");
	const lw = run([...APPLY_27, `--db=${later}`]);
	check(lw.code === 0 && invAdj(later) === 0 && /INV-SK-2026W41-01 \(week 2026-10-10 to 2026-10-16, Approved\) carries -\$300\.00/.test(lw.out),
		"a hand claw-back on a later approved week: the open W40 is not clawed back again", lw.out.slice(-500));

	// A manual invoice carrying the day taken back by hand counts too.
	const manual = noWrite(buildFixture("manual-adjusted", { manualAdjustment: { amount: -300, note: "Sunday 9/27 by hand" }, october: false }), APPLY_27);
	check(manual.unchanged && /INV-SK-MANUAL-01 \(manual invoice 2026-10-01 to 2026-10-05, Submitted\) carries -\$300\.00/.test(manual.out),
		"a manual invoice with a hand adjustment: the driver line is skipped, nothing written", manual.out.slice(-500));

	// The investor's side: a hand correction on another month's payout row.
	const nov = buildFixture("november-adjusted", { novemberAdjustment: { amount: 150, note: "Sunday 9/27 credit by hand" } });
	const nr = run([...APPLY_27, `--db=${nov}`]);
	check(nr.code === 0 && octAdj(nov) === 0 && invAdj(nov) === -300 &&
		/payout row 35 \(November 2026, owed\) carries \+\$150\.00 \(note: "Sunday 9\/27 credit by hand", by super_admin\)\. That adjustment was not written by this script/.test(nr.out),
		"a hand credit on another payout row: the investor line is skipped; the driver line still applies", nr.out.slice(-600));

	// Invoices outside October count too: a hand claw-back on a week that
	// straddles into November, or on a manual invoice starting in September.
	const w44 = buildFixture("w44-adjusted", { october: false });
	setInvoice(w44, `INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, total_earnings, status, adjustment, adjustment_note, adjusted_by)
		VALUES (670, 'INV-SK-2026W44-01', '${DRIVER}', '2026-10-31', '2026-11-06', 1500, 'Submitted', -300, 'Sunday 9/27 by hand', 'super_admin')`);
	const r44 = noWrite(w44, APPLY_27);
	check(r44.unchanged && invAdj(w44) === 0 && /INV-SK-2026W44-01 \(week 2026-10-31 to 2026-11-06, Submitted\) carries -\$300\.00/.test(r44.out),
		"a hand claw-back on the 10/31-11/06 invoice: W40 stays at $0 and the line is skipped", r44.out.slice(-500));
	const early = noWrite(buildFixture("manual-september", { october: false, manualAdjustment: { amount: -300, note: "Sunday 9/27 by hand", start: "2026-09-20", end: "2026-10-05" } }), APPLY_27);
	check(early.unchanged && /INV-SK-MANUAL-01 \(manual invoice 2026-09-20 to 2026-10-05, Submitted\) carries -\$300\.00/.test(early.out),
		"a hand claw-back on a manual invoice starting before 10/01: the line is skipped", early.out.slice(-500));

	// A deleted earliest October invoice: the claw-back is not moved to W41.
	const del = buildFixture("deleted-w40", { w40Total: 200, w41: true });
	run([...APPLY_27, `--db=${del}`]);
	setInvoice(del, "UPDATE invoices SET deleted_at = '2026-10-17T12:00:00.000Z', deleted_by = 'super_admin' WHERE id = 640");
	const beforeDel = tablesHash(del);
	const rd = run([...APPLY_27, `--db=${del}`]);
	check(rd.code === 0 && invAdj(del, 650) === 0 && tablesHash(del) === beforeDel &&
		/INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09\) was deleted 2026-10-17T12:00:00\.000Z\. Posting the claw-back now would pass it over/.test(rd.out),
		"a re-run after the earliest October invoice is deleted writes nothing and names it", rd.out.slice(-600));
	const delOnly = buildFixture("deleted-w40-alone", { october: false });
	setInvoice(delOnly, "UPDATE invoices SET deleted_at = '2026-10-17T12:00:00.000Z' WHERE id = 640");
	const ro2 = noWrite(delOnly, APPLY_27);
	check(ro2.unchanged && /was deleted 2026-10-17T12:00:00\.000Z/.test(ro2.out) && !/Re-run this command once that invoice exists/.test(ro2.out),
		"a deleted earliest invoice with no later one yet needs a decision, not a re-run");
	const regen = buildFixture("deleted-w40-regenerated", { october: false });
	setInvoice(regen, "UPDATE invoices SET deleted_at = '2026-10-17T12:00:00.000Z' WHERE id = 640");
	setInvoice(regen, `INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, render_data)
		VALUES (641, 'INV-SK-2026W40-02', '${DRIVER}', '2026-10-03', '2026-10-09', 5, 300, 1500, 'Submitted', '{}')`);
	const rg = run([...APPLY_27, `--db=${regen}`]);
	check(rg.code === 0 && invAdj(regen, 641) === -300 && invAdj(regen) === 0, "a deleted invoice whose week has a live one in its place does not block: the live one is the home", rg.out.slice(-500));

	// The home check stays even if the check of all the driver's invoices
	// misses an adjustment (here: that check edited to find none).
	const FOREIGN_COND = "AND week_end >= ? AND COALESCE(adjustment, 0) != 0 ORDER BY week_start, id";
	const src = fs.readFileSync(SCRIPT, "utf8");
	check(src.split(FOREIGN_COND).length === 2, "the driver's adjustment check is where the variant below edits it");
	const variant = { exports: {} };
	new Function("require", "module", "exports", "__dirname", "__filename", src.replace(/^#!.*\n/, "").replace(FOREIGN_COND, "AND week_end >= ? AND 0 ORDER BY week_start, id"))(
		createRequire(SCRIPT), variant, variant.exports, path.dirname(SCRIPT), SCRIPT);
	const safety = buildFixture("home-safety", { w40Adjustment: { amount: 50, note: "fuel advance repaid" } });
	const hs = variant.exports.openDatabase(safety, { dryRun: true });
	const sp = variant.exports.buildPlan(hs, "2026-09-27", variant.exports.CASES["2026-09-27"]);
	hs.close();
	check(sp.lines[0].status === "skip" && /INV-SK-2026W40-01 carries \+\$50\.00 \(note: "fuel advance repaid"\) that this script did not write; writing would replace it/.test(sp.lines[0].reasons.join(" ")),
		"with that check missing the adjustment, the home check still refuses to overwrite it", JSON.stringify(sp.lines[0].status));

	// A line that waits beside a line that needs a decision is not told to re-run.
	const mixed = run([...APPLY_27, `--db=${buildFixture("mixed", { w40Adjustment: { amount: 50, note: "fuel advance repaid" }, october: false })}`]);
	check(!/Re-run this command between/i.test(mixed.out) && /- Once what it waits for exists, ask before re-running this command: line 1 needs a decision first \(see above\)\./.test(mixed.out) &&
		/No re-run command: line 1 needs a decision first/.test(mixed.out),
		"a waiting line beside a line that needs a decision says to ask, as the footer does", mixed.out.slice(-700));

	// Repro 2: W40's Total Due cannot take the claw-back; W41 exists. No re-run
	// is offered; and if W40 is approved later, a re-run is refused by code
	// rather than moving the claw-back to W41.
	const two = buildFixture("repro-2", { w40Total: 200, w41: true });
	const r2 = run([...APPLY_27, `--db=${two}`]);
	check(r2.code === 0 && invAdj(two) === 0 && invAdj(two, 650) === 0 && /The claw-back is not moved to another invoice/.test(r2.out), "repro 2, first run: the Total Due skip", r2.out.slice(-400));
	check(!/Re-run command/.test(r2.out) && /Do not re-run this command for this line/.test(r2.out) && /No re-run command: line 1 needs a decision first/.test(r2.out),
		"repro 2, first run: no re-run command, and the skipped line says not to re-run");
	setInvoice(two, "UPDATE invoices SET status = 'Approved' WHERE id = 640");
	const before2 = tablesHash(two);
	const a2 = run([...APPLY_27, `--db=${two}`]);
	check(a2.code === 0 && invAdj(two, 650) === 0 && tablesHash(two) === before2, "repro 2, a re-run after W40 is approved writes nothing: the claw-back is not moved to W41",
		JSON.stringify({ w41: invAdj(two, 650) }));
	check(/Skipped \(uncertain\): INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09\) is Approved\. Posting the claw-back now would pass it over and land on a later week's invoice/.test(a2.out) &&
		!/Target: INV-SK-2026W41-01/.test(a2.out) && /No re-run command: line 1 needs a decision first/.test(a2.out),
		"repro 2, the re-run names the passed-over W40 and needs a decision", a2.out.slice(-700));

	// The intended cost: a first apply after W40 is already approved stops too.
	const late = buildFixture("approved-first", { w40: "Approved", w41: true });
	const lr = run([...APPLY_27, `--db=${late}`]);
	check(lr.code === 0 && invAdj(late) === 0 && invAdj(late, 650) === 0 && octAdj(late) === 150 && /INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09\) is Approved\./.test(lr.out),
		"a first apply after W40 is approved: the driver line stops for a decision, the investor line is written", lr.out.slice(-600));

	// Waiting skips still get their re-run command.
	const wait = run([...APPLY_27, `--db=${buildFixture("waiting", { w40: null, october: false })}`]);
	check(/Re-run command for the skipped line\(s\), once the row each one waits for exists:/.test(wait.out) && !/Do not re-run/.test(wait.out), "skips that only wait for their home keep the re-run command");

	// The read-back after the writes: a row that does not read back as written
	// rolls the whole run back.
	const tamper = buildFixture("read-back", { tamperNote: true });
	const before = tablesHash(tamper);
	const t = run([...APPLY_27, `--db=${tamper}`]);
	check(t.code === 1 && /invoices row 640 does not read back as written/.test(t.err) && tablesHash(tamper) === before,
		"a write that does not read back as written: exit 1, nothing written", `${t.code} ${t.err}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
