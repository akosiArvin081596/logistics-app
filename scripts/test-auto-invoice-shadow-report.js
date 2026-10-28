#!/usr/bin/env node
// scripts/auto-invoice-shadow-report.js: the read-only report for automatic
// invoice drafts. This runner covers --retro, the sizing run on a copy.
//
//   §1  the retro sizing on made-up loads: delivered in the window (Completion
//       Date, else the POD upload, else "date unknown"), button drafts, the
//       verdict split with reasons, the A / B / C comparison and per domain
//   §2  what it prints: load IDs to their last four characters, domains only, no
//       address, name or amount
//   §3  read-only: the database opens read-only and the folder is unchanged
//   §4  the command line: --sheets-json and --values-json read the same sheet;
//       every bad argument is refused with exit 2 and touches nothing
//   §5  no network: the script loads no network module
//
// Made-up data only, in a fresh temp folder. Never reads app.db.
//   node scripts/test-auto-invoice-shadow-report.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "auto-invoice-shadow-report.js");
const report = require(SCRIPT);
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

// ------------------------------------------------------------------ fixture
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-report-"));
const DB_FILE = path.join(TMP, "app.db");
const UPLOADS = path.join(TMP, "uploads");
fs.mkdirSync(UPLOADS);
for (const f of ["pod-0001.pdf", "pod-0002.pdf", "pod-0003-none.pdf", "pod-0004.pdf", "pod-0005.pdf", "pod-0006.pdf", "pod-0007.pdf", "pod-0014.pdf", "pod-0015.pdf"]) {
	fs.writeFileSync(path.join(UPLOADS, f), "%PDF-1.4 made-up\n");
}

const HEADERS = ["Load ID", "Trailer Number", "Driver", "Drop-off Appointment", "Job Status", "Broker Contact Name", "Email",
	"Status Update Date", "Completion Date", "  Payment  "];
const BROKER = "ops@example-broker.test";
const OTHER = "dispatch@example-carrier-ops.test";
const BISON = "ops-test@bisontransport.com";
// [id, status, email, statusUpdate, completion]
const ROWS = [
	["#LD-TEST-0002", "In Transit", BROKER, "", ""],
	["LD-TEST-0001", "Delivered", BROKER, "10/01/2026 9:00:00", "10/01/2026 9:00:00"],
	["#LD-TEST-0002", "Delivered", BROKER, "10/02/2026 9:00:00", "10/02/2026 9:00:00"],
	["LD-TEST-0003", "Completed", OTHER, "10/03/2026 9:00:00", "10/03/2026 9:00:00"],
	["LD-TEST-0004", "Delivered", BISON, "10/04/2026 9:00:00", "10/04/2026 9:00:00"],
	["LD-TEST-0005", "POD Received", BROKER, "10/05/2026 9:00:00", ""],
	["LD-TEST-0006", "Delivered", "", "10/06/2026 9:00:00", "10/06/2026 9:00:00"],
	["LD-TEST-0007", "Delivered", OTHER, "10/07/2026 9:00:00", "2026-10-07"],
	["LD-TEST-0008", "Delivered", OTHER, "10/08/2026 9:00:00", "10/08/2026 9:00:00"],
	["LD-TEST-0009", "Delivered", BROKER, "10/09/2026 9:00:00", ""],
	["LD-TEST-0010", "Delivered", BROKER, "07/01/2026 9:00:00", "07/01/2026 9:00:00"],
	["LD-TEST-0011", "Cancelled", BROKER, "10/11/2026 9:00:00", "10/11/2026 9:00:00"],
	["LD-TEST-0012", "Delivered", BROKER, "10/12/2026 9:00:00", "10/12/2026 9:00:00"],
	["LD-TEST-0013", "In Transit", BROKER, "", ""],
	["LD-TEST-0014", "Delivered", OTHER, "", ""],
	["LD-TEST-0015", "Delivered", "not an email", "10/15/2026 9:00:00", "10/15/2026 9:00:00"],
];
const VALUES = [HEADERS, ...ROWS.map(([id, status, email, upd, comp]) => [id, "TR-1", "Made-up Driver", "", status, "Made-up Agent", email, upd, comp, "$1,000.00"])];

function makeDb() {
	const db = new Database(DB_FILE);
	db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
			file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT,
			total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, load_key TEXT NOT NULL, voided_at TEXT);
	`);
	const doc = db.prepare("INSERT INTO documents (load_id, type, file_name, drive_file_id, drive_url, uploaded_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
	doc.run("LD-TEST-0001", "POD", "pod-0001.pdf", "", "/uploads/pod-0001.pdf", "2026-10-01 14:00:00", null);
	doc.run("LD-TEST-0001", "RATECON", "rc-0001.pdf", "drv-made-up-1", "", "2026-09-29 14:00:00", null);
	doc.run("#LD-TEST-0002", "pod", "pod-0002.pdf", "", "", "2026-10-02 14:00:00", null);
	doc.run("LD-TEST-0003", "POD", "pod-0003-gone.pdf", "", "", "2026-10-03 14:00:00", "2026-10-03 15:00:00");
	doc.run("LD-TEST-0004", "POD", "pod-0004.pdf", "", "", "2026-10-04 14:00:00", null);
	// Evening Eastern on Oct 5 is Oct 6 in UTC: the business day is Oct 5.
	doc.run("LD-TEST-0005", "POD", "pod-0005.pdf", "", "", "2026-10-06 01:30:00", null);
	doc.run("LD-TEST-0006", "POD", "pod-0006.pdf", "", "", "2026-10-06 14:00:00", null);
	doc.run("LD-TEST-0007", "POD", "pod-0007.pdf", "", "", "2026-10-07 14:00:00", null);
	doc.run("LD-TEST-0008", "POD", "pod-0008-missing.pdf", "", "", "2026-10-08 14:00:00", null);
	doc.run("LD-TEST-0014", "POD", "pod-0014.pdf", "", "", "2026-10-14 14:00:00", null);
	doc.run("LD-TEST-0015", "POD", "pod-0015.pdf", "", "", "2026-10-15 14:00:00", null);
	doc.run("LD-TEST-0015", "BOL", "bol-0015.pdf", "", "", "2026-10-15 14:00:00", null);
	const draft = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_at, edited, edited_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	draft.run("LD-TEST-0001", "10032026-1", "billing@example-broker.test", "ratecon", "imap", "2026-10-03T15:00:00Z", 0, "");
	draft.run("LD-TEST-0004", "10052026-1", "ap@example-bison-ap.test", "default", "imap", "2026-10-05T15:00:00Z", 1, "orderNumber,poNumber");
	draft.run("LD-TEST-0005", "10062026-1", "quickpay@example-ap-inbox.test", "default", "imap", "2026-10-06T15:00:00Z", 0, "");
	draft.run("LD-TEST-0010", "10102026-1", "billing@example-broker.test", "ratecon", "imap", "2026-10-10T15:00:00Z", 0, "");
	draft.run("LD-TEST-0099", "10112026-1", "billing@example-broker.test", "ratecon", "imap", "2026-10-11T15:00:00Z", 0, "");
	draft.run("LD-TEST-0003", "06012026-1", "billing@example-carrier-ops.test", "ratecon", "imap", "2026-06-01T15:00:00Z", 0, "");
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES (?)").run("#ld-test-0012");
	db.prepare("INSERT INTO broker_invoice_lines (load_id, load_key, voided_at) VALUES (?, ?, ?)").run("LD-TEST-0007", "ld-test-0007", null);
	db.prepare("INSERT INTO broker_invoice_lines (load_id, load_key, voided_at) VALUES (?, ?, ?)").run("LD-TEST-0001", "ld-test-0001", "2026-10-01T00:00:00Z");
	db.close();
}
makeDb();

const VALUES_FILE = path.join(TMP, "values.json");
fs.writeFileSync(VALUES_FILE, JSON.stringify({ range: "Job Tracking!A1:J17", majorDimension: "ROWS", values: VALUES }));
const sheetsDoc = (spreadsheets) => ({ format: 1, exportedAt: "2026-10-20T00:00:00.000Z", spreadsheets });
const book = (role, values) => ({ role, properties: { title: "made-up" }, sheets: [
	{ properties: { title: "Drivers" }, values: [["Name"]] },
	{ properties: { title: "Job Tracking" }, values, formulas: {} },
] });
const SHEETS_FILE = path.join(TMP, "sheets.json");
fs.writeFileSync(SHEETS_FILE, JSON.stringify(sheetsDoc({ "made-up-main": book("main", VALUES), "made-up-archive": book("archive", [HEADERS]) })));
const TWO_MAINS = path.join(TMP, "two-mains.json");
fs.writeFileSync(TWO_MAINS, JSON.stringify(sheetsDoc({ a: book("main", VALUES), b: book("main", VALUES) })));

const listing = () => fs.readdirSync(TMP).sort().map((f) => {
	const st = fs.statSync(path.join(TMP, f));
	return `${f}:${st.isDirectory() ? "dir" : st.size}:${st.mtimeMs}`;
});
const BEFORE = listing();
const DB_BYTES = fs.readFileSync(DB_FILE);

// ------------------------------------------------------------------ §1
section("§1  the retro sizing");
const helpers = report.liftSheetHelpers();
const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
const zone = "America/New_York";
const r = report.buildRetro({ values: VALUES, db, uploadsDir: UPLOADS, zone, helpers, today: "2026-10-20" });
eq(r.window, { since: "2026-08-22", until: "2026-10-20", zone }, "§1 the default window is the 60 days ending today");
eq(r.delivered, { inWindow: 10, byCompletionDate: 8, byPodUpload: 2, dateUnknown: 1 }, "§1 delivered: by Completion Date, else the POD upload; one can't be placed");
eq(r.buttonDrafts, { inWindow: 5, loads: 5, deliveredLoadsWithOne: 4 }, "§1 button drafts made in the window, and delivered loads with one (any time)");
const byLoad = Object.fromEntries(r.loads.map((l) => [l.load, l]));
eq(Object.keys(byLoad).sort(), ["...0001", "...0002", "...0003", "...0004", "...0005", "...0006", "...0007", "...0008", "...0014", "...0015"],
	"§1 the loads in the window, by their last four characters (the duplicate row is one load)");
eq(byLoad["...0005"] && [byLoad["...0005"].day, byLoad["...0005"].dayFrom], ["2026-10-05", "pod"], "§1 no Completion Date: the POD's upload time, as a business day");
eq(byLoad["...0007"] && byLoad["...0007"].day, "2026-10-07", "§1 an ISO Completion Date is read too");
eq(r.verdicts.WOULD_ATTEMPT, { count: 4, reasons: {} }, "§1 WOULD_ATTEMPT: 0001, 0002, 0004 (Bison), 0005");
eq(r.verdicts.WOULD_WAIT, { count: 1, reasons: { WAITING_POD: 1 } }, "§1 WOULD_WAIT: 0003 (its only POD row was deleted)");
eq(r.verdicts.WOULD_NEED_ATTENTION, { count: 5, reasons: { NO_BROKER_EMAIL: 2, ADVANCE_LINES: 1, POD_UNREADABLE: 1, NO_DELIVERY_DATE: 1 } },
	"§1 WOULD_NEED_ATTENTION: 0006 and 0015 no broker Email, 0007 an advance line, 0008 its POD file gone, 0014 no delivery date");
eq(r.verdicts.WOULD_SKIP, { count: 0, reasons: {} }, "§1 nothing skipped: no opt-outs yet, and a hand draft doesn't count");
eq(r.attemptDetail, { bison: 1, otherWithRateConOnFile: 1, otherRateConFromDriveOrNone: 2 }, "§1 WOULD_ATTEMPT detail");
eq(r.handDraftCompare, { drafted: 3, A: 1, B: 1, C: 1, editedFields: { orderNumber: 1, poNumber: 1 } }, "§1 (A) 0001 same; (B) 0005 went to the default inbox; (C) 0004 edited");
eq([byLoad["...0001"].compare, byLoad["...0004"].compare, byLoad["...0005"].compare, byLoad["...0002"].compare], ["A", "C", "B", null], "§1 the comparison per load");
eq(r.medianDaysToHandDraft, 1, "§1 median days from delivered to the first button draft");
const dom = Object.fromEntries(r.perDomain.map((d) => [d.domain, d]));
eq(dom["example-broker.test"], { domain: "example-broker.test", delivered: 3, wouldAttempt: 3, withButtonDraft: 2, buttonDraftsInWindow: 3 }, "§1 per domain: the broker's delivered loads and drafts");
eq(dom["example-carrier-ops.test"], { domain: "example-carrier-ops.test", delivered: 4, wouldAttempt: 0, withButtonDraft: 1, buttonDraftsInWindow: 0 }, "§1 per domain: a draft before the window counts for the load, not the window");
eq(dom["bisontransport.com"], { domain: "bisontransport.com", delivered: 1, wouldAttempt: 1, withButtonDraft: 1, buttonDraftsInWindow: 1 }, "§1 per domain: Bison");
eq(dom["(no broker email)"], { domain: "(no broker email)", delivered: 2, wouldAttempt: 0, withButtonDraft: 0, buttonDraftsInWindow: 0 }, "§1 per domain: loads with no readable broker Email");
eq(dom["(not on the sheet)"], { domain: "(not on the sheet)", delivered: 0, wouldAttempt: 0, withButtonDraft: 0, buttonDraftsInWindow: 1 }, "§1 per domain: a draft for a load not on the sheet");
eq(r.dateUnknown, { count: 1, verdicts: { WOULD_ATTEMPT: { count: 0, reasons: {} }, WOULD_WAIT: { count: 1, reasons: { WAITING_POD: 1 } }, WOULD_NEED_ATTENTION: { count: 0, reasons: {} }, WOULD_SKIP: { count: 0, reasons: {} } } }, "§1 date unknown: 0009, counted on its own");
ok(!byLoad["...0010"] && !byLoad["...0011"] && !byLoad["...0012"] && !byLoad["...0013"], "§1 out of window, cancelled, soft-deleted and in transit loads are not counted");
const narrow = report.buildRetro({ values: VALUES, db, uploadsDir: UPLOADS, zone, helpers, since: "2026-10-04", until: "2026-10-05", today: "2026-10-20" });
eq(narrow.loads.map((l) => l.load).sort(), ["...0004", "...0005"], "§1 --since/--until bound the window, both days included");
const unchecked = report.buildRetro({ values: VALUES, db, uploadsDir: "", zone, helpers, today: "2026-10-20" });
eq([unchecked.podFilesChecked, unchecked.verdicts.WOULD_NEED_ATTENTION.reasons.POD_UNREADABLE || 0], [false, 0], "§1 without --uploads a POD row counts as readable, and the report says so");
ok(/POD files: not checked/.test(unchecked.text), "§1 the text says the POD files were not checked");

// ------------------------------------------------------------------ §2
section("§2  what it prints");
console.log(r.text.split("\n").map((l) => `    ${l}`).join("\n"));
const printed = [r.text, JSON.stringify({ ...r, text: undefined })];
for (const [i, s] of printed.entries()) {
	const what = i ? "the JSON" : "the text";
	ok(!/@/.test(s), `§2 ${what} holds no email address`);
	ok(!/LD-TEST-00\d\d/i.test(s), `§2 ${what} holds no full load ID`);
	ok(!/\$|1,000|1000\.00/.test(s), `§2 ${what} holds no amount`);
	ok(!/Made-up (Driver|Agent)/.test(s), `§2 ${what} holds no driver or agent name`);
	ok(!/10032026-1|10052026-1/.test(s), `§2 ${what} holds no invoice number`);
}
ok(/WOULD_ATTEMPT\s+4/.test(r.text) && /example-broker\.test/.test(r.text), "§2 the text has the split and the domains");

// ------------------------------------------------------------------ §3
section("§3  read-only");
ok(db.readonly, "§3 the test's handle is read-only");
db.close();
eq(listing(), BEFORE, "§3 the folder is unchanged after the in-process runs");
ok(fs.readFileSync(DB_FILE).equals(DB_BYTES), "§3 the database bytes are unchanged");

// ------------------------------------------------------------------ §4
section("§4  the command line");
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, APP_TIMEZONE: zone } });
const viaSheets = cli("--retro", `--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, `--uploads=${UPLOADS}`, "--since=2026-08-22", "--until=2026-10-20", "--json");
eq(viaSheets.status, 0, "§4 --sheets-json runs");
const viaValues = cli("--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, `--uploads=${UPLOADS}`, "--since=2026-08-22", "--until=2026-10-20", "--json");
eq(viaValues.status, 0, "§4 --values-json runs");
let a = null;
let b = null;
try { a = JSON.parse(viaSheets.stdout); b = JSON.parse(viaValues.stdout); } catch { /* compared below */ }
eq(a, b, "§4 the replica working copy and a saved values.get give the same report");
eq(a && a.delivered, r.delivered, "§4 the command line reports what the module does");
ok(a && !("text" in a), "§4 --json carries no text field");
const textRun = cli("--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, "--since=2026-08-22", "--until=2026-10-20");
ok(textRun.status === 0 && /retro sizing/.test(textRun.stdout), "§4 the text form runs");
const refusals = [
	[[], "only --retro"],
	[["--retro"], "--db"],
	[["--retro", `--db=${DB_FILE}`], "--sheets-json=<file> or --values-json"],
	[["--retro", `--db=${DB_FILE}`, `--sheets-json=${SHEETS_FILE}`, `--values-json=${VALUES_FILE}`], "not both"],
	[["--retro", `--db=${DB_FILE}`, `--sheets-json=${TWO_MAINS}`], "exactly one main"],
	[["--retro", `--db=${DB_FILE}`, `--sheets-json=${VALUES_FILE}`], "not a replica Sheets working copy"],
	[["--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, "--since=2026-02-30"], "calendar day"],
	[["--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, "--since=2026-10-10", "--until=2026-10-01"], "after --until"],
	[["--retro", `--db=${path.join(TMP, "missing.db")}`, `--values-json=${VALUES_FILE}`], "read-only"],
	[["--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, `--uploads=${VALUES_FILE}`], "not a folder"],
	[["--retro", `--db=${DB_FILE}`, `--values-json=${VALUES_FILE}`, "--sheet-id=made-up"], "unknown argument --sheet-id"],
	[["--retro", "--db"], "--db=<app.db>"],
];
for (const [args, want] of refusals) {
	const run = cli(...args);
	ok(run.status === 2 && run.stderr.includes(want), `§4 ${JSON.stringify(args.map((x) => x.replace(TMP, "<tmp>")))} is refused (${want})`);
}
ok(!fs.existsSync(path.join(TMP, "missing.db")), "§4 a missing database is never created");
eq(listing(), BEFORE, "§4 the folder is unchanged after every command-line run");

// ------------------------------------------------------------------ §5
section("§5  no network");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const requires = [...SRC.matchAll(/require\(((?:[^()]|\([^()]{0,100}\)){1,160})\)/g)].map((m) => m[1].trim()).sort();
eq(requires, [
	"\"../lib/app-time\"", "\"../lib/auto-invoice-rules\"", "\"./lib/server-lift\"", "\"fs\"", "\"path\"",
	"path.join(ROOT, \"node_modules\", \"better-sqlite3\")",
].sort(), "§5 it loads only fs, path, the rules, app-time, server-lift and better-sqlite3");
ok(!/\bfetch\s*\(|googleapis|https?:\/\/|\.env\b/.test(SRC), "§5 no fetch, Google client, URL or settings file");

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
