#!/usr/bin/env node
/**
 * scripts/driver-rate-lines-report.js: one driver's invoice day lines judged
 * against his rate in effect that day, read-only, on a file database with the
 * production schema of the tables it reads (made-up data only).
 *
 *   §1 the command line: an unknown option, no --db, a bad --driver-id, a bad
 *      --from and a --json with a value are refused (exit 2) before anything
 *      is opened;
 *   §2 the lift: every root resolves in this checkout's server.js and no denied
 *      name is reached;
 *   §3 read-only: the handle is read-only, a write through it throws, and a run
 *      (module and command line) leaves the file byte for byte as it was;
 *   §4 the lines: dated rates read through the server's own reader ($300 on
 *      10/1, $350 from 10/2), any spelling of the driver's name, another driver
 *      left out, each differing line's route by status and month (adjustment,
 *      next invoice, regenerate, open-month manual invoice, adjust or re-create
 *      a manual Draft), the counts and the total difference;
 *   §5 deleted invoices: listed apart, each saying whether a live invoice pays
 *      its day (a Rejected invoice does not);
 *   §6 not judged: a dated manual line that is not one day's pay, a Personal
 *      correction, a weekly invoice with no day grid;
 *   §7 a closed month's line differs but gets no route; --from 10/1 judges the
 *      10/1 line against $300;
 *   §8 refusals: no user, not a Driver account, no Drivers Database row, a
 *      percentage driver, an unreadable period_locks;
 *   §9 the output: ids and amounts, no name, in text and JSON.
 *
 * Pure: a temp directory, child processes of the script itself, no server,
 * no network. Run: node scripts/test-driver-rate-lines-report.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "driver-rate-lines-report.js");
let Database;
try {
	Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const report = require(SCRIPT);

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(actual, expected, label) {
	ok(label, JSON.stringify(actual) === JSON.stringify(expected), { got: actual, want: expected });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rate-lines-"));
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Super Admin','Dispatcher','Driver','Investor')), driver_name TEXT DEFAULT '', email TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, full_name TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', rating REAL DEFAULT 0,
  must_change_password INTEGER DEFAULT 0, last_login_at TEXT DEFAULT '');
CREATE TABLE drivers_directory ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "driver_name" TEXT COLLATE NOCASE NOT NULL UNIQUE, "user_id" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'active', "pay_type" TEXT DEFAULT 'fixed', "pay_percentage" REAL DEFAULT 0, "pay_daily" REAL DEFAULT 0);
CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0);
CREATE TABLE pay_rate_history (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL CHECK(subject IN ('truck','driver')), subject_key TEXT NOT NULL,
  rate REAL NOT NULL, effective_from TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'change');
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL,
  finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
  loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '',
  pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '',
  approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '',
  paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '',
  render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '', personal_total REAL NOT NULL DEFAULT 0, personal_share_total REAL NOT NULL DEFAULT 0, correction_of INTEGER,
  is_correction INTEGER NOT NULL DEFAULT 0);
`;

const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// A weekly invoice's render_data: `paid` maps a day of the week to its printed total.
function grid(weekStart, paid) {
	const days = {};
	GRID.forEach((name, i) => {
		const day = addDays(weekStart, i);
		days[name] = paid[day] != null ? { completed: true, total: paid[day], loadBol: "LOAD-1001" } : { completed: false, total: 0 };
	});
	return JSON.stringify({ __templateName: "service_invoice", days });
}
const manual = (lines, extra = {}) => JSON.stringify({ __templateName: "service_invoice_manual", lineItems: lines, ...extra });

const DRIVER = "Test Driver Alpha";
const OTHER = "Test Driver Beta";
let seq = 0;
let nextInvoice = 0;
// The made-up world: driver Alpha (user 901, row 7: $350 now; dated $300 from 10/1 and $350 from 10/2),
// September closed, and his invoices around the rate change.
function fixture(mutate) {
	const dir = path.join(tmp, `f${++seq}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (901, 'alpha', 'x', 'Driver', ?), (902, 'beta', 'x', 'Driver', ?), (903, 'office', 'x', 'Dispatcher', ''), (904, 'gamma', 'x', 'Driver', 'Test Driver Gamma'), (905, 'delta', 'x', 'Driver', 'Test Driver Delta')").run(DRIVER, OTHER);
	db.prepare("INSERT INTO drivers_directory (id, driver_name, pay_type, pay_daily) VALUES (7, ?, 'fixed', 350), (8, ?, 'fixed', 300), (9, 'Test Driver Delta', 'percentage', 0)").run(DRIVER, OTHER);
	db.prepare("INSERT INTO trucks (unit_number, assigned_driver, driver_pay_daily) VALUES ('TEST-01', ?, 300)").run(DRIVER);
	const hist = db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES (?, ?, ?, ?, ?)");
	hist.run("driver", "test driver alpha", 300, "2026-10-01T04:00:00.000Z", "data-fix");
	hist.run("driver", "test driver alpha", 350, "2026-10-02T04:00:00.000Z", "data-fix");
	hist.run("driver", "test driver alpha", 350, "2026-10-03T03:00:20.000Z", "seed");
	hist.run("driver", "test driver beta", 300, "2026-10-03T03:00:20.000Z", "seed");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-08', 'locked', '2026-09-08T05:00:00Z'), ('2026-09', 'locked', '2026-10-09T14:00:00Z')").run();
	const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, status, render_data, is_manual, is_correction, deleted_at)
		VALUES (@id, @number, @driver, @ws, @we, @status, @rd, @manual, @corr, @deleted)`);
	const add = (o) => inv.run({ id: o.id, number: `INV-TEST-${++nextInvoice}`, driver: o.driver || DRIVER.toLowerCase(), ws: o.ws, we: o.we, status: o.status,
		rd: o.rd, manual: o.manual ? 1 : 0, corr: o.corr ? 1 : 0, deleted: o.deleted || "" });
	// 101: the week before the rate change, Submitted, touching closed September; Fri 10/2 printed $300.
	add({ id: 101, driver: "  test   DRIVER alpha ", ws: "2026-09-26", we: "2026-10-02", status: "Submitted",
		rd: grid("2026-09-26", { "2026-09-29": 300, "2026-09-30": 300, "2026-10-01": 300, "2026-10-02": 300 }) });
	// 102: Paid, one day at the old rate.
	add({ id: 102, ws: "2026-10-03", we: "2026-10-09", status: "Paid", rd: grid("2026-10-03", { "2026-10-05": 350, "2026-10-06": 300 }) });
	// 103: Submitted, all October.
	add({ id: 103, ws: "2026-10-10", we: "2026-10-16", status: "Submitted", rd: grid("2026-10-10", { "2026-10-12": 300, "2026-10-13": 350 }) });
	// 104: a weekly Draft.
	add({ id: 104, ws: "2026-10-17", we: "2026-10-23", status: "Draft", rd: grid("2026-10-17", { "2026-10-19": 300 }) });
	// 105: a manual correction Draft: one day's pay at $300 and a dated line that is not one day's pay.
	add({ id: 105, ws: "2026-10-15", we: "2026-10-15", status: "Draft", manual: true, rd: manual([
		{ date: "2026-10-02", description: "Correction for INV-TEST-1: Friday, October 2, 2026, $300", amount: 300 },
		{ date: "2026-10-03", description: "Fuel advance", amount: 100 },
	]) });
	// 106: a deleted correction Draft: 10/2 (paid by live 101) and 10/8 (paid by no live invoice).
	add({ id: 106, ws: "2026-10-14", we: "2026-10-14", status: "Draft", manual: true, deleted: "2026-10-16T14:00:00.000Z", rd: manual([
		{ date: "2026-10-02", description: "Correction for INV-TEST-1: Friday, October 2, 2026, $300", amount: 300 },
		{ date: "2026-10-08", description: "Correction for INV-TEST-2: Thursday, October 8, 2026, $300", amount: 300 },
	]) });
	// 107: Rejected, Mon 10/26 at $300; its days are not "paid by a live invoice".
	add({ id: 107, ws: "2026-10-24", we: "2026-10-30", status: "Rejected", rd: grid("2026-10-24", { "2026-10-26": 300 }) });
	// 108: a Personal correction (pays no day); 109: a weekly invoice with no day grid.
	add({ id: 108, ws: "2026-10-20", we: "2026-10-20", status: "Draft", manual: true, corr: true, rd: manual([{ date: "2026-10-20", description: "Personal: receipt", amount: 40 }]) });
	add({ id: 109, ws: "2026-10-31", we: "2026-11-06", status: "Draft", rd: "{}" });
	// 110: another driver, a $300 day: never listed for Alpha.
	add({ id: 110, driver: OTHER.toLowerCase(), ws: "2026-10-03", we: "2026-10-09", status: "Submitted", rd: grid("2026-10-03", { "2026-10-05": 250 }) });
	// 111: a Rejected manual line dated 10/8: still "no live invoice pays" it.
	add({ id: 111, ws: "2026-10-08", we: "2026-10-08", status: "Rejected", manual: true, rd: manual([{ date: "2026-10-08", description: "Correction for INV-TEST-2: Thursday, October 8, 2026, $350", amount: 350 }]) });
	if (mutate) mutate(db);
	db.close();
	return file;
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function run(file, opts) {
	const db = report.openReadOnly(file);
	try {
		const { api } = report.buildWorld({ db });
		return report.buildReport(db, api, { today: "2026-10-28", ...opts });
	} finally {
		db.close();
	}
}
function tryRun(file, opts) {
	try { return { r: run(file, opts) }; } catch (err) { return { err }; }
}
function cli(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: "utf8", timeout: 120000, env: { ...process.env, LOCAL_REPLICA: "" } });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const lineOf = (r, id, day) => r.live.find((l) => l.invoiceId === id && l.day === day);

// ── §1 the command line ────────────────────────────────────────────────────────
function section1() {
	console.log("§1 the command line");
	eq(report.readOptions(["--db", "app", "--driver-id", "901", "--from", "2026-10-02"]), { db: "app", driverId: 901, from: "2026-10-02", json: false }, "§1 the options read");
	ok("§1 --json reads", report.readOptions(["--db=x.db", "--driver-id=901", "--from=2026-10-02", "--json"]).json === true);
	const refuses = (name, argv, re) => {
		let err = null;
		try { report.readOptions(argv); } catch (e) { err = e; }
		ok(`§1 refuses ${name}`, err instanceof report.Refusal && re.test(err.message), err ? err.message : "accepted");
	};
	refuses("an unknown option", ["--db", "app", "--driver-id", "901", "--from", "2026-10-02", "--apply"], /unknown option --apply/);
	refuses("no --db", ["--driver-id", "901", "--from", "2026-10-02"], /--db is required/);
	refuses("a --driver-id that is no id", ["--db", "app", "--driver-id", "9x", "--from", "2026-10-02"], /--driver-id/);
	refuses("a --driver-id of 0", ["--db", "app", "--driver-id", "0", "--from", "2026-10-02"], /--driver-id/);
	refuses("no --from", ["--db", "app", "--driver-id", "901"], /--from/);
	refuses("a --from that is no day", ["--db", "app", "--driver-id", "901", "--from", "2026-02-30"], /--from/);
	refuses("a --json with a value", ["--db", "app", "--driver-id", "901", "--from", "2026-10-02", "--json=yes"], /--json takes no value/);
	const c = cli(["--driver-id", "901", "--from", "2026-10-02"]);
	ok("§1 the command line exits 2 without --db", c.code === 2 && /REFUSED: --db is required/.test(c.out), c.out);
	const missing = cli(["--db", path.join(tmp, "none.db"), "--driver-id", "901", "--from", "2026-10-02"]);
	ok("§1 the command line exits 2 on a missing file", missing.code === 2 && /does not exist/.test(missing.out), missing.out);
}

// ── §2 the lift ────────────────────────────────────────────────────────────────
function section2() {
	console.log("§2 the lift");
	const file = fixture();
	const db = report.openReadOnly(file);
	let w = null;
	let err = null;
	try { w = report.buildWorld({ db }); } catch (e) { err = e; }
	ok("§2 every root lifts and compiles", w && report.ROOTS.every((r) => w.liftedNames.includes(r)), err && err.message);
	ok("§2 no denied name is lifted", w && !w.liftedNames.some((n) => report.DENIED.includes(n)), w && w.liftedNames.filter((n) => report.DENIED.includes(n)));
	db.close();
}

// ── §3 read-only ───────────────────────────────────────────────────────────────
function section3() {
	console.log("§3 read-only");
	const file = fixture();
	const before = sha(file);
	const db = report.openReadOnly(file);
	ok("§3 the handle is read-only", db.readonly === true);
	let threw = false;
	try { db.prepare("UPDATE invoices SET status = 'Paid' WHERE id = 101").run(); } catch { threw = true; }
	ok("§3 a write through the handle throws", threw);
	db.close();
	run(file, { driverId: 901, from: "2026-10-02" });
	eq(sha(file), before, "§3 a module run leaves the file as it was");
	const c = cli(["--db", file, "--driver-id", "901", "--from", "2026-10-02"]);
	ok("§3 the command line exits 0", c.code === 0, c.out);
	eq(sha(file), before, "§3 a command-line run leaves the file as it was");
	ok("§3 it says nothing was written", /read-only; nothing was written/.test(c.out) && /a copy \(read-only handle\)/.test(c.out), c.out);
}

// ── §4 the lines ───────────────────────────────────────────────────────────────
function section4() {
	console.log("§4 the lines");
	const r = run(fixture(), { driverId: 901, from: "2026-10-02" });
	eq(r.driver, { userId: 901, directoryRowIds: [7], payType: "fixed", ownRateNow: 35000 }, "§4 the driver by ids");
	eq(r.rateRuns, [{ from: "2026-10-02", to: "2026-10-28", rate: 35000 }], "§4 the rate in effect from 10/2 is $350");
	eq(r.history.map((h) => [h.id, h.rate, h.day, h.source]), [[1, 30000, "2026-10-01", "data-fix"], [2, 35000, "2026-10-02", "data-fix"], [3, 35000, "2026-10-02", "seed"]], "§4 the history rows by business day");
	ok("§4 any spelling of the name is the driver's", !!lineOf(r, 101, "2026-10-02"));
	ok("§4 another driver's invoice is left out", !r.live.some((l) => l.invoiceId === 110) && !r.deleted.some((l) => l.invoiceId === 110));
	ok("§4 a day before --from is left out", !lineOf(r, 101, "2026-10-01"));
	const route = (id, day) => { const l = lineOf(r, id, day); return l && l.route ? l.route.key : l ? "ok" : "missing"; };
	eq(route(101, "2026-10-02"), "open-month-manual", "§4 Submitted, its week touching closed September: a manual invoice in the open month");
	ok("§4 that route names September and the adjust refusal", /touches closed 2026-09/.test(lineOf(r, 101, "2026-10-02").route.text) && /adjust route refuses it/.test(lineOf(r, 101, "2026-10-02").route.text));
	eq(route(102, "2026-10-06"), "next-invoice", "§4 Paid: the difference on the next invoice");
	eq(route(102, "2026-10-05"), "ok", "§4 a day at $350 is ok");
	eq(route(103, "2026-10-12"), "adjustment", "§4 Submitted, all October: an adjustment");
	eq(route(104, "2026-10-19"), "regenerate", "§4 a weekly Draft: regenerate it");
	eq(route(105, "2026-10-02"), "adjust-or-recreate", "§4 a manual Draft's day line: adjust or re-create it");
	eq(route(107, "2026-10-26"), "adjustment", "§4 Rejected, all October: an adjustment");
	const l = lineOf(r, 101, "2026-10-02");
	eq([l.days, l.used, l.correct, l.difference, l.month, l.monthClosed, l.status, l.kind], [1, 30000, 35000, 5000, "2026-10", false, "Submitted", "weekly"], "§4 a line's figures");
	eq(r.counts.liveLines, 9, "§4 nine live lines from 10/2 (a Rejected invoice's included)");
	eq(r.counts.liveLinesDiffering, 6, "§4 six differ");
	eq(r.counts.liveDifferingByStatus, { Submitted: 2, Paid: 1, Draft: 2, Rejected: 1 }, "§4 by status");
	eq(r.counts.liveDifferingByRoute, { "open-month-manual": 1, "next-invoice": 1, adjustment: 2, "adjust-or-recreate": 1, regenerate: 1 }, "§4 by route (in week order)");
	eq(r.counts.liveDifference, 30000, "§4 the difference is +$300.00 (six days at +$50)");
}

// ── §5 deleted invoices ────────────────────────────────────────────────────────
function section5() {
	console.log("§5 deleted invoices");
	const r = run(fixture(), { driverId: 901, from: "2026-10-02" });
	eq(r.deleted.map((d) => [d.invoiceId, d.day, d.used, d.correct, d.difference, d.deletedOn, d.paidByLive]),
		[[106, "2026-10-02", 30000, 35000, 5000, "2026-10-16", [101, 105]], [106, "2026-10-08", 30000, 35000, 5000, "2026-10-16", []]],
		"§5 each deleted line, and which live invoices pay its day (a Rejected one does not)");
	ok("§5 a deleted line is never a live line", !r.live.some((l) => l.invoiceId === 106));
	eq([r.counts.deletedLines, r.counts.deletedLinesDiffering, r.counts.deletedLinesOnNoLiveInvoice], [2, 2, 1], "§5 the deleted counts");
}

// ── §6 not judged ──────────────────────────────────────────────────────────────
function section6() {
	console.log("§6 not judged");
	const r = run(fixture(), { driverId: 901, from: "2026-10-02" });
	const why = r.notJudged.map((n) => [n.invoiceId, n.day || "", n.why]);
	ok("§6 a dated line that is not one day's pay", why.some((w) => w[0] === 105 && w[1] === "2026-10-03" && /not one day's pay/.test(w[2])), why);
	ok("§6 a Personal correction", why.some((w) => w[0] === 108 && /Personal correction/.test(w[2])), why);
	ok("§6 a weekly invoice with no day grid", why.some((w) => w[0] === 109 && /no daily day grid/.test(w[2])), why);
	eq(r.counts.notJudged, 3, "§6 three not judged");
}

// ── §7 a closed month, and --from 10/1 ─────────────────────────────────────────
function section7() {
	console.log("§7 a closed month, and --from 10/1");
	const file = fixture((db) => {
		db.prepare("UPDATE invoices SET render_data = ? WHERE id = 101").run(grid("2026-09-26", { "2026-09-29": 250, "2026-09-30": 300, "2026-10-01": 300, "2026-10-02": 300 }));
	});
	const r = run(file, { driverId: 901, from: "2026-09-28" });
	const sep = lineOf(r, 101, "2026-09-29");
	ok("§7 a September line at $250 against $300 differs", sep && sep.difference === 5000 && sep.monthClosed === true, sep);
	eq(sep && sep.route.key, "none-closed-month", "§7 a closed month's line gets no route");
	eq(lineOf(r, 101, "2026-09-30").route, null, "§7 a day before the first history row reads its rate ($300): ok");
	const oct1 = run(fixture(), { driverId: 901, from: "2026-10-01" });
	const l = lineOf(oct1, 101, "2026-10-01");
	eq(l && [l.used, l.correct, l.differs], [30000, 30000, false], "§7 --from 10/1: the 10/1 line at $300 matches the rate in effect that day");
	eq(oct1.rateRuns[0], { from: "2026-10-01", to: "2026-10-01", rate: 30000 }, "§7 the rate table starts at $300 on 10/1");
}

// ── §8 refusals ────────────────────────────────────────────────────────────────
function section8() {
	console.log("§8 refusals");
	const file = fixture();
	const refused = (name, opts, re, f = file) => {
		const { err } = tryRun(f, opts);
		ok(`§8 refuses ${name}`, err instanceof report.Refusal && re.test(err.message), err ? err.message : "accepted");
	};
	refused("an unknown user", { driverId: 999, from: "2026-10-02" }, /no user 999/);
	refused("a Dispatcher account", { driverId: 903, from: "2026-10-02" }, /not a Driver account/);
	refused("a driver with no Drivers Database row", { driverId: 904, from: "2026-10-02" }, /no Drivers Database row/);
	refused("a percentage driver", { driverId: 905, from: "2026-10-02" }, /percentage/);
	const noLocks = fixture((db) => db.exec("DROP TABLE period_locks"));
	refused("an unreadable period_locks", { driverId: 901, from: "2026-10-02" }, /period_locks cannot be read/, noLocks);
	const c = cli(["--db", file, "--driver-id", "903", "--from", "2026-10-02"]);
	ok("§8 the command line exits 2 on a refusal", c.code === 2 && /REFUSED: user 903 is not a Driver account/.test(c.out), c.out);
}

// ── §9 the output ──────────────────────────────────────────────────────────────
function section9() {
	console.log("§9 the output");
	const file = fixture();
	const text = cli(["--db", file, "--driver-id", "901", "--from", "2026-10-02"]).out;
	const json = cli(["--db", file, "--driver-id", "901", "--from", "2026-10-02", "--json"]).out;
	for (const [label, out] of [["text", text], ["JSON", json]]) {
		ok(`§9 ${label}: no driver name`, !/alpha|beta|gamma|delta/i.test(out), out);
		ok(`§9 ${label}: no invoice number`, !/INV-TEST/.test(out));
	}
	ok("§9 text: the driver by user and row id", /Driver: user 901, Drivers Database row 7, pay type fixed, own rate now \$350\.00/.test(text), text);
	ok("§9 text: a differing line", text.includes("invoice 101  weekly  Submitted  2026-09-26..2026-10-02  2026-10-02  1 day  $300.00 -> $350.00  +$50.00  2026-10 open  DIFFERS: "), text);
	ok("§9 text: a deleted line on no live invoice", text.includes("invoice 106  manual  Draft  deleted 2026-10-16  2026-10-08  1 day  $300.00 -> $350.00  +$50.00  no live invoice pays this day"), text);
	ok("§9 text: the counts", /Live lines: 9; differing 6.*difference \+\$300\.00/.test(text), text);
	let parsed = null;
	try { parsed = JSON.parse(json); } catch { parsed = null; }
	ok("§9 JSON parses and carries the counts", parsed && parsed.counts && parsed.counts.liveLinesDiffering === 6, json.slice(0, 300));
}

for (const s of [section1, section2, section3, section4, section5, section6, section7, section8, section9]) {
	try { s(); } catch (err) { ok(`${s.name} ran`, false, err.stack || err.message); }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
