#!/usr/bin/env node
// The driver stepper's GPS phases, the app's half (load phases PR 3;
// DRIVER_STEPPER_GPS_PHASES_ENABLED). The server decides per load whether the
// geofence can mark a stop's phases right now and ships `_gpsPhases`
// { pickup, drop } (lib/gps-phases.js; scripts/test-stepper-gps-phases-server.js).
// The app must:
//
//   1. on "Arrived at Shipper" and "In Transit" (pickup) and "Arrived at
//      Receiver" (drop), when the server said exactly true for that stop, show a
//      line, "GPS marks this when you get there" ("...when you leave the
//      shipper" for In Transit), and a smaller "Mark it myself" link;
//   2. make the link open the same confirm and send the same status tap as
//      today's button;
//   3. keep today's button everywhere else: Heading to Shipper, Loading and
//      Delivered, a false or missing answer, and with no key at all (the flag
//      off), where the stepper renders exactly as before this change;
//   4. compute nothing: no clock, distance or position in the browser.
//
// StatusStepper.vue's own <script setup> and <template> are compiled with the
// client's vue/compiler-sfc, rendered to HTML with Vue's server renderer, and
// mounted on a minimal in-memory renderer to click. Only its two child
// components are stubs. No network, no DOM, no database. Needs client/node_modules.
//
//   node scripts/test-stepper-gps-phases.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
// One pass can join two halves into a new comment, so strip until nothing changes.
const stripHtmlComments = (s) => {
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, '') }
  return s
}
const STEPPER = 'client/src/components/driver/StatusStepper.vue'
const LIB = 'client/src/lib/gpsPhases.js'

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`ok    ${label}`)
  } else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

let gps = null
try { gps = await import(pathToFileURL(path.join(ROOT, LIB)).href) } catch { gps = null }
check('client/src/lib/gpsPhases.js loads', !!gps, true)

// ══ 1 — the wording, by step and the server's answer ═════════════════════════
const BOTH = { pickup: true, drop: true }
const NONE = { pickup: false, drop: false }
const PICKUP_ONLY = { pickup: true, drop: false }
const DROP_ONLY = { pickup: false, drop: true }
const ARRIVE = 'GPS marks this when you get there.'
const LEAVE = 'GPS marks this when you leave the shipper.'
{
  const line = (step, phases) => (gps ? gps.gpsStepLine(step, phases) : 'no module')
  check('W1 Arrived at Shipper reads the pickup answer', [line('At Shipper', PICKUP_ONLY), line('At Shipper', DROP_ONLY)], [ARRIVE, null])
  check('W2 In Transit (leaving the pickup zone) reads the pickup answer', [line('In Transit', PICKUP_ONLY), line('In Transit', DROP_ONLY)], [LEAVE, null])
  check('W3 Arrived at Receiver reads the drop answer', [line('At Receiver', DROP_ONLY), line('At Receiver', PICKUP_ONLY)], [ARRIVE, null])
  check('W4 Heading to Shipper, Loading and Delivered keep their buttons whatever the answer',
    ['Heading to Shipper', 'Loading', 'Delivered'].map((s) => line(s, BOTH)), [null, null, null])
  check('W5 no key (the flag off), null, an array or a string: the button',
    [undefined, null, [], 'yes'].map((p) => line('At Shipper', p)), [null, null, null, null])
  check('W6 only exactly true counts: "true", 1 and {} are not true',
    ['true', 1, {}].map((v) => line('At Shipper', { pickup: v, drop: v })), [null, null, null])
  check('W7 the link reads "Mark it myself"', gps && gps.MARK_IT_MYSELF, 'Mark it myself')
  check('W8 a step name that only looks like a key is no step', line('constructor', BOTH), null)
}

// ══ the harness: StatusStepper.vue compiled from a source ═════════════════════
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')
const DIR = path.dirname(path.join(ROOT, STEPPER))

// The confirm modals: each instance records its props and its emit, so a case
// can read whether it is open and confirm it.
const modals = []
const ConfirmModal = Vue.defineComponent({
  name: 'ConfirmModal',
  props: { open: Boolean, title: String, message: String, confirmText: String },
  emits: ['confirm', 'cancel'],
  setup(props, { emit }) {
    modals.push({ props, emit })
    return () => Vue.h('div', { 'data-stub': 'ConfirmModal', 'data-open': String(!!props.open), 'data-title': props.title })
  },
})
const StatusBadge = Vue.defineComponent({ name: 'StatusBadge', props: { status: String }, setup: (p) => () => Vue.h('span', { 'data-stub': 'StatusBadge' }, p.status) })

async function compileStepper(source) {
  const { descriptor } = parse(source, { filename: 'StatusStepper.vue' })
  let body = compileScript(descriptor, { id: 'status-stepper', inlineTemplate: true }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('StatusStepper.vue: an import/export this harness cannot map')
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec.endsWith('ConfirmModal.vue')) deps[spec] = { default: ConfirmModal }
    else if (spec.endsWith('StatusBadge.vue')) deps[spec] = { default: StatusBadge }
    else if (spec.startsWith('.')) deps[spec] = await import(pathToFileURL(path.join(DIR, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
    else throw new Error(`StatusStepper.vue: unexpected import '${spec}'`)
  }
  return new Function('__deps', body)(deps)
}

const HEADERS = ['Load ID', 'Driver', 'Job Status']
const load = (status, phases, more = {}) => ({
  'Load ID': 'L-3001', Driver: 'Driver Able', 'Job Status': status, _podCount: 0,
  ...(phases === undefined ? {} : { _gpsPhases: phases }), ...more,
})
const html = async (Comp, status, phases, more = {}, props = {}) => stripHtmlComments(await renderToString(Vue.createSSRApp(Comp, {
  load: load(status, phases, more), headers: HEADERS, currentStatus: status, driverName: 'Driver Able', ...props,
})))
const primary = (h) => (/<button class="action-btn primary"[^>]*>([^<]*)<\/button>/.exec(h) || [])[1] || null
const gpsHint = (h) => {
  const m = /<div class="gps-hint"><div class="gps-hint-step">([^<]*)<\/div><div class="gps-hint-text">([^<]*)<\/div><button type="button" class="gps-self-link"[^>]*>([^<]*)<\/button><\/div>/.exec(h)
  return m ? [m[1], m[2], m[3]] : null
}

// Today's stepper: this file with the change taken out, so the flag-off render
// can be compared with it. On a tree without the change, the file itself.
const SRC = read(STEPPER)
function withoutChange(src) {
  const cut = (s, re) => {
    const n = (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) || []).length
    if (n !== 1) throw new Error(`the change's piece is found ${n}x: ${re.source.slice(0, 60)}`)
    return s.replace(re, '')
  }
  if (!/gpsStepLine/.test(src)) return src
  let s = cut(src, / {8}<!-- The geofence marks this step on its own[\s\S]*?<\/button>\n {8}<\/div>\n\n/)
  s = cut(s, /^import \{ gpsStepLine, MARK_IT_MYSELF \} from '\.\.\/\.\.\/lib\/gpsPhases'\n/m)
  s = cut(s, /\n\/\/ The server's answer for the next step's stop, worded[\s\S]*?const gpsLine = computed\([^\n]*\n/)
  s = cut(s, /\n\/\* The geofence marks the next step: a line[\s\S]*?\.gps-self-link:disabled \{[\s\S]*?\}\n/)
  return s
}

{
  let today = null
  try { today = withoutChange(SRC) } catch { today = null }
  check('F0 today\'s stepper, recovered from the file, carries nothing of the change', !!today && !/gps|GPS/.test(today) && /gpsStepLine/.test(SRC), true)
}

let Stepper = null
let Today = null
try { Stepper = await compileStepper(SRC) } catch (e) { check(`StatusStepper.vue compiles (${e.message})`, false, true) }
try { Today = await compileStepper(withoutChange(SRC)) } catch (e) { check(`today's stepper is recoverable from the file (${e.message})`, false, true) }

// ══ 2 — what the driver sees ══════════════════════════════════════════════════
if (Stepper) {
  let h = await html(Stepper, 'Heading to Shipper', PICKUP_ONLY)
  check('R1 Heading to Shipper, pickup true: the next step "Arrived at Shipper" reads as GPS-marked, with the link, and no button',
    [gpsHint(h), primary(h)], [['Arrived at Shipper', ARRIVE, 'Mark it myself'], null])
  h = await html(Stepper, 'Heading to Shipper', DROP_ONLY)
  check('R2 ...pickup false (drop true): today\'s "Arrived at Shipper" button', [gpsHint(h), primary(h)], [null, 'Arrived at Shipper'])
  h = await html(Stepper, 'Loading', PICKUP_ONLY)
  check('R3 Loading, pickup true: "In Transit" is GPS-marked when he leaves the shipper', [gpsHint(h), primary(h)], [['In Transit', LEAVE, 'Mark it myself'], null])
  h = await html(Stepper, 'Loading', DROP_ONLY)
  check('R4 ...drop true only: today\'s "In Transit" button (the departure is the pickup zone\'s)', [gpsHint(h), primary(h)], [null, 'In Transit'])
  h = await html(Stepper, 'In Transit', DROP_ONLY)
  check('R5 In Transit, drop true: "Arrived at Receiver" is GPS-marked', [gpsHint(h), primary(h)], [['Arrived at Receiver', ARRIVE, 'Mark it myself'], null])
  h = await html(Stepper, 'In Transit', PICKUP_ONLY)
  check('R6 ...pickup true only: today\'s "Arrived at Receiver" button', [gpsHint(h), primary(h)], [null, 'Arrived at Receiver'])
  for (const s of ['Dispatched', 'Assigned']) {
    h = await html(Stepper, s, BOTH)
    check(`R7 ${s}, both true: "Heading to Shipper" keeps its button (it stays optional, and the geofence skips it)`, [gpsHint(h), primary(h)], [null, 'Heading to Shipper'])
  }
  h = await html(Stepper, 'At Shipper', BOTH)
  check('R8 At Shipper, both true: "Loading" keeps its button', [gpsHint(h), primary(h)], [null, 'Loading'])
  h = await html(Stepper, 'At Receiver', BOTH)
  check('R9 At Receiver, both true, no POD: the upload hint, as today', [gpsHint(h), h.includes('Upload a Proof of Delivery'), primary(h)], [null, true, null])
  h = await html(Stepper, 'At Receiver', BOTH, { _podCount: 1 })
  check('R10 ...with a POD: today\'s Delivered button', [gpsHint(h), primary(h)], [null, 'Delivered'])
  h = await html(Stepper, 'Delivered', BOTH)
  check('R11 Delivered: "Load Delivered", no line', [gpsHint(h), h.includes('&#10003; Load Delivered') || h.includes('✓ Load Delivered')], [null, true])
  h = await html(Stepper, 'Heading to Shipper', BOTH, {}, { readOnly: true })
  check('R12 read-only (the public tracker): no line, no link, no button', [gpsHint(h), h.includes('gps-'), primary(h)], [null, false, null])
  h = await html(Stepper, 'Heading to Shipper', BOTH, {}, { blocked: true })
  check('R13 another job active: the blocked hint, as today, before the line', [gpsHint(h), h.includes('Complete your current active job')], [null, true])
  h = await html(Stepper, 'Heading to Shipper', { pickup: 'true', drop: 'true' })
  check('R14 an answer that isn\'t exactly true: today\'s button', [gpsHint(h), primary(h)], [null, 'Arrived at Shipper'])
}

// ══ 3 — the flag off: exactly today's stepper ═════════════════════════════════
if (Stepper && Today) {
  const STATUSES = ['Assigned', 'Dispatched', 'Heading to Shipper', 'At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Delivered']
  const diffs = []
  for (const s of STATUSES) {
    for (const more of [{}, { _podCount: 1 }]) {
      for (const props of [{}, { readOnly: true }, { blocked: true }]) {
        const a = await html(Stepper, s, undefined, more, props)
        const b = await html(Today, s, undefined, more, props)
        if (a !== b) diffs.push(`${s} ${JSON.stringify(more)} ${JSON.stringify(props)}`)
      }
    }
  }
  check('F1 no _gpsPhases key (the flag off): every status renders byte for byte as today\'s stepper', diffs, [])
  const diffsFalse = []
  for (const s of STATUSES) {
    const a = await html(Stepper, s, NONE)
    const b = await html(Today, s, NONE)
    if (a !== b) diffsFalse.push(s)
  }
  check('F2 both answers false: today\'s stepper too', diffsFalse, [])
}

// ══ 4 — the link makes the same tap ═══════════════════════════════════════════
// A minimal renderer: element nodes with props (handlers included) and children.
function memoryRenderer() {
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
  const detach = (n) => { if (n.parent) { n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null } }
  return Vue.createRenderer({
    createElement: (tag) => node(tag),
    createText: (t) => node('#text', t),
    createComment: (t) => node('#comment', t),
    setText: (n, t) => { n.text = t },
    setElementText: (el, t) => { el.children.forEach((c) => { c.parent = null }); el.children = t ? [Object.assign(node('#text', t), { parent: el })] : [] },
    insert: (child, parent, anchor) => {
      detach(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child)
      else parent.children.push(child)
      child.parent = parent
    },
    remove: detach,
    parentNode: (n) => n.parent,
    nextSibling: (n) => (n.parent ? n.parent.children[n.parent.children.indexOf(n) + 1] || null : null),
    patchProp: (el, key, prev, next) => { el.props[key] = next },
  })
}
const textOf = (n) => (n.type === '#text' ? n.text : n.type === '#comment' ? '' : n.children.map(textOf).join(''))
const find = (n, pred) => { if (pred(n)) return n; for (const c of n.children) { const f = find(c, pred); if (f) return f } return null }
const byClass = (cls) => (n) => typeof n.props.class === 'string' && n.props.class.split(/\s+/).includes(cls)

// Mount, tap the control `cls`, confirm the modal it opens; the updates emitted.
async function tapThrough(Comp, status, phases, cls) {
  modals.length = 0
  const updates = []
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0 }
  try {
    const root = { type: 'root', text: '', children: [], props: {}, parent: null }
    const theLoad = load(status, phases)
    const app = memoryRenderer().createApp(Comp, {
      load: theLoad, headers: HEADERS, currentStatus: status, driverName: 'Driver Able', onUpdate: (e) => updates.push(e),
    })
    app.mount(root)
    await Vue.nextTick()
    const control = find(root, byClass(cls))
    const label = control ? textOf(control) : null
    const confirm = modals.find((m) => m.props.title === 'Update Status')
    const before = confirm ? confirm.props.open : null
    if (control && typeof control.props.onClick === 'function') control.props.onClick()
    await Vue.nextTick()
    const opened = confirm ? confirm.props.open : null
    if (confirm && opened) confirm.emit('confirm')
    await Vue.nextTick()
    app.unmount()
    return { found: !!control, label, before, opened, updates: updates.map((u) => ({ newStatus: u.newStatus, same: u.load === theLoad })), timers }
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

if (Stepper) {
  const viaLink = await tapThrough(Stepper, 'Heading to Shipper', PICKUP_ONLY, 'gps-self-link')
  const viaButton = await tapThrough(Stepper, 'Heading to Shipper', undefined, 'action-btn')
  check('T1 "Mark it myself" opens the same "Update Status" confirm, closed until tapped',
    [viaLink.found, viaLink.label, viaLink.before, viaLink.opened], [true, 'Mark it myself', false, true])
  check('T2 ...and confirming sends one update, "At Shipper", for this load', viaLink.updates, [{ newStatus: 'At Shipper', same: true }])
  check('T3 ...exactly what today\'s button sends from the same status', viaLink.updates, viaButton.updates)
  check('T4 ...with the same follow-up (the 5 s "Updating..." reset)', viaLink.timers, viaButton.timers)
  const transit = await tapThrough(Stepper, 'Loading', PICKUP_ONLY, 'gps-self-link')
  check('T5 from Loading the link sends "In Transit"', transit.updates, [{ newStatus: 'In Transit', same: true }])
  const receiver = await tapThrough(Stepper, 'In Transit', DROP_ONLY, 'gps-self-link')
  check('T6 from In Transit the link sends "At Receiver", with the POD reminder after it as the button has',
    [receiver.updates, receiver.timers], [[{ newStatus: 'At Receiver', same: true }], [1500, 5000]])
}

// ══ 5 — nothing computed in the browser ═══════════════════════════════════════
{
  const lib = fs.existsSync(path.join(ROOT, LIB)) ? read(LIB) : ''
  const code = lib.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  check('N1 gpsPhases.js reads no clock, position, distance or network', /\bDate\b|\bMath\b|latitude|longitude|setTimeout|fetch|navigator|geolocation/.test(code) || !lib, false)
  check('N2 ...and exports only the wording and its one reader', [...code.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort(), ['GPS_STEPS', 'MARK_IT_MYSELF', 'gpsStepLine'])
  const stepperCode = stripHtmlComments(SRC).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  check('N3 the stepper reads the server\'s answer through gpsStepLine() only',
    /const gpsLine = computed\(\(\) => \(nextStep\.value \? gpsStepLine\(nextStep\.value\.value, props\.load\._gpsPhases\) : null\)\)/.test(stepperCode)
      && stepperCode.split('_gpsPhases').length === 2, true)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p)
    return /\.(vue|js)$/.test(e.name) ? [p] : []
  })
  const readers = walk(path.join(ROOT, 'client', 'src'))
    .filter((f) => fs.readFileSync(f, 'utf8').split('\n').some((l) => l.includes('_gpsPhases') && !/^\s*(\/\/|\*|<!--)/.test(l)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  check('N4 no other file in the app reads _gpsPhases', readers, ['client/src/components/driver/StatusStepper.vue'])
}

// ══ 6 — mutants, each caught ══════════════════════════════════════════════════
async function mutantStepper(label, from, to) {
  const n = SRC.split(from).length - 1
  if (n !== 1) { check(`${label}: the mutant applies (found ${n}x)`, false, true); return null }
  try { return await compileStepper(SRC.replace(from, to)) } catch (e) { check(`${label}: compiles (${e.message})`, false, true); return null }
}
async function mutantLib(label, from, to) {
  const text = fs.existsSync(path.join(ROOT, LIB)) ? read(LIB) : ''
  const n = text.split(from).length - 1
  if (n !== 1) { check(`${label}: the mutant applies (found ${n}x)`, false, true); return null }
  return import(`data:text/javascript;base64,${Buffer.from(text.replace(from, to)).toString('base64')}`)
}
{
  const m1 = await mutantLib('C1', "'In Transit': Object.freeze({ stop: 'pickup'", "'In Transit': Object.freeze({ stop: 'drop'")
  if (m1) check('C1 In Transit read off the drop answer: W2 and R3 flip', m1.gpsStepLine('In Transit', PICKUP_ONLY), null)
  const m2 = await mutantLib('C2', 'return gpsPhases[step.stop] === true ? step.line : null', 'return gpsPhases[step.stop] ? step.line : null')
  if (m2) check('C2 any truthy answer counted: W6 and R14 flip', m2.gpsStepLine('At Shipper', { pickup: 'true' }), ARRIVE)
  const m3 = await mutantLib('C3', "Object.create(null), {\n", "Object.create(null), {\n  'Heading to Shipper': Object.freeze({ stop: 'pickup', line: 'GPS marks this when you get there.' }),\n")
  if (m3) check('C3 Heading made GPS-marked: W4 and R7 flip', m3.gpsStepLine('Heading to Shipper', BOTH), ARRIVE)

  const m5 = await mutantStepper('C4', '<div v-else-if="gpsLine" class="gps-hint">', '<div v-else-if="false" class="gps-hint">')
  if (m5) {
    const h = await html(m5, 'Heading to Shipper', PICKUP_ONLY)
    check('C4 the line never shown: R1 flips to today\'s button', [gpsHint(h), primary(h)], [null, 'Arrived at Shipper'])
  }
  const m6 = await mutantStepper('C5','            class="gps-self-link"\n            :disabled="updating"\n            @click="showConfirm = true"',
    '            class="gps-self-link"\n            :disabled="updating"\n            @click="showPodReminder = true"')
  if (m6) {
    const t = await tapThrough(m6, 'Heading to Shipper', PICKUP_ONLY, 'gps-self-link')
    check('C5 the link opening another modal: T1-T2 flip (no confirm, no update)', [t.opened, t.updates], [false, []])
  }
  // M7: the line placed before the blocked hint.
  const blockedAt = SRC.indexOf('        <!-- Blocked: another job is active -->')
  const gpsAt = SRC.indexOf('\n\n        <!-- The geofence marks this step on its own')
  const normalAt = SRC.indexOf('\n\n        <!-- Normal action button -->')
  if (blockedAt > 0 && gpsAt > blockedAt && normalAt > gpsAt) {
    const blockedBlock = SRC.slice(blockedAt, gpsAt)
    const gpsBlock = SRC.slice(gpsAt + 2, normalAt)
    const swapped = SRC.slice(0, blockedAt) + gpsBlock + '\n\n' + blockedBlock + SRC.slice(normalAt)
    const m7 = await compileStepper(swapped)
    const h = await html(m7, 'Heading to Shipper', BOTH, {}, { blocked: true })
    check('C6 the line before the blocked hint: R13 flips (a blocked driver is told GPS will mark it)', gpsHint(h) !== null, true)
  } else check('C6 the mutant applies (the three blocks in order)', false, true)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
