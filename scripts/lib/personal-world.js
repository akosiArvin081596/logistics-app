// The world the "Personal" receipt runners share: server.js's own code, lifted
// at run time (lib/server-lift.js), on an in-memory SQLite built from
// server.js's own DDL, with a pinned business clock, a stubbed Job Tracking
// sheet and a stubbed PDF renderer. Every name, amount and date here is made up.
//
// The fleet (clock Thu 2026-10-15 12:00 US Eastern; week Sat 10-10 .. Fri 10-16):
//   investor 7 (split 50%) owns trucks T-1 and T-2;
//   "Test Driver A"  fixed $300/day on T-1;
//   "Test Driver B"  fixed $250/day on T-3 (company truck, owner 0);
//   "Test Owner Op"  percentage 25% on T-2;
//   August and September 2026 are closed (period_locks).
// Receipts (ids are fixed so the runners can name them):
//   1 R1  A  Fuel   $200.00  50 gal  2026-10-12 Approved  "Pilot #123"
//   2 R2  A  Other   $45.50          2026-10-13 Pending   "Love's #77"
//   3 R3  A  Fuel   $300.00          2026-08-30 Pending   (closed month)
//   4 R4  A  Fuel   $120.00          2026-10-12 Rejected
//   5 R5  A  Fuel   $300.00 100 gal  2026-10-11 Approved  "Pilot #123"
//   6 R6  A  Fuel    $80.00          2026-09-28 Approved  (closed month)
//   7 O1  Op Fuel   $700.00          2026-10-12 Approved  "Flying J #4"
//   8 O2  Op Fuel   $100.00          2026-10-13 Approved  "Shell #9"
//   9 O3  Op Fuel   $700.00          2026-10-05 Approved  "Flying J #4"
//  10 O4  Op Fuel   $100.00          2026-10-06 Approved  "Shell #9"
//  11 B1  B  Food    $30.00          2026-10-13 Approved  "Diner #2"
// Loads (Job Tracking, delivered, Owner ID 7 unless noted):
//   L1  A   W41 pickup 10/12 drop 10/14 (3 days -> $900)
//   L2  Op  W41 $2,500 + L3 Op W41 $1,500 (week revenue $4,000)
//   L4  Op  W40 $4,000
//   L5  B   W41 pickup 10/13 drop 10/14, T-3, Owner ID 0 (2 days -> $500)
//   L6  A   W40 pickup 10/06 drop 10/07 (2 days -> $600)

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./server-lift");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const appRequire = createRequire(path.join(ROOT, "server.js"));
const Database = appRequire("better-sqlite3");

// Thu 2026-10-15 12:00 EDT.
const NOW_MS = Date.UTC(2026, 9, 15, 16, 0, 0);
const DRIVER_A = "Test Driver A";
const DRIVER_B = "Test Driver B";
const OWNER_OP = "Test Owner Op";

const ROUTE_HEADS = {
	mark: 'app.post("/api/expenses/:id/personal", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
	undo: 'app.delete("/api/expenses/:id/personal", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
	reverse: 'app.post("/api/expenses/:id/personal/reverse", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
	corrections: 'app.post("/api/invoices/personal-corrections", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
	status: 'app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	bulk: 'app.put("/api/expenses/bulk-status", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	adjust: 'app.put("/api/invoices/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {',
	invoiceDelete: 'app.delete("/api/invoices/:id", requireRole("Super Admin"), (req, res) => {',
	restore: 'app.put("/api/invoices/:id/restore", requireRole("Super Admin"), (req, res) => {',
	expensesAll: 'app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	investorExpenses: 'app.get("/api/investor/expenses", requireRole("Super Admin", "Investor"), async (req, res) => {',
	userDelete: 'app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {',
	fuelAnalytics: 'app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), fuelAnalyticsLimiter, (req, res) => {',
};
// Phase 2 (receipts on invoices): lifted only for a world built with
// { receipts: true }, so the phase 1 runners lift exactly what they did.
const RECEIPT_ROUTE_HEADS = {
	receipt: 'app.get("/api/invoices/:id/personal-receipts/:lineId", requireAuth, personalReceiptLimiter, async (req, res) => {',
	waitingCorrections: 'app.get("/api/expenses/personal/waiting-corrections", requireRole("Super Admin"), personalListLimiter, (req, res) => {',
	invoices: 'app.get("/api/invoices", requireAuth, (req, res) => {',
};
const RECEIPT_ROOTS = ["paymentReportColumns", "personalLinesForInvoices", "personalWaitingInPeriod", "warmPersonalReceiptsForWeek"];

const ROOTS = [
	"generateInvoiceHandler", "runPersonalSweep", "invoiceTotalDue", "buildPaymentReport", "invoiceListSummary",
	"expenseFrom", "gatherLedgerScopeFacts", "computeInvestorMonthlyEarnings", "getDeductibleExpensesByDriverMonth",
	"getCarrierDBFromSQLite", "getInvestorDriverSet", "parseSheet", "deduplicateLoads", "findCol",
	"kpiGatherDbInputs", "fuelCpgBandFromFleet", "computeInsightsCacheKey", "closingFingerprint",
	"personalSummaryByExpense", "personalSummaryForRole", "requireAuth", "userDeleteLockBlockers",
	// Called right after a comment that ends in a full stop, which the closure
	// walker reads as a property access (lib/server-lift.js), so named here.
	"assertInvoiceFileStillOwn",
];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "notifyChange",
	"getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR",
	"fetch", "io", "sendEmail", "fuelAnalyticsLimiter", "personalReceiptLimiter", "personalRouteLimiter", "personalListLimiter"];
const DENIED = ["server", "transporter", "getDrive", "KEY_FILE"];

const lifted = new Map();
function liftedCode(receipts) {
	const key = receipts ? "receipts" : "base";
	if (!lifted.has(key)) {
		const roots = receipts ? [...ROOTS, ...RECEIPT_ROOTS] : ROOTS;
		const routes = Object.values(receipts ? { ...ROUTE_HEADS, ...RECEIPT_ROUTE_HEADS } : ROUTE_HEADS);
		lifted.set(key, { roots, code: closure(SRC, { roots, routes, provided: PROVIDED, denied: DENIED }) });
	}
	return lifted.get(key);
}

const TABLES = ["users", "investors", "truck_assignments", "carrier_driver_history", "drivers_directory", "expenses",
	"excluded_driver_days", "maintenance_fund", "compliance_fees", "deleted_loads", "investor_payouts", "investor_payout_history",
	"investor_payout_basis", "period_locks", "financials_ledger_items", "financials_ledger_freezes", "app_settings",
	"load_coordinates", "routemate_telemetry", "pay_rate_history", "dispatch_notifications", "load_status_history", "invoices",
	"driver_payment_info", "load_eld_miles", "load_ratecon_miles", "audit_trail", "invoice_autogen_runs", "eld_miles_daily",
	"eld_device_assignments", "kpi_snapshots", "kpi_load_weights", "documents", "fuel_events"];
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`could not locate CREATE TABLE ${table} in server.js`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || [];
function trucksDdl() {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) throw new Error("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	return `CREATE TABLE trucks (${m[1]}\n)`;
}

const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
function loadRow({ id, driver, pickup, dropoff, assigned, done, truck, pay, owner = "7" }) {
	const r = Object.fromEntries(HEADERS.map((h) => [h, ""]));
	Object.assign(r, {
		"Load ID": id, Driver: driver, "Pickup Appointment": pickup, "Drop-off Appointment": dropoff, "Job Status": "Delivered",
		"  Payment  ": pay, "Assigned Date": assigned, "Status Update Date": done, "Completion Date": done, Truck: truck, "Owner ID": owner,
	});
	return HEADERS.map((h) => r[h]);
}
const SHEET = [
	HEADERS,
	loadRow({ id: "L1", driver: DRIVER_A, pickup: "10/12/2026 8:00", dropoff: "10/14/2026 10:00", assigned: "10/12/2026", done: "10/14/2026", truck: "T-1", pay: "$2,000.00" }),
	loadRow({ id: "L2", driver: OWNER_OP, pickup: "10/12/2026 8:00", dropoff: "10/13/2026 10:00", assigned: "10/12/2026", done: "10/13/2026", truck: "T-2", pay: "$2,500.00" }),
	loadRow({ id: "L3", driver: OWNER_OP, pickup: "10/14/2026 8:00", dropoff: "10/15/2026 10:00", assigned: "10/14/2026", done: "10/15/2026", truck: "T-2", pay: "$1,500.00" }),
	loadRow({ id: "L4", driver: OWNER_OP, pickup: "10/5/2026 8:00", dropoff: "10/7/2026 10:00", assigned: "10/5/2026", done: "10/7/2026", truck: "T-2", pay: "$4,000.00" }),
	loadRow({ id: "L5", driver: DRIVER_B, pickup: "10/13/2026 8:00", dropoff: "10/14/2026 10:00", assigned: "10/13/2026", done: "10/14/2026", truck: "T-3", pay: "$1,200.00", owner: "0" }),
	loadRow({ id: "L6", driver: DRIVER_A, pickup: "10/6/2026 8:00", dropoff: "10/7/2026 10:00", assigned: "10/6/2026", done: "10/7/2026", truck: "T-1", pay: "$1,800.00" }),
];

// [id, driver, type, amount, gallons, date, status, vendor, truck, owner]
const RECEIPTS = [
	[1, DRIVER_A, "Fuel", 200.00, 50, "2026-10-12", "Approved", "Pilot #123", "T-1", 7],
	[2, DRIVER_A, "Other", 45.50, 0, "2026-10-13", "Pending", "Love's #77", "T-1", 7],
	[3, DRIVER_A, "Fuel", 300.00, 0, "2026-08-30", "Pending", "Pilot #123", "T-1", 7],
	[4, DRIVER_A, "Fuel", 120.00, 0, "2026-10-12", "Rejected", "Pilot #123", "T-1", 7],
	[5, DRIVER_A, "Fuel", 300.00, 100, "2026-10-11", "Approved", "Pilot #123", "T-1", 7],
	[6, DRIVER_A, "Fuel", 80.00, 0, "2026-09-28", "Approved", "Pilot #123", "T-1", 7],
	[7, OWNER_OP, "Fuel", 700.00, 0, "2026-10-12", "Approved", "Flying J #4", "T-2", 7],
	[8, OWNER_OP, "Fuel", 100.00, 0, "2026-10-13", "Approved", "Shell #9", "T-2", 7],
	[9, OWNER_OP, "Fuel", 700.00, 0, "2026-10-05", "Approved", "Flying J #4", "T-2", 7],
	[10, OWNER_OP, "Fuel", 100.00, 0, "2026-10-06", "Approved", "Shell #9", "T-2", 7],
	[11, DRIVER_B, "Food", 30.00, 0, "2026-10-13", "Approved", "Diner #2", "T-3", 0],
];

const USERS = {
	admin: { id: 1, username: "super_admin", role: "Super Admin" },
	admin2: { id: 2, username: "ops_admin", role: "Super Admin" },
	dispatcher: { id: 3, username: "dispatch1", role: "Dispatcher" },
	driverA: { id: 4, username: "drivera", role: "Driver", driverName: DRIVER_A },
	investor: { id: 7, username: "inv7", role: "Investor" },
	driverB: { id: 8, username: "driverb", role: "Driver", driverName: DRIVER_B },
};

function buildDb(personalSchemaSql) {
	const db = new Database(":memory:");
	const stmts = [trucksDdl(), ...alters("trucks"), ...TABLES.flatMap((t) => [tableDdl(t), ...alters(t)]),
		"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))",
		"CREATE UNIQUE INDEX idx_invoices_driver_week ON invoices(driver COLLATE NOCASE, week_start) WHERE deleted_at = '' AND is_manual = 0"];
	for (const sql of stmts) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) throw new Error(`DDL failed: ${e.message}\n${sql.slice(0, 160)}`); }
	}
	db.exec(personalSchemaSql);
	// The KPI tables whose DDL lives in their modules, created as server.js does.
	appRequire("./lib/kpi-ratecon-pass").ensureTables(db);
	appRequire("./lib/kpi-deadhead-routes").ensureTables(db);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name, driver_name) VALUES (?, ?, 'x', ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "");
	user.run(2, "ops_admin", "Super Admin", "", "");
	user.run(3, "dispatch1", "Dispatcher", "", "");
	user.run(4, "drivera", "Driver", "Acme Carrier", DRIVER_A);
	user.run(7, "inv7", "Investor", "Acme Carrier", "");
	user.run(8, "driverb", "Driver", "", DRIVER_B);
	user.run(9, "ownerop", "Driver", "Acme Carrier", OWNER_OP);
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (7, 'Ivy Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'settlement_grace_days', '7')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, driver_pay_daily)
		VALUES (?, ?, ?, 'Active', '2026-07-01', '2026-07-01 00:00:00', ?, ?)`);
	truck.run(1, "T-1", 7, DRIVER_A, 300);
	truck.run(2, "T-2", 7, OWNER_OP, 0);
	truck.run(3, "T-3", 0, DRIVER_B, 250);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?)");
	dir.run(DRIVER_A, "Acme Carrier", "fixed", 0, 300);
	dir.run(DRIVER_B, "", "fixed", 0, 250);
	dir.run(OWNER_OP, "Acme Carrier", "percentage", 25, 0);
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-07-01T17:00:00.000Z')");
	assign.run(1, DRIVER_A);
	assign.run(2, OWNER_OP);
	assign.run(3, DRIVER_B);
	const exp = db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, gallons, date, status, vendor, truck_unit, owner_id, created_at, description, photo_data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`);
	for (const [id, driver, type, amount, gallons, date, status, vendor, truck_, owner] of RECEIPTS) {
		exp.run(id, `${date}T15:00:00.000Z`, driver, type, amount, gallons, date, status, vendor, truck_, owner, `${date} 15:00:00`,
			`/uploads/expense-receipts/${1760000000000 + id}-abcdefabcdef.jpg`);
	}
	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-10-08T04:00:00.000Z', 'test')");
	lock.run("2026-08");
	lock.run("2026-09");
	return db;
}

class Res {
	constructor(done) { this.statusCode = 200; this.body = undefined; this.headers = {}; this._done = done; }
	status(c) { this.statusCode = c; return this; }
	json(b) { this.body = b; this._done(); return this; }
	send(b) { this.body = b; this._done(); return this; }
	setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
	set(k, v) { this.setHeader(k, v); return this; }
	end(b) { if (b !== undefined) this.body = b; this._done(); return this; }
}

// One server start. opts: { env, nowMs, render(templateName, data) -> Promise<Buffer>, receipts }.
function buildPersonalWorld(opts = {}) {
	const personalExpense = appRequire("./lib/personal-expense");
	const db = buildDb(personalExpense.SCHEMA_SQL);
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-world-"));
	const clock = { now: opts.nowMs || NOW_MS };
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.now])); }
		static now() { return clock.now; }
	}
	const routes = [];
	const register = (method) => (p, ...handlers) => { routes.push({ method, path: p, handlers }); };
	const app = { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE"), patch: register("PATCH") };
	const rendered = [];
	const notifications = [];
	const defaultRender = async (templateName, data) => {
		rendered.push({ templateName, data: JSON.parse(JSON.stringify(data)) });
		return Buffer.from(`%PDF-stub ${templateName} ${rendered.length}`);
	};
	const hooks = { render: opts.render || null };
	const render = (templateName, data) => (hooks.render ? hooks.render(templateName, data, defaultRender) : defaultRender(templateName, data));
	const sheet = { rows: SHEET.map((r) => [...r]) };
	const quiet = { log() {}, info() {}, warn() {}, error: (...a) => { if (process.env.PERSONAL_WORLD_DEBUG) console.error(...a); } };
	const deps = {
		db,
		require: appRequire,
		console: quiet,
		process: { env: { CSRF_HEADER_REQUIRED: "", ...(opts.env || {}) }, argv: [], cwd: () => ROOT, pid: process.pid },
		__dirname: ROOT,
		Date: FixedDate,
		app,
		notifyChange: (d) => notifications.push(d),
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheet.rows.map((r) => [...r]) } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: render,
		fs,
		DATA_DIR: dataDir,
		fetch: () => { throw new Error("no network in a test"); },
		io: null,
		sendEmail: async () => undefined,
		fuelAnalyticsLimiter: (req, res, next) => next(),
		personalReceiptLimiter: (req, res, next) => next(),
		personalRouteLimiter: (req, res, next) => next(),
		personalListLimiter: (req, res, next) => next(),
	};
	const { roots, code } = liftedCode(!!opts.receipts);
	const body = [
		'"use strict";',
		code.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet.rows.map((r) => [...r]) }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		`return { ${roots.join(", ")} };`,
	].join("\n");
	const api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), sheet);

	const match = (pattern, actual) => {
		const a = pattern.split("/");
		const b = actual.split("?")[0].split("/");
		if (a.length !== b.length) return null;
		const params = {};
		for (let i = 0; i < a.length; i++) {
			if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
			else if (a[i] !== b[i]) return null;
		}
		return params;
	};
	// Runs a route's whole chain (requireRole, refuseCrossOrigin, the handler).
	// as: a USERS key, or null for signed out. headers default to a same-origin
	// SPA request carrying X-Requested-With.
	async function call(method, url, { as = "admin", body: reqBody = {}, query = {}, headers } = {}) {
		const route = routes.find((r) => r.method === method && match(r.path, url));
		if (!route) throw new Error(`no route ${method} ${url}`);
		const params = match(route.path, url);
		const hdrs = headers || { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin", host: "app.test" };
		const user = as ? { ...USERS[as] } : null;
		const req = {
			method, url, originalUrl: url, path: url, params, body: reqBody, query, headers: hdrs, ip: "127.0.0.1",
			hostname: "app.test", protocol: "https",
			session: user ? { user } : {},
			get(h) { return hdrs[String(h).toLowerCase()]; },
			route: { path: route.path },
		};
		let finished;
		const done = new Promise((r) => { finished = r; });
		const res = new Res(() => finished());
		let i = 0;
		const next = async () => {
			const h = route.handlers[i++];
			if (!h) return;
			await h(req, res, next);
		};
		await next();
		const timer = setTimeout(() => finished(), 15000);
		await done;
		clearTimeout(timer);
		if (res.body === undefined) throw new Error(`no response from ${method} ${url}`);
		return { status: res.statusCode, body: res.body, headers: res.headers };
	}
	async function generate(driver, weekEnd = "2026-10-16", as = "admin") {
		const out = { status: 200, body: null };
		let finished;
		const done = new Promise((r) => { finished = r; });
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; finished(); return res; } };
		await api.generateInvoiceHandler({ session: { user: { ...USERS[as] } }, body: { driver, weekEnd } }, res);
		await done;
		return out;
	}
	const invoice = (id) => db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
	const lines = (where = "1=1", ...params) => db.prepare(`SELECT * FROM expense_personal WHERE ${where} ORDER BY id`).all(...params);
	const audits = (action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
	const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp dir */ } };
	return {
		db, api, call, generate, rendered, notifications, hooks, sheet, clock, dataDir, invoice, lines, audits, cleanup,
		setNow(ms) { clock.now = ms; },
	};
}

// The checks every runner prints. Values compare as JSON.
function makeChecker() {
	let pass = 0;
	let fail = 0;
	const check = (label, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a === e) { pass++; console.log(`  ok    ${label}`); return true; }
		fail++;
		console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
		return false;
	};
	const section = (t) => console.log(`\n${t}`);
	const finish = () => {
		console.log(`\n${pass} passed, ${fail} failed`);
		process.exit(fail ? 1 : 0);
	};
	return { check, section, finish, counts: () => ({ pass, fail }) };
}

// Eastern wall clock to epoch ms, for the runners' clock moves (EDT, UTC-4, in October).
const edt = (day, h = 12, m = 0) => Date.parse(`${day}T00:00:00Z`) + (h + 4) * 3600000 + m * 60000;

module.exports = { buildPersonalWorld, makeChecker, edt, NOW_MS, DRIVER_A, DRIVER_B, OWNER_OP, USERS, ROUTE_HEADS, RECEIPT_ROUTE_HEADS, ROOT, SRC };
