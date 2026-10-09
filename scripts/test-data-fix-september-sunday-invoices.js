#!/usr/bin/env node
/**
 * scripts/data-fix-september-sunday-invoices.js: its decisions, its September
 * comparison, its command line and its lift of server.js.
 *
 *   §1 invoiceCorrection(): a billed Sunday comes off the stored snapshot (the
 *      day line cleared, Total Due, the day count and the total less one daily
 *      rate; nothing else in the snapshot moves); an invoice already corrected
 *      by this script is "done"; every uncertain invoice is skipped with why: a
 *      paid, processing, rejected, deleted, manual or adjusted invoice, a day
 *      outside the week or not a Sunday, a line naming another load, a day line
 *      that is not billed, totals that disagree, a percentage-pay snapshot;
 *   §2 compareSeptember(): the correction alone passes and reports the
 *      investor's payout, the items removed and the Financials figures; each of
 *      these fails, named: another invoice changed, a corrected invoice changed
 *      beyond its day line and total, another frozen item gone, another
 *      owner's payout moved, the investor's driver pay moved by a different
 *      amount, a status changed, the month not finalized again, a receipt
 *      changed, an override the run did not add;
 *   §3 the command line refuses (exit 2, nothing opened for writing): an unknown
 *      option, neither or both of --dry-run and --apply, no --db, a database
 *      outside the app directory and the temp directory, --data-dir with the
 *      app's own database; and with no sheet it stops before any database work;
 *   §4 the lift: every root and both route handlers resolve in this checkout's
 *      server.js, reach none of the denied names (the HTTP server, the Sheets
 *      writer, the mailer, the sheet ID), and the lifted code compiles.
 *
 * The run on a copy of production's database (reopen, overrides, invoices,
 * close, comparison, PDFs) is the script's own --dry-run; the rehearsal on the
 * local copy is in the PR.
 *
 * Pure: a temp directory, child processes of the script itself, no server, no
 * network. Run: node scripts/test-data-fix-september-sunday-invoices.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-september-sunday-invoices.js");
const fix = require(SCRIPT);
const { closure } = require("./lib/server-lift");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// ── §1 invoiceCorrection ──────────────────────────────────────────────────────
const W37 = fix.CORRECTION.invoices[0];
function days(spec) {
	const out = {};
	for (const d of ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
		out[d] = spec[d] ? { loadBol: spec[d], total: 300, completed: true } : { loadBol: "", total: 0, completed: false };
	}
	return out;
}
const SIX = days({ Sunday: "567844619", Monday: "567844619", Tuesday: "567844619", Wednesday: "568073441, 567850506", Thursday: "568073441, 567850506", Friday: "567850506" });
function invoice(over = {}, renderOver = {}) {
	const render = { driverName: "Test Driver", invoiceNumberSuffix: "SK-2026W37-01", submissionDate: "Sep 19, 2026", totalDue: 1800, adjustment: 0, adjustmentNote: "", days: SIX, __templateName: "service_invoice", ...renderOver };
	return {
		id: 537, invoice_number: W37.invoiceNumber, driver: "test driver", week_start: "2026-09-12", week_end: "2026-09-18", loads_count: 6, rate_per_load: 300,
		total_earnings: 1800, expenses_total: 1761.44, status: "Submitted", paid_at: "", deleted_at: "", is_manual: 0, adjustment: 0, render_data: JSON.stringify(render), ...over,
	};
}
{
	const r = fix.invoiceCorrection(invoice(), W37);
	check("§1 a billed Sunday is corrected", r.state === "correct", r.why);
	const after = JSON.parse(r.renderData);
	check("§1 the Sunday line is cleared", after.days.Sunday.completed === false && after.days.Sunday.total === 0 && after.days.Sunday.loadBol === "");
	check("§1 Total Due, days and total drop by one daily rate", after.totalDue === 1500 && r.after.total === 1500 && r.after.loadsCount === 5);
	const before = JSON.parse(invoice().render_data);
	const strip = (x) => { const c = { ...x, days: { ...x.days } }; delete c.days.Sunday; delete c.totalDue; return JSON.stringify(c); };
	check("§1 nothing else in the snapshot moves", strip(after) === strip(before));
	check("§1 the remaining days are listed", r.after.days.join(",") === "Monday,Tuesday,Wednesday,Thursday,Friday");

	const corrected = invoice({ loads_count: 5, total_earnings: 1500, render_data: r.renderData });
	check("§1 already corrected by this script is done", fix.invoiceCorrection(corrected, W37, { applied: true }).state === "done");
	const notOurs = fix.invoiceCorrection(corrected, W37, { applied: false });
	check("§1 a Sunday that is off the invoice without this script's record is skipped", notOurs.state === "skip" && /did not take it off/.test(notOurs.why), notOurs.why);

	const skips = [
		["paid", invoice({ status: "Paid", paid_at: "2026-10-09T00:00:00Z" }), /paid/],
		["paid stamp on an approved invoice", invoice({ status: "Approved", paid_at: "2026-10-09T00:00:00Z" }), /paid/],
		["processing", invoice({ status: "Processing" }), /Processing/],
		["rejected", invoice({ status: "Rejected" }), /Rejected/],
		["deleted", invoice({ deleted_at: "2026-10-01" }), /deleted/],
		["manual", invoice({ is_manual: 1 }), /manual/],
		["adjusted", invoice({ adjustment: -300 }), /adjustment/],
		["a day outside the week", invoice({ week_start: "2026-09-19", week_end: "2026-09-25" }), /not in/],
		["a line naming another load", invoice({}, { days: days({ Sunday: "111", Monday: "567844619", Tuesday: "567844619", Wednesday: "1", Thursday: "1", Friday: "1" }) }), /not 567844619/],
		["totals that disagree", invoice({ total_earnings: 2100 }), /do not agree/],
		["a Total Due that disagrees", invoice({}, { totalDue: 1700 }), /do not agree/],
		["a percentage-pay snapshot", invoice({}, { __templateName: "service_invoice_owner_op" }), /no day-rate/],
		["no snapshot", invoice({ render_data: "{}" }), /no day-rate/],
		["missing", null, /not found/],
	];
	for (const [name, row, re] of skips) {
		const s = fix.invoiceCorrection(row, W37);
		check(`§1 ${name} is skipped`, s.state === "skip" && re.test(s.why), s.why);
	}
	const monday = fix.invoiceCorrection(invoice(), { ...W37, day: "2026-09-14" });
	check("§1 a day that is not a Sunday is skipped", monday.state === "skip" && /not a Sunday/.test(monday.why), monday.why);
	check("§1 weekdayOf reads the calendar day", fix.weekdayOf("2026-09-13") === "Sunday" && fix.weekdayOf("2026-09-27") === "Sunday" && fix.weekdayOf("2026-09-28") === "Monday");
}

// ── §2 compareSeptember ───────────────────────────────────────────────────────
function item(o) {
	return JSON.stringify({ owner_id: 5, kind: "driver_pay", adjusts: "", day: "", cents: 30000, load_id: "", driver: "test driver", truck: "T-1", expense_id: null, source_id: null, expense_type: "", pay_type: "fixed", pickup_state: "", delivery_state: "", ...o });
}
function breakdown(driverPay, netProfit, share) {
	return JSON.stringify({ revenue: 1000, driverPay, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit, splitPct: 50, monthShare: share, lossCarriedIn: 0, lossDeferred: 0 });
}
function state(over = {}) {
	const inv = JSON.parse(JSON.stringify(invoice()));
	const base = {
		lock: { period: "2026-09", status: "locked", finalized_at: "2026-10-08T05:00:25Z", finalized_by: "system", reopened_at: "", reopened_by: "", reopen_reason: "" },
		payouts: [
			{ id: 27, owner_id: 5, amount: 400, due_date: "2026-10-30", status: "owed", processed_at: null, paid_at: null, notes: "", adjustment: 0, adjustment_note: "", reopened_at: "", reopen_reason: "", finalized_at: "2026-10-08T05:00:25Z", finalized_amount: 400, finalized_breakdown: breakdown(600, 250, 125), statement_pdf_file_name: "" },
			{ id: 28, owner_id: 41, amount: 0, due_date: "2026-10-30", status: "owed", processed_at: null, paid_at: null, notes: "", adjustment: 0, adjustment_note: "", reopened_at: "", reopen_reason: "", finalized_at: "2026-10-08T05:00:25Z", finalized_amount: 0, finalized_breakdown: breakdown(0, 0, 0), statement_pdf_file_name: "" },
		],
		items: [item({ day: "2026-09-13", load_id: "L1" }), item({ day: "2026-09-14", load_id: "L1" }), item({ kind: "revenue", cents: 100000, load_id: "L1" })].sort(),
		freezes: [{ source: "close", frozen_by: "system", item_count: 3, summary: JSON.stringify({ revenue: 1000, driverPay: 600, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 250 }), settings: "{}" }],
		invoices: [inv, { ...inv, id: 540, invoice_number: "INV-HR-2026W37-01", driver: "other driver" }],
		excluded: [],
		unchanged: { receipts: "a", maintenanceFund: "b", complianceFees: "c", otherMonthsPayouts: "d", otherMonthsItems: "e", otherMonthsFreezes: "f", otherMonthsLocks: "g", otherInvoices: "h", otherOverrides: "i", trucksAndPay: "j" },
	};
	return { ...base, ...over };
}
const REMOVED = [item({ day: "2026-09-13", load_id: "L1" })];
const OVERRIDES = [{ driver_name: "test driver", excluded_date: "2026-09-13", action: "remove" }];
const REASON = fix.CORRECTION.reason;
function goodAfter() {
	const b = state();
	const r = fix.invoiceCorrection(b.invoices[0], W37);
	return state({
		lock: { ...b.lock, finalized_at: "2026-10-09T05:00:00Z", finalized_by: fix.ACTOR, reopened_at: "2026-10-09T04:59:59Z", reopened_by: fix.ACTOR, reopen_reason: REASON },
		payouts: [
			{ ...b.payouts[0], amount: 550, finalized_amount: 550, finalized_at: "2026-10-09T05:00:00Z", finalized_breakdown: breakdown(300, 550, 275) },
			{ ...b.payouts[1], finalized_at: "2026-10-09T05:00:00Z" },
		],
		items: b.items.filter((x) => x !== REMOVED[0]),
		freezes: [{ ...b.freezes[0], frozen_by: fix.ACTOR, item_count: 2, summary: JSON.stringify({ revenue: 1000, driverPay: 300, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 550 }) }],
		invoices: [{ ...b.invoices[0], loads_count: 5, total_earnings: 1500, render_data: r.renderData }, b.invoices[1]],
		excluded: OVERRIDES.map((o) => ({ ...o, reason: "x", excluded_by: fix.ACTOR })),
	});
}
const OPTS = { corrected: [{ id: 537, weekday: "Sunday" }], removed: REMOVED, ownerId: 5, overrides: OVERRIDES, reason: REASON };
{
	const ok = fix.compareSeptember(state(), goodAfter(), OPTS);
	check("§2 the correction alone passes", ok.ok, ok.problems.join("; "));
	const pay = ok.changes.find((c) => c.what === "payout");
	check("§2 the investor's payout is reported", pay && pay.before.amount === 400 && pay.after.amount === 550);
	check("§2 the removed items are reported", ok.changes.find((c) => c.what === "items").removed.length === 1);

	const variants = [
		["another invoice changed", (a) => { a.invoices[1] = { ...a.invoices[1], total_earnings: 1 }; }, /INV-HR-2026W37-01 changed/],
		["a corrected invoice changed beyond its day and total", (a) => { a.invoices[0] = { ...a.invoices[0], expenses_total: 1 }; }, /expenses_total changed/],
		["a corrected invoice's snapshot changed elsewhere", (a) => { const r = JSON.parse(a.invoices[0].render_data); r.submissionDate = "Oct 9, 2026"; a.invoices[0] = { ...a.invoices[0], render_data: JSON.stringify(r) }; }, /snapshot changed/],
		["another frozen item gone", (a) => { a.items = a.items.slice(1); }, /frozen items differ/],
		["another owner's payout moved", (a) => { a.payouts[1] = { ...a.payouts[1], amount: 5, finalized_amount: 5 }; }, /owner 41's September payout changed/],
		["the investor's driver pay moved by a different amount", (a) => { a.payouts[0] = { ...a.payouts[0], finalized_breakdown: breakdown(0, 850, 425) }; }, /driverPay is/],
		["a payout status changed", (a) => { a.payouts[0] = { ...a.payouts[0], status: "paid" }; }, /status changed/],
		["the month not finalized again", (a) => { a.lock = { ...a.lock, status: "reopened" }; }, /not finalized/],
		["a receipt changed", (a) => { a.unchanged = { ...a.unchanged, receipts: "z" }; }, /receipts changed/],
		["an override the run did not add", (a) => { a.excluded = [...a.excluded, { driver_name: "x", excluded_date: "2026-09-20", action: "remove" }]; }, /overrides are not/],
		["Financials moved beyond the day", (a) => { a.freezes = [{ ...a.freezes[0], summary: JSON.stringify({ revenue: 999, driverPay: 300, fixedCosts: 100, tripExpenses: 50, maintFundCost: 0, complianceCost: 0, netProfit: 549 }) }]; }, /Financials revenue/],
	];
	for (const [name, mutate, re] of variants) {
		const a = goodAfter();
		mutate(a);
		const r = fix.compareSeptember(state(), a, OPTS);
		check(`§2 fails: ${name}`, !r.ok && r.problems.some((p) => re.test(p)), r.problems.join("; ") || "passed");
	}
	check("§2 the driver's pay sums its driver-pay items", fix.driverPayIn(state().items, "test driver") === 600 && fix.driverPayIn(goodAfter().items, "test driver") === 300);
}

// ── §3 the command line ───────────────────────────────────────────────────────
{
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ssi-test-"));
	const db = path.join(tmp, "app.db");
	fs.writeFileSync(db, "");
	const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "" } });
	const refusals = [
		["an unknown option", ["--db", db, "--dry-run", "--force"], /unknown option/],
		["neither --dry-run nor --apply", ["--db", db], /--dry-run or --apply/],
		["both --dry-run and --apply", ["--db", db, "--dry-run", "--apply"], /--dry-run or --apply/],
		["no --db", ["--dry-run"], /--db is required/],
		["a database outside the app directory and the temp directory", ["--db", path.join(ROOT, "scripts", "app.db"), "--dry-run"], /opens its own app directory's database/],
		["--data-dir with the app's own database", ["--db", path.join(ROOT, "app.db"), "--dry-run", "--data-dir", tmp], /--data-dir/],
	];
	for (const [name, args, re] of refusals) {
		const r = run(args);
		check(`§3 refuses ${name}`, r.status === 2 && re.test(r.stderr), `exit ${r.status}: ${r.stderr.trim().slice(0, 300)}`);
	}
	const noSheet = run(["--db", db, "--dry-run"]);
	check("§3 no sheet stops before any database work", noSheet.status === 1 && /--sheet-id \(or --values-json\) is required/.test(noSheet.stderr) && fs.statSync(db).size === 0, `exit ${noSheet.status}: ${noSheet.stderr.trim().slice(0, 300)}`);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── §4 the lift ───────────────────────────────────────────────────────────────
{
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	let lifted = null;
	try {
		lifted = closure(SRC, { roots: fix.ROOTS, routes: [fix.REOPEN_HEAD, fix.EXCLUDE_HEAD], provided: fix.PROVIDED, denied: fix.DENIED });
	} catch (err) {
		check("§4 the lift resolves", false, err.message.slice(0, 500));
	}
	if (lifted) {
		for (const n of [...fix.ROOTS, "reconcileInvestorPayouts", "writeLedgerFreeze", "closingFingerprint", "excludedDayGate", "writeInvoiceFileAtomically"]) {
			check(`§4 lifts ${n}`, lifted.names.includes(n));
		}
		check("§4 reaches no denied name", fix.DENIED.every((n) => !lifted.names.includes(n)));
		check("§4 the two route handlers are lifted", lifted.text.includes(fix.REOPEN_HEAD) && lifted.text.includes(fix.EXCLUDE_HEAD));
		let compiles = true;
		try { new Function(...fix.PROVIDED.filter((n) => n !== "getJobTrackingCached" && n !== "jtCacheInvalidate"), "__sheetData", `${lifted.text}\nfunction getJobTrackingCached() {}\nfunction jtCacheInvalidate() {}`); } catch (err) { compiles = err.message; }
		check("§4 the lifted code compiles", compiles === true, compiles);
	}
}

console.log(`test-data-fix-september-sunday-invoices: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
