// ============================================================
// Rate-con extraction hardening (post-Gemini normalization)
// ============================================================
// Pure, dependency-free helpers that clean up the raw field object
// returned by runRateConGemini() BEFORE it is shown in the dispatcher
// review modal or written to the sheet. Multi-broker rate-cons vary wildly
// in how they format money, addresses and phone numbers; Gemini extracts the
// semantic value but leaves the surface form as-is ("$1500", "USD 1,500.00",
// a street split across three lines, "800.580.3101"). This module gives every
// broker's output one consistent, sheet-ready shape.
//
// Nothing here touches the network, Google Sheets, Drive, or SQLite. Same
// pure-helper contract (and no-throw guarantee) as lib/ratecon-load.js and
// lib/broker-invoice.js, so it self-tests offline with `node lib/ratecon-normalize.js`.
//
// Exports:
//   normalizeRateConFields(fields) -> cleaned COPY (rate → "$X,XXX.XX",
//                                     addresses collapsed to one line, 10-digit
//                                     phones tidied, strings trimmed, "" and
//                                     null-ish tokens ("None"/"N/A") → null,
//                                     unknown keys copied through untouched)
//   missingCriticalFields(fields)  -> string[] of any missing among the 4 fields
//                                     a load cannot be created / rate-per-mile'd
//                                     without (for a retry-nudge)
//   mergeExtractions(primary, retry) -> primary with its missing fields filled
//                                     from retry (second-pass nudge)
//   FIELD_NAMES / CRITICAL_FIELDS / FIXTURES / selfTest  (for callers + tests)

"use strict";

// ------------------------------------------------------------
// Field taxonomy — mirrors RATECON_GEMINI_FIELDS / the response
// schema in server.js. Keep in lockstep if the schema grows.
// ------------------------------------------------------------
const FIELD_NAMES = [
	"Load Number", "Broker Name", "Broker Phone", "Broker Email", "Driver Name",
	"Pickup Company Information", "Pickup Address", "Pickup Appointment Time",
	"P/U Reference Number", "Pickup Notes/Instructions",
	"Drop-off Company Information", "Drop-off Address", "Delivery Appointment Time",
	"Delivery Reference Number", "Delivery Notes/Instructions",
	"Rate", "BOL Number", "Details",
	"Order Number", "PO Number", "Move Number", "Trailer Number", "Total Rate",
	"Documents Email",
];
const KNOWN_FIELDS = new Set(FIELD_NAMES);

// Money fields → "$X,XXX.XX".
const RATE_FIELDS = new Set(["Rate", "Total Rate"]);
// Free-form street/city/state/zip that brokers routinely split across lines.
const ADDRESS_FIELDS = new Set(["Pickup Address", "Drop-off Address"]);
// Phone fields (only Broker Phone today; matched by name so future-proof).
const PHONE_FIELDS = new Set(FIELD_NAMES.filter((f) => /phone/i.test(f)));

// The four fields a load genuinely cannot be created or priced without —
// same set the review-modal warnings (ratecon-load.extractionWarnings) flag.
const CRITICAL_FIELDS = ["Load Number", "Rate", "Pickup Address", "Drop-off Address"];

// Tokens Gemini (or a broker template) uses to mean "nothing here". These are
// treated as MISSING by missingCriticalFields / mergeExtractions, and a rate of
// one of these normalizes to null rather than a bogus string.
const NULLISH_TOKENS = new Set([
	"none", "n/a", "na", "null", "nil", "tbd", "unknown", "-", "--", "—",
]);

// ------------------------------------------------------------
// Small pure formatters
// ------------------------------------------------------------

// Deterministic money formatter (no Intl/ICU dependency, so output is identical
// on every Node build). 1500 -> "$1,500.00", -12.5 -> "-$12.50".
function formatMoney(n) {
	const neg = n < 0;
	const fixed = Math.abs(n).toFixed(2); // "1500.00"
	const dot = fixed.indexOf(".");
	const intPart = fixed.slice(0, dot);
	const decPart = fixed.slice(dot + 1);
	const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return (neg ? "-$" : "$") + withCommas + "." + decPart;
}

// Parse the many money surface forms brokers emit into "$X,XXX.XX".
// "$1500" | "1,500.00" | "USD 1500" | "1500.0" | "$ 1,500" -> "$1,500.00".
// Returns null when the string carries no parseable number (e.g. "None",
// "See rate agreement") so the caller sees a missing rate, not junk.
function formatRate(raw) {
	// Commas are thousands separators here, never decimal — strip them, then
	// pull the first number. Handles a leading currency word/symbol for free.
	const cleaned = String(raw).replace(/,/g, "");
	const m = cleaned.match(/-?\d+(?:\.\d+)?/);
	if (!m) return null;
	const n = parseFloat(m[0]);
	if (!Number.isFinite(n)) return null;
	return formatMoney(n);
}

// Collapse a street address that arrived split across lines (or padded with
// runaway whitespace) into one clean "street, city, ST zip"-style string.
// Only ever applied to the two Address fields — Notes may legitimately contain
// newlines and must not be comma-joined.
function collapseAddress(raw) {
	let out = String(raw).replace(/\r\n?/g, "\n");
	// Join non-empty lines with ", ".
	out = out.split("\n").map((l) => l.trim()).filter(Boolean).join(", ");
	// One space internally; no space before a comma, one after.
	out = out.replace(/[ \t]+/g, " ").replace(/\s*,\s*/g, ", ");
	// Squash the ", , " that a trailing-comma line + join produces.
	out = out.replace(/(?:,\s*){2,}/g, ", ");
	// Trim stray leading/trailing commas or spaces.
	out = out.replace(/^[,\s]+|[,\s]+$/g, "");
	return out;
}

// Tidy a US 10-digit phone to "(xxx) xxx-xxxx". Accepts an 11-digit "1"-prefixed
// number too. Anything else (international, extension-laden, partial) is left
// as the trimmed original rather than mangled.
function formatPhone(raw) {
	const digits = String(raw).replace(/\D/g, "");
	let ten = null;
	if (digits.length === 10) ten = digits;
	else if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
	if (!ten) return String(raw).trim();
	return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// True when a value should be treated as "not extracted": null/undefined, an
// empty/whitespace string, or a null-ish token like "None"/"N/A".
function isMissing(v) {
	if (v == null) return true;
	if (typeof v !== "string") return false; // a real number/other counts as present
	const t = v.trim().toLowerCase();
	return t === "" || NULLISH_TOKENS.has(t);
}

// Clean one KNOWN field. Never throws — any surprise coerces to a safe value.
function cleanKnownField(key, val) {
	if (val == null) return null;
	let s = typeof val === "string" ? val : String(val);
	s = s.trim();
	if (s === "") return null;
	// A null-ish token ("None", "N/A", "TBD"…) is how a broker template / Gemini
	// spells "nothing here" for an extracted field — treat it as absent, the same
	// spirit as "" → null (and matching lib/broker-invoice's "None" handling).
	if (NULLISH_TOKENS.has(s.toLowerCase())) return null;
	if (RATE_FIELDS.has(key)) return formatRate(s);
	if (ADDRESS_FIELDS.has(key)) return collapseAddress(s) || null;
	if (PHONE_FIELDS.has(key)) return formatPhone(s);
	return s;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

// Return a cleaned COPY of the extracted field object. Known fields are trimmed,
// null-ified when empty or null-ish ("None"/"N/A"), and format-normalized
// (money/address/phone); unknown keys are copied through verbatim. Pure and
// total — never throws, never mutates the input.
function normalizeRateConFields(fields) {
	if (fields == null || typeof fields !== "object") return {};
	const out = {};
	for (const key of Object.keys(fields)) {
		try {
			out[key] = KNOWN_FIELDS.has(key)
				? cleanKnownField(key, fields[key])
				: fields[key]; // unknown key — leave untouched
		} catch (_e) {
			out[key] = fields[key]; // defensive: never let one bad field throw
		}
	}
	return out;
}

// Which of the four load-critical fields are absent. Works on raw OR normalized
// input (isMissing catches "", null, and "None"-style tokens). Drives the
// "extraction thin — try a second pass" retry nudge.
function missingCriticalFields(fields) {
	const f = fields && typeof fields === "object" ? fields : {};
	return CRITICAL_FIELDS.filter((k) => isMissing(f[k]));
}

// Fill primary's missing fields from a retry extraction (second-pass nudge).
// Returns a new object; primary always wins where it already has a value. Keys
// present only in retry are added so a re-run can recover a field the first pass
// dropped entirely.
function mergeExtractions(primary, retry) {
	const p = primary && typeof primary === "object" ? primary : {};
	const r = retry && typeof retry === "object" ? retry : {};
	const out = { ...p };
	for (const k of new Set([...Object.keys(p), ...Object.keys(r)])) {
		if (isMissing(out[k]) && !isMissing(r[k])) out[k] = r[k];
	}
	return out;
}

// ------------------------------------------------------------
// Synthetic broker-shaped fixtures + self-test
// ------------------------------------------------------------
// Each fixture is a raw Gemini-shaped object modeled on a different broker's
// layout, paired with its expected normalized output. Run: node lib/ratecon-normalize.js
const FIXTURES = [
	{
		name: "TQL-style — multi-line addresses, dotted phone, pre-formatted rate",
		raw: {
			"Load Number": "  TQL-8842119 ",
			"Broker Name": "Danna Garcia",
			"Broker Phone": "800.580.3101",
			"Broker Email": " dgarcia@tql.com ",
			"Pickup Company Information": "Jacobson Warehouse",
			"Pickup Address": "500 Bell Avenue\nAmes\nIA 50010",
			"Rate": "$1,500.00",
			"Drop-off Address": "2930 114th Street,\n  Grand Prairie, TX  75050",
			"Delivery Reference Number": "",
			"Total Rate": "1500",
		},
		expected: {
			"Load Number": "TQL-8842119",
			"Broker Name": "Danna Garcia",
			"Broker Phone": "(800) 580-3101",
			"Broker Email": "dgarcia@tql.com",
			"Pickup Company Information": "Jacobson Warehouse",
			"Pickup Address": "500 Bell Avenue, Ames, IA 50010",
			"Rate": "$1,500.00",
			"Drop-off Address": "2930 114th Street, Grand Prairie, TX 75050",
			"Delivery Reference Number": null,
			"Total Rate": "$1,500.00",
		},
	},
	{
		name: "Coyote-style — 'USD 2200', pre-parenthesized phone, double-spaced address",
		raw: {
			"Load Number": "CO-5567",
			"Broker Phone": "(312) 447-2400",
			"Rate": "USD 2200",
			"Pickup Address": "1000  W Fulton Market,   Chicago, IL 60607",
			"Drop-off Address": "  700 Nicollet Mall\nMinneapolis, MN 55402 ",
			"Driver Name": "",
			"Move Number": " 19879427 ",
		},
		expected: {
			"Load Number": "CO-5567",
			"Broker Phone": "(312) 447-2400",
			"Rate": "$2,200.00",
			"Pickup Address": "1000 W Fulton Market, Chicago, IL 60607",
			"Drop-off Address": "700 Nicollet Mall, Minneapolis, MN 55402",
			"Driver Name": null,
			"Move Number": "19879427",
		},
	},
	{
		name: "CHR-style — 1-prefixed phone, decimal rate, unknown keys pass through",
		raw: {
			"Load Number": "1122334",
			"Broker Phone": "1-847-555-0199",
			"Rate": "2,750.5",
			"Pickup Address": "17 Loading Dock Rd, Elk Grove Village, IL 60007",
			"Drop-off Address": "5th & Main\nDenver, CO 80202",
			"Order Number": "7007280",
			"Delivery Reference Number": "None",
			"_source": "gemini",     // unknown key — must survive untouched
			"_confidence": 0.92,      // unknown non-string — must survive untouched
		},
		expected: {
			"Load Number": "1122334",
			"Broker Phone": "(847) 555-0199",
			"Rate": "$2,750.50",
			"Pickup Address": "17 Loading Dock Rd, Elk Grove Village, IL 60007",
			"Drop-off Address": "5th & Main, Denver, CO 80202",
			"Order Number": "7007280",
			"Delivery Reference Number": null,
			"_source": "gemini",
			"_confidence": 0.92,
		},
	},
];

// Tiny key-order-agnostic deep-equal for the self-test (objects/primitives only).
function deepEqual(a, b) {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return a === b;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
		if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}

// Runs the fixtures + the two other exports through assertions. Returns
// { passed, failed, total }; logs a line per check. Pure enough to call from a
// harness; also invoked when this file is run directly.
function selfTest() {
	const results = [];
	const check = (label, cond, extra) => {
		results.push({ label, ok: !!cond });
		const tag = cond ? "PASS" : "FAIL";
		console.log(`[${tag}] ${label}${cond ? "" : "  -> " + (extra || "")}`);
	};

	FIXTURES.forEach((fx) => {
		const got = normalizeRateConFields(fx.raw);
		check(
			`normalize: ${fx.name}`,
			deepEqual(got, fx.expected),
			"got " + JSON.stringify(got),
		);
		// Purity: input object must be unchanged.
		check(
			`normalize does not mutate input: ${fx.name}`,
			// re-normalizing a fresh clone yields the same result -> input intact
			deepEqual(normalizeRateConFields(fx.raw), got),
		);
	});

	// missingCriticalFields — full set present, none missing.
	check(
		"missingCriticalFields: complete load -> []",
		deepEqual(missingCriticalFields(FIXTURES[0].expected), []),
	);
	// missing rate + drop-off.
	check(
		"missingCriticalFields: gaps -> [Rate, Drop-off Address]",
		deepEqual(
			missingCriticalFields({ "Load Number": "X", "Pickup Address": "1 A St, Town, TX 75001" }),
			["Rate", "Drop-off Address"],
		),
	);
	// null-ish token counts as missing on raw input.
	check(
		"missingCriticalFields: 'None' rate treated as missing",
		deepEqual(
			missingCriticalFields({
				"Load Number": "X",
				"Rate": "None",
				"Pickup Address": "1 A St, Town, TX 75001",
				"Drop-off Address": "2 B St, City, CA 90001",
			}),
			["Rate"],
		),
	);

	// mergeExtractions — primary wins; nulls/empties/new keys come from retry.
	const merged = mergeExtractions(
		{ "Load Number": "L1", "Rate": null, "Pickup Address": "", "Broker Email": "a@b.com" },
		{
			"Rate": "$1,000.00",
			"Pickup Address": "1 A St, Town, TX 75001",
			"Drop-off Address": "2 B St, City, CA 90001",
			"Broker Email": "z@z.com",
		},
	);
	check(
		"mergeExtractions: fills gaps, keeps primary's real values, adds new keys",
		deepEqual(merged, {
			"Load Number": "L1",
			"Rate": "$1,000.00",
			"Pickup Address": "1 A St, Town, TX 75001",
			"Broker Email": "a@b.com",
			"Drop-off Address": "2 B St, City, CA 90001",
		}),
		"got " + JSON.stringify(merged),
	);

	// never throws on junk input.
	let threw = false;
	try {
		normalizeRateConFields(null);
		normalizeRateConFields(undefined);
		normalizeRateConFields(42);
		normalizeRateConFields({ "Rate": 1500, "Broker Phone": 8005803101, weird: { a: 1 } });
		missingCriticalFields(null);
		mergeExtractions(null, null);
	} catch (_e) {
		threw = true;
	}
	check("no-throw on null/number/nested inputs", !threw);

	const failed = results.filter((r) => !r.ok).length;
	const passed = results.length - failed;
	console.log(`\n${passed}/${results.length} checks passed.`);
	return { passed, failed, total: results.length };
}

module.exports = {
	normalizeRateConFields,
	missingCriticalFields,
	mergeExtractions,
	// Exposed for callers/tests:
	FIELD_NAMES,
	CRITICAL_FIELDS,
	FIXTURES,
	selfTest,
	// Lower-level formatters (handy for unit tests / reuse):
	formatMoney,
	formatRate,
	collapseAddress,
	formatPhone,
	isMissing,
};

// Run the self-test when executed directly: `node lib/ratecon-normalize.js`
if (require.main === module) {
	const { failed } = selfTest();
	process.exit(failed === 0 ? 0 : 1);
}
