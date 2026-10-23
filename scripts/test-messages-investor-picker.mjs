#!/usr/bin/env node
// The Messages page's "New message" picker (views/MessagesView.vue with
// components/dashboard/MessagingPanel.vue), MOUNTED:
//
//   §1 a Super Admin: each investor shows by his full name and is written to by
//      his account's sign-in username (GET /api/users/investors'
//      accountUsername), which POST /api/messages addresses him by; an
//      investor with no linked account is left out of the picker.
//   §2 picking an investor with "General" (an investor has no loads) opens his
//      conversation under the sign-in username, and a send goes to it. A
//      driver picked with "General" opens his general conversation too.
//   §3 a Dispatcher: the investors list is never asked for and no investor is
//      offered (investor conversations are Super Admin only).
//
// No DOM, no server: the components are compiled from their .vue files and
// mounted on an in-memory renderer; stores and the API are stubs. Vue comes
// from client/node_modules. Made-up names only.
//   node scripts/test-messages-investor-picker.mjs
//   MESSAGES_VIEW_VUE=<base copy> MESSAGING_PANEL_VUE=<base copy> node scripts/test-messages-investor-picker.mjs   # fails on the base
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const VIEW_REL = 'client/src/views/MessagesView.vue'
const PANEL_REL = 'client/src/components/dashboard/MessagingPanel.vue'
const SOURCES = {
  [VIEW_REL]: process.env.MESSAGES_VIEW_VUE || path.join(ROOT, VIEW_REL),
  [PANEL_REL]: process.env.MESSAGING_PANEL_VUE || path.join(ROOT, PANEL_REL),
}

let failed = 0
const ok = (name, cond) => {
  if (cond) console.log(`ok    ${name}`)
  else { failed++; console.log(`FAIL  ${name}`) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, same(got, want))

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
// v-model on a text field asks whether its root is a Document or ShadowRoot.
globalThis.document = globalThis.document || { activeElement: null }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}

// Compile a component's <script setup> + <template> from SOURCES (a base copy
// when the env names one). `overrides` replace an import by its specifier; a
// .vue import listed in `real` is compiled too, any other .vue import is an
// empty stub; a relative .js import loads from the component's own folder in
// this checkout.
async function compileComponent(rel, { overrides = {}, real = {} } = {}) {
  const file = SOURCES[rel] || path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(path.join(ROOT, rel))
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(rel) })
  let body = compileScript(descriptor, { id: path.basename(rel), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) {
      const childRel = path.relative(ROOT, path.join(dir, spec))
      deps[spec] = real[path.basename(spec)]
        ? { default: await compileComponent(childRel, { overrides: real[path.basename(spec)], real }) }
        : { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
    } else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// An in-memory renderer with just enough of a <select> for v-model: `options`
// (every <option> inside it), `selectedIndex`, and an option's `_value`.
function mountInMemory(Comp, props) {
  const node = (type, tag) => {
    const n = {
      type, tag, children: [], parent: null, props: {}, text: '', value: '', selected: false, listeners: {},
      addEventListener(ev, fn) { (n.listeners[ev] = n.listeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) { n.listeners[ev] = (n.listeners[ev] || []).filter((f) => f !== fn) },
      getRootNode() { return {} },
      focus() {},
      get options() {
        const out = []
        const walk = (el) => { for (const c of el.children) { if (c.type !== 'el') continue; if (c.tag === 'option') out.push(c); else walk(c) } }
        walk(n)
        return out
      },
      get selectedIndex() { return n.options.findIndex((o) => o.selected) },
      set selectedIndex(i) { n.options.forEach((o, j) => { o.selected = j === i }) },
    }
    return Vue.markRaw(n)
  }
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
    patchProp(el, key, prev, next) {
      el.props[key] = next
      if (key === 'value') { el._value = next; el.value = next == null ? '' : String(next) }
    },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  const app = createApp(Comp, props)
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => { if (n.type === 'el' && pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
  return {
    findAll: (pred) => all(root, pred),
    find: (pred) => all(root, pred)[0] || null,
    textOf: (n) => (n ? textOf(n).replace(/\s+/g, ' ').trim() : ''),
    unmount: () => app.unmount(),
  }
}
const hasClass = (n, c) => {
  const v = n && n.props && n.props.class
  if (!v) return false
  if (typeof v === 'string') return v.split(/\s+/).includes(c)
  if (Array.isArray(v)) return v.some((x) => (typeof x === 'string' ? x.split(/\s+/).includes(c) : !!(x && x[c])))
  return !!v[c]
}
const evt = (el) => ({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el })
const fire = (fn, el) => { if (typeof fn === 'function') fn(evt(el)); else if (Array.isArray(fn)) fn.forEach((h) => h(evt(el))) }
async function click(el) {
  if (!el) return
  fire(el.props.onClick, el)
  await drain()
}
// Pick an option of a <select> as a person would: mark it selected, then the
// change event (v-model's listener and any @change).
async function choose(m, select, option) {
  if (!select || !option) return
  for (const o of select.options) o.selected = o === option
  for (const fn of select.listeners.change || []) fn(evt(select))
  fire(select.props.onChange, select)
  await drain()
}
async function typeInto(el, text) {
  if (!el) return
  el.value = text
  for (const fn of el.listeners.input || []) fn(evt(el))
  await drain()
}

// ── fixtures (made up) ─────────────────────────────────────────────────────────
const DRIVER = 'Tamsin Vale'
const INVESTORS_ANSWER = {
  investors: [
    { id: null, username: 'Anouk Prell', CompanyName: 'Anouk Prell', accountUsername: null },
    { id: 50, username: 'Marla Fenwick', CompanyName: 'Marla Fenwick', accountUsername: 'fenwick_q' },
  ],
}

async function mountPage({ superAdmin }) {
  const calls = { gets: [], selects: [], sends: [] }
  const store = Vue.reactive({
    conversations: [], selectedDriver: '', selectedLoadId: '', selectedLoadShown: '', currentMessages: [], totalUnread: 0,
    loadConversations() {},
    addIncomingMessage() {},
    selectConversation(name, loadId, shown) {
      calls.selects.push([name, loadId, shown])
      store.selectedDriver = name
      store.selectedLoadId = loadId || ''
      store.selectedLoadShown = shown == null ? store.selectedLoadId : String(shown)
    },
    async sendMessage(to, message, loadId) { calls.sends.push([to, message, loadId]) },
  })
  const api = {
    get: async (url) => { calls.gets.push(url); return url === '/api/users/investors' ? INVESTORS_ANSWER : {} },
    post: async () => ({}),
    put: async () => ({}),
  }
  const dash = { fleet: [{ Driver: DRIVER }], activeJobs: [], refresh: async () => {} }
  const panelOverrides = {
    '../../stores/messages': { useMessagesStore: () => store },
    '../../composables/useApi': { useApi: () => api },
    '../../stores/dashboard': { useDashboardStore: () => dash },
    '../../composables/useToast': { useToast: () => ({ show() {} }) },
    '../../composables/useVoiceNotesFeature': { useVoiceNotesFeature: () => Vue.ref(false) },
    '../../composables/useFileDrop': {
      useFileDrop: () => ({ dropzoneProps: {}, inputProps: {}, setInputEl() {}, dragActive: Vue.ref(false), error: Vue.ref(''), notice: Vue.ref(''), clearMessages() {} }),
    },
  }
  const viewOverrides = {
    '../stores/dashboard': { useDashboardStore: () => dash },
    '../stores/messages': { useMessagesStore: () => store },
    '../stores/auth': { useAuthStore: () => ({ isSuperAdmin: superAdmin }) },
    '../composables/useSocket': { useSocket: () => ({ connect() {}, register() {}, on() {}, off() {} }) },
    '../composables/useApi': { useApi: () => api },
  }
  const View = await compileComponent(VIEW_REL, { overrides: viewOverrides, real: { 'MessagingPanel.vue': panelOverrides } })
  const m = mountInMemory(View, {})
  await drain()
  await click(m.find((n) => n.tag === 'button' && hasClass(n, 'new-msg-btn')))
  const recipientSelect = m.findAll((n) => n.tag === 'select' && hasClass(n, 'new-msg-select'))[0] || null
  const options = recipientSelect ? recipientSelect.options.map((o) => ({ value: o.value, text: m.textOf(o), el: o })) : []
  return { m, calls, store, recipientSelect, options }
}

// ── §1 + §2 a Super Admin ──────────────────────────────────────────────────────
{
  let page = null
  try { page = await mountPage({ superAdmin: true }) } catch (err) { ok(`§1 the Messages page compiles and mounts (${err.message})`, false) }
  if (page) {
    const { m, calls, recipientSelect, options } = page
    ok('§1 the picker is open with a recipient list', !!recipientSelect)
    ok('§1 the investors list is asked for', calls.gets.includes('/api/users/investors'))
    const marla = options.find((o) => o.text === 'Marla Fenwick')
    eq('§1 the investor shows by his full name and is written to by his sign-in username', marla ? marla.value : null, 'fenwick_q')
    ok('§1 no option is written to by a full name', !options.some((o) => o.value === 'Marla Fenwick'))
    ok('§1 an investor with no linked account is left out', !options.some((o) => o.text === 'Anouk Prell' || o.value === 'Anouk Prell'))
    ok('§1 the driver is still offered by his name', options.some((o) => o.value === DRIVER && o.text === DRIVER))

    await choose(m, recipientSelect, marla && marla.el)
    await click(m.find((n) => n.tag === 'button' && hasClass(n, 'new-msg-start')))
    eq('§2 Open Chat with "General" opens the investor\'s conversation under his sign-in username', calls.selects, [['fenwick_q', '', '']])
    await typeInto(m.find((n) => n.tag === 'input' && hasClass(n, 'msg-input')), 'Made-up hello')
    await click(m.find((n) => n.tag === 'button' && hasClass(n, 'msg-send-btn')))
    eq('§2 the send goes to the sign-in username', calls.sends, [['fenwick_q', 'Made-up hello', '']])
    m.unmount()
  }
}
{
  let page = null
  try { page = await mountPage({ superAdmin: true }) } catch (err) { ok(`§2 the Messages page mounts again (${err.message})`, false) }
  if (page) {
    const { m, calls, recipientSelect, options } = page
    const driver = options.find((o) => o.value === DRIVER)
    await choose(m, recipientSelect, driver && driver.el)
    await click(m.find((n) => n.tag === 'button' && hasClass(n, 'new-msg-start')))
    eq('§2 a driver picked with "General" opens his general conversation', calls.selects, [[DRIVER, '', '']])
    m.unmount()
  }
}

// ── §3 a Dispatcher ────────────────────────────────────────────────────────────
{
  let page = null
  try { page = await mountPage({ superAdmin: false }) } catch (err) { ok(`§3 the Messages page mounts for a Dispatcher (${err.message})`, false) }
  if (page) {
    const { m, calls, options } = page
    ok('§3 a Dispatcher: the investors list is never asked for', !calls.gets.includes('/api/users/investors'))
    eq('§3 a Dispatcher is offered drivers only', options.filter((o) => o.value).map((o) => o.value), [DRIVER])
    m.unmount()
  }
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
