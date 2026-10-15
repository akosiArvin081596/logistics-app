#!/usr/bin/env node
/**
 * scripts/create-correction-invoice-draft.js: its checks, its one write and its
 * command line, on a file database with the production schema of the tables it
 * reads and a fictional driver (made-up data only).
 *
 *   §1 the command line: an unknown option, a missing or malformed --invoice,
 *      --days, --rate or --date, a repeated day, more than 7 days, --data-dir
 *      without a copy and --db inside another app directory are refused (exit 2)
 *      before anything is opened;
 *   §2 the lift: every root resolves in this checkout's server.js and reaches
 *      none of the denied names (the HTTP server, the Sheets writer, the mailer,
 *      sockets);
 *   §3 the dry run (module and command line) writes nothing: no row, no audit
 *      row, no file, and prints the Draft it would create;
 *   §4 the write: ONE Draft, manual, for the original's driver, dated --date
 *      (period and issue date), one line per day dated that day with the
 *      agreed text, total = days x rate, an INV-M- number and its PDF; the
 *      original invoice and every other row unchanged; exactly one audit row, a
 *      system change naming the original's id, the days and the total;
 *   §5 idempotent: a re-run (and a re-run's dry run) prints "already drafted"
 *      and writes nothing; a correction naming some of the days refuses;
 *   §6 refusals, each writing nothing: a day the original bills, a day on
 *      another live invoice (a manual line dated that day, an undated manual
 *      line covering it), a closed-month --date, unreadable month locks, a date
 *      after today or before the week, a day outside the week, an original that
 *      is missing, deleted, Rejected, manual, adjusted or has no day grid. A
 *      Rejected or deleted invoice paying the day does not block;
 *   §7 a change between the plan and the write (made while the PDF renders) is
 *      caught inside the transaction: nothing written, no PDF left;
 *   §8 parity with POST /api/invoices/manual: the route, lifted from server.js
 *      and given the same payee, period, lines and notes on an identical
 *      database, stores the same row (every column but created_at) and the same
 *      snapshot (every key; only the issue date, which the route takes from the
 *      clock, may differ).
 *
 * Pure: a temp directory, child processes of the script itself (dry runs
 * only), no server, no network, no Chromium (the PDF renderer is a stub).
 * Run: node scripts/test-create-correction-invoice-draft.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "create-correction-invoice-draft.js");
const fix = require(SCRIPT);
const { closure } = require("./lib/server-lift");
const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-invoice-"));
const TODAY = "2026-10-15";
const OPTS = Object.freeze({ invoiceNumber: "INV-JT-2026W39-01", days: ["2026-09-28", "2026-10-02"], rate: 300, date: "2026-10-15", dryRun: false });
const PDF_STUB = Buffer.from("%PDF-1.4 stub\n");
const stubRender = async () => PDF_STUB;

// ── fixtures ──────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '');
CREATE INDEX idx_invoices_driver ON invoices(driver);
CREATE INDEX idx_invoices_week ON invoices(week_start, week_end);
CREATE UNIQUE INDEX idx_invoices_driver_week ON invoices(driver COLLATE NOCASE, week_start) WHERE deleted_at = '' AND is_manual = 0;
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT COLLATE NOCASE NOT NULL UNIQUE, carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', status TEXT DEFAULT 'active', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT NOT NULL DEFAULT '', carrier_name TEXT NOT NULL DEFAULT '', application_id INTEGER DEFAULT 0, address TEXT DEFAULT '', phone TEXT DEFAULT '', contact_title TEXT DEFAULT '');
CREATE TABLE investor_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, address TEXT DEFAULT '', phone TEXT DEFAULT '', contact_title TEXT DEFAULT '');
`;
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
function grid(billed) {
	const out = {};
	for (const d of WEEK) out[d] = billed[d] ? { loadBol: billed[d], total: 300, completed: true } : { loadBol: "", total: 0, completed: false };
	return out;
}
const weeklyRender = (name, suffix, billed, total) => JSON.stringify({ driverName: name, invoiceNumberSuffix: suffix, billingPeriodStart: "x", billingPeriodEnd: "y", totalDue: total, adjustment: 0, adjustmentNote: "", days: grid(billed), __templateName: "service_invoice" });
const manualRender = (lines, start, end) => JSON.stringify({ payeeName: "Jordan Testwell", lineItems: lines, deductions: [], subtotal: 0, deductionsTotal: 0, totalDue: 0, notes: "", preparedBy: "admin", adjustment: 0, adjustmentNote: "", billingPeriodStart: start, billingPeriodEnd: end, __templateName: "service_invoice_manual" });

let seq = 0;
function fixture(mutate) {
	const dir = path.join(tmp, `f${++seq}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-08', 'locked', '2026-09-08T05:00:00Z'), ('2026-09', 'locked', '2026-10-09T14:45:52Z')").run();
	db.prepare("INSERT INTO drivers_directory (driver_name, address, city, state, zip, phone, pay_daily) VALUES ('Jordan Testwell', '100 Sample Rd', 'Testville', 'TX', '75000', '5550100', 325), ('Avery Bramble', '200 Example Ave', 'Mockton', 'OK', '74000', '5550200', 300)").run();
	const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, render_data, is_manual)
		VALUES (@id, @invoice_number, @driver, @week_start, @week_end, @loads_count, @rate_per_load, @total_earnings, @expenses_total, @status, @pdf_file_name, @render_data, @is_manual)`);
	inv.run({ id: 70, invoice_number: "INV-JT-2026W39-01", driver: "jordan testwell", week_start: "2026-09-26", week_end: "2026-10-02", loads_count: 3, rate_per_load: 300, total_earnings: 900, expenses_total: 120.5, status: "Submitted", pdf_file_name: "INV-JT-2026W39-01.pdf", render_data: weeklyRender("Jordan Testwell", "JT-2026W39-01", { Tuesday: "L-1001", Wednesday: "L-1001, L-1002", Thursday: "L-1002" }, 900), is_manual: 0 });
	inv.run({ id: 71, invoice_number: "INV-JT-2026W40-01", driver: "jordan testwell", week_start: "2026-10-03", week_end: "2026-10-09", loads_count: 2, rate_per_load: 300, total_earnings: 600, expenses_total: 0, status: "Submitted", pdf_file_name: "INV-JT-2026W40-01.pdf", render_data: weeklyRender("Jordan Testwell", "JT-2026W40-01", { Monday: "L-1003", Tuesday: "L-1003" }, 600), is_manual: 0 });
	inv.run({ id: 72, invoice_number: "INV-AB-2026W39-01", driver: "avery bramble", week_start: "2026-09-26", week_end: "2026-10-02", loads_count: 1, rate_per_load: 300, total_earnings: 300, expenses_total: 0, status: "Approved", pdf_file_name: "INV-AB-2026W39-01.pdf", render_data: weeklyRender("Avery Bramble", "AB-2026W39-01", { Monday: "L-2001" }, 300), is_manual: 0 });
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-10-09T12:35:00Z', 1, 'admin', 'Super Admin', 'adjust_invoice_blocked', 'invoice', '70', 'made-up refusal')").run();
	if (mutate) mutate(db);
	return { dir, file, db };
}
const addInvoice = (db, o) => db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual, deleted_at)
	VALUES (@invoice_number, @driver, @week_start, @week_end, 1, 0, @total, @status, @pdf, @render_data, @is_manual, @deleted_at)`).run({ total: 0, pdf: `${o.invoice_number}.pdf`, deleted_at: "", is_manual: 1, ...o });

function snapshot(db) {
	const h = (sql) => {
		let rows;
		try { rows = db.prepare(sql).all(); } catch (err) { rows = `unreadable: ${err.message}`; }
		return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
	};
	return { invoices: h("SELECT * FROM invoices ORDER BY id"), audit: h("SELECT * FROM audit_trail ORDER BY id"), locks: h("SELECT * FROM period_locks ORDER BY period"), directory: h("SELECT * FROM drivers_directory ORDER BY id") };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const worldFor = (f, render = stubRender) => fix.buildWorld({ db: f.db, dataDir: f.dir, render }).api;
async function attempt(f, opts, render) {
	try { return { out: await fix.run(f.db, worldFor(f, render), { ...OPTS, ...opts }, { today: TODAY }) }; } catch (err) { return { err }; }
}
function cli(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

(async () => {
	// ── §1 the command line ──────────────────────────────────────────────────────
	{
		const base = ["--invoice", "INV-JT-2026W39-01", "--days", "2026-09-28,2026-10-02", "--rate", "300", "--date", "2026-10-15"];
		const ok = fix.readOptions(base);
		check("§1 a full command line reads", ok.invoiceNumber === "INV-JT-2026W39-01" && same(ok.days, ["2026-09-28", "2026-10-02"]) && ok.rate === 300 && ok.date === "2026-10-15" && ok.dryRun === false);
		check("§1 --dry-run reads", fix.readOptions([...base, "--dry-run"]).dryRun === true);
		check("§1 days are sorted", same(fix.readOptions(["--invoice", "X", "--days", "2026-10-02,2026-09-28", "--rate", "300", "--date", "2026-10-15"]).days, ["2026-09-28", "2026-10-02"]));
		const refuses = (name, argv, re) => {
			let err = null;
			try { fix.readOptions(argv); } catch (e) { err = e; }
			check(`§1 refuses ${name}`, err instanceof fix.Refusal && re.test(err.message), err ? err.message : "accepted");
		};
		const without = (flag) => { const a = [...base]; const i = a.indexOf(flag); a.splice(i, 2); return a; };
		refuses("an unknown option", [...base, "--apply"], /unknown option --apply/);
		refuses("no --invoice", without("--invoice"), /--invoice/);
		refuses("no --days", without("--days"), /--days/);
		refuses("no --rate", without("--rate"), /--rate/);
		refuses("no --date", without("--date"), /--date/);
		refuses("a day that is not a calendar day", ["--invoice", "X", "--days", "2026-09-31", "--rate", "300", "--date", "2026-10-15"], /not a calendar day/);
		refuses("a repeated day", ["--invoice", "X", "--days", "2026-09-28,2026-09-28", "--rate", "300", "--date", "2026-10-15"], /twice/);
		refuses("more than 7 days", ["--invoice", "X", "--days", "2026-09-20,2026-09-21,2026-09-22,2026-09-23,2026-09-24,2026-09-25,2026-09-26,2026-09-27", "--rate", "300", "--date", "2026-10-15"], /more than 7/);
		refuses("a zero rate", ["--invoice", "X", "--days", "2026-09-28", "--rate", "0", "--date", "2026-10-15"], /--rate/);
		refuses("a rate with 3 decimals", ["--invoice", "X", "--days", "2026-09-28", "--rate", "300.125", "--date", "2026-10-15"], /--rate/);
		refuses("a negative rate", ["--invoice", "X", "--days", "2026-09-28", "--rate=-300", "--date", "2026-10-15"], /--rate/);
		refuses("a malformed date", ["--invoice", "X", "--days", "2026-09-28", "--rate", "300", "--date", "10/15/2026"], /--date/);

		const appLike = path.join(tmp, "app-like");
		fs.mkdirSync(appLike);
		fs.writeFileSync(path.join(appLike, "server.js"), "// not an app\n");
		fs.writeFileSync(path.join(appLike, "app.db"), "");
		const inApp = cli([...base, "--dry-run", "--db", path.join(appLike, "app.db")]);
		check("§1 --db inside another app directory is refused (exit 2)", inApp.code === 2 && /another app directory/.test(inApp.out), inApp.out);
		const dataDirOnly = cli([...base, "--dry-run", "--data-dir", tmp]);
		check("§1 --data-dir without a copy is refused (exit 2)", dataDirOnly.code === 2 && /only for a copy/.test(dataDirOnly.out), dataDirOnly.out);
		const unknown = cli([...base, "--force"]);
		check("§1 the command line exits 2 on an unknown option", unknown.code === 2 && /unknown option --force/.test(unknown.out), unknown.out);
		const missing = cli([...base, "--dry-run", "--db", path.join(tmp, "nope.db")]);
		check("§1 a --db that does not exist is refused (exit 2)", missing.code === 2 && /does not exist/.test(missing.out), missing.out);
	}

	// ── §2 the lift ──────────────────────────────────────────────────────────────
	{
		const f = fixture();
		let world = null;
		let err = null;
		try { world = fix.buildWorld({ db: f.db, dataDir: f.dir, render: stubRender }); } catch (e) { err = e; }
		check("§2 every root lifts and compiles", world && fix.ROOTS.every((r) => world.liftedNames.includes(r) || (r === "renderPolicy")), err && err.message);
		check("§2 no denied name is lifted", world && !world.liftedNames.some((n) => fix.DENIED.includes(n)));
		const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
		check("§2 the INSERT is the manual route's own", SRC.includes(fix.INSERT_INVOICE.split("\n")[0]) && SRC.includes(fix.INSERT_INVOICE.split("\n")[1].trim()));
		f.db.close();
	}

	// ── §3 the dry run ───────────────────────────────────────────────────────────
	{
		const f = fixture();
		const before = snapshot(f.db);
		const { out, err } = await attempt(f, { dryRun: true }, async () => { throw new Error("the dry run rendered a PDF"); });
		check("§3 the dry run plans a draft", out && out.state === "draft", err && err.message);
		check("§3 the dry run writes nothing", same(snapshot(f.db), before) && !fs.existsSync(path.join(f.dir, "uploads")));
		const lines = out ? fix.describe(out.plan, { ...OPTS }, { pay_daily: 325 }) : [];
		check("§3 it prints the row, both lines, the total and the audit row", lines.some((l) => /INV-M-JT-2026W42-01, Draft/.test(l)) && lines.filter((l) => /Correction for INV-JT-2026W39-01:/.test(l)).length === 2
			&& lines.some((l) => /total due \$600\.00/.test(l)) && lines.some((l) => /^Audit row: create_correction_invoice/.test(l)), lines.join("\n"));
		check("§3 it notes the rates differ (directory $325)", lines.some((l) => /rates above differ/.test(l)));
		f.db.close();

		const g = fixture();
		g.db.close();
		const ro = new Database(g.file, { readonly: true });
		const roBefore = snapshot(ro);
		ro.close();
		const run = cli(["--invoice", "INV-JT-2026W39-01", "--days", "2026-09-28,2026-10-02", "--rate", "300", "--date", "2026-10-14", "--db", g.file, "--dry-run"]);
		const ro2 = new Database(g.file, { readonly: true });
		check("§3 the command-line dry run exits 0 and says so", run.code === 0 && /DRY RUN: nothing written\./.test(run.out) && /INV-M-JT-2026W42-01/.test(run.out), run.out);
		check("§3 the command-line dry run writes nothing", same(snapshot(ro2), roBefore) && !fs.existsSync(path.join(g.dir, "uploads")));
		ro2.close();
	}

	// ── §4 the write, §5 idempotent ──────────────────────────────────────────────
	{
		const f = fixture();
		const original = f.db.prepare("SELECT * FROM invoices WHERE id = 70").get();
		const others = f.db.prepare("SELECT * FROM invoices ORDER BY id").all();
		const auditBefore = f.db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
		const locksBefore = snapshot(f.db).locks;
		const { out, err } = await attempt(f, {});
		check("§4 the run writes", out && out.state === "written", err && err.message);
		const inv = out && out.invoice;
		const rd = inv ? JSON.parse(inv.render_data) : {};
		check("§4 one new invoice, in Draft, manual", f.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n === others.length + 1 && inv && inv.status === "Draft" && inv.is_manual === 1);
		check("§4 for the original's driver", inv && inv.driver === "jordan testwell" && rd.payeeName === "Jordan Testwell");
		check("§4 dated --date: period and issue date", inv && inv.week_start === "2026-10-15" && inv.week_end === "2026-10-15" && rd.billingPeriodStart === "October 15, 2026" && rd.billingPeriodEnd === "October 15, 2026" && rd.issueDate === "Oct 15, 2026", inv && `${inv.week_start} ${rd.issueDate}`);
		check("§4 an INV-M- number and its PDF name", inv && inv.invoice_number === "INV-M-JT-2026W42-01" && inv.pdf_file_name === "INV-M-JT-2026W42-01.pdf", inv && inv.invoice_number);
		check("§4 one line per day, dated that day, with the agreed text", same(rd.lineItems, [
			{ date: "2026-09-28", description: "Correction for INV-JT-2026W39-01: Monday, September 28, 2026, $300", amount: 300 },
			{ date: "2026-10-02", description: "Correction for INV-JT-2026W39-01: Friday, October 2, 2026, $300", amount: 300 },
		]), JSON.stringify(rd.lineItems));
		check("§4 total = 2 x $300, no deductions", inv && inv.total_earnings === 600 && inv.expenses_total === 0 && inv.loads_count === 2 && inv.rate_per_load === 0 && rd.totalDue === 600 && rd.subtotal === 600 && same(rd.deductions, []));
		check("§4 the notes name the original, its week and the closed month", /^Correction for INV-JT-2026W39-01 \(billing week September 26, 2026 - October 2, 2026\): 2 days that invoice did not bill, at \$300 a day\. Dated in October 2026 because September 2026 is closed\.$/.test(rd.notes), rd.notes);
		check("§4 the payee's address and phone on file", rd.payeeAddress === "100 Sample Rd, Testville, TX, 75000" && rd.payeePhone === "5550100");
		check("§4 created by the system actor, no adjustment", inv && inv.created_by === fix.ACTOR && rd.preparedBy === fix.ACTOR && inv.adjustment === 0 && rd.adjustment === 0 && rd.__templateName === "service_invoice_manual");
		check("§4 nothing submitted, approved or paid", inv && !inv.submitted_at && !inv.approved_at && !inv.paid_at && !inv.processed_at);
		check("§4 the original invoice is untouched", same(f.db.prepare("SELECT * FROM invoices WHERE id = 70").get(), original));
		check("§4 every other invoice is untouched", same(f.db.prepare("SELECT * FROM invoices WHERE id != ? ORDER BY id").all(inv ? inv.id : 0), others));
		check("§4 no lock is touched", snapshot(f.db).locks === locksBefore);
		const pdf = path.join(f.dir, "uploads", "invoices", "INV-M-JT-2026W42-01.pdf");
		check("§4 the PDF is written, and no temporary file is left", fs.existsSync(pdf) && fs.readFileSync(pdf).equals(PDF_STUB) && filesIn(path.join(f.dir, "uploads", "invoices")).length === 1);
		const audits = f.db.prepare("SELECT * FROM audit_trail WHERE id > ? ORDER BY id").all(auditBefore[auditBefore.length - 1].id);
		check("§4 exactly one audit row", audits.length === 1, String(audits.length));
		const a = audits[0] || {};
		check("§4 the audit row is a system change", a.user_id === 0 && a.username === "system: correction-invoice script" && a.role === "system" && a.action === "create_correction_invoice" && a.entity === "invoice" && a.entity_id === String(inv && inv.id));
		check("§4 the audit row names the original's id, the days and the total", /correction for INV-JT-2026W39-01 \(invoice id 70\), days 2026-09-28, 2026-10-02 at \$300\.00 = \$600\.00, dated 2026-10-15/.test(a.details || ""), a.details);
		check("§4 earlier audit rows are untouched", same(f.db.prepare("SELECT * FROM audit_trail WHERE id <= ? ORDER BY id").all(auditBefore[auditBefore.length - 1].id), auditBefore));

		const afterFirst = snapshot(f.db);
		const again = await attempt(f, {}, async () => { throw new Error("a re-run rendered a PDF"); });
		check("§5 a re-run is already drafted", again.out && again.out.state === "already" && again.out.plan.existing.invoice_number === "INV-M-JT-2026W42-01", again.err && again.err.message);
		check("§5 a re-run writes nothing", same(snapshot(f.db), afterFirst) && filesIn(path.join(f.dir, "uploads", "invoices")).length === 1);
		const againDry = await attempt(f, { dryRun: true });
		check("§5 a re-run's dry run is already drafted too", againDry.out && againDry.out.state === "already");
		const partial = await attempt(f, { days: ["2026-09-27", "2026-09-28"] });
		check("§5 a correction naming some of the days refuses", partial.err instanceof fix.Refusal && /already corrects INV-JT-2026W39-01 for 2026-09-28, 2026-10-02, which overlaps/.test(partial.err.message), partial.err ? partial.err.message : "drafted");
		check("§5 the refused overlap writes nothing", same(snapshot(f.db), afterFirst));
		f.db.close();

		// A copy on disk: the command line reports "already drafted" (exit 0).
		const run = cli(["--invoice", "INV-JT-2026W39-01", "--days", "2026-09-28,2026-10-02", "--rate", "300", "--date", "2026-10-14", "--db", f.file, "--dry-run"]);
		check("§5 the command line says already drafted (exit 0)", run.code === 0 && /already drafted: INV-M-JT-2026W42-01/.test(run.out), run.out);
	}

	// ── §6 refusals ──────────────────────────────────────────────────────────────
	{
		const refused = async (name, mutate, opts, re) => {
			const f = fixture(mutate);
			const before = snapshot(f.db);
			const { out, err } = await attempt(f, opts);
			check(`§6 refuses ${name}`, err instanceof fix.Refusal && re.test(err.message), err ? err.message : `state ${out && out.state}`);
			check(`§6 ${name}: nothing written`, same(snapshot(f.db), before) && !fs.existsSync(path.join(f.dir, "uploads")));
			f.db.close();
		};
		await refused("a day the original bills", null, { days: ["2026-09-29"] }, /INV-JT-2026W39-01 already bills Tuesday 2026-09-29/);
		await refused("a day with a manual line on another live invoice", (db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W40-01", driver: "jordan testwell", week_start: "2026-10-05", week_end: "2026-10-05", status: "Approved", render_data: manualRender([{ date: "2026-09-28", description: "Make-up day", amount: 300 }], "October 5, 2026", "October 5, 2026") }), {}, /INV-M-JT-2026W40-01 \(Approved\) has a line dated 2026-09-28/);
		await refused("a day another driver-name spelling's manual invoice pays", (db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W40-02", driver: "Jordan  Testwell", week_start: "2026-10-05", week_end: "2026-10-05", status: "Paid", render_data: manualRender([{ date: "2026-10-02", description: "Friday", amount: 300 }], "October 5, 2026", "October 5, 2026") }), {}, /has a line dated 2026-10-02/);
		await refused("an undated manual line covering the day", (db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W39-01", driver: "jordan testwell", week_start: "2026-09-01", week_end: "2026-09-30", status: "Submitted", render_data: manualRender([{ date: "", description: "September lease", amount: 1000 }], "September 1, 2026", "September 30, 2026") }), {}, /covers 2026-09-28 with an undated line/);
		await refused("a closed-month date", null, { date: "2026-09-30" }, /September 2026 is closed/);
		await refused("unreadable month locks", (db) => db.exec("DROP TABLE period_locks"), {}, /October 2026 is closed \(or the month locks can't be read\)/);
		await refused("a date after today", null, { date: "2026-10-16" }, /after today \(2026-10-15\)/);
		await refused("a date before the week", (db) => db.prepare("DELETE FROM period_locks").run(), { date: "2026-09-25" }, /before INV-JT-2026W39-01's week/);
		await refused("a day outside the week", null, { days: ["2026-10-03"] }, /2026-10-03 is not in INV-JT-2026W39-01's week \(2026-09-26 to 2026-10-02\)/);
		await refused("a missing original", null, { invoiceNumber: "INV-JT-2026W38-01" }, /INV-JT-2026W38-01 was not found/);
		await refused("a deleted original", (db) => db.prepare("UPDATE invoices SET deleted_at = '2026-10-10T00:00:00Z' WHERE id = 70").run(), {}, /is deleted/);
		await refused("a Rejected original", (db) => db.prepare("UPDATE invoices SET status = 'Rejected' WHERE id = 70").run(), {}, /is Rejected/);
		await refused("a manual original", (db) => db.prepare("UPDATE invoices SET is_manual = 1 WHERE id = 70").run(), {}, /is a manual invoice/);
		await refused("an adjusted original", (db) => db.prepare("UPDATE invoices SET adjustment = 600 WHERE id = 70").run(), {}, /carries an adjustment of \$600\.00/);
		await refused("an original with no day grid", (db) => db.prepare("UPDATE invoices SET render_data = '{}' WHERE id = 70").run(), {}, /no daily day grid/);
		await refused("an original whose grid has no line for the day", (db) => {
			const r = JSON.parse(db.prepare("SELECT render_data FROM invoices WHERE id = 70").get().render_data);
			delete r.days.Monday;
			db.prepare("UPDATE invoices SET render_data = ? WHERE id = 70").run(JSON.stringify(r));
		}, {}, /day grid has no Monday line/);

		const allowed = async (name, mutate) => {
			const f = fixture(mutate);
			const { out, err } = await attempt(f, {});
			check(`§6 ${name} does not block`, out && out.state === "written", err && err.message);
			f.db.close();
		};
		await allowed("a Rejected manual invoice paying the day", (db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W40-03", driver: "jordan testwell", week_start: "2026-10-05", week_end: "2026-10-05", status: "Rejected", render_data: manualRender([{ date: "2026-09-28", description: "Make-up day", amount: 300 }], "October 5, 2026", "October 5, 2026") }));
		await allowed("a deleted manual invoice paying the day", (db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W40-04", driver: "jordan testwell", week_start: "2026-10-05", week_end: "2026-10-05", status: "Draft", deleted_at: "2026-10-06T00:00:00Z", render_data: manualRender([{ date: "2026-10-02", description: "Friday", amount: 300 }], "October 5, 2026", "October 5, 2026") }));
		await allowed("another driver's invoice billing the day", null);
	}

	// ── §7 a change while the PDF renders ────────────────────────────────────────
	{
		const race = async (name, change, re, keep) => {
			const f = fixture();
			const before = snapshot(f.db);
			const { out, err } = await attempt(f, {}, async () => { change(f.db); return PDF_STUB; });
			check(`§7 ${name}: refused`, err && (err instanceof fix.Refusal || err.invoiceWriteRefusal) && re.test(err.message), err ? err.message : `state ${out && out.state}`);
			const rows = f.db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE 'INV-M-%' ORDER BY id").all().map((r) => r.invoice_number);
			check(`§7 ${name}: nothing of the run is written`, same(rows, keep) && snapshot(f.db).audit === before.audit, rows.join(","));
			check(`§7 ${name}: no PDF or temporary file is left`, filesIn(path.join(f.dir, "uploads", "invoices")).length === 0);
			f.db.close();
		};
		await race("a line for the day added meanwhile",
			(db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W42-09", driver: "jordan testwell", week_start: "2026-10-14", week_end: "2026-10-14", status: "Draft", render_data: manualRender([{ date: "2026-10-02", description: "Friday by hand", amount: 300 }], "October 14, 2026", "October 14, 2026") }),
			/INV-M-JT-2026W42-09 \(Draft\) has a line dated 2026-10-02/, ["INV-M-JT-2026W42-09"]);
		await race("the payee's address changed meanwhile",
			(db) => db.prepare("UPDATE drivers_directory SET address = '300 Changed St' WHERE driver_name = 'Jordan Testwell'").run(),
			/the invoices changed while this run rendered its PDF/, []);
		await race("the invoice number taken meanwhile",
			(db) => addInvoice(db, { invoice_number: "INV-M-JT-2026W42-01", driver: "jamie tobin", week_start: "2026-10-12", week_end: "2026-10-12", status: "Draft", render_data: manualRender([{ date: "", description: "Other payee", amount: 50 }], "October 12, 2026", "October 12, 2026") }),
			/INV-M-JT-2026W42-01 was given to another invoice/, ["INV-M-JT-2026W42-01"]);
	}

	// ── §8 parity with POST /api/invoices/manual ─────────────────────────────────
	{
		const scriptSide = fixture();
		const { out, err } = await attempt(scriptSide, {});
		const routeSide = fixture();
		const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
		const HEAD = 'app.post("/api/invoices/manual", requireRole("Super Admin"), async (req, res) => {';
		const provided = ["db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch", "app", "requireRole", "notifyChange", "renderPolicy"];
		let routeOut = null;
		let routeErr = null;
		try {
			const lifted = closure(SRC, { routes: [HEAD], provided, denied: fix.DENIED.filter((n) => !provided.includes(n)) });
			const handlers = {};
			const app = { post: (p, ...h) => { handlers[p] = h[h.length - 1]; } };
			const appRequire = createRequire(path.join(ROOT, "server.js"));
			new Function(...provided, `"use strict";\n${lifted.text}`)(
				routeSide.db, (m) => appRequire(m), console, { env: process.env, pid: process.pid }, ROOT, routeSide.dir,
				() => { throw new Error("fetch"); }, app, () => (q, s, n) => n && n(), () => {}, stubRender,
			);
			const p = out.plan;
			const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
			await handlers["/api/invoices/manual"]({
				body: { payee: p.payee, periodStart: OPTS.date, periodEnd: OPTS.date, lineItems: p.renderData.lineItems, deductions: [], notes: p.renderData.notes },
				session: { user: { id: 0, username: fix.ACTOR, role: "system" } },
			}, res);
			routeOut = res;
		} catch (e) { routeErr = e; }
		check("§8 the route runs on the same input", routeOut && routeOut.code === 200 && routeOut.body && routeOut.body.success, routeErr ? routeErr.message : JSON.stringify(routeOut && routeOut.body));
		if (out && routeOut && routeOut.body && routeOut.body.invoice) {
			const mine = scriptSide.db.prepare("SELECT * FROM invoices WHERE id = ?").get(out.invoice.id);
			const theirs = routeSide.db.prepare("SELECT * FROM invoices WHERE id = ?").get(routeOut.body.invoice.id);
			const cols = Object.keys(mine).filter((k) => !["created_at", "render_data"].includes(k));
			const diff = cols.filter((k) => String(mine[k]) !== String(theirs[k]));
			check("§8 the same row, every column", diff.length === 0, diff.map((k) => `${k}: ${mine[k]} vs ${theirs[k]}`).join("; "));
			const a = JSON.parse(mine.render_data);
			const b = JSON.parse(theirs.render_data);
			check("§8 the same snapshot keys", same(Object.keys(a).sort(), Object.keys(b).sort()), `${Object.keys(a)} vs ${Object.keys(b)}`);
			const differ = Object.keys(a).filter((k) => k !== "issueDate" && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
			check("§8 the same snapshot values but the issue date", differ.length === 0, differ.join(", "));
		} else {
			check("§8 both sides wrote an invoice", false, err ? err.message : "no invoice");
		}
		scriptSide.db.close();
		routeSide.db.close();
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`test-create-correction-invoice-draft: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err.stack || err.message);
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
	process.exit(1);
});
