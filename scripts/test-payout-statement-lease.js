#!/usr/bin/env node
/**
 * lib/payout-statement.js — the statement PDF for a month paid as a fixed
 * monthly lease, and the split statement left exactly as it was.
 *
 * WHAT IS PROVED HERE
 *   §1  a SPLIT statement (no breakdown.payoutBasis) is byte-identical to the one
 *       61406a1 printed under the Houston clock: eight representative rows (carry
 *       in, loss deferred, a correction after payment, drift, no breakdown,
 *       maintenance and compliance costs, an empty appendix) hashed against pins
 *       computed from that commit's module, and a one-word change to the split
 *       wording moves a pin. The one exception is the month that ran at a loss,
 *       which no longer prints a change note beside its settled $0 (§7)
 *   §2  a lease month (breakdown.payoutBasis): "How your payment is calculated",
 *       the monthly lease, the reason line for a prorated, downtime or
 *       not-in-service month, what the month pays, the shared settled-amount and
 *       adjustment rows; the explanation under the amount paid as the caption of
 *       the truck's revenue and costs; the loss-month note only for a loss month
 *       that paid the full lease; and no split or carry wording anywhere
 *   §3  the drift note on a lease page compares the settled amount with the
 *       amount the lease paid, never share minus carry
 *   §4  LEASE_TEXT: the shared wording verbatim, each template's placeholders,
 *       plain text, and every text listed in docs/investor-portal-copy.md §17
 *   §5  MUTANTS, each caught: payoutBasis ignored, a lease composed as share
 *       minus carry, the loss-month note beside a proration, a one-word change
 *       to the split page, a bare date parsed at local midnight, an instant
 *       printed as the calendar date of its UTC text, a loss month composed
 *       without the loss it carried forward, and the change note silenced on
 *       every loss month
 *   §6  every date prints the same under any server clock (UTC, Eastern, Central,
 *       Manila and both ends of the offset range, each in its own process): a
 *       bare YYYY-MM-DD as that very date, an instant as its business date; the split
 *       pins and a lease page hold under every clock
 *   §7  a split month that ran at a loss (the August 2026 row QA captured on
 *       staging) composes to the $0 it settled at: share, less an earlier loss
 *       applied, plus the loss carried forward. No change note, and the page
 *       foots; the pinned loss page is 61406a1's less exactly that note, every
 *       page with no loss carried forward is unchanged, and a real change after
 *       close is still disclosed in the same words
 *
 * Run: node scripts/test-payout-statement-lease.js
 */
"use strict";

// The in-process renders run under the production server's clock; §6 renders
// under others, each in a process of its own (TZ is read when a process starts).
process.env.TZ = "UTC";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const MODULE_PATH = path.join(__dirname, "..", "lib", "payout-statement.js");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");
const S = require(MODULE_PATH);

let pass = 0;
let mutantsCaught = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// Loads a copy of the module from (possibly mutated) source text, resolving its
// own requires from lib/.
function loadFrom(src) {
	const m = new Module(MODULE_PATH, null);
	m.filename = MODULE_PATH;
	m.paths = Module._nodeModulePaths(path.dirname(MODULE_PATH));
	m._compile(src, MODULE_PATH);
	return m.exports;
}
function mutate(from, to) {
	if (MODULE_SRC.split(from).length - 1 !== 1) throw new Error(`mutant anchor not found exactly once: ${from}`);
	return MODULE_SRC.replace(from, to);
}

// The logo is embedded as a data URI read from logo.png; the pins cover the
// statement's markup and words, not the image, so its bytes are left out.
function pageHash(html) {
	const logo = /<img src="[^"]*" alt="LogisX">/g;
	if ((html.match(logo) || []).length !== 1) throw new Error("expected exactly one logo image on the statement");
	return crypto.createHash("sha256").update(html.replace(logo, '<img src="LOGO" alt="LogisX">'), "utf8").digest("hex");
}

// ---------------------------------------------------------------- fixtures
const BASE = {
	investorName: "Test Investor",
	investorCompany: "Test Holdings LLC",
	period: "2026-06",
	periodLabel: "June 2026",
	statementNo: "202606-7",
	generatedAt: new Date("2026-08-14T17:00:00Z"),
};
// The real June row's frozen composition (scripts/test-payout-carry-freeze.js §4).
const FROZEN = {
	revenue: 35161.76, driverPay: 9000, fixedCosts: 6149.16, tripExpenses: 2431.72,
	maintFundCost: 0, complianceCost: 0, netProfit: 17580.88, splitPct: 50, monthShare: 8790,
};
const DETAIL = {
	revenueLoads: [
		{ loadId: "563166022", date: "2026-06-03", driver: "Driver One", truck: "91", pickup: "Laredo, TX", dropoff: "Irving, TX", amount: 20161.76 },
		{ loadId: "550303758", date: "2026-06-17", driver: "Driver One", truck: "91", pickup: "Houston, TX", dropoff: "", amount: 15000 },
	],
	driverPayRows: [
		{ driver: "Driver One", payType: "daily", activeDays: 20, dailyRate: 250, pay: 5000 },
		{ driver: "Driver Two", payType: "percentage", payPercentage: 25, pay: 4000 },
		{ driver: "Driver Three", payType: "daily", activeDays: 1, dailyRate: 0, pay: 0 },
	],
	fixedCostItems: [
		{ truck: "91", insurance: 1800, eld: 45, truckPayment: 3800, irp: 300.16, hvut: 204, total: 6149.16 },
	],
	tripExpenseItems: [
		{ date: "2026-06-05", type: "Fuel", description: "Diesel", driver: "Driver One", city: "Laredo", state: "TX", truck: "91", amount: 1931.72 },
		{ date: "2026-06-20", type: "", description: "", amount: 500 },
	],
};
const PAID = { status: "paid", paidAt: "2026-07-31T15:00:00.000Z", paidBy: "super_admin", dueDate: "2026-07-31" };
const FINAL = { status: "owed", finalizedAt: "2026-07-08T12:00:00.000Z", dueDate: "2026-07-31" };

const SPLIT_ROWS = {
	"paid, nothing carried, no adjustment": {
		...BASE, ...PAID, breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0,
		adjustment: 0, amount: 8790, effectiveAmount: 8790, detail: DETAIL,
	},
	"paid, an earlier loss applied": {
		...BASE, ...PAID, breakdown: FROZEN, lossCarriedIn: 87, lossDeferred: 0,
		adjustment: 0, amount: 8703, effectiveAmount: 8703, detail: DETAIL,
	},
	"final, a losing month carried forward": {
		...BASE, ...FINAL, period: "2025-07", periodLabel: "July 2025",
		breakdown: { ...FROZEN, netProfit: -1940, monthShare: -970 }, lossCarriedIn: 0, lossDeferred: 970,
		adjustment: 0, amount: 0, effectiveAmount: 0, detail: DETAIL,
	},
	"paid, corrected after payment, text to escape": {
		...BASE, ...PAID, investorName: "O'Brien & Sons <LLC>", investorCompany: "",
		breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0,
		adjustment: -661, adjustmentNote: "Duplicate fuel receipt \"#44\" & toll", adjustedAfterPaid: true, adjustedAt: "2026-08-10",
		amount: 8790, effectiveAmount: 8129, detail: DETAIL,
	},
	"paid, the composition drifted from the settled amount": {
		...BASE, ...PAID, breakdown: FROZEN, lossCarriedIn: 1563, lossDeferred: 0,
		adjustment: 0, amount: 8703, effectiveAmount: 8703, detail: DETAIL,
	},
	"paid, no breakdown (aged out)": {
		...BASE, ...PAID, period: "2024-01", periodLabel: "January 2024",
		breakdown: null, lossCarriedIn: 0, lossDeferred: 0,
		adjustment: 0, amount: 500, effectiveAmount: 500, detail: DETAIL,
	},
	"final, maintenance and compliance, 55% split, a positive adjustment": {
		...BASE, ...FINAL,
		breakdown: { ...FROZEN, maintFundCost: 250, complianceCost: 120.12, netProfit: 17210.76, splitPct: 55, monthShare: 9466 },
		lossCarriedIn: 0, lossDeferred: 0, adjustment: 150, adjustmentNote: "Toll refund",
		amount: 9466, effectiveAmount: 9616, detail: DETAIL,
	},
	"paid, nothing itemized against the headline": {
		...BASE, ...PAID, paidBy: "", breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0,
		adjustment: 0, amount: 8790, effectiveAmount: 8790, detail: {},
	},
};

// ⚠️ THE ORACLE. Each pin is pageHash() of the row above rendered by
// lib/payout-statement.js at 61406a1, the module before lease statements
// existed, under TZ=America/Chicago: the one clock under which that module
// printed a bare YYYY-MM-DD as its own date. Under the production server's UTC
// it printed each of them a day early (the due date, the appendix's load and
// expense dates, a bare correction date), until 2026-09-30; this module prints
// the Houston-clock page under every clock (§6). A split statement must keep
// printing exactly this. Change a pin only for a split wording or layout
// change the client has signed off, never to make a lease change pass.
const ORIGIN_MAIN_SHA256 = {
	"paid, nothing carried, no adjustment": "e3b50d628857686778f6798980b2ec04fe78805c5c9dd8de337bbd0b2a6121f6",
	"paid, an earlier loss applied": "0579aa845c3419eeafd789c510e427c809e7c92768df88368f9b3985e7bbbbbf",
	"final, a losing month carried forward": "4964b3bba7a97896319988ecba1e1e643a80aef3dfc5443e4380b503fc192658",
	"paid, corrected after payment, text to escape": "f39c09ea6e0c2140ea1ea69aee474c321dabc3c10e3ddd9738a6815d2d55d2b9",
	"paid, the composition drifted from the settled amount": "b4705f34d1bf9af1c7e40ce3ccf5baa4e349b6d637fa581fd98adca145f7a7e2",
	"paid, no breakdown (aged out)": "cebb9f3913a7c65d40b9470602d89dfcd4de4ae98a7ce876e0df5d98d1474758",
	"final, maintenance and compliance, 55% split, a positive adjustment": "08377bdc606c2a8fe820f45da808159a181f425bdd62bcc80e3429002b9d8788",
	"paid, nothing itemized against the headline": "d78471ccf16704421dfab1e15cddf50e49a96582afcb03dc059c85e981db4c22",
};
// What a split statement prints now: 61406a1's page for every row but the month
// that ran at a loss, which no longer prints the change note ("…now computes to
// −$970.00…") beside its settled $0.00, because nothing had changed (2026-09-30).
// §7 proves that note is the whole difference from 61406a1's page.
const SPLIT_PIN = {
	...ORIGIN_MAIN_SHA256,
	"final, a losing month carried forward": "0ee882fec0a18cb82c421272030f4ddae57cc320c8fdf1443587a9112adc0cb9",
};

// Every date the statement prints is one of two kinds. A bare YYYY-MM-DD (the
// due date, a load's or an expense's date, a correction date stored without a
// time) is a calendar date and prints as itself. An instant (paid_at,
// finalized_at, adjusted_at, the issue date) prints its business date
// (APP_TIMEZONE, US Eastern), so an instant in the Eastern evening prints the day
// BEFORE its UTC date. The days straddle the year's ends and both clock changes;
// the instants fall in summer (UTC-4) and in winter (UTC-5).
const DATE_DETAIL = {
	revenueLoads: [
		{ loadId: "700000001", date: "2026-03-08", driver: "Driver One", truck: "91", pickup: "Laredo, TX", dropoff: "Irving, TX", amount: 1000 },
		{ loadId: "700000002", date: "2026-11-01", driver: "Driver One", truck: "91", pickup: "Houston, TX", dropoff: "Dallas, TX", amount: 1000 },
	],
	tripExpenseItems: [
		{ date: "2026-01-01", type: "Fuel", description: "Diesel", amount: 100 },
		{ date: "2026-12-31", type: "Tolls", description: "Toll", amount: 50 },
	],
};
const DATE_ROWS = {
	"dates: final": {
		...BASE, generatedAt: new Date("2026-08-15T03:00:00.000Z"),
		status: "owed", finalizedAt: "2026-07-08T03:59:00.000Z", dueDate: "2026-07-31",
		breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0, adjustment: 0, amount: 8790, effectiveAmount: 8790, detail: DATE_DETAIL,
	},
	"dates: paid, corrected, instants": {
		...BASE, period: "2025-11", periodLabel: "November 2025",
		status: "paid", paidAt: "2026-01-01T04:30:00.000Z", paidBy: "super_admin",
		adjustment: -100, adjustmentNote: "Toll", adjustedAfterPaid: true, adjustedAt: "2026-08-10T03:00:00.000Z",
		breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0, amount: 8790, effectiveAmount: 8690, detail: {},
	},
	"dates: paid, corrected, bare dates": {
		...BASE, status: "paid", paidAt: "2026-07-31", paidBy: "super_admin",
		adjustment: -100, adjustmentNote: "Toll", adjustedAfterPaid: true, adjustedAt: "2026-08-10",
		breakdown: FROZEN, lossCarriedIn: 0, lossDeferred: 0, amount: 8790, effectiveAmount: 8690, detail: {},
	},
};
// [what, where it prints, what every clock must print there]
const DATE_EXPECT = {
	"dates: final": [
		["issued, an instant at 03:00Z (the evening before on the business clock)", /Issued: <strong>([^<]*)</, "08/14/2026"],
		["finalized, an instant at 03:59Z in summer (23:59 EDT the day before)", /Finalized<\/span><span class="v">([^<]*)/, "07/07/2026"],
		["payment due, a bare date, in the band", /Payment due<\/span><span class="v">([^<]*)/, "07/31/2026"],
		["payment due, a bare date, under the amount", /Payment due (\d\d\/\d\d\/\d{4})\./, "07/31/2026"],
		["a load dated on the spring clock change", /<td class="mono">700000001<\/td>\s*<td>([^<]*)/, "03/08/2026"],
		["a load dated on the autumn clock change", /<td class="mono">700000002<\/td>\s*<td>([^<]*)/, "11/01/2026"],
		["an expense dated the first day of the year", /<td>([^<]*)<\/td>\s*<td>Fuel<\/td>/, "01/01/2026"],
		["an expense dated the last day of the year", /<td>([^<]*)<\/td>\s*<td>Tolls<\/td>/, "12/31/2026"],
	],
	"dates: paid, corrected, instants": [
		["paid on, an instant at 04:30Z in winter (23:30 EST the day before), in the band", /Paid on<\/span><span class="v">([^<]*)/, "12/31/2025"],
		["paid on, the same instant, under the amount", /paid on (\d\d\/\d\d\/\d{4}) &middot;/, "12/31/2025"],
		["correction recorded, an instant at 03:00Z", /correction recorded (\d\d\/\d\d\/\d{4})/, "08/09/2026"],
	],
	"dates: paid, corrected, bare dates": [
		["paid on, a bare date, in the band", /Paid on<\/span><span class="v">([^<]*)/, "07/31/2026"],
		["correction recorded, a bare date", /correction recorded (\d\d\/\d\d\/\d{4})/, "08/10/2026"],
	],
};
function printedDate(html, re) {
	const m = html.match(re);
	return m ? m[1] : null;
}

// A lease month as server.js hands it over: payoutBasis on the breakdown,
// splitPct null, monthShare = the amount paid, nothing carried.
const LEASE_BD = {
	revenue: 18000, driverPay: 5000, fixedCosts: 4100, tripExpenses: 2200,
	maintFundCost: 0, complianceCost: 0, netProfit: 6700, splitPct: null, monthShare: 2000,
};
function leaseRow({ paid = 2000, covered = 30, days = 30, reason = null, bd = {}, ...rest } = {}) {
	return {
		...BASE, ...PAID, period: "2026-09", periodLabel: "September 2026", statementNo: "202609-12",
		breakdown: {
			...LEASE_BD, monthShare: paid, ...bd,
			payoutBasis: { type: "lease", leaseAmount: 2000, paidAmount: paid, coveredDays: covered, daysInMonth: days, reason },
		},
		lossCarriedIn: 0, lossDeferred: 0, adjustment: 0, amount: paid, effectiveAmount: paid, detail: DETAIL,
		...rest,
	};
}

// The August 2026 row QA captured on staging on 2026-09-30 (payout #29): a split
// month that ran at a loss, net profit −$500 × 50% = −$250, settled at $0 with
// the $250 carried forward. The route issues its statement only once a correction
// lifts it above $0 (409 PAYOUT_NOT_SETTLEABLE otherwise), so it is rendered both
// as captured and with a +$100 correction.
const AUGUST = {
	investorName: "QA Lease One", period: "2026-08", periodLabel: "August 2026", statementNo: "202608-29",
	status: "owed", paidAt: null, finalizedAt: "2026-09-30T07:55:14.658Z", dueDate: "2026-09-25",
	breakdown: {
		revenue: 500, driverPay: 0, fixedCosts: 1000, tripExpenses: 0,
		maintFundCost: 0, complianceCost: 0, netProfit: -500, splitPct: 50, monthShare: -250,
	},
	lossCarriedIn: 0, lossDeferred: 250, adjustment: 0, adjustmentNote: "", amount: 0, effectiveAmount: 0,
	detail: {
		revenueLoads: [{ loadId: "QA-LEASE-1-AUG", date: "2026-08-14", truck: "INV-537-A", amount: 500 }],
		fixedCostItems: [{ truck: "INV-537-A", insurance: 1000, eld: 0, truckPayment: 0, irp: 0, hvut: 0, total: 1000 }],
	},
	generatedAt: new Date("2026-09-30T08:00:00Z"),
};
const AUGUST_CORRECTED = { ...AUGUST, adjustment: 100, adjustmentNote: "Goodwill", effectiveAmount: 100 };
// The same month settled at $300 before its records showed the loss: a real
// change after close, which the change note must still disclose.
const AUGUST_SETTLED_300 = { ...AUGUST, amount: 300, effectiveAmount: 300 };
// The split composition as the module writes it, and as it was written until
// 2026-09-30, when it left out a loss month's carried-forward loss.
const COMPOSED_WITH_CARRY = "? Math.round(num(b.monthShare) - lossCarriedIn + (lossDeferred > 0 ? lossDeferred : 0)) : null;";
const COMPOSED_BEFORE_2026_09_30 = "? Math.round(num(b.monthShare) - lossCarriedIn) : null;";

// The module's escape, for comparing against the page's markup.
function escHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const has = (html, text) => html.includes(escHtml(text));

// The shared wording, typed out from the shared contract (L3–L7), so a reword in
// the module fails here as well as in the copy doc.
const CANONICAL = {
	L3: "Under your agreement you are paid a fixed monthly lease of {amount}, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment.",
	L4: "The lease covered {covered} of {days} days this month, so this month pays {paid}.",
	L5: "No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.",
	L6: "No lease payment is owed for this month: no truck was in service under your lease.",
	L7: "A month your truck runs at a loss still pays the full lease. Losses are not carried forward against your lease.",
};
const L3_FILLED = CANONICAL.L3.replace("{amount}", "$2,000");
const SPLIT_WORDS = ["How your share is calculated", "investor split", "Your share of net profit", "Earlier loss applied",
	"Loss carried forward", "Your trip expenses are deducted before the split, so the share above is already net of them."];

// ---------------------------------------------------------------- §1
section("§1 a split statement is byte-identical to 61406a1 under the Houston clock, but for a loss month's change note");
{
	for (const [name, row] of Object.entries(SPLIT_ROWS)) {
		eq(pageHash(S.buildPayoutStatementHtml(row)), SPLIT_PIN[name], `split: ${name}`);
	}
	eq(Object.keys(SPLIT_ROWS).filter((name) => SPLIT_PIN[name] !== ORIGIN_MAIN_SHA256[name]), ["final, a losing month carried forward"],
		"split: the loss month is the only page that differs from 61406a1's");
	// A payoutBasis that is not an object is no lease: the split page, unchanged.
	const nonObject = { ...SPLIT_ROWS["paid, nothing carried, no adjustment"] };
	nonObject.breakdown = { ...FROZEN, payoutBasis: "lease" };
	eq(pageHash(S.buildPayoutStatementHtml(nonObject)), SPLIT_PIN["paid, nothing carried, no adjustment"],
		"split: a payoutBasis that is not an object leaves the split page as it was");
}

// ---------------------------------------------------------------- §2
section("§2 a lease month's statement");
{
	const full = S.buildPayoutStatementHtml(leaseRow());
	ok(has(full, "How your payment is calculated"), "full month: the heading is \"How your payment is calculated\"");
	ok(/<tr><td>Fixed monthly lease payment<\/td><td class="num">\$2,000\.00<\/td><\/tr>/.test(full), "full month: the lease line prints the monthly lease, $2,000.00");
	ok(/<tr><td>Lease payment for September 2026<\/td><td class="num">\$2,000\.00<\/td><\/tr>/.test(full), "full month: the month pays $2,000.00");
	ok(!full.includes('<td class="sub">'), "full month: no reason line");
	ok(/Settled amount for September 2026<\/td><td class="num strong">\$2,000\.00/.test(full), "full month: the settled amount row, shared with the split page");
	ok(/<span class="lbl">Amount Paid<\/span><span class="amt">\$2,000\.00<\/span>/.test(full), "full month: Amount Paid $2,000.00");
	ok(has(full, L3_FILLED), "full month: the L3 explanation with the lease in whole dollars");
	ok(has(full, "Your truck's revenue and costs") && /<tr><td>Revenue<\/td><td class="num">\$18,000\.00/.test(full)
		&& /Net Profit<\/td><td class="num strong">\$6,700\.00/.test(full), "full month: the truck's revenue and costs, down to net profit, in their own table");
	ok(full.indexOf(escHtml(L3_FILLED)) > full.indexOf('class="paidmeta"') && full.indexOf(escHtml(L3_FILLED)) < full.indexOf(escHtml("Your truck's revenue and costs")),
		"full month: the explanation sits under the amount paid, as the caption of that table");
	ok(full.indexOf("Revenue</td>") > full.indexOf('class="paidmeta"'), "full month: the revenue lines come after the amount paid, not above it");
	ok(full.includes("Supporting detail"), "full month: the itemized appendix is still printed");
	ok(!has(full, CANONICAL.L7), "full month at a profit: no loss-month note");
	ok(!/\{\w+\}/.test(full), "full month: no placeholder left unfilled");

	const prorated = S.buildPayoutStatementHtml(leaseRow({ paid: 1333, covered: 20, days: 30, reason: "prorated" }));
	ok(has(prorated, "The lease covered 20 of 30 days this month, so this month pays $1,333."), "prorated: L4, filled");
	ok(/<tr><td class="sub">The lease covered 20 of 30 days/.test(prorated), "prorated: …on the reason line");
	ok(prorated.indexOf("Fixed monthly lease payment") < prorated.indexOf("The lease covered") && prorated.indexOf("The lease covered") < prorated.indexOf("Lease payment for September 2026"),
		"prorated: lease line, then the reason, then what the month pays");
	ok(/Lease payment for September 2026<\/td><td class="num">\$1,333\.00/.test(prorated), "prorated: the month pays $1,333.00");

	const downtime = S.buildPayoutStatementHtml(leaseRow({ paid: 0, reason: "downtime", adjustment: 200, adjustmentNote: "Goodwill", effectiveAmount: 200,
		bd: { revenue: 0, driverPay: 0, fixedCosts: 0, tripExpenses: 0, netProfit: 0 } }));
	ok(has(downtime, CANONICAL.L5), "downtime: L5");
	ok(/Lease payment for September 2026<\/td><td class="num">\$0\.00/.test(downtime), "downtime: the month pays $0.00");
	ok(/\+ Adjustment<div class="cap">Goodwill<\/div><\/td><td class="num ">\+\$200\.00/.test(downtime), "downtime: the adjustment row, shared with the split page");
	ok(/<span class="amt">\$200\.00<\/span>/.test(downtime), "downtime: the amount paid includes the adjustment");

	const notInService = S.buildPayoutStatementHtml(leaseRow({ paid: 0, covered: 0, reason: "not_in_service" }));
	ok(has(notInService, CANONICAL.L6), "not in service: L6");

	const unknown = S.buildPayoutStatementHtml(leaseRow({ reason: "something_new" }));
	ok(unknown === full, "a reason with no words prints no reason line: the full-month lease page");

	// L7: a loss month that paid the full lease; never beside a proration or a $0 month.
	const loss = (o) => S.buildPayoutStatementHtml(leaseRow({ ...o, bd: { netProfit: -850 } }));
	ok(has(loss({}), CANONICAL.L7), "a loss month paying the full lease: L7");
	ok(loss({}).indexOf(escHtml(CANONICAL.L7)) > loss({}).indexOf("Net Profit</td>"), "…under the truck's net profit");
	ok(!has(loss({ paid: 1333, covered: 20, reason: "prorated" }), CANONICAL.L7), "a prorated loss month: no L7");
	ok(!has(loss({ paid: 0, reason: "downtime" }), CANONICAL.L7), "a downtime month: no L7");
	ok(!has(loss({ paid: 0, covered: 0, reason: "not_in_service" }), CANONICAL.L7), "a month with no truck in service: no L7");

	// Maintenance and compliance feed net profit; the lease table prints them as the split page does.
	const costs = S.buildPayoutStatementHtml(leaseRow({ bd: { maintFundCost: 250, complianceCost: 120.12, netProfit: 6329.88 } }));
	ok(costs.includes("&minus; Maintenance Fund") && costs.includes("&minus; Compliance / IFTA"), "the truck table prints maintenance and compliance when non-zero");

	// No split or carry wording on any lease page, even when the route passes a carry.
	const carried = S.buildPayoutStatementHtml(leaseRow({ lossCarriedIn: 500, lossDeferred: 300 }));
	const pages = { full, prorated, downtime, notInService, "loss month": loss({}), costs, "carry passed": carried };
	for (const [name, html] of Object.entries(pages)) {
		const found = SPLIT_WORDS.filter((w) => has(html, w));
		eq(found, [], `${name}: no split or carry wording`);
	}
	ok(SPLIT_WORDS.every((w) => has(S.buildPayoutStatementHtml({ ...SPLIT_ROWS["paid, an earlier loss applied"], lossDeferred: 1 }), w)),
		"control: the split page does carry every one of those words");
}

// ---------------------------------------------------------------- §3
section("§3 drift on a lease page: the composition is the amount the lease paid");
{
	ok(!/now computes to/.test(S.buildPayoutStatementHtml(leaseRow({ paid: 1333, covered: 20, reason: "prorated" }))),
		"paid amount = settled amount: no drift note");
	ok(!/now computes to/.test(S.buildPayoutStatementHtml(leaseRow({ lossCarriedIn: 500 }))),
		"a carry passed in is not subtracted from a lease month: no drift note");
	const moved = S.buildPayoutStatementHtml(leaseRow({ paid: 1333, covered: 20, reason: "prorated", amount: 2000, effectiveAmount: 2000 }));
	ok(/now computes to \$1,333\.00; the settled amount is what was paid\./.test(moved) && /Settled amount for September 2026[\s\S]*?\$2,000\.00/.test(moved),
		"settled at $2,000, the lease now pays $1,333: the drift note names both, and the settled amount stands");
	ok(!/now computes to/.test(S.buildPayoutStatementHtml(leaseRow({ paid: 1333, covered: 20, reason: "prorated", amount: 1334, effectiveAmount: 1334 }))),
		"within a dollar: no drift note, as on the split page");
}

// ---------------------------------------------------------------- §4
section("§4 the lease texts");
{
	const T = S.LEASE_TEXT;
	eq([T.EXPLAIN, T.REASON.prorated, T.REASON.downtime, T.REASON.not_in_service, T.LOSS_MONTH],
		[CANONICAL.L3, CANONICAL.L4, CANONICAL.L5, CANONICAL.L6, CANONICAL.L7], "L3–L7 are the shared wording, verbatim");
	// …taken from their one home, lib/lease-payout-text.js, not typed out again here.
	const SHARED = require(path.join(__dirname, "..", "lib", "lease-payout-text.js")).LEASE_TEXT;
	ok(T.REASON === SHARED.REASON && T.EXPLAIN === SHARED.EXPLAIN && T.LOSS_MONTH === SHARED.LOSS_MONTH,
		"L3–L7 are lib/lease-payout-text.js's own texts");
	ok(Object.values(CANONICAL).every((t) => !MODULE_SRC.includes(t)), "payout-statement.js keeps no copy of L3–L7");
	eq([T.HEADING, T.LEASE_LINE, T.PAID_LINE, T.RESULT_HEADING],
		["How your payment is calculated", "Fixed monthly lease payment", "Lease payment for {period}", "Your truck's revenue and costs"], "the statement's own lease labels");
	const placeholders = (t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	const WANT = {
		HEADING: [], LEASE_LINE: [], PAID_LINE: ["period"], EXPLAIN: ["amount"], RESULT_HEADING: [], LOSS_MONTH: [],
		"REASON.prorated": ["covered", "days", "paid"], "REASON.downtime": [], "REASON.not_in_service": [],
	};
	const flat = {};
	for (const [k, v] of Object.entries(T)) {
		if (typeof v === "string") flat[k] = v;
		else for (const [r, t] of Object.entries(v)) flat[`${k}.${r}`] = t;
	}
	eq(Object.keys(flat).sort(), Object.keys(WANT).sort(), "LEASE_TEXT holds exactly the lease statement's texts");
	for (const [k, want] of Object.entries(WANT)) eq(placeholders(flat[k]), want, `${k} takes ${want.length ? want.join(", ") : "no value"}`);
	eq(Object.keys(T.REASON).sort(), ["downtime", "not_in_service", "prorated"], "a text for each reason the contract names");
	ok(Object.isFrozen(T) && Object.isFrozen(T.REASON), "the text tables are frozen");
	const BS = String.fromCharCode(92);
	const hex = (n) => BS + "u" + n.toString(16).padStart(4, "0");
	const INVISIBLE = new RegExp("[" + [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
		.map(([a, b]) => `${hex(a)}-${hex(b)}`).join("") + "]");
	for (const [k, v] of Object.entries(flat)) {
		ok(v === v.trim() && !/\s{2}/.test(v) && !INVISIBLE.test(v), `${k}: plain printable text, no doubled or edge spaces`);
	}
	// docs/investor-portal-copy.md §17 lists every one for the client's sign-off.
	const DOC = fs.readFileSync(path.join(__dirname, "..", "docs", "investor-portal-copy.md"), "utf8");
	const s17 = DOC.slice(DOC.indexOf("\n## 17. "), DOC.indexOf("\n## ", DOC.indexOf("\n## 17. ") + 5));
	ok(s17.length > 100, "the copy doc has a §17");
	for (const [k, v] of Object.entries(flat)) ok(s17.includes("`" + v + "`"), `§17 lists ${k} verbatim`);
}

// ---------------------------------------------------------------- §5
section("§5 MUTANTS — each must be caught");
{
	const cases = [
		{
			name: "a lease month printed as a split (payoutBasis ignored)",
			src: mutate('const lease = b && b.payoutBasis && typeof b.payoutBasis === "object" ? b.payoutBasis : null;', "const lease = null;"),
			caught: (M) => M.buildPayoutStatementHtml(leaseRow()).includes("investor split"),
		},
		{
			name: "a lease month composed as share minus carry (a carry passed in trips the drift note)",
			src: mutate("? Math.round(num(lease.paidAmount))", "? Math.round(num(b.monthShare) - lossCarriedIn)"),
			caught: (M) => /now computes to/.test(M.buildPayoutStatementHtml(leaseRow({ lossCarriedIn: 500 }))),
		},
		{
			name: "the loss-month note printed beside a proration",
			src: mutate("num(b.netProfit) < 0 && !lease.reason", "num(b.netProfit) < 0"),
			caught: (M) => M.buildPayoutStatementHtml(leaseRow({ paid: 1333, covered: 20, reason: "prorated", bd: { netProfit: -850 } })).includes(CANONICAL.L7),
		},
		{
			name: "a one-word change to the split page (the §1 pins must see it)",
			src: mutate("% investor split</td>", "% investor share</td>"),
			caught: (M) => pageHash(M.buildPayoutStatementHtml(SPLIT_ROWS["paid, nothing carried, no adjustment"])) !== SPLIT_PIN["paid, nothing carried, no adjustment"],
		},
		{
			name: "a loss month composed without the loss it carried forward (the change note on August 2026)",
			src: mutate(COMPOSED_WITH_CARRY, COMPOSED_BEFORE_2026_09_30),
			caught: (M) => /now computes to/.test(M.buildPayoutStatementHtml(AUGUST_CORRECTED)),
		},
		{
			name: "the change note silenced on every loss month (a real change after close goes unsaid)",
			src: mutate("const drifted = composed != null && Math.abs(", "const drifted = composed != null && !(lossDeferred > 0) && Math.abs("),
			caught: (M) => !/now computes to/.test(M.buildPayoutStatementHtml(AUGUST_SETTLED_300)),
		},
		{
			name: "a bare date parsed at local midnight (the due date a day early on this UTC clock)",
			src: mutate("new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))", "new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))"),
			caught: (M) => printedDate(M.buildPayoutStatementHtml(DATE_ROWS["dates: final"]), DATE_EXPECT["dates: final"][2][1]) !== "07/31/2026",
		},
		{
			name: "an instant printed as the calendar date of its UTC text",
			src: mutate("match(/^(\\d{4})-(\\d{2})-(\\d{2})$/)", "match(/^(\\d{4})-(\\d{2})-(\\d{2})/)"),
			caught: (M) => printedDate(M.buildPayoutStatementHtml(DATE_ROWS["dates: paid, corrected, instants"]), DATE_EXPECT["dates: paid, corrected, instants"][0][1]) !== "12/31/2025",
		},
	];
	for (const c of cases) {
		ok(c.src !== MODULE_SRC, `the mutant applied: ${c.name}`);
		let M = null;
		let loadError = null;
		try { M = loadFrom(c.src); } catch (e) { loadError = e; }
		const caught = !loadError && c.caught(M);
		ok(caught, `MUTANT caught: ${c.name}`);
		if (caught) mutantsCaught++;
	}
}

// ---------------------------------------------------------------- §6
section("§6 every date prints the same under any server clock");
{
	// The business zone itself, Central, the production server's UTC, a
	// developer's Manila, and the two ends of the offset range (UTC+14, UTC-11).
	const CLOCKS = ["UTC", "America/New_York", "America/Chicago", "Asia/Manila", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
	const LEASE_NAME = "lease: a full month";
	const rows = { ...SPLIT_ROWS, ...DATE_ROWS, [LEASE_NAME]: leaseRow() };
	// Rows cross to the child as JSON; generatedAt goes back to the Date the route passes.
	const CHILD = `"use strict";
const S = require(${JSON.stringify(MODULE_PATH)});
const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
const pages = {};
for (const [name, row] of Object.entries(rows)) pages[name] = S.buildPayoutStatementHtml({ ...row, generatedAt: new Date(row.generatedAt) });
process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(2026, 6, 31).getTimezoneOffset(), pages }));`;
	const leaseHere = S.buildPayoutStatementHtml(leaseRow());
	const offsets = new Set();
	for (const clock of CLOCKS) {
		const run = spawnSync(process.execPath, ["-e", CHILD], {
			input: JSON.stringify(rows), env: { ...process.env, TZ: clock }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
		});
		if (run.status !== 0) { ok(false, `${clock}: the render ran (exit ${run.status}: ${String(run.stderr).trim().split("\n")[0]})`); continue; }
		const { zone, offset, pages } = JSON.parse(run.stdout);
		eq(zone, clock, `${clock}: the render ran under that clock`);
		offsets.add(offset);
		for (const name of Object.keys(SPLIT_ROWS)) eq(pageHash(pages[name]), SPLIT_PIN[name], `${clock}: split: ${name}`);
		ok(pages[LEASE_NAME] === leaseHere, `${clock}: the lease page is the one this process renders`);
		for (const [name, expected] of Object.entries(DATE_EXPECT)) {
			for (const [what, re, want] of expected) eq(printedDate(pages[name], re), want, `${clock}: ${what}`);
		}
	}
	eq(offsets.size, CLOCKS.length, "the clocks were five different offsets, not one clock five times");
}

// ---------------------------------------------------------------- §7
section("§7 a split month that ran at a loss composes to the $0 it settled at");
{
	for (const [name, row] of [["as captured", AUGUST], ["with a +$100 correction", AUGUST_CORRECTED]]) {
		const html = S.buildPayoutStatementHtml(row);
		ok(!/now computes to/.test(html), `August 2026, ${name}: no change note, nothing changed after it closed`);
		ok(/Your share of net profit<\/td><td class="num">−\$250\.00<\/td>/.test(html)
			&& /Loss carried forward<div class="cap">This month ran at a loss, so nothing is payable\. The shortfall is carried against later months rather than billed back to you\.<\/div><\/td><td class="num">\+\$250\.00<\/td>/.test(html)
			&& /Settled amount for August 2026<\/td><td class="num strong">\$0\.00<\/td>/.test(html),
		`August 2026, ${name}: the page foots, share −$250.00 + loss carried forward $250.00 = settled $0.00`);
	}

	// The page as the module printed it before this change: the same source with
	// the composition as it was, which prints 61406a1's page for every split row.
	const before = loadFrom(mutate(COMPOSED_WITH_CARRY, COMPOSED_BEFORE_2026_09_30));
	for (const [name, row] of Object.entries(SPLIT_ROWS)) {
		eq(pageHash(before.buildPayoutStatementHtml(row)), ORIGIN_MAIN_SHA256[name], `before this change: ${name} is 61406a1's page`);
	}
	ok(/now computes to −\$250\.00; the settled amount is the amount payable\./.test(before.buildPayoutStatementHtml(AUGUST_CORRECTED)),
		"before this change: August 2026 printed \"now computes to −$250.00\" beside its settled $0.00 (the staging repro)");

	// The whole difference on the pinned loss page is that one note.
	const NOTE_970 = '<div class="cap">Recorded on the ledger when this period was settled. The composition above reflects our records as of 08/14/2026 and now computes to −$970.00; the settled amount is the amount payable.</div>';
	const lossBefore = before.buildPayoutStatementHtml(SPLIT_ROWS["final, a losing month carried forward"]);
	const lossNow = S.buildPayoutStatementHtml(SPLIT_ROWS["final, a losing month carried forward"]);
	ok(lossBefore.split(NOTE_970).length === 2 && lossBefore.replace(NOTE_970, "") === lossNow,
		"the pinned loss month: the new page is 61406a1's page less exactly the change note, nothing else");
	for (const [name, row] of Object.entries(SPLIT_ROWS)) {
		if (row.lossDeferred > 0) continue;
		ok(S.buildPayoutStatementHtml(row) === before.buildPayoutStatementHtml(row), `no loss carried forward, unchanged: ${name}`);
	}

	// A real change after close is still disclosed, in the same words; only the
	// figure it names is now what the month would settle at, $0.
	const moved = S.buildPayoutStatementHtml(AUGUST_SETTLED_300);
	ok(/Settled amount for August 2026<div class="cap">Recorded on the ledger when this period was settled\. The composition above reflects our records as of 09\/30\/2026 and now computes to \$0\.00; the settled amount is the amount payable\.<\/div><\/td><td class="num strong">\$300\.00<\/td>/.test(moved),
		"settled at $300, the records now show the loss: the change note names $0.00, and the settled $300.00 stands");
	ok(!/now computes to/.test(S.buildPayoutStatementHtml({ ...AUGUST, amount: 1, effectiveAmount: 1 })),
		"within a dollar of the settled amount: no change note, as before");
	const profitNow = { ...AUGUST_CORRECTED, breakdown: { ...AUGUST.breakdown, revenue: 1800, netProfit: 800, monthShare: 400 }, lossDeferred: 0 };
	const profitHtml = S.buildPayoutStatementHtml(profitNow);
	ok(/now computes to \$400\.00; the settled amount is the amount payable\./.test(profitHtml) && profitHtml === before.buildPayoutStatementHtml(profitNow),
		"settled at $0, the records now show a profit: disclosed exactly as before");
}

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutants caught)`);
