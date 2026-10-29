#!/usr/bin/env node
/**
 * scripts/correct-weekly-invoice.js: re-issues ONE Submitted weekly daily-rate
 * invoice in place from a recompute that reads the live Driver Pay Overrides
 * (a Super Admin's "remove" days), on the full server schema
 * (scripts/lib/work-days-world.js) with the server's own generator lifted, an
 * invented driver, truck, ELD feed and loads (made-up data only).
 *
 * The invented case: week Sat 2026-10-03 to Fri 2026-10-09, six loads, the
 * truck moving every day, 7 days at $300 = $2,100. A Super Admin removes Sat to
 * Wed for the driver (5 "remove" overrides); the corrected invoice pays Thu and
 * Fri, $600, 2 days.
 *
 *   §0 the script exists (this runner fails until it does);
 *   §1 the command line: every malformed or missing option is refused (exit 2)
 *      before anything is opened;
 *   §2 the lift: every root lifts and none is denied; ROOTS names exactly the
 *      server.js functions the script calls (api.X); no server.js declaration
 *      hides from the lift behind a `//` comment ending in "." (closure()'s
 *      pitfall: it reads the identifier that starts the next line as a
 *      property), with the detector proven on a sample first;
 *   §3 the composition equals generate: fixture weeks generated through
 *      generateInvoiceHandler() and recomputed through the script (no new
 *      overrides) give identical days (date, loadBol, listed, scheduled, total,
 *      rate), total, loads_count, rate_per_load and load_ids: the real-like
 *      week, the daily-rate rule, the blank-pickup fallback, an early delivery
 *      ("scheduled"), a held day (a live manual invoice pays it) and overrides
 *      present at generation; a percentage invoice is refused;
 *   §4 the dry run: the overrides it relies on, the stored and new 7-row grid,
 *      every changed figure, the periods, the plan time and the fingerprint;
 *      nothing written (module, and the command line on a copy, read-only);
 *   §5 the write: only render_data's days and totalDue, total_earnings and
 *      loads_count change, exactly as the overrides imply; one audit row, a
 *      system change, with the before and after; the PDF re-rendered from the
 *      corrected data with the row's adjustment; an owner-only backup of the
 *      row and the old PDF beside the database; no temporary file left;
 *   §6 idempotent: once this script's audit row exists, a dry run or an apply
 *      prints it and writes nothing (exit 0), whatever the recompute says now;
 *   §7 the fingerprint: an apply needs the dry run's; a change after the dry run
 *      or while the PDF renders is refused inside the transaction, nothing
 *      written, no temporary file left;
 *   §8 the strict override check, both ways: a day the recompute stops paying
 *      without a "remove" override refuses; a "remove" override in the week on a
 *      day the stored invoice does not pay refuses; an "add" override in the
 *      week refuses; no removed day refuses;
 *   §9 the periods: a removed day whose excludedDayPeriods() holds a month other
 *      than its own refuses; a closed month and unreadable locks refuse;
 *   §10 every other refusal, each writing nothing;
 *   §11 a COMMIT that fails after the rename puts the old PDF back and writes
 *      nothing; the post-commit hash check names a PDF that is not this run's.
 *
 * Pure: in-memory databases, temporary copies under the temp directory, child
 * processes of the script itself (dry runs and refusals only), no server, no
 * network, no Chromium (the PDF renderer is a stub).
 * Run: node scripts/test-correct-weekly-invoice.js   # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const W = require("./lib/work-days-world");
const { loadRow } = W;
const { closure, indexDeclarations } = require("./lib/server-lift");

const SCRIPT_REL = "scripts/correct-weekly-invoice.js";
const SCRIPT = path.join(W.ROOT, SCRIPT_REL);
let M = null;
let loadError = null;
try { M = require(SCRIPT); } catch (err) { M = null; loadError = err; }

// ── fixtures (made up) ───────────────────────────────────────────────────────
const NIA = "Nia Brooks";
const NORM = "nia brooks";
const WEEK_START = "2026-10-03";
const WEEK_END = "2026-10-09";
const GENERATED_AT = Date.parse("2026-10-10T01:00:00Z");
const RUN_AT = Date.parse("2026-10-12T15:00:00Z");
const REMOVED = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
const KEPT = ["2026-10-08", "2026-10-09"];
const ALL_DAYS = [...REMOVED, ...KEPT];
const REASON = "Correction: not driven by this driver (ELD log)";
const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ORIGINAL_PDF = Buffer.from("%PDF-1.4 the invoice as issued\n");
const FAKE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const stubPdf = (templateName, data) => Buffer.from(`%PDF-1.4 stub ${templateName} ${sha256(JSON.stringify(data))}\n`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The week modeled on a real one: L0 delivered Saturday 04:42 off a Thursday
// appointment, two loads with rate-con pickups well before their Assigned Date.
function weekRows() {
	const rows = [
		loadRow({ id: "L0", driver: NIA, pickup: "2026-10-01 9:00", dropoff: "2026-10-01 15:00", assigned: "2026-10-01", done: "2026-10-03", truck: "T7" }),
		loadRow({ id: "L1", driver: NIA, pickup: "2026-09-15 7:00", dropoff: "2026-10-05 8:00", assigned: "2026-10-02", done: "2026-10-05", truck: "T7" }),
		loadRow({ id: "L2", driver: NIA, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 10:00", assigned: "2026-10-02", done: "2026-10-06", truck: "T7" }),
		loadRow({ id: "L3", driver: NIA, pickup: "2026-10-06 16:00", dropoff: "2026-10-07 6:30", assigned: "2026-10-06", done: "2026-10-07", truck: "T7" }),
		loadRow({ id: "L4", driver: NIA, pickup: "2026-09-21 0:00", dropoff: "", assigned: "2026-10-07", done: "2026-10-08", truck: "T7" }),
		loadRow({ id: "L5", driver: NIA, pickup: "2026-10-04 0:00", dropoff: "2026-10-09 0:00", assigned: "2026-10-08", done: "2026-10-09", truck: "T7" }),
	];
	rows[0]["Status Update Date"] = "10/3/2026 4:42";
	return rows;
}
// Delivered Tue 10/6, before its Thu 10/8 drop-off appointment: Wed and Thu are
// paid "(scheduled)".
const earlyRows = () => [loadRow({ id: "Q1", driver: NIA, pickup: "2026-10-05 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-04", done: "2026-10-06", truck: "T7" })];
// The blank-pickup fallback: B1 paid from its Assigned Date.
const blankPickupRows = () => [
	loadRow({ id: "B1", driver: NIA, pickup: "", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T7" }),
	loadRow({ id: "B2", driver: NIA, pickup: "2026-10-03 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-04", done: "2026-10-05", truck: "T7" }),
];
function travel(from, to) {
	const f = W.feed(5000);
	for (const d of W.daysFrom(from, to)) f.drive(d, { miles: 300 });
	return f.pings;
}
function addOverride(db, { day, action = "remove", reason = REASON, by = "super_admin", at = "2026-10-11 14:00:00", driver = NORM }) {
	return Number(db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by, excluded_at, action) VALUES (?, ?, ?, ?, ?, ?)")
		.run(driver, day, reason, by, at, action).lastInsertRowid);
}
function addManualInvoice(db, { number, lines, status = "Draft" }) {
	const render = { payeeName: NIA, lineItems: lines, deductions: [], subtotal: 0, deductionsTotal: 0, totalDue: 0, notes: "", preparedBy: "admin", adjustment: 0, adjustmentNote: "", __templateName: "service_invoice_manual" };
	db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`).run(number, NORM, WEEK_START, WEEK_END, lines.length, lines.reduce((c, l) => c + l.amount, 0), status, `${number}.pdf`, JSON.stringify(render));
}

// One generated week, through generateInvoiceHandler(), then submitted.
async function generated({ env = {}, rows = weekRows, payType = "fixed", payDaily = 300, before = null, submit = true } = {}) {
	const w = W.startWorld({
		env, now: GENERATED_AT, rows: rows(),
		drivers: [{ name: NIA, payDaily, payType, payPct: payType === "percentage" ? 30 : 0 }],
		trucks: [{ unit: "T7", driver: NIA, vid: "V7" }],
		pings: { V7: travel("2026-09-28", "2026-10-11") },
	});
	if (before) before(w);
	const g = await W.generate(w, NIA, WEEK_END);
	if (g.status !== 200) throw new Error(`generate answered ${g.status}: ${JSON.stringify(g.body).slice(0, 300)}`);
	if (submit) w.db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = '2026-10-10T01:05:00.000Z' WHERE id = ?").run(g.invoice.id);
	w.clock.ms = RUN_AT;
	return { w, env, id: g.invoice.id, g };
}

// A fixture to run the script on: a copy of a generated world's database, the
// overrides a Super Admin adds (Sat-Wed removed unless told), the issued PDF in
// the data folder, and the script's world on that copy.
function stage(base, { removed = REMOVED, env = base.env, pdf = ORIGINAL_PDF, mutate = null } = {}) {
	const db = new W.Database(base.w.db.serialize());
	const overrideIds = {};
	for (const day of removed) overrideIds[day] = addOverride(db, { day });
	const dataDir = W.tempDir();
	const dir = path.join(dataDir, "uploads", "invoices");
	fs.mkdirSync(dir, { recursive: true });
	const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(base.id);
	const s = {
		db, env, dataDir, dir, overrideIds, id: row.id, number: row.invoice_number, pdfPath: path.join(dir, row.pdf_file_name),
		rows: base.w.rows.map((r) => ({ ...r })), rendered: [], onRender: null,
	};
	if (pdf) fs.writeFileSync(s.pdfPath, pdf);
	if (mutate) mutate(s);
	const render = async (templateName, data) => {
		s.rendered.push({ templateName, data: JSON.parse(JSON.stringify(data)) });
		if (s.onRender) await s.onRender();
		return stubPdf(templateName, data);
	};
	s.world = M.buildWorld({ db, env, dataDir, render, log: quiet, now: RUN_AT });
	s.api = s.world.api;
	s.values = () => ({ values: W.sheetValues(s.rows) });
	s.opts = (o = {}) => ({ invoice: s.number, apply: false, expect: null, ...o });
	s.ctx = (o = {}) => ({ dataDir, dbFile: path.join(dataDir, "app.db"), clock: () => RUN_AT, commit: () => FAKE_COMMIT, ...o });
	s.plan = (o = {}) => M.plan(db, s.api, s.values(), s.opts(o), s.ctx());
	s.run = (o = {}, c = {}) => M.run(db, s.api, s.values(), s.opts(o), s.ctx(c));
	s.row = () => db.prepare("SELECT * FROM invoices WHERE id = ?").get(s.id);
	s.audits = () => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(M.AUDIT_ACTION);
	s.files = () => fs.readdirSync(dir).sort();
	return s;
}
// Throws -> the error; returns -> null.
function caught(fn) { try { fn(); return null; } catch (err) { return err; } }
async function caughtAsync(fn) { try { await fn(); return null; } catch (err) { return err; } }
const isRefusal = (err, re) => !!err && err instanceof M.Refusal && re.test(err.message);
// Every table's rows hashed, and the PDF folder's files with their hashes.
const snapshot = (s) => ({ tables: W.tableHashes(s.db), files: s.files().map((f) => `${f} ${sha256(fs.readFileSync(path.join(s.dir, f)))}`) });

// Each identifier that starts a line right after a `//` comment ending in a
// single ".": closure() reads it as a property access, so it never lifts the
// declaration it names.
function hiddenAfterDotComment(text) {
	const out = new Set();
	let inBlock = false;
	let afterDot = false;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		if (inBlock) { if (t.includes("*/")) inBlock = false; afterDot = false; continue; }
		if (t.startsWith("/*") && !t.includes("*/")) { inBlock = true; afterDot = false; continue; }
		const first = /^[A-Za-z_$][\w$]*/.exec(t);
		if (afterDot && first) out.add(first[0]);
		afterDot = t.includes("//") && /(^|[^.])\.$/.test(t);
	}
	return [...out];
}

const unpaid = (date) => ({ date, loadBol: "", total: 0, completed: false, listed: [], scheduled: [] });
const paid = (date, loadBol, listed) => ({ date, loadBol, total: 300, completed: true, listed, scheduled: [], rate: 300 });
const STORED_DAYS = {
	Saturday: paid("2026-10-03", "L1, L4", ["L0", "L1"]), Sunday: paid("2026-10-04", "L1, L4, L5", ["L1"]),
	Monday: paid("2026-10-05", "L1, L2, L4, L5", ["L1", "L2"]), Tuesday: paid("2026-10-06", "L2, L3, L4, L5", ["L2", "L3"]),
	Wednesday: paid("2026-10-07", "L3, L4, L5", ["L3", "L4"]), Thursday: paid("2026-10-08", "L4, L5", ["L4", "L5"]), Friday: paid("2026-10-09", "L5", ["L5"]),
};
const NEW_DAYS = {
	Saturday: unpaid("2026-10-03"), Sunday: unpaid("2026-10-04"), Monday: unpaid("2026-10-05"), Tuesday: unpaid("2026-10-06"), Wednesday: unpaid("2026-10-07"),
	Thursday: paid("2026-10-08", "L4, L5", ["L4", "L5"]), Friday: paid("2026-10-09", "L5", ["L5"]),
};

(async () => {
	const R = W.createRunner("correct-weekly-invoice: one Submitted weekly invoice re-issued in place from the live Driver Pay Overrides");
	const test = R.test;

	// ── §0 ──────────────────────────────────────────────────────────────────────
	await test("§0 the script exists and loads as a module", async ({ ok }) => {
		ok(`${SCRIPT_REL} loads`, !!M, loadError ? String(loadError.message).split("\n")[0] : `${SCRIPT_REL} does not exist yet (the fix adds it)`);
	});
	if (!M) { R.finish(); return; }

	const base = await generated();

	// ── §1 the command line ─────────────────────────────────────────────────────
	await test("§1 a full command line reads; malformed ones are refused before anything opens", async ({ eq, ok }) => {
		const FP = "0123456789abcdef";
		const full = M.readOptions(["--invoice", "INV-XX-2026W40-01", "--db", "/x/app.db", "--values-json", "/x/v.json", "--apply", `--expect=${FP}`]);
		eq("read", [full.invoice, full.db, full.valuesJson, full.sheetId, full.apply, full.expect], ["INV-XX-2026W40-01", "/x/app.db", "/x/v.json", null, true, FP]);
		const dry = M.readOptions(["--invoice", "INV-XX-2026W40-01", "--sheet-id", "env"]);
		eq("a dry run by default, --db optional", [dry.apply, dry.expect, dry.db, dry.sheetId], [false, null, null, "env"]);
		const needs = ["--values-json", "/x/v.json"];
		const refuses = (name, argv, re) => {
			const err = caught(() => M.readOptions(argv));
			ok(`refuses ${name}`, isRefusal(err, re), err ? err.message : "accepted");
		};
		refuses("an unknown option", ["--invoice", "INV-1", ...needs, "--remove-days", "2026-10-03"], /unknown option --remove-days/);
		refuses("no --invoice", [...needs], /--invoice/);
		refuses("--invoice with no value", ["--invoice", "--apply", ...needs], /--invoice/);
		refuses("an invoice number with a path in it", ["--invoice", "../INV-1", ...needs], /--invoice/);
		refuses("--apply without --expect", ["--invoice", "INV-1", ...needs, "--apply"], /--expect/);
		refuses("--expect without --apply", ["--invoice", "INV-1", ...needs, `--expect=${FP}`], /--apply/);
		refuses("a malformed --expect", ["--invoice", "INV-1", ...needs, "--apply", "--expect=xyz"], /--expect/);
		refuses("--apply with a value", ["--invoice", "INV-1", ...needs, "--apply=yes", `--expect=${FP}`], /--apply takes no value/);
		refuses("--dry-run with --apply", ["--invoice", "INV-1", ...needs, "--dry-run", "--apply", `--expect=${FP}`], /--dry-run/);
		refuses("no sheet", ["--invoice", "INV-1"], /--sheet-id/);
		refuses("two sheets", ["--invoice", "INV-1", ...needs, "--sheet-id", "env"], /one of --sheet-id/);
		const cli = W.runScript(SCRIPT_REL, ["--invoice", "INV-1", ...needs, "--rate", "300"]);
		eq("the command line exits 2 on an unknown option", [cli.code, /REFUSED: unknown option --rate/.test(cli.stderr)], [2, true]);
		const elsewhere = W.runScript(SCRIPT_REL, ["--invoice", "INV-1", "--db", path.join(W.ROOT, "scripts", "app.db"), ...needs]);
		eq("a database outside the app directory and the temp directory is refused (exit 2)", [elsewhere.code, /REFUSED: refusing .*a copy under the temp directory/.test(elsewhere.stderr)], [2, true]);
	});

	// ── §2 the lift ─────────────────────────────────────────────────────────────
	await test("§2 every root lifts, none denied; ROOTS is exactly what the script calls; nothing hides behind a comment ending in \".\"", async ({ eq, ok }) => {
		const sample = "function outer() {\n\t// Calls inner.\n\tinner();\n}\nfunction inner() {\n\treturn 1;\n}\n";
		const sampleLift = closure(sample, { roots: ["outer"] });
		ok("closure()'s pitfall is real: the call after the comment is not lifted", !sampleLift.names.includes("inner"), sampleLift.names.join(", "));
		eq("the detector finds it", hiddenAfterDotComment(sampleLift.text), ["inner"]);
		const s = stage(base);
		const world = s.world;
		ok("every root lifts", M.ROOTS.every((r) => world.liftedNames.includes(r)), M.ROOTS.filter((r) => !world.liftedNames.includes(r)).join(", "));
		ok("no denied name is lifted", !world.liftedNames.some((n) => M.DENIED.includes(n)), world.liftedNames.filter((n) => M.DENIED.includes(n)).join(", "));
		ok("the world hands back every root", M.ROOTS.every((n) => n in world.api), M.ROOTS.filter((n) => !(n in world.api)).join(", "));
		const src = fs.readFileSync(SCRIPT, "utf8");
		const called = [...new Set([...src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
		eq("ROOTS names every server.js function the script calls, and nothing else", [...M.ROOTS].sort(), called);
		const { decls } = indexDeclarations(W.SRC);
		const lifted = new Set(world.liftedNames);
		const hidden = hiddenAfterDotComment(world.liftedText).filter((id) => decls.has(id) && !lifted.has(id) && !M.PROVIDED.includes(id));
		eq("no server.js declaration the lifted code calls is left out", hidden, []);
	});

	// ── §3 the composition equals generate ─────────────────────────────────────
	const composition = async (label, { env = {}, rows = weekRows, before = null } = {}) => {
		const b = await generated({ env, rows, before, submit: false });
		const row = b.w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(b.id);
		const world = M.buildWorld({ db: b.w.db, env, dataDir: W.tempDir(), render: async () => ORIGINAL_PDF, log: quiet, now: GENERATED_AT });
		const r = M.recompute(b.w.db, world.api, { values: W.sheetValues(b.w.rows) }, { driverName: row.driver, weekEnd: row.week_end });
		const stored = JSON.parse(row.render_data);
		return {
			label,
			got: { days: JSON.parse(JSON.stringify(r.days)), total: r.totalEarnings, loadsCount: r.loadsCount, ratePerLoad: r.ratePerLoad, loadIds: r.loadIds, expenseIds: r.expenseIds, expensesTotal: r.expensesTotal },
			want: { days: stored.days, total: row.total_earnings, loadsCount: row.loads_count, ratePerLoad: row.rate_per_load, loadIds: JSON.parse(row.load_ids), expenseIds: JSON.parse(row.expense_ids), expensesTotal: row.expenses_total },
			stored, row,
		};
	};
	await test("§3a the real-like week: the recompute is generate's invoice exactly (7 rows with date, loadBol, listed, scheduled, total and rate; $2,100; 7 days; $300; 6 loads)", async ({ eq }) => {
		const c = await composition("real-like week");
		eq("days, total, loads_count, rate_per_load, load_ids, expenses", c.got, c.want);
		eq("…and the stored grid is the one this runner expects", c.stored.days, STORED_DAYS);
		eq("[total, loads_count]", [c.row.total_earnings, c.row.loads_count], [2100, 7]);
	});
	await test("§3b the daily-rate rule on (DRIVER_RATE_ONLY from 2026-10), the blank-pickup fallback on, an early delivery (\"scheduled\" days): the recompute is generate's invoice exactly", async ({ eq, ok }) => {
		for (const c of [
			await composition("daily-rate rule", { env: { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" } }),
			await composition("blank-pickup fallback", { env: { INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2026-10" }, rows: blankPickupRows }),
			await composition("early delivery", { rows: earlyRows }),
		]) eq(c.label, c.got, c.want);
		const early = await composition("early delivery", { rows: earlyRows });
		ok("the early delivery's grid holds scheduled days", GRID.some((n) => (early.got.days[n].scheduled || []).length), JSON.stringify(early.got.days));
	});
	await test("§3c a held day (a live manual invoice pays Thu 10/8) and overrides present at generation (Wed 10/7 removed, Sat 10/3 added on an early-delivery week): the recompute is generate's invoice exactly", async ({ eq, ok }) => {
		const held = await composition("held day", { before: (w) => addManualInvoice(w.db, { number: "INV-M-NB-01", lines: [{ date: "2026-10-08", description: "Missed week 2026-10-03 to 2026-10-09: Thursday, October 8, 2026, $300", amount: 300 }] }) });
		eq("held day", held.got, held.want);
		ok("…generate left 10/8 off", held.stored.days.Thursday.completed === false, JSON.stringify(held.stored.days.Thursday));
		const ovr = await composition("overrides", { rows: earlyRows, before: (w) => { addOverride(w.db, { day: "2026-10-07" }); addOverride(w.db, { day: "2026-10-03", action: "add" }); } });
		eq("overrides", ovr.got, ovr.want);
		eq("…generate removed 10/7 and added 10/3", [ovr.stored.days.Wednesday.completed, ovr.stored.days.Saturday.completed], [false, true]);
	});
	await test("§3d a percentage driver's invoice is refused, by the recompute and by the plan", async ({ ok }) => {
		const b = await generated({ payType: "percentage" });
		const row = b.w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(b.id);
		const world = M.buildWorld({ db: b.w.db, env: {}, dataDir: W.tempDir(), render: async () => ORIGINAL_PDF, log: quiet, now: RUN_AT });
		const err = caught(() => M.recompute(b.w.db, world.api, { values: W.sheetValues(b.w.rows) }, { driverName: row.driver, weekEnd: row.week_end }));
		ok("the recompute refuses", isRefusal(err, /percentage/), err && err.message);
		const s = stage(b, { removed: [] });
		const p = caught(() => s.plan());
		ok("the plan refuses", isRefusal(p, /percentage/), p && p.message);
	});

	// ── §4 the dry run ──────────────────────────────────────────────────────────
	await test("§4a the dry run (module): the overrides, the stored and new grid, the changed figures, the periods, the plan time and the fingerprint; nothing written", async ({ eq, ok }) => {
		const s = stage(base);
		const before = snapshot(s);
		const out = await s.run();
		eq("state", out.state, "dry-run");
		ok("a fingerprint of 16 hex digits", /^[0-9a-f]{16}$/.test(out.plan.fingerprint), out.plan.fingerprint);
		eq("removed days", out.plan.removed.map((r) => r.day), REMOVED);
		eq("…each with its override", out.plan.removed.map((r) => [r.override.id, r.override.reason, r.override.excludedBy, r.override.excludedAt]),
			REMOVED.map((d) => [s.overrideIds[d], REASON, "super_admin", "2026-10-11T14:00:00Z"]));
		eq("…and its periods", out.plan.removed.map((r) => r.periods), REMOVED.map(() => ["2026-10"]));
		eq("kept days", out.plan.kept, KEPT);
		eq("the new grid", out.plan.next.days, NEW_DAYS);
		eq("[total, loads_count, totalDue] before and after", [out.plan.before.total, out.plan.after.total, out.plan.before.loadsCount, out.plan.after.loadsCount, out.plan.before.totalDue, out.plan.after.totalDue],
			[2100, 600, 7, 2, 2100, 600]);
		const text = M.describe(out).join("\n");
		for (const want of [
			"DRY RUN: nothing written.",
			`Invoice ${s.number} (id ${s.id}): weekly, Submitted`,
			`  2026-10-03 Saturday: override #${s.overrideIds["2026-10-03"]}, by super_admin at 2026-10-11T14:00:00Z, reason "${REASON}"`,
			"  2026-10-07: 2026-10 (open)",
			"  Saturday   2026-10-03  $300.00  L1, L4  ->  $0.00  not paid  (removed)",
			"  Thursday   2026-10-08  $300.00  L4, L5  ->  $300.00  L4, L5 (lists L4, L5)  (kept)",
			"  days paid: 7 -> 2",
			"  total_earnings: $2,100.00 -> $600.00",
			"  loads_count: 7 -> 2",
			"  render totalDue: $2,100.00 -> $600.00",
			"Plan time: ",
			`Fingerprint: ${out.plan.fingerprint}`,
		]) ok(`prints ${JSON.stringify(want)}`, text.includes(want), text);
		eq("nothing written", snapshot(s), before);
		eq("nothing rendered", s.rendered.length, 0);
	});
	await test("§4b the dry run (command line, on a copy): exit 0, read-only, the same fingerprint as the module's, nothing written", async ({ eq, ok }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		const copy = W.saveCopy({ db: s.db, rows: s.rows }, s.env);
		const pdfDir = path.join(copy.dir, "uploads", "invoices");
		fs.mkdirSync(pdfDir, { recursive: true });
		fs.writeFileSync(path.join(pdfDir, path.basename(s.pdfPath)), ORIGINAL_PDF);
		const before = fs.readFileSync(copy.db);
		const r = W.runScript(SCRIPT_REL, ["--invoice", s.number, "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile]);
		eq("exit 0", r.code, 0);
		ok("DRY RUN", /^DRY RUN: nothing written\.$/m.test(r.stdout), r.stdout + r.stderr);
		ok("the module's fingerprint", r.stdout.includes(`Fingerprint: ${fp}`), r.stdout);
		ok("prints how to apply", r.stdout.includes(`--apply --expect=${fp}`), r.stdout);
		ok("the database file is unchanged", fs.readFileSync(copy.db).equals(before));
		eq("the PDF folder is unchanged", fs.readdirSync(pdfDir), [path.basename(s.pdfPath)]);
		ok("no backup was taken", !fs.readdirSync(copy.dir).some((f) => f.includes("pre-invoice-correction")), fs.readdirSync(copy.dir).join(", "));
	});

	// ── §5 the write ────────────────────────────────────────────────────────────
	await test("§5a the apply: only render_data's days and totalDue, total_earnings and loads_count change, exactly as the overrides imply; every other column and table stays", async ({ eq, ok }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		const rowBefore = s.row();
		const tablesBefore = W.tableHashes(s.db);
		const out = await s.run({ apply: true, expect: fp });
		eq("state", out.state, "written");
		const rowAfter = s.row();
		const cols = Object.keys(rowBefore).filter((k) => !["render_data", "total_earnings", "loads_count"].includes(k));
		eq("every other column", cols.map((k) => rowAfter[k]), cols.map((k) => rowBefore[k]));
		eq("[total_earnings, loads_count]", [rowAfter.total_earnings, rowAfter.loads_count], [2100 - REMOVED.length * 300, 7 - REMOVED.length]);
		const a = JSON.parse(rowBefore.render_data);
		const b = JSON.parse(rowAfter.render_data);
		eq("render_data keys", Object.keys(b), Object.keys(a));
		const other = Object.keys(a).filter((k) => !["days", "totalDue"].includes(k));
		eq("every other render_data field", other.map((k) => b[k]), other.map((k) => a[k]));
		eq("totalDue", [a.totalDue, b.totalDue], [2100, 600]);
		eq("days: the removed days unpaid as generate writes an unpaid day, the kept days as they were", b.days, NEW_DAYS);
		eq("the days the invoice pays (invoicePaidDaysOf(), as Financials reads them)", s.api.invoicePaidDaysOf(rowAfter), KEPT);
		eq("the days it paid before", s.api.invoicePaidDaysOf(rowBefore), ALL_DAYS);
		eq("total due", s.api.invoiceTotalDue(rowAfter), 600);
		const tablesAfter = W.tableHashes(s.db);
		const changed = Object.keys(tablesAfter).filter((t) => tablesAfter[t] !== tablesBefore[t]).sort();
		eq("only invoices and audit_trail change", changed, ["audit_trail", "invoices"]);
		eq("one audit row", s.audits().length, 1);
		ok("the write lock time is measured", Number.isFinite(out.lockMs) && out.lockMs >= 0, String(out.lockMs));
	});
	await test("§5b the audit row: a system change naming the before and after, each override, the PDF hashes, the commit and the backup", async ({ eq, ok }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		const out = await s.run({ apply: true, expect: fp });
		const [a] = s.audits();
		eq("[user_id, username, role, action, entity, entity_id, timestamp]", [a.user_id, a.username, a.role, a.action, a.entity, a.entity_id, a.timestamp],
			[0, "system: invoice correction script", "system", "correct_weekly_invoice", "invoice", String(s.id), new Date(RUN_AT).toISOString()]);
		eq("the audit id returned", out.auditId, a.id);
		for (const want of [
			`${s.number} (weekly, Submitted)`,
			`days ${ALL_DAYS.join(", ")} -> ${KEPT.join(", ")}`,
			"total $2,100.00 -> $600.00", "loads_count 7 -> 2", "totalDue $2,100.00 -> $600.00",
			...REMOVED.map((d) => `${d} (override #${s.overrideIds[d]}, "${REASON}", by super_admin at 2026-10-11T14:00:00Z, period 2026-10)`),
			`sha256 ${sha256(ORIGINAL_PDF)} -> ${out.newSha256}`,
			`git ${FAKE_COMMIT}`,
			`backup ${out.backup.dir}`,
		]) ok(`details name ${JSON.stringify(want)}`, a.details.includes(want), a.details);
	});
	await test("§5c the PDF: rendered once from the corrected data with the row's adjustment; written over the served file; the old one and the row backed up beside the database, owner-only; no temporary file left", async ({ eq, ok }) => {
		const s = stage(base, { mutate: (x) => x.db.prepare("UPDATE invoices SET adjustment = 50, adjustment_note = 'Detention', adjusted_by = 'super_admin', adjusted_at = '2026-10-10T02:00:00.000Z' WHERE id = ?").run(x.id) });
		const fp = (await s.run()).plan.fingerprint;
		const rowBefore = s.row();
		const out = await s.run({ apply: true, expect: fp });
		eq("rendered once, with the weekly template", s.rendered.map((r) => r.templateName), ["service_invoice"]);
		const d = s.rendered[0].data;
		eq("the render's [days, totalDue, adjustment, adjustmentNote, __templateName]", [d.days, d.totalDue, d.adjustment, d.adjustmentNote, d.__templateName], [NEW_DAYS, 600, 50, "Detention", undefined]);
		ok("the served PDF is the new render", fs.readFileSync(s.pdfPath).equals(stubPdf("service_invoice", d)));
		eq("the new hash returned", out.newSha256, sha256(fs.readFileSync(s.pdfPath)));
		eq("no other file in the PDF folder", s.files(), [path.basename(s.pdfPath)]);
		const dir = out.backup.dir;
		ok("the backup sits beside the database, outside uploads/", path.dirname(dir) === s.dataDir && path.basename(dir).startsWith(`app.db.pre-invoice-correction-${s.id}-`), dir);
		eq("the backup's mode", (fs.statSync(dir).mode & 0o777).toString(8), "700");
		eq("the backup's files", fs.readdirSync(dir).sort(), ["invoice-row.json", path.basename(s.pdfPath)].sort());
		ok("the old PDF is in it", fs.readFileSync(path.join(dir, path.basename(s.pdfPath))).equals(ORIGINAL_PDF));
		eq("the row as it was is in it", JSON.parse(fs.readFileSync(path.join(dir, "invoice-row.json"), "utf8")), rowBefore);
		eq("files owner-only", fs.readdirSync(dir).map((f) => (fs.statSync(path.join(dir, f)).mode & 0o777).toString(8)), ["600", "600"]);
		eq("the post-commit check passed", out.check.ok, true);
		eq("total due with the adjustment", s.api.invoiceTotalDue(s.row()), 650);
	});
	await test("§5d a grid stored before rows carried date, listed and scheduled (the shape issued before #610) is corrected the same way: the kept days compare on completed, total, rate and loadBol", async ({ eq }) => {
		const s = stage(base, {
			mutate: (x) => {
				const rd = JSON.parse(x.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(x.id).render_data);
				for (const n of GRID) { delete rd.days[n].date; delete rd.days[n].listed; delete rd.days[n].scheduled; }
				x.db.prepare("UPDATE invoices SET render_data = ? WHERE id = ?").run(JSON.stringify(rd), x.id);
			},
		});
		const fp = (await s.run()).plan.fingerprint;
		const out = await s.run({ apply: true, expect: fp });
		eq("state", out.state, "written");
		eq("the new grid", JSON.parse(s.row().render_data).days, NEW_DAYS);
	});

	// ── §6 idempotent ───────────────────────────────────────────────────────────
	await test("§6 once this script's audit row exists: a dry run or an apply prints it and writes nothing, whatever the recompute says now (module and command line)", async ({ eq, ok }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		await s.run({ apply: true, expect: fp });
		const after = snapshot(s);
		const again = await s.run({ apply: true, expect: fp });
		eq("an apply again: already", again.state, "already");
		eq("…naming the audit row", again.plan.audit.id, s.audits()[0].id);
		eq("…writing nothing", snapshot(s), after);
		s.db.prepare("DELETE FROM excluded_driver_days").run();
		const gone = snapshot(s);
		const dry = await s.run();
		eq("a dry run with the overrides gone: still already", dry.state, "already");
		const apply = await s.run({ apply: true, expect: fp });
		eq("an apply with the overrides gone: still already", apply.state, "already");
		eq("nothing written", snapshot(s), gone);
		ok("describe says so", M.describe(dry).join("\n").includes(`already corrected: audit row #${s.audits()[0].id}`), M.describe(dry).join("\n"));
		const copy = W.saveCopy({ db: s.db, rows: s.rows }, s.env);
		fs.mkdirSync(path.join(copy.dir, "uploads", "invoices"), { recursive: true });
		const r = W.runScript(SCRIPT_REL, ["--invoice", s.number, "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--apply", `--expect=${fp}`]);
		eq("the command line: exit 0", r.code, 0);
		ok("…and says already corrected", /already corrected: audit row #\d+/.test(r.stdout), r.stdout + r.stderr);
	});

	// ── §7 the fingerprint ──────────────────────────────────────────────────────
	await test("§7a an apply needs the dry run's fingerprint: another one, or a change after the dry run (an override's reason edited), is refused and writes nothing", async ({ ok, eq }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		const before = snapshot(s);
		const wrong = await caughtAsync(() => s.run({ apply: true, expect: "ffffffffffffffff" }));
		ok("a wrong fingerprint refuses", isRefusal(wrong, /fingerprint/), wrong && wrong.message);
		s.db.prepare("UPDATE excluded_driver_days SET reason = 'edited' WHERE excluded_date = '2026-10-05'").run();
		const moved = await caughtAsync(() => s.run({ apply: true, expect: fp }));
		ok("a change since the dry run refuses", isRefusal(moved, /fingerprint/), moved && moved.message);
		const after = snapshot(s);
		eq("nothing but the edit", [after.files, Object.keys(after.tables).filter((t) => after.tables[t] !== before.tables[t])], [before.files, ["excluded_driver_days"]]);
		eq("nothing rendered", s.rendered.length, 0);
		const cli = W.saveCopy({ db: s.db, rows: s.rows }, s.env);
		fs.mkdirSync(path.join(cli.dir, "uploads", "invoices"), { recursive: true });
		fs.writeFileSync(path.join(cli.dir, "uploads", "invoices", path.basename(s.pdfPath)), ORIGINAL_PDF);
		const r = W.runScript(SCRIPT_REL, ["--invoice", s.number, "--db", cli.db, "--values-json", cli.values, "--env-file", cli.envFile, "--apply", `--expect=${fp}`]);
		eq("the command line: exit 2", [r.code, /REFUSED: .*fingerprint/.test(r.stderr)], [2, true]);
	});
	await test("§7b a change while the PDF renders (an adjustment, an override deleted) is refused inside the transaction: nothing written, the served PDF as it was, no temporary file left", async ({ ok, eq }) => {
		for (const [label, change] of [
			["an adjustment", (s) => s.db.prepare("UPDATE invoices SET adjustment = 25, adjusted_at = '2026-10-12T14:59:00.000Z' WHERE id = ?").run(s.id)],
			["an override deleted", (s) => s.db.prepare("DELETE FROM excluded_driver_days WHERE excluded_date = '2026-10-04'").run()],
		]) {
			const s = stage(base);
			const fp = (await s.run()).plan.fingerprint;
			const rowBefore = s.row();
			s.onRender = async () => change(s);
			const err = await caughtAsync(() => s.run({ apply: true, expect: fp }));
			ok(`${label}: refused once the database is held`, isRefusal(err, /nothing was written/), err && err.message);
			eq(`${label}: the row's render_data and figures`, [s.row().render_data, s.row().total_earnings, s.row().loads_count], [rowBefore.render_data, rowBefore.total_earnings, rowBefore.loads_count]);
			eq(`${label}: no audit row`, s.audits().length, 0);
			ok(`${label}: the served PDF as it was`, fs.readFileSync(s.pdfPath).equals(ORIGINAL_PDF));
			eq(`${label}: no temporary file`, s.files(), [path.basename(s.pdfPath)]);
		}
	});

	// ── §8 the strict override check ────────────────────────────────────────────
	await test("§8a a day the recompute stops paying without a \"remove\" override is refused: the ELD shows the truck parked on Thu 10/8, or a manual invoice now pays it", async ({ ok }) => {
		const parked = stage(base, {
			mutate: (x) => x.db.prepare("UPDATE routemate_telemetry SET speed = 0 WHERE location_date_ms >= ? AND location_date_ms < ?").run(Date.parse("2026-10-08T05:00:00Z"), Date.parse("2026-10-09T05:00:00Z")),
		});
		const e1 = caught(() => parked.plan());
		ok("ELD parked", isRefusal(e1, /2026-10-08.*no live "remove" override/), e1 && e1.message);
		const heldNow = stage(base, { mutate: (x) => addManualInvoice(x.db, { number: "INV-M-NB-02", lines: [{ date: "2026-10-08", description: "Missed week 2026-10-03 to 2026-10-09: Thursday, October 8, 2026, $300", amount: 300 }] }) });
		const e2 = caught(() => heldNow.plan());
		ok("a manual invoice pays it now", isRefusal(e2, /2026-10-08.*no live "remove" override/), e2 && e2.message);
	});
	await test("§8b a live \"remove\" override in the week on a day the stored invoice does not pay is refused (the invoice was generated with Fri 10/9 already removed)", async ({ ok }) => {
		const b = await generated({ before: (w) => addOverride(w.db, { day: "2026-10-09", reason: "earlier" }) });
		const s = stage(b);
		const err = caught(() => s.plan());
		ok("refused", isRefusal(err, /2026-10-09.*does not pay/), err && err.message);
	});
	await test("§8c an \"add\" override in the week refuses; no removed day refuses (nothing to correct)", async ({ ok }) => {
		const add = stage(base, { mutate: (x) => addOverride(x.db, { day: "2026-10-09", action: "add" }) });
		const e1 = caught(() => add.plan());
		ok("an add override", isRefusal(e1, /"add" override/), e1 && e1.message);
		const none = stage(base, { removed: [] });
		const e2 = caught(() => none.plan());
		ok("nothing removed", isRefusal(e2, /nothing to correct/), e2 && e2.message);
		const other = stage(base, { removed: [], mutate: (x) => addOverride(x.db, { day: "2026-10-04", driver: "someone else" }) });
		const e3 = caught(() => other.plan());
		ok("another driver's override does not count", isRefusal(e3, /nothing to correct/), e3 && e3.message);
		const outside = stage(base, { mutate: (x) => addOverride(x.db, { day: "2026-10-10" }) });
		ok("an override outside the week does not block", !caught(() => outside.plan()));
	});

	// ── §9 the periods ──────────────────────────────────────────────────────────
	await test("§9 the periods: a removed day a September-assigned load covers moves 2026-09 too and is refused (open or closed); a closed month and unreadable locks refuse", async ({ ok }) => {
		const sept = stage(base, {
			mutate: (x) => x.rows.push(loadRow({ id: "S9", driver: NIA, pickup: "2026-10-03 8:00", dropoff: "2026-10-12 8:00", assigned: "2026-09-30", status: "Dispatched", truck: "T7" })),
		});
		const e1 = caught(() => sept.plan());
		ok("September open", isRefusal(e1, /2026-10-03.*2026-09/), e1 && e1.message);
		sept.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-15T05:00:00.000Z', 'test')").run();
		const e2 = caught(() => sept.plan());
		ok("September closed", isRefusal(e2, /2026-09/), e2 && e2.message);
		const closed = stage(base, { mutate: (x) => x.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-10', 'locked', '2026-11-15T05:00:00.000Z', 'test')").run() });
		const e3 = caught(() => closed.plan());
		ok("October closed", isRefusal(e3, /closed|locked/), e3 && e3.message);
		const unreadable = stage(base, { mutate: (x) => x.db.exec("DROP TABLE period_locks") });
		const e4 = caught(() => unreadable.plan());
		ok("locks unreadable", isRefusal(e4, /can't be read|cannot be read/), e4 && e4.message);
	});

	// ── §10 every other refusal ─────────────────────────────────────────────────
	await test("§10a the invoice: unknown, not Submitted, deleted, manual, a correction, Personal lines (row, snapshot, ledger), an invoice_paid_days row, the trip work-day rule on", async ({ ok }) => {
		const set = (sql, ...args) => (x) => x.db.prepare(sql).run(...args, x.id);
		const cases = [
			["an unknown number", { mutate: (x) => { x.number = "INV-NONE-01"; } }, /no invoice numbered INV-NONE-01/],
			["a Draft", { mutate: set("UPDATE invoices SET status = 'Draft' WHERE id = ?") }, /Draft.*only a Submitted/],
			["an Approved invoice", { mutate: set("UPDATE invoices SET status = 'Approved' WHERE id = ?") }, /Approved.*only a Submitted/],
			["a Paid invoice", { mutate: set("UPDATE invoices SET status = 'Paid' WHERE id = ?") }, /Paid.*only a Submitted/],
			["a deleted invoice", { mutate: set("UPDATE invoices SET deleted_at = '2026-10-11T00:00:00Z' WHERE id = ?") }, /deleted/],
			["a manual invoice", { mutate: set("UPDATE invoices SET is_manual = 1 WHERE id = ?") }, /manual/],
			["a correction invoice", { mutate: set("UPDATE invoices SET correction_of = 99 WHERE id = ?") }, /correction/],
			["a Personal total on the row", { mutate: set("UPDATE invoices SET personal_total = 12.5 WHERE id = ?") }, /Personal/],
			["Personal lines in the snapshot", {
				mutate: (x) => {
					const rd = JSON.parse(x.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(x.id).render_data);
					rd.personalLines = [{ label: "Personal expense", cents: -1250 }];
					x.db.prepare("UPDATE invoices SET render_data = ? WHERE id = ?").run(JSON.stringify(rd), x.id);
				},
			}, /Personal/],
			["a Personal line on the ledger", {
				mutate: (x) => {
					x.db.exec(require(path.join(W.ROOT, "lib", "personal-expense.js")).SCHEMA_SQL);
					x.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, invoice_id, created_at, created_by, created_by_id, created_role)
						VALUES (1, 'deduct', 1250, 4000, '2026-10', 1, '2026-10-05', ?, ?, '2026-10-06T00:00:00Z', 'super_admin', 1, 'Super Admin')`).run(WEEK_START, x.id);
				},
			}, /Personal/],
			["an invoice_paid_days row", { mutate: (x) => x.db.prepare("INSERT INTO invoice_paid_days (driver_norm, day, invoice_id) VALUES (?, '2026-10-03', ?)").run(NORM, x.id) }, /invoice_paid_days/],
			["the trip work-day rule on", { env: { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" } }, /TRIP_WORK_DAYS/],
		];
		for (const [label, o, re] of cases) {
			const s = stage(base, o);
			const before = snapshot(s);
			const err = caught(() => s.plan());
			ok(label, isRefusal(err, re), err ? err.message : "accepted");
			ok(`${label}: nothing written`, same(snapshot(s), before));
		}
	});
	await test("§10b the week and the figures: a week start that is not its Saturday, another live weekly invoice for the driver-week, a stored totalDue that is not the total, a rate that moved, a load joining or leaving", async ({ ok }) => {
		const cases = [
			["a week start that is not a Saturday", { mutate: (x) => x.db.prepare("UPDATE invoices SET week_start = '2026-10-04' WHERE id = ?").run(x.id) }, /week/],
			["another live weekly invoice for the driver-week", {
				mutate: (x) => x.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual)
					VALUES ('INV-NB-OTHER', 'nia  brooks', ?, ?, 1, 300, 300, 'Draft', 'INV-NB-OTHER.pdf', '{}', 0)`).run(WEEK_START, WEEK_END),
			}, /2 live weekly invoices/],
			["a stored totalDue that is not the total", {
				mutate: (x) => {
					const rd = JSON.parse(x.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(x.id).render_data);
					rd.totalDue = 2000;
					x.db.prepare("UPDATE invoices SET render_data = ? WHERE id = ?").run(JSON.stringify(rd), x.id);
				},
			}, /totalDue/],
			["a rate that moved (the driver's daily rate is now $320)", { mutate: (x) => x.db.prepare("UPDATE drivers_directory SET pay_daily = 320").run() }, /rate/],
			["a load joining (L6 completed Fri 10/9, its window in the week)", { mutate: (x) => x.rows.push(loadRow({ id: "L6", driver: NIA, pickup: "2026-10-08 8:00", dropoff: "2026-10-09 12:00", assigned: "2026-10-08", done: "2026-10-09", truck: "T7" })) }, /load_ids/],
			["a load leaving (L0 soft-deleted)", { mutate: (x) => x.db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES ('L0', 'test')").run() }, /load_ids/],
		];
		for (const [label, o, re] of cases) {
			const s = stage(base, o);
			const before = snapshot(s);
			const err = caught(() => s.plan());
			ok(label, isRefusal(err, re), err ? err.message : "accepted");
			ok(`${label}: nothing written`, same(snapshot(s), before));
		}
	});
	await test("§10c the files and the race: no PDF on disk, a PDF file another invoice also names, an adjustment saved under 2 minutes ago, DRIVER_RATE_ONLY on a database the app never ran it on", async ({ ok, eq }) => {
		const missing = stage(base, { pdf: null });
		const e1 = caught(() => missing.plan());
		ok("no PDF on disk", isRefusal(e1, /PDF/), e1 && e1.message);
		const shared = stage(base, {
			mutate: (x) => x.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, pdf_file_name, render_data, is_manual, deleted_at)
				VALUES ('INV-SHARED', 'someone else', '2026-09-26', '2026-10-02', 'Paid', ?, '{}', 1, '')`).run(path.basename(x.pdfPath)),
		});
		const e2 = caught(() => shared.plan());
		ok("a shared PDF file", isRefusal(e2, /also names/), e2 && e2.message);
		const raced = stage(base, { mutate: (x) => x.db.prepare("UPDATE invoices SET adjustment = 10, adjusted_at = ? WHERE id = ?").run(new Date(RUN_AT - 60000).toISOString(), x.id) });
		const fp = (await raced.run()).plan.fingerprint;
		const before = snapshot(raced);
		const e3 = await caughtAsync(() => raced.run({ apply: true, expect: fp }));
		ok("an adjustment a minute ago", isRefusal(e3, /adjust/), e3 && e3.message);
		eq("nothing written, nothing rendered", [same(snapshot(raced), before), raced.rendered.length], [true, 0]);
		const RULE = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
		const rule = stage(base, { env: RULE });
		const settingsBefore = rule.db.prepare("SELECT * FROM app_settings ORDER BY key").all();
		const e4 = await caughtAsync(() => rule.run({ apply: true, expect: "0123456789abcdef" }));
		ok("DRIVER_RATE_ONLY on a database the app never ran it on: an apply refuses", isRefusal(e4, /never run/), e4 && e4.message);
		const e5 = await caughtAsync(() => rule.run());
		ok("…and so does a dry run on a handle that can write (it would stamp the rule's start record)", isRefusal(e5, /never run/), e5 && e5.message);
		eq("…stamping nothing", rule.db.prepare("SELECT * FROM app_settings ORDER BY key").all(), settingsBefore);
		const copy = W.saveCopy({ db: rule.db, rows: rule.rows }, RULE);
		fs.mkdirSync(path.join(copy.dir, "uploads", "invoices"), { recursive: true });
		fs.writeFileSync(path.join(copy.dir, "uploads", "invoices", path.basename(rule.pdfPath)), ORIGINAL_PDF);
		const before2 = fs.readFileSync(copy.db);
		const r = W.runScript(SCRIPT_REL, ["--invoice", rule.number, "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile]);
		eq("the command-line dry run (read-only) plans it in memory: exit 0, the rule named", [r.code, r.stdout.includes("DRIVER_RATE_ONLY from 2026-10")], [0, true]);
		ok("…and the database file is unchanged", fs.readFileSync(copy.db).equals(before2), r.stderr);
	});

	// ── §11 a failed COMMIT; the post-commit check ──────────────────────────────
	await test("§11a a COMMIT that fails after the rename (a deferred foreign key) puts the old PDF back: the row as it was, no audit row, no temporary file", async ({ ok, eq }) => {
		const s = stage(base, {
			mutate: (x) => {
				x.db.exec("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY); CREATE TABLE fk_child (pid INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED)");
				x.db.exec("CREATE TRIGGER audit_fails_at_commit AFTER INSERT ON audit_trail BEGIN INSERT INTO fk_child (pid) VALUES (999); END");
				x.db.pragma("foreign_keys = ON");
			},
		});
		const fp = (await s.run()).plan.fingerprint;
		const rowBefore = s.row();
		const err = await caughtAsync(() => s.run({ apply: true, expect: fp }));
		ok("the run fails", !!err && /FOREIGN KEY/.test(err.message) && /put back/.test(err.message), err && err.message);
		eq("the row as it was", s.row(), rowBefore);
		eq("no audit row", s.audits().length, 0);
		ok("the served PDF is the old one", fs.readFileSync(s.pdfPath).equals(ORIGINAL_PDF));
		eq("no temporary file", s.files(), [path.basename(s.pdfPath)]);
	});
	await test("§11b the post-commit check: the served PDF must be the one this run renamed, and the row must hold what it wrote", async ({ eq }) => {
		const s = stage(base);
		const fp = (await s.run()).plan.fingerprint;
		const out = await s.run({ apply: true, expect: fp });
		eq("after the run: ok", M.verifyServed({ db: s.db, id: s.id, file: s.pdfPath, sha256: out.newSha256, renderData: out.plan.nextJson }).ok, true);
		fs.writeFileSync(s.pdfPath, Buffer.from("%PDF-1.4 an adjust re-render from the old data\n"));
		const v = M.verifyServed({ db: s.db, id: s.id, file: s.pdfPath, sha256: out.newSha256, renderData: out.plan.nextJson });
		eq("another PDF in place: not ok, the served hash named", [v.ok, v.servedSha256 === out.newSha256, v.rowMatches], [false, false, true]);
	});

	R.finish();
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
