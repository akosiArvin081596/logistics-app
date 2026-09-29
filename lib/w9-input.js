// ============================================================
// Input checks for what the investor W-9 prints
// ============================================================
// fillW9Form() in server.js prints the TIN in Part I. POST
// /api/public/investor-apply and the W-9 preview check it here, before
// anything is stored or rendered, so a value the form cannot hold is refused
// while the applicant can still correct it -- not discovered after the
// application is in, as a W-9 that was never produced.
//
// Pure: no network, no database, no filesystem. Every checker is total -- it
// never throws -- and answers { ok: true, ... } or
// { ok: false, code, message }: `message` is safe to show the applicant, `code`
// is the response's error code.
//
// client/src/lib/taxId.js is the client's copy of checkW9Tin();
// scripts/test-w9-input-checks.js runs one table against both.

"use strict";

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

module.exports = {
	INVALID_TIN_MESSAGE,
	TIN_MAX_LENGTH,
	TIN_CHARS_RE,
	checkW9Tin,
};
