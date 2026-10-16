#!/usr/bin/env node
/**
 * The owner's rule (2026-10-16): a daily rate belongs to the DRIVER, not the
 * truck. A daily-rate driver is paid his own rate (drivers_directory.pay_daily);
 * $250 is the default only when he has none. A truck's driver_pay_daily never
 * prices a driver's day.
 *
 * The planned switch, a money flag like the others: DRIVER_RATE_ONLY_ENABLED
 * (true/1/yes/on; off by default) and DRIVER_RATE_ONLY_FROM=YYYY-MM, the first
 * month the rule applies to. A day's month is the month it pays in: the
 * Assigned month of its load (the earliest, when several loads pay the day),
 * else the day's own month, on the invoice as in the ledger. Months before
 * FROM, and a month already closed when the rule first ran, keep the rate they
 * were paid at (the driver's, else the truck's, else $250). The flag on
 * without a month leaves the rule off with one warning, and a FROM at or
 * before the latest closed month is named in a warning at boot.
 *
 * Written before the fix. A case whose title ends in "Base: ..." fails on the
 * base, where resolveDailyRate() falls back to the truck's rate; the controls
 * (C1-C7) pin what must not move and pass before and after the fix.
 *
 * The pay paths, as scripts/lib/money-plans-world.js lifts them out of
 * server.js: the weekly invoice (POST /api/invoices/generate) and its late
 * days, the payout ledger (computeInvestorMonthlyEarnings(), which Financials
 * and the payouts read), the investor view (GET /api/investor, its all-time
 * figures and the Fleet Breakdown), the Financials month detail
 * (GET /api/financials?month=) and the work-days dry run
 * (GET /api/admin/work-days/dry-run); the Fleet Breakdown's text
 * (client/src/lib/driverPay.js), and its Drivers Database and Trucks page text
 * (D18, D19). D10, D10b, D14 and D17 run the read-only "what would change"
 * report (scripts/driver-rate-only-report.js) on a copy of this world's
 * database. D20 and C7 pin the trip rater's TRIP_WORK_DAYS_FROM check on the
 * calendar month. The month-end guards, the close record and the payout-rules
 * dry run are in test-driver-rate-only-guards.js.
 *
 * Made-up data only: investor 5 owns T1 ($150 a day on the truck), T2 ($300)
 * and T3 ($300). Cal Burke has no rate of his own and drives T1; Kim Lowe has
 * none and drives T3; Ana Moss has her own $350 and drives T2. The process runs
 * in UTC, production's zone. Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-driver-rate-only.js    # exits 1 on failure
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
// The first world's own routes (the invoice routes and the work-days dry run);
// M.route() calls the routes money-plans-world adds.
const W = require(path.join(findRoot(__dirname), "scripts", "lib", "work-days-world.js"));
const { loadRow, et } = M;

const CAL = "Cal Burke";
const KIM = "Kim Lowe";
const ANA = "Ana Moss";
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const W40 = "2026-10-09"; // the week Sat 10/3 - Fri 10/9
const NOW = Date.parse("2026-10-16T17:00:00Z"); // Fri 10/16, 1 PM Eastern
const s = (lid, status, wall) => [lid, status, "manual", et(wall), ""];

// One world: September and October loads for Cal on T1, an October load for
// Kim on T3 and for Ana on T2. No ELD on any truck, so each load pays the days
// of its window.
function world({ env = {}, locks = [], payRates = [], status = [], extraDrivers = [], extraRows = [], rows = null, halRate = 0, now = NOW } = {}) {
	return M.startWorld({
		env, locks, payRates, status, now,
		drivers: [{ name: CAL, payDaily: halRate }, { name: ANA, payDaily: 350 }, { name: KIM, payDaily: 0 }, ...extraDrivers],
		trucks: [
			{ unit: "T1", driver: CAL, payDaily: 150 },
			{ unit: "T2", driver: ANA, payDaily: 300 },
			{ unit: "T3", driver: KIM, payDaily: 300 },
		],
		rows: rows || [
			loadRow({ id: "H901", driver: CAL, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1" }),
			loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "K901", driver: KIM, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T3" }),
			loadRow({ id: "A901", driver: ANA, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T2" }),
			...extraRows,
		],
	});
}
// The investor view's production block (as investor 5).
async function production(w) {
	const inv = await M.investorDays(w);
	return (inv.body && inv.body.production) || {};
}
// A stored invoice's paid grid days as [day, total].
const storedGrid = (w, id, weekEnd) => M.gridDays(JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data || "{}"), weekEnd).map((e) => [e.day, e.total]);
// The week Sat 9/26 - Fri 10/2, and the boundary trip: a September load
// (Mon-Tue) and a load Assigned Thu 10/1, At Shipper that morning, still in
// transit when W39 is made (Fri 10/2 20:00 ET) and delivered Mon 10/5.
const W39 = "2026-10-02";
const etMs = (wall) => M.etMs(wall);
function boundaryWorld(env) {
	return world({
		env, now: etMs("2026-10-02 20:00"),
		rows: [
			loadRow({ id: "Q301", driver: CAL, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "Q302", driver: CAL, pickup: "2026-10-01 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
		],
		status: [
			s("Q301", "At Shipper", "2026-09-28 08:00"), s("Q301", "Delivered", "2026-09-29 17:00"),
			s("Q302", "At Shipper", "2026-10-01 10:00"), s("Q302", "In Transit", "2026-10-01 14:00"),
		],
	});
}
function deliverBoundaryLoad(w) {
	w.addStatus([s("Q302", "At Receiver", "2026-10-05 11:00"), s("Q302", "Delivered", "2026-10-05 13:00")]);
	w.setRow("Q302", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
	w.clock.ms = etMs("2026-10-09 20:00");
}
const TRIP_OCT = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" };
// The client's Fleet Breakdown text (an ES module), loaded once.
let driverPayLib = null;
async function driverPayText() {
	if (!driverPayLib) driverPayLib = await import(require("url").pathToFileURL(path.join(M.ROOT, "client", "src", "lib", "driverPay.js")).href);
	return driverPayLib;
}
// The report's rows as plain tuples, for comparing.
const tuples = (list, keys) => (Array.isArray(list) ? list : []).map((r) => keys.map((k) => (k === "driver" ? norm(String(r[k] || "")) : r[k]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

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
	await R.test("D1 Flag on, FROM 2026-10: Cal (no rate of his own, on a $150 truck) gets his W40 invoice at $250 a day, 3 days, Total Due $750; the row records rate $250. Base: $150 a day, $450", async ({ eq }) => {
		const inv = await weekly(world({ env: ON }), CAL, W40);
		eq("status", inv.status, 200);
		eq("grid days at $250", inv.days, [["2026-10-05", 250], ["2026-10-06", 250], ["2026-10-07", 250]]);
		eq("Total Due", inv.totalDue, 750);
		eq("invoice row rate and total", inv.row, { rate: 250, total: 750 });
	});

	await R.test("D2 Flag on, FROM 2026-10: the payout ledger pays Cal's October days at $250 and Kim's (no rate, on a $300 truck) at $250; Cal's September days, before FROM, stay at the truck's $150. Base: October at $150 and $300", async ({ eq }) => {
		const w = world({ env: ON });
		eq("Cal", await ledgerDays(w, CAL), [
			["2026-09", "2026-09-15", 15000], ["2026-09", "2026-09-16", 15000],
			["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000], ["2026-10", "2026-10-07", 25000],
		]);
		eq("Kim", await ledgerDays(w, KIM), [["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000]]);
	});

	await R.test("D3 Flag on, FROM 2026-10: the investor view shows Cal's October at $250 a day ($750) and his September at $150 ($300). Base: October at $150 ($450)", async ({ eq }) => {
		const w = world({ env: ON });
		eq("October", await investorMonth(w, CAL, "2026-10"), { dailyRate: 250, totalPay: 750 });
		eq("September", await investorMonth(w, CAL, "2026-09"), { dailyRate: 150, totalPay: 300 });
	});

	await R.test("D4 Flag on, FROM 2026-10: the Financials October detail prices Cal at $250 ($750), and T1 carries the $250-default badge (no rate on its driver). Base: $150 ($450), no badge", async ({ eq }) => {
		const r = await M.route(world({ env: ON }), "GET /api/financials", { query: { month: "2026-10" } });
		eq("status", r.status, 200);
		const md = (r.body && r.body.monthDetail) || {};
		const row = (md.drivers || []).find((d) => norm(d.name) === norm(CAL)) || null;
		eq("Cal's row", row && { dailyRate: row.dailyRate, pay: row.pay }, { dailyRate: 250, pay: 750 });
		const t1 = (md.trucks || []).find((t) => t.unitNumber === "T1") || null;
		eq("T1 badge", t1 && t1.dailyRateIsDefault, true);
	});

	await R.test("D5 Flag on with PAYOUT_RULES_V2_ENABLED (dated rates): Cal's rate history is $0 and T1's is $150 from 10/1; his October days pay $250. Base: $150 (the truck's rate in effect that day)", async ({ eq }) => {
		const w = world({
			env: { ...ON, PAYOUT_RULES_V2_ENABLED: "true" },
			payRates: [{ subject: "driver", key: norm(CAL), rate: 0, from: "2026-10-01T12:00:00.000Z" }, { subject: "truck", key: "1", rate: 150, from: "2026-10-01T12:00:00.000Z" }],
		});
		const oct = (await ledgerDays(w, CAL)).filter((x) => x[0] === "2026-10");
		eq("October days", oct, [["2026-10", "2026-10-05", 25000], ["2026-10", "2026-10-06", 25000], ["2026-10", "2026-10-07", 25000]]);
	});

	await R.test("D6 Flag on with the trip work-day rule (TRIP_WORK_DAYS, FROM 2026-10): Cal's W40 trip days print $250 each, Total Due $750. Base: $150 each", async ({ eq }) => {
		const w = world({
			env: { ...ON, TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" },
			status: [s("H902", "At Shipper", "2026-10-05 09:00"), s("H902", "Delivered", "2026-10-07 17:00")],
		});
		const inv = await weekly(w, CAL, W40);
		eq("status", inv.status, 200);
		eq("grid days at $250", inv.days, [["2026-10-05", 250], ["2026-10-06", 250], ["2026-10-07", 250]]);
		eq("Total Due", inv.totalDue, 750);
	});

	await R.test("D7 Flag on with no FROM month: the rule stays off (Cal at $150 on the invoice and the ledger) and one warning names DRIVER_RATE_ONLY_FROM. Base: no warning", async ({ eq, ok }) => {
		const w = world({ env: { DRIVER_RATE_ONLY_ENABLED: "true" } });
		const inv = await weekly(w, CAL, W40);
		eq("invoice days at $150", inv.days, [["2026-10-05", 150], ["2026-10-06", 150], ["2026-10-07", 150]]);
		eq("ledger October at $150", (await ledgerDays(w, CAL)).filter((x) => x[0] === "2026-10").map((x) => x[2]), [15000, 15000, 15000]);
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

	await R.test("D8b Flag on with FROM 2026-09, September closed (10/15) before the rule first ran (10/16): September stays at the truck's $150 on the investor view and the ledger, October is $250. Base: October at $150", async ({ eq }) => {
		const w = world({ env: { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-09" } });
		M.lockMonth(w.db, "2026-09", "2026-10-15T05:00:00.000Z");
		eq("investor view September", await investorMonth(w, CAL, "2026-09"), { dailyRate: 150, totalPay: 300 });
		eq("investor view October", await investorMonth(w, CAL, "2026-10"), { dailyRate: 250, totalPay: 750 });
		eq("ledger", (await ledgerDays(w, CAL)).map((x) => [x[0], x[2]]), [["2026-09", 15000], ["2026-09", 15000], ["2026-10", 25000], ["2026-10", 25000], ["2026-10", 25000]]);
	});

	await R.test("D10 The read-only report (scripts/driver-rate-only-report.js --from=2026-10) on a copy, after the W40 invoices were issued at today's rates: drivers Cal $150 -> $250 and Kim $300 -> $250, not Ana; October driver pay Cal $450 -> $750, Kim $600 -> $500; the issued (non-Draft) W40 invoices whose printed rate differs: Cal +$300, Kim -$100; closed months unchanged; exit 0; the copy unchanged. Base: the script does not exist", async ({ eq, ok }) => {
		const w = world({ locks: ["2026-09"] });
		for (const d of [CAL, KIM, ANA]) {
			const g = await M.generate(w, d, W40);
			if (g.invoice) w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.invoice.id);
		}
		const copy = M.saveCopy(w, {});
		const before = M.fileHash(copy.db);
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-10", "--names", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("exit code", r.code, 0);
		const j = r.json || {};
		eq("drivers whose rate changes", tuples(j.drivers, ["driver", "rateToday", "rateUnderRule"]), [[norm(CAL), 150, 250], [norm(KIM), 300, 250]]);
		eq("driver months", tuples(j.driverMonths, ["driver", "month", "days", "payNow", "payUnderRule"]), [[norm(CAL), "2026-10", 3, 450, 750], [norm(KIM), "2026-10", 2, 600, 500]]);
		eq("issued invoices whose printed rate differs", tuples(j.invoices, ["driver", "status", "printedRate", "ruleRate", "difference"]), [[norm(CAL), "Submitted", 150, 250, 300], [norm(KIM), "Submitted", 300, 250, -100]]);
		eq("closed months unchanged", j.closedMonthsUnchanged, true);
		eq("the copy is unchanged", M.fileHash(copy.db), before);
	});

	await R.test("D10b The report refuses --from=2026-09 while September is closed: exit 2, nothing printed as a result. Base: the script does not exist", async ({ eq, ok }) => {
		const w = world({ locks: ["2026-09"] });
		const copy = M.saveCopy(w, {});
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-09", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("exit code", r.code, 2);
		eq("no result", r.json, null);
	});

	await R.test("D11 A week straddling FROM (W39, Sat 9/26 - Fri 10/2) is priced by each day's Assigned month: a load Assigned 9/29 (days 9/29-10/1) keeps the truck's $150, including Thu 10/1; a load Assigned 10/2 pays $250; Total Due $700; the ledger files the same days in the same months at the same rates. Base: 10/2 at $150, $600", async ({ eq }) => {
		const w = world({
			env: ON,
			rows: [
				loadRow({ id: "S901", driver: CAL, pickup: "2026-09-29 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T1" }),
				loadRow({ id: "S902", driver: CAL, pickup: "2026-10-02 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-02", done: "2026-10-02", truck: "T1" }),
			],
		});
		const inv = await weekly(w, CAL, W39);
		eq("grid", inv.days, [["2026-09-29", 150], ["2026-09-30", 150], ["2026-10-01", 150], ["2026-10-02", 250]]);
		eq("Total Due", inv.totalDue, 700);
		eq("ledger", await ledgerDays(w, CAL), [
			["2026-09", "2026-09-29", 15000], ["2026-09", "2026-09-30", 15000], ["2026-09", "2026-10-01", 15000], ["2026-10", "2026-10-02", 25000],
		]);
	});

	await R.test("D12 Flag on, FROM 2026-10: the investor view's all-time figure prices each day by its month (2 x $150 + 3 x $250 = $1,050, segments [2 days $150, 3 days $250]); the Fleet Breakdown's T1 pay is the same $1,050 with the same segments. Base: 5 x $150 = $750, no segments", async ({ eq }) => {
		const p = await production(world({ env: ON }));
		const det = (p.driverPayDetails || {})[norm(CAL)] || {};
		eq("all-time pay", det.totalPay, 1050);
		eq("all-time segments", det.rates, [{ days: 2, rate: 150 }, { days: 3, rate: 250 }]);
		const t1 = (p.perTruckData && p.perTruckData.T1 && p.perTruckData.T1.driverPay) || {};
		eq("Fleet Breakdown T1 pay", t1.totalPay, 1050);
		eq("Fleet Breakdown T1 driver segments", (t1.drivers || []).map((d) => [d.totalPay, d.rates]), [[1050, [{ days: 2, rate: 150 }, { days: 3, rate: 250 }]]]);
	});

	await R.test("D13 The Fleet Breakdown's text for a driver paid at two rates reads \"2 days x $150 + 3 days x $250\" (client/src/lib/driverPay.js). Base: \"5 days x $250\"", async ({ eq }) => {
		const lib = await driverPayText();
		eq("text", lib.driverPayBasis({ payType: "fixed", activeDays: 5, dailyRate: 0, totalPay: 1050, rates: [{ days: 2, rate: 150 }, { days: 3, rate: 250 }] }), "2 days x $150 + 3 days x $250");
	});

	await R.test("D14 The report lists dated-history gaps: Cal's own $150 was set on 10/16 but pay_rate_history reads $0 for 10/1-10/15, days the dated-rate and trip rules would pay at $250 under the rule while the ledger and invoice pay $150. Base: the script does not exist", async ({ eq, ok }) => {
		const w = world({
			halRate: 150,
			payRates: [
				{ subject: "driver", key: norm(CAL), rate: 0, from: "2026-10-02T03:00:20.000Z" },
				{ subject: "truck", key: "1", rate: 150, from: "2026-10-02T03:00:20.000Z" },
				{ subject: "driver", key: norm(CAL), rate: 150, from: "2026-10-16T12:00:00.000Z" },
			],
		});
		const copy = M.saveCopy(w, {});
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-10", "--names", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("history gaps", tuples(r.json && r.json.historyGaps, ["driver", "from", "to"]), [[norm(CAL), "2026-10-01", "2026-10-15"]]);
	});

	await R.test("D15 Late days (TRIP_WORK_DAYS, FROM 2026-10, settleLateWorkDays()): W39 is made with the October load in transit; when W40 is made, its Thu 10/1 and Fri 10/2 go onto the W39 Draft at $250 each (an October load), its September days stay $150, and W40's trip days are $250. Base: $150", async ({ eq }) => {
		const w = boundaryWorld({ ...ON, ...TRIP_OCT });
		const g39 = await M.generate(w, CAL, W39);
		eq("W39 made", g39.status, 200);
		deliverBoundaryLoad(w);
		const g40 = await weekly(w, CAL, W40);
		eq("W40 grid", g40.days, [["2026-10-03", 250], ["2026-10-04", 250], ["2026-10-05", 250]]);
		eq("W39 after the late days", storedGrid(w, g39.invoice.id, W39), [["2026-09-28", 150], ["2026-09-29", 150], ["2026-10-01", 250], ["2026-10-02", 250]]);
	});

	await R.test("D16 The work-days dry run (GET /api/admin/work-days/dry-run, from 2026-10) prices the days it would add to W39 (Thu 10/1, Fri 10/2 of an October load) at $250 each: $500. Base: $300", async ({ eq }) => {
		const w = boundaryWorld(ON);
		const g39 = await M.generate(w, CAL, W39);
		deliverBoundaryLoad(w);
		await M.generate(w, CAL, W40);
		const r = await W.route(w, "GET /api/admin/work-days/dry-run", { query: { from: "2026-10", to: "2026-10" } });
		eq("status", r.status, 200);
		const inv = ((r.body && r.body.perInvoice) || []).find((i) => g39.invoice && i.invoiceNumber === g39.invoice.invoice_number) || null;
		eq("W39 added days and amount", inv && [inv.addedDays, inv.amountAdded], [["2026-10-01", "2026-10-02"], 500]);
	});

	await R.test("D17 The report lists the ledger days whose pay changes and that no live weekly invoice carries: Cal's W41 load (10/12-10/13, no invoice yet) at $150 -> $250 each; his invoiced W40 days are not listed. Base: the script does not exist", async ({ eq, ok }) => {
		const w = world({
			locks: ["2026-09"],
			extraRows: [loadRow({ id: "H903", driver: CAL, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T1" })],
		});
		const g = await M.generate(w, CAL, W40);
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.invoice.id);
		const copy = M.saveCopy(w, {});
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-10", "--names", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("Cal's ledger days on no invoice", tuples(((r.json && r.json.ledgerDaysOnNoInvoice) || []).filter((d) => norm(d.driver) === norm(CAL)), ["driver", "day", "payNow", "payUnderRule"]),
			[[norm(CAL), "2026-10-12", 150, 250], [norm(CAL), "2026-10-13", 150, 250]]);
	});

	await R.test("D18 The Drivers Database's Daily Rate help says blank/0 is the $250 default while the rule is on, and keeps today's truck-rate wording while it is off (client/src/lib/driverPay.js dailyRateHelpText()). Base: no such text", async ({ eq }) => {
		const lib = await driverPayText();
		eq("on", typeof lib.dailyRateHelpText === "function" ? lib.dailyRateHelpText({ from: "2026-10" }) : null, "Driver earns this × active days. Leave blank/0 for the $250 default.");
		eq("off", typeof lib.dailyRateHelpText === "function" ? lib.dailyRateHelpText(null) : null, "Driver earns this × active days. Leave blank/0 to use the assigned truck's rate (default $250).");
	});

	await R.test("D19 The Trucks page's Driver Pay field reads \"Not used for pay from October 2026.\" while the rule is on, and nothing while it is off (truckPayRuleNote()). Base: no such text", async ({ eq }) => {
		const lib = await driverPayText();
		eq("on", typeof lib.truckPayRuleNote === "function" ? lib.truckPayRuleNote({ from: "2026-10" }) : null, "Not used for pay from October 2026.");
		eq("off", typeof lib.truckPayRuleNote === "function" ? lib.truckPayRuleNote(null) : null, "");
	});

	// A Sept 30 trip day of a load Assigned Oct 1, under the trip work-day rule
	// (FROM 2026-10): Cal's own rate is $300 now, but his dated rate reads $0.
	const tripCalendarWorld = (env) => world({
		env: { ...TRIP_OCT, ...env }, halRate: 300, now: etMs("2026-10-02 20:00"),
		payRates: [{ subject: "driver", key: norm(CAL), rate: 0, from: "2026-09-01T12:00:00.000Z" }],
		rows: [loadRow({ id: "Q401", driver: CAL, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T1" })],
		status: [s("Q401", "At Shipper", "2026-09-30 09:00"), s("Q401", "Delivered", "2026-10-01 17:00")],
	});
	await R.test("D20 Flag on with the trip work-day rule: the trip rater keeps its TRIP_WORK_DAYS_FROM check on the calendar month. Sept 30 (a September day, though its load pays in October) keeps Cal's one rate, $300; Oct 1 takes the dated path, $0 dated so the rule's $250. Base: Oct 1 at the truck's $150", async ({ eq }) => {
		eq("W39 grid", (await weekly(tripCalendarWorld(ON), CAL, W39)).days, [["2026-09-30", 300], ["2026-10-01", 250]]);
	});

	// The rule from November: an October day keeps the truck's $150, a November
	// day pays $250 (Cal has no rate of his own).
	const NOV = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-11" };

	await R.test("D21 The work-days dry run (from 2026-10) prices a day paid by a load with no Assigned Date and by a load Assigned the next month in the day's own month: W39's Thu 10/1 and Fri 10/2 (undated load U951 and load V951 Assigned Nov 2) are October days at $150, $300 added. Before: November days, $500 (the undated load was skipped)", async ({ eq }) => {
		const w = world({
			env: NOV, now: etMs("2026-10-02 20:00"),
			rows: [
				loadRow({ id: "Q301", driver: CAL, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				// The dated load first, so the undated one is weighed second.
				loadRow({ id: "V951", driver: CAL, pickup: "2026-10-01 9:00", dropoff: "2026-10-02 14:00", assigned: "2026-11-02", done: "", status: "In Transit", truck: "T1" }),
				loadRow({ id: "U951", driver: CAL, pickup: "2026-10-01 9:00", dropoff: "2026-10-02 14:00", assigned: "", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [
				s("Q301", "At Shipper", "2026-09-28 08:00"), s("Q301", "Delivered", "2026-09-29 17:00"),
				s("U951", "At Shipper", "2026-10-01 10:00"), s("V951", "At Shipper", "2026-10-01 10:00"),
			],
		});
		const g39 = await M.generate(w, CAL, W39);
		w.addStatus([s("U951", "Delivered", "2026-10-02 13:00"), s("V951", "Delivered", "2026-10-02 13:00")]);
		for (const id of ["U951", "V951"]) w.setRow(id, { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
		w.clock.ms = etMs("2026-10-09 20:00");
		const r = await W.route(w, "GET /api/admin/work-days/dry-run", { query: { from: "2026-10", to: "2026-10" } });
		eq("status", r.status, 200);
		const inv = ((r.body && r.body.perInvoice) || []).find((i) => g39.invoice && i.invoiceNumber === g39.invoice.invoice_number) || null;
		eq("W39 added days and amount", inv && [inv.addedDays, inv.amountAdded], [["2026-10-01", "2026-10-02"], 300]);
	});

	await R.test("D22 The report (--from=2026-11) reads a grid day paid by a load with no Assigned Date and by a load Assigned the next month in the day's own month: an issued week of Sat 10/31 (loads U961 undated and V961 Assigned Nov 2) and Mon 11/2 (V961) at $150 is listed for Mon 11/2 only ($250 under the rule); Sat 10/31 is an October day, before FROM. Before: both days listed", async ({ eq, ok }) => {
		const w = world({
			rows: [
				loadRow({ id: "U961", driver: CAL, pickup: "2026-10-31 8:00", dropoff: "2026-10-31 18:00", assigned: "", done: "2026-10-31", truck: "T1" }),
				loadRow({ id: "V961", driver: CAL, pickup: "2026-10-31 8:00", dropoff: "2026-11-02 18:00", assigned: "2026-11-02", done: "2026-11-02", truck: "T1" }),
			],
		});
		const days = M.dayGrid("2026-10-31", ["2026-10-31", "2026-11-02"], 150, (d) => (d === "2026-10-31" ? "U961, V961" : "V961"));
		M.insertInvoice(w.db, {
			invoice_number: "INV-CB-2026W44-01", driver: CAL, week_start: "2026-10-31", week_end: "2026-11-06", loads_count: 2, rate_per_load: 150,
			total_earnings: 300, status: "Submitted", render_data: JSON.stringify({ __templateName: "service_invoice", days }),
		});
		const copy = M.saveCopy(w, {});
		const r = M.runScript("scripts/driver-rate-only-report.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--from=2026-11", "--names", "--json"]);
		ok("the script ran", r.code === 0, r.stderr.split("\n")[0]);
		const listed = ((r.json && r.json.invoices) || []).find((i) => i.invoiceNumber === "INV-CB-2026W44-01") || null;
		eq("the days listed", listed && listed.days.map((d) => [d.day, d.month, d.printed, d.rule]), [["2026-11-02", "2026-11", 150, 250]]);
	});

	await R.test("C7 Control, flag off with the trip work-day rule: the same week as today: Sept 30 at Cal's one rate ($300), Oct 1 on the dated path ($0 dated, so the truck's $150)", async ({ eq }) => {
		eq("W39 grid", (await weekly(tripCalendarWorld({}), CAL, W39)).days, [["2026-09-30", 300], ["2026-10-01", 150]]);
	});

	await R.test("C1 Control, flag off (also with FROM set and the flag off): Cal at the truck's $150 on the invoice, the ledger and the investor view; Kim at $300", async ({ eq }) => {
		for (const env of [{}, { DRIVER_RATE_ONLY_FROM: "2026-10" }]) {
			const w = world({ env });
			eq(`invoice ${JSON.stringify(env)}`, (await weekly(w, CAL, W40)).days, [["2026-10-05", 150], ["2026-10-06", 150], ["2026-10-07", 150]]);
			eq(`ledger October ${JSON.stringify(env)}`, (await ledgerDays(w, CAL)).filter((x) => x[0] === "2026-10").map((x) => x[2]), [15000, 15000, 15000]);
			eq(`investor October ${JSON.stringify(env)}`, await investorMonth(w, CAL, "2026-10"), { dailyRate: 150, totalPay: 450 });
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

	await R.test("C4 Control, flag on, FROM 2026-10: September (before FROM) closes with Cal's days frozen at the truck's $150, and the Financials page shows it exactly as settled", async ({ eq }) => {
		const w = world({ env: ON });
		const frozen = await M.freezeAndLock(w, "2026-09", "2026-10-15T05:00:00.000Z");
		eq("frozen at $150", frozen.filter((i) => i.kind === "driver_pay" && i.driver === norm(CAL)).map((i) => i.cents), [15000, 15000]);
		const r = await M.route(w, "GET /api/financials", { query: { month: "2026-09" } });
		const row = ((r.body && r.body.monthDetail && r.body.monthDetail.drivers) || []).find((d) => norm(d.name) === norm(CAL)) || null;
		eq("September's Cal row", row && { dailyRate: row.dailyRate, pay: row.pay }, { dailyRate: 150, pay: 300 });
	});

	await R.test("C5 Control, flag off: the investor view's all-time figure and the Fleet Breakdown keep days x one rate (5 x $150 = $750)", async ({ eq }) => {
		const p = await production(world());
		const det = (p.driverPayDetails || {})[norm(CAL)] || {};
		eq("all-time", [det.activeDays, det.dailyRate, det.totalPay], [5, 150, 750]);
		const t1 = (p.perTruckData && p.perTruckData.T1 && p.perTruckData.T1.driverPay) || {};
		eq("Fleet Breakdown T1", [t1.totalPay, (t1.drivers || []).map((d) => [d.activeDays, d.dailyRate, d.totalPay])], [750, [[5, 150, 750]]]);
	});

	await R.test("C6 Control: the Fleet Breakdown's text for one rate is unchanged (\"5 days x $150\")", async ({ eq }) => {
		const lib = await driverPayText();
		eq("text", lib.driverPayBasis({ payType: "fixed", activeDays: 5, dailyRate: 150, totalPay: 750 }), "5 days x $150");
	});

	R.finish();
})();
