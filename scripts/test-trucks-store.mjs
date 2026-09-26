#!/usr/bin/env node
// Deterministic check on the Trucks page's save flow:
//   client/src/lib/truckEdit.js   the Edit dialog's form, and the save body of
//                                 only the fields changed since it opened
//   client/src/stores/trucks.js   the list loads and the writes, driven for real
//                                 (real Pinia, real useApi, a scripted network)
//
// WHY THIS EXISTS. The Edit dialog stays open through list reloads, so a save that
// resent every field put back whatever the dialog had opened with: a driver
// reassignment, an owner change, a date or a cost that someone else saved in the
// meantime was undone, and nobody saw it happen. The dialog now sends only what
// the person changed (section 1). The store (section 2) settles a write on the
// server's answer to the write alone and re-reads the list behind it, so
// "Saving…" no longer waits on a reload that can take seconds; a failed re-read
// is not reported as a failed save; a write whose answer never came re-reads the
// list, since it may still have been made; an older list load never replaces a
// newer one, nor ends "Refreshing…" while another is running; a load from before
// the page was opened again is ignored; and a failed load keeps its reason for
// the page to show with a Retry. Section 3 runs the store scenarios against
// mutants, each a plausible regression, and every one must fail a scenario.
//
// No DOM, no server. Section 2 loads Pinia from client/node_modules (installed by
// `npm ci` at the repo root) and stubs fetch; nothing waits on a real timer.
//   node scripts/test-trucks-store.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const CLIENT_SRC = path.join(CLIENT_DIR, 'src')

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`) }
}

// ══ 1. The Edit dialog's save body ════════════════════════════════════════════
const { EDIT_FIELDS, formFromTruck, changedFields, bodyForFields, truckEditBody, changedUnderneath } =
  await import(pathToFileURL(path.join(CLIENT_SRC, 'lib', 'truckEdit.js')).href)

// A row of GET /api/trucks, with the fields the dialog does not edit as well.
const ROW = Object.freeze({
  id: 7, UnitNumber: 'TRK-91', Make: 'Volvo', Model: 'VNL 760', Year: 2022, VIN: '4V4NC9EH5NN123456', LicensePlate: 'ABC-1234',
  Status: 'Active', AssignedDriver: 'Dwayne Jones', OwnerId: 5, Notes: 'Night runs', Photo: 'data:image/jpeg;base64,/9j/4AAQ',
  InsuranceMonthly: 1200, EldMonthly: 45, TruckPaymentMonthly: 2100, HvutAnnual: 550, IrpAnnual: 1800, AdminFeePct: 50,
  DriverPayDaily: 300, PurchasePrice: 58000, TitleStatus: 'Clean', MaintenanceFundMonthly: 800, FuelTankGallons: 189, AvgMpg: 6.5,
  InServiceDate: '2026-03-01', RetiredAt: '', CreatedAt: '2026-02-11T15:04:05Z',
  LoadCount: 12, RoutemateVehicleId: 'rm-91', Odometer: 992938, OdometerAt: '2026-09-26T01:00:00Z',
})
const SUPER_ADMIN = { canEditPay: true }
const DISPATCHER = { canEditPay: false }
// The dialog opening on `row`: the baseline it keeps, and the form the inputs edit.
function open(row) {
  const baseline = Object.freeze(formFromTruck(row))
  return { baseline, form: { ...baseline } }
}
// The body Save sends after `edit` changes the form.
function bodyAfter(edit, { row = ROW, as = SUPER_ADMIN } = {}) {
  const { baseline, form } = open(row)
  edit(form)
  return truckEditBody(baseline, form, as)
}

eq('formFromTruck: what each input shows when the dialog opens',
  formFromTruck(ROW),
  {
    id: 7, unitNumber: 'TRK-91', make: 'Volvo', model: 'VNL 760', year: 2022, vin: '4V4NC9EH5NN123456', licensePlate: 'ABC-1234',
    status: 'Active', assignedDriver: 'Dwayne Jones', ownerId: 5, notes: 'Night runs', photo: 'data:image/jpeg;base64,/9j/4AAQ',
    insuranceMonthly: 1200, eldMonthly: 45, truckPaymentMonthly: 2100, hvutAnnual: 550, irpAnnual: 1800, adminFeePct: 50,
    driverPayDaily: 300, purchasePrice: 58000, titleStatus: 'Clean', maintenanceFundMonthly: 800, fuelTankGallons: 189, avgMpg: 6.5,
    inServiceDate: '2026-03-01', retiredAt: '',
  })
eq('formFromTruck: an unset truck shows blanks and the defaults (placeholders for pay and fuel, 50 for the fee)',
  formFromTruck({ id: 3, UnitNumber: 'X-3', Status: 'Inactive', Year: 0, OwnerId: 0, DriverPayDaily: 0, FuelTankGallons: 0, AvgMpg: 0 }),
  {
    id: 3, unitNumber: 'X-3', make: '', model: '', year: '', vin: '', licensePlate: '',
    status: 'Inactive', assignedDriver: '', ownerId: 0, notes: '', photo: '',
    insuranceMonthly: 0, eldMonthly: 0, truckPaymentMonthly: 0, hvutAnnual: 0, irpAnnual: 0, adminFeePct: 50,
    driverPayDaily: '', purchasePrice: 0, titleStatus: 'Clean', maintenanceFundMonthly: 0, fuelTankGallons: '', avgMpg: '',
    inServiceDate: '', retiredAt: '',
  })
eq('formFromTruck: the snake_case date spellings are read too',
  [formFromTruck({ in_service_date: '2026-01-05', retired_at: '2026-08-31' }).inServiceDate, formFromTruck({ retired_at: '2026-08-31' }).retiredAt],
  ['2026-01-05', '2026-08-31'])
eq('formFromTruck(null) is a blank form, for the dialog before it first opens', formFromTruck(null).unitNumber, '')

// ── Untouched: nothing is sent ────────────────────────────────────────────────
{
  const { baseline, form } = open(ROW)
  eq('untouched: no field has changed', changedFields(baseline, form, SUPER_ADMIN), [])
  eq('untouched: nothing is sent (Super Admin)', truckEditBody(baseline, form, SUPER_ADMIN), {})
  eq('untouched: nothing is sent (Dispatcher)', truckEditBody(baseline, form, DISPATCHER), {})
}

// ── One field: only that field, under the key(s) the dialog has always used ───
const ONE_FIELD = [
  ['notes', (f) => { f.notes = 'Day runs' }, { notes: 'Day runs' }],
  ['unit number', (f) => { f.unitNumber = 'TRK-091' }, { unitNumber: 'TRK-091' }],
  ['year', (f) => { f.year = 2023 }, { year: 2023 }],
  ['status', (f) => { f.status = 'Maintenance' }, { status: 'Maintenance' }],
  ['assigned driver', (f) => { f.assignedDriver = 'Amir S' }, { assignedDriver: 'Amir S' }],
  ['driver unassigned', (f) => { f.assignedDriver = '' }, { assignedDriver: '' }],
  ['owner', (f) => { f.ownerId = 9 }, { ownerId: 9 }],
  ['owner cleared', (f) => { f.ownerId = 0 }, { ownerId: 0 }],
  ['title status', (f) => { f.titleStatus = 'Lien' }, { titleStatus: 'Lien' }],
  ['insurance', (f) => { f.insuranceMonthly = 1500 }, { insuranceMonthly: 1500 }],
  ['insurance cleared (the server stores 0)', (f) => { f.insuranceMonthly = '' }, { insuranceMonthly: '' }],
  ['purchase price', (f) => { f.purchasePrice = 61000 }, { purchasePrice: 61000 }],
  ['admin fee', (f) => { f.adminFeePct = 40 }, { adminFeePct: 40 }],
  ['in-service date: both spellings', (f) => { f.inServiceDate = '2026-04-01' }, { in_service_date: '2026-04-01', inServiceDate: '2026-04-01' }],
  ['in-service date cleared: both spellings, as \'\'', (f) => { f.inServiceDate = '' }, { in_service_date: '', inServiceDate: '' }],
  ['retirement date: both spellings', (f) => { f.retiredAt = '2026-09-30' }, { retired_at: '2026-09-30', retiredAt: '2026-09-30' }],
  ['fuel tank: snake_case, as the dialog sends it', (f) => { f.fuelTankGallons = 203 }, { fuel_tank_gallons: 203 }],
  ['fuel tank cleared: 0, the fleet default', (f) => { f.fuelTankGallons = '' }, { fuel_tank_gallons: 0 }],
  ['average MPG: snake_case', (f) => { f.avgMpg = 7 }, { avg_mpg: 7 }],
  ['driver pay (Super Admin)', (f) => { f.driverPayDaily = 325 }, { driverPayDaily: 325 }],
  ['driver pay cleared (Super Admin): 0, the default rate', (f) => { f.driverPayDaily = '' }, { driverPayDaily: 0 }],
]
for (const [name, edit, expected] of ONE_FIELD) eq(`one edited field, ${name}: only it is sent`, bodyAfter(edit), expected)

eq('driver pay changed by a Dispatcher is never sent (the box is disabled for them)',
  bodyAfter((f) => { f.driverPayDaily = 999 }, { as: DISPATCHER }), {})
{
  const { baseline, form } = open(ROW)
  form.driverPayDaily = 999
  eq('…nor counted as a change', changedFields(baseline, form, DISPATCHER), [])
}
eq('two edits: exactly those, in the dialog\'s order',
  bodyAfter((f) => { f.inServiceDate = '2026-04-01'; f.notes = 'Day runs' }),
  { notes: 'Day runs', in_service_date: '2026-04-01', inServiceDate: '2026-04-01' })

// ── The photo: only when a new one was picked, or it was cleared ──────────────
eq('photo untouched: not sent', bodyAfter(() => {}), {})
eq('photo re-read to the same bytes: not sent', bodyAfter((f) => { f.photo = `${ROW.Photo}` }), {})
eq('a new photo: sent', bodyAfter((f) => { f.photo = 'data:image/png;base64,iVBORw0KGgo=' }), { photo: 'data:image/png;base64,iVBORw0KGgo=' })
eq('the photo cleared: sent as \'\'', bodyAfter((f) => { f.photo = '' }), { photo: '' })
eq('a first photo on a truck with none: sent',
  bodyAfter((f) => { f.photo = 'data:image/webp;base64,UklGR' }, { row: { ...ROW, Photo: '' } }), { photo: 'data:image/webp;base64,UklGR' })

// ── "Changed" is decided the way each input holds its value ───────────────────
eq('an amount cleared and typed back is no change', bodyAfter((f) => { f.insuranceMonthly = ''; f.insuranceMonthly = 1200 }), {})
eq('a number arriving as text is compared as the number', bodyAfter((f) => { f.insuranceMonthly = '1200'; f.year = '2022' }), {})
eq('clearing an amount that is 0 changes nothing (the server stores 0 for blank)',
  bodyAfter((f) => { f.eldMonthly = '' }, { row: { ...ROW, EldMonthly: 0 } }), {})
eq('clearing the admin fee at 50 changes nothing (the server stores 50 for blank)', bodyAfter((f) => { f.adminFeePct = '' }), {})
eq('clearing the admin fee at 40 is a change', bodyAfter((f) => { f.adminFeePct = '' }, { row: { ...ROW, AdminFeePct: 40 } }), { adminFeePct: '' })
eq('an unset fuel tank typed as 0 changes nothing', bodyAfter((f) => { f.fuelTankGallons = 0 }, { row: { ...ROW, FuelTankGallons: 0 } }), {})
eq('unset driver pay typed as 0 changes nothing', bodyAfter((f) => { f.driverPayDaily = 0 }, { row: { ...ROW, DriverPayDaily: 0 } }), {})
eq('a blank year typed as 0 changes nothing', bodyAfter((f) => { f.year = 0 }, { row: { ...ROW, Year: 0 } }), {})
eq('text is compared trimmed', bodyAfter((f) => { f.notes = 'Night runs '; f.unitNumber = ' TRK-91'; f.vin = `${ROW.VIN}\n` }), {})
eq('…and sent as typed once it really changed', bodyAfter((f) => { f.notes = 'Day runs ' }), { notes: 'Day runs ' })
eq('a date is compared as its text', bodyAfter((f) => { f.inServiceDate = '2026-03-01' }), {})
eq('an owner id arriving as text is compared as the id', bodyAfter((f) => { f.ownerId = '5' }), {})
{
  const { baseline, form } = open(ROW)
  form.fuelTankGallons = 'abc'
  eq('a value that is no number reads as a change, so the amount check sees it', changedFields(baseline, form, SUPER_ADMIN), ['fuelTankGallons'])
}

// ── The review's case: a colleague's newer save is kept ───────────────────────
{
  const { baseline, form } = open(ROW)
  form.notes = 'Day runs'
  // While the dialog was open, someone else reassigned the driver, moved the
  // truck to another owner, set an in-service date and raised the insurance.
  const theirs = { ...ROW, AssignedDriver: 'Amir S', OwnerId: 9, InServiceDate: '2026-02-01', InsuranceMonthly: 1500 }
  eq('their driver, owner, date and insurance are not in the save, so they stay as they saved them',
    truckEditBody(baseline, form, SUPER_ADMIN), { notes: 'Day runs' })
  eq('…and the dialog can tell those moved underneath it',
    changedUnderneath(baseline, formFromTruck(theirs), form), ['assignedDriver', 'ownerId', 'inServiceDate', 'insuranceMonthly'])
}
{
  const { baseline, form } = open(ROW)
  eq('changedUnderneath: an unchanged row moved nothing', changedUnderneath(baseline, formFromTruck(ROW), form), [])
  eq('changedUnderneath: fields the dialog does not edit (loads, odometer, ELD link) are not changes to it',
    changedUnderneath(baseline, formFromTruck({ ...ROW, LoadCount: 13, Odometer: 993100, OdometerAt: '2026-09-26T02:00:00Z', RoutemateVehicleId: '' }), form), [])
  form.insuranceMonthly = 1500
  eq('changedUnderneath: the person\'s own save coming back through a reload is not someone else\'s',
    changedUnderneath(baseline, formFromTruck({ ...ROW, InsuranceMonthly: 1500 }), form), [])
  eq('changedUnderneath: a field both changed, to different values, is',
    changedUnderneath(baseline, formFromTruck({ ...ROW, InsuranceMonthly: 1400 }), form), ['insuranceMonthly'])
  eq('changedUnderneath: driver pay counts even for a Dispatcher (the dialog shows it)',
    changedUnderneath(baseline, formFromTruck({ ...ROW, DriverPayDaily: 350 }), form), ['driverPayDaily'])
  eq('changedUnderneath: no row (deleted) or no baseline is []', [changedUnderneath(baseline, null, form), changedUnderneath(null, baseline, form)], [[], []])
}

// ── The table ─────────────────────────────────────────────────────────────────
eq('EDIT_FIELDS covers every value formFromTruck gives the dialog, once each',
  EDIT_FIELDS.map((f) => f.key).sort(), Object.keys(formFromTruck(ROW)).filter((k) => k !== 'id').sort())
eq('only driver pay waits on canEditPay', EDIT_FIELDS.filter((f) => f.pay).map((f) => f.key), ['driverPayDaily'])
ok('the table is frozen, rows and body keys included',
  Object.isFrozen(EDIT_FIELDS) && EDIT_FIELDS.every((f) => Object.isFrozen(f) && Object.isFrozen(f.body)))
eq('bodyForFields skips a key that is not a field', bodyForFields({ id: 7, notes: 'x' }, ['id', 'notes', 'nope']), { notes: 'x' })

// Every key the dialog sends is one PUT /api/trucks/:id reads. A key the server
// does not read would be dropped there, and the change it carries never saved.
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
  const start = src.indexOf('\napp.put("/api/trucks/:id"')
  const end = start < 0 ? -1 : src.indexOf('\napp.', start + 1)
  const route = start < 0 || end < 0 ? '' : src.slice(start, end)
  ok('server.js: PUT /api/trucks/:id found', route.length > 0)
  const read = new Set()
  for (const m of route.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/g)) {
    for (const name of m[1].split(',')) if (name.trim()) read.add(name.trim().split(/\s*[:=]\s*/)[0])
  }
  for (const m of route.matchAll(/req\.body\.([A-Za-z_]\w*)/g)) read.add(m[1])
  const tableAt = src.indexOf('\nconst TRUCK_AMOUNT_FIELDS = [')
  const table = tableAt < 0 ? '' : src.slice(tableAt, src.indexOf('\n];', tableAt))
  for (const m of table.matchAll(/keys:\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/"([^"]+)"/g)) read.add(k[1])
  ok('server.js: the route reads parseTruckAmounts(req.body, TRUCK_AMOUNT_FIELDS)', /parseTruckAmounts\(req\.body,\s*TRUCK_AMOUNT_FIELDS\)/.test(route))
  const sent = [...new Set(EDIT_FIELDS.flatMap((f) => f.body))]
  eq('every key the Edit dialog can send is read by PUT /api/trucks/:id', sent.filter((k) => !read.has(k)), [])
}

// The number boxes take their `max` from lib/truckAmounts.js (AMOUNT_CAPS), the
// one copy of each ceiling, never a literal that can drift from it.
for (const file of ['components/trucks/AddTruckForm.vue', 'components/trucks/TruckTable.vue']) {
  const src = fs.readFileSync(path.join(CLIENT_SRC, file), 'utf8')
  eq(`${file}: no literal max on an input`, src.match(/<input\b[^>]*\smax="[^"]*"[^>]*>/g) || [], [])
  ok(`${file}: the capped boxes bind AMOUNT_CAPS`, ['fuelTankGallons', 'avgMpg', 'driverPayDaily', 'adminFeePct'].every((k) => src.includes(`:max="AMOUNT_CAPS.${k}"`)))
}

// ══ 2. The store, end to end ══════════════════════════════════════════════════
// client/src/stores/trucks.js as committed, with the real Pinia and the real
// useApi, against a network where every request waits until the scenario
// answers it: the scenario decides the order answers come back in.
const STORE_URL = pathToFileURL(path.join(CLIENT_SRC, 'stores', 'trucks.js')).href
// The file Node resolves the store's bare `import 'pinia'` to (exports: node +
// import + default), so the test and the store share one Pinia.
const PINIA_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href

const net = { pending: [] }
globalThis.fetch = (url, opts = {}) => {
  const req = { method: opts.method || 'GET', url: String(url), body: opts.body === undefined ? undefined : JSON.parse(opts.body) }
  return new Promise((resolve, reject) => {
    req.answer = (status, json = {}) => resolve({ ok: status >= 200 && status < 300, status, json: async () => json })
    req.drop = (err) => reject(err)
    net.pending.push(req)
  })
}
// The oldest request still waiting for `method url`.
function take(method, url) {
  const i = net.pending.findIndex((r) => r.method === method && r.url === url)
  if (i < 0) throw new Error(`no ${method} ${url} is waiting (waiting: ${net.pending.map((r) => `${r.method} ${r.url}`).join(', ') || 'nothing'})`)
  return net.pending.splice(i, 1)[0]
}
const waiting = (method, url) => net.pending.filter((r) => r.method === method && r.url === url).length
// What useApi sees when its own 20 s timer aborts the request (it turns this
// into code TIMEOUT), and when the connection drops.
const timedOut = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
const offline = () => new TypeError('Failed to fetch')
// Real setImmediate: one turn flushes every pending promise job.
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}
function track(promise) {
  const t = { done: false, value: undefined, error: undefined }
  promise.then((v) => { t.done = true; t.value = v }, (e) => { t.done = true; t.error = e })
  return t
}

const LIST_A = [{ id: 1, UnitNumber: 'A-1' }]
const LIST_B = [{ id: 1, UnitNumber: 'A-1' }, { id: 2, UnitNumber: 'B-2' }]

// The page open with LIST_A on screen.
async function opened(s) {
  s.resetList()
  track(s.loadTrucks())
  take('GET', '/api/trucks').answer(200, { trucks: LIST_A })
  await drain()
}

const STORE_SCENARIOS = [
  ['a load started before resetList() is ignored', async (c, s) => {
    const early = track(s.loadTrucks())
    s.resetList()
    const fresh = track(s.loadTrucks())
    take('GET', '/api/trucks').answer(200, { trucks: LIST_B })
    await drain()
    c.expect('its list is not shown', s.trucks.length === 0 && !s.hasLoaded)
    c.expect('"Refreshing…" is still owed to the load started since', s.isLoading)
    take('GET', '/api/trucks').answer(200, { trucks: LIST_A })
    await drain()
    c.expect('the load started since is the one shown', s.hasLoaded && s.trucks.length === 1 && !s.isLoading)
    c.expect('both calls resolved', early.done && !early.error && fresh.done && !fresh.error)
  }],
  ['a load from before resetList() that fails is not this visit\'s error', async (c, s) => {
    const early = track(s.loadTrucks())
    s.resetList()
    take('GET', '/api/trucks').answer(500, { error: 'Database is locked' })
    await drain()
    c.expect('no loadError, not loading, nothing shown', s.loadError === '' && !s.isLoading && !s.hasLoaded)
    c.expect('the call itself still rejected', early.done && early.error?.message === 'Database is locked')
  }],
  ['an older load coming back after a newer one does not replace its list', async (c, s) => {
    s.resetList()
    track(s.loadTrucks())
    track(s.loadTrucks())
    const older = take('GET', '/api/trucks')
    const newer = take('GET', '/api/trucks')
    newer.answer(200, { trucks: LIST_B })
    await drain()
    c.expect('the newer list is shown', s.trucks.length === 2 && s.hasLoaded)
    c.expect('"Refreshing…" stays while the older load is out', s.isLoading)
    older.answer(200, { trucks: LIST_A })
    await drain()
    c.expect('the older list does not replace it', s.trucks.length === 2)
    c.expect('"Refreshing…" ends once both are back', !s.isLoading)
  }],
  ['one load coming back does not end "Refreshing…" while another is running', async (c, s) => {
    s.resetList()
    track(s.loadTrucks())
    track(s.loadTrucks())
    take('GET', '/api/trucks').answer(200, { trucks: LIST_A })
    await drain()
    c.expect('the first list is shown', s.trucks.length === 1 && s.hasLoaded)
    c.expect('still refreshing: the second load is running', s.isLoading)
    take('GET', '/api/trucks').answer(200, { trucks: LIST_B })
    await drain()
    c.expect('the newer list replaces it and "Refreshing…" ends', s.trucks.length === 2 && !s.isLoading)
  }],
  ['an older load\'s failure is not shown while a newer load is running', async (c, s) => {
    s.resetList()
    track(s.loadTrucks())
    track(s.loadTrucks())
    take('GET', '/api/trucks').answer(500, { error: 'Database is locked' })
    await drain()
    c.expect('no loadError yet: the newer load decides', s.loadError === '' && s.isLoading)
    take('GET', '/api/trucks').answer(200, { trucks: LIST_A })
    await drain()
    c.expect('the newer load\'s list is shown, with no error', s.hasLoaded && s.trucks.length === 1 && s.loadError === '')
  }],
  ['a failed first load sets loadError; a Retry that succeeds clears it', async (c, s) => {
    s.resetList()
    const first = track(s.loadTrucks())
    take('GET', '/api/trucks').answer(500, { error: 'Database is locked' })
    await drain()
    c.expect('loadTrucks() rejects with the reason', first.done && first.error?.message === 'Database is locked')
    c.expect('loadError holds it', s.loadError === 'Database is locked')
    c.expect('not loaded: the page shows the error, not an empty fleet', !s.hasLoaded && s.trucks.length === 0 && !s.isLoading)
    const retry = track(s.refreshList())
    c.expect('the Retry is running', s.isLoading)
    take('GET', '/api/trucks').answer(200, { trucks: LIST_A })
    await drain()
    c.expect('refreshList() resolved', retry.done && !retry.error)
    c.expect('loaded, and the error is gone', s.hasLoaded && s.trucks.length === 1 && s.loadError === '')
  }],
  ['refreshList() never rejects, and keeps the failure in loadError', async (c, s) => {
    s.resetList()
    const r = track(s.refreshList())
    take('GET', '/api/trucks').drop(offline())
    await drain()
    c.expect('it resolved', r.done && !r.error)
    c.expect('loadError holds the failure', s.loadError === 'Failed to fetch' && !s.hasLoaded)
  }],
  ['add resolves once the server accepts it, without waiting for the reload, which then fails', async (c, s) => {
    await opened(s)
    const add = track(s.addTruck({ unitNumber: 'B-2' }))
    const post = take('POST', '/api/trucks')
    c.expect('the add sends the form\'s body', post.body?.unitNumber === 'B-2')
    post.answer(200, { success: true, id: 2 })
    await drain()
    c.expect('the add resolved with the server\'s answer', add.done && !add.error && add.value?.id === 2)
    c.expect('…while the reload is still waiting for the server', waiting('GET', '/api/trucks') === 1 && s.isLoading)
    take('GET', '/api/trucks').answer(500, { error: 'Database is locked' })
    await drain()
    c.expect('the failed reload shows as loadError, not as a failed add', s.loadError === 'Database is locked' && !add.error)
    c.expect('the list on screen stays', s.hasLoaded && s.trucks.length === 1 && !s.isLoading)
  }],
  ['update resolves once the server accepts it, without waiting for the reload, which then fails', async (c, s) => {
    await opened(s)
    const upd = track(s.updateTruck(1, { notes: 'Day runs' }))
    const put = take('PUT', '/api/trucks/1')
    c.expect('the update sends exactly the body it was given', JSON.stringify(put.body) === '{"notes":"Day runs"}')
    put.answer(200, { success: true })
    await drain()
    c.expect('the update resolved', upd.done && !upd.error)
    c.expect('…while the reload is still waiting for the server', waiting('GET', '/api/trucks') === 1)
    take('GET', '/api/trucks').drop(offline())
    await drain()
    c.expect('the failed reload is loadError, and the update stays resolved', s.loadError === 'Failed to fetch' && !upd.error)
  }],
  ['delete resolves once the server accepts it; the list follows', async (c, s) => {
    await opened(s)
    const del = track(s.deleteTruck(1))
    take('DELETE', '/api/trucks/1').answer(200, { success: true })
    await drain()
    c.expect('the delete resolved', del.done && !del.error)
    take('GET', '/api/trucks').answer(200, { trucks: [] })
    await drain()
    c.expect('the reload shows the truck gone', s.trucks.length === 0 && s.hasLoaded && !s.isLoading)
  }],
  ['a refused write rejects with the server\'s message, and re-reads nothing', async (c, s) => {
    await opened(s)
    const add = track(s.addTruck({ unitNumber: 'A-1' }))
    take('POST', '/api/trucks').answer(400, { error: 'Unit number already exists' })
    await drain()
    c.expect('add rejects with the server\'s message', add.done && add.error?.message === 'Unit number already exists')
    const upd = track(s.updateTruck(1, { retired_at: '2026-01-31', retiredAt: '2026-01-31' }))
    take('PUT', '/api/trucks/1').answer(409, { error: 'Cannot apply this change to A-1', code: 'PERIOD_LOCKED' })
    await drain()
    c.expect('update rejects with the server\'s message and code',
      upd.done && upd.error?.message === 'Cannot apply this change to A-1' && upd.error?.code === 'PERIOD_LOCKED')
    const del = track(s.deleteTruck(1))
    take('DELETE', '/api/trucks/1').answer(409, { error: 'Cannot delete A-1: it still has 1 trailer.' })
    await drain()
    c.expect('delete rejects with the server\'s message', del.done && del.error?.message === 'Cannot delete A-1: it still has 1 trailer.')
    c.expect('no reload after a refusal: nothing changed', waiting('GET', '/api/trucks') === 0 && !s.isLoading)
  }],
  ['an add that timed out rejects as TIMEOUT and re-reads the list: it may have been made', async (c, s) => {
    await opened(s)
    const add = track(s.addTruck({ unitNumber: 'B-2' }))
    take('POST', '/api/trucks').drop(timedOut())
    await drain()
    c.expect('the add rejects with code TIMEOUT', add.done && add.error?.code === 'TIMEOUT')
    c.expect('the list is re-read', waiting('GET', '/api/trucks') === 1)
    take('GET', '/api/trucks').answer(200, { trucks: LIST_B })
    await drain()
    c.expect('…and shows the truck the server did add', s.trucks.length === 2)
  }],
  ['an update whose connection dropped re-reads the list too', async (c, s) => {
    await opened(s)
    const upd = track(s.updateTruck(1, { notes: 'Day runs' }))
    take('PUT', '/api/trucks/1').drop(offline())
    await drain()
    c.expect('the update rejects', upd.done && !!upd.error)
    c.expect('the list is re-read', waiting('GET', '/api/trucks') === 1)
  }],
  ['resetList() empties the driver and investor lists, and ignores their late answers', async (c, s) => {
    s.resetList()
    track(s.loadDriverNames())
    track(s.loadInvestorUsers())
    take('GET', '/api/drivers-directory').answer(200, { headers: ['Driver'], data: [{ Driver: 'Dwayne Jones' }] })
    take('GET', '/api/users/investors').answer(200, { investors: [{ id: 5, username: 'inv5' }] })
    await drain()
    c.expect('both lists loaded', s.driverNames.length === 1 && s.investorUsers.length === 1)
    track(s.loadDriverNames())
    track(s.loadInvestorUsers())
    s.resetList()
    c.expect('resetList() empties both', s.driverNames.length === 0 && s.investorUsers.length === 0)
    take('GET', '/api/drivers-directory').answer(200, { headers: ['Driver'], data: [{ Driver: 'Amir S' }] })
    take('GET', '/api/users/investors').answer(200, { investors: [{ id: 9, username: 'inv9' }] })
    await drain()
    c.expect('answers to loads from before resetList() are ignored', s.driverNames.length === 0 && s.investorUsers.length === 0)
  }],
  ['an older driver-list answer does not replace a newer one', async (c, s) => {
    s.resetList()
    track(s.loadDriverNames())
    track(s.loadDriverNames())
    const older = take('GET', '/api/drivers-directory')
    take('GET', '/api/drivers-directory').answer(200, { headers: ['Driver'], data: [{ Driver: 'Amir S' }, { Driver: 'Dwayne Jones' }] })
    await drain()
    older.answer(200, { headers: ['Driver'], data: [{ Driver: 'Dwayne Jones' }] })
    await drain()
    c.expect('the newer list stays', s.driverNames.join('|') === 'Amir S|Dwayne Jones')
  }],
]

// Runs every scenario on a fresh store instance from `source(n)`; one result per
// expectation. Leftover requests are dropped between scenarios so none can be
// answered by the next one.
async function runStoreScenarios(source) {
  const results = []
  for (const [name, scenario] of STORE_SCENARIOS) {
    const mod = await import(source(++loadSeq))
    const store = mod.useTrucksStore(piniaModule.createPinia())
    const c = { expect: (label, cond) => results.push({ ok: !!cond, label: `${name}: ${label}` }) }
    try {
      await scenario(c, store)
    } catch (err) {
      results.push({ ok: false, label: `${name}: threw ${err.message}` })
    }
    for (const req of net.pending.splice(0)) req.drop(offline())
    await drain()
  }
  return results
}

let loadSeq = 0
let piniaModule = null
const unhandled = []
process.on('unhandledRejection', (err) => unhandled.push(err))
// The store logs every failed load (refreshList) — expected here, not noise.
const logged = []
const realConsoleError = console.error
const quiet = async (fn) => {
  console.error = (...args) => logged.push(args)
  try { return await fn() } finally { console.error = realConsoleError }
}

try {
  piniaModule = await import(PINIA_URL)
} catch (err) {
  ok(`section 2 cannot load Pinia from client/node_modules (${err.code || err.message}); install the client dependencies`, false)
}

// ══ 3. Mutants: the scenarios must be able to fail ════════════════════════════
// Each is the store with one plausible regression. The source is loaded as a
// data: module with its imports pointed back at the real files.
const STORE_SRC = fs.readFileSync(fileURLToPath(STORE_URL), 'utf8')
function asDataModule(src) {
  let unresolved = null
  const out = src.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    if (spec === 'pinia') return pre + q + PINIA_URL + q
    if (spec.startsWith('./') || spec.startsWith('../')) return pre + q + new URL(spec, STORE_URL).href + q
    unresolved = spec
    return m
  })
  if (unresolved) return null
  return (n) => 'data:text/javascript;base64,' + Buffer.from(`${out}\n// load ${n}\n`, 'utf8').toString('base64')
}
function replaceOnce(src, from, to) {
  return src.split(from).length === 2 ? src.replace(from, () => to) : null
}
const STORE_MUTANTS = [
  ['every answer is shown, the newest or not', (s) => replaceOnce(s, 'if (truckLoads.claim(ticket)) {', 'if (true) {')],
  ['resetList() forgets no truck load', (s) => replaceOnce(s, '      truckLoads.forget()\n', '')],
  ['resetList() leaves the driver and investor lists', (s) => replaceOnce(s, '      this.driverNames = []\n      this.investorUsers = []\n', '')],
  ['a write waits for the reload (the pre-review flow)', (s) => replaceOnce(s, '  store.refreshList()\n  return result', '  await store.refreshList()\n  return result')],
  ['a failed reload fails the write', (s) => replaceOnce(s, '  store.refreshList()\n  return result', '  await store.loadTrucks()\n  return result')],
  ['a lost answer re-reads nothing', (s) => replaceOnce(s, '    if (replyLost(err)) store.refreshList()\n', '')],
  ['a refused write re-reads the list anyway', (s) => replaceOnce(s, 'if (replyLost(err)) store.refreshList()', 'store.refreshList()')],
  ['a failed load leaves no loadError', (s) => replaceOnce(s, 'if (truckLoads.isLatest(ticket)) this.loadError =', 'if (false) this.loadError =')],
  ['any failed load shows, older or not', (s) => replaceOnce(s, 'if (truckLoads.isLatest(ticket)) this.loadError =', 'this.loadError =')],
  ['any load coming back ends "Refreshing…"', (s) => replaceOnce(s, 'if (running.delete(ticket)) this.isLoading = running.size > 0', 'running.delete(ticket); this.isLoading = false')],
  ['a failed first load counts as loaded (the empty-fleet look)', (s) => replaceOnce(s, '      } finally {\n        if (running.delete(ticket))', '      } finally {\n        this.hasLoaded = true\n        if (running.delete(ticket))')],
  ['the driver list shows any answer', (s) => replaceOnce(s, 'if (!driverLoads.claim(ticket)) return', '')],
]

if (piniaModule) {
  await quiet(async () => {
    for (const r of await runStoreScenarios((n) => `${STORE_URL}?load=${n}`)) ok(r.label, r.ok)
  })
  eq('no unhandled promise rejection from the store', unhandled.map((e) => String(e?.message || e)), [])

  const control = asDataModule(STORE_SRC)
  const controlResults = control ? await quiet(() => runStoreScenarios(control)) : [{ ok: false }]
  ok('mutants: the UNMUTATED store also passes when loaded the mutant way, so a caught mutant means something',
    controlResults.every((r) => r.ok))
  for (const [name, mutate] of STORE_MUTANTS) {
    const mutated = mutate(STORE_SRC)
    const source = mutated && mutated !== STORE_SRC ? asDataModule(mutated) : null
    if (!source) {
      ok(`store mutant could not be built: ${name} — its target text is gone from stores/trucks.js; update the mutant with the store`, false)
      continue
    }
    const results = await quiet(() => runStoreScenarios(source))
    ok(`store mutant survived: ${name} — no store scenario noticed it`, results.some((r) => !r.ok))
  }
}

console.log(`\ntrucks-store: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
