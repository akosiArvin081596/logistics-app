// A driver's recorded time off, as the dispatch screens word it (R11).
//
// The dates are calendar days ("YYYY-MM-DD") on the business clock, never
// instants, so they are formatted from the text alone: no Date, no zone, and the
// same words for a dispatcher in any time zone. lib/driver-availability.js
// availabilityRangeText() says the same on the server (the 409 DRIVER_OFF_DUTY
// message); scripts/test-availability-range-text.mjs pins the two equal.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
