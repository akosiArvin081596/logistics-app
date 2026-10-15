#!/usr/bin/env node
/**
 * Money plan A (2026-10-15): marking a driver invoice Paid in a closed month
 * records the payment only (the user's decision 6 of 2026-10-14: "Mark Paid in
 * closed months: yes, recording the payment only. Tests must show no closed
 * month's revenue, P&L or investor figure changes."), behind
 * MARK_PAID_CLOSED_MONTH_ENABLED, off by default ("Batch 1 money decisions":
 * the flag off, and the user's word before it goes on).
 *
 * Written before the fix, which A1, A2, A3, A8, A10, A14 and A15 failed:
 * PUT /api/invoices/:id/approve refused action "paid" with 409
 * PERIOD_FINALIZED whenever any month of the invoice's week was locked
 * (invoiceMonthLockBlockers()) and wrote no audit row when it did mark an
 * invoice paid; PUT /api/invoices/:id/revert refused to clear any paid stamp
 * in a locked month.
 *
 * Flag ON:
 *   - Mark Paid on a week touching a closed month: 200, Paid, audited with the
 *     closed month named; the Data Issues queue stops calling it never payable;
 *   - revert clears a paid stamp set AFTER every closed month in the week was
 *     locked (period_locks.finalized_at), audited; and only those.
 * Flag ON, pins (passed before the fix too): A4 the payment changes no other
 * row and no ledger, investor-view or Financials figure; A6 an unreadable lock
 * table and A7 an unreadable week date still refuse; A11 a stamp set BEFORE
 * the month locked (part of the closed month's record) still can't be
 * reverted; A13 a lock with no lock time refuses the revert (fail closed).
 * Flag OFF: A9 closed-month Mark Paid refused exactly as before; A12 revert
 * refused exactly as before. A5: an open month works, with no figure moved,
 * flag on or off. A14: every Mark Paid is audited, flag on or off.
 * A15: the read-only report (scripts/mark-paid-closed-month-report.js) lists
 * what the flag would let through and fingerprints the closed months' rows
 * only: a closed-month Mark Paid leaves the fingerprint as it was, while an
 * open month's payout row may move. A16 (failed before the strict-instant
 * check): a paid stamp or lock time that is not a strict ISO instant ending in
 * Z refuses the revert. A17: a week spanning two closed months reverts only a
 * stamp set after both locks. A18: a month reopened and locked again counts
 * from its latest lock.
 *
 * The routes and the money paths run lifted from server.js
 * (scripts/lib/money-plans-world.js). Made-up data only: one driver at $300 a
 * day on investor 5's truck; September 2026 closed at 2026-10-08 04:00 UTC.
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-mark-paid-closed-month.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
function findRoot(dir) {
	while (!fs.existsSync(path.join(dir, "server.js"))) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error("server.js not found above this runner");
		dir = up;
	}
	return dir;
}
const M = require(path.join(findRoot(__dirname), "scripts", "lib", "money-plans-world.js"));
const { loadRow } = M;

const FLAG_ON = { MARK_PAID_CLOSED_MONTH_ENABLED: "true" };
const FLAG_OFF = {};
const AMY = "Amy Birch";
const NOW = Date.parse("2026-10-15T16:00:00Z");
const SEP_LOCKED_AT = "2026-10-08T04:00:00.000Z";
const ROWS = [
	loadRow({ id: "P101", driver: AMY, pickup: "2026-09-21 8:00", dropoff: "2026-09-23 18:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" }),
	loadRow({ id: "P102", driver: AMY, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
	loadRow({ id: "P103", driver: AMY, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
	loadRow({ id: "P104", driver: AMY, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T1" }),
];

function world(env, { lockedAt = SEP_LOCKED_AT } = {}) {
	const w = M.startWorld({ env, drivers: [{ name: AMY, payDaily: 300 }], rows: ROWS, now: NOW });
	M.lockMonth(w.db, "2026-09", lockedAt);
	w.db.prepare("UPDATE trucks SET insurance_monthly = 1000").run();
	w.inv = {
		// W39: Sat 9/26 - Fri 10/2, half in closed September, half in open October.
		span: M.insertInvoice(w.db, { invoice_number: "INV-AB-2026W39-01", driver: AMY, week_start: "2026-09-26", week_end: "2026-10-02", status: "Approved", total_earnings: 1200,
			render_data: JSON.stringify({ days: M.dayGrid("2026-09-26", ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"], 300) }) }),
		// W38: Sat 9/19 - Fri 9/25, all in closed September, Processing.
		closed: M.insertInvoice(w.db, { invoice_number: "INV-AB-2026W38-01", driver: AMY, week_start: "2026-09-19", week_end: "2026-09-25", status: "Processing", total_earnings: 900,
			render_data: JSON.stringify({ days: M.dayGrid("2026-09-19", ["2026-09-21", "2026-09-22", "2026-09-23"], 300) }) }),
		// W41: Sat 10/10 - Fri 10/16, all in open October.
		open: M.insertInvoice(w.db, { invoice_number: "INV-AB-2026W41-01", driver: AMY, week_start: "2026-10-10", week_end: "2026-10-16", status: "Approved", total_earnings: 600,
			render_data: JSON.stringify({ days: M.dayGrid("2026-10-10", ["2026-10-12", "2026-10-13"], 300) }) }),
	};
	return w;
}
const pay = (w, id) => M.route(w, "PUT /api/invoices/:id/approve", { params: { id: String(id) }, body: { action: "paid" } });
const revert = (w, id) => M.route(w, "PUT /api/invoices/:id/revert", { params: { id: String(id) }, body: { reason: "marked by mistake" } });
const stamp = (w, id, paidAt) => w.db.prepare("UPDATE invoices SET status = 'Paid', paid_at = ?, paid_by = 'super_admin' WHERE id = ?").run(paidAt, id);
const row = (w, id) => w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
const audits = (w, id) => w.db.prepare("SELECT action, details FROM audit_trail WHERE entity = 'invoice' AND entity_id = ? ORDER BY id").all(String(id));
const keep = (h) => Object.fromEntries(Object.entries(h).filter(([t]) => t !== "invoices" && t !== "audit_trail"));

// Every money figure a payment could reach, in every month: the payout ledger
// (computeInvestorMonthlyEarnings, investor 5's scope), the investor view (GET
// /api/investor as investor 5) and the Financials page (all months, plus the
// September and October month detail).
async function figures(w) {
	const led = await M.ledger(w);
	const inv = await M.investorDays(w);
	const fin = await M.route(w, "GET /api/financials", {});
	const sep = await M.route(w, "GET /api/financials", { query: { month: "2026-09" } });
	const oct = await M.route(w, "GET /api/financials", { query: { month: "2026-10" } });
	return JSON.stringify({ ledgerMonths: led.monthlyEarnings, ledgerItems: led.items, investor: inv.body, fin: fin.body, sep: sep.body, oct: oct.body });
}
async function dataIssues(w) {
	const r = await M.route(w, "GET /api/admin/period-lock-issues", {});
	if (r.status !== 200) throw new Error(`period-lock-issues: ${r.status}`);
	const listed = (r.body.invoices || []).find((x) => x.id === w.inv.span) || null;
	return { neverPayable: listed && listed.neverPayable, count: r.body.invoiceSummary && r.body.invoiceSummary.neverPayable };
}

const R = M.createRunner("Money plan A: Mark Paid in a closed month records the payment only (MARK_PAID_CLOSED_MONTH_ENABLED)");

(async () => {
	await R.test("A1 Flag on: Mark Paid on a week spanning closed September and open October: 200, Paid, paid_at = now, paid_by = the admin. Base: 409 PERIOD_FINALIZED", async ({ eq }) => {
		const w = world(FLAG_ON);
		const r = await pay(w, w.inv.span);
		eq("status code", r.status, 200);
		eq("response success and status", r.body && [r.body.success, r.body.status], [true, "Paid"]);
		const after = row(w, w.inv.span);
		eq("row", [after.status, after.paid_at, after.paid_by], ["Paid", new Date(NOW).toISOString(), "super_admin"]);
	});

	await R.test("A2 Flag on: Mark Paid on a week wholly inside closed September (from Processing): 200 and Paid. Base: 409", async ({ eq }) => {
		const w = world(FLAG_ON);
		const r = await pay(w, w.inv.closed);
		eq("status code", r.status, 200);
		eq("row status", row(w, w.inv.closed).status, "Paid");
	});

	await R.test("A3 Flag on: the payment is audited: one pay_invoice row naming the closed month (September 2026), no pay_invoice_blocked row. Base: only a refusal row", async ({ eq, ok }) => {
		const w = world(FLAG_ON);
		await pay(w, w.inv.span);
		const rows = audits(w, w.inv.span);
		eq("actions", rows.map((x) => x.action), ["pay_invoice"]);
		ok("the row names the closed month", rows.length === 1 && /September 2026/.test(rows[0].details), JSON.stringify(rows));
	});

	await R.test("A4 Flag on: recording the payment changes nothing else: no other table, no other invoice column, and no ledger, investor-view or Financials figure in any month (passes on main only because the payment is refused)", async ({ eq }) => {
		const w = world(FLAG_ON);
		const beforeTables = keep(M.tableHashes(w.db));
		const strip = (r) => { const { status: _s, paid_at: _a, paid_by: _b, ...rest } = r; return rest; };
		const beforeRows = [w.inv.span, w.inv.closed].map((id) => strip(row(w, id)));
		const beforeFigures = await figures(w);
		await pay(w, w.inv.span);
		await pay(w, w.inv.closed);
		eq("other tables", keep(M.tableHashes(w.db)), beforeTables);
		eq("other invoice columns", [w.inv.span, w.inv.closed].map((id) => strip(row(w, id))), beforeRows);
		eq("every figure", await figures(w), beforeFigures);
	});

	await R.test("A5 Flag off and on: an invoice in an open month is marked Paid as today, and that payment moves no figure (the A4 comparison, run on a payment main makes)", async ({ eq }) => {
		for (const env of [FLAG_OFF, FLAG_ON]) {
			const w = world(env);
			const beforeTables = keep(M.tableHashes(w.db));
			const beforeFigures = await figures(w);
			const r = await pay(w, w.inv.open);
			const label = env === FLAG_ON ? "flag on" : "flag off";
			eq(`${label}: status code`, r.status, 200);
			eq(`${label}: row status`, row(w, w.inv.open).status, "Paid");
			eq(`${label}: other tables`, keep(M.tableHashes(w.db)), beforeTables);
			eq(`${label}: every figure`, await figures(w), beforeFigures);
		}
	});

	await R.test("A6 Flag on: an unreadable lock table still refuses (409 PERIOD_LOCK_UNREADABLE) and writes nothing", async ({ eq }) => {
		const w = world(FLAG_ON);
		w.db.exec("DROP TABLE period_locks; CREATE TABLE period_locks (period TEXT PRIMARY KEY)");
		const r = await pay(w, w.inv.span);
		eq("refusal", [r.status, r.body && r.body.code], [409, "PERIOD_LOCK_UNREADABLE"]);
		eq("row unchanged", [row(w, w.inv.span).status, row(w, w.inv.span).paid_at], ["Approved", ""]);
	});

	await R.test("A7 Flag on: a week date the server cannot read still refuses (409, PERIOD_UNRESOLVED audit) and writes nothing", async ({ eq }) => {
		const w = world(FLAG_ON);
		const id = M.insertInvoice(w.db, { invoice_number: "INV-AB-BAD-01", driver: AMY, week_start: "", week_end: "2026-10-02", status: "Approved" });
		const r = await pay(w, id);
		eq("status code", r.status, 409);
		eq("row unchanged", [row(w, id).status, row(w, id).paid_at], ["Approved", ""]);
	});

	await R.test("A8 Flag on: the Data Issues queue no longer calls a closed-month Approved invoice never payable. Base: neverPayable", async ({ eq }) => {
		eq("W39 invoice and summary count", await dataIssues(world(FLAG_ON)), { neverPayable: false, count: 0 });
	});

	await R.test("A9 Flag off: closed-month Mark Paid is refused exactly as today (409 PERIOD_FINALIZED, nothing written, still never payable)", async ({ eq }) => {
		const w = world(FLAG_OFF);
		const r = await pay(w, w.inv.span);
		eq("refusal", [r.status, r.body && r.body.code], [409, "PERIOD_FINALIZED"]);
		eq("row unchanged", [row(w, w.inv.span).status, row(w, w.inv.span).paid_at], ["Approved", ""]);
		eq("Data Issues", await dataIssues(w), { neverPayable: true, count: 2 });
	});

	await R.test("A10 Flag on: revert clears a paid stamp set AFTER September locked (stamp 10/14, lock 10/8): 200, Submitted, paid_at cleared, audited. Base: 409", async ({ eq, ok }) => {
		const w = world(FLAG_ON);
		stamp(w, w.inv.span, "2026-10-14T15:00:00.000Z");
		const r = await revert(w, w.inv.span);
		eq("status code", r.status, 200);
		eq("row", [row(w, w.inv.span).status, row(w, w.inv.span).paid_at], ["Submitted", ""]);
		const rows = audits(w, w.inv.span).filter((x) => x.action === "revert_invoice");
		ok("the revert is audited, naming the closed month and the stamp", rows.length === 1 && /September 2026/.test(rows[0].details) && rows[0].details.includes("2026-10-14T15:00:00.000Z"), JSON.stringify(rows));
	});

	await R.test("A11 Flag on: a paid stamp set BEFORE September locked (stamp 10/5, lock 10/8) is part of the closed month's record: revert still refused (409 PERIOD_FINALIZED)", async ({ eq }) => {
		const w = world(FLAG_ON);
		stamp(w, w.inv.span, "2026-10-05T15:00:00.000Z");
		const r = await revert(w, w.inv.span);
		eq("refusal", [r.status, r.body && r.body.code], [409, "PERIOD_FINALIZED"]);
		eq("row unchanged", [row(w, w.inv.span).status, row(w, w.inv.span).paid_at], ["Paid", "2026-10-05T15:00:00.000Z"]);
	});

	await R.test("A12 Flag off: revert of a stamp set after the lock is refused exactly as today", async ({ eq }) => {
		const w = world(FLAG_OFF);
		stamp(w, w.inv.span, "2026-10-14T15:00:00.000Z");
		const r = await revert(w, w.inv.span);
		eq("refusal", [r.status, r.body && r.body.code], [409, "PERIOD_FINALIZED"]);
		eq("row unchanged", row(w, w.inv.span).status, "Paid");
	});

	await R.test("A13 Flag on: a closed month with no lock time recorded refuses the revert (fail closed)", async ({ eq }) => {
		const w = world(FLAG_ON, { lockedAt: "" });
		stamp(w, w.inv.span, "2026-10-14T15:00:00.000Z");
		const r = await revert(w, w.inv.span);
		eq("status code", r.status, 409);
		eq("row unchanged", row(w, w.inv.span).status, "Paid");
	});

	await R.test("A14 Every Mark Paid is audited, flag off too: an open-month payment writes one pay_invoice row. Base: none", async ({ eq }) => {
		const w = world(FLAG_OFF);
		await pay(w, w.inv.open);
		eq("actions", audits(w, w.inv.open).map((x) => x.action), ["pay_invoice"]);
	});

	await R.test("A15 The read-only report on a copy: W38 and W39 can be marked Paid with the flag on; after W39 is marked, it shows as revertible, and the closed months' fingerprint is unchanged although October's payout row moved; the copy is never written", async ({ eq, ok }) => {
		const w = world(FLAG_ON);
		const payout = w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, ?, ?, ?, 'owed')");
		payout.run("2026-09", 1234.5, "2026-10-30");
		payout.run("2026-10", 500, "2026-11-27");
		const report = () => {
			const copy = M.saveCopy(w, FLAG_ON);
			const before = M.fileHash(copy.db);
			const r = M.runScript("scripts/mark-paid-closed-month-report.js", ["--db", copy.db, "--env-file", copy.envFile, "--json"]);
			if (M.fileHash(copy.db) !== before) throw new Error("the report wrote to the database copy");
			if (!r.json) throw new Error(`the report did not run: ${(r.stderr || r.stdout).slice(0, 300)}`);
			return r.json;
		};
		const first = report();
		eq("flag as the app reads it", first.flag, "on");
		eq("unpaid invoices and next step", first.unpaid.map((x) => [x.invoice, x.status, x.totalDue, x.closedMonths]),
			[["INV-AB-2026W38-01", "Processing", 900, ["2026-09"]], ["INV-AB-2026W39-01", "Approved", 1200, ["2026-09"]]]);
		await pay(w, w.inv.span);
		w.db.prepare("UPDATE investor_payouts SET amount = 650 WHERE period = '2026-10'").run();
		const second = report();
		eq("W39 now paid and revertible", second.paid.map((x) => [x.invoice, x.revert.startsWith("allowed")]), [["INV-AB-2026W39-01", true]]);
		eq("closed months' fingerprint", second.closedMonthFingerprint, first.closedMonthFingerprint);
		ok("the fingerprint covers the September payout row", first.closedMonthFingerprint.investor_payouts.rows === 1, JSON.stringify(first.closedMonthFingerprint));
	});

	await R.test("A16 Flag on: a paid stamp or lock time that is not a strict ISO instant ending in Z refuses the revert, even when it reads as after the lock. Base: a loose stamp was accepted", async ({ eq }) => {
		const loose = [
			["stamp without a zone", "2026-10-14 15:00:00", SEP_LOCKED_AT],
			["stamp in words", "Oct 14 2026 15:00 UTC", SEP_LOCKED_AT],
			["stamp with an offset", "2026-10-14T15:00:00+00:00", SEP_LOCKED_AT],
			["stamp on a day that does not exist", "2026-09-31T15:00:00.000Z", "2026-09-08T04:00:00.000Z"],
			["lock time without a zone", "2026-10-14T15:00:00.000Z", "2026-10-08 04:00:00"],
		];
		for (const [label, paidAt, lockedAt] of loose) {
			const w = world(FLAG_ON, { lockedAt });
			stamp(w, w.inv.span, paidAt);
			const r = await revert(w, w.inv.span);
			eq(`${label}: refused, row unchanged`, [r.status, row(w, w.inv.span).status], [409, "Paid"]);
		}
	});

	await R.test("A17 Flag on: a week spanning two closed months (Aug locked 9/8, Sep locked 10/8): a stamp set between the two locks refuses the revert; one set after both is cleared", async ({ eq }) => {
		const run = async (paidAt) => {
			const w = world(FLAG_ON);
			M.lockMonth(w.db, "2026-08", "2026-09-08T04:00:00.000Z");
			const id = M.insertInvoice(w.db, { invoice_number: "INV-AB-2026W35-01", driver: AMY, week_start: "2026-08-29", week_end: "2026-09-04", status: "Approved", total_earnings: 600 });
			stamp(w, id, paidAt);
			const r = await revert(w, id);
			return [r.status, row(w, id).status];
		};
		eq("stamp 9/20 (after August's lock, before September's): refused", await run("2026-09-20T15:00:00.000Z"), [409, "Paid"]);
		eq("stamp 10/14 (after both locks): cleared", await run("2026-10-14T15:00:00.000Z"), [200, "Submitted"]);
	});

	await R.test("A18 Flag on: a month reopened and locked again counts from its latest lock: a stamp set between the first lock (10/8) and the re-lock (10/12) refuses the revert; one set after the re-lock is cleared", async ({ eq }) => {
		const run = async (paidAt) => {
			const w = world(FLAG_ON);
			w.db.prepare("UPDATE period_locks SET status = 'reopened', reopened_at = '2026-10-09T15:00:00.000Z', reopened_by = 'test', reopen_reason = 'test' WHERE period = '2026-09'").run();
			// The close's own write (finalizePeriods() takeLock): the re-lock replaces the lock time.
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-12T04:00:00.000Z', 'test') ON CONFLICT(period) DO UPDATE SET status = 'locked', finalized_at = excluded.finalized_at, finalized_by = excluded.finalized_by").run();
			stamp(w, w.inv.span, paidAt);
			const r = await revert(w, w.inv.span);
			return [r.status, row(w, w.inv.span).status];
		};
		eq("stamp 10/10 (while reopened, before the re-lock): refused", await run("2026-10-10T15:00:00.000Z"), [409, "Paid"]);
		eq("stamp 10/14 (after the re-lock): cleared", await run("2026-10-14T15:00:00.000Z"), [200, "Submitted"]);
	});

	R.finish();
})();
