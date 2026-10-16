#!/usr/bin/env node
// The client side of the R11 follow-up: staff full edit and the driver's own
// "My time off" screen (client/src/lib/availabilityText.js, the panel, the card).
//
// The server owns every rule. Each row of GET /api/drivers-directory/:id/availability
// carries `editable` ("full" / "end_early" / "none") and `limits`
// ({ fromMin, toMin, toMax }, null = no limit); the reply carries `createLimits`.
// The client only applies what it is sent: the one thing it adds is that the
// last day off is never before the form's own first day. An edit sends only
// the fields that changed.
//
// The driver's rows ride on GET /api/driver/:driverName as
// `timeOff: { today, rows: [{ id, kind, from, to, status }] }`, only while the
// server's DRIVER_TIME_OFF_SCREEN_ENABLED is on. The card lists current and
// upcoming rows (dates, kind, "Off now" / "Upcoming") and nothing else, whatever
// extra fields arrive; the Loads banner shows while he is off and in the 7 days
// before a row starts. Dates are calendar days compared as text: the same words
// in every viewer zone.
//
//   §1 rowActions(): which buttons a row gets, from `editable` only
//   §2 editPatch(): only the changed fields; an end-only edit is exactly { to }
//   §3 editDateBounds() / createDateBounds(): the server's limits, plus "not
//      before the form's first day"
//   §4 canSaveEdit() / datesWithinBounds(): Save only for a change inside them
//   §5 editFormFor(): the form starts from the stored row; End early starts at
//      today, kept inside the server's limits
//   §6 driverTimeOffRows(): current and upcoming only, five fields only
//   §7 driverTimeOffBanner(): off now; coming up within 7 days; month, year
//      and leap-day edges
//   §8 the same answers under every viewer zone
//   §9 the source: no zone-dependent Date in the text lib, the panel or the
//      card; the card never names the fields it must not show; DriverView
//      renders the card and the banner only when the payload carried `timeOff`
//
// No DOM, no server. Files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-availability-edit-form.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.LOGISX_ROOT || HERE

let pass = 0
const failures = []
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  failures.push(`${name} — expected ${e}, got ${a}`)
  console.log(`  FAIL  ${name} — expected ${e}, got ${a}`)
}

let text = null
try {
  text = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'availabilityText.js')).href)
} catch {
  text = null
}
eq('§0 client/src/lib/availabilityText.js loads', !!text, true)
const T = text || {}
const NEW_EXPORTS = ['rowActions', 'editPatch', 'editDateBounds', 'createDateBounds', 'datesWithinBounds', 'canSaveEdit', 'editFormFor', 'driverTimeOffRows', 'driverTimeOffBanner']
for (const name of NEW_EXPORTS) eq(`§0 availabilityText.js exports ${name}()`, typeof T[name], 'function')
const call = (name, ...args) => (typeof T[name] === 'function' ? T[name](...args) : undefined)

// Made-up rows, as the staff GET will send them (today 2026-10-16).
const TODAY = '2026-10-16'
const stored = (over) => ({
  id: 7, directoryId: 3, kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family',
  createdBy: 'dispatch_demo', createdAt: '2026-10-01T14:00:00Z', updatedAt: null, cancelledAt: null, cancelledBy: null,
  status: 'current', editable: 'full', limits: { fromMin: null, toMin: null, toMax: null }, ...over,
})
const formOf = (r, over) => ({ kind: r.kind, from: r.from, to: r.to, reason: r.reason, ...over })
// A Super Admin's row, a Dispatcher's recent row, a Dispatcher's old live row
// (end early only) and a Dispatcher's old ended row.
const SA = stored({})
const DISP = stored({ limits: { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null } })
const OLD = stored({ id: 8, from: '2026-09-01', to: '2026-10-20', limits: { fromMin: null, toMin: '2026-10-15', toMax: '2026-10-19' }, editable: 'end_early' })
const ENDED = stored({ id: 9, from: '2026-08-20', to: '2026-09-05', status: 'past', editable: 'none', limits: null })

function scenario() {
  const out = []
  const rec = (name, actual, expected) => { eq(name, actual, expected); out.push(JSON.stringify(actual)) }

  // §1 the buttons a row gets come from `editable` alone.
  rec('§1 "full": Edit and Cancel', call('rowActions', SA), { edit: true, endEarly: false, cancel: true })
  rec('§1 "end_early": End early only, no Cancel', call('rowActions', OLD), { edit: false, endEarly: true, cancel: false })
  rec('§1 "none": no buttons', call('rowActions', ENDED), { edit: false, endEarly: false, cancel: false })
  rec('§1 no `editable` sent: no buttons', call('rowActions', stored({ editable: undefined })), { edit: false, endEarly: false, cancel: false })
  rec('§1 an unknown `editable`: no buttons', call('rowActions', stored({ editable: 'yes' })), { edit: false, endEarly: false, cancel: false })
  rec('§1 no row: no buttons', call('rowActions', null), { edit: false, endEarly: false, cancel: false })

  // §2 only the fields that changed.
  rec('§2 nothing changed: empty', call('editPatch', SA, formOf(SA)), {})
  rec('§2 an end-only edit is exactly { to }', call('editPatch', SA, formOf(SA, { to: '2026-10-18' })), { to: '2026-10-18' })
  rec('§2 kind only', call('editPatch', SA, formOf(SA, { kind: 'off_duty' })), { kind: 'off_duty' })
  rec('§2 first day only', call('editPatch', SA, formOf(SA, { from: '2026-10-12' })), { from: '2026-10-12' })
  rec('§2 reason changed, sent trimmed', call('editPatch', SA, formOf(SA, { reason: '  Family trip ' })), { reason: 'Family trip' })
  rec('§2 reason with only edge spaces added: unchanged', call('editPatch', SA, formOf(SA, { reason: ' Family ' })), {})
  rec('§2 reason cleared', call('editPatch', SA, formOf(SA, { reason: '' })), { reason: '' })
  rec('§2 a stored null reason and an empty field: unchanged', call('editPatch', stored({ reason: null }), formOf(stored({ reason: null }), { reason: '' })), {})
  rec('§2 all four changed', call('editPatch', SA, { kind: 'other', from: '2026-10-11', to: '2026-10-19', reason: 'Move' }), { kind: 'other', from: '2026-10-11', to: '2026-10-19', reason: 'Move' })
  rec('§2 "end_early" sends only { to }, whatever else the form holds', call('editPatch', OLD, formOf(OLD, { kind: 'other', from: '2026-10-01', reason: 'x', to: '2026-10-17' })), { to: '2026-10-17' })
  rec('§2 "end_early" with the end unchanged: empty', call('editPatch', OLD, formOf(OLD)), {})
  rec('§2 "none": empty', call('editPatch', ENDED, formOf(ENDED, { to: '2026-09-01' })), {})
  rec('§2 no `editable`: empty', call('editPatch', stored({ editable: undefined }), formOf(SA, { to: '2026-10-18' })), {})

  // §3 the date limits a form shows.
  rec('§3 Super Admin: no limit but "not before the first day"', call('editDateBounds', SA, formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null })
  rec('§3 Super Admin: the first day moved later moves the end\'s minimum', call('editDateBounds', SA, formOf(SA, { from: '2026-10-14' })), { fromMin: null, toMin: '2026-10-14', toMax: null })
  rec('§3 Dispatcher recent row: the server\'s limits', call('editDateBounds', DISP, formOf(DISP)), { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null })
  rec('§3 Dispatcher recent row: a later first day wins over toMin', call('editDateBounds', DISP, formOf(DISP, { from: '2026-10-18' })), { fromMin: '2026-09-16', toMin: '2026-10-18', toMax: null })
  rec('§3 "end_early": the stored first day, the server\'s end limits', call('editDateBounds', OLD, formOf(OLD, { from: '2026-10-18' })), { fromMin: null, toMin: '2026-10-15', toMax: '2026-10-19' })
  rec('§3 "none": no form', call('editDateBounds', ENDED, formOf(ENDED)), null)
  rec('§3 no limits sent: only "not before the first day"', call('editDateBounds', stored({ limits: undefined }), formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null })
  rec('§3 an unreadable limit is ignored', call('editDateBounds', stored({ limits: { fromMin: '2026-9-1', toMin: 'soon', toMax: 5 } }), formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null })
  rec('§3 an empty first day: the server\'s toMin alone', call('editDateBounds', DISP, formOf(DISP, { from: '' })), { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null })
  rec('§3 create, Dispatcher', call('createDateBounds', { fromMin: '2026-09-16', toMin: null }, { from: '2026-10-16', to: '2026-10-16' }), { fromMin: '2026-09-16', toMin: '2026-10-16', toMax: null })
  rec('§3 create, Super Admin', call('createDateBounds', { fromMin: null, toMin: null }, { from: '2026-01-02', to: '2026-01-03' }), { fromMin: null, toMin: '2026-01-02', toMax: null })
  rec('§3 create, no createLimits sent', call('createDateBounds', undefined, { from: '2026-10-16', to: '' }), { fromMin: null, toMin: '2026-10-16', toMax: null })

  // §4 Save only for a change that sits inside the limits.
  rec('§4 unchanged: no Save', call('canSaveEdit', DISP, formOf(DISP)), false)
  rec('§4 kind changed: Save', call('canSaveEdit', DISP, formOf(DISP, { kind: 'other' })), true)
  rec('§4 end moved to toMin: Save', call('canSaveEdit', DISP, formOf(DISP, { to: '2026-10-15' })), true)
  rec('§4 end moved before toMin: no Save', call('canSaveEdit', DISP, formOf(DISP, { to: '2026-10-14' })), false)
  rec('§4 first day before fromMin: no Save', call('canSaveEdit', DISP, formOf(DISP, { from: '2026-09-15' })), false)
  rec('§4 first day at fromMin: Save', call('canSaveEdit', DISP, formOf(DISP, { from: '2026-09-16' })), true)
  rec('§4 end before the first day: no Save', call('canSaveEdit', SA, formOf(SA, { from: '2026-10-20', to: '2026-10-19' })), false)
  rec('§4 a cleared date: no Save', call('canSaveEdit', SA, formOf(SA, { to: '' })), false)
  rec('§4 "end_early" inside toMin..toMax: Save', call('canSaveEdit', OLD, formOf(OLD, { to: '2026-10-19' })), true)
  rec('§4 "end_early" at the stored end: no Save', call('canSaveEdit', OLD, formOf(OLD)), false)
  rec('§4 "end_early" after toMax: no Save', call('canSaveEdit', OLD, formOf(OLD, { to: '2026-10-21' })), false)
  rec('§4 "end_early" before toMin: no Save', call('canSaveEdit', OLD, formOf(OLD, { to: '2026-10-14' })), false)
  rec('§4 "none": no Save', call('canSaveEdit', ENDED, formOf(ENDED, { to: '2026-09-04' })), false)
  rec('§4 create inside its bounds', call('datesWithinBounds', { from: '2026-09-16', to: '2026-09-20' }, { fromMin: '2026-09-16', toMin: '2026-09-16', toMax: null }), true)
  rec('§4 create before fromMin', call('datesWithinBounds', { from: '2026-09-15', to: '2026-09-20' }, { fromMin: '2026-09-16', toMin: '2026-09-15', toMax: null }), false)
  rec('§4 no bounds: no Save', call('datesWithinBounds', { from: '2026-09-15', to: '2026-09-20' }, null), false)

  // §5 where the form starts.
  rec('§5 "full" starts from the stored row', call('editFormFor', DISP, TODAY), { kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family' })
  rec('§5 a stored null reason starts empty', call('editFormFor', stored({ reason: null }), TODAY)?.reason, '')
  rec('§5 "end_early" starts at today when the limits allow it', call('editFormFor', OLD, TODAY)?.to, '2026-10-16')
  rec('§5 "end_early" ending today starts at its latest allowed end', call('editFormFor', stored({ from: '2026-09-01', to: '2026-10-16', editable: 'end_early', limits: { fromMin: null, toMin: '2026-10-15', toMax: '2026-10-15' } }), TODAY)?.to, '2026-10-15')
  rec('§5 "end_early" with no readable today keeps the stored end', call('editFormFor', OLD, '')?.to, '2026-10-20')

  // §6 the driver's card: current and upcoming rows, five fields, by first day.
  const sent = [
    { id: 4, kind: 'other', from: '2026-10-21', to: '2026-10-23', status: 'upcoming', reason: 'Clinic visit', createdBy: 'dispatch_demo', directoryId: 3 },
    { id: 2, kind: 'vacation', from: '2026-10-14', to: '2026-10-20', status: 'current', reason: 'Family', createdAt: '2026-10-01T14:00:00Z' },
    { id: 1, kind: 'vacation', from: '2026-09-01', to: '2026-09-05', status: 'past' },
    { id: 3, kind: 'off_duty', from: '2026-10-15', to: '2026-10-16', status: 'cancelled', cancelledBy: 'dispatch_demo' },
    { id: 5, kind: 'other', from: '2026-10-30', to: 'soon', status: 'upcoming' },
  ]
  rec('§6 current and upcoming only, sorted, five fields', call('driverTimeOffRows', sent), [
    { id: 2, kind: 'vacation', from: '2026-10-14', to: '2026-10-20', status: 'current' },
    { id: 4, kind: 'other', from: '2026-10-21', to: '2026-10-23', status: 'upcoming' },
  ])
  rec('§6 no rows sent', call('driverTimeOffRows', undefined), [])
  rec('§6 not a list', call('driverTimeOffRows', { rows: [] }), [])
  rec('§6 a blank entry is skipped', call('driverTimeOffRows', [null, 'x', { id: 6, kind: 'vacation', from: '2026-10-18', to: '2026-10-18', status: 'upcoming' }]), [{ id: 6, kind: 'vacation', from: '2026-10-18', to: '2026-10-18', status: 'upcoming' }])

  // §7 the Loads banner.
  const row = (from, to, kind = 'vacation', status = 'upcoming') => ({ id: from, kind, from, to, status })
  rec('§7 off now', call('driverTimeOffBanner', sent, TODAY), 'You\'re marked off Oct 14 – Oct 20 (Vacation).')
  rec('§7 off now beats coming up', call('driverTimeOffBanner', [row('2026-10-17', '2026-10-18'), row('2026-10-16', '2026-10-16', 'off_duty', 'current')], TODAY), 'You\'re marked off Oct 16 (Off duty).')
  rec('§7 coming up tomorrow', call('driverTimeOffBanner', [row('2026-10-17', '2026-10-19')], TODAY), 'Time off coming up: Oct 17 – Oct 19.')
  rec('§7 coming up in exactly 7 days', call('driverTimeOffBanner', [row('2026-10-23', '2026-10-24')], TODAY), 'Time off coming up: Oct 23 – Oct 24.')
  rec('§7 8 days ahead: no banner', call('driverTimeOffBanner', [row('2026-10-24', '2026-10-25')], TODAY), '')
  rec('§7 the nearest of two coming up', call('driverTimeOffBanner', [row('2026-10-22', '2026-10-22'), row('2026-10-18', '2026-10-19')], TODAY), 'Time off coming up: Oct 18 – Oct 19.')
  rec('§7 across a month end, 7 days', call('driverTimeOffBanner', [row('2026-11-04', '2026-11-06')], '2026-10-28'), 'Time off coming up: Nov 4 – Nov 6.')
  rec('§7 across a month end, 8 days', call('driverTimeOffBanner', [row('2026-11-05', '2026-11-06')], '2026-10-28'), '')
  rec('§7 across a year end, coming up', call('driverTimeOffBanner', [row('2027-01-04', '2027-01-06')], '2026-12-28'), 'Time off coming up: Jan 4 – Jan 6.')
  rec('§7 across a year end, off now', call('driverTimeOffBanner', [row('2026-12-28', '2027-01-03', 'off_duty', 'current')], '2026-12-31'), 'You\'re marked off Dec 28, 2026 – Jan 3, 2027 (Off duty).')
  rec('§7 a leap February, 7 days', call('driverTimeOffBanner', [row('2028-03-04', '2028-03-05')], '2028-02-26'), 'Time off coming up: Mar 4 – Mar 5.')
  rec('§7 a leap February, 8 days', call('driverTimeOffBanner', [row('2028-03-05', '2028-03-05')], '2028-02-26'), '')
  rec('§7 a common February, 7 days', call('driverTimeOffBanner', [row('2027-03-05', '2027-03-05')], '2027-02-26'), 'Time off coming up: Mar 5.')
  rec('§7 a cancelled row over today: no banner', call('driverTimeOffBanner', [row('2026-10-15', '2026-10-17', 'vacation', 'cancelled')], TODAY), '')
  rec('§7 a past row: no banner', call('driverTimeOffBanner', [row('2026-10-01', '2026-10-15', 'vacation', 'past')], TODAY), '')
  rec('§7 no rows: no banner', call('driverTimeOffBanner', [], TODAY), '')
  rec('§7 no readable today: no banner', call('driverTimeOffBanner', sent, ''), '')
  const withExtras = call('driverTimeOffBanner', [{ ...row('2026-10-15', '2026-10-18', 'other', 'current'), reason: 'Clinic visit', createdBy: 'dispatch_demo' }], TODAY)
  rec('§7 the banner never carries the reason or the author', [/Clinic|dispatch_demo/.test(String(withExtras)), withExtras], [false, 'You\'re marked off Oct 15 – Oct 18 (Other).'])
  return out.join('|')
}

// §8 the same answers whatever zone the phone or the dispatcher's browser is in.
const ZONES = ['America/New_York', 'Pacific/Honolulu', 'Asia/Manila', 'UTC', 'Pacific/Kiritimati', 'Etc/GMT+12']
const seen = new Set()
for (const zone of ZONES) {
  process.env.TZ = zone
  seen.add(scenario())
}
eq('§8 every viewer zone gives the same answers', seen.size, 1)

// §9 the source.
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch { return null } }
const ZONED_DATE = /new Date\(|Date\.parse|Date\.now|toLocale|getTimezoneOffset|\.get(?:Full)?(?:Year|Month|Date|Day|Hours)\(/
const lib = read('client/src/lib/availabilityText.js')
eq('§9 availabilityText.js uses no zone-dependent Date', !!lib && !ZONED_DATE.test(lib), true)

const card = read('client/src/components/driver/DriverTimeOffCard.vue')
eq('§9 DriverTimeOffCard.vue exists', !!card, true)
eq('§9 the card uses no zone-dependent Date', !!card && !ZONED_DATE.test(card), true)
eq('§9 the card never names a reason, an author or a cancelled row', !!card && !/reason|created|cancel|directoryId/i.test(card), true)
eq('§9 the card lists rows through driverTimeOffRows()', !!card && /driverTimeOffRows\(/.test(card), true)
eq('§9 the banner text comes from driverTimeOffBanner()', !!card && /driverTimeOffBanner\(/.test(card), true)

const view = read('client/src/views/DriverView.vue') || ''
const cardTags = view.match(/<DriverTimeOffCard\b[^>]*>/g) || []
eq('§9 DriverView renders the card and the banner', cardTags.length, 2)
eq('§9 each renders only when the payload carried `timeOff`', cardTags.every((t) => /v-if="driverStore\.timeOff"/.test(t)), true)
eq('§9 one of them is the banner', cardTags.filter((t) => /variant="banner"/.test(t)).length, 1)

const store = read('client/src/stores/driver.js') || ''
eq('§9 the store starts with no time off', /\btimeOff: null,/.test(store), true)
eq('§9 the store takes `timeOff` from the payload only when it is there', /this\.timeOff = [^\n]*data\.timeOff/.test(store), true)

const panel = read('client/src/components/drivers-db/DriverAvailabilityPanel.vue') || ''
eq('§9 the panel uses no zone-dependent Date', !ZONED_DATE.test(panel), true)
eq('§9 the panel\'s buttons come from rowActions()', /rowActions\(/.test(panel), true)
eq('§9 the panel\'s edit sends editPatch()', /api\.put\([^\n]*editPatch\(/.test(panel), true)
eq('§9 the panel\'s Save waits for canSaveEdit()', /canSaveEdit\(/.test(panel), true)
eq('§9 the panel shows the server\'s create limits', /createDateBounds\(/.test(panel), true)

console.log(`\ntest-availability-edit-form: ${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
