// The Drivers page's "Driver notices" section, for a Super Admin: which driver confirmed which notice, and
// when (GET /api/admin/driver-release/acknowledgements, lib/driver-releases.js acknowledgementRecord()).
// Pure. Times are on the app's own clock. Pinned by scripts/test-driver-release-notices-client.mjs.
import { fmtAppInstant, fmtYmd } from '../utils/datetime.js'

export const RECORD_URL = '/api/admin/driver-release/acknowledgements'

export const RECORD_WORDS = Object.freeze({
  heading: 'Driver notices',
  acknowledged: 'Acknowledged',
  notYet: 'Not yet',
  startedAfter: 'Started after this notice',
  noName: 'No name on file',
  unreadable: "Driver notices couldn't be loaded. Try again later.",
})

export const countLine = (acknowledged, asked) => `${acknowledged} of ${asked} acknowledged`

function rowText(driver) {
  if (driver.state === 'acknowledged') return `${RECORD_WORDS.acknowledged} ${fmtAppInstant(driver.at, { fallback: '' })}`.trim()
  return driver.state === 'not-yet' ? RECORD_WORDS.notYet : RECORD_WORDS.startedAfter
}

const STATES = new Set(['acknowledged', 'not-yet', 'started-after'])
const isCount = (n) => Number.isInteger(n) && n >= 0

// The answer as the section shows it, or null when it can't be read: then the section says so.
export function recordView(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notices)) return null
  return raw.notices
    .filter((n) => n && typeof n.id === 'string' && typeof n.title === 'string' && Array.isArray(n.drivers) && isCount(n.acknowledged) && isCount(n.asked))
    .map((n) => ({
      id: n.id,
      title: n.title,
      date: fmtYmd(n.date, { fallback: '' }),
      count: countLine(n.acknowledged, n.asked),
      rows: n.drivers
        .filter((x) => x && STATES.has(x.state))
        .map((x) => ({ name: String(x.name || '').trim() || RECORD_WORDS.noName, state: x.state, text: rowText(x) })),
    }))
}
