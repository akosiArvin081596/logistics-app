// The Drivers page's "Driver notices" section, for a Super Admin: which driver confirmed which notice, and
// when (GET /api/admin/driver-release/acknowledgements, lib/driver-releases.js acknowledgementRecord()),
// and the words drivers read: each notice's lines and its tour's steps, then the whole app tour. The lines
// come on the record from the server's list, and the steps are TOUR_STEPS, walked as the driver's own tour
// walks them, so the words are never a copy. Pure. Times are on the app's own clock. Pinned by
// scripts/test-driver-release-notices-client.mjs.
import { fmtAppInstant, fmtYmd } from '../utils/datetime.js'
import { APP_TOUR_STEP_IDS, TOUR_STEPS, WORDS, tourStepsFor } from './driverReleaseNotices.js'

export const RECORD_URL = '/api/admin/driver-release/acknowledgements'

export const RECORD_WORDS = Object.freeze({
  heading: 'Driver notices',
  acknowledged: 'Acknowledged',
  notYet: 'Not yet',
  startedAfter: 'Started after this notice',
  noName: 'No name on file',
  unreadable: "Driver notices couldn't be loaded. Try again later.",
  lines: 'What drivers read',
  tour: `The tour from ${WORDS.showMe}`,
  appTour: 'The app tour',
  appTourWhen: 'Offered to a first-time driver; any driver can take it from the Kit.',
  performanceOnly: 'Performance drivers only',
})

export const countLine = (acknowledged, asked) => `${acknowledged} of ${asked} acknowledged`

function rowText(driver) {
  if (driver.state === 'acknowledged') return `${RECORD_WORDS.acknowledged} ${fmtAppInstant(driver.at, { fallback: '' })}`.trim()
  return driver.state === 'not-yet' ? RECORD_WORDS.notYet : RECORD_WORDS.startedAfter
}

const STATES = new Set(['acknowledged', 'not-yet', 'started-after'])
const isCount = (n) => Number.isInteger(n) && n >= 0
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Who reads a line, by the part of the app it needs: every driver, or only one whose app has that part. A
// part the app doesn't know is no driver's, so on the driver's screen, and here, its line is left out.
const ONLY = new Map([['performance', RECORD_WORDS.performanceOnly]])
// A driver whose app has every part walks every step any driver does.
const EVERY_PART = Object.freeze(Object.fromEntries([...ONLY.keys()].map((part) => [part, true])))

// A notice's lines, each with who reads it, read as the driver's app reads them.
function linesView(notes) {
  if (!Array.isArray(notes)) return []
  return notes.flatMap((n) => {
    if (!isPlainObject(n) || typeof n.text !== 'string' || n.text.trim() === '') return []
    const need = typeof n.needs === 'string' ? n.needs : ''
    if (need === '') return [{ text: n.text, only: '' }]
    return ONLY.has(need) ? [{ text: n.text, only: ONLY.get(need) }] : []
  })
}

// A tour's steps, by their ids, as a driver with every part walks them: each step's title, its own text,
// and the sentence a driver with the Performance tab reads after it, each with who reads it.
function stepsView(ids) {
  return tourStepsFor(ids, EVERY_PART).map(({ id }) => {
    const step = TOUR_STEPS.find((s) => s.id === id)
    const lines = [{ text: step.text, only: step.needs ? ONLY.get(step.needs) : '' }]
    if (step.withPerformance) lines.push({ text: step.withPerformance, only: ONLY.get('performance') })
    return { id, title: step.title, lines }
  })
}

// The whole app tour, once under the notices: a first-time driver's offer and the Kit's button walk it.
export const appTourView = () => stepsView(APP_TOUR_STEP_IDS)

// The answer as the section shows it, or null when it can't be read: then the section says so. A notice
// with no words on it (an older server) shows its record alone.
export function recordView(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notices)) return null
  return raw.notices
    .filter((n) => n && typeof n.id === 'string' && typeof n.title === 'string' && Array.isArray(n.drivers) && isCount(n.acknowledged) && isCount(n.asked))
    .map((n) => ({
      id: n.id,
      title: n.title,
      date: fmtYmd(n.date, { fallback: '' }),
      count: countLine(n.acknowledged, n.asked),
      lines: linesView(n.notes),
      steps: stepsView(n.tour),
      rows: n.drivers
        .filter((x) => x && STATES.has(x.state))
        .map((x) => ({ name: String(x.name || '').trim() || RECORD_WORDS.noName, state: x.state, text: rowText(x) })),
    }))
}
