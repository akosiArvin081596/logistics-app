// The EIN/SSN rule for /invest, and the SSN rule for /apply.
//
// THE SERVER DECIDES. lib/w9-input.js checkW9Tin() judges every submission and
// W-9 preview, and this file is the client's copy of that same rule, so an
// applicant hears about a mistyped number on step 1, where they typed it,
// rather than at the final submit, after every document has been signed.
// checkSsn() below is the copy of checkW9Ssn(), the rule for a driver's SSN.
//
// It must say exactly what the server says. scripts/test-w9-input-checks.js
// runs one table of TINs, and scripts/test-driver-apply-inputs.js one table of
// SSNs, against both and fails on any drift. Change the rule in both files
// together.
//
// Pure: no network, no DOM, no Vue.

export const INVALID_TIN_MESSAGE = 'Enter a 9-digit SSN or EIN.'

// Nine digits, with hyphens or spaces between them or none at all
// (123-45-6789, 12-3456789, 123456789). The length cap runs before the pattern.
export const TIN_MAX_LENGTH = 32
export const TIN_CHARS_RE = /^[0-9 -]{1,32}$/
const TIN_DIGITS = 9

// { ok: true } for a TIN the W-9 can print, or for none at all (whether one is
// required is the form's check); { ok: false, message } otherwise.
export function checkTin(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (typeof raw !== 'string' || raw.length > TIN_MAX_LENGTH || !TIN_CHARS_RE.test(raw)) {
    return { ok: false, message: INVALID_TIN_MESSAGE }
  }
  if (raw.replace(/[ -]/g, '').length !== TIN_DIGITS) return { ok: false, message: INVALID_TIN_MESSAGE }
  return { ok: true }
}

export const INVALID_SSN_MESSAGE = 'Enter a 9-digit Social Security number.'

// A TIN checkTin() accepts, written as an SSN: 123-45-6789 or 123456789, with
// spaces around it allowed. The driver's W-9 prints it in the SSN boxes.
export const SSN_SHAPE_RE = /^ {0,32}(?:\d{3}-\d{2}-\d{4}|\d{9}) {0,32}$/

// { ok: true } for an SSN the driver's W-9 can print, or for none at all;
// { ok: false, message } otherwise.
export function checkSsn(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (!checkTin(raw).ok || !SSN_SHAPE_RE.test(raw)) return { ok: false, message: INVALID_SSN_MESSAGE }
  return { ok: true }
}
