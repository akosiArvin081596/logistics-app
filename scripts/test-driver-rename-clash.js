#!/usr/bin/env node
/**
 * Driver-name clash on the RENAME and ASSIGNMENT paths. Every path that renames
 * a driver, or writes a driver's name into another record, asks the question
 * the create paths ask — findDriverNameClash() / findDriverNameClashes(), i.e.
 * normalizeDriverName(), the comparison every ownership check uses. The helper
 * itself and the create paths are scripts/test-driver-name-clash.js's subject.
 *
 * WHAT IS ASSERTED. Each route is the shipped handler, lifted out of server.js
 * and run against an in-memory SQLite that carries every rename target, with
 * server.js's own planner, merge scan, cascade, directory sync and truck
 * assignment. Only period locks (with the create lock's driver history), the
 * Job Tracking sheet and sessions are stubbed.
 *   §1 PUT /api/users/:id
 *      guard (b): another account's driver name (exact, case, spacing), another
 *      account's username or a reserved name → 409 DRIVER_NAME_TAKEN, audited,
 *      nothing written, the message saying which. This account's own name
 *      re-spelled, its own username, and a re-spelling of a name another
 *      account already shares → allowed — except a re-spelling onto the exact
 *      spelling (case aside) another account's driver name has → 409.
 *      guard (e): a directory-only driver's name in another spacing → 409
 *      DRIVER_RENAME_IS_MERGE naming drivers_directory; this account's own
 *      directory row is never a merge. A FIRST driver name that matches a
 *      directory-only driver in another spacing links to that driver without a
 *      second directory row.
 *   §2 PUT /api/admin/fix-driver-name
 *      another account's driver name, or a directory-only driver, in another
 *      spacing → a merge (isMerge, the by-id recipe), dry run included; a
 *      directory row on both sides that differ only in spacing → 409
 *      DIRECTORY_NAME_VARIANT, nothing written, the sheet untouched; a reserved
 *      name or another account's username → 409 DRIVER_NAME_TAKEN, even with
 *      acknowledgeLockedPeriods; the renamed account's own username → allowed;
 *      the same name re-spelled → no merge; DIRECTORY_NAME_COLLISION still
 *      answers the case-only pair, with its own rationale.
 *   §3 PUT /api/drivers-directory/:id
 *      another row's name (exact, case, spacing, padding) → 409 DRIVER_EXISTS
 *      naming that row, nothing written; the row's own name re-spelled onto
 *      another row's exact spelling, case aside → 409 DRIVER_EXISTS, not a
 *      constraint error; the row's own name otherwise re-spelled, a name only
 *      an account holds, a free name → saved; blank → 400 DRIVER_NAME_REQUIRED;
 *      a Driver that is not text → 400 INVALID_DRIVER_NAME; a request without
 *      the Driver column keeps the name.
 *   §4 truck assignment (PUT /api/trucks/:id, POST /api/trucks), the directory
 *      sync and canonicalDriverName(): a driver named in another spacing or case
 *      resolves to the spelling the driver already has, the account's first —
 *      the other truck is released, truck_assignments holds one spelling, and
 *      no second directory row appears; a new name still gets its pending
 *      directory row. A save that re-sends the truck's own driver in another
 *      spelling is not a reassignment (no active-load refusal, no sync of a
 *      "previous" driver); moving a driver on a load is still refused. An
 *      assignedDriver that is not text → 400 INVALID_DRIVER_NAME, nothing
 *      written; null still means no driver.
 *   §4b the pay structure: a directory row re-spelled in case or spacing, by
 *      any of the three rename paths, is still found under the driver's name;
 *      of two rows for one name, the first by id wins.
 *   §4c the cascade's drivers_directory leg renames the row
 *      findDirectoryRowForDriver() finds for the old name: a row stored under a
 *      spacing variant of it is renamed by both rename routes (the dry run
 *      counts it), keeps its id and rate, and no second row appears — not from
 *      PUT /api/users/:id's own sync, nor a later one; renamed onto another
 *      row's name it is refused as DIRECTORY_NAME_COLLISION before anything is
 *      written.
 *   §5 source pins: each rename check runs after its route's last await and
 *      before its write — except fix-driver-name's, which runs in the plan,
 *      before the sheet write (the route's last await), like its merge scan;
 *      the type checks come before anything is resolved or written; the
 *      DIRECTORY_NAME_COLLISION pre-flight and `caseOnly` are as they were; no
 *      rename path keeps a TRIM(LOWER) clash query.
 *   §6 MUTANTS, each of which must be caught by the checks above.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-driver-rename-clash.js    # exits 1 on failure
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

const NORM_SRC = liftFunction("normalizeDriverName");
const CLASH_SRC = [liftFunction("findDriverNameClashes"), liftFunction("findDriverNameClash"), liftFunction("driverNameHeldByOtherAccount"),
	liftFunction("canonicalDriverName")].join("\n");
// The sync finds its directory row through findDirectoryRowForDriver() and the
// driver's truck through findTruckForDriver(); the cascade's drivers_directory
// leg finds its row through findDirectoryRowForDriver() too.
const SYNC_SRC = [liftFunction("findDirectoryRowForDriver"), liftFunction("findTruckForDriver"), liftFunction("syncDriverToCarrierSheet")].join("\n");
// The pay fields PUT /api/drivers-directory/:id reads (scripts/test-pay-settings-admin-only.js).
const DIRECTORY_PAY = new Function(`${liftFunction("parsePlainDecimal")}\n${liftFunction("directoryPayValue")}\nreturn directoryPayValue;`)();
// assignDriverToTruck() asks driverNameHeldByOtherSpelling() before it releases a
// spacing variant of the driver's name.
const ASSIGN_SRC = [liftFunction("driverNameHeldByOtherSpelling"), liftFunction("assignDriverToTruck")].join("\n");
const AUDIT_TEXT_SRC = [liftFunction("scrubPurgeMarker"), liftFunction("auditText")].join("\n");
const TARGETS_SRC = liftConst("const DRIVER_RENAME_TARGETS = [", "\n];");
const HARD_BLOCK_SRC = liftConst("const DRIVER_RENAME_HARD_BLOCK_CODES = ");
const PLANNER_SRC = liftFunction("planDriverRenameSqlite");
const CASCADE_SRC = [
	TARGETS_SRC,
	liftFunction("driverRenameWhereSql"),
	liftFunction("driverRenameWhereArgs"),
	liftFunction("driverRenameDirectoryRowId"),
	liftFunction("driverRenameNewValue"),
	liftConst("const DRIVER_RENAME_ID_CAP = "),
	liftFunction("driverRenameMergeScan"),
	liftFunction("replaceNameOnWordBoundary"),
	liftFunction("applyDriverRenameSqlite"),
	liftFunction("driverRenameAccountIds"),
].join("\n");
const COL_LETTER_SRC = liftFunction("colLetter");
const DIR_CHANGED_SRC = [liftConst("const DIRECTORY_PERIOD_COLUMNS = "), liftFunction("directoryChangedColumns")].join("\n");
const TRUCK_PARSE_SRC = [liftFunction("parsePlainDecimal"), liftFunction("parseDriverPayDaily"), liftFunction("parseInServiceDate"), liftFunction("parseRetiredAt"),
	liftConst("const ADMIN_FEE_PCT_MAX = "), liftFunction("parseAdminFeePct"),
	liftConst("const TRUCK_AMOUNT_MAX = "), liftFunction("parseTruckAmount"), liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"), liftFunction("parseTruckAmounts"),
	liftFunction("parseUnitNumber"), liftFunction("isUnitNumberTaken")].join("\n");
const FIXED_COST_SRC = liftFunction("truckMonthlyFixed");
const PAY_SRC = [liftConst("let lastPayStructShadowWarnMs = "), liftFunction("getDriverPayStructures")].join("\n");

const HEADS = {
	usersPut: 'app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {',
	fix: 'app.put("/api/admin/fix-driver-name", requireRole("Super Admin"), async (req, res) => {',
	dirPut: 'app.put("/api/drivers-directory/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	truckPut: 'app.put("/api/trucks/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	truckPost: 'app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));

// Everything a route below calls from module scope, built on one database.
// `src` swaps one piece for a mutant.
function buildModule(db, src = {}) {
	const s = { planner: PLANNER_SRC, sync: SYNC_SRC, clash: CLASH_SRC, hard: HARD_BLOCK_SRC, pay: PAY_SRC, cascade: CASCADE_SRC, ...src };
	return new Function("db", "isLocked", "expenseRowPeriodLocked", "invoiceRowPeriodLocked", "namedLockedPeriods", "expensePostedPeriod",
		`"use strict";\n${NORM_SRC}\n${s.clash}\n${s.cascade}\n${s.hard}\n${s.planner}\n${s.sync}\n${ASSIGN_SRC}\n${AUDIT_TEXT_SRC}\n${s.pay}\n` +
		"return { normalizeDriverName, findDriverNameClash, findDriverNameClashes, canonicalDriverName, DRIVER_RENAME_TARGETS," +
		" DRIVER_RENAME_ID_CAP, DRIVER_RENAME_HARD_BLOCK_CODES, planDriverRenameSqlite, driverRenameMergeScan, applyDriverRenameSqlite," +
		" driverRenameAccountIds, syncDriverToCarrierSheet, assignDriverToTruck, auditText, getDriverPayStructures };")(
		db, () => false, () => false, () => false, () => [], () => "");
}
const TARGETS = new Function(`${TARGETS_SRC}\nreturn DRIVER_RENAME_TARGETS;`)();
const colLetter = new Function(`${COL_LETTER_SRC}\nreturn colLetter;`)();
const directoryChangedColumns = new Function(`${DIR_CHANGED_SRC}\nreturn directoryChangedColumns;`)();
const truckParse = new Function("DRIVER_PAY_DAILY_MAX", "todayKeyCT", "IN_SERVICE_MAX_MONTHS_AHEAD",
	`${TRUCK_PARSE_SRC}\nreturn { parseDriverPayDaily, parseInServiceDate, parseRetiredAt, parseAdminFeePct, TRUCK_AMOUNT_FIELDS, parseTruckAmounts, parseUnitNumber, isUnitNumberTaken };`)(10000, () => "2026-09-24", 24);
const truckMonthlyFixed = new Function(`${FIXED_COST_SRC}\nreturn truckMonthlyFixed;`)();
// The photo check both truck routes run, verbatim (its own subject is
// scripts/test-stored-file-serving.js).
const PHOTO_CHECK = new Function("imageLimits",
	`"use strict";\n${liftFunction("storedFileForServing")}\n${liftFunction("truckPhotoForStorage")}\nreturn { storedFileForServing, truckPhotoForStorage };`
)(require("../lib/image-size"));

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
const DDL = [
	...usersDdl(),
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
	"CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, date TEXT, posted_period TEXT DEFAULT '', created_at TEXT DEFAULT '', amount REAL DEFAULT 0, status TEXT DEFAULT '')",
	"CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, week_start TEXT, week_end TEXT, paid_at TEXT DEFAULT '', status TEXT DEFAULT '', deleted_at TEXT DEFAULT '', is_manual INTEGER DEFAULT 0)",
	"CREATE TABLE dispatch_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '', body TEXT DEFAULT '')",
];
function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	// Every other rename target, as a table holding its name columns — so the
	// planner reads every money target and the cascade writes every leg.
	const byTable = {};
	for (const t of TARGETS) (byTable[t.table] = byTable[t.table] || new Set()).add(t.column);
	for (const [table, cols] of Object.entries(byTable)) {
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
		db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${[...cols].map((c) => `"${c}" TEXT DEFAULT ''`).join(", ")})`);
	}
	return db;
}
function addUser(db, id, username, driverName, role = "Driver", fullName = driverName) {
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, full_name) VALUES (?, ?, 'x', ?, ?, ?)")
		.run(id, username, role, driverName, fullName);
}
function addDirectory(db, name) {
	return Number(db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(name).lastInsertRowid);
}
function addTruck(db, id, unit, driver = "") {
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver) VALUES (?, ?, ?)").run(id, unit, driver);
	if (driver) db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-09-01')").run(id, driver);
}
const driverNameOf = (db, id) => (db.prepare("SELECT driver_name FROM users WHERE id = ?").get(id) || {}).driver_name;
const directoryNames = (db) => db.prepare("SELECT driver_name FROM drivers_directory ORDER BY id").all().map((r) => r.driver_name);
const snapshot = (db) => JSON.stringify({
	users: db.prepare("SELECT id, driver_name, full_name FROM users ORDER BY id").all(),
	directory: directoryNames(db),
});

// One app: registers the lifted route and answers one request at a time.
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
		const full = { params: {}, query: {}, body: {}, sessionID: "t-sid", session: { user: { id: 1, username: "super_admin", role: "Super Admin" } }, ...req };
		return Promise.resolve(handler(full, res)).then(() => out);
	};
}
// The route's catch logs to console.error, which is expected noise when a
// mutant answers 500.
async function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = e; }
}
const JOB_TRACKING = [["Load ID", "Driver", "Assigned Date"]];

function mountUsersPut(db, { routeSrc = ROUTES.usersPut, moduleSrc = {} } = {}) {
	const m = buildModule(db, moduleSrc);
	const log = { refusals: [], audits: [] };
	const call = mountRoute(routeSrc, {
		db,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: JOB_TRACKING } }) } } }),
		SPREADSHEET_ID: "not-a-sheet",
		auditText: m.auditText,
		recordPeriodRefusal: (audit, code) => log.refusals.push({ code, tail: audit.tail || "" }),
		userUpdateLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodLabel: (p) => p,
		driverRenameMergeScan: m.driverRenameMergeScan,
		applyDriverRenameSqlite: m.applyDriverRenameSqlite,
		syncDriverToCarrierSheet: m.syncDriverToCarrierSheet,
		purgeUserSessions: () => 0,
		logAudit: (req, action, entity, entityId, details) => log.audits.push({ action, details }),
		notifyChange: () => {},
		refreshOwnSession: () => true,
		normalizeDriverName: m.normalizeDriverName,
		findDriverNameClash: m.findDriverNameClash,
		findDriverNameClashes: m.findDriverNameClashes,
	});
	return { put: (id, body) => quiet(() => call({ params: { id: String(id) }, body })), log };
}

function mountFix(db, { routeSrc = ROUTES.fix, moduleSrc = {} } = {}) {
	const m = buildModule(db, moduleSrc);
	const log = { refusals: [], audits: [], sheetWrites: 0 };
	const call = mountRoute(routeSrc, {
		db,
		getSheets: async () => ({ spreadsheets: { values: {
			get: async () => ({ data: { values: JOB_TRACKING } }),
			batchUpdate: async () => { log.sheetWrites++; return {}; },
		} } }),
		SPREADSHEET_ID: "not-a-sheet",
		colLetter,
		isLocked: () => false,
		periodLocksReadable: () => true,
		namedLockedPeriods: () => [],
		planDriverRenameSqlite: m.planDriverRenameSqlite,
		driverRenameMergeScan: m.driverRenameMergeScan,
		DRIVER_RENAME_TARGETS: m.DRIVER_RENAME_TARGETS,
		DRIVER_RENAME_HARD_BLOCK_CODES: m.DRIVER_RENAME_HARD_BLOCK_CODES,
		DRIVER_RENAME_ID_CAP: m.DRIVER_RENAME_ID_CAP,
		recordPeriodRefusal: (audit, code) => log.refusals.push({ code, subject: audit.subject || "" }),
		auditText: m.auditText,
		auditReasonNote: () => "",
		applyDriverRenameSqlite: m.applyDriverRenameSqlite,
		driverRenameAccountIds: m.driverRenameAccountIds,
		purgeUserSessions: () => 0,
		logAudit: (req, action, entity, entityId, details) => log.audits.push({ action, details }),
		refreshOwnSession: () => true,
		normalizeDriverName: m.normalizeDriverName,
		findDriverNameClashes: m.findDriverNameClashes,
	});
	return { fix: (body, query = {}) => quiet(() => call({ body, query })), log };
}

function mountDirectoryPut(db, { routeSrc = ROUTES.dirPut, moduleSrc = {} } = {}) {
	const m = buildModule(db, moduleSrc);
	const log = { history: [] };
	const refuse = (req, res) => res.status(409).json({ code: "PERIOD_STUB" });
	const call = mountRoute(routeSrc, {
		db,
		directoryChangedColumns,
		directoryEditLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodLockUnreadableResponse: refuse,
		periodBlockedResponse: refuse,
		DIRECTORY_LOCK_REMEDY: "",
		syncCarrierDriverHistory: (rows) => log.history.push(rows),
		logAudit: () => {},
		notifyChange: () => {},
		normalizeDriverName: m.normalizeDriverName,
		findDriverNameClash: m.findDriverNameClash,
		findDriverNameClashes: m.findDriverNameClashes,
		directoryPayValue: DIRECTORY_PAY,
		DRIVER_PAY_DAILY_MAX: 10000,
	});
	return { put: (id, headers, values) => quiet(() => call({ params: { id: String(id) }, body: { headers, values } })), log };
}

// `busy` names the drivers on an active load, compared the way the real
// checkDriverActiveLoad() compares a sheet row with the name it is asked about.
function mountTrucks(db, { putSrc = ROUTES.truckPut, postSrc = ROUTES.truckPost, moduleSrc = {}, busy = [] } = {}) {
	const m = buildModule(db, moduleSrc);
	const refuse = (req, res) => res.status(409).json({ code: "PERIOD_STUB" });
	// Which drivers a save syncs, by name and action — the route's own decision.
	// The sync finds a driver's directory row and truck under any spelling, so
	// syncing one driver twice leaves the same rows; only this record shows it.
	const syncCalls = [];
	const env = {
		db,
		...truckParse,
		...PHOTO_CHECK,
		truckChargeFromMonth: () => "",
		truckChargeUntilMonth: () => "",
		truckEditLockBlockers: () => ({ unreadable: false, blockers: [] }),
		truckCreateLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodLockUnreadableResponse: refuse,
		periodBlockedResponse: refuse,
		checkDriverActiveLoad: async (name) => (busy.map(m.normalizeDriverName).includes(m.normalizeDriverName(name))
			? `${name} already has an active load (L-1, status: In Transit). Complete or reassign it before assigning another.`
			: null),
		// POST /api/trucks reads the sheet for the create lock's driver history.
		// The lock is stubbed, so the history is too; the real pair is
		// scripts/test-truck-create-new-driver.js's subject.
		getJobTrackingCached: async () => ({ headers: JOB_TRACKING[0].slice(), data: [] }),
		driverHistoryFloorMonth: () => ({ floor: "", unbounded: false }),
		// The create's audit lines name its monthly fixed costs.
		truckMonthlyFixed,
		assignDriverToTruck: m.assignDriverToTruck,
		fuelModel: { DEFAULT_TANK_GALLONS: 200 },
		syncDriverToCarrierSheet: (name, o) => { syncCalls.push([name, o && o.action]); return m.syncDriverToCarrierSheet(name, o); },
		logAudit: () => {},
		// The success lines name the truck through it.
		auditText: m.auditText,
		notifyChange: () => {},
		canonicalDriverName: m.canonicalDriverName,
		normalizeDriverName: m.normalizeDriverName,
	};
	const put = mountRoute(putSrc, env);
	const post = mountRoute(postSrc, env);
	return {
		put: (id, body) => quiet(() => put({ params: { id: String(id) }, body })),
		post: (body, role = "Super Admin") => quiet(() => post({ body, session: { user: { id: role === "Investor" ? 9 : 1, username: "u", role } } })),
		m,
		syncCalls,
	};
}

// ─────────────────────────────── §1 PUT /api/users/:id
function usersFixture() {
	const db = makeDb();
	addUser(db, 1, "super_admin", "", "Super Admin", "");
	addUser(db, 2, "sking", "Shorn King");
	addUser(db, 3, "bdriver", "Bob Driver");
	addUser(db, 4, "kevin", "", "Dispatcher", "Kevin Dispatch");
	addUser(db, 5, "Lee Park", "L. Park");
	addUser(db, 7, "newdriver", "", "Driver", "New Driver");
	addDirectory(db, "Shorn King"); // row 1 — sking's
	addDirectory(db, "Bob Driver"); // row 2 — bdriver's
	addDirectory(db, "Deshorn King"); // row 3 — a driver in the directory with no account
	return db;
}

async function usersBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });

	// Guard (b): the account side.
	for (const [label, name, expectWhy, tail] of [
		["another account's driver name, exactly", "Shorn King", /already belongs to sking \(user 2\)/, /driver name already belongs to sking \(user 2\)/],
		["another account's driver name, case and spacing changed", "  shorn   KING ", /already belongs to sking \(user 2\)/, /driver name already belongs to sking \(user 2\)/],
		["another account's username", "KEVIN", /username of kevin \(user 4\)/, /is the username of kevin \(user 4\)/],
		["a reserved name", " Dispatch ", /that name is reserved\.$/, /that name is reserved/],
	]) {
		const db = usersFixture();
		const before = snapshot(db);
		const { put, log } = mountUsersPut(db, opts);
		const r = await put(3, { driverName: name });
		const body = r.body || {};
		t(`guard (b), ${label}: 409 DRIVER_NAME_TAKEN, the message saying which (got ${r.status} ${body.code || ""})`,
			r.status === 409 && body.code === "DRIVER_NAME_TAKEN" && typeof body.error === "string" &&
			body.error.startsWith("Cannot set the driver name to") && expectWhy.test(body.error));
		t(`guard (b), ${label}: nothing written`, snapshot(db) === before);
		t(`guard (b), ${label}: the refusal is audited, naming the match`,
			log.refusals.length === 1 && log.refusals[0].code === "DRIVER_NAME_TAKEN" && tail.test(log.refusals[0].tail));
	}
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(3, { driverName: "Dispatch" });
		t("guard (b), a reserved name: the message names no account", r.status === 409 && !/\(user \d+\)/.test((r.body || {}).error || ""));
	}

	// Guard (b) must not refuse this account's own name, however it is spelled.
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(3, { driverName: "BOB  driver" });
		t(`this account's own name re-spelled is saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 3) === "BOB  driver");
	}
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(5, { driverName: "lee park" });
		t(`renaming a driver to their own username is saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 5) === "lee park");
	}
	{
		// Another account ALREADY shares this account's name (a state from before
		// the check). Re-spelling this account's own name adds nothing to it.
		const db = usersFixture();
		addUser(db, 6, "sking2", "SHORN KING");
		const { put } = mountUsersPut(db, opts);
		const r = await put(6, { driverName: "Shorn  King" });
		t(`re-spelling a name another account already shares is saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 6) === "Shorn  King");
	}
	// ...except onto the exact spelling, case aside, that the other account has.
	for (const name of ["shorn  king", " SHORN  KING "]) {
		const db = usersFixture();
		addUser(db, 6, "sking2", "Shorn  King"); // a second spelling of sking's name, from before the check
		const before = snapshot(db);
		const { put, log } = mountUsersPut(db, opts);
		const r = await put(2, { driverName: name });
		const body = r.body || {};
		t(`re-spelling this account's own name onto another account's exact spelling (${JSON.stringify(name)}): 409 DRIVER_NAME_TAKEN naming it (got ${r.status} ${body.code || ""})`,
			r.status === 409 && body.code === "DRIVER_NAME_TAKEN" && /already belongs to sking2 \(user 6\)/.test(body.error || ""));
		t(`...nothing written, and the refusal audited (${JSON.stringify(name)})`,
			snapshot(db) === before && log.refusals.length === 1 && log.refusals[0].code === "DRIVER_NAME_TAKEN" &&
			/driver name already belongs to sking2 \(user 6\)/.test(log.refusals[0].tail));
	}
	{
		const db = usersFixture();
		addUser(db, 6, "sking2", "Shorn  King");
		const { put } = mountUsersPut(db, opts);
		const r = await put(2, { driverName: "SHORN KING" });
		t(`...while a case-only re-spelling beside that account is saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 2) === "SHORN KING");
	}

	// Guard (e): a directory-only driver in another spacing is a merge.
	{
		const db = usersFixture();
		const before = snapshot(db);
		const { put } = mountUsersPut(db, opts);
		const r = await put(3, { driverName: "deshorn   KING" });
		const body = r.body || {};
		t(`guard (e), a directory-only driver's name in another spacing: 409 DRIVER_RENAME_IS_MERGE naming drivers_directory (got ${r.status} ${body.code || ""})`,
			r.status === 409 && body.code === "DRIVER_RENAME_IS_MERGE" && !!body.mergeTargets && body.mergeTargets.drivers_directory >= 1);
		t("guard (e), ...and nothing written", snapshot(db) === before);
	}
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(3, { driverName: "Deshorn King" });
		t(`guard (e), the same driver spelled exactly is still a merge (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 409 && (r.body || {}).code === "DRIVER_RENAME_IS_MERGE");
	}
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(2, { driverName: "Shorn Kingsley" });
		t(`guard (e), this account's own directory row is not a merge: a free name is saved and the row renamed (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 2) === "Shorn Kingsley" && directoryNames(db)[0] === "Shorn Kingsley");
	}

	// A FIRST driver name that matches a directory-only driver in another spacing
	// links to that driver; the directory sync adds no second row.
	{
		const db = usersFixture();
		const { put } = mountUsersPut(db, opts);
		const r = await put(7, { driverName: "Deshorn  King" });
		t(`a first driver name matching a directory-only driver in another spacing is saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 7) === "Deshorn  King");
		t(`...and no second directory row appears (directory: ${JSON.stringify(directoryNames(db))})`,
			JSON.stringify(directoryNames(db)) === JSON.stringify(["Shorn King", "Bob Driver", "Deshorn King"]));
	}
	return results;
}

// ─────────────────────────────── §2 PUT /api/admin/fix-driver-name
function fixFixture() {
	const db = usersFixture();
	addUser(db, 8, "rob", "Robert Driver"); // an account with no directory row
	addUser(db, 9, "tdriver", "Tim Driver"); // another
	return db;
}

async function fixBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });

	// Another account's driver name in another spacing: a merge, flagged.
	{
		const db = fixFixture();
		const { fix, log } = mountFix(db, opts);
		const dry = await fix({ oldName: "Bob Driver", newName: "ROBERT  driver" }, { dryRun: "true" });
		const v = (dry.body || {}).verdict || {};
		t(`another account's driver name in another spacing: the dry run calls it a merge (got ${dry.status} isMerge=${v.isMerge})`,
			dry.status === 200 && v.isMerge === true && !!v.mergeTargets && v.mergeTargets.users >= 1 && dry.body.wouldWrite === true);
		const r = await fix({ oldName: "Bob Driver", newName: "ROBERT  driver" });
		const audit = log.audits.find((a) => a.action === "fix_driver_name");
		const details = audit ? JSON.parse(audit.details) : {};
		t(`...and the rename runs as a merge, with the by-id reversal recipe (got ${r.status})`,
			r.status === 200 && (r.body || {}).isMerge === true && /MERGE/.test((r.body || {}).reversal || "") &&
			details.isMerge === true && !!details.changedIds && driverNameOf(db, 3) === "ROBERT  driver");
	}
	// A directory-only driver in another spacing, the old name holding no row.
	{
		const db = fixFixture();
		const { fix } = mountFix(db, opts);
		const r = await fix({ oldName: "Tim Driver", newName: "deshorn   king" });
		t(`a directory-only driver in another spacing: a merge (got ${r.status} isMerge=${(r.body || {}).isMerge})`,
			r.status === 200 && (r.body || {}).isMerge === true);
	}
	// Directory rows on both sides that differ only in spacing: refused.
	{
		const db = fixFixture();
		const before = snapshot(db);
		const { fix, log } = mountFix(db, opts);
		const dry = await fix({ oldName: "Bob Driver", newName: "Shorn  King" }, { dryRun: "true" });
		const v = (dry.body || {}).verdict || {};
		t(`directory rows on both sides, spacing only: the dry run blocks with DIRECTORY_NAME_VARIANT (got ${v.decision} ${v.code})`,
			dry.status === 200 && v.decision === "block" && v.code === "DIRECTORY_NAME_VARIANT" && dry.body.wouldWrite === false);
		const r = await fix({ oldName: "Bob Driver", newName: "Shorn  King", acknowledgeLockedPeriods: true, reason: "combining two records" });
		t(`...the rename answers 409 DIRECTORY_NAME_VARIANT, even acknowledged (got ${r.status} ${(r.body || {}).code})`,
			r.status === 409 && (r.body || {}).code === "DIRECTORY_NAME_VARIANT" && /Merge or delete the redundant row first/.test((r.body || {}).error || ""));
		t("...writes nothing, leaves the sheet untouched, and is audited",
			snapshot(db) === before && log.sheetWrites === 0 && log.refusals.some((x) => x.code === "DIRECTORY_NAME_VARIANT"));
	}
	// The case-only pair is still the constraint's own pre-flight, with its own rationale.
	{
		const db = fixFixture();
		const { fix } = mountFix(db, opts);
		const dry = await fix({ oldName: "Bob Driver", newName: "SHORN KING" }, { dryRun: "true" });
		const v = (dry.body || {}).verdict || {};
		t(`directory rows on both sides, case only: DIRECTORY_NAME_COLLISION, explained as the UNIQUE constraint (got ${v.code})`,
			v.decision === "block" && v.code === "DIRECTORY_NAME_COLLISION" && /UNIQUE constraint/.test(v.rationale || "") &&
			!(v.blockers || []).some((b) => b.code === "DIRECTORY_NAME_VARIANT"));
	}
	// A reserved name, or another account's username: refused.
	for (const [label, name, detail] of [
		["a reserved name", "Dispatch", /is a reserved name/],
		["another account's username", "Kevin", /is the username of kevin \(user 4\)/],
	]) {
		const db = fixFixture();
		const before = snapshot(db);
		const { fix, log } = mountFix(db, opts);
		const dry = await fix({ oldName: "Bob Driver", newName: name }, { dryRun: "true" });
		const v = (dry.body || {}).verdict || {};
		t(`${label}: the dry run blocks with DRIVER_NAME_TAKEN (got ${v.decision} ${v.code})`,
			v.decision === "block" && v.code === "DRIVER_NAME_TAKEN" && dry.body.wouldWrite === false);
		const r = await fix({ oldName: "Bob Driver", newName: name, acknowledgeLockedPeriods: true, reason: "combining two records" });
		t(`${label}: 409 DRIVER_NAME_TAKEN, even acknowledged, saying why (got ${r.status} ${(r.body || {}).code})`,
			r.status === 409 && (r.body || {}).code === "DRIVER_NAME_TAKEN" && detail.test((r.body || {}).error || ""));
		t(`${label}: nothing written, the sheet untouched, the refusal audited`,
			snapshot(db) === before && log.sheetWrites === 0 && log.refusals.some((x) => x.code === "DRIVER_NAME_TAKEN"));
	}
	// The renamed account's own username is not a refusal.
	{
		const db = fixFixture();
		const { fix } = mountFix(db, opts);
		const r = await fix({ oldName: "L. Park", newName: "lee park" });
		t(`renaming a driver to their own username runs (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && driverNameOf(db, 5) === "lee park");
	}
	// The same name re-spelled finds only its own rows: no merge.
	{
		const db = fixFixture();
		const { fix } = mountFix(db, opts);
		const r = await fix({ oldName: "Bob Driver", newName: "Bob  Driver" });
		t(`the same name re-spelled is not a merge (got ${r.status} isMerge=${(r.body || {}).isMerge})`,
			r.status === 200 && (r.body || {}).isMerge === false && driverNameOf(db, 3) === "Bob  Driver");
	}
	// A free name: a plain rename.
	{
		const db = fixFixture();
		const { fix } = mountFix(db, opts);
		const r = await fix({ oldName: "Bob Driver", newName: "Robert Brown" });
		t(`a free name: a plain rename (got ${r.status} isMerge=${(r.body || {}).isMerge})`,
			r.status === 200 && (r.body || {}).isMerge === false && driverNameOf(db, 3) === "Robert Brown" && directoryNames(db)[1] === "Robert Brown");
	}
	return results;
}

// ─────────────────────────────── §3 PUT /api/drivers-directory/:id
async function directoryBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const fixture = () => {
		const db = usersFixture();
		addUser(db, 9, "jhill", "Jonas Hill"); // an account with no directory row
		return db;
	};
	for (const [label, name] of [
		["another row's name, exactly", "Shorn King"],
		["another row's name, case and spacing changed", "SHORN  KING"],
		["another row's name, padded", "  Shorn King  "],
	]) {
		const db = fixture();
		const before = snapshot(db);
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(3, ["Driver"], [name]);
		const body = r.body || {};
		t(`${label}: 409 DRIVER_EXISTS naming row 1 (got ${r.status} ${body.code || ""})`,
			r.status === 409 && body.code === "DRIVER_EXISTS" && body.id === 1 && body.route === "PUT /api/drivers-directory/1");
		t(`${label}: nothing written`, snapshot(db) === before);
	}
	{
		const db = fixture();
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(3, ["Driver"], ["DESHORN  king"]);
		t(`the row's own name re-spelled is saved (got ${r.status})`, r.status === 200 && directoryNames(db)[2] === "DESHORN  king");
	}
	{
		// A second spelling of row 1's name is already stored, from before the
		// check. Re-spelling row 1 onto it exactly (case aside) is the pair the
		// column's UNIQUE COLLATE NOCASE rejects: a 409 naming that row, not the
		// constraint's error.
		const db = fixture();
		const variantId = addDirectory(db, "Shorn  King");
		const before = snapshot(db);
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(1, ["Driver"], ["shorn  KING"]);
		const body = r.body || {};
		t(`the row's own name re-spelled onto another row's exact spelling: 409 DRIVER_EXISTS naming row ${variantId} (got ${r.status} ${body.code || ""} ${body.id || ""})`,
			r.status === 409 && body.code === "DRIVER_EXISTS" && body.id === variantId && body.route === `PUT /api/drivers-directory/${variantId}`);
		t("...nothing written", snapshot(db) === before);
		const r2 = await put(1, ["Driver"], ["SHORN KING"]);
		t(`...while a case-only re-spelling beside that row is saved (got ${r2.status})`, r2.status === 200 && directoryNames(db)[0] === "SHORN KING");
	}
	for (const [label, value] of [["an object", { a: 1 }], ["a number", 42], ["a list", ["Shorn", "King"]]]) {
		const db = fixture();
		const before = snapshot(db);
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(2, ["Driver"], [value]);
		t(`a Driver sent as ${label}: 400 INVALID_DRIVER_NAME, nothing written (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 400 && (r.body || {}).code === "INVALID_DRIVER_NAME" && snapshot(db) === before);
	}
	{
		const db = fixture();
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(3, ["Driver"], ["Jonas Hill"]);
		t(`a name only an account holds is saved — it becomes that account's row (got ${r.status})`, r.status === 200 && directoryNames(db)[2] === "Jonas Hill");
	}
	{
		const db = fixture();
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(2, ["Driver"], ["  Robert Brown "]);
		t(`a free name is saved, trimmed (got ${r.status})`, r.status === 200 && directoryNames(db)[1] === "Robert Brown");
	}
	{
		const db = fixture();
		const before = snapshot(db);
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(3, ["Driver"], ["   "]);
		t(`a blank name: 400 DRIVER_NAME_REQUIRED, nothing written (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 400 && (r.body || {}).code === "DRIVER_NAME_REQUIRED" && snapshot(db) === before);
	}
	{
		const db = fixture();
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(2, ["PhoneNumber"], ["555-0100"]);
		t(`a request without the Driver column keeps the name (got ${r.status}, directory ${JSON.stringify(directoryNames(db))})`,
			r.status === 200 && directoryNames(db)[1] === "Bob Driver");
	}
	return results;
}

// ─────────────────────────────── §4 truck assignment and the directory sync
function trucksFixture() {
	const db = usersFixture();
	addUser(db, 9, "tdriver", "Tim Driver"); // an account whose name has no directory row
	addTruck(db, 1, "101", "Shorn King");
	addTruck(db, 2, "102", "");
	return db;
}
const activeAssignments = (db) => db.prepare("SELECT truck_id, driver_name FROM truck_assignments WHERE end_date = '' ORDER BY truck_id").all();
const truckDrivers = (db) => db.prepare("SELECT id, assigned_driver FROM trucks ORDER BY id").all().map((r) => `${r.id}:${r.assigned_driver}`).join(",");

async function trucksBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });

	for (const [label, name] of [["spacing and case changed", "shorn  KING"], ["case changed", "SHORN KING"]]) {
		const db = trucksFixture();
		const { put } = mountTrucks(db, opts);
		const r = await put(2, { assignedDriver: name });
		t(`PUT /api/trucks/:id, the driver named with ${label}: resolves to "Shorn King" (got ${r.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && truckDrivers(db) === "1:,2:Shorn King");
		t(`...one active assignment, under the driver's spelling (got ${JSON.stringify(activeAssignments(db))})`,
			JSON.stringify(activeAssignments(db)) === JSON.stringify([{ truck_id: 2, driver_name: "Shorn King" }]));
		t(`...and no second directory row (directory ${JSON.stringify(directoryNames(db))})`,
			JSON.stringify(directoryNames(db)) === JSON.stringify(["Shorn King", "Bob Driver", "Deshorn King"]));
	}
	{
		const db = trucksFixture();
		const { put } = mountTrucks(db, opts);
		const r = await put(2, { assignedDriver: "tim  DRIVER" });
		t(`a driver known only by an account resolves to that account's spelling (got ${r.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && truckDrivers(db) === "1:Shorn King,2:Tim Driver");
	}
	{
		const db = trucksFixture();
		const { put } = mountTrucks(db, opts);
		const r = await put(2, { assignedDriver: "Brand New" });
		t(`a new name is stored as sent and still gets its pending directory row (got ${r.status}, directory ${JSON.stringify(directoryNames(db))})`,
			r.status === 200 && truckDrivers(db) === "1:Shorn King,2:Brand New" &&
			JSON.stringify(directoryNames(db)) === JSON.stringify(["Shorn King", "Bob Driver", "Deshorn King", "Brand New"]));
	}
	{
		const db = trucksFixture();
		const { put } = mountTrucks(db, opts);
		const r = await put(1, { assignedDriver: "" });
		t(`unassigning still unassigns (got ${r.status}, trucks ${truckDrivers(db)})`, r.status === 200 && truckDrivers(db) === "1:,2:");
	}
	{
		const db = trucksFixture();
		const { post } = mountTrucks(db, opts);
		const r = await post({ unitNumber: "103", assignedDriver: "  SHORN   king " });
		t(`POST /api/trucks, the driver named in another spacing: resolves to "Shorn King" and releases the other truck (got ${r.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && truckDrivers(db) === "1:,2:,3:Shorn King");
	}
	{
		const db = trucksFixture();
		const { post } = mountTrucks(db, opts);
		const r = await post({ unitNumber: "104", assignedDriver: "Shorn King" }, "Investor");
		t(`POST /api/trucks by an Investor still names no driver, and releases no one (got ${r.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && truckDrivers(db) === "1:Shorn King,2:,3:");
	}
	{
		// The directory sync on its own: its add branch never adds a row for a
		// name the directory already holds apart from case or spacing.
		const db = trucksFixture();
		const { m } = mountTrucks(db, opts);
		m.syncDriverToCarrierSheet("Shorn  King", { action: "add" });
		m.syncDriverToCarrierSheet("deshorn king", { action: "add" });
		m.syncDriverToCarrierSheet("Bob Driver", { action: "update" });
		t(`syncDriverToCarrierSheet adds no row for a spacing or case variant (directory ${JSON.stringify(directoryNames(db))})`,
			JSON.stringify(directoryNames(db)) === JSON.stringify(["Shorn King", "Bob Driver", "Deshorn King"]));
		m.syncDriverToCarrierSheet("Fresh Person", { action: "add" });
		t("...and still adds a pending row for a new driver",
			JSON.stringify(db.prepare("SELECT driver_name, status FROM drivers_directory WHERE driver_name = 'Fresh Person'").all()) ===
				JSON.stringify([{ driver_name: "Fresh Person", status: "pending" }]));
	}
	{
		const db = trucksFixture();
		const { m } = mountTrucks(db, opts);
		const c = m.canonicalDriverName;
		t("canonicalDriverName: a driver in another spacing → the spelling the driver already has", c("  shorn  king ") === "Shorn King");
		t("canonicalDriverName: a directory-only driver → the directory's spelling", c("DESHORN  king") === "Deshorn King");
		t("canonicalDriverName: a driver known only by an account → the account's spelling", c("TIM  driver") === "Tim Driver");
		t("canonicalDriverName: a username is not a driver identity → returned as sent", c(" kevin ") === "kevin");
		t("canonicalDriverName: a reserved name → returned as sent", c("Dispatch") === "Dispatch");
		t("canonicalDriverName: a new name → trimmed", c("  Brand New ") === "Brand New");
		t("canonicalDriverName: blank or non-string → \"\"", c("   ") === "" && c(null) === "" && c(42) === "");
		db.prepare("UPDATE drivers_directory SET driver_name = 'Shorn  King' WHERE id = 1").run();
		t("canonicalDriverName: an account and a directory row spelling one driver differently → the account's spelling",
			c("SHORN KING") === "Shorn King" && c("shorn  king") === "Shorn King");
	}

	// The truck's own driver, stored in an older spelling and on an active load.
	// The Trucks screen sends the driver only when it changed, but an older page
	// or a direct API caller may still re-send the stored driver on every save,
	// so an ordinary edit must not be read as moving that driver onto this truck.
	{
		const db = trucksFixture();
		db.prepare("UPDATE trucks SET assigned_driver = 'Shorn  King' WHERE id = 1").run();
		db.prepare("UPDATE truck_assignments SET driver_name = 'Shorn  King' WHERE truck_id = 1").run();
		const { put } = mountTrucks(db, { ...opts, busy: ["Shorn King"] });
		const r = await put(1, { assignedDriver: "Shorn  King", notes: "new tyres" });
		const notes = (db.prepare("SELECT notes FROM trucks WHERE id = 1").get() || {}).notes;
		t(`PUT /api/trucks/:id, a save re-sending the truck's own driver in an older spelling while that driver is on a load: 200, saved under the driver's spelling (got ${r.status} ${JSON.stringify(r.body)}, trucks ${truckDrivers(db)})`,
			r.status === 200 && notes === "new tyres" && truckDrivers(db) === "1:Shorn King,2:" &&
			JSON.stringify(activeAssignments(db)) === JSON.stringify([{ truck_id: 1, driver_name: "Shorn King" }]));
		const before = JSON.stringify([truckDrivers(db), activeAssignments(db)]);
		const r2 = await put(2, { assignedDriver: "shorn king" });
		t(`...while moving that driver to another truck is still refused for the active load, nothing written (got ${r2.status})`,
			r2.status === 409 && /already has an active load/.test((r2.body || {}).error || "") &&
			JSON.stringify([truckDrivers(db), activeAssignments(db)]) === before);
	}
	// The account and the directory row spell the driver differently. The truck
	// takes the account's spelling, and the save does not treat the spelling it
	// replaced as a different, departing driver: the directory row keeps its
	// name and its truck.
	{
		const db = trucksFixture();
		db.prepare("UPDATE drivers_directory SET driver_name = 'Shorn  King', trucks = '101' WHERE id = 1").run();
		db.prepare("UPDATE trucks SET assigned_driver = 'Shorn  King' WHERE id = 1").run();
		db.prepare("UPDATE truck_assignments SET driver_name = 'Shorn  King' WHERE truck_id = 1").run();
		const { put, syncCalls } = mountTrucks(db, opts);
		const r = await put(1, { assignedDriver: "Shorn  King", notes: "x" });
		const row = db.prepare("SELECT driver_name, trucks FROM drivers_directory WHERE id = 1").get();
		t(`an account and a directory row spelling one driver differently: the truck takes the account's spelling (got ${r.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && truckDrivers(db) === "1:Shorn King,2:");
		t(`...and the directory row keeps its name and its truck (got ${JSON.stringify(row)})`,
			!!row && row.driver_name === "Shorn  King" && row.trucks === "101" && directoryNames(db).length === 3);
		t(`...and the save syncs that driver once, under the spelling it kept — never the replaced spelling as a departing driver (got ${JSON.stringify(syncCalls)})`,
			JSON.stringify(syncCalls) === JSON.stringify([["Shorn King", "update"]]));
	}

	// A driver name is text: anything else is refused before anything is resolved or written.
	for (const [label, value] of [["an object", { a: 1 }], ["a list", ["Shorn King", "Bob Driver"]], ["a number", 7]]) {
		const db = trucksFixture();
		const state = () => JSON.stringify([truckDrivers(db), activeAssignments(db), directoryNames(db)]);
		const before = state();
		const { put, post } = mountTrucks(db, opts);
		const r = await put(2, { assignedDriver: value });
		t(`PUT /api/trucks/:id, assignedDriver as ${label}: 400 INVALID_DRIVER_NAME (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 400 && (r.body || {}).code === "INVALID_DRIVER_NAME");
		const p = await post({ unitNumber: "109", assignedDriver: value });
		t(`POST /api/trucks, assignedDriver as ${label}: 400 INVALID_DRIVER_NAME (got ${p.status} ${(p.body || {}).code || ""})`,
			p.status === 400 && (p.body || {}).code === "INVALID_DRIVER_NAME");
		t(`...and neither wrote anything (${label})`, state() === before);
	}
	{
		const db = trucksFixture();
		const { put, post } = mountTrucks(db, opts);
		const r = await put(1, { assignedDriver: null });
		const p = await post({ unitNumber: "110", assignedDriver: null });
		t(`null still means no driver, on both routes (got ${r.status}/${p.status}, trucks ${truckDrivers(db)})`,
			r.status === 200 && p.status === 200 && truckDrivers(db) === "1:,2:,3:");
	}
	return results;
}

// ─────────────────────────────── §4b the pay structure follows a re-spelled name
// getDriverPayStructures()'s answer for a name, the way its callers ask:
// indexed by normalizeDriverName().
function payDailyOf(db, name, moduleSrc = {}) {
	const m = buildModule(db, moduleSrc);
	const e = console.error;
	console.error = () => {}; // two rows for one name are reported there, as expected below
	try {
		const s = m.getDriverPayStructures()[m.normalizeDriverName(name)];
		return s ? s.payDaily : null;
	} finally {
		console.error = e;
	}
}

async function payBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const ms = opts.moduleSrc || {};
	{
		const db = usersFixture();
		db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE id = 1").run();
		const { put } = mountDirectoryPut(db, opts);
		const r = await put(1, ["Driver"], ["SHORN  king"]);
		t(`a directory row re-spelled in case and spacing by PUT /api/drivers-directory/:id keeps its pay structure under the driver's name (got ${r.status}, pay ${payDailyOf(db, "Shorn King", ms)})`,
			r.status === 200 && payDailyOf(db, "Shorn King", ms) === 300 && payDailyOf(db, "shorn   KING", ms) === 300);
	}
	{
		const db = usersFixture();
		db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE id = 1").run();
		const { put } = mountUsersPut(db, opts);
		const r = await put(2, { driverName: "Shorn  King" });
		t(`...so does one re-spelled by PUT /api/users/:id's cascade (got ${r.status}, directory ${JSON.stringify(directoryNames(db))}, pay ${payDailyOf(db, "Shorn King", ms)})`,
			r.status === 200 && directoryNames(db)[0] === "Shorn  King" && payDailyOf(db, "Shorn King", ms) === 300);
	}
	{
		const db = fixFixture();
		db.prepare("UPDATE drivers_directory SET pay_daily = 275 WHERE id = 2").run();
		const { fix } = mountFix(db, opts);
		const r = await fix({ oldName: "Bob Driver", newName: "Bob  Driver" });
		t(`...and one re-spelled by fix-driver-name (got ${r.status}, directory ${JSON.stringify(directoryNames(db))}, pay ${payDailyOf(db, "Bob Driver", ms)})`,
			r.status === 200 && directoryNames(db)[1] === "Bob  Driver" && payDailyOf(db, "Bob Driver", ms) === 275);
	}
	{
		const db = usersFixture();
		db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE id = 1").run();
		addDirectory(db, "Shorn  King"); // a second row for the same name in another spacing, at the defaults
		t("two rows for one name: the first by id wins, under either spelling",
			payDailyOf(db, "Shorn King", ms) === 300 && payDailyOf(db, "Shorn  King", ms) === 300);
	}
	return results;
}

// ─────────────────────────────── §4c the cascade renames a spacing-variant directory row
// The cascade's drivers_directory leg renames the row findDirectoryRowForDriver()
// finds for the old name, so a row stored under a spacing variant of it moves
// with the driver — and the sync that follows adds no second row at the
// default terms (the shadow row identity-collation.md describes).
async function cascadeBattery(opts = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const ms = opts.moduleSrc || {};
	const spacedFixture = (base) => {
		const db = base();
		// sking's directory row, stored with a doubled space, carrying the $300 rate.
		db.prepare("UPDATE drivers_directory SET driver_name = 'Shorn  King', pay_daily = 300 WHERE id = 1").run();
		return db;
	};
	const rows = (db) => db.prepare("SELECT id, driver_name, pay_daily FROM drivers_directory ORDER BY id").all()
		.map((r) => `${r.id}:${r.driver_name}:${r.pay_daily}`).join(" | ");
	{
		const db = spacedFixture(usersFixture);
		const { put } = mountUsersPut(db, opts);
		const r = await put(2, { driverName: "Shaun King" });
		t(`PUT /api/users/:id renaming "Shorn King" to "Shaun King": the directory row stored as "Shorn  King" is renamed, keeping its id and rate, and no second row appears (got ${r.status}, ${rows(db)})`,
			r.status === 200 && rows(db) === "1:Shaun King:300 | 2:Bob Driver:0 | 3:Deshorn King:0");
		t(`...so the renamed driver's pay structure is still the $300 row (got ${payDailyOf(db, "Shaun King", ms)})`,
			payDailyOf(db, "Shaun King", ms) === 300);
	}
	{
		const db = spacedFixture(fixFixture);
		const { fix, log } = mountFix(db, opts);
		const dry = await fix({ oldName: "Shorn King", newName: "Shaun King" }, { dryRun: "true" });
		const planned = dry.body && dry.body.plan && dry.body.plan.sqlite && dry.body.plan.sqlite.drivers_directory;
		t(`fix-driver-name's dry run counts the directory row stored as "Shorn  King" (got ${dry.status}, ${JSON.stringify(planned || null)})`,
			dry.status === 200 && planned && planned.rows === 1 && rows(db) === "1:Shorn  King:300 | 2:Bob Driver:0 | 3:Deshorn King:0");
		const r = await fix({ oldName: "Shorn King", newName: "Shaun King" });
		t(`fix-driver-name renames it, keeping its id and rate (got ${r.status}, ${rows(db)})`,
			r.status === 200 && rows(db) === "1:Shaun King:300 | 2:Bob Driver:0 | 3:Deshorn King:0" && log.sheetWrites === 0);
		// A later sync under the new name (a truck assignment, an email change)
		// finds that row and adds nothing.
		buildModule(db, ms).syncDriverToCarrierSheet("Shaun King", { action: "update" });
		t(`...and a sync under the new name afterwards adds no second row (got ${rows(db)}, pay ${payDailyOf(db, "Shaun King", ms)})`,
			rows(db) === "1:Shaun King:300 | 2:Bob Driver:0 | 3:Deshorn King:0" && payDailyOf(db, "Shaun King", ms) === 300);
	}
	{
		// Renamed onto another row's name, the row found by id would be written a
		// name another row holds: the UNIQUE pre-flight counts it and refuses before
		// anything is written.
		const db = spacedFixture(fixFixture);
		const before = rows(db);
		const { fix, log } = mountFix(db, opts);
		const r = await fix({ oldName: "Shorn King", newName: "Bob Driver", acknowledgeLockedPeriods: true });
		t(`fix-driver-name renaming it onto "Bob Driver", who has a directory row: 409 DIRECTORY_NAME_COLLISION, nothing written, the sheet untouched (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 409 && (r.body || {}).code === "DIRECTORY_NAME_COLLISION" && rows(db) === before && log.sheetWrites === 0);
	}
	return results;
}

// ─────────────────────────────── §5 source pins
function sourcePins() {
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const upd = code(ROUTES.usersPut);
	const bAt = upd.indexOf("findDriverNameClash(nextName, { exceptUserId: id, directory: false })");
	const b2At = upd.indexOf("findDriverNameClashes(nextName, { exceptUserId: id, directory: false })");
	const eAt = upd.indexOf("findDriverNameClash(driverName, { users: false })");
	ok(bAt > 0, "§5 PUT /api/users/:id guard (b) asks findDriverNameClash(nextName, { exceptUserId: id, directory: false })");
	ok(b2At > 0, "§5 PUT /api/users/:id guard (b) asks findDriverNameClashes(...) for a re-spelling of the account's own name");
	ok(eAt > 0, "§5 PUT /api/users/:id guard (e) asks findDriverNameClash(driverName, { users: false })");
	ok(upd.lastIndexOf("await ") < Math.min(bAt, b2At, eAt), "§5 ...all after the route's last await");
	ok(Math.max(bAt, b2At, eAt) < upd.indexOf("db.transaction("), "§5 ...all before its write");
	ok(/normalizeDriverName\(nextName\) !== normalizeDriverName\(user\.driver_name\)/.test(upd),
		"§5 PUT /api/users/:id guard (b) decides \"is it a change\" with normalizeDriverName() on both sides");
	ok(!/(TRIM\(LOWER\(|LOWER\(TRIM\()\s*driver_name/.test(upd), "§5 PUT /api/users/:id keeps no TRIM/LOWER clash query");

	const fx = code(ROUTES.fix);
	const askAt = fx.indexOf("findDriverNameClashes(newTrim, { exceptUserIds: movingAccountIds })");
	ok(askAt > 0, "§5 fix-driver-name asks findDriverNameClashes(newTrim, { exceptUserIds: movingAccountIds })");
	ok(askAt > 0 && askAt < fx.indexOf("batchUpdate(") && askAt < fx.indexOf("const isMerge = "),
		"§5 ...in the plan, before isMerge is decided and before the sheet is written");
	const readAt = fx.indexOf("renamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);");
	const cascadeAt = fx.indexOf("applyDriverRenameSqlite({");
	ok(readAt > 0 && cascadeAt > readAt && !/findDriverNameClash/.test(fx.slice(readAt, cascadeAt)),
		"§5 ...and outside the session read → cascade window scripts/test-session-sockets.js pins");
	ok(fx.includes("const caseOnly = oldLower === newTrim.toLowerCase();"), "§5 fix-driver-name's caseOnly is unchanged");
	const planner = code(PLANNER_SRC);
	ok(!/findDriverNameClash/.test(planner) && planner.includes('code: "DIRECTORY_NAME_COLLISION"') &&
		planner.includes('WHERE LOWER(TRIM("${t.column}")) = ? OR LOWER(TRIM("${t.column}")) = ?'),
		"§5 the DIRECTORY_NAME_COLLISION pre-flight still mirrors the NOCASE constraint and does not use the helper");
	const hard = new Function(`${HARD_BLOCK_SRC}\nreturn DRIVER_RENAME_HARD_BLOCK_CODES;`)();
	ok(["INVOICE_WEEK_COLLISION", "TARGET_UNREADABLE", "DIRECTORY_NAME_COLLISION", "DIRECTORY_NAME_VARIANT", "DRIVER_NAME_TAKEN"].every((c) => hard.has(c)),
		"§5 DRIVER_NAME_TAKEN and DIRECTORY_NAME_VARIANT are hard blocks, beside the three that were");

	const dir = code(ROUTES.dirPut);
	const dAsk = dir.indexOf("findDriverNameClashes(nextName, { users: false, exceptDirectoryId: id })");
	ok(dAsk > 0 && dAsk < dir.indexOf("UPDATE drivers_directory SET"), "§5 PUT /api/drivers-directory/:id asks the helper, leaving its own row out, before its UPDATE");
	const dType = dir.indexOf('typeof obj.Driver !== "string"');
	ok(dType > 0 && dType < dir.indexOf("const nextName = "), "§5 ...and refuses a Driver that is not text before reading it");

	const tp = code(ROUTES.truckPut);
	const canon = tp.indexOf("canonicalDriverName(");
	ok(canon > 0 && canon < tp.indexOf("assignDriverToTruck(") && canon < tp.indexOf("truckEditLockBlockers("),
		"§5 PUT /api/trucks/:id resolves the driver before its guard and its assignment");
	ok(tp.includes("assignDriverToTruck(id, nextAssignedDriver);") && tp.includes('params.push(nextAssignedDriver);') &&
		tp.includes('syncDriverToCarrierSheet(nextAssignedDriver, { action: "update" });'),
		"§5 ...and assigns, stores and syncs that one spelling");
	ok(tp.includes("normalizeDriverName(nextAssignedDriver) !== normalizeDriverName(truck.assigned_driver)") &&
		tp.includes("normalizeDriverName(oldDriver) !== normalizeDriverName(nextAssignedDriver)") &&
		!/toLowerCase\(\) !== \(truck\.assigned_driver/.test(tp) && !/oldDriver\.trim\(\)\.toLowerCase\(\)/.test(tp),
		"§5 ...and tells a different driver from a re-spelling with normalizeDriverName(), for the active-load check and the previous driver's sync");
	const tType = tp.indexOf('typeof assignedDriver !== "string"');
	ok(tType > 0 && tType < canon && tType < tp.indexOf("await ") && tType < tp.indexOf("assignDriverToTruck(") &&
		tType < tp.indexOf("db.prepare(`UPDATE trucks SET"),
		"§5 PUT /api/trucks/:id refuses an assignedDriver that is not text before resolving, awaiting or writing");
	const tpo = code(ROUTES.truckPost);
	const pCanon = tpo.indexOf("canonicalDriverName(");
	ok(pCanon > 0 && pCanon < tpo.indexOf("truckCreateLockBlockers(") && pCanon < tpo.indexOf("assignDriverToTruck("),
		"§5 POST /api/trucks resolves the driver before its guard and its assignment");
	ok(tpo.lastIndexOf("await ") < pCanon, "§5 ...after the route's last await");
	const pType = tpo.indexOf('typeof assignedDriver !== "string"');
	ok(pType > 0 && pType < tpo.indexOf("const requestedDriver = ") && pType < tpo.indexOf("await "),
		"§5 POST /api/trucks refuses an assignedDriver that is not text before reading it or awaiting");

	const sync = code(SYNC_SRC);
	const sAsk = sync.indexOf("findDriverNameClash(driverName, { users: false })");
	ok(sAsk > 0 && sAsk < sync.indexOf("INSERT OR IGNORE INTO drivers_directory"),
		"§5 syncDriverToCarrierSheet's add branch asks the helper before it inserts");

	const pay = code(PAY_SRC);
	ok(pay.includes("const key = normalizeDriverName(r.driver_name);") && !/LOWER\(|TRIM\(/.test(pay),
		"§5 getDriverPayStructures() keys each row by normalizeDriverName(), with no SQL folding of its own");
	console.log("  source pins checked");
}

// ─────────────────────────────── §6 mutants
async function mutants() {
	const caught = (label, results) => {
		const bad = results.filter((r) => !r.ok);
		ok(bad.length > 0, `§6 ${label} was NOT caught — the checks above have lost their teeth`);
		console.log(`  ${label}: caught by ${bad.length} check(s), e.g.`);
		for (const r of bad.slice(0, 2)) console.log(`      ✗ ${r.name}`);
	};
	const swap = (label, src, from, to) => {
		const hits = src.split(from).length - 1;
		ok(hits === 1, `§6 ${label}: marker found ${hits} times — ${from.slice(0, 80)}`);
		return src.replace(from, to);
	};

	const B_ASK = "clash = findDriverNameClash(nextName, { exceptUserId: id, directory: false });";
	caught("R1 PUT /api/users/:id guard (b) back to TRIM(LOWER(driver_name))", await usersBattery({
		routeSrc: swap("R1", ROUTES.usersPut, B_ASK,
			'clash = db.prepare("SELECT id, username FROM users WHERE id <> ? AND TRIM(LOWER(driver_name)) = ?").get(id, nextSpelling) || null;'),
	}));
	caught("R2 PUT /api/users/:id guard (b) deciding \"is it a change\" with trim + lowercase", await usersBattery({
		routeSrc: swap("R2", ROUTES.usersPut, "if (normalizeDriverName(nextName) !== normalizeDriverName(user.driver_name)) {",
			'if (nextSpelling !== String(user.driver_name || "").trim().toLowerCase()) {'),
	}));
	caught("R3 PUT /api/users/:id guard (e) without the directory check", await usersBattery({
		routeSrc: swap("R3", ROUTES.usersPut, "&& findDriverNameClash(driverName, { users: false })) {", "&& false) {"),
	}));
	caught("R4 PUT /api/users/:id guard (b) without exceptUserId", await usersBattery({
		routeSrc: swap("R4", ROUTES.usersPut, "findDriverNameClash(nextName, { exceptUserId: id, directory: false })", "findDriverNameClash(nextName, { directory: false })"),
	}));
	const RESPELL_MATCH = 'h.field === "driver_name" && String(h.driver_name).trim().toLowerCase() === nextSpelling';
	caught("R15 PUT /api/users/:id admitting a re-spelling onto another account's exact spelling", await usersBattery({
		routeSrc: swap("R15", ROUTES.usersPut, `.find((h) => ${RESPELL_MATCH}) || null;`, ".find(() => false) || null;"),
	}));
	caught("R16 PUT /api/users/:id refusing a re-spelling beside any second spelling, not just onto it", await usersBattery({
		routeSrc: swap("R16", ROUTES.usersPut, RESPELL_MATCH, 'h.field === "driver_name"'),
	}));

	const FIX_ASK = "if (normalizeDriverName(oldTrim) !== normalizeDriverName(newTrim)) {\n\t\t\tconst movingAccountIds";
	caught("R5 fix-driver-name without the helper", await fixBattery({
		routeSrc: swap("R5", ROUTES.fix, FIX_ASK, "if (false) {\n\t\t\tconst movingAccountIds"),
	}));
	caught("R6 fix-driver-name without leaving the renamed accounts out", await fixBattery({
		routeSrc: swap("R6", ROUTES.fix, "findDriverNameClashes(newTrim, { exceptUserIds: movingAccountIds })", "findDriverNameClashes(newTrim)"),
	}));
	caught("R7 fix-driver-name without DIRECTORY_NAME_VARIANT", await fixBattery({
		routeSrc: swap("R7", ROUTES.fix, 'if (hit.source === "drivers_directory" && oldDirectoryRows > 0', 'if (false && oldDirectoryRows > 0'),
	}));
	caught("R8 DRIVER_NAME_TAKEN not a hard block (acknowledgeLockedPeriods waves it through)", await fixBattery({
		moduleSrc: { hard: swap("R8", HARD_BLOCK_SRC, ', "DRIVER_NAME_TAKEN"]', "]") },
	}));
	caught("R9 DIRECTORY_NAME_COLLISION borrowing TARGET_UNREADABLE's rationale again", await fixBattery({
		routeSrc: swap("R9", ROUTES.fix, "\t\t\t\tDIRECTORY_NAME_COLLISION: \"Two drivers_directory rows would be written the same name", "\t\t\t\tNOT_A_CODE: \"Two drivers_directory rows would be written the same name"),
	}));

	caught("R10 PUT /api/drivers-directory/:id without the clash check", await directoryBattery({
		routeSrc: swap("R10", ROUTES.dirPut, "const dirClash = findDriverNameClashes(nextName, { users: false, exceptDirectoryId: id })", "const dirClash = []"),
	}));
	caught("R11 PUT /api/drivers-directory/:id writing the raw Driver column again", await directoryBattery({
		routeSrc: swap("R11", ROUTES.dirPut, ".run(writeName, nextCarrier,", '.run(obj.Driver || "", nextCarrier,'),
	}));
	caught("R17 PUT /api/drivers-directory/:id re-spelling a row onto another row's exact spelling unchecked", await directoryBattery({
		routeSrc: swap("R17", ROUTES.dirPut, "renamed || String(h.driver_name).toLowerCase() === nextName.toLowerCase()", "renamed"),
	}));
	caught("R18 PUT /api/drivers-directory/:id without the text check on Driver", await directoryBattery({
		routeSrc: swap("R18", ROUTES.dirPut, 'if (obj.Driver !== undefined && typeof obj.Driver !== "string") {', "if (false) {"),
	}));

	caught("R12 PUT /api/trucks/:id without resolving the driver", await trucksBattery({
		putSrc: swap("R12", ROUTES.truckPut, 'canonicalDriverName(String(assignedDriver || ""))', 'String(assignedDriver || "").trim()'),
	}));
	caught("R13 POST /api/trucks without resolving the driver", await trucksBattery({
		postSrc: swap("R13", ROUTES.truckPost, "const finalAssignedDriver = canonicalDriverName(requestedDriver);", "const finalAssignedDriver = requestedDriver;"),
	}));
	const SYNC_ASK = "if (findDriverNameClash(driverName, { users: false })) return;";
	const noSyncGuard = swap("R14", SYNC_SRC, SYNC_ASK, "");
	caught("R14 syncDriverToCarrierSheet adding a row for a spacing variant", [
		...await trucksBattery({ moduleSrc: { sync: noSyncGuard } }),
		...await usersBattery({ moduleSrc: { sync: noSyncGuard } }),
	]);
	caught("R19 PUT /api/trucks/:id active-load check comparing spellings, not drivers", await trucksBattery({
		putSrc: swap("R19", ROUTES.truckPut, "if (nextAssignedDriver && normalizeDriverName(nextAssignedDriver) !== normalizeDriverName(truck.assigned_driver)) {",
			'if (nextAssignedDriver && nextAssignedDriver.toLowerCase() !== (truck.assigned_driver || "").trim().toLowerCase()) {'),
	}));
	caught("R20 PUT /api/trucks/:id syncing the replaced spelling as a departing driver", await trucksBattery({
		putSrc: swap("R20", ROUTES.truckPut, "if (oldDriver && oldDriver.trim() && normalizeDriverName(oldDriver) !== normalizeDriverName(nextAssignedDriver)) {",
			"if (oldDriver && oldDriver.trim() && oldDriver.trim().toLowerCase() !== nextAssignedDriver.toLowerCase()) {"),
	}));
	const TYPE_CHECK = 'if (assignedDriver !== undefined && assignedDriver !== null && typeof assignedDriver !== "string") {';
	caught("R21 PUT /api/trucks/:id without the text check on assignedDriver", await trucksBattery({
		putSrc: swap("R21", ROUTES.truckPut, TYPE_CHECK, "if (false) {"),
	}));
	caught("R22 POST /api/trucks without the text check on assignedDriver", await trucksBattery({
		postSrc: swap("R22", ROUTES.truckPost, TYPE_CHECK, "if (false) {"),
	}));
	caught("R23 canonicalDriverName() preferring the directory's spelling to the account's", await trucksBattery({
		moduleSrc: { clash: swap("R23", CLASH_SRC,
			'const known = hits.find((h) => h.source === "users" && h.field === "driver_name")\n\t\t|| hits.find((h) => h.source === "drivers_directory");',
			'const known = hits.find((h) => h.source === "drivers_directory")\n\t\t|| hits.find((h) => h.source === "users" && h.field === "driver_name");') },
	}));
	caught("R24 getDriverPayStructures() keyed differently from normalizeDriverName()", await payBattery({
		moduleSrc: { pay: swap("R24", PAY_SRC, "const key = normalizeDriverName(r.driver_name);", 'const key = String(r.driver_name || "").trim().toLowerCase();') },
	}));
	const DIRECTORY_LEG = 'key: "drivers_directory", table: "drivers_directory", column: "driver_name", match: "directory_row",';
	caught("R25 the cascade's drivers_directory leg matched with LOWER() alone again", await cascadeBattery({
		moduleSrc: { cascade: swap("R25", CASCADE_SRC, DIRECTORY_LEG, DIRECTORY_LEG.replace('"directory_row"', '"ci"')) },
	}));
	// No mutant for the merge scan asking its directory leg through the row
	// lookup instead of case-insensitively: driverRenameDirectoryRowId() refuses
	// a spacing variant another account holds, and for the new name that is the
	// renamed account itself whenever the lookup would self-match, so the two
	// answer alike in every scenario here — an equivalent mutant.
}

(async () => {
	section("§1 PUT /api/users/:id");
	record(await usersBattery());
	section("§2 PUT /api/admin/fix-driver-name");
	record(await fixBattery());
	section("§3 PUT /api/drivers-directory/:id");
	record(await directoryBattery());
	section("§4 truck assignment and the directory sync");
	record(await trucksBattery());
	section("§4b the pay structure follows a re-spelled name");
	record(await payBattery());
	section("§4c the rename cascade renames a directory row stored under a spacing variant");
	record(await cascadeBattery());
	section("§5 source pins");
	sourcePins();
	section("§6 mutants — each must be caught");
	await mutants();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
