#!/usr/bin/env node
/**
 * A truck's unit number and VIN are on the audit trail: PUT /api/trucks/:id
 * writes one line for each that a save really changes, old -> new, after the
 * write; POST /api/trucks and DELETE /api/trucks/:id name the VIN beside the
 * unit number they already name.
 *
 * WHY. The edit route wrote both columns with no audit row, while it audited the
 * pay rate, status, dates, owner, costs, tank and MPG beside them. A truck was
 * renamed three times with no trail, and a load's Truck cell still read a name
 * that no longer matched any truck, with nothing to say when or by whom the
 * name changed.
 *
 * WHAT IS ASSERTED. The three shipped truck handlers, lifted out of server.js
 * and run against an in-memory SQLite with server.js's own parsers, audit
 * writer, name helpers, directory sync and truck assignment. The month-end
 * locks, the active-load check, the Job Tracking read and the socket
 * notification are stubbed.
 *   §1 PUT renames: one update_truck_unit_number line naming the number as
 *      stored and the new one, under the account that saved it; a case-only
 *      rename counts; the stored number resent (as stored, padded, or in a
 *      whole-row body) writes none; a rename refused because another truck
 *      holds the number, an unreadable number, an unknown truck or the
 *      month-end lock writes none and changes nothing.
 *   §2 PUT VINs: one update_truck_vin line when the VIN is set, changed or
 *      cleared, naming the truck by its number as stored before the save; a
 *      resend (exact or padded) writes none and leaves the stored VIN byte for
 *      byte as it was (a VIN stored padded before the trim stays as stored); a
 *      change sent padded is stored trimmed and its line names the trimmed
 *      values; a save that renames and changes the VIN writes one of each; a
 *      refused save carrying a VIN change writes none and leaves the VIN as it
 *      was.
 *   §3 POST: the create_truck line names the VIN when one is set, and is the
 *      line it always was when none is; a VIN sent padded is stored trimmed.
 *   §4 DELETE: the delete_truck line names the deleted truck's VIN when it had
 *      one, and is the line it always was when it had none.
 *   §5 Trailers, the same VIN rule: POST /api/trailers stores a padded VIN
 *      trimmed; PUT /api/trailers/:id keeps the stored VIN as it is on a padded
 *      resend or a save that sends none, and stores a real change trimmed.
 *
 * Pure: no server, no app.db, no network. Made-up trucks and names.
 *
 *   node scripts/test-truck-identity-audit.js     # exits 1 on failure
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
	del: liftRoute('app.delete("/api/trucks/:id", requireRole("Super Admin"), (req, res) => {'),
	trailerPost: liftRoute('app.post("/api/trailers", requireRole("Super Admin", "Dispatcher"), (req, res) => {'),
	trailerPut: liftRoute('app.put("/api/trailers/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {'),
};

// Everything the three routes call from module scope, verbatim.
const MODULE_SRC = [
	liftFunction("parsePlainDecimal"),
	liftConst("const TRUCK_AMOUNT_MAX = "),
	liftFunction("parseTruckAmount"),
	liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"),
	liftFunction("parseTruckAmounts"),
	liftFunction("parseUnitNumber"),
	liftFunction("isUnitNumberTaken"),
	liftConst("const DRIVER_PAY_DAILY_MAX = "),
	liftFunction("parseDriverPayDaily"),
	liftConst("const IN_SERVICE_MAX_MONTHS_AHEAD = "),
	liftFunction("parseInServiceDate"),
	liftFunction("parseRetiredAt"),
	liftConst("const ADMIN_FEE_PCT_MAX = "),
	liftFunction("parseAdminFeePct"),
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
	liftFunction("isBuiltInPropertyName"),
	liftFunction("reservedDriverNameRefusal"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	liftFunction("driverNameHeldByOtherAccount"),
	liftFunction("canonicalDriverName"),
	liftFunction("findDirectoryRowForDriver"),
	liftFunction("findTruckForDriver"),
	liftFunction("syncDriverToCarrierSheet"),
	liftFunction("driverNameHeldByOtherSpelling"),
	liftFunction("assignDriverToTruck"),
	liftFunction("syncOpenCarrierPairing"),
].join("\n");
const MODULE_EXPORTS = [
	"parseTruckAmount", "TRUCK_AMOUNT_FIELDS", "parseTruckAmounts", "parseUnitNumber", "isUnitNumberTaken",
	"parseDriverPayDaily", "parseInServiceDate", "parseRetiredAt", "parseAdminFeePct", "truckMonthlyFixed",
	"refusePayEdit", "logAudit", "auditText",
	"normalizeDriverName", "reservedDriverNameRefusal", "canonicalDriverName",
	"syncDriverToCarrierSheet", "assignDriverToTruck",
];
function buildModule(db) {
	return new Function("db", "appTodayKey",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(db, () => "2026-10-19");
}
const imageLimits = require(path.join(__dirname, "..", "lib", "image-size"));
const PHOTO_CHECK = new Function("imageLimits",
	`"use strict";\n${liftFunction("storedFileForServing")}\n${liftFunction("truckPhotoForStorage")}\nreturn { storedFileForServing, truckPhotoForStorage };`
)(imageLimits);

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
function trailersDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS trailers \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE trailers");
	return `CREATE TABLE trailers (${m[1]}\n)`;
}
const DDL = [
	...usersDdl(),
	auditDdl(),
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
		hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL DEFAULT 50, created_at TEXT DEFAULT '',
		routemate_vehicle_id TEXT DEFAULT '')`,
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT)",
	// What DELETE /api/trucks/:id reads or cascades through, and what the two
	// trailer routes write (server.js's own trailers table).
	trailersDdl(),
	"CREATE TABLE legal_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER)",
	"CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT)",
	"CREATE TABLE compliance_fees (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT)",
];

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };
const VIN_A = "1FUJGLDR5CLBP0001";
const VIN_B = "3AKJHHDR7KSKA0002";

// LogisX-#41 has a driver (Soren King) and a VIN; LogisX-#91 has neither and
// no assignment history, so it can be deleted.
function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, full_name, company_name) VALUES (?, ?, 'x', ?, ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "", "");
	user.run(2, "kevin", "Dispatcher", "", "Kevin Dispatch", "");
	user.run(3, "sking", "Driver", "Soren King", "Soren King", "");
	user.run(5, "acme", "Investor", "", "Acme Holdings", "Acme Holdings");
	db.prepare("INSERT INTO drivers_directory (id, driver_name, city, state, trucks) VALUES (1, 'Soren King', 'Houston', 'TX', 'LogisX-#41')").run();
	db.prepare(`INSERT INTO trucks (id, unit_number, make, model, year, vin, status, assigned_driver, owner_id, driver_pay_daily, created_at)
		VALUES (1, 'LogisX-#41', 'Freightliner', 'Cascadia', 2021, ?, 'Active', 'Soren King', 5, 250, '2026-04-15 03:10:50')`).run(VIN_A);
	db.prepare(`INSERT INTO trucks (id, unit_number, make, status, assigned_driver, owner_id, created_at)
		VALUES (2, 'LogisX-#91', 'Volvo', 'Active', '', 5, '2026-05-21 12:07:08')`).run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Soren King', '2026-09-01')").run();
	db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES ('Acme Holdings', 'Soren King', '2026-09-01')").run();
	return db;
}

const truckRow = (db, id) => db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const identityRows = (db) => db.prepare("SELECT action FROM audit_trail WHERE action IN ('update_truck_unit_number', 'update_truck_vin') ORDER BY id").all().map((r) => r.action);
const snapshot = (db) => JSON.stringify({
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	assignments: db.prepare("SELECT * FROM truck_assignments ORDER BY id").all(),
	directory: db.prepare("SELECT * FROM drivers_directory ORDER BY id").all(),
	audit: db.prepare("SELECT * FROM audit_trail ORDER BY id").all(),
});

// A whole-row save body, from the stored row: every field, as an older page or
// a direct API caller may still send it. `over` replaces or (with undefined)
// removes a key.
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
		unitNumber: "LogisX-#23", make: "Volvo", model: "VNL 760", year: 2024, vin: "", licensePlate: "", status: "Active",
		assignedDriver: "", ownerId: 5, notes: "", driverPayDaily: 0, in_service_date: "", inServiceDate: "",
		insuranceMonthly: 0, eldMonthly: 0, truckPaymentMonthly: 0, hvutAnnual: 0, irpAnnual: 0, adminFeePct: 50,
		purchasePrice: 0, titleStatus: "Clean", maintenanceFundMonthly: 0, fuel_tank_gallons: 0, avg_mpg: 0,
	};
	for (const [k, v] of Object.entries(over)) { if (v === undefined) delete b[k]; else b[k] = v; }
	return b;
}

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
async function quiet(fn) {
	const loud = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = loud; }
}

// `blockEdit`, when set, makes the month-end lock refuse every PUT, as a
// closed month would.
function mountAll(db, { blockEdit = false } = {}) {
	const m = buildModule(db);
	const refuse = (req, res, title, blockers, remedy, audit) => {
		if (audit) db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, 'stub', 'stub', ?, ?, ?, ?)")
			.run(new Date().toISOString(), audit.action, audit.entity, audit.entityId, audit.subject);
		return res.status(409).json({ code: "PERIOD_FINALIZED" });
	};
	const env = {
		db,
		...m,
		...PHOTO_CHECK,
		truckEditLockBlockers: () => ({ unreadable: false, blockers: blockEdit ? [{ field: "unit_number", month: "2026-09" }] : [] }),
		truckCreateLockBlockers: () => ({ unreadable: false, blockers: [] }),
		truckDeleteLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodBlockedResponse: refuse,
		periodLockUnreadableResponse: refuse,
		truckChargeFromMonth: () => "",
		truckChargeUntilMonth: () => "",
		getJobTrackingCached: async () => ({ headers: ["Load ID", "Driver", "Assigned Date"], data: [] }),
		driverHistoryFloorMonth: () => ({ floor: "", unbounded: false }),
		checkDriverActiveLoad: async () => null,
		fuelModel: { DEFAULT_TANK_GALLONS: 200 },
		notifyChange: () => {},
		recordPayRateChanges: () => {},
	};
	const put = mountRoute(ROUTES.put, env);
	const post = mountRoute(ROUTES.post, env);
	const del = mountRoute(ROUTES.del, env);
	const trailerPost = mountRoute(ROUTES.trailerPost, env);
	const trailerPut = mountRoute(ROUTES.trailerPut, env);
	const as = (user) => ({ session: { user } });
	return {
		put: (user, id, body) => quiet(() => put({ ...as(user), params: { id: String(id) }, body })),
		post: (user, body) => quiet(() => post({ ...as(user), body })),
		del: (user, id) => quiet(() => del({ ...as(user), params: { id: String(id) } })),
		trailerPost: (user, body) => quiet(() => trailerPost({ ...as(user), body })),
		trailerPut: (user, id, body) => quiet(() => trailerPut({ ...as(user), params: { id: String(id) }, body })),
	};
}

// ═══════════════════════════════════════════════════════════════ §1
async function renameSection() {
	section("§1 PUT /api/trucks/:id — a unit-number rename is audited, old -> new");
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, { unitNumber: "LogisX-#42" });
		const rows = audits(db, "update_truck_unit_number");
		ok(r.status === 200 && truckRow(db, 1).unit_number === "LogisX-#42", `§1 a rename: 200 and renamed (got ${r.status} ${JSON.stringify(r.body)})`);
		ok(rows.length === 1, `§1 a rename writes exactly one update_truck_unit_number row (got ${rows.length})`);
		const row = rows[0] || {};
		ok(row.entity === "truck" && row.entity_id === "1", `§1 ...on the truck's own entity and id (got ${row.entity} ${row.entity_id})`);
		ok(row.details === "Unit number for truck #1: LogisX-#41 → LogisX-#42", `§1 ...naming the number as stored and the new one (got ${JSON.stringify(row.details)})`);
		ok(row.username === "super_admin" && row.role === "Super Admin", `§1 ...under the account that saved it (got ${row.username} / ${row.role})`);
		ok(identityRows(db).join() === "update_truck_unit_number", `§1 ...and no VIN line (got ${identityRows(db).join()})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(DISPATCHER, 1, { unitNumber: "LOGISX-#41" });
		const row = audits(db, "update_truck_unit_number")[0] || {};
		ok(r.status === 200 && audits(db, "update_truck_unit_number").length === 1 && row.details === "Unit number for truck #1: LogisX-#41 → LOGISX-#41" && row.role === "Dispatcher",
			`§1 a case-only rename by a Dispatcher is a rename: one line (got ${r.status}, ${JSON.stringify(row.details)}, ${row.role})`);
	}
	for (const [label, body] of [
		["the number resent as stored", () => ({ unitNumber: "LogisX-#41", notes: "new tires" })],
		["the number resent padded", () => ({ unitNumber: "  LogisX-#41  " })],
		["a whole-row resend", (db) => truckFormBody(truckRow(db, 1))],
		["a notes-only save", () => ({ notes: "new tires" })],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, body(db));
		ok(r.status === 200 && truckRow(db, 1).unit_number === "LogisX-#41" && identityRows(db).length === 0,
			`§1 ${label}: 200 and no unit-number or VIN line (got ${r.status}, ${identityRows(db).join()})`);
	}
	for (const [label, id, body, status, opts] of [
		["another truck's number, in another case", 1, { unitNumber: "logisx-#91" }, 400, {}],
		["an unreadable number", 1, { unitNumber: "=HYPERLINK(1)" }, 400, {}],
		["a blank number", 1, { unitNumber: "   " }, 400, {}],
		["an unknown truck", 99, { unitNumber: "LogisX-#42" }, 404, {}],
		["a rename the month-end lock refuses", 1, { unitNumber: "LogisX-#42" }, 409, { blockEdit: true }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const trucksBefore = JSON.stringify(db.prepare("SELECT * FROM trucks ORDER BY id").all());
		const r = await app.put(SUPER, id, body);
		ok(r.status === status && identityRows(db).length === 0 && JSON.stringify(db.prepare("SELECT * FROM trucks ORDER BY id").all()) === trucksBefore,
			`§1 a refused rename (${label}): ${status}, no unit-number line, the trucks unchanged (got ${r.status} ${JSON.stringify(r.body)}, ${identityRows(db).join()})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const before = snapshot(db);
		const r = await app.put(SUPER, 1, { unitNumber: "LogisX-#91" });
		ok(r.status === 400 && snapshot(db) === before, `§1 a refused rename writes nothing at all (got ${r.status})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §2
async function vinSection() {
	section("§2 PUT /api/trucks/:id — a VIN change is audited, old -> new");
	for (const [label, id, vin, details] of [
		["a VIN changed", 1, VIN_B, `VIN for LogisX-#41: ${VIN_A} → ${VIN_B}`],
		["a VIN set on a truck that had none", 2, VIN_B, `VIN for LogisX-#91: not set → ${VIN_B}`],
		["a VIN cleared", 1, "", `VIN for LogisX-#41: ${VIN_A} → not set`],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(DISPATCHER, id, { vin });
		const rows = audits(db, "update_truck_vin");
		const row = rows[0] || {};
		ok(r.status === 200 && truckRow(db, id).vin === vin, `§2 ${label}: 200 and stored (got ${r.status} ${JSON.stringify(r.body)})`);
		ok(rows.length === 1 && row.entity === "truck" && row.entity_id === String(id) && row.details === details && row.username === "kevin",
			`§2 ${label}: exactly one update_truck_vin line, ${JSON.stringify(details)} (got ${rows.length}, ${JSON.stringify(row.details)})`);
		ok(identityRows(db).join() === "update_truck_vin", `§2 ${label}: no unit-number line (got ${identityRows(db).join()})`);
	}
	for (const [label, body] of [
		["the VIN resent as stored", () => ({ vin: VIN_A })],
		["the VIN resent padded", () => ({ vin: ` ${VIN_A} ` })],
		["the VIN resent padded with a tab and a line break", () => ({ vin: `\t${VIN_A}\r\n` })],
		["a whole-row resend", (db) => truckFormBody(truckRow(db, 1))],
		["a whole-row resend with the VIN padded", (db) => truckFormBody(truckRow(db, 1), { vin: `  ${VIN_A}  ` })],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, body(db));
		ok(r.status === 200 && audits(db, "update_truck_vin").length === 0, `§2 ${label}: 200 and no VIN line (got ${r.status}, ${audits(db, "update_truck_vin").length})`);
		ok(truckRow(db, 1).vin === VIN_A, `§2 ${label}: the stored VIN unchanged, byte for byte (got ${JSON.stringify(truckRow(db, 1).vin)})`);
	}
	// A VIN stored padded before the trim: a resend of the same VIN, trimmed or
	// padded, is no change, so the stored value is kept exactly as it is.
	for (const sent of [VIN_A, ` ${VIN_A}`]) {
		const db = makeDb();
		db.prepare("UPDATE trucks SET vin = ? WHERE id = 1").run(`${VIN_A}  `);
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, { vin: sent });
		ok(r.status === 200 && audits(db, "update_truck_vin").length === 0 && truckRow(db, 1).vin === `${VIN_A}  `,
			`§2 a VIN stored padded, resent as ${JSON.stringify(sent)}: 200, no VIN line, the stored value kept as it is (got ${r.status}, ${audits(db, "update_truck_vin").length}, ${JSON.stringify(truckRow(db, 1).vin)})`);
	}
	for (const [label, id, vin, stored, details] of [
		["a VIN changed, sent padded", 1, `  ${VIN_B}\t`, VIN_B, `VIN for LogisX-#41: ${VIN_A} → ${VIN_B}`],
		["a VIN set, sent padded, on a truck that had none", 2, ` ${VIN_B} `, VIN_B, `VIN for LogisX-#91: not set → ${VIN_B}`],
		["a VIN cleared with spaces only", 1, "   ", "", `VIN for LogisX-#41: ${VIN_A} → not set`],
	]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(DISPATCHER, id, { vin });
		const rows = audits(db, "update_truck_vin");
		ok(r.status === 200 && truckRow(db, id).vin === stored, `§2 ${label}: 200 and stored trimmed, ${JSON.stringify(stored)} (got ${r.status}, ${JSON.stringify(truckRow(db, id).vin)})`);
		ok(rows.length === 1 && (rows[0] || {}).details === details,
			`§2 ${label}: one update_truck_vin line with the trimmed values, ${JSON.stringify(details)} (got ${rows.length}, ${JSON.stringify((rows[0] || {}).details)})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 2, { vin: "" });
		ok(r.status === 200 && audits(db, "update_truck_vin").length === 0, `§2 a blank VIN sent to a truck with none: no VIN line (got ${r.status}, ${audits(db, "update_truck_vin").length})`);
	}
	{
		// A rename and a VIN change in one save: one line each, and the VIN line
		// names the truck by the number it had before this save, as every truck
		// line does.
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.put(SUPER, 1, truckFormBody(truckRow(db, 1), { unitNumber: "LogisX-#42", vin: VIN_B }));
		ok(r.status === 200 && identityRows(db).join() === "update_truck_unit_number,update_truck_vin",
			`§2 a rename and a VIN change in one save: one line each (got ${r.status}, ${identityRows(db).join()})`);
		ok((audits(db, "update_truck_unit_number")[0] || {}).details === "Unit number for truck #1: LogisX-#41 → LogisX-#42" &&
			(audits(db, "update_truck_vin")[0] || {}).details === `VIN for LogisX-#41: ${VIN_A} → ${VIN_B}`,
		`§2 ...the VIN line naming the truck as it was stored (got ${JSON.stringify(db.prepare("SELECT details FROM audit_trail ORDER BY id").all())})`);
	}
	for (const [label, body, status, opts] of [
		["with an unreadable amount", { vin: VIN_B, insuranceMonthly: "abc" }, 400, {}],
		["with another truck's number", { vin: VIN_B, unitNumber: "LogisX-#91" }, 400, {}],
		["that the month-end lock refuses", { vin: VIN_B, unitNumber: "LogisX-#42" }, 409, { blockEdit: true }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.put(SUPER, 1, body);
		ok(r.status === status && audits(db, "update_truck_vin").length === 0 && truckRow(db, 1).vin === VIN_A,
			`§2 a refused save carrying a VIN change (${label}): ${status}, no VIN line, the VIN as it was (got ${r.status}, ${audits(db, "update_truck_vin").length}, ${truckRow(db, 1).vin})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §3
async function createSection() {
	section("§3 POST /api/trucks — the create_truck line names the VIN when one is set");
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(SUPER, addForm({ vin: VIN_B }));
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(r.status === 200 && line === `Created truck LogisX-#23 (Active), in-service date: unset (falls back to created_at), fixed costs: $0.00/mo, VIN ${VIN_B}`,
			`§3 a truck added with a VIN: the line names it (got ${r.status}, ${JSON.stringify(line)})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(SUPER, addForm());
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(r.status === 200 && line === "Created truck LogisX-#23 (Active), in-service date: unset (falls back to created_at), fixed costs: $0.00/mo",
			`§3 a truck added with no VIN: the line it always was (got ${r.status}, ${JSON.stringify(line)})`);
	}
	// The Investor's My Trucks form sends the VIN as typed.
	for (const user of [SUPER, { id: 5, username: "acme", role: "Investor" }]) {
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(user, addForm({ vin: `  ${VIN_B} ` }));
		const t = db.prepare("SELECT * FROM trucks WHERE unit_number = 'LogisX-#23'").get() || {};
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(r.status === 200 && t.vin === VIN_B && line.endsWith(`, VIN ${VIN_B}`),
			`§3 a truck added by a ${user.role} with a padded VIN: stored trimmed and named trimmed (got ${r.status} ${JSON.stringify(r.body)}, ${JSON.stringify(t.vin)}, ${JSON.stringify(line)})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.post(SUPER, addForm({ vin: "   " }));
		const t = db.prepare("SELECT * FROM trucks WHERE unit_number = 'LogisX-#23'").get() || {};
		ok(r.status === 200 && t.vin === "", `§3 a truck added with a VIN of spaces only: stored blank (got ${r.status}, ${JSON.stringify(t.vin)})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §4
async function deleteSection() {
	section("§4 DELETE /api/trucks/:id — the delete_truck line names the VIN the truck had");
	{
		const db = makeDb();
		db.prepare("UPDATE trucks SET vin = ? WHERE id = 2").run(VIN_B);
		const app = mountAll(db);
		const r = await app.del(SUPER, 2);
		const line = (audits(db, "delete_truck")[0] || {}).details || "";
		ok(r.status === 200 && !truckRow(db, 2) && line === `Truck LogisX-#91 (Active, owner 5, VIN ${VIN_B}) deleted; cascade: no rows`,
			`§4 a truck with a VIN deleted: the line names it (got ${r.status}, ${JSON.stringify(line)})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.del(SUPER, 2);
		const line = (audits(db, "delete_truck")[0] || {}).details || "";
		ok(r.status === 200 && line === "Truck LogisX-#91 (Active, owner 5) deleted; cascade: no rows",
			`§4 a truck with no VIN deleted: the line it always was (got ${r.status}, ${JSON.stringify(line)})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §5
async function trailerSection() {
	section("§5 Trailers — the same VIN rule: edge whitespace trimmed, a padded resend is no change");
	const trailerRow = (db, id) => db.prepare("SELECT * FROM trailers WHERE id = ?").get(id) || {};
	const seed = (db, vin) => db.prepare("INSERT INTO trailers (id, trailer_number, type, vin, status) VALUES (7, 'TR-5301', 'Dry Van', ?, 'Available')").run(vin);
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.trailerPost(DISPATCHER, { trailer_number: "TR-5302", type: "Reefer", vin: ` ${VIN_B}\t` });
		const t = db.prepare("SELECT * FROM trailers WHERE trailer_number = 'TR-5302'").get() || {};
		ok(r.status === 200 && t.vin === VIN_B, `§5 a trailer added with a padded VIN: stored trimmed (got ${r.status} ${JSON.stringify(r.body)}, ${JSON.stringify(t.vin)})`);
	}
	{
		const db = makeDb();
		const app = mountAll(db);
		const r = await app.trailerPost(DISPATCHER, { trailer_number: "TR-5303" });
		const t = db.prepare("SELECT * FROM trailers WHERE trailer_number = 'TR-5303'").get() || {};
		ok(r.status === 200 && t.vin === "", `§5 a trailer added with no VIN: stored blank, as before (got ${r.status}, ${JSON.stringify(t.vin)})`);
	}
	for (const [label, stored, body, expected] of [
		["the VIN resent padded", VIN_A, { vin: `  ${VIN_A} ` }, VIN_A],
		["a VIN stored padded, resent trimmed", `${VIN_A} `, { vin: VIN_A }, `${VIN_A} `],
		["a save that sends no VIN", `${VIN_A} `, { notes: "new mud flaps" }, `${VIN_A} `],
		["a VIN changed, sent padded", VIN_A, { vin: `\t${VIN_B}  ` }, VIN_B],
		["a VIN cleared", VIN_A, { vin: "" }, ""],
	]) {
		const db = makeDb();
		seed(db, stored);
		const app = mountAll(db);
		const r = await app.trailerPut(SUPER, 7, body);
		ok(r.status === 200 && trailerRow(db, 7).vin === expected,
			`§5 PUT, ${label}: 200 and the VIN stored as ${JSON.stringify(expected)} (got ${r.status} ${JSON.stringify(r.body)}, ${JSON.stringify(trailerRow(db, 7).vin)})`);
	}
}

(async () => {
	await renameSection();
	await vinSection();
	await createSection();
	await deleteSection();
	await trailerSection();
})().then(() => {
	if (failures.length) {
		for (const f of failures) console.error(`  FAIL  ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n${pass} passed, 0 failed`);
}).catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
