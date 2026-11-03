#!/usr/bin/env node
/**
 * The admin Expenses list says which receipts sit in a finalized month, and
 * it says so for exactly the receipts the status route refuses.
 *
 * WHAT IT REPRODUCES: on 2026-09-28 receipts #211 and #212 (dated 2026-08-30
 * and 2026-08-31, Pending) were approved seven times and the screen said
 * "Failed to update status" each time. August was finalized, so
 * PUT /api/expenses/:id/status answered 409 PERIOD_FINALIZED, and nothing on
 * the list told anyone the receipt was already counted in August's figures.
 *
 * WHAT IS ASSERTED: GET /api/expenses/all gives every row `finalized_period`:
 * the month the receipt counts in when that month is finalized, else ''. The
 * month is the status route's own (posted_period, else the date's month, else
 * the upload's), so a receipt dated in a closed month but booked to an open one
 * is not finalized, and a reopened month is not finalized. For every row,
 * `finalized_period` is set exactly when the status route refuses it with 409
 * PERIOD_FINALIZED. An unreadable period_locks table claims nothing: every
 * row reads '' and the list still loads (the status route then refuses with
 * PERIOD_LOCK_UNREADABLE, which the screen now shows as the reason).
 *
 * THE STATUS RECORDER (RECEIPT_STATUS_RECORDER_ENABLED, on only when exactly
 * "true"). Off (unset, "1", "TRUE"): the single and bulk status routes prepare
 * today's UPDATE statements exactly, no statement names a recorder column, every
 * row keeps them empty, and the list carries no status_by. On: a Super Admin's
 * approve and undo record role, id, name and time; a Dispatcher's bulk records
 * them on every row it writes, a row already at the target included; a write
 * refused for a closed month records nothing; the list gives status_by
 * { role, name, at } or null.
 *
 * The shipped code runs, lifted out of server.js with scripts/lib/server-lift.js:
 * the three routes and every helper they reach, on an in-memory SQLite built from
 * server.js's own CREATE TABLE and ALTER TABLE statements.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-expense-finalized-period.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }

const LIST_HEAD = 'app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const STATUS_HEAD = 'app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const BULK_HEAD = 'app.put("/api/expenses/bulk-status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const RECORDER = "RECEIPT_STATUS_RECORDER_ENABLED";
// Today's two status writes, as the routes prepare them with the recorder off.
const TODAY_SINGLE = "UPDATE expenses SET status = ? WHERE id = ?";
const TODAY_BULK = (n) => `UPDATE expenses SET status = ? WHERE id IN (${Array(n).fill("?").join(",")})`;
const STAMP_COLS = ["status_by_role", "status_by_id", "status_by_name", "status_at"];
const ADMIN = { id: 1, username: "admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "dispatch_a", role: "Dispatcher" };

function createTable(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
const expenseColumns = [...SRC.matchAll(/ALTER TABLE expenses ADD COLUMN [^"`]+/g)].map((m) => m[0]);
if (!expenseColumns.some((s) => /posted_period/.test(s))) die("could not locate the posted_period migration");

function buildDb() {
	const db = new Database(":memory:");
	for (const t of ["expenses", "period_locks", "audit_trail"]) db.exec(createTable(t));
	for (const sql of expenseColumns) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`${sql}: ${e.message}`); }
	}
	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, ?, '2026-09-08T05:00:57.883Z')");
	lock.run("2025-09", "locked");
	lock.run("2026-07", "reopened");
	lock.run("2026-08", "locked");
	const add = db.prepare(`INSERT INTO expenses (id, timestamp, driver, load_id, type, amount, date, status, created_at, posted_period)
		VALUES (@id, @ts, 'Driver A', '', 'Fuel', 10, @date, @status, @created, @posted)`);
	for (const r of ROWS) add.run({ status: "Pending", posted: "", created: "2026-09-29 20:06:12", ts: "2026-09-29T20:06:12.000Z", ...r });
	return db;
}

// id -> [what it stands for, the finalized_period the list must give it]
const ROWS = [
	{ id: 211, date: "2026-08-30", want: "2026-08", what: "an August receipt (the #211 case)" },
	{ id: 212, date: "2026-08-31", status: "Approved", want: "2026-08", what: "an approved August receipt" },
	{ id: 213, date: "2026-08-15", status: "Rejected", want: "2026-08", what: "a rejected August receipt" },
	{ id: 300, date: "2026-09-15", want: "", what: "an open-month receipt" },
	{ id: 255, date: "2025-09-28", posted: "2026-09", want: "", what: "a receipt dated in a finalized month, booked to an open one" },
	{ id: 254, date: "2023-09-28", want: "", what: "a receipt dated in a month that was never closed" },
	{ id: 150, date: "2026-07-20", want: "", what: "a receipt in a reopened month" },
	{ id: 151, date: "2026-09-01", posted: "2026-08", want: "2026-08", what: "a receipt booked to a finalized month" },
];

// `recorder`: the value RECEIPT_STATUS_RECORDER_ENABLED holds while the lifted
// code is built (undefined = unset); the flag is read once there, as at boot.
function world(db, recorder) {
	const lifted = closure(SRC, {
		routes: [LIST_HEAD, STATUS_HEAD, BULK_HEAD],
		provided: ["db", "app", "requireRole", "console", "notifyChange", "require", "process"],
		denied: ["server", "io", "sheets", "getSheets", "SPREADSHEET_ID"],
	});
	const routes = {};
	const app = {
		get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
		put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; },
	};
	const quiet = { ...console, error: () => {}, log: () => {}, warn: () => {} };
	const body = `"use strict";\n${lifted.text}`;
	// The lifted code requires "./lib/…" as server.js does, from the repo root.
	const rootRequire = (m) => require(m.startsWith("./") ? path.join(ROOT, m) : m);
	const env = { ...process.env };
	delete env[RECORDER];
	if (recorder !== undefined) env[RECORDER] = recorder;
	new Function("db", "app", "requireRole", "console", "notifyChange", "require", "process", body)(
		db, app, () => (q, s, n) => n && n(), quiet, () => {}, rootRequire, Object.create(process, { env: { value: env } }));
	return routes;
}

function call(handler, req, user = ADMIN) {
	const out = { status: 200, body: null };
	const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
	handler({ session: { user }, query: {}, params: {}, body: {}, ...req }, res);
	return out;
}

// Every statement the routes prepare, in order.
function spy(db) {
	const seen = [];
	const prepare = db.prepare.bind(db);
	db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
	return seen;
}

// A receipt's four recorder columns, or the error reading them (no such column
// on code without the recorder).
function stampOf(db, id) {
	try {
		const r = db.prepare(`SELECT ${STAMP_COLS.join(", ")} FROM expenses WHERE id = ?`).get(id);
		return r ? STAMP_COLS.map((c) => r[c]) : "row missing";
	} catch (e) {
		return `unreadable: ${e.message}`;
	}
}
const EMPTY = ["", null, "", ""];
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let failed = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
}

// ---- the list marks finalized rows --------------------------------------
{
	const db = buildDb();
	const routes = world(db);
	const list = routes["GET /api/expenses/all"];
	const put = routes["PUT /api/expenses/:id/status"];
	if (!list || !put) die("routes were not registered");
	const got = call(list, {});
	check("GET /api/expenses/all answers 200", got.status === 200, JSON.stringify(got.body));
	const byId = new Map(((got.body && got.body.expenses) || []).map((e) => [e.id, e]));
	for (const r of ROWS) {
		const e = byId.get(r.id);
		check(`${r.what}: finalized_period is ${JSON.stringify(r.want)}`, !!e && e.finalized_period === r.want, e ? JSON.stringify(e.finalized_period) : "row missing");
	}

	// The list and the status route agree on every row.
	for (const r of ROWS) {
		const target = (r.status || "Pending") === "Approved" ? "Pending" : "Approved";
		const res = call(put, { params: { id: String(r.id) }, body: { status: target } });
		const refused = res.status === 409 && res.body && res.body.code === "PERIOD_FINALIZED";
		check(`#${r.id} ${r.what}: the status route ${r.want ? "refuses" : "accepts"} a change`, refused === !!r.want, `${res.status} ${JSON.stringify(res.body)}`);
		if (refused) check(`#${r.id}: the refusal names the month`, res.body.period === r.want && /August 2026/.test(res.body.error), JSON.stringify(res.body));
	}
	const write = db.prepare("SELECT status FROM expenses WHERE id = 211").get().status;
	check("the refused receipt is unchanged", write === "Pending", write);
}

// ---- an unreadable lock table claims nothing ------------------------------
{
	const db = buildDb();
	const routes = world(db);
	db.exec("DROP TABLE period_locks");
	const got = call(routes["GET /api/expenses/all"], {});
	check("unreadable period_locks: the list still answers 200", got.status === 200, JSON.stringify(got.body));
	const rows = (got.body && got.body.expenses) || [];
	check("unreadable period_locks: no row is called finalized", rows.length === ROWS.length && rows.every((e) => e.finalized_period === ""), JSON.stringify(rows.map((e) => e.finalized_period)));
	const res = call(routes["PUT /api/expenses/:id/status"], { params: { id: "300" }, body: { status: "Approved" } });
	check("unreadable period_locks: the status route still holds the change (PERIOD_LOCK_UNREADABLE)", res.status === 409 && res.body.code === "PERIOD_LOCK_UNREADABLE", JSON.stringify(res.body));
}

// ---- the status recorder off: today's statements, nothing recorded ----------
for (const [label, value] of [["unset", undefined], ["'1'", "1"], ["'TRUE'", "TRUE"]]) {
	const db = buildDb();
	const seen = spy(db);
	const routes = world(db, value);
	const one = call(routes["PUT /api/expenses/:id/status"], { params: { id: "300" }, body: { status: "Approved" } });
	const bulk = call(routes["PUT /api/expenses/bulk-status"], { body: { ids: [300, 254, 211], status: "Approved" } }, DISPATCHER);
	const list = call(routes["GET /api/expenses/all"], {});
	check(`recorder ${label}: the single and bulk writes answer as today (200; bulk 2 updated, 1 withheld)`,
		one.status === 200 && bulk.status === 200 && bulk.body.updated === 2 && bulk.body.skippedFinalized === 1, JSON.stringify([one, bulk]));
	const updates = seen.filter((s) => /^\s*UPDATE expenses\b/.test(s));
	check(`recorder ${label}: the status writes are today's statements exactly`, same(updates, [TODAY_SINGLE, TODAY_BULK(2)]), JSON.stringify(updates));
	check(`recorder ${label}: no statement names a recorder column`, !seen.some((s) => /status_by_|status_at/.test(s)), JSON.stringify(seen.filter((s) => /status_by_|status_at/.test(s))));
	const stamps = ROWS.map((r) => stampOf(db, r.id));
	check(`recorder ${label}: every receipt keeps the four columns empty`, stamps.every((s) => same(s, EMPTY)), JSON.stringify(stamps));
	const rows = (list.body && list.body.expenses) || [];
	check(`recorder ${label}: the list carries no status_by`, rows.length === ROWS.length && rows.every((e) => !("status_by" in e) && !STAMP_COLS.some((c) => c in e)), JSON.stringify(rows[0]));
}

// ---- the status recorder on: who set each status, and when -----------------
{
	const db = buildDb();
	const routes = world(db, "true");
	const put = routes["PUT /api/expenses/:id/status"];
	const t0 = new Date().toISOString();
	const approve = call(put, { params: { id: "300" }, body: { status: "Approved" } });
	const t1 = new Date().toISOString();
	const s300 = stampOf(db, 300);
	check("recorder on: a Super Admin's approve records role, id and name", approve.status === 200 && same(s300.slice(0, 3), ["Super Admin", 1, "admin"]), JSON.stringify([approve, s300]));
	check("…and the time, ISO-8601 UTC, at the write", typeof s300[3] === "string" && ISO_Z.test(s300[3]) && s300[3] >= t0 && s300[3] <= t1, JSON.stringify(s300[3]));
	check("…with the status written", db.prepare("SELECT status FROM expenses WHERE id = 300").get().status === "Approved");

	call(put, { params: { id: "150" }, body: { status: "Approved" } });
	const undo = call(put, { params: { id: "150" }, body: { status: "Pending" } }, DISPATCHER);
	const s150 = stampOf(db, 150);
	check("recorder on: an Undo to Pending records who undid it, over the earlier approver", undo.status === 200 && same(s150.slice(0, 3), ["Dispatcher", 2, "dispatch_a"]), JSON.stringify([undo, s150]));

	const refused = call(put, { params: { id: "211" }, body: { status: "Approved" } });
	check("recorder on: a write refused for a closed month records nothing", refused.status === 409 && refused.body.code === "PERIOD_FINALIZED" && same(stampOf(db, 211), EMPTY), JSON.stringify([refused.body, stampOf(db, 211)]));

	const tb0 = new Date().toISOString();
	const bulk = call(routes["PUT /api/expenses/bulk-status"], { body: { ids: [300, 254, 211, 151], status: "Approved" } }, DISPATCHER);
	const s254 = stampOf(db, 254);
	const s300b = stampOf(db, 300);
	check("recorder on: a Dispatcher's bulk answers as today (2 updated, 2 withheld)", bulk.status === 200 && bulk.body.updated === 2 && bulk.body.skippedFinalized === 2, JSON.stringify(bulk.body));
	check("…records the Dispatcher on the Pending row it approved", same(s254.slice(0, 3), ["Dispatcher", 2, "dispatch_a"]) && ISO_Z.test(String(s254[3])) && s254[3] >= tb0, JSON.stringify(s254));
	check("…and on the row already Approved, which its click decided too", same(s300b.slice(0, 3), ["Dispatcher", 2, "dispatch_a"]) && s300b[3] === s254[3], JSON.stringify(s300b));
	check("…and nothing on the two rows it withheld (closed August)", same(stampOf(db, 211), EMPTY) && same(stampOf(db, 151), EMPTY), JSON.stringify([stampOf(db, 211), stampOf(db, 151)]));
	check("rows no one set keep the four columns empty", [212, 213, 255].every((id) => same(stampOf(db, id), EMPTY)), JSON.stringify([212, 213, 255].map((id) => stampOf(db, id))));

	const list = call(routes["GET /api/expenses/all"], {}, DISPATCHER);
	const byId = new Map(((list.body && list.body.expenses) || []).map((e) => [e.id, e]));
	const e300 = byId.get(300) || {};
	check("recorder on: the list gives status_by { role, name, at } for a receipt someone set",
		same(e300.status_by, { role: "Dispatcher", name: "dispatch_a", at: s254[3] }), JSON.stringify(e300.status_by));
	check("…null for one no one has set", (byId.get(213) || {}).status_by === null, JSON.stringify((byId.get(213) || {}).status_by));
	check("…and no raw recorder column (the account id stays in the database)", [...byId.values()].every((e) => !STAMP_COLS.some((c) => c in e)), JSON.stringify(Object.keys(e300)));
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
