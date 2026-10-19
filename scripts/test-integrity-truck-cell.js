#!/usr/bin/env node
/**
 * Check 9 of the daily integrity check (lib/integrity-check.js
 * unknownTruckLoads()): an open-month load whose Truck cell names no truck is
 * reported, once per load (the decision of 2026-10-16: "the daily integrity
 * check reports, once per load, an open-month load whose Truck cell names no
 * truck (report-only)"). Read-only: no cell, truck or load is changed.
 *
 * WHAT IS ASSERTED:
 *   §1 the check over one sheet: a live open-month load whose Truck cell
 *      matches no trucks row is raised; not raised: a Truck cell matching a
 *      truck across case and edge spaces, a blank Truck cell, a cancelled load
 *      and a soft-deleted one (server.js's excludeDroppedLoads(), lifted); a
 *      load in a closed month is never raised (counted for the log line only);
 *      one whose month can't be told is counted, not raised; a cell with a
 *      space inside that the truck's number doesn't have is raised, as pay
 *      can't resolve it either; the sheet object is never mutated
 *   §2 the email and the log line: the section, one line per load naming its
 *      Truck cell; the note for loads that can't be placed; the closed-month
 *      count in the log line and nowhere in the email
 *   §3 once per load: a recorded run names each load with its Truck cell once
 *      (integrity_check_unknown_trucks, created only when the first is named,
 *      in the run's transaction); the next run counts it in one note and sends
 *      nothing for it; a load whose cell now names a truck drops out; a new
 *      unknown name on the same load is named again; a failed send records
 *      nothing; the print run (write false) writes nothing
 *   §4 what it can't read: no trucks table, no closed-month rule, no
 *      cancelled-load rule, or no Truck column skips the check and says so, and
 *      the other checks still run
 *   §5 it only reads: the trucks, deleted loads and locks are byte-identical
 *      after every run
 *   §6 one rule, not a copy: truckUnitKey() answers as the pay paths read a
 *      Truck cell (server.js invoiceTruckVidReader()); the Truck column is
 *      found with the pay paths' regex; server.js and scripts/integrity-check.js
 *      hand the run the closed-month rule and excludeDroppedLoads(), the
 *      script over the server's own getDeletedLoadIds()
 *
 * Hermetic: in-memory SQLite, made-up loads and trucks; no network.
 *   node scripts/test-integrity-truck-cell.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const ic = require("../lib/integrity-check");
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

// The server's own accounting-month rule and live-load rule. The server's own
// getDeletedLoadIds() is lifted on its own over the test's database, as
// scripts/integrity-check.js lifts it; `require` resolves as it does in
// server.js (normalizeLoadId() is lib/ratecon-load.js's).
const lifted = closure(SRC, {
	roots: ["loadRowAccountingMonths", "excludeDroppedLoads"],
	provided: ["getDeletedLoadIds"],
	denied: ["db", "getSheets", "sheets", "sendEmail", "transporter", "app", "io", "server", "SPREADSHEET_ID"],
});
const deletedReader = closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] });
const serverRequire = createRequire(path.join(ROOT, "server.js"));
const serverFor = (db) => new Function("getDeletedLoadIds", "require", `"use strict";\n${lifted.text}\nreturn { loadRowAccountingMonths, excludeDroppedLoads };`)(
	new Function("db", `"use strict";\n${deletedReader.text}\nreturn getDeletedLoadIds;`)(db), serverRequire);

// The closed-month rule as server.js's integrityClosedMonthsOf() reads it.
function closedMonthsOf(db, server) {
	return (headers, row) => {
		const locked = new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period));
		const months = server.loadRowAccountingMonths(headers, headers.map((h) => row[h]));
		return months === null ? null : months.filter((mk) => locked.has(mk));
	};
}

const ADMIN = "admin@example.test";
const HEADERS = ["Job Status", "Load ID", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Driver", "Truck", "Owner ID"];

function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
// Job Tracking as getJobTrackingCached() hands it over, frozen (the cache is shared).
function sheet(rows, headers = HEADERS) {
	return deepFreeze({
		headers: headers.slice(),
		data: rows.map((r, i) => {
			const row = { _rowIndex: i + 2 };
			for (const h of headers) row[h] = "";
			Object.assign(row, {
				"Job Status": r.status || "Dispatched", "Load ID": r.id, "Pickup Appointment": r.pickup || "",
				"Assigned Date": r.assigned === undefined ? "10/05/2026 9:00:00" : r.assigned, Driver: "Test Driver", "Owner ID": "5",
			});
			if (headers.includes("Truck")) row.Truck = r.truck === undefined ? "LogisX-#41" : r.truck;
			return row;
		}),
	});
}
const ROWS = [
	{ id: "LX-1001", truck: "LogisX-#X" },                                  // raised: names no truck
	{ id: "LX-1002", truck: " logisx #456 " },                               // a truck, across case and edge spaces
	{ id: "LX-1003", truck: "Old-Unit-7", assigned: "09/10/2026 8:00:00" },  // closed September: never raised
	{ id: "LX-1004", truck: "Ghost-1", status: "Cancelled" },                // cancelled
	{ id: "#LX-1005", truck: "Ghost-2" },                                    // soft-deleted (stored as "lx-1005")
	{ id: "LX-1006", truck: "" },                                            // blank: names nothing
	{ id: "LX-1007", truck: "LogisX-#41" },                                  // a truck
	{ id: "LX-1008", truck: "Mystery-9", assigned: "TBD" },                  // its month can't be told
	{ id: "LX-1009", truck: "Mystery-9" },                                   // raised
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
	db.prepare("INSERT INTO trucks (unit_number) VALUES ('LogisX-#41'), ('LogisX #456'), ('Logisx-#91')").run();
	db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-09', 'locked'), ('2026-08', 'unlocked')").run();
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('lx-1005')").run();
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
async function run(db, jt, { now = "2026-10-15T12:00:30Z", sendEmail = mailSpy(), write = true, rules = true } = {}) {
	const server = serverFor(db);
	const log = quietLog();
	const result = await ic.runIntegrityCheck({
		db, now: new Date(now), write, sendEmail, to: ADMIN, log,
		readJobTracking: async () => jt,
		expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		appZone: "America/New_York",
		...(rules ? { closedMonthsOf: closedMonthsOf(db, server), liveLoadRows: (s) => server.excludeDroppedLoads(s.data, s.headers) } : {}),
	});
	return { result, log, sendEmail };
}
const tableExists = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ic.UNKNOWN_TRUCKS_TABLE);
const reportedRows = (db) => (tableExists(db)
	? db.prepare(`SELECT load_id, truck_key FROM ${ic.UNKNOWN_TRUCKS_TABLE} ORDER BY load_id, truck_key`).all()
	: []);
const snapshot = (db) => JSON.stringify(["trucks", "deleted_loads", "period_locks"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

(async () => {
	const present = typeof ic.unknownTruckLoads === "function" && typeof ic.UNKNOWN_TRUCKS_TABLE === "string" && typeof ic.truckUnitKey === "function";
	ok("§1 unknownTruckLoads(), truckUnitKey() and UNKNOWN_TRUCKS_TABLE are exported", present);
	if (!present) return;

	console.log("§1 the check over one sheet");
	const db = makeDb();
	const before = snapshot(db);
	const jt = sheet(ROWS);
	const frozenText = JSON.stringify(jt);
	const server = serverFor(db);
	const r = ic.unknownTruckLoads(db, jt, { closedMonthsOf: closedMonthsOf(db, server), liveLoadRows: (s) => server.excludeDroppedLoads(s.data, s.headers) });
	const ids = r.loads.map((l) => l.id);
	ok("§1 raised: the two open-month loads whose Truck cell names no truck", ids.join() === "LX-1001,LX-1009", r);
	ok("§1 each carries its Truck cell as written and its key", r.loads[0] && r.loads[0].truck === "LogisX-#X" && r.loads[1] && r.loads[1].truck === "Mystery-9" && r.loads[1].truckKey === "mystery-9", r.loads);
	ok("§1 not raised: a truck matched across case and edge spaces, a blank cell, a cancelled load, a soft-deleted load, a known truck",
		!["LX-1002", "LX-1004", "#LX-1005", "LX-1006", "LX-1007"].some((id) => ids.includes(id)));
	{
		// A space inside the cell that the truck's number doesn't have: the pay
		// paths (trimmed, case aside) can't resolve it to LogisX #456, so it is named.
		const spaced = sheet([{ id: "LX-3001", truck: "LogisX  #456" }, { id: "LX-3002", truck: "  LOGISX #456  " }]);
		const s = ic.unknownTruckLoads(db, spaced, { closedMonthsOf: closedMonthsOf(db, server), liveLoadRows: (x) => server.excludeDroppedLoads(x.data, x.headers) });
		ok("§1 a cell with a space inside the truck's number doesn't have is raised; the same number in another case with edge spaces is not",
			s.loads.map((l) => `${l.id}:${l.truckKey}`).join() === "LX-3001:logisx  #456", s.loads);
	}
	ok("§1 the closed-month load is never raised, only counted", !ids.includes("LX-1003") && r.closed === 1, r);
	ok("§1 the load whose month can't be told is counted, not raised", !ids.includes("LX-1008") && r.unknownMonth === 1, r);
	ok("§1 nothing reported earlier, nothing skipped", r.reportedOpen === 0 && r.skipped === "", r);
	ok("§1 the sheet object is not mutated", JSON.stringify(jt) === frozenText);

	console.log("§2 the email and the log line");
	const first = await run(db, jt);
	const mail = first.sendEmail.calls[0];
	ok("§2 one email to ADMIN_NOTIFY_EMAIL", first.sendEmail.calls.length === 1 && mail.to === ADMIN, first.sendEmail.calls.map((c) => c.to));
	ok("§2 the section title and its count", /Truck cell names no truck \(2\)/.test(mail.html), mail.html);
	const text = first.result.mail.text;
	ok("§2 one line per load naming its Truck cell",
		text.includes('Load LX-1001: its Truck cell reads "LogisX-#X", which matches no truck on the Trucks page.') &&
		text.includes('Load LX-1009: its Truck cell reads "Mystery-9", which matches no truck on the Trucks page.'), text);
	ok("§2 the note for the load that can't be placed",
		text.includes("1 load whose Truck cell names no truck could not be placed in an open or a closed month (a date that can't be placed, or closed months that can't be read), so it was not raised."), text);
	ok("§2 the email says nothing of the closed-month load", !/LX-1003|Old-Unit-7|closed month, final as recorded/.test(text) && !/LX-1003|Old-Unit-7/.test(mail.html), text);
	const line = first.log.lines.join("\n");
	ok("§2 the log line names the loads and counts what was not raised",
		/Truck cell names no truck: load LX-1001, LX-1009/.test(line) &&
		/truck cells not raised: 1 in a closed month, 1 whose month can't be told/.test(line), line);

	console.log("§3 once per load");
	ok("§3 the recorded run named both loads with their Truck cells",
		JSON.stringify(reportedRows(db)) === JSON.stringify([{ load_id: "lx-1001", truck_key: "logisx-#x" }, { load_id: "lx-1009", truck_key: "mystery-9" }]), reportedRows(db));
	const second = await run(db, jt, { now: "2026-10-16T12:00:30Z" });
	ok("§3 the next run names neither again and sends nothing for them",
		second.result.report.unknownTrucks.loads.length === 0 && second.sendEmail.calls.length === 0, second.result.report.unknownTrucks);
	ok("§3 ...and counts them in one note and in the log line",
		second.result.report.notes.includes("2 loads whose Truck cell names no truck, reported earlier, are still as reported.") &&
		/2 such loads reported earlier/.test(second.log.lines.join("\n")), [second.result.report.notes, second.log.lines]);
	const renamed = sheet(ROWS.map((x) => (x.id === "LX-1001" ? { ...x, truck: "logisx-#91" } : x.id === "LX-1009" ? { ...x, truck: "Mystery-10" } : x)));
	const third = await run(db, renamed, { now: "2026-10-17T12:00:30Z" });
	ok("§3 a load whose cell now names a truck drops out; a new unknown name on the same load is named again",
		third.result.report.unknownTrucks.loads.map((l) => `${l.id}:${l.truck}`).join() === "LX-1009:Mystery-10" &&
		third.result.report.unknownTrucks.reportedOpen === 0 && third.sendEmail.calls.length === 1, third.result.report.unknownTrucks);
	const respelled = sheet(ROWS.map((x) => (x.id === "LX-1009" ? { ...x, truck: "  MYSTERY-10 " } : x)));
	const fourth = await run(db, respelled, { now: "2026-10-18T12:00:30Z" });
	ok("§3 the same name in another case or spacing is not named again",
		fourth.result.report.unknownTrucks.loads.length === 0 && fourth.result.report.unknownTrucks.reportedOpen >= 1, fourth.result.report.unknownTrucks);

	const dbFail = makeDb();
	const failed = await run(dbFail, jt, { sendEmail: mailSpy(false) });
	ok("§3 a failed send records nothing, so the next run names them again",
		failed.result.ok === false && reportedRows(dbFail).length === 0, reportedRows(dbFail));
	const retried = await run(dbFail, jt);
	ok("§3 ...the retry names both", retried.result.report.unknownTrucks.loads.length === 2 && reportedRows(dbFail).length === 2);
	const dbPrint = makeDb();
	const printed = await run(dbPrint, jt, { write: false });
	ok("§3 the print run (write false) names them and writes nothing",
		printed.result.report.unknownTrucks.loads.length === 2 && !tableExists(dbPrint));
	const dbClean = makeDb();
	await run(dbClean, sheet([{ id: "LX-2001", truck: "LogisX-#41" }]));
	ok("§3 a run that names none creates no table", !tableExists(dbClean));
	const lib = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	const commitAt = lib.indexOf("function commitState(");
	const txBody = commitAt < 0 ? "" : lib.slice(lib.indexOf("db.transaction(() => {", commitAt), lib.indexOf("})();", commitAt));
	ok("§3 the loads are recorded in the run's one transaction", /markUnknownTruck\.run\(/.test(txBody), txBody);

	console.log("§4 what it can't read");
	{
		const dbNoTrucks = makeDb();
		dbNoTrucks.exec("DROP TABLE trucks");
		dbNoTrucks.prepare("INSERT INTO expenses (id, status, date, created_at) VALUES (7, 'Approved', '2026-10-01', '2026-10-01 10:00:00')").run();
		const res = await run(dbNoTrucks, jt);
		ok("§4 no trucks table: skipped and said so; the receipt check still reports",
			res.result.report.unknownTrucks.skipped === "the database has no trucks table" &&
			res.result.report.notes.includes("Truck cells were not checked: the database has no trucks table.") &&
			/#7/.test(res.result.mail.html) && /truck cells not checked \(the database has no trucks table\)/.test(res.log.lines.join("\n")), res.result.report.notes);
	}
	{
		const noRule = ic.unknownTruckLoads(makeDb(), jt, {});
		ok("§4 no closed-month rule: skipped and said so", noRule.loads.length === 0 && noRule.skipped === "no closed-month rule was given", noRule);
		const dbx = makeDb();
		const noLive = ic.unknownTruckLoads(dbx, jt, { closedMonthsOf: closedMonthsOf(dbx, serverFor(dbx)) });
		ok("§4 no cancelled-load rule: skipped and said so", noLive.loads.length === 0 && noLive.skipped === "no cancelled-load rule was given", noLive);
		const noCol = sheet(ROWS, HEADERS.filter((h) => h !== "Truck"));
		const s = serverFor(dbx);
		const noTruckCol = ic.unknownTruckLoads(dbx, noCol, { closedMonthsOf: closedMonthsOf(dbx, s), liveLoadRows: (x) => s.excludeDroppedLoads(x.data, x.headers) });
		ok("§4 no Truck column: skipped and said so", noTruckCol.loads.length === 0 && noTruckCol.skipped === "Job Tracking has no Load ID or Truck column", noTruckCol);
		const dbRun = makeDb();
		const res = await run(dbRun, noCol);
		ok("§4 ...and the daily run still completes", res.result.ok === true, res.result);
	}

	console.log("§5 it only reads");
	ok("§5 the trucks, deleted loads and locks are unchanged by the check and four recorded runs", snapshot(db) === before);
	ok("§5 the lib writes no truck, deleted-load or lock row",
		!/\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(trucks|deleted_loads|period_locks)\b/i.test(lib));

	console.log("§6 one rule, not a copy");
	// The pay paths' own read of a Truck cell, taken from server.js's
	// invoiceTruckVidReader() (the weekly invoice reads the cell the same way).
	const readerAt = SRC.indexOf("\nfunction invoiceTruckVidReader(headers) {");
	const readerSrc = readerAt < 0 ? "" : SRC.slice(readerAt, SRC.indexOf("\n}\n", readerAt + 1));
	const payRead = readerSrc.match(/const unit = truckCol \? (String\(row\[truckCol\] \|\| ""\)\.trim\(\)\.toLowerCase\(\)) : "";/);
	ok("§6 the pay paths' read of a Truck cell found in invoiceTruckVidReader()", !!payRead, readerSrc.slice(0, 200));
	if (payRead) {
		const payKey = new Function("row", "truckCol", `return ${payRead[1]};`);
		const samples = ["LogisX-#41", "  logisx #456 ", "LogisX  #456", "LogisX\t#456", "", "x"];
		ok("§6 truckUnitKey() answers as the pay paths read a Truck cell on every sample",
			samples.every((s) => ic.truckUnitKey(s) === payKey({ Truck: s }, "Truck")), samples.map((s) => [ic.truckUnitKey(s), payKey({ Truck: s }, "Truck")]));
	}
	ok("§6 the weekly invoice reads the Truck cell the same way",
		/const truckUnit = truckCol \? \(load\[truckCol\] \|\| ""\)\.trim\(\)\.toLowerCase\(\) : "";/.test(SRC));
	const colRe = SRC.match(/\nconst ELD_LINK_TRUCK_COL_RE = (\/[^\n]*\/i);\n/);
	ok("§6 the check finds the Truck column with the pay paths' regex", !!colRe && ic.TRUCK_COL_RE.source === new Function(`return ${colRe[1]};`)().source && ic.TRUCK_COL_RE.flags === "i",
		colRe && colRe[1]);
	ok("§6 server.js hands the daily run excludeDroppedLoads() as its cancelled-load rule",
		SRC.includes("liveLoadRows: (sheet) => excludeDroppedLoads(sheet.data, sheet.headers),"));
	const cli = fs.readFileSync(path.join(ROOT, "scripts", "integrity-check.js"), "utf8");
	ok("§6 scripts/integrity-check.js hands it the server's excludeDroppedLoads() too",
		cli.includes("liveLoadRows: (sheet) => server.excludeDroppedLoads(sheet.data, sheet.headers),"));
	ok("§6 ...over the server's own getDeletedLoadIds(), with no read of the deleted loads of its own",
		cli.includes('closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] })') && !/deleted_loads/.test(cli));
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
