#!/usr/bin/env node
/**
 * The before-payroll check (item 241, PR 1): GET /api/admin/payroll-check
 * (Super Admin, behind PAYROLL_CHECK_ENABLED) and scripts/payroll-check.js, both
 * the server's own payrollCheck(), lifted from server.js and run on a made-up
 * fleet (scripts/lib/work-days-world.js). Written before the fix: at d5bab952
 * neither the function, the route, lib/payroll-check.js nor the script exists.
 *
 *   §1  the role gate: 401 signed out; Dispatcher, Driver, Investor, KPI Viewer
 *       403; nothing read for a refused caller; requireRole before the limiter
 *   §2  the switch: off (unset, "1", "TRUE"), a Super Admin gets 404 FEATURE_OFF
 *       before any read; exactly "true" runs the check
 *   §3  the week: a missing, malformed, impossible, non-Friday, unfinished or
 *       closed-month weekEnd is refused with 400; a finished week of an open
 *       month answers
 *   §4  ledger-paid days on no invoice, each with its reason: a cross-week day,
 *       a Delivered after the invoice, an "add" after the invoice, a week with
 *       no invoice, a blank pickup, an ELD read changed after the invoice, an
 *       investor scope with no ELD for the truck, an adjustment that may pay
 *       it, a deleted correction Draft, a closed month; days a correction Draft
 *       or a hand-made invoice's dated line holds are not listed
 *   §5  invoice-paid days the books no longer pay: a "remove" after the invoice
 *   §6  Personal lines on no invoice (a receipt driver no directory row names, a
 *       line waiting for its week's invoice); receipts still Pending
 *   §7  correction Drafts waiting; a percentage driver's load no invoice bills
 *   §8  whole cents: every amount an integer, each total the sum of its items, a
 *       $262.37 day as 26237; a day two scopes count is listed once, counted once
 *   §9  nothing written: every table as before, no sheet write, no render; the
 *       function calls no writer; the cached sheet is never changed
 *   §10 the script: --help, its refusals (exit 2), the route's answer with the
 *       switch off, its database file unchanged byte for byte
 *   §11 parameterized SQL only; the switch reads exactly "true"
 *
 * Every driver, load, truck, receipt and amount is made up.
 * Run: node scripts/test-payroll-check.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const { closure, indexDeclarations } = require("./lib/server-lift");
const { loadRow, etMs, feed } = W;

const ROUTE = "/api/admin/payroll-check";
const ROUTE_KEY = `GET ${ROUTE}`;
const LINES = W.SRC.split("\n");
const ROUTE_HEAD = LINES.find((l) => l.startsWith(`app.get(${JSON.stringify(ROUTE)},`)) || null;
const HAS_FN = /\n(?:async )?function payrollCheck\(/.test(W.SRC);
const LIB_FILE = path.join(W.ROOT, "lib", "payroll-check.js");

function requireFix() {
	const missing = [];
	if (!HAS_FN) missing.push("payrollCheck() in server.js");
	if (!ROUTE_HEAD) missing.push(`GET ${ROUTE} in server.js`);
	if (!fs.existsSync(LIB_FILE)) missing.push("lib/payroll-check.js");
	if (missing.length) throw new Error(`not built yet: ${missing.join(", ")}`);
}

// ── the made-up fleet ─────────────────────────────────────────────────────────
const ADA = "Ada Quill";
const BRAM = "Bram Toft";
const CYD = "Cyd Marr";
const DAX = "Dax Penn";
const ELI = "Eli Rusk";
const FAY = "Fay Lorn";
const GUS = "Gus Hale"; // a percentage driver
const HAL = "Hal Brin";
const IVO = "Ivo Senn";
const JO = "Jo Kade";
const KIT = "Kit Moss";
const LU = "Lu Penn";
const MO = "Mo Reyes";
const NED = "Ned Ruiz";
const PAT = "Pat Voss"; // $262.37 a day
const GIL = "Gil Varn"; // a receipt's driver no Drivers Database row names

const ENV = { PAYROLL_CHECK_ENABLED: "true", PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true", PERSONAL_RECEIPT_WEEK_ENABLED: "true" };
const WEEK_END = "2026-10-16";

const DRIVERS = [ADA, BRAM, CYD, DAX, ELI, FAY, HAL, IVO, JO, KIT, LU, MO, NED].map((name) => ({ name }))
	.concat([{ name: GUS, payType: "percentage", payPct: 30 }, { name: PAT, payDaily: 262.37 }]);
const TRUCKS = DRIVERS.map((d, i) => ({ unit: `T${i + 1}`, driver: d.name, owner: 5, vid: null }));
// Ivo's truck (investor 5's) reports to the ELD; Jo drives the company's own
// truck, which reports too, on investor 5's load.
Object.assign(TRUCKS.find((t) => t.driver === IVO), { vid: "v-ivo" });
Object.assign(TRUCKS.find((t) => t.driver === JO), { owner: 0, vid: "v-co" });
const unitOf = (driver) => TRUCKS.find((t) => t.driver === driver).unit;
const L = (o) => loadRow({ truck: unitOf(o.driver), ...o });
const transit = { done: "", status: "In Transit" };
const delivered = (day) => ({ "Job Status": "Delivered", "Status Update Date": W.md(day), "Completion Date": W.md(day) });

function rows() {
	return [
		// Ada: PC101 delivered 10/12, after the 10/3-10/9 invoice: 10/8 and 10/9 cross weeks.
		L({ id: "PC100", driver: ADA, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05" }),
		L({ id: "PC101", driver: ADA, pickup: "2026-10-08 8:00", dropoff: "2026-10-12 12:00", assigned: "2026-10-08", ...transit }),
		// Bram: PC202 delivered 10/16 after the batch that made the week's invoice.
		L({ id: "PC201", driver: BRAM, pickup: "2026-10-13 8:00", dropoff: "2026-10-14 12:00", assigned: "2026-10-13", done: "2026-10-14" }),
		L({ id: "PC202", driver: BRAM, pickup: "2026-10-15 8:00", dropoff: "2026-10-16 12:00", assigned: "2026-10-15", ...transit }),
		// Cyd: 10/7 added on Driver Pay Overrides after the invoice.
		L({ id: "PC301", driver: CYD, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 12:00", assigned: "2026-10-05", done: "2026-10-06" }),
		// Dax: no invoice for the week.
		L({ id: "PC401", driver: DAX, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 12:00", assigned: "2026-10-06", done: "2026-10-07" }),
		// Eli: PC501 has a blank Pickup Appointment.
		L({ id: "PC501", driver: ELI, pickup: "", dropoff: "2026-10-07 12:00", assigned: "2026-10-06", done: "2026-10-07" }),
		L({ id: "PC502", driver: ELI, pickup: "2026-10-08 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-08", done: "2026-10-08" }),
		// Fay: 10/13 removed on Driver Pay Overrides after the invoice paid it.
		L({ id: "PC601", driver: FAY, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 12:00", assigned: "2026-10-12", done: "2026-10-13" }),
		// Gus (percentage): PC902 delivered 10/9 after that week's invoice.
		L({ id: "PC901", driver: GUS, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 12:00", assigned: "2026-10-05", done: "2026-10-06" }),
		L({ id: "PC902", driver: GUS, pickup: "2026-10-08 8:00", dropoff: "2026-10-09 12:00", assigned: "2026-10-08", ...transit }),
		// Hal: cross-week, its two early days on a correction Draft.
		L({ id: "PC1700", driver: HAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05" }),
		L({ id: "PC1701", driver: HAL, pickup: "2026-10-08 8:00", dropoff: "2026-10-12 12:00", assigned: "2026-10-08", ...transit }),
		// Ivo: the ELD showed driving on 10/13 only after the invoice was made.
		L({ id: "PC1101", driver: IVO, pickup: "2026-10-12 8:00", dropoff: "2026-10-14 12:00", assigned: "2026-10-12", done: "2026-10-14" }),
		// Jo: investor 5's load on the company's truck, parked 10/6.
		L({ id: "PC1201", driver: JO, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 12:00", assigned: "2026-10-05", done: "2026-10-07" }),
		// Kit: cross-week; that week's invoice carries a $300 adjustment.
		L({ id: "PC1300", driver: KIT, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05" }),
		L({ id: "PC1301", driver: KIT, pickup: "2026-10-08 8:00", dropoff: "2026-10-12 12:00", assigned: "2026-10-08", ...transit }),
		// Lu: cross-week; a correction Draft naming 10/8 was deleted.
		L({ id: "PC1400", driver: LU, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05" }),
		L({ id: "PC1401", driver: LU, pickup: "2026-10-08 8:00", dropoff: "2026-10-12 12:00", assigned: "2026-10-08", ...transit }),
		// Mo: Assigned in October with a September day, completed in a later week.
		L({ id: "PC1500", driver: MO, pickup: "2026-09-28 8:00", dropoff: "2026-09-28 18:00", assigned: "2026-09-28", done: "2026-09-28" }),
		L({ id: "PC1501", driver: MO, pickup: "2026-09-30 8:00", dropoff: "2026-10-05 12:00", assigned: "2026-10-01", ...transit }),
		// Ned: 10/6 paid by investor 5's load and by the company's.
		L({ id: "PC1601", driver: NED, pickup: "2026-10-06 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-06", done: "2026-10-06" }),
		L({ id: "PC1602", driver: NED, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 12:00", assigned: "2026-10-06", done: "2026-10-07", owner: "0" }),
		// Pat: $262.37 a day, no invoice.
		L({ id: "PC1801", driver: PAT, pickup: "2026-10-13 8:00", dropoff: "2026-10-14 12:00", assigned: "2026-10-13", done: "2026-10-14" }),
	];
}

const personalLib = () => require(path.join(W.ROOT, "lib", "personal-expense.js"));
function addReceipt(db, { driver, date, amount, type = "Fuel", status = "Approved" }) {
	return Number(db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, status) VALUES (?, ?, '', ?, ?, 'made-up', ?, ?)")
		.run(`${date}T15:00:00.000Z`, driver, type, amount, date, status).lastInsertRowid);
}
function addPersonalLine(db, { expenseId, cents, receiptDate, weekStart, carriedSince = "" }) {
	return Number(db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start,
		needs_correction_since, created_at, created_by, created_by_id, created_role) VALUES (?, 'deduct', ?, ?, 'Made-up Fuel Stop', ?, ?, 1, ?, ?, ?, '2026-10-10T14:00:00.000Z', 'made-up-admin', 1, 'Super Admin')`)
		.run(expenseId, cents, cents, receiptDate, receiptDate.slice(0, 7), receiptDate, weekStart, carriedSince).lastInsertRowid);
}
function addManualInvoice(db, { number, driver, weekStart, weekEnd, status = "Draft", correctionOf, days, deletedAt = "" }) {
	const lineItems = days.map((d) => ({ date: d, description: `Correction for its weekly invoice: ${d}, $260.00`, amount: 260 }));
	const render = { __templateName: "service_invoice_manual", workDayCorrection: true, paidDays: days, lineItems, totalDue: 260 * days.length };
	return Number(db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name,
		load_ids, expense_ids, render_data, is_manual, created_by, correction_of, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, '[]', '[]', ?, 1, 'made-up-admin', ?, ?, ?)`)
		.run(number, driver.toLowerCase(), weekStart, weekEnd, days.length, 260 * days.length, status, `${number}.pdf`, JSON.stringify(render), correctionOf, deletedAt, deletedAt ? "made-up-admin" : "").lastInsertRowid);
}

// The fleet through two Friday batches, then what happened after them.
async function buildFleet(env = ENV) {
	requireFix();
	const ivo = feed(1000).drive("2026-10-12", { miles: 300 }).park("2026-10-13").drive("2026-10-14", { miles: 250 });
	const co = feed(5000).drive("2026-10-05", { miles: 300 }).park("2026-10-06").drive("2026-10-07", { miles: 280 });
	const w = W.startWorld({
		env, drivers: DRIVERS, trucks: TRUCKS, rows: rows(), pings: { "v-ivo": ivo.pings, "v-co": co.pings },
		now: etMs("2026-10-02 20:00"), routes: [["get", ROUTE]], expose: ["payrollCheck"],
	});
	const inv = {};
	const gen = async (driver, weekEnd) => {
		const g = await W.generate(w, driver, weekEnd);
		if (g.status !== 200 || !g.invoice) throw new Error(`generate ${driver} ${weekEnd}: ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
		inv[`${driver} ${weekEnd}`] = g.invoice;
		return g.invoice;
	};
	// The batch of Friday 10/2.
	await gen(MO, "2026-10-02");
	w.setRow("PC1501", delivered("2026-10-05"));
	// The batch of Friday 10/9.
	w.clock.ms = etMs("2026-10-09 20:00");
	for (const d of [ADA, CYD, ELI, GUS, HAL, JO, KIT, LU, MO]) await gen(d, "2026-10-09");
	for (const id of ["PC101", "PC1301", "PC1401", "PC1701"]) w.setRow(id, delivered("2026-10-12"));
	w.setRow("PC902", delivered("2026-10-09"));
	w.addOverrides([{ driver: CYD, day: "2026-10-07", action: "add" }]);
	w.db.prepare("UPDATE invoices SET adjustment = 300, adjustment_note = 'made-up bonus' WHERE id = ?").run(inv[`${KIT} 2026-10-09`].id);
	addManualInvoice(w.db, { number: "INV-M-LP-2026W41-01", driver: LU, weekStart: "2026-10-03", weekEnd: "2026-10-09", correctionOf: inv[`${LU} 2026-10-09`].id, days: ["2026-10-08"], deletedAt: "2026-10-14T15:00:00.000Z" });
	const halDraft = addManualInvoice(w.db, { number: "INV-M-HB-2026W41-01", driver: HAL, weekStart: "2026-10-03", weekEnd: "2026-10-09", correctionOf: inv[`${HAL} 2026-10-09`].id, days: ["2026-10-08", "2026-10-09"] });
	// A hand-made invoice for Dax with one line dated 10/7 (no paidDays, no correction): it may pay that day.
	w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name,
		load_ids, expense_ids, render_data, is_manual, created_by) VALUES ('INV-M-DP-2026W41-01', 'dax penn', '2026-10-03', '2026-10-09', 1, 0, 260, 0, 'Submitted', 'INV-M-DP-2026W41-01.pdf', '[]', '[]', ?, 1, 'made-up-admin')`)
		.run(JSON.stringify({ __templateName: "service_invoice_manual", lineItems: [{ date: "2026-10-07", description: "Made-up hand invoice: an extra stop", amount: 260 }], totalDue: 260 }));
	// The batch of Friday 10/16.
	w.clock.ms = etMs("2026-10-16 20:00");
	for (const d of [ADA, BRAM, FAY, HAL, IVO, KIT, LU]) await gen(d, "2026-10-16");
	w.setRow("PC202", delivered("2026-10-16"));
	w.addOverrides([{ driver: FAY, day: "2026-10-13", action: "remove" }]);
	// Pings for 10/13 that reached the server after the batch.
	const late = feed(1300).drive("2026-10-13", { miles: 200 });
	const tl = w.db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, ?, ?, '')");
	for (const p of late.pings) tl.run("v-ivo", p.lat, p.lng, p.speed, p.odo, p.ms);
	w.lock(["2026-09"]);
	// Receipts and Personal lines.
	w.db.exec(personalLib().SCHEMA_SQL);
	const gilReceipt = addReceipt(w.db, { driver: GIL, date: "2026-10-07", amount: 45.5 });
	const gilLine = addPersonalLine(w.db, { expenseId: gilReceipt, cents: 4550, receiptDate: "2026-10-07", weekStart: "2026-10-03", carriedSince: "2026-10-10T10:00:00.000Z" });
	const daxReceipt = addReceipt(w.db, { driver: DAX, date: "2026-10-06", amount: 30 });
	const daxLine = addPersonalLine(w.db, { expenseId: daxReceipt, cents: 3000, receiptDate: "2026-10-06", weekStart: "2026-10-03" });
	const pending = addReceipt(w.db, { driver: ADA, date: "2026-10-14", amount: 61.25, type: "Maintenance", status: "Pending" });
	const pendingOld = addReceipt(w.db, { driver: ADA, date: "2026-09-20", amount: 19.99, status: "Pending" });
	const rejected = addReceipt(w.db, { driver: ADA, date: "2026-10-13", amount: 12.5, status: "Rejected" });
	w.clock.ms = etMs("2026-10-17 12:00");
	return { w, inv, halDraft, gilLine, daxLine, receipts: { pending, pendingOld, rejected } };
}

const ADMIN = { session: { user: { id: 1, role: "Super Admin", username: "made-up-admin" } }, headers: {}, params: {} };
async function check(w, weekEnd = WEEK_END) {
	const h = w.routes[ROUTE_KEY];
	if (!h) throw new Error(`${ROUTE_KEY} is not registered`);
	return W.call(h, { ...ADMIN, query: { weekEnd } });
}
let shared = null;
async function fleetAndBody() {
	if (!shared) {
		const f = await buildFleet();
		const before = W.tableHashes(f.w.db);
		const rendered = f.w.rendered.length;
		const r = await check(f.w);
		shared = { ...f, r, body: r.body || {}, before, after: W.tableHashes(f.w.db), renderedBefore: rendered };
	}
	return shared;
}
const triples = (list) => (list || []).map((x) => [x.driver, x.day, x.reason]).sort((a, b) => `${a}`.localeCompare(`${b}`));
const forDriver = (list, d) => (list || []).filter((x) => x.driver === d);
const sumOf = (list, key = "cents") => (list || []).reduce((c, x) => c + x[key], 0);

// ── the route alone, with the real requireRole, for the gate ──────────────────
function gateWorld(env) {
	if (!ROUTE_HEAD) throw new Error(`GET ${ROUTE} is not registered in server.js`);
	const provided = ["app", "db", "process", "require", "console", "payrollCheck", "payrollCheckLimiter"];
	const lifted = closure(W.SRC, { routes: [ROUTE_HEAD], provided, denied: ["getSheets", "sendEmail", "getJobTrackingCached", "io", "server"] });
	const state = { sql: 0, checks: [], limiter: 0, registered: [] };
	const db = { prepare() { state.sql++; throw new Error("the gate test reads no table"); } };
	const app = {};
	for (const m of ["get", "post", "put", "patch", "delete", "use", "all"]) app[m] = (p, ...h) => { state.registered.push({ method: m.toUpperCase(), path: p, handlers: h }); };
	const payrollCheck = async (args) => { state.checks.push(args); return { weekEnd: args.weekEnd, ledgerDays: [] }; };
	const payrollCheckLimiter = (req, res, next) => { state.limiter++; next(); };
	const quiet = { log() {}, warn() {}, error() {} };
	// The route's own requires are the app's lib/ files, read from the repo root.
	const libRequire = (m) => {
		if (!/^\.\/lib\/[\w.-]+$/.test(m)) throw new Error(`the route required ${m}, which the gate test does not load`);
		return require(path.join(W.ROOT, m));
	};
	new Function(...provided, `"use strict";\n${lifted.text}`)(app, db, { env: { ...env } }, libRequire, quiet, payrollCheck, payrollCheckLimiter);
	return state;
}
async function gateCall(state, user, query = { weekEnd: WEEK_END }) {
	const reg = state.registered.find((r) => r.method === "GET" && r.path === ROUTE);
	if (!reg) throw new Error(`GET ${ROUTE} did not register`);
	const req = { method: "GET", path: ROUTE, url: ROUTE, originalUrl: ROUTE, route: { path: ROUTE }, headers: {}, query, session: user ? { user } : {} };
	const res = { statusCode: 200, body: undefined, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
	for (const handler of reg.handlers) {
		let advanced = false;
		await handler(req, res, () => { advanced = true; });
		if (!advanced) break;
	}
	return { status: res.statusCode, body: res.body, headers: res.headers };
}
const SA ={ id: 7, username: "made-up-admin", role: "Super Admin" };
const OTHERS = [
	{ id: 11, username: "made-up-dispatcher", role: "Dispatcher" },
	{ id: 12, username: "made-up-driver", role: "Driver", driverName: ADA },
	{ id: 13, username: "made-up-investor", role: "Investor" },
	{ id: 14, username: "made-up-viewer", role: "KPI Viewer" },
];

const R = W.createRunner("Item 241 PR 1: the before-payroll check (route and script)");

(async () => {
	await R.test("§1 The role gate: 401 signed out; Dispatcher, Driver, Investor and KPI Viewer 403, switch on or off; the check never runs and nothing is read for them; requireRole is mounted before the limiter", async ({ eq, ok }) => {
		requireFix();
		eq("the route's head: requireRole first, then the limiter", ROUTE_HEAD, `app.get("${ROUTE}", requireRole("Super Admin"), payrollCheckLimiter, async (req, res) => {`);
		for (const [label, env] of [["switch on", { PAYROLL_CHECK_ENABLED: "true" }], ["switch off", {}]]) {
			const g = gateWorld(env);
			const anon = await gateCall(g, null);
			eq(`${label}: signed out is 401`, [anon.status, anon.body && anon.body.error], [401, "Not authenticated"]);
			for (const user of OTHERS) {
				const r = await gateCall(g, user);
				eq(`${label}: a ${user.role} is 403`, [r.status, r.body && r.body.error], [403, "Forbidden"]);
			}
			eq(`${label}: no check, no SQL, no limiter hit for a refused caller`, [g.checks.length, g.sql, g.limiter], [0, 0, 0]);
		}
		const g = gateWorld({ PAYROLL_CHECK_ENABLED: "true" });
		const r = await gateCall(g, SA);
		eq("a Super Admin passes the limiter and gets the check", [r.status, g.limiter, g.checks.length], [200, 1, 1]);
		eq("…asked for the week, with names", g.checks[0], { weekEnd: WEEK_END, names: true });
		eq("…and the answer is not stored by the browser", r.headers && r.headers["Cache-Control"], "no-store");
		const decl = indexDeclarations(W.SRC).decls.get("payrollCheckLimiter");
		ok("the limiter is keyed on the session user", !!decl && /keyGenerator/.test(decl.text) && /u:\$\{/.test(decl.text), decl ? decl.text.slice(0, 200) : "no payrollCheckLimiter");
	});

	await R.test("§2 The switch: unset, \"1\" or \"TRUE\", a Super Admin gets 404 FEATURE_OFF before any read; exactly \"true\" runs the check", async ({ eq }) => {
		requireFix();
		for (const [label, env] of [["unset", {}], ["\"1\"", { PAYROLL_CHECK_ENABLED: "1" }], ["\"TRUE\"", { PAYROLL_CHECK_ENABLED: "TRUE" }], ["\" true\"", { PAYROLL_CHECK_ENABLED: " true" }]]) {
			const g = gateWorld(env);
			const r = await gateCall(g, SA);
			eq(`${label}: 404 FEATURE_OFF`, [r.status, r.body && r.body.code], [404, "FEATURE_OFF"]);
			eq(`${label}: no check, no SQL`, [g.checks.length, g.sql], [0, 0]);
		}
		const g = gateWorld({ PAYROLL_CHECK_ENABLED: "true" });
		eq("\"true\": the check runs", [(await gateCall(g, SA)).status, g.checks.length], [200, 1]);
	});

	await R.test("§3 The week: missing, malformed, impossible, not a Friday, not finished, or in a closed month is 400; the first finished week of an open month answers", async ({ eq }) => {
		const { w } = await fleetAndBody();
		const status = async (weekEnd) => { const r = await check(w, weekEnd); return [r.status, r.body && r.body.code]; };
		const missing = await W.call(w.routes[ROUTE_KEY], { ...ADMIN, query: {} });
		eq("missing", [missing.status, missing.body && missing.body.code], [400, "PAYROLL_CHECK_WEEK_END_INVALID"]);
		eq("an array", (await W.call(w.routes[ROUTE_KEY], { ...ADMIN, query: { weekEnd: [WEEK_END, WEEK_END] } })).status, 400);
		eq("malformed", await status("2026-10-1"), [400, "PAYROLL_CHECK_WEEK_END_INVALID"]);
		eq("too long", await status("2026-10-16T00:00"), [400, "PAYROLL_CHECK_WEEK_END_INVALID"]);
		eq("not a real day", await status("2026-02-30"), [400, "PAYROLL_CHECK_WEEK_END_INVALID"]);
		eq("a Thursday", await status("2026-10-15"), [400, "PAYROLL_CHECK_WEEK_END_INVALID"]);
		eq("this week's Friday, not finished", await status("2026-10-23"), [400, "PAYROLL_CHECK_WEEK_NOT_FINISHED"]);
		eq("a Friday in the future", await status("2027-01-01"), [400, "PAYROLL_CHECK_WEEK_NOT_FINISHED"]);
		eq("a week wholly in closed September", await status("2026-09-25"), [400, "PAYROLL_CHECK_WEEK_CLOSED"]);
		const first = await check(w, "2026-10-02");
		eq("the week of 9/26, which touches October, answers", [first.status, first.body && first.body.weekStart, first.body && first.body.rangeStart], [200, "2026-09-26", "2026-09-26"]);
	});

	await R.test("§4 Ledger-paid days on no invoice, each driver-day once, each with its reason; the correction Draft's days are held", async ({ eq, ok }) => {
		const { r, body } = await fleetAndBody();
		eq("200", r.status, 200);
		eq("the range: the open months' first week to the week checked", [body.weekEnd, body.weekStart, body.rangeStart, body.latestClosedMonth, body.firstOpenMonth],
			[WEEK_END, "2026-10-10", "2026-09-26", "2026-09", "2026-10"]);
		const want = [
			[ADA, "2026-10-08", "completedAfterInvoice"], [ADA, "2026-10-09", "completedAfterInvoice"],
			[BRAM, "2026-10-15", "completedAfterInvoice"], [BRAM, "2026-10-16", "completedAfterInvoice"],
			[CYD, "2026-10-07", "addedAfterInvoice"],
			[DAX, "2026-10-06", "noWeeklyInvoice"],
			[ELI, "2026-10-06", "blankPickup"], [ELI, "2026-10-07", "blankPickup"],
			[IVO, "2026-10-13", "invoiceEldNoDriving"],
			[JO, "2026-10-06", "investorScopeNoEld"],
			[KIT, "2026-10-08", "mayBePaid"], [KIT, "2026-10-09", "mayBePaid"],
			[LU, "2026-10-08", "deletedDraft"], [LU, "2026-10-09", "completedAfterInvoice"],
			[MO, "2026-09-30", "closedMonth"], [MO, "2026-10-01", "completedAfterInvoice"], [MO, "2026-10-02", "completedAfterInvoice"],
			[NED, "2026-10-06", "noWeeklyInvoice"], [NED, "2026-10-07", "noWeeklyInvoice"],
			[PAT, "2026-10-13", "noWeeklyInvoice"], [PAT, "2026-10-14", "noWeeklyInvoice"],
		];
		eq("every listed day and its reason", triples(body.ledgerDays), triples(want.map(([driver, day, reason]) => ({ driver, day, reason }))));
		const day = (d, k) => (body.ledgerDays || []).find((x) => x.driver === d && x.day === k) || {};
		eq("a cross-week day: its load, completed in a later week", [day(ADA, "2026-10-08").loadId, day(ADA, "2026-10-08").loadCompleted, day(ADA, "2026-10-08").weekStart], ["PC101", "2026-10-12", "2026-10-03"]);
		eq("a Delivered after the invoice: completed inside its own week", [day(BRAM, "2026-10-15").loadId, day(BRAM, "2026-10-15").loadCompleted, day(BRAM, "2026-10-15").weekStart], ["PC202", "2026-10-16", "2026-10-10"]);
		eq("an added day names no load", [day(CYD, "2026-10-07").added, day(CYD, "2026-10-07").loadId], [true, ""]);
		ok("each item names the week's invoice when there is one", /^INV-/.test(day(ADA, "2026-10-08").invoiceNumber || "") && (day(DAX, "2026-10-06").invoiceNumber === ""), JSON.stringify([day(ADA, "2026-10-08"), day(DAX, "2026-10-06")]));
		ok("each reason comes with its words", (body.ledgerDays || []).every((x) => typeof x.text === "string" && x.text.length > 10), JSON.stringify((body.ledgerDays || []).find((x) => !x.text)));
		eq("Hal's 10/8 and 10/9 are held by his correction Draft", forDriver(body.ledgerDays, HAL), []);
		eq("Dax's 10/7 is held by a hand-made invoice's line dated that day", forDriver(body.ledgerDays, DAX).map((x) => x.day), ["2026-10-06"]);
		eq("Gus is paid by percentage: no day of his is listed", forDriver(body.ledgerDays, GUS), []);
		eq("the scope of each day: Jo's 10/6 is investor 5's", (day(JO, "2026-10-06").scopes || []).map((s) => s.ownerId), [5]);
		eq("summary by reason", body.summary && body.summary.ledgerDays && body.summary.ledgerDays.byReason, {
			addedAfterInvoice: 1, blankPickup: 2, closedMonth: 1, completedAfterInvoice: 7, deletedDraft: 1, investorScopeNoEld: 1, invoiceEldNoDriving: 1, mayBePaid: 2, noWeeklyInvoice: 5,
		});
	});

	await R.test("§5 Invoice-paid days the books no longer pay: a \"remove\" after the invoice, kept as issued and named", async ({ eq }) => {
		const { body, inv } = await fleetAndBody();
		const fay = inv[`${FAY} 2026-10-16`];
		eq("only Fay's 10/13", (body.invoiceDays || []).map((x) => [x.driver, x.day, x.invoiceNumber, x.reason, x.cents]), [[FAY, "2026-10-13", fay.invoice_number, "removeOverride", 26000]]);
		eq("…on its week, with its status and load", (body.invoiceDays || []).map((x) => [x.weekStart, x.status, x.loadIds]), [["2026-10-10", "Draft", ["PC601"]]]);
	});

	await R.test("§6 Personal lines on no invoice (a receipt driver no Drivers Database row names; a line waiting for its week's invoice) and receipts still Pending", async ({ eq, ok }) => {
		const { body, gilLine, daxLine, receipts } = await fleetAndBody();
		const line = (id) => (body.personalLines || []).find((x) => x.lineId === id) || {};
		eq("Gil's carried line: no Drivers Database row names its driver", [line(gilLine).driver, line(gilLine).state, line(gilLine).reason, line(gilLine).cents], [GIL, "carried", "unknownDriver", 4550]);
		ok("…said in words", /Drivers Database/.test(line(gilLine).text || ""), line(gilLine).text);
		eq("Dax's line waits for its week's invoice", [line(daxLine).driver, line(daxLine).state, line(daxLine).reason, line(daxLine).weekStart, line(daxLine).cents], [DAX, "pending", "pending", "2026-10-03", 3000]);
		ok("…which has none", /no weekly invoice/.test(line(daxLine).text || ""), line(daxLine).text);
		eq("only those two lines", (body.personalLines || []).length, 2);
		eq("receipts still Pending: Ada's of 10/14, not the one before the open weeks, not the rejected one",
			(body.pendingReceipts || []).map((x) => [x.driver, x.expenseId, x.date, x.weekStart, x.type, x.cents]), [[ADA, receipts.pending, "2026-10-14", "2026-10-10", "Maintenance", 6125]]);
	});

	await R.test("§7 Correction Drafts waiting for approval; a percentage driver's load completed after its week's invoice", async ({ eq }) => {
		const { body, inv } = await fleetAndBody();
		eq("Hal's correction Draft, $520, correcting his 10/3-10/9 invoice; Lu's deleted one is not listed",
			(body.correctionDrafts || []).map((x) => [x.driver, x.invoiceNumber, x.status, x.weekStart, x.weekEnd, x.kind, x.correctionOf, x.cents]),
			[[HAL, "INV-M-HB-2026W41-01", "Draft", "2026-10-03", "2026-10-09", "days", inv[`${HAL} 2026-10-09`].invoice_number, 52000]]);
		eq("Gus's PC902: completed after the week's invoice was made, $2,000 of revenue",
			(body.percentageLoads || []).map((x) => [x.driver, x.loadId, x.weekStart, x.completed, x.reason, x.paymentCents]),
			[[GUS, "PC902", "2026-10-03", "2026-10-09", "completedAfterInvoice", 200000]]);
	});

	await R.test("§8 Whole cents: every amount an integer; each total the sum of its items; $262.37 is 26237; a day two scopes count is listed once and counted once", async ({ eq, ok }) => {
		const { body } = await fleetAndBody();
		const bad = [];
		const walk = (v, at) => {
			if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
			if (!v || typeof v !== "object") return;
			for (const [k, x] of Object.entries(v)) {
				if (/cents$/i.test(k) && typeof x !== "object" && !(Number.isInteger(x))) bad.push(`${at}.${k}=${x}`);
				walk(x, `${at}.${k}`);
			}
		};
		walk(body, "body");
		eq("no amount outside whole cents", bad, []);
		const s = body.summary || {};
		eq("each total is the sum of its items", [
			s.ledgerDays && s.ledgerDays.cents, s.invoiceDays && s.invoiceDays.cents, s.personalLines && s.personalLines.cents,
			s.pendingReceipts && s.pendingReceipts.cents, s.correctionDrafts && s.correctionDrafts.cents, s.percentageLoads && s.percentageLoads.paymentCents,
		], [sumOf(body.ledgerDays), sumOf(body.invoiceDays), sumOf(body.personalLines), sumOf(body.pendingReceipts), sumOf(body.correctionDrafts), sumOf(body.percentageLoads, "paymentCents")]);
		eq("the ledger days come to 19 days at $260 and 2 at $262.37", [s.ledgerDays && s.ledgerDays.count, s.ledgerDays && s.ledgerDays.cents], [21, 546474]);
		eq("Pat's days", forDriver(body.ledgerDays, PAT).map((x) => x.cents), [26237, 26237]);
		const ned = forDriver(body.ledgerDays, NED);
		eq("Ned's 10/6 once, with both scopes; 10/7 the company's", ned.map((x) => [x.day, x.overlap, (x.scopes || []).map((sc) => sc.ownerId).sort(), x.cents]),
			[["2026-10-06", true, [0, 5], 26000], ["2026-10-07", false, [0], 26000]]);
		const rollup = ((body.drivers || []).find((d) => d.driver === NED) || { weeks: [] }).weeks.map((x) => [x.weekStart, x.counts && x.counts.ledgerDays, x.cents && x.cents.ledgerDays]);
		eq("Ned's week in the per driver and week roll-up", rollup, [["2026-10-03", 2, 52000]]);
		ok("the roll-up covers every listed item", (body.drivers || []).reduce((c, d) => c + d.weeks.reduce((n, x) => n + (x.counts ? x.counts.ledgerDays : 0), 0), 0) === (body.ledgerDays || []).length, JSON.stringify(body.drivers).slice(0, 200));
	});

	await R.test("§9 Nothing written: every table as before, no sheet write, no render; the function calls no writer; the cached sheet is never changed", async ({ eq, ok }) => {
		const f = await fleetAndBody();
		eq("every table as before the call", f.after, f.before);
		eq("no sheet write", f.w.sheetWrites.length, 0);
		eq("no PDF rendered by the check", f.w.rendered.length, f.renderedBefore);
		const decl = indexDeclarations(W.SRC).decls.get("payrollCheck");
		const own = decl ? decl.text : "";
		const WRITERS = ["logAudit", "notifyChange", "getSheets", "sendEmail", "jtCacheInvalidate", "renderPolicy", "claimInvoicePaidDays", "commitInvoiceWithPdf",
			"releaseInvoicePaidDays", "insertPersonalRow", "addLateWorkDaysToInvoice", "createWorkDayCorrection", "settleLateWorkDays", "reconcileInvestorPayouts"];
		ok("payrollCheck() calls no writer", !!own && WRITERS.every((n) => !new RegExp(`\\b${n}\\(`).test(own)), WRITERS.filter((n) => new RegExp(`\\b${n}\\(`).test(own)).join(", ") || "no payrollCheck");
		ok("…writes no table itself", !!own && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(own), "a write statement in payrollCheck()");
		ok("…and asks for no write of the paid days", !!own && /backfillInvoicePaidDays\(\{ write: false \}\)/.test(own), "backfillInvoicePaidDays must be asked with write: false");
		// The script's lift reads one sheet snapshot, the server's cache stand-in: frozen, it must come through unchanged.
		const { buildLedgerWorld } = require("./lib/ledger-world");
		const copy = W.saveCopy(f.w, ENV);
		const lw = buildLedgerWorld({ root: W.ROOT, dbPath: copy.db, readonly: true, sheetData: JSON.parse(fs.readFileSync(copy.values, "utf8")), envFile: copy.envFile, extraRoots: ["payrollCheck"] });
		try {
			const jt = await lw.api.getJobTrackingCached();
			const freeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
			const before = JSON.stringify(jt);
			freeze(jt);
			const out = await lw.api.payrollCheck({ weekEnd: WEEK_END, names: true });
			eq("the frozen sheet snapshot is read, never written", [JSON.stringify(jt) === before, !out.refused, (out.ledgerDays || []).length], [true, true, 21]);
		} finally {
			lw.db.close();
		}
	});

	await R.test("§10 The script: --help; exit 2 without --week-end, --db or a sheet, or with a bad week; with the switch off it answers what the route answers, and leaves its database file byte for byte", async ({ eq, ok }) => {
		const f = await fleetAndBody();
		const help = W.runScript("scripts/payroll-check.js", ["--help"]);
		ok("--help: exit 0, naming --week-end", help.code === 0 && /--week-end/.test(help.stdout), help.stderr || help.stdout);
		const off = Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== "PAYROLL_CHECK_ENABLED"));
		const copy = W.saveCopy(f.w, off);
		const refusals = [
			["no arguments", [], /--week-end/],
			["no --db", [`--week-end=${WEEK_END}`, `--values-json=${copy.values}`], /--db/],
			["no sheet", [`--week-end=${WEEK_END}`, `--db=${copy.db}`, `--env-file=${copy.envFile}`], /--sheet-id/],
			["a Thursday", ["--week-end=2026-10-15", `--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`], /Friday/],
		];
		for (const [label, args, says] of refusals) {
			const r = W.runScript("scripts/payroll-check.js", args);
			ok(`${label}: exit 2, saying why`, r.code === 2 && says.test(`${r.stderr}${r.stdout}`), `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
		}
		const fileBefore = W.fileHash(copy.db);
		const run = W.runScript("scripts/payroll-check.js", [`--week-end=${WEEK_END}`, `--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--names", "--json"]);
		ok("the switch off: exit 0 with JSON", run.code === 0 && !!run.json, (run.stderr || run.stdout).slice(0, 300));
		const SECTIONS = ["ledgerDays", "invoiceDays", "personalLines", "pendingReceipts", "correctionDrafts", "percentageLoads", "summary", "drivers"];
		const pick = (b) => Object.fromEntries(SECTIONS.map((k) => [k, b ? b[k] : null]));
		eq("…the route's answer, section by section", JSON.stringify(pick(run.json)), JSON.stringify(pick(f.body)));
		eq("the database file unchanged", W.fileHash(copy.db), fileBefore);
		const labelled = W.runScript("scripts/payroll-check.js", [`--week-end=${WEEK_END}`, `--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--json"]);
		const names = (labelled.json && labelled.json.ledgerDays || []).map((x) => x.driver);
		ok("without --names, drivers are numbered labels", labelled.code === 0 && names.length === 21 && names.every((n) => /^driver \d+$/.test(n)), names.slice(0, 4).join(", "));
		const text = W.runScript("scripts/payroll-check.js", [`--week-end=${WEEK_END}`, `--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`]);
		ok("the text report names each section and says nothing was written", text.code === 0 && /Nothing was written/.test(text.stdout) && /Ledger-paid days on no invoice/.test(text.stdout), text.stdout.slice(0, 300));
	});

	await R.test("§11 Parameterized SQL only in the check; the switch reads exactly \"true\"", async ({ eq, ok }) => {
		requireFix();
		const decl = indexDeclarations(W.SRC).decls.get("payrollCheck");
		const own = decl ? decl.text : "";
		const sql = [...own.matchAll(/db\.prepare\((`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
		ok("the check prepares its statements", sql.length > 0, own.slice(0, 120));
		const interpolated = sql.filter((s) => s.startsWith("`") && /\$\{(?!PERSONAL_SUMMARY_SELECT\})/.test(s));
		eq("no value is written into SQL text", interpolated, []);
		ok("PAYROLL_CHECK_ENABLED is read once, exactly \"true\"", LINES.filter((l) => /^const PAYROLL_CHECK_ENABLED = /.test(l)).length === 1
			&& LINES.includes('const PAYROLL_CHECK_ENABLED = process.env.PAYROLL_CHECK_ENABLED === "true";'), "the switch's line");
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
