// The email-address rule for the public application forms (/apply, /invest).
//
// THE SERVER DECIDES. lib/public-form-input.js checkPublicEmail() judges every
// submission, and this file is the client's copy of that same rule, so an
// applicant hears about a mistyped address on the step where they typed it
// rather than at the final submit, several steps (and, on /invest, several
// signatures) later.
//
// It must say exactly what the server says. scripts/test-email-address-client.mjs
// pins the two to the same pattern, length limit, messages and verdicts, and
// fails on any drift. Change the rule in both files together.
//
// Pure: no network, no DOM, no Vue.

// RFC 5321: 254 characters for the address itself. Checked before the pattern.
export const EMAIL_MAX_LENGTH = 254

// Printable ASCII only. Local part: letters, digits, "." and the RFC 5322
// atext symbols less "?", "#" and "%". Domain labels: letters, digits and "-".
const EMAIL_LOCAL_CHARS = "A-Za-z0-9!$&'*+/=^_`{|}~.-"
const EMAIL_LABEL_CHARS = 'A-Za-z0-9-'

// Linear by construction: each quantifier is one character class, and no two
// adjacent quantifiers accept the same character.
export const EMAIL_RE = new RegExp(
  `^[${EMAIL_LOCAL_CHARS}]+@[${EMAIL_LABEL_CHARS}]+(?:\\.[${EMAIL_LABEL_CHARS}]+)+$`
)

export const EMAIL_MESSAGES = {
  invalid: 'Please provide a valid email address.',
  multiple: 'Please enter a single email address.',
  too_long: `That email address is too long (${EMAIL_MAX_LENGTH} characters at most).`,
}

function refusal(reason) {
  return { ok: false, reason, message: EMAIL_MESSAGES[reason] }
}

// { ok: true, value } or { ok: false, reason, message }. The value is checked
// exactly as given, the same as on the server.
export function checkEmail(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return refusal('invalid')
  if (raw.length > EMAIL_MAX_LENGTH) return refusal('too_long')
  if (raw.includes(',') || raw.includes(';') || raw.indexOf('@') !== raw.lastIndexOf('@')) {
    return refusal('multiple')
  }
  if (!EMAIL_RE.test(raw)) return refusal('invalid')
  return { ok: true, value: raw }
}
