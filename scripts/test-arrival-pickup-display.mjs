#!/usr/bin/env node
// The load detail's read-only pickup line under the arrival pickup date rule
// (ARRIVAL_PICKUP_DATE_ENABLED, off by default). The server decides the facts
// (lib/arrival-pickup-display.js, `_pickupArrival`); the client words them
// (client/src/lib/pickupArrival.js) on Active, Completed and Job Board and on
// the driver's own load detail.
//
//   §1 the words: the arrival line with its time on the business clock, both days
//      when that clock's day differs from the shipper's, the note that a Pickup
//      Appointment edit doesn't change pay, and the rate-con line without one
//   §2 flag off: no row gets the key, and no screen shows a line
//   §3 the field: in scope as the pay paths read a load; what it carries (no Load
//      ID, distance or name)
//   §4 nothing computed in the browser: the client reads only the field, with no
//      clock or zone; the same words and the same field under four process zones
//   §5 the four components compile
//   §6 mutants, each caught
// The two routes are run in scripts/test-arrival-pickup-pay-paths.js (§D).
// Made-up data only (Amy Birch, Bo Wyn; loads L-3101 and up). No network, no DOM.
//   node scripts/test-arrival-pickup-display.mjs     # exits 1 on any failure

import fs from 'fs'
import os from 'os'
import path from 'path'
import Module, { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const CLIENT_LIB = path.join(ROOT, 'client', 'src', 'lib', 'pickupArrival.js')
const SERVER_LIB = path.join(ROOT, 'lib', 'arrival-pickup-display.js')
const COMPONENTS = ['dashboard/ActiveLoadsTab.vue', 'dashboard/CompletedLoadsTab.vue', 'dashboard/JobBoardTab.vue', 'driver/LoadDetail.vue']
const ZONES = ['America/New_York', 'America/Chicago', 'UTC', 'Asia/Manila']

const ON = { ARRIVAL_PICKUP_DATE_ENABLED: 'true', ARRIVAL_PICKUP_DATE_FROM: '2026-11-20' }
const ET = 'America/New_York'
const AMY = 'Amy Birch'
const BO = 'Bo Wyn'
const CHI = 'America/Chicago'

// ── the made-up world ──────────────────────────────────────────────────────────
function historyDb({ columns = true } = {}) {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '',
    new_status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', reason TEXT DEFAULT '',
    ${columns ? "actor_role TEXT DEFAULT '', fix_ms INTEGER, pickup_distance_m REAL, pickup_zone TEXT DEFAULT '', local_tz TEXT DEFAULT '', other_load_hauling INTEGER," : ''}
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
  return db
}
const U = (s) => Date.parse(`${s.replace(' ', 'T')}Z`)
// One load's trip as the recorder writes it; `arrival` is 'geofence' (fix `fixAt`) or 'tap'.
function addTrip(db, id, { arrival = 'geofence', at, fixAt = null, delivered = '2026-12-10 18:00:00', actor = AMY }) {
  const ins = db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, actor_role, fix_ms, pickup_distance_m, pickup_zone, local_tz, other_load_hauling, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const key = id.toLowerCase()
  ins.run(key, 'Unassigned', 'Dispatched', 'dispatch', 'dispatcher_test', 'Dispatcher', null, null, '', '', null, '2026-12-04 15:00:00')
  ins.run(key, 'Dispatched', 'Heading to Shipper', 'manual', actor, 'Driver', null, null, '', '', null, '2026-12-07 22:00:00')
  if (arrival === 'geofence') ins.run(key, 'Heading to Shipper', 'At Shipper', 'geofence', actor, 'system', U(fixAt), 812.5, 'inside', CHI, 0, at)
  else ins.run(key, 'Heading to Shipper', 'At Shipper', 'manual', actor, 'Driver', U(at), 640.25, 'inside', CHI, null, at)
  ins.run(key, 'At Shipper', 'Loading', 'manual', actor, 'Driver', null, null, '', '', null, '2026-12-09 15:00:00')
  ins.run(key, 'Loading', 'In Transit', 'manual', actor, 'Driver', null, null, '', '', null, '2026-12-09 15:30:00')
  ins.run(key, 'In Transit', 'At Receiver', 'manual', actor, 'Driver', null, null, '', '', null, '2026-12-10 15:00:00')
  if (delivered) ins.run(key, 'At Receiver', 'Delivered', 'manual', actor, 'Driver', null, null, '', '', null, delivered)
}
// Job Tracking rows as the server reads them (the readers below stand in for server.js's).
const row = (id, o = {}) => ({ 'Load ID': id, Driver: AMY, 'Job Status': 'Delivered', 'Assigned Date': '2026-12-04', 'Pickup Appointment': '2026-12-07', ...o })
const READ = {
  loadId: (r) => r['Load ID'],
  completed: (r) => /delivered|completed|pod received/i.test(r['Job Status'] || ''),
  driverKey: (r) => String(r.Driver || '').trim().toLowerCase(),
  assigned: (r) => r['Assigned Date'] || null,
  scheduled: (r) => r['Pickup Appointment'],
}
const PAY_TYPES = () => Object.assign(Object.create(null), { 'amy birch': { payType: 'fixed' }, 'bo wyn': { payType: 'percentage' } })

// The world every §3 case reads: one load per rule.
function world() {
  const db = historyDb()
  addTrip(db, 'L-3101', { arrival: 'geofence', at: '2026-12-08 14:41:10', fixAt: '2026-12-08 14:40:00' })
  addTrip(db, 'L-3102', { arrival: 'tap', at: '2026-12-09 03:30:00' })
  addTrip(db, 'L-3103', { arrival: 'geofence', at: '2026-12-09 05:21:00', fixAt: '2026-12-09 05:20:00' })
  addTrip(db, 'L-3104', { arrival: 'geofence', at: '2026-12-08 14:41:00', fixAt: '2026-12-08 14:40:00', delivered: null })
  addTrip(db, 'L-3105', { arrival: 'geofence', at: '2026-12-08 14:41:00', fixAt: '2026-12-08 14:40:00', actor: BO })
  addTrip(db, 'L-3106', { arrival: 'geofence', at: '2026-12-08 14:41:00', fixAt: '2026-12-08 14:40:00' })
  addTrip(db, 'L-3107', { arrival: 'geofence', at: '2026-12-08 14:41:00', fixAt: '2026-12-08 14:40:00' })
  return db
}
const ROWS = () => [
  row('L-3101'), // GPS arrival, Tue Dec 8 08:40 CST (9:40 AM EST)
  row('L-3102', { 'Pickup Appointment': '2026-12-09' }), // his own tap, 21:30 CST Tue Dec 8 (Wed Dec 9 03:30 UTC)
  row('L-3103'), // GPS at 23:20 CST Tue Dec 8: already Wed Dec 9 on the business clock
  row('L-3104'), // an arrival but no Delivered row: paid its scheduled window
  row('L-3105', { Driver: BO }), // a percentage driver
  row('L-3106', { 'Job Status': 'In Transit' }), // not completed on the sheet (set back there by hand), though its history ends Delivered
  row('L-3107', { 'Assigned Date': '2026-11-19' }), // assigned before FROM
  row('L-3108'), // no history at all
  row('L-3109', { 'Pickup Appointment': '' }), // nothing to say
]
const annotate = (lib, { env = ON, rows = ROWS(), db = world(), tripFrom = null, payTypes = PAY_TYPES, read = READ, logs = [] } = {}) => {
  const shown = lib.annotateRows({ db, env, rows, read, payTypes, tripFrom, zone: ET, log: (m) => logs.push(m) })
  return { rows, shown, logs, byId: Object.fromEntries(rows.map((r) => [r['Load ID'], r._pickupArrival])) }
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
// A fresh copy of a CommonJS lib, compiled from `text` under its own file name (so its
// requires resolve), never touching the require cache.
function compileCjs(file, text) {
  const m = new Module(file, null)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(text, file)
  return m.exports
}
// A fresh copy of the client lib (it imports nothing), from `text`.
let tmpDir = null
async function importClient(text) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-display-'))
  const file = path.join(tmpDir, `pickupArrival-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, text)
  return import(pathToFileURL(file).href)
}

// The zone probe: this runner again under another TZ prints the words and the fields.
if (process.argv[2] === '--tz-probe') {
  const client = await import(pathToFileURL(CLIENT_LIB).href)
  const lib = require(SERVER_LIB)
  const { rows } = annotate(lib)
  process.stdout.write(JSON.stringify(rows.map((r) => [r._pickupArrival, client.pickupArrivalLine(r)])))
  process.exit(0)
}

// ── the runner ─────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const failures = []
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return true }
  fail++
  failures.push(name)
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
  return false
}
const ok = (name, cond, detail = '') => eq(name + (cond || !detail ? '' : ` (${detail})`), !!cond, true)

// On a base without the feature each case fails on its own instead of the run stopping.
const client = await import(pathToFileURL(CLIENT_LIB).href).catch(() => ({ pickupArrivalLine: () => null, dayLabel: () => null }))
let server
try { server = require(SERVER_LIB) } catch { server = { annotateRows: () => 0 } }
const LINE_3101 = "Arrived at shipper Tue Dec 8, 9:40 AM EST (GPS). Pay starts this day; editing the Pickup Appointment doesn't change it. Scheduled (rate con): Mon Dec 7"

// ---------------------------------------------------------------------------
console.log('§1 the words (client/src/lib/pickupArrival.js)')
// ---------------------------------------------------------------------------
function wordCases(c) {
  const line = c.pickupArrivalLine
  eq('1a GPS arrival, the same day on both clocks', line({ _pickupArrival: { scheduled: '2026-12-07', day: '2026-12-08', at: '2026-12-08T14:40:00.000Z', source: 'gps', atDay: '2026-12-08', atTime: '9:40 AM EST' } }), LINE_3101)
  eq("1b his own tap: (driver's tap)", line({ _pickupArrival: { scheduled: '2026-12-09', day: '2026-12-08', at: '2026-12-09T03:30:00.000Z', source: 'driver', atDay: '2026-12-08', atTime: '10:30 PM EST' } }),
    "Arrived at shipper Tue Dec 8, 10:30 PM EST (driver's tap). Pay starts this day; editing the Pickup Appointment doesn't change it. Scheduled (rate con): Wed Dec 9")
  eq("1c the business clock's day differs from the shipper's: both days named, and pay starts on the shipper's", line({ _pickupArrival: { scheduled: '2026-12-07', day: '2026-12-08', at: '2026-12-09T05:20:00.000Z', source: 'gps', atDay: '2026-12-09', atTime: '12:20 AM EST' } }),
    "Arrived at shipper Tue Dec 8 on the shipper's clock; Wed Dec 9, 12:20 AM EST (GPS). Pay starts Tue Dec 8; editing the Pickup Appointment doesn't change it. Scheduled (rate con): Mon Dec 7")
  eq('1d no time sent: the plan\'s line as written', line({ _pickupArrival: { scheduled: '2026-12-07', day: '2026-12-08', source: 'gps' } }),
    "Arrived at shipper Tue Dec 8 (GPS). Pay starts this day; editing the Pickup Appointment doesn't change it. Scheduled (rate con): Mon Dec 7")
  eq('1e a blank Pickup Appointment: no Scheduled part', line({ _pickupArrival: { scheduled: '', day: '2026-12-08', at: '2026-12-08T14:40:00.000Z', source: 'gps', atDay: '2026-12-08', atTime: '9:40 AM EST' } }),
    "Arrived at shipper Tue Dec 8, 9:40 AM EST (GPS). Pay starts this day; editing the Pickup Appointment doesn't change it.")
  eq('1f no arrival: the rate con\'s date', line({ _pickupArrival: { scheduled: '2026-12-07' } }), 'Pickup (rate con): Mon Dec 7')
  eq('1g no arrival and no date: no line', line({ _pickupArrival: { scheduled: '' } }), '')
  eq('1h a source the server never sends: never "Arrived"', line({ _pickupArrival: { scheduled: '2026-12-07', day: '2026-12-08', source: 'dispatcher', atDay: '2026-12-08', atTime: '9:40 AM EST' } }), 'Pickup (rate con): Mon Dec 7')
  eq('1i a day that does not exist: never "Arrived"', line({ _pickupArrival: { scheduled: '2026-12-07', day: '2026-02-30', source: 'gps' } }), 'Pickup (rate con): Mon Dec 7')
  for (const [name, f] of [['GPS', { day: '2026-12-08', source: 'gps' }], ['tap', { day: '2026-12-08', source: 'driver', atDay: '2026-12-08', atTime: '9:40 AM EST' }], ['two clocks', { day: '2026-12-08', source: 'gps', atDay: '2026-12-09', atTime: '12:20 AM EST' }]]) {
    ok(`1j the Pickup Appointment note on every arrival line (${name})`, /Pay starts [^;]+; editing the Pickup Appointment doesn't change it\./.test(line({ _pickupArrival: { scheduled: '2026-12-07', ...f } })), line({ _pickupArrival: f }))
  }
  eq('1k days split as text: [Dec 8, Dec 7, Feb 29 2028, Feb 29 2000, Jan 1, Mar 1, Jan 3 2027]',
    ['2026-12-08', '2026-12-07', '2028-02-29', '2000-02-29', '2026-01-01', '2026-03-01', '2027-01-03'].map(c.dayLabel),
    ['Tue Dec 8', 'Mon Dec 7', 'Tue Feb 29', 'Tue Feb 29', 'Thu Jan 1', 'Sun Mar 1', 'Sun Jan 3'])
  eq('1l not a day: Feb 29 2026, Feb 29 1900, month 13, day 0, a sheet cell, a Date, null', ['2026-02-29', '1900-02-29', '2026-13-01', '2026-12-00', '12/07/2026 08:00', new Date(0), null].map(c.dayLabel), ['', '', '', '', '', '', ''])
}
wordCases(client)

// ---------------------------------------------------------------------------
console.log('§2 flag off: no key, no line')
// ---------------------------------------------------------------------------
for (const [label, env] of [['unset', {}], ['"TRUE"', { ...ON, ARRIVAL_PICKUP_DATE_ENABLED: 'TRUE' }], ['"1"', { ...ON, ARRIVAL_PICKUP_DATE_ENABLED: '1' }],
  ['on without FROM', { ARRIVAL_PICKUP_DATE_ENABLED: 'true' }], ['FROM not a day', { ...ON, ARRIVAL_PICKUP_DATE_FROM: '2026-02-30' }]]) {
  for (const [which, rows] of [['every load', ROWS()], ['open loads only', [row('L-3106', { 'Job Status': 'In Transit' }), row('L-3110', { 'Job Status': 'Dispatched' })]]]) {
    const r = annotate(server, { env, rows })
    eq(`2a ${label}, ${which}: no row gets the key, nothing is counted or logged`, [r.shown, r.rows.filter((x) => Object.hasOwn(x, '_pickupArrival')).length, r.logs.length], [0, 0, 0])
  }
}
eq('2b a row without the key shows no line', [client.pickupArrivalLine(row('L-3101')), client.pickupArrivalLine(null), client.pickupArrivalLine({ _pickupArrival: 'x' })], ['', '', ''])
for (const file of COMPONENTS) {
  const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', file), 'utf8')
  const shown = /<p v-if="(?:selectedJob && pickupArrivalLine\(selectedJob\)|pickupArrivalText)" class="pickup-arrival" role="note">\{\{ (?:pickupArrivalLine\(selectedJob\)|pickupArrivalText) \}\}<\/p>/.test(src)
  ok(`2c ${file}: one text-only line (no button, no badge), shown only when pickupArrivalLine() has words`, shown && (src.match(/class="pickup-arrival"/g) || []).length === 1)
  ok(`2d ${file}: nothing else reads the field`, !/_pickupArrival/.test(src))
}

// ---------------------------------------------------------------------------
console.log('§3 the field (lib/arrival-pickup-display.js)')
// ---------------------------------------------------------------------------
function fieldCases(lib) {
  const r = annotate(lib)
  const b = r.byId
  eq('3a L-3101, GPS: the shipper-local day, the fix\'s instant, and that instant on the business clock', b['L-3101'],
    { scheduled: '2026-12-07', day: '2026-12-08', at: '2026-12-08T14:40:00.000Z', source: 'gps', atDay: '2026-12-08', atTime: '9:40 AM EST' })
  eq('3b L-3102, his own tap at 21:30 CST: Tue Dec 8 (UTC is already Wed)', b['L-3102'],
    { scheduled: '2026-12-09', day: '2026-12-08', at: '2026-12-09T03:30:00.000Z', source: 'driver', atDay: '2026-12-08', atTime: '10:30 PM EST' })
  eq('3c L-3103, 23:20 CST: the shipper\'s Tue Dec 8, the business clock\'s Wed Dec 9', b['L-3103'],
    { scheduled: '2026-12-07', day: '2026-12-08', at: '2026-12-09T05:20:00.000Z', source: 'gps', atDay: '2026-12-09', atTime: '12:20 AM EST' })
  eq('3d no Delivered row, a percentage driver, not completed, assigned before FROM, no history: the rate con\'s date only',
    ['L-3104', 'L-3105', 'L-3106', 'L-3107', 'L-3108'].map((id) => b[id]), Array(5).fill({ scheduled: '2026-12-07' }))
  eq('3e no Pickup Appointment and no arrival: an empty field', b['L-3109'], { scheduled: '' })
  eq('3f how many rows show an arrival', r.shown, 3)
  const t = annotate(lib, { tripFrom: '2026-12' })
  eq('3g the trip work-day rule covers December: its trip days pay, so the rate con\'s date only', [t.byId['L-3101'], t.shown], [{ scheduled: '2026-12-07' }, 0])
  eq('3h ...and a trip rule from January leaves December to the arrival', annotate(lib, { tripFrom: '2027-01' }).byId['L-3101'], b['L-3101'])
  const keys = new Set(Object.values(b).flatMap((f) => Object.keys(f || {})))
  eq('3i the field\'s keys, and nothing more', [...keys].sort(), ['at', 'atDay', 'atTime', 'day', 'scheduled', 'source'])
  const text = JSON.stringify(Object.values(b))
  ok('3j no Load ID, driver name or distance in any field', !/L-31|Amy|Birch|Bo Wyn|812|640/i.test(text), text)
  const unread = annotate(lib, { db: historyDb({ columns: false }) })
  eq('3k an older database copy without the recorder\'s columns: the rate con\'s date only, and one log line', [unread.byId['L-3101'], unread.shown, unread.logs.length], [{ scheduled: '2026-12-07' }, 0, 1])
  const failing = { ...READ, scheduled: (x) => { if (x['Load ID'] === 'L-3103') throw new Error('cell unreadable'); return READ.scheduled(x) } }
  for (const [label, opts] of [['the driver directory unreadable', { payTypes: () => { throw new Error('directory unreadable') } }], ['a row that fails halfway down the list', { read: failing }]]) {
    const broken = annotate(lib, opts)
    eq(`3l ${label}: no row keeps the key, one log line`, [broken.rows.filter((x) => Object.hasOwn(x, '_pickupArrival')).length, broken.shown, broken.logs.length], [0, 0, 1])
    ok(`3m ${label}: the log line never names a load`, !/L-31/.test(broken.logs.join(' ')), broken.logs.join(' '))
  }
}
fieldCases(server)

// ---------------------------------------------------------------------------
console.log('§4 nothing computed in the browser')
// ---------------------------------------------------------------------------
const clientSrc = readText(CLIENT_LIB).replace(/^\s*\/\/.*$/gm, '')
ok('4 the client lib exists', clientSrc.trim() !== '')
ok('4a the client lib has no clock, no zone and no date parsing', !/\bDate\b|\bIntl\b|toLocale|TimezoneOffset|timeZone/.test(clientSrc))
ok('4b it reads nothing of the row but `_pickupArrival`', (clientSrc.match(/\bjob\b(?:\s*\.\s*|\s*\[)\s*[\w'"]+/g) || []).every((m) => /_pickupArrival/.test(m)), (clientSrc.match(/\bjob\b(?:\s*\.\s*|\s*\[)\s*[\w'"]+/g) || []).join(', '))
ok('4c it imports nothing', !/^\s*import\s/m.test(clientSrc))
for (const file of COMPONENTS) {
  const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', file), 'utf8')
  ok(`4d ${file}: the words come from lib/pickupArrival`, /import \{ pickupArrivalLine \} from '\.\.\/\.\.\/lib\/pickupArrival(?:\.js)?'/.test(src))
}
const probes = ZONES.map((zone) => {
  try { return execFileSync(process.execPath, [__filename, '--tz-probe'], { env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 60000 }) } catch (e) { return `probe failed: ${e.message}` }
})
ok('4e the same fields and words under TZ New York, Chicago, UTC and Manila', probes.every((p) => p === probes[0]) && /Tue Dec 8/.test(probes[0]), probes.map((p) => p.slice(0, 80)).join(' | '))
let probed = null
try { probed = JSON.parse(probes[0])[0][1] } catch { probed = null }
eq('4f ...and L-3101\'s line, as the screen shows it', probed, LINE_3101)

// ---------------------------------------------------------------------------
console.log('§5 the four components compile (the client\'s own vue/compiler-sfc)')
// ---------------------------------------------------------------------------
const sfc = createRequire(path.join(ROOT, 'client', 'package.json'))('vue/compiler-sfc')
for (const file of COMPONENTS) {
  let problem = ''
  try {
    const { descriptor, errors } = sfc.parse(readText(path.join(ROOT, 'client', 'src', 'components', file)), { filename: file })
    if (errors.length) problem = errors.map((e) => e.message).join('; ')
    else sfc.compileScript(descriptor, { id: `arrival-${path.basename(file)}`, inlineTemplate: true })
  } catch (err) {
    problem = err.message
  }
  eq(`5 ${file}: its script and template compile`, problem, '')
}

// ---------------------------------------------------------------------------
console.log('§6 mutants, each caught')
// ---------------------------------------------------------------------------
// Each mutant runs the cases it should break; it counts as caught when one fails.
async function caught(name, { file, from, to, run }) {
  const text = readText(file)
  if (!text.includes(from)) { ok(`${name}: anchor present`, false); return }
  let mod = null
  try {
    mod = file === CLIENT_LIB ? await importClient(text.replace(from, to)) : compileCjs(file, text.replace(from, to))
  } catch (e) { ok(`${name}: the mutant compiles`, false, e.message); return }
  const before = fail
  const saved = { pass, failures: failures.length }
  const log = console.log
  console.log = () => {}
  try { await run(mod) } catch { fail++ } finally { console.log = log }
  const hit = fail > before
  pass = saved.pass
  fail = before
  failures.length = saved.failures
  if (ok(`${name}: caught`, hit)) console.log(`  caught  ${name}`)
}
const S = SERVER_LIB
const C = CLIENT_LIB
const flagOffCases = async (lib) => {
  for (const rows of [ROWS(), [row('L-3106', { 'Job Status': 'In Transit' })]]) {
    const r = annotate(lib, { env: {}, rows })
    eq('m', [r.rows.filter((x) => Object.hasOwn(x, '_pickupArrival')).length, r.logs.length], [0, 0])
  }
}
await caught('M1 the flag check dropped (§2)', { file: S, from: 'if (!fromDay || !Array.isArray(rows) || !rows.length) return 0;', to: 'if (!Array.isArray(rows) || !rows.length) return 0;', run: flagOffCases })
await caught('M2 the percentage check dropped (3d)', { file: S, from: '(!own || own.payType !== "percentage") && !tripPays', to: '!tripPays', run: fieldCases })
await caught('M3 the trip-rule check dropped (3g)', { file: S, from: '&& !tripPays) answer', to: ') answer', run: fieldCases })
await caught('M4 an arrival with no delivery shown as paying (3d)', { file: S, from: 'const start = answer && arrivalPickup.isCalendarDay(answer.start) ? answer.start : "";', to: 'const start = answer && answer.arrival ? answer.arrival.day : "";', run: fieldCases })
await caught('M5 the sources swapped (3a, 3b)', { file: S, from: 'Object.freeze({ geofence: "gps", driver: "driver" })', to: 'Object.freeze({ geofence: "driver", driver: "gps" })', run: fieldCases })
await caught("M6 the business clock's day read as the UTC day (3b)", { file: S, from: 'atDay: appTime.dayInZone(at, zone)', to: 'atDay: at.toISOString().slice(0, 10)', run: fieldCases })
await caught('M7 a failure leaves the rows it reached keyed (3l)', { file: S, from: 'for (const row of rows) if (row && typeof row === "object") delete row._pickupArrival;', to: '', run: fieldCases })
await caught('M8 every row read as completed (3d, L-3106)', { file: S, from: 'if (read.completed(row)) {', to: 'if (true) {', run: fieldCases })
await caught('M9 the field carries the Load ID (3i, 3j)', { file: S, from: 'row._pickupArrival = fieldFor(answer, read.scheduled(row), zone);', to: 'row._pickupArrival = { ...fieldFor(answer, read.scheduled(row), zone), load: read.loadId(row) };', run: fieldCases })
await caught('M10 the Pickup Appointment note dropped (1a, 1j)', { file: C, from: "const PAY_NOTE = \"editing the Pickup Appointment doesn't change it.\"", to: "const PAY_NOTE = ''", run: wordCases })
await caught("M11 one clock's day assumed (1c)", { file: C, from: 'if (f.atDay === f.day) return', to: 'if (true) return', run: wordCases })
await caught('M12 any source taken as an arrival (1h)', { file: C, from: "Object.hasOwn(SOURCE_WORDS, f.source) ? SOURCE_WORDS[f.source] : ''", to: "String(f.source || '')", run: wordCases })
await caught('M13 the leap-year rule without the century (1k, 1l)', { file: C, from: '(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0', to: 'y % 4 === 0', run: wordCases })

if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
console.log(`\nThe arrival pickup display: ${pass} passed, ${fail} failed`)
if (fail) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
