#!/usr/bin/env node
// B11, owner decision 2026-10-15: wherever a truck's live position, distance or
// ETA is shown, a last fix older than 30 minutes says how old it is ("Last seen
// 3 h ago"), and one older than 2 hours shows no distance and no ETA.
//
//   §1 client/src/lib/fixAge.js: the two thresholds (over 30 minutes, over 2
//      hours; exactly at each is still fresh), the wording through
//      formatAgeMs(), ISO / epoch / Date input, an unknown age (no text, no ETA)
//   §2 DriverRouteMap (the dispatch load detail and the public tracker), with a
//      feed's fixAt: rendered and mounted, a fresh fix keeps its miles, ETA and
//      arrival; 45 minutes old adds "Last seen 45 min ago"; 3 hours old shows
//      "Last seen 3 h ago" and no miles, no ETA, no arrival; without fixAt (the
//      driver app's own position) nothing changes
//   §3 the customer tracking page (TrackLoadView), mounted on a payload: a 3-hour
//      fix with an ETA still in the payload shows "Not available" and the age,
//      and hands the map no arrival; 45 minutes shows the ETA and the age; a
//      fresh fix the ETA alone; no fix "Not available yet"; the map gets the fix
//      time
//   §4 the dispatch tracking map (TrackingMap), mounted on /api/locations/latest:
//      each driver row's age text and the glance metrics' distance and ETA
//   §5 the parts only a live map reaches (the marker popup, the route summary,
//      the route's distance label) and the load detail's fix time, from source
//
// No DOM, no server. Vue comes from this checkout's client/node_modules; the
// files under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-fix-age-tracking.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-fix-age-tracking.mjs   # a base checkout: fails
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
// Rendered HTML to its visible text: comments dropped, tags as spaces, the two
// entities the renderer emits here decoded, whitespace collapsed.
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
const lastStub = (name) => [...stubbed].reverse().find((s) => s.name === name) || null
const attr = (a, kebab, camel) => (a == null ? undefined : (kebab in a ? a[kebab] : a[camel]))
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
function mountInMemory(Comp, props, { components = {} } = {}) {
  const node = (type, tag) => Vue.markRaw({ type, tag, children: [], parent: null, props: {}, style: {}, text: '', addEventListener() {}, removeEventListener() {} })
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
  for (const [name, c] of Object.entries(components)) app.component(name, c)
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  return { root, app, text: () => textOf(root).replace(/\s+/g, ' ').trim(), unmount: () => app.unmount() }
}

const MIN = 60 * 1000
const HOUR = 60 * MIN
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// ══ §1 the helper ════════════════════════════════════════════════════════════
let fa = null
try { fa = exists('client', 'src', 'lib', 'fixAge.js') ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'fixAge.js')).href) : null } catch { fa = null }
ok('§1 client/src/lib/fixAge.js exists', !!fa)
if (fa) {
  const NOW = Date.parse('2026-10-15T16:00:00Z')
  ok('§1 the thresholds: 30 minutes and 2 hours', fa.LAST_SEEN_AFTER_MS === 30 * MIN && fa.NO_ETA_AFTER_MS === 2 * HOUR)
  ok('§1 the age of an ISO fix, an epoch fix and a Date fix',
    fa.fixAgeMs('2026-10-15T13:00:00Z', NOW) === 3 * HOUR && fa.fixAgeMs(NOW - 5 * MIN, NOW) === 5 * MIN && fa.fixAgeMs(new Date(NOW - MIN), NOW) === MIN)
  ok('§1 a fix a little ahead of this clock is 0 old; a missing or unreadable one has no age',
    fa.fixAgeMs(NOW + 5000, NOW) === 0 && fa.fixAgeMs(null, NOW) === null && fa.fixAgeMs('', NOW) === null && fa.fixAgeMs('not a time', NOW) === null)
  ok('§1 at 30 minutes exactly: no "Last seen"; one minute later: "Last seen 31 min ago"',
    fa.lastSeenText(30 * MIN) === '' && fa.lastSeenText(31 * MIN) === 'Last seen 31 min ago')
  ok('§1 "Last seen 3 h ago" at 3 h 20 min; "Last seen 2 d ago" at 50 h',
    fa.lastSeenText(3 * HOUR + 20 * MIN) === 'Last seen 3 h ago' && fa.lastSeenText(50 * HOUR) === 'Last seen 2 d ago')
  ok('§1 an unknown age says nothing', fa.lastSeenText(null) === '' && fa.lastSeenText(NaN) === '')
  ok('§1 ETA and distance allowed up to 2 hours exactly, not a millisecond more',
    fa.fixAllowsEta(0) === true && fa.fixAllowsEta(2 * HOUR) === true && fa.fixAllowsEta(2 * HOUR + 1) === false)
  ok('§1 never for an unknown age', fa.fixAllowsEta(null) === false && fa.fixAllowsEta(NaN) === false)
}

// ══ §2 DriverRouteMap ════════════════════════════════════════════════════════
const MAP_DEPS = {
  '../../composables/useApi': { useApi: () => ({ get: async () => ({}) }) },
  '../../composables/useGoogleMaps': { useGoogleMaps: () => ({ load: async () => ({}), createMap: async () => ({}) }), createDotPin: () => ({}) },
  '../../composables/useDriverPosition': { useDriverPosition: () => ({ startPhoneGps() {} }) },
  '../../composables/useVoiceGuidance': { useVoiceGuidance: () => ({ unlock() {} }) },
}
const MAP_HEADERS = ['Load ID', 'Job Status', 'Driver', 'Pickup Address', 'Drop-off Address', 'Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng']
const mapLoad = (status) => ({ 'Load ID': '7700123', 'Job Status': status, Driver: 'Driver A', 'Pickup Address': 'Town A, TX', 'Drop-off Address': 'Town B, GA', 'Origin Lat': '29.7', 'Origin Lng': '-95.3', 'Dest Lat': '33.7', 'Dest Lng': '-84.4' })
const LIVE = { latitude: 30.1, longitude: -94.2, source: 'eld' }
let RouteMap = null
try { RouteMap = await compileComponent('client/src/components/driver/DriverRouteMap.vue', MAP_DEPS) } catch (err) { ok(`§2 DriverRouteMap compiles in this harness (${err.message})`, false) }
if (RouteMap) {
  const base = { load: mapLoad('In Transit'), headers: MAP_HEADERS, driverPosition: LIVE, dispatchMode: true, showArrival: true }
  const old = await ssr(RouteMap, { ...base, fixAt: ago(3 * HOUR + 5 * MIN) })
  ok(`§2 rendered, a 3-hour fix: "Last seen 3 h ago" and why there is no ETA (${old.slice(0, 120)})`,
    old.includes('Last seen 3 h ago. No distance or ETA until the truck reports again.'))
  const mid = await ssr(RouteMap, { ...base, fixAt: ago(45 * MIN + 10000) })
  ok(`§2 rendered, a 45-minute fix: "Last seen 45 min ago", nothing withheld (${mid.slice(0, 120)})`,
    mid.includes('Last seen 45 min ago') && !mid.includes('No distance or ETA'))
  const fresh = await ssr(RouteMap, { ...base, fixAt: ago(10 * MIN) })
  ok('§2 rendered, a 10-minute fix: no "Last seen"', !/Last seen/.test(fresh))
  const own = await ssr(RouteMap, { ...base })
  ok('§2 rendered, no fixAt (the driver app): no "Last seen"', !/Last seen/.test(own))
  ok('§2 the prop defaults to null', /fixAt: \{ type: \[String, Number\], default: null \}/.test(read('client', 'src', 'components', 'driver', 'DriverRouteMap.vue')))

  // Mounted, with the map script and /api/route answering as in production.
  class Marker { constructor(o) { Object.assign(this, o) } addEventListener() {} }
  class Polyline { constructor(o) { this.o = { ...o } } setMap() {} get(k) { return this.o[k] } set(k, v) { this.o[k] = v } setPath() {} }
  class LatLngBounds { extend() {} getCenter() { return { lat: 0, lng: 0 } } }
  globalThis.google = { maps: { marker: { AdvancedMarkerElement: Marker }, Polyline, LatLngBounds, MapTypeControlStyle: { HORIZONTAL_BAR: 1 }, ControlPosition: { TOP_LEFT: 1 } } }
  const liveDeps = {
    ...MAP_DEPS,
    '../../composables/useApi': { useApi: () => ({ get: async () => ({ routes: [{ route: [{ latitude: 30.1, longitude: -94.2 }, { latitude: 32, longitude: -88 }, { latitude: 33.7, longitude: -84.4 }], distanceMiles: 85.2, etaMinutes: 95, steps: [] }], recommendedIdx: 0 }) }) },
    '../../composables/useGoogleMaps': { useGoogleMaps: () => ({ load: async () => globalThis.google.maps, createMap: async () => ({ fitBounds() {}, setCenter() {}, setZoom() {}, panTo() {} }) }), createDotPin: () => ({ addEventListener() {} }) },
  }
  let LiveMap = null
  try { LiveMap = await compileComponent('client/src/components/driver/DriverRouteMap.vue', liveDeps) } catch (err) { ok(`§2 DriverRouteMap mounts in this harness (${err.message})`, false) }
  if (LiveMap) {
    const mountAt = async (fixAt) => {
      const m = mountInMemory(LiveMap, { ...base, ...(fixAt === undefined ? {} : { fixAt }) })
      await drain()
      const t = m.text()
      m.unmount()
      return t
    }
    const freshTxt = await mountAt(ago(10 * MIN))
    ok(`§2 mounted, a 10-minute fix: miles, ETA and arrival as before (${freshTxt.slice(0, 120)})`,
      freshTxt.includes('85.2 mi') && freshTxt.includes('1h 35m ETA') && /Estimated arrival/.test(freshTxt) && !/Last seen/.test(freshTxt))
    const midTxt = await mountAt(ago(45 * MIN + 10000))
    ok('§2 mounted, a 45-minute fix: miles and ETA kept, and "Last seen 45 min ago"',
      midTxt.includes('85.2 mi') && midTxt.includes('1h 35m ETA') && midTxt.includes('Last seen 45 min ago'))
    const oldTxt = await mountAt(ago(3 * HOUR + 5 * MIN))
    ok(`§2 mounted, a 3-hour fix: no miles, no ETA, no arrival, and "Last seen 3 h ago" (${oldTxt.slice(0, 120)})`,
      !/\bmi\b/.test(oldTxt) && !/\bETA\b/.test(oldTxt.replace('No distance or ETA until the truck reports again.', '')) && !/Estimated arrival/.test(oldTxt) && oldTxt.includes('Last seen 3 h ago'))
    const badTxt = await mountAt('not a time')
    ok('§2 mounted, an unreadable fix time: no miles, no ETA (an unknown age never shows one)', !/\bmi\b/.test(badTxt) && !/1h 35m ETA/.test(badTxt))
    const ownTxt = await mountAt(undefined)
    ok('§2 mounted, no fixAt (the driver app): miles and ETA exactly as before', ownTxt.includes('85.2 mi') && ownTxt.includes('1h 35m ETA') && !/Last seen/.test(ownTxt))
  }
  delete globalThis.google
}

// ══ §3 the customer tracking page ═══════════════════════════════════════════
const routerDeps = {
  'vue-router': { useRoute: () => ({ params: { loadId: 'T-100' } }), useRouter: () => ({ push() {} }) },
  'socket.io-client': { io: () => ({ on() {}, emit() {}, disconnect() {} }) },
}
let Track = null
try { Track = await compileComponent('client/src/views/TrackLoadView.vue', routerDeps) } catch (err) { ok(`§3 TrackLoadView compiles in this harness (${err.message})`, false) }
if (Track) {
  const payload = (lastPing, eta) => ({
    loadId: 'T-100', status: 'In Transit', stages: [], phases: [],
    origin: { city: 'Town A', state: 'TX', zip: '' }, destination: { city: 'Town B', state: 'GA', zip: '' },
    originLat: 29.7, originLng: -95.3, destLat: 33.7, destLng: -84.4, truckUnit: '',
    lastPing, eta, route: [], distanceMiles: 812.4, etaMinutes: 750,
    scheduledPickup: '', scheduledDelivery: '', deliveredAt: null, actualPickup: null, actualDelivery: null,
  })
  const ETA = { distanceMiles: 120.5, minutesRemaining: 125, expectedAt: new Date(Date.now() + 125 * MIN).toISOString(), onTime: true }
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const page = async (body) => {
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => body })
    stubbed.length = 0
    const m = mountInMemory(Track, {}, { components: { 'router-link': stub('router-link') } })
    await drain()
    const t = m.text()
    const map = lastStub('DriverRouteMap')
    m.unmount()
    return { t, map: map ? map.attrs : null }
  }
  const oldAt = ago(3 * HOUR + 5 * MIN)
  const old = await page(payload({ lat: 31, lng: -92, at: oldAt }, ETA))
  ok(`§3 a 3-hour fix, ETA still in the payload: "Not available" and the age (${old.t.slice(0, 160)})`,
    /Estimated arrival Not available Last seen 3 h ago\. We'll show an ETA when it reports again\./.test(old.t) && !old.t.includes('2h 5m') && !old.t.includes('120.5 mi'))
  ok('§3 ...and the map gets the fix time and no arrival',
    attr(old.map, 'fix-at', 'fixAt') === oldAt && attr(old.map, 'show-arrival', 'showArrival') === false && attr(old.map, 'arrival-at', 'arrivalAt') == null)
  const midAt = ago(45 * MIN + 10000)
  const mid = await page(payload({ lat: 31, lng: -92, at: midAt }, ETA))
  ok(`§3 a 45-minute fix: the ETA and "Last seen 45 min ago" (${mid.t.slice(0, 160)})`,
    mid.t.includes('2h 5m') && mid.t.includes('~120.5 mi') && mid.t.includes('Last seen 45 min ago'))
  ok('§3 ...and the map gets the arrival', attr(mid.map, 'show-arrival', 'showArrival') === true && attr(mid.map, 'arrival-at', 'arrivalAt') === ETA.expectedAt && attr(mid.map, 'fix-at', 'fixAt') === midAt)
  const fresh = await page(payload({ lat: 31, lng: -92, at: ago(5 * MIN) }, ETA))
  ok('§3 a 5-minute fix: the ETA and no age', fresh.t.includes('2h 5m') && !/Last seen/.test(fresh.t))
  const noEta = await page(payload({ lat: 31, lng: -92, at: ago(5 * MIN) }, null))
  ok(`§3 a 5-minute fix with no ETA (no drop-off coordinates): "Not available yet", not the old-fix wording (${noEta.t.slice(0, 160)})`,
    /Not available yet/.test(noEta.t) && !/not reported its position recently/.test(noEta.t) && !/Last seen/.test(noEta.t))
  const none = await page(payload(null, null))
  ok('§3 no fix: "Not available yet", as before, and no fix time for the map',
    /Not available yet/.test(none.t) && !/Last seen/.test(none.t) && attr(none.map, 'fix-at', 'fixAt') == null)
  delete globalThis.fetch
  delete globalThis.document
}

// ══ §4 the dispatch tracking map ════════════════════════════════════════════
{
  const locations = [
    { driver: 'Driver Fresh', latitude: 30, longitude: -95, speed: 20, timestamp: ago(5 * MIN), source: 'routemate', noGps: false, distanceMiles: 80, etaMinutes: 90, etaStatus: 'on_time', activeLoads: [{ loadId: 'L1', status: 'In Transit' }] },
    { driver: 'Driver Mid', latitude: 31, longitude: -94, speed: 0, timestamp: ago(45 * MIN + 10000), source: 'routemate', noGps: false, distanceMiles: 70, etaMinutes: 60, etaStatus: 'on_time', activeLoads: [{ loadId: 'L2', status: 'In Transit' }] },
    { driver: 'Driver Old', latitude: 32, longitude: -93, speed: 0, timestamp: ago(3 * HOUR + 5 * MIN), source: 'routemate', noGps: false, distanceMiles: 60, etaMinutes: 50, pickupEtaMinutes: 20, etaStatus: 'delayed', activeLoads: [{ loadId: 'L3', status: 'Dispatched' }] },
  ]
  const deps = {
    '../../composables/useApi': { useApi: () => ({ get: async (u) => (u === '/api/locations/latest' ? { locations: locations.map((l) => ({ ...l })) } : { available: false }) }) },
    '../../composables/useSocket': { useSocket: () => ({ connect() {}, register() {}, on() {}, off() {} }) },
    '../../composables/useGoogleMaps': {
      useGoogleMaps: () => ({ load: () => new Promise(() => {}), createMap: async () => ({}) }),
      createDotPin: () => ({}), createTruckArrow: () => ({}), createFuelPricePin: () => ({}),
    },
  }
  globalThis.cancelAnimationFrame = () => {}
  let Tracking = null
  try { Tracking = await compileComponent('client/src/components/dashboard/TrackingMap.vue', deps) } catch (err) { ok(`§4 TrackingMap compiles in this harness (${err.message})`, false) }
  if (Tracking) {
    stubbed.length = 0
    const m = mountInMemory(Tracking, { visible: true })
    await drain()
    const t = m.text()
    const glance = stubbed.filter((s) => s.name === 'DriverGlanceMetrics').slice(-3).map((s) => s.attrs)
    m.unmount()
    ok(`§4 a 5-minute fix keeps its short age; 45 minutes and 3 hours read "Last seen" (${t.slice(0, 200)})`,
      /Driver Fresh .*5m ago/.test(t) && /Driver Mid .*Last seen 45 min ago/.test(t) && /Driver Old .*Last seen 3 h ago/.test(t) && !/Driver Fresh [^]*?Last seen[^]*?Driver Mid/.test(t))
    const [g1, g2, g3] = glance
    ok('§4 the fresh and the 45-minute rows keep their distance and ETA',
      glance.length === 3 && attr(g1, 'distance-miles', 'distanceMiles') === 80 && attr(g1, 'eta-minutes', 'etaMinutes') === 90 &&
      attr(g2, 'distance-miles', 'distanceMiles') === 70 && attr(g2, 'eta-minutes', 'etaMinutes') === 60)
    ok('§4 the 3-hour row gets no distance, no ETA, no shipper ETA and no on-time verdict',
      !!g3 && attr(g3, 'distance-miles', 'distanceMiles') == null && attr(g3, 'eta-minutes', 'etaMinutes') == null && attr(g3, 'eta-epoch-ms', 'etaEpochMs') == null &&
      attr(g3, 'pickup-eta-minutes', 'pickupEtaMinutes') == null && attr(g3, 'pickup-eta-epoch-ms', 'pickupEtaEpochMs') == null && attr(g3, 'eta-status', 'etaStatus') === 'unknown')
  }
  delete globalThis.cancelAnimationFrame
}

// ══ §5 what only a live map reaches, from source ════════════════════════════
{
  const TM = read('client', 'src', 'components', 'dashboard', 'TrackingMap.vue')
  const popupAt = TM.indexOf('function buildDriverPopupContent(')
  const popup = popupAt < 0 ? '' : TM.slice(popupAt, TM.indexOf('\n}\n', popupAt))
  ok('§5 the marker popup says "Last seen" for an old fix', /const lastSeen = locLastSeen\(loc\)/.test(popup) && /if \(lastSeen\) html \+=/.test(popup))
  ok('§5 the popup\'s ETA, miles remaining and miles to pickup need a fix of 2 hours or less',
    /const showEta = locShowsEta\(loc\)/.test(popup) && /if \(showEta && loc\.etaMinutes != null/.test(popup) &&
    /if \(showEta && loc\.distanceMiles != null/.test(popup) && /if \(showEta && selectedDriver\.value === loc\.driver && originLatLng\.value/.test(popup))
  ok('§5 the route summary hides miles and ETA for an old fix and shows its age',
    /v-if="selectedShowsEta && routeDistance != null"/.test(TM) && /v-if="selectedShowsEta && routeEta != null"/.test(TM) && /\{\{ selectedLastSeen \}\}/.test(TM))
  ok('§5 the route\'s distance label needs a fix of 2 hours or less', /if \(routeDistance\.value != null && selectedShowsEta\.value\)/.test(TM))
  ok('§5 the helpers read lib/fixAge.js on the 10 s clock',
    /return lastSeenText\(fixAgeMs\(loc && loc\.timestamp, now\.value\)\)/.test(TM) && /return fixAllowsEta\(fixAgeMs\(loc && loc\.timestamp, now\.value\)\)/.test(TM))
  const ACTIVE = read('client', 'src', 'components', 'dashboard', 'ActiveLoadsTab.vue')
  ok('§5 the dispatch load detail hands the map the ELD fix time',
    /<DriverRouteMap\b[^>]*:fix-at="mapDriverPosition \? mapDriverPosition\.fixAt : null"/.test(ACTIVE) && /fixAt: l\.timestamp \|\|/.test(ACTIVE))
}

if (failures.length) {
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n${pass} passed, 0 failed`)
process.exit(0)
