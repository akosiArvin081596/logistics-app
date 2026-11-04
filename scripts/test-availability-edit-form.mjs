#!/usr/bin/env node
// The client side of the R11 follow-up: staff full edit and the driver's own
// "My time off" screen (client/src/lib/availabilityText.js, the panel, the card).
//
// The server owns every rule. Each row of GET /api/drivers-directory/:id/availability
// carries `editable` ("full" / "end_early" / "none") and `limits`
// ({ fromMin, toMin, toMax, maxDays }, null = no limit); the reply carries
// `createLimits` ({ fromMin, toMin, maxDays, dispatcherBackDays }). The client
// only applies what it is sent: the one thing it adds is that the last day off
// is never before the form's own first day. An edit sends only the fields that
// changed.
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
//   §4 canSaveEdit() / datesWithinBounds(): Save only for a change inside them,
//      never longer than maxDays; rangeHint(): why Save or Add is off when the
//      range is longer than maxDays; endEarlyNote(): the Dispatcher's
//      back-dating window in words, from the server's dispatcherBackDays
//   §5 editFormFor(): the form starts from the stored row; End early starts at
//      today, kept inside the server's limits
//   §6 driverTimeOffRows(): current and upcoming only, five fields only
//   §7 driverTimeOffBanner(): off now; coming up within 7 days; month, year
//      and leap-day edges
//   §8 the same answers under every viewer zone
//   §9 the source: no zone-dependent Date in the text lib, the panel or the
//      card; the card never names the fields it must not show; DriverView
//      renders the card and the banner only when the payload carried `timeOff`;
//      the panel's "Save anyway" (R11b) is built from the helpers below
//   §10 R11b, the other side of the dispatch warning: a save over loads he
//      already has answers 409 DRIVER_HAS_LOADS (isDriverHasLoadsWarning());
//      "Save anyway" re-sends the same body with the listed loads echoed as
//      `confirmLoads` (withLoadsConfirmed()), never anything the panel worked
//      out; a save the server could not check says so (loadsUncheckedNote())
//   §11 a driver's own request (DRIVER_TIME_OFF_REQUESTS_ENABLED): the card's
//      request rows, its words, and a form that only applies the server's
//      requestLimits (shiftDayKey() counts whole calendar days, no Date)
//   §12 staff: the request on its in-app notice, stored or live
//      (timeOffRequestOfNotice(), noticeWithDecision(), requestDecisionText())
//      and in the Drivers panel (panelGroup(), panelPastText(), panelRequestText())
//   §13 home time (H1): his rows and requests keep a well-formed `home`; the
//      form starts at the server's homeDefault and won't send without a city
//      and a listed state; the staff forms take both or neither and send a
//      changed home time only on a row carrying `home`; the words; the state
//      list is the server's (lib/us-states.js STATE_CODES)
//
// No DOM, no server. Files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-availability-edit-form.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
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
const NEW_EXPORTS = ['rowActions', 'editPatch', 'editDateBounds', 'createDateBounds', 'datesWithinBounds', 'canSaveEdit', 'editFormFor', 'driverTimeOffRows', 'driverTimeOffBanner', 'endEarlyNote', 'rangeHint',
  'isDriverHasLoadsWarning', 'withLoadsConfirmed', 'loadsUncheckedNote',
  // A driver's own request (PR 4).
  'shiftDayKey', 'driverRequestRows', 'driverRequestStatusText', 'requestFormStart', 'requestFormBounds', 'canSendRequest', 'requestBody',
  'timeOffRequestOfNotice', 'noticeWithDecision', 'requestDecisionText', 'panelGroup', 'panelPastText', 'panelRequestText',
  // Home time (H1).
  'homeReady', 'staffHomeReady', 'createBody', 'homeLocationText', 'homeTimeText', 'panelHomeText']
for (const name of NEW_EXPORTS) eq(`§0 availabilityText.js exports ${name}()`, typeof T[name], 'function')
eq('§0 ...and the card\'s two hints', [T.REQUEST_HINT, T.RECORDED_HINT], [
  'Ask at least 5 days ahead. Dispatch approves each request. For sooner days or changes, message dispatch.',
  'Dispatch records your time off. To change it, message dispatch.'])
const call = (name, ...args) => (typeof T[name] === 'function' ? T[name](...args) : undefined)

// Made-up rows, as the staff GET will send them (today 2026-10-16).
const TODAY = '2026-10-16'
const stored = (over) => ({
  id: 7, directoryId: 3, kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family',
  createdBy: 'dispatch_demo', createdAt: '2026-10-01T14:00:00Z', updatedAt: null, cancelledAt: null, cancelledBy: null,
  status: 'current', editable: 'full', limits: { fromMin: null, toMin: null, toMax: null, maxDays: 60 }, ...over,
})
const formOf = (r, over) => ({ kind: r.kind, from: r.from, to: r.to, reason: r.reason, ...over })
// A Super Admin's row, a Dispatcher's recent row, a Dispatcher's old live row
// (end early only) and a Dispatcher's old ended row.
const SA = stored({})
const DISP = stored({ limits: { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null, maxDays: 60 } })
const OLD = stored({ id: 8, from: '2026-09-01', to: '2026-10-20', limits: { fromMin: null, toMin: '2026-10-15', toMax: '2026-10-19', maxDays: 60 }, editable: 'end_early' })
const CREATE_DISP = { fromMin: '2026-09-16', toMin: null, maxDays: 60, dispatcherBackDays: 30 }
const CREATE_SA = { fromMin: null, toMin: null, maxDays: 60, dispatcherBackDays: 30 }
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
  rec('§3 Super Admin: no limit but "not before the first day"', call('editDateBounds', SA, formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null, maxDays: 60 })
  rec('§3 Super Admin: the first day moved later moves the end\'s minimum', call('editDateBounds', SA, formOf(SA, { from: '2026-10-14' })), { fromMin: null, toMin: '2026-10-14', toMax: null, maxDays: 60 })
  rec('§3 Dispatcher recent row: the server\'s limits', call('editDateBounds', DISP, formOf(DISP)), { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null, maxDays: 60 })
  rec('§3 Dispatcher recent row: a later first day wins over toMin', call('editDateBounds', DISP, formOf(DISP, { from: '2026-10-18' })), { fromMin: '2026-09-16', toMin: '2026-10-18', toMax: null, maxDays: 60 })
  rec('§3 "end_early": the stored first day, the server\'s end limits', call('editDateBounds', OLD, formOf(OLD, { from: '2026-10-18' })), { fromMin: null, toMin: '2026-10-15', toMax: '2026-10-19', maxDays: 60 })
  rec('§3 "none": no form', call('editDateBounds', ENDED, formOf(ENDED)), null)
  rec('§3 no limits sent: only "not before the first day"', call('editDateBounds', stored({ limits: undefined }), formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null, maxDays: null })
  rec('§3 an unreadable limit is ignored', call('editDateBounds', stored({ limits: { fromMin: '2026-9-1', toMin: 'soon', toMax: 5, maxDays: '60' } }), formOf(SA)), { fromMin: null, toMin: '2026-10-10', toMax: null, maxDays: null })
  rec('§3 an empty first day: the server\'s toMin alone', call('editDateBounds', DISP, formOf(DISP, { from: '' })), { fromMin: '2026-09-16', toMin: '2026-10-15', toMax: null, maxDays: 60 })
  rec('§3 create, Dispatcher', call('createDateBounds', CREATE_DISP, { from: '2026-10-16', to: '2026-10-16' }), { fromMin: '2026-09-16', toMin: '2026-10-16', toMax: null, maxDays: 60 })
  rec('§3 create, Super Admin', call('createDateBounds', CREATE_SA, { from: '2026-01-02', to: '2026-01-03' }), { fromMin: null, toMin: '2026-01-02', toMax: null, maxDays: 60 })
  rec('§3 create, no createLimits sent', call('createDateBounds', undefined, { from: '2026-10-16', to: '' }), { fromMin: null, toMin: '2026-10-16', toMax: null, maxDays: null })

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
  rec('§4 an edit to 60 days (Oct 10 - Dec 8, maxDays 60): Save', call('canSaveEdit', SA, formOf(SA, { to: '2026-12-08' })), true)
  rec('§4 an edit to 61 days (Oct 10 - Dec 9): no Save (the server answers 400 RANGE_TOO_LONG)', call('canSaveEdit', SA, formOf(SA, { to: '2026-12-09' })), false)
  rec('§4 a Dispatcher\'s 61-day edit, the first day moved earlier: no Save', call('canSaveEdit', DISP, formOf(DISP, { from: '2026-09-21', to: '2026-11-20' })), false)
  rec('§4 no maxDays sent: no cap on this side (the server still refuses)', call('canSaveEdit', stored({ limits: { fromMin: null, toMin: null, toMax: null } }), formOf(SA, { to: '2026-12-09' })), true)
  rec('§4 an unreadable maxDays is ignored', call('canSaveEdit', stored({ limits: { fromMin: null, toMin: null, toMax: null, maxDays: 0 } }), formOf(SA, { to: '2026-12-09' })), true)
  const add = (from, to) => call('datesWithinBounds', { from, to }, call('createDateBounds', CREATE_DISP, { from, to }))
  rec('§4 add 60 days (Oct 16 - Dec 14): allowed', add('2026-10-16', '2026-12-14'), true)
  rec('§4 add 61 days (Oct 16 - Dec 15): not allowed', add('2026-10-16', '2026-12-15'), false)
  rec('§4 add across a year end, 61 days (Dec 1 - Jan 30): not allowed', add('2026-12-01', '2027-01-30'), false)
  const LONG = 'At most 60 days. For longer, add another period after this one ends.'
  const hint = (from, to, limits = CREATE_DISP) => call('rangeHint', { from, to }, call('createDateBounds', limits, { from, to }))
  rec('§4 the range hint at 61 days names the server\'s cap', hint('2026-10-16', '2026-12-15'), LONG)
  rec('§4 ...says nothing at 60 days', hint('2026-10-16', '2026-12-14'), '')
  rec('§4 ...uses the number the server sends', hint('2026-10-16', '2026-11-16', { ...CREATE_DISP, maxDays: 30 }), 'At most 30 days. For longer, add another period after this one ends.')
  rec('§4 ...says nothing without a maxDays', hint('2026-10-16', '2026-12-15', { fromMin: null, toMin: null }), '')
  rec('§4 ...nor for a reversed range or an unreadable day (the other limits cover those)', [hint('2026-12-15', '2026-10-16'), hint('2026-10-16', '')], ['', ''])
  rec('§4 ...nor without bounds', call('rangeHint', { from: '2026-10-16', to: '2026-12-15' }, null), '')
  rec('§4 ...and on an edit form, from its bounds', call('rangeHint', formOf(SA, { to: '2026-12-09' }), call('editDateBounds', SA, formOf(SA, { to: '2026-12-09' }))), LONG)
  rec('§4 the end-early note names the server\'s window', call('endEarlyNote', CREATE_DISP), 'Started more than 30 days ago: only a Super Admin can change the other details.')
  rec('§4 ...whatever number it sends', call('endEarlyNote', { ...CREATE_DISP, dispatcherBackDays: 45 }), 'Started more than 45 days ago: only a Super Admin can change the other details.')
  rec('§4 ...and names no number when none was sent', call('endEarlyNote', null), 'Started too long ago: only a Super Admin can change the other details.')
  rec('§4 ...or an unreadable one', call('endEarlyNote', { dispatcherBackDays: 'thirty' }), 'Started too long ago: only a Super Admin can change the other details.')

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

  // §10 R11b: "Save anyway" when the time off covers loads he already has.
  const apiError = (status, code, data) => Object.assign(new Error((data && data.error) || 'x'), { status, code, data })
  const hasLoads = {
    error: 'Demo Driver has 2 loads overlapping these dates: L-100 (Oct 20 – Oct 22), L-101 (Oct 24). Save anyway? The loads stay assigned to him.',
    code: 'DRIVER_HAS_LOADS', driver: 'Demo Driver', from: '2026-10-20', to: '2026-10-24',
    loads: [{ loadId: 'L-100', from: '2026-10-20', to: '2026-10-22', truck: 'T-7' }, { loadId: 'L-101', from: '2026-10-24', to: '2026-10-24', truck: '' }],
  }
  rec('§10 a 409 DRIVER_HAS_LOADS is the loads warning', call('isDriverHasLoadsWarning', apiError(409, 'DRIVER_HAS_LOADS', hasLoads)), true)
  rec('§10 ...the dispatch side\'s 409 DRIVER_OFF_DUTY is not', call('isDriverHasLoadsWarning', apiError(409, 'DRIVER_OFF_DUTY', {})), false)
  rec('§10 ...nor an overlap, another status, or nothing', [
    call('isDriverHasLoadsWarning', apiError(409, 'AVAILABILITY_OVERLAP', {})), call('isDriverHasLoadsWarning', apiError(400, 'DRIVER_HAS_LOADS', {})),
    call('isDriverHasLoadsWarning', null), call('isDriverHasLoadsWarning', undefined),
  ], [false, false, false, false])
  const sentBody = { kind: 'vacation', from: '2026-10-20', to: '2026-10-24', reason: 'Family' }
  rec('§10 "Save anyway" re-sends the same body with each listed load echoed as { loadId, from, to }', call('withLoadsConfirmed', sentBody, hasLoads), {
    ...sentBody, confirmLoads: [{ loadId: 'L-100', from: '2026-10-20', to: '2026-10-22' }, { loadId: 'L-101', from: '2026-10-24', to: '2026-10-24' }],
  })
  rec('§10 ...an edit\'s body of changed fields alone', call('withLoadsConfirmed', { to: '2026-10-24' }, hasLoads), {
    to: '2026-10-24', confirmLoads: [{ loadId: 'L-100', from: '2026-10-20', to: '2026-10-22' }, { loadId: 'L-101', from: '2026-10-24', to: '2026-10-24' }],
  })
  const second = { ...hasLoads, loads: [{ loadId: 'L-102', from: '2026-10-21', to: '2026-10-21', truck: '' }] }
  rec('§10 a second 409\'s list replaces the first echo', call('withLoadsConfirmed', call('withLoadsConfirmed', sentBody, hasLoads), second)?.confirmLoads, [{ loadId: 'L-102', from: '2026-10-21', to: '2026-10-21' }])
  const kept = { ...sentBody }
  call('withLoadsConfirmed', kept, hasLoads)
  rec('§10 ...the body sent first is left as it was', kept, sentBody)
  rec('§10 no list in the answer: an empty echo (the server asks again)', call('withLoadsConfirmed', sentBody, { code: 'DRIVER_HAS_LOADS' })?.confirmLoads, [])
  rec('§10 entries that are not loads are left out', call('withLoadsConfirmed', sentBody, { loads: [null, 'L-9', { loadId: 'L-103', from: '2026-10-22', to: '2026-10-23', extra: 1 }] })?.confirmLoads,
    [{ loadId: 'L-103', from: '2026-10-22', to: '2026-10-23' }])
  rec('§10 a save the server could not check says so', call('loadsUncheckedNote', { success: true, row: {}, loadsUnchecked: true }), 'Loads couldn\'t be checked. Look at the Job Board for his loads.')
  rec('§10 ...a checked save says nothing', [call('loadsUncheckedNote', { success: true, row: {} }), call('loadsUncheckedNote', { loadsUnchecked: 'yes' }), call('loadsUncheckedNote', null)], ['', '', ''])

  // §11 a driver's own request (PR 4): the card applies the days the server sent
  // (requestLimits, from its own business day "today" Oct 15) and nothing else.
  const LIMITS = { fromMin: '2026-10-20', fromMax: '2027-01-13', maxDays: 60, waitingMax: 5 }
  rec('§11 shiftDayKey(): a month end, a year end, a leap day, backwards, 90 days on', [
    call('shiftDayKey', '2026-10-31', 1), call('shiftDayKey', '2026-12-31', 1), call('shiftDayKey', '2028-02-28', 1), call('shiftDayKey', '2027-02-28', 1),
    call('shiftDayKey', '2026-03-01', -1), call('shiftDayKey', '2026-10-15', 90), call('shiftDayKey', '2026-11-01', 0),
  ], ['2026-11-01', '2027-01-01', '2028-02-29', '2027-03-01', '2026-02-28', '2027-01-13', '2026-11-01'])
  rec('§11 ..."" for a key that is not a day or a count that is not whole', [call('shiftDayKey', '2026-13-01', 1), call('shiftDayKey', '', 1), call('shiftDayKey', '2026-10-15', 1.5)], ['', '', ''])
  const asked = [
    { id: 9, kind: 'vacation', from: '2026-11-09', to: '2026-11-13', request: 'waiting', canCancel: true, reason: 'Family', decidedBy: 'dispatch_demo' },
    { id: 8, kind: 'off_duty', from: '2026-11-02', to: '2026-11-02', request: 'declined', canCancel: true },
    { id: 7, kind: 'other', from: '2026-11-20', to: '2026-11-21', request: 'approved', canCancel: false },
    { id: 6, kind: 'other', from: '2026-11-25', to: '2026-11-24', request: 'waiting', canCancel: true },
    { id: 5, kind: 'other', from: '2026-11-26', to: '2026-11-26', request: 'waiting', canCancel: 'yes' },
    null,
  ]
  rec('§11 driverRequestRows(): waiting and declined only, by first day, six fields; Cancel only on a waiting one the server offered it on', call('driverRequestRows', asked), [
    { id: 8, kind: 'off_duty', from: '2026-11-02', to: '2026-11-02', request: 'declined', canCancel: false },
    { id: 9, kind: 'vacation', from: '2026-11-09', to: '2026-11-13', request: 'waiting', canCancel: true },
    { id: 5, kind: 'other', from: '2026-11-26', to: '2026-11-26', request: 'waiting', canCancel: false },
  ])
  rec('§11 ...nothing sent, or not a list', [call('driverRequestRows', undefined), call('driverRequestRows', { requests: [] })], [[], []])
  rec('§11 driverRequestStatusText(): the card\'s words', [call('driverRequestStatusText', { request: 'waiting' }), call('driverRequestStatusText', { request: 'declined' }),
    call('driverRequestStatusText', { request: 'approved' }), call('driverRequestStatusText', null)], ['Waiting for approval', 'Not approved. Message dispatch.', '', ''])
  rec('§11 requestFormStart(): the first day the server allows, one day, "Off duty" (no home time sent: blank)', call('requestFormStart', LIMITS),
    { kind: 'off_duty', from: '2026-10-20', to: '2026-10-20', homeCity: '', homeState: '' })
  rec('§11 ...no limits sent: empty days', call('requestFormStart', null), { kind: 'off_duty', from: '', to: '', homeCity: '', homeState: '' })
  rec('§11 requestFormBounds(): the first day from fromMin to fromMax; the last from the first to the 60th day', call('requestFormBounds', LIMITS, { from: '2026-10-20', to: '2026-10-20' }),
    { fromMin: '2026-10-20', fromMax: '2027-01-13', toMin: '2026-10-20', toMax: '2026-12-18' })
  rec('§11 ...across a year end', call('requestFormBounds', LIMITS, { from: '2026-12-01', to: '' }), { fromMin: '2026-10-20', fromMax: '2027-01-13', toMin: '2026-12-01', toMax: '2027-01-29' })
  rec('§11 ...an empty first day: the last day starts at fromMin, no end limit', call('requestFormBounds', LIMITS, { from: '', to: '' }), { fromMin: '2026-10-20', fromMax: '2027-01-13', toMin: '2026-10-20', toMax: null })
  rec('§11 ...no limits sent: only "not before the first day"', call('requestFormBounds', null, { from: '2026-11-02', to: '' }), { fromMin: null, fromMax: null, toMin: '2026-11-02', toMax: null })
  // H1: a request names its home time, so each form here carries one.
  const sendable = (form, limits = LIMITS) => call('canSendRequest', { kind: 'off_duty', homeCity: 'Springfield', homeState: 'MO', ...form }, limits)
  rec('§11 canSendRequest(): Send inside the limits only', [
    sendable({ from: '2026-10-20', to: '2026-10-22' }), sendable({ from: '2026-10-19', to: '2026-10-22' }), sendable({ from: '2027-01-13', to: '2027-01-13' }),
    sendable({ from: '2027-01-14', to: '2027-01-14' }), sendable({ from: '2026-10-22', to: '2026-10-21' }), sendable({ from: '2026-10-20', to: '2026-12-18' }),
    sendable({ from: '2026-10-20', to: '2026-12-19' }), sendable({ from: '2026-10-20', to: '' }), sendable({ from: '2026-10-20', to: '2026-10-20', kind: 'sick' }),
    sendable({ from: '2026-10-20', to: '2026-10-20' }, null),
  ], [true, false, true, false, false, true, false, false, false, false])
  rec('§11 requestBody(): the two days, the kind and (H1) the home time, never anything else',
    call('requestBody', { kind: 'vacation', from: '2026-11-02', to: '2026-11-03', reason: 'Family', driver: 'Demo Driver', homeCity: ' Springfield ', homeState: 'MO' }),
    { kind: 'vacation', from: '2026-11-02', to: '2026-11-03', homeCity: 'Springfield', homeState: 'MO' })

  // §12 staff: the request on its in-app notice (stored, or live with its payload
  // nested in `metadata`) and in the Drivers panel.
  const notice = (metadata, type = 'time-off-request') => ({ id: 41, type, title: 'Time off request: Demo Driver (Nov 9 – Nov 13)', body: 'Off duty. Asked Nov 2.', metadata, read: 0 })
  const STORED = notice(JSON.stringify({ availabilityId: 12, directoryId: 3 }))
  const LIVE = notice(JSON.stringify({ type: 'time-off-request', title: 'x', body: 'y', metadata: { availabilityId: 12, directoryId: 3 } }))
  rec('§12 timeOffRequestOfNotice(): a stored notice and a live one both name the request', [call('timeOffRequestOfNotice', STORED), call('timeOffRequestOfNotice', LIVE)],
    [{ availabilityId: 12, decision: '', decidedBy: '' }, { availabilityId: 12, decision: '', decidedBy: '' }])
  rec('§12 ...a decided one says who', call('timeOffRequestOfNotice', notice(JSON.stringify({ availabilityId: 12, decision: 'approved', decidedBy: 'dispatch_demo' }))),
    { availabilityId: 12, decision: 'approved', decidedBy: 'dispatch_demo' })
  rec('§12 ...another type, unreadable metadata, no request id, or an unknown decision', [
    call('timeOffRequestOfNotice', notice(JSON.stringify({ availabilityId: 12 }), 'eld-feed-silent')), call('timeOffRequestOfNotice', notice('{not json')),
    call('timeOffRequestOfNotice', notice(JSON.stringify({ availabilityId: 'x' }))), call('timeOffRequestOfNotice', notice(JSON.stringify({ availabilityId: 12, decision: 'maybe', decidedBy: 'x' }))),
  ], [null, null, null, { availabilityId: 12, decision: '', decidedBy: '' }])
  const decidedStored = call('noticeWithDecision', STORED, 12, 'declined', 'super_demo')
  const decidedLive = call('noticeWithDecision', LIVE, 12, 'approved', 'dispatch_demo')
  rec('§12 noticeWithDecision(): the decision written in, the metadata kept in the shape it came in', [
    call('timeOffRequestOfNotice', decidedStored), typeof decidedStored?.metadata, call('timeOffRequestOfNotice', decidedLive), JSON.parse(decidedLive?.metadata || '{}').type,
  ], [{ availabilityId: 12, decision: 'declined', decidedBy: 'super_demo' }, 'string', { availabilityId: 12, decision: 'approved', decidedBy: 'dispatch_demo' }, 'time-off-request'])
  rec('§12 ...another request\'s notice, or an unknown decision: the same notice', [call('noticeWithDecision', STORED, 13, 'approved', 'x') === STORED, call('noticeWithDecision', STORED, 12, 'maybe', 'x') === STORED], [true, true])
  rec('§12 requestDecisionText(): who decided, as staff read it', [
    call('requestDecisionText', 'approved', 'dispatch_demo'), call('requestDecisionText', 'declined', 'super_demo'), call('requestDecisionText', 'cancelled', 'driver'),
    call('requestDecisionText', 'cancelled', 'system'), call('requestDecisionText', 'approved', ''), call('requestDecisionText', '', 'x'),
  ], ['Approved by dispatch_demo', 'Declined by super_demo', 'Cancelled by the driver', 'Cancelled: driver removed from the Drivers list', 'Approved by staff', ''])
  const prow = (over) => ({ id: 1, kind: 'vacation', from: '2026-11-09', to: '2026-11-13', status: 'upcoming', request: 'approved', source: 'staff', decidedBy: null, ...over })
  rec('§12 panelGroup(): a waiting request first, a declined one with the past rows, approved time off as before', [
    call('panelGroup', prow({ request: 'waiting', source: 'driver' })), call('panelGroup', prow({ request: 'declined', source: 'driver' })), call('panelGroup', prow({})),
    call('panelGroup', prow({ status: 'current' })), call('panelGroup', prow({ status: 'past' })), call('panelGroup', prow({ status: 'cancelled', request: 'waiting', source: 'driver' })),
    call('panelGroup', { id: 2, from: '2026-11-09', to: '2026-11-13', status: 'upcoming' }), call('panelGroup', null),
  ], ['waiting', 'past', 'live', 'live', 'past', 'past', 'live', 'past'])
  rec('§12 panelPastText() and panelRequestText(): the words beside a row', [
    call('panelPastText', prow({ status: 'cancelled' })), call('panelPastText', prow({ request: 'declined' })), call('panelPastText', prow({ status: 'past' })),
    call('panelRequestText', prow({ request: 'waiting', source: 'driver' })), call('panelRequestText', prow({ source: 'driver', decidedBy: 'dispatch_demo' })),
    call('panelRequestText', prow({ request: 'declined', source: 'driver', decidedBy: 'super_demo' })), call('panelRequestText', prow({})), call('panelRequestText', { status: 'upcoming' }),
  ], ['Cancelled', 'Declined', 'Ended', 'Asked by the driver', 'Asked by the driver, approved by dispatch_demo', 'Asked by the driver, declined by super_demo', '', ''])

  // §13 home time (H1). Made-up places.
  const H = { city: 'Riverton', state: 'WY' }
  rec('§13 driverTimeOffRows(): a row naming a home time keeps it; a malformed or null one is left out', call('driverTimeOffRows', [
    { id: 1, kind: 'vacation', from: '2026-10-20', to: '2026-10-21', status: 'upcoming', home: H },
    { id: 2, kind: 'vacation', from: '2026-10-22', to: '2026-10-23', status: 'upcoming', home: null },
    { id: 3, kind: 'vacation', from: '2026-10-24', to: '2026-10-25', status: 'upcoming', home: { city: 'Riverton', state: 7, phone: '555-0100' } },
  ]), [
    { id: 1, kind: 'vacation', from: '2026-10-20', to: '2026-10-21', status: 'upcoming', home: H },
    { id: 2, kind: 'vacation', from: '2026-10-22', to: '2026-10-23', status: 'upcoming' },
    { id: 3, kind: 'vacation', from: '2026-10-24', to: '2026-10-25', status: 'upcoming' },
  ])
  rec('§13 driverRequestRows(): the same for a request, nothing else of `home` kept', call('driverRequestRows', [
    { id: 4, kind: 'off_duty', from: '2026-11-09', to: '2026-11-10', request: 'waiting', canCancel: true, home: { ...H, note: 'x' } },
  ]), [{ id: 4, kind: 'off_duty', from: '2026-11-09', to: '2026-11-10', request: 'waiting', canCancel: true, home: H }])
  rec('§13 the words: the card\'s, the panel\'s, and none for no home time', [
    call('homeTimeText', H), call('panelHomeText', { home: H }), call('homeLocationText', H), call('homeTimeText', null), call('panelHomeText', { home: { city: '', state: 'WY' } }), call('panelHomeText', null),
  ], ['Home time in Riverton, WY', 'Home time: Riverton, WY', 'Riverton, WY', '', '', ''])
  rec('§13 requestFormStart(): the home time at the server\'s homeDefault; a state off the list starts blank', [
    call('requestFormStart', LIMITS, { city: 'Springfield', state: 'MO' }), call('requestFormStart', LIMITS, { city: 'Springfield', state: 'Missouri' }),
  ], [{ kind: 'off_duty', from: '2026-10-20', to: '2026-10-20', homeCity: 'Springfield', homeState: 'MO' },
    { kind: 'off_duty', from: '2026-10-20', to: '2026-10-20', homeCity: 'Springfield', homeState: '' }])
  rec('§13 canSendRequest(): not without a city, a listed state, or with a city over 60 characters', [
    sendable({ from: '2026-10-20', to: '2026-10-20' }), sendable({ from: '2026-10-20', to: '2026-10-20', homeCity: '   ' }), sendable({ from: '2026-10-20', to: '2026-10-20', homeState: '' }),
    sendable({ from: '2026-10-20', to: '2026-10-20', homeState: 'ZZ' }), sendable({ from: '2026-10-20', to: '2026-10-20', homeCity: 'A'.repeat(60) }), sendable({ from: '2026-10-20', to: '2026-10-20', homeCity: 'A'.repeat(61) }),
  ], [true, false, false, false, true, false])
  rec('§13 staffHomeReady(): both or neither', [
    call('staffHomeReady', { homeCity: '', homeState: '' }), call('staffHomeReady', { homeCity: 'Riverton', homeState: 'WY' }), call('staffHomeReady', { homeCity: 'Riverton', homeState: '' }),
    call('staffHomeReady', { homeCity: ' ', homeState: 'WY' }), call('staffHomeReady', {}),
  ], [true, true, false, false, true])
  const HROW = stored({ home: H, request: 'approved', source: 'staff' })
  const NOHOME = stored({ home: null, request: 'approved', source: 'staff' })
  rec('§13 editFormFor(): the row\'s home time as fields, only on a row carrying `home`', [call('editFormFor', HROW, TODAY), call('editFormFor', NOHOME, TODAY), call('editFormFor', SA, TODAY)], [
    { kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family', homeCity: 'Riverton', homeState: 'WY' },
    { kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family', homeCity: '', homeState: '' },
    { kind: 'vacation', from: '2026-10-10', to: '2026-10-20', reason: 'Family' },
  ])
  const hform = (row, over) => ({ ...call('editFormFor', row, TODAY), ...over })
  rec('§13 editPatch(): an unchanged home time sends nothing; a changed city sends both parts; cleared sends both ""', [
    call('editPatch', HROW, hform(HROW)), call('editPatch', HROW, hform(HROW, { homeCity: ' Lincoln ' })), call('editPatch', HROW, hform(HROW, { homeCity: '', homeState: '' })),
    call('editPatch', NOHOME, hform(NOHOME, { homeCity: 'Lincoln', homeState: 'NE' })),
  ], [{}, { homeCity: 'Lincoln', homeState: 'WY' }, { homeCity: '', homeState: '' }, { homeCity: 'Lincoln', homeState: 'NE' }])
  rec('§13 ...never on an end-early edit, nor on a row without `home` (the flag off)', [
    call('editPatch', { ...HROW, editable: 'end_early', limits: OLD.limits }, hform(HROW, { homeCity: 'Lincoln' })), call('editPatch', SA, { ...formOf(SA), homeCity: 'Lincoln', homeState: 'NE' }),
  ], [{}, {}])
  rec('§13 canSaveEdit(): not with a city and no state', [call('canSaveEdit', HROW, hform(HROW, { homeState: '' })), call('canSaveEdit', HROW, hform(HROW, { homeCity: 'Lincoln', homeState: 'NE' }))], [false, true])
  rec('§13 createBody(): the home time\'s two parts (trimmed) only when the server offered it', [
    call('createBody', { kind: 'vacation', from: '2026-10-20', to: '2026-10-21', reason: ' Family ', homeCity: ' Riverton ', homeState: 'WY' }, true),
    call('createBody', { kind: 'vacation', from: '2026-10-20', to: '2026-10-21', reason: ' Family ', homeCity: ' Riverton ', homeState: 'WY' }, false),
  ], [{ kind: 'vacation', from: '2026-10-20', to: '2026-10-21', reason: 'Family', homeCity: 'Riverton', homeState: 'WY' }, { kind: 'vacation', from: '2026-10-20', to: '2026-10-21', reason: 'Family' }])
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
// "Cancel request" on a waiting request (PR 4) is the one cancel the card may name.
const cardOwnCancel = /Cancel request|canCancel|cancelTimeOffRequest/g
eq('§9 the card never names a reason, an author or a cancelled row', !!card && !/reason|created|cancel|directoryId|decided/i.test(card.replace(cardOwnCancel, '')), true)
eq('§9 the card lists rows through driverTimeOffRows()', !!card && /driverTimeOffRows\(/.test(card), true)
eq('§9 the banner text comes from driverTimeOffBanner()', !!card && /driverTimeOffBanner\(/.test(card), true)
// PR 4: the request part of the card follows the keys the server sent.
eq('§9 the request part shows only when the payload carried `requests` (the server\'s flag)', !!card && /Array\.isArray\(props\.timeOff\.requests\)/.test(card) && /v-if="requestsOn && !loadFailed"/.test(card), true)
eq('§9 "Request home time / days off" (H1) only on a session the server says may ask', !!card && /v-else-if="timeOff\.canRequest === true"[^>]*>Request home time \/ days off</.test(card), true)
eq('§9 its requests come through driverRequestRows(), Cancel only where r.canCancel', !!card && /driverRequestRows\(/.test(card) && /v-if="r\.canCancel"[^>]*>Cancel request</.test(card), true)
eq('§9 the form\'s days come from requestFormBounds() and requestFormStart(); Send waits for canSendRequest() and sends requestBody()',
  !!card && [/requestFormBounds\(/, /requestFormStart\(/, /canSendRequest\(/, /requestTimeOff\(requestBody\(form\)\)/].every((re) => re.test(card)), true)
eq('§9 the hint is the lib\'s, by the flag', !!card && /requestsOn \? REQUEST_HINT : RECORDED_HINT/.test(card), true)

const view = read('client/src/views/DriverView.vue') || ''
const cardTags = view.match(/<DriverTimeOffCard\b[^>]*>/g) || []
eq('§9 DriverView renders the card and the banner', cardTags.length, 2)
eq('§9 each renders only when the payload carried `timeOff`', cardTags.every((t) => /v-if="driverStore\.timeOff"/.test(t)), true)
eq('§9 one of them is the banner', cardTags.filter((t) => /variant="banner"/.test(t)).length, 1)

const store = read('client/src/stores/driver.js') || ''
eq('§9 the store starts with no time off', /\btimeOff: null,/.test(store), true)
eq('§9 the store takes `timeOff` from the payload only when it is there', /this\.timeOff = [^\n]*data\.timeOff/.test(store), true)
eq('§9 PR 4: the store asks and withdraws through the driver\'s own routes only (no name in the path or body)', [
  /api\.post\('\/api\/driver\/me\/availability', body\)/.test(store), /api\.post\(`\/api\/driver\/me\/availability\/\$\{encodeURIComponent\(id\)\}\/cancel`, \{\}\)/.test(store),
], [true, true])
// Every plain reload swaps the Kit tab for its skeleton, which remounts the card and drops its note.
const actionBody = (name) => {
  const at = store.indexOf(`async ${name}(`)
  return at < 0 ? '' : store.slice(at, store.indexOf('\n    },', at))
}
eq('§9 ...each reloads quietly (no skeleton swap), and a refusal over the days takes the server\'s limits again', [
  ['requestTimeOff', 'cancelTimeOffRequest', 'refreshTimeOffLimits'].filter((n) => /this\.loadData\(\{ quiet: true \}\)/.test(actionBody(n))).length,
  /if \(!\(opts && opts\.quiet === true\)\) this\.isLoading = true/.test(store),
  !!card && /err\.code === 'TIME_OFF_TOO_SOON' \|\| err\.code === 'TIME_OFF_TOO_FAR'\)\) await driverStore\.refreshTimeOffLimits\(\)/.test(card),
], [3, true, true])
eq('§9 ...and DriverView opens the Kit tab on a time-off notice and refetches on `time-off-updated`',
  [/notif\.type === 'time-off'/.test(view), /socket\.on\('time-off-updated', onTimeOffUpdated\)/.test(view), /socket\.off\('time-off-updated', onTimeOffUpdated\)/.test(view)], [true, true, true])

// PR 4, staff: one tap on the notice, and the same two buttons in the panel.
const notices = read('client/src/views/NotificationsView.vue') || ''
eq('§9 Notifications: Approve and Decline keep their click on the button (@click.stop), on a waiting request only',
  [/@click\.stop="decide\(n, 'approve'\)"/.test(notices), /@click\.stop="decide\(n, 'decline'\)"/.test(notices), /v-if="requestOf\(n\)\.decision"/.test(notices)], [true, true, true])
eq('§9 ...each tap posts to the request\'s own route; "Approve anyway" re-sends withLoadsConfirmed()',
  [/api\.post\(`\/api\/driver-availability\/\$\{req\.availabilityId\}\/\$\{decision\}`, body\)/.test(notices), /withLoadsConfirmed\(\{\}, err\.data\)/.test(notices),
    /confirm-text="Approve anyway"/.test(notices), /cancel-text="Keep waiting"/.test(notices)], [true, true, true, true])
eq('§9 ...and a decision made elsewhere reaches an open page', /socket\.on\('time-off-request-decided', onRequestDecided\)/.test(notices) && /socket\.off\('time-off-request-decided', onRequestDecided\)/.test(notices), true)

const panel = read('client/src/components/drivers-db/DriverAvailabilityPanel.vue') || ''
eq('§9 the panel uses no zone-dependent Date', !ZONED_DATE.test(panel), true)
eq('§9 the panel\'s buttons come from rowActions()', /rowActions\(/.test(panel), true)
eq('§9 the panel\'s edit sends editPatch()', /api\.put\([^\n]*editPatch\(/.test(panel), true)
eq('§9 the panel\'s Save waits for canSaveEdit()', /canSaveEdit\(/.test(panel), true)
eq('§9 the panel shows the server\'s create limits', /createDateBounds\(/.test(panel), true)
eq('§9 the panel shows the range hint under the edit form and the add form', (panel.match(/rangeHint\(/g) || []).length, 2)
eq('§9 the end-early note comes from endEarlyNote(), with no day count of its own', /endEarlyNote\(/.test(panel) && !/more than \d+ days/.test(panel), true)
eq('§9 R11b: the panel knows the loads warning by isDriverHasLoadsWarning()', /isDriverHasLoadsWarning\(/.test(panel), true)
eq('§9 ...re-sends with withLoadsConfirmed()', /withLoadsConfirmed\(/.test(panel), true)
eq('§9 ...says when loads were not checked through loadsUncheckedNote()', /loadsUncheckedNote\(/.test(panel), true)
eq('§9 ...asks in its own dialog: "He has loads on these days", "Keep as is" (the safe button, first) and "Save anyway"',
  [/title="He has loads on these days"/.test(panel), /cancel-text="Keep as is"/.test(panel), /confirm-text="Save anyway"/.test(panel)], [true, true, true])
eq('§9 ...and builds no echo of its own (no confirmLoads written in the panel)', /confirmLoads/.test(panel), false)
eq('§9 PR 4: the panel groups rows by panelGroup(), a waiting request first with Approve and Decline posting to its own route',
  [/panelGroup\(r\) === 'waiting'/.test(panel), /api\.post\(`\/api\/driver-availability\/\$\{r\.id\}\/\$\{decision\}`, body\)/.test(panel),
    /confirm-text="Approve anyway"/.test(panel), panel.indexOf('v-for="r in waiting"') > -1 && panel.indexOf('v-for="r in waiting"') < panel.indexOf('v-for="r in live"')], [true, true, true, true])
// §13 the source (H1).
eq('§13 the card asks "Where do you need to be?" with a city and a state, starting at the server\'s homeDefault, and shows each home time through homeTimeText()', !!card && [
  /<legend[^>]*>Where do you need to be\?<\/legend>/.test(card), /v-model="form\.homeCity"[^>]*:maxlength="HOME_CITY_MAX"/.test(card), /v-model="form\.homeState"/.test(card),
  /v-for="s in US_STATES"/.test(card), /requestFormStart\(limits\.value, props\.timeOff\.homeDefault\)/.test(card), (card.match(/homeTimeText\(r\.home\)/g) || []).length === 2,
].every(Boolean), true)
eq('§13 the panel shows each row\'s home time through panelHomeText(), takes one in its edit form only on a row carrying `home`, and in its add form only with the server\'s homeTime', [
  (panel.match(/panelHomeText\(r\)/g) || []).length >= 3, /v-if="'home' in r"/.test(panel), /v-if="homeTime"/.test(panel), /homeTime\.value = data\.homeTime === true/.test(panel),
  /createBody\(form, homeTime\.value\)/.test(panel), /staffHomeReady\(form\)/.test(panel),
], [true, true, true, true, true, true])
{
  let serverCodes = null
  try { serverCodes = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'us-states.js')).STATE_CODES } catch { serverCodes = null }
  let clientStates = null
  try { clientStates = (await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'utils', 'usStates.js')).href)).US_STATES } catch { clientStates = null }
  eq('§13 the forms\' state list is the server\'s: client/src/utils/usStates.js codes = lib/us-states.js STATE_CODES (the 50 states and DC)',
    [Array.isArray(serverCodes) && serverCodes.length, Array.isArray(clientStates) && clientStates.map((s) => s.code).sort().join() === (serverCodes || []).join()], [51, true])
}

for (const rel of ['client/src/composables/useOffDutyConfirm.js', 'client/src/components/shared/OffDutyConfirmHost.vue']) {
  const src = read(rel)
  eq(`§9 ${rel} is left to the dispatch side (it never names DRIVER_HAS_LOADS)`, src !== null && !/DRIVER_HAS_LOADS|confirmLoads/.test(src), true)
}

console.log(`\ntest-availability-edit-form: ${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
