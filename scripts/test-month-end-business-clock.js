#!/usr/bin/env node
/**
 * Money plan B (2026-10-15): on a month's last evening the payout ledger's and
 * the investor view's month loops, and the all-time fixed-cost month count,
 * read the server's own clock (UTC on the VPS) while "the current month" is
 * the business month (APP_TIMEZONE, US Eastern).
 *
 * Written before the fix (server.js appMonthStart(): the first of the business
 * month), which B1-B6 and B8 failed. From 8 PM EDT (7 PM EST) on the last day
 * of a month until midnight Eastern, `now.getMonth()` on the UTC server was
 * already the next month, so:
 *   - gatherLedgerScopeFacts() passes endDate = the first of NEXT month, and
 *     computeLedgerScope() (lib/financials-calc.js) adds a next-month row: the
 *     payout ledger and the Financials page show a month that has not begun;
 *   - GET /api/investor builds its months to the same wrong end
 *     (`const endDate = new Date(now.getFullYear(), now.getMonth(), 1)`), and
 *     its zero-activity deferral then takes the phantom month's fixed costs
 *     back out of the all-time expenses: the investor's total expenses,
 *     net revenue to date, monthly and annual estimates all move for a few
 *     hours and move back at midnight;
 *   - truckBilledMonthCount() counts one month more.
 * B7 is the control two hours earlier, the same evening, and passed before the
 * fix too. B8 runs the after-deploy check, scripts/month-end-clock-report.js,
 * on a copy of this world's database: it finds no difference between 18:00
 * and 23:00 Eastern, and writes nothing.
 *
 * Made-up data only: one driver at $300 a day on investor 5's truck T1 (in
 * service 2026-08-01, $1,000 a month fixed), one load a month. The process
 * runs in UTC, production's zone. Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-month-end-business-clock.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
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

const AMY = "Amy Birch";
// Saturday 2026-10-31: 19:00 EDT (control) and 21:00 EDT (inside the window).
const OCT31_1900_ET = Date.parse("2026-10-31T23:00:00Z");
const OCT31_2100_ET = Date.parse("2026-11-01T01:00:00Z");
// Monday 2026-11-30, 19:30 EST (inside the window, after the switch to EST).
const NOV30_1930_ET = Date.parse("2026-12-01T00:30:00Z");

function world(now, extraRows = []) {
	const w = M.startWorld({
		drivers: [{ name: AMY, payDaily: 300 }], now,
		rows: [
			loadRow({ id: "B101", driver: AMY, pickup: "2026-08-10 8:00", dropoff: "2026-08-11 18:00", assigned: "2026-08-10", done: "2026-08-11", truck: "T1" }),
			loadRow({ id: "B102", driver: AMY, pickup: "2026-09-10 8:00", dropoff: "2026-09-11 18:00", assigned: "2026-09-10", done: "2026-09-11", truck: "T1" }),
			loadRow({ id: "B103", driver: AMY, pickup: "2026-10-10 8:00", dropoff: "2026-10-11 18:00", assigned: "2026-10-10", done: "2026-10-11", truck: "T1" }),
			...extraRows,
		],
	});
	w.db.prepare("UPDATE trucks SET insurance_monthly = 1000").run();
	return w;
}
const months = (list) => list.map((m) => m.month);
// The investor dashboard's all-time and estimate figures (GET /api/investor, production.*).
const INVESTOR_FIGURES = ["totalExpenses", "netRevenueToDate", "avgMonthlyInvestorEarnings", "avgDailyInvestorEarnings", "trailing3MonthInvestor", "fleetEstAnnualInvestorRevenue"];
async function investorFigures(w) {
	const inv = await M.investorDays(w);
	const p = (inv.body && inv.body.production) || {};
	return {
		months: months(inv.months),
		figures: Object.fromEntries(INVESTOR_FIGURES.map((k) => [k, p[k]])),
		atRiskCapital: inv.body && inv.body.taxShield ? inv.body.taxShield.atRiskCapital : null,
	};
}

const R = M.createRunner("Money plan B: the month-end loops read the business month (APP_TIMEZONE), not the server clock");

(async () => {
	await R.test("B1 Oct 31 21:00 EDT: the payout ledger's months end at the current month, 2026-10. Base: a 2026-11 row", async ({ eq }) => {
		const led = await M.ledger(world(OCT31_2100_ET));
		eq("current month", led.currentMonthKey, "2026-10");
		eq("ledger months", months(led.monthlyEarnings), ["2026-08", "2026-09", "2026-10"]);
	});

	await R.test("B2 Oct 31 21:00 EDT: the investor view's months end at 2026-10. Base: a 2026-11 row", async ({ eq }) => {
		const v = await investorFigures(world(OCT31_2100_ET));
		eq("investor view months", v.months, ["2026-08", "2026-09", "2026-10"]);
	});

	await R.test("B3 Oct 31 21:00 EDT: the investor's totals and estimates equal those at 19:00 the same evening (total expenses $4,800, net to date $1,200). Base: $3,800 and $2,200", async ({ eq }) => {
		const early = await investorFigures(world(OCT31_1900_ET));
		const late = await investorFigures(world(OCT31_2100_ET));
		eq("figures", late.figures, early.figures);
		eq("at-risk capital", late.atRiskCapital, early.atRiskCapital);
		eq("total expenses (3 months x $1,000 fixed + $1,800 driver pay)", late.figures.totalExpenses, 4800);
	});

	await R.test("B4 Oct 31 21:00 EDT: truckBilledMonthCount() counts Aug, Sep, Oct = 3. Base: 4", async ({ eq }) => {
		const w = world(OCT31_2100_ET);
		const t = w.db.prepare("SELECT * FROM trucks WHERE id = 1").get();
		eq("billed months", w.extra.truckBilledMonthCount(t, new Date(OCT31_2100_ET)), 3);
	});

	await R.test("B5 Oct 31 21:00 EDT: the Financials page ends at October (range to 2026-10-31, 3 months of operation). Base: November added", async ({ eq }) => {
		const r = await M.route(world(OCT31_2100_ET), "GET /api/financials", {});
		eq("status", r.status, 200);
		eq("months", months(r.body.monthlyPerformance || []), ["2026-08", "2026-09", "2026-10"]);
		eq("range end and months of operation", [r.body.summary.to, r.body.summary.monthsOfOperation], ["2026-10-31", 3]);
	});

	await R.test("B6 Nov 30 19:30 EST (after the switch to standard time): the ledger and the investor view end at 2026-11. Base: a 2026-12 row", async ({ eq }) => {
		const w = world(NOV30_1930_ET, [loadRow({ id: "B104", driver: AMY, pickup: "2026-11-10 8:00", dropoff: "2026-11-11 18:00", assigned: "2026-11-10", done: "2026-11-11", truck: "T1" })]);
		const led = await M.ledger(w);
		eq("ledger months", months(led.monthlyEarnings), ["2026-08", "2026-09", "2026-10", "2026-11"]);
		eq("investor view months", (await investorFigures(w)).months, ["2026-08", "2026-09", "2026-10", "2026-11"]);
	});

	await R.test("B7 Control, Oct 31 19:00 EDT (before the window): ledger, investor view and Financials end at 2026-10; 3 billed months", async ({ eq }) => {
		const w = world(OCT31_1900_ET);
		eq("ledger months", months((await M.ledger(w)).monthlyEarnings), ["2026-08", "2026-09", "2026-10"]);
		eq("investor view months", (await investorFigures(w)).months, ["2026-08", "2026-09", "2026-10"]);
		const r = await M.route(w, "GET /api/financials", {});
		eq("Financials months", months(r.body.monthlyPerformance || []), ["2026-08", "2026-09", "2026-10"]);
		const t = w.db.prepare("SELECT * FROM trucks WHERE id = 1").get();
		eq("billed months", w.extra.truckBilledMonthCount(t, new Date(OCT31_1900_ET)), 3);
	});

	await R.test("B8 The after-deploy check (scripts/month-end-clock-report.js, read-only) on a copy, day 2026-10-31: no difference between 18:00 and 23:00 ET, exit 0, the copy unchanged. Base: the November month and a 4th billed month reported, exit 1", async ({ eq, ok }) => {
		const copy = M.saveCopy(world(OCT31_1900_ET));
		const before = M.fileHash(copy.db);
		const r = M.runScript("scripts/month-end-clock-report.js", ["--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--day", "2026-10-31", "--json"]);
		ok("the report ran", r.json, r.stderr.slice(0, 300));
		eq("exit code", r.code, 0);
		eq("differences", r.json && r.json.differences, []);
		eq("what it compared", r.json && [r.json.currentMonth, r.json.trucks, r.json.processZone], [{ before: "2026-10", after: "2026-10" }, 1, "UTC"]);
		eq("the copy is unchanged", M.fileHash(copy.db), before);
	});

	await R.test("B9 The after-deploy check also reads each investor's dashboard (GET /api/investor as the investor): one investor view compared, its months and figures the same at both times", async ({ eq, ok }) => {
		const copy = M.saveCopy(world(OCT31_1900_ET));
		const r = M.runScript("scripts/month-end-clock-report.js", ["--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--day", "2026-10-31", "--json"]);
		ok("the report ran", r.json, r.stderr.slice(0, 300));
		eq("investor dashboards compared", r.json && r.json.investorViews, 1);
		eq("exit code and differences", [r.code, r.json && r.json.differences], [0, []]);
	});

	await R.test("B10 On a machine outside UTC the check still compares on production's zone, UTC, and says which zone the machine runs in", async ({ eq }) => {
		const copy = M.saveCopy(world(OCT31_1900_ET));
		const script = path.join(M.ROOT, "scripts", "month-end-clock-report.js");
		for (const zone of ["America/Los_Angeles", "Asia/Manila"]) {
			const r = spawnSync(process.execPath, [script, "--db", copy.db, "--values-json", copy.values, "--env-file", copy.envFile, "--day", "2026-10-31", "--json"],
				{ cwd: M.ROOT, encoding: "utf8", env: { ...process.env, TZ: zone }, timeout: 45000 });
			let json = null;
			try { json = JSON.parse(r.stdout); } catch { json = null; }
			eq(`${zone}: [process zone, machine zone, exit code]`, json && [json.processZone, json.machineZone, r.status], ["UTC", zone, 0]);
		}
	});

	R.finish();
})();
