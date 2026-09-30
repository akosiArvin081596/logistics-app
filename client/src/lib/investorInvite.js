// The personal invitation link on the public /invest form (`/invest?invite=<token>`).
//
// An admin creates an invitation on /investors with payment terms for one person.
// The link carries a 43-character token; the page looks the invitation up with
// GET /api/public/investor-invite (token in the X-Invite-Token header), shows the
// terms read-only, and sends the token with each document preview and with the
// final submit. Everything here is pure, so scripts/test-investor-invite-client.mjs
// can run it without a browser.
//
// ⚠️ The words in INVITE_MESSAGES are investor-facing and awaiting the client's
// sign-off: docs/investor-portal-copy.md §15 lists them, and the runner fails if
// the two ever differ. Reword both together.

// Same shape as the server's INVITE_TOKEN_RE (lib/investor-payment-terms.js):
// crypto.randomBytes(32) in base64url is always exactly 43 characters.
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

// The response header an invitation preview carries: the terms revision the PDF
// was rendered with.
export const PAYMENT_TERMS_REVISION_HEADER = 'X-Payment-Terms-Revision'

// The two documents whose wording depends on the terms. The W-9 never does.
export const TERMS_DOC_KEYS = Object.freeze(['master_agreement', 'vehicle_lease'])

// Client-only code: the lookup got no usable answer (offline, a timeout, the rate
// limit, a server error). Not the applicant's fault, so it offers a retry rather
// than calling the link invalid.
export const INVITE_UNAVAILABLE = 'INVITE_UNAVAILABLE'

export const INVITE_MESSAGES = Object.freeze({
  INVITE_NOT_FOUND: "This invitation link isn't valid. Please ask LogisX for a new link.",
  INVITE_USED: 'This invitation has already been used to submit an application. If you just submitted, it was received.',
  INVITE_REVOKED: 'This invitation was withdrawn. Please contact LogisX.',
  INVITE_EXPIRED: 'This invitation has expired. Please ask LogisX for a new link.',
  INVITE_TERMS_CHANGED: 'LogisX updated the payment terms in your invitation. Please review and sign the agreements again.',
  [INVITE_UNAVAILABLE]: "We couldn't load your invitation just now. Please check your connection and try again.",
})

// The server's refusals of an invitation token (404 / 410), on the lookup, the
// preview and the submit alike.
const REFUSAL_CODES = new Set(['INVITE_NOT_FOUND', 'INVITE_USED', 'INVITE_REVOKED', 'INVITE_EXPIRED'])

export function inviteErrorMessage(code) {
  return Object.prototype.hasOwnProperty.call(INVITE_MESSAGES, code)
    ? INVITE_MESSAGES[code]
    : INVITE_MESSAGES[INVITE_UNAVAILABLE]
}

// True only for a 404/410 that names an invitation refusal. A 404 with any other
// code (an unknown document key, say) is not about the invitation and must not
// end it.
export function isInviteRefusal(status, code) {
  return (status === 404 || status === 410) && REFUSAL_CODES.has(code)
}

// What a failed lookup means for the page. The lookup route answers every
// malformed or unknown token with 404, so a 404/410 without a known code is still
// "not found"; anything else is a lookup that did not get an answer.
export function inviteLookupFailureCode(status, code) {
  if (status === 404 || status === 410) return REFUSAL_CODES.has(code) ? code : 'INVITE_NOT_FOUND'
  return INVITE_UNAVAILABLE
}

// `?invite=` as the router hands it over: a string, an array when the key is
// repeated, or absent. A repeated key is ambiguous, so it counts as no token
// rather than picking one.
export function inviteTokenFromQuery(query) {
  const v = query ? query.invite : undefined
  return typeof v === 'string' ? v.trim() : ''
}

// A terms revision off the wire: a number from JSON, or the header's string.
// Anything that is not a whole number reads as "unknown".
function toRevision(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
  if (typeof v === 'string') {
    const s = v.trim()
    return /^\d{1,9}$/.test(s) ? Number(s) : null
  }
  return null
}

// True only when BOTH revisions are known and differ. A missing header is not a
// change: there is nothing to compare, and the submit carries the revision the
// server checks anyway (409 INVITE_TERMS_CHANGED).
export function revisionChanged(a, b) {
  const x = toRevision(a)
  const y = toRevision(b)
  return x !== null && y !== null && x !== y
}

// The read-only card's content, or null when there is nothing to show: no active
// invitation, or one with the standard contract terms.
export function paymentTermsView({ active, isStandard, terms, display } = {}) {
  if (!active || isStandard || !terms) return null
  return {
    type: terms.type === 'lease' ? 'lease' : 'split',
    typeLabel: typeof display?.typeLabel === 'string' ? display.typeLabel : '',
    amountLabel: typeof display?.amountLabel === 'string' ? display.amountLabel : '',
    details: typeof terms.details === 'string' ? terms.details : '',
  }
}
