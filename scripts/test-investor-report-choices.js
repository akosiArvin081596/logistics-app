#!/usr/bin/env node
/**
 * GET /api/investor/report, run whole, under each setting of the two report
 * switches in lib/investor-report-options.js (2026-09-30):
 *
 *   RANGE_MODE       "whole-months" (shipped): a date range that starts or ends
 *                    mid-month covers the whole of each month it touches, on every
 *                    line, and the period label prints the whole months.
 *                    "exact-dates": revenue and trip expenses cover the exact dates
 *                    chosen, as the report did before.
 *   UNPRICED_TRUCKS  "not-available" (shipped): a truck with no recorded purchase
 *                    price is never a silent $0. The per-truck figures are the
 *                    average over the priced trucks ("Not recorded" when none has a
 *                    price); Total Purchase Price, Current Market Value, Total
 *                    Investment and Payoff Progress read "Not available" while
 *                    any truck lacks a price (Business ROI reads no price and is
 *                    unaffected); a footnote says how many. "zero": the figures
 *                    the report printed before.
 *
 * WHAT IS PROVED HERE
 *   §1  the whole handler, lifted out of server.js, run against a sheet fixture
 *       and a real SQLite database, with pdfkit replaced by a recorder that keeps
 *       every string the report draws, in order. A mid-month range under
 *       "whole-months" and "exact-dates": the period label, Total Revenue, the
 *       trip-expense lines, the payout (whole months either way) and the note's
 *       first sentence, against a hand oracle
 *   §2  UNPRICED_TRUCKS for an investor with one priced and one unpriced truck, an
 *       investor whose only truck is unpriced, and one whose trucks are all
 *       priced: every asset KPI and the footnote, against a hand oracle; "zero"
 *       reproduces the figures from before the choice
 *   §3  MUTANTS: the handler pricing trucks at "zero" whatever the switch, the
 *       footnote never printed, and the period label reading the raw query
 *
 * The recorder stands in for pdfkit only; every figure is the handler's own. The
 * payout months come from a stub of investorReportPayoutEntries() (the ledger
 * itself is test-investor-report-payout.js's). TZ is UTC, the production
 * server's zone, because the handler parses the range start as UTC midnight and
 * prints it as a server-local date.
 *
 * Run: node scripts/test-investor-report-choices.js
 */
"use strict";

process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require("../lib/ratecon-load");
const investorReportOptions = require("../lib/investor-report-options");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let mutantsCaught = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------- extraction
function balancedFrom(src, open) {
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return j + 1; }
	}
	throw new Error("unbalanced braces");
}
function extractFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let paren = 0;
	let body = -1;
	for (let j = SRC.indexOf("(", start); j < SRC.length; j++) {
		if (SRC[j] === "(") paren++;
		else if (SRC[j] === ")") { paren--; if (paren === 0) { body = SRC.indexOf("{", j); break; } }
	}
	if (body < 0) throw new Error(`could not find the body of ${name}()`);
	return SRC.slice(start, balancedFrom(SRC, body));
}
function extractConst(name) {
	const hits = SRC.match(new RegExp(`\\nconst ${name} =[\\s\\S]*?;\\n`, "g")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 definition of const ${name} in server.js, found ${hits.length}`);
	return hits[0].trim();
}
const ROUTE = 'app.get("/api/investor/report", requireRole("Super Admin", "Investor"), ';
if (SRC.split(ROUTE).length - 1 !== 1) throw new Error("expected the report route exactly once");
const OPEN = SRC.indexOf("async (req, res) => {", SRC.indexOf(ROUTE));
const HANDLER = SRC.slice(OPEN, balancedFrom(SRC, SRC.indexOf("{", OPEN)));

const NAMES = [
	"resolvePreviewUser", "parseSheet", "deduplicateLoads", "findCol", "getDeletedLoadIds", "loadKeySet", "excludeDroppedLoads",
	"reportRangeMonthKeys", "summarizeReportPayout", "reportPayoutNote", "periodLabel",
	"investorJobRowTest", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName",
	"investorTruckPurchase", "resolveInvestorSplitPct", "investorExpenseScopeSql",
];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, extractFn(n)]));
const CONSTS = ["CANCELED_STATUS_RE", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR"].map(extractConst);

// ------------------------------------------------------------------ fixtures
const HEADERS = ["Load ID", "Driver", "Job Status", "  Payment  ", "Assigned Date", "Owner ID"];
const LOADS = [
	["5001", "Driver A", "Delivered", "1000", "2026-07-06", "5"],
	["5002", "Driver A", "Delivered", "500", "2026-07-20", "5"],
	["5003", "Driver A", "Completed", "2000", "2026-08-10", "5"],
	["5004", "Driver A", "Delivered", "300", "2026-08-25", "5"],
	["4101", "Driver Z", "Delivered", "4000", "2026-07-18", "41"],
	["4201", "Driver Q", "Delivered", "700", "2026-08-05", "42"],
];
// Owner 5: T-1 priced, T-2 without a price. Owner 41: T-3 priced. Owner 42: T-4,
// its only truck, without a price (0 is no price).
const TRUCKS = [
	[1, "T-1", 5, 60000], [2, "T-2", 5, null], [3, "T-3", 41, 40000], [4, "T-4", 42, 0],
];
// Every investor's payout months: July and August, 700 + 900, driver pay 300 + 200.
const ENTRIES = [
	{ month: "2026-07", payout: 700, driverPay: 300, fixedCosts: 0, inProgress: false, lossCarriedIn: 0, lossDeferred: 0, settledDiffers: false, corrected: false },
	{ month: "2026-08", payout: 900, driverPay: 200, fixedCosts: 0, inProgress: false, lossCarriedIn: 0, lossDeferred: 0, settledDiffers: false, corrected: false },
];

function world() {
	const db = new Database(":memory:");
	const ddl = SRC.match(/CREATE TABLE IF NOT EXISTS deleted_loads \([\s\S]*?\n\t\)/);
	if (!ddl) throw new Error("deleted_loads CREATE TABLE not found in server.js");
	db.exec(ddl[0]);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
	db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT, owner_id INTEGER, purchase_price REAL, make TEXT, model TEXT, assigned_driver TEXT, created_at TEXT, in_service_date TEXT, retired_at TEXT)");
	db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY, type TEXT, amount REAL, date TEXT, status TEXT, owner_id INTEGER, driver TEXT, truck_unit TEXT, posted_period TEXT, created_at TEXT)");
	db.exec("CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY, truck TEXT, amount REAL, type TEXT)");
	db.exec("CREATE TABLE compliance_fees (id INTEGER PRIMARY KEY, truck TEXT, amount REAL, status TEXT)");
	db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'sa', 'Super Admin'), (5, 'inv5', 'Investor'), (41, 'inv41', 'Investor'), (42, 'inv42', 'Investor')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const t = db.prepare("INSERT INTO trucks (id, unit_number, status, owner_id, purchase_price, make, model, assigned_driver) VALUES (?, ?, 'Active', ?, ?, '', '', '')");
	for (const row of TRUCKS) t.run(...row);
	const e = db.prepare("INSERT INTO expenses (type, amount, date, status, owner_id, driver, truck_unit) VALUES (?, ?, ?, 'Approved', 5, 'Driver A', 'T-1')");
	e.run("Fuel", 100, "2026-07-02");
	e.run("Fuel", 40, "2026-07-25");
	e.run("Toll", 60, "2026-08-28");
	return db;
}

// pdfkit's surface as the handler uses it; text() records each string drawn.
function recorder() {
	const texts = [];
	class Doc {
		constructor() {
			this.page = { width: 612, height: 792, margins: { left: 50, bottom: 50 } };
			this.x = 50;
			this.y = 72;
			this.handlers = {};
		}
		on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
		text(s) { texts.push(String(s)); this.y += 12; return this; }
		moveDown(n = 1) { this.y += 12 * n; return this; }
		addPage() { this.y = 50; return this; }
		heightOfString() { return 12; }
		end() {
			setImmediate(() => {
				for (const fn of this.handlers.data || []) fn(Buffer.from("%PDF-recorded"));
				for (const fn of this.handlers.end || []) fn();
			});
		}
	}
	for (const m of ["rect", "fill", "fillColor", "fontSize", "font", "moveTo", "lineTo", "strokeColor", "stroke"]) Doc.prototype[m] = function chain() { return this; };
	return { Doc, texts };
}

async function runReport(handlerSrc, { session, query = {}, rangeMode = "whole-months", unpriced = "not-available" }) {
	const db = world();
	const pdf = recorder();
	const deps = {
		db,
		normalizeLoadId,
		SPREADSHEET_ID: "fixture-sheet",
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [HEADERS, ...LOADS] } }) } } }),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [] }),
		getInvestorDriverSet: () => new Set(),
		getInvestorDriverMonthWindows: () => new Map(),
		investorReportPayoutEntries: async () => ENTRIES.map((x) => ({ ...x })),
		truckChargedInMonth: () => false,
		truckMonthlyFixed: () => ({ eld: 0, hvut: 0, irp: 0, truckPayment: 0, insurance: 0, total: 0 }),
		logAudit: () => {},
		investorReportOptions: { ...investorReportOptions, RANGE_MODE: rangeMode, UNPRICED_TRUCKS: unpriced },
		require: (m) => { if (m !== "pdfkit") throw new Error(`unexpected require(${m})`); return pdf.Doc; },
	};
	const names = Object.keys(deps);
	const handler = new Function(...names, `
		${CONSTS.join("\n")}
		${NAMES.map((n) => SOURCES[n]).join("\n")}
		return ${handlerSrc};
	`)(...names.map((n) => deps[n]));
	let status = 200;
	let body = null;
	const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; }, send(b) { body = b; return this; } };
	await handler({ session: { user: session }, query }, res);
	if (status !== 200 || !Buffer.isBuffer(body)) throw new Error(`the handler answered ${status}: ${JSON.stringify(body)}`);
	const texts = pdf.texts;
	// A KPI's value is the string drawn right after its (upper-cased) label.
	const kpi = (label) => {
		const i = texts.indexOf(label.toUpperCase());
		return i < 0 ? undefined : texts[i + 1];
	};
	// A P&L line's value is the string drawn right after its label.
	const line = (label) => {
		const i = texts.findIndex((t) => t.trim() === label);
		return i < 0 ? undefined : texts[i + 1];
	};
	return {
		period: texts.find((t) => t.startsWith("Period:") || t === "All-time"),
		revenue: kpi("Total Revenue"),
		fuel: line("Fuel Expenses"),
		other: line("Other Expenses"),
		driverPay: line("Driver Pay"),
		payout: line("Investor Payout (50%)"),
		note: texts.find((t) => /Investor Payout is the total|No payout month/.test(t)),
		asset: {
			perTruck: kpi("Purchase Price (per truck)"),
			marketValue: kpi("Current Market Value (80%)"),
			total: kpi("Total Purchase Price"),
			investment: kpi("Total Investment"),
			payoff: kpi("Payoff Progress"),
			roi: kpi("Business ROI"),
			section179: kpi("Section 179 Deduction"),
		},
		footnote: texts.find((t) => t.startsWith("Purchase price not recorded")),
		texts,
	};
}
const INVESTOR5 = { id: 5, username: "inv5", role: "Investor" };
const INVESTOR41 = { id: 41, username: "inv41", role: "Investor" };
const INVESTOR42 = { id: 42, username: "inv42", role: "Investor" };
const SUPER_ADMIN = { id: 1, username: "sa", role: "Super Admin" };
const MID = { start: "2026-07-15", end: "2026-08-12" };

(async () => {
	// ================================================ §1 RANGE_MODE, run whole
	section("§1 RANGE_MODE: a mid-month range (July 15 – August 12), owner 5");
	{
		// ⚠️ THE ORACLE, by hand. whole-months = July 1 – August 31: every load of
		// owner 5's (1,000 + 500 + 2,000 + 300 = 3,800); fuel 100 + 40 = 140; the toll
		// 60 is Other. exact-dates = July 15 – August 12: 5002 and 5003 (2,500); the
		// July 25 fuel (40); no toll. The payout and Driver Pay are July + August
		// either way: 1,600 and 500.
		const whole = await runReport(HANDLER, { session: INVESTOR5, query: MID, rangeMode: "whole-months" });
		eq([whole.period, whole.revenue, whole.fuel, whole.other, whole.driverPay, whole.payout],
			["Period: 7/1/2026 – 8/31/2026", "$3,800", "($140)", "($60)", "($500)", "$1,600"],
			"whole-months: the label, revenue and trip expenses cover July 1 – August 31; the payout July and August");
		ok(whole.note.startsWith("Payouts are settled by month, so this report covers the whole of each month in your date range: July 2026 – August 2026. Investor Payout is the total of your monthly payouts for July 2026 – August 2026"),
			"whole-months: the note opens with the whole-months sentence");
		const exact = await runReport(HANDLER, { session: INVESTOR5, query: MID, rangeMode: "exact-dates" });
		eq([exact.period, exact.revenue, exact.fuel, exact.other, exact.driverPay, exact.payout],
			["Period: 7/15/2026 – 8/12/2026", "$2,500", "($40)", "($0)", "($500)", "$1,600"],
			"exact-dates: the label, revenue and trip expenses cover the exact dates; the payout still July and August");
		ok(exact.note.startsWith("Driver Pay, the fixed costs and Investor Payout cover whole months; revenue and trip expenses cover the exact dates you chose. Investor Payout is the total"),
			"exact-dates: the note opens with the exact-dates sentence");
		const all = await runReport(HANDLER, { session: INVESTOR5, rangeMode: "whole-months" });
		eq([all.period, all.revenue, all.note.slice(0, 40)], ["All-time", "$3,800", "Investor Payout is the total of your mon"], "no range: All-time, and no date-range sentence");
		const fleet = await runReport(HANDLER, { session: SUPER_ADMIN, query: MID, rangeMode: "whole-months" });
		ok(fleet.note.startsWith("Payouts are settled by month, so this report covers the whole of each month in the date range: July 2026 – August 2026."), "the fleet report says \"the date range\"");
		const preview = await runReport(HANDLER, { session: SUPER_ADMIN, query: { ...MID, as_user_id: "5" }, rangeMode: "whole-months" });
		eq([preview.period, preview.revenue, preview.note], [whole.period, whole.revenue, whole.note], "a Super Admin's preview of owner 5: the same report");
	}

	// ============================================ §2 UNPRICED_TRUCKS, run whole
	section("§2 UNPRICED_TRUCKS: the asset figures and the footnote");
	{
		const NR = "Not recorded";
		const NA = "Not available";
		// ⚠️ THE ORACLE, by hand, all-time. Owner 5: revenue 3,800; expenses: driver
		// pay 500 + fuel 140 + other 60 = 700; Net Revenue To Date 3,100. Trucks T-1
		// 60,000 and T-2 (no price), startup 2 × 5,000.
		//   zero: per truck 30,000 (60,000 over both trucks); total 60,000; market
		//   value 48,000; investment 70,000; payoff 3,100 / 70,000 = 4.4%; ROI 3,100 /
		//   3,800 = 81.6%.
		//   not-available: per truck 60,000 (the priced truck); everything that needs
		//   T-2's price is Not available; the footnote says 1 of 2.
		// Every investor's Driver Pay is the stub's 500 (July + August).
		// Owner 42: revenue 700, net 200; its only truck T-4 has no price. zero:
		//   investment 5,000 (startup only), payoff 4.0%, ROI 200 / 700 = 28.6%.
		// Owner 41: revenue 4,000, net 3,500; T-3 40,000 is its only truck, priced:
		//   per truck 40,000, market value 32,000, investment 45,000, payoff 7.8%,
		//   ROI 87.5%, in both settings.
		const cases = [
			["owner 5, zero", INVESTOR5, "zero", { perTruck: "$30,000", marketValue: "$48,000", total: "$60,000", investment: "$70,000", payoff: "4.4%", roi: "81.6%", section179: "$30,000" }, undefined],
			["owner 5, not-available", INVESTOR5, "not-available", { perTruck: "$60,000", marketValue: NA, total: NA, investment: NA, payoff: NA, roi: "81.6%", section179: "$60,000" },
				"Purchase price not recorded for 1 of 2 truck(s). Figures that need it show \"Not available\" until it is entered in the Truck Database."],
			["owner 42, zero", INVESTOR42, "zero", { perTruck: "$0", marketValue: "$0", total: "$0", investment: "$5,000", payoff: "4.0%", roi: "28.6%", section179: "$0" }, undefined],
			["owner 42, not-available", INVESTOR42, "not-available", { perTruck: NR, marketValue: NA, total: NA, investment: NA, payoff: NA, roi: "28.6%", section179: NR },
				"Purchase price not recorded for 1 of 1 truck(s). Figures that need it show \"Not available\" until it is entered in the Truck Database."],
			["owner 41, zero", INVESTOR41, "zero", { perTruck: "$40,000", marketValue: "$32,000", total: "$40,000", investment: "$45,000", payoff: "7.8%", roi: "87.5%", section179: "$40,000" }, undefined],
			["owner 41, not-available", INVESTOR41, "not-available", { perTruck: "$40,000", marketValue: "$32,000", total: "$40,000", investment: "$45,000", payoff: "7.8%", roi: "87.5%", section179: "$40,000" }, undefined],
		];
		for (const [name, session, unpriced, asset, footnote] of cases) {
			const r = await runReport(HANDLER, { session, unpriced });
			eq(r.asset, asset, `${name}: the asset KPIs`);
			eq(r.footnote, footnote, `${name}: ${footnote ? "the footnote" : "no footnote"}`);
			if (footnote) {
				const i = r.texts.indexOf(footnote);
				ok(i > r.texts.indexOf("DEPRECIATION") && i < r.texts.indexOf("Cash Flow & Projections"), `${name}: the footnote sits under the asset KPIs`);
			}
		}
		const na5 = await runReport(HANDLER, { session: INVESTOR5, unpriced: "not-available" });
		ok(!Object.values(na5.asset).includes("$0"), "not-available: no asset KPI is a silent $0");
		// The report's money formatter, as the handler ships it.
		const fmtLine = HANDLER.split("\n").find((l) => l.trim().startsWith("const fmt = n =>"));
		ok(Boolean(fmtLine), "the report's money formatter is found");
		const fmtFn = eval(fmtLine.trim().replace(/^const fmt = /, "").replace(/;$/, ""));
		eq([fmtFn(-1234), fmtFn(1234), fmtFn(-0.4), fmtFn(0)], ["-$1,234", "$1,234", "$0", "$0"], "a negative amount prints as -$1,234, never $-1,234");
	}

	// ============================================================ §3 mutants
	section("§3 MUTANTS");
	{
		const PRICED = "investorReportOptions.truckPriceFigures(purchase, investorReportOptions.UNPRICED_TRUCKS)";
		const zeroAlways = HANDLER.replace(PRICED, "investorReportOptions.truckPriceFigures(purchase, 'zero')");
		ok(zeroAlways !== HANDLER, "the \"ignores UNPRICED_TRUCKS\" mutant applied");
		const a = await runReport(zeroAlways, { session: INVESTOR42, unpriced: "not-available" });
		let caught = a.asset.perTruck === "$0" && a.footnote === undefined;
		ok(caught, "MUTANT caught: a report that ignores UNPRICED_TRUCKS prints an unpriced truck at $0, unflagged");
		if (caught) mutantsCaught++;

		const FOOTNOTE_IF = "if (priced.flagged) {";
		const noFootnote = HANDLER.replace(FOOTNOTE_IF, "if (false) {");
		ok(noFootnote !== HANDLER, "the \"no footnote\" mutant applied");
		const b = await runReport(noFootnote, { session: INVESTOR5, unpriced: "not-available" });
		caught = b.footnote === undefined && b.asset.total === "Not available";
		ok(caught, "MUTANT caught: \"Not available\" with no footnote saying why");
		if (caught) mutantsCaught++;

		const FILTER_START = "const filterStart = dateRange.from ? new Date(dateRange.from) : null;";
		const rawStart = HANDLER.replace(FILTER_START, "const filterStart = req.query.start ? new Date(req.query.start) : null;");
		ok(rawStart !== HANDLER, "the \"raw start\" mutant applied");
		const c = await runReport(rawStart, { session: INVESTOR5, query: MID, rangeMode: "whole-months" });
		caught = c.period === "Period: 7/15/2026 – 8/31/2026" && c.revenue !== "$3,800";
		ok(caught, `MUTANT caught: a filter on the raw start prints ${c.period} and ${c.revenue} under whole-months`);
		if (caught) mutantsCaught++;
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutants caught)`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
