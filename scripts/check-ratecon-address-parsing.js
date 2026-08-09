#!/usr/bin/env node
// Deterministic check on lib/ratecon-load.js → cityStateZip(), the function that
// builds the "Details" route string ("City, ST ZIP - City, ST ZIP") written to
// the Job Details tab by BOTH ingestion paths:
//   * POST /api/loads/from-ratecon   (dispatcher drag-and-drop)
//   * POST /api/n8n/load-distance    (the n8n email path, since the LLM was retired)
//
// WHY THIS EXISTS. The n8n workflow used to derive both the distance and this
// address string from a Gemini `AI Agent` node with no tools attached. Retiring
// it moved the address half onto this regex — so the regex had to be at least as
// good first, or the change would have swapped a wrong distance for a wrong
// address. Measured against the 144 production rows where the LLM had also
// answered: 118/144 (81.9%) before the newline fix, 140/144 (97.2%) after.
//
// Every raw address below is copied verbatim from a production rate-con. No
// network, no sheet, no database — pure input/output, safe to run anywhere.
//
//   node scripts/check-ratecon-address-parsing.js     # exits 1 on any failure

const path = require("path");
const { cityStateZip } = require(path.join(__dirname, "..", "lib", "ratecon-load.js"));

// [label, rawAddress, expectedCityStateZip]
const CASES = [
	// Multi-line addresses — 22 of the 26 measured production disagreements were
	// this shape. The original character class `[^,]` matches "\n", so the city
	// capture swallowed the whole street.
	["newline street", "4528 W Royal Ln\nIrving, TX 75063", "Irving, TX 75063"],
	["newline street 2", "818 Hallmark Dr\nLAREDO, TX 78045", "LAREDO, TX 78045"],
	["newline + ZIP+4", "1600 W Wintergreen Rd\nHUTCHINS, TX 75141-3714", "HUTCHINS, TX 75141"],
	["newline + suite line", "1501 Southern Rd\nSTE D\nKansas City, MO 64120", "Kansas City, MO 64120"],
	["newline + suite line 2", "2420 Grand Ave\nSTE 300\nWest Des Moines, IA 50265", "West Des Moines, IA 50265"],
	["newline, ZIP own line", "1700 SCOTT AVE\nDES MOINES, IA\n50309", "DES MOINES, IA 50309"],
	["newline, ZIP own line 2", "2930 114TH STREET\nGRAND PRAIRIE, TX\n75050", "GRAND PRAIRIE, TX 75050"],
	["newline ZIP+4", "501 Atlantic St\nKansas City, MO 64116-4208", "Kansas City, MO 64116"],

	// Comma before the ZIP. This failed the regex outright and fell through to the
	// last-two-comma-parts fallback, which returned "TX, 78521" — city LOST.
	// Documented residual: with no delimiter between street and city the street is
	// kept. Verbose but complete, and strictly better than dropping the city. Every
	// rule that would separate them is a guess about where a street name ends.
	["comma before ZIP", "1355 N Central Ave Brownsville, TX, 78521", "1355 N Central Ave Brownsville, TX 78521"],

	// Regression guard — the ordinary single-line form always worked and must
	// keep working.
	["plain one-line", "500 Bell Avenue, Ames, IA 50010", "Ames, IA 50010"],
	["plain one-line 2", "13120 E 59TH ST, Tulsa, OK 74134", "Tulsa, OK 74134"],
	["plain one-line 3", "4200 E. 32nd, JOPLIN, MO 64803", "JOPLIN, MO 64803"],
	["plain, ZIP+4", "3701 Lively St Rd, Fort Worth, TX 76177-2438", "Fort Worth, TX 76177"],

	// Degenerate input takes the fallback and must never throw. Note the app
	// returns "Cedar Rapids, IA" with no ZIP rather than inventing one — the
	// retired LLM answered this same row with a fabricated "52404".
	["no ZIP", "4600 C Street SW, Cedar Rapids, IA", "Cedar Rapids, IA"],
	["empty", "", ""],
	["city/state only", "Houston, TX", "Houston, TX"],
];

let pass = 0;
const failures = [];
console.log("case                      | got                                       | expected");
console.log("-".repeat(112));
for (const [label, raw, want] of CASES) {
	let got;
	try {
		got = cityStateZip(raw);
	} catch (e) {
		got = "THREW: " + e.message;
	}
	const ok = got === want;
	if (ok) pass++;
	else failures.push({ label, raw, got, want });
	console.log(
		`${ok ? "ok  " : "FAIL"} ${label.padEnd(21)} | ${JSON.stringify(got).padEnd(41)} | ${JSON.stringify(want)}`
	);
}
console.log("-".repeat(112));
console.log(`pass ${pass} / ${CASES.length}`);
if (failures.length) {
	console.error(`\n${failures.length} FAILED`);
	for (const f of failures) console.error(`  ${f.label}: input ${JSON.stringify(f.raw)}`);
	process.exit(1);
}
