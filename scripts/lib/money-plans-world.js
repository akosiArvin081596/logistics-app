// The shared world for the money-lane plan runners of 2026-10-15
// (scripts/pending/test-*.js): Mark Paid in a closed month, the month-end
// loops on the server clock, the invoice week counted in two months'
// Financials driver table, and the blank Pickup Appointment.
//
// It starts scripts/lib/work-days-world.js's world (the weekly invoice, the
// investor view and the payout ledger, lifted out of server.js on one
// in-memory SQLite, with one Job Tracking sheet and a clock the test can move)
// and lifts a second closure onto the SAME database, sheet and clock with the
// routes these plans need:
//
//   GET  /api/financials                 the Financials page (month detail)
//   PUT  /api/invoices/:id/approve       Mark Paid (and approve / processing)
//   PUT  /api/invoices/:id/revert        undo of a paid stamp
//   GET  /api/admin/period-lock-issues   the Data Issues queue
//   truckBilledMonthCount()              the all-time fixed-cost month count
//   writeLedgerFreeze()                  a closed month's frozen line items
//
// Unlike work-days-world, logAudit() is the server's own (audit_trail rows are
// what a plan asserts), and sendEmail() records each call instead of sending.
//
// Every fixture is made up. Pure: no server, no app.db, no network.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const W = require("./work-days-world");
const { closure } = require("./server-lift");

const SRC = W.SRC;
const LINES = SRC.split("\n");
function routeHead(method, p) {
	const heads = LINES.filter((l) => l.startsWith(`app.${method}(${JSON.stringify(p)},`));
	if (heads.length !== 1) throw new Error(`expected one registration of ${method.toUpperCase()} ${p} in server.js, found ${heads.length}`);
	return heads[0];
}
const ROUTES = [
	["get", "/api/financials"],
	["put", "/api/invoices/:id/approve"],
	["put", "/api/invoices/:id/revert"],
	["get", "/api/admin/period-lock-issues"],
];
const ROOTS = ["truckBilledMonthCount", "appDay", "buildFinancialsLedger", "writeLedgerFreeze", "computeInvestorMonthlyEarnings", "parseSheet", "deduplicateLoads"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs",
	"DATA_DIR", "fetch", "io", "sendEmail", "periodIssueLimiter"];
let LIFTED = null;
function lifted() {
	if (!LIFTED) {
		LIFTED = closure(SRC, {
			roots: ROOTS, routes: ROUTES.map(([m, p]) => routeHead(m, p)), provided: PROVIDED,
			denied: ["server", "transporter", "getDrive", "KEY_FILE"],
		});
	}
	return LIFTED;
}

// work-days-world's world, plus this file's routes on the same database,
// sheet and clock. world.extra holds { truckBilledMonthCount, appDay,
// buildFinancialsLedger, writeLedgerFreeze, computeInvestorMonthlyEarnings },
// world.extraRoutes the lifted handlers,
// world.emails each sendEmail() call.
function startWorld(opts = {}) {
	const world = W.startWorld(opts);
	const L = lifted();
	const clock = world.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	world.extraRoutes = {};
	world.emails = [];
	world.changes = [];
	const register = (method) => (p, ...h) => { world.extraRoutes[`${method} ${p}`] = h[h.length - 1]; };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const quiet = { log() {}, info() {}, error() {}, warn: (...a) => world.warnings.push(a.join(" ")) };
	const sheetValues = () => W.sheetValues(world.rows);
	const deps = {
		db: world.db,
		require: createRequire(path.join(W.ROOT, "server.js")),
		console: quiet,
		process: { env: { ...(opts.env || {}) }, argv: [], cwd: () => W.ROOT, pid: 4243 },
		__dirname: W.ROOT,
		Date: FixedDate,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass,
		requireAuth: pass(),
		refuseCrossOrigin: pass(),
		periodIssueLimiter: pass(),
		notifyChange: (d) => world.changes.push(d),
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheetValues() } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: async () => Buffer.from("%PDF-stub"),
		fs: { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "", writeFileSync: () => {}, renameSync: () => {}, unlinkSync: () => {} },
		DATA_DIR: "/nonexistent-money-plans",
		fetch: () => { throw new Error("no network in a test"); },
		io: null,
		sendEmail: async (to, subject) => { world.emails.push({ to, subject }); },
	};
	const body = [
		'"use strict";',
		L.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		"return { truckBilledMonthCount, appDay, buildFinancialsLedger, writeLedgerFreeze, computeInvestorMonthlyEarnings };",
	].join("\n");
	world.extra = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), sheetValues);
	return world;
}

const ADMIN = { session: { user: { id: 1, role: "Super Admin", username: "super_admin" } }, headers: {}, query: {}, params: {} };
// One of this file's routes, as the Super Admin.
async function route(world, key, { params = {}, query = {}, body = {} } = {}) {
	const h = world.extraRoutes[key];
	if (!h) throw new Error(`${key} is not registered in server.js`);
	return W.call(h, { ...ADMIN, params, query, body });
}

// One invoices row, inserted directly (a week the test chooses). Returns its id.
function insertInvoice(db, o) {
	const row = {
		invoice_number: "INV-T-2026W39-01", driver: "Amy Birch", week_start: "2026-09-26", week_end: "2026-10-02",
		loads_count: 5, rate_per_load: 300, total_earnings: 1500, expenses_total: 0, status: "Approved",
		load_ids: "[]", expense_ids: "[]", render_data: "{}", adjustment: 0, is_manual: 0, ...o,
	};
	const cols = Object.keys(row);
	return Number(db.prepare(`INSERT INTO invoices (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}

// A daily-rate invoice's day grid (render_data.days) for the week starting
// `weekStart` (a Saturday): `paid` lists the paid days, each at `rate`.
function dayGrid(weekStart, paid, rate, loadOf = () => "") {
	const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
	const days = {};
	GRID.forEach((n, i) => {
		const day = W.addDays(weekStart, i);
		const on = paid.includes(day);
		days[n] = { loadBol: on ? loadOf(day) : "", total: on ? rate : 0, completed: on };
	});
	return days;
}

// Closes `period` as the month-end close does, at the instant `finalizedAt`
// (work-days-world's world.lock() always stamps one fixed instant).
function lockMonth(db, period, finalizedAt) {
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', ?, 'test')").run(period, finalizedAt);
}

// Freezes a month's current Financials items as the close does (the items
// buildFinancialsLedger() holds for it now), then closes it at `finalizedAt`.
async function freezeAndLock(world, period, finalizedAt) {
	const books = await world.extra.buildFinancialsLedger();
	const items = books.items.filter((i) => i.month === period);
	world.extra.writeLedgerFreeze(period, items, { source: "close", actor: "test", frozenAt: finalizedAt });
	lockMonth(world.db, period, finalizedAt);
	return items;
}

module.exports = { ...W, startWorld, route, insertInvoice, dayGrid, lockMonth, freezeAndLock, ADMIN, liftedMoneyPlans: lifted };
