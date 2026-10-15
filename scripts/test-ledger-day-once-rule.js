#!/usr/bin/env node
/**
 * lib/ledger-day-once.js on its own, and two money edges of the ledger day-once
 * rule the plan's cases (scripts/test-ledger-day-once.js) do not reach:
 *   - R1-R4: the settings (exactly "true" turns it on; FROM must be a month; the
 *     warning names the setting, never its value), the closed-month notice, the
 *     latest closed month, and dropRepeatedDays() (earliest month wins, months
 *     before FROM untouched, an emptied month keeps its empty set, idempotent);
 *   - R5: a percentage driver whose month loses every day is still paid that
 *     month's percentage of revenue, in the ledger and the investor view;
 *   - R6: an admin-added day is a paid day like a load's: an added day a load in
 *     an earlier month already pays leaves the later month, and a load's day an
 *     earlier added day already pays leaves the later month too;
 *   - R7: .env.example documents both settings, off.
 * The paths run lifted from server.js (scripts/lib/work-days-world.js) for
 * investor 5. Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/test-ledger-day-once-rule.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const dayOnce = require("../lib/ledger-day-once");

const ONCE = { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-10" };
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const sets = (o) => Object.fromEntries(Object.entries(o).map(([drv, m]) => [drv, Object.fromEntries(Object.entries(m).map(([mk, s]) => [mk, [...s].sort()]))]));
const days = (obj) => Object.fromEntries(Object.entries(obj).map(([drv, m]) => [drv, Object.fromEntries(Object.entries(m).map(([mk, list]) => [mk, new Set(list)]))]));

async function monthPay(world, driver) {
	const led = await W.ledger(world);
	const inv = await W.investorDays(world);
	const pick = (months, mk) => { const m = months.find((x) => x.month === mk); return m ? Math.round(m.driverPay * 100) / 100 : 0; };
	const invDays = (mk) => {
		const m = inv.months.find((x) => x.month === mk);
		const det = m && m.driverDetails && m.driverDetails[norm(driver)];
		return det ? det.activeDays : 0;
	};
	return {
		ledgerDays: W.monthDays(led.pay.filter((i) => i.day), norm(driver)),
		ledgerPay: (mk) => pick(led.monthlyEarnings, mk),
		investorPay: (mk) => pick(inv.months, mk),
		investorDays: invDays,
		percentDays: (mk) => { const it = led.pay.find((i) => i.month === mk && i.payType === "percentage" && i.driver === norm(driver)); return it ? it.days : null; },
	};
}

const R = W.createRunner("Ledger day-once: lib/ledger-day-once.js and the money edges");

(async () => {
	await R.test("R1 Settings: on only when LEDGER_DAY_ONCE_ENABLED is exactly \"true\" and LEDGER_DAY_ONCE_FROM is a month; a bad FROM warns once, naming the setting and not its value", async ({ eq, ok }) => {
		eq("on, FROM 2026-10", dayOnce.ruleFromEnv(ONCE), "2026-10");
		eq("on, FROM with edge spaces", dayOnce.ruleFromEnv({ LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: " 2026-10 " }), "2026-10");
		for (const v of [undefined, "", "false", "1", "yes", "on", "TRUE", " true", "true "]) {
			const warned = [];
			eq(`flag ${JSON.stringify(v)}: off`, dayOnce.ruleFromEnv({ LEDGER_DAY_ONCE_ENABLED: v, LEDGER_DAY_ONCE_FROM: "2026-10" }, (m) => warned.push(m)), null);
			eq(`flag ${JSON.stringify(v)}: no warning`, warned.length, 0);
		}
		eq("no environment: off", dayOnce.ruleFromEnv(undefined), null);
		for (const from of [undefined, "", "2026-13", "2026-00", "2026-10-01", "October", "26-10"]) {
			const warned = [];
			eq(`FROM ${JSON.stringify(from)}: off`, dayOnce.ruleFromEnv({ LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: from }, (m) => warned.push(m)), null);
			eq(`FROM ${JSON.stringify(from)}: one warning`, warned.length, 1);
			ok(`FROM ${JSON.stringify(from)}: the warning names the setting, not the value`, /LEDGER_DAY_ONCE_FROM/.test(warned[0] || "") && (!from || !warned[0].includes(from)), warned[0]);
		}
		eq("a request-time read (no warn given) never throws on a bad FROM", dayOnce.ruleFromEnv({ LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "x" }), null);
	});

	await R.test("R2 The start-up notice: only when FROM is at or before the latest closed month, naming it and saying never to change FROM", async ({ eq, ok }) => {
		eq("FROM after the latest closed month", dayOnce.fromMonthClosedWarning("2026-10", "2026-09"), null);
		eq("nothing closed", dayOnce.fromMonthClosedWarning("2026-10", ""), null);
		eq("no FROM", dayOnce.fromMonthClosedWarning(null, "2026-09"), null);
		for (const [from, latest] of [["2026-10", "2026-10"], ["2026-09", "2026-10"]]) {
			const msg = dayOnce.fromMonthClosedWarning(from, latest);
			ok(`FROM ${from}, latest closed ${latest}: the notice`, /LEDGER_DAY_ONCE_FROM is at or before/.test(msg || "") && msg.includes(latest) && /latest closed month/.test(msg) && /Never change LEDGER_DAY_ONCE_FROM/.test(msg), msg);
		}
	});

	await R.test("R3 The latest closed month: the latest locked YYYY-MM period; open rows and other periods ignored; no table reads as none", async ({ eq }) => {
		const db = new W.Database(":memory:");
		eq("no period_locks table", dayOnce.latestClosedMonth(db), "");
		db.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT)");
		eq("no rows", dayOnce.latestClosedMonth(db), "");
		const ins = db.prepare("INSERT INTO period_locks (period, status) VALUES (?, ?)");
		ins.run("2026-08", "locked");
		ins.run("2026-09", "locked");
		ins.run("2026-10", "open");
		ins.run("2026-W40", "locked");
		eq("latest locked month", dayOnce.latestClosedMonth(db), "2026-09");
		db.close();
	});

	await R.test("R4 dropRepeatedDays(): earliest month wins; months before FROM untouched; an emptied month keeps an empty set; dayLoads entries go too; a second run drops nothing", async ({ eq }) => {
		const input = () => days({
			amy: { "2026-08": ["2026-08-31"], "2026-09": ["2026-08-31", "2026-09-30"], "2026-10": ["2026-09-30", "2026-10-01"], "2026-11": ["2026-10-01", "2026-11-02"] },
			bo: { "2026-10": ["2026-09-30"] },
			cy: { "2026-09": ["2026-09-29"], "2026-10": ["2026-09-29"] },
			dee: { "2026-08": ["2026-08-31"], "2026-09": ["2026-08-31"] },
		});
		const untouched = input();
		eq("no FROM: nothing dropped", dayOnce.dropRepeatedDays(untouched, null), []);
		eq("no FROM: sets as given", sets(untouched), sets(input()));
		const m = input();
		const loads = { cy: { "2026-09": { "2026-09-29": ["C1"] }, "2026-10": { "2026-09-29": ["C2"] } } };
		const drops = dayOnce.dropRepeatedDays(m, "2026-10", loads);
		eq("the drops", drops, [
			{ driver: "amy", day: "2026-09-30", month: "2026-10", keptMonth: "2026-09" },
			{ driver: "amy", day: "2026-10-01", month: "2026-11", keptMonth: "2026-10" },
			{ driver: "cy", day: "2026-09-29", month: "2026-10", keptMonth: "2026-09" },
		]);
		eq("the sets", sets(m), {
			amy: { "2026-08": ["2026-08-31"], "2026-09": ["2026-08-31", "2026-09-30"], "2026-10": ["2026-10-01"], "2026-11": ["2026-11-02"] },
			bo: { "2026-10": ["2026-09-30"] },
			cy: { "2026-09": ["2026-09-29"], "2026-10": [] },
			dee: { "2026-08": ["2026-08-31"], "2026-09": ["2026-08-31"] },
		});
		eq("dayLoads lose the dropped day only", loads, { cy: { "2026-09": { "2026-09-29": ["C1"] }, "2026-10": {} } });
		const before = sets(m);
		eq("second run: nothing dropped", dayOnce.dropRepeatedDays(m, "2026-10", loads), []);
		eq("second run: sets unchanged", sets(m), before);
	});

	await R.test("R5 A percentage driver whose October loses its only day (9/30, paid in September) is still paid 30% of October's revenue, in the ledger and the investor view; the day count drops from 1 to 0", async ({ eq }) => {
		const P = "Pat Quill";
		const build = (env) => W.startWorld({
			env,
			drivers: [{ name: P, payType: "percentage", payPct: 30 }],
			rows: [
				W.loadRow({ id: "R501", driver: P, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1" }),
				W.loadRow({ id: "R502", driver: P, pickup: "2026-09-30 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T1" }),
			],
		});
		const off = await monthPay(build({}), P);
		const on = await monthPay(build(ONCE), P);
		eq("October pay, ledger and investor view: flag off then on", [off.ledgerPay("2026-10"), off.investorPay("2026-10"), on.ledgerPay("2026-10"), on.investorPay("2026-10")], [600, 600, 600, 600]);
		eq("September pay unchanged", [off.ledgerPay("2026-09"), on.ledgerPay("2026-09")], [600, 600]);
		eq("October days in the ledger item: off then on", [off.percentDays("2026-10"), on.percentDays("2026-10")], [1, 0]);
		eq("October days in the investor view: off then on", [off.investorDays("2026-10"), on.investorDays("2026-10")], [1, 0]);
	});

	await R.test("R6 Added days are paid days: an added 10/1 that a September load already pays leaves October; a load's 9/30 that an added September day already pays leaves October", async ({ eq }) => {
		const A = "Ann Ames";
		const B = "Ben Boyd";
		const build = (env) => W.startWorld({
			env,
			drivers: [{ name: A }, { name: B }],
			rows: [
				W.loadRow({ id: "R601", driver: A, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T1" }),
				W.loadRow({ id: "R602", driver: B, pickup: "2026-09-30 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
			],
			overrides: [{ driver: A, day: "2026-10-01", action: "add" }, { driver: B, day: "2026-09-30", action: "add" }],
		});
		const offA = await monthPay(build({}), A);
		const onA = await monthPay(build(ONCE), A);
		eq("Ann, ledger days: flag off", offA.ledgerDays, ["2026-09 2026-09-30", "2026-09 2026-10-01", "2026-10 2026-10-01"]);
		eq("Ann, ledger days: flag on", onA.ledgerDays, ["2026-09 2026-09-30", "2026-09 2026-10-01"]);
		eq("Ann, October active days, investor view: off then on", [offA.investorDays("2026-10"), onA.investorDays("2026-10")], [1, 0]);
		const offB = await monthPay(build({}), B);
		const onB = await monthPay(build(ONCE), B);
		eq("Ben, ledger days: flag off", offB.ledgerDays, ["2026-09 2026-09-30", "2026-10 2026-09-30"]);
		eq("Ben, ledger days: flag on", onB.ledgerDays, ["2026-09 2026-09-30"]);
		eq("Ben, October active days, investor view: off then on", [offB.investorDays("2026-10"), onB.investorDays("2026-10")], [1, 0]);
		eq("October driver pay (both drivers), ledger = investor view: off then on", [offA.ledgerPay("2026-10"), offA.investorPay("2026-10"), onA.ledgerPay("2026-10"), onA.investorPay("2026-10")], [520, 520, 0, 0]);
	});

	await R.test("R7 .env.example documents LEDGER_DAY_ONCE_ENABLED, off, and LEDGER_DAY_ONCE_FROM, commented with no value", async ({ ok }) => {
		const example = fs.readFileSync(path.join(W.ROOT, ".env.example"), "utf8");
		ok("the flag, off", /\nLEDGER_DAY_ONCE_ENABLED=false\n/.test(example));
		ok("FROM, commented with no value", /\n# LEDGER_DAY_ONCE_FROM=\n/.test(example));
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
