#!/usr/bin/env node
// scripts/cancelled-loads-report.js: the read-only count report behind the
// Cancelled loads list, on a made-up copy.
//
//   §1  the counts match a hand-worked fixture: the page's buckets, the money
//       filter's parity, and what a later version could add
//   §2  what it prints: counts only, none of the fixture's IDs, names, accounts,
//       reasons or drivers
//   §3  read-only: the database opens read-only (pinned), nothing in the folder
//       changes, a missing --db is refused and never created
//   §4  the command line: --sheets-json and --values-json agree; every refused
//       argument exits 2 and touches nothing
//   §5  no network on a file run, and the requires are pinned
//
// Made-up data only, in a fresh temp folder. Never reads app.db.
//   node scripts/test-cancelled-loads-report.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "cancelled-loads-report.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const ZONE = "America/New_York";

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
// A section that throws (the script missing, a function gone) fails as a whole.
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (err) {
		failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`);
	}
}

let report = null;
let loadError = null;
try { report = require(SCRIPT); } catch (err) { loadError = err; }
ok(report, `scripts/cancelled-loads-report.js loads${loadError ? ` (${String(loadError.message).split("\n")[0]})` : ""}`);

// ── the made-up copy ──────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cancelled-loads-report-"));
const DB_FILE = path.join(TMP, "app.db");
const HEADERS = ["Load ID", "Job Status", "Driver", "Pickup Address", "Drop-off Address", "Pickup Appointment", "Broker Contact Name", "Status Update Date"];
const R = (id, status, driver = "") => [id, status, driver, "Made-up Pickup Yard, IL", "Made-up Drop Dock, IN", "09/01/2026 08:00", "Made-up Broker Agent", "09/01/2026 09:00:00"];
const ROWS = [
	R("LD-RPT-0001", "Cancelled"), // 2: Cancel button with a reason, a named account
	R("LD-RPT-0002", "Cancelled"), // 3: Cancel button before reasons, the shared login
	R("LD-RPT-0003", "canceled"), // 4: a status override, audit row only
	R("LD-RPT-0004", "Cancelled", "Made-up Driver R4"), // 5: a driver status cancel, no audit row
	R("LD-RPT-0005", "Cancelled"), // 6: no record; a dispatch-feed cancel time
	R("LD-RPT-0006", "Cancelled"), // 7: no record; a feed row from before the button cancelled
	R("LD-RPT-0007", "Cancelled"), // 8: changed after its cancel; a feed time and an audit row from another screen
	R("LD-RPT-0008", "Cancelled"), // 9: also soft-deleted; the shared login
	R("", "Cancelled"), // 10: no Load ID
	R("LD-RPT-0009", "Dispatched"), // 11: an earlier copy, live
	R("#LD-RPT-0009", "Cancelled"), // 12: the bottom copy wins
	R("LD-RPT-0010", "In Transit"), // 13: live, with a cancel on record
	R("LD-RPT-0011", "Cancelled"), // 14: an earlier copy, cancelled too
	R("LD-RPT-0011", "Cancelled"), // 15
	R("LD-RPT-0012", "Delivered"), // 16
];
const VALUES = [HEADERS, ...ROWS];

function makeDb() {
	const db = new Database(DB_FILE);
	db.exec(`
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL,
			role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
		CREATE TABLE dispatch_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', metadata TEXT DEFAULT '{}',
			read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL,
			drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL, deleted_by TEXT DEFAULT '');
	`);
	const h = db.prepare("INSERT INTO load_status_history (load_id, new_status, source, actor, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)");
	h.run("ld-rpt-0001", "Cancelled", "cancel", "made-up-admin-a", "2026-09-15 15:00:00", "Made-up reason 0001");
	h.run("ld-rpt-0002", "Cancelled", "cancel", "super_admin", "2026-07-10 15:00:00", "");
	h.run("ld-rpt-0004", "Cancelled", "manual", "Made-up Driver R4", "2026-07-20 15:00:00", "");
	h.run("ld-rpt-0007", "Cancelled", "cancel", "made-up-admin-a", "2026-08-01 12:00:00", "Made-up reason 0007");
	h.run("ld-rpt-0007", "Dispatched", "dispatch", "made-up-dispatcher-b", "2026-08-05 12:00:00", "");
	h.run("ld-rpt-0008", "Cancelled", "cancel", "super_admin", "2026-10-05 15:00:00", "Made-up reason 0008");
	h.run("ld-rpt-0010", "Cancelled", "cancel", "made-up-admin-a", "2026-08-20 15:00:00", "Made-up reason 0010");
	h.run("ld-rpt-0010", "Dispatched", "dispatch", "made-up-dispatcher-b", "2026-08-21 15:00:00", "");
	h.run("ld-rpt-0099", "Cancelled", "cancel", "made-up-admin-a", "2026-08-22 15:00:00", "Made-up reason 0099");
	const a = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 7, ?, ?, ?, ?, ?, ?)");
	a.run("2026-09-15T15:00:00.300Z", "made-up-admin-a", "Super Admin", "cancel_load", "load", "LD-RPT-0001", "Cancelled load LD-RPT-0001 (driver: Made-up Driver R1) — reason: Made-up reason 0001");
	a.run("2026-05-12T15:00:00.000Z", "made-up-dispatcher-b", "Dispatcher", "status_override", "load", "LD-RPT-0003", "Override \"Assigned\" → \"Cancelled\" by made-up-dispatcher-b: Made-up reason 0003");
	a.run("2026-08-01T12:00:00.200Z", "made-up-admin-a", "Super Admin", "cancel_load", "load", "LD-RPT-0007", "Cancelled load LD-RPT-0007 — reason: Made-up reason 0007");
	a.run("2026-08-05T12:00:00.100Z", "made-up-dispatcher-b", "Dispatcher", "dispatch_load", "load", "LD-RPT-0007", "Assigned driver Made-up Driver R7 to load LD-RPT-0007");
	a.run("2026-10-05T15:00:00.400Z", "super_admin", "Super Admin", "cancel_load", "load", "#LD-RPT-0008", "Cancelled load #LD-RPT-0008 — reason: Made-up reason 0008");
	a.run("2026-08-23T15:00:00.000Z", "made-up-admin-a", "Super Admin", "cancel_load", "load", "LD-RPT-0098", "Cancelled load LD-RPT-0098 — reason: Made-up reason 0098");
	a.run("2026-10-06T15:00:00.000Z", "made-up-admin-a", "Super Admin", "login", "user", "7", "Made-up sign-in");
	const otherAudit = (entityId, details) => a.run("2026-09-01T10:00:00.000Z", "made-up-dispatcher-b", "Dispatcher", "update_sheet_row", "sheet_row", entityId, typeof details === "string" ? details : JSON.stringify(details));
	otherAudit("Job Tracking!8", { outcome: "updated", sheet: "Job Tracking", rowIndex: 8, changed: [{ column: "Job Status", col: 1, from: "Dispatched", to: "Cancelled", why: "made-up" }], loadId: "LD-RPT-0007" });
	otherAudit("Job Tracking!14", { outcome: "updated", sheet: "Job Tracking", rowIndex: 14, changed: [{ column: "Job Status", col: 1, from: "Assigned", to: "cancelled" }] });
	otherAudit("Job Tracking!6", { outcome: "updated", sheet: "Job Tracking", rowIndex: 6, changed: [{ column: "Driver", col: 2, from: "Made-up Driver R5", to: "Made-up Driver R6" }], loadId: "LD-RPT-0005" });
	otherAudit("Drivers!3", { outcome: "updated", sheet: "Drivers", rowIndex: 3, changed: [{ column: "Status", col: 1, from: "Active", to: "Cancelled" }] });
	otherAudit("Job Tracking!9", { outcome: "updated", sheet: "Job Tracking", rowIndex: 9, changed: [{ column: "Job Status", col: 1, from: "Cancelled", to: "cancelled" }], loadId: "LD-RPT-0008" });
	otherAudit("Job Tracking!7", "not json {");
	const n = db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata, created_at) VALUES (?, ?, ?, ?, ?)");
	n.run("load-cancelled", "Cancelled Load LD-RPT-0005", "Was assigned to unknown — Made-up feed reason", JSON.stringify({ loadId: "LD-RPT-0005", driver: "", rowIndex: 6, reason: "Made-up feed reason" }), "2026-05-01 12:00:00");
	n.run("load-cancelled", "Cancelled Load LD-RPT-0006", "Was assigned to unknown", JSON.stringify({ loadId: "LD-RPT-0006", driver: "", rowIndex: 7 }), "2026-04-10 12:00:00");
	n.run("load-cancelled", "Cancelled Load LD-RPT-0007", "Was assigned to unknown — Made-up feed reason", JSON.stringify({ loadId: "LD-RPT-0007", driver: "", rowIndex: 8, reason: "Made-up feed reason" }), "2026-08-01 12:00:00");
	n.run("load-assigned", "Assigned Made-up Driver R5 to Load LD-RPT-0005", "", JSON.stringify({ loadId: "LD-RPT-0005", driver: "Made-up Driver R5", rowIndex: 6 }), "2026-05-02 12:00:00");
	n.run("load-cancelled", "Cancelled Load (made-up)", "", "{broken", "2026-06-01 12:00:00");
	const d = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, deleted_at) VALUES (?, '', ?, ?, ?)");
	d.run("LD-RPT-0001", "RATECON", "rc-made-up-0001.pdf", null);
	d.run("#LD-RPT-0002", "rate con", "rc-made-up-0002.pdf", null);
	d.run("LD-RPT-0003", "RATECON", "rc-made-up-0003.pdf", "2026-06-01 00:00:00");
	d.run("LD-RPT-0005", "POD", "pod-made-up-0005.pdf", null);
	d.run("LD-RPT-0012", "RATECON", "rc-made-up-0012.pdf", null);
	db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, ?)").run("#ld-rpt-0008", "made-up-admin-a");
	db.close();
}
makeDb();

const VALUES_FILE = path.join(TMP, "values.json");
fs.writeFileSync(VALUES_FILE, JSON.stringify({ range: "Job Tracking!A1:H16", majorDimension: "ROWS", values: VALUES }));
const sheetsDoc = (spreadsheets) => ({ format: 1, exportedAt: "2026-10-20T00:00:00.000Z", spreadsheets });
const book = (role, values) => ({ role, properties: { title: "made-up" }, sheets: [
	{ properties: { title: "Drivers" }, values: [["Name"], ["Made-up Driver R1"]] },
	{ properties: { title: "Job Tracking" }, values, formulas: {} },
] });
const SHEETS_FILE = path.join(TMP, "sheets.json");
fs.writeFileSync(SHEETS_FILE, JSON.stringify(sheetsDoc({ "made-up-main": book("main", VALUES), "made-up-archive": book("archive", [HEADERS]) })));
const TWO_MAINS = path.join(TMP, "two-mains.json");
fs.writeFileSync(TWO_MAINS, JSON.stringify(sheetsDoc({ a: book("main", VALUES), b: book("main", VALUES) })));
const NO_STATUS = path.join(TMP, "no-status.json");
fs.writeFileSync(NO_STATUS, JSON.stringify({ values: [["Load ID", "Driver"], ["LD-RPT-0001", "Made-up Driver R1"]] }));
const BARE_DB = path.join(TMP, "bare.db");
{
	const bare = new Database(BARE_DB);
	bare.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL)");
	bare.close();
}

const listing = () => fs.readdirSync(TMP).sort().map((f) => {
	const st = fs.statSync(path.join(TMP, f));
	return `${f}:${st.isDirectory() ? "dir" : st.size}:${st.mtimeMs}`;
});
const BEFORE = listing();
const DB_BYTES = fs.readFileSync(DB_FILE);

const EXPECTED = {
	sheet: { rowsRead: 15, rowsAfterDedup: 13, cancelledRowsBeforeDedup: 12 },
	cancelled: { loads: 11, alsoDeleted: 1, noLoadId: 1, earlierCopyNotCancelled: 1, moneyFilterDrops: 11, matchesMoneyFilter: true },
	recorded: { total: 5, cancelButton: 3, statusOverride: 1, driverStatus: 1 },
	time: { recorded: 5, notRecorded: 6 },
	account: { sharedLogin: 2, named: 2, notRecorded: 7 },
	reason: { recorded: 3, notRecorded: 8 },
	notRecorded: { total: 6, none: 5, changedAfter: 1, withFeedTime: { none: 1, changedAfter: 1 }, withOtherAudit: { none: 0, changedAfter: 1 } },
	byMonth: { "2026-05": 1, "2026-07": 2, "2026-09": 1, "2026-10": 1 },
	noRecordedTime: 6,
	earliestMonth: "2026-05",
	latestMonth: "2026-10",
	otherCancelAudits: { withLoadId: 1, withoutLoadId: 1 },
	cancelEventsOnLoadsNotCancelled: { total: 3, onSheet: 1, notOnSheet: 2 },
	rateConDocumentRow: 2,
};
const FIXTURE_TEXT = [/LD-RPT/i, /Made-up Driver/i, /made-up-admin/i, /made-up-dispatcher/i, /super_admin/i, /Made-up reason/i, /Made-up feed reason/i,
	/Made-up Broker Agent/i, /Made-up Pickup/i, /Made-up Drop/i, /rc-made-up|pod-made-up/i];

let built = null;
// ── §1 ────────────────────────────────────────────────────────────────────────
section("§1  the counts", () => {
	const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
	try {
		built = report.buildReport({ values: VALUES, db, zone: ZONE });
	} finally {
		db.close();
	}
	const { text: _text, generatedAt: _at, timeZone, ...counts } = built;
	eq(timeZone, ZONE, "§1 the business zone it counts months in");
	for (const k of Object.keys(EXPECTED)) eq(counts[k], EXPECTED[k], `§1 ${k}`);
	eq(Object.keys(counts).sort(), Object.keys(EXPECTED).sort(), "§1 nothing else is counted");
	ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(String(built.generatedAt)), "§1 it says when it ran");
});

// ── §2 ────────────────────────────────────────────────────────────────────────
section("§2  what it prints", () => {
	console.log(String(built.text).split("\n").map((l) => `    ${l}`).join("\n"));
	const { text: _text, ...json } = built;
	for (const [what, s] of [["the text", String(built.text)], ["the JSON", JSON.stringify(json)]]) {
		const leaks = FIXTURE_TEXT.filter((re) => re.test(s)).map(String);
		eq(leaks, [], `§2 ${what} holds none of the fixture's IDs, names, accounts, reasons, drivers or files`);
	}
	ok(/Cancelled loads/.test(built.text) && /shared login 2/.test(built.text) && /2026-05 1/.test(built.text), "§2 the text has the counts and the months");
	ok(/not read/i.test(built.text), "§2 the text says the rate-con count does not read the Drive folder");
});

// ── §3 ────────────────────────────────────────────────────────────────────────
section("§3  read-only", () => {
	eq(listing(), BEFORE, "§3 the folder is unchanged after the in-process run");
	ok(fs.readFileSync(DB_FILE).equals(DB_BYTES), "§3 the database bytes are unchanged");
	const src = fs.readFileSync(SCRIPT, "utf8");
	ok(/\{\s*readonly:\s*true,\s*fileMustExist:\s*true\s*\}/.test(src) && /!db\.readonly/.test(src), "§3 the database opens with { readonly: true, fileMustExist: true } and is refused unless db.readonly");
	ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA)\b/.test(src.replace(/^\s*\/\/.*$/gm, "")), "§3 its SQL is SELECT only (no write, ATTACH or PRAGMA)");
});

// ── §4 ────────────────────────────────────────────────────────────────────────
section("§4  the command line", () => {
	const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, APP_TIMEZONE: ZONE } });
	const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
	const viaSheets = cli(`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, "--json");
	const viaValues = cli(`--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, "--json");
	eq([viaSheets.status, viaValues.status], [0, 0], "§4 both file forms run");
	const strip = (o) => { if (!o) return o; const { generatedAt: _g, ...rest } = o; return rest; };
	const a = strip(parse(viaSheets));
	const b = strip(parse(viaValues));
	eq(a, b, "§4 the replica working copy and a saved values.get give the same report");
	eq(a && a.cancelled, EXPECTED.cancelled, "§4 the command line counts what the module does");
	ok(a && !("text" in a), "§4 --json carries no text field");
	const textRun = cli(`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`);
	ok(textRun.status === 0 && /Cancelled loads/.test(textRun.stdout) && !FIXTURE_TEXT.some((re) => re.test(textRun.stdout)), "§4 the text form runs and prints counts only");
	const missing = path.join(TMP, "missing.db");
	const refusals = [
		[[], "--db=<app.db> is required"],
		[["--db"], "--db=<app.db> is required"],
		[[`--db=${DB_FILE}`], "exactly one of"],
		[[`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, `--values-json=${VALUES_FILE}`], "exactly one of"],
		[[`--db=${DB_FILE}`, "--sheet-id=env"], "name the sheet by its ID"],
		[[`--db=${DB_FILE}`, "--sheet-id=not a sheet id"], "name the sheet by its ID"],
		[[`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, "--key=made-up-key.json"], "--key is for --sheet-id only"],
		[[`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, "--since=2026-01-01"], "unknown argument --since"],
		[[`--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, "--json=yes"], "--json takes no value"],
		[[`--db=${DB_FILE}`, "--sheets-json"], "--sheets-json needs a value"],
		[["made-up-positional"], "unknown argument"],
		[[`--db=${missing}`, `--sheets-json=${SHEETS_FILE}`], "cannot open the database read-only"],
		[[`--db=${BARE_DB}`, `--sheets-json=${SHEETS_FILE}`], "has no load_status_history"],
		[[`--db=${DB_FILE}`, `--sheets-json=${TWO_MAINS}`], "exactly one main spreadsheet"],
		[[`--db=${DB_FILE}`, `--sheets-json=${VALUES_FILE}`], "not a replica Sheets working copy"],
		[[`--db=${DB_FILE}`, `--values-json=${SHEETS_FILE}`], "holds no values.get answer"],
		[[`--db=${DB_FILE}`, `--values-json=${NO_STATUS}`], "no Load ID or status column"],
		[[`--db=${DB_FILE}`, `--values-json=${path.join(TMP, "nowhere.json")}`], "cannot read"],
	];
	for (const [args, want] of refusals) {
		const r = cli(...args);
		ok(r.status === 2 && r.stderr.includes(want), `§4 ${JSON.stringify(args.map((x) => x.split(TMP).join("<tmp>")))} is refused with exit 2 (${want})${r.status === 2 ? "" : `: exit ${r.status} ${r.stderr.slice(0, 120)}`}`);
	}
	ok(!fs.existsSync(missing), "§4 a missing database is never created");
	eq(listing(), BEFORE, "§4 the folder is unchanged after every command-line run");
	ok(fs.readFileSync(DB_FILE).equals(DB_BYTES), "§4 the database bytes are unchanged");
});

// ── §5 ────────────────────────────────────────────────────────────────────────
section("§5  no network", () => {
	ok(!Object.keys(require.cache).some((k) => /googleapis|ledger-world/.test(k)), "§5 a file run loads no Google client and not even the sheet reader");
	const src = fs.readFileSync(SCRIPT, "utf8");
	const code = src.replace(/^\s*\/\/.*$/gm, "");
	const requires = [...code.matchAll(/require\(((?:[^()]|\([^()]{0,100}\)){1,160})\)/g)].map((m) => m[1].trim()).sort();
	eq(requires, [
		"\"../lib/app-time\"", "\"../lib/cancelled-loads-view\"", "\"../lib/ratecon-load\"", "\"./lib/ledger-world\"", "\"./lib/server-lift\"", "\"./lib/server-source\"",
		"\"fs\"", "\"path\"", "path.join(ROOT, \"node_modules\", \"better-sqlite3\")",
	].sort(), "§5 it loads only fs, path, the view, app-time, ratecon-load, the lift helpers, better-sqlite3 and (for --sheet-id) the sheet reader");
	ok(!/\bfetch\s*\(|googleapis|https?:\/\/|\.env\b|settings\.env/.test(src), "§5 no fetch, Google client, URL or settings file named");
	const idx = code.indexOf("require(\"./lib/ledger-world\")");
	ok(idx > 0 && /sheet-id/.test(code.slice(Math.max(0, idx - 300), idx)), "§5 the sheet reader is loaded only on the --sheet-id path");
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
