#!/usr/bin/env node
// The driver form's emergency-contact rules are the server's own.
//
// client/src/lib/emergencyContacts.js checks a list on the phone before it is
// sent; lib/emergency-contacts.js checks it again on every write. Two copies of
// one rule drift, and each direction costs a driver: a form that allows what the
// server refuses fails after every contact is typed; a form that refuses what the
// server allows blocks a real family member's number.
//
// This runs both over one table of made-up inputs and compares every answer: the
// limits and the relationship suggestions; cleanContactText() (whitespace runs,
// control, format, private-use, unassigned and line-separator characters, the
// zero-width joiners, accents, emoji, no letter, the cap counted as sent);
// normalizePhone() (US and Canadian numbers as people write them, 0/1 and N11
// codes, international numbers, extensions, letters, other dashes and digits, the
// 32-character cap); validateContactList() (the body's shape, the count, each
// field's code and index, duplicates in stored form, ids). Status, code, index,
// the stored values and the list must match; the words are each side's own. The
// sabotage controls prove the comparison can fail: copies of the client module
// with one limit, one character class, one phone rule or one check changed must
// each be reported.
//
// No network, no DB, no server: safe anywhere.
//   node scripts/test-emergency-contacts-parity.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const lib = require(path.join(__dirname, '..', 'lib', 'emergency-contacts.js'))
const CLIENT_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'emergencyContacts.js')

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function done() {
  console.log(`\ntest-emergency-contacts-parity: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

if (!fs.existsSync(CLIENT_PATH)) {
  ok('client/src/lib/emergencyContacts.js exists', false)
  done()
}
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, 'utf8')
const client = await import(pathToFileURL(CLIENT_PATH).href)

const cp = (...codes) => String.fromCodePoint(...codes)
const j = (v) => (v === undefined ? 'undefined' : JSON.stringify(v))

// ══ One table of made-up inputs ═══════════════════════════════════════════════
const TEXTS = [
  'Quinn Example', '  Harper   Example  ', 'O\'Brien-Smith', 'Jean-Luc Example', 'Zoë Exämple', 'e' + cp(0x301) + 'mile',
  'Example' + cp(0xa0) + 'Name', 'Example' + cp(0x3000) + 'Name', 'Tab\tand\nnewline', cp(0x674e) + ' Example', cp(0x645, 0x62b, 0x627, 0x644),
  cp(0x645, 0x62b) + cp(0x200c) + cp(0x627, 0x644), 'A' + cp(0x200d) + 'B', 'Quinn ' + cp(0x1f600), cp(0x1f600).repeat(3), 'Spouse', 'Other',
  '123', '-', '', '   ', '\t\n', 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(40), 'x'.repeat(41), 'a' + cp(0x1f600).repeat(40), 'a' + cp(0x1f600).repeat(39),
  'Nul' + cp(0) + 'Name', 'Right' + cp(0x202e) + 'Left', 'Private' + cp(0xe000), 'Line' + cp(0x2028) + 'Sep', 'Para' + cp(0x2029) + 'Sep',
  'Soft' + cp(0xad) + 'Hyphen', cp(0xfeff) + 'Bom', 'Unassigned' + String.fromCharCode(0x378), 'Lone' + String.fromCharCode(0xd800),
  'Zero' + cp(0x200b) + 'Width', 'Bell' + cp(7), 'Del' + cp(0x7f), 42, null, undefined, {}, [], true,
]
const MAXES = [80, 40, 5, 1]
const PHONES = [
  '(202) 555-0143', '202-555-0143', '202.555.0143', '2025550143', ' (202) 555-0143 ', '\t2025550143', '1-312-555-0178', '13125550178',
  '1 (202) 555-0143', '+1 312 555 0178', '+13125550178', '+1 (312) 555-0178', '+ 12025550143', '(800) 555-0143', '1-800-555-0143',
  '+44 20 7946 0958', '+44 113 496 0123', '+61 491 570 156', '+44 207 946', '+44207946', '+442079460958123', '+4420794609581234', '+4420794',
  '+0 20 7946 0958', '+1234567', '+123456789012345', '+1', '+', '++12025550143', '555-0143', '(102) 555-0143', '(002) 555-0143',
  '(211) 555-0143', '(911) 555-0143', '(202) 155-0143', '(202) 055-0143', '(202) 911-0143', '(202) 211-0143', '202 555 0143 x12',
  '202-555-0143 ext 5', '202-555-01ab', '202' + cp(0x2013) + '555' + cp(0x2013) + '0143', cp(0xff12, 0xff10, 0xff12) + '5550143',
  '202/555/0143', '202_555_0143', '1' + '2'.repeat(31), '1' + '2'.repeat(32), '(202) 555-0143' + ' '.repeat(18), '(202) 555-0143' + ' '.repeat(19),
  '', '   ', 2025550143, null, undefined, {}, '+1 202 555 0143', '12025550143', '+12025550143',
]
const two = [
  { name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' },
  { name: 'Harper Example', relationship: 'Parent', phone: '1-312-555-0178' },
]
const more = [
  { name: 'Jordan Placeholder', relationship: 'Friend', phone: '+44 20 7946 0958' },
  { name: 'Riley Fixture', relationship: 'Relative', phone: '512-555-0149' },
  { name: 'Sky Testcase', relationship: 'Other', phone: '512-555-0150' },
  { name: 'Drew Sampleton', relationship: 'Child', phone: '512-555-0151' },
]
const BODIES = [
  { contacts: two }, { contacts: [...two, ...more.slice(0, 3)] }, { contacts: [...two, ...more] }, { contacts: [two[0]] }, { contacts: [] },
  null, undefined, [], 'contacts', 7, { contacts: 'no' }, { contacts: {} }, {},
  { contacts: Array.from({ length: 21 }, () => two[0]) }, { contacts: Array.from({ length: 20 }, () => two[0]) },
  { contacts: [two[0], null] }, { contacts: [two[0], 'x'] }, { contacts: [two[0], [two[1]]] },
  { contacts: [{ ...two[0], id: '7' }, two[1]] }, { contacts: [{ ...two[0], id: 0 }, two[1]] }, { contacts: [{ ...two[0], id: -1 }, two[1]] },
  { contacts: [{ ...two[0], id: 1.5 }, two[1]] }, { contacts: [{ ...two[0], id: 2 ** 53 }, two[1]] }, { contacts: [{ ...two[0], id: 9 }, { ...two[1], id: 9 }] },
  { contacts: [{ ...two[0], id: null }, { ...two[1], id: undefined }] }, { contacts: [{ ...two[0], id: 31 }, { ...two[1], id: 32 }] },
  { contacts: [two[0], { ...two[1], phone: '+1 202 555 0143' }] }, { contacts: [two[0], { ...two[1], phone: '2025550143' }] },
  { contacts: [two[0], two[1], { ...more[0], name: '' }] }, { contacts: [{ ...two[0], relationship: 'r'.repeat(41) }, two[1]] },
  { contacts: [two[0], { ...two[1], phone: '555-0143' }] }, { contacts: [{ ...two[0], phone: 'x' }, { ...two[1], name: '' }] },
  { contacts: [{ ...two[0], name: 'A' + cp(0x200c) + 'B' }, two[1]] }, { contacts: [{ ...two[0], name: '  Quinn   Example ' }, two[1]] },
  { contacts: [{ ...two[0], relationship: 42 }, two[1]] }, { contacts: [{ name: 'Quinn Example', phone: '2025550143' }, two[1]] },
  { contacts: [two[0], two[1], { ...more[0], id: 'x' }, more[1], more[2], more[3]] },
  { contacts: [two[0], { ...two[1], name: 'x'.repeat(81) }] }, { contacts: [two[0], { ...two[1], phone: '+0 20 7946 0958' }] },
]

// Every answer but the words: each side says a refusal its own way.
const answer = (r) => {
  if (!r || typeof r !== 'object') return r
  const { error, ...rest } = r
  return rest
}

function differences(c) {
  const out = []
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${label}: client ${JSON.stringify(a)} / server ${JSON.stringify(b)}`) }
  for (const k of ['MIN_CONTACTS', 'MAX_CONTACTS', 'CONTACT_NAME_MAX', 'RELATIONSHIP_MAX', 'PHONE_RAW_MAX', 'BODY_MAX_ENTRIES', 'RELATIONSHIP_SUGGESTIONS']) same(k, c[k], lib[k])
  for (const t of TEXTS) for (const m of MAXES) same(`cleanContactText(${j(t)}, ${m})`, c.cleanContactText(t, m), lib.cleanContactText(t, m))
  for (const p of PHONES) same(`normalizePhone(${j(p)})`, c.normalizePhone(p), lib.normalizePhone(p))
  for (const b of BODIES) same(`validateContactList(${j(b).slice(0, 80)})`, answer(c.validateContactList(b)), answer(lib.validateContactList(b)))
  return out
}

// ══ The real pair ═════════════════════════════════════════════════════════════
const real = differences(client)
const compared = 7 + TEXTS.length * MAXES.length + PHONES.length + BODIES.length
ok(`the client mirror agrees with the server on every input (${compared} compared, ${real.length} difference(s))${real.length ? `:\n        ${real.slice(0, 10).join('\n        ')}` : ''}`, real.length === 0)
console.log(`  ${compared} answers compared: 7 constants, ${TEXTS.length} texts x ${MAXES.length} caps, ${PHONES.length} phones, ${BODIES.length} bodies`)
const codes = new Set(BODIES.map((b) => lib.validateContactList(b).code).filter(Boolean))
ok(`the table reaches every refusal code the server has (${[...codes].sort().join(', ')})`,
  Object.keys(lib.REFUSAL_TEXT).every((k) => codes.has(k)))
ok('the table holds accepted and refused names, phones and lists',
  TEXTS.some((t) => lib.cleanContactText(t, 80).ok) && TEXTS.some((t) => !lib.cleanContactText(t, 80).ok) &&
  PHONES.some((p) => lib.normalizePhone(p).ok) && PHONES.some((p) => !lib.normalizePhone(p).ok) &&
  BODIES.some((b) => lib.validateContactList(b).ok))
ok('every refusal the client gives carries its own words', BODIES.every((b) => {
  const r = client.validateContactList(b)
  return r.ok || (typeof r.error === 'string' && r.error.length > 0 && r.error === client.MESSAGES[r.code])
}))
ok('the client module is pure (no imports)', !/^\s*import\s/m.test(CLIENT_SRC))

// ══ Sabotage controls ═════════════════════════════════════════════════════════
async function sabotaged(from, to) {
  if (CLIENT_SRC.split(from).length !== 2) throw new Error(`sabotage anchor not found exactly once: ${from}`)
  return import(`data:text/javascript,${encodeURIComponent(CLIENT_SRC.replace(from, () => to))}`)
}
const CONTROLS = [
  ['the name limit changed', 'export const CONTACT_NAME_MAX = 80', 'export const CONTACT_NAME_MAX = 81'],
  ['the minimum changed', 'export const MIN_CONTACTS = 2', 'export const MIN_CONTACTS = 1'],
  ['a suggestion dropped', "'Relative', ", ''],
  ['format characters (the zero-width joiners) let through', '/^[\\p{C}\\p{Zl}\\p{Zp}]$/u', '/^[\\p{Cc}\\p{Zl}\\p{Zp}]$/u'],
  ['the cap counted in characters instead of as sent', 'raw.length > max', '[...raw].length > max'],
  ['no-break spaces no longer folded', '/^[\\t\\n\\v\\f\\r\\p{Zs}]$/u', '/^[\\t\\n\\v\\f\\r ]$/u'],
  ['N11 codes allowed', " && !(three[1] === '1' && three[2] === '1')", ''],
  ['seven-digit international numbers allowed', 'digits.length < 8', 'digits.length < 7'],
  ['the phone cap dropped', 'raw.length > PHONE_RAW_MAX', 'false'],
  ['duplicates in stored form no longer refused', "    if (phones.has(phone.e164)) return refusal(422, 'CONTACT_PHONE_DUPLICATE', i)\n", ''],
  ['an id given as text allowed', '!Number.isSafeInteger(e.id) || ', ''],
]
for (const [label, from, to] of CONTROLS) {
  let found = []
  try { found = differences(await sabotaged(from, to)) } catch (err) { found = []; console.error(`      (${label}: ${err.message})`) }
  ok(`SABOTAGE: ${label} is reported`, found.length > 0)
}

done()
