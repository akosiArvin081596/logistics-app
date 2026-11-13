#!/usr/bin/env node
/**
 * scripts/data-fix-october-driver-rate.js on made-up data: a temp SQLite built
 * from every CREATE TABLE in server.js (scripts/lib/work-days-world.js, the payout
 * runners' world), a fake Sheets client that serves one Job Tracking tab, and the
 * payout ledger lifted from server.js as the oracle. One made-up daily-rate
 * driver's own rate was raised to $300 while his trucks pay $250; his October
 * invoices paid $250 a day (two weekly, one manual correction, all paid), one day
 * is on no invoice, and his later open weekly invoice paid two October days at $300.
 *
 *   §1 the dry run writes nothing, on each path, and lists the rows it would write
 *   §2 the apply: forward-only writes the payout row's adjustment, its history and
 *      audit rows, nothing else; october-300 writes the next open invoice's
 *      adjustment, its PDF and audit row, nothing else; forward-only on the open
 *      invoice's own days writes both, the invoice first
 *   §3 the same rows, file and audit rows as a person's, through the lifted routes
 *   §4 a full no-op (nothing written, exit 2) on each refusal: the month closed, a
 *      before value changed, a wrong expected figure, the driver's rate, the
 *      payout code's days, what the invoices paid, the carrying invoice, the plan;
 *      and a paying invoice's adjustment the plan names exactly lets it go ahead
 *   §5 a replay writes nothing; a failed render writes nothing and a re-run
 *      finishes; the month closing, or a person's change, between the checks and a
 *      write stops the run before that write
 *   §6 the read back: the payout code against the plan's figure (exit 3), and the
 *      investor's closed-month rows
 *   §7 the lift
 *   §8 the command line and the files
 *   §9 a difference posted already elsewhere: another invoice of his carrying an
 *      adjustment, a correction total, manual lines off the planned days or a
 *      deduction, or a waiting correction line, refuses a plan that pays the
 *      driver a difference unless the plan acknowledges it by fingerprint;
 *      forward-only doesn't look
 *   §10 a plan's rows (D's yes): his company-booked load moved to the investor first,
 *      through the Data Manager's save path, then the rate's writes; refusals,
 *      replay, a refused sheet write and a row changed after the checks
 *   §11 the routes' own audit and history rows, required by the read back
 *   §12 the source
 *
 * DRIVER_RATE_FIX_UNDER_TEST=<file> runs that copy of the script (a mutant) as if
 * it sat at the script's own path, so its requires resolve as the script's do.
 * Every name, load, amount and sheet ID here is made up. No network.
 *   node scripts/test-data-fix-october-driver-rate.js   # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-october-driver-rate.js");

// The script under test: the real one, or a mutant copy compiled as if it sat at
// the real path.
function loadFix() {
	const file = process.env.DRIVER_RATE_FIX_UNDER_TEST || SCRIPT;
	const src = fs.readFileSync(file, "utf8");
	const m = new Module(SCRIPT, module);
	m.filename = SCRIPT;
	m.paths = Module._nodeModulePaths(path.dirname(SCRIPT));
	m._compile(src, SCRIPT);
	return m.exports;
}
let FIX;
try {
	FIX = loadFix();
} catch (err) {
	console.error(`FAIL: scripts/data-fix-october-driver-rate.js did not load (${String((err && err.message) || err).split("\n")[0]})`);
	process.exit(1);
}

const W = require("./lib/work-days-world");
const { closure } = require("./lib/server-lift");
const sheetIds = require("../lib/sheet-id");
const { unresolvedNames } = require("./data-fix-october-dvir-correction");

const { test, finish } = W.createRunner("data-fix-october-driver-rate");
const NOW = Date.parse("2026-11-12T15:00:00Z");
const SHEET_ID = "sheet-under-test-rate-r1";
const PERIOD = "2026-10";
const OWNER = 5;
const GUS = "Gus Testdriver";
const HAL = "Hal Testdriver";
const ADMIN = Object.freeze({ id: 1, username: "super_admin", role: "Super Admin" });
const EARLIER_NOTE = "Made-up earlier correction: 2 loads at their invoiced totals; your 50% share.";
const RATE_NOTE = "Made-up: the earlier correction, and the driver's days before his raise at $250; your 50% share.";
const DRIVER_NOTE_UP = "Made-up: your $300 rate for October, +$50 on each of 6 days paid at $250.";
const DRIVER_NOTE_DOWN = "Made-up: Oct 31 and Nov 1 at $250, the rate before your raise.";
const tag = (name) => FIX.driverTag(String(name).trim().toLowerCase().replace(/\s+/g, " "));
const GUS_TAG = tag(GUS);

// ── the made-up fleet, loads and invoices ────────────────────────────────────
const DRIVERS = [{ name: GUS, payDaily: 300 }, { name: HAL, payDaily: 260 }];
const TRUCKS = [{ unit: "T1", driver: GUS, payDaily: 250 }, { unit: "T2", driver: HAL }];
const LOADS = [
	{ id: "900201", driver: GUS, truck: "T1", pickup: "2026-10-12 8:00", dropoff: "2026-10-13 14:00", payment: "$1,400.00" },
	{ id: "900202", driver: GUS, truck: "T1", pickup: "2026-10-14 8:00", dropoff: "2026-10-14 18:00", payment: "$700.00" },
	{ id: "900203", driver: GUS, truck: "T1", pickup: "2026-10-16 8:00", dropoff: "2026-10-16 18:00", payment: "$650.00" },
	{ id: "900204", driver: GUS, truck: "T1", pickup: "2026-10-19 8:00", dropoff: "2026-10-21 14:00", payment: "$2,100.00" },
	{ id: "900205", driver: GUS, truck: "T1", pickup: "2026-10-31 8:00", dropoff: "2026-11-01 14:00", assigned: "2026-10-30", done: "2026-11-01", payment: "$1,800.00" },
	{ id: "900206", driver: HAL, truck: "T2", pickup: "2026-10-05 8:00", dropoff: "2026-10-07 14:00", payment: "$3,300.00" },
	{ id: "900207", driver: HAL, truck: "T2", pickup: "2026-09-14 8:00", dropoff: "2026-09-15 14:00", payment: "$2,000.00" },
	// His haul booked to the company (Owner ID 0, no truck): the load a plan's rows move.
	{ id: "900209", driver: GUS, truck: "", owner: "0", pickup: "2026-10-22 8:00", dropoff: "2026-10-23 14:00", payment: "$1,000.00" },
];
const GUS_DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-31", "2026-11-01"];
const sheetRow = (l) => W.loadRow({ id: l.id, driver: l.driver, truck: l.truck, owner: l.owner ?? "5", payment: l.payment, pickup: l.pickup, dropoff: l.dropoff, assigned: l.assigned || l.pickup.split(" ")[0], done: l.done || l.dropoff.split(" ")[0] });

const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const plus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// A weekly invoice row: its Saturday-Friday grid pays `pays` ({ day: rate }).
function weekly({ id, number, weekStart, status, pays }) {
	const days = {};
	GRID.forEach((name, i) => {
		const day = plus(weekStart, i);
		days[name] = pays[day] ? { date: day, loadBol: "made-up", total: pays[day], completed: true, rate: pays[day] } : { date: day, loadBol: "", total: 0, completed: false };
	});
	const total = Object.values(pays).reduce((s, x) => s + x, 0);
	const render = { driverName: GUS, submissionDate: "made-up", totalDue: total, days, adjustment: 0, adjustmentNote: "", __templateName: "service_invoice" };
	return { id, invoice_number: number, driver: GUS, week_start: weekStart, week_end: plus(weekStart, 6), loads_count: Object.keys(pays).length, rate_per_load: Math.max(...Object.values(pays)), total_earnings: total, status, pdf_file_name: `${number}.pdf`, render_data: JSON.stringify(render), is_manual: 0 };
}
function manual({ id, number, period, status, lines }) {
	const total = lines.reduce((s, l) => s + l.amount, 0);
	const render = { payeeName: GUS, lineItems: lines, deductions: [], subtotal: total, deductionsTotal: 0, totalDue: total, notes: "", adjustment: 0, adjustmentNote: "", __templateName: "service_invoice_manual" };
	return { id, invoice_number: number, driver: GUS, week_start: period, week_end: period, loads_count: lines.length, rate_per_load: 0, total_earnings: total, status, pdf_file_name: `${number}.pdf`, render_data: JSON.stringify(render), is_manual: 1 };
}
// Oct 15 (on 9101) and Nov 2 (on 9104) are days his invoices pay that the
// investor's October does not count.
const INVOICES = [
	weekly({ id: 9101, number: "INV-GT-2026W41-01", weekStart: "2026-10-10", status: "Paid", pays: { "2026-10-12": 250, "2026-10-13": 250, "2026-10-15": 250 } }),
	manual({ id: 9102, number: "INV-M-GT-2026W42-01", period: "2026-10-23", status: "Paid", lines: [{ date: "2026-10-14", description: "Correction for INV-GT-2026W41-01: Wednesday, October 14, 2026, $250", amount: 250 }] }),
	weekly({ id: 9103, number: "INV-GT-2026W42-01", weekStart: "2026-10-17", status: "Paid", pays: { "2026-10-19": 250, "2026-10-20": 250, "2026-10-21": 250, "2026-10-22": 250 } }),
	weekly({ id: 9104, number: "INV-GT-2026W44-01", weekStart: "2026-10-31", status: "Submitted", pays: { "2026-10-31": 300, "2026-11-01": 300, "2026-11-02": 300 } }),
];
const CARRIER = 9104;
const CARRIER_FILE = "INV-GT-2026W44-01.pdf";
function insertInvoice(db, r) {
	const cols = Object.keys(r);
	db.prepare(`INSERT INTO invoices (${cols.join(", ")}, created_at, submitted_at) VALUES (${cols.map(() => "?").join(", ")}, '2026-11-01 12:00:00', '2026-11-01T12:00:00Z')`).run(...cols.map((k) => r[k]));
}

// The oracle's figures, set once the world is built. MOVED: the month with 900209
// moved to owner 5 (its revenue and his Oct 22-23, at $300).
let BEFORE = null;
let AT250 = null;
let MOVED = null;
let PAYOUT_ID = null;
let MOVE_ROW = null;

// Plan days: each of his October days, at the payout code's $300, set as the path
// says; a "-yes" kind adds the two days 900209 brings once moved.
function days(kind) {
	const yes = kind.endsWith("-yes");
	const base = kind.replace(/-yes$/, "");
	const paid = { "2026-10-12": [9101, 250], "2026-10-13": [9101, 250], "2026-10-14": [9102, 250], "2026-10-19": [9103, 250], "2026-10-20": [9103, 250], "2026-10-21": [9103, 250], "2026-10-31": [CARRIER, 300], "2026-11-01": [CARRIER, 300], ...(yes ? { "2026-10-22": [9103, 250] } : {}) };
	return [...GUS_DAYS, ...(yes ? ["2026-10-22", "2026-10-23"] : [])].sort().map((day) => {
		const set = base === "october-300" ? "300.00" : base === "forward-only-own" ? "250.00" : (paid[day] && paid[day][1] === 300 ? "300.00" : "250.00");
		const d = { day, ledger: "300.00", set };
		if (paid[day]) Object.assign(d, { invoice: paid[day][0], paid: `${paid[day][1]}.00` });
		return d;
	});
}
const moveRows = () => [{ load: "900209", row: MOVE_ROW, cells: { "Owner ID": { before: "0", after: "5" }, Truck: { before: "", after: "T1" } } }];
// The plans: forward-only (the default answer, the open invoice as it is),
// october-300, forward-only taking the raise off the open invoice's own days, and
// the first two with 900209's row moved to owner 5 first (D's yes).
function basePlan(kind = "forward-only", over = {}) {
	const plans = {
		"forward-only": { path: "forward-only", days: days("forward-only"), payout: { id: PAYOUT_ID, before: { adjustment: 12, note: EARLIER_NOTE }, after: { adjustment: 187, note: RATE_NOTE } }, carrier: null, expectedEffective: BEFORE + 187 },
		"october-300": { path: "october-300", days: days("october-300"), payout: { id: PAYOUT_ID, before: { adjustment: 12, note: EARLIER_NOTE }, after: { adjustment: 12, note: EARLIER_NOTE } }, carrier: { id: CARRIER, before: { adjustment: "0.00", note: "" }, after: { adjustment: "300.00", note: DRIVER_NOTE_UP } }, acknowledged: [], expectedEffective: BEFORE + 12 },
		"forward-only-own": { path: "forward-only", days: days("forward-only-own"), payout: { id: PAYOUT_ID, before: { adjustment: 12, note: EARLIER_NOTE }, after: { adjustment: 237, note: RATE_NOTE } }, carrier: { id: CARRIER, before: { adjustment: "0.00", note: "" }, after: { adjustment: "-100.00", note: DRIVER_NOTE_DOWN } }, acknowledged: [], expectedEffective: BEFORE + 237 },
		"forward-only-yes": { path: "forward-only", days: days("forward-only-yes"), payout: { id: PAYOUT_ID, before: { adjustment: 12, note: EARLIER_NOTE }, after: { adjustment: 237, note: RATE_NOTE } }, carrier: null, rows: moveRows(), expectedEffective: MOVED + 237 },
		"october-300-yes": { path: "october-300", days: days("october-300-yes"), payout: { id: PAYOUT_ID, before: { adjustment: 12, note: EARLIER_NOTE }, after: { adjustment: 12, note: EARLIER_NOTE } }, carrier: { id: CARRIER, before: { adjustment: "0.00", note: "" }, after: { adjustment: "350.00", note: DRIVER_NOTE_UP } }, acknowledged: [], rows: moveRows(), expectedEffective: MOVED + 12 },
	};
	return { kind: "october-driver-rate", period: PERIOD, ownerId: OWNER, splitPct: 50, driver: GUS_TAG, ownRate: "300.00", ...plans[kind], ...over };
}

// ── the world: one database every case copies ────────────────────────────────
const BASE = W.startWorld({ rows: LOADS.map(sheetRow), drivers: DRIVERS, trucks: TRUCKS, locks: ["2026-08", "2026-09"], now: NOW, expose: ["computeLossCarryForward"] });
async function oraclePayable(world) {
	const led = await W.ledger(world, OWNER);
	const carry = world.api.computeLossCarryForward(led.monthlyEarnings);
	return { payable: carry[PERIOD] ? carry[PERIOD].payable : null, led };
}

// The fake Sheets client: one Job Tracking tab, kept as the sheet shows it; reads
// drop trailing empty cells and rows, as the API does. `failWrite`: { nth, mode:
// "refused" | "landed" }. `hooks`: onGet(n, rows) before the nth whole-tab read
// answers, onBatchGet(rowNo, rows) before a row's batchGet answers.
function fakeSheets(values, { failWrite = null, hooks = {} } = {}) {
	const rows = values.map((r) => r.map((c) => (c == null ? "" : String(c))));
	const calls = [];
	const writes = [];
	const trim = (r) => {
		const out = (r || []).map((c) => (c == null ? "" : String(c)));
		while (out.length && out[out.length - 1] === "") out.pop();
		return out;
	};
	const own = (id) => { if (id !== SHEET_ID) throw new Error(`fake sheet: a call to ${id}`); };
	const parse = (range) => {
		if (range === "Job Tracking") return "";
		const m = /^'((?:[^']|'')+)'(?:!(.+))?$/.exec(String(range));
		if (!m || m[1].replace(/''/g, "'") !== "Job Tracking") throw new Error(`fake sheet: unknown range ${range}`);
		return m[2] || "";
	};
	const rowOf = (a) => { const m = /^(\d+):\1$/.exec(a); if (!m) throw new Error(`fake sheet: unknown row range ${a}`); return Number(m[1]); };
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	let reads = 0;
	let n = 0;
	const client = {
		spreadsheets: {
			get: async ({ spreadsheetId }) => {
				own(spreadsheetId);
				calls.push("get");
				return { data: { sheets: [{ properties: { title: "Job Tracking", sheetId: 1036 } }, { properties: { title: "Carrier Database", sheetId: 7 } }] } };
			},
			values: {
				get: async ({ spreadsheetId, range }) => {
					own(spreadsheetId);
					calls.push(`values.get ${range}`);
					const a = parse(range);
					if (!a) {
						reads++;
						if (hooks.onGet) hooks.onGet(reads, rows);
						const all = rows.map(trim);
						while (all.length && !all[all.length - 1].length) all.pop();
						return { data: { values: all } };
					}
					return { data: { values: [trim(rows[rowOf(a) - 1])] } };
				},
				batchGet: async ({ spreadsheetId, ranges }) => {
					own(spreadsheetId);
					calls.push(`values.batchGet ${ranges.join(" ")}`);
					const nums = ranges.map((x) => rowOf(parse(x)));
					if (hooks.onBatchGet) hooks.onBatchGet(nums[nums.length - 1], rows);
					return { data: { valueRanges: nums.map((r) => ({ values: [trim(rows[r - 1])] })) } };
				},
				batchUpdate: async ({ spreadsheetId, requestBody }) => {
					own(spreadsheetId);
					calls.push("values.batchUpdate");
					n++;
					const fail = failWrite && failWrite.nth === n ? failWrite.mode : "";
					if (fail === "refused") throw new Error("made-up write failure");
					if (requestBody.valueInputOption !== "USER_ENTERED") throw new Error("fake sheet: not USER_ENTERED");
					for (const d of requestBody.data) {
						const m = /^'Job Tracking'!([A-Z]+)(\d+)$/.exec(d.range);
						if (!m) throw new Error(`fake sheet: unknown cell ${d.range}`);
						const row = rows[Number(m[2]) - 1];
						const c = colIndex(m[1]);
						while (row.length <= c) row.push("");
						row[c] = String(d.values[0][0]);
					}
					writes.push(JSON.parse(JSON.stringify(requestBody)));
					if (fail === "landed") throw new Error("made-up lost answer");
					return { data: { totalUpdatedCells: requestBody.data.length } };
				},
				update: async () => { throw new Error("fake sheet: values.update is not a row save"); },
				append: async () => { throw new Error("fake sheet: values.append is not a row save"); },
			},
		},
	};
	return { client, rows, calls, writes };
}

// ── one case: its own database copy, plan, result, sheet and renderer ───────
const IDX = Object.fromEntries(W.HEADERS.map((h, i) => [h, i]));
const rowNo = (rows, id) => rows.findIndex((r) => r[IDX["Load ID"]] === id) + 1;
function newCase({ plan = basePlan(), db = null, edit = null, hooks = {}, failWrite = null, renderFail = false, onRender = null } = {}) {
	const copy = W.saveCopy(BASE, {});
	if (db) { const d = new W.Database(copy.db); try { db(d); } finally { d.close(); } }
	const values = W.sheetValues(BASE.rows);
	if (edit) edit(values);
	const planFile = path.join(copy.dir, "plan.json");
	fs.writeFileSync(planFile, JSON.stringify(plan));
	const result = path.join(copy.dir, "result.json");
	const renders = [];
	const render = async (templateName, data) => {
		renders.push({ templateName, data: JSON.parse(JSON.stringify(data)) });
		if (onRender) onRender(copy, renders.length);
		if (renderFail) throw new Error("made-up render failure");
		return Buffer.from(`%PDF-made-up ${templateName} adjustment=${data.adjustment}`);
	};
	return { ...copy, planFile, result, fake: fakeSheets(values, { hooks, failWrite }), plan, renders, render };
}
const args = (c, mode = "--apply", pathName = c.plan.path) => [`--path=${pathName}`, `--db=${c.db}`, `--sheet-id=${SHEET_ID}`, `--settings-file=${c.envFile}`, `--plan=${c.planFile}`, `--result=${c.result}`, ...(mode ? [mode] : [])];
// `opts.onLog(line)` sees each printed line as it is printed: a hook between the checks and the writes.
async function run(c, mode = "--apply", opts = {}) {
	const out = [];
	const { onLog = null, ...rest } = opts;
	const log = (s) => { out.push(String(s)); if (onLog) onLog(String(s)); };
	const code = await FIX.main(rest.argv || args(c, mode), { sheets: c.fake.client, nowMs: NOW, render: c.render, log, err: (s) => out.push(String(s)), ...rest });
	let result = null;
	try { result = JSON.parse(fs.readFileSync(c.result, "utf8")); } catch { result = null; }
	return { code, out: out.join("\n"), result };
}
const hashes = (c) => { const d = new W.Database(c.db, { readonly: true }); try { return W.tableHashes(d); } finally { d.close(); } };
const query = (c, sql, ...p) => { const d = new W.Database(c.db, { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const payoutRow = (c) => query(c, "SELECT * FROM investor_payouts WHERE id = ?", PAYOUT_ID)[0];
const invoiceRow = (c, id = CARRIER) => query(c, "SELECT * FROM invoices WHERE id = ?", id)[0];
const scriptAudits = (c) => query(c, "SELECT user_id, username, role, action, entity, entity_id, details, timestamp FROM audit_trail WHERE username = ? ORDER BY id", FIX.ACTOR);
const pdfPath = (c) => path.join(c.dir, "uploads", "invoices", CARRIER_FILE);
const pdfOf = (c) => (fs.existsSync(pdfPath(c)) ? fs.readFileSync(pdfPath(c), "utf8") : null);

// A full no-op: refused, nothing rendered, every table as it was, and why in the result.
async function noOp(t, c, why, mode = "--apply") {
	const before = hashes(c);
	const r = await run(c, mode);
	t.eq("exit code (refused)", r.code, 2);
	t.eq("every table as it was", hashes(c), before);
	t.eq("nothing rendered, no PDF written", [c.renders.length, pdfOf(c)], [0, null]);
	t.ok(`the result says it was refused, naming ${why}`, r.result && r.result.outcome === "refused" && why.test((r.result.problems || []).join(" | ")), JSON.stringify(r.result && r.result.problems));
	return r;
}

// ── the person's path: the two routes, lifted on their own, as a Super Admin ─
class Clock extends Date {
	constructor(...a) { if (a.length) super(...a); else super(NOW); }
	static now() { return NOW; }
}
async function personPath(c, kind) {
	const plan = basePlan(kind);
	const lifted = closure(W.SRC, { roots: [...FIX.ROOTS], routes: [...FIX.HEADS], provided: [...FIX.PROVIDED] });
	const db = new W.Database(c.db);
	const routes = {};
	const register = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const appRequire = Module.createRequire(path.join(ROOT, "server.js"));
	const deps = {
		db,
		require: (m) => appRequire(m),
		console: { log() {}, info() {}, warn() {}, error() {} },
		process: { env: {}, pid: process.pid, argv: [], cwd: () => ROOT, exit: () => { throw new Error("exit"); } },
		__dirname: ROOT,
		Date: Clock,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass,
		refuseCrossOrigin: pass(),
		notifyChange: () => {},
		fs,
		DATA_DIR: c.dir,
		REPLICA: null,
		renderPolicy: c.render,
	};
	new Function(...FIX.PROVIDED, `"use strict";\n${lifted.text}\n`)(...FIX.PROVIDED.map((k) => deps[k]));
	const call = async (key, id, body) => {
		const out = { status: 200, body: null };
		const res = { status(x) { out.status = x; return res; }, json(b) { out.body = b; return res; } };
		await routes[key]({ params: { id: String(id) }, body, session: { user: { ...ADMIN } }, headers: {}, query: {} }, res);
		return out;
	};
	const answers = [];
	if (plan.carrier) answers.push(await call("PUT /api/invoices/:id/adjust", CARRIER, { adjustment: Number(plan.carrier.after.adjustment), adjustmentNote: plan.carrier.after.note }));
	if (plan.payout.after.adjustment !== plan.payout.before.adjustment) answers.push(await call("PUT /api/investor/payouts/:id/adjust", PAYOUT_ID, { adjustment: plan.payout.after.adjustment, adjustmentNote: plan.payout.after.note }));
	db.close();
	return answers;
}

// The Data Manager's save of one row (PUT /api/data/:rowIndex, lifted on its own,
// as a Super Admin's screen sends it: every cell as shown, the two changed, no
// baseline), then Payouts' adjustment, on a copy.
const DATA_HEAD = 'app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
let ROW_PERSON_LIFT = null;
function rowPersonLift() {
	if (ROW_PERSON_LIFT) return ROW_PERSON_LIFT;
	const provided = ["db", "require", "console", "process", "Date", "app", "requireRole", "refuseCrossOrigin", "getSheets", "SPREADSHEET_ID",
		"jtCacheInvalidate", "REPLICA", "factoringRoutes", "__dirname", "getJobTrackingCached"];
	const heads = [DATA_HEAD, FIX.HEADS[0]];
	const roots = ["recordPayoutChange"];
	for (let round = 0; round < 6; round++) {
		const lifted = closure(W.SRC, { roots, routes: heads, provided, denied: ["server", "io", "transporter", "getDrive", "sendEmail", "fetch"] });
		const missing = unresolvedNames(W.SRC, lifted, provided, heads);
		if (!missing.length) { ROW_PERSON_LIFT = { lifted, provided }; return ROW_PERSON_LIFT; }
		roots.push(...missing);
	}
	throw new Error("the row person's lift did not settle");
}
async function rowPersonPath(c, plan) {
	const { lifted, provided } = rowPersonLift();
	const db = new W.Database(c.db);
	const routes = {};
	const register = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const appRequire = Module.createRequire(path.join(ROOT, "server.js"));
	const deps = {
		db,
		require: (m) => appRequire(m),
		console: { log() {}, info() {}, warn() {}, error() {} },
		process: { env: {}, argv: [], cwd: () => ROOT, exit: () => { throw new Error("exit"); } },
		Date: Clock,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass,
		refuseCrossOrigin: pass(),
		getSheets: async () => c.fake.client,
		SPREADSHEET_ID: SHEET_ID,
		jtCacheInvalidate: () => {},
		REPLICA: null,
		factoringRoutes: { loadIdSave: () => { throw new Error("no Load ID changes here"); } },
		__dirname: ROOT,
		getJobTrackingCached: async () => { throw new Error("not read here"); },
	};
	new Function(...provided, `"use strict";\n${lifted.text}\n`)(...provided.map((k) => deps[k]));
	const call = async (key, req) => {
		const out = { status: 200, body: null };
		const res = { status(x) { out.status = x; return res; }, json(b) { out.body = b; return res; } };
		await routes[key](req, res);
		return out;
	};
	const shown = c.fake.rows[MOVE_ROW - 1];
	const values = W.HEADERS.map((h, i) => (h === "Owner ID" ? "5" : h === "Truck" ? "T1" : (shown[i] ?? "")));
	const answers = [];
	answers.push(await call("PUT /api/data/:rowIndex", { params: { rowIndex: String(MOVE_ROW) }, query: { sheet: "Job Tracking" }, body: { values }, session: { user: { ...ADMIN } }, headers: {} }));
	answers.push(await call("PUT /api/investor/payouts/:id/adjust", { params: { id: String(PAYOUT_ID) }, body: { adjustment: plan.payout.after.adjustment, adjustmentNote: plan.payout.after.note }, session: { user: { ...ADMIN } }, headers: {} }));
	db.close();
	return answers;
}

(async () => {
	// The world's invoices, the closed months' payout rows, the oracle, then October's row.
	for (const r of INVOICES) insertInvoice(BASE.db, r);
	const pay = BASE.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status, adjustment, adjustment_note, adjusted_by, adjusted_at, finalized_at) VALUES (?, ?, ?, ?, 'owed', ?, ?, ?, ?, ?)");
	pay.run(OWNER, "2026-08", 1000, "2026-09-27", 0, "", "", "", "2026-09-08T05:00:00.000Z");
	pay.run(OWNER, "2026-09", 2000, "2026-10-27", 0, "", "", "", "2026-10-09T05:00:00.000Z");
	const o = await oraclePayable(BASE);
	BEFORE = o.payable;
	const gusDays = o.led.pay.filter((i) => i.month === PERIOD && tag(i.driver) === GUS_TAG).map((i) => [i.day, i.cents]);
	BASE.db.prepare("UPDATE drivers_directory SET pay_daily = 250 WHERE driver_name = ?").run(GUS);
	AT250 = (await oraclePayable(BASE)).payable;
	BASE.db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE driver_name = ?").run(GUS);
	MOVE_ROW = rowNo(W.sheetValues(BASE.rows), "900209");
	BASE.setRow("900209", { "Owner ID": "5", Truck: "T1" });
	const moved = await oraclePayable(BASE);
	MOVED = moved.payable;
	const movedDays = moved.led.pay.filter((i) => i.month === PERIOD && tag(i.driver) === GUS_TAG).map((i) => i.day).sort();
	BASE.setRow("900209", { "Owner ID": "0", Truck: "" });
	pay.run(OWNER, PERIOD, BEFORE, "2026-11-27", 12, EARLIER_NOTE, "made-up-admin", "2026-11-12T10:00:00.000Z", "");
	PAYOUT_ID = BASE.db.prepare("SELECT id FROM investor_payouts WHERE owner_id = ? AND period = ?").get(OWNER, PERIOD).id;

	await test("the fixture: the payout code prices his 9 October days at his raised $300, and $250 would add $225", ({ eq, ok }) => {
		ok("a payable for the month", Number.isFinite(BEFORE) && BEFORE > 0, String(BEFORE));
		eq("his October days, each once at $300", gusDays.sort(), GUS_DAYS.map((d) => [d, 30000]));
		eq("the same days at $250 move the month by 9 x $25", AT250 - BEFORE, 225);
		eq("900209 moved to owner 5 brings his Oct 22 and 23 into October", movedDays, [...GUS_DAYS, "2026-10-22", "2026-10-23"].sort());
		eq("…and its $1,000 less those two days at $300, half of it", MOVED - BEFORE, 200);
	});

	// §1 ───────────────────────────────────────────────────────────────────────
	for (const kind of ["forward-only", "october-300", "forward-only-own"]) {
		await test(`§1 the dry run (${kind}) writes nothing and says what it would write`, async (t) => {
			const c = newCase({ plan: basePlan(kind) });
			const before = hashes(c);
			const r = await run(c, "--dry-run");
			t.eq("exit code", r.code, 0);
			t.eq("every table as it was", hashes(c), before);
			t.eq("nothing rendered, no PDF written", [c.renders.length, pdfOf(c)], [0, null]);
			t.eq("one sheet read, of the named sheet", c.fake.calls, ["values.get Job Tracking"]);
			t.eq("result: would write", r.result && [r.result.mode, r.result.outcome], ["dry-run", "would-write"]);
			const plan = basePlan(kind);
			t.eq("the payout it predicts", r.result && [r.result.ledger.recomputed, r.result.ledger.effectiveAfter, r.result.ledger.expected], [BEFORE, plan.expectedEffective, plan.expectedEffective]);
			t.eq("the result file is the owner's only (600)", (fs.statSync(c.result).mode & 0o777).toString(8), "600");
			t.ok("it says nothing was written", /Nothing was written/.test(r.out), r.out.slice(-300));
			const cols = (r.result.writes || []).filter((w) => w.table && w.id !== "new").map((w) => `${w.table} ${w.id} ${w.column}`);
			const inv = ["adjustment", "adjustment_note", "adjusted_by", "adjusted_at"].map((k) => `invoices ${CARRIER} ${k}`);
			const pay = ["adjustment", "adjustment_note", "adjusted_by", "adjusted_at"].map((k) => `investor_payouts ${PAYOUT_ID} ${k}`);
			t.eq("the rows it lists", cols, kind === "forward-only" ? pay : kind === "october-300" ? inv : [...inv, ...pay]);
		});
	}
	await test("§1 with neither --dry-run nor --apply it is a dry run", async (t) => {
		const c = newCase();
		const before = hashes(c);
		const r = await run(c, null);
		t.eq("exit code", r.code, 0);
		t.eq("every table as it was", hashes(c), before);
		t.eq("result mode", r.result && r.result.mode, "dry-run");
	});
	await test("§1 the dry run lists each change with its before and after", async (t) => {
		const r = await run(newCase({ plan: basePlan("october-300") }), "--dry-run");
		const w = (table, column) => (r.result.writes || []).find((x) => x.table === table && x.column === column);
		t.eq("the invoice's adjustment", w("invoices", "adjustment") && [w("invoices", "adjustment").before, w("invoices", "adjustment").after], ["$0.00", "$300.00"]);
		t.eq("its note", w("invoices", "adjustment_note") && w("invoices", "adjustment_note").after, DRIVER_NOTE_UP);
		t.eq("its PDF, named without the driver's initials", (r.result.writes || []).filter((x) => x.file).map((x) => x.file), [`invoice ${CARRIER}'s own PDF in ${path.join("uploads", "invoices")}`]);
		t.ok("its audit row", (r.result.writes || []).some((x) => x.table === "audit_trail" && /adjust_invoice, invoice 9104: adjustment 0\.00 → 300\.00/.test(x.after)));
		t.ok("no payout row change", !(r.result.writes || []).some((x) => x.table === "investor_payouts"));
	});

	// §2 ───────────────────────────────────────────────────────────────────────
	await test("§2 forward-only: the payout row's adjustment, its history and audit rows, nothing else", async (t) => {
		const c = newCase();
		const before = hashes(c);
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		const p = payoutRow(c);
		t.eq("the payout row: the adjustment, its note, by the script", [p.adjustment, p.adjustment_note, p.adjusted_by], [187, RATE_NOTE, FIX.ACTOR]);
		t.eq("its amount is left to the app's recompute", p.amount, BEFORE);
		const h = query(c, "SELECT kind, old_amount, new_amount, delta, detail, actor FROM investor_payout_history WHERE payout_id = ?", PAYOUT_ID);
		t.eq("one history row, the route's own", h, [{ kind: "adjustment", old_amount: BEFORE + 12, new_amount: BEFORE + 187, delta: 175, detail: `adjustment: ${RATE_NOTE}`, actor: FIX.ACTOR }]);
		const a = scriptAudits(c);
		t.eq("one audit row, the route's own, as the system", a.map((x) => [x.action, x.entity, x.entity_id, x.user_id, x.role, x.details]), [["investor_payout_adjust", "investor_payout", String(PAYOUT_ID), 0, "system", `owner ${OWNER} ${PERIOD}: adjustment 12.00 -> 187.00 (${RATE_NOTE})`]]);
		const after = hashes(c);
		t.eq("only those three tables changed", Object.keys(before).filter((k) => before[k] !== after[k]).sort(), ["audit_trail", "investor_payout_history", "investor_payouts"]);
		t.eq("no invoice touched, nothing rendered", [c.renders.length, pdfOf(c)], [0, null]);
		t.eq("result: written and read back", r.result && [r.result.outcome, r.result.ledger.effectiveReadBack, r.result.ledger.difference], ["written", BEFORE + 187, 0]);
	});
	await test("§2 october-300: the next open invoice's adjustment, its PDF and audit row, nothing else", async (t) => {
		const c = newCase({ plan: basePlan("october-300") });
		const before = hashes(c);
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		const inv = invoiceRow(c);
		t.eq("the invoice: the adjustment, its note, by the script", [inv.adjustment, inv.adjustment_note, inv.adjusted_by, inv.status], [300, DRIVER_NOTE_UP, FIX.ACTOR, "Submitted"]);
		t.eq("its total earnings kept", inv.total_earnings, 900);
		t.eq("its PDF redrawn once, from its snapshot with the adjustment", [c.renders.length, c.renders[0] && c.renders[0].templateName, c.renders[0] && c.renders[0].data.adjustment, pdfOf(c)], [1, "service_invoice", 300, "%PDF-made-up service_invoice adjustment=300"]);
		const a = scriptAudits(c);
		t.eq("one audit row, the route's own, as the system", a.map((x) => [x.action, x.entity, x.entity_id, x.user_id, x.role]), [["adjust_invoice", "invoice", String(CARRIER), 0, "system"]]);
		t.ok("…naming the before and after", /adjustment 0\.00 → 300\.00/.test(a[0] && a[0].details), a[0] && a[0].details);
		const after = hashes(c);
		t.eq("only the invoice and the audit trail changed", Object.keys(before).filter((k) => before[k] !== after[k]).sort(), ["audit_trail", "invoices"]);
		t.eq("the payout row as it was", [payoutRow(c).adjustment, payoutRow(c).adjustment_note], [12, EARLIER_NOTE]);
		t.eq("result: written, and the month as planned", r.result && [r.result.outcome, r.result.ledger.effectiveReadBack, r.result.carrier.totalDueAfter], ["written", BEFORE + 12, 1200]);
	});
	await test("§2 october-300 with a day his invoice pays that the investor's month does not count: his pay alone", async (t) => {
		const plan = basePlan("october-300");
		plan.days = [...plan.days, { day: "2026-10-15", ledger: null, set: "300.00", invoice: 9101, paid: "250.00" }];
		plan.carrier = { ...plan.carrier, after: { adjustment: "350.00", note: DRIVER_NOTE_UP } };
		const c = newCase({ plan });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the invoice: +$350", invoiceRow(c).adjustment, 350);
		t.eq("the payout row as it was, and the month as planned", [payoutRow(c).adjustment, r.result && r.result.ledger.effectiveReadBack], [12, BEFORE + 12]);
	});
	await test("§2 forward-only on the open invoice's own days: both, the invoice first", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own") });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the invoice: -$100", [invoiceRow(c).adjustment, invoiceRow(c).adjustment_note], [-100, DRIVER_NOTE_DOWN]);
		t.eq("the payout row: $237", [payoutRow(c).adjustment, payoutRow(c).adjustment_note], [237, RATE_NOTE]);
		t.eq("two audit rows, the invoice's first", scriptAudits(c).map((x) => x.action), ["adjust_invoice", "investor_payout_adjust"]);
		t.eq("result: the month as planned", r.result && [r.result.ledger.effectiveReadBack, r.result.ledger.difference, r.result.carrier.totalDueAfter], [BEFORE + 237, 0, 800]);
	});
	await test("§2 forward-only on the open invoice's own days, a November day too: the invoice -$150, October as planned", async (t) => {
		const plan = basePlan("forward-only-own");
		plan.days = [...plan.days, { day: "2026-11-02", ledger: null, set: "250.00", invoice: CARRIER, paid: "300.00" }];
		plan.carrier = { ...plan.carrier, after: { adjustment: "-150.00", note: DRIVER_NOTE_DOWN } };
		const c = newCase({ plan });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the invoice -$150, the payout row $237", [invoiceRow(c).adjustment, payoutRow(c).adjustment], [-150, 237]);
		t.eq("the month as planned", r.result && r.result.ledger.difference, 0);
	});

	// §3 ───────────────────────────────────────────────────────────────────────
	for (const kind of ["forward-only", "october-300", "forward-only-own"]) {
		await test(`§3 the same rows as a person's through the lifted routes (${kind})`, async (t) => {
			const script = newCase({ plan: basePlan(kind) });
			t.eq("the script's run", (await run(script)).code, 0);
			const person = newCase({ plan: basePlan(kind) });
			const answers = await personPath(person, kind);
			t.ok("the routes took every edit", answers.every((a) => a.status === 200), JSON.stringify(answers.map((a) => [a.status, a.body && a.body.error])));
			const strip = (rows) => rows.map(({ action, entity, entity_id, details, timestamp }) => ({ action, entity, entity_id, details, timestamp }));
			t.eq("the same audit rows (action, entity, details, time)", strip(scriptAudits(script)), strip(query(person, "SELECT * FROM audit_trail ORDER BY id")));
			const pay = (x) => { const p = payoutRow(x); return [p.amount, p.adjustment, p.adjustment_note, p.adjusted_at, p.status]; };
			t.eq("the same payout row", pay(script), pay(person));
			const hist = (x) => query(x, "SELECT payout_id, owner_id, period, kind, old_amount, new_amount, delta, detail FROM investor_payout_history ORDER BY id");
			t.eq("the same history rows", hist(script), hist(person));
			const inv = (x) => { const r = invoiceRow(x); return [r.adjustment, r.adjustment_note, r.adjusted_at, r.status, r.total_earnings]; };
			t.eq("the same invoice row", inv(script), inv(person));
			t.eq("the same PDF", pdfOf(script), pdfOf(person));
		});
	}

	// §4 ───────────────────────────────────────────────────────────────────────
	const lock = (d) => d.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-15T05:00:00Z', 'test')").run(PERIOD);
	for (const [label, opts, why] of [
		["the month already closed", { db: lock }, /2026-10 is already closed/],
		["the month closed, october-300", { plan: basePlan("october-300"), db: lock }, /2026-10 is already closed/],
		["the payout row's adjustment not the plan's before", { db: (d) => d.prepare("UPDATE investor_payouts SET adjustment = 13 WHERE id = ?").run(PAYOUT_ID) }, /payout row carries \$13/],
		["the payout row's note changed", { db: (d) => d.prepare("UPDATE investor_payouts SET adjustment_note = 'made-up other note' WHERE id = ?").run(PAYOUT_ID) }, /payout row carries \$12 with a note/],
		["the payout row's before changed, october-300 (it writes no payout)", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE investor_payouts SET adjustment = 20 WHERE id = ?").run(PAYOUT_ID) }, /payout row carries \$20/],
		["the payout row finalized", { db: (d) => d.prepare("UPDATE investor_payouts SET finalized_at = '2026-11-15T05:00:00Z' WHERE id = ?").run(PAYOUT_ID) }, /finalized/],
		["the payout row paid", { db: (d) => d.prepare("UPDATE investor_payouts SET status = 'paid' WHERE id = ?").run(PAYOUT_ID) }, /is paid, not owed/],
		["the payout row another owner's", { db: (d) => d.prepare("UPDATE investor_payouts SET owner_id = 6 WHERE id = ?").run(PAYOUT_ID) }, /owner 6's 2026-10/],
		["the carrying invoice's adjustment not the plan's before", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE invoices SET adjustment = 5 WHERE id = ?").run(CARRIER) }, /carrying invoice 9104 carries \$5\.00/],
		["a wrong expected figure", { plan: basePlan("forward-only", { expectedEffective: BEFORE + 192 }) }, /not the plan's expected/],
		["a wrong expected figure, october-300", { plan: basePlan("october-300", { expectedEffective: BEFORE + 11 }) }, /not the plan's expected/],
		["the driver's own rate not the plan's", { db: (d) => d.prepare("UPDATE drivers_directory SET pay_daily = 280 WHERE driver_name = ?").run(GUS) }, /own rate is \$280\.00, not the plan's \$300\.00/],
		["the driver on two Drivers Database rows", { db: (d) => d.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily, pay_percentage) VALUES (?, 'Acme Carrier', 'fixed', 300, 0)").run(` ${GUS.toUpperCase()} `) }, /2 Drivers Database rows/],
		["a planned day the payout code doesn't count", { edit: (v) => { v[rowNo(v, "900203") - 1][IDX["Job Status"]] = "Cancelled"; } }, /2026-10-16: the payout code counts it 0 time/],
		["a day the payout code counts that the plan doesn't list", { edit: (v) => { v.push(W.HEADERS.map((h) => sheetRow({ id: "900208", driver: GUS, truck: "T1", pickup: "2026-10-27 8:00", dropoff: "2026-10-27 18:00", payment: "$500.00" })[h] ?? "")); } }, /on 2026-10-27/],
		["an invoice paying a day at another figure", { db: (d) => { const r = d.prepare("SELECT render_data FROM invoices WHERE id = 9103").get(); const s = JSON.parse(r.render_data); s.days.Tuesday.rate = 260; s.days.Tuesday.total = 260; d.prepare("UPDATE invoices SET render_data = ? WHERE id = 9103").run(JSON.stringify(s)); } }, /2026-10-20: invoice 9103 pays it at \$260\.00/],
		["a day the plan has unpaid that an invoice pays", { db: (d) => insertInvoice(d, manual({ id: 9105, number: "INV-M-GT-2026W43-01", period: "2026-10-30", status: "Draft", lines: [{ date: "2026-10-16", description: "made-up", amount: 250 }] })) }, /2026-10-16: the plan has no invoice paying it, but 9105/],
		["a day two live invoices pay", { db: (d) => insertInvoice(d, manual({ id: 9105, number: "INV-M-GT-2026W43-01", period: "2026-10-30", status: "Submitted", lines: [{ date: "2026-10-12", description: "made-up", amount: 250 }] })) }, /2026-10-12: the plan says invoice 9101 alone pays it, but 9101 at \$250\.00, 9105/],
		["a paying invoice already carrying an adjustment", { db: (d) => d.prepare("UPDATE invoices SET adjustment = 20 WHERE id = 9101").run() }, /invoice 9101 .* carries an adjustment/],
		["a paying invoice carrying a correction line", { db: (d) => d.prepare("UPDATE invoices SET correction_lines_total = 50 WHERE id = 9103").run() }, /invoice 9103 .* carries an adjustment or a correction line/],
		["the carrying invoice approved", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE invoices SET status = 'Approved', approved_at = '2026-11-10T12:00:00Z' WHERE id = ?").run(CARRIER) }, /9104 is Approved, not Submitted/],
		["an earlier open weekly invoice is the app's next one", { plan: basePlan("october-300"), db: (d) => insertInvoice(d, weekly({ id: 9106, number: "INV-GT-2026W43-01", weekStart: "2026-10-24", status: "Submitted", pays: { "2026-10-26": 300 } })) }, /next open weekly invoice after 2026-10-23 is 9106/],
		["the carrying invoice with a correction line on it", { plan: basePlan("october-300"), db: (d) => d.prepare("INSERT INTO invoice_correction_lines (source_invoice_id, source_invoice_number, source_week_start, source_week_end, kind, line_date, cents, label, invoice_id, created_at) VALUES (9101, 'INV-GT-2026W41-01', '2026-10-10', '2026-10-16', 'amount', '2026-10-12', 1000, 'made-up', ?, '2026-11-02T00:00:00Z')").run(CARRIER) }, /carries a Personal or correction line/],
		["the carrying invoice another driver's", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE invoices SET driver = ? WHERE id = ?").run(HAL, CARRIER) }, /not driver d-[0-9a-f]{8}'s|alone pays it/],
		["the carrying invoice sharing its PDF", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE invoices SET pdf_file_name = ? WHERE id = 9101").run(CARRIER_FILE) }, /PDF is another invoice's file too/],
	]) {
		await test(`§4 ${label}: nothing written`, async (t) => {
			await noOp(t, newCase(opts), why);
		});
	}
	await test("§4 a plan day at a figure the payout code does not price it at: nothing written", async (t) => {
		const plan = basePlan("forward-only-own");
		plan.days = plan.days.map((d) => (d.day === "2026-10-31" ? { ...d, ledger: "310.00" } : d));
		plan.payout = { ...plan.payout, after: { adjustment: 242, note: RATE_NOTE } };
		plan.expectedEffective = BEFORE + 242;
		await noOp(t, newCase({ plan }), /2026-10-31: the payout code counts it 1 time\(s\) at \$300\.00 .* not once at \$310\.00/);
	});
	await test("§4 a paying invoice's adjustment the plan knows exactly: the run goes ahead", async (t) => {
		const plan = basePlan("forward-only", { knownAdjustments: [{ invoice: 9103, adjustment: "-36.05", note: "made-up receipt recoupment" }] });
		const c = newCase({ plan, db: (d) => d.prepare("UPDATE invoices SET adjustment = -36.05, adjustment_note = 'made-up receipt recoupment' WHERE id = 9103").run() });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the payout row written", payoutRow(c).adjustment, 187);
		t.eq("the known invoice untouched", [invoiceRow(c, 9103).adjustment, invoiceRow(c, 9103).adjustment_note], [-36.05, "made-up receipt recoupment"]);
	});
	await test("§4 a known adjustment that differs from the invoice's: nothing written", async (t) => {
		const plan = basePlan("forward-only", { knownAdjustments: [{ invoice: 9103, adjustment: "-36.05", note: "made-up receipt recoupment" }] });
		await noOp(t, newCase({ plan, db: (d) => d.prepare("UPDATE invoices SET adjustment = -36.05, adjustment_note = 'made-up other note' WHERE id = 9103").run() }), /invoice 9103 .* carries an adjustment or a correction line the plan does not know/);
	});
	await test("§4 a known adjustment on an invoice that pays none of the days: nothing written", async (t) => {
		const plan = basePlan("forward-only", { knownAdjustments: [{ invoice: 9106, adjustment: "10.00", note: "made-up" }] });
		await noOp(t, newCase({ plan }), /knows an adjustment on invoice 9106, which pays none of its days/);
	});
	await test("§4 the payout code doesn't move the month by the plan's share (a loss absorbs it): nothing written", async (t) => {
		const plan = basePlan("forward-only", { expectedEffective: 187 });
		const c = newCase({ plan, db: (d) => d.prepare("UPDATE trucks SET insurance_monthly = 100000 WHERE unit_number = 'T1'").run() });
		await noOp(t, c, /with the days at their set figures the payout code moves owner 5's 2026-10 by \$0, not the plan's \$175/);
	});
	await test("§4 a carrying invoice of another driver's, open and his next one: nothing written", async (t) => {
		const plan = basePlan("october-300");
		plan.carrier = { ...plan.carrier, id: 9107 };
		const hal = { ...weekly({ id: 9107, number: "INV-HT-2026W44-01", weekStart: "2026-10-31", status: "Submitted", pays: { "2026-11-02": 260 } }), driver: HAL };
		await noOp(t, newCase({ plan, db: (d) => insertInvoice(d, hal) }), /the carrying invoice 9107 is not driver d-[0-9a-f]{8}'s/);
	});
	await test("§4 a day the plan says the investor's month does not count, which it counts: nothing written", async (t) => {
		const plan = basePlan("forward-only");
		plan.days = plan.days.map((d) => (d.day === "2026-10-12" ? { ...d, ledger: null } : d));
		plan.payout = { ...plan.payout, after: { adjustment: 162, note: RATE_NOTE } };
		plan.expectedEffective = BEFORE + 162;
		await noOp(t, newCase({ plan }), /2026-10-12: the payout code counts it 1 time\(s\) .* though the plan says that month does not count it/);
	});
	for (const [label, opts, why] of [
		["a weekly invoice of his over the plan's days whose grid can't be read", { db: (d) => d.prepare("UPDATE invoices SET render_data = '{}' WHERE id = 9103").run() }, /invoice 9103 \(2026W42-01\) covers the plan's days but has no day grid to read/],
		["an adjustment that takes the payout row below $0", { db: (d) => d.prepare("UPDATE investor_payouts SET amount = -200 WHERE id = ?").run(PAYOUT_ID) }, /would take owner 5's 2026-10 payout below \$0/],
		["a manual invoice named as the carrier", { plan: basePlan("october-300", { carrier: { id: 9111, before: { adjustment: "0.00", note: "" }, after: { adjustment: "300.00", note: DRIVER_NOTE_UP } } }), db: (d) => insertInvoice(d, manual({ id: 9111, number: "INV-M-GT-2026W44-02", period: "2026-11-05", status: "Submitted", lines: [{ date: "2026-11-05", description: "made-up", amount: 100 }] })) }, /the carrying invoice 9111 is a manual invoice/],
		["a carrier with no PDF to redraw", { plan: basePlan("october-300"), db: (d) => d.prepare("UPDATE invoices SET pdf_file_name = '' WHERE id = ?").run(CARRIER) }, /the carrying invoice 9104 has no render data or no PDF to redraw/],
		["a carrier the adjustment would take below $0", { plan: basePlan("forward-only-own"), db: (d) => d.prepare("UPDATE invoices SET total_earnings = 50 WHERE id = ?").run(CARRIER) }, /would take the carrying invoice 9104 below \$0/],
	]) {
		await test(`§4 ${label}: nothing written`, async (t) => {
			await noOp(t, newCase(opts), why);
		});
	}
	await test("§4 the plan's path is not --path: refused before anything is read", async (t) => {
		const c = newCase({ plan: basePlan("october-300") });
		const before = hashes(c);
		const r = await run(c, "--apply", { argv: args(c, "--apply", "forward-only") });
		t.eq("exit code", r.code, 2);
		t.eq("the sheet not even read", c.fake.calls.length, 0);
		t.eq("every table as it was", hashes(c), before);
		t.ok("says why", /october-300 plan, not forward-only/.test(r.out), r.out.slice(0, 300));
	});
	await test("§4 a plan whose figures don't add up: refused before anything is read", async (t) => {
		const fwd = basePlan("forward-only");
		const up = basePlan("october-300");
		for (const [label, plan, why] of [
			["the payout move", { ...fwd, payout: { ...fwd.payout, after: { adjustment: 186, note: RATE_NOTE } } }, /moves the payout adjustment by \$174, not 50% of the days' \$350\.00/],
			["the carrier move", { ...up, carrier: { ...up.carrier, after: { adjustment: "250.00", note: DRIVER_NOTE_UP } } }, /moves the carrying invoice by \$250\.00, not the days' \$300\.00/],
			["october-300 moving a day off the ledger", { ...up, days: up.days.map((d) => (d.day === "2026-10-16" ? { ...d, set: "250.00" } : d)), payout: { ...up.payout, after: { adjustment: 37, note: RATE_NOTE } } }, /is october-300 but moves 2026-10-16/],
			["forward-only raising a day", { ...fwd, days: fwd.days.map((d) => (d.day === "2026-10-16" ? { ...d, set: "310.00" } : d)), payout: { ...fwd.payout, after: { adjustment: 157, note: RATE_NOTE } } }, /is forward-only but raises 2026-10-16/],
			["october-300 with no carrier", { ...up, carrier: null }, /names no carrying invoice/],
			["an invoice with no paid figure", { ...fwd, days: fwd.days.map((d) => (d.day === "2026-10-12" ? { day: d.day, ledger: d.ledger, set: d.set, invoice: 9101 } : d)) }, /invoice and paid go together/],
			["a day with neither a ledger figure nor an invoice", { ...fwd, days: fwd.days.map((d) => (d.day === "2026-10-16" ? { day: d.day, ledger: null, set: d.set } : d)) }, /neither a ledger figure nor an invoice/],
			["a day twice", { ...fwd, days: [...fwd.days, fwd.days[0]] }, /names 2026-10-12 twice/],
			["a note over two lines", { ...fwd, payout: { ...fwd.payout, after: { adjustment: 187, note: "line one\nline two" } } }, /payout\.after's note/],
			["a payout adjustment in cents", { ...fwd, payout: { ...fwd.payout, after: { adjustment: 187.5, note: RATE_NOTE } } }, /whole dollars/],
			["no expected figure", { ...fwd, expectedEffective: undefined }, /expectedEffective/],
			["an unknown field", { ...fwd, extra: 1 }, /unknown fields: extra/],
		]) {
			const c = newCase({ plan });
			const before = hashes(c);
			const r = await run(c);
			t.eq(`${label}: refused`, r.code, 2);
			t.eq(`${label}: the sheet not even read`, c.fake.calls.length, 0);
			t.eq(`${label}: every table as it was`, hashes(c), before);
			t.ok(`${label}: says why`, why.test(r.out), r.out.slice(0, 300));
		}
	});
	await test("§4 with LOCAL_REPLICA set: refused, nothing read", async (t) => {
		const c = newCase();
		const was = process.env.LOCAL_REPLICA;
		process.env.LOCAL_REPLICA = "made-up-task";
		let r;
		try { r = await run(c); } finally { if (was === undefined) delete process.env.LOCAL_REPLICA; else process.env.LOCAL_REPLICA = was; }
		t.eq("exit code", r.code, 2);
		t.eq("the sheet not even read", c.fake.calls.length, 0);
		t.ok("says why", /LOCAL_REPLICA/.test(r.out), r.out.slice(0, 200));
	});

	// §5 ───────────────────────────────────────────────────────────────────────
	for (const kind of ["forward-only", "october-300", "forward-only-own"]) {
		await test(`§5 a replay writes nothing (${kind})`, async (t) => {
			const c = newCase({ plan: basePlan(kind) });
			t.eq("the first run", (await run(c)).code, 0);
			const rendered = c.renders.length;
			const before = hashes(c);
			const pdf = pdfOf(c);
			const r = await run(c);
			t.eq("exit code", r.code, 0);
			t.eq("every table as it was (no audit row either)", hashes(c), before);
			t.eq("nothing rendered again, the PDF as it was", [c.renders.length, pdfOf(c)], [rendered, pdf]);
			t.eq("result: already done", r.result && [r.result.outcome, r.result.payout.state, r.result.carrier ? r.result.carrier.state : null], ["already-done", kind === "october-300" ? "unchanged" : "already-done", kind === "forward-only" ? null : "already-done"]);
			const dry = await run(c, "--dry-run");
			t.eq("a dry run after it: already done", dry.result && [dry.code, dry.result.outcome], [0, "already-done"]);
		});
	}
	await test("§5 a failed render: the route puts the invoice back, nothing is written, and a re-run finishes", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own"), renderFail: true });
		const before = hashes(c);
		const r1 = await run(c);
		t.eq("exit code (incomplete)", r1.code, 1);
		t.eq("result: partial, the invoice failed, the payout not tried", r1.result && [r1.result.outcome, r1.result.carrier.state, r1.result.payout.state], ["partial", "failed", "to-write"]);
		t.eq("every table as it was", hashes(c), before);
		const c2 = { ...c, render: async (n, data) => Buffer.from(`%PDF-made-up ${n} adjustment=${data.adjustment}`) };
		const r2 = await run(c2);
		t.eq("the re-run: exit code", r2.code, 0);
		t.eq("the re-run: both written", [invoiceRow(c).adjustment, payoutRow(c).adjustment], [-100, 237]);
	});
	await test("§5 the month closing between the two writes: the invoice's stands, the payout's is refused and audited", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own"), onRender: (copy) => { const d = new W.Database(copy.db); lock(d); d.close(); } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("result: partial; the invoice written, the payout failed", r.result && [r.result.outcome, r.result.carrier.state, r.result.payout.state], ["partial", "written", "failed"]);
		t.eq("the invoice's adjustment written", invoiceRow(c).adjustment, -100);
		t.eq("the payout row as it was", payoutRow(c).adjustment, 12);
		t.ok("the payout route's refusal audited as the route audits it", scriptAudits(c).some((a) => a.action === "investor_payout_adjust_blocked" && /\[PERIOD_FINALIZED\]/.test(a.details)), JSON.stringify(scriptAudits(c).map((a) => a.action)));
		const r2 = await run({ ...c, renders: [] });
		t.eq("a re-run then refuses: the month is closed", r2.code, 2);
	});

	await test("§5 the invoice changed by a person after the checks: the run stops before writing it", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own") });
		let fired = false;
		const onLog = (s) => { if (!fired && /^ {2}WRITE invoices/.test(s)) { fired = true; const d = new W.Database(c.db); d.prepare("UPDATE invoices SET adjustment = 5, adjustment_note = 'made-up by a person' WHERE id = ?").run(CARRIER); d.close(); } };
		const r = await run(c, "--apply", { onLog });
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("result: the invoice not written, the payout not tried", r.result && [r.result.outcome, r.result.carrier.state, r.result.payout.state], ["partial", "not-written", "to-write"]);
		t.eq("the person's adjustment stands, the payout row as it was", [invoiceRow(c).adjustment, invoiceRow(c).adjustment_note, payoutRow(c).adjustment], [5, "made-up by a person", 12]);
		t.eq("nothing rendered, no audit row", [c.renders.length, scriptAudits(c).length], [0, 0]);
	});
	await test("§5 the payout row changed by a person between the two writes: the invoice's stands, the payout's is not written", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own"), onRender: (copy) => { const d = new W.Database(copy.db); d.prepare("UPDATE investor_payouts SET adjustment = 13 WHERE id = ?").run(PAYOUT_ID); d.close(); } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("result: the invoice written, the payout not", r.result && [r.result.outcome, r.result.carrier.state, r.result.payout.state], ["partial", "written", "not-written"]);
		t.eq("the person's figure stands", payoutRow(c).adjustment, 13);
		t.eq("one audit row, the invoice's", scriptAudits(c).map((a) => a.action), ["adjust_invoice"]);
	});

	// §6 ───────────────────────────────────────────────────────────────────────
	await test("§6 the payout code reads back other than the plan's figure: exit 3, and by how much", async (t) => {
		const c = newCase({ plan: basePlan("october-300"), hooks: { onGet: (n, rows) => { if (n === 2) rows[rowNo(rows, "900206") - 1][IDX["  Payment  "]] = "$3,310.00"; } } });
		const r = await run(c);
		t.eq("exit code", r.code, 3);
		t.eq("the write is still made", invoiceRow(c).adjustment, 300);
		t.eq("the difference", r.result && r.result.ledger.difference, 5);
		t.ok("it says it differs by $5", /differs by \$5/.test(r.out), r.out.slice(-500));
	});
	await test("§6 the investor's closed-month rows changing during the run: exit 1, unconfirmed", async (t) => {
		const c = newCase({ plan: basePlan("october-300"), onRender: (copy) => { const d = new W.Database(copy.db); d.prepare("UPDATE investor_payouts SET notes = 'made-up' WHERE owner_id = ? AND period = '2026-09'").run(OWNER); d.close(); } });
		const r = await run(c);
		t.eq("exit code", r.code, 1);
		t.eq("result: unconfirmed", r.result && r.result.outcome, "unconfirmed");
		t.ok("it says so", /closed-month rows changed/.test(r.out), r.out.slice(-300));
	});
	await test("§6 the months before October as they were, and the closed months' rows untouched", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-own") });
		const closed = () => query(c, "SELECT * FROM investor_payouts WHERE period IN ('2026-08', '2026-09') ORDER BY id");
		const was = closed();
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("no earlier month moved", r.result && r.result.ledger.earlierMonthsMoved, []);
		t.eq("the closed months' rows untouched", closed(), was);
		t.eq("the fingerprint before and after", r.result && r.result.closedMonths.before.hash, r.result && r.result.closedMonths.after.hash);
		t.ok("September is in the payout code's months", r.result && r.result.ledger.months.some((m) => m.month === "2026-09"));
	});

	// §7 ───────────────────────────────────────────────────────────────────────
	await test("§7 the lift names what the walk misses, registers both routes, and leaves nothing out", async (t) => {
		const d = W.schemaDb();
		const api = FIX.liftServer({ db: d, env: {}, nowMs: NOW, dataDir: os.tmpdir(), render: async () => Buffer.from("x") });
		t.ok("assertInvoiceFileStillOwn and recordPayoutChange named and lifted", ["assertInvoiceFileStillOwn", "recordPayoutChange"].every((n) => FIX.ROOTS.includes(n) && api.liftedNames.includes(n)));
		t.eq("both routes registered", [typeof api.adjustPayout, typeof api.adjustInvoice], ["function", "function"]);
		t.eq("the key path is server.js's own KEY_FILE", api.KEY_FILE, new Function(`${closure(W.SRC, { roots: ["KEY_FILE"] }).text}\nreturn KEY_FILE;`)());
		for (const name of ["assertInvoiceFileStillOwn", "recordPayoutChange"]) {
			let refused = "";
			try { FIX.liftServer({ db: d, env: {}, nowMs: NOW, roots: FIX.ROOTS.filter((n) => n !== name) }); } catch (e) { refused = e instanceof FIX.Refusal ? e.message : `not a refusal: ${e.message}`; }
			t.ok(`a lift without ${name} is refused, naming it`, new RegExp(name).test(refused), refused);
		}
		d.close();
	});
	await test("§7 a run whose lift leaves a name out is refused before anything is read or written", async (t) => {
		const c = newCase({ plan: basePlan("october-300") });
		const before = hashes(c);
		const r = await run(c, "--apply", { roots: FIX.ROOTS.filter((n) => n !== "assertInvoiceFileStillOwn") });
		t.eq("exit code", r.code, 2);
		t.eq("the sheet not even read", c.fake.calls.length, 0);
		t.eq("every table as it was", hashes(c), before);
		t.ok("names the missing one", /assertInvoiceFileStillOwn/.test(r.out), r.out.slice(0, 300));
	});
	await test("§7 what an invoice pays a day: a weekly grid's rate, a manual line's amount, nothing else", ({ eq }) => {
		const d = W.schemaDb();
		const api = FIX.liftServer({ db: d, env: {}, nowMs: NOW });
		const w = INVOICES[0];
		const m = INVOICES[1];
		eq("the weekly grid", [FIX.invoicePays(api, w, "2026-10-12"), FIX.invoicePays(api, w, "2026-10-14")], [{ cents: 25000 }, null]);
		eq("the manual lines", [FIX.invoicePays(api, m, "2026-10-14"), FIX.invoicePays(api, m, "2026-10-12")], [{ cents: 25000 }, null]);
		d.close();
	});

	// §8 ───────────────────────────────────────────────────────────────────────
	await test("§8 the command line: each required argument, one mode, no unknown option", async (t) => {
		const c = newCase();
		const base = args(c, null);
		const drop = (p) => base.filter((a) => !a.startsWith(p));
		for (const [label, argv, why] of [
			["no --path", drop("--path="), /--path/],
			["a made-up --path", [...drop("--path="), "--path=backwards"], /--path must be/],
			["no --db", drop("--db="), /--db/],
			["no sheet", drop("--sheet-id="), /--sheet-id/],
			["both sheets", [...base, `--values-json=${c.values}`], /not both/],
			["no --plan", drop("--plan="), /--plan/],
			["no --result", drop("--result="), /--result/],
			["both modes", [...base, "--dry-run", "--apply"], /not both/],
			["a key option", [...base, "--key=made-up.json"], /unknown/],
			["a stray word", [...base, "now"], /unknown/],
			["a copy with no settings file", drop("--settings-file="), /--settings-file=<…> is required with a copy/],
		]) {
			const out = [];
			const code = await FIX.main(argv, { sheets: c.fake.client, nowMs: NOW, render: c.render, log: (s) => out.push(s), err: (s) => out.push(s) });
			t.eq(`${label}: refused`, code, 2);
			t.ok(`${label}: says why`, why.test(out.join("\n")), out.join("\n").slice(0, 200));
		}
		t.eq("nothing was read", c.fake.calls.length, 0);
	});
	await test("§8 the plan, the result and the settings stay outside the repository; the database is the app's or a temp copy", async (t) => {
		const c = newCase();
		const inRepo = path.join(ROOT, "made-up-rate-result.json");
		const swap = (prefix, v) => args(c).map((a) => (a.startsWith(prefix) ? `${prefix}${v}` : a));
		for (const [label, argv, why] of [
			["a result inside the repository", swap("--result=", inRepo), /outside the repository/],
			["a plan inside the repository", swap("--plan=", path.join(ROOT, "package.json")), /outside the repository/],
			["settings inside the repository", swap("--settings-file=", path.join(ROOT, "package.json")), /outside the repository/],
			["a database elsewhere", swap("--db=", path.join(ROOT, "client", "made-up.db")), /refusing|no file/],
		]) {
			const out = [];
			const code = await FIX.main(argv, { sheets: c.fake.client, nowMs: NOW, render: c.render, log: (s) => out.push(s), err: (s) => out.push(s) });
			t.eq(`${label}: refused`, code, 2);
			t.ok(`${label}: says why`, why.test(out.join("\n")), out.join("\n").slice(0, 200));
		}
		t.eq("no result file inside the repository", fs.existsSync(inRepo), false);
		t.eq("nothing was read", c.fake.calls.length, 0);
	});
	await test("§8 a copy may read a saved Job Tracking tab in place of the sheet", async (t) => {
		const c = newCase();
		const out = [];
		const argv = args(c, "--dry-run").map((a) => (a.startsWith("--sheet-id=") ? `--values-json=${c.values}` : a));
		const code = await FIX.main(argv, { nowMs: NOW, render: c.render, log: (s) => out.push(s), err: (s) => out.push(s) });
		t.eq("exit code", code, 0);
		t.ok("it names the saved values", /saved values/.test(out.join("\n")), out.join("\n").slice(0, 300));
	});
	await test("§8 the Sheets key is the app's own: started outside the app's folder, refused before any client", async ({ ok }) => {
		let refused = "";
		try { await FIX.googleSheets({ keyFile: "./made-up-key.json", cwd: os.tmpdir() }); } catch (e) { refused = e instanceof FIX.Refusal ? e.message : `not a refusal: ${e.message}`; }
		ok("refused, saying to run it from the app's folder", /app's own folder/.test(refused), refused);
	});
	await test("§8 the driver's tag and an invoice number's tail", ({ eq }) => {
		eq("a tag is 8 hex of the sha256 of the normalized name", FIX.driverTag("made-up name"), `d-${crypto.createHash("sha256").update("made-up name").digest("hex").slice(0, 8)}`);
		eq("no name, no tag", FIX.driverTag(""), "");
		eq("the initials come off", [FIX.numberTail("INV-GT-2026W44-01"), FIX.numberTail("INV-M-GT-2026W42-01")], ["2026W44-01", "2026W42-01"]);
	});

	// §9 ───────────────────────────────────────────────────────────────────────
	// The same difference posted already, somewhere the day checks don't look.
	const laterWeekly = () => weekly({ id: 9107, number: "INV-GT-2026W45-01", weekStart: "2026-11-07", status: "Submitted", pays: { "2026-11-09": 300 } });
	const withLaterAdjustment = (d) => { insertInvoice(d, laterWeekly()); d.prepare("UPDATE invoices SET adjustment = 300, adjustment_note = 'made-up October rate difference' WHERE id = 9107").run(); };
	const posted = [
		["a later weekly invoice of his carrying an adjustment", withLaterAdjustment, /invoice 9107 \(2026W45-01, Submitted, week 2026-11-07\.\.2026-11-13\) carries adjustment \$300\.00/],
		["a manual invoice of his dated in November", (d) => insertInvoice(d, manual({ id: 9108, number: "INV-M-GT-2026W45-01", period: "2026-11-13", status: "Draft", lines: [{ date: "2026-11-13", description: "made-up October rate difference", amount: 300 }] })), /invoice 9108 .* 1 manual line\(s\) off the planned days \(\$300\.00\)/],
		["a later invoice of his carrying a correction total", (d) => { insertInvoice(d, laterWeekly()); d.prepare("UPDATE invoices SET correction_lines_total = 300 WHERE id = 9107").run(); }, /invoice 9107 .* correction lines \$300\.00/],
		["a paying manual invoice with a line off the planned days", (d) => { const s = JSON.parse(d.prepare("SELECT render_data FROM invoices WHERE id = 9102").get().render_data); s.lineItems.push({ date: "2026-11-10", description: "made-up October rate difference", amount: 300 }); d.prepare("UPDATE invoices SET render_data = ? WHERE id = 9102").run(JSON.stringify(s)); }, /invoice 9102 .* 1 manual line\(s\) off the planned days \(\$300\.00\)/],
		["a paying manual invoice with a deduction", (d) => { const s = JSON.parse(d.prepare("SELECT render_data FROM invoices WHERE id = 9102").get().render_data); s.deductions.push({ date: "2026-11-10", description: "made-up October rate difference", amount: 100 }); d.prepare("UPDATE invoices SET render_data = ? WHERE id = 9102").run(JSON.stringify(s)); }, /invoice 9102 .* 1 manual line\(s\) off the planned days \(-\$100\.00\)/],
		["a correction line of his waiting for an invoice", (d) => d.prepare("INSERT INTO invoice_correction_lines (source_invoice_id, source_invoice_number, source_week_start, source_week_end, kind, line_date, cents, label, invoice_id, waiting_since, created_at) VALUES (9103, 'INV-GT-2026W42-01', '2026-10-17', '2026-10-23', 'amount', '2026-10-20', 30000, 'made-up', NULL, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')").run(), /correction line \d+ \(amount, \$300\.00, to 2026W42-01\) waits for his next invoice/],
	];
	for (const kind of ["october-300", "forward-only-own"]) {
		for (const [label, db, why] of posted) {
			await test(`§9 ${kind}: ${label}, not acknowledged: nothing written`, async (t) => {
				await noOp(t, newCase({ plan: basePlan(kind), db }), why);
			});
		}
	}
	const fingerprintIn = (r, id) => { const m = new RegExp(`\\{ "invoice": ${id}, "fingerprint": "([0-9a-f]{16})" \\}`).exec(((r.result && r.result.problems) || []).join(" ")); return m ? m[1] : null; };
	await test("§9 an invoice a person read and acknowledged by its fingerprint: the run goes ahead", async (t) => {
		const r1 = await run(newCase({ plan: basePlan("october-300"), db: withLaterAdjustment }), "--dry-run");
		const fp = fingerprintIn(r1, 9107);
		t.ok("the dry run refuses, printing the invoice's fingerprint", r1.code === 2 && Boolean(fp), JSON.stringify(r1.result && r1.result.problems));
		const c = newCase({ plan: basePlan("october-300", { acknowledged: [{ invoice: 9107, fingerprint: fp || "0".repeat(16) }] }), db: withLaterAdjustment });
		const r = await run(c);
		t.eq("acknowledged: exit code", r.code, 0);
		t.eq("the carrying invoice written, the acknowledged one untouched", [invoiceRow(c).adjustment, invoiceRow(c, 9107).adjustment], [300, 300]);
		t.eq("…and listed as acknowledged", r.result && r.result.others.map((o) => [o.id, o.acknowledged]), [[9107, true]]);
	});
	await test("§9 an acknowledged invoice that changed since: nothing written", async (t) => {
		const fp = fingerprintIn(await run(newCase({ plan: basePlan("october-300"), db: withLaterAdjustment }), "--dry-run"), 9107);
		const c = newCase({ plan: basePlan("october-300", { acknowledged: [{ invoice: 9107, fingerprint: fp || "0".repeat(16) }] }), db: (d) => { withLaterAdjustment(d); d.prepare("UPDATE invoices SET adjustment_note = 'made-up other note' WHERE id = 9107").run(); } });
		await noOp(t, c, /invoice 9107 .* not what the plan acknowledged/);
	});
	await test("§9 acknowledging an invoice that carries nothing: nothing written", async (t) => {
		await noOp(t, newCase({ plan: basePlan("october-300", { acknowledged: [{ invoice: 9101, fingerprint: "0123456789abcdef" }] }) }), /acknowledges invoice 9101, which carries nothing of his/);
	});
	await test("§9 a plan that pays the driver a difference must say what it has read: refused before anything is read", async (t) => {
		const plan = basePlan("october-300");
		delete plan.acknowledged;
		const c = newCase({ plan });
		const r = await run(c);
		t.eq("exit code", r.code, 2);
		t.eq("the sheet not even read", c.fake.calls.length, 0);
		t.ok("says why", /acknowledged: a list, which may be empty/.test(r.out), r.out.slice(0, 300));
	});
	await test("§9 forward-only pays the driver nothing, so a later invoice's adjustment doesn't stop it", async (t) => {
		const c = newCase({ db: withLaterAdjustment });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the payout row written", payoutRow(c).adjustment, 187);
	});
	await test("§9 an invoice posted after the checks: the run stops before the carrying invoice", async (t) => {
		const c = newCase({ plan: basePlan("october-300") });
		let fired = false;
		const onLog = (s) => { if (!fired && /^ {2}WRITE invoices/.test(s)) { fired = true; const d = new W.Database(c.db); withLaterAdjustment(d); d.close(); } };
		const r = await run(c, "--apply", { onLog });
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("result: the invoice not written", r.result && [r.result.outcome, r.result.carrier.state], ["partial", "not-written"]);
		t.eq("the carrying invoice as it was, nothing rendered", [invoiceRow(c).adjustment, c.renders.length], [0, 0]);
	});

	// §10 ──────────────────────────────────────────────────────────────────────
	// D's yes: a load of his booked to the company moves to owner 5 first.
	const OWNER_COL = W.HEADERS.indexOf("Owner ID");
	const TRUCK_COL = W.HEADERS.indexOf("Truck");
	const letter = (i) => String.fromCharCode(65 + i);
	const moveCells = (c) => [c.fake.rows[MOVE_ROW - 1][OWNER_COL], c.fake.rows[MOVE_ROW - 1][TRUCK_COL]];
	for (const kind of ["forward-only-yes", "october-300-yes"]) {
		await test(`§10 the dry run (${kind}) reads the month with the row moved and writes nothing`, async (t) => {
			const c = newCase({ plan: basePlan(kind) });
			const before = hashes(c);
			const r = await run(c, "--dry-run");
			t.eq("exit code", r.code, 0);
			t.eq("no sheet write, every table as it was", [c.fake.writes.length, hashes(c)], [0, before]);
			t.eq("the row it would move", r.result && r.result.rows, [{ load: "900209", row: MOVE_ROW, before: ["0", ""], after: ["5", "T1"], state: "to-write" }]);
			t.eq("the month with the row moved", r.result && [r.result.ledger.recomputed, r.result.ledger.effectiveAfter], [MOVED, basePlan(kind).expectedEffective]);
			t.ok("the row's two cells in the writes it lists", ["Owner ID", "Truck"].every((col) => (r.result.writes || []).some((w) => w.table === "Job Tracking" && w.column === col)));
		});
	}
	await test("§10 forward-only with the row moved: the row's two cells, then the payout row", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes") });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		const cells = [[TRUCK_COL, "T1"], [OWNER_COL, "5"]].sort((a, b) => a[0] - b[0]).map(([i, v]) => [`'Job Tracking'!${letter(i)}${MOVE_ROW}`, [[v]]]);
		t.eq("one sheet write: the row's two cells, as the sheet's own entry", c.fake.writes.map((w) => [w.valueInputOption, w.data.map((x) => [x.range, x.values])]), [["USER_ENTERED", cells]]);
		t.eq("the row now owner 5's, on T1", moveCells(c), ["5", "T1"]);
		t.eq("the payout row $237", payoutRow(c).adjustment, 237);
		const a = scriptAudits(c);
		t.eq("audit rows: the row's save, then the adjustment, as the system", a.map((x) => [x.action, x.entity, x.entity_id, x.user_id, x.role]), [["update_sheet_row", "sheet_row", `Job Tracking!${MOVE_ROW}`, 0, "system"], ["investor_payout_adjust", "investor_payout", String(PAYOUT_ID), 0, "system"]]);
		t.eq("the row's audit keeps each cell's before and after", a[0] && JSON.parse(a[0].details).changed.map((x) => [x.column, x.from, x.to]).sort(), [["Owner ID", "0", "5"], ["Truck", "", "T1"]]);
		t.eq("the month as planned, the row read back", r.result && [r.result.ledger.effectiveReadBack, r.result.ledger.difference, r.result.rows[0].readBack], [MOVED + 237, 0, "ok"]);
	});
	await test("§10 october-300 with the row moved: the row, then the carrying invoice", async (t) => {
		const c = newCase({ plan: basePlan("october-300-yes") });
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("the row moved, the invoice +$350, the payout row as it was", [...moveCells(c), invoiceRow(c).adjustment, payoutRow(c).adjustment], ["5", "T1", 350, 12]);
		t.eq("audit rows: the row's save, then the invoice's", scriptAudits(c).map((x) => x.action), ["update_sheet_row", "adjust_invoice"]);
		t.eq("the month as planned", r.result && r.result.ledger.effectiveReadBack, MOVED + 12);
	});
	await test("§10 the row's save is the Data Manager's: the same cells and audit rows through PUT /api/data/:rowIndex", async (t) => {
		const script = newCase({ plan: basePlan("forward-only-yes") });
		t.eq("the script's run", (await run(script)).code, 0);
		const person = newCase({ plan: basePlan("forward-only-yes") });
		const answers = await rowPersonPath(person, basePlan("forward-only-yes"));
		t.ok("the routes took both edits", answers.every((x) => x.status === 200), JSON.stringify(answers.map((x) => [x.status, x.body && x.body.error])));
		t.eq("the same sheet write", script.fake.writes, person.fake.writes);
		const strip = (rows) => rows.map(({ action, entity, entity_id, details, timestamp }) => ({ action, entity, entity_id, details, timestamp }));
		t.eq("the same audit rows (action, entity, details, time)", strip(scriptAudits(script)), strip(query(person, "SELECT * FROM audit_trail ORDER BY id")));
		const pay = (x) => { const p = payoutRow(x); return [p.adjustment, p.adjustment_note, p.adjusted_at]; };
		t.eq("the same payout row", pay(script), pay(person));
	});
	await test("§10 a replay writes nothing", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes") });
		t.eq("the first run", (await run(c)).code, 0);
		const writes = c.fake.writes.length;
		const before = hashes(c);
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("no sheet write, every table as it was", [c.fake.writes.length, hashes(c)], [writes, before]);
		t.eq("result: already done", r.result && [r.result.outcome, r.result.rows[0].state, r.result.payout.state], ["already-done", "already-done", "already-done"]);
	});
	const yesRow = (v) => v[MOVE_ROW - 1];
	for (const [label, opts, why] of [
		["the row not at the plan's before", { edit: (v) => { yesRow(v)[OWNER_COL] = "3"; } }, /load 900209 \(row \d+\) shows Owner ID "3"/],
		["the load on another row", { plan: basePlan("forward-only-yes", { rows: [{ ...moveRows()[0], row: 99 }] }) }, /load 900209 is on row \d+, not the plan's 99/],
		["the load on two rows", { edit: (v) => { v.push(yesRow(v).slice()); } }, /load 900209: 2 Job Tracking rows carry it/],
		["the row not his", { edit: (v) => { yesRow(v)[W.HEADERS.indexOf("Driver")] = HAL; } }, /load 900209 \(row \d+\) is not driver/],
		["a truck not owner 5's", { plan: basePlan("forward-only-yes", { rows: [{ ...moveRows()[0], cells: { ...moveRows()[0].cells, Truck: { before: "", after: "T9" } } }] }) }, /truck "T9" is not one truck of owner 5/],
		["a row in a closed month (the edit guard refuses its save)", { edit: (v) => { const r = yesRow(v); r[W.HEADERS.indexOf("Pickup Appointment")] = "9/29/2026 8:00"; r[W.HEADERS.indexOf("Assigned Date")] = "9/29/2026"; } }, /load 900209: the save would be refused \(PERIOD_/],
	]) {
		await test(`§10 ${label}: nothing written`, async (t) => {
			const c = newCase({ plan: basePlan("forward-only-yes"), ...opts });
			await noOp(t, c, why);
			t.eq("no sheet write", c.fake.writes.length, 0);
		});
	}
	await test("§10 a plan's rows that move anything but the two cells, or to another investor: refused before anything is read", async (t) => {
		const row = moveRows()[0];
		for (const [label, rows, why] of [
			["a Payment cell", [{ ...row, cells: { ...row.cells, "  Payment  ": { before: "$1,000.00", after: "$1.00" } } }], /must move exactly Owner ID and Truck/],
			["Owner ID to another investor", [{ ...row, cells: { ...row.cells, "Owner ID": { before: "0", after: "6" } } }], /Owner ID to the plan's investor, 5/],
			["a formula", [{ ...row, cells: { ...row.cells, Truck: { before: "", after: "=T1" } } }], /not one plain cell/],
		]) {
			const c = newCase({ plan: basePlan("forward-only-yes", { rows }) });
			const r = await run(c);
			t.eq(`${label}: refused`, r.code, 2);
			t.eq(`${label}: the sheet not even read`, c.fake.calls.length, 0);
			t.ok(`${label}: says why`, why.test(r.out), r.out.slice(0, 300));
		}
	});
	await test("§10 saved values can't take a plan's rows to the sheet: an apply refused", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes") });
		const r = await run(c, "--apply", { argv: args(c).map((a) => (a.startsWith("--sheet-id=") ? `--values-json=${c.values}` : a)) });
		t.eq("exit code", r.code, 2);
		t.ok("says why", /--values-json is for a dry run/.test(r.out), r.out.slice(0, 300));
	});
	await test("§10 the row's write refused by the sheet: nothing else written, and a re-run finishes", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes"), failWrite: { nth: 1, mode: "refused" } });
		const r1 = await run(c);
		t.eq("exit code (incomplete)", r1.code, 1);
		t.eq("result: partial, the row failed, the payout not tried", r1.result && [r1.result.outcome, r1.result.rows[0].state, r1.result.payout.state], ["partial", "failed", "to-write"]);
		t.eq("the failed save's own audit row", scriptAudits(c).map((a) => a.action), ["update_sheet_row_failed"]);
		t.eq("the payout row as it was", payoutRow(c).adjustment, 12);
		const r2 = await run({ ...c, fake: fakeSheets(c.fake.rows) });
		t.eq("the re-run: exit code", r2.code, 0);
		t.eq("the re-run: the row and the payout written", [r2.result && r2.result.rows[0].state, payoutRow(c).adjustment], ["written", 237]);
	});
	await test("§10 a row that doesn't read back as written: exit 1, unconfirmed", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes"), hooks: { onGet: (n, rows) => { if (n === 2) rows[MOVE_ROW - 1][OWNER_COL] = "0"; } } });
		const r = await run(c);
		t.eq("exit code", r.code, 1);
		t.eq("result: unconfirmed, naming the row", r.result && [r.result.outcome, r.result.rows[0].readBack], ["unconfirmed", "differs"]);
		t.ok("it says so", new RegExp(`READ BACK: row ${MOVE_ROW} \\(load 900209\\) does not read back`).test(r.out), r.out.slice(-300));
	});
	await test("§10 a sheet whose Job Tracking tab the closed-month guard doesn't cover: nothing written", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes") });
		c.fake.client.spreadsheets.get = async () => ({ data: { sheets: [{ properties: { title: "Carrier Database", sheetId: 7 } }] } });
		await noOp(t, c, /no Job Tracking tab the closed-month guard covers/);
		t.eq("no sheet write", c.fake.writes.length, 0);
	});
	await test("§10 the row changed after the checks: that save stops, nothing written for it", async (t) => {
		const c = newCase({ plan: basePlan("forward-only-yes"), hooks: { onBatchGet: (r, rows) => { if (r === MOVE_ROW) rows[r - 1][W.HEADERS.indexOf("Details")] = "made-up note added meanwhile"; } } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("result: the row not written, and why", r.result && [r.result.rows[0].state, r.result.rows[0].code], ["not-written", "ROW_CHANGED_SINCE_CHECK"]);
		t.eq("no sheet write, the payout row as it was", [c.fake.writes.length, payoutRow(c).adjustment], [0, 12]);
	});

	// §11 ──────────────────────────────────────────────────────────────────────
	// The routes record their own rows and swallow a failed insert (logging it): the
	// read back requires them. The routes' own log lines are kept off this output.
	const quietly = async (fn) => { const was = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = was; } };
	await test("§11 a route's audit row that didn't land: exit 1, unconfirmed", async (t) => {
		const c = newCase({ plan: basePlan("october-300"), db: (d) => d.exec("CREATE TRIGGER made_up_no_audit BEFORE INSERT ON audit_trail BEGIN SELECT RAISE(ABORT, 'made-up audit failure'); END;") });
		const r = await quietly(() => run(c));
		t.eq("exit code", r.code, 1);
		t.eq("result: unconfirmed", r.result && r.result.outcome, "unconfirmed");
		t.ok("it says the audit rows don't read back", /audit rows read back 0, not one for each of the 1 write/.test(r.out), r.out.slice(-400));
	});
	await test("§11 the payout row's history row that didn't land: exit 1, unconfirmed", async (t) => {
		const c = newCase({ db: (d) => d.exec("CREATE TRIGGER made_up_no_history BEFORE INSERT ON investor_payout_history BEGIN SELECT RAISE(ABORT, 'made-up history failure'); END;") });
		const r = await quietly(() => run(c));
		t.eq("exit code", r.code, 1);
		t.ok("it says the history row doesn't read back", /history row reads back 0 time\(s\), not once/.test(r.out), r.out.slice(-400));
	});

	// §12 ──────────────────────────────────────────────────────────────────────
	await test("§12 the source: no production sheet, no key option, no real load numbers or driver tags", ({ ok }) => {
		const src = fs.readFileSync(process.env.DRIVER_RATE_FIX_UNDER_TEST || SCRIPT, "utf8");
		const self = fs.readFileSync(__filename, "utf8");
		ok("no production sheet ID", !src.includes(sheetIds.PRODUCTION_SPREADSHEET_ID) && !self.includes(sheetIds.PRODUCTION_SPREADSHEET_ID));
		ok("no key option", !FIX.OPTIONS.includes("key"));
		ok("no 9-digit load number in the script or this runner", !/\b\d{9}\b/.test(src) && !/\b\d{9}\b/.test(self));
		ok("no driver tag in the script (the plan names him)", !/\bd-[0-9a-f]{8}\b/.test(src));
	});

	finish();
})().catch((err) => {
	console.error(`FAIL: the runner threw: ${err && err.stack ? err.stack : err}`);
	process.exit(1);
});
