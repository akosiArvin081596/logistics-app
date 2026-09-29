/**
 * The consent statement a signer is shown before they can sign an onboarding
 * document, and the exact string transmitted with the signature.
 *
 * ⚠️ ONE CONSTANT, RENDERED AND SENT. Both signing modals bind their checkbox
 * label to this value AND put it in the request, so the wording stored on the
 * row is provably the wording the signer read. Two literals — one in the
 * template, one in the payload — would drift the first time somebody reworded
 * the label, and a stored consent statement that differs from what was
 * displayed is worse evidence than none: it is a record of an assertion nobody
 * made.
 *
 * The server records the same sentence as `SIGNING_CONSENT_TEXT_EXPECTED` in
 * server.js, so a reviewer can see what the stored field is expected to say. It
 * is NOT a fallback: a client that transmits the flag without the text gets ""
 * stored, never this sentence, and nothing overwrites what is sent — what the
 * signer saw is what gets stored.
 */
export const SIGNING_CONSENT_TEXT = 'I have read and agree to the terms of this document'

/**
 * The payload shape the server requires. `agreed` is checked with `=== true`
 * server-side, so this must stay a real boolean — not the ref, not a truthy
 * string.
 */
export function buildConsent(agreed) {
	return { agreed: agreed === true, text: SIGNING_CONSENT_TEXT }
}
