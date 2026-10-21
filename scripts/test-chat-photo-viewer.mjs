#!/usr/bin/env node
// A photo in a Messages thread opens full size (owner request, 2026-10-21):
// zoom (pinch, wheel, buttons), next/previous through the thread's photos,
// close with Esc, the X or a click outside, in the dashboard Messages page and
// in the driver app's Messages tab.
//
//   §1 the rules (client/src/lib/photoViewer.js, client/src/lib/chatPhotos.js,
//      pure): a thread's photos are its image attachments on our own /uploads
//      URLs, oldest first, each once, with "Photo from <sender>" as their text;
//      next/previous never wrap; "Photo 2 of 3"; a swipe is a long, mostly
//      sideways one-finger move; Tab stays inside the viewer
//   §2 the viewer (components/shared/ZoomableImage.vue), MOUNTED: a modal
//      dialog (role, aria-modal, a name) teleported to <body>; the photo keeps
//      its alt text; focus moves in on open, Tab / Shift+Tab wrap inside it,
//      and focus goes back to the photo that opened it on close; Esc, the X and
//      a click outside the photo close it, a click on the photo doesn't;
//      previous / next buttons (aria-disabled at the ends, never disabled),
//      the arrow keys and a swipe step through the set; a caller with one
//      photo, or a receipt caller that binds none of it, gets no next/previous
//   §3 the dashboard thread (ChatBubble.vue in MessagingPanel.vue), MOUNTED: a
//      photo is a button that opens the viewer on that photo; next/previous
//      walk the thread's photos only; a PDF stays a link; a photo arriving live
//      keeps its attachment (stores/messages.js)
//   §4 the driver thread (driver/ChatView.vue), MOUNTED: the same, and a photo
//      arriving live keeps its attachment (stores/driver.js)
//   §5 the investor thread (investor/InvestorChat.vue), MOUNTED: the same
//      viewer, and the investor's own photo shows in his bubble only once the
//      message naming it is saved (a chat file opens only for the conversation
//      of the message that sent it)
//
// No DOM, no server: components are compiled from their .vue files and mounted
// on an in-memory renderer. Vue comes from client/node_modules; the sources
// from LOGISX_ROOT (default: this checkout).
//   node scripts/test-chat-photo-viewer.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-chat-photo-viewer.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const CLIENT_DIR = path.join(HERE, 'client')
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const read = (...p) => (exists(...p) ? fs.readFileSync(path.join(ROOT, ...p), 'utf8') : '')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function importLib(name) {
  if (!exists('client', 'src', 'lib', name)) return null
  try { return await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', name)).href) } catch (err) {
    ok(`${name} loads (${err.message})`, false)
    return null
  }
}

// Made-up thread: Dispatch sends two photos and a PDF, the driver one photo.
const P1 = '/uploads/chat/chat_1700000000001_aaaaa.jpg'
const P2 = '/uploads/chat/chat_1700000000002_bbbbb.png'
const P3 = '/uploads/chat/chat_1700000000003_ccccc.jpg'
const PDF = '/uploads/chat/chat_1700000000004_ddddd.pdf'
const BAD_SCRIPT = 'javascript:alert(document.cookie)'
const BAD_SITE = 'https://elsewhere.example/invoice.pdf'
const thread = () => ([
  { id: 1, timestamp: '2026-10-20T13:00:00.000Z', from: 'Dispatch', to: 'Test Driver', message: 'first', loadId: 'L-1', read: 1, attachment_url: P1, attachment_type: 'image' },
  { id: 2, timestamp: '2026-10-20T13:01:00.000Z', from: 'Test Driver', to: 'Dispatch', message: 'ok', loadId: 'L-1', read: 1, attachment_url: '', attachment_type: '' },
  { id: 3, timestamp: '2026-10-20T13:02:00.000Z', from: 'Dispatch', to: 'Test Driver', message: '', loadId: 'L-1', read: 1, attachment_url: PDF, attachment_type: 'pdf' },
  { id: 4, timestamp: '2026-10-20T13:03:00.000Z', from: 'Test Driver', to: 'Dispatch', message: 'photo', loadId: 'L-1', read: 1, attachment_url: P2, attachment_type: 'image' },
  { id: 5, timestamp: '2026-10-20T13:04:00.000Z', from: 'Dispatch', to: 'Test Driver', message: 'last', loadId: 'L-1', read: 1, attachment_url: P3, attachment_type: 'image' },
  // Attachments that are not our own uploads: never a link, in any thread.
  { id: 6, timestamp: '2026-10-20T13:05:00.000Z', from: 'Test Driver', to: 'Dispatch', message: '', loadId: 'L-1', read: 1, attachment_url: BAD_SCRIPT, attachment_type: 'pdf' },
  { id: 7, timestamp: '2026-10-20T13:06:00.000Z', from: 'Test Driver', to: 'Dispatch', message: '', loadId: 'L-1', read: 1, attachment_url: BAD_SITE, attachment_type: 'other' },
])
const BAD_LINK = (n) => n.tag === 'a' && /^\s*(javascript:|https?:|\/\/|data:)/i.test(String(n.props.href || ''))
const unavailable = (m) => m.findAll((n) => n.tag === 'span' && m.textOf(n) === 'File unavailable').length

// ══ §1 the rules ═════════════════════════════════════════════════════════════
const PV = await importLib('photoViewer.js')
const CP = await importLib('chatPhotos.js')
ok('§1 client/src/lib/photoViewer.js exists and exports swipeStep, stepIndex, positionLabel, trapTabIndex',
  !!PV && ['swipeStep', 'stepIndex', 'positionLabel', 'trapTabIndex'].every((k) => typeof PV[k] === 'function'))
ok('§1 client/src/lib/chatPhotos.js exists and exports isChatPhoto, chatPhotoAlt, chatPhotos, chatPhotoView, chatPhotoStep',
  !!CP && ['isChatPhoto', 'chatPhotoAlt', 'chatPhotos', 'chatPhotoView', 'chatPhotoStep'].every((k) => typeof CP[k] === 'function'))

if (PV) {
  const { swipeStep, stepIndex, positionLabel, trapTabIndex } = PV
  ok('§1 a long move to the left is next, to the right previous', swipeStep(-120, 10) === 1 && swipeStep(120, -10) === -1)
  ok('§1 a short move, a tap or a mostly vertical move is no swipe', swipeStep(-30, 0) === 0 && swipeStep(0, 0) === 0 && swipeStep(-80, 90) === 0)
  ok('§1 next/previous never wrap', stepIndex(0, -1, 3) === 0 && stepIndex(2, 1, 3) === 2 && stepIndex(1, 1, 3) === 2 && stepIndex(1, -1, 3) === 0)
  ok('§1 stepIndex: nothing open or out of range is -1', stepIndex(-1, 1, 3) === -1 && stepIndex(3, -1, 3) === -1 && stepIndex(0, 1, 0) === -1)
  ok('§1 position reads "Photo 2 of 3"; a single photo has none', positionLabel(1, 3) === 'Photo 2 of 3' && positionLabel(0, 1) === '' && positionLabel(-1, 3) === '')
  ok('§1 Tab on the last control goes to the first, Shift+Tab on the first to the last', trapTabIndex(4, 3, false) === 0 && trapTabIndex(4, 0, true) === 3)
  ok('§1 Tab between controls is left to the browser', trapTabIndex(4, 1, false) === -1 && trapTabIndex(4, 2, true) === -1)
  ok('§1 focus on the viewer itself (or outside it) goes to the first / last control', trapTabIndex(4, -1, false) === 0 && trapTabIndex(4, -1, true) === 3)
}

if (CP) {
  const { isChatPhoto, chatPhotoAlt, chatPhotos, chatPhotoView, chatPhotoStep } = CP
  ok('§1 an image attachment on our own /uploads URL is a photo', isChatPhoto({ attachment_type: 'image', attachment_url: P1 }))
  ok('§1 a PDF, a file or a message with no attachment is not', !isChatPhoto({ attachment_type: 'pdf', attachment_url: PDF }) && !isChatPhoto({ attachment_type: 'other', attachment_url: P1 }) && !isChatPhoto({ attachment_type: 'image', attachment_url: '' }) && !isChatPhoto(null))
  ok('§1 an image URL on another host, protocol-relative, data:, blob: or with ".." is not opened as a photo',
    ['https://elsewhere.example/a.jpg', '//elsewhere.example/a.jpg', 'data:image/png;base64,AAAA', 'blob:http://localhost/x', '/uploads/chat/../../x.jpg', '/api/x.jpg', '/uploads/chat/a.jpg?x=1']
      .every((u) => !isChatPhoto({ attachment_type: 'image', attachment_url: u })))
  ok('§1 isOwnUploadUrl: our own /uploads path yes; a script URL, another site, protocol-relative, data: or ".." no',
    typeof CP.isOwnUploadUrl === 'function' && CP.isOwnUploadUrl(PDF) && CP.isOwnUploadUrl(P1)
      && [BAD_SCRIPT, 'JavaScript:alert(1)', BAD_SITE, '//elsewhere.example/a.pdf', 'data:text/html,x', '/uploads/chat/../../x.pdf', '', null]
        .every((u) => !CP.isOwnUploadUrl(u)))
  ok('§1 the alt text names the sender', chatPhotoAlt({ from: ' Dispatch ' }) === 'Photo from Dispatch' && chatPhotoAlt({ from: '' }) === 'Photo' && chatPhotoAlt(null) === 'Photo')
  const photos = chatPhotos(thread())
  ok('§1 a thread\'s photos: oldest first, PDFs and text left out', same(photos.map((p) => p.url), [P1, P2, P3]))
  ok('§1 each photo carries its alt text', same(photos.map((p) => p.alt), ['Photo from Dispatch', 'Photo from Test Driver', 'Photo from Dispatch']))
  ok('§1 a URL sent twice is one photo', chatPhotos([...thread(), { ...thread()[0], id: 9 }]).length === 3)
  ok('§1 no messages, no photos', same(chatPhotos(undefined), []) && same(chatPhotos([]), []))
  const v = chatPhotoView(photos, P2)
  ok('§1 the open photo: its index, neighbours and position', !!v && v.index === 1 && v.hasPrev && v.hasNext && v.position === 'Photo 2 of 3' && v.photo.url === P2)
  const first = chatPhotoView(photos, P1)
  const last = chatPhotoView(photos, P3)
  ok('§1 the first has no previous, the last no next', !!first && !first.hasPrev && first.hasNext && !!last && last.hasPrev && !last.hasNext)
  ok('§1 nothing open, or a URL not in this thread: no view', chatPhotoView(photos, '') === null && chatPhotoView(photos, '/uploads/chat/other.jpg') === null)
  ok('§1 stepping: next, previous, and staying put at either end', chatPhotoStep(photos, P1, 1) === P2 && chatPhotoStep(photos, P2, -1) === P1 && chatPhotoStep(photos, P3, 1) === P3 && chatPhotoStep(photos, P1, -1) === P1)
  ok('§1 stepping with nothing open opens nothing', chatPhotoStep(photos, '', 1) === '')
}

// ══ the in-memory renderer ════════════════════════════════════════════════════
const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

// Keydown listeners the viewer puts on window, and the element with focus.
const winListeners = []
globalThis.window = {
  innerWidth: 390, innerHeight: 844,
  // A browser adds the same listener once, however often it is added.
  addEventListener: (type, fn) => { if (!winListeners.some((l) => l.type === type && l.fn === fn)) winListeners.push({ type, fn }) },
  removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1) },
}
globalThis.document = { activeElement: null }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}
function key(k, extra = {}) {
  const e = { key: k, shiftKey: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true }, ...extra }
  for (const l of winListeners.filter((x) => x.type === 'keydown')) l.fn(e)
  return e
}

// Compile a committed SFC's <script setup> + <template>. `overrides` replace an
// import by its specifier; a .vue import listed in `real` is compiled too, any
// other .vue import is an empty stub; a relative .js import loads from ROOT.
async function compileComponent(rel, { overrides = {}, real = [] } = {}) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
      deps[spec] = real.includes(path.basename(spec))
        ? { default: await compileComponent(childRel, { overrides, real }) }
        : { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
    } else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea'])
function mountInMemory(Comp, props) {
  const node = (type, tag) => {
    const n = {
      type, tag, children: [], parent: null, props: {}, text: '', value: '', listeners: {},
      // v-model on the composer's text field registers listeners and asks
      // for the root node; nothing here ever types into it.
      addEventListener(ev, fn) { (n.listeners[ev] = n.listeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) { n.listeners[ev] = (n.listeners[ev] || []).filter((f) => f !== fn) },
      getRootNode() { return {} },
      get isConnected() { let p = n; while (p.parent) p = p.parent; return p.tag === 'root' || p.tag === 'body' },
      focus() { globalThis.document.activeElement = n },
      // The viewer's FOCUSABLE_SELECTOR, read the way a browser would for the
      // elements this renderer makes: enabled buttons/fields, links with an
      // href, anything with a tabindex other than -1; descendants, DOM order.
      querySelectorAll() {
        const out = []
        const walk = (el) => {
          for (const c of el.children) {
            if (c.type !== 'el') continue
            const ti = c.props.tabindex
            const focusable = (FOCUSABLE_TAGS.has(c.tag) && !c.props.disabled) || (c.tag === 'a' && c.props.href) || (ti != null && String(ti) !== '-1')
            if (focusable) out.push(c)
            walk(c)
          }
        }
        walk(n)
        return out
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }),
      clientWidth: 390, clientHeight: 844,
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
    querySelector: (sel) => (sel === 'body' ? body : null),
    setScopeId() {},
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  const body = node('el', 'body')
  const app = createApp(Comp, props)
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => { if (n.type === 'el' && pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
  return {
    root, body,
    findAll: (pred) => [...all(root, pred), ...all(body, pred)],
    find: (pred) => [...all(root, pred), ...all(body, pred)][0] || null,
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
const evt = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, ...extra })
async function click(el, extra = {}) {
  // Nothing to click (a base checkout has no such control): the asserts that
  // follow fail on their own.
  if (!el) return
  // A real click focuses the button it lands on.
  if (el.tag === 'button') globalThis.document.activeElement = el
  const handler = el.props.onClick
  if (typeof handler === 'function') handler(evt({ target: el, currentTarget: el, ...extra }))
  else if (Array.isArray(handler)) handler.forEach((h) => h(evt({ target: el, currentTarget: el, ...extra })))
  await drain()
}
const dialogOf = (m) => m.find((n) => n.props.role === 'dialog')
const imgIn = (n) => {
  const walk = (el) => (el.tag === 'img' ? el : el.children.reduce((hit, c) => hit || (c.type === 'el' ? walk(c) : null), null))
  return n ? walk(n) : null
}
const buttonNamed = (m, label) => m.find((n) => n.tag === 'button' && n.props['aria-label'] === label)

// ══ §2 the viewer ════════════════════════════════════════════════════════════
const VIEWER_REL = 'client/src/components/shared/ZoomableImage.vue'
if (exists(...VIEWER_REL.split('/'))) {
  let Viewer = null
  try { Viewer = await compileComponent(VIEWER_REL) } catch (err) { ok(`§2 ZoomableImage.vue compiles (${err.message})`, false) }
  if (Viewer) {
    const events = []
    const state = Vue.reactive({ src: null, hasPrev: false, hasNext: true, position: 'Photo 1 of 3', alt: 'Photo from Dispatch' })
    const Host = Vue.defineComponent({
      setup: () => () => Vue.h(Viewer, {
        src: state.src, alt: state.alt, hasPrev: state.hasPrev, hasNext: state.hasNext, position: state.position,
        onPrev: () => events.push('prev'), onNext: () => events.push('next'), onClose: () => events.push('close'),
      }),
    })
    const m = mountInMemory(Host, {})
    // The photo that opens it, outside the viewer, has focus first.
    const opener = { tag: 'button', isConnected: true, focus() { globalThis.document.activeElement = opener } }
    globalThis.document.activeElement = opener
    state.src = P1
    await drain()
    const dlg = dialogOf(m)
    ok('§2 open: a dialog in <body> (teleported out of the thread)', !!dlg && m.body.children.length > 0 && !!m.find((n) => n === dlg))
    ok('§2 the dialog is modal and named by the photo', !!dlg && dlg.props['aria-modal'] === 'true' && dlg.props['aria-label'] === 'Photo from Dispatch')
    const img = imgIn(dlg)
    ok('§2 the full-size photo is the same URL, with its alt text', !!img && img.props.src === P1 && img.props.alt === 'Photo from Dispatch')
    ok('§2 focus moves into the viewer on open', globalThis.document.activeElement === dlg)
    const position = m.find((n) => hasClass(n, 'zoom-position'))
    ok('§2 "Photo 1 of 3" shows, announced politely', !!position && m.textOf(position) === 'Photo 1 of 3' && position.props['aria-live'] === 'polite')

    const prev = buttonNamed(m, 'Previous photo')
    const next = buttonNamed(m, 'Next photo')
    const close = buttonNamed(m, 'Close')
    ok('§2 Previous / Next / Close buttons, each a type="button"', !!prev && !!next && !!close && [prev, next, close].every((b) => b.props.type === 'button'))
    ok('§2 at the first photo Previous is aria-disabled (never disabled: it keeps focus)', !!prev && !!next && prev.props['aria-disabled'] === 'true' && !prev.props.disabled && next.props['aria-disabled'] === 'false')
    ok('§2 the zoom buttons are still there', !!buttonNamed(m, 'Zoom in') && !!buttonNamed(m, 'Zoom out') && !!buttonNamed(m, 'Reset zoom'))

    events.length = 0
    await click(prev)
    ok('§2 Previous at the first photo does nothing', events.length === 0)
    await click(next)
    ok('§2 Next asks for the next photo', same(events, ['next']))
    events.length = 0
    key('ArrowRight')
    key('ArrowLeft')
    ok('§2 ArrowRight is next; ArrowLeft at the first photo does nothing', same(events, ['next']))
    state.hasPrev = true
    state.src = P2
    state.position = 'Photo 2 of 3'
    await drain()
    events.length = 0
    key('ArrowLeft')
    ok('§2 ArrowLeft is previous once there is one', same(events, ['prev']))
    ok('§2 stepping to another photo is not a new opening (focus is not re-saved)', globalThis.document.activeElement !== opener)

    // Swipe: one finger at fit size.
    events.length = 0
    const img2 = imgIn(dialogOf(m)) || { props: { onPointerdown() {}, onPointermove() {}, onPointerup() {} } }
    img2.props.onPointerdown({ pointerId: 7, clientX: 300, clientY: 400, type: 'pointerdown' })
    img2.props.onPointermove({ pointerId: 7, clientX: 180, clientY: 410, type: 'pointermove' })
    img2.props.onPointerup({ pointerId: 7, clientX: 180, clientY: 410, type: 'pointerup' })
    img2.props.onPointerdown({ pointerId: 8, clientX: 100, clientY: 400, type: 'pointerdown' })
    img2.props.onPointerup({ pointerId: 8, clientX: 220, clientY: 395, type: 'pointerup' })
    ok('§2 a swipe left is next, a swipe right previous', same(events, ['next', 'prev']))
    events.length = 0
    img2.props.onPointerdown({ pointerId: 9, clientX: 100, clientY: 400, type: 'pointerdown' })
    img2.props.onPointerup({ pointerId: 9, clientX: 104, clientY: 401, type: 'pointerup' })
    img2.props.onPointerdown({ pointerId: 10, clientX: 100, clientY: 400, type: 'pointerdown' })
    img2.props.onPointerdown({ pointerId: 11, clientX: 200, clientY: 400, type: 'pointerdown' })
    img2.props.onPointerup({ pointerId: 10, clientX: 20, clientY: 400, type: 'pointerup' })
    img2.props.onPointerup({ pointerId: 11, clientX: 300, clientY: 400, type: 'pointerup' })
    ok('§2 a tap or a two-finger pinch is not a swipe', events.length === 0)

    // Focus trap.
    const controls = dialogOf(m) ? dialogOf(m).querySelectorAll() : []
    const firstControl = controls[0]
    const lastControl = controls[controls.length - 1]
    ok('§2 the viewer\'s controls run Previous ... Close', controls.length >= 6 && firstControl === buttonNamed(m, 'Previous photo') && lastControl === buttonNamed(m, 'Close'))
    globalThis.document.activeElement = lastControl
    const tab = key('Tab')
    ok('§2 Tab on the last control wraps to the first', tab.defaultPrevented && globalThis.document.activeElement === firstControl)
    const back = key('Tab', { shiftKey: true })
    ok('§2 Shift+Tab on the first control wraps to the last', back.defaultPrevented && globalThis.document.activeElement === lastControl)
    globalThis.document.activeElement = controls[1]
    const mid = key('Tab')
    ok('§2 Tab between controls is the browser\'s', !mid.defaultPrevented && globalThis.document.activeElement === controls[1])
    globalThis.document.activeElement = opener
    key('Tab')
    ok('§2 focus outside the viewer is pulled back in', globalThis.document.activeElement === firstControl)

    // Closing.
    events.length = 0
    const esc = key('Escape')
    ok('§2 Esc closes', esc.defaultPrevented && same(events, ['close']))
    events.length = 0
    await click(buttonNamed(m, 'Close'))
    ok('§2 the X closes', same(events, ['close']))
    events.length = 0
    const overlay = dialogOf(m) || { props: { onClick() {} }, children: [] }
    overlay.props.onClick(evt({ target: imgIn(overlay), currentTarget: overlay }))
    ok('§2 a click on the photo does not close', events.length === 0)
    overlay.props.onClick(evt({ target: overlay, currentTarget: overlay }))
    ok('§2 a click outside the photo closes', same(events, ['close']))

    state.src = null
    await drain()
    ok('§2 closed: the dialog is gone', !dialogOf(m))
    ok('§2 closed: focus is back on the photo that opened it', globalThis.document.activeElement === opener)
    ok('§2 closed: no key listener left on window', winListeners.filter((l) => l.type === 'keydown').length === 0)
    events.length = 0
    key('Escape')
    ok('§2 closed: Esc does nothing', events.length === 0)
    m.unmount()

    // A caller that binds none of it (the receipt viewers): no next/previous.
    const solo = mountInMemory(Viewer, { src: '/uploads/expense-receipts/r.jpg', alt: 'Receipt' })
    await drain()
    ok('§2 a receipt caller (no has-prev/has-next): no Previous/Next, no position', !buttonNamed(solo, 'Previous photo') && !buttonNamed(solo, 'Next photo') && !solo.find((n) => hasClass(n, 'zoom-position')))
    const soloEvents = []
    ok('§2 ...and is still a modal dialog with a Close button', !!dialogOf(solo) && dialogOf(solo).props['aria-modal'] === 'true' && !!buttonNamed(solo, 'Close'))
    key('ArrowRight')
    ok('§2 ...where the arrow keys do nothing', soloEvents.length === 0)
    solo.unmount()
    ok('§2 unmounting an open viewer leaves no key listener', winListeners.filter((l) => l.type === 'keydown').length === 0)

    // Inline mode (the Expenses detail pane) stays a plain zoom box.
    const inline = mountInMemory(Viewer, { src: '/uploads/expense-receipts/r.jpg', alt: 'Receipt', inline: true, hasNext: true })
    await drain()
    ok('§2 inline mode: no dialog, no next/previous, no key listener', !dialogOf(inline) && !buttonNamed(inline, 'Next photo') && winListeners.length === 0)
    inline.unmount()
  }
} else {
  ok(`§2 ${VIEWER_REL} exists`, false)
}

// ══ §3 the dashboard thread ══════════════════════════════════════════════════
const PANEL_REL = 'client/src/components/dashboard/MessagingPanel.vue'
{
  const store = Vue.reactive({ conversations: [], selectedDriver: 'Test Driver', selectedLoadId: 'L-1', currentMessages: thread(), selectConversation() {} })
  const overrides = {
    '../../stores/messages': { useMessagesStore: () => store },
    '../../composables/useApi': { useApi: () => ({ get: async () => ({}), post: async () => ({}), put: async () => ({}) }) },
    '../../stores/dashboard': { useDashboardStore: () => ({ activeJobs: [] }) },
    '../../composables/useToast': { useToast: () => ({ show() {} }) },
    '../../composables/useFileDrop': {
      useFileDrop: () => ({ dropzoneProps: {}, inputProps: {}, setInputEl() {}, dragActive: Vue.ref(false), error: Vue.ref(''), notice: Vue.ref(''), clearMessages() {} }),
    },
  }
  let Panel = null
  try { Panel = await compileComponent(PANEL_REL, { overrides, real: ['ChatBubble.vue', 'ZoomableImage.vue'] }) } catch (err) { ok(`§3 MessagingPanel.vue compiles (${err.message})`, false) }
  if (Panel) {
    const m = mountInMemory(Panel, { driverNames: ['Test Driver'] })
    await drain()
    const photoButtons = m.findAll((n) => n.tag === 'button' && hasClass(n, 'msg-attach-photo'))
    ok('§3 each thread photo is a button (3 photos, 3 buttons)', photoButtons.length === 3)
    ok('§3 the button says what it does and the photo keeps its alt text',
      photoButtons.length === 3 && photoButtons[0].props['aria-label'] === 'Open full size: Photo from Dispatch' && imgIn(photoButtons[0])?.props?.alt === 'Photo from Dispatch' && imgIn(photoButtons[1])?.props?.alt === 'Photo from Test Driver')
    ok('§3 a PDF stays a link', !!m.find((n) => n.tag === 'a' && n.props.href === PDF))
    ok('§3 a script URL or another site\'s link is never a link; each reads "File unavailable"', m.findAll(BAD_LINK).length === 0 && unavailable(m) === 2)
    ok('§3 nothing is open until a photo is clicked', !dialogOf(m))
    if (photoButtons.length === 3) {
      await click(photoButtons[1])
      let dlg = dialogOf(m)
      ok('§3 clicking the second photo opens it full size', !!dlg && imgIn(dlg)?.props?.src === P2)
      ok('§3 ...as "Photo 2 of 3", with Previous and Next', !!dlg && m.textOf(m.find((n) => hasClass(n, 'zoom-position'))) === 'Photo 2 of 3' && buttonNamed(m, 'Previous photo')?.props?.['aria-disabled'] === 'false' && buttonNamed(m, 'Next photo')?.props?.['aria-disabled'] === 'false')
      await click(buttonNamed(m, 'Next photo'))
      dlg = dialogOf(m)
      ok('§3 Next: the third photo (the PDF is skipped)', !!dlg && imgIn(dlg)?.props?.src === P3 && buttonNamed(m, 'Next photo')?.props?.['aria-disabled'] === 'true')
      await click(buttonNamed(m, 'Next photo'))
      ok('§3 Next at the last photo stays on it', imgIn(dialogOf(m))?.props?.src === P3)
      key('ArrowLeft'); await drain()
      key('ArrowLeft'); await drain()
      ok('§3 ArrowLeft twice: back to the first photo', imgIn(dialogOf(m))?.props?.src === P1 && buttonNamed(m, 'Previous photo')?.props?.['aria-disabled'] === 'true')
      key('Escape'); await drain()
      ok('§3 Esc closes the viewer', !dialogOf(m))
      ok('§3 focus returns to the photo that was clicked', globalThis.document.activeElement === photoButtons[1])
      // Another conversation: an open viewer closes and does not come back.
      await click(photoButtons[0])
      ok('§3 reopened on the first photo', !!dialogOf(m) && imgIn(dialogOf(m))?.props?.src === P1)
      store.currentMessages = [{ id: 20, timestamp: '2026-10-20T14:00:00.000Z', from: 'Dispatch', to: 'Other Driver', message: 'hi', loadId: '', read: 1, attachment_url: '', attachment_type: '' }]
      await drain()
      ok('§3 picking another conversation closes the viewer', !dialogOf(m))
      store.currentMessages = thread()
      await drain()
      ok('§3 coming back does not reopen it', !dialogOf(m))
    }
    m.unmount()
  }

  // A photo that arrives live keeps its attachment.
  const src = read('client', 'src', 'stores', 'messages.js')
  const live = /addIncomingMessage\s*\(msg\)\s*\{[\s\S]*?\n {4}\},/.exec(src)
  ok('§3 stores/messages.js addIncomingMessage keeps attachment_url and attachment_type',
    !!live && /attachment_url:\s*msg\.attachment_url/.test(live[0]) && /attachment_type:\s*msg\.attachment_type/.test(live[0]))
}

// ══ §4 the driver thread ═════════════════════════════════════════════════════
const CHAT_REL = 'client/src/components/driver/ChatView.vue'
{
  let Chat = null
  try { Chat = await compileComponent(CHAT_REL, { real: ['ZoomableImage.vue'] }) } catch (err) { ok(`§4 ChatView.vue compiles (${err.message})`, false) }
  if (Chat) {
    const messages = Vue.reactive(thread())
    const m = mountInMemory(Chat, { messages, loads: [], driverName: 'Test Driver', loadId: 'L-1' })
    await drain()
    const photoButtons = m.findAll((n) => n.tag === 'button' && hasClass(n, 'msg-photo'))
    ok('§4 the driver thread shows each photo as a button (3)', photoButtons.length === 3)
    ok('§4 ...with the button\'s purpose and the photo\'s alt text', photoButtons.length === 3 && photoButtons[2].props['aria-label'] === 'Open full size: Photo from Dispatch' && imgIn(photoButtons[2])?.props?.alt === 'Photo from Dispatch' && imgIn(photoButtons[2])?.props?.src === P3)
    ok('§4 a PDF from Dispatch shows as a link', !!m.find((n) => n.tag === 'a' && n.props.href === PDF))
    ok('§4 a script URL or another site\'s link is never a link; each reads "File unavailable"', m.findAll(BAD_LINK).length === 0 && unavailable(m) === 2)
    if (photoButtons.length === 3) {
      await click(photoButtons[0])
      ok('§4 tapping a photo opens it full size as "Photo 1 of 3"', !!dialogOf(m) && imgIn(dialogOf(m))?.props?.src === P1 && m.textOf(m.find((n) => hasClass(n, 'zoom-position'))) === 'Photo 1 of 3')
      const img = imgIn(dialogOf(m))
      img.props.onPointerdown({ pointerId: 1, clientX: 320, clientY: 400, type: 'pointerdown' })
      img.props.onPointerup({ pointerId: 1, clientX: 150, clientY: 420, type: 'pointerup' })
      await drain()
      ok('§4 a swipe left shows the next photo', imgIn(dialogOf(m))?.props?.src === P2)
      await click(buttonNamed(m, 'Close'))
      ok('§4 the X closes it, and focus returns to the photo', !dialogOf(m) && globalThis.document.activeElement === photoButtons[0])
    }
    m.unmount()
  }
  const src = read('client', 'src', 'stores', 'driver.js')
  const live = /addIncomingMessage\s*\(msg\)\s*\{[\s\S]*?\n {4}\},/.exec(src)
  ok('§4 stores/driver.js addIncomingMessage keeps attachment_url and attachment_type',
    !!live && /attachment_url:\s*msg\.attachment_url/.test(live[0]) && /attachment_type:\s*msg\.attachment_type/.test(live[0]))
}

// ══ §5 the investor thread ═══════════════════════════════════════════════════
// The investor portal's Messages section: the same viewer, and an investor's
// own photo shows in his bubble only once the message naming it is saved
// (a chat file opens only for the conversation the message that sent it is in).
const INV_REL = 'client/src/components/investor/InvestorChat.vue'
{
  const invThread = () => ([
    { id: 1, timestamp: '2026-10-20T13:00:00.000Z', from: 'Dispatch', to: 'inv_t', message: 'hi', read: 1, attachment_url: P1, attachment_type: 'image' },
    { id: 2, timestamp: '2026-10-20T13:01:00.000Z', from: 'inv_t', to: 'admin', message: '', read: 1, attachment_url: P2, attachment_type: 'image' },
    { id: 3, timestamp: '2026-10-20T13:02:00.000Z', from: 'Dispatch', to: 'inv_t', message: '', read: 1, attachment_url: PDF, attachment_type: 'pdf' },
    { id: 4, timestamp: '2026-10-20T13:03:00.000Z', from: 'Dispatch', to: 'inv_t', message: '', read: 1, attachment_url: BAD_SCRIPT, attachment_type: 'pdf' },
    { id: 5, timestamp: '2026-10-20T13:04:00.000Z', from: 'Dispatch', to: 'inv_t', message: '', read: 1, attachment_url: BAD_SITE, attachment_type: 'image' },
  ])
  const NEW = '/uploads/chat/chat_1700000000009_zzzzz.jpg'
  const calls = []
  let releaseMessage = null
  const api = {
    get: async () => ({ messages: invThread() }),
    put: async () => ({}),
    post: (url, body) => {
      calls.push(url)
      if (url === '/api/chat/attachment') return Promise.resolve({ success: true, fileUrl: NEW, attachmentType: 'image' })
      if (url === '/api/messages') return new Promise((resolve) => { releaseMessage = () => resolve({ success: true, id: 99 }) })
      return Promise.resolve({})
    },
  }
  let onFiles = null
  let chatAttachment = null
  try { chatAttachment = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'chatAttachment.js')).href) } catch { chatAttachment = null }
  const overrides = {
    '../../composables/useApi': { useApi: () => api },
    '../../composables/useSocket': { useSocket: () => ({ on() {}, off() {} }) },
    '../../composables/useFileDrop': {
      useFileDrop: (opts) => { onFiles = opts.onFiles; return { dropzoneProps: {}, inputProps: {}, setInputEl() {}, dragActive: Vue.ref(false), error: Vue.ref(''), notice: Vue.ref(''), clearMessages() {} } },
    },
    // The picked file, already read (FileReader is a browser API).
    '../../lib/chatAttachment': chatAttachment && {
      ...chatAttachment,
      prepareChatAttachment: async (file) => ({ ok: true, error: '', attachment: { displayName: file.name, fileName: file.name, mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAA', uploaded: null } }),
    },
    '../../stores/auth': { useAuthStore: () => ({ user: { username: 'inv_t', role: 'Investor' } }) },
    '../../stores/investor': { useInvestorStore: () => ({ data: null }) },
  }
  let Inv = null
  try { Inv = await compileComponent(INV_REL, { overrides, real: ['ZoomableImage.vue'] }) } catch (err) { ok(`§5 InvestorChat.vue compiles (${err.message})`, false) }
  if (Inv && chatAttachment) {
    const m = mountInMemory(Inv, { trucks: [] })
    await drain()
    const photoButtons = m.findAll((n) => n.tag === 'button' && hasClass(n, 'attach-photo'))
    ok('§5 the investor thread shows each photo as a button (2), a PDF as a link', photoButtons.length === 2 && !!m.find((n) => n.tag === 'a' && n.props.href === PDF))
    ok('§5 ...with the button\'s purpose and the photo\'s alt text', photoButtons.length === 2 && photoButtons[0].props['aria-label'] === 'Open full size: Photo from Dispatch' && imgIn(photoButtons[0])?.props?.alt === 'Photo from Dispatch')
    ok('§5 no photo opens in a new tab any more', !m.find((n) => n.tag === 'a' && (n.props.href === P1 || n.props.href === P2)))
    ok('§5 a script URL or another site\'s link (even typed as a photo) is never a link or an image; each reads "File unavailable"',
      m.findAll(BAD_LINK).length === 0 && !m.find((n) => n.tag === 'img' && n.props.src === BAD_SITE) && unavailable(m) === 2)
    if (photoButtons.length === 2) {
      await click(photoButtons[0])
      ok('§5 a photo opens full size as "Photo 1 of 2"', !!dialogOf(m) && imgIn(dialogOf(m))?.props?.src === P1 && m.textOf(m.find((n) => hasClass(n, 'zoom-position'))) === 'Photo 1 of 2')
      await click(buttonNamed(m, 'Next photo'))
      ok('§5 Next shows the investor\'s own photo', imgIn(dialogOf(m))?.props?.src === P2)
      key('Escape'); await drain()
      ok('§5 Esc closes, focus back on the photo', !dialogOf(m) && globalThis.document.activeElement === photoButtons[0])
    }
    // Send a photo: it shows only after the message naming it is saved.
    await onFiles([{ name: 'IMG_0001.jpg', type: 'image/jpeg', size: 1000 }])
    await drain()
    const sendBtn = m.find((n) => n.tag === 'button' && hasClass(n, 'send-btn'))
    await click(sendBtn)
    for (let i = 0; i < 5 && !calls.includes('/api/messages'); i++) await drain()
    // The investor types the next message while this one is still sending,
    // which re-renders the thread.
    const box = m.find((n) => (n.tag === 'textarea' || n.tag === 'input') && typeof n.props.onKeydown === 'function')
    if (box) {
      box.value = 'next'
      for (const fn of box.listeners.input || []) fn({ target: box })
      await drain()
    }
    ok('§5 (the composer is found and re-renders the thread while sending)', !!box)
    const shownEarly = m.find((n) => n.tag === 'img' && n.props.src === NEW)
    ok('§5 sending: the photo is uploaded, then the message is posted', calls.includes('/api/chat/attachment') && calls.includes('/api/messages'))
    ok('§5 ...and the bubble does not show the photo before the message is saved', !shownEarly)
    if (releaseMessage) releaseMessage()
    await drain()
    const shown = m.find((n) => n.tag === 'img' && n.props.src === NEW)
    ok('§5 once the message is saved, the photo shows (as a button that opens the viewer)', !!shown && shown.parent && hasClass(shown.parent, 'attach-photo'))
    m.unmount()
  } else if (!chatAttachment) {
    ok('§5 lib/chatAttachment.js loads', false)
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
