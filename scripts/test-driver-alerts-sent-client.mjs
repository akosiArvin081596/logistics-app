#!/usr/bin/env node
// The Drivers page's "Alerts sent": a driver's alerts, read-only, for a Super Admin. The
// logic in client/src/lib/driverAlertsSent.js, the panel DriverAlertsSentPanel.vue, and
// where DriverTable.vue puts it.
//
// The server is the gate (scripts/test-driver-page-role-gate.js §10): the route is Super
// Admin only and answers what the driver's own payload carries. The page shows what it is
// sent:
//   §1 the lib: the route for a row, the words, each row as title, text and time on the
//      app's clock and nothing else of it, the line over a list at the server's cap, the
//      unlinked and unreadable lines, and the refusals that keep the section away
//   §2 parity with the server: its route, the fields it sends and the cap it names, and
//      its own handler's answers shown as the page shows them
//   §3 the panel, mounted in memory: one GET for its row and no write; the rows, the cap
//      line, the empty, unlinked and unreadable lines; nothing before the answer, for a
//      403 or a 404, or for a row with no id; another row's list cleared at once and a
//      late answer dropped; it compiles with no warning
//   §4 the dialog: DriverTable.vue shows the panel in the detail dialog, for the row it
//      opened; the panel reads only a row's title, text and time, as text; nothing else
//      in the client asks the route; the page is Super Admin only
//   §5 mutants: copies of the lib, the panel and the table with one rule changed must
//      each be caught by the sections above
//
// Made-up people only. No DOM (an in-memory renderer), no server, no build.
//   node scripts/test-driver-alerts-sent-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { serverSource } from './lib/server-source.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const LIB = path.join(CLIENT_SRC, 'lib', 'driverAlertsSent.js')
const PANEL = path.join(CLIENT_SRC, 'components', 'drivers-db', 'DriverAlertsSentPanel.vue')
const TABLE = path.join(CLIENT_SRC, 'components', 'drivers-db', 'DriverTable.vue')
const ROUTER = path.join(CLIENT_SRC, 'router', 'index.js')
const SERVER_LIB = path.join(ROOT, 'lib', 'driver-alerts-sent.js')

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const LIB_SRC = read(LIB)
const PANEL_SRC = read(PANEL)
const TABLE_SRC = read(TABLE)
const DATETIME_URL = pathToFileURL(path.join(CLIENT_SRC, 'utils', 'datetime.js')).href
// The lib's one import, made absolute so a mutant copy loaded from a data: URL finds it.
const absImports = (src) => src.replace("from '../utils/datetime.js'", `from '${DATETIME_URL}'`)
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('\n<script')))
// Comments are dropped until none is left, so a comment inside a comment can't hide code.
const stripComments = (s) => {
  for (let prev = null; prev !== s;) {
    prev = s
    for (let p = null; p !== s;) { p = s; s = s.replace(/<!--[\s\S]*?-->/g, '') }
    for (let p = null; p !== s;) { p = s; s = s.replace(/\/\*[\s\S]*?\*\//g, '') }
  }
  return s.replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
const count = (s, needle) => s.split(needle).length - 1

// ── reporting ────────────────────────────────────────────────────────────────
// The main run prints every result; a mutant run only counts what failed.
let pass = 0
let fail = 0
function checker(print) {
  const c = { failed: [] }
  c.eq = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) { if (print) { pass++; console.log(`  ok    ${name}`) } return }
    c.failed.push(name)
    if (print) { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`) }
  }
  c.ok = (name, cond) => c.eq(name, !!cond, true)
  return c
}

// ── made-up answers ──────────────────────────────────────────────────────────
// Times: Nov 12 and Nov 11 are on Eastern Standard Time, Jul 4 on daylight time.
const ANSWER = {
  linked: true,
  limit: 100,
  alerts: [
    { title: 'Please sign again: Equipment Policy', text: '', time: '2026-11-12T19:30:00Z' },
    { title: 'New message from dispatch', text: 'Call me when you reach the yard.', time: '2026-11-11T15:20:00Z' },
    { title: 'New Load Assigned: QA-7701', text: 'Lakeview, OH → Hilltop, KY', time: '2026-07-04T16:05:00Z' },
  ],
}
const SHOWN = [
  { title: 'Please sign again: Equipment Policy', text: '', time: 'Nov 12, 2026, 2:30 PM EST' },
  { title: 'New message from dispatch', text: 'Call me when you reach the yard.', time: 'Nov 11, 2026, 10:20 AM EST' },
  { title: 'New Load Assigned: QA-7701', text: 'Lakeview, OH → Hilltop, KY', time: 'Jul 4, 2026, 12:05 PM EDT' },
]
const listOf = (n, limit = 100) => ({
  linked: true,
  limit,
  alerts: Array.from({ length: n }, (_, i) => ({ title: `At Shipper - Load QA-${8000 + i}`, text: 'You have arrived at the pickup location', time: '2026-11-09T17:00:00Z' })),
})
const WORDS = {
  heading: 'Alerts sent',
  none: 'No alerts sent to this driver yet.',
  noAccount: 'No single driver account matches this directory row, so there are no alerts to show.',
  unreadable: "This driver's alerts couldn't be loaded. Try again.",
}

// ── §1 the lib ───────────────────────────────────────────────────────────────
function libChecks(c, L) {
  c.eq('§1 the words', { ...L.ALERTS_WORDS }, WORDS)
  c.ok('§1 ...frozen', Object.isFrozen(L.ALERTS_WORDS))
  c.eq('§1 a row\'s route', L.alertsSentUrl(11), '/api/drivers-directory/11/alerts-sent')
  c.eq('§1 ...and none for anything but a positive whole id',
    [0, -3, 1.5, '11', null, undefined, NaN, 2 ** 53, Infinity].map((v) => L.alertsSentUrl(v)), Array(9).fill(null))
  const view = L.alertsSentView(ANSWER)
  c.eq('§1 a list: each row as title, text and time on the app\'s clock, in the order sent', view, { note: '', rows: SHOWN, newest: '' })
  const extra = L.alertsSentView({ linked: true, limit: 100, alerts: [{ ...ANSWER.alerts[1], id: 5, type: 'message', read: 0, metadata: '{"note":"QA-META-ONLY"}' }] })
  c.eq('§1 ...nothing else of a row reaches the page', extra.rows.map((r) => Object.keys(r)), [['title', 'text', 'time']])
  c.eq('§1 ...a text that is not text shows as none; a time that is not an instant shows as none',
    L.alertsSentView({ linked: true, limit: 100, alerts: [{ title: 'QA one', text: null, time: 'soon' }, { title: 'QA two', text: 5 }] }).rows,
    [{ title: 'QA one', text: '', time: '' }, { title: 'QA two', text: '', time: '' }])
  c.eq('§1 ...a row with no title is left out',
    L.alertsSentView({ linked: true, limit: 100, alerts: [null, 'x', { text: 'QA no title' }, ANSWER.alerts[0]] }).rows, [SHOWN[0]])
  c.eq('§1 a list at the server\'s cap says it shows the newest', L.alertsSentView(listOf(100)).newest, 'Showing the newest 100.')
  c.eq('§1 ...with the server\'s own number', L.alertsSentView(listOf(50, 50)).newest, 'Showing the newest 50.')
  c.eq('§1 ...and a list below the cap, or an answer naming none, says nothing of it',
    [L.alertsSentView(listOf(99)).newest, L.alertsSentView({ ...listOf(100), limit: undefined }).newest, L.alertsSentView({ ...listOf(100), limit: 0 }).newest], ['', '', ''])
  c.eq('§1 no alerts', L.alertsSentView({ linked: true, limit: 100, alerts: [] }), { note: WORDS.none, rows: [], newest: '' })
  c.eq('§1 a row that names no single Driver account: its line, whatever else the answer carries',
    [{ linked: false }, { linked: false, alerts: ANSWER.alerts }].map((a) => L.alertsSentView(a)),
    Array(2).fill({ note: WORDS.noAccount, rows: [], newest: '' }))
  c.eq('§1 an answer it can\'t read says so, with no rows',
    [null, undefined, 'x', 5, {}, { linked: true }, { linked: true, alerts: {} }, { linked: 'yes', alerts: [] }].map((a) => L.alertsSentView(a)),
    Array(8).fill({ note: WORDS.unreadable, rows: [], newest: '' }))
  c.eq('§1 the section stays away for a 403 or a 404 only',
    [{ status: 403 }, { status: 404 }, { status: 500 }, { status: 401 }, { status: 0 }, null, undefined].map((e) => L.isHiddenAnswer(e)),
    [true, true, false, false, false, false, false])
}

// ── §2 parity with the server ────────────────────────────────────────────────
function parityChecks(c, L) {
  const req = createRequire(import.meta.url)
  let server = null
  try { server = req(SERVER_LIB) } catch { server = null }
  c.ok('§2 lib/driver-alerts-sent.js loads', !!server)
  if (!server) return
  c.eq('§2 the route is the server\'s', L.alertsSentUrl(11), server.PATH.replace(':id', '11'))
  const sent = server.sentView({ id: 9, type: 'message', title: 'QA title', body: 'QA text', metadata: '{}', read: 0, createdAt: '2026-11-12T19:30:00Z' })
  c.eq('§2 the fields the server sends are the ones the page reads', Object.keys(sent), ['title', 'text', 'time'])
  c.eq('§2 ...and a row the server sends shows as itself', L.alertsSentView({ linked: true, limit: server.ALERTS_LIMIT, alerts: [sent] }).rows,
    [{ title: 'QA title', text: 'QA text', time: 'Nov 12, 2026, 2:30 PM EST' }])
  c.eq('§2 a list of the server\'s cap says so', L.alertsSentView(listOf(server.ALERTS_LIMIT, server.ALERTS_LIMIT)).newest, `Showing the newest ${server.ALERTS_LIMIT}.`)
  // The server's own handler, over made-up deps, answering the page.
  const answer = (spelling, rows) => {
    const chains = []
    server.mount({ get: (p, ...chain) => chains.push(chain) }, {
      requireRole: () => (req, res, next) => next(),
      db: { prepare: () => ({ get: () => ({ id: 11, driver_name: 'QA Driver' }), all: () => rows }) },
      accountSpelling: () => spelling,
      logger: { error() {} },
    })
    const res = { body: null, status() { return this }, json(b) { this.body = b; return this }, set() { return this } }
    const chain = chains[0] || []
    if (chain.length) chain[chain.length - 1]({ params: { id: '11' } }, res)
    return res.body
  }
  c.eq('§2 the server\'s answer for a driver shows his rows', L.alertsSentView(answer('QA Driver', [{ id: 1, type: 'message', title: 'QA title', body: 'QA text', metadata: '{}', read: 0, createdAt: '2026-11-12T19:30:00Z' }])),
    { note: '', rows: [{ title: 'QA title', text: 'QA text', time: 'Nov 12, 2026, 2:30 PM EST' }], newest: '' })
  c.eq('§2 ...and its answer for a row that names no single account shows that line', L.alertsSentView(answer(null, [])).note, WORDS.noAccount)
  c.ok('§2 server.js wires the route to findDriverAccountSpelling()', serverSource().includes('driverAlertsSent.mount(app, { requireRole, db, accountSpelling: findDriverAccountSpelling });'))
}

// ── §3 the panel, mounted ────────────────────────────────────────────────────
// No DOM: an in-memory renderer, with a stub for the API.
let VUE = null
function vue() {
  if (VUE) return VUE
  const req = createRequire(path.join(ROOT, 'client', 'package.json'))
  VUE = { Vue: req('vue'), SFC: req('vue/compiler-sfc') }
  globalThis.document = globalThis.document || { activeElement: null }
  return VUE
}

// The panel's script and template as one function of its imports, per source text.
const factories = new Map()
function panelFactory(src) {
  if (factories.has(src)) return factories.get(src)
  const { SFC } = vue()
  const { descriptor, errors } = SFC.parse(src, { filename: 'DriverAlertsSentPanel.vue' })
  if (errors && errors.length) throw new Error(`the panel does not parse: ${errors[0].message}`)
  let body = SFC.compileScript(descriptor, { id: 'alerts-sent-panel', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('the panel has an import or export this harness cannot map')
  const make = (deps) => {
    const missing = specs.filter((s) => !Object.prototype.hasOwnProperty.call(deps, s))
    if (missing.length) throw new Error(`no stub for ${missing.join(', ')}`)
    return new Function('__deps', body)(deps)
  }
  factories.set(src, make)
  return make
}

function mountInMemory(Comp) {
  const { Vue } = vue()
  const node = (type, tag) => Vue.markRaw({ type, tag, children: [], parent: null, props: {}, text: '' })
  const ops = {
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child)
      child.parent = parent
    },
    remove(child) {
      const p = child.parent
      if (!p) return
      const i = p.children.indexOf(child)
      if (i >= 0) p.children.splice(i, 1)
      child.parent = null
    },
    createElement: (tag) => node('el', tag),
    createText: (t) => Object.assign(node('text'), { text: t }),
    createComment: (t) => Object.assign(node('comment'), { text: t }),
    setText(n, t) { n.text = t },
    setElementText(el, t) { el.children = []; if (t) ops.insert(Object.assign(node('text'), { text: t }), el) },
    parentNode: (n) => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; return p.children[p.children.indexOf(n) + 1] || null },
    querySelector: () => null,
    setScopeId() {},
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const warnings = []
  const root = node('el', 'root')
  const app = Vue.createRenderer(ops).createApp(Comp)
  app.config.warnHandler = (msg) => warnings.push(String(msg))
  app.mount(root)
  const textOf = (n) => (!n ? '' : n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => {
    if (!n) return out
    if (n.type === 'el' && pred(n)) out.push(n)
    for (const ch of n.children || []) all(ch, pred, out)
    return out
  }
  return {
    warnings,
    findAll: (pred, from = root) => all(from, pred),
    text: (n) => textOf(n).replace(/\s+/g, ' ').trim(),
    unmount: () => app.unmount(),
  }
}

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

// An API whose answers the test settles: every call recorded, a GET left waiting until
// its answer is given.
function fakeApi() {
  const calls = []
  const waiting = []
  const record = (method) => (url) => { calls.push(`${method} ${url}`); return Promise.resolve({}) }
  const api = {
    get: (url) => {
      calls.push(`GET ${url}`)
      return new Promise((resolve, reject) => waiting.push({ url, resolve, reject }))
    },
    post: record('POST'), put: record('PUT'), patch: record('PATCH'), del: record('DELETE'),
  }
  const settle = async (url, how) => {
    const i = waiting.findIndex((w) => w.url === url)
    if (i < 0) throw new Error(`no request waiting for ${url}`)
    const [w] = waiting.splice(i, 1)
    if (how.answer !== undefined) w.resolve(how.answer)
    else w.reject(Object.assign(new Error(how.words || 'Request failed'), { status: how.status, code: how.code || '', data: {} }))
    await drain()
  }
  return { api, calls, settle }
}

function mountPanel({ L, src, api, id }) {
  const { Vue } = vue()
  const Panel = panelFactory(src)({ vue: Vue, '../../composables/useApi': { useApi: () => api }, '../../lib/driverAlertsSent': L })
  const current = Vue.ref(id)
  const Root = Vue.defineComponent({ setup: () => () => Vue.h(Panel, { directoryId: current.value }) })
  const m = mountInMemory(Root)
  const byTestid = (testid) => m.findAll((n) => n.props['data-testid'] === testid)
  const part = (row, cls) => m.findAll((n) => n.props.class === cls, row).map((n) => m.text(n))
  const shown = () => {
    const section = byTestid('alerts-sent')
    const heading = section.length ? m.findAll((n) => n.tag === 'h4', section[0]).map((n) => m.text(n)) : []
    return {
      sections: section.length,
      heading: heading[0] || '',
      note: byTestid('alerts-sent-note').map((n) => m.text(n)).join(' | '),
      newest: byTestid('alerts-sent-newest').map((n) => m.text(n)).join(' | '),
      rows: byTestid('alerts-sent-row').map((row) => ({
        title: part(row, 'asp-row-title').join(' | '),
        text: part(row, 'asp-row-text').join(' | '),
        time: part(row, 'asp-row-time').join(' | '),
      })),
    }
  }
  return { ...m, shown, setId: async (n) => { current.value = n; await drain() } }
}

const URL11 = '/api/drivers-directory/11/alerts-sent'
const URL12 = '/api/drivers-directory/12/alerts-sent'
const NOTHING = { sections: 0, heading: '', note: '', newest: '', rows: [] }
const noted = (note) => ({ sections: 1, heading: WORDS.heading, note, newest: '', rows: [] })

async function panelChecks(c, L, src) {
  vue()
  const writes = []
  const open = async (id = 11) => {
    const f = fakeApi()
    const m = mountPanel({ L, src, api: f.api, id })
    await drain()
    return { f, m, done: () => { writes.push(...f.calls.filter((x) => !x.startsWith('GET '))); m.unmount() } }
  }

  let { f, m, done } = await open()
  c.eq('§3 before the answer: nothing shown', m.shown(), NOTHING)
  await f.settle(URL11, { answer: ANSWER })
  c.eq('§3 one GET, for its own row', f.calls, [`GET ${URL11}`])
  c.eq('§3 the list: the heading and each row\'s title, text and time, in the order sent', m.shown(), { sections: 1, heading: WORDS.heading, note: '', newest: '', rows: SHOWN })
  c.eq('§3 ...and no warning from Vue', m.warnings, [])
  done()

  ;({ f, m, done } = await open())
  await f.settle(URL11, { answer: listOf(100) })
  const capped = m.shown()
  c.eq('§3 a list at the cap: the line that it shows the newest, over its 100 rows', [capped.newest, capped.rows.length], ['Showing the newest 100.', 100])
  done()
  ;({ f, m, done } = await open())
  await f.settle(URL11, { answer: listOf(99) })
  c.eq('§3 ...and below it, no such line', [m.shown().newest, m.shown().rows.length], ['', 99])
  done()

  for (const [label, answer, words] of [
    ['no alerts', { linked: true, limit: 100, alerts: [] }, WORDS.none],
    ['a row that names no single Driver account', { linked: false }, WORDS.noAccount],
    ['an answer it can\'t read', { linked: true }, WORDS.unreadable],
  ]) {
    ;({ f, m, done } = await open())
    await f.settle(URL11, { answer })
    c.eq(`§3 ${label}: the heading and its line, no rows`, m.shown(), noted(words))
    done()
  }
  for (const [label, how] of [['a refusal the server words (500)', { status: 500, code: 'READ_FAILED' }], ['no answer (status 0)', { status: 0 }]]) {
    ;({ f, m, done } = await open())
    await f.settle(URL11, how)
    c.eq(`§3 ${label}: the unreadable line`, m.shown(), noted(WORDS.unreadable))
    done()
  }
  for (const [label, how] of [['a 403 (not this viewer\'s)', { status: 403 }], ['a 404 (a server without the route)', { status: 404 }]]) {
    ;({ f, m, done } = await open())
    await f.settle(URL11, how)
    c.eq(`§3 ${label}: nothing shown`, m.shown(), NOTHING)
    done()
  }
  for (const id of [null, 0]) {
    ;({ f, m, done } = await open(id))
    c.eq(`§3 a row with no id (${id}): nothing asked, nothing shown`, [f.calls, m.shown()], [[], NOTHING])
    done()
  }

  // Another row while one is shown, and while one is still out.
  ;({ f, m, done } = await open())
  await f.settle(URL11, { answer: ANSWER })
  await m.setId(12)
  c.eq('§3 another row: the last row\'s list is gone at once, before the next answer', m.shown(), NOTHING)
  await f.settle(URL12, { answer: { linked: true, limit: 100, alerts: [ANSWER.alerts[2]] } })
  c.eq('§3 ...then that row\'s own list', m.shown().rows, [SHOWN[2]])
  done()
  ;({ f, m, done } = await open())
  await m.setId(12)
  await f.settle(URL12, { answer: { linked: true, limit: 100, alerts: [ANSWER.alerts[2]] } })
  await f.settle(URL11, { answer: ANSWER })
  c.eq('§3 a late answer for the row before is dropped', [f.calls, m.shown().rows], [[`GET ${URL11}`, `GET ${URL12}`], [SHOWN[2]]])
  done()
  ;({ f, m, done } = await open())
  m.unmount()
  let threw = false
  try { await f.settle(URL11, { answer: ANSWER }) } catch { threw = true }
  c.eq('§3 closed while its answer is out: nothing thrown, no warning', [threw, m.warnings], [false, []])
  c.eq('§3 no write, ever: every call the panel made is a GET', writes, [])
}

// ── §4 the dialog and the sources ────────────────────────────────────────────
function sourceChecks(c, panelSrc, tableSrc) {
  const tpl = stripComments(templateOf(panelSrc))
  const fields = [...new Set([...tpl.matchAll(/\brow\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))].sort()
  c.eq('§4 the panel reads only a row\'s title, text and time', fields, ['text', 'time', 'title'])
  c.ok('§4 ...and shows them as text, never as HTML', !/v-html|innerHTML/.test(tpl))
  const script = stripComments((panelSrc.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || '')
  c.ok('§4 the panel sends nothing: no post, put, patch or delete', !/api\.(post|put|patch|del)\b|method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(script))
  const code = stripComments(tableSrc)
  const TAG = '<DriverAlertsSentPanel v-if="viewDrv._rowIndex" :directory-id="viewDrv._rowIndex" />'
  c.eq('§4 DriverTable.vue imports the panel once and shows it once', [count(code, "import DriverAlertsSentPanel from './DriverAlertsSentPanel.vue'"), count(code, '<DriverAlertsSentPanel')], [1, 1])
  // The dialog's markers are comments, so the dialog is cut from the file as written.
  const dialog = tableSrc.slice(tableSrc.indexOf('<!-- View Detail -->'), tableSrc.indexOf('<!-- Edit Modal -->'))
  c.ok('§4 ...in the detail dialog, for the row it opened, after the shared documents',
    dialog.includes(TAG) && dialog.indexOf('<LegalDocumentPortal') >= 0 && dialog.indexOf('<LegalDocumentPortal') < dialog.indexOf(TAG))
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p)
    return /\.(vue|js|ts)$/.test(e.name) ? [p] : []
  })
  // The route's last segment, with its slash: the panel's test ids carry the words alone.
  const askers = walk(CLIENT_SRC).filter((p) => read(p).includes('/alerts-sent')).map((p) => path.relative(CLIENT_SRC, p).split(path.sep).join('/')).sort()
  c.eq('§4 only the lib names the route', askers, ['lib/driverAlertsSent.js'])
  const router = read(ROUTER)
  const m = router.match(/path:\s*'\/drivers',[\s\S]{0,200}?roles:\s*\[([^\]]*)\]/)
  c.eq('§4 the Drivers page is Super Admin only', m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : null, ['Super Admin'])
}

// ── run ──────────────────────────────────────────────────────────────────────
async function runAll(c, { L, panelSrc = PANEL_SRC, tableSrc = TABLE_SRC }) {
  const guard = (name, fn) => { try { return fn() } catch (e) { c.ok(`${name} ran (${String(e.message || e).slice(0, 120)})`, false) } }
  guard('§1', () => libChecks(c, L))
  guard('§2', () => parityChecks(c, L))
  try { await panelChecks(c, L, panelSrc) } catch (e) { c.ok(`§3 ran (${String(e.message || e).slice(0, 160)})`, false) }
  guard('§4', () => sourceChecks(c, panelSrc, tableSrc))
}

let lib = null
try { lib = await import(pathToFileURL(LIB).href) } catch { lib = null }
const main = checker(true)
console.log('\n§0 the files')
main.ok('§0 client/src/lib/driverAlertsSent.js loads', !!lib)
main.ok('§0 DriverAlertsSentPanel.vue exists', !!PANEL_SRC)
if (lib) {
  // The app's own clock, as the server sends it; the answers above are on it.
  const { setAppTimeZone } = await import(DATETIME_URL)
  setAppTimeZone('America/New_York')
  console.log('\n§1-§4')
  await runAll(main, { L: lib })

  console.log('\n§5 mutants')
  const libMut = (from, to) => ({ lib: count(LIB_SRC, from) === 1 ? LIB_SRC.replace(from, to) : null })
  const panelMut = (from, to) => ({ panel: count(PANEL_SRC, from) === 1 ? PANEL_SRC.replace(from, to) : null })
  const tableMut = (from, to) => ({ table: count(TABLE_SRC, from) === 1 ? TABLE_SRC.replace(from, to) : null })
  async function mutant(id, label, made) {
    const source = made.lib !== undefined ? made.lib : made.panel !== undefined ? made.panel : made.table
    if (source === null) { fail++; console.log(`  FAIL  ${id} does not apply (${label})`); return }
    const c = checker(false)
    let L = lib
    try {
      if (made.lib !== undefined) L = await import(`data:text/javascript,${encodeURIComponent(absImports(made.lib))}`)
      await runAll(c, { L, panelSrc: made.panel !== undefined ? made.panel : PANEL_SRC, tableSrc: made.table !== undefined ? made.table : TABLE_SRC })
    } catch (e) {
      c.failed.push(`crashed: ${e.message}`)
    }
    if (c.failed.length) { pass++; console.log(`  ok    ${id} caught (${label}): ${c.failed[0]}`) }
    else { fail++; console.log(`  FAIL  ${id} not caught (${label})`) }
  }
  await mutant('L1', 'the newest line below the cap', libMut("newest: limit && answer.alerts.length >= limit ? newestLine(limit) : ''", "newest: limit ? newestLine(limit) : ''"))
  await mutant('L2', 'the time off the app\'s clock', libMut("time: fmtAppInstant(a.time, { fallback: '' }),", "time: String(a.time || ''),"))
  await mutant('L3', 'every field of a row kept', libMut('    title: a.title,', '    ...a,\n    title: a.title,'))
  await mutant('L4', 'an unlinked row read as one with no alerts', libMut('if (answer.linked === false) return noted(ALERTS_WORDS.noAccount)', 'if (answer.linked === false) return noted(ALERTS_WORDS.none)'))
  await mutant('L5', 'every refusal kept away', libMut('return !!err && (err.status === 403 || err.status === 404)', 'return !!err && err.status >= 400'))
  await mutant('L6', 'a route for any id', libMut('Number.isSafeInteger(directoryId) && directoryId > 0 ?', 'directoryId ?'))
  await mutant('P1', 'the panel showing a field the server never sends', panelMut('<span class="asp-row-title">{{ row.title }}</span>', '<span class="asp-row-title">{{ row.title }} {{ row.type }}</span>'))
  await mutant('P2', 'a late answer kept', panelMut('if (mine === seq) view.value = alertsSentView(answer)', 'view.value = alertsSentView(answer)'))
  await mutant('P3', 'a 403 or a 404 shown as unreadable', panelMut('if (mine === seq) view.value = isHiddenAnswer(err) ? null : alertsSentView(null)', 'if (mine === seq) view.value = alertsSentView(null)'))
  await mutant('P4', 'the last row\'s list kept while the next loads', panelMut('  view.value = null\n  const url', '  const url'))
  await mutant('P5', 'the text shown as HTML', panelMut('<span v-if="row.text" class="asp-row-text">{{ row.text }}</span>', '<span v-if="row.text" class="asp-row-text" v-html="row.text"></span>'))
  await mutant('T1', 'the panel keyed to another row', tableMut('<DriverAlertsSentPanel v-if="viewDrv._rowIndex" :directory-id="viewDrv._rowIndex" />', '<DriverAlertsSentPanel v-if="viewDrv._rowIndex" :directory-id="drivers[0]._rowIndex" />'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
