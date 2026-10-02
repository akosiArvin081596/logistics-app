#!/usr/bin/env node
/**
 * GET /api/investor/tax-csv counts the same loads as GET /api/investor/report and
 * /api/investor, resolves an investor's drivers from the drivers directory,
 * decides which rows are the investor's by the portal's rule, and prices each
 * truck as the report does.
 *
 * THE BUGS (fixed 2026-09-30)
 *   1. "Net Revenue to Date" summed Job Tracking's RAW completed rows. The report
 *      and the portal deduplicate the sheet (deduplicateLoads(): one row per load
 *      id, the most recent copy) and then drop cancelled and soft-deleted loads
 *      (excludeDroppedLoads()); this tax document did neither. A load re-entered
 *      on the sheet counted once per copy, and a soft-deleted load still in a
 *      completed status counted at all. "At-Risk Capital Remaining" is computed
 *      from it and was understated by the same amount.
 *   2. The handler asked batchGet for ONE range, ["Job Tracking"], and then read
 *      valueRanges[1] as the Carrier Database. The Sheets API answers one value
 *      range per range requested (checked against the local non-production sheet:
 *      valueRanges.length was 1), so that read was always undefined, parseSheet()
 *      made it an empty sheet, and getInvestorDriverSet() silently lost its
 *      drivers-directory leg: a blank-Owner-ID load run by a driver that only the
 *      directory ties to the investor's carrier counted nowhere. The handler now
 *      reads the directory the way /api/investor and the report do,
 *      getCarrierDBFromSQLite().
 *   3. The CSV counted a row for an investor when its Owner ID named them OR its
 *      driver was one of theirs. The report and the portal trust a filled-in
 *      Owner ID ("0", a company truck, included) and fall back to the driver only
 *      when it is blank. So a load stamped to another owner, or to a company
 *      truck, counted in the investor's CSV whenever one of their drivers ran it.
 *      The CSV, like the report, now asks investorJobRowTest(), which states the
 *      portal's rule.
 *   4. The CSV priced every truck at the investor config's truck_purchase_price
 *      ($58,000 by default). The report prices each truck at its recorded
 *      trucks.purchase_price ($0 when none is recorded). Both now read
 *      investorTruckPurchase().
 *   5. The outer catch answered err.message, so a failure outside the Sheets read
 *      (a SQLite error, say) put the server's own error text in the response.
 *      Since 2026-09-30 it answers a fixed message, as the report does.
 *
 * AND ONE CHOICE (2026-09-30): a truck with no recorded purchase price. The
 * switch is UNPRICED_TRUCKS in lib/investor-report-options.js. "zero" prints
 * exactly what the CSV printed before (the truck at $0); "not-available", the
 * shipped setting, prints each per-truck line as the average over the priced
 * trucks ("Not recorded" when none has a price), "Not available" for the fleet
 * total and At-Risk Capital while any truck lacks one, and a count row.
 *
 * WHAT IS PROVED HERE
 *   §1  source: the handler deduplicates, then excludes, before the first row is
 *       read; reads the directory through getCarrierDBFromSQLite(); reads no value
 *       range it did not request; hand-rolls no copy of either rule; and the CSV
 *       and the report both ask investorJobRowTest() and investorTruckPurchase(),
 *       with no copy of either beside it
 *   §2  the handler, lifted out of server.js and run against a sheet fixture on
 *       production's real header row, a real SQLite database, and a batchGet stub
 *       that answers like the API: the fleet CSV, two investors' CSVs and a Super
 *       Admin's preview print the hand oracle, the truck figures and At-Risk
 *       Capital included
 *   §3  MUTANTS, each must be caught: the handler without the deduplication,
 *       without the exclusion, reading the carrier database from valueRanges[1]
 *       again, with its old Owner-ID-or-driver rule, with the old config pricing,
 *       and with a helper that reads "0" as blank. With all of the CSV's fixes
 *       reverted, it must print exactly what the CSV printed before them
 *   §4  the helper and the portal's own copies of the rule (GET /api/investor and
 *       computeInvestorMonthlyEarnings(), left as they are) resolve the same
 *       columns and answer every row of one fixture the same, for two investors;
 *       the "0"-as-blank helper mutant must disagree
 *   §5  UNPRICED_TRUCKS: §2's fixture under "zero" is §2's oracle, to the byte of
 *       every truck line; under "not-available" the hand oracle below, with the
 *       count row, and never a $0 for a missing price. Mutant: a CSV that ignores
 *       the switch prints $0 again
 *   §6  the outer catch answers a fixed message (recreated with a database that
 *       throws); mutant: err.message again. The route's limiter is per user and
 *       mounted after requireRole
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT:
 * server.js opens SQLite, reads a service-account key and listens on import.
 * Same approach as test-investor-report-dropped-loads.js; every extraction asserts
 * exactly one match, so a rename fails loudly instead of testing nothing.
 *
 * Run: node scripts/test-investor-tax-csv.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require("../lib/ratecon-load");
const { csvRows } = require("../lib/csv");
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
	return SRC.slice(start, balancedFrom(SRC, body));
}
function extractConst(name) {
	const re = new RegExp(`\\nconst ${name} =[\\s\\S]*?;\\n`, "g");
	const hits = SRC.match(re) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 definition of const ${name} in server.js, found ${hits.length}`);
	return hits[0].trim();
}
function extractDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\)`));
	if (!m) throw new Error(`${table} CREATE TABLE not found in server.js`);
	return m[0];
}
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
function once(haystack, needle, what) {
	const n = haystack.split(needle).length - 1;
	if (n !== 1) throw new Error(`expected ${what} exactly once, found ${n}`);
	return haystack.indexOf(needle);
}
function routeHandler(route) {
	once(SRC, route, route);
	const open = SRC.indexOf("async (req, res) => {", SRC.indexOf(route));
	return SRC.slice(open, balancedFrom(SRC, SRC.indexOf("{", open)));
}

const HANDLER = routeHandler('app.get("/api/investor/tax-csv", requireRole("Super Admin", "Investor"), ');
const REPORT = routeHandler('app.get("/api/investor/report", requireRole("Super Admin", "Investor"), ');

// The statements the fixes add, and what the mutants put back.
const DEDUPE_STMT = "jt.data = deduplicateLoads(jt.data, jt.headers);";
const EXCLUDE_STMT = "jt.data = excludeDroppedLoads(jt.data, jt.headers);";
const CARRIER_STMT = "const cdb = getCarrierDBFromSQLite();";
const CARRIER_BEFORE = "const cdb = parseSheet(rng.data.valueRanges[1]);";
// The ownership test, from where it is built to where it drops a row.
const OWNERSHIP_OPEN = "const belongsToInvestor = isSuperAdmin";
const OWNERSHIP_CLOSE = "if (belongsToInvestor && !belongsToInvestor(r)) return;";
const OWNERSHIP_STMT = HANDLER.slice(once(HANDLER, OWNERSHIP_OPEN, "the ownership test"),
	once(HANDLER, OWNERSHIP_CLOSE, "the ownership drop") + OWNERSHIP_CLOSE.length);
const OWNERSHIP_BEFORE = `let driverSet = null;
			const taxOwnerId = !isSuperAdmin ? user.id : null;
			if (!isSuperAdmin) {
				driverSet = getInvestorDriverSet(user.id, cdb.data, cDriverCol, cCarrierCol);
			}
			const taxOwnerIdCol = findCol(jt.headers, /^owner.?id$/i);
			const jtDriverCol = findCol(jt.headers, /driver/i);
			jt.data.forEach(r => {
				if (driverSet) {
					let match = false;
					if (taxOwnerIdCol && parseInt(r[taxOwnerIdCol]) === taxOwnerId) match = true;
					if (!match && jtDriverCol) {
						const d = (r[jtDriverCol] || "").trim().toLowerCase();
						if (driverSet.has(d)) match = true;
					}
					if (!match) return;
				}`;
const TRUCK_STMT = "const purchase = investorTruckPurchase(isSuperAdmin ? null : user.id);";
const TRUCK_FIGURES_STMT = "const priced = investorReportOptions.truckPriceFigures(purchase, investorReportOptions.UNPRICED_TRUCKS);";
const TRUCK_COUNT_STMT = "const totalTrucks = purchase.trucks.length;";
const TRUCK_BEFORE = `const globalCfg = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all();
		const config = {};
		globalCfg.forEach(r => (config[r.key] = r.value));
		if (!isSuperAdmin) {
			const investorCfg = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(user.id);
			investorCfg.forEach(r => (config[r.key] = r.value));
		}
		const purchasePrice = parseFloat(config.truck_purchase_price || config.purchase_price) || 58000;
		const totalTrucks = isSuperAdmin
			? db.prepare("SELECT COUNT(*) AS cnt FROM trucks").get().cnt
			: db.prepare("SELECT COUNT(*) AS cnt FROM trucks WHERE owner_id = ?").get(user.id).cnt;
		const totalPurchasePrice = purchasePrice * totalTrucks;`;
// With the config pricing back, what the CSV's lines read.
const PRICED_BEFORE = "const priced = { perTruck: purchasePrice, total: totalPurchasePrice, flagged: false, unpricedCount: 0, truckCount: totalTrucks };";
const withoutPricing = (src) => src.replace(TRUCK_STMT, TRUCK_BEFORE).replace(TRUCK_FIGURES_STMT, PRICED_BEFORE).replace(TRUCK_COUNT_STMT, "");
// The helper's Owner ID test, and the mutant that reads "0" as blank.
const HELPER_OWNER_TEST = 'String(raw).trim() !== "";';
const HELPER_ZERO_AS_BLANK = 'String(raw).trim() !== "" && String(raw).trim() !== "0";';

const NAMES = [
	"resolvePreviewUser", "parseSheet", "deduplicateLoads", "findCol",
	"getDeletedLoadIds", "loadKeySet", "excludeDroppedLoads",
	"getCarrierDBFromSQLite", "getInvestorDriverSet", "investorExpenseScopeSql",
	"investorJobRowTest", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName",
	"investorTruckPurchase",
];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, extractFn(n)]));
const CONSTS = ["CANCELED_STATUS_RE", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR"].map(extractConst);

// ------------------------------------------------------------------ fixtures
// Production's real Job Tracking header row ("  Payment  " with its real spaces).
const HEADERS = ["Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status", "Phase of Progress",
	"Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output"];
const CARRIER = "Acme Haulers";
// Driver A is on owner 5's truck. Driver D is tied to owner 5 ONLY by the drivers
// directory (carrier = owner 5's company), the leg the valueRanges[1] read dropped.
// Driver Z runs owner 41's truck and is nobody else's.
const LOADS = [
	{ id: "3001", status: "Delivered", pay: "900", driver: "Driver A", owner: "5" },       // older copy: DROPPED by dedupe
	{ id: "3001", status: "Completed", pay: "$1,000.00", driver: "Driver A", owner: "5" }, // the copy that counts
	{ id: "#3002", status: "Delivered", pay: "2,000", driver: "Driver A", owner: "5" },    // older copy, "#" spelling: DROPPED
	{ id: "3002", status: "Delivered", pay: "2,000", driver: "Driver A", owner: "5" },     // counts
	{ id: "3003", status: "Delivered", pay: "500", driver: "Driver A", owner: "5" },       // soft-deleted: DROPPED
	{ id: "3004", status: "Cancelled", pay: "700", driver: "Driver A", owner: "5" },       // cancelled: never counted
	{ id: "3005", status: "At Shipper", pay: "300", driver: "Driver A", owner: "5" },      // in progress: never counted
	{ id: "3006", status: "Delivered", pay: "400", driver: "Driver D", owner: "" },        // blank Owner ID, directory-leg driver: owner 5's
	{ id: "#3007", status: "POD Received", pay: "250", driver: "Driver A", owner: "5" },   // soft-deleted as "3007": DROPPED
	{ id: "4001", status: "Delivered", pay: "9,000", driver: "Driver Z", owner: "41" },    // older copy: DROPPED
	{ id: "4001", status: "Delivered", pay: "9,000", driver: "Driver Z", owner: "41" },    // counts, owner 41's
	{ id: "3008", status: "Delivered", pay: "600", driver: "Driver A", owner: "41" },      // stamped to owner 41, run by owner 5's driver: owner 41's
	{ id: "3009", status: "Delivered", pay: "800", driver: "Driver A", owner: "0" },       // stamped "0", a company truck: nobody's
	{ id: "3010", status: "Delivered", pay: "150", driver: "Driver A", owner: " " },       // a blank (spaces) Owner ID, owner 5's driver: owner 5's
	{ id: "4002", status: "Delivered", pay: "350", driver: "Driver Z", owner: "5" },       // stamped to owner 5, run by owner 41's driver: owner 5's
];
const DELETED = ["3003", "3007"];

function sheetValues() {
	const col = (h) => HEADERS.indexOf(h);
	return [HEADERS, ...LOADS.map((l) => {
		const row = HEADERS.map(() => "");
		row[col("Load ID")] = l.id;
		row[col("Job Status")] = l.status;
		row[col("  Payment  ")] = l.pay;
		row[col("Driver")] = l.driver;
		row[col("Owner ID")] = l.owner;
		return row;
	})];
}

// ⚠️ THE ORACLE, by hand from the fixture.
//   Live completed revenue — fleet: 3001 1,000 + 3002 2,000 + 3006 400 + 4001 9,000
//   + 3008 600 + 3009 800 + 3010 150 + 4002 350 = 14,300.
//   Owner 5: 3001 + 3002 + 4002 (Owner ID 5) + 3006 (blank, Driver D through the
//   directory) + 3010 (blank, Driver A) = 3,900. Not 3008 (stamped 41) or 3009
//   (stamped 0), though Driver A ran both.
//   Owner 41: 4001 + 3008 (Owner ID 41) = 9,600. Not 4002 (stamped 5), though
//   Driver Z ran it.
//   Expenses (EXPENSE_PNL_FILTER drops the Rejected $200): fleet 100 + 50 = 150,
//   owner 5 100, owner 41 50.
//   Trucks, at each one's recorded price, a truck with none at $0: owner 5's T-1
//   60,000 and T-2 (none), owner 41's T-3 40,000, the company's T-4 (none). The
//   config's $58,000 and owner 5's own $70,000 are read by nothing. Startup
//   $5,000 a truck. "Per truck" is the one truck's price, else the average.
const ORACLE = {
	fleet: { net: 14150, atRisk: 105850, perTruck: 25000, trucks: 4, fleetPrice: 100000, section179: 25000 },
	investor: { net: 3800, atRisk: 66200, perTruck: 30000, trucks: 2, fleetPrice: 60000, section179: 30000 },
	investor41: { net: 9550, atRisk: 35450, perTruck: 40000, trucks: 1, fleetPrice: 40000, section179: 40000 },
};
// What the CSV printed before any of its fixes, on the same fixture: every copy
// of every completed row, the soft-deleted ones included; no Driver D load for
// owner 5 (the directory leg was empty); a row counted for an investor when its
// Owner ID OR its driver was theirs (owner 5 gains 3008, 3009 and the older
// copies; owner 41 gains 4002); and every truck at the config price (fleet and
// owner 41 $58,000, owner 5 $70,000). §3's mutant with every fix reverted must
// reproduce these exactly.
const BEFORE = {
	fleet: { net: 26800, atRisk: 225200, perTruck: 58000, trucks: 4, fleetPrice: 232000, section179: 58000 },
	investor: { net: 8450, atRisk: 141550, perTruck: 70000, trucks: 2, fleetPrice: 140000, section179: 70000 },
	investor41: { net: 18900, atRisk: 44100, perTruck: 58000, trucks: 1, fleetPrice: 58000, section179: 58000 },
};

function world(extraTrucks = null) {
	const db = new Database(":memory:");
	for (const t of ["deleted_loads", "drivers_directory", "carrier_driver_history", "truck_assignments"]) db.exec(extractDdl(t));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, company_name TEXT DEFAULT '')");
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
	db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT, owner_id INTEGER, assigned_driver TEXT DEFAULT '', purchase_price REAL DEFAULT 0)");
	db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY, type TEXT, amount REAL, date TEXT, status TEXT, owner_id INTEGER, driver TEXT, truck_unit TEXT, posted_period TEXT, created_at TEXT)");
	db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (1, 'sa', 'Super Admin', ''), (5, 'inv5', 'Investor', ?), (41, 'inv41', 'Investor', 'Other Co'), (42, 'inv42', 'Investor', 'Third Co')").run(CARRIER);
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'truck_purchase_price', '58000'), (5, 'truck_purchase_price', '70000')").run();
	db.prepare(`INSERT INTO trucks (id, unit_number, status, owner_id, assigned_driver, purchase_price) VALUES
		(1, 'T-1', 'Active', 5, 'Driver A', 60000), (2, 'T-2', 'Active', 5, '', NULL),
		(3, 'T-3', 'Active', 41, 'Driver Z', 40000), (4, 'T-4', 'Active', 0, '', 0)`).run();
	if (extraTrucks) extraTrucks(db);
	db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name) VALUES ('Driver D', ?), ('Driver Z', 'Other Co')").run(CARRIER);
	const exp = db.prepare("INSERT INTO expenses (type, amount, date, status, owner_id, driver, truck_unit) VALUES (?, ?, '2026-08-10', ?, ?, ?, ?)");
	exp.run("Fuel", 100, "Approved", 5, "Driver A", "T-1");
	exp.run("Repair", 200, "Rejected", 5, "Driver A", "T-1");
	exp.run("Toll", 50, null, 41, "Driver Z", "T-3");
	const del = db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, 'fixture')");
	for (const id of DELETED) del.run(id);
	return db;
}

// Runs the lifted handler with the module-scope names server.js would supply.
// The batchGet stub answers like the Sheets API: one value range per range
// requested, so a request for ["Job Tracking"] has no valueRanges[1].
// `unpriced` is the UNPRICED_TRUCKS setting the handler is given. §2–§4 check the
// figures the CSV printed before that choice existed, so they run it at "zero".
function lift(handlerSrc, deps, sources = SOURCES) {
	const names = Object.keys(deps);
	return new Function(...names, `
		${CONSTS.join("\n")}
		${NAMES.map((n) => sources[n]).join("\n")}
		return ${handlerSrc};
	`)(...names.map((n) => deps[n]));
}
function fakeRes() {
	const out = { status: 200, body: null };
	out.res = {
		setHeader() {},
		status(s) { out.status = s; return this; },
		json(b) { out.body = b; return this; },
		send(b) { out.body = b; return this; },
	};
	return out;
}
// The audit rows the last runHandler() call wrote: { action, entity, entityId }.
let lastAudits = [];
async function runHandler(handlerSrc, { session, query = {}, sources = SOURCES, unpriced = "zero", extraTrucks = null }) {
	const db = world(extraTrucks);
	const requested = [];
	lastAudits = [];
	const deps = {
		db,
		normalizeLoadId,
		csvRows,
		SPREADSHEET_ID: "fixture-sheet",
		getSheets: async () => ({ spreadsheets: { values: {
			batchGet: async ({ ranges }) => {
				requested.push(...ranges);
				return { data: { valueRanges: ranges.map((r) => ({ range: r, values: r === "Job Tracking" ? sheetValues() : [] })) } };
			},
		} } }),
		getInvestorDriverMonthWindows: () => new Map(),
		investorReportOptions: { ...investorReportOptions, UNPRICED_TRUCKS: unpriced },
		logAudit: (req, action, entity, entityId) => lastAudits.push({ action, entity, entityId }),
	};
	const handler = lift(handlerSrc, deps, sources);
	const out = fakeRes();
	await handler({ session: { user: session }, query }, out.res);
	const { status, body } = out;
	if (status !== 200 || typeof body !== "string") throw new Error(`the handler answered ${status}: ${JSON.stringify(body)}`);
	const lines = body.split(/\r?\n/);
	// Every cell is quoted (lib/csv.js); the value of a "label","value" line, as text.
	const cell = (label) => {
		const line = lines.find((l) => l.startsWith(`"${label}",`));
		return line === undefined ? undefined : line.slice(label.length + 4, -1).replace(/""/g, "\"");
	};
	const money = (label) => {
		const text = cell(label);
		if (text === undefined) throw new Error(`no "${label}" line in the CSV`);
		return /^\$?[\d,]+$/.test(text) ? Number(text.replace(/[$,]/g, "")) : text;
	};
	return {
		net: money("Net Revenue to Date"),
		atRisk: money("At-Risk Capital Remaining"),
		perTruck: money("Purchase Price (per truck)"),
		trucks: money("Total Trucks"),
		fleetPrice: money("Total Fleet Purchase Price"),
		section179: money("Section 179 Deduction (100%)"),
		depreciation: money("Annual Depreciation (Year 1)"),
		unpricedRow: cell(investorReportOptions.UNPRICED_TEXT.CSV_COUNT_LABEL),
		labels: lines.map((l) => (l.match(/^"((?:[^"]|"")*)"/) || [])[1]).filter(Boolean),
		requested,
	};
}
const INVESTOR = { id: 5, username: "inv5", role: "Investor" };
const INVESTOR41 = { id: 41, username: "inv41", role: "Investor" };
const SUPER_ADMIN = { id: 1, username: "sa", role: "Super Admin" };
const figures = ({ net, atRisk, perTruck, trucks, fleetPrice, section179 }) => ({ net, atRisk, perTruck, trucks, fleetPrice, section179 });
async function allThree(src, sources) {
	return {
		fleet: figures(await runHandler(src, { session: SUPER_ADMIN, sources })),
		investor: figures(await runHandler(src, { session: INVESTOR, sources })),
		investor41: figures(await runHandler(src, { session: INVESTOR41, sources })),
	};
}

// ------------------------------------------------ the portal's copies (§4)
// Each copy is the arrow GET /api/investor and the payout ledger's row read
// (ledgerLoadRows(), behind computeInvestorMonthlyEarnings()) pass to filter(),
// lifted as it ships, with the columns it resolves.
function portalCopy(src, what) {
	const at = once(src, "const filteredJobData = investorDriverSet", `${what}'s filteredJobData`);
	const arrow = src.indexOf(".filter(r => {", at);
	if (arrow < 0) throw new Error(`${what}: no .filter(r => { after filteredJobData`);
	const open = src.indexOf("{", arrow);
	const body = src.slice(arrow + ".filter(".length, balancedFrom(src, open));
	const col = (name) => {
		const m = src.match(new RegExp(`const ${name} = findCol\\([\\w.]+, (/[^\\n]*?/i)\\);`));
		if (!m) throw new Error(`${what}: no const ${name} = findCol(...)`);
		return m[1];
	};
	return { what, body, ownerRe: col("ownerIdCol"), driverRe: col("driverCol") };
}
const PORTAL_COPIES = [
	portalCopy(routeHandler('app.get("/api/investor", requireRole("Super Admin", "Investor"), '), "GET /api/investor"),
	portalCopy(extractFn("ledgerLoadRows"), "ledgerLoadRows() (computeInvestorMonthlyEarnings())"),
];
const regexOf = (literal) => new Function(`return ${literal};`)();
const helperCol = (name) => {
	const m = SOURCES.investorJobRowTest.match(new RegExp(`const ${name} = findCol\\(headers, (/[^\\n]*?/i)\\);`));
	if (!m) throw new Error(`investorJobRowTest(): no const ${name} = findCol(headers, ...)`);
	return m[1];
};
function libFns(sources) {
	return new Function(`
		${["findCol", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName", "investorJobRowTest"].map((n) => sources[n]).join("\n")}
		return { findCol, driverNameForTotals, investorJobRowTest };
	`)();
}
// Every Owner ID spelling and Driver cell worth a question, crossed. The sets hold
// a built-in property name so a copy that skipped driverNameForTotals() would show.
const OWNER_CELLS = ["5", "41", "0", "", " ", undefined, "05", " 5 ", "5abc", "abc", "5.9", "-5", "00"];
const DRIVER_CELLS = ["Driver A", " driver a ", "DRIVER A", "Driver Z", "Driver  A", "", undefined, "constructor", "toString", "Nobody"];
const SETS = { 5: new Set(["driver a", "constructor"]), 41: new Set(["driver z", "tostring"]) };
function agreement(sources) {
	const { findCol, driverNameForTotals, investorJobRowTest } = libFns(sources);
	const headerSets = [["Load ID", "Driver", "Owner ID"], ["Load ID", "Driver"], ["Load ID", "Owner ID"]];
	const disagreements = [];
	let checked = 0;
	for (const headers of headerSets) {
		const rows = [];
		for (const o of OWNER_CELLS) for (const d of DRIVER_CELLS) {
			const r = { "Load ID": "1" };
			if (headers.includes("Owner ID") && o !== undefined) r["Owner ID"] = o;
			if (headers.includes("Driver") && d !== undefined) r.Driver = d;
			rows.push(r);
		}
		for (const ownerId of [5, 41]) {
			const helper = investorJobRowTest(headers, ownerId, SETS[ownerId]);
			for (const copy of PORTAL_COPIES) {
				const test = new Function("ownerIdCol", "driverCol", "investorOwnerId", "investorDriverSet", "driverNameForTotals",
					`return (${copy.body});`)(findCol(headers, regexOf(copy.ownerRe)), findCol(headers, regexOf(copy.driverRe)), ownerId, SETS[ownerId], driverNameForTotals);
				for (const r of rows) {
					checked++;
					if (Boolean(helper(r)) !== Boolean(test(r))) disagreements.push(`${copy.what}, owner ${ownerId}, ${JSON.stringify(r)}`);
				}
			}
		}
	}
	return { checked, disagreements };
}

(async () => {
	// ======================================================= §1 source pins
	section("§1 the tax CSV reads live loads, the drivers directory, the portal's ownership rule and recorded truck prices");
	{
		const h = stripComments(HANDLER);
		eq(h.split(DEDUPE_STMT).length - 1, 1, "the handler runs deduplicateLoads() once, on its own rows");
		eq(h.split(EXCLUDE_STMT).length - 1, 1, "…and excludeDroppedLoads() once");
		const dedupe = h.indexOf(DEDUPE_STMT);
		const exclude = h.indexOf(EXCLUDE_STMT);
		const firstRead = h.indexOf("jt.data.forEach");
		ok(dedupe >= 0 && exclude > dedupe, "…deduplicate first, then exclude: the order the report and /api/investor use");
		ok(exclude >= 0 && firstRead > exclude, "…both before the first row is read");
		ok(!/CANCELED_STATUS_RE|deleted_loads|getDeletedLoadIds|lastIndex|cancel/i.test(h), "the handler hand-rolls no copy of either rule");
		eq(h.split(CARRIER_STMT).length - 1, 1, "the drivers directory comes from getCarrierDBFromSQLite(), as in /api/investor and the report");
		ok(!/valueRanges\[[1-9]\]/.test(h), "the handler reads no value range beyond the one it requests");

		const r = stripComments(REPORT);
		for (const [name, src] of [["the tax CSV", h], ["the report", r]]) {
			eq((src.match(/\binvestorJobRowTest\(/g) || []).length, 1, `${name} decides whose rows are the investor's with investorJobRowTest(), once`);
			ok(!/owner\.\?id|hasOwnerIdValue|[dD]riverSet\.has\(|parseInt\(r\[/.test(src), `…and holds no copy of the rule beside it (${name})`);
			eq((src.match(/\binvestorTruckPurchase\(/g) || []).length, 1, `${name} prices its trucks with investorTruckPurchase(), once`);
			ok(!/purchase_price|investor_config[^\n]*truck|58000|58,000/.test(src), `…and prices no truck itself (${name})`);
		}
		ok(!/investor_config/.test(h), "the tax CSV reads no investor config at all: nothing in it is configured");
		const helper = stripComments(SOURCES.investorTruckPurchase);
		ok(/Number\(t\.purchase_price\)/.test(helper) && /p > 0/.test(helper) && !/config|58000/.test(helper),
			"investorTruckPurchase() reads each truck's recorded price (recorded when > 0), and no config");
		eq(h.split(TRUCK_FIGURES_STMT).length - 1, 1, "the CSV asks truckPriceFigures() under UNPRICED_TRUCKS what to print for the prices");
		ok(/\[CSV_COUNT_LABEL, priced\.unpricedCount\]/.test(h) && /priced\.flagged/.test(h), "…and adds the count row only when it is flagged");
	}

	// ================================================ §2 the hand oracle
	section("§2 the CSV counts each live load once, for its owner, and prices each truck as recorded (hand oracle)");
	{
		const fleet = await runHandler(HANDLER, { session: SUPER_ADMIN });
		eq(figures(fleet), ORACLE.fleet, "the fleet CSV: Net Revenue to Date, At-Risk Capital Remaining and the truck lines");
		eq(fleet.requested, ["Job Tracking"], "…and it asks the sheet for Job Tracking alone");
		const inv = await runHandler(HANDLER, { session: INVESTOR });
		eq(figures(inv), ORACLE.investor,
			"owner 5's CSV: its blank-Owner-ID rows by driver (the directory leg's included), no row stamped 41 or 0, its trucks at their recorded prices");
		const preview = await runHandler(HANDLER, { session: SUPER_ADMIN, query: { as_user_id: "5" } });
		eq(figures(preview), ORACLE.investor, "a Super Admin's preview of owner 5: the same figures");
		eq(lastAudits, [{ action: "investor_preview_tax_csv", entity: "investor", entityId: 5 }], "a Super Admin's preview download writes one audit row naming the investor");
		const inv41 = await runHandler(HANDLER, { session: INVESTOR41 });
		eq(lastAudits, [], "an investor's own download writes no preview audit row");
		eq(figures(inv41), ORACLE.investor41, "owner 41's CSV: the row stamped 41 that owner 5's driver ran, not the row stamped 5 that its own driver ran");
	}

	// ============================================================ §3 mutants
	section("§3 MUTANTS");
	{
		const nets = (x) => [x.fleet.net, x.investor.net, x.investor41.net];
		const mutants = [
			// The older copies of 3001, 3002 and 4001 back in: fleet 26,200 − 150,
			// owner 5 6,800 − 100, owner 41 18,600 − 50.
			{ name: "no deduplication", src: HANDLER.replace(DEDUPE_STMT, ""), nets: [26050, 6700, 18550] },
			// The soft-deleted 3003 and #3007 back in: fleet 15,050 − 150, owner 5 4,650 − 100.
			{ name: "no exclusion", src: HANDLER.replace(EXCLUDE_STMT, ""), nets: [14900, 4550, 9550] },
			// Driver D's 3006 out of owner 5's CSV (the fleet CSV scopes no driver): 3,500 − 100.
			{ name: "the old carrier read (valueRanges[1])", src: HANDLER.replace(CARRIER_STMT, CARRIER_BEFORE), nets: [14150, 3400, 9550] },
			// Owner ID OR driver: owner 5 gains 3008 (stamped 41) and 3009 (stamped 0),
			// 5,300 − 100; owner 41 gains 4002 (stamped 5), 9,950 − 50.
			{ name: "the old Owner-ID-or-driver rule", src: HANDLER.replace(OWNERSHIP_STMT, OWNERSHIP_BEFORE), nets: [14150, 5200, 9900] },
			// "0" read as blank: 3009 falls back to Driver A, owner 5's: 4,700 − 100.
			{ name: "a helper that reads \"0\" as blank", src: HANDLER, nets: [14150, 4600, 9550],
				sources: { ...SOURCES, investorJobRowTest: SOURCES.investorJobRowTest.replace(HELPER_OWNER_TEST, HELPER_ZERO_AS_BLANK) } },
		];
		for (const m of mutants) {
			ok(m.src !== HANDLER || (m.sources && m.sources.investorJobRowTest !== SOURCES.investorJobRowTest), `the "${m.name}" mutant applied`);
			const got = await allThree(m.src, m.sources);
			const caught = JSON.stringify(nets(got)) !== JSON.stringify(nets(ORACLE));
			ok(caught, `MUTANT caught: ${m.name}`);
			if (caught) mutantsCaught++;
			eq(nets(got), m.nets, `…it prints the figures that step alone was keeping out (${m.name})`);
		}

		// The old config pricing: every truck at $58,000, owner 5's at its own
		// $70,000. No revenue line moves; At-Risk Capital does.
		const pricing = withoutPricing(HANDLER);
		ok(pricing !== HANDLER, "the \"old config pricing\" mutant applied");
		const priced = await allThree(pricing);
		const caught = JSON.stringify(priced) !== JSON.stringify(ORACLE);
		ok(caught, "MUTANT caught: the old config pricing");
		if (caught) mutantsCaught++;
		eq([priced.fleet.atRisk, priced.investor.atRisk, priced.investor41.atRisk], [237850, 146200, 53450],
			"…At-Risk Capital at $58,000 / $70,000 a truck (fleet 252,000 − 14,150; owner 5 150,000 − 3,800; owner 41 63,000 − 9,550)");
		eq(nets(priced), nets(ORACLE), "…and no revenue figure moves");

		const before = withoutPricing(HANDLER).replace(DEDUPE_STMT, "").replace(EXCLUDE_STMT, "").replace(CARRIER_STMT, CARRIER_BEFORE)
			.replace(OWNERSHIP_STMT, OWNERSHIP_BEFORE);
		eq(await allThree(before), BEFORE, "every fix reverted: exactly what the CSV printed before them (fleet, owner 5, owner 41)");
	}

	// ======================================== §4 the helper agrees with the portal
	section("§4 investorJobRowTest() and the portal's own copies of the rule agree");
	{
		for (const copy of PORTAL_COPIES) {
			eq([copy.ownerRe, copy.driverRe], [helperCol("ownerIdCol"), helperCol("driverCol")],
				`${copy.what} resolves the Owner ID and Driver columns with the helper's regexes`);
		}
		const { checked, disagreements } = agreement(SOURCES);
		ok(checked === 3 * 2 * PORTAL_COPIES.length * OWNER_CELLS.length * DRIVER_CELLS.length, `every row was asked (${checked})`);
		eq(disagreements.slice(0, 5), [], `the helper and both portal copies answer all ${checked} questions the same`);
		const mutant = agreement({ ...SOURCES, investorJobRowTest: SOURCES.investorJobRowTest.replace(HELPER_OWNER_TEST, HELPER_ZERO_AS_BLANK) });
		const caught = mutant.disagreements.length > 0;
		ok(caught, "MUTANT caught: a helper that reads \"0\" as blank disagrees with the portal");
		if (caught) mutantsCaught++;
		ok(mutant.disagreements.every((d) => /"Owner ID":"0"/.test(d)), "…on the \"0\" rows and nowhere else");
	}

	// ============================================== §5 trucks with no price
	section("§5 UNPRICED_TRUCKS: \"zero\" is the CSV as it was; \"not-available\" never prints $0 for a missing price");
	{
		// Owner 42 has one truck and no price for it. Added only where it is asked
		// for, so the fleet figures above keep their four trucks.
		const inv42Truck = (db) => db.prepare("INSERT INTO trucks (id, unit_number, status, owner_id, assigned_driver, purchase_price) VALUES (5, 'T-5', 'Active', 42, '', 0)").run();
		const INVESTOR42 = { id: 42, username: "inv42", role: "Investor" };
		const view = (x) => ({ ...figures(x), depreciation: x.depreciation, unpricedRow: x.unpricedRow });
		// The rows the CSV printed before the choice, in order (d8a4a64).
		const LABELS_BEFORE = ["LogisX Tax Shield Summary", "Generated", "Investor", "Field", "Purchase Price (per truck)", "Total Trucks",
			"Total Fleet Purchase Price", "Startup Expenses (est. $5,000/truck)", "Section 179 Deduction (100%)", "Annual Depreciation (Year 1)",
			"Write-Off Percentage", "Net Revenue to Date", "At-Risk Capital Remaining", "Note", "Disclaimer"];

		// "zero": §2's oracle, the same rows, and no count row.
		for (const [who, session, oracle] of [["fleet", SUPER_ADMIN, ORACLE.fleet], ["owner 5", INVESTOR, ORACLE.investor], ["owner 41", INVESTOR41, ORACLE.investor41]]) {
			const z = await runHandler(HANDLER, { session, unpriced: "zero" });
			eq(view(z), { ...oracle, depreciation: oracle.section179, unpricedRow: undefined }, `zero, ${who}: the figures before the choice, a missing price at $0`);
			eq(z.labels, LABELS_BEFORE, `zero, ${who}: the same rows as before, no count row`);
		}
		const z42 = await runHandler(HANDLER, { session: INVESTOR42, unpriced: "zero", extraTrucks: inv42Truck });
		eq(view(z42), { net: 0, atRisk: 5000, perTruck: 0, trucks: 1, fleetPrice: 0, section179: 0, depreciation: 0, unpricedRow: undefined },
			"zero, owner 42 (one truck, no price): $0 throughout, as before");

		// "not-available", the shipped setting. Hand oracle: the fleet's priced trucks
		// are T-1 60,000 and T-3 40,000 (T-2 and T-4 have none), so per truck 50,000;
		// owner 5's only priced truck is T-1 (T-2 has none); owner 41's T-3 is priced,
		// so nothing is missing there; owner 42's only truck has none.
		const NR = investorReportOptions.UNPRICED_TEXT.NOT_RECORDED;
		const NA = investorReportOptions.UNPRICED_TEXT.NOT_AVAILABLE;
		const NOT_AVAILABLE_ORACLE = {
			fleet: { net: 14150, atRisk: NA, perTruck: 50000, trucks: 4, fleetPrice: NA, section179: 50000, depreciation: 50000, unpricedRow: "2" },
			investor: { net: 3800, atRisk: NA, perTruck: 60000, trucks: 2, fleetPrice: NA, section179: 60000, depreciation: 60000, unpricedRow: "1" },
			investor41: { net: 9550, atRisk: 35450, perTruck: 40000, trucks: 1, fleetPrice: 40000, section179: 40000, depreciation: 40000, unpricedRow: undefined },
			investor42: { net: 0, atRisk: NA, perTruck: NR, trucks: 1, fleetPrice: NA, section179: NR, depreciation: NR, unpricedRow: "1" },
		};
		const na = {
			fleet: view(await runHandler(HANDLER, { session: SUPER_ADMIN, unpriced: "not-available" })),
			investor: view(await runHandler(HANDLER, { session: INVESTOR, unpriced: "not-available" })),
			investor41: view(await runHandler(HANDLER, { session: INVESTOR41, unpriced: "not-available" })),
			investor42: view(await runHandler(HANDLER, { session: INVESTOR42, unpriced: "not-available", extraTrucks: inv42Truck })),
		};
		for (const who of Object.keys(NOT_AVAILABLE_ORACLE)) eq(na[who], NOT_AVAILABLE_ORACLE[who], `not-available, ${who}: the hand oracle`);
		const nf = await runHandler(HANDLER, { session: INVESTOR, unpriced: "not-available" });
		eq(nf.labels.slice(4, 8), ["Purchase Price (per truck)", "Total Trucks", investorReportOptions.UNPRICED_TEXT.CSV_COUNT_LABEL, "Total Fleet Purchase Price"],
			"not-available: the count row sits under Total Trucks");
		ok(Object.values(na).every((x) => x.perTruck !== 0 && x.section179 !== 0 && x.depreciation !== 0 && x.fleetPrice !== 0),
			"not-available: no truck line is a silent $0");

		// MUTANT: a CSV that ignores the switch (every truck line at the "zero" figures).
		const ignores = HANDLER.replace(TRUCK_FIGURES_STMT, "const priced = investorReportOptions.truckPriceFigures(purchase, \"zero\");");
		ok(ignores !== HANDLER, "the \"ignores the switch\" mutant applied");
		const m = view(await runHandler(ignores, { session: INVESTOR42, unpriced: "not-available", extraTrucks: inv42Truck }));
		const caught = JSON.stringify(m) !== JSON.stringify(NOT_AVAILABLE_ORACLE.investor42) && m.perTruck === 0;
		ok(caught, "MUTANT caught: a CSV that ignores UNPRICED_TRUCKS prints owner 42's unpriced truck at $0");
		if (caught) mutantsCaught++;
	}

	// ======================================================= §6 errors, limit
	section("§6 an unexpected failure answers a fixed message; the route is rate-limited per user");
	{
		const ROUTE_LIMITED = 'app.get("/api/investor/tax-csv", requireRole("Super Admin", "Investor"), investorTaxCsvLimiter, async (req, res) => {';
		eq(SRC.split(ROUTE_LIMITED).length - 1, 1, "the per-user limiter is mounted after requireRole");

		// A database that fails the way a schema drift would, outside the Sheets read.
		const SECRETISH = "no such column: t.purchase_price_fixture";
		const failing = async (src) => {
			const db = world();
			const deps = {
				db: { prepare: (sql) => { if (/FROM trucks/.test(sql)) throw new Error(SECRETISH); return db.prepare(sql); } },
				normalizeLoadId, csvRows, SPREADSHEET_ID: "fixture-sheet",
				getSheets: async () => { throw new Error("the sheet is not reached"); },
				getInvestorDriverMonthWindows: () => new Map(),
				investorReportOptions,
				console: { error() {}, log() {}, warn() {} },
			};
			const out = fakeRes();
			await lift(src, deps)({ session: { user: INVESTOR }, query: {} }, out.res);
			return out;
		};
		const r = await failing(HANDLER);
		eq([r.status, r.body], [500, { error: "Failed to generate tax document" }], "a failure outside the Sheets read: 500 with a fixed message");
		ok(!JSON.stringify(r.body).includes("purchase_price"), "…and none of the error's own text");
		const CATCH_REPLY = 'res.status(500).json({ error: "Failed to generate tax document" });';
		const leaky = HANDLER.replace(CATCH_REPLY, "res.status(500).json({ error: err.message });");
		ok(leaky !== HANDLER, "the \"err.message\" mutant applied");
		const lr = await failing(leaky);
		const caught = lr.status === 500 && JSON.stringify(lr.body).includes(SECRETISH);
		ok(caught, "MUTANT caught: the catch answering err.message puts the database's error text in the response");
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
