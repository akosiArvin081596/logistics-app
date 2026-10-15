#!/usr/bin/env node
// The load-detail rate con viewer (RateConViewer.vue): wheel and pinch zoom
// centred on the pointer, drag to pan, and no blank frame while zooming (B22).
//
//   §1 the maths (client/src/lib/rateConZoom.js, pure): a zoom keeps the PDF
//      point under the pointer where it is; zoom stays between fit and 400 %;
//      zooming back out lands on the centred fit view; a pinch scales by the
//      fingers' spread and follows their midpoint; the wheel scales by its
//      delta; a drag never pulls the page past its edges; the sharp render
//      stays under the phone canvas limit at 400 %; a resize keeps the centre;
//      a new page opens at its top at the same zoom
//   §2 the component, mounted without a DOM: the wheel listener is non-passive
//      and sits on the PDF area only (never window or document), it prevents
//      the page scroll and zooms about the pointer; - and + are disabled at the
//      limits; a drag pans only on the PDF area and only when zoomed; a shown
//      canvas is never resized or cleared: the sharp render goes into a new,
//      detached canvas that replaces the old one
//   §3 the source: pdf.js still gets only { url } through the essential entry,
//      no new request, touch-action lets a swipe scroll the page at fit
//
//   node scripts/test-ratecon-viewer-zoom.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-ratecon-viewer-zoom.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const read = (...p) => (exists(...p) ? fs.readFileSync(path.join(ROOT, ...p), 'utf8') : '')
const CLIENT_DIR = path.join(HERE, 'client')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// ══ §1 the maths ═════════════════════════════════════════════════════════════
let Z = null
let V = null
try { V = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'rateConView.js')).href) } catch { V = null }
try { Z = exists('client', 'src', 'lib', 'rateConZoom.js') ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'rateConZoom.js')).href) : null } catch (err) { ok(`§1 rateConZoom.js loads (${err.message})`, false) }
ok('§1 client/src/lib/rateConZoom.js exists', !!Z)

const need = ['fitSize', 'fitView', 'zoomAt', 'panBy', 'pinchStep', 'wheelZoomFactor', 'renderDensity', 'keepCentre', 'pageTopView', 'clampView', 'axisRange', 'MAX_CANVAS_PIXELS']
const haveAll = !!Z && need.every((k) => k in Z)
ok(`§1 rateConZoom.js exports ${need.join(', ')}`, haveAll)
ok('§1 zoom runs from fit (100 %) to 400 %: MIN_ZOOM is FIT_ZOOM and MAX_ZOOM is 4', !!V && V.MIN_ZOOM === V.FIT_ZOOM && V.FIT_ZOOM === 1 && V.MAX_ZOOM === 4)
ok('§1 clampZoom and stepZoom default to 400 %', !!V && V.clampZoom(99) === 4 && V.clampZoom(0.2) === 1 && V.stepZoom(4, 1) === 4 && V.stepZoom(1, -1) === 1 && V.stepZoom(3.5, 1) === 4)

if (haveAll && V) {
  // The page point (0..1 across, 0..1 down) under a stage point, for a view.
  const pagePoint = (view, fit, px, py) => ({ u: (px - view.x) / (fit.w * view.zoom), v: (py - view.y) / (fit.h * view.zoom) })
  const screenOf = (view, fit, pt) => ({ x: view.x + pt.u * fit.w * view.zoom, y: view.y + pt.v * fit.h * view.zoom })
  const DESK = { w: 900, h: 700, gap: 8 }
  const PHONE = { w: 348, h: 400, gap: 4 }
  const LETTER = 11 / 8.5
  const deskFit = Z.fitSize(DESK, LETTER)
  const phoneFit = Z.fitSize(PHONE, LETTER)
  ok(`§1 fit on a desktop stage: the height decides, gap kept (${deskFit.w} x ${deskFit.h.toFixed(1)})`, deskFit.w === Math.floor((700 - 16) / LETTER) && deskFit.h <= 700 - 16)
  ok(`§1 fit on a phone stage: the width decides when the stage is tall enough (${phoneFit.w})`, Z.fitSize({ w: 348, h: 600, gap: 4 }, LETTER).w === 340)
  const fit0 = Z.fitView(DESK, deskFit)
  ok('§1 the fit view is centred in the stage, on whole pixels', fit0.zoom === 1 && near(fit0.x, (900 - deskFit.w) / 2, 0.5) && near(fit0.y, (700 - deskFit.h) / 2, 0.5) && Number.isInteger(fit0.x) && Number.isInteger(fit0.y))

  // Cursor-anchored zoom in: five wheel notches at off-centre points.
  for (const [label, px, py] of [['left of centre', 330, 260], ['near the top-left corner', 200, 40], ['right, low', 640, 610], ['the centre', 450, 350]]) {
    let view = fit0
    const before = pagePoint(view, deskFit, px, py)
    for (let i = 0; i < 5; i++) view = Z.zoomAt(view, view.zoom * Z.wheelZoomFactor(-100, 0, false), px, py, DESK, deskFit)
    const after = screenOf(view, deskFit, before)
    ok(`§1 five wheel notches in, pointer ${label}: zoom grew (${view.zoom.toFixed(2)})`, view.zoom > 2)
    ok(`§1 five wheel notches in, pointer ${label}: the PDF point stays under the pointer (moved ${Math.hypot(after.x - px, after.y - py).toFixed(4)} px)`, Math.hypot(after.x - px, after.y - py) < 1e-6)
  }
  // ...and on a phone stage (the width decides there).
  {
    let view = Z.fitView(PHONE, phoneFit)
    const before = pagePoint(view, phoneFit, 90, 120)
    for (let i = 0; i < 4; i++) view = Z.zoomAt(view, view.zoom * 1.3, 90, 120, PHONE, phoneFit)
    const after = screenOf(view, phoneFit, before)
    ok('§1 phone: zooming in keeps the point under the fingers', Math.hypot(after.x - 90, after.y - 120) < 1e-6)
  }
  // Zoom out, while the page still covers the stage, keeps the point too.
  {
    let view = Z.fitView(DESK, deskFit)
    view = Z.zoomAt(view, 3, 450, 350, DESK, deskFit)
    const before = pagePoint(view, deskFit, 470, 330)
    view = Z.zoomAt(view, 2.5, 470, 330, DESK, deskFit)
    const after = screenOf(view, deskFit, before)
    ok('§1 zooming out from 300 % to 250 % mid-page keeps the point under the pointer', Math.hypot(after.x - 470, after.y - 330) < 1e-6)
  }
  // Limits.
  {
    const deep = Z.zoomAt(fit0, 50, 300, 300, DESK, deskFit)
    ok('§1 zoom stops at 400 %', deep.zoom === 4)
    ok('§1 already at 400 %: a further zoom in changes nothing (same view back)', Z.zoomAt(deep, 8, 300, 300, DESK, deskFit) === deep)
    ok('§1 at fit: a zoom out changes nothing (same view back)', Z.zoomAt(fit0, 0.5, 300, 300, DESK, deskFit) === fit0)
    let view = Z.zoomAt(fit0, 3.2, 210, 90, DESK, deskFit)
    for (let i = 0; i < 40 && view.zoom > 1; i++) view = Z.zoomAt(view, view.zoom / 1.15, 700, 600, DESK, deskFit)
    ok('§1 wheeling all the way out lands exactly on the centred fit view (what Fit shows)', view.zoom === 1 && near(view.x, fit0.x) && near(view.y, fit0.y))
    const down = Z.zoomAt(Z.zoomAt(fit0, 1.4, 200, 100, DESK, deskFit), 0.7, 200, 100, DESK, deskFit)
    ok('§1 a zoom below fit is fit, centred', down.zoom === 1 && near(down.x, fit0.x) && near(down.y, fit0.y))
  }
  // Button zoom: centred on the visible centre.
  {
    let view = fit0
    const c = pagePoint(view, deskFit, DESK.w / 2, DESK.h / 2)
    for (let i = 0; i < 3; i++) view = Z.zoomAt(view, V.stepZoom(view.zoom, 1), DESK.w / 2, DESK.h / 2, DESK, deskFit)
    const after = screenOf(view, deskFit, c)
    ok('§1 + three times: the point at the visible centre stays at the centre', Math.hypot(after.x - DESK.w / 2, after.y - DESK.h / 2) < 1e-6)
  }
  // The wheel scales by its delta.
  {
    const notch = Z.wheelZoomFactor(-100, 0, false)
    ok(`§1 a wheel notch up zooms in about 1.2x (${notch.toFixed(3)})`, notch > 1.12 && notch < 1.3)
    ok('§1 a wheel notch down zooms out by the same factor', near(Z.wheelZoomFactor(100, 0, false), 1 / notch, 1e-9))
    ok('§1 the wheel scales with its delta: two half-notches make one notch', near(Z.wheelZoomFactor(-50, 0, false) ** 2, notch, 1e-9))
    ok('§1 line-mode deltas (Firefox) zoom like pixel ones', Z.wheelZoomFactor(-3, 1, false) > 1.12 && Z.wheelZoomFactor(-3, 1, false) < 1.35)
    ok('§1 one event never zooms more than a notch and a half', Z.wheelZoomFactor(-5000, 0, false) <= Math.exp(150 * 0.0018) + 1e-9 && Z.wheelZoomFactor(-1, 2, false) < 1.35)
    const p1 = Z.wheelZoomFactor(-2, 0, true)
    const p2 = Z.wheelZoomFactor(-4, 0, true)
    ok(`§1 trackpad pinch (ctrlKey): small deltas scale smoothly and in proportion (${p1.toFixed(4)}, ${p2.toFixed(4)})`, p1 > 1 && p1 < 1.05 && near(p1 * p1, p2, 1e-9))
    ok('§1 ctrl + a mouse wheel notch is still about one step, not a leap', Z.wheelZoomFactor(-100, 0, true) < 1.35)
    ok('§1 no delta, no zoom', Z.wheelZoomFactor(0, 0, false) === 1 && Z.wheelZoomFactor(NaN, 0, false) === 1)
  }
  // Pinch.
  {
    // 200 %: the page is wider and taller than the stage, so it pans both ways.
    const start = Z.zoomAt(fit0, 2, 450, 350, DESK, deskFit)
    const from = { dist: 100, x: 400, y: 300 }
    const pt = pagePoint(start, deskFit, from.x, from.y)
    const spread = Z.pinchStep(start, from, { dist: 150, x: 400, y: 300 }, DESK, deskFit)
    ok('§1 pinch: fingers 1.5x further apart zoom 1.5x', near(spread.zoom, 3, 1e-9))
    const at = screenOf(spread, deskFit, pt)
    ok('§1 pinch: the point between the fingers stays between them', Math.hypot(at.x - 400, at.y - 300) < 1e-6)
    const moved = Z.pinchStep(start, from, { dist: 100, x: 380, y: 290 }, DESK, deskFit)
    const at2 = screenOf(moved, deskFit, pt)
    ok('§1 pinch: moving both fingers pans with them', near(moved.zoom, 2) && Math.hypot(at2.x - 380, at2.y - 290) < 1e-6)
    ok('§1 pinch: a zero spread changes nothing', Z.pinchStep(start, { dist: 0, x: 1, y: 1 }, { dist: 0, x: 1, y: 1 }, DESK, deskFit).zoom === start.zoom)
  }
  // Pan bounds.
  {
    ok('§1 at fit nothing pans (same view back)', Z.panBy(fit0, 40, 40, DESK, deskFit) === fit0)
    const z3 = Z.zoomAt(fit0, 3, 450, 350, DESK, deskFit)
    const w = deskFit.w * 3
    const h = deskFit.h * 3
    const farRight = Z.panBy(z3, 99999, 99999, DESK, deskFit)
    ok('§1 dragging right/down stops with the page\'s left/top edge at the gap', near(farRight.x, 8) && near(farRight.y, 8))
    const farLeft = Z.panBy(z3, -99999, -99999, DESK, deskFit)
    ok('§1 dragging left/up stops with the page\'s right/bottom edge at the gap', near(farLeft.x, 900 - w - 8) && near(farLeft.y, 700 - h - 8))
    const mid = Z.panBy(z3, -30, 25, DESK, deskFit)
    ok('§1 a drag inside the bounds moves the page by exactly the drag', near(mid.x, z3.x - 30) && near(mid.y, z3.y + 25))
    const [lo, hi] = Z.axisRange(900, deskFit.w * 1.2, 8)
    ok('§1 along an axis where the page fits, it rests centred', lo === hi && near(lo, (900 - deskFit.w * 1.2) / 2))
    // A page left off its bounds by a zoom about its edge: a drag may bring it
    // back but never push it further out, and nothing snaps.
    const off = { zoom: 2, x: 120, y: 8 }
    ok('§1 a page left with a gap: a drag that would widen the gap is held', Z.panBy(off, 30, 0, DESK, deskFit).x === 120)
    ok('§1 a page left with a gap: a drag that closes it moves it', near(Z.panBy(off, -30, 0, DESK, deskFit).x, 90))
    ok('§1 a page left with a gap: a drag along the other axis does not snap it', Z.panBy(off, 0, -10, DESK, deskFit).x === 120)
    const clamped = Z.clampView({ zoom: 3, x: 500, y: -99999 }, DESK, deskFit)
    ok('§1 clampView puts a view back inside its bounds', near(clamped.x, 8) && near(clamped.y, 700 - h - 8))
  }
  // The sharp render's canvas size.
  {
    const cssW = 356 * 4
    const cssH = cssW * LETTER
    const d = Z.renderDensity(cssW, cssH, 3)
    ok(`§1 400 % on a DPR-3 phone: the canvas stays under the iOS limit (${Math.round(cssW * d)} x ${Math.round(cssH * d)})`, (cssW * d) * (cssH * d) <= Z.MAX_CANVAS_PIXELS && d > 1.5)
    ok('§1 a small page renders at the full screen density', Z.renderDensity(540, 700, 2) === 2)
    ok('§1 no size: the screen density', Z.renderDensity(0, 0, 2) === 2 && Z.renderDensity(10, 10, 0) === 1)
  }
  // Resize and page change.
  {
    // 300 %, panned a little: inside its bounds on both stages.
    const z2 = Z.panBy(Z.zoomAt(fit0, 3, 450, 350, DESK, deskFit), 60, -40, DESK, deskFit)
    const centre = pagePoint(z2, deskFit, DESK.w / 2, DESK.h / 2)
    const FULL = { w: 1440, h: 860, gap: 8 }
    const fullFit = Z.fitSize(FULL, LETTER)
    const kept = Z.keepCentre(z2, DESK, deskFit, FULL, fullFit)
    const at = screenOf(kept, fullFit, centre)
    ok('§1 a resize (full screen) keeps the zoom and the page point at the centre', kept.zoom === 3 && Math.hypot(at.x - FULL.w / 2, at.y - FULL.h / 2) < 1e-6)
    const fitKept = Z.keepCentre(fit0, DESK, deskFit, FULL, fullFit)
    ok('§1 a resize at fit stays at the centred fit', fitKept.zoom === 1 && near(fitKept.x, (FULL.w - fullFit.w) / 2))
    const top = Z.pageTopView(3, z2.x, DESK, deskFit)
    ok('§1 a new page opens at its top, same zoom, same column', top.zoom === 3 && near(top.y, 8) && near(top.x, z2.x))
    ok('§1 a new page at fit opens at the centred fit', (() => { const t = Z.pageTopView(1, 0, DESK, deskFit); return t.zoom === 1 && near(t.x, fit0.x) && near(t.y, fit0.y) })())
  }
}

// Canvas caps: the iOS-safe one on iOS, iPadOS and touch-first devices, a
// higher one on desktop browsers, and no side past what Safari draws.
{
  const has = !!Z && typeof Z.canvasPixelCap === 'function' && Z.DESKTOP_CANVAS_PIXELS > Z.MAX_CANVAS_PIXELS && Z.MAX_CANVAS_SIDE > 0
  ok('§1 rateConZoom.js has canvasPixelCap(), DESKTOP_CANVAS_PIXELS and MAX_CANVAS_SIDE', has)
  if (has) {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
    const IOS = Z.MAX_CANVAS_PIXELS
    const DESK = Z.DESKTOP_CANVAS_PIXELS
    ok('§1 cap: iPhone gets the iOS-safe cap', Z.canvasPixelCap({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, coarsePointer: true }) === IOS)
    ok('§1 cap: an iPad in desktop mode (Mac user agent, touch points) gets the iOS-safe cap', Z.canvasPixelCap({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5, coarsePointer: false }) === IOS)
    ok('§1 cap: a touch-first Android phone gets the iOS-safe cap', Z.canvasPixelCap({ userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5, coarsePointer: true }) === IOS)
    ok('§1 cap: Mac Safari gets the desktop cap', Z.canvasPixelCap({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0, coarsePointer: false }) === DESK)
    ok('§1 cap: Windows Chrome with a touch screen but a mouse first gets the desktop cap', Z.canvasPixelCap({ userAgent: WIN_CHROME, platform: 'Win32', maxTouchPoints: 10, coarsePointer: false }) === DESK)
    ok('§1 cap: nothing known gets the iOS-safe cap', Z.canvasPixelCap({}) === IOS && Z.canvasPixelCap() === IOS)
    ok(`§1 cap: the desktop cap stays well inside desktop limits (${DESK} px, side ${Z.MAX_CANVAS_SIDE})`, DESK >= 30e6 && DESK <= 40e6 && Z.MAX_CANVAS_SIDE <= 16384)
    const dW = 528 * 4
    const dH = dW * (11 / 8.5)
    ok('§1 desktop, 400 % at DPR 2: drawn at the full density under the desktop cap', Z.renderDensity(dW, dH, 2, DESK) === 2 && (dW * 2) * (dH * 2) <= DESK)
    ok('§1 the same page under the iOS-safe cap gives way', Z.renderDensity(dW, dH, 2, IOS) < 2)
    ok('§1 renderDensity defaults to the iOS-safe cap', Z.renderDensity(dW, dH, 2) === Z.renderDensity(dW, dH, 2, IOS))
    const tall = Z.renderDensity(1000, 12000, 2, DESK)
    ok(`§1 a very tall page: no canvas side past MAX_CANVAS_SIDE (${Math.round(12000 * tall)})`, 12000 * tall <= Z.MAX_CANVAS_SIDE && (1000 * tall) * (12000 * tall) <= DESK)
  }
}

// ══ §2 the component, mounted ═══════════════════════════════════════════════
const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

// Compile the SFC's <script setup> + <template>. Static imports come from
// `deps` (or ROOT for a relative .js); `import(` is routed to `dyn`, so the
// lazily loaded pdf.js entry is the fake below.
async function compileComponent(rel, dyn) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  body = body.split('import(').join('__dyn(')
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', '__dyn', body)(deps, dyn)
}

// A canvas that records every resize or clear, and whether it was on screen
// (attached to the page box) when it happened.
function fakeCanvas(log) {
  const c = {
    tag: 'canvas', parentNode: null, style: {}, attrs: {}, ops: [], _w: 300, _h: 150,
    setAttribute(k, v) { this.attrs[k] = v },
    getContext() { return { clearRect: () => { c.ops.push({ op: 'clear', attached: !!c.parentNode }); log.push({ op: 'clear', canvas: c, attached: !!c.parentNode }) } } },
  }
  for (const k of ['width', 'height']) {
    Object.defineProperty(c, k, {
      get() { return k === 'width' ? c._w : c._h },
      set(v) { if (k === 'width') c._w = v; else c._h = v; c.ops.push({ op: k, v, attached: !!c.parentNode }); log.push({ op: k, canvas: c, attached: !!c.parentNode }) },
    })
  }
  return c
}

// The in-memory renderer: elements carry a size, listeners and child lists.
function mountInMemory(Comp, props, size) {
  const node = (type, tag) => {
    const n = {
      type, tag, children: [], parent: null, props: {}, text: '', listeners: [], style: {}, scrollTop: 0,
      get clientWidth() { return size.w },
      get clientHeight() { return size.h },
      get parentElement() { return n.parent && n.parent.type === 'el' ? n.parent : null },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: size.w, height: size.h, right: size.w, bottom: size.h }),
      addEventListener(t, fn, opts) { n.listeners.push({ type: t, fn, opts }) },
      removeEventListener(t, fn) { const i = n.listeners.findIndex((l) => l.type === t && l.fn === fn); if (i >= 0) n.listeners.splice(i, 1) },
      appendChild(child) { if (child.parentNode && child.parentNode !== n) child.parentNode.removeChild(child); n.children.push(child); child.parentNode = n; return child },
      removeChild(child) { const i = n.children.indexOf(child); if (i >= 0) n.children.splice(i, 1); child.parentNode = null; return child },
      contains(other) { let p = other; while (p) { if (p === n) return true; p = p.parent || p.parentNode } return false },
      setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false }, focus() {},
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
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  const app = createApp(Comp, props)
  app.mount(root)
  const find = (n, pred) => (pred(n) ? n : n.children && n.children.reduce((hit, c) => hit || (c.type ? find(c, pred) : null), null))
  return { root, find: (pred) => find(root, pred), unmount: () => app.unmount() }
}

const VIEWER_REL = 'client/src/components/shared/RateConViewer.vue'
const VIEWER = read(...VIEWER_REL.split('/'))
const templateOf = (sfc) => { const m = /<template>([\s\S]*)<\/template>\s*<script/.exec(sfc); return m ? m[1] : '' }
const cls = (n) => String((n && n.props && n.props.class) || '')
const hasClass = (n, c) => {
  const v = n && n.props && n.props.class
  if (!v) return false
  if (typeof v === 'string') return v.split(/\s+/).includes(c)
  if (Array.isArray(v)) return v.some((x) => (typeof x === 'string' ? x.split(/\s+/).includes(c) : !!(x && x[c])))
  return !!v[c]
}
const styleOf = (n) => {
  const s = n && n.props && n.props.style
  return s && typeof s === 'object' ? s : {}
}
// translate(Xpx, Ypx) scale(S) + width -> where the page is and how big.
function placed(pageNode) {
  const st = styleOf(pageNode)
  const m = /translate(?:3d)?\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px[^)]*\)\s*scale\(\s*([\d.e+-]+)\s*\)/.exec(String(st.transform || ''))
  const w = parseFloat(String(st.width || ''))
  const h = parseFloat(String(st.height || ''))
  if (!m || !(w > 0) || !(h > 0)) return null
  const s = parseFloat(m[3])
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), w: w * s, h: h * s }
}

if (VIEWER) {
  const winListeners = []
  const docListeners = []
  const log = []
  const renders = []
  const sources = []
  const PAGE_W = 612
  const PAGE_H = 792
  const fakePage = (n) => ({
    pageNumber: n,
    getViewport: ({ scale }) => ({ width: PAGE_W * scale, height: PAGE_H * scale, scale }),
    render: ({ canvas, viewport }) => {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      const task = { promise, cancelled: false, cancel() { task.cancelled = true; const e = new Error('Rendering cancelled'); e.name = 'RenderingCancelledException'; reject(e) } }
      promise.catch(() => {})
      renders.push({ canvas, viewport, page: n, resolve, reject, task })
      return task
    },
    cleanup() {},
  })
  const fakeDoc = { numPages: 3, getPage: async (n) => fakePage(n), destroy() {} }
  const fakeEntry = {
    GlobalWorkerOptions: {},
    usePdfDocument: ({ source }) => { sources.push(Vue.toValue(source)); return { doc: Vue.shallowRef(fakeDoc) } },
    useVuePdfEmbed: ({ source }) => { sources.push(Vue.toValue(source)); return { doc: Vue.shallowRef(fakeDoc) } },
    default: Vue.defineComponent({ name: 'VuePdfEmbed', setup: () => () => null }),
  }
  const dyn = async (spec) => {
    if (spec === 'vue-pdf-embed/dist/index.essential.mjs') return fakeEntry
    if (/pdf\.worker/.test(spec)) return { default: '/assets/pdf.worker.min.mjs' }
    throw new Error(`unexpected import(${spec})`)
  }
  // A resize is played by changing SIZE and calling fireResize().
  const resizeCallbacks = []
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb }
    observe() { resizeCallbacks.push(this.cb) }
    disconnect() { const i = resizeCallbacks.indexOf(this.cb); if (i >= 0) resizeCallbacks.splice(i, 1) }
  }
  const fireResize = () => resizeCallbacks.slice().forEach((cb) => cb())
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.window = {
    devicePixelRatio: 1,
    ResizeObserver: FakeResizeObserver,
    addEventListener: (type, fn, opts) => winListeners.push({ type, fn, opts }),
    removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1) },
  }
  globalThis.document = {
    fullscreenEnabled: false, fullscreenElement: null, body: {},
    addEventListener: (type, fn, opts) => docListeners.push({ type, fn, opts }),
    removeEventListener: (type, fn) => { const i = docListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) docListeners.splice(i, 1) },
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas(log) : { tag, style: {}, setAttribute() {} }),
  }
  // The mount root plays the dialog body: the scroll area the tile sits in.
  globalThis.getComputedStyle = (el) => ({ overflowY: el && el.tag === 'root' ? 'auto' : 'visible', paddingTop: '0px', paddingBottom: '0px' })
  const SIZE = { w: 900, h: 700 }
  const resolveLive = () => renders.filter((x) => !x.task.cancelled && !x.done).forEach((x) => { x.done = true; x.resolve() })
  try {
    const Viewer = await compileComponent(VIEWER_REL, dyn)
    const m = mountInMemory(Viewer, { src: 'blob:test' }, SIZE)
    await drain()
    const stage = m.find((n) => n.type === 'el' && hasClass(n, 'rcv-stage'))
    const toolbar = m.find((n) => n.type === 'el' && hasClass(n, 'rcv-toolbar'))
    const pageBox = m.find((n) => n.type === 'el' && hasClass(n, 'rcv-page'))
    const btn = (label) => m.find((n) => n.type === 'el' && n.props['aria-label'] === label)
    ok('§2 mounted: the PDF area, the toolbar and the page box are found', !!stage && !!toolbar && !!pageBox)

    // Wheel: non-passive, on the PDF area only.
    const wheel = stage ? stage.listeners.find((l) => l.type === 'wheel') : null
    ok('§2 a wheel listener sits on the PDF area', !!wheel)
    ok('§2 ...and it is not passive (it may cancel the page scroll)', !!wheel && !!wheel.opts && wheel.opts.passive === false)
    ok('§2 no wheel listener on window or document (outside the PDF the page scrolls as usual)', !winListeners.some((l) => l.type === 'wheel') && !docListeners.some((l) => l.type === 'wheel'))
    ok('§2 no wheel listener on the toolbar', !!toolbar && !toolbar.listeners.some((l) => l.type === 'wheel') && !toolbar.props.onWheel)

    // First render: one canvas in the page box.
    ok(`§2 the first page is drawn once the document is in (${renders.length} render)`, renders.length === 1 && renders[0].page === 1)
    if (renders.length) renders[0].resolve()
    await drain()
    const first = renders[0] && renders[0].canvas
    const canvasesIn = (n) => (n ? n.children.filter((c) => c && c.tag === 'canvas') : [])
    ok('§2 the drawn canvas is in the page box', !!first && canvasesIn(pageBox).length === 1 && canvasesIn(pageBox)[0] === first)
    ok('§2 the canvas was sized before it went on screen', !!first && first.ops.length > 0 && first.ops.every((o) => !o.attached))

    // Limits: at fit, - is disabled and + is not.
    ok('§2 at fit: Zoom out is disabled', !!btn('Zoom out') && btn('Zoom out').props.disabled === true)
    ok('§2 at fit: Zoom in is enabled', !!btn('Zoom in') && !btn('Zoom in').props.disabled)

    // A drag at fit does nothing; the stage is not pannable.
    const before0 = pageBox ? placed(pageBox) : null
    ok('§2 the page box is placed with translate() scale() and a size', !!before0)
    const pdown = stage && (stage.props.onPointerdown || (stage.listeners.find((l) => l.type === 'pointerdown') || {}).fn)
    const pmove = stage && (stage.props.onPointermove || (stage.listeners.find((l) => l.type === 'pointermove') || {}).fn)
    const pup = stage && (stage.props.onPointerup || (stage.listeners.find((l) => l.type === 'pointerup') || {}).fn)
    ok('§2 drag handlers sit on the PDF area', !!pdown && !!pmove && !!pup)
    ok('§2 the toolbar starts no drag (no pointer handlers on it)', !!toolbar && !toolbar.props.onPointerdown && !toolbar.listeners.some((l) => l.type === 'pointerdown'))
    const pev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, target: stage, preventDefault() {}, stopPropagation() {} })
    if (pdown && pmove && pup && before0) {
      pdown(pev(400, 300)); pmove(pev(340, 260)); pup(pev(340, 260))
      await drain()
      const after0 = placed(pageBox)
      ok('§2 at fit a drag moves nothing', !!after0 && near(after0.x, before0.x) && near(after0.y, before0.y))
      ok('§2 at fit the PDF area is not pannable (no grab cursor, page swipes scroll)', !hasClass(stage, 'rcv-pannable'))
    }

    // Wheel zoom about the pointer.
    if (wheel && before0) {
      const px = 380
      const py = 250
      const u = (px - before0.x) / before0.w
      const v = (py - before0.y) / before0.h
      const evs = []
      for (let i = 0; i < 5; i++) {
        const ev = { deltaY: -100, deltaX: 0, deltaMode: 0, ctrlKey: false, clientX: px, clientY: py, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        wheel.fn(ev)
        evs.push(ev)
      }
      await drain()
      const after = placed(pageBox)
      ok('§2 every wheel event over the PDF prevents the page scroll', evs.every((e) => e.defaultPrevented))
      ok(`§2 five notches zoom in (${after ? (after.w / before0.w).toFixed(2) : '?'}x)`, !!after && after.w / before0.w > 2)
      const sx = after ? after.x + u * after.w : NaN
      const sy = after ? after.y + v * after.h : NaN
      ok(`§2 the PDF point under the pointer stays put (moved ${Math.hypot(sx - px, sy - py).toFixed(3)} px)`, Math.hypot(sx - px, sy - py) < 1)
      ok('§2 zoomed in: Zoom out is enabled', !btn('Zoom out').props.disabled)
      ok('§2 zoomed in: the PDF area is pannable (grab cursor, touch handled here)', hasClass(stage, 'rcv-pannable'))
      // The zoom shows at once as a transform of the canvas already there.
      ok('§2 the zoom shows at once on the canvas already there (no new render yet)', renders.length === 1 && canvasesIn(pageBox)[0] === first)

      // After the pause: a sharp render into a NEW detached canvas.
      await sleep(320)
      await drain()
      ok(`§2 after a short pause one sharp render starts (${renders.length - 1})`, renders.length === 2)
      const second = renders[1] && renders[1].canvas
      ok('§2 the sharp render draws into a new canvas, not the one on screen', !!second && second !== first)
      ok('§2 while it draws, the old canvas stays on screen untouched', canvasesIn(pageBox).length === 1 && canvasesIn(pageBox)[0] === first)
      if (renders[1]) renders[1].resolve()
      await drain()
      ok('§2 then the new canvas replaces the old one (one canvas, the new one)', canvasesIn(pageBox).length === 1 && canvasesIn(pageBox)[0] === second)
      ok('§2 no canvas was ever resized or cleared while on screen (no blank frame)', log.length > 0 && log.every((e) => !e.attached))
      const settled = placed(pageBox)
      const sx2 = settled ? settled.x + u * settled.w : NaN
      const sy2 = settled ? settled.y + v * settled.h : NaN
      ok(`§2 the swap does not move the page (point moved ${Math.hypot(sx2 - px, sy2 - py).toFixed(3)} px)`, Math.hypot(sx2 - px, sy2 - py) < 1)

      // Drag pans when zoomed.
      if (pdown && pmove && pup && settled) {
        pdown(pev(400, 300)); pmove(pev(370, 280))
        await drain()
        ok('§2 while dragging the PDF area says so (grabbing cursor)', hasClass(stage, 'rcv-dragging'))
        pup(pev(370, 280))
        await drain()
        const dragged = placed(pageBox)
        ok('§2 zoomed in, a drag moves the page with the pointer', !!dragged && near(dragged.x, settled.x - 30, 0.01) && near(dragged.y, settled.y - 20, 0.01))
        ok('§2 the drag ends cleanly', !hasClass(stage, 'rcv-dragging'))
      }

      // + to the top: Zoom in disabled at 400 %.
      for (let i = 0; i < 20 && !btn('Zoom in').props.disabled; i++) { btn('Zoom in').props.onClick(); await drain() }
      ok('§2 at 400 %: Zoom in is disabled', btn('Zoom in').props.disabled === true)
      const top = placed(pageBox)
      const fitW = before0.w
      ok(`§2 ...and that is 400 % of fit (${top ? (top.w / fitW).toFixed(2) : '?'}x)`, !!top && near(top.w / fitW, 4, 0.01))
      // - to the bottom: Zoom out disabled at fit, page back where it started.
      for (let i = 0; i < 20 && !btn('Zoom out').props.disabled; i++) { btn('Zoom out').props.onClick(); await drain() }
      const back = placed(pageBox)
      ok('§2 back at fit: Zoom out is disabled again', btn('Zoom out').props.disabled === true)
      ok('§2 back at fit: the page is centred where it started', !!back && near(back.x, before0.x, 0.5) && near(back.y, before0.y, 0.5) && near(back.w, before0.w, 0.5))

      // Fit to page from a zoom.
      wheel.fn({ deltaY: -200, deltaMode: 0, ctrlKey: false, clientX: 300, clientY: 200, preventDefault() {} })
      await drain()
      btn('Fit to page').props.onClick()
      await drain()
      const fitted = placed(pageBox)
      ok('§2 Fit to page returns to the centred whole page', !!fitted && near(fitted.x, before0.x, 0.5) && near(fitted.w, before0.w, 0.5) && btn('Fit to page').props['aria-pressed'] === 'true')
    }

    // Page change keeps the zoom and opens the new page at its top.
    {
      wheel.fn({ deltaY: -300, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
      await drain()
      const z = placed(pageBox)
      const n0 = renders.length
      btn('Next page').props.onClick()
      await drain()
      const r = renders[renders.length - 1]
      ok('§2 Next page draws page 2', renders.length > n0 && r && r.page === 2)
      ok('§2 ...while page 1 stays on screen until page 2 is drawn', canvasesIn(pageBox).length === 1 && canvasesIn(pageBox)[0] !== (r && r.canvas))
      if (r) r.resolve()
      await drain()
      const p2 = placed(pageBox)
      ok('§2 page 2 opens at the same zoom', !!p2 && !!z && near(p2.w, z.w, 0.5))
      ok('§2 ...at its top', !!p2 && near(p2.y, 8, 0.5))
      const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
      ok('§2 "Page 2 of 3"', textOf(m.root).replace(/\s+/g, ' ').includes('Page 2 of 3'))
      ok('§2 no canvas was resized or cleared on screen across the page change', log.every((e) => !e.attached))

      // Fit, drawn sharp at fit; then Next page and, while page 3 is still
      // being drawn, a zoom in and straight back to fit: page 3 still arrives.
      btn('Fit to page').props.onClick()
      await sleep(320)
      await drain()
      renders.filter((x) => !x.task.cancelled && !x.done).forEach((x) => { x.done = true; x.resolve() })
      await drain()
      btn('Next page').props.onClick()
      await drain()
      wheel.fn({ deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
      btn('Fit to page').props.onClick()
      await sleep(320)
      await drain()
      const live = renders.filter((x) => !x.task.cancelled && !x.done)
      ok(`§2 a zoom back to fit during a page change does not lose the page (${live.map((x) => x.page).join(',') || 'no draw'})`, live.length === 1 && live[0].page === 3)
      if (live[0]) { live[0].done = true; live[0].resolve() }
      await drain()
      ok('§2 ...and page 3 is the one on screen', !!live[0] && canvasesIn(pageBox).length === 1 && canvasesIn(pageBox)[0] === live[0].canvas)
    }

    // Touch: at fit one finger is the dialog's; two fingers pinch about their
    // midpoint; the finger left after a pinch moves the zoomed page.
    {
      const tl = (type) => (stage.listeners.find((l) => l.type === type) || { fn() {} }).fn
      const tev = (pts) => ({ touches: pts.map(([x, y]) => ({ clientX: x, clientY: y })), cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })
      btn('Fit to page').props.onClick()
      await drain()
      const f0 = placed(pageBox)
      tl('touchstart')(tev([[400, 300]]))
      const swipe = tev([[400, 250]])
      tl('touchmove')(swipe)
      tl('touchend')(tev([]))
      await drain()
      ok('§2 touch at fit: one finger is left to scroll the dialog (not prevented, page still)', !swipe.defaultPrevented && near(placed(pageBox).y, f0.y))
      const u = (400 - f0.x) / f0.w
      const v = (300 - f0.y) / f0.h
      tl('touchstart')(tev([[350, 300], [450, 300]]))
      const spread = tev([[300, 300], [500, 300]])
      tl('touchmove')(spread)
      await drain()
      const p1 = placed(pageBox)
      ok(`§2 pinch: fingers twice as far apart zoom 2x (${(p1.w / f0.w).toFixed(2)}x)`, spread.defaultPrevented && near(p1.w / f0.w, 2, 0.01))
      ok('§2 pinch: the point between the fingers stays between them', Math.hypot(p1.x + u * p1.w - 400, p1.y + v * p1.h - 300) < 1)
      tl('touchend')(tev([[500, 300]]))
      const one = tev([[470, 280]])
      tl('touchmove')(one)
      await drain()
      const p2 = placed(pageBox)
      ok('§2 one finger left after a pinch moves the zoomed page with it', one.defaultPrevented && near(p2.x, p1.x - 30, 0.01) && near(p2.y, p1.y - 20, 0.01))
      tl('touchend')(tev([]))
      ok('§2 zoomed, the page area takes touches (pannable: touch-action none)', hasClass(stage, 'rcv-pannable'))
    }

    // Keyboard on the focused page area.
    {
      const key = (k, extra = {}) => {
        const e = { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
        stage.props.onKeydown(e)
        return e
      }
      btn('Fit to page').props.onClick()
      await drain()
      const atFit = placed(pageBox)
      const down0 = key('ArrowDown')
      await drain()
      ok('§2 keyboard at fit: the arrows are left to scroll the dialog', !down0.defaultPrevented && near(placed(pageBox).y, atFit.y))
      const plus = key('+')
      await drain()
      ok('§2 keyboard: + zooms in one step', plus.defaultPrevented && near(placed(pageBox).w / atFit.w, 1.25, 0.01))
      key('+')
      key('+')
      await drain()
      const z2 = placed(pageBox)
      const down = key('ArrowDown')
      await drain()
      ok('§2 keyboard zoomed: ArrowDown shows what is below (page up 48 px)', down.defaultPrevented && near(placed(pageBox).y, z2.y - 48, 0.01))
      const upFast = key('ArrowUp', { shiftKey: true })
      await drain()
      ok('§2 keyboard zoomed: Shift+ArrowUp moves three steps (144 px)', upFast.defaultPrevented && near(placed(pageBox).y, z2.y - 48 + 144, 0.01))
      const right = key('ArrowRight')
      await drain()
      ok('§2 keyboard zoomed: ArrowRight shows what is to the right (page left 48 px)', right.defaultPrevented && near(placed(pageBox).x, z2.x - 48, 0.01))
      const zero = key('0')
      await drain()
      ok('§2 keyboard: 0 is fit', zero.defaultPrevented && near(placed(pageBox).w, atFit.w, 0.5))
      ok('§2 keyboard: other keys and browser shortcuts are left alone', !key('a').defaultPrevented && !key('+', { ctrlKey: true }).defaultPrevented)
    }

    // A resize schedules a sharp draw for the new size; zooming back to the
    // drawn zoom within the pause must not drop it.
    {
      SIZE.w = 1000
      SIZE.h = 760
      fireResize()
      wheel.fn({ deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
      btn('Fit to page').props.onClick()
      await sleep(320)
      await drain()
      const live = renders.filter((x) => !x.task.cancelled && !x.done)
      const newFitW = Math.floor((760 - 16) / (PAGE_H / PAGE_W))
      ok(`§2 after a resize, zooming back to the drawn zoom still draws the page for the new size (${live.map((x) => Math.round(x.viewport.width)).join(',') || 'no draw'} vs ${newFitW})`, live.length === 1 && near(live[0].viewport.width, newFitW, 1))
      resolveLive()
      await drain()
    }

    // Full screen (the CSS fallback here): leaving it untouched brings back the
    // exact view and the dialog's scroll; zoomed in full screen, it keeps that.
    {
      SIZE.w = 900
      SIZE.h = 700
      fireResize()
      await sleep(320)
      await drain()
      resolveLive()
      await drain()
      wheel.fn({ deltaY: -300, deltaMode: 0, ctrlKey: false, clientX: 400, clientY: 300, preventDefault() {} })
      await sleep(320)
      await drain()
      resolveLive()
      await drain()
      const before = placed(pageBox)
      m.root.scrollTop = 20
      btn('Full screen').props.onClick()
      await drain()
      m.root.scrollTop = 0
      SIZE.w = 1400
      SIZE.h = 900
      fireResize()
      await drain()
      const inFull = placed(pageBox)
      ok('§2 full screen: the page follows the bigger stage at the same zoom', !!inFull && inFull.w > before.w + 50)
      SIZE.w = 900
      SIZE.h = 700
      btn('Exit full screen').props.onClick()
      await drain()
      const after = placed(pageBox)
      ok('§2 leaving full screen untouched: the exact view comes back', !!after && near(after.x, before.x, 0.01) && near(after.y, before.y, 0.01) && near(after.w, before.w, 0.01))
      ok(`§2 ...and the dialog's own scroll comes back (${m.root.scrollTop})`, m.root.scrollTop === 20)
      btn('Full screen').props.onClick()
      await drain()
      SIZE.w = 1400
      SIZE.h = 900
      fireResize()
      await drain()
      wheel.fn({ deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 700, clientY: 450, preventDefault() {} })
      await drain()
      SIZE.w = 900
      SIZE.h = 700
      btn('Exit full screen').props.onClick()
      await drain()
      const kept = placed(pageBox)
      ok('§2 zoomed in full screen: leaving keeps that zoom, not the old view', !!kept && kept.w > before.w * 1.1)
      await sleep(320)
      await drain()
      resolveLive()
      await drain()
    }

    m.unmount()
    ok('§2 unmount removes the wheel listener', !stage.listeners.some((l) => l.type === 'wheel'))
    ok('§2 pdf.js was handed only { url }', sources.length >= 1 && sources.every((s) => s && Object.keys(s).length === 1 && s.url === 'blob:test'))

    // A second viewer: keys before the first page is shown, then unmount in
    // the middle of a draw.
    {
      const m2 = mountInMemory(Viewer, { src: 'blob:test' }, SIZE)
      await drain()
      const stage2 = m2.find((n) => n.type === 'el' && hasClass(n, 'rcv-stage'))
      const first2 = renders[renders.length - 1]
      const early = { key: '+', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      stage2.props.onKeydown(early)
      await drain()
      ok('§2 before the first page is shown, keys do nothing (its first draw goes on)', !early.defaultPrevented && !!first2 && !first2.task.cancelled && renders[renders.length - 1] === first2)
      first2.done = true
      first2.resolve()
      await drain()
      const wheel2 = stage2.listeners.find((l) => l.type === 'wheel')
      wheel2.fn({ deltaY: -200, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
      await sleep(320)
      await drain()
      const pending = renders[renders.length - 1]
      ok('§2 a sharp draw is under way', pending !== first2 && !pending.done && !pending.task.cancelled)
      m2.unmount()
      await drain()
      ok('§2 unmount in the middle of a draw cancels it', pending.task.cancelled)
      ok('§2 ...frees its off-screen canvas', pending.canvas.width === 0 && pending.canvas.height === 0)
      ok('§2 ...and frees the page that was on screen only once it is off screen', first2.canvas.width === 0 && log.every((e) => !e.attached))
      ok('§2 ...and removes every listener it added (page area, window, document)', stage2.listeners.length === 0 && winListeners.length === 0 && docListeners.length === 0)
    }

    // The canvas cap where it is used: 400 % on a DPR-3 touch phone stays under
    // the iOS limit; 400 % on a DPR-2 desktop browser is drawn at full density.
    const atMaxZoom = async (device) => {
      window.devicePixelRatio = device.dpr
      window.navigator = { userAgent: device.userAgent, platform: device.platform, maxTouchPoints: device.maxTouchPoints }
      window.matchMedia = (q) => ({ media: q, matches: q === '(pointer: coarse)' ? device.coarse : false })
      try {
        const mm = mountInMemory(Viewer, { src: 'blob:test' }, device.size)
        await drain()
        resolveLive()
        await drain()
        const box = mm.find((n) => n.type === 'el' && hasClass(n, 'rcv-page'))
        const zin = () => mm.find((n) => n.type === 'el' && n.props['aria-label'] === 'Zoom in')
        const fitW = placed(box).w
        for (let i = 0; i < 12 && !zin().props.disabled; i++) { zin().props.onClick(); await drain() }
        await sleep(320)
        await drain()
        const r = renders.filter((x) => !x.task.cancelled && !x.done).pop()
        const canvas = r ? { w: r.canvas.width, h: r.canvas.height } : null
        resolveLive()
        await drain()
        const css = placed(box)
        mm.unmount()
        await drain()
        return { canvas, zoom: css ? css.w / fitW : 0, density: canvas && css ? canvas.w / css.w : 0 }
      } finally {
        window.devicePixelRatio = 1
        delete window.navigator
        delete window.matchMedia
      }
    }
    {
      const phone = await atMaxZoom({ dpr: 3, size: { w: 348, h: 414 }, coarse: true, maxTouchPoints: 5, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })
      const px = phone.canvas ? phone.canvas.w * phone.canvas.h : Infinity
      ok(`§2 phone (DPR 3, touch): 400 % is reached (${phone.zoom.toFixed(2)}x)`, near(phone.zoom, 4, 0.01))
      ok(`§2 phone (DPR 3, touch): the 400 % canvas stays under the iOS limit (${phone.canvas && `${phone.canvas.w} x ${phone.canvas.h}`} = ${px} <= ${Z && Z.MAX_CANVAS_PIXELS})`, !!Z && px <= Z.MAX_CANVAS_PIXELS)
      ok(`§2 phone (DPR 3, touch): ...and is still drawn well above 2x (${phone.density.toFixed(2)})`, phone.density > 2)
      const desk = await atMaxZoom({ dpr: 2, size: { w: 900, h: 700 }, coarse: false, maxTouchPoints: 0, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })
      const dpx = desk.canvas ? desk.canvas.w * desk.canvas.h : Infinity
      ok(`§2 desktop (DPR 2): 400 % is drawn at the full screen density (${desk.density.toFixed(2)})`, near(desk.zoom, 4, 0.01) && near(desk.density, 2, 0.01))
      ok(`§2 desktop (DPR 2): ...within the desktop cap (${dpx})`, !!Z && dpx <= (Z.DESKTOP_CANVAS_PIXELS || 0))
    }

    // A failed sharp re-draw keeps the good page; a failed first draw says so.
    {
      const warnings = []
      const origWarn = console.warn
      console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
      try {
        const m3 = mountInMemory(Viewer, { src: 'blob:test' }, SIZE)
        await drain()
        resolveLive()
        await drain()
        const box3 = m3.find((n) => n.type === 'el' && hasClass(n, 'rcv-page'))
        const stage3 = m3.find((n) => n.type === 'el' && hasClass(n, 'rcv-stage'))
        const good = canvasesIn(box3)[0]
        const wheel3 = stage3.listeners.find((l) => l.type === 'wheel')
        wheel3.fn({ deltaY: -200, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
        await sleep(320)
        await drain()
        const bad = renders.filter((x) => !x.task.cancelled && !x.done).pop()
        if (bad) { bad.done = true; bad.reject(new Error('render failed (test)')) }
        await drain()
        ok('§2 a failed sharp re-draw keeps the page on screen, no failure message', !!bad && !m3.find((n) => n.type === 'el' && hasClass(n, 'rcv-status-fail')) && canvasesIn(box3).length === 1 && canvasesIn(box3)[0] === good)
        ok('§2 ...and logs it to the console', warnings.some((w) => /rate con/i.test(w) && /render failed \(test\)/.test(w)))
        const n3 = renders.length
        wheel3.fn({ deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 450, clientY: 350, preventDefault() {} })
        await sleep(320)
        await drain()
        ok('§2 ...and the next zoom still draws sharp', renders.length === n3 + 1)
        resolveLive()
        await drain()
        m3.unmount()
        await drain()
        const m4 = mountInMemory(Viewer, { src: 'blob:test' }, SIZE)
        await drain()
        const first4 = renders.filter((x) => !x.task.cancelled && !x.done).pop()
        if (first4) { first4.done = true; first4.reject(new Error('bad page (test)')) }
        await drain()
        ok('§2 a first draw that fails still says "Couldn\'t show the rate con here."', !!first4 && !!m4.find((n) => n.type === 'el' && hasClass(n, 'rcv-status-fail')))
        m4.unmount()
        await drain()
      } finally {
        console.warn = origWarn
      }
    }
  } catch (err) {
    ok(`§2 RateConViewer mounts in this harness (${err.message})`, false)
  } finally {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.getComputedStyle
    delete globalThis.ResizeObserver
  }
} else {
  ok('§2 RateConViewer.vue exists', false)
}

// ══ §3 the source ═══════════════════════════════════════════════════════════
ok('§3 the wheel listener is added with { passive: false }', /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(VIEWER))
ok('§3 pdf.js still gets only { url }', /const pdfSource = computed\(\(\) => \(\{ url: props\.src \}\)\)/.test(VIEWER))
ok('§3 still the essential vue-pdf-embed entry with its worker', /import\('vue-pdf-embed\/dist\/index\.essential\.mjs'\)/.test(VIEWER) && /import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'\)/.test(VIEWER))
ok('§3 no request of its own (no fetch, XHR or new Worker in the viewer)', VIEWER.length > 0 && !/\bfetch\(|XMLHttpRequest|new Worker\(|sendBeacon/.test(VIEWER))
ok('§3 no text or annotation layer (nothing in the PDF is clickable)', VIEWER.length > 0 && !/textLayer|annotationLayer|text-layer|annotation-layer|AnnotationLayer|TextLayer/.test(VIEWER))
ok('§3 at fit a one-finger swipe scrolls the page (touch-action pan-x pan-y on the PDF area)', /\.rcv-stage \{[^}]*touch-action: pan-x pan-y/.test(VIEWER))
ok('§3 zoomed in, touches are the viewer\'s (touch-action: none) and the cursor is a hand', /\.rcv-pannable \{[^}]*touch-action: none/.test(VIEWER) && /\.rcv-pannable \{[^}]*cursor: grab/.test(VIEWER) && /\.rcv-dragging \{[^}]*cursor: grabbing/.test(VIEWER))
ok('§3 the PDF area never scrolls itself: the page is moved by transform inside a fixed tile', /\.rcv-stage \{[^}]*overflow: hidden/.test(VIEWER) && /transform-origin: 0 0/.test(VIEWER))
ok('§3 the pinch listener may cancel (touchmove not passive)', /addEventListener\('touchmove', onTouchMove, \{ passive: false \}\)/.test(VIEWER))
ok('§3 the template has no link out of the viewer', VIEWER.length > 0 && !/Open PDF|<a\b|:href=/.test(templateOf(VIEWER)))

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
