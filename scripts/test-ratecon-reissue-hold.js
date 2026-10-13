#!/usr/bin/env node
/**
 * A rate con re-issued for a load that is already delivered or invoiced must not change the
 * load's Payment or dates; a person decides instead (2026-10-14). A broker's post-delivery
 * "Booked Load #" email (DVIR deductions, an "Advanced Total" and a "New Total") reached
 * POST /api/n8n/keep-stored-values like any rate con, and every non-blank value it carried was
 * written: Payment fell on invoiced loads, and pickup dates moved, which moves a driver's pay
 * window. The loads here are synthetic; the amounts and date shapes are the production ones.
 *
 *   §1 POST /api/n8n/keep-stored-values, lifted, with a stand-in Job Tracking and an in-memory
 *      load_invoice_drafts (its CREATE TABLE taken from server.js). For a load whose Job Status
 *      is delivered (/^(delivered|completed|pod received)$/i) or that has an invoice draft:
 *      - Payment, Pickup Appointment and Drop-off Appointment come back as stored;
 *      - a blank stored date is not filled either;
 *      - the response names each held column with the stored and the sent value, and why;
 *      - the same amount or moment in another format is not a hold;
 *      - every other column still comes back as sent;
 *      - the hold alert is raised with the load, the reason and the held columns;
 *      - the draft is found under any spelling of the load id ("#X", case, edge spaces);
 *      - a draft table that can't be read holds (fails closed) and says so;
 *      a load that is neither still gets every value as sent, with nothing held and no alert,
 *      and the route still never writes the sheet.
 *   §2 alertRateConReissueHold(): once per load, column and sent value (a dedupe ledger like
 *      ratecon_extract_alerts); a new sent value alerts again; alerted_at is stamped only on a
 *      confirmed delivery (the email or the in-app notification), so a failed send retries; it
 *      writes no table but its own.
 *   §3 the daily integrity check, check 5: a load whose Job Tracking Payment differs from the
 *      sheet's figure when its invoice was drafted (load_invoice_drafts.sheet_total, the latest
 *      draft) is reported once; the same amount in another format is not; a further change is
 *      reported again; a draft with no sheet_total is skipped; a load whose Assigned Date is in
 *      a closed month is not raised; a database without load_invoice_drafts skips the check.
 *
 * Pure: no server, no network. Run: node scripts/test-ratecon-reissue-hold.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const ic = require("../lib/integrity-check");

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const SECRET = "test-secret";
const DRAFTS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS load_invoice_drafts \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
if (!DRAFTS_DDL) { console.error("FAILED: load_invoice_drafts's CREATE TABLE was not found in server.js"); process.exit(1); }
function draftsDb() {
	const db = new Database(":memory:");
	db.exec(DRAFTS_DDL[1]);
	for (const col of ["sheet_total TEXT", "ratecon_total TEXT", "total_source TEXT"]) {
		try { db.exec(`ALTER TABLE load_invoice_drafts ADD COLUMN ${col}`); } catch { /* already there */ }
	}
	return db;
}
function addDraft(db, { loadId, total, sheetTotal, createdAt = "2026-10-12T13:33:10Z" }) {
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, sheet_total, ratecon_total, total_source, broker_name, created_at) VALUES (?, ?, ?, ?, ?, 'manual', 'Broker Co', ?)")
		.run(loadId, `INV-${loadId}`, total, sheetTotal, sheetTotal, createdAt);
}

// --- §1 the route -----------------------------------------------------------
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Info", "Pickup Appointment", "Pickup Address", "Drop-off Appointment", "Job Status", "Assigned Date", "Documents", "  Payment  "];
const row = (o) => HEADERS.map((h) => (o[h] === undefined ? "" : o[h]));
const DELIVERED = row({ "Load ID": "900000101", Details: "ROLLSTOCK, 44,548 lbs", "Pickup Info": "Mill REF/PU#: 7000000001", "Pickup Appointment": "10/9/2026 0:00", "Pickup Address": "1 Mill Ln, Town, OK 74000", "Drop-off Appointment": "10/9/2026 0:01", "Job Status": "Delivered", "Assigned Date": "10/7/2026, 3:56:51 PM", Documents: "Yes", "  Payment  ": " $ 1,516.56 " });
const IN_TRANSIT_INVOICED = row({ "Load ID": "900000102", "Pickup Appointment": "10/6/2026 8:00", "Drop-off Appointment": "10/8/2026 0:00", "Job Status": "In Transit", "  Payment  ": " $ 1,511.22 " });
const DISPATCHED = row({ "Load ID": "900000103", "Pickup Appointment": "10/12/2026 10:00", "Drop-off Appointment": "", "Job Status": "Dispatched", "  Payment  ": " $ 2,635.29 " });
const DELIVERED_NO_PICKUP = row({ "Load ID": "900000104", "Pickup Appointment": "", "Drop-off Appointment": "10/8/2026 0:00", "Job Status": "Delivered", "  Payment  ": " $ 1,511.22 " });
// What n8n sends for the post-delivery re-issue of 900000101 (the shape of a real one).
const REISSUE = { "Load ID": "900000101", Details: "ROLLSTOCK, 7 Roll(s), 44,548 lbs, Equipment: Van/Min L = 53", "Pickup Info": "Mill REF/PU#: 7000000001, DEL#: 359000", "Pickup Appointment": "10/8/2026 00:00", "Pickup Address": "1 Mill Ln, Town, OK 74000", "Drop-off Appointment": "10/9/2026 00:01", "Assigned Date": "10/13/2026, 8:51:31 AM", Documents: "", "  Payment  ": "$1,446.56" };

async function section1() {
	if (!SRC.includes(KHEAD)) { check("§1 the route exists", false); return; }
	const db = draftsDb();
	addDraft(db, { loadId: "#900000102", total: "$1,511.22", sheetTotal: "$1,511.22" });
	const alerts = [];
	const lifted = closure(SRC, {
		routes: [KHEAD],
		provided: ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold"],
		denied: ["sendEmail", "transporter", "io", "server"],
	});
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	let sheetValues = [HEADERS, DELIVERED, IN_TRANSIT_INVOICED, DISPATCHED, DELIVERED_NO_PICKUP];
	const calls = [];
	const sheets = { spreadsheets: { values: {
		get: async (q) => { calls.push(["get", q.range]); return { data: { values: sheetValues } }; },
		update: async () => { calls.push(["update"]); }, append: async () => { calls.push(["append"]); }, batchUpdate: async () => { calls.push(["batchUpdate"]); },
	}, batchUpdate: async () => { calls.push(["batchUpdate"]); } } };
	const logs = [];
	const quiet = { ...console, log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };
	let dbForRoute = db;
	new Function("getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold", `"use strict";\n${lifted.text}`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET } }, app, require,
		new Proxy({}, { get: (_t, k) => (typeof dbForRoute[k] === "function" ? dbForRoute[k].bind(dbForRoute) : dbForRoute[k]) }),
		(a) => { alerts.push(a); return Promise.resolve({ alerted: true }); },
	);
	const post = async (body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": SECRET }, body, ip: "" }, res);
		await new Promise((r) => setImmediate(r));
		return out;
	};
	const heldCols = (b) => ((b && b.held) || []).map((h) => h.column).sort();

	// The production case: a delivered, invoiced load and its post-delivery re-issue.
	const r = await post({ loadId: "900000101", values: REISSUE, fallbacks: { Documents: "900000101" } });
	const v = (r.body && r.body.values) || {};
	check("§1 delivered: the route answers 200 and finds the load", r.status === 200 && r.body.found === true, r.body);
	check("§1 delivered: Payment comes back as stored, not the re-issue's lower total", v["  Payment  "] === " $ 1,516.56 ", v["  Payment  "]);
	check("§1 delivered: a different Pickup Appointment comes back as stored", v["Pickup Appointment"] === "10/9/2026 0:00", v["Pickup Appointment"]);
	check("§1 delivered: the same Drop-off moment written another way comes back as stored", v["Drop-off Appointment"] === "10/9/2026 0:01", v["Drop-off Appointment"]);
	check("§1 delivered: other columns still come back as sent", v.Details === REISSUE.Details && v["Pickup Info"] === REISSUE["Pickup Info"], { Details: v.Details, PickupInfo: v["Pickup Info"] });
	check("§1 delivered: the stored Assigned Date still comes back (unchanged rule)", v["Assigned Date"] === "10/7/2026, 3:56:51 PM", v["Assigned Date"]);
	check("§1 delivered: held names Payment and Pickup Appointment only (Drop-off is the same moment)",
		JSON.stringify(heldCols(r.body)) === JSON.stringify(["  Payment  ", "Pickup Appointment"].sort()), r.body && r.body.held);
	const pay = ((r.body && r.body.held) || []).find((h) => h.column === "  Payment  ");
	check("§1 delivered: each hold carries the stored and the sent value", pay && pay.stored === " $ 1,516.56 " && pay.sent === "$1,446.56", pay);
	check("§1 delivered: the reason says delivered", r.body && /delivered/i.test(String(r.body.holdReason || "")), r.body && r.body.holdReason);
	check("§1 delivered: one alert, with the load, the reason and the held columns",
		alerts.length === 1 && alerts[0].loadId === "900000101" && /delivered/i.test(String(alerts[0].reason || "")) && (alerts[0].held || []).length === 2, alerts);

	// Invoiced but not delivered: a draft exists under another spelling of the id.
	alerts.length = 0;
	const inv = await post({ loadId: "900000102", values: { "Load ID": "900000102", "Pickup Appointment": "10/7/2026 08:00", "Drop-off Appointment": "10/8/2026 00:00", "  Payment  ": "$1,476.22" } });
	const iv = (inv.body && inv.body.values) || {};
	check("§1 invoiced: Payment comes back as stored", iv["  Payment  "] === " $ 1,511.22 ", iv["  Payment  "]);
	check("§1 invoiced: a different Pickup Appointment comes back as stored", iv["Pickup Appointment"] === "10/6/2026 8:00", iv["Pickup Appointment"]);
	check("§1 invoiced: the draft is found under \"#X\"; the reason says invoiced", inv.body && /invoiced/i.test(String(inv.body.holdReason || "")), inv.body && inv.body.holdReason);
	check("§1 invoiced: one alert", alerts.length === 1 && alerts[0].loadId === "900000102", alerts);

	// Neither: every value as sent, nothing held, no alert (today's rule, kept).
	alerts.length = 0;
	const disp = await post({ loadId: "900000103", values: { "Load ID": "900000103", "Pickup Appointment": "10/13/2026 09:00", "Drop-off Appointment": "10/14/2026", "  Payment  ": "$2,700.00" } });
	const dv = (disp.body && disp.body.values) || {};
	check("§1 neither delivered nor invoiced: values come back as sent", dv["  Payment  "] === "$2,700.00" && dv["Pickup Appointment"] === "10/13/2026 09:00" && dv["Drop-off Appointment"] === "10/14/2026", dv);
	check("§1 neither: nothing held, no alert", heldCols(disp.body).length === 0 && alerts.length === 0, { held: disp.body && disp.body.held, alerts });

	// A delivered load with no stored pickup: the re-issue does not fill it.
	alerts.length = 0;
	const fill = await post({ loadId: "900000104", values: { "Load ID": "900000104", "Pickup Appointment": "10/6/2026 08:00", "  Payment  ": "$1,476.22" } });
	const fv = (fill.body && fill.body.values) || {};
	check("§1 delivered: a blank stored Pickup Appointment is not filled by a re-issue", fv["Pickup Appointment"] === "", fv["Pickup Appointment"]);
	check("§1 delivered: the fill is held and alerted, stored shown as blank", heldCols(fill.body).includes("Pickup Appointment") && alerts.length === 1, { held: fill.body && fill.body.held, alerts: alerts.length });

	// The same amount in another format is no change.
	alerts.length = 0;
	const same = await post({ loadId: "900000101", values: { "Load ID": "900000101", "  Payment  ": "$1,516.56", "Pickup Appointment": "10/9/2026 00:00" } });
	const sv = (same.body && same.body.values) || {};
	check("§1 delivered: the same amount and moment in another format come back as stored", sv["  Payment  "] === " $ 1,516.56 " && sv["Pickup Appointment"] === "10/9/2026 0:00", sv);
	check("§1 delivered: and are not a hold (no alert)", heldCols(same.body).length === 0 && alerts.length === 0, { held: same.body && same.body.held, alerts: alerts.length });

	// A draft table that can't be read: hold (fail closed) and log it.
	alerts.length = 0;
	logs.length = 0;
	dbForRoute = { prepare: () => { throw new Error("database is locked"); } };
	const locked = await post({ loadId: "900000103", values: { "Load ID": "900000103", "  Payment  ": "$2,700.00" } });
	check("§1 drafts unreadable: Payment is held (fails closed)", locked.body && locked.body.values && locked.body.values["  Payment  "] === " $ 2,635.29 ", locked.body);
	check("§1 drafts unreadable: logged", logs.some((l) => /load_invoice_drafts|invoice draft/i.test(l)), logs);
	dbForRoute = db;

	check("§1 the route never writes the sheet", calls.every(([k]) => k === "get"), calls);
}

// --- §2 the alert ledger -------------------------------------------------------
async function section2() {
	if (!/\n(async )?function alertRateConReissueHold\(/.test(SRC)) { check("§2 alertRateConReissueHold() exists in server.js", false); return; }
	const db = new Database(":memory:");
	const sends = [];
	const notes = [];
	const lifted = closure(SRC, { functions: ["alertRateConReissueHold"], provided: ["db", "sendEmail", "insertDispatchNotification", "io", "console", "process"] });
	const before = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length;
	const fn = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", `"use strict";\n${lifted.text}\nreturn alertRateConReissueHold;`)(
		db, async (to, subject, html) => { sends.push({ to, subject, html }); return true; },
		{ run: (...a) => { notes.push(a); } }, { to: () => ({ emit: () => {} }) },
		{ ...console, log: () => {}, error: () => {} }, { env: { ADMIN_NOTIFY_EMAIL: "admin@example.test" } },
	);
	const held = [{ column: "  Payment  ", stored: " $ 1,516.56 ", sent: "$1,446.56" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 00:00" }];
	const a1 = await fn({ loadId: "900000101", reason: "delivered and invoiced", held });
	check("§2 first sighting: emails ADMIN_NOTIFY_EMAIL with the load and both values", a1 && a1.alerted === true && sends.length === 1 && sends[0].to === "admin@example.test"
		&& /900000101/.test(sends[0].subject + sends[0].html) && /1,516\.56/.test(sends[0].html) && /1,446\.56/.test(sends[0].html), sends);
	check("§2 first sighting: an in-app notification too", notes.length === 1, notes.length);
	await fn({ loadId: "900000101", reason: "delivered and invoiced", held });
	check("§2 the same load, column and sent value: no second alert", sends.length === 1, sends.length);
	await fn({ loadId: "900000101", reason: "delivered and invoiced", held: [{ column: "  Payment  ", stored: " $ 1,516.56 ", sent: "$1,411.56" }] });
	check("§2 a new sent value alerts again", sends.length === 2, sends.length);
	const failing = { run: () => { throw new Error("notifications down"); } };
	const fn2 = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", `"use strict";\n${lifted.text}\nreturn alertRateConReissueHold;`)(
		db, async () => false, failing, { to: () => ({ emit: () => {} }) }, { ...console, log: () => {}, error: () => {} }, { env: { ADMIN_NOTIFY_EMAIL: "admin@example.test" } },
	);
	const a3 = await fn2({ loadId: "900000105", reason: "delivered", held: [{ column: "  Payment  ", stored: "$1.00", sent: "$2.00" }] });
	check("§2 nothing delivered: not stamped, so the next sighting retries", a3 && a3.alerted === false, a3);
	await fn({ loadId: "900000105", reason: "delivered", held: [{ column: "  Payment  ", stored: "$1.00", sent: "$2.00" }] });
	check("§2 the retry goes out", sends.some((s) => /900000105/.test(s.subject + s.html)), sends.map((s) => s.subject));
	const after = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
	check("§2 it writes no table but its own", after.length === before + 1, after);
}

// --- §3 the integrity check, check 5 ------------------------------------------
const EXPENSE_PERIOD_EXPR = JSON.parse((SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/) || [])[1] || "\"''\"");
const IC_HEADERS = ["Job Status", "Load ID", "Pickup Appointment", "Assigned Date", "  Payment  "];
function jt(rows) {
	return { headers: IC_HEADERS.slice(), data: rows.map((r, i) => ({ _rowIndex: i + 2, "Job Status": "Delivered", "Load ID": r.id, "Pickup Appointment": "10/9/2026 0:00", "Assigned Date": r.assigned || "10/7/2026, 3:56:51 PM", "  Payment  ": r.payment })) };
}
function icDb({ drafts = true } = {}) {
	const db = drafts ? draftsDb() : new Database(":memory:");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT 'd',
			load_id TEXT DEFAULT '', type TEXT NOT NULL DEFAULT 'Fuel', amount REAL NOT NULL DEFAULT 10, description TEXT DEFAULT '',
			date TEXT NOT NULL, status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
	`);
	return db;
}
async function runIc(db, sheet, now = new Date("2026-10-14T12:00:30Z")) {
	const sends = [];
	const result = await ic.runIntegrityCheck({
		db, write: true, now, readJobTracking: async () => sheet, readRateConEmails: null, expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		sendEmail: async (to, subject, html) => { sends.push({ to, subject, html }); return true; }, to: "admin@example.test",
		log: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} }, appZone: "America/New_York",
	});
	return { result, text: String((result.report && result.report.text) || "") + String((result.mail && result.mail.html) || "") };
}

async function section3() {
	const db = icDb();
	addDraft(db, { loadId: "900000201", total: "$1,516.56", sheetTotal: "$1,516.56" });
	addDraft(db, { loadId: "900000202", total: "$1,511.22", sheetTotal: "$1,511.22" });
	addDraft(db, { loadId: "900000203", total: "$405.84", sheetTotal: "" });
	addDraft(db, { loadId: "900000204", total: "$900.00", sheetTotal: "$900.00", createdAt: "2026-10-01T10:00:00Z" });
	addDraft(db, { loadId: "900000204", total: "$950.00", sheetTotal: "$950.00", createdAt: "2026-10-05T10:00:00Z" });
	addDraft(db, { loadId: "900000205", total: "$1,000.00", sheetTotal: "$1,000.00" });
	db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-09', 'locked')").run();
	const sheet = (p201) => jt([
		{ id: "900000201", payment: p201 },
		{ id: "900000202", payment: " $ 1,511.22 " },
		{ id: "900000203", payment: " $ 370.84 " },
		{ id: "900000204", payment: " $ 950.00 " },
		{ id: "900000205", payment: " $ 800.00 ", assigned: "9/28/2026, 10:00:00 AM" },
	]);
	const r1 = await runIc(db, sheet(" $ 1,446.56 "));
	check("§3 a Payment lowered after invoicing is reported, with both amounts",
		/Payment changed after invoic/i.test(r1.text) && /900000201/.test(r1.text) && /1,516\.56/.test(r1.text) && /1,446\.56/.test(r1.text), r1.text.slice(0, 400));
	check("§3 the same amount in another format is not reported", !/900000202/.test(r1.text));
	check("§3 a draft with no sheet_total is skipped", !/900000203/.test(r1.text));
	check("§3 the latest draft is the one compared", !/900000204/.test(r1.text));
	check("§3 a load in a closed month is not raised", !/900000205/.test(r1.text));
	const r2 = await runIc(db, sheet(" $ 1,446.56 "), new Date("2026-10-15T12:00:30Z"));
	check("§3 reported once: the next run doesn't name it again", !/900000201/.test(r2.text), r2.text.slice(0, 300));
	const r3 = await runIc(db, sheet(" $ 1,411.56 "), new Date("2026-10-16T12:00:30Z"));
	check("§3 a further change is reported again", /900000201/.test(r3.text) && /1,411\.56/.test(r3.text), r3.text.slice(0, 300));
	const before = JSON.stringify(db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id").all());
	check("§3 load_invoice_drafts is never written", before === JSON.stringify(db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id").all()));
	const bare = icDb({ drafts: false });
	let threw = null;
	try { await runIc(bare, sheet(" $ 1,446.56 ")); } catch (e) { threw = e.message; }
	check("§3 a database without load_invoice_drafts skips the check and the run still completes", threw === null, threw);
}

(async () => {
	await section1();
	await section2();
	await section3();
	console.log(`test-ratecon-reissue-hold: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
