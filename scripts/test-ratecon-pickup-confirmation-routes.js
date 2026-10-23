#!/usr/bin/env node
/**
 * "NEEDS CONFIRMATION" PICKUPS (Arvin, 2026-10-21; plan Revision 3, decisions N1-N12): the server
 * side of PR 1. The routes and helpers are lifted from server.js (scripts/lib/server-lift.js) over
 * an in-memory database (period_locks and load_status_history from server.js's own CREATE TABLEs)
 * and a stand-in Job Tracking; Gemini, the role gate, the audit and the shown-Load-ID rule are
 * stand-ins. Every value here is made up (load numbers, dates, ids, addresses, rate-con text);
 * none is copied from a real rate con or from production.
 *
 *   §1 POST /api/n8n/extract-pdf-via-gemini: the pickup reading is kept after the answer (the CHR
 *      line in the built-in text, or Gemini's notes), and the route writes nothing to any table;
 *      (R2 L8) two PDFs of one load within the TTL: DVIR's reading is the last PDF's, the pickup
 *      reading OR-s; the flag off keeps no pickup reading (DVIR as before).
 *   §2 POST /api/n8n/keep-stored-values: one record only with the flag on and a reading for that
 *      load; the answer is the same as with the flag off; no reading, no record; a held Pickup
 *      Appointment (a delivered load, or a person's date with the person hold on) leaves the record
 *      untouched; an email without the phrase never clears a flagged record.
 *   §3 POST /api/loads/pickup-confirmed: 404 with the flag off; 403 for Driver and Investor; 200
 *      for a Super Admin and for a Dispatcher naming a withheld Load ID as served, with one person
 *      row in load_cell_writes (asserted) and one audit row (the value only), after which the code
 *      is gone; 409 ROW_MOVED, PICKUP_NOT_FLAGGED, and (R2 H1) PERIOD_FINALIZED on a straddling row
 *      and a wholly closed one; 400 for a bad row index.
 *   §4 the dashboard (R2 L2): the codes are computed on the raw rows before sanitizing, so a
 *      Dispatcher's row whose Load ID is withheld still carries `_review`; the straddling row gets
 *      the closed variant; with the person hold off, a later email over a person's date brings the
 *      code back with `replaced`; the flag off adds no key; the call sits between enrichLocations()
 *      and sanitizeBrokerColumns().
 *   §5 drag-and-drop, as Super Admin and as Dispatcher: the extract keeps the reading and the
 *      extracted pickup for every role and adds the modal line; the create records a person row
 *      for a date changed in the modal and ratecon_create for a kept one, and the load's record
 *      (source dropzone); an expired stash reads the PDF itself; the flag off adds nothing; the
 *      create route calls the helpers in that order.
 *
 * SERVER_JS=<file> runs against another copy of server.js. Pure: no server, no network.
 * Run: node scripts/test-ratecon-pickup-confirmation-routes.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");
const { createRequire } = require("module");
const { closure, liftRoute } = require("./lib/server-lift");

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
const XHEAD = 'app.post("/api/n8n/extract-pdf-via-gemini"';
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const MHEAD = 'app.post("/api/loads/pickup-confirmed"';
const DHEAD = 'app.post("/api/loads/ratecon/extract"';
const CHEAD = 'app.post("/api/loads/from-ratecon"';
const DASH_HEAD = 'app.get("/api/dashboard"';
const ROOTS = ["rateConPickupReading", "rateConDvirReading", "annotateDashboardPickupReview", "rateConCreatePickup", "recordRateConCreateCellWrites",
	"recordRateConCreatePickupReading", "recordLoadCellWrite", "loadCellWritesTable", "sanitizeBrokerColumns", "rateConPickupStash", "rateConPickupReadings"];
const PROVIDED = ["app", "db", "process", "console", "require", "getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "pdfOcrLimiter", "rateConLimiter",
	"GEMINI_API_KEY", "runRateConGemini", "alertUnusableRateConExtraction", "alertRateConReissueHold", "requireRole", "logAudit", "notifyChange",
	"shownLoadId", "loadIdWithheldFor", "io", "sendEmail", "insertDispatchNotification"];
const has = (head) => SRC.includes(`\n${head}`);
const HAS_ALL = has(MHEAD) && ROOTS.every((r) => new RegExp(`\\n(async )?(function|const) ${r}\\b`).test(SRC));
check("server.js has the Mark confirmed route and the Needs Confirmation helpers", HAS_ALL);
if (!HAS_ALL) {
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const LIFTED = closure(SRC, { routes: [XHEAD, KHEAD, MHEAD, DHEAD], roots: ROOTS, provided: PROVIDED, denied: ["server", "transporter"] }).text;
const ddl = (table) => {
	const m = new RegExp(`(CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\))`).exec(SRC);
	if (!m) throw new Error(`${table}'s CREATE TABLE was not found in server.js`);
	return m[1];
};

// --- made-up rate cons -------------------------------------------------------------------
const zlib = require("zlib");
function pdfWith(lines) {
	const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
	const content = `BT /F1 10 Tf 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -14 Td`).join(" ")} ET`;
	const data = zlib.deflateSync(Buffer.from(content, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		data,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
	]);
}
const INTRO = ["Carrier Rate Confirmation for a test load.", "Pickup at Test Shipper, delivery appointment at Test Consignee.", "Equipment: van; trailer as booked; weight 20,000 lbs."];
const PDF_FLAGGED_DVIR = pdfWith([...INTRO, "Shipper Instructions", "20261006 0700: Scheduled Pick-up Date, Needs Confirmation", "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00"]);
const PDF_PLAIN = pdfWith([...INTRO, "Shipper Instructions", "Dock 4, check in at the gate.", "Line Haul", "$540.00"]);
const PDF_FLAGGED_B = pdfWith([...INTRO, "Shipper Instructions", "Scheduled Pickup Date, Needs Confirmation", "Dock 9."]);
const b64 = (buf) => buf.toString("base64");

const HEADERS = ["Load ID", "Details", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "  Payment  "];
const IDX = Object.fromEntries(HEADERS.map((h, i) => [h, i]));
function jtRow(id, over = {}) {
	const base = { "Load ID": id, Details: "Test lane", "Job Status": "Dispatched", "Pickup Appointment": "10/6/2026 7:00:00", "Drop-off Appointment": "10/8/2026 9:00:00", "Assigned Date": "10/5/2026", "  Payment  ": "$1,000.00" };
	const r = { ...base, ...over };
	return HEADERS.map((h) => r[h]);
}
// The Dispatcher is served a Load ID holding contact as this text (the shown-Load-ID stand-in).
const WITHHELD = { "900000555-ops@example.test": "900000555-[contact withheld]" };

// One world: a database, a Job Tracking, the lifted routes and helpers (env: the lifted
// code's process.env, read once as the server reads it at start).
function makeWorld({ env = {} } = {}) {
	const db = new Database(":memory:");
	db.exec(ddl("period_locks"));
	db.exec(ddl("load_status_history"));
	db.exec(ddl("load_invoice_drafts"));
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-01T00:00:00Z')").run();
	const sheet = [HEADERS.slice()];
	const logs = [];
	const capture = (...a) => logs.push(util.format(...a));
	const quiet = { ...console, log: capture, warn: capture, error: capture, info: capture };
	const audits = [];
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h; }, get: (p, ...h) => { routes[`GET ${p}`] = h; } };
	const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: sheet.map((r) => r.slice()) } }) } } };
	const gemini = { next: null };
	const role = (who) => (typeof who === "string" ? who : (who && who.session && who.session.user && who.session.user.role) || "");
	// lib/ratecon-dvir.js as shipped, counting each read of a PDF's text.
	const realDvir = rootRequire("./lib/ratecon-dvir");
	const pdfReads = { n: 0 };
	const countingDvir = { ...realDvir, pdfText: (...a) => { pdfReads.n++; return realDvir.pdfText(...a); } };
	const deps = {
		app,
		db,
		process: { env: { N8N_EXTRACT_SECRET: SECRET, ...env } },
		console: quiet,
		require: (p) => (p === "./lib/ratecon-dvir" ? countingDvir : rootRequire(p)),
		getSheets: async () => sheets,
		SPREADSHEET_ID: "sheet-under-test",
		n8nKeepStoredLimiter: (q, r, n) => n(),
		pdfOcrLimiter: (q, r, n) => n(),
		rateConLimiter: (q, r, n) => n(),
		GEMINI_API_KEY: "test-key",
		runRateConGemini: async () => ({ ...gemini.next }),
		alertUnusableRateConExtraction: async () => {},
		alertRateConReissueHold: async () => ({ alerted: true }),
		requireRole: (...roles) => (req, res, next) => (roles.includes(role(req)) ? next() : res.status(403).json({ error: "Forbidden" })),
		logAudit: (req, action, entity, entityId, details) => audits.push({ role: role(req), action, entity, entityId, details }),
		notifyChange: () => {},
		shownLoadId: (who, raw) => (role(who) === "Super Admin" ? raw : (WITHHELD[raw] || raw)),
		loadIdWithheldFor: (who) => role(who) !== "Super Admin",
		io: { to: () => ({ emit: () => {}, except: () => ({ emit: () => {} }) }) },
		sendEmail: async () => true,
		insertDispatchNotification: { run: () => ({}) },
	};
	const api = new Function(...PROVIDED, `"use strict";\n${LIFTED}\nreturn { ${ROOTS.join(", ")} };`)(...PROVIDED.map((k) => deps[k]));
	const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
	const call = async (p, req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const chain = routes[p];
		let i = 0;
		const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
		await next();
		await settle();
		return out;
	};
	const user = (r, id) => ({ session: { user: { role: r, id, username: `u${id}` } }, headers: { "x-requested-with": "XMLHttpRequest" } });
	return {
		db, sheet, logs, audits, gemini, api, settle, pdfReads,
		extractEmail: (pdf, fields) => { gemini.next = fields; return call("/api/n8n/extract-pdf-via-gemini", { headers: { "x-webhook-secret": SECRET }, body: { pdf_base64: b64(pdf) } }); },
		keep: (loadId, values) => call("/api/n8n/keep-stored-values", { headers: { "x-webhook-secret": SECRET }, body: { loadId, values }, ip: "" }),
		mark: (r, id, body) => call("/api/loads/pickup-confirmed", { ...user(r, id), body }),
		extractDrop: (r, id, pdf, fields) => { gemini.next = fields; return call("/api/loads/ratecon/extract", { ...user(r, id), body: { pdfBase64: b64(pdf) } }); },
		user,
		record: (id) => {
			try { return db.prepare("SELECT load_id, needs_confirmation, detected_by, source, first_seen, last_seen FROM ratecon_pickup_readings WHERE load_key = ?").get(String(id).toLowerCase()) || null; } catch { return null; }
		},
		recordCount: () => { try { return db.prepare("SELECT COUNT(*) AS n FROM ratecon_pickup_readings").get().n; } catch { return 0; } },
		cellRows: (id) => db.prepare("SELECT source, value, actor FROM load_cell_writes WHERE load_key = ? AND column_name = 'Pickup Appointment' ORDER BY id").all(String(id).toLowerCase()),
		tables: () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => [t.name, db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n]),
		rows: () => sheet.slice(1).map((cells) => Object.fromEntries(HEADERS.map((h, i) => [h, cells[i] == null ? "" : cells[i]]))),
	};
}

const GEM = (id, over = {}) => ({
	"Load Number": id, Rate: "$1,000.00", "Pickup Address": "100 Test Park Dr, Springfield, IL 62701", "Drop-off Address": "55 Depot Ln, Riverton, WY 82501",
	"Pickup Appointment Time": "10/06/2026 07:00", "Delivery Appointment Time": "10/08/2026 09:00", "Pickup Notes/Instructions": "Dock 4.", ...over,
});
const ON = { RATECON_PICKUP_CONFIRMATION_REVIEW_ENABLED: "true" };

(async () => {
	// ------------------------------------------------------------ §1 the n8n extract route
	{
		const w = makeWorld({ env: ON });
		const before = w.tables();
		const blank = await w.extractEmail(PDF_FLAGGED_DVIR, GEM(""));
		eq("§1 (security review Low 1) no Load Number: the route answers, the PDF's text is never read, no reading kept",
			[blank.status, w.pdfReads.n, w.api.rateConPickupReading(""), w.api.rateConDvirReading("")], [200, 0, null, null]);
		const r = await w.extractEmail(PDF_FLAGGED_DVIR, GEM("900000101"));
		eq("§1 the route answers 200 with Gemini's fields", [r.status, r.body && r.body.output && r.body.output["Load Number"]], [200, "900000101"]);
		eq("§1 the PDF's text is read once for both readings", w.pdfReads.n, 1);
		eq("§1 the CHR line in the built-in text is kept as the load's pickup reading", w.api.rateConPickupReading("900000101"), { needsConfirmation: true, by: "text" });
		eq("§1 the route writes nothing to any table (no new table, no row)", w.tables(), before);
		await w.extractEmail(PDF_PLAIN, GEM("900000101"));
		eq("§1 (R2 L8) a second PDF of the load: DVIR's reading is the last PDF's (no deduction), the pickup reading OR-s",
			[(w.api.rateConDvirReading("900000101") || {}).count, w.api.rateConPickupReading("900000101")], [0, { needsConfirmation: true, by: "text" }]);
		await w.extractEmail(PDF_PLAIN, GEM("900000102", { "Pickup Notes/Instructions": "20261006 0700: Scheduled Pick-up Date, Needs Confirmation" }));
		eq("§1 Gemini's notes alone flag it", w.api.rateConPickupReading("900000102"), { needsConfirmation: true, by: "notes" });
		await w.extractEmail(PDF_PLAIN, GEM("900000103"));
		eq("§1 neither: a reading without the phrase", w.api.rateConPickupReading("900000103"), { needsConfirmation: false, by: "" });
		const off = makeWorld();
		await off.extractEmail(PDF_FLAGGED_DVIR, GEM("900000104"));
		eq("§1 the flag off: no pickup reading; DVIR's reading as before", [off.api.rateConPickupReading("900000104"), (off.api.rateConDvirReading("900000104") || {}).count], [null, 1]);
	}

	// ------------------------------------------------------------ §2 keep-stored-values
	{
		const on = makeWorld({ env: ON });
		const off = makeWorld();
		for (const w of [on, off]) await w.extractEmail(PDF_FLAGGED_DVIR, GEM("900000201"));
		const values = { "Load ID": "900000201", "Pickup Appointment": "10/06/2026 07:00", "Drop-off Appointment": "10/08/2026 09:00", "Job Status": "Unassigned" };
		const a = await on.keep("900000201", values);
		const b = await off.keep("900000201", values);
		eq("§2 the answer is the same with the flag on and off", a.body, b.body);
		eq("§2 a new load with the phrase: one record, flagged, from the email", [on.recordCount(), on.record("900000201") && [on.record("900000201").needs_confirmation, on.record("900000201").detected_by, on.record("900000201").source]], [1, [1, "text", "email"]]);
		eq("§2 the flag off: no record", off.recordCount(), 0);
		await on.keep("900000202", { "Load ID": "900000202", "Pickup Appointment": "10/06/2026 07:00" });
		eq("§2 no reading for the load: no record", on.record("900000202"), null);
		await on.extractEmail(PDF_PLAIN, GEM("900000203"));
		await on.keep("900000203", { "Load ID": "900000203", "Pickup Appointment": "10/06/2026 07:00" });
		eq("§2 (review Low 2) a reading without the phrase on an unrecorded load: no record", on.record("900000203"), null);

		// A delivered load on file: the re-issue hold keeps the Pickup Appointment.
		on.sheet.push(jtRow("900000204", { "Job Status": "Delivered" }));
		await on.extractEmail(PDF_FLAGGED_DVIR, GEM("900000204"));
		await on.keep("900000204", { "Load ID": "900000204", "Pickup Appointment": "10/09/2026 07:00" });
		eq("§2 a delivered load (the re-issue hold keeps the date): no record", on.record("900000204"), null);

		// An open flagged load: an email without the phrase never clears it.
		on.sheet.push(jtRow("900000205"));
		await on.extractEmail(PDF_FLAGGED_DVIR, GEM("900000205"));
		await on.keep("900000205", { "Load ID": "900000205", "Pickup Appointment": "10/06/2026 07:00" });
		const first = on.record("900000205");
		await new Promise((r) => setTimeout(r, 5));
		// A later rate con without the phrase, after the first reading expired.
		on.api.rateConPickupReadings.note("900000205", { needsConfirmation: false, by: "" }, Date.now() + 11 * 60 * 1000);
		eq("§2 the later reading has no phrase", on.api.rateConPickupReading("900000205"), { needsConfirmation: false, by: "" });
		await on.keep("900000205", { "Load ID": "900000205", "Pickup Appointment": "10/07/2026 07:00" });
		const later = on.record("900000205");
		eq("§2 (decision 12 (a)) a later email that writes a new date keeps the record flagged, last seen moved",
			[later.needs_confirmation, later.first_seen === first.first_seen, later.last_seen > first.last_seen], [1, true, true]);

		// The person hold on: a person's date is held, so the record is untouched.
		const ph = makeWorld({ env: { ...ON, RATECON_PERSON_EDIT_HOLD_ENABLED: "true" } });
		ph.sheet.push(jtRow("900000206", { "Pickup Appointment": "10/9/2026 7:00:00" }));
		ph.api.recordLoadCellWrite("900000206", "Pickup Appointment", "10/06/2026 07:00", "ratecon", { at: "2026-10-05T12:00:00.000Z" });
		ph.api.recordLoadCellWrite("900000206", "Pickup Appointment", "10/9/2026 7:00:00", "person", { actor: "Dispatcher#2", at: "2026-10-05T13:00:00.000Z" });
		await ph.extractEmail(PDF_FLAGGED_DVIR, GEM("900000206"));
		const held = await ph.keep("900000206", { "Load ID": "900000206", "Pickup Appointment": "10/06/2026 07:00" });
		eq("§2 the person hold keeps a person's date (the answer holds it)", [held.status, held.body.values["Pickup Appointment"]], [200, "10/9/2026 7:00:00"]);
		eq("§2 a Pickup Appointment the person hold kept: no record", ph.record("900000206"), null);
		const failedNoRecord = on.logs.filter((l) => /\[ratecon-pickup\]/.test(l));
		eq("§2 nothing logged as failed", failedNoRecord, []);
	}

	// ------------------------------------------------------------ §3 Mark pickup confirmed
	{
		const off = makeWorld();
		off.sheet.push(jtRow("900000301"));
		eq("§3 the flag off: 404 (a Super Admin too)", (await off.mark("Super Admin", 1, { rowIndex: 2, loadId: "900000301" })).status, 404);

		const w = makeWorld({ env: ON });
		const board = [
			jtRow("900000301"),                                                       // row 2: open, flagged
			jtRow("900000555-ops@example.test"),                                      // row 3: open, flagged, withheld ID
			jtRow("900000303", { "Pickup Appointment": "9/29/2026 8:00:00" }),         // row 4: straddles closed September
			jtRow("900000304", { "Pickup Appointment": "9/20/2026 8:00:00", "Drop-off Appointment": "9/22/2026 9:00:00", "Assigned Date": "9/19/2026" }), // row 5: wholly closed
			jtRow("900000305"),                                                       // row 6: open, no record
		];
		// Each flagged load arrives as a new load (no closed-month hold runs for a load not yet
		// on the sheet: the plan's flag F8), then n8n writes its row.
		for (const row of board.slice(0, 4)) {
			await w.extractEmail(PDF_FLAGGED_DVIR, GEM(row[0]));
			await w.keep(row[0], { "Load ID": row[0], "Pickup Appointment": row[IDX["Pickup Appointment"]] });
		}
		for (const row of board) w.sheet.push(row);
		eq("§3 four flagged records", w.recordCount(), 4);
		eq("§3 Driver and Investor: 403", [(await w.mark("Driver", 7, { rowIndex: 2, loadId: "900000301" })).status, (await w.mark("Investor", 8, { rowIndex: 2, loadId: "900000301" })).status], [403, 403]);
		eq("§3 a bad row index: 400", [(await w.mark("Super Admin", 1, { rowIndex: 1, loadId: "900000301" })).status, (await w.mark("Super Admin", 1, { rowIndex: "2x", loadId: "900000301" })).status], [400, 400]);
		eq("§3 a row that holds another load: 409 ROW_MOVED", (await w.mark("Super Admin", 1, { rowIndex: 6, loadId: "900000301" })).body.code, "ROW_MOVED");
		eq("§3 no Needs Confirmation record: 409 PICKUP_NOT_FLAGGED", (await w.mark("Super Admin", 1, { rowIndex: 6, loadId: "900000305" })).body.code, "PICKUP_NOT_FLAGGED");
		eq("§3 (R2 H1) a row straddling a closed month: 409 PERIOD_FINALIZED", (await w.mark("Dispatcher", 2, { rowIndex: 4, loadId: "900000303" })).body.code, "PERIOD_FINALIZED");
		eq("§3 (R2 H1) a wholly closed row: 409 PERIOD_FINALIZED", (await w.mark("Dispatcher", 2, { rowIndex: 5, loadId: "900000304" })).body.code, "PERIOD_FINALIZED");
		eq("§3 nothing recorded or audited by a refusal", [w.audits.length, w.cellRows("900000303").filter((r) => r.source === "person").length], [0, 0]);

		const beforeCodes = w.rows();
		w.api.annotateDashboardPickupReview(HEADERS, "Load ID", beforeCodes);
		eq("§3 before: the open row carries pickup_unconfirmed", (beforeCodes[0]._review || []).map((c) => c.code), ["pickup_unconfirmed"]);

		const sa = await w.mark("Super Admin", 1, { rowIndex: 2, loadId: "900000301" });
		eq("§3 a Super Admin: 200", [sa.status, sa.body.ok, sa.body.stored], [200, true, "2026-10-06"]);
		eq("§3 one person row of the current value, role and user id", w.cellRows("900000301").filter((r) => r.source === "person"), [{ source: "person", value: "10/6/2026 7:00:00", actor: "Super Admin#1" }]);
		eq("§3 one audit row: load / pickup_confirmed, the value only", w.audits, [{ role: "Super Admin", action: "pickup_confirmed", entity: "load", entityId: "900000301", details: JSON.stringify({ value: "10/6/2026 7:00:00" }) }]);
		const again = await w.mark("Dispatcher", 2, { rowIndex: 2, loadId: "900000301" });
		eq("§3 confirming again: 200, already confirmed, no second person row or audit row",
			[again.status, again.body.alreadyConfirmed, w.cellRows("900000301").filter((r) => r.source === "person").length, w.audits.length], [200, true, 1, 1]);
		const disp = await w.mark("Dispatcher", 2, { rowIndex: 3, loadId: "900000555-[contact withheld]" });
		eq("§3 a Dispatcher naming a withheld Load ID as served: 200 and one audit row", [disp.status, w.audits.length, w.audits[1] && w.audits[1].role], [200, 2, "Dispatcher"]);
		eq("§3 the Dispatcher's person row", w.cellRows("900000555-ops@example.test").filter((r) => r.source === "person").map((r) => r.actor), ["Dispatcher#2"]);
		eq("§3 a Dispatcher naming the raw text of a withheld Load ID: 409 ROW_MOVED", (await w.mark("Dispatcher", 2, { rowIndex: 3, loadId: "900000555-ops@example.test" })).body.code, "ROW_MOVED");
		const afterCodes = w.rows();
		w.api.annotateDashboardPickupReview(HEADERS, "Load ID", afterCodes);
		eq("§3 after: both confirmed rows lose their code; the straddling row keeps the closed variant; the closed and unrecorded rows have none",
			afterCodes.map((r) => (r._review || []).map((c) => c.code)), [[], [], ["pickup_unconfirmed_closed"], [], []]);
	}

	// ------------------------------------------------------------ §4 the dashboard
	{
		const w = makeWorld({ env: ON });
		const board = [
			jtRow("900000555-ops@example.test"),
			jtRow("900000402", { "Pickup Appointment": "9/29/2026 8:00:00", "Assigned Date": "10/16/2026", "Drop-off Appointment": "10/19/2026 9:00:00" }),
			jtRow("900000403"),
		];
		for (const row of board) {
			await w.extractEmail(PDF_FLAGGED_DVIR, GEM(row[0]));
			await w.keep(row[0], { "Load ID": row[0], "Pickup Appointment": row[IDX["Pickup Appointment"]] });
		}
		for (const row of board) w.sheet.push(row);
		w.db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, '', ?, 'driver', 'test driver', ?)").run("900000402", "At Shipper", "2026-10-17 14:00:00");
		const raw = w.rows();
		w.api.annotateDashboardPickupReview(HEADERS, "Load ID", raw);
		const served = w.api.sanitizeBrokerColumns(HEADERS, raw.map((r) => ({ ...r })));
		check("§4 the withheld Load ID is not served as stored (redaction on)", served[0]["Load ID"] !== "900000555-ops@example.test", served[0]["Load ID"]);
		eq("§4 (R2 L2) the Dispatcher's row with a withheld Load ID still carries its code, dates intact", served[0]._review, [{ code: "pickup_unconfirmed", stored: "2026-10-06" }]);
		eq("§4 (R2 H1) stored in closed September, other months open: the closed variant with closedMonth and the arrival",
			served[1]._review, [{ code: "pickup_unconfirmed_closed", stored: "2026-09-29", arrived: "2026-10-17", closedMonth: "2026-09" }]);

		// Person hold off: a person's correction, then a later email writes the rate con's date back.
		w.api.recordLoadCellWrite("900000403", "Pickup Appointment", "10/9/2026 7:00:00", "person", { actor: "Dispatcher#2" });
		w.sheet[3][IDX["Pickup Appointment"]] = "10/9/2026 7:00:00";
		const personRows = w.rows();
		w.api.annotateDashboardPickupReview(HEADERS, "Load ID", personRows);
		eq("§4 a person's correction: no code", personRows[2]._review, undefined);
		await w.extractEmail(PDF_PLAIN, GEM("900000403"));
		const overwrite = await w.keep("900000403", { "Load ID": "900000403", "Pickup Appointment": "10/06/2026 07:00" });
		eq("§4 with the person hold off the email's date goes out (today's rule)", overwrite.body.values["Pickup Appointment"], "10/06/2026 07:00");
		w.sheet[3][IDX["Pickup Appointment"]] = "10/6/2026 7:00:00";
		const replaced = w.rows();
		w.api.annotateDashboardPickupReview(HEADERS, "Load ID", replaced);
		eq("§4 the code is back with `replaced`, read from load_cell_writes alone", replaced[2]._review, [{ code: "pickup_unconfirmed", stored: "2026-10-06", replaced: true }]);

		const off = makeWorld();
		off.sheet.push(jtRow("900000403"));
		const offRows = off.rows();
		eq("§4 the flag off: nothing computed, no row gets the key", [off.api.annotateDashboardPickupReview(HEADERS, "Load ID", offRows), offRows.some((r) => "_review" in r)], [0, false]);

		const dash = liftRoute(SRC, DASH_HEAD);
		const at = dash.indexOf("annotateDashboardPickupReview(");
		check("§4 the dashboard computes the codes after enrichLocations() and before sanitizeBrokerColumns()",
			at > dash.indexOf("enrichLocations(completedJobs)") && at < dash.indexOf("sanitizeBrokerColumns(") && dash.indexOf("enrichLocations(completedJobs)") > 0);
	}

	// ------------------------------------------------------------ §5 drag-and-drop
	{
		const key = (pdf) => require(path.join(ROOT, "lib", "broker-contact")).rateConStashKey(b64(pdf));
		for (const [r, id] of [["Super Admin", 1], ["Dispatcher", 2]]) {
			const w = makeWorld({ env: ON });
			const x = await w.extractDrop(r, id, PDF_FLAGGED_B, GEM(`9000005${id}1`));
			eq(`§5 ${r}: the extract answers 200 with the modal line last`, [x.status, x.body.warnings.slice(-1)], [200, ["The rate con marks the pickup date 'Needs Confirmation'. Check it before creating the load."]]);
			eq(`§5 ${r}: the pickup stash holds the reading and the extracted pickup`, w.api.rateConPickupStash.get(key(PDF_FLAGGED_B)), { needsConfirmation: true, by: "text", pickup: "10/06/2026 07:00" });
			const fieldsKept = GEM(`9000005${id}1`);
			const valuesKept = jtRow(`9000005${id}1`, { "Pickup Appointment": "10/06/2026 07:00" });
			const req = w.user(r, id);
			const pc = w.api.rateConCreatePickup(req, b64(PDF_FLAGGED_B), key(PDF_FLAGGED_B), HEADERS, fieldsKept);
			w.api.recordRateConCreateCellWrites(`9000005${id}1`, HEADERS, valuesKept, pc ? pc.person : null);
			w.api.recordRateConCreatePickupReading(`9000005${id}1`, HEADERS, valuesKept, pc.reading);
			eq(`§5 ${r}: the extracted date kept: a ratecon_create row`, w.cellRows(`9000005${id}1`).map((c) => c.source), ["ratecon_create"]);
			eq(`§5 ${r}: the load's record, flagged, from the drop zone`, [w.record(`9000005${id}1`).needs_confirmation, w.record(`9000005${id}1`).source], [1, "dropzone"]);

			await w.extractDrop(r, id, PDF_FLAGGED_B, GEM(`9000005${id}2`));
			const fieldsChanged = GEM(`9000005${id}2`, { "Pickup Appointment Time": "10/09/2026 07:00" });
			const valuesChanged = jtRow(`9000005${id}2`, { "Pickup Appointment": "10/09/2026 07:00" });
			const pc2 = w.api.rateConCreatePickup(req, b64(PDF_FLAGGED_B), key(PDF_FLAGGED_B), HEADERS, fieldsChanged);
			w.api.recordRateConCreateCellWrites(`9000005${id}2`, HEADERS, valuesChanged, pc2 ? pc2.person : null);
			w.api.recordRateConCreatePickupReading(`9000005${id}2`, HEADERS, valuesChanged, pc2.reading);
			eq(`§5 ${r}: a date changed in the modal: a person row (role and user id)`, w.cellRows(`9000005${id}2`), [{ source: "person", value: "10/09/2026 07:00", actor: `${r}#${id}` }]);
			const rows = [Object.fromEntries(HEADERS.map((h, i) => [h, valuesChanged[i]]))];
			w.api.annotateDashboardPickupReview(HEADERS, "Load ID", rows);
			eq(`§5 ${r}: so the changed date raises no code`, rows[0]._review, undefined);
		}
		const w = makeWorld({ env: ON });
		const pc = w.api.rateConCreatePickup(w.user("Dispatcher", 2), b64(PDF_FLAGGED_B), "no-such-key", HEADERS, GEM("900000590"));
		eq("§5 no stash (expired): the PDF's own text is read; the date counts as the rate con's", [pc.reading, pc.person], [{ needsConfirmation: true, by: "text" }, null]);
		const off = makeWorld();
		const xo = await off.extractDrop("Dispatcher", 2, PDF_FLAGGED_B, GEM("900000591"));
		eq("§5 the flag off: no modal line, no pickup stash, no create reading", [xo.body.warnings.length, off.api.rateConPickupStash.get(key(PDF_FLAGGED_B)), off.api.rateConCreatePickup(off.user("Dispatcher", 2), b64(PDF_FLAGGED_B), key(PDF_FLAGGED_B), HEADERS, GEM("900000591"))], [0, null, null]);
		const create = liftRoute(SRC, CHEAD);
		const a = create.indexOf("rateConCreatePickup(");
		const b = create.indexOf("recordRateConCreateCellWrites(loadId, headers, values, pickupCreate");
		const c = create.indexOf("recordRateConCreatePickupReading(");
		check("§5 the create route reads the pickup, records the cells with it, then the record, after the append", a > create.indexOf("values.append(") && a < b && b < c);
	}

	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => {
	console.error("FAIL runner crashed:", e && e.stack);
	process.exit(1);
});
