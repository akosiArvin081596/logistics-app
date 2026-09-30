#!/usr/bin/env node
// The personal invitation link on /invest — the CLIENT's side.
//
// WHY THIS EXISTS. `/invest?invite=<token>` shows an investor the payment terms
// LogisX set for them, read-only, and sends the token with each preview and the
// submit (client/src/lib/investorInvite.js, composables/useInvestorInvite.js,
// views/InvestorApplyView.vue). The words an applicant reads are awaiting the
// client's sign-off in docs/investor-portal-copy.md §15, and the page must not
// change at all without an invitation. This runner holds those together:
//
//   §1 INVITE_TOKEN_RE accepts exactly a 43-character base64url token
//   §2 the code → message map is the §15 wording, word for word, and so are
//      the page's security wording and payment answers (§15.5, §15.6)
//   §3 revisionChanged() fires only on two known, different revisions
//   §4 refusals, the lookup failure code and the ?invite= reader
//   §5 the terms card has nothing an applicant can edit; a failed preview is
//      shown with a retry, in the sign modal and in the review window's viewer
//   §6 without an invitation the payloads are what they always were, and the
//      token is never written to the draft
//   §7 DISCRIMINATION — defang the token pattern, require an assertion to flip
//   §8 the admin side: the invite form's "contract only" warning stays up
//      until the server says lease payouts are on; the payout basis words
//      (L1, L4-L6), the month bounds and the accept line; two sabotages
//
// No network, no DOM, no Vue runtime.
//
//   node scripts/test-investor-invite-client.mjs      # exits 1 on any failure

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import {
  INVITE_TOKEN_RE,
  INVITE_MESSAGES,
  INVITE_UNAVAILABLE,
  PAYMENT_TERMS_REVISION_HEADER,
  TERMS_DOC_KEYS,
  inviteErrorMessage,
  inviteLookupFailureCode,
  inviteTokenFromQuery,
  isInviteRefusal,
  paymentTermsView,
  revisionChanged,
} from '../client/src/lib/investorInvite.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
function ok(name, cond) {
  if (cond) console.log(`ok    ${name}`)
  else { console.log(`FAIL  ${name}`); failed++ }
}
const ch = (code) => String.fromCodePoint(code)

// ══ §1 — the token pattern ══════════════════════════════════════════════════
console.log('\n§1  INVITE_TOKEN_RE')
function tokenChecks(re) {
  const real = Array.from({ length: 300 }, () => crypto.randomBytes(32).toString('base64url'))
  const good = 'A'.repeat(21) + '-_' + 'z9'.repeat(10)
  return {
    realTokens: real.every((t) => t.length === 43 && re.test(t)),
    allAlphabet: re.test(good) && good.length === 43,
    short: !re.test(good.slice(1)),
    long: !re.test(good + 'A'),
    padded: !re.test(good.slice(0, 42) + '='),
    base64Plus: !re.test(good.slice(0, 42) + '+'),
    base64Slash: !re.test(good.slice(0, 42) + '/'),
    dot: !re.test(good.slice(0, 42) + '.'),
    space: !re.test(' ' + good.slice(1)),
    trailingNewline: !re.test(good + '\n'),
    nonAscii: !re.test(good.slice(0, 42) + ch(0xe9)),
    zeroWidth: !re.test(good.slice(0, 42) + ch(0x200b)),
    fullwidthDigit: !re.test(good.slice(0, 42) + ch(0xff11)),
    empty: !re.test(''),
  }
}
const t1 = tokenChecks(INVITE_TOKEN_RE)
ok('accepts 300 real tokens (randomBytes(32) in base64url, 43 characters)', t1.realTokens)
ok('accepts every base64url character, including - and _', t1.allAlphabet)
ok('refuses 42 characters', t1.short)
ok('refuses 44 characters', t1.long)
ok('refuses base64 padding (=)', t1.padded)
ok('refuses standard base64 + and /', t1.base64Plus && t1.base64Slash)
ok('refuses a dot, a space, a trailing newline', t1.dot && t1.space && t1.trailingNewline)
ok('refuses non-ASCII look-alikes (é, a zero-width space, a fullwidth digit)', t1.nonAscii && t1.zeroWidth && t1.fullwidthDigit)
ok('refuses the empty string', t1.empty)
ok('the pattern carries no flags', INVITE_TOKEN_RE.flags === '')
const serverLib = path.join(ROOT, 'lib/investor-payment-terms.js')
if (fs.existsSync(serverLib)) {
  const m = /INVITE_TOKEN_RE\s*=\s*(\/\^\[A-Za-z0-9_-\]\{43\}\$\/)/.exec(fs.readFileSync(serverLib, 'utf8'))
  ok('the same pattern as the server (lib/investor-payment-terms.js)', !!m && m[1] === String(INVITE_TOKEN_RE))
} else {
  console.log('info  lib/investor-payment-terms.js is not on this branch; server parity not checked')
}

// ══ §2 — the messages are the §15 wording ═══════════════════════════════════
console.log('\n§2  code → message, against docs/investor-portal-copy.md §15')
const EXPECTED = {
  INVITE_NOT_FOUND: "This invitation link isn't valid. Please ask LogisX for a new link.",
  INVITE_USED: 'This invitation has already been used to submit an application. If you just submitted, it was received.',
  INVITE_REVOKED: 'This invitation was withdrawn. Please contact LogisX.',
  INVITE_EXPIRED: 'This invitation has expired. Please ask LogisX for a new link.',
  INVITE_TERMS_CHANGED: 'LogisX updated the payment terms in your invitation. Please review and sign the agreements again.',
  [INVITE_UNAVAILABLE]: "We couldn't load your invitation just now. Please check your connection and try again.",
}
ok('exactly the six codes', JSON.stringify(Object.keys(INVITE_MESSAGES).sort()) === JSON.stringify(Object.keys(EXPECTED).sort()))
for (const [code, msg] of Object.entries(EXPECTED)) {
  ok(`${code}: the agreed wording`, INVITE_MESSAGES[code] === msg && inviteErrorMessage(code) === msg)
}
const DOC = read('docs/investor-portal-copy.md')
const s15a = DOC.indexOf('\n## 15.')
const s15b = DOC.indexOf('\n## ', s15a + 1)
const S15 = s15a >= 0 ? DOC.slice(s15a, s15b < 0 ? undefined : s15b) : ''
ok('docs/investor-portal-copy.md has a §15', S15.length > 0)
for (const [code, msg] of Object.entries(INVITE_MESSAGES)) {
  ok(`§15 lists the ${code} message word for word`, S15.includes('`' + msg + '`'))
}
ok('§15 marks its lines as awaiting approval', (S15.match(/\*\*Awaiting approval\*\*/g) || []).length >= Object.keys(INVITE_MESSAGES).length)
const CARD = read('client/src/components/invest/InvitePaymentTermsCard.vue')
const NOTE = 'These terms were set by LogisX for your agreement and appear in Amendment No. 1 of the documents you sign.'
ok('the card carries the agreed note', CARD.includes(NOTE))
ok('§15 lists the card note word for word', S15.includes('`' + NOTE + '`'))
const PREVIEW_MSG = /const PREVIEW_FAILED_MESSAGE = "([^"]+)"/.exec(read('client/src/views/InvestorApplyView.vue'))
ok('§15 lists the failed-preview line word for word', !!PREVIEW_MSG && S15.includes('`' + PREVIEW_MSG[1] + '`'))
// §15.5 / §15.6: the page's security wording and the payment answers, as shipped.
{
  const view = read('client/src/views/InvestorApplyView.vue')
  const kb = JSON.parse(read('client/src/wizard/data/knowledge-base.json')).faqs
  const note = (/class="bank-security-note"[\s\S]*?<span>([^<]+)<\/span>/.exec(view) || [])[1] || ''
  const badge = (/class="trust-badge"[\s\S]*?<span>([^<]+)<\/span>/.exec(view) || [])[1] || ''
  ok('§15 lists the Step 3 banking note word for word', !!note && S15.includes('`' + note + '`'))
  ok('§15 lists the Step 1 badge word for word', !!badge && S15.includes('`' + badge + '`'))
  ok('the page no longer claims 256-bit or encrypted storage', !/256-bit|encrypted and stored/i.test(view))
  for (const id of ['why_address', 'what_is_logisx', 'how_often_paid']) {
    ok(`§15 lists the ${id} answer word for word`, typeof kb[id]?.a === 'string' && S15.includes('`' + kb[id].a + '`'))
  }
  ok('the address answer no longer promises no third-party sharing', !/third part/i.test(kb.why_address.a))
  const CAVEAT = "That's the standard agreement. If LogisX set different payment terms in your invitation, they're shown on the documents step and in Amendment No. 1 of your agreements."
  ok('the two profit-share answers end with the invitation caveat', kb.what_is_logisx.a.endsWith(CAVEAT) && kb.how_often_paid.a.endsWith(CAVEAT))
}
ok('an unknown code reads as "could not load", never as a verdict on the link',
  inviteErrorMessage('SOMETHING_ELSE') === EXPECTED[INVITE_UNAVAILABLE] && inviteErrorMessage(undefined) === EXPECTED[INVITE_UNAVAILABLE])
ok('inherited names are not codes (toString, __proto__, constructor)',
  ['toString', '__proto__', 'constructor'].every((c) => inviteErrorMessage(c) === EXPECTED[INVITE_UNAVAILABLE]))

// ══ §3 — revisionChanged ═══════════════════════════════════════════════════
console.log('\n§3  revisionChanged(a, b)')
const CASES = [
  [1, 1, false, 'same number'],
  [1, 2, true, 'different numbers'],
  ['2', 2, false, 'the header string and the same number'],
  ['3', 2, true, 'the header string and a different number'],
  [' 3 ', 2, true, 'a header with surrounding spaces'],
  [2, '3', true, 'either order'],
  [null, 2, false, 'no header (null)'],
  [undefined, 2, false, 'no header (undefined)'],
  ['', 2, false, 'an empty header'],
  [2, null, false, 'no loaded revision'],
  ['abc', 2, false, 'a header that is not a number'],
  ['2.0', 3, false, 'a decimal string'],
  ['1e3', 1000, false, 'exponent notation'],
  ['0x2', 1, false, 'a hex string'],
  ['-1', 1, false, 'a negative string'],
  ['1234567890', 1, false, 'more than nine digits'],
  [1.5, 1, false, 'a fractional number'],
  [NaN, 1, false, 'NaN'],
  [Infinity, 1, false, 'Infinity'],
  [-1, 1, false, 'a negative number'],
  [0, 1, true, 'zero is a known revision'],
]
for (const [a, b, want, label] of CASES) ok(`${label} → ${want}`, revisionChanged(a, b) === want)
ok('the header name the preview answers with', PAYMENT_TERMS_REVISION_HEADER === 'X-Payment-Terms-Revision')

// ══ §4 — refusals, lookup failures, the query reader, the card model ═══════
console.log('\n§4  refusals, lookup failures, ?invite=, the card model')
ok('404 INVITE_NOT_FOUND and the three 410s are refusals',
  isInviteRefusal(404, 'INVITE_NOT_FOUND') && ['INVITE_USED', 'INVITE_REVOKED', 'INVITE_EXPIRED'].every((c) => isInviteRefusal(410, c)))
ok('a 404 about something else is not (an unknown document key must not end the invitation)',
  !isInviteRefusal(404, 'NOT_FOUND') && !isInviteRefusal(404, '') && !isInviteRefusal(404, undefined))
ok('409 INVITE_TERMS_CHANGED is not a refusal (it is a notice)', !isInviteRefusal(409, 'INVITE_TERMS_CHANGED'))
ok('a refusal code on another status is not a refusal', !isInviteRefusal(500, 'INVITE_USED') && !isInviteRefusal(200, 'INVITE_USED'))
ok('lookup: a known 404/410 code is kept', inviteLookupFailureCode(410, 'INVITE_EXPIRED') === 'INVITE_EXPIRED' && inviteLookupFailureCode(404, 'INVITE_NOT_FOUND') === 'INVITE_NOT_FOUND')
ok('lookup: a 404 without a known code is "not found"', inviteLookupFailureCode(404, '') === 'INVITE_NOT_FOUND')
ok('lookup: a timeout, the rate limit or a server error is "could not load"',
  [0, 429, 500, 502, 503].every((s) => inviteLookupFailureCode(s, '') === INVITE_UNAVAILABLE))
ok('?invite= as a string is read (trimmed)', inviteTokenFromQuery({ invite: ' abc ' }) === 'abc')
ok('a repeated ?invite= is no token', inviteTokenFromQuery({ invite: ['a', 'b'] }) === '')
ok('no ?invite= is no token', inviteTokenFromQuery({}) === '' && inviteTokenFromQuery(undefined) === '')
ok('the terms documents are the master agreement and the lease, never the W-9',
  JSON.stringify(TERMS_DOC_KEYS) === JSON.stringify(['master_agreement', 'vehicle_lease']))
const leaseInvite = {
  active: true, isStandard: false,
  terms: { type: 'lease', leaseAmountCents: 200000, details: 'Line one\nLine two' },
  display: { typeLabel: 'Fixed monthly lease payment', amountLabel: '$2,000.00' },
}
ok('an active custom invitation gives the card its four values',
  JSON.stringify(paymentTermsView(leaseInvite)) === JSON.stringify({ type: 'lease', typeLabel: 'Fixed monthly lease payment', amountLabel: '$2,000.00', details: 'Line one\nLine two' }))
ok('no card without an active invitation, for standard terms, or without terms',
  paymentTermsView({ ...leaseInvite, active: false }) === null &&
  paymentTermsView({ ...leaseInvite, isStandard: true }) === null &&
  paymentTermsView({ ...leaseInvite, terms: null }) === null &&
  paymentTermsView() === null)

// ══ §5 — read-only surfaces ═════════════════════════════════════════════════
console.log('\n§5  nothing editable where the terms are shown')
const EDITABLE = /<input\b|<select\b|<textarea\b|contenteditable|v-model/i
// Markup only: the comments explain the rule in the very words it forbids.
const templateOf = (src) => src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '')
ok('InvitePaymentTermsCard.vue: no input, select, textarea, contenteditable or v-model', !EDITABLE.test(templateOf(CARD)))
ok('the card renders the details as text (no v-html)', !/v-html/.test(CARD))
ok('the card keeps line breaks (white-space: pre-wrap on the details)', /\.terms-details\s*\{[^}]*white-space:\s*pre-wrap/.test(CARD))
const VIEW = read('client/src/views/InvestorApplyView.vue')
const r1 = VIEW.indexOf('data-test="review-terms"')
const r2 = VIEW.indexOf('<!-- Step 2: Documents -->', r1)
const REVIEW_TERMS = r1 >= 0 && r2 > r1 ? VIEW.slice(r1, r2) : ''
ok('the review window has a Payment Terms section', REVIEW_TERMS.includes('Payment Terms'))
ok('…with nothing editable in it and no v-html', REVIEW_TERMS.length > 0 && !EDITABLE.test(REVIEW_TERMS) && !/v-html/.test(REVIEW_TERMS))
const MODAL = read('client/src/components/invest/InvestorSignModal.vue')
ok('the sign modal shows the same card, tagged sign-terms', /<InvitePaymentTermsCard v-if="paymentTerms" :payment-terms="paymentTerms" data-test="sign-terms" \/>/.test(MODAL))
ok('the view passes the sign modal its terms only for the two terms documents',
  /const signTerms = computed\(\(\) => \(TERMS_DOC_KEYS\.includes\(selectedDoc\.value\?\.doc_key\) \? inviteTerms\.value : null\)\)/.test(VIEW) &&
  /:payment-terms="signTerms"/.test(VIEW))

// The sign dialog must sit above every layer of the guided tour, or the tour's
// minimized tab covers its close button (it did, at 999 under 9999).
const WIZARD_DIR = path.join(ROOT, 'client/src/wizard/components')
const wizardZ = fs.readdirSync(WIZARD_DIR).filter((f) => f.endsWith('.vue'))
  .flatMap((f) => [...fs.readFileSync(path.join(WIZARD_DIR, f), 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])))
const modalZ = Number((/\.modal-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(MODAL) || [])[1])
ok(`the sign dialog (z-index ${modalZ}) stacks above the guided tour (highest ${Math.max(...wizardZ)})`, wizardZ.length > 0 && modalZ > Math.max(...wizardZ))
ok('Escape closes the sign dialog, caught before the tour hears it',
  /window\.addEventListener\('keydown', onKeydown, true\)/.test(MODAL) && /e\.key !== 'Escape'/.test(MODAL) && /e\.stopPropagation\(\)/.test(MODAL))
ok('a failed preview shows why, with a retry, instead of "Loading document..." for good',
  /v-else-if="pdfError"/.test(MODAL) && /\$emit\('retry-preview'\)/.test(MODAL) && /@retry-preview="retryPreview"/.test(VIEW) && /previewError\.value = message/.test(VIEW))
ok('the review window\'s viewer opens on the click and shows a failed preview with a retry, never silently',
  /<div v-if="reviewDoc" class="pdf-viewer-overlay"/.test(VIEW) && /v-else-if="reviewPdfError"/.test(VIEW) &&
  /@click="retryReviewPdf"/.test(VIEW) && /reviewPdfError\.value = message/.test(VIEW) && /reviewPdfError\.value = PREVIEW_FAILED_MESSAGE/.test(VIEW))

// ══ §6 — no invitation, no change; the token never reaches the draft ═══════
console.log('\n§6  plain /invest is unchanged, and the token stays out of the draft')
function lift(src, head) {
  const a = src.indexOf(head)
  if (a < 0) throw new Error(`not found: ${head}`)
  const b = src.indexOf('\n}\n', a)
  return src.slice(a, b + 2)
}
const ADD_SRC = lift(VIEW, 'function addInviteToken(')
const addInviteToken = (invite) => new Function('invite', `${ADD_SRC}\nreturn addInviteToken;`)(invite)
{
  const payload = { legal_name: 'QA-TEST Holdings', vehicles: [], banking: {} }
  const before = JSON.stringify(payload)
  const sent = addInviteToken({ active: false, token: 'x'.repeat(43), revision: 3 })(payload)
  ok('no invitation: nothing is added to the payload', sent === null && JSON.stringify(payload) === before)
}
{
  const payload = { legal_name: 'QA-TEST Holdings' }
  const sent = addInviteToken({ active: true, token: 'y'.repeat(43), revision: 4 })(payload)
  ok('an active invitation adds invite_token only, and reports the revision it was sent under',
    JSON.stringify(Object.keys(payload)) === JSON.stringify(['legal_name', 'invite_token']) && payload.invite_token === 'y'.repeat(43) && sent.revision === 4)
}
ok('invite_token is written only inside addInviteToken', (VIEW.match(/invite_token\s*=/g) || []).length === 1 && ADD_SRC.includes('payload.invite_token = invite.token'))
ok('invite_terms_revision is sent only with a token', /if \(sent\) body\.invite_terms_revision = sent\.revision/.test(VIEW))
const SAVE_SRC = lift(VIEW, 'function saveState(')
// Code only: its comment says what it leaves out, token included.
const SAVE_CODE = SAVE_SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
ok('saveState() writes nothing about the invitation', SAVE_CODE.includes('draft.save(') && !/invite|token/i.test(SAVE_CODE))
ok('the finished draft keeps the flag and the name only', /draft\.save\(\{ completed: true, completedName: completedName\.value \}\)/.test(SAVE_SRC))
ok('completedName is not a sensitive key, so the draft keeps it',
  /const SENSITIVE_FIELDS = \['ein_ssn', 'routing_number', 'account_number', 'signatures'\]/.test(VIEW))
ok('the success screen thanks completedName', /Thank you, <strong>\{\{ completedName \}\}<\/strong>\./.test(VIEW))
const COMPOSABLE = read('client/src/composables/useInvestorInvite.js')
ok('the composable touches no browser store', !/localStorage|sessionStorage|document\.cookie/.test(COMPOSABLE))
ok('the composable refuses a malformed token before any request',
  COMPOSABLE.indexOf('INVITE_TOKEN_RE.test(token)') > 0 && COMPOSABLE.indexOf('INVITE_TOKEN_RE.test(token)') < COMPOSABLE.indexOf("api.get('/api/public/investor-invite'"))
ok('the lookup sends the token in X-Invite-Token, not the URL', /'X-Invite-Token': token/.test(COMPOSABLE) && !/investor-invite\?/.test(COMPOSABLE))
ok('the submit waits 90 s', /const SUBMIT_TIMEOUT_MS = 90000/.test(VIEW) && /\{ timeout: SUBMIT_TIMEOUT_MS \}/.test(VIEW))

// ══ §7 — DISCRIMINATION ════════════════════════════════════════════════════
console.log('\n§7  DISCRIMINATION')
{
  const t = tokenChecks(/[A-Za-z0-9_-]{43}/)
  ok('an unanchored token pattern is caught (44 characters or a newline tail would pass it)', !(t.long && t.trailingNewline))
}

// ══ §8 — the admin side of a lease invitation ══════════════════════════════
// A lease in an invitation is recorded as the investor's payout basis when the
// application is accepted, and payouts use it only while lease payouts are
// switched on. The admin invite form says "contract only" until the server
// says they are on (a pending or failed answer keeps the warning), and the
// admin screens name a lease month in the agreed words.
console.log('\n§8  the admin invite form\'s lease warning, and the payout basis words')
const BASIS_PATH = path.join(ROOT, 'client/src/components/investors/payoutBasis.js')
const BASIS_SRC = fs.readFileSync(BASIS_PATH, 'utf8')
const basis = await import(pathToFileURL(BASIS_PATH).href)
// A copy of payoutBasis.js with one change, its relative imports made absolute
// so it loads from a data: URL.
async function basisWith(from, to) {
  if (!BASIS_SRC.includes(from)) throw new Error(`sabotage anchor not found: ${from}`)
  const src = BASIS_SRC.replace(from, to).replace(/from '\.\.\/\.\.\/(lib|utils)\//g, (_, dir) => `from '${pathToFileURL(path.join(ROOT, 'client/src', dir)).href}/`)
  return import(`data:text/javascript,${encodeURIComponent(src)}`)
}
function warningChecks(b) {
  return {
    pending: b.leasePayoutsOff(null) === true,
    missing: b.leasePayoutsOff(undefined) === true,
    off: b.leasePayoutsOff({ enabled: false }) === true,
    notABoolean: b.leasePayoutsOff({ enabled: 'true' }) === true,
    on: b.leasePayoutsOff({ enabled: true }) === false,
  }
}
{
  const w = warningChecks(basis)
  ok('the warning shows while the settings are pending or failed (null)', w.pending && w.missing)
  ok('the warning shows while lease payouts are off', w.off)
  ok('only enabled === true hides it (a string "true" does not)', w.notABoolean && w.on)
  const FORM = read('client/src/components/investors/InviteTermsForm.vue')
  ok('the form gates the warning on leasePayoutsOff(payoutSettings)',
    /<p v-if="leasePayoutsOff\(payoutSettings\)" class="itf-msg itf-msg-warn" role="note" data-test="invite-lease-warning">This changes the contract only\. Payouts are still calculated from the Split % column\.<\/p>/.test(FORM))
  ok('the settings start unknown and a failed read leaves them unknown',
    /const payoutSettings = ref\(null\)/.test(FORM) && /api\.get\('\/api\/investor-payout-settings'\)/.test(FORM) && /\.catch\(\(\) => \{ payoutSettings\.value = null \}\)/.test(FORM))
  ok('the amount field asks for whole dollars', /placeholder="2000"/.test(FORM) && /inputmode="numeric"/.test(FORM) && /Whole dollars between/.test(FORM))
}
{
  ok('L1: "Fixed monthly lease"', basis.LEASE_LABEL === 'Fixed monthly lease')
  const reason = (r, paidAmount, coveredDays = 30, daysInMonth = 30) => basis.leaseReasonText({ type: 'lease', leaseAmount: 2000, paidAmount, coveredDays, daysInMonth, reason: r })
  ok('L4: prorated, word for word', reason('prorated', 1097, 17, 31) === 'The lease covered 17 of 31 days this month, so this month pays $1,097.')
  ok('L5: downtime, word for word', reason('downtime', 0) === 'No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.')
  ok('L6: not in service, word for word', reason('not_in_service', 0) === 'No lease payment is owed for this month: no truck was in service under your lease.')
  ok('no reason for a full month, a split row or no basis', reason(null, 2000) === '' && basis.leaseReasonText({ type: 'split', reason: 'downtime' }) === '' && basis.leaseReasonText(undefined) === '')
  // L1 and L4-L6 have one client copy, lib/leasePayoutText.js: this module takes
  // them from there and keeps none of its own.
  const text = await import(pathToFileURL(path.join(ROOT, 'client/src/lib/leasePayoutText.js')).href)
  ok('L1 and L4-L6 come from lib/leasePayoutText.js', basis.LEASE_LABEL === text.LEASE_LABEL &&
    /import \{ LEASE_LABEL, leaseReasonLine \} from '\.\.\/\.\.\/lib\/leasePayoutText\.js'/.test(BASIS_SRC))
  ok('payoutBasis.js keeps no copy of them', !BASIS_SRC.includes(`'${text.LEASE_LABEL}'`) &&
    !Object.values(text.LEASE_REASON_TEXT).some((t) => BASIS_SRC.includes(t.slice(0, 30))))
  ok('the not-yet-applied status, word for word', basis.STATUS_OFF === 'Recorded, not yet applied: lease payouts are switched off. Payouts still use the Split %.')
  ok('the status says "recorded" only when something is', basis.basisStatus({ enabled: false, schedule: [] }).text !== basis.STATUS_OFF &&
    basis.basisStatus({ enabled: false, schedule: [{ effectiveMonth: '2026-09' }] }).text === basis.STATUS_OFF)
  ok('switched on: applied from the earliest scheduled month',
    basis.basisStatus({ enabled: true, schedule: [{ effectiveMonth: '2026-11' }, { effectiveMonth: '2026-09' }] }).text === 'Applied to payouts from September 2026')
  ok('the badge and the amounts', basis.leaseBadgeLabel(2000) === 'Lease $2,000/mo' && basis.formatLeaseAmount(2000.5) === '$2,000.50' && basis.formatLeaseAmount(-1) === '')
  ok('a lease basis, and a split one, in words',
    basis.describeBasis({ type: 'lease', leaseAmount: 2000, effectiveMonth: '2026-09' }) === 'Fixed monthly lease of $2,000 from September 2026' &&
    basis.currentBasisText({ type: 'split', splitPct: 50, effectiveMonth: null, source: 'default' }) === 'Split at 50% of net profit (default)')
}
{
  const b = basis.monthBounds('2026-09-30', '2026-09')
  ok('month bounds: the first editable month to this month + 12', b.min === '2026-09' && b.max === '2027-09' && b.start === '2026-09')
  ok('no settled month: no lower bound', basis.monthBounds('2026-09-30', null).min === '')
  ok('a first editable month later than this one is where the form starts', basis.monthBounds('2026-09-30', '2026-11').start === '2026-11')
  ok('December rolls into the next year', basis.monthBounds('2026-12-05', null).max === '2027-12' && basis.addMonths('2026-12', 1) === '2027-01')
  const bounds = { min: '2026-09', max: '2027-09' }
  const v = (f) => basis.validateBasisForm({ note: '', ...f }, bounds)
  ok('a whole-dollar lease becomes the PUT body', JSON.stringify(v({ type: 'lease', amount: '2000', month: '2026-10' }).body) === JSON.stringify({ type: 'lease', effectiveMonth: '2026-10', note: '', leaseAmount: 2000 }))
  ok('a split sends no amount', JSON.stringify(v({ type: 'split', amount: '2000', month: '2026-10' }).body) === JSON.stringify({ type: 'split', effectiveMonth: '2026-10', note: '' }))
  ok('cents are refused with the invite form\'s whole-dollar message', v({ type: 'lease', amount: '2000.50', month: '2026-10' }).errors?.amount === 'Enter the monthly lease amount in whole dollars, for example 2000.')
  ok('a settled month is refused', /is the earliest month that can change/.test(v({ type: 'lease', amount: '2000', month: '2026-08' }).errors?.month || ''))
  ok('a month past the upper bound is refused', /no later than September 2027/.test(v({ type: 'lease', amount: '2000', month: '2027-10' }).errors?.month || ''))
  ok('a malformed month is refused', !!v({ type: 'split', month: '2026-13' }).errors?.month && !!v({ type: 'split', month: '2026-9' }).errors?.month)
  ok('a note over 300 characters is refused', !!v({ type: 'split', month: '2026-10', note: 'x'.repeat(301) }).errors?.note && v({ type: 'split', month: '2026-10', note: 'x'.repeat(300) }).ok)
}
{
  ok('accept: a recorded lease in one line', basis.acceptBasisLine({ recorded: true, type: 'lease', leaseAmount: 2000, effectiveMonth: '2026-09' }) === 'Payout basis recorded: fixed monthly lease of $2,000 from September 2026')
  ok('accept: not recorded says why and where', basis.acceptBasisLine({ recorded: false, reason: 'LEASE_AMOUNT_WHOLE_DOLLARS' }) ===
    'No payout basis was recorded: the signed lease amount is not a whole number of dollars. Set it in the Payout Basis panel on the Investors page')
  ok('accept: no payoutBasis, no line', basis.acceptBasisLine(undefined) === '' && basis.acceptBasisLine(null) === '' && basis.acceptBasisLine({}) === '')
}
{
  const flipped = warningChecks(await basisWith('return settings?.enabled !== true', 'return !!settings && settings.enabled !== true'))
  ok('SABOTAGE: a warning that hides while the settings are unknown is caught', !(flipped.pending && flipped.missing))
  const unbounded = await basisWith("const min = MONTH_RE.test(earliestEditableMonth || '') ? earliestEditableMonth : ''", "const min = ''")
  ok('SABOTAGE: a month form that ignores the settled months is caught', unbounded.monthBounds('2026-09-30', '2026-09').min !== '2026-09')
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
