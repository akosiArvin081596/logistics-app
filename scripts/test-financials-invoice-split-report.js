#!/usr/bin/env node
/**
 * scripts/financials-invoice-split-report.js, money plan C's read-only "what
 * would change" report for the Financials driver table's invoice columns.
 *
 *   P1  per month and driver, before and after: a W39 invoice ($1,200 plus a
 *       $100 adjustment) counted $1,300 in September and in October before;
 *       after, $600 in September and $700 in October; a week inside October is
 *       the same before and after and is not listed as changed
 *   P2  the report's "after" figures are what GET /api/financials?month= shows
 *   P3  a closed month is marked "display only"; the shares add up and the
 *       months together count every invoice once
 *   P4  read-only: the database file is byte-identical after the run; drivers
 *       are shown by initials unless --names
 *   P5  refusals: no --db, no sheet, a database outside the app directory and
 *       the temp directory (exit 2)
 *
 * The world is scripts/lib/money-plans-world.js (server.js lifted onto one
 * in-memory SQLite and sheet); the script runs on a copy of its database under
 * the temp directory with the sheet as a saved values.get. Made-up data only.
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-financials-invoice-split-report.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const path = require("path");
const M = require("./lib/money-plans-world");
const { loadRow } = M;

const AMY = "Amy Birch";
const NOW = Date.parse("2026-10-20T16:00:00Z");
const SCRIPT = "scripts/financials-invoice-split-report.js";

async function fixture() {
	const w = M.startWorld({
		drivers: [{ name: AMY, payDaily: 300 }], now: NOW,
		rows: [
			loadRow({ id: "P101", driver: AMY, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "P102", driver: AMY, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
			loadRow({ id: "P103", driver: AMY, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T1" }),
		],
	});
	const w39 = await M.generate(w, AMY, "2026-10-02");
	w.db.prepare("UPDATE invoices SET adjustment = 100 WHERE id = ?").run(w39.invoice.id);
	await M.generate(w, AMY, "2026-10-16");
	await M.freezeAndLock(w, "2026-09", "2026-10-15T04:00:00.000Z");
	return { w, w39 };
}
let shared = null;
async function outputs() {
	if (shared) return shared;
	const f = await fixture();
	const copy = M.saveCopy(f.w, {});
	const before = M.fileHash(copy.db);
	const run = M.runScript(SCRIPT, [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--json"]);
	const named = M.runScript(SCRIPT, [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--json", "--names"]);
	shared = { f, copy, run, named, fileSame: M.fileHash(copy.db) === before };
	return shared;
}
const monthOf = (json, mk) => (json && json.months || []).find((m) => m.month === mk) || null;

const R = M.createRunner("Money plan C: the Financials invoice split report (read-only)");

(async () => {
	await R.test("P1 Per month and driver, before vs after; the W39 invoice listed with its split, the week inside October not", async ({ eq, ok }) => {
		const { run } = await outputs();
		ok("exits 0 with JSON", run.code === 0 && !!run.json, (run.stderr || run.stdout).slice(0, 300));
		const sep = monthOf(run.json, "2026-09");
		const oct = monthOf(run.json, "2026-10");
		eq("September's driver row", sep && sep.drivers.map((d) => [d.driver, d.pay, d.old.invoiced, d.new.invoiced, d.old.variance, d.new.variance, d.old.invoiceCount, d.new.invoiceCount]),
			[["AB", 600, 1300, 600, 700, 0, 1, 1]]);
		eq("October's driver row [pay, invoiced, adjustments, variance, count] before and after", oct && oct.drivers.map((d) => [d.pay, d.old.invoiced, d.new.invoiced, d.old.adjustments, d.new.adjustments, d.old.variance, d.new.variance, d.old.invoiceCount, d.new.invoiceCount]),
			[[1200, 1900, 1300, 100, 100, 700, 100, 2, 2]]);
		eq("September's adjustments move to October", sep && [sep.drivers[0].old.adjustments, sep.drivers[0].new.adjustments], [100, 0]);
		const listed = (run.json && run.json.invoices) || [];
		eq("only the W39 invoice is listed", listed.map((i) => [i.weekStart, i.weekEnd, i.method, i.old, i.new]),
			[["2026-09-26", "2026-10-02", "days", { "2026-09": 1300, "2026-10": 1300 }, { "2026-09": 600, "2026-10": 700 }]]);
		eq("its parts: the days by month, the adjustment once in October", listed[0] && [listed[0].parts["2026-09"].days, listed[0].parts["2026-10"].days, listed[0].parts["2026-10"].unsplit, listed[0].unsplit.month],
			[["2026-09-28", "2026-09-29"], ["2026-10-01", "2026-10-02"], { adjustment: 100 }, "2026-10"]);
	});

	await R.test("P2 The report's after figures are the page's (GET /api/financials?month=)", async ({ eq }) => {
		const { f, run } = await outputs();
		for (const mk of ["2026-09", "2026-10"]) {
			const page = await M.route(f.w, "GET /api/financials", { query: { month: mk } });
			const row = (page.body.monthDetail.drivers || []).find((d) => d.name === AMY);
			const rep = monthOf(run.json, mk).drivers[0];
			eq(`${mk} [invoiced, adjustments, variance, count, split]`, [rep.new.invoiced, rep.new.adjustments, rep.new.variance, rep.new.invoiceCount, rep.new.splitInvoices],
				[row.invoicedTotal, row.adjustments, row.variance, row.invoiceCount, row.splitInvoices]);
		}
	});

	await R.test("P3 A closed month is marked display only; every invoice adds up and is counted once across the months", async ({ eq, ok }) => {
		const { run } = await outputs();
		const sep = monthOf(run.json, "2026-09");
		eq("September closed and frozen, October open", [sep && sep.closed, sep && sep.frozen, monthOf(run.json, "2026-10").closed], [true, true, false]);
		ok("September's note says display only", sep && /display only/.test(sep.note), sep && sep.note);
		eq("checks", run.json && [run.json.countedOnce, run.json.invoiced, run.json.problems], [true, 1300 + 600, []]);
		eq("the W39 invoice names its closed month", run.json && run.json.invoices[0].closedMonths, ["2026-09"]);
	});

	await R.test("P4 Read-only: the database file is unchanged; initials by default, names with --names", async ({ eq, ok }) => {
		const { run, named, fileSame } = await outputs();
		ok("the database file is byte-identical after both runs", fileSame);
		eq("readOnly flag", run.json && run.json.readOnly, true);
		ok("no name in the default output", !run.stdout.toLowerCase().includes("birch"));
		eq("--names", named.json && named.json.months[0].drivers[0].driver, "amy birch");
	});

	await R.test("P5 Refusals exit 2: no --db, no sheet, a database outside the app directory and the temp directory", async ({ eq }) => {
		const { copy } = await outputs();
		const noDb = M.runScript(SCRIPT, [`--values-json=${copy.values}`]);
		const noSheet = M.runScript(SCRIPT, [`--db=${copy.db}`]);
		// Beside the app directory, neither in it nor under the temp directory (no
		// file is created: the copy rule refuses the place before anything opens).
		const outside = M.runScript(SCRIPT, [`--db=${path.join(path.dirname(M.ROOT), "plan-c-no-such-app.db")}`, `--values-json=${copy.values}`]);
		eq("exit codes", [noDb.code, noSheet.code, outside.code], [2, 2, 2]);
		eq("each says REFUSED", [noDb, noSheet, outside].map((r) => /^REFUSED:/.test(r.stderr)), [true, true, true]);
		eq("the place is what is refused", /a script opens its own app directory's database/.test(outside.stderr), true);
	});

	R.finish();
})();
