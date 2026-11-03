#!/usr/bin/env node
// Owner-operators, the client half of plan C PR 3: /apply's "Your truck" step,
// the Applications screen's owner-operator tab and accept buttons, and the sign
// modal's payment section for his agreement.
//
//   §1 client/src/lib/ownerOperatorApply.js: the steps (the truck step only with
//      the server's apply-options on and the position Owner Operator), the
//      step's checks, the section sent, the referral code from the link; its
//      field list is the server's (lib/public-form-input.js) less the code
//   §2 the client's checks agree with the server's on every row of one table
//   §3 ApplyView.vue: compiles; asks GET /api/config/apply-options; shows the
//      step by key; sends the section only when it showed the step; validates
//      every step it shows
//   §4 StepOwnerOperator.vue: compiles; a field for every section field
//   §5 ApplicationsView.vue: compiles; the tab and both accept buttons exist only
//      while the server sends the category; the owner-operator accept sends
//      `as` and the source
//   §6 DocumentSignModal.vue: compiles; the payment section and its details for
//      both agreements
//   §7 mutants, each caught
//
//   node scripts/test-owner-operator-apply-client.mjs    # exits 1 on any failure

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client')
const LIB_FILE = path.join(CLIENT, 'src', 'lib', 'ownerOperatorApply.js')
const require = createRequire(import.meta.url)
const clientRequire = createRequire(path.join(CLIENT, 'package.json'))

let pass = 0
const fails = []
const ok = (name, cond, detail) => { if (cond) pass++; else fails.push(detail ? `${name} (${detail})` : name) }
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

const LIB_SRC = read(LIB_FILE)
// A mutant of the module, loaded from a temp folder of its own: runners run side by side
// and write nothing into the repo tree (scripts/run-unit-tests.js). The module imports nothing.
const MUTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-apply-client-'))
process.on('exit', () => { try { fs.rmSync(MUTANT_DIR, { recursive: true, force: true }) } catch { /* scratch */ } })
let mutantSeq = 0
async function loadLib (text) {
  const file = path.join(MUTANT_DIR, `mutant-${++mutantSeq}.mjs`)
  fs.writeFileSync(file, text)
  return import(pathToFileURL(file).href)
}
const mutate = (text, from, to) => {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`mutant target found ${n}x: ${from.slice(0, 80)}`)
  return text.replace(from, () => to)
}

let sfc = null
try { sfc = clientRequire('vue/compiler-sfc') } catch (e) { ok('vue/compiler-sfc loads (client/node_modules)', false, e.message) }
function compiles (file) {
  const src = read(file)
  if (!src) return `missing ${path.basename(file)}`
  try {
    const { descriptor, errors } = sfc.parse(src, { filename: path.basename(file) })
    if (errors.length) return errors[0].message
    sfc.compileScript(descriptor, { id: path.basename(file), inlineTemplate: true })
    return true
  } catch (e) { return e.message }
}

// ── §1 ────────────────────────────────────────────────────────────────────────
function libSection (L, c = { ok, eq }) {
  c.eq('§1 flag off: the drivers\' five steps, whatever the position', [L.applyPages({ ownerOperatorEnabled: false, position: 'Owner Operator' }), L.applyPages({})],
    [['personal', 'experience', 'history', 'certifications', 'references'], ['personal', 'experience', 'history', 'certifications', 'references']])
  c.eq('§1 flag on, Owner Operator (any case and spacing): "Your truck" after Personal Info', L.applyPages({ ownerOperatorEnabled: true, position: ' owner OPERATOR ' }),
    ['personal', 'truck', 'experience', 'history', 'certifications', 'references'])
  c.eq('§1 flag on, another position: the five steps', [L.applyPages({ ownerOperatorEnabled: true, position: 'Company Driver' }), L.applyPages({ ownerOperatorEnabled: 'true', position: 'Owner Operator' })],
    [['personal', 'experience', 'history', 'certifications', 'references'], ['personal', 'experience', 'history', 'certifications', 'references']])
  const good = { truck_year: '2019', truck_make: 'Madeup', truck_model: 'Hauler 9', truck_vin: '1MDEXP0VT00000001', truck_plate: 'QA-1234', truck_plate_state: 'TX', truck_unit: '', truck_ownership: 'own', registered_owner: 'Alex Example', business_name: '' }
  c.eq('§1 a complete section passes', L.validateOwnerOperatorTruck(good), '')
  for (const [label, over] of [['no VIN', { truck_vin: '' }], ['no ownership', { truck_ownership: '' }], ['no registered owner', { registered_owner: ' ' }], ['a 3-digit year', { truck_year: '201' }],
    ['an 18-character VIN', { truck_vin: '1MDEXP0VT000000012' }], ['a three-letter state', { truck_plate_state: 'TXX' }], ['ownership "rent"', { truck_ownership: 'rent' }]]) {
    c.ok(`§1 ${label} is caught before submit`, L.validateOwnerOperatorTruck({ ...good, ...over }) !== '')
  }
  c.eq('§1 the section sent: every field trimmed, the referral code from the link, capped', L.ownerOperatorSection({ ...good, truck_make: '  Madeup ' }, ` ${'x'.repeat(80)} `),
    { ...good, truck_make: 'Madeup', referral_code: 'x'.repeat(64) })
  c.eq('§1 the referral code: ?ref= only', [L.referralCodeFrom('?ref=QA-CODE&x=1'), L.referralCodeFrom('?x=1'), L.referralCodeFrom(''), L.referralCodeFrom(undefined)], ['QA-CODE', '', '', ''])
  const server = require(path.join(ROOT, 'lib', 'public-form-input.js')).OWNER_OPERATOR_TRUCK_FIELDS || []
  c.eq('§1 the client\'s fields are the server\'s, less the referral code', [...L.OO_TRUCK_FIELDS], server.filter((f) => f !== 'referral_code'))
  c.eq('§1 an empty section has every field blank', L.emptyOwnerOperatorTruck(), Object.fromEntries(L.OO_TRUCK_FIELDS.map((f) => [f, ''])))
}

// ── §2 client and server agree ────────────────────────────────────────────────
function agreementSection (L) {
  const check = require(path.join(ROOT, 'lib', 'public-form-input.js')).checkPublicOwnerOperatorTruck
  if (typeof check !== 'function') return ok('§2 the server\'s check exists', false)
  const base = { truck_year: '2019', truck_make: 'Madeup', truck_model: 'Hauler 9', truck_vin: '1MDEXP0VT00000001', truck_plate: 'QA-1234', truck_plate_state: 'TX', truck_unit: '', truck_ownership: 'lease', registered_owner: 'Alex Example', business_name: 'Example Hauling LLC' }
  const rows = [{}, { truck_vin: '' }, { truck_vin: 'abc123' }, { truck_vin: '1MDEXP0VT0000000!' }, { truck_year: '1949' }, { truck_year: '2101' }, { truck_year: '20x9' },
    { truck_plate_state: 't' }, { truck_plate_state: 'tx' }, { truck_plate: 'QA_1234' }, { truck_ownership: 'Own' }, { registered_owner: '' }, { truck_make: '' }]
  for (const over of rows) {
    const t = { ...base, ...over }
    eq(`§2 ${JSON.stringify(over)}: the client and the server agree`, L.validateOwnerOperatorTruck(t) === '', check(L.ownerOperatorSection(t, '')).ok)
  }
}

// ── §3-§6 the views ───────────────────────────────────────────────────────────
function viewSections () {
  const APPLY = path.join(CLIENT, 'src', 'views', 'ApplyView.vue')
  const STEP = path.join(CLIENT, 'src', 'components', 'apply', 'StepOwnerOperator.vue')
  const APPS = path.join(CLIENT, 'src', 'views', 'ApplicationsView.vue')
  const SIGN = path.join(CLIENT, 'src', 'components', 'driver', 'DocumentSignModal.vue')
  if (!sfc) return
  const av = read(APPLY)
  eq('§3 ApplyView.vue compiles', compiles(APPLY), true)
  ok('§3 it asks GET /api/config/apply-options and starts with the five steps', av.includes("fetch('/api/config/apply-options')") && av.includes('const ownerOperatorOffered = ref(false)') &&
    av.includes('ownerOperatorOffered.value = !!data && data.ownerOperator === true'))
  ok('§3 the steps come from applyPages() with the server\'s answer and the position', av.includes('applyPages({ ownerOperatorEnabled: ownerOperatorOffered.value, position: form.position })'))
  ok('§3 the truck step shows by key', av.includes('<StepOwnerOperator v-if="page === \'truck\'" :truck="form.owner_operator" />'))
  ok('§3 the section is sent only when the step was shown', av.includes("if (pages.value.includes('truck')) payload.owner_operator = ownerOperatorSection(form.owner_operator, referralCode)") &&
    av.includes('else delete payload.owner_operator'))
  ok('§3 submit validates every step shown', av.includes('for (let s = 0; s < pages.value.length; s++) {') && av.includes('const stepErr = validatePage(s)'))
  ok('§3 no step is addressed by a fixed number any more', !/step === [0-9]|step < 4|s <= 4/.test(av))
  const st = read(STEP)
  eq('§4 StepOwnerOperator.vue compiles', compiles(STEP), true)
  const models = [...st.matchAll(/v-model="truck\.([a-z_]+)"/g)].map((m) => m[1])
  eq('§4 a field for each section field, each once', [...new Set(models)].sort(), ['business_name', 'registered_owner', 'truck_make', 'truck_model', 'truck_ownership', 'truck_plate', 'truck_plate_state', 'truck_unit', 'truck_vin', 'truck_year'])
  ok('§4 no EIN asked (the W-9 stays the drivers\' sole-proprietor W-9)', !/\bEIN\b|ein/i.test(st.replace(/maintain|again/gi, '')))
  const ap = read(APPS)
  eq('§5 ApplicationsView.vue compiles', compiles(APPS), true)
  ok('§5 the owner-operator parts appear only while the server sends the category', ap.includes("applications.value.some(a => Object.prototype.hasOwnProperty.call(a, 'category'))") &&
    ap.includes('...(ownerOperatorsOn.value') && ap.includes("pendingStatus.value === 'Accepted' && ownerOperatorsOn.value && pendingApp.value?.category === OO_FILTER"))
  ok('§5 two accept buttons for an owner-operator application, the owner-operator one off without truck details', ap.includes("@click=\"confirmStatusChange('company_driver')\"") &&
    ap.includes("@click=\"confirmStatusChange('owner_operator')\"") && ap.includes(':disabled="statusSaving || !pendingApp?.oo_truck"'))
  ok('§5 the owner-operator accept sends `as` and the source; the others send `as` alone or nothing', ap.includes("const extra = as === 'owner_operator' ? { as, source: acceptSource.value } : as === 'company_driver' ? { as } : {}") &&
    ap.includes('{ status, ...extra }'))
  ok('§5 the source defaults to the application\'s', ap.includes("acceptSource.value = app.oo_source === 'partner' ? 'partner' : 'direct'"))
  const sm = read(SIGN)
  eq('§6 DocumentSignModal.vue compiles', compiles(SIGN), true)
  ok('§6 the payment section and its details for both agreements', sm.includes("const hasPaymentSection = computed(() => props.doc?.doc_key === 'contractor_agreement' || isOwnerOperatorAgreement.value)") &&
    sm.includes('<div v-if="hasPaymentSection" class="payment-section">') && sm.includes('const payInfo = hasPaymentSection.value ? {') && sm.includes('if (hasPaymentSection.value) {'))
}

// ── §7 mutants ────────────────────────────────────────────────────────────────
async function mutants () {
  const caught = async (name, from, to, run) => {
    let L
    try { L = await loadLib(mutate(LIB_SRC, from, to)) } catch (e) { ok(`§7 ${name}: the mutation applies`, false, e.message); return }
    const sub = { fails: 0, ok: (n, c) => { if (!c) sub.fails++ }, eq: (n, g, w) => { if (JSON.stringify(g) !== JSON.stringify(w)) sub.fails++ } }
    run(L, sub)
    ok(`§7 ${name}: is caught`, sub.fails > 0)
  }
  await caught('M1 the truck step without the server\'s answer', 'if (ownerOperatorEnabled === true && isOwnerOperatorPosition(position))', 'if (isOwnerOperatorPosition(position))', libSection)
  await caught('M2 the VIN without its 17-character cap', '/^[A-Za-z0-9]{1,17}$/.test(text(t.truck_vin))', '/^[A-Za-z0-9]+$/.test(text(t.truck_vin))', libSection)
  await caught('M3 the referral code not capped', ".slice(0, 64)\n  return out", '\n  return out', libSection)
}

let L = null
try { L = await import(pathToFileURL(LIB_FILE).href) } catch (e) { ok('§1 client/src/lib/ownerOperatorApply.js loads', false, e.message) }
if (L) { libSection(L); agreementSection(L) }
viewSections()
if (L) await mutants()

if (fails.length) {
  console.error(`\nFAILURES (${fails.length}):`)
  for (const f of fails) console.error(`  x ${f}`)
  console.error(`\n${pass} passed, ${fails.length} failed`)
  process.exit(1)
}
console.log(`${pass} passed, 0 failed`)
