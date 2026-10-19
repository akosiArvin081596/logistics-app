#!/usr/bin/env node
/**
 * Money plan D (2026-10-15, B12 review finding F2): a completed load with a
 * blank Pickup Appointment is paid differently by the three pay paths that
 * must move together (.claude/rules/path-backend.md, "Driver pay active
 * days"):
 *   - the weekly invoice (POST /api/invoices/generate) skips the load: no day
 *     is paid (`if (!pickup) continue;` in generateInvoiceHandler());
 *   - the payout ledger (lib/financials-calc.js computeLedgerScope()) and the
 *     investor view (GET /api/investor) start the load's window at its
 *     Assigned Date and pay Assigned Date .. Drop-off Appointment.
 * A pickup cell that is not a date ("TBD") does the same. The mirror case: a
 * blank Drop-off Appointment, where the invoice runs the window to the
 * completion date and the ledger and the investor view pay the pickup day only.
 *
 * Two flags, so driver pay and investor payouts are approved separately; each
 * applies to loads whose Assigned month (the month their days settle in) is
 * its FROM or later:
 *   INVOICE_BLANK_PICKUP_FALLBACK_ENABLED / _FROM   driver pay (D-D1 a): the
 *     invoice starts a blank or non-date pickup's window at the Assigned Date,
 *     as the ledger does; ELD check and pre-dispatch rule as today;
 *   LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED / _FROM   investor payouts (D-D4 i):
 *     the ledger and the investor view end a blank drop-off's window at the
 *     completion date, as the invoice does.
 *
 * Written before the fix. Fail on main: D1-D4 (invoice flag on, FROM=2026-10)
 * and D8 (ledger flag on): D8 checks the direction, so a fix that cut the
 * invoice back to the pickup day would fail it. Pass on main and pin what must
 * not move: D5 a pickup on file; D6 both flags off, exactly today; D7 a week
 * before FROM; D9 and D10 each flag moves only its own side; D11 the ledger
 * flag before FROM.
 *
 * The three paths run lifted from server.js (scripts/lib/money-plans-world.js
 * on scripts/lib/work-days-world.js). Made-up data only: one driver at $300 a
 * day on investor 5's truck. Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-blank-pickup-pay-days.js    # exits 1 on failure
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
const { loadRow } = M;

const INVOICE_ON = { INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2026-10" };
const LEDGER_ON = { LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED: "true", LEDGER_BLANK_DROPOFF_FALLBACK_FROM: "2026-10" };
const OFF = {};
const AMY = "Amy Birch";
const NOW = Date.parse("2026-10-12T16:00:00Z");
const OCT_WEEK = "2026-10-09"; // Sat 10/3 - Fri 10/9
const SEP_WEEK = "2026-09-25"; // Sat 9/19 - Fri 9/25

// The days each path pays the driver: the weekly invoice's day grid, the
// ledger's driver_pay items and the investor view's day rows.
async function paths(w, weekEnd = OCT_WEEK) {
	const g = await M.generate(w, AMY, weekEnd);
	if (g.status !== 200) throw new Error(`invoice: ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
	const led = await M.ledger(w);
	const inv = await M.investorDays(w);
	return {
		invoice: M.dayList(M.gridDays(g.data, weekEnd)),
		invoiceTotal: g.invoice ? g.invoice.total_earnings : null,
		ledger: [...new Set(led.pay.map((p) => p.day))].sort(),
		investor: [...new Set(inv.days.map((d) => d.day))].sort(),
	};
}
function world(env, row, opts = {}) {
	return M.startWorld({ env, drivers: [{ name: AMY, payDaily: 300 }], rows: [row], now: NOW, ...opts });
}
// Assigned Mon 10/5, delivered Wed 10/7 18:00, completed 10/7; pickup blank.
const blankPickup = (extra = {}) => loadRow({ id: "D101", driver: AMY, pickup: "", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1", ...extra });
// Pickup 10/5, drop-off blank, completed 10/7.
const blankDropoff = (extra = {}) => blankPickup({ pickup: "2026-10-05 8:00", dropoff: "", ...extra });
const OCT_DAYS = ["2026-10-05", "2026-10-06", "2026-10-07"];

const R = M.createRunner("Money plan D: a blank Pickup (or Drop-off) Appointment pays the same days on the invoice, the ledger and the investor view");

(async () => {
	await R.test("D1 Invoice flag on (FROM 2026-10): blank pickup, no ELD: invoice, ledger and investor view pay the same days. Base: invoice none", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankPickup()));
		eq("invoice = ledger", p.invoice, p.ledger);
		eq("investor view = ledger", p.investor, p.ledger);
	});

	await R.test("D2 (D-D1 a) Invoice flag on: all three pay Assigned 10/5 .. Drop-off 10/7, $900 on the invoice. Base: invoice $0", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankPickup()));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
		eq("invoice total", p.invoiceTotal, 900);
	});

	await R.test("D3 Invoice flag on: blank pickup on an ELD truck parked on the Assigned day: the ELD check drops 10/5 on every path; all three pay 10/6, 10/7. Base: invoice none", async ({ eq }) => {
		const f = M.feed(1000).park("2026-10-05").drive("2026-10-06", { miles: 320 }).drive("2026-10-07", { miles: 280 });
		const p = await paths(world(INVOICE_ON, blankPickup(), { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: f.pings } }));
		const want = ["2026-10-06", "2026-10-07"];
		eq("days", [p.invoice, p.ledger, p.investor], [want, want, want]);
	});

	await R.test("D4 Invoice flag on: a pickup cell that is not a date (\"TBD\") pays as a blank one: all three 10/5-10/7. Base: invoice none", async ({ eq }) => {
		const row = blankPickup();
		row["Pickup Appointment"] = "TBD";
		const p = await paths(world(INVOICE_ON, row));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D5 Control, both flags on: pickup 10/5 and drop-off 10/7 on file: all three pay 10/5-10/7", async ({ eq }) => {
		const p = await paths(world({ ...INVOICE_ON, ...LEDGER_ON }, blankPickup({ pickup: "2026-10-05 8:00" })));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D6 Both flags off: nothing changes: blank pickup pays no invoice day ($0), ledger and investor view 10/5-10/7; blank drop-off pays the invoice 10/5-10/7, ledger and investor view 10/5", async ({ eq }) => {
		const a = await paths(world(OFF, blankPickup()));
		eq("blank pickup [invoice, ledger, investor, invoice total]", [a.invoice, a.ledger, a.investor, a.invoiceTotal], [[], OCT_DAYS, OCT_DAYS, 0]);
		const b = await paths(world(OFF, blankDropoff()));
		eq("blank drop-off [invoice, ledger, investor]", [b.invoice, b.ledger, b.investor], [OCT_DAYS, ["2026-10-05"], ["2026-10-05"]]);
	});

	await R.test("D7 Invoice flag on, FROM 2026-10: a September-assigned blank-pickup load (Assigned 9/21, drop-off 9/23, week ending 9/25) is paid exactly as today: no invoice day, ledger and investor view 9/21-9/23", async ({ eq }) => {
		const row = loadRow({ id: "D701", driver: AMY, pickup: "", dropoff: "2026-09-23 18:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" });
		const p = await paths(world(INVOICE_ON, row), SEP_WEEK);
		const sep = ["2026-09-21", "2026-09-22", "2026-09-23"];
		eq("[invoice, ledger, investor]", [p.invoice, p.ledger, p.investor], [[], sep, sep]);
	});

	await R.test("D8 (D-D4 i) Ledger flag on (FROM 2026-10): blank drop-off, pickup 10/5, completed 10/7: the ledger and the investor view extend to the completion date like the invoice; all three pay 10/5-10/7 (a fix cutting the invoice back fails this). Base: ledger and investor view 10/5 only", async ({ eq }) => {
		const p = await paths(world(LEDGER_ON, blankDropoff()));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D9 Invoice flag on alone: the payout side does not move: blank drop-off still pays the ledger and the investor view 10/5 only", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankDropoff()));
		eq("[ledger, investor]", [p.ledger, p.investor], [["2026-10-05"], ["2026-10-05"]]);
	});

	await R.test("D10 Ledger flag on alone: driver pay does not move: a blank-pickup load still pays no invoice day", async ({ eq }) => {
		const p = await paths(world(LEDGER_ON, blankPickup()));
		eq("[invoice, invoice total]", [p.invoice, p.invoiceTotal], [[], 0]);
	});

	await R.test("D11 Ledger flag on, FROM 2026-10: a September-assigned blank-drop-off load (pickup 9/21, completed 9/23) keeps the ledger and investor view at 9/21 only", async ({ eq }) => {
		const row = loadRow({ id: "D1101", driver: AMY, pickup: "2026-09-21 8:00", dropoff: "", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" });
		const p = await paths(world(LEDGER_ON, row), SEP_WEEK);
		eq("[ledger, investor]", [p.ledger, p.investor], [["2026-09-21"], ["2026-09-21"]]);
	});

	R.finish();
})();
