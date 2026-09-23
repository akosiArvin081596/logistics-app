#!/usr/bin/env node
/**
 * WHICH completed loads the weekly driver invoice bills — and which loads every
 * KPI treats as soft-deleted.
 *
 * Three defects, all measured read-only on production 2026-09-23:
 *
 *   A. '#' NORMALIZATION. DELETE /api/loads/:loadId stores a soft-delete as
 *      rawId.toLowerCase().replace(/^#/, ""), but excludeDroppedLoads() and both
 *      weekly-invoice filters compared the RAW lowercased cell. A soft-deleted
 *      "#X" row stayed in revenue, driver pay and the invoice. (Preventive: the
 *      one production deleted_loads row matches the same sheet row either way.)
 *   B. THE INVOICE DEDUPED ON RAW TEXT. "#X" and "X" are one load spelled twice
 *      (a rate-con arrives as two emails); ten production invoices list the same
 *      31 loads twice. For a percentage-paid driver that bills the revenue twice.
 *   C. NO COMPLETION DATE MEANT EVERY WEEK. A completed row with a blank Status
 *      Update Date was "included to be safe" — in every week. 283 of 438 completed
 *      rows are like that. Day-rate pay clips them to $0; percentage pay does not.
 *
 * WHAT IS EXECUTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import). Every lift
 * asserts exactly one definition, so a rename fails loudly instead of testing
 * nothing.
 *   §1 excludeDroppedLoads()           — A on the KPI path (dashboard/investor/financials)
 *   §2 selectInvoiceWeekLoads()        — A, B, C on the invoice path
 *   §3 driversWithCompletedLoadsInWeek — the batch's coverage check agrees with §2
 *   §4 the WHOLE generateInvoiceHandler, against an in-memory SQLite and stubbed
 *      Sheets/renderer: the percentage invoice's money, the day-rate invoice's
 *      load list, and the 400 + warnings for a driver with only undated rows
 *   §4a WHO may generate: Super Admin, or a Driver for themselves. The gate named
 *      only the Driver role, so a Dispatcher or an Investor could mint any
 *      driver's Draft and read back its render_data (address, phone, bank).
 *   §4b the WHOLE runWeeklyInvoiceBatch (the Friday run), side effects captured:
 *      what it submits, and that undated in-week loads are escalated — for
 *      drivers on the roster and off it — while undated history raises nothing
 *   §5 source pins — every reader goes through the shared helpers
 *   §6 DISCRIMINATION — the pre-fix code (verbatim copies below) must FAIL §1–§4b,
 *      and five mutants of the lifted code must each flip an assertion. A test
 *      that passes on the broken code has not tested anything.
 *
 * Pure: no server, no app.db, no network, no Sheets, no fixtures on disk.
 * Run: node scripts/test-invoice-week-selection.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require("../lib/ratecon-load");
const eldMiles = require("../lib/eld-miles");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ---------------------------------------------------------------- lifting
function liftAt(src, needle, label) {
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1; // skip the leading newline
	// Paren-match the parameter list FIRST: invoiceEmailHtml({ heading, … })
	// destructures, and brace-counting from the first `{` would lift the
	// parameter list alone.
	let p = src.indexOf("(", start);
	for (let pd = 0; p < src.length; p++) {
		if (src[p] === "(") pd++;
		else if (src[p] === ")") { pd--; if (pd === 0) break; }
	}
	let depth = 0;
	for (let j = src.indexOf("{", p); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces lifting ${label}`);
}
const liftFn = (src, name) => liftAt(src, `\nfunction ${name}(`, `function ${name}()`);
const liftAsyncFn = (src, name) => liftAt(src, `\nasync function ${name}(`, `async function ${name}()`);
function liftConst(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 const ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	return src.slice(start, src.indexOf("\n", start));
}

const SHARED_FNS = [
	"houstonDay", "sheetDayKey", "getWeekRange", "normalizeDriverName", "findCol", "parseSheet", "deduplicateLoads",
	"getDeletedLoadIds", "excludeDroppedLoads", "loadKeySet",
	"invoiceWeekColumns", "invoiceCompletionDay", "invoiceWeekVerdict", "selectInvoiceWeekLoads", "invoiceWeekWarnings",
	"driversWithCompletedLoadsInWeek",
	"resolveDailyRate", "getEldTravelDaysByVehicle", "getAllExcludedDriverDays", "generateInvoiceNumber", "isAfterDeadline",
	// The Friday batch, run for real in §4b.
	"escHtml", "invoiceEmailHtml", "generateInvoiceInProcess", "abortAutogenRun",
];
const SHARED_CONSTS = ["RFC2822_MONTHS", "CANCELED_STATUS_RE", "INVOICE_COMPLETED_RE", "EXPENSE_PNL_FILTER", "INVOICE_AUTOGEN_MAX_ATTEMPTS"];
const ASYNC_FNS = ["generateInvoiceHandler", "runWeeklyInvoiceBatch"];

// Build the lifted world against one database. `src` defaults to the shipping
// server.js; §6 passes mutated copies. `overrides` replaces a lifted binding
// (§4/§6 splice the PRE-FIX selection into the otherwise-identical handler).
function buildWorld(db, opts = {}) {
	const src = opts.src || SRC;
	const body = [
		...SHARED_CONSTS.map((c) => liftConst(src, c)),
		...SHARED_FNS.map((f) => liftFn(src, f)),
		...ASYNC_FNS.map((f) => liftAsyncFn(src, f)),
		// Module state and statements the batch closes over, restated verbatim.
		"let invoiceAutogenAbortStreak = 0;",
		"let invoiceAutogenAbortAlerted = false;",
		"const submitDraftInvoiceStmt = db.prepare(\"UPDATE invoices SET status = 'Submitted', submitted_at = ? WHERE id = ? AND status = 'Draft'\");",
		// getJobTrackingCached()'s shape: parseSheet + deduplicateLoads over the same values.
		"async function getJobTrackingCached() { const p = parseSheet({ values: __sheetValues }); p.data = deduplicateLoads(p.data, p.headers); return p; }",
		...Object.keys(opts.overrides || {}).map((k) => `${k} = __overrides.${k};`),
		`return { ${[...SHARED_CONSTS, ...SHARED_FNS, ...ASYNC_FNS].join(", ")} };`,
	].join("\n");
	// A function declaration is a mutable binding, so the `name = __overrides.name`
	// lines swap exactly the binding the lifted handler closes over.
	const rendered = [];
	const notes = [];
	const emails = [];
	const logs = [];
	const deps = {
		db,
		normalizeLoadId,
		localDayInTz: eldMiles.localDayInTz,
		usTzForLongitude: eldMiles.usTzForLongitude,
		SPREADSHEET_ID: "test-sheet",
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: opts.sheetValues || [] } }) } } }),
		renderPolicy: async (templateName, data) => { rendered.push({ templateName, data }); return Buffer.from("%PDF-stub"); },
		fs: { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} },
		path,
		__dirname: "/nonexistent",
		__overrides: opts.overrides || {},
		__sheetValues: opts.sheetValues || [],
		// The batch's side effects, captured instead of performed.
		notifyChange: () => {},
		insertDispatchNotification: { run: (...args) => { notes.push(args); } },
		io: null,
		sendEmail: async (to, subject, html) => { emails.push({ to, subject, html }); },
		// The batch races each driver against a 90 s timer; a real one would hold
		// this process open for 90 s after the last assertion.
		setTimeout: () => 0,
		console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => console.error(...a) },
	};
	const w = new Function(...Object.keys(deps), body)(...Object.values(deps));
	Object.assign(w, { rendered, notes, emails, logs });
	return w;
}

// ---------------------------------------------------------------- the PRE-FIX code
// Verbatim from origin/main before this change (only renamed). §6 runs every
// assertion against these and requires them to FAIL.
const OLD_SRC = `
function OLD_excludeDroppedLoads(rows, headers, deletedIds) {
	if (!Array.isArray(rows) || rows.length === 0) return rows || [];
	const loadIdCol = findCol(headers || [], /load.?id|job.?id/i);
	const statusCol = findCol(headers || [], /^(job[\\s._-]?)?status$/i) || findCol(headers || [], /status/i);
	const ids = deletedIds instanceof Set ? deletedIds : getDeletedLoadIds();
	return rows.filter((r) => {
		const lid = loadIdCol ? (r[loadIdCol] || "").toString().trim().toLowerCase() : "";
		if (lid && ids.has(lid)) return false;
		const st = statusCol ? (r[statusCol] || "").toString().trim() : "";
		if (CANCELED_STATUS_RE.test(st)) return false;
		return true;
	});
}
function OLD_selectLoads(data, headers, driverName, weekStart, computedWeekEnd, deletedIds) {
	const driverCol = headers.find(h => /driver/i.test(h));
	const statusCol = headers.find(h => /^(job[\\s._-]?)?status$/i.test(h));
	const loadIdCol = headers.find(h => /load.?id|job.?id/i.test(h));
	const dateCol = headers.find(h => /status.*update.*date|completion.*date|drop.?off.*date|deliv.*date/i.test(h))
		|| headers.find(h => /date/i.test(h));
	const completedRe = /delivered|completed|pod received/i;
	const nameNorm = normalizeDriverName(driverName);
	const weekLoads = data.filter(row => {
		if (!driverCol || normalizeDriverName(row[driverCol]) !== nameNorm) return false;
		if (!statusCol || !completedRe.test(row[statusCol])) return false;
		const lidLc = loadIdCol ? (row[loadIdCol] || "").toString().trim().toLowerCase() : "";
		if (lidLc && deletedIds.has(lidLc)) return false;
		if (!dateCol) return true; // if no date column, include all completed
		const rawDate = (row[dateCol] || "").replace(/^date:\\s*/i, "").trim();
		if (!rawDate) return true; // no date? include to be safe
		const dateStr = sheetDayKey(rawDate);
		if (!dateStr) return true; // unparseable? include, as before
		return dateStr >= weekStart && dateStr <= computedWeekEnd;
	});
	const loadMap = new Map();
	for (const load of weekLoads) {
		const lid = loadIdCol ? (load[loadIdCol] || "") : "";
		if (lid) loadMap.set(lid, load);
		else loadMap.set(\`_row_\${load._rowIndex}\`, load);
	}
	return [...loadMap.values()];
}
function OLD_driversWithCompletedLoadsInWeek(data, headers, weekStart, weekEnd) {
	const col = (re) => headers.find((h) => re.test(h));
	const dCol = col(/driver/i);
	const sCol = col(/^(job[\\s._-]?)?status$/i);
	const lCol = col(/load.?id|job.?id/i);
	const dtCol = col(/status.*update.*date|completion.*date|drop.?off.*date|deliv.*date/i) || col(/date/i);
	const completedRe = /delivered|completed|pod received/i;
	const deletedIds = getDeletedLoadIds();
	const out = new Set();
	if (!dCol || !sCol) return out;
	for (const row of data) {
		const name = normalizeDriverName(row[dCol]);
		if (!name) continue;
		if (!completedRe.test(row[sCol] || "")) continue;
		const lid = lCol ? String(row[lCol] || "").trim().toLowerCase() : "";
		if (lid && deletedIds.has(lid)) continue;
		if (dtCol) {
			const raw = String(row[dtCol] || "").trim();
			if (raw) {
				const ds = sheetDayKey(raw);
				if (ds && (ds < weekStart || ds > weekEnd)) continue;
			}
		}
		out.add(name);
	}
	return out;
}
return { OLD_excludeDroppedLoads, OLD_selectLoads, OLD_driversWithCompletedLoadsInWeek };`;
function buildOld(w) {
	return new Function("findCol", "getDeletedLoadIds", "CANCELED_STATUS_RE", "normalizeDriverName", "sheetDayKey", OLD_SRC)(
		w.findCol, w.getDeletedLoadIds, w.CANCELED_STATUS_RE, w.normalizeDriverName, w.sheetDayKey,
	);
}

// ---------------------------------------------------------------- fixtures
// Production's real 26-column Job Tracking header row, in order.
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
// The billing week the Friday 2026-09-25 batch closes: Sat 09-19 .. Fri 09-25.
const WEEK_END_PARAM = "2026-09-25";
const WS = "2026-09-19", WE = "2026-09-25";

function freshDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft', rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', is_manual INTEGER DEFAULT 0);
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, date TEXT, amount REAL, type TEXT, status TEXT DEFAULT '', description TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT, assigned_driver TEXT, driver_pay_daily REAL DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '');
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
		CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE driver_payment_info (user_id INTEGER, bank_name TEXT, account_type TEXT);
		CREATE TABLE excluded_driver_days (driver_name TEXT, excluded_date TEXT, action TEXT);
		CREATE TABLE routemate_telemetry (routemate_vehicle_id TEXT, location_date_ms INTEGER, speed REAL, longitude REAL, dropped_reason TEXT DEFAULT '');
		CREATE TABLE invoice_autogen_runs (week_end TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP, attempts INTEGER DEFAULT 0, created INTEGER DEFAULT 0, submitted INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, summary TEXT DEFAULT '');
	`);
	// "3001" as the delete route stores it; "#3002" as a hand-inserted SQL row might.
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES (?), (?)").run("3001", "#3002");
	// Pat carries the personal data the §4a gate protects: address, phone, bank.
	db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_percentage, pay_daily, address, city, state, zip, phone) VALUES (?, 'percentage', 20, 0, '12 Home St', 'Houston', 'TX', '77002', '555-0100')").run("Pat Percent");
	db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_percentage, pay_daily) VALUES (?, 'fixed', 0, 300)").run("Dee Dayrate");
	db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_percentage, pay_daily) VALUES (?, 'fixed', 0, 300)").run("Lee Legacy");
	const pat = db.prepare("INSERT INTO users (driver_name) VALUES (?)").run("Pat Percent");
	db.prepare("INSERT INTO driver_payment_info (user_id, bank_name, account_type) VALUES (?, 'First Test Bank', 'Checking')").run(pat.lastInsertRowid);
	return db;
}

let rowNo = 1;
function row(fields) {
	const r = { _rowIndex: ++rowNo };
	for (const h of HEADERS) r[h] = "";
	return Object.assign(r, fields);
}
const toValues = (rows) => [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] || ""))];

// Pat Percent — percentage-paid (20%). Every one of A, B, C moves her money.
const PAT = [
	row({ "Load ID": "#1001", Driver: "Pat Percent", "Job Status": "Delivered", "Pickup Appointment": "9/21/2026 8:00", "Drop-off Appointment": "9/22/2026 10:00", "Status Update Date": "9/22/2026 14:00:00", "Completion Date": "9/22/2026 14:00:00", "  Payment  ": " $ 1,000.00 " }),
	// B: the same load, the other spelling (the second rate-con email).
	row({ "Load ID": "1001", Driver: "Pat Percent", "Job Status": "Delivered", "Pickup Appointment": "9/21/2026 8:00", "Drop-off Appointment": "9/22/2026 10:00", "Status Update Date": "9/22/2026 14:05:00", "Completion Date": "9/22/2026 14:05:00", "  Payment  ": " $ 1,000.00 " }),
	// C: 2025 history, no Status Update Date, no Completion Date.
	row({ "Load ID": "1002", Driver: "Pat Percent", "Job Status": "Completed", "Pickup Appointment": "5/14/25 08:30-09:00", "Drop-off Appointment": "5/14/25 07:00-15:30", "  Payment  ": " $ 700.00 " }),
	// A: soft-deleted as "3001" by the route; the sheet spells it "#3001".
	row({ "Load ID": "#3001", Driver: "Pat Percent", "Job Status": "Delivered", "Pickup Appointment": "9/22/2026 8:00", "Drop-off Appointment": "9/23/2026 8:00", "Status Update Date": "9/23/2026 9:00:00", "Completion Date": "9/23/2026 9:00:00", "  Payment  ": " $ 500.00 " }),
	// A (stored side): deleted_loads holds "#3002"; the sheet spells it "3002".
	row({ "Load ID": "3002", Driver: "Pat Percent", "Job Status": "Delivered", "Status Update Date": "9/23/2026 9:30:00", "  Payment  ": " $ 450.00 " }),
	// C, fallback: Status Update Date blank, Completion Date set — same fact, billed.
	row({ "Load ID": "1004", Driver: "Pat Percent", "Job Status": "Delivered", "Pickup Appointment": "9/23/2026 7:00", "Drop-off Appointment": "9/24/2026 7:00", "Completion Date": "9/24/2026 11:00:00", "  Payment  ": " $ 300.00 " }),
	// C, in-week miss: no completion date, but scheduled in this week → NOT billed, flagged.
	row({ "Load ID": "1005", Driver: "Pat Percent", "Job Status": "Delivered", "Pickup Appointment": "9/23/2026 7:00", "Drop-off Appointment": "9/24/2026 7:00", "  Payment  ": " $ 400.00 " }),
	// Completed in the PREVIOUS week — belongs there, not here.
	row({ "Load ID": "1006", Driver: "Pat Percent", "Job Status": "Delivered", "Status Update Date": "9/12/2026 10:00:00", "  Payment  ": " $ 999.00 " }),
	// Not completed.
	row({ "Load ID": "1007", Driver: "Pat Percent", "Job Status": "In Transit", "Status Update Date": "9/22/2026 10:00:00", "  Payment  ": " $ 888.00 " }),
];
// Dee Dayrate — $300/day. Money is window-clipped, so only the load LIST moves.
const DEE = [
	row({ "Load ID": "#2001", Driver: "Dee Dayrate", "Job Status": "Delivered", "Pickup Appointment": "9/20/2026 8:00", "Drop-off Appointment": "9/21/2026 16:00", "Status Update Date": "9/21/2026 18:00:00", "  Payment  ": " $ 1,200.00 " }),
	row({ "Load ID": "2001", Driver: "Dee  Dayrate", "Job Status": "Delivered", "Pickup Appointment": "9/20/2026 8:00", "Drop-off Appointment": "9/21/2026 16:00", "Status Update Date": "9/21/2026 18:01:00", "  Payment  ": " $ 1,200.00 " }),
	row({ "Load ID": "2002", Driver: "Dee Dayrate", "Job Status": "Completed", "Pickup Appointment": "5/15/25", "Drop-off Appointment": "5/16/25, 06:00-18:00", "  Payment  ": " $ 650.00 " }),
];
// Lee Legacy — ONLY undated history (the weekly $0 Draft / false-alarm shape).
const LEE = [
	row({ "Load ID": "#4001", Driver: "Lee Legacy", "Job Status": "Completed", "Pickup Appointment": "5/16/25", "Drop-off Appointment": "5/16/25", "  Payment  ": " $ 800.00 " }),
	row({ "Load ID": "4001", Driver: "Lee Legacy", "Job Status": "Completed", "Pickup Appointment": "5/16/25", "Drop-off Appointment": "5/16/25", "  Payment  ": " $ 800.00 " }),
];
// Sam Deleted — whose ONLY in-week load is the soft-deleted "#3001" copy.
const SAM = [
	row({ "Load ID": "#3001", Driver: "Sam Deleted", "Job Status": "Delivered", "Status Update Date": "9/23/2026 9:00:00", "  Payment  ": " $ 500.00 " }),
];
// Load 5001: a live dated copy AND an undated copy — billed once, not "missing".
const MIX = [
	row({ "Load ID": "#5001", Driver: "Pat Percent", "Job Status": "Completed" }),
	row({ "Load ID": "5001", Driver: "Pat Percent", "Job Status": "Delivered", "Status Update Date": "9/19/2026 06:00:00", "  Payment  ": " $ 100.00 " }),
];
// Ivy Inweek — her ONLY load this week was marked Delivered with no date stamped
// (a direct sheet edit). Not billed — but the 400 she sees in the app names it.
const IVY = [
	row({ "Load ID": "6001", Driver: "Ivy Inweek", "Job Status": "Delivered", "Pickup Appointment": "9/22/2026 9:00", "Drop-off Appointment": "9/22/2026 17:00", "  Payment  ": " $ 900.00 " }),
];
// Ken Former — NOT on the roster, only undated 2025 history. The production shape
// behind the weekly "WORKED-BUT-UNBILLED (kenrick davis)" alarm and its retries.
const KEN = [
	row({ "Load ID": "7001", Driver: "Ken Former", "Job Status": "Completed", "Pickup Appointment": "5/16/2025", "Drop-off Appointment": "5/16/2025", "  Payment  ": " $ 750.00 " }),
];
const ALL = [...PAT, ...DEE, ...LEE, ...SAM, ...MIX, ...IVY, ...KEN];

// ---------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
const ids = (rows) => rows.map((r) => r["Load ID"]);
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`ok    ${label}`); return true; }
	fail++; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
	console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
	return false;
}
function section(t) { console.log(`\n${t}`); }

// Each check is a function of an IMPLEMENTATION so §6 can re-run it on the old code.
// Returns [label, actual, expected] triples.
function checksA_kpi(impl) {
	const rows = [
		{ "Load ID": "#3001", "Job Status": "Delivered" },
		{ "Load ID": " #3001 ", "Job Status": "Delivered" },
		{ "Load ID": "3001", "Job Status": "Delivered" },
		{ "Load ID": "3002", "Job Status": "Delivered" },
		{ "Load ID": "#3002", "Job Status": "Delivered" },
		{ "Load ID": "3003", "Job Status": "Delivered" },
		{ "Load ID": "3004", "Job Status": "Cancelled" },
	];
	const kept = impl.excludeDroppedLoads(rows, ["Load ID", "Job Status"]).map((r) => r["Load ID"]);
	return [
		["A/KPI: a soft-deleted load is dropped in EVERY spelling (#3001, ' #3001 ', 3001)", kept.filter((k) => /3001/.test(k)), []],
		["A/KPI: a hand-inserted '#3002' tombstone drops both spellings of 3002", kept.filter((k) => /3002/.test(k)), []],
		["A/KPI: a live load and the cancelled rule are untouched", kept, ["3003"]],
	];
}
function checksInvoice(impl) {
	const pat = impl.select(ALL, HEADERS, "Pat Percent", WS, WE);
	const dee = impl.select(ALL, HEADERS, "dee dayrate", WS, WE);
	const lee = impl.select(ALL, HEADERS, "Lee Legacy", WS, WE);
	const sam = impl.select(ALL, HEADERS, "Sam Deleted", WS, WE);
	const patIds = ids(pat);
	return [
		["A/invoice: the soft-deleted '#3001' copy is not billed", patIds.filter((x) => /3001/.test(x)), []],
		["A/invoice: a load tombstoned as '#3002' is not billed as '3002'", patIds.filter((x) => /3002/.test(x)), []],
		["A/invoice: a driver whose only load is soft-deleted bills nothing", ids(sam), []],
		["B: '#1001' and '1001' are ONE load (the last row wins)", patIds.filter((x) => /1001/.test(x)), ["1001"]],
		["B: '#2001' and '2001' are ONE load for the day-rate driver too", ids(dee).filter((x) => /2001/.test(x)), ["2001"]],
		["C: 2025 history with no completion date is not billed this week", patIds.filter((x) => x === "1002"), []],
		["C: an undated load scheduled in this week is not billed either", patIds.filter((x) => x === "1005"), []],
		["C: a driver with ONLY undated rows bills nothing", ids(lee), []],
		["C: Completion Date stands in for a blank Status Update Date", patIds.filter((x) => x === "1004"), ["1004"]],
		["week: a load completed last week stays in last week", patIds.filter((x) => x === "1006"), []],
		["exact set billed for the percentage driver", patIds, ["1001", "1004", "5001"]],
	];
}
function checksVerifier(impl) {
	const got = [...impl.verifier(ALL, HEADERS, WS, WE)].sort();
	return [
		["verifier: Lee Legacy (only undated rows) is NOT 'worked this week'", got.includes("lee legacy"), false],
		["verifier: Sam Deleted (only a soft-deleted '#3001') is NOT 'worked this week'", got.includes("sam deleted"), false],
		["verifier: exactly the drivers the handler bills", got, ["dee dayrate", "pat percent"]],
	];
}
function run(checks) { for (const [label, actual, expected] of checks) eq(actual, expected, label); }
function countFailures(checks) { return checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).length; }

// The NEW implementation, lifted.
function newImpl(db) {
	const w = buildWorld(db);
	return {
		w,
		excludeDroppedLoads: w.excludeDroppedLoads,
		select: (data, headers, name, ws, we) => w.selectInvoiceWeekLoads(data, headers, name, ws, we, w.loadKeySet(w.getDeletedLoadIds())).loads,
		verifier: w.driversWithCompletedLoadsInWeek,
	};
}
// The PRE-FIX implementation, run against the same lifted helpers.
function oldImpl(db) {
	const w = buildWorld(db);
	const o = buildOld(w);
	return {
		w,
		excludeDroppedLoads: o.OLD_excludeDroppedLoads,
		select: (data, headers, name, ws, we) => o.OLD_selectLoads(data, headers, name, ws, we, w.getDeletedLoadIds()),
		verifier: o.OLD_driversWithCompletedLoadsInWeek,
	};
}

(async () => {
	// ============================================================ 0. the key
	section("0. normalizeLoadId() IS the delete route's rule");
	for (const raw of ["#540935268", "540935268", " #ABC-12 ", "abc", "##7", "# 5", ""]) {
		const trimmed = raw.trim();
		eq(normalizeLoadId(raw), trimmed.toLowerCase().replace(/^#/, ""), `normalizeLoadId(${JSON.stringify(raw)}) matches rawId.trim().toLowerCase().replace(/^#/, "")`);
	}

	// ============================================================ 1. KPI path
	section("1. excludeDroppedLoads() — A on the dashboard / investor / financials path");
	run(checksA_kpi(newImpl(freshDb())));

	// ============================================================ 2. invoice selection
	section("2. selectInvoiceWeekLoads() — A, B, C on the weekly invoice");
	const N = newImpl(freshDb());
	run(checksInvoice(N));
	{
		const pat = N.w.selectInvoiceWeekLoads(ALL, HEADERS, "Pat Percent", WS, WE, N.w.loadKeySet(N.w.getDeletedLoadIds()));
		const und = pat.undated.map((u) => [u.loadId, u.scheduledInWeek]);
		eq(und, [["1002", false], ["1005", true]], "undated rows are REPORTED, flagged when scheduled in this week");
		eq(pat.undated.some((u) => /5001/.test(u.loadId)), false, "an undated copy of a load that another copy dates is not reported as missing");
		const warn = N.w.invoiceWeekWarnings(pat.undated);
		eq(warn.length, 2, "two warnings: the in-week miss and the history");
		eq(/^NOT BILLED: 1005 /.test(warn[0]), true, "the in-week miss leads, naming the load");
		eq(/1 completed load scheduled outside this week has no Status Update Date or Completion Date.*: 1002\.$/.test(warn[1]), true, "the history is listed");
		const many = Array.from({ length: 13 }, (_, i) => ({ loadId: String(9000 + i), scheduledInWeek: false }));
		eq(/9009, and 3 more\.$/.test(N.w.invoiceWeekWarnings(many)[0]), true, "a long history is capped at ten ids");
		eq(N.w.invoiceWeekVerdict(PAT[0], N.w.invoiceWeekColumns(HEADERS), WS, WE, new Set()), "bill", "verdict: in-week completion bills");
		eq(N.w.invoiceWeekVerdict(PAT[2], N.w.invoiceWeekColumns(HEADERS), WS, WE, new Set()), "undated", "verdict: no completion date is 'undated', not 'bill'");
		eq(N.w.invoiceWeekVerdict(PAT[3], N.w.invoiceWeekColumns(HEADERS), WS, WE, N.w.loadKeySet(["3001"])), "deleted", "verdict: '#3001' against a '3001' tombstone is 'deleted'");
		// Production's header order resolves Status Update Date, then Completion Date as the fallback.
		const cols = N.w.invoiceWeekColumns(HEADERS);
		eq([cols.dateCol, cols.fallbackDateCol, cols.statusCol, cols.pickupCol, cols.dropoffCol],
			["Status Update Date", "Completion Date", "Job Status", "Pickup Appointment", "Drop-off Appointment"],
			"columns resolve exactly as the handler always did on production's header row");
	}

	// ============================================================ 3. verifier
	section("3. driversWithCompletedLoadsInWeek() — the batch's coverage check agrees");
	run(checksVerifier(N));

	// ============================================================ 4. whole handler
	section("4. generateInvoiceHandler — end to end on an in-memory database");
	async function generate(driver) {
		const db = freshDb();
		const w = buildWorld(db, { sheetValues: toValues(ALL) });
		let statusCode = 200, body = null;
		const res = { status(c) { statusCode = c; return this; }, json(o) { body = o; return this; } };
		await w.generateInvoiceHandler({ session: { user: { role: "Super Admin", username: "test" } }, body: { driver, weekEnd: WEEK_END_PARAM } }, res);
		const inv = db.prepare("SELECT * FROM invoices").get() || null;
		return { statusCode, body, inv, rendered: w.rendered };
	}
	const handlerChecks = async (gen) => {
		const pat = await gen("Pat Percent");
		const dee = await gen("Dee Dayrate");
		const lee = await gen("Lee Legacy");
		const ivy = await gen("Ivy Inweek");
		const patData = pat.rendered[0] ? pat.rendered[0].data : {};
		const deeDays = dee.rendered[0] ? dee.rendered[0].data.days : {};
		return [
			["handler: the percentage invoice is generated", pat.statusCode, 200],
			// 1001 ($1,000, once) + 1004 ($300) + 5001 ($100) = $1,400 gross → 20% = $280.
			["handler: percentage gross revenue counts each load ONCE and nothing undated/deleted", patData.grossRevenue, 1400],
			["handler: percentage pay = 20% of $1,400", pat.inv && pat.inv.total_earnings, 280],
			["handler: the stored load list", pat.inv && JSON.parse(pat.inv.load_ids), ["1001", "1004", "5001"]],
			["handler: the in-week undated miss is returned for the batch", pat.body && pat.body.undatedInWeek, ["1005"]],
			["handler: warnings ride on the success response", pat.body && Array.isArray(pat.body.warnings) && pat.body.warnings.length, 2],
			// Dee: Sun 09-20 and Mon 09-21 at $300 — unchanged money, one load on the invoice.
			["handler: day-rate pay is unchanged (2 days × $300)", dee.inv && dee.inv.total_earnings, 600],
			["handler: the day-rate invoice lists the load once", dee.inv && JSON.parse(dee.inv.load_ids), ["2001"]],
			["handler: the BoL grid names it once", [deeDays.Sunday && deeDays.Sunday.loadBol, deeDays.Monday && deeDays.Monday.loadBol], ["2001", "2001"]],
			// Lee: history only → no $0 Draft, a 400 that says why.
			["handler: a driver with only undated history gets 400, not a $0 Draft", [lee.statusCode, !!lee.inv], [400, false]],
			// "#4001" and "4001" are one load, so ONE id is reported — the last row's spelling.
			["handler: …and the 400 carries the warning", lee.body && Array.isArray(lee.body.warnings) && /no weekly invoice bills it: 4001\.$/.test(lee.body.warnings[0] || ""), true],
			["handler: …while its error stays the plain one (history is not actionable this week)", lee.body && lee.body.error, "No completed loads found for this week"],
			// Ivy: the only load is undated but scheduled this week → not billed, and SAID so.
			["handler: an undated load worked this week is not billed", [ivy.statusCode, !!ivy.inv], [400, false]],
			["handler: …the app's error names it", /^No completed loads with a completion date this week — 6001 is marked completed but has no Status Update Date\./.test((ivy.body && ivy.body.error) || ""), true],
			["handler: …and the batch is handed it to escalate", ivy.body && ivy.body.undatedInWeek, ["6001"]],
		];
	};
	run(await handlerChecks(generate));
	{
		// No date column at all: the old filter billed every completed load ever. Now a loud 500.
		const db = freshDb();
		// Careful: "Status Update …" still matches /date/i through "upDATE", so the
		// renamed headers must lose the substring entirely.
		const noDate = HEADERS.map((h) => ({ "Assigned Date": "Assigned At", "Status Update Date": "Status Changed At", "Completion Date": "Finished At" }[h] || h));
		if (noDate.some((h) => /date/i.test(h))) throw new Error("fixture still has a /date/i header");
		const w = buildWorld(db, { sheetValues: [noDate, ...PAT.map((r) => HEADERS.map((h) => r[h] || ""))] });
		let statusCode = 200, body = null;
		await w.generateInvoiceHandler({ session: { user: { role: "Super Admin", username: "t" } }, body: { driver: "Pat Percent", weekEnd: WEEK_END_PARAM } },
			{ status(c) { statusCode = c; return this; }, json(o) { body = o; return this; } });
		eq([statusCode, body && body.code, !!db.prepare("SELECT 1 FROM invoices").get()], [500, "INVOICE_WEEK_DATE_UNRESOLVED", false],
			"handler: a sheet with no date column refuses loudly instead of billing everything");
	}

	// ============================================================ 4a. who may generate
	section("4a. Only a Super Admin, or a Driver for themselves, may generate an invoice");
	// The route mounts requireAuth only; the handler is the gate. It used to name
	// only the Driver role, so a Dispatcher or an Investor could mint any driver's
	// Draft and read back the row — pay, loads and render_data (address, bank).
	async function generateAs(user, bodyDriver, src) {
		const db = freshDb();
		const w = buildWorld(db, { sheetValues: toValues(ALL), src });
		let statusCode = 200, body = null;
		await w.generateInvoiceHandler({ session: { user }, body: { driver: bodyDriver, weekEnd: WEEK_END_PARAM } },
			{ status(c) { statusCode = c; return this; }, json(o) { body = o; return this; } });
		return { statusCode, body, inv: db.prepare("SELECT * FROM invoices").get() || null };
	}
	const authChecks = async (src) => {
		const disp = await generateAs({ role: "Dispatcher", username: "d" }, "Pat Percent", src);
		const inv = await generateAs({ role: "Investor", username: "i" }, "Pat Percent", src);
		const other = await generateAs({ role: "Driver", username: "dd", driverName: "Dee Dayrate" }, "Pat Percent", src);
		const self = await generateAs({ role: "Driver", username: "pp", driverName: "Pat Percent" }, "", src);
		return [
			["auth: a Dispatcher is refused and nothing is written", [disp.statusCode, !!disp.inv], [403, false]],
			["auth: an Investor is refused, and never sees the driver's bank", [inv.statusCode, !!inv.inv, JSON.stringify(inv.body || {}).includes("First Test Bank")], [403, false, false]],
			["auth: a Driver naming someone else still gets only their OWN invoice", other.inv && other.inv.driver, "dee dayrate"],
			["auth: a Driver may generate their own", [self.statusCode, self.inv && self.inv.driver], [200, "pat percent"]],
		];
	};
	run(await authChecks());

	// ============================================================ 4b. the Friday batch
	section("4b. runWeeklyInvoiceBatch — the Friday run, for real (captured notification + email)");
	async function runBatch(opts = {}) {
		const db = freshDb();
		const w = buildWorld(db, { sheetValues: toValues(ALL), ...opts });
		const result = await w.runWeeklyInvoiceBatch(WEEK_END_PARAM, 1);
		return {
			result,
			marker: db.prepare("SELECT * FROM invoice_autogen_runs WHERE week_end = ?").get(WEEK_END_PARAM) || {},
			invoices: db.prepare("SELECT driver, status, total_earnings FROM invoices ORDER BY driver").all().map((i) => [i.driver, i.status, i.total_earnings]),
			notes: w.notes, emails: w.emails,
		};
	}
	const batchChecks = (b) => [
		["batch: Pat and Dee are generated AND submitted, at the fixed amounts", b.invoices, [["dee dayrate", "Submitted", 600], ["pat percent", "Submitted", 280]]],
		["batch: no $0 Draft for a driver with only undated history (Lee Legacy)", /ZERO-PAY/.test(b.marker.summary || ""), false],
		["batch: no WORKED-BUT-UNBILLED for off-roster history (Ken Former), so no retry", [b.result && b.result.problem, b.marker.failed], [false, 0]],
		["batch: undated in-week loads are escalated, roster AND off-roster",
			/UNDATED completed loads NOT billed \(Pat Percent: 1005; Ivy Inweek \(not on the roster\): 6001\)/.test(b.marker.summary || ""), true],
		["batch: …once, as ACTION NEEDED, in the notification and the email",
			[b.notes.length, /ACTION NEEDED/.test((b.notes[0] || [])[1] || ""), b.emails.length, /NOT billed — no Status Update Date or Completion Date:<\/b> Pat Percent: 1005; Ivy Inweek \(not on the roster\): 6001\./.test((b.emails[0] || {}).html || "")],
			[1, true, 1, true]],
	];
	run(batchChecks(await runBatch()));

	// ============================================================ 5. source pins
	section("5. Source pins — every reader goes through the shared helpers");
	const handlerSrc = liftAsyncFn(SRC, "generateInvoiceHandler");
	const verifierSrc = liftFn(SRC, "driversWithCompletedLoadsInWeek");
	const excludeSrc = liftFn(SRC, "excludeDroppedLoads");
	const batchSrc = liftAsyncFn(SRC, "runWeeklyInvoiceBatch");
	const deleteRoute = SRC.slice(SRC.indexOf('app.delete("/api/loads/:loadId"'), SRC.indexOf('app.delete("/api/loads/:loadId"') + 6000);
	eq(SRC.split('const { normalizeLoadId } = require("./lib/ratecon-load");').length - 1, 1, "server.js imports THE key from lib/ratecon-load, once");
	eq(/function normalizeLoadId\(|const normalizeLoadId = /.test(SRC), false, "no second definition of normalizeLoadId in server.js");
	// Counted as CALLS — the comments name the function too.
	eq((handlerSrc.match(/= selectInvoiceWeekLoads\(data, headers, driverName, weekStart, computedWeekEnd, loadKeySet\(getDeletedLoadIds\(\)\)\)/g) || []).length, 1,
		"the handler selects its loads through selectInvoiceWeekLoads(), with the normalized tombstones");
	eq(/deletedIds\.has|loadMap|toLowerCase\(\)\s*;?\s*\n?\s*if \(lidLc/.test(handlerSrc), false, "the handler keeps no private deleted/dedupe logic");
	eq(/return true; \/\/ no date\? include/.test(SRC), false, "'no date? include to be safe' is gone");
	eq(verifierSrc.includes("invoiceWeekVerdict(") && !verifierSrc.includes("sheetDayKey("), true, "the verifier asks the shared verdict and parses no date itself");
	eq(excludeSrc.includes("normalizeLoadId(r[loadIdCol])") && excludeSrc.includes("loadKeySet("), true, "excludeDroppedLoads() normalizes both sides");
	eq(/const lid = normalizeLoadId\(rawId\);/.test(deleteRoute) && /normalizeLoadId\(r\[cols\.loadIdCol\]\) === lid/.test(deleteRoute), true,
		"DELETE /api/loads/:loadId keys the tombstone and its guard with normalizeLoadId()");
	eq(batchSrc.includes("body.undatedInWeek") && /needsAttention = [^;]*undatedInWeek\.length > 0/.test(batchSrc), true,
		"the batch escalates undatedInWeek as ACTION NEEDED");
	eq(/const problem = unbilled\.length > 0;/.test(batchSrc), true, "…and does NOT retry on it (the retry signal is unchanged)");

	// ============================================================ 6. discrimination
	section("6. DISCRIMINATION — the pre-fix code must FAIL these assertions");
	const O = oldImpl(freshDb());
	const oldA = countFailures(checksA_kpi(O));
	const oldInv = checksInvoice(O);
	const oldVer = countFailures(checksVerifier(O));
	const failedLabels = (checks) => checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).map(([l]) => l);
	const oldInvFailed = failedLabels(oldInv);
	console.log(`   old excludeDroppedLoads fails ${oldA}/3; old invoice filter fails ${oldInvFailed.length}/${oldInv.length}; old verifier fails ${oldVer}/3`);
	eq(oldA > 0, true, "A: the old excludeDroppedLoads() keeps a soft-deleted '#X' row");
	eq(oldInvFailed.some((l) => l.startsWith("A/")), true, "A: the old invoice filter bills a soft-deleted '#X' row");
	eq(oldInvFailed.some((l) => l.startsWith("B:")), true, "B: the old invoice dedupe bills '#X' and 'X' twice");
	eq(oldInvFailed.some((l) => l.startsWith("C:")), true, "C: the old invoice filter bills an undated row in this week");
	eq(oldVer > 0, true, "C: the old verifier counts undated history as 'worked this week'");
	// The whole handler with ONLY the selection swapped back to the pre-fix code —
	// everything else byte-identical — pays the percentage driver the old amount.
	{
		const db = freshDb();
		const probe = buildWorld(db);
		const o = buildOld(probe);
		const shim = (data, headers, name, ws, we) => ({
			cols: probe.invoiceWeekColumns(headers),
			loads: o.OLD_selectLoads(data, headers, name, ws, we, probe.getDeletedLoadIds()),
			undated: [],
		});
		const genOld = async (driver) => {
			const d2 = freshDb();
			const w = buildWorld(d2, { sheetValues: toValues(ALL), overrides: { selectInvoiceWeekLoads: shim } });
			let statusCode = 200, body = null;
			await w.generateInvoiceHandler({ session: { user: { role: "Super Admin", username: "test" } }, body: { driver, weekEnd: WEEK_END_PARAM } },
				{ status(c) { statusCode = c; return this; }, json(o2) { body = o2; return this; } });
			return { statusCode, body, inv: d2.prepare("SELECT * FROM invoices").get() || null, rendered: w.rendered };
		};
		const oldHandler = await handlerChecks(genOld);
		const oldHandlerFailed = failedLabels(oldHandler);
		const oldPat = await genOld("Pat Percent");
		const oldLee = await genOld("Lee Legacy");
		console.log(`   pre-fix selection inside the real handler: Pat Percent paid $${oldPat.inv && oldPat.inv.total_earnings} on $${oldPat.rendered[0] && oldPat.rendered[0].data.grossRevenue} gross (fixed: $280 on $1,400); Lee Legacy → ${oldLee.statusCode} with a $${oldLee.inv && oldLee.inv.total_earnings} invoice`);
		eq(oldHandlerFailed.includes("handler: percentage pay = 20% of $1,400"), true, "the pre-fix selection OVERPAYS the percentage driver");
		eq(oldHandlerFailed.includes("handler: a driver with only undated history gets 400, not a $0 Draft"), true, "the pre-fix selection mints the weekly $0 Draft");
		eq(oldHandlerFailed.includes("handler: day-rate pay is unchanged (2 days × $300)"), false, "…and pays the day-rate driver the same, which is why this went unnoticed");

		// The Friday batch with the pre-fix selection AND the pre-fix coverage check:
		// production's weekly shape — a $0 Draft, a WORKED-BUT-UNBILLED retry, no escalation.
		const oldBatch = await runBatch({ overrides: { selectInvoiceWeekLoads: shim, driversWithCompletedLoadsInWeek: o.OLD_driversWithCompletedLoadsInWeek } });
		const oldBatchFailed = failedLabels(batchChecks(oldBatch));
		console.log(`   pre-fix batch: ${oldBatch.marker.summary}`);
		eq(oldBatchFailed.includes("batch: no $0 Draft for a driver with only undated history (Lee Legacy)"), true, "the pre-fix batch leaves the weekly $0 Draft");
		eq(oldBatchFailed.includes("batch: no WORKED-BUT-UNBILLED for off-roster history (Ken Former), so no retry"), true, "the pre-fix batch raises the weekly false WORKED-BUT-UNBILLED and retries");
		eq(oldBatchFailed.includes("batch: Pat and Dee are generated AND submitted, at the fixed amounts"), true, "the pre-fix batch auto-SUBMITS the percentage overpayment");
	}

	// The authorization gate, removed: a Dispatcher mints the Draft and an Investor
	// reads the driver's bank back out of render_data.
	{
		const noGate = SRC.replace('if (user.role !== "Super Admin" && user.role !== "Driver") {', "if (false) {");
		if (noGate === SRC) throw new Error("mutant anchor not found: auth gate");
		const failed = failedLabels(await authChecks(noGate));
		const leak = await generateAs({ role: "Investor", username: "i" }, "Pat Percent", noGate);
		eq(failed.includes("auth: a Dispatcher is refused and nothing is written") && failed.includes("auth: an Investor is refused, and never sees the driver's bank"), true,
			"MUTANT M4: without the gate a Dispatcher and an Investor both generate");
		eq([leak.statusCode, JSON.parse((leak.body && leak.body.invoice && leak.body.invoice.render_data) || "{}").bankOnFile], [200, "First Test Bank"],
			"MUTANT M4: …and the Investor reads the driver's bank name back (the leak the gate closes)");
	}
	{
		// M5 — drop the off-roster half of the batch escalation.
		const src = SRC.replace("if (ids.length) undatedInWeek.push(`${display} (not on the roster): ${ids.join(\", \")}`);", "");
		if (src === SRC) throw new Error("mutant anchor not found: M5");
		const b = await runBatch({ src });
		eq(failedLabels(batchChecks(b)).includes("batch: undated in-week loads are escalated, roster AND off-roster"), true,
			"MUTANT M5: without the snapshot scan, an off-roster driver's undated load goes unreported");
	}

	// Mutants of the LIFTED code: each defangs one rule and must flip an assertion.
	const mutate = (from, to, label) => {
		if (!SRC.includes(from)) throw new Error(`mutant anchor not found: ${label}`);
		return SRC.replace(from, to);
	};
	const mutantImpl = (src) => {
		const w = buildWorld(freshDb(), { src });
		return {
			w, excludeDroppedLoads: w.excludeDroppedLoads, verifier: w.driversWithCompletedLoadsInWeek,
			select: (data, headers, name, ws, we) => w.selectInvoiceWeekLoads(data, headers, name, ws, we, w.loadKeySet(w.getDeletedLoadIds())).loads,
		};
	};
	{
		// M1 — dedupe on the raw cell again (B).
		const m = mutantImpl(mutate(
			"const key = (cols.loadIdCol && normalizeLoadId(row[cols.loadIdCol])) || `_row_${row._rowIndex}`;",
			"const key = (cols.loadIdCol && String(row[cols.loadIdCol] || \"\")) || `_row_${row._rowIndex}`;",
			"M1"));
		eq(failedLabels(checksInvoice(m)).some((l) => l.startsWith("B:")), true, "MUTANT M1: keying the dedupe on raw text double-bills '#X'/'X'");
	}
	{
		// M2 — "no date? include to be safe" again (C).
		const m = mutantImpl(mutate(
			'if (!day) return "undated";',
			'if (!day) return "bill";',
			"M2"));
		eq(failedLabels(checksInvoice(m)).some((l) => l.startsWith("C:")), true, "MUTANT M2: treating an undated row as in-week bills history every week");
		eq(countFailures(checksVerifier(m)) > 0, true, "MUTANT M2: …and the verifier inherits it, because it shares the verdict");
	}
	{
		// M3 — the stored side of the tombstone left raw (A, hand-inserted '#3002').
		const m = mutantImpl(mutate(
			"const key = normalizeLoadId(id);\n\t\tif (key) out.add(key);",
			"const key = String(id || \"\").trim().toLowerCase();\n\t\tif (key) out.add(key);",
			"M3"));
		eq(countFailures(checksA_kpi(m)) > 0 && failedLabels(checksInvoice(m)).some((l) => l.startsWith("A/")), true,
			"MUTANT M3: an un-normalized tombstone set misses '3002' on both paths");
	}

	// -------------------------------------------------------------------- report
	console.log(`\n${"-".repeat(60)}`);
	if (fail) {
		console.log(`FAILED — ${pass} passed, ${fail} failed\n`);
		failures.forEach((f) => console.log(`  ${f}`));
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})().catch((e) => { console.error("FAIL  runner crashed:", e && e.stack || e); process.exit(1); });
