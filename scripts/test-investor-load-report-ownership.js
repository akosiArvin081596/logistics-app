#!/usr/bin/env node
/**
 * GET /api/investor/load-report decides which Job Tracking rows are an
 * investor's with investorJobRowTest(), the rule the report, the tax CSV and the
 * portal share.
 *
 * THE BUG (fixed 2026-09-30). The route kept its own copy of the rule. It
 * matched the driver fallback on `(r[driverCol] || "").trim().toLowerCase()`,
 * without the driverNameForTotals() step every other copy has. So a row with a
 * blank Owner ID whose Driver cell reads as a built-in property name
 * ("constructor", "toString", in any case or spacing) was the investor's here
 * whenever their driver set held that name, and nobody's on the portal, the
 * report and the tax CSV. The load then showed in the investor's Load Report,
 * and its rate in the period's Gross, while no other surface counted it.
 *
 * WHAT IS PROVED HERE
 *   §1  source: the handler calls investorJobRowTest() once and keeps no copy of
 *       the rule (no Owner ID column of its own, no driver-set lookup)
 *   §2  the handler, lifted out of server.js and run (format=json) over a fixture:
 *       an investor's periods list exactly the loads the shared rule gives them,
 *       the "constructor" rows included in no one's; and over a fixture of every
 *       Owner ID spelling crossed with every Driver cell, the handler returns
 *       exactly the rows investorJobRowTest() selects, for two investors
 *   §3  MUTANT: the route's old copy put back. The "constructor" rows reappear,
 *       and the cross-product disagrees with the shared rule on them and nowhere
 *       else
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT:
 * server.js opens SQLite, reads a service-account key and listens on import.
 * Same approach as test-investor-tax-csv.js; every extraction asserts exactly one
 * match, so a rename fails loudly instead of testing nothing.
 *
 * Run: node scripts/test-investor-load-report-ownership.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { csvRows } = require("../lib/csv");

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
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");

const ROUTE = 'app.get("/api/investor/load-report", requireRole("Super Admin", "Investor"), ';
if (SRC.split(ROUTE).length - 1 !== 1) throw new Error("expected the load-report route exactly once");
const OPEN = SRC.indexOf("async (req, res) => {", SRC.indexOf(ROUTE));
const HANDLER = SRC.slice(OPEN, balancedFrom(SRC, SRC.indexOf("{", OPEN)));

// The shared test, as the handler calls it, and the copy the route used to keep
// (d8a4a64, verbatim but for its Owner ID column, which the route resolved on a
// line of its own).
const SHARED_FILTER = "data.filter(investorJobRowTest(headers, investorOwnerId, investorDriverSet))";
const OLD_FILTER = `data.filter((r) => {
				const ownerIdCol = findCol(headers, /^owner.?id$/i);
				if (ownerIdCol) {
					const raw = r[ownerIdCol];
					if (raw !== undefined && raw !== null && String(raw).trim() !== "") return (parseInt(raw) || 0) === investorOwnerId;
				}
				const d = driverCol ? (r[driverCol] || "").trim().toLowerCase() : "";
				return d && investorDriverSet.has(d);
			})`;

const NAMES = [
	"resolvePreviewUser", "findCol", "pickAddressColumn", "moneySheetDate", "periodLabel", "resolveInvestorSplitPct",
	"investorJobRowTest", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName",
];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, extractFn(n)]));

// ------------------------------------------------------------------ fixtures
const HEADERS = ["Load ID", "Driver", "Job Status", "  Payment  ", "Assigned Date", "Truck", "Owner ID"];
// Owner 5's drivers. The set holds "constructor" the way getInvestorDriverSet()
// would from a truck whose assigned_driver was stored with that name.
const SETS = { 5: new Set(["driver a", "constructor"]), 41: new Set(["driver z", "tostring"]) };

function world() {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
	db.exec("CREATE TABLE investors (id INTEGER PRIMARY KEY, user_id INTEGER, full_name TEXT)");
	db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'sa', 'Super Admin'), (5, 'inv5', 'Investor'), (41, 'inv41', 'Investor')").run();
	return db;
}

// Runs the lifted handler (format=json) over `rows` and returns the load ids it
// lists, in the period order it answers, with each period's gross.
async function runHandler(handlerSrc, { session, rows, query = {} }) {
	const deps = {
		db: world(),
		csvRows,
		RFC2822_MONTHS: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
		getJobTrackingCached: async () => ({ headers: HEADERS, data: rows }),
		excludeDroppedLoads: (data) => data,
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [] }),
		getInvestorDriverSet: (userId) => SETS[userId] || new Set(),
		logAudit: () => {},
		resolveCityState: () => "City, ST",
		getWeekRange: () => { throw new Error("the monthly view reads no week"); },
	};
	const names = Object.keys(deps);
	const handler = new Function(...names, `
		${NAMES.map((n) => SOURCES[n]).join("\n")}
		return ${handlerSrc};
	`)(...names.map((n) => deps[n]));
	let status = 200;
	let body = null;
	const res = {
		setHeader() {},
		status(s) { status = s; return this; },
		json(b) { body = b; return this; },
		send(b) { body = b; return this; },
	};
	await handler({ session: { user: session }, query: { period: "monthly", ...query } }, res);
	if (status !== 200) throw new Error(`the handler answered ${status}: ${JSON.stringify(body)}`);
	return {
		ids: body.periods.flatMap((p) => p.loads.map((l) => l.loadId)).sort(),
		gross: body.periods.map((p) => [p.key, p.grossRevenue]),
	};
}
const INVESTOR = { id: 5, username: "inv5", role: "Investor" };
const INVESTOR41 = { id: 41, username: "inv41", role: "Investor" };
const SUPER_ADMIN = { id: 1, username: "sa", role: "Super Admin" };

const row = (id, owner, driver, pay = "100", date = "2026-08-10") => {
	const r = { "Load ID": id, "Job Status": "Delivered", "  Payment  ": pay, "Assigned Date": date, Truck: "" };
	if (owner !== undefined) r["Owner ID"] = owner;
	if (driver !== undefined) r.Driver = driver;
	return r;
};
// ⚠️ THE ORACLE, by hand. Owner 5: L1 (Owner ID 5) and L2 (blank Owner ID, owner
// 5's driver). L3 and L4 have a blank Owner ID and a Driver cell that reads as a
// built-in property name, so they count as unassigned, as on the portal: nobody's.
// L5 is stamped 41 and L6 "0" (a company truck): not owner 5's, though Driver A ran
// them.
const LOADS = [
	row("L1", "5", "Driver A", "1000", "2026-08-10"),
	row("L2", "", "Driver A", "500", "2026-08-12"),
	row("L3", "", "constructor", "700", "2026-08-14"),
	row("L4", " ", " Constructor ", "300", "2026-08-16"),
	row("L5", "41", "Driver A", "900", "2026-08-18"),
	row("L6", "0", "Driver A", "800", "2026-08-20"),
];

// Every Owner ID spelling crossed with every Driver cell, one load each.
const OWNER_CELLS = ["5", "41", "0", "", " ", undefined, "05", " 5 ", "5abc", "abc", "5.9", "-5", "00"];
const DRIVER_CELLS = ["Driver A", " driver a ", "DRIVER A", "Driver Z", "", undefined, "constructor", "Constructor", "toString", " TOSTRING ", "Nobody"];
const CROSS = [];
OWNER_CELLS.forEach((o, i) => DRIVER_CELLS.forEach((d, j) => CROSS.push(row(`X${String(i).padStart(2, "0")}${String(j).padStart(2, "0")}`, o, d))));
function sharedRuleIds(ownerId) {
	const { investorJobRowTest } = new Function(`
		${["findCol", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName", "investorJobRowTest"].map((n) => SOURCES[n]).join("\n")}
		return { investorJobRowTest };
	`)();
	const test = investorJobRowTest(HEADERS, ownerId, SETS[ownerId]);
	return CROSS.filter(test).map((r) => r["Load ID"]).sort();
}

(async () => {
	// ======================================================= §1 source pins
	section("§1 the load report asks the shared rule, and keeps no copy of it");
	{
		const h = stripComments(HANDLER);
		eq(h.split(SHARED_FILTER).length - 1, 1, "the handler filters the investor's rows with investorJobRowTest(), once");
		ok(!/owner\.\?id|hasOwnerIdValue|ownerIdCol|[dD]riverSet\.has\(|parseInt\(raw\)/.test(h), "…and holds no copy of the rule beside it");
	}

	// ============================================== §2 the handler, run
	section("§2 an investor's load report lists exactly the loads the shared rule gives them");
	{
		const inv = await runHandler(HANDLER, { session: INVESTOR, rows: LOADS });
		eq(inv.ids, ["L1", "L2"], "owner 5: L1 (stamped 5) and L2 (blank, their driver); not the \"constructor\" rows, not L5 or L6");
		eq(inv.gross, [["2026-08", 1500]], "…and August's Gross is those two loads' rates");
		const preview = await runHandler(HANDLER, { session: SUPER_ADMIN, rows: LOADS, query: { as_user_id: "5" } });
		eq(preview.ids, ["L1", "L2"], "a Super Admin's preview of owner 5: the same loads");
		const fleet = await runHandler(HANDLER, { session: SUPER_ADMIN, rows: LOADS });
		eq(fleet.ids, ["L1", "L2", "L3", "L4", "L5", "L6"], "the fleet view scopes no owner");

		for (const [who, session, ownerId] of [["owner 5", INVESTOR, 5], ["owner 41", INVESTOR41, 41]]) {
			const got = await runHandler(HANDLER, { session, rows: CROSS });
			const want = sharedRuleIds(ownerId);
			ok(want.length > 0, `${who}: the cross-product holds rows the shared rule gives them (${want.length})`);
			eq(got.ids, want, `${who}: the handler returns exactly the rows investorJobRowTest() selects, of ${CROSS.length}`);
		}
	}

	// ============================================================ §3 mutant
	section("§3 MUTANT: the route's old copy of the rule");
	{
		const old = HANDLER.replace(SHARED_FILTER, OLD_FILTER);
		ok(old !== HANDLER, "the mutant applied");
		const inv = await runHandler(old, { session: INVESTOR, rows: LOADS });
		const caught = JSON.stringify(inv.ids) !== JSON.stringify(["L1", "L2"]);
		ok(caught, "MUTANT caught: the old copy lists a load the shared rule does not give the investor");
		if (caught) mutantsCaught++;
		eq(inv.ids, ["L1", "L2", "L3", "L4"], "…the two \"constructor\" rows, and nothing else");
		eq(inv.gross, [["2026-08", 2500]], "…whose rates reach the period's Gross");
		const got = await runHandler(old, { session: INVESTOR, rows: CROSS });
		const want = sharedRuleIds(5);
		const extra = got.ids.filter((id) => !want.includes(id));
		const missing = want.filter((id) => !got.ids.includes(id));
		ok(extra.length > 0 && missing.length === 0, `…over the cross-product it adds ${extra.length} rows and drops none`);
		const drivers = new Set(extra.map((id) => DRIVER_CELLS[Number(id.slice(3))]));
		eq([...drivers].sort(), ["Constructor", "constructor"], "…each of them a blank-Owner-ID row whose Driver cell is \"constructor\" in some case");
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutant caught)`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
