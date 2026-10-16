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
async function b12World() {
	const oct = (id, driver, truck) => loadRow({ id, driver, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck });
	const w = M.startWorld({
		env: ENV, now: M.etMs("2026-10-02 20:00"),
		drivers: [{ name: DOT }, { name: EVE }, { name: GUS }, { name: HAL, payDaily: 350 }, { name: IKE, payType: "percentage", payPct: 30 }],
		payRates: [
			{ subject: "driver", key: "hal ives", rate: 300, from: "2026-09-01T12:00:00.000Z" },
			{ subject: "driver", key: "hal ives", rate: 350, from: "2026-10-10T12:00:00.000Z" },
		],
		rows: [
			loadRow({ id: "F701", driver: DOT, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "F702", driver: DOT, pickup: "2026-09-30 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
			oct("E401", EVE, "T2"), oct("G401", GUS, "T3"), oct("J401", HAL, "T4"), oct("I401", IKE, "T5"),
		],
		status: [
			s("F701", "At Shipper", "2026-09-28 08:00"), s("F701", "Delivered", "2026-09-29 17:00"), s("F702", "At Shipper", "2026-09-30 09:00"),
			s("E401", "At Shipper", "2026-10-04 09:00"), s("E401", "Delivered", "2026-10-06 17:00"),
			s("G401", "At Shipper", "2026-10-04 09:00"), s("G401", "Delivered", "2026-10-06 17:00"),
		],
	});
	const dot = await M.generate(w, DOT, "2026-10-02");
	w.addStatus([s("F702", "Delivered", "2026-10-03 16:00")]);
	w.setRow("F702", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
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
async function inProcess(copy, { ready = READY, extra = [], during = null } = {}) {
	const mod = scriptModule();
	if (!mod || typeof mod.run !== "function") throw new Error(`${SCRIPT} does not exist yet (or has no run())`);
	let reads = 0;
	const loadSheet = async () => {
		reads++;
		if (during) during();
		return JSON.parse(fs.readFileSync(copy.values, "utf8"));
	};
	const out = await mod.run({
		argv: [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, `--b4-ready=${JSON.stringify(ready)}`, "--names", "--json", ...extra],
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

	await R.test("O8 The figures this report replaces are listed as labels, each beside this run's figure: investor 5 $2,347 -> $722 (B12 dry run) beside today -> B12 ($975 -> $900); B12 October driver pay +$3,250 beside +$150. Base: the script does not exist", async ({ eq, ok }) => {
		const { out } = await main();
		const list = (out.result && out.result.replaces) || [];
		ok("four earlier figures", list.length === 4 && ["$2,347", "$1,969", "+$900", "+$3,250"].every((x) => list.some((e) => String(e.earlier).includes(x))), JSON.stringify(list).slice(0, 300));
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
		const r = M.runScript(SCRIPT, [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--dry-run"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("exit code", r.code, 0);
		ok("the text report says nothing was written", /Nothing was written/.test(r.stdout), r.stdout.slice(0, 200));
		ok("it starts with a note to run it under nice with --max-old-space-size=4096 and a run-time estimate (review L3)", /nice/.test(r.stderr) && /--max-old-space-size=4096/.test(r.stderr) && /estimate/i.test(r.stderr), r.stderr.slice(0, 300));
		// Some of B12's days are paid by their week's own invoice later (beforeFloorWeekNotInvoiced): the heading claims no outcome; each line keeps its reason.
		ok("the B12 days heading is neutral (re-review)", /Days B12 would not add automatically/.test(r.stdout) && !/corrected by hand/.test(r.stdout), (r.stdout.match(/.*B12.*refused.*|.*B12 would not.*/) || [""])[0]);
		eq("the file's bytes and modified time", [M.fileHash(copy.db), fs.statSync(copy.db).mtimeMs], before);
	});

	await R.test("O10 Refused with exit 2 and no report: a malformed --b4-ready (not JSON, a list, a date that does not exist, a blank load id, one load twice, a load not on Job Tracking), no --b4-ready, and no --db. Base: the script does not exist", async ({ eq, ok }) => {
		const { copy } = await main();
		const base = [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--values-json=${copy.values}`, "--json"];
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
			["no --b4-ready", base],
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
		const r = M.runScript(SCRIPT, [`--db=${c.db}`, `--env-file=${c.envFile}`, `--values-json=${c.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--json"]);
		ok("the script exists", !r.missing, r.stderr.split("\n")[0]);
		eq("October closed", [r.code, r.json], [2, null]);
		const { f } = await main();
		for (const flags of [{ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" }, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" }]) {
			const on = M.saveCopy(f.w, { ...ENV, ...flags });
			const x = M.runScript(SCRIPT, [`--db=${on.db}`, `--env-file=${on.envFile}`, `--values-json=${on.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--json"]);
			eq(`${Object.keys(flags)[0]} already on`, [x.code, x.json], [2, null]);
		}
		// The shell's APP_TIMEZONE (none: America/New_York) is what lib/ reads; the
		// .env naming another zone would make the lifted code and lib/ disagree.
		const zone = M.saveCopy(f.w, { ...ENV, APP_TIMEZONE: "America/Chicago" });
		const z = M.runScript(SCRIPT, [`--db=${zone.db}`, `--env-file=${zone.envFile}`, `--values-json=${zone.values}`, `--b4-ready=${JSON.stringify(READY)}`, "--json"]);
		eq("the .env's APP_TIMEZONE differs from the shell's (review L1)", [z.code, z.json, /APP_TIMEZONE/.test(z.stderr)], [2, null, true]);
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

	await R.test("O15 (review M2) B12 alone regenerates a Draft at each day's own dated rate (invoiceDayRater()): Hal's W40 Draft, printed at his $350, prices 10/5-10/6 at the $300 pay_rate_history holds for those days, $700 -> $600. Before: not listed", async ({ eq }) => {
		const { f, out } = await b12Main();
		eq("Hal's W40 Draft", invoiceRows(out.result, "b12").filter((i) => i.number === f.hal), [{
			number: f.hal, status: "Draft", added: [], notPaid: [], repriced: [["2026-10-05", 350, 300], ["2026-10-06", 350, 300]],
			amount: [700, 600, -100], correction: "regenerate the Draft once the flags are on",
		}]);
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

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
