#!/usr/bin/env node
/**
 * Approving or rejecting a receipt in a closed month is refused with a message
 * that never tells anyone to reopen the month.
 *
 * WHAT IT REPRODUCES: approving a receipt booked to a finalized month answered
 * 409 PERIOD_FINALIZED with "This expense is booked to <Month YYYY>, which is
 * finalized. Reopen the period, or record the correction as a payout
 * adjustment." Closed months are never reopened (standing rule, 2026-10-14), so
 * the screen, which shows the server's sentence as is, told people to do the
 * one thing they must not.
 *
 * WHAT IS ASSERTED, for PUT /api/expenses/:id/status and its batch twin
 * PUT /api/expenses/bulk-status:
 *   - the outcome is unchanged: the single route answers 409 PERIOD_FINALIZED
 *     with `period`; the batch route answers 200 with `skippedFinalized` and
 *     `finalizedPeriods` (it never 409s, it withholds the closed rows);
 *   - the receipt's status is unchanged, and exactly one refusal audit row is
 *     written per request, as before;
 *   - the message names the month, says the receipt already counts in that
 *     month's figures (or, for a rejected one, that it is left out), says who
 *     can correct what (a Super Admin, an investor's payout, with an adjustment
 *     on an open month in Payouts; a company truck's closed month stays as
 *     recorded), says the status can't be changed (true for an approve, a
 *     reject and a reset to Pending alike), and contains no "reopen" in any
 *     case, no "/api/" and no internal code.
 * It also checks the gallons-recovery refusal in lib/, the other receipt
 * refusal that used to give the same advice.
 *
 * The shipped code runs, lifted out of server.js with scripts/lib/server-lift.js:
 * both routes and every helper they reach, on an in-memory SQLite built from
 * server.js's own CREATE TABLE and ALTER TABLE statements. Made-up data only.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-expense-status-refusal-message.js    # exits 1 on failure
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

const STATUS_HEAD = 'app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const BULK_HEAD = 'app.put("/api/expenses/bulk-status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';

function createTable(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
const expenseColumns = [...SRC.matchAll(/ALTER TABLE expenses ADD COLUMN [^"`]+/g)].map((m) => m[0]);
if (!expenseColumns.some((s) => /posted_period/.test(s))) die("could not locate the posted_period migration");

const ROWS = [
	{ id: 1, date: "2026-08-30", status: "Pending" },   // August, closed
	{ id: 2, date: "2026-08-31", status: "Approved" },  // August, closed
	{ id: 3, date: "2026-08-15", status: "Rejected" },  // August, closed, left out of the figures
	{ id: 4, date: "2026-09-15", status: "Pending" },   // September, open
	{ id: 5, date: "2025-09-10", status: "Pending" },   // September 2025, closed
	{ id: 6, date: "2026-07-10", status: "Pending" },   // July 2026, closed
];

function buildDb() {
	const db = new Database(":memory:");
	for (const t of ["expenses", "period_locks", "audit_trail"]) db.exec(createTable(t));
	for (const sql of expenseColumns) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`${sql}: ${e.message}`); }
	}
	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', '2026-09-08T05:00:00.000Z')");
	lock.run("2025-09");
	lock.run("2026-07");
	lock.run("2026-08");
	const add = db.prepare(`INSERT INTO expenses (id, timestamp, driver, load_id, type, amount, date, status, created_at, posted_period)
		VALUES (@id, '2026-09-29T20:00:00.000Z', 'Driver A', '', 'Fuel', 10, @date, @status, '2026-09-29 20:00:00', '')`);
	for (const r of ROWS) add.run(r);
	return db;
}

function world(db) {
	const lifted = closure(SRC, {
		routes: [STATUS_HEAD, BULK_HEAD],
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

// What every refusal message must never contain.
function checkClean(label, msg) {
	const text = String(msg || "");
	check(`${label}: no "reopen" in any case`, !/reopen/i.test(text), text);
	check(`${label}: no API path`, !text.includes("/api/"), text);
	check(`${label}: no internal code`, !/PERIOD_[A-Z_]+/.test(text), text);
	check(`${label}: says a Super Admin can adjust an investor's payout on an open month`, /A Super Admin can correct an investor's payout with an adjustment on an open month in Payouts\./.test(text), text);
	check(`${label}: says a company truck's closed month stays as recorded`, /A company truck's closed (month stays|months stay) as recorded\./.test(text), text);
	check(`${label}: says the status can't be changed, not "approved or rejected"`, /status can't be changed/.test(text) && !/approved or rejected/.test(text), text);
}

const statusOf = (db, id) => db.prepare("SELECT status FROM expenses WHERE id = ?").get(id).status;
const auditRows = (db, action) => db.prepare("SELECT entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);

const SINGLE_SENTENCE = "August 2026 is closed, so this receipt's status can't be changed. It already counts in August 2026's figures as it stands. A Super Admin can correct an investor's payout with an adjustment on an open month in Payouts. A company truck's closed month stays as recorded.";

// ---- single receipt: approve and reject ------------------------------------
for (const target of ["Approved", "Rejected"]) {
	const db = buildDb();
	const put = world(db)["PUT /api/expenses/:id/status"];
	if (!put) die("PUT /api/expenses/:id/status was not registered");
	const res = call(put, { params: { id: "1" }, body: { status: target } });
	const b = res.body || {};
	const label = `single ${target}`;
	check(`${label}: 409 PERIOD_FINALIZED with period 2026-08`, res.status === 409 && b.code === "PERIOD_FINALIZED" && b.period === "2026-08", `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the receipt is unchanged`, statusOf(db, 1) === "Pending", statusOf(db, 1));
	const audit = auditRows(db, "update_expense_status_blocked");
	check(`${label}: one refusal audit row`, audit.length === 1 && audit[0].entity_id === "1" && /\[PERIOD_FINALIZED\]/.test(audit[0].details), JSON.stringify(audit));
	check(`${label}: no success audit row`, auditRows(db, "update_expense_status").length === 0);
	check(`${label}: names the month`, /August 2026/.test(b.error), b.error);
	check(`${label}: says it already counts`, /already counts in August 2026's figures/.test(b.error), b.error);
	check(`${label}: the exact sentence`, b.error === SINGLE_SENTENCE, b.error);
	checkClean(label, b.error);
}

// ---- single receipt reset to Pending (the Undo on an approved receipt) ----
{
	const db = buildDb();
	const put = world(db)["PUT /api/expenses/:id/status"];
	const res = call(put, { params: { id: "2" }, body: { status: "Pending" } });
	const b = res.body || {};
	const label = "single reset to Pending";
	check(`${label}: 409 PERIOD_FINALIZED with period 2026-08`, res.status === 409 && b.code === "PERIOD_FINALIZED" && b.period === "2026-08", `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the receipt is unchanged`, statusOf(db, 2) === "Approved", statusOf(db, 2));
	check(`${label}: one refusal audit row`, auditRows(db, "update_expense_status_blocked").length === 1);
	check(`${label}: the exact sentence`, b.error === SINGLE_SENTENCE, b.error);
	checkClean(label, b.error);
}

// ---- single receipt that is rejected: it is left out, not counted ----------
{
	const db = buildDb();
	const put = world(db)["PUT /api/expenses/:id/status"];
	const res = call(put, { params: { id: "3" }, body: { status: "Approved" } });
	const b = res.body || {};
	const label = "single, rejected receipt";
	check(`${label}: 409 PERIOD_FINALIZED with period 2026-08`, res.status === 409 && b.code === "PERIOD_FINALIZED" && b.period === "2026-08", `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the receipt is unchanged`, statusOf(db, 3) === "Rejected", statusOf(db, 3));
	check(`${label}: one refusal audit row`, auditRows(db, "update_expense_status_blocked").length === 1);
	check(`${label}: names the month and says it is left out`, /August 2026 is closed/.test(b.error) && /left out of August 2026's figures/.test(b.error), b.error);
	check(`${label}: does not claim it counts`, !/already counts/.test(b.error), b.error);
	checkClean(label, b.error);
}

// ---- batch: every row withheld --------------------------------------------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	if (!bulk) die("PUT /api/expenses/bulk-status was not registered");
	const res = call(bulk, { body: { ids: [1, 2], status: "Rejected" } });
	const b = res.body || {};
	const label = "batch, all withheld";
	check(`${label}: 200, nothing updated, 2 withheld in 2026-08`, res.status === 200 && b.updated === 0 && b.skippedFinalized === 2 && JSON.stringify(b.finalizedPeriods) === '["2026-08"]', `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the receipts are unchanged`, statusOf(db, 1) === "Pending" && statusOf(db, 2) === "Approved");
	const audit = auditRows(db, "bulk_update_expense_status_blocked");
	check(`${label}: one refusal audit row`, audit.length === 1 && audit[0].entity_id === "2" && /\[PERIOD_FINALIZED\]/.test(audit[0].details), JSON.stringify(audit));
	check(`${label}: no success audit row`, auditRows(db, "bulk_update_expense_status").length === 0);
	check(`${label}: names the month`, /August 2026 is closed/.test(b.message), b.message);
	check(`${label}: says they already count`, /already count in August 2026's figures/.test(b.message), b.message);
	checkClean(label, b.message);
}

// ---- batch: one open row goes through, one closed row is withheld ---------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	const res = call(bulk, { body: { ids: [1, 4], status: "Approved" } });
	const b = res.body || {};
	const label = "batch, partial";
	check(`${label}: 200, 1 updated, 1 withheld`, res.status === 200 && b.updated === 1 && b.skippedFinalized === 1, `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the closed receipt is unchanged, the open one approved`, statusOf(db, 1) === "Pending" && statusOf(db, 4) === "Approved");
	check(`${label}: one refusal audit row`, auditRows(db, "bulk_update_expense_status_blocked").length === 1);
	check(`${label}: the message`, b.message === `1 updated. 1 skipped. ${SINGLE_SENTENCE}`, b.message);
	checkClean(label, b.message);
}

// ---- batch: two closed months ---------------------------------------------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	const res = call(bulk, { body: { ids: [1, 5], status: "Approved" } });
	const b = res.body || {};
	const label = "batch, two closed months";
	check(`${label}: both withheld, both months named`, b.skippedFinalized === 2 && JSON.stringify(b.finalizedPeriods) === '["2025-09","2026-08"]', JSON.stringify(b));
	check(`${label}: the message names both months`, /September 2025 and August 2026 are closed/.test(b.message), b.message);
	check(`${label}: says they already count`, /already count in those months' figures/.test(b.message), b.message);
	checkClean(label, b.message);
}

// ---- batch: three closed months --------------------------------------------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	const res = call(bulk, { body: { ids: [1, 5, 6], status: "Approved" } });
	const b = res.body || {};
	const label = "batch, three closed months";
	check(`${label}: all withheld, all three months named`, b.skippedFinalized === 3 && JSON.stringify(b.finalizedPeriods) === '["2025-09","2026-07","2026-08"]', JSON.stringify(b));
	check(`${label}: the message reads "A, B and C are closed"`, /September 2025, July 2026 and August 2026 are closed/.test(b.message), b.message);
	check(`${label}: company trucks' closed months, plural`, /A company truck's closed months stay as recorded\./.test(b.message), b.message);
	checkClean(label, b.message);
	check(`${label}: the receipts are unchanged`, [1, 5, 6].every((id) => statusOf(db, id) === "Pending"));
}

// ---- batch: reset to Pending -----------------------------------------------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	const res = call(bulk, { body: { ids: [2], status: "Pending" } });
	const b = res.body || {};
	const label = "batch reset to Pending";
	check(`${label}: nothing updated, 1 withheld`, res.status === 200 && b.updated === 0 && b.skippedFinalized === 1, `${res.status} ${JSON.stringify(b)}`);
	check(`${label}: the receipt is unchanged`, statusOf(db, 2) === "Approved", statusOf(db, 2));
	check(`${label}: the message`, b.message === `0 updated. 1 skipped. ${SINGLE_SENTENCE}`, b.message);
	checkClean(label, b.message);
}

// ---- batch: a rejected row among the withheld ------------------------------
{
	const db = buildDb();
	const bulk = world(db)["PUT /api/expenses/bulk-status"];
	const only = call(bulk, { body: { ids: [3], status: "Approved" } }).body || {};
	check("batch, rejected only: says it is left out", /left out of August 2026's figures/.test(only.message) && !/already count/.test(only.message), only.message);
	checkClean("batch, rejected only", only.message);
	const mixed = call(bulk, { body: { ids: [1, 3], status: "Approved" } }).body || {};
	check("batch, mixed: counted ones count, the rejected one is left out", /already count in August 2026's figures/.test(mixed.message) && /rejected one, which is left out/.test(mixed.message), mixed.message);
	checkClean("batch, mixed", mixed.message);
	check("batch, rejected rows: unchanged", statusOf(db, 3) === "Rejected" && statusOf(db, 1) === "Pending");
}

// ---- the other receipt refusal: gallons recovery in a closed month --------
{
	const { judgeGallonsRecovery } = require(path.join(ROOT, "lib", "receipt-gallons-recovery.js"));
	const v = judgeGallonsRecovery({ locked: true });
	check("gallons recovery, closed month: verdict is locked_period", v.verdict === "locked_period", JSON.stringify(v));
	check("gallons recovery, closed month: no \"reopen\" in any case", !/reopen/i.test(v.reason), v.reason);
	check("gallons recovery, closed month: says the month is closed", /closed month/.test(v.reason), v.reason);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
