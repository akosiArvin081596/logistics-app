#!/usr/bin/env node
/**
 * Check 10 of the daily integrity check (lib/integrity-check.js
 * withheldLoadIds()): an open-month load whose Load ID holds broker contact (a
 * phone or an email inside it, or the row's own broker phone as bare digits), so
 * every role but Super Admin is served it withheld, is reported once per load to
 * ADMIN_NOTIFY_EMAIL (decision 5 of the Dispatcher raw Load ID plan, 2026-10-21).
 * Report only: no cell or load is changed.
 *
 * WHAT IS ASSERTED:
 *   §1 the check over one sheet: raised, a live open-month load whose Load ID
 *      would be withheld (a phone inside it, an email, the row's own broker phone
 *      as bare digits); not raised: a normal Load ID, a bare digit run that is
 *      not the row's phone, a cancelled load and a soft-deleted one (server.js's
 *      excludeDroppedLoads(), lifted); a load in a closed month is counted, never
 *      raised; one whose month can't be told is counted; the sheet is not mutated
 *   §2 the email and the log line: one line per load naming what other roles see
 *   §3 once per load: a recorded run names each load once
 *      (integrity_check_withheld_load_ids, created only when the first is named,
 *      in the run's transaction); the next run counts it in one note; a failed
 *      send records nothing; the print run (write false) writes nothing
 *   §4 no Load ID rule given: skipped and said so; the other checks still run
 *   §5 server.js and scripts/integrity-check.js hand the run the one Load ID rule
 *      (lib/broker-contact.js shownLoadIdOf() over BROKER_WITHHELD_RE)
 *
 * Hermetic: in-memory SQLite, made-up loads (555-01xx numbers, example.invalid).
 *   node scripts/test-integrity-withheld-load-ids.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const ic = require("../lib/integrity-check");
const bc = require("../lib/broker-contact");
const { closure } = require("./lib/server-lift");

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const periodDef = SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/);
if (!periodDef) { console.error("FAILED: EXPENSE_PERIOD_EXPR not found in server.js"); process.exit(1); }
const EXPENSE_PERIOD_EXPR = JSON.parse(periodDef[1]);
const withheldDef = SRC.match(/\nconst BROKER_WITHHELD_RE = (\/[^\n]*\/i);\n/);
if (!withheldDef) { console.error("FAILED: BROKER_WITHHELD_RE not found in server.js"); process.exit(1); }
const WITHHELD_RE = new Function(`return ${withheldDef[1]};`)();

const lifted = closure(SRC, {
	roots: ["loadRowAccountingMonths", "excludeDroppedLoads"],
	provided: ["getDeletedLoadIds"],
	denied: ["db", "getSheets", "sheets", "sendEmail", "transporter", "app", "io", "server", "SPREADSHEET_ID"],
});
const deletedReader = closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] });
const serverRequire = createRequire(path.join(ROOT, "server.js"));
const serverFor = (db) => new Function("getDeletedLoadIds", "require", `"use strict";\n${lifted.text}\nreturn { loadRowAccountingMonths, excludeDroppedLoads };`)(
	new Function("db", `"use strict";\n${deletedReader.text}\nreturn getDeletedLoadIds;`)(db), serverRequire);
function closedMonthsOf(db, server) {
	return (headers, row) => {
		const locked = new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period));
		const months = server.loadRowAccountingMonths(headers, headers.map((h) => row[h]));
		return months === null ? null : months.filter((mk) => locked.has(mk));
	};
}
// The server's Load ID rule (server.js passes the same call).
const loadIdShownOf = (row, raw) => (typeof bc.shownLoadIdOf === "function" ? bc.shownLoadIdOf(raw, { row, withheldRe: WITHHELD_RE }) : raw);

const ADMIN = "admin@example.test";
const W = bc.WITHHELD_TEXT;
const HEADERS = ["Job Status", "Load ID", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Driver", "Truck", "Owner ID", "Phone Number", "Email"];
function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
function sheet(rows) {
	return deepFreeze({
		headers: HEADERS.slice(),
		data: rows.map((r, i) => {
			const row = { _rowIndex: i + 2 };
			for (const h of HEADERS) row[h] = "";
			Object.assign(row, {
				"Job Status": r.status || "Dispatched", "Load ID": r.id, "Assigned Date": r.assigned === undefined ? "10/05/2026 9:00:00" : r.assigned,
				Driver: "Test Driver", Truck: "LogisX-#41", "Owner ID": "5", "Phone Number": r.phone || "", Email: r.email || "",
			});
			return row;
		}),
	});
}
const ROWS = [
	{ id: "QA-555-010-0161" },                                               // raised: a phone inside
	{ id: "agent.h4@example.invalid" },                                      // raised: an email
	{ id: "5550100163", phone: "555-010-0163" },                             // raised: the row's own phone as bare digits
	{ id: "5550100199", phone: "555-010-0142" },                             // bare digits, not the row's phone: kept
	{ id: "LX-1001" },                                                       // normal
	{ id: "QA-555-010-0170", assigned: "09/10/2026 8:00:00" },               // closed September: counted only
	{ id: "QA-555-010-0171", status: "Cancelled" },                          // cancelled
	{ id: "#QA-555-010-0172" },                                              // soft-deleted
	{ id: "QA-555-010-0173", assigned: "TBD" },                              // its month can't be told
];
function makeDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT NOT NULL DEFAULT 'd', type TEXT NOT NULL DEFAULT 'Fuel',
			amount REAL NOT NULL DEFAULT 10, date TEXT NOT NULL, status TEXT DEFAULT 'Pending',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
			status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, vin TEXT DEFAULT '', status TEXT DEFAULT 'Active');
		CREATE TABLE deleted_loads (load_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL DEFAULT '');
	`);
	db.prepare("INSERT INTO trucks (unit_number) VALUES ('LogisX-#41')").run();
	db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-09', 'locked')").run();
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('qa-555-010-0172')").run();
	return db;
}
function mailSpy(result = true) {
	const calls = [];
	const fn = async (to, subject, html) => { calls.push({ to, subject, html }); return result; };
	fn.calls = calls;
	return fn;
}
function quietLog() {
	const lines = [];
	return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}
async function run(db, jt, { now = "2026-10-15T12:00:30Z", sendEmail = mailSpy(), write = true, rule = true } = {}) {
	const server = serverFor(db);
	const log = quietLog();
	const result = await ic.runIntegrityCheck({
		db, now: new Date(now), write, sendEmail, to: ADMIN, log,
		readJobTracking: async () => jt,
		expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		appZone: "America/New_York",
		closedMonthsOf: closedMonthsOf(db, server), liveLoadRows: (s) => server.excludeDroppedLoads(s.data, s.headers),
		...(rule ? { loadIdShownOf } : {}),
	});
	return { result, log, sendEmail };
}
const tableName = () => ic.WITHHELD_LOAD_IDS_TABLE;
const tableExists = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName());
const reportedRows = (db) => (tableExists(db) ? db.prepare(`SELECT load_id FROM ${tableName()} ORDER BY load_id`).all().map((r) => r.load_id) : []);

(async () => {
	const present = typeof ic.withheldLoadIds === "function" && typeof ic.WITHHELD_LOAD_IDS_TABLE === "string" && typeof bc.shownLoadIdOf === "function";
	ok("§1 withheldLoadIds() and WITHHELD_LOAD_IDS_TABLE are exported, and lib/broker-contact.js shownLoadIdOf()", present);
	if (!present) return;

	console.log("§1 the check over one sheet");
	const db = makeDb();
	const jt = sheet(ROWS);
	const frozenText = JSON.stringify(jt);
	const server = serverFor(db);
	const r = ic.withheldLoadIds(db, jt, { closedMonthsOf: closedMonthsOf(db, server), liveLoadRows: (s) => server.excludeDroppedLoads(s.data, s.headers), loadIdShownOf });
	ok("§1 raised: the three open-month loads whose Load ID would be withheld, each with what other roles see",
		JSON.stringify(r.loads.map((l) => [l.id, l.shown])) === JSON.stringify([["QA-555-010-0161", `QA-${W}`], ["agent.h4@example.invalid", W], ["5550100163", W]]), r.loads);
	ok("§1 not raised: a normal ID, bare digits that are not the row's phone, a cancelled load, a soft-deleted load",
		!r.loads.some((l) => ["5550100199", "LX-1001", "QA-555-010-0171", "#QA-555-010-0172"].includes(l.id)));
	ok("§1 the closed-month load is counted only; the one whose month can't be told is counted", r.closed === 1 && r.unknownMonth === 1, r);
	ok("§1 the sheet object is not mutated", JSON.stringify(jt) === frozenText);

	console.log("§2 the email and the log line");
	const first = await run(db, jt);
	const text = first.result.mail ? first.result.mail.text : "";
	ok("§2 one email to ADMIN_NOTIFY_EMAIL with the section and its count",
		first.sendEmail.calls.length === 1 && /Load ID withheld from other roles \(3\)/.test(first.sendEmail.calls[0].html), first.sendEmail.calls.map((c) => c.html.slice(0, 200)));
	ok("§2 one line per load naming what other roles see",
		text.includes(`Load QA-555-010-0161: its Load ID holds broker contact, so every role but Super Admin sees it as "QA-${W}".`), text);
	ok("§2 the email says nothing of the closed-month load", !/QA-555-010-0170/.test(text));
	// The server log is read more widely than the admin inbox: it counts the loads
	// and names no withheld ID (the email names them).
	const logText = first.log.lines.join("\n");
	ok("§2 the log line counts the loads and names no withheld ID",
		/3 loads with a Load ID withheld from other roles/.test(logText) && !/QA-555-010-0161|agent\.h4@example\.invalid|5550100163/.test(logText), first.log.lines);

	console.log("§3 once per load");
	ok("§3 the recorded run named the three loads", JSON.stringify(reportedRows(db)) === JSON.stringify(["5550100163", "agent.h4@example.invalid", "qa-555-010-0161"]), reportedRows(db));
	const second = await run(db, jt, { now: "2026-10-16T12:00:30Z" });
	ok("§3 the next run names none again, sends nothing for them, and counts them in one note",
		second.result.report.withheldLoadIds.loads.length === 0 && second.sendEmail.calls.length === 0 &&
		second.result.report.notes.includes("3 loads whose Load ID is withheld from other roles, reported earlier, are still as reported."), second.result.report.notes);
	const dbFail = makeDb();
	const failed = await run(dbFail, jt, { sendEmail: mailSpy(false) });
	ok("§3 a failed send records nothing", failed.result.ok === false && reportedRows(dbFail).length === 0);
	const dbPrint = makeDb();
	const printed = await run(dbPrint, jt, { write: false });
	ok("§3 the print run names them and writes nothing", printed.result.report.withheldLoadIds.loads.length === 3 && !tableExists(dbPrint));
	const dbClean = makeDb();
	await run(dbClean, sheet([{ id: "LX-2001" }]));
	ok("§3 a run that names none creates no table", !tableExists(dbClean));
	const lib = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	const commitAt = lib.indexOf("function commitState(");
	const txBody = commitAt < 0 ? "" : lib.slice(lib.indexOf("db.transaction(() => {", commitAt), lib.indexOf("})();", commitAt));
	ok("§3 the loads are recorded in the run's one transaction", /markWithheldLoadId\.run\(/.test(txBody), txBody);

	console.log("§4 no Load ID rule");
	const dbNoRule = makeDb();
	const noRule = await run(dbNoRule, jt, { rule: false });
	ok("§4 skipped and said so; the run still completes",
		noRule.result.ok === true && noRule.result.report.withheldLoadIds.skipped === "no Load ID rule was given" &&
		noRule.result.report.notes.includes("Load IDs were not checked for broker contact: no Load ID rule was given."), noRule.result.report.notes);

	console.log("§5 one rule");
	ok("§5 server.js hands the daily run the Load ID rule over BROKER_WITHHELD_RE",
		SRC.includes("loadIdShownOf: (row, raw) => brokerContact.shownLoadIdOf(raw, { row, withheldRe: BROKER_WITHHELD_RE }),"));
	const cli = fs.readFileSync(path.join(ROOT, "scripts", "integrity-check.js"), "utf8");
	ok("§5 scripts/integrity-check.js hands it the server's rule too",
		cli.includes("loadIdShownOf: (row, raw) => brokerContact.shownLoadIdOf(raw, { row, withheldRe: server.BROKER_WITHHELD_RE }),"));
})().then(() => {
	if (failures.length) {
		console.error(`\n${passed} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n${passed} passed, 0 failed`);
}).catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
