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
 * The shipped code runs, lifted out of server.js with scripts/lib/server-lift.js:
 * both routes and every helper they reach, on an in-memory SQLite built from
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
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }

const LIST_HEAD = 'app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const STATUS_HEAD = 'app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';

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

function world(db) {
	const lifted = closure(SRC, {
		routes: [LIST_HEAD, STATUS_HEAD],
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
	new Function("db", "app", "requireRole", "console", "notifyChange", "require", "process", body)(
		db, app, () => (q, s, n) => n && n(), quiet, () => {}, rootRequire, process);
	return routes;
}

function call(handler, req) {
	const out = { status: 200, body: null };
	const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
	handler({ session: { user: { id: 1, username: "admin", role: "Super Admin" } }, query: {}, params: {}, body: {}, ...req }, res);
	return out;
}

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

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
