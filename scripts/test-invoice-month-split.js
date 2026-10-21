#!/usr/bin/env node
/**
 * lib/invoice-month-split.js: one driver invoice's share of each month in the
 * Financials driver table (money plan C, decisions C-D1 to C-D3).
 *
 *   S1  days follow the books' month; a day the books do not pay, its own month
 *   S2  the adjustment, the returned Personal share and the gap: once, in
 *       week_end's month, named in `unsplit`, never spread
 *   S3  an owner-operator invoice splits by its loads' rates
 *   S4  no days and no loads: prorated by calendar days, the rounding in the
 *       later month
 *   S5  the shares add up to the invoiced amount exactly, on many generated invoices
 *   S6  a $0 invoice counts once, at $0, in week_end's month; an unreadable
 *       period counts whole in week_end's month
 *   S7  monthInvoiceTotals(): per driver, the month's share, its adjustments and
 *       the split count; rows without the month or a driver are skipped
 *
 * Made-up data only. Pure: no server, no database, no network.
 * Run: node scripts/test-invoice-month-split.js    # exits 1 on failure
 */
"use strict";

const path = require("path");
const S = require(path.join(__dirname, "..", "lib", "invoice-month-split.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
	const problems = [];
	const eq = (label, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a !== e) problems.push(`${label}\n             expected ${e}\n             actual   ${a}`);
	};
	try {
		fn(eq);
	} catch (err) {
		problems.push(`threw: ${String((err && err.message) || err).split("\n")[0]}`);
	}
	if (problems.length) failed++; else passed++;
	console.log(`  ${problems.length ? "FAIL" : "ok  "}  ${name}`);
	for (const p of problems.slice(0, 4)) console.log(`        - ${p}`);
}

const W39 = { driver: "amy birch", week_start: "2026-09-26", week_end: "2026-10-02", total_earnings: 1200, adjustment: 0, personal_share_total: 0, render_data: "{}" };
const GRID_DAYS = ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"];
const at300 = () => 300;

console.log("lib/invoice-month-split.js: an invoice's share of each month");

test("S1 Each paid day counts in the books' month for that driver-day; a day the books do not pay counts in its own month", (eq) => {
	const books = { "amy birch\t2026-09-28": "2026-09", "amy birch\t2026-09-29": "2026-09", "amy birch\t2026-10-01": "2026-09" };
	const r = S.invoiceMonthShares(W39, { paidDays: GRID_DAYS, dayAmount: at300, booksMonthOf: (d, day) => books[`${d}\t${day}`] || "" });
	eq("shares", r.shares, { "2026-09": 90000, "2026-10": 30000 });
	eq("method and split", [r.method, r.split, r.months], ["days", true, ["2026-09", "2026-10"]]);
	eq("the unpaid day's part", r.parts.find((p) => p.day === "2026-10-02"), { kind: "day", day: "2026-10-02", month: "2026-10", cents: 30000 });
	const bad = S.invoiceMonthShares(W39, { paidDays: GRID_DAYS, dayAmount: at300, booksMonthOf: () => "not a month" });
	eq("an answer that is not a month reads as unpaid", bad.shares, { "2026-09": 60000, "2026-10": 60000 });
});

test("S2 Adjustment, returned Personal share and gap count once in week_end's month, named in unsplit", (eq) => {
	const inv = { ...W39, total_earnings: 1250, adjustment: -100, personal_share_total: 40 };
	const r = S.invoiceMonthShares(inv, { paidDays: GRID_DAYS, dayAmount: at300 });
	eq("shares", r.shares, { "2026-09": 60000, "2026-10": 60000 + 5000 - 10000 + 4000 });
	eq("unsplit", r.unsplit, { month: "2026-10", adjustmentCents: -10000, personalShareCents: 4000, gapCents: 5000 });
	eq("invoiced", r.invoicedCents, 125000 - 10000 + 4000);
	const back = S.invoiceMonthShares({ ...W39, week_end: "2026-10-02", total_earnings: 1100 }, { paidDays: GRID_DAYS, dayAmount: at300 });
	eq("a negative gap (total below the days) lands in week_end's month", [back.shares, back.unsplit.gapCents], [{ "2026-09": 60000, "2026-10": 50000 }, -10000]);
});

test("S3 An owner-operator invoice splits its earnings by its loads' rates, each in its load's books month, else the load's own date, else week_end's month", (eq) => {
	const snap = { __templateName: "service_invoice_owner_op", loads: [{ loadId: " L1 ", rate: 2000, date: "2026-09-29" }, { loadId: "L2", rate: 1000, date: "2026-10-01" }] };
	const r = S.invoiceMonthShares({ ...W39, total_earnings: 900, render_data: JSON.stringify(snap) }, { loadMonthOf: (id) => ({ L1: "2026-09", L2: "2026-10" })[id] || "" });
	eq("shares", [r.method, r.shares], ["loads", { "2026-09": 60000, "2026-10": 30000 }]);
	const fallback = S.invoiceMonthShares({ ...W39, total_earnings: 900, render_data: snap }, { loadMonthOf: () => "" });
	eq("no books month: the load's own date", fallback.shares, { "2026-09": 60000, "2026-10": 30000 });
	const noDate = { __templateName: "service_invoice_owner_op", loads: [{ loadId: "L1", rate: 1 }, { loadId: "L2", rate: 2 }] };
	const thirds = S.invoiceMonthShares({ ...W39, total_earnings: 100, render_data: noDate }, { loadMonthOf: (id) => (id === "L1" ? "2026-09" : "") });
	eq("cents add up; no date: week_end's month", thirds.shares, { "2026-09": 3333, "2026-10": 6667 });
	const zero = S.invoiceMonthShares({ ...W39, total_earnings: 900, render_data: { __templateName: "service_invoice_owner_op", loads: [{ loadId: "L1", rate: 0 }] } });
	eq("loads without a rate: prorated by calendar days", zero.method, "calendar");
});

test("S4 No days and no loads: prorated by the period's calendar days in each month, the rounding in the later month", (eq) => {
	const r = S.invoiceMonthShares({ ...W39, total_earnings: 1500 });
	eq("5 days in September, 2 in October", [r.method, r.shares], ["calendar", { "2026-09": 107143, "2026-10": 42857 }]);
	eq("parts", r.parts.map((p) => [p.month, p.days, p.cents]), [["2026-09", 5, 107143], ["2026-10", 2, 42857]]);
	const inside = S.invoiceMonthShares({ ...W39, week_start: "2026-10-10", week_end: "2026-10-16", total_earnings: 700 });
	eq("a week inside one month", [inside.shares, inside.split], [{ "2026-10": 70000 }, false]);
	const long = S.invoiceMonthShares({ ...W39, week_start: "2026-08-20", week_end: "2026-10-10", total_earnings: 1000 });
	eq("a manual period over three months adds up", Object.values(long.shares).reduce((s, c) => s + c, 0), 100000);
	eq("its months", long.months, ["2026-08", "2026-09", "2026-10"]);
});

test("S5 The shares add up to the invoiced amount exactly (2,000 generated invoices)", (eq) => {
	let seed = 7;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const money = () => Math.round(rnd() * 300000) / 100;
	let bad = 0;
	let first = null;
	for (let i = 0; i < 2000; i++) {
		const kind = i % 3;
		const inv = { ...W39, total_earnings: money(), adjustment: rnd() < 0.3 ? -money() / 10 : 0, personal_share_total: rnd() < 0.2 ? money() / 20 : 0 };
		let opts = {};
		if (kind === 0) {
			const days = GRID_DAYS.filter(() => rnd() < 0.7);
			opts = { paidDays: days, dayAmount: () => Math.round(rnd() * 40000) / 100, booksMonthOf: () => (rnd() < 0.5 ? "2026-09" : "") };
		} else if (kind === 1) {
			inv.render_data = { __templateName: "service_invoice_owner_op", loads: [1, 2, 3].map((n) => ({ loadId: `L${n}`, rate: money() })) };
			opts = { loadMonthOf: (id) => (id === "L2" ? "2026-09" : "2026-10") };
		}
		const r = S.invoiceMonthShares(inv, opts);
		const sum = Object.values(r.shares).reduce((s, c) => s + c, 0);
		const invoiced = Math.round(inv.total_earnings * 100) + Math.round(inv.adjustment * 100) + Math.round(inv.personal_share_total * 100);
		if (sum !== invoiced || r.invoicedCents !== invoiced) { bad++; if (!first) first = { inv, shares: r.shares, invoiced }; }
	}
	eq("invoices whose shares miss the invoiced amount", [bad, first], [0, null]);
});

test("S6 A $0 invoice counts once at $0 in week_end's month; an unreadable period counts whole in week_end's month", (eq) => {
	const zero = S.invoiceMonthShares({ ...W39, total_earnings: 0 });
	eq("$0", [zero.shares, zero.split], [{ "2026-10": 0 }, false]);
	const odd = S.invoiceMonthShares({ ...W39, week_start: "garbage", total_earnings: 500 });
	eq("unreadable week_start", [odd.method, odd.shares], ["whole", { "2026-10": 50000 }]);
	const backwards = S.invoiceMonthShares({ ...W39, week_start: "2026-10-09", week_end: "2026-10-02", total_earnings: 500 });
	eq("week_start after week_end", [backwards.method, backwards.shares], ["whole", { "2026-10": 50000 }]);
	eq("prorate keeps the total with no weight", S.prorate(123, [0, 0]), [0, 123]);
});

test("S7 monthInvoiceTotals(): the month's shares, its adjustments (week_end's month only) and the split count, per driver", (eq) => {
	const a = { driver: "amy birch", ...S.invoiceMonthShares({ ...W39, adjustment: 100 }, { paidDays: GRID_DAYS, dayAmount: at300 }) };
	const b = { driver: "amy birch", ...S.invoiceMonthShares({ ...W39, week_start: "2026-10-03", week_end: "2026-10-09", total_earnings: 300 }) };
	const c = { driver: "", ...S.invoiceMonthShares({ ...W39 }) };
	const sep = S.monthInvoiceTotals([a, b, c], "2026-09");
	const oct = S.monthInvoiceTotals([a, b, c], "2026-10");
	eq("September", { ...sep["amy birch"] }, { count: 1, invoicedCents: 60000, adjustmentCents: 0, splitCount: 1 });
	eq("October", { ...oct["amy birch"] }, { count: 2, invoicedCents: 70000 + 30000, adjustmentCents: 10000, splitCount: 1 });
	eq("no row for a blank driver, and a null-prototype result", [Object.keys(oct), Object.getPrototypeOf(oct)], [["amy birch"], null]);
	eq("a month no invoice holds", Object.keys(S.monthInvoiceTotals([a, b], "2026-11")), []);
});

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
process.exit(failed ? 1 : 0);
