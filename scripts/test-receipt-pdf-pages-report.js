#!/usr/bin/env node
/**
 * scripts/receipt-pdf-pages-report.js (driver privacy PR B's read-only "what
 * would change" report), run on a made-up database and made-up receipt PDFs:
 *   - both paths are required (exit 2 without them; no default target);
 *   - the database is opened read-only: its bytes are the same after the run
 *     and no journal file appears;
 *   - it prints ids and counts only: no name, amount, vendor or page text;
 *   - the counts: a 3-page statement naming another driver (STATEMENT and
 *     OTHER_PERSON; nothing auto-released), a clean 1-page receipt (auto-
 *     released; its open invoice listed), a PDF with no Personal line (counted,
 *     not listed), and the stored-file line (no render record, nothing rewritten).
 * Run: node scripts/test-receipt-pdf-pages-report.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const { receiptPdf } = require("./lib/receipt-privacy-world");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`  ok    ${label}`); return; }
	fail++;
	console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

const SCRIPT = path.join(__dirname, "receipt-pdf-pages-report.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-pdf-pages-report-"));
const DB = path.join(TMP, "made-up.db");
const RECEIPTS = path.join(TMP, "expense-receipts");
fs.mkdirSync(RECEIPTS);

const db = new Database(DB);
db.exec(`
	CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, driver_name TEXT DEFAULT '', full_name TEXT DEFAULT '');
	CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT);
	CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, license_plate TEXT DEFAULT '', vin TEXT DEFAULT '', assigned_driver TEXT DEFAULT '');
	CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT, amount REAL, date TEXT, vendor TEXT, truck_unit TEXT, photo_data TEXT, receipt_details TEXT DEFAULT '');
	CREATE TABLE invoices (id INTEGER PRIMARY KEY, status TEXT, deleted_at TEXT DEFAULT '');
	CREATE TABLE expense_personal (id INTEGER PRIMARY KEY, expense_id INTEGER, invoice_id INTEGER, voided_at TEXT DEFAULT '');
`);
db.prepare("INSERT INTO users (id, role, driver_name) VALUES (1, 'Driver', 'Test Driver A'), (2, 'Driver', 'Test Driver B')").run();
db.prepare("INSERT INTO trucks (unit_number, license_plate, vin, assigned_driver) VALUES ('T-1', 'ABC1234', '1FUJGLDR0CSBM0001', 'Test Driver A')").run();
const put = (id, bytes) => {
	fs.writeFileSync(path.join(RECEIPTS, `made-up-${id}.pdf`), bytes);
	return `/uploads/expense-receipts/made-up-${id}.pdf`;
};
const exp = db.prepare("INSERT INTO expenses (id, driver, amount, date, vendor, truck_unit, photo_data) VALUES (?, ?, ?, ?, ?, ?, ?)");
exp.run(1, "Test Driver A", 200, "2026-10-12", "Pilot #123", "T-1", put(1, receiptPdf([
	["FLEET TOLL STATEMENT", "10/12/2026 PILOT #123 $200.00", "10/13/2026 PLAZA 4 $4.50"],
	["ACCOUNT HOLDER TEST DRIVER B", "10/05/2026 PLAZA 9 $6.25", "10/06/2026 PLAZA 9 $6.25"],
	["10/14/2026 PLAZA 2 $3.00", "10/15/2026 PLAZA 2 $3.00"],
])));
exp.run(2, "Test Driver A", 45.5, "2026-10-13", "Love's #77", "T-1", put(2, receiptPdf([["LOVE'S #77", "10/13/2026 09:02", "TOTAL $45.50"]])));
exp.run(3, "Test Driver B", 30, "2026-10-13", "Diner #2", "", put(3, receiptPdf([["DINER #2", "10/13/2026", "TOTAL $30.00"]])));
exp.run(4, "Test Driver A", 12, "2026-10-13", "Shop", "T-1", "/uploads/expense-receipts/made-up-4.jpg");
db.prepare("INSERT INTO invoices (id, status) VALUES (10, 'Approved'), (11, 'Draft')").run();
db.prepare("INSERT INTO expense_personal (expense_id, invoice_id) VALUES (1, 10), (2, 11)").run();
db.close();

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const before = sha(DB);
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120000 });

const usage = run();
check("no paths: usage, exit 2", [usage.status, /usage:/.test(usage.stderr)], [2, true]);
const onlyDb = run("--db", DB);
check("the receipts folder is required too", onlyDb.status, 2);

const text = run("--db", DB, "--receipts-dir", RECEIPTS);
check("the report runs (exit 0)", [text.status, text.stderr.trim()], [0, ""]);
const out = text.stdout;
check("ids and counts only: no name, amount, vendor, file name or page text",
	[out.length > 0, /Test Driver|TEST DRIVER|200\.00|45\.50|\$|Pilot|PILOT|Love's|LOVE'S|Diner|DINER|made-up|PLAZA|FLEET TOLL|ACCOUNT HOLDER|ABC1234|1FUJGLDR/.test(out)], [true, false]);
check("the lines the report promises",
	["roster:", "PDF receipts on file: 3;", "their pages by verdict:", "Personal PDF receipts (live lines): 2", "  expense 1: 3 pages", "  expense 2: 1 pages", "pages a Super Admin must mark", "open invoices whose next render would carry released PDF pages: 11", "stored invoice PDFs rewritten at the switch: 0 (render records now: table not there yet"]
		.every((s) => out.includes(s)), true);
check("the database is untouched: same bytes, no journal left", [sha(DB) === before, fs.existsSync(`${DB}-journal`), fs.existsSync(`${DB}-wal`)], [true, false, false]);

const json = run("--db", DB, "--receipts-dir", RECEIPTS, "--json");
let report = null;
try { report = JSON.parse(json.stdout); } catch { report = null; }
const byExpense = (id) => ((report && report.personal) || []).find((p) => p.expense === id) || {};
check("the statement: 3 pages, page 2 names another driver, nothing auto-released; its invoice is Approved",
	[byExpense(1).pages, byExpense(1).codes && byExpense(1).codes.OTHER_PERSON, byExpense(1).autoReleased, byExpense(1).invoices], [3, 1, 0, [{ id: 10, status: "Approved" }]]);
check("the clean receipt: auto-released, its Draft listed; the PDF with no Personal line counted, not listed",
	[byExpense(2).codes, byExpense(2).autoReleased, report && report.openInvoicesWithReleasedPages, report && report.pdfReceipts, report && report.personal.length],
	[{ AUTO_RELEASED: 1 }, 1, [11], 3, 2]);
check("the source opens the database read-only and must find it", fs.readFileSync(SCRIPT, "utf8").includes("{ readonly: true, fileMustExist: true }"), true);

const all = run("--db", DB, "--receipts-dir", RECEIPTS, "--json", "--all");
let census = null;
try { census = JSON.parse(all.stdout).receipts; } catch { census = null; }
check("--all: every PDF receipt's codes page by page, ids and codes only (the census input)",
	census && census.map((r) => [r.expense, r.codes]), [[1, ["STATEMENT", "OTHER_PERSON", "UNREADABLE"]], [2, ["AUTO_RELEASED"]], [3, ["AUTO_RELEASED"]]]);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
