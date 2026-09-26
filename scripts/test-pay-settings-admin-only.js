#!/usr/bin/env node
/**
 * Driver pay settings are Super Admin only (owner decision, 2026-09-24).
 *
 * A driver's pay lives in drivers_directory.pay_type / pay_percentage /
 * pay_daily and in trucks.driver_pay_daily — the two inputs resolveDailyRate()
 * reads. The four routes that write them also admit a Dispatcher (and
 * POST /api/trucks an Investor) for every other column, so the rule is per
 * field: from anyone but a Super Admin, a request that would CHANGE a pay value
 * is refused whole with 403 PAY_EDIT_ADMIN_ONLY and nothing is written; a
 * request that resends the stored value, or leaves it out, goes through.
 *
 * WHAT IS ASSERTED. Each route is the shipped handler, lifted out of server.js
 * and run against an in-memory SQLite, with server.js's own pay rule, refusal
 * helper, audit writer (logAudit / logAuditRefusal, coalescing included), name
 * helpers, truck assignment and field parsers. Only the period locks, the
 * active-load check, the Job Tracking read and the driver history it feeds (the
 * create lock is stubbed, so the history it would be handed is too), and the
 * socket notification are stubbed.
 *   §1 PUT /api/drivers-directory/:id — a Dispatcher changing pay_type,
 *      pay_percentage (active or not) or pay_daily, or clearing it: 403, the
 *      fields named, nothing written, one refusal row. The edit form's
 *      whole-row resend of the stored terms (in any spelling the handler
 *      accepts, a legacy "Fixed" included), the new client's blank pay fields,
 *      or no pay columns at all: saved, with the non-pay edit written and the
 *      stored pay columns (NULLs included) left byte for byte as they were.
 *      The stored name of a row that carries its own terms is part of them:
 *      any change to it — a rename, a respelling in case or spacing — is
 *      refused the same way, and a save that resends it (padded or not) writes
 *      it back byte for byte. A rename of a row on the default terms and
 *      status and contact edits are unchanged. A daily rate above DRIVER_PAY_DAILY_MAX ("Infinity" and
 *      1e308 included) is 400 INVALID_PAY for every role. So is a sent pay
 *      field that is not a plain decimal (directoryPayValue(): "300abc",
 *      "0x1F4", "   ", ["300"], a number that is not finite), with nothing
 *      written; a plain decimal keeps the old ranges (a percentage clamped to
 *      0–100, a daily rate up to 0) and "" keeps the stored value. POST
 *      reads its pay fields the same way. Hostile rate values,
 *      a duplicated header and a __proto__ header never move the stored rate.
 *      A Super Admin changes each field. With a locked month the 403 still
 *      answers first.
 *   §2 POST /api/drivers-directory — a Dispatcher's add with the default terms
 *      (the Add Driver form's shape) is created; any other terms are refused,
 *      and no row appears. A Super Admin sets terms on create, up to the cap.
 *   §3 PUT /api/trucks/:id — a Dispatcher changing or clearing
 *      driver_pay_daily: 403, nothing written (not even the driver
 *      assignment the same save carried). Resending the stored rate, leaving it
 *      out, or sending only the stored rate: saved. A Super Admin's rate change
 *      that lands while a Dispatcher's save is waiting on the active-load check
 *      is kept, not overwritten. A Super Admin changes the rate. The same form's
 *      Admin Fee (not a pay setting — either role may edit it): a number from 0
 *      to 100 is stored as given, a blank one is the column's 50, never NULL,
 *      anything else is 400 INVALID_AMOUNT with the stored fee kept, and a save
 *      that leaves it out leaves the column alone.
 *   §4 POST /api/trucks — a Dispatcher or an Investor adding a truck with a
 *      rate: 403, no truck; without one: created. A Super Admin sets one. The
 *      Add form's fixed costs, admin fee and photo are stored for a Super Admin
 *      or a Dispatcher (and are what the month-end lock is asked about), not for
 *      an Investor; a blank admin fee is the column's 50, and one that is not a
 *      number from 0 to 100 refuses the add.
 *   §5 the refusal row: action pay_edit_blocked, the entity and id, the
 *      account, the attempted change and [PAY_EDIT_ADMIN_ONLY]; coalesced by
 *      logAuditRefusal(); caller text capped and unable to forge a
 *      [PERIOD_ marker; never on the purge list.
 *   §6 source pins: each check sits before its route's month-end lock and its
 *      first write; the directory handlers never await; a non-Super-Admin's
 *      save never writes its own pay values on either PUT; the rename check
 *      and the rate cap sit where they must; both truck routes store the admin
 *      fee through one rule.
 *   §7 MUTANTS — three breaks of the pay guard: the check removed, the check
 *      keyed on presence instead of change, and the role test inverted. Each is
 *      applied to all four routes at once and must fail at least one check in
 *      every route's own section, §1 to §4.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-pay-settings-admin-only.js    # exits 1 on failure
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
function record(results) {
	for (const r of results) ok(r.ok, r.name);
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

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

const HEADS = {
	dirGet: 'app.get("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	dirPost: 'app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	dirPut: 'app.put("/api/drivers-directory/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	truckPost: 'app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {',
	truckPut: 'app.put("/api/trucks/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));
// The photo check both truck routes run, verbatim (its own subject is
// scripts/test-stored-file-serving.js).
const PHOTO_CHECK = new Function("imageLimits",
	`"use strict";\n${liftFunction("storedFileForServing")}\n${liftFunction("truckPhotoForStorage")}\nreturn { storedFileForServing, truckPhotoForStorage };`
)(require("../lib/image-size"));

// The eighteen columns DriverTable.vue sends back on every save (`headers:
// this.headers`, straight from the GET) — read off the GET route, so the
// bodies below are the shape the client really sends.
const DIR_HEADERS = (() => {
	const m = ROUTES.dirGet.match(/const headers = (\[[^\]]*\]);/);
	if (!m) die("could not read the header list of GET /api/drivers-directory");
	return JSON.parse(m[1]);
})();
if (!["PayType", "PayPercentage", "PayDaily"].every((h) => DIR_HEADERS.includes(h))) die("the directory headers no longer carry the pay columns");

// Everything the four routes call from module scope, lifted verbatim. `src`
// swaps one piece for a mutant.
const PIECES = {
	payRule: [
		liftConst("const PAY_EDIT_ADMIN_ONLY = "),
		liftFunction("directoryPayStruct"),
		liftFunction("directoryPayChanges"),
		liftFunction("refusePayEdit"),
	].join("\n"),
	audit: [
		liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
		liftConst("const refusalAuditWindows = "),
		liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
		liftFunction("logAudit"),
		liftFunction("logAuditRefusal"),
		liftFunction("scrubPurgeMarker"),
		liftFunction("auditText"),
	].join("\n"),
	names: [
		liftFunction("normalizeDriverName"),
		liftFunction("findDriverNameClashes"),
		liftFunction("findDriverNameClash"),
		liftFunction("driverNameHeldByOtherAccount"),
		liftFunction("canonicalDriverName"),
		liftFunction("findDirectoryRowForDriver"),
		liftFunction("findTruckForDriver"),
		liftFunction("syncDriverToCarrierSheet"),
		liftFunction("driverNameHeldByOtherSpelling"),
		liftFunction("assignDriverToTruck"),
	].join("\n"),
	directory: [liftConst("const DIRECTORY_PERIOD_COLUMNS = "), liftFunction("directoryChangedColumns")].join("\n"),
	// The pay fields both directory routes read (§1c).
	directoryPay: liftFunction("directoryPayValue"),
	truckParse: [
		liftFunction("parsePlainDecimal"),
		liftConst("const DRIVER_PAY_DAILY_MAX = "),
		liftFunction("parseDriverPayDaily"),
		liftConst("const IN_SERVICE_MAX_MONTHS_AHEAD = "),
		liftFunction("parseInServiceDate"),
		liftFunction("parseRetiredAt"),
		// The admin fee both truck routes store, and the monthly total the create's
		// audit lines name.
		liftConst("const ADMIN_FEE_PCT_MAX = "),
		liftFunction("parseAdminFeePct"),
		liftFunction("truckMonthlyFixed"),
		// The amounts both truck routes parse (scripts/test-truck-cost-amounts.js).
		liftConst("const TRUCK_AMOUNT_MAX = "),
		liftFunction("parseTruckAmount"),
		liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"),
		liftFunction("parseTruckAmounts"),
		// The unit number both truck routes read, and the write-time duplicate check.
		liftFunction("parseUnitNumber"),
		liftFunction("isUnitNumberTaken"),
	].join("\n"),
};
const MODULE_EXPORTS = [
	"PAY_EDIT_ADMIN_ONLY", "directoryPayStruct", "directoryPayChanges", "refusePayEdit",
	"logAudit", "logAuditRefusal", "auditText",
	"normalizeDriverName", "findDriverNameClash", "findDriverNameClashes", "canonicalDriverName",
	"syncDriverToCarrierSheet", "assignDriverToTruck",
	"directoryChangedColumns", "DRIVER_PAY_DAILY_MAX", "parseDriverPayDaily", "parseInServiceDate", "parseRetiredAt",
	"parseAdminFeePct", "truckMonthlyFixed", "TRUCK_AMOUNT_FIELDS", "parseTruckAmounts", "parseUnitNumber", "isUnitNumberTaken",
	"directoryPayValue",
];
function buildModule(db, src = {}) {
	const s = { ...PIECES, ...src };
	return new Function("db", "todayKeyCT",
		`"use strict";\n${s.audit}\n${s.payRule}\n${s.names}\n${s.directory}\n${s.directoryPay}\n${s.truckParse}\n` +
		`return { ${MODULE_EXPORTS.join(", ")} };`)(db, () => "2026-09-24");
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
	// The migrated production shape of the directory (UNIQUE COLLATE NOCASE).
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
];

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };
const INVESTOR = { id: 9, username: "acme", role: "Investor" };

function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, full_name) VALUES (?, ?, 'x', ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "");
	user.run(2, "kevin", "Dispatcher", "", "Kevin Dispatch");
	user.run(3, "sking", "Driver", "Shorn King", "Shorn King");
	user.run(4, "rbrown", "Driver", "Rodney Brown", "Rodney Brown");
	user.run(9, "acme", "Investor", "", "Acme Holdings");
	const dir = db.prepare(`INSERT INTO drivers_directory (id, driver_name, city, state, phone, email, status, pay_type, pay_percentage, pay_daily)
		VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`);
	dir.run(1, "Shorn King", "Houston", "TX", "555-0100", "shorn@example.com", "fixed", 0, 300); // a day rate of his own
	dir.run(2, "Rodney Brown", "Dallas", "TX", "555-0200", "rodney@example.com", "percentage", 20, 0); // an owner-operator share
	dir.run(3, "Legacy Lee", "Austin", "TX", "555-0300", "", "Fixed", 0, 280); // pay_type stored before the handler lowercased it
	dir.run(4, "New Hire", "Waco", "TX", "555-0400", "", "fixed", 0, 0); // on the default terms: the truck's rate applies
	dir.run(5, "Null Nell", "Tyler", "TX", "555-0500", "", null, null, null); // pay columns never written
	dir.run(6, " Padded Pat", "Tyler", "TX", "555-0600", "", "fixed", 0, 275); // a name stored before names were trimmed
	const truck = db.prepare("INSERT INTO trucks (id, unit_number, make, status, assigned_driver, notes, owner_id, driver_pay_daily) VALUES (?, ?, 'Freightliner', 'Active', ?, '', 5, ?)");
	truck.run(1, "33", "Shorn King", 250);
	truck.run(2, "302", "Rodney Brown", 20);
	truck.run(3, "91", "", 0);
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Shorn King', '2026-09-01')").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (2, 'Rodney Brown', '2026-09-01')").run();
	return db;
}

const row = (db, id) => db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
const truckRow = (db, id) => db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
// Everything a refused request must leave exactly as it found it.
const snapshot = (db) => JSON.stringify({
	directory: db.prepare("SELECT * FROM drivers_directory ORDER BY id").all(),
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	assignments: db.prepare("SELECT * FROM truck_assignments ORDER BY id").all(),
	history: db.prepare("SELECT * FROM carrier_driver_history ORDER BY id").all(),
});
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);

// The body DriverTable.vue's Save sends: every column, from the loaded row.
// `over` replaces individual columns by header name. (The component zeroes the
// inactive pay field; a numeric 0 reads as "not sent" in this handler, so it
// is sent here as the stored value, which is what that zero amounts to.)
function dirFormBody(r, over = {}) {
	const v = {
		Driver: r.driver_name, "Carrier Name": "", State: r.state, City: r.city, ZIP: r.zip, Address: r.address,
		Trucks: r.trucks, Hazmat: r.hazmat || "NO", PhoneNumber: r.phone, CellNumber: r.cell, Email: r.email,
		DOT: r.dot, MC: r.mc, Rating: r.rating || "Not Rated", Status: r.status || "active",
		PayType: r.pay_type || "fixed", PayPercentage: r.pay_percentage, PayDaily: r.pay_daily, ...over,
	};
	return { headers: DIR_HEADERS, values: DIR_HEADERS.map((h) => v[h]) };
}
// A whole-row save body, from the stored row. The Trucks page sends only the
// fields that changed (client/src/lib/truckEdit.js); an older page or a direct
// API caller may still send the whole row, which is why the route compares
// against the stored value rather than keying on presence, and why these
// checks send it. `over` replaces or (with undefined) removes a key.
function truckFormBody(t, over = {}) {
	const b = {
		unitNumber: t.unit_number, make: t.make, model: t.model, year: t.year, vin: t.vin, licensePlate: t.license_plate,
		status: t.status, assignedDriver: t.assigned_driver, ownerId: t.owner_id, notes: t.notes, photo: t.photo,
		insuranceMonthly: t.insurance_monthly, eldMonthly: t.eld_monthly, truckPaymentMonthly: t.truck_payment_monthly,
		hvutAnnual: t.hvut_annual, irpAnnual: t.irp_annual, adminFeePct: t.admin_fee_pct,
		driverPayDaily: t.driver_pay_daily === 0 ? 0 : t.driver_pay_daily,
		purchasePrice: t.purchase_price, titleStatus: t.title_status, maintenanceFundMonthly: t.maintenance_fund_monthly,
		fuel_tank_gallons: t.fuel_tank_gallons, avg_mpg: t.avg_mpg,
		in_service_date: t.in_service_date, inServiceDate: t.in_service_date, retired_at: t.retired_at, retiredAt: t.retired_at,
	};
	for (const [k, v] of Object.entries(over)) { if (v === undefined) delete b[k]; else b[k] = v; }
	return b;
}

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
// A route's catch logs to console.error, which is expected noise when a mutant
// answers 500.
async function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = e; }
}

// `locked` makes every money-visible change a finalized-month refusal, so the
// order of the two refusals can be seen. `duringActiveLoadCheck` runs inside
// the active-load check, after it has yielded — i.e. while the truck PUT is
// suspended between its checks and its writes.
function mountAll(db, { routes = {}, moduleSrc = {}, locked = false, duringActiveLoadCheck = null } = {}) {
	const m = buildModule(db, moduleSrc);
	const r = { ...ROUTES, ...routes };
	const blocked = (changed) => (locked && Object.keys(changed || {}).length
		? { unreadable: false, blockers: [{ field: Object.keys(changed)[0], periods: ["2026-06"], detail: "restates June" }] }
		: { unreadable: false, blockers: [] });
	const periodRefusal = (req, res) => res.status(409).json({ code: "PERIOD_FINALIZED" });
	// What POST /api/trucks asked its month-end lock about, one entry per call.
	const createLockSeen = [];
	const env = {
		db,
		...m,
		...PHOTO_CHECK,
		directoryEditLockBlockers: (rowBefore, changed) => blocked(changed),
		truckEditLockBlockers: (truck, changed) => blocked(changed),
		truckCreateLockBlockers: (truck) => { createLockSeen.push({ ...truck }); return { unreadable: false, blockers: [] }; },
		// The create lock is stubbed, so the driver history it would be handed is
		// too; the real pair is scripts/test-truck-create-new-driver.js's subject.
		getJobTrackingCached: async () => ({ headers: ["Load ID", "Driver", "Assigned Date"], data: [] }),
		driverHistoryFloorMonth: () => ({ floor: "", unbounded: false }),
		periodBlockedResponse: periodRefusal,
		periodLockUnreadableResponse: periodRefusal,
		DIRECTORY_LOCK_REMEDY: "",
		truckChargeFromMonth: () => "",
		truckChargeUntilMonth: () => "",
		checkDriverActiveLoad: async () => {
			await new Promise((done) => setImmediate(done));
			if (duringActiveLoadCheck) duringActiveLoadCheck();
			return null;
		},
		syncCarrierDriverHistory: () => {},
		fuelModel: { DEFAULT_TANK_GALLONS: 200 },
		notifyChange: () => {},
	};
	const call = Object.fromEntries(["dirPost", "dirPut", "truckPost", "truckPut"].map((k) => [k, mountRoute(r[k], env)]));
	const as = (user) => ({ session: { user } });
	return {
		dirPost: (user, body) => quiet(() => call.dirPost({ ...as(user), body })),
		dirPut: (user, id, body) => quiet(() => call.dirPut({ ...as(user), params: { id: String(id) }, body })),
		truckPost: (user, body) => quiet(() => call.truckPost({ ...as(user), body })),
		truckPut: (user, id, body) => quiet(() => call.truckPut({ ...as(user), params: { id: String(id) }, body })),
		createLockSeen,
	};
}

// ── the battery ─────────────────────────────────────────────────────────────
async function battery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const refused = (label, r, fields) => {
		const b = r.body || {};
		t(`${label}: 403 PAY_EDIT_ADMIN_ONLY naming ${fields.join(", ")} (got ${r.status} ${b.code || ""} ${JSON.stringify(b.fields || null)})`,
			r.status === 403 && b.code === "PAY_EDIT_ADMIN_ONLY" && JSON.stringify(b.fields) === JSON.stringify(fields) &&
			typeof b.error === "string" && b.error.startsWith("Only a Super Admin can change driver pay."));
	};

	// ── §1 PUT /api/drivers-directory/:id ──
	for (const [label, id, over, fields] of [
		["pay_type fixed → percentage", 1, { PayType: "percentage" }, ["pay_type"]],
		["pay_percentage 20 → 25 on a percentage driver", 2, { PayPercentage: 25 }, ["pay_percentage"]],
		["pay_percentage 0 → 30 on a fixed driver (the field the form hides)", 1, { PayPercentage: 30 }, ["pay_percentage"]],
		["pay_daily 300 → 350", 1, { PayDaily: 350 }, ["pay_daily"]],
		["pay_daily 300 → \"0\" (cleared)", 1, { PayDaily: "0" }, ["pay_daily"]],
		["pay_type and share together", 1, { PayType: "percentage", PayPercentage: 25 }, ["pay_type", "pay_percentage"]],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPut(DISPATCHER, id, dirFormBody(row(db, id), over));
		refused(`§1 Dispatcher PUT directory, ${label}`, r, fields);
		t(`§1 Dispatcher PUT directory, ${label}: nothing written`, snapshot(db) === before);
		const rows = audits(db, "pay_edit_blocked");
		t(`§1 Dispatcher PUT directory, ${label}: one pay_edit_blocked row, no success line (got ${rows.length})`,
			rows.length === 1 && audits(db, "update_driver_pay").length === 0);
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { PayDaily: 350, PhoneNumber: "555-9999" }));
		refused("§1 Dispatcher PUT directory, a pay change beside a phone edit", r, ["pay_daily"]);
		t("§1 Dispatcher PUT directory, a pay change beside a phone edit: refused whole, the phone number is not written either", snapshot(db) === before && row(db, 1).phone === "555-0100");
	}
	for (const [label, id, over] of [
		["the stored terms resent verbatim", 1, {}],
		["the stored terms as text (\"300\", \"0\")", 1, { PayDaily: "300", PayPercentage: "0" }],
		["the stored terms in other spellings (\"300.0\", \"FIXED\")", 1, { PayDaily: "300.0", PayType: "FIXED" }],
		["a percentage driver's stored share, as \"20.00\"", 2, { PayPercentage: "20.00" }],
		["a legacy \"Fixed\" pay_type resent as stored", 3, {}],
		["a row whose pay columns were never written (NULL)", 5, {}],
		["blank pay fields (the non-Super-Admin client)", 1, { PayType: "", PayPercentage: "", PayDaily: "" }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		// The stored columns byte for byte — a legacy "Fixed" must not come back
		// as "fixed" from a save by an account that may not change pay.
		const terms = (r) => JSON.stringify([r.pay_type, r.pay_percentage, r.pay_daily]);
		const termsBefore = terms(row(db, id));
		const r = await app.dirPut(DISPATCHER, id, dirFormBody(row(db, id), { ...over, PhoneNumber: "555-7777" }));
		const after = row(db, id);
		t(`§1 Dispatcher PUT directory, ${label} + a phone edit: saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && r.body && r.body.success === true);
		t(`§1 Dispatcher PUT directory, ${label}: the phone edit is written`, after.phone === "555-7777");
		t(`§1 Dispatcher PUT directory, ${label}: the stored pay columns are untouched (before ${termsBefore}, after ${terms(after)})`,
			terms(after) === termsBefore);
		t(`§1 Dispatcher PUT directory, ${label}: no refusal row and no pay line under the Dispatcher`,
			audits(db, "pay_edit_blocked").length === 0 && audits(db, "update_driver_pay").length === 0);
	}
	{
		// A request that carries no pay column at all keeps the stored terms.
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(DISPATCHER, 1, { headers: ["Driver", "PhoneNumber"], values: ["Shorn King", "555-1234"] });
		t(`§1 Dispatcher PUT directory with no pay columns: saved (got ${r.status})`, r.status === 200 && row(db, 1).phone === "555-1234" && row(db, 1).pay_daily === 300);
	}
	{
		// Every non-pay edit a Dispatcher could make before, still made: status and
		// contact edits on a driver with terms of their own, and a rename of a
		// driver on the default terms (which prices them exactly as no row does).
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), {
			Status: "inactive", City: "Katy", Email: "sak@example.com", Rating: "A",
		}));
		const after = row(db, 1);
		t(`§1 Dispatcher PUT directory, status + contact edits on a $300 driver: saved as before (got ${r.status})`,
			r.status === 200 && after.status === "inactive" && after.city === "Katy" &&
			after.email === "sak@example.com" && after.rating === "A" && after.pay_daily === 300);
		const n = await app.dirPut(DISPATCHER, 4, dirFormBody(row(db, 4), { Driver: "New Hire Jr.", Status: "inactive" }));
		t(`§1 Dispatcher PUT directory, renaming a driver on the default terms: saved as before (got ${n.status} ${(n.body || {}).code || ""})`,
			n.status === 200 && row(db, 4).driver_name === "New Hire Jr." && row(db, 4).status === "inactive");
		const c = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { Driver: " Shorn King  " }));
		t(`§1 Dispatcher PUT directory, a $300 driver's name resent with padding: saved, stored name unchanged (got ${c.status} ${(c.body || {}).code || ""})`,
			c.status === 200 && row(db, 1).driver_name === "Shorn King" && row(db, 1).pay_daily === 300);
		const p = await app.dirPut(DISPATCHER, 6, dirFormBody(row(db, 6), { PhoneNumber: "555-0666" }));
		t(`§1 Dispatcher PUT directory, a $275 row whose stored name is padded, resent as loaded: saved, name kept byte for byte (got ${p.status} ${(p.body || {}).code || ""})`,
			p.status === 200 && row(db, 6).driver_name === " Padded Pat" && row(db, 6).phone === "555-0666");
		t("§1 ...and none of those is a refusal", audits(db, "pay_edit_blocked").length === 0);
	}
	// The stored name of a row with terms of its own is part of those terms.
	for (const [label, id, to] of [
		["a $300 driver renamed", 1, "Shorn A. King"],
		["a 20% owner-operator renamed", 2, "Rodney B. Brown"],
		["a $280 legacy row renamed", 3, "Lee Legacy"],
		["a $300 driver respelled in case", 1, "SHORN KING"],
		["a $300 driver respelled in spacing", 1, "Shorn  King"],
		["a padded $275 row trimmed", 6, "Padded Pat"],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPut(DISPATCHER, id, dirFormBody(row(db, id), { Driver: to }));
		refused(`§1 Dispatcher PUT directory, ${label}`, r, ["driver_name"]);
		t(`§1 Dispatcher PUT directory, ${label}: nothing written`, snapshot(db) === before);
		const rows = audits(db, "pay_edit_blocked");
		t(`§1 Dispatcher PUT directory, ${label}: one refusal row naming both names`,
			rows.length === 1 && rows[0].details.includes(`driver_name "${row(db, id).driver_name}" -> "${to}"`));
	}
	{
		// A rename of a row with terms is refused even when an earlier rename
		// freed the name it asks for.
		const db = makeDb();
		const app = mountAll(db, opts);
		const first = await app.dirPut(DISPATCHER, 4, dirFormBody(row(db, 4), { Driver: "New Hire Old" }));
		const second = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { Driver: "New Hire" }));
		t(`§1 a default-terms row renamed out of the way, then a $300 row renamed onto its old name: the second is refused (got ${first.status}, ${second.status} ${(second.body || {}).code || ""})`,
			first.status === 200 && second.status === 403 && second.body.code === "PAY_EDIT_ADMIN_ONLY" &&
			row(db, 1).driver_name === "Shorn King" && row(db, 1).pay_daily === 300);
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(SUPER, 1, dirFormBody(row(db, 1), { Driver: "Shorn A. King" }));
		t(`§1 Super Admin PUT directory, renaming a $300 driver: saved (got ${r.status})`,
			r.status === 200 && row(db, 1).driver_name === "Shorn A. King" && row(db, 1).pay_daily === 300);
	}
	// The daily rate is held to the truck routes' cap, for every role.
	for (const [label, who, value, status] of [
		["a Super Admin's \"Infinity\"", SUPER, "Infinity", 400],
		["a Super Admin's 1e308", SUPER, 1e308, 400],
		["a Super Admin's 10000.01", SUPER, "10000.01", 400],
		["a Dispatcher's \"Infinity\"", DISPATCHER, "Infinity", 400],
		["a Super Admin's 10000", SUPER, 10000, 200],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPut(who, 1, dirFormBody(row(db, 1), { PayDaily: value }));
		t(`§1 PUT directory, ${label} as the daily rate: ${status} (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === status && (status === 200
				? row(db, 1).pay_daily === 10000
				: r.body.code === "INVALID_PAY" && snapshot(db) === before && audits(db, "pay_edit_blocked").length === 0));
	}
	// Whatever a Dispatcher sends as the rate, the stored rate does not move.
	for (const [label, value] of [
		["\" 300 \"", " 300 "], ["[\"300\"]", ["300"]], ["\"1e3\"", "1e3"], ["\"0x12C\"", "0x12C"], ["{}", {}],
		["true", true], ["\"-0\"", "-0"], ["\"Infinity\"", "Infinity"], ["1e308", 1e308], ["\"300abc\"", "300abc"],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { PayDaily: value }));
		t(`§1 Dispatcher PUT directory, ${label} as the daily rate: refused or a no-op, the stored $300 kept (got ${r.status})`,
			[200, 400, 403].includes(r.status) && row(db, 1).pay_daily === 300 && row(db, 1).pay_type === "fixed");
	}
	// A pay field sent is read as a plain decimal (directoryPayValue()): text
	// parseFloat() used to read as a number ("300abc" as 300, "0x1F4" as 0) is
	// 400 INVALID_PAY with nothing written, whoever sends it.
	for (const [label, id, field, value] of [
		['"300abc" as the daily rate', 1, "PayDaily", "300abc"], ['"12,5" as the daily rate', 1, "PayDaily", "12,5"],
		['"0x1F4" as the daily rate', 1, "PayDaily", "0x1F4"], ['"abc" as the daily rate', 1, "PayDaily", "abc"],
		['"   " as the daily rate', 1, "PayDaily", "   "], ['["300"] as the daily rate', 1, "PayDaily", ["300"]],
		["true as the daily rate", 1, "PayDaily", true], ['"-1e400" as the daily rate', 1, "PayDaily", "-1e400"],
		['"25abc" as the percentage', 2, "PayPercentage", "25abc"], ['"0x19" as the percentage', 2, "PayPercentage", "0x19"],
		['"abc" as the percentage', 2, "PayPercentage", "abc"], ['"1e400" as the percentage', 2, "PayPercentage", "1e400"],
		["[25] as the percentage", 2, "PayPercentage", [25]],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPut(SUPER, id, dirFormBody(row(db, id), { [field]: value }));
		t(`§1 Super Admin PUT directory, ${label}: 400 INVALID_PAY, nothing written (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 400 && (r.body || {}).code === "INVALID_PAY" && snapshot(db) === before && audits(db, "update_driver_pay").length === 0);
	}
	// ...while a plain decimal keeps each field's range as before.
	for (const [label, id, over, expect] of [
		['" 325.5 " as the daily rate: 325.5', 1, { PayDaily: " 325.5 " }, { pay_daily: 325.5 }],
		['"1e2" as the daily rate: 100', 1, { PayDaily: "1e2" }, { pay_daily: 100 }],
		['"-20" as the daily rate: clamped to 0', 1, { PayDaily: "-20" }, { pay_daily: 0 }],
		['"150" as the percentage: clamped to 100', 2, { PayPercentage: "150" }, { pay_percentage: 100 }],
		['"-5" as the percentage: clamped to 0', 2, { PayPercentage: "-5" }, { pay_percentage: 0 }],
		['"" as both: the stored terms kept', 1, { PayDaily: "", PayPercentage: "" }, { pay_daily: 300 }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(SUPER, id, dirFormBody(row(db, id), over));
		const after = row(db, id);
		t(`§1 Super Admin PUT directory, ${label} (got ${r.status} ${(r.body || {}).code || ""}, ${JSON.stringify(expect)} → ${JSON.stringify(Object.fromEntries(Object.keys(expect).map((k) => [k, after[k]])))})`,
			r.status === 200 && Object.entries(expect).every(([k, v]) => after[k] === v));
	}
	for (const [label, body] of [
		["a PayDaily header sent twice", { headers: ["Driver", "PayDaily", "PayDaily"], values: ["Shorn King", 300, 500] }],
		["a __proto__ header carrying a rate", { headers: ["Driver", "__proto__"], values: ["Shorn King", { PayDaily: 999, PayType: "percentage" }] }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(DISPATCHER, 1, body);
		t(`§1 Dispatcher PUT directory, ${label}: refused, the stored terms kept (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 403 && row(db, 1).pay_daily === 300 && row(db, 1).pay_type === "fixed");
	}
	for (const [label, id, over, expect] of [
		["pay_type → percentage with a 25% share", 1, { PayType: "percentage", PayPercentage: 25 }, { pay_type: "percentage", pay_percentage: 25 }],
		["pay_daily 300 → 350", 1, { PayDaily: 350 }, { pay_daily: 350 }],
		["pay_percentage 20 → 25", 2, { PayPercentage: 25 }, { pay_percentage: 25 }],
		["pay_daily cleared to \"0\"", 1, { PayDaily: "0" }, { pay_daily: 0 }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPut(SUPER, id, dirFormBody(row(db, id), over));
		const after = row(db, id);
		t(`§1 Super Admin PUT directory, ${label}: saved (got ${r.status} ${(r.body || {}).code || ""})`, r.status === 200);
		t(`§1 Super Admin PUT directory, ${label}: written`, Object.entries(expect).every(([k, v]) => after[k] === v));
		t(`§1 Super Admin PUT directory, ${label}: the update_driver_pay line and no refusal row`,
			audits(db, "update_driver_pay").length === 1 && audits(db, "pay_edit_blocked").length === 0);
	}
	{
		// Reopening a month would not make a Dispatcher's pay edit allowed, so the
		// 403 answers first — while the lock still answers a Super Admin's.
		const db = makeDb();
		const app = mountAll(db, { ...opts, locked: true });
		const r = await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { PayDaily: 350 }));
		refused("§1 in a locked month, a Dispatcher's pay edit", r, ["pay_daily"]);
		const s = await app.dirPut(SUPER, 1, dirFormBody(row(db, 1), { PayDaily: 350 }));
		t(`§1 in a locked month, a Super Admin's is still answered by the month-end lock (got ${s.status} ${(s.body || {}).code || ""})`,
			s.status === 409 && s.body.code === "PERIOD_FINALIZED" && row(db, 1).pay_daily === 300);
	}

	// ── §2 POST /api/drivers-directory ──
	const newDriver = (over = {}) => {
		const v = { Driver: "NEW DRIVER", State: "TX", City: "WACO", PhoneNumber: "555-0400", Hazmat: "NO", Rating: "Not Rated", ...over };
		return { headers: DIR_HEADERS, values: DIR_HEADERS.map((h) => v[h] === undefined ? "" : v[h]) };
	};
	for (const [label, over] of [
		["the Add Driver form's default terms (fixed, 0, 0)", { PayType: "fixed", PayPercentage: 0, PayDaily: 0 }],
		["blank pay fields", { PayType: "", PayPercentage: "", PayDaily: "" }],
		["the default terms spelled \"FIXED\", \"0\", \"0\"", { PayType: "FIXED", PayPercentage: "0", PayDaily: "0" }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPost(DISPATCHER, newDriver(over));
		const made = db.prepare("SELECT * FROM drivers_directory WHERE driver_name = 'NEW DRIVER'").get();
		t(`§2 Dispatcher POST directory, ${label}: created with the default terms (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && made && made.pay_type === "fixed" && made.pay_percentage === 0 && made.pay_daily === 0 && made.phone === "555-0400");
	}
	for (const [label, over, fields] of [
		["a $300 daily rate", { PayType: "fixed", PayDaily: 300 }, ["pay_daily"]],
		["a 20% owner-operator share", { PayType: "percentage", PayPercentage: 20 }, ["pay_type", "pay_percentage"]],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.dirPost(DISPATCHER, newDriver(over));
		refused(`§2 Dispatcher POST directory with ${label}`, r, fields);
		t(`§2 Dispatcher POST directory with ${label}: no row appears`, snapshot(db) === before);
		const rows = audits(db, "pay_edit_blocked");
		t(`§2 Dispatcher POST directory with ${label}: one refusal row, keyed on the name`, rows.length === 1 && rows[0].entity === "driver" && rows[0].entity_id === "NEW DRIVER");
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPost(SUPER, newDriver({ PayType: "percentage", PayPercentage: 20 }));
		const made = db.prepare("SELECT * FROM drivers_directory WHERE driver_name = 'NEW DRIVER'").get();
		t(`§2 Super Admin POST directory with a 20% share: created with it (got ${r.status})`,
			r.status === 200 && made && made.pay_type === "percentage" && made.pay_percentage === 20);
	}
	for (const [label, value, status] of [["\"Infinity\"", "Infinity", 400], ["10001", 10001, 400], ["10000", 10000, 200]]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPost(SUPER, newDriver({ PayType: "fixed", PayDaily: value }));
		const made = db.prepare("SELECT * FROM drivers_directory WHERE driver_name = 'NEW DRIVER'").get();
		t(`§2 Super Admin POST directory with ${label} as the daily rate: ${status} (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === status && (status === 200 ? made && made.pay_daily === 10000 : r.body.code === "INVALID_PAY" && !made));
	}
	// The same reading on create: a sent field that is not a plain decimal is
	// 400 INVALID_PAY and no row appears; one within reach is clamped as before.
	for (const [label, over, expect] of [
		['"300abc" as the daily rate', { PayType: "fixed", PayDaily: "300abc" }, null],
		['"0x1F4" as the daily rate', { PayType: "fixed", PayDaily: "0x1F4" }, null],
		['"20abc" as the percentage', { PayType: "percentage", PayPercentage: "20abc" }, null],
		['"abc" as the percentage', { PayType: "percentage", PayPercentage: "abc" }, null],
		['"150" as the percentage: clamped to 100', { PayType: "percentage", PayPercentage: "150" }, { pay_percentage: 100 }],
		['" 275 " as the daily rate: 275', { PayType: "fixed", PayDaily: " 275 " }, { pay_daily: 275 }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.dirPost(SUPER, newDriver(over));
		const made = db.prepare("SELECT * FROM drivers_directory WHERE driver_name = 'NEW DRIVER'").get();
		t(`§2 Super Admin POST directory with ${label}: ${expect ? "created with it" : "400 INVALID_PAY, no row"} (got ${r.status} ${(r.body || {}).code || ""})`,
			expect
				? r.status === 200 && made && Object.entries(expect).every(([k, v]) => made[k] === v)
				: r.status === 400 && (r.body || {}).code === "INVALID_PAY" && !made);
	}

	// ── §3 PUT /api/trucks/:id ──
	for (const [label, over, to] of [
		["250 → 300", { driverPayDaily: 300 }, 300],
		["250 → 0 (the form's blank field)", { driverPayDaily: 0 }, 0],
		["250 → \"275.5\"", { driverPayDaily: "275.5" }, 275.5],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), over));
		refused(`§3 Dispatcher PUT truck, driver_pay_daily ${label}`, r, ["driver_pay_daily"]);
		t(`§3 Dispatcher PUT truck, driver_pay_daily ${label}: nothing written`, snapshot(db) === before);
		const rows = audits(db, "pay_edit_blocked");
		t(`§3 Dispatcher PUT truck, driver_pay_daily ${label}: one refusal row naming the truck and the attempt (got ${rows.length})`,
			rows.length === 1 && rows[0].entity === "truck" && rows[0].entity_id === "1" &&
			rows[0].details.includes(`driver_pay_daily 250 -> ${to}`));
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { driverPayDaily: 300, assignedDriver: "Bob Driver", notes: "swap" }));
		refused("§3 Dispatcher PUT truck, a rate change beside a driver reassignment and a note", r, ["driver_pay_daily"]);
		t("§3 Dispatcher PUT truck, a rate change beside a reassignment: refused whole, no assignment, no note, no directory row", snapshot(db) === before);
	}
	for (const [label, over] of [
		["the stored rate resent (250)", {}],
		["the stored rate as text (\"250\", \"250.0\")", { driverPayDaily: "250.0" }],
		["no rate at all (the non-Super-Admin client)", { driverPayDaily: undefined }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { ...over, notes: "new tires", licensePlate: "TX-1" }));
		const after = truckRow(db, 1);
		t(`§3 Dispatcher PUT truck, ${label} + other edits: saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && after.notes === "new tires" && after.license_plate === "TX-1" && after.driver_pay_daily === 250);
		t(`§3 Dispatcher PUT truck, ${label}: no refusal row and no pay line`, audits(db, "pay_edit_blocked").length === 0 && audits(db, "update_driver_pay").length === 0);
	}
	{
		// A body that carries nothing but the stored rate still succeeds.
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPut(DISPATCHER, 1, { driverPayDaily: 250 });
		t(`§3 Dispatcher PUT truck with only the stored rate: saved (got ${r.status} ${JSON.stringify(r.body)})`,
			r.status === 200 && truckRow(db, 1).driver_pay_daily === 250);
	}
	{
		// The route yields in the active-load check, between its pay check and its
		// UPDATE. A Super Admin's rate change landing there must survive a
		// Dispatcher's save that loaded the old rate.
		const db = makeDb();
		const app = mountAll(db, { ...opts, duringActiveLoadCheck: () => db.prepare("UPDATE trucks SET driver_pay_daily = 300 WHERE id = 1").run() });
		const r = await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { assignedDriver: "Bob Driver" }));
		const after = truckRow(db, 1);
		t(`§3 a Super Admin's rate change during a Dispatcher's reassigning save is kept (got ${r.status}, rate ${after.driver_pay_daily}, driver ${after.assigned_driver})`,
			r.status === 200 && after.driver_pay_daily === 300 && after.assigned_driver === "Bob Driver");
	}
	{
		// ...and a Super Admin's own save still writes the rate it carries.
		const db = makeDb();
		const app = mountAll(db, { ...opts, duringActiveLoadCheck: () => db.prepare("UPDATE trucks SET driver_pay_daily = 300 WHERE id = 1").run() });
		const r = await app.truckPut(SUPER, 1, truckFormBody(truckRow(db, 1), { driverPayDaily: 280, assignedDriver: "Bob Driver" }));
		t(`§3 a Super Admin's reassigning save writes its own rate (got ${r.status}, rate ${truckRow(db, 1).driver_pay_daily})`,
			r.status === 200 && truckRow(db, 1).driver_pay_daily === 280);
	}
	for (const [label, pay, expect] of [["250 → 300", 300, 300], ["250 → 0 (cleared)", 0, 0]]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPut(SUPER, 1, truckFormBody(truckRow(db, 1), { driverPayDaily: pay }));
		const lines = audits(db, "update_driver_pay");
		t(`§3 Super Admin PUT truck, driver_pay_daily ${label}: written, with its pay line (got ${r.status}, rate ${truckRow(db, 1).driver_pay_daily})`,
			r.status === 200 && truckRow(db, 1).driver_pay_daily === expect && lines.length === 1 && lines[0].entity === "truck" &&
			audits(db, "pay_edit_blocked").length === 0);
	}
	{
		const db = makeDb();
		const app = mountAll(db, { ...opts, locked: true });
		const r = await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { driverPayDaily: 300 }));
		refused("§3 in a locked month, a Dispatcher's rate change", r, ["driver_pay_daily"]);
	}
	// The Edit form's Admin Fee, from a stored 40. Clearing the field sends ""
	// (v-model.number keeps an empty input as the empty string). Anything but a
	// blank or a number from 0 to 100 is refused, and the stored 40 kept.
	for (const [label, who, fee, status, expect] of [
		["a Super Admin clearing it (\"\")", SUPER, "", 200, 50],
		["a Dispatcher clearing it (\"\")", DISPATCHER, "", 200, 50],
		["null", SUPER, null, 200, 50],
		["unreadable (\"abc\")", SUPER, "abc", 400, 40],
		["\"Infinity\"", SUPER, "Infinity", 400, 40],
		["100.01", DISPATCHER, 100.01, 400, 40],
		["35", DISPATCHER, 35, 200, 35],
		["\"37.5\"", SUPER, "37.5", 200, 37.5],
		["0 (a deliberate zero)", SUPER, 0, 200, 0],
		["left out of the save", SUPER, undefined, 200, 40],
	]) {
		const db = makeDb();
		db.prepare("UPDATE trucks SET admin_fee_pct = 40 WHERE id = 1").run();
		const app = mountAll(db, opts);
		const r = await app.truckPut(who, 1, truckFormBody(truckRow(db, 1), { adminFeePct: fee }));
		const after = truckRow(db, 1).admin_fee_pct;
		const code = status === 400 ? (r.body || {}).code === "INVALID_AMOUNT" && (r.body || {}).field === "admin_fee_pct" : true;
		t(`§3 PUT truck, the admin fee ${label}: ${status}, stored ${expect} (got ${r.status} ${JSON.stringify(r.body)}, ${after})`,
			r.status === status && code && after === expect);
	}

	// ── §4 POST /api/trucks ──
	const newTruck = (over = {}) => {
		const b = { unitNumber: "500", make: "Volvo", model: "VNL 760", year: 2024, vin: "", licensePlate: "", status: "Active",
			assignedDriver: "", ownerId: 5, notes: "", photo: "", driverPayDaily: 0, in_service_date: "", inServiceDate: "", ...over };
		for (const [k, v] of Object.entries(over)) if (v === undefined) delete b[k];
		return b;
	};
	for (const [label, who, over] of [
		["Dispatcher, the Add Truck form's blank rate (0)", DISPATCHER, {}],
		["Dispatcher, \"\"", DISPATCHER, { driverPayDaily: "" }],
		["Investor, the My Trucks form (no rate key)", INVESTOR, { driverPayDaily: undefined }],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(who, newTruck(over));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		t(`§4 POST truck, ${label}: created with no rate of its own (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && made && made.driver_pay_daily === 0);
	}
	for (const [label, who, pay] of [["Dispatcher", DISPATCHER, 300], ["Investor", INVESTOR, 1]]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.truckPost(who, newTruck({ driverPayDaily: pay }));
		refused(`§4 POST truck by a ${label} with a $${pay}/day rate`, r, ["driver_pay_daily"]);
		t(`§4 POST truck by a ${label} with a rate: no truck appears`, snapshot(db) === before);
		const rows = audits(db, "pay_edit_blocked");
		t(`§4 POST truck by a ${label} with a rate: one refusal row keyed on the unit number, under the ${label}'s account`,
			rows.length === 1 && rows[0].entity === "truck" && rows[0].entity_id === "500" && rows[0].role === who.role);
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(SUPER, newTruck({ driverPayDaily: 300 }));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		t(`§4 Super Admin POST truck with a $300/day rate: created with it (got ${r.status})`, r.status === 200 && made && made.driver_pay_daily === 300);
	}
	// The Add form's fixed costs, admin fee and photo (AddTruckForm.vue sends all
	// seven). Stored for the two roles PUT /api/trucks/:id lets edit them, parsed
	// the way that route parses them, and handed to the month-end lock as stored.
	// The photo is a 4 × 3 JPEG header: the least checkImage() reads as a JPEG.
	const COSTS = { insuranceMonthly: 1630, eldMonthly: "50", truckPaymentMonthly: 1200, hvutAnnual: 580, irpAnnual: "1380", adminFeePct: 40, photo: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAADAAQDAAAAAAAAAAAA/9k=" };
	const storedCosts = (r) => r && [r.insurance_monthly, r.eld_monthly, r.truck_payment_monthly, r.hvut_annual, r.irp_annual, r.admin_fee_pct, r.photo];
	for (const [label, who] of [["Super Admin", SUPER], ["Dispatcher", DISPATCHER]]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(who, newTruck(COSTS));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		t(`§4 POST truck by a ${label} with the Add form's costs: stored as sent (got ${r.status}, ${JSON.stringify(storedCosts(made))})`,
			r.status === 200 && JSON.stringify(storedCosts(made)) === JSON.stringify([1630, 50, 1200, 580, 1380, 40, COSTS.photo]));
		const seen = app.createLockSeen[0] || {};
		t(`§4 POST truck by a ${label} with the Add form's costs: the month-end lock is asked about the same amounts`,
			app.createLockSeen.length === 1 && seen.insurance_monthly === 1630 && seen.eld_monthly === 50 && seen.truck_payment_monthly === 1200 &&
			seen.hvut_annual === 580 && seen.irp_annual === 1380);
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(INVESTOR, newTruck({ ...COSTS, driverPayDaily: undefined }));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		const seen = app.createLockSeen[0] || {};
		t(`§4 POST truck by an Investor with costs: created with the defaults — $0, the 50% fee, no photo (got ${r.status}, ${JSON.stringify(storedCosts(made))})`,
			r.status === 200 && JSON.stringify(storedCosts(made)) === JSON.stringify([0, 0, 0, 0, 0, 50, ""]) &&
			seen.insurance_monthly === 0 && seen.irp_annual === 0);
	}
	for (const [label, fee, expect] of [
		["blank (\"\")", "", 50], ["missing", undefined, 50], ["0 (a deliberate zero)", 0, 0], ["\"37.5\"", "37.5", 37.5],
	]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(SUPER, newTruck({ adminFeePct: fee }));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		t(`§4 POST truck with the admin fee ${label}: stored as ${expect} (got ${r.status}, ${made && made.admin_fee_pct})`,
			r.status === 200 && made && made.admin_fee_pct === expect);
	}
	for (const [label, fee] of [["unreadable (\"abc\")", "abc"], ["\"Infinity\"", "Infinity"], ["101", 101]]) {
		const db = makeDb();
		const app = mountAll(db, opts);
		const before = snapshot(db);
		const r = await app.truckPost(SUPER, newTruck({ adminFeePct: fee }));
		const b = r.body || {};
		t(`§4 POST truck with the admin fee ${label}: 400 INVALID_AMOUNT naming admin_fee_pct, no truck (got ${r.status} ${JSON.stringify(b)})`,
			r.status === 400 && b.code === "INVALID_AMOUNT" && b.field === "admin_fee_pct" && snapshot(db) === before);
	}
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		// (An unreadable amount is refused — scripts/test-truck-cost-amounts.js.)
		const r = await app.truckPost(DISPATCHER, newTruck({ insuranceMonthly: "", eldMonthly: "  ", truckPaymentMonthly: null, hvutAnnual: undefined, irpAnnual: "1380.5", photo: undefined }));
		const made = db.prepare("SELECT * FROM trucks WHERE unit_number = '500'").get();
		t(`§4 POST truck with blank and missing amounts: 0 for each, the rest as sent (got ${r.status}, ${JSON.stringify(storedCosts(made))})`,
			r.status === 200 && JSON.stringify(storedCosts(made)) === JSON.stringify([0, 0, 0, 0, 1380.5, 50, ""]));
	}

	// ── §5 the refusal row ──
	{
		const db = makeDb();
		const app = mountAll(db, opts);
		await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { PayDaily: 350 }));
		const [a] = audits(db, "pay_edit_blocked");
		t("§5 the refusal row names the account, its role, the driver and the attempted change",
			!!a && a.username === "kevin" && a.role === "Dispatcher" && a.user_id === 2 && a.entity === "driver" && a.entity_id === "1" &&
			a.details.startsWith("Shorn King: pay_daily 300 -> 350") && a.details.includes("[PAY_EDIT_ADMIN_ONLY]") &&
			a.details.endsWith("nothing was written"));
		// Coalesced through logAuditRefusal(): a repeat inside the window is
		// counted, not written again.
		await app.dirPut(DISPATCHER, 1, dirFormBody(row(db, 1), { PayDaily: 360 }));
		await app.truckPut(DISPATCHER, 1, truckFormBody(truckRow(db, 1), { driverPayDaily: 300 }));
		t(`§5 repeats from one account inside the window coalesce to one row (got ${audits(db, "pay_edit_blocked").length})`,
			audits(db, "pay_edit_blocked").length === 1);
	}
	{
		// Caller text on a create is capped, kept on one line, and cannot forge the
		// [PERIOD_ marker the purge exemption and the period-lock queue key on.
		const db = makeDb();
		const app = mountAll(db, opts);
		const r = await app.truckPost(DISPATCHER, newTruck({ unitNumber: `[PERIOD_FINALIZED]\n${"x".repeat(500)}`, driverPayDaily: 300 }));
		const [a] = audits(db, "pay_edit_blocked");
		t(`§5 hostile caller text is refused normally (got ${r.status})`, r.status === 403 && !!a);
		t("§5 hostile caller text cannot plant a [PERIOD_ marker, a newline or 500 characters in the row",
			!!a && !/\[period_/i.test(a.details) && !/\[period_/i.test(a.entity_id) && !/[\r\n]/.test(a.details) &&
			a.entity_id.length <= 100 && a.details.length < 800);
	}
	return results;
}

// ── §6 source pins ──────────────────────────────────────────────────────────
function sourcePins() {
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const before = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); return i > 0 && j > 0 && i < j; };

	const dp = code(ROUTES.dirPut);
	const dpo = code(ROUTES.dirPost);
	ok(!/\bawait\b/.test(dp), "§6 PUT /api/drivers-directory/:id never awaits, so its check and its UPDATE see one row");
	ok(before(dp, "refusePayEdit(", "directoryEditLockBlockers(") && before(dp, "refusePayEdit(", "UPDATE drivers_directory SET"),
		"§6 ...and refuses a pay change before its month-end lock and its UPDATE");
	ok(dp.includes("directoryPayChanges(current, { pay_type: nextPayType, pay_percentage: nextPayPct, pay_daily: nextPayDaily })"),
		"§6 ...comparing the values it would write with the stored row");
	ok(dp.includes(": { pay_type: current.pay_type, pay_percentage: current.pay_percentage, pay_daily: current.pay_daily };") &&
		dp.includes("nextStatus, writePay.pay_type, writePay.pay_percentage, writePay.pay_daily, id);") &&
		!/nextStatus, nextPayType, nextPayPct, nextPayDaily/.test(dp),
		"§6 ...and anyone but a Super Admin writes the stored pay columns back unchanged");
	const keeps = dp.indexOf("const keepsName = !payEditAllowed && directoryPayChanges(null, current).length > 0;");
	const nameCheck = dp.indexOf("if (keepsName && obj.Driver !== undefined && obj.Driver !== current.driver_name && nextName !== current.driver_name) {");
	ok(keeps > dp.indexOf("const payEditAllowed = ") && nameCheck > keeps && nameCheck < dp.indexOf("refusePayEdit("),
		"§6 ...and treats any change to the stored name of a row with its own terms as a pay change, compared byte for byte");
	ok(dp.includes("const writeName = keepsName ? current.driver_name : nextName;") && dp.includes(".run(writeName, nextCarrier,") &&
		dp.includes("driver_name: writeName,"),
		"§6 ...and writes that name back exactly as stored");
	for (const [label, src, v] of [["PUT", dp, "nextPayDaily"], ["POST", dpo, "insPayDaily"]]) {
		const cap = src.indexOf(`!(${v} <= DRIVER_PAY_DAILY_MAX)`);
		ok(cap > 0 && cap < src.indexOf("refusePayEdit("),
			`§6 ${label} /api/drivers-directory holds a sent daily rate to DRIVER_PAY_DAILY_MAX before the pay check`);
	}

	ok(!/\bawait\b/.test(dpo), "§6 POST /api/drivers-directory never awaits");
	ok(before(dpo, "refusePayEdit(", "INSERT INTO drivers_directory"), "§6 ...and refuses non-default terms before its INSERT");

	const tp = code(ROUTES.truckPut);
	const payCheck = tp.indexOf('Object.prototype.hasOwnProperty.call(changed, "driver_pay_daily")');
	ok(payCheck > 0 && payCheck < tp.indexOf("truckEditLockBlockers(") && payCheck < tp.indexOf("await ") &&
		payCheck < tp.indexOf("assignDriverToTruck(") && payCheck < tp.indexOf("db.prepare(`UPDATE trucks SET"),
		"§6 PUT /api/trucks/:id refuses a rate change before its month-end lock, its await and every write");
	ok(tp.includes('if (payEditAllowed) { updates.push("driver_pay_daily = ?"); params.push(driverPayParsed.value); }') &&
		tp.includes('else updates.push("driver_pay_daily = driver_pay_daily");') &&
		(tp.match(/params\.push\(driverPayParsed\.value\)/g) || []).length === 1,
		"§6 ...and only a Super Admin's save binds its own rate; anyone else's writes the column's own value");

	const tpo = code(ROUTES.truckPost);
	ok(before(tpo, "refusePayEdit(", "await ") && before(tpo, "refusePayEdit(", "INSERT INTO trucks"),
		"§6 POST /api/trucks refuses a rate before its await and its INSERT");
	ok(tp.includes("const feeParsed = parseAdminFeePct(adminFeePct);") &&
		tp.includes('if (feeParsed.value !== undefined) { updates.push("admin_fee_pct = ?"); params.push(feeParsed.value); }') &&
		tpo.includes("parseAdminFeePct(adminFeePct)") && !/parseFloat\(adminFeePct\)/.test(tp + tpo),
		"§6 both truck routes store the admin fee through parseAdminFeePct(), neither through a bare parseFloat");

	// The refusal action: its own name, coalesced (not a PERIOD_ code), and kept.
	const purge = (() => {
		const at = SRC.indexOf("\nconst PURGEABLE_REFUSAL_ACTIONS = [");
		if (at < 0) die("PURGEABLE_REFUSAL_ACTIONS not found");
		return SRC.slice(at, SRC.indexOf("];", at));
	})();
	ok(!purge.includes('"pay_edit_blocked"'), "§6 pay_edit_blocked is not on the purge list — kept, like the period refusals");
	ok(!liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);").includes("PAY_EDIT_ADMIN_ONLY"),
		"§6 PAY_EDIT_ADMIN_ONLY is coalesced like every non-period code");
	ok((SRC.match(/"pay_edit_blocked"/g) || []).length === 1, "§6 exactly one writer of pay_edit_blocked");
	console.log("  source pins checked");
}

// ── §7 mutants ──────────────────────────────────────────────────────────────
async function mutants() {
	// Each kind of break is applied to all four routes at once, and must then
	// fail at least one check in every route's own section — so no route's
	// guard can go missing behind another route's failures.
	const SECTIONS = ["§1", "§2", "§3", "§4"];
	const caught = (label, results) => {
		const bad = results.filter((r) => !r.ok);
		for (const s of SECTIONS) {
			ok(bad.some((r) => r.name.startsWith(`${s} `)), `§7 ${label} was NOT caught in ${s} — that route's checks have lost their teeth`);
		}
		console.log(`  ${label}: caught by ${bad.length} check(s), e.g.`);
		for (const s of SECTIONS) {
			const r = bad.find((x) => x.name.startsWith(`${s} `));
			if (r) console.log(`      ✗ ${r.name}`);
		}
	};
	const swap = (label, src, from, to) => {
		const hits = src.split(from).length - 1;
		ok(hits === 1, `§7 ${label}: marker found ${hits} times — ${from.slice(0, 80)}`);
		return src.replace(from, to);
	};
	const allRoutes = (label, swaps) => ({
		routes: Object.fromEntries(Object.entries(swaps).map(([key, [from, to]]) => [key, swap(`${label} ${key}`, ROUTES[key], from, to)])),
	});

	const PRESENCE_DIR = '["PayType", "PayPercentage", "PayDaily"].filter((h) => obj[h] !== undefined && obj[h] !== "").map((h) => ({ field: h, from: "", to: obj[h] }))';
	const TRUCK_POST_CHECK = 'if (req.session.user.role !== "Super Admin" && driverPayParsed.value !== 0) {';
	const M = [
		["M1 the check removed", allRoutes("M1", {
			dirPut: ["if (payChanges.length) {", "if (false) {"],
			dirPost: ["if (payChanges.length) {", "if (false) {"],
			truckPut: ['if (!payEditAllowed && Object.prototype.hasOwnProperty.call(changed, "driver_pay_daily")) {', "if (false) {"],
			truckPost: [TRUCK_POST_CHECK, "if (false) {"],
		})],
		["M2 the check keyed on presence instead of change", allRoutes("M2", {
			dirPut: ["directoryPayChanges(current, { pay_type: nextPayType, pay_percentage: nextPayPct, pay_daily: nextPayDaily })", PRESENCE_DIR],
			dirPost: ["directoryPayChanges(null, { pay_type: insPayType, pay_percentage: insPayPct, pay_daily: insPayDaily })", PRESENCE_DIR],
			truckPut: ['Object.prototype.hasOwnProperty.call(changed, "driver_pay_daily")', "driverPayDaily !== undefined"],
			truckPost: [TRUCK_POST_CHECK, 'if (req.session.user.role !== "Super Admin" && driverPayDaily !== undefined) {'],
		})],
		["M3 the role test inverted", allRoutes("M3", {
			dirPut: ['const payEditAllowed = req.session.user.role === "Super Admin";', 'const payEditAllowed = req.session.user.role !== "Super Admin";'],
			dirPost: ['if (req.session.user.role !== "Super Admin") {', 'if (req.session.user.role === "Super Admin") {'],
			truckPut: ['const payEditAllowed = req.session.user.role === "Super Admin";', 'const payEditAllowed = req.session.user.role !== "Super Admin";'],
			truckPost: [TRUCK_POST_CHECK, 'if (req.session.user.role === "Super Admin" && driverPayParsed.value !== 0) {'],
		})],
	];
	for (const [label, opts] of M) caught(label, await battery(opts));

	// M4 the directory pay fields read by parseFloat() again ("300abc" as 300).
	// Only the two directory routes read them, so it must fail in §1 and §2.
	{
		const bad = (await battery({ moduleSrc: { directoryPay: swap("M4", PIECES.directoryPay,
			"const n = parsePlainDecimal(raw);", "const n = parseFloat(raw);") } })).filter((r) => !r.ok);
		for (const s of ["§1", "§2"]) {
			ok(bad.some((r) => r.name.startsWith(`${s} `)), `§7 M4 the directory pay fields read by parseFloat() was NOT caught in ${s}`);
		}
		console.log(`  M4 the directory pay fields read by parseFloat(): caught by ${bad.length} check(s), e.g.`);
		for (const r of bad.slice(0, 2)) console.log(`      ✗ ${r.name}`);
	}
}

(async () => {
	section("§1–§5 behaviour (the shipped routes)");
	record(await battery());
	section("§6 source pins");
	sourcePins();
	section("§7 mutants");
	await mutants();

	console.log("\n================================================================");
	if (failures.length) {
		console.log(`✗ ${failures.length} assertion(s) failed, ${pass} passed:`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
