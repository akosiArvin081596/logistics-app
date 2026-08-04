// CSV emit helpers — pure module (no network, no DB, no requires).
//
// One escaper for every CSV this app hands to a user. It was copied inline into
// four different handlers, and only the receipts-manifest copy carried the
// formula-injection guard; the others quote-escape only. Anything we export is
// opened in Excel or Google Sheets by an owner/accountant/investor, and load
// rows carry broker names, free-text notes, and address strings that come
// straight off a rate con — i.e. attacker-influenced text landing in a
// spreadsheet. So:
//
//   1. A cell that starts with = + - @ is prefixed with a single quote.
//      Excel/Calc/Sheets treat a leading =/+/-/@ as the start of a FORMULA
//      (=HYPERLINK(...), =cmd|...), so an unescaped broker name of
//      `=1+1` executes on open. The quote forces it to stay text and is not
//      displayed as part of the value. This is the load-bearing line here —
//      OWASP CSV injection. (Note the "-" case: it also covers the classic
//      `-2+3+cmd|' /C calc'!A0` command-execution payload.)
//   2. Every cell is wrapped in double quotes with internal quotes doubled, so
//      commas / newlines inside a value can never shift the column layout.
//
// Rows join with CRLF per RFC 4180 — that is what Excel on Windows expects, and
// a bare \n makes it render the whole file as one row.

"use strict";

// Leading noise to ignore when deciding whether a cell is a formula. JS \s
// covers space, tab, CR, LF, VT, FF, NBSP and the Unicode space separators —
// i.e. every character an importer is likely to trim on the way in.
const LEADING_NOISE = /^\s+/;

// Escape ONE value into a CSV cell. null/undefined become an empty cell.
// Always returns a quoted string, so callers can join with "," unconditionally.
//
// The guard tests the value with that leading noise STRIPPED rather than
// testing the raw first character. Testing raw is the common mistake: " =cmd|…"
// and "\r=cmd|…" both slip past a plain /^[=+\-@]/ check, and importers that
// trim on the way in (LibreOffice's "Trim spaces", assorted third-party
// parsers) then see a formula again. The quote is still prepended to the
// ORIGINAL string, so the exported value itself is never altered.
//
// LEADING_NOISE deliberately does NOT include "-": stripping a leading hyphen
// would make "-2+3+cmd|…" test as "2+3+cmd|…", which starts with a digit, and
// the guard would skip the exact payload it exists to stop.
function csvCell(v) {
	let s = String(v ?? "");
	if (/^[=+\-@]/.test(s.replace(LEADING_NOISE, ""))) s = "'" + s;
	return `"${s.replace(/"/g, '""')}"`;
}

// rows = array of row-arrays (including the header row) -> a full CSV body.
// Cells run through csvCell, so a header array is quoted like any other row —
// valid RFC 4180 and parsed identically by Excel / Sheets / pandas.
function csvRows(rows) {
	return (Array.isArray(rows) ? rows : [])
		.map((row) => (Array.isArray(row) ? row : [row]).map(csvCell).join(","))
		.join("\r\n");
}

module.exports = { csvCell, csvRows };
