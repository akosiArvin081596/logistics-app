#!/usr/bin/env node
// scripts/personal-expenses-dry-run.js — the "Personal" receipts dry run, before
// PERSONAL_EXPENSE_DEDUCTIONS_ENABLED is switched on. It runs this checkout's own
// code (lifted from server.js, lib/server-lift.js) on a READ-ONLY handle of
// app.db and writes nothing to it: every Personal line it needs lives in a TEMP
// table of this connection, which shadows expense_personal and is gone when the
// script ends.
//
//   Part A (parity, no mark): every month of the payout ledger and Financials
//   (fleet-wide and per investor), percentage pay, the fuel figures, the KPI fuel
//   receipts and the cost-per-gallon band read through the new receipt sources
//   give the same figures, to the cent, as the plain receipts table; every
//   unpaid invoice's total due is what it was. All zero differences is the
//   proof that the readers change nothing until a receipt is marked.
//   Part B (hypotheticals): for each --mark=<expenseId>[:<dollars>], the receipt,
//   where its line would land (the week, that week's invoice and its status),
//   the driver's total due before and after, the month it costs (in place or a
//   credit in the open month), and each affected month's company trip expenses,
//   driver pay and investor payout, before and after.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/personal-expenses-dry-run.js --db=app.db --sheet-id=<id> [--key=service-account-key.json]
//        [--mark=<expenseId>[:<dollars>] ...] [--names]
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when it sets none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                print driver names (ids only otherwise)
// The database is this checkout's own app.db or a copy under the temp
// directory; any other is refused (it may be another deployment's). Part A runs
// while expense_personal is empty (or absent: a database the new server has not
// opened yet); Part B needs one the new server has started on (the invoices'
// Personal columns and the expense_personal table exist).
// There is no default sheet. Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { parseArgs, sheetFor, envFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ROOTS = [
	"computeInvestorMonthlyEarnings", "getCarrierDBFromSQLite", "getInvestorDriverSet", "parseSheet", "deduplicateLoads", "findCol",
	"getDeductibleExpensesByDriverMonth", "kpiGatherDbInputs", "fuelCpgBandFromFleet", "invoiceTotalDue",
	"personalPlacement", "personalShareForReceipt", "payoutRules", "futureAwarePeriodExpr", "periodWriteLocked", "periodLocksReadable",
	"appMonthKey", "appTodayKey", "getWeekRange", "invoiceMonthLockBlockers", "EXPENSE_PERIOD_EXPR",
];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "getJobTrackingCached", "fetch", "expenseFrom", "notifyChange", "io"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "transporter", "getDrive", "sendEmail", "jtCacheInvalidate"];
const LIFTED_REQUIRE_OK = (m) => m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The lifted code, with expenseFrom() switchable: "plain" answers the receipts
// table, "derived" the sources lib/personal-expense.js builds (over the TEMP
// expense_personal of this connection).
function buildDryRunWorld({ db, sheetData, env = {}, DateImpl = Date }) {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const personalExpense = appRequire("./lib/personal-expense");
	const lifted = closure(SRC, { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const mode = { source: "plain" };
	const columns = db.prepare("PRAGMA table_info(expenses)").all().map((c) => c.name);
	const expenseFrom = (kind) => {
		if (kind !== "book" && kind !== "world") throw new Error(`unknown source ${kind}`);
		return mode.source === "plain" ? "expenses" : `(${personalExpense.expenseSourceSql(kind, columns)}) AS expenses`;
	};
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which the dry run does not load`);
		return appRequire(m);
	};
	const quiet = { log() {}, info() {}, warn() {}, error: (...a) => console.error(...a) };
	const body = [
		'"use strict";',
		lifted.text,
		"let _sheet = null;",
		"async function getJobTrackingCached() {",
		"\tif (!_sheet) { const p = parseSheet(__sheetData); p.data = deduplicateLoads(p.data, p.headers); _sheet = p; }",
		"\treturn _sheet;",
		"}",
		`return { ${ROOTS.join(", ")} };`,
	].join("\n");
	const noFetch = () => { throw new Error("the dry run makes no network calls"); };
	const api = new Function(...PROVIDED, "__sheetData", body)(
		db, liftedRequire, quiet, { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } },
		ROOT, DateImpl, null, noFetch, expenseFrom, () => {}, null, sheetData,
	);
	return { db, api, mode, personalExpense, expenseFrom };
}

// Whether the new server has opened this database (its Personal columns and
// table exist), and how many Personal lines it holds.
function ledgerState(db) {
	const invoiceCols = new Set(db.prepare("PRAGMA table_info(invoices)").all().map((c) => c.name));
	const table = !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'expense_personal'").get();
	const migrated = invoiceCols.has("personal_total") && invoiceCols.has("personal_share_total") && table;
	return { migrated, table, rows: table ? db.prepare("SELECT COUNT(*) AS n FROM main.expense_personal").get().n : 0 };
}

// The TEMP ledger this connection writes to: the real table's shape, or the
// schema's own when the database has none yet.
function createTempLedger(db, state) {
	if (state.table) {
		db.exec("CREATE TEMP TABLE IF NOT EXISTS expense_personal AS SELECT * FROM main.expense_personal WHERE 0");
		return;
	}
	const create = /CREATE TABLE IF NOT EXISTS expense_personal \(([\s\S]*?)\n\);/.exec(require("../lib/personal-expense").SCHEMA_SQL);
	db.exec(`CREATE TEMP TABLE IF NOT EXISTS expense_personal (${create[1]}\n)`);
}

// Every figure the readers feed, keyed for comparison.
async function figures(w) {
	const { api, db } = w;
	const out = {};
	const put = (key, value) => { out[key] = typeof value === "number" ? round2(value) : value; };
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const owners = db.prepare("SELECT DISTINCT owner_id AS id FROM trucks WHERE owner_id > 0 ORDER BY owner_id").all().map((r) => r.id);
	const scopes = [{ key: "fleet", user: { id: 0, role: "Super Admin", username: "dry-run" }, isSuperAdmin: true, investorDriverSet: null, investorOwnerId: null, owner: 0 },
		...owners.map((id) => ({ key: `owner ${id}`, user: { id, role: "Investor", username: `owner-${id}` }, isSuperAdmin: false,
			investorDriverSet: api.getInvestorDriverSet(id, carrierDB.data, driverCol, carrierCol), investorOwnerId: id, owner: id }))];
	for (const s of scopes) {
		const config = {};
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, ?) ORDER BY owner_id").all(s.owner).forEach((r) => { config[r.key] = r.value; });
		const r = await api.computeInvestorMonthlyEarnings({ user: s.user, isSuperAdmin: s.isSuperAdmin, investorDriverSet: s.investorDriverSet, investorOwnerId: s.investorOwnerId, config });
		for (const m of r.monthlyEarnings || []) {
			const x = m.exact || {};
			put(`${s.key} ${m.month} trip expenses`, x.tripExpenses);
			put(`${s.key} ${m.month} driver pay`, x.driverPay);
			put(`${s.key} ${m.month} net profit`, x.netProfit);
			if (s.investorOwnerId) put(`${s.key} ${m.month} investor payout`, m.investorEarnings);
		}
	}
	const deductible = api.getDeductibleExpensesByDriverMonth();
	for (const [driver, months] of Object.entries(deductible)) {
		for (const [month, total] of Object.entries(months)) put(`percentage base ${driver} ${month}`, total);
	}
	for (const r of db.prepare(`SELECT strftime('%Y-%m', date) AS m, COALESCE(SUM(amount),0) AS spend, COALESCE(SUM(gallons),0) AS gallons, COUNT(*) AS fills
		FROM ${w.expenseFrom("world")} WHERE LOWER(type) = 'fuel' AND COALESCE(status, '') != 'Rejected' GROUP BY m`).all()) {
		put(`fuel ${r.m} spend`, r.spend);
		put(`fuel ${r.m} gallons`, r.gallons);
		put(`fuel ${r.m} fills`, r.fills);
	}
	const kpi = api.kpiGatherDbInputs(db, { asOfDay: api.appTodayKey(), timeZone: require("../lib/app-time").appTimeZone() });
	put("kpi fuel receipts", JSON.stringify(kpi.fuelReceipts.map((f) => [f.day, round2(f.amount), f.gallons]).sort()));
	put("cost-per-gallon band", JSON.stringify(api.fuelCpgBandFromFleet()));
	return out;
}

function diff(before, after) {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	return keys.filter((k) => before[k] !== after[k]).map((k) => ({ figure: k, before: before[k] ?? null, after: after[k] ?? null }));
}

const INSERT_COLS = ["expense_id", "kind", "reverses_id", "cents", "receipt_cents", "merchant", "receipt_date", "cost_period", "in_place", "book_date",
	"week_start", "invoice_id", "reversed_by_id", "share_cents", "base_invoice_id", "needs_correction_since", "reason", "created_at", "created_by",
	"created_by_id", "created_role", "voided_at", "voided_by", "void_reason"];
function insertTempRow(db, row) {
	const id = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM temp.expense_personal").get().n);
	const full = { reverses_id: null, merchant: "", receipt_date: "", invoice_id: null, reversed_by_id: null, share_cents: 0, base_invoice_id: null, needs_correction_since: "", reason: "dry run",
		created_at: new Date().toISOString(), created_by: "dry-run", created_by_id: 0, created_role: "system", voided_at: "", voided_by: "", void_reason: "", ...row };
	db.prepare(`INSERT INTO temp.expense_personal (id, ${INSERT_COLS.join(", ")}) VALUES (?, ${INSERT_COLS.map(() => "?").join(", ")})`)
		.run(id, ...INSERT_COLS.map((c) => full[c]));
	return id;
}

// One mark as POST /api/expenses/:id/personal would make it, without writing.
function planMark(w, spec, names, dataDir) {
	const { api, db, personalExpense } = w;
	const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(spec.id);
	if (!expense) return { expenseId: spec.id, refused: "no such receipt" };
	if (String(expense.status || "") === "Rejected") return { expenseId: spec.id, refused: "the receipt is Rejected (EXPENSE_REJECTED)" };
	const receiptCents = personalExpense.receiptCents(expense.amount);
	const amount = personalExpense.parseAmountCents(spec.amount, receiptCents);
	if (amount.code) return { expenseId: spec.id, refused: `${amount.code}: ${amount.error}` };
	const periodExpr = api.payoutRules().futureReceipts ? api.futureAwarePeriodExpr() : api.EXPENSE_PERIOD_EXPR;
	const month = (db.prepare(`SELECT ${periodExpr} AS m FROM expenses WHERE id = ?`).get(spec.id) || {}).m || "";
	const inPlace = /^\d{4}-\d{2}$/.test(month) && !api.periodWriteLocked(month);
	const week = api.getWeekRange().weekStart;
	const share = api.personalShareForReceipt(expense, amount.cents);
	const row = {
		expense_id: expense.id, kind: "deduct", cents: amount.cents, receipt_cents: receiptCents, merchant: personalExpense.merchantOf(expense),
		receipt_date: String(expense.date || "").slice(0, 10), cost_period: inPlace ? month : api.appMonthKey(), in_place: inPlace ? 1 : 0,
		book_date: inPlace ? String(expense.date || "").slice(0, 10) : api.appTodayKey(), week_start: week, share_cents: share,
	};
	const place = api.personalPlacement(String(expense.driver || ""), week);
	const net = (share - amount.cents) / 100;
	let landing;
	if (place.kind === "attach") {
		const before = api.invoiceTotalDue(place.invoice);
		const after = round2(before + net);
		landing = after < 0
			? { where: `waits for the week's correction invoice: it would take ${place.invoice.invoice_number} (${place.invoice.status}) below $0`, totalDueBefore: before, totalDueAfter: before }
			: { where: `${place.invoice.invoice_number} (${place.invoice.status}), attached now`, totalDueBefore: before, totalDueAfter: after };
	} else if (place.kind === "correction") {
		const before = place.correction ? api.invoiceTotalDue(place.correction) : 0;
		landing = { where: place.correction ? `the week's open correction ${place.correction.invoice_number}` : `a new correction Draft for the week (${place.weekly.invoice_number} is ${place.weekly.status})`,
			totalDueBefore: before, totalDueAfter: round2(before + net) };
	} else if (place.kind === "pending") {
		landing = { where: "the week's invoice when it is generated", lineAmount: net };
	} else {
		landing = { where: `waits for the week's correction invoice (${place.why || "cannot place"})`, lineAmount: net };
	}
	const photo = String(expense.photo_data || "");
	const file = photo.startsWith("/uploads/expense-receipts/") ? path.join(dataDir, "uploads", "expense-receipts", path.basename(photo)) : "";
	return {
		expenseId: expense.id,
		receipt: { type: expense.type, merchant: row.merchant, date: row.receipt_date, amount: receiptCents / 100, status: expense.status || "Pending",
			month, monthClosed: !inPlace, ...(names ? { driver: expense.driver } : {}) },
		personal: { amount: amount.cents / 100, shareReturned: share / 100, week, costMonth: row.cost_period, books: inPlace ? "in place" : `a credit in ${row.cost_period}` },
		landing,
		receiptFile: file ? (fs.existsSync(file) ? "on file" : "missing") : (photo ? "not a stored upload" : "none"),
		row,
	};
}

async function personalDryRun(w, { marks = [], names = false, dataDir = ROOT } = {}) {
	const { db } = w;
	const state = ledgerState(db);
	if (marks.length && !state.migrated) {
		throw Object.assign(new Error("Part B needs a database the new server has started on (invoices.personal_total and expense_personal exist); Part A runs without marks"), { refused: true });
	}
	createTempLedger(db, state);
	const result = { partA: null, partB: null };
	w.mode.source = "plain";
	const plain = await figures(w);
	if (state.rows === 0) {
		// A voided line switches the readers to the derived sources while no line applies.
		const anyReceipt = db.prepare("SELECT MIN(id) AS id FROM expenses").get().id;
		if (anyReceipt != null) {
			insertTempRow(db, { expense_id: anyReceipt, kind: "deduct", cents: 1, receipt_cents: 1, cost_period: "1970-01", in_place: 1, book_date: "1970-01-01",
				week_start: "1970-01-03", voided_at: new Date().toISOString(), voided_by: "dry-run", void_reason: "parity probe" });
		}
		w.mode.source = "derived";
		const derived = await figures(w);
		const differences = diff(plain, derived);
		// Before the server adds the two columns, every invoice reads them as 0.
		const invoices = db.prepare("SELECT * FROM invoices WHERE deleted_at = '' AND status != 'Paid'").all()
			.map((r) => ({ personal_total: 0, personal_share_total: 0, ...r }));
		const dueDiffs = invoices.filter((r) => w.api.invoiceTotalDue(r) !== round2((r.total_earnings || 0) + (r.adjustment || 0)))
			.map((r) => ({ invoice: r.invoice_number, before: round2((r.total_earnings || 0) + (r.adjustment || 0)), after: w.api.invoiceTotalDue(r) }));
		result.partA = { figuresCompared: Object.keys(plain).length, unpaidInvoicesCompared: invoices.length, differences, totalDueDifferences: dueDiffs,
			allEqual: differences.length === 0 && dueDiffs.length === 0 };
	} else {
		result.partA = { skipped: `expense_personal already holds ${state.rows} row(s): Part A proves the readers inert before any mark` };
	}
	if (marks.length) {
		w.mode.source = "derived";
		db.exec("DELETE FROM temp.expense_personal");
		const before = await figures(w);
		const planned = marks.map((m) => planMark(w, m, names, dataDir));
		for (const p of planned) if (p.row) insertTempRow(db, p.row);
		const after = await figures(w);
		result.partB = {
			marks: planned.map(({ row, ...p }) => p),
			changes: diff(before, after),
		};
	}
	db.exec("DROP TABLE IF EXISTS temp.expense_personal");
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) throw new Error("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let scoped;
	try {
		scoped = envFor({ root: ROOT, dbPath: args.db, envFile });
	} catch (err) {
		console.error(`REFUSED: ${err.message}`);
		process.exit(2);
	}
	const marks = [];
	for (const a of process.argv.slice(2)) {
		const m = /^--mark=(\d+)(?::(\d+(?:\.\d{1,2})?))?$/.exec(a);
		if (a.startsWith("--mark") && !m) throw new Error(`--mark takes <expenseId>[:<dollars>], got ${a}`);
		if (m) marks.push({ id: Number(m[1]), amount: m[2] });
	}
	const sheetData = await sheetFor(args, ROOT);
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const db = new Database(scoped.file, { readonly: true, fileMustExist: true });
	if (!db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
	db.pragma("busy_timeout = 10000");
	try {
		const w = buildDryRunWorld({ db, sheetData, env: scoped.env });
		const result = await personalDryRun(w, { marks, names: args.names === true, dataDir: path.dirname(scoped.file) });
		console.log(JSON.stringify(result, null, 1));
	} catch (err) {
		if (err && err.refused) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		throw err;
	} finally {
		db.close();
	}
}

module.exports = { buildDryRunWorld, personalDryRun };

if (require.main === module) {
	main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
}
