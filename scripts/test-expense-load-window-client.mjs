#!/usr/bin/env node
// Receipts on recently delivered loads — the DRIVER APP's half.
//
// WHY THIS EXISTS. A driver could not attach fuel receipts to loads he had
// already delivered: the load page showed the expense form on ACTIVE loads only,
// and the form's own Load picker dropped every delivered load. The owner approved
// "last 7 days" (2026-09-23). The rule is decided on the SERVER
// (lib/expense-window.js — scripts/test-expense-load-window.js pins it and its
// gate) and arrives on every load as `_expenseWindow`. The app must:
//
//   1. render from that verdict, never re-derive it from a status;
//   2. re-check its closing time against the phone's clock, INCLUSIVE, so a page
//      left open closes exactly when the server's gate would;
//   3. show the form on a delivered load inside its window, with a short note,
//      and list that load in the form's picker so the preselect is real;
//   4. tell a driver on a closed / unrecorded delivery why, and to ask dispatch;
//   5. never take the form away from under a half-typed entry.
//
// Where a check guards a regression, the OLD code runs against the same fixture
// first and must reproduce the bug. LoadDetail.vue's and ExpenseForm.vue's own
// <script setup> are compiled with the client's vue/compiler-sfc and run on Vue's
// real reactivity; only browser-bound imports are stubbed.
//
// No network, no DOM, no database. Needs client/node_modules (vue), which CI
// installs before the unit runners.
//
//   node scripts/test-expense-load-window-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

import {
  ACTIVE_LOAD_STATUS_RE, isActiveLoadStatus, liveExpenseWindow, expenseWindowDays,
  expenseWindowCopy, expenseLoadIds,
} from '../client/src/lib/expenseWindow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const server = require('../lib/expense-window.js')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const DAY = 24 * 60 * 60 * 1000
const T = Date.parse('2026-09-16T15:00:00Z') // delivered: 10:00 AM CDT
const CLOSES = T + 7 * DAY
// What GET /api/driver/:driverName ships, built by the server's own function.
const verdictAt = (status, deliveredAt, now) => server.expenseWindow({ status, deliveredAt, now })
const OPEN = verdictAt('Delivered', T, T + 2 * DAY)
const brief = (w) => [w.eligible, w.state]

// ══ 1 — the phone re-checks the server's verdict against its own clock ═══════
{
  check('open verdict, before it closes → eligible', brief(liveExpenseWindow(OPEN, { now: T + 5 * DAY })), [true, 'open'])
  check('open verdict, AT the closing instant → still eligible (inclusive, as the server)', brief(liveExpenseWindow(OPEN, { now: CLOSES })), [true, 'open'])
  check('open verdict, 1 ms later → closed on the phone too', brief(liveExpenseWindow(OPEN, { now: CLOSES + 1 })), [false, 'closed'])
  check('open verdict, day 8 → closed', brief(liveExpenseWindow(OPEN, { now: T + 8 * DAY })), [false, 'closed'])
  check('an open verdict with an unreadable closing time is not open', brief(liveExpenseWindow({ ...OPEN, closesAt: 'soon' }, { now: T })), [false, 'closed'])
  check('a bare wall clock is not trusted as a closing time', brief(liveExpenseWindow({ ...OPEN, closesAt: '2026-09-23 15:00:00' }, { now: T })), [false, 'closed'])
  const closed = verdictAt('Delivered', T, T + 8 * DAY)
  check('the phone never REOPENS a window the server closed (clock behind)', brief(liveExpenseWindow(closed, { now: T })), [false, 'closed'])
  check('active → eligible, no clock involved', brief(liveExpenseWindow(verdictAt('In Transit', null, T), { now: T + 99 * DAY })), [true, 'active'])
  check('unknown (no delivery on record) → not eligible', brief(liveExpenseWindow(verdictAt('Delivered', null, T), { now: T })), [false, 'unknown'])
  check('cancelled → not eligible', brief(liveExpenseWindow(verdictAt('Cancelled', T, T), { now: T })), [false, 'cancelled'])
  check('other status → not eligible', brief(liveExpenseWindow(verdictAt('Unassigned', null, T), { now: T })), [false, 'none'])
  // No verdict on the load: exactly the old rule, and no claims about a window.
  check('NO verdict + active status → the old rule: eligible', brief(liveExpenseWindow(undefined, { status: 'At Receiver' })), [true, 'active'])
  check('NO verdict + delivered status → the old rule: not eligible, and silent (state none)', brief(liveExpenseWindow(null, { status: 'Delivered' })), [false, 'none'])
  check('...marked as a fallback', liveExpenseWindow(null, { status: 'Delivered' }).fallback, true)
  check('a verdict with an unknown state is no verdict at all', brief(liveExpenseWindow({ state: 'forever', eligible: true }, { status: 'Delivered' })), [false, 'none'])
  check('a verdict wins over the status cell (the phone does not re-derive the rule)', brief(liveExpenseWindow(OPEN, { status: 'In Transit', now: CLOSES + 1 })), [false, 'closed'])
}

// ══ 2 — parity: the phone decides exactly what the server gate would ═════════
// For every status and delivery age, a verdict fetched at `fetchedAt` and
// re-checked on the phone at a LATER instant must equal the server's own verdict
// at that later instant. (Time only moves forward; a phone clock running
// backwards is covered in §1 — it can close, never reopen.)
{
  const statuses = ['Delivered', 'Completed', 'POD Received', 'In Transit', 'Dispatched', 'Cancelled', 'Unassigned', '']
  const deliveries = [null, T, T - 3 * DAY, T - 7 * DAY, T - 7 * DAY - 1, T - 30 * DAY]
  const offsets = [0, 1, 60e3, DAY, 3 * DAY, 7 * DAY - 1, 7 * DAY, 7 * DAY + 1, 8 * DAY]
  let cases = 0
  let mismatches = 0
  for (const status of statuses) {
    for (const deliveredAt of deliveries) {
      for (const f of offsets) {
        for (const later of offsets) {
          if (later < f) continue
          const fetchedAt = T + f
          const now = T + later
          const phone = liveExpenseWindow(server.expenseWindow({ status, deliveredAt, now: fetchedAt }), { now })
          const truth = server.expenseWindow({ status, deliveredAt, now })
          cases++
          if (phone.eligible !== truth.eligible || phone.state !== truth.state) {
            mismatches++
            if (mismatches <= 3) console.error(`      ${JSON.stringify({ status, deliveredAt, fetchedAt, now, phone: brief(phone), truth: brief(truth) })}`)
          }
        }
      }
    }
  }
  check(`phone and server agree on every case (${cases} status × delivery × fetch × later)`, mismatches, 0)
}

// ══ 3 — one meaning of "active" on both sides ════════════════════════════════
{
  check('the client and server active sets are the same pattern', ACTIVE_LOAD_STATUS_RE.source === server.ACTIVE_STATUS_RE.source && ACTIVE_LOAD_STATUS_RE.flags === server.ACTIVE_STATUS_RE.flags, true)
  const probes = ['Assigned', 'dispatched', 'Heading to Shipper', 'At Shipper', 'Loading', ' In Transit ', 'At Receiver', 'Unloading',
    'Delivered', 'Completed', 'POD Received', 'Cancelled', 'Unassigned', 'Picked Up', '', 'In-Transit', 'in transit!']
  check('...and answer every probe the same', probes.filter((s) => isActiveLoadStatus(s) !== server.isActiveLoadStatus(s)), [])
}

// ══ 4 — what the load page says ══════════════════════════════════════════════
{
  const open = expenseWindowCopy(liveExpenseWindow(OPEN, { now: T + DAY }))
  check('open: the note, in the owner-approved words', open.note && open.note.title, 'Adding a receipt to a delivered load')
  check('open: "allowed for 7 days after delivery", and until when — Houston time, labelled',
    /^Allowed for 7 days after delivery\. Open until Wed, Sep 23, 10:00 AM CDT\.$/.test(open.note && open.note.body), true)
  check('open: no hint', open.hint, null)
  const closed = expenseWindowCopy(liveExpenseWindow(OPEN, { now: T + 8 * DAY }))
  check('closed: a hint that says when and who to ask',
    closed.hint, 'The 7-day window for adding receipts to this load closed Sep 23, 2026, 10:00 AM CDT. Ask dispatch to add one.')
  check('closed: no note', closed.note, null)
  const unknown = expenseWindowCopy(liveExpenseWindow(verdictAt('Delivered', null, T), { now: T }))
  check('unknown: the hint says there is no record, and to ask dispatch', /no record of when this load was delivered.*Ask dispatch/.test(unknown.hint), true)
  check('cancelled: says so', /cancelled/.test(expenseWindowCopy(liveExpenseWindow(verdictAt('Cancelled', null, T))).hint), true)
  check('active: nothing to say — the form is where it always was', expenseWindowCopy(liveExpenseWindow(verdictAt('In Transit', null, T))), { note: null, hint: null })
  check('no verdict: nothing to say about a window we know nothing of', expenseWindowCopy(liveExpenseWindow(null, { status: 'Delivered' })), { note: null, hint: null })
  // The number is READ from the verdict, so the copy follows the server's rule.
  const ten = { state: 'open', eligible: true, deliveredAt: new Date(T).toISOString(), closesAt: new Date(T + 10 * DAY).toISOString() }
  check('the copy follows the server\'s window length (a 10-day verdict says 10 days)', /^Allowed for 10 days after delivery\./.test(expenseWindowCopy(liveExpenseWindow(ten, { now: T })).note.body), true)
  check('window days are read off the verdict', [expenseWindowDays(OPEN), expenseWindowDays({}), expenseWindowDays(null)], [7, null, null])
}

// ══ 5 — the form's Load picker offers exactly what the server accepts ════════
const HEADERS = ['Load ID', 'Job Status', 'Driver']
const load = (id, status, win) => ({ 'Load ID': id, 'Job Status': status, Driver: 'Deshorn King', ...(win === undefined ? {} : { _expenseWindow: win }) })
{
  const loads = [
    load('A-ACTIVE', 'In Transit', verdictAt('In Transit', null, T)),
    load('B-OPEN', 'Delivered', OPEN),
    load('C-CLOSED', 'Delivered', verdictAt('Delivered', T - 8 * DAY, T)),
    load('D-UNKNOWN', 'Delivered', verdictAt('Delivered', null, T)),
    load('E-NOVERDICT-ACTIVE', 'Loading'),
    load('F-NOVERDICT-DELIVERED', 'Delivered'),
  ]
  check('active + delivered-inside-window (+ the no-verdict active fallback) — nothing else',
    expenseLoadIds(loads, HEADERS, { now: T + DAY }), ['A-ACTIVE', 'B-OPEN', 'E-NOVERDICT-ACTIVE'])
  check('...and the delivered load drops out the moment its window closes',
    expenseLoadIds(loads, HEADERS, { now: CLOSES + 1 }), ['A-ACTIVE', 'E-NOVERDICT-ACTIVE'])
  check('no load-id column → nothing to offer', expenseLoadIds(loads, ['Job Status']), [])
  check('junk in the list is skipped', expenseLoadIds([null, undefined, load('', 'In Transit')], HEADERS), [])
}

// ══ SFC harness — a component's own <script setup>, run in node ═════════════
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const SRC_DIR = path.join(ROOT, 'client', 'src')
const settle = async () => { for (let i = 0; i < 6; i++) { await Vue.nextTick(); await new Promise((r) => setImmediate(r)) } }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }

// Compile `rel` (optionally from a rewritten source) into a setup(props) runner.
// One-line named and default imports only; anything else stops the run loudly.
async function compileSetup(rel, { source, stubs = {} } = {}) {
  const file = path.join(ROOT, rel)
  const dir = path.dirname(file)
  const { descriptor } = parse(source ?? read(rel), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: false }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (_, names, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)';?[ \t]*$/gm, (_, name, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const build = new Function('__deps', body)
  const deps = {
    vue: { ...Vue, onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} },
    vant: new Proxy({}, { get: () => ({}) }),
  }
  for (const spec of specs) {
    if (spec === 'vue' || spec === 'vant') continue
    const key = path.relative(SRC_DIR, path.join(dir, spec)).split(path.sep).join('/').replace(/\.js$/, '')
    if (stubs[key]) deps[spec] = stubs[key]
    else if (spec.endsWith('.vue')) deps[spec] = { default: {} }
    else if (spec.startsWith('.')) deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
    else throw new Error(`${rel}: unexpected import '${spec}'`)
  }
  return (props) => {
    const scope = Vue.effectScope()
    const bindings = scope.run(() => build(deps).setup(props, { expose() {}, emit() {}, attrs: {}, slots: {} }))
    return { b: bindings, stop: () => scope.stop() }
  }
}

// ══ 6 — LoadDetail.vue: when the form shows, what it says, and the latch ══════
{
  const REL = 'client/src/components/driver/LoadDetail.vue'
  const mountDetail = await compileSetup(REL)
  const props = (l) => Vue.shallowReactive({
    load: l, headers: HEADERS, driverName: 'Deshorn King', hasActiveJob: false, driverPosition: null, truck: null,
    loadExpenses: [], responding: false, expenseSubmitHandler: null, phoneGpsModeActive: false, phoneGpsStatus: '',
  })
  const shown = (b) => b.showExpenseForm.value

  // Fresh verdicts, relative to the real clock — the component judges at Date.now().
  const now = Date.now()
  const live = {
    active: verdictAt('In Transit', null, now),
    open: verdictAt('Delivered', now - 2 * DAY, now),
    closed: verdictAt('Delivered', now - 8 * DAY, now),
    unknown: verdictAt('Delivered', null, now),
  }

  let m = mountDetail(props(load('564157463', 'In Transit', live.active))); await settle()
  check('L1 active load → the form, no note, no hint', [shown(m.b), !!m.b.expenseCopy.value.note, m.b.expenseCopy.value.hint], [true, false, null])
  m.stop()

  m = mountDetail(props(load('564157463', 'Delivered', live.open))); await settle()
  check('L2 delivered 2 days ago → the form AND the note', [shown(m.b), m.b.expenseCopy.value.note && m.b.expenseCopy.value.note.title], [true, 'Adding a receipt to a delivered load'])
  m.stop()

  m = mountDetail(props(load('564157463', 'Delivered', live.closed))); await settle()
  check('L3 delivered 8 days ago → no form; a hint saying the window closed', [shown(m.b), /window for adding receipts to this load closed/.test(m.b.expenseCopy.value.hint || '')], [false, true])
  m.stop()

  m = mountDetail(props(load('564157463', 'Delivered', live.unknown))); await settle()
  check('L4 delivered with no recorded time → no form; a hint to ask dispatch', [shown(m.b), /no record.*Ask dispatch/.test(m.b.expenseCopy.value.hint || '')], [false, true])
  m.stop()

  m = mountDetail(props(load('564157463', 'Delivered'))); await settle()
  check('L5 no verdict at all + Delivered → exactly the old page: no form, no hint', [shown(m.b), m.b.expenseCopy.value.hint], [false, null])
  m.stop()
  m = mountDetail(props(load('564157463', 'At Receiver'))); await settle()
  check('L5 no verdict at all + active → exactly the old page: the form', shown(m.b), true)
  m.stop()

  // The driver taps Delivered with the form open: the verdict goes active → open.
  {
    const p = props(load('564157463', 'At Receiver', live.active))
    m = mountDetail(p); await settle()
    const before = shown(m.b)
    p.load = load('564157463', 'Delivered', live.open); await settle()
    check('L6 active → just delivered: the form never leaves the screen', [before, shown(m.b), !!m.b.expenseCopy.value.note], [true, true, true])
    m.stop()
  }

  // THE LATCH. The window closes (or the load turns out to have no recorded
  // delivery) while the page — and possibly a half-typed entry — is open.
  {
    const p = props(load('564157463', 'Delivered', live.open))
    m = mountDetail(p); await settle()
    p.load = load('564157463', 'Delivered', live.closed); await settle()
    check('L7 the window closes under an open page → the form STAYS (an entry is never thrown away)', shown(m.b), true)
    check('...and the hint above it says why a submit will be refused', /window for adding receipts to this load closed/.test(m.b.expenseCopy.value.hint || ''), true)
    p.load = load('777000111', 'Delivered', live.closed); await settle()
    check('L7 ...but a DIFFERENT load starts over: closed → no form', shown(m.b), false)
    p.load = load('564157463', 'Delivered', live.unknown); await settle()
    check('L7 ...and coming back to a load already shown here keeps it for the page', shown(m.b), true)
    m.stop()
  }

  // Source pins the template relies on (the harness runs setup, not the template).
  const tpl = read(REL)
  check('the page renders the form off the verdict, not the status', /<ExpenseForm\s+v-if="showExpenseForm"/.test(tpl), true)
  check('...still passes it this load, preselected', /:loads="\[load\]"/.test(tpl) && /:preset-load-id="String\(loadId \|\| ''\)"/.test(tpl), true)
  check('...renders the note and the hint', /v-if="expenseCopy\.note"/.test(tpl) && /v-else-if="expenseCopy\.hint"/.test(tpl), true)
  check('...and "No expenses" only where there is no form', /<van-empty v-else-if="!showExpenseForm" description="No expenses for this load"/.test(tpl), true)
  check('...with no second copy of the active-status regex', /heading to shipper\|at shipper/.test(tpl), false)

  // M1 — the latch removed: the same scenario throws the entry away.
  {
    const mutant = tpl.replace(
      /const showExpenseForm = computed\(\(\) =>[\s\S]*?\n\)\n/,
      'const showExpenseForm = computed(() => expenseWin.value.eligible)\n',
    )
    check('M1 (mutant source differs)', mutant !== tpl, true)
    const mountMutant = await compileSetup(REL, { source: mutant })
    const p = props(load('564157463', 'Delivered', live.open))
    const mm = mountMutant(p); await settle()
    p.load = load('564157463', 'Delivered', live.closed); await settle()
    check('M1 without the latch the form vanishes when the window closes (so L7 would fail)', shown(mm.b), false)
    mm.stop()
  }
  // M2 — the page gated on the status again (the bug this change fixes).
  {
    const mutant = tpl.replace('const expenseWin = computed(() => liveExpenseWindow(props.load && props.load._expenseWindow, { status: status.value }))',
      'const expenseWin = computed(() => liveExpenseWindow(null, { status: status.value }))')
    check('M2 (mutant source differs)', mutant !== tpl, true)
    const mountMutant = await compileSetup(REL, { source: mutant })
    const mm = mountMutant(props(load('564157463', 'Delivered', live.open))); await settle()
    check('M2 ignoring the verdict hides the form on a load delivered 2 days ago (so L2 would fail)', shown(mm.b), false)
    mm.stop()
  }
}

// ══ 7 — ExpenseForm.vue: the preselected delivered load is really pickable ════
{
  const REL = 'client/src/components/driver/ExpenseForm.vue'
  const stubs = {
    'composables/useToast': { useToast: () => ({ show() {} }) },
    'composables/useDocumentScan': { useDocumentScan: () => ({ scanDocument: async () => ({}) }) },
    'composables/useFileDrop': { useFileDrop: () => ({ dropzoneProps: Vue.ref({}), dragActive: Vue.ref(false), error: Vue.ref(''), clearMessages() {} }) },
    'lib/imageUtils': { compressImage: async () => '', isDecodedImage: () => false },
  }
  const formProps = (loads, presetLoadId) => Vue.shallowReactive({
    loads, driverName: 'Deshorn King', headers: HEADERS, presetLoadId, submitHandler: async () => ({}),
  })
  const delivered = load('564157463', 'Delivered', verdictAt('Delivered', Date.now() - 2 * DAY, Date.now()))

  const src = read(REL)
  check('the form reads its picker from the shared rule', /const loadIdOptions = computed\(\(\) => expenseLoadIds\(props\.loads, props\.headers\)\)/.test(src), true)
  check('...imported on ONE line, the shape the receipt-flow harness can map', /^import \{ expenseLoadIds \} from '\.\.\/\.\.\/lib\/expenseWindow'$/m.test(src), true)

  // The OLD picker, on the same fixture, must reproduce the bug.
  const OLD = [
    'const loadIdOptions = computed(() => {',
    '  const loadIdCol = (props.headers || []).find((h) => /load.?id|job.?id/i.test(h)) || null',
    '  const statusCol = (props.headers || []).find((h) => /status/i.test(h)) || null',
    '  if (!loadIdCol) return []',
    '  const completedRe = /^(delivered|completed|pod received|cancelled)$/i',
    '  return props.loads',
    '    .filter((l) => !statusCol || !completedRe.test((l[statusCol] || \'\').trim()))',
    '    .map((l) => l[loadIdCol])',
    '    .filter(Boolean)',
    '})',
  ].join('\n')
  const oldSrc = src.replace('const loadIdOptions = computed(() => expenseLoadIds(props.loads, props.headers))', OLD)
  check('(old-code source differs)', oldSrc !== src, true)
  const oldForm = (await compileSetup(REL, { source: oldSrc, stubs }))(formProps([delivered], '564157463'))
  check('OLD: the field preselects the delivered load…', oldForm.b.form.loadId, '564157463')
  check('OLD: …while its own picker lists nothing (the bug)', oldForm.b.loadColumns.value, [])
  oldForm.stop()

  const mountForm = await compileSetup(REL, { stubs })
  const f = mountForm(formProps([delivered], '564157463'))
  check('NEW: the field preselects the delivered load', f.b.form.loadId, '564157463')
  check('NEW: and the picker lists it', f.b.loadColumns.value, [{ text: '564157463', value: '564157463' }])
  f.b.onLoadPick({ selectedOptions: [] })
  check('an empty picker confirm changes nothing and does not throw', f.b.form.loadId, '564157463')
  f.b.onLoadPick({ selectedOptions: [{ text: 'X', value: '564157463' }] })
  check('a real pick still lands', f.b.form.loadId, '564157463')
  f.stop()

  const closedForm = mountForm(formProps([load('564157463', 'Delivered', verdictAt('Delivered', Date.now() - 9 * DAY, Date.now()))], '564157463'))
  check('a load past its window is not offered', closedForm.b.loadColumns.value, [])
  closedForm.stop()
}

// ══ 8 — LoadDetail.vue RENDERED: its real template, to HTML ══════════════════
// §6 runs the page's logic; this renders its actual <template> with Vue's server
// renderer, so the v-if / v-else-if chain the driver sees is what is asserted —
// not a regex over the source. Child components and Vant are stubs that render
// their default slot (and, for the two that matter, the props being checked).
{
  const { renderToString } = clientRequire('vue/server-renderer')
  const REL = 'client/src/components/driver/LoadDetail.vue'
  const file = path.join(ROOT, REL)
  const dir = path.dirname(file)
  const { descriptor } = parse(read(REL), { filename: 'LoadDetail.vue' })
  let body = compileScript(descriptor, { id: 'load-detail-ssr', inlineTemplate: true }).content
  const specs = []
  // The compiler's own helper imports use double quotes; the file's use single.
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${REL}: an import/export this harness cannot map`)
  const stub = (name) => Vue.defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      return () => Vue.h('div', {
        'data-stub': name,
        ...(attrs.description ? { 'data-desc': attrs.description } : {}),
        ...(name === 'ExpenseForm' ? { 'data-preset': attrs['preset-load-id'] ?? attrs.presetLoadId } : {}),
      }, slots.default ? slots.default() : [])
    },
  })
  const deps = { vue: Vue, vant: new Proxy({}, { get: (_, k) => stub(String(k)) }) }
  for (const spec of specs) {
    if (spec === 'vue' || spec === 'vant') continue
    if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  const LoadDetail = new Function('__deps', body)(deps)
  // Just the Expenses section, comments stripped.
  async function expensesHtml(l, loadExpenses = []) {
    const html = await renderToString(Vue.createSSRApp(LoadDetail, { load: l, headers: HEADERS, driverName: 'Deshorn King', loadExpenses }))
    const from = html.indexOf('class="expenses-section"')
    const to = html.indexOf('data-stub="ZoomableImage"')
    return from < 0 || to < from ? '' : html.slice(from, to).replace(/<!--[\s\S]*?-->/g, '')
  }
  const now = Date.now()
  const FORM = 'data-stub="ExpenseForm" data-preset="564157463"'
  const EMPTY = 'data-desc="No expenses for this load"'
  const NOTE = '<div class="expense-window-note" role="note"><strong>Adding a receipt to a delivered load</strong><span>Allowed for 7 days after delivery. Open until '

  let h = await expensesHtml(load('564157463', 'In Transit', verdictAt('In Transit', null, now)))
  check('R1 active: the form, preset to this load — no note, no hint, no empty state',
    [h.includes(FORM), h.includes('expense-window-note'), h.includes('expense-window-hint'), h.includes(EMPTY)], [true, false, false, false])
  h = await expensesHtml(load('564157463', 'Delivered', verdictAt('Delivered', now - 2 * DAY, now)))
  check('R2 delivered 2 days ago: the note ("Adding a receipt to a delivered load — allowed for 7 days…") above the form',
    [h.includes(NOTE), h.includes(FORM), h.indexOf(NOTE) < h.indexOf(FORM), h.includes(EMPTY)], [true, true, true, false])
  check('R2 …with its closing time in Houston time, labelled', /Open until \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M C[DS]T\.<\/span>/.test(h), true)
  h = await expensesHtml(load('564157463', 'Delivered', verdictAt('Delivered', now - 8 * DAY, now)))
  check('R3 delivered 8 days ago: the hint and "No expenses" — no form',
    [/<div class="expense-window-hint" role="note">\s*The 7-day window for adding receipts to this load closed .+ Ask dispatch to add one\.\s*<\/div>/.test(h), h.includes(EMPTY), h.includes('data-stub="ExpenseForm"')], [true, true, false])
  h = await expensesHtml(load('564157463', 'Delivered', verdictAt('Delivered', null, now)))
  check('R4 no recorded delivery: the ask-dispatch hint — no form', [/no record of when this load was delivered/.test(h), h.includes('data-stub="ExpenseForm"')], [true, false])
  h = await expensesHtml(load('564157463', 'Delivered', verdictAt('Delivered', now - 8 * DAY, now)), [{ id: 7, loadId: '564157463', amount: 50 }])
  check('R5 a closed load with receipts on file shows their history instead of "No expenses"',
    [h.includes('data-stub="ExpenseCard"'), h.includes(EMPTY)], [true, false])
  h = await expensesHtml(load('564157463', 'Delivered'))
  check('R6 no verdict on a delivered load: the old page exactly — "No expenses", no note, no hint, no form',
    [h.includes(EMPTY), h.includes('expense-window-'), h.includes('data-stub="ExpenseForm"')], [true, false, false])
}

console.log(`expense-load-window-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
