#!/usr/bin/env node
/**
 * scripts/create-missed-week-invoice-draft.js: the gap it fills, its checks,
 * its one write and its command line, on the full server schema
 * (scripts/lib/work-days-world.js) with the server's own generator lifted, an
 * invented driver, truck, ELD feed and loads (made-up data only).
 *
 * The invented case: week Sat 2026-10-03 to Fri 2026-10-09 (September closed).
 * Load M-5101 is picked up and delivered Wed 10/7 (the truck drives that day)
 * and completed Sat 10/10, so the generator bills it in the next week and pays
 * none of its days there; the week of 10/3 bills nothing. M-5103 is still open.
 *
 *   §0 the gap, with the real generator: the week of 10/3 answers 400 "No
 *      completed loads"; the next week's invoice bills M-5101 without 10/7; no
 *      invoice pays 10/7;
 *   §1 the command line: every malformed or missing option is refused (exit 2)
 *      before anything is opened; a database outside the temp directory and the
 *      app directory is refused;
 *   §2 the lift: every root resolves in this checkout's server.js and reaches no
 *      denied name; the INSERT is the manual route's;
 *   §3 the dry run (command line, on a copy): exit 0, the day with its load, the
 *      ELD state and the rate with its source, every check, the related loads,
 *      the row, the line, the notes and the audit row; nothing written;
 *   §4 the write: ONE manual Draft, period the week, an INV-M- number, one line
 *      per day with the agreed text, total = the days' rates, the notes, no paid
 *      days claimed while the trip rule is off; every other row unchanged;
 *      exactly one audit row, a system change; the PDF;
 *   §5 idempotent, before the date and lock checks: a re-run is "already
 *      drafted" (module and command line) and writes nothing; the same days at a
 *      rate that changed since, and an overlapping set of days, refuse;
 *   §6 refusals, each writing nothing: a weekly invoice for the week (any
 *      status); a load the generator bills in the week; a day the rules would
 *      not pay (no window, the ELD parked, an override removed it); a day on
 *      another live invoice (a paid-days record, a weekly grid, a weekly
 *      adjustment note, a manual line dated it, paidDays naming it, an undated
 *      line covering it, notes naming it); a closed month (the issue date's, a
 *      day's, unreadable locks); a date after today or before the last day; the
 *      driver not one account and one directory row, or paid a percentage;
 *      --loads naming nothing. A Rejected or deleted invoice paying the day and
 *      another driver's do not block; a day a Super Admin added is drafted;
 *   §7 a change while the PDF renders is caught inside the transaction: nothing
 *      written, no PDF left;
 *   §8 parity with POST /api/invoices/manual (lifted, same input, identical
 *      database): the same row and the same snapshot (issue date and "Prepared
 *      by" aside); with the trip rule set, both claim the same paid days;
 *   §9 the rate as generate prices it: the directory rate; the truck's when the
 *      directory has none; under the daily-rate rule the rate in effect that day
 *      (on a database the app never ran it on, the dry run runs and a write
 *      refuses, stamping nothing); the trip rule paying a day of the week refuses
 *      (generate it in the app);
 *   §10 a load whose window covers the whole week (a mistyped pickup) is named
 *      with a note, and the week's other day it would pay is shown, not drafted;
 *      --loads leaves it out and lists it as related.
 *
 * Pure: in-memory databases, temporary copies under the temp directory, child
 * processes of the script itself (dry runs only), no server, no network, no
 * Chromium (the PDF renderer is a stub).
 * Run: node scripts/test-create-missed-week-invoice-draft.js  # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, feed } = W;
const { closure } = require("./lib/server-lift");

const SCRIPT_REL = "scripts/create-missed-week-invoice-draft.js";
const SCRIPT = path.join(W.ROOT, SCRIPT_REL);
let M = null;
try { M = require(SCRIPT); } catch (err) { M = null; }

const D = "Jordan Testwell";
const NORM = "jordan testwell";
const WEEK_START = "2026-10-03";
const WEEK_END = "2026-10-09";
const TODAY = "2026-10-21";
const NEW_NUMBER = "INV-M-JT-2026W40-01";
const PREFIX = `Missed week ${WEEK_START} to ${WEEK_END}:`;
const OPTS = Object.freeze({ driver: D, weekStart: WEEK_START, weekEnd: WEEK_END, days: ["2026-10-07"], date: "2026-10-20", loads: null, dryRun: false });
const CLI_BASE = ["--driver", D, "--week-start", WEEK_START, "--days", "2026-10-07"];
const PDF_STUB = Buffer.from("%PDF-1.4 stub\n");
const stubRender = async () => PDF_STUB;
const quiet = { log() {}, info() {}, warn() {}, error() {} };

// ── fixtures ──────────────────────────────────────────────────────────────────
const M5101 = () => loadRow({ id: "M-5101", driver: D, pickup: "2026-10-07 8:00", dropoff: "2026-10-07 17:00", assigned: "2026-10-06", done: "2026-10-10", truck: "T1" });
const M5103 = () => loadRow({ id: "M-5103", driver: D, pickup: "2026-10-08 8:00", dropoff: "2026-10-09 12:00", assigned: "2026-10-07", done: "", status: "Dispatched", truck: "T1" });
// A pickup typed weeks early: its window covers the whole week.
const M5102 = () => loadRow({ id: "M-5102", driver: D, pickup: "2026-09-22 7:00", dropoff: "2026-10-12 8:00", assigned: "2026-10-09", done: "2026-10-12", truck: "T1" });
const pings = () => feed(1000).park("2026-10-05").drive("2026-10-07", { miles: 320 }).drive("2026-10-10", { miles: 210 }).drive("2026-10-12", { miles: 180 }).pings;

function base({ env = {}, rows = null, extraRows = [], locks = ["2026-09"], payDaily = 280, payType = "fixed", truckPay = 265, overrides = [], payRates = [], account = true, status = [], feedV1 = pings } = {}) {
	const w = W.startWorld({
		env, locks, overrides, payRates, status,
		drivers: [{ name: D, payDaily, payType, payPct: payType === "percentage" ? 30 : 0 }, { name: "Avery Bramble", payDaily: 260 }],
		trucks: [{ unit: "T1", driver: D, vid: "V1", payDaily: truckPay }, { unit: "T2", driver: "Avery Bramble", vid: null }],
		pings: { V1: feedV1() },
		rows: rows || [M5101(), M5103(), ...extraRows],
		now: Date.parse("2026-10-21T15:00:00Z"),
	});
	if (account) w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (7, 'jtestwell', 'x', 'Driver', ?)").run(D);
	w.db.prepare("UPDATE drivers_directory SET address = '100 Sample Rd', city = 'Testville', state = 'TX', zip = '75000', phone = '5550100' WHERE driver_name = ?").run(D);
	w.env = env;
	return w;
}
const values = (w) => ({ values: W.sheetValues(w.rows) });
function scriptApi(w, { render = stubRender, dataDir = W.tempDir() } = {}) {
	return { api: M.buildWorld({ db: w.db, env: w.env || {}, dataDir, render, log: quiet }).api, dataDir };
}
async function attempt(w, opts = {}, { render = stubRender, today = TODAY } = {}) {
	const { api, dataDir } = scriptApi(w, { render });
	try { return { out: await M.run(w.db, api, values(w), { ...OPTS, ...opts }, { today }), dataDir, api }; } catch (err) { return { err, dataDir, api }; }
}
const addInvoice = (w, o) => w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual, deleted_at, adjustment, adjustment_note)
	VALUES (@invoice_number, @driver, @week_start, @week_end, 1, 0, @total, @status, @pdf, @render_data, @is_manual, @deleted_at, @adjustment, @adjustment_note)`)
	.run({ total: 0, pdf: `${o.invoice_number}.pdf`, deleted_at: "", is_manual: 1, adjustment: 0, adjustment_note: "", driver: NORM, status: "Draft", ...o });
const manualRender = (lines, { notes = "", paidDays = null } = {}) => JSON.stringify({ payeeName: D, lineItems: lines, deductions: [], subtotal: 0, deductionsTotal: 0, totalDue: 0, notes, preparedBy: "admin", adjustment: 0, adjustmentNote: "", ...(paidDays ? { paidDays } : {}), __templateName: "service_invoice_manual" });
const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const weeklyRender = (billed) => JSON.stringify({ driverName: D, days: Object.fromEntries(GRID.map((n) => [n, billed.includes(n) ? { loadBol: "M-9", total: 280, completed: true } : { loadBol: "", total: 0, completed: false }])), __templateName: "service_invoice" });
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
	const R = W.createRunner("create-missed-week-invoice-draft");
	const test = R.test;

	// ── §0 the gap, with the real generator ────────────────────────────────────
	await test("§0 the generator leaves a day worked in a week with no other load on no invoice", async ({ eq, ok }) => {
		const w = base();
		const missed = await W.generate(w, D, WEEK_END);
		eq("the week of 10/3 bills nothing", [missed.status, /No completed loads/.test(String(missed.body && missed.body.error))], [400, true]);
		const next = await W.generate(w, D, "2026-10-16");
		eq("the next week's invoice is made", next.status, 200);
		ok("it bills M-5101", JSON.parse(next.invoice.load_ids).includes("M-5101"), next.invoice && next.invoice.load_ids);
		ok("without 10/7 (outside its week)", !W.gridDays(next.data, "2026-10-16").some((g) => g.day === "2026-10-07"));
		const again = await W.generate(w, D, WEEK_END);
		eq("generating the week of 10/3 again still bills nothing", again.status, 400);
		eq("no invoice row covers 10/7", w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE week_start <= '2026-10-07' AND week_end >= '2026-10-07'").get().n, 0);
	});

	if (!M) {
		await test("the script exists", async ({ ok }) => ok(`${SCRIPT_REL} loads`, false, `${SCRIPT_REL} does not exist yet (the fix adds it)`));
		R.finish();
		return;
	}

	// ── §1 the command line ─────────────────────────────────────────────────────
	await test("§1 a full command line reads; malformed ones are refused before anything opens", async ({ eq, ok }) => {
		const full = M.readOptions([...CLI_BASE, "--days", "2026-10-08,2026-10-07", "--date", "2026-10-20", "--loads", "5101", "--db", "/x/app.db", "--values-json", "/x/v.json", "--dry-run"]);
		eq("read", [full.driver, full.weekStart, full.weekEnd, full.days, full.date, full.loads, full.dryRun], [D, WEEK_START, WEEK_END, ["2026-10-07", "2026-10-08"], "2026-10-20", ["5101"], true]);
		const needs = ["--db", "/x/app.db", "--values-json", "/x/v.json"];
		eq("no --date reads as today, no --loads as all", (({ date, loads }) => [date, loads])(M.readOptions([...CLI_BASE, ...needs])), [null, null]);
		const refuses = (name, argv, re) => {
			let err = null;
			try { M.readOptions(argv); } catch (e) { err = e; }
			ok(`refuses ${name}`, err instanceof M.Refusal && re.test(err.message), err ? err.message : "accepted");
		};
		const without = (flag) => { const a = [...CLI_BASE, ...needs]; a.splice(a.indexOf(flag), 2); return a; };
		refuses("an unknown option", [...CLI_BASE, ...needs, "--force-day", "2026-10-05"], /unknown option --force-day/);
		refuses("no --driver", without("--driver"), /--driver/);
		refuses("no --week-start", without("--week-start"), /--week-start/);
		refuses("a week start that is not a Saturday", ["--driver", D, "--week-start", "2026-10-04", "--days", "2026-10-07", ...needs], /2026-10-04 is a Sunday/);
		refuses("no --days", without("--days"), /--days/);
		refuses("a day outside the week", ["--driver", D, "--week-start", WEEK_START, "--days", "2026-10-10", ...needs], /2026-10-10 is not in the week 2026-10-03 to 2026-10-09/);
		refuses("a repeated day", ["--driver", D, "--week-start", WEEK_START, "--days", "2026-10-07,2026-10-07", ...needs], /twice/);
		refuses("a day that is not a calendar day", ["--driver", D, "--week-start", WEEK_START, "--days", "2026-10-32", ...needs], /not a calendar day/);
		refuses("a malformed --date", [...CLI_BASE, ...needs, "--date", "10/20/2026"], /--date/);
		refuses("a malformed --loads", [...CLI_BASE, ...needs, "--loads", "51"], /--loads/);
		refuses("no --db", without("--db"), /--db/);
		refuses("no sheet", without("--values-json"), /--sheet-id/);
		refuses("--dry-run with a value", [...CLI_BASE, ...needs, "--dry-run=yes"], /takes no value/);
		const unknown = W.runScript(SCRIPT_REL, [...CLI_BASE, ...needs, "--rate", "300"]);
		eq("the command line exits 2 on an unknown option", [unknown.code, /unknown option --rate/.test(unknown.stderr)], [2, true]);
		const elsewhere = W.runScript(SCRIPT_REL, [...CLI_BASE, "--db", path.join(W.ROOT, "scripts", "app.db"), "--values-json", "/x/v.json", "--dry-run"]);
		eq("a database outside the app directory and the temp directory is refused (exit 2)", [elsewhere.code, /refusing .*a copy under the temp directory/.test(elsewhere.stderr)], [2, true]);
	});

	// ── §2 the lift ─────────────────────────────────────────────────────────────
	await test("§2 every root lifts, none denied; the INSERT is the manual route's", async ({ ok }) => {
		const w = base();
		const world = M.buildWorld({ db: w.db, env: {}, dataDir: W.tempDir(), render: stubRender, log: quiet });
		ok("every root lifts", M.ROOTS.every((r) => world.liftedNames.includes(r)), M.ROOTS.filter((r) => !world.liftedNames.includes(r)).join(", "));
		ok("no denied name is lifted", !world.liftedNames.some((n) => M.DENIED.includes(n)));
		const { INSERT_INVOICE } = require("./create-correction-invoice-draft");
		ok("the INSERT is the route's own", W.SRC.includes(INSERT_INVOICE.split("\n")[0]) && W.SRC.includes(INSERT_INVOICE.split("\n")[1].trim()));
	});

	// ── §3 the dry run ──────────────────────────────────────────────────────────
	await test("§3 the command-line dry run on a copy prints the draft and writes nothing", async ({ eq, ok }) => {
		const w = base();
		await W.generate(w, D, "2026-10-16");
		const copy = W.saveCopy(w, {});
		const before = W.tableHashes(w.db);
		const r = W.runScript(SCRIPT_REL, [...CLI_BASE, "--date", "2026-10-20", "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--dry-run"]);
		const out = r.stdout;
		eq("exit 0", r.code, 0);
		ok("says DRY RUN", /^DRY RUN: nothing written\.$/m.test(out), out + r.stderr);
		ok("the day, its load, the ELD and the rate with its source", out.includes("  2026-10-07 Wednesday: paid by the weekly rules for load M-5101 (ELD: moving); rate $280.00, from drivers directory daily rate (pay_daily $280.00)"), out);
		ok("the flags it ran with", /TRIP_WORK_DAYS off, DRIVER_RATE_ONLY off, INVOICE_BLANK_PICKUP_FALLBACK off, pre-dispatch rule off/.test(out));
		ok("every check passed", ["driver matched", "no weekly invoice for the week", "the weekly generator bills no load", "each day is one the weekly rules pay", "issue date 2026-10-20", "no live invoice of the driver pays these days"].every((c) => out.includes(c)), out);
		ok("the open load is related, not used", /load M-5103: Dispatched; .*not used: not completed/.test(out), out);
		ok("the next week's invoice is listed", /INV-JT-2026W41-01 \(weekly, Draft, 2026-10-10 to 2026-10-16/.test(out), out);
		ok("the row", out.includes(`Invoice row: ${NEW_NUMBER}, Draft, manual, driver "${NORM}", period ${WEEK_START} to ${WEEK_END}, issue date Oct 20, 2026, 1 line(s), total $280.00`), out);
		ok("the line", out.includes(`  line 1: 2026-10-07  ${PREFIX} Wednesday, October 7, 2026, $280  $280.00`), out);
		ok("the audit row", /^Audit row: create_missed_week_invoice, invoice <new id>, by "system: missed-week invoice script" \(system\): /m.test(out), out);
		const ro = new W.Database(copy.db, { readonly: true });
		eq("nothing written to the copy", W.tableHashes(ro), before);
		ro.close();
		eq("no PDF folder", fs.existsSync(path.join(copy.dir, "uploads")), false);
	});

	// ── §4 the write, §5 idempotent ─────────────────────────────────────────────
	await test("§4 the write: one manual Draft for the week, one line, the notes, one audit row, the PDF", async ({ eq, ok }) => {
		const w = base();
		await W.generate(w, D, "2026-10-16");
		const others = w.db.prepare("SELECT * FROM invoices ORDER BY id").all();
		const auditBefore = w.db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
		const hashes = W.tableHashes(w.db);
		const { out, err, dataDir } = await attempt(w);
		eq("written", out && out.state, "written");
		if (err) ok("no error", false, err.message);
		const inv = out && out.invoice;
		const rd = inv ? JSON.parse(inv.render_data) : {};
		eq("one more invoice", w.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, others.length + 1);
		eq("a manual Draft for the driver, period the week", inv && [inv.status, inv.is_manual, inv.driver, inv.week_start, inv.week_end, inv.invoice_number, inv.pdf_file_name], ["Draft", 1, NORM, WEEK_START, WEEK_END, NEW_NUMBER, `${NEW_NUMBER}.pdf`]);
		eq("the line", rd.lineItems, [{ date: "2026-10-07", description: `${PREFIX} Wednesday, October 7, 2026, $280`, amount: 280 }]);
		eq("the totals", inv && [inv.total_earnings, inv.expenses_total, inv.loads_count, inv.rate_per_load, rd.subtotal, rd.totalDue], [280, 0, 1, 0, 280, 280]);
		eq("the notes", rd.notes, "No weekly invoice was made for the week of October 3, 2026 - October 9, 2026. 1 day worked in it on load M-5101 completed 2026-10-10: a load is billed in the week it completes, and that week's invoice pays only its own days. $280 a day.");
		eq("the snapshot", [rd.payeeName, rd.payeeRole, rd.payeeAddress, rd.payeePhone, rd.issueDate, rd.billingPeriodStart, rd.billingPeriodEnd, rd.preparedBy, rd.__templateName, "paidDays" in rd],
			[D, "Driver", "100 Sample Rd, Testville, TX, 75000", "5550100", "Oct 20, 2026", "October 3, 2026", "October 9, 2026", M.PREPARED_BY, "service_invoice_manual", false]);
		eq("nothing submitted, approved or paid", inv && [inv.submitted_at, inv.approved_at, inv.paid_at, inv.processed_at, inv.created_by], ["", "", "", "", M.ACTOR]);
		eq("every other invoice unchanged", w.db.prepare("SELECT * FROM invoices WHERE id != ? ORDER BY id").all(inv ? inv.id : 0), others);
		const after = W.tableHashes(w.db);
		eq("only invoices and audit_trail changed", Object.keys(after).filter((t) => after[t] !== hashes[t]).sort(), ["audit_trail", "invoices"]);
		eq("no paid days claimed (the trip rule is off)", w.db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days").get().n, 0);
		const audits = w.db.prepare("SELECT * FROM audit_trail WHERE id > ? ORDER BY id").all(auditBefore.length ? auditBefore[auditBefore.length - 1].id : 0);
		eq("exactly one audit row", audits.length, 1);
		const a = audits[0] || {};
		eq("a system change", [a.user_id, a.username, a.role, a.action, a.entity, a.entity_id], [0, M.ACTOR, "system", "create_missed_week_invoice", "invoice", String(inv && inv.id)]);
		eq("naming the invoice, driver, week, days, rate and total", a.details,
			`${NEW_NUMBER} (Draft) for ${D}: missed week ${WEEK_START} to ${WEEK_END} (no weekly invoice), days 2026-10-07 $280.00 = $280.00; loads M-5101; rate: drivers directory daily rate (pay_daily $280.00), resolveDailyRate() as the weekly invoice prices it; issued 2026-10-20`);
		const pdfDir = path.join(dataDir, "uploads", "invoices");
		ok("the PDF, and no temporary file", same(filesIn(pdfDir), [`${NEW_NUMBER}.pdf`]) && fs.readFileSync(path.join(pdfDir, `${NEW_NUMBER}.pdf`)).equals(PDF_STUB));
	});

	await test("§5 idempotent: a re-run is already drafted and writes nothing; a changed rate or an overlap refuses", async ({ eq, ok }) => {
		const w = base();
		const first = await attempt(w);
		eq("first run writes", first.out && first.out.state, "written");
		const hashes = W.tableHashes(w.db);
		const again = await attempt(w, {}, { render: async () => { throw new Error("a re-run rendered a PDF"); } });
		eq("already drafted, with its total", again.out && [again.out.state, again.out.plan.existing.invoice_number, again.out.plan.existingTotal], ["already", NEW_NUMBER, 280]);
		eq("nothing written", W.tableHashes(w.db), hashes);
		w.lock(["2026-10"]);
		const closed = await attempt(w, { date: "2026-10-22" }, { today: "2026-11-20" });
		eq("still already drafted once October closed, any date", closed.out && closed.out.state, "already");
		w.db.prepare("DELETE FROM period_locks WHERE period = '2026-10'").run();
		const copy = W.saveCopy(w, {});
		const cli = W.runScript(SCRIPT_REL, [...CLI_BASE, "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--dry-run"]);
		eq("the command line says already drafted (exit 0)", [cli.code, new RegExp(`^already drafted: ${NEW_NUMBER} \\(id \\d+, Draft, total due \\$280\\.00\\) pays the week of ${WEEK_START} for 2026-10-07; nothing written$`, "m").test(cli.stdout)], [0, true]);
		const overlap = await attempt(w, { days: ["2026-10-07", "2026-10-08"] });
		ok("an overlapping set of days refuses", overlap.err instanceof M.Refusal && new RegExp(`${NEW_NUMBER} \\(Draft\\) already drafts the week for 2026-10-07, which overlaps`).test(overlap.err.message), overlap.err ? overlap.err.message : "drafted");
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 300 WHERE driver_name = ?").run(D);
		const rate = await attempt(w);
		ok("the same days at a rate that changed refuse", rate.err instanceof M.Refusal && /already drafts these days, 2026-10-07 at \$280\.00, not at today's rate \(\$300\.00\)/.test(rate.err.message), rate.err ? rate.err.message : "drafted");
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 280 WHERE driver_name = ?").run(D);
		eq("the refused runs wrote nothing", W.tableHashes(w.db), hashes);
	});

	// ── §6 refusals ─────────────────────────────────────────────────────────────
	const refused = async (name, setup, opts, re, worldOpts = {}, runOpts = {}) => {
		await test(`§6 refuses ${name}, writing nothing`, async ({ eq, ok }) => {
			const w = base(worldOpts);
			if (setup) setup(w);
			const hashes = W.tableHashes(w.db);
			const { out, err, dataDir } = await attempt(w, opts, runOpts);
			ok("refused", err instanceof M.Refusal && re.test(err.message), err ? err.message : `state ${out && out.state}`);
			eq("nothing written", W.tableHashes(w.db), hashes);
			eq("no PDF", fs.existsSync(path.join(dataDir, "uploads")), false);
		});
	};
	const allowed = async (name, setup, opts = {}, worldOpts = {}) => {
		await test(`§6 ${name}`, async ({ eq, ok }) => {
			const w = base(worldOpts);
			if (setup) setup(w);
			const { out, err } = await attempt(w, opts);
			eq("written", out && out.state, "written");
			if (err) ok("no error", false, err.message);
		});
	};
	await refused("a weekly invoice for the week", (w) => addInvoice(w, { invoice_number: "INV-JT-2026W40-01", week_start: WEEK_START, week_end: WEEK_END, status: "Approved", is_manual: 0, render_data: weeklyRender(["Monday"]) }), {},
		/weekly invoice INV-JT-2026W40-01 \(Approved\) for the week of 2026-10-03; for days it missed use scripts\/create-correction-invoice-draft\.js/);
	await refused("a Rejected weekly invoice for the week too", (w) => addInvoice(w, { invoice_number: "INV-JT-2026W40-01", week_start: WEEK_START, week_end: WEEK_END, status: "Rejected", is_manual: 0, render_data: weeklyRender([]) }), {},
		/weekly invoice INV-JT-2026W40-01 \(Rejected\)/);
	await refused("a load the generator bills in the week", null, {}, /the weekly generator bills load M-5104 in this week; generate the week's invoice in the app/,
		{ extraRows: [loadRow({ id: "M-5104", driver: D, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 9:00", assigned: "2026-10-04", done: "2026-10-06", truck: "T1" })] });
	await refused("a day no window covers", null, { days: ["2026-10-04"] }, /would not pay Sunday 2026-10-04: no load billed in another week has a pay window covering it/);
	await refused("a day a Super Admin removed", null, {}, /would not pay Wednesday 2026-10-07: a Super Admin removed it/, { overrides: [{ driver: D, day: "2026-10-07", action: "remove" }] });
	await refused("a day recorded as paid (invoice_paid_days)", (w) => {
		const id = addInvoice(w, { invoice_number: "INV-M-JT-2026W42-01", week_start: "2026-10-17", week_end: "2026-10-17", render_data: manualRender([{ date: "2026-10-17", description: "Other", amount: 50 }]) }).lastInsertRowid;
		w.db.prepare("INSERT INTO invoice_paid_days (driver_norm, day, invoice_id) VALUES (?, '2026-10-07', ?)").run(NORM, id);
	}, {}, /2026-10-07 is already recorded as paid by INV-M-JT-2026W42-01 \(invoice_paid_days\)/);
	await refused("a weekly grid billing the day", (w) => addInvoice(w, { invoice_number: "INV-JT-2026W40-02", driver: "Jordan  Testwell", week_start: "2026-10-04", week_end: "2026-10-10", status: "Submitted", is_manual: 0, render_data: weeklyRender(["Wednesday"]) }), {},
		/Wednesday 2026-10-07 is already billed on INV-JT-2026W40-02 \(Submitted\)/);
	await refused("a weekly invoice covering the day with no grid", (w) => addInvoice(w, { invoice_number: "INV-JT-2026W40-03", week_start: "2026-10-04", week_end: "2026-10-10", status: "Submitted", is_manual: 0, render_data: "{}" }), {},
		/INV-JT-2026W40-03 \(Submitted\) covers 2026-10-07 but has no day grid line for it/);
	await refused("a later weekly invoice's adjustment note naming the day", (w) => addInvoice(w, { invoice_number: "INV-JT-2026W41-01", week_start: "2026-10-10", week_end: "2026-10-16", status: "Approved", is_manual: 0, render_data: weeklyRender([]), adjustment: 280, adjustment_note: "Missed day 10/7" }), {},
		/INV-JT-2026W41-01 \(Approved\) carries an adjustment of \$280\.00 whose note names 2026-10-07/);
	await refused("a manual line dated the day", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-02", week_start: "2026-10-18", week_end: "2026-10-18", status: "Approved", render_data: manualRender([{ date: "2026-10-07", description: "Make-up day", amount: 280 }]) }), {},
		/INV-M-JT-2026W42-02 \(Approved\) has a line dated 2026-10-07/);
	await refused("a manual invoice naming the day among its paid days", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-03", week_start: "2026-10-18", week_end: "2026-10-18", render_data: manualRender([{ date: "2026-10-18", description: "Days", amount: 280 }], { paidDays: ["2026-10-07"] }) }), {},
		/INV-M-JT-2026W42-03 \(Draft\) names 2026-10-07 among the days it pays/);
	await refused("an undated manual line over a period covering the day", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W40-04", week_start: "2026-10-01", week_end: "2026-10-31", status: "Submitted", render_data: manualRender([{ date: "", description: "October lease", amount: 900 }]) }), {},
		/INV-M-JT-2026W40-04 \(Submitted\) covers 2026-10-07 with an undated line/);
	await refused("manual notes naming the day", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-05", week_start: "2026-10-18", week_end: "2026-10-18", render_data: manualRender([{ date: "2026-10-18", description: "Make-up pay", amount: 280 }], { notes: "Covers Wed Oct 7" }) }), {},
		/INV-M-JT-2026W42-05 \(Draft\) names 2026-10-07 in a line or its notes/);
	await refused("an issue date in a closed month", null, { date: "2026-10-20" }, /October 2026 is closed \(or the month locks can't be read\), so the draft can't be issued 2026-10-20/, { locks: ["2026-09", "2026-10"] });
	await refused("unreadable month locks", (w) => w.db.exec("DROP TABLE period_locks"), {}, /October 2026 is closed \(or the month locks can't be read\)/);
	await refused("a date after today", null, { date: "2026-10-22" }, /--date 2026-10-22 is after today \(2026-10-21\)/);
	await refused("a date before the last day", null, { date: "2026-10-06" }, /--date 2026-10-06 is before 2026-10-07, the last day it pays/);
	await refused("two accounts carrying the name", (w) => w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (8, 'jtestwell2', 'x', 'Driver', 'Jordan  Testwell')").run(), {}, /2 accounts carry this driver name/);
	await refused("no account carrying the name", null, {}, /0 accounts carry this driver name/, { account: false });
	await refused("a non-Driver account carrying the name", (w) => w.db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = 7").run(), {}, /is a Dispatcher account, not a Driver's/);
	await refused("two directory rows carrying the name", (w) => w.db.prepare("INSERT INTO drivers_directory (driver_name, pay_daily) VALUES ('Jordan  Testwell', 300)").run(), {}, /2 drivers directory rows carry this driver name/);
	await refused("a percentage driver", null, {}, /paid a percentage of revenue/, { payType: "percentage" });
	await refused("--loads naming no load billed in another week", null, { loads: ["M-5103"] }, /--loads M-5103 matches 0 of this driver's completed loads billed in another week/);
	// The day's month closed, in a week across the close: the week of Sep 26.
	const closedWeek = { weekStart: "2026-09-26", weekEnd: "2026-10-02" };
	const acrossClose = [loadRow({ id: "M-5201", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 16:00", assigned: "2026-09-29", done: "2026-10-05", truck: "T1" })];
	const acrossPings = () => feed(1000).drive("2026-09-30", { miles: 300 }).drive("2026-10-01", { miles: 250 }).pings;
	await test("§6 refuses a day in a closed month, writing nothing; drafts the open month's day with the period from its month", async ({ eq, ok }) => {
		const mk = () => { const w = base({ rows: acrossClose }); w.db.prepare("DELETE FROM routemate_telemetry").run(); const tl = w.db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES ('V1', ?, ?, ?, ?, ?, '')"); for (const p of acrossPings()) tl.run(p.lat, p.lng, p.speed, p.odo, p.ms); return w; };
		const w = mk();
		const hashes = W.tableHashes(w.db);
		const sep = await attempt(w, { ...closedWeek, days: ["2026-09-30"] });
		ok("September's day refused", sep.err instanceof M.Refusal && /September 2026 is closed \(or the month locks can't be read\); its days are not paid on a new draft/.test(sep.err.message), sep.err ? sep.err.message : "drafted");
		eq("nothing written", W.tableHashes(w.db), hashes);
		const oct = await attempt(w, { ...closedWeek, days: ["2026-10-01"] });
		eq("October's day drafted", oct.out && oct.out.state, "written");
		const inv = oct.out && oct.out.invoice;
		const rd = inv ? JSON.parse(inv.render_data) : {};
		eq("its period starts October 1; numbered for that week", inv && [inv.week_start, inv.week_end, inv.invoice_number, rd.billingPeriodStart], ["2026-10-01", "2026-10-02", NEW_NUMBER, "October 1, 2026"]);
		ok("its notes say why", / Period from October 1, 2026 because September 2026 is closed\.$/.test(rd.notes || ""), rd.notes);
		eq("its line names the week", rd.lineItems && rd.lineItems[0].description, "Missed week 2026-09-26 to 2026-10-02: Thursday, October 1, 2026, $280");
	});
	await test("§6 refuses a day named in a manual invoice's adjustment note, whatever its period, writing nothing", async ({ eq, ok }) => {
		const w = base();
		// Approved, its period before the week: an adjustment can pay any day.
		addInvoice(w, { invoice_number: "INV-M-JT-2026W40-08", week_start: "2026-10-01", week_end: "2026-10-01", status: "Approved", adjustment: 280, adjustment_note: "Missed day 10/7",
			render_data: manualRender([{ date: "2026-10-01", description: "Fuel advance", amount: 40 }]) });
		const hashes = W.tableHashes(w.db);
		const { out, err } = await attempt(w);
		ok("refused", err instanceof M.Refusal && /INV-M-JT-2026W40-08 \(Approved\) carries an adjustment of \$280\.00 whose note names 2026-10-07; it may already pay that day/.test(err.message), err ? err.message : `state ${out && out.state}`);
		eq("nothing written", W.tableHashes(w.db), hashes);
	});
	await test("§6 refuses any day of the week once this script's own draft for it carries an adjustment, writing nothing", async ({ eq, ok }) => {
		const w = base({ overrides: [{ driver: D, day: "2026-10-08", action: "add" }] });
		const first = await attempt(w);
		eq("the 10/7 draft is written", first.out && first.out.state, "written");
		const id = first.out && first.out.invoice.id;
		for (const note of ["+$280 Thu 10/8 too", "bonus"]) {
			w.db.prepare("UPDATE invoices SET adjustment = 280, adjustment_note = ? WHERE id = ?").run(note, id);
			const hashes = W.tableHashes(w.db);
			const { out, err } = await attempt(w, { days: ["2026-10-08"] });
			// Matched as text: the note never becomes part of a pattern.
			const want = `${NEW_NUMBER} (Draft), this script's draft for the week, carries an adjustment of $280.00 (${JSON.stringify(note)})`;
			ok(`refused (note "${note}")`, err instanceof M.Refusal && err.message.includes(want), err ? err.message : `state ${out && out.state}`);
			eq(`nothing written (note "${note}")`, W.tableHashes(w.db), hashes);
		}
		const again = await attempt(w);
		eq("the same days again are still already drafted", again.out && again.out.state, "already");
	});
	await refused("--loads naming a token two loads end with", null, { loads: ["5101"] }, /--loads 5101 matches 2 of this driver's completed loads billed in another week; name one/,
		{ extraRows: [loadRow({ id: "Q-5101", driver: D, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 9:00", assigned: "2026-10-11", done: "2026-10-13", truck: "T1" })] });
	await test("§6 a Rejected invoice naming the day does not block, and is listed (PUT /revert can bring it back)", async ({ eq, ok }) => {
		const w = base();
		addInvoice(w, { invoice_number: "INV-M-JT-2026W42-06", week_start: "2026-10-18", week_end: "2026-10-18", status: "Rejected", render_data: manualRender([{ date: "2026-10-07", description: "Make-up", amount: 280 }]) });
		addInvoice(w, { invoice_number: "INV-JT-2026W41-01", week_start: "2026-10-10", week_end: "2026-10-16", status: "Rejected", is_manual: 0, render_data: weeklyRender([]), adjustment: 280, adjustment_note: "Wed 10/7 missed" });
		const { out, err } = await attempt(w);
		eq("written", out && out.state, "written");
		if (err) ok("no error", false, err.message);
		const lines = out ? M.describe(out.plan, { ...OPTS }) : [];
		const at = lines.indexOf("Rejected invoices naming these days (they do not block; PUT /api/invoices/:id/revert can bring one back):");
		ok("the heading", at >= 0, lines.join("\n"));
		eq("each listed with what names the day", lines.slice(at + 1, at + 3), [
			"  INV-M-JT-2026W42-06 (Rejected): INV-M-JT-2026W42-06 (Rejected) has a line dated 2026-10-07; it may already pay that day",
			"  INV-JT-2026W41-01 (Rejected): INV-JT-2026W41-01 (Rejected) carries an adjustment of $280.00 whose note names 2026-10-07; it may already pay that day",
		]);
	});
	await allowed("a Rejected manual invoice paying the day does not block", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-06", week_start: "2026-10-18", week_end: "2026-10-18", status: "Rejected", render_data: manualRender([{ date: "2026-10-07", description: "Make-up", amount: 280 }]) }));
	await allowed("a deleted manual invoice paying the day does not block", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-07", week_start: "2026-10-18", week_end: "2026-10-18", deleted_at: "2026-10-19T00:00:00Z", render_data: manualRender([{ date: "2026-10-07", description: "Make-up", amount: 280 }]) }));
	await allowed("another driver's invoice paying the day does not block", (w) => addInvoice(w, { invoice_number: "INV-M-AB-2026W42-01", driver: "avery bramble", week_start: "2026-10-18", week_end: "2026-10-18", render_data: manualRender([{ date: "2026-10-07", description: "Make-up", amount: 260 }]) }));
	await test("§6 a day a Super Admin added for the driver is drafted, named as such", async ({ eq }) => {
		const w = base({ overrides: [{ driver: D, day: "2026-10-08", action: "add" }] });
		const { out } = await attempt(w, { days: ["2026-10-08"] });
		eq("written", out && out.state, "written");
		const rd = out && out.invoice ? JSON.parse(out.invoice.render_data) : {};
		eq("its notes", rd.notes, "No weekly invoice was made for the week of October 3, 2026 - October 9, 2026. 1 day a Super Admin added for the driver. $280 a day.");
	});

	// ── §7 a change while the PDF renders ───────────────────────────────────────
	const race = async (name, change, re, keep) => {
		await test(`§7 ${name}: refused inside the transaction, nothing of the run written, no PDF`, async ({ eq, ok }) => {
			const w = base();
			const audits = w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
			const { out, err, dataDir } = await attempt(w, {}, { render: async () => { change(w); return PDF_STUB; } });
			ok("refused", err && (err instanceof M.Refusal || err.invoiceWriteRefusal) && re.test(err.message), err ? err.message : `state ${out && out.state}`);
			eq("manual invoices", w.db.prepare("SELECT invoice_number FROM invoices WHERE is_manual = 1 ORDER BY id").all().map((r) => r.invoice_number), keep);
			eq("no audit row", w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n, audits);
			eq("no PDF or temporary file", filesIn(path.join(dataDir, "uploads", "invoices")), []);
		});
	};
	await race("a line for the day added meanwhile", (w) => addInvoice(w, { invoice_number: "INV-M-JT-2026W42-09", week_start: "2026-10-18", week_end: "2026-10-18", render_data: manualRender([{ date: "2026-10-07", description: "By hand", amount: 280 }]) }),
		/INV-M-JT-2026W42-09 \(Draft\) has a line dated 2026-10-07; it may already pay that day \(found while this run rendered its PDF; nothing was written\)/, ["INV-M-JT-2026W42-09"]);
	await race("the payee's address changed meanwhile", (w) => w.db.prepare("UPDATE drivers_directory SET address = '310 Changed St' WHERE driver_name = ?").run(D),
		/the invoices changed while this run rendered its PDF/, []);
	await race("the invoice number taken meanwhile", (w) => addInvoice(w, { invoice_number: NEW_NUMBER, driver: "jamie tobin", week_start: "2026-10-14", week_end: "2026-10-14", render_data: manualRender([{ date: "", description: "Other payee", amount: 50 }]) }),
		new RegExp(`${NEW_NUMBER} was given to another invoice`), [NEW_NUMBER]);

	// ── §8 parity with POST /api/invoices/manual ────────────────────────────────
	for (const [label, env] of [["the trip rule off", {}], ["the trip rule set (from a later month), both claiming the day", { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-11" }]]) {
		await test(`§8 parity with POST /api/invoices/manual, ${label}`, async ({ eq, ok }) => {
			const mine = base({ env });
			const { out, err } = await attempt(mine);
			eq("the script writes", out && out.state, "written");
			if (err) ok("no error", false, err.message);
			const theirs = base({ env });
			const p = out ? out.plan : null;
			const res = p ? await W.route(theirs, "POST /api/invoices/manual", { body: {
				payee: p.payee, payeeRole: "Driver", periodStart: p.row.week_start, periodEnd: p.row.week_end, lineItems: p.renderData.lineItems, deductions: [], notes: p.renderData.notes,
				...(p.paidDays ? { days: p.paidDays } : {}),
			} }) : { status: 0, body: null };
			eq("the route answers 200", res.status, 200);
			if (!(out && res.body && res.body.invoice)) return;
			const a = mine.db.prepare("SELECT * FROM invoices WHERE id = ?").get(out.invoice.id);
			const b = theirs.db.prepare("SELECT * FROM invoices WHERE id = ?").get(res.body.invoice.id);
			const cols = Object.keys(a).filter((k) => !["created_at", "render_data", "created_by"].includes(k));
			eq("the same row, every column but created_at and created_by", cols.filter((k) => String(a[k]) !== String(b[k])), []);
			const sa = JSON.parse(a.render_data);
			const sb = JSON.parse(b.render_data);
			eq("the same snapshot keys", Object.keys(sa).sort(), Object.keys(sb).sort());
			eq("the same snapshot values but the issue date and Prepared by", Object.keys(sa).filter((k) => !["issueDate", "preparedBy"].includes(k) && JSON.stringify(sa[k]) !== JSON.stringify(sb[k])), []);
			const claims = (db, id) => db.prepare("SELECT driver_norm, day FROM invoice_paid_days WHERE invoice_id = ? ORDER BY day").all(id);
			eq("the same paid days claimed", claims(mine.db, a.id), claims(theirs.db, b.id));
			eq(env.TRIP_WORK_DAYS_FROM ? "the day is claimed" : "no day is claimed", claims(mine.db, a.id).length, env.TRIP_WORK_DAYS_FROM ? 1 : 0);
		});
	}

	// ── §9 the rate as generate prices it ───────────────────────────────────────
	await test("§9 the truck's rate when the directory has none (the daily-rate rule off)", async ({ eq }) => {
		const w = base({ payDaily: 0 });
		const { out } = await attempt(w, { dryRun: true });
		const day = out && out.plan.perDay[0];
		eq("rate and source", day && [day.rate, day.source], [265, "the driver's truck (trucks.driver_pay_daily, $250 when blank) $265.00, the last truck naming him; no directory rate"]);
	});
	await test("§9 under the daily-rate rule, the driver's rate in effect that day", async ({ eq, ok }) => {
		const env = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
		const w = base({ env, payRates: [{ subject: "driver", key: NORM, rate: 280, from: "2026-09-01T12:00:00.000Z" }, { subject: "driver", key: NORM, rate: 310, from: "2026-10-05T13:00:00.000Z" }] });
		const { out, err } = await attempt(w);
		eq("written", out && out.state, "written");
		if (err) ok("no error", false, err.message);
		const day = out && out.plan.perDay[0];
		eq("priced at the rate in effect on 10/7", day && day.rate, 310);
		ok("its source says so", day && /^the daily-rate rule \(DRIVER_RATE_ONLY from 2026-10, pays in 2026-10\): the driver's own rate in effect that day/.test(day.source), day && day.source);
		const rd = out && out.invoice ? JSON.parse(out.invoice.render_data) : {};
		eq("the line", rd.lineItems && rd.lineItems[0].description, `${PREFIX} Wednesday, October 7, 2026, $310`);
	});
	await test("§9 the daily-rate rule on, on a database the app never ran with it: the dry run runs, a write refuses and stamps nothing", async ({ eq, ok }) => {
		const env = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
		const w = base({ env });
		w.db.prepare("DELETE FROM app_settings WHERE key = 'driver_rate_only.started'").run();
		const hashes = W.tableHashes(w.db);
		const write = await attempt(w);
		ok("the write refuses", write.err instanceof M.Refusal && /DRIVER_RATE_ONLY is on but the app has never run with it on this database/.test(write.err.message), write.err ? write.err.message : "drafted");
		eq("nothing written, no start record stamped", W.tableHashes(w.db), hashes);
		const copy = W.saveCopy(w, env);
		const dry = W.runScript(SCRIPT_REL, [...CLI_BASE, "--date", "2026-10-20", "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--dry-run"]);
		eq("the dry run runs (exit 0), priced by the rule", [dry.code, /rate \$280\.00, from the daily-rate rule/.test(dry.stdout)], [0, true]);
	});
	await test("§9 the trip work-day rule paying a day of the week refuses: generate the week in the app", async ({ ok }) => {
		const env = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" };
		const at = (lid, s, stamp) => [lid, s, "manual", stamp, ""];
		const w = base({ env, status: [at("M-5101", "At Shipper", "2026-10-07 13:00:00"), at("M-5101", "Delivered", "2026-10-07 21:00:00")] });
		const { err } = await attempt(w);
		ok("refused", err instanceof M.Refusal && /the trip work-day rule pays this week's days for load M-5101; generate the week's invoice in the app instead/.test(err.message), err ? err.message : "drafted");
	});

	// ── §10 a load whose window covers the whole week ───────────────────────────
	await test("§10 a mistyped pickup is named; --loads leaves it out and lists it as related", async ({ eq, ok }) => {
		// The truck also drives on Thursday 10/8, a day only M-5102's window covers.
		const w = base({ extraRows: [M5102()], feedV1: () => feed(1000).park("2026-10-05").drive("2026-10-07", { miles: 320 }).drive("2026-10-08", { miles: 150 }).drive("2026-10-10", { miles: 210 }).pings });
		const all = await attempt(w, { dryRun: true });
		const d = all.out && all.out.plan.perDay[0];
		eq("by default both loads pay 10/7", d && d.loads.map((l) => l.loadId).sort(), ["M-5101", "M-5102"]);
		const lines = all.out ? M.describe(all.out.plan, { ...OPTS }) : [];
		ok("the long window is named", lines.some((l) => l === "NOTE: load M-5102: its pay window runs 21 days (2026-09-22 to 2026-10-12); its Pickup Appointment 2026-09-22 is 17 days before its Assigned Date 2026-10-09: check its appointments. To leave it out, name the other load(s) with --loads."), lines.join("\n"));
		ok("the week's other day it would pay is shown, not drafted", lines.includes("Other days of this week the rules would pay for these loads (not drafted; only --days are): 2026-10-08 (load M-5102)") && all.out.plan.row.loads_count === 1, lines.join("\n"));
		const parked = await attempt(w, { days: ["2026-10-05"] });
		ok("a day its window covers with the truck parked is refused", parked.err instanceof M.Refusal && /would not pay Monday 2026-10-05: the pay window of M-5102 covers it, but the rules drop it: ELD parked \(pings, no movement\)/.test(parked.err.message), parked.err ? parked.err.message : "drafted");
		const only = await attempt(w, { loads: ["5101"] });
		eq("with --loads 5101, written", only.out && only.out.state, "written");
		const p = only.out && only.out.plan;
		eq("only M-5101 pays the day", p && p.perDay[0].loads.map((l) => l.loadId), ["M-5101"]);
		const rel = p ? p.related.find((r) => r.loadId === "M-5102") : null;
		eq("M-5102 is related: left out, the days the rule would pay for it", rel && [rel.why, rel.days], ["left out by --loads", ["2026-10-07", "2026-10-08"]]);
		eq("and no other day is payable through M-5101", p && p.otherDays, []);
		ok("with its note", rel && /pay window runs 21 days/.test(rel.suspect));
		const rd = only.out && only.out.invoice ? JSON.parse(only.out.invoice.render_data) : {};
		ok("the notes name only M-5101", /on load M-5101 completed 2026-10-10:/.test(rd.notes || "") && !/M-5102/.test(rd.notes || ""), rd.notes);
	});

	R.finish();
})().catch((err) => {
	console.error(err.stack || err.message);
	process.exit(1);
});
