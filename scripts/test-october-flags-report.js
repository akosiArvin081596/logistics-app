#!/usr/bin/env node
/**
 * The combined October what-would-change report (the user's standing rule,
 * 2026-10-16): before the B12 (TRIP_WORK_DAYS), daily-rate (DRIVER_RATE_ONLY)
 * or B4 (drop-trailer Ready date) flag goes on, one read-only report for
 * October from one read of the data: each change alone and all three together,
 * per driver October pay, per investor October payable, and every issued
 * invoice and draft that would differ; closed months unchanged.
 * scripts/october-flags-report.js; written before it, so every case fails
 * first ("the script does not exist").
 *
 * Made-up data only. Investor 5 (split 50%) owns T1 ($150 a day on the truck)
 * and T2 ($300). Cal Burke has no rate of his own and drives T1; Ana Moss has
 * her own $350 and drives T2.
 *   H901  Cal, September (closed 10/15, frozen), $100: a $100 loss share
 *         carried into October
 *   H902  Cal, 10/5-10/7, At Shipper 10/4 09:00 ET: B12 adds 10/4
 *   A902  Ana, drop trailer, delivered: stored pickup (the Drop date) 10/5,
 *         Ready 10/7, drop-off 10/8
 *   D903  Cal, drop trailer, dispatched (in flight), no broker invoice draft
 *   D904  Ana, drop trailer, dispatched, with a broker invoice draft
 *   W40   Cal's invoice Submitted ($450), Ana's a Draft ($1,400)
 * Expected October (payout ledger; investor 5's payable after the $100
 * carried in):
 *                     Cal            Ana           investor 5
 *   today             3 days $450    4 days $1,400   $975
 *   B12               4 days $600    $1,400          $900
 *   daily rate        3 days $750    $1,400          $825
 *   B4 as designed    = today
 *   B4 applied        $450           2 days $700     $1,325
 *   all three         4 days $1,000  2 days $700     $1,050
 *   all, B4 designed  $1,000         $1,400          $700
 *
 * The figure cases run the script's run() in this process (a clock stopped at
 * Fri 10/16 1 PM Eastern, and a sheet loader that counts its calls); the exit
 * code and read-only cases run it as the command the server runs. Pure: no
 * server, no app.db, no network.
 *
 * Run: node scripts/test-october-flags-report.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
const M = require("./lib/money-plans-world");
const { loadRow, et } = M;

const SCRIPT = "scripts/october-flags-report.js";
const CAL = "Cal Burke";
const ANA = "Ana Moss";
const W40 = "2026-10-09"; // the week Sat 10/3 - Fri 10/9
const NOW = Date.parse("2026-10-16T17:00:00Z"); // Fri 10/16, 1 PM Eastern
// Production's money settings as its .env sets them (the day-once rule on).
const ENV = { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-10" };
const READY = { A902: "2026-10-07", D903: "2026-10-20", D904: "2026-10-21", H901: "2026-09-16" };
const s = (lid, status, wall) => [lid, status, "manual", et(wall), ""];

async function fixture({ lockOctober = false } = {}) {
	const w = M.startWorld({
		env: ENV, now: NOW,
		drivers: [{ name: CAL, payDaily: 0 }, { name: ANA, payDaily: 350 }],
		trucks: [{ unit: "T1", driver: CAL, payDaily: 150 }, { unit: "T2", driver: ANA, payDaily: 300 }],
		rows: [
			loadRow({ id: "H901", driver: CAL, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1", payment: "$100.00" }),
			loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "A902", driver: ANA, pickup: "2026-10-05 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-05", done: "2026-10-08", truck: "T2" }),
			loadRow({ id: "D903", driver: CAL, pickup: "2026-10-19 8:00", dropoff: "2026-10-21 18:00", assigned: "2026-10-16", done: "", status: "Dispatched", truck: "T1" }),
			loadRow({ id: "D904", driver: ANA, pickup: "2026-10-20 8:00", dropoff: "2026-10-22 18:00", assigned: "2026-10-16", done: "", status: "Dispatched", truck: "T2" }),
		],
		status: [s("H902", "At Shipper", "2026-10-04 09:00"), s("H902", "Delivered", "2026-10-07 17:00")],
	});
	await M.freezeAndLock(w, "2026-09", "2026-10-15T05:00:00.000Z");
	w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-09', 0, '2026-10-15', 'paid')").run();
	w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total) VALUES ('D904', 'INV-1001', '$2,000.00')").run();
	const cal = await M.generate(w, CAL, W40);
	const ana = await M.generate(w, ANA, W40);
	if (!cal.invoice || !ana.invoice) throw new Error(`W40 invoices not made (${cal.status}, ${ana.status})`);
	w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(cal.invoice.id);
	if (lockOctober) M.lockMonth(w.db, "2026-10", "2026-10-16T05:00:00.000Z");
	return { w, cal: cal.invoice.invoice_number, ana: ana.invoice.invoice_number };
}

// The B12 invoice cases (review M1, M2, L6), on a second made-up world: $260 a
// day unless named, each driver on his own truck of investor 5's.
//   Dot Ellis  W39 Submitted (made 10/2 while F702 was in transit); F702,
//              Assigned 10/1, At Shipper 9/30, delivered 10/3; September closed
//              10/15: B12 adds 10/1-10/2 on a correction Draft (the week
//              touches September) and refuses 9/30 (a closed month)
//   Eve Park   W40 Approved; At Shipper 10/4: B12 adds 10/4 on a correction Draft
//   Gus Hale   W40 Submitted with a $300 adjustment; At Shipper 10/4: B12
//              does not add 10/4 (the adjustment may already pay it)
//   Hal Ives   $350 now, $300 in pay_rate_history until 10/10; W40 a Draft at
//              $350: regenerated under B12 it prices 10/5-10/6 at $300
//   Ike Moe    a percentage driver (30%): his October pay moves in no scenario
const DOT = "Dot Ellis";
const EVE = "Eve Park";
const GUS = "Gus Hale";
const HAL = "Hal Ives";
const IKE = "Ike Moe";
// `deletedDraft`: a correction Draft for Dot's W39 naming 10/1 and 10/2 was made
// and then deleted by a Super Admin (as "not valid") before F702 was delivered:
// the switch-on carries neither day again (2026-10-21 item 2, the MR 10/2 shape).
// `twoMonths` (with deletedDraft; review L1): Dot has no rate of his own and
// drives T1 at the truck's $150, and a second load, F703, Assigned 9/30 (a
// September load the trip rule does not cover), also spans 10/1-10/2: with
// both changes on, F702's October days price at $250 and F703's September
// ones at $150, so the switch-on's deleted-draft entries carry both prices.
async function b12World({ deletedDraft = false, twoMonths = false } = {}) {
	const oct = (id, driver, truck) => loadRow({ id, driver, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck });
	const w = M.startWorld({
		env: ENV, now: M.etMs("2026-10-02 20:00"),
		drivers: [{ name: DOT, ...(twoMonths ? { payDaily: 0 } : {}) }, { name: EVE }, { name: GUS }, { name: HAL, payDaily: 350 }, { name: IKE, payType: "percentage", payPct: 30 }],
		...(twoMonths ? { trucks: [{ unit: "T1", driver: DOT, payDaily: 150 }, { unit: "T2", driver: EVE }, { unit: "T3", driver: GUS }, { unit: "T4", driver: HAL }, { unit: "T5", driver: IKE }] } : {}),
		payRates: [
			{ subject: "driver", key: "hal ives", rate: 300, from: "2026-09-01T12:00:00.000Z" },
			{ subject: "driver", key: "hal ives", rate: 350, from: "2026-10-10T12:00:00.000Z" },
		],
		rows: [
			loadRow({ id: "F701", driver: DOT, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "F702", driver: DOT, pickup: "2026-09-30 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
			...(twoMonths ? [loadRow({ id: "F703", driver: DOT, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-09-30", done: "", status: "In Transit", truck: "T1" })] : []),
			oct("E401", EVE, "T2"), oct("G401", GUS, "T3"), oct("J401", HAL, "T4"), oct("I401", IKE, "T5"),
		],
		status: [
			s("F701", "At Shipper", "2026-09-28 08:00"), s("F701", "Delivered", "2026-09-29 17:00"), s("F702", "At Shipper", "2026-09-30 09:00"),
			s("E401", "At Shipper", "2026-10-04 09:00"), s("E401", "Delivered", "2026-10-06 17:00"),
			s("G401", "At Shipper", "2026-10-04 09:00"), s("G401", "Delivered", "2026-10-06 17:00"),
		],
	});
	const dot = await M.generate(w, DOT, "2026-10-02");
	if (deletedDraft) {
		const n = dot.invoice.invoice_number;
		const lines = [
			{ date: "2026-10-01", description: `Correction for ${n}: Thursday, October 1, 2026, $260`, amount: 260 },
			{ date: "2026-10-02", description: `Correction for ${n}: Friday, October 2, 2026, $260`, amount: 260 },
		];
		// The invoice routes work-days-world lifts (money-plans-world's route() is its own).
		const WD = require("./lib/work-days-world");
		const m = await WD.route(w, "POST /api/invoices/manual", { body: { payee: DOT, periodStart: "2026-10-01", periodEnd: "2026-10-02", lineItems: lines } });
		const del = await WD.route(w, "DELETE /api/invoices/:id", { params: { id: String(m.body && m.body.invoice && m.body.invoice.id) }, query: { reason: "not valid" } });
		if (m.status !== 200 || del.status !== 200) throw new Error(`the deleted correction draft was not made (${m.status}, ${del.status})`);
	}
	w.addStatus([s("F702", "Delivered", "2026-10-03 16:00")]);
	w.setRow("F702", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
	if (twoMonths) w.setRow("F703", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
	M.lockMonth(w.db, "2026-09", "2026-10-15T05:00:00.000Z");
	w.clock.ms = NOW;
	const eve = await M.generate(w, EVE, W40);
	const gus = await M.generate(w, GUS, W40);
	const hal = await M.generate(w, HAL, W40);
	for (const g of [dot, eve, gus, hal]) if (!g.invoice) throw new Error(`an invoice was not made (${g.status})`);
	const set = w.db.prepare("UPDATE invoices SET status = ?, adjustment = ? WHERE id = ?");
	set.run("Submitted", 0, dot.invoice.id);
	set.run("Approved", 0, eve.invoice.id);
	set.run("Submitted", 300, gus.invoice.id);
	return { w, dot: dot.invoice.invoice_number, eve: eve.invoice.invoice_number, gus: gus.invoice.invoice_number, hal: hal.invoice.invoice_number };
}
let sharedB12 = null;
async function b12Main() {
	if (!sharedB12) {
		const f = await b12World();
		const copy = M.saveCopy(f.w, ENV);
		sharedB12 = { f, out: await inProcess(copy, { ready: {} }) };
	}
	return sharedB12;
}

// The script as a module (null while it does not exist).
function scriptModule() {
	const file = path.join(M.ROOT, SCRIPT);
	if (!fs.existsSync(file)) return null;
	return require(file);
}

// One in-process run on a copy, with a sheet loader that counts its calls.
// Every run states its rate basis (pay plan R3): --rates-as-recorded unless the
// case gives its own. `ready` null leaves --b4-ready out (B4 is opt-in, R1).
async function inProcess(copy, { ready = READY, extra = [], during = null, rates = ["--rates-as-recorded"] } = {}) {
	const mod = scriptModule();
	if (!mod || typeof mod.run !== "function") throw new Error(`${SCRIPT} does not exist yet (or has no run())`);
	let reads = 0;
	const loadSheet = async () => {
		reads++;
		if (during) during();
		return JSON.parse(fs.readFileSync(copy.values, "utf8"));
	};
	const out = await mod.run({
		argv: [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, ...(ready === null ? [] : [`--b4-ready=${JSON.stringify(ready)}`]), "--names", "--json", ...rates, ...extra],
		now: NOW, loadSheet, log: () => {},
	});
	return { ...out, reads };
}

// The shared fixture and its in-process result, made once.
let shared = null;
async function main() {
	if (!shared) {
		const f = await fixture();
		const copy = M.saveCopy(f.w, ENV);
		shared = { f, copy, out: await inProcess(copy) };
	}
	return shared;
}
const SCEN = ["today", "b12", "dailyRate", "b4AsDesigned", "b4Applied", "allThree", "allThreeB4AsDesigned"];
const pay = (r, driver) => {
	const d = ((r && r.drivers) || []).find((x) => x.driver === driver);
	return d ? SCEN.map((k) => [d.byScenario[k].days, d.byScenario[k].pay]) : null;
};
const payable = (r, ownerId) => {
	const i = ((r && r.investors) || []).find((x) => x.ownerId === ownerId);
	return i ? SCEN.map((k) => i.byScenario[k].payable) : null;
};
const invoiceRows = (r, key) => (((r && r.invoices) || {})[key] || []).map((i) => ({
	number: i.invoiceNumber, status: i.status, added: i.addedDays, notPaid: i.notPaidDays,
	repriced: (i.repricedDays || []).map((d) => [d.day, d.printed, d.scenario]),
	amount: [i.amountNow, i.amountScenario, i.difference], correction: i.correction,
})).sort((a, b) => String(a.number).localeCompare(String(b.number)));
// The days B12 would not add (a person decides): [[days, amount, reason]].
const notAdded = (r, key, number) => ((((r && r.invoices) || {})[key] || []).find((i) => i.invoiceNumber === number) || {}).notAdded;

const R = M.createRunner("The combined October what-would-change report (scripts/october-flags-report.js): B12, the daily rate and B4, alone and together, from one read");

(async () => {
	await R.test("O1 Today and B12 alone (TRIP_WORK_DAYS from 2026-10): Cal 3 days $450 -> 4 days $600 (10/4 from the At Shipper tap), Ana $1,400 both; investor 5's October payable $975 -> $900 after the $100 loss carried in from September. Base: the script does not exist", async ({ eq }) => {
		const { out } = await main();
		eq("exit code", out.code, 0);
		eq("Cal: today, B12", (pay(out.result, CAL) || []).slice(0, 2), [[3, 450], [4, 600]]);
		eq("Ana: today, B12", (pay(out.result, ANA) || []).slice(0, 2), [[4, 1400], [4, 1400]]);
		eq("investor 5: today, B12", (payable(out.result, 5) || []).slice(0, 2), [975, 900]);
	});

	await R.test("O2 Daily rate alone (DRIVER_RATE_ONLY from 2026-10): Cal $750 (no rate of his own: $250, not the truck's $150), Ana $1,400 (her own $350); investor 5 $825; Cal's Submitted W40 lists its three days $150 -> $250, $450 -> $750 (+$300), an adjustment; Ana's Draft is not listed. Base: the script does not exist", async ({ eq }) => {
		const { f, out } = await main();
		eq("Cal, Ana", [(pay(out.result, CAL) || [])[2], (pay(out.result, ANA) || [])[2]], [[3, 750], [4, 1400]]);
		eq("investor 5", (payable(out.result, 5) || [])[2], 825);
		eq("invoices", invoiceRows(out.result, "dailyRate"), [{
			number: f.cal, status: "Submitted", added: [], notPaid: [],
			repriced: [["2026-10-05", 150, 250], ["2026-10-06", 150, 250], ["2026-10-07", 150, 250]],
			amount: [450, 750, 300], correction: "adjustment",
		}]);
	});

	await R.test("O3 B4 as designed: stored loads unchanged, so every figure is today's and no invoice differs; the in-flight list names D903 only (A902 is delivered, D904 has a broker invoice draft, H901 is in closed September). Base: the script does not exist", async ({ eq }) => {
		const { out } = await main();
		const r = out.result || {};
		eq("Cal and Ana as today", [CAL, ANA].map((d) => { const p = pay(r, d) || []; return [p[3], p[0]]; }), [[[3, 450], [3, 450]], [[4, 1400], [4, 1400]]]);
		eq("investor 5 as today", (payable(r, 5) || [])[3], 975);
		eq("no invoice", invoiceRows(r, "b4AsDesigned"), []);
		eq("in flight", r.b4InFlight, ["D903"]);
		eq("why each load is or is not in flight", (r.b4Loads || []).map((l) => [l.loadId, l.asDesigned && l.asDesigned.takesReady]).sort(), [["A902", false], ["D903", true], ["D904", false], ["H901", false]]);
	});

	await R.test("O4 B4 applied to every listed drop-trailer load (Pickup Appointment = the Ready date): Ana's A902 pays 10/7-10/8, 2 days $700; Cal unchanged; investor 5 $1,325; Ana's W40 Draft pays 10/5 and 10/6 no more, $1,400 -> $700, regenerated; H901 (closed September) is skipped. Base: the script does not exist", async ({ eq }) => {
		const { f, out } = await main();
		const r = out.result || {};
		eq("Cal, Ana", [(pay(r, CAL) || [])[4], (pay(r, ANA) || [])[4]], [[3, 450], [2, 700]]);
		eq("investor 5", (payable(r, 5) || [])[4], 1325);
		eq("invoices", invoiceRows(r, "b4Applied"), [{
			number: f.ana, status: "Draft", added: [], notPaid: ["2026-10-05", "2026-10-06"], repriced: [],
			amount: [1400, 700, -700], correction: "regenerate the Draft once the flags are on",
		}]);
		eq("applied, skipped", (r.b4Loads || []).map((l) => [l.loadId, l.applied, /closed month/.test(l.skipped || "")]).sort(), [["A902", true, false], ["D903", true, false], ["D904", true, false], ["H901", false, true]]);
	});

	await R.test("O5 All three together: Cal 4 days at $250 = $1,000, Ana $700, investor 5 $1,050; Cal's W40 gains 10/4 at $250 (B12: added to the invoice in place, as the server does for a Submitted invoice in an open month) and its three days at $250 (the daily rate: an adjustment), $450 -> $1,000 (+$550); Ana's Draft -$700. All three with B4 as designed (B12 + daily rate): Cal $1,000, Ana $1,400, investor 5 $700, Cal's W40 +$550 only. Before (review M1): B12's part was labelled an adjustment", async ({ eq }) => {
		const { f, out } = await main();
		const r = out.result || {};
		eq("Cal, Ana: all three, all three with B4 as designed", [CAL, ANA].map((d) => (pay(r, d) || []).slice(5)), [[[4, 1000], [4, 1000]], [[2, 700], [4, 1400]]]);
		eq("investor 5", (payable(r, 5) || []).slice(5), [1050, 700]);
		const cal = {
			number: f.cal, status: "Submitted", added: ["2026-10-04"], notPaid: [],
			repriced: [["2026-10-05", 150, 250], ["2026-10-06", 150, 250], ["2026-10-07", 150, 250]],
			amount: [450, 1000, 550], correction: "B12: added to this invoice in place; daily rate: adjustment",
		};
		const ana = { number: f.ana, status: "Draft", added: [], notPaid: ["2026-10-05", "2026-10-06"], repriced: [], amount: [1400, 700, -700], correction: "regenerate the Draft once the flags are on" };
		eq("all three", invoiceRows(r, "allThree"), [cal, ana].sort((a, b) => a.number.localeCompare(b.number)));
		eq("all three, B4 as designed", invoiceRows(r, "allThreeB4AsDesigned"), [cal]);
		eq("B12 alone: Cal's W40 gains 10/4 at $150, in place", invoiceRows(r, "b12").map((i) => [i.number, i.added, i.amount, i.correction]), [[f.cal, ["2026-10-04"], [450, 600, 150], "added to this invoice in place"]]);
	});

	await R.test("O6 Closed months: September (closed, frozen) and every month before October are identical in every scenario; the frozen-row fingerprint counts September's rows and is the same on a second run. Base: the script does not exist", async ({ eq, ok }) => {
		const { copy, out } = await main();
		const r = out.result || {};
		eq("closed months unchanged", [r.closedMonthsUnchanged, r.monthsBeforeUnchanged, r.problems], [true, true, []]);
		const fp = r.closedMonthsFingerprint || {};
		ok("September's frozen line items and its payout row are counted", (fp.financials_ledger_items || {}).rows > 0 && (fp.investor_payouts || {}).rows === 1 && (fp.period_locks || {}).rows === 1, JSON.stringify(fp));
		const again = await inProcess(copy);
		eq("the same fingerprint on a second run", again.result && again.result.closedMonthsFingerprint, fp);
	});

	await R.test("O7 One data read: the Job Tracking loader is called once for every scenario; the run names its read time in US Eastern, the app's commit, and the settings it found (the day-once rule from 2026-10; B12 and the daily rate off). Base: the script does not exist", async ({ eq, ok }) => {
		const { out } = await main();
		const r = out.result || {};
		eq("sheet reads", out.reads, 1);
		const at = r.readAt || {};
		ok("the database snapshot's and the sheet read's times, each in Eastern (review L2)", [at.database, at.sheet].every((x) => /^2026-10-16 13:00(:\d\d)? (EDT|EST)$/.test(String(x && x.eastern))), JSON.stringify(r.readAt));
		ok("the app's commit", /^[0-9a-f]{40}$/.test(String(r.commit)), String(r.commit));
		eq("settings found", r.settings && [r.settings.LEDGER_DAY_ONCE_FROM, r.settings.TRIP_WORK_DAYS_FROM, r.settings.DRIVER_RATE_ONLY_FROM], ["2026-10", null, null]);
	});

	await R.test("O8 (revised 2026-10-22, pay plan R7: the 2026-10-16 production run is a fifth figure) The figures this report replaces are listed as labels, each beside this run's figure: investor 5 $2,347 -> $722 (B12 dry run) beside today -> B12 ($975 -> $900); B12 October driver pay +$3,250 beside +$150; the 2026-10-16 production run's today and both totals beside this run's. Before: four figures", async ({ eq, ok }) => {
		const { out } = await main();
		const list = (out.result && out.result.replaces) || [];
		ok("five earlier figures", list.length === 5 && ["$2,347", "$1,969", "+$900", "+$3,250", "$10,750"].every((x) => list.some((e) => String(e.earlier).includes(x))), JSON.stringify(list).slice(0, 300));
		const prod = list.find((e) => String(e.earlier).includes("$10,750")) || {};
		ok("the production run's source names its data time and commit", /09:42 ET/.test(String(prod.source)) && /73be100/.test(String(prod.source)), String(prod.source));
		eq("this run's today and both: driver pay (days, $) and the investor payable", prod.thisRun, { today: { days: 7, pay: 1850, payable: 975 }, both: { days: 8, pay: 2400, payable: 700 } });
		const b12 = list.find((e) => String(e.earlier).includes("$2,347")) || {};
		eq("investor 5, today -> B12", b12.thisRun && [b12.thisRun.today, b12.thisRun.b12], [975, 900]);
		const pay12 = list.find((e) => String(e.earlier).includes("+$3,250")) || {};
		eq("October driver pay change with B12", pay12.thisRun && pay12.thisRun.change, 150);
		const b4 = list.find((e) => String(e.earlier).includes("$1,969")) || {};
		eq("the $1,969 figure's source (review L8)", b4.source, "B4 impact, computed 2026-10-16 ~05:00 ET on the replica copy of 2026-10-15: B12 off -> on, B4 applied");
	});

	await R.test("O9 Read-only: run as the server runs it (text report), it exits 0 and leaves the database file's bytes and modified time as they were. Base: the script does not exist", async ({ eq, ok }) => {
		const { copy } = await main();
		const before = [M.fileHash(copy.db), fs.statSync(copy.db).mtimeMs];
		const r = M.runScript(SCRIPT, [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--rates-as-recorded", "--dry-run"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("exit code", r.code, 0);
		ok("the text report says nothing was written", /Nothing was written/.test(r.stdout), r.stdout.slice(0, 200));
		ok("it starts with a note to run it under nice with --max-old-space-size=4096 and a run-time estimate (review L3)", /nice/.test(r.stderr) && /--max-old-space-size=4096/.test(r.stderr) && /estimate/i.test(r.stderr), r.stderr.slice(0, 300));
		// Some of B12's days are paid by their week's own invoice later (beforeFloorWeekNotInvoiced): the heading claims no outcome; each line keeps its reason.
		ok("the B12 days heading is neutral (re-review)", /Days B12 would not add automatically/.test(r.stdout) && !/corrected by hand/.test(r.stdout), (r.stdout.match(/.*B12.*refused.*|.*B12 would not.*/) || [""])[0]);
		eq("the file's bytes and modified time", [M.fileHash(copy.db), fs.statSync(copy.db).mtimeMs], before);
	});

	await R.test("O10 (revised 2026-10-22, pay plan R1: B4 is opt-in, so a run with no --b4-ready is no longer refused; O19 runs one) Refused with exit 2 and no report: a malformed --b4-ready (not JSON, a list, a date that does not exist, a blank load id, one load twice, a load not on Job Tracking) and no --db", async ({ eq, ok }) => {
		const { copy } = await main();
		const base = [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--rates-as-recorded", "--json"];
		const cases = [
			["not JSON", [...base, "--b4-ready={A902:2026-10-07}"]],
			["a list", [...base, '--b4-ready=["A902"]']],
			["no such date", [...base, '--b4-ready={"A902":"2026-02-30"}']],
			["no such month", [...base, '--b4-ready={"A902":"2026-13-01"}']],
			["a blank load id", [...base, '--b4-ready={" ":"2026-10-07"}']],
			["one load twice", [...base, '--b4-ready={"A902":"2026-10-07","#a902":"2026-10-07"}']],
			["one key twice (review L9)", [...base, '--b4-ready={"A902":"2026-10-07","A902":"2026-10-08"}']],
			["one key twice, the first value not a string (re-review)", [...base, '--b4-ready={"A902":5,"A902":"2026-10-07"}']],
			["501 loads (review L7)", [...base, `--b4-ready=${JSON.stringify(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`L${i}`, "2026-10-07"])))}`]],
			["a 65-character load id (review L7)", [...base, `--b4-ready=${JSON.stringify({ ["9".repeat(65)]: "2026-10-07" })}`]],
			["a load not on Job Tracking", [...base, '--b4-ready={"Z999":"2026-10-07"}']],
			["no --db", base.slice(1).concat(['--b4-ready={"A902":"2026-10-07"}'])],
		];
		const why = { "501 loads (review L7)": /at most 500/, "a 65-character load id (review L7)": /overlong/, "one key twice (review L9)": /twice/, "one key twice, the first value not a string (re-review)": /twice/ };
		for (const [label, args] of cases) {
			const r = M.runScript(SCRIPT, args);
			ok(`${label}: the script exists`, !r.missing, r.stderr.split("\n")[0]);
			eq(`${label}: exit code and no report`, [r.code, r.json, /^REFUSED: /m.test(r.stderr)], [2, null, true]);
			if (why[label]) ok(`${label}: the reason`, why[label].test(r.stderr), r.stderr.slice(0, 200));
		}
	});

	await R.test("O11 Refused with exit 2: October already closed (the rules may start only in an open month), and an app .env that already turns B12 or the daily rate on (today would already include it). Base: the script does not exist", async ({ eq, ok }) => {
		const closed = await fixture({ lockOctober: true });
		const c = M.saveCopy(closed.w, ENV);
		const r = M.runScript(SCRIPT, [`--db=${c.db}`, `--env-file=${c.envFile}`, `--values-json=${c.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--rates-as-recorded", "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("October closed", [r.code, r.json], [2, null]);
		const { f } = await main();
		for (const flags of [{ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" }, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" }]) {
			const on = M.saveCopy(f.w, { ...ENV, ...flags });
			const x = M.runScript(SCRIPT, [`--db=${on.db}`, `--env-file=${on.envFile}`, `--values-json=${on.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--rates-as-recorded", "--json"]);
			eq(`${Object.keys(flags)[0]} already on`, [x.code, x.json], [2, null]);
		}
		// The shell's APP_TIMEZONE (none: America/New_York) is what lib/ reads; the
		// .env naming another zone would make the lifted code and lib/ disagree.
		const zone = M.saveCopy(f.w, { ...ENV, APP_TIMEZONE: "America/Chicago" });
		const z = M.runScript(SCRIPT, [`--db=${zone.db}`, `--env-file=${zone.envFile}`, `--values-json=${zone.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--rates-as-recorded", "--json"]);
		eq("the .env's APP_TIMEZONE differs from the shell's (review L1)", [z.code, z.json, /APP_TIMEZONE/.test(z.stderr)], [2, null, true]);
	});

	await R.test("O23 (pay plan R8) Refused with exit 2: a start record of either rule already in the database (TRIP_WORK_DAYS' first invoiced week, or DRIVER_RATE_ONLY's start), so a rule has already run. Before: not checked", async ({ eq, ok }) => {
		for (const key of ["trip_work_days_started_at", "driver_rate_only.started"]) {
			const f = await fixture();
			const value = key === "trip_work_days_started_at" ? JSON.stringify({ weekStart: "2026-10-03" }) : JSON.stringify({ from: "2026-10", startedAt: "2026-10-16T12:00:00.000Z" });
			f.w.db.prepare("INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, '2026-10-16T12:00:00.000Z', 'system')").run(key, value);
			const c = M.saveCopy(f.w, ENV);
			const r = M.runScript(SCRIPT, [`--db=${c.db}`, `--env-file=${c.envFile}`, `--values-json=${c.values}`, "--rates-as-recorded", "--json"]);
			eq(`${key}: exit code and no report`, [r.code, r.json], [2, null]);
			ok(`${key}: the reason names the record`, r.stderr.includes(key), r.stderr.slice(0, 200));
		}
	});

	await R.test("O12 (review M1) B12 on an Approved invoice in an open month: Eve's W40 gains 10/4 ($260) on a correction Draft for that week, as the server does; the week's pay $520 -> $780. Before: labelled an adjustment", async ({ eq }) => {
		const { f, out } = await b12Main();
		eq("exit code", out.code, 0);
		eq("Eve's W40", invoiceRows(out.result, "b12").filter((i) => i.number === f.eve), [{
			number: f.eve, status: "Approved", added: ["2026-10-04"], notPaid: [], repriced: [], amount: [520, 780, 260], correction: "a correction invoice (Draft) for this week",
		}]);
	});

	await R.test("O13 (review M1) B12 on an invoice whose $300 adjustment may already pay the day: Gus's 10/4 is not added and is left out of the difference and the amount; it is listed for a person to decide, with its $260. Before: added and counted", async ({ eq }) => {
		const { f, out } = await b12Main();
		const rows = invoiceRows(out.result, "b12").filter((i) => i.number === f.gus);
		eq("Gus's W40", rows.map((i) => [i.added, i.amount]), [[[], [520, 520, 0]]]);
		eq("a person decides", notAdded(out.result, "b12", f.gus), [{ days: ["2026-10-04"], amount: 260, reason: `not added: ${f.gus} carries a $300.00 adjustment that may already pay them; a person decides` }]);
	});

	await R.test("O14 (review M1) B12's refused days are listed per scenario: Dot's 9/30 (an October load's day in closed September, $260, corrected by hand) under B12 alone and with all three; his W39 gains 10/1-10/2 ($520) on a correction Draft (its week touches September). Before: not shown", async ({ eq }) => {
		const { f, out } = await b12Main();
		const r = out.result || {};
		const refused = (k) => (((r.refusedDays || {})[k]) || []).filter((d) => d.driver === DOT).map((d) => [d.day, d.kind, d.amount]);
		eq("B12 alone", refused("b12"), [["2026-09-30", "closedMonth", 260]]);
		eq("all three", refused("allThree"), [["2026-09-30", "closedMonth", 260]]);
		eq("no B12, no refused days", ((r.refusedDays || {}).dailyRate || []).length, 0);
		eq("Dot's W39", invoiceRows(r, "b12").filter((i) => i.number === f.dot).map((i) => [i.added, i.amount, i.correction]),
			[[["2026-10-01", "2026-10-02"], [520, 1040, 520], "a correction invoice (Draft) for this week"]]);
	});

	await R.test("O15 (review M2; revised 2026-10-21, one pricing rule) Dated rates price a regenerated Draft only with the daily-rate rule on: Hal's W40 Draft, printed at his $350, is not repriced by B12 alone (it pays the ledger's $350), and with all three it prices 10/5-10/6 at the $300 pay_rate_history holds for those days, $700 -> $600. Before: B12 alone repriced it", async ({ eq }) => {
		const { f, out } = await b12Main();
		eq("B12 alone: Hal's W40 Draft not listed", invoiceRows(out.result, "b12").filter((i) => i.number === f.hal), []);
		eq("all three: Hal's W40 Draft", invoiceRows(out.result, "allThree").filter((i) => i.number === f.hal).map((i) => [i.status, i.repriced, i.amount]), [
			["Draft", [["2026-10-05", 350, 300], ["2026-10-06", 350, 300]], [700, 600, -100]],
		]);
	});

	await R.test("O24 (2026-10-21 item 2) A day a deleted correction Draft named is never carried again, so the report does not count it as an invoice change: Dot's W39 adds nothing ($520 -> $520); 10/1-10/2 ($520) are listed for a person to decide, as deleted-draft days the switch-on refuses. Before: added on a correction Draft (+$520)", async ({ eq }) => {
		const f = await b12World({ deletedDraft: true });
		const out = await inProcess(M.saveCopy(f.w, ENV), { ready: null });
		eq("exit code", out.code, 0);
		const r = out.result || {};
		for (const k of ["b12", "allThreeB4AsDesigned"]) {
			const row = ((r.invoices || {})[k] || []).find((i) => i.invoiceNumber === f.dot) || {};
			eq(`${k}: Dot's W39 adds nothing`, [row.addedDays, row.amountNow, row.amountScenario], [[], 520, 520]);
			eq(`${k}: 10/1-10/2 left to a person, as deleted-draft days`, (row.notAdded || []).map((x) => [x.days, x.amount, /deleted/.test(x.reason)]), [[["2026-10-01", "2026-10-02"], 520, true]]);
			eq(`${k}: the refused days`, (((r.refusedDays || {})[k]) || []).filter((d) => d.driver === DOT).map((d) => [d.day, d.kind]), [["2026-09-30", "closedMonth"], ["2026-10-01", "deletedDraft"], ["2026-10-02", "deletedDraft"]]);
		}
		eq("check c: the deleted-draft days, once each", ((r.checkC && r.checkC.deletedDraftDays) || []).filter((d) => d.driver === DOT).map((d) => d.day), ["2026-10-01", "2026-10-02"]);
	});

	await R.test("O16 (review L6) A percentage driver's October pay is the same in every scenario, and the report says so. Before: not checked", async ({ eq, ok }) => {
		const { out } = await b12Main();
		const r = out.result || {};
		const ike = (r.percentageDrivers || []).find((d) => d.driver === IKE);
		ok("Ike's October pay is listed and positive", ike && ike.byScenario.today > 0, JSON.stringify(r.percentageDrivers));
		eq("the same in every scenario", ike && SCEN.map((k) => ike.byScenario[k]).every((v) => v === ike.byScenario.today), true);
		eq("the check", r.percentageDriversUnchanged, true);
	});

	await R.test("O17 (review L7) One snapshot: a write another connection commits while Job Tracking is read (Ana's own rate to $500) does not show; the report keeps the database as it stood at the read (Ana $1,400 today). Before: the write shows", async ({ eq }) => {
		const f = await fixture();
		const copy = M.saveCopy(f.w, ENV);
		const writer = new M.Database(copy.db);
		writer.pragma("journal_mode = WAL");
		try {
			const out = await inProcess(copy, { during: () => writer.prepare("UPDATE drivers_directory SET pay_daily = 500 WHERE driver_name = ?").run(ANA) });
			eq("the write landed", writer.prepare("SELECT pay_daily FROM drivers_directory WHERE driver_name = ?").get(ANA).pay_daily, 500);
			eq("Ana today, as at the read", (pay(out.result, ANA) || [])[0], [4, 1400]);
		} finally {
			writer.close();
		}
	});

	await R.test("O18 (review L4) The app's .env changing during the run is flagged (exit 1; its contents are never printed). Before: not checked", async ({ eq, ok }) => {
		const f = await fixture();
		const copy = M.saveCopy(f.w, ENV);
		const out = await inProcess(copy, { during: () => fs.appendFileSync(copy.envFile, "SOME_SETTING=1\n") });
		eq("exit code", out.code, 1);
		ok("a problem names the .env", ((out.result && out.result.problems) || []).some((p) => /\.env/.test(p.issue)), JSON.stringify(out.result && out.result.problems));
		ok("no value printed", !/SOME_SETTING/.test(out.output || ""), "");
	});

	await R.test("O19 (pay plan R1) B4 is opt-in and the headline is both changes: with no --b4-ready the run is not refused, B4 is not included (B4 applied reads as today), and the headline gives today -> both (B12 + daily rate): Ana $1,400 both, Cal 3 days $450 -> 4 days $1,000; investor 5 $975 -> $700; Cal's W40 the one invoice that changes (+$550); the text report opens with it. Before: refused for no --b4-ready", async ({ eq, ok }) => {
		const { f, copy } = await main();
		const out = await inProcess(copy, { ready: null });
		eq("exit code", out.code, 0);
		const r = out.result || {};
		eq("B4 not included", r.b4Included, false);
		eq("B4 applied reads as today: Ana", (pay(r, ANA) || [])[4], [4, 1400]);
		const h = r.headline || {};
		eq("the headline's scenario", h.scenario, "allThreeB4AsDesigned");
		eq("drivers, today -> both", (h.drivers || []).map((d) => [d.driver, d.today.days, d.today.pay, d.both.days, d.both.pay]), [[ANA, 4, 1400, 4, 1400], [CAL, 3, 450, 4, 1000]]);
		eq("driver totals", h.driverTotals, { today: { days: 7, pay: 1850 }, both: { days: 8, pay: 2400 } });
		eq("investor 5", (h.investors || []).map((i) => [i.ownerId, i.today, i.both]), [[5, 975, 700]]);
		eq("investor total", h.investorTotals, { today: 975, both: 700 });
		eq("the invoices that change", (h.invoices || []).map((i) => [i.invoiceNumber, i.status, i.difference]), [[f.cal, "Submitted", 550]]);
		const t = M.runScript(SCRIPT, [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--rates-as-recorded"]);
		eq("text: exit code", t.code, 0);
		const at = t.stdout.indexOf("Both changes (B12 + daily rate)");
		ok("text: the headline comes before every other table", at !== -1 && at < t.stdout.indexOf("Driver October pay"), t.stdout.slice(0, 400));
		ok("text: B4 is said to be left out", /B4: not included/.test(t.stdout), t.stdout.slice(0, 400));
	});

	// The data fix's plan for made-up Ana: $300 from 10/1, $350 (her rate now) from 10/6.
	const PLAN = { approval: "arvin-2026-10-21-a-b", drivers: [{ name: ANA, expect: { payDaily: 350 }, rates: [{ from: "2026-10-01", rate: 300 }, { from: "2026-10-06", rate: 350 }] }] };
	const planFile = (dir, plan = PLAN) => { const p = path.join(dir, "octrep-plan.json"); fs.writeFileSync(p, JSON.stringify(plan)); return p; };
	// The data fix's end state, as scripts/data-fix-driver-rates.js writes it:
	// Ana's dated rows (Eastern midnight) and its audit rows' references.
	const applyFix = (w, { rows = true, refs = 5 } = {}) => {
		if (rows) {
			const ins = w.db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES ('driver', 'ana moss', ?, ?, 'data-fix')");
			ins.run(300, "2026-10-01T04:00:00.000Z");
			ins.run(350, "2026-10-06T04:00:00.000Z");
		}
		const a = w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-10-16T12:00:00.000Z', 0, 'system: data-fix-driver-rates', 'system', 'pay_rate_entry', 'driver', 'ana moss', ?)");
		for (let n = 1; n <= refs; n++) a.run(`made-up data fix row. [DRF-20261021-${n}]`);
	};

	await R.test("O20 (pay plan R3, R5) The rates the report prices by: refused (exit 2) without the data fix's end state (no --rate-plan, its audit references missing, or a day not at the plan's rate); with it, the run prices Ana's 10/5 at $300 (both $1,350) and prints each daily-rate driver's October rate per day, today vs both; --simulate-rate-plan gives the same figures from the plan in memory, labelled SIMULATED, the file untouched; each plan rate's first day says which invoice pays it. Before: none of it", async ({ eq, ok }) => {
		const run = (copy, args) => M.runScript(SCRIPT, [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--json", ...args]);
		const bare = await fixture();
		const c0 = M.saveCopy(bare.w, ENV);
		const none = run(c0, []);
		eq("no rate basis: exit code, no report", [none.code, none.json], [2, null]);
		ok("no rate basis: the reason names the data fix", /data fix/.test(none.stderr), none.stderr.slice(0, 200));
		const both = run(c0, [`--rate-plan=${planFile(c0.dir)}`, "--rates-as-recorded"]);
		eq("--rate-plan with --rates-as-recorded: refused", [both.code, both.json], [2, null]);

		const short = await fixture();
		applyFix(short.w, { refs: 4 });
		const c1 = M.saveCopy(short.w, ENV);
		const r1 = run(c1, [`--rate-plan=${planFile(c1.dir)}`]);
		eq("a reference missing: refused", [r1.code, r1.json], [2, null]);
		ok("the reason names the missing reference", /DRF-20261021-5/.test(r1.stderr), r1.stderr.slice(0, 200));

		const noRows = await fixture();
		applyFix(noRows.w, { rows: false });
		const c2 = M.saveCopy(noRows.w, ENV);
		const r2 = run(c2, [`--rate-plan=${planFile(c2.dir)}`]);
		eq("the rows missing: refused", [r2.code, r2.json], [2, null]);
		ok("the reason names the driver's first wrong day", /2026-10-01/.test(r2.stderr), r2.stderr.slice(0, 200));

		const fixed = await fixture();
		applyFix(fixed.w);
		const c3 = M.saveCopy(fixed.w, ENV);
		const out = await inProcess(c3, { rates: [`--rate-plan=${planFile(c3.dir)}`] });
		eq("fixed: exit code", out.code, 0);
		const r = out.result || {};
		eq("fixed: the rate basis", r.rates && r.rates.mode, "fixed");
		eq("Ana today, both: 10/5 at $300", [(pay(r, ANA) || [])[0], (pay(r, ANA) || [])[6]], [[4, 1400], [4, 1350]]);
		const rates = Object.fromEntries(((r.rates && r.rates.october) || []).map((d) => [d.driver, [d.today, d.both]]));
		eq("October rates per day, today vs both", [rates[ANA], rates[CAL]], [
			[[{ from: "2026-10-01", to: "2026-10-31", rate: 350 }], [{ from: "2026-10-01", to: "2026-10-05", rate: 300 }, { from: "2026-10-06", to: "2026-10-31", rate: 350 }]],
			[[{ from: "2026-10-01", to: "2026-10-31", rate: 150 }], [{ from: "2026-10-01", to: "2026-10-31", rate: 250 }]],
		]);
		eq("each plan rate's first day: who pays it, today's ledger and both", ((r.checkC && r.checkC.rateDays) || []).map((d) => [d.driver, d.day, d.paidBy.map((p) => [p.invoiceNumber, p.status, p.amount]), d.ledgerToday, d.ledgerBoth]), [
			[ANA, "2026-10-01", [], 0, 0],
			[ANA, "2026-10-06", [[fixed.ana, "Draft", 350]], 350, 350],
		]);

		const c4 = M.saveCopy(bare.w, ENV);
		const before = [M.fileHash(c4.db), fs.statSync(c4.db).mtimeMs];
		const sim = await inProcess(c4, { rates: [`--rate-plan=${planFile(c4.dir)}`, "--simulate-rate-plan"] });
		eq("simulated: exit code and basis", [sim.code, sim.result && sim.result.rates && sim.result.rates.mode], [0, "simulated"]);
		eq("simulated: Ana today, both", [(pay(sim.result, ANA) || [])[0], (pay(sim.result, ANA) || [])[6]], [[4, 1400], [4, 1350]]);
		eq("simulated: the database file untouched", [M.fileHash(c4.db), fs.statSync(c4.db).mtimeMs], before);
		const st = M.runScript(SCRIPT, [`--db=${c4.db}`, `--env-file=${c4.envFile}`, `--values-json=${c4.values}`, `--rate-plan=${planFile(c4.dir)}`, "--simulate-rate-plan"]);
		ok("simulated: the text report says so first", st.code === 0 && /^.*SIMULATED/m.test(st.stdout.split("\n").slice(0, 3).join("\n")), st.stdout.slice(0, 300) + st.stderr.slice(0, 300));
	});

	// Rule d's shapes (scripts/test-trip-work-days-pay-paths.js), in week W41
	// (Sat 10/10-Fri 10/16), one driver and truck each at $260, with ELD:
	//   Abe   heading Mon, loads Tue: Mon added (heading)
	//   Cy    At Shipper Mon, Loading Wed: Tue a waiting day
	//   Eli   in transit Mon-Wed, parked Tue: a rest day
	//   Hal   At Receiver Tue, Delivered Fri, no receiver coordinates: a lateTap
	//         load, Wed-Thu not paid, Fri added (unloading)
	//   Kim   At Shipper Mon, no Loading tap, In Transit Wed, Pickup Appointment
	//         Tue (parked): Tue a loading-fallback day
	//   Lou   heading Mon, cancelled Tue (drove both days): two drive days on a
	//         cancelled load (Q17)
	//   Mo    Delivered Wed, Drop-off Appointment Thu, drove Thu: Thu not paid
	//         by rule d, kept on his Submitted W41 invoice
	async function ruleDWorld() {
		const [, , MON, TUE, WED, THU, FRI] = M.daysFrom("2026-10-10", "2026-10-16");
		const shapes = [
			{ driver: "Abe Heading", pickup: TUE, dropoff: WED, assigned: MON, done: WED,
				status: [["Dispatched", MON, "08:00"], ["Heading to Shipper", MON, "09:30"], ["At Shipper", TUE, "08:00"], ["Loading", TUE, "09:00"], ["In Transit", TUE, "13:00"], ["At Receiver", WED, "10:00"], ["Delivered", WED, "11:30"]],
				feed: (x) => x.drive(MON, { miles: 200 }).drive(TUE, { miles: 250 }).drive(WED, { miles: 150 }) },
			{ driver: "Cy Wait", pickup: MON, dropoff: THU, assigned: MON, done: THU,
				status: [["At Shipper", MON, "10:00"], ["Loading", WED, "08:00"], ["In Transit", WED, "12:00"], ["At Receiver", THU, "14:00"], ["Delivered", THU, "15:00"]],
				feed: (x) => x.drive(MON, { miles: 200 }).park(TUE).drive(WED, { miles: 200 }).drive(THU, { miles: 200 }) },
			{ driver: "Eli Rest", pickup: MON, dropoff: WED, assigned: MON, done: WED,
				status: [["At Shipper", MON, "08:00"], ["Loading", MON, "09:00"], ["In Transit", MON, "12:00"], ["At Receiver", WED, "15:00"], ["Delivered", WED, "16:00"]],
				feed: (x) => x.drive(MON, { miles: 300 }).park(TUE).drive(WED, { miles: 300 }) },
			{ driver: "Hal Late", pickup: MON, dropoff: TUE, assigned: MON, done: FRI,
				status: [["At Shipper", MON, "09:00"], ["Loading", MON, "10:00"], ["In Transit", MON, "12:00"], ["At Receiver", TUE, "15:00"], ["Delivered", FRI, "10:00"]],
				feed: (x) => x.drive(MON, { miles: 300 }).drive(TUE, { miles: 200, to: 13 }).park(WED).drive(THU, { miles: 10, from: 9, to: 11 }).park(FRI) },
			{ driver: "Kim Fall", pickup: TUE, dropoff: THU, assigned: MON, done: THU,
				status: [["At Shipper", MON, "10:00"], ["In Transit", WED, "12:00"], ["At Receiver", THU, "10:00"], ["Delivered", THU, "11:00"]],
				feed: (x) => x.drive(MON, { miles: 200 }).park(TUE).drive(WED, { miles: 200 }).drive(THU, { miles: 100 }) },
			{ driver: "Lou Tonu", pickup: WED, dropoff: THU, assigned: MON, done: "", rowStatus: "Cancelled",
				status: [["Dispatched", MON, "08:00"], ["Heading to Shipper", MON, "09:00"], ["Cancelled", TUE, "10:00"]],
				feed: (x) => x.drive(MON, { miles: 200 }).drive(TUE, { miles: 100, to: 10 }) },
			{ driver: "Mo Early", pickup: MON, dropoff: THU, assigned: MON, done: WED,
				status: [["At Shipper", MON, "08:00"], ["Loading", MON, "09:00"], ["In Transit", MON, "12:00"], ["At Receiver", WED, "09:00"], ["Delivered", WED, "10:00"]],
				feed: (x) => x.drive(MON, { miles: 200 }).drive(TUE, { miles: 200 }).drive(WED, { miles: 200 }).drive(THU, { miles: 200 }) },
		];
		const rows = [];
		const status = [];
		const pings = {};
		const trucks = [];
		shapes.forEach((x, i) => {
			const id = `R0${i}`;
			const unit = `T${i + 1}`;
			const vid = `V${i + 1}`;
			trucks.push({ unit, driver: x.driver, vid });
			pings[vid] = x.feed(M.feed(100000 * (i + 1))).pings;
			rows.push(loadRow({ id, driver: x.driver, pickup: `${x.pickup} 8:00`, dropoff: `${x.dropoff} 18:00`, assigned: x.assigned, done: x.done, truck: unit, status: x.rowStatus || "Delivered" }));
			for (const [st, day, hm] of x.status) status.push([id, st, st === "Dispatched" ? "dispatch" : "manual", et(`${day} ${hm}`), st === "Dispatched" ? "super_admin" : ""]);
		});
		const w = M.startWorld({ env: ENV, drivers: shapes.map((x) => ({ name: x.driver })), trucks, rows, status, pings, now: M.etMs("2026-10-16 20:00") });
		const mo = await M.generate(w, "Mo Early", "2026-10-16");
		if (!mo.invoice) throw new Error(`Mo's W41 invoice was not made (${mo.status})`);
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(mo.invoice.id);
		return { w, mo: mo.invoice.invoice_number, days: { MON, TUE, WED, THU, FRI } };
	}
	let sharedRuleD = null;
	async function ruleDMain() {
		if (!sharedRuleD) {
			const f = await ruleDWorld();
			const copy = M.saveCopy(f.w, ENV);
			sharedRuleD = { f, copy, out: await inProcess(copy, { ready: null }) };
		}
		return sharedRuleD;
	}

	await R.test("O21 (pay plan R4) Rule d in the both-changes figures: each changed driver-day with its reason (Abe's Mon heading, Hal's Fri unloading, Kim's Mon driving and Tue loading-fallback added; Mo's Thu not paid, outsideSpan), and per driver the waiting (Cy 1), rest (Eli 1) and dark days, loading-fallback days (Kim 1), lateTap loads (Hal 1), error-state loads, days an issued invoice keeps (Mo 1) and drive days on cancelled loads (Lou 2: Mon, Tue). Before: none of it", async ({ eq }) => {
		const { f, out } = await ruleDMain();
		eq("exit code", out.code, 0);
		const r = out.result || {};
		const { MON, TUE, THU, FRI } = f.days;
		const changed = ((r.ruleD && r.ruleD.changedDays) || []).map((d) => [d.driver, d.day, d.change, d.reason]);
		eq("changed driver-days and why", changed, [
			["Abe Heading", MON, "added", "heading"],
			["Hal Late", FRI, "added", "unloading"],
			["Kim Fall", MON, "added", "driving"],
			["Kim Fall", TUE, "added", "loading-fallback"],
			["Mo Early", THU, "removed", "outsideSpan"],
		]);
		const counts = Object.fromEntries(((r.ruleD && r.ruleD.drivers) || []).map((d) => [d.driver, d]));
		const pick = (name) => { const d = counts[name] || {}; return [d.waiting, d.restDay, d.dark, d.loadingFallback, d.lateTapLoads, d.errorLoads, d.keptOnIssued, d.cancelledDriveDays]; };
		eq("Cy", pick("Cy Wait"), [1, 0, 0, 0, 0, 0, 0, 0]);
		eq("Eli", pick("Eli Rest"), [0, 1, 0, 0, 0, 0, 0, 0]);
		eq("Hal", pick("Hal Late"), [0, 0, 0, 0, 1, 0, 0, 0]);
		eq("Kim", pick("Kim Fall"), [0, 0, 0, 1, 0, 0, 0, 0]);
		eq("Mo", pick("Mo Early"), [0, 0, 0, 0, 0, 0, 1, 0]);
		eq("Lou", pick("Lou Tonu"), [0, 0, 0, 0, 0, 0, 0, 2]);
		eq("Lou's cancelled load and its drive days", ((r.ruleD && r.ruleD.cancelled) || []).map((c) => [c.driver, c.loadId, c.days]), [["Lou Tonu", "R05", [MON, TUE]]]);
		eq("Mo's kept day", ((r.ruleD && r.ruleD.keptOnIssued) || []).map((k) => [k.driver, k.invoiceNumber, k.days]), [["Mo Early", f.mo, [THU]]]);
	});

	await R.test("O22 (pay plan R6) --owner-note prints a plain note of 25 lines or fewer: October pay per driver today -> both (days and $), the investor payable today -> both, each invoice that changes (number, status, +/-, how), rule d's counts, the rate basis and the send-by dates; names only with --names. Before: no such option", async ({ eq, ok }) => {
		const { f, copy } = await main();
		const args = [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--rates-as-recorded", "--owner-note"];
		const named = M.runScript(SCRIPT, [...args, "--names"]);
		eq("exit code", named.code, 0);
		const lines = named.stdout.trim().split("\n");
		ok("25 lines or fewer", lines.length <= 25 && lines.length >= 8, `${lines.length} lines`);
		ok("Cal: 3 days $450 -> 4 days $1,000", lines.some((l) => /Cal Burke/.test(l) && /3 days, \$450/.test(l) && /4 days, \$1,000/.test(l)), named.stdout);
		ok("the investor payable $975 -> $700", lines.some((l) => /\$975/.test(l) && /\$700/.test(l)), named.stdout);
		ok("Cal's W40: number, status, +$550, how", lines.some((l) => l.includes(f.cal) && /Submitted/.test(l) && /\+\$550/.test(l)), named.stdout);
		ok("rule d's counts", lines.some((l) => /waiting/i.test(l) && /cancelled/i.test(l)), named.stdout);
		ok("the rate basis: rates as recorded, not final", lines.slice(0, 3).some((l) => /not final/i.test(l)), named.stdout);
		ok("the send-by dates", lines.some((l) => /Fri Oct 30/.test(l) && /Mon Nov 9/.test(l)), named.stdout);
		const plain = M.runScript(SCRIPT, args);
		eq("without --names: exit code", plain.code, 0);
		ok("without --names: numbered drivers, no name", !/Cal Burke|Ana Moss/.test(plain.stdout) && /driver \d/.test(plain.stdout), plain.stdout.slice(0, 300));
	});

	await R.test("O25 (#555 review M1) --owner-note on a run that found a problem prints no note: with the .env changing during the run (as O18) it exits 1 with \"owner note withheld: 1 problem(s): …\" naming the problem, and prints nothing. Before: a clean-looking note on stdout", async ({ eq, ok }) => {
		const f = await fixture();
		const copy = M.saveCopy(f.w, ENV);
		const out = await inProcess(copy, { extra: ["--owner-note"], during: () => fs.appendFileSync(copy.envFile, "SOME_SETTING=1\n") });
		eq("exit code", out.code, 1);
		eq("no note", out.output, undefined);
		ok("the reason: withheld, the count and the problem", /^owner note withheld: 1 problem\(s\): .*\.env/.test(String(out.error)), String(out.error).slice(0, 200));
		ok("no value printed", !/SOME_SETTING/.test(String(out.error)), "");
	});

	await R.test("O26 (#555 review L1) Deleted-draft days that two loads of different Assigned months name: when every day the invoice would add is held, the held amount is the invoice projection's own (10/1-10/2 at both changes' $250, $500), not one load's entry price, and the invoice adds nothing. Before: a load's entry price ($300)", async ({ eq }) => {
		const f = await b12World({ deletedDraft: true, twoMonths: true });
		const out = await inProcess(M.saveCopy(f.w, ENV), { ready: null });
		const row = (((out.result || {}).invoices || {}).allThreeB4AsDesigned || []).find((i) => i.invoiceNumber === f.dot) || {};
		eq("Dot's W39: nothing added, no difference", [row.addedDays, row.difference], [[], 0]);
		eq("left to a person at the projection's $500", (row.notAdded || []).map((x) => [x.days, x.amount]), [[["2026-10-01", "2026-10-02"], 500]]);
	});

	await R.test("O27 (#555 review L4) Check c does not count a Rejected invoice as paying a day (as the pay plan's check c query): with Ana's W40 Rejected, her 10/6 lists no payer. Before: the Rejected W40 at $350", async ({ eq }) => {
		const f = await fixture();
		applyFix(f.w);
		f.w.db.prepare("UPDATE invoices SET status = 'Rejected' WHERE invoice_number = ?").run(f.ana);
		const copy = M.saveCopy(f.w, ENV);
		const out = await inProcess(copy, { rates: [`--rate-plan=${planFile(copy.dir)}`] });
		eq("exit code", out.code, 0);
		eq("10/6's payers", (((out.result || {}).checkC || {}).rateDays || []).filter((d) => d.day === "2026-10-06").map((d) => d.paidBy), [[]]);
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
