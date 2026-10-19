#!/usr/bin/env node
/**
 * Money plan D, the "what would change" report: scripts/blank-pickup-dry-run.js
 * (--db --values-json --env-file --invoice-from --ledger-from --json), the shape
 * of B12's scripts/work-days-dry-run.js. Read-only, and two sections so the two
 * flags are approved separately:
 *   invoice  driver pay under INVOICE_BLANK_PICKUP_FALLBACK (the weekly invoice
 *            starts a blank pickup's window at the Assigned Date);
 *   ledger   payouts under LEDGER_BLANK_DROPOFF_FALLBACK (the ledger ends a
 *            blank drop-off's window at the completion date).
 * Closed months and months before FROM are listed unchanged; a closed FROM is
 * refused (exit 2), as is a flag already on in the .env.
 *
 * Fixture (investor 5, split 50%), made-up data only:
 *   P101  Amy Birch $300/day  pickup blank, Assigned Mon 10/5, drop-off 10/7,
 *                             completed 10/7: the invoice pays no day today, 10/5-10/7
 *                             with the flag; her W41 invoice (10/3-10/9) is Approved
 *   P201  Bo Wyn    $260/day  pickup 10/5, drop-off blank, completed 10/7: the ledger
 *                             pays 10/5 today, 10/5-10/7 with the flag (+$520 driver
 *                             pay, -$260 payable)
 *   P301  Amy Birch           September (closed): pickup blank, Assigned 9/21,
 *                             drop-off 9/23, completed 9/23
 *   P302  Bo Wyn              September (closed): pickup 9/21, drop-off blank,
 *                             completed 9/23
 *
 * Shipping code lifted from server.js (scripts/lib/work-days-world.js). Pure: no
 * server, no app.db, no network.
 * Run: node scripts/test-blank-pickup-dry-run.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");
const { loadRow } = W;

const AMY = "Amy Birch";
const BO = "Bo Wyn";
const NOW = Date.parse("2026-10-12T16:00:00Z");
const SCRIPT = "scripts/blank-pickup-dry-run.js";

function fixture() {
	const w = W.startWorld({
		env: {},
		drivers: [{ name: AMY, payDaily: 300 }, { name: BO, payDaily: 260 }],
		trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: BO }],
		rows: [
			loadRow({ id: "P101", driver: AMY, pickup: "", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "P201", driver: BO, pickup: "2026-10-05 8:00", dropoff: "", assigned: "2026-10-05", done: "2026-10-07", truck: "T2" }),
			loadRow({ id: "P301", driver: AMY, pickup: "", dropoff: "2026-09-23 18:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" }),
			loadRow({ id: "P302", driver: BO, pickup: "2026-09-21 8:00", dropoff: "", assigned: "2026-09-21", done: "2026-09-23", truck: "T2" }),
		],
		locks: ["2026-09"],
		now: NOW,
	});
	return w;
}
const argsFor = (copy, extra) => [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, ...extra];

async function outputs() {
	const w = fixture();
	// Amy's W41 invoice, made today ($0: the blank-pickup load pays no day), then approved.
	const g = await W.generate(w, AMY, "2026-10-09");
	if (g.status !== 200) throw new Error(`generate: ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
	w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g.invoice.id);
	const copy = W.saveCopy(w, {});
	const before = W.fileHash(copy.db);
	const run = W.runScript(SCRIPT, argsFor(copy, ["--invoice-from=2026-10", "--ledger-from=2026-10", "--json"]));
	const text = W.runScript(SCRIPT, argsFor(copy, ["--invoice-from=2026-10", "--ledger-from=2026-10"]));
	return { w, g, copy, run, text, fileBefore: before, fileAfter: W.fileHash(copy.db) };
}
function requireJson(ok, o) {
	ok("script exits 0 with JSON", o.run.code === 0 && !!o.run.json, (o.run.stderr || o.run.stdout).slice(0, 300));
}

const R = W.createRunner("Money plan D: the blank-appointment dry run (scripts/blank-pickup-dry-run.js)");

(async () => {
	let shared = null;
	const get = async () => (shared || (shared = await outputs()));

	await R.test("P1 Read-only: the script leaves its database file byte for byte, and its text report runs too", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		eq("the database file unchanged", o.fileAfter, o.fileBefore);
		ok("the text report exits 0 and says nothing was written", o.text.code === 0 && /Nothing was written/.test(o.text.stdout), (o.text.stderr || o.text.stdout).slice(0, 300));
	});

	await R.test("P2 Driver pay: Amy's week 10/3-10/9 pays no day today and 10/5-10/7 ($900) with the invoice flag; P101 is the load it starts at the Assigned Date", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		const inv = o.run.json && o.run.json.invoice;
		ok("an invoice section", !!inv, JSON.stringify(o.run.json).slice(0, 200));
		const week = inv && inv.weeks.find((x) => x.weekStart === "2026-10-03");
		ok("a line for the week of 2026-10-03", !!week, JSON.stringify(inv && inv.weeks));
		if (!week) return;
		eq("[days now, days with the flag, added]", [week.daysNow, week.daysWithFlag, week.addedDays], [[], ["2026-10-05", "2026-10-06", "2026-10-07"], ["2026-10-05", "2026-10-06", "2026-10-07"]]);
		eq("[amount now, with the flag, delta]", [week.amountNow, week.amountWithFlag, week.delta], [0, 900, 900]);
		eq("the load", week.loadIds, ["P101"]);
		eq("drivers are labels without --names", /^driver \d+$/.test(week.driver), true);
	});

	await R.test("P3 An issued invoice is not regenerated: Amy's Approved W41 is named, the $900 is listed as not paid until a person adds it", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		const inv = o.run.json && o.run.json.invoice;
		const week = inv && inv.weeks.find((x) => x.weekStart === "2026-10-03");
		ok("the week's invoice", !!(week && week.invoice), JSON.stringify(week));
		if (!week || !week.invoice) return;
		eq("[number, status]", [week.invoice.invoiceNumber, week.invoice.status], [o.g.invoice.invoice_number, "Approved"]);
		ok("once on: issued, not regenerated", /^issued \(Approved\)/.test(week.afterSwitchOn), week.afterSwitchOn);
		eq("[issued weeks, amount not paid]", [inv.summary.issuedWeeks, inv.summary.issuedAmountNotPaid], [1, 900]);
	});

	await R.test("P4 Payouts: Bo's P201 gains 10/6 and 10/7 in October's ledger with the ledger flag: driver pay +$520, investor 5's October payable -$260 (split 50%)", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		const led = o.run.json && o.run.json.ledger;
		ok("a ledger section", !!led, JSON.stringify(o.run.json).slice(0, 200));
		if (!led) return;
		const days = led.perDay.filter((d) => d.ownerId === 5).map((d) => `${d.loadId} ${d.month} ${d.day} ${d.change} ${d.amount}`);
		eq("investor 5's changed days", days, ["P201 2026-10 2026-10-06 added 260", "P201 2026-10 2026-10-07 added 260"]);
		const oct = led.investorMonths.find((m) => m.ownerId === 5 && m.period === "2026-10");
		ok("investor 5's October", !!oct, JSON.stringify(led.investorMonths));
		if (oct) eq("[driver pay change, payable change]", [oct.driverPayChange, oct.delta], [520, -260]);
		eq("[loads, days added, driver pay]", [led.summary.loads, led.summary.daysAdded, led.summary.driverPayChange].map(Number), [1, 2, 520]);
	});

	await R.test("P5 The sections stay apart: the invoice section never lists the blank drop-off load (the invoice already pays it), the ledger section never the blank-pickup load (the ledger already pays it)", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		const j = o.run.json || {};
		eq("invoice loads", (j.invoice ? j.invoice.loads : []).map((l) => l.loadId), ["P101"]);
		eq("ledger loads", (j.ledger ? j.ledger.loads : []).map((l) => l.loadId), ["P201"]);
	});

	await R.test("P6 Closed September is listed unchanged and nothing before FROM moves: P301 and P302 (September, closed) appear in neither section", async ({ eq, ok }) => {
		const o = await get();
		requireJson(ok, o);
		const j = o.run.json || {};
		eq("[closed months, unchanged, before FROM unchanged, problems]", [j.closedMonths, j.closedMonthsUnchanged, j.monthsBeforeFromUnchanged, j.problems], [["2026-09"], true, true, []]);
		const all = JSON.stringify([j.invoice, j.ledger]);
		ok("no September load or day in either section", !/P30[12]|2026-09-2/.test(all), all.slice(0, 300));
	});

	await R.test("P7 Refused (exit 2): a FROM at or before the latest closed month (each section), a FROM that is not a month, and no FROM at all", async ({ eq }) => {
		const o = await get();
		const code = (extra) => W.runScript(SCRIPT, argsFor(o.copy, [...extra, "--json"])).code;
		eq("[invoice 2026-09, ledger 2026-09, invoice 2026-13, none]",
			[code(["--invoice-from=2026-09"]), code(["--ledger-from=2026-09"]), code(["--invoice-from=2026-13"]), code([])], [2, 2, 2, 2]);
	});

	await R.test("P8 Refused (exit 2) when the .env already has the flag on: today would already include it; the other section still runs", async ({ eq }) => {
		const o = await get();
		const on = W.saveCopy(o.w, { INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2026-10" });
		const refused = W.runScript(SCRIPT, argsFor(on, ["--invoice-from=2026-10", "--json"]));
		const other = W.runScript(SCRIPT, argsFor(on, ["--ledger-from=2026-10", "--json"]));
		eq("[invoice section, ledger section]", [refused.code, other.code], [2, 0]);
	});

	R.finish();
})();
