#!/usr/bin/env node
/**
 * The weekly driver invoice matches a driver the way every ownership check and
 * the P&L do — through normalizeDriverName() — and an invoice number and its
 * PDF belong to exactly one row.
 *
 * A driver's name reaches the invoice path in more than one spelling: the
 * driver's session carries the account's ("Shorn King"), the Friday batch passes
 * the drivers_directory row's (which may have been re-spelled by spacing alone:
 * "Shorn  King"), and a Super Admin types one. idx_invoices_driver_week folds
 * case, not spacing, so the application has to hold the rule.
 *
 * WHAT IS ASSERTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import) and run against
 * an in-memory SQLite that carries the real one-per-driver-week index, with PDFs
 * written to a fresh temporary directory:
 *   §1 ONE DRIVER, TWO SPELLINGS, ONE INVOICE. Whichever spelling asks, there is
 *      one live weekly invoice per week; the existing-invoice check sees a row
 *      stored under the other spelling (409 INVOICE_EXISTS); two live Drafts
 *      under two spellings are refused (409 INVOICE_WEEK_DUPLICATE); a new row
 *      stores the spelling the driver's identity already has.
 *   §2 NUMBERING NEVER REUSES A NUMBER — two drivers with the same initials in
 *      one week, a soft-deleted invoice, a row under another spelling, a file
 *      name held in another case, a regenerated Draft, manual invoices; and every
 *      number the old count would mint that nobody holds is minted unchanged.
 *   §3 A PDF IS NEVER OVERWRITTEN BY ANOTHER INVOICE — another row holding the
 *      number or the file, before the request or during its render; the
 *      driver-week or the Draft changing during the render; a failed render; a
 *      temporary write that fails part-way; a failed INSERT; the adjust route's
 *      re-render of a file two rows share, of a Draft regenerated while it
 *      renders, and two adjustments at once (the refused one rolls back only
 *      its own adjustment).
 *   §4 PAY LOOKUPS AGREE WITH THE P&L — pay type, percentage and daily rate equal
 *      what /api/financials resolves (its trucksByDriver block is lifted and run
 *      on the same database) for every spelling; the expenses a percentage
 *      invoice deducts are the driver's in any spelling, Rejected ones excluded.
 *   §5 THE FRIDAY BATCH — one directory driver in two spellings is billed once;
 *      only 409 INVOICE_EXISTS counts as billed, any other 409 is an error that
 *      leaves the driver unbilled (retry, then an alert).
 *   §6 THE READERS — GET /api/invoices (Driver, other roles, Super Admin filter),
 *      the driver app's own list, the restore route's one-per-week check, the
 *      approve route's status-email recipient, the payment report.
 *   §7 SOURCE PINS.
 *   §8 MUTANTS — one per money guard (normalized matching, the existing-invoice
 *      check, never reuse a number, never overwrite a PDF). Each rewrites the
 *      guard back to a narrower rule and must flip at least one assertion above.
 *      A test that passes on both has not tested anything.
 *
 * Pure: no server, no app.db, no network, no Sheets; mail is captured.
 * Run: node scripts/test-invoice-driver-name-matching.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require("../lib/ratecon-load");
const eldMiles = require("../lib/eld-miles");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ───────────────────────────────────────────────────────────────── lifting
// Each lift is anchored on a newline and counted, so a mention in a comment is
// never taken for the definition and a second copy fails the run. A top-level
// function ends at the first column-0 "}" line; a route at the first "});".
function liftBetween(src, needle, terminator, label) {
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf(terminator, a);
	if (end < 0) throw new Error(`no terminator after ${label}`);
	return src.slice(a, end + terminator.length);
}
const liftFn = (src, name) => liftBetween(src, `\nfunction ${name}(`, "\n}\n", `function ${name}()`);
const liftAsyncFn = (src, name) => liftBetween(src, `\nasync function ${name}(`, "\n}\n", `async function ${name}()`);
const liftRoute = (src, head) => liftBetween(src, `\n${head}`, "\n});\n", head);
function liftConst(src, name) {
	const needle = `\nconst ${name} =`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 const ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	let end = src.indexOf("\n", start);
	if (/=\s*$/.test(src.slice(start, end))) end = src.indexOf("\n", end + 1);
	return src.slice(start, end);
}
// A statement fragment, from an anchor to the first terminator after it.
function liftFragment(src, anchor, terminator, label) {
	const hits = src.split(anchor).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = src.indexOf(anchor);
	const end = src.indexOf(terminator, a);
	if (end < 0) throw new Error(`no terminator after ${label}`);
	return src.slice(a, end + terminator.length);
}

const SHARED_CONSTS = [
	"RFC2822_MONTHS", "CANCELED_STATUS_RE", "INVOICE_COMPLETED_RE", "EXPENSE_PNL_FILTER", "INVOICE_AUTOGEN_MAX_ATTEMPTS",
	"INVOICE_UNDATED_ALERT_ENABLED", "INVOICE_UNDATED_ALERT_MAX_PER_DAY", "INVOICE_UNDATED_MASS_RESOLVE",
	"INVOICE_UNDATED_BASELINE_KEY", "INVOICE_UNDATED_PENDING_SHRINK_KEY", "INVOICE_UNDATED_STATUS_KEY",
];
const SHARED_FNS = [
	"houstonDay", "sheetDayKey", "getWeekRange", "normalizeDriverName", "findCol", "parseSheet", "deduplicateLoads",
	"getDeletedLoadIds", "excludeDroppedLoads", "loadKeySet",
	"invoiceWeekColumns", "invoiceCompletionDay", "invoiceWeekVerdict", "selectInvoiceWeekLoads", "invoiceWeekWarnings",
	"driversWithCompletedLoadsInWeek",
	"resolveDailyRate", "getEldTravelDaysByVehicle", "getAllExcludedDriverDays", "isAfterDeadline",
	// Under test.
	"liveWeeklyInvoicesForDriverWeek", "invoicePdfFileName", "invoiceNumberHolders", "generateInvoiceNumber",
	"invoiceWriteRefusal", "commitInvoiceWithPdf", "driverAccountsNamed", "getDriverPayStructures",
	"truckDailyRateCandidates", "findDriverNameClashes", "canonicalDriverName", "driverOwnsInvoice",
	"buildPaymentReport", "sanitizeManualInvoiceRows", "assertInvoiceFileStillOwn", "writeInvoiceFileAtomically",
	// The Friday batch and its mail.
	"escHtml", "invoiceEmailHtml", "invoiceStatusChangeEmail", "generateInvoiceInProcess", "abortAutogenRun",
	"listUndatedCompletedLoads",
];
const ASYNC_FNS = ["generateInvoiceHandler", "runWeeklyInvoiceBatch", "runUndatedLoadAlerts", "sendUndatedLoadDigest",
	"rerenderInvoicePdfFromStoredData"];
const ROUTES = [
	'app.get("/api/invoices", requireAuth, (req, res) => {',
	'app.post("/api/invoices/manual", requireRole("Super Admin"), async (req, res) => {',
	'app.put("/api/invoices/:id/approve", requireRole("Super Admin"), async (req, res) => {',
	'app.put("/api/invoices/:id/restore", requireRole("Super Admin"), (req, res) => {',
	'app.put("/api/invoices/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {',
];
// The driver app's own invoice list is one statement inside GET
// /api/driver/:driverName; it is lifted and run on its own.
const DRIVER_APP_LIST_ANCHOR = "const driverInvoices = db.prepare(";
// The P&L's truck-rate map, lifted from GET /api/financials (the fleet-wide P&L).
const PNL_TRUCKS_ANCHOR = 'const trucksByDriver = {};\n\t\tdb.prepare("SELECT assigned_driver, driver_pay_daily FROM trucks").all().forEach(t => {';

// The one-per-driver-week index, exactly as the migration builds it.
const INDEX_COLS = new Function(`${liftConst(SRC, "INVOICE_WEEK_IDX_COLS")}\nreturn INVOICE_WEEK_IDX_COLS;`)();

// ───────────────────────────────────────────────────────────────── fixtures
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
// Three billing weeks (Sat–Fri). `param` is the Friday a caller passes.
const W38 = { param: "2026-09-25", start: "2026-09-19", tag: "2026W38" };
const W39 = { param: "2026-10-02", start: "2026-09-26", tag: "2026W39" };
const W40 = { param: "2026-10-09", start: "2026-10-03", tag: "2026W40" };

let rowNo = 1;
function row(fields) {
	const r = { _rowIndex: ++rowNo };
	for (const h of HEADERS) r[h] = "";
	return Object.assign(r, fields);
}
const delivered = (loadId, driver, pickup, dropoff, stamp, pay) => row({
	"Load ID": loadId, Driver: driver, "Job Status": "Delivered", "Pickup Appointment": pickup,
	"Drop-off Appointment": dropoff, "Status Update Date": stamp, "  Payment  ": pay,
});
const SHEET = [
	delivered("8101", "Shorn King", "9/21/2026 8:00", "9/22/2026 10:00", "9/22/2026 14:00:00", " $ 1,000.00 "),
	delivered("8102", "Shorn King", "9/28/2026 8:00", "9/29/2026 10:00", "9/29/2026 14:00:00", " $ 900.00 "),
	delivered("8103", "Shorn King", "10/5/2026 8:00", "10/6/2026 10:00", "10/6/2026 14:00:00", " $ 800.00 "),
	delivered("8201", "Sam Kelly", "9/23/2026 8:00", "9/23/2026 18:00", "9/23/2026 19:00:00", " $ 700.00 "),
	delivered("8301", "Pat Percent", "9/21/2026 8:00", "9/22/2026 10:00", "9/22/2026 14:00:00", " $ 1,000.00 "),
	delivered("8302", "Pat Percent", "9/23/2026 8:00", "9/24/2026 10:00", "9/24/2026 14:00:00", " $ 500.00 "),
	delivered("8401", "Tom Truck", "9/21/2026 8:00", "9/22/2026 10:00", "9/22/2026 14:00:00", " $ 600.00 "),
	delivered("8501", "Dee Dayrate", "9/20/2026 8:00", "9/21/2026 10:00", "9/21/2026 14:00:00", " $ 650.00 "),
];
const toValues = (rows) => [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] || ""))];

const DDL = `
	CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
	CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft', rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '');
	CREATE UNIQUE INDEX idx_invoices_driver_week ON ${INDEX_COLS};
	CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, date TEXT, amount REAL, type TEXT, status TEXT DEFAULT '', description TEXT DEFAULT '');
	CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT, assigned_driver TEXT, driver_pay_daily REAL DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '');
	CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
	CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT DEFAULT '', email TEXT DEFAULT '', role TEXT DEFAULT 'Driver', driver_name TEXT DEFAULT '');
	CREATE TABLE driver_payment_info (user_id INTEGER, bank_name TEXT, account_type TEXT);
	CREATE TABLE excluded_driver_days (driver_name TEXT, excluded_date TEXT, action TEXT);
	CREATE TABLE routemate_telemetry (routemate_vehicle_id TEXT, location_date_ms INTEGER, speed REAL, longitude REAL, dropped_reason TEXT DEFAULT '');
	CREATE TABLE invoice_autogen_runs (week_end TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP, attempts INTEGER DEFAULT 0, created INTEGER DEFAULT 0, submitted INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, summary TEXT DEFAULT '');
`;
function liftCreateTable(src, table) {
	const needle = `CREATE TABLE IF NOT EXISTS ${table} (`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 CREATE TABLE ${table}, found ${hits}`);
	const start = src.indexOf(needle);
	for (let i = start + needle.length - 1, depth = 0; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(start, i + 1); }
	}
	throw new Error(`unbalanced CREATE TABLE ${table}`);
}
const LEDGER_DDL = `${liftCreateTable(SRC, "server_state")};\n${liftCreateTable(SRC, "invoice_undated_alerts")};`;

// The account says "Shorn King"; the directory row was re-spelled by spacing
// alone. Pat's and Dee's directory rows are spaced differently from their names
// on the sheet too; Tom is named on two trucks, one of them spaced differently.
function seedBase(db) {
	const u = db.prepare("INSERT INTO users (id, username, email, role, driver_name) VALUES (?, ?, ?, ?, ?)");
	u.run(1, "super_admin", "admin@example.test", "Super Admin", "");
	u.run(2, "sking", "sking@example.test", "Driver", "Shorn King");
	u.run(3, "skelly", "skelly@example.test", "Driver", "Sam Kelly");
	u.run(4, "ppercent", "pp@example.test", "Driver", "Pat Percent");
	u.run(5, "ttruck", "tt@example.test", "Driver", "Tom Truck");
	u.run(6, "dispatch1", "d@example.test", "Dispatcher", "");
	const d = db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_percentage, pay_daily, address, city, state, zip, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	d.run("Shorn  King", "fixed", 0, 300, "1 Main St", "Houston", "TX", "77002", "555-0101");
	d.run("Sam Kelly", "fixed", 0, 0, "", "", "", "", "");
	d.run("Pat  Percent", "percentage", 20, 0, "", "", "", "", "");
	d.run("Tom Truck", "fixed", 0, 0, "", "", "", "", "");
	d.run("Dee  Dayrate", "fixed", 0, 310, "", "", "", "", "");
	const t = db.prepare("INSERT INTO trucks (unit_number, assigned_driver, driver_pay_daily) VALUES (?, ?, ?)");
	t.run("101", "Shorn King", 275);
	t.run("102", "Sam Kelly", 260);
	t.run("103", "Tom Truck", 275);
	t.run("104", "Tom  Truck", 325);
	t.run("105", "Dee Dayrate", 0);
	db.prepare("INSERT INTO driver_payment_info (user_id, bank_name, account_type) VALUES (2, 'Shorn Test Bank', 'Checking')").run();
	const e = db.prepare("INSERT INTO expenses (driver, date, amount, type, status) VALUES (?, ?, ?, ?, ?)");
	e.run("pat  percent", "2026-09-22", 100, "Fuel", "");
	e.run("Pat Percent", "2026-09-23", 50, "Maintenance", "Approved");
	e.run("pat percent", "2026-09-23", 999, "Fuel", "Rejected");
	e.run("Shorn King", "2026-09-22", 40, "Fuel", "");
}

// ───────────────────────────────────────────────────────────────── the world
// What a world lifts from one source text — cached, because §8 builds hundreds
// of worlds over the shipped source and one mutated copy per mutant, and lifting
// ~50 functions out of server.js is the expensive part.
const LIFT_CACHE = new Map();
function liftedFor(src) {
	if (LIFT_CACHE.has(src)) return LIFT_CACHE.get(src);
	const lifted = {
		body: [
			...SHARED_CONSTS.map((c) => liftConst(src, c)),
			...SHARED_FNS.map((f) => liftFn(src, f)),
			...ASYNC_FNS.map((f) => liftAsyncFn(src, f)),
			"let invoiceAutogenAbortStreak = 0;",
			"let invoiceAutogenAbortAlerted = false;",
			"let invoiceUndatedAlertsRunning = false;",
			"let lastPayStructShadowWarnMs = 0;",
			"const submitDraftInvoiceStmt = db.prepare(\"UPDATE invoices SET status = 'Submitted', submitted_at = ? WHERE id = ? AND status = 'Draft'\");",
			"async function getJobTrackingCached() { const p = parseSheet({ values: __sheet.values }); p.data = deduplicateLoads(p.data, p.headers); return p; }",
			...ROUTES.map((h) => liftRoute(src, h)),
			`return { ${[...SHARED_CONSTS, ...SHARED_FNS, ...ASYNC_FNS].join(", ")} };`,
		].join("\n"),
		driverAppList: new Function("db", "normalizeDriverName", "driverNameNorm", "driverName",
			`${liftFragment(src, DRIVER_APP_LIST_ANCHOR, ";\n", "the driver app's invoice list")}\nreturn driverInvoices;`),
		pnlTrucks: new Function("db", "normalizeDriverName",
			`${liftFragment(src, PNL_TRUCKS_ANCHOR, "\n\t\t});", "the P&L's trucksByDriver block")}\nreturn trucksByDriver;`),
	};
	LIFT_CACHE.set(src, lifted);
	return lifted;
}

const ROOTS = [];
function buildWorld(opts = {}) {
	const src = opts.src || SRC;
	const lifted = liftedFor(src);
	const db = new Database(":memory:");
	db.exec(DDL);
	db.exec(LEDGER_DDL);
	(opts.seed || seedBase)(db);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-invname-"));
	ROOTS.push(root);
	const invoicesDir = path.join(root, "uploads", "invoices");
	const routes = {};
	const app = {};
	for (const verb of ["get", "post", "put", "delete"]) {
		app[verb] = (p, ...handlers) => { routes[`${verb.toUpperCase()} ${p}`] = handlers[handlers.length - 1]; };
	}
	const rendered = [];
	const emails = [];
	const notes = [];
	const logs = [];
	const audits = [];
	const sheet = { values: opts.sheetValues || toValues(SHEET) };
	const passthrough = () => (req, res, next) => next && next();
	const deps = {
		db, app, normalizeLoadId,
		localDayInTz: eldMiles.localDayInTz,
		usTzForLongitude: eldMiles.usTzForLongitude,
		SPREADSHEET_ID: "test-sheet",
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheet.values } }) } } }),
		// The document records whose invoice it is, so a test can tell which
		// invoice's content a file on disk holds.
		renderPolicy: async (templateName, data) => {
			// The render's own number, taken at the call: a render held open by a
			// test hook must not pick up the number of one that started after it.
			const seq = rendered.push({ templateName, data });
			if (opts.onRender) await opts.onRender(data, { db, invoicesDir });
			return Buffer.from(JSON.stringify({
				seq,
				who: data.driverName || data.payeeName || "",
				number: `INV-${data.invoiceNumberSuffix || ""}`,
				total: data.totalDue != null ? data.totalDue : data.totalEarnings,
				adjustment: data.adjustment || 0,
			}));
		},
		fs: opts.fs || fs, path, __dirname: root,
		__sheet: sheet,
		notifyChange: () => {},
		insertDispatchNotification: { run: (...args) => notes.push(args) },
		io: null,
		sendEmail: async (to, subject, html) => { emails.push({ to, subject, html }); return true; },
		setTimeout: () => 0,
		console: {
			log: (...a) => logs.push(a.join(" ")),
			warn: (...a) => logs.push(a.join(" ")),
			error: (...a) => logs.push(a.join(" ")),
		},
		logAudit: (req, action, entity, entityId, details) => audits.push({ action, entityId, details }),
		requireAuth: passthrough(),
		requireRole: passthrough,
		refuseCrossOrigin: passthrough(),
		invoiceMonthLockBlockers: () => ({ blockers: [] }),
		periodLockUnreadableResponse: () => { throw new Error("period locks are not under test here"); },
		periodBlockedResponse: () => { throw new Error("period locks are not under test here"); },
		INVOICE_LOCK_REMEDY: "",
		findInvoicePayee: () => null,
		auditReasonNote: () => "",
		appendInvoiceAdjustmentAddendum: async () => { throw new Error("legacy addendum not under test here"); },
	};
	const w = new Function(...Object.keys(deps), lifted.body)(...Object.values(deps));
	return Object.assign(w, {
		db, root, invoicesDir, routes, rendered, emails, notes, logs, audits, sheet,
		driverAppList: (name) => lifted.driverAppList(db, w.normalizeDriverName, w.normalizeDriverName(name), name),
		pnlTrucks: () => lifted.pnlTrucks(db, w.normalizeDriverName),
	});
}

// ───────────────────────────────────────────────────────────────── helpers
const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
const SHORN = { id: 2, role: "Driver", username: "sking", driverName: "Shorn King" };
const DISPATCH = { id: 6, role: "Dispatcher", username: "dispatch1", driverName: "" };

function mockRes() {
	return {
		statusCode: 200, body: null,
		status(c) { this.statusCode = c; return this; },
		json(o) { this.body = o; return this; },
	};
}
async function generate(w, user, driver, week) {
	const res = mockRes();
	await w.generateInvoiceHandler({ session: { user }, body: { driver, weekEnd: week.param } }, res);
	return res;
}
async function callRoute(w, key, req) {
	const res = mockRes();
	await w.routes[key]({ params: {}, query: {}, body: {}, ...req }, res);
	// Let a fire-and-forget email run to completion.
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	return res;
}
const liveRows = (w, name, week) => w.liveWeeklyInvoicesForDriverWeek(name, week.start);
const rowById = (w, id) => w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) || null;
const pdfOf = (w, file) => {
	const p = path.join(w.invoicesDir, file);
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};
const who = (w, file) => { try { return JSON.parse(pdfOf(w, file)).who; } catch { return pdfOf(w, file); } };
const tmpLeft = (w) => (fs.existsSync(w.invoicesDir) ? fs.readdirSync(w.invoicesDir).filter((f) => f.endsWith(".tmp")) : []);
function putFile(w, file, content) {
	fs.mkdirSync(w.invoicesDir, { recursive: true });
	fs.writeFileSync(path.join(w.invoicesDir, file), content);
}
function insertInvoice(db, f) {
	const r = db.prepare(
		`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, pdf_file_name, deleted_at, is_manual, total_earnings, adjustment, render_data)
		 VALUES (@invoice_number, @driver, @week_start, @week_end, @status, @pdf_file_name, @deleted_at, @is_manual, @total_earnings, @adjustment, @render_data)`
	).run({
		status: "Draft", deleted_at: "", is_manual: 0, total_earnings: 0, adjustment: 0, render_data: "{}",
		week_end: "", pdf_file_name: `${f.invoice_number}.pdf`, ...f,
	});
	return r.lastInsertRowid;
}

// ───────────────────────────────────────────────────────────────── runner
let pass = 0;
const failures = [];
function report(checks) {
	for (const [label, actual, expected] of checks) {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		if (a === e) { pass++; console.log(`ok    ${label}`); }
		else {
			failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
			console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
		}
	}
}
const failed = (checks) => checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).map(([l]) => l);
function section(t) { console.log(`\n${t}`); }

// ═════════════════════════════════════════════════════ §1 one driver, one invoice
async function batteryIdentity(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	// Premise: the index folds case, not spacing — two spellings are two entries.
	{
		const w = buildWorld({ src });
		let second = "inserted";
		insertInvoice(w.db, { invoice_number: "INV-P-1", driver: "shorn king", week_start: W38.start });
		try { insertInvoice(w.db, { invoice_number: "INV-P-2", driver: "shorn  king", week_start: W38.start }); }
		catch (e) { second = "refused"; }
		t("premise: idx_invoices_driver_week lets a spacing variant in (the application has to hold the rule)", second, "inserted");
		let caseVariant = "inserted";
		try { insertInvoice(w.db, { invoice_number: "INV-P-3", driver: "SHORN KING", week_start: W38.start }); }
		catch (e) { caseVariant = "refused"; }
		t("premise: …while it refuses a case variant", caseVariant, "refused");
	}
	const w = buildWorld({ src });
	// The driver generates from the app, under the account's spelling.
	const a = await generate(w, SHORN, "", W38);
	const first = a.body && a.body.invoice;
	t("§1 the driver's own generate succeeds", a.statusCode, 200);
	t("§1 …numbered from the driver's initials and week", first && first.invoice_number, `INV-SK-${W38.tag}-01`);
	t("§1 …stored under the account's spelling, lowercased", first && first.driver, "shorn king");
	t("§1 …priced at the directory's $300/day, like the P&L (2 days)", first && first.total_earnings, 600);
	// The Friday batch asks under the DIRECTORY's spelling.
	const b = await generate(w, SUPER, "Shorn  King", W38);
	const regen = b.body && b.body.invoice;
	t("§1 the batch's spelling finds the Draft and regenerates it", b.statusCode, 200);
	t("§1 …still ONE live weekly invoice for the driver-week", liveRows(w, "Shorn King", W38).length, 1);
	t("§1 …keeping its number", regen && regen.invoice_number, `INV-SK-${W38.tag}-01`);
	t("§1 …as a new row replacing the old one", [!!regen && regen.id !== (first && first.id), rowById(w, first && first.id)], [true, null]);
	// Once it is past Draft, every spelling is told it exists.
	w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(regen && regen.id);
	for (const [user, spelling] of [[SUPER, "SHORN KING"], [SUPER, " shorn  king "], [SHORN, ""]]) {
		const r = await generate(w, user, spelling, W38);
		t(`§1 a submitted invoice answers 409 INVOICE_EXISTS to ${JSON.stringify(spelling || "the driver's session")}`,
			[r.statusCode, r.body && r.body.code, r.body && r.body.invoice && r.body.invoice.invoice_number],
			[409, "INVOICE_EXISTS", `INV-SK-${W38.tag}-01`]);
	}
	t("§1 …and nothing new was written for that week", liveRows(w, "Shorn King", W38).length, 1);
	// A legacy row stored under the other spelling is seen by the check.
	insertInvoice(w.db, { invoice_number: `INV-SK-${W39.tag}-01`, driver: "shorn  king", week_start: W39.start, week_end: "2026-10-02", status: "Submitted" });
	const c = await generate(w, SHORN, "", W39);
	t("§1 the existing-invoice check sees a row stored under another spelling",
		[c.statusCode, c.body && c.body.code, c.body && c.body.invoice && c.body.invoice.invoice_number],
		[409, "INVOICE_EXISTS", `INV-SK-${W39.tag}-01`]);
	// Two live Drafts under two spellings: which to replace is a human's call.
	const d1 = insertInvoice(w.db, { invoice_number: `INV-SK-${W40.tag}-01`, driver: "shorn king", week_start: W40.start, week_end: "2026-10-09" });
	const d2 = insertInvoice(w.db, { invoice_number: `INV-SK-${W40.tag}-02`, driver: "shorn  king", week_start: W40.start, week_end: "2026-10-09" });
	const d = await generate(w, SHORN, "", W40);
	t("§1 two live Drafts under two spellings answer 409 INVOICE_WEEK_DUPLICATE", [d.statusCode, d.body && d.body.code], [409, "INVOICE_WEEK_DUPLICATE"]);
	t("§1 …and both are left exactly as they were", [rowById(w, d1) && rowById(w, d1).status, rowById(w, d2) && rowById(w, d2).status, liveRows(w, "Shorn King", W40).length], ["Draft", "Draft", 2]);
	// What a new row stores.
	{
		const w2 = buildWorld({ src });
		const r = await generate(w2, SUPER, "SHORN  KING", W38);
		t("§1 a new row stores the spelling the driver's identity already has (the account's), whoever asked",
			r.body && r.body.invoice && r.body.invoice.driver, "shorn king");
		const r2 = await generate(w2, SUPER, "Dee Dayrate", W38);
		t("§1 …and a directory-only driver's the directory's",
			r2.body && r2.body.invoice && r2.body.invoice.driver, "dee  dayrate");
		const blank = await generate(w2, SUPER, "   ", W38);
		t("§1 a name that normalizes to nothing is 400, not an invoice for the blank-driver rows", blank.statusCode, 400);
	}
	return out;
}

// ═════════════════════════════════════════════════════ §2 numbering
// origin/main's generateInvoiceNumber, verbatim but for its name — the reference
// for "a number nobody holds is minted unchanged".
function OLD_generateInvoiceNumber(db, driverName, weekStart) {
	const initials = driverName.split(/\s+/).map(w => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
	const d = new Date(weekStart);
	const year = d.getUTCFullYear();
	const jan1 = new Date(Date.UTC(year, 0, 1));
	const days = Math.floor((d - jan1) / 86400000);
	const weekNum = Math.ceil((days + jan1.getUTCDay() + 1) / 7);
	const weekStr = String(weekNum).padStart(2, "0");
	const existing = db.prepare("SELECT COUNT(*) AS cnt FROM invoices WHERE LOWER(driver) = ? AND week_start = ?")
		.get(driverName.toLowerCase(), weekStart).cnt;
	const seq = String(existing + 1).padStart(2, "0");
	return `INV-${initials}-${year}W${weekStr}-${seq}`;
}

async function batteryNumbering(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	{
		// Same initials, same week, two drivers.
		const w = buildWorld({ src });
		const shorn = await generate(w, SUPER, "Shorn King", W38);
		const sam = await generate(w, SUPER, "Sam Kelly", W38);
		const s1 = shorn.body && shorn.body.invoice, s2 = sam.body && sam.body.invoice;
		t("§2 two drivers with the same initials in one week: both invoices are written", [shorn.statusCode, sam.statusCode], [200, 200]);
		t("§2 …the second takes the next free number", [s1 && s1.invoice_number, s2 && s2.invoice_number], [`INV-SK-${W38.tag}-01`, `INV-SK-${W38.tag}-02`]);
		t("§2 …each row's PDF is its own", [s1 && who(w, s1.pdf_file_name), s2 && who(w, s2.pdf_file_name)], ["Shorn King", "Sam Kelly"]);
		const nums = w.db.prepare("SELECT invoice_number, pdf_file_name FROM invoices").all();
		t("§2 …no number or file name is held twice",
			[new Set(nums.map((r) => r.invoice_number.toLowerCase())).size, new Set(nums.map((r) => r.pdf_file_name.toLowerCase())).size], [nums.length, nums.length]);
	}
	{
		// A soft-deleted invoice keeps its number; the next one moves on.
		const w = buildWorld({ src });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const first = a.body && a.body.invoice;
		w.db.prepare("UPDATE invoices SET deleted_at = '2026-09-26T00:00:00Z' WHERE id = ?").run(first && first.id);
		const b = await generate(w, SUPER, "Shorn King", W38);
		t("§2 after a soft delete the next invoice is -02", b.body && b.body.invoice && b.body.invoice.invoice_number, `INV-SK-${W38.tag}-02`);
		t("§2 …and the deleted invoice's PDF is still its own", first && JSON.parse(pdfOf(w, first.pdf_file_name) || "{}").number, first && first.invoice_number);
	}
	{
		// A row under another spelling of the same driver counts toward the sequence.
		const w = buildWorld({ src });
		insertInvoice(w.db, { invoice_number: `INV-M-SK-${W38.tag}-01`, driver: "shorn  king", week_start: W38.start, is_manual: 1 });
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§2 this driver's invoice for the week under another spelling counts: the next is -02",
			r.body && r.body.invoice && r.body.invoice.invoice_number, `INV-SK-${W38.tag}-02`);
	}
	{
		// A file name held in another case is held.
		const w = buildWorld({ src });
		insertInvoice(w.db, { invoice_number: "LEGACY-7", driver: "someone else", week_start: "2025-01-04", pdf_file_name: `inv-sk-${W38.tag.toLowerCase()}-01.pdf` });
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§2 a PDF name another row holds in another case is not reused",
			r.body && r.body.invoice && r.body.invoice.invoice_number, `INV-SK-${W38.tag}-02`);
	}
	{
		// A regenerated Draft keeps its number.
		const w = buildWorld({ src });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const b = await generate(w, SUPER, "Shorn King", W38);
		t("§2 a regenerated Draft keeps its number",
			[a.body && a.body.invoice && a.body.invoice.invoice_number, b.body && b.body.invoice && b.body.invoice.invoice_number],
			[`INV-SK-${W38.tag}-01`, `INV-SK-${W38.tag}-01`]);
	}
	{
		// Manual invoices: two payees with the same initials in one period.
		const w = buildWorld({ src });
		const manual = (payee) => callRoute(w, "POST /api/invoices/manual", {
			session: { user: SUPER },
			body: { payee, periodStart: W38.start, periodEnd: "2026-09-25", lineItems: [{ description: "Yard work", amount: 100 }], payeeAddress: "", payeePhone: "" },
		});
		const m1 = await manual("Sam Kelly");
		const m2 = await manual("Shorn King");
		t("§2 two manual payees with the same initials in one period both get invoices", [m1.statusCode, m2.statusCode], [200, 200]);
		t("§2 …numbered -01 and -02",
			[m1.body && m1.body.invoice && m1.body.invoice.invoice_number, m2.body && m2.body.invoice && m2.body.invoice.invoice_number],
			[`INV-M-SK-${W38.tag}-01`, `INV-M-SK-${W38.tag}-02`]);
		t("§2 …each with its own PDF",
			[m1.body && m1.body.invoice && who(w, m1.body.invoice.pdf_file_name), m2.body && m2.body.invoice && who(w, m2.body.invoice.pdf_file_name)],
			["Sam Kelly", "Shorn King"]);
	}
	{
		// Every number the old count would mint that nobody holds is minted unchanged.
		const w = buildWorld({ src });
		insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-01`, driver: "shorn king", week_start: W38.start, deleted_at: "x" });
		insertInvoice(w.db, { invoice_number: `INV-O-${W39.tag}-01`, driver: "o'brien", week_start: W39.start });
		insertInvoice(w.db, { invoice_number: `INV-O-${W39.tag}-02`, driver: "o'brien", week_start: W39.start, deleted_at: "x" });
		insertInvoice(w.db, { invoice_number: `INV-SK-${W40.tag}-01`, driver: "Shorn King", week_start: W40.start });
		const cases = [["Shorn King", W38], ["Mary Jane Watson", W38], ["O'Brien", W39], ["Shorn King", W40], ["Pat Percent", W39], ["a/b c/d", W40]];
		const newer = cases.map(([n, wk]) => w.generateInvoiceNumber(n, wk.start));
		const older = cases.map(([n, wk]) => OLD_generateInvoiceNumber(w.db, n, wk.start));
		t("§2 where the old count's number is free, the number is byte-identical to origin/main's", newer, older);
		const newerManual = cases.map(([n, wk]) => w.generateInvoiceNumber(n, wk.start, { prefix: "INV-M-" }));
		t("§2 …and a manual number is the old INV- number with the INV-M- prefix", newerManual, older.map((s) => s.replace(/^INV-/, "INV-M-")));
		t("§2 invoicePdfFileName() is `${number}.pdf` for every weekly number", newer.map((n) => w.invoicePdfFileName(n)), newer.map((n) => `${n}.pdf`));
	}
	return out;
}

// ═════════════════════════════════════════════════════ §3 PDFs
async function batteryPdfs(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const num = (data) => `INV-${data.invoiceNumberSuffix}`;
	{
		// Before the request: another driver's row holds -01 and its PDF.
		const w = buildWorld({ src });
		insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-01`, driver: "sam kelly", week_start: W38.start, status: "Paid" });
		putFile(w, `INV-SK-${W38.tag}-01.pdf`, "SAM'S PAID INVOICE");
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 another driver holding the number: this invoice takes the next one", [r.statusCode, r.body && r.body.invoice && r.body.invoice.invoice_number], [200, `INV-SK-${W38.tag}-02`]);
		t("§3 …and that driver's PDF is untouched", pdfOf(w, `INV-SK-${W38.tag}-01.pdf`), "SAM'S PAID INVOICE");
	}
	{
		// During the render: another row takes the NUMBER (and writes its file).
		const w = buildWorld({ src, onRender: (data, { db }) => {
			insertInvoice(db, { invoice_number: num(data), driver: "sam kelly", week_start: W38.start });
			putFile(w, `${num(data)}.pdf`, "OTHER");
		} });
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 a number taken during the render: 409 INVOICE_NUMBER_TAKEN", [r.statusCode, r.body && r.body.code], [409, "INVOICE_NUMBER_TAKEN"]);
		t("§3 …the other invoice's PDF is untouched", pdfOf(w, `INV-SK-${W38.tag}-01.pdf`), "OTHER");
		t("§3 …no row for this driver-week, no temporary file left", [liveRows(w, "Shorn King", W38).length, tmpLeft(w)], [0, []]);
	}
	{
		// During the render: another row takes the FILE NAME under a different number.
		const w = buildWorld({ src, onRender: (data, { db }) => {
			insertInvoice(db, { invoice_number: "LEGACY-99", driver: "sam kelly", week_start: "2025-01-04", pdf_file_name: `${num(data)}.pdf` });
			putFile(w, `${num(data)}.pdf`, "LEGACY DOCUMENT");
		} });
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 a PDF name taken during the render (different number): 409 INVOICE_NUMBER_TAKEN", [r.statusCode, r.body && r.body.code], [409, "INVOICE_NUMBER_TAKEN"]);
		t("§3 …that row's document is untouched", pdfOf(w, `INV-SK-${W38.tag}-01.pdf`), "LEGACY DOCUMENT");
	}
	{
		// During the render: the driver-week gains a live invoice under another spelling.
		const w = buildWorld({ src, onRender: (data, { db }) => {
			insertInvoice(db, { invoice_number: `INV-SK-${W38.tag}-77`, driver: "shorn  king", week_start: W38.start });
		} });
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 the driver-week taken during the render (other spelling): 409 INVOICE_WEEK_CHANGED", [r.statusCode, r.body && r.body.code], [409, "INVOICE_WEEK_CHANGED"]);
		t("§3 …leaving one live invoice for the week, not two", liveRows(w, "Shorn King", W38).map((x) => x.invoice_number), [`INV-SK-${W38.tag}-77`]);
	}
	{
		// During a regenerate's render: the Draft is submitted.
		let hook = null;
		const w = buildWorld({ src, onRender: (data, ctx) => hook && hook(data, ctx) });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		const before = pdfOf(w, draft && draft.pdf_file_name);
		hook = (data, { db }) => { db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(draft.id); };
		const r = await generate(w, SUPER, "Shorn  King", W38);
		t("§3 the Draft submitted during a regenerate's render: 409 INVOICE_WEEK_CHANGED", [r.statusCode, r.body && r.body.code], [409, "INVOICE_WEEK_CHANGED"]);
		t("§3 …the submitted invoice and its PDF are untouched", [rowById(w, draft && draft.id) && rowById(w, draft.id).status, pdfOf(w, draft && draft.pdf_file_name) === before], ["Submitted", true]);
	}
	{
		// During a regenerate's render: an admin adjusts the Draft.
		let hook = null;
		const w = buildWorld({ src, onRender: (data, ctx) => hook && hook(data, ctx) });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		hook = (data, { db }) => { db.prepare("UPDATE invoices SET adjustment = 200, adjustment_note = 'bonus', adjusted_at = 'now' WHERE id = ?").run(draft.id); };
		const r = await generate(w, SHORN, "", W38);
		t("§3 the Draft adjusted during a regenerate's render: 409 INVOICE_WEEK_CHANGED", [r.statusCode, r.body && r.body.code], [409, "INVOICE_WEEK_CHANGED"]);
		t("§3 …the adjustment stands", rowById(w, draft && draft.id) && rowById(w, draft.id).adjustment, 200);
	}
	{
		// A failed render leaves the Draft being regenerated exactly as it was.
		let fail = false;
		const w = buildWorld({ src, onRender: () => { if (fail) throw new Error("renderer down"); } });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		const before = pdfOf(w, draft && draft.pdf_file_name);
		fail = true;
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 a failed render is a 500", r.statusCode, 500);
		t("§3 …and the Draft it was regenerating is still there, with its PDF",
			[!!rowById(w, draft && draft.id), pdfOf(w, draft && draft.pdf_file_name) === before, tmpLeft(w)], [true, true, []]);
	}
	{
		// A temporary file that fails part-way (a full disk) leaves nothing behind.
		let full = false;
		const diskFull = Object.assign(Object.create(fs), {
			writeFileSync(p, data, ...rest) {
				if (full && String(p).endsWith(".tmp")) {
					fs.writeFileSync(p, "PARTIAL");
					throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
				}
				return fs.writeFileSync(p, data, ...rest);
			},
		});
		const w = buildWorld({ src, fs: diskFull });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		const before = pdfOf(w, draft && draft.pdf_file_name);
		full = true;
		const r = await generate(w, SUPER, "Shorn King", W38);
		t("§3 a disk-full temporary write is a 500", r.statusCode, 500);
		t("§3 …leaving no partial temporary file, and the Draft and its PDF as they were",
			[tmpLeft(w), !!rowById(w, draft && draft.id), pdfOf(w, draft && draft.pdf_file_name) === before], [[], true, true]);
	}
	{
		// commitInvoiceWithPdf(): a failed INSERT leaves the final file and the Draft.
		const w = buildWorld({ src });
		const id = insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-01`, driver: "shorn king", week_start: W38.start });
		putFile(w, `INV-SK-${W38.tag}-01.pdf`, "THE DRAFT'S PDF");
		const replacing = w.liveWeeklyInvoicesForDriverWeek("Shorn King", W38.start)[0];
		let thrown = "";
		try {
			w.commitInvoiceWithPdf({
				invoiceNumber: `INV-SK-${W38.tag}-01`, pdfFileName: `INV-SK-${W38.tag}-01.pdf`, pdfBuffer: Buffer.from("NEW"),
				replacing, slot: { driverName: "Shorn King", weekStart: W38.start },
				insert: () => { throw new Error("insert failed"); },
			});
		} catch (e) { thrown = e.message; }
		t("§3 a failed INSERT throws", thrown, "insert failed");
		t("§3 …and rolls back: the Draft row and its PDF are untouched, no temporary file",
			[!!rowById(w, id), pdfOf(w, `INV-SK-${W38.tag}-01.pdf`), tmpLeft(w)], [true, "THE DRAFT'S PDF", []]);
	}
	{
		// An adjustment re-renders the Draft; while that render runs, the Draft is
		// regenerated (a new row on the same number and file). The adjustment must
		// not write its older render over the regenerated invoice's PDF.
		let gate = null;
		let armed = false;
		const w = buildWorld({ src, onRender: async () => { if (armed) { armed = false; await gate; } } });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		let release = null;
		gate = new Promise((r) => { release = r; });
		armed = true;
		const pending = callRoute(w, "PUT /api/invoices/:id/adjust", { session: { user: SUPER }, params: { id: String(draft && draft.id) }, body: { adjustment: 50, adjustmentNote: "bonus" } });
		const regen = await generate(w, SUPER, "Shorn  King", W38);
		const regenSeq = w.rendered.length;
		release();
		const adj = await pending;
		const fresh = regen.body && regen.body.invoice;
		t("§3 a Draft regenerated while an adjustment re-renders it: the adjust answers 409", adj.statusCode, 409);
		t("§3 …and the regenerated invoice keeps its own PDF, and the adjustment it carried over",
			[fresh && JSON.parse(pdfOf(w, fresh.pdf_file_name) || "{}").seq, fresh && rowById(w, fresh.id) && rowById(w, fresh.id).adjustment, tmpLeft(w)],
			[regenSeq, 50, []]);
	}
	{
		// Two adjustments at once: the earlier one's render finishes last. It must be
		// refused, and its rollback must not undo the later adjustment.
		let gate = null;
		let armed = false;
		const w = buildWorld({ src, onRender: async () => { if (armed) { armed = false; await gate; } } });
		const a = await generate(w, SUPER, "Shorn King", W38);
		const draft = a.body && a.body.invoice;
		let release = null;
		gate = new Promise((r) => { release = r; });
		armed = true;
		const first = callRoute(w, "PUT /api/invoices/:id/adjust", { session: { user: SUPER }, params: { id: String(draft && draft.id) }, body: { adjustment: 50, adjustmentNote: "first" } });
		const second = await callRoute(w, "PUT /api/invoices/:id/adjust", { session: { user: { ...SUPER, username: "admin2" } }, params: { id: String(draft && draft.id) }, body: { adjustment: 70, adjustmentNote: "second" } });
		release();
		const one = await first;
		t("§3 two adjustments at once: the later lands, the earlier is refused", [second.statusCode, one.statusCode], [200, 409]);
		t("§3 …and the refused one's rollback leaves the later adjustment and its PDF in place",
			[rowById(w, draft && draft.id) && rowById(w, draft.id).adjustment, JSON.parse(pdfOf(w, draft && draft.pdf_file_name) || "{}").adjustment],
			[70, 70]);
	}
	{
		// The adjust route's re-render rewrites a row's own file — never a shared one.
		const w = buildWorld({ src });
		const snapshot = JSON.stringify({ __templateName: "service_invoice", driverName: "Shorn King", invoiceNumberSuffix: "X" });
		const a = insertInvoice(w.db, { invoice_number: "LEGACY-A", driver: "shorn king", week_start: "2025-01-04", pdf_file_name: "SHARED.pdf", render_data: snapshot, adjustment: 50 });
		insertInvoice(w.db, { invoice_number: "LEGACY-B", driver: "sam kelly", week_start: "2025-01-11", pdf_file_name: "SHARED.pdf", render_data: snapshot });
		putFile(w, "SHARED.pdf", "B'S DOCUMENT");
		let thrown = "";
		try { await w.rerenderInvoicePdfFromStoredData(rowById(w, a)); } catch (e) { thrown = e.message; }
		t("§3 the adjust re-render refuses a PDF file another row also names", /also the file of LEGACY-B/.test(thrown), true);
		t("§3 …leaving that file untouched", pdfOf(w, "SHARED.pdf"), "B'S DOCUMENT");
		const c = insertInvoice(w.db, { invoice_number: "OWN-C", driver: "pat percent", week_start: "2025-01-18", pdf_file_name: "OWN-C.pdf", render_data: snapshot, adjustment: 75 });
		putFile(w, "OWN-C.pdf", "ORIGINAL");
		const mode = await w.rerenderInvoicePdfFromStoredData(rowById(w, c));
		t("§3 …while a row's own file re-renders with its adjustment", [mode, JSON.parse(pdfOf(w, "OWN-C.pdf") || "{}").adjustment], ["rerender", 75]);
	}
	{
		// The manual route: a number taken during its render is refused, not overwritten.
		const w = buildWorld({ src, onRender: (data, { db }) => {
			insertInvoice(db, { invoice_number: num(data), driver: "someone", week_start: W38.start, is_manual: 1 });
			putFile(w, `${num(data)}.pdf`, "OTHER MANUAL");
		} });
		const r = await callRoute(w, "POST /api/invoices/manual", {
			session: { user: SUPER },
			body: { payee: "Sam Kelly", periodStart: W38.start, periodEnd: "2026-09-25", lineItems: [{ description: "Yard work", amount: 100 }], payeeAddress: "", payeePhone: "" },
		});
		t("§3 manual: a number taken during the render is 409 INVOICE_NUMBER_TAKEN", [r.statusCode, r.body && r.body.code], [409, "INVOICE_NUMBER_TAKEN"]);
		t("§3 manual: …and the other invoice's PDF is untouched", pdfOf(w, `INV-M-SK-${W38.tag}-01.pdf`), "OTHER MANUAL");
	}
	return out;
}

// ═════════════════════════════════════════════════════ §4 pay agrees with the P&L
async function batteryPay(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const cases = [
		["Shorn King", "Shorn King"], ["Shorn King", "Shorn  King"], ["Shorn King", "SHORN KING"],
		["Tom Truck", "Tom Truck"], ["Tom Truck", "Tom  Truck"],
		["Dee Dayrate", "Dee Dayrate"], ["Sam Kelly", "Sam Kelly"],
		["Pat Percent", "Pat Percent"], ["Pat Percent", "pat  percent"],
	];
	for (const [driver, spelling] of cases) {
		const w = buildWorld({ src });
		// The P&L's answer, from GET /api/financials' own code on the same rows.
		const key = w.normalizeDriverName(spelling);
		const struct = w.getDriverPayStructures()[key] || { payType: "fixed", payPercentage: 0 };
		const pnlRate = w.resolveDailyRate(struct.payDaily, w.pnlTrucks()[key]);
		const r = await generate(w, SUPER, spelling, W38);
		const inv = r.body && r.body.invoice;
		const tpl = w.rendered[0] && w.rendered[0].templateName;
		const invoiceSays = inv ? {
			payType: tpl === "service_invoice_owner_op" ? "percentage" : "fixed",
			rate: inv.rate_per_load,
		} : null;
		const pnlSays = { payType: struct.payType, rate: struct.payType === "percentage" ? struct.payPercentage : pnlRate };
		t(`§4 ${driver} asked as ${JSON.stringify(spelling)}: the invoice's pay type and rate are the P&L's`, invoiceSays, pnlSays);
	}
	{
		// The absolute figures, so an agreement between two wrong answers cannot pass.
		const expect = { "Shorn King": [300, 600], "Tom Truck": [325, 650], "Dee Dayrate": [310, 620], "Sam Kelly": [260, 260] };
		for (const [driver, [rate, total]] of Object.entries(expect)) {
			const w = buildWorld({ src });
			const r = await generate(w, SUPER, driver, W38);
			t(`§4 ${driver}: $${rate}/day, $${total} for the week`, r.body && r.body.invoice && [r.body.invoice.rate_per_load, r.body.invoice.total_earnings], [rate, total]);
		}
	}
	{
		// Percentage pay deducts the driver's Fuel/Maintenance in any spelling.
		const w = buildWorld({ src });
		const r = await generate(w, SUPER, "Pat Percent", W38);
		const inv = r.body && r.body.invoice;
		const data = w.rendered[0] && w.rendered[0].data;
		t("§4 percentage: deducts both spellings' Fuel/Maintenance ($100 + $50), never the Rejected $999", data && data.deductible, 150);
		t("§4 percentage: 20% of ($1,500 − $150) = $270", inv && inv.total_earnings, 270);
		t("§4 percentage: the expense total and ids are the driver's in any spelling", inv && [inv.expenses_total, JSON.parse(inv.expense_ids).length], [150, 2]);
	}
	{
		// The address, phone and bank on the invoice come from this driver's records.
		const w = buildWorld({ src });
		await generate(w, SUPER, "Shorn King", W38);
		const data = w.rendered[0] && w.rendered[0].data;
		t("§4 the directory row found under another spelling supplies the address and phone",
			data && [data.providerAddress, data.providerPhone], ["1 Main St, Houston, TX, 77002", "555-0101"]);
		t("§4 the one account under the name supplies the bank on file", data && data.bankOnFile, "Shorn Test Bank");
		const w2 = buildWorld({ src });
		w2.db.prepare("INSERT INTO users (username, email, role, driver_name) VALUES ('sk2', 'sk2@example.test', 'Driver', 'SHORN  KING')").run();
		await generate(w2, SUPER, "Shorn King", W38);
		t("§4 …but two accounts under one name print no bank", w2.rendered[0] && w2.rendered[0].data.bankOnFile, "");
	}
	return out;
}

// ═════════════════════════════════════════════════════ §5 the Friday batch
async function batteryBatch(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const sheetShorn = toValues(SHEET.filter((r) => r.Driver === "Shorn King" || r.Driver === "Sam Kelly"));
	const sheetOnlyShorn = toValues(SHEET.filter((r) => r.Driver === "Shorn King"));
	{
		// Two directory rows for one driver (an older pair the naming check would refuse).
		const w = buildWorld({ src, sheetValues: sheetShorn, seed: (db) => {
			seedBase(db);
			db.prepare("DELETE FROM drivers_directory").run();
			db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_daily) VALUES ('Shorn  King', 'fixed', 300), ('Shorn King', 'fixed', 0), ('Sam Kelly', 'fixed', 0)").run();
		} });
		const result = await w.runWeeklyInvoiceBatch(W38.param, 1);
		const marker = w.db.prepare("SELECT * FROM invoice_autogen_runs WHERE week_end = ?").get(W38.param) || {};
		t("§5 one driver in two directory spellings is billed ONCE, and submitted",
			liveRows(w, "Shorn King", W38).map((r) => [r.status, r.total_earnings]), [["Submitted", 600]]);
		t("§5 …the run counts two created, none skipped, none failed, no problem",
			[marker.created, marker.skipped, marker.failed, result && result.problem], [2, 0, 0, false]);
	}
	{
		// Two live Drafts for Sam: the handler refuses, and that is not "billed".
		const w = buildWorld({ src, sheetValues: sheetShorn, seed: (db) => {
			seedBase(db);
			db.prepare("DELETE FROM drivers_directory WHERE driver_name NOT IN ('Sam Kelly', 'Shorn  King')").run();
			insertInvoice(db, { invoice_number: `INV-SK-${W38.tag}-05`, driver: "sam kelly", week_start: W38.start });
			insertInvoice(db, { invoice_number: `INV-SK-${W38.tag}-06`, driver: "sam  kelly", week_start: W38.start });
		} });
		const result = await w.runWeeklyInvoiceBatch(W38.param, 1);
		const marker = w.db.prepare("SELECT * FROM invoice_autogen_runs WHERE week_end = ?").get(W38.param) || {};
		t("§5 a 409 that is not INVOICE_EXISTS is an error: the driver stays unbilled and the run retries",
			[result && result.problem, marker.failed, /WORKED-BUT-UNBILLED \(sam kelly\)/.test(marker.summary || ""), /1 errored/.test(marker.summary || "")],
			[true, 1, true, true]);
	}
	{
		// A submitted invoice stored under another spelling: 409 INVOICE_EXISTS, billed.
		const w = buildWorld({ src, sheetValues: sheetOnlyShorn, seed: (db) => {
			seedBase(db);
			db.prepare("DELETE FROM drivers_directory WHERE driver_name <> 'Shorn  King'").run();
			insertInvoice(db, { invoice_number: `INV-SK-${W38.tag}-01`, driver: "shorn king", week_start: W38.start, status: "Submitted" });
		} });
		const result = await w.runWeeklyInvoiceBatch(W38.param, 1);
		const marker = w.db.prepare("SELECT * FROM invoice_autogen_runs WHERE week_end = ?").get(W38.param) || {};
		t("§5 an invoice already submitted under another spelling counts as billed — skipped, no retry",
			[marker.created, marker.skipped, result && result.problem, liveRows(w, "Shorn King", W38).length], [0, 1, false, 1]);
	}
	return out;
}

// ═════════════════════════════════════════════════════ §6 the readers
async function batteryReaders(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = buildWorld({ src });
	const a = insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-01`, driver: "shorn king", week_start: W38.start, week_end: "2026-09-25", status: "Submitted", total_earnings: 600 });
	const b = insertInvoice(w.db, { invoice_number: `INV-SK-${W39.tag}-01`, driver: "shorn  king", week_start: W39.start, week_end: "2026-10-02", status: "Submitted", total_earnings: 450 });
	insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-02`, driver: "sam kelly", week_start: W38.start, status: "Submitted" });
	insertInvoice(w.db, { invoice_number: "INV-SK-2026W37-01", driver: "shorn king", week_start: "2026-09-12", deleted_at: "x" });
	const ids = (res) => (res.body && res.body.invoices ? res.body.invoices.map((r) => r.invoice_number).sort() : null);
	const mine = [`INV-SK-${W38.tag}-01`, `INV-SK-${W39.tag}-01`];
	t("§6 GET /api/invoices: a Driver lists their invoices in every stored spelling, never another's or a deleted one",
		ids(await callRoute(w, "GET /api/invoices", { session: { user: SHORN } })), mine);
	t("§6 GET /api/invoices: a role with no driver name lists nothing",
		ids(await callRoute(w, "GET /api/invoices", { session: { user: DISPATCH } })), []);
	t("§6 GET /api/invoices: the Super Admin driver filter matches every spelling",
		ids(await callRoute(w, "GET /api/invoices", { session: { user: SUPER }, query: { driver: "Shorn  King" } })), mine);
	const app = w.driverAppList("Shorn King");
	t("§6 the driver app's list: the driver's invoices in every spelling", app.map((r) => r.invoice_number).sort(), mine);
	t("§6 …in the shape it always had (no driver field)", app.every((r) => !("driver" in r)), true);
	for (let i = 0; i < 25; i++) insertInvoice(w.db, { invoice_number: `BULK-${i}`, driver: i % 2 ? "shorn king" : "SHORN  KING", week_start: `2024-01-${String(i + 1).padStart(2, "0")}`, is_manual: 1 });
	t("§6 …still capped at 20", w.driverAppList("Shorn King").length, 20);
	// Restore: one live weekly invoice per driver-week, in any spelling.
	const dead = insertInvoice(w.db, { invoice_number: `INV-SK-${W38.tag}-09`, driver: "shorn  king", week_start: W38.start, deleted_at: "x" });
	const r1 = await callRoute(w, "PUT /api/invoices/:id/restore", { session: { user: SUPER }, params: { id: String(dead) } });
	t("§6 restore refuses a spacing variant of a driver-week that already has a live invoice",
		[r1.statusCode, rowById(w, dead).deleted_at], [409, "x"]);
	const alone = insertInvoice(w.db, { invoice_number: `INV-SK-${W40.tag}-01`, driver: "shorn  king", week_start: W40.start, week_end: "2026-10-09", deleted_at: "x" });
	const r2 = await callRoute(w, "PUT /api/invoices/:id/restore", { session: { user: SUPER }, params: { id: String(alone) } });
	t("§6 …and restores one with no live twin", [r2.statusCode, rowById(w, alone).deleted_at], [200, ""]);
	// Approve: the status email reaches the driver whose name is on the invoice.
	w.emails.length = 0;
	await callRoute(w, "PUT /api/invoices/:id/approve", { session: { user: SUPER }, params: { id: String(b) }, body: { action: "approve" } });
	t("§6 approve emails the Driver account named on the invoice, in any spelling", w.emails.map((m) => m.to), ["sking@example.test"]);
	w.db.prepare("INSERT INTO users (username, email, role, driver_name) VALUES ('sk2', 'sk2@example.test', 'Driver', 'shorn KING')").run();
	w.emails.length = 0;
	await callRoute(w, "PUT /api/invoices/:id/approve", { session: { user: SUPER }, params: { id: String(a) }, body: { action: "approve" } });
	t("§6 …and emails nobody when two Driver accounts carry the name", w.emails.map((m) => m.to), []);
	// The payment report.
	const rep = w.buildPaymentReport("Shorn King", "2026-09-01", "2026-10-31");
	t("§6 the payment report counts the payee's invoices in every spelling",
		rep.invoices.map((r) => r.invoice_number).sort(), [`INV-SK-${W38.tag}-01`, `INV-SK-${W39.tag}-01`, `INV-SK-${W40.tag}-01`]);
	return out;
}

const BATTERIES = [
	["§1", batteryIdentity], ["§2", batteryNumbering], ["§3", batteryPdfs],
	["§4", batteryPay], ["§5", batteryBatch], ["§6", batteryReaders],
];

// ═════════════════════════════════════════════════════ §8 mutants
// One per money guard: each rewrites the guard back to a narrower rule and must
// flip at least one assertion above.
const MUTANTS = [
	["M1 normalized matching — the daily rate from origin/main's exact-spelling lookups",
		"const dailyRate = resolveDailyRate(payStruct.payDaily, truckDailyRateCandidates(driverName).slice(-1)[0]);",
		"const truckRateRow = db.prepare(\"SELECT driver_pay_daily FROM trucks WHERE LOWER(assigned_driver) = LOWER(?) AND COALESCE(driver_pay_daily, 0) > 0 LIMIT 1\").get(driverName); const driverDailyRow = db.prepare(\"SELECT pay_daily FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?) LIMIT 1\").get(driverName); const dailyRate = resolveDailyRate(driverDailyRow && driverDailyRow.pay_daily, truckRateRow && truckRateRow.driver_pay_daily);"],
	["M2 the existing-invoice check matches the exact spelling",
		"const weekInvoices = liveWeeklyInvoicesForDriverWeek(driverName, weekStart);",
		"const weekInvoices = db.prepare(\"SELECT *, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at FROM invoices WHERE LOWER(driver) = ? AND week_start = ? AND deleted_at = '' AND is_manual = 0\").all(driverName.toLowerCase(), weekStart);"],
	["M3 never reuse a number — the allocator mints a number another row holds",
		"if (!invoiceNumberHolders(number, invoicePdfFileName(number), replacingId).length) return number;",
		"return number;"],
	["M4 never overwrite a PDF — the write does not re-check the number and file",
		"if (invoiceNumberHolders(invoiceNumber, pdfFileName, replacingId).length) {",
		"if (false) {"],
];
function mutate(find, replace, label) {
	const hits = SRC.split(find).length - 1;
	if (hits !== 1) throw new Error(`mutant "${label}": expected its target exactly once in server.js, found ${hits}`);
	return SRC.replace(find, () => replace);
}

// ═════════════════════════════════════════════════════ run
(async () => {
	try {
		for (const [name, battery] of BATTERIES) {
			section(`${name} ${{
				"§1": "ONE DRIVER, TWO SPELLINGS, ONE INVOICE",
				"§2": "NUMBERING NEVER REUSES A NUMBER",
				"§3": "A PDF IS NEVER OVERWRITTEN BY ANOTHER INVOICE",
				"§4": "PAY LOOKUPS AGREE WITH THE P&L",
				"§5": "THE FRIDAY BATCH",
				"§6": "THE READERS",
			}[name]}`);
			report(await battery());
		}

		// ═══════════════════════════════════════════ §7 source pins
		section("§7 SOURCE PINS");
		const handler = liftAsyncFn(SRC, "generateInvoiceHandler");
		const commit = liftFn(SRC, "commitInvoiceWithPdf");
		const batch = liftAsyncFn(SRC, "runWeeklyInvoiceBatch");
		const manual = liftRoute(SRC, ROUTES[1]);
		const list = liftRoute(SRC, ROUTES[0]);
		const approve = liftRoute(SRC, ROUTES[2]);
		const restore = liftRoute(SRC, ROUTES[3]);
		const report_ = liftFn(SRC, "buildPaymentReport");
		const pins = [
			["§7 the handler compares no driver name in SQL", /LOWER\((driver|driver_name|assigned_driver)\)/.test(handler), false],
			["§7 the handler writes no file itself and deletes no row itself", [/writeFileSync|renameSync/.test(handler), /DELETE FROM invoices/.test(handler)], [false, false]],
			// Counted as CALLS — the comments name the helper too.
			["§7 the handler writes through commitInvoiceWithPdf() exactly once, with its driver-week", [(handler.match(/= commitInvoiceWithPdf\(\{/g) || []).length, /slot: \{ driverName, weekStart \}/.test(handler)], [1, true]],
			["§7 the handler's existing-invoice check is liveWeeklyInvoicesForDriverWeek()", /const weekInvoices = liveWeeklyInvoicesForDriverWeek\(driverName, weekStart\);/.test(handler), true],
			["§7 commitInvoiceWithPdf() has no await and runs one IMMEDIATE transaction", [/\bawait\b/.test(commit), /\}\)\.immediate\(\);/.test(commit)], [false, true]],
			["§7 …and moves the PDF into place only after the INSERT", commit.indexOf("fs.renameSync(tmpPath, finalPath)") > commit.indexOf("const result = insert();"), true],
			["§7 the manual route mints INV-M- directly and writes through commitInvoiceWithPdf()",
				[/generateInvoiceNumber\(payee, periodStart, \{ prefix: "INV-M-" \}\)/.test(manual), /commitInvoiceWithPdf\(/.test(manual), /writeFileSync/.test(manual)], [true, true, false]],
			["§7 the batch counts only INVOICE_EXISTS as billed", [/statusCode === 409 && body\.code === "INVOICE_EXISTS"/.test(batch), /statusCode === 409\)/.test(batch)], [true, false]],
			["§7 no reader of these routes compares a driver name in SQL",
				[list, approve, restore, report_].map((s) => /LOWER\((driver|driver_name)\)/.test(s)), [false, false, false, false]],
			// The two INSERTs that mint an invoice (the boot-time CHECK probe, which
			// inserts and deletes a sentinel row, names no loads_count).
			["§7 both invoice-minting INSERTs are insert() callbacks of commitInvoiceWithPdf()",
				[(SRC.match(/INSERT INTO invoices \(invoice_number, driver, week_start, week_end, loads_count/g) || []).length,
					(SRC.match(/insert: \(\) => db\.prepare\(\n\t+`INSERT INTO invoices \(invoice_number, driver, week_start, week_end, loads_count/g) || []).length],
				[2, 2]],
			["§7 the P&L resolution §4 compares against is what /api/financials runs",
				[SRC.includes('const struct = payStructures[driver] || { payType: "fixed", payPercentage: 0 };'),
					SRC.includes("dailyRate = resolveDailyRate(struct.payDaily, trucksByDriver[driver]);")], [true, true]],
		];
		report(pins);

		// ═══════════════════════════════════════════ §8 mutants
		section("§8 MUTANTS — each must flip at least one assertion above");
		// A mutant counts as caught only when an ASSERTION fails. A battery that
		// throws means the mutant broke the harness (it no longer parses, say),
		// which proves nothing about the rule — so that is a failure of its own.
		for (const [label, find, replace] of MUTANTS) {
			const src = mutate(find, replace, label);
			const flipped = [];
			const threw = [];
			for (const [name, battery] of BATTERIES) {
				let checks;
				try { checks = await battery(src); }
				catch (e) { threw.push(`${name}: ${e.message.split("\n")[0]}`); continue; }
				flipped.push(...failed(checks));
			}
			report([[`MUTANT ${label} → ${threw.length ? `a battery THREW (${threw[0]})` : flipped.length ? JSON.stringify(flipped[0]) + (flipped.length > 1 ? ` (+${flipped.length - 1} more)` : "") : "NOTHING fails"}`,
				threw.length === 0 && flipped.length > 0, true]]);
		}
	} catch (err) {
		failures.push(`runner crashed: ${err && err.stack}`);
		console.log(`FAIL  runner crashed: ${err && err.stack}`);
	} finally {
		for (const r of ROOTS) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
	}
	console.log("\n" + "-".repeat(60));
	if (failures.length) {
		console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions:\n  ${failures.join("\n  ")}`);
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})();
