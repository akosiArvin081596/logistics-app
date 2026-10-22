#!/usr/bin/env node
/**
 * PERSON EDIT HOLD (2026-10-22, Arvin's rule of 2026-10-21): a Pickup or Drop-off Appointment a
 * person corrected on an open load is never overwritten by a later rate-con email; the email
 * raises the re-issue alert instead (like #502/#503), behind RATECON_PERSON_EDIT_HOLD_ENABLED
 * (default off), with the record (load_cell_writes) running from deploy whatever the flag.
 * Every value here is made up (load numbers, dates, ids, amounts); none is copied from production.
 *
 * POST /api/n8n/keep-stored-values is lifted with the real alert, retry sweep and recorders,
 * over an in-memory database (load_invoice_drafts and period_locks from server.js's own CREATE
 * TABLEs) and a stand-in Job Tracking that n8n "writes" the answer into, reformatting dates as
 * Sheets does (USER_ENTERED).
 *   §1 flag on: an email's date, a sheet edit, the same email again -> the person's date answered,
 *      held named, reason "in the sheet", one ledger row source 'person', email + in-app once;
 *      the same value again -> no second alert; a new value -> a new alert. Through a LogisX save
 *      by a Dispatcher -> reason "in LogisX by a Dispatcher". Drop-off the same; Payment never.
 *   §2 overlap (a read before the previous write landed) -> no hold; L4 first sighting seeded;
 *      L1 a manual row later edited in the sheet -> held; L2 another sheet, or the same date in
 *      another format -> no person row; drag-and-drop create rows count as the rate con's.
 *   §3 flag off: the answer is exactly today's (pinned literally and against a route with no
 *      record), one would_hold row, no alert. M1: flag on with RATECON_REISSUE_HOLD_ENABLED=false
 *      -> today's answer for an open and a delivered load, no held row, no alert, one warning per
 *      start, ratecon rows still recorded.
 *   §4 M2: every written/sheet shape pair seen is the app's own value (no hold); the three
 *      unreadable forms against a readable cell -> no hold, a format row, a log line; a time window
 *      compared as text.
 *   §5 L3: a person hold and a closed-month escalation in one call -> one alert, the re-issue
 *      wording, the reason adding "a person had corrected it"; a value alerted as a person hold,
 *      later held as delivered -> no second alert. Delivered / invoiced / closed-month loads: #502's
 *      answer and reason unchanged, no person ledger row. L7: the lost-edit line, once.
 *   §6 the sweep retries a failed person-hold email with its own wording and gives up at 48 h;
 *      a record failure never fails the call; the record keeps 20 rows per kind; the purge.
 *   §7 scripts/person-edit-hold-report.js: lists would_hold/held/format rows by Load ID suffix and
 *      column, marks a would_hold to review when either date can't be read (two readable times
 *      on one day are not marked), shows values with broker contact withheld and cut to 40
 *      characters, opens the database read-only.
 *   Review fixes: M1 (§2) the sheet's date is the app's own baseline the first time a column is
 *   seen, so overlapping rate cons or a failed n8n write never make it look like a person's; M2
 *   (§5) a "TBD" or closed-month email date still holds every column with the flag on.
 *   scripts/test-reissue-runners-person-hold-on.js runs the re-issue runners with the flag on.
 *
 * SERVER_JS=<file> runs against another copy of server.js. Pure: no server, no network.
 * Run: node scripts/test-keep-stored-person-hold.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const rootRequire = createRequire(path.join(ROOT, "server.js"));
let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const cellCompare = require(path.join(ROOT, "lib", "cell-compare"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(name, actual, expected) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const SECRET = "test-secret";
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const DRAFTS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS load_invoice_drafts \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const LOCKS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS period_locks \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const ROOTS = ["alertRateConReissueHold", "sweepRateConReissueHolds", "recordPersonCellEdits", "recordRateConCreateCellWrites",
	"warnPersonEditHoldInert", "purgeOldLoadCellWrites", "recordLoadCellWrite", "loadCellWritesTable"];
const HAS_ALL = SRC.includes(KHEAD) && ROOTS.every((r) => new RegExp(`\\n(async )?function ${r}\\(`).test(SRC));
const PROVIDED = ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "sendEmail", "insertDispatchNotification", "io"];
let LIFTED = null;
if (HAS_ALL) LIFTED = closure(SRC, { routes: [KHEAD], roots: ROOTS, provided: PROVIDED, denied: ["transporter", "server"] }).text;

const HEADERS = ["Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Job Status", "Assigned Date", "  Payment  "];
const IDX = Object.fromEntries(HEADERS.map((h, i) => [h, i]));

// What Sheets stores for a date the app writes USER_ENTERED: "10/6/2026 8:00:00".
function sheetsFormat(v) {
	const k = cellCompare.momentKey(v);
	if (k === null) return v;
	const [d, t] = k.split(" ");
	const [y, mo, da] = d.split("-").map(Number);
	const [h, mi, s] = t.split(":").map(Number);
	return `${mo}/${da}/${y} ${h}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const SHEET_WRITES = [];
// One world: a database, a Job Tracking, the lifted route and its helpers.
function world({ env = {}, send = async () => true, dbWrap = null, rows = [] } = {}) {
	const real = new Database(":memory:");
	real.exec(DRAFTS_DDL[1]);
	real.exec(LOCKS_DDL[1]);
	real.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-01T00:00:00Z')").run();
	const db = dbWrap ? dbWrap(real) : real;
	const sheet = [HEADERS.slice(), ...rows.map((r) => r.slice())];
	const logs = [];
	const capture = (...a) => logs.push(util.format(...a));
	const quiet = { ...console, log: capture, warn: capture, error: capture, info: capture };
	const sends = [];
	const notes = [];
	let sendImpl = send;
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	// Any Sheets method the route reaches but the read is recorded (SHEET_WRITES): the route
	// must never write the sheet.
	const noted = (target, allowed) => new Proxy(target, { get: (t, k) => {
		if (typeof k === "string" && k !== "then" && !allowed.includes(k)) SHEET_WRITES.push(k);
		return t[k];
	} });
	const sheets = { spreadsheets: noted({ values: noted({ get: async () => ({ data: { values: sheet.map((r) => r.slice()) } }) }, ["get"]) }, ["values"]) };
	const api = new Function(...PROVIDED, `"use strict";\n${LIFTED}\nreturn { ${ROOTS.join(", ")} };`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet,
		{ env: { N8N_EXTRACT_SECRET: SECRET, ADMIN_NOTIFY_EMAIL: "admin@example.test", ...env } }, app, rootRequire, db,
		async (to, subject, html) => { sends.push({ to, subject, html }); return sendImpl(to, subject, html); },
		{ run: (...a) => { notes.push({ type: a[0], title: a[1], body: a[2], metadata: JSON.parse(a[3]) }); } },
		{ to: () => ({ emit: () => {}, except: () => ({ emit: () => {} }) }) },
	);
	const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
	const post = async (loadId, values) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": SECRET }, body: { loadId, values }, ip: "" }, res);
		await settle();
		return out;
	};
	const findRow = (loadId) => {
		for (let i = sheet.length - 1; i >= 1; i--) if (String(sheet[i][0]).trim().toLowerCase().replace(/^#/, "") === String(loadId).trim().toLowerCase().replace(/^#/, "")) return i;
		return -1;
	};
	// n8n's JOB DETAILS ENTRY: the answer written (appendOrUpdate), Sheets reformatting dates.
	const n8nWrite = (loadId, values) => {
		let i = findRow(loadId);
		if (i === -1) { sheet.push(HEADERS.map(() => "")); i = sheet.length - 1; }
		for (const [col, v] of Object.entries(values)) {
			const j = HEADERS.indexOf(col);
			if (j >= 0) sheet[i][j] = /appo/i.test(col) ? sheetsFormat(String(v)) : String(v);
		}
	};
	// An email: keep-stored-values asked, then the answer written.
	const email = async (loadId, values) => {
		const r = await post(loadId, values);
		if (r.status === 200) n8nWrite(loadId, r.body.values);
		return r;
	};
	const setCell = (loadId, col, v) => { sheet[findRow(loadId)][IDX[col]] = v; };
	const cell = (loadId, col) => sheet[findRow(loadId)][IDX[col]];
	const rowOf = (loadId) => sheet[findRow(loadId)].slice();
	const cellRows = (key, col) => {
		if (!real.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'load_cell_writes'").get()) return [];
		return real.prepare("SELECT source, value, actor, stored_value FROM load_cell_writes WHERE load_key = ? AND column_name = ? ORDER BY id").all(key, col);
	};
	const ledger = () => { try { return real.prepare("SELECT * FROM ratecon_reissue_holds ORDER BY first_seen").all(); } catch { return []; } };
	return { api, db: real, sheet, post, email, n8nWrite, setCell, cell, rowOf, cellRows, ledger, sends, notes, logs, settle, setSend: (f) => { sendImpl = f; } };
}
const SA = { session: { user: { id: 1, role: "Super Admin", username: "super_admin" } } };
const DISPATCHER = { session: { user: { id: 7, role: "Dispatcher", username: "dispatch" } } };
const ON = { RATECON_PERSON_EDIT_HOLD_ENABLED: "true" };
const v = (o) => ({ "Load ID": o.id, Details: o.details || "Boxes", "Pickup Appointment": o.pu || "", "Drop-off Appointment": o.dr || "", "Assigned Date": o.as || "", "  Payment  ": o.pay || "$1,000.00" });
const heldCols = (r) => ((r.body && r.body.held) || []).map((h) => h.column).sort();

async function section1() {
	// The case this fixes.
	const w = world({ env: ON });
	const r1 = await w.email("900000201", v({ id: "900000201", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" }));
	eq("§1 email 1, a new load: answered as sent, nothing held", [r1.status, r1.body.found, r1.body.values["Pickup Appointment"], r1.body.held], [200, false, "10/6/2026 08:00", []]);
	eq("§1 email 1: the rate con's dates are recorded", [w.cellRows("900000201", "Pickup Appointment").map((x) => [x.source, x.value]), w.cellRows("900000201", "Drop-off Appointment").length],
		[[["ratecon", "10/6/2026 08:00"]], 1]);
	eq("§1 email 1: Payment is not recorded (not in v1)", w.cellRows("900000201", "Payment").length + w.cellRows("900000201", "  Payment  ").length, 0);
	w.setCell("900000201", "Pickup Appointment", "10/12/2026 8:00:00");
	const r2 = await w.email("900000201", v({ id: "900000201", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" }));
	eq("§1 email 2 after a sheet edit: the person's date is answered", r2.body.values["Pickup Appointment"], "10/12/2026 8:00:00");
	eq("§1 email 2: held names it, with the stored and the sent value", r2.body.held, [{ column: "Pickup Appointment", stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00" }]);
	check("§1 email 2: the reason says a person corrected it in the sheet after the rate con", /^a person corrected this date \(in the sheet after the rate con of [A-Z][a-z]{2} \d{1,2}\)$/.test(r2.body.holdReason), r2.body.holdReason);
	eq("§1 email 2: every other column as sent (kept lists the pickup only)", [r2.body.values.Details, r2.body.values["Drop-off Appointment"], r2.body.kept, r2.body.alsoChanged], ["Boxes", "10/8/2026 08:00", ["Pickup Appointment"], []]);
	eq("§1 email 2: the sheet still holds the person's date after n8n's write", w.cell("900000201", "Pickup Appointment"), "10/12/2026 8:00:00");
	const led = w.ledger();
	eq("§1 email 2: one ledger row, source 'person'", led.map((x) => [x.load_id, x.column_name, x.sent_value, x.stored_value, x.source]),
		[["900000201", "Pickup Appointment", "10/6/2026 08:00", "10/12/2026 8:00:00", "person"]]);
	eq("§1 email 2: one email and one in-app notice", [w.sends.length, w.notes.length], [1, 1]);
	const mail = w.sends[0] || { subject: "", html: "" };
	eq("§1 the email's subject", mail.subject, "Load 900000201: a later rate con did not replace a corrected date");
	check("§1 the email's lead", mail.html.includes("A later rate con for load 900000201 carried a different Pickup Appointment from the one a person set. The person's date was kept."), mail.html.slice(0, 300));
	check("§1 the email's table: Field / Kept / In the email / Result", /Field<\/th>.*Kept<\/th>.*In the email<\/th>.*Result<\/th>/.test(mail.html) && mail.html.includes("kept: the person&#39;s date"), mail.html);
	check("§1 the email says what to do, and nothing is applied", mail.html.includes("If the email's date is right (a real reschedule), change the load in LogisX. Nothing is applied for you."), mail.html);
	check("§1 the email leaves out #502's post-delivery sentence", !/Brokers re-send rate cons after delivery/.test(mail.html) && !/re-issue/.test(mail.subject), mail.html);
	const note = w.notes[0] || {};
	eq("§1 the in-app notice: the existing type, its own title and body", [note.type, note.title, note.body],
		["ratecon-reissue-held", "Load 900000201: corrected date kept", "Pickup Appointment: 10/12/2026 8:00:00 kept; the rate con said 10/6/2026 08:00"]);
	eq("§1 the in-app notice's metadata names the source", note.metadata && note.metadata.source, "person");
	eq("§1 a held row is recorded", w.cellRows("900000201", "Pickup Appointment").map((x) => x.source), ["ratecon", "held"]);
	await w.email("900000201", v({ id: "900000201", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" }));
	eq("§1 email 3, the same date again: still held, no second alert", [w.sends.length, w.notes.length, w.cell("900000201", "Pickup Appointment")], [1, 1, "10/12/2026 8:00:00"]);
	const r4 = await w.email("900000201", v({ id: "900000201", pu: "10/14/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" }));
	eq("§1 email 4, a new date: held, and a new alert", [r4.body.values["Pickup Appointment"], w.sends.length, w.notes.length], ["10/12/2026 8:00:00", 2, 2]);

	// The same through a LogisX save (PUT /api/load/:loadId) by a Dispatcher.
	const d = world({ env: ON });
	await d.email("900000202", v({ id: "900000202", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	const before = d.rowOf("900000202");
	const after = before.slice();
	after[IDX["Pickup Appointment"]] = "10/13/2026 09:00";
	eq("§1 a Dispatcher's save records one person row", d.api.recordPersonCellEdits(DISPATCHER, "Job Tracking", HEADERS, before, after), 1);
	eq("§1 the person row has the role and user id, no name", d.cellRows("900000202", "Pickup Appointment").slice(-1).map((x) => [x.source, x.value, x.actor]), [["person", "10/13/2026 09:00", "Dispatcher#7"]]);
	d.setCell("900000202", "Pickup Appointment", "10/13/2026 9:00:00");
	const rd = await d.email("900000202", v({ id: "900000202", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§1 LogisX save: the Dispatcher's date is answered", rd.body.values["Pickup Appointment"], "10/13/2026 9:00:00");
	check("§1 LogisX save: the reason is \"in LogisX by a Dispatcher on <day>\"", /^a person corrected this date \(in LogisX by a Dispatcher on [A-Z][a-z]{2} \d{1,2}\)$/.test(rd.body.holdReason), rd.body.holdReason);

	// Drop-off the same; Payment never.
	const dr = world({ env: ON });
	await dr.email("900000203", v({ id: "900000203", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$1,000.00" }));
	dr.setCell("900000203", "Drop-off Appointment", "10/9/2026 7:00:00");
	dr.setCell("900000203", "  Payment  ", "$1,100.00");
	const rdr = await dr.email("900000203", v({ id: "900000203", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$1,000.00" }));
	eq("§1 Drop-off: the person's date is held", [rdr.body.values["Drop-off Appointment"], heldCols(rdr)], ["10/9/2026 7:00:00", ["Drop-off Appointment"]]);
	eq("§1 Payment: a person's sheet edit is not held by this rule (v1)", rdr.body.values["  Payment  "], "$1,000.00");
	const rboth = await dr.email("900000203", v({ id: "900000203", pu: "10/7/2026 08:00", dr: "10/10/2026 08:00" }));
	eq("§1 Pickup is the machine's, so a new email pickup is written; Drop-off stays held", [rboth.body.values["Pickup Appointment"], heldCols(rboth)], ["10/7/2026 08:00", ["Drop-off Appointment"]]);
	// Two held columns: one reason naming both.
	dr.setCell("900000203", "Pickup Appointment", "10/11/2026 6:00:00");
	const rtwo = await dr.email("900000203", v({ id: "900000203", pu: "10/7/2026 08:00", dr: "10/10/2026 08:00" }));
	check("§1 two held columns: one reason naming both", /^a person corrected these dates \(Pickup Appointment: in the sheet after the rate con of .+; Drop-off Appointment: in the sheet after the rate con of .+\)$/.test(rtwo.body.holdReason), rtwo.body.holdReason);
}

async function section2() {
	// Overlap: the second email's read came before the first email's write.
	const o = world({ env: ON });
	const a = await o.post("900000211", v({ id: "900000211", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	const b = await o.post("900000211", v({ id: "900000211", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§2 overlap, no row yet: both answered as sent, nothing held", [a.body.held, b.body.held, b.body.found], [[], [], false]);
	o.n8nWrite("900000211", a.body.values);
	const c1 = await o.post("900000211", v({ id: "900000211", pu: "10/9/2026 08:00", dr: "10/8/2026 08:00" }));
	const c2 = await o.post("900000211", v({ id: "900000211", pu: "10/9/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§2 overlap, the sheet holds an older rate-con value (the 10/9 write not landed yet): no hold", [c1.body.values["Pickup Appointment"], c2.body.values["Pickup Appointment"], c2.body.held], ["10/9/2026 08:00", "10/9/2026 08:00", []]);
	eq("§2 overlap: no alert", [o.sends.length, o.notes.length], [0, 0]);

	// L4: a load with no record whose email repeats the stored date.
	const s = world({ env: ON, rows: [["900000212", "Steel", "10/6/2026 8:00:00", "10/8/2026 8:00:00", "Dispatched", "10/5/2026, 9:00:00 AM", "$900.00"]] });
	const s1 = await s.email("900000212", v({ id: "900000212", details: "Steel", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$900.00" }));
	eq("§2 (L4, review M1) first sighting, same date: answered as sent; the sheet's date seeded as the app's own baseline, nothing more",
		[s1.body.held, s.cellRows("900000212", "Pickup Appointment").map((x) => [x.source, x.value])], [[], [["baseline", "10/6/2026 8:00:00"]]]);
	await s.email("900000212", v({ id: "900000212", details: "Steel", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$900.00" }));
	eq("§2 (L4) the same date again (a row exists): nothing more recorded", s.cellRows("900000212", "Pickup Appointment").length, 1);
	s.setCell("900000212", "Pickup Appointment", "10/7/2026 8:00:00");
	const s3 = await s.email("900000212", v({ id: "900000212", details: "Steel", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$900.00" }));
	eq("§2 (L4) a later sheet edit, then a different email: held", [s3.body.values["Pickup Appointment"], heldCols(s3)], ["10/7/2026 8:00:00", ["Pickup Appointment"]]);
	// No record at all (a load last emailed before the deploy), a date changed: today's rule.
	const nr = world({ env: ON, rows: [["900000213", "Wood", "10/12/2026 8:00:00", "10/14/2026 8:00:00", "Dispatched", "10/5/2026, 9:00:00 AM", "$900.00"]] });
	const nr1 = await nr.email("900000213", v({ id: "900000213", details: "Wood", pu: "10/6/2026 08:00", dr: "10/14/2026 08:00", pay: "$900.00" }));
	eq("§2 (decision 3) no record yet and a different date: today's rule (written)", [nr1.body.values["Pickup Appointment"], nr1.body.held, nr.sends.length], ["10/6/2026 08:00", [], 0]);
	eq("§2 (review M1) no record yet and a different date: the baseline, then the email's date",
		nr.cellRows("900000213", "Pickup Appointment").map((x) => [x.source, x.value]), [["baseline", "10/12/2026 8:00:00"], ["ratecon", "10/6/2026 08:00"]]);

	// Review M1: two overlapping rate cons (two PDFs in one email) on a load with no record. The
	// second read comes before the first write lands, so the sheet still holds the date from
	// before the record: the app's own (the baseline), never a person's.
	const PRE = ["900000217", "Steel", "10/6/2026 8:00:00", "10/8/2026 8:00:00", "Dispatched", "10/5/2026, 9:00:00 AM", "$900.00"];
	const pre = (pu) => v({ id: "900000217", details: "Steel", pu, dr: "10/8/2026 08:00", pay: "$900.00" });
	for (const [label, env] of [["flag on", ON], ["flag off", {}]]) {
		const ov = world({ env, rows: [PRE] });
		const a1 = await ov.post("900000217", pre("10/7/2026 08:00"));
		const a2 = await ov.post("900000217", pre("10/9/2026 08:00"));
		eq(`§2 (review M1, ${label}) two overlapping rate cons on a load with no record: no hold, each written as sent`,
			[a1.body.held, a2.body.held, a1.body.values["Pickup Appointment"], a2.body.values["Pickup Appointment"]], [[], [], "10/7/2026 08:00", "10/9/2026 08:00"]);
		eq(`§2 (review M1, ${label}) no would_hold, held or format row, no alert`,
			[ov.cellRows("900000217", "Pickup Appointment").filter((x) => !["baseline", "ratecon"].includes(x.source)).length, ov.sends.length, ov.notes.length], [0, 0, 0]);
		eq(`§2 (review M1, ${label}) recorded: the sheet's date as the baseline, then each email's date`,
			ov.cellRows("900000217", "Pickup Appointment").map((x) => [x.source, x.value]), [["baseline", "10/6/2026 8:00:00"], ["ratecon", "10/7/2026 08:00"], ["ratecon", "10/9/2026 08:00"]]);
	}
	// Review M1: a failed n8n write on a load with no record (the first answer never landed).
	const fw = world({ env: ON, rows: [PRE] });
	await fw.post("900000217", pre("10/7/2026 08:00"));
	const f2 = await fw.post("900000217", pre("10/7/2026 08:00"));
	eq("§2 (review M1) a failed n8n write, then the same email again: written, no hold", [f2.body.held, f2.body.values["Pickup Appointment"], fw.sends.length], [[], "10/7/2026 08:00", 0]);

	// L1: a manual row (POST /api/data) later edited in the sheet.
	const m = world({ env: ON });
	const manual = ["900000214", "Tiles", "10/12/2026 08:00", "10/14/2026 08:00", "Dispatched", "10/11/2026", "$700.00"];
	eq("§2 (decision 7) POST /api/data: the new row's dates are a person's", m.api.recordPersonCellEdits(SA, "Job Tracking", HEADERS, [], manual), 2);
	m.sheet.push(manual.map((x, i) => (/appo/i.test(HEADERS[i]) ? sheetsFormat(x) : x)));
	const m1 = await m.email("900000214", v({ id: "900000214", details: "Tiles", pu: "10/6/2026 08:00", dr: "10/14/2026 08:00", pay: "$700.00" }));
	check("§2 (decision 7) the rate con then brings another date: held, \"in LogisX by a Super Admin\"",
		m1.body.values["Pickup Appointment"] === "10/12/2026 8:00:00" && /in LogisX by a Super Admin on/.test(m1.body.holdReason), m1.body);
	m.setCell("900000214", "Pickup Appointment", "10/13/2026 8:00:00");
	const m2 = await m.email("900000214", v({ id: "900000214", details: "Tiles", pu: "10/6/2026 08:00", dr: "10/14/2026 08:00", pay: "$700.00" }));
	check("§2 (L1) the manual row later edited in the sheet: still held, \"in the sheet after a LogisX edit\"",
		m2.body.values["Pickup Appointment"] === "10/13/2026 8:00:00" && /in the sheet after a LogisX edit/.test(m2.body.holdReason), m2.body);

	// L2: PUT /api/data of another sheet, or the same date in another format.
	const l2 = world({ env: ON });
	const b0 = ["900000215", "Tiles", "10/12/2026 8:00:00", "10/14/2026 8:00:00", "Dispatched", "", "$700.00"];
	const b1 = b0.slice(); b1[IDX["Pickup Appointment"]] = "10/13/2026 08:00";
	eq("§2 (L2) a save of another sheet records nothing", [l2.api.recordPersonCellEdits(SA, "Carrier History", HEADERS, b0, b1), l2.cellRows("900000215", "Pickup Appointment").length], [0, 0]);
	const b2 = b0.slice(); b2[IDX["Pickup Appointment"]] = "10/12/2026 08:00";
	eq("§2 (L2) the same date in another format records nothing", [l2.api.recordPersonCellEdits(SA, "Job Tracking", HEADERS, b0, b2), l2.cellRows("900000215", "Pickup Appointment").length], [0, 0]);
	const b3 = b0.slice(); b3[IDX["Pickup Appointment"]] = "";
	eq("§2 a cleared date records nothing (a blank is never recorded)", l2.api.recordPersonCellEdits(SA, "Job Tracking", HEADERS, b0, b3), 0);
	const b4 = b0.slice(); b4[IDX.Details] = "Tiles, 3 pallets";
	eq("§2 a save that changes no date records nothing", l2.api.recordPersonCellEdits(DISPATCHER, "Job Tracking", HEADERS, b0, b4), 0);
	eq("§2 the sheet name is matched like the route resolves it", l2.api.recordPersonCellEdits(SA, "job tracking", HEADERS, b0, b1), 1);

	// Decision 5: a drag-and-drop create counts as the rate con's.
	const fr = world({ env: ON });
	const created = ["900000216", "Drums", "10/12/2026 08:00", "10/14/2026 08:00", "Dispatched", "10/11/2026", "$650.00"];
	eq("§2 (decision 5) from-ratecon: its dates recorded as ratecon_create", [fr.api.recordRateConCreateCellWrites("900000216", HEADERS, created), fr.cellRows("900000216", "Pickup Appointment").map((x) => x.source)], [2, ["ratecon_create"]]);
	fr.sheet.push(created.map((x, i) => (/appo/i.test(HEADERS[i]) ? sheetsFormat(x) : x)));
	const fr1 = await fr.email("900000216", v({ id: "900000216", details: "Drums", pu: "10/15/2026 08:00", dr: "10/14/2026 08:00", pay: "$650.00" }));
	eq("§2 (decision 5) a later email's new date is written (the created date is the machine's)", [fr1.body.values["Pickup Appointment"], fr1.body.held], ["10/15/2026 08:00", []]);
}

async function section3() {
	// Flag off: the answer is exactly today's.
	const off = world({});
	const noRecord = world({});
	const base = ["900000221", "Boxes", "10/12/2026 8:00:00", "10/8/2026 8:00:00", "Dispatched", "10/5/2026, 9:00:00 AM", "$1,000.00"];
	noRecord.sheet.push(base.slice());
	await off.email("900000221", v({ id: "900000221", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" }));
	off.setCell("900000221", "Pickup Appointment", "10/12/2026 8:00:00");
	const sent = v({ id: "900000221", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "10/5/2026, 9:00:00 AM" });
	const r = await off.post("900000221", sent);
	eq("§3 flag off: exactly today's answer (pinned)", r.body, {
		loadId: "900000221", storedLoadId: "900000221", found: true, rows: 1,
		values: { "Load ID": "900000221", Details: "Boxes", "Pickup Appointment": "10/6/2026 08:00", "Drop-off Appointment": "10/8/2026 08:00", "Assigned Date": "10/5/2026, 9:00:00 AM", "  Payment  ": "$1,000.00" },
		kept: [], held: [], holdReason: "", alsoChanged: [],
	});
	const today = await noRecord.post("900000221", sent);
	eq("§3 flag off: the same answer as a route with no record at all", r.body, today.body);
	eq("§3 flag off: one would_hold row with both dates", off.cellRows("900000221", "Pickup Appointment").filter((x) => x.source === "would_hold").map((x) => [x.value, x.stored_value]), [["10/6/2026 08:00", "10/12/2026 8:00:00"]]);
	eq("§3 flag off: no alert, no ledger row", [off.sends.length, off.notes.length, off.ledger().length], [0, 0, 0]);
	off.n8nWrite("900000221", r.body.values);
	await off.post("900000221", sent);
	eq("§3 flag off: once written, the email's date is the machine's (no second would_hold)", off.cellRows("900000221", "Pickup Appointment").filter((x) => x.source === "would_hold").length, 1);

	// M1: flag on with RATECON_REISSUE_HOLD_ENABLED=false.
	const m1 = world({ env: { ...ON, RATECON_REISSUE_HOLD_ENABLED: "false" } });
	const m1Today = world({ env: { RATECON_REISSUE_HOLD_ENABLED: "false" } });
	await m1.email("900000222", v({ id: "900000222", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§3 (M1) ratecon rows are still recorded", m1.cellRows("900000222", "Pickup Appointment").map((x) => x.source), ["ratecon"]);
	m1.setCell("900000222", "Pickup Appointment", "10/12/2026 8:00:00");
	m1Today.sheet.push(m1.rowOf("900000222"));
	const open = await m1.post("900000222", v({ id: "900000222", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	const openToday = await m1Today.post("900000222", v({ id: "900000222", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§3 (M1) an open load: exactly today's answer", open.body, openToday.body);
	eq("§3 (M1) an open load: the email's date is written", open.body.values["Pickup Appointment"], "10/6/2026 08:00");
	m1.setCell("900000222", "Job Status", "Delivered");
	m1Today.sheet[1][IDX["Job Status"]] = "Delivered";
	const del = await m1.post("900000222", v({ id: "900000222", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	const delToday = await m1Today.post("900000222", v({ id: "900000222", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§3 (M1) a delivered load: exactly today's answer", del.body, delToday.body);
	eq("§3 (M1) no held or would_hold row, no alert", [m1.cellRows("900000222", "Pickup Appointment").filter((x) => x.source !== "ratecon").length, m1.sends.length, m1.notes.length, m1.ledger().length], [0, 0, 0, 0]);
	m1.logs.length = 0;
	const why = m1.api.warnPersonEditHoldInert();
	check("§3 (M1) one warning per start says why", m1.logs.length === 1 && /RATECON_REISSUE_HOLD_ENABLED is off/.test(m1.logs[0]) && why, m1.logs);
	const quietOn = world({ env: ON });
	quietOn.logs.length = 0;
	eq("§3 (M1) no warning when both switches are on, or the flag is off", [quietOn.api.warnPersonEditHoldInert(), quietOn.logs.length, world({ env: { RATECON_REISSUE_HOLD_ENABLED: "false" } }).api.warnPersonEditHoldInert()], ["", 0, ""]);
	eq("§3 (M1) server.js calls the warning once, at start", (SRC.match(/\nwarnPersonEditHoldInert\(\);\n/g) || []).length, 1);
	// The flag's shape: default off.
	for (const [val, on] of [["", false], ["false", false], ["0", false], ["true", true], ["1", true], ["yes", true], ["On", true]]) {
		const t = world({ env: { RATECON_PERSON_EDIT_HOLD_ENABLED: val } });
		await t.email("900000223", v({ id: "900000223", pu: "10/6/2026 08:00" }));
		t.setCell("900000223", "Pickup Appointment", "10/12/2026 8:00:00");
		const tr = await t.post("900000223", v({ id: "900000223", pu: "10/6/2026 08:00" }));
		eq(`§3 RATECON_PERSON_EDIT_HOLD_ENABLED="${val}": ${on ? "holds" : "does not hold"}`, tr.body.held.length > 0, on);
	}
}

async function section4() {
	// M2: every written/sheet shape pair seen is the app's own value (a zero-padded month in an
	// open month: September is the world's closed month).
	const pairs = [["10/06/2026 14:00", "10/6/2026 14:00"], ["01/05/2027 07:30", "1/5/2027 7:30"], ["10/16/2026", "10/16/2026 0:00"], ["10/6/2026 08:00", "10/6/2026 8:00"],
		["10/06/2026 14:00", "10/6/2026 14:00:00"], ["10/16/2026", "10/16/2026 0:00:00"]];
	for (const [written, stored] of pairs) {
		const w = world({ env: ON });
		await w.post("900000231", v({ id: "900000231", pu: written }));
		w.sheet.push(["900000231", "Boxes", stored, "", "Dispatched", "", "$1,000.00"]);
		const r = await w.post("900000231", v({ id: "900000231", pu: "10/20/2026 08:00" }));
		eq(`§4 (M2) written "${written}", Sheets kept "${stored}": the app's own value, a new email date is written`,
			[r.body.values["Pickup Appointment"], r.body.held, w.cellRows("900000231", "Pickup Appointment").filter((x) => x.source !== "ratecon").length], ["10/20/2026 08:00", [], 0]);
	}
	for (const written of ["10/06 14:00", "10/06", "10/6/26 14:00"]) {
		const w = world({ env: ON });
		await w.post("900000232", v({ id: "900000232", pu: written }));
		w.sheet.push(["900000232", "Boxes", "10/6/2026 14:00:00", "", "Dispatched", "", "$1,000.00"]);
		w.logs.length = 0;
		const r = await w.post("900000232", v({ id: "900000232", pu: "10/20/2026 08:00" }));
		eq(`§4 (M2) written "${written}" (unreadable), Sheets kept a readable date: no hold, written as sent`, [r.body.values["Pickup Appointment"], r.body.held, w.sends.length], ["10/20/2026 08:00", [], 0]);
		eq(`§4 (M2) written "${written}": a format row with both values`, w.cellRows("900000232", "Pickup Appointment").filter((x) => x.source === "format").map((x) => [x.value, x.stored_value]), [["10/20/2026 08:00", "10/6/2026 14:00:00"]]);
		check(`§4 (M2) written "${written}": one log line`, w.logs.filter((l) => /\[person-edit-hold\].*can't be compared/.test(l)).length === 1, w.logs);
	}
	{
		// An unreadable email date against a person's value: format, never a hold.
		const w = world({ env: ON });
		await w.email("900000233", v({ id: "900000233", pu: "10/6/2026 08:00" }));
		w.setCell("900000233", "Pickup Appointment", "10/12/2026 8:00:00");
		const r = await w.post("900000233", v({ id: "900000233", pu: "10/06" }));
		eq("§4 (M2) a person's value and an unreadable email date: no hold, a format row", [r.body.held, w.cellRows("900000233", "Pickup Appointment").filter((x) => x.source === "format").length], [[], 1]);
	}
	{
		// A time window is compared as text.
		const w = world({ env: ON });
		await w.email("900000234", v({ id: "900000234", pu: "10/7/2026 08:00-14:00 (FCFS)" }));
		eq("§4 a time window is stored as text, as written", w.cell("900000234", "Pickup Appointment"), "10/7/2026 08:00-14:00 (FCFS)");
		const same = await w.email("900000234", v({ id: "900000234", pu: "10/7/2026 08:00-14:00 (FCFS)" }));
		eq("§4 the same time window again: nothing held", same.body.held, []);
		w.setCell("900000234", "Pickup Appointment", "10/8/2026 08:00-14:00 (FCFS)");
		const r = await w.email("900000234", v({ id: "900000234", pu: "10/7/2026 08:00-14:00 (FCFS)" }));
		eq("§4 a time window a person changed in the sheet: held (compared as text)", [r.body.values["Pickup Appointment"], heldCols(r)], ["10/8/2026 08:00-14:00 (FCFS)", ["Pickup Appointment"]]);
	}
}

async function section5() {
	// L3: a person hold and a closed-month escalation in one call.
	const w = world({ env: ON });
	await w.email("900000241", v({ id: "900000241", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	w.setCell("900000241", "Pickup Appointment", "10/12/2026 8:00:00");
	const r = await w.email("900000241", v({ id: "900000241", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", as: "9/28/2026, 9:00:00 AM" }));
	eq("§5 (L3) escalation: every column comes back as stored", [r.body.values["Pickup Appointment"], r.body.values["Assigned Date"]], ["10/12/2026 8:00:00", ""]);
	check("§5 (L3) escalation: the reason is the re-issue's, adding that a person had corrected it",
		/closed month \(2026-09\)/.test(r.body.holdReason) && /a person had corrected it \(Pickup Appointment\)/.test(r.body.holdReason), r.body.holdReason);
	eq("§5 (L3) escalation: one alert, the re-issue wording", [w.sends.length, w.notes.length, (w.sends[0] || {}).subject, (w.notes[0] || {}).title],
		[1, 1, "Load 900000241: a re-issued rate con was held", "Load 900000241: re-issued rate con held"]);
	eq("§5 (L3) escalation: the ledger rows are the re-issue's", [...new Set(w.ledger().map((x) => x.source))], ["reissue"]);
	eq("§5 (L3) escalation: no held row of the person hold's own", w.cellRows("900000241", "Pickup Appointment").filter((x) => x.source === "held").length, 0);

	// Review M2: the flag only ever adds holds. A person-corrected pickup, then an email whose
	// pickup can't be placed ("TBD") or is in a closed month: every column held, exactly as with
	// the flag off, the reason adding the person's correction, one re-issue alert.
	for (const [label, pu] of [["a TBD pickup", "TBD"], ["a closed-month pickup", "9/28/2026 08:00"]]) {
		const run = {};
		for (const [name, env] of [["on", ON], ["off", {}]]) {
			const x = world({ env });
			await x.email("900000248", v({ id: "900000248", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00", pay: "$3,333.33" }));
			x.setCell("900000248", "Pickup Appointment", "10/12/2026 8:00:00");
			run[name] = { x, r: await x.post("900000248", v({ id: "900000248", details: "Crates, 2 skids", pu, dr: "10/8/2026 08:00", pay: "$3,400.00" })) };
		}
		const { on, off } = run;
		eq(`§5 (review M2) ${label}, flag on: every column comes back as stored`,
			[on.r.body.values["Pickup Appointment"], on.r.body.values["  Payment  "], on.r.body.values.Details], ["10/12/2026 8:00:00", "$3,333.33", "Boxes"]);
		eq(`§5 (review M2) ${label}: the same values and held columns as with the flag off`, [on.r.body.values, heldCols(on.r)], [off.r.body.values, heldCols(off.r)]);
		check(`§5 (review M2) ${label}: the flag-off reason, plus "a person had corrected it"`,
			off.r.body.holdReason !== "" && on.r.body.holdReason === `${off.r.body.holdReason} and a person had corrected it (Pickup Appointment)`, { on: on.r.body.holdReason, off: off.r.body.holdReason });
		eq(`§5 (review M2) ${label}: one alert, the re-issue wording`, [on.x.sends.length, on.x.notes.length, (on.x.sends[0] || {}).subject, (on.x.notes[0] || {}).title],
			[1, 1, "Load 900000248: a re-issued rate con was held", "Load 900000248: re-issued rate con held"]);
	}

	// L3: a value alerted as a person hold, later held as delivered: no second alert.
	const d = world({ env: ON });
	await d.email("900000242", v({ id: "900000242", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	d.setCell("900000242", "Pickup Appointment", "10/12/2026 8:00:00");
	await d.email("900000242", v({ id: "900000242", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§5 (L3) the person hold alerted once", [d.sends.length, d.notes.length], [1, 1]);
	d.setCell("900000242", "Job Status", "Delivered");
	const dd = await d.email("900000242", v({ id: "900000242", pu: "10/6/2026 08:00", dr: "10/8/2026 08:00" }));
	eq("§5 (L3) delivered later, same value: held as delivered (#502), no second alert", [dd.body.holdReason, dd.body.values["Pickup Appointment"], d.sends.length, d.notes.length], ["delivered", "10/12/2026 8:00:00", 1, 1]);

	// #502's answer and reason unchanged on delivered, invoiced and closed-month loads.
	for (const [label, row, drafted, want] of [
		["delivered", ["900000243", "Boxes", "10/12/2026 8:00:00", "10/14/2026 8:00:00", "Delivered", "10/5/2026, 9:00:00 AM", "$1,000.00"], false, "delivered"],
		["invoiced", ["900000244", "Boxes", "10/12/2026 8:00:00", "10/14/2026 8:00:00", "In Transit", "10/5/2026, 9:00:00 AM", "$1,000.00"], true, "invoiced"],
		["closed month", ["900000245", "Boxes", "9/12/2026 8:00:00", "9/14/2026 8:00:00", "Dispatched", "9/5/2026, 9:00:00 AM", "$1,000.00"], false, "in a closed month (2026-09)"],
	]) {
		const on = world({ env: ON, rows: [row] });
		const today = world({ rows: [row] });
		for (const x of [on, today]) {
			if (drafted) x.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, broker_name, created_at) VALUES (?, 'INV-1', '$1,000.00', 'Test Broker', '2026-10-12T12:00:00Z')").run(row[0]);
			x.api.recordPersonCellEdits(DISPATCHER, "Job Tracking", HEADERS, row.map((c, i) => (i === IDX["Pickup Appointment"] ? (label === "closed month" ? "9/11/2026 8:00:00" : "10/11/2026 8:00:00") : c)), row);
		}
		const sentPu = label === "closed month" ? "9/6/2026 08:00" : "10/6/2026 08:00";
		const a = await on.post(row[0], v({ id: row[0], pu: sentPu, dr: row[3], as: row[5] }));
		const b = await today.post(row[0], v({ id: row[0], pu: sentPu, dr: row[3], as: row[5] }));
		eq(`§5 ${label}: #502's answer and reason, the same with the flag on and off`, a.body, b.body);
		check(`§5 ${label}: the reason is #502's`, a.body.holdReason === want || a.body.holdReason.startsWith(want), a.body.holdReason);
		eq(`§5 ${label}: no person ledger row`, on.ledger().filter((x) => x.source === "person").length, 0);
	}

	// L7: the lost-edit log line, once, for its shape only.
	const l = world({ env: ON });
	await l.email("900000246", v({ id: "900000246", pu: "10/6/2026 08:00" }));
	const before = l.rowOf("900000246");
	const after = before.slice(); after[IDX["Pickup Appointment"]] = "10/12/2026 08:00";
	l.api.recordPersonCellEdits(DISPATCHER, "Job Tracking", HEADERS, before, after);
	// The sheet still holds 10/6: n8n's write of an answer read before the edit landed after it.
	l.logs.length = 0;
	const lr = await l.post("900000246", v({ id: "900000246", pu: "10/6/2026 08:00" }));
	await l.post("900000246", v({ id: "900000246", pu: "10/6/2026 08:00" }));
	eq("§5 (L7) the lost-edit line fires once", l.logs.filter((x) => /is not in the sheet/.test(x)).length, 1);
	eq("§5 (L7) and nothing is held (the sheet holds the rate con's value)", lr.body.held, []);
	const quiet = world({ env: ON });
	await quiet.email("900000247", v({ id: "900000247", pu: "10/6/2026 08:00" }));
	quiet.setCell("900000247", "Pickup Appointment", "10/12/2026 8:00:00");
	quiet.logs.length = 0;
	await quiet.post("900000247", v({ id: "900000247", pu: "10/6/2026 08:00" }));
	eq("§5 (L7) a sheet edit is not the lost-edit shape", quiet.logs.filter((x) => /is not in the sheet/.test(x)).length, 0);
}

async function section6() {
	// The sweep retries a failed person-hold email with its own wording, and gives up at 48 h.
	const w = world({ env: ON, send: async () => false });
	await w.email("900000251", v({ id: "900000251", pu: "10/6/2026 08:00" }));
	w.setCell("900000251", "Pickup Appointment", "10/12/2026 8:00:00");
	await w.email("900000251", v({ id: "900000251", pu: "10/6/2026 08:00" }));
	eq("§6 a failed email: tried once, the in-app notice went", [w.sends.length, w.notes.length], [1, 1]);
	w.setSend(async () => true);
	const first = w.ledger()[0];
	const later = new Date(Date.parse(first.first_seen) + 20 * 60 * 1000);
	const s = await w.api.sweepRateConReissueHolds({ now: later, clock: () => later });
	eq("§6 the sweep retries it: one email, the person wording, no second in-app notice", [s.loads, w.sends.length, w.sends[1] && w.sends[1].subject, w.notes.length],
		[1, 2, "Load 900000251: a later rate con did not replace a corrected date", 1]);
	check("§6 the retry says it is one, and keeps the person reason", !!w.sends[1] && /This is a retry/.test(w.sends[1].html) && /Kept because a person corrected this date/.test(w.sends[1].html), w.sends[1] && w.sends[1].html);
	const g = world({ env: ON, send: async () => false });
	await g.email("900000252", v({ id: "900000252", pu: "10/6/2026 08:00" }));
	g.setCell("900000252", "Pickup Appointment", "10/12/2026 8:00:00");
	await g.email("900000252", v({ id: "900000252", pu: "10/6/2026 08:00" }));
	const gl = g.ledger()[0];
	const past = new Date(Date.parse(gl.first_seen) + 49 * 60 * 60 * 1000);
	const gs = await g.api.sweepRateConReissueHolds({ now: past, clock: () => past });
	eq("§6 after 48 h it is given up, like #507", [gs.gaveUp, g.ledger()[0].email_skipped, g.sends.length], [1, "gave_up", 1]);
	// A load with both a re-issue row and a person row owed: two alerts, each with its wording.
	const two = world({ env: ON, send: async () => false });
	await two.api.alertRateConReissueHold({ loadId: "900000253", reason: "delivered", held: [{ column: "  Payment  ", stored: "$1.00", sent: "$2.00" }] });
	await two.api.alertRateConReissueHold({ loadId: "900000253", reason: "a person corrected this date (in the sheet after the rate con of Oct 7)", held: [{ column: "Pickup Appointment", stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00" }], source: "person" });
	two.setSend(async () => true);
	const tl = new Date(Date.now() + 20 * 60 * 1000);
	await two.api.sweepRateConReissueHolds({ now: tl, clock: () => tl });
	eq("§6 a load owing both kinds: the sweep sends each with its own subject", two.sends.slice(2).map((x) => x.subject).sort(),
		["Load 900000253: a later rate con did not replace a corrected date", "Load 900000253: a re-issued rate con was held"]);

	// A record failure never fails the call.
	const broken = world({ env: ON, dbWrap: (real) => new Proxy(real, { get: (t, k) => (k === "prepare" || k === "exec"
		? (sql, ...a) => { if (/load_cell_writes/.test(String(sql))) throw new Error("disk I/O error"); return t[k](sql, ...a); }
		: typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) });
	const br = await broken.post("900000254", v({ id: "900000254", pu: "10/6/2026 08:00" }));
	eq("§6 a record that throws: the call still answers 200 with the values as sent", [br.status, br.body.values["Pickup Appointment"]], [200, "10/6/2026 08:00"]);
	await broken.post("900000254", v({ id: "900000254", pu: "10/7/2026 08:00" }));
	eq("§6 a record that throws: logged once", broken.logs.filter((x) => /load_cell_writes .* failed/.test(x)).length, 1);
	eq("§6 a person save whose record throws records nothing and does not throw", broken.api.recordPersonCellEdits(SA, "Job Tracking", HEADERS, ["900000254", "", "10/6/2026"], ["900000254", "", "10/7/2026"]), 0);

	// The record keeps the newest 20 rows per load, column and kind.
	const k = world({});
	for (let i = 1; i <= 25; i++) k.api.recordLoadCellWrite("900000255", "Pickup Appointment", `10/${i}/2026 08:00`, "ratecon");
	k.api.recordLoadCellWrite("900000255", "Pickup Appointment", "10/1/2026 08:00", "would_hold", { stored: "10/2/2026" });
	const kept = k.cellRows("900000255", "Pickup Appointment");
	eq("§6 the newest 20 rate-con rows kept, the shadow row beside them", [kept.filter((x) => x.source === "ratecon").length, kept.find((x) => x.source === "ratecon").value, kept.filter((x) => x.source === "would_hold").length], [20, "10/6/2026 08:00", 1]);
	k.api.recordLoadCellWrite("900000255", "Pickup Appointment", "10/1/2026 08:00", "would_hold", { stored: "10/2/2026" });
	eq("§6 the same shadow row is not recorded twice", k.cellRows("900000255", "Pickup Appointment").filter((x) => x.source === "would_hold").length, 1);
	eq("§6 a blank value is never recorded", k.api.recordLoadCellWrite("900000255", "Pickup Appointment", "  ", "ratecon"), false);
	// The purge: loads untouched for 180 days.
	k.api.recordLoadCellWrite("900000256", "Pickup Appointment", "3/1/2026 08:00", "ratecon", { at: "2026-03-01T12:00:00.000Z" });
	const purged = k.api.purgeOldLoadCellWrites(new Date("2026-10-22T12:00:00.000Z"));
	eq("§6 the purge removes a load untouched for 180 days, and only it", [purged, k.cellRows("900000256", "Pickup Appointment").length, k.cellRows("900000255", "Pickup Appointment").length], [1, 0, 21]);
	const tables = k.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name).filter((n) => !/^sqlite_/.test(n));
	eq("§6 the record writes no table but its own", tables, ["load_cell_writes", "load_invoice_drafts", "period_locks"]);
	// The route still writes nothing to the sheet: the stand-in has no write method at all.
	eq("§6 (review L6) across every call above, the route never reached a Sheets method but the read", SHEET_WRITES, []);
}

async function section7() {
	const reportPath = path.join(ROOT, "scripts", "person-edit-hold-report.js");
	if (!fs.existsSync(reportPath)) { check("§7 scripts/person-edit-hold-report.js exists", false); return; }
	const report = require(reportPath);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickuphold-report-"));
	const file = path.join(dir, "app.db");
	try {
		const w = world({});
		w.api.recordLoadCellWrite("900001234", "Pickup Appointment", "10/6/2026 08:00", "would_hold", { stored: "10/12/2026 8:00:00", at: "2026-10-20T15:00:00.000Z" });
		w.api.recordLoadCellWrite("900005678", "Pickup Appointment", "10/06 14:00", "would_hold", { stored: "10/6/2026 14:00:00", at: "2026-10-21T15:00:00.000Z" });
		w.api.recordLoadCellWrite("900009999", "Drop-off Appointment", "10/20/2026 08:00", "format", { stored: "10/6/2026 14:00:00", at: "2026-10-21T16:00:00.000Z" });
		w.api.recordLoadCellWrite("900004321", "Pickup Appointment", "10/7/2026 08:00", "held", { stored: "10/8/2026 8:00:00", at: "2026-10-21T17:00:00.000Z" });
		w.api.recordLoadCellWrite("900002468", "Pickup Appointment", "10/1/2026 08:00", "would_hold", { stored: "10/2/2026 8:00:00", at: "2026-10-01T15:00:00.000Z" });
		w.api.recordLoadCellWrite("900001357", "Pickup Appointment", "10/9/2026 08:00", "ratecon", { at: "2026-10-21T15:00:00.000Z" });
		// Review L2: two readable times on the same day are a real change, not marked.
		w.api.recordLoadCellWrite("900003579", "Pickup Appointment", "10/21/2026 08:00", "would_hold", { stored: "10/21/2026 14:00:00", at: "2026-10-21T18:00:00.000Z" });
		// Review L4: a long cell holding contact is shown with the contact withheld, cut to 40.
		w.api.recordLoadCellWrite("900008642", "Pickup Appointment", "10/21/2026 08:00 call ops@example.test for the appointment window please", "would_hold", { stored: "10/20/2026 8:00:00", at: "2026-10-21T19:00:00.000Z" });
		await w.db.backup(file);
		const before = fs.readFileSync(file);
		const out = report.buildReport({ dbPath: file, since: "2026-10-15" });
		eq("§7 the report lists would_hold, held and format rows since the date, by Load ID suffix and column, marking would_hold rows to review",
			out.rows.map((x) => [x.load, x.column, x.source, x.review, x.sameDay]),
			[["...1234", "Pickup Appointment", "would_hold", false, false], ["...5678", "Pickup Appointment", "would_hold", true, true], ["...9999", "Drop-off Appointment", "format", false, false],
				["...4321", "Pickup Appointment", "held", false, false], ["...3579", "Pickup Appointment", "would_hold", false, false], ["...8642", "Pickup Appointment", "would_hold", true, false]]);
		eq("§7 the report's counts and switch-on condition", [out.counts, out.switchOnReady], [{ would_hold: 4, held: 1, format: 1, review: 2 }, false]);
		check("§7 the text names no full Load ID", !/900001234|900005678/.test(out.text) && /\.\.\.1234/.test(out.text), out.text);
		const long = out.rows.find((x) => x.load === "...8642") || {};
		check("§7 (review L4) a value is shown with broker contact withheld and cut to 40 characters",
			!/ops@example\.test/.test(out.text + JSON.stringify(out.rows)) && long.email === "10/21/2026 08:00 call [contact withheld]…", long.email);
		check("§7 the database file is unchanged (opened read-only)", Buffer.compare(before, fs.readFileSync(file)) === 0);
		const clean = report.buildReport({ dbPath: file, since: "2026-10-22" });
		eq("§7 nothing since the date: the switch-on condition holds on its own rows", [clean.rows.length, clean.switchOnReady], [0, true]);
		let threw = null;
		try { report.buildReport({ dbPath: file, since: "yesterday" }); } catch (e) { threw = e.message; }
		check("§7 --since must be a date or an ISO time", /--since/.test(String(threw)), threw);
		let missing = null;
		try { report.buildReport({ dbPath: path.join(dir, "none.db"), since: "2026-10-15" }); } catch (e) { missing = e.message; }
		check("§7 a database that isn't there is refused, not created", !!missing && !fs.existsSync(path.join(dir, "none.db")), missing);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

(async () => {
	if (!DRAFTS_DDL || !LOCKS_DDL) { check("server.js's load_invoice_drafts and period_locks CREATE TABLEs", false); }
	else if (!HAS_ALL) { check("server.js has keep-stored-values and the person-edit-hold recorder, alert and sweep", false, ROOTS.filter((r) => !new RegExp(`\\n(async )?function ${r}\\(`).test(SRC))); }
	else {
		await section1();
		await section2();
		await section3();
		await section4();
		await section5();
		await section6();
		// §7 records its rows through the lifted recorder, so it runs only with it.
		await section7();
	}
	console.log(`\ntest-keep-stored-person-hold: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e && e.stack); process.exit(1); });
