#!/usr/bin/env node
/**
 * The daily integrity check (lib/integrity-check.js, the server.js block that
 * schedules it, and scripts/integrity-check.js --print).
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 checks 1 and 2 over the job's own state table: the first run takes a
 *      baseline (recorded, said in its log line, nothing reported); a Pickup
 *      Appointment that goes blank is reported once; an Assigned Date that
 *      changes is reported once, from and to; a first Assigned Date, a load
 *      that leaves the sheet and a new load are not findings; a Job Tracking
 *      read without the columns stops the run before anything is written; the
 *      sheet object handed in is never mutated
 *   §2 check 3: a new n8n Assigned Date is matched to the rate-con email's own
 *      Date header to the second: Eastern is fine, Central (n8n's zone until
 *      2026-10-09) and UTC are reported, no matching email is "unmatched" and
 *      never reported, nor is a stamp equal to one email's Eastern time and
 *      another's offset time; a stamp in the repeated hour of 2026-11-01 is Eastern,
 *      the app's own stamp shape and date-only values are not checked, the
 *      shape this Node's toLocaleString produces parses; no mailbox, an
 *      unreadable mailbox and the baseline skip check 3 and the rest still run
 *   §3 check 4: an approved receipt submitted more than 7 days ago on no live
 *      invoice is reported; one on an invoice, one only on a deleted invoice,
 *      a rejected or pending one, a recent one, and one booked to a closed
 *      month are not (a reopened month is open); each receipt is named once
 *      (the job's reported list): later runs count those named before in one
 *      line, a late approval or an invoice deleted later is named on the next
 *      run, and a failed send records nothing (§3b)
 *   §4 the schedule: 8:00 AM US Eastern on the business clock, across the end
 *      of daylight time on 2026-11-01 (12:00 UTC before, 13:00 UTC after), the
 *      start of it in March, once per day; a failed run is retried after 15
 *      minutes, at most 3 times a day
 *   §5 email: only to the inbox it is given (ADMIN_NOTIFY_EMAIL in server.js),
 *      one email per run with findings, none when clean; unset, nothing is sent
 *      and the log says so; a failed send records nothing so the run repeats
 *      (a failed first run never says the baseline was taken); a clean run
 *      logs exactly one line; it writes no table but its own
 *   §6 server.js: the kill switch defaults on; the job asks startsJob(), so a
 *      replica starts nothing; outside one it ticks every minute and catches up
 *      after boot, reads Job Tracking through getJobTrackingCached(), and mails
 *      ADMIN_NOTIFY_EMAIL with the shared sendEmail; .env.example documents it
 *   §7 scripts/integrity-check.js: refuses without --print, --db or a named
 *      sheet (no default; --sheet-id=env with no SPREADSHEET_ID is a refusal,
 *      exit 2), opens the database read-only, prints what it would
 *      send, writes nothing (the file is byte-identical, no state table is
 *      created) and never sends mail
 *
 * Hermetic: in-memory SQLite and a mkdtemp directory; no network.
 *   node scripts/test-integrity-check.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

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

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

// The server's own EXPENSE_PERIOD_EXPR, read from server.js, so check 4 books a
// receipt to the month every settlement path books it to.
const periodDef = SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/);
if (!periodDef) { console.error("FAILED: EXPENSE_PERIOD_EXPR not found in server.js"); process.exit(1); }
const EXPENSE_PERIOD_EXPR = JSON.parse(periodDef[1]);

const ADMIN = "admin@example.test";
const HEADERS = ["Job Status", "Load ID", "Pickup Info", "Pickup Appointment", "Assigned Date", "Driver"];

function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
// Job Tracking as getJobTrackingCached() hands it over: { headers, data } with
// header-keyed rows, frozen so a mutation throws (the cache is shared).
function jt(rows) {
	return deepFreeze({
		headers: HEADERS.slice(),
		data: rows.map((r, i) => ({
			_rowIndex: i + 2,
			"Job Status": "Dispatched", "Pickup Info": "", Driver: "",
			"Load ID": r.id, "Pickup Appointment": r.pickup || "", "Assigned Date": r.assigned || "",
		})),
	});
}
function makeDb() {
	const db = new Database(":memory:");
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
function addExpense(db, { id, status, date, createdAt, postedPeriod = "", type = "Fuel", amount = 42.5 }) {
	db.prepare("INSERT INTO expenses (id, status, date, created_at, posted_period, type, amount) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(id, status, date, createdAt, postedPeriod, type, amount);
}
function sqliteStamp(ms) { return new Date(ms).toISOString().replace("T", " ").slice(0, 19); }
function captureLog() {
	const lines = [];
	return {
		lines,
		log: (...a) => lines.push({ level: "log", text: a.join(" ") }),
		info: (...a) => lines.push({ level: "log", text: a.join(" ") }),
		warn: (...a) => lines.push({ level: "warn", text: a.join(" ") }),
		error: (...a) => lines.push({ level: "error", text: a.join(" ") }),
	};
}
function mailSpy(result = true) {
	const calls = [];
	const fn = async (to, subject, html, ...rest) => { calls.push({ to, subject, html, rest }); return typeof result === "function" ? result(calls.length) : result; };
	fn.calls = calls;
	return fn;
}
function tables(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
}
function businessRows(db) {
	return JSON.stringify(["expenses", "invoices", "period_locks"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
}
async function run(db, sheet, extra = {}) {
	const logger = extra.logger || captureLog();
	const result = await ic.runIntegrityCheck({
		db,
		write: true,
		now: extra.now || new Date("2026-10-10T12:00:30Z"),
		readJobTracking: async () => sheet,
		readRateConEmails: extra.readRateConEmails === undefined ? null : extra.readRateConEmails,
		expensePeriodExpr: EXPENSE_PERIOD_EXPR,
		sendEmail: extra.sendEmail === undefined ? mailSpy() : extra.sendEmail,
		to: extra.to === undefined ? ADMIN : extra.to,
		log: logger,
		appZone: "America/New_York",
	});
	return { result, logger };
}
function stateRow(db, key) {
	return db.prepare(`SELECT * FROM ${ic.STATE_TABLE} WHERE load_id = ?`).get(key);
}

async function section1() {
	console.log("§1 checks 1 and 2 (Pickup Appointment blanked, Assigned Date changed)");
	const db = makeDb();
	const s0 = jt([
		{ id: "570698749", pickup: "10/12/2026 08:00", assigned: "10/8/2026, 9:33:24 AM" },
		{ id: "#L-200", pickup: "10/13/2026", assigned: "" },
		{ id: "300", pickup: "10/14/2026", assigned: "10/9/2026" },
	]);
	const spy = mailSpy();
	const first = await run(db, s0, { sendEmail: spy, now: new Date("2026-10-09T12:00:30Z") });
	ok("first run: baseline", first.result.ok && first.result.baseline === true, first.result);
	ok("first run: every load recorded", db.prepare(`SELECT COUNT(*) AS c FROM ${ic.STATE_TABLE}`).get().c === 3);
	ok("first run: its log line says it took a baseline", first.logger.lines.length === 1 && /baseline/i.test(first.logger.lines[0].text), first.logger.lines);
	ok("first run: nothing to report, no email", spy.calls.length === 0);
	const row = stateRow(db, "l-200");
	ok("state keys a load like deduplicateLoads (trimmed, lower case, no leading #)", !!row && row.pickup_appointment === "10/13/2026");
	ok("state records first_seen_at and last_seen_at", !!row && row.first_seen_at === "2026-10-09T12:00:30.000Z" && row.last_seen_at === "2026-10-09T12:00:30.000Z", row);
	ok("lastRunAt() reads the last run off the state table", ic.lastRunAt(db) === "2026-10-09T12:00:30.000Z", ic.lastRunAt(db));

	const s1 = jt([
		{ id: "570698749", pickup: "", assigned: "10/8/2026, 9:33:24 AM" },
		{ id: "#L-200", pickup: "10/13/2026", assigned: "10/9/2026, 7:00:00 AM" },
		{ id: "300", pickup: "10/14/2026", assigned: "10/10/2026" },
		{ id: "400", pickup: "", assigned: "" },
	]);
	const spy2 = mailSpy();
	const second = await run(db, s1, { sendEmail: spy2 });
	const r2 = second.result.report;
	ok("a Pickup Appointment that went blank is reported", r2.pickupBlanked.length === 1 && r2.pickupBlanked[0].id === "570698749" && r2.pickupBlanked[0].was === "10/12/2026 08:00", r2.pickupBlanked);
	ok("an Assigned Date that changed is reported, from and to", r2.assignedChanged.length === 1 && r2.assignedChanged[0].id === "300" &&
		r2.assignedChanged[0].was === "10/9/2026" && r2.assignedChanged[0].assigned === "10/10/2026", r2.assignedChanged);
	ok("a first Assigned Date (blank before) is not a change", !r2.assignedChanged.some((x) => x.id === "#L-200"));
	ok("a new load is not a finding", ![...r2.pickupBlanked, ...r2.assignedChanged].some((x) => x.id === "400"));
	ok("one email for the run", spy2.calls.length === 1);
	ok("the email names each load and what is wrong",
		spy2.calls.length === 1 && /570698749/.test(spy2.calls[0].html) && /Pickup Appointment/.test(spy2.calls[0].html) && /300/.test(spy2.calls[0].html) && /10\/9\/2026/.test(spy2.calls[0].html));
	ok("first_seen_at is kept, last_seen_at moves", stateRow(db, "300").first_seen_at === "2026-10-09T12:00:30.000Z" && stateRow(db, "300").last_seen_at === "2026-10-10T12:00:30.000Z");

	const s2 = jt([
		{ id: "#L-200", pickup: "10/13/2026", assigned: "10/9/2026, 7:00:00 AM" },
		{ id: "300", pickup: "10/14/2026", assigned: "10/10/2026" },
		{ id: "400", pickup: "", assigned: "" },
		{ id: "570698749", pickup: "", assigned: "10/8/2026, 9:33:24 AM" },
	]);
	const spy3 = mailSpy();
	const third = await run(db, s2, { sendEmail: spy3, now: new Date("2026-10-11T12:00:30Z") });
	ok("each change is reported once: the next run is clean", third.result.report.findings === 0 && spy3.calls.length === 0, third.result.report);
	const s3 = jt([{ id: "300", pickup: "10/14/2026", assigned: "10/10/2026" }]);
	const fourth = await run(db, s3, { now: new Date("2026-10-12T12:00:30Z") });
	ok("a load that left the sheet (archived, deleted) is not a finding", fourth.result.report.findings === 0, fourth.result.report);
	ok("...and keeps its state row", !!stateRow(db, "570698749"));
	const s4 = jt([{ id: "300", pickup: "10/14/2026", assigned: "" }]);
	const fifth = await run(db, s4, { now: new Date("2026-10-13T12:00:30Z") });
	ok("an Assigned Date cleared after it was set is a change", fifth.result.report.assignedChanged.length === 1 && fifth.result.report.assignedChanged[0].assigned === "", fifth.result.report.assignedChanged);

	// A read without the columns must stop the run, not report every load blank.
	const before = db.prepare(`SELECT * FROM ${ic.STATE_TABLE} ORDER BY load_id`).all();
	let threw = null;
	try {
		await run(db, deepFreeze({ headers: ["Load ID", "Assigned Date"], data: [{ "Load ID": "300", "Assigned Date": "x" }] }));
	} catch (e) { threw = e; }
	ok("a Job Tracking read without Pickup Appointment stops the run", !!threw && /Pickup Appointment/.test(threw.message), threw && threw.message);
	ok("...and writes nothing", JSON.stringify(db.prepare(`SELECT * FROM ${ic.STATE_TABLE} ORDER BY load_id`).all()) === JSON.stringify(before));
	ok("jobTrackingLoads() keeps the bottom row of a duplicated load (deduplicateLoads' rule)",
		ic.jobTrackingLoads({ headers: HEADERS, data: [{ "Load ID": "9", "Pickup Appointment": "a", "Assigned Date": "" }, { "Load ID": " 9 ", "Pickup Appointment": "b", "Assigned Date": "" }] })
			.map((l) => l.pickup).join() === "b");
}

async function section2() {
	console.log("§2 check 3 (new n8n Assigned Dates not in Eastern)");
	const zone = "America/New_York";
	const P = ic.n8nStampParts;
	ok("n8n's shape parses (AM)", JSON.stringify(P("10/6/2026, 9:21:43 AM")) === JSON.stringify({ year: 2026, month: 10, day: 6, hour: 9, minute: 21, second: 43 }), P("10/6/2026, 9:21:43 AM"));
	ok("n8n's shape parses (12 PM is noon, 12 AM is midnight)", P("10/6/2026, 12:05:00 PM").hour === 12 && P("10/6/2026, 12:05:00 AM").hour === 0);
	ok("a narrow no-break space before AM/PM parses", !!P("10/6/2026, 9:21:43 AM"));
	const produced = new Date("2026-10-06T13:21:43Z").toLocaleString("en-US", { timeZone: zone });
	ok(`the shape this Node's toLocaleString produces parses (${JSON.stringify(produced)})`, JSON.stringify(P(produced)) === JSON.stringify({ year: 2026, month: 10, day: 6, hour: 9, minute: 21, second: 43 }));
	ok("the app's own stamp (appStamp, 24 h, no comma) is not n8n's", P("10/09/2026 9:21:43") === null);
	ok("a date-only value and an ISO value are not n8n's", P("10/9/2026") === null && P("2026-10-09T13:21:43.000Z") === null && P("") === null);

	const emails = [
		{ subject: "Load 1", date: "Fri, 09 Oct 2026 09:21:43 -0400", fromAddress: "broker@example.test" },
		{ subject: "Load 2", date: "Fri, 9 Oct 2026 09:30:10 -0400 (EDT)", fromAddress: "broker@example.test" },
		{ subject: "Load 3", date: "Fri, 09 Oct 2026 13:40:00 +0000", fromAddress: "broker@example.test" },
		{ subject: "Load 6", date: "Fri, 09 Oct 2026 09:55:00 -0400", fromAddress: "broker@example.test" },
		{ subject: "Load 7", date: "Sun, 01 Nov 2026 01:30:00 -0500", fromAddress: "broker@example.test" },
		{ subject: "unreadable", date: "not a date", fromAddress: "broker@example.test" },
	];
	const stamps = [
		{ id: "1", assigned: "10/9/2026, 9:21:43 AM" },
		{ id: "2", assigned: "10/9/2026, 8:30:10 AM" },
		{ id: "3", assigned: "10/9/2026, 1:40:00 PM" },
		{ id: "4", assigned: "10/9/2026, 11:11:11 AM" },
		{ id: "5", assigned: "10/09/2026 9:50:00" },
		{ id: "6", assigned: "10/9/2026, 9:55:00 AM" },
		{ id: "7", assigned: "11/1/2026, 1:30:00 AM" },
	];
	const c = ic.classifyStamps(stamps, emails, { appZone: zone });
	ok("Eastern stamps matching their email are fine", c.ok.map((x) => x.id).sort().join() === "1,6,7", c.ok.map((x) => x.id));
	const wrong = Object.fromEntries(c.wrong.map((w) => [w.id, w]));
	ok("a Central stamp (n8n's zone until 2026-10-09) is reported: UTC-05:00, 1 hour behind Eastern", !!wrong["2"] && wrong["2"].offset === "UTC-05:00" && wrong["2"].hoursBehind === 1 && /1 hour behind Eastern/.test(wrong["2"].label), wrong["2"]);
	ok("...with the email's time in Eastern", !!wrong["2"] && /9:30:10/.test(wrong["2"].eastern), wrong["2"]);
	ok("a UTC stamp is reported: 4 hours ahead of Eastern in October", !!wrong["3"] && wrong["3"].offset === "UTC+00:00" && wrong["3"].hoursBehind === -4 && /4 hours ahead of Eastern/.test(wrong["3"].label), wrong["3"]);
	const winter = ic.classifyStamps([{ id: "w", assigned: "12/1/2026, 8:00:00 AM" }], [{ date: "Tue, 01 Dec 2026 09:00:00 -0500" }], { appZone: zone });
	ok("in winter a Central stamp is UTC-06:00, still 1 hour behind Eastern", winter.wrong.length === 1 && winter.wrong[0].offset === "UTC-06:00" && winter.wrong[0].hoursBehind === 1, winter);
	const odd = ic.classifyStamps([{ id: "o", assigned: "10/9/2026, 9:21:43 AM" }], [{ date: "Fri, 09 Oct 2026 09:21:43 +0530" }], { appZone: zone });
	ok("an offset no US zone or UTC has is unmatched, never reported", odd.unmatched.length === 1 && odd.wrong.length === 0, odd);
	ok("a stamp no email matches is unmatched, never reported", c.unmatched.map((x) => x.id).join() === "4" && !wrong["4"], c.unmatched);
	ok("the app's own stamp shape is not checked", c.notN8n === 1 && ![...c.ok, ...c.wrong, ...c.unmatched].some((x) => x.id === "5"));
	ok("a stamp in the repeated hour of 2026-11-01 (1:30 AM EST) is Eastern, not Central", c.ok.some((x) => x.id === "7") && !wrong["7"]);
	// One email's Eastern time and another's Central time can be the same wall
	// clock (emails exactly an hour apart): which one n8n used is unknown.
	const both = ic.classifyStamps([{ id: "b", assigned: "10/9/2026, 9:21:43 AM" }],
		[{ date: "Fri, 09 Oct 2026 09:21:43 -0400" }, { date: "Fri, 09 Oct 2026 10:21:43 -0400" }], { appZone: zone });
	ok("a stamp equal to one email's Eastern time and another's offset time is unmatched, neither fine nor reported",
		both.unmatched.map((x) => x.id).join() === "b" && both.ok.length === 0 && both.wrong.length === 0, both);
	const eastOnly = ic.classifyStamps([{ id: "e", assigned: "10/9/2026, 9:21:43 AM" }],
		[{ date: "Fri, 09 Oct 2026 09:21:43 -0400" }, { date: "Fri, 09 Oct 2026 10:21:44 -0400" }], { appZone: zone });
	ok("...one second apart is no longer ambiguous: fine", eastOnly.ok.length === 1, eastOnly);

	// Through the runner: only NEW stamps (a new load, a changed Assigned Date) are checked.
	const db = makeDb();
	await run(db, jt([{ id: "1", pickup: "p", assigned: "" }, { id: "2", pickup: "p", assigned: "10/8/2026, 8:00:00 AM" }]), { now: new Date("2026-10-09T12:00:30Z") });
	let asked = null;
	const reader = async (opts) => { asked = opts; return emails; };
	const { result, logger } = await run(db, jt([
		{ id: "1", pickup: "p", assigned: "10/9/2026, 9:21:43 AM" },
		{ id: "2", pickup: "p", assigned: "10/9/2026, 8:30:10 AM" },
		{ id: "8", pickup: "p", assigned: "10/9/2026, 2:22:22 PM" },
	]), { readRateConEmails: reader });
	const z = result.report.zone;
	ok("the runner checks the new and changed stamps against the mailbox", !!z && z.checked === 3 && z.ok.length === 1 && z.wrong.length === 1 && z.unmatched.length === 1, z);
	ok("the mailbox is read back to the previous run, with slack", !!asked && asked.sinceDays >= 2 && asked.sinceDays <= 14, asked);
	ok("a stamp that is not Eastern is in the email", result.emailed === true && /UTC-05:00, 1 hour behind Eastern/.test(result.mail.html), result.mail && result.mail.text);
	ok("the log line counts what it could not match", logger.lines.some((l) => /unmatched/i.test(l.text)), logger.lines);

	const db2 = makeDb();
	await run(db2, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const noMailbox = await run(db2, jt([{ id: "1", pickup: "p", assigned: "10/9/2026, 9:21:43 AM" }]), { readRateConEmails: null });
	ok("no mailbox: check 3 is skipped and says so", /skipped/.test(noMailbox.result.report.zone.skipped || "") || !!noMailbox.result.report.zone.skipped, noMailbox.result.report.zone);
	ok("...and the run still completes", noMailbox.result.ok === true);
	const db3 = makeDb();
	addExpense(db3, { id: 1, status: "Approved", date: "2026-09-25", createdAt: "2026-09-25 10:00:00" });
	addExpense(db3, { id: 2, status: "Approved", date: "2026-10-02", createdAt: "2026-10-02 20:00:00" });
	await run(db3, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const broken = await run(db3, jt([{ id: "1", pickup: "p", assigned: "10/9/2026, 9:21:43 AM" }]), { readRateConEmails: async () => { throw new Error("IMAP timeout"); } });
	ok("an unreadable mailbox: check 3 is skipped with the reason", /IMAP timeout/.test(broken.result.report.zone.skipped || ""), broken.result.report.zone);
	ok("...and checks 1, 2 and 4 still run (the receipt now past 7 days is named, the one named before counted)",
		broken.result.report.receipts.stale.map((r) => r.id).join() === "2" && broken.result.report.receipts.reportedOpen === 1, broken.result.report.receipts);
	const dbAmb = makeDb();
	await run(dbAmb, jt([{ id: "1", pickup: "p", assigned: "" }, { id: "2", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const amb = await run(dbAmb, jt([{ id: "1", pickup: "p", assigned: "10/9/2026, 9:21:43 AM" }, { id: "2", pickup: "p", assigned: "10/9/2026, 11:11:11 AM" }]), {
		readRateConEmails: async () => [{ date: "Fri, 09 Oct 2026 09:21:43 -0400" }, { date: "Fri, 09 Oct 2026 10:21:43 -0400" }],
	});
	const ambNotes = amb.result.report.notes.join("\n");
	ok("an ambiguous stamp's note: could not be matched to one rate-con email",
		/1 new Assigned Date could not be matched to one rate-con email[^\n]*load 1\b/.test(ambNotes) && !/matched no rate-con email[^\n]*load 1\b/.test(ambNotes), ambNotes);
	ok("...a stamp no email fits keeps its own note: matched no rate-con email", /1 new Assigned Date matched no rate-con email[^\n]*load 2\b/.test(ambNotes), ambNotes);
	const db4 = makeDb();
	let read = false;
	const base = await run(db4, jt([{ id: "1", pickup: "p", assigned: "10/9/2026, 9:21:43 AM" }]), { readRateConEmails: async () => { read = true; return emails; } });
	ok("the baseline run skips check 3 (nothing is new yet) and reads no mailbox", /baseline/.test(base.result.report.zone.skipped || "") && read === false, base.result.report.zone);
	const db5 = makeDb();
	await run(db5, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	let read5 = false;
	await run(db5, jt([{ id: "1", pickup: "p", assigned: "10/9/2026" }]), { readRateConEmails: async () => { read5 = true; return []; } });
	ok("no new n8n-shaped stamp: no mailbox read", read5 === false);
}

async function section3() {
	console.log("§3 check 4 (approved receipts on no invoice for more than 7 days)");
	const db = makeDb();
	const now = new Date("2026-10-10T12:00:30Z");
	const old = sqliteStamp(now.getTime() - 8 * 86400000);
	const recent = sqliteStamp(now.getTime() - 6 * 86400000);
	addExpense(db, { id: 10, status: "Approved", date: "2026-10-01", createdAt: old });
	addExpense(db, { id: 11, status: "Approved", date: "2026-10-01", createdAt: old });
	addExpense(db, { id: 12, status: "Approved", date: "2026-10-01", createdAt: old });
	addExpense(db, { id: 13, status: "Rejected", date: "2026-10-01", createdAt: old });
	addExpense(db, { id: 14, status: "Pending", date: "2026-10-01", createdAt: old });
	addExpense(db, { id: 15, status: "Approved", date: "2026-10-03", createdAt: recent });
	addExpense(db, { id: 16, status: "Approved", date: "2026-08-20", createdAt: "2026-08-21 10:00:00" });
	addExpense(db, { id: 17, status: "Approved", date: "2026-09-20", createdAt: "2026-09-21 10:00:00" });
	addExpense(db, { id: 18, status: "Approved", date: "2026-10-01", createdAt: old, postedPeriod: "2026-08" });
	addExpense(db, { id: 19, status: "Approved", date: "2026-10-01", createdAt: "2026-10-01T09:00:00.000Z" });
	db.prepare("INSERT INTO invoices (invoice_number, status, expense_ids, deleted_at) VALUES (?, ?, ?, ?)").run("INV-A", "Submitted", "[11]", "");
	db.prepare("INSERT INTO invoices (invoice_number, status, expense_ids, deleted_at) VALUES (?, ?, ?, ?)").run("INV-B", "Draft", "[12]", "2026-10-05T10:00:00Z");
	db.prepare("INSERT INTO invoices (invoice_number, status, expense_ids, deleted_at) VALUES (?, ?, ?, ?)").run("INV-C", "Draft", "not json", "");
	db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-08', 'locked'), ('2026-09', 'reopened')").run();
	const r = ic.staleApprovedReceipts(db, { now, expensePeriodExpr: EXPENSE_PERIOD_EXPR });
	const ids = r.stale.map((x) => x.id).sort((a, b) => a - b);
	ok("approved, submitted 8 days ago, on no invoice: reported", ids.includes(10), ids);
	ok("approved and on a live invoice: not reported", !ids.includes(11));
	ok("approved and only on a deleted invoice: reported", ids.includes(12));
	ok("rejected and pending receipts: not reported", !ids.includes(13) && !ids.includes(14));
	ok("approved 6 days ago: not reported yet", !ids.includes(15));
	ok("booked to a closed month (dated in it, or posted to it): not reported", !ids.includes(16) && !ids.includes(18));
	ok("booked to a reopened month: reported", ids.includes(17));
	ok("an ISO created_at is read too", ids.includes(19));
	ok("exactly those", ids.join() === "10,12,17,19", ids);
	ok("each carries its age in days and its month", r.stale.find((x) => x.id === 10).days === 8 && r.stale.find((x) => x.id === 10).period === "2026-10", r.stale.find((x) => x.id === 10));
	ok("an invoice whose expense list is unreadable is counted", r.unreadableInvoices === 1, r.unreadableInvoices);
	ok("nothing reported before: every receipt past 7 days is listed, none counted", r.reportedOpen === 0, r.reportedOpen);

	// Each receipt is named once: the job's reported list (its own
	// *_alerts-style ledger) holds every receipt a recorded run named.
	const r2 = ic.staleApprovedReceipts(db, { now, expensePeriodExpr: EXPENSE_PERIOD_EXPR, reported: new Set([10, 11, 17]) });
	ok("receipts on the reported list are not named again", r2.stale.map((x) => x.id).sort((a, b) => a - b).join() === "12,19", r2.stale.map((x) => x.id));
	ok("...those still open are counted (a reported one now on an invoice is not)", r2.reportedOpen === 2, r2.reportedOpen);

	console.log("§3b check 4 through the runner: each receipt named once");
	const dbOnce = makeDb();
	addExpense(dbOnce, { id: 41, status: "Approved", date: "2026-09-20", createdAt: "2026-09-20 10:00:00" });
	addExpense(dbOnce, { id: 42, status: "Approved", date: "2026-10-02", createdAt: "2026-10-02 20:00:00" });
	addExpense(dbOnce, { id: 43, status: "Pending", date: "2026-10-01", createdAt: "2026-10-01 15:00:00" });
	const sheetOnce = jt([{ id: "1", pickup: "p", assigned: "" }]);
	const reportedRows = () => dbOnce.prepare(`SELECT expense_id FROM ${ic.RECEIPTS_TABLE} ORDER BY expense_id`).all().map((x) => x.expense_id).join();
	const m1 = mailSpy();
	const run1 = await run(dbOnce, sheetOnce, { sendEmail: m1, now: new Date("2026-10-09T12:00:30Z") });
	ok("run 1 (first): the receipt past 7 days (#41) is named, the 6-day-old one (#42) and the pending one (#43) are not",
		run1.result.report.receipts.stale.map((x) => x.id).join() === "41" && m1.calls.length === 1 && /#41/.test(m1.calls[0].html) && !/#4[23]/.test(m1.calls[0].html));
	ok("run 1: the first run's log line does not say \"newly\"", run1.logger.lines.length === 1 && !/newly/i.test(run1.logger.lines[0].text), run1.logger.lines);
	ok("run 1: #41 is on the reported list, with when", reportedRows() === "41" &&
		dbOnce.prepare(`SELECT reported_at FROM ${ic.RECEIPTS_TABLE} WHERE expense_id = 41`).get().reported_at === "2026-10-09T12:00:30.000Z");
	const m2 = mailSpy();
	const run2 = await run(dbOnce, sheetOnce, { sendEmail: m2, now: new Date("2026-10-10T12:00:30Z") });
	ok("run 2: #42 (now past 7 days) is named and #41 is not repeated",
		run2.result.report.receipts.stale.map((x) => x.id).join() === "42" && m2.calls.length === 1 && /#42/.test(m2.calls[0].html) && !/#41/.test(m2.calls[0].html), m2.calls.map((c) => c.subject));
	ok("run 2: one line counts the reported receipt still open, with no id",
		/1 approved receipt reported earlier is still on no invoice\./.test(m2.calls[0].html) && run2.result.report.receipts.reportedOpen === 1);
	ok("run 2: the subject counts only what is named (1 issue)", /: 1 issue$/.test(m2.calls[0].subject), m2.calls[0].subject);
	const m3 = mailSpy();
	const run3 = await run(dbOnce, sheetOnce, { sendEmail: m3, now: new Date("2026-10-11T12:00:30Z") });
	ok("run 3: nothing to name, so no email (the count alone sends nothing)", m3.calls.length === 0 && run3.result.report.findings === 0);
	ok("run 3: its one log line counts the 2 reported earlier, with no ids",
		run3.logger.lines.length === 1 && /2 reported earlier still on no invoice/.test(run3.logger.lines[0].text) && !/#4\d/.test(run3.logger.lines[0].text), run3.logger.lines);

	// Late approval: submitted 10-01 (past its 7-day mark on 10-08) but Pending
	// until 10-11. A submission-time window never names it; the list does.
	dbOnce.prepare("UPDATE expenses SET status = 'Approved' WHERE id = 43").run();
	const failedSend = await run(dbOnce, sheetOnce, { sendEmail: mailSpy(false), now: new Date("2026-10-12T12:00:30Z") });
	ok("a failed send names #43 but records nothing on the reported list", failedSend.result.ok === false &&
		failedSend.result.report.receipts.stale.map((x) => x.id).join() === "43" && reportedRows() === "41,42");
	const m4 = mailSpy();
	const run4 = await run(dbOnce, sheetOnce, { sendEmail: m4, now: new Date("2026-10-12T12:15:30Z") });
	ok("late approval: #43 (submitted 10-01, approved 10-11) is named on the next run",
		run4.result.report.receipts.stale.map((x) => x.id).join() === "43" && m4.calls.length === 1 && /#43/.test(m4.calls[0].html) && !/#4[12]/.test(m4.calls[0].html));
	ok("...with the 2 reported earlier counted", /2 approved receipts reported earlier are still on no invoice\./.test(m4.calls[0].html), m4.calls[0].text);
	const m5 = mailSpy();
	const run5 = await run(dbOnce, sheetOnce, { sendEmail: m5, now: new Date("2026-10-13T12:00:30Z") });
	ok("...and only once: the next run counts it, names nothing, sends nothing", m5.calls.length === 0 && run5.result.report.receipts.reportedOpen === 3 && reportedRows() === "41,42,43");
	ok("across the runs each receipt was emailed once",
		[...m1.calls, ...m2.calls, ...m3.calls, ...m4.calls, ...m5.calls].map((c) => (c.html.match(/#4\d/g) || []).join()).join("|") === "#41|#42|#43");

	// Becomes reportable after its 7-day mark another way: its invoice is
	// soft-deleted later. Named once then.
	const dbLate = makeDb();
	addExpense(dbLate, { id: 51, status: "Approved", date: "2026-09-20", createdAt: "2026-09-20 10:00:00" });
	dbLate.prepare("INSERT INTO invoices (invoice_number, status, expense_ids, deleted_at) VALUES ('INV-L', 'Draft', '[51]', '')").run();
	await run(dbLate, sheetOnce, { now: new Date("2026-10-09T12:00:30Z") });
	dbLate.prepare("UPDATE invoices SET deleted_at = '2026-10-09T15:00:00Z' WHERE invoice_number = 'INV-L'").run();
	const m6 = mailSpy();
	const late = await run(dbLate, sheetOnce, { sendEmail: m6, now: new Date("2026-10-10T12:00:30Z") });
	ok("a receipt whose invoice is deleted after its 7-day mark is named on the next run", late.result.report.receipts.stale.map((x) => x.id).join() === "51" && m6.calls.length === 1);
	let threw = false;
	try { ic.staleApprovedReceipts(db, { now }); } catch { threw = true; }
	ok("the month rule is required (server.js passes EXPENSE_PERIOD_EXPR)", threw);
}

async function section4() {
	console.log("§4 the schedule: 8:00 AM Eastern, once a day");
	const tz = "America/New_York";
	const due = (now, last) => ic.dueSlot({ now: new Date(now), lastRunAt: last, timeZone: tz });
	ok("7:59:59 AM EDT on 2026-10-31: not due", due("2026-10-31T11:59:59Z", "2026-10-30T12:00:30.000Z") === null);
	ok("8:00 AM EDT on 2026-10-31 is 12:00 UTC: due", due("2026-10-31T12:00:00Z", "2026-10-30T12:00:30.000Z") === Date.parse("2026-10-31T12:00:00Z"));
	ok("after that day's run: not due again that day", due("2026-10-31T23:59:00Z", "2026-10-31T12:00:30.000Z") === null);
	ok("2026-11-01 (daylight time ended at 2 AM): 7:00 AM EST (12:00 UTC) is not 8:00", due("2026-11-01T12:00:00Z", "2026-10-31T12:00:30.000Z") === null);
	ok("2026-11-01: 8:00 AM EST is 13:00 UTC: due", due("2026-11-01T13:00:00Z", "2026-10-31T12:00:30.000Z") === Date.parse("2026-11-01T13:00:00Z"));
	ok("2026-11-02: 12:59:59 UTC not due, 13:00 UTC due", due("2026-11-02T12:59:59Z", "2026-11-01T13:00:30.000Z") === null && due("2026-11-02T13:00:00Z", "2026-11-01T13:00:30.000Z") === Date.parse("2026-11-02T13:00:00Z"));
	ok("2027-03-14 (daylight time starts): 8:00 AM EDT is 12:00 UTC", due("2027-03-14T11:59:00Z", "2027-03-13T13:00:30.000Z") === null && due("2027-03-14T12:00:00Z", "2027-03-13T13:00:30.000Z") === Date.parse("2027-03-14T12:00:00Z"));
	ok("never run, after 8 AM: due now (the first run, a baseline)", due("2026-10-09T15:00:00Z", null) === Date.parse("2026-10-09T12:00:00Z"));
	ok("never run, before 8 AM: waits for 8 AM", due("2026-10-09T11:00:00Z", null) === null);
	ok("a missed day is not run twice: before 8 AM the next day nothing runs", due("2026-10-12T11:30:00Z", "2026-10-10T12:00:30.000Z") === null);
	ok("the hour is 8", ic.RUN_HOUR === 8);

	// The ticker over a real run: a failed send is retried after 15 minutes, at
	// most 3 times a day, and a run that completes is not repeated that day.
	const db = makeDb();
	addExpense(db, { id: 1, status: "Approved", date: "2026-09-25", createdAt: "2026-09-25 10:00:00" });
	let clock = Date.parse("2026-10-10T11:59:00Z");
	const sends = mailSpy((n) => n >= 3);
	const logger = captureLog();
	let runs = 0;
	const tick = ic.dailyTicker({
		db, timeZone: tz, now: () => new Date(clock), log: logger,
		run: (now) => { runs++; return ic.runIntegrityCheck({ db, now, write: true, readJobTracking: async () => jt([{ id: "1", pickup: "p", assigned: "" }]), expensePeriodExpr: EXPENSE_PERIOD_EXPR, sendEmail: sends, to: ADMIN, log: logger, appZone: tz }); },
	});
	await tick();
	ok("ticker: nothing before 8 AM", runs === 0);
	clock = Date.parse("2026-10-10T12:00:05Z"); await tick();
	ok("ticker: runs at 8 AM", runs === 1 && sends.calls.length === 1);
	clock += 60 * 1000; await tick();
	ok("ticker: a failed send is not retried within 15 minutes", runs === 1);
	clock += 15 * 60 * 1000; await tick();
	ok("ticker: retried after 15 minutes", runs === 2 && sends.calls.length === 2);
	clock += 16 * 60 * 1000; await tick();
	ok("ticker: the third attempt sends and records the run", runs === 3 && sends.calls.length === 3 && ic.lastRunAt(db) !== null);
	clock += 60 * 60 * 1000; await tick();
	ok("ticker: not run again that day", runs === 3);
	clock = Date.parse("2026-10-11T12:00:10Z"); await tick();
	ok("ticker: runs again the next day at 8 AM", runs === 4);
	const failing = mailSpy(false);
	let runs2 = 0;
	let clock2 = Date.parse("2026-10-10T12:00:05Z");
	const db2 = makeDb();
	addExpense(db2, { id: 1, status: "Approved", date: "2026-09-25", createdAt: "2026-09-25 10:00:00" });
	const tick2 = ic.dailyTicker({
		db: db2, timeZone: tz, now: () => new Date(clock2), log: captureLog(),
		run: (now) => { runs2++; return ic.runIntegrityCheck({ db: db2, now, write: true, readJobTracking: async () => jt([{ id: "1", pickup: "p", assigned: "" }]), expensePeriodExpr: EXPENSE_PERIOD_EXPR, sendEmail: failing, to: ADMIN, log: captureLog(), appZone: tz }); },
	});
	for (let i = 0; i < 8; i++) { await tick2(); clock2 += 16 * 60 * 1000; }
	ok("ticker: at most 3 attempts a day", runs2 === 3, runs2);
	let runs3 = 0;
	const tick3 = ic.dailyTicker({ db: makeDb(), timeZone: tz, now: () => new Date("2026-10-10T12:00:05Z"), log: captureLog(), run: async () => { runs3++; throw new Error("sheet down"); } });
	await tick3();
	let threw = false;
	try { await tick3(); } catch { threw = true; }
	ok("ticker: a run that throws is caught and logged, never rethrown", runs3 === 1 && !threw);
}

async function section5() {
	console.log("§5 email and logging");
	const db = makeDb();
	// Submitted 2026-10-03 10:00 UTC: 6 days old at the first run, past 7 at the second.
	addExpense(db, { id: 7, status: "Approved", date: "2026-10-03", createdAt: "2026-10-03 10:00:00", amount: 88.25 });
	await run(db, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z"), sendEmail: mailSpy() });
	const before = businessRows(db);
	const spy = mailSpy();
	const { result } = await run(db, jt([{ id: "1", pickup: "", assigned: "" }]), { sendEmail: spy });
	ok("one email per run with findings", spy.calls.length === 1);
	ok("to ADMIN_NOTIFY_EMAIL only, and no one else", spy.calls.every((c) => c.to === ADMIN) && spy.calls[0].rest.length === 0, spy.calls.map((c) => c.to));
	ok("the subject counts the findings", /2 issues/.test(spy.calls[0].subject), spy.calls[0].subject);
	ok("the email names receipt #7 and its age", /#7/.test(spy.calls[0].html) && /days/.test(spy.calls[0].html));
	ok("a run writes no business table", businessRows(db) === before);
	ok("its only tables are its own (the load state and the reported list)",
		tables(db).filter((t) => !["expenses", "invoices", "period_locks"].includes(t)).join() === [ic.STATE_TABLE, ic.RECEIPTS_TABLE].sort().join(), tables(db));
	ok("result.emailed", result.emailed === true);

	const db2 = makeDb();
	addExpense(db2, { id: 7, status: "Approved", date: "2026-09-25", createdAt: "2026-09-25 10:00:00" });
	const noTo = mailSpy();
	const unset = await run(db2, jt([{ id: "1", pickup: "p", assigned: "" }]), { sendEmail: noTo, to: "" });
	ok("ADMIN_NOTIFY_EMAIL unset: nothing is sent", noTo.calls.length === 0);
	ok("...the log names the setting", unset.logger.lines.some((l) => /ADMIN_NOTIFY_EMAIL/.test(l.text) && /not set/.test(l.text)), unset.logger.lines);
	ok("...and the run is recorded", unset.result.ok === true && ic.lastRunAt(db2) !== null);

	const db3 = makeDb();
	await run(db3, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const failed = await run(db3, jt([{ id: "1", pickup: "", assigned: "" }]), { sendEmail: mailSpy(false) });
	ok("a failed send records nothing (the run repeats)", failed.result.ok === false && failed.result.retry === true && stateRow(db3, "1").pickup_appointment === "p");
	ok("...and logs an error", failed.logger.lines.some((l) => l.level === "error"));
	const again = mailSpy();
	await run(db3, jt([{ id: "1", pickup: "", assigned: "" }]), { sendEmail: again });
	ok("...so the next attempt reports the same finding", again.calls.length === 1 && /Pickup Appointment/.test(again.calls[0].html));

	// A failed FIRST run: no baseline was taken, so its line must not say one was.
	const db6 = makeDb();
	addExpense(db6, { id: 9, status: "Approved", date: "2026-09-25", createdAt: "2026-09-25 10:00:00" });
	const failedBase = await run(db6, jt([{ id: "1", pickup: "p", assigned: "" }]), { sendEmail: mailSpy(false) });
	const baseLine = failedBase.logger.lines.map((l) => l.text).join("\n");
	ok("a failed first run: an error that says the run is not recorded", failedBase.result.ok === false && failedBase.logger.lines.length === 1 &&
		failedBase.logger.lines[0].level === "error" && /not recorded/.test(baseLine), failedBase.logger.lines);
	ok("...and never that the baseline was taken", !/baseline taken/i.test(baseLine) && /baseline not taken/i.test(baseLine), baseLine);
	ok("...and nothing is in the state table", ic.lastRunAt(db6) === null);

	const db4 = makeDb();
	await run(db4, jt([{ id: "1", pickup: "p", assigned: "" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const quiet = mailSpy();
	const clean = await run(db4, jt([{ id: "1", pickup: "p", assigned: "" }]), { sendEmail: quiet });
	ok("clean: no email", quiet.calls.length === 0);
	ok("clean: exactly one log line", clean.logger.lines.length === 1 && clean.logger.lines[0].level === "log" && /^\[integrity-check\] clean/.test(clean.logger.lines[0].text) && !/\n/.test(clean.logger.lines[0].text), clean.logger.lines);

	const db5 = makeDb();
	await run(db5, jt([{ id: "1", pickup: "p", assigned: "x" }]), { now: new Date("2026-10-09T12:00:30Z") });
	const hostile = mailSpy();
	await run(db5, jt([{ id: "1", pickup: "", assigned: "<img src=x onerror=alert(1)>" }]), { sendEmail: hostile });
	ok("sheet text is escaped in the email", hostile.calls.length === 1 && !/<img/.test(hostile.calls[0].html) && /&lt;img/.test(hostile.calls[0].html));
}

function liftBlock() {
	const head = 'if (INTEGRITY_CHECK_ENABLED && startsJob("daily integrity check")) {';
	const at = SRC.indexOf(`\n${head}\n`);
	if (at < 0) return null;
	const end = SRC.indexOf("\n}\n", at + 1);
	return SRC.slice(at + 1, end + 2);
}

async function section6() {
	console.log("§6 server.js wiring");
	const def = SRC.match(/\nconst INTEGRITY_CHECK_ENABLED = ([^;\n]+);/);
	ok("server.js declares INTEGRITY_CHECK_ENABLED once", !!def && SRC.split("\nconst INTEGRITY_CHECK_ENABLED = ").length === 2);
	if (def) {
		const value = (env) => new Function("process", `return ${def[1]};`)({ env });
		ok("unset: on (a kill switch, production runs it by default)", value({}) === true);
		ok("true: on", value({ INTEGRITY_CHECK_ENABLED: "true" }) === true);
		ok("false / 0 / no / off: off", ["false", "0", "no", "off", " OFF "].every((v) => value({ INTEGRITY_CHECK_ENABLED: v }) === false));
	}
	ok("server.js loads lib/integrity-check.js", /\nconst integrityCheck = require\("\.\/lib\/integrity-check"\);\n/.test(SRC));
	const block = liftBlock();
	ok("the job is gated: INTEGRITY_CHECK_ENABLED && startsJob(\"daily integrity check\")", !!block);
	if (!block) return;
	const startsJobSrc = SRC.match(/function startsJob\(name\) \{[\s\S]*?\n\}/)[0];
	const names = ["INTEGRITY_CHECK_ENABLED", "REPLICA", "setInterval", "setTimeout", "console", "integrityCheck", "db", "APP_TIMEZONE",
		"getJobTrackingCached", "sendEmail", "ADMIN_NOTIFY_EMAIL", "EXPENSE_PERIOD_EXPR", "invoiceEmailHtml", "RATECON_RECONCILE_MAILBOX", "process"];
	const exec = (over) => {
		const timers = [];
		const seen = {};
		const env = {
			INTEGRITY_CHECK_ENABLED: true,
			REPLICA: null,
			setInterval: (fn, ms) => { timers.push({ kind: "interval", ms, fn }); return 0; },
			setTimeout: (fn, ms) => { timers.push({ kind: "timeout", ms, fn }); return 0; },
			console: { log: () => {}, error: () => {}, warn: () => {} },
			integrityCheck: {
				dailyTicker: (o) => { seen.ticker = o; return async () => {}; },
				rateConEmailReader: (o) => { seen.reader = o; return "reader"; },
				runIntegrityCheck: (o) => { seen.run = o; return { ok: true }; },
			},
			db: { db: true },
			APP_TIMEZONE: "America/New_York",
			getJobTrackingCached: async () => ({ headers: [], data: [] }),
			sendEmail: async () => true,
			ADMIN_NOTIFY_EMAIL: ADMIN,
			EXPENSE_PERIOD_EXPR,
			invoiceEmailHtml: ({ heading }) => `<h2>${heading}</h2>`,
			RATECON_RECONCILE_MAILBOX: "RATECONs",
			process: { env: { GMAIL_USER: "ops@example.test", GMAIL_APP_PASSWORD: "pw" } },
			...over,
		};
		new Function(...names, `${startsJobSrc}\n${block}`)(...names.map((n) => env[n]));
		return { timers, seen, env };
	};
	const notStarted = [];
	const replica = exec({ REPLICA: { jobNotStarted: (n) => { notStarted.push(n); return false; } } });
	ok("replica mode: no timer starts", replica.timers.length === 0 && !replica.seen.ticker);
	ok("...and the job is named in the replica's log", notStarted.join() === "daily integrity check", notStarted);
	const off = exec({ INTEGRITY_CHECK_ENABLED: false });
	ok("switched off: no timer starts", off.timers.length === 0);
	const on = exec({});
	ok("on: ticks every minute", on.timers.some((t) => t.kind === "interval" && t.ms === 60 * 1000));
	ok("on: one catch-up after boot", on.timers.filter((t) => t.kind === "timeout").length === 1);
	ok("on: the ticker runs on the business clock (APP_TIMEZONE) over the app's database", !!on.seen.ticker && on.seen.ticker.timeZone === "America/New_York" && on.seen.ticker.db === on.env.db);
	if (on.seen.ticker) {
		const now = new Date("2026-10-10T12:00:30Z");
		on.seen.ticker.run(now);
		const o = on.seen.run || {};
		ok("the run writes its state (write: true) at the ticker's time", o.write === true && o.now === now);
		ok("it reads Job Tracking through getJobTrackingCached()", o.readJobTracking === on.env.getJobTrackingCached);
		ok("it mails ADMIN_NOTIFY_EMAIL with the shared sendEmail", o.to === ADMIN && o.sendEmail === on.env.sendEmail);
		ok("it books receipts with EXPENSE_PERIOD_EXPR", o.expensePeriodExpr === EXPENSE_PERIOD_EXPR);
		ok("it reads the rate-con mailbox with the app's Gmail account and label", !!on.seen.reader && on.seen.reader.user === "ops@example.test" && on.seen.reader.pass === "pw" && on.seen.reader.mailbox === "RATECONs" && o.readRateConEmails === "reader");
		ok("it wraps the email in the app's template", typeof o.emailHtml === "function" && /<h2>x<\/h2>/.test(o.emailHtml({ heading: "x", bodyHtml: "" })));
	}
	ok("no sendEmail() call of its own in server.js (the five admin sends stay five)", !/sendEmail\(ADMIN_NOTIFY_EMAIL/.test(block));
	const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	ok(".env.example documents INTEGRITY_CHECK_ENABLED as a kill switch", /\nINTEGRITY_CHECK_ENABLED=true\n/.test(example) && /integrity/i.test(example));
	const lib = fs.readFileSync(path.join(ROOT, "lib", "integrity-check.js"), "utf8");
	ok("the lib sends only through the sendEmail it is given, to the inbox it is given", !/nodemailer|createTransport|sendMail\(/.test(lib));
	const writes = [...lib.matchAll(/\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|REPLACE\s+INTO|UPDATE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(\S+)/g)]
		.map((m) => `${m[1].split(/\s+/)[0]} ${m[2]}`);
	ok("the lib writes, creates and changes only its own table",
		writes.length > 0 && writes.every((w) => /\$\{(STATE_TABLE|RECEIPTS_TABLE)\}$/.test(w) || w === "UPDATE SET"), writes);
	const commitAt = lib.indexOf("function commitState(");
	const txBody = commitAt < 0 ? "" : lib.slice(lib.indexOf("db.transaction(() => {", commitAt), lib.indexOf("})();", commitAt));
	ok("the reported list is written in the same transaction as the load state", /upsert\.run\(/.test(txBody) && /markReported\.run\(/.test(txBody), txBody);
}

function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

async function section7() {
	console.log("§7 scripts/integrity-check.js --print");
	const CLI = path.join(ROOT, "scripts", "integrity-check.js");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-cli-"));
	try {
		const dbFile = path.join(tmp, "app.db");
		const db = new Database(dbFile);
		db.exec(`
			CREATE TABLE expenses (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT 'd',
				load_id TEXT DEFAULT '', type TEXT NOT NULL DEFAULT 'Fuel', amount REAL NOT NULL DEFAULT 10, description TEXT DEFAULT '',
				date TEXT NOT NULL, status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
			CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL DEFAULT 'd',
				status TEXT NOT NULL DEFAULT 'Draft', expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
			CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
		`);
		db.prepare("INSERT INTO expenses (id, status, date, created_at) VALUES (31, 'Approved', '2020-01-02', '2020-01-02 10:00:00')").run();
		db.close();
		const values = { values: [["Load ID", "Pickup Appointment", "Assigned Date"], ["111", "", "10/9/2026, 8:30:10 AM"], ["222", "10/20/2026", "10/9/2026"]] };
		fs.writeFileSync(path.join(tmp, "values.json"), JSON.stringify(values));
		fs.writeFileSync(path.join(tmp, "settings.env"), `ADMIN_NOTIFY_EMAIL=${ADMIN}\n`);
		fs.writeFileSync(path.join(tmp, "emails.json"), JSON.stringify([{ subject: "Load 111", date: new Date(Date.now() - 3600 * 1000).toUTCString() }]));
		const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: os.tmpdir() } });
		const base = [`--db=${dbFile}`, `--values-json=${path.join(tmp, "values.json")}`, `--env-file=${path.join(tmp, "settings.env")}`];

		const noPrint = cli(base);
		ok("without --print: refused, exit 2", noPrint.status === 2 && /--print/.test(noPrint.stderr), noPrint.stderr);
		const noDb = cli(["--print", `--values-json=${path.join(tmp, "values.json")}`]);
		ok("without --db: refused, exit 2", noDb.status === 2 && /--db/.test(noDb.stderr), noDb.stderr);
		const noSheet = cli(["--print", `--db=${dbFile}`, `--env-file=${path.join(tmp, "settings.env")}`]);
		ok("without --sheet-id or --values-json: refused, exit 2, no default sheet", noSheet.status === 2 && /no default sheet/.test(noSheet.stderr), noSheet.stderr);
		const elsewhere = cli(["--print", `--db=${path.join(ROOT, "scripts", "no-such.db")}`, `--values-json=${path.join(tmp, "values.json")}`]);
		ok("a database outside the app directory or the temp directory: refused, exit 2", elsewhere.status === 2 && /refusing/.test(elsewhere.stderr), elsewhere.stderr);
		ok("...and nothing was created there", !fs.existsSync(path.join(ROOT, "scripts", "no-such.db")));
		const envSheet = cli(["--print", `--db=${dbFile}`, "--sheet-id=env", `--env-file=${path.join(tmp, "settings.env")}`]);
		ok("--sheet-id=env when the settings name no SPREADSHEET_ID: refused, exit 2, one line, no stack",
			envSheet.status === 2 && /SPREADSHEET_ID/.test(envSheet.stderr) && !/\n\s+at /.test(envSheet.stderr) && envSheet.stderr.trim().split("\n").length === 1, envSheet.stderr);

		const h0 = sha(dbFile);
		const first = cli(["--print", ...base]);
		ok("no state yet: exit 0", first.status === 0, first.stderr);
		ok("no state yet: it says the first run would take a baseline", /baseline/i.test(first.stdout), first.stdout);
		ok("check 4 still reports receipt #31", /#31/.test(first.stdout), first.stdout);
		ok("it prints the email it would send, to ADMIN_NOTIFY_EMAIL", new RegExp(`To: ${ADMIN.replace(/\./g, "\\.")}`).test(first.stdout) && /Subject: /.test(first.stdout) && /not sent/i.test(first.stdout), first.stdout);
		ok("the database file is unchanged", sha(dbFile) === h0);
		const check = new Database(dbFile, { readonly: true });
		ok("no state table and no reported list were created", !tables(check).includes(ic.STATE_TABLE) && !tables(check).includes(ic.RECEIPTS_TABLE), tables(check));
		check.close();

		// With state from an earlier run, checks 1-3 compare against it.
		const w = new Database(dbFile);
		ic.ensureStateTable(w);
		w.prepare(`INSERT INTO ${ic.RECEIPTS_TABLE} (expense_id, reported_at) VALUES (31, ?)`).run(new Date(Date.now() - 86400000).toISOString());
		w.prepare(`INSERT INTO ${ic.STATE_TABLE} (load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
			.run("222", "10/20/2026", "10/8/2026", "2026-10-08T12:00:30.000Z", new Date(Date.now() - 86400000).toISOString());
		w.prepare(`INSERT INTO ${ic.STATE_TABLE} (load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
			.run("111", "10/15/2026", "", "2026-10-08T12:00:30.000Z", new Date(Date.now() - 86400000).toISOString());
		w.close();
		const h1 = sha(dbFile);
		const emails = [{ subject: "Load 111", date: "Fri, 09 Oct 2026 09:30:10 -0400" }];
		fs.writeFileSync(path.join(tmp, "emails.json"), JSON.stringify(emails));
		const second = cli(["--print", ...base, `--emails-json=${path.join(tmp, "emails.json")}`]);
		ok("with state: exit 0", second.status === 0, second.stderr);
		ok("with state: the blanked Pickup Appointment (111) is printed", /111/.test(second.stdout) && /Pickup Appointment/.test(second.stdout), second.stdout);
		ok("with state: the changed Assigned Date (222) is printed", /222/.test(second.stdout) && /10\/8\/2026/.test(second.stdout));
		ok("with state: the Central stamp (111) is printed", /111: Assigned Date "10\/9\/2026, 8:30:10 AM" is the rate-con email's time at UTC-05:00, 1 hour behind Eastern/.test(second.stdout), second.stdout);
		ok("with state: receipt #31 (on the reported list) is not named again, only counted",
			!/#31/.test(second.stdout) && /1 approved receipt reported earlier is still on no invoice/.test(second.stdout), second.stdout);
		ok("with state: the database file is still unchanged (no state write)", sha(dbFile) === h1);
		const noMail = cli(["--print", ...base]);
		ok("without --mailbox or --emails-json: check 3 says the mailbox was not read", /mailbox/i.test(noMail.stdout) && noMail.status === 0, noMail.stdout);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	const cliSrc = fs.readFileSync(CLI, "utf8");
	ok("the CLI opens the database read-only and checks it", /readonly: true/.test(cliSrc) && /\.readonly/.test(cliSrc));
	ok("the CLI reads the sheet only through ledger-world's sheetFor (spreadsheets.readonly)", /sheetFor\(/.test(cliSrc) && !/auth\/spreadsheets"/.test(cliSrc) && !/auth\/drive/.test(cliSrc));
	ok("the CLI sends no mail", !/nodemailer|sendMail|sendEmail:\s*[a-zA-Z]/.test(cliSrc));
	ok("the CLI writes no state (write: false)", /write: false/.test(cliSrc) && !/write: true/.test(cliSrc));
}

(async () => {
	try {
		await section1();
		await section2();
		await section3();
		await section4();
		await section5();
		await section6();
		await section7();
	} catch (e) {
		console.error(`FAILED: ${e.stack || e.message}`);
		process.exit(1);
	}
	console.log(`\n${passed} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
})();
