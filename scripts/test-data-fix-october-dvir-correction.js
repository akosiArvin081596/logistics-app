#!/usr/bin/env node
/**
 * scripts/data-fix-october-dvir-correction.js on made-up data: a fake Sheets
 * client that keeps one Job Tracking tab, and a temp SQLite built from every
 * CREATE TABLE in server.js (scripts/lib/work-days-world.js, the payout
 * runners' world), with the payout ledger lifted from server.js as the oracle.
 *
 *   §1 the dry run writes nothing: no sheet write, every table as it was, and a
 *      result file (mode 600) saying what it would write and what the payout
 *      would read
 *   §2 the apply writes exactly the 7 planned cells (one range each, in the
 *      Payment column) and 1 adjustment, and nothing else
 *   §3 the audit rows: the system actor on each; and the cell writes, audit rows
 *      and payout rows equal what a person makes through the lifted routes
 *      themselves (PUT /api/data/:rowIndex as Data Manager sends it, then
 *      PUT /api/investor/payouts/:id/adjust as Payouts sends it)
 *   §4 a full no-op (nothing written, exit 2) on: a Payment not at its planned
 *      figure, a load not exactly its gap under its last invoice, the month
 *      closed (also with only the adjustment left), a planned row with a closed
 *      month's date, a finalized payout row, a settled one, an adjustment
 *      already on the row, an adjust-only load already corrected, a load on
 *      two rows, a load the payout math doesn't count in the month, and a plan
 *      whose figures don't add up
 *   §5 one sheet write failing mid-run (refused, or landed with its answer
 *      lost) leaves a clear state, and a re-run finishes it; the month closing
 *      mid-run and a row changing under the run stop it the same way
 *   §6 a replay writes nothing
 *   §7 the payout read back: recomputed by the payout code, plus the adjustment,
 *      against the plan's expected figure (equal: exit 0; not: exit 3 and the gap)
 *   §8 the lift: recordPayoutChange named; a name the lift leaves out refuses
 *      the run before anything is read or written
 *   §9 the command line and the files
 *   §10 the source: no production sheet, no key option, no real load numbers
 *
 * DVIR_FIX_UNDER_TEST=<file> runs that copy of the script (a mutant) as if it
 * sat at the script's own path, so its requires resolve as the script's do.
 * Every load, amount, person and sheet ID here is made up. No network.
 *   node scripts/test-data-fix-october-dvir-correction.js   # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-october-dvir-correction.js");

// The script under test: the real one, or a mutant copy compiled as if it sat at
// the real path.
function loadFix() {
	const file = process.env.DVIR_FIX_UNDER_TEST || SCRIPT;
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
	console.error(`FAIL: scripts/data-fix-october-dvir-correction.js did not load (${String((err && err.message) || err).split("\n")[0]})`);
	process.exit(1);
}

const W = require("./lib/work-days-world");
const { closure } = require("./lib/server-lift");
const sheetIds = require("../lib/sheet-id");

const { test, finish } = W.createRunner("data-fix-october-dvir-correction");
const NOW = Date.parse("2026-11-12T15:00:00Z");
const SHEET_ID = "sheet-under-test-dvir-c1";
const PERIOD = "2026-10";
const OWNER = 5;
const PAY = "  Payment  ";
const ADMIN = Object.freeze({ id: 1, username: "super_admin", role: "Super Admin" });

// ── the made-up fleet and loads ───────────────────────────────────────────────
const DRIVERS = [{ name: "Dana Testdriver" }, { name: "Eli Testdriver" }, { name: "Fay Testdriver" }];
const TRUCKS = [{ unit: "T1", driver: "Dana Testdriver" }, { unit: "T2", driver: "Eli Testdriver" }, { unit: "T3", driver: "Fay Testdriver" }];
// The Payment the sheet shows, and the invoiced figure of the load's last invoice row.
const LOADS = [
	// Planned with both figures.
	{ id: "900101", driver: "Dana Testdriver", truck: "T1", pickup: "2026-10-05 8:00", dropoff: "2026-10-06 14:00", payment: "$1,210.00", invoiced: "$1,250.00" },
	{ id: "900102", driver: "Eli Testdriver", truck: "T2", pickup: "2026-10-07 8:00", dropoff: "2026-10-08 14:00", payment: "$980.40", invoiced: "$1,040.40" },
	{ id: "900103", driver: "Fay Testdriver", truck: "T3", pickup: "2026-10-12 8:00", dropoff: "2026-10-13 14:00", payment: "$2,115.75", invoiced: "2140.75" },
	{ id: "900109", driver: "Dana Testdriver", truck: "T1", pickup: "2026-10-26 8:00", dropoff: "2026-10-27 14:00", payment: "$462.10", invoiced: "$487.10" },
	{ id: "900110", driver: "Eli Testdriver", truck: "T2", pickup: "2026-10-28 8:00", dropoff: "2026-10-29 14:00", payment: "$1,333.00", invoiced: "$1,383.00" },
	// Planned by their gap under the last invoice.
	{ id: "900104", driver: "Dana Testdriver", truck: "T1", pickup: "2026-10-14 8:00", dropoff: "2026-10-15 14:00", payment: "$1,500.00", invoiced: "$1,530.00" },
	{ id: "900105", driver: "Eli Testdriver", truck: "T2", pickup: "2026-10-19 8:00", dropoff: "2026-10-20 14:00", payment: "$800.50", invoiced: "$830.50" },
	// A closed month's pickup: the adjustment only, the Payment stays.
	{ id: "900106", driver: "Fay Testdriver", truck: "T3", pickup: "2026-09-29 8:00", dropoff: "2026-10-01 14:00", assigned: "2026-10-01", payment: "$1,000.00", invoiced: "$1,050.00" },
	{ id: "900107", driver: "Dana Testdriver", truck: "T1", pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", payment: "$700.00", invoiced: "$725.00" },
	{ id: "900108", driver: "Eli Testdriver", truck: "T2", pickup: "2026-09-28 8:00", dropoff: "2026-10-02 10:00", assigned: "2026-10-02", payment: "$600.00", invoiced: "$620.00" },
	// Not in the plan.
	{ id: "900120", driver: "Fay Testdriver", truck: "T3", pickup: "2026-10-21 8:00", dropoff: "2026-10-22 14:00", payment: "$3,000.00", invoiced: "$3,000.00" },
];
const PLANNED = ["900101", "900102", "900103", "900109", "900110", "900104", "900105"];
const ADJUST_ONLY = ["900106", "900107", "900108"];
const REASON = "Test correction: 3 loads were paid at their invoiced totals, $95.00 more than recorded; your 50% share.";
const byId = (id) => LOADS.find((l) => l.id === id);
const cents = (s) => Math.round(Number(String(s).replace(/[$,]/g, "")) * 100);
const dollars = (c) => (c / 100).toFixed(2);

function sheetRow(l) {
	const day = (v) => v.split(" ")[0];
	return W.loadRow({
		id: l.id, driver: l.driver, truck: l.truck, owner: l.owner ?? "5", payment: l.payment,
		pickup: l.pickup, dropoff: l.dropoff, assigned: l.assigned || day(l.pickup), done: day(l.dropoff),
	});
}

// The October payout row's amount and the plan's expected figure, from the oracle.
let BEFORE = null;
let FINAL = null;
let EXPECTED = null;
let PAYOUT_ID = null;

function basePlan(over = {}) {
	return {
		kind: "october-dvir-correction",
		period: PERIOD,
		ownerId: OWNER,
		splitPct: 50,
		payments: [
			{ load: "900101", now: "1210.00", set: "1250.00" },
			{ load: "900102", now: "980.40", set: "1040.40" },
			{ load: "900103", now: "2115.75", set: "2140.75" },
			{ load: "900109", now: "462.10", set: "487.10" },
			{ load: "900110", now: "1333.00", set: "1383.00" },
			{ load: "900104", under: "30.00" },
			{ load: "900105", under: "30.00" },
		],
		adjustOnly: [
			{ load: "900106", under: "50.00" },
			{ load: "900107", under: "25.00" },
			{ load: "900108", under: "20.00" },
		],
		revenueDelta: "260.00",
		payoutDelta: 130,
		adjustment: 48,
		reason: REASON,
		expectedEffective: EXPECTED,
		...over,
	};
}

// ── the world: one database every case copies ────────────────────────────────
const BASE = W.startWorld({ rows: LOADS.map(sheetRow), drivers: DRIVERS, trucks: TRUCKS, locks: ["2026-08", "2026-09"], now: NOW, expose: ["computeLossCarryForward"] });
{
	const draft = BASE.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, via, created_at, created_by) VALUES (?, ?, ?, 'manual', ?, 'made-up-admin')");
	// An older invoice row first, so the last one is the one that counts.
	draft.run("900104", "10152026-1", "$1,500.00", "2026-10-15T20:00:00Z");
	LOADS.forEach((l, i) => draft.run(l.id === "900105" ? `#${l.id}` : l.id, `10${String(20 + i)}2026-1`, l.invoiced, "2026-10-28T20:00:00Z"));
}
async function oraclePayable(world) {
	const led = await W.ledger(world, OWNER);
	const carry = world.api.computeLossCarryForward(led.monthlyEarnings);
	return carry[PERIOD] ? carry[PERIOD].payable : null;
}
function setPayments(world, ids, which) {
	for (const id of ids) world.setRow(id, { [PAY]: which === "set" ? FIX.moneyText(cents(byId(id).invoiced), byId(id).payment) : byId(id).payment });
}

// ── the fake sheet ────────────────────────────────────────────────────────────
// Rows kept as the sheet shows them; reads drop trailing empty cells and rows, as
// the API does. `failWrite`: { nth, mode: "refused" | "landed" }. `hooks`:
// onRowRead(rowNo, rows) before a single-row values.get answers, onBatchGet(rowNo,
// rows) before a batchGet answers, afterWrite(n, rows) after the nth write lands.
function fakeSheets(values, { failWrite = null, hooks = {} } = {}) {
	const rows = values.map((r) => r.map((c) => (c == null ? "" : String(c))));
	const calls = [];
	const writes = [];
	const ids = [];
	const trim = (r) => {
		const out = (r || []).map((c) => (c == null ? "" : String(c)));
		while (out.length && out[out.length - 1] === "") out.pop();
		return out;
	};
	const own = (id) => { ids.push(id); if (id !== SHEET_ID) throw new Error(`fake sheet: a call to ${id}`); };
	const parse = (range) => {
		const m = /^'((?:[^']|'')+)'(?:!(.+))?$/.exec(String(range));
		if (!m || m[1].replace(/''/g, "'") !== "Job Tracking") throw new Error(`fake sheet: unknown range ${range}`);
		return m[2] || "";
	};
	const rowOf = (a) => { const m = /^(\d+):\1$/.exec(a); if (!m) throw new Error(`fake sheet: unknown row range ${a}`); return Number(m[1]); };
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
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
						const all = rows.map(trim);
						while (all.length && !all[all.length - 1].length) all.pop();
						return { data: { values: all } };
					}
					const r = rowOf(a);
					if (hooks.onRowRead) hooks.onRowRead(r, rows);
					return { data: { values: [trim(rows[r - 1])] } };
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
					if (hooks.afterWrite) hooks.afterWrite(n, rows);
					if (fail === "landed") throw new Error("made-up lost answer");
					return { data: { totalUpdatedCells: requestBody.data.length } };
				},
				update: async () => { throw new Error("fake sheet: values.update is not a row save"); },
				append: async () => { throw new Error("fake sheet: values.append is not a row save"); },
				clear: async () => { throw new Error("fake sheet: values.clear is not a row save"); },
			},
		},
	};
	return { client, rows, calls, writes, ids };
}

// ── one case: its own database copy, plan file, result file and sheet ────────
const IDX = Object.fromEntries(W.HEADERS.map((h, i) => [h, i]));
function rowNo(rows, id) { return rows.findIndex((r) => r[IDX["Load ID"]] === id) + 1; }
function newCase({ edit = null, plan = basePlan(), db = null, sheet = {} } = {}) {
	const copy = W.saveCopy(BASE, {});
	if (db) { const d = new W.Database(copy.db); try { db(d); } finally { d.close(); } }
	const values = W.sheetValues(BASE.rows);
	if (edit) edit(values);
	const planFile = path.join(copy.dir, "plan.json");
	fs.writeFileSync(planFile, JSON.stringify(plan));
	const result = path.join(copy.dir, "result.json");
	return { ...copy, planFile, result, fake: fakeSheets(values, sheet), plan };
}
const args = (c, mode = "--apply") => [`--db=${c.db}`, `--sheet-id=${SHEET_ID}`, `--plan=${c.planFile}`, `--result=${c.result}`, ...(mode ? [mode] : [])];
async function run(c, mode = "--apply", opts = {}) {
	const out = [];
	const code = await FIX.main(args(c, mode), { sheets: c.fake.client, envFile: c.envFile, nowMs: NOW, log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), ...opts });
	let result = null;
	try { result = JSON.parse(fs.readFileSync(c.result, "utf8")); } catch { result = null; }
	return { code, out: out.join("\n"), result };
}
const hashes = (c) => { const d = new W.Database(c.db, { readonly: true }); try { return W.tableHashes(d); } finally { d.close(); } };
const query = (c, sql, ...p) => { const d = new W.Database(c.db, { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const payoutRow = (c) => query(c, "SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?", OWNER, PERIOD)[0];
const scriptAudits = (c) => query(c, "SELECT user_id, username, role, action, entity, entity_id, details, timestamp FROM audit_trail WHERE username = ? ORDER BY id", FIX.ACTOR);
const paymentOf = (c, id) => c.fake.rows[rowNo(c.fake.rows, id) - 1][IDX[PAY]];
const setText = (id) => FIX.moneyText(cents(byId(id).invoiced), byId(id).payment);

// A full no-op: refused, no sheet write, every table as it was, and why in the result.
async function noOp(t, c, why, mode = "--apply") {
	const before = hashes(c);
	const r = await run(c, mode);
	t.eq("exit code (refused)", r.code, 2);
	t.eq("no sheet write", c.fake.writes.length, 0);
	t.eq("every table as it was", hashes(c), before);
	t.ok(`the result says it was refused, naming ${why}`, r.result && r.result.outcome === "refused" && why.test((r.result.problems || []).join(" | ")), JSON.stringify(r.result && r.result.problems));
	return r;
}

// ── the person's path: the lifted routes as Data Manager and Payouts call them ─
const DATA_HEAD = 'app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
let PERSON_LIFT = null;
function personLift() {
	if (PERSON_LIFT) return PERSON_LIFT;
	const provided = ["db", "require", "console", "process", "Date", "app", "requireRole", "refuseCrossOrigin", "getSheets", "SPREADSHEET_ID",
		"jtCacheInvalidate", "REPLICA", "factoringRoutes", "__dirname", "getJobTrackingCached"];
	const roots = ["recordPayoutChange"];
	for (let round = 0; round < 6; round++) {
		const lifted = closure(W.SRC, { roots, routes: [DATA_HEAD, FIX.ADJUST_HEAD], provided, denied: ["server", "io", "transporter", "getDrive", "sendEmail", "fetch"] });
		const missing = FIX.unresolvedNames(W.SRC, lifted, provided, [DATA_HEAD, FIX.ADJUST_HEAD]);
		if (!missing.length) { PERSON_LIFT = { lifted, provided }; return PERSON_LIFT; }
		roots.push(...missing);
	}
	throw new Error("the person's lift did not settle");
}
class Clock extends Date {
	constructor(...a) { if (a.length) super(...a); else super(NOW); }
	static now() { return NOW; }
}
async function personPath(c) {
	const { lifted, provided } = personLift();
	const db = new W.Database(c.db);
	const routes = {};
	const register = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const { createRequire } = require("module");
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const deps = {
		db,
		require: (m) => { if (m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m)) return appRequire(m); throw new Error(`lifted code required ${m}`); },
		console: { log() {}, info() {}, warn() {}, error() {} },
		process: { env: {}, argv: [], exit: () => { throw new Error("exit"); } },
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
	const answers = [];
	for (const id of PLANNED) {
		const r = rowNo(c.fake.rows, id);
		const shown = c.fake.rows[r - 1];
		// Data Manager sends every column as shown, the edited one changed, and no baseline.
		const values = W.HEADERS.map((h, i) => (h === PAY ? setText(id) : (shown[i] ?? "")));
		answers.push(await call("PUT /api/data/:rowIndex", { params: { rowIndex: String(r) }, query: { sheet: "Job Tracking" }, body: { values }, session: { user: { ...ADMIN } }, headers: {} }));
	}
	const payout = db.prepare("SELECT id FROM investor_payouts WHERE owner_id = ? AND period = ?").get(OWNER, PERIOD);
	answers.push(await call("PUT /api/investor/payouts/:id/adjust", { params: { id: String(payout.id) }, body: { adjustment: 48, adjustmentNote: REASON }, session: { user: { ...ADMIN } }, headers: {} }));
	db.close();
	return answers;
}

(async () => {
	// The oracle: the payout ledger, lifted by the payout runners' world.
	BEFORE = await oraclePayable(BASE);
	setPayments(BASE, PLANNED, "set");
	FINAL = await oraclePayable(BASE);
	setPayments(BASE, PLANNED, "now");
	EXPECTED = FINAL + 48;
	BASE.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (?, ?, ?, '2026-11-27', 'owed')").run(OWNER, PERIOD, BEFORE);
	PAYOUT_ID = BASE.db.prepare("SELECT id FROM investor_payouts WHERE owner_id = ? AND period = ?").get(OWNER, PERIOD).id;

	await test("the fixture: the payout ledger books the 7 loads to owner 5's October, +$130 in all", ({ eq, ok }) => {
		ok("a payable for the month", Number.isFinite(BEFORE) && BEFORE > 0, String(BEFORE));
		eq("the 7 Payments move the month by +$130", FINAL - BEFORE, 130);
	});

	// §1 ───────────────────────────────────────────────────────────────────────
	await test("§1 the dry run writes nothing and says what it would write", async (t) => {
		const c = newCase();
		const before = hashes(c);
		const r = await run(c, "--dry-run");
		t.eq("exit code", r.code, 0);
		t.eq("no sheet write", c.fake.writes.length, 0);
		t.ok("no write call of any kind", !c.fake.calls.some((x) => /batchUpdate|update|append|clear/.test(x)), c.fake.calls.join(", "));
		t.eq("every table as it was", hashes(c), before);
		t.eq("every call went to the named sheet", [...new Set(c.fake.ids)], [SHEET_ID]);
		t.eq("result: would write", r.result && r.result.outcome, "would-write");
		t.eq("result: 7 cells and 1 adjustment to write", r.result && [r.result.counts.paymentsToWrite, r.result.counts.adjustToWrite], [7, 1]);
		t.eq("result: the payout it predicts", r.result && [r.result.payout.recomputedBefore, r.result.payout.recomputedAfter, r.result.payout.effectiveAfter, r.result.payout.difference], [BEFORE, FINAL, EXPECTED, 0]);
		t.eq("the result file is the owner's only (600)", (fs.statSync(c.result).mode & 0o777).toString(8), "600");
		t.ok("it says nothing was written", /Nothing was written/.test(r.out), r.out.slice(-300));
	});
	await test("§1 with neither --dry-run nor --apply it is a dry run", async (t) => {
		const c = newCase();
		const before = hashes(c);
		const r = await run(c, null);
		t.eq("exit code", r.code, 0);
		t.eq("no sheet write", c.fake.writes.length, 0);
		t.eq("every table as it was", hashes(c), before);
		t.eq("result mode", r.result && r.result.mode, "dry-run");
	});

	// §2 ───────────────────────────────────────────────────────────────────────
	await test("§2 the apply writes exactly 7 cells and 1 adjustment", async (t) => {
		const c = newCase();
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		t.eq("7 sheet writes", c.fake.writes.length, 7);
		t.ok("each one cell, in the Payment column, as the sheet's own entry", c.fake.writes.every((w) => w.valueInputOption === "USER_ENTERED" && w.data.length === 1 && /^'Job Tracking'!O\d+$/.test(w.data[0].range)), JSON.stringify(c.fake.writes.map((w) => w.data)));
		t.eq("the cells written: each planned load's row, set to its invoiced figure",
			c.fake.writes.map((w) => [w.data[0].range, w.data[0].values]),
			PLANNED.map((id) => [`'Job Tracking'!O${rowNo(c.fake.rows, id)}`, [[setText(id)]]]));
		for (const id of PLANNED) t.eq(`load ${id} now shows its invoiced figure`, cents(paymentOf(c, id)), cents(byId(id).invoiced));
		for (const id of [...ADJUST_ONLY, "900120"]) t.eq(`load ${id} keeps its Payment`, paymentOf(c, id), byId(id).payment);
		const p = payoutRow(c);
		t.eq("the payout row: the adjustment, its reason, by the script", [p.adjustment, p.adjustment_note, p.adjusted_by], [48, REASON, FIX.ACTOR]);
		t.eq("the payout row's amount is left to the app's own recompute", p.amount, BEFORE);
		const h = query(c, "SELECT kind, old_amount, new_amount, delta, detail, actor FROM investor_payout_history WHERE payout_id = ?", p.id);
		t.eq("one history row, the route's own", h, [{ kind: "adjustment", old_amount: BEFORE, new_amount: BEFORE + 48, delta: 48, detail: `adjustment: ${REASON}`, actor: FIX.ACTOR }]);
		t.eq("result: written", r.result && r.result.outcome, "written");
		t.eq("result counts", r.result && [r.result.counts.paymentsWritten, r.result.counts.paymentsAlreadyDone, r.result.counts.adjustWritten, r.result.counts.auditRows], [7, 0, 1, 8]);
		t.ok("only batchUpdate writes the sheet", c.fake.calls.filter((x) => /batchUpdate/.test(x)).length === 7 && !c.fake.calls.some((x) => /^values\.(update|append|clear)/.test(x)), c.fake.calls.join(", "));
	});

	// §3 ───────────────────────────────────────────────────────────────────────
	await test("§3 the audit rows: the route's own, as a system change", async (t) => {
		const c = newCase();
		await run(c);
		const rows = scriptAudits(c);
		t.eq("8 audit rows: 7 cell saves, then the adjustment", rows.map((a) => a.action), [...PLANNED.map(() => "update_sheet_row"), "investor_payout_adjust"]);
		t.ok("each as the system actor (user 0, role system)", rows.every((a) => a.user_id === 0 && a.username === FIX.ACTOR && a.role === "system"));
		t.eq("each cell save names its row", rows.slice(0, 7).map((a) => [a.entity, a.entity_id]), PLANNED.map((id) => ["sheet_row", `Job Tracking!${rowNo(c.fake.rows, id)}`]));
		const first = JSON.parse(rows[0].details);
		t.eq("a cell save keeps the Payment's before and after", first.changed, [{ column: "Payment", col: IDX[PAY], from: "$1,210.00", to: "$1,250.00", why: "the load's payment amount" }]);
		t.eq("the adjustment's row", [rows[7].entity, rows[7].entity_id, rows[7].details], ["investor_payout", String(PAYOUT_ID), `owner ${OWNER} ${PERIOD}: adjustment 0.00 -> 48.00 (${REASON})`]);
	});
	await test("§3 the same cell writes, audit rows and payout rows as a person's, through the lifted routes", async (t) => {
		const script = newCase();
		await run(script);
		const person = newCase();
		const answers = await personPath(person);
		t.eq("the routes took every edit", answers.map((a) => (a.status === 200 ? 200 : `${a.status} ${String(a.body && a.body.error).slice(0, 160)}`)), [...PLANNED.map(() => 200), 200]);
		t.eq("the same cell writes, in order", script.fake.writes, person.fake.writes);
		const strip = (rows) => rows.map(({ action, entity, entity_id, details, timestamp }) => ({ action, entity, entity_id, details, timestamp }));
		const personAudits = query(person, "SELECT user_id, username, role, action, entity, entity_id, details, timestamp FROM audit_trail ORDER BY id");
		t.eq("the same audit rows (action, entity, details, time)", strip(scriptAudits(script)), strip(personAudits));
		t.ok("…the person's by the person's account", personAudits.every((a) => a.username === ADMIN.username && a.role === ADMIN.role));
		const pay = (x) => { const p = payoutRow(x); return { amount: p.amount, adjustment: p.adjustment, adjustment_note: p.adjustment_note, adjusted_at: p.adjusted_at, status: p.status }; };
		t.eq("the same payout row", pay(script), pay(person));
		const hist = (x) => query(x, "SELECT payout_id, owner_id, period, kind, old_amount, new_amount, delta, detail, breakdown FROM investor_payout_history ORDER BY id");
		t.eq("the same history rows", hist(script), hist(person));
		t.eq("the actors differ as they should", [payoutRow(script).adjusted_by, payoutRow(person).adjusted_by], [FIX.ACTOR, ADMIN.username]);
	});

	// §4 ───────────────────────────────────────────────────────────────────────
	await test("§4 a Payment not at its planned figure: nothing written", async (t) => {
		const c = newCase({ edit: (v) => { v[rowNo(v, "900102") - 1][IDX[PAY]] = "$981.40"; } });
		await noOp(t, c, /900102/);
	});
	await test("§4 a load not exactly its gap under its last invoice: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("UPDATE load_invoice_drafts SET total = '$831.50' WHERE load_id = '#900105'").run() });
		await noOp(t, c, /900105/);
	});
	await test("§4 a planned load whose last invoice isn't the plan's figure: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, via) VALUES ('900103', '11012026-9', '$2,150.75', 'manual')").run() });
		await noOp(t, c, /900103/);
	});
	await test("§4 the month already closed: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-15T05:00:00Z', 'test')").run(PERIOD) });
		await noOp(t, c, /2026-10.*closed|closed.*2026-10/);
	});
	await test("§4 the month closed with only the adjustment left: nothing written", async (t) => {
		const c = newCase({
			edit: (v) => { for (const id of PLANNED) v[rowNo(v, id) - 1][IDX[PAY]] = setText(id); },
			db: (d) => d.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-15T05:00:00Z', 'test')").run(PERIOD),
		});
		await noOp(t, c, /2026-10.*closed|closed.*2026-10/);
		t.eq("no refusal row either", query(c, "SELECT COUNT(*) AS n FROM audit_trail").map((x) => x.n), [0]);
	});
	await test("§4 a planned row with a closed month's date (the edit guard would refuse it): nothing written", async (t) => {
		const c = newCase({ edit: (v) => { v[rowNo(v, "900109") - 1][IDX["Pickup Appointment"]] = "9/30/2026 8:00"; } });
		await noOp(t, c, /900109.*PERIOD_FINALIZED/);
	});
	await test("§4 the payout row finalized: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("UPDATE investor_payouts SET finalized_at = '2026-11-15T05:00:00Z', finalized_amount = amount WHERE id = ?").run(PAYOUT_ID) });
		await noOp(t, c, /finalized/);
	});
	await test("§4 the payout row settled (processing): nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("UPDATE investor_payouts SET status = 'processing' WHERE id = ?").run(PAYOUT_ID) });
		await noOp(t, c, /processing/);
	});
	await test("§4 the payout row already carries another adjustment: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("UPDATE investor_payouts SET adjustment = -12, adjustment_note = 'made-up earlier correction', adjusted_by = 'super_admin' WHERE id = ?").run(PAYOUT_ID) });
		await noOp(t, c, /adjustment/);
	});
	await test("§4 no payout row for the month: nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("DELETE FROM investor_payouts WHERE id = ?").run(PAYOUT_ID) });
		await noOp(t, c, /payout row/);
	});
	await test("§4 an adjust-only load already corrected: nothing written", async (t) => {
		const c = newCase({ edit: (v) => { v[rowNo(v, "900107") - 1][IDX[PAY]] = "$725.00"; } });
		await noOp(t, c, /900107/);
	});
	await test("§4 a load on two rows: nothing written", async (t) => {
		const c = newCase({ edit: (v) => { v.push(v[rowNo(v, "900102") - 1].slice()); } });
		await noOp(t, c, /900102.*2 /);
	});
	await test("§4 a load the payout math doesn't count in the investor's month: nothing written", async (t) => {
		const c = newCase({ edit: (v) => { v[rowNo(v, "900110") - 1][IDX["Assigned Date"]] = "11/2/2026"; } });
		await noOp(t, c, /900110/);
	});
	await test("§4 the payout code doesn't move the month by the planned amount (a loss absorbs it): nothing written", async (t) => {
		const c = newCase({ db: (d) => d.prepare("UPDATE trucks SET insurance_monthly = 100000 WHERE unit_number = 'T1'").run() });
		await noOp(t, c, /move owner 5's 2026-10 by/);
	});
	await test("§4 a plan whose figures don't add up: refused before anything is read", async (t) => {
		for (const [label, over, why] of [
			["the adjustment", { adjustment: 47 }, /adjustment/],
			["the revenue", { revenueDelta: "250.00" }, /revenueDelta/],
			["the payout", { payoutDelta: 125 }, /payoutDelta/],
			["a load in both lists", { adjustOnly: [{ load: "900101", under: "50.00" }, { load: "900107", under: "25.00" }, { load: "900108", under: "20.00" }] }, /twice/],
			["a reason over two lines", { reason: "line one\nline two" }, /reason/],
		]) {
			const c = newCase({ plan: basePlan(over) });
			const r = await run(c);
			t.eq(`${label}: refused`, r.code, 2);
			t.eq(`${label}: the sheet not even read`, c.fake.calls.length, 0);
			t.ok(`${label}: says why`, why.test(r.out), r.out.slice(0, 300));
		}
	});

	// §5 ───────────────────────────────────────────────────────────────────────
	await test("§5 the 4th sheet write refused: a clear state, and a re-run finishes", async (t) => {
		const c = newCase({ sheet: { failWrite: { nth: 4, mode: "refused" } } });
		const r1 = await run(c);
		t.eq("exit code (incomplete)", r1.code, 1);
		t.eq("3 cells written", c.fake.writes.length, 3);
		t.eq("result: partial", r1.result && r1.result.outcome, "partial");
		t.eq("each load's state", r1.result && r1.result.payments.map((p) => p.state), ["written", "written", "written", "failed", "to-write", "to-write", "to-write"]);
		t.eq("the adjustment not written", payoutRow(c).adjustment, 0);
		t.eq("the failed save's own audit row", scriptAudits(c).map((a) => a.action), ["update_sheet_row", "update_sheet_row", "update_sheet_row", "update_sheet_row_failed"]);
		const r2 = await run({ ...c, fake: fakeSheets(c.fake.rows) });
		t.eq("the re-run: exit code", r2.code, 0);
		t.eq("the re-run: 3 already done, 4 written", r2.result && r2.result.payments.map((p) => p.state), ["already-done", "already-done", "already-done", "written", "written", "written", "written"]);
		t.eq("the re-run: the adjustment written", payoutRow(c).adjustment, 48);
		t.eq("…and every planned load at its invoiced figure", r2.result && r2.result.payments.every((p) => p.readBack === "ok"), true);
	});
	await test("§5 the 4th sheet write landed but its answer was lost: the re-run sees it done", async (t) => {
		const c = newCase({ sheet: { failWrite: { nth: 4, mode: "landed" } } });
		const r1 = await run(c);
		t.eq("exit code (incomplete)", r1.code, 1);
		t.eq("4 cells landed", c.fake.writes.length, 4);
		t.eq("result: the 4th marked failed", r1.result && r1.result.payments[3].state, "failed");
		const fake2 = fakeSheets(c.fake.rows);
		const r2 = await run({ ...c, fake: fake2 });
		t.eq("the re-run: exit code", r2.code, 0);
		t.eq("the re-run: 4 already done, 3 written", r2.result && r2.result.payments.map((p) => p.state), ["already-done", "already-done", "already-done", "already-done", "written", "written", "written"]);
		t.eq("the re-run wrote 3 cells", fake2.writes.length, 3);
	});
	await test("§5 the month closes mid-run: the next save is refused by the edit guard, audited", async (t) => {
		let c = null;
		c = newCase({ sheet: { hooks: { afterWrite: (n) => { if (n === 1) { const d = new W.Database(c.db); d.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-15T05:00:00Z', 'test')").run(PERIOD); d.close(); } } } } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("1 cell written", c.fake.writes.length, 1);
		t.eq("each load's state", r.result && r.result.payments.map((p) => p.state), ["written", "refused", "to-write", "to-write", "to-write", "to-write", "to-write"]);
		t.ok("the refusal audited as the route audits it", scriptAudits(c).some((a) => a.action === "update_sheet_row_blocked" && /\[PERIOD_FINALIZED\]$/.test(a.details)));
		t.eq("the adjustment not written", payoutRow(c).adjustment, 0);
	});
	await test("§5 a row changing after the check: that save stops, nothing written for it", async (t) => {
		const r2 = rowNo(W.sheetValues(BASE.rows), "900102");
		const c = newCase({ sheet: { hooks: { onBatchGet: (r, rows) => { if (r === r2) rows[r - 1][IDX.Details] = "made-up note added meanwhile"; } } } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("1 cell written", c.fake.writes.length, 1);
		t.eq("result: the 2nd not written, and why", r.result && [r.result.payments[1].state, r.result.payments[1].code], ["not-written", "ROW_CHANGED_SINCE_CHECK"]);
	});
	await test("§5 a row changing just before its write: the route's SHEET_CHANGED, audited", async (t) => {
		const r3 = rowNo(W.sheetValues(BASE.rows), "900103");
		const c = newCase({ sheet: { hooks: { onRowRead: (r, rows) => { if (r === r3) rows[r - 1][IDX.Details] = "made-up note added meanwhile"; } } } });
		const r = await run(c);
		t.eq("exit code (incomplete)", r.code, 1);
		t.eq("2 cells written", c.fake.writes.length, 2);
		t.eq("result: the 3rd refused SHEET_CHANGED", r.result && [r.result.payments[2].state, r.result.payments[2].code], ["refused", "SHEET_CHANGED"]);
		t.ok("audited as the route audits it", scriptAudits(c).some((a) => a.action === "update_sheet_row_blocked" && /\[SHEET_CHANGED\]$/.test(a.details)));
	});

	// §6 ───────────────────────────────────────────────────────────────────────
	await test("§6 a replay writes nothing", async (t) => {
		const c = newCase();
		t.eq("the first run", (await run(c)).code, 0);
		const fake2 = fakeSheets(c.fake.rows);
		const before = hashes(c);
		const r = await run({ ...c, fake: fake2 });
		t.eq("exit code", r.code, 0);
		t.eq("no sheet write", fake2.writes.length, 0);
		t.eq("every table as it was (no audit row either)", hashes(c), before);
		t.eq("result: already done", r.result && [r.result.outcome, r.result.counts.paymentsAlreadyDone, r.result.adjust.state], ["already-done", 7, "already-done"]);
		const dry = await run({ ...c, fake: fakeSheets(c.fake.rows) }, "--dry-run");
		t.eq("a dry run after it: already done", dry.result && [dry.code, dry.result.outcome], [0, "already-done"]);
	});

	// §7 ───────────────────────────────────────────────────────────────────────
	await test("§7 the payout read back: recomputed plus the adjustment, equal to the plan's figure", async (t) => {
		const c = newCase();
		const r = await run(c);
		t.eq("exit code", r.code, 0);
		const p = r.result && r.result.payout;
		t.eq("recomputed before and after, the adjustment, the effective figure", p && [p.recomputedBefore, p.recomputedReadBack, p.adjustment, p.effectiveReadBack, p.expected, p.difference], [BEFORE, FINAL, 48, EXPECTED, EXPECTED, 0]);
		t.eq("the stored row as it stands until the next Payouts read", p && [p.storedAmount, p.storedEffective], [BEFORE, BEFORE + 48]);
		t.ok("it says it matches", /matches/.test(r.out), r.out.slice(-400));
	});
	await test("§7 the payout read back differs from the plan's figure: exit 3, and by how much", async (t) => {
		const c = newCase({ plan: basePlan({ expectedEffective: EXPECTED + 5 }) });
		const r = await run(c);
		t.eq("exit code", r.code, 3);
		t.eq("the writes are still made", c.fake.writes.length, 7);
		t.eq("the difference", r.result && r.result.payout.difference, -5);
		t.ok("it says it differs by $5", /differs by -\$5/.test(r.out), r.out.slice(-400));
	});

	await test("§7 a Payment that doesn't read back as written: exit 1, unconfirmed", async (t) => {
		const c = newCase({ sheet: { hooks: { afterWrite: (n, rows) => { if (n === 2) rows[rowNo(rows, "900102") - 1][IDX[PAY]] = "$1.00"; } } } });
		const r = await run(c);
		t.eq("exit code", r.code, 1);
		t.eq("result: unconfirmed, naming the load", r.result && [r.result.outcome, r.result.payments[1].readBack], ["unconfirmed", "differs"]);
		t.ok("it says so", /READ BACK: load 900102/.test(r.out), r.out.slice(-300));
	});

	// §8 ───────────────────────────────────────────────────────────────────────
	await test("§8 the lift names recordPayoutChange, and leaves nothing out", async (t) => {
		const d = W.schemaDb();
		const api = FIX.liftServer({ db: d, env: {}, sheetId: SHEET_ID, nowMs: NOW });
		t.ok("recordPayoutChange is a root and lifted", FIX.ROOTS.includes("recordPayoutChange") && api.liftedNames.includes("recordPayoutChange"));
		t.eq("the adjust route registered", typeof api.adjust, "function");
		t.eq("the key path is server.js's own KEY_FILE", api.KEY_FILE, new Function(`${closure(W.SRC, { roots: ["KEY_FILE"] }).text}\nreturn KEY_FILE;`)());
		const plain = closure(W.SRC, { roots: FIX.ROOTS.filter((n) => n !== "recordPayoutChange"), routes: [FIX.ADJUST_HEAD], provided: FIX.PROVIDED });
		t.ok("without the name, the walk alone misses it", !plain.names.includes("recordPayoutChange"));
		t.eq("…and the check finds it", FIX.unresolvedNames(W.SRC, plain, FIX.PROVIDED), ["recordPayoutChange"]);
		let refused = "";
		try { FIX.liftServer({ db: d, env: {}, sheetId: SHEET_ID, nowMs: NOW, roots: FIX.ROOTS.filter((n) => n !== "recordPayoutChange") }); } catch (e) { refused = e instanceof FIX.Refusal ? e.message : `not a refusal: ${e.message}`; }
		t.ok("a lift that leaves a name out is refused, naming it", /recordPayoutChange/.test(refused), refused);
		d.close();
	});
	await test("§8 a run whose lift leaves a name out is refused before anything is read or written", async (t) => {
		const c = newCase();
		const before = hashes(c);
		const out = [];
		const code = await FIX.main(args(c), { sheets: c.fake.client, envFile: c.envFile, nowMs: NOW, log: (s) => out.push(s), err: (s) => out.push(s), roots: FIX.ROOTS.filter((n) => n !== "recordPayoutChange") });
		t.eq("exit code", code, 2);
		t.eq("the sheet not even read", c.fake.calls.length, 0);
		t.eq("every table as it was", hashes(c), before);
		t.ok("names the missing one", /recordPayoutChange/.test(out.join("\n")), out.join("\n").slice(0, 300));
	});
	await test("§8 the check's own reading of names: what server-lift's walk misreads", ({ eq, ok }) => {
		const { codeIdentifiers } = require("./lib/server-lift");
		const afterComment = 'function f() {\n\tg(1);\n\t// a sentence ending in a full stop.\n\th(2);\n\tconst u = "http://example.invalid/x";\n\treturn k;\n}';
		ok("the walk misses a call after a comment ending in \".\"", !codeIdentifiers(afterComment).includes("h"));
		ok("…the check's reading finds it", FIX.usedNames(afterComment).has("h"));
		const quoteRegex = "function q(t) {\n\treturn `'${String(t).replace(/'/g, \"''\")}'`;\n}\nfunction r() {\n\treturn later(1);\n}";
		ok("the walk loses its place after a template holding a regex with a quote", !codeIdentifiers(quoteRegex).includes("later"));
		ok("…the check's reading does not", FIX.usedNames(quoteRegex).has("later"));
		eq("property names, strings, comments and regex text are not names",
			[...FIX.usedNames('a.b; c?.d; "e f"; // g\n/* h */ x = /i j/.test(y); `k ${l} m`;')].sort(), ["a", "c", "l", "x", "y"]);
	});

	// §9 ───────────────────────────────────────────────────────────────────────
	await test("§9 the command line: each required argument, one mode, no unknown option", async (t) => {
		const c = newCase();
		const base = args(c, null);
		for (const [label, argv, why] of [
			["no --db", base.filter((a) => !a.startsWith("--db=")), /--db/],
			["no --sheet-id", base.filter((a) => !a.startsWith("--sheet-id=")), /--sheet-id/],
			["no --plan", base.filter((a) => !a.startsWith("--plan=")), /--plan/],
			["no --result", base.filter((a) => !a.startsWith("--result=")), /--result/],
			["both modes", [...base, "--dry-run", "--apply"], /not both/],
			["a key option", [...base, "--key=made-up.json"], /unknown/],
			["a stray word", [...base, "now"], /unknown/],
		]) {
			const out = [];
			const code = await FIX.main(argv, { sheets: c.fake.client, envFile: c.envFile, nowMs: NOW, log: (s) => out.push(s), err: (s) => out.push(s) });
			t.eq(`${label}: refused`, code, 2);
			t.ok(`${label}: says why`, why.test(out.join("\n")), out.join("\n").slice(0, 200));
		}
		t.eq("nothing was read", c.fake.calls.length, 0);
	});
	await test("§9 the plan and the result stay outside the repository; the database is the app's or a temp copy", async (t) => {
		const c = newCase();
		const inRepo = path.join(ROOT, "made-up-dvir-result.json");
		for (const [label, argv, why] of [
			["a result inside the repository", args(c).map((a) => (a.startsWith("--result=") ? `--result=${inRepo}` : a)), /outside the repository/],
			["a plan inside the repository", args(c).map((a) => (a.startsWith("--plan=") ? `--plan=${path.join(ROOT, "package.json")}` : a)), /outside the repository/],
			["a database elsewhere", args(c).map((a) => (a.startsWith("--db=") ? `--db=${path.join(ROOT, "client", "made-up.db")}` : a)), /refusing|no file/],
		]) {
			const out = [];
			const code = await FIX.main(argv, { sheets: c.fake.client, envFile: c.envFile, nowMs: NOW, log: (s) => out.push(s), err: (s) => out.push(s) });
			t.eq(`${label}: refused`, code, 2);
			t.ok(`${label}: says why`, why.test(out.join("\n")), out.join("\n").slice(0, 200));
		}
		t.eq("no result file inside the repository", fs.existsSync(inRepo), false);
		t.eq("nothing was read", c.fake.calls.length, 0);
	});
	await test("§9 the Sheets key is the app's own: started outside the app's folder, refused before any client", async ({ ok }) => {
		let refused = "";
		try { await FIX.googleSheets({ keyFile: "./made-up-key.json", write: false, cwd: require("os").tmpdir() }); } catch (e) { refused = e instanceof FIX.Refusal ? e.message : `not a refusal: ${e.message}`; }
		ok("refused, saying to run it from the app's folder", /app's own folder/.test(refused), refused);
	});
	await test("§9 the app's own sheet: SPREADSHEET_ID, else production's for production's own folder", ({ eq }) => {
		eq("named", FIX.ownSheetId({ SPREADSHEET_ID: " made-up-sheet " }, "/srv/elsewhere"), "made-up-sheet");
		eq("production's folder", FIX.ownSheetId({}, sheetIds.PRODUCTION_DIR), sheetIds.PRODUCTION_SPREADSHEET_ID);
		eq("any other folder", FIX.ownSheetId({}, "/srv/elsewhere"), "");
	});
	await test("§9 money as the sheet shows it", ({ eq }) => {
		eq("read", ["$1,516.56", "1516.56", "$405.84", " 1,234 ", "$1,2345.00", "12.3.4", "", "TBD"].map(FIX.moneyCents), [151656, 151656, 40584, 123400, null, null, null, null]);
		eq("written in the cell's own style", [FIX.moneyText(151656, "$1,481.56"), FIX.moneyText(40584, "$370.84"), FIX.moneyText(151656, "1481.56"), FIX.moneyText(151656, "1,481.56")], ["$1,516.56", "$405.84", "1516.56", "1,516.56"]);
	});

	// §10 ──────────────────────────────────────────────────────────────────────
	await test("§10 the source: no production sheet, no key option, no real load numbers", ({ ok }) => {
		const src = fs.readFileSync(process.env.DVIR_FIX_UNDER_TEST || SCRIPT, "utf8");
		const self = fs.readFileSync(__filename, "utf8");
		ok("no production sheet ID", !src.includes(sheetIds.PRODUCTION_SPREADSHEET_ID) && !self.includes(sheetIds.PRODUCTION_SPREADSHEET_ID));
		ok("no key option", !FIX.OPTIONS.includes("key"));
		ok("no 9-digit load number in the script or this runner", !/\b\d{9}\b/.test(src) && !/\b\d{9}\b/.test(self));
	});

	finish();
})().catch((err) => {
	console.error(`FAIL: the runner threw: ${err && err.stack ? err.stack : err}`);
	process.exit(1);
});
