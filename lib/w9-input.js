// ============================================================
// Input checks for what the investor W-9 prints
// ============================================================
// fillW9Form() in server.js prints the legal name (Line 1), the business name
// (Line 2), the address (Lines 5 and 6), the TIN (Part I) and the signature.
// POST /api/public/investor-apply, the W-9 preview and step 1 of /invest (POST
// /api/public/investor-w9-check) check those values here, before anything is
// stored or rendered, so a value the form cannot hold is refused while the
// applicant can still correct it -- not discovered after the application is
// in, as a W-9 that was never produced.
//
// Pure: no network, no database, no filesystem. Every checker is total -- it
// never throws -- and answers { ok: true, ... } or
// { ok: false, code, message }: `message` is safe to show the applicant, `code`
// is the response's error code.
//
// client/src/lib/taxId.js is the client's copy of checkW9Tin();
// scripts/test-w9-input-checks.js runs one table against both.

"use strict";

const { StandardFontEmbedder, StandardFonts } = require("pdf-lib");

// ------------------------------------------------------------
// TIN (Part I)
// ------------------------------------------------------------

const INVALID_TIN_MESSAGE = "Enter a 9-digit SSN or EIN.";

// Part I has nine boxes, 3-2-4 for an SSN or 2-7 for an EIN, so a TIN is nine
// digits, written with hyphens or spaces between them or none at all
// (123-45-6789, 12-3456789, 123456789). Anything else printed either a short
// number or nothing at all. The value is not rewritten: a TIN that passes is
// stored and printed exactly as it was before this check existed.
//
// The length cap runs before the pattern, and the pattern is one bounded
// character class.
const TIN_MAX_LENGTH = 32;
const TIN_CHARS_RE = /^[0-9 -]{1,32}$/;
const TIN_DIGITS = 9;

function tinRefusal() {
	return { ok: false, code: "INVALID_TIN", message: INVALID_TIN_MESSAGE };
}

// Absent (undefined, null or "") answers { ok: true, absent: true }: whether a
// TIN is required is the caller's check.
function checkW9Tin(raw) {
	if (raw === undefined || raw === null || raw === "") return { ok: true, absent: true };
	if (typeof raw !== "string" || raw.length > TIN_MAX_LENGTH || !TIN_CHARS_RE.test(raw)) return tinRefusal();
	if (raw.replace(/[ -]/g, "").length !== TIN_DIGITS) return tinRefusal();
	return { ok: true, value: raw };
}

// ------------------------------------------------------------
// Text the W-9's font can print
// ------------------------------------------------------------

const UNSUPPORTED_CHARACTERS_MESSAGE = "Please enter this as it appears on your U.S. tax return, using Latin characters.";

// The longest value each W-9 text field takes, in UTF-16 code units (what a
// string's length and an input's maxlength count): one line of the form for
// the legal name, business name and signature, two for the address. A field
// named neither way gets the shortest cap there is. Checked before any
// per-character work, the way checkW9Tin() checks its length before its
// pattern, so an over-long value costs one comparison. /invest's inputs carry
// the same numbers as maxlength.
const W9_TEXT_MAX_LENGTH = { legal_name: 200, dba: 200, address: 300 };
const W9_SIGNATURE_MAX_LENGTH = 200;
const W9_DEFAULT_MAX_LENGTH = 200;

function maxLengthOf(field, font) {
	if (font === "signature") return W9_SIGNATURE_MAX_LENGTH;
	return Object.prototype.hasOwnProperty.call(W9_TEXT_MAX_LENGTH, field) ? W9_TEXT_MAX_LENGTH[field] : W9_DEFAULT_MAX_LENGTH;
}

function tooLongMessage(max) {
	return `This is too long. Please keep it to ${max} characters or fewer.`;
}

// The fonts fillW9Form() uses: Helvetica for the form's fields, Helvetica Bold
// for the signature. pdf-lib's standard fonts encode text as WinAnsi, and a
// character outside it makes the fill throw. The question is put to pdf-lib's
// own font, never to a character list kept here, so the answer is the fill's.
const W9_FONTS = {
	field: StandardFontEmbedder.for(StandardFonts.Helvetica),
	signature: StandardFontEmbedder.for(StandardFonts.HelveticaBold),
};

// pdf-lib's own test, one code point at a time, the way its encoder walks the
// text. It allocates nothing and stops at the first character the font has
// no code for. Only ever given a value within its length cap.
function fontCanPrint(embedder, text) {
	for (const ch of text) {
		if (!embedder.encoding.canEncodeUnicodeCodePoint(ch.codePointAt(0))) return false;
	}
	return true;
}

// `fields` is a list of { field, value, font }: `field` names the value in the
// refusal, and `font` is "field" (the default) or "signature". Checked in
// order; the first value refused is the one named. Empty and absent values
// print nothing and pass. A value over its length cap is refused as
// VALUE_TOO_LONG before its characters are looked at. A number is printed as
// its digits; any other non-string is refused (the routes refuse it as
// INVALID_FIELD first).
function checkW9Printable(fields) {
	for (const { field, value, font = "field" } of fields) {
		if (value === undefined || value === null || value === "") continue;
		const text = typeof value === "string" ? value
			: typeof value === "number" && Number.isFinite(value) ? String(value) : null;
		const max = maxLengthOf(field, font);
		if (text !== null && text.length > max) return { ok: false, code: "VALUE_TOO_LONG", field, message: tooLongMessage(max) };
		const embedder = Object.prototype.hasOwnProperty.call(W9_FONTS, font) ? W9_FONTS[font] : null;
		if (text === null || !embedder || !fontCanPrint(embedder, text)) {
			return { ok: false, code: "UNSUPPORTED_CHARACTERS", field, message: UNSUPPORTED_CHARACTERS_MESSAGE };
		}
	}
	return { ok: true };
}

// The request fields on step 1 of /invest that the W-9 prints, in the form's
// order. The TIN has its own check above.
const W9_TEXT_FIELDS = ["legal_name", "dba", "address"];

// Those fields of a request body, and, when `signature` names a body field,
// the W-9 signature it holds, in the signature font. (The application's
// signatures.w9.text is nested; its route checks it with checkW9Printable.)
function checkW9Text(source, { signature } = {}) {
	const obj = source !== null && typeof source === "object" ? source : {};
	const fields = W9_TEXT_FIELDS.map((field) => ({ field, value: obj[field] }));
	if (signature) fields.push({ field: signature, value: obj[signature], font: "signature" });
	return checkW9Printable(fields);
}

module.exports = {
	INVALID_TIN_MESSAGE,
	UNSUPPORTED_CHARACTERS_MESSAGE,
	TIN_MAX_LENGTH,
	TIN_CHARS_RE,
	W9_TEXT_FIELDS,
	W9_TEXT_MAX_LENGTH,
	W9_SIGNATURE_MAX_LENGTH,
	checkW9Tin,
	checkW9Printable,
	checkW9Text,
};
