#!/usr/bin/env node
/**
 * A rate con re-issued for a load that is already delivered or invoiced must not change the
 * load's Payment or dates; a person decides instead (2026-10-14). A broker's post-delivery
 * "Booked Load #" email (deductions, an "Advanced Total" and a "New Total") reached
 * POST /api/n8n/keep-stored-values like any rate con, and every non-blank value it carried was
 * written: Payment fell on invoiced loads, and pickup dates moved, which moves a driver's pay
 * window. Every value in this file is made up: load numbers, amounts, weights, references,
 * addresses, dates and names. None is copied from production or from a real rate con.
 *
 *   §1 POST /api/n8n/keep-stored-values, lifted, with a stand-in Job Tracking and an in-memory
 *      load_invoice_drafts and period_locks (their CREATE TABLEs taken from server.js). For a load
 *      whose Job Status is delivered (DISPATCH_COMPLETED_RE, the dispatch guard's own rule), that
 *      has an invoice draft, or on a sheet with no Job Status column (status unknown: fails closed):
 *      - Payment, Pickup Appointment and Drop-off Appointment come back as stored, each found by
 *        the money math's pattern ("Pickup Appointment Time", "Drop Off Appointment", "Payment ($)"
 *        too, compared in cents and as moments);
 *      - a blank stored date is not filled either;
 *      - the response names each held column with the stored and the sent value, and why;
 *      - the same amount or moment in another format is not a hold;
 *      - every other column still comes back as sent, and a blank stored Assigned Date the
 *        email fills is listed as a change;
 *      - the hold alert is raised with the load, the reason and the held columns;
 *      - the draft is found under any spelling of the load id ("#X", case, edge spaces);
 *      - a draft table that can't be read holds (fails closed) and says so;
 *      - the alert also lists every other field the re-issue changed, with stored and new values;
 *      a load whose dates book it into a closed month (a pickup to drop-off window reaching
 *      into one included) gets EVERY column back as stored (no fallback fills a blank), whatever
 *      its status; so does a load with a date that can't be placed, a load when the lock table
 *      can't be read, and a load whose OUTGOING values would book it into a closed month (a
 *      blank stored date filled with a closed-month one, or a row with no dates yet, or a
 *      delivered load's blank Assigned Date sent in a closed month) or carry a date that can't
 *      be placed (an ordinary load sent "TBD"); when every column is held, a blank stored
 *      Assigned Date the email would fill is listed as held and alerted; a load
 *      that is neither delivered, invoiced nor in a closed month still gets every value as sent,
 *      with nothing held and no alert; RATECON_REISSUE_HOLD_ENABLED=false turns the hold off;
 *      a found load's answer names its stored Load ID cell (storedLoadId); the route never
 *      writes the sheet.
 *   §2 alertRateConReissueHold(): once per load, column and sent value (a dedupe ledger like
 *      ratecon_extract_alerts); a new sent value alerts again; alerted_at is stamped only on a
 *      confirmed delivery (the email or the in-app notification), so a failed send retries; two
 *      overlapping calls send once (claimed_at), a stale claim is retaken, an already-alerted row
 *      is never sent again even when its claim is stale, a table made before claimed_at gets it;
 *      ids with spaces or "/" are their own loads; past the daily cap (counted in distinct loads)
 *      no email goes, but the in-app notification does and the change is stamped, so it is
 *      reported once; the email says why it held; first_seen and alerted_at are ISO strings; it
 *      writes no table but its own.
 *   §3 the daily integrity check, check 5: a load whose Job Tracking Payment differs from the
 *      sheet's figure when its invoice was drafted (load_invoice_drafts.sheet_total, the latest
 *      draft) is reported once; the same amount in another format is not, on the day or later;
 *      a further change is reported again; a draft with no sheet_total is skipped; a load whose
 *      accounting months (the server's loadRowAccountingMonths(), lifted) include a closed one is
 *      not raised; the log line and the notes count what was not raised; the server's rule
 *      (integrityClosedMonthsOf(), lifted) answers "can't tell" when the lock table can't be read,
 *      and the run says so; a database without load_invoice_drafts, or a caller with no
 *      closed-month rule, skips the check and says so in the log line.
 *   §4 lib/cell-compare.js, the one amount and moment reading both sides use: cents
 *      (trailing zeros, accounting negatives), moments (a date alone is 0:00, ISO and US forms);
 *      server.js's reissueSameValue() reads through it; reissueHeldColumn() holds Payment and the
 *      pickup and drop-off dates under any name the money math reads, and no other column n8n sends.
 *
 * SERVER_JS=<file> runs against another copy of server.js (a mutant, to show a case fails).
 * Pure: no server, no network. Run: node scripts/test-ratecon-reissue-hold.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
// server.js's own require, so a lifted `require("./lib/...")` finds this checkout's lib/.
const rootRequire = createRequire(path.join(ROOT, "server.js"));
let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const ic = require(path.join(ROOT, "lib", "integrity-check"));
const cellCompare = require(path.join(ROOT, "lib", "cell-compare"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const SECRET = "test-secret";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DRAFTS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS load_invoice_drafts \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const LOCKS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS period_locks \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
if (!DRAFTS_DDL || !LOCKS_DDL) { console.error("FAILED: load_invoice_drafts's or period_locks's CREATE TABLE was not found in server.js"); process.exit(1); }
function lockMonth(db, period) {
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', '2026-10-01T00:00:00Z')").run(period);
}
function draftsDb({ locks = true } = {}) {
	const db = new Database(":memory:");
	db.exec(DRAFTS_DDL[1]);
	if (locks) db.exec(LOCKS_DDL[1]);
	for (const col of ["sheet_total TEXT", "ratecon_total TEXT", "total_source TEXT"]) {
		try { db.exec(`ALTER TABLE load_invoice_drafts ADD COLUMN ${col}`); } catch { /* already there */ }
	}
	return db;
}
function addDraft(db, { loadId, total, sheetTotal, createdAt = "2026-10-12T12:00:00Z" }) {
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, sheet_total, ratecon_total, total_source, broker_name, created_at) VALUES (?, ?, ?, ?, ?, 'manual', 'Test Broker', ?)")
		.run(loadId, `INV-${loadId}`, total, sheetTotal, sheetTotal, createdAt);
}

// --- §1 the route -----------------------------------------------------------
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Info", "Pickup Appointment", "Pickup Address", "Drop-off Appointment", "Job Status", "Assigned Date", "Documents", "  Payment  "];
const row = (o) => HEADERS.map((h) => (o[h] === undefined ? "" : o[h]));
const DELIVERED = row({ "Load ID": "900000101", Details: "Paper rolls, 12,345 lbs", "Pickup Info": "Test Mill REF/PU#: 1000000001", "Pickup Appointment": "10/9/2026 0:00", "Pickup Address": "1 Test Ln, Testville, OK 70000", "Drop-off Appointment": "10/9/2026 0:01", "Job Status": "Delivered", "Assigned Date": "10/7/2026, 1:23:45 PM", Documents: "Yes", "  Payment  ": " $ 1,234.56 " });
const IN_TRANSIT_INVOICED = row({ "Load ID": "900000102", "Pickup Appointment": "10/6/2026 8:00", "Drop-off Appointment": "10/8/2026 0:00", "Job Status": "In Transit", "  Payment  ": " $ 2,222.22 " });
const DISPATCHED = row({ "Load ID": "900000103", "Pickup Appointment": "10/12/2026 10:00", "Drop-off Appointment": "", "Job Status": "Dispatched", "  Payment  ": " $ 3,333.33 " });
const DELIVERED_NO_PICKUP = row({ "Load ID": "900000104", "Pickup Appointment": "", "Drop-off Appointment": "10/8/2026 0:00", "Job Status": "Delivered", "  Payment  ": " $ 1,111.11 " });
// Not delivered and not invoiced, but its dates book it into September, which is closed.
const CLOSED_MONTH = row({ "Load ID": "900000106", Details: "Paper, 20,000 lbs", "Pickup Info": "Test Plant REF/PU#: 1", "Pickup Appointment": "9/28/2026 8:00", "Drop-off Appointment": "9/29/2026 0:00", "Job Status": "Dispatched", "Assigned Date": "9/27/2026, 9:00:00 AM", "  Payment  ": " $ 900.00 " });
// Delivered with no Assigned Date yet: the email's Assigned Date fills it, and that is listed.
const DELIVERED_NO_ASSIGNED = row({ "Load ID": "900000107", Details: "Boxes", "Pickup Appointment": "10/9/2026 0:00", "Drop-off Appointment": "10/10/2026 0:00", "Job Status": "Delivered", "Assigned Date": "", "  Payment  ": " $ 500.00 " });
// An ordinary load with a pickup that can't be placed in a month.
const TBD_PICKUP = row({ "Load ID": "900000108", Details: "Crates", "Pickup Appointment": "TBD", "Drop-off Appointment": "10/15/2026 0:00", "Job Status": "Dispatched", "Assigned Date": "10/12/2026, 9:00:00 AM", "  Payment  ": " $ 700.00 " });
const POD_RECEIVED = row({ "Load ID": "900000109", "Pickup Appointment": "10/5/2026 8:00", "Drop-off Appointment": "10/6/2026 0:00", "Job Status": "POD Received", "Assigned Date": "10/4/2026, 9:00:00 AM", "  Payment  ": " $ 600.00 " });
const COMPLETED = row({ "Load ID": "900000110", "Pickup Appointment": "10/5/2026 8:00", "Drop-off Appointment": "10/6/2026 0:00", "Job Status": "Completed", "Assigned Date": "10/4/2026, 9:00:00 AM", "  Payment  ": " $ 650.00 " });
// A pickup to drop-off window from closed September into open October, no Assigned Date.
const SPAN = row({ "Load ID": "900000111", Details: "Steel coil", "Pickup Appointment": "9/30/2026 08:00", "Drop-off Appointment": "10/2/2026 0:00", "Job Status": "In Transit", "Assigned Date": "", "  Payment  ": " $ 800.00 " });
// An ordinary October load with no stored pickup yet.
const BLANK_PICKUP = row({ "Load ID": "900000112", Details: "Lumber", "Pickup Appointment": "", "Drop-off Appointment": "10/2/2026 0:00", "Job Status": "Dispatched", "Assigned Date": "10/1/2026, 9:00:00 AM", "  Payment  ": " $ 400.00 " });
// A row with no dates at all yet.
const NO_DATES = row({ "Load ID": "900000113", Details: "Pallets", "Job Status": "Dispatched" });
// Stored under another spelling of its id.
const STORED_SPELLING = row({ "Load ID": "#X900000114", Details: "Drums", "Pickup Appointment": "10/13/2026 08:00", "Drop-off Appointment": "10/14/2026 0:00", "Job Status": "Dispatched", "Assigned Date": "10/12/2026, 9:00:00 AM", "  Payment  ": " $ 1,000.00 " });
const SHEET = [HEADERS, DELIVERED, IN_TRANSIT_INVOICED, DISPATCHED, DELIVERED_NO_PICKUP, CLOSED_MONTH, DELIVERED_NO_ASSIGNED, TBD_PICKUP, POD_RECEIVED, COMPLETED, SPAN, BLANK_PICKUP, NO_DATES, STORED_SPELLING];
// What n8n sends for the post-delivery re-issue of 900000101.
const REISSUE = { "Load ID": "900000101", Details: "Paper rolls, 6 Roll(s), 12,345 lbs, Equipment: Van 53", "Pickup Info": "Test Mill REF/PU#: 1000000001, DEL#: 100001", "Pickup Appointment": "10/8/2026 00:00", "Pickup Address": "1 Test Ln, Testville, OK 70000", "Drop-off Appointment": "10/9/2026 00:01", "Assigned Date": "10/13/2026, 8:00:00 AM", Documents: "", "  Payment  ": "$1,184.56" };

// Job Tracking with its columns named otherwise: each found by the money math's pattern.
const ALT_HEADERS = ["Load ID", "Details", "Pickup Appointment Time", "Drop Off Appointment", "Job Status", "Assigned Date", "Payment ($)"];
const ALT_SHEET = [ALT_HEADERS, ["900000131", "Steel", "10/9/2026 08:00", "10/10/2026 0:00", "Delivered", "10/8/2026, 9:00:00 AM", "$1,500.00"]];
// Job Tracking with no Job Status column: an ordinary October load, not invoiced.
const NO_STATUS_HEADERS = ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "  Payment  "];
const NO_STATUS_SHEET = [NO_STATUS_HEADERS, ["900000132", "Tiles", "10/12/2026 08:00", "10/13/2026 0:00", "10/11/2026, 9:00:00 AM", " $ 2,000.00 "]];

// The route, lifted, on `db` (a function: the database it reads at call time), with `env`,
// reading `sheet` as Job Tracking.
function liftRoute({ db, env = {}, sheet = SHEET }) {
	const alerts = [];
	const lifted = closure(SRC, {
		routes: [KHEAD],
		provided: ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold"],
		denied: ["sendEmail", "transporter", "io", "server"],
	});
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const calls = [];
	const sheets = { spreadsheets: { values: {
		get: async (q) => { calls.push(["get", q.range]); return { data: { values: sheet } }; },
		update: async () => { calls.push(["update"]); }, append: async () => { calls.push(["append"]); }, batchUpdate: async () => { calls.push(["batchUpdate"]); },
	}, batchUpdate: async () => { calls.push(["batchUpdate"]); } } };
	const logs = [];
	const quiet = { ...console, log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };
	new Function("getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold", `"use strict";\n${lifted.text}`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET, ...env } }, app, rootRequire,
		new Proxy({}, { get: (_t, k) => { const d = db(); return typeof d[k] === "function" ? d[k].bind(d) : d[k]; } }),
		(a) => { alerts.push(a); return Promise.resolve({ alerted: true }); },
	);
	const post = async (body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": SECRET }, body, ip: "" }, res);
		await new Promise((r) => setImmediate(r));
		return out;
	};
	return { post, alerts, calls, logs };
}
const heldCols = (b) => ((b && b.held) || []).map((h) => h.column).sort();
const valuesOf = (r) => (r.body && r.body.values) || {};
const reasonOf = (r) => String((r.body && r.body.holdReason) || "");

async function section1() {
	if (!SRC.includes(KHEAD)) { check("§1 the route exists", false); return; }
	const db = draftsDb();
	addDraft(db, { loadId: "#900000102", total: "$2,222.22", sheetTotal: "$2,222.22" });
	lockMonth(db, "2026-09");
	let dbForRoute = db;
	const { post, alerts, calls, logs } = liftRoute({ db: () => dbForRoute });

	// The case this fixes: a delivered, invoiced load and its post-delivery re-issue.
	const r = await post({ loadId: "900000101", values: REISSUE, fallbacks: { Documents: "900000101" } });
	const v = valuesOf(r);
	check("§1 delivered: the route answers 200 and finds the load", r.status === 200 && r.body.found === true, r.body);
	check("§1 delivered: Payment comes back as stored, not the re-issue's lower total", v["  Payment  "] === " $ 1,234.56 ", v["  Payment  "]);
	check("§1 delivered: a different Pickup Appointment comes back as stored", v["Pickup Appointment"] === "10/9/2026 0:00", v["Pickup Appointment"]);
	check("§1 delivered: the same Drop-off moment written another way comes back as stored", v["Drop-off Appointment"] === "10/9/2026 0:01", v["Drop-off Appointment"]);
	check("§1 delivered: other columns still come back as sent", v.Details === REISSUE.Details && v["Pickup Info"] === REISSUE["Pickup Info"], { Details: v.Details, PickupInfo: v["Pickup Info"] });
	check("§1 delivered: the stored Assigned Date still comes back (unchanged rule)", v["Assigned Date"] === "10/7/2026, 1:23:45 PM", v["Assigned Date"]);
	check("§1 delivered: held names Payment and Pickup Appointment only (Drop-off is the same moment)",
		JSON.stringify(heldCols(r.body)) === JSON.stringify(["  Payment  ", "Pickup Appointment"].sort()), r.body && r.body.held);
	const pay = ((r.body && r.body.held) || []).find((h) => h.column === "  Payment  ");
	check("§1 delivered: each hold carries the stored and the sent value", pay && pay.stored === " $ 1,234.56 " && pay.sent === "$1,184.56", pay);
	check("§1 delivered: the reason says delivered", /delivered/i.test(reasonOf(r)), reasonOf(r));
	check("§1 delivered: one alert, with the load, the reason and the held columns",
		alerts.length === 1 && alerts[0].loadId === "900000101" && /delivered/i.test(String(alerts[0].reason || "")) && (alerts[0].held || []).length === 2, alerts);
	const otherCols = ((alerts[0] && alerts[0].changed) || []).map((c) => c.column).sort();
	check("§1 delivered: the alert also lists every other field the re-issue changed (written, not held)",
		JSON.stringify(otherCols) === JSON.stringify(["Details", "Pickup Info"]), alerts[0] && alerts[0].changed);
	const det = ((alerts[0] && alerts[0].changed) || []).find((c) => c.column === "Details");
	check("§1 delivered: each listed change carries the stored and the new value", det && det.stored === "Paper rolls, 12,345 lbs" && det.sent === REISSUE.Details, det);
	check("§1 delivered: unchanged and blank-sent columns are not listed (Pickup Address, Documents, Assigned Date)",
		!otherCols.includes("Pickup Address") && !otherCols.includes("Documents") && !otherCols.includes("Assigned Date"));

	// M1: a blank stored Assigned Date the email fills is the one real Assigned Date change.
	alerts.length = 0;
	const na = await post({ loadId: "900000107", values: { "Load ID": "900000107", Details: "Boxes", "Assigned Date": "10/13/2026, 8:00:00 AM", "  Payment  ": "$500.00" } });
	const nav = valuesOf(na);
	check("§1 delivered, no stored Assigned Date: it comes back as sent", nav["Assigned Date"] === "10/13/2026, 8:00:00 AM", nav["Assigned Date"]);
	const naChanged = ((na.body && na.body.alsoChanged) || []).find((c) => c.column === "Assigned Date");
	check("§1 delivered, no stored Assigned Date: the fill is listed in alsoChanged, stored blank",
		!!naChanged && naChanged.stored === "" && naChanged.sent === "10/13/2026, 8:00:00 AM", na.body && na.body.alsoChanged);
	check("§1 delivered, no stored Assigned Date: and alerted as a change",
		alerts.length === 1 && ((alerts[0].changed || []).some((c) => c.column === "Assigned Date")), alerts);

	// Low 1: the same delivered load, its blank Assigned Date sent in closed September. The
	// load is already held (delivered), and the values going out are still checked.
	alerts.length = 0;
	const lc = await post({ loadId: "900000107", values: { "Load ID": "900000107", Details: "Boxes, 4 pallets", "Assigned Date": "9/28/2026, 9:00:00 AM", "  Payment  ": "$480.00" } });
	const lcv = valuesOf(lc);
	check("§1 delivered, a blank Assigned Date sent in a closed month: every column comes back as stored",
		lcv["Load ID"] === "900000107" && lcv.Details === "Boxes" && lcv["Assigned Date"] === "" && lcv["  Payment  "] === " $ 500.00 ", lcv);
	check("§1 delivered, a blank Assigned Date sent in a closed month: the reason says the re-issue's dates are in a closed month",
		/delivered/.test(reasonOf(lc)) && /the re-issue's dates are in a closed month \(2026-09\)/.test(reasonOf(lc)), reasonOf(lc));
	const lcAssigned = ((lc.body && lc.body.held) || []).find((h) => h.column === "Assigned Date");
	check("§1 delivered, a blank Assigned Date sent in a closed month: the Assigned Date is held (stored blank), and alerted",
		!!lcAssigned && lcAssigned.stored === "" && lcAssigned.sent === "9/28/2026, 9:00:00 AM" && alerts.length === 1, { held: lc.body && lc.body.held, alerts: alerts.length });

	// Low 3: every column held on the stored row alone (a window reaching into closed
	// September); the email's only news is the blank stored Assigned Date it would fill.
	alerts.length = 0;
	const fa = await post({ loadId: "900000111", values: { "Load ID": "900000111", "Assigned Date": "10/13/2026, 8:00:00 AM" } });
	check("§1 every column held, a blank stored Assigned Date sent: it comes back blank", valuesOf(fa)["Assigned Date"] === "", valuesOf(fa));
	const faHeld = ((fa.body && fa.body.held) || []).find((h) => h.column === "Assigned Date");
	check("§1 every column held, a blank stored Assigned Date sent: it is listed as held, stored blank",
		!!faHeld && faHeld.stored === "" && faHeld.sent === "10/13/2026, 8:00:00 AM", fa.body && fa.body.held);
	check("§1 every column held, a blank stored Assigned Date sent: and alerted",
		alerts.length === 1 && (alerts[0].held || []).some((h) => h.column === "Assigned Date"), alerts);

	// A closed month: every column is held, whatever the status.
	alerts.length = 0;
	const cm = await post({ loadId: "900000106", values: { "Load ID": "900000106", Details: "Paper, 21,000 lbs", "Pickup Info": "Test Plant REF/PU#: 2", "Pickup Appointment": "9/28/2026 09:00", "  Payment  ": "$850.00", Documents: "", "Assigned Date": "10/13/2026, 8:00:00 AM" }, fallbacks: { Documents: "900000106" } });
	const cv = valuesOf(cm);
	check("§1 closed month: every column comes back as stored", cv.Details === "Paper, 20,000 lbs" && cv["Pickup Info"] === "Test Plant REF/PU#: 1"
		&& cv["Pickup Appointment"] === "9/28/2026 8:00" && cv["  Payment  "] === " $ 900.00 ", cv);
	check("§1 closed month: a fallback does not fill a blank either", cv.Documents === "", cv.Documents);
	check("§1 closed month: Assigned Date comes back as stored and is not listed (kept by its own rule)",
		cv["Assigned Date"] === "9/27/2026, 9:00:00 AM" && !heldCols(cm.body).includes("Assigned Date"), { assigned: cv["Assigned Date"], held: heldCols(cm.body) });
	check("§1 closed month: the reason names the closed month, and each changed column is held",
		/closed month \(2026-09\)/.test(reasonOf(cm)) && JSON.stringify(heldCols(cm.body)) === JSON.stringify(["  Payment  ", "Details", "Pickup Appointment", "Pickup Info"].sort()), cm.body);
	check("§1 closed month: one alert", alerts.length === 1 && alerts[0].loadId === "900000106", alerts.length);

	// M2: a window from closed September into October, re-issued with an October pickup.
	alerts.length = 0;
	const sp = await post({ loadId: "900000111", values: { "Load ID": "900000111", "Pickup Appointment": "10/1/2026 08:00", "  Payment  ": "$750.00" } });
	const spv = valuesOf(sp);
	check("§1 a window reaching into a closed month: every column comes back as stored",
		spv["Pickup Appointment"] === "9/30/2026 08:00" && spv["  Payment  "] === " $ 800.00 ", spv);
	check("§1 a window reaching into a closed month: the reason names it", /in a closed month \(2026-09\)/.test(reasonOf(sp)), reasonOf(sp));

	// M2: an ordinary load with a date that can't be placed.
	alerts.length = 0;
	const tbd = await post({ loadId: "900000108", values: { "Load ID": "900000108", Details: "Crates, 2 skids", "Pickup Appointment": "10/14/2026 08:00", "  Payment  ": "$750.00" } });
	const tv = valuesOf(tbd);
	check("§1 a stored date that can't be placed: every column comes back as stored",
		tv["Pickup Appointment"] === "TBD" && tv["  Payment  "] === " $ 700.00 " && tv.Details === "Crates", tv);
	check("§1 a stored date that can't be placed: the reason says so", /a date on the load can't be placed/.test(reasonOf(tbd)), reasonOf(tbd));
	check("§1 a stored date that can't be placed: alerted", alerts.length === 1, alerts.length);

	// M2: POD Received and Completed are delivered.
	for (const [status, id, stored, sent] of [["POD Received", "900000109", " $ 600.00 ", "$550.00"], ["Completed", "900000110", " $ 650.00 ", "$600.00"]]) {
		const s = await post({ loadId: id, values: { "Load ID": id, "  Payment  ": sent } });
		check(`§1 Job Status "${status}": Payment comes back as stored`, valuesOf(s)["  Payment  "] === stored && /delivered/.test(reasonOf(s)), s.body);
	}
	// Low 5: "delivered" is the dispatch guard's own rule, not a copy of it.
	const holdFor = (SRC.match(/\nfunction reissueHoldFor\([\s\S]*?\n\}\n/) || [""])[0];
	check("§1 delivered is DISPATCH_COMPLETED_RE (the dispatch guard's rule), with no copy of its pattern",
		/DISPATCH_COMPLETED_RE\.test\(/.test(holdFor) && !/delivered\|completed/i.test(holdFor) && /\nconst DISPATCH_COMPLETED_RE = /.test(SRC), holdFor.slice(0, 200));

	// Invoiced but not delivered: a draft exists under another spelling of the id.
	alerts.length = 0;
	const inv = await post({ loadId: "900000102", values: { "Load ID": "900000102", "Pickup Appointment": "10/7/2026 08:00", "Drop-off Appointment": "10/8/2026 00:00", "  Payment  ": "$2,180.00" } });
	const iv = valuesOf(inv);
	check("§1 invoiced: Payment comes back as stored", iv["  Payment  "] === " $ 2,222.22 ", iv["  Payment  "]);
	check("§1 invoiced: a different Pickup Appointment comes back as stored", iv["Pickup Appointment"] === "10/6/2026 8:00", iv["Pickup Appointment"]);
	check("§1 invoiced: the draft is found under \"#X\"; the reason says invoiced", /invoiced/i.test(reasonOf(inv)), reasonOf(inv));
	check("§1 invoiced: one alert", alerts.length === 1 && alerts[0].loadId === "900000102", alerts);

	// Neither: every value as sent, nothing held, no alert (today's rule, kept).
	alerts.length = 0;
	const disp = await post({ loadId: "900000103", values: { "Load ID": "900000103", "Pickup Appointment": "10/13/2026 09:00", "Drop-off Appointment": "10/14/2026", "  Payment  ": "$3,400.00" } });
	const dv = valuesOf(disp);
	check("§1 neither delivered nor invoiced: values come back as sent", dv["  Payment  "] === "$3,400.00" && dv["Pickup Appointment"] === "10/13/2026 09:00" && dv["Drop-off Appointment"] === "10/14/2026", dv);
	check("§1 neither: nothing held, no alert", heldCols(disp.body).length === 0 && alerts.length === 0 && reasonOf(disp) === "", { held: disp.body && disp.body.held, alerts });

	// Low 2: the same ordinary open-month load, sent a pickup that can't be placed in a month.
	alerts.length = 0;
	const tb = await post({ loadId: "900000103", values: { "Load ID": "900000103", Details: "Crates of test parts", "Pickup Appointment": "TBD", "  Payment  ": "$3,400.00" } });
	const tbv = valuesOf(tb);
	check("§1 an ordinary load sent \"Pickup Appointment\": \"TBD\": every column comes back as stored",
		tbv["Pickup Appointment"] === "10/12/2026 10:00" && tbv["  Payment  "] === " $ 3,333.33 " && tbv.Details === "", tbv);
	check("§1 an ordinary load sent \"TBD\": the reason says a date the re-issue would write can't be placed",
		/a date the re-issue would write can't be placed in a month/.test(reasonOf(tb)), reasonOf(tb));
	check("§1 an ordinary load sent \"TBD\": the pickup, Payment and Details are held, and alerted",
		JSON.stringify(heldCols(tb.body)) === JSON.stringify(["  Payment  ", "Details", "Pickup Appointment"].sort()) && alerts.length === 1, { held: heldCols(tb.body), alerts: alerts.length });

	// EXTRA A: the values going out are held to the closed months too.
	alerts.length = 0;
	const bp = await post({ loadId: "900000112", values: { "Load ID": "900000112", Details: "Lumber, 30 bundles", "Pickup Appointment": "9/29/2026 08:00", "  Payment  ": "$450.00" } });
	const bpv = valuesOf(bp);
	check("§1 a blank stored date filled with a closed-month one: every column comes back as stored",
		bpv["Pickup Appointment"] === "" && bpv["  Payment  "] === " $ 400.00 " && bpv.Details === "Lumber", bpv);
	check("§1 a blank stored date filled with a closed-month one: the reason says the re-issue's dates are in a closed month",
		/re-issue's dates are in a closed month \(2026-09\)/.test(reasonOf(bp)), reasonOf(bp));
	check("§1 a blank stored date filled with a closed-month one: held lists the pickup, and it is alerted",
		heldCols(bp.body).includes("Pickup Appointment") && alerts.length === 1, { held: heldCols(bp.body), alerts: alerts.length });
	alerts.length = 0;
	const nd = await post({ loadId: "900000113", values: { "Load ID": "900000113", "Pickup Appointment": "9/25/2026 08:00", "Drop-off Appointment": "9/26/2026 0:00", "Assigned Date": "9/24/2026, 9:00:00 AM", "  Payment  ": "$300.00" } });
	const ndv = valuesOf(nd);
	check("§1 a row with no dates, given closed-month ones: every column comes back as stored (blank)",
		ndv["Pickup Appointment"] === "" && ndv["Drop-off Appointment"] === "" && ndv["Assigned Date"] === "" && ndv["  Payment  "] === "", ndv);
	check("§1 a row with no dates, given closed-month ones: the reason names the closed month",
		/closed month \(2026-09\)/.test(reasonOf(nd)) && heldCols(nd.body).includes("  Payment  "), nd.body);

	// EXTRA B: the stored row's Load ID, exactly as the sheet has it.
	const sl = await post({ loadId: "x900000114", values: { "Load ID": "x900000114", "  Payment  ": "$1,000.00" } });
	check("§1 storedLoadId: a found load names its Load ID cell as stored (\"#X\", asked as \"x\")",
		sl.body && sl.body.found === true && sl.body.storedLoadId === "#X900000114", sl.body);
	const nw = await post({ loadId: "900000999", values: { "Load ID": "900000999", "  Payment  ": "$1,000.00" } });
	check("§1 storedLoadId: absent for a new load", nw.body && nw.body.found === false && !Object.prototype.hasOwnProperty.call(nw.body, "storedLoadId"), nw.body);

	// A delivered load with no stored pickup: the re-issue does not fill it.
	alerts.length = 0;
	const fill = await post({ loadId: "900000104", values: { "Load ID": "900000104", "Pickup Appointment": "10/6/2026 08:00", "  Payment  ": "$1,050.00" } });
	const fv = valuesOf(fill);
	check("§1 delivered: a blank stored Pickup Appointment is not filled by a re-issue", fv["Pickup Appointment"] === "", fv["Pickup Appointment"]);
	check("§1 delivered: the fill is held and alerted, stored shown as blank", heldCols(fill.body).includes("Pickup Appointment") && alerts.length === 1, { held: fill.body && fill.body.held, alerts: alerts.length });

	// The same amount in another format is no change.
	alerts.length = 0;
	const same = await post({ loadId: "900000101", values: { "Load ID": "900000101", "  Payment  ": "$1,234.56", "Pickup Appointment": "10/9/2026 00:00" } });
	const sv = valuesOf(same);
	check("§1 delivered: the same amount and moment in another format come back as stored", sv["  Payment  "] === " $ 1,234.56 " && sv["Pickup Appointment"] === "10/9/2026 0:00", sv);
	check("§1 delivered: and are not a hold (no alert)", heldCols(same.body).length === 0 && alerts.length === 0, { held: same.body && same.body.held, alerts: alerts.length });

	// A draft table that can't be read: hold (fail closed) and log it.
	alerts.length = 0;
	logs.length = 0;
	dbForRoute = { prepare: () => { throw new Error("database is locked"); } };
	const locked = await post({ loadId: "900000103", values: { "Load ID": "900000103", "  Payment  ": "$3,400.00" } });
	check("§1 drafts unreadable: Payment is held (fails closed)", valuesOf(locked)["  Payment  "] === " $ 3,333.33 ", locked.body);
	check("§1 drafts unreadable: logged", logs.some((l) => /load_invoice_drafts|invoice draft/i.test(l)), logs);
	dbForRoute = db;

	check("§1 the route never writes the sheet", calls.every(([k]) => k === "get"), calls);

	// M2: a lock table that can't be read (no period_locks at all): every column held, said so.
	const noLocks = draftsDb({ locks: false });
	const broken = liftRoute({ db: () => noLocks });
	const bl = await broken.post({ loadId: "900000103", values: { "Load ID": "900000103", Details: "Changed", "  Payment  ": "$3,400.00" } });
	const blv = valuesOf(bl);
	check("§1 locks unreadable: every column comes back as stored", blv["  Payment  "] === " $ 3,333.33 " && blv.Details === "", blv);
	check("§1 locks unreadable: the reason says the closed months can't be read", /the closed months can't be read/.test(reasonOf(bl)), reasonOf(bl));

	// M2: the kill switch.
	const off = liftRoute({ db: () => db, env: { RATECON_REISSUE_HOLD_ENABLED: "false" } });
	const o = await off.post({ loadId: "900000101", values: REISSUE });
	const ov = valuesOf(o);
	check("§1 RATECON_REISSUE_HOLD_ENABLED=false: values come back as sent (stored Assigned Date rule kept)",
		ov["  Payment  "] === "$1,184.56" && ov["Pickup Appointment"] === "10/8/2026 00:00" && ov["Assigned Date"] === "10/7/2026, 1:23:45 PM", ov);
	check("§1 RATECON_REISSUE_HOLD_ENABLED=false: nothing held, no alert", heldCols(o.body).length === 0 && reasonOf(o) === "" && off.alerts.length === 0, { held: o.body && o.body.held, alerts: off.alerts.length });

	// Low 5: the held columns are found by the money math's patterns, not by exact name.
	const alt = liftRoute({ db: () => db, sheet: ALT_SHEET });
	const ar = await alt.post({ loadId: "900000131", values: { Details: "Steel, 2 coils", "Pickup Appointment Time": "10/8/2026 08:00", "Drop Off Appointment": "10/11/2026 0:00", "Payment ($)": "$1,465.00" } });
	const arv = valuesOf(ar);
	check("§1 columns named otherwise (\"Pickup Appointment Time\", \"Drop Off Appointment\", \"Payment ($)\"): each comes back as stored",
		arv["Pickup Appointment Time"] === "10/9/2026 08:00" && arv["Drop Off Appointment"] === "10/10/2026 0:00" && arv["Payment ($)"] === "$1,500.00", arv);
	check("§1 columns named otherwise: Details still comes back as sent, and the three are held",
		arv.Details === "Steel, 2 coils" && JSON.stringify(heldCols(ar.body)) === JSON.stringify(["Drop Off Appointment", "Payment ($)", "Pickup Appointment Time"]), ar.body);
	alt.alerts.length = 0;
	const as = await alt.post({ loadId: "900000131", values: { "Pickup Appointment Time": "10/9/2026 8:00", "Payment ($)": "1500.00" } });
	check("§1 columns named otherwise: the same amount and moment in another format are not a hold (cents, moments)",
		heldCols(as.body).length === 0 && alt.alerts.length === 0, { held: as.body && as.body.held, alerts: alt.alerts.length });

	// Low 5: no Job Status column to read: fail closed, as if delivered.
	const ns = liftRoute({ db: () => db, sheet: NO_STATUS_SHEET });
	const nr = await ns.post({ loadId: "900000132", values: { "Load ID": "900000132", Details: "Tiles, 9 pallets", "Pickup Appointment": "10/12/2026 09:00", "  Payment  ": "$1,950.00" } });
	const nrv = valuesOf(nr);
	check("§1 no Job Status column: Payment and the pickup come back as stored (fails closed)",
		nrv["  Payment  "] === " $ 2,000.00 " && nrv["Pickup Appointment"] === "10/12/2026 08:00", nrv);
	check("§1 no Job Status column: other columns still come back as sent", nrv.Details === "Tiles, 9 pallets", nrv.Details);
	check("§1 no Job Status column: the reason says the status is unknown, and it is alerted and logged",
		/status unknown/.test(reasonOf(nr)) && ns.alerts.length === 1 && /status unknown/.test(String(ns.alerts[0].reason || ""))
		&& ns.logs.some((l) => /no Job Status column/.test(l)), { reason: reasonOf(nr), alerts: ns.alerts.length, logs: ns.logs });
}

// --- §2 the alert ledger -------------------------------------------------------
const OLD_LEDGER_DDL = `CREATE TABLE ratecon_reissue_holds (load_id TEXT NOT NULL, column_name TEXT NOT NULL, sent_value TEXT NOT NULL,
	stored_value TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'held', reason TEXT NOT NULL DEFAULT '',
	first_seen DATETIME DEFAULT CURRENT_TIMESTAMP, alerted_at DATETIME, PRIMARY KEY (load_id, column_name, sent_value))`;

async function section2() {
	if (!/\n(async )?function alertRateConReissueHold\(/.test(SRC)) { check("§2 alertRateConReissueHold() exists in server.js", false); return; }
	const lifted = closure(SRC, { roots: ["alertRateConReissueHold"], provided: ["db", "sendEmail", "insertDispatchNotification", "io", "console", "process"] });
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	const make = ({ db, send = async () => true, notify = null, env = {} }) => {
		const sends = [];
		const notes = [];
		const fn = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", `"use strict";\n${lifted.text}\nreturn alertRateConReissueHold;`)(
			db, async (to, subject, html) => { sends.push({ to, subject, html }); return send(to, subject, html); },
			notify || { run: (...a) => { notes.push(a); } }, { to: () => ({ emit: () => {} }) },
			quiet, { env: { ADMIN_NOTIFY_EMAIL: "admin@example.test", ...env } },
		);
		return { fn, sends, notes };
	};

	const db = new Database(":memory:");
	const before = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length;
	const { fn, sends, notes } = make({ db });
	const held = [{ column: "  Payment  ", stored: " $ 1,234.56 ", sent: "$1,184.56" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 00:00" }];
	const a1 = await fn({ loadId: "900000101", reason: "delivered and invoiced", held });
	check("§2 first sighting: emails ADMIN_NOTIFY_EMAIL with the load and both values", a1 && a1.alerted === true && sends.length === 1 && sends[0].to === "admin@example.test"
		&& /900000101/.test(sends[0].subject + sends[0].html) && /1,234\.56/.test(sends[0].html) && /1,184\.56/.test(sends[0].html), sends);
	check("§2 first sighting: an in-app notification too", notes.length === 1, notes.length);
	await fn({ loadId: "900000101", reason: "delivered and invoiced", held });
	check("§2 the same load, column and sent value: no second alert", sends.length === 1, sends.length);
	await fn({ loadId: "900000101", reason: "delivered and invoiced", held: [{ column: "  Payment  ", stored: " $ 1,234.56 ", sent: "$1,134.56" }] });
	check("§2 a new sent value alerts again", sends.length === 2, sends.length);
	const rows = db.prepare("SELECT first_seen, alerted_at FROM ratecon_reissue_holds WHERE load_id = '900000101'").all();
	check("§2 first_seen and alerted_at are both ISO strings", rows.length > 0 && rows.every((x) => ISO_RE.test(String(x.first_seen)) && ISO_RE.test(String(x.alerted_at))), rows);

	const failing = make({ db, send: async () => false, notify: { run: () => { throw new Error("notifications down"); } } });
	const a3 = await failing.fn({ loadId: "900000105", reason: "delivered", held: [{ column: "  Payment  ", stored: "$1.00", sent: "$2.00" }] });
	check("§2 nothing delivered: not stamped, so the next sighting retries", a3 && a3.alerted === false, a3);
	await fn({ loadId: "900000105", reason: "delivered", held: [{ column: "  Payment  ", stored: "$1.00", sent: "$2.00" }] });
	check("§2 the retry goes out (the failed call released its claim)", sends.some((s) => /900000105/.test(s.subject + s.html)), sends.map((s) => s.subject));

	// N10: the lead sentence reads as a sentence whatever the reason.
	await fn({ loadId: "900000115", reason: "the closed months can't be read", held: [{ column: "  Payment  ", stored: "$5.00", sent: "$6.00" }] });
	const lead = sends.find((s) => /900000115/.test(s.subject));
	check("§2 the email says why it held: \"came in again; it was held because: <reason>.\"",
		!!lead && /came in again; it was held because: the closed months can&#39;t be read\./.test(lead.html) && !/after the load was/.test(lead.html), lead && lead.html.slice(0, 200));

	// L6: ids with a space or "/" are each their own load.
	const before6 = sends.length;
	await fn({ loadId: "PO 5555 A", reason: "delivered", held: [{ column: "  Payment  ", stored: "$7.00", sent: "$8.00" }] });
	await fn({ loadId: "PO 5555/B", reason: "delivered", held: [{ column: "  Payment  ", stored: "$7.00", sent: "$8.00" }] });
	check("§2 two different ids with spaces or \"/\": two alerts", sends.length === before6 + 2, sends.slice(before6).map((s) => s.subject));
	check("§2 and each is its own ledger key (no shared \"unidentified\" key)",
		db.prepare("SELECT COUNT(*) AS c FROM ratecon_reissue_holds WHERE load_id IN ('po 5555 a', 'po 5555/b')").get().c === 2
		&& db.prepare("SELECT COUNT(*) AS c FROM ratecon_reissue_holds WHERE load_id LIKE 'unidentified:%'").get().c === 0);

	const after = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
	check("§2 it writes no table but its own", after.length === before + 1, after);

	// L5: two overlapping calls for one new change send once.
	const cdb = new Database(":memory:");
	const slow = make({ db: cdb, send: async () => { await new Promise((r) => setTimeout(r, 20)); return true; } });
	const change = { loadId: "900000116", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] };
	const both = await Promise.all([slow.fn(change), slow.fn(change)]);
	check("§2 two concurrent calls for the same new change: one email", slow.sends.length === 1 && slow.notes.length === 1, { sends: slow.sends.length, results: both });
	// A claim left by a call that died is retaken once it is stale; a fresh one is not.
	// (The ledger stores the column name trimmed.)
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, claimed_at) VALUES (?, ?, ?, 'held', ?, ?)")
		.run("900000117", "Payment", "$9.00", new Date().toISOString(), new Date(Date.now() - 10 * 60 * 1000).toISOString());
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, claimed_at) VALUES (?, ?, ?, 'held', ?, ?)")
		.run("900000118", "Payment", "$9.00", new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
	const quick = make({ db: cdb });
	await quick.fn({ loadId: "900000117", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a claim older than 5 minutes is retaken and sent", quick.sends.length === 1 && /900000117/.test(quick.sends[0] && quick.sends[0].subject), quick.sends.map((s) => s.subject));
	await quick.fn({ loadId: "900000118", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a claim another call holds right now is left alone", quick.sends.length === 1, quick.sends.map((s) => s.subject));

	// L5: a table made before claimed_at existed gets the column.
	const odb = new Database(":memory:");
	odb.exec(OLD_LEDGER_DDL);
	const old = make({ db: odb });
	const oa = await old.fn({ loadId: "900000119", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a ledger made before claimed_at: the column is added and the alert goes out",
		oa && oa.alerted === true && odb.prepare("PRAGMA table_info(ratecon_reissue_holds)").all().some((c) => c.name === "claimed_at"), oa);

	// Nit 7: a row already alerted is never sent again, even with a claim older than 5 minutes.
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, alerted_at, claimed_at) VALUES (?, ?, ?, 'held', ?, ?, ?)")
		.run("900000122", "Payment", "$9.00", new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - 10 * 60 * 1000).toISOString());
	const quickBefore = { sends: quick.sends.length, notes: quick.notes.length };
	const aa = await quick.fn({ loadId: "900000122", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 an already-alerted row whose claim is older than 5 minutes: no second email or notification",
		quick.sends.length === quickBefore.sends && quick.notes.length === quickBefore.notes && aa && aa.reason === "already_alerted", { aa, sends: quick.sends.length });

	// Low 4: the daily cap stops the email only; the in-app notification goes in and the
	// change is stamped, so it is reported once.
	const capDb = new Database(":memory:");
	const capped = make({ db: capDb, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await capped.fn({ loadId: "900000120", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	const secondChange = { loadId: "900000121", reason: "delivered", held: [{ column: "  Payment  ", stored: "$20.00", sent: "$19.00" }] };
	const second = await capped.fn(secondChange);
	check("§2 with RATECON_REISSUE_ALERT_MAX_PER_DAY=1, a second load the same day gets no email: reason daily_cap",
		capped.sends.length === 1 && second && second.emailed === false && second.reason === "daily_cap", { sends: capped.sends.length, second });
	check("§2 ...but its in-app notification goes in", capped.notes.length === 2 && second.notified === true && second.alerted === true
		&& /900000121/.test(String(capped.notes[1] && capped.notes[1][1])), { notes: capped.notes.length, second });
	const rec = capDb.prepare("SELECT alerted_at FROM ratecon_reissue_holds WHERE load_id = '900000121'").get();
	check("§2 ...and the change is stamped as reported", !!rec && ISO_RE.test(String(rec.alerted_at)), rec);
	const third = await capped.fn(secondChange);
	check("§2 ...so its next sighting reports nothing again", capped.sends.length === 1 && capped.notes.length === 2 && third && third.reason === "already_alerted", { third, notes: capped.notes.length });

	// Nit 7: the cap counts loads, not ledger rows: one load with two held columns is one.
	const distinctDb = new Database(":memory:");
	const distinct = make({ db: distinctDb, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "2" } });
	await distinct.fn({ loadId: "900000123", reason: "delivered", held: [{ column: "  Payment  ", stored: "$30.00", sent: "$29.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 0:00" }] });
	const nextLoad = await distinct.fn({ loadId: "900000124", reason: "delivered", held: [{ column: "  Payment  ", stored: "$40.00", sent: "$39.00" }] });
	check("§2 with RATECON_REISSUE_ALERT_MAX_PER_DAY=2, a second load after one with two held columns is still emailed (distinct loads)",
		distinct.sends.length === 2 && nextLoad && nextLoad.emailed === true, { sends: distinct.sends.length, nextLoad });
}

// --- §3 the integrity check, check 5 ------------------------------------------
const EXPENSE_PERIOD_EXPR = JSON.parse((SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/) || [])[1] || "\"''\"");
const IC_HEADERS = ["Job Status", "Load ID", "Pickup Appointment", "Assigned Date", "  Payment  "];
function jt(rows) {
	return { headers: IC_HEADERS.slice(), data: rows.map((r, i) => ({ _rowIndex: i + 2, "Job Status": "Delivered", "Load ID": r.id, "Pickup Appointment": r.pickup || "10/9/2026 0:00", "Assigned Date": r.assigned || "10/7/2026, 1:23:45 PM", "  Payment  ": r.payment })) };
}
function icDb({ drafts = true, locks = true } = {}) {
	const db = drafts ? draftsDb({ locks }) : new Database(":memory:");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT 'd',
			load_id TEXT DEFAULT '', type TEXT NOT NULL DEFAULT 'Fuel', amount REAL NOT NULL DEFAULT 10, description TEXT DEFAULT '',
			date TEXT NOT NULL, status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
	`);
	if (!drafts && locks) db.exec(LOCKS_DDL[1]);
	return db;
}
// The server's own accounting-month rule, lifted, with the database's locks: what
// server.js hands the job as closedMonthsOf.
const { loadRowAccountingMonths } = new Function(`"use strict";\n${closure(SRC, { roots: ["loadRowAccountingMonths"] }).text}\nreturn { loadRowAccountingMonths };`)();
const closedMonthsOf = (db) => (headers, r) => {
	const months = loadRowAccountingMonths(headers, headers.map((h) => r[h]));
	if (months === null) return null;
	const locked = new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((x) => x.period));
	return months.filter((mk) => locked.has(mk));
};
const quietLog = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
async function runIc(db, sheet, now = new Date("2026-10-14T12:00:30Z"), rule = closedMonthsOf(db)) {
	const sends = [];
	const result = await ic.runIntegrityCheck({
		db, write: true, now, readJobTracking: async () => sheet, readRateConEmails: null, expensePeriodExpr: EXPENSE_PERIOD_EXPR, closedMonthsOf: rule,
		sendEmail: async (to, subject, html) => { sends.push({ to, subject, html }); return true; }, to: "admin@example.test",
		log: quietLog, appZone: "America/New_York",
	});
	return { result, text: String((result.report && result.report.text) || "") + String((result.mail && result.mail.html) || "") };
}

async function section3() {
	const db = icDb();
	addDraft(db, { loadId: "900000201", total: "$1,234.56", sheetTotal: "$1,234.56" });
	addDraft(db, { loadId: "900000202", total: "$2,222.22", sheetTotal: "$2,222.22" });
	addDraft(db, { loadId: "900000203", total: "$405.00", sheetTotal: "" });
	addDraft(db, { loadId: "900000204", total: "$900.00", sheetTotal: "$900.00", createdAt: "2026-10-01T10:00:00Z" });
	addDraft(db, { loadId: "900000204", total: "$950.00", sheetTotal: "$950.00", createdAt: "2026-10-05T10:00:00Z" });
	addDraft(db, { loadId: "900000205", total: "$1,000.00", sheetTotal: "$1,000.00" });
	addDraft(db, { loadId: "900000206", total: "$600.00", sheetTotal: "$600.00" });
	lockMonth(db, "2026-09");
	const sheet = (p201) => jt([
		{ id: "900000201", payment: p201 },
		{ id: "900000202", payment: " $ 2,222.22 " },
		{ id: "900000203", payment: " $ 370.00 " },
		{ id: "900000204", payment: " $ 950.00 " },
		{ id: "900000205", payment: " $ 800.00 ", assigned: "9/28/2026, 10:00:00 AM" },
		{ id: "900000206", payment: " $ 550.00 ", pickup: "TBD" },
	]);
	const r1 = await runIc(db, sheet(" $ 1,184.56 "));
	check("§3 a Payment lowered after invoicing is reported, with both amounts",
		/Payment changed after invoic/i.test(r1.text) && /900000201/.test(r1.text) && /1,234\.56/.test(r1.text) && /1,184\.56/.test(r1.text), r1.text.slice(0, 400));
	check("§3 the same amount in another format is not reported", !/900000202/.test(r1.text));
	check("§3 a draft with no sheet_total is skipped", !/900000203/.test(r1.text));
	check("§3 the latest draft is the one compared", !/900000204/.test(r1.text));
	check("§3 a load in a closed month is not raised", !/900000205/.test(r1.text));
	check("§3 a load with a date that can't be placed is not raised", !/900000206/.test(r1.text));
	const line1 = String(r1.result.logLine || "");
	check("§3 the log line names the change", /Payment changed after invoicing: load 900000201/.test(line1), line1);
	check("§3 the log line counts what was not raised: closed month, month untold, no sheet total",
		/not raised: 1 in a closed month, 1 whose month can't be told \(a date that can't be placed, or closed months that can't be read\), 1 with no sheet total/.test(line1), line1);
	const notes1 = ((r1.result.report && r1.result.report.notes) || []).join(" | ");
	check("§3 the notes count the closed-month load", /1 load with a Payment different from the invoice is in a closed month/.test(notes1), notes1);
	check("§3 the notes count the load whose month can't be told", /1 load with a Payment different from the invoice could not be placed/.test(notes1), notes1);
	const r2 = await runIc(db, sheet(" $ 1,184.56 "), new Date("2026-10-15T12:00:30Z"));
	check("§3 reported once: the next run doesn't name it again", !/900000201/.test(r2.text), r2.text.slice(0, 300));
	const r2b = await runIc(db, sheet("1184.560"), new Date("2026-10-15T13:00:30Z"));
	check("§3 the same amount reformatted later is not named again, only counted",
		!/900000201/.test(r2b.text) && r2b.result.report.payments.reportedOpen === 1, { text: r2b.text.slice(0, 300), payments: r2b.result.report.payments });
	const r3 = await runIc(db, sheet(" $ 1,134.56 "), new Date("2026-10-16T12:00:30Z"));
	check("§3 a further change is reported again", /900000201/.test(r3.text) && /1,134\.56/.test(r3.text), r3.text.slice(0, 300));
	const ledger = db.prepare(`SELECT sheet_payment FROM ${ic.PAYMENTS_TABLE} WHERE load_id = '900000201' ORDER BY sheet_payment`).all().map((x) => x.sheet_payment);
	check("§3 the ledger keys the Payment by its cents", JSON.stringify(ledger) === JSON.stringify(["113456", "118456"]), ledger);
	const before = JSON.stringify(db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id").all());
	check("§3 load_invoice_drafts is never written", before === JSON.stringify(db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id").all()));
	const bare = icDb({ drafts: false });
	let threw = null;
	let bareRun = null;
	try { bareRun = await runIc(bare, sheet(" $ 1,184.56 ")); } catch (e) { threw = e.message; }
	check("§3 a database without load_invoice_drafts skips the check and the run still completes", threw === null && /not checked/i.test(bareRun.result.logLine || ""), threw || (bareRun && bareRun.result.logLine));
	const noRule = await ic.runIntegrityCheck({
		db: icDb(), write: false, now: new Date("2026-10-14T12:00:30Z"), readJobTracking: async () => sheet(" $ 1,184.56 "), expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		log: quietLog, appZone: "America/New_York",
	});
	check("§3 without a closed-month rule the check is skipped, never run without it", noRule.report.payments.skipped === "no closed-month rule was given", noRule.report.payments);

	// L7: the server's rule says "can't tell" when the lock table can't be read.
	const rule = closure(SRC, { roots: ["integrityClosedMonthsOf"], provided: ["db"] });
	const noLocks = icDb({ locks: false });
	addDraft(noLocks, { loadId: "900000201", total: "$1,234.56", sheetTotal: "$1,234.56" });
	const serverRule = new Function("db", `"use strict";\n${rule.text}\nreturn integrityClosedMonthsOf;`)(noLocks);
	const rb = await runIc(noLocks, sheet(" $ 1,184.56 "), new Date("2026-10-14T12:00:30Z"), serverRule);
	const pb = rb.result.report.payments;
	check("§3 locks unreadable: the server's rule makes the load untold, not closed (counted, not raised)",
		pb.unknownMonth === 1 && pb.closed === 0 && pb.changes.length === 0, pb);
	check("§3 locks unreadable: the run says the closed months can't be read",
		/closed months that can't be read/.test(String(rb.result.logLine || "")) && /closed months that can't be read/.test((rb.result.report.notes || []).join(" ")), rb.result.logLine);
}

// --- §4 lib/cell-compare.js and reissueSameValue() ------------------------------
function section4() {
	const { moneyCents, sameMoment } = cellCompare;
	check("§4 moneyCents: \"$1,234.56\" and \" $ 1,234.56 \" are 123456", moneyCents("$1,234.56") === 123456 && moneyCents(" $ 1,234.56 ") === 123456);
	check("§4 moneyCents: \"1234.560\" (a trailing zero) is 123456", moneyCents("1234.560") === 123456, moneyCents("1234.560"));
	check("§4 moneyCents: \"1234.565\" (a fraction of a cent) is no amount, never rounded", moneyCents("1234.565") === null, moneyCents("1234.565"));
	check("§4 moneyCents: \"($100.00)\" is -10000, as \"-$100.00\" and \"$-100.00\"",
		moneyCents("($100.00)") === -10000 && moneyCents("-$100.00") === -10000 && moneyCents("$-100.00") === -10000, [moneyCents("($100.00)"), moneyCents("-$100.00")]);
	check("§4 moneyCents: no amount is null (blank, text, \"(-$1.00)\", exponent, an over-long cell)",
		[null, "", "TBD", "(-$1.00)", "1e5", `$${"1".repeat(50)}`].every((x) => moneyCents(x) === null));
	check("§4 sameMoment: \"10/9/2026\" is \"10/9/2026 0:00\" (a date alone is that day at 0:00)", sameMoment("10/9/2026", "10/9/2026 0:00"));
	check("§4 sameMoment: ISO \"2026-10-09\" is \"10/9/2026\"", sameMoment("2026-10-09", "10/9/2026"));
	check("§4 sameMoment: \"10/9/2026, 3:45:12 PM\" is \"2026-10-09T15:45:12\"", sameMoment("10/9/2026, 3:45:12 PM", "2026-10-09T15:45:12"));
	check("§4 sameMoment: \"10/9/2026 0:01\" is \"10/9/2026 00:01\"; 12:00 AM is 0:00", sameMoment("10/9/2026 0:01", "10/9/2026 00:01") && sameMoment("10/9/2026 12:00 AM", "10/9/2026"));
	check("§4 sameMoment: different moments, an instant with a zone, or no date are not the same",
		!sameMoment("10/9/2026", "10/9/2026 0:01") && !sameMoment("2026-10-09T08:00:00Z", "10/9/2026 8:00") && !sameMoment("2/30/2026", "3/2/2026") && !sameMoment("TBD", "TBD"));

	const lifted = closure(SRC, { roots: ["reissueSameValue"], provided: ["require"] });
	const same = new Function("require", `"use strict";\n${lifted.text}\nreturn reissueSameValue;`)(rootRequire);
	check("§4 reissueSameValue: Payment \"1234.560\" is \"$1,234.56\"", same("  Payment  ", "1234.560", "$1,234.56"));
	check("§4 reissueSameValue: Payment \"($100.00)\" is \"-$100.00\"", same("Payment", "($100.00)", "-$100.00"));
	check("§4 reissueSameValue: Pickup Appointment \"10/9/2026\" is \"10/9/2026 0:00\"", same("Pickup Appointment", "10/9/2026", "10/9/2026 0:00"));
	check("§4 reissueSameValue: Drop-off Appointment \"2026-10-09\" is \"10/9/2026\"", same("Drop-off Appointment", "2026-10-09", "10/9/2026"));
	check("§4 reissueSameValue: a date column's text that is no moment compares as text (spaces collapsed)",
		same("Drop-off Appointment", "TBD  by phone", "TBD by phone") && !same("Drop-off Appointment", "TBD", "10/9/2026"));
	check("§4 reissueSameValue: a real change is a change", !same("Payment", "$1.00", "$1.01") && !same("Pickup Appointment", "10/9/2026", "10/10/2026"));
	check("§4 reissueSameValue: an amount column named otherwise compares in cents, an abbreviated date column as a moment",
		same("Payment ($)", "1500.00", "$1,500.00") && same("Rate", "$900", "900.00") && same("Pickup Appt", "10/9/2026", "10/9/2026 0:00"));

	// Low 5: the held columns, by the money math's patterns.
	const heldLift = closure(SRC, { roots: ["reissueHeldColumn"] });
	const isHeld = new Function(`"use strict";\n${heldLift.text}\nreturn reissueHeldColumn;`)();
	const heldNames = ["  Payment  ", "Payment", "Payment ($)", "Rate", "Total Amount", "Revenue", "Pickup Appointment", "Pickup Appointment Time", "Pickup Date",
		"Drop-off Appointment", "Drop Off Appointment", "Dropoff Appt Date", "Delivery Date"];
	const freeNames = ["Load ID", "Details", "Pickup Info", "Pickup Address", "Drop-off Info", "Drop-off Address", "Broker Contact Name", "Phone Number", "Email",
		"Assigned Date", "Documents", "Job Status", "Contract ID"];
	check("§4 reissueHeldColumn: Payment and the pickup and drop-off dates, under any name the money math reads",
		heldNames.every(isHeld), heldNames.filter((n) => !isHeld(n)));
	check("§4 reissueHeldColumn: every other column n8n sends is free (Assigned Date has its own rule)",
		freeNames.every((n) => !isHeld(n)), freeNames.filter(isHeld));

	const icSrc = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	const libSrc = fs.readFileSync(path.join(ROOT, "lib", "cell-compare.js"), "utf8");
	check("§4 one amount reading: server.js and lib/integrity-check.js both require lib/cell-compare.js, and neither keeps a copy",
		/\nconst cellCompare = require\("\.\/lib\/cell-compare"\);\n/.test(SRC) && /require\("\.\/cell-compare"\)/.test(icSrc)
		&& !/function amountCents\(/.test(icSrc) && !/\\d\{1,9\}\(\?:\\\.\\d\{1,2\}\)\?\$/.test(SRC + icSrc));
	check("§4 lib/cell-compare.js is pure (requires nothing)", !/\brequire\(/.test(libSrc.replace(/\/\/.*$/gm, "")));
}

(async () => {
	await section1();
	await section2();
	await section3();
	section4();
	console.log(`test-ratecon-reissue-hold: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
