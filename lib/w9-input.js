// ============================================================
// Input checks for what the investor W-9 prints
// ============================================================
// fillW9Form() in server.js prints the legal name (Line 1), the business name
// (Line 2), the address (Lines 5 and 6), the TIN (Part I) and the signature.
// POST /api/public/investor-apply, the W-9 preview and step 1 of /invest (POST
// /api/public/investor-w9-check) check those values here, before anything is
// stored or rendered, so a value the form cannot hold is refused while the
// applicant can still correct it -- not discovered after the application is
// in, as a W-9 that was never produced. The driver's application (POST
// /api/public/apply) checks its SSN here too (checkW9Ssn).
//
// Pure: no network, no database, no filesystem. Every checker is total -- it
// never throws -- and answers { ok: true, ... } or
// { ok: false, code, message }: `message` is safe to show the applicant, `code`
// is the response's error code.
//
// client/src/lib/taxId.js is the client's copy of checkW9Tin() and
// checkW9Ssn(); scripts/test-w9-input-checks.js and
// scripts/test-driver-apply-inputs.js each run one table against both.

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
// SSN (the driver's W-9)
// ------------------------------------------------------------

const INVALID_SSN_MESSAGE = "Enter a 9-digit Social Security number.";

// A driver's W-9 is filled as an individual's (fillW9Form's "Sole Prop"), so
// the number POST /api/public/apply takes goes in Part I's SSN boxes, 3-2-4.
// It must pass checkW9Tin() above (nine digits, the length cap, one bounded
// class) and be written as an SSN: 123-45-6789 or 123456789. Spaces around it
// pass, as /apply has stored "123-45-6789 " before. The value is not
// rewritten: an SSN that passes is stored and printed as before.
//
// Runs only on what checkW9Tin() passed (a string of at most 32 characters),
// and every quantifier is bounded.
const SSN_SHAPE_RE = /^ {0,32}(?:\d{3}-\d{2}-\d{4}|\d{9}) {0,32}$/;

// Absent answers { ok: true, absent: true }, as checkW9Tin() does.
function checkW9Ssn(raw) {
	const tin = checkW9Tin(raw);
	if (tin.ok && tin.absent) return tin;
	if (!tin.ok || !SSN_SHAPE_RE.test(raw)) return { ok: false, code: "INVALID_SSN", message: INVALID_SSN_MESSAGE };
	return { ok: true, value: raw };
}

// ------------------------------------------------------------
// Text the W-9's font can print
// ------------------------------------------------------------

const UNSUPPORTED_CHARACTERS_MESSAGE = "Please enter this as it appears on your U.S. tax return, using Latin characters.";
// A value that is not text: the public forms' own INVALID_FIELD words
// (lib/public-form-input.js). Kept here rather than required from there, so
// this file loads with no relative require; scripts/test-w9-input-checks.js
// pins the two equal.
const INVALID_VALUE_MESSAGE = "Some of the submitted details are invalid. Please review the form and try again.";

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
// print nothing and pass. Any other value must be a string: a number, list,
// object or boolean is INVALID_FIELD, because fillW9Form() splits the address
// and draws the signature as text, and the check must pass only what the fill
// can take. A value over its length cap is refused as VALUE_TOO_LONG before
// its characters are looked at.
function checkW9Printable(fields) {
	for (const { field, value, font = "field" } of fields) {
		if (value === undefined || value === null || value === "") continue;
		if (typeof value !== "string") return { ok: false, code: "INVALID_FIELD", field, message: INVALID_VALUE_MESSAGE };
		const max = maxLengthOf(field, font);
		if (value.length > max) return { ok: false, code: "VALUE_TOO_LONG", field, message: tooLongMessage(max) };
		const embedder = Object.prototype.hasOwnProperty.call(W9_FONTS, font) ? W9_FONTS[font] : null;
		if (!embedder || !fontCanPrint(embedder, value)) {
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
	INVALID_SSN_MESSAGE,
	UNSUPPORTED_CHARACTERS_MESSAGE,
	INVALID_VALUE_MESSAGE,
	TIN_MAX_LENGTH,
	TIN_CHARS_RE,
	SSN_SHAPE_RE,
	W9_TEXT_FIELDS,
	W9_TEXT_MAX_LENGTH,
	W9_SIGNATURE_MAX_LENGTH,
	checkW9Tin,
	checkW9Ssn,
	checkW9Printable,
	checkW9Text,
};
