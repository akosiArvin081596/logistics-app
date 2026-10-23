#!/usr/bin/env node
/**
 * scripts/test-truck-delete-open-month-fees.js — deleting a truck never removes
 * its maintenance fund entries, compliance fees or legal documents
 * (2026-10-22, plan §9, TD1-TD7).
 *
 * THE BUG. DELETE /api/trucks/:id hard-deletes the truck's maintenance_fund and
 * compliance_fees rows (matched by unit number) and its legal_documents rows.
 * Its guard (truckDeleteLockBlockers()) judges only CLOSED months: it returns no
 * blockers at all when no month is locked, and its fee leg reads only
 * maintenance `service` rows and `Paid` compliance fees. So an open-month
 * service row, a contribution or a Pending fee in any month, and every legal
 * document went with the truck, with no check.
 *
 * THE RULE ASSERTED:
 *   - any fee row the cascade would remove that is not already a closed-month
 *     blocker refuses the delete with its OWN 409 OPEN_MONTH_TRUCK_FEES,
 *     audited as delete_truck_blocked under that code, nothing written. It is
 *     counted before the guard's "no month locked" early return, so it holds
 *     with and without a locked month, and it never goes through
 *     periodBlockedResponse() (which always answers PERIOD_FINALIZED);
 *   - any legal document on the truck refuses it with 409 TRUCK_HAS_DOCUMENTS,
 *     the same way;
 *   - fee rows are matched case and edge spaces aside (LOWER(TRIM(truck))), and
 *     not at all when the unit number is blank;
 *   - the order: PERIOD_LOCK_UNREADABLE, then PERIOD_FINALIZED (closed months),
 *     then OPEN_MONTH_TRUCK_FEES, then TRUCK_HAS_DOCUMENTS, then TRUCK_REFERENCED;
 *   - the bodies carry counts only, and the text reads as planned;
 *   - each refusal's audit row ends with its counts ("nothing was written —
 *     maintenance_fund=N, compliance_fees=M" / "legal_documents=N"), and no
 *     subject or tail holds a dollar amount or a file name;
 *   - if the cascade ever removes a fee row or a legal document anyway, the
 *     transaction rolls back and the route answers 500 DELETE_ROLLED_BACK.
 *
 * WHAT MUST NOT CHANGE (these pass on main too):
 *   - a truck with no fee rows, no legal documents, no assignment history and
 *     no trailer deletes as before;
 *   - another truck's rows are untouched;
 *   - a closed-month service row still answers PERIOD_FINALIZED, audited so;
 *   - assignment history still answers TRUCK_REFERENCED.
 *
 *   §1 Open-month fee rows, with no month locked.
 *   §2 The same with a locked month: same code, text and audit code.
 *   §3 Contributions and Pending fees, any month.
 *   §4 Closed-month rows: PERIOD_FINALIZED wins, the new code never appears.
 *   §5 Matching: edge spaces counted, a blank unit number not.
 *   §6 Legal documents: TRUCK_HAS_DOCUMENTS, and the order against fees and
 *      TRUCK_REFERENCED.
 *   §7 What must not change.
 *   §8 Discrimination (mutants) and source pins, comments stripped.
 *   §9 A forced guard drift rolls the cascade back.
 *   §10 No dollar amount or file name in any refusal's audit subject or tail.
 *
 * The route registration is lifted whole from server.js with the real guard,
 * truckFeeLockedRows(), lockedPeriodsDesc(), periodBlockedResponse(),
 * periodLockUnreadableResponse(), periodLabel() and periodRefusalDetail(), over an in-memory database
 * built from server.js's own CREATE TABLE statements for the fee, legal
 * document, trailer and assignment tables. The money checks the guard also runs
 * (fixed costs, driver pay, the investor driver set) are stubbed empty; they
 * have their own runners. No server, no port, no app.db, no files, no network.
 * Made-up unit numbers only.
 *
 * Run: node scripts/test-truck-delete-open-month-fees.js   # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function eq(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	ok(name, a === e, `expected ${e}, got ${a}`);
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
function liftFn(name, src = SRC) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = src.indexOf(needle);
	const b = src.indexOf("\n}\n", a);
	if (b < 0) fatal(`could not locate the end of function ${name} in server.js`);
	return src.slice(a + 1, b + 2);
}
// The registration, from its line to the first `});` in column 0 after it.
function routeSource(verb, routePath) {
	const head = `\napp.${verb}("${routePath}",`;
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 registration of ${verb.toUpperCase()} ${routePath}, found ${hits}`);
	const a = SRC.indexOf(head) + 1;
	const b = SRC.indexOf("\n});\n", a);
	if (b < 0) fatal(`could not find the end of ${verb.toUpperCase()} ${routePath}`);
	return SRC.slice(a, b + 4);
}
// Code only: full-line and trailing `//` comments and `/* */` blocks removed.
function codeOnly(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !/^\s*\/\//.test(l))
		.map((l) => l.replace(/\s\/\/\s.*$/, ""))
		.join("\n");
}
function createTable(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\)`));
	if (!m) fatal(`CREATE TABLE ${name} not found in server.js`);
	return m[0];
}

const DELETE_SRC = routeSource("delete", "/api/trucks/:id");
const GUARD = liftFn("truckDeleteLockBlockers");
const HELPERS_SRC = ["lockedPeriodsDesc", "truckFeeLockedRows"].map((n) => liftFn(n)).join("\n");
const RESPONSES_SRC = ["periodLabel", "periodBlockedResponse", "periodLockUnreadableResponse"].map((n) => liftFn(n)).join("\n");
const auditText = (v, max) => String(v == null ? "" : v).slice(0, max);
// The real formatter, so the stand-in below records the detail the audit row
// would hold, built from the same subject and tail.
const periodRefusalDetail = new Function("auditText", `${liftFn("periodRefusalDetail")}\nreturn periodRefusalDetail;`)(auditText);
// Every refusal any case records, for the "no money, no file name" check in §9.
const ALL_REFUSALS = [];

// --- scratch database ------------------------------------------------------
function scratch() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT DEFAULT 'Active', owner_id INTEGER DEFAULT 0,
			assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '',
			vin TEXT DEFAULT '', created_at TEXT DEFAULT '2026-10-01 09:00:00');
		CREATE TABLE period_locks (period TEXT, status TEXT);
	`);
	for (const t of ["maintenance_fund", "compliance_fees", "trailers", "truck_assignments", "legal_documents"]) db.exec(createTable(t));
	for (const m of SRC.matchAll(/ALTER TABLE legal_documents ADD COLUMN [^"`\n]+/g)) {
		try { db.exec(m[0]); } catch { /* a column added twice, as the boot's try/catch allows */ }
	}
	return db;
}

// --- fixtures (made up) ----------------------------------------------------
const T5 = { id: 5, unit_number: "MADE-UP-T5" };
const T6 = { id: 6, unit_number: "MADE-UP-T6" };
const RETIRE = "To take it out of service, give it a retirement date in an open month.";

function world(opts = {}) {
	const db = scratch();
	const target = opts.target || T5;
	db.prepare("INSERT INTO trucks (id, unit_number) VALUES (?, ?)").run(target.id, target.unit_number);
	db.prepare("INSERT INTO trucks (id, unit_number) VALUES (?, ?)").run(T6.id, T6.unit_number);
	for (const p of opts.locked || []) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);
	// Another truck's own rows, which no delete of the target may touch.
	db.prepare("INSERT INTO maintenance_fund (type, amount, truck, date) VALUES ('service', 120, 'MADE-UP-T6', '2026-10-04')").run();
	db.prepare("INSERT INTO compliance_fees (type, amount, truck, due_date, status) VALUES ('IFTA', 75, 'MADE-UP-T6', '2026-10-30', 'Pending')").run();
	db.prepare("INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url) VALUES (6, 'MADE-UP-T6', 'Insurance', 't6-ins.pdf', '/uploads/legal/t6-ins.pdf')").run();
	for (const r of opts.maintenance || []) {
		db.prepare("INSERT INTO maintenance_fund (type, amount, truck, date) VALUES (?, ?, ?, ?)").run(r.type || "service", r.amount || 100, r.truck ?? target.unit_number, r.date);
	}
	for (const r of opts.compliance || []) {
		db.prepare("INSERT INTO compliance_fees (type, amount, truck, due_date, paid_date, status) VALUES (?, ?, ?, ?, ?, ?)")
			.run(r.type || "2290", r.amount || 50, r.truck ?? target.unit_number, r.due, r.paid || "", r.status || "Pending");
	}
	for (let i = 0; i < (opts.legal || 0); i++) {
		db.prepare("INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url) VALUES (?, ?, 'Registration', ?, ?)")
			.run(target.id, target.unit_number, `t5-reg-${i}.pdf`, `/uploads/legal/t5-reg-${i}.pdf`);
	}
	if (opts.assignment) db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, 'Made Up Driver', '2026-10-01', '')").run(target.id);
	return { db, readable: opts.readable !== false };
}

function deleteRoute(w, rec, guardSrc = GUARD) {
	const guard = new Function(
		"db", "periodLocksReadable", "investorPayoutBasis", "truckFixedCostLockedMonths", "truckMonthlyFixed",
		"normalizeDriverName", "getDriverPayStructures", "driverPayLockedMonths", "resolveDailyRate", "investorsHoldingDriver",
		`${HELPERS_SRC}\n${guardSrc}\nreturn truckDeleteLockBlockers;`,
	)(w.db, () => w.readable, { truckInFleet: () => true }, () => [], () => ({ total: 0 }),
		(s) => String(s || "").trim().toLowerCase(), () => ({}), () => [], () => 0, () => new Set());
	const AUDITED_UPSTREAM = Symbol("test");
	const recordPeriodRefusal = (audit, code, periods, subjectFallback) => {
		const a = audit || {};
		const subject = a.subject || subjectFallback;
		const row = { action: a.action, code, periods, subject, tail: a.tail, detail: periodRefusalDetail(subject, code, periods, a.note, a.tail) };
		rec.refusals.push(row);
		ALL_REFUSALS.push(row);
	};
	const responses = new Function("recordPeriodRefusal", "AUDITED_UPSTREAM",
		`${RESPONSES_SRC}\nreturn { periodBlockedResponse, periodLockUnreadableResponse };`)(recordPeriodRefusal, AUDITED_UPSTREAM);
	const deps = {
		requireRole: () => (req, res, next) => next(),
		db: w.db,
		truckDeleteLockBlockers: guard,
		auditText,
		periodBlockedResponse: responses.periodBlockedResponse,
		periodLockUnreadableResponse: responses.periodLockUnreadableResponse,
		recordPeriodRefusal,
		AUDITED_UPSTREAM,
		logAudit: (req, action, entity, id, details) => rec.audits.push({ action, entity, id, details }),
		notifyChange: () => {},
		console: { log() {}, warn() {}, error: (...a) => rec.errors.push(a.map(String).join(" ")) },
	};
	let captured = null;
	const app = { delete: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...Object.keys(deps), `${DELETE_SRC};`)(app, ...Object.values(deps));
	if (!captured || captured.path !== "/api/trucks/:id") fatal("the lifted registration did not register DELETE /api/trucks/:id");
	return captured.chain;
}
function del(w, id = T5.id, guardSrc) {
	const rec = { refusals: [], audits: [], errors: [] };
	const chain = deleteRoute(w, rec, guardSrc);
	const req = { method: "DELETE", params: { id: String(id) }, body: {}, query: {}, headers: {}, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } };
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	let threw = null;
	try {
		for (const mw of chain) {
			let next = false;
			mw(req, res, () => { next = true; });
			if (!next) break;
		}
	} catch (err) { threw = err.message; }
	return { status: res.statusCode, body: res.body || {}, threw, ...rec };
}
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;
const snapshot = (w) => [
	count(w.db, "SELECT COUNT(*) AS n FROM trucks"),
	count(w.db, "SELECT COUNT(*) AS n FROM maintenance_fund"),
	count(w.db, "SELECT COUNT(*) AS n FROM compliance_fees"),
	count(w.db, "SELECT COUNT(*) AS n FROM legal_documents"),
];
const done = (w) => w.db.close();
const OPEN_SERVICE = { type: "service", date: "2026-10-06" };

// ---------------------------------------------------------------------------
// §1 Open-month fee rows, no month locked (the guard's early return).
// ---------------------------------------------------------------------------
{
	const w = world({ maintenance: [OPEN_SERVICE] });
	const before = snapshot(w);
	const r = del(w);
	eq("§1 one open-month service row, no month locked: 409 OPEN_MONTH_TRUCK_FEES", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	ok("§1 ...the route did not throw", r.threw === null, r.threw);
	eq("§1 ...nothing written (truck, fee rows and legal documents all still there)", snapshot(w), before);
	eq("§1 ...audited once as delete_truck_blocked under OPEN_MONTH_TRUCK_FEES",
		r.refusals.map((x) => [x.action, x.code]), [["delete_truck_blocked", "OPEN_MONTH_TRUCK_FEES"]]);
	eq("§1 ...the audit row's tail carries the counts (L3)",
		r.refusals.map((x) => x.tail), ["nothing was written — maintenance_fund=1, compliance_fees=0"]);
	ok("§1 ...and the stored detail ends with it",
		String((r.refusals[0] || {}).detail).endsWith("WITHHELD [OPEN_MONTH_TRUCK_FEES] — nothing was written — maintenance_fund=1, compliance_fees=0"),
		(r.refusals[0] || {}).detail);
	eq("§1 ...no delete_truck success row", r.audits.filter((a) => a.action === "delete_truck").length, 0);
	eq("§1 ...the text",
		r.body.error,
		`Cannot delete MADE-UP-T5: 1 maintenance fund entry is filed under this truck. Deleting the truck would permanently delete it, so it stays in place. ${RETIRE} Nothing was changed.`);
	eq("§1 ...the body carries counts only", [Object.keys(r.body).sort(), r.body.counts], [["code", "counts", "error"], { maintenance_fund: 1, compliance_fees: 0 }]);
	done(w);
}

// ---------------------------------------------------------------------------
// §2 The same refusal with a locked month (no closed-month fee rows).
// ---------------------------------------------------------------------------
{
	const w = world({ locked: ["2026-09"], maintenance: [OPEN_SERVICE], compliance: [{ due: "2026-10-20", paid: "2026-10-12", status: "Paid" }] });
	const before = snapshot(w);
	const r = del(w);
	eq("§2 open-month service row + Paid fee, a month locked: 409 OPEN_MONTH_TRUCK_FEES", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	eq("§2 ...nothing written", snapshot(w), before);
	eq("§2 ...audited under OPEN_MONTH_TRUCK_FEES, not PERIOD_FINALIZED",
		r.refusals.map((x) => [x.action, x.code]), [["delete_truck_blocked", "OPEN_MONTH_TRUCK_FEES"]]);
	eq("§2 ...the audit row's tail carries both counts (L3)",
		r.refusals.map((x) => x.tail), ["nothing was written — maintenance_fund=1, compliance_fees=1"]);
	eq("§2 ...the plural text",
		r.body.error,
		`Cannot delete MADE-UP-T5: 1 maintenance fund entry and 1 compliance fee are filed under this truck. Deleting the truck would permanently delete them, so it stays in place. ${RETIRE} Nothing was changed.`);
	eq("§2 ...counts", r.body.counts, { maintenance_fund: 1, compliance_fees: 1 });
	done(w);
}

// ---------------------------------------------------------------------------
// §3 Contributions and Pending fees count too, in any month (TD2, TD3).
// ---------------------------------------------------------------------------
{
	const w = world({ maintenance: [{ type: "contribution", date: "2026-10-02" }, { type: "contribution", date: "2026-10-09" }] });
	const r = del(w);
	eq("§3 contributions only: refused, counting both", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FEES", { maintenance_fund: 2, compliance_fees: 0 }]);
	ok("§3 ...plural entries", /: 2 maintenance fund entries are filed under this truck\. /.test(String(r.body.error || "")), r.body.error);
	done(w);
}
{
	const w = world({ compliance: [{ due: "2026-11-15", status: "Pending" }] });
	const r = del(w);
	eq("§3 a Pending compliance fee only: refused", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FEES", { maintenance_fund: 0, compliance_fees: 1 }]);
	ok("§3 ...the zero part is left out", /: 1 compliance fee is filed under this truck\. /.test(String(r.body.error || "")), r.body.error);
	done(w);
}
{
	const w = world({ locked: ["2026-09"], maintenance: [{ type: "contribution", date: "2026-09-10" }] });
	const before = snapshot(w);
	const r = del(w);
	eq("§3 a contribution in a closed month (not a closed-month blocker): refused the same way", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	eq("§3 ...nothing written", snapshot(w), before);
	done(w);
}

// ---------------------------------------------------------------------------
// §4 Closed-month service and Paid rows keep PERIOD_FINALIZED; the new code
// never appears in that answer or its audit row.
// ---------------------------------------------------------------------------
{
	const w = world({ locked: ["2026-09"], maintenance: [{ type: "service", date: "2026-09-14" }, OPEN_SERVICE] });
	const before = snapshot(w);
	const r = del(w);
	eq("§4 closed-month service row + open row: PERIOD_FINALIZED, naming the month", [r.status, r.body.code, r.body.periods], [409, "PERIOD_FINALIZED", ["2026-09"]]);
	eq("§4 ...audited as PERIOD_FINALIZED only", r.refusals.map((x) => x.code), ["PERIOD_FINALIZED"]);
	ok("§4 ...OPEN_MONTH_TRUCK_FEES appears nowhere in the answer", !JSON.stringify(r.body).includes("OPEN_MONTH_TRUCK_FEES"), JSON.stringify(r.body));
	eq("§4 ...nothing written", snapshot(w), before);
	done(w);
}

// ---------------------------------------------------------------------------
// §5 Matching: edge spaces and letter case counted (TD4); a blank unit number
// matches no fee row.
// ---------------------------------------------------------------------------
{
	const w = world({ maintenance: [{ type: "service", date: "2026-10-06", truck: " made-up-t5 " }] });
	const before = snapshot(w);
	const r = del(w);
	eq("§5 a fee row stored as ' made-up-t5 ': counted, refused", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	eq("§5 ...and kept", snapshot(w), before);
	done(w);
}
{
	const BLANK = { id: 5, unit_number: "" };
	const w = world({ target: BLANK, maintenance: [{ type: "service", date: "2026-10-06", truck: "" }] });
	const r = del(w);
	eq("§5 a blank unit number: no fee count, the delete goes through", [r.status, r.body.success], [200, true]);
	eq("§5 ...only the documents leg ran, removing nothing", r.body.removed, { legal_documents: 0 });
	ok("§5 ...the audit line still reads \"cascade: no rows\"",
		r.audits.some((a) => a.action === "delete_truck" && String(a.details).endsWith("cascade: no rows")), JSON.stringify(r.audits));
	eq("§5 ...the blank-truck fee row is untouched (the cascade matches none)",
		count(w.db, "SELECT COUNT(*) AS n FROM maintenance_fund WHERE truck = ''"), 1);
	done(w);
}

// ---------------------------------------------------------------------------
// §6 Legal documents: TRUCK_HAS_DOCUMENTS, and the order of the refusals.
// ---------------------------------------------------------------------------
for (const locked of [[], ["2026-09"]]) {
	const w = world({ locked, legal: 2 });
	const before = snapshot(w);
	const r = del(w);
	const tag = locked.length ? "with a month locked" : "no month locked";
	eq(`§6 two legal documents, ${tag}: 409 TRUCK_HAS_DOCUMENTS`, [r.status, r.body.code], [409, "TRUCK_HAS_DOCUMENTS"]);
	eq(`§6 ...nothing written (${tag})`, snapshot(w), before);
	eq(`§6 ...audited under TRUCK_HAS_DOCUMENTS (${tag})`, r.refusals.map((x) => [x.action, x.code]), [["delete_truck_blocked", "TRUCK_HAS_DOCUMENTS"]]);
	eq(`§6 ...the audit row's tail carries the count (L3, ${tag})`, r.refusals.map((x) => x.tail), ["nothing was written — legal_documents=2"]);
	eq(`§6 ...the text (${tag})`,
		r.body.error,
		`Cannot delete MADE-UP-T5: 2 legal documents are filed under this truck. Deleting the truck would permanently delete them, so it stays in place. ` +
		`A document filed in error can be removed from the truck's documents first. ${RETIRE} Nothing was changed.`);
	eq(`§6 ...counts only (${tag})`, [Object.keys(r.body).sort(), r.body.counts], [["code", "counts", "error"], { legal_documents: 2 }]);
	done(w);
}
{
	// L4: a blank unit number skips the fee match, never the document count (the
	// documents are filed by truck id).
	const w = world({ target: { id: 5, unit_number: "" }, legal: 1 });
	const before = snapshot(w);
	const r = del(w);
	eq("§6 a blank unit number with one legal document: 409 TRUCK_HAS_DOCUMENTS", [r.status, r.body.code, r.body.counts], [409, "TRUCK_HAS_DOCUMENTS", { legal_documents: 1 }]);
	eq("§6 ...the document is kept", count(w.db, "SELECT COUNT(*) AS n FROM legal_documents WHERE truck_id = 5"), 1);
	eq("§6 ...nothing written", snapshot(w), before);
	eq("§6 ...audited with the count", r.refusals.map((x) => [x.code, x.tail]), [["TRUCK_HAS_DOCUMENTS", "nothing was written — legal_documents=1"]]);
	ok("§6 ...the text names the truck by id",
		String(r.body.error || "").startsWith("Cannot delete truck #5: 1 legal document is filed under this truck. "), r.body.error);
	done(w);
}
{
	const w = world({ legal: 1, maintenance: [OPEN_SERVICE] });
	const r = del(w);
	eq("§6 fee rows and legal documents: OPEN_MONTH_TRUCK_FEES first", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	done(w);
}
{
	const w = world({ assignment: true, maintenance: [OPEN_SERVICE] });
	const r = del(w);
	eq("§6 assignment history and a fee row: OPEN_MONTH_TRUCK_FEES before TRUCK_REFERENCED", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	done(w);
}
{
	const w = world({ assignment: true, legal: 1 });
	const r = del(w);
	eq("§6 assignment history and a legal document: TRUCK_HAS_DOCUMENTS before TRUCK_REFERENCED", [r.status, r.body.code], [409, "TRUCK_HAS_DOCUMENTS"]);
	done(w);
}

// ---------------------------------------------------------------------------
// §7 What must not change (passes on main too).
// ---------------------------------------------------------------------------
{
	const w = world();
	const r = del(w);
	eq("§7 no fee rows, documents, assignments or trailer: the delete goes through (200)", [r.status, r.body.success], [200, true]);
	eq("§7 ...the truck is gone", count(w.db, "SELECT COUNT(*) AS n FROM trucks WHERE id = 5"), 0);
	eq("§7 ...removed counts are all 0", r.body.removed, { legal_documents: 0, maintenance_fund: 0, compliance_fees: 0 });
	eq("§7 ...one delete_truck audit row, no refusal", [r.audits.filter((a) => a.action === "delete_truck").length, r.refusals.length], [1, 0]);
	eq("§7 ...the other truck's fee rows and document are untouched", [
		count(w.db, "SELECT COUNT(*) AS n FROM maintenance_fund WHERE truck = 'MADE-UP-T6'"),
		count(w.db, "SELECT COUNT(*) AS n FROM compliance_fees WHERE truck = 'MADE-UP-T6'"),
		count(w.db, "SELECT COUNT(*) AS n FROM legal_documents WHERE truck_id = 6"),
	], [1, 1, 1]);
	done(w);
}
{
	const w = world({ assignment: true });
	const r = del(w);
	eq("§7 assignment history alone: TRUCK_REFERENCED, as before", [r.status, r.body.code], [409, "TRUCK_REFERENCED"]);
	done(w);
}
{
	const w = world({ readable: false, maintenance: [OPEN_SERVICE] });
	const r = del(w);
	eq("§7 an unreadable lock table still answers PERIOD_LOCK_UNREADABLE first", [r.status, r.body.code], [409, "PERIOD_LOCK_UNREADABLE"]);
	done(w);
}

// ---------------------------------------------------------------------------
// §8 Discrimination and source pins.
// ---------------------------------------------------------------------------
{
	// A mutant whose anchor is missing is a failure, never a pass.
	const guardWith = (from, to) => {
		const n = GUARD.split(from).length - 1;
		if (n !== 1) { ok(`§8 mutant anchor found exactly once: ${from.slice(0, 60)}`, false, `found ${n}`); return null; }
		return GUARD.replace(from, to);
	};
	const noCount = guardWith("const openFees = {", "const openFees = { maintenance: 0, compliance: 0 }; const _unused = {");
	if (noCount) {
		const w = world({ maintenance: [OPEN_SERVICE] });
		const r = del(w, T5.id, noCount);
		eq("§8 mutant: without the fee count no 409; only the cascade's check (§9) stops the delete", [r.status, r.body.code], [500, "DELETE_ROLLED_BACK"]);
		done(w);
	}
	const earlyFirst = guardWith("const locked = lockedPeriodsDesc();", "const locked = lockedPeriodsDesc();\n\tif (!locked.length) return { unreadable: false, blockers: [], openFees: { maintenance: 0, compliance: 0 }, legalDocuments: 0 };");
	if (earlyFirst) {
		const w = world({ maintenance: [OPEN_SERVICE] });
		const r = del(w, T5.id, earlyFirst);
		eq("§8 mutant: the early return above the count loses the 409 with no month locked; only the cascade's check (§9) stops the delete",
			[r.status, r.body.code], [500, "DELETE_ROLLED_BACK"]);
		done(w);
	}
	const intoBlockers = guardWith("return { unreadable: false, blockers, openFees, legalDocuments };",
		"if (openFees.maintenance + openFees.compliance) blockers.push({ table: \"maintenance_fund\", rows: 1, periods: [], detail: \"x\" });\n\treturn { unreadable: false, blockers, openFees, legalDocuments };");
	if (intoBlockers) {
		const w = world({ locked: ["2026-09"], maintenance: [OPEN_SERVICE] });
		eq("§8 mutant: open fees pushed into blockers answer PERIOD_FINALIZED instead", del(w, T5.id, intoBlockers).body.code, "PERIOD_FINALIZED");
		done(w);
	}

	const ROUTE = codeOnly(DELETE_SRC);
	ok("§8 the cascade's fee deletes match case and edge spaces aside",
		/DELETE FROM maintenance_fund WHERE LOWER\(TRIM\(truck\)\) = \?/.test(ROUTE) && /DELETE FROM compliance_fees WHERE LOWER\(TRIM\(truck\)\) = \?/.test(ROUTE));
	const at = (s) => ROUTE.indexOf(s);
	ok("§8 the route answers PERIOD_FINALIZED, then OPEN_MONTH_TRUCK_FEES, then TRUCK_HAS_DOCUMENTS, then TRUCK_REFERENCED",
		at("periodBlockedResponse(") > 0 && at("periodBlockedResponse(") < at("\"OPEN_MONTH_TRUCK_FEES\"") &&
		at("\"OPEN_MONTH_TRUCK_FEES\"") < at("\"TRUCK_HAS_DOCUMENTS\"") && at("\"TRUCK_HAS_DOCUMENTS\"") < at("\"TRUCK_REFERENCED\""));
	ok("§8 the open-fee answer never goes through periodBlockedResponse()",
		!/periodBlockedResponse\([^;]*OPEN_MONTH_TRUCK_FEES/.test(ROUTE));
}

// ---------------------------------------------------------------------------
// §9 The cascade's own check (L2): if the guard ever lets through a truck whose
// fee rows or legal documents the cascade then removes, the transaction rolls
// back and the route answers 500 DELETE_ROLLED_BACK. The drift is forced with a
// guard that reports nothing on the no-month-locked path.
// ---------------------------------------------------------------------------
{
	const anchor = "if (!locked.length) return { unreadable: false, blockers: [], openFees, legalDocuments };";
	const n = GUARD.split(anchor).length - 1;
	ok("§9 drift anchor found exactly once in the guard", n === 1, `found ${n}`);
	const blind = n === 1
		? GUARD.replace(anchor, "if (!locked.length) return { unreadable: false, blockers: [], openFees: { maintenance: 0, compliance: 0 }, legalDocuments: 0 };")
		: null;
	const cases = [
		["one legal document", { legal: 1 }],
		["one open-month service row", { maintenance: [OPEN_SERVICE] }],
		["one Pending compliance fee", { compliance: [{ due: "2026-11-15", status: "Pending" }] }],
		// A blank unit number skips the fee match, never the documents (filed by truck id).
		["a blank unit number with one legal document", { target: { id: 5, unit_number: "" }, legal: 1 }],
	];
	for (const [label, opts] of blind ? cases : []) {
		const w = world(opts);
		const before = snapshot(w);
		const r = del(w, T5.id, blind);
		eq(`§9 drift (${label}): 500 DELETE_ROLLED_BACK`, [r.status, r.body.code], [500, "DELETE_ROLLED_BACK"]);
		ok(`§9 ...the route did not throw (${label})`, r.threw === null, r.threw);
		eq(`§9 ...rolled back: truck, fee rows and documents all still there (${label})`, snapshot(w), before);
		eq(`§9 ...the truck's own documents are kept (${label})`,
			count(w.db, "SELECT COUNT(*) AS n FROM legal_documents WHERE truck_id = 5"), opts.legal || 0);
		eq(`§9 ...no delete_truck success row (${label})`, r.audits.filter((a) => a.action === "delete_truck").length, 0);
		eq(`§9 ...the body names no row (${label})`, Object.keys(r.body).sort(), ["code", "error"]);
		// One server-log line, naming tables and counts only: every "=" is
		// followed by a whole number, and no file name or dollar amount.
		const logText = r.errors.join("\n");
		ok(`§9 ...exactly one error logged (${label})`, r.errors.length === 1, JSON.stringify(r.errors));
		ok(`§9 ...the log line holds only =N counts (${label})`,
			/=\d/.test(logText) && !/=(?!\d+(,|$))/.test(logText) && !/\$|\.(pdf|jpe?g|png)\b|\/uploads\/|t5-reg/i.test(logText), logText);
		done(w);
	}
}

// ---------------------------------------------------------------------------
// §10 Every refusal audit row recorded above (L4): its subject and tail hold no
// dollar amount and no file name.
// ---------------------------------------------------------------------------
{
	ok("§10 refusal rows were recorded", ALL_REFUSALS.length >= 10, `${ALL_REFUSALS.length}`);
	ok("§10 ...some of them carry a count tail", ALL_REFUSALS.some((x) => /=\d/.test(String(x.tail || ""))));
	const FILE_OR_MONEY = /\$|\.(pdf|jpe?g|png)\b|\/uploads\/|t5-reg|t6-ins/i;
	const leaks = ALL_REFUSALS.filter((x) => FILE_OR_MONEY.test(String(x.subject || "")) || FILE_OR_MONEY.test(String(x.tail || "")));
	eq("§10 ...no subject or tail holds a $ or a file name", leaks.map((x) => [x.code, x.subject, x.tail]), []);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
