#!/usr/bin/env node
/**
 * B12 runner E: one driver-day is paid in one month (plan section 4b, flag F1,
 * cases E1-E9), behind LEDGER_DAY_ONCE_ENABLED and LEDGER_DAY_ONCE_FROM.
 * FAILING TESTS WRITTEN BEFORE THE FIX. On main the ledger keeps one day set per
 * driver per Assigned month (lib/financials-calc.js), so a day two loads with
 * different Assigned months pay counts in both; E2, E3 and E6 pin today's
 * behaviour and pass on main.
 *
 * The contract (from the plan):
 *   - in a bucket month that is FROM or later, a day is dropped when a load with
 *     an earlier Assigned month also pays it; the earliest Assigned month wins;
 *     months before FROM are computed exactly as today;
 *   - "pays" means the earlier load's PAID days (after the ELD check, the
 *     pre-dispatch rule when on, the trip rule when it applies, and remove
 *     overrides), not its scheduled window;
 *   - no frozen-item or lock read in the pay math; the investor view (GET
 *     /api/investor) applies the same rule, within one owner scope;
 *   - start-up: FROM unset or not a month leaves the rule off with one warning
 *     naming the setting (never its value); FROM at or before the latest closed
 *     month logs one notice built like lib/load-pay-days.js
 *     fromMonthClosedWarning(), from a boot call written like
 *     warnPreDispatchFromClosedMonth(): a column-0 `warn...FromClosedMonth();`;
 *   - the switch-on dry run, scripts/ledger-day-once-dry-run.js (this name is the
 *     runners' choice; the plan names no file) --db=<copy> --values-json=<file>
 *     --env-file=<file> --from=YYYY-MM, refuses (exit 2) a FROM that is already
 *     closed and lists each dropped day with both loads, marking a dropped day
 *     missing from the earlier month's frozen items (a report only).
 *
 * The ledger (computeInvestorMonthlyEarnings()) and the investor view run lifted
 * from server.js (lib/work-days-world.js beside this runner) for investor 5; $260 a
 * day; no ELD unless a case gives one. Made-up data only. Pure: no server, no
 * app.db, no network.
 * Run: node scripts/pending/test-ledger-day-once.js    # exits 1 on failure (scripts/test-ledger-day-once.js once enabled)
 */
"use strict";
process.env.TZ = "UTC";
const path = require("path");
const { spawnSync } = require("child_process");
const W = require("./lib/work-days-world");
const { loadRow } = W;

const ONCE = (from) => ({ LEDGER_DAY_ONCE_ENABLED: "true", ...(from === undefined ? {} : { LEDGER_DAY_ONCE_FROM: from }) });
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const md = (month, days) => days.map((d) => `${month} ${d}`);

async function views(world, driver) {
	const led = await W.ledger(world);
	const inv = await W.investorDays(world);
	const pay = (months, mk) => { const m = months.find((x) => x.month === mk); return m ? Math.round(m.driverPay) : 0; };
	return {
		ledger: W.monthDays(led.pay, norm(driver)),
		investor: W.monthDays(inv.days, norm(driver)),
		ledgerPay: (mk) => pay(led.monthlyEarnings, mk),
		investorPay: (mk) => pay(inv.months, mk),
		led,
	};
}

// A Sep-assigned load 9/28-9/30 and an Oct-assigned load 9/30-10/2: 9/30 is paid by both.
const AMY = "Amy Birch";
function pairWorld(env, extra = {}) {
	return W.startWorld({
		env,
		drivers: [{ name: AMY }],
		rows: [
			loadRow({ id: "E101", driver: AMY, pickup: "2026-09-28 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-28", done: "2026-09-30", truck: "T1" }),
			loadRow({ id: "E102", driver: AMY, pickup: "2026-09-30 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
		],
		...extra,
	});
}
const TODAY_PAIR = [...md("2026-09", ["2026-09-28", "2026-09-29", "2026-09-30"]), ...md("2026-10", ["2026-09-30", "2026-10-01", "2026-10-02"])];
const ONCE_PAIR = [...md("2026-09", ["2026-09-28", "2026-09-29", "2026-09-30"]), ...md("2026-10", ["2026-10-01", "2026-10-02"])];

const R = W.createRunner("B12 E: the ledger pays a driver-day in one month (LEDGER_DAY_ONCE)");

(async () => {
	await R.test("E1 Flag on, FROM=2026-10: a day paid by a Sep- and an Oct-assigned load (9/30) counts in Sep only. Base: in both", async ({ eq }) => {
		const v = await views(pairWorld(ONCE("2026-10")), AMY);
		eq("ledger", v.ledger, ONCE_PAIR);
	});

	await R.test("E2 FROM=2026-11: both months still count it, unchanged", async ({ eq }) => {
		const v = await views(pairWorld(ONCE("2026-11")), AMY);
		eq("ledger", v.ledger, TODAY_PAIR);
		eq("investor view", v.investor, TODAY_PAIR);
	});

	await R.test("E3 FROM=2026-10: a double count before FROM (Aug- and Sep-assigned loads both paying 8/31) stays double", async ({ eq }) => {
		const D = "Cy Dorn";
		const w = W.startWorld({
			env: ONCE("2026-10"),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "E301", driver: D, pickup: "2026-08-30 8:00", dropoff: "2026-08-31 18:00", assigned: "2026-08-30", done: "2026-08-31", truck: "T1" }),
				loadRow({ id: "E302", driver: D, pickup: "2026-08-31 8:00", dropoff: "2026-09-01 18:00", assigned: "2026-09-01", done: "2026-09-01", truck: "T1" }),
			],
		});
		const v = await views(w, D);
		const want = [...md("2026-08", ["2026-08-30", "2026-08-31"]), ...md("2026-09", ["2026-08-31", "2026-09-01"])];
		eq("ledger", v.ledger, want);
		eq("investor view", v.investor, want);
	});

	await R.test("E4 Three Assigned months (Sep, Oct, Nov) pay 10/1: the earliest, Sep, keeps it; Oct and Nov drop it (FROM=2026-10). Base: in all three", async ({ eq }) => {
		const D = "Dot Ernst";
		const w = W.startWorld({
			env: ONCE("2026-10"),
			now: Date.parse("2026-11-20T17:00:00Z"),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "E401", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T1" }),
				loadRow({ id: "E402", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				loadRow({ id: "E403", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-11-02", done: "2026-11-02", truck: "T1" }),
			],
		});
		const v = await views(w, D);
		const want = [...md("2026-09", ["2026-09-30", "2026-10-01"]), ...md("2026-10", ["2026-10-02"])];
		eq("ledger", v.ledger, want);
		eq("investor view", v.investor, want);
	});

	await R.test("E5 The investor view equals the ledger for the same scope and month, days and driver pay (FROM=2026-10: Sep 3 days $780, Oct 2 days $520). Base: both pay Oct 3 days", async ({ eq }) => {
		const v = await views(pairWorld(ONCE("2026-10")), AMY);
		eq("days: investor view = ledger", v.investor, v.ledger);
		eq("days: as expected", v.ledger, ONCE_PAIR);
		eq("driver pay by month, ledger and investor view", [v.ledgerPay("2026-09"), v.ledgerPay("2026-10"), v.investorPay("2026-09"), v.investorPay("2026-10")], [780, 520, 780, 520]);
	});

	await R.test("E6 Flag off: scripts/test-ledger-golden.js passes unchanged, and with only LEDGER_DAY_ONCE_FROM set (flag off) the ledger counts today's way", async ({ eq }) => {
		const golden = spawnSync(process.execPath, [path.join(W.ROOT, "scripts", "test-ledger-golden.js")], { cwd: W.ROOT, encoding: "utf8", env: { ...process.env, TZ: "UTC" }, timeout: 50000 });
		eq("test-ledger-golden.js exit code", golden.status, 0);
		const v = await views(pairWorld({ LEDGER_DAY_ONCE_FROM: "2026-10" }), AMY);
		eq("FROM set, flag off: ledger as today", v.ledger, TODAY_PAIR);
	});

	await R.test("E7 (N2) A claim is a PAID day, not a window day: a Sep load 9/28-9/30 on an ELD truck parked 9/30 pays 9/28, 9/29; an Oct load 9/29-9/30 on a truck without ELD pays 9/29, 9/30: 9/29 counts in Sep only, 9/30 stays in Oct; a remove override on 9/29 (per driver-day, every load) counts it in neither; a day the pre-dispatch rule drops is no claim either. Base: Oct keeps every day", async ({ eq }) => {
		const D = "Fay Fenn";
		const trucks = (vid) => [{ unit: "T1", driver: D, vid }, { unit: "T2", driver: D, vid: null }];
		const v71 = W.feed(100000).park("2026-09-26").drive("2026-09-28", { miles: 200 }).drive("2026-09-29", { miles: 250 }).park("2026-09-30").park("2026-10-01").pings;
		const rows = [
			loadRow({ id: "E701", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-28", done: "2026-09-30", truck: "T1" }),
			loadRow({ id: "E702", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
		];
		const main = await views(W.startWorld({ env: ONCE("2026-10"), drivers: [{ name: D }], trucks: trucks("V71"), pings: { V71: v71 }, rows }), D);
		const want = [...md("2026-09", ["2026-09-28", "2026-09-29"]), ...md("2026-10", ["2026-09-30"])];
		eq("ledger", main.ledger, want);
		eq("investor view", main.investor, want);
		const removed = await views(W.startWorld({ env: ONCE("2026-10"), drivers: [{ name: D }], trucks: trucks("V71"), pings: { V71: v71 }, rows, overrides: [{ driver: D, day: "2026-09-29", action: "remove" }] }), D);
		eq("remove override on 9/29: in neither month", removed.ledger, [...md("2026-09", ["2026-09-28"]), ...md("2026-10", ["2026-09-30"])]);
		const v72 = W.feed(200000).park("2026-09-25").drive("2026-09-27", { miles: 7.5 }).drive("2026-09-28", { miles: 200, visit: W.PICKUP })
			.drive("2026-09-29", { miles: 250 }).park("2026-09-30").park("2026-10-01").pings;
		const pre = await views(W.startWorld({
			env: { ...ONCE("2026-10"), PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-09" },
			drivers: [{ name: D }], trucks: trucks("V72"), pings: { V72: v72 }, coords: { E711: W.PICKUP },
			rows: [
				loadRow({ id: "E711", driver: D, pickup: "2026-09-27 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-27", done: "2026-09-30", truck: "T1" }),
				loadRow({ id: "E712", driver: D, pickup: "2026-09-27 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
			],
			status: [s("E711", "Dispatched", "2026-09-28 14:00:00", "dispatch", "super_admin")],
		}), D);
		eq("pre-dispatch drops the Sep load's idle 9/27: Oct keeps 9/27 and 9/30", pre.ledger, [...md("2026-09", ["2026-09-28", "2026-09-29"]), ...md("2026-10", ["2026-09-27", "2026-09-30"])]);
	});

	await R.test("E8 Start-up: FROM at or before the latest closed month logs one notice built like fromMonthClosedWarning() (none when FROM is later); FROM unset or not a month leaves the rule off with one warning naming LEDGER_DAY_ONCE_FROM, never its value; the switch-on dry run refuses (exit 2) a FROM that is already closed", async ({ eq, ok }) => {
		const notices = (w) => w.warnings.filter((x) => /LEDGER_DAY_ONCE_FROM/.test(x) && /latest closed month/.test(x));
		const closed = pairWorld(ONCE("2026-10"), { locks: ["2026-09", "2026-10"] });
		const n = notices(closed);
		eq("FROM 2026-10, October closed: one notice", n.length, 1);
		ok("the notice names the latest closed month and says never to change FROM once the rule has run", /2026-10/.test(n[0] || "") && /never change LEDGER_DAY_ONCE_FROM/i.test(n[0] || ""), n[0]);
		eq("FROM 2026-11, October closed: no notice", notices(pairWorld(ONCE("2026-11"), { locks: ["2026-09", "2026-10"] })).length, 0);
		for (const [label, from] of [["unset", undefined], ["empty", ""], ["not a month (2026-13)", "2026-13"], ["a day (2026-10-01)", "2026-10-01"], ["a word", "October"]]) {
			const w = pairWorld(ONCE(from));
			const v = await views(w, AMY);
			eq(`FROM ${label}: the rule is off`, v.ledger, TODAY_PAIR);
			const named = w.warnings.filter((x) => /LEDGER_DAY_ONCE_FROM/.test(x));
			eq(`FROM ${label}: one warning naming LEDGER_DAY_ONCE_FROM`, named.length, 1);
			if (from) ok(`FROM ${label}: the warning does not print the value`, !named.some((x) => x.includes(from)), JSON.stringify(named));
		}
		const sep = pairWorld(ONCE("2026-09"), { locks: ["2026-09"] });
		const copy = W.saveCopy(sep, ONCE("2026-09"));
		const r = W.runScript("scripts/ledger-day-once-dry-run.js", [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--from=2026-09", "--json"]);
		eq("dry run with FROM 2026-09, September closed: exit 2", r.code, 2);
		ok("…and says why", r.missing ? false : /closed|finalized|locked/i.test(r.stderr + r.stdout), (r.stderr || r.stdout).slice(0, 200));
	});

	await R.test("E9 The 4b dry run lists each dropped day with both loads, and marks the dropped day missing from September's frozen items (9/30) apart from the one September settled (9/29); a report only: the ledger's numbers are identical with and without frozen items", async ({ eq, ok }) => {
		const D = "Gil Hart";
		const build = (frozen) => {
			const w = W.startWorld({
				env: ONCE("2026-10"),
				drivers: [{ name: D }],
				locks: ["2026-09"],
				rows: [
					loadRow({ id: "E901", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-28", done: "2026-09-30", truck: "T1" }),
					loadRow({ id: "E902", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				],
			});
			if (frozen) {
				const ins = w.db.prepare(`INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at)
					VALUES ('2026-09', 5, 'driver_pay', ?, 26000, 'E901', ?, 'T1', 'fixed', 'freeze-sep', '2026-10-08T05:00:00.000Z')`);
				for (const day of ["2026-09-28", "2026-09-29"]) ins.run(day, norm(D));
			}
			return w;
		};
		const withFrozen = build(true);
		const a = await views(withFrozen, D);
		const b = await views(build(false), D);
		eq("the ledger's driver-pay items, with and without frozen items", a.led.pay.map((i) => [i.month, i.day, i.cents]), b.led.pay.map((i) => [i.month, i.day, i.cents]));
		const copy = W.saveCopy(withFrozen, ONCE("2026-10"));
		const r = W.runScript("scripts/ledger-day-once-dry-run.js", [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--from=2026-10", "--json"]);
		eq("dry run: exit 0 with JSON", [r.code, !!r.json], [0, true]);
		const entry = (day) => W.objects(r.json).find((o) => W.scalars(o).includes(day) && JSON.stringify(o).includes("E901") && JSON.stringify(o).includes("E902"));
		const e29 = entry("2026-09-29");
		const e30 = entry("2026-09-30");
		ok("9/29 is listed with both loads", !!e29, (r.stderr || r.stdout).slice(0, 200));
		ok("9/30 is listed with both loads", !!e30, (r.stderr || r.stdout).slice(0, 200));
		const marks = (o) => Object.entries(o || {}).filter(([k]) => /frozen|settled|missing/i.test(k));
		ok("9/30 is marked apart from 9/29 (missing from September's frozen items)", !!e29 && !!e30 && marks(e30).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(e29[k])), JSON.stringify([e29, e30]));
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
