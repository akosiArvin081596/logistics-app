#!/usr/bin/env node
/**
 * Driver privacy PR B: the page verdict (lib/receipt-page-verdict.js), pure.
 * Plan ~/LogisX-replica/reports/2026-10-22-driver-privacy-receipts-plan.md
 * Revision 3, section 5. Every name, truck, plate, VIN and card here is made up.
 *
 *   T8  verdicts, codes only: another driver by full name, "LAST, FIRST",
 *       spacing and case, run together, initial + surname, first and last name
 *       apart; the receipt's driver's own name in any spelling never counts;
 *       another truck by labelled unit, plate or VIN (an unlabelled number is
 *       no unit); a last-4 next to a card label seen only on another driver's
 *       receipts (a shared card, or one without a label, decides nothing); text
 *       without the amount + date or the vendor, or drawn in an unmapped font,
 *       is UNREADABLE; any page of a multi-page file, or one with 4+ dated money
 *       lines, or 2 on different dates, is STATEMENT even with his name and
 *       truck (2 on the same date are not); a clean single page is AUTO_RELEASED
 *   T13 6 pages with long whitespace runs and repeated date / money shapes:
 *       every verdict inside the time cap (bounded patterns)
 *   the release rule (releasedPages, markLapses): a page reaches the driver only
 *       with a verdict for this file under this roster, by a Super Admin mark or
 *       AUTO_RELEASED; "office" withholds; a mark lapses when a later verdict
 *       finds an OTHER_* code it did not acknowledge
 *
 * Run: node scripts/test-receipt-page-verdict.js    # exits 1 on failure
 */
"use strict";

const path = require("path");

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

let V = null;
try {
	V = require(path.join(__dirname, "..", "lib", "receipt-page-verdict.js"));
} catch (err) {
	console.log(`  (lib/receipt-page-verdict.js could not be loaded: ${err.code || err.message})`);
}
// Every check runs; without the module each one fails on its own line.
const call = (fn, ...args) => {
	if (!V || typeof V[fn] !== "function") return { missing: fn };
	try { return V[fn](...args); } catch (err) { return { threw: err.message }; }
};
const code = (page, roster, receipt) => {
	const v = call("pageVerdict", page, roster, receipt);
	return v && v.code ? v.code : v;
};

const DRIVER = "Morgan Ellis";
const ROSTER_INPUT = {
	people: [DRIVER, "Ellis, Morgan", "MORGAN  ELLIS", "Casey Rivera", "Jordan Lee", "Test Driver B", "Sam"],
	trucks: [
		{ unit: "T-1", plate: "ABC1234", vin: "1FUJGLDR0CSBM0001" },
		{ unit: "T-2", plate: "XYZ 7788", vin: "1FUJGLDR0CSBM0002" },
		{ unit: "102", plate: "KLM4455", vin: "1FUJGLDR0CSBM0102" },
	],
	cards: [
		{ last4: "4242", driver: "Casey Rivera" },
		{ last4: "1111", driver: DRIVER },
		{ last4: "1111", driver: "Ellis, Morgan" },
		{ last4: "7777", driver: DRIVER },
		{ last4: "7777", driver: "Jordan Lee" },
	],
};
const roster = call("buildRoster", ROSTER_INPUT);
const RECEIPT = { driver: DRIVER, truck: "T-1", amountCents: 20000, date: "2026-10-12", vendor: "Pilot #123", pageCount: 1 };
const CLEAN = [
	"PILOT TRAVEL CENTER #123",
	"10/12/2026 08:14",
	"DIESEL 50.000 GAL @ 4.000",
	"TOTAL $200.00",
	"CARDHOLDER MORGAN ELLIS",
	"VISA XXXXXXXXXXXX1111",
	"UNIT T-1",
];
const page = (lines, extra = {}) => ({ text: lines.join("\n"), unmapped: false, ...extra });
const withLine = (...more) => page([...CLEAN, ...more]);

section("T8 another person");
{
	check("T8 a clean single-page receipt (his own name, card and truck) is AUTO_RELEASED", code(page(CLEAN), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 another driver's full name", code(withLine("SIGNED CASEY RIVERA"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver as \"LAST, FIRST\"", code(withLine("RIVERA, CASEY"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver with other spacing and case", code(withLine("casey     rivera"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver run together", code(withLine("CASEYRIVERA"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver as initial + surname", code(withLine("C. RIVERA"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver as surname + initial", code(withLine("RIVERA C"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 another driver's first and last name apart on the page (likely)", code(withLine("CASEY", "PUMP 4", "RIVERA"), roster, RECEIPT), "OTHER_PERSON");
	check("T8 a three-word name: full, and last name first", [code(withLine("TEST DRIVER B"), roster, RECEIPT), code(withLine("B, TEST DRIVER"), roster, RECEIPT)], ["OTHER_PERSON", "OTHER_PERSON"]);
	check("T8 his own name as \"LAST, FIRST\", with other spacing, run together, or initial + surname never counts",
		[code(withLine("ELLIS, MORGAN"), roster, RECEIPT), code(withLine("morgan    ellis"), roster, RECEIPT), code(withLine("MORGANELLIS"), roster, RECEIPT), code(withLine("M. ELLIS"), roster, RECEIPT)],
		["AUTO_RELEASED", "AUTO_RELEASED", "AUTO_RELEASED", "AUTO_RELEASED"]);
	check("T8 the roster holding his name in other spellings (\"Ellis, Morgan\", \"MORGAN  ELLIS\") is still him",
		code(withLine("DRIVER: ELLIS, MORGAN"), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 a one-word roster name under 4 letters never matches (\"Sam\")", code(withLine("SAM'S CLUB"), roster, RECEIPT), "AUTO_RELEASED");
	const answer = call("pageVerdict", withLine("CASEY RIVERA"), roster, RECEIPT);
	check("T8 the code is a code: no name, number or excerpt in the answer",
		[answer && answer.code, JSON.stringify(answer).match(/RIVERA|CASEY|200|PILOT/i)], ["OTHER_PERSON", null]);
}

section("T8 another truck");
{
	check("T8 another truck's unit next to a unit label", code(withLine("UNIT T-2"), roster, RECEIPT), "OTHER_TRUCK");
	check("T8 another truck's unit after \"TRUCK #\" / \"VEH NO\"", [code(withLine("TRUCK # 102"), roster, RECEIPT), code(withLine("VEH NO 102"), roster, RECEIPT)], ["OTHER_TRUCK", "OTHER_TRUCK"]);
	check("T8 the same number with no unit label is no truck", code(withLine("ITEM 102 QTY 1"), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 another truck's plate anywhere, in any spacing", [code(withLine("PLATE XYZ-7788"), roster, RECEIPT), code(withLine("XYZ7788"), roster, RECEIPT)], ["OTHER_TRUCK", "OTHER_TRUCK"]);
	check("T8 another truck's VIN anywhere", code(withLine("1FUJGLDR0CSBM0002"), roster, RECEIPT), "OTHER_TRUCK");
	check("T8 his own truck's unit, plate and VIN", code(withLine("UNIT T-1", "PLATE ABC1234", "1FUJGLDR0CSBM0001"), roster, RECEIPT), "AUTO_RELEASED");
}

section("T8 another card");
{
	check("T8 a last-4 next to a card label, seen only on another driver's receipts", code(withLine("VISA XXXX4242"), roster, RECEIPT), "OTHER_CARD");
	check("T8 \"CARD ENDING IN 4242\"", code(withLine("CARD ENDING IN 4242"), roster, RECEIPT), "OTHER_CARD");
	check("T8 the same digits with no card label decide nothing", code(withLine("AUTH 4242"), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 a shared card (seen on his and another driver's receipts) decides nothing", code(withLine("MC XXXX7777"), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 a card nobody's receipts show decides nothing", code(withLine("VISA XXXX9999"), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 card last-4s come from a receipt's stored OCR fields (next to a card label only)",
		call("cardLast4sFromDetails", JSON.stringify([{ label: "Card", value: "VISA ****4242" }, { label: "Auth", value: "1234" }, { label: "Payment", value: "MASTERCARD XXXXXXXXXXXX5555" }])),
		["4242", "5555"]);
}

section("T8 readable or not");
{
	check("T8 text without the amount + date and without the vendor is UNREADABLE", code(page(["THANK YOU", "COME AGAIN"]), roster, RECEIPT), "UNREADABLE");
	check("T8 the amount without the date (and no vendor) is UNREADABLE", code(page(["TOTAL $200.00"]), roster, RECEIPT), "UNREADABLE");
	check("T8 the amount and the date (no vendor) are enough", code(page(["10/12/26", "TOTAL 200.00"]), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 the vendor alone is enough", code(page(["PILOT", "THANK YOU"]), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 the date written \"Oct 12, 2026\" or \"2026-10-12\" matches", [code(page(["Oct 12, 2026", "$200.00"]), roster, RECEIPT), code(page(["2026-10-12", "$200.00"]), roster, RECEIPT)], ["AUTO_RELEASED", "AUTO_RELEASED"]);
	check("T8 any of the page drawn in a font the reader cannot map: UNREADABLE, whatever the text says", code(page(CLEAN, { unmapped: true }), roster, RECEIPT), "UNREADABLE");
	check("T8 a page the reader cut short: UNREADABLE", code(page(CLEAN, { truncated: true }), roster, RECEIPT), "UNREADABLE");
	check("T8 an empty page (a scanned image, no text layer): UNREADABLE", code(page([]), roster, RECEIPT), "UNREADABLE");
}

section("T8 statement shape");
{
	check("T8 any page of a multi-page file is STATEMENT, even with only his name and truck",
		code(page(CLEAN), roster, { ...RECEIPT, pageCount: 3 }), "STATEMENT");
	check("T8 4 dated money lines on one page is STATEMENT",
		code(page([...CLEAN, "10/12/2026 TOLL 1 $4.50", "10/12/2026 TOLL 2 $4.50", "10/12/2026 TOLL 3 $4.50", "10/12/2026 TOLL 4 $4.50"]), roster, RECEIPT), "STATEMENT");
	check("T8 (R3) 2 dated money lines on different dates is STATEMENT",
		code(page([...CLEAN, "10/11/2026 TOLL A $4.50", "10/12/2026 TOLL B $6.25"]), roster, RECEIPT), "STATEMENT");
	check("T8 (R3) 2 dated money lines on the same date are not",
		code(page([...CLEAN, "10/12/2026 TOLL A $4.50", "10/12/2026 TOLL B $6.25"]), roster, RECEIPT), "AUTO_RELEASED");
	check("T8 short dates (\"10/11\") count for the shape", code(page([...CLEAN, "10/11 TOLL A 4.50", "10/12 TOLL B 6.25"]), roster, RECEIPT), "STATEMENT");
	const v = call("pageVerdict", page([...CLEAN, "RIVERA, CASEY"]), roster, { ...RECEIPT, pageCount: 2 });
	check("T8 every code that applies is kept, the most severe first", [v && v.code, v && v.reasons], ["OTHER_PERSON", ["OTHER_PERSON", "STATEMENT"]]);
}

section("T13 bounded on long whitespace runs");
{
	const run = " ".repeat(300_000);
	const pages = Array.from({ length: 6 }, (_, i) => page([
		`PILOT${run}#123`,
		`10/12/2026${run}TOTAL${run}$200.00`,
		`${"1/".repeat(20_000)}1`,
		`${"$".repeat(50_000)}${"9".repeat(50_000)}.00`,
		`${"JAN ".repeat(30_000)}`,
		`CASEY${"\t".repeat(200_000)}RIVERA`,
		`${"X".repeat(100_000)}4242 CARD`,
	]));
	const times = [];
	const codes = [];
	for (const p of pages) {
		const t0 = process.hrtime.bigint();
		codes.push(code(p, roster, { ...RECEIPT, pageCount: 6 }));
		times.push(Number(process.hrtime.bigint() - t0) / 1e6);
	}
	check("T13 every page of a 6-page file still gets a code (STATEMENT at least)", codes.every((c) => typeof c === "string" && c !== "AUTO_RELEASED"), true);
	check("T13 each verdict inside 400 ms, all six inside 1.5 s, each one a code",
		[times.every((t) => t < 400), times.reduce((a, b) => a + b, 0) < 1500, codes.every((c) => typeof c === "string")], [true, true, true]);
	const huge = { text: "A".repeat(300_000), unmapped: false };
	const t0 = process.hrtime.bigint();
	const big = code(huge, roster, RECEIPT);
	check("T13 a page past the reading cap is UNREADABLE and still quick", [big, Number(process.hrtime.bigint() - t0) / 1e6 < 400], ["UNREADABLE", true]);
}

section("the release rule");
{
	const H = roster && roster.hash;
	const SHA = "a".repeat(64);
	const row = (page_, extra) => ({ page: page_, file_sha256: SHA, roster_hash: H, verdict_code: "STATEMENT", reason_codes: "STATEMENT", mark: "", mark_codes: "", mark_lapsed_at: "", ...extra });
	check("the roster has a hash, and the same people in another order give the same one",
		[typeof H === "string" && H.length === 64, (call("buildRoster", { ...ROSTER_INPUT, people: [...ROSTER_INPUT.people].reverse() }) || {}).hash === H], [true, true]);
	check("a new name on the roster changes the hash", (call("buildRoster", { ...ROSTER_INPUT, people: [...ROSTER_INPUT.people, "Avery Stone"] }) || {}).hash !== H, true);
	check("AUTO_RELEASED with no mark is released; STATEMENT with no mark is not",
		call("releasedPages", [row(1, { verdict_code: "AUTO_RELEASED", reason_codes: "AUTO_RELEASED" }), row(2)], { sha256: SHA, rosterHash: H }), [1]);
	check("a Super Admin's \"released\" mark releases a statement page; \"office\" withholds an AUTO_RELEASED one",
		call("releasedPages", [row(1, { mark: "released" }), row(2, { verdict_code: "AUTO_RELEASED", reason_codes: "AUTO_RELEASED", mark: "office" })], { sha256: SHA, rosterHash: H }), [1]);
	check("a verdict under another roster, or for another file, releases nothing (withheld while the check runs)",
		[call("releasedPages", [row(1, { mark: "released" })], { sha256: SHA, rosterHash: "b".repeat(64) }), call("releasedPages", [row(1, { mark: "released" })], { sha256: "c".repeat(64), rosterHash: H })], [[], []]);
	check("\"Release anyway\": a released mark covers only the OTHER_* codes it acknowledged",
		call("releasedPages", [
			row(1, { verdict_code: "OTHER_PERSON", reason_codes: "OTHER_PERSON,STATEMENT", mark: "released", mark_codes: "OTHER_PERSON" }),
			row(2, { verdict_code: "OTHER_PERSON", reason_codes: "OTHER_PERSON,OTHER_TRUCK,STATEMENT", mark: "released", mark_codes: "OTHER_PERSON" }),
			row(3, { verdict_code: "OTHER_CARD", reason_codes: "OTHER_CARD", mark: "released", mark_codes: "" }),
		], { sha256: SHA, rosterHash: H }), [1]);
	check("a lapsed mark withholds until the page is marked again",
		call("releasedPages", [row(1, { mark: "released", mark_lapsed_at: "2026-10-28T08:00:00.000Z" })], { sha256: SHA, rosterHash: H }), []);
	check("a mark lapses when a later verdict finds an OTHER_* code it did not acknowledge, and only then",
		[call("markLapses", row(1, { mark: "released" }), ["OTHER_PERSON", "STATEMENT"]), call("markLapses", row(1, { mark: "released", mark_codes: "OTHER_PERSON" }), ["OTHER_PERSON"]),
			call("markLapses", row(1, { mark: "office" }), ["OTHER_PERSON"]), call("markLapses", row(1, { mark: "released" }), ["STATEMENT"])],
		[true, false, false, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
