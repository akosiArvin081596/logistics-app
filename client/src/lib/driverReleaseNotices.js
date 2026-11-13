// New-feature notices for drivers: whether the app can show a driver what's new as they sign in, and the
// words of the note's buttons and the tour. Pure: every input is passed in. The server keeps the list and
// says what's unread (lib/driver-release-routes.js); composables/useDriverRelease.js does the rest. Pinned
// by scripts/test-driver-release-notices-client.mjs.

export const RELEASE_URL = '/api/driver/me/release'
export const ACK_URL = `${RELEASE_URL}/acknowledge`
export const SEEN_URL = `${RELEASE_URL}/seen`
export const TOUR_DONE_URL = `${RELEASE_URL}/tour-done`
// lib/driver-releases.js holds the same name: a first-time driver's offer and the whole tour.
export const APP_TOUR_ROW = 'app-tour'

export const WORDS = Object.freeze({
  notesHeading: "What's new",
  notesEncourage: 'Take a minute to see it for yourself.',
  acknowledgeLine: "Tap I acknowledge to confirm you've read and agree to what's new.",
  acknowledge: 'I acknowledge',
  showMe: 'Show me',
  notSaved: "We couldn't save that. We'll ask again next time you sign in.",
  offerHeading: 'Welcome to the LogisX app',
  offerText: 'A quick tour shows you how the app works. We suggest taking it now. You can also take it later from your Kit.',
  takeTour: 'Take the tour',
  skipOffer: 'Skip for now',
  kitTitle: 'App tour',
  kitText: 'See how the app works, one screen at a time.',
  kitButton: 'Take the app tour',
  whenParked: 'You can take the tour once the truck is parked.',
  tourNext: 'Next',
  tourDone: 'Done',
  tourSkip: 'Skip',
  tourVideos: 'Watch the training videos',
})

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// ── The tour ──────────────────────────────────────────────────────────────

// Each step shows the real tab behind it. `needs` drops a step for a driver without that tab;
// `withPerformance` is one more sentence for a driver who has it. The Past Performance step states the
// general rule, figures and all; a week with approved time off can show a lower one on the tab.
export const TOUR_STEPS = Object.freeze([
  Object.freeze({ id: 'loads', tab: 'loads', title: 'Loads', text: 'This is your list of loads. Active, Pending and Historical sort them.', withPerformance: 'The bar at the top shows your loads this week. Tap it to open Past Performance.' }),
  Object.freeze({ id: 'load-page', tab: 'loads', title: "A load's page", text: "Tap a load to open its page. That's where you update your status and add your POD." }),
  Object.freeze({ id: 'alerts', tab: 'notifications', title: 'Alerts', text: 'New loads, changes and other notices show up here.' }),
  Object.freeze({ id: 'kit', tab: 'kit', title: 'Kit', text: "Your documents and your truck's documents are here. You can take this tour again from here any time." }),
  Object.freeze({ id: 'messages', tab: 'messages', title: 'Messages', text: 'Message dispatch here, about a load or anything else.' }),
  Object.freeze({ id: 'invoices', tab: 'invoices', title: 'Invoices', text: 'Your weekly invoices are here. You can check one and send it in.' }),
  Object.freeze({ id: 'performance', tab: 'performance', needs: 'performance', title: 'Past Performance', text: "Here's your weekly performance. It shows your target turns and the minimum turns required. Each turn counts as .50, with the weekly requirement of 6 total turns, and a target of 7.5 weekly." }),
  Object.freeze({ id: 'fuel-range', tab: 'loads', title: 'Fuel range', text: "The top of the app shows your fuel range when it's known: how many miles you have left until empty." }),
])
export const APP_TOUR_STEP_IDS = Object.freeze(TOUR_STEPS.map((s) => s.id))

// What this driver's app has. An unknown need is a part of the app they may not have, so it's dropped.
const hasPart = (need, has) => !need || (isPlainObject(has) && has[need] === true)

// The steps to walk, in the order asked, each once, as they'd read them.
export function tourStepsFor(ids, has) {
  const asked = Array.isArray(ids) ? [...new Set(ids)] : []
  return asked
    .map((id) => TOUR_STEPS.find((s) => s.id === id))
    .filter((s) => s && hasPart(s.needs, has))
    .map((s) => ({ id: s.id, tab: s.tab, title: s.title, text: s.withPerformance && hasPart('performance', has) ? `${s.text} ${s.withPerformance}` : s.text }))
}

// One step's card. The release tour, from the note's Show me, runs Next … I acknowledge with no Skip, so
// it ends in the note's own answer; the app tour keeps Skip, Done and the training videos at its end.
export function tourCardView(steps, index, release = false) {
  if (!Array.isArray(steps) || !steps[index]) return null
  const last = index === steps.length - 1
  const fromNote = release === true
  return {
    label: `Step ${index + 1} of ${steps.length}`,
    title: steps[index].title,
    text: steps[index].text,
    last,
    next: !last ? WORDS.tourNext : fromNote ? WORDS.acknowledge : WORDS.tourDone,
    skip: !fromNote,
    videos: last && !fromNote,
  }
}

// ── What the server said ──────────────────────────────────────────────────

const isReleaseId = (id) => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id)
const isText = (t) => typeof t === 'string' && t.trim() !== ''

function noteEntries(raw) {
  return raw.filter((e) => isPlainObject(e) && isReleaseId(e.id) && isText(e.title) && Array.isArray(e.notes)).map((e) => ({
    id: e.id,
    title: e.title,
    notes: e.notes.filter((n) => isPlainObject(n) && isText(n.text)).map((n) => ({ text: n.text, needs: typeof n.needs === 'string' ? n.needs : '' })),
    tour: Array.isArray(e.tour) ? e.tour.filter((id) => typeof id === 'string') : [],
  }))
}

// null is no answer: useApi turns a proxy's page, or an older server's, into `{}`, and that says
// nothing about a release. Anything else on the answer is dropped.
export function releaseFromAnswer(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.notes) || typeof raw.tourOffered !== 'boolean') return null
  return { notes: noteEntries(raw.notes), tourOffered: raw.tourOffered }
}

// The lines this driver can use. An entry left with none isn't shown or marked seen, so they still
// get it if they have that part of the app later. One with a line left is marked seen whole, so a
// driver who gets the rest of the app after that isn't told again.
export function notesForScreen(entries, has) {
  if (!Array.isArray(entries)) return []
  return entries
    .map((e) => ({ id: e.id, title: e.title, tour: e.tour, lines: e.notes.filter((n) => hasPart(n.needs, has)).map((n) => n.text) }))
    .filter((e) => e.lines.length > 0)
}

// ── When ──────────────────────────────────────────────────────────────────

// Whether "What's new" or the tour offer can open, asked once, as a sign-in's answer lands. A no doesn't
// wait: nothing gets marked, so it comes at their next sign-in, never later on this page. A working load
// doesn't stop it, so a driver at a shipper can read it, and it doesn't read the truck: it follows a
// password they've just typed, and it's one tap. Not knowing whether they have the Performance tab does
// stop it: answered now, the note would be marked seen without those lines.
export function noteMoment(s) {
  if (s.onboarding !== false || s.partsKnown !== true) return false
  if (s.tab !== 'loads' || s.loadOpen !== false) return false
  return s.welcomeOpen === false && s.dialogOpen === false
}
