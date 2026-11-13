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
 *        header pattern, REISSUE_HELD_COLUMN_RES ("Pickup Appointment Time", "Drop Off Appointment", "Payment ($)"
 *        too, compared in cents and as moments);
 *      - a blank stored date is not filled either;
 *      - the response names each held column with the stored and the sent value, and why;
 *      - the same amount or moment in another format is not a hold;
 *      - every other column still comes back as sent; a blank stored Assigned Date is not
 *        filled either (decision 3, 2026-10-14): the email's date is listed as held;
 *      - the hold alert is raised with the load, the reason and the held columns;
 *      - the draft is found under any spelling of the load id ("#X", case, edge spaces);
 *      - a draft table that can't be read holds (fails closed) and says so;
 *      - the alert also lists every other field the re-issue changed, with stored and new values;
 *      a load whose dates book it into a closed month (a pickup to drop-off window reaching
 *      into one included) gets EVERY column back as stored (no fallback fills a blank), whatever
 *      its status; so does a load with a date that can't be placed, a load when the lock table
 *      can't be read, and a load whose OUTGOING values would book it into a closed month (a
 *      blank stored date filled with a closed-month one, or a row with no dates yet; a
 *      delivered load's blank Assigned Date sent in a closed month is held, so it does not, and
 *      the reason names that month) or
 *      carry a date that can't be placed (an ordinary load sent "TBD"); when every column is held, a blank stored
 *      Assigned Date the email would fill is listed as held and alerted; a load
 *      that is neither delivered, invoiced nor in a closed month (a blank Job Status cell
 *      included) still gets every value as sent, with nothing held and no alert; RATECON_REISSUE_HOLD_ENABLED=false turns the hold off;
 *      a found load's answer names its stored Load ID cell (storedLoadId); the route never
 *      writes the sheet.
 *   §1x DVIR lines never lower Payment (RATECON_DVIR_KEEP_ENABLED, lib/ratecon-dvir-keep.js), on
 *      made-up C.H. Robinson loads (chrobinson.com, 9-digit Load IDs) whose rate con the extract
 *      route read (noteRateConDvir()). On: an open load's email $35 lower by one readable DVIR line
 *      keeps Payment as stored, with one ratecon_payment_kept_dvir audit row, a "kept" decision row
 *      and no alert; with no reading, an expired one or an unreadable PDF, one or two lines' worth is
 *      kept and alerted (source "dvir", decision "held"); a reading that disagrees with the drop, DVIR
 *      lines plus another amount, or readable text with no DVIR line is held too; a $40 drop, $105
 *      unread, a rise, another broker and an 8-digit Load ID follow today's rule with no row; a
 *      delivered load keeps today's hold, with no alert when Payment was its only change and the
 *      alert when a date changed too; a closed month keeps every column and records nothing; with
 *      the re-issue hold off nothing is kept or recorded. F1: a revised CHR rate con carrying an
 *      advance and a DVIR line leaves Payment at the stored figure (never the revised Total, never
 *      the New Total). The decision table holds cents and codes only. Off: every answer and alert
 *      is the base's own (scripts/fixtures/ratecon-dvir-keep-flag-off.json, captured on the base
 *      with --capture=<file>), and each decision is recorded as would_keep or would_hold;
 *      scripts/ratecon-dvir-keep-report.js counts them read-only, with no load number.
 *   §2 alertRateConReissueHold(): once per load, column and sent value (a dedupe ledger like
 *      ratecon_extract_alerts); a new sent value alerts again; alerted_at is stamped only on a
 *      confirmed delivery (the email or the in-app notification), so a failed send retries; two
 *      overlapping calls send once (claimed_at), a stale claim is retaken, an already-alerted row
 *      is never sent again even when its claim is stale, a table made before claimed_at gets it;
 *      ids with spaces or "/" are their own loads; past the daily cap (counted in distinct loads)
 *      no email goes, but the in-app notification does and the change is stamped, so it is
 *      reported once; the in-app notification shows each column's old and new value, except a
 *      broker contact column (BROKER_WITHHELD_RE), named without values; the email says why it held; first_seen and alerted_at are ISO strings; it
 *      writes no table but its own.
 *      B7: each channel is stamped on its own (emailed_at, notified_at) as soon as it went out,
 *      the in-app notification before the email is awaited: an email that answered false or
 *      rejected is retried on the next sighting without a second notification, a failed
 *      notification without a second email, both when both failed, and the log line names the
 *      failed channel; the email lists only the rows that owe it; the cap counts loads emailed
 *      (or still owed an email) in 24 h, so a load already emailed is not capped again while a
 *      new load, and a load the cap held back, is; a capped change (or one with no
 *      ADMIN_NOTIFY_EMAIL) is never emailed later (email_skipped); a claim is stale after
 *      15 minutes, and a call releases only its own; overlapping calls send once per channel;
 *      a ledger made before these columns gets them (an IMMEDIATE transaction), its alerted
 *      rows marked before_tracking on both channels, nothing re-sent. The retry sweep
 *      (sweepRateConReissueHolds()) sends what rows first seen in the last 48 h still owe, from
 *      the ledger, since a change is rarely seen again; older rows are given up (gave_up), one
 *      log line per load; a sweep and a sighting together send once per channel; a replica
 *      (startsJob()) or RATECON_REISSUE_HOLD_ENABLED=false starts no sweep, and otherwise it
 *      runs every 15 minutes on an unref'd timer. A row is retried only at its next slot
 *      (15 min, 30 min, 1 h, 2 h, then every 4 h after its last try; attempts and last_try),
 *      and a sweep logs one summary line naming the loads still failing; each load is claimed
 *      with the time the sweep reached it; the retry carries the reason and the load number as
 *      first written, and says when the change was first seen (APP_TIMEZONE); the in-app
 *      notification goes in before the email starts; the cap counts a load still owed an email
 *      (so a new load is capped) but not one told in-app only, and a load owed an email from an
 *      alert over 24 h old still gets its retry.
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
 *      pickup and drop-off dates under the names its patterns read, and no other column of the sheet
 *      (Completion Date and Status Update Date included).
 *
 * SERVER_JS=<file> runs against another copy of server.js (a mutant, to show a case fails).
 * --capture=<file> (with SERVER_JS naming the base) writes §1x's switch-off answers there.
 * Pure: no server, no network. Run: node scripts/test-ratecon-reissue-hold.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { textPdf } = require("./lib/made-up-pdf");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
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
const appTime = require(path.join(ROOT, "lib", "app-time"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eqCheck(name, actual, expected) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const SECRET = "test-secret";
// RATECON_PERSON_EDIT_HOLD_ENABLED from this runner's own environment reaches the lifted
// route's stand-in env, so every case here also runs with the person-edit hold on
// (scripts/test-reissue-runners-person-hold-on.js does that run); a case's own env wins.
const PERSON_HOLD_ENV = process.env.RATECON_PERSON_EDIT_HOLD_ENABLED === undefined ? {} : { RATECON_PERSON_EDIT_HOLD_ENABLED: process.env.RATECON_PERSON_EDIT_HOLD_ENABLED };
const ISO_RE =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
// Delivered with no Assigned Date yet: the email's Assigned Date does not fill it; it is held.
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
// An open-month load whose Job Status cell is blank, with no invoice draft: nothing to hold.
const BLANK_STATUS = row({ "Load ID": "900000133", Details: "Cartons", "Pickup Appointment": "10/13/2026 08:00", "Drop-off Appointment": "10/14/2026 0:00", "Job Status": "", "Assigned Date": "10/12/2026, 9:00:00 AM", "  Payment  ": " $ 1,200.00 " });
const SHEET = [HEADERS, DELIVERED, IN_TRANSIT_INVOICED, DISPATCHED, DELIVERED_NO_PICKUP, CLOSED_MONTH, DELIVERED_NO_ASSIGNED, TBD_PICKUP, POD_RECEIVED, COMPLETED, SPAN, BLANK_PICKUP, NO_DATES, STORED_SPELLING, BLANK_STATUS];
// What n8n sends for the post-delivery re-issue of 900000101.
const REISSUE = { "Load ID": "900000101", Details: "Paper rolls, 6 Roll(s), 12,345 lbs, Equipment: Van 53", "Pickup Info": "Test Mill REF/PU#: 1000000001, DEL#: 100001", "Pickup Appointment": "10/8/2026 00:00", "Pickup Address": "1 Test Ln, Testville, OK 70000", "Drop-off Appointment": "10/9/2026 00:01", "Assigned Date": "10/13/2026, 8:00:00 AM", Documents: "", "  Payment  ": "$1,184.56" };

// Job Tracking with its columns named otherwise: each found by header pattern (REISSUE_HELD_COLUMN_RES).
const ALT_HEADERS = ["Load ID", "Details", "Pickup Appointment Time", "Drop Off Appointment", "Job Status", "Assigned Date", "Payment ($)"];
const ALT_SHEET = [ALT_HEADERS, ["900000131", "Steel", "10/9/2026 08:00", "10/10/2026 0:00", "Delivered", "10/8/2026, 9:00:00 AM", "$1,500.00"]];
// Job Tracking with no Job Status column: an ordinary October load, not invoiced.
const NO_STATUS_HEADERS = ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "  Payment  "];
const NO_STATUS_SHEET = [NO_STATUS_HEADERS, ["900000132", "Tiles", "10/12/2026 08:00", "10/13/2026 0:00", "10/11/2026, 9:00:00 AM", " $ 2,000.00 "]];

// The route, lifted, on `db` (a function: the database it reads at call time), with `env`,
// reading `sheet` as Job Tracking; `roots` are lifted with it and returned.
function liftRoute({ db, env = {}, sheet = SHEET, roots = [] }) {
	const alerts = [];
	const lifted = closure(SRC, {
		routes: [KHEAD],
		roots,
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
	const fns = new Function("getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold", `"use strict";\n${lifted.text}\nreturn { ${roots.join(", ")} };`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET, ...PERSON_HOLD_ENV, ...env } }, app, rootRequire,
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
	return { post, alerts, calls, logs, ...fns };
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

	// M1, decision 3 (2026-10-14): a re-issue never fills a blank Assigned Date on a
	// delivered load; the email's date is held for a person.
	alerts.length = 0;
	const na = await post({ loadId: "900000107", values: { "Load ID": "900000107", Details: "Boxes", "Assigned Date": "10/13/2026, 8:00:00 AM", "  Payment  ": "$500.00" } });
	const nav = valuesOf(na);
	check("§1 delivered, no stored Assigned Date: it comes back blank, not filled", nav["Assigned Date"] === "", nav["Assigned Date"]);
	const naHeld = ((na.body && na.body.held) || []).find((c) => c.column === "Assigned Date");
	check("§1 delivered, no stored Assigned Date: the email's date is listed in held, stored blank, and not in alsoChanged",
		!!naHeld && naHeld.stored === "" && naHeld.sent === "10/13/2026, 8:00:00 AM" && !((na.body && na.body.alsoChanged) || []).some((c) => c.column === "Assigned Date"), na.body);
	check("§1 delivered, no stored Assigned Date: and alerted as held",
		alerts.length === 1 && ((alerts[0].held || []).some((c) => c.column === "Assigned Date")), alerts);

	// Low 1: the same delivered load, its blank Assigned Date sent in closed September. The
	// Assigned Date is held (decision 3), so nothing booked into September goes out: the
	// values going out are checked, and the reason names the email's closed month.
	alerts.length = 0;
	const lc = await post({ loadId: "900000107", values: { "Load ID": "900000107", Details: "Boxes, 4 pallets", "Assigned Date": "9/28/2026, 9:00:00 AM", "  Payment  ": "$480.00" } });
	const lcv = valuesOf(lc);
	check("§1 delivered, a blank Assigned Date sent in a closed month: Assigned Date and Payment come back as stored, Details as sent",
		lcv["Load ID"] === "900000107" && lcv.Details === "Boxes, 4 pallets" && lcv["Assigned Date"] === "" && lcv["  Payment  "] === " $ 500.00 ", lcv);
	check("§1 delivered, a blank Assigned Date sent in a closed month: the reason is delivered, naming the email's closed month (nothing in it goes out)",
		reasonOf(lc) === "delivered and the email's Assigned Date is in a closed month (2026-09)", reasonOf(lc));
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

	// A blank Job Status cell is not "delivered" and not "unknown": the column is there.
	alerts.length = 0;
	const bs = await post({ loadId: "900000133", values: { "Load ID": "900000133", "Pickup Appointment": "10/13/2026 09:00", "Drop-off Appointment": "10/15/2026 0:00", "  Payment  ": "$1,250.00" } });
	const bsv = valuesOf(bs);
	check("§1 a blank Job Status, open month, not invoiced: Payment and both dates come back as sent",
		bsv["  Payment  "] === "$1,250.00" && bsv["Pickup Appointment"] === "10/13/2026 09:00" && bsv["Drop-off Appointment"] === "10/15/2026 0:00", bsv);
	check("§1 a blank Job Status: nothing held, no reason, no alert", heldCols(bs.body).length === 0 && reasonOf(bs) === "" && alerts.length === 0, { held: bs.body && bs.body.held, reason: reasonOf(bs), alerts: alerts.length });

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

	// Low 5: the held columns are found by header pattern, not by exact name.
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

// --- §1x DVIR lines never lower Payment ----------------------------------------
// Made-up C.H. Robinson-shaped loads (chrobinson.com, 9-digit Load IDs) and one other
// broker's: Payment $2,150.00; the revised rate con has one DVIR line (-$35.00, Total
// $2,115.00) and an advance of $500.00 (New Total $1,615.00).
const DVIR_KEEP_ON = { RATECON_DVIR_KEEP_ENABLED: "true" };
const AUDIT_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS audit_trail \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const DVIR_FIXTURE = path.join(__dirname, "fixtures", "ratecon-dvir-keep-flag-off.json");
const CHR_EMAIL = "made-up.agent@chrobinson.com";
const OTHER_EMAIL = "ap@example-broker.test";
const DVIR_HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Job Status", "  Payment  ", "Accessorial Amount", "Email", "Assigned Date"];
const dvirRow = (o) => DVIR_HEADERS.map((h) => (o[h] === undefined ? "" : o[h]));
const chrLoad = (id, extra = {}) => dvirRow({ "Load ID": id, Details: "Test freight, 20,000 lbs", "Pickup Appointment": "11/10/2026 08:00", "Drop-off Appointment": "11/11/2026 0:00",
	"Job Status": "In Transit", "  Payment  ": "$2,150.00", Email: CHR_EMAIL, "Assigned Date": "11/9/2026, 9:00:00 AM", ...extra });
const SEPTEMBER = { "Pickup Appointment": "9/28/2026 08:00", "Drop-off Appointment": "9/29/2026 0:00", "Assigned Date": "9/27/2026, 9:00:00 AM" };
const DVIR_SHEET = [DVIR_HEADERS,
	...["123456789", "123456790", "123456791", "123456792", "123456793", "123456797", "123456798", "123456799", "123456780", "123456781", "123456782", "123456783"].map((id) => chrLoad(id)),
	chrLoad("LD-TEST-0001", { Email: OTHER_EMAIL }), chrLoad("12345678"),
	chrLoad("123456794", { "Job Status": "Delivered" }), chrLoad("123456795", { "Job Status": "Delivered" }), chrLoad("123456796", SEPTEMBER),
];
// What n8n sends for a rate-con email of one of those loads (the Assigned Date re-stamped).
const chrEmail = (id, payment, extra = {}) => ({ "Load ID": id, Details: "Test freight, 20,000 lbs", "Pickup Appointment": "11/10/2026 08:00", "Drop-off Appointment": "11/11/2026 0:00",
	Email: CHR_EMAIL, "Assigned Date": "11/12/2026, 7:00:00 AM", "  Payment  ": payment, ...extra });
const RC_INTRO = "Carrier Rate Confirmation for a test load. Pickup at Test Shipper, delivery appointment at Test Consignee. Equipment: van; trailer as booked; weight 20,000 lbs.";
const rcPdf = (body, mode = "literal") => textPdf(`${RC_INTRO} ${body}`, { mode }).toString("base64");
const DVIR_LINE = "Missing Pre-Trip DVIR Inspection 1.00 -$35.00 -$35.00";
const PDF_DVIR = rcPdf(`Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00`);
const PDF_DVIR_ADVANCE = rcPdf(`Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $500.00 New Total: $1,615.00`);
const PDF_TWO_LINES = rcPdf(`Line Haul 1.00 $2,150.00 $2,150.00 Missing Post-Trip DVIR Inspection 1.00 -$35.00 -$35.00 ${DVIR_LINE} Total: $2,080.00`);
const PDF_NO_DVIR = rcPdf("Line Haul 1.00 $2,115.00 $2,115.00 Total: $2,115.00");
// Glyph codes only: the built-in reader finds no text.
const PDF_GLYPHS = rcPdf(`Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00`, "skia");
const pay = (r) => valuesOf(r)["  Payment  "];
const heldPayment = (stored, sent) => JSON.stringify([{ column: "  Payment  ", stored, sent }]);
const decisionsOf = (db, key) => {
	try {
		return db.prepare(`SELECT load_key, stored_cents, sent_cents, dvir_cents, dvir_count, reading, verdict, reason, switch_on, protected_load
			FROM ratecon_dvir_decisions WHERE load_key = ? ORDER BY id`).all(key);
	} catch { return []; }
};
const auditsOf = (db, id) => {
	try { return db.prepare("SELECT username, role, action, entity, entity_id, details FROM audit_trail WHERE entity_id = ? ORDER BY id").all(id); } catch { return []; }
};
const decision = (stored, sent, dvirCents, dvirCount, reading, verdict, reason, on, protectedLoad, key) => ({
	load_key: key, stored_cents: stored, sent_cents: sent, dvir_cents: dvirCents, dvir_count: dvirCount, reading, verdict, reason, switch_on: on ? 1 : 0, protected_load: protectedLoad ? 1 : 0,
});

// The route on its own database (audit_trail too), September closed, with noteRateConDvir().
function dvirWorld({ env = DVIR_KEEP_ON } = {}) {
	const db = draftsDb();
	db.exec(AUDIT_DDL[1]);
	lockMonth(db, "2026-09");
	return { db, ...liftRoute({ db: () => db, env, sheet: DVIR_SHEET, roots: ["noteRateConDvir"] }) };
}

// The switch-off cases whose answers and alerts must be the base's own.
const FLAG_OFF_CASES = [
	["open, one readable DVIR line, $35 lower", "123456789", "$2,115.00", PDF_DVIR],
	["open, no reading, $35 lower", "123456790", "$2,115.00", null],
	["open, no reading, $40 lower", "123456791", "$2,110.00", null],
	["open, no reading, $105 lower", "123456792", "$2,045.00", null],
	["open, a rise", "123456793", "$2,200.00", null],
	["another broker, one readable DVIR line", "LD-TEST-0001", "$2,115.00", PDF_DVIR, { Email: OTHER_EMAIL }],
	["delivered, one readable DVIR line, nothing else changed", "123456794", "$2,115.00", PDF_DVIR],
	["delivered, one readable DVIR line, a date changed", "123456795", "$2,115.00", PDF_DVIR, { "Pickup Appointment": "11/10/2026 10:00" }],
	["closed month, one readable DVIR line", "123456796", "$2,115.00", PDF_DVIR, SEPTEMBER],
	["revised rate con with an advance, the email's Total", "123456781", "$2,115.00", PDF_DVIR_ADVANCE],
	["revised rate con with an advance, the email's New Total", "123456781", "$1,615.00", PDF_DVIR_ADVANCE],
	["open, two DVIR lines read, $35 lower", "123456797", "$2,115.00", PDF_TWO_LINES],
];
async function dvirFlagOffAnswers() {
	const world = dvirWorld({ env: {} });
	const answers = [];
	for (const [what, id, sent, pdf, extra] of FLAG_OFF_CASES) {
		if (pdf) world.noteRateConDvir(id, pdf);
		world.alerts.length = 0;
		const r = await world.post({ loadId: id, values: chrEmail(id, sent, extra) });
		answers.push([what, { status: r.status, body: r.body, alerts: world.alerts.slice() }]);
	}
	return { answers, world };
}

async function section1x() {
	if (!AUDIT_DDL) { check("§1x audit_trail's CREATE TABLE is in server.js", false); return; }
	const { db, post, alerts, calls, noteRateConDvir: note } = dvirWorld();

	// The case this fixes: an open load's email, $35 lower by one DVIR line the rate con shows.
	note("123456789", PDF_DVIR);
	const k = await post({ loadId: "123456789", values: chrEmail("123456789", "$2,115.00") });
	check("§1x open CHR load, email $35 lower by one readable DVIR line: Payment comes back as stored, \"$2,150.00\"", pay(k) === "$2,150.00", valuesOf(k));
	check("§1x ...every other column as today (Details as sent, the stored Assigned Date kept)", valuesOf(k).Details === "Test freight, 20,000 lbs" && valuesOf(k)["Assigned Date"] === "11/9/2026, 9:00:00 AM", valuesOf(k));
	check("§1x ...held lists Payment with both figures, kept names it, and the reason says DVIR lines",
		JSON.stringify(k.body.held) === heldPayment("$2,150.00", "$2,115.00") && k.body.kept.includes("  Payment  ") && /lower only by its DVIR lines/.test(reasonOf(k)), k.body);
	check("§1x ...no alert", alerts.length === 0, alerts);
	eqCheck("§1x ...one decision row, \"kept\", in cents and codes", decisionsOf(db, "123456789"), [decision(215000, 211500, 3500, 1, "readable", "kept", "dvir_lines", true, false, "123456789")]);
	const audit = auditsOf(db, "123456789");
	check("§1x ...one system audit row, ratecon_payment_kept_dvir, naming the two figures, the DVIR cents and the count",
		audit.length === 1 && audit[0].action === "ratecon_payment_kept_dvir" && audit[0].role === "system" && audit[0].username === "ratecon-dvir-keep"
		&& audit[0].entity === "job_tracking" && /\$2,150\.00/.test(audit[0].details) && /\$2,115\.00/.test(audit[0].details) && /\(3500 cents, 1 line\)/.test(audit[0].details), audit);

	// No reading: a drop of one or two DVIR lines' worth is kept, and a person looks.
	for (const [what, id, sent, cents] of [["no reading, $35 lower", "123456790", "$2,115.00", 211500], ["no reading, $70 lower", "123456783", "$2,080.00", 208000]]) {
		alerts.length = 0;
		const r = await post({ loadId: id, values: chrEmail(id, sent) });
		check(`§1x ${what}: Payment comes back as stored`, pay(r) === "$2,150.00", valuesOf(r));
		check(`§1x ${what}: one alert, source "dvir", holding Payment with both figures, saying the text can't confirm it`,
			alerts.length === 1 && alerts[0].source === "dvir" && alerts[0].dvir === "held" && JSON.stringify(alerts[0].held) === heldPayment("$2,150.00", sent)
			&& /can't be read to confirm it/.test(String(alerts[0].reason)), alerts);
		eqCheck(`§1x ${what}: one decision row, "held"`, decisionsOf(db, id), [decision(215000, cents, 0, 0, "none", "held", "unread", true, false, id)]);
		check(`§1x ${what}: no audit row`, auditsOf(db, id).length === 0, auditsOf(db, id));
	}

	// Held too: a reading that disagrees with the drop, DVIR lines plus another amount, readable
	// text with no DVIR line, a reading older than 10 minutes, an unreadable rate con.
	const heldCases = [
		["a reading of $70 (two lines) against a $35 drop", "123456797", PDF_TWO_LINES, {}, [7000, 2, "readable", "disagrees"]],
		["one readable DVIR line and another amount changed", "123456782", PDF_DVIR, { "Accessorial Amount": "$75.00" }, [3500, 1, "readable", "other_money"]],
		["readable text with no DVIR line, $35 lower", "123456798", PDF_NO_DVIR, {}, [0, 0, "readable", "no_dvir_line"]],
		["a reading older than 10 minutes, $35 lower", "123456799", PDF_DVIR, {}, [0, 0, "none", "unread"], Date.now() - 11 * 60 * 1000],
		["an unreadable rate con, $35 lower", "123456780", PDF_GLYPHS, {}, [0, 0, "unreadable", "unread"]],
	];
	for (const [what, id, pdf, extra, [cents, count, reading, reason], at] of heldCases) {
		note(id, pdf, at === undefined ? Date.now() : at);
		alerts.length = 0;
		const r = await post({ loadId: id, values: chrEmail(id, "$2,115.00", extra) });
		check(`§1x ${what}: Payment comes back as stored, and one "dvir" alert holds it`,
			pay(r) === "$2,150.00" && alerts.length === 1 && alerts[0].source === "dvir" && JSON.stringify(alerts[0].held) === heldPayment("$2,150.00", "$2,115.00"), { values: valuesOf(r), alerts });
		eqCheck(`§1x ${what}: one decision row, "held" (${reason})`, decisionsOf(db, id), [decision(215000, 211500, cents, count, reading, "held", reason, true, false, id)]);
	}

	// The rule's own bounds: today's rule, nothing held, no alert, no row.
	note("LD-TEST-0001", PDF_DVIR);
	note("12345678", PDF_DVIR);
	for (const [what, id, sent, extra] of [
		["no reading, $40 lower", "123456791", "$2,110.00", {}],
		["no reading, $105 lower (three lines' worth, unread)", "123456792", "$2,045.00", {}],
		["a rise", "123456793", "$2,200.00", {}],
		["another broker's load, one readable DVIR line", "LD-TEST-0001", "$2,115.00", { Email: OTHER_EMAIL }],
		["an 8-digit Load ID on chrobinson.com, one readable DVIR line", "12345678", "$2,115.00", {}],
	]) {
		alerts.length = 0;
		const r = await post({ loadId: id, values: chrEmail(id, sent, extra) });
		check(`§1x ${what}: Payment written as sent, nothing held, no alert, no decision row`,
			pay(r) === sent && heldCols(r.body).length === 0 && alerts.length === 0 && decisionsOf(db, id.toLowerCase()).length === 0, { values: valuesOf(r), alerts, rows: decisionsOf(db, id.toLowerCase()) });
	}

	// F1: the revised rate con carries an advance and a DVIR line, read as its Total or as its New Total.
	note("123456781", PDF_DVIR_ADVANCE);
	alerts.length = 0;
	const f1Total = await post({ loadId: "123456781", values: chrEmail("123456781", "$2,115.00") });
	const f1New = await post({ loadId: "123456781", values: chrEmail("123456781", "$1,615.00") });
	const f1 = [pay(f1Total), pay(f1New)];
	check("§1x F1 a revised CHR rate con carrying an advance and a DVIR line leaves Payment at the stored figure",
		f1.every((p) => p === "$2,150.00") && !f1.includes("$2,115.00") && !f1.includes("$1,615.00"), f1);
	eqCheck("§1x F1 ...the Total is kept (its DVIR line), the New Total held for a person (the line is $35, the drop $535)", decisionsOf(db, "123456781"), [
		decision(215000, 211500, 3500, 1, "readable", "kept", "dvir_lines", true, false, "123456781"),
		decision(215000, 161500, 3500, 1, "readable", "held", "disagrees", true, false, "123456781"),
	]);
	check("§1x F1 ...only the New Total alerts", alerts.length === 1 && JSON.stringify(alerts[0].held) === heldPayment("$2,150.00", "$1,615.00"), alerts);

	// A protected load keeps today's hold; a certain DVIR-only change there raises no alert.
	note("123456794", PDF_DVIR);
	alerts.length = 0;
	const dl = await post({ loadId: "123456794", values: chrEmail("123456794", "$2,115.00") });
	check("§1x delivered, one readable DVIR line, nothing else changed: Payment as stored, held as today, no alert",
		pay(dl) === "$2,150.00" && JSON.stringify(dl.body.held) === heldPayment("$2,150.00", "$2,115.00") && /delivered/.test(reasonOf(dl)) && alerts.length === 0, { body: dl.body, alerts });
	eqCheck("§1x ...its decision row is \"kept\", on a protected load", decisionsOf(db, "123456794"), [decision(215000, 211500, 3500, 1, "readable", "kept", "dvir_lines", true, true, "123456794")]);
	check("§1x ...and its audit row", auditsOf(db, "123456794").length === 1, auditsOf(db, "123456794"));
	note("123456795", PDF_DVIR);
	alerts.length = 0;
	const dd = await post({ loadId: "123456795", values: chrEmail("123456795", "$2,115.00", { "Pickup Appointment": "11/10/2026 10:00" }) });
	check("§1x delivered, one readable DVIR line and a date changed: the date held too, and the alert goes, told the DVIR verdict",
		pay(dd) === "$2,150.00" && valuesOf(dd)["Pickup Appointment"] === "11/10/2026 08:00" && alerts.length === 1 && alerts[0].dvir === "kept"
		&& JSON.stringify(heldCols({ held: alerts[0].held })) === JSON.stringify(["  Payment  ", "Pickup Appointment"]) && alerts[0].source === undefined, alerts);
	note("123456796", PDF_DVIR);
	alerts.length = 0;
	const cm = await post({ loadId: "123456796", values: chrEmail("123456796", "$2,115.00", SEPTEMBER) });
	check("§1x closed month: every column comes back as stored and today's alert goes, with no DVIR verdict",
		pay(cm) === "$2,150.00" && /in a closed month \(2026-09\)/.test(reasonOf(cm)) && alerts.length === 1 && alerts[0].dvir === undefined, { body: cm.body, alerts });
	check("§1x closed month: no decision row and no audit row", decisionsOf(db, "123456796").length === 0 && auditsOf(db, "123456796").length === 0, decisionsOf(db, "123456796"));
	check("§1x the route never writes the sheet", calls.every(([c]) => c === "get"), calls);

	// The record: cents and codes, never text.
	const cols = (() => { try { return db.prepare("PRAGMA table_info(ratecon_dvir_decisions)").all().map((c) => `${c.name} ${c.type}`); } catch { return []; } })();
	eqCheck("§1x ratecon_dvir_decisions holds the load key, the time, cents, the count and codes only", cols,
		["id INTEGER", "load_key TEXT", "at TEXT", "stored_cents INTEGER", "sent_cents INTEGER", "dvir_cents INTEGER", "dvir_count INTEGER", "reading TEXT", "verdict TEXT", "reason TEXT", "switch_on INTEGER", "protected_load INTEGER"]);
	const refusedText = ["reading", "verdict", "reason"].filter((c) => {
		const row = { reading: "readable", verdict: "kept", reason: "dvir_lines", [c]: "Pat Example" };
		try {
			db.prepare("INSERT INTO ratecon_dvir_decisions (load_key, at, stored_cents, sent_cents, dvir_cents, dvir_count, reading, verdict, reason, switch_on, protected_load) VALUES ('123456789', '2026-11-12T00:00:00.000Z', 1, 0, 0, 0, ?, ?, ?, 1, 0)")
				.run(row.reading, row.verdict, row.reason);
			return false;
		} catch { return true; }
	});
	eqCheck("§1x ...its code columns refuse free text (a made-up name)", refusedText, ["reading", "verdict", "reason"]);

	// The re-issue hold's kill switch off: nothing is kept or recorded.
	const noHold = dvirWorld({ env: { ...DVIR_KEEP_ON, RATECON_REISSUE_HOLD_ENABLED: "false" } });
	noHold.noteRateConDvir("123456789", PDF_DVIR);
	const nh = await noHold.post({ loadId: "123456789", values: chrEmail("123456789", "$2,115.00") });
	check("§1x RATECON_REISSUE_HOLD_ENABLED=false: Payment written as sent, no decision row, no alert",
		pay(nh) === "$2,115.00" && decisionsOf(noHold.db, "123456789").length === 0 && noHold.alerts.length === 0, { values: valuesOf(nh), alerts: noHold.alerts });

	// The switch: on only for true/1/yes/on, read once, and never in a replica.
	const switchLift = (() => { try { return closure(SRC, { roots: ["RATECON_DVIR_KEEP_ENABLED"], provided: ["require", "process"] }).text; } catch { return null; } })();
	const switchOn = (value, replica = false) => new Function("require", "process", `"use strict";\n${switchLift}\nreturn RATECON_DVIR_KEEP_ENABLED;`)(
		(p) => (p === "./lib/replica-mode" ? { active: () => replica } : rootRequire(p)), { env: value === undefined ? {} : { RATECON_DVIR_KEEP_ENABLED: value } });
	eqCheck("§1x RATECON_DVIR_KEEP_ENABLED: on for true, 1, yes, on (any case, spaces around); off unset, blank, false, 0, no, off or anything else; off in a replica",
		switchLift ? [...["true", " TRUE ", "1", "yes", "on"].map((x) => switchOn(x)), ...[undefined, "", "false", "0", "no", "off", "enabled"].map((x) => switchOn(x)), switchOn("true", true)] : null,
		[true, true, true, true, true, false, false, false, false, false, false, false, false]);

	// Off: the base's own answers, and the decisions recorded as would_keep or would_hold.
	const { answers, world: off } = await dvirFlagOffAnswers();
	let fixture = null;
	try { fixture = JSON.parse(fs.readFileSync(DVIR_FIXTURE, "utf8")); } catch { /* checked below */ }
	check("§1x off: the base's answers are on file (scripts/fixtures/ratecon-dvir-keep-flag-off.json)", Boolean(fixture && Array.isArray(fixture.answers) && fixture.answers.length === answers.length), fixture && fixture.answers && fixture.answers.length);
	if (fixture && Array.isArray(fixture.answers)) {
		answers.forEach(([what, got], i) => eqCheck(`§1x off: "${what}" answers and alerts exactly as the base`, got, (fixture.answers[i] || [])[1]));
	}
	const offRows = off.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ratecon_dvir_decisions'").get()
		? off.db.prepare("SELECT load_key, verdict, reason, switch_on, protected_load FROM ratecon_dvir_decisions ORDER BY id").all() : [];
	eqCheck("§1x off: each decision is recorded as would_keep or would_hold, with the switch off", offRows.map((r) => [r.load_key, r.verdict, r.reason, r.switch_on, r.protected_load]), [
		["123456789", "would_keep", "dvir_lines", 0, 0],
		["123456790", "would_hold", "unread", 0, 0],
		["123456794", "would_keep", "dvir_lines", 0, 1],
		["123456795", "would_keep", "dvir_lines", 0, 1],
		["123456781", "would_keep", "dvir_lines", 0, 0],
		["123456781", "would_hold", "disagrees", 0, 0],
		["123456797", "would_hold", "disagrees", 0, 0],
	]);
	check("§1x off: no audit row", ["123456789", "123456794", "123456781"].every((id) => auditsOf(off.db, id).length === 0));

	// The switch-on report, read-only, on a copy of the switch-off decisions.
	const reportPath = path.join(ROOT, "scripts", "ratecon-dvir-keep-report.js");
	if (!fs.existsSync(reportPath)) { check("§1x scripts/ratecon-dvir-keep-report.js exists", false); return; }
	const report = require(reportPath);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dvir-keep-report-"));
	try {
		const file = path.join(dir, "app.db");
		fs.writeFileSync(file, off.db.serialize());
		const out = report.buildReport({ dbPath: file, since: "2026-11-01" });
		const s = out.summary;
		eqCheck("§1x report: the decisions by verdict, and the holds by reading and reason",
			[s.rows, s.loads, s.verdicts, s.holdReadings, s.holdReasons], [7, 6, { would_keep: 4, would_hold: 3 }, { none: 1, readable: 2 }, { unread: 1, disagrees: 2 }]);
		eqCheck("§1x report: on switch-on, what Payment would keep on open loads (each change once)", s.switchOnWouldKeep,
			{ emails: 5, loads: 4, changes: 5, dropCents: 67500, dvirCents: 17500 });
		check("§1x report: the share of holds with no readable text (it decides a second reader)", Math.abs(s.unreadShareOfHolds - 1 / 3) < 1e-9, s.unreadShareOfHolds);
		check("§1x report: counts and cents only, no load number", !/\b\d{8,9}\b|LD-TEST/i.test(out.text) && /\$675\.00/.test(out.text), out.text);
		check("§1x report: it says what it can't count without the sheet", out.notCounted.length === 2 && /percentage-paid/.test(out.text) && /closed month/.test(out.text), out.notCounted);
		const empty = path.join(dir, "empty.db");
		new Database(empty).close();
		const none = report.buildReport({ dbPath: empty, since: "2026-11-01" });
		check("§1x report: a database with no decision table says nothing was recorded", none.present === false && none.summary.rows === 0 && /nothing recorded/.test(none.text), none.text);
		let missing = "";
		try { report.buildReport({ dbPath: path.join(dir, "none.db"), since: "2026-11-01" }); } catch (e) { missing = e.message; }
		check("§1x report: a missing database is refused, never created", Boolean(missing) && !fs.existsSync(path.join(dir, "none.db")), missing);
		let badSince = "";
		try { report.buildReport({ dbPath: file, since: "last week" }); } catch (e) { badSince = e.message; }
		check("§1x report: --since must be a date or an ISO time", /--since/.test(badSince), badSince);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// --- §2 the alert ledger -------------------------------------------------------
const OLD_LEDGER_DDL =`CREATE TABLE ratecon_reissue_holds (load_id TEXT NOT NULL, column_name TEXT NOT NULL, sent_value TEXT NOT NULL,
	stored_value TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'held', reason TEXT NOT NULL DEFAULT '',
	first_seen DATETIME DEFAULT CURRENT_TIMESTAMP, alerted_at DATETIME, PRIMARY KEY (load_id, column_name, sent_value))`;

async function section2() {
	if (!/\n(async )?function alertRateConReissueHold\(/.test(SRC)) { check("§2 alertRateConReissueHold() exists in server.js", false); return; }
	// The retry sweep is lifted with it when server.js has one (a base without it fails §2 B7's sweep cases).
	const hasSweep = /\n(async )?function sweepRateConReissueHolds\(/.test(SRC);
	const lifted = closure(SRC, { roots: ["alertRateConReissueHold", ...(hasSweep ? ["sweepRateConReissueHolds"] : [])], provided: ["db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "require"] });
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	// logs: the log and warn lines, formatted. sweep: sweepRateConReissueHolds(), or null.
	// order: "in-app" and "email", in the order the default notification and the email started.
	const make = ({ db, send = async () => true, notify = null, env = {}, logs = null }) => {
		const sends = [];
		const notes = [];
		const order = [];
		const capture = (...a) => { logs.push(util.format(...a)); };
		const lift = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "require",
			`"use strict";\n${lifted.text}\nreturn { fn: alertRateConReissueHold, sweep: ${hasSweep ? "sweepRateConReissueHolds" : "null"} };`)(
			db, async (to, subject, html) => { order.push("email"); sends.push({ to, subject, html }); return send(to, subject, html); },
			notify || { run: (...a) => { order.push("in-app"); notes.push(a); } }, { to: () => ({ emit: () => {}, except: () => ({ emit: () => {} }) }) },
			logs ? { ...quiet, log: capture, warn: capture } : quiet, { env: { ADMIN_NOTIFY_EMAIL: "admin@example.test", ...env } }, rootRequire,
		);
		return { fn: lift.fn, sweep: lift.sweep, sends, notes, order };
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
	// A claim left by a call that died is retaken once it is stale (15 minutes: longer than a
	// send can take); a younger one is not. (The ledger stores the column name trimmed.)
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, claimed_at) VALUES (?, ?, ?, 'held', ?, ?)")
		.run("900000117", "Payment", "$9.00", new Date().toISOString(), new Date(Date.now() - 20 * 60 * 1000).toISOString());
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, claimed_at) VALUES (?, ?, ?, 'held', ?, ?)")
		.run("900000118", "Payment", "$9.00", new Date().toISOString(), new Date(Date.now() - 10 * 60 * 1000).toISOString());
	const quick = make({ db: cdb });
	await quick.fn({ loadId: "900000117", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a claim older than 15 minutes is retaken and sent", quick.sends.length === 1 && /900000117/.test(quick.sends[0] && quick.sends[0].subject), quick.sends.map((s) => s.subject));
	await quick.fn({ loadId: "900000118", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a claim 10 minutes old (its send may still be running) is left alone", quick.sends.length === 1, quick.sends.map((s) => s.subject));

	// L5: a table made before claimed_at existed gets the column.
	const odb = new Database(":memory:");
	odb.exec(OLD_LEDGER_DDL);
	const old = make({ db: odb });
	const oa = await old.fn({ loadId: "900000119", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 a ledger made before claimed_at: the column is added and the alert goes out",
		oa && oa.alerted === true && odb.prepare("PRAGMA table_info(ratecon_reissue_holds)").all().some((c) => c.name === "claimed_at"), oa);

	// Nit 7: a row already alerted is never sent again, even with a stale claim.
	cdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, first_seen, alerted_at, claimed_at) VALUES (?, ?, ?, 'held', ?, ?, ?)")
		.run("900000122", "Payment", "$9.00", new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - 20 * 60 * 1000).toISOString());
	const quickBefore = { sends: quick.sends.length, notes: quick.notes.length };
	const aa = await quick.fn({ loadId: "900000122", reason: "delivered", held: [{ column: "  Payment  ", stored: "$10.00", sent: "$9.00" }] });
	check("§2 an already-alerted row whose claim is older than 15 minutes: no second email or notification",
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
	check("§2 ...and it carries the old and new value, so the capped change still reaches a person",
		/Payment \(held\): \$20\.00 → \$19\.00/.test(String(capped.notes[1] && capped.notes[1][2])), capped.notes[1] && capped.notes[1][2]);
	const rec = capDb.prepare("SELECT alerted_at FROM ratecon_reissue_holds WHERE load_id = '900000121'").get();
	check("§2 ...and the change is stamped as reported", !!rec && ISO_RE.test(String(rec.alerted_at)), rec);
	const third = await capped.fn(secondChange);
	check("§2 ...so its next sighting reports nothing again", capped.sends.length === 1 && capped.notes.length === 2 && third && third.reason === "already_alerted", { third, notes: capped.notes.length });

	// The in-app notification shows old and new values, except for broker contact columns:
	// Dispatchers see the dispatch room and get no broker contact data.
	const wdb = new Database(":memory:");
	const w = make({ db: wdb });
	await w.fn({
		loadId: "900000125", reason: "delivered",
		held: [{ column: "  Payment  ", stored: "$50.00", sent: "$49.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 08:00" }],
		changed: [{ column: "Details", stored: "Test cargo", sent: "Test cargo, 3 pallets" }, { column: "Phone Number", stored: "555-0100", sent: "555-0199" },
			{ column: "Email", stored: "agent.one@example.test", sent: "agent.two@example.test" }, { column: "Broker Contact Name", stored: "Test Agent One", sent: "Test Agent Two" }],
	});
	const wNote = w.notes[0] || [];
	const wBody = String(wNote[2] || "");
	check("§2 the in-app notification shows each listed column's old and new value",
		/Payment \(held\): \$50\.00 → \$49\.00/.test(wBody) && /Pickup Appointment \(held\): 10\/9\/2026 0:00 → 10\/8\/2026 08:00/.test(wBody)
		&& /Details: Test cargo → Test cargo, 3 pallets/.test(wBody), wBody);
	check("§2 ...but names each broker contact column without its values (body and metadata)",
		/Phone Number: broker contact, not shown/.test(wBody) && /Email: broker contact, not shown/.test(wBody) && /Broker Contact Name: broker contact, not shown/.test(wBody)
		&& !/555-01|example\.test|Test Agent/.test(wBody + String(wNote[3] || "")), { body: wBody, metadata: wNote[3] });
	check("§2 ...while the email to ADMIN_NOTIFY_EMAIL still has them", w.sends.length === 1 && /555-0199/.test(w.sends[0].html) && /Test Agent Two/.test(w.sends[0].html), w.sends.length);

	// Nit 7: the cap counts loads, not ledger rows: one load with two held columns is one.
	const distinctDb = new Database(":memory:");
	const distinct = make({ db: distinctDb, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "2" } });
	await distinct.fn({ loadId: "900000123", reason: "delivered", held: [{ column: "  Payment  ", stored: "$30.00", sent: "$29.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 0:00" }] });
	const nextLoad = await distinct.fn({ loadId: "900000124", reason: "delivered", held: [{ column: "  Payment  ", stored: "$40.00", sent: "$39.00" }] });
	check("§2 with RATECON_REISSUE_ALERT_MAX_PER_DAY=2, a second load after one with two held columns is still emailed (distinct loads)",
		distinct.sends.length === 2 && nextLoad && nextLoad.emailed === true, { sends: distinct.sends.length, nextLoad });

	await section2Channels(make);
}

// B7: each channel once per change. The email and the in-app notification are stamped on
// their own (emailed_at, notified_at), so one that failed is retried on the next sighting of
// that change without repeating the other. sendEmail answers false on an SMTP error (it never
// throws), so false is a failure; a rejection is treated the same.
async function section2Channels(make) {
	// SELECT *: on a server.js without the channel columns each check fails on its own.
	const ledger = (db, loadId) => db.prepare("SELECT * FROM ratecon_reissue_holds WHERE load_id = ? ORDER BY column_name, sent_value").all(loadId);
	// st.email: true, false or "reject"; st.inApp: whether the notification insert works.
	const flaky = (db, st, opts = {}) => {
		const notes = [];
		const m = make({
			db, ...opts,
			send: async () => { if (st.email === "reject") throw new Error("smtp down"); return st.email; },
			notify: { run: (...a) => { if (!st.inApp) throw new Error("notifications down"); notes.push(a); } },
		});
		return { ...m, notes };
	};
	const pay = (loadId, stored, sent) => ({ loadId, reason: "delivered", held: [{ column: "  Payment  ", stored, sent }] });

	// The email answers false, the in-app notification goes in.
	const adb = new Database(":memory:");
	const ast = { email: false, inApp: true };
	const logs = [];
	const a = flaky(adb, ast, { logs });
	const a1 = await a.fn(pay("900000126", "$60.00", "$59.00"));
	check("§2 B7 email answers false, in-app goes in: notified, not emailed", a1 && a1.notified === true && a1.emailed === false && a.sends.length === 1 && a.notes.length === 1, { a1, sends: a.sends.length, notes: a.notes.length });
	const ar = ledger(adb, "900000126")[0] || {};
	check("§2 B7 ...the ledger stamps the in-app channel and alerted_at, not the email", ISO_RE.test(String(ar.notified_at)) && ISO_RE.test(String(ar.alerted_at)) && ar.emailed_at == null && ar.email_skipped == null && ar.claimed_at == null, ar);
	check("§2 B7 ...the log line says the email failed and the in-app notification went", logs.some((l) => /email FAILED/.test(l) && /in-app sent/.test(l)), logs);
	ast.email = true;
	const a2 = await a.fn(pay("900000126", "$60.00", "$59.00"));
	check("§2 B7 ...the next sighting of that change sends the email only", a.sends.length === 2 && a.notes.length === 1 && a2 && a2.emailed === true && a2.notified === false, { a2, sends: a.sends.length, notes: a.notes.length });
	check("§2 B7 ...and that email carries the stored and the sent value", /60\.00/.test(a.sends[1] && a.sends[1].html) && /59\.00/.test(a.sends[1] && a.sends[1].html), a.sends[1] && a.sends[1].subject);
	const ar2 = ledger(adb, "900000126")[0] || {};
	check("§2 B7 ...emailed_at is stamped, alerted_at keeps the first time a person was told", ISO_RE.test(String(ar2.emailed_at)) && ar2.alerted_at === ar.alerted_at, ar2);
	const a3 = await a.fn(pay("900000126", "$60.00", "$59.00"));
	check("§2 B7 ...a third sighting sends nothing", a.sends.length === 2 && a.notes.length === 1 && a3 && a3.reason === "already_alerted", a3);
	// A rejected send is a failure too.
	ast.email = "reject";
	await a.fn(pay("900000126", "$60.00", "$58.00"));
	ast.email = true;
	const ra = await a.fn(pay("900000126", "$60.00", "$58.00"));
	check("§2 B7 a rejected email is retried on the next sighting, the notification is not repeated", a.sends.length === 4 && a.notes.length === 2 && ra && ra.emailed === true && ra.notified === false, { ra, sends: a.sends.length, notes: a.notes.length });

	// The email goes, the in-app notification fails.
	const bdb = new Database(":memory:");
	const bst = { email: true, inApp: false };
	const blogs = [];
	const b = flaky(bdb, bst, { logs: blogs });
	const b1 = await b.fn(pay("900000129", "$61.00", "$60.00"));
	check("§2 B7 email goes, in-app fails: emailed, not notified", b1 && b1.emailed === true && b1.notified === false && b.sends.length === 1 && b.notes.length === 0, b1);
	check("§2 B7 ...the log line says the email went and the in-app notification failed", blogs.some((l) => /email sent/.test(l) && /in-app FAILED/.test(l)), blogs);
	bst.inApp = true;
	const b2 = await b.fn(pay("900000129", "$61.00", "$60.00"));
	check("§2 B7 ...the next sighting sends the in-app notification only", b.sends.length === 1 && b.notes.length === 1 && b2 && b2.notified === true && b2.emailed === false, { b2, sends: b.sends.length });
	check("§2 B7 ...and it shows the old and new value", /Payment \(held\): \$61\.00 → \$60\.00/.test(String(b.notes[0] && b.notes[0][2])), b.notes[0] && b.notes[0][2]);
	const b3 = await b.fn(pay("900000129", "$61.00", "$60.00"));
	check("§2 B7 ...a third sighting sends nothing", b.sends.length === 1 && b.notes.length === 1 && b3 && b3.reason === "already_alerted", b3);

	// Both fail.
	const cdb = new Database(":memory:");
	const cst = { email: false, inApp: false };
	const c = flaky(cdb, cst);
	const c1 = await c.fn(pay("900000130", "$62.00", "$61.00"));
	const cr = ledger(cdb, "900000130")[0] || {};
	check("§2 B7 both channels fail: nothing stamped, claim released", c1 && c1.alerted === false && cr.alerted_at == null && cr.emailed_at == null && cr.notified_at == null && cr.claimed_at == null, { c1, cr });
	cst.email = true; cst.inApp = true;
	const c2 = await c.fn(pay("900000130", "$62.00", "$61.00"));
	check("§2 B7 ...the next sighting sends both", c.sends.length === 2 && c.notes.length === 1 && c2 && c2.emailed === true && c2.notified === true, { c2, sends: c.sends.length, notes: c.notes.length });

	// A change with one column emailed earlier and a new column: the email lists only what it owes.
	const ddb = new Database(":memory:");
	const dst = { email: false, inApp: true };
	const d = flaky(ddb, dst);
	await d.fn(pay("900000134", "$63.00", "$62.00"));
	dst.email = true;
	await d.fn({ loadId: "900000134", reason: "delivered", held: [{ column: "  Payment  ", stored: "$63.00", sent: "$62.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 08:00" }] });
	check("§2 B7 an owed email and a new column: one email with both, one notification with the new column only",
		d.sends.length === 2 && /62\.00/.test(d.sends[1].html) && /10\/8\/2026 08:00/.test(d.sends[1].html)
		&& d.notes.length === 2 && /Pickup Appointment/.test(String(d.notes[1][2])) && !/Payment/.test(String(d.notes[1][2])), { notes: d.notes.map((n) => n[2]) });

	// The cap counts loads emailed (or still owed an email) in the window; a load already
	// emailed there doesn't count again, and one the cap held back doesn't become counted
	// through its in-app notification.
	const kdb = new Database(":memory:");
	const k = make({ db: kdb, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await k.fn(pay("900000135", "$70.00", "$69.00"));
	const kA = await k.fn(pay("900000135", "$70.00", "$68.00"));
	check("§2 B7 cap 1, load A emailed today: a new change on A is still emailed", k.sends.length === 2 && kA && kA.emailed === true && kA.reason !== "daily_cap", { kA, sends: k.sends.length });
	const kB = await k.fn(pay("900000136", "$80.00", "$79.00"));
	check("§2 B7 ...while a new load B is capped (in-app only)", k.sends.length === 2 && kB && kB.reason === "daily_cap" && kB.emailed === false && kB.notified === true && k.notes.length === 3, { kB, sends: k.sends.length });
	const kbr = ledger(kdb, "900000136")[0] || {};
	check("§2 B7 ...the capped change records why no email is owed", kbr.email_skipped === "daily_cap" && kbr.emailed_at == null && ISO_RE.test(String(kbr.notified_at)), kbr);
	const kB2 = await k.fn(pay("900000136", "$80.00", "$79.00"));
	check("§2 B7 ...and is not emailed on its next sighting", k.sends.length === 2 && k.notes.length === 3 && kB2 && kB2.reason === "already_alerted", { kB2, sends: k.sends.length });
	const kB3 = await k.fn(pay("900000136", "$80.00", "$78.00"));
	check("§2 B7 ...and a new change on B is capped too (B's in-app notification doesn't make it counted)",
		k.sends.length === 2 && kB3 && kB3.reason === "daily_cap" && kB3.emailed === false && kB3.notified === true, { kB3, sends: k.sends.length });
	// M7: a capped change whose in-app notification failed gets it later, never the email.
	const k7db = new Database(":memory:");
	const k7st = { email: true, inApp: true };
	const k7 = flaky(k7db, k7st, { env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await k7.fn(pay("900000151", "$70.00", "$69.00"));
	k7st.inApp = false;
	const k7b = await k7.fn(pay("900000152", "$80.00", "$79.00"));
	k7st.inApp = true;
	const k7c = await k7.fn(pay("900000152", "$80.00", "$79.00"));
	const k7s = k7.sweep ? await k7.sweep() : null;
	check("§2 B7 a capped change whose in-app notification failed: the next sighting sends it, and no email (nor does the sweep)",
		k7b && k7b.reason === "daily_cap" && k7c && k7c.notified === true && k7c.emailed === false && k7.sends.length === 1 && k7.notes.length === 2 && !!k7s,
		{ k7b, k7c, k7s, sends: k7.sends.length, notes: k7.notes.length });
	// An email that failed is retried even when the cap is full: its load is already counted.
	const fdb = new Database(":memory:");
	const fst = { email: false, inApp: true };
	const f = flaky(fdb, fst, { env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await f.fn(pay("900000137", "$90.00", "$89.00"));
	fst.email = true;
	const fr = await f.fn(pay("900000137", "$90.00", "$89.00"));
	check("§2 B7 cap 1: a failed email on the only counted load is still retried", f.sends.length === 2 && fr && fr.emailed === true, { fr, sends: f.sends.length });

	// No ADMIN_NOTIFY_EMAIL: in-app only, and the change is not emailed once one is set.
	const ndb = new Database(":memory:");
	const n1 = make({ db: ndb, env: { ADMIN_NOTIFY_EMAIL: "" } });
	const nr = await n1.fn(pay("900000138", "$95.00", "$94.00"));
	check("§2 B7 no ADMIN_NOTIFY_EMAIL: in-app only, recorded as no_recipient", n1.sends.length === 0 && n1.notes.length === 1 && nr && nr.notified === true
		&& (ledger(ndb, "900000138")[0] || {}).email_skipped === "no_recipient", { nr, row: ledger(ndb, "900000138")[0] });
	const n2 = make({ db: ndb });
	const nr2 = await n2.fn(pay("900000138", "$95.00", "$94.00"));
	check("§2 B7 ...a later sighting with the address set sends nothing", n2.sends.length === 0 && n2.notes.length === 0 && nr2 && nr2.reason === "already_alerted", nr2);
	// M7, M12, M17: no address and a failed in-app notification, then (address set) the same
	// change and a new column on the load. The old column gets the in-app notification only:
	// it is not emailed, not listed in the email, and not stamped emailed.
	const n3db = new Database(":memory:");
	const n3 = make({ db: n3db, env: { ADMIN_NOTIFY_EMAIL: "" }, notify: { run: () => { throw new Error("notifications down"); } } });
	await n3.fn(pay("900000153", "$45.00", "$44.00"));
	const n4 = make({ db: n3db });
	const pickup = { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 07:00" };
	const n4r = await n4.fn({ loadId: "900000153", reason: "delivered", held: [{ column: "  Payment  ", stored: "$45.00", sent: "$44.00" }, pickup] });
	const n4pay = ledger(n3db, "900000153").find((x) => x.column_name === "Payment") || {};
	const n4mail = (n4.sends[0] && n4.sends[0].html) || "";
	check("§2 B7 no address and in-app failed, then a new column: one email, for the new column only",
		n4r && n4r.emailed === true && n4.sends.length === 1 && /10\/8\/2026 07:00/.test(n4mail) && !/44\.00|45\.00/.test(n4mail), { n4r, mail: n4mail.slice(0, 120) });
	check("§2 B7 ...the old column gets its in-app notification, and is not stamped emailed",
		n4.notes.length === 1 && /Payment \(held\): \$45\.00 → \$44\.00/.test(String(n4.notes[0][2])) && n4pay.emailed_at == null && n4pay.email_skipped === "no_recipient" && ISO_RE.test(String(n4pay.notified_at)),
		{ note: n4.notes[0] && n4.notes[0][2], row: n4pay });

	// Two overlapping calls still send once per channel, on a retry too.
	const odb = new Database(":memory:");
	const ost = { email: false, inApp: true };
	const slow = flaky(odb, ost);
	await slow.fn(pay("900000139", "$99.00", "$98.00"));
	ost.email = true;
	const slowSend = make({ db: odb, send: async () => { await new Promise((r) => setTimeout(r, 20)); return true; } });
	const both = await Promise.all([slowSend.fn(pay("900000139", "$99.00", "$98.00")), slowSend.fn(pay("900000139", "$99.00", "$98.00"))]);
	check("§2 B7 two overlapping retries of an owed email: one email, no notification", slowSend.sends.length === 1 && slowSend.notes.length === 0
		&& both.filter((r) => r.emailed === true).length === 1, { sends: slowSend.sends.length, notes: slowSend.notes.length, both });
	const fresh2 = make({ db: odb, send: async () => { await new Promise((r) => setTimeout(r, 20)); return true; } });
	await Promise.all([fresh2.fn(pay("900000140", "$99.00", "$97.00")), fresh2.fn(pay("900000140", "$99.00", "$97.00")), fresh2.fn(pay("900000140", "$99.00", "$97.00"))]);
	check("§2 B7 three overlapping calls for a new change: one email and one notification", fresh2.sends.length === 1 && fresh2.notes.length === 1, { sends: fresh2.sends.length, notes: fresh2.notes.length });

	// The migration: a ledger made before the channel columns (with claimed_at, as main made
	// it), holding alerted rows and an unalerted one. Alerted rows count as done on both
	// channels and are not sent again; the unalerted one still owes both.
	const mdb = new Database(":memory:");
	mdb.exec(OLD_LEDGER_DDL);
	mdb.exec("ALTER TABLE ratecon_reissue_holds ADD COLUMN claimed_at TEXT");
	const told = "2026-10-13T15:00:00.000Z";
	const ins = mdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, stored_value, kind, first_seen, alerted_at, claimed_at) VALUES (?, ?, ?, ?, 'held', ?, ?, ?)");
	ins.run("900000141", "Payment", "$49.00", "$50.00", told, told, told);
	ins.run("900000141", "Pickup Appointment", "10/8/2026 08:00", "10/9/2026 0:00", told, told, null);
	ins.run("900000142", "Payment", "$39.00", "$40.00", told, told, null);
	ins.run("900000143", "Payment", "$29.00", "$30.00", told, null, null);
	const m = make({ db: mdb });
	const m1 = await m.fn({ loadId: "900000141", reason: "delivered", held: [{ column: "  Payment  ", stored: "$50.00", sent: "$49.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 08:00" }] });
	const m2 = await m.fn(pay("900000142", "$40.00", "$39.00"));
	const cols = mdb.prepare("PRAGMA table_info(ratecon_reissue_holds)").all().map((x) => x.name);
	check("§2 B7 migration: emailed_at, notified_at, email_skipped and notify_skipped are added", ["emailed_at", "notified_at", "email_skipped", "notify_skipped"].every((x) => cols.includes(x)), cols);
	const back = mdb.prepare("SELECT * FROM ratecon_reissue_holds WHERE alerted_at IS NOT NULL").all();
	check("§2 B7 migration: every alerted row is marked done on both channels as before_tracking, with no channel stamp made up",
		back.length === 3 && back.every((x) => x.email_skipped === "before_tracking" && x.notify_skipped === "before_tracking" && x.emailed_at == null && x.notified_at == null && x.alerted_at === told), back);
	check("§2 B7 migration: no alerted row is sent again", m.sends.length === 0 && m.notes.length === 0 && m1 && m1.reason === "already_alerted" && m2 && m2.reason === "already_alerted", { m1, m2, sends: m.sends.length, notes: m.notes.length });
	const m3 = await m.fn(pay("900000143", "$30.00", "$29.00"));
	check("§2 B7 migration: an unalerted row still gets both channels", m.sends.length === 1 && m.notes.length === 1 && m3 && m3.emailed === true && m3.notified === true, m3);
	const pre = new Database(":memory:");
	pre.exec(OLD_LEDGER_DDL);
	pre.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, kind, alerted_at) VALUES ('900000144', 'Payment', '$19.00', 'held', ?)").run(told);
	const p = make({ db: pre });
	await p.fn(pay("900000144", "$20.00", "$19.00"));
	const pr = pre.prepare("SELECT * FROM ratecon_reissue_holds WHERE load_id = '900000144'").get();
	check("§2 B7 migration: a ledger made before claimed_at gets every column, marked before_tracking, nothing sent",
		p.sends.length === 0 && p.notes.length === 0 && pr.email_skipped === "before_tracking" && pr.notify_skipped === "before_tracking" && "claimed_at" in pr, { pr, sends: p.sends.length });
	const ps = p.sweep ? await p.sweep() : null;
	check("§2 B7 migration: the retry sweep sends nothing for a row marked before_tracking", !!ps && p.sends.length === 0 && p.notes.length === 0, ps);
	// One connection can't show it: the migration takes the write lock up front (IMMEDIATE),
	// so another process's write can't interleave between reading the columns and adding them.
	check("§2 B7 migration: its transaction is IMMEDIATE", /\nfunction reissueHoldTable\(\) \{[\s\S]*?\n\t\}\)\.immediate\(\);\n[\s\S]*?\n\}\n/.test(SRC));

	await section2Sweep(make, flaky, ledger, pay);
}

// M1: a channel a sighting couldn't send is retried from the ledger, because the change is
// rarely seen again: a written ("changed") field is not listed once the sheet holds it, and a
// held value recurs only if the broker resends it. sweepRateConReissueHolds() retries rows
// first seen in the last 48 h, per load, from the values the ledger kept; older rows are given
// up, logged once per load; a replica never starts it.
async function section2Sweep(make, flaky, ledger, pay) {
	if (!/\n(async )?function sweepRateConReissueHolds\(/.test(SRC)) { check("§2 B7 sweepRateConReissueHolds() exists in server.js", false); }
	const sweepOf = (m) => (m.sweep ? m.sweep : async () => ({ missing: true }));
	// A sweep `min` minutes from now (its start and every load it reaches): past a first try's 15-minute slot at 16.
	const inMin = (min) => { const t = new Date(Date.now() + min * 60 * 1000); return { now: t, clock: () => t }; };

	// A changed field whose email failed: the next rate con carries the value now stored, so
	// the route lists nothing; the sweep sends the email, once.
	const cfdb = new Database(":memory:");
	const cfst = { email: false, inApp: true };
	const cf = flaky(cfdb, cfst);
	const cfChange = { column: "Details", stored: "Test cargo", sent: "Test cargo, 2 pallets" };
	await cf.fn({ loadId: "#X900000145", reason: "delivered and invoiced", changed: [cfChange] });
	cfst.email = true;
	const cfAgain = await cf.fn({ loadId: "#X900000145", reason: "delivered", changed: [] });
	check("§2 B7 sweep: a changed field's failed email, then a sighting with nothing changed: nothing sent", cf.sends.length === 1 && cf.notes.length === 1 && cfAgain && cfAgain.reason === "already_alerted", { cfAgain, sends: cf.sends.length });
	const cfs = await sweepOf(cf)(inMin(16));
	const cfMail = (cf.sends[1] && cf.sends[1].html) || "";
	check("§2 B7 sweep: ...the sweep sends that email, with the stored and the sent value, and no second notification",
		cf.sends.length === 2 && cf.notes.length === 1 && /Test cargo, 2 pallets/.test(cfMail) && /changed fields/.test(cf.sends[1].subject) && cfs && cfs.loads === 1, { cfs, sends: cf.sends.length, subject: cf.sends[1] && cf.sends[1].subject });
	const cfr = ledger(cfdb, "x900000145")[0] || {};
	check("§2 B7 sweep: ...emailed_at is stamped and the claim released", ISO_RE.test(String(cfr.emailed_at)) && cfr.claimed_at == null, cfr);
	check("§2 B7 sweep: ...the retry carries the original reason", /because: delivered and invoiced\./.test(cfMail), cfMail.slice(0, 260));
	check("§2 B7 sweep: ...and the load number as first written, not the ledger key", /Load #X900000145:/.test(cf.sends[1] && cf.sends[1].subject) && /load #X900000145/.test(cfMail), cf.sends[1] && cf.sends[1].subject);
	const firstSeenText = appTime.dateTextInZone(new Date(cfr.first_seen || 0), appTime.appTimeZone(), { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
	check("§2 B7 sweep: ...and says it is a retry, with when the change was first seen in the business time zone",
		cfMail.includes(`This is a retry: the first try to send this email failed. The change was first seen ${firstSeenText}.`)
		&& !/This is a retry/.test((cf.sends[0] && cf.sends[0].html) || ""), { expected: firstSeenText, mail: cfMail.slice(0, 400) });
	const cfs2 = await sweepOf(cf)(inMin(40));
	check("§2 B7 sweep: ...and the next sweep sends nothing", cf.sends.length === 2 && cf.notes.length === 1 && cfs2 && cfs2.loads === 0, cfs2);

	// A held value whose in-app notification failed: the broker never resends that value.
	const hvdb = new Database(":memory:");
	const hvst = { email: true, inApp: false };
	const hv = flaky(hvdb, hvst);
	await hv.fn(pay("900000146", "$75.00", "$74.00"));
	hvst.inApp = true;
	await hv.fn({ loadId: "900000146", reason: "delivered", held: [] });
	check("§2 B7 sweep: a held value's failed notification, then a sighting without it: nothing sent", hv.sends.length === 1 && hv.notes.length === 0, { sends: hv.sends.length, notes: hv.notes.length });
	const hvs = await sweepOf(hv)(inMin(16));
	check("§2 B7 sweep: ...the sweep sends the in-app notification only, with old and new value",
		hv.sends.length === 1 && hv.notes.length === 1 && /Payment \(held\): \$75\.00 → \$74\.00/.test(String(hv.notes[0] && hv.notes[0][2])) && hvs && hvs.loads === 1, { hvs, note: hv.notes[0] && hv.notes[0][2] });
	await sweepOf(hv)(inMin(40));
	check("§2 B7 sweep: ...once", hv.sends.length === 1 && hv.notes.length === 1, { sends: hv.sends.length, notes: hv.notes.length });

	// 48 h: rows still owed are given up, one log line per load; rows inside the window are sent.
	const gdb = new Database(":memory:");
	const glogs = [];
	const g = make({ db: gdb, logs: glogs });
	if (!g.sweep) { check("§2 B7 sweep: the 48 h give-up (no sweep to run)", false); } else {
	await g.sweep();
	const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
	const gins = gdb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, stored_value, kind, reason, first_seen, alerted_at, notified_at) VALUES (?, ?, ?, ?, 'held', 'delivered', ?, ?, ?)");
	gins.run("900000147", "Payment", "$9.00", "$10.00", ago(48.5), null, null);
	gins.run("900000147", "Pickup Appointment", "10/8/2026 08:00", "10/9/2026 0:00", ago(50), ago(50), ago(50));
	gins.run("900000148", "Payment", "$19.00", "$20.00", ago(47.5), null, null);
	const gs = await g.sweep();
	const g147 = ledger(gdb, "900000147");
	const gPay = g147.find((x) => x.column_name === "Payment") || {};
	const gPick = g147.find((x) => x.column_name === "Pickup Appointment") || {};
	check("§2 B7 sweep: rows first seen 48.5 h and 50 h ago are given up on each channel they owed, and nothing is sent for them",
		gPay.email_skipped === "gave_up" && gPay.notify_skipped === "gave_up" && gPick.email_skipped === "gave_up" && gPick.notify_skipped == null && ISO_RE.test(String(gPick.notified_at))
		&& !g.sends.some((s) => /900000147/.test(s.subject)) && !g.notes.some((n) => /900000147/.test(String(n[1]))), { gPay, gPick });
	check("§2 B7 sweep: ...a row first seen 47.5 h ago is still sent", g.sends.some((s) => /900000148/.test(s.subject)) && g.notes.some((n) => /900000148/.test(String(n[1]))) && gs && gs.loads === 1, gs);
	const gaveUpLines = glogs.filter((l) => /GAVE UP/.test(l));
	check("§2 B7 sweep: ...one GAVE UP line for the load, naming what each channel gave up",
		gaveUpLines.length === 1 && /900000147/.test(gaveUpLines[0]) && /email: (Pickup Appointment, Payment|Payment, Pickup Appointment);/.test(gaveUpLines[0]) && /in-app: Payment$/.test(gaveUpLines[0]), glogs);
	const gSends = g.sends.length;
	await g.sweep();
	check("§2 B7 sweep: ...and the next sweep neither sends nor logs it again", g.sends.length === gSends && glogs.filter((l) => /GAVE UP/.test(l)).length === 1, glogs);
	}

	// The sweep and an overlapping sighting send once per channel.
	const ovdb = new Database(":memory:");
	const ovst = { email: false, inApp: true };
	const ov = flaky(ovdb, ovst);
	await ov.fn(pay("900000149", "$55.00", "$54.00"));
	const ovSlow = make({ db: ovdb, send: async () => { await new Promise((r) => setTimeout(r, 20)); return true; } });
	await Promise.all([sweepOf(ovSlow)(inMin(16)), ovSlow.fn(pay("900000149", "$55.00", "$54.00")), sweepOf(ovSlow)(inMin(16))]);
	check("§2 B7 sweep: a sweep and a sighting together retry an owed email once, with no notification", ovSlow.sends.length === 1 && ovSlow.notes.length === 0, { sends: ovSlow.sends.length, notes: ovSlow.notes.length });

	// A call releases only its own claim (M8): a sighting whose send outlived the claim
	// timeout finishes while the sweep, which retook the row, is still sending; a third call
	// must still find the row held.
	const xdb = new Database(":memory:");
	const pending = [];
	const x = make({ db: xdb, send: () => new Promise((r) => pending.push(r)) });
	const xCall = x.fn(pay("900000150", "$65.00", "$64.00"));
	await new Promise((r) => setImmediate(r));
	check("§2 B7 claims: the in-app notification goes in before the email is awaited", x.notes.length === 1 && x.sends.length === 1, { notes: x.notes.length, sends: x.sends.length });
	const sCall = sweepOf(x)(inMin(16));
	await new Promise((r) => setImmediate(r));
	check("§2 B7 claims: a claim older than 15 minutes is retaken by the sweep, for the email only", x.sends.length === 2 && x.notes.length === 1, { sends: x.sends.length, notes: x.notes.length });
	if (pending[0]) pending[0](false);
	await xCall;
	const third = x.fn(pay("900000150", "$65.00", "$64.00"));
	await new Promise((r) => setImmediate(r));
	check("§2 B7 claims: the first call, finishing, leaves the sweep's claim in place: a third call sends nothing", x.sends.length === 2 && x.notes.length === 1, { sends: x.sends.length });
	for (const r of pending.slice(1)) r(true);
	await Promise.all([sCall, third]);
	const xr = ledger(xdb, "900000150")[0] || {};
	check("§2 B7 claims: ...the sweep's email is stamped and its claim released", ISO_RE.test(String(xr.emailed_at)) && xr.claimed_at == null && x.sends.length === 2, xr);

	// A load the sweep reaches 20 minutes after it started is claimed with the time it was
	// reached, so a sighting while its email is in flight doesn't find the claim stale.
	const ldb = new Database(":memory:");
	const lpending = [];
	const lg = make({ db: ldb, send: () => new Promise((r) => lpending.push(r)) });
	await lg.fn({ loadId: "900000154", reason: "delivered", held: [] });
	const lt = new Date().toISOString();
	ldb.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, stored_value, kind, reason, first_seen, alerted_at, notified_at) VALUES ('900000155', 'Payment', '$34.00', '$35.00', 'held', 'delivered', ?, ?, ?)").run(lt, lt, lt);
	const lsweep = sweepOf(lg)({ now: new Date(Date.now() - 20 * 60 * 1000) });
	await new Promise((r) => setImmediate(r));
	const lsight = lg.fn(pay("900000155", "$35.00", "$34.00"));
	await new Promise((r) => setImmediate(r));
	check("§2 B7 claims: a load a sweep reaches 20 minutes in: a sighting while its email is in flight sends nothing", lg.sends.length === 1, { sends: lg.sends.length });
	for (const r of lpending) r(true);
	await Promise.all([lsweep, lsight]);

	// Retries back off: 15 min after the first try, then 30 min, 1 h and 2 h after each
	// later one, then every 4 h. A sweep before a row's slot leaves it alone.
	const bodb = new Database(":memory:");
	const bo = flaky(bodb, { email: false, inApp: true });
	await bo.fn(pay("900000156", "$25.00", "$24.00"));
	const t0 = Date.parse((ledger(bodb, "900000156")[0] || {}).last_try) || Date.now();
	const tried = [];
	for (const min of [10, 16, 40, 47, 106, 108, 227, 229, 468, 470, 709, 711]) {
		const before = bo.sends.length;
		const t = new Date(t0 + min * 60 * 1000);
		await sweepOf(bo)({ now: t, clock: () => t });
		if (bo.sends.length > before) tried.push(min);
	}
	eqCheck("§2 B7 backoff: retried at +16, +47, +108, +229, +470 and +711 min after the first try, and at no sweep before its slot", tried, [16, 47, 108, 229, 470, 711]);
	const boRow = ledger(bodb, "900000156")[0] || {};
	check("§2 B7 backoff: ...each try counted (attempts) with its time (last_try)", boRow.attempts === 7 && boRow.last_try === new Date(t0 + 711 * 60 * 1000).toISOString(), boRow);

	// One summary line per sweep for the loads still failing, not a line per row or load.
	const sudb = new Database(":memory:");
	const sulogs = [];
	const su = flaky(sudb, { email: false, inApp: true }, { logs: sulogs });
	await su.fn({ loadId: "900000157", reason: "delivered", held: [{ column: "  Payment  ", stored: "$5.00", sent: "$4.00" }, { column: "Pickup Appointment", stored: "10/9/2026 0:00", sent: "10/8/2026 06:00" }] });
	await su.fn(pay("900000158", "$6.00", "$5.00"));
	sulogs.length = 0;
	await sweepOf(su)(inMin(16));
	const suLines = sulogs.filter((l) => /\[ratecon-reissue\]/.test(l));
	check("§2 B7 sweep log: one summary line naming each load still failing and the channel",
		suLines.length === 1 && /retry sweep: 2 load\(s\) retried, 0 delivered; still failing, retried later: 900000157 \(email\); 900000158 \(email\)$/.test(suLines[0]), suLines);
	sulogs.length = 0;
	await sweepOf(su)(inMin(20));
	check("§2 B7 sweep log: ...and a sweep with nothing due logs nothing", sulogs.filter((l) => /\[ratecon-reissue\]/.test(l)).length === 0, sulogs);

	// The cap counts a load still owed an email: with load A's email failed, a new load B is capped.
	const s12db = new Database(":memory:");
	const s12st = { email: false, inApp: true };
	const s12 = flaky(s12db, s12st, { env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await s12.fn(pay("900000159", "$7.00", "$6.00"));
	s12st.email = true;
	const s12b = await s12.fn(pay("900000160", "$8.00", "$7.00"));
	check("§2 B7 cap 1: load A's email failed (still owed), so a new load B is capped", s12.sends.length === 1 && s12b && s12b.reason === "daily_cap" && s12b.notified === true, { s12b, sends: s12.sends.length });
	// ...while a load told in-app only (no address then) doesn't use up the cap.
	const m2db = new Database(":memory:");
	await make({ db: m2db, env: { ADMIN_NOTIFY_EMAIL: "" } }).fn(pay("900000164", "$3.00", "$2.00"));
	const m2 = make({ db: m2db, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	const m2r = await m2.fn(pay("900000165", "$4.00", "$3.00"));
	check("§2 B7 cap 1: a load told in-app only, with no address, doesn't count: the next load is emailed", m2.sends.length === 1 && m2r && m2r.emailed === true, { m2r, sends: m2.sends.length });

	// The in-app notification goes in (and is stamped) before the email is even started.
	const ordb = new Database(":memory:");
	const or = make({ db: ordb });
	await or.fn(pay("900000161", "$9.00", "$8.00"));
	eqCheck("§2 B7 order: the in-app notification before the email starts", or.order, ["in-app", "email"]);

	// A load still owed an email from an alert more than 24 h old is not held back by a full
	// cap when its retry comes (hours 25-48).
	const c24db = new Database(":memory:");
	const c24 = make({ db: c24db, env: { RATECON_REISSUE_ALERT_MAX_PER_DAY: "1" } });
	await c24.fn(pay("900000162", "$11.00", "$10.00"));
	const old = new Date(Date.now() - 30 * 3600000).toISOString();
	c24db.prepare("INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, stored_value, kind, reason, first_seen, alerted_at, notified_at) VALUES ('900000163', 'Payment', '$12.00', '$13.00', 'held', 'delivered', ?, ?, ?)").run(old, old, old);
	await sweepOf(c24)();
	check("§2 B7 cap 1 full: a load owed an email from an alert 30 h old still gets its retry",
		c24.sends.length === 2 && /900000163/.test(c24.sends[1] && c24.sends[1].subject) && (ledger(c24db, "900000163")[0] || {}).email_skipped == null, { sends: c24.sends.map((s) => s.subject), row: ledger(c24db, "900000163")[0] });

	// A replica starts no sweep; otherwise it runs every 15 minutes on an unref'd timer.
	if (!/\nfunction startRateConReissueSweep\(/.test(SRC)) { check("§2 B7 startRateConReissueSweep() exists in server.js", false); return; }
	const lift = closure(SRC, { roots: ["startRateConReissueSweep"], provided: ["db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "REPLICA", "setInterval", "require"] });
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	const start = (REPLICA, env = {}) => {
		const timers = [];
		const fakeInterval = (fn, ms) => { const t = { fn, ms, unref() { t.unrefd = true; } }; timers.push(t); return t; };
		const started = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "REPLICA", "setInterval", "require",
			`"use strict";\n${lift.text}\nreturn startRateConReissueSweep();`)(
			new Database(":memory:"), async () => true, { run: () => {} }, { to: () => ({ emit: () => {}, except: () => ({ emit: () => {} }) }) }, quiet, { env }, REPLICA, fakeInterval, rootRequire);
		return { started, timers };
	};
	const notStarted = [];
	const rep = start({ jobNotStarted: (name) => { notStarted.push(name); return false; } });
	check("§2 B7 sweep: a replica starts no sweep, and names it", rep.started === false && rep.timers.length === 0 && notStarted.some((n) => /re-issue/.test(n)), { rep, notStarted });
	const live = start(null);
	check("§2 B7 sweep: outside a replica it runs every 15 minutes on an unref'd timer",
		live.started === true && live.timers.length === 1 && live.timers[0].ms === 15 * 60 * 1000 && live.timers[0].unrefd === true, live.timers);
	const off = start(null, { RATECON_REISSUE_HOLD_ENABLED: "false" });
	check("§2 B7 sweep: RATECON_REISSUE_HOLD_ENABLED=false starts none", off.started === false && off.timers.length === 0, off);
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

	// Low 5: the held columns, by header pattern (REISSUE_HELD_COLUMN_RES).
	const heldLift = closure(SRC, { roots: ["reissueHeldColumn"] });
	const isHeld = new Function(`"use strict";\n${heldLift.text}\nreturn reissueHeldColumn;`)();
	const heldNames = ["  Payment  ", "Payment", "Payment ($)", "Rate", "Total Amount", "Revenue", "Pickup Appointment", "Pickup Appointment Time", "Pickup Date",
		"Drop-off Appointment", "Drop Off Appointment", "Dropoff Appt Date", "Delivery Date"];
	const freeNames = ["Load ID", "Details", "Pickup Info", "Pickup Address", "Drop-off Info", "Drop-off Address", "Broker Contact Name", "Phone Number", "Email",
		"Assigned Date", "Documents", "Job Status", "Contract ID",
		"Completion Date", "Status Update Date", "Truck", "Owner ID", "Trailer Number", "Driver", "Carrier Stage", "Phase of Progress", "Location Link"];
	check("§4 reissueHeldColumn: Payment and the pickup and drop-off dates, under the names the patterns read (\"Delivery Appointment\" too)",
		[...heldNames, "Delivery Appointment"].every(isHeld), [...heldNames, "Delivery Appointment"].filter((n) => !isHeld(n)));
	check("§4 reissueHeldColumn: every other column of the sheet is free (Assigned Date has its own rule)",
		freeNames.every((n) => !isHeld(n)), freeNames.filter(isHeld));

	const icSrc = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	const libSrc = fs.readFileSync(path.join(ROOT, "lib", "cell-compare.js"), "utf8");
	check("§4 one amount reading: server.js and lib/integrity-check.js both require lib/cell-compare.js, and neither keeps a copy",
		/\nconst cellCompare = require\("\.\/lib\/cell-compare"\);\n/.test(SRC) && /require\("\.\/cell-compare"\)/.test(icSrc)
		&& !/function amountCents\(/.test(icSrc) && !/\\d\{1,9\}\(\?:\\\.\\d\{1,2\}\)\?\$/.test(SRC + icSrc));
	check("§4 lib/cell-compare.js is pure (requires nothing)", !/\brequire\(/.test(libSrc.replace(/\/\/.*$/gm, "")));
}

const CAPTURE = (process.argv.find((a) => a.startsWith("--capture=")) || "").slice("--capture=".length);

(async () => {
	if (CAPTURE) {
		const { answers } = await dvirFlagOffAnswers();
		fs.writeFileSync(CAPTURE, `${JSON.stringify({ note: "Captured on the base's own server.js by scripts/test-ratecon-reissue-hold.js --capture; made-up data.", answers }, null, 1)}\n`);
		console.log(`captured ${CAPTURE}`);
		process.exit(0);
	}
	await section1();
	await section1x();
	await section2();
	await section3();
	section4();
	console.log(`test-ratecon-reissue-hold: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
