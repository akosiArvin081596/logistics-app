#!/usr/bin/env node
/**
 * Truck amounts are finite and in range, and cost edits are audited.
 *
 * THE RULE. POST /api/trucks and PUT /api/trucks/:id store nine amounts — the
 * five fixed costs (insurance, ELD fee, truck payment, HVUT, IRP), the purchase
 * price, the maintenance fund, the fuel tank and the average MPG — through one
 * parser, parseTruckAmount(), and one table, TRUCK_AMOUNT_FIELDS. A sent amount
 * is a finite number from 0 to TRUCK_AMOUNT_MAX (1,000,000), or blank (null, ""
 * or whitespace), which is 0. Anything else refuses the whole request with
 * 400 INVALID_AMOUNT, naming the column in `field`, before the month-end lock is
 * asked and before anything is written. An Investor's add never stores the five
 * fixed costs, so they are not read and cannot refuse it. A PUT that actually
 * changes a cost — one of the five, the purchase price, the maintenance fund or
 * the admin fee — writes exactly one `update_truck_costs` line naming each
 * change and, when one of the five moved, the monthly fixed-cost total before
 * and after. A save that resends the stored values writes none.
 *
 * WHAT IS ASSERTED. The shipped parser and the two shipped handlers, lifted out
 * of server.js and run against an in-memory SQLite with server.js's own
 * parsers, audit writer, name helpers and truck assignment. Only the month-end
 * locks (which record what they were asked), the active-load check, the Job
 * Tracking read and the driver history it feeds, and the socket notification
 * are stubbed.
 *   §1 parseTruckAmount() — every accepted and refused shape, the cap's two
 *      edges, 1e308, whitespace, the error text; the table's nine rows, their
 *      keys (the fuel pair's `a ?? b` order included), the five fixed costs,
 *      and labels in the month-end lock's own wording.
 *   §2 PUT refusals — "Infinity", "-Infinity", 1e999 (a JSON number that parses
 *      to Infinity), "abc", -5 and more, one on each of the nine fields, each
 *      beside a driver reassignment: 400 INVALID_AMOUNT naming the column and
 *      its label, the database byte for byte as it was (no assignment, no
 *      directory row, no audit row), the lock never asked.
 *   §3 PUT successes — the values stored and the lock asked about the parsed
 *      ones; one update_truck_costs line per save that changes a cost, in the
 *      exact format, with the fixed-cost total only when a fixed cost moved;
 *      none for a resend, a notes-only save, a field left out, or a stored NULL
 *      admin fee resent as its 50; the fuel tank on its own line.
 *   §4 POST — a Super Admin's or a Dispatcher's unreadable fixed cost refused
 *      with nothing inserted; an Investor's junk fixed costs ignored (stored as
 *      0) while a junk purchase price is refused; the create lock and the INSERT
 *      given the parsed values.
 *   §5 source pins — both routes parse before their lock, their first await and
 *      their first write; no sent amount goes through parseFloat; exactly one
 *      writer of update_truck_costs.
 * The mutants for these checks were run by hand before shipping and are not
 * committed (see the PR).
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-truck-cost-amounts.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
// Anchored on a newline and counted, so a mention in a comment cannot be taken
// for the definition and a second copy fails the run instead of lifting either.
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A one-line `const NAME = …;`, or a block from its head to `close`.
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}

const ROUTES = {
	post: liftRoute('app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {'),
	put: liftRoute('app.put("/api/trucks/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {'),
};

// Everything the two routes call from module scope, verbatim.
const MODULE_SRC = [
	// the subject
	liftConst("const TRUCK_AMOUNT_MAX = "),
	liftFunction("parseTruckAmount"),
	liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"),
	liftFunction("parseTruckAmounts"),
	// the routes' other parsers, and the monthly total the audit lines name
	liftConst("const DRIVER_PAY_DAILY_MAX = "),
	liftFunction("parseDriverPayDaily"),
	liftConst("const IN_SERVICE_MAX_MONTHS_AHEAD = "),
	liftFunction("parseInServiceDate"),
	liftFunction("parseRetiredAt"),
	liftFunction("adminFeePctOrDefault"),
	liftFunction("truckMonthlyFixed"),
	// the real audit writers, so a row is the row production writes
	liftConst("const PAY_EDIT_ADMIN_ONLY = "),
	liftFunction("refusePayEdit"),
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAudit"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
	// names and the assignment a reassigning save writes
	liftFunction("normalizeDriverName"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	liftFunction("canonicalDriverName"),
	liftFunction("syncDriverToCarrierSheet"),
	liftFunction("assignDriverToTruck"),
].join("\n");
const MODULE_EXPORTS = [
	"TRUCK_AMOUNT_MAX", "parseTruckAmount", "TRUCK_AMOUNT_FIELDS", "parseTruckAmounts",
	"parseDriverPayDaily", "parseInServiceDate", "parseRetiredAt", "adminFeePctOrDefault", "truckMonthlyFixed",
	"refusePayEdit", "logAudit", "auditText",
	"normalizeDriverName", "findDriverNameClash", "findDriverNameClashes", "canonicalDriverName",
	"syncDriverToCarrierSheet", "assignDriverToTruck",
];
function buildModule(db) {
	return new Function("db", "todayKeyCT",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(db, () => "2026-09-26");
}

// ── fixtures ────────────────────────────────────────────────────────────────
function usersDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	const alters = ["full_name", "company_name", "must_change_password", "last_login_at"].map((col) => {
		const a = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
		if (!a) die(`could not locate the users.${col} migration`);
		return a[0];
	});
	return [`CREATE TABLE users (${m[1]}\n)`, ...alters];
}
function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}
const DDL = [
	...usersDdl(),
	auditDdl(),
	// The migrated production shapes (several migrations deep in server.js).
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '',
		phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '',
		trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '', rating TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	`CREATE TABLE trucks (
		id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '',
		year INTEGER DEFAULT 0, vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', status TEXT DEFAULT 'Active',
		assigned_driver TEXT DEFAULT '', notes TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, driver_pay_daily REAL DEFAULT 0,
		purchase_price REAL DEFAULT 0, title_status TEXT DEFAULT 'Clean', maintenance_fund_monthly REAL DEFAULT 0,
		fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '',
		photo TEXT DEFAULT '', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0, truck_payment_monthly REAL DEFAULT 0,
		hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL DEFAULT 50, created_at TEXT DEFAULT '')`,
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT)",
];

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };
const INVESTOR = { id: 9, username: "lx", role: "Investor" };

// LogisX-#33 carries production's cost shape: $3,043.33/mo of fixed costs
// (1630 + 50 + 1200 + 580/12 + 1380/12). Logisx-#91's admin fee is a legacy
// NULL. Bob Driver drives no truck and has no directory row, so a save that
// reassigns #33 to him writes an assignment, a carrier-history row and a
// directory row — everything a refused save must not write.
function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, full_name, company_name) VALUES (?, ?, 'x', ?, ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "", "");
	user.run(2, "kevin", "Dispatcher", "", "Kevin Dispatch", "");
	user.run(3, "sking", "Driver", "Shorn King", "Shorn King", "");
	user.run(4, "bdriver", "Driver", "Bob Driver", "Bob Driver", "");
	user.run(5, "acme", "Investor", "", "Acme Holdings", "Acme Holdings");
	user.run(9, "lx", "Investor", "", "LX Capital", "LX Capital");
	db.prepare("INSERT INTO drivers_directory (id, driver_name, city, state, trucks) VALUES (1, 'Shorn King', 'Houston', 'TX', 'LogisX-#33')").run();
	db.prepare(`INSERT INTO trucks (id, unit_number, make, model, year, status, assigned_driver, owner_id, driver_pay_daily,
		purchase_price, maintenance_fund_monthly, fuel_tank_gallons, avg_mpg, insurance_monthly, eld_monthly, truck_payment_monthly,
		hvut_annual, irp_annual, admin_fee_pct, created_at)
		VALUES (1, 'LogisX-#33', 'Freightliner', 'Cascadia', 2021, 'Active', 'Shorn King', 5, 250,
		85000, 800, 203, 6.5, 1630, 50, 1200, 580, 1380, 50, '2026-04-15 03:10:50')`).run();
	db.prepare(`INSERT INTO trucks (id, unit_number, make, status, assigned_driver, owner_id, admin_fee_pct, created_at)
		VALUES (2, 'Logisx-#91', 'Freightliner', 'Active', '', 5, NULL, '2026-05-21 12:07:08')`).run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Shorn King', '2026-09-01')").run();
	db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES ('Acme Holdings', 'Shorn King', '2026-09-01')").run();
	return db;
}

const truckRow = (db, id) => db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
const truckByUnit = (db, unit) => db.prepare("SELECT * FROM trucks WHERE unit_number = ?").get(unit);
// Everything a refused request must leave exactly as it found it.
const snapshot = (db) => JSON.stringify({
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	assignments: db.prepare("SELECT * FROM truck_assignments ORDER BY id").all(),
	history: db.prepare("SELECT * FROM carrier_driver_history ORDER BY id").all(),
	directory: db.prepare("SELECT * FROM drivers_directory ORDER BY id").all(),
	audit: db.prepare("SELECT * FROM audit_trail ORDER BY id").all(),
});
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const FIVE = ["insurance_monthly", "eld_monthly", "truck_payment_monthly", "hvut_annual", "irp_annual"];
const fiveOf = (o) => o && FIVE.map((c) => o[c]);

// The body the Trucks Edit form sends (TruckTable.vue handleSaveEdit), from the
// stored row: every field on every save. `over` replaces or (with undefined)
// removes a key. `photo` is left out — it is not an amount, and has checks and
// a runner of its own.
function truckFormBody(t, over = {}) {
	const b = {
		unitNumber: t.unit_number, make: t.make, model: t.model, year: t.year, vin: t.vin, licensePlate: t.license_plate,
		status: t.status, assignedDriver: t.assigned_driver, ownerId: t.owner_id, notes: t.notes,
		insuranceMonthly: t.insurance_monthly, eldMonthly: t.eld_monthly, truckPaymentMonthly: t.truck_payment_monthly,
		hvutAnnual: t.hvut_annual, irpAnnual: t.irp_annual, adminFeePct: t.admin_fee_pct ?? 50,
		driverPayDaily: t.driver_pay_daily, purchasePrice: t.purchase_price, titleStatus: t.title_status,
		maintenanceFundMonthly: t.maintenance_fund_monthly, fuel_tank_gallons: t.fuel_tank_gallons, avg_mpg: t.avg_mpg,
		in_service_date: t.in_service_date, inServiceDate: t.in_service_date, retired_at: t.retired_at, retiredAt: t.retired_at,
	};
	for (const [k, v] of Object.entries(over)) { if (v === undefined) delete b[k]; else b[k] = v; }
	return b;
}
// The body AddTruckForm.vue's submit sends, less the photo.
function addForm(over = {}) {
	const b = {
		unitNumber: "500", make: "Volvo", model: "VNL 760", year: 2024, vin: "", licensePlate: "", status: "Active",
		assignedDriver: "", ownerId: 5, notes: "", driverPayDaily: 0, in_service_date: "", inServiceDate: "",
		insuranceMonthly: 0, eldMonthly: 0, truckPaymentMonthly: 0, hvutAnnual: 0, irpAnnual: 0, adminFeePct: 50,
		purchasePrice: 0, titleStatus: "Clean", maintenanceFundMonthly: 0, fuel_tank_gallons: 0, avg_mpg: 0,
	};
	for (const [k, v] of Object.entries(over)) { if (v === undefined) delete b[k]; else b[k] = v; }
	return b;
}
// A JSON number too large for a double arrives as Infinity.
const WIRE_1E999 = JSON.parse('{"v":1e999}').v;

// One app: registers each lifted route and answers one request at a time.
function mountRoute(routeSrc, env) {
	let handler = null;
	const grab = (p, ...rest) => { handler = rest[rest.length - 1]; };
	const all = { app: { get: grab, post: grab, put: grab, delete: grab }, requireRole: () => (req, res, next) => next(), ...env };
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (typeof handler !== "function") die("a lifted route did not register a handler");
	return (req) => {
		const out = { status: 200, body: null };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
			setHeader() {},
		};
		const full = { params: {}, query: {}, body: {}, sessionID: "t-sid", ...req };
		return Promise.resolve(handler(full, res)).then(() => out);
	};
}
// A route's catch logs to console.error, which is expected noise on a 500.
async function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = e; }
}

// The month-end locks answer "nothing blocked" and record what they were asked:
// `editLockSeen` the `changed` of each PUT, `createLockSeen` each POST's row.
function mountAll(db) {
	const m = buildModule(db);
	const seen = { editLockSeen: [], createLockSeen: [], activeLoad: 0 };
	const refuse = (req, res) => res.status(409).json({ code: "PERIOD_STUB" });
	const env = {
		db,
		...m,
		truckEditLockBlockers: (truck, changed) => { seen.editLockSeen.push({ ...changed }); return { unreadable: false, blockers: [] }; },
		truckCreateLockBlockers: (truck) => { seen.createLockSeen.push({ ...truck }); return { unreadable: false, blockers: [] }; },
		periodBlockedResponse: refuse,
		periodLockUnreadableResponse: refuse,
		truckChargeFromMonth: () => "",
		truckChargeUntilMonth: () => "",
		getJobTrackingCached: async () => ({ headers: ["Load ID", "Driver", "Assigned Date"], data: [] }),
		driverHistoryFloorMonth: () => ({ floor: "", unbounded: false }),
		checkDriverActiveLoad: async () => { seen.activeLoad++; await new Promise((done) => setImmediate(done)); return null; },
		fuelModel: { DEFAULT_TANK_GALLONS: 200 },
		notifyChange: () => {},
	};
	const put = mountRoute(ROUTES.put, env);
	const post = mountRoute(ROUTES.post, env);
	const as = (user) => ({ session: { user } });
	return {
		put: (user, id, body) => quiet(() => put({ ...as(user), params: { id: String(id) }, body })),
		post: (user, body) => quiet(() => post({ ...as(user), body })),
		seen,
		m,
	};
}

// ═══════════════════════════════════════════════════════════════ §1
function parserSection() {
	section("§1 parseTruckAmount() and TRUCK_AMOUNT_FIELDS");
	const { m } = mountAll(makeDb());
	const p = m.parseTruckAmount;
	ok(m.TRUCK_AMOUNT_MAX === 1_000_000, `§1 TRUCK_AMOUNT_MAX is 1,000,000 (got ${m.TRUCK_AMOUNT_MAX})`);

	const notSent = p(undefined);
	ok(notSent.value === undefined && !notSent.error && Object.prototype.hasOwnProperty.call(notSent, "value"),
		"§1 undefined (not sent) → { value: undefined }, no error");
	for (const [label, raw] of [["null", null], ['""', ""], ['"   "', "   "], ['"\\t\\n"', "\t\n"]]) {
		const r = p(raw);
		ok(r.value === 0 && !r.error, `§1 ${label} (blank) → { value: 0 } (got ${JSON.stringify(r)})`);
	}
	for (const [label, raw, expect] of [
		["0", 0, 0], ["5", 5, 5], ["12.5", 12.5, 12.5], ['"12.5"', "12.5", 12.5], ['" 12.5 "', " 12.5 ", 12.5],
		['"\\t42\\n"', "\t42\n", 42], ['"0"', "0", 0], ['".5"', ".5", 0.5], ['"1e3"', "1e3", 1000],
		["1_000_000 (the cap)", 1_000_000, 1_000_000], ['"1000000" (the cap, as text)', "1000000", 1_000_000],
		['" 1000000 "', " 1000000 ", 1_000_000],
	]) {
		const r = p(raw);
		ok(r.value === expect && !r.error, `§1 ${label} → { value: ${expect} } (got ${JSON.stringify(r)})`);
	}
	for (const [label, raw] of [["-0", -0], ['"-0"', "-0"]]) {
		const r = p(raw);
		ok(Object.is(r.value, 0) && !r.error, `§1 ${label} → +0, never -0 (got ${Object.is(r.value, -0) ? "-0" : JSON.stringify(r)})`);
	}
	for (const [label, raw] of [
		['"Infinity"', "Infinity"], ['"-Infinity"', "-Infinity"], ["Infinity", Infinity], ["-Infinity", -Infinity],
		["1e999 off the wire", WIRE_1E999], ['"1e999"', "1e999"], ["1e308", 1e308], ['"1e308"', "1e308"],
		["1_000_000.01 (a cent over the cap)", 1_000_000.01], ['"1000000.01"', "1000000.01"],
		["-5", -5], ['"-5"', "-5"], ["-0.01", -0.01], ["NaN", NaN], ['"NaN"', "NaN"],
		['"abc"', "abc"], ['"12abc"', "12abc"], ['"1 000"', "1 000"], ['"1,000"', "1,000"], ['"$100"', "$100"],
		["true", true], ["false", false], ["[]", []], ["[5]", [5]], ['["5"]', ["5"]], ["{}", {}], ["{ value: 5 }", { value: 5 }],
	]) {
		const r = p(raw);
		ok(typeof r.error === "string" && r.value === undefined, `§1 ${label} → { error } (got ${JSON.stringify(r)})`);
	}
	ok(p("abc").error === "Amount must be a number between 0 and 1,000,000", `§1 the default error text (got ${JSON.stringify(p("abc").error)})`);
	ok(p("abc", "Insurance").error === "Insurance must be a number between 0 and 1,000,000", "§1 ...and with a label");

	// The table: nine rows, their keys, the five fixed costs, the labels.
	const T = m.TRUCK_AMOUNT_FIELDS;
	ok(JSON.stringify(T.map((f) => [f.col, f.keys, f.fixed])) === JSON.stringify([
		["insurance_monthly", ["insuranceMonthly"], true], ["eld_monthly", ["eldMonthly"], true],
		["truck_payment_monthly", ["truckPaymentMonthly"], true], ["hvut_annual", ["hvutAnnual"], true], ["irp_annual", ["irpAnnual"], true],
		["purchase_price", ["purchasePrice"], false], ["maintenance_fund_monthly", ["maintenanceFundMonthly"], false],
		["fuel_tank_gallons", ["fuel_tank_gallons", "fuelTankGallons"], false], ["avg_mpg", ["avg_mpg", "avgMpg"], false],
	]), "§1 TRUCK_AMOUNT_FIELDS: the nine columns, their body keys, and the five fixed costs flagged");
	// The fixed-cost labels are the month-end lock's own wording, in both locks.
	for (const f of T.filter((x) => x.fixed)) {
		const tuple = `["${f.col}", "${f.label}"`;
		ok(SRC.split(tuple).length - 1 === 2, `§1 the ${f.col} label "${f.label}" is the one both month-end locks use`);
	}
	// Every row reads its key(s); the fuel pair as `snake ?? camel`.
	const one = (body, col) => m.parseTruckAmounts(body, T.filter((f) => f.col === col));
	for (const f of T) {
		for (const k of f.keys) {
			const r = one({ [k]: "7" }, f.col);
			ok(r.values && r.values[f.col] === 7, `§1 ${f.col} is read from ${k}`);
		}
	}
	for (const [label, body, expect] of [
		["snake_case wins over camelCase", { fuel_tank_gallons: 3, fuelTankGallons: 7 }, 3],
		["a null snake_case falls through to camelCase", { fuel_tank_gallons: null, fuelTankGallons: 7 }, 7],
		["a null snake_case with no camelCase is not sent", { fuel_tank_gallons: null }, undefined],
		["neither key is not sent", {}, undefined],
	]) {
		const r = one(body, "fuel_tank_gallons");
		ok(r.values && r.values.fuel_tank_gallons === expect, `§1 fuel tank keys: ${label} (got ${JSON.stringify(r)})`);
	}
	// The refusal body, per field.
	const LABELS = ["Insurance", "ELD fee", "Truck payment", "HVUT", "IRP", "Purchase price", "Maintenance fund", "Fuel tank", "Average MPG"];
	T.forEach((f, i) => {
		const r = one({ [f.keys[0]]: "abc" }, f.col);
		ok(JSON.stringify(r) === JSON.stringify({ refusal: { error: `${LABELS[i]} must be a number between 0 and 1,000,000`, code: "INVALID_AMOUNT", field: f.col } }),
			`§1 ${f.col}: the refusal body names "${LABELS[i]}" and the column (got ${JSON.stringify(r)})`);
	});
	const first = m.parseTruckAmounts({ insuranceMonthly: "abc", avgMpg: "abc" }, T);
	ok(first.refusal && first.refusal.field === "insurance_monthly", "§1 two bad fields: the first in table order is named");
}

// ═══════════════════════════════════════════════════════════════ §2
async function putRefusalSection() {
	section("§2 PUT /api/trucks/:id — refused amounts");
	ok(WIRE_1E999 === Infinity, "§2 (a JSON 1e999 parses to Infinity — the premise of the wire case)");
	for (const [label, who, over, field, name] of [
		['insurance "Infinity"', SUPER, { insuranceMonthly: "Infinity" }, "insurance_monthly", "Insurance"],
		['ELD fee "12abc"', SUPER, { eldMonthly: "12abc" }, "eld_monthly", "ELD fee"],
		["truck payment 1e308", SUPER, { truckPaymentMonthly: 1e308 }, "truck_payment_monthly", "Truck payment"],
		['HVUT "-Infinity"', SUPER, { hvutAnnual: "-Infinity" }, "hvut_annual", "HVUT"],
		["IRP true", DISPATCHER, { irpAnnual: true }, "irp_annual", "IRP"],
		["purchase price 1e999 off the wire", SUPER, { purchasePrice: WIRE_1E999 }, "purchase_price", "Purchase price"],
		["maintenance fund [800]", DISPATCHER, { maintenanceFundMonthly: [800] }, "maintenance_fund_monthly", "Maintenance fund"],
		['fuel tank "abc"', SUPER, { fuel_tank_gallons: "abc" }, "fuel_tank_gallons", "Fuel tank"],
		["fuel tank {} under the camelCase key", SUPER, { fuel_tank_gallons: undefined, fuelTankGallons: {} }, "fuel_tank_gallons", "Fuel tank"],
		["average MPG -5", SUPER, { avg_mpg: -5 }, "avg_mpg", "Average MPG"],
		['average MPG "1000000.01" under the camelCase key', DISPATCHER, { avg_mpg: null, avgMpg: "1000000.01" }, "avg_mpg", "Average MPG"],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const before = snapshot(db);
		const r = await app.put(who, 1, truckFormBody(truckRow(db, 1), { ...over, assignedDriver: "Bob Driver", notes: "swap" }));
		const b = r.body || {};
		ok(r.status === 400 && b.code === "INVALID_AMOUNT" && b.field === field && b.error === `${name} must be a number between 0 and 1,000,000`,
			`§2 PUT, ${label} (${who.role}): 400 INVALID_AMOUNT naming ${field} (got ${r.status} ${JSON.stringify(b)})`);
		ok(snapshot(db) === before, `§2 PUT, ${label}: nothing written — no amount, no note, no reassignment to Bob Driver, no directory row, no audit row`);
		ok(app.seen.editLockSeen.length === 0 && app.seen.activeLoad === 0, `§2 PUT, ${label}: refused before the month-end lock and the active-load check`);
	}
}

// ═══════════════════════════════════════════════════════════════ §3
async function putSuccessSection() {
	section("§3 PUT /api/trucks/:id — stored, and audited on a change");
	const costLines = (db) => audits(db, "update_truck_costs").map((a) => a.details);
	{
		// Insurance and IRP, sent as text the way a hand-typed body would.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, truckFormBody(truckRow(db, 1), { insuranceMonthly: " 1700 ", irpAnnual: "1500" }));
		const t = truckRow(db, 1);
		ok(r.status === 200 && t.insurance_monthly === 1700 && t.irp_annual === 1500,
			`§3 insurance + IRP changed: 200, stored as numbers (got ${r.status}, ${t.insurance_monthly}, ${t.irp_annual})`);
		const asked = app.seen.editLockSeen[0] || {};
		ok(app.seen.editLockSeen.length === 1 && asked.insurance_monthly === 1700 && asked.irp_annual === 1500 &&
			JSON.stringify(Object.keys(asked).sort()) === JSON.stringify(["insurance_monthly", "irp_annual"]),
			`§3 ...the month-end lock asked about exactly those two, parsed (got ${JSON.stringify(asked)})`);
		const rows = audits(db, "update_truck_costs");
		ok(rows.length === 1 && rows[0].details ===
			"Costs for LogisX-#33: insurance $1,630.00/mo → $1,700.00/mo, IRP $1,380.00/yr → $1,500.00/yr; fixed costs $3,043.33/mo → $3,123.33/mo",
			`§3 ...one update_truck_costs line naming both and the fixed-cost total (got ${JSON.stringify(rows.map((x) => x.details))})`);
		ok(rows.length === 1 && rows[0].entity === "truck" && rows[0].entity_id === "1" && rows[0].username === "super_admin" && rows[0].role === "Super Admin",
			"§3 ...on the truck, under the account that saved it");
		// The same body again: nothing changes, so nothing is written to the log.
		const again = await app.put(SUPER, 1, truckFormBody(truckRow(db, 1)));
		ok(again.status === 200 && costLines(db).length === 1, `§3 the same save resent: 200 and NO new cost line (got ${again.status}, ${costLines(db).length} lines)`);
		// A notes-only save by a Dispatcher, and a body that leaves every amount out.
		const notes = await app.put(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { notes: "new tires" }));
		const bare = await app.put(DISPATCHER, 1, { notes: "rotated" });
		const t2 = truckRow(db, 1);
		ok(notes.status === 200 && bare.status === 200 && t2.notes === "rotated" && costLines(db).length === 1 &&
			JSON.stringify(fiveOf(t2)) === JSON.stringify([1700, 50, 1200, 580, 1500]) && t2.purchase_price === 85000 && t2.fuel_tank_gallons === 203,
			`§3 a notes-only save and a body with no amounts: saved, amounts left alone, no cost line (got ${notes.status}/${bare.status}, ${costLines(db).length} lines)`);
	}
	for (const [label, who, over, line, stored] of [
		["the purchase price alone", SUPER, { purchasePrice: 90000 },
			"Costs for LogisX-#33: purchase price $85,000.00 → $90,000.00", (t) => t.purchase_price === 90000],
		["the maintenance fund, by a Dispatcher", DISPATCHER, { maintenanceFundMonthly: "900" },
			"Costs for LogisX-#33: maintenance fund $800.00/mo → $900.00/mo", (t) => t.maintenance_fund_monthly === 900],
		["HVUT (annual)", SUPER, { hvutAnnual: 600 },
			"Costs for LogisX-#33: HVUT $580.00/yr → $600.00/yr; fixed costs $3,043.33/mo → $3,045.00/mo", (t) => t.hvut_annual === 600],
		["insurance cleared (\"\")", SUPER, { insuranceMonthly: "" },
			"Costs for LogisX-#33: insurance $1,630.00/mo → $0.00/mo; fixed costs $3,043.33/mo → $1,413.33/mo", (t) => t.insurance_monthly === 0],
		["insurance up and the truck payment down by the same $100 (the total still named)", SUPER, { insuranceMonthly: 1730, truckPaymentMonthly: 1100 },
			"Costs for LogisX-#33: insurance $1,630.00/mo → $1,730.00/mo, truck payment $1,200.00/mo → $1,100.00/mo; fixed costs $3,043.33/mo → $3,043.33/mo",
			(t) => t.insurance_monthly === 1730 && t.truck_payment_monthly === 1100],
		["the admin fee 50 → 45", DISPATCHER, { adminFeePct: 45 },
			"Costs for LogisX-#33: admin fee 50% → 45%", (t) => t.admin_fee_pct === 45],
		["every cost at once", SUPER, {
			insuranceMonthly: 1700, eldMonthly: 60, truckPaymentMonthly: 1300, hvutAnnual: 600, irpAnnual: 1500,
			purchasePrice: 90000, maintenanceFundMonthly: 900, adminFeePct: 45,
		}, "Costs for LogisX-#33: insurance $1,630.00/mo → $1,700.00/mo, ELD fee $50.00/mo → $60.00/mo, truck payment $1,200.00/mo → $1,300.00/mo, " +
			"HVUT $580.00/yr → $600.00/yr, IRP $1,380.00/yr → $1,500.00/yr, purchase price $85,000.00 → $90,000.00, " +
			"maintenance fund $800.00/mo → $900.00/mo, admin fee 50% → 45%; fixed costs $3,043.33/mo → $3,235.00/mo",
			(t) => JSON.stringify(fiveOf(t)) === JSON.stringify([1700, 60, 1300, 600, 1500]) && t.admin_fee_pct === 45],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(who, 1, truckFormBody(truckRow(db, 1), over));
		const lines = costLines(db);
		ok(r.status === 200 && stored(truckRow(db, 1)), `§3 ${label}: 200 and stored (got ${r.status} ${JSON.stringify(r.body)})`);
		ok(lines.length === 1 && lines[0] === line, `§3 ${label}: exactly one cost line, ${JSON.stringify(line)} (got ${JSON.stringify(lines)})`);
	}
	{
		// A legacy NULL admin fee reads as its 50: the form resends 50 (or a blank,
		// which is 50) without a line; a real change is named from 50.
		const db = makeDb();
		const app = mountAll(db);
		const a = await app.put(SUPER, 2, truckFormBody(truckRow(db, 2)));
		const b = await app.put(SUPER, 2, truckFormBody(truckRow(db, 2), { adminFeePct: "" }));
		ok(a.status === 200 && b.status === 200 && costLines(db).length === 0 && truckRow(db, 2).admin_fee_pct === 50,
			`§3 a stored NULL admin fee resent as 50, then blank: no cost line (got ${a.status}/${b.status}, ${JSON.stringify(costLines(db))})`);
		db.prepare("UPDATE trucks SET admin_fee_pct = NULL WHERE id = 2").run();
		const c = await app.put(SUPER, 2, truckFormBody(truckRow(db, 2), { adminFeePct: 45 }));
		ok(c.status === 200 && JSON.stringify(costLines(db)) === JSON.stringify(["Costs for Logisx-#91: admin fee 50% → 45%"]),
			`§3 a stored NULL admin fee changed to 45: named from 50 (got ${JSON.stringify(costLines(db))})`);
	}
	{
		// The fuel tank keeps its own line; it is not a cost.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, truckFormBody(truckRow(db, 1), { fuel_tank_gallons: "189", insuranceMonthly: 1700 }));
		const tank = audits(db, "update_truck_fuel_tank").map((a) => a.details);
		const lines = costLines(db);
		ok(r.status === 200 && truckRow(db, 1).fuel_tank_gallons === 189 && JSON.stringify(tank) === JSON.stringify(["Fuel tank for LogisX-#33: 203 gal → 189 gal"]) &&
			lines.length === 1 && !/fuel|tank/i.test(lines[0]),
			`§3 a fuel tank change beside a cost change: its own line, not in the cost line (got ${JSON.stringify(tank)} / ${JSON.stringify(lines)})`);
	}
	{
		// The cap itself is an amount.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, truckFormBody(truckRow(db, 1), { purchasePrice: "1000000" }));
		ok(r.status === 200 && truckRow(db, 1).purchase_price === 1_000_000, `§3 a purchase price of exactly 1,000,000: stored (got ${r.status})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §4
async function postSection() {
	section("§4 POST /api/trucks");
	for (const [label, who, over, field] of [
		['a Super Admin, insurance "Infinity"', SUPER, { insuranceMonthly: "Infinity" }, "insurance_monthly"],
		["a Super Admin, IRP 1e999 off the wire", SUPER, { irpAnnual: WIRE_1E999 }, "irp_annual"],
		['a Dispatcher, truck payment "12abc"', DISPATCHER, { truckPaymentMonthly: "12abc" }, "truck_payment_monthly"],
		["a Super Admin, fuel tank -1", SUPER, { fuel_tank_gallons: -1 }, "fuel_tank_gallons"],
		['an Investor, purchase price "Infinity"', INVESTOR, { purchasePrice: "Infinity", driverPayDaily: undefined }, "purchase_price"],
		["an Investor, maintenance fund 1e308", INVESTOR, { maintenanceFundMonthly: 1e308, driverPayDaily: undefined }, "maintenance_fund_monthly"],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const before = snapshot(db);
		const r = await app.post(who, addForm({ ...over, assignedDriver: who === INVESTOR ? "" : "Bob Driver" }));
		const b = r.body || {};
		ok(r.status === 400 && b.code === "INVALID_AMOUNT" && b.field === field && /must be a number between 0 and 1,000,000$/.test(b.error || ""),
			`§4 POST by ${label}: 400 INVALID_AMOUNT naming ${field} (got ${r.status} ${JSON.stringify(b)})`);
		ok(snapshot(db) === before && !truckByUnit(db, "500"), `§4 POST by ${label}: no truck, no assignment, no audit row`);
		ok(app.seen.createLockSeen.length === 0 && app.seen.activeLoad === 0, `§4 POST by ${label}: refused before the lock and the active-load check`);
	}
	{
		// An Investor's add stores none of the five fixed costs, so junk in them is
		// not read and cannot refuse it.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(INVESTOR, addForm({
			insuranceMonthly: "Infinity", eldMonthly: "abc", truckPaymentMonthly: -5, hvutAnnual: [1], irpAnnual: WIRE_1E999, driverPayDaily: undefined,
		}));
		const t = truckByUnit(db, "500");
		ok(r.status === 200 && !!t && JSON.stringify(fiveOf(t)) === JSON.stringify([0, 0, 0, 0, 0]) && t.owner_id === 9,
			`§4 POST by an Investor with junk fixed costs: 200, the five stored as 0, owned by the investor (got ${r.status} ${JSON.stringify(r.body)}, ${JSON.stringify(fiveOf(t))})`);
		ok(JSON.stringify(fiveOf(app.seen.createLockSeen[0])) === JSON.stringify([0, 0, 0, 0, 0]), "§4 ...and the create lock asked about $0");
	}
	for (const [label, who] of [["a Super Admin", SUPER], ["a Dispatcher", DISPATCHER]]) {
		// Text, padding and a blank, parsed once: the lock and the INSERT see the
		// same numbers.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(who, addForm({
			insuranceMonthly: " 1630 ", eldMonthly: "50", truckPaymentMonthly: 1200, hvutAnnual: "580", irpAnnual: "1380",
			purchasePrice: "85000", maintenanceFundMonthly: "", fuel_tank_gallons: "203", avg_mpg: 6.5,
		}));
		const t = truckByUnit(db, "500") || {};
		ok(r.status === 200 && JSON.stringify(fiveOf(t)) === JSON.stringify([1630, 50, 1200, 580, 1380]) &&
			t.purchase_price === 85000 && t.maintenance_fund_monthly === 0 && t.fuel_tank_gallons === 203 && t.avg_mpg === 6.5,
			`§4 POST by ${label} with amounts as text: stored as numbers, the blank as 0 (got ${r.status} ${JSON.stringify(r.body)})`);
		const asked = app.seen.createLockSeen[0] || {};
		ok(app.seen.createLockSeen.length === 1 && JSON.stringify(fiveOf(asked)) === JSON.stringify([1630, 50, 1200, 580, 1380]),
			`§4 POST by ${label}: the create lock asked about the same parsed five (got ${JSON.stringify(fiveOf(asked))})`);
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(line.endsWith(", fixed costs: $3,043.33/mo"), `§4 POST by ${label}: the create_truck line names $3,043.33/mo (got ${JSON.stringify(line)})`);
	}
	{
		// A body that leaves every amount out is a truck at $0.
		const db = makeDb();
		const app = mountAll(db);
		const bare = addForm();
		for (const k of ["insuranceMonthly", "eldMonthly", "truckPaymentMonthly", "hvutAnnual", "irpAnnual", "purchasePrice", "maintenanceFundMonthly", "fuel_tank_gallons", "avg_mpg"]) delete bare[k];
		const r = await app.post(SUPER, bare);
		const t = truckByUnit(db, "500") || {};
		ok(r.status === 200 && JSON.stringify([...fiveOf(t), t.purchase_price, t.maintenance_fund_monthly, t.fuel_tank_gallons, t.avg_mpg]) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0]),
			`§4 POST with every amount left out: 200, each 0 (got ${r.status} ${JSON.stringify(r.body)})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §5
function sourcePins() {
	section("§5 source pins");
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const put = code(ROUTES.put);
	const post = code(ROUTES.post);
	const at = (src, s) => src.indexOf(s);

	const pParse = at(put, "parseTruckAmounts(req.body, TRUCK_AMOUNT_FIELDS)");
	ok(pParse > 0 && pParse < at(put, "truckEditLockBlockers(") && pParse < at(put, "await ") &&
		pParse < at(put, "assignDriverToTruck(") && pParse < at(put, "db.prepare(`UPDATE trucks SET"),
		"§5 PUT parses all nine before its month-end lock, its await, the assignment and the UPDATE");
	ok(!/parseFloat\((?!truck\.)/.test(put), "§5 PUT reads no sent value through parseFloat (only the stored tank and MPG, for their own lines)");
	for (const col of ["insurance_monthly", "eld_monthly", "truck_payment_monthly", "hvut_annual", "irp_annual",
		"purchase_price", "maintenance_fund_monthly", "fuel_tank_gallons", "avg_mpg"]) {
		ok(put.includes(`if (amount.${col} !== undefined) { updates.push("${col} = ?"); params.push(amount.${col}); }`),
			`§5 PUT writes ${col} as parsed, and only when it was sent`);
	}
	for (const col of ["insurance_monthly", "eld_monthly", "truck_payment_monthly", "hvut_annual", "irp_annual"]) {
		ok(put.includes(`if (amount.${col} !== undefined) diff("${col}", amount.${col});`), `§5 PUT hands the lock ${col} as parsed`);
	}

	const addAt = at(post, "parseTruckAmounts(req.body, TRUCK_AMOUNT_FIELDS.filter((f) => !f.fixed))");
	const costAt = at(post, "costsAllowed ? parseTruckAmounts(req.body, TRUCK_AMOUNT_FIELDS.filter((f) => f.fixed)) : { values: {} }");
	ok(addAt > 0 && addAt < at(post, "refusePayEdit("), "§5 POST parses the four every-role amounts before the pay check");
	ok(costAt > addAt && costAt > at(post, "const costsAllowed = ") && costAt < at(post, "await ") &&
		costAt < at(post, "truckCreateLockBlockers(") && costAt < at(post, "INSERT INTO trucks"),
		"§5 POST parses the five fixed costs only for the roles that store them, before its await, its lock and its INSERT");
	ok(!/parseFloat\(/.test(post), "§5 POST reads no amount through parseFloat");
	ok((SRC.match(/"update_truck_costs"/g) || []).length === 1, "§5 exactly one writer of update_truck_costs");
	console.log("  source pins checked");
}

(async () => {
	parserSection();
	await putRefusalSection();
	await putSuccessSection();
	await postSection();
	sourcePins();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`✗ ${failures.length} assertion(s) failed, ${pass} passed:`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
