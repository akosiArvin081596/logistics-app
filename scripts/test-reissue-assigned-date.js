#!/usr/bin/env node
/**
 * A stored Assigned Date is set once, when the load is first assigned, and never re-stamped
 * (client, 2026-10-09), under any header the money math reads as that column. Assigned Date
 * decides the month a load's revenue and driver pay count in. The money math finds the column
 * by pattern, findCol(headers, /assigned.*date/i) and jobTrackingMonthCols()'s dateCol, the
 * first header in sheet order that matches. keepStoredSheetValues() (behind
 * POST /api/n8n/keep-stored-values) recognised it only by its exact name, "assigned date"
 * after trim and lower case. So under a header such as "Assigned Date (ET)" a later rate-con
 * email re-stamped a stored Assigned Date and moved the load's revenue and pay month. The
 * owner's fix (2026-10-14, option ii): every column /assigned.*date|date.*assigned/i names is
 * set once, "Date Assigned" (the KPI and integrity check's pattern) included. And a re-issue
 * never fills a blank Assigned Date on a delivered or invoiced load (decision 3, 2026-10-14):
 * it comes back blank and the email's date is held for a person. Every value in this file is
 * made up: load numbers, amounts, dates and details.
 *
 *   §1 An ordinary open-month load (not delivered, not invoiced, in no closed month), under
 *      each header the money math reads as Assigned Date ("Assigned Date (ET)", "Load Assigned
 *      Date", "Assigned  Date", "ASSIGNED DATE"; first, the runner proves that the money math's
 *      own resolvers pick that header), and under "Date Assigned", which the money math does
 *      not read (proved too): a stored Assigned Date comes back as stored and is listed in
 *      kept; nothing is held and nothing is alerted; a blank stored one is filled as sent.
 *   §2 Delivered, invoiced and closed-month loads (protected by reissueHoldFor()), under the same
 *      headers:
 *      - a blank stored Assigned Date comes back blank on each: the email's date is listed in
 *        held (not in alsoChanged) and alerted as held;
 *      - a stored Assigned Date comes back as stored and is no news: not listed in alsoChanged
 *        or held, and not alerted.
 *   §3 Control: the exact "Assigned Date" header gets every §1 and §2 expectation.
 *   §4 Decision 3's edges, with "Assigned Date":
 *      - a sheet with no Job Status column (status unknown, held as if delivered): a blank
 *        Assigned Date comes back blank and is held, other columns as sent;
 *      - the outgoing closed-month check reads what goes out: a delivered load's blank
 *        Assigned Date sent in a closed month is held by decision 3, and nothing booked into
 *        the closed month goes out, so other columns follow the delivered rules; the reason
 *        names the closed month the email's Assigned Date is in (an open month adds nothing,
 *        and a month the hold of every column already names is not named again);
 *        a column a delivered load still writes (Completion Date) sent in a closed month still
 *        holds every column;
 *      - a sheet with two matching columns ("Assigned Date" and "Date Assigned"): each stored
 *        one is kept on an ordinary load, each blank one is filled on an ordinary load, and
 *        each blank one is held on a delivered load;
 *      - a column name is read to its first 200 characters, and a 1 MB one is answered fast.
 *
 * SERVER_JS=<file> runs against another copy of server.js (the base, to show a case fails).
 * Pure: no server, no network; an in-memory database. Run:
 *   node scripts/test-reissue-assigned-date.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
// server.js's own require, so a lifted `require("./lib/...")` finds this checkout's lib/.
const rootRequire = createRequire(path.join(ROOT, "server.js"));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
	if (cond) { pass++; console.log(`ok   ${name}`); return; }
	fail++;
	console.log(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(actual, expected, name) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`ok   ${name}`); return; }
	fail++;
	console.log(`FAIL ${name}: got ${a}, want ${e}`);
}
function fatal(msg) { console.log(`FAIL ${msg}`); process.exit(1); }

let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	fatal(`better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
}

// --- the code under test ------------------------------------------------------
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const PROVIDED = ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold"];
let ROUTE;
let MONEY;
try {
	ROUTE = closure(SRC, { routes: [KHEAD], provided: PROVIDED, denied: ["sendEmail", "transporter", "io", "server"] }).text;
	MONEY = new Function(`"use strict";\n${closure(SRC, { roots: ["findCol", "jobTrackingMonthCols"] }).text}\nreturn { findCol, jobTrackingMonthCols };`)();
} catch (e) {
	fatal(`lifting from server.js: ${e.message}`);
}
const DRAFTS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS load_invoice_drafts \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const LOCKS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS period_locks \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
if (!DRAFTS_DDL || !LOCKS_DDL) fatal("load_invoice_drafts's or period_locks's CREATE TABLE was not found in server.js");

// --- made-up Job Tracking -----------------------------------------------------
// Production's column order around it: Assigned Date, then Status Update Date, then
// Completion Date, so the money math's dateCol resolves to the Assigned Date header.
const SECRET = "test-secret";
// RATECON_PERSON_EDIT_HOLD_ENABLED from this runner's own environment reaches the lifted
// route's stand-in env, so every case here also runs with the person-edit hold on
// (scripts/test-reissue-runners-person-hold-on.js does that run).
const PERSON_HOLD_ENV = process.env.RATECON_PERSON_EDIT_HOLD_ENABLED === undefined ? {} : { RATECON_PERSON_EDIT_HOLD_ENABLED: process.env.RATECON_PERSON_EDIT_HOLD_ENABLED };
const SENT = "10/13/2026, 8:00:00 AM";
const headersFor = (ad) => ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Job Status", ad, "Status Update Date", "Completion Date", "Payment"];
// [load id, details, pickup, drop-off, job status, assigned date, status update date, payment]
const LOADS = {
	ordinary: ["900000201", "Cartons, 10 pallets", "10/20/2026 08:00", "10/21/2026 0:00", "Dispatched", "10/12/2026, 9:00:00 AM", "", "$1,500.00"],
	ordinaryBlank: ["900000202", "Tiles, 4 crates", "10/22/2026 08:00", "10/23/2026 0:00", "Dispatched", "", "", "$1,100.00"],
	delivered: ["900000203", "Paper rolls, 6 rolls", "10/9/2026 08:00", "10/9/2026 16:00", "Delivered", "10/7/2026, 1:23:45 PM", "10/9/2026", "$1,234.56"],
	deliveredBlank: ["900000204", "Boxes, 8 pallets", "10/10/2026 08:00", "10/11/2026 0:00", "Delivered", "", "10/11/2026", "$800.00"],
	invoicedBlank: ["900000205", "Steel coil", "10/14/2026 08:00", "10/15/2026 0:00", "In Transit", "", "", "$950.00"],
	closed: ["900000206", "Lumber, 12 bundles", "9/28/2026 08:00", "9/29/2026 0:00", "Dispatched", "9/27/2026, 9:00:00 AM", "", "$900.00"],
	closedBlank: ["900000207", "Drums, 20 count", "9/29/2026 08:00", "9/30/2026 0:00", "Dispatched", "", "", "$700.00"],
};
const sheetRow = ([id, details, pu, dr, status, ad, su, pay]) => [id, details, pu, dr, status, ad, su, "", pay];
// What n8n sends for a later email: the same details and amount, and a new Assigned Date.
const sentFor = (ad, [id, details, , , , , , pay]) => ({ "Load ID": id, Details: details, [ad]: SENT, Payment: pay });

// The route, lifted, reading a Job Tracking whose Assigned Date header is `ad` (or the
// given headers and rows).
function harness(ad, { headers = headersFor(ad), rows = Object.values(LOADS).map(sheetRow) } = {}) {
	const db = new Database(":memory:");
	db.exec(DRAFTS_DDL[1]);
	db.exec(LOCKS_DDL[1]);
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-01T00:00:00Z')").run();
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, broker_name, created_at) VALUES (?, ?, ?, 'Test Broker', '2026-10-12T12:00:00Z')")
		.run(LOADS.invoicedBlank[0], `INV-${LOADS.invoicedBlank[0]}`, LOADS.invoicedBlank[7]);
	const sheet = [headers, ...rows];
	const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: sheet } }) } } };
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const alerts = [];
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	new Function(...PROVIDED, `"use strict";\n${ROUTE}`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET, ...PERSON_HOLD_ENV } }, app, rootRequire, db,
		(a) => { alerts.push(a); return Promise.resolve({ alerted: true }); },
	);
	const post = async (load, values = sentFor(ad, load)) => {
		alerts.length = 0;
		const out = { status: 200, body: {} };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": SECRET }, body: { loadId: load[0], values }, ip: "" }, res);
		await new Promise((r) => setImmediate(r));
		return { status: out.status, body: out.body || {}, alerts: alerts.slice() };
	};
	return { post };
}
const listed = (arr, col) => (arr || []).find((x) => x.column === col) || null;
const alertedCols = (alerts, kind) => alerts.flatMap((a) => (a[kind] || []).map((x) => x.column));

// --- the cases, for one Assigned Date header ----------------------------------
async function ordinaryCases(sec, ad) {
	const { post } = harness(ad);
	const tag = `${sec} "${ad}", an ordinary open-month load`;
	const r = await post(LOADS.ordinary);
	eq(r.status, 200, `${tag}: the route answers 200`);
	eq((r.body.values || {})[ad], LOADS.ordinary[5], `${tag}: a stored Assigned Date comes back as stored, not re-stamped`);
	ok(`${tag}: and is listed in kept`, (r.body.kept || []).includes(ad), r.body.kept);
	eq([(r.body.held || []).length, r.alerts.length], [0, 0], `${tag}: nothing is held and nothing is alerted`);
	const b = await post(LOADS.ordinaryBlank);
	eq((b.body.values || {})[ad], SENT, `${tag}: a blank stored Assigned Date is filled as sent`);
}

async function protectedCases(sec, ad) {
	const { post } = harness(ad);
	const tag = `${sec} "${ad}"`;
	// A blank stored Assigned Date on a delivered or invoiced load: not filled; held and alerted.
	for (const [kind, load, reason] of [["delivered", LOADS.deliveredBlank, /delivered/], ["invoiced", LOADS.invoicedBlank, /invoiced/]]) {
		const r = await post(load);
		eq((r.body.values || {})[ad], "", `${tag}, ${kind}, blank stored: Assigned Date stays blank (a re-issue never fills it)`);
		ok(`${tag}, ${kind}, blank stored: the hold applies (${kind})`, reason.test(String(r.body.holdReason || "")), r.body.holdReason);
		eq([listed(r.body.held, ad), listed(r.body.alsoChanged, ad)], [{ column: ad, stored: "", sent: SENT }, null], `${tag}, ${kind}, blank stored: the email's date is listed in held, not in alsoChanged`);
		ok(`${tag}, ${kind}, blank stored: and alerted as held`, r.alerts.length === 1 && alertedCols(r.alerts, "held").includes(ad) && !alertedCols(r.alerts, "changed").includes(ad), r.alerts);
	}
	const cb = await post(LOADS.closedBlank);
	eq((cb.body.values || {})[ad], "", `${tag}, closed month, blank stored: Assigned Date stays blank (every column held)`);
	eq(listed(cb.body.held, ad), { column: ad, stored: "", sent: SENT }, `${tag}, closed month, blank stored: the fill is listed in held`);
	ok(`${tag}, closed month, blank stored: and alerted as held`, cb.alerts.length === 1 && alertedCols(cb.alerts, "held").includes(ad), cb.alerts);
	// A stored Assigned Date: kept by its own rule, so no news.
	const d = await post(LOADS.delivered);
	eq((d.body.values || {})[ad], LOADS.delivered[5], `${tag}, delivered, stored: Assigned Date comes back as stored, not re-stamped`);
	eq([listed(d.body.alsoChanged, ad), listed(d.body.held, ad), d.alerts.length], [null, null, 0], `${tag}, delivered, stored: not listed, and no alert`);
	const c = await post(LOADS.closed);
	eq((c.body.values || {})[ad], LOADS.closed[5], `${tag}, closed month, stored: Assigned Date comes back as stored`);
	eq([listed(c.body.held, ad), listed(c.body.alsoChanged, ad), c.alerts.length], [null, null, 0], `${tag}, closed month, stored: not listed, and no alert`);
}

const VARIANTS = ["Assigned Date (ET)", "Load Assigned Date", "Assigned  Date", "ASSIGNED DATE"];
const EXACT = "Assigned Date";
const DATE_ASSIGNED = "Date Assigned";

// §4: decision 3's edges.
async function edgeCases() {
	const ad = EXACT;
	// No Job Status column: status unknown, held as if delivered.
	const noStatusHeaders = ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", ad, "Status Update Date", "Completion Date", "Payment"];
	const noStatusRow = ["900000208", "Pipes, 3 bundles", "10/12/2026 08:00", "10/13/2026 0:00", "", "", "", "$600.00"];
	const ns = harness(ad, { headers: noStatusHeaders, rows: [noStatusRow] });
	const n = await ns.post(noStatusRow, { "Load ID": noStatusRow[0], Details: "Pipes, 4 bundles", [ad]: SENT, Payment: "$600.00" });
	eq((n.body.values || {})[ad], "", "§4 no Job Status column, blank stored: Assigned Date stays blank");
	ok("§4 no Job Status column: the hold says status unknown", /status unknown/.test(String(n.body.holdReason || "")), n.body.holdReason);
	eq(listed(n.body.held, ad), { column: ad, stored: "", sent: SENT }, "§4 no Job Status column, blank stored: the email's date is listed in held");
	eq((n.body.values || {}).Details, "Pipes, 4 bundles", "§4 no Job Status column: another column still comes back as sent");

	// The outgoing closed-month check reads what goes out.
	const { post } = harness(ad);
	const closedAd = "9/28/2026, 9:00:00 AM";
	const o = await post(LOADS.deliveredBlank, { "Load ID": LOADS.deliveredBlank[0], Details: "Boxes, 9 pallets", [ad]: closedAd, Payment: LOADS.deliveredBlank[7] });
	eq((o.body.values || {})[ad], "", "§4 delivered, a blank Assigned Date sent in a closed month: it stays blank");
	eq(listed(o.body.held, ad), { column: ad, stored: "", sent: closedAd }, "§4 delivered, a blank Assigned Date sent in a closed month: listed in held");
	eq([String(o.body.holdReason || ""), (o.body.values || {}).Details], ["delivered and the email's Assigned Date is in a closed month (2026-09)", "Boxes, 9 pallets"],
		"§4 delivered, a blank Assigned Date sent in a closed month: nothing booked into it goes out (Details as sent); the reason names the email's closed month");
	const op = await post(LOADS.deliveredBlank, { "Load ID": LOADS.deliveredBlank[0], Details: "Boxes, 9 pallets", [ad]: SENT, Payment: LOADS.deliveredBlank[7] });
	eq(String(op.body.holdReason || ""), "delivered", "§4 delivered, a blank Assigned Date sent in an open month: the reason is \"delivered\" only");
	const c = await post(LOADS.deliveredBlank, { "Load ID": LOADS.deliveredBlank[0], Details: "Boxes, 9 pallets", [ad]: SENT, "Completion Date": "9/30/2026", Payment: LOADS.deliveredBlank[7] });
	const cv = c.body.values || {};
	eq([cv.Details, cv["Completion Date"], cv[ad]], [LOADS.deliveredBlank[1], "", ""], "§4 delivered, a Completion Date sent in a closed month: every column comes back as stored");
	ok("§4 delivered, a Completion Date sent in a closed month: the reason says the re-issue's dates are in a closed month",
		/delivered/.test(String(c.body.holdReason || "")) && /the re-issue's dates are in a closed month \(2026-09\)/.test(String(c.body.holdReason || "")), c.body.holdReason);
	const sameMonth = await post(LOADS.deliveredBlank, { "Load ID": LOADS.deliveredBlank[0], [ad]: closedAd, "Completion Date": "9/30/2026", Payment: LOADS.deliveredBlank[7] });
	eq(String(sameMonth.body.holdReason || ""), "delivered and the re-issue's dates are in a closed month (2026-09)",
		"§4 delivered, Assigned Date and Completion Date sent in the same closed month: that month is named once (no separate Assigned Date note)");

	// Two matching columns: each is protected.
	const twoHeaders = ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Job Status", ad, DATE_ASSIGNED, "Status Update Date", "Completion Date", "Payment"];
	const twoOrdinary = ["900000209", "Cans, 5 pallets", "10/20/2026 08:00", "10/21/2026 0:00", "Dispatched", "10/12/2026, 9:00:00 AM", "10/12/2026", "", "", "$700.00"];
	const twoBlank = ["900000210", "Jars, 6 pallets", "10/20/2026 08:00", "10/21/2026 0:00", "Dispatched", "", "", "", "", "$710.00"];
	const twoDelivered = ["900000211", "Bags, 7 pallets", "10/9/2026 08:00", "10/10/2026 0:00", "Delivered", "", "", "10/10/2026", "", "$720.00"];
	const two = harness(ad, { headers: twoHeaders, rows: [twoOrdinary, twoBlank, twoDelivered] });
	const both = (row) => ({ "Load ID": row[0], Details: row[1], [ad]: SENT, [DATE_ASSIGNED]: "10/13/2026", Payment: row[9] });
	const t1 = await two.post(twoOrdinary, both(twoOrdinary));
	eq([(t1.body.values || {})[ad], (t1.body.values || {})[DATE_ASSIGNED]], [twoOrdinary[5], twoOrdinary[6]], "§4 two matching columns, ordinary load: each stored one comes back as stored");
	ok("§4 two matching columns, ordinary load: both listed in kept, nothing held or alerted",
		(t1.body.kept || []).includes(ad) && (t1.body.kept || []).includes(DATE_ASSIGNED) && (t1.body.held || []).length === 0 && t1.alerts.length === 0, t1.body);
	const t2 = await two.post(twoBlank, both(twoBlank));
	eq([(t2.body.values || {})[ad], (t2.body.values || {})[DATE_ASSIGNED]], [SENT, "10/13/2026"], "§4 two matching columns, ordinary load, both blank: each is filled as sent");
	const t3 = await two.post(twoDelivered, both(twoDelivered));
	eq([(t3.body.values || {})[ad], (t3.body.values || {})[DATE_ASSIGNED]], ["", ""], "§4 two matching columns, delivered, both blank: each stays blank");
	eq([listed(t3.body.held, ad), listed(t3.body.held, DATE_ASSIGNED)], [{ column: ad, stored: "", sent: SENT }, { column: DATE_ASSIGNED, stored: "", sent: "10/13/2026" }],
		"§4 two matching columns, delivered, both blank: each is listed in held");

	// The column names come from the request body: each is read to its first 200 characters.
	const t0 = Date.now();
	const long = await post(LOADS.ordinary, { "Load ID": LOADS.ordinary[0], ["a".repeat(1000000)]: SENT });
	ok("§4 a 1 MB column name is answered in under 1000 ms", long.status === 200 && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
	const past = `${"x".repeat(200)} Assigned Date`;
	const cut = await post(LOADS.deliveredBlank, { "Load ID": LOADS.deliveredBlank[0], [past]: SENT });
	eq([listed(cut.body.held, past), (cut.body.values || {})[past]], [null, SENT],
		"§4 a column name is read to its first 200 characters: \"Assigned Date\" after them does not make it that column");
}

(async () => {
	console.log("§1 an ordinary load: a stored Assigned Date is kept under every header the money math reads");
	for (const ad of VARIANTS) {
		const h = headersFor(ad);
		eq([MONEY.findCol(h, /assigned.*date/i), MONEY.jobTrackingMonthCols(h).dateCol], [ad, ad], `§1 "${ad}" is the column the money math reads as Assigned Date (findCol and dateCol)`);
	}
	const da = headersFor(DATE_ASSIGNED);
	eq([MONEY.findCol(da, /assigned.*date/i), MONEY.jobTrackingMonthCols(da).dateCol], [null, "Status Update Date"], `§1 "${DATE_ASSIGNED}" is not, yet it is protected too (option ii)`);
	for (const ad of [...VARIANTS, DATE_ASSIGNED]) await ordinaryCases("§1", ad);

	console.log("§2 delivered, invoiced and closed-month loads");
	for (const ad of [...VARIANTS, DATE_ASSIGNED]) await protectedCases("§2", ad);

	console.log(`§3 control: the exact "${EXACT}"`);
	await ordinaryCases("§3", EXACT);
	await protectedCases("§3", EXACT);

	console.log("§4 decision 3's edges: status unknown, the outgoing closed-month check, two matching columns");
	await edgeCases();

	console.log(`test-reissue-assigned-date: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`FAIL ${e.stack || e}`); process.exit(1); });
