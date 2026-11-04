// The load detail's read-only pickup line under the arrival pickup date rule. The server
// sends `_pickupArrival` on each row only while the rule is on and decides every fact in it
// (lib/arrival-pickup-display.js); this only words them. Runner: scripts/test-arrival-pickup-display.mjs.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Sakamoto's weekday table: a calendar date's weekday by integer arithmetic, so no
// clock or zone can move it.
const WEEKDAY_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
const SOURCE_WORDS = Object.freeze({ gps: 'GPS', driver: "driver's tap" })
const PAY_NOTE = "editing the Pickup Appointment doesn't change it."

// 'YYYY-MM-DD' -> "Tue Dec 8", split as text ('' when it isn't a real day).
export function dayLabel(v) {
  const m = typeof v === 'string' ? DAY_RE.exec(v) : null
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  if (!days || d < 1 || d > days) return ''
  const yy = mo < 3 ? y - 1 : y
  const wd = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + WEEKDAY_OFFSETS[mo - 1] + d) % 7
  return `${WEEKDAYS[wd]} ${MONTHS[mo - 1]} ${d}`
}

// The line ('' when the row has no field, i.e. the rule is off, or nothing to say).
export function pickupArrivalLine(job) {
  const f = job && job._pickupArrival
  if (!f || typeof f !== 'object') return ''
  const scheduled = dayLabel(f.scheduled)
  const rateCon = scheduled ? ` Scheduled (rate con): ${scheduled}` : ''
  const day = dayLabel(f.day)
  const source = Object.hasOwn(SOURCE_WORDS, f.source) ? SOURCE_WORDS[f.source] : ''
  if (!day || !source) return scheduled ? `Pickup (rate con): ${scheduled}` : ''
  const atDay = dayLabel(f.atDay)
  const atTime = typeof f.atTime === 'string' ? f.atTime.trim() : ''
  if (!atDay || !atTime) return `Arrived at shipper ${day} (${source}). Pay starts this day; ${PAY_NOTE}${rateCon}`
  if (f.atDay === f.day) return `Arrived at shipper ${day}, ${atTime} (${source}). Pay starts this day; ${PAY_NOTE}${rateCon}`
  return `Arrived at shipper ${day} on the shipper's clock; ${atDay}, ${atTime} (${source}). Pay starts ${day}; ${PAY_NOTE}${rateCon}`
}
