#!/usr/bin/env node
// The email-address rule on the public application forms — the CLIENT's copy.
//
// WHY THIS EXISTS. The server judges every submission with checkPublicEmail()
// (lib/public-form-input.js). The two public forms check the address earlier,
// on the step where it is typed, with client/src/lib/emailAddress.js — so that
// a typo on /invest is not refused only at the final submit, after every
// document has been signed. Two copies of one rule drift apart unless
// something holds them together; this runner is that something.
//
//   §1 the client rule IS the server rule: same pattern, flags and limit, and
//      the same verdict and message for a fixed corpus plus a seeded fuzz
//   §2 /apply (ApplyView.vue): its step-0 validate() — lifted from the SFC and
//      executed — refuses what the server refuses, with the server's words
//   §3 /invest (InvestorApplyView.vue): the step-0 gate — the real computed
//      definitions, executed — blocks Continue on a bad address and explains
//      it once the field is left, never while typing
//   §4 DISCRIMINATION — defang each piece, require an assertion to flip
//
// No network, no DOM, no database, no Vue runtime (the four computed values
// are evaluated over a minimal stand-in).
//
//   node scripts/test-email-address-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

import { EMAIL_RE, EMAIL_MAX_LENGTH, EMAIL_MESSAGES, checkEmail } from '../client/src/lib/emailAddress.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const server = require('../lib/public-form-input.js')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
function ok(name, cond) {
  if (cond) console.log(`ok    ${name}`)
  else { console.log(`FAIL  ${name}`); failed++ }
}
const ch = (code) => String.fromCharCode(code)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ══ §1 — the client rule is the server rule ═════════════════════════════════
console.log('\n§1  client/src/lib/emailAddress.js === lib/public-form-input.js')
ok('same pattern source', EMAIL_RE.source === server.EMAIL_RE.source)
ok('same pattern flags (none)', EMAIL_RE.flags === server.EMAIL_RE.flags && EMAIL_RE.flags === '')
ok('same length limit', EMAIL_MAX_LENGTH === server.EMAIL_MAX_LENGTH)

const CORPUS = [
  // accepted
  'jane@example.com', 'jane.doe+loads@sub.example.co.uk', "o'brien@example.com", 'first_last-1@ex-ample.com',
  'UPPER@EXAMPLE.COM', 'user=tag@example.com', 'a@xn--bcher-kva.de',
  'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(57) + '.com',
  // typos an applicant actually makes
  'john@gmail', 'john@gmail.', 'john@@gmail.com', 'john.gmail.com', 'john@gmail..com', ' john@gmail.com', 'john@gmail.com ',
  // lists and mail syntax
  'a@example.com, b@example.org', 'a@example.com;b@example.org', 'a@example.com b@example.org', 'a@example.com,',
  'Name <a@example.com>', 'a@example.com(x)', '"a b"@example.com', 'a@[127.0.0.1]', 'a\\b@example.com', 'a:b@example.com',
  'a?b@example.com', 'a#b@example.com', 'a%b@example.com', 'a@example.com\r\nBcc: b@example.org',
  // non-ASCII and invisible characters
  'jos' + ch(0xe9) + '@example.com', 'a@example' + ch(0xff0e) + 'com', 'a' + ch(0x200b) + 'b@example.com', ch(0xfeff) + 'a@example.com',
  // structure and length
  '', '@', 'a@', '@example.com', 'a@.example.com', 'a@exa_mple.com',
  'a'.repeat(65) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(57) + '.com',
  // not strings
  null, undefined, 42, ['a@example.com'], { toString() { return 'a@example.com' } }, true,
]
const mismatches = CORPUS.filter((v) => !same(checkEmail(v), server.checkPublicEmail(v)))
ok(`the same verdict and message for all ${CORPUS.length} corpus values`, mismatches.length === 0)
for (const m of mismatches.slice(0, 5)) console.log(`      differs on ${JSON.stringify(m)}`)

// Seeded, so a failure reproduces exactly.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ALPHABET = [
  'a', 'b', 'Z', '0', '9', '.', '.', '@', '@', '-', '_', '+', "'", '=', '!', '~',
  ',', ';', '<', '>', '(', ')', '[', ']', '\\', ':', '"', '?', '#', '%',
  ' ', '\t', '\r', '\n', ch(0xa0), ch(0x2028), ch(0xe9), ch(0xff0e), ch(0x200b),
]
const rand = mulberry32(20260923)
const FUZZ = 20000
let firstDiff = null
for (let n = 0; n < FUZZ && firstDiff === null; n++) {
  // Mostly short values, some just past the limit.
  const len = rand() < 0.02 ? EMAIL_MAX_LENGTH - 2 + Math.floor(rand() * 5) : Math.floor(rand() * 30)
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  if (rand() < 0.5) s = 'ab' + s.replace(/@/g, '') + '@ex.com' // steer half the cases near a valid shape
  if (!same(checkEmail(s), server.checkPublicEmail(s))) firstDiff = s
}
if (firstDiff !== null) console.log(`      first difference: ${JSON.stringify(firstDiff)}`)
ok(`the same verdict for ${FUZZ} seeded random values`, firstDiff === null)
const reasonsSeen = new Set(CORPUS.map((v) => checkEmail(v).reason).filter(Boolean))
ok('the corpus exercises every refusal reason', ['invalid', 'multiple', 'too_long'].every((r) => reasonsSeen.has(r)))
ok('the client messages are the server messages, reason by reason',
  ['invalid', 'multiple', 'too_long'].every((r) =>
    EMAIL_MESSAGES[r] === server.checkPublicEmail({ invalid: 'x', multiple: 'a@b.com,c@d.com', too_long: 'x'.repeat(255) }[r]).message))

// ══ §2 — /apply: ApplyView.vue's step-0 validate() ═══════════════════════════
console.log('\n§2  /apply — ApplyView.vue validate(0), lifted and executed')
const APPLY_VIEW = read('client/src/views/ApplyView.vue')

// Brace-count `function name(` out of a source text.
function liftFn(src, name) {
  const a = src.indexOf(`function ${name}(`)
  if (a < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  for (let i = src.indexOf('{', src.indexOf(')', a)); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}
const VALIDATE_SRC = liftFn(APPLY_VIEW, 'validate')
const buildValidate = (src) => new Function('form', 'checkEmail', `${src}\nreturn validate;`)
// A step-0 form with every required field and upload present.
const driverForm = (email) => ({
  first_name: 'Jane', last_name: 'Doe', email, phone: '5550100', dob: '1990-01-01', address: '1 Main St',
  city: 'Dallas', state: 'TX', zip: '75201', ssn: '000-00-0000', drivers_license: 'D1', position: 'Driver',
  hazmat: 'No', cdl_front: 'x', cdl_back: 'x', medical_card: 'x',
})
const runValidate = (src, email) => buildValidate(src)(driverForm(email), checkEmail)(0)
ok('ApplyView imports the shared rule', /import \{ checkEmail \} from '\.\.\/lib\/emailAddress'/.test(APPLY_VIEW))
ok('the previous inline email pattern is gone from ApplyView.vue', !APPLY_VIEW.includes('[^\\s@]+@[^\\s@]+\\.[^\\s@]+'))
ok('a valid address passes step 0', runValidate(VALIDATE_SRC, 'jane.doe@example.com') === '')
for (const bad of ['john@gmail', 'a@example.com, b@example.org', 'jos' + ch(0xe9) + '@example.com', 'a@example..com', 'x'.repeat(255)]) {
  ok(`step 0 refuses ${JSON.stringify(bad.length > 30 ? bad.slice(0, 12) + '…' : bad)} with the server's message`,
    runValidate(VALIDATE_SRC, bad) === server.checkPublicEmail(bad).message)
}

// ══ §3 — /invest: InvestorApplyView.vue's step-0 gate ════════════════════════
console.log('\n§3  /invest — InvestorApplyView.vue step-0 gate, executed')
const INVEST_VIEW = read('client/src/views/InvestorApplyView.vue')
// The four definitions, from `const emailCheck = ` to the end of the
// `const canProceedStep1 = ` line: the real code, not a restatement.
function liftGate(src) {
  const a = src.indexOf('const emailCheck = ')
  const b = src.indexOf('const canProceedStep1 = ')
  if (a < 0 || b < 0 || b < a) throw new Error('step-0 gate definitions not found')
  return src.slice(a, src.indexOf('\n', b))
}
const GATE_SRC = liftGate(INVEST_VIEW)
// Minimal stand-ins for Vue's ref() and computed(): lazily evaluated getters.
const ref = (v) => ({ value: v })
const computed = (fn) => ({ get value() { return fn() } })
function buildGate(src, form) {
  return new Function('form', 'checkEmail', 'ref', 'computed',
    `${src}\nreturn { emailCheck, emailFocused, showEmailError, canProceedStep1 };`)(form, checkEmail, ref, computed)
}
const investForm = (email) => ({ legal_name: 'Example Holdings LLC', email, phone: '5550100', address: '1 Main St', ein_ssn: '12-3456789' })

ok('InvestorApplyView imports the shared rule', /import \{ checkEmail \} from '\.\.\/lib\/emailAddress'/.test(INVEST_VIEW))
{
  const g = buildGate(GATE_SRC, investForm('jane@example.com'))
  ok('a valid address with every field filled: Continue is enabled, no message', g.canProceedStep1.value === true && g.showEmailError.value === false)
}
{
  const g = buildGate(GATE_SRC, investForm('john@gmail'))
  ok('a mistyped address blocks Continue even with every other field filled', g.canProceedStep1.value === false)
  ok('…and the message shows once the field is left', g.showEmailError.value === true && g.emailCheck.value.message === server.checkPublicEmail('john@gmail').message)
  g.emailFocused.value = true
  ok('…but never while the applicant is still typing in it', g.showEmailError.value === false)
}
{
  const g = buildGate(GATE_SRC, investForm('a@example.com, b@example.org'))
  ok('a list of addresses blocks Continue, with the server\'s "single address" message',
    g.canProceedStep1.value === false && g.emailCheck.value.message === EMAIL_MESSAGES.multiple)
}
{
  const g = buildGate(GATE_SRC, investForm(''))
  ok('an empty field blocks Continue without a message (nothing typed yet)', g.canProceedStep1.value === false && g.showEmailError.value === false)
}
ok('the Continue button is still disabled by canProceedStep1',
  /:disabled="!canProceedStep1 \|\| submitting" data-wizard-target="continue-step0"/.test(INVEST_VIEW))
ok('the email input tracks focus for the message',
  /@focus="emailFocused = true" @blur="emailFocused = false"/.test(INVEST_VIEW))
ok('the message element renders the shared message',
  /<p v-if="showEmailError" id="invest-email-error" class="field-error" role="alert">\{\{ emailCheck\.message \}\}<\/p>/.test(INVEST_VIEW))
ok('the final-submit backstop names the email when it is the only problem',
  /toast\(step0FieldsFilled\.value \? emailCheck\.value\.message : 'Please complete your business details before submitting\.', 'error'\)/.test(INVEST_VIEW))

// ══ §4 — DISCRIMINATION ══════════════════════════════════════════════════════
console.log('\n§4  DISCRIMINATION — defang each piece, require an assertion to flip')
// The previous /apply check, restored inside the real validate().
const OLD_VALIDATE = VALIDATE_SRC.replace(
  /(?:\/\/[^\n]*\n\s*)?const email = checkEmail\(form\.email\)\n\s*if \(!email\.ok\) return email\.message/,
  "if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(form.email)) return 'Please enter a valid email address.'")
ok('MUTANT: the previous /apply pattern lets a list of addresses through step 0',
  OLD_VALIDATE !== VALIDATE_SRC && runValidate(OLD_VALIDATE, 'a@b.com,c') === '' && runValidate(VALIDATE_SRC, 'a@b.com,c') !== '')
// The previous /invest gate: presence only.
const OLD_GATE = GATE_SRC.replace(
  /const canProceedStep1 = computed\(\(\) => [^\n]+/,
  'const canProceedStep1 = computed(() => form.legal_name && form.email && form.phone && form.address && form.ein_ssn)')
ok('MUTANT: the previous presence-only gate lets a mistyped address through step 0',
  OLD_GATE !== GATE_SRC && !!buildGate(OLD_GATE, investForm('john@gmail')).canProceedStep1.value === true)
// One character of drift between the client and server rules.
const CLIENT_SRC = read('client/src/lib/emailAddress.js')
const drifted = CLIENT_SRC.replace("const EMAIL_LABEL_CHARS = 'A-Za-z0-9-'", "const EMAIL_LABEL_CHARS = 'A-Za-z0-9_-'")
const driftedMod = await import('data:text/javascript,' + encodeURIComponent(drifted))
ok('MUTANT: a client rule one character wider than the server rule is caught by §1',
  drifted !== CLIENT_SRC && driftedMod.EMAIL_RE.source !== server.EMAIL_RE.source &&
  CORPUS.some((v) => !same(driftedMod.checkEmail(v), server.checkPublicEmail(v))))

console.log(failed ? `\n${failed} test(s) failed` : '\nall passed')
process.exit(failed ? 1 : 0)
