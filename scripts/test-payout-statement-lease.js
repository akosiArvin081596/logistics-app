#!/usr/bin/env node
/**
 * lib/payout-statement.js — the statement PDF for a month paid as a fixed
 * monthly lease, and the split statement left exactly as it was.
 *
 * WHAT IS PROVED HERE
 *   §1  a SPLIT statement (no breakdown.payoutBasis) is byte-identical to the one
 *       61406a1 printed: eight representative rows (carry in, loss deferred, a
 *       correction after payment, drift, no breakdown, maintenance and compliance
 *       costs, an empty appendix) hashed against pins computed from that commit's
 *       module, and a one-word change to the split wording moves a pin
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
 *       minus carry, the loss-month note beside a proration, and a one-word
 *       change to the split page
 *
 * Run: node scripts/test-payout-statement-lease.js
 */
"use strict";

// Bare YYYY-MM-DD dates are parsed as local time by the module, so the pins are
// taken under one clock: the production server's.
process.env.TZ = "UTC";

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
// existed, under TZ=UTC. A split statement must keep printing exactly this.
// Change a pin only for a split wording or layout change the client has
// signed off, never to make a lease change pass.
const ORIGIN_MAIN_SHA256 = {
	"paid, nothing carried, no adjustment": "7580374f542faaba15c4c7f174a60c6f9870bd73614920fe95080b85d125c564",
	"paid, an earlier loss applied": "dd83f0103cd5a12073b450b8195483da58bc2aa4c5ce7cc2c2243fc0b12806ee",
	"final, a losing month carried forward": "0592b21bba0f9b9bcc7c2d1f6ee42ae7ead84d63a8c7f7d78a29593a883f7ad0",
	"paid, corrected after payment, text to escape": "01a803ea1ca98e9ee03307f664aa19543b2bcfdf1122e2de6abe93522734854c",
	"paid, the composition drifted from the settled amount": "c2737022b5122ba044a8051274d32a6530d96c271df047c83afae36a6a24a476",
	"paid, no breakdown (aged out)": "cebb9f3913a7c65d40b9470602d89dfcd4de4ae98a7ce876e0df5d98d1474758",
	"final, maintenance and compliance, 55% split, a positive adjustment": "c71ddfa40f6a0604e747883b9ff956d1e7a5bd44de4412bfef59818023fa8af1",
	"paid, nothing itemized against the headline": "d78471ccf16704421dfab1e15cddf50e49a96582afcb03dc059c85e981db4c22",
};

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
section("§1 a split statement is byte-identical to 61406a1");
{
	for (const [name, row] of Object.entries(SPLIT_ROWS)) {
		eq(pageHash(S.buildPayoutStatementHtml(row)), ORIGIN_MAIN_SHA256[name], `split: ${name}`);
	}
	// A payoutBasis that is not an object is no lease: the split page, unchanged.
	const nonObject = { ...SPLIT_ROWS["paid, nothing carried, no adjustment"] };
	nonObject.breakdown = { ...FROZEN, payoutBasis: "lease" };
	eq(pageHash(S.buildPayoutStatementHtml(nonObject)), ORIGIN_MAIN_SHA256["paid, nothing carried, no adjustment"],
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
			caught: (M) => pageHash(M.buildPayoutStatementHtml(SPLIT_ROWS["paid, nothing carried, no adjustment"])) !== ORIGIN_MAIN_SHA256["paid, nothing carried, no adjustment"],
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

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutants caught)`);
