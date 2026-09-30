"use strict";
// The downloadable investor report's choices, in the one place to change them.
//
// Read by GET /api/investor/report (the PDF), GET /api/investor/tax-csv and
// GET /api/investor (which hands RANGE_MODE to the client as reportRangeMode).
// Each choice is one switch or one text table below. The owner approved the
// settings shipped here on 2026-09-30, pending the client's review.
//
// ⚠️ Every sentence and label here reaches an investor, in a document that leaves
// the app. docs/investor-portal-copy.md §16 lists each one for the client's
// sign-off (§17 the lease ones): change a text here and change it there too.
//
// ⚠️ client/src/lib/investorReportText.js keeps its own copy of RANGE_HINT (the
// client cannot require this file); change both.
//
// Pure: no I/O and no requires, so a runner can load it on its own.
// scripts/test-investor-report-options.js.

// ---- Choice: a date range that starts or ends mid-month ---------------------
//   "whole-months"  every line of the report covers the whole of each month the
//                   range touches: the start moves to the 1st of its month and the
//                   end to the last day of its month.
//   "exact-dates"   revenue and trip expenses cover the exact dates chosen, while
//                   driver pay, the fixed costs and the payout cover whole months
//                   (the report's behaviour before 2026-09-30).
const RANGE_MODE = "whole-months";

// ---- Choice: a truck with no recorded purchase price ------------------------
//   "not-available" a per-truck figure is the average over the trucks that have a
//                   price ("Not recorded" when none has one); a figure that needs
//                   every truck's price reads "Not available" while any truck lacks
//                   one; the report prints FOOTNOTE and the CSV a count row.
//   "zero"          such a truck is priced at $0, with no footnote and no count
//                   row (the behaviour before 2026-09-30).
// A price counts as recorded when trucks.purchase_price > 0.
const UNPRICED_TRUCKS = "not-available";

const RANGE_MODES = Object.freeze(["whole-months", "exact-dates"]);
const UNPRICED_TRUCK_MODES = Object.freeze(["not-available", "zero"]);

// ---- The payout row's label in the report's Income Statement -----------------
//   SPLIT  every month in the report is paid as a share of net profit: the label
//          the report has always printed, {pct} the investor's split % (50 prints
//          "Investor Payout (50%)")
//   LEASE  every month in the report is paid as a fixed monthly lease
//   MIXED  the report covers months of both kinds
const PAYOUT_LABEL = Object.freeze({
	SPLIT: "Investor Payout ({pct}%)",
	LEASE: "Investor Payout (fixed monthly lease)",
	MIXED: "Investor Payout",
});

// ---- The line printed under the report's Income Statement --------------------
// Templates: {span} is "May 2026" or "May 2026 – August 2026" (SPAN), {month} one
// month, {months} a list ("May 2026 and June 2026"), {amount} a monthly lease in
// whole dollars ("$2,000"). The sentences are joined with a space, in this order:
// the date-range sentence (only when a range was given), then either NO_MONTHS or
// the lead (INVESTOR / FLEET) followed by any of LEASE / LEASE_FROM, IN_PROGRESS,
// CARRIED, SETTLED_DIFFERS_*, CORRECTED that apply. LEASE is for a report whose
// every month is paid as a fixed monthly lease; LEASE_FROM for one where the lease
// starts partway through, {month} being its first lease month.
const NOTE = Object.freeze({
	RANGE_WHOLE_MONTHS: "Payouts are settled by month, so this report covers the whole of each month in your date range: {span}.",
	RANGE_WHOLE_MONTHS_FLEET: "Payouts are settled by month, so this report covers the whole of each month in the date range: {span}.",
	RANGE_EXACT_DATES: "Driver Pay, the fixed costs and Investor Payout cover whole months; revenue and trip expenses cover the exact dates you chose.",
	NO_MONTHS: "No payout month falls in this report period.",
	INVESTOR: "Investor Payout is the total of your monthly payouts for {span}, the same figures as your Payouts page.",
	FLEET: "Investor Payout is the total of the fleet-wide monthly investor shares for {span}.",
	IN_PROGRESS: "{month} is still in progress, so its figure is the projected payout if the month closed today.",
	CARRIED: "A month that ran at a loss pays nothing; the shortfall is carried against later months rather than billed back to you.",
	SETTLED_DIFFERS_ONE: "Your payout for {months} is the amount that month was settled at. The figures above reflect current records, which have changed since it closed.",
	SETTLED_DIFFERS_MANY: "Your payouts for {months} are the amounts those months were settled at. The figures above reflect current records, which have changed since they closed.",
	CORRECTED: "The payout for {months} includes a correction shown on your Payouts page.",
	LEASE: "Your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	LEASE_FROM: "From {month}, your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	// A span of months. SPAN_FROM / SPAN_UNTIL are for a date range with one end
	// left open (a start date only, or an end date only).
	SPAN: "{first} – {last}",
	SPAN_FROM: "{first} onward",
	SPAN_UNTIL: "through {last}",
});

// ---- Trucks with no recorded purchase price (UNPRICED_TRUCKS "not-available") --
const UNPRICED_TEXT = Object.freeze({
	NOT_RECORDED: "Not recorded",
	NOT_AVAILABLE: "Not available",
	FOOTNOTE: "Purchase price not recorded for {n} of {total} truck(s). Figures that need it show \"Not available\" until it is entered in the Truck Database.",
	CSV_COUNT_LABEL: "Trucks without a recorded purchase price",
});

// ---- The hint under the portal's report date inputs (RANGE_MODE "whole-months") --
const RANGE_HINT = "Reports cover whole months: a date range that starts or ends mid-month includes that whole month, because payouts are settled by month.";

// ---- A report date the server refuses (400) ----------------------------------
const DATE_ERRORS = Object.freeze({
	INVALID_DATE: "The {field} date must be a real date written as YYYY-MM-DD.",
	INVALID_RANGE: "The start date is after the end date.",
});

function assertMode(mode, allowed, name) {
	if (!allowed.includes(mode)) throw new Error(`${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(mode)}`);
}
// A typo in a switch above stops the server at start-up (and fails the unit
// runner in CI) rather than quietly picking a behaviour nobody chose.
assertMode(RANGE_MODE, RANGE_MODES, "RANGE_MODE");
assertMode(UNPRICED_TRUCKS, UNPRICED_TRUCK_MODES, "UNPRICED_TRUCKS");

// Fills {name} placeholders. A placeholder with no value is left as written, so
// a missing value shows in the output instead of printing "undefined".
function fill(template, values = {}) {
	return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
		(Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole));
}

function daysInMonth(year, month) {
	if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

// One end of a range: "" when empty or missing (unbounded), else exactly
// YYYY-MM-DD naming a real calendar day. Checked by arithmetic, never by Date:
// new Date("2026-02-30") is a valid Date (March 2), and a bare date is UTC midnight.
function readDay(value) {
	if (value === undefined || value === null || value === "") return { ok: true, day: "" };
	if (typeof value !== "string") return { ok: false };
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return { ok: false };
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { ok: false };
	return { ok: true, day: value, year, month };
}

// The report's date range, from the raw `start` / `end` query values.
//   { ok: true, from, until, widened }  from / until are "YYYY-MM-DD", or "" for an
//     open end. In "whole-months" mode `from` is the 1st of its month and `until`
//     the last day of its month, and `widened` says whether either end moved; in
//     "exact-dates" mode both are the dates as given.
//   { ok: false, status: 400, code: "INVALID_DATE", field: "start" | "end", error }
//   { ok: false, status: 400, code: "INVALID_RANGE", error }  start after end
// The report handler calls this before it reads or writes anything.
function reportDateRange(start, end, mode = RANGE_MODE) {
	assertMode(mode, RANGE_MODES, "mode");
	const s = readDay(start);
	if (!s.ok) return { ok: false, status: 400, code: "INVALID_DATE", field: "start", error: fill(DATE_ERRORS.INVALID_DATE, { field: "start" }) };
	const e = readDay(end);
	if (!e.ok) return { ok: false, status: 400, code: "INVALID_DATE", field: "end", error: fill(DATE_ERRORS.INVALID_DATE, { field: "end" }) };
	if (s.day && e.day && s.day > e.day) return { ok: false, status: 400, code: "INVALID_RANGE", error: DATE_ERRORS.INVALID_RANGE };
	if (mode === "exact-dates") return { ok: true, from: s.day, until: e.day, widened: false };
	const from = s.day ? `${s.day.slice(0, 7)}-01` : "";
	const until = e.day ? `${e.day.slice(0, 7)}-${String(daysInMonth(e.year, e.month)).padStart(2, "0")}` : "";
	return { ok: true, from, until, widened: from !== s.day || until !== e.day };
}

// What the documents print for the trucks' purchase prices, from
// investorTruckPurchase()'s { trucks, pricedCount, unpricedCount,
// totalPurchasePrice, purchasePrice }.
//   perTruck  the per-truck price, or null: print UNPRICED_TEXT.NOT_RECORDED
//   total     the fleet's total price, or null: print UNPRICED_TEXT.NOT_AVAILABLE,
//             and the same for every figure computed from it
//   flagged   print FOOTNOTE (the report) / the CSV_COUNT_LABEL row (the CSV)
//   unpricedCount, truckCount  for FOOTNOTE's {n} and {total}
// "zero" returns exactly the figures the documents printed before 2026-09-30: a
// truck without a price counts as $0, and "per truck" is the one truck's price or
// the average over every truck.
function truckPriceFigures(purchase, mode = UNPRICED_TRUCKS) {
	assertMode(mode, UNPRICED_TRUCK_MODES, "mode");
	const truckCount = purchase.trucks.length;
	if (mode === "zero") {
		const perTruck = truckCount === 1
			? (purchase.purchasePrice || 0)
			: (truckCount > 0 ? Math.round(purchase.totalPurchasePrice / truckCount) : 0);
		return { perTruck, total: purchase.totalPurchasePrice, flagged: false, unpricedCount: purchase.unpricedCount, truckCount };
	}
	return {
		perTruck: purchase.pricedCount > 0 ? purchase.purchasePrice : null,
		total: purchase.unpricedCount > 0 ? null : purchase.totalPurchasePrice,
		flagged: purchase.unpricedCount > 0,
		unpricedCount: purchase.unpricedCount,
		truckCount,
	};
}

module.exports = {
	RANGE_MODE,
	UNPRICED_TRUCKS,
	RANGE_MODES,
	UNPRICED_TRUCK_MODES,
	PAYOUT_LABEL,
	NOTE,
	UNPRICED_TEXT,
	RANGE_HINT,
	DATE_ERRORS,
	fill,
	reportDateRange,
	truckPriceFigures,
};
