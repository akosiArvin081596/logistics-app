#!/usr/bin/env node
// B11, the user's decision 2026-10-16: when a truck's last fix is more than 2
// hours old, its load's map draws the planned pickup-to-drop-off route, never a
// route from the old pin, and asks no paid route from that pin (the figures it
// would give are already hidden, #523). The pin stays, with "Last seen X ago".
//
//   §1 client/src/lib/routeLeg.js: pinIsLive(), routeLegFor() — a live pin
//      routes to the pickup before collection and to the drop-off after; no pin
//      or a pin over 2 hours old gives the planned pickup -> drop-off leg
//   §2 DriverRouteMap (the dispatch load detail), mounted with the map script
//      and /api/route stubbed: a 3-hour fix asks pickup -> drop-off, draws the
//      line from the pickup with its marker and frames the route instead of
//      zooming to the old pin; with the admin planned lane it asks nothing; a
//      fix that turns old while the map is open is re-drawn from the plan; a
//      fresh fix and the driver app's own position route from the pin as before
//   §3 DriverRouteMap on the customer tracker (publicMode, preset lane): a fix
//      over 2 hours old leaves the lane whole instead of trimming it at the pin
//   §4 TrackingMap (the dispatch tracking map), mounted on /api/locations/latest
//      and opened on the driver: a 3-hour fix asks no route, approach leg or
//      driver-to-drop-off figures from the pin and draws the planned lane; a
//      fresh fix routes from the pin as before
//   §5 TrackingMap's live feed for the open driver: a pushed fix over 2 hours
//      old (the poller re-sends a parked device's last fix every minute) asks
//      no route or approach leg from that pin and is not glued to the line; a
//      fresh push still refreshes the route; and when the open load's fix turns
//      2 hours old on the map's own clock, the load is redrawn from the plan
//
// No DOM, no server, no network. Vue comes from this checkout's
// client/node_modules; the files under test come from LOGISX_ROOT (default:
// this checkout).
//   node scripts/test-stale-fix-route.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-stale-fix-route.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const CLIENT_DIR = path.join(HERE, 'client')

let pass = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

// Compile a committed SFC's <script setup> + <template> into a component.
// Imports are resolved from `overrides` first; a .vue import becomes a stub; a
// relative .js import is loaded from ROOT.
function stub(name) {
  return Vue.defineComponent({ name, inheritAttrs: false, setup() { return () => Vue.h('div', { 'data-stub': name }) } })
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
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// A minimal in-memory renderer, so a component can be MOUNTED (watchers run,
// awaits resolve, template refs are set) without a DOM.
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
  const find = (pred, n = root) => {
    if (n.type === 'el' && pred(n)) return n
    for (const c of n.children || []) { const hit = find(pred, c); if (hit) return hit }
    return null
  }
  return { root, text: () => textOf(root).replace(/\s+/g, ' ').trim(), find, unmount: () => app.unmount() }
}

const MIN = 60 * 1000
const HOUR = 60 * MIN
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// The load: pickup near 29.7,-95.3, drop-off near 33.7,-84.4. The old pin is
// far from both; the live one between them.
const PICKUP = { lat: 29.7, lng: -95.3 }
const DROP = { lat: 33.7, lng: -84.4 }
const OLD_PIN = { latitude: 26.5, longitude: -81.5, source: 'eld' }
const LIVE_PIN = { latitude: 31.2, longitude: -90.1, source: 'eld' }
const same = (p, q) => !!p && !!q && Math.abs(p.lat - q.lat) < 1e-9 && Math.abs(p.lng - q.lng) < 1e-9
const pinLatLng = (p) => ({ lat: p.latitude, lng: p.longitude })

// ══ §1 the helper ════════════════════════════════════════════════════════════
let leg = null
try { leg = exists('client', 'src', 'lib', 'routeLeg.js') ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'routeLeg.js')).href) : null } catch { leg = null }
ok('§1 client/src/lib/routeLeg.js exists', !!leg)
if (leg) {
  const pin = { lat: 31, lng: -90 }
  ok('§1 a live pin is live; an old one or none is not',
    leg.pinIsLive(pin, false) === true && leg.pinIsLive(pin, true) === false && leg.pinIsLive(null, false) === false)
  const a = leg.routeLegFor({ pin, pinTooOld: false, origin: PICKUP, dest: DROP, pickedUp: true })
  ok('§1 a live pin, freight aboard: from the pin to the drop-off', a.from === pin && a.to === DROP && a.fromPin === true, a)
  const b = leg.routeLegFor({ pin, pinTooOld: false, origin: PICKUP, dest: DROP, pickedUp: false })
  ok('§1 a live pin, not yet collected: from the pin to the pickup', b.from === pin && b.to === PICKUP && b.fromPin === true, b)
  const c = leg.routeLegFor({ pin, pinTooOld: false, origin: null, dest: DROP, pickedUp: false })
  ok('§1 ...with no pickup coordinate: from the pin to the drop-off', c.from === pin && c.to === DROP, c)
  for (const pickedUp of [true, false]) {
    const d = leg.routeLegFor({ pin, pinTooOld: true, origin: PICKUP, dest: DROP, pickedUp })
    ok(`§1 a pin over 2 hours old (${pickedUp ? 'freight aboard' : 'not yet collected'}): the planned pickup -> drop-off route`,
      d.from === PICKUP && d.to === DROP && d.fromPin === false, d)
  }
  const e = leg.routeLegFor({ pin: null, origin: PICKUP, dest: DROP, pickedUp: true })
  ok('§1 no pin: the planned pickup -> drop-off route, as before', e.from === PICKUP && e.to === DROP && e.fromPin === false, e)
}

// ══ §2-§3 DriverRouteMap ═════════════════════════════════════════════════════
const MAP_HEADERS = ['Load ID', 'Job Status', 'Driver', 'Pickup Address', 'Drop-off Address', 'Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng']
const mapLoad = (status) => ({ 'Load ID': '7700123', 'Job Status': status, Driver: 'Driver A', 'Pickup Address': 'Town A, TX', 'Drop-off Address': 'Town B, GA', 'Origin Lat': String(PICKUP.lat), 'Origin Lng': String(PICKUP.lng), 'Dest Lat': String(DROP.lat), 'Dest Lng': String(DROP.lng) })
const LANE = [{ latitude: PICKUP.lat, longitude: PICKUP.lng }, { latitude: 31.5, longitude: -90 }, { latitude: DROP.lat, longitude: DROP.lng }]

// One recording world per mount: every /api/route ask, every line drawn, every
// marker and camera move.
function mapWorld() {
  const w = { asks: [], lines: [], markers: [], camera: [] }
  class Marker { constructor(o) { Object.assign(this, o); w.markers.push(o) } addEventListener() {} addListener() {} }
  class Polyline {
    constructor(o) { this.o = { ...o }; if (o.strokeColor === '#ffffff') w.lines.push((o.path || []).map((p) => ({ lat: p.lat, lng: p.lng }))) }
    setMap() {} get(k) { return this.o[k] } set(k, v) { this.o[k] = v } getPath() { return { getArray: () => [] } }
    // A live redraw of the route line counts as a line drawn.
    setPath(path) { if (this.o.strokeColor === '#ffffff') w.lines.push((path || []).map((p) => ({ lat: p.lat, lng: p.lng }))) }
  }
  class LatLngBounds { extend() {} getCenter() { return { lat: 0, lng: 0 } } }
  class InfoWindow { open() {} close() {} setContent() {} }
  w.google = { maps: { marker: { AdvancedMarkerElement: Marker }, Polyline, LatLngBounds, InfoWindow, event: { trigger() {} }, MapTypeControlStyle: { HORIZONTAL_BAR: 1 }, ControlPosition: { TOP_LEFT: 1 } } }
  w.map = {
    fitBounds() { w.camera.push(['fitBounds']) }, setCenter(c) { w.camera.push(['setCenter', c]) }, setZoom(z) { w.camera.push(['setZoom', z]) },
    panTo() {}, getZoom() { return 10 }, addListener() { return { remove() {} } },
  }
  w.route = (url) => {
    const q = new URL(url, 'http://x').searchParams
    const from = { lat: Number(q.get('fromLat')), lng: Number(q.get('fromLng')) }
    const to = { lat: Number(q.get('toLat')), lng: Number(q.get('toLng')) }
    w.asks.push({ from, to })
    return { from, to, route: [{ latitude: from.lat, longitude: from.lng }, { latitude: (from.lat + to.lat) / 2, longitude: (from.lng + to.lng) / 2 }, { latitude: to.lat, longitude: to.lng }] }
  }
  return w
}
const lastLine = (w) => w.lines[w.lines.length - 1] || null

let RouteMap = null
let world = null
const routeMapDeps = {
  '../../composables/useApi': {
    useApi: () => ({
      get: async (url) => {
        if (!String(url).startsWith('/api/route')) return {}
        const r = world.route(url)
        return { routes: [{ route: r.route, distanceMiles: 85.2, etaMinutes: 95, steps: [] }], recommendedIdx: 0 }
      },
    }),
  },
  '../../composables/useGoogleMaps': { useGoogleMaps: () => ({ load: async () => globalThis.google.maps, createMap: async () => world.map }), createDotPin: () => ({ addEventListener() {} }) },
  '../../composables/useDriverPosition': { useDriverPosition: () => ({ startPhoneGps() {} }) },
  '../../composables/useVoiceGuidance': { useVoiceGuidance: () => ({ unlock() {} }) },
}
try { RouteMap = await compileComponent('client/src/components/driver/DriverRouteMap.vue', routeMapDeps) } catch (err) { ok(`§2 DriverRouteMap compiles in this harness (${err.message})`, false) }

async function mountMap(props) {
  world = mapWorld()
  globalThis.google = world.google
  const m = mountInMemory(RouteMap, props)
  await drain()
  const out = { w: world, text: m.text(), m }
  return out
}

if (RouteMap) {
  console.log('§2 DriverRouteMap, the dispatch load detail')
  const base = { load: mapLoad('In Transit'), headers: MAP_HEADERS, dispatchMode: true, showArrival: true }
  {
    const { w, m } = await mountMap({ ...base, driverPosition: OLD_PIN, fixAt: ago(3 * HOUR) })
    ok('§2 a 3-hour fix: the route asked is the planned pickup -> drop-off', w.asks.length >= 1 && w.asks.every((a) => same(a.from, PICKUP) && same(a.to, DROP)), w.asks)
    ok('§2 ...never one from the old pin', !w.asks.some((a) => same(a.from, pinLatLng(OLD_PIN))), w.asks)
    const line = lastLine(w)
    ok('§2 ...the line drawn starts at the pickup, not at the pin', !!line && same(line[0], PICKUP) && !line.some((p) => same(p, pinLatLng(OLD_PIN))), line && line.slice(0, 2))
    ok('§2 ...the pickup marker is drawn (the route starts there), and the pin stays', w.markers.some((mk) => mk.title === 'Pickup') && w.markers.some((mk) => same(mk.position, pinLatLng(OLD_PIN))),
      w.markers.map((mk) => mk.title))
    ok('§2 ...and the map frames the route instead of zooming in on the old pin',
      w.camera.some((c) => c[0] === 'fitBounds') && !w.camera.some((c) => c[0] === 'setZoom' && c[1] === 15), w.camera)
    m.unmount()
  }
  {
    const { w, m } = await mountMap({ ...base, load: mapLoad('Dispatched'), driverPosition: OLD_PIN, fixAt: ago(3 * HOUR) })
    ok('§2 not yet collected, a 3-hour fix: the planned pickup -> drop-off, not pin -> pickup',
      w.asks.length >= 1 && w.asks.every((a) => same(a.from, PICKUP) && same(a.to, DROP)), w.asks)
    m.unmount()
  }
  {
    const planned = { status: 'ready', route: LANE, distanceMiles: 812.4, etaMinutes: 750, source: 'routes_api' }
    const { w, text, m } = await mountMap({ ...base, driverPosition: OLD_PIN, fixAt: ago(3 * HOUR), plannedLane: planned })
    ok('§2 with the load\'s planned lane on hand, a 3-hour fix asks no route at all', w.asks.length === 0, w.asks)
    const line = lastLine(w)
    ok('§2 ...and draws that lane', !!line && same(line[0], PICKUP) && line.length >= LANE.length, line)
    ok(`§2 ...saying it is the planned route (${text.slice(0, 160)})`, text.includes('Planned route, pickup → drop-off.') && text.includes('Last seen 3 h ago'))
    m.unmount()
  }
  {
    const { w, m } = await mountMap({ ...base, driverPosition: LIVE_PIN, fixAt: ago(10 * MIN) })
    ok('§2 a 10-minute fix: routed from the pin to the drop-off, as before',
      w.asks.length === 1 && same(w.asks[0].from, pinLatLng(LIVE_PIN)) && same(w.asks[0].to, DROP), w.asks)
    const line = lastLine(w)
    ok('§2 ...and the line starts at the pin', !!line && same(line[0], pinLatLng(LIVE_PIN)), line && line[0])
    m.unmount()
  }
  {
    const { w, m } = await mountMap({ ...base, driverPosition: LIVE_PIN })
    ok('§2 no fixAt (the driver app\'s own position): routed from the pin, as before',
      w.asks.length === 1 && same(w.asks[0].from, pinLatLng(LIVE_PIN)), w.asks)
    m.unmount()
  }
  {
    // The fix turns old while the map is open: the parent hands a new fix time.
    world = mapWorld()
    globalThis.google = world.google
    const state = Vue.reactive({ fixAt: ago(10 * MIN) })
    const Wrapper = Vue.defineComponent({ setup: () => () => Vue.h(RouteMap, { ...base, driverPosition: LIVE_PIN, fixAt: state.fixAt }) })
    const m = mountInMemory(Wrapper, {})
    await drain()
    const w = world
    const asked = w.asks.length
    state.fixAt = ago(2 * HOUR + 5 * MIN)
    await drain()
    const later = w.asks.slice(asked)
    ok('§2 a fix that turns 2 hours old while the map is open: the planned route is asked',
      asked === 1 && later.length >= 1 && later.every((a) => same(a.from, PICKUP) && same(a.to, DROP)), [asked, later])
    const line = lastLine(w)
    ok('§2 ...and the line no longer starts at the pin', !!line && same(line[0], PICKUP), line && line[0])
    m.unmount()
  }

  console.log('§3 DriverRouteMap, the customer tracker')
  const pub = { load: mapLoad('In Transit'), headers: MAP_HEADERS, publicMode: true, presetRoute: { route: LANE, distanceMiles: 812.4, etaMinutes: 750 } }
  {
    const { w, m } = await mountMap({ ...pub, driverPosition: OLD_PIN, fixAt: ago(150 * MIN) })
    const line = lastLine(w)
    ok('§3 a 2 h 30 min fix: the lane is drawn whole, not trimmed at the old pin',
      !!line && same(line[0], PICKUP) && !line.some((p) => same(p, pinLatLng(OLD_PIN))), line && line.slice(0, 2))
    ok('§3 ...and nothing is routed (the tracker never asks)', w.asks.length === 0, w.asks)
    m.unmount()
  }
  {
    const { w, m } = await mountMap({ ...pub, driverPosition: LIVE_PIN, fixAt: ago(10 * MIN) })
    const line = lastLine(w)
    ok('§3 a 10-minute fix: the lane is trimmed at the pin, as before', !!line && same(line[0], pinLatLng(LIVE_PIN)), line && line[0])
    m.unmount()
  }
  delete globalThis.google
}

// ══ §4 TrackingMap ═══════════════════════════════════════════════════════════
console.log('§4 TrackingMap, the dispatch tracking map')
{
  const locFor = (pin, ageMs, status) => ({
    driver: 'Driver A', latitude: pin.latitude, longitude: pin.longitude, speed: 0, timestamp: ago(ageMs), source: 'linxup', noGps: false,
    loadId: 'L-77', etaStatus: 'unknown', etaMinutes: null, distanceMiles: null,
    activeLoads: [{ loadId: 'L-77', status, pickupAddress: 'Town A, TX', dropoffAddress: 'Town B, GA', originLat: PICKUP.lat, originLng: PICKUP.lng, destLat: DROP.lat, destLng: DROP.lng }],
  })
  let tw = null
  let socketHandlers = {}
  const deps = (locations, loadsMap) => ({
    '../../composables/useApi': {
      useApi: () => ({
        get: async (url) => {
          if (url === '/api/locations/latest') return { locations: locations.map((l) => ({ ...l, activeLoads: l.activeLoads.map((a) => ({ ...a })) })) }
          if (String(url).startsWith('/api/route')) {
            const r = tw.route(url)
            return { route: r.route, distanceMiles: 85.2, etaMinutes: 95 }
          }
          return { available: false }
        },
      }),
    },
    '../../composables/useSocket': { useSocket: () => ({ connect() {}, register() {}, on(event, fn) { socketHandlers[event] = fn }, off() {} }) },
    '../../composables/useGoogleMaps': {
      useGoogleMaps: () => ({ load: loadsMap ? async () => globalThis.google.maps : () => new Promise(() => {}), createMap: async () => tw.map }),
      createDotPin: () => ({ addEventListener() {} }), createTruckArrow: () => ({ addEventListener() {}, style: {} }), createFuelPricePin: () => ({ addEventListener() {} }),
    },
  })
  globalThis.cancelAnimationFrame = () => {}
  globalThis.requestAnimationFrame = () => 0
  globalThis.document = { createElement: () => ({ style: {}, textContent: '', addEventListener() {}, appendChild() {} }) }
  // Opens the map on the driver (a click on the driver's row), which expands
  // the driver's working load and draws its route.
  const openOn = async (loc, { loadsMap = false } = {}) => {
    tw = mapWorld()
    globalThis.google = tw.google
    let Tracking = null
    try { Tracking = await compileComponent('client/src/components/dashboard/TrackingMap.vue', deps([loc], loadsMap)) } catch (err) { ok(`§4 TrackingMap compiles in this harness (${err.message})`, false); return null }
    const m = mountInMemory(Tracking, { visible: true })
    await drain()
    // The driver's own row, not the "All drivers" row above it.
    const row = m.find((n) => /(^|\s)driver-item(\s|$)/.test(String(n.props.class || '')) && !/\ball-item\b/.test(String(n.props.class || '')))
    if (!row || typeof row.props.onClick !== 'function') { m.unmount(); return { w: tw, opened: false } }
    row.props.onClick({ stopPropagation() {} })
    await drain()
    m.unmount()
    return { w: tw, opened: true }
  }
  {
    const r = await openOn(locFor(OLD_PIN, 3 * HOUR, 'In Transit'))
    ok('§4 the driver row opens', !!r && r.opened)
    if (r && r.opened) {
      ok('§4 In Transit, a 3-hour fix: no route asked from the old pin', !r.w.asks.some((a) => same(a.from, pinLatLng(OLD_PIN))), r.w.asks)
      ok('§4 ...the planned pickup -> drop-off is asked instead', r.w.asks.some((a) => same(a.from, PICKUP) && same(a.to, DROP)), r.w.asks)
    }
  }
  {
    const r = await openOn(locFor(OLD_PIN, 3 * HOUR, 'Dispatched'))
    if (r && r.opened) {
      ok('§4 Dispatched, a 3-hour fix: no approach leg and no driver-to-drop-off figures asked from the old pin',
        !r.w.asks.some((a) => same(a.from, pinLatLng(OLD_PIN))), r.w.asks)
    }
  }
  {
    const r = await openOn(locFor(LIVE_PIN, 10 * MIN, 'In Transit'))
    if (r && r.opened) {
      ok('§4 In Transit, a 10-minute fix: routed from the pin to the drop-off, as before',
        r.w.asks.some((a) => same(a.from, pinLatLng(LIVE_PIN)) && same(a.to, DROP)), r.w.asks)
    }
  }
  {
    // With the map script loaded, the line itself: the planned lane, not one
    // glued to the old pin.
    const r = await openOn(locFor(OLD_PIN, 3 * HOUR, 'In Transit'), { loadsMap: true })
    if (r && r.opened) {
      const line = lastLine(r.w)
      ok('§4 In Transit, a 3-hour fix, map loaded: the line starts at the pickup, not at the old pin',
        !!line && same(line[0], PICKUP) && !line.some((p) => same(p, pinLatLng(OLD_PIN))), line && line.slice(0, 2))
      const centredOnPin = r.w.camera.some((c) => c[0] === 'setCenter' && same(c[1], pinLatLng(OLD_PIN)))
      const streetZoom = r.w.camera.some((c) => c[0] === 'setZoom' && c[1] === 20)
      ok('§4 ...and the map is not zoomed in on the old pin', !(centredOnPin && streetZoom), r.w.camera)
    }
    const f = await openOn(locFor(LIVE_PIN, 10 * MIN, 'In Transit'), { loadsMap: true })
    if (f && f.opened) {
      const line = lastLine(f.w)
      ok('§4 a 10-minute fix, map loaded: the line starts at the pin, as before', !!line && same(line[0], pinLatLng(LIVE_PIN)), line && line[0])
    }
  }
  // ══ §5 TrackingMap's live feed ═════════════════════════════════════════════
  console.log('§5 TrackingMap, the live feed for the open driver')
  {
    // The map's own clock and the Date it reads, under the test's control; an
    // animation frame runs its last step at once.
    const realNow = Date.now
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    let skew = 0
    const intervals = []
    Date.now = () => realNow() + skew
    globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
    globalThis.clearInterval = () => {}
    globalThis.requestAnimationFrame = (cb) => { setImmediate(() => cb(performance.now() + 1e7)); return 1 }
    const tickClock = async (ms) => {
      skew += ms
      for (const i of intervals) if (i.ms === 10000) i.fn()
      await drain()
    }
    const openLive = async (loc) => {
      tw = mapWorld()
      globalThis.google = tw.google
      socketHandlers = {}
      intervals.length = 0
      const Tracking = await compileComponent('client/src/components/dashboard/TrackingMap.vue', deps([loc], true))
      const m = mountInMemory(Tracking, { visible: true })
      await drain()
      const row = m.find((n) => /(^|\s)driver-item(\s|$)/.test(String(n.props.class || '')) && !/\ball-item\b/.test(String(n.props.class || '')))
      if (row) row.props.onClick({ stopPropagation() {} })
      await drain()
      const push = async (pin, at) => {
        socketHandlers['location-update']({ driver: 'Driver A', latitude: pin.latitude, longitude: pin.longitude, speed: 0, heading: 0, loadId: 'L-77', timestamp: at, source: 'routemate', fuelPct: null })
        await drain()
      }
      return { w: tw, m, push, opened: !!row && typeof socketHandlers['location-update'] === 'function' }
    }
    {
      // In Transit, opened on a 3-hour fix; a minute later the poller re-sends
      // that same fix.
      const loc = locFor(OLD_PIN, 3 * HOUR, 'In Transit')
      const r = await openLive(loc)
      ok('§5 the map opens with its live feed', r.opened)
      const asked = r.w.asks.length
      const lines = r.w.lines.length
      skew += 61 * 1000
      await r.push(OLD_PIN, loc.timestamp)
      const later = r.w.asks.slice(asked)
      ok('§5 In Transit, the 3-hour fix pushed again a minute later: no route asked from that pin', !later.some((a) => same(a.from, pinLatLng(OLD_PIN))), later)
      const drawn = r.w.lines.slice(lines)
      ok('§5 ...and the line is not glued to it', !drawn.some((line) => line.length && same(line[0], pinLatLng(OLD_PIN))), drawn.map((l) => l[0]))
      r.m.unmount()
    }
    {
      const loc = locFor(OLD_PIN, 3 * HOUR, 'Dispatched')
      const r = await openLive(loc)
      const asked = r.w.asks.length
      await r.push(OLD_PIN, loc.timestamp)
      const later = r.w.asks.slice(asked)
      ok('§5 Dispatched, the 3-hour fix pushed again: no approach leg and no driver-to-drop-off figures asked from that pin',
        !later.some((a) => same(a.from, pinLatLng(OLD_PIN))), later)
      r.m.unmount()
    }
    {
      const LIVE_NEXT = { latitude: 31.4, longitude: -89.6 }
      const r = await openLive(locFor(LIVE_PIN, 10 * MIN, 'In Transit'))
      const asked = r.w.asks.length
      skew += 61 * 1000
      await r.push(LIVE_NEXT, new Date(Date.now() - 20 * 1000).toISOString())
      const later = r.w.asks.slice(asked)
      ok('§5 a fresh push a minute later still refreshes the route from the truck, as before',
        later.some((a) => same(a.from, pinLatLng(LIVE_NEXT)) && same(a.to, DROP)), later)
      r.m.unmount()
    }
    {
      // Opened on a 1 h 55 min fix (live, routed from the pin); the map's clock
      // then runs past 2 hours with no new fix.
      const r = await openLive(locFor(LIVE_PIN, 2 * HOUR - 5 * MIN, 'In Transit'))
      ok('§5 a 1 h 55 min fix is routed from the pin when opened', r.w.asks.some((a) => same(a.from, pinLatLng(LIVE_PIN))), r.w.asks)
      const asked = r.w.asks.length
      await tickClock(10 * 1000)
      ok('§5 ...ten seconds on, still under 2 hours: nothing redrawn', r.w.asks.length === asked, r.w.asks.slice(asked))
      await tickClock(10 * MIN)
      const later = r.w.asks.slice(asked)
      ok('§5 ...once the fix is over 2 hours old: the load is redrawn from the planned pickup -> drop-off',
        later.length >= 1 && later.every((a) => same(a.from, PICKUP) && same(a.to, DROP)), later)
      const line = lastLine(r.w)
      ok('§5 ...and the line now starts at the pickup', !!line && same(line[0], PICKUP), line && line[0])
      r.m.unmount()
    }
    Date.now = realNow
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  delete globalThis.cancelAnimationFrame
  delete globalThis.requestAnimationFrame
  delete globalThis.document
  delete globalThis.google
}

if (failures.length) {
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n${pass} passed, 0 failed`)
process.exit(0)
