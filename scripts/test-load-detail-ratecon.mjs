#!/usr/bin/env node
// The dispatch load-detail modal (Active and Completed): ONE map, a small
// "Actual miles driven" line under it, and, for a Super Admin only, the load's
// rate con in a tile below.
//
//   §1 one map: each tab renders exactly one DriverRouteMap and hands it the
//      planned lane; LoadHaulSection draws no map; the rate con tile sits under
//      the map, behind auth.isSuperAdmin; a delivered Active load has no live
//      position of its own
//   §2 DriverRouteMap, rendered: with no live position and a planned lane the
//      map says "Planned route" and its chips are the lane's miles and drive
//      time; with a live position it is the live map; without the prop (every
//      other surface) and in publicMode nothing changes
//   §3 the miles line: wording, the running-load fix ("The truck hasn't reached
//      the pickup yet."), and LoadHaulSection mounted: the line and the lane
//      it emits
//   §4 RateConPdfSection, mounted: nothing (and no request) for any role but
//      Super Admin; the request; "No rate con on file" on 404, the plain
//      "can't be loaded" on 503; the viewer on 200
//   §5 RateConViewer: the controls (page X of Y, zoom in/out, fit to page, full
//      screen), starting at fit to page; the zoom maths; phone height and
//      native scrolling
//   §6 pdf.js: no eval( / new Function( in the build the app loads, enableXfa
//      never true, pdfjs-dist at or above 6.4.299, essential entry only
//   §7 the driver app, the job board and the public tracker pass none of it
//
// No DOM, no server. Vue comes from this checkout's client/node_modules; the
// components under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-load-detail-ratecon.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-load-detail-ratecon.mjs   # a base checkout: fails
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

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
// Rendered HTML to its visible text, in one forward scan with no pattern
// stripping: a "<!--" … "-->" comment is dropped, any other "<" … ">" tag
// becomes one space, and the text between them is kept as written (the
// renderer writes &lt; / &gt; for a literal bracket, which stay encoded). Then
// the two entities the server renderer emits in these components are decoded,
// &amp; last, and whitespace is collapsed.
function text(html) {
  const s = String(html)
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { out += s.slice(i); break }
    out += s.slice(i, lt)
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end === -1 ? s.length : end + 3
    } else {
      const end = s.indexOf('>', lt + 1)
      out += ' '
      i = end === -1 ? s.length : end + 1
    }
  }
  return out.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

// Compile a committed SFC's <script setup> + <template> into a component.
// Imports are resolved from `overrides` first; a .vue import becomes a stub
// that records its props; a relative .js import is loaded from ROOT.
const stubbed = []
function stub(name) {
  return Vue.defineComponent({
    name, inheritAttrs: false,
    setup(_, { attrs }) {
      return () => { stubbed.push({ name, attrs: { ...attrs } }); return Vue.h('div', { 'data-stub': name }) }
    },
  })
}
async function compileComponent(rel, overrides = {}) {
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
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: overrides.vue || Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}
async function ssr(Comp, props) {
  return text(await renderToString(Vue.createSSRApp(Comp, props)))
}

// A minimal in-memory renderer, so a component can be MOUNTED (watchers run,
// awaits resolve, the template re-renders) without a DOM.
function mountInMemory(Comp, props) {
  // markRaw: Vue never proxies a real DOM element held in a template ref, so
  // these must not be proxied either (identity checks compare them).
  const node = (type, tag) => Vue.markRaw({ type, tag, children: [], parent: null, props: {}, text: '', addEventListener() {}, removeEventListener() {} })
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
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const find = (n, pred) => (pred(n) ? n : n.children && n.children.reduce((hit, c) => hit || find(c, pred), null))
  return { root, app, text: () => textOf(root).replace(/\s+/g, ' ').trim(), find: (pred) => find(root, pred), unmount: () => app.unmount() }
}

const ACTIVE = read('client', 'src', 'components', 'dashboard', 'ActiveLoadsTab.vue')
const COMPLETED = read('client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue')
const HAUL = read('client', 'src', 'components', 'dashboard', 'LoadHaulSection.vue')
const ROUTE_MAP = read('client', 'src', 'components', 'driver', 'DriverRouteMap.vue')
const templateOf = (sfc) => { const m = /<template>([\s\S]*)<\/template>\s*<script/.exec(sfc); return m ? m[1] : '' }

// ══ §1 one map ═══════════════════════════════════════════════════════════════
for (const [name, sfc] of [['ActiveLoadsTab', ACTIVE], ['CompletedLoadsTab', COMPLETED]]) {
  const tpl = templateOf(sfc)
  const maps = tpl.match(/<DriverRouteMap\b/g) || []
  ok(`§1 ${name}: exactly one DriverRouteMap (${maps.length})`, maps.length === 1)
  ok(`§1 ${name}: the map is handed the planned lane`, /<DriverRouteMap\b[^>]*:planned-lane="plannedLane"/.test(tpl))
  const mapAt = tpl.indexOf('<DriverRouteMap')
  const haulAt = tpl.indexOf('<LoadHaulSection')
  const rcAt = tpl.indexOf('<RateConPdfSection')
  ok(`§1 ${name}: the miles line sits under the map`, mapAt > 0 && haulAt > mapAt)
  ok(`§1 ${name}: LoadHaulSection feeds the map its lane`, /<LoadHaulSection\b[^>]*@lane="onPlannedLane"/.test(tpl) && /function onPlannedLane\(lane\) \{ plannedLane\.value = lane \}/.test(sfc))
  ok(`§1 ${name}: the rate con tile sits below the map and the miles line`, rcAt > haulAt && haulAt > 0)
  ok(`§1 ${name}: the rate con tile renders only for a Super Admin`, /<RateConPdfSection v-if="auth\.isSuperAdmin"/.test(tpl))
  ok(`§1 ${name}: no other map element in the modal`, !/haul-map|ref="mapEl"/.test(tpl))
}
ok('§1 ActiveLoadsTab: a delivered load gets no live position on the map',
  /const mapDriverPosition = computed\(\(\) => isSelectedLoadCompleted\.value \? null : selectedDriverPosition\.value\)/.test(ACTIVE) &&
  /<DriverRouteMap\b[^>]*:driver-position="mapDriverPosition"/.test(ACTIVE))
ok('§1 ActiveLoadsTab: the miles line knows whether the load is still running',
  /<LoadHaulSection\b[^>]*:load-in-progress="!isSelectedLoadCompleted"/.test(ACTIVE))
ok('§1 LoadHaulSection draws no map (no map element, no Maps loader)',
  HAUL.length > 0 && !/ref="mapEl"|createMap|useGoogleMaps|class="haul-map"/.test(HAUL))
ok('§1 LoadHaulSection no longer carries the second "Full Route" section', HAUL.length > 0 && !/Full Route — Pickup/.test(HAUL))

// ══ §2 DriverRouteMap, rendered ══════════════════════════════════════════════
const MAP_DEPS = {
  '../../composables/useApi': { useApi: () => ({ get: async () => ({}) }) },
  '../../composables/useGoogleMaps': { useGoogleMaps: () => ({ load: async () => ({}), createMap: async () => ({}) }), createDotPin: () => ({}) },
  '../../composables/useDriverPosition': { useDriverPosition: () => ({ startPhoneGps() {} }) },
  '../../composables/useVoiceGuidance': { useVoiceGuidance: () => ({ unlock() {} }) },
}
const MAP_HEADERS = ['Load ID', 'Job Status', 'Driver', 'Pickup Address', 'Drop-off Address', 'Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng']
const mapLoad = (status) => ({ 'Load ID': '7700123', 'Job Status': status, Driver: 'Driver A', 'Pickup Address': 'Town A, TX', 'Drop-off Address': 'Town B, GA', 'Origin Lat': '29.7', 'Origin Lng': '-95.3', 'Dest Lat': '33.7', 'Dest Lng': '-84.4' })
const LANE = { status: 'ready', route: [{ latitude: 29.7, longitude: -95.3 }, { latitude: 31.5, longitude: -90 }, { latitude: 33.7, longitude: -84.4 }], distanceMiles: 812.44, etaMinutes: 750, source: 'routes_api' }
const LIVE = { latitude: 30.1, longitude: -94.2, source: 'eld' }
let RouteMap = null
try { RouteMap = await compileComponent('client/src/components/driver/DriverRouteMap.vue', MAP_DEPS) } catch (err) { ok(`§2 DriverRouteMap compiles in this harness (${err.message})`, false) }
if (RouteMap) {
  for (const status of ['Dispatched', 'In Transit', 'Delivered']) {
    const planned = await ssr(RouteMap, { load: mapLoad(status), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, showArrival: true, plannedLane: LANE })
    ok(`§2 ${status}, no live position: the map shows the planned route`, /Planned route, pickup → drop-off/.test(planned))
    ok(`§2 ${status}, no live position: chips are the lane's miles and drive time (${planned.slice(0, 80)})`, planned.includes('812.4 mi') && planned.includes('12h 30m drive time'))
    ok(`§2 ${status}, no live position: no live ETA or arrival is claimed`, !/\bETA\b/.test(planned) && !/Estimated arrival/.test(planned))
    const live = await ssr(RouteMap, { load: mapLoad(status), headers: MAP_HEADERS, driverPosition: LIVE, dispatchMode: true, showArrival: true, plannedLane: LANE })
    ok(`§2 ${status}, live position: the live map, not the planned route`, !/Planned route/.test(live) && !/drive time/.test(live) && !live.includes('812.4 mi'))
  }
  const waiting = await ssr(RouteMap, { load: mapLoad('Dispatched'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, plannedLane: { status: 'loading' } })
  ok('§2 while the lane loads: the planned hint, and no chip invented', /Planned route/.test(waiting) && !/\bmi\b/.test(waiting))
  const straight = await ssr(RouteMap, { load: mapLoad('Dispatched'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, plannedLane: { status: 'ready', route: null, distanceMiles: 700, etaMinutes: null, source: 'straight_line' } })
  ok('§2 a straight-line lane says so', /Straight-line distance/.test(straight) && straight.includes('700 mi') && !/drive time/.test(straight))
  // An empty stored lane: distance 0, drive time unknown. No "0 mi", no chip.
  for (const lane of [
    { status: 'ready', route: LANE.route, distanceMiles: 0, etaMinutes: null, source: 'stored' },
    { status: 'ready', route: LANE.route, distanceMiles: null, etaMinutes: 0, source: 'stored' },
  ]) {
    const empty = await ssr(RouteMap, { load: mapLoad('Delivered'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, plannedLane: lane })
    ok(`§2 a lane of ${lane.distanceMiles} mi / ${lane.etaMinutes} min shows no chip for either (${empty.slice(0, 60)})`, !/\b0 mi\b/.test(empty) && !/\bmi\b/.test(empty) && !/drive time/.test(empty) && !/\b0m\b/.test(empty))
  }
  const halfLane = await ssr(RouteMap, { load: mapLoad('Delivered'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, plannedLane: { status: 'ready', route: LANE.route, distanceMiles: 412, etaMinutes: null, source: 'stored' } })
  ok('§2 a known distance with an unknown drive time: the miles chip alone', halfLane.includes('412 mi') && !/drive time/.test(halfLane))
  // Every other surface passes no plannedLane: identical to before.
  const none = await ssr(RouteMap, { load: mapLoad('Dispatched'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true })
  ok('§2 without the prop (job board, completed before, driver app): no planned route, no drive time', !/Planned route|drive time/.test(none))
  const pub = await ssr(RouteMap, { load: mapLoad('In Transit'), headers: MAP_HEADERS, driverPosition: null, publicMode: true, dispatchMode: true, plannedLane: LANE, presetRoute: { route: LANE.route, distanceMiles: 812.44, etaMinutes: 750 } })
  ok('§2 publicMode ignores a planned lane even if one were passed', !/Planned route|drive time/.test(pub))
  ok('§2 the prop defaults to null and every new branch reads usePlannedLane',
    /plannedLane: \{ type: Object, default: null \}/.test(ROUTE_MAP) &&
    /const usePlannedLane = computed\(\(\) => !props\.publicMode && !!props\.plannedLane && !driverLatLng\.value\)/.test(ROUTE_MAP))
  // Live mode, mounted: the map script and /api/route answer, as in
  // production. The ETA chip is there, as it was on main.
  {
    class Marker { constructor(o) { Object.assign(this, o) } addEventListener() {} }
    class Polyline { constructor(o) { this.o = { ...o } } setMap() {} get(k) { return this.o[k] } set(k, v) { this.o[k] = v } setPath() {} }
    class LatLngBounds { extend() {} getCenter() { return { lat: 0, lng: 0 } } }
    globalThis.google = { maps: { marker: { AdvancedMarkerElement: Marker }, Polyline, LatLngBounds, MapTypeControlStyle: { HORIZONTAL_BAR: 1 }, ControlPosition: { TOP_LEFT: 1 } } }
    const routeCalls = []
    const liveDeps = {
      ...MAP_DEPS,
      '../../composables/useApi': { useApi: () => ({ get: async (u) => { routeCalls.push(u); return { routes: [{ route: [{ latitude: 30.1, longitude: -94.2 }, { latitude: 32, longitude: -88 }, { latitude: 33.7, longitude: -84.4 }], distanceMiles: 85.2, etaMinutes: 95, steps: [] }], recommendedIdx: 0 } } }) },
      '../../composables/useGoogleMaps': { useGoogleMaps: () => ({ load: async () => globalThis.google.maps, createMap: async () => ({ fitBounds() {}, setCenter() {}, setZoom() {}, panTo() {} }) }), createDotPin: () => ({ addEventListener() {} }) },
    }
    let LiveMap = null
    try { LiveMap = await compileComponent('client/src/components/driver/DriverRouteMap.vue', liveDeps) } catch (err) { ok(`§2 DriverRouteMap mounts in this harness (${err.message})`, false) }
    if (LiveMap) {
      for (const [label, extra] of [['with the planned lane passed (Active)', { plannedLane: LANE }], ['without it (as on main)', {}]]) {
        routeCalls.length = 0
        const m = mountInMemory(LiveMap, { load: mapLoad('In Transit'), headers: MAP_HEADERS, driverPosition: LIVE, dispatchMode: true, ...extra })
        await drain()
        const txt = m.text()
        ok(`§2 live, ${label}: routed from the truck`, routeCalls.length >= 1 && routeCalls[0].startsWith('/api/route?fromLat=30.1&fromLng=-94.2'))
        ok(`§2 live, ${label}: the miles-left and ETA chips (${txt.slice(0, 70)})`, txt.includes('85.2 mi') && txt.includes('1h 35m ETA') && !/drive time|Planned route/.test(txt))
        m.unmount()
      }
      routeCalls.length = 0
      const p = mountInMemory(LiveMap, { load: mapLoad('Dispatched'), headers: MAP_HEADERS, driverPosition: null, dispatchMode: true, plannedLane: LANE })
      await drain()
      ok('§2 planned, mounted: the lane is drawn with no /api/route call', routeCalls.length === 0 && p.text().includes('812.4 mi') && p.text().includes('12h 30m drive time'))
      p.unmount()
    }
    delete globalThis.google
  }
  ok('§2 with a planned lane on screen no /api/route call is made',
    /if \(usePlannedLane\.value\) \{\s*if \(props\.plannedLane\.status === 'loading'\)[^\n]*return \}\s*if \(props\.plannedLane\.status === 'ready'\) \{ applyPlannedLane\(\); return \}/.test(ROUTE_MAP))
}

// ══ §3 the miles line ════════════════════════════════════════════════════════
let miles = null
try { miles = exists('client', 'src', 'lib', 'milesDriven.js') ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'milesDriven.js')).href) : null } catch { miles = null }
ok('§3 client/src/lib/milesDriven.js exists', !!miles)
if (miles) {
  const notThere = { basis: 'no-data', reason: 'no_pickup_zone', loadedMiles: null, deadheadMiles: null, totalMiles: null }
  ok('§3 a running load the truck has not reached yet: "The truck hasn\'t reached the pickup yet."',
    miles.milesDrivenReason(notThere, { loadInProgress: true }) === "The truck hasn't reached the pickup yet.")
  ok('§3 a finished load keeps today\'s wording', miles.milesDrivenReason(notThere, { loadInProgress: false }) === 'The truck was never recorded at the pickup, so the haul cannot be measured.')
  ok('§3 other reasons are unchanged while running', miles.milesDrivenReason({ reason: 'no_eld_device' }, { loadInProgress: true }) === 'This truck has no ELD device linked, so its miles are not reported.')
  ok('§3 an unknown reason still says something', miles.milesDrivenReason({ reason: 'mystery' }) === 'No ELD measurement is available for this load.')
  ok('§3 summary: total with loaded and deadhead', miles.milesDrivenSummary({ basis: 'eld', totalMiles: 512.34, loadedMiles: 480.1, deadheadMiles: 32.2 }) === '512.3 mi (480.1 loaded · 32.2 deadhead)')
  ok('§3 summary: "so far" while the haul runs', miles.milesDrivenSummary({ basis: 'partial', totalMiles: 100, loadedMiles: 100, deadheadMiles: null, inProgress: true }) === '100 mi (100 loaded) so far')
  ok('§3 nothing measured is never "0 mi"', miles.milesDrivenSummary(notThere) === '' && miles.milesDrivenUnavailable(notThere))
}
{
  let answer = null
  const api = { get: async (u) => { api.calls.push(u); return answer } , calls: [] }
  let Haul = null
  try { Haul = await compileComponent('client/src/components/dashboard/LoadHaulSection.vue', { '../../composables/useApi': { useApi: () => api } }) } catch (err) { ok(`§3 LoadHaulSection compiles in this harness (${err.message})`, false) }
  if (Haul) {
    const lanes = []
    answer = {
      origin: { lat: 29.7, lng: -95.3 }, destination: { lat: 33.7, lng: -84.4 },
      lane: { route: LANE.route, distanceMiles: 812.44, etaMinutes: 750, source: 'routes_api' },
      driven: { basis: 'eld', totalMiles: 512.34, loadedMiles: 480.1, deadheadMiles: 32.2, radiusM: 3218.7 },
    }
    const m = mountInMemory(Haul, { loadId: '7700123', open: true, onLane: (l) => lanes.push(l) })
    await drain()
    ok('§3 LoadHaulSection reads /haul once on open', api.calls.length === 1 && api.calls[0] === '/api/loads/7700123/haul')
    ok(`§3 the line: "Actual miles driven: 512.3 mi (480.1 loaded · 32.2 deadhead) ELD" (${m.text()})`, m.text() === 'Actual miles driven: 512.3 mi (480.1 loaded · 32.2 deadhead) ELD')
    const last = lanes[lanes.length - 1] || {}
    ok('§3 it emits the planned lane for the map', lanes[0] && lanes[0].status === 'loading' && last.status === 'ready' && last.distanceMiles === 812.44 && last.etaMinutes === 750 && Array.isArray(last.route) && last.route.length === 3)
    m.unmount()
    answer = { origin: { lat: 1, lng: 1 }, destination: { lat: 2, lng: 2 }, lane: { route: null, distanceMiles: 90, etaMinutes: null, source: 'stored' }, driven: { basis: 'no-data', reason: 'no_pickup_zone', loadedMiles: null, deadheadMiles: null } }
    const running = mountInMemory(Haul, { loadId: '7700124', open: true, loadInProgress: true })
    await drain()
    ok(`§3 a running load not yet at the pickup: the new wording (${running.text()})`, running.text() === "Actual miles driven: The truck hasn't reached the pickup yet.")
    running.unmount()
    const done = mountInMemory(Haul, { loadId: '7700124', open: true, loadInProgress: false })
    await drain()
    ok(`§3 a finished load: today's wording (${done.text()})`, done.text() === 'Actual miles driven: The truck was never recorded at the pickup, so the haul cannot be measured.')
    done.unmount()
    const lanes2 = []
    answer = { origin: null, destination: null, lane: { route: null, distanceMiles: null, etaMinutes: null, source: 'none' }, driven: { basis: 'no-data', reason: 'no_coordinates' } }
    const nocoord = mountInMemory(Haul, { loadId: '7700125', open: true, onLane: (l) => lanes2.push(l) })
    await drain()
    ok('§3 no coordinates: the lane is "none" (the map falls back to its own route fetch)', (lanes2[lanes2.length - 1] || {}).status === 'none')
    nocoord.unmount()
    const lanes3 = []
    answer = { origin: { lat: 1, lng: 1 }, destination: { lat: 2, lng: 2 }, lane: { route: null, distanceMiles: 0, etaMinutes: null, source: 'stored' }, driven: { basis: 'no-data', reason: 'no_samples' } }
    const emptyLane = mountInMemory(Haul, { loadId: '7700127', open: true, onLane: (l) => lanes3.push(l) })
    await drain()
    ok('§3 an empty stored lane (0 mi, no route) is "none", not a lane to draw', (lanes3[lanes3.length - 1] || {}).status === 'none')
    emptyLane.unmount()
    const before = api.calls.length
    const closed = mountInMemory(Haul, { loadId: '7700126', open: false })
    await drain()
    ok('§3 a closed modal reads nothing', api.calls.length === before)
    closed.unmount()
  }
}

// ══ §4 RateConPdfSection ═════════════════════════════════════════════════════
let view = null
try { view = exists('client', 'src', 'lib', 'rateConView.js') ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'rateConView.js')).href) : null } catch { view = null }
ok('§4 client/src/lib/rateConView.js exists', !!view)
{
  const world = { superAdmin: false }
  const authStub = { useAuthStore: () => ({ get isSuperAdmin() { return world.superAdmin } }) }
  let Section = null
  try {
    Section = exists('client', 'src', 'components', 'dashboard', 'RateConPdfSection.vue')
      ? await compileComponent('client/src/components/dashboard/RateConPdfSection.vue', { '../../stores/auth': authStub })
      : null
  } catch (err) { ok(`§4 RateConPdfSection compiles in this harness (${err.message})`, false) }
  ok('§4 RateConPdfSection.vue exists', !!Section)
  if (Section) {
    const requests = []
    let reply = null
    globalThis.fetch = async (u, opts) => { requests.push({ u: String(u), opts }); return reply() }
    const jsonReply = (status, body) => () => ({ ok: false, status, json: async () => body, blob: async () => new Blob([]) })
    for (const role of ['Dispatcher', 'Driver', 'Investor']) {
      world.superAdmin = false
      requests.length = 0
      const html = await ssr(Section, { loadId: '7700123', open: true })
      const m = mountInMemory(Section, { loadId: '7700123', open: true })
      await drain()
      ok(`§4 ${role}: no rate con section at all`, html === '' && m.text() === '' && !/Rate Con/i.test(html))
      ok(`§4 ${role}: no request`, requests.length === 0)
      m.unmount()
    }
    world.superAdmin = true
    reply = jsonReply(404, { code: 'RATECON_NOT_FOUND', error: 'No rate con is on file for this load.' })
    requests.length = 0
    const nf = mountInMemory(Section, { loadId: '7700123', open: true })
    await drain()
    ok(`§4 Super Admin, nothing on file: "No rate con on file" (${nf.text()})`, nf.text() === 'Rate Con No rate con on file')
    ok('§4 the request: GET /api/loads/<id>/ratecon.pdf with the session cookie and X-Requested-With',
      requests.length === 1 && requests[0].u === '/api/loads/7700123/ratecon.pdf' &&
      requests[0].opts && requests[0].opts.credentials === 'same-origin' &&
      requests[0].opts.headers && requests[0].opts.headers['X-Requested-With'] === 'XMLHttpRequest' &&
      (!requests[0].opts.method || requests[0].opts.method === 'GET'))
    nf.unmount()
    reply = jsonReply(503, { code: 'RATECON_SOURCE_UNAVAILABLE', error: 'Google Drive can\'t be reached right now.' })
    const down = mountInMemory(Section, { loadId: '7700123', open: true })
    await drain()
    ok(`§4 Drive down: "Rate con can't be loaded right now" (${down.text()})`, down.text() === "Rate Con Rate con can't be loaded right now")
    down.unmount()
    reply = () => { throw new TypeError('Failed to fetch') }
    const net = mountInMemory(Section, { loadId: '7700123', open: true })
    await drain()
    ok('§4 a dropped connection reads the same plain sentence', net.text() === "Rate Con Rate con can't be loaded right now")
    net.unmount()
    reply = () => ({ ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([Buffer.from('%PDF-1.7\n')], { type: 'application/pdf' }) })
    stubbed.length = 0
    const good = mountInMemory(Section, { loadId: '#7700123', open: true })
    await drain()
    const viewer = stubbed.filter((s) => s.name === 'RateConViewer').pop()
    ok('§4 a PDF goes to the in-page viewer as a blob: URL', !!viewer && /^blob:/.test(String(viewer.attrs.src || '')))
    ok('§4 a "#" in the load ID is encoded', requests[requests.length - 1].u === '/api/loads/%237700123/ratecon.pdf')
    good.unmount()
    requests.length = 0
    const shut = mountInMemory(Section, { loadId: '7700123', open: false })
    await drain()
    ok('§4 a closed modal asks for nothing', requests.length === 0)
    shut.unmount()
  }
  if (view) {
    ok('§4 404 reads "No rate con on file"', view.rateConFailureText(404, 'anything') === 'No rate con on file')
    ok('§4 503 reads "Rate con can\'t be loaded right now"', view.rateConFailureText(503, 'Drive down') === "Rate con can't be loaded right now")
    ok('§4 413/422 carry the server\'s sentence', view.rateConFailureText(422, 'The rate con on file isn\'t a PDF, so it can\'t be shown.') === "The rate con on file isn't a PDF, so it can't be shown.")
    ok('§4 a 403 never shows the server\'s wording', view.rateConFailureText(403, 'Forbidden') === "Rate con can't be loaded right now")
  }
}

// ══ §5 RateConViewer ═════════════════════════════════════════════════════════
{
  const VIEWER = read('client', 'src', 'components', 'shared', 'RateConViewer.vue')
  let Viewer = null
  try { Viewer = VIEWER ? await compileComponent('client/src/components/shared/RateConViewer.vue') : null } catch (err) { ok(`§5 RateConViewer compiles in this harness (${err.message})`, false) }
  ok('§5 RateConViewer.vue exists', !!Viewer)
  if (Viewer) {
    const html = await renderToString(Vue.createSSRApp(Viewer, { src: 'blob:test' }))
    for (const label of ['Previous page', 'Next page', 'Zoom out', 'Zoom in', 'Fit to page', 'Full screen']) {
      ok(`§5 control "${label}" is there`, html.includes(`aria-label="${label}"`))
    }
    ok('§5 "Page 1 of …" until the document says how many', text(html).includes('Page 1 of …'))
    ok('§5 it starts at fit to page', /aria-label="Fit to page"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Fit to page"/.test(html))
  }
  ok('§5 pdf.js gets only { url } (every option at its default, enableXfa off)', /const pdfSource = computed\(\(\) => \(\{ url: props\.src \}\)\)/.test(VIEWER))
  ok('§5 no text or annotation layer (nothing in the PDF is clickable)', VIEWER.length > 0 && !/text-layer|annotation-layer|textLayer|annotationLayer|:forms/.test(templateOf(VIEWER)))
  ok('§5 one page at a time', /:page="page"/.test(VIEWER))
  ok('§5 the essential vue-pdf-embed entry with its worker', /import\('vue-pdf-embed\/dist\/index\.essential\.mjs'\)/.test(VIEWER) && /import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'\)/.test(VIEWER))
  ok('§5 phone: the tile is 55% of the screen height', /@media \(max-width: 640px\) \{\s*\.rcv \{ height: 55vh; \}/.test(VIEWER))
  ok('§5 the tile is capped to the scroll area it sits in (outside full screen)',
    /const tileStyle = computed\(\(\) => \(!isFull\.value && tileCap\.value > 0 \? \{ maxHeight: `\$\{tileCap\.value\}px` \} : null\)\)/.test(VIEWER) && /:style="tileStyle"/.test(VIEWER))
  ok('§5 no link out of the viewer (no "Open PDF", no href)', VIEWER.length > 0 && !/Open PDF|<a\b|:href=/.test(templateOf(VIEWER)))
  ok('§5 Escape is caught on window in the capture phase', /window\.addEventListener\('keydown', onKeydown, true\)/.test(VIEWER) && /window\.removeEventListener\('keydown', onKeydown, true\)/.test(VIEWER))
  ok('§5 rateConView.js has tileMaxHeight()', !!view && typeof view.tileMaxHeight === 'function')
  if (view && typeof view.tileMaxHeight === 'function') {
    ok('§5 tile ceiling at 390x844: the ~495 px dialog body less its padding', view.tileMaxHeight(495, 20, 20) === 447)
    ok('§5 tile ceiling: never under 240 px, none when nothing was measured', view.tileMaxHeight(150, 20, 20) === 240 && view.tileMaxHeight(0) === 0 && view.tileMaxHeight(NaN) === 0)
  }
  // Mounted: full screen (the CSS fallback, as on an iPhone), then Escape.
  if (VIEWER) {
    const winListeners = []
    globalThis.window = {
      devicePixelRatio: 2,
      addEventListener: (type, fn, capture) => winListeners.push({ type, fn, capture }),
      removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1) },
    }
    globalThis.document = { addEventListener() {}, removeEventListener() {}, fullscreenEnabled: false, fullscreenElement: null, body: {} }
    globalThis.getComputedStyle = () => ({ overflowY: 'visible', paddingTop: '0px', paddingBottom: '0px' })
    try {
      const Viewer2 = await compileComponent('client/src/components/shared/RateConViewer.vue')
      const m = mountInMemory(Viewer2, { src: 'blob:test' })
      await drain()
      const tile = m.find((n) => n.type === 'el' && /\brcv\b/.test(String(n.props.class || '')))
      const fsBtn = m.find((n) => n.type === 'el' && n.props['aria-label'] === 'Full screen')
      const keydown = winListeners.find((l) => l.type === 'keydown')
      ok('§5 mounted: a capture-phase keydown listener on window', !!keydown && keydown.capture === true)
      ok('§5 mounted: no link in the failure state either', !m.find((n) => n.type === 'el' && n.tag === 'a'))
      if (tile && fsBtn && keydown) {
        fsBtn.props.onClick()
        await drain()
        ok('§5 Full screen expands the tile', /rcv-expanded/.test(String(tile.props.class)))
        const esc = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.stoppedNow = true } }
        keydown.fn(esc)
        await drain()
        ok('§5 Escape in full screen leaves full screen', !/rcv-expanded/.test(String(tile.props.class)))
        ok('§5 ...and goes no further, so the load dialog stays open (stopped, default prevented)', esc.defaultPrevented && esc.stopped && esc.stoppedNow)
        const esc2 = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.stoppedNow = true } }
        keydown.fn(esc2)
        ok('§5 Escape outside full screen is left alone (the dialog closes as usual)', !esc2.defaultPrevented && !esc2.stopped)
      } else {
        ok('§5 mounted: the tile, the Full screen button and the keydown listener are found', false)
      }
      m.unmount()
      ok('§5 unmount removes the keydown listener', !winListeners.some((l) => l.type === 'keydown'))
    } catch (err) {
      ok(`§5 RateConViewer mounts in this harness (${err.message})`, false)
    } finally {
      delete globalThis.window
      delete globalThis.document
      delete globalThis.getComputedStyle
    }
  }
  // Mounted: NATIVE full screen, and the browser leaving it on Escape by itself
  // before the keydown is handled (document.fullscreenElement already null).
  // `dispatchEscape` plays the event path: window capture (the viewer), then
  // the dialog's own Escape handler (reka-ui, window bubble), which closes the
  // dialog unless the event was stopped or its default prevented.
  if (VIEWER) {
    const winListeners = []
    const docListeners = []
    globalThis.window = {
      devicePixelRatio: 2,
      addEventListener: (type, fn, capture) => winListeners.push({ type, fn, capture }),
      removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1) },
    }
    const doc = {
      fullscreenEnabled: true,
      fullscreenElement: null,
      body: {},
      addEventListener: (type, fn) => docListeners.push({ type, fn }),
      removeEventListener: (type, fn) => { const i = docListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) docListeners.splice(i, 1) },
      exitFullscreen: async () => {},
    }
    globalThis.document = doc
    globalThis.getComputedStyle = () => ({ overflowY: 'visible', paddingTop: '0px', paddingBottom: '0px' })
    const fireFullscreenChange = (timeStamp) => docListeners.filter((l) => l.type === 'fullscreenchange').forEach((l) => l.fn({ type: 'fullscreenchange', timeStamp }))
    const dialog = { open: true }
    function dispatchEscape(timeStamp) {
      const ev = { key: 'Escape', timeStamp, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.stopped = true } }
      for (const l of winListeners.filter((x) => x.type === 'keydown' && x.capture === true)) { l.fn(ev); if (ev.stopped) break }
      if (!ev.stopped && !ev.defaultPrevented) dialog.open = false
      return ev
    }
    try {
      const Viewer3 = await compileComponent('client/src/components/shared/RateConViewer.vue')
      const m = mountInMemory(Viewer3, { src: 'blob:test' })
      await drain()
      const tile = m.find((n) => n.type === 'el' && /\brcv\b/.test(String(n.props.class || '')))
      const fsBtn = m.find((n) => n.type === 'el' && n.props['aria-label'] === 'Full screen')
      if (tile && fsBtn) {
        tile.requestFullscreen = async () => { doc.fullscreenElement = tile; fireFullscreenChange(1000) }
        fsBtn.props.onClick()
        await drain()
        const exitBtn = m.find((n) => n.type === 'el' && n.props['aria-label'] === 'Exit full screen')
        ok('§5 native full screen is entered (the button now says Exit full screen)', !!exitBtn)
        // The browser leaves full screen on Escape and reports it first.
        doc.fullscreenElement = null
        fireFullscreenChange(2000)
        await drain()
        ok('§5 native exit reported: the tile is out of full screen', !!m.find((n) => n.type === 'el' && n.props['aria-label'] === 'Full screen'))
        // The keydown's handler runs late (a busy main thread), but the key was
        // pressed 300 ms after the exit was reported: still the viewer's.
        await new Promise((r) => setTimeout(r, 700))
        const late = dispatchEscape(2300)
        ok('§5 Escape handled after fullscreenchange (fullscreenElement null, within 500 ms of the exit): the dialog stays open', dialog.open === true && late.stopped && late.defaultPrevented)
        const before = dispatchEscape(1990)
        ok('§5 an Escape pressed just before the exit was reported is also held back', dialog.open === true && before.stopped)
        const later = dispatchEscape(3000)
        ok('§5 Escape 1 s after leaving full screen closes the dialog as usual', dialog.open === false && !later.stopped && !later.defaultPrevented)
      } else {
        ok('§5 mounted (native): the tile and the Full screen button are found', false)
      }
      m.unmount()
    } catch (err) {
      ok(`§5 RateConViewer mounts in this harness, native full screen (${err.message})`, false)
    } finally {
      delete globalThis.window
      delete globalThis.document
      delete globalThis.getComputedStyle
    }
  }
  ok('§5 phone: one finger scrolls natively, two fingers pinch (touch-action pan-x pan-y, touchmove not passive)',
    /touch-action: pan-x pan-y/.test(VIEWER) && /addEventListener\('touchmove', onTouchMove, \{ passive: false \}\)/.test(VIEWER))
  ok('§5 no horizontal page scroll: the tile is capped to its column and scrolls inside', /\.rcv \{[^}]*max-width: 100%/.test(VIEWER) && /\.rcv-stage \{[^}]*overflow: auto/.test(VIEWER) && /min-width: 0/.test(VIEWER))
  if (view) {
    ok('§5 fit on a desktop tile: the page height decides', view.fitPageWidth(800, 700, 11 / 8.5) === 540)
    ok('§5 fit on a 390 px phone: the width decides', view.fitPageWidth(356, 520, 11 / 8.5) === 356)
    ok('§5 fit for a landscape page', view.fitPageWidth(800, 700, 8.5 / 11) === 800)
    ok('§5 zoom steps land exactly on fit', view.stepZoom(view.stepZoom(1, 1, 4), -1, 4) === 1 && view.stepZoom(0.8, 1, 4) === 1)
    ok('§5 zoom is bounded', view.clampZoom(99, 3) === 3 && view.clampZoom(0.01, 3) === view.MIN_ZOOM && view.clampZoom(NaN, 3) === 1)
    const mz = view.maxZoomFor(356, 11 / 8.5, 3)
    ok(`§5 the deepest zoom keeps the canvas under the phone limit (${mz.toFixed(2)})`, mz > 1 && Math.pow(356 * mz * 3, 2) * (11 / 8.5) <= 16.1e6)
    ok('§5 pages are bounded', view.clampPage(0, 3) === 1 && view.clampPage(9, 3) === 3 && view.clampPage(2, 3) === 2)
    ok('§5 the request URL', view.rateConPdfUrl(' 7700123 ') === '/api/loads/7700123/ratecon.pdf')
  }
}

// ══ §6 pdf.js ════════════════════════════════════════════════════════════════
{
  const pdfjsDir = path.dirname(clientRequire.resolve('pdfjs-dist/package.json'))
  // An import-only export, so it is located on disk rather than through require.
  const embedEntry = path.join(CLIENT_DIR, 'node_modules', 'vue-pdf-embed', 'dist', 'index.essential.mjs')
  const shipped = [
    path.join(pdfjsDir, 'legacy', 'build', 'pdf.mjs'),
    path.join(pdfjsDir, 'legacy', 'build', 'pdf.min.mjs'),
    path.join(pdfjsDir, 'legacy', 'build', 'pdf.worker.mjs'),
    path.join(pdfjsDir, 'legacy', 'build', 'pdf.worker.min.mjs'),
    path.join(pdfjsDir, 'legacy', 'web', 'pdf_viewer.mjs'),
    embedEntry,
  ]
  const distAssets = path.join(ROOT, 'client', 'dist', 'assets')
  if (fs.existsSync(distAssets)) {
    for (const f of fs.readdirSync(distAssets)) if (/pdf/i.test(f) && /\.m?js$/.test(f)) shipped.push(path.join(distAssets, f))
  }
  for (const f of shipped) {
    const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
    const rel = path.relative(HERE, f)
    ok(`§6 ${rel} is present`, src !== null)
    if (src === null) continue
    ok(`§6 ${rel}: no eval(`, !/(^|[^\w$.])eval\s*\(/.test(src))
    ok(`§6 ${rel}: no new Function(`, !/new\s+Function\s*\(/.test(src))
  }
  const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0) } return 0 }
  const installed = JSON.parse(fs.readFileSync(path.join(pdfjsDir, 'package.json'), 'utf8')).version
  ok(`§6 installed pdfjs-dist ${installed} is at or above 6.4.299`, cmp(installed, '6.4.299') >= 0)
  const pkg = JSON.parse(read('client', 'package.json') || '{}')
  const spec = String((pkg.dependencies || {})['pdfjs-dist'] || '')
  const floor = (/(\d+\.\d+\.\d+)/.exec(spec) || [])[1] || '0.0.0'
  ok(`§6 client/package.json asks for pdfjs-dist ${spec}, floor at or above 6.4.299`, /^[\^~]?\d/.test(spec) && cmp(floor, '6.4.299') >= 0)
  ok('§6 the override keeps vue-pdf-embed on that same pdfjs-dist', pkg.overrides && pkg.overrides['pdfjs-dist'] === '$pdfjs-dist')
  const lock = JSON.parse(read('client', 'package-lock.json') || '{}')
  const locked = lock.packages && lock.packages['node_modules/pdfjs-dist'] && lock.packages['node_modules/pdfjs-dist'].version
  ok(`§6 package-lock resolves pdfjs-dist ${locked} at or above 6.4.299`, !!locked && cmp(locked, '6.4.299') >= 0)
  const srcFiles = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(vue|js|mjs|ts)$/.test(e.name)) srcFiles.push(p) } }
  walk(path.join(ROOT, 'client', 'src'))
  const xfaOn = srcFiles.filter((f) => /enableXfa\s*[:=]\s*(true|!0|1\b)/.test(fs.readFileSync(f, 'utf8')))
  ok(`§6 no client source turns enableXfa on (${xfaOn.map((f) => path.relative(ROOT, f)).join(', ')})`, xfaOn.length === 0)
  const evalOpt = srcFiles.filter((f) => /isEvalSupported/.test(fs.readFileSync(f, 'utf8')))
  ok('§6 no client source passes isEvalSupported (pdfjs-dist 6 has no such option)', evalOpt.length === 0)
  const defaultEntry = srcFiles.filter((f) => /from\s+['"]vue-pdf-embed['"]|import\(\s*['"]vue-pdf-embed['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
  ok('§6 nothing imports vue-pdf-embed\'s default entry (it inlines its own pdf.js)', defaultEntry.length === 0)
}

// ══ §7 the other surfaces ════════════════════════════════════════════════════
for (const rel of ['client/src/views/TrackLoadView.vue', 'client/src/components/driver/LoadDetail.vue', 'client/src/components/dashboard/JobBoardTab.vue']) {
  const src = read(...rel.split('/'))
  ok(`§7 ${path.basename(rel)} exists`, src.length > 0)
  ok(`§7 ${path.basename(rel)}: no planned lane, no rate con tile`, !/planned-lane|plannedLane|RateConPdfSection|RateConViewer|ratecon\.pdf/.test(src))
}

console.log(`\nload-detail-ratecon: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
