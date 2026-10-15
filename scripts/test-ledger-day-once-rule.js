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
 *   - R7: .env.example documents both settings, off;
 *   - R8: unsettledDays() and frozenDriverDays(): the driver-days the rule
 *     decides against a closed month's settled record (frozen items), report only;
 *   - R9: the daily integrity check's check 7 on the real payout ledger
 *     (computeFleetLedger() lifted by scripts/lib/ledger-world.js): each such
 *     driver-day named once, then counted in one note; a ledger that fails skips
 *     only check 7; with the rule off nothing runs and no table is created;
 *   - R10: scopes: a day two owners' loads pay stays in both investors' ledgers
 *     (payouts and Financials are per owner), and the company's own ledger
 *     drops its repeat.
 * The paths run lifted from server.js (scripts/lib/work-days-world.js) for
 * investor 5 unless a case says otherwise. Made-up data only. Pure: no server,
 * no app.db, no network; temporary copies live under the temp directory.
 * Run: node scripts/test-ledger-day-once-rule.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const { buildLedgerWorld } = require("./lib/ledger-world");
const dayOnce = require("../lib/ledger-day-once");
const ic = require("../lib/integrity-check");

const periodDef = W.SRC.match(/\nconst EXPENSE_PERIOD_EXPR =\s*("(?:[^"\\]|\\.)*");/);
if (!periodDef) { console.error("SETUP FAILED: EXPENSE_PERIOD_EXPR not found in server.js"); process.exit(1); }
const EXPENSE_PERIOD_EXPR = JSON.parse(periodDef[1]);

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

	await R.test("R8 unsettledDays(): a day left out of an open month that a closed month's frozen items never paid, and an open month's day a closed month already paid; nothing for a settled day, an open or unfrozen kept month, a closed dropped month, a percentage driver or a month before FROM", async ({ eq }) => {
		const db = new W.Database(":memory:");
		db.exec("CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT, owner_id INTEGER, kind TEXT, day TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT '', load_id TEXT NOT NULL DEFAULT '')");
		const ins = db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, day, driver, load_id) VALUES (?, ?, ?, ?, ?, ?)");
		ins.run("2026-09", 5, "driver_pay", "2026-09-29", "Gil Hart", "S1");
		ins.run("2026-09", 5, "driver_pay", "2026-09-27", "kay lund", "S2");
		ins.run("2026-09", 5, "revenue", "2026-09-01", "", "S1");
		ins.run("2026-08", 6, "fixed", "", "", "");
		const frozen = dayOnce.frozenDriverDays(db);
		eq("frozen months by owner", [frozen.hasMonth("2026-09", 5), frozen.hasMonth("2026-09", 6), frozen.hasMonth("2026-08", 6)], [true, false, true]);
		eq("a frozen driver-day, any letter case", [frozen.holds("2026-09", 5, "gil hart", "2026-09-29"), frozen.holds("2026-09", 5, "gil hart", "2026-09-30")], [true, false]);
		eq("no table: nothing frozen", dayOnce.frozenDriverDays(new W.Database(":memory:")).hasMonth("2026-09", 5), false);
		const closed = new Set(["2026-08", "2026-09"]);
		const drop = (o) => ({ driver: "gil hart", day: "2026-09-30", month: "2026-10", keptMonth: "2026-09", payType: "fixed", loadId: "O1", keptLoadId: "S1", ...o });
		const scopes = [
			{
				ownerId: 5,
				dayOnceDrops: [drop({}), drop({ day: "2026-09-29" }), drop({ month: "2026-11", keptMonth: "2026-10" }), drop({ month: "2026-09", keptMonth: "2026-08" }), drop({ day: "2026-09-28", payType: "percentage" })],
				items: [
					{ kind: "driver_pay", month: "2026-10", day: "2026-09-27", driver: "kay lund", loadId: "O2", payType: "fixed" },
					{ kind: "driver_pay", month: "2026-10", day: "2026-10-01", driver: "kay lund", loadId: "O2", payType: "fixed" },
					{ kind: "revenue", month: "2026-10", day: "2026-09-27", driver: "kay lund" },
				],
			},
			{ ownerId: 6, dayOnceDrops: [drop({})], items: [] },
		];
		const rows = (list) => list.map((f) => [f.kind, f.ownerId, f.driver, f.day, f.month, f.otherMonth, f.loadId, f.otherLoadId]);
		eq("FROM 2026-10", rows(dayOnce.unsettledDays({ fromMonth: "2026-10", scopes, frozen, closed })), [
			["dropped", 5, "gil hart", "2026-09-30", "2026-10", "2026-09", "O1", "S1"],
			["kept", 5, "kay lund", "2026-09-27", "2026-10", "2026-09", "O2", "S2"],
		]);
		eq("FROM 2026-11: an October day is before FROM", rows(dayOnce.unsettledDays({ fromMonth: "2026-11", scopes, frozen, closed })), [["dropped", 5, "gil hart", "2026-09-30", "2026-10", "2026-09", "O1", "S1"]]);
		eq("no FROM, or closed months unreadable: nothing", [dayOnce.unsettledDays({ fromMonth: null, scopes, frozen, closed }).length, dayOnce.unsettledDays({ fromMonth: "2026-10", scopes, frozen, closed: null }).length], [0, 0]);
	});

	await R.test("R9 Check 7 of the daily integrity check, rule on: names each driver-day decided against September's settled record once (9/30 left out but never settled; 9/27 paid again), then counts them in one note; a ledger that fails skips only check 7; rule off: nothing runs, no table", async ({ eq, ok }) => {
		const G = "Gil Hart";
		const K = "Kay Lund";
		const w = W.startWorld({
			env: ONCE,
			drivers: [{ name: G }, { name: K }],
			locks: ["2026-09"],
			rows: [
				W.loadRow({ id: "R901", driver: G, pickup: "2026-09-28 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-28", done: "2026-09-30", truck: "T1" }),
				W.loadRow({ id: "R902", driver: G, pickup: "2026-09-29 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				W.loadRow({ id: "R903", driver: K, pickup: "2026-09-28 8:00", dropoff: "2026-09-28 18:00", assigned: "2026-09-28", done: "2026-09-28", truck: "T2" }),
				W.loadRow({ id: "R904", driver: K, pickup: "2026-09-27 8:00", dropoff: "2026-09-28 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
			],
		});
		// September as it settled: Gil's 9/28 and 9/29, and Kay's 9/27 and 9/28
		// (Kay's September window has moved since: today it pays 9/28 only).
		const ins = w.db.prepare(`INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at)
			VALUES ('2026-09', 5, 'driver_pay', ?, 26000, ?, ?, ?, 'fixed', 'freeze-sep', '2026-10-08T05:00:00.000Z')`);
		for (const day of ["2026-09-28", "2026-09-29"]) ins.run(day, "R901", norm(G), "T1");
		for (const day of ["2026-09-27", "2026-09-28"]) ins.run(day, "R903", norm(K), "T2");
		const copy = W.saveCopy(w, ONCE);
		const lw = buildLedgerWorld({ root: W.ROOT, dbPath: copy.db, readonly: true, sheetData: JSON.parse(fs.readFileSync(copy.values, "utf8")), envFile: copy.envFile });
		const jt = { headers: [...W.HEADERS], data: w.rows.map((r) => ({ ...r })) };
		const quiet = { log() {}, error() {} };
		const run = (db, opts) => ic.runIntegrityCheck({
			db, now: new Date("2026-10-20T13:00:00Z"), write: true, readJobTracking: async () => jt, expensePeriodExpr: EXPENSE_PERIOD_EXPR, to: "", log: quiet,
			dayOnceFrom: "2026-10", readFleetLedger: () => lw.api.computeFleetLedger(), ...opts,
		});
		try {
			const first = await run(w.db, {});
			eq("first run: the two driver-days", first.report.dayOnce.days.map((f) => [f.kind, f.driver, f.day, f.month, f.otherMonth, f.loadId, f.otherLoadId]), [
				["dropped", "gil hart", "2026-09-30", "2026-10", "2026-09", "R902", "R901"],
				["kept", "kay lund", "2026-09-27", "2026-10", "2026-09", "R904", "R903"],
			]);
			ok("the report names them in plain words", first.report.text.includes("2026-09-30, driver gil hart (owner 5): left out of 2026-10 (load R902) because 2026-09's live figures count it (load R901), but 2026-09's settled record never paid it, so no month pays this day.")
				&& first.report.text.includes("2026-09-27, driver kay lund (owner 5): paid in 2026-10 (load R904) although 2026-09 already settled it (load R903), so it is paid twice."), first.report.text);
			ok("the log line counts them", /2 ledger day-once driver-days against a closed month's settled record/.test(first.logLine), first.logLine);
			eq("recorded once", w.db.prepare(`SELECT owner_id, driver, day, kind, month FROM ${ic.DAY_ONCE_TABLE} ORDER BY day`).all().map((r) => [r.owner_id, r.driver, r.day, r.kind, r.month]), [
				[5, "kay lund", "2026-09-27", "kept", "2026-10"],
				[5, "gil hart", "2026-09-30", "dropped", "2026-10"],
			]);
			const second = await run(w.db, {});
			eq("second run: none named again, both counted", [second.report.dayOnce.days.length, second.report.dayOnce.reportedOpen], [0, 2]);
			ok("...in one note", second.report.notes.includes("2 driver-days the ledger day-once rule decides against a closed month's settled record, reported earlier, are still as reported."), second.report.notes);
			const broken = await run(w.db, { write: false, readFleetLedger: async () => { throw new Error("the sheet is down"); } });
			ok("a ledger that fails: the run completes and says check 7 was not checked", broken.ok === true && broken.report.notes.includes("Ledger day-once days were not checked: the payout ledger could not be computed (the sheet is down)."), broken.report.notes);
			const fresh = W.startWorld({ drivers: [{ name: G }], rows: [] });
			const off = await run(fresh.db, { dayOnceFrom: null, readFleetLedger: () => { throw new Error("must not be called with the rule off"); } });
			ok("rule off: check 7 does not run, the log line does not mention it, no table is created", off.ok === true && !off.report.dayOnce.checked && !/day-once/.test(off.logLine) && !W.hasTable(fresh.db, ic.DAY_ONCE_TABLE), off.logLine);
		} finally {
			lw.db.close();
		}
	});

	await R.test("R10 Scopes, rule on: Hal's 9/30, paid by owner 5's September load and owner 6's October load, stays in both investors' ledgers (Financials and owner 6's payout ledger agree); in the company's ledger Cara's October repeat of 9/30 goes", async ({ eq }) => {
		const H = "Hal Moss";
		const C = "Cara Pike";
		const w = W.startWorld({
			env: ONCE,
			drivers: [{ name: H }, { name: C, carrier: "" }],
			trucks: [{ unit: "T1", driver: H }, { unit: "T6", driver: H, owner: 6 }, { unit: "C9", driver: C, owner: 0 }],
			rows: [
				W.loadRow({ id: "R1001", driver: H, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1", owner: "5" }),
				W.loadRow({ id: "R1002", driver: H, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T6", owner: "6" }),
				W.loadRow({ id: "R1003", driver: C, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "C9", owner: "0" }),
				W.loadRow({ id: "R1004", driver: C, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "C9", owner: "0" }),
			],
		});
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (6, 'inv6', 'x', 'Investor', 'Beta Haul')").run();
		w.db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (6, 'Ike Investor', 'Beta Haul')").run();
		const copy = W.saveCopy(w, ONCE);
		const lw = buildLedgerWorld({ root: W.ROOT, dbPath: copy.db, readonly: true, sheetData: JSON.parse(fs.readFileSync(copy.values, "utf8")), envFile: copy.envFile });
		try {
			const fleet = await lw.api.computeFleetLedger();
			const scope = (id) => fleet.scopes.find((s) => s.ownerId === id) || { items: [], dayOnceDrops: [] };
			const paid = (items, driver) => W.monthDays(items.filter((i) => i.kind === "driver_pay" && i.day), norm(driver));
			eq("owner 5 (Financials scope): Hal's September", paid(scope(5).items, H), ["2026-09 2026-09-29", "2026-09 2026-09-30"]);
			eq("owner 6 (Financials scope): Hal's October keeps 9/30", paid(scope(6).items, H), ["2026-10 2026-09-30", "2026-10 2026-10-01"]);
			eq("owner 6's payout ledger: the same", paid((await W.ledger(w, 6)).pay, H), ["2026-10 2026-09-30", "2026-10 2026-10-01"]);
			eq("the company: Cara's October repeat of 9/30 goes", paid(scope(0).items, C), ["2026-09 2026-09-29", "2026-09 2026-09-30", "2026-10 2026-10-01"]);
			eq("the company's drop names both loads", scope(0).dayOnceDrops.map((d) => [d.driver, d.day, d.month, d.keptMonth, d.loadId, d.keptLoadId]), [["cara pike", "2026-09-30", "2026-10", "2026-09", "R1004", "R1003"]]);
			eq("no investor scope drops a day", [scope(5).dayOnceDrops.length, scope(6).dayOnceDrops.length], [0, 0]);
		} finally {
			lw.db.close();
		}
	});

	await R.test("R11 The dry run names nobody without --names: drivers become \"driver 1\", \"driver 2\" (one label per driver, so rows still group), investors stay owner ids; --names adds both", async ({ eq, ok }) => {
		const G = "Gil Hart";
		const P = "Pia Rook";
		const w = W.startWorld({
			env: ONCE,
			drivers: [{ name: G }, { name: P }],
			rows: [
				W.loadRow({ id: "R1101", driver: G, pickup: "2026-09-28 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-28", done: "2026-09-30", truck: "T1" }),
				W.loadRow({ id: "R1102", driver: G, pickup: "2026-09-29 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				W.loadRow({ id: "R1103", driver: P, pickup: "2026-09-30 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-30", done: "2026-09-30", truck: "T2" }),
				W.loadRow({ id: "R1104", driver: P, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
			],
		});
		const copy = W.saveCopy(w, ONCE);
		const args = [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--from=2026-10", "--json"];
		const plain = W.runScript("scripts/ledger-day-once-dry-run.js", args);
		const named = W.runScript("scripts/ledger-day-once-dry-run.js", [...args, "--names"]);
		eq("both runs: exit 0 with JSON", [plain.code, !!plain.json, named.code, !!named.json], [0, true, 0, true]);
		const drivers = (r) => [...new Set(((r.json && r.json.droppedDays) || []).map((d) => d.driver))];
		eq("without --names: one label per driver", drivers(plain), ["driver 1", "driver 2"]);
		eq("...the same labels on the driver-month rows", [...new Set(((plain.json && plain.json.driverMonths) || []).map((d) => d.driver))], ["driver 1", "driver 2"]);
		ok("...and no driver's name, nor the investor's, anywhere in the output", !/gil hart|pia rook|ivy investor|acme carrier/i.test(plain.stdout), plain.stdout.slice(0, 300));
		eq("with --names: the drivers", drivers(named), ["gil hart", "pia rook"]);
		ok("...and the investor (as listSettlableInvestors() names it)", ((named.json && named.json.investorMonths) || []).some((i) => /^(Ivy Investor|Acme Carrier)$/.test(i.investor || "")), JSON.stringify(named.json && named.json.investorMonths));
		const text = W.runScript("scripts/ledger-day-once-dry-run.js", args.filter((a) => a !== "--json"));
		ok("the text report labels drivers too", text.code === 0 && /driver 1/.test(text.stdout) && !/gil hart|pia rook/i.test(text.stdout), text.stdout.slice(0, 300));
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
