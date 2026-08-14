#!/usr/bin/env node
/**
 * Tests for the EDITABLE INVOICE OVERRIDES — parseInvoiceOverrides(),
 * isoToMdy() and safeAttachmentName() in server.js.
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-truck-retirement.js and
 * test-investor-expense-scoping.js: server.js opens SQLite, reads a service
 * account key and starts listening on import. Extracting the text keeps this
 * honest in the way that matters — it exercises THE CODE THAT SHIPS, not a copy
 * that can quietly drift. Every extraction asserts the symbol is found exactly
 * once, so a rename or a second definition fails the run loudly rather than
 * silently testing nothing.
 *
 * THE PROPERTY UNDER TEST is not "bad input is rejected". It is that THREE
 * SPECIFIC LANDMINES stay defused, each of which was reproduced against the real
 * lib/broker-invoice.js before this file existed:
 *
 *   §2/§3 ORDERING. brokerInvoice.parseMoney() is a MANGLER, not a validator —
 *      it strips everything outside [0-9.\-] and parseFloats the remains:
 *          parseMoney("12abc34") === 1234      formatMoney -> "$1,234.00"
 *          parseMoney("-500")    === -500      formatMoney -> "$-500.00"
 *          parseMoney("1e9")     === 19
 *      Every one of those passes a naive `> 0` check and prints a plausible
 *      invoice. The defence is that a strict FORMAT GATE runs BEFORE parseMoney
 *      ever sees the string. Mutant M2 reorders exactly that and must be caught,
 *      because a test that only checks "12abc34 is rejected" would pass against
 *      a gate applied to the already-mangled value.
 *
 *   §4 THE OFF-BY-ONE. brokerInvoice.formatDate("2026-08-14") returns
 *      "08/13/2026" — its last resort is `new Date(raw)` (UTC midnight)
 *      rendered through mdy() in America/Chicago. `<input type="date">` emits
 *      exactly that shape, so reusing formatDate would date EVERY edited
 *      invoice one day early. §4 pins isoToMdy against the trap by asserting the
 *      two DISAGREE on the same input — a bare `=== "08/14/2026"` would still
 *      pass on a day when the trap happened to be harmless.
 *
 *   §5 OMITTED vs EMPTY. undefined/null mean "the client didn't send the key →
 *      derive it"; "" means "the dispatcher CLEARED it". Conflating them
 *      silently restamps a value somebody deliberately deleted, which is the
 *      POST /api/invoices/manual payeeAddress reasoning verbatim.
 *
 * Run: node scripts/test-invoice-overrides.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const brokerInvoice = require(path.join(__dirname, "..", "lib", "broker-invoice.js"));

// ---------------------------------------------------------------- extraction
function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	}
	const start = src.indexOf(needle) + 1;
	let depth = 0;
	for (let j = src.indexOf("{", start); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// The regexes and the two bounds are the CONTRACT, so they are lifted from the
// shipped source too — a widened charset or a raised ceiling must fail this run,
// not be silently re-declared here.
function extractConst(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 declaration of ${name} in server.js, found ${hits}`);
	}
	const start = src.indexOf(needle) + 1;
	const end = src.indexOf("\n", start);
	return src.slice(start, end);
}

// Extract a whole route registration BY LINE RANGE — from its `app.post(` /
// `app.get(` line to the `);` that closes it at column 0.
//
// Needed because the interesting assertions about a route are NEGATIVE ("this
// handler performs no Sheets write"), and a negative scanned over the whole
// 33k-line file is not an assertion about the route at all — it is an assertion
// about the file, which some unrelated handler will falsify.
function extractRouteByLines(src, needle) {
	const lines = src.split("\n");
	const hits = lines.reduce((n, l) => n + (l.includes(needle) ? 1 : 0), 0);
	if (hits !== 1) throw new Error(`expected exactly 1 line containing ${needle}, found ${hits}`);
	let s = lines.findIndex((l) => l.includes(needle));
	while (s > 0 && !/^app\.(post|get|put|delete|use)\(/.test(lines[s])) s--;
	if (!/^app\.(post|get|put|delete|use)\(/.test(lines[s])) throw new Error(`no route registration above ${needle}`);
	let e = s;
	while (e < lines.length && lines[e] !== ");") e++;
	if (e >= lines.length) throw new Error(`unterminated route registration for ${needle}`);
	return { text: lines.slice(s, e + 1).join("\n"), startLine: s + 1, endLine: e + 1 };
}

// Is `needle`'s occurrence inside a `finally { … }` block? Brace-matched, not
// proximity-guessed — the whole point of the T2 finding was that a proximity
// regex passes when the statement has been moved OUT of the block.
function insideFinallyBlock(text, needle) {
	const decIdx = text.indexOf(needle);
	if (decIdx < 0) return false;
	let searchFrom = 0;
	for (;;) {
		const fIdx = text.indexOf("finally {", searchFrom);
		if (fIdx < 0) return false;
		const open = text.indexOf("{", fIdx);
		let depth = 0;
		let close = -1;
		for (let j = open; j < text.length; j++) {
			if (text[j] === "{") depth++;
			else if (text[j] === "}") { depth--; if (depth === 0) { close = j; break; } }
		}
		if (close < 0) return false;
		if (decIdx > open && decIdx < close) return true;
		searchFrom = fIdx + 1;
	}
}

const FNS = [
	"sanitizeEvidenceText",
	"isoToMdy",
	"mdyToIso",
	"isRealCalendarDate",
	"safeAttachmentName",
	"parseInvoiceOverrides",
];
// The predicates §7 asserts and §9 re-checks against planted violations. Named
// so the two sections cannot drift, and so a wrong predicate is provable rather
// than quietly permissive.
const APPROVE_NEEDLE = '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],';
const PREVIEW_NEEDLE = '"/api/loads/:loadId/invoice-preview",';
// Every way this codebase writes to a Google Sheet. `values.get` is the only
// Sheets verb the approve route is allowed, and the preview route may use none.
const SHEET_WRITE_VERBS = ["values.update", "values.append", "values.batchUpdate", "values.clear", "batchUpdate(", "upsertByKey"];
const CHECKS = {
	// Owner decision #2: a corrected total is INVOICE-ONLY and must never restate
	// revenue, driver pay, investor payouts or the P&L. The honest form of that
	// claim is "this handler issues no Sheets write at all".
	approveWritesNoSheet: (s) => {
		const route = extractRouteByLines(s, APPROVE_NEEDLE).text;
		if (SHEET_WRITE_VERBS.some((v) => route.includes(v))) return false;
		return (route.match(/values\.get/g) || []).length === 1;
	},
	previewTouchesNoSheet: (s) => {
		const route = extractRouteByLines(s, PREVIEW_NEEDLE).text;
		return !SHEET_WRITE_VERBS.concat("values.get").some((v) => route.includes(v));
	},
	decrementInFinally: (s) => {
		const route = extractRouteByLines(s, PREVIEW_NEEDLE).text;
		if ((route.match(/invoicePreviewInflight--/g) || []).length !== 1) return false;
		return insideFinallyBlock(route, "invoicePreviewInflight--");
	},
};

const CONSTS = [
	"EVIDENCE_TEXT_STRIP",
	"INVOICE_TOTAL_FORMAT_RE",
	"INVOICE_TOTAL_MAX",
	"INVOICE_TOTAL_MIN",
	"INVOICE_ID_RE",
	"INVOICE_REF_RE",
	"INVOICE_FIELD_SCAN_MAX",
	"INVOICE_YEAR_MIN",
	"INVOICE_YEAR_MAX",
];

// brokerInvoice is the ONLY injected dependency. It is the real library — the
// landmines above live inside it, so stubbing it would test a world in which
// they do not exist.
function loadShipped(mutate) {
	const src = mutate ? mutate(SRC) : SRC;
	const body =
		CONSTS.map((c) => extractConst(src, c)).join("\n") +
		"\n" +
		FNS.map((f) => extractFn(src, f)).join("\n") +
		`\nreturn { ${FNS.join(", ")}, ${CONSTS.join(", ")} };`;
	return new Function("brokerInvoice", body)(brokerInvoice);
}

const M = loadShipped(null);
const { isoToMdy, mdyToIso, safeAttachmentName, parseInvoiceOverrides, INVOICE_TOTAL_MAX } = M;

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// Shorthands. `rej` asserts BOTH the refusal and the code — the codes are the
// wire contract the client branches on, so a right refusal under the wrong code
// is a failure.
function rej(body, code, label) {
	const r = parseInvoiceOverrides(body);
	eq({ ok: r.ok, code: r.code }, { ok: false, code }, label);
}
function acc(body, label) {
	const r = parseInvoiceOverrides(body);
	if (r.ok) { pass++; return r; }
	failures.push(`${label}\n      expected accepted\n      actual   ${r.code}: ${r.error}`);
	return r;
}

// ================================================== §0 THE TRAPS ARE STILL REAL
// The expectations below are only meaningful while the landmines they guard
// against exist. Assert them first, against the real library, so this file can
// never pass by testing a world that has changed underneath it.
section("0. The landmines are real (control assertions against lib/broker-invoice.js)");
{
	eq(brokerInvoice.parseMoney("12abc34"), 1234, "§0 parseMoney manges '12abc34' into 1234");
	eq(brokerInvoice.formatMoney(brokerInvoice.parseMoney("12abc34")), "$1,234.00",
		"§0 …and formatMoney prints it as a plausible invoice figure");
	eq(brokerInvoice.parseMoney("-500"), -500, "§0 parseMoney accepts a NEGATIVE amount");
	eq(brokerInvoice.parseMoney("1e9"), 19, "§0 parseMoney reads '1e9' as 19");
	eq(brokerInvoice.formatMoney(0.001), "$0.00",
		"§0 formatMoney renders 0.001 as $0.00 — positive, yet prints zero (why the floor is 0.01, not > 0)");
	eq(brokerInvoice.formatDate("2026-08-14"), "08/13/2026",
		"§0 formatDate LOSES A DAY on an ISO date (the <input type=\"date\"> shape)");
}

// ============================================== §1 MONEY — THE GATE RUNS FIRST
section("1. Money format gate — shape is judged BEFORE parseMoney");
{
	// Rejected by the FORMAT GATE. Each of these parses to something positive
	// and plausible if parseMoney is allowed to see it first.
	for (const v of ["12abc34", "-500", "1e9", "1.2.3", "0.001", "", "  ", "1,80.00", "$", "abc", "3,000.000", "+500", "1 800"]) {
		rej({ total: v }, "INVOICE_TOTAL_INVALID", `§1 rejects total ${JSON.stringify(v)}`);
	}
	// Accepted, with the parsed value pinned — the gate must not also mangle.
	for (const [v, n] of [["1,800.00", 1800], ["3000", 3000], ["$3,000.00", 3000], ["0.01", 0.01],
		["$ 1,234.56", 1234.56], ["999999", 999999], [1800, 1800], [1800.5, 1800.5]]) {
		const r = acc({ total: v }, `§1 accepts total ${JSON.stringify(v)}`);
		if (r.ok) eq(r.values.total, n, `§1 total ${JSON.stringify(v)} parses to ${n}`);
	}
	// A number is accepted as a type (the contract is string|number) but is still
	// gated on its printed shape — a Number carries no formatting privilege.
	rej({ total: 0.001 }, "INVOICE_TOTAL_INVALID", "§1 the NUMBER 0.001 is gated the same as the string");
	rej({ total: 1e9 }, "INVOICE_TOTAL_OUT_OF_RANGE", "§1 the NUMBER 1e9 prints as 1000000000 → out of range");
	rej({ total: -500 }, "INVOICE_TOTAL_INVALID", "§1 the NUMBER -500 is refused");
	rej({ total: NaN }, "INVOICE_TOTAL_INVALID", "§1 NaN is refused");
	rej({ total: Infinity }, "INVOICE_TOTAL_INVALID", "§1 Infinity is refused");
	// Arrays coerce disarmingly well: String([1800]) === "1800". The typeof guard
	// is the only thing between that and a billed figure.
	rej({ total: [1800] }, "INVOICE_TOTAL_INVALID", "§1 an ARRAY does not coerce its way in");
	rej({ total: { amount: 1800 } }, "INVOICE_TOTAL_INVALID", "§1 an object is refused");
	rej({ total: true }, "INVOICE_TOTAL_INVALID", "§1 a boolean is refused");
}

section("2. Money bounds — floor $0.01, ceiling $1,000,000");
{
	eq(INVOICE_TOTAL_MAX, 1000000, "§2 the ceiling matches sanitizeManualInvoiceRows' $1,000,000");
	rej({ total: "0" }, "INVOICE_TOTAL_OUT_OF_RANGE", "§2 zero is not a settleable invoice");
	rej({ total: "0.00" }, "INVOICE_TOTAL_OUT_OF_RANGE", "§2 $0.00 is refused — the whole point of the guard");
	rej({ total: "1000000.01" }, "INVOICE_TOTAL_OUT_OF_RANGE", "§2 one cent over the ceiling is refused");
	rej({ total: "9,999,999.00" }, "INVOICE_TOTAL_OUT_OF_RANGE", "§2 a typo'd extra digit is refused");
	eq(acc({ total: "1000000" }, "§2 exactly the ceiling is accepted").values.total, 1000000,
		"§2 …and parses to 1000000");
	eq(acc({ total: "0.01" }, "§2 exactly the floor is accepted").values.total, 0.01,
		"§2 …and parses to 0.01");

	// ⚠️ THE FLOOR IS ASSERTED STRUCTURALLY, and honestly so. Behaviourally,
	// `>= 0.01` and `> 0` are INDISTINGUISHABLE once the format gate caps the
	// input at two decimals and round2 snaps to cents: everything in (0, 0.01)
	// arrives as either 0 or 0.01. The floor is the SECOND line of defence — it
	// is what stops formatMoney(0.001) === "$0.00" reaching a broker on the day
	// somebody widens the gate to three decimals. A behavioural mutant cannot
	// reach it, so the source is pinned instead.
	ok(/const INVOICE_TOTAL_MIN = 0\.01;/.test(SRC),
		"§2 INVOICE_TOTAL_MIN is 0.01 in the shipped source");
	ok(/!\(n >= INVOICE_TOTAL_MIN\)/.test(SRC),
		"§2 the comparison is `>= INVOICE_TOTAL_MIN`, never a bare `> 0`");
	// And the ordering itself, textually: the gate must appear before the parse.
	ok(SRC.indexOf("INVOICE_TOTAL_FORMAT_RE.test(raw)") < SRC.indexOf("brokerInvoice.parseMoney(raw)"),
		"§2 the format gate is applied BEFORE parseMoney in the shipped source");
}

// ================================================== §3 DATES — STRING SURGERY
section("3. Dates — string surgery, never new Date()");
{
	// THE REGRESSION. Both halves are required: the value, and the fact that it
	// DISAGREES with the trap on the same input.
	eq(isoToMdy("2026-08-14"), "08/14/2026", "§3 isoToMdy('2026-08-14') === '08/14/2026'");
	ok(isoToMdy("2026-08-14") !== brokerInvoice.formatDate("2026-08-14"),
		"§3 isoToMdy DISAGREES with brokerInvoice.formatDate on the same ISO string (the off-by-one)");
	eq(brokerInvoice.formatDate(isoToMdy("2026-08-14")), "08/14/2026",
		"§3 the MM/DD/YYYY we hand buildInvoiceHtml survives its own formatDate() re-run");

	// Day boundaries, where a Date-based conversion goes wrong first.
	eq(isoToMdy("2026-01-01"), "01/01/2026", "§3 Jan 1 does not fall into the previous year");
	eq(isoToMdy("2026-12-31"), "12/31/2026", "§3 Dec 31 does not roll into the next");
	eq(isoToMdy("2026-03-08"), "03/08/2026", "§3 a US DST-transition day is unaffected");
	eq(isoToMdy("2024-02-29"), "02/29/2024", "§3 a leap day survives");
	eq(isoToMdy("08/14/2026"), "", "§3 isoToMdy refuses a value that is already MM/DD/YYYY");
	eq(isoToMdy(""), "", "§3 isoToMdy('') === ''");
	eq(isoToMdy(null), "", "§3 isoToMdy(null) === ''");

	// Round trip, for the *Iso echo fields the modal seeds its date inputs from.
	eq(mdyToIso("08/14/2026"), "2026-08-14", "§3 mdyToIso round-trips");
	eq(mdyToIso(isoToMdy("2026-08-14")), "2026-08-14", "§3 iso → mdy → iso is the identity");
	eq(mdyToIso("8/4/2026"), "2026-08-04", "§3 mdyToIso zero-pads a single-digit month/day");
	eq(mdyToIso(""), "", "§3 mdyToIso('') === '' (a load with no delivery date)");
	eq(mdyToIso("not a date"), "", "§3 mdyToIso refuses junk rather than inventing a day");

	// Calendar validity. The regex alone is not enough: "2026-02-31" matches it
	// perfectly, and a Date-based check would ROLL IT FORWARD to March 3 and
	// print a date the dispatcher never chose.
	for (const v of ["2026-02-31", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-32", "2026-01-00", "2025-02-29"]) {
		rej({ invoiceDate: v }, "INVOICE_DATE_INVALID", `§3 rejects the non-day ${v}`);
	}
	eq(acc({ invoiceDate: "2024-02-29" }, "§3 a real leap day is accepted").values.invoiceDate, "02/29/2024",
		"§3 …and converts by string surgery");
	// Shape, not just calendar.
	for (const v of ["2026-8-14", "26-08-14", "2026/08/14", "08/14/2026", "2026-08-14T00:00:00Z", "2026-08-142", "tomorrow"]) {
		rej({ invoiceDate: v }, "INVOICE_DATE_INVALID", `§3 rejects the shape ${JSON.stringify(v)}`);
	}
	// ⚠️ Year 0000 matches \d{4} perfectly. `<input type="date">` emits it from a
	// mistyped keystroke, and "01/14/0000" on a broker's invoice is a document
	// nobody can age. Refused rather than clamped — a correction the dispatcher
	// can see beats a silently rewritten year.
	for (const v of ["0000-01-14", "0001-06-01", "1999-12-31", "2101-01-01", "9999-01-01"]) {
		rej({ invoiceDate: v }, "INVOICE_DATE_INVALID", `§3 rejects the out-of-range year ${v}`);
	}
	eq(acc({ invoiceDate: "2000-01-01" }, "§3 the lower year bound is accepted").values.invoiceDate, "01/01/2000",
		"§3 …and converts correctly");
	eq(acc({ invoiceDate: "2100-12-31" }, "§3 the upper year bound is accepted").values.invoiceDate, "12/31/2100",
		"§3 …and converts correctly");
	rej({ deliveryDate: "0000-01-14" }, "DELIVERY_DATE_INVALID", "§3 deliveryDate takes the same year bound");
	// deliveryDate takes the identical rules under its own code.
	rej({ deliveryDate: "2026-02-31" }, "DELIVERY_DATE_INVALID", "§3 deliveryDate uses the same calendar check");
	eq(acc({ deliveryDate: "2026-08-01" }, "§3 deliveryDate accepts a real day").values.deliveryDate, "08/01/2026",
		"§3 …converted the same way");
}

// ============================================ §4 OMITTED vs EMPTY vs SUPPLIED
section("4. Omitted vs empty — the manual-invoice precedent, field by field");
{
	// Omitted entirely → the server derives. `has` must be false so the caller's
	// `ov.has.x ? … : derived` falls to the derived branch.
	const none = acc({}, "§4 an empty body is valid (nothing overridden)");
	for (const f of ["invoiceId", "invoiceDate", "billToName", "recipientEmail", "brokerName",
		"orderNumber", "poNumber", "deliveryDate", "total", "moveNumber"]) {
		eq(none.has[f], undefined, `§4 ${f}: omitted → has.${f} is falsy → server derives it`);
	}

	// Explicit undefined / null are ALSO "not supplied" — the payeeAddress rule.
	for (const f of ["invoiceId", "invoiceDate", "billToName", "recipientEmail", "brokerName",
		"orderNumber", "poNumber", "deliveryDate", "total", "moveNumber"]) {
		const u = acc({ [f]: undefined }, `§4 ${f}: undefined is accepted as "not supplied"`);
		eq(u.has[f], undefined, `§4 ${f}: undefined → has.${f} falsy`);
		const n = acc({ [f]: null }, `§4 ${f}: null is accepted as "not supplied"`);
		eq(n.has[f], undefined, `§4 ${f}: null → has.${f} falsy`);
	}

	// "" REJECTED — clearing these is not a thing the invoice can express.
	// (total specifically: falling back to the derived rate would silently
	// restamp the number the dispatcher just deleted.)
	rej({ invoiceId: "" }, "INVOICE_ID_INVALID", "§4 invoiceId: '' is rejected");
	rej({ invoiceDate: "" }, "INVOICE_DATE_INVALID", "§4 invoiceDate: '' is rejected");
	rej({ recipientEmail: "" }, "RECIPIENT_INVALID", "§4 recipientEmail: '' is rejected");
	rej({ orderNumber: "" }, "ORDER_NUMBER_INVALID", "§4 orderNumber: '' is rejected (an attachment named '.pdf')");
	rej({ total: "" }, "INVOICE_TOTAL_INVALID", "§4 total: '' is rejected, NOT silently restored");
	// Whitespace-only is the same clear wearing a disguise.
	rej({ invoiceId: "   " }, "INVOICE_ID_INVALID", "§4 invoiceId: whitespace-only is rejected");
	rej({ orderNumber: " \t " }, "ORDER_NUMBER_INVALID", "§4 orderNumber: whitespace-only is rejected");

	// "" ALLOWED — all four have fallback rendering in the template, so an empty
	// value is a legitimate choice and must be HONOURED (has = true), not
	// quietly replaced by the extracted one.
	for (const f of ["brokerName", "billToName", "poNumber", "deliveryDate", "moveNumber"]) {
		const r = acc({ [f]: "" }, `§4 ${f}: '' is allowed`);
		eq(r.has[f], true, `§4 ${f}: '' is HONOURED (has.${f} === true), not treated as omitted`);
		eq(r.values[f], "", `§4 ${f}: '' comes through as ''`);
	}
	// And whitespace-only collapses to "" for those, rather than printing a space.
	eq(acc({ brokerName: "   " }, "§4 brokerName: whitespace-only is allowed").values.brokerName, "",
		"§4 brokerName: whitespace-only normalises to ''");
}

// ================================================= §5 CHARSETS + ERROR CODES
section("5. Field charsets and their wire codes");
{
	// invoiceId — the printed number, also a filename component in downstream use.
	for (const v of ["08142026-1", "INV-M-2026W31-01", "A1", "a_b.c/d-1"]) {
		eq(acc({ invoiceId: v }, `§5 invoiceId accepts ${JSON.stringify(v)}`).values.invoiceId, v,
			`§5 invoiceId ${JSON.stringify(v)} is unchanged`);
	}
	for (const v of ["-leading", ".hidden", "has space", "semi;colon", "quote\"", "<b>", "a\\b", "#hash", "café"]) {
		rej({ invoiceId: v }, "INVOICE_ID_INVALID", `§5 invoiceId rejects ${JSON.stringify(v)}`);
	}
	// ⚠️ OVER-LENGTH IS A REFUSAL, NOT A TRUNCATION. sanitizing to 40 and then
	// applying a {0,39} regex silently cuts a 45-character number down to one
	// that matches — the dispatcher types a number, the modal accepts it, and
	// the PDF prints a different one. Caught by mutant M11.
	eq(acc({ invoiceId: "A".repeat(40) }, "§5 invoiceId of exactly 40 chars is accepted").values.invoiceId,
		"A".repeat(40), "§5 …unchanged at the limit");
	rej({ invoiceId: "A".repeat(41) }, "INVOICE_ID_INVALID", "§5 invoiceId over 40 chars is rejected, not truncated into validity");
	rej({ invoiceId: "A".repeat(300) }, "INVOICE_ID_INVALID", "§5 invoiceId far over the scan bound is still rejected");
	rej({ orderNumber: "9".repeat(41) }, "ORDER_NUMBER_INVALID", "§5 orderNumber over 40 chars is rejected, not truncated");
	rej({ poNumber: "9".repeat(41) }, "PO_NUMBER_INVALID", "§5 poNumber over 40 chars is rejected, not truncated");

	// orderNumber / poNumber share a charset that additionally allows space and #
	// (real broker refs read "SHP2607-A3BJ112", "PO # 4471").
	for (const v of ["563367203", "SHP2607-A3BJ112", "PO 4471", "A#1"]) {
		eq(acc({ orderNumber: v }, `§5 orderNumber accepts ${JSON.stringify(v)}`).values.orderNumber, v,
			`§5 orderNumber ${JSON.stringify(v)} is unchanged`);
	}
	for (const v of ["-500", "a;b", "a<b>", "a\"b", "a|b", "a*b"]) {
		rej({ orderNumber: v }, "ORDER_NUMBER_INVALID", `§5 orderNumber rejects ${JSON.stringify(v)}`);
		rej({ poNumber: v }, "PO_NUMBER_INVALID", `§5 poNumber rejects ${JSON.stringify(v)}`);
	}
	// A CR in any of these forges an audit line and a MIME header; it is stripped
	// by sanitizeEvidenceText before the charset is even consulted.
	eq(acc({ brokerName: "Acme\r\nBcc: evil@example.com" }, "§5 brokerName with CRLF is accepted after stripping")
		.values.brokerName.includes("\n"), false, "§5 …and carries no newline");
	eq(acc({ billToName: "A‮B" }, "§5 billToName with a BIDI override is accepted after stripping")
		.values.billToName, "A B", "§5 …with the override replaced, not preserved");

	// recipientEmail — the one deliberate behaviour change: invalid is now
	// REJECTED, where it used to be silently ignored.
	for (const v of ["nope", "a@b", "a b@c.com", "@example.com", "x@example", "javascript:alert(1)"]) {
		rej({ recipientEmail: v }, "RECIPIENT_INVALID", `§5 recipientEmail rejects ${JSON.stringify(v)}`);
	}
	eq(acc({ recipientEmail: "QPinvoicesUSA@bisontransport.com" }, "§5 a real AP inbox is accepted")
		.values.recipientEmail, "QPinvoicesUSA@bisontransport.com", "§5 …case preserved");
	eq(acc({ recipientEmail: " quickpay@megacorplogistics.com " }, "§5 a padded address is accepted")
		.values.recipientEmail, "quickpay@megacorplogistics.com", "§5 …and trimmed");

	// The first failure wins and names its field, so the client can focus it.
	const multi = parseInvoiceOverrides({ invoiceId: "", total: "12abc34" });
	eq({ ok: multi.ok, field: multi.field }, { ok: false, field: "invoiceId" },
		"§5 a refusal names the offending field");
	// A refused body yields NO values at all — a partially-populated result is how
	// half a rejected edit reaches an invoice.
	eq(multi.values, {}, "§5 a refusal returns no values");
	eq(multi.has, {}, "§5 a refusal returns no `has` flags");
	ok(typeof multi.error === "string" && multi.error.length > 0, "§5 a refusal carries user-facing copy");

	// Non-object bodies must not throw — express hands us whatever was sent.
	for (const b of [null, undefined, "", "a string", 42, []]) {
		ok(parseInvoiceOverrides(b).ok, `§5 a ${JSON.stringify(b)} body is treated as "nothing supplied"`);
	}
}

// ================================================= §6 ATTACHMENT FILENAMES
section("6. safeAttachmentName — a filename built from attacker-supplied text");
{
	eq(safeAttachmentName("Bison Transport"), "Bison Transport", "§6 an ordinary name is unchanged");
	// CRLF: forges MIME headers in the attachment disposition.
	eq(safeAttachmentName("Acme\r\nContent-Type: text/html"), "Acme Content-Type text html",
		"§6 CRLF is stripped and the separators neutralised");
	ok(!/[\r\n]/.test(safeAttachmentName("a\r\nb")), "§6 no CR or LF survives");
	// Traversal. Every leading dot, not one — "..." is ".." wearing a decoy.
	eq(safeAttachmentName(".."), "Invoice", "§6 '..' collapses to the fallback");
	eq(safeAttachmentName("...."), "Invoice", "§6 '....' collapses to the fallback");
	eq(safeAttachmentName("../../etc/passwd"), "etc passwd", "§6 a traversal path keeps no separators and no leading dots");
	eq(safeAttachmentName(".hidden"), "hidden", "§6 a leading dot is stripped");
	ok(!safeAttachmentName("../../x").startsWith("."), "§6 the result never starts with a dot");
	// Path separators, both flavours, plus the Windows-reserved set.
	eq(safeAttachmentName("a/b\\c"), "a b c", "§6 / and \\ become spaces");
	eq(safeAttachmentName('a:b*c?d"e<f>g|h'), "a b c d e f g h", "§6 the reserved set is neutralised");
	ok(!/[\\/:*?"<>|]/.test(safeAttachmentName('x/y\\z:*?"<>|')), "§6 no separator or reserved char survives");
	// Length, counted in CODEPOINTS.
	eq(safeAttachmentName("A".repeat(200)).length, 80, "§6 an over-long name is capped at 80");
	eq(safeAttachmentName("A".repeat(200), 40).length, 40, "§6 …at the caller's max when given one");
	// Surrogate pairs: a UTF-16 slice would leave a lone surrogate in the header.
	const emoji = "🚚".repeat(10); // 10 codepoints, 20 UTF-16 units
	eq(Array.from(safeAttachmentName(emoji, 5)).length, 5, "§6 the cap counts CODEPOINTS, not UTF-16 units");
	ok(!/[\uD800-\uDFFF]/.test(safeAttachmentName(emoji, 5).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
		"§6 no lone surrogate survives the cap");
	// Empty and fallback behaviour — the broker half passes "" deliberately.
	eq(safeAttachmentName(""), "Invoice", "§6 '' falls back to 'Invoice'");
	eq(safeAttachmentName(null), "Invoice", "§6 null falls back to 'Invoice'");
	eq(safeAttachmentName("   "), "Invoice", "§6 whitespace-only falls back to 'Invoice'");
	eq(safeAttachmentName("///"), "Invoice", "§6 separators-only falls back to 'Invoice'");
	eq(safeAttachmentName("", 40, ""), "", "§6 an explicit '' fallback is honoured — the non-Bison filename needs it");
	// The real shapes, end to end.
	eq(`${safeAttachmentName("563367203", 40)}.pdf`, "563367203.pdf", "§6 a rate-con attachment name is unchanged");
	eq(`${safeAttachmentName("../../../etc/passwd", 40)}.pdf`, "etc passwd.pdf", "§6 …and a hostile one is inert");
}

// ===================================================== §7 THE SHIPPED WIRING
// Textual, and necessarily so: no value-based test can notice that a route
// stopped CALLING the validator, or that the sequence stopped being consumed.
section("7. Wiring — the guarantees that no value can prove");
{
	ok(/const ov = parseInvoiceOverrides\(req\.body\);/.test(SRC),
		"§7 the routes call the shared validator (never a second copy of the rules)");
	eq(SRC.split("parseInvoiceOverrides(req.body)").length - 1, 2,
		"§7 exactly TWO callers — draft-invoice and invoice-preview");
	// ⚠️ The sequence must be consumed on every real approve, override or not:
	// the common path is confirming the peeked number verbatim, and gating the
	// mint on "no override was sent" would reissue it on the next draft.
	ok(/const mintedInvoiceId = dryRun \? peekInvoiceNumber\(today\) : nextInvoiceNumber\(today\);/.test(SRC),
		"§7 the mint is UNCONDITIONAL on a real approve — not gated on ov.has.invoiceId");
	ok(/const invoiceId = ov\.has\.invoiceId \? ov\.values\.invoiceId : mintedInvoiceId;/.test(SRC),
		"§7 …and the override is only what gets PRINTED");
	// ⚠️ isBison is derived from the broker EMAIL, never the editable name.
	ok(/const isBison = brokerInvoice\.isBisonLoad\(\{ email: brokerEmail \}\);/.test(SRC),
		"§7 isBison comes from the broker email on the approve path");
	const NAME_DERIVED_RE = /isBisonLoad\(\{ *email: *(eff)?[bB]rokerName/;
	ok(!NAME_DERIVED_RE.test(SRC), "§7 isBison is never recomputed from a broker NAME");
	// …and that negative is not vacuous: plant the forbidden pattern and confirm
	// the guard above would actually catch it. A `!regex.test()` assertion passes
	// just as happily when the regex is simply wrong.
	ok(NAME_DERIVED_RE.test("const isBison = brokerInvoice.isBisonLoad({ email: effBrokerName });"),
		"§7 the name-derived guard actually matches the pattern it forbids");

	// ── isBison is PINNED across the two routes, not derived twice. ──────────
	// The Email tab's job is "read the precise cover note before approving", so a
	// load that previews the generic letter and sends the Bison one defeats it —
	// and that is reachable both ways now the recipient is editable (a Bison load
	// re-routed off-domain, or a non-Bison load addressed to bisontransport.com).
	ok(/\n\t{5}isBison,\n/.test(SRC), "§7 the dryRun ECHOES the authoritative isBison");
	ok(/const isBison = typeof \(req\.body && req\.body\.isBison\) === "boolean"\n\t{4}\? req\.body\.isBison\n\t{4}: brokerInvoice\.isBisonLoad\(\{ email: invoiceTo\.email \}\);/.test(SRC),
		"§7 the preview PINS a supplied isBison and falls back to the recipient address");
	// STRICTLY boolean — a "false" string is truthy and would flip the template
	// the wrong way, the same reasoning as readTransmittedConsent's `=== true`.
	ok(/typeof \(req\.body && req\.body\.isBison\) === "boolean"/.test(SRC),
		"§7 …accepting ONLY a real boolean, never a truthy string");
	// ⚠️ THE SAFETY ARGUMENT: the body may influence isBison only on the route
	// that SENDS NOTHING. The approve decides where money is invoiced to, so it
	// must never read this from the caller.
	const previewAt = SRC.indexOf('"/api/loads/:loadId/invoice-preview"');
	ok(previewAt > 0, "§7 the invoice-preview route is registered");
	const bodyIsBisonHits = [...SRC.matchAll(/req\.body(?:\?)?(?:\.|\[")isBison/g)].map((m) => m.index);
	ok(bodyIsBisonHits.length > 0, "§7 the preview reads isBison from the body");
	ok(bodyIsBisonHits.every((i) => i > previewAt),
		"§7 NO body-supplied isBison anywhere before the preview route — the approve never reads it");
	// And it cannot sneak in through the shared validator either.
	ok(!/isBison/.test(extractFn(SRC, "parseInvoiceOverrides")),
		"§7 parseInvoiceOverrides does not carry isBison, so `ov` cannot leak it into the approve");
	// The 422 relaxation is dryRun-only, and the other guards are untouched.
	ok(/if \(needsTotal && !dryRun\) \{/.test(SRC),
		"§7 INVOICE_TOTAL_UNKNOWN is relaxed for dryRun ONLY");
	ok(/if \(!\/delivered\|completed\|pod received\/i\.test\(status\)\) \{/.test(SRC),
		"§7 the delivered gate is unchanged");
	eq(SRC.split('return res.status(400).json({ error: "POD not found for this load" });').length - 1, 2,
		"§7 both POD gates are unchanged");
	ok(/code: "TRAILER_MISMATCH"/.test(SRC), "§7 the trailer 409 is unchanged");
	// ⚠️ Owner decision #2, asserted EVASION-PROOF rather than indicatively.
	// The first version of this scanned the whole file for `values.update` within
	// 400 characters of `paymentCol` — which misses a values.append write-back
	// entirely, misses a values.update 401 characters away, and is really an
	// assertion about the file rather than about this handler. The honest claim
	// is that the draft-invoice route performs NO Sheets write of any kind.
	const approveRoute = extractRouteByLines(SRC, APPROVE_NEEDLE);
	for (const verb of SHEET_WRITE_VERBS) {
		ok(!approveRoute.text.includes(verb),
			`§7 the draft-invoice route contains no ${verb} — an edited total can never restate the books`);
	}
	eq((approveRoute.text.match(/values\.get/g) || []).length, 1,
		"§7 …and reads the sheet exactly once (the load lookup), no more");
	ok(CHECKS.approveWritesNoSheet(SRC), "§7 approveWritesNoSheet holds on the shipped source");
	// The preview route's stated contract: zero Sheets, zero Gemini, zero Drive,
	// zero DB writes. The Sheets half is checkable the same way.
	const previewRoute = extractRouteByLines(SRC, PREVIEW_NEEDLE);
	for (const verb of SHEET_WRITE_VERBS.concat("values.get")) {
		ok(!previewRoute.text.includes(verb), `§7 the invoice-preview route contains no ${verb}`);
	}
	ok(!/runRateConGemini|extractRateConFields|getDrive\(|fetchDocumentBytes/.test(previewRoute.text),
		"§7 …and no Gemini or Drive call either");
	ok(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(previewRoute.text),
		"§7 …and writes nothing to SQLite");
	ok(!/nextInvoiceNumber\(/.test(previewRoute.text),
		"§7 …and never CONSUMES an invoice number (peek only)");
	// The audit split.
	ok(/logAudit\(req, "invoice_draft_created", "load", loadId, `\$\{invoiceId\} → \$\{invoiceTo\.email\} \(\$\{via\}\)`\)/.test(SRC),
		"§7 invoice_draft_created keeps its byte-identical detail string");
	ok(/logAudit\(req, "invoice_draft_edited", "load", loadId/.test(SRC),
		"§7 an edit is a SEPARATE audit action");
	ok(/INVOICE ONLY — Job Tracking Payment unchanged/.test(SRC),
		"§7 the audit line names the invoice-only rule explicitly");
	// The preview route's bounds.
	ok(/const INVOICE_PREVIEW_MAX_INFLIGHT = \d+;/.test(SRC), "§7 the preview route has an in-flight cap");
	// ⚠️ THIS ASSERTION WAS VACUOUS. It read
	//   ok(/invoicePreviewInflight--;\n\t\t\}/.test(…) || /finally \{[\s\S]{0,300}…/.test(SRC), …)
	// whose first disjunct proves only that the decrement is followed by `}` —
	// true of a decrement sitting anywhere in a block — and because an `||` short
	// -circuits on it, the real check never ran. Measured: a mutant moving the
	// decrement OUT of the finally still passed. Brace-matched now, and mutant
	// M15 proves it fails when violated.
	ok(CHECKS.decrementInFinally(SRC),
		"§7 …released inside a brace-matched finally, so a throw cannot ratchet it to zero");
	ok(/invoicePreviewInflight\+\+;\n\t\ttry \{/.test(previewRoute.text),
		"§7 …with the increment immediately followed by try, so no statement can throw between them");
	ok(previewRoute.text.indexOf("if (invoicePreviewInflight >= INVOICE_PREVIEW_MAX_INFLIGHT)")
		< previewRoute.text.indexOf("invoicePreviewInflight++;"),
		"§7 …and the cap is checked BEFORE the increment");
	ok(/"\/api\/loads\/:loadId\/invoice-preview",\n\trequireRole\("Super Admin", "Dispatcher"\),/.test(SRC),
		"§7 requireRole is mounted BEFORE the limiter so a 403 cannot spend the budget");
	ok(/\trefuseCrossSite,\n\tinvoicePreviewLimiter,/.test(SRC), "§7 the preview carries refuseCrossSite + its limiter");

	// ── The invoice-# collision probe runs on BOTH routes. ───────────────────
	// A caller that skips the preview (curl, n8n, any non-SPA client) would
	// otherwise reuse another load's issued number with no signal at all.
	eq((SRC.match(/invoiceIdAlreadyUsed\(/g) || []).length, 3,
		"§7 invoiceIdAlreadyUsed is DEFINED once and CALLED twice — approve and preview");
	ok(/invoiceIdAlreadyUsed\(invoiceId, loadId\)/.test(approveRoute.text),
		"§7 the approve path probes for a colliding invoice #");
	eq((approveRoute.text.match(/warnings: draftWarnings/g) || []).length, 3,
		"§7 …surfaced in warnings[] on every success response (imap, n8n, no-target)");
	// Never a block: invoice_id has no unique index by design.
	ok(!/status\(409\)[\s\S]{0,160}invoiceIdAlreadyUsed|invoiceIdAlreadyUsed[\s\S]{0,160}status\(409\)/.test(approveRoute.text),
		"§7 a collision is a WARNING, never a refusal — the re-approve flow reissues on purpose");
	ok(approveRoute.text.indexOf("invoiceIdAlreadyUsed(") < approveRoute.text.indexOf("INSERT INTO load_invoice_drafts"),
		"§7 …and it is probed BEFORE this draft inserts its own row");
}

// ======================== §7b PROTOTYPE INHERITANCE ON has / values
// supplied() uses hasOwnProperty, so nothing can be WRITTEN through the
// prototype — but every consumer READS ov.has.total / ov.values.total, and a
// plain {} inherits. A polluted Object.prototype would therefore hand the
// approve a total that never entered the `if (supplied("total"))` branch, so
// the format gate, the $0.01 floor and the $1,000,000 ceiling are all skipped
// and $999,999.00 is billed. Defence in depth — there is no pollution sink in
// this app today — and it costs one word.
section("7b. Prototype inheritance — a polluted Object.prototype must not become an override");
{
	const SENTINELS = {
		total: 999999, recipientEmail: "attacker@evil.example.com", invoiceId: "POLLUTED",
		orderNumber: "POLLUTED", invoiceDate: "2026-01-01", poNumber: "POLLUTED",
		deliveryDate: "2026-01-01", brokerName: "POLLUTED", billToName: "POLLUTED", moveNumber: "POLLUTED",
	};
	for (const [key, sentinel] of Object.entries(SENTINELS)) {
		try {
			Object.prototype[key] = sentinel;
			const r = parseInvoiceOverrides({});
			ok(r.ok, `§7b a polluted ${key} does not break the validator`);
			eq(r.has[key], undefined, `§7b has.${key} is NOT inherited from Object.prototype`);
			eq(r.values[key], undefined, `§7b values.${key} is NOT inherited from Object.prototype`);
			// The refusal shape too — a caller that ignores `ok` must still see nothing.
			const refused = parseInvoiceOverrides({ invoiceId: "!!!" });
			eq(refused.ok, false, `§7b (control) a genuine refusal still refuses while ${key} is polluted`);
			eq(refused.values[key], undefined, `§7b a REFUSAL's values.${key} is not inherited either`);
		} finally {
			// Restore in a finally, ALWAYS — leaving Object.prototype polluted would
			// poison every later section and read as a cascade of unrelated failures.
			delete Object.prototype[key];
		}
	}
	eq(Object.prototype.total, undefined, "§7b Object.prototype is left clean for the rest of the run");
	ok(/const has = Object\.create\(null\);/.test(SRC) && /const values = Object\.create\(null\);/.test(SRC),
		"§7b has/values are null-prototype objects in the shipped source");
	ok(/has: Object\.create\(null\), values: Object\.create\(null\)/.test(SRC),
		"§7b …and so is the refusal shape returned by bad()");
}

// ====================================================== §8 MUTANTS
// Each reintroduces one landmine. Each must be caught, or the corresponding
// assertions above are decorative.
section("8. Mutants");
const MUTANTS = [
	{
		name: "M1 the format gate is removed entirely (parseMoney alone decides)",
		mutate: (s) => s.replace(
			"if (!raw || !INVOICE_TOTAL_FORMAT_RE.test(raw)) {",
			"if (false) {"),
		// "12abc34" → 1234 → in range → billed.
		expect: (m) => m.parseInvoiceOverrides({ total: "12abc34" }).ok,
	},
	{
		name: "M2 the gate runs AFTER parseMoney instead of before (the ordering)",
		mutate: (s) => s.replace(
			"if (!raw || !INVOICE_TOTAL_FORMAT_RE.test(raw)) {",
			"if (!raw || !INVOICE_TOTAL_FORMAT_RE.test(String(brokerInvoice.parseMoney(raw)))) {"),
		// The mangled value is a clean number by the time the gate sees it, so
		// every one of §1's rejects sails through. This is the mutant a test that
		// only asserted "12abc34 is rejected" without §2's ordering check would
		// still fail to distinguish — it is caught here behaviourally.
		expect: (m) => m.parseInvoiceOverrides({ total: "12abc34" }).ok
			|| m.parseInvoiceOverrides({ total: "1e9" }).ok,
	},
	{
		name: "M3 isoToMdy delegates to brokerInvoice.formatDate (the off-by-one)",
		mutate: (s) => s.replace(
			"\treturn m ? `${m[2]}/${m[3]}/${m[1]}` : \"\";",
			"\treturn m ? brokerInvoice.formatDate(String(iso)) : \"\";"),
		expect: (m) => m.isoToMdy("2026-08-14") !== "08/14/2026",
	},
	{
		name: "M4 the ceiling is dropped",
		mutate: (s) => s.replace("|| n > INVOICE_TOTAL_MAX", ""),
		expect: (m) => m.parseInvoiceOverrides({ total: "9,999,999.00" }).ok,
	},
	{
		name: "M5 '' is treated as omitted (omitted-vs-empty conflated)",
		mutate: (s) => s.replace(
			"\t\treturn src[k] !== undefined && src[k] !== null;",
			"\t\treturn src[k] !== undefined && src[k] !== null && src[k] !== \"\";"),
		// The dispatcher clears the total; the server quietly restamps the old one.
		expect: (m) => {
			const r = m.parseInvoiceOverrides({ total: "" });
			return r.ok && !r.has.total;
		},
	},
	{
		name: "M6 safeAttachmentName strips one dot CHARACTER instead of a run",
		mutate: (s) => s.replace('s = s.replace(/^[.\\s]+/, "");', 's = s.replace(/^\\./, "");'),
		expect: (m) => m.safeAttachmentName("..") !== "Invoice",
	},
	{
		name: "M7 safeAttachmentName caps with slice() instead of Array.from()",
		mutate: (s) => s.replace(
			's = Array.from(s).slice(0, max).join("").trim();',
			"s = s.slice(0, max).trim();"),
		expect: (m) => Array.from(m.safeAttachmentName("🚚".repeat(10), 5)).length !== 5,
	},
	{
		name: "M8 the calendar check is dropped (regex-only date validation)",
		mutate: (s) => s.replace(
			"if (!m || !isRealCalendarDate(+m[1], +m[2], +m[3])) {",
			"if (!m) {"),
		expect: (m) => m.parseInvoiceOverrides({ invoiceDate: "2026-02-31" }).ok,
	},
	{
		name: "M9 the total type guard is dropped (arrays coerce in)",
		mutate: (s) => s.replace(
			'if (typeof t !== "string" && typeof t !== "number") {',
			"if (false) {"),
		expect: (m) => m.parseInvoiceOverrides({ total: [1800] }).ok,
	},
	{
		name: "M11 fields sanitized to 40 (over-length TRUNCATED into validity)",
		mutate: (s) => s.replace(/sanitizeEvidenceText\(src\.invoiceId, INVOICE_FIELD_SCAN_MAX\)/,
			"sanitizeEvidenceText(src.invoiceId, 40)"),
		expect: (m) => m.parseInvoiceOverrides({ invoiceId: "A".repeat(41) }).ok,
	},
	{
		name: "M12 safeAttachmentName strips a leading dot-run only ONCE",
		mutate: (s) => s.replace('s = s.replace(/^[.\\s]+/, "");', 's = s.replace(/^\\.+/, "").trim();'),
		// Separator replacement MANUFACTURES a second run: "../../etc/passwd" →
		// ".. .. etc passwd", so one pass leaves ".. etc passwd".
		expect: (m) => m.safeAttachmentName("../../etc/passwd").startsWith("."),
	},
	{
		name: "M13 has/values are plain {} again (prototype inheritance)",
		mutate: (s) => s.replace(
			"const has = Object.create(null);\n\tconst values = Object.create(null);",
			"const has = {};\n\tconst values = {};"),
		expect: (m) => {
			try {
				Object.prototype.total = 999999;
				const r = m.parseInvoiceOverrides({});
				// The approve reads exactly this pair, and would bill $999,999.00.
				return !!r.has.total && r.values.total === 999999;
			} finally { delete Object.prototype.total; }
		},
	},
	{
		name: "M14 the year bound is dropped (year 0000 prints on the invoice)",
		mutate: (s) => s.replace(
			"\tif (!(y >= INVOICE_YEAR_MIN && y <= INVOICE_YEAR_MAX)) return false;\n", ""),
		expect: (m) => m.parseInvoiceOverrides({ invoiceDate: "0000-01-14" }).ok,
	},
	{
		name: "M10 an invalid recipientEmail is silently ignored (the old behaviour)",
		mutate: (s) => s.replace(
			'if (!v) return bad("RECIPIENT_INVALID", "recipientEmail", "Recipient must be a valid email address.");',
			"if (!v) { has.recipientEmail = false; }"),
		expect: (m) => m.parseInvoiceOverrides({ recipientEmail: "nope" }).ok,
	},
];
for (const mut of MUTANTS) {
	// ⚠️ ASSERT THE MUTATION LANDED. A `.replace()` whose needle no longer exists
	// is a silent no-op, which turns the mutant into a CONTROL that passes for
	// the wrong reason — and needles rot every time the shipped code is touched.
	// This caught a real one: M6's needle was the pre-fix text, so after the fix
	// it mutated nothing and reported the shipped behaviour as an escape.
	ok(mut.mutate(SRC) !== SRC, `§8 mutant needle is STALE (mutated nothing): ${mut.name}`);
	let caught = false;
	try {
		const mutated = loadShipped(mut.mutate);
		caught = !!mut.expect(mutated);
	} catch {
		caught = true; // a mutant that cannot even load is caught
	}
	ok(caught, `§8 mutant NOT caught: ${mut.name}`);
}

// ============================ §9 THE TEXTUAL ASSERTIONS ARE LOAD-BEARING
// §7's route-level claims are NEGATIVE ("this handler issues no Sheets write",
// "the decrement is inside a finally"). A negative passes just as happily when
// the predicate is simply wrong, so each is re-checked against a source that
// deliberately violates it. Both predicates replaced ones that were measured to
// be porous — this section is the reason to believe the replacements are not.
section("9. Negative controls — each §7 route predicate must FAIL on a violation");
{
	// The two retired assertions, kept verbatim, so the improvement is provable
	// rather than asserted. Neither is used to judge the shipped source.
	const OLD_PAYMENT_CHECK = (s) => !/values\.update[\s\S]{0,400}paymentCol/.test(s);
	const OLD_FINALLY_CHECK = (s) =>
		/invoicePreviewInflight--;\n\t\t\}/.test(s.replace(/\r/g, "")) ||
		/finally \{[\s\S]{0,300}invoicePreviewInflight--;/.test(s);

	const VIOLATIONS = [
		{
			name: "V1 approve gains a values.update write-back beside paymentCol",
			mutate: (s) => s.replace(
				"\t\t\t// 6b) Invoice identifiers + dates.",
				'\t\t\tawait sheets.spreadsheets.values.update({ range: paymentCol, values: [[totalAmount]] });\n\t\t\t// 6b) Invoice identifiers + dates.'),
			check: "approveWritesNoSheet",
			oldWouldCatch: true,
		},
		{
			name: "V2 approve gains a values.APPEND write-back (old regex matched only .update)",
			mutate: (s) => s.replace(
				"\t\t\t// 6b) Invoice identifiers + dates.",
				'\t\t\tawait sheets.spreadsheets.values.append({ range: paymentCol, values: [[totalAmount]] });\n\t\t\t// 6b) Invoice identifiers + dates.'),
			check: "approveWritesNoSheet",
			oldCheck: OLD_PAYMENT_CHECK,
			oldWouldCatch: false,
		},
		{
			name: "V3 approve gains a values.update >400 chars from paymentCol (outside the old window)",
			mutate: (s) => s.replace(
				"\t\t\t// 6b) Invoice identifiers + dates.",
				"\t\t\tawait sheets.spreadsheets.values.update({ range: 'Job Tracking!Z2', values: [[totalAmount]] });\n\t\t\t// 6b) Invoice identifiers + dates."),
			check: "approveWritesNoSheet",
			oldCheck: OLD_PAYMENT_CHECK,
			oldWouldCatch: false,
		},
		{
			// ⚠️ The needle MUST be unique to the preview route. The first draft
			// anchored on `const loadRef = loadId.replace(…)`, which appears in the
			// approve route FIRST — String.replace takes only that occurrence, so
			// the violation landed in the wrong handler and previewTouchesNoSheet
			// correctly reported nothing. Caught by the routeChanged guard below.
			name: "V4 preview starts reading the sheet",
			mutate: (s) => s.replace(
				"\t\t\tconst fallbackTo = brokerInvoice.resolveInvoiceTo({});",
				"\t\t\tconst sheetRow = await sheets.spreadsheets.values.get({ range: 'Job Tracking' });\n\t\t\tconst fallbackTo = brokerInvoice.resolveInvoiceTo({});"),
			check: "previewTouchesNoSheet",
			oldWouldCatch: null, // no prior assertion existed at all
		},
		{
			name: "V5 the in-flight decrement is moved OUT of the finally",
			mutate: (s) => s.replace(
				"\t\t} finally {\n\t\t\t// In a finally, always: a throw inside the render would otherwise leak a\n\t\t\t// slot and the cap would ratchet to zero after two failures.\n\t\t\tinvoicePreviewInflight--;\n\t\t}",
				"\t\t\tinvoicePreviewInflight--;\n\t\t}"),
			check: "decrementInFinally",
			oldCheck: OLD_FINALLY_CHECK,
			oldWouldCatch: false,
		},
		{
			name: "V6 a second decrement appears outside the finally",
			mutate: (s) => s.replace(
				"\t\tinvoicePreviewInflight++;",
				"\t\tinvoicePreviewInflight++;\n\t\tinvoicePreviewInflight--;"),
			check: "decrementInFinally",
			oldWouldCatch: null,
		},
	];

	// Which route each predicate actually examines — used to prove the violation
	// landed THERE and not merely somewhere in the file.
	const CHECK_ROUTE = {
		approveWritesNoSheet: APPROVE_NEEDLE,
		previewTouchesNoSheet: PREVIEW_NEEDLE,
		decrementInFinally: PREVIEW_NEEDLE,
	};

	for (const v of VIOLATIONS) {
		const mutated = v.mutate(SRC);
		ok(mutated !== SRC, `§9 violation needle is STALE (mutated nothing): ${v.name}`);
		if (mutated === SRC) continue;
		// ⚠️ "The file changed" is NOT "the route changed". String.replace takes
		// the FIRST occurrence, so a needle that also appears in the other handler
		// plants the violation in the wrong route — the predicate then reports
		// nothing and the control silently proves the opposite of what it claims.
		// This caught exactly that on V4 while it was being written.
		const needle = CHECK_ROUTE[v.check];
		ok(extractRouteByLines(mutated, needle).text !== extractRouteByLines(SRC, needle).text,
			`§9 violation landed in the WRONG route (${v.check} examines a route this mutation never touched): ${v.name}`);
		let caught;
		try { caught = !CHECKS[v.check](mutated); } catch { caught = true; }
		ok(caught, `§9 ${v.check} FAILED to catch: ${v.name}`);
		// And where a prior assertion existed, show it was porous — this is the
		// evidence that the replacement is an improvement and not a rewrite.
		if (v.oldCheck && v.oldWouldCatch === false) {
			ok(v.oldCheck(mutated), `§9 (control) the RETIRED assertion passes on ${v.name}, which is why it was replaced`);
		}
	}
}

// -------------------------------------------------------------------- report
console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed (${MUTANTS.length} mutants caught)`);
