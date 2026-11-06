// New-feature notices for drivers: when the app may sign a driver out after a release, when it may
// show him what's new, and the words of the note's buttons and the tour. Pure: every input is passed
// in. The server keeps the list and says what's due (lib/driver-release-routes.js); this decides
// when, and composables/useDriverRelease.js does the rest. Pinned by
// scripts/test-driver-release-notices-client.mjs.

export const RELEASE_URL = '/api/driver/me/release'
export const SEEN_URL = `${RELEASE_URL}/seen`
export const TOUR_DONE_URL = `${RELEASE_URL}/tour-done`
// lib/driver-releases.js holds the same name: a first-time driver's offer and the whole tour.
export const APP_TOUR_ROW = 'app-tour'

export const WORDS = Object.freeze({
  signedOut: 'The app was updated. Please sign in again.',
  notesHeading: "What's new",
  notesEncourage: 'Take a minute to see it for yourself.',
  showMe: 'Show me',
  gotIt: 'Got it',
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
// `withPerformance` is one more sentence for a driver who has it.
export const TOUR_STEPS = Object.freeze([
  Object.freeze({ id: 'loads', tab: 'loads', title: 'Loads', text: 'This is your list of loads. Active, Pending and Historical sort them.', withPerformance: 'The bar at the top shows your loads this week. Tap it to open Performance.' }),
  Object.freeze({ id: 'load-page', tab: 'loads', title: "A load's page", text: "Tap a load to open its page. That's where you update your status and add your POD." }),
  Object.freeze({ id: 'alerts', tab: 'notifications', title: 'Alerts', text: 'New loads, changes and other notices show up here.' }),
  Object.freeze({ id: 'kit', tab: 'kit', title: 'Kit', text: "Your documents and your truck's documents are here. You can take this tour again from here any time." }),
  Object.freeze({ id: 'messages', tab: 'messages', title: 'Messages', text: 'Message dispatch here, about a load or anything else.' }),
  Object.freeze({ id: 'invoices', tab: 'invoices', title: 'Invoices', text: 'Your weekly invoices are here. You can check one and send it in.' }),
  Object.freeze({ id: 'performance', tab: 'performance', needs: 'performance', title: 'Performance', text: "Your week is here: what counted, your target and, most weeks, what's required. No other driver can see it." }),
  Object.freeze({ id: 'fuel-range', tab: 'loads', title: 'Fuel range', text: "The top of the app shows your fuel range when it's known: how many miles you have left until empty. It's about your tank, not your load or route." }),
])
export const APP_TOUR_STEP_IDS = Object.freeze(TOUR_STEPS.map((s) => s.id))

// What this driver's app has. An unknown need is a part of the app he may not have, so it's dropped.
const hasPart = (need, has) => !need || (isPlainObject(has) && has[need] === true)

// The steps to walk, in the order asked, each once, as he'd read them.
export function tourStepsFor(ids, has) {
  const asked = Array.isArray(ids) ? [...new Set(ids)] : []
  return asked
    .map((id) => TOUR_STEPS.find((s) => s.id === id))
    .filter((s) => s && hasPart(s.needs, has))
    .map((s) => ({ id: s.id, tab: s.tab, title: s.title, text: s.withPerformance && hasPart('performance', has) ? `${s.text} ${s.withPerformance}` : s.text }))
}

export function tourCardView(steps, index) {
  if (!Array.isArray(steps) || !steps[index]) return null
  return { label: `Step ${index + 1} of ${steps.length}`, title: steps[index].title, text: steps[index].text, last: index === steps.length - 1 }
}

// ── What the server said ──────────────────────────────────────────────────

const isReleaseId = (id) => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id)
const isText = (t) => typeof t === 'string' && t.trim() !== ''

function noteEntries(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((e) => isPlainObject(e) && isReleaseId(e.id) && isText(e.title) && Array.isArray(e.notes)).map((e) => ({
    id: e.id,
    title: e.title,
    notes: e.notes.filter((n) => isPlainObject(n) && isText(n.text)).map((n) => ({ text: n.text, needs: typeof n.needs === 'string' ? n.needs : '' })),
    tour: Array.isArray(e.tour) ? e.tour.filter((id) => typeof id === 'string') : [],
  }))
}

// null is no answer: useApi turns a proxy's page, or an older server's, into `{}`, and that says
// nothing about a release. A sign-out needs a good id; anything else on the answer is dropped.
export function releaseFromAnswer(raw) {
  if (!isPlainObject(raw) || typeof raw.signInDue !== 'boolean') return null
  const releaseId = isReleaseId(raw.releaseId) ? raw.releaseId : ''
  const signInDue = raw.signInDue && !!releaseId
  return {
    signInDue,
    releaseId,
    notes: signInDue ? [] : noteEntries(raw.notes),
    tourOffered: !signInDue && raw.tourOffered === true,
  }
}

// The lines this driver can use. An entry left with none isn't shown or marked seen, so he still
// gets it if he has that part of the app later. One with a line left is marked seen whole, so a
// driver who gets the rest of the app after that isn't told again.
export function notesForScreen(entries, has) {
  if (!Array.isArray(entries)) return []
  return entries
    .map((e) => ({ id: e.id, title: e.title, tour: e.tour, lines: e.notes.filter((n) => hasPart(n.needs, has)).map((n) => n.text) }))
    .filter((e) => e.lines.length > 0)
}

// ── When ──────────────────────────────────────────────────────────────────

// A load he has finished, or an offer he hasn't taken, leaves him free. Anything else holds the
// sign-out, a status this file doesn't know or a blank one too: he gets the update at his next
// sign-in instead, within a day, whereas a wrong guess here could catch him mid-trip. An empty list
// holds as well: a reply that dropped on a weak signal, a sheet column that moved and a name that
// stopped matching all read as no loads, whatever he is really hauling.
const FINISHED_RE = /^(delivered|completed|pod received|cancel|canceled|cancelled)$/i
const OFFER_RE = /^dispatched$/i
export function loadsHoldSignOut(loads, headers) {
  if (!Array.isArray(loads) || loads.length === 0) return true
  const list = Array.isArray(headers) ? headers : []
  const col = list.find((h) => /^(job[\s._-]?)?status$/i.test(h)) || list.find((h) => /status/i.test(h))
  if (!col) return true
  return loads.some((load) => {
    const status = String((load && load[col]) ?? '').trim()
    return !FINISHED_RE.test(status) && !OFFER_RE.test(status)
  })
}

// How long the truck must have read as parked before a release may sign its driver out: past a light,
// a rail crossing or a stop in traffic, and short of a fuel stop, a break or a wait at a dock. A
// read-only count of how long real stops last backs this figure; change it here and nowhere else.
export const SIGN_OUT_PARKED_MS = 15 * 60 * 1000

// `state` and `stoppedSince` are the truck as the voice note gate reads it (lib/voiceNoteGate.js).
export function parkedLongEnough(state, stoppedSince, nowMs) {
  return state === 'parked' && Number.isFinite(stoppedSince) && nowMs - stoppedSince >= SIGN_OUT_PARKED_MS
}

// Whether this moment may sign him out. Every input must say so, in so many words: one that's
// missing holds the sign-out. The caller asks only as the app opens (lib/appOpening.js), straight
// after reading his loads and the truck afresh; never in a page already open, so it can't land under
// his thumb, and any other driver gets the update at his next sign-in.
// `parked` is parkedLongEnough(), stricter than the note's motionAllowed: a truck with no reading may
// be moving, and a truck stopped a short while may be at a light.
// `otherTabOpen` is lib/appTabs.js's answer, whose null (can't tell) holds as well.
export function signOutMoment(s) {
  if (!isPlainObject(s) || s.role !== 'Driver' || s.signInDue !== true) return false
  if (s.loaded !== true || s.onboarding !== false) return false
  if (s.tab !== 'loads' || s.loadOpen !== false) return false
  if (s.welcomeOpen !== false || s.dialogOpen !== false || s.tourOpen !== false) return false
  if (s.loadsHold !== false || s.writesBusy !== false || s.otherTabOpen !== false) return false
  if (s.visible !== true || s.online !== true) return false
  return s.parked === true
}

// Whether "What's new" or the tour offer may show now. Asked again whenever an input changes, so a
// note held back waits instead of being skipped. A working load doesn't hold it, so a driver at a
// shipper can read it; a moving truck, a load's page and another screen do. So does not yet knowing
// whether he has the Performance tab: answered now, the note would be marked seen without those lines.
export function noteMoment(s) {
  if (!isPlainObject(s) || s.role !== 'Driver' || s.signInDue !== false) return false
  if (s.settled !== true || s.onboarding !== false || s.partsKnown !== true) return false
  if (s.tab !== 'loads' || s.loadOpen !== false) return false
  if (s.welcomeOpen !== false || s.dialogOpen !== false || s.tourOpen !== false) return false
  return s.motionAllowed === true
}

// Anything on screen that a sign-out would throw away, from any component on the page. A hidden
// one has no boxes, so it doesn't count.
export function overlayOnScreen(doc) {
  try {
    const nodes = doc.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="overlay"]')
    return Array.from(nodes).some((el) => el.getClientRects().length > 0)
  } catch {
    return true
  }
}

export function fieldInFocus(doc) {
  try {
    return /^(INPUT|TEXTAREA|SELECT)$/.test(String(doc.activeElement?.tagName || ''))
  } catch {
    return true
  }
}

// ── What this browser keeps ───────────────────────────────────────────────

export function browserStorage(kind) {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

// The release this browser has already signed this driver out for. Should a server ever keep
// answering "due" after he signs back in, the app asks him once and no more: a loop would keep him
// out of the app. A browser that can't keep this gets no forced sign-out at all, and he gets the
// update at his next sign-in. By account, so a shared phone keeps each driver's apart.
const signedOutKey = (userId) => `logisx.driverRelease.signedOut.v1.${userId}`
export function signedOutFor(storage, userId, releaseId) {
  try {
    return storage.getItem(signedOutKey(userId)) === releaseId
  } catch {
    return false
  }
}
export function rememberSignOut(storage, userId, releaseId) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !isReleaseId(releaseId)) return false
  try {
    storage.setItem(signedOutKey(userId), releaseId)
    return storage.getItem(signedOutKey(userId)) === releaseId
  } catch {
    return false
  }
}

// The login page's line after such a sign-out: this tab's next look at that page only. It says
// nothing about who was signed out, so the next person on a shared phone learns nothing from it.
// A session the server confirms removes it (stores/auth.js), so a logout he asks for later never
// shows it.
export const LOGIN_NOTE_KEY = 'logisx.driverRelease.loginNote.v1'
export const LOGIN_NOTE_TTL_MS = 10 * 60 * 1000
export function leaveLoginNote(storage, nowMs) {
  try {
    storage.setItem(LOGIN_NOTE_KEY, String(nowMs))
  } catch {
    /* the login page just doesn't say why */
  }
}
// `keep` is for a page that has started a sign-out: this view mounts on it first, and a fresh /login
// may be about to replace it, so taking the note there would leave the page he reads without it.
// With no signal no fresh page comes, and he reads it here until he signs in.
export function takeLoginNote(storage, nowMs, keep = false) {
  let raw = null
  try {
    raw = storage.getItem(LOGIN_NOTE_KEY)
    if (!keep) storage.removeItem(LOGIN_NOTE_KEY)
  } catch {
    return false
  }
  if (raw === null) return false
  const age = nowMs - Number(raw)
  return age >= 0 && age <= LOGIN_NOTE_TTL_MS
}
