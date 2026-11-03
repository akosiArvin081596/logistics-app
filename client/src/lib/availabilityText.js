// A driver's recorded time off, as the dispatch screens word it (R11).
//
// The dates are calendar days ("YYYY-MM-DD") on the business clock, never
// instants, so they are formatted and compared from the text alone: no Date
// parsing, no zone, and the same words for a dispatcher in any time zone (the
// one count of days between two keys runs on Date.UTC whole days, as the
// server's lib does). lib/driver-availability.js availabilityRangeText() says
// the same on the server (the 409 DRIVER_OFF_DUTY message);
// scripts/test-availability-range-text.mjs pins the two equal, and
// scripts/test-availability-edit-form.mjs covers the edit and driver-screen
// helpers below.

import { US_STATES } from '../utils/usStates.js'

const MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 24 * 60 * 60 * 1000
// Whole days on the UTC calendar (Date.UTC), which no zone can shift.
const dayIndex = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY_MS

export const AVAILABILITY_KINDS = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'off_duty', label: 'Off duty' },
  { value: 'other', label: 'Other' },
]

// A real calendar day "YYYY-MM-DD" (2000-2099).
export function isAvailabilityDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v : '')
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
}

const monthDay = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`

// "Oct 14 – Oct 20"; "Oct 14" for one day; "Dec 28, 2026 – Jan 3, 2027" across a
// year end; "" when either end is not a day.
export function availabilityRangeText(from, to) {
  if (!isAvailabilityDay(from) || !isAvailabilityDay(to)) return ''
  if (from === to) return monthDay(from)
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${monthDay(from)}, ${from.slice(0, 4)} – ${monthDay(to)}, ${to.slice(0, 4)}`
  return `${monthDay(from)} – ${monthDay(to)}`
}

// "Off until Oct 20" ("" when not a day).
export function offUntilText(to) {
  return isAvailabilityDay(to) ? `Off until ${monthDay(to)}` : ''
}

// The suffix a driver dropdown adds to an off driver's name.
export function offDutySuffix(to) {
  const t = offUntilText(to)
  return t ? ` — ${t}` : ''
}

// The Fleet & Drivers pill: "Off until Oct 20" for a driver off today, else the
// status the server sent (On Load / Queued / Available).
export function fleetPillText(entry) {
  const e = entry || {}
  return offUntilText(e.offUntil) || e.Status || ''
}

export function kindLabel(kind) {
  const k = AVAILABILITY_KINDS.find((x) => x.value === kind)
  return k ? k.label : 'Time off'
}

// The 409 DRIVER_OFF_DUTY answer an assign route gives, recognised from a
// useApi() error ({ status, code, data }).
export function isOffDutyWarning(err) {
  return !!err && err.status === 409 && err.code === 'DRIVER_OFF_DUTY'
}

// Driver names for a dropdown with the drivers off today moved last (never
// hidden: an emergency may still need one), each group in the order given.
// `offUntil` maps a name to his last day off.
export function sortDriversForAssign(names, offUntil) {
  const off = offUntil || {}
  const list = Array.isArray(names) ? names : []
  return [...list.filter((n) => !off[n]), ...list.filter((n) => off[n])]
}

// ── Staff edit (R11 follow-up) ──────────────────────────────────────────────
// The server decides what the caller may change: each row of
// GET /api/drivers-directory/:id/availability carries `editable` ("full",
// "end_early" or "none") and `limits` ({ fromMin, toMin, toMax, maxDays }, null
// = no limit), and the reply carries `createLimits` ({ fromMin, toMin, maxDays,
// dispatcherBackDays }) for the add form. Nothing here knows the 30-day, the
// 60-day or the yesterday rule: the panel applies the days it is sent, adds
// only "the last day is not before the first", and the server's validator
// stays the authority (its answer shows in words when it refuses).

const EDIT_FIELDS = ['kind', 'from', 'to', 'reason']
const dayOrNull = (v) => (isAvailabilityDay(v) ? v : null)
const countOrNull = (v) => (Number.isInteger(v) && v > 0 ? v : null)
const laterDay = (a, b) => {
  const x = dayOrNull(a)
  const y = dayOrNull(b)
  if (!x) return y
  if (!y) return x
  return x > y ? x : y
}
const reasonText = (v) => String(v == null ? '' : v).trim()

// "full" | "end_early" | "none", as the server sent it; anything else is "none".
function editMode(row) {
  const e = row && row.editable
  return e === 'full' || e === 'end_early' ? e : 'none'
}

// The buttons a row gets: Edit and Cancel on "full", End early on "end_early",
// none otherwise.
export function rowActions(row) {
  const mode = editMode(row)
  return { edit: mode === 'full', endEarly: mode === 'end_early', cancel: mode === 'full' }
}

// The body of an edit: only the fields that changed. An "end_early" row only
// ever sends { to }; a row the caller may not change sends nothing. A changed
// home time (only on a row carrying `home`, the server's requests flag) sends
// both its parts, "" for none.
export function editPatch(row, form) {
  const mode = editMode(row)
  if (mode === 'none') return {}
  const f = form || {}
  const patch = {}
  for (const key of mode === 'end_early' ? ['to'] : EDIT_FIELDS) {
    if (key === 'reason') {
      const next = reasonText(f.reason)
      if (next !== reasonText(row.reason)) patch.reason = next
    } else if (f[key] !== row[key]) {
      patch[key] = f[key]
    }
  }
  if (mode === 'full' && homeKeyed(row)) {
    const was = homeFormFields(row)
    const next = { homeCity: homePart(f.homeCity), homeState: homePart(f.homeState) }
    if (next.homeCity !== was.homeCity || next.homeState !== was.homeState) Object.assign(patch, next)
  }
  return patch
}

// The date limits an edit form shows (null when the row can't be edited). On
// "end_early" the first day is the stored one, whatever the form holds.
export function editDateBounds(row, form) {
  const mode = editMode(row)
  if (mode === 'none') return null
  const limits = (row && row.limits) || {}
  const from = mode === 'end_early' ? row.from : (form || {}).from
  return {
    fromMin: mode === 'full' ? dayOrNull(limits.fromMin) : null,
    toMin: laterDay(from, limits.toMin),
    toMax: dayOrNull(limits.toMax),
    maxDays: countOrNull(limits.maxDays),
  }
}

// The add form's date limits, from the reply's `createLimits`.
export function createDateBounds(createLimits, form) {
  const limits = createLimits || {}
  return {
    fromMin: dayOrNull(limits.fromMin),
    toMin: laterDay((form || {}).from, limits.toMin),
    toMax: dayOrNull(limits.toMax),
    maxDays: countOrNull(limits.maxDays),
  }
}

// Both days are real days, inside the bounds, and the range no longer than
// maxDays, both days included (false without bounds).
export function datesWithinBounds(form, bounds) {
  if (!bounds) return false
  const f = form || {}
  if (!isAvailabilityDay(f.from) || !isAvailabilityDay(f.to)) return false
  if (bounds.fromMin && f.from < bounds.fromMin) return false
  if (bounds.toMin && f.to < bounds.toMin) return false
  if (bounds.toMax && f.to > bounds.toMax) return false
  if (bounds.maxDays && dayIndex(f.to) - dayIndex(f.from) + 1 > bounds.maxDays) return false
  return true
}

// Why Save or Add is off when the range is longer than the server's maxDays
// (both days real and in order), in the server's own words; "" otherwise.
export function rangeHint(form, bounds) {
  const f = form || {}
  if (!bounds || !bounds.maxDays || !isAvailabilityDay(f.from) || !isAvailabilityDay(f.to) || f.to < f.from) return ''
  return dayIndex(f.to) - dayIndex(f.from) + 1 > bounds.maxDays
    ? `At most ${bounds.maxDays} days. For longer, add another period after this one ends.`
    : ''
}

// The note on an "end_early" form: why only the last day can change, naming
// the server's back-dating window (createLimits.dispatcherBackDays).
export function endEarlyNote(createLimits) {
  const days = countOrNull((createLimits || {}).dispatcherBackDays)
  return days
    ? `Started more than ${days} days ago: only a Super Admin can change the other details.`
    : 'Started too long ago: only a Super Admin can change the other details.'
}

// Save is offered once something changed, the days sit inside the limits and a
// home time, where the row has one's key, is whole or empty (staffHomeReady()).
export function canSaveEdit(row, form) {
  const mode = editMode(row)
  if (mode === 'none') return false
  if (Object.keys(editPatch(row, form)).length === 0) return false
  if (mode === 'full' && homeKeyed(row) && !staffHomeReady(form)) return false
  const days = mode === 'end_early' ? { from: row.from, to: (form || {}).to } : form
  return datesWithinBounds(days, editDateBounds(row, form))
}

// Where an edit form starts: the stored row, with its home time when the row
// carries one's key (the server's requests flag). End early starts at today,
// moved inside the server's limits, so one tap ends the time off as early as
// allowed (the stored end when today can't be read).
export function editFormFor(row, today) {
  const r = row || {}
  const form = { kind: r.kind, from: r.from, to: r.to, reason: reasonText(r.reason), ...homeFormFields(r) }
  if (editMode(r) === 'end_early' && isAvailabilityDay(today)) {
    const b = editDateBounds(r, form)
    let to = laterDay(today, b.toMin)
    if (b.toMax && to > b.toMax) to = b.toMax
    form.to = to
  }
  return form
}

// ── Time off over loads he already has (R11b) ───────────────────────────────
// With the server's DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED on, a create or an
// edit that covers loads the driver already has answers 409 DRIVER_HAS_LOADS:
// { error (the words), driver, from, to, loads: [{ loadId, from, to }] }, each
// Load ID as the server shows this user (broker contact withheld for every role
// but Super Admin). The server decides which loads warn. "Save anyway" re-sends
// the same body with those loads echoed back as `confirmLoads`; if the list changed meanwhile
// the server asks again with the new one. A save it could not check (Job
// Tracking unreadable) answers `loadsUnchecked: true`.

export const LOADS_UNCHECKED_NOTE = 'Loads couldn\'t be checked. Look at the Job Board for his loads.'

// The 409 a time-off save gives over his loads, from a useApi() error.
export function isDriverHasLoadsWarning(err) {
  return !!err && err.status === 409 && err.code === 'DRIVER_HAS_LOADS'
}

// The "Save anyway" body: `body` as it was sent, plus `confirmLoads`, the
// warning's loads as { loadId, from, to } (a later warning's list replaces an
// earlier echo). Copied as the server sent them; nothing is worked out here.
export function withLoadsConfirmed(body, warning) {
  const loads = warning && Array.isArray(warning.loads) ? warning.loads : []
  return {
    ...(body || {}),
    confirmLoads: loads.filter((l) => l && typeof l === 'object').map((l) => ({ loadId: l.loadId, from: l.from, to: l.to })),
  }
}

// The note after a save the server could not check against his loads ("" otherwise).
export function loadsUncheckedNote(reply) {
  return reply && reply.loadsUnchecked === true ? LOADS_UNCHECKED_NOTE : ''
}

// ── The driver's own screen (R11 follow-up) ─────────────────────────────────
// GET /api/driver/:driverName carries `timeOff: { today, rows }` only while the
// server's DRIVER_TIME_OFF_SCREEN_ENABLED is on. He sees his current and
// upcoming rows: the dates, the kind and whether he is off now. Each row is
// rebuilt from those five fields, so nothing else the payload might carry
// reaches his screen.

const DRIVER_STATUSES = ['current', 'upcoming']
const BANNER_LEAD_DAYS = 7

// His current and upcoming rows, by first day, as { id, kind, from, to, status },
// plus `home` ({ city, state }) on a row that names a home time.
export function driverTimeOffRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => r && typeof r === 'object' && DRIVER_STATUSES.includes(r.status) && isAvailabilityDay(r.from) && isAvailabilityDay(r.to) && r.from <= r.to)
    .map((r) => ({ id: r.id, kind: r.kind, from: r.from, to: r.to, status: r.status, ...homeKey(r) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

// The Loads banner: "You're marked off Oct 14 – Oct 20 (Vacation)." while
// today is inside a row; "Time off coming up: Oct 21 – Oct 23." when the
// nearest row starts within the next 7 days; "" otherwise. `today` is the
// server's business day.
export function driverTimeOffBanner(rows, today) {
  if (!isAvailabilityDay(today)) return ''
  const list = driverTimeOffRows(rows)
  const now = list.find((r) => r.from <= today && today <= r.to)
  if (now) return `You're marked off ${availabilityRangeText(now.from, now.to)} (${kindLabel(now.kind)}).`
  const next = list.find((r) => r.from > today && dayIndex(r.from) - dayIndex(today) <= BANNER_LEAD_DAYS)
  return next ? `Time off coming up: ${availabilityRangeText(next.from, next.to)}.` : ''
}

// ── A driver's own request (D's rules of 2026-10-31) ────────────────────────
// With the server's DRIVER_TIME_OFF_REQUESTS_ENABLED on, `timeOff` also carries
// `requests` ([{ id, kind, from, to, request: "waiting" | "declined",
// canCancel }]), `requestLimits` ({ fromMin, fromMax, maxDays, waitingMax }) and
// `canRequest`. The server decides every day: the form starts at fromMin, which
// it worked out from its own business day, and it refuses anything else in
// words. Nothing here counts days ahead from the phone's clock.

export const REQUEST_HINT = 'Ask at least 5 days ahead. Dispatch approves each request. For sooner days or changes, message dispatch.'
export const RECORDED_HINT = 'Dispatch records your time off. To change it, message dispatch.'
const REQUEST_STATES = ['waiting', 'declined']

// A day key from whole days since 1970-01-01 (Howard Hinnant's civil_from_days):
// integer arithmetic only, so no Date and no zone is involved.
function keyFromDayIndex(n) {
  const z = n + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// `key` moved by n whole days ("" for a key that is not a day).
export function shiftDayKey(key, n) {
  return isAvailabilityDay(key) && Number.isInteger(n) ? keyFromDayIndex(dayIndex(key) + n) : ''
}

// Their waiting and declined requests, by first day, each rebuilt from
// { id, kind, from, to, request, canCancel } only, plus `home` on one that names
// a home time.
export function driverRequestRows(requests) {
  if (!Array.isArray(requests)) return []
  return requests
    .filter((r) => r && typeof r === 'object' && REQUEST_STATES.includes(r.request) && isAvailabilityDay(r.from) && isAvailabilityDay(r.to) && r.from <= r.to)
    .map((r) => ({ id: r.id, kind: r.kind, from: r.from, to: r.to, request: r.request, canCancel: r.request === 'waiting' && r.canCancel === true, ...homeKey(r) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

// What a request's card row says about it.
export function driverRequestStatusText(r) {
  if (r && r.request === 'waiting') return 'Waiting for approval'
  if (r && r.request === 'declined') return 'Not approved. Message dispatch.'
  return ''
}

// Where the request form starts: the first day the server allows, for one day,
// "Off duty" (the server's default kind), and the home time at the server's
// `homeDefault` (his Drivers page city and state; a state off the list starts blank).
export function requestFormStart(limits, homeDefault) {
  const from = isAvailabilityDay((limits || {}).fromMin) ? limits.fromMin : ''
  const d = homeDefault && typeof homeDefault === 'object' ? homeDefault : {}
  return { kind: 'off_duty', from, to: from, homeCity: typeof d.city === 'string' ? d.city : '', homeState: STATE_CODES.has(d.state) ? d.state : '' }
}

// The form's date limits from the server's requestLimits: the first day from
// fromMin to fromMax; the last day from the form's first day to the last one
// the server's maxDays allows.
export function requestFormBounds(limits, form) {
  const l = limits || {}
  const from = isAvailabilityDay((form || {}).from) ? form.from : null
  const max = countOrNull(l.maxDays)
  return {
    fromMin: dayOrNull(l.fromMin),
    fromMax: dayOrNull(l.fromMax),
    toMin: laterDay(from, l.fromMin),
    toMax: from && max ? shiftDayKey(from, max - 1) : null,
  }
}

// Send is offered once both days are real days inside those limits and the
// home time is filled in (homeReady(): the server requires it on his request).
export function canSendRequest(form, limits) {
  const f = form || {}
  const b = requestFormBounds(limits, f)
  if (!b.fromMin || !isAvailabilityDay(f.from) || !isAvailabilityDay(f.to)) return false
  if (f.from < b.fromMin || (b.fromMax && f.from > b.fromMax)) return false
  if (f.to < b.toMin || (b.toMax && f.to > b.toMax)) return false
  if (!homeReady(f)) return false
  return AVAILABILITY_KINDS.some((k) => k.value === f.kind)
}

// The body a request sends: the two days, the kind and the home time (the city
// trimmed), never anything else.
export function requestBody(form) {
  const f = form || {}
  return { kind: f.kind, from: f.from, to: f.to, homeCity: homePart(f.homeCity), homeState: homePart(f.homeState) }
}

// ── Home time (H1) ──────────────────────────────────────────────────────────
// With the server's DRIVER_TIME_OFF_REQUESTS_ENABLED on, `timeOff` carries
// `homeDefault` (where his request form starts) and each row and request `home`
// ({ city, state } or null); each staff row carries `home`, and the staff list
// `homeTime: true` for the add form. His request must name a city and a state;
// a staff row both or neither. The server checks every rule (a city name, not
// digits or contact details) and refuses in its own words: the forms only hold
// back a blank city, one over 60 characters, or a state not on the list.

export const HOME_CITY_MAX = 60
const STATE_CODES = new Set(US_STATES.map((s) => s.code))
const homePart = (v) => (typeof v === 'string' ? v.trim() : '')

// { city, state } when both are text, else null.
function homeOf(h) {
  return h && typeof h === 'object' && typeof h.city === 'string' && h.city && typeof h.state === 'string' && h.state ? { city: h.city, state: h.state } : null
}

// `{ home }` for a row that names a home time, {} otherwise.
function homeKey(r) {
  const h = homeOf(r && r.home)
  return h ? { home: h } : {}
}

// Whether a staff row carries the `home` key (the server's requests flag).
const homeKeyed = (row) => !!row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'home')

// A staff row's home time as form fields ({} when the row has no `home` key).
function homeFormFields(row) {
  if (!homeKeyed(row)) return {}
  const h = homeOf(row.home)
  return { homeCity: h ? h.city : '', homeState: h ? h.state : '' }
}

// Both parts filled in: a city of 1-60 characters and a state on the list.
export function homeReady(form) {
  const f = form || {}
  const city = homePart(f.homeCity)
  return city.length > 0 && city.length <= HOME_CITY_MAX && STATE_CODES.has(f.homeState)
}

// A staff form's home time: both parts (homeReady()) or neither.
export function staffHomeReady(form) {
  const f = form || {}
  return (!homePart(f.homeCity) && !homePart(f.homeState)) || homeReady(f)
}

// The staff add form's body: its days, kind and reason, and the home time's two
// parts ("" for none) only when the server offered it (`homeTime`).
export function createBody(form, homeTime) {
  const f = form || {}
  return {
    kind: f.kind, from: f.from, to: f.to, reason: reasonText(f.reason),
    ...(homeTime === true ? { homeCity: homePart(f.homeCity), homeState: homePart(f.homeState) } : {}),
  }
}

// "Springfield, MO" ("" for none).
export function homeLocationText(home) {
  const h = homeOf(home)
  return h ? `${h.city}, ${h.state}` : ''
}

// The driver's card: "Home time in Springfield, MO" ("" for none).
export function homeTimeText(home) {
  const t = homeLocationText(home)
  return t ? `Home time in ${t}` : ''
}

// The staff panel: "Home time: Springfield, MO" ("" for none).
export function panelHomeText(row) {
  const t = homeLocationText(row && row.home)
  return t ? `Home time: ${t}` : ''
}

// ── Staff: a request on the in-app notice and in the Drivers panel ──────────
// The notice (type "time-off-request") carries { availabilityId, directoryId }
// in its metadata, and the decision once made ({ decision, decidedBy }); a live
// notice nests its whole payload in `metadata`, so both shapes are read.

const DECISIONS = ['approved', 'declined', 'cancelled']

function parseMeta(meta) {
  if (meta && typeof meta === 'object') return meta
  if (typeof meta !== 'string') return null
  try {
    const v = JSON.parse(meta || '{}')
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// { availabilityId, decision, decidedBy } of a time-off-request notice, decision
// "" while it waits; null for any other notice.
export function timeOffRequestOfNotice(n) {
  if (!n || n.type !== 'time-off-request') return null
  const meta = parseMeta(n.metadata)
  if (!meta) return null
  const inner = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : meta
  const id = Number(inner.availabilityId)
  if (!Number.isInteger(id) || id <= 0) return null
  const decision = DECISIONS.includes(inner.decision) ? inner.decision : ''
  return { availabilityId: id, decision, decidedBy: decision && typeof inner.decidedBy === 'string' ? inner.decidedBy : '' }
}

// The notice with a decision written in (a live update or this user's own tap),
// its metadata kept in the shape it came in.
export function noticeWithDecision(n, availabilityId, decision, decidedBy) {
  const req = timeOffRequestOfNotice(n)
  if (!req || req.availabilityId !== Number(availabilityId) || !DECISIONS.includes(decision)) return n
  const meta = parseMeta(n.metadata) || {}
  const by = typeof decidedBy === 'string' ? decidedBy : ''
  const next = meta.metadata && typeof meta.metadata === 'object'
    ? { ...meta, metadata: { ...meta.metadata, decision, decidedBy: by } }
    : { ...meta, decision, decidedBy: by }
  return { ...n, metadata: typeof n.metadata === 'string' ? JSON.stringify(next) : next }
}

// What a decided request says: "Approved by dispatch_t", "Declined by
// dispatch_t", "Cancelled by the driver", or, when the driver was removed from
// the Drivers list, "Cancelled: driver removed from the Drivers list"; "" while
// it waits.
export function requestDecisionText(decision, decidedBy) {
  const by = typeof decidedBy === 'string' && decidedBy.trim() ? decidedBy.trim() : 'staff'
  if (decision === 'approved') return `Approved by ${by}`
  if (decision === 'declined') return `Declined by ${by}`
  if (decision === 'cancelled') return decidedBy === 'system' ? 'Cancelled: driver removed from the Drivers list' : 'Cancelled by the driver'
  return ''
}

// Which list of the Drivers panel a staff row goes in: "waiting" (a driver's
// request still waiting, shown first), "live" (approved time off from today on)
// or "past" (ended, cancelled or declined). A row with no `request` key (the
// requests flag off) goes by its status alone.
export function panelGroup(row) {
  const r = row || {}
  if (r.status === 'cancelled') return 'past'
  if (r.request === 'waiting') return 'waiting'
  if (r.request === 'declined') return 'past'
  return r.status === 'current' || r.status === 'upcoming' ? 'live' : 'past'
}

// The word on a row of the past list.
export function panelPastText(row) {
  const r = row || {}
  if (r.status === 'cancelled') return 'Cancelled'
  if (r.request === 'declined') return 'Declined'
  return 'Ended'
}

// Who asked and who decided, for a row the panel shows: "Asked by the driver"
// on a request still waiting; "Asked by the driver, approved by X" or
// "...declined by X" once decided; "" for a row staff recorded or no request keys.
export function panelRequestText(row) {
  const r = row || {}
  if (r.source !== 'driver') return ''
  if (r.request === 'waiting') return 'Asked by the driver'
  const by = typeof r.decidedBy === 'string' && r.decidedBy ? r.decidedBy : 'staff'
  if (r.request === 'approved') return `Asked by the driver, approved by ${by}`
  if (r.request === 'declined') return `Asked by the driver, declined by ${by}`
  return ''
}
