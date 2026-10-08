#!/usr/bin/env node
/**
 * scripts/data-fix-sunday-pay-days.js, end to end on small file databases
 * under a temp directory (the production schema of the tables it reads and
 * writes, with a fictional driver):
 *
 *   §1 the dry run opens the database read-only and writes nothing (file bytes
 *      and every table unchanged), and prints both lines with exact amounts;
 *   §2 the apply writes exactly the two lines (the invoice adjustment, the
 *      payout adjustment and its history row) and two system audit rows, with
 *      the exact amounts; the closed month's rows do not move;
 *   §3 a second apply writes nothing and says the lines are already applied;
 *   §4 the two days are independent: each applies on its own, and the second
 *      combines with the first on the same targets (sum, appended note), its
 *      investor amount replayed after the first (so a rate whose half is not
 *      whole dollars splits 138 + 137, never 138 + 138);
 *   §5 a missing October home (no invoice yet, no payout row yet) is skipped
 *      with when to re-run, and nothing is written;
 *   §6 a paid invoice, a paid payout and a closed October are refused;
 *   §7 an amount mismatch between the invoice and the ledger, a replay that
 *      does not reproduce the settlement, and an adjustment the script did not
 *      write are skipped;
 *   §8 refusals: an unlisted day, an apply without (or with the wrong)
 *      --approval, an unknown option, a database outside the temp directory,
 *      a source month that is not closed.
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

// opts: rate (the daily rate), october ("row" | null), w40 (status | null),
// lockOctober, ledgerSundayCents (the 9/27 item), shareSkew (added to the
// settled monthShare), septemberLocked, w40Adjustment.
function buildFixture(name, opts = {}) {
	const o = { rate: 300, october: "row", w40: "Submitted", lockOctober: false, ledgerSundayCents: null, shareSkew: 0, septemberLocked: true, w40Adjustment: null, octoberStatus: "owed", ...opts };
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
		["revenue", "2026-09-14", 1200000, "567844619"],
		["revenue", "2026-09-28", 345679, "569820951"],
		["driver_pay", "2026-09-13", rc, "567484733"],
		["driver_pay", "2026-09-14", rc, "567844619"],
		["driver_pay", "2026-09-27", o.ledgerSundayCents == null ? rc : o.ledgerSundayCents, "569820951"],
		["driver_pay", "2026-09-28", rc, "569820951"],
		["fixed", "", 304333, ""],
		["trip", "2026-09-20", 100125, "567850506"],
	];
	const ins = db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at) VALUES ('2026-09', 5, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-08T05:00:25.792Z')");
	for (const [kind, day, cents, load] of items) {
		ins.run(kind, day, cents, load, kind === "fixed" ? "" : DRIVER, "Logisx-#91", kind === "driver_pay" ? "fixed" : "", FREEZE);
	}
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, item_count) VALUES (?, '2026-09', 'close', '2026-10-08T05:00:25.792Z', ?)").run(FREEZE, items.length);
	const sum = (k) => items.filter((i) => i[0] === k).reduce((s, i) => s + i[2], 0) / 100;
	const fig = { revenue: sum("revenue"), driverPay: sum("driver_pay"), fixedCosts: sum("fixed"), tripExpenses: sum("trip"), maintFundCost: 0, complianceCost: 0 };
	fig.netProfit = fig.revenue - fig.driverPay - fig.fixedCosts - fig.tripExpenses;
	const share = Math.round(fig.netProfit * 0.5) + o.shareSkew;
	db.prepare(
		`INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status, finalized_at, finalized_amount, finalized_breakdown)
		 VALUES (27, 5, '2026-09', ?, '2026-10-30', 'owed', '2026-10-08T05:00:25.792Z', ?, ?)`
	).run(share, share, JSON.stringify({ ...fig, splitPct: 50, monthShare: share, lossCarriedIn: 0, lossDeferred: 0 }));
	if (o.october) {
		db.prepare("INSERT INTO investor_payouts (id, owner_id, period, amount, due_date, status) VALUES (31, 5, '2026-10', 4321, '2026-11-27', ?)").run(o.octoberStatus);
	}

	const insInv = db.prepare(
		`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, load_ids, render_data, paid_at, adjustment, adjustment_note, adjusted_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const sixDays = [0, r, r, r, r, r, r];
	insInv.run(537, "INV-SK-2026W37-01", DRIVER, "2026-09-12", "2026-09-18", 6, r, 6 * r, "Submitted",
		JSON.stringify(["#540935268", "567484733", "567844619", "568073441", "567850506"]),
		renderData(sixDays, ["", "567844619", "567844619", "567844619", "568073441, 567850506", "568073441, 567850506", "567850506"]), "", 0, "", "");
	insInv.run(608, "INV-SK-2026W39-01", DRIVER, "2026-09-26", "2026-10-02", 6, r, 6 * r, "Submitted",
		JSON.stringify(["569246552", "569820951", "569139441", "570008279"]),
		renderData(sixDays, ["", "569820951", "569820951, 569139441", "569820951, 569139441, 570008279", "570008279", "570008279", "570008279"]), "", 0, "", "");
	if (o.w40) {
		const adj = o.w40Adjustment;
		insInv.run(640, "INV-SK-2026W40-01", DRIVER, "2026-10-03", "2026-10-09", 5, r, 5 * r, o.w40,
			JSON.stringify(["570351713"]), renderData([0, 0, r, r, r, r, r], ["", "", "570351713", "570351713", "570351713", "570351713", "570351713"]),
			o.w40 === "Paid" ? "2026-10-12T15:00:00.000Z" : "", adj ? adj.amount : 0, adj ? adj.note : "", adj ? "super_admin" : "");
	}
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-09-28T19:59:42.061Z', 1, 'super_admin', 'Super Admin', 'dispatch_load', 'load', '569820951', 'Assigned driver Pat Sample to load 569820951')").run();
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

const APPLY_27 = ["--day", "2026-09-27", "--approval", "C1"];
const APPLY_13 = ["--day", "2026-09-13", "--approval", "C2"];

// ═══════════════════════════════════════════════════ §1 the dry run
console.log("§1 the dry run writes nothing");
{
	const file = buildFixture("dry");
	const beforeFile = fileHash(file);
	const beforeTables = hashOf(tableDump(file));
	const r = run(["--day", "2026-09-27", "--dry-run", `--db=${file}`]);
	check(r.code === 0, "the dry run exits 0", r.err || r.out.slice(-400));
	check(fileHash(file) === beforeFile && hashOf(tableDump(file)) === beforeTables, "the database file and every table are unchanged");
	check(/Mode: DRY RUN/.test(r.out) && /Nothing was written\./.test(r.out), "it says it is a dry run and wrote nothing");
	check(/Line 1 of 2: Pat Sample's driver pay, -\$300\.00/.test(r.out) && /Line 2 of 2: investor 5's payout, \+\$150\.00/.test(r.out),
		"it prints both lines with their exact signed amounts", r.out.split("\n").filter((l) => /^Line/.test(l)).join(" | "));
	check(/Before: adjustment \+\$0\.00, Total Due \+\$1,500\.00\. After: adjustment -\$300\.00, Total Due \+\$1,200\.00\./.test(r.out),
		"it prints the invoice's before and after");
	check(/Before: amount \+\$4,321\.00, adjustment \+\$0\.00, effective payout \+\$4,321\.00\. After: amount \+\$4,321\.00, adjustment \+\$150\.00, effective payout \+\$4,471\.00\./.test(r.out),
		"it prints the payout row's before and after");
	check(/x 0\.50 = \+\$5,106\.105, rounded to \+\$5,106\.00/.test(r.out) && /\+\$5,256\.00 - \+\$5,106\.00 = \+\$150\.00/.test(r.out),
		"it shows the settlement arithmetic, with its rounding");
	check(/2 line\(s\) would be written/.test(r.out) && /--day 2026-09-27 --approval C1/.test(r.out), "it counts the lines and prints the apply command");
	const again = run(["--day", "2026-09-27", "--dry-run", `--db=${file}`]);
	check(again.out === r.out, "a second dry run prints the same plan");
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
		audits[1].details.includes("owner 5 2026-10: adjustment 0.00 -> 150.00") && audits[1].details.includes("[SPD-20260927 investor +150.00 2026-10]"),
		"the payout audit row: the route's action and shape and the reference", audits[1] && audits[1].details);
	check(septemberRows(file) === sept, "September's payout row, its frozen ledger and its invoices did not move");
	check(/2 line\(s\) written \(audit rows \d+, \d+\)/.test(r.out) && /Mode: APPLY/.test(r.out), "the apply reports what it wrote");

	const before = hashOf(tableDump(file));
	const again = run([...APPLY_27, `--db=${file}`]);
	check(again.code === 0 && hashOf(tableDump(file)) === before, "a second apply writes nothing", again.err || again.out.slice(-300));
	check((again.out.match(/Already applied/g) || []).length === 2 && /2 already applied/.test(again.out) && /still carries it/.test(again.out),
		"it says both lines are already applied and still in place");
}

// ═══════════════════════════════════════════════════ §4 independent days
console.log("§4 9/13 and 9/27 are independent");
{
	const file = buildFixture("independent");
	const r13 = run([...APPLY_13, `--db=${file}`]);
	check(r13.code === 0, "9/13 applies on its own", r13.err || r13.out.slice(-300));
	let inv = rowOf(file, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	let oct = rowOf(file, "SELECT adjustment, adjustment_note FROM investor_payouts WHERE id = 31");
	check(inv.adjustment === -300 && /Ref SPD-20260913$/.test(inv.adjustment_note) && !/SPD-20260927/.test(inv.adjustment_note) && oct.adjustment === 150,
		"9/13's lines carry only 9/13's reference", JSON.stringify({ inv, oct }));
	check(/names load 567844619 and the frozen ledger's day names load 567484733/.test(r13.out), "the dry run explains 9/13's two load numbers");
	const dry27 = run(["--day", "2026-09-27", "--dry-run", `--db=${file}`]);
	check(/2 line\(s\) would be written/.test(dry27.out) && !/Already applied/.test(dry27.out), "9/27 is not marked applied by 9/13", dry27.out.slice(-300));
	check(/already carries this script's own earlier line/.test(dry27.out) && /Already corrected by this script on the investor's side: 2026-09-13/.test(dry27.out),
		"9/27 combines with 9/13's lines and replays after 9/13");
	const r27 = run([...APPLY_27, `--db=${file}`]);
	inv = rowOf(file, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	oct = rowOf(file, "SELECT adjustment, adjustment_note FROM investor_payouts WHERE id = 31");
	check(r27.code === 0 && inv.adjustment === -600 && /Ref SPD-20260913 \| Sunday 9\/27\/2026 .* Ref SPD-20260927$/.test(inv.adjustment_note),
		"the invoice sums both days and appends the note", JSON.stringify(inv));
	check(oct.adjustment === 300 && /Ref SPD-20260913 \| Correction .* Ref SPD-20260927$/.test(oct.adjustment_note), "the payout sums both days", JSON.stringify(oct));
	check(rowsOf(file, "SELECT id FROM audit_trail WHERE username = ?", ACTOR).length === 4, "four audit rows, one per line per day");

	// A rate whose half is not whole dollars: the second day replays after the first.
	const odd = buildFixture("odd-rate", { rate: 275 });
	const a = run([...APPLY_27, `--db=${odd}`]);
	const first = rowOf(odd, "SELECT adjustment FROM investor_payouts WHERE id = 31").adjustment;
	const b = run([...APPLY_13, `--db=${odd}`]);
	const both = rowOf(odd, "SELECT adjustment FROM investor_payouts WHERE id = 31").adjustment;
	check(a.code === 0 && b.code === 0 && first === 138 && both === 275, "at $275 a day: 9/27 +138, then 9/13 +137, together +275 (the joint replay)", JSON.stringify({ first, both }));
	check(/Already corrected by this script on the investor's side: 2026-09-27/.test(b.out) && /= \+\$137\.00 for investor 5/.test(b.out), "the second day's arithmetic shows the replay after the first");
}

// ═══════════════════════════════════════════════════ §5 a missing October home
console.log("§5 a missing October home is skipped");
{
	const file = buildFixture("no-home", { w40: null, october: null });
	const before = hashOf(tableDump(file));
	const r = run([...APPLY_27, `--db=${file}`]);
	check(r.code === 0 && hashOf(tableDump(file)) === before, "the apply exits 0 and writes nothing", r.err || r.out.slice(-300));
	check(/Skipped: Pat Sample has no weekly invoice for a week inside October 2026 that is still Draft or Submitted\./.test(r.out) &&
		/the first week inside October 2026 is 2026-10-03 to 2026-10-09/.test(r.out) && /re-run this command once that invoice exists/.test(r.out),
		"the driver line says its home does not exist yet and when to re-run");
	check(/Skipped: investor 5 has no October 2026 payout row yet\./.test(r.out) && /re-run this command between 2026-11-01 and 2026-11-07/.test(r.out),
		"the investor line says its row does not exist yet and when to re-run");
	check(/0 line\(s\) written/.test(r.out) && /Re-run command for the skipped line\(s\)/.test(r.out), "it counts nothing written and prints the re-run command");
}

// ═══════════════════════════════════════════════════ §6 closed or paid targets
console.log("§6 a paid invoice, a paid payout and a closed October are refused");
{
	const paid = buildFixture("paid", { w40: "Paid", octoberStatus: "paid" });
	const before = hashOf(tableDump(paid));
	const r = run([...APPLY_27, `--db=${paid}`]);
	check(r.code === 0 && hashOf(tableDump(paid)) === before, "nothing is written", r.err || r.out.slice(-300));
	check(/passed over: INV-SK-2026W40-01 \(week 2026-10-03 to 2026-10-09\) is Paid, paid 2026-10-12T15:00:00.000Z/.test(r.out), "the paid invoice is passed over, by name");
	check(/payout row 31 \(October 2026\) is paid; the correction has to land before it is settled/.test(r.out), "the paid payout row is refused");

	const closed = buildFixture("closed", { lockOctober: true });
	const before2 = hashOf(tableDump(closed));
	const r2 = run([...APPLY_27, `--db=${closed}`]);
	check(r2.code === 0 && hashOf(tableDump(closed)) === before2, "a closed October: nothing is written", r2.err || r2.out.slice(-300));
	check((r2.out.match(/October 2026 is closed, so/g) || []).length === 2, "both lines say October is closed", r2.out.slice(-600));
}

// ═══════════════════════════════════════════════════ §7 uncertain amounts
console.log("§7 uncertain amounts are skipped");
{
	const mismatch = buildFixture("mismatch", { ledgerSundayCents: 25000 });
	const before = hashOf(tableDump(mismatch));
	const r = run([...APPLY_27, `--db=${mismatch}`]);
	check(r.code === 0 && hashOf(tableDump(mismatch)) === before, "an invoice/ledger mismatch writes nothing", r.err || r.out.slice(-300));
	check((r.out.match(/the amounts disagree: INV-SK-2026W39-01 bills the day at \+\$300\.00, the frozen ledger pays it \+\$250\.00\./g) || []).length === 2,
		"both lines say the amounts disagree");

	const skew = buildFixture("skew", { shareSkew: 1 });
	const r2 = run([...APPLY_27, `--db=${skew}`]);
	check(r2.code === 0 && rowOf(skew, "SELECT adjustment FROM investor_payouts WHERE id = 31").adjustment === 0 && /the replay does not reproduce September 2026 as settled/.test(r2.out),
		"a replay that does not reproduce the settlement skips the investor line");
	check(rowOf(skew, "SELECT adjustment FROM invoices WHERE id = 640").adjustment === -300, "the driver line still applies on its own");

	const foreign = buildFixture("foreign", { w40Adjustment: { amount: 50, note: "fuel advance repaid" } });
	const r3 = run([...APPLY_27, `--db=${foreign}`]);
	const inv = rowOf(foreign, "SELECT adjustment, adjustment_note FROM invoices WHERE id = 640");
	check(r3.code === 0 && inv.adjustment === 50 && inv.adjustment_note === "fuel advance repaid", "an adjustment the script did not write is left alone", JSON.stringify(inv));
	check(/already has an adjustment of \+\$50\.00 that this script did not write/.test(r3.out) && rowOf(foreign, "SELECT adjustment FROM investor_payouts WHERE id = 31").adjustment === 150,
		"the driver line says why; the investor line still applies");
}

// ═══════════════════════════════════════════════════ §8 refusals
console.log("§8 refusals");
{
	const file = buildFixture("refusals");
	const before = hashOf(tableDump(file));
	const cases = [
		[["--day", "2026-09-20", "--dry-run", `--db=${file}`], /not a listed case/, "an unlisted day"],
		[["--day", "2026-09-27", `--db=${file}`], /needs --approval C1/, "an apply without --approval"],
		[["--day", "2026-09-13", "--approval", "C1", `--db=${file}`], /needs --approval C2/, "an apply with another case's approval"],
		[["--day", "2026-09-27", "--dryrun", `--db=${file}`], /unknown option --dryrun/, "a mistyped --dry-run"],
		[["--day", "2026-09-27", "--dry-run=yes", `--db=${file}`], /takes no value/, "--dry-run with a value"],
		[["--day", "2026-09-27", "--dry-run", `--db=${path.join(ROOT, "scripts", "fixtures", "app.db")}`], /opens its own app directory's database/, "a database outside the app directory and the temp directory"],
	];
	for (const [args, re, label] of cases) {
		const r = run(args);
		check(r.code === 2 && re.test(r.err), `refused: ${label}`, `${r.code} ${r.err}`);
	}
	check(hashOf(tableDump(file)) === before, "no refusal wrote anything");

	const open = buildFixture("open-september", { septemberLocked: false });
	const before2 = hashOf(tableDump(open));
	const r = run([...APPLY_27, `--db=${open}`]);
	check(r.code === 2 && /REFUSED: September 2026 is not closed/.test(r.out) && hashOf(tableDump(open)) === before2, "a September that is not closed is refused, nothing written", r.out.slice(-300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
