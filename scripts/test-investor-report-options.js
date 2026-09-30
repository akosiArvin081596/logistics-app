#!/usr/bin/env node
/**
 * lib/investor-report-options.js — the downloadable investor report's choices,
 * each one switch or one text table, in the one place to change them.
 *
 * WHAT IS PROVED HERE
 *   §1  the module is pure (no require), the shipped switches are the settings the
 *       owner approved on 2026-09-30, and a switch that names no setting stops the
 *       module from loading
 *   §2  reportDateRange(): a date is exactly YYYY-MM-DD and a real calendar day,
 *       or it is 400 INVALID_DATE naming the field; a start after the end is 400
 *       INVALID_RANGE; empty or missing is an open end; "whole-months" moves the
 *       start to the 1st and the end to the last day of their months (leap years
 *       included) and says whether either moved; "exact-dates" returns the dates
 *       as given; the default mode is RANGE_MODE
 *   §3  truckPriceFigures(): under "zero", exactly the figures the report and the
 *       tax CSV printed before 2026-09-30 (checked against that formula, typed
 *       out); under "not-available", the average over the priced trucks or null
 *       ("Not recorded"), a null total ("Not available") while any truck lacks a
 *       price, and the flag, never a $0 for a missing price
 *   §4  fill(), the texts (every template's placeholders, the hint), the payout
 *       row's labels and the Owner Earnings labels (each SPLIT is the report's
 *       split label, character for character; PAYOUT_LABEL.LEASE and the NOTE
 *       lease sentences are the shared lease wording; every lease label is listed
 *       in docs/investor-portal-copy.md §17), and how the server
 *       reads the module: one require, each switch passed explicitly, and
 *       GET /api/investor's reportRangeMode
 *   §5  MUTANTS, one per guard, each built from the module's own source and each
 *       caught: no calendar check, no INVALID_RANGE, no end-of-month widening, no
 *       mode check at load, a total that ignores unpriced trucks, and a per-truck
 *       average over every truck
 *
 * Run: node scripts/test-investor-report-options.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MODULE_PATH = path.join(__dirname, "..", "lib", "investor-report-options.js");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");
const SERVER_SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const O = require(MODULE_PATH);

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

// Loads a copy of the module from (possibly mutated) source text.
function loadFrom(src) {
	const module = { exports: {} };
	new Function("module", "exports", src)(module, module.exports);
	return module.exports;
}
function mutate(from, to) {
	if (MODULE_SRC.split(from).length - 1 !== 1) throw new Error(`mutant anchor not found exactly once: ${from}`);
	return MODULE_SRC.replace(from, to);
}

// ---------------------------------------------------------------- §1
section("§1 pure, the approved settings, and a typo cannot load");
{
	ok(!/\brequire\(/.test(MODULE_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")), "the module requires nothing");
	eq([O.RANGE_MODE, O.UNPRICED_TRUCKS], ["whole-months", "not-available"], "shipped: RANGE_MODE \"whole-months\", UNPRICED_TRUCKS \"not-available\"");
	eq([O.RANGE_MODES, O.UNPRICED_TRUCK_MODES], [["whole-months", "exact-dates"], ["not-available", "zero"]], "each switch has exactly two settings");
	for (const [name, setting] of [["RANGE_MODE", "exact-dates"], ["UNPRICED_TRUCKS", "zero"]]) {
		const flipped = loadFrom(mutate(`const ${name} = "${O[name]}";`, `const ${name} = "${setting}";`));
		eq(flipped[name], setting, `flipping ${name} to "${setting}" is a one-line edit that loads`);
	}
	let threw = null;
	try { loadFrom(mutate('const RANGE_MODE = "whole-months";', 'const RANGE_MODE = "whole-month";')); } catch (e) { threw = e.message; }
	ok(threw && /RANGE_MODE must be one of whole-months, exact-dates/.test(threw), "a RANGE_MODE naming no setting stops the module loading");
	threw = null;
	try { loadFrom(mutate('const UNPRICED_TRUCKS = "not-available";', 'const UNPRICED_TRUCKS = "none";')); } catch (e) { threw = e.message; }
	ok(threw && /UNPRICED_TRUCKS must be one of not-available, zero/.test(threw), "an UNPRICED_TRUCKS naming no setting stops the module loading");
	for (const fn of [() => O.reportDateRange("", "", "whole"), () => O.truckPriceFigures({ trucks: [] }, "blank")]) {
		let t = false;
		try { fn(); } catch { t = true; }
		ok(t, "a function asked for a setting that does not exist throws");
	}
}

// ---------------------------------------------------------------- §2
section("§2 reportDateRange()");
{
	const R = O.reportDateRange;
	const bad = (field) => ({ ok: false, status: 400, code: "INVALID_DATE", field, error: `The ${field} date must be a real date written as YYYY-MM-DD.` });
	const INVALID = ["garbage", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-29", "2026-02-30", "2026-4-01", "2026-04-1",
		" 2026-04-01", "2026-04-01 ", "2026-04-01T00:00:00", "04/01/2026", "20260401", "2026-04-00", "+02026-04-01"];
	for (const v of INVALID) {
		eq(R(v, "", "whole-months"), bad("start"), `start ${JSON.stringify(v)}: 400 INVALID_DATE naming start`);
		eq(R("", v, "exact-dates"), bad("end"), `end ${JSON.stringify(v)}: 400 INVALID_DATE naming end`);
	}
	for (const v of [["2026-04-01"], 12, {}, true]) {
		eq(R(v, "", "whole-months"), bad("start"), `a start that is not text (${JSON.stringify(v)}): 400 INVALID_DATE`);
	}
	eq(R("junk", "also junk", "whole-months").field, "start", "both ends bad: the start is named first");
	eq(R("2026-08-10", "2026-05-01", "whole-months"), { ok: false, status: 400, code: "INVALID_RANGE", error: "The start date is after the end date." },
		"a start after the end: 400 INVALID_RANGE");
	eq(R("2026-08-10", "2026-05-01", "exact-dates").code, "INVALID_RANGE", "…in either mode");
	eq(R("2026-08-10", "2026-08-01", "whole-months").code, "INVALID_RANGE", "…even inside one month (checked before widening)");
	for (const empty of [undefined, null, ""]) {
		eq(R(empty, empty, "whole-months"), { ok: true, from: "", until: "", widened: false }, `${JSON.stringify(empty)} ends: unbounded`);
	}
	// whole-months
	eq(R("2026-05-15", "2026-08-02", "whole-months"), { ok: true, from: "2026-05-01", until: "2026-08-31", widened: true }, "whole-months: the 15th to the 1st, the 2nd to the 31st");
	eq(R("2026-05-01", "2026-08-31", "whole-months"), { ok: true, from: "2026-05-01", until: "2026-08-31", widened: false }, "whole-months: whole months already, not widened");
	eq(R("2026-05-01", "2026-08-30", "whole-months").widened, true, "whole-months: one end moved is widened");
	eq(R("2026-02-10", "2026-02-11", "whole-months"), { ok: true, from: "2026-02-01", until: "2026-02-28", widened: true }, "whole-months: February 2026 ends on the 28th");
	eq(R("2024-02-29", "2024-02-29", "whole-months"), { ok: true, from: "2024-02-01", until: "2024-02-29", widened: true }, "whole-months: February 2024 (leap) ends on the 29th");
	eq(R("", "2000-02-03", "whole-months").until, "2000-02-29", "whole-months: 2000 is a leap year (divisible by 400)");
	eq(R("1900-02-28", "", "whole-months"), { ok: true, from: "1900-02-01", until: "", widened: true }, "whole-months: 1900 is not (1900-02-29 would be refused)");
	eq(R("1900-02-29", "", "whole-months").code, "INVALID_DATE", "…and 1900-02-29 is refused");
	for (const [m, last] of [["01", 31], ["03", 31], ["04", 30], ["06", 30], ["09", 30], ["11", 30], ["12", 31]]) {
		eq(R("", `2026-${m}-15`, "whole-months").until, `2026-${m}-${last}`, `whole-months: 2026-${m} ends on the ${last}th`);
	}
	eq(R("2026-05-15", "", "whole-months"), { ok: true, from: "2026-05-01", until: "", widened: true }, "whole-months: a start only");
	eq(R("", "2026-05-15", "whole-months"), { ok: true, from: "", until: "2026-05-31", widened: true }, "whole-months: an end only");
	// exact-dates
	eq(R("2026-05-15", "2026-08-02", "exact-dates"), { ok: true, from: "2026-05-15", until: "2026-08-02", widened: false }, "exact-dates: the dates as given");
	eq(R("2026-05-15", "2026-05-15", "exact-dates"), { ok: true, from: "2026-05-15", until: "2026-05-15", widened: false }, "exact-dates: a one-day range");
	// default
	eq(R("2026-05-15", "2026-08-02"), R("2026-05-15", "2026-08-02", O.RANGE_MODE), "the default mode is RANGE_MODE");
}

// ---------------------------------------------------------------- §3
section("§3 truckPriceFigures()");
// The trucks the documents priced, as investorTruckPurchase() returns them.
function purchaseOf(prices) {
	const trucks = prices.map((p, i) => ({ id: i + 1, purchase_price: p }));
	const recorded = prices.map(Number).filter((p) => Number.isFinite(p) && p > 0);
	const total = recorded.reduce((s, p) => s + p, 0);
	return {
		trucks,
		pricedCount: recorded.length,
		unpricedCount: trucks.length - recorded.length,
		totalPurchasePrice: total,
		purchasePrice: recorded.length === 0 ? null : (trucks.length === 1 ? recorded[0] : Math.round(total / recorded.length)),
	};
}
// ⚠️ THE ORACLE for "zero": the formula investorTruckPurchase() and both documents
// used at d8a4a64, typed out. Every truck counts, one with no price at $0.
function before(prices) {
	const total = prices.reduce((s, p) => s + (p || 0), 0);
	const perTruck = prices.length === 1 ? (prices[0] || 0) : (prices.length > 0 ? Math.round(total / prices.length) : 0);
	return { perTruck, total };
}
const FLEETS = {
	"no trucks": [],
	"one truck, priced": [61234.5],
	"one truck, no price (null)": [null],
	"one truck, no price (0)": [0],
	"two priced": [60000, 40001],
	"one of two priced": [60000, null],
	"one of three priced": [0, 90000, null],
	"none of two priced": [null, 0],
	"three priced": [50000, 50000, 50001],
};
{
	for (const [name, prices] of Object.entries(FLEETS)) {
		const z = O.truckPriceFigures(purchaseOf(prices), "zero");
		eq({ perTruck: z.perTruck, total: z.total }, before(prices), `zero, ${name}: the figures before the choice`);
		ok(z.flagged === false, `zero, ${name}: never flagged`);
	}
	const NA = (prices) => O.truckPriceFigures(purchaseOf(prices), "not-available");
	eq(NA(FLEETS["no trucks"]), { perTruck: null, total: 0, flagged: false, unpricedCount: 0, truckCount: 0 }, "not-available, no trucks: no per-truck price, a true $0 total, no flag");
	eq(NA(FLEETS["one truck, priced"]), { perTruck: 61234.5, total: 61234.5, flagged: false, unpricedCount: 0, truckCount: 1 }, "not-available, one priced truck: its own price, unrounded");
	eq(NA(FLEETS["one truck, no price (null)"]), { perTruck: null, total: null, flagged: true, unpricedCount: 1, truckCount: 1 }, "not-available, one truck, no price: Not recorded / Not available, flagged");
	eq(NA(FLEETS["one truck, no price (0)"]), { perTruck: null, total: null, flagged: true, unpricedCount: 1, truckCount: 1 }, "not-available, a price of 0 is no price");
	eq(NA(FLEETS["two priced"]), { perTruck: 50001, total: 100001, flagged: false, unpricedCount: 0, truckCount: 2 }, "not-available, all priced: the rounded average and the total");
	eq(NA(FLEETS["one of two priced"]), { perTruck: 60000, total: null, flagged: true, unpricedCount: 1, truckCount: 2 }, "not-available, one of two priced: the priced average, no total, flagged");
	eq(NA(FLEETS["one of three priced"]), { perTruck: 90000, total: null, flagged: true, unpricedCount: 2, truckCount: 3 }, "not-available, one of three priced: 2 of 3 unpriced");
	eq(NA(FLEETS["none of two priced"]), { perTruck: null, total: null, flagged: true, unpricedCount: 2, truckCount: 2 }, "not-available, none priced: nothing to show but the flag");
	for (const [name, prices] of Object.entries(FLEETS)) {
		const f = NA(prices);
		const p = purchaseOf(prices);
		ok(!(p.unpricedCount > 0 && (f.total === 0 || f.perTruck === 0)), `not-available, ${name}: no $0 stands in for a missing price`);
	}
	eq(O.truckPriceFigures(purchaseOf([60000, null])), NA([60000, null]), "the default mode is UNPRICED_TRUCKS");
}

// ---------------------------------------------------------------- §4
section("§4 texts, fill(), and how the server reads the module");
{
	eq(O.fill("{a} and {b}", { a: 1, b: "two" }), "1 and two", "fill() fills each placeholder");
	eq(O.fill("{a} and {missing}", { a: 1 }), "1 and {missing}", "…and leaves one with no value as written");
	eq(O.fill("{a}", { a: "$& $1 $$" }), "$& $1 $$", "…and inserts a value literally (no replacement patterns)");
	const placeholders = (t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	const WANT = {
		RANGE_WHOLE_MONTHS: ["span"], RANGE_WHOLE_MONTHS_FLEET: ["span"], RANGE_EXACT_DATES: [], NO_MONTHS: [],
		INVESTOR: ["span"], FLEET: ["span"], IN_PROGRESS: ["month"], CARRIED: [], SETTLED_DIFFERS_ONE: ["months"],
		SETTLED_DIFFERS_MANY: ["months"], CORRECTED: ["months"], SPAN: ["first", "last"], SPAN_FROM: ["first"], SPAN_UNTIL: ["last"],
		LEASE: ["amount"], LEASE_FROM: ["amount", "month"], LEASE_DURING: ["amount", "span"],
	};
	eq(Object.keys(O.NOTE).sort(), Object.keys(WANT).sort(), "NOTE holds exactly the note's templates");
	for (const [k, want] of Object.entries(WANT)) eq(placeholders(O.NOTE[k]), want, `NOTE.${k} takes ${want.length ? want.join(", ") : "no value"}`);
	// The payout row's label. SPLIT is the label the report printed at 61406a1
	// (server.js: `Investor Payout (${splitPctLabel}%)`), typed out here as the oracle.
	eq(Object.keys(O.PAYOUT_LABEL).sort(), ["LEASE", "MIXED", "SPLIT"], "PAYOUT_LABEL holds exactly SPLIT, LEASE and MIXED");
	eq([placeholders(O.PAYOUT_LABEL.SPLIT), placeholders(O.PAYOUT_LABEL.LEASE), placeholders(O.PAYOUT_LABEL.MIXED)], [["pct"], [], []],
		"PAYOUT_LABEL.SPLIT takes {pct}; LEASE and MIXED take no value");
	eq(O.PAYOUT_LABEL.SPLIT.replace("{pct}", "${splitPctLabel}"), "Investor Payout (${splitPctLabel}%)", "SPLIT is the report's split label, character for character");
	eq(O.fill(O.PAYOUT_LABEL.SPLIT, { pct: 50 }), "Investor Payout (50%)", "SPLIT at 50 prints today's exact label");
	eq(O.fill(O.PAYOUT_LABEL.SPLIT, { pct: 55 }), "Investor Payout (55%)", "…and at 55, the investor's own split");
	eq([O.PAYOUT_LABEL.LEASE, O.PAYOUT_LABEL.MIXED], ["Investor Payout (fixed monthly lease)", "Investor Payout"], "LEASE (the shared wording L9) and MIXED");
	// The same figure beside Net Cash Flow. SPLIT is the label the report printed at
	// 61406a1 (server.js: `Owner Earnings (${splitPctLabel}%)`), typed out as the oracle.
	eq(Object.keys(O.OWNER_EARNINGS_LABEL).sort(), ["LEASE", "MIXED", "SPLIT"], "OWNER_EARNINGS_LABEL holds exactly SPLIT, LEASE and MIXED");
	eq([placeholders(O.OWNER_EARNINGS_LABEL.SPLIT), placeholders(O.OWNER_EARNINGS_LABEL.LEASE), placeholders(O.OWNER_EARNINGS_LABEL.MIXED)], [["pct"], [], []],
		"OWNER_EARNINGS_LABEL.SPLIT takes {pct}; LEASE and MIXED take no value");
	eq(O.OWNER_EARNINGS_LABEL.SPLIT.replace("{pct}", "${splitPctLabel}"), "Owner Earnings (${splitPctLabel}%)", "OWNER_EARNINGS_LABEL.SPLIT is the report's split label, character for character");
	// fill() converts with String(), as the template literal did: the same text for
	// every split % resolveInvestorSplitPct() can answer, a fraction included.
	for (const pct of [50, 55, 37.5, 100]) {
		eq(O.fill(O.OWNER_EARNINGS_LABEL.SPLIT, { pct }), `Owner Earnings (${pct}%)`, `OWNER_EARNINGS_LABEL.SPLIT at ${pct} prints today's exact label`);
	}
	eq([O.OWNER_EARNINGS_LABEL.LEASE, O.OWNER_EARNINGS_LABEL.MIXED], ["Owner Earnings (fixed monthly lease)", "Owner Earnings"], "OWNER_EARNINGS_LABEL.LEASE and MIXED");
	eq(Object.keys(O.OWNER_EARNINGS_LABEL), Object.keys(O.PAYOUT_LABEL), "…the same keys as PAYOUT_LABEL, so one choice picks both labels");
	eq([O.NOTE.LEASE, O.NOTE.LEASE_FROM, O.NOTE.LEASE_DURING], [
		"Your payout is a fixed monthly lease of {amount}, not a share of net profit.",
		"From {month}, your payout is a fixed monthly lease of {amount}, not a share of net profit.",
		"For {span}, your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	], "NOTE.LEASE, LEASE_FROM and LEASE_DURING are the shared wording L8, L8b and L8c, verbatim");
	eq(O.fill(O.NOTE.LEASE_FROM, { month: "September 2026", amount: "$2,000" }),
		"From September 2026, your payout is a fixed monthly lease of $2,000, not a share of net profit.", "NOTE.LEASE_FROM, filled");
	// This module loads nothing, so it keeps copies of the shared lease wording;
	// lib/lease-payout-text.js is their one home, and they must not drift from it.
	const SHARED = require(path.join(__dirname, "..", "lib", "lease-payout-text.js")).LEASE_TEXT;
	eq([O.PAYOUT_LABEL.LEASE, O.NOTE.LEASE, O.NOTE.LEASE_FROM, O.NOTE.LEASE_DURING],
		[SHARED.REPORT_LABEL, SHARED.REPORT_NOTE, SHARED.REPORT_NOTE_FROM, SHARED.REPORT_NOTE_DURING],
		"PAYOUT_LABEL.LEASE and the NOTE lease sentences equal lib/lease-payout-text.js, character for character");
	ok(!/\brequire\(/.test(MODULE_SRC.replace(/^\s*\/\/.*$/gm, "")), "the module still loads nothing (so it keeps copies)");
	const DOC = fs.readFileSync(path.join(__dirname, "..", "docs", "investor-portal-copy.md"), "utf8");
	const s17 = DOC.slice(DOC.indexOf("\n## 17. "), DOC.indexOf("\n## ", DOC.indexOf("\n## 17. ") + 5));
	for (const [k, v] of Object.entries({
		"PAYOUT_LABEL.LEASE": O.PAYOUT_LABEL.LEASE, "PAYOUT_LABEL.MIXED": O.PAYOUT_LABEL.MIXED,
		"OWNER_EARNINGS_LABEL.LEASE": O.OWNER_EARNINGS_LABEL.LEASE, "OWNER_EARNINGS_LABEL.MIXED": O.OWNER_EARNINGS_LABEL.MIXED,
		"NOTE.LEASE": O.NOTE.LEASE, "NOTE.LEASE_FROM": O.NOTE.LEASE_FROM, "NOTE.LEASE_DURING": O.NOTE.LEASE_DURING,
	})) {
		ok(s17.length > 100 && s17.includes("`" + v + "`"), `docs/investor-portal-copy.md §17 lists ${k} verbatim`);
	}
	eq(placeholders(O.UNPRICED_TEXT.FOOTNOTE), ["n", "total"], "UNPRICED_TEXT.FOOTNOTE takes {n} and {total}");
	eq(O.fill(O.UNPRICED_TEXT.FOOTNOTE, { n: 1, total: 2 }),
		"Purchase price not recorded for 1 of 2 truck(s). Figures that need it show \"Not available\" until it is entered in the Truck Database.",
		"the footnote, filled");
	eq([O.UNPRICED_TEXT.NOT_RECORDED, O.UNPRICED_TEXT.NOT_AVAILABLE, O.UNPRICED_TEXT.CSV_COUNT_LABEL],
		["Not recorded", "Not available", "Trucks without a recorded purchase price"], "the unpriced labels");
	eq(O.RANGE_HINT, "Reports cover whole months: a date range that starts or ends mid-month includes that whole month, because payouts are settled by month.",
		"the hint under the portal's date inputs");
	// Control and invisible format characters, built from code points: a literal
	// one in this file would be invisible itself.
	const BS = String.fromCharCode(92);
	const hex = (n) => BS + "u" + n.toString(16).padStart(4, "0");
	const INVISIBLE = new RegExp("[" + [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
		.map(([a, b]) => `${hex(a)}-${hex(b)}`).join("") + "]");
	ok([0x00, 0x1f, 0x85, 0xad, 0x200b, 0x2028, 0x202e, 0x2066, 0xfeff].every((c) => INVISIBLE.test(`a${String.fromCodePoint(c)}b`)) && !INVISIBLE.test("a – b"),
		"control: the scan sees each invisible character and passes the en dash");
	const labels = Object.fromEntries([
		...Object.entries(O.PAYOUT_LABEL).map(([k, v]) => [`PAYOUT_LABEL.${k}`, v]),
		...Object.entries(O.OWNER_EARNINGS_LABEL).map(([k, v]) => [`OWNER_EARNINGS_LABEL.${k}`, v]),
	]);
	for (const [k, v] of Object.entries({ ...O.NOTE, ...O.UNPRICED_TEXT, RANGE_HINT: O.RANGE_HINT, ...O.DATE_ERRORS, ...labels })) {
		ok(typeof v === "string" && v === v.trim() && !/\s{2}/.test(v) && !INVISIBLE.test(v),
			`${k}: plain printable text, no doubled or edge spaces`);
	}
	ok(Object.isFrozen(O.NOTE) && Object.isFrozen(O.UNPRICED_TEXT) && Object.isFrozen(O.DATE_ERRORS) && Object.isFrozen(O.PAYOUT_LABEL)
		&& Object.isFrozen(O.OWNER_EARNINGS_LABEL), "the text tables are frozen");

	// The server: one require, each switch passed explicitly (so a runner can hand a
	// handler either setting), and the range mode on GET /api/investor.
	eq(SERVER_SRC.split('require("./lib/investor-report-options")').length - 1, 1, "server.js requires the module once");
	eq(SERVER_SRC.split("investorReportOptions.reportDateRange(req.query.start, req.query.end, investorReportOptions.RANGE_MODE)").length - 1, 1,
		"the report checks its range under RANGE_MODE, passed explicitly");
	eq(SERVER_SRC.split("investorReportOptions.truckPriceFigures(purchase, investorReportOptions.UNPRICED_TRUCKS)").length - 1, 2,
		"the report and the tax CSV each price trucks under UNPRICED_TRUCKS, passed explicitly");
	const inv = SERVER_SRC.indexOf('app.get("/api/investor", requireRole("Super Admin", "Investor"), ');
	const invEnd = SERVER_SRC.indexOf("\napp.get(", inv + 10);
	const handler = SERVER_SRC.slice(inv, invEnd);
	ok(inv > 0 && /\n\t\t\treportRangeMode: investorReportOptions\.RANGE_MODE,\n/.test(handler), "GET /api/investor answers reportRangeMode: RANGE_MODE, top level");
	eq((SERVER_SRC.match(/reportRangeMode:/g) || []).length, 1, "…and nothing else sets it");
}

// ---------------------------------------------------------------- §5
section("§5 MUTANTS — each must be caught");
{
	const cases = [
		{
			name: "no calendar check (a date only has to look like YYYY-MM-DD)",
			src: mutate("if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { ok: false };", ""),
			caught: (M) => M.reportDateRange("2026-02-30", "", "exact-dates").ok === true,
		},
		{
			name: "no INVALID_RANGE (a start after the end is accepted)",
			src: mutate('if (s.day && e.day && s.day > e.day) return { ok: false, status: 400, code: "INVALID_RANGE", error: DATE_ERRORS.INVALID_RANGE };', ""),
			caught: (M) => M.reportDateRange("2026-08-10", "2026-05-01", "whole-months").ok === true,
		},
		{
			name: "whole-months that does not move the end to the month's last day",
			src: mutate('const until = e.day ? `${e.day.slice(0, 7)}-${String(daysInMonth(e.year, e.month)).padStart(2, "0")}` : "";', "const until = e.day;"),
			caught: (M) => M.reportDateRange("2026-05-15", "2026-08-02", "whole-months").until === "2026-08-02",
		},
		{
			name: "no mode check at load (a typo picks a behaviour silently)",
			src: mutate('assertMode(RANGE_MODE, RANGE_MODES, "RANGE_MODE");', "").replace('const RANGE_MODE = "whole-months";', 'const RANGE_MODE = "whole-month";'),
			caught: (M) => M.RANGE_MODE === "whole-month",
		},
		{
			name: "a fleet total that ignores unpriced trucks (a silent $0 in the total)",
			src: mutate("total: purchase.unpricedCount > 0 ? null : purchase.totalPurchasePrice,", "total: purchase.totalPurchasePrice,"),
			caught: (M) => M.truckPriceFigures(purchaseOf([60000, null]), "not-available").total === 60000,
		},
		{
			name: "a per-truck average over every truck (an unpriced truck counted at $0)",
			src: mutate("perTruck: purchase.pricedCount > 0 ? purchase.purchasePrice : null,",
				"perTruck: purchase.trucks.length ? Math.round(purchase.totalPurchasePrice / purchase.trucks.length) : null,"),
			caught: (M) => M.truckPriceFigures(purchaseOf([60000, null]), "not-available").perTruck === 30000,
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
	// And each guard, as shipped, refuses what its mutant lets through.
	ok(O.reportDateRange("2026-02-30", "", "exact-dates").ok === false && O.reportDateRange("2026-08-10", "2026-05-01", "whole-months").ok === false,
		"control: the shipped module refuses both");
}

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutants caught)`);
