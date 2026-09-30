#!/usr/bin/env node
/**
 * GET /api/investor/report drops cancelled and soft-deleted loads before any
 * revenue math, through excludeDroppedLoads(), as /api/investor does.
 *
 * THE BUG (fixed 2026-09-30). The report reads Job Tracking with its own
 * values.get and deduplicates it, but it never ran excludeDroppedLoads(), the one
 * place that decides "is this load live?" (CLAUDE.md, "Load exclusion is
 * centralized"). The portal (/api/investor) and the payouts ledger
 * (computeInvestorMonthlyEarnings()) both drop such rows, so the report
 * disagreed with them:
 *   - a load soft-deleted into deleted_loads keeps its completed status on the
 *     sheet, so it counted in Gross Revenue (and so in Net Profit, Net Revenue
 *     To Date and ROI), Total Revenue, Avg Revenue / Load, Completed Loads,
 *     Total Jobs and the Monthly Revenue table;
 *   - a cancelled load (Job Status Cancelled / Canceled) was kept out of Gross
 *     Revenue only by the completed-status test, and still counted in Total Jobs
 *     and, when it had a Payment, in the Monthly Revenue table, which tests no
 *     status at all.
 *
 * THE SECOND BUG (fixed the same day). The Monthly Revenue table tested no status,
 * so a live load in progress (At Shipper, At Receiver, In Transit…) with a
 * Payment showed in the table and not in Gross Revenue, and the months did not
 * add up to it. The portal's monthly figures count completed loads only. On a
 * local copy of production's data, live loads still At Shipper or At Receiver
 * put the table above Gross Revenue. The table now counts the
 * completed statuses Gross Revenue counts, by the same column and regex.
 *
 * WHAT IS PROVED HERE
 *   §1  source: the handler calls excludeDroppedLoads() once, on its deduplicated
 *       rows, before the first row is read, and hand-rolls no copy of the rule;
 *       the Monthly Revenue table tests Gross Revenue's own status column and
 *       regex, not a copy
 *   §2  the handler's data section, lifted out of server.js and run against a
 *       sheet fixture and a real SQLite deleted_loads table: an investor's report
 *       (and a Super Admin's preview of it) and the fleet-wide report count only
 *       live loads, against a hand oracle, and the Monthly Revenue table sums to
 *       Gross Revenue. A mid-month range covers the whole months under RANGE_MODE
 *       "whole-months" and the exact dates under "exact-dates"
 *       (lib/investor-report-options.js)
 *   §3  MUTANTS: the section without the exclusion counts the dropped loads
 *       again; without the table's status test the in-progress loads show in
 *       the table and it stops summing to Gross Revenue; without both it prints
 *       exactly the figures the report printed before either fix; a range check
 *       that ignores RANGE_MODE stays on the exact dates
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT:
 * server.js opens SQLite, reads a service-account key and listens on import.
 * Same approach as test-investor-report-payout.js; every extraction asserts
 * exactly one match, so a rename fails loudly instead of testing nothing.
 *
 * Run: node scripts/test-investor-report-dropped-loads.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require("../lib/ratecon-load");
const investorReportOptions = require("../lib/investor-report-options");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
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
function extractFn(name) {
	const plain = `\nfunction ${name}(`;
	const asyncy = `\nasync function ${name}(`;
	const hits = (SRC.split(plain).length - 1) + (SRC.split(asyncy).length - 1);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = SRC.includes(asyncy) ? asyncy : plain;
	const start = SRC.indexOf(needle) + 1;
	let paren = 0;
	let body = -1;
	for (let j = SRC.indexOf("(", start); j < SRC.length; j++) {
		if (SRC[j] === "(") paren++;
		else if (SRC[j] === ")") { paren--; if (paren === 0) { body = SRC.indexOf("{", j); break; } }
	}
	if (body < 0) throw new Error(`could not find the body of ${name}()`);
	let depth = 0;
	for (let j = body; j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(name) {
	const re = new RegExp(`\\nconst ${name} =[\\s\\S]*?;\\n`, "g");
	const hits = SRC.match(re) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 definition of const ${name} in server.js, found ${hits.length}`);
	return hits[0].trim();
}
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");

const REPORT_START = SRC.indexOf('app.get("/api/investor/report"');
if (REPORT_START < 0) throw new Error("GET /api/investor/report not found");
const REPORT_END = SRC.indexOf("\napp.", REPORT_START + 10);
const HANDLER = SRC.slice(REPORT_START, REPORT_END > REPORT_START ? REPORT_END : SRC.length);

// The handler's data section: everything from checking the date range and
// resolving whose report it is to the last figure, stopping where the PDF starts.
// Run as-is, so a figure the fix does not reach shows up here.
const SEG_OPEN = "const dateRange = investorReportOptions.reportDateRange(";
const SEG_CLOSE = "\t\t// Build PDF\n";
for (const [needle, what] of [[SEG_OPEN, "the date-range check"], [SEG_CLOSE, "the `// Build PDF` marker"]]) {
	const n = HANDLER.split(needle).length - 1;
	if (n !== 1) throw new Error(`expected ${what} exactly once in the report handler, found ${n}`);
}
const SEGMENT = HANDLER.slice(HANDLER.indexOf(SEG_OPEN), HANDLER.indexOf(SEG_CLOSE));

// The exclusion statement the first fix adds, and the mutant that removes it.
const EXCLUDE_STMT = "jobTracking.data = excludeDroppedLoads(jobTracking.data, jobTracking.headers);";
// The Monthly Revenue table's status test (the second fix): Gross Revenue's own
// rptStatusCol / rptCompletedStatuses, not a copy. The mutant removes it.
const TABLE_STATUS_STMT = "if (!rptCompletedStatuses.test(st)) return;";
const TABLE_OPEN = "const monthlyRevenue2 = {};";
const TABLE_CLOSE = "const monthlyData2 =";

const NAMES = [
	"resolvePreviewUser", "parseSheet", "deduplicateLoads", "findCol",
	"getDeletedLoadIds", "loadKeySet", "excludeDroppedLoads",
	"reportRangeMonthKeys", "summarizeReportPayout", "reportPayoutLabel",
	"investorJobRowTest", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName",
	"investorTruckPurchase",
];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, extractFn(n)]));
const CONSTS = ["CANCELED_STATUS_RE", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR"].map(extractConst);

// ------------------------------------------------------------------ fixtures
// Production's real Job Tracking header row (the columns the report resolves by
// regex: "Load ID", "Job Status", "  Payment  " with its real spaces, "Assigned
// Date", "Owner ID").
const HEADERS = ["Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status", "Phase of Progress",
	"Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output"];
// Mid-month dates: the report keys Monthly Revenue with local getMonth(), so the
// 1st of a month would slide into the previous one west of UTC.
const LOADS = [
	{ id: "1001", status: "Delivered", pay: "$1,000.00", date: "2026-07-06", owner: "5" },   // live
	{ id: "1002", status: "Completed", pay: "2,000", date: "2026-08-10", owner: "5" },       // live
	{ id: "1004", status: "Cancelled", pay: "700", date: "2026-07-12", owner: "5" },         // DROPPED: cancelled
	{ id: "1005", status: "Canceled", pay: "300", date: "2026-08-12", owner: "5" },          // DROPPED: the other spelling
	{ id: "1006", status: "Delivered", pay: "500", date: "2026-07-20", owner: "5" },         // DROPPED: soft-deleted
	{ id: "#1007", status: "POD Received", pay: "250", date: "2026-08-20", owner: "5" },     // DROPPED: soft-deleted as "1007"
	{ id: "2001", status: "Delivered", pay: "9,000", date: "2026-07-15", owner: "41" },      // live, another investor's
	{ id: "2002", status: "Cancelled", pay: "800", date: "2026-08-15", owner: "41" },        // DROPPED: cancelled
	{ id: "1008", status: "At Shipper", pay: "450", date: "2026-08-22", owner: "5" },        // live, in progress: a job, no revenue yet
	{ id: "1009", status: "At Receiver", pay: "350", date: "2026-07-25", owner: "5" },       // live, in progress
	{ id: "2003", status: "In Transit", pay: "600", date: "2026-08-18", owner: "41" },       // live, in progress, another investor's
];
// The delete route stores the id with its "#" stripped (see loadKeySet()).
const DELETED = ["1006", "1007"];

function sheetValues() {
	const col = (h) => HEADERS.indexOf(h);
	return [HEADERS, ...LOADS.map((l) => {
		const row = HEADERS.map(() => "");
		row[col("Load ID")] = l.id;
		row[col("Job Status")] = l.status;
		row[col("  Payment  ")] = l.pay;
		row[col("Assigned Date")] = l.date;
		row[col("Owner ID")] = l.owner;
		return row;
	})];
}

// ⚠️ THE ORACLE, by hand from the fixture: only the live loads count, and only the
// completed ones earn revenue. Owner 5: 1001 (July 1,000) and 1002 (August 2,000);
// the in-progress 1008 and 1009 are jobs, not revenue, so they count in Total Jobs
// and nowhere else. Fleet: those plus 2001 (July 9,000) and the in-progress 2003.
// The Monthly Revenue table adds up to Gross Revenue in every case.
const ORACLE = {
	investor: { totalRevenue: 3000, completedJobs: 2, totalJobs: 4, monthly: [{ month: "2026-07", amount: 1000 }, { month: "2026-08", amount: 2000 }] },
	fleet: { totalRevenue: 12000, completedJobs: 3, totalJobs: 6, monthly: [{ month: "2026-07", amount: 10000 }, { month: "2026-08", amount: 2000 }] },
};
// §3's mutants, each by hand from the same fixture.
const MUTANT_FIGURES = {
	// Without the exclusion: the soft-deleted 1006 (July 500) and #1007 (August 250)
	// in every figure, the cancelled rows in Total Jobs only (the table's status
	// test keeps them out of it).
	noExclusion: {
		investor: { totalRevenue: 3750, completedJobs: 4, totalJobs: 8, monthly: [{ month: "2026-07", amount: 1500 }, { month: "2026-08", amount: 2250 }] },
		fleet: { totalRevenue: 12750, completedJobs: 5, totalJobs: 11, monthly: [{ month: "2026-07", amount: 10500 }, { month: "2026-08", amount: 2250 }] },
	},
	// Without the table's status test: the in-progress 1009 (July 350), 1008
	// (August 450) and 2003 (August 600) in the table, and in nothing else.
	noTableStatus: {
		investor: { totalRevenue: 3000, completedJobs: 2, totalJobs: 4, monthly: [{ month: "2026-07", amount: 1350 }, { month: "2026-08", amount: 2450 }] },
		fleet: { totalRevenue: 12000, completedJobs: 3, totalJobs: 6, monthly: [{ month: "2026-07", amount: 10350 }, { month: "2026-08", amount: 3050 }] },
	},
};
// What the report printed before either fix, on the same fixture: the soft-deleted
// 1006 and #1007 in every figure, the cancelled and in-progress rows in Total Jobs
// and, with a Payment, in the Monthly Revenue table. The mutant without both fixes
// must reproduce these exactly.
const BEFORE = {
	investor: { totalRevenue: 3750, completedJobs: 4, totalJobs: 8, monthly: [{ month: "2026-07", amount: 2550 }, { month: "2026-08", amount: 3000 }] },
	fleet: { totalRevenue: 12750, completedJobs: 5, totalJobs: 11, monthly: [{ month: "2026-07", amount: 11550 }, { month: "2026-08", amount: 4400 }] },
};
const tableSum = (r) => r.monthly.reduce((s, m) => s + m.amount, 0);

function world() {
	const db = new Database(":memory:");
	const ddl = SRC.match(/CREATE TABLE IF NOT EXISTS deleted_loads \([\s\S]*?\n\t\)/);
	if (!ddl) throw new Error("deleted_loads CREATE TABLE not found in server.js");
	db.exec(ddl[0]);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
	db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT, owner_id INTEGER, purchase_price REAL, created_at TEXT, in_service_date TEXT, retired_at TEXT)");
	db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY, type TEXT, amount REAL, date TEXT, status TEXT, owner_id INTEGER, driver TEXT, truck_unit TEXT, posted_period TEXT, created_at TEXT)");
	db.exec("CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY, truck TEXT, amount REAL, type TEXT)");
	db.exec("CREATE TABLE compliance_fees (id INTEGER PRIMARY KEY, truck TEXT, amount REAL, status TEXT)");
	db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'sa', 'Super Admin'), (5, 'inv5', 'Investor')").run();
	const del = db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, 'fixture')");
	for (const id of DELETED) del.run(id);
	return db;
}

// Runs the handler's data section with the module-scope names server.js would
// supply. The payout reader and the fixed-cost helpers are stubs (no payout month,
// no truck): this runner is about which LOADS the report reads.
function runSection(segment, { session, query = {}, rangeMode = "whole-months" }) {
	const db = world();
	const deps = {
		db,
		normalizeLoadId,
		SPREADSHEET_ID: "fixture-sheet",
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheetValues() } }) } } }),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [] }),
		getInvestorDriverSet: () => new Set(),
		getInvestorDriverMonthWindows: () => new Map(),
		investorExpenseScopeSql: (ownerId) => ({ sql: "owner_id = ?", params: [ownerId] }),
		investorReportPayoutEntries: async () => [],
		reportPayoutNote: () => "",
		resolveInvestorSplitPct: () => 50,
		truckChargedInMonth: () => true,
		truckMonthlyFixed: () => ({ eld: 0, hvut: 0, irp: 0, truckPayment: 0, insurance: 0, total: 0 }),
		// The fleet rule the fixed-cost lines and fee queries read, the real module.
		investorPayoutBasis: require("../lib/investor-payout-basis"),
		logAudit: () => {},
		investorReportOptions: { ...investorReportOptions, RANGE_MODE: rangeMode },
	};
	const names = Object.keys(deps);
	const fn = new Function(...names, `
		${CONSTS.join("\n")}
		${NAMES.map((n) => SOURCES[n]).join("\n")}
		return async (req, res) => {
			${segment}
			return { totalRevenue, completedJobs, totalJobs: filteredJobData.length, monthly: monthlyData2 };
		};
	`)(...names.map((n) => deps[n]));
	const res = { status: () => ({ json: () => { throw new Error("the handler answered an error"); } }) };
	return fn({ session: { user: session }, query }, res);
}
const INVESTOR = { id: 5, username: "inv5", role: "Investor" };
const SUPER_ADMIN = { id: 1, username: "sa", role: "Super Admin" };

(async () => {
	// ======================================================= §1 source pins
	section("§1 the handler drops cancelled and soft-deleted loads through the shared rule");
	{
		const h = stripComments(HANDLER);
		eq(h.split(EXCLUDE_STMT).length - 1, 1, "the handler runs excludeDroppedLoads() once, on its own rows");
		const dedupe = h.indexOf("jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);");
		const exclude = h.indexOf(EXCLUDE_STMT);
		const firstRead = h.indexOf("const filteredJobData");
		ok(dedupe >= 0 && exclude > dedupe, "…after deduplicateLoads(), the order /api/investor reads them in");
		ok(exclude >= 0 && firstRead > exclude, "…and before the first row is read");
		ok(!/CANCELED_STATUS_RE|deleted_loads|getDeletedLoadIds|cancel/i.test(h), "the handler hand-rolls no copy of the rule");
		const open = h.indexOf(TABLE_OPEN);
		const close = h.indexOf(TABLE_CLOSE);
		ok(open >= 0 && close > open, "the Monthly Revenue table block is found");
		const table = h.slice(open, close);
		eq(table.split(TABLE_STATUS_STMT).length - 1, 1, "the Monthly Revenue table tests Gross Revenue's completed statuses");
		ok(/\brptStatusCol\b/.test(table), "…on Gross Revenue's own status column");
		ok(!/\(delivered\|/i.test(table), "…and holds no copy of the status regex");
	}

	// ============================================== §2 only live loads count
	section("§2 the report counts only live loads, and the table sums to Gross Revenue (hand oracle)");
	{
		const inv = await runSection(SEGMENT, { session: INVESTOR });
		eq(inv, ORACLE.investor, "an investor's report: Gross Revenue, Completed Loads, Total Jobs, Monthly Revenue");
		const preview = await runSection(SEGMENT, { session: SUPER_ADMIN, query: { as_user_id: "5" } });
		eq(preview, ORACLE.investor, "a Super Admin's preview of that investor: the same figures");
		const fleet = await runSection(SEGMENT, { session: SUPER_ADMIN });
		eq(fleet, ORACLE.fleet, "the fleet-wide report: the same rule");
		const ranged = await runSection(SEGMENT, { session: INVESTOR, query: { start: "2026-07-01", end: "2026-07-31" } });
		eq(ranged, { totalRevenue: 1000, completedJobs: 1, totalJobs: 2, monthly: [{ month: "2026-07", amount: 1000 }] },
			"a July-only report: 1001's revenue alone (the cancelled 1004 and the soft-deleted 1006 are out; the in-progress 1009 is a job)");
		for (const [who, r] of [["investor", inv], ["preview", preview], ["fleet", fleet], ["July-only", ranged]]) {
			eq(tableSum(r), r.totalRevenue, `the ${who} report's Monthly Revenue table sums to its Gross Revenue`);
		}

		// A range that starts and ends mid-month, July 10 to August 11, under each
		// RANGE_MODE. "whole-months": July 1 to August 31, so every live load of
		// owner 5's. "exact-dates" (the report before 2026-09-30): only 1002 (August
		// 10) earns, and the in-progress 1009 (July 25) is a job.
		const MID = { start: "2026-07-10", end: "2026-08-11" };
		eq(await runSection(SEGMENT, { session: INVESTOR, query: MID, rangeMode: "whole-months" }), ORACLE.investor,
			"whole-months, a mid-month range: the whole of July and August");
		eq(await runSection(SEGMENT, { session: INVESTOR, query: MID, rangeMode: "exact-dates" }),
			{ totalRevenue: 2000, completedJobs: 1, totalJobs: 2, monthly: [{ month: "2026-08", amount: 2000 }] },
			"exact-dates, the same range: the exact dates, as before");
	}

	// ============================================================ §3 mutants
	section("§3 MUTANTS");
	{
		const noExclusion = SEGMENT.replace(EXCLUDE_STMT, "");
		const noTableStatus = SEGMENT.replace(TABLE_STATUS_STMT, "");
		const neither = noExclusion.replace(TABLE_STATUS_STMT, "");
		ok(noExclusion !== SEGMENT && noTableStatus !== SEGMENT && neither !== noExclusion, "the mutants applied");

		const inv1 = await runSection(noExclusion, { session: INVESTOR });
		const fleet1 = await runSection(noExclusion, { session: SUPER_ADMIN });
		ok(JSON.stringify(inv1) !== JSON.stringify(ORACLE.investor) && JSON.stringify(fleet1) !== JSON.stringify(ORACLE.fleet),
			"MUTANT caught: §2's oracle fails without the exclusion");
		eq(inv1, MUTANT_FIGURES.noExclusion.investor, "…it counts the soft-deleted loads again (investor)");
		eq(fleet1, MUTANT_FIGURES.noExclusion.fleet, "…it counts the soft-deleted loads again (fleet)");

		const inv2 = await runSection(noTableStatus, { session: INVESTOR });
		const fleet2 = await runSection(noTableStatus, { session: SUPER_ADMIN });
		ok(tableSum(inv2) !== inv2.totalRevenue && tableSum(fleet2) !== fleet2.totalRevenue,
			"MUTANT caught: without the table's status test, the table no longer sums to Gross Revenue");
		eq(inv2, MUTANT_FIGURES.noTableStatus.investor, "…the in-progress loads show in the table and nowhere else (investor)");
		eq(fleet2, MUTANT_FIGURES.noTableStatus.fleet, "…the in-progress loads show in the table and nowhere else (fleet)");

		eq(await runSection(neither, { session: INVESTOR }), BEFORE.investor, "without both: what the report printed before either fix (investor)");
		eq(await runSection(neither, { session: SUPER_ADMIN }), BEFORE.fleet, "without both: what the report printed before either fix (fleet)");

		// The range check ignoring RANGE_MODE (always the exact dates).
		const CHECK_MODE = "investorReportOptions.reportDateRange(req.query.start, req.query.end, investorReportOptions.RANGE_MODE)";
		const exactOnly = SEGMENT.replace(CHECK_MODE, "investorReportOptions.reportDateRange(req.query.start, req.query.end, 'exact-dates')");
		ok(exactOnly !== SEGMENT, "the RANGE_MODE mutant applied");
		const got = await runSection(exactOnly, { session: INVESTOR, query: { start: "2026-07-10", end: "2026-08-11" }, rangeMode: "whole-months" });
		ok(JSON.stringify(got) !== JSON.stringify(ORACLE.investor) && got.totalRevenue === 2000,
			"MUTANT caught: a range check that ignores RANGE_MODE leaves a whole-months report on the exact dates");
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`PASS — ${pass} assertions passed (4 mutants caught)`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
