#!/usr/bin/env node
/**
 * The owner's rule (2026-10-16): a daily rate belongs to the DRIVER, not the
 * truck. A daily-rate driver is paid his own rate (drivers_directory.pay_daily);
 * $250 is the default only when he has none. A truck's driver_pay_daily never
 * prices a driver's day.
 *
 * The planned switch, a money flag like the others: DRIVER_RATE_ONLY_ENABLED
 * (true/1/yes/on; off by default) and DRIVER_RATE_ONLY_FROM=YYYY-MM, the first
 * month the rule applies to. Months before FROM, and every closed month, keep
 * the rate they were paid at (the driver's, else the truck's, else $250). The
 * flag on without a month leaves the rule off with one warning, and a FROM at
 * or before the latest closed month is named in a warning at boot.
 *
 * Written before the fix. A case whose title ends in "Base: ..." fails on main,
 * where resolveDailyRate() falls back to the truck's rate; the controls (C1-C4)
 * pin what must not move and pass on main and after the fix.
 *
 * The pay paths, as scripts/lib/money-plans-world.js lifts them out of
 * server.js: the weekly invoice (POST /api/invoices/generate), the payout
 * ledger (computeInvestorMonthlyEarnings(), which Financials and the payouts
 * read), the investor view (GET /api/investor) and the Financials month detail
 * (GET /api/financials?month=). D10 runs the planned read-only "what would
 * change" report on a copy of this world's database.
 *
 * Made-up data only: investor 5 owns T1 ($150 a day on the truck), T2 ($300)
 * and T3 ($300). Hal Reed has no rate of his own and drives T1; Kim Lowe has
 * none and drives T3; Ana Moss has her own $350 and drives T2. The process runs
 * in UTC, production's zone. Pure: no server, no app.db, no network.
 *
 * They live in scripts/pending/, which scripts/run-unit-tests.js does not read,
 * so npm run check is unchanged; the fix moves this runner to scripts/.
 *
 * Run: node scripts/pending/test-driver-rate-only.js    # exits 1 on failure
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
const { loadRow, et } = M;

const HAL = "Hal Reed";
const KIM = "Kim Lowe";
const ANA = "Ana Moss";
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const W40 = "2026-10-09"; // the week Sat 10/3 - Fri 10/9
const NOW = Date.parse("2026-10-16T17:00:00Z"); // Fri 10/16, 1 PM Eastern
const s = (lid, status, wall) => [lid, status, "manual", et(wall), ""];

// One world: September and October loads for Hal on T1, an October load for
// Kim on T3 and for Ana on T2. No ELD on any truck, so each load pays the days
// of its window.
function world({ env = {}, locks = [], payRates = [], status = [], extraDrivers = [], extraRows = [] } = {}) {
	return M.startWorld({
		env, locks, payRates, status, now: NOW,
		drivers: [{ name: HAL, payDaily: 0 }, { name: ANA, payDaily: 350 }, { name: KIM, payDaily: 0 }, ...extraDrivers],
		trucks: [
			{ unit: "T1", driver: HAL, payDaily: 150 },
			{ unit: "T2", driver: ANA, payDaily: 300 },
			{ unit: "T3", driver: KIM, payDaily: 300 },
		],
		rows: [
			loadRow({ id: "H901", driver: HAL, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1" }),
			loadRow({ id: "H902", driver: HAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "K901", driver: KIM, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T3" }),
			loadRow({ id: "A901", driver: ANA, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T2" }),
			...extraRows,
		],
	});
}

// A driver's ledger day items as [month, day, cents], sorted.
async function ledgerDays(w, driver) {
	const led = await M.ledger(w);
	return led.pay.filter((i) => i.driver === norm(driver)).map((i) => [i.month, i.day, i.cents]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}
// The investor view's { dailyRate, totalPay } for a driver in a month.
async function investorMonth(w, driver, month) {
	const inv = await M.investorDays(w);
	const m = inv.months.find((x) => x.month === month);
	const det = m && m.driverDetails ? m.driverDetails[norm(driver)] : null;
	return det ? { dailyRate: det.dailyRate, totalPay: det.totalPay } : null;
}
// The weekly invoice's paid grid days as [day, total], and its row's rate and total.
async function weekly(w, driver, weekEnd) {
	const g = await M.generate(w, driver, weekEnd);
	return {
		status: g.status,
		days: M.gridDays(g.data, weekEnd).map((e) => [e.day, e.total]),
		totalDue: g.data && g.data.totalDue,
		row: g.invoice ? { rate: g.invoice.rate_per_load, total: g.invoice.total_earnings } : null,
	};
}

const R = M.createRunner("The owner's rule (2026-10-16): a daily rate belongs to the driver; $250 only when the driver has none (DRIVER_RATE_ONLY_ENABLED, DRIVER_RATE_ONLY_FROM)");

(async () => {
	await R.test("D1 Flag on, FROM 2026-10: Hal (no rate of his own, on a $150 truck) gets his W40 invoice at $250 a day, 3 days, Total Due $750; the row records rate $250. Base: $150 a day, $450", async ({ eq }) => {
		const inv = await weekly(world({ env: ON }), HAL, W40);
		eq("status", inv.status, 200);
		eq("grid days at $250", inv.days, [["2026-10-05", 250], ["2026-10-06", 250], ["2026-10-07", 250]]);
		eq("Total Due", inv.totalDue, 750);
		eq("invoice row rate and total", inv.row, { rate: 250, total: 750 });
	});

	await R.test("D2 Flag on, FROM 2026-10: the payout ledger pays Hal's October days at $250 and Kim's (no rate, on a $300 truck) at $250; Hal's September days, before FROM, stay at the truck's $150. Base: October at $150 and $300", async ({ eq }) => {
		const w = world({ env: ON });
		eq("Hal", await ledgerDays(w, HAL), [
			["2026-09", "2026-09-15", 15000], ["2026-09", "2026-09-16", 15000],
			["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000], ["2026-10", "2026-10-07", 25000],
		]);
		eq("Kim", await ledgerDays(w, KIM), [["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000]]);
	});

	await R.test("D3 Flag on, FROM 2026-10: the investor view shows Hal's October at $250 a day ($750) and his September at $150 ($300). Base: October at $150 ($450)", async ({ eq }) => {
		const w = world({ env: ON });
		eq("October", await investorMonth(w, HAL, "2026-10"), { dailyRate: 250, totalPay: 750 });
		eq("September", await investorMonth(w, HAL, "2026-09"), { dailyRate: 150, totalPay: 300 });
	});

	await R.test("D4 Flag on, FROM 2026-10: the Financials October detail prices Hal at $250 ($750), and T1 carries the $250-default badge (no rate on its driver). Base: $150 ($450), no badge", async ({ eq }) => {
		const r = await M.route(world({ env: ON }), "GET /api/financials", { query: { month: "2026-10" } });
		eq("status", r.status, 200);
		const md = (r.body && r.body.monthDetail) || {};
		const row = (md.drivers || []).find((d) => norm(d.name) === norm(HAL)) || null;
		eq("Hal's row", row && { dailyRate: row.dailyRate, pay: row.pay }, { dailyRate: 250, pay: 750 });
		const t1 = (md.trucks || []).find((t) => t.unitNumber === "T1") || null;
		eq("T1 badge", t1 && t1.dailyRateIsDefault, true);
	});

	await R.test("D5 Flag on with PAYOUT_RULES_V2_ENABLED (dated rates): Hal's rate history is $0 and T1's is $150 from 10/1; his October days pay $250. Base: $150 (the truck's rate in effect that day)", async ({ eq }) => {
		const w = world({
			env: { ...ON, PAYOUT_RULES_V2_ENABLED: "true" },
			payRates: [{ subject: "driver", key: norm(HAL), rate: 0, from: "2026-10-01T12:00:00.000Z" }, { subject: "truck", key: "1", rate: 150, from: "2026-10-01T12:00:00.000Z" }],
		});
		const oct = (await ledgerDays(w, HAL)).filter((x) => x[0] === "2026-10");
		eq("October days", oct, [["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000], ["2026-10", "2026-10-07", 25000]]);
	});

	await R.test("D6 Flag on with the trip work-day rule (TRIP_WORK_DAYS, FROM 2026-10): Hal's W40 trip days print $250 each, Total Due $750. Base: $150 each", async ({ eq }) => {
		const w = world({
			env: { ...ON, TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" },
			status: [s("H902", "At Shipper", "2026-10-05 09:00"), s("H902", "Delivered", "2026-10-07 17:00")],
		});
		const inv = await weekly(w, HAL, W40);
		eq("status", inv.status, 200);
		eq("grid days at $250", inv.days, [["2026-10-05", 250], ["2026-10-06", 250], ["2026-10-07", 250]]);
		eq("Total Due", inv.totalDue, 750);
	});

	await R.test("D7 Flag on with no FROM month: the rule stays off (Hal at $150 on the invoice and the ledger) and one warning names DRIVER_RATE_ONLY_FROM. Base: no warning", async ({ eq, ok }) => {
		const w = world({ env: { DRIVER_RATE_ONLY_ENABLED: "true" } });
		const inv = await weekly(w, HAL, W40);
		eq("invoice days at $150", inv.days, [["2026-10-05", 150], ["2026-10-06", 150], ["2026-10-07", 150]]);
		eq("ledger October at $150", (await ledgerDays(w, HAL)).filter((x) => x[0] === "2026-10").map((x) => x[2]), [15000, 15000, 15000]);
		ok("a warning names DRIVER_RATE_ONLY_FROM", w.warnings.some((x) => /DRIVER_RATE_ONLY_FROM/.test(x)), JSON.stringify(w.warnings.slice(0, 3)));
	});

	await R.test("D8 Flag on with FROM 2026-09 while September is closed: a warning at boot names DRIVER_RATE_ONLY_FROM and 2026-09. Base: no warning", async ({ ok }) => {
		const w = world({ env: { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-09" }, locks: ["2026-09"] });
		ok("boot warning", w.warnings.some((x) => /DRIVER_RATE_ONLY_FROM/.test(x) && /2026-09/.test(x)), JSON.stringify(w.warnings.slice(0, 3)));
	});

	await R.test("D9 Flag on, FROM 2026-10: a driver hired after the switch, with no rate of his own, is paid $250 on a truck someone sets to $400 (the truck rate never reaches him). Base: $400", async ({ eq }) => {
		const NED = "Ned Fair";
		const w = world({
			env: ON,
			extraDrivers: [{ name: NED, payDaily: 0 }],
			extraRows: [loadRow({ id: "N901", driver: NED, pickup: "2026-10-06 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-06", done: "2026-10-06", truck: "T4" })],
		});
		w.db.prepare("INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, driver_pay_daily) VALUES (4, 'T4', 5, 'Active', '2026-10-01', '2026-10-01 00:00:00', ?, 400)").run(NED);
		w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (4, ?, '2026-10-01T17:00:00.000Z')").run(NED);
		eq("invoice", (await weekly(w, NED, W40)).days, [["2026-10-06", 250]]);
		eq("ledger", await ledgerDays(w, NED), [["2026-10", "2026-10-06", 25000]]);
	});

	await R.test("D10 The read-only report (scripts/driver-rate-only-report.js --from=2026-10) on a copy: lists Hal $150 -> $250 and Kim $300 -> $250 (rate today vs under the rule), not Ana; closed months unchanged; exit 0; the copy unchanged. Base: the script does not exist", async ({ eq, ok }) => {
		const w = world({ locks: ["2026-09"] });
		const copy = M.saveCopy(w, {});
		const before = M.fileHash(copy.db);
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-10", "--names", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("exit code", r.code, 0);
		const list = (r.json && Array.isArray(r.json.drivers) ? r.json.drivers : []).map((d) => [norm(String(d.driver || "")), d.rateToday, d.rateUnderRule]).sort();
		eq("drivers whose rate changes", list, [[norm(HAL), 150, 250], [norm(KIM), 300, 250]]);
		eq("closed months unchanged", r.json && r.json.closedMonthsUnchanged, true);
		eq("the copy is unchanged", M.fileHash(copy.db), before);
	});

	await R.test("C1 Control, flag off (also with FROM set and the flag off): Hal at the truck's $150 on the invoice, the ledger and the investor view; Kim at $300", async ({ eq }) => {
		for (const env of [{}, { DRIVER_RATE_ONLY_FROM: "2026-10" }]) {
			const w = world({ env });
			eq(`invoice ${JSON.stringify(env)}`, (await weekly(w, HAL, W40)).days, [["2026-10-05", 150], ["2026-10-06", 150], ["2026-10-07", 150]]);
			eq(`ledger October ${JSON.stringify(env)}`, (await ledgerDays(w, HAL)).filter((x) => x[0] === "2026-10").map((x) => x[2]), [15000, 15000, 15000]);
			eq(`investor October ${JSON.stringify(env)}`, await investorMonth(w, HAL, "2026-10"), { dailyRate: 150, totalPay: 450 });
			eq(`Kim ${JSON.stringify(env)}`, (await ledgerDays(w, KIM)).map((x) => x[2]), [30000, 30000]);
		}
	});

	await R.test("C2 Control, flag on: Ana's own $350 wins over her $300 truck on the invoice and the ledger", async ({ eq }) => {
		const w = world({ env: ON });
		eq("invoice", (await weekly(w, ANA, W40)).days, [["2026-10-05", 350], ["2026-10-06", 350]]);
		eq("ledger", (await ledgerDays(w, ANA)).map((x) => x[2]), [35000, 35000]);
	});

	await R.test("C3 Control, flag on: a driver with no rate and no truck is paid the $250 default", async ({ eq }) => {
		const ZOE = "Zoe Hart";
		const w = world({
			env: ON,
			extraDrivers: [{ name: ZOE, payDaily: 0 }],
			extraRows: [loadRow({ id: "Z901", driver: ZOE, pickup: "2026-10-06 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-06", done: "2026-10-06", owner: "" })],
		});
		eq("invoice", (await weekly(w, ZOE, W40)).days, [["2026-10-06", 250]]);
	});

	await R.test("C4 Control, flag on, FROM 2026-10: September (before FROM) closes with Hal's days frozen at the truck's $150, and the Financials page shows it exactly as settled", async ({ eq }) => {
		const w = world({ env: ON });
		const frozen = await M.freezeAndLock(w, "2026-09", "2026-10-15T05:00:00.000Z");
		eq("frozen at $150", frozen.filter((i) => i.kind === "driver_pay" && i.driver === norm(HAL)).map((i) => i.cents), [15000, 15000]);
		const r = await M.route(w, "GET /api/financials", { query: { month: "2026-09" } });
		const row = ((r.body && r.body.monthDetail && r.body.monthDetail.drivers) || []).find((d) => norm(d.name) === norm(HAL)) || null;
		eq("September's Hal row", row && { dailyRate: row.dailyRate, pay: row.pay }, { dailyRate: 150, pay: 300 });
	});

	R.finish();
})();
