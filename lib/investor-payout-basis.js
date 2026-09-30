"use strict";
// What an investor is paid each month: a share of net profit (the Split %) or a
// fixed monthly lease, and the loss carry-forward that runs under both.
//
// THE ONE PAYOUT FUNCTION. settleInvestorMonths() is the only place a month's
// investor earnings are worked out, and carryForward() is the only loss walk.
// Both copies of the monthly math call settleInvestorMonths(): the payouts
// ledger's computeInvestorMonthlyEarnings() and GET /api/investor. Readers that
// already hold settled months (reconcileInvestorPayouts(), the fleet-wide
// report) walk them with carryForward() through server.js's
// computeLossCarryForward(). A second copy of either rule is how the portal and
// the ledger came to publish two different figures for one month before.
//
// ⚠️ A SPLIT MONTH IS EXACTLY THE ARITHMETIC THAT SHIPPED BEFORE THIS MODULE:
// Math.round(netProfit * splitFraction) on the RAW (unrounded) net profit, with
// splitFraction = resolveInvestorSplitPct(config) / 100, and the same carry walk.
// scripts/test-investor-payout-basis.js compares it with the old formula and the
// old walk, value for value, over thousands of random months.
//
// A LEASE MONTH pays the lease, prorated by the days a truck was in service, or
// nothing during downtime or before a truck is in service (the three settings
// below). It neither absorbs nor adds to the split months' running deficit: a
// lease month is not a share of profit, so a loss is not carried against it.
//
// The basis rows come from server.js's investor_payout_basis table: the row with
// the latest effective_month on or before a month governs it, and no row means
// the split. INVESTOR_LEASE_PAYOUTS_ENABLED gates all of it: the context server.js
// passes carries `enabled`, and leaseBasisActive() is the one test of it.
//
// Pure: no I/O and no requires, so a runner can load it on its own.
// scripts/test-investor-payout-basis.js.

const BASIS_TYPES = Object.freeze(["split", "lease"]);
const BASIS_SOURCES = Object.freeze(["signed_terms", "admin"]);

// A lease is whole dollars, $1 to $100,000, stored as cents (a multiple of 100),
// the same range the invitation terms allow.
const LEASE_CENTS_MIN = 100;
const LEASE_CENTS_MAX = 10000000;
const LEASE_DOLLARS_MIN = LEASE_CENTS_MIN / 100;
const LEASE_DOLLARS_MAX = LEASE_CENTS_MAX / 100;
const NOTE_MAX = 300;
// How far ahead an admin may date a basis change, and the earliest month one may
// start (well before any payout; it keeps a mistyped year from making the ledger
// walk centuries of months).
const MONTHS_AHEAD_MAX = 12;
const EFFECTIVE_MONTH_MIN = "2020-01";

// The three client settings, each read from the environment once at boot. An
// unset value takes the default quietly; a value that names no setting takes it
// with one warning. The defaults follow the master agreement and the lease:
//   downtime    "unpaid"  master §3.1: nothing is owed during Operational Downtime
//   prorate     "daily"   lease §1.02: the term starts at vehicle delivery, and
//                         master §4.03 pays up to the decommission date
//   retirement  "stop"    master §4.03 / lease §9.01: the lease ends with the truck
const SETTINGS = Object.freeze({
	downtime: Object.freeze({ env: "INVESTOR_LEASE_DOWNTIME", values: Object.freeze(["unpaid", "paid"]), fallback: "unpaid" }),
	prorate: Object.freeze({ env: "INVESTOR_LEASE_PRORATE", values: Object.freeze(["daily", "none"]), fallback: "daily" }),
	retirement: Object.freeze({ env: "INVESTOR_LEASE_RETIREMENT", values: Object.freeze(["stop", "continue"]), fallback: "stop" }),
});
const DEFAULT_SETTINGS = Object.freeze({ downtime: "unpaid", prorate: "daily", retirement: "stop" });

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, "0");

function isMonthKey(v) {
	return typeof v === "string" && MONTH_RE.test(v);
}

// 'YYYY-MM' plus n months (n may be negative).
function addMonths(monthKey, n) {
	const y = parseInt(monthKey.slice(0, 4), 10);
	const m = parseInt(monthKey.slice(5, 7), 10) - 1 + n;
	const year = y + Math.floor(m / 12);
	const month = ((m % 12) + 12) % 12;
	return `${year}-${pad2(month + 1)}`;
}

function daysInMonth(monthKey) {
	const y = parseInt(monthKey.slice(0, 4), 10);
	const m = parseInt(monthKey.slice(5, 7), 10);
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---- settings ---------------------------------------------------------------
function readLeaseSettings(env, warn) {
	const out = {};
	for (const [key, s] of Object.entries(SETTINGS)) {
		const raw = env ? env[s.env] : undefined;
		const value = String(raw ?? "").trim().toLowerCase();
		if (value === "") {
			out[key] = s.fallback;
		} else if (s.values.includes(value)) {
			out[key] = value;
		} else {
			out[key] = s.fallback;
			if (typeof warn === "function") {
				warn(`${s.env}=${JSON.stringify(String(raw).slice(0, 40))} is not one of ${s.values.join(", ")}; using "${s.fallback}".`);
			}
		}
	}
	return Object.freeze(out);
}

// ---- the flag gate ------------------------------------------------------------
// THE one test of INVESTOR_LEASE_PAYOUTS_ENABLED. Every lease decision below goes
// through it, so with the flag off no basis row can move a figure or a month.
function leaseBasisActive(basis) {
	return !!basis && basis.enabled === true;
}

// ---- basis rows -----------------------------------------------------------------
// A lease row's amount in cents, or null when the row is not a lease with a
// whole-dollar amount in range. The table's CHECK constraint and the write paths
// only ever store valid rows; a row that is not one reads as the split, the
// default, rather than as a lease of some other amount.
function leaseCentsOf(row) {
	if (!row || row.basis_type !== "lease") return null;
	const c = row.lease_amount_cents;
	if (!Number.isSafeInteger(c) || c < LEASE_CENTS_MIN || c > LEASE_CENTS_MAX || c % 100 !== 0) return null;
	return c;
}

// The row that governs `monthKey`: the latest effective_month on or before it.
function governingBasisRow(rows, monthKey) {
	let best = null;
	for (const r of rows || []) {
		if (!r || !isMonthKey(r.effective_month) || r.effective_month > monthKey) continue;
		if (!best || r.effective_month > best.effective_month) best = r;
	}
	return best;
}

// A settled month keeps the basis it was settled under. basis.settledSplitMonths
// lists the owner's months already FINALIZED as the split (their frozen breakdown
// carries no payoutBasis): each stays the split whatever row now governs it, so a
// lease row recorded while the flag was off (the acceptance records one) cannot
// relabel, re-price or re-walk the carry of a month that closed before the flag
// was turned on.
function frozenAsSplit(basis, monthKey) {
	return Array.isArray(basis.settledSplitMonths) && basis.settledSplitMonths.includes(monthKey);
}

// Whether a frozen finalized_breakdown (JSON text) records a lease month.
// Absent, empty or unreadable is the split: every month closed before lease
// payouts existed was one.
function frozenBreakdownIsLease(breakdownJson) {
	if (typeof breakdownJson !== "string" || !breakdownJson) return false;
	try {
		const b = JSON.parse(breakdownJson);
		return !!(b && b.payoutBasis && b.payoutBasis.type === "lease");
	} catch {
		return false;
	}
}

// The lease row that governs `monthKey` under an active basis, or null for the
// split (no row, a split row, or a month frozen as the split).
function governingLeaseRow(basis, monthKey) {
	if (frozenAsSplit(basis, monthKey)) return null;
	const row = governingBasisRow(basis.rows, monthKey);
	return leaseCentsOf(row) === null ? null : row;
}

// { leaseAmount, effectiveMonth } when `monthKey` is a lease month under an
// active basis, else null.
function leaseBasisForMonth(basis, monthKey) {
	if (!leaseBasisActive(basis)) return null;
	const row = governingLeaseRow(basis, monthKey);
	return row ? { leaseAmount: row.lease_amount_cents / 100, effectiveMonth: row.effective_month } : null;
}

// The first month the monthly array must hold: the earliest activity month, or
// the earliest lease row's month when that is earlier, so a lease month with no
// activity still exists (and pays as the downtime setting says).
function firstPayoutMonth(activityStartMonth, basis) {
	if (!leaseBasisActive(basis)) return activityStartMonth;
	let first = activityStartMonth;
	for (const r of basis.rows || []) {
		if (leaseCentsOf(r) !== null && isMonthKey(r.effective_month) && r.effective_month < first) first = r.effective_month;
	}
	return first;
}

// ---- the idle month -----------------------------------------------------------------
// A month with no revenue, no driver pay, no trip expenses, no maintenance or
// compliance cost and no driver with an active day. Both monthly builders defer
// the month's fixed costs on it, and a lease under downtime "unpaid" pays nothing
// for it: one predicate, so the two can never disagree about which months are idle.
function isZeroActivityMonth({ revenue, driverPay, tripExpenses, maintFundCost, complianceCost, driverCount }) {
	return revenue === 0 && driverPay === 0 && tripExpenses === 0 && maintFundCost === 0 && complianceCost === 0 && driverCount === 0;
}

// ---- coverage ---------------------------------------------------------------------------
// A truck's first and last day in the fleet, as 'YYYY-MM-DD' ("" = no bound).
// First: in_service_date when it is YYYY-MM-DD, else the local date of
// created_at (the fallback truckChargeFromMonth() takes), else unbounded. Last:
// retired_at, inclusive, when it is a real month and day and the retirement
// setting is "stop"; otherwise unbounded (truckChargeUntilMonth()'s reading).
// Dates are compared as strings, never through new Date() of a bare day, which
// is UTC midnight and so the previous day in Houston.
function truckServiceBounds(t, retirement) {
	let from = "";
	const inService = String((t && t.in_service_date) || "").trim();
	if (DAY_RE.test(inService)) {
		from = inService;
	} else if (t && t.created_at) {
		const d = new Date(t.created_at);
		if (!isNaN(d)) from = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	}
	let until = "";
	if (retirement === "stop") {
		const retired = String((t && t.retired_at) || "").trim();
		const m = retired.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (m) {
			const mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
			if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) until = retired;
		}
	}
	return { from, until };
}

// Days of `monthKey` the lease covers: on or after the governing row's first day,
// with at least one of the investor's trucks in the fleet.
function leaseCoverage({ monthKey, effectiveMonth, trucks, retirement }) {
	const days = daysInMonth(monthKey);
	const leaseFrom = `${effectiveMonth}-01`;
	const bounds = (trucks || []).map((t) => truckServiceBounds(t, retirement));
	let coveredDays = 0;
	for (let d = 1; d <= days; d++) {
		const day = `${monthKey}-${pad2(d)}`;
		if (day < leaseFrom) continue;
		if (bounds.some((b) => (!b.from || day >= b.from) && (!b.until || day <= b.until))) coveredDays++;
	}
	return { coveredDays, daysInMonth: days };
}

// What one lease month pays, whole dollars, and why when it is not the lease.
// Precedence: no covered day, then downtime, then proration.
function leaseMonthPayment({ leaseAmount, coveredDays, daysInMonth: days, zeroActivity, settings }) {
	const s = settings || DEFAULT_SETTINGS;
	if (coveredDays === 0) return { paidAmount: 0, reason: "not_in_service" };
	if (s.downtime === "unpaid" && zeroActivity) return { paidAmount: 0, reason: "downtime" };
	if (s.prorate === "daily") {
		const paidAmount = Math.round(leaseAmount * coveredDays / days);
		return { paidAmount, reason: coveredDays < days ? "prorated" : null };
	}
	return { paidAmount: leaseAmount, reason: null };
}

// ---- the carry walk --------------------------------------------------------------------
// A split month where costs outran revenue has NEGATIVE investor earnings. It
// pays $0, and the loss carries forward as a deficit that later profitable split
// months absorb, so payable is never negative and the lifetime total is
// unchanged. A lease month pays its lease and leaves the deficit where it is.
//
// Walks oldest → newest (the monthly arrays are ordered that way), so the result
// is deterministic and every caller is idempotent. No mutation of the input.
// Returns { "YYYY-MM": { raw, payable, carriedIn, deferred } } for EVERY month
// passed in, so a caller may index it without a presence check.
function carryForward(monthlyEarnings) {
	const carryByPeriod = {};
	let deficit = 0;
	for (const m of monthlyEarnings || []) {
		const raw = Math.round(m.investorEarnings);
		let payable, carriedIn = 0, deferred = 0;
		if (m.payoutBasis && m.payoutBasis.type === "lease") {
			payable = raw;        // the lease is owed as it stands; the split deficit waits
		} else if (raw < 0) {
			deferred = -raw;      // this month's loss joins the running deficit
			deficit += deferred;
			payable = 0;
		} else {
			carriedIn = Math.min(deficit, raw); // earlier losses eat into this month
			payable = raw - carriedIn;
			deficit -= carriedIn;
		}
		carryByPeriod[m.month] = { raw, payable, carriedIn, deferred };
	}
	return carryByPeriod;
}

// ---- THE payout function ----------------------------------------------------------------
// months: [{ month: 'YYYY-MM', netProfit: RAW net profit, zeroActivity: boolean }],
//         oldest first, one per month.
// splitFraction: resolveInvestorSplitPct(config) / 100.
// basis: null, or { enabled, rows, trucks, settings, settledSplitMonths } from
//        server.js's payoutBasisContext() (rows: the owner's
//        investor_payout_basis rows; trucks: the owner's Active trucks, the
//        fixed-cost set; settledSplitMonths: the months finalized as the split,
//        which stay the split — see frozenAsSplit()).
// Returns { 'YYYY-MM': { month, investorEarnings, companyEarnings, payoutBasis,
//           raw, payable, carriedIn, deferred } }. payoutBasis is null on a split
// month and { type: "lease", leaseAmount, paidAmount, coveredDays, daysInMonth,
// reason } on a lease month.
function settleInvestorMonths(months, { splitFraction, basis = null } = {}) {
	const lease = leaseBasisActive(basis) ? basis : null;
	const settings = (lease && lease.settings) || DEFAULT_SETTINGS;
	const entries = [];
	for (const m of months || []) {
		const row = lease ? governingLeaseRow(lease, m.month) : null;
		if (row) {
			const leaseAmount = row.lease_amount_cents / 100;
			const { coveredDays, daysInMonth: days } = leaseCoverage({
				monthKey: m.month, effectiveMonth: row.effective_month, trucks: lease.trucks, retirement: settings.retirement,
			});
			const { paidAmount, reason } = leaseMonthPayment({ leaseAmount, coveredDays, daysInMonth: days, zeroActivity: m.zeroActivity, settings });
			entries.push({
				month: m.month,
				investorEarnings: paidAmount,
				companyEarnings: Math.round(m.netProfit - paidAmount),
				payoutBasis: { type: "lease", leaseAmount, paidAmount, coveredDays, daysInMonth: days, reason },
			});
		} else {
			// The split: applied to the RAW net profit and rounded once.
			const investorEarnings = Math.round(m.netProfit * splitFraction);
			entries.push({
				month: m.month,
				investorEarnings,
				companyEarnings: Math.round(m.netProfit - investorEarnings),
				payoutBasis: null,
			});
		}
	}
	const carry = carryForward(entries);
	const out = {};
	for (const e of entries) out[e.month] = { ...e, ...carry[e.month] };
	return out;
}

// ---- the admin write ------------------------------------------------------------------------
function basisRefusal(status, code, field, error) {
	return { ok: false, status, code, field, error };
}

// Admin text: control, format and line-separator characters become a space,
// runs of spaces collapse, and the ends are trimmed.
function cleanNote(text) {
	return text
		.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

// The whole-dollar lease amount of a PUT body, as { ok, cents } or a refusal.
// A number, or a string of digits with at most two decimals; a value that is
// not whole dollars is its own refusal, so the panel can say exactly that.
function readLeaseAmount(value) {
	let n;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		n = value;
	} else if (typeof value === "string") {
		const text = value.trim();
		if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) return null;
		n = Number(text);
	} else {
		return null;
	}
	if (!Number.isInteger(n)) return { ok: false, wholeDollars: false };
	return { ok: true, cents: n * 100 };
}

// PUT /api/investors/:id/payout-basis's body → the row to write, or the refusal.
// 400 INVALID_BASIS names the field; 400 LEASE_AMOUNT_WHOLE_DOLLARS; 409
// BASIS_MONTH_CLOSED when effectiveMonth is before earliestEditableMonth (a
// settled or closed month's basis never changes). currentMonth is Houston's
// 'YYYY-MM'.
function readBasisInput(body, { currentMonth, earliestEditableMonth = null } = {}) {
	const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
	const type = src.type;
	if (!BASIS_TYPES.includes(type)) {
		return basisRefusal(400, "INVALID_BASIS", "type", 'type must be "lease" or "split".');
	}
	let leaseAmountCents = null;
	if (type === "lease") {
		const amount = readLeaseAmount(src.leaseAmount);
		if (!amount) {
			return basisRefusal(400, "INVALID_BASIS", "leaseAmount", `leaseAmount must be the monthly lease in whole dollars, ${LEASE_DOLLARS_MIN} to ${LEASE_DOLLARS_MAX}.`);
		}
		if (!amount.ok) {
			return basisRefusal(400, "LEASE_AMOUNT_WHOLE_DOLLARS", "leaseAmount", "leaseAmount must be whole dollars, for example 2000.");
		}
		if (amount.cents < LEASE_CENTS_MIN || amount.cents > LEASE_CENTS_MAX) {
			return basisRefusal(400, "INVALID_BASIS", "leaseAmount", `leaseAmount must be between ${LEASE_DOLLARS_MIN} and ${LEASE_DOLLARS_MAX} dollars.`);
		}
		leaseAmountCents = amount.cents;
	}
	const effectiveMonth = src.effectiveMonth;
	if (!isMonthKey(effectiveMonth)) {
		return basisRefusal(400, "INVALID_BASIS", "effectiveMonth", "effectiveMonth must be a month, YYYY-MM.");
	}
	if (effectiveMonth < EFFECTIVE_MONTH_MIN) {
		return basisRefusal(400, "INVALID_BASIS", "effectiveMonth", `effectiveMonth must be ${EFFECTIVE_MONTH_MIN} or later.`);
	}
	const latest = addMonths(currentMonth, MONTHS_AHEAD_MAX);
	if (effectiveMonth > latest) {
		return basisRefusal(400, "INVALID_BASIS", "effectiveMonth", `effectiveMonth can be at most ${MONTHS_AHEAD_MAX} months ahead (${latest}).`);
	}
	let note = "";
	if (src.note !== undefined && src.note !== null) {
		if (typeof src.note !== "string" || src.note.length > NOTE_MAX * 4) {
			return basisRefusal(400, "INVALID_BASIS", "note", `note must be text of at most ${NOTE_MAX} characters.`);
		}
		note = cleanNote(src.note);
		if (note.length > NOTE_MAX) {
			return basisRefusal(400, "INVALID_BASIS", "note", `note must be text of at most ${NOTE_MAX} characters.`);
		}
	}
	if (earliestEditableMonth && effectiveMonth < earliestEditableMonth) {
		return basisRefusal(409, "BASIS_MONTH_CLOSED", "effectiveMonth",
			`Payouts through ${addMonths(earliestEditableMonth, -1)} are settled or closed, so the basis can change from ${earliestEditableMonth} onward.`);
	}
	return { ok: true, value: { type, leaseAmountCents, effectiveMonth, note } };
}

// "$2,000": whole dollars, grouped by hand so no locale can change it.
function formatLeaseAmount(dollars) {
	const digits = String(Math.round(Math.abs(Number(dollars) || 0)));
	let grouped = "";
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) grouped += ",";
		grouped += digits[i];
	}
	return `$${grouped}`;
}

// One line for the audit trail: "from 2026-09 lease $2,000 (signed_terms);
// from 2026-11 split (admin)", or the default when there is no row.
function describeSchedule(rows) {
	const list = [...(rows || [])].sort((a, b) => String(a.effective_month).localeCompare(String(b.effective_month)));
	if (!list.length) return "no basis rows (split at the Split %)";
	return list.map((r) => {
		const cents = leaseCentsOf(r);
		const what = cents !== null ? `lease ${formatLeaseAmount(cents / 100)}` : "split";
		return `from ${r.effective_month} ${what} (${r.source})${r.note ? ` note "${r.note}"` : ""}`;
	}).join("; ");
}

module.exports = {
	BASIS_TYPES,
	BASIS_SOURCES,
	LEASE_CENTS_MIN,
	LEASE_CENTS_MAX,
	NOTE_MAX,
	MONTHS_AHEAD_MAX,
	EFFECTIVE_MONTH_MIN,
	SETTINGS,
	DEFAULT_SETTINGS,
	isMonthKey,
	addMonths,
	daysInMonth,
	readLeaseSettings,
	leaseBasisActive,
	leaseCentsOf,
	governingBasisRow,
	frozenBreakdownIsLease,
	leaseBasisForMonth,
	firstPayoutMonth,
	isZeroActivityMonth,
	truckServiceBounds,
	leaseCoverage,
	leaseMonthPayment,
	carryForward,
	settleInvestorMonths,
	readBasisInput,
	formatLeaseAmount,
	describeSchedule,
};
