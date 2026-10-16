#!/usr/bin/env node
/**
 * scripts/create-correction-invoice-draft.js: its checks, its one write and its
 * command line, on a file database with the production schema of the tables it
 * reads and a fictional driver (made-up data only: an invented week, rate and
 * day count, round lock times).
 *
 *   §1 the command line: an unknown option, a missing or malformed --invoice,
 *      --days, --rate or --date, a repeated day, more than 7 days, --data-dir
 *      without a copy, --db inside another app directory or missing are refused
 *      (exit 2) before anything is opened. Where the database may be: with
 *      LOCAL_REPLICA set, no --db is refused and a plain copy still runs; a copy
 *      or a --data-dir inside the repository is refused;
 *   §2 the lift: every root resolves in this checkout's server.js and reaches
 *      none of the denied names (the HTTP server, the Sheets writer, the mailer,
 *      sockets); the INSERT is the manual route's;
 *   §3 the dry run (module and command line) writes nothing: no row, no audit
 *      row, no file, and prints the Draft it would create and the driver's live
 *      manual invoices from the original's week on;
 *   §4 the write: ONE Draft, manual, for the original's driver, dated --date
 *      (period and issue date), one line per day dated that day with the agreed
 *      text, total = days x rate, an INV-M- number and its PDF, "Prepared by"
 *      LogisX correction (script); the original invoice and every other row
 *      unchanged; exactly one audit row, a system change naming the original's
 *      id, the days and the total;
 *   §5 idempotent, before any date check: a re-run (also after the month closed,
 *      or with a later --date) prints "already drafted" with the total and
 *      writes nothing; the same days at another rate refuse; a correction naming
 *      some of the days refuses;
 *   §6 refusals, each writing nothing: a day the original bills; a day on
 *      another live invoice (a weekly invoice under another spelling of the
 *      driver's name whose grid bills it, or which has no grid; a manual line
 *      dated that day; an undated manual line covering it; a manual line or
 *      notes naming the original and the day in another format, or the
 *      original with no readable date); a closed-month --date, unreadable month
 *      locks, a date after today or before the week, a day outside the week, an
 *      original that is missing, deleted, Rejected, manual, adjusted, has no day
 *      grid or no line for the day. A Rejected or deleted invoice paying the
 *      day, another driver's, and a manual line naming the original for another
 *      day do not block;
 *   §7 a change between the plan and the write (made while the PDF renders) is
 *      caught inside the transaction: nothing written, no PDF left;
 *   §8 parity with POST /api/invoices/manual: the route, lifted from server.js
 *      and given the same payee, period, lines and notes on an identical
 *      database, stores the same row (every column but created_at) and the same
 *      snapshot (every key; the issue date, which the route takes from the
 *      clock, and "Prepared by", which it takes from the session, may differ);
 *   §9 namesDay() reads 6/1, 06/01/26, 6/1/2026, June 1, Jun. 01 and the ISO
 *      day, and not another year, 16/1, 6/10, Junebug 1 or June 12; an original
 *      invoice number holding . + ( ) [ ] * drafts and re-runs as written, a
 *      look-alike of it in a manual line does not block, the exact number with
 *      the day does.
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
const { replicaFlagSet } = require("./lib/app-database");
const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-invoice-"));
// The invented case: week Sat 2026-05-30 to Fri 2026-06-05 (May is closed),
// the original bills Tuesday and Wednesday at $275, the correction adds
// Sunday, Monday and Friday, dated 2026-06-17.
const ORIGINAL = "INV-JT-2026W22-01";
const TODAY = "2026-06-18";
const OPTS = Object.freeze({ invoiceNumber: ORIGINAL, days: ["2026-05-31", "2026-06-01", "2026-06-05"], rate: 275, date: "2026-06-17", dryRun: false });
const NEW_NUMBER = "INV-M-JT-2026W25-01";
const PDF_STUB = Buffer.from("%PDF-1.4 stub\n");
const stubRender = async () => PDF_STUB;
const CLI_BASE = ["--invoice", ORIGINAL, "--days", "2026-05-31,2026-06-01,2026-06-05", "--rate", "275", "--date", "2026-06-17"];

// ── fixtures ──────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0, rate_per_load REAL NOT NULL DEFAULT 250.00, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')), rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]', expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '', personal_total REAL NOT NULL DEFAULT 0, personal_share_total REAL NOT NULL DEFAULT 0, correction_of INTEGER, is_correction INTEGER NOT NULL DEFAULT 0);
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
function grid(billed, rate) {
	const out = {};
	for (const d of WEEK) out[d] = billed[d] ? { loadBol: billed[d], total: rate, completed: true } : { loadBol: "", total: 0, completed: false };
	return out;
}
const weeklyRender = (name, suffix, billed, total, rate = 275) => JSON.stringify({ driverName: name, invoiceNumberSuffix: suffix, billingPeriodStart: "x", billingPeriodEnd: "y", totalDue: total, adjustment: 0, adjustmentNote: "", days: grid(billed, rate), __templateName: "service_invoice" });
const manualRender = (lines, start, end, notes = "") => JSON.stringify({ payeeName: "Jordan Testwell", lineItems: lines, deductions: [], subtotal: 0, deductionsTotal: 0, totalDue: 0, notes, preparedBy: "admin", adjustment: 0, adjustmentNote: "", billingPeriodStart: start, billingPeriodEnd: end, __templateName: "service_invoice_manual" });

let seq = 0;
function fixture(mutate) {
	const dir = path.join(tmp, `f${++seq}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-04', 'locked', '2026-05-08T04:00:00Z'), ('2026-05', 'locked', '2026-06-08T04:00:00Z')").run();
	db.prepare("INSERT INTO drivers_directory (driver_name, address, city, state, zip, phone, pay_daily) VALUES ('Jordan Testwell', '100 Sample Rd', 'Testville', 'TX', '75000', '5550100', 290), ('Avery Bramble', '200 Example Ave', 'Mockton', 'OK', '74000', '5550200', 260)").run();
	const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, render_data, is_manual)
		VALUES (@id, @invoice_number, @driver, @week_start, @week_end, @loads_count, @rate_per_load, @total_earnings, @expenses_total, @status, @pdf_file_name, @render_data, @is_manual)`);
	inv.run({ id: 70, invoice_number: ORIGINAL, driver: "jordan testwell", week_start: "2026-05-30", week_end: "2026-06-05", loads_count: 2, rate_per_load: 275, total_earnings: 550, expenses_total: 64.25, status: "Approved", pdf_file_name: `${ORIGINAL}.pdf`, render_data: weeklyRender("Jordan Testwell", "JT-2026W22-01", { Tuesday: "T-501", Wednesday: "T-501, T-502" }, 550), is_manual: 0 });
	inv.run({ id: 71, invoice_number: "INV-JT-2026W23-01", driver: "jordan testwell", week_start: "2026-06-06", week_end: "2026-06-12", loads_count: 2, rate_per_load: 275, total_earnings: 550, expenses_total: 0, status: "Submitted", pdf_file_name: "INV-JT-2026W23-01.pdf", render_data: weeklyRender("Jordan Testwell", "JT-2026W23-01", { Monday: "T-503", Tuesday: "T-503" }, 550), is_manual: 0 });
	inv.run({ id: 72, invoice_number: "INV-AB-2026W22-01", driver: "avery bramble", week_start: "2026-05-30", week_end: "2026-06-05", loads_count: 1, rate_per_load: 260, total_earnings: 260, expenses_total: 0, status: "Paid", pdf_file_name: "INV-AB-2026W22-01.pdf", render_data: weeklyRender("Avery Bramble", "AB-2026W22-01", { Monday: "T-601" }, 260, 260), is_manual: 0 });
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-06-06T15:00:00Z', 1, 'admin', 'Super Admin', 'submit_invoice', 'invoice', '70', 'made-up submit')").run();
	if (mutate) mutate(db);
	return { dir, file, db };
}
const addInvoice = (db, o) => db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual, deleted_at)
	VALUES (@invoice_number, @driver, @week_start, @week_end, 1, 0, @total, @status, @pdf, @render_data, @is_manual, @deleted_at)`).run({ total: 0, pdf: `${o.invoice_number}.pdf`, deleted_at: "", is_manual: 1, ...o });
const manual = (number, lines, { status = "Draft", driver = "jordan testwell", start = "2026-06-10", end = start, notes = "", deleted_at = "", total = 0 } = {}) =>
	(db) => addInvoice(db, { invoice_number: number, driver, week_start: start, week_end: end, status, deleted_at, total, render_data: manualRender(lines, start, end, notes) });

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
async function attempt(f, opts, render, today = TODAY) {
	try { return { out: await fix.run(f.db, worldFor(f, render), { ...OPTS, ...opts }, { today }) }; } catch (err) { return { err }; }
}
// A child with no LOCAL_REPLICA and no DATABASE_PATH unless given.
function cli(args, env = {}) {
	const base = { ...process.env };
	delete base.LOCAL_REPLICA;
	delete base.DATABASE_PATH;
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: "utf8", timeout: 60000, env: { ...base, ...env } });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

(async () => {
	// ── §1 the command line ──────────────────────────────────────────────────────
	{
		const ok = fix.readOptions(CLI_BASE);
		check("§1 a full command line reads", ok.invoiceNumber === ORIGINAL && same(ok.days, OPTS.days) && ok.rate === 275 && ok.date === "2026-06-17" && ok.dryRun === false);
		check("§1 --dry-run reads", fix.readOptions([...CLI_BASE, "--dry-run"]).dryRun === true);
		check("§1 days are sorted", same(fix.readOptions(["--invoice", "X", "--days", "2026-06-05,2026-05-31", "--rate", "275", "--date", "2026-06-17"]).days, ["2026-05-31", "2026-06-05"]));
		const refuses = (name, argv, re) => {
			let err = null;
			try { fix.readOptions(argv); } catch (e) { err = e; }
			check(`§1 refuses ${name}`, err instanceof fix.Refusal && re.test(err.message), err ? err.message : "accepted");
		};
		const without = (flag) => { const a = [...CLI_BASE]; const i = a.indexOf(flag); a.splice(i, 2); return a; };
		refuses("an unknown option", [...CLI_BASE, "--apply"], /unknown option --apply/);
		refuses("no --invoice", without("--invoice"), /--invoice/);
		refuses("no --days", without("--days"), /--days/);
		refuses("no --rate", without("--rate"), /--rate/);
		refuses("no --date", without("--date"), /--date/);
		refuses("a day that is not a calendar day", ["--invoice", "X", "--days", "2026-06-31", "--rate", "275", "--date", "2026-06-17"], /not a calendar day/);
		refuses("a repeated day", ["--invoice", "X", "--days", "2026-06-01,2026-06-01", "--rate", "275", "--date", "2026-06-17"], /twice/);
		refuses("more than 7 days", ["--invoice", "X", "--days", "2026-05-29,2026-05-30,2026-05-31,2026-06-01,2026-06-02,2026-06-03,2026-06-04,2026-06-05", "--rate", "275", "--date", "2026-06-17"], /more than 7/);
		refuses("a zero rate", ["--invoice", "X", "--days", "2026-06-01", "--rate", "0", "--date", "2026-06-17"], /--rate/);
		refuses("a rate with 3 decimals", ["--invoice", "X", "--days", "2026-06-01", "--rate", "275.125", "--date", "2026-06-17"], /--rate/);
		refuses("a negative rate", ["--invoice", "X", "--days", "2026-06-01", "--rate=-275", "--date", "2026-06-17"], /--rate/);
		refuses("a malformed date", ["--invoice", "X", "--days", "2026-06-01", "--rate", "275", "--date", "6/17/2026"], /--date/);

		const appLike = path.join(tmp, "app-like");
		fs.mkdirSync(appLike);
		fs.writeFileSync(path.join(appLike, "server.js"), "// not an app\n");
		fs.writeFileSync(path.join(appLike, "app.db"), "");
		const inApp = cli([...CLI_BASE, "--dry-run", "--db", path.join(appLike, "app.db")]);
		check("§1 --db inside another app directory is refused (exit 2)", inApp.code === 2 && /another app directory/.test(inApp.out), inApp.out);
		const dataDirOnly = cli([...CLI_BASE, "--dry-run", "--data-dir", tmp]);
		check("§1 --data-dir without a copy is refused (exit 2)", dataDirOnly.code === 2 && /only for a copy/.test(dataDirOnly.out), dataDirOnly.out);
		const unknown = cli([...CLI_BASE, "--force"]);
		check("§1 the command line exits 2 on an unknown option", unknown.code === 2 && /unknown option --force/.test(unknown.out), unknown.out);
		const missing = cli([...CLI_BASE, "--dry-run", "--db", path.join(tmp, "nope.db")]);
		check("§1 a --db that does not exist is refused (exit 2)", missing.code === 2 && /does not exist/.test(missing.out), missing.out);

		// LOCAL_REPLICA: the app's own database is refused, a plain copy still runs.
		check("§1 LOCAL_REPLICA=1 (and a stray value) count as set; unset, empty, 0 and off do not",
			replicaFlagSet({ LOCAL_REPLICA: "1" }) && replicaFlagSet({ LOCAL_REPLICA: "yes" }) && !replicaFlagSet({}) && !replicaFlagSet({ LOCAL_REPLICA: "" }) && !replicaFlagSet({ LOCAL_REPLICA: "0" }) && !replicaFlagSet({ LOCAL_REPLICA: "off" }));
		const replicaNoDb = cli([...CLI_BASE, "--dry-run"], { LOCAL_REPLICA: "1" });
		check("§1 LOCAL_REPLICA set and no --db is refused (exit 2)", replicaNoDb.code === 2 && /LOCAL_REPLICA is set/.test(replicaNoDb.out), replicaNoDb.out);
		const copy = fixture();
		copy.db.close();
		const replicaNamed = cli([...CLI_BASE, "--dry-run", "--db", copy.file], { LOCAL_REPLICA: "1", DATABASE_PATH: copy.file });
		check("§1 LOCAL_REPLICA set and --db naming the replica's own database is refused", replicaNamed.code === 2 && /LOCAL_REPLICA is set/.test(replicaNamed.out), replicaNamed.out);
		const replicaCopy = cli([...CLI_BASE, "--dry-run", "--db", copy.file], { LOCAL_REPLICA: "1" });
		check("§1 LOCAL_REPLICA set and a plain copy named with --db runs the dry run", replicaCopy.code === 0 && /DRY RUN: nothing written\./.test(replicaCopy.out), replicaCopy.out);
		// Inside the repository (a pretend one under the temp directory).
		const repo = path.join(tmp, "pretend-repo");
		fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
		fs.writeFileSync(path.join(repo, "sub", "app.db"), "");
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "app.db"), "");
		const resolveErr = (o) => { try { fix.resolveTarget(o, repo, { env: {} }); return null; } catch (e) { return e; } };
		const inRepo = resolveErr({ db: path.join(repo, "sub", "app.db"), dataDir: null });
		check("§1 a copy inside the repository is refused", inRepo instanceof fix.Refusal && /inside the repository/.test(inRepo.message), inRepo && inRepo.message);
		const dataInRepo = resolveErr({ db: path.join(outside, "app.db"), dataDir: path.join(repo, "sub") });
		check("§1 a --data-dir inside the repository is refused", dataInRepo instanceof fix.Refusal && /--data-dir .* is inside the repository/.test(dataInRepo.message), dataInRepo && dataInRepo.message);
		const fine = fix.resolveTarget({ db: path.join(outside, "app.db"), dataDir: null }, repo, { env: {} });
		check("§1 a copy outside the repository keeps its PDFs beside it", fine.scope === "copy" && fine.dataDir === fs.realpathSync(outside));
	}

	// ── §2 the lift ──────────────────────────────────────────────────────────────
	{
		const f = fixture();
		let world = null;
		let err = null;
		try { world = fix.buildWorld({ db: f.db, dataDir: f.dir, render: stubRender }); } catch (e) { err = e; }
		check("§2 every root lifts and compiles", world && fix.ROOTS.every((r) => world.liftedNames.includes(r)), err && err.message);
		check("§2 no denied name is lifted", world && !world.liftedNames.some((n) => fix.DENIED.includes(n)));
		const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
		check("§2 the INSERT is the manual route's own", SRC.includes(fix.INSERT_INVOICE.split("\n")[0]) && SRC.includes(fix.INSERT_INVOICE.split("\n")[1].trim()));
		f.db.close();
	}

	// ── §3 the dry run ───────────────────────────────────────────────────────────
	{
		const f = fixture(manual("INV-M-JT-2026W23-01", [{ date: "2026-06-08", description: "Yard move", amount: 120 }], { status: "Submitted", start: "2026-06-08", total: 120 }));
		const before = snapshot(f.db);
		const { out, err } = await attempt(f, { dryRun: true }, async () => { throw new Error("the dry run rendered a PDF"); });
		check("§3 the dry run plans a draft", out && out.state === "draft", err && err.message);
		check("§3 the dry run writes nothing", same(snapshot(f.db), before) && !fs.existsSync(path.join(f.dir, "uploads")));
		const lines = out ? fix.describe(out.plan, { ...OPTS }, { pay_daily: 290 }) : [];
		check("§3 it prints the row, the three lines, the total and the audit row", lines.some((l) => l.includes(`${NEW_NUMBER}, Draft`)) && lines.filter((l) => l.includes(`Correction for ${ORIGINAL}:`)).length === 3
			&& lines.some((l) => /total due \$825\.00/.test(l)) && lines.some((l) => /^Audit row: create_correction_invoice/.test(l)), lines.join("\n"));
		check("§3 the original's billed days follow its grid", lines[0] === `Original: ${ORIGINAL} (id 70, Approved, week 2026-05-30 to 2026-06-05, $275.00/day, bills Tuesday, Wednesday)`, lines[0]);
		check("§3 it lists the driver's live manual invoices from the original's week on", lines.includes("Live manual invoices for this driver from 2026-05-30 on: ")
			&& lines.includes('  INV-M-JT-2026W23-01 (Submitted, total due $120.00): "Yard move"'), lines.join("\n"));
		check("§3 it notes the rates differ (directory $290)", lines.some((l) => /rates above differ/.test(l)));
		// The daily-rate rule (DRIVER_RATE_ONLY_FROM): a driver with no rate of his
		// own is paid the $250 default from FROM's month on, not his truck's rate.
		const rateLine = (dirRow, env) => (out ? fix.describe(out.plan, { ...OPTS }, dirRow, env) : []).find((l) => l.startsWith("Rate: ")) || "";
		check("§3 a directory rate not set: the truck's rate applies while the daily-rate rule is off",
			rateLine({ pay_daily: 0 }, {}).endsWith("drivers directory now not set (truck rate applies)"), rateLine({ pay_daily: 0 }, {}));
		check("§3 ...and the $250 default for a week from the rule's FROM month on",
			rateLine({ pay_daily: 0 }, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-06" }).endsWith("drivers directory now not set ($250 default)"),
			rateLine({ pay_daily: 0 }, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-06" }));
		check("§3 ...but the truck's rate for a week before FROM",
			rateLine({ pay_daily: 0 }, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-07" }).endsWith("drivers directory now not set (truck rate applies)"));
		f.db.close();

		const g = fixture();
		g.db.close();
		const ro = new Database(g.file, { readonly: true });
		const roBefore = snapshot(ro);
		ro.close();
		const run = cli([...CLI_BASE, "--db", g.file, "--dry-run"]);
		const ro2 = new Database(g.file, { readonly: true });
		check("§3 the command-line dry run exits 0 and says so", run.code === 0 && /DRY RUN: nothing written\./.test(run.out) && run.out.includes(NEW_NUMBER) && /from 2026-05-30 on: none/.test(run.out), run.out);
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
		check("§4 dated --date: period and issue date", inv && inv.week_start === "2026-06-17" && inv.week_end === "2026-06-17" && rd.billingPeriodStart === "June 17, 2026" && rd.billingPeriodEnd === "June 17, 2026" && rd.issueDate === "Jun 17, 2026", inv && `${inv.week_start} ${rd.issueDate}`);
		check("§4 an INV-M- number and its PDF name", inv && inv.invoice_number === NEW_NUMBER && inv.pdf_file_name === `${NEW_NUMBER}.pdf`, inv && inv.invoice_number);
		check("§4 one line per day, dated that day, with the agreed text", same(rd.lineItems, [
			{ date: "2026-05-31", description: `Correction for ${ORIGINAL}: Sunday, May 31, 2026, $275`, amount: 275 },
			{ date: "2026-06-01", description: `Correction for ${ORIGINAL}: Monday, June 1, 2026, $275`, amount: 275 },
			{ date: "2026-06-05", description: `Correction for ${ORIGINAL}: Friday, June 5, 2026, $275`, amount: 275 },
		]), JSON.stringify(rd.lineItems));
		check("§4 total = 3 x $275, no deductions", inv && inv.total_earnings === 825 && inv.expenses_total === 0 && inv.loads_count === 3 && inv.rate_per_load === 0 && rd.totalDue === 825 && rd.subtotal === 825 && same(rd.deductions, []));
		check("§4 the notes name the original, its week and the closed month", rd.notes === `Correction for ${ORIGINAL} (billing week May 30, 2026 - June 5, 2026): 3 days that invoice did not bill, at $275 a day. Dated in June 2026 because May 2026 is closed.`, rd.notes);
		check("§4 the payee's address and phone on file", rd.payeeAddress === "100 Sample Rd, Testville, TX, 75000" && rd.payeePhone === "5550100");
		check("§4 created by the system actor; the PDF says LogisX correction (script)", inv && inv.created_by === fix.ACTOR && rd.preparedBy === "LogisX correction (script)" && fix.PREPARED_BY === rd.preparedBy && inv.adjustment === 0 && rd.adjustment === 0 && rd.__templateName === "service_invoice_manual");
		check("§4 nothing submitted, approved or paid", inv && !inv.submitted_at && !inv.approved_at && !inv.paid_at && !inv.processed_at);
		check("§4 the original invoice is untouched", same(f.db.prepare("SELECT * FROM invoices WHERE id = 70").get(), original));
		check("§4 every other invoice is untouched", same(f.db.prepare("SELECT * FROM invoices WHERE id != ? ORDER BY id").all(inv ? inv.id : 0), others));
		check("§4 no lock is touched", snapshot(f.db).locks === locksBefore);
		const pdf = path.join(f.dir, "uploads", "invoices", `${NEW_NUMBER}.pdf`);
		check("§4 the PDF is written, and no temporary file is left", fs.existsSync(pdf) && fs.readFileSync(pdf).equals(PDF_STUB) && filesIn(path.join(f.dir, "uploads", "invoices")).length === 1);
		const audits = f.db.prepare("SELECT * FROM audit_trail WHERE id > ? ORDER BY id").all(auditBefore[auditBefore.length - 1].id);
		check("§4 exactly one audit row", audits.length === 1, String(audits.length));
		const a = audits[0] || {};
		check("§4 the audit row is a system change", a.user_id === 0 && a.username === "system: correction-invoice script" && a.role === "system" && a.action === "create_correction_invoice" && a.entity === "invoice" && a.entity_id === String(inv && inv.id));
		check("§4 the audit row names the original's id, the days and the total", (a.details || "").includes(`correction for ${ORIGINAL} (invoice id 70), days 2026-05-31, 2026-06-01, 2026-06-05 at $275.00 = $825.00, dated 2026-06-17`), a.details);
		check("§4 earlier audit rows are untouched", same(f.db.prepare("SELECT * FROM audit_trail WHERE id <= ? ORDER BY id").all(auditBefore[auditBefore.length - 1].id), auditBefore));

		const afterFirst = snapshot(f.db);
		const again = await attempt(f, {}, async () => { throw new Error("a re-run rendered a PDF"); });
		check("§5 a re-run is already drafted, with its total", again.out && again.out.state === "already" && again.out.plan.existing.invoice_number === NEW_NUMBER && again.out.plan.existingTotal === 825, again.err && again.err.message);
		check("§5 a re-run writes nothing", same(snapshot(f.db), afterFirst) && filesIn(path.join(f.dir, "uploads", "invoices")).length === 1);
		const againDry = await attempt(f, { dryRun: true });
		check("§5 a re-run's dry run is already drafted too", againDry.out && againDry.out.state === "already");
		const againLines = again.out ? fix.describe(again.out.plan, { ...OPTS }, null) : [];
		check("§5 \"already drafted\" lists the correction among the manual invoices", againLines.some((l) => l.startsWith(`  ${NEW_NUMBER} (Draft, total due $825.00): "Correction for ${ORIGINAL}: Sunday`)), againLines.join("\n"));
		f.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-06', 'locked', '2026-07-08T04:00:00Z')").run();
		const afterClose = await attempt(f, { date: "2026-06-20" }, undefined, "2026-07-20");
		check("§5 after June closed, a re-run with a June date is still already drafted", afterClose.out && afterClose.out.state === "already", afterClose.err && afterClose.err.message);
		const laterDate = await attempt(f, { date: "2026-08-30" });
		check("§5 a re-run with a date after today is still already drafted", laterDate.out && laterDate.out.state === "already", laterDate.err && laterDate.err.message);
		f.db.prepare("DELETE FROM period_locks WHERE period = '2026-06'").run();
		const otherRate = await attempt(f, { rate: 285 });
		check("§5 the same days at another rate refuse", otherRate.err instanceof fix.Refusal && new RegExp(`${NEW_NUMBER} \\(Draft, total due \\$825\\.00\\) already corrects ${ORIGINAL} for these days at \\$275\\.00 a day, not \\$285\\.00`).test(otherRate.err.message), otherRate.err ? otherRate.err.message : "accepted");
		const partial = await attempt(f, { days: ["2026-05-30", "2026-05-31"] });
		check("§5 a correction naming some of the days refuses", partial.err instanceof fix.Refusal && new RegExp(`already corrects ${ORIGINAL} for 2026-05-31, 2026-06-01, 2026-06-05, which overlaps`).test(partial.err.message), partial.err ? partial.err.message : "drafted");
		check("§5 the refused runs write nothing", same(snapshot(f.db), afterFirst));
		f.db.close();

		// A copy on disk: the command line reports "already drafted" with the total (exit 0).
		const run = cli([...CLI_BASE, "--db", f.file, "--dry-run"]);
		check("§5 the command line says already drafted, with the total (exit 0)", run.code === 0 && new RegExp(`already drafted: ${NEW_NUMBER} \\(id \\d+, Draft, total due \\$825\\.00\\)`).test(run.out), run.out);
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
		const otherSpellingWeekly = (render) => (db) => db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual)
			VALUES ('INV-JT-2026W22-02', 'Jordan  Testwell', '2026-05-30', '2026-06-05', 1, 275, 275, 'Submitted', 'INV-JT-2026W22-02.pdf', ?, 0)`).run(render);
		await refused("a day the original bills", null, { days: ["2026-06-02"] }, new RegExp(`${ORIGINAL} already bills Tuesday 2026-06-02`));
		await refused("a day billed on a weekly invoice under another spelling of the name", otherSpellingWeekly(weeklyRender("Jordan  Testwell", "JT-2026W22-02", { Sunday: "T-504" }, 275)), {}, /Sunday 2026-05-31 is already billed on INV-JT-2026W22-02 \(Submitted\)/);
		await refused("a weekly invoice covering the day with no day grid", otherSpellingWeekly("{}"), {}, /INV-JT-2026W22-02 covers 2026-05-31 but has no day grid/);
		await refused("a day with a manual line dated that day", manual("INV-M-JT-2026W23-01", [{ date: "2026-05-31", description: "Make-up day", amount: 275 }], { status: "Approved" }), {}, /INV-M-JT-2026W23-01 \(Approved\) has a line dated 2026-05-31/);
		await refused("a day another spelling's manual invoice pays", manual("INV-M-JT-2026W23-02", [{ date: "2026-06-05", description: "Friday", amount: 275 }], { status: "Paid", driver: "Jordan  Testwell" }), {}, /has a line dated 2026-06-05/);
		await refused("an undated manual line covering the day", manual("INV-M-JT-2026W18-01", [{ date: "", description: "May lease", amount: 1000 }], { status: "Submitted", start: "2026-05-01", end: "2026-05-31" }), {}, /covers 2026-05-31 with an undated line/);
		await refused("a manual line naming the original and the day as M/D", manual("INV-M-JT-2026W24-01", [{ date: "2026-06-10", description: `Missed day 6/1 for ${ORIGINAL}`, amount: 275 }], { status: "Submitted" }), {}, new RegExp(`INV-M-JT-2026W24-01 \\(Submitted\\) names ${ORIGINAL} and 2026-06-01`));
		await refused("manual notes naming the original and the day as Month D", manual("INV-M-JT-2026W24-02", [{ date: "2026-06-10", description: "Make-up pay", amount: 275 }], { notes: `Covers ${ORIGINAL.toLowerCase()}, Sunday May 31` }), {}, new RegExp(`names ${ORIGINAL} and 2026-05-31`));
		await refused("a manual line naming the original with no readable date", manual("INV-M-JT-2026W25-02", [{ date: "", description: `Make-up for ${ORIGINAL}`, amount: 275 }], { start: "2026-06-15" }), {}, new RegExp(`names ${ORIGINAL} with no date the script can read`));
		await refused("a closed-month date", null, { date: "2026-05-31" }, /May 2026 is closed/);
		await refused("unreadable month locks", (db) => db.exec("DROP TABLE period_locks"), {}, /June 2026 is closed \(or the month locks can't be read\)/);
		await refused("a date after today", null, { date: "2026-06-19" }, /after today \(2026-06-18\)/);
		await refused("a date before the week", (db) => db.prepare("DELETE FROM period_locks").run(), { date: "2026-05-29" }, new RegExp(`before ${ORIGINAL}'s week`));
		await refused("a day outside the week", null, { days: ["2026-06-06"] }, new RegExp(`2026-06-06 is not in ${ORIGINAL}'s week \\(2026-05-30 to 2026-06-05\\)`));
		await refused("a missing original", null, { invoiceNumber: "INV-JT-2026W21-01" }, /INV-JT-2026W21-01 was not found/);
		await refused("a deleted original", (db) => db.prepare("UPDATE invoices SET deleted_at = '2026-06-10T00:00:00Z' WHERE id = 70").run(), {}, /is deleted/);
		await refused("a Rejected original", (db) => db.prepare("UPDATE invoices SET status = 'Rejected' WHERE id = 70").run(), {}, /is Rejected/);
		await refused("a manual original", (db) => db.prepare("UPDATE invoices SET is_manual = 1 WHERE id = 70").run(), {}, /is a manual invoice/);
		await refused("an adjusted original", (db) => db.prepare("UPDATE invoices SET adjustment = 275 WHERE id = 70").run(), {}, /carries an adjustment of \$275\.00/);
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
		await allowed("a Rejected manual invoice paying the day", manual("INV-M-JT-2026W23-03", [{ date: "2026-05-31", description: "Make-up day", amount: 275 }], { status: "Rejected" }));
		await allowed("a deleted manual invoice paying the day", manual("INV-M-JT-2026W23-04", [{ date: "2026-06-05", description: "Friday", amount: 275 }], { deleted_at: "2026-06-11T00:00:00Z" }));
		await allowed("a manual line naming the original for another day", manual("INV-M-JT-2026W24-03", [{ date: "2026-06-10", description: `${ORIGINAL}: Thursday 6/4 fuel advance`, amount: 40 }]));
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
			manual("INV-M-JT-2026W25-09", [{ date: "2026-06-05", description: "Friday by hand", amount: 275 }], { start: "2026-06-16" }),
			/INV-M-JT-2026W25-09 \(Draft\) has a line dated 2026-06-05/, ["INV-M-JT-2026W25-09"]);
		await race("the payee's address changed meanwhile",
			(db) => db.prepare("UPDATE drivers_directory SET address = '310 Changed St' WHERE driver_name = 'Jordan Testwell'").run(),
			/the invoices changed while this run rendered its PDF/, []);
		await race("the invoice number taken meanwhile",
			manual(NEW_NUMBER, [{ date: "", description: "Other payee", amount: 50 }], { driver: "jamie tobin", start: "2026-06-14" }),
			new RegExp(`${NEW_NUMBER} was given to another invoice`), [NEW_NUMBER]);
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
			const differ = Object.keys(a).filter((k) => !["issueDate", "preparedBy"].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
			check("§8 the same snapshot values but the issue date and Prepared by", differ.length === 0, differ.join(", "));
			check("§8 Prepared by: the script's text, the route's session name", a.preparedBy === fix.PREPARED_BY && b.preparedBy === fix.ACTOR);
		} else {
			check("§8 both sides wrote an invoice", false, err ? err.message : "no invoice");
		}
		scriptSide.db.close();
		routeSide.db.close();
	}

	// ── §9 dates in free text; an invoice number with pattern characters ─────────
	{
		const cases = [
			["Missed 6/1 for the week", "2026-06-01", true],
			["06/01/26 make-up", "2026-06-01", true],
			["paid 6/1/2026", "2026-06-01", true],
			["paid 6/1/2027", "2026-06-01", false],
			["16/1", "2026-06-01", false],
			["6/10", "2026-06-01", false],
			["6/1/", "2026-06-01", false],
			["June 1", "2026-06-01", true],
			["jun. 01", "2026-06-01", true],
			["Junebug 1", "2026-06-01", false],
			["June 12", "2026-06-01", false],
			["2026-06-01", "2026-06-01", true],
			["May 31, Jun 5", "2026-06-05", true],
			["6/1 and 6/5", "2026-06-05", true],
			["6/1,6/5", "2026-06-05", true],
			["September 1", "2026-09-01", true],
			["December 12, 2026", "2026-12-12", true],
			["6/1/27", "2026-06-01", false],
			["2026/06/01", "2026-06-01", false],
		];
		for (const [text, day, want] of cases) check(`§9 namesDay(${JSON.stringify(text)}, ${day}) is ${want}`, fix.namesDay(text, day) === want);

		// The original's number holds . + ( ) [ ] *: matched as text, never as a pattern.
		const META = "INV-JT.2026W22+01(a)[*]";
		const renumber = (db) => db.prepare("UPDATE invoices SET invoice_number = ? WHERE id = 70").run(META);
		const metaRun = async (extra) => {
			const f = fixture((db) => { renumber(db); if (extra) extra(db); });
			const first = await attempt(f, { invoiceNumber: META });
			const second = first.out ? await attempt(f, { invoiceNumber: META }) : null;
			f.db.close();
			return { first, second };
		};
		const plain = await metaRun(null);
		const lines = plain.first.out && plain.first.out.invoice ? JSON.parse(plain.first.out.invoice.render_data).lineItems : [];
		check("§9 a number with pattern characters drafts, its lines naming it as written", plain.first.out && plain.first.out.state === "written"
			&& lines.length === 3 && lines.every((l) => l.description.startsWith(`Correction for ${META}: `)), plain.first.err && plain.first.err.message);
		check("§9 and its re-run is already drafted", plain.second && plain.second.out && plain.second.out.state === "already", plain.second && plain.second.err && plain.second.err.message);
		// Text the number would match if it were read as a pattern ("." any
		// character, "2+" several 2s, "(a)" a, "[*]" a star) does not name it.
		const lookalike = await metaRun(manual("INV-M-JT-2026W24-04", [{ date: "2026-06-10", description: "INV-JTx2026W222201a* make-up 6/1", amount: 275 }]));
		check("§9 a look-alike of the number does not block", lookalike.first.out && lookalike.first.out.state === "written", lookalike.first.err && lookalike.first.err.message);
		const named = await metaRun(manual("INV-M-JT-2026W24-05", [{ date: "2026-06-10", description: `Make-up 6/1 for ${META}`, amount: 275 }]));
		check("§9 a line naming the number exactly and the day refuses", named.first.err instanceof fix.Refusal && named.first.err.message.includes(`names ${META} and 2026-06-01`), named.first.err ? named.first.err.message : "drafted");
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`test-create-correction-invoice-draft: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err.stack || err.message);
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
	process.exit(1);
});
