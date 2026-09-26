#!/usr/bin/env node
/**
 * The truck lookups behind the money stamps find a driver's truck across
 * spacing as well as case, and never hand one driver's truck to another
 * account's name.
 *
 * POST /api/expenses stamps an expense with its driver's truck, owner and ELD
 * vehicle; POST /api/dispatch and /api/dispatch/reassign stamp a load's Truck
 * and Owner ID. Those decide whose P&L the money lands on, and a miss stamps
 * Owner ID 0, which moves a load's revenue to the company. They matched the
 * truck with LOWER(assigned_driver) = LOWER(?), which folds case but not
 * spacing, so a truck stored as "Shorn  King" was missed for the driver
 * "Shorn King". They now ask findTruckForDriverStamp(): findTruckForDriver()
 * (case aside, else through normalizeDriverName()), then, for the dispatch
 * routes, the active truck_assignments row found the same two ways. A spacing
 * match counts only while no other account holds the name under another
 * spelling (driverNameHeldByOtherSpelling()); otherwise that step is no match,
 * as before. assignDriverToTruck() releases the driver's other truck and
 * assignment rows the same way, and the public tracker shows the unit the same
 * lookup finds. The driver's open carrier pairing (carrier_driver_history,
 * getInvestorDriverSet() leg 3) is kept by one helper, syncOpenCarrierPairing(),
 * which both of its writers call: assignDriverToTruck() and
 * syncCarrierDriverHistory() (POST and PUT /api/drivers-directory). A pairing
 * stored under a spacing variant is closed the same way when the carrier
 * changes.
 *
 *   §1 the helpers on their own: findTruckForDriver()'s added fields,
 *      findActiveAssignmentTruckForDriver(), driverNameHeldByOtherSpelling()
 *      and findTruckForDriverStamp().
 *   §2 POST /api/expenses, lifted whole and run against a real database.
 *   §3 POST /api/dispatch and /api/dispatch/reassign, lifted whole, against a
 *      real database and a fake sheet: the Truck and Owner ID cells written.
 *   §4 assignDriverToTruck(): the spacing-variant truck and assignment released.
 *   §4b assignDriverToTruck(): the open carrier pairing stored under a spacing
 *      variant closed when the carrier changes, under the same guard.
 *   §4c syncCarrierDriverHistory(): the same, through the same helper, and a
 *      single case-aside open row handled exactly as by the case-only copy the
 *      helper replaced.
 *   §5 the wiring: each stamp and the tracker ask the helper, with no
 *      case-only lookup of their own; both pairing writers ask
 *      syncOpenCarrierPairing(), the only code that opens or closes a pairing.
 *   §6 the mutants: each stamp back to case-only, the guard removed, the
 *      guard's own-spelling exception dropped, assignDriverToTruck()'s pairing
 *      handed a case-only answer, and the pairing helper's spacing step removed
 *      (run through each writer, and each must catch it).
 *
 *   node scripts/test-truck-stamp-spacing.js     # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run under the .nvmrc Node`);
	process.exit(1);
}
const receiptDuplicates = require(path.join(ROOT, "lib", "receipt-duplicates"));
const { getStateFromCoords } = require(path.join(ROOT, "lib", "ifta-states"));

// ─────────────────────────────────────────────────────────────── assertions
let pass = 0, fail = 0;
const failures = [];
// Sections collect into a list, so §6 can run them against a mutant and count
// what they catch; record() tallies a list.
function collector() {
	const results = [];
	const t = (name, actual, expected) => {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		results.push({ ok: a === e, name, a, e });
	};
	return { results, t };
}
function record(results) {
	for (const r of results) {
		if (r.ok) { pass++; continue; }
		fail++;
		failures.push(`${r.name}\n     expected ${r.e}\n     actual   ${r.a}`);
		console.log(`  FAIL  ${r.name}\n          expected ${r.e}\n          actual   ${r.a}`);
	}
}
function check(name, actual, expected) { record([{ ok: JSON.stringify(actual) === JSON.stringify(expected), name, a: JSON.stringify(actual), e: JSON.stringify(expected) }]); }
function section(title) { console.log(`\n${title}`); }

// ─────────────────────────────────────────────────────────────── extraction
// A top-level declaration, from its line to the first "}" in column 0.
function extract(name) {
	for (const prefix of ["function ", "async function "]) {
		const needle = `\n${prefix}${name}(`;
		const hits = SRC.split(needle).length - 1;
		if (hits === 0) continue;
		if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
		const start = SRC.indexOf(needle) + 1;
		const end = SRC.indexOf("\n}\n", start);
		if (end < 0) throw new Error(`could not find the top-level end of ${name}()`);
		const body = SRC.slice(start, end + 3);
		if (/\n(async )?function /.test(body)) throw new Error(`extraction of ${name}() spanned more than one declaration`);
		return body;
	}
	throw new Error(`no definition of ${name}() in server.js`);
}
// A route registration, from its line to the first column-0 "});".
function extractRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", start);
	if (end < 0) throw new Error(`no column-0 "});" after ${head}`);
	return SRC.slice(start, end + "\n});".length);
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 80)}`);
	return src.replace(from, () => to);
}
const decomment = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const HELPERS = ["normalizeDriverName", "findDriverNameClashes", "driverNameHeldByOtherAccount", "driverNameHeldByOtherSpelling",
	"findTruckForDriver", "findActiveAssignmentTruckForDriver", "findTruckForDriverStamp", "assignDriverToTruck",
	"syncOpenCarrierPairing", "syncCarrierDriverHistory"];
const HELPER_SRC = Object.fromEntries(HELPERS.map((n) => [n, extract(n)]));
function buildHelpers(db, over = {}) {
	const s = { ...HELPER_SRC, ...over };
	return new Function("db", `"use strict";\n${HELPERS.map((n) => s[n]).join("\n")}\nreturn { ${HELPERS.join(", ")} };`)(db);
}
const QUIET = { error() {}, log() {}, warn() {} };
const H = new Function(`
${extract("parseSheet")}
${extract("findCol")}
${extract("formulaCellRefusal")}
${extract("colLetter")}
${extract("sheetRowToObject")}
${extract("resolveSheetDataRow")}
${extract("sanitizeReceiptDetails")}
return { formulaCellRefusal, colLetter, sheetRowToObject, resolveSheetDataRow, sanitizeReceiptDetails };
`)();
const RESOLVE_ACTOR_SRC = extract("resolveDriverActor");
const readJobTrackingSnapshot = new Function("SPREADSHEET_ID", "console",
	`${extract("readJobTrackingSnapshot")}\nreturn readJobTrackingSnapshot;`)("sheet-under-test", QUIET);

const HEADS = {
	expense: 'app.post("/api/expenses", requireAuth, driverWriteLimiter, async (req, res) => {',
	dispatch: 'app.post("/api/dispatch", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	reassign: 'app.post("/api/dispatch/reassign", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	track: 'app.get("/api/public/track/:loadId", trackPublicLimiter, async (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, extractRoute(h)]));

// ─────────────────────────────────────────────────────────────── fixtures
const DDL = [
	"CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, role TEXT, driver_name TEXT DEFAULT '', company_name TEXT DEFAULT '')",
	`CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '',
		owner_id INTEGER DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '', photo TEXT DEFAULT '')`,
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT)",
	`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, driver TEXT, load_id TEXT, type TEXT, amount REAL,
		description TEXT, date TEXT, photo_data TEXT, gallons REAL, odometer REAL, owner_id INTEGER, truck_unit TEXT,
		location_city TEXT, location_state TEXT, vendor TEXT, vendor_normalized TEXT, location_lat REAL, location_lng REAL,
		location_source TEXT, receipt_hash TEXT DEFAULT '', receipt_details TEXT DEFAULT '', posted_period TEXT DEFAULT '', status TEXT DEFAULT '')`,
	`CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT, latitude REAL, longitude REAL,
		location_date_ms INTEGER, dropped_reason TEXT DEFAULT '')`,
	"CREATE TABLE load_responses (load_id TEXT, driver_name TEXT)",
];
// accounts: [id, driver_name]; trucks: [id, unit, assigned_driver, owner_id, vehicle];
// assignments: [truck_id, driver_name, start_date]; investors: [id, company_name]
// (a truck owner's company is its carrier); pairings: carrier_driver_history
// rows as [carrier_name, driver_name, ended_at], open when ended_at is null.
function makeDb({ accounts = [], trucks = [], assignments = [], investors = [], pairings = [] } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const u = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, 'Driver', ?)");
	for (const [id, name] of accounts) u.run(id, `LogisX-${1000 + id}`, name);
	const inv = db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (?, ?, 'Investor', ?)");
	for (const [id, company] of investors) inv.run(id, `carrier${id}`, company);
	const t = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, owner_id, routemate_vehicle_id) VALUES (?, ?, ?, ?, ?)");
	for (const [id, unit, driver, owner = 0, vehicle = ""] of trucks) t.run(id, unit, driver, owner, vehicle);
	const a = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, ?)");
	for (const [truckId, name, start] of assignments) a.run(truckId, name, start);
	const p = db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at) VALUES (?, ?, '2026-05-01T12:00:00.000Z', ?)");
	for (const [carrier, name, ended = null] of pairings) p.run(carrier, name, ended);
	return db;
}
const SK = [2, "Shorn King"];
const DK = [3, "Deshorn King"];
// A second account naming the same driver in another spelling (a legacy row).
const SK_OTHER = [4, "Shorn   King"];
// Shorn King's truck, stored with a doubled space, and Deshorn King's.
const T101 = [1, "101", "Shorn  King", 5, "RM-101"];
const T205 = [2, "205", "Deshorn King", 7, "RM-205"];
const A101 = [1, "Shorn  King", "2026-09-01T12:00:00.000Z"];
const A205 = [2, "Deshorn King", "2026-09-01T12:00:00.000Z"];
const withTruck = (base, over) => { const r = base.slice(); for (const [i, v] of Object.entries(over)) r[i] = v; return r; };

// ─────────────────────────────────────────────────────────────── §1 helpers
function helperSection(over = {}) {
	const { results, t } = collector();
	const brief = (r) => (r ? [r.id, r.unit_number, r.owner_id, r.routemate_vehicle_id, r.matchedBy] : null);
	{
		const db = makeDb({ accounts: [SK, DK], trucks: [T101, T205] });
		const m = buildHelpers(db, over);
		t("findTruckForDriver(), a spacing variant: the truck with its owner and ELD vehicle, stored spelling, matchedBy normalized",
			[brief(m.findTruckForDriver("Shorn King")), (m.findTruckForDriver("Shorn King") || {}).assigned_driver], [[1, "101", 5, "RM-101", "normalized"], "Shorn  King"]);
		t("findTruckForDriver(), case aside: the same fields, matchedBy case",
			brief(m.findTruckForDriver("DESHORN KING")), [2, "205", 7, "RM-205", "case"]);
	}
	{
		// The active assignment, found the same two ways, the newest first.
		const db = makeDb({ accounts: [SK], trucks: [withTruck(T101, { 2: "" }), [3, "300", "", 9, ""]],
			assignments: [[3, "Shorn  King", "2026-08-01T00:00:00.000Z"], [1, " shorn king ", "2026-09-01T00:00:00.000Z"]] });
		const m = buildHelpers(db, over);
		t("findActiveAssignmentTruckForDriver(), spacing variants only: the newest active row's truck, matchedBy normalized",
			brief(m.findActiveAssignmentTruckForDriver("Shorn King")), [1, "101", 5, "RM-101", "normalized"]);
		db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (3, 'SHORN KING', '2026-07-01T00:00:00.000Z')").run();
		t("findActiveAssignmentTruckForDriver(), a case-aside row is preferred to a newer spacing variant",
			brief(m.findActiveAssignmentTruckForDriver("Shorn King")), [3, "300", 9, "", "case"]);
		db.prepare("UPDATE truck_assignments SET end_date = '2026-09-02' WHERE truck_id = 3").run();
		db.prepare("UPDATE truck_assignments SET end_date = '2026-09-02' WHERE truck_id = 1").run();
		t("findActiveAssignmentTruckForDriver(), a closed row is no match; a blank name matches nothing",
			[m.findActiveAssignmentTruckForDriver("Shorn King"), m.findActiveAssignmentTruckForDriver(""), m.findActiveAssignmentTruckForDriver(null)], [null, null, null]);
	}
	{
		const db = makeDb({ accounts: [SK, DK, [5, "shorn king"]] });
		const m = buildHelpers(db, over);
		t("driverNameHeldByOtherSpelling(): the name's own spelling, case aside, is not another spelling",
			[m.driverNameHeldByOtherSpelling("Shorn King"), m.driverNameHeldByOtherSpelling(" SHORN KING ")], [false, false]);
		t("driverNameHeldByOtherSpelling(): a spacing variant nobody holds, a stranger's name, a blank name: false",
			[m.driverNameHeldByOtherSpelling("Pat Newhire"), m.driverNameHeldByOtherSpelling(""), m.driverNameHeldByOtherSpelling(null)], [false, false, false]);
		t("driverNameHeldByOtherSpelling(): a spelling no account has, beside the account that has the name: true",
			m.driverNameHeldByOtherSpelling("Shorn  King"), true);
		db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (4, 'LogisX-1004', 'Driver', 'Shorn   King')").run();
		t("driverNameHeldByOtherSpelling(): another account holds the name in another spacing: true",
			m.driverNameHeldByOtherSpelling("Shorn King"), true);
		db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (6, 'Pat  Newhire', 'Dispatcher', '')").run();
		t("driverNameHeldByOtherSpelling(): a username is not a driver name", m.driverNameHeldByOtherSpelling("Pat Newhire"), false);
	}
	{
		const stamp = (world, name, opts) => brief(buildHelpers(makeDb(world), over).findTruckForDriverStamp(name, opts));
		t("findTruckForDriverStamp(), a spacing-variant truck, no other account: that truck",
			stamp({ accounts: [SK, DK], trucks: [T101, T205] }, "Shorn King"), [1, "101", 5, "RM-101", "normalized"]);
		t("findTruckForDriverStamp(), a directory-only driver (no account at all): that truck",
			stamp({ trucks: [T101] }, "shorn king"), [1, "101", 5, "RM-101", "normalized"]);
		t("findTruckForDriverStamp(), another account holds the name in another spacing: no truck, as before",
			stamp({ accounts: [SK, SK_OTHER], trucks: [T101] }, "Shorn King"), null);
		t("findTruckForDriverStamp(), ...a case-aside truck is still found",
			stamp({ accounts: [SK, SK_OTHER], trucks: [withTruck(T101, { 2: "SHORN KING" })] }, "Shorn King"), [1, "101", 5, "RM-101", "case"]);
		t("findTruckForDriverStamp(), ...and the other account's own spelling finds its truck case aside",
			stamp({ accounts: [SK, SK_OTHER], trucks: [withTruck(T101, { 2: "Shorn   King" })] }, "Shorn   King"), [1, "101", 5, "RM-101", "case"]);
		t("findTruckForDriverStamp(), no truck names the driver: the active assignment only when asked for",
			[stamp({ accounts: [SK], trucks: [withTruck(T101, { 2: "" })], assignments: [A101] }, "Shorn King"),
				stamp({ accounts: [SK], trucks: [withTruck(T101, { 2: "" })], assignments: [A101] }, "Shorn King", { activeAssignment: true })],
			[null, [1, "101", 5, "RM-101", "normalized"]]);
		t("findTruckForDriverStamp(), the refused spacing step falls to a case-aside assignment",
			stamp({ accounts: [SK, SK_OTHER], trucks: [T101, [3, "300", "", 9, ""]], assignments: [[3, "shorn king", "2026-09-01T00:00:00.000Z"]] }, "Shorn King", { activeAssignment: true }),
			[3, "300", 9, "", "case"]);
		t("findTruckForDriverStamp(), ...and a spacing-variant assignment is refused the same way",
			stamp({ accounts: [SK, SK_OTHER], trucks: [T101], assignments: [A101] }, "Shorn King", { activeAssignment: true }), null);
		t("findTruckForDriverStamp(), a blank name: no truck", stamp({ trucks: [withTruck(T101, { 2: "" })] }, "", { activeAssignment: true }), null);
	}
	return results;
}

// ─────────────────────────────────────────────────────────────── §2 POST /api/expenses
const EXPENSE_DATE = "2026-09-10";
function mountExpense(db, routeSrc, helperOver) {
	const helpers = buildHelpers(db, helperOver);
	const audits = [];
	let handler = null;
	const env = {
		app: { post: (...args) => { handler = args[args.length - 1]; } },
		requireAuth: null,
		driverWriteLimiter: null,
		db,
		findTruckForDriverStamp: helpers.findTruckForDriverStamp,
		sanitizeReceiptDetails: H.sanitizeReceiptDetails,
		resolveDriverActor: new Function("normalizeDriverName", `${RESOLVE_ACTOR_SRC}\nreturn resolveDriverActor;`)(helpers.normalizeDriverName),
		normalizeVendor: (v) => String(v || "").trim().toLowerCase(),
		normalizeVendorDetailed: () => ({ normalized: "", aliasHit: false }),
		sentIfDriverExpenseLoadMissing: () => false,
		loadBelongsToDriver: async () => true,
		sentIfLoadOwnershipUnverified: () => false,
		sentIfDriverExpenseWindowClosed: async () => false,
		crypto,
		receiptDuplicates,
		saveReceiptToDisk: () => ({ url: "" }),
		savePdfReceiptToDisk: () => { throw new Error("no PDF in this fixture"); },
		GEOCODE_CITY_RE: /^[A-Za-z][A-Za-z .'\-]{1,49}$/,
		spendGeocodeBudget: () => false,
		geocodeAddress: async () => null,
		getStateFromCoords,
		currentMonthKeyCT: () => "2026-09",
		periodLocksReadable: () => true,
		periodWriteLocked: () => false,
		logAudit: (req, action) => { audits.push(action); },
		notifyChange: () => {},
		path, fs, __dirname: "/nonexistent",
		console: QUIET,
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("the lifted expense route did not register a handler");
	return async (user, body) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ body, session: { user } }, res);
		return out;
	};
}
async function expenseSection(routeSrc = ROUTES.expense, helperOver = {}) {
	const { results, t } = collector();
	const DRIVER_SK = { id: 2, role: "Driver", username: "LogisX-1002", driverName: "Shorn King" };
	const ADMIN = { id: 1, role: "Super Admin", username: "super_admin" };
	const post = async (world, user, over = {}) => {
		const db = makeDb(world);
		// An ELD ping on the receipt's day, for the truck's vehicle: the stamp's
		// routemate_vehicle_id is what finds it.
		db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms) VALUES ('RM-101', 29.76, -95.37, ?)")
			.run(Date.parse(`${EXPENSE_DATE}T18:00:00Z`));
		const run = mountExpense(db, routeSrc, helperOver);
		const r = await run(user, { loadId: "L-1", type: "Fuel", amount: "123.45", date: EXPENSE_DATE, ...over });
		const row = db.prepare("SELECT driver, truck_unit, owner_id, location_state, location_source FROM expenses").get() || null;
		return { r, row: row && [row.driver, row.truck_unit, row.owner_id, row.location_state, row.location_source] };
	};
	{
		const { r, row } = await post({ accounts: [SK, DK], trucks: [T101, T205] }, DRIVER_SK);
		t("POST /api/expenses, the driver whose truck is stored with a doubled space: 200, the truck's unit and owner stamped, its ELD vehicle placing the receipt",
			[r.code, row], [200, ["Shorn King", "101", 5, "TX", "eld"]]);
	}
	{
		const { r, row } = await post({ accounts: [SK, DK], trucks: [T101, T205] }, ADMIN, { driver: "shorn king" });
		t("POST /api/expenses, a Super Admin filing for the driver in another spelling: the same truck and owner",
			[r.code, row], [200, ["shorn king", "101", 5, "TX", "eld"]]);
	}
	{
		const { r, row } = await post({ accounts: [SK, DK], trucks: [T101, T205] }, ADMIN, { driver: "Deshorn King" });
		t("POST /api/expenses, a case-aside match is stamped as before",
			[r.code, row], [200, ["Deshorn King", "205", 7, "", ""]]);
	}
	{
		const { r, row } = await post({ accounts: [SK, DK, SK_OTHER], trucks: [T101, T205] }, DRIVER_SK);
		t("POST /api/expenses, another account holds the name in another spacing: no truck, owner 0, as before",
			[r.code, row], [200, ["Shorn King", "", 0, "", ""]]);
	}
	{
		const { r, row } = await post({ accounts: [SK, DK, SK_OTHER], trucks: [withTruck(T101, { 2: "SHORN KING" }), T205] }, DRIVER_SK);
		t("POST /api/expenses, ...a truck naming the driver case aside is still stamped",
			[r.code, row], [200, ["Shorn King", "101", 5, "TX", "eld"]]);
	}
	return results;
}

// ─────────────────────────────────────────────────────────────── §3 dispatch + reassign
const JT_HEADERS = ["Contract ID", "Load ID", "Details", "Driver", "Job Status", "Assigned Date", "Status Update Date",
	"Completion Date", "  Payment  ", "Truck", "Owner ID"];
const JT_IDX = Object.fromEntries(JT_HEADERS.map((h, i) => [h.trim(), i]));
function jtRow(loadId, over) {
	const r = new Array(JT_HEADERS.length).fill("");
	r[JT_IDX["Load ID"]] = loadId;
	r[JT_IDX["Job Status"]] = "Unassigned";
	for (const [k, v] of Object.entries(over || {})) r[JT_IDX[k]] = v;
	return r;
}
function fakeSheets(tabs) {
	const writes = [];
	const values = {
		get: async ({ range }) => ({ data: { values: tabs[String(range).split("!")[0]].map((r) => r.slice()) } }),
		update: async ({ range, requestBody }) => { writes.push({ range, value: requestBody.values[0] }); return { data: {} }; },
		batchUpdate: async ({ requestBody }) => {
			for (const d of requestBody.data) writes.push({ range: d.range, value: d.values[0][0] });
			return { data: {} };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), writes };
}
function mountDispatch(db, routeSrc, helperOver) {
	const helpers = buildHelpers(db, helperOver);
	const sheet = fakeSheets({ "Job Tracking": [JT_HEADERS.slice(), jtRow("111", { Driver: "Old Driver", "Job Status": "Dispatched", Truck: "LogisX-#33", "Owner ID": "0" })] });
	let handler = null;
	const env = {
		app: { post: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		resolveSheetDataRow: H.resolveSheetDataRow,
		db,
		findTruckForDriverStamp: helpers.findTruckForDriverStamp,
		getSheets: sheet.getSheets,
		readJobTrackingSnapshot,
		sendDispatchRefusal: (req, res, blocked) => res.status(409).json({ code: blocked.code }),
		resolveLoadBinding: () => null,
		sendLoadBindRefusal: (req, res) => res.status(409).json({ code: "LOAD_ROW_MISMATCH" }),
		dispatchWriteBlocker: () => null,
		sheetRowToObject: H.sheetRowToObject,
		colLetter: H.colLetter,
		formulaCellRefusal: H.formulaCellRefusal,
		SPREADSHEET_ID: "sheet-under-test",
		insertNotification: { run: () => ({ lastInsertRowid: 1 }) },
		insertDispatchNotification: { run: () => ({}) },
		io: { to: () => ({ emit: () => {} }) },
		driverRoom: (n) => `driver:${String(n).toLowerCase()}`,
		logAudit: () => {},
		recordStatusChange: () => {},
		notifyChange: () => {},
		jtCacheInvalidate: () => {},
		console: QUIET,
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("a lifted dispatch route did not register a handler");
	return async (body) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ body, session: { user: { id: 1, role: "Super Admin", username: "super_admin" } } }, res);
		const cell = (col) => {
			const w = sheet.writes.find((x) => x.range === `Job Tracking!${H.colLetter(JT_IDX[col])}2`);
			return w ? w.value : undefined;
		};
		return { code: out.code, driver: cell("Driver"), truck: cell("Truck"), owner: cell("Owner ID") };
	};
}
async function dispatchSection(routes = { dispatch: ROUTES.dispatch, reassign: ROUTES.reassign }, helperOver = {}) {
	const { results, t } = collector();
	for (const [label, key] of [["POST /api/dispatch", "dispatch"], ["POST /api/dispatch/reassign", "reassign"]]) {
		const field = key === "dispatch" ? "driver" : "newDriver";
		const run = (world, name) => mountDispatch(makeDb(world), routes[key], helperOver)({ rowIndex: 2, loadId: "111", [field]: name });
		const brief = (r) => [r.code, r.driver, r.truck, r.owner];
		t(`${label}, the driver whose truck is stored with a doubled space: Truck and Owner ID are that truck's`,
			brief(await run({ accounts: [SK, DK], trucks: [T101, T205], assignments: [A101, A205] }, "Shorn King")), [200, "Shorn King", "101", "5"]);
		t(`${label}, the driver named in another case and spacing: the account's spelling, and the same truck`,
			brief(await run({ accounts: [SK, DK], trucks: [T101, T205] }, "shorn king")), [200, "Shorn King", "101", "5"]);
		t(`${label}, a case-aside match is stamped as before`,
			brief(await run({ accounts: [SK, DK], trucks: [T101, T205] }, "Deshorn King")), [200, "Deshorn King", "205", "7"]);
		t(`${label}, no truck names the driver: the active assignment, stored with a doubled space, is the fallback`,
			brief(await run({ accounts: [SK], trucks: [withTruck(T101, { 2: "" })], assignments: [A101] }, "Shorn King")), [200, "Shorn King", "101", "5"]);
		t(`${label}, another account holds the name in another spacing: no truck, Owner ID 0, as before`,
			brief(await run({ accounts: [SK, SK_OTHER], trucks: [T101], assignments: [A101] }, "Shorn King")), [200, "Shorn King", "", "0"]);
		t(`${label}, ...a truck naming the driver case aside is still stamped`,
			brief(await run({ accounts: [SK, SK_OTHER], trucks: [withTruck(T101, { 2: "SHORN KING" })] }, "Shorn King")), [200, "Shorn King", "101", "5"]);
		t(`${label}, ...and so is a case-aside active assignment`,
			brief(await run({ accounts: [SK, SK_OTHER], trucks: [withTruck(T101, { 2: "" })], assignments: [[1, "SHORN KING", "2026-09-01T00:00:00.000Z"]] }, "Shorn King")),
			[200, "Shorn King", "101", "5"]);
		t(`${label}, a name no truck or assignment names: no truck, Owner ID 0`,
			brief(await run({ accounts: [SK], trucks: [T101] }, "Pat Newhire")), [200, "Pat Newhire", "", "0"]);
	}
	return results;
}

// ─────────────────────────────────────────────────────────────── §4 assignDriverToTruck()
function assignSection(helperOver = {}) {
	const { results, t } = collector();
	const state = (db) => [
		db.prepare("SELECT id, assigned_driver FROM trucks ORDER BY id").all().map((r) => `${r.id}:${r.assigned_driver}`).join(","),
		db.prepare("SELECT truck_id, driver_name FROM truck_assignments WHERE end_date = '' ORDER BY id").all().map((r) => `${r.truck_id}:${r.driver_name}`).join(","),
	];
	const assign = (world, truckId, name) => { const db = makeDb(world); buildHelpers(db, helperOver).assignDriverToTruck(truckId, name); return state(db); };
	const T2 = [2, "205", "", 7, ""];
	t("assignDriverToTruck(), the driver's old truck stored with a doubled space: released, with its assignment row; one truck, one active row",
		assign({ accounts: [SK], trucks: [T101, T2], assignments: [A101] }, 2, "Shorn King"), ["1:,2:Shorn King", "2:Shorn King"]);
	t("assignDriverToTruck(), an old truck and row stored with edge spaces: released too",
		assign({ accounts: [SK], trucks: [withTruck(T101, { 2: " shorn king " }), T2], assignments: [[1, " shorn king ", "2026-09-01T00:00:00.000Z"]] }, 2, "Shorn King"),
		["1:,2:Shorn King", "2:Shorn King"]);
	t("assignDriverToTruck(), a directory-only driver (no account): released the same way",
		assign({ trucks: [T101, T2], assignments: [A101] }, 2, "Shorn King"), ["1:,2:Shorn King", "2:Shorn King"]);
	t("assignDriverToTruck(), another account holds the name in another spacing: its truck and row are left alone, as before",
		assign({ accounts: [SK, SK_OTHER], trucks: [T101, T2], assignments: [A101] }, 2, "Shorn King"), ["1:Shorn  King,2:Shorn King", "1:Shorn  King,2:Shorn King"]);
	t("assignDriverToTruck(), ...a case-aside truck and row are still released",
		assign({ accounts: [SK, SK_OTHER], trucks: [withTruck(T101, { 2: "SHORN KING" }), T2], assignments: [[1, "SHORN KING", "2026-09-01T00:00:00.000Z"]] }, 2, "Shorn King"),
		["1:,2:Shorn King", "2:Shorn King"]);
	t("assignDriverToTruck(), Deshorn King's truck is never Shorn King's to release",
		assign({ accounts: [SK, DK], trucks: [T101, T205, [3, "300", "", 0, ""]], assignments: [A101, A205] }, 3, "Shorn King"),
		["1:,2:Deshorn King,3:Shorn King", "2:Deshorn King,3:Shorn King"]);
	t("assignDriverToTruck(), unassigning (a blank name) clears only that truck",
		assign({ accounts: [SK], trucks: [T101, withTruck(T2, { 2: "Deshorn King" })], assignments: [A101, [2, "Deshorn King", "2026-09-01T00:00:00.000Z"]] }, 1, ""),
		["1:,2:Deshorn King", "2:Deshorn King"]);
	t("assignDriverToTruck(), re-assigning the driver's own truck in another spelling keeps one row",
		assign({ accounts: [SK], trucks: [T101], assignments: [A101] }, 1, "Shorn King"), ["1:Shorn King", "1:Shorn King"]);
	return results;
}

// ─────────────────────────────────────────────────────────────── the pairing rows
// carrier_driver_history as carrier|driver|state, in id order: "closed" means
// closed by the call under test, "closed earlier" a fixture's own end.
const EARLIER = "2026-06-01T00:00:00.000Z";
const pairingRows = (db) => db.prepare("SELECT carrier_name, driver_name, ended_at FROM carrier_driver_history ORDER BY id").all()
	.map((r) => `${r.carrier_name}|${r.driver_name}|${r.ended_at == null ? "open" : r.ended_at === EARLIER ? "closed earlier" : "closed"}`);

// ─────────────────────────────────────────────────────────────── §4b the carrier pairing
// assignDriverToTruck() mirrors the driver's carrier, the company of the truck's
// owner, into carrier_driver_history: one open pairing per driver, which
// getInvestorDriverSet() leg 3 reads. Truck 3 is empty and Carrier Seven's.
function pairingSection(helperOver = {}) {
	const { results, t: check4b } = collector();
	const t = (name, actual, expected) => check4b(`assignDriverToTruck(), the carrier pairing: ${name}`, actual, expected);
	const INVESTORS = [[5, "Carrier Five LLC"], [7, "Carrier Seven LLC"]];
	const T3 = [3, "300", "", 7, ""];
	const after = (world, name) => {
		const db = makeDb({ investors: INVESTORS, trucks: [T101, T3], ...world });
		buildHelpers(db, helperOver).assignDriverToTruck(3, name);
		return pairingRows(db);
	};
	t("the driver's open pairing stored with a doubled space, a truck of another carrier: that pairing closed, one open under the new carrier",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn  King"]] }, "Shorn King"),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("...one stored with edge spaces: closed too",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", " shorn king "]] }, "Shorn King"),
		["Carrier Five LLC| shorn king |closed", "Carrier Seven LLC|Shorn King|open"]);
	t("...a directory-only driver (no account): the same",
		after({ pairings: [["Carrier Five LLC", "Shorn  King"]] }, "Shorn King"),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("the spacing-variant pairing already under this carrier: left open, no second row",
		after({ accounts: [SK], pairings: [["Carrier Seven LLC", "Shorn  King"]] }, "Shorn King"),
		["Carrier Seven LLC|Shorn  King|open"]);
	t("two open pairings the old lookup left (a variant under Carrier Five, the name under Carrier Seven): the variant closed, the other kept, no new row",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn  King"], ["Carrier Seven LLC", "Shorn King"]] }, "Shorn King"),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("a case-aside pairing under another carrier: closed and replaced, as before",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "SHORN KING"]] }, "Shorn King"),
		["Carrier Five LLC|SHORN KING|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("a pairing closed earlier is left as it was",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn  King", EARLIER]] }, "Shorn King"),
		["Carrier Five LLC|Shorn  King|closed earlier", "Carrier Seven LLC|Shorn King|open"]);
	t("another account holds the name in another spacing: its pairing is left open, as before",
		after({ accounts: [SK, SK_OTHER], pairings: [["Carrier Five LLC", "Shorn   King"]] }, "Shorn King"),
		["Carrier Five LLC|Shorn   King|open", "Carrier Seven LLC|Shorn King|open"]);
	t("...while a case-aside pairing is still closed",
		after({ accounts: [SK, SK_OTHER], pairings: [["Carrier Five LLC", "shorn king"]] }, "Shorn King"),
		["Carrier Five LLC|shorn king|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("Deshorn King's pairing is never Shorn King's to close",
		after({ accounts: [SK, DK], pairings: [["Carrier Five LLC", "Deshorn King"]] }, "Shorn King"),
		["Carrier Five LLC|Deshorn King|open", "Carrier Seven LLC|Shorn King|open"]);
	return results;
}

// ─────────────────────────────────────────────────────────────── §4c the directory's pairing
// syncCarrierDriverHistory() is what POST and PUT /api/drivers-directory call,
// with the directory row's name and carrier. It keeps each row's pairing through
// the helper assignDriverToTruck() uses, so a pairing stored under a spacing
// variant is closed the same way, under the same guard.
//
// The case-only copy it held before, verbatim but for its comments: the
// reference for the rows it already handled (one case-aside open row, or none).
const CASE_ONLY_SYNC_SRC = `function syncCarrierDriverHistory(carrierDBData, driverColName, carrierColName) {
	if (!driverColName || !carrierColName) return;
	const now = new Date().toISOString();
	carrierDBData.forEach(row => {
		const driverName = (row[driverColName] || "").trim();
		const carrierName = (row[carrierColName] || "").trim();
		if (!driverName || !carrierName) return;
		const driverLower = driverName.toLowerCase();
		const carrierLower = carrierName.toLowerCase();
		const current = db.prepare(
			"SELECT id, carrier_name FROM carrier_driver_history WHERE LOWER(driver_name) = ? AND ended_at IS NULL"
		).get(driverLower);
		if (current) {
			if (current.carrier_name.toLowerCase() === carrierLower) return;
			db.prepare("UPDATE carrier_driver_history SET ended_at = ? WHERE id = ?").run(now, current.id);
		}
		db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES (?, ?, ?)").run(carrierName, driverName, now);
	});
}`;
// Every column in id order, a time the call under test wrote read as "now".
const FIXTURE_TIMES = new Set(["2026-05-01T12:00:00.000Z", EARLIER]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const writtenAt = (v) => (v == null || FIXTURE_TIMES.has(v) || !ISO_INSTANT.test(v) ? v : "now");
const pairingDump = (db) => db.prepare("SELECT id, carrier_name, driver_name, started_at, ended_at FROM carrier_driver_history ORDER BY id").all()
	.map((r) => [r.id, r.carrier_name, r.driver_name, writtenAt(r.started_at), writtenAt(r.ended_at)].join("|"));

function directorySyncSection(helperOver = {}) {
	const { results, t: check4c } = collector();
	const t = (name, actual, expected) => check4c(`syncCarrierDriverHistory(), the carrier pairing: ${name}`, actual, expected);
	// `src` runs the case-only reference instead of the shipped function.
	const run = (world, rows, { cols = ["Driver", "Carrier Name"], src } = {}) => {
		const db = makeDb(world);
		const sync = src
			? new Function("db", `"use strict";\n${src}\nreturn syncCarrierDriverHistory;`)(db)
			: buildHelpers(db, helperOver).syncCarrierDriverHistory;
		sync(rows, ...cols);
		return db;
	};
	const after = (world, rows, opts) => pairingRows(run(world, rows, opts));
	const to = (driver, carrier = "Carrier Seven LLC") => [{ Driver: driver, "Carrier Name": carrier }];
	t("the driver's open pairing stored with a doubled space, another carrier: that pairing closed, one open under the new carrier",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn  King"]] }, to("Shorn King")),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("...one stored with edge spaces: closed too",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", " shorn king "]] }, to("Shorn King")),
		["Carrier Five LLC| shorn king |closed", "Carrier Seven LLC|Shorn King|open"]);
	t("...a directory-only driver (no account): the same",
		after({ pairings: [["Carrier Five LLC", "Shorn  King"]] }, to("Shorn King")),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("the spacing-variant pairing already open under this carrier: left open, not reopened",
		after({ accounts: [SK], pairings: [["Carrier Seven LLC", "Shorn  King"]] }, to("Shorn King")),
		["Carrier Seven LLC|Shorn  King|open"]);
	t("...under this carrier spelled in another case: left open too",
		after({ accounts: [SK], pairings: [["CARRIER SEVEN LLC", "Shorn  King"]] }, to("Shorn King")),
		["CARRIER SEVEN LLC|Shorn  King|open"]);
	t("two open pairings the old lookup left (a variant under Carrier Five, the name under Carrier Seven): the variant closed, the other kept, no new row",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn  King"], ["Carrier Seven LLC", "Shorn King"]] }, to("Shorn King")),
		["Carrier Five LLC|Shorn  King|closed", "Carrier Seven LLC|Shorn King|open"]);
	// With the guard engaged too: the spacing pass would otherwise find the
	// second row, since normalizeDriverName() folds case as well.
	const TWO_CASE_ASIDE = [["Carrier Five LLC", "SHORN KING"], ["Carrier Six LLC", "Shorn King"]];
	t("two case-aside open pairings under other carriers, with and without the guard engaged: both closed (the old lookup closed one), one opened",
		[after({ accounts: [SK], pairings: TWO_CASE_ASIDE }, to("Shorn King")), after({ accounts: [SK, SK_OTHER], pairings: TWO_CASE_ASIDE }, to("Shorn King"))],
		Array(2).fill(["Carrier Five LLC|SHORN KING|closed", "Carrier Six LLC|Shorn King|closed", "Carrier Seven LLC|Shorn King|open"]));
	t("the guard: another account holds the name in another spacing: its pairing is left open, as before",
		after({ accounts: [SK, SK_OTHER], pairings: [["Carrier Five LLC", "Shorn   King"]] }, to("Shorn King")),
		["Carrier Five LLC|Shorn   King|open", "Carrier Seven LLC|Shorn King|open"]);
	t("...while a case-aside pairing is still closed",
		after({ accounts: [SK, SK_OTHER], pairings: [["Carrier Five LLC", "shorn king"]] }, to("Shorn King")),
		["Carrier Five LLC|shorn king|closed", "Carrier Seven LLC|Shorn King|open"]);
	t("...and a directory row spelled the way no account is leaves the account's pairing open, as before",
		after({ accounts: [SK], pairings: [["Carrier Five LLC", "Shorn King"]] }, to("Shorn  King")),
		["Carrier Five LLC|Shorn King|open", "Carrier Seven LLC|Shorn  King|open"]);
	t("Deshorn King's pairing is never Shorn King's to close",
		after({ accounts: [SK, DK], pairings: [["Carrier Five LLC", "Deshorn King"]] }, to("Shorn King")),
		["Carrier Five LLC|Deshorn King|open", "Carrier Seven LLC|Shorn King|open"]);
	t("the new row carries both names trimmed, as before",
		after({ accounts: [SK] }, to("  Shorn King ", " Carrier Seven LLC  ")),
		["Carrier Seven LLC|Shorn King|open"]);
	t("a row without a driver or a carrier, or a call without the column names: nothing written",
		[after({}, to("")), after({}, to("Shorn King", "")), after({}, to("Shorn King"), { cols: ["Driver", ""] })],
		[[], [], []]);
	// One case-aside open row, or none, over every world and input below, with
	// and without the guard engaged: the rows end exactly as under the case-only
	// copy, every column.
	const WORLDS = [
		{},
		{ pairings: [["Carrier Five LLC", "Shorn King"]] },
		{ pairings: [["Carrier Five LLC", "SHORN KING"]] },
		{ pairings: [["Carrier Seven LLC", "shorn king"]] },
		{ pairings: [["CARRIER SEVEN LLC", "Shorn King"]] },
		{ pairings: [["Carrier Five LLC", "Shorn King", EARLIER]] },
		{ pairings: [["Carrier Five LLC", "Shorn  King", EARLIER], ["Carrier Seven LLC", "Shorn King"]] },
		{ pairings: [["Carrier Five LLC", "Deshorn King"], ["Carrier Five LLC", "Shorn King"]] },
	];
	const INPUTS = [to("Shorn King"), to("Shorn King", "Carrier Five LLC"), to("SHORN KING", "carrier seven llc"), [],
		[...to("Shorn King"), ...to("Deshorn King")]];
	const drift = [];
	let compared = 0;
	for (const accounts of [[SK, DK], [SK, DK, SK_OTHER]]) {
		WORLDS.forEach((w, wi) => INPUTS.forEach((rows, ii) => {
			const world = { accounts, ...w };
			const was = pairingDump(run(world, rows, { src: CASE_ONLY_SYNC_SRC }));
			const now = pairingDump(run(world, rows));
			compared++;
			if (JSON.stringify(was) !== JSON.stringify(now)) drift.push({ accounts: accounts.length, world: wi, input: ii, was, now });
		}));
	}
	t(`one case-aside open row, or none: all ${compared} world and input pairs end exactly as under the case-only copy`, drift, []);
	return results;
}

// ─────────────────────────────────────────────────────────────── §5 wiring
function wiringSection(routes = ROUTES) {
	const { results, t } = collector();
	const code = (s) => decomment(s);
	const e = code(routes.expense), d = code(routes.dispatch), r = code(routes.reassign), tr = code(routes.track);
	t("POST /api/expenses stamps through findTruckForDriverStamp(driver), with no trucks lookup of its own",
		[e.includes("const driverTruck = findTruckForDriverStamp(driver);"), /FROM trucks\b/.test(e), /assigned_driver/.test(e)], [true, false, false]);
	t("POST /api/dispatch stamps through findTruckForDriverStamp(driver, { activeAssignment: true }), with no truck or assignment lookup of its own",
		[d.includes("findTruckForDriverStamp(driver, { activeAssignment: true })"), /FROM trucks\b|truck_assignments/.test(d)], [true, false]);
	t("POST /api/dispatch/reassign stamps through findTruckForDriverStamp(newDriver, { activeAssignment: true }), with no lookup of its own",
		[r.includes("findTruckForDriverStamp(newDriver, { activeAssignment: true })"), /FROM trucks\b|truck_assignments/.test(r)], [true, false]);
	t("GET /api/public/track/:loadId shows the unit findTruckForDriverStamp() finds, with no LOWER(assigned_driver) lookup",
		[tr.includes("findTruckForDriverStamp(driverNameRaw)"), /LOWER\(assigned_driver\)/.test(tr)], [true, false]);
	// The pairing: one helper, both writers ask it, and nothing else in server.js
	// opens or closes a pairing (the first-startup backfill aside, which writes
	// no start).
	const as = code(HELPER_SRC.assignDriverToTruck), sy = code(HELPER_SRC.syncCarrierDriverHistory), pr = HELPER_SRC.syncOpenCarrierPairing;
	t("assignDriverToTruck() keeps the pairing through syncOpenCarrierPairing(), handed its release's guard answer, with no carrier_driver_history SQL of its own",
		[as.includes("syncOpenCarrierPairing(driverName.trim(), carrierName, now, releaseSpacingVariants)"), /carrier_driver_history/.test(as)], [true, false]);
	t("syncCarrierDriverHistory() keeps each row's pairing through syncOpenCarrierPairing(), with no carrier_driver_history SQL of its own",
		[sy.includes("syncOpenCarrierPairing(driverName, carrierName, now)"), /carrier_driver_history/.test(sy)], [true, false]);
	const inServer = (s) => SRC.split(s).length - 1;
	const CLOSE = "UPDATE carrier_driver_history SET ended_at", OPEN = "INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at)";
	t("the only statements in server.js that close a pairing, or open one with a start, are syncOpenCarrierPairing()'s",
		[inServer(CLOSE), pr.includes(CLOSE), inServer(OPEN), pr.includes(OPEN)], [1, true, 1, true]);
	return results;
}

// ─────────────────────────────────────────────────────────────── run
(async () => {
	section("§1 the helpers");
	record(helperSection());
	section("§2 POST /api/expenses");
	record(await expenseSection());
	section("§3 POST /api/dispatch and /api/dispatch/reassign");
	record(await dispatchSection());
	section("§4 assignDriverToTruck()");
	record(assignSection());
	section("§4b assignDriverToTruck(): the carrier pairing");
	record(pairingSection());
	section("§4c syncCarrierDriverHistory(): the carrier pairing");
	record(directorySyncSection());
	section("§5 the wiring");
	record(wiringSection());

	section("§6 the mutants (each must be caught)");
	const OLD_EXPENSE = 'db.prepare("SELECT unit_number, owner_id, routemate_vehicle_id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(driver.trim())';
	const oldDispatch = (who) => `db.prepare("SELECT unit_number, owner_id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(${who}.trim())
			|| db.prepare("SELECT t.unit_number AS unit_number, t.owner_id AS owner_id FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id WHERE LOWER(ta.driver_name) = LOWER(?) AND ta.end_date = '' ORDER BY ta.start_date DESC LIMIT 1").get(${who}.trim())`;
	const GUARD = "if (held === undefined) held = driverNameHeldByOtherSpelling(name);\n\t\treturn !held;";
	const ASSIGN_GUARD = 'const releaseSpacingVariants = needle !== "" && !driverNameHeldByOtherSpelling(driverName);';
	const pairingSpacingStepRemoved = () => ({ syncOpenCarrierPairing: mutate(HELPER_SRC.syncOpenCarrierPairing,
		"if (!found.has(r.id) && normalizeDriverName(r.driver_name) === needle) openPairings.push(r);", "void r;") });
	const mutants = [
		["M1 POST /api/expenses back to the case-only truck lookup",
			async () => expenseSection(mutate(ROUTES.expense, "findTruckForDriverStamp(driver)", OLD_EXPENSE))],
		["M2 POST /api/dispatch back to the case-only truck and assignment lookups",
			async () => dispatchSection({ dispatch: mutate(ROUTES.dispatch, "findTruckForDriverStamp(driver, { activeAssignment: true })", oldDispatch("driver")), reassign: ROUTES.reassign })],
		["M3 POST /api/dispatch/reassign back to the case-only truck and assignment lookups",
			async () => dispatchSection({ dispatch: ROUTES.dispatch, reassign: mutate(ROUTES.reassign, "findTruckForDriverStamp(newDriver, { activeAssignment: true })", oldDispatch("newDriver")) })],
		["M4 the stamps' guard removed (a spacing match taken while another account holds the name)",
			async () => {
				const over = { findTruckForDriverStamp: mutate(HELPER_SRC.findTruckForDriverStamp, GUARD, "return true;") };
				return [...helperSection(over), ...(await expenseSection(ROUTES.expense, over)), ...(await dispatchSection(undefined, over))];
			}],
		["M5 the dispatch fallback's spacing step dropped (the active assignment back to case-only)",
			async () => {
				const over = { findActiveAssignmentTruckForDriver: mutate(HELPER_SRC.findActiveAssignmentTruckForDriver, 'return hit ? { ...hit, matchedBy: "normalized" } : null;', "return null;") };
				return [...helperSection(over), ...(await dispatchSection(undefined, over))];
			}],
		["M6 the guard's own-spelling exception dropped (the driver's own account read as another)",
			async () => {
				const over = { driverNameHeldByOtherSpelling: mutate(HELPER_SRC.driverNameHeldByOtherSpelling, "driverNameHeldByOtherAccount(trimmed, ownIds)", "driverNameHeldByOtherAccount(trimmed, [])") };
				return [...helperSection(over), ...(await expenseSection(ROUTES.expense, over)), ...(await dispatchSection(undefined, over)), ...assignSection(over), ...pairingSection(over),
					...directorySyncSection(over)];
			}],
		["M7 assignDriverToTruck()'s guard removed",
			async () => {
				const over = { assignDriverToTruck: mutate(HELPER_SRC.assignDriverToTruck, ASSIGN_GUARD, 'const releaseSpacingVariants = needle !== "";') };
				return [...assignSection(over), ...pairingSection(over)];
			}],
		["M8 assignDriverToTruck()'s release back to case-only",
			async () => {
				const over = { assignDriverToTruck: mutate(HELPER_SRC.assignDriverToTruck, ASSIGN_GUARD, "const releaseSpacingVariants = false;") };
				return [...assignSection(over), ...pairingSection(over)];
			}],
		["M9 the public tracker back to its own case-only lookup",
			async () => wiringSection({ ...ROUTES, track: mutate(ROUTES.track, "findTruckForDriverStamp(driverNameRaw)",
				'db.prepare("SELECT unit_number FROM trucks WHERE LOWER(assigned_driver) = LOWER(?) LIMIT 1").get(driverNameRaw)') })],
		["M10 assignDriverToTruck()'s pairing handed a case-only answer (the truck and assignment release kept)",
			async () => pairingSection({ assignDriverToTruck: mutate(HELPER_SRC.assignDriverToTruck,
				"syncOpenCarrierPairing(driverName.trim(), carrierName, now, releaseSpacingVariants)",
				"syncOpenCarrierPairing(driverName.trim(), carrierName, now, false)") })],
		// One mutant, run through each writer on its own: each must catch it.
		["M11 the pairing helper's spacing step removed, run through assignDriverToTruck() (§4b)",
			async () => pairingSection(pairingSpacingStepRemoved())],
		["M11 the pairing helper's spacing step removed, run through syncCarrierDriverHistory() (§4c)",
			async () => directorySyncSection(pairingSpacingStepRemoved())],
	];
	for (const [label, run] of mutants) {
		let caught;
		try {
			caught = (await run()).filter((r) => !r.ok);
		} catch (e) {
			check(`${label}: the mutant runs (${e.message})`, false, true);
			continue;
		}
		check(`${label}: caught`, caught.length > 0, true);
		console.log(`  caught  ${label} — by ${caught.length} check(s), e.g. ✗ ${caught[0] ? caught[0].name : "(none)"}`);
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.log("Failures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
})().catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
