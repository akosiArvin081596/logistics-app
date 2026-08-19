#!/usr/bin/env node
/**
 * Tests for trucks.retired_at — the LAST month a truck accrues fixed costs, and
 * the mirror of in_service_date.
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-status-override-guard.js and test-money-date.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import. Extracting the text keeps this honest in the way that matters — it
 * exercises THE CODE THAT SHIPS, not a copy that can quietly drift. The
 * extraction asserts each function is found exactly once, so a rename or a
 * second definition fails the run loudly rather than silently testing nothing.
 *
 * THE PROPERTY UNDER TEST is not "a retired truck stops billing". It is that
 * THE GUARD AND THE MONEY MATH AGREE — because a guard that disagrees with the
 * math it protects is how a retired truck keeps billing an investor silently.
 * That is the exact inversion corrected in PR #205 (user delete) and again in
 * PR #216 (truck create), both times on the in_service_date half.
 *
 * It is proved two ways, and BOTH are required:
 *
 *   §1 TEXTUAL. Every fixed-cost month gate in server.js is literally the same
 *      call to truckChargedInMonth(). Asserted by counting occurrences in the
 *      shipped source, so a future hand-rolled sixth gate fails this run. A
 *      behavioural test cannot catch that — a new gate simply would not be
 *      exercised.
 *
 *   §2 BEHAVIOURAL, against an INDEPENDENT ORACLE. Testing truckChargedInMonth
 *      against itself proves nothing, so the oracle below is written from the
 *      stated semantics (both bounds inclusive; an empty bound is no bound) in a
 *      deliberately different shape — month-index arithmetic rather than string
 *      comparison. The shipped predicate, the shipped guard and the oracle are
 *      then compared across the full cross-product of fixtures x months.
 *
 * THE DANGEROUS VALUE is "". truckChargeFromMonth returns it for "no usable
 * in-service date" and the money math reads it as CHARGE EVERY MONTH; its mirror
 * truckChargeUntilMonth returns it for "not retired" and the math must read it
 * as CHARGE FOREVER. Every existing production row has retired_at = "", so a
 * guard reading that "" as "retired long ago" would report zero exposure for the
 * ENTIRE fleet. §4 pins both directions.
 *
 * Fixtures are production-shaped: the 6 real trucks and the 15 real locked
 * periods (2025-05..2026-07), read read-only from production on 2026-08-09.
 *
 * Run: node scripts/test-truck-retirement.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	}
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

const REAL = [
	"truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth",
	"truckBilledMonthCount", "truckFixedCostLockedMonths", "truckMonthlyFixed",
	"parseInServiceDate", "parseRetiredAt",
];

// The only stubs: the clock (so the horizon cap is deterministic) and the
// constant it reads. Stubbing the month math would test nothing.
let TODAY_CT = "2026-08-09";
const todayKeyCT = () => TODAY_CT;
const IN_SERVICE_MAX_MONTHS_AHEAD = (() => {
	const m = SRC.match(/const IN_SERVICE_MAX_MONTHS_AHEAD = (\d+);/);
	if (!m) throw new Error("IN_SERVICE_MAX_MONTHS_AHEAD not found in server.js");
	return parseInt(m[1], 10);
})();

const M = new Function(
	"todayKeyCT", "IN_SERVICE_MAX_MONTHS_AHEAD",
	`${REAL.map(extract).join("\n")}\nreturn { ${REAL.join(", ")} };`
)(todayKeyCT, IN_SERVICE_MAX_MONTHS_AHEAD);

const {
	truckChargeFromMonth, truckChargeUntilMonth, truckChargedInMonth,
	truckBilledMonthCount, truckFixedCostLockedMonths, truckMonthlyFixed,
	parseRetiredAt,
} = M;

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// ------------------------------------------------------- independent oracle
// Written from the SPEC, not from the implementation, and deliberately in a
// different shape: month INDEX arithmetic instead of 'YYYY-MM' string compare.
// If the two agree across the whole cross-product, the string comparison in the
// shipped code is doing what the spec says.
const idx = (mk) => parseInt(mk.slice(0, 4), 10) * 12 + (parseInt(mk.slice(5, 7), 10) - 1);
function oracleCharged(truck, monthKey) {
	const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
	// start: in_service_date, else created_at's month, else unbounded
	let start = null;
	if (isDate(truck.in_service_date)) start = idx(String(truck.in_service_date).trim().slice(0, 7));
	else if (truck.created_at) {
		const d = new Date(truck.created_at);
		start = d.getFullYear() * 12 + d.getMonth();
	}
	// end: retired_at only. No created_at fallback. Unbounded when absent.
	let end = null;
	if (isDate(truck.retired_at)) end = idx(String(truck.retired_at).trim().slice(0, 7));
	const m = idx(monthKey);
	if (start !== null && m < start) return false;   // inclusive lower bound
	if (end !== null && m > end) return false;       // inclusive upper bound
	return true;
}

// ------------------------------------------------------------------ fixtures
// The 15 locked periods on production, newest first (2026-08 is the open month).
const LOCKED = [
	"2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
	"2025-12", "2025-11", "2025-10", "2025-09", "2025-08", "2025-07", "2025-06", "2025-05",
];
// The 6 real production trucks (read-only probe, 2026-08-09).
const PROD = [
	{ id: 2, unit_number: "LogisX-#33", status: "Active", owner_id: 5, created_at: "2026-04-15 03:10:50", in_service_date: "", retired_at: "", insurance_monthly: 1630, eld_monthly: 50, truck_payment_monthly: 1200, hvut_annual: 580, irp_annual: 1380 },
	{ id: 3, unit_number: "LogisX-#2372", status: "Active", owner_id: 0, created_at: "2026-04-17 14:28:15", in_service_date: "", retired_at: "", insurance_monthly: 1630, eld_monthly: 50, truck_payment_monthly: 0, hvut_annual: 295, irp_annual: 2007 },
	{ id: 4, unit_number: "LogisX-#302", status: "Active", owner_id: 41, created_at: "2026-04-20 19:31:37", in_service_date: "", retired_at: "", insurance_monthly: 1520, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0 },
	{ id: 5, unit_number: "INV-24-A", status: "Active", owner_id: 42, created_at: "2026-04-20 20:16:38", in_service_date: "", retired_at: "", insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0 },
	{ id: 11, unit_number: "Logisx-#91", status: "Active", owner_id: 5, created_at: "2026-05-21 12:07:08", in_service_date: "2026-08-04", retired_at: "", insurance_monthly: 1680, eld_monthly: 50, truck_payment_monthly: 1210, hvut_annual: 580, irp_annual: 1410 },
	{ id: 12, unit_number: "LogisX-TEST", status: "Active", owner_id: 0, created_at: "2026-05-30 01:16:45", in_service_date: "", retired_at: "", insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0 },
];
const t33 = () => ({ ...PROD[0] });

// Every month from 2025-01 to 2027-06 — well outside the locked range on both
// sides, so the cross-product exercises months before the first lock and after
// the last.
const ALL_MONTHS = [];
for (let y = 2025; y <= 2027; y++) for (let mo = 1; mo <= 12; mo++) ALL_MONTHS.push(`${y}-${String(mo).padStart(2, "0")}`);

// ================================================================== §1 TEXTUAL
section("1. TEXTUAL — every fixed-cost month gate routes through ONE predicate");
{
	// ⚠️ FIVE, not four — and the fifth is correct, which is why this pin moved
	// rather than the code. The gates are: computeInvestorMonthlyEarnings ×2
	// (the month total and its detail month), /api/investor ×2, and
	// /api/financials ×1. The pair inside /api/investor is deliberate:
	// getMonthlyFixedCosts() computes the total and getMonthlyFixedCostParts()
	// the breakdown, and the breakdown re-walks THE SAME gated loop so the parts
	// sum to the total by construction rather than by coincidence — the comment
	// beside it records the $3,107 discrepancy that taught that lesson. Deleting
	// one to satisfy a stale count would reintroduce exactly that bug.
	//
	// A bare count is a weak pin, but it is the one that catches the thing that
	// matters: a SIXTH gate appearing that does not route through the shared
	// predicate. If it trips, read the new call site before touching this number.
	const gateCalls = (SRC.match(/if \(!truckChargedInMonth\(/g) || []).length;
	eq(gateCalls, 5, "five money month-gates call truckChargedInMonth() directly");

	// The guard delegates to it too, via truckFixedCostLockedMonths.
	const guardSrc = extract("truckFixedCostLockedMonths");
	ok(/truckChargedInMonth\(truck, p\)/.test(guardSrc),
		"truckFixedCostLockedMonths delegates to truckChargedInMonth (does not re-derive)");
	ok(!/truckChargeFromMonth|monthKey <|p >= from/.test(guardSrc),
		"truckFixedCostLockedMonths hand-rolls NO bound of its own");

	// The old hand-rolled gate shape must be gone everywhere.
	const oldGate = (SRC.match(/truckKey && month(Key)? < truckKey/g) || []).length;
	eq(oldGate, 0, "no hand-rolled `truckKey && monthKey < truckKey` gate survives");
	const oldGateMk = (SRC.match(/truckKey && mk < truckKey/g) || []).length;
	eq(oldGateMk, 0, "no hand-rolled `truckKey && mk < truckKey` gate survives");

	// All-time totals: the four month-COUNT sites must use the shared counter.
	const countCalls = (SRC.match(/truckBilledMonthCount\(/g) || []).length;
	// 1 definition + 4 call sites
	eq(countCalls, 5, "truckBilledMonthCount: 1 definition + 4 all-time-total call sites");

	// Every fixed-cost SELECT list must carry retired_at, or the bound silently
	// never fires — undefined column => truckChargeUntilMonth returns "".
	const fixedSelects = SRC.match(/SELECT [^"]*insurance_monthly[^"]*FROM trucks/g) || [];
	const missing = fixedSelects.filter((q) => !/retired_at/.test(q) && !/SELECT \*/.test(q));
	eq(missing, [], "every explicit fixed-cost SELECT list includes retired_at");
	ok(fixedSelects.length >= 7, `found ${fixedSelects.length} explicit fixed-cost SELECT lists (>=7)`);
}

// =============================================== §2 GUARD vs MATH vs ORACLE
section("2. BEHAVIOURAL — predicate, guard and independent oracle agree");
{
	// Fixtures: production rows plus retirement dates placed BEFORE, DURING and
	// AFTER the locked range, which is what the task requires.
	const cases = [
		["not retired", { ...t33(), retired_at: "" }],
		["retired BEFORE the first lock", { ...t33(), retired_at: "2025-01-15" }],
		["retired ON the first locked month", { ...t33(), retired_at: "2025-05-31" }],
		["retired DURING the locked range", { ...t33(), retired_at: "2026-02-14" }],
		["retired ON the last locked month", { ...t33(), retired_at: "2026-07-27" }],
		["retired in the open month", { ...t33(), retired_at: "2026-08-09" }],
		["retired in the FUTURE", { ...t33(), retired_at: "2027-01-31" }],
		["retired same month as in service", { ...t33(), in_service_date: "2026-04-02", retired_at: "2026-04-28" }],
		["malformed retired_at", { ...t33(), retired_at: "2026-8-4" }],
		["nonsense retired_at", { ...t33(), retired_at: "not-a-date" }],
		["null retired_at", { ...t33(), retired_at: null }],
		["no created_at, no dates", { ...t33(), created_at: null, in_service_date: "", retired_at: "" }],
	];

	for (const [label, truck] of cases) {
		// (a) shipped predicate == independent oracle, every month
		const mismatched = ALL_MONTHS.filter((mk) => truckChargedInMonth(truck, mk) !== oracleCharged(truck, mk));
		eq(mismatched, [], `${label}: shipped predicate matches oracle in all ${ALL_MONTHS.length} months`);

		// (b) THE POINT: the guard's month list == the months the math bills,
		// restricted to locked months. Computed from the oracle, not the predicate.
		const guardMonths = truckFixedCostLockedMonths(truck, LOCKED).slice().sort();
		const mathMonths = LOCKED.filter((p) => oracleCharged(truck, p)).sort();
		eq(guardMonths, mathMonths, `${label}: GUARD agrees with MATH on which locked months are billed`);
	}

	// Same cross-product over every production truck, unmodified.
	for (const truck of PROD) {
		const mismatched = ALL_MONTHS.filter((mk) => truckChargedInMonth(truck, mk) !== oracleCharged(truck, mk));
		eq(mismatched, [], `production ${truck.unit_number}: predicate matches oracle`);
		eq(truckFixedCostLockedMonths(truck, LOCKED).slice().sort(),
			LOCKED.filter((p) => oracleCharged(truck, p)).sort(),
			`production ${truck.unit_number}: guard agrees with math`);
	}
}

// ============================================== §3 EXACT MONTHS + THE DOLLARS
section("3. The retirement month IS billed (inclusive), and the dollars");
{
	const monthly = truckMonthlyFixed(t33()).total;
	eq(monthly, 3043.33, "LogisX-#33 monthly fixed cost matches production");

	// Retired 2026-07-27 -> July is still billed, so nothing leaves a locked month.
	const retJul = { ...t33(), retired_at: "2026-07-27" };
	eq(truckFixedCostLockedMonths(retJul, LOCKED).sort(),
		["2026-04", "2026-05", "2026-06", "2026-07"],
		"retired 2026-07-27: all four locked months still billed (INCLUSIVE upper bound)");
	ok(truckChargedInMonth(retJul, "2026-07"), "retirement month itself is billed");
	ok(!truckChargedInMonth(retJul, "2026-08"), "the month AFTER retirement is not billed");

	// Retired one month earlier -> July leaves a finalized month. $1,520-class harm.
	const retJun = { ...t33(), retired_at: "2026-06-30" };
	eq(truckFixedCostLockedMonths(retJun, LOCKED).sort(),
		["2026-04", "2026-05", "2026-06"],
		"retired 2026-06-30: July drops out of the billed set");

	// Mid-month retirement bills the whole month — no proration, mirroring
	// in_service_date (a truck in service 2026-04-15 is billed all of April).
	for (const d of ["2026-07-01", "2026-07-15", "2026-07-31"]) {
		eq(truckFixedCostLockedMonths({ ...t33(), retired_at: d }, LOCKED).sort(),
			["2026-04", "2026-05", "2026-06", "2026-07"],
			`retired ${d}: whole month billed, no proration`);
	}

	// In service and retired in the SAME month = exactly one billed month.
	const oneMonth = { ...t33(), in_service_date: "2026-06-03", retired_at: "2026-06-28" };
	eq(truckFixedCostLockedMonths(oneMonth, LOCKED), ["2026-06"], "same-month in/out bills exactly one month");
	eq(truckBilledMonthCount(oneMonth, new Date(2026, 7, 9)), 1, "…and counts as 1 month, not 0");
}

// ================================================= §4 THE "" INVERSION TRAP
section('4. "" means UNBOUNDED at both ends — the PR #205 / #216 inversion');
{
	// Lower bound: no usable in-service date => charge in EVERY month.
	const noDates = { ...t33(), created_at: null, in_service_date: "", retired_at: "" };
	eq(truckChargeFromMonth(noDates), "", 'truckChargeFromMonth("") for a truck with no dates');
	eq(truckFixedCostLockedMonths(noDates, LOCKED).length, 15,
		'empty charge-FROM yields ALL 15 locked months, not zero (PR #205 inversion)');

	// Upper bound: not retired => charge FOREVER. Every production row is "".
	eq(truckChargeUntilMonth({ retired_at: "" }), "", 'truckChargeUntilMonth("") when not retired');
	eq(truckChargeUntilMonth({}), "", "truckChargeUntilMonth() with the column absent entirely");
	eq(truckChargeUntilMonth({ retired_at: null }), "", "truckChargeUntilMonth() with a NULL column");
	for (const truck of PROD) {
		ok(truckChargedInMonth(truck, "2027-12"),
			`${truck.unit_number}: un-retired truck still billed far in the future (NOT read as retired)`);
	}

	// A malformed retirement date must fall through to "charge forever", which is
	// the CONSERVATIVE direction — it keeps billing rather than silently stopping.
	for (const bad of ["2026-8-4", "2026-13-01", "not-a-date", "20260804", "2026-08"]) {
		eq(truckChargeUntilMonth({ retired_at: bad }), "", `malformed retired_at ${JSON.stringify(bad)} => "" (charge forever)`);
		ok(truckChargedInMonth({ ...t33(), retired_at: bad }, "2027-12"),
			`malformed retired_at ${JSON.stringify(bad)} does not silently retire the truck`);
	}

	// No created_at fallback on the upper bound — created_at is a lower bound by
	// nature and would retire every truck on the day its row was typed in.
	eq(truckChargeUntilMonth({ created_at: "2026-04-15 03:10:50", retired_at: "" }), "",
		"created_at is NOT used as a retirement date");

	// The bare-date/UTC trap: slice the string, never round-trip through Date.
	eq(truckChargeUntilMonth({ retired_at: "2026-08-01" }), "2026-08",
		"2026-08-01 reads as August, not July (no UTC-midnight shift)");
	eq(truckChargeFromMonth({ in_service_date: "2026-08-01" }), "2026-08",
		"…and the in-service half behaves the same way");
}

// ======================================== §5 ALL-TIME MONTH COUNT (Family B)
section("5. truckBilledMonthCount — the all-time totals are bounded too");
{
	const now = new Date(2026, 7, 9); // 2026-08-09
	// #33: created 2026-04, not retired => Apr,May,Jun,Jul,Aug = 5
	eq(truckBilledMonthCount(t33(), now), 5, "not retired: Apr..Aug = 5 months");
	// retired in July => Apr..Jul = 4
	eq(truckBilledMonthCount({ ...t33(), retired_at: "2026-07-27" }, now), 4, "retired July: Apr..Jul = 4 months");
	// retired in April => 1
	eq(truckBilledMonthCount({ ...t33(), retired_at: "2026-04-30" }, now), 1, "retired April: 1 month");
	// retired BEFORE in service => 0, never negative
	eq(truckBilledMonthCount({ ...t33(), in_service_date: "2026-06-01", retired_at: "2026-03-01" }, now), 0,
		"retired before in service: floor 0, never negative");
	// retired in the FUTURE must not invent months the truck has not lived
	eq(truckBilledMonthCount({ ...t33(), retired_at: "2027-06-30" }, now), 5,
		"future retirement does not add months beyond today");
	// unparseable start => null, so the caller keeps its own fallback
	eq(truckBilledMonthCount({ created_at: null, in_service_date: "", retired_at: "" }, now), null,
		"unparseable start month returns null (caller keeps monthsOfOperation)");
	// forward-dated truck accrues nothing yet — the existing floor-0 behaviour
	eq(truckBilledMonthCount({ in_service_date: "2026-12-01", created_at: null, retired_at: "" }, now), 0,
		"forward-dated truck still counts 0 months");
	// #91 today: in service 2026-08-04 => exactly 1
	eq(truckBilledMonthCount(PROD[4], now), 1, "Logisx-#91 (in service 2026-08-04) counts 1 month");
}

// ========================================================= §6 THE VALIDATOR
section("6. parseRetiredAt — mirrors parseInServiceDate exactly");
{
	eq(parseRetiredAt(undefined), { value: undefined }, "undefined = field not sent");
	eq(parseRetiredAt(""), { value: "" }, '"" = explicitly un-retired');
	eq(parseRetiredAt(null), { value: "" }, "null = un-retired");
	eq(parseRetiredAt("2026-07-27"), { value: "2026-07-27" }, "a real date passes");
	ok(parseRetiredAt("2026-8-4").error, "2026-8-4 refused (would read as charge-forever)");
	ok(parseRetiredAt("2026-13-01").error, "2026-13-01 refused (month 13 sorts above every real month)");
	ok(parseRetiredAt("2026-00-10").error, "month 00 refused");
	ok(parseRetiredAt("2026-07-00").error, "day 00 refused");
	ok(parseRetiredAt("2026-07-32").error, "day 32 refused");
	ok(parseRetiredAt("not-a-date").error, "garbage refused");
	ok(parseRetiredAt("2062-08-04").error, `beyond the ${IN_SERVICE_MAX_MONTHS_AHEAD}-month horizon refused`);
	// The horizon is shared with the in-service half so one number governs both.
	eq(parseRetiredAt("2028-08-01").error === undefined, true, "24 months ahead is inside the horizon");
	// Past dates are the whole point of the feature.
	eq(parseRetiredAt("2025-05-01"), { value: "2025-05-01" }, "a past retirement date is accepted by the VALIDATOR (the GUARD decides)");
}

// ===================================== §7 THE RETROACTIVITY GUARD, END-TO-END
section("7. Setting retired_at retroactively is refused; forward is allowed");
{
	// Reproduces guard check (4b)'s symmetric difference exactly as shipped: the
	// months at risk are the ones that CHANGE, not the whole history.
	const symDiff = (truck, next) => {
		const before = truckFixedCostLockedMonths(truck, LOCKED);
		const after = truckFixedCostLockedMonths({ ...truck, retired_at: next }, LOCKED);
		const b = new Set(before), a = new Set(after);
		return [...new Set([...before, ...after])].filter((p) => b.has(p) !== a.has(p)).sort();
	};
	const monthly = truckMonthlyFixed(t33()).total;

	// ALLOWED: retire effective the month that just closed — nothing moves.
	eq(symDiff(t33(), "2026-07-27"), [], "retire effective 2026-07-27: no locked month moves => ALLOWED");
	// ALLOWED: retire effective the open month.
	eq(symDiff(t33(), "2026-08-09"), [], "retire effective the open month => ALLOWED");
	// ALLOWED: retire in the future.
	eq(symDiff(t33(), "2027-01-01"), [], "retire effective a future month => ALLOWED");

	// REFUSED: pulling the retirement back removes finalized months.
	eq(symDiff(t33(), "2026-06-30"), ["2026-07"], "retire 2026-06-30 removes 2026-07 => REFUSED");
	eq(symDiff(t33(), "2026-04-30"), ["2026-05", "2026-06", "2026-07"], "retire 2026-04-30 removes three finalized months");
	// …and the dollars named in the blocker message.
	eq(Math.round(monthly * 3 * 100) / 100, 9129.99, "…worth $9,129.99 across those three months");

	// REFUSED: retiring before the first lock removes every billed locked month.
	eq(symDiff(t33(), "2025-01-01").length, 4, "retire before the fleet existed removes all four billed months");
	eq(Math.round(monthly * 4 * 100) / 100, 12173.32, "…the full $12,173.32 production exposure for LogisX-#33");

	// REFUSED in the other direction: UN-retiring adds months back.
	const alreadyRetired = { ...t33(), retired_at: "2026-05-31" };
	eq(symDiff(alreadyRetired, ""), ["2026-06", "2026-07"], "clearing retired_at ADDS finalized months back => REFUSED");
	eq(symDiff(alreadyRetired, "2026-07-31"), ["2026-06", "2026-07"], "extending retirement forward also adds them back => REFUSED");

	// A truck that was never billed into a closed month may be retired freely.
	eq(symDiff(PROD[4], "2026-08-31"), [], "Logisx-#91 (in service in the open month) retires freely");
	eq(symDiff(PROD[4], "2025-01-01").length, 0, "…and even a nonsense past date moves no locked month for it");

	// A $0 truck moves no money, but the guard still reports the months honestly.
	eq(symDiff(PROD[3], "2026-05-31"), ["2026-06", "2026-07"], "INV-24-A ($0/mo) still reports the months that move");
	eq(truckMonthlyFixed(PROD[3]).total, 0, "…while the dollar figure is correctly $0");
}

// ================================================= §8 REGRESSION: NO-OP TODAY
section("8. REGRESSION — with retired_at unset, behaviour is byte-identical");
{
	// Every production row has retired_at = "". Strip the column entirely and the
	// answers must not move: that is what makes the migration additive.
	for (const truck of PROD) {
		const withoutCol = { ...truck };
		delete withoutCol.retired_at;
		for (const mk of ALL_MONTHS) {
			if (truckChargedInMonth(truck, mk) !== truckChargedInMonth(withoutCol, mk)) {
				eq(`${truck.unit_number}@${mk}`, "identical", "column absent vs empty must agree");
			}
		}
		eq(truckFixedCostLockedMonths(withoutCol, LOCKED), truckFixedCostLockedMonths(truck, LOCKED),
			`${truck.unit_number}: guard identical with the column absent`);
		eq(truckBilledMonthCount(withoutCol, new Date(2026, 7, 9)), truckBilledMonthCount(truck, new Date(2026, 7, 9)),
			`${truck.unit_number}: month count identical with the column absent`);
	}
	// The exact production exposure figures from PR #210 must still reproduce.
	const exposure = (t) => Math.round(truckMonthlyFixed(t).total * truckFixedCostLockedMonths(t, LOCKED).length * 100) / 100;
	eq(exposure(PROD[0]), 12173.32, "LogisX-#33 locked-month exposure unchanged ($12,173.32)");
	eq(exposure(PROD[1]), 7487.32, "LogisX-#2372 locked-month exposure unchanged ($7,487.32)");
	eq(exposure(PROD[2]), 6080.00, "LogisX-#302 locked-month exposure unchanged ($6,080.00)");
	eq(exposure(PROD[4]), 0, "Logisx-#91 still carries no locked-month exposure");
}

// -------------------------------------------------------------------- report
console.log(`\n${"=".repeat(64)}`);
if (fail) {
	console.log(`FAILURES (${fail}):`);
	failures.forEach((f) => console.log(f));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
