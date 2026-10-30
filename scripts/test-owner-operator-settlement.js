#!/usr/bin/env node
/**
 * Owner-operators: the pure rules (lib/owner-operator.js) and the schema server.js
 * creates at boot. Made-up people, trucks and loads only (Appendix B's "Alex
 * Example", loads QA-OO-1 to QA-OO-9).
 *
 *   §1 the module and its exports
 *   §2 the four flags: on only when exactly "true"; the one start-up line
 *   §3 rounding half away from zero; dollars to cents (null when unreadable)
 *   §4 Saturday keys; a stamp's day on the business clock (an evening completion)
 *   §5 the first settlement week: the earlier of onboarding and the first load,
 *      never before the profile's week; the list of loads before it; the chain
 *      fixes it; where a receipt goes
 *   §6 the truck: the in-service date at onboarding, in-service weeks, weekly
 *      insurance and ELD from monthly amounts, skipped and pre-first weeks
 *   §7 the owner's example and Appendix B weeks 1-5 to the cent, a pay change, the final
 *      settlement with the escrow flag off, a partner source
 *   §8 the cases: short week, escrow start and cap, rejected receipt, removed
 *      load, installment default written once, escrow uses, the final's
 *      onboarding balance, the hold's dates, refusals
 *   §9 the investor-ledger test inputs
 *   §10 validators
 *   §11 the schema: eight tables and two columns, their checks, run by server.js
 *   §12 inert: server.js reads no flag, table or column; the module stays pure
 *   §13 mutants, each required to flip a check
 *
 * Run: node scripts/test-owner-operator-settlement.js   # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const Database = require("better-sqlite3");
const appTime = require("../lib/app-time");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const LIB_FILE = path.join(ROOT, "lib", "owner-operator.js");
const TZ = "America/New_York";

let realLib = null;
let loadError = "";
try { realLib = require(LIB_FILE); } catch (err) { loadError = err.code || err.message; }
const LIB_SRC = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : "";
const SRC = serverSource({ root: ROOT });

// ── reporting ─────────────────────────────────────────────────────────────────
// A section reports through a checker: the main run prints, a mutant run counts.
let passed = 0;
const failures = [];
function checker(print) {
	const c = { failed: [] };
	c.ok = (name, cond, detail) => {
		if (cond) { if (print) { passed++; console.log(`  ok    ${name}`); } return; }
		c.failed.push(name);
		if (print) {
			failures.push(name);
			const d = detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`;
			console.log(`  FAIL  ${name}${d}`);
		}
	};
	c.eq = (name, actual, expected) => c.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	return c;
}
const MAIN = checker(true);

// Exact cents from a dollar string, so no expected figure goes through a float.
function cents(s) {
	const t = String(s).replace(/,/g, "");
	const neg = t.startsWith("-");
	const [d, f = ""] = t.replace("-", "").split(".");
	const v = Number(d) * 100 + Number(`${f}00`.slice(0, 2));
	return neg ? -v : v;
}
const sum = (list) => list.reduce((s, x) => s + x, 0);
const pick = (o, keys) => keys.map((k) => (o ? o[k] : undefined));

// ── the made-up world: Appendix B ─────────────────────────────────────────────
const PROFILE_CREATED = "2026-11-02T15:00:00.000Z"; // accepted Monday Nov 2, 10 AM Eastern
const ONBOARDED = "2026-11-07T15:00:00.000Z"; // Saturday Nov 7, 10 AM Eastern
const TRUCK = { insurance_monthly: 1343.33, eld_monthly: 65, in_service_date: "2026-11-07", retired_at: "" };

function appendixBWorld(opts = {}) {
	return {
		profile: { feeBps: 1800, source: opts.source || "direct", escrowTargetCents: 250000, escrowWeeklyCents: 50000 },
		createdAt: PROFILE_CREATED,
		onboardedAt: ONBOARDED,
		installmentStored: opts.installmentStored === undefined ? 100000 : opts.installmentStored,
		charges: [
			{ id: 1, kind: "onboarding", label: "Form 2290", cents: 55000, voided_at: "" },
			{ id: 2, kind: "onboarding", label: "IRP plates", cents: 185000, voided_at: "" },
			{ id: 3, kind: "onboarding", label: "ELD device", cents: 30000, voided_at: "" },
			{ id: 4, kind: "onboarding", label: "Lettering", cents: 25000, voided_at: "" },
		],
		links: [{ startWeekStart: "2026-10-31", endWeekStart: "", truck: { ...TRUCK } }],
		loads: [
			{ ref: "qa-oo-1", day: "2026-11-09", cents: 350000, label: "QA-OO-1" },
			{ ref: "qa-oo-2", day: "2026-11-12", cents: 400000, label: "QA-OO-2" },
			{ ref: "qa-oo-3", day: "2026-11-18", cents: 210000, label: "QA-OO-3" },
			{ ref: "qa-oo-4", day: "2026-11-23", cents: 380000, label: "QA-OO-4" },
			{ ref: "qa-oo-5", day: "2026-11-26", cents: 420000, label: "QA-OO-5" },
			{ ref: "qa-oo-6", day: "2026-12-02", cents: 600000, label: "QA-OO-6" },
			{ ref: "qa-oo-7", day: "2026-12-07", cents: 300000, label: "QA-OO-7" },
			{ ref: "qa-oo-8", day: "2026-12-10", cents: 400000, label: "QA-OO-8" },
		],
		receipts: [
			{ ref: "exp-101", day: "2026-11-08", cents: 142035, label: "Fuel" },
			{ ref: "exp-102", day: "2026-11-10", cents: 110510, label: "Fuel" },
			{ ref: "exp-103", day: "2026-11-11", cents: 4650, label: "Toll" },
			{ ref: "exp-104", day: "2026-11-15", cents: 120000, label: "Fuel" },
			{ ref: "exp-105", day: "2026-11-19", cents: 78000, label: "Repair" },
			{ ref: "exp-106", day: "2026-11-22", cents: 150000, label: "Fuel" },
			{ ref: "exp-107", day: "2026-11-25", cents: 80000, label: "Fuel" },
			{ ref: "exp-108", day: "2026-11-30", cents: 200000, label: "Fuel" },
			// The paper toll the office uploads on Dec 1 with its scanned notice.
			{ ref: "exp-109", day: "2026-11-18", cents: 2375, label: "Toll", filedOn: "2026-12-01" },
			{ ref: "exp-110", day: "2026-12-06", cents: 130000, label: "Fuel" },
			{ ref: "exp-111", day: "2026-12-09", cents: 120000, label: "Fuel" },
		],
		settlements: [],
		endWeekStart: "",
		escrowOn: true,
		uses: [],
	};
}

// One generation; a builder that throws fails its week's checks instead of
// stopping the section.
function generate(L, world, weekStart, { asOf, final = false } = {}) {
	let result;
	try { result = buildWeek(L, world, weekStart, asOf, final); } catch (err) { result = { ok: false, code: "THREW", error: err.message }; }
	if (result && result.ok) world.settlements.push({ weekStart, lines: result.lines, final });
	return result;
}

// One week, as the server will run it: every input read, then the builder.
function buildWeek(L, world, weekStart, asOf, final) {
	const seen = (items) => items.filter((i) => !i.filedOn || i.filedOn <= asOf);
	const liveLines = world.settlements.flatMap((s) => s.lines);
	const chainStartWeek = world.settlements.length ? world.settlements[0].weekStart : "";
	const win = L.ooFirstSettlementWeek({ profileCreatedAt: world.createdAt, onboardedAt: world.onboardedAt, loads: seen(world.loads), chainStartWeek, timeZone: TZ });
	const settled = L.ooSettledFromLines(liveLines);
	const receipts = seen(world.receipts);
	const split = L.ooSplitReceipts(receipts, win);
	const pre = L.ooPreFirstWeekTruckCharges({ floorWeekStart: win.floorWeekStart, firstWeekStart: win.firstWeekStart, links: world.links });
	const onboardingLeftCents = L.ooOnboardingLeftCents({
		chargeCents: L.ooOnboardingChargeCents(world.charges),
		receiptCents: sum(split.onboarding.map((r) => r.cents)),
		truckCents: pre.cents,
		paidCents: L.ooInstallmentsPaidFromLines(liveLines),
	});
	const installment = L.ooEffectiveInstallment({ storedCents: world.installmentStored, onboardingLeftCents });
	if (installment.writeDefault) world.installmentStored = installment.cents;
	const previous = world.settlements.length ? world.settlements[world.settlements.length - 1].lines : [];
	return L.ooBuildSettlement({
		weekStart,
		window: win,
		endWeekStart: world.endWeekStart,
		final,
		profile: world.profile,
		installmentCents: installment.cents,
		loads: seen(world.loads),
		receipts,
		weeklyLines: L.ooWeeklyChargeLines({ weekStart, firstWeekStart: win.firstWeekStart, endWeekStart: world.endWeekStart, links: world.links, charges: world.charges, chargedRefs: settled.weekly }),
		oneTime: L.ooDueOneTimeCharges(world.charges, { weekStart, settledRefs: settled.oneTime }),
		settled,
		carriedInCents: L.ooCarriedOutCents(previous),
		onboardingLeftCents,
		escrow: { enabled: world.escrowOn, balanceCents: L.ooEscrowBalanceFromLines(liveLines), uses: world.uses },
	});
}

// Appendix B, cents: loads, fee, receipts, weekly, carried in, before, installment,
// escrow, net paid, carried out, onboarding left, escrow balance.
const APPENDIX_B = [
	["2026-11-07", "7,500.00", "1,350.00", "2,571.95", "325.00", "0.00", "3,253.05", "1,000.00", "0.00", "2,253.05", "0.00", "1,950.00", "0.00"],
	["2026-11-14", "2,100.00", "378.00", "1,980.00", "325.00", "0.00", "-583.00", "0.00", "0.00", "0.00", "583.00", "1,950.00", "0.00"],
	["2026-11-21", "8,000.00", "1,440.00", "2,300.00", "325.00", "583.00", "3,352.00", "1,000.00", "0.00", "2,352.00", "0.00", "950.00", "0.00"],
	["2026-11-28", "6,000.00", "1,080.00", "2,023.75", "325.00", "0.00", "2,571.25", "950.00", "0.00", "1,621.25", "0.00", "0.00", "0.00"],
	["2026-12-05", "7,000.00", "1,260.00", "2,500.00", "325.00", "0.00", "2,915.00", "0.00", "500.00", "2,415.00", "0.00", "0.00", "500.00"],
];
const TOTAL_KEYS = ["loadCents", "feeCents", "receiptCents", "weeklyCents", "carriedInCents", "beforeCents", "installmentCents",
	"escrowDepositCents", "payableCents", "carriedOutCents", "onboardingLeftAfterCents", "escrowBalanceAfterCents"];

// Weeks 1-5 of Appendix B, generated each Friday evening.
function runAppendixB(L, world) {
	const out = [];
	for (const row of APPENDIX_B) out.push(generate(L, world, row[0], { asOf: L.ooWeekEnd(row[0]) }));
	return out;
}

// ── §1 ───────────────────────────────────────────────────────────────────────
function moduleSection(c, L) {
	c.ok("§1 lib/owner-operator.js loads", !!L, loadError || "missing");
	if (!L) return;
	const names = ["ooFlagsFromEnv", "ooFlagsStartupLine", "ooToCents", "ooDivRound", "ooFeeCents", "ooShareCents", "ooWeeklyFromMonthlyCents",
		"ooInstallmentDefaultCents", "ooEffectiveInstallment", "ooIsDayKey", "ooAddDays", "ooWeekStart", "ooWeekEnd", "ooIsWeekStart",
		"ooWeeksBetween", "ooStampDay", "ooFirstSettlementWeek", "ooPlaceDay", "ooSplitReceipts", "ooInServiceDateOnCompletion",
		"ooTruckInServiceWeek", "ooTruckWeeklyCents", "ooTruckForWeek", "ooWeeklyChargeLines", "ooPreFirstWeekTruckCharges",
		"ooOnboardingChargeCents", "ooDueOneTimeCharges", "ooOwnerIdCell", "ooLoadOnInvestorLedger", "ooReceiptOnInvestorLedger",
		"ooSplitLedgerHolds", "ooSettledFromLines", "ooDiffItems", "ooNetCents", "ooCarriedOutCents", "ooEscrowBalanceFromLines",
		"ooInstallmentsPaidFromLines", "ooOnboardingLeftCents", "ooSettlementMath", "ooBuildSettlement", "ooFinalSettlementDue",
		"ooValidateFeeBps", "ooParseFeePercent", "ooParseDollarsToCents", "ooValidateEscrowTerms", "ooInstallmentChangeRefusal",
		"ooCleanLabel", "ooCleanReason", "ooValidateCharge", "ooPostedPeriod", "ooSourceFromReferral", "ooMatchableVin",
		"ooEndWeekRefusal", "ooIsOwnerOperatorPosition", "ooLoadRef"];
	const missing = names.filter((n) => typeof L[n] !== "function");
	c.eq("§1 every rule is exported", missing, []);
	c.eq("§1 the fee range and default, in basis points", [L.OO_FEE_MIN_BPS, L.OO_FEE_MAX_BPS, L.OO_FEE_DEFAULT_BPS], [1000, 2500, 1800]);
	c.eq("§1 the escrow defaults: $2,500 at $500 a week", [L.OO_ESCROW_TARGET_DEFAULT_CENTS, L.OO_ESCROW_WEEKLY_DEFAULT_CENTS], [250000, 50000]);
	c.eq("§1 the hold: 45 days, the final settlement 7 days before it ends", [L.OO_HOLD_DAYS, L.OO_FINAL_LEAD_DAYS], [45, 7]);
}

// ── §2 ───────────────────────────────────────────────────────────────────────
const FLAG_NAMES = ["OWNER_OPERATOR_ONBOARDING_ENABLED", "OWNER_OPERATOR_LOAD_PAY_ENABLED", "OWNER_OPERATOR_SETTLEMENTS_ENABLED", "OWNER_OPERATOR_ESCROW_ENABLED"];
function flagsSection(c, L) {
	const off = { onboarding: false, loadPay: false, settlements: false, escrow: false };
	c.eq("§2 every flag is off with nothing set", L.ooFlagsFromEnv({}), off);
	c.eq("§2 ...and with no environment at all", L.ooFlagsFromEnv(undefined), off);
	c.eq("§2 each is on with exactly \"true\"", L.ooFlagsFromEnv(Object.fromEntries(FLAG_NAMES.map((n) => [n, "true"]))),
		{ onboarding: true, loadPay: true, settlements: true, escrow: true });
	for (const v of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
		c.eq(`§2 ${JSON.stringify(v)} leaves a flag off`, L.ooFlagsFromEnv({ OWNER_OPERATOR_SETTLEMENTS_ENABLED: v }).settlements, false);
	}
	c.ok("§2 the flags read are frozen", Object.isFrozen(L.ooFlagsFromEnv({})));
	c.eq("§2 the four names", Object.values(L.OO_FLAG_NAMES || {}), FLAG_NAMES);
	c.eq("§2 the start-up line, every flag off", L.ooFlagsStartupLine(L.ooFlagsFromEnv({})),
		"[owner-operator] OWNER_OPERATOR_ONBOARDING_ENABLED off; OWNER_OPERATOR_LOAD_PAY_ENABLED off; OWNER_OPERATOR_SETTLEMENTS_ENABLED off; OWNER_OPERATOR_ESCROW_ENABLED off");
	c.eq("§2 ...with escrow alone on", L.ooFlagsStartupLine(L.ooFlagsFromEnv({ OWNER_OPERATOR_ESCROW_ENABLED: "true" })),
		"[owner-operator] OWNER_OPERATOR_ONBOARDING_ENABLED off; OWNER_OPERATOR_LOAD_PAY_ENABLED off; OWNER_OPERATOR_SETTLEMENTS_ENABLED off; OWNER_OPERATOR_ESCROW_ENABLED on");
}

// ── §3 ───────────────────────────────────────────────────────────────────────
function roundingSection(c, L) {
	c.eq("§3 18% of $7,500.00 is $1,350.00", L.ooFeeCents(750000, 1800), 135000);
	c.eq("§3 half a cent rounds up: 10% of 25 cents is 3 cents", L.ooFeeCents(25, 1000), 3);
	c.eq("§3 ...and away from zero on a reversal: -3 cents", L.ooFeeCents(-25, 1000), -3);
	c.eq("§3 under half rounds down: 10% of 24 cents is 2 cents", L.ooFeeCents(24, 1000), 2);
	c.eq("§3 division rounds half away from zero", [L.ooDivRound(5, 10), L.ooDivRound(-5, 10), L.ooDivRound(15, 10), L.ooDivRound(-15, 10), L.ooDivRound(14, 10), L.ooDivRound(-14, 10)],
		[1, -1, 2, -2, 1, -1]);
	c.eq("§3 a reversal's fee comes back in full: 18% of -$2,100.00", L.ooFeeCents(-210000, 1800), -37800);
	c.eq("§3 dollars to cents", [L.ooToCents(1343.33), L.ooToCents("1,343.33"), L.ooToCents("$65"), L.ooToCents(0.125), L.ooToCents(-0.125),
		L.ooToCents(2.675), L.ooToCents(1420.35), L.ooToCents(-0)], [134333, 134333, 6500, 13, -13, 268, 142035, 0]);
	c.eq("§3 unreadable dollars are null, never $0", [L.ooToCents(""), L.ooToCents(null), L.ooToCents(undefined), L.ooToCents("abc"), L.ooToCents(NaN),
		L.ooToCents("12abc"), L.ooToCents({}), L.ooToCents(true)], [null, null, null, null, null, null, null, null]);
	c.eq("§3 the owner's example share: $10,000.00 less 18% and $6,000.00 of costs", L.ooShareCents({ loadCents: 1000000, feeBps: 1800, chargeCents: 600000 }), { feeCents: 180000, shareCents: 220000 });
}

// ── §4 ───────────────────────────────────────────────────────────────────────
function daysSection(c, L) {
	const week = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
	c.eq("§4 each day of a Saturday-Friday week starts on its Saturday", week.map(L.ooWeekStart), week.map(() => "2026-11-07"));
	c.eq("§4 the next Saturday starts the next week", L.ooWeekStart("2026-11-14"), "2026-11-14");
	c.eq("§4 across a month end and a year end", [L.ooWeekStart("2026-12-31"), L.ooWeekStart("2027-01-01"), L.ooWeekStart("2027-01-02")],
		["2026-12-26", "2026-12-26", "2027-01-02"]);
	c.eq("§4 a week ends on its Friday; a day that is not a Saturday has no week end", [L.ooWeekEnd("2026-11-07"), L.ooWeekEnd("2026-11-08")], ["2026-11-13", null]);
	c.eq("§4 impossible or malformed days have no week", [L.ooWeekStart("2026-02-30"), L.ooWeekStart("2026-11-7"), L.ooWeekStart(""), L.ooWeekStart(null)], [null, null, null, null]);
	c.eq("§4 the weeks from one Saturday to another", L.ooWeeksBetween("2026-11-07", "2026-11-28"), ["2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"]);
	c.eq("§4 ...none when the end is earlier", L.ooWeeksBetween("2026-11-28", "2026-11-07"), []);
	c.eq("§4 a Friday-evening stamp in Eastern (Saturday in UTC) is that Friday", L.ooStampDay("2026-11-14T03:30:00.000Z", TZ), "2026-11-13");
	c.eq("§4 ...so its week is Nov 7, not Nov 14", L.ooWeekStart(L.ooStampDay("2026-11-14T03:30:00.000Z", TZ)), "2026-11-07");
	c.eq("§4 a summer evening (daylight time)", L.ooStampDay("2026-07-04T02:00:00.000Z", TZ), "2026-07-03");
	c.eq("§4 SQLite's UTC CURRENT_TIMESTAMP reads as an instant", L.ooStampDay("2026-11-14 03:30:00", TZ), "2026-11-13");
	c.eq("§4 a bare day is its own day, never shifted", L.ooStampDay("2026-11-13", TZ), "2026-11-13");
	c.eq("§4 unreadable stamps have no day", [L.ooStampDay("", TZ), L.ooStampDay("Nov 13", TZ), L.ooStampDay("2026-02-30T12:00:00Z", TZ), L.ooStampDay(null, TZ)],
		[null, null, null, null]);
	c.eq("§4 with no zone given, the app's own (APP_TIMEZONE)", L.ooStampDay("2026-11-14T03:30:00.000Z"), appTime.appDay(new Date("2026-11-14T03:30:00.000Z")));
}

// ── §5 ───────────────────────────────────────────────────────────────────────
function firstWeekSection(c, L) {
	const base = { profileCreatedAt: PROFILE_CREATED, onboardedAt: ONBOARDED, timeZone: TZ };
	const w = L.ooFirstSettlementWeek({ ...base, loads: [{ ref: "qa-oo-1", day: "2026-11-09" }] });
	c.eq("§5 the floor is the profile's week and the first week the onboarding week", pick(w, ["ok", "floorWeekStart", "firstWeekStart"]), [true, "2026-10-31", "2026-11-07"]);
	const early = L.ooFirstSettlementWeek({ ...base, onboardedAt: "2026-11-20T15:00:00.000Z", loads: [{ ref: "qa-oo-1", day: "2026-11-09" }] });
	c.eq("§5 a load completed before onboarding finished (row editor, no hook) sets the first week", early.firstWeekStart, "2026-11-07");
	const late = L.ooFirstSettlementWeek({ ...base, onboardedAt: "2026-11-20T15:00:00.000Z", loads: [] });
	c.eq("§5 with no load, the onboarding week", late.firstWeekStart, "2026-11-14");
	// An older load under his name (a deleted account's, a namesake's) is never his to settle.
	const old = L.ooFirstSettlementWeek({ ...base, loads: [{ ref: "qa-oo-old", day: "2026-10-20" }, { ref: "qa-oo-1", day: "2026-11-09" }] });
	c.eq("§5 a load dated before the profile's week never moves the first week", old.firstWeekStart, "2026-11-07");
	c.eq("§5 ...and goes on the safety-net list", (old.beforeFirstWeek || []).map((l) => l.ref), ["qa-oo-old"]);
	const reused = L.ooFirstSettlementWeek({ ...base, onboardedAt: "2026-08-01T15:00:00.000Z", loads: [] });
	c.eq("§5 an onboarding stamp older than the profile never sets an earlier week", reused.firstWeekStart, "2026-10-31");
	const none = L.ooFirstSettlementWeek({ ...base, onboardedAt: "", loads: [] });
	c.eq("§5 no onboarding and no load: no first week yet", pick(none, ["ok", "firstWeekStart"]), [true, ""]);
	const onlyOld = L.ooFirstSettlementWeek({ ...base, onboardedAt: "", loads: [{ ref: "qa-oo-old", day: "2026-10-20" }] });
	c.eq("§5 ...and an older load alone is listed, not settled", [onlyOld.firstWeekStart, (onlyOld.beforeFirstWeek || []).map((l) => l.ref)], ["", ["qa-oo-old"]]);
	c.eq("§5 an unreadable profile date refuses", L.ooFirstSettlementWeek({ ...base, profileCreatedAt: "" }).code, "OO_PROFILE_DATE_UNREADABLE");
	const chained = L.ooFirstSettlementWeek({ ...base, chainStartWeek: "2026-11-07", loads: [{ ref: "qa-oo-found", day: "2026-11-03" }, { ref: "qa-oo-1", day: "2026-11-09" }] });
	c.eq("§5 once a live settlement exists, its chain fixes the first week", chained.firstWeekStart, "2026-11-07");
	c.eq("§5 ...and a load found later before it is listed", (chained.beforeFirstWeek || []).map((l) => l.ref), ["qa-oo-found"]);
	c.eq("§5 a chain week that is not a Saturday refuses", L.ooFirstSettlementWeek({ ...base, chainStartWeek: "2026-11-08", loads: [] }).code, "OO_CHAIN_WEEK_UNREADABLE");
	const evening = L.ooFirstSettlementWeek({ ...base, onboardedAt: "2026-11-14T03:30:00.000Z", loads: [] });
	c.eq("§5 a Friday-evening completion (Saturday in UTC) starts that Friday's week", evening.firstWeekStart, "2026-11-07");
	const undated = L.ooFirstSettlementWeek({ ...base, loads: [{ ref: "qa-oo-x", day: "" }] });
	c.eq("§5 an undated load is listed apart and moves nothing", [undated.firstWeekStart, (undated.undated || []).map((l) => l.ref)], ["2026-11-07", ["qa-oo-x"]]);

	const split = L.ooSplitReceipts([{ ref: "e1", day: "2026-10-20" }, { ref: "e2", day: "2026-11-03" }, { ref: "e3", day: "2026-11-09" }, { ref: "e4", day: "11/09/2026" }], w);
	c.eq("§5 a receipt before the profile's week joins no balance (listed)", split.beforeFloor.map((r) => r.ref), ["e1"]);
	c.eq("§5 a receipt before his first week joins the onboarding balance", split.onboarding.map((r) => r.ref), ["e2"]);
	c.eq("§5 ...one from his first week on is settled", split.settlement.map((r) => r.ref), ["e3"]);
	c.eq("§5 ...and one with an unreadable date is listed apart", split.undated.map((r) => r.ref), ["e4"]);
	c.eq("§5 with no first week yet, a receipt after the floor waits in the onboarding balance", L.ooPlaceDay("2026-11-09", { floorWeekStart: "2026-10-31", firstWeekStart: "" }), "onboarding");
}

// ── §6 ───────────────────────────────────────────────────────────────────────
function truckSection(c, L) {
	c.eq("§6 onboarding completion sets the in-service date to its business day", L.ooInServiceDateOnCompletion({ onboardedAt: "2026-11-14T03:30:00.000Z", currentInServiceDate: "", timeZone: TZ }), "2026-11-13");
	c.eq("§6 ...unless a Super Admin already set one", L.ooInServiceDateOnCompletion({ onboardedAt: "2026-11-14T03:30:00.000Z", currentInServiceDate: "2026-11-01", timeZone: TZ }), "");
	c.eq("§6 ...and none from an unreadable completion stamp", L.ooInServiceDateOnCompletion({ onboardedAt: "", currentInServiceDate: "", timeZone: TZ }), "");
	c.eq("§6 weekly insurance and ELD: monthly x 12 / 52, to the cent", L.ooTruckWeeklyCents(TRUCK), { insuranceCents: 31000, eldCents: 1500 });
	c.eq("§6 ...rounded half away from zero ($10.00 a month is $2.31 a week)", L.ooWeeklyFromMonthlyCents(1000), 231);
	c.eq("§6 ...an empty or unreadable monthly amount charges nothing", L.ooTruckWeeklyCents({ insurance_monthly: null, eld_monthly: "n/a" }), { insuranceCents: 0, eldCents: 0 });
	c.eq("§6 in service from the in-service date's week", [L.ooTruckInServiceWeek(TRUCK, "2026-10-31"), L.ooTruckInServiceWeek(TRUCK, "2026-11-07")], [false, true]);
	c.eq("§6 a mid-week in-service date puts that week in service", L.ooTruckInServiceWeek({ ...TRUCK, in_service_date: "2026-11-12" }, "2026-11-07"), true);
	c.eq("§6 retired: in service through the week it retires, not after", [L.ooTruckInServiceWeek({ ...TRUCK, retired_at: "2026-11-30" }, "2026-11-28"), L.ooTruckInServiceWeek({ ...TRUCK, retired_at: "2026-11-27" }, "2026-11-28")], [true, false]);
	c.eq("§6 no in-service date: never in service (no charge on a guess)", L.ooTruckInServiceWeek({ ...TRUCK, in_service_date: "" }, "2026-11-07"), false);

	const preLinks = [{ startWeekStart: "2026-10-31", endWeekStart: "", truck: { ...TRUCK, in_service_date: "2026-11-02" } }];
	c.eq("§6 an in-service week before his first week joins the onboarding balance", L.ooPreFirstWeekTruckCharges({ floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07", links: preLinks }),
		{ cents: 32500, weeks: [{ weekStart: "2026-10-31", insuranceCents: 31000, eldCents: 1500 }] });
	c.eq("§6 ...none when in service from his first week", L.ooPreFirstWeekTruckCharges({ floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07", links: [{ startWeekStart: "2026-10-31", endWeekStart: "", truck: TRUCK }] }).cents, 0);
	c.eq("§6 ...and none before the profile's week", L.ooPreFirstWeekTruckCharges({ floorWeekStart: "2026-11-07", firstWeekStart: "2026-11-07", links: preLinks }).cents, 0);

	const links = [{ startWeekStart: "2026-10-31", endWeekStart: "", truck: TRUCK }];
	const skipped = L.ooWeeklyChargeLines({ weekStart: "2026-11-21", firstWeekStart: "2026-11-07", endWeekStart: "", links, charges: [], chargedRefs: new Set(["ins:2026-11-07", "eld:2026-11-07"]) });
	c.eq("§6 a skipped week is charged on the next settlement, each week once", skipped.map((l) => l.ref), ["ins:2026-11-14", "eld:2026-11-14", "ins:2026-11-21", "eld:2026-11-21"]);
	c.eq("§6 ...at its weekly amount, with its own week as the date", skipped.map((l) => [l.kind, l.lineDate, l.cents]),
		[["weekly", "2026-11-14", -31000], ["weekly", "2026-11-14", -1500], ["weekly", "2026-11-21", -31000], ["weekly", "2026-11-21", -1500]]);
	const ended = L.ooWeeklyChargeLines({ weekStart: "2026-11-28", firstWeekStart: "2026-11-07", endWeekStart: "2026-11-14", links, charges: [], chargedRefs: new Set() });
	c.eq("§6 no weekly charge after his end week", [...new Set(ended.map((l) => l.lineDate))], ["2026-11-07", "2026-11-14"]);
	const item = { id: 7, kind: "weekly", label: "Trailer rental", cents: 5000, from_week_start: "2026-11-14", until_week_start: "2026-11-21", voided_at: "" };
	const voided = { ...item, id: 8, voided_at: "2026-11-16T12:00:00.000Z" };
	const items = L.ooWeeklyChargeLines({ weekStart: "2026-11-28", firstWeekStart: "2026-11-07", endWeekStart: "", links, charges: [item, voided], chargedRefs: new Set() }).filter((l) => l.ref.startsWith("chg:"));
	c.eq("§6 a weekly item runs from its first to its last week; a voided one never", items.map((l) => [l.ref, l.cents]), [["chg:7:2026-11-14", -5000], ["chg:7:2026-11-21", -5000]]);
	const relinked = [{ startWeekStart: "2026-10-31", endWeekStart: "2026-11-07", truck: TRUCK }, { startWeekStart: "2026-11-14", endWeekStart: "", truck: { ...TRUCK, insurance_monthly: 1083.33 } }];
	c.eq("§6 a re-link from a week start charges the new truck's amounts from that week", L.ooWeeklyChargeLines({ weekStart: "2026-11-14", firstWeekStart: "2026-11-07", endWeekStart: "", links: relinked, charges: [], chargedRefs: new Set() })
		.filter((l) => l.ref.startsWith("ins:")).map((l) => l.cents), [-31000, -25000]);
	c.eq("§6 the truck a week's link covers", [L.ooTruckForWeek(relinked, "2026-11-07") === TRUCK, L.ooTruckForWeek(relinked, "2026-10-24")], [true, null]);
}

// ── §7 ───────────────────────────────────────────────────────────────────────
function appendixBSection(c, L) {
	const d = L.ooSettlementMath({ loadCents: 1000000, feeBps: 1800, receiptCents: 600000, escrow: {} });
	c.eq("§7 the owner's example: $10,000 load pay, $6,000 costs, 18%: a $1,800 fee and $2,200 net", pick(d, ["ok", "feeCents", "netCents", "payableCents"]), [true, 180000, 220000, 220000]);

	const world = appendixBWorld();
	const results = runAppendixB(L, world);
	APPENDIX_B.forEach((row, i) => {
		const r = results[i] || {};
		c.eq(`§7 Appendix B week ${i + 1} (${row[0]}) to the cent`, r.ok ? pick(r.totals, TOTAL_KEYS) : r, row.slice(1).map(cents));
		c.ok(`§7 ...its lines add up to its net`, r.ok && L.ooNetCents(r.lines) === r.totals.netCents);
	});
	const w1 = results[0] || {};
	c.eq("§7 week 1's lines", w1.ok ? w1.lines.map((l) => [l.kind, l.ref, l.cents]) : w1, [
		["load", "qa-oo-1", 350000], ["load", "qa-oo-2", 400000], ["fee", "fee", -135000],
		["receipt", "exp-101", -142035], ["receipt", "exp-102", -110510], ["receipt", "exp-103", -4650],
		["weekly", "ins:2026-11-07", -31000], ["weekly", "eld:2026-11-07", -1500], ["installment", "installment", -100000]]);
	const w2 = results[1] || {};
	c.eq("§7 week 2 is short: $0.00 paid, $583.00 carried, no installment or escrow line", w2.ok ? [w2.totals.payableCents, w2.totals.carriedOutCents, w2.lines.filter((l) => l.kind === "installment" || l.kind === "escrow").length] : w2, [0, 58300, 0]);
	const w3 = results[2] || {};
	c.ok("§7 week 3 carries the $583.00 in", w3.ok && w3.lines.some((l) => l.kind === "carry_in" && l.cents === -58300));
	const w4 = results[3] || {};
	c.eq("§7 week 4: the Nov 18 paper toll lands late with its own date", w4.ok ? w4.lines.filter((l) => l.ref === "exp-109").map((l) => [l.kind, l.lineDate, l.cents]) : w4, [["receipt", "2026-11-18", -2375]]);
	c.eq("§7 ...and was on no earlier settlement", results.slice(0, 3).map((r) => (r.ok ? r.lines.filter((l) => l.ref === "exp-109").length : -1)), [0, 0, 0]);
	c.eq("§7 week 4 clears the onboarding balance; escrow starts in week 5", [w4.ok && w4.totals.escrowDepositCents, (results[4] || {}).ok && results[4].totals.escrowDepositCents], [0, 50000]);
	c.eq("§7 each truck week is charged once over the five weeks", world.settlements.flatMap((s) => s.lines).filter((l) => l.kind === "weekly").map((l) => l.ref).length, 10);

	// QA-OO-2's pay is lowered by $35.00 after its settlement.
	world.loads.find((l) => l.ref === "qa-oo-2").cents = 396500;
	world.loads.push({ ref: "qa-oo-9", day: "2026-12-14", cents: 100000, label: "QA-OO-9" });
	const w6 = generate(L, world, "2026-12-12", { asOf: "2026-12-18" });
	c.eq("§7 a lowered pay comes as its difference on the next settlement", w6.ok ? w6.lines.filter((l) => l.ref === "qa-oo-2").map((l) => [l.kind, l.cents, l.baseCents]) : w6, [["load_change", -3500, 396500]]);
	c.eq("§7 ...and its fee, -$6.30, inside the week's fee", w6.ok ? [w6.totals.loadCents, w6.totals.feeCents] : w6, [96500, 18000 - 630]);

	const partner = appendixBWorld({ source: "partner" });
	const pr = runAppendixB(L, partner);
	c.eq("§7 a partner source changes no figure", pr.map((r) => (r.ok ? r.totals : r.code)), results.map((r) => (r.ok ? r.totals : r.code)));
}

// The final settlement: he ends after week 5 with $500.00 held, and a $23.75 toll
// arrives during the hold. The escrow flag is off by then.
function finalSection(c, L) {
	const world = appendixBWorld();
	runAppendixB(L, world);
	world.endWeekStart = "2026-12-05";
	world.escrowOn = false;
	world.receipts.push({ ref: "exp-112", day: "2026-12-09", cents: 2375, label: "Toll", filedOn: "2026-12-20" });
	const weekly = generate(L, world, "2026-12-12", { asOf: "2026-12-18" });
	c.eq("§7 no weekly settlement after his end week", weekly.code, "OWNER_OPERATOR_ENDED");
	const due = L.ooFinalSettlementDue({ endWeekStart: "2026-12-05", today: "2027-01-18" });
	c.eq("§7 the hold ends 45 days after his end week's Friday; the final settlement is due 7 days before", pick(due, ["ok", "holdEndsOn", "dueOn", "due"]), [true, "2027-01-25", "2027-01-18", true]);
	const fin = generate(L, world, "2027-01-16", { asOf: "2027-01-18", final: true });
	c.eq("§7 the final settlement: the toll, paid from escrow, the rest returned (flag off)", fin.ok ? fin.lines.map((l) => [l.kind, l.cents]) : fin,
		[["receipt", -2375], ["escrow_use", 2375], ["escrow_return", 47625]]);
	c.eq("§7 ...$476.25 paid and nothing held after it", fin.ok ? [fin.totals.payableCents, fin.totals.escrowBalanceAfterCents, fin.totals.escrowDepositCents] : fin, [47625, 0, 0]);
	c.ok("§7 ...and no truck week after his end week", fin.ok && !fin.lines.some((l) => l.kind === "weekly"));
}

// ── §8 ───────────────────────────────────────────────────────────────────────
function mathCase(L, over) {
	return L.ooSettlementMath({ loadCents: 0, feeBps: 1800, receiptCents: 0, weeklyCents: 0, oneTimeCents: 0, carriedInCents: 0, onboardingLeftCents: 0, installmentCents: 0, ...over, escrow: { enabled: true, targetCents: 250000, weeklyCents: 50000, balanceCents: 0, ...(over.escrow || {}) } });
}
function casesSection(c, L) {
	const short = mathCase(L, { loadCents: 100000, receiptCents: 120000, onboardingLeftCents: 50000, installmentCents: 20000 });
	c.eq("§8 a short week takes no installment and pays $0, carrying the rest", pick(short, ["installmentCents", "escrowDepositCents", "payableCents", "carriedOutCents"]), [0, 0, 0, 38000]);
	const shortEscrow = mathCase(L, { loadCents: 100000, receiptCents: 120000 });
	c.eq("§8 ...and no escrow when the balance is cleared", pick(shortEscrow, ["escrowDepositCents", "carriedOutCents"]), [0, 38000]);
	const thin = mathCase(L, { loadCents: 100000, receiptCents: 60000, onboardingLeftCents: 50000, installmentCents: 40000 });
	c.eq("§8 an installment never makes a short week: only what the week can spare", pick(thin, ["beforeCents", "installmentCents", "netCents"]), [22000, 22000, 0]);
	const thinEscrow = mathCase(L, { loadCents: 100000, receiptCents: 60000 });
	c.eq("§8 escrow never makes a short week either", pick(thinEscrow, ["escrowDepositCents", "netCents"]), [22000, 0]);
	const cap = mathCase(L, { loadCents: 500000, escrow: { balanceCents: 240000 } });
	c.eq("§8 escrow stops at its target: $100.00 tops up $2,400.00", pick(cap, ["escrowDepositCents", "escrowBalanceAfterCents"]), [10000, 250000]);
	const full = mathCase(L, { loadCents: 500000, escrow: { balanceCents: 250000 } });
	c.eq("§8 ...and holds back nothing once full", full.escrowDepositCents, 0);
	const off = mathCase(L, { loadCents: 500000, escrow: { enabled: false } });
	c.eq("§8 with the escrow flag off, no deposit", off.escrowDepositCents, 0);
	const owed = mathCase(L, { loadCents: 500000, onboardingLeftCents: 1 });
	c.eq("§8 no escrow while any onboarding balance is left", owed.escrowDepositCents, 0);

	// A receipt rejected, and a load removed, after their settlement.
	const world = appendixBWorld();
	generate(L, world, "2026-11-07", { asOf: "2026-11-13" });
	generate(L, world, "2026-11-14", { asOf: "2026-11-20" });
	world.receipts = world.receipts.filter((r) => r.ref !== "exp-101");
	world.loads = world.loads.filter((l) => l.ref !== "qa-oo-3");
	const w3 = generate(L, world, "2026-11-21", { asOf: "2026-11-27" });
	c.eq("§8 a receipt rejected after its settlement comes back as a credit", w3.ok ? w3.lines.filter((l) => l.ref === "exp-101").map((l) => [l.kind, l.cents, l.baseCents]) : w3, [["receipt_change", 142035, 0]]);
	c.eq("§8 a load removed after its settlement is reversed, and its fee given back", w3.ok ? [w3.lines.filter((l) => l.ref === "qa-oo-3").map((l) => [l.kind, l.cents]), w3.totals.feeCents] : w3,
		[[["load_change", -210000]], 144000 - 37800]);
	c.eq("§8 nothing settled is settled again", w3.ok ? w3.lines.filter((l) => ["qa-oo-1", "qa-oo-2", "exp-102", "exp-104"].includes(l.ref)).length : -1, 0);
	const only = L.ooBuildSettlement({ weekStart: "2026-11-21", window: { floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07" }, profile: { feeBps: 1800 },
		loads: [], receipts: [], settled: L.ooSettledFromLines([{ kind: "load", ref: "qa-oo-3", cents: 210000 }]), escrow: {} });
	c.eq("§8 a week of only a reversal gives the fee back", only.ok ? only.lines.map((l) => [l.kind, l.cents]) : only, [["load_change", -210000], ["fee", 37800]]);

	// The installment default: a third, rounded up, written once.
	c.eq("§8 the installment default is a third, rounded up to the cent", [L.ooInstallmentDefaultCents(295000), L.ooInstallmentDefaultCents(300000), L.ooInstallmentDefaultCents(0), L.ooInstallmentDefaultCents(-5)], [98334, 100000, 0, 0]);
	c.eq("§8 a stored installment is used as it is", L.ooEffectiveInstallment({ storedCents: 100000, onboardingLeftCents: 295000 }), { cents: 100000, writeDefault: false });
	c.eq("§8 with none stored and a balance, the default is written", L.ooEffectiveInstallment({ storedCents: 0, onboardingLeftCents: 295000 }), { cents: 98334, writeDefault: true });
	const unset = appendixBWorld({ installmentStored: 0 });
	const u = runAppendixB(L, unset);
	c.eq("§8 ...once: the third of $2,950.00 stays $983.34 while the balance falls", [unset.installmentStored, (u[0].ok && u[0].totals.installmentCents), (u[2].ok && u[2].totals.installmentCents)], [98334, 98334, 98334]);

	// Escrow uses. An unpaid charge-back pays down the carried balance with one line.
	const unpaid = L.ooBuildSettlement({ weekStart: "2026-12-12", window: { floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07" }, profile: { feeBps: 1800, escrowTargetCents: 250000, escrowWeeklyCents: 50000 },
		loads: [], receipts: [], settled: L.ooSettledFromLines([]), carriedInCents: 58300, escrow: { enabled: true, balanceCents: 50000, uses: [{ ref: "use:1", purpose: "unpaid_charge", cents: 50000 }] } });
	c.eq("§8 an escrow use for an unpaid charge-back pays down the carry with one line and no new charge", unpaid.ok ? unpaid.lines.map((l) => [l.kind, l.cents]) : unpaid,
		[["escrow_use", 50000], ["carry_in", -58300]]);
	c.eq("§8 ...leaving $83.00 carried and the escrow at $0", unpaid.ok ? pick(unpaid.totals, ["carriedOutCents", "escrowBalanceAfterCents"]) : unpaid, [8300, 0]);
	// A deductible (no record in the app) adds its own charge line, and his pay is unchanged.
	const dedArgs = (uses) => ({ weekStart: "2026-12-12", window: { floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07" }, profile: { feeBps: 1800, escrowTargetCents: 250000, escrowWeeklyCents: 50000 },
		loads: [{ ref: "qa-oo-9", day: "2026-12-14", cents: 100000 }], receipts: [], settled: L.ooSettledFromLines([]), escrow: { enabled: true, balanceCents: 250000, uses } });
	const ded = L.ooBuildSettlement(dedArgs([{ ref: "use:2", purpose: "deductible", cents: 100000, label: "Insurance deductible" }]));
	const noDed = L.ooBuildSettlement(dedArgs([]));
	c.eq("§8 a deductible use adds its own charge and \"paid from your escrow\"", ded.ok ? ded.lines.filter((l) => l.ref === "use:2").map((l) => [l.kind, l.cents]) : ded, [["deductible", -100000], ["escrow_use", 100000]]);
	c.eq("§8 ...his pay unchanged and his escrow down by it", ded.ok && noDed.ok ? [ded.totals.netCents === noDed.totals.netCents, ded.totals.escrowBalanceAfterCents] : [ded.code, noDed.code], [true, 150000]);
	const refill = mathCase(L, { loadCents: 500000, escrow: { balanceCents: 150000 } });
	c.eq("§8 ...and the next week's hold-back refills it", refill.escrowDepositCents, 50000);
	c.eq("§8 a use above the balance refuses", mathCase(L, { carriedInCents: 90000, escrow: { balanceCents: 50000, unpaidUseCents: 60000 } }).code, "OO_ESCROW_USE_OVER_BALANCE");
	c.eq("§8 an unpaid-charge use above the carried balance refuses", mathCase(L, { carriedInCents: 10000, escrow: { balanceCents: 50000, unpaidUseCents: 20000 } }).code, "OO_ESCROW_USE_OVER_CARRY");
	c.eq("§8 no new use while the escrow flag is off", mathCase(L, { carriedInCents: 10000, escrow: { enabled: false, balanceCents: 50000, unpaidUseCents: 5000 } }).code, "OO_ESCROW_OFF");

	// The final settlement applies what he still owes on onboarding before it returns escrow.
	const fin = mathCase(L, { loadCents: 0, receiptCents: 0, carriedInCents: 0, onboardingLeftCents: 30000, installmentCents: 1000, final: true, escrow: { enabled: false, balanceCents: 50000 } });
	c.eq("§8 the final settlement takes the whole onboarding balance, then returns the rest", pick(fin, ["installmentCents", "escrowAppliedCents", "escrowReturnCents", "netCents"]), [30000, 30000, 20000, 20000]);
	const short2 = mathCase(L, { receiptCents: 70000, final: true, escrow: { enabled: false, balanceCents: 50000 } });
	c.eq("§8 ...and what escrow can't cover stays owed", pick(short2, ["escrowAppliedCents", "escrowReturnCents", "payableCents", "carriedOutCents"]), [50000, 0, 0, 20000]);
	c.eq("§8 the final settlement holds back nothing", mathCase(L, { loadCents: 500000, final: true, escrow: { enabled: true, balanceCents: 0 } }).escrowDepositCents, 0);
	c.eq("§8 an End clicked after the hold: the final settlement is due at once", L.ooFinalSettlementDue({ endWeekStart: "2026-12-05", today: "2027-02-01" }).due, true);
	c.eq("§8 ...and not before its day", L.ooFinalSettlementDue({ endWeekStart: "2026-12-05", today: "2027-01-17" }).due, false);
	c.eq("§8 an end week that is not a Saturday refuses", L.ooFinalSettlementDue({ endWeekStart: "2026-12-06", today: "2027-01-17" }).code, "OO_WEEK_INVALID");

	// Refusals.
	const args = (over) => ({ weekStart: "2026-11-07", window: { floorWeekStart: "2026-10-31", firstWeekStart: "2026-11-07" }, profile: { feeBps: 1800 },
		loads: [], receipts: [], settled: L.ooSettledFromLines([]), escrow: {}, ...over });
	const noPay = L.ooBuildSettlement(args({ loads: [{ ref: "qa-oo-1", day: "2026-11-09", cents: null }, { ref: "qa-oo-2", day: "2026-11-12", cents: 0 }] }));
	c.eq("§8 a load with no readable pay stops the settlement, naming it", [noPay.code, noPay.refs], ["OO_SETTLEMENT_LOAD_NO_PAY", ["qa-oo-1", "qa-oo-2"]]);
	c.eq("§8 ...one not due yet does not", L.ooBuildSettlement(args({ loads: [{ ref: "qa-oo-9", day: "2026-12-14", cents: null }], carriedInCents: 100 })).ok, true);
	const noAmount = L.ooBuildSettlement(args({ receipts: [{ ref: "exp-1", day: "2026-11-09", cents: null }] }));
	c.eq("§8 a receipt with no readable amount stops it too", [noAmount.code, noAmount.refs], ["OO_SETTLEMENT_RECEIPT_NO_AMOUNT", ["exp-1"]]);
	c.eq("§8 a week with nothing at all", L.ooBuildSettlement(args({})).code, "OO_NOTHING_TO_SETTLE");
	c.eq("§8 a week after his end week", L.ooBuildSettlement(args({ weekStart: "2026-11-21", endWeekStart: "2026-11-14" })).code, "OWNER_OPERATOR_ENDED");
	c.eq("§8 a week before his first week", L.ooBuildSettlement(args({ weekStart: "2026-10-31" })).code, "OO_SETTLEMENT_BEFORE_FIRST_WEEK");
	c.eq("§8 no first week yet", L.ooBuildSettlement(args({ window: { floorWeekStart: "2026-10-31", firstWeekStart: "" } })).code, "OO_NO_FIRST_WEEK");
	c.eq("§8 a week start that is not a Saturday", L.ooBuildSettlement(args({ weekStart: "2026-11-08" })).code, "OO_WEEK_INVALID");
	c.eq("§8 a fee outside 10-25% refuses the math", mathCase(L, { feeBps: 2600 }).code, "OO_FEE_OUT_OF_RANGE");
	c.eq("§8 a carry alone is a settlement (its record)", L.ooBuildSettlement(args({ carriedInCents: 58300 })).lines.map((l) => [l.kind, l.cents]), [["carry_in", -58300]]);
	const oneTime = L.ooDueOneTimeCharges([
		{ id: 21, kind: "one_time", label: "Credit", cents: -2500, week_start: "", voided_at: "", charge_date: "2026-11-10" },
		{ id: 22, kind: "one_time", label: "Later", cents: 1000, week_start: "2026-11-21", voided_at: "", charge_date: "2026-11-20" },
		{ id: 23, kind: "one_time", label: "Voided", cents: 1000, week_start: "", voided_at: "2026-11-11T12:00:00.000Z", charge_date: "2026-11-10" },
		{ id: 24, kind: "one_time", label: "Settled", cents: 1000, week_start: "", voided_at: "", charge_date: "2026-11-01" },
	], { weekStart: "2026-11-14", settledRefs: new Set(["chg:24"]) });
	c.eq("§8 one-time items: due now or waiting, never a voided or settled one", oneTime.map((o) => [o.ref, o.cents]), [["chg:21", -2500]]);
}

// ── §9 ───────────────────────────────────────────────────────────────────────
function ledgerSection(c, L) {
	c.eq("§9 the ledger's Owner ID reading", ["", "  ", null, undefined, "0", "12", 12, "abc", "12abc"].map((v) => L.ooOwnerIdCell(v)),
		[{ blank: true, ownerId: 0 }, { blank: true, ownerId: 0 }, { blank: true, ownerId: 0 }, { blank: true, ownerId: 0 },
			{ blank: false, ownerId: 0 }, { blank: false, ownerId: 12 }, { blank: false, ownerId: 12 }, { blank: false, ownerId: 0 }, { blank: false, ownerId: 12 }]);
	c.eq("§9 a load on an investor's ledger: an Owner ID other than 0, or a blank one the driver fallback claims",
		[L.ooLoadOnInvestorLedger({ ownerIdCell: "12" }), L.ooLoadOnInvestorLedger({ ownerIdCell: "0" }), L.ooLoadOnInvestorLedger({ ownerIdCell: "", blankClaimedByInvestor: true }),
			L.ooLoadOnInvestorLedger({ ownerIdCell: "", blankClaimedByInvestor: false }), L.ooLoadOnInvestorLedger({ ownerIdCell: "abc", blankClaimedByInvestor: true })],
		[true, false, true, false, false]);
	c.eq("§9 a receipt on an investor's ledger: an owner stamp other than 0, or no truck and a claiming driver window",
		[L.ooReceiptOnInvestorLedger({ ownerId: 12, truckUnit: "INV-7-A" }), L.ooReceiptOnInvestorLedger({ ownerId: 0, truckUnit: "OO-9001-A", blankUnitClaimedByInvestor: true }),
			L.ooReceiptOnInvestorLedger({ ownerId: 0, truckUnit: "", blankUnitClaimedByInvestor: true }), L.ooReceiptOnInvestorLedger({ ownerId: null, truckUnit: "", blankUnitClaimedByInvestor: false })],
		[true, false, true, false]);
	const split = L.ooSplitLedgerHolds([
		{ ref: "qa-oo-1", onInvestorLedger: false }, { ref: "qa-oo-2", onInvestorLedger: true }, { ref: "qa-oo-3", onInvestorLedger: true },
	], new Set(["qa-oo-3"]));
	c.eq("§9 held items are listed, the rest are candidates, an item with a ledger exit is neither", [split.candidates.map((i) => i.ref), split.held.map((i) => i.ref)], [["qa-oo-1"], ["qa-oo-2"]]);
	const world = appendixBWorld();
	world.loads = world.loads.filter((l) => l.ref !== "qa-oo-2");
	const r = generate(L, world, "2026-11-07", { asOf: "2026-11-13" });
	c.eq("§9 with a held load left out, the rest of the week settles", r.ok ? [r.totals.loadCents, r.lines.some((l) => l.ref === "qa-oo-2")] : r, [350000, false]);
	c.eq("§9 the settle-once key is the invoice's normalized Load ID", [L.ooLoadRef(" #QA-OO-1 "), L.ooLoadRef(540935268)], ["qa-oo-1", "540935268"]);
}

// ── §10 ──────────────────────────────────────────────────────────────────────
function validatorsSection(c, L) {
	c.eq("§10 the fee: 10% to 25% in basis points", [1000, 1800, 2500, 999, 2501, 1800.5, "1800"].map((b) => (L.ooValidateFeeBps(b) ? L.ooValidateFeeBps(b).code : null)),
		[null, null, null, "OO_FEE_OUT_OF_RANGE", "OO_FEE_OUT_OF_RANGE", "OO_FEE_OUT_OF_RANGE", "OO_FEE_OUT_OF_RANGE"]);
	c.eq("§10 a fee typed as a percent", ["18", "10", "25", "18.5", "18.25", 18, " 12 "].map((v) => L.ooParseFeePercent(v).bps), [1800, 1000, 2500, 1850, 1825, 1800, 1200]);
	c.eq("§10 ...and refused outside the range or past two decimals", ["9.99", "25.01", "18.125", "abc", "", "-18"].map((v) => L.ooParseFeePercent(v).code), Array(6).fill("OO_FEE_OUT_OF_RANGE"));
	c.eq("§10 dollars typed by staff", ["550", "1,850.00", "$300.5", "0.01"].map((v) => L.ooParseDollarsToCents(v).cents), [55000, 185000, 30050, 1]);
	c.eq("§10 ...refused: zero, negative, three decimals, words, too large", ["0", "-5", "1.005", "ten", "100000.01"].map((v) => L.ooParseDollarsToCents(v).code), Array(5).fill("OO_AMOUNT_INVALID"));
	c.eq("§10 ...a credit when asked for", L.ooParseDollarsToCents("-25.00", { allowNegative: true }).cents, -2500);
	c.eq("§10 escrow terms: whole cents, the weekly hold-back no more than the target", [L.ooValidateEscrowTerms({ targetCents: 250000, weeklyCents: 50000 }),
		(L.ooValidateEscrowTerms({ targetCents: 50000, weeklyCents: 60000 }) || {}).code, (L.ooValidateEscrowTerms({ targetCents: -1, weeklyCents: 0 }) || {}).code], [null, "OO_ESCROW_TERMS_INVALID", "OO_ESCROW_TERMS_INVALID"]);
	c.eq("§10 the installment: any amount before he signs", L.ooInstallmentChangeRefusal({ signed: false, currentCents: 100000, nextCents: 150000 }), null);
	c.eq("§10 ...only a smaller one after", [L.ooInstallmentChangeRefusal({ signed: true, currentCents: 100000, nextCents: 80000 }),
		(L.ooInstallmentChangeRefusal({ signed: true, currentCents: 100000, nextCents: 120000 }) || {}).code,
		(L.ooInstallmentChangeRefusal({ signed: true, currentCents: 100000, nextCents: 0 }) || {}).code], [null, "OO_INSTALLMENT_ONLY_LOWER", "OO_INSTALLMENT_ONLY_LOWER"]);
	c.eq("§10 ...after signing with none set, smaller than the default", [L.ooInstallmentChangeRefusal({ signed: true, currentCents: 0, nextCents: 90000, defaultCents: 98334 }),
		(L.ooInstallmentChangeRefusal({ signed: true, currentCents: 0, nextCents: 90000 }) || {}).code], [null, "OO_INSTALLMENT_ONLY_LOWER"]);
	c.eq("§10 a label: 1-80 characters, a letter or number first, no line break, < or >", ["Form 2290", " IRP plates ", "x".repeat(80), "x".repeat(81), "-5", "a<b", "line\nbreak", ""].map((v) => {
		const r = L.ooCleanLabel(v);
		return r.ok ? r.value : r.code;
	}), ["Form 2290", "IRP plates", "x".repeat(80), "OO_LABEL_INVALID", "OO_LABEL_INVALID", "OO_LABEL_INVALID", "line break", "OO_LABEL_INVALID"]);
	c.eq("§10 a reason: 1-300 characters", ["Paid at the DMV", "y".repeat(300), "y".repeat(301), ""].map((v) => (L.ooCleanReason(v).ok ? "ok" : L.ooCleanReason(v).code)),
		["ok", "ok", "OO_REASON_INVALID", "OO_REASON_INVALID"]);
	const cats = ["fuel", "tolls", "repairs", "insurance", "eld", "taxes_registration", "onboarding_ready", "cash_advance"];
	const good = { kind: "onboarding", category: "taxes_registration", label: "Form 2290", cents: 55000, chargeDate: "2026-11-03", costRecord: "outside_app", reason: "Paid at the IRS" };
	c.eq("§10 an onboarding charge with its record passes", L.ooValidateCharge(good, { categories: cats }).ok, true);
	c.eq("§10 a charge's refusals", [
		L.ooValidateCharge({ ...good, kind: "monthly" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, category: "lunch" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, cents: 0 }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, cents: -500 }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, costRecord: "" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, costRecord: "receipt" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, chargeDate: "2026-02-30" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, kind: "weekly", fromWeekStart: "2026-11-08" }, { categories: cats }).code,
		L.ooValidateCharge({ ...good, reason: "" }, { categories: cats }).code,
	], ["OO_CHARGE_KIND_INVALID", "OO_CHARGE_CATEGORY_INVALID", "OO_CHARGE_AMOUNT_INVALID", "OO_CHARGE_AMOUNT_INVALID", "OO_CHARGE_RECORD_REQUIRED",
		"OO_CHARGE_RECORD_INVALID", "OO_CHARGE_DATE_INVALID", "OO_CHARGE_WEEK_INVALID", "OO_REASON_INVALID"]);
	c.eq("§10 a one-time credit needs no record", L.ooValidateCharge({ kind: "one_time", category: "fuel", label: "Fuel credit", cents: -2500, chargeDate: "2026-11-10", reason: "Card refund" }, { categories: cats }).ok, true);
	c.eq("§10 a charge paid in a closed month posts to the first open month", [L.ooPostedPeriod({ chargeDate: "2026-09-15", firstOpenMonth: "2026-10" }), L.ooPostedPeriod({ chargeDate: "2026-11-03", firstOpenMonth: "2026-10" })], ["2026-10", "2026-11"]);
	c.eq("§10 the source: \"partner\" only for the partner's own code", [L.ooSourceFromReferral("PTR-123", "PTR-123"), L.ooSourceFromReferral(" PTR-123 ", "PTR-123"),
		L.ooSourceFromReferral("PTR-124", "PTR-123"), L.ooSourceFromReferral("", "PTR-123"), L.ooSourceFromReferral("", ""), L.ooSourceFromReferral("PTR-123", "")],
		["partner", "partner", "direct", "direct", "direct", "direct"]);
	c.eq("§10 only a full 17-character VIN is ever matched", ["1m8gdm9axkp042788", " 1M8GDM9AXKP042788 ", "1M8GDM9AXKP04278", "", "1M8GDM9AXKP04278O"].map(L.ooMatchableVin),
		["1M8GDM9AXKP042788", "1M8GDM9AXKP042788", "", "", ""]);
	c.eq("§10 his end week: a Saturday, never before his last load's week", [L.ooEndWeekRefusal({ endWeekStart: "2026-12-05", lastLoadDay: "2026-12-10" }),
		(L.ooEndWeekRefusal({ endWeekStart: "2026-11-28", lastLoadDay: "2026-12-10" }) || {}).code, (L.ooEndWeekRefusal({ endWeekStart: "2026-12-06", lastLoadDay: "" }) || {}).code],
		[null, "OO_END_BEFORE_LOAD", "OO_WEEK_INVALID"]);
	c.eq("§10 the category: position \"Owner Operator\", trimmed and case-folded", ["Owner Operator", " owner operator ", "OWNER OPERATOR", "Owner-Operator", "Company Driver", null].map(L.ooIsOwnerOperatorPosition),
		[true, true, true, false, false, false]);
}

// ── §11 ──────────────────────────────────────────────────────────────────────
const TABLES = ["owner_operator_applications", "owner_operators", "owner_operator_trucks", "owner_operator_charges",
	"owner_operator_settlement_lines", "owner_operator_escrow_uses", "owner_operator_toll_notices", "owner_operator_ledger_exits"];
function schemaSection(c, L) {
	c.eq("§11 the eight tables", [...(L.OO_TABLES || [])].sort(), [...TABLES].sort());
	c.eq("§11 the two filed-by columns", L.OO_EXPENSE_COLUMNS, ["filed_by_role", "filed_by_user_id"]);
	const db = new Database(":memory:");
	try {
		db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL)");
		db.prepare("INSERT INTO expenses (driver, amount, date) VALUES (?, ?, ?)").run("Made Up Driver", 12.5, "2026-11-01");
		for (let pass = 0; pass < 2; pass++) {
			db.exec(L.OO_SCHEMA_SQL);
			for (const sql of L.OO_EXPENSE_COLUMN_SQL) { try { db.exec(sql); } catch { /* exists on the second pass */ } }
		}
		const have = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'owner_operator%' ORDER BY name").all().map((r) => r.name);
		c.eq("§11 created, and again with no error (additive, idempotent)", have, [...TABLES].sort());
		const cols = Object.fromEntries(db.prepare("PRAGMA table_info(expenses)").all().map((col) => [col.name, [col.notnull, col.dflt_value]]));
		c.eq("§11 filed_by_role is '' by default, filed_by_user_id empty", [cols.filed_by_role, cols.filed_by_user_id], [[1, "''"], [0, null]]);
		c.eq("§11 ...so an existing receipt reads as filed by no one", db.prepare("SELECT filed_by_role, filed_by_user_id FROM expenses").get(), { filed_by_role: "", filed_by_user_id: null });
		const refuses = (sql, ...a) => { try { db.prepare(sql).run(...a); return false; } catch { return true; } };
		const NOW = "2026-11-02T15:00:00.000Z";
		let nextId = 1000;
		const oo = (fee, source = "direct", status = "onboarding") => refuses("INSERT INTO owner_operators (user_id, fee_bps, source, status, created_at) VALUES (?, ?, ?, ?, ?)", nextId++, fee, source, status, NOW);
		c.eq("§11 owner_operators: the fee 10-25%, source and status checked", [oo(1800), oo(999), oo(2501), oo(1800, "other"), oo(1800, "direct", "paused")], [false, true, true, true, true]);
		c.eq("§11 ...its defaults: 18%, $2,500 at $500, installment unset, open", db.prepare("INSERT INTO owner_operators (user_id, created_at) VALUES (?, ?) RETURNING fee_bps, escrow_target_cents, escrow_weekly_cents, installment_cents, end_week_start, status, source").get(424242, NOW),
			{ fee_bps: 1800, escrow_target_cents: 250000, escrow_weekly_cents: 50000, installment_cents: 0, end_week_start: "", status: "onboarding", source: "direct" });
		c.ok("§11 ...one profile per account", refuses("INSERT INTO owner_operators (user_id, created_at) VALUES (?, ?)", 424242, NOW));
		const charge = (kind, amount, record = "outside_app") => refuses("INSERT INTO owner_operator_charges (oo_id, kind, category, label, cents, cost_record, created_at) VALUES (1, ?, 'fuel', 'Made-up charge', ?, ?, ?)", kind, amount, record, NOW);
		c.eq("§11 owner_operator_charges: never $0, a credit only one-time, its record checked", [charge("onboarding", 500), charge("onboarding", 0), charge("weekly", -500), charge("one_time", -500), charge("one_time", 500, "elsewhere"), charge("monthly", 500)],
			[false, true, true, false, true, true]);
		const line = (kind) => refuses("INSERT INTO owner_operator_settlement_lines (invoice_id, oo_id, kind, label, cents, created_at) VALUES (1, 1, ?, 'Made-up line', -1, ?)", kind, NOW);
		c.eq("§11 owner_operator_settlement_lines take every line kind, a deductible's charge included", (L.OO_LINE_KINDS || []).map(line).filter(Boolean).length, 0);
		c.ok("§11 ...and refuse any other", line("bonus"));
		c.ok("§11 ...the kinds are the thirteen the math writes", (L.OO_LINE_KINDS || []).length === 13 && (L.OO_LINE_KINDS || []).includes("deductible"));
		const use = (purpose, amount) => refuses("INSERT INTO owner_operator_escrow_uses (oo_id, purpose, cents, reason, created_at) VALUES (1, ?, ?, 'Made-up reason', ?)", purpose, amount, NOW);
		c.eq("§11 owner_operator_escrow_uses: the owner's two purposes, more than $0", [use("deductible", 100), use("unpaid_charge", 100), use("vacation", 100), use("deductible", 0)], [false, false, true, true]);
		const notice = (id, number) => refuses("INSERT INTO owner_operator_toll_notices (expense_id, agency, agency_key, notice_number, plate_or_transponder, toll_date, toll_cents, plate_check, duplicate_check, created_at) VALUES (?, 'Example Toll Authority', 'example toll authority', ?, 'OOX4821', '2026-11-18', 2375, 'match', 'clear', ?)", id, number, NOW);
		c.eq("§11 owner_operator_toll_notices: one row per notice number per agency; blank numbers apart", [notice(901, "N-1001"), notice(902, "N-1001"), notice(903, ""), notice(904, "")], [false, true, false, false]);
		const exit = () => refuses("INSERT INTO owner_operator_ledger_exits (oo_id, item_kind, ref, reason, decided_by, decided_at) VALUES (1, 'load', 'qa-oo-2', 'Stays on the investor ledger', 'made.up.admin', ?)", NOW);
		c.eq("§11 owner_operator_ledger_exits: one exit per item", [exit(), exit()], [false, true]);
		const link = (ooId, truckId, end) => refuses("INSERT INTO owner_operator_trucks (oo_id, truck_id, start_week_start, end_week_start, created_at) VALUES (?, ?, '2026-10-31', ?, ?)", ooId, truckId, end, NOW);
		c.eq("§11 owner_operator_trucks: one open link per owner-operator and per truck; ended links apart", [link(1, 10, ""), link(1, 11, ""), link(2, 10, ""), link(1, 10, "2026-11-07"), link(3, 12, "")], [false, true, true, false, false]);
		const app = (ownership, source) => refuses("INSERT INTO owner_operator_applications (application_id, truck_ownership, source, created_at) VALUES (?, ?, ?, ?)", nextId++, ownership, source, NOW);
		c.eq("§11 owner_operator_applications: own or lease, direct or partner", [app("own", "direct"), app("lease", "partner"), app("rent", "direct"), app("own", "agent")], [false, false, true, true]);
	} catch (err) {
		c.ok("§11 the schema runs", false, err.message);
	} finally {
		db.close();
	}
	// server.js runs it at boot, after the expenses table exists.
	const lines = SRC.split("\n");
	const at = (needle) => lines.findIndex((l) => l === needle);
	const req = at('const ownerOperator = require("./lib/owner-operator");');
	const exec = at("db.exec(ownerOperator.OO_SCHEMA_SQL);");
	const cols = lines.findIndex((l) => l.startsWith("for (const sql of ownerOperator.OO_EXPENSE_COLUMN_SQL)"));
	const expenses = lines.findIndex((l) => /CREATE TABLE IF NOT EXISTS expenses \(/.test(l));
	c.ok("§11 server.js requires the module, runs the tables and the two columns, once each", req >= 0 && exec > req && cols > exec
		&& SRC.split("ownerOperator.OO_SCHEMA_SQL").length === 2 && SRC.split("ownerOperator.OO_EXPENSE_COLUMN_SQL").length === 2, { req, exec, cols });
	c.ok("§11 ...after the expenses table is created", expenses >= 0 && exec > expenses);
}

// ── §12 ──────────────────────────────────────────────────────────────────────
function inertSection(c) {
	const names = ["OWNER_OPERATOR_ONBOARDING_ENABLED", "OWNER_OPERATOR_LOAD_PAY_ENABLED", "OWNER_OPERATOR_SETTLEMENTS_ENABLED", "OWNER_OPERATOR_ESCROW_ENABLED"];
	const defs = { onboarding: names[0], loadPay: names[1], settlements: names[2], escrow: names[3] };
	for (const [key, name] of Object.entries(defs)) {
		c.ok(`§12 server.js defines ${name} from the module's reader`, SRC.includes(`\nconst ${name} = OO_FLAGS.${key};\n`));
		c.eq(`§12 ...and nothing reads it`, SRC.split(new RegExp(`\\b${name}\\b`)).length - 1, 1);
	}
	c.ok("§12 the flags are read once, from the environment, through the module", SRC.split("ownerOperator.ooFlagsFromEnv(process.env)").length === 2);
	c.ok("§12 one start-up line logs the four flags", SRC.split("console.log(ownerOperator.ooFlagsStartupLine(OO_FLAGS));").length === 2);
	c.eq("§12 OO_FLAGS is used by the four flags and the start-up line only", SRC.split(/\bOO_FLAGS\b/).length - 1, 6);
	const uses = [...new Set((SRC.match(/\bownerOperator\.[A-Za-z_]+/g) || []).map((m) => m.slice("ownerOperator.".length)))].sort();
	c.eq("§12 server.js uses the module for the schema, the flags and the line only", uses, ["OO_EXPENSE_COLUMN_SQL", "OO_SCHEMA_SQL", "ooFlagsFromEnv", "ooFlagsStartupLine"]);
	c.eq("§12 no SQL in server.js names a new table or column", ["owner_operator", "filed_by_role", "filed_by_user_id"].filter((n) => SRC.includes(n)), []);
	const start = SRC.indexOf('const ownerOperator = require("./lib/owner-operator");');
	const end = SRC.indexOf("console.log(ownerOperator.ooFlagsStartupLine(OO_FLAGS));");
	const region = start >= 0 && end > start ? SRC.slice(start, end) : "";
	c.ok("§12 the region registers no route and starts no timer", region !== "" && !/\bapp\.|setInterval|setTimeout|\.listen\(/.test(region), region ? "" : "region not found");
	const requires = [...LIB_SRC.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort();
	c.eq("§12 the module requires only the app clock and the load-ID key", requires, ["./app-time", "./ratecon-load"]);
	c.ok("§12 ...and reads no environment itself", LIB_SRC !== "" && !LIB_SRC.includes("process.env"));
}

// ── §13 mutants ──────────────────────────────────────────────────────────────
function compileLib(text) {
	const m = new Module(LIB_FILE, module);
	m.filename = LIB_FILE;
	m.paths = Module._nodeModulePaths(path.dirname(LIB_FILE));
	m._compile(text, LIB_FILE);
	return m.exports;
}
// Replace exactly one occurrence, or throw: a mutant whose target is gone proves nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 80)}`);
	return src.replace(from, () => to);
}
function mutant(id, label, edits, run) {
	if (!realLib) { MAIN.ok(`§13 ${id}: ${label} — is caught`, false, "not evaluated: the module is missing"); return; }
	let text = LIB_SRC;
	try { for (const [from, to] of edits) text = mutate(text, from, to); } catch (err) {
		MAIN.ok(`§13 ${id}: ${label} — the mutation applies`, false, err.message);
		return;
	}
	let lib = null;
	try { lib = compileLib(text); } catch (err) { MAIN.ok(`§13 ${id}: ${label} — the mutant compiles`, false, err.message); return; }
	const c = checker(false);
	let threw = "";
	try { run(c, lib); } catch (err) { threw = err.message; }
	MAIN.ok(`§13 ${id}: ${label} — is caught (${c.failed.length} check(s) flip)`, c.failed.length > 0, threw ? `threw: ${threw}` : undefined);
}

(function main() {
	const sections = [
		["§1 the module", moduleSection], ["§2 the flags", flagsSection], ["§3 rounding", roundingSection],
		["§4 Saturday keys and stamps", daysSection], ["§5 the first settlement week", firstWeekSection],
		["§6 the truck", truckSection], ["§7 the owner's example and Appendix B", (c, L) => { appendixBSection(c, L); finalSection(c, L); }],
		["§8 the cases", casesSection], ["§9 the investor-ledger test inputs", ledgerSection], ["§10 validators", validatorsSection],
		["§11 the schema", schemaSection],
	];
	for (const [title, fn] of sections) {
		console.log(`\n${title}`);
		if (!realLib && fn !== moduleSection) { MAIN.ok(`${title.split(" ")[0]} runs`, false, "lib/owner-operator.js is missing"); continue; }
		try { fn(MAIN, realLib); } catch (err) { MAIN.ok(`${title.split(" ")[0]} runs to the end`, false, err.stack.split("\n").slice(0, 2).join(" ")); }
	}
	console.log("\n§12 inert");
	try { inertSection(MAIN); } catch (err) { MAIN.ok("§12 runs to the end", false, err.message); }

	console.log("\n§13 mutants");
	const appendixB = (c, L) => { roundingSection(c, L); appendixBSection(c, L); casesSection(c, L); };
	mutant("M1", "escrow held back before the onboarding balance clears", [["const depositAllowed = !final && escrowOn && onboardingLeftCents <= 0;", "const depositAllowed = !final && escrowOn;"]], appendixB);
	mutant("M2", "an installment taken on a short week", [["Math.min(installmentCents, leftCents, Math.max(0, beforeCents))", "Math.min(installmentCents, leftCents)"]], appendixB);
	mutant("M3", "the fee taken on net instead of load pay", [["const feeCents = ooFeeCents(loadCents, feeBps);", "const feeCents = ooFeeCents(loadCents - chargeCents, feeBps);"]], appendixB);
	mutant("M4", "the carried balance ignored", [["const beforeCents = shareCents - carriedInCents + escrowUseCents;", "const beforeCents = shareCents + escrowUseCents;"]], appendixB);
	mutant("M5", "a receipt settled twice", [["settled: settled.receipts,", "settled: new Map(),"]], appendixB);
	mutant("M6", "the profile's week no longer a floor", [
		["const candidates = dated.map((l) => ooWeekStart(l.day)).filter((w) => w >= floorWeekStart);", "const candidates = dated.map((l) => ooWeekStart(l.day));"],
		["if (candidates.length) firstWeekStart = laterWeek(floorWeekStart, earliestWeek(candidates));", "if (candidates.length) firstWeekStart = earliestWeek(candidates);"],
	], firstWeekSection);
	mutant("M7", "the final settlement's return gated on the escrow flag", [["const returning = final;", "const returning = final && escrowOn;"]], (c, L) => { finalSection(c, L); casesSection(c, L); });
	mutant("M8", "an unpaid-charge escrow use adding a charge line", [['if (use.purpose === "deductible") {', "if (true) {"]], casesSection);
	mutant("M9", "rounding by Math.round (half up, not away from zero)", [["const q = Math.floor((2 * Math.abs(num) + den) / (2 * den));\n\treturn num < 0 ? -q : q;", "return Math.round(num / den);"]], roundingSection);
	mutant("M10", "a truck week charged twice", [["if (cents > 0 && !charged.has(ref))", "if (cents > 0)"]], (c, L) => { truckSection(c, L); appendixBSection(c, L); });
	mutant("M11", "a Friday-evening stamp read on the UTC day", [["return appTime.dayInZone(new Date(ms), timeZone || appTime.appTimeZone());", "return new Date(ms).toISOString().slice(0, 10);"]], (c, L) => { daysSection(c, L); firstWeekSection(c, L); });

	console.log(`\n${passed} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
})();
