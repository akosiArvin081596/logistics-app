#!/usr/bin/env node
/**
 * Receipts auto-approve, rules v1 (lib/receipt-auto-approve.js): the pure judge.
 * Every reason code alone and together in rule order, the approve path, the exact
 * edges (cents, date, gallons, state, brand, confidence, 50 km, 48 h, 6 failed reads),
 * the printed-code fingerprint, rule 19's mixed ticket, and the rule 8 / 9 helpers.
 * Every driver, truck, code and amount here is made up.
 *
 * Run: node scripts/test-receipt-auto-approve-rules.js    # exits 1 on failure
 */
"use strict";

// A zone far from UTC, so a stamp read as local time instead of UTC shows on any machine.
process.env.TZ = "Asia/Manila";

const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "lib", "receipt-auto-approve.js");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`  ok    ${label}`); return; }
	fail++;
	console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
const section = (t) => console.log(`\n${t}`);

let A = null;
try {
	A = require(LIB);
} catch (err) {
	console.log(`  (lib/receipt-auto-approve.js could not be loaded: ${err.code || err.message})`);
}
// Every check runs; without the module each one fails on its own line.
const call = (fn, ...args) => {
	if (!A || typeof A[fn] !== "function") return { missing: fn };
	try { return A[fn](...args); } catch (err) { return { threw: err.message }; }
};
const pick = (v, keys) => (v && typeof v === "object" ? Object.fromEntries(keys.map((k) => [k, v[k]])) : v);
const verdictOf = (c, e) => pick(call("judge", c, e), ["verdict", "reasons"]);

// ── A made-up world: one fuel receipt that passes every rule ────────────────
const NOW = "2026-10-16T15:00:00.000Z";
const ID = 501;
function ocr(over = {}) {
	return {
		amount: 400, date: "2026-10-15", vendor: "PILOT #123", gallons: 96.18, state: "TX", city: "Sampleton",
		suggestedType: "Fuel", confidence: "high",
		details: [
			{ label: "Pump", value: "7" },
			{ label: "Product", value: "Diesel #2" },
			{ label: "Price/Gal", value: "$4.159" },
			{ label: "Auth Code", value: "A1B2C3" },
			{ label: "Trans #", value: "884213" },
			{ label: "Card", value: "XXXXXXXXXXXX4321" },
		],
		...over,
	};
}
function cand(over = {}) {
	return {
		id: ID, type: "Fuel", status: "Pending", driver: "Sample Driver A", truck_unit: "T-101", owner_id: 7,
		amount: 400, gallons: 96.18, date: "2026-10-15", location_state: "TX", location_city: "Sampleton",
		location_source: "geocode", vendor: "Pilot Travel Center #123", vendor_normalized: "PILOT FLYING J",
		receipt_details: "", created_at: "2026-10-15 18:00:00",
		...over,
	};
}
function ev(over = {}) {
	return {
		now: NOW,
		link: { expense_id: ID, fuel_event_id: 9001, match_basis: "exact_day", match_distance_km: 12.4 },
		assignments: [{ truck_unit: "T-101", start_date: "2026-09-01", end_date: "" }],
		truckOwnerId: 7,
		duplicateIds: new Set(),
		overriddenIds: new Set(),
		band: { min: 2.85, max: 6.78 },
		others: [],
		failedReads: 0,
		read: { status: "ok", ocr: ocr() },
		...over,
	};
}
const withRead = (o) => ev({ read: { status: "ok", ocr: ocr(o) } });
const other = (over = {}) => ({
	id: 777, type: "Fuel", status: "Approved", driver: "Sample Driver A", truck_unit: "T-101",
	vendor: "Pilot Travel Center #123", vendor_normalized: "PILOT FLYING J", receipt_details: "", ...over,
});

const CODES = ["NO_ELD_FILL", "ADJACENT_DAY", "PLACE_FAR", "TRUCK_UNSET", "TRUCK_NOT_HELD", "TRUCK_CHANGE_DAY",
	"OWNER_MISMATCH", "DUPLICATE", "OVERRIDDEN", "PRICE", "NO_PHOTO", "OCR_TOTAL", "OCR_DATE", "OCR_GALLONS",
	"OCR_PLACE", "OCR_BRAND", "OCR_LOW", "SAME_PAPER", "OCR_MIXED"];

section("§1 the module: rules v1 in the plan's order, and pure");
check("rules version", A && A.RULES_VERSION, "v1");
check("the 19 reason codes in rule order", A && A.RULES, CODES);
check("rules 1-10 are free, 11-19 need the re-read", [A && A.FREE_RULES, A && A.READ_RULES], [CODES.slice(0, 10), CODES.slice(10)]);
check("the limits: 50 km, 48 h, 6 failed reads", [A && A.MAX_PLACE_KM, A && A.FILL_WAIT_HOURS, A && A.MAX_READ_WAITS], [50, 48, 6]);
{
	let src = "";
	try { src = fs.readFileSync(LIB, "utf8").replace(/\/\/.*$/gm, ""); } catch { /* reported below */ }
	const requires = [...src.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]).sort();
	check("requires only crypto and three pure modules", requires,
		["./expense-analytics", "./receipt-duplicates", "./receipt-gallons-recovery", "crypto"]);
	check("reads no clock, environment, network or file",
		src ? [/Date\.now\(/, /new Date\(\s*\)/, /process\.env/, /\bfetch\(/, /readFileSync|writeFileSync/].map((re) => re.test(src)) : null,
		[false, false, false, false, false]);
}

section("§2 the approve path");
{
	const r = call("judge", cand(), ev());
	check("every rule passes: approve, no reasons, no wait", pick(r, ["verdict", "reasons", "wait", "failedReads"]),
		{ verdict: "approve", reasons: [], wait: null, failedReads: 0 });
	check("what the re-read said, as values only", r && r.read,
		{ amount: 400, date: "2026-10-15", gallons: 96.18, state: "TX", brand: "PILOT FLYING J", confidence: "high", ppg: 4.159 });
	check("two printed codes give two 64-hex fingerprints", r && Array.isArray(r.fingerprints) && r.fingerprints.map((f) => /^[0-9a-f]{64}$/.test(f)), [true, true]);
	check("no fingerprint carries the printed code",
		r && Array.isArray(r.fingerprints) && r.fingerprints.length ? r.fingerprints.some((f) => /884213|A1B2C3/i.test(f)) : "no fingerprints", false);
	check("the free stage alone says read", pick(call("judgeFree", cand(), ev()), ["verdict", "reasons", "wait"]), { verdict: "read", reasons: [], wait: null });
	const c = cand(); const e = ev();
	const deepFreeze = (o) => { if (o && typeof o === "object" && !(o instanceof Set)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
	deepFreeze(c); deepFreeze(e);
	check("judges frozen inputs without writing to them, the same way twice",
		[verdictOf(c, e), verdictOf(c, e)], [{ verdict: "approve", reasons: [] }, { verdict: "approve", reasons: [] }]);
}

section("§3 each free rule alone (1-10)");
{
	const hold = (reasons) => ({ verdict: "hold", reasons });
	check("1 NO_ELD_FILL: no fill links it, 48 h after filing", verdictOf(cand({ created_at: "2026-10-14 15:00:00" }), ev({ link: null })), hold(["NO_ELD_FILL"]));
	check("2 ADJACENT_DAY: the link is a next-day match", verdictOf(cand(), ev({ link: { expense_id: ID, match_basis: "adjacent_day", match_distance_km: 12.4 } })), hold(["ADJACENT_DAY"]));
	check("2 ADJACENT_DAY: any basis but exact_day", verdictOf(cand(), ev({ link: { expense_id: ID, match_basis: "", match_distance_km: 12.4 } })), hold(["ADJACENT_DAY"]));
	check("3 PLACE_FAR: 50.01 km", verdictOf(cand(), ev({ link: { expense_id: ID, match_basis: "exact_day", match_distance_km: 50.01 } })), hold(["PLACE_FAR"]));
	check("4 TRUCK_UNSET: the receipt names no truck", verdictOf(cand({ truck_unit: "  " }), ev()), hold(["TRUCK_UNSET"]));
	check("5 TRUCK_NOT_HELD: his assignment names another truck",
		verdictOf(cand({ truck_unit: "T-102" }), ev({ assignments: [{ truck_unit: "T-101", start_date: "2026-09-01", end_date: "" }] })), hold(["TRUCK_NOT_HELD"]));
	check("5 TRUCK_NOT_HELD: his assignment of that truck ended before the day",
		verdictOf(cand(), ev({ assignments: [{ truck_unit: "T-101", start_date: "2026-09-01", end_date: "2026-10-10" }] })), hold(["TRUCK_NOT_HELD"]));
	check("6 TRUCK_CHANGE_DAY: his assignment of the truck began the day before",
		verdictOf(cand(), ev({ assignments: [{ truck_unit: "T-101", start_date: "2026-10-14", end_date: "" }] })), hold(["TRUCK_CHANGE_DAY"]));
	check("6 TRUCK_CHANGE_DAY: another assignment of his ended the day after",
		verdictOf(cand(), ev({ assignments: [{ truck_unit: "T-101", start_date: "2026-09-01", end_date: "" }, { truck_unit: "T-205", start_date: "2026-08-01", end_date: "2026-10-16" }] })),
		hold(["TRUCK_CHANGE_DAY"]));
	check("7 OWNER_MISMATCH: the owner stamp isn't the truck's owner now", verdictOf(cand({ owner_id: 0 }), ev({ truckOwnerId: 7 })), hold(["OWNER_MISMATCH"]));
	check("8 DUPLICATE: in a duplicate group", verdictOf(cand(), ev({ duplicateIds: new Set([ID]) })), hold(["DUPLICATE"]));
	check("8 DUPLICATE: ids as an array too", verdictOf(cand(), ev({ duplicateIds: [String(ID)] })), hold(["DUPLICATE"]));
	check("9 OVERRIDDEN: an override names it", verdictOf(cand(), ev({ overriddenIds: new Set([ID]) })), hold(["OVERRIDDEN"]));
	check("10 PRICE: $9.00 a gallon is outside the band", verdictOf(cand({ amount: 90, gallons: 10 }),
		ev({ link: { expense_id: ID, match_basis: "exact_day", match_distance_km: 12.4 }, read: { status: "ok", ocr: ocr({ amount: 90, gallons: 10 }) } })), hold(["PRICE"]));
	check("10 PRICE: $2.00 a gallon is under the band", verdictOf(cand({ amount: 200, gallons: 100 }), withRead({ amount: 200, gallons: 100, details: [] })), hold(["PRICE"]));
	check("10 PRICE: the band's own edges pass ($2.85 and $6.78)",
		[verdictOf(cand({ amount: 285, gallons: 100 }), withRead({ amount: 285, gallons: 100, details: [] })).verdict,
			verdictOf(cand({ amount: 678, gallons: 100 }), withRead({ amount: 678, gallons: 100, details: [] })).verdict],
		["approve", "approve"]);
	check("a free hold makes no read: the re-read's reasons are not added", pick(call("judge", cand({ owner_id: 3 }), withRead({ amount: 1, confidence: "low" })), ["verdict", "reasons", "read"]),
		{ verdict: "hold", reasons: ["OWNER_MISMATCH"], read: null });
}

section("§4 each re-read rule alone (11-19)");
{
	const hold = (reasons) => ({ verdict: "hold", reasons });
	check("11 NO_PHOTO: no stored file", verdictOf(cand(), ev({ read: { status: "no_photo" } })), hold(["NO_PHOTO"]));
	check("12 OCR_TOTAL: the receipt reads another total", verdictOf(cand(), withRead({ amount: 399 })), hold(["OCR_TOTAL"]));
	check("13 OCR_DATE: the receipt reads another day", verdictOf(cand(), withRead({ date: "2026-10-14" })), hold(["OCR_DATE"]));
	check("14 OCR_GALLONS: 2 gallons apart", verdictOf(cand(), withRead({ gallons: 94.18, details: [] })), hold(["OCR_GALLONS"]));
	check("15 OCR_PLACE: another state", verdictOf(cand(), withRead({ state: "OK" })), hold(["OCR_PLACE"]));
	check("16 OCR_BRAND: both brands known and different", verdictOf(cand(), withRead({ vendor: "Love's Travel Stop #9" })), hold(["OCR_BRAND"]));
	check("17 OCR_LOW: low confidence", verdictOf(cand(), withRead({ confidence: "low" })), hold(["OCR_LOW"]));
	check("18 SAME_PAPER: another fuel receipt on his truck prints the same auth code",
		verdictOf(cand(), ev({ others: [other({ receipt_details: JSON.stringify([{ label: "Auth Code", value: "a1b2c3" }]) })] })), hold(["SAME_PAPER"]));
	check("19 OCR_MIXED: a store item on the ticket", verdictOf(cand(), withRead({ details: [...ocr().details, { label: "Energy Drink 16oz", value: "$3.49" }] })), hold(["OCR_MIXED"]));
}

section("§5 together, in rule order");
{
	const hold = (reasons) => ({ verdict: "hold", reasons });
	check("rules 2-10 at once, in order", verdictOf(
		cand({ truck_unit: "T-102", owner_id: 0, amount: 90, gallons: 10 }),
		ev({
			link: { expense_id: ID, match_basis: "adjacent_day", match_distance_km: 80 },
			assignments: [{ truck_unit: "T-101", start_date: "2026-10-16", end_date: "" }],
			truckOwnerId: 7, duplicateIds: new Set([ID]), overriddenIds: new Set([ID]),
		})),
	hold(["ADJACENT_DAY", "PLACE_FAR", "TRUCK_NOT_HELD", "TRUCK_CHANGE_DAY", "OWNER_MISMATCH", "DUPLICATE", "OVERRIDDEN", "PRICE"]));
	check("rule 1 with 4, 6, 8, 9 and 10, in order", verdictOf(
		cand({ truck_unit: "", amount: 90, gallons: 10, created_at: "2026-10-10 12:00:00" }),
		ev({ link: null, assignments: [{ truck_unit: "T-101", start_date: "2026-10-15", end_date: "" }],
			duplicateIds: new Set([ID]), overriddenIds: new Set([ID]) })),
	hold(["NO_ELD_FILL", "TRUCK_UNSET", "TRUCK_CHANGE_DAY", "DUPLICATE", "OVERRIDDEN", "PRICE"]));
	check("rules 12-19 at once, in order", verdictOf(cand(), ev({
		others: [other({ receipt_details: JSON.stringify([{ label: "Trans #", value: "884213" }]) })],
		read: { status: "ok", ocr: ocr({ amount: 380, date: "2026-10-13", gallons: 80, state: "OK", vendor: "Love's #9", confidence: "low",
			details: [...ocr().details, { label: "Merchandise", value: "$12.00" }] }) },
	})), hold(["OCR_TOTAL", "OCR_DATE", "OCR_GALLONS", "OCR_PLACE", "OCR_BRAND", "OCR_LOW", "SAME_PAPER", "OCR_MIXED"]));
}

section("§6 exact cents");
check("one cent over holds", verdictOf(cand(), withRead({ amount: 400.01 })).reasons, ["OCR_TOTAL"]);
check("one cent under holds", verdictOf(cand(), withRead({ amount: 399.99 })).reasons, ["OCR_TOTAL"]);
check("$0.00 apart passes, float noise included", [verdictOf(cand(), withRead({ amount: 400 })).verdict,
	verdictOf(cand({ amount: 412.1, gallons: 99.09 }), withRead({ amount: 412.10, gallons: 99.09, details: [] })).verdict], ["approve", "approve"]);
check("an unread total holds", [verdictOf(cand(), withRead({ amount: null })).reasons, verdictOf(cand(), withRead({ amount: "400.00" })).reasons], [["OCR_TOTAL"], ["OCR_TOTAL"]]);

section("§7 the date");
check("the same day passes; another day, none, another format or no such day hold",
	[ocr().date, "2026-10-16", null, "10/15/2026", "2026-02-30"].map((d) => verdictOf(cand(), withRead({ date: d })).reasons),
	[[], ["OCR_DATE"], ["OCR_DATE"], ["OCR_DATE"], ["OCR_DATE"]]);
check("a receipt dated on no real day never passes", verdictOf(cand({ date: "2026-02-30" }), withRead({ date: "2026-02-30" })).verdict, "hold");

section("§8 the gallons tolerance (more than 0.5 gal and more than 1% holds)");
{
	// $4.00 a gallon, so the price band never decides these.
	const g = (entered, read) => {
		const amount = Math.round(entered * 400) / 100;
		const r = verdictOf(cand({ gallons: entered, amount }), withRead({ amount, gallons: read, details: [] }));
		if (!r || !Array.isArray(r.reasons)) return r;
		return r.reasons.length > 1 ? r.reasons : r.reasons.includes("OCR_GALLONS");
	};
	check("0.5 gal apart passes", g(100, 100.5), false);
	check("1 gal apart at 101 gal (0.99%) passes", g(100, 101), false);
	check("0.51 gal apart at 51.51 gal (0.99%) passes", g(51, 51.51), false);
	check("0.61 gal apart at 60.61 gal (1.006%) holds", g(60, 60.61), true);
	check("1 gal apart at 50 gal (2%) holds", g(49, 50), true);
	check("no gallons read holds", g(96.18, null), true);
}

section("§9 the state");
check("case doesn't matter; another state, none, or a blank entry holds",
	[verdictOf(cand({ location_state: "tx" }), withRead({ state: "TX" })).reasons, verdictOf(cand(), withRead({ state: "OK" })).reasons,
		verdictOf(cand(), withRead({ state: null })).reasons, verdictOf(cand({ location_state: "" }), withRead({})).reasons],
	[[], ["OCR_PLACE"], ["OCR_PLACE"], ["OCR_PLACE"]]);

section("§10 the brands");
check("two spellings of one brand pass; an unknown side passes; two known brands hold",
	[verdictOf(cand(), withRead({ vendor: "PILOT FLYING J TRAVEL #44" })).reasons, verdictOf(cand(), withRead({ vendor: null })).reasons,
		verdictOf(cand({ vendor: "", vendor_normalized: "" }), withRead({ vendor: "Love's #9" })).reasons, verdictOf(cand(), withRead({ vendor: "Shell" })).reasons],
	[[], [], [], ["OCR_BRAND"]]);

section("§11 the reading's confidence");
check("high and medium pass; low, missing or another word holds",
	["high", "medium", "low", undefined, "HIGH"].map((x) => verdictOf(cand(), withRead({ confidence: x })).reasons),
	[[], [], ["OCR_LOW"], ["OCR_LOW"], ["OCR_LOW"]]);

section("§12 the fingerprint (rule 18)");
{
	check("a code across case, spaces, separators and masking",
		["ab12 34cd", "AB12-34CD", "AB 12CD", "tk-5150", "XXXX5678", "****5678", "APPROVED 012345", "Auth: 012345", "#884213"].map((v) => call("normalizeCode", v)),
		["AB1234CD", "AB1234CD", "AB12CD", "TK5150", "5678", "5678", "012345", "012345", "884213"]);
	check("a word, a short number, a date, a time or money is no code",
		["APPROVED", "VOID ONLY", "12", "10/15/2026", "14:32", "$400.00", ""].map((v) => call("normalizeCode", v)), ["", "", "", "", "", "", ""]);
	const codes = (d) => call("printedCodes", d);
	const found = codes([{ label: "Auth #", value: "111111" }, { label: "Approval Code", value: "222222" }, { label: "Invoice No", value: "333333" },
		{ label: "Ticket", value: "444444" }, { label: "Transaction Number", value: "555555" }]);
	check("auth or approval codes and transaction, invoice or ticket numbers count",
		Array.isArray(found) ? [...found].sort() : found, ["111111", "222222", "333333", "444444", "555555"]);
	check("a pump number alone makes none", [codes([{ label: "Pump #", value: "12" }, { label: "Pump", value: "1207" }, { label: "Pump/Trans", value: "0712" }]),
		call("fingerprints", "PILOT FLYING J", [{ label: "Pump", value: "1207" }])], [[], []]);
	check("a transaction's date, an invoice total and a card number are not codes",
		codes([{ label: "Transaction Date", value: "20261015" }, { label: "Invoice Total", value: "400.00" }, { label: "Card", value: "XXXX4321" }]), []);
	check("stored details as JSON text read the same; broken text reads as none",
		[codes(JSON.stringify([{ label: "Auth", value: "9876" }])), codes("{not json"), codes({ label: "Auth" })], [["9876"], [], []]);
	const fp = (brand, value) => call("fingerprints", brand, [{ label: "Auth Code", value }]);
	const [fpA, fpB] = [fp("PILOT FLYING J", "ab 12cd"), fp("PILOT FLYING J", "AB12CD")];
	check("the same code in another case, spacing or masking gives the same fingerprint",
		Array.isArray(fpA) && fpA.length === 1 && JSON.stringify(fpA) === JSON.stringify(fpB), true);
	check("another brand gives another fingerprint", JSON.stringify(fp("PILOT FLYING J", "AB12CD")) === JSON.stringify(fp("LOVE'S", "AB12CD")), false);

	const twin = (over) => other({ receipt_details: JSON.stringify([{ label: "Auth Code", value: "A1B2C3" }]), ...over });
	const twinsOf = (others, c = cand()) => pick(call("judge", c, ev({ others })), ["verdict", "reasons", "twins"]);
	check("a twin whose details hold only one of the two codes is found (any one shared code)", twinsOf([twin()]),
		{ verdict: "hold", reasons: ["SAME_PAPER"], twins: [777] });
	check("same driver on another truck, or same truck under another driver: found",
		[twinsOf([twin({ truck_unit: "T-300" })]).twins, twinsOf([twin({ driver: "Sample Driver B" })]).twins], [[777], [777]]);
	check("another truck and another driver, another brand, a non-fuel receipt, or the receipt itself: not found",
		[twinsOf([twin({ truck_unit: "T-300", driver: "Sample Driver B" })]).twins, twinsOf([twin({ vendor: "Love's", vendor_normalized: "LOVE'S" })]).twins,
			twinsOf([twin({ type: "Other" })]).twins, twinsOf([twin({ id: ID })]).twins], [[], [], [], []]);
	check("a twin a person rejected still holds this copy for a person", twinsOf([twin({ status: "Rejected" })]).twins, [777]);
	check("a twin's own reading fingerprints count as well as its stored details",
		twinsOf([other({ fingerprints: call("fingerprints", "PILOT FLYING J", [{ label: "Trans #", value: "884213" }]) })]).twins, [777]);
	check("stored details can hold: the candidate's own stored code matches a twin's",
		pick(call("judge", cand({ receipt_details: JSON.stringify([{ label: "Ticket", value: "TK-5150" }]) }),
			ev({ others: [other({ receipt_details: JSON.stringify([{ label: "Ticket #", value: "tk5150" }]) })],
				read: { status: "ok", ocr: ocr({ details: [{ label: "Product", value: "Diesel" }] }) } })), ["verdict", "reasons"]),
		{ verdict: "hold", reasons: ["SAME_PAPER"] });
	const stored = JSON.stringify([{ label: "Ticket", value: "TK-5150" }, { label: "Product", value: "Diesel" }, { label: "Price/Gal", value: "4.000" }]);
	const viaStored = call("judge", cand({ receipt_details: stored }), ev({ read: { status: "ok", ocr: ocr({ details: [{ label: "Product", value: "Diesel" }] }) } }));
	check("never approve: the reading's fingerprints come from the re-read only", viaStored && viaStored.fingerprints, []);
	check("never approve: a clean stored copy doesn't clear what the re-read shows",
		verdictOf(cand({ receipt_details: stored }), withRead({ amount: 380, details: [{ label: "Merchandise", value: "$20.00" }] })).reasons, ["OCR_TOTAL", "OCR_MIXED"]);
	check("no printed code: rule 18 can't hold, even with no comparison set",
		verdictOf(cand(), ev({ others: undefined, read: { status: "ok", ocr: ocr({ details: [{ label: "Product", value: "Diesel" }] }) } })), { verdict: "approve", reasons: [] });
	check("a printed code with no comparison set holds (fail closed)", verdictOf(cand(), ev({ others: undefined })).reasons, ["SAME_PAPER"]);
}

section("§13 rule 3 and the receipt's place (L6)");
{
	const place = (km, source = "geocode") => verdictOf(cand({ location_source: source }),
		ev({ link: { expense_id: ID, match_basis: "exact_day", match_distance_km: km } })).reasons;
	check("exactly 50 km passes; 50.01, no distance, or a negative one hold",
		[place(50), place(50.01), place(null), place(""), place(-1)], [[], ["PLACE_FAR"], ["PLACE_FAR"], ["PLACE_FAR"], ["PLACE_FAR"]]);
	check("a place taken from the truck's own ELD ping holds at 3 km", place(3, "eld"), ["PLACE_FAR"]);
}

section("§14 rule 19, a ticket with more than fuel (NM1)");
{
	const mix = (o, c = {}) => verdictOf(cand(c), withRead(o)).reasons;
	const fuel = [{ label: "Product", value: "Diesel" }, { label: "Price/Gal", value: "$4.159" }];
	check("$400.00 prepaid at 96.18 gal x $4.159 passes", mix({ details: fuel }), []);
	check("a ticket $1.50 over gallons x price holds", mix({ amount: 401.5, details: fuel }, { amount: 401.5 }), ["OCR_MIXED"]);
	const at4 = [{ label: "Price Per Gallon", value: "4.000" }];
	check("the edge at 100 gal x $4.000 (0.005 x price + $0.01 = $0.03): $400.03 passes, $400.04 holds",
		[mix({ amount: 400.03, gallons: 100, details: at4 }, { amount: 400.03, gallons: 100 }), mix({ amount: 400.04, gallons: 100, details: at4 }, { amount: 400.04, gallons: 100 })],
		[[], ["OCR_MIXED"]]);
	check("a total under gallons x price (a fleet discount) passes", mix({ amount: 390, gallons: 100, details: at4 }, { amount: 390, gallons: 100 }), []);
	check("no price per gallon read holds nothing by itself", mix({ amount: 401.5, details: [{ label: "Product", value: "Diesel" }] }, { amount: 401.5 }), []);
	check("of two prices, the lower one is tested", call("pricePerGallon", [{ label: "Cash Price", value: "4.059" }, { label: "Credit Price", value: "4.159" }]), 4.059);
	check("a total or a discount line is not a price; 96.18 isn't a price", call("pricePerGallon",
		[{ label: "Fuel Total", value: "$400.00" }, { label: "Discount/Gal", value: "0.10" }, { label: "Price/Gal", value: "96.18 @ 4.159" }]), 4.159);
	check("store items listed hold, however they're labelled",
		[[{ label: "Energy Drink", value: "$3.49" }], [{ label: "Merchandise Total", value: "$12.00" }], [{ label: "DEF", value: "2.5 gal" }],
			[{ label: "Diesel Exhaust Fluid", value: "$15.00" }], [{ label: "Product", value: "Sunflower Seeds" }], [{ label: "Item", value: "Coffee" }],
			[{ label: "Scale Ticket #", value: "5501" }], [{ label: "Shower", value: "$15.00" }], [{ label: "Item", value: "$3.49" }],
			[{ label: "Product", value: "Diesel" }, { label: "Product", value: "Wiper Blades" }]]
			.map((d) => call("mixedTicket", { amount: 400, gallons: 96.18, details: [...fuel, ...d] }).mixed),
		[true, true, true, true, true, true, true, true, true, true]);
	check("goods whose names share a word with a fuel-ticket line still hold",
		["Potato Chips", "Cashews", "Gift Card", "Diesel Fuel Additive", "Phone Charger", "Trailer Lock", "Trucker Hat"]
			.map((label) => call("mixedTicket", { amount: 400, gallons: 96.18, details: [...fuel, { label, value: "$9.99" }] }).mixed),
		[true, true, true, true, true, true, true]);
	check("an item label with a fuel or a bare product code passes",
		[[{ label: "Product", value: "019" }], [{ label: "Description", value: "AUTO DIESEL" }], [{ label: "Item", value: "B20 Biodiesel" }]]
			.map((d) => call("mixedTicket", { amount: 400, gallons: 96.18, details: [...fuel, ...d] }).mixed), [false, false, false]);
	check("the lines a fuel-only ticket prints pass",
		call("mixedTicket", { amount: 400, gallons: 96.18, details: [
			{ label: "Pump #", value: "7" }, { label: "Grade", value: "#2" }, { label: "Fuel Type", value: "ULSD" }, { label: "Price/Gal", value: "$4.159" },
			{ label: "Gallons", value: "96.18" }, { label: "Fuel Sale", value: "$400.00" }, { label: "Discount", value: "-$0.00" },
			{ label: "Subtotal", value: "$400.00" }, { label: "Tax", value: "$0.00" }, { label: "Total", value: "$400.00" },
			{ label: "Payment Method", value: "Fleet Card" }, { label: "Card #", value: "XXXX4321" }, { label: "Entry Method", value: "Chip" },
			{ label: "Auth Code", value: "A1B2C3" }, { label: "Trans #", value: "884213" }, { label: "Invoice #", value: "77120" },
			{ label: "Store #", value: "123" }, { label: "Store Address", value: "1 Sample Rd" }, { label: "Phone", value: "555-0100" },
			{ label: "Time", value: "14:32" }, { label: "Odometer", value: "412345" }, { label: "Unit #", value: "T-101" },
			{ label: "Trailer", value: "TR-9" }, { label: "Driver ID", value: "D-17" }, { label: "Trip #", value: "4471" },
			{ label: "Cashier", value: "05" }, { label: "Reefer", value: "0.00" }, { label: "Rewards Points", value: "96" },
			{ label: "Shower Credit", value: "1 earned" }, { label: "Customer Copy", value: "" }, { label: "Cash", value: "$0.00" },
			{ label: "Change", value: "$0.00" }, { label: "Chip", value: "Read" }, { label: "Cardholder", value: "SAMPLE FLEET" },
		] }), { mixed: false, items: [], ppg: 4.159, over: false });
}

section("§15 the 48 h fill wait and the 6 failed reads (NL5)");
{
	const fill = (filed, now = NOW) => pick(call("judge", cand({ created_at: filed }), ev({ link: null, now })), ["verdict", "reasons", "wait"]);
	check("no fill 47 h 59 min after filing: wait", fill("2026-10-14 15:01:00"), { verdict: "wait", reasons: [], wait: "FILL" });
	check("no fill 48 h after filing: hold", fill("2026-10-14 15:00:00"), { verdict: "hold", reasons: ["NO_ELD_FILL"], wait: null });
	check("a stamp with no zone is UTC, an ISO stamp is read as written",
		[fill("2026-10-14T16:00:00Z").verdict, fill("2026-10-14T11:00:00-04:00").verdict, fill("2026-10-14T10:59:00-04:00").verdict], ["wait", "hold", "hold"]);
	check("a filing time that can't be read: hold, never wait", fill("yesterday").verdict, "hold");
	check("while the fill may come, another free rule holds at once",
		verdictOf(cand({ owner_id: 3 }), ev({ link: null })), { verdict: "hold", reasons: ["OWNER_MISMATCH"] });
	const read = (status, failedReads) => pick(call("judge", cand(), ev({ read: { status }, failedReads })), ["verdict", "reasons", "wait", "failedReads"]);
	check("a failed read waits and counts: 1st", read("failed", 0), { verdict: "wait", reasons: [], wait: "READ_FAILED", failedReads: 1 });
	check("the 6th failed read still waits", read("failed", 5), { verdict: "wait", reasons: [], wait: "READ_FAILED", failedReads: 6 });
	check("after 6 waits, the next failed read holds as OCR_UNREAD", read("failed", 6), { verdict: "hold", reasons: ["OCR_UNREAD"], wait: null, failedReads: 7 });
	check("a cap, the deadline or the day latch defers without counting, even after 6",
		[read("deferred", 0), read("deferred", 6)],
		[{ verdict: "wait", reasons: [], wait: "READ_DEFERRED", failedReads: 0 }, { verdict: "wait", reasons: [], wait: "READ_DEFERRED", failedReads: 6 }]);
	check("no read given: a deferred wait, never an approval", pick(call("judge", cand(), ev({ read: undefined })), ["verdict", "wait"]), { verdict: "wait", wait: "READ_DEFERRED" });
	check("a read status it doesn't know holds", read("weird", 0).reasons, ["OCR_UNREAD"]);
	check("a read that isn't an object holds on every field it can't read",
		verdictOf(cand(), ev({ read: { status: "ok", ocr: "not an object" } })).reasons, ["OCR_TOTAL", "OCR_DATE", "OCR_GALLONS", "OCR_PLACE", "OCR_LOW"]);
}

section("§16 missing evidence holds");
{
	const r = (e, c = cand()) => verdictOf(c, ev(e)).reasons;
	check("no duplicate set, no override set, no band, no truck owner",
		[r({ duplicateIds: undefined }), r({ overriddenIds: null }), r({ band: undefined }), r({ truckOwnerId: null })],
		[["DUPLICATE"], ["OVERRIDDEN"], ["PRICE"], ["OWNER_MISMATCH"]]);
	check("a receipt with no owner stamp holds", r({}, cand({ owner_id: null })), ["OWNER_MISMATCH"]);
	const foreign = { expense_id: 999, match_basis: "exact_day", match_distance_km: 1 };
	check("a link that names another receipt is no link: wait, then hold",
		[pick(call("judge", cand(), ev({ link: foreign })), ["verdict", "wait"]), r({ link: foreign }, cand({ created_at: "2026-10-01 12:00:00" }))],
		[{ verdict: "wait", wait: "FILL" }, ["NO_ELD_FILL"]]);
	check("an assignment whose dates can't be read holds", r({ assignments: [{ truck_unit: "T-101", start_date: "2026-09-01", end_date: "soon" }] }),
		["TRUCK_NOT_HELD", "TRUCK_CHANGE_DAY"]);
	check("a receipt with no id takes no link and no set's word for it, and never approves",
		verdictOf(cand({ id: undefined, created_at: "2026-10-01 12:00:00" }), ev({ link: { expense_id: undefined, match_basis: "exact_day", match_distance_km: 1 } })),
		{ verdict: "hold", reasons: ["NO_ELD_FILL", "DUPLICATE", "OVERRIDDEN"] });
	check("a receipt that isn't Fuel is held, never judged", verdictOf(cand({ type: "Other" }), ev()), { verdict: "hold", reasons: ["NOT_FUEL"] });
}

section("§17 rule 8 and rule 9 inputs (L4, NL8)");
{
	const row = (id, over = {}) => ({ id, date: "2026-10-15", truck_unit: "T-101", driver: "Sample Driver A", amount: 200, gallons: 48.1, vendor_normalized: "PILOT FLYING J", status: "Pending", ...over });
	const ids = (rows, opts) => { const s = call("duplicateMemberIds", rows, opts); return s instanceof Set ? [...s].sort((a, b) => a - b) : s; };
	check("a pair is found; a separate fill (other gallons) is not", ids([row(1), row(2), row(3, { gallons: 60 })]), [1, 2]);
	check("a Rejected copy is not spend, so its twin isn't a duplicate", ids([row(1), row(2, { status: "Rejected" })]), []);
	check("a Rejected receipt being judged joins its own check", ids([row(1), row(2, { status: "Rejected" })], { includeId: 2 }), [1, 2]);
	check("a group someone kept on purpose is closed", ids([row(1), row(2)], { suppressedIds: new Set([2]) }), []);
	const many = [];
	for (let i = 0; i < 205; i++) many.push(row(1000 + 2 * i, { truck_unit: `T-${i}` }), row(1001 + 2 * i, { truck_unit: `T-${i}` }));
	check("every group counts, past the 200th", ids(many).length, 410);
	const named = call("overrideNamedIds", [
		{ action: "expense_duplicate_override", entity_id: "88", details: "Logged despite matching expense #41 (PILOT FLYING J, 2026-10-15, $200, Sample Driver A)" },
		{ action: "update_expense_status", entity_id: "90", details: "status Pending -> Approved" },
		{ action: "expense_duplicate_override", entity_id: "", details: "no reference" },
	]);
	check("an override names the receipt it logged and the one it matched", named instanceof Set ? [...named].sort((a, b) => a - b) : named, [41, 88]);
	const band = call("priceBand", [{ amount: 400, gallons: 100 }]);
	check("rule 10's band is the gallons-recovery band (fixed band below 20 priced receipts)", band && [band.min, band.max, band.source], [2.5, 7, "fallback"]);
}

section("§18 model text is bounded (no slow patterns on long input)");
{
	const long = " ".repeat(150) + "1".repeat(40) + ". ".repeat(5);
	const details = Array.from({ length: 60 }, (_, i) => ({ label: `${"Price ".repeat(6)}${i}`.slice(0, 40), value: long }));
	let last = null;
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < 20; i++) last = call("judge", cand({ receipt_details: JSON.stringify(details) }), withRead({ details }));
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	check("20 judgements of 60 long detail lines under 1 s, each reaching a verdict", [ms < 1000, last && last.verdict], [true, "approve"]);
	check("details past 40 lines are not read", call("printedCodes", [...Array.from({ length: 40 }, () => ({ label: "Pump", value: "1" })), { label: "Auth", value: "424242" }]), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
