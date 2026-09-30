#!/usr/bin/env node
/**
 * lib/investor-payout-basis.js — THE payout function: the split, the fixed
 * monthly lease, and the one loss walk under both.
 *
 * WHAT IS PROVED HERE
 *   §1  the three settings: unset → the default quietly; a valid value (any
 *       case, padded) is taken; anything else → the default with exactly one
 *       warning naming the variable
 *   §2  the flag gate: with `enabled` false a lease row changes no month, no
 *       figure and no month range (flag off ≡ split)
 *   §3  which row governs a month: the latest effective_month on or before it;
 *       none → the split; a future row changes nothing yet
 *   §4  a lease month: the full lease; an idle month under downtime "unpaid"
 *       (0, reason downtime) and "paid"; a loss month (the full lease, nothing
 *       carried, the split deficit untouched); a first month prorated from the
 *       in-service day; a last month under retirement "stop" (prorated to the
 *       retirement day, inclusive) and "continue"; no truck in service
 *       (not_in_service, ahead of downtime); prorate "none"; the created_at
 *       fallback; two trucks' days as a union; which trucks count: every
 *       status but Inactive (a truck in Maintenance or OOS covers, and its
 *       idle month is downtime, paid under downtime "paid"; an Inactive truck
 *       covers no day)
 *   §5  transitions: split → lease → split, the deficit waiting across the lease
 *   §6  THE SPLIT IS THE OLD ARITHMETIC: thousands of random months (split % from
 *       0 to 100, .5 boundaries, -0) through settleInvestorMonths() with no lease
 *       basis equal the formula and the walk that shipped before this module,
 *       copied here from 61406a1, value for value (Object.is, so -0 too)
 *   §7  the admin write's input rules: 400 INVALID_BASIS naming the field, 400
 *       LEASE_AMOUNT_WHOLE_DOLLARS, 409 BASIS_MONTH_CLOSED, the 12-month horizon
 *   §8  the idle predicate, the first month, the audit line, the dollar format
 *   §9  MUTANTS: the flag gate always open; a lease month joining the carry;
 *       coverage over the fixed-cost set (Active trucks only)
 *   §10 a month settled as a lease: its frozen snapshot read back exactly, or,
 *       where a figure cannot be read, towards its settled amount; it pays what
 *       it froze whatever the flag, the settings, the trucks or the rows say now,
 *       carries nothing either way, and stays in the month range with the flag
 *       off. MUTANT: the settled lease months ignored
 *
 * Pure: the module has no requires; nothing here touches a database or a network.
 * Run: node scripts/test-investor-payout-basis.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MODULE_PATH = path.join(__dirname, "..", "lib", "investor-payout-basis.js");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");
const B = require(MODULE_PATH);

let pass = 0;
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
const section = (t) => console.log(`\n${t}`);

// The module as loaded from a (possibly mutated) source; it has no requires.
function loadModule(src) {
	const m = { exports: {} };
	new Function("module", "exports", src)(m, m.exports);
	return m.exports;
}
function mutate(from, to) {
	if (MODULE_SRC.split(from).length !== 2) throw new Error(`mutant anchor not found exactly once: ${from}`);
	return MODULE_SRC.replace(from, to);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const SETTINGS = { downtime: "unpaid", prorate: "daily", retirement: "stop" };
const lease = (month, dollars) => ({ effective_month: month, basis_type: "lease", lease_amount_cents: dollars * 100 });
const split = (month) => ({ effective_month: month, basis_type: "split", lease_amount_cents: null });
const TRUCK_ALL_YEAR = { in_service_date: "2026-01-01", created_at: "2025-12-01 10:00:00", retired_at: "" };
const basisOf = (rows, trucks = [TRUCK_ALL_YEAR], settings = SETTINGS, enabled = true) => ({ enabled, rows, trucks, settings });
const month = (m, netProfit, zeroActivity = false) => ({ month: m, netProfit, zeroActivity });
const pick = (r, keys = ["investorEarnings", "companyEarnings", "raw", "payable", "carriedIn", "deferred"]) => Object.fromEntries(keys.map((k) => [k, r[k]]));

// ============================================================ §1 settings
section("§1 settings: the default quietly, a valid value, or the default with one warning");
{
	const warnings = [];
	const none = B.readLeaseSettings({}, (m) => warnings.push(m));
	eq(none, { downtime: "unpaid", prorate: "daily", retirement: "stop" }, "§1 unset: every default");
	eq(warnings.length, 0, "§1 unset: no warning");
	eq(B.readLeaseSettings({ INVESTOR_LEASE_DOWNTIME: " Paid ", INVESTOR_LEASE_PRORATE: "NONE", INVESTOR_LEASE_RETIREMENT: "continue" }, (m) => warnings.push(m)),
		{ downtime: "paid", prorate: "none", retirement: "continue" }, "§1 valid values are taken, any case, padded");
	eq(warnings.length, 0, "§1 valid values: no warning");
	const bad = B.readLeaseSettings({ INVESTOR_LEASE_DOWNTIME: "sometimes", INVESTOR_LEASE_PRORATE: "hourly", INVESTOR_LEASE_RETIREMENT: "stop" }, (m) => warnings.push(m));
	eq(bad, { downtime: "unpaid", prorate: "daily", retirement: "stop" }, "§1 invalid values fall back to the defaults");
	eq(warnings.length, 2, "§1 exactly one warning per invalid value");
	ok(/INVESTOR_LEASE_DOWNTIME/.test(warnings[0]) && /"unpaid"/.test(warnings[0]) && /INVESTOR_LEASE_PRORATE/.test(warnings[1]),
		"§1 each warning names the variable and the default it takes");
	ok(Object.isFrozen(none), "§1 the settings object is frozen");
	eq(B.readLeaseSettings(undefined), B.DEFAULT_SETTINGS, "§1 no environment at all: the defaults");
}

// ============================================================ §2 the flag gate
section("§2 the flag gate: enabled false changes nothing (flag off ≡ split)");
{
	const rows = [lease("2026-01", 2000)];
	const months = [month("2026-01", 5000), month("2026-02", -3000), month("2026-03", 0, true), month("2026-04", 9000)];
	const noBasis = B.settleInvestorMonths(months, { splitFraction: 0.5 });
	const off = B.settleInvestorMonths(months, { splitFraction: 0.5, basis: basisOf(rows, [TRUCK_ALL_YEAR], SETTINGS, false) });
	eq(off, noBasis, "§2 a lease row with the flag off: every month is the split, exactly");
	ok(Object.values(off).every((m) => m.payoutBasis === null), "§2 …and no month carries a payoutBasis");
	eq(B.firstPayoutMonth("2026-05", basisOf(rows, [], SETTINGS, false)), "2026-05", "§2 the month range does not reach back to the lease with the flag off");
	eq(B.leaseBasisForMonth(basisOf(rows, [], SETTINGS, false), "2026-02"), null, "§2 no lease month with the flag off");
	ok(!B.leaseBasisActive(null) && !B.leaseBasisActive({ enabled: "true" }) && B.leaseBasisActive({ enabled: true }),
		"§2 only enabled === true opens the gate");
	const on = B.settleInvestorMonths(months, { splitFraction: 0.5, basis: basisOf(rows) });
	ok(Object.values(on).every((m) => m.payoutBasis && m.payoutBasis.type === "lease"), "§2 control: the flag on makes them lease months");
}

// ============================================================ §3 which row governs
section("§3 the row that governs a month");
{
	const rows = [lease("2026-03", 2000), split("2026-06"), lease("2026-09", 2500)];
	eq(B.governingBasisRow(rows, "2026-02"), null, "§3 before every row: none (the split)");
	eq(B.governingBasisRow(rows, "2026-03").effective_month, "2026-03", "§3 the row's own month");
	eq(B.governingBasisRow(rows, "2026-05").effective_month, "2026-03", "§3 a later month keeps it");
	eq(B.governingBasisRow(rows, "2026-06").basis_type, "split", "§3 a later split row takes over");
	eq(B.governingBasisRow([...rows].reverse(), "2026-12").lease_amount_cents, 250000, "§3 order of the rows does not matter");
	eq(B.leaseBasisForMonth(basisOf(rows), "2026-07"), null, "§3 a split month is no lease");
	eq(B.leaseBasisForMonth(basisOf(rows), "2026-10"), { leaseAmount: 2500, effectiveMonth: "2026-09" }, "§3 the lease that governs, with its month");
	eq(B.leaseCentsOf({ basis_type: "lease", lease_amount_cents: 200050 }), null, "§3 a lease with cents is not read as a lease");
	eq(B.leaseCentsOf({ basis_type: "lease", lease_amount_cents: null }), null, "§3 a lease with no amount is not read as a lease");
}

// ============================================================ §4 a lease month
section("§4 a lease month");
{
	const pay = (m, opts = {}) => B.settleInvestorMonths([m], { splitFraction: 0.5, basis: basisOf([lease("2026-01", 2000)], opts.trucks || [TRUCK_ALL_YEAR], { ...SETTINGS, ...(opts.settings || {}) }) })[m.month];

	const full = pay(month("2026-04", 3475.25));
	eq(full.payoutBasis, { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 30, daysInMonth: 30, reason: null }, "§4 a full month pays the lease");
	eq(pick(full), { investorEarnings: 2000, companyEarnings: 1475, raw: 2000, payable: 2000, carriedIn: 0, deferred: 0 },
		"§4 investorEarnings = raw = payable = the lease; companyEarnings = round(net − lease)");

	const idle = pay(month("2026-04", 0, true));
	eq([idle.payoutBasis.paidAmount, idle.payoutBasis.reason, idle.payable], [0, "downtime", 0], "§4 an idle month under downtime \"unpaid\" pays nothing: downtime");
	const idlePaid = pay(month("2026-04", 0, true), { settings: { downtime: "paid" } });
	eq([idlePaid.payoutBasis.paidAmount, idlePaid.payoutBasis.reason], [2000, null], "§4 downtime \"paid\": the idle month pays the lease");

	const loss = pay(month("2026-04", -4358.12));
	eq(pick(loss), { investorEarnings: 2000, companyEarnings: -6358, raw: 2000, payable: 2000, carriedIn: 0, deferred: 0 },
		"§4 a loss month pays the full lease and carries nothing forward");

	const first = pay(month("2026-06", 800), { trucks: [{ in_service_date: "2026-06-10", created_at: "", retired_at: "" }] });
	eq(first.payoutBasis, { type: "lease", leaseAmount: 2000, paidAmount: 1400, coveredDays: 21, daysInMonth: 30, reason: "prorated" },
		"§4 the first month: 21 of 30 days from the 10th, Math.round(2000 × 21 / 30)");
	const firstNone = pay(month("2026-06", 800), { trucks: [{ in_service_date: "2026-06-10" }], settings: { prorate: "none" } });
	eq([firstNone.payoutBasis.paidAmount, firstNone.payoutBasis.reason, firstNone.payoutBasis.coveredDays], [2000, null, 21], "§4 prorate \"none\": the full lease, days still reported");

	const retiring = { in_service_date: "2026-01-01", retired_at: "2026-09-20" };
	const last = pay(month("2026-09", 900), { trucks: [retiring] });
	eq([last.payoutBasis.paidAmount, last.payoutBasis.coveredDays, last.payoutBasis.reason], [1333, 20, "prorated"], "§4 the last month under \"stop\": to the retirement day, inclusive");
	const after = pay(month("2026-10", 0), { trucks: [retiring] });
	eq([after.payoutBasis.paidAmount, after.payoutBasis.reason], [0, "not_in_service"], "§4 the month after retirement: not_in_service");
	const cont = pay(month("2026-10", 0), { trucks: [retiring], settings: { retirement: "continue" } });
	eq([cont.payoutBasis.paidAmount, cont.payoutBasis.coveredDays, cont.payoutBasis.reason], [2000, 31, null], "§4 retirement \"continue\": the lease runs on");

	const none = pay(month("2026-04", 0, true), { trucks: [] });
	eq([none.payoutBasis.paidAmount, none.payoutBasis.coveredDays, none.payoutBasis.reason], [0, 0, "not_in_service"], "§4 no truck: not_in_service, ahead of downtime");
	const future = pay(month("2026-04", 500), { trucks: [{ in_service_date: "2026-05-01" }] });
	eq(future.payoutBasis.reason, "not_in_service", "§4 a truck not yet in service: not_in_service");

	const fromCreated = pay(month("2026-06", 500), { trucks: [{ in_service_date: "", created_at: "2026-06-16 09:30:00", retired_at: "" }] });
	eq(fromCreated.payoutBasis.coveredDays, 15, "§4 no in-service date: the created_at day (the truckChargeFromMonth fallback)");
	const malformed = pay(month("2026-06", 500), { trucks: [{ in_service_date: "2026-6-1", created_at: "2026-06-16 09:30:00", retired_at: "2026-13-01" }] });
	eq(malformed.payoutBasis.coveredDays, 15, "§4 a malformed in-service date reads created_at, a malformed retirement no bound");
	const unbounded = pay(month("2026-06", 500), { trucks: [{}] });
	eq(unbounded.payoutBasis.coveredDays, 30, "§4 neither date: unbounded");

	const union = pay(month("2026-06", 500), { trucks: [{ in_service_date: "2026-06-21" }, { in_service_date: "2026-01-01", retired_at: "2026-06-05" }] });
	eq(union.payoutBasis.coveredDays, 15, "§4 two trucks: the days either is in the fleet (1–5 and 21–30)");
	eq(B.leaseCoverage({ monthKey: "2028-02", effectiveMonth: "2028-02", trucks: [{}], retirement: "stop" }), { coveredDays: 29, daysInMonth: 29 }, "§4 a leap February");

	// Which trucks count: every status but Inactive, not the fixed-cost set.
	eq(["Active", "Maintenance", "OOS", "Inactive", undefined].map((status) => B.truckInLeaseFleet({ ...TRUCK_ALL_YEAR, status })), [true, true, true, false, true],
		"§4 a lease counts a truck in every status but Inactive");
	const withStatus = (status) => [{ ...TRUCK_ALL_YEAR, status }];
	const shop = pay(month("2026-04", 500), { trucks: withStatus("Maintenance") });
	eq([shop.payoutBasis.paidAmount, shop.payoutBasis.coveredDays, shop.payoutBasis.reason], [2000, 30, null], "§4 a truck in Maintenance still covers the month");
	const oos = pay(month("2026-04", 500), { trucks: withStatus("OOS") });
	eq([oos.payoutBasis.paidAmount, oos.payoutBasis.coveredDays], [2000, 30], "§4 a truck Out of Service (OOS) still covers the month");
	const gone = pay(month("2026-04", 500), { trucks: withStatus("Inactive") });
	eq([gone.payoutBasis.paidAmount, gone.payoutBasis.coveredDays, gone.payoutBasis.reason], [0, 0, "not_in_service"], "§4 an Inactive truck covers no day: not_in_service");
	const mixed = pay(month("2026-06", 500), { trucks: [{ in_service_date: "2026-06-21", status: "Active" }, { in_service_date: "2026-01-01", status: "Inactive" }] });
	eq(mixed.payoutBasis.coveredDays, 10, "§4 an Inactive truck adds no day to another truck's");
	const shopIdle = pay(month("2026-04", 0, true), { trucks: withStatus("Maintenance") });
	eq([shopIdle.payoutBasis.paidAmount, shopIdle.payoutBasis.reason], [0, "downtime"], "§4 a Maintenance-only idle month under downtime \"unpaid\": downtime, not not_in_service");
	const shopIdlePaid = pay(month("2026-04", 0, true), { trucks: withStatus("Maintenance"), settings: { downtime: "paid" } });
	eq([shopIdlePaid.payoutBasis.paidAmount, shopIdlePaid.payoutBasis.coveredDays, shopIdlePaid.payoutBasis.reason], [2000, 30, null],
		"§4 downtime \"paid\": a Maintenance-only idle month pays the lease");
}

// ============================================================ §5 transitions
section("§5 split → lease → split: the deficit waits across the lease");
{
	const rows = [lease("2026-03", 1000), split("2026-05")];
	const months = [month("2026-01", 2000), month("2026-02", -3000), month("2026-03", -500), month("2026-04", 8000), month("2026-05", 4000), month("2026-06", 4000)];
	const s = B.settleInvestorMonths(months, { splitFraction: 0.5, basis: basisOf(rows) });
	eq(["2026-01", "2026-02"].map((m) => pick(s[m])), [
		{ investorEarnings: 1000, companyEarnings: 1000, raw: 1000, payable: 1000, carriedIn: 0, deferred: 0 },
		{ investorEarnings: -1500, companyEarnings: -1500, raw: -1500, payable: 0, carriedIn: 0, deferred: 1500 },
	], "§5 the split months before the lease: February's loss defers 1,500");
	eq(["2026-03", "2026-04"].map((m) => [s[m].payable, s[m].carriedIn, s[m].deferred, s[m].payoutBasis.type]), [[1000, 0, 0, "lease"], [1000, 0, 0, "lease"]],
		"§5 the lease months pay the lease, a loss month included, and absorb nothing");
	eq(["2026-05", "2026-06"].map((m) => [s[m].raw, s[m].carriedIn, s[m].payable]), [[2000, 1500, 500], [2000, 0, 2000]],
		"§5 back on the split, May absorbs February's 1,500, which the lease left untouched");
	const walk = B.carryForward(months.map((m) => ({ month: m.month, investorEarnings: s[m.month].investorEarnings, payoutBasis: s[m.month].payoutBasis })));
	eq(Object.fromEntries(Object.entries(walk).map(([k, v]) => [k, v])), Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { raw: v.raw, payable: v.payable, carriedIn: v.carriedIn, deferred: v.deferred }])),
		"§5 carryForward() over the settled months (the ledger's re-walk) gives the same carry");
}

// ============================================ §6 the split is the old arithmetic
section("§6 no lease basis: exactly the formula and the walk that shipped before (61406a1)");
{
	// Copied from server.js at 61406a1: the monthly split in both builders and
	// computeLossCarryForward(), unchanged.
	function oldSplit(netProfit, fraction) {
		return { investorEarnings: Math.round(netProfit * fraction), companyEarnings: Math.round(netProfit - Math.round(netProfit * fraction)) };
	}
	function oldWalk(monthlyEarnings) {
		const carryByPeriod = {};
		let deficit = 0;
		for (const m of monthlyEarnings || []) {
			const raw = Math.round(m.investorEarnings);
			let payable, carriedIn = 0, deferred = 0;
			if (raw < 0) {
				deferred = -raw;
				deficit += deferred;
				payable = 0;
			} else {
				carriedIn = Math.min(deficit, raw);
				payable = raw - carriedIn;
				deficit -= carriedIn;
			}
			carryByPeriod[m.month] = { raw, payable, carriedIn, deferred };
		}
		return carryByPeriod;
	}
	// A deterministic generator, so a failure reproduces.
	let seed = 20260930;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const PCTS = [0, 100, 50, 37.5, 33.3, 12.5, 66.6, 99.99, 0.01];
	const netProfitFor = (fraction) => {
		const r = rnd();
		if (r < 0.2) return (Math.floor(rnd() * 20000) - 10000) + 0.5;               // x.5 net profit
		if (r < 0.35 && fraction > 0) return ((Math.floor(rnd() * 4000) - 2000) + 0.5) / fraction; // net × fraction lands on x.5
		if (r < 0.45) return Math.round((rnd() - 0.5) * 20000 * 100) / 100;        // cents
		if (r < 0.5) return -0;
		if (r < 0.55) return 0;
		return (rnd() - 0.5) * 30000;                                              // anything
	};
	let compared = 0, mismatches = 0;
	const keys = ["investorEarnings", "companyEarnings", "raw", "payable", "carriedIn", "deferred"];
	for (let run = 0; run < 3000; run++) {
		const pct = rnd() < 0.5 ? PCTS[Math.floor(rnd() * PCTS.length)] : Math.round(rnd() * 10000) / 100;
		const fraction = pct / 100;
		const n = 1 + Math.floor(rnd() * 14);
		const months = [];
		for (let i = 0; i < n; i++) months.push({ month: B.addMonths("2025-01", i), netProfit: netProfitFor(fraction), zeroActivity: rnd() < 0.2 });
		const oldMonths = months.map((m) => ({ month: m.month, ...oldSplit(m.netProfit, fraction) }));
		const oldCarry = oldWalk(oldMonths);
		// No basis, a disabled lease basis, and an enabled basis of split rows only.
		const variants = [
			B.settleInvestorMonths(months, { splitFraction: fraction }),
			B.settleInvestorMonths(months, { splitFraction: fraction, basis: basisOf([lease("2024-01", 2000)], [TRUCK_ALL_YEAR], SETTINGS, false) }),
			B.settleInvestorMonths(months, { splitFraction: fraction, basis: basisOf([split("2024-06"), split("2025-03")]) }),
		];
		for (const got of variants) {
			for (let i = 0; i < n; i++) {
				const want = { ...oldMonths[i], ...oldCarry[months[i].month] };
				const have = got[months[i].month];
				compared++;
				if (!keys.every((k) => Object.is(have[k], want[k])) || have.payoutBasis !== null) {
					mismatches++;
					if (mismatches <= 3) console.error(`    ${pct}% net ${months[i].netProfit}: old ${JSON.stringify(pick(want))} new ${JSON.stringify(pick(have))}`);
				}
			}
		}
		// The ledger's re-walk over the old arrays is the old walk, value for value.
		const reWalk = B.carryForward(oldMonths);
		for (const m of months) {
			compared++;
			if (!["raw", "payable", "carriedIn", "deferred"].every((k) => Object.is(reWalk[m.month][k], oldCarry[m.month][k]))) mismatches++;
		}
	}
	ok(compared > 50000, `§6 compared ${compared} month figures`);
	eq(mismatches, 0, "§6 every split figure equals the old formula and the old walk (Object.is)");
	// The boundary that motivated rounding once: −4899.16 × 50% = −2449.58 → −2450.
	eq(pick(B.settleInvestorMonths([month("2026-08", -4899.16)], { splitFraction: 0.5 })["2026-08"]),
		{ investorEarnings: -2450, companyEarnings: -2449, raw: -2450, payable: 0, carriedIn: 0, deferred: 2450 }, "§6 the live −4899.16 month");
	ok(Object.is(B.settleInvestorMonths([month("2026-08", -0.4)], { splitFraction: 0.5 })["2026-08"].investorEarnings, -0),
		"§6 a −0 share stays −0, as it always was (JSON prints it as 0)");
}

// ============================================================ §7 the admin write
section("§7 PUT /api/investors/:id/payout-basis input rules");
{
	const read = (body, earliest = null) => B.readBasisInput(body, { currentMonth: "2026-09", earliestEditableMonth: earliest });
	const refusal = (r) => (r.ok ? "ok" : `${r.status} ${r.code} ${r.field}`);
	eq(read({ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-10", note: "  signed\u0007 terms  " }),
		{ ok: true, value: { type: "lease", leaseAmountCents: 200000, effectiveMonth: "2026-10", note: "signed terms" } }, "§7 a lease: cents stored, the note cleaned");
	eq(read({ type: "lease", leaseAmount: " 2000.00 ", effectiveMonth: "2026-10" }).value.leaseAmountCents, 200000, "§7 \"2000.00\" is whole dollars");
	eq(read({ type: "split", leaseAmount: 900, effectiveMonth: "2026-10" }).value, { type: "split", leaseAmountCents: null, effectiveMonth: "2026-10", note: "" },
		"§7 a split stores no amount (one sent is ignored)");
	const cases = [
		[{ type: "Lease", leaseAmount: 2000, effectiveMonth: "2026-10" }, "400 INVALID_BASIS type"],
		[null, "400 INVALID_BASIS type"],
		[[], "400 INVALID_BASIS type"],
		[{ type: "lease", effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: "2,000", effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: Infinity, effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: 0, effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: 100001, effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: -5, effectiveMonth: "2026-10" }, "400 INVALID_BASIS leaseAmount"],
		[{ type: "lease", leaseAmount: 2000.5, effectiveMonth: "2026-10" }, "400 LEASE_AMOUNT_WHOLE_DOLLARS leaseAmount"],
		[{ type: "lease", leaseAmount: "2000.50", effectiveMonth: "2026-10" }, "400 LEASE_AMOUNT_WHOLE_DOLLARS leaseAmount"],
		[{ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-13" }, "400 INVALID_BASIS effectiveMonth"],
		[{ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-9" }, "400 INVALID_BASIS effectiveMonth"],
		[{ type: "lease", leaseAmount: 2000 }, "400 INVALID_BASIS effectiveMonth"],
		[{ type: "lease", leaseAmount: 2000, effectiveMonth: "2027-10" }, "400 INVALID_BASIS effectiveMonth"],
		[{ type: "split", effectiveMonth: "2026-10", note: 5 }, "400 INVALID_BASIS note"],
		[{ type: "split", effectiveMonth: "2026-10", note: "x".repeat(301) }, "400 INVALID_BASIS note"],
	];
	for (const [body, want] of cases) eq(refusal(read(body)), want, `§7 ${JSON.stringify(body)?.slice(0, 70)} → ${want}`);
	ok(read({ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-10" }).ok && read({ type: "split", effectiveMonth: "2027-09" }).ok,
		"§7 up to 12 months ahead is allowed");
	const closed = read({ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-07" }, "2026-08");
	eq(refusal(closed), "409 BASIS_MONTH_CLOSED effectiveMonth", "§7 a month before earliestEditableMonth: 409 BASIS_MONTH_CLOSED");
	ok(/2026-07/.test(closed.error) && /2026-08/.test(closed.error), "§7 …saying which months are settled and where a change may start");
	ok(read({ type: "lease", leaseAmount: 2000, effectiveMonth: "2026-08" }, "2026-08").ok, "§7 earliestEditableMonth itself is open");
	eq(refusal(read({ type: "lease", leaseAmount: 2000.5, effectiveMonth: "2026-07" }, "2026-08")), "400 LEASE_AMOUNT_WHOLE_DOLLARS leaseAmount",
		"§7 a malformed body is 400 before the month is judged");
	ok(read({ type: "split", effectiveMonth: B.EFFECTIVE_MONTH_MIN }, null).ok, "§7 no settled or closed month: back to the floor");
	eq(B.EFFECTIVE_MONTH_MIN, "2020-01", "§7 the floor is 2020-01");
	eq(refusal(read({ type: "lease", leaseAmount: 2000, effectiveMonth: "2019-12" }, null)), "400 INVALID_BASIS effectiveMonth",
		"§7 a month before the floor (a mistyped year, say): 400, whatever earliestEditableMonth says");
	eq(refusal(read({ type: "lease", leaseAmount: 2000, effectiveMonth: "1026-09" }, null)), "400 INVALID_BASIS effectiveMonth", "§7 …1026-09 too");
}

// ============================================================ §8 small pieces
section("§8 the idle predicate, the first month, the audit line, the dollars");
{
	const idle = { revenue: 0, driverPay: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0, driverCount: 0 };
	ok(B.isZeroActivityMonth(idle), "§8 nothing at all: idle");
	for (const k of Object.keys(idle)) ok(!B.isZeroActivityMonth({ ...idle, [k]: k === "driverCount" ? 1 : 0.01 }), `§8 any ${k}: not idle`);
	ok(!B.isZeroActivityMonth({ ...idle, revenue: -5 }), "§8 negative revenue: not idle");
	eq(B.firstPayoutMonth("2026-07", basisOf([lease("2026-03", 2000), lease("2025-11", 1000)])), "2025-11", "§8 the earliest lease row starts the months");
	eq(B.firstPayoutMonth("2026-07", basisOf([split("2025-01"), lease("2026-09", 1000)])), "2026-07", "§8 a split row, or a later lease, starts nothing");
	eq(B.firstPayoutMonth("2026-07", null), "2026-07", "§8 no basis: the activity month");
	eq(B.describeSchedule([{ effective_month: "2026-11", basis_type: "split", lease_amount_cents: null, source: "admin", note: "" }, { ...lease("2026-09", 2000), source: "signed_terms", note: "as signed" }]),
		'from 2026-09 lease $2,000 (signed_terms) note "as signed"; from 2026-11 split (admin)', "§8 the audit line, oldest first");
	eq(B.describeSchedule([]), "no basis rows (split at the Split %)", "§8 the audit line with no rows");
	eq([B.formatLeaseAmount(2000), B.formatLeaseAmount(100000), B.formatLeaseAmount(1), B.formatLeaseAmount(1234567)], ["$2,000", "$100,000", "$1", "$1,234,567"], "§8 whole dollars, grouped");
	eq([B.addMonths("2026-11", 2), B.addMonths("2026-01", -1), B.daysInMonth("2026-02"), B.daysInMonth("2026-12")], ["2027-01", "2025-12", 28, 31], "§8 month arithmetic");
	ok(!Object.prototype.hasOwnProperty.call(B, "LEASE_TEXT"), "§8 no investor-facing wording here: lib/lease-payout-text.js is its one home");
	// A settled month keeps the basis it was settled under.
	eq(["", null, "not json", "{}", JSON.stringify({ splitPct: 50 }), JSON.stringify({ payoutBasis: { type: "lease" } })].map(B.frozenBreakdownIsLease),
		[false, false, false, false, false, true], "§8 a frozen breakdown is a lease only when it says so; empty, unreadable or split is the split");
	const frozen = { ...basisOf([lease("2026-01", 2000)]), settledSplitMonths: ["2026-02"] };
	const fm = B.settleInvestorMonths([{ month: "2026-02", netProfit: -800, zeroActivity: false }, { month: "2026-03", netProfit: 9000, zeroActivity: false }],
		{ splitFraction: 0.5, basis: frozen });
	eq([fm["2026-02"].payoutBasis, fm["2026-02"].investorEarnings, fm["2026-02"].deferred, fm["2026-03"].payoutBasis && fm["2026-03"].payoutBasis.paidAmount],
		[null, -400, 400, 2000], "§8 a month finalized as the split stays the split (and defers its loss) under a lease row; the next open month is the lease");
	eq([B.leaseBasisForMonth(frozen, "2026-02"), B.leaseBasisForMonth(frozen, "2026-03")], [null, { leaseAmount: 2000, effectiveMonth: "2026-01" }],
		"§8 leaseBasisForMonth agrees");
}

// ============================================================ §9 mutants
section("§9 mutants — each must be caught");
{
	const rows = [lease("2026-01", 2000)];
	const months = [month("2026-01", 5000), month("2026-02", -3000)];
	const flagOffIsSplit = (M) => JSON.stringify(M.settleInvestorMonths(months, { splitFraction: 0.5, basis: basisOf(rows, [TRUCK_ALL_YEAR], SETTINGS, false) }))
		=== JSON.stringify(M.settleInvestorMonths(months, { splitFraction: 0.5 }));
	ok(flagOffIsSplit(B), "§9 control: the shipped gate keeps flag off ≡ split");
	const openGate = loadModule(mutate("return !!basis && basis.enabled === true;", "return !!basis;"));
	ok(!flagOffIsSplit(openGate), "§9 MUTANT the flag gate always open (a lease row pays with the flag off) is caught");

	const deficitWaits = (M) => {
		const s = M.settleInvestorMonths([month("2026-01", -2000), month("2026-02", 500), month("2026-03", 3000)],
			{ splitFraction: 0.5, basis: basisOf([lease("2026-02", 800), split("2026-03")]) });
		return s["2026-02"].payable === 800 && s["2026-02"].carriedIn === 0 && s["2026-03"].carriedIn === 1000;
	};
	ok(deficitWaits(B), "§9 control: the lease month leaves the deficit for the split month");
	const leaseAbsorbs = loadModule(mutate("if (m.payoutBasis && m.payoutBasis.type === \"lease\") {", "if (false) {"));
	ok(!deficitWaits(leaseAbsorbs), "§9 MUTANT a lease month joining the carry walk is caught");

	const shopCovers = (M) => M.settleInvestorMonths([month("2026-04", 0, true)], {
		splitFraction: 0.5, basis: basisOf([lease("2026-01", 2000)], [{ ...TRUCK_ALL_YEAR, status: "Maintenance" }], { ...SETTINGS, downtime: "paid" }),
	})["2026-04"].payable === 2000;
	ok(shopCovers(B), "§9 control: a Maintenance-only month pays the lease under downtime \"paid\"");
	const activeOnly = loadModule(mutate("return !!t && t.status !== LEASE_FLEET_EXIT_STATUS;", "return !!t && (t.status === undefined || t.status === \"Active\");"));
	ok(!shopCovers(activeOnly), "§9 MUTANT coverage over the fixed-cost set (Active trucks only) is caught");
}

// ============================================================ §10 settled as a lease
section("§10 a month settled as a lease keeps what it settled at");
{
	const frozenJson = (pb, extra = {}) => JSON.stringify({ netProfit: 9000, splitPct: null, monthShare: pb.paidAmount, payoutBasis: pb, lossCarriedIn: 0, lossDeferred: 0, ...extra });
	const JUNE_IDLE = { type: "lease", leaseAmount: 2000, paidAmount: 0, coveredDays: 30, daysInMonth: 30, reason: "downtime" };
	const JULY_FULL = { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null };

	// Reading the frozen snapshot.
	eq(B.readFrozenLeaseBasis(frozenJson(JUNE_IDLE), "2026-06", 0), { payoutBasis: JUNE_IDLE, complete: true }, "§10 a frozen lease snapshot reads back exactly, in the settle's shape");
	eq(["", null, "not json", JSON.stringify({ splitPct: 50, monthShare: 4500 }), "null"].map((j) => B.readFrozenLeaseBasis(j, "2026-06", 4500)),
		[null, null, null, null, null], "§10 empty, unreadable or split snapshots are not a lease (the split, as before)");
	eq(B.readFrozenLeaseBasis(frozenJson(JUNE_IDLE), "2026-6", 0), null, "§10 a period that is not a month key reads nothing");
	const damaged = B.readFrozenLeaseBasis(frozenJson({ type: "lease", leaseAmount: "2000", paidAmount: null, coveredDays: 40, daysInMonth: 31, reason: "later" }), "2026-07", 2000);
	eq(damaged, { payoutBasis: { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null }, complete: false },
		"§10 a snapshot whose figures cannot be read falls back to the settled amount (never a live figure), and says it is incomplete");
	eq(B.readFrozenLeaseBasis(frozenJson({ type: "lease" }), "2026-07", null).payoutBasis.paidAmount, 0, "§10 …with no settled amount either: $0, not a live figure");

	// Settling with it: whatever the flag, the rows, the trucks or the settings say now.
	const settled = { "2026-06": JUNE_IDLE, "2026-07": JULY_FULL };
	const months = [month("2026-05", -3000), month("2026-06", 0, true), month("2026-07", -4500), month("2026-08", 6000, false)];
	const now = (over) => ({ ...basisOf([lease("2026-05", 2000)]), settledLeaseMonths: settled, ...over });
	const view = (basis) => {
		const s = B.settleInvestorMonths(months, { splitFraction: 0.5, basis });
		return months.map(({ month: m }) => [m, s[m].investorEarnings, s[m].payable, s[m].carriedIn, s[m].deferred, s[m].payoutBasis && `${s[m].payoutBasis.paidAmount} ${s[m].payoutBasis.reason}`]);
	};
	const want = view(now({}));
	eq(want.slice(1, 3), [["2026-06", 0, 0, 0, 0, "0 downtime"], ["2026-07", 2000, 2000, 0, 0, "2000 null"]], "§10 June and July pay exactly what they froze");
	for (const [label, over] of [
		["downtime \"paid\"", { settings: { ...SETTINGS, downtime: "paid" } }],
		["prorate \"none\" and retirement \"continue\"", { settings: { ...SETTINGS, prorate: "none", retirement: "continue" } }],
		["the only truck Inactive", { trucks: [{ ...TRUCK_ALL_YEAR, status: "Inactive" }] }],
		["the truck retired in May", { trucks: [{ ...TRUCK_ALL_YEAR, retired_at: "2026-05-20" }] }],
		["a split row governing now", { rows: [lease("2026-05", 2000), split("2026-06")] }],
		["no basis row at all", { rows: [] }],
	]) {
		const got = view(now(over));
		eq(got.slice(1, 3), want.slice(1, 3), `§10 ${label}: the settled months unchanged`);
	}
	const off = view(now({ enabled: false }));
	eq(off.slice(1, 3), want.slice(1, 3), "§10 the flag off: the settled months still read as the lease they settled as");
	eq([off[0], off[3]], [["2026-05", -1500, 0, 0, 1500, null], ["2026-08", 3000, 1500, 1500, 0, null]],
		"§10 …while the open months are the split, the May loss carried past the settled lease months into August");
	const s = B.settleInvestorMonths(months, { splitFraction: 0.5, basis: now({}) });
	eq(s["2026-07"].companyEarnings, -6500, "§10 the company's share of a settled lease month: the net profit less the lease it settled at");
	s["2026-07"].payoutBasis.paidAmount = 1;
	eq(settled["2026-07"].paidAmount, 2000, "§10 a settled month's payoutBasis is a copy: a caller cannot change the context through it");
	eq(B.firstPayoutMonth("2026-08", { enabled: false, rows: [], settledLeaseMonths: settled }), "2026-06", "§10 the month range reaches back to a month settled as a lease, flag off");
	eq(B.firstPayoutMonth("2026-08", { enabled: false, rows: [lease("2026-03", 2000)] }), "2026-08", "§10 …but not to a lease row with the flag off");
	eq([B.isLeaseMonth(now({ enabled: false }), "2026-07"), B.isLeaseMonth(now({ enabled: false }), "2026-08"), B.isLeaseMonth(now({}), "2026-08"), B.isLeaseMonth(null, "2026-07")],
		[true, false, true, false], "§10 isLeaseMonth: settled as a lease (any flag), or an open month under an active lease row");

	// MUTANT: the settled lease months ignored.
	const noFrozen = loadModule(mutate("const frozen = settledLeaseBasis(basis, m.month);", "const frozen = null;"));
	const viewWith = (M, basis) => { const r = M.settleInvestorMonths(months, { splitFraction: 0.5, basis }); return months.map(({ month: m }) => [r[m].investorEarnings, r[m].payoutBasis]); };
	const paidNow = now({ settings: { ...SETTINGS, downtime: "paid" } });
	ok(JSON.stringify(viewWith(B, paidNow)) === JSON.stringify(viewWith(B, now({}))), "§10 control: switching downtime moves no settled month");
	ok(JSON.stringify(viewWith(noFrozen, paidNow)) !== JSON.stringify(viewWith(noFrozen, now({}))), "§10 MUTANT the settled lease months ignored: switching downtime re-explains June (caught)");
}

console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${pass} assertions passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
