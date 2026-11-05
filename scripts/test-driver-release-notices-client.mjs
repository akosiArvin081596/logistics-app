#!/usr/bin/env node
// New-feature notices for drivers, the app's side: the rules in client/src/lib/driverReleaseNotices.js,
// composables/useDriverRelease.js driven for real on Vue's own reactivity, and how DriverView.vue,
// LoginView.vue and the two components use them. The server's side is
// scripts/test-driver-release-notices.js; scripts/e2e/driver-release-notices.mjs covers the page.
//   §1  the words, exact, and plain: no figure, no name, no word a driver wouldn't use; none that's
//       false for a driver who can read it
//   §2  signOutMoment(): every safe-moment input holds the sign-out on its own, and a missing one does
//   §3  noteMoment(): the same, except that a working load doesn't hold a note
//   §4  loadsHoldSignOut(): In Transit and every status short of done hold it; so does one nobody knows,
//       and so does an empty list
//   §5  releaseFromAnswer(): what an answer may and may not say; an unreadable body says nothing
//   §6  notesForScreen(), tourStepsFor(), tourCardView(): only what this driver's app has
//   §7  what the browser keeps: once per release per account; the login line once; no storage, no sign-out
//   §8  overlayOnScreen() and fieldInFocus(): a dialog from any component, a field he's typing in
//   §9  writesBusy() and useApi: a write on the wire holds the sign-out, and a moment after it
//   §10 the sign-out through useDriverRelease: only when due and safe; never in transit or mid-action;
//       fresh facts first; a failed read changes nothing; another tab of the app holds it; no loop; only
//       a Driver, off the lock screen
//   §11 the note, the offer and the tour through useDriverRelease: once, what each writes, skip, motion;
//       the note waits for the Performance answer
//   §12 DriverView.vue: he asks by his own moves and no others: a cancel, a refetch or a tab taken away
//       closing a page starts no check, run on the view's own statements; no timer, no socket; the tour
//       marks nothing read
//   §13 the components and LoginView.vue
//   §14 only the driver app and the session store read any of it
//   §15 the real driver store and the real truck read, over a stubbed fetch: a reply whose body drops, an
//       empty list, a truck with no reading and a failed read of it all hold the sign-out
//   §16 lib/appTabs.js: each page's record in the browser's storage: another page's holds, frozen or
//       silent too, until it leaves or a day has passed; a page's own never does; a browser that can't
//       keep them says so; they hold no name or account and can't pile up
//
// No DOM, no server, no build.
//   node scripts/test-driver-release-notices-client.mjs      # exits 1 on any failure
import fs from 'fs'
import { registerHooks } from 'module'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client', 'src')
// The driver store and the truck read import without an extension, as Vite allows; plain Node needs a hand.
const CLIENT_URL = pathToFileURL(CLIENT).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && String(context.parentURL || '').startsWith(CLIENT_URL)) {
      const asJs = new URL(`${specifier}.js`, context.parentURL)
      if (fs.existsSync(fileURLToPath(asJs))) return nextResolve(asJs.href, context)
    }
    return nextResolve(specifier, context)
  },
})
const load = (rel) => import(pathToFileURL(path.join(CLIENT, rel)).href)
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8')

let pass = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) { pass++; return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
const section = (title) => console.log(`§ ${title}`)

let lib, composable, writes, vue, useApiModule
try {
  lib = await load('lib/driverReleaseNotices.js')
  writes = await load('lib/writesInFlight.js')
  composable = await load('composables/useDriverRelease.js')
  useApiModule = await load('composables/useApi.js')
  vue = await import(pathToFileURL(path.join(ROOT, 'client', 'node_modules', 'vue', 'index.mjs')).href)
} catch (e) {
  console.log(`  FAIL  the app's side must load: ${e.message}`)
  console.log('\nFAILED: 1 of 1')
  process.exit(1)
}
const { WORDS, TOUR_STEPS, APP_TOUR_STEP_IDS, APP_TOUR_ROW, RELEASE_URL, SEEN_URL, TOUR_DONE_URL } = lib
const { useDriverRelease } = composable
const { reactive, nextTick } = vue

const tick = async () => { await new Promise((r) => setImmediate(r)); await nextTick() }

// ── §1 ────────────────────────────────────────────────────────────────────
section('1 the words')
eq('the routes', [RELEASE_URL, SEEN_URL, TOUR_DONE_URL], ['/api/driver/me/release', '/api/driver/me/release/seen', '/api/driver/me/release/tour-done'])
eq('the login line', WORDS.signedOut, 'The app was updated. Please sign in again.')
eq("the note's words", [WORDS.notesHeading, WORDS.showMe, WORDS.gotIt], ["What's new", 'Show me', 'Got it'])
eq("the offer's buttons", [WORDS.takeTour, WORDS.skipOffer], ['Take the tour', 'Skip for now'])
eq("the Kit's button", WORDS.kitButton, 'Take the app tour')
eq("the tour's buttons", [WORDS.tourNext, WORDS.tourSkip, WORDS.tourDone], ['Next', 'Skip', 'Done'])
ok('the offer suggests the tour and says it can wait', /suggest/.test(WORDS.offerText) && /later/.test(WORDS.offerText))
eq('the steps, in order', APP_TOUR_STEP_IDS, ['loads', 'load-page', 'alerts', 'kit', 'messages', 'invoices', 'performance', 'fuel-range'])
eq('each step shows the real tab', TOUR_STEPS.map((s) => s.tab), ['loads', 'loads', 'notifications', 'kit', 'messages', 'invoices', 'performance', 'loads'])
const allWords = [...Object.values(WORDS), ...TOUR_STEPS.flatMap((s) => [s.title, s.text, s.withPerformance].filter(Boolean))]
const APP_WORDS = new Set(['Loads', 'Performance', 'Alerts', 'Kit', 'Messages', 'Invoices', 'Active', 'Pending', 'Historical', 'POD', 'LogisX', 'What', 'Fuel', 'A', 'The'])
for (const line of allWords) {
  ok(`no figure: "${line}"`, !/[\d$#%@]/.test(line) && !/\b(half|dollars?|percent)\b/i.test(line))
  ok(`no word he wouldn't use: "${line}"`, !/\b(session|deploy|release|server|api|bug|flag|sheet|database|endpoint|cache|token)\b/i.test(line))
  for (const sentence of line.split(/(?<=[.!?:])\s+/)) {
    for (const word of sentence.split(/\s+/).slice(1)) {
      const bare = word.replace(/[^A-Za-z]/g, '')
      ok(`no name: "${bare}" in "${line}"`, !/^[A-Z]/.test(bare) || APP_WORDS.has(bare))
    }
  }
}
const fuelStep = TOUR_STEPS.find((s) => s.id === 'fuel-range').text
ok("the fuel step says what it isn't", /not your load or route/.test(fuelStep))
eq("the fuel step, exact: it says when, since no reading or no tank size on file shows no figure", fuelStep, "The top of the app shows your fuel range when it's known: how many miles you have left until empty. It's about your tank, not your load or route.")
eq('the performance step says most weeks: a week of time off can have no required figure', TOUR_STEPS.find((s) => s.id === 'performance').text, "Your week is here: what counted, your target and, most weeks, what's required. No other driver can see it.")
ok("nothing else claims what's required without saying most weeks", allWords.every((line) => !/what's required/.test(line) || /most weeks/.test(line)))

// ── §2 ────────────────────────────────────────────────────────────────────
section('2 signOutMoment()')
const SAFE = Object.freeze({
  role: 'Driver', signInDue: true, loaded: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false,
  dialogOpen: false, tourOpen: false, loadsHold: false, writesBusy: false, otherTabOpen: false, visible: true, online: true, parked: true,
})
eq('due, on the list, nothing going on: he may be signed out', lib.signOutMoment(SAFE), true)
const HOLDS = [
  ['not due', { signInDue: false }],
  ['a Super Admin on /driver', { role: 'Super Admin' }],
  ['a Dispatcher', { role: 'Dispatcher' }],
  ['an Investor', { role: 'Investor' }],
  ['no role', { role: undefined }],
  ["his loads weren't read", { loaded: false }],
  ['the lock screen', { onboarding: true }],
  ['another tab', { tab: 'messages' }],
  ['a load open', { loadOpen: true }],
  ['the welcome window', { welcomeOpen: true }],
  ['a dialog or form', { dialogOpen: true }],
  ['the tour', { tourOpen: true }],
  ['a working load', { loadsHold: true }],
  ['something being sent', { writesBusy: true }],
  ['another window has the screen', { visible: false }],
  ['no signal', { online: false }],
  ['another tab of the app is open', { otherTabOpen: true }],
  ["a browser that can't tell about the other tabs", { otherTabOpen: null }],
  ['a truck that does not read as parked', { parked: false }],
  ['a truck with no reading: not moving is not enough', { parked: false, motionAllowed: true }],
]
for (const [label, change] of HOLDS) eq(`held: ${label}`, lib.signOutMoment({ ...SAFE, ...change }), false)
for (const key of Object.keys(SAFE)) {
  const missing = { ...SAFE }
  delete missing[key]
  eq(`held: ${key} not known`, lib.signOutMoment(missing), false)
}
eq('held: no inputs', lib.signOutMoment(null), false)
eq('held: a truthy word is not a yes', lib.signOutMoment({ ...SAFE, parked: 'yes' }), false)

// ── §3 ────────────────────────────────────────────────────────────────────
section('3 noteMoment()')
const FREE = Object.freeze({ role: 'Driver', signInDue: false, settled: true, partsKnown: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false, tourOpen: false, motionAllowed: true })
eq('on the list, parked: the note may show', lib.noteMoment(FREE), true)
eq('a working load does not hold it: he can read at a shipper', lib.noteMoment({ ...FREE, loadsHold: true }), true)
eq('a truck with no reading does not hold it: its gate stays as it was', lib.noteMoment({ ...FREE, parked: false }), true)
for (const [label, change] of [
  ['still behind', { signInDue: true }],
  ['a Super Admin', { role: 'Super Admin' }],
  ['before the first ELD read settles', { settled: false }],
  ['before the Performance answer is known', { partsKnown: false }],
  ['with no Performance answer at all', { partsKnown: undefined }],
  ['the lock screen', { onboarding: true }],
  ['another tab', { tab: 'kit' }],
  ['a load open', { loadOpen: true }],
  ['the welcome window', { welcomeOpen: true }],
  ['a dialog', { dialogOpen: true }],
  ['the tour', { tourOpen: true }],
  ['the truck moving', { motionAllowed: false }],
]) eq(`held: ${label}`, lib.noteMoment({ ...FREE, ...change }), false)

// ── §4 ────────────────────────────────────────────────────────────────────
section('4 loadsHoldSignOut()')
const HEADERS = ['Load ID', 'Job Status', 'Status Update Date']
const withStatus = (status) => [{ 'Load ID': 'QA-1', 'Job Status': status, 'Status Update Date': '2026-01-01' }]
for (const status of ['Assigned', 'Heading to Shipper', 'At Shipper', 'Loading', 'In Transit', 'in transit', ' In Transit ', 'At Receiver', 'Unloading', 'Picked Up', 'Some New Status', '']) {
  eq(`held: "${status}"`, lib.loadsHoldSignOut(withStatus(status), HEADERS), true)
}
for (const status of ['Delivered', 'delivered', 'Completed', 'POD Received', 'Dispatched', 'Cancelled', 'Canceled', 'cancel']) {
  eq(`free: "${status}"`, lib.loadsHoldSignOut(withStatus(status), HEADERS), false)
}
eq('held: no loads at all, which proves nothing about what he is hauling', lib.loadsHoldSignOut([], HEADERS), true)
eq('held: no list and no headers, as a reply whose body dropped leaves', lib.loadsHoldSignOut([], []), true)
eq('held: no list', lib.loadsHoldSignOut(undefined, HEADERS), true)
eq('held: one working load among finished ones', lib.loadsHoldSignOut([...withStatus('Delivered'), ...withStatus('In Transit')], HEADERS), true)
eq("held: a sheet with no status column can't say", lib.loadsHoldSignOut(withStatus('Delivered'), ['Load ID']), true)
eq('the status column, not the date beside it', lib.loadsHoldSignOut([{ 'Status Update Date': '2026-01-01', 'Job Status': 'Delivered' }], ['Status Update Date', 'Job Status']), false)

// ── §5 ────────────────────────────────────────────────────────────────────
section('5 releaseFromAnswer()')
const ID = '2026-11-06-my-week'
const ENTRY = { id: ID, title: 'A title', notes: [{ text: 'A line.' }, { text: 'A tab line.', needs: 'performance' }], tour: ['loads'] }
eq('no answer', lib.releaseFromAnswer(null), null)
eq("useApi's unreadable body says nothing", lib.releaseFromAnswer({}), null)
eq('a list says nothing', lib.releaseFromAnswer([]), null)
eq('a word for yes says nothing', lib.releaseFromAnswer({ signInDue: 'true', releaseId: ID }), null)
eq('due, with notes it may not show yet', lib.releaseFromAnswer({ signInDue: true, releaseId: ID, notes: [ENTRY], tourOffered: true }), { signInDue: true, releaseId: ID, notes: [], tourOffered: false })
eq('due with no good id is no sign-out', lib.releaseFromAnswer({ signInDue: true, releaseId: '' }).signInDue, false)
eq('due with a made-up id is no sign-out', lib.releaseFromAnswer({ signInDue: true, releaseId: '<b>' }).signInDue, false)
eq('not due, the notes as sent', lib.releaseFromAnswer({ signInDue: false, releaseId: ID, notes: [ENTRY], tourOffered: false }).notes[0], { id: ID, title: 'A title', notes: [{ text: 'A line.', needs: '' }, { text: 'A tab line.', needs: 'performance' }], tour: ['loads'] })
const decoyEntry = { ...ENTRY, driverName: 'Decoy Name', notes: [{ text: 'A line.', pay: 987 }] }
const copied = JSON.stringify(lib.releaseFromAnswer({ signInDue: false, releaseId: ID, notes: [decoyEntry], name: 'Decoy Name' }))
ok('nothing else on an answer gets through', !/Decoy|987|driverName|pay/.test(copied), copied)
eq('a broken note is dropped', lib.releaseFromAnswer({ signInDue: false, releaseId: ID, notes: [{ id: ID }, 'text', null] }).notes, [])

// ── §6 ────────────────────────────────────────────────────────────────────
section('6 only what his app has')
const OLD_ID = '2026-01-01-older'
const answered = lib.releaseFromAnswer({ signInDue: false, releaseId: ID, notes: [ENTRY, { id: OLD_ID, title: 'Older', notes: [{ text: 'Only with the tab.', needs: 'performance' }], tour: ['performance'] }] }).notes
eq('with the tab, every line', lib.notesForScreen(answered, { performance: true }).map((e) => e.lines), [['A line.', 'A tab line.'], ['Only with the tab.']])
eq('without it, those lines go', lib.notesForScreen(answered, { performance: false }).map((e) => e.lines), [['A line.']])
eq('an entry left with no line goes too', lib.notesForScreen(answered, { performance: false }).map((e) => e.id), [ID])
eq('a part of the app nobody knows is dropped', lib.notesForScreen([{ id: ID, title: 't', tour: [], notes: [{ text: 'x', needs: 'something-new' }] }], { performance: true }), [])
eq('no notes', lib.notesForScreen(null, {}), [])
eq('the steps asked for, in that order, each once', lib.tourStepsFor(['fuel-range', 'loads', 'fuel-range'], { performance: true }).map((s) => s.id), ['fuel-range', 'loads'])
eq('an unknown step is dropped', lib.tourStepsFor(['loads', 'made-up'], { performance: true }).map((s) => s.id), ['loads'])
eq('no Performance step without the tab', lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: false }).map((s) => s.id), ['loads', 'load-page', 'alerts', 'kit', 'messages', 'invoices', 'fuel-range'])
const [withBar] = lib.tourStepsFor(['loads'], { performance: true })
const [noBar] = lib.tourStepsFor(['loads'], { performance: false })
ok('the Loads step names the bar only to a driver who has one', /\bbar\b/.test(withBar.text) && !/\bbar\b/.test(noBar.text))
eq('step words', lib.tourCardView(lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: true }), 2).label, 'Step 3 of 8')
eq('not the last', lib.tourCardView(lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: true }), 2).last, false)
eq('the last', lib.tourCardView(lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: true }), 7).last, true)
eq('no card past the end', lib.tourCardView(lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: true }), 8), null)

// ── §7 ────────────────────────────────────────────────────────────────────
section('7 what the browser keeps')
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: (k) => { m.delete(k) }, keys: () => [...m.keys()], values: () => [...m.values()],
    get length() { return m.size }, key: (i) => [...m.keys()][i] ?? null,
  }
}
const brokenStorage = () => ({ getItem() { throw new Error('private mode') }, setItem() { throw new Error('private mode') }, removeItem() { throw new Error('private mode') } })
{
  const s = fakeStorage()
  eq('not yet', lib.signedOutFor(s, 2, ID), false)
  eq('recorded', lib.rememberSignOut(s, 2, ID), true)
  eq('this release, this driver', lib.signedOutFor(s, 2, ID), true)
  eq('the next release is another sign-out: two deploys in a day sign out twice', lib.signedOutFor(s, 2, '2026-11-07-next'), false)
  eq("a shared phone: another driver's own", lib.signedOutFor(s, 3, ID), false)
  ok('it keeps an account id and a release id, no name', s.keys().every((k) => /^logisx\.driverRelease\.signedOut\.v1\.\d+$/.test(k)) && s.values().every((v) => v === ID))
  eq('no good account, no record', lib.rememberSignOut(s, 'x', ID), false)
  eq('no good id, no record', lib.rememberSignOut(s, 2, 'made up'), false)
  eq('storage that throws reads as not yet', lib.signedOutFor(brokenStorage(), 2, ID), false)
  eq("storage that throws can't record it", lib.rememberSignOut(brokenStorage(), 2, ID), false)
  eq('no storage at all too', lib.rememberSignOut(null, 2, ID), false)
  const quietlyDrops = { getItem: () => null, setItem: () => {} }
  eq('storage that drops writes silently is found out', lib.rememberSignOut(quietlyDrops, 2, ID), false)
}
{
  const s = fakeStorage()
  const T = 1_800_000_000_000
  eq('no note', lib.takeLoginNote(s, T), false)
  lib.leaveLoginNote(s, T)
  eq('the note', lib.takeLoginNote(s, T + 1000), true)
  eq('once only', lib.takeLoginNote(s, T + 2000), false)
  lib.leaveLoginNote(s, T)
  eq('a page about to be replaced shows it', lib.takeLoginNote(s, T + 1000, true), true)
  eq('...and leaves it for the fresh page', lib.takeLoginNote(s, T + 2000), true)
  eq('...which takes it', lib.takeLoginNote(s, T + 3000), false)
  lib.leaveLoginNote(s, T)
  eq('an old note is not shown', lib.takeLoginNote(s, T + lib.LOGIN_NOTE_TTL_MS + 1), false)
  eq('...and is gone', s.keys(), [])
  lib.leaveLoginNote(s, T)
  eq('one from the future is not shown', lib.takeLoginNote(s, T - 1), false)
  s.setItem('logisx.driverRelease.loginNote.v1', 'junk')
  eq('junk is not shown', lib.takeLoginNote(s, T), false)
  lib.leaveLoginNote(brokenStorage(), T)
  eq('storage that throws has no note', lib.takeLoginNote(brokenStorage(), T), false)
  eq('no storage has no note', lib.takeLoginNote(null, T), false)
  lib.leaveLoginNote(null, T)
  lib.leaveLoginNote(s, T)
  ok('the note holds a time and nothing about him', s.values().every((v) => /^\d+$/.test(v)))
}

// ── §8 ────────────────────────────────────────────────────────────────────
section('8 what is on screen')
const docWith = (nodes, activeTag) => ({
  querySelectorAll: () => nodes.map((n) => ({ getClientRects: () => ({ length: n }) })),
  activeElement: activeTag ? { tagName: activeTag } : null,
})
eq('nothing open', lib.overlayOnScreen(docWith([])), false)
eq('a hidden one has no boxes', lib.overlayOnScreen(docWith([0, 0])), false)
eq('one on screen', lib.overlayOnScreen(docWith([0, 1])), true)
eq("a page that can't be read holds it", lib.overlayOnScreen({ querySelectorAll() { throw new Error('no') } }), true)
{
  let asked = ''
  lib.overlayOnScreen({ querySelectorAll: (q) => { asked = q; return [] } })
  ok('it asks for dialogs and overlays of any component', /role="dialog"/.test(asked) && /aria-modal/.test(asked) && /class\*="overlay"/.test(asked), asked)
}
for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) eq(`typing in ${tag}`, lib.fieldInFocus(docWith([], tag)), true)
eq('a button in focus is no field', lib.fieldInFocus(docWith([], 'BUTTON')), false)
eq('nothing in focus', lib.fieldInFocus(docWith([])), false)

// ── §9 ────────────────────────────────────────────────────────────────────
section('9 a write on the wire')
{
  const realFetch = globalThis.fetch
  const answers = []
  globalThis.fetch = () => new Promise((resolve, reject) => answers.push({ resolve, reject }))
  const { useApi } = useApiModule
  const api = useApi()
  const okBody = () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
  const LATER = Date.now() + 60 * 60 * 1000
  const idleBefore = !writes.writesBusy(LATER)
  ok('nothing on the wire at first', idleBefore)
  const reading = api.get('/api/anything')
  eq('a read holds nothing', writes.writesBusy(LATER), false)
  answers.shift().resolve(okBody())
  await reading
  const writing = api.put('/api/driver/status', { newStatus: 'Delivered' })
  eq('a status tap on the wire holds it', writes.writesBusy(LATER), true)
  const uploading = api.post('/api/documents/upload', { kind: 'POD' }, { timeout: 90000 })
  answers.shift().resolve(okBody())
  await writing
  eq('one of two done still holds it', writes.writesBusy(LATER), true)
  answers.shift().resolve(okBody())
  await uploading
  eq("just after it ended, it's still held: an upload's next try may be seconds off", writes.writesBusy(), true)
  eq('a little later it is free', writes.writesBusy(Date.now() + writes.WRITE_QUIET_MS + 1), false)
  const failing = api.post('/api/expenses', {})
  eq('a write in flight that then fails', writes.writesBusy(LATER), true)
  answers.shift().reject(new TypeError('Failed to fetch'))
  await failing.catch(() => {})
  eq('...stops holding once it has failed', writes.writesBusy(Date.now() + writes.WRITE_QUIET_MS + 1), false)
  globalThis.fetch = realFetch
  const end = writes.writeStarted()
  end()
  end()
  eq('ending one twice counts once', writes.writesBusy(Date.now() + writes.WRITE_QUIET_MS + 1), false)
}

// ── the world for §10 and §11 ──────────────────────────────────────────────
const LOAD_HEADERS = ['Load ID', 'Job Status']
const loadWith = (status) => ({ 'Load ID': 'QA-1', 'Job Status': status })
function world(start = {}) {
  const s = reactive({
    role: 'Driver', userId: 2, onboarding: false, mounted: true, performance: true, partsKnown: true, motionAllowed: true, parked: true, settled: true, tab: 'loads', loadOpen: false,
    welcomeOpen: false, dialogOpen: false, writesBusy: false, visible: true, online: true, loaded: true, loads: [loadWith('Delivered')], ...start,
  })
  const calls = { gets: 0, posts: [], signOuts: 0, facts: 0, asks: 0, steps: [], restored: [], toasts: [] }
  const box = {
    answer: () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: false }),
    fresh: null,
    otherTab: false,
    local: fakeStorage(),
    session: fakeStorage(),
  }
  const options = {
    api: {
      get: async (url) => { calls.gets++; eq('it reads the release route', url, RELEASE_URL); return box.answer() },
      post: async (url, body) => { calls.posts.push([url, body]); return { success: true } },
    },
    role: () => s.role,
    userId: () => s.userId,
    onboarding: () => s.onboarding,
    mounted: () => s.mounted,
    has: () => ({ performance: s.performance }),
    motionAllowed: () => s.motionAllowed,
    noteInputs: () => ({ onboarding: s.onboarding, settled: s.settled, partsKnown: s.partsKnown, tab: s.tab, loadOpen: s.loadOpen, welcomeOpen: s.welcomeOpen, dialogOpen: s.dialogOpen, motionAllowed: s.motionAllowed }),
    signOutInputs: () => ({
      loaded: s.loaded, onboarding: s.onboarding, tab: s.tab, loadOpen: s.loadOpen, welcomeOpen: s.welcomeOpen, dialogOpen: s.dialogOpen,
      loadsHold: lib.loadsHoldSignOut(s.loads, LOAD_HEADERS), writesBusy: s.writesBusy, otherTabOpen: box.otherTab, visible: s.visible, online: s.online, parked: s.parked, motionAllowed: s.motionAllowed,
    }),
    refreshFacts: async () => { calls.facts++; if (box.fresh) await box.fresh(s, box) },
    signOut: () => { calls.signOuts++ },
    place: () => s.tab,
    showStep: (step) => { calls.steps.push(step.id); s.tab = step.tab },
    restorePlace: (tab) => { calls.restored.push(tab); s.tab = tab },
    toast: (text) => calls.toasts.push(text),
    localStorage: box.local,
    sessionStorage: box.session,
    now: () => 1_800_000_000_000,
  }
  return { s, calls, box, options, release: useDriverRelease(options) }
}
const DUE = () => ({ signInDue: true, releaseId: ID, notes: [], tourOffered: false })

// ── §10 ───────────────────────────────────────────────────────────────────
section('10 the sign-out')
{
  const w = world()
  w.box.answer = DUE
  await w.release.check()
  eq('due and safe: signed out, once', w.calls.signOuts, 1)
  eq('his loads and truck read first', w.calls.facts, 1)
  eq('the login page gets its line', lib.takeLoginNote(w.box.session, 1_800_000_000_000), true)
  eq('this browser remembers', lib.signedOutFor(w.box.local, 2, ID), true)
  await w.release.check()
  eq("a page on its way out asks nothing more", [w.calls.signOuts, w.calls.gets], [1, 1])
}
for (const status of ['In Transit', 'Assigned', 'Heading to Shipper', 'At Shipper', 'Loading', 'At Receiver', 'Unloading']) {
  const w = world({ loads: [loadWith(status)] })
  w.box.answer = DUE
  await w.release.check()
  await w.release.check()
  eq(`a driver with a load ${status} is not signed out`, w.calls.signOuts, 0)
  eq('...and his place is left alone', lib.signedOutFor(w.box.local, 2, ID), false)
}
{
  const w = world({ loads: [loadWith('In Transit')] })
  w.box.answer = DUE
  await w.release.check()
  eq('In Transit: held', w.calls.signOuts, 0)
  w.s.loads = [loadWith('Delivered')]
  await w.release.check()
  eq('the first open after Delivered: signed out', w.calls.signOuts, 1)
}
{
  const w = world({ loads: [] })
  w.box.answer = DUE
  w.box.fresh = async (s) => { s.loads = [loadWith('In Transit')] }
  await w.release.check()
  eq('a list read before the phone slept said no load; the fresh read says In Transit: held', w.calls.signOuts, 0)
}
{
  const w = world({ loads: [loadWith('In Transit')] })
  w.box.answer = DUE
  w.box.fresh = async (s) => { s.loads = [loadWith('Delivered')] }
  await w.release.check()
  eq('the other way too: the fresh read says Delivered', w.calls.signOuts, 1)
}
{
  const w = world()
  w.box.answer = DUE
  w.box.fresh = async () => { throw new Error('no signal') }
  await w.release.check()
  eq("his loads can't be read: held", w.calls.signOuts, 0)
}
{
  const w = world()
  w.box.answer = DUE
  w.box.fresh = async (s) => { s.parked = false; s.motionAllowed = false }
  await w.release.check()
  eq('the fresh ELD read says moving: held', w.calls.signOuts, 0)
}
{
  const w = world({ loads: [] })
  w.box.answer = DUE
  await w.release.check()
  eq('an empty list holds, whatever caused it', w.calls.signOuts, 0)
}
{
  const w = world({ parked: false, motionAllowed: true })
  w.box.answer = DUE
  await w.release.check()
  eq('a truck with no reading, or a stale one: not moving is not parked, held', w.calls.signOuts, 0)
  w.s.parked = true
  await w.release.check()
  eq('...and the next moment with it parked signs him out', w.calls.signOuts, 1)
}
{
  const w = world()
  w.box.answer = DUE
  w.box.otherTab = true
  await w.release.check()
  eq('another tab of the app is open: held', w.calls.signOuts, 0)
  eq('...and nothing is recorded, so it can happen later', lib.signedOutFor(w.box.local, 2, ID), false)
  w.box.otherTab = false
  await w.release.check()
  eq('...and once the other tab has closed, the next moment signs him out', w.calls.signOuts, 1)
}
for (const [label, answer] of [["a browser that can't tell", null], ['no answer at all', undefined]]) {
  const w = world()
  w.box.answer = DUE
  w.box.otherTab = answer
  await w.release.check()
  eq(`${label}: held, as any missing input is`, w.calls.signOuts, 0)
}
{
  const w = world()
  w.box.answer = DUE
  w.box.fresh = async (s, box) => { box.otherTab = true }
  await w.release.check()
  eq('a tab opened while it read: the last check sees it, held', w.calls.signOuts, 0)
}
{
  const source = read('composables/useDriverRelease.js')
  const tail = source.slice(source.indexOf('if (!signOutMoment('), source.indexOf('o.signOut()'))
  ok('no await from the last check to the sign-out', tail.length > 0 && !/\bawait\b/.test(tail), tail)
  ok('nothing waits on another tab: the record is read in that last check', !/askOtherTabs|BroadcastChannel/.test(source))
}
for (const [label, change] of [
  ['opens a load while it reads', { loadOpen: true }],
  ['moves to another tab while it reads', { tab: 'messages' }],
  ['opens a dialog while it reads', { dialogOpen: true }],
  ['taps a status while it reads', { writesBusy: true }],
  ['loses signal while it reads', { online: false }],
  ['leaves the app while it reads', { visible: false }],
]) {
  const w = world()
  w.box.answer = DUE
  w.box.fresh = async (s) => { Object.assign(s, change) }
  await w.release.check()
  eq(`he ${label}: held`, w.calls.signOuts, 0)
}
{
  const w = world({ writesBusy: true })
  w.box.answer = DUE
  await w.release.check()
  eq('a status tap or POD upload in flight is not interrupted', w.calls.signOuts, 0)
  w.s.writesBusy = false
  await w.release.check()
  eq('...and the next moment after it signs him out', w.calls.signOuts, 1)
}
{
  const w = world({ dialogOpen: true })
  w.box.answer = DUE
  await w.release.check()
  eq('a form open: held', w.calls.signOuts, 0)
}
{
  const w = world({ tab: 'kit' })
  w.box.answer = DUE
  await w.release.check()
  eq('on another tab: held', w.calls.signOuts, 0)
}
for (const [label, fail] of [
  ['503', Object.assign(new Error('x'), { status: 503 })],
  ['500', Object.assign(new Error('x'), { status: 500 })],
  ['429', Object.assign(new Error('x'), { status: 429 })],
  ['401', Object.assign(new Error('x'), { status: 401 })],
  ['403', Object.assign(new Error('x'), { status: 403 })],
  ['a timeout', Object.assign(new Error('x'), { status: 0, code: 'TIMEOUT' })],
  ['no signal', new TypeError('Failed to fetch')],
]) {
  const w = world()
  w.box.answer = DUE
  await w.release.check()
  const signedOut = w.calls.signOuts
  const w2 = world()
  w2.box.answer = () => { throw fail }
  await w2.release.check()
  eq(`a failed read (${label}) signs nobody out and shows nothing`, [w2.calls.signOuts, w2.calls.facts, w2.release.noteView.value, w2.release.featureOn.value], [0, 0, null, false])
  eq('...where a good answer would have', signedOut, 1)
}
{
  const w = world()
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [ENTRY], tourOffered: false })
  await w.release.check()
  eq('a good answer turns it on', [w.release.featureOn.value, w.release.noteView.value?.mode], [true, 'notes'])
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 503 }) }
  await w.release.check()
  eq('a failed read later changes nothing', [w.release.featureOn.value, w.release.noteView.value?.mode], [true, 'notes'])
  w.box.answer = () => ({})
  await w.release.check()
  eq('nor does an unreadable body', [w.calls.signOuts, w.release.noteView.value?.mode], [0, 'notes'])
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 404, code: 'FEATURE_OFF' }) }
  await w.release.check()
  eq('the kill switch: nothing shows, the Kit button goes', [w.release.featureOn.value, w.release.noteView.value, w.calls.signOuts], [false, null, 0])
}
{
  // A server that keeps saying "due" after he signs back in: a new page, the same browser.
  const first = world()
  first.box.answer = DUE
  await first.release.check()
  eq('the first page signs him out', first.calls.signOuts, 1)
  const second = world()
  second.box.answer = DUE
  second.box.local = first.box.local
  second.options.localStorage = first.box.local
  const again = useDriverRelease(second.options)
  await again.check()
  await again.check()
  eq("the next page doesn't sign him out again: no loop", second.calls.signOuts, 0)
  eq('...nor rereads his loads for nothing', second.calls.facts, 0)
  const nextRelease = world()
  nextRelease.box.answer = () => ({ signInDue: true, releaseId: '2026-11-07-next', notes: [], tourOffered: false })
  nextRelease.options.localStorage = first.box.local
  await useDriverRelease(nextRelease.options).check()
  eq('a second release the same day signs him out again', nextRelease.calls.signOuts, 1)
  const nextDriver = world({ userId: 3 })
  nextDriver.box.answer = DUE
  nextDriver.options.localStorage = first.box.local
  await useDriverRelease(nextDriver.options).check()
  eq("on a shared phone the next driver's session is his own", nextDriver.calls.signOuts, 1)
}
{
  const w = world()
  w.box.answer = DUE
  w.options.localStorage = brokenStorage()
  await useDriverRelease(w.options).check()
  eq("a browser that can't remember gets no forced sign-out", w.calls.signOuts, 0)
  w.options.localStorage = null
  await useDriverRelease(w.options).check()
  eq('...no storage at all neither', w.calls.signOuts, 0)
}
for (const role of ['Super Admin', 'Dispatcher', 'Investor', 'KPI Viewer', undefined]) {
  const w = world({ role })
  w.box.answer = DUE
  await w.release.check()
  eq(`${role || 'nobody'} never even asks`, [w.calls.gets, w.calls.signOuts], [0, 0])
}
{
  const w = world({ onboarding: true })
  w.box.answer = DUE
  await w.release.check()
  eq('the lock screen never asks', [w.calls.gets, w.calls.signOuts], [0, 0])
}
{
  const w = world({ onboarding: undefined })
  w.box.answer = DUE
  await w.release.check()
  eq("before he's known to be off it, neither", [w.calls.gets, w.calls.signOuts], [0, 0])
}
{
  const w = world()
  w.box.answer = () => { w.s.mounted = false; return DUE() }
  await w.release.check()
  eq('a view left while it read does nothing', [w.calls.signOuts, w.calls.facts], [0, 0])
}
{
  // Two moments at once: the newer one decides, and there is one sign-out.
  const w = world()
  w.box.answer = DUE
  await Promise.all([w.release.check(), w.release.check()])
  eq('two moments at once: one sign-out', w.calls.signOuts, 1)
}

// ── §11 ───────────────────────────────────────────────────────────────────
section('11 the note, the offer and the tour')
const NOTE_ANSWER = () => ({ signInDue: false, releaseId: ID, notes: [{ ...ENTRY, tour: ['loads', 'performance', 'fuel-range'] }], tourOffered: false })
{
  // Shown before the Performance answer, a Got it would spend the whole entry without its lines.
  const w = world({ partsKnown: false, performance: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq("the Performance answer isn't known: the note is held", w.release.noteView.value, null)
  eq('...and nothing is marked', w.calls.posts, [])
  w.s.performance = true
  w.s.partsKnown = true
  eq('...known, it shows whole, with no new read', [w.release.noteView.value?.entries?.[0]?.lines, w.calls.gets], [['A line.', 'A tab line.'], 1])
}
{
  const w = world({ partsKnown: false })
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: true })
  await w.release.check()
  eq("a first-time driver's offer waits for it too: the whole tour depends on it", w.release.noteView.value, null)
}
{
  const w = world({ settled: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq("before things settle, it's held", w.release.noteView.value, null)
  eq('a note signs nobody out', w.calls.signOuts, 0)
  w.s.settled = true
  eq('settled, it shows, with no new read', [w.release.noteView.value.mode, w.calls.gets], ['notes', 1])
  w.s.motionAllowed = false
  eq('the truck starts moving: held', w.release.noteView.value, null)
  w.s.motionAllowed = true
  eq('parked again: it waited', w.release.noteView.value.mode, 'notes')
  w.s.loadOpen = true
  eq("a load's page: held", w.release.noteView.value, null)
  w.s.loadOpen = false
  w.s.loads = [loadWith('At Shipper')]
  eq('a working load: he can read it', w.release.noteView.value.mode, 'notes')
  eq('a due answer holds it back', (w.box.answer = DUE, await w.release.check(), w.release.noteView.value), null)
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  const view = w.release.noteView.value
  eq('what it says', [view.mode, view.canShowMe, view.entries[0].title, view.entries[0].lines], ['notes', true, 'A title', ['A line.', 'A tab line.']])
  w.release.noteGotIt()
  await tick()
  eq('Got it: marked seen', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  eq('...closed', w.release.noteView.value, null)
  await w.release.check()
  eq('...and not back in this view, whatever the next answer says', w.release.noteView.value, null)
  eq('Got it starts no tour', w.calls.steps, [])
}
{
  const w = world({ performance: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq('with no Performance tab he reads only his lines', w.release.noteView.value.entries[0].lines, ['A line.'])
  w.release.noteShowMe()
  await tick()
  eq('...and the tour skips that tab', w.calls.steps, ['loads'])
}
{
  const w = world({ performance: false })
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [{ id: ID, title: 'Tab only', notes: [{ text: 'Only with the tab.', needs: 'performance' }], tour: ['performance'] }], tourOffered: false })
  await w.release.check()
  eq("a release that's all about a tab he hasn't got shows nothing", w.release.noteView.value, null)
  eq('...and writes nothing', w.calls.posts, [])
}
{
  const w = world()
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [{ id: ID, title: 'No tour', notes: [{ text: 'Just a line.' }], tour: [] }], tourOffered: false })
  await w.release.check()
  eq('nothing to show him: no Show me', w.release.noteView.value.canShowMe, false)
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq('Show me: marked seen, and only that so far', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  eq("the release's steps only, on the real tab", [w.calls.steps, w.s.tab], [['loads'], 'loads'])
  eq('the card', [w.release.tourView.value.label, w.release.tourView.value.title, w.release.tourView.value.last], ['Step 1 of 3', 'Loads', false])
  eq('the note is out of the way', w.release.noteView.value, null)
  const gets = w.calls.gets
  await w.release.check()
  eq('no moment reads during the tour', w.calls.gets, gets)
  w.release.tourNext()
  eq('Next: the Performance tab', [w.calls.steps, w.s.tab, w.release.tourView.value.label], [['loads', 'performance'], 'performance', 'Step 2 of 3'])
  w.release.tourNext()
  eq('Next: the fuel range', [w.s.tab, w.release.tourView.value.last], ['loads', true])
  eq('nothing written along the way', w.calls.posts.length, 1)
  w.release.tourNext()
  await tick()
  eq('Done: only tour_done_at', w.calls.posts.slice(1), [[TOUR_DONE_URL, { ids: [ID] }]])
  eq('...closed and back where he was', [w.release.tourView.value, w.release.tourOpen.value, w.calls.restored], [null, false, ['loads']])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.release.tourNext()
  w.release.tourSkip()
  await tick()
  eq('Skip: no tour_done_at', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  eq('...back where he was', [w.release.tourOpen.value, w.calls.restored, w.s.tab], [false, ['loads'], 'loads'])
  await w.release.check()
  eq('...and no nagging', [w.release.noteView.value, w.release.tourOpen.value], [null, false])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.s.motionAllowed = false
  await tick()
  eq('the truck starts moving: the tour closes by itself', [w.release.tourOpen.value, w.calls.restored], [false, ['loads']])
  eq('...and marks nothing done', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  w.s.motionAllowed = true
  await tick()
  eq('...and stays closed', w.release.tourOpen.value, false)
}
{
  const w = world()
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: true })
  await w.release.check()
  eq('a first-time driver is offered the tour', w.release.noteView.value.mode, 'offer')
  w.release.offerSkip()
  await tick()
  eq('Skip for now: answered', w.calls.posts, [[SEEN_URL, { ids: [APP_TOUR_ROW] }]])
  eq('...and not asked again', w.release.noteView.value, null)
  await w.release.check()
  eq('...whatever a later answer in this view says', w.release.noteView.value, null)
}
{
  const w = world()
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: true })
  await w.release.check()
  w.release.offerTake()
  await tick()
  eq('Take the tour: answered, and the whole tour', [w.calls.posts, w.release.tourView.value.label], [[[SEEN_URL, { ids: [APP_TOUR_ROW] }]], 'Step 1 of 8'])
  for (let i = 0; i < 7; i++) w.release.tourNext()
  eq('every step, in order', w.calls.steps, APP_TOUR_STEP_IDS)
  w.release.tourNext()
  await tick()
  eq('finished, on the tour row', w.calls.posts[1], [TOUR_DONE_URL, { ids: [APP_TOUR_ROW] }])
}
{
  const w = world({ tab: 'kit' })
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: false })
  await w.release.check()
  w.release.startAppTour()
  await tick()
  eq('the Kit runs the whole tour any time, writing nothing to start', [w.release.tourView.value.label, w.calls.posts], ['Step 1 of 8', []])
  w.release.tourSkip()
  eq('...and goes back to the Kit', w.s.tab, 'kit')
  w.s.motionAllowed = false
  await tick()
  w.release.startAppTour()
  eq('with the truck moving it says when, and starts nothing', [w.calls.toasts, w.release.tourOpen.value], [[WORDS.whenParked], false])
}
{
  const w = world({ tab: 'kit' })
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [], tourOffered: true })
  await w.release.check()
  w.release.startAppTour()
  await tick()
  eq("taking it from the Kit answers a first-time driver's offer", w.calls.posts, [[SEEN_URL, { ids: [APP_TOUR_ROW] }]])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  w.options.api.post = async () => { throw new Error('no signal') }
  const release = useDriverRelease(w.options)
  await release.check()
  release.noteGotIt()
  await tick()
  eq('a mark that fails holds nothing up', release.noteView.value, null)
}
{
  // The tour's row and the notes in one answer: the notes first, then the offer.
  const w = world()
  w.box.answer = () => ({ signInDue: false, releaseId: ID, notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('notes first', w.release.noteView.value.mode, 'notes')
  w.release.noteGotIt()
  eq('then the offer', w.release.noteView.value.mode, 'offer')
}

// ── §12 ───────────────────────────────────────────────────────────────────
section('12 DriverView.vue')
const VIEW = read('views/DriverView.vue')
const script = VIEW.slice(VIEW.indexOf('<script setup>'), VIEW.indexOf('</script>'))
function fn(head) {
  const a = script.indexOf(head)
  if (a < 0) return ''
  return script.slice(a, script.indexOf('\n}\n', a) + 2)
}
const checks = [...script.matchAll(/release\.check\(\)/g)]
eq('it asks at four places and no others', checks.length, 4)
ok('when the app opens', /checkPerformanceTab\(\)\n\s+release\.check\(\)\n\s+\} catch/.test(fn('async function attemptInitialLoad()')))
ok('when he comes back to the app', /visibilityState === 'visible' && isMounted\) \{\n\s+scheduleDriverRefetch\(\)\n\s+release\.check\(\)/.test(fn('function onVisibilityChange()')))
ok("when he leaves a load's page himself", /@back="handleLoadBack"/.test(VIEW))
ok('when he taps a tab himself', /@switch="handleNavTap"/.test(VIEW))

// The view's own statements around a stand-in for the check: what closes a load's page, and what starts a check.
const between = (a, b) => {
  const at = script.indexOf(a)
  if (at < 0) throw new Error(`DriverView.vue: not found: ${a}`)
  return script.slice(at, script.indexOf(b, at) + b.length)
}
const flush = async () => { for (let i = 0; i < 8; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 0)) } }
async function placeScene({ tab = 'loads', rowOpen = 7, performance = false } = {}) {
  const { ref, computed, watch } = vue
  const headers = ['Load ID', 'Driver', 'Job Status', 'Origin Lat']
  const driverStore = reactive({
    loads: [{ _rowIndex: 7, 'Load ID': 'QA-1', Driver: 'Casey Example', 'Job Status': 'Assigned' }], headers: { jobTracking: headers }, notifications: [], messages: [], currentTab: tab,
    addNotification() {}, markNotificationsRead() {}, markMessagesRead() {},
  })
  const scene = { checks: 0, driverStore, currentTab: ref(tab), detailRowIndex: ref(rowOpen), detailLoad: ref(null), performanceTab: ref(performance) }
  const release = { check: () => { scene.checks++ } }
  const body = [
    between('const detailLoadRaw = computed(() => {', '\n})'),
    between('watch(detailLoadRaw, async (load) => {', '}, { immediate: true })'),
    between('watch(performanceTab, (shown) => {', '\n})'),
    between("watch(() => (currentTab.value === 'loads' ? (detailLoad.value ? 'load' : 'list') : ''), (place) => {", '\n})'),
    fn('function onLoadCancelled(payload)'),
    fn('function handleTabSwitch(tab)'),
    fn('function handleLoadBack()'),
    fn('function handleNavTap(tab)'),
    `return {
      onLoadCancelled,
      handleLoadBack: typeof handleLoadBack === 'function' ? handleLoadBack : null,
      handleNavTap: typeof handleNavTap === 'function' ? handleNavTap : null,
    }`,
  ].join('\n')
  const lifted = new Function('ref', 'computed', 'watch', 'driverStore', 'detailRowIndex', 'detailLoad', 'currentTab', 'performanceTab', 'api', 'release', 'weekSlotHeld', 'weekSlotWanted',
    'checkPerformanceTab', 'isMounted', 'toast', 'findCol', 'scheduleDriverRefetch', 'driverName', body)
  Object.assign(scene, lifted(ref, computed, watch, driverStore, scene.detailRowIndex, scene.detailLoad, scene.currentTab, scene.performanceTab, { get: async () => ({}) }, release, ref(true), true,
    () => {}, true, { show() {} }, (hs, re) => (hs || []).find((h) => re.test(h)) || null, () => {}, ref('Casey Example')))
  await flush()
  return scene
}
try {
  const open = await placeScene()
  eq('(the scene) his load page is open', !!open.detailLoad.value, true)
  open.onLoadCancelled({ loadId: 'QA-1', reason: 'cancelled' })
  await flush()
  eq('a socket push cancelling his load closes the page and starts no check', [!!open.detailLoad.value, open.checks], [false, 0])

  const refetched = await placeScene()
  refetched.driverStore.loads = []
  await flush()
  eq('a refetch where his open load has left the list closes the page and starts no check', [!!refetched.detailLoad.value, refetched.checks], [false, 0])

  const taken = await placeScene({ tab: 'performance', rowOpen: null, performance: true })
  taken.performanceTab.value = false
  await flush()
  eq('a Performance tab taken away goes back to the list and starts no check', [taken.currentTab.value, taken.checks], ['loads', 0])

  const back = await placeScene()
  ok('(the scene) the load page has its back handler', typeof back.handleLoadBack === 'function')
  back.handleLoadBack?.()
  await flush()
  eq("his own back from a load's page closes it and starts one check", [!!back.detailLoad.value, back.checks], [false, 1])

  const nav = await placeScene({ tab: 'kit', rowOpen: null })
  ok('(the scene) the tab bar has its tap handler', typeof nav.handleNavTap === 'function')
  nav.handleNavTap?.('messages')
  await flush()
  eq('tapping another tab starts no check', nav.checks, 0)
  nav.handleNavTap?.('loads')
  await flush()
  eq('tapping Loads, back to the list, starts one', [nav.currentTab.value, nav.checks], ['loads', 1])

  const toLoad = await placeScene({ tab: 'kit' })
  toLoad.handleNavTap?.('loads')
  await flush()
  eq("tapping Loads with a load's page still open there starts none", [!!toLoad.detailLoad.value, toLoad.checks], [true, 0])
} catch (e) {
  ok(`the scenes of who starts a check ran: ${e.message}`, false)
}

// The view's own read of the Performance tab: only a yes or a no from the server makes it known.
async function probeScene(answer) {
  const { ref } = vue
  const driverPerformance = await load('lib/driverPerformance.js')
  const performanceKnown = ref(false)
  const performanceTab = ref(false)
  const body = `let performanceReads = 0; let weekSlotWanted = true; ${fn('async function checkPerformanceTab()')}\nreturn checkPerformanceTab`
  const run = new Function('auth', 'tabProbeUrl', 'isOnboarding', 'api', 'isMounted', 'performanceTab', 'performanceKnown', 'tabAfterAnswer', 'isGoneAnswer', 'performanceWeek', 'weekFromAnswer', body)(
    { user: { role: 'Driver' } }, driverPerformance.tabProbeUrl, ref(false), { get: answer }, true, performanceTab, performanceKnown, driverPerformance.tabAfterAnswer, driverPerformance.isGoneAnswer, ref(null), driverPerformance.weekFromAnswer)
  await run()
  return [performanceKnown.value, performanceTab.value]
}
const refusal = (status) => async () => { throw Object.assign(new Error('x'), { status }) }
eq('a yes from the server: known, and he has the tab', await probeScene(async () => ({ weeks: [] })), [true, true])
eq('a no (the switch off, or no week to show): known, and he has none', await probeScene(refusal(404)), [true, false])
eq('a failed probe (503): not known, so the note keeps holding', await probeScene(refusal(503)), [false, false])
eq('no signal: not known', await probeScene(async () => { throw new TypeError('Failed to fetch') }), [false, false])
ok('it starts unknown', /const performanceKnown = ref\(false\)/.test(script))
ok('the note reads it', /partsKnown: performanceKnown\.value/.test(script))

for (const head of ['function scheduleDriverRefetch()', 'function onLoadAssigned(payload)', 'function onInstructionsChanged(payload)', 'function onResignRequested()', 'function onTimeOffUpdated()', 'function onLoadCancelled(payload)', 'function onGeofenceTrigger(payload)', 'function onLocationUpdate(payload)', 'function onNewMessage(msg)']) {
  const body = fn(head)
  ok(`no socket push or refetch asks: ${head}`, body !== '' && !/release\.check/.test(body))
}
ok('no timer asks', ![...script.matchAll(/set(?:Timeout|Interval)\([\s\S]{0,200}?\)/g)].some((m) => /release\.check/.test(m[0])))
ok('a socket reconnect does not ask', !/isConnected\.value[\s\S]{0,200}release\.check/.test(script))
ok('a working load is read from the whole list, not just workingLoads', /loadsHold: loadsHoldSignOut\(driverStore\.loads, driverStore\.headers\.jobTracking\)/.test(script))
ok('the note and the tour, by the same gate as the contacts prompt', /motionAllowed: \(\) => voiceGate\.value\.allowed/.test(script) && /settled: contactsPromptReady\.value[\s\S]{0,300}motionAllowed: voiceGate\.value\.allowed/.test(script))
ok('the sign-out, only by a truck that reads as parked', /parked: voiceGate\.value\.state === 'parked'/.test(script))
ok("the other tabs are read from the page's one record, at each check", /signOutInputs: \(\) => \(\{[\s\S]{0,700}otherTabOpen: thisPageTabs\(\)\.otherPageOpen\(\),/.test(script))
ok('a load opened, a window up, a new load banner, an accept in flight, a field in focus, any overlay: all hold it',
  /const loadPageOpen = \(\) => !!detailLoad\.value/.test(script) && [...script.matchAll(/loadOpen: loadPageOpen\(\)/g)].length === 2 && /dialogOpen: releaseDialogOpen\(\) \|\| !!assignedNotification\.value \|\| respondingLoadIds\.size > 0 \|\| fieldInFocus\(document\) \|\| overlayOnScreen\(document\)/.test(script))
ok('a load that failed to read holds it', /loaded: !initialLoadFailed\.value/.test(script))
ok('writes on the wire hold it', /writesBusy: writesBusy\(\)/.test(script))
ok('another window or no signal holds it', /visible: document\.visibilityState === 'visible'/.test(script) && /online: navigator\.onLine !== false && !auth\.isReconnecting/.test(script))
ok('the loads and the truck are read afresh, quietly, so the screen stays, and a failed truck read holds', /await driverStore\.loadData\(\{ quiet: true \}\)\s+if \(await driverPos\.refreshEld\(\) !== true\) throw /.test(script))
ok('it signs out the way the Logout button does', /signOut: handleLogout/.test(script))
const stepFn = fn('function showTourStep(step)')
ok('a step shows the real tab', /currentTab\.value = step\.tab/.test(stepFn))
ok('a step marks nothing read: no handleTabSwitch', stepFn !== '' && !/handleTabSwitch|markMessagesRead|markNotificationsRead/.test(stepFn))
ok('a step leaves the store alone, so a message arriving stays unread', !/driverStore\.currentTab/.test(stepFn))
ok('the Messages tab opening in the tour marks nothing read', /function handleMarkRead\(ids\) \{[\s\S]{0,120}if \(release\.tourOpen\.value\) return\n\s+driverStore\.markMessagesRead\(ids\)/.test(script))
ok('the contacts prompt waits for the tour', /dialogOpen: showSignModal\.value \|\| showDeclineConfirm\.value \|\| showContactsForm\.value \|\| release\.tourOpen\.value/.test(script))
ok('a new load tapped during the tour ends it', /release\.closeTour\(\)\n\s+currentTab\.value = 'loads'/.test(fn('function viewAssignedLoad()')))
ok('the note and the tour sit in the normal app only', VIEW.indexOf('<DriverReleaseNote') > VIEW.indexOf('NORMAL DRIVER UI') && VIEW.indexOf('<DriverAppTour') > VIEW.indexOf('NORMAL DRIVER UI'))
ok("the Kit's button only with a good answer", /<section v-if="releaseFeatureOn" class="card tour-kit"/.test(VIEW))
ok("the Kit's button runs the tour", /@click="release\.startAppTour"/.test(VIEW))
ok('the training videos only when the Kit has them', /:videos="driverStore\.trainingVideos === 'kit'"/.test(VIEW))
ok('the tour ends on them: finished, then the Kit', /release\.tourFinish\(\)\n\s+handleTabSwitch\('kit'\)/.test(fn('function tourToVideos()')))

// ── §13 ───────────────────────────────────────────────────────────────────
section('13 the components and the login page')
const NOTE = read('components/driver/DriverReleaseNote.vue')
const TOUR = read('components/driver/DriverAppTour.vue')
const LOGIN = read('views/LoginView.vue')
for (const [label, src] of [['the note', NOTE], ['the tour', TOUR]]) {
  ok(`${label} prints no raw HTML`, !/v-html/.test(src))
  ok(`${label} reads and writes nothing itself`, !/useApi|fetch\(|localStorage|sessionStorage/.test(src))
  ok(`${label} takes its words from the lib`, /WORDS/.test(src))
}
ok('the note is the same kind of window as the contacts prompt', /<van-popup/.test(NOTE) && /:close-on-click-overlay="false"/.test(NOTE))
for (const id of ['release-show-me', 'release-got-it', 'release-take-tour', 'release-skip-offer']) ok(`the note has ${id}`, NOTE.includes(`data-testid="${id}"`))
for (const id of ['tour-card', 'tour-label', 'tour-next', 'tour-skip', 'tour-shield']) ok(`the tour has ${id}`, TOUR.includes(`data-testid="${id}"`))
ok("every button is a 44 px tap", /\.tour-skip, \.tour-next, \.tour-videos \{ min-height: 44px/.test(TOUR) && /\.drn-primary \{ min-height: 44px/.test(NOTE) && /\.drn-second \{[\s\S]{0,80}min-height: 44px/.test(NOTE))
ok('the clear layer stops a tap reaching the screen under it', /\.tour-shield \{ position: fixed; inset: 0;/.test(TOUR))
ok('...under the new load banner, which stays tappable', /z-index: 150/.test(TOUR) && /z-index: 160/.test(TOUR))
ok("the login page's line comes from the lib, once", /takeLoginNote\(browserStorage\('session'\), Date\.now\(\), isLeavingPage\(\)\) \? RELEASE_WORDS\.signedOut : ''/.test(LOGIN))
ok('...and shows above the form', LOGIN.indexOf('data-testid="login-updated-note"') > 0 && LOGIN.indexOf('data-testid="login-updated-note"') < LOGIN.indexOf('class="login-form"', LOGIN.indexOf('LOGIN FORM')))
ok('a session the server confirms ends the line, in the one place every sign-in passes', /_applyAuthenticated\(user, \{ persist = true \} = \{\}\) \{[\s\S]{0,400}removeKey\('session', LOGIN_NOTE_KEY\)/.test(read('stores/auth.js')))

// ── §14 ───────────────────────────────────────────────────────────────────
section('14 only the driver app and the session store read any of it')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}
const importers = walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && /driverReleaseNotices|useDriverRelease|driver\/me\/release/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(CLIENT, f).replaceAll(path.sep, '/')).sort()
eq('these files and no others', importers, ['components/driver/DriverAppTour.vue', 'components/driver/DriverReleaseNote.vue', 'composables/useDriverRelease.js', 'lib/driverReleaseNotices.js', 'stores/auth.js', 'views/DriverView.vue', 'views/LoginView.vue'])

// ── §15 ───────────────────────────────────────────────────────────────────
section('15 the real driver store and the real truck read')
const piniaModule = await import(pathToFileURL(path.join(ROOT, 'client', 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href)
const { useDriverStore } = await load('stores/driver.js')
const { useDriverPosition } = await load('composables/useDriverPosition.js')
const { recordGate } = await load('lib/voiceNoteGate.js')
const DRIVER_NAME = 'Casey Example'
const REAL_HEADERS = ['Load ID', 'Driver', 'Job Status']
const realLoad = (status) => ({ _rowIndex: 2, 'Load ID': 'QA-1', Driver: DRIVER_NAME, 'Job Status': status })
const jsonReply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const payload = (status) => () => jsonReply({ loads: status ? [realLoad(status)] : [], headers: { jobTracking: REAL_HEADERS, carrierDB: [] } })
// Headers and part of a body arrive and the connection drops, or all of a body that was cut short.
const droppedBody = () => () => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode('{"loads":[{"_rowIndex":2,')); setTimeout(() => c.error(new TypeError('network error')), 1) },
}), { status: 200, headers: { 'content-type': 'application/json' } })
const cutShort = () => () => new Response('{"loads":[{"_rowIndex":2,', { status: 200 })
const noBody = () => () => new Response('', { status: 200 })
const truck = ({ speed = 0, age = 5000, stopped = 10 * 60 * 1000 } = {}) => () => jsonReply({
  ok: true,
  position: { latitude: 29.7, longitude: -95.3, speed, source: 'routemate', lastPingAge: age, timestamp: new Date(Date.now() - age).toISOString(), ...(speed === 0 ? { stoppedSinceMs: stopped === null ? null : Date.now() - stopped } : {}) },
})
const noReading = () => () => jsonReply({ ok: true, position: null, reason: 'no_recent_fix' })
const refusedRead = () => () => jsonReply({ error: 'x' }, 503)
const noSignal = () => () => { throw new TypeError('Failed to fetch') }
// The view's own statements for reading the facts afresh, run on the real store and the real truck read.
const refreshFactsText = (script.match(/refreshFacts: (async \(\) => \{[\s\S]*?\n {2}\}),/) || [])[1]
ok('(the scene) the view reads its facts in one place', !!refreshFactsText)

async function realCheck({ loads, reading, before = null, holding = 'In Transit', otherTab = () => false }) {
  piniaModule.setActivePinia(piniaModule.createPinia())
  const store = useDriverStore()
  store.driverName = DRIVER_NAME
  store.loads = [realLoad(holding)]
  store.headers = { jobTracking: REAL_HEADERS, carrierDB: [] }
  const pos = useDriverPosition()
  const realFetch = globalThis.fetch
  let readingNow = before || reading
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === RELEASE_URL) return jsonReply(DUE())
    if (u === '/api/driver/position') return readingNow()
    if (u.startsWith('/api/driver/')) return loads()
    throw new TypeError(`unexpected ${u}`)
  }
  if (before) { await pos.refreshEld(); readingNow = reading }
  const gate = () => {
    const m = pos.eldMotion.value
    return recordGate({ fix: m ? m.fix : null, stoppedSince: m ? m.stoppedSince : null, nowMs: Date.now() })
  }
  let signOuts = 0
  const release = useDriverRelease({
    api: useApiModule.useApi(),
    role: () => 'Driver',
    userId: () => 2,
    onboarding: () => false,
    mounted: () => true,
    has: () => ({ performance: true }),
    motionAllowed: () => gate().allowed,
    noteInputs: () => ({}),
    signOutInputs: () => ({
      loaded: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false,
      loadsHold: lib.loadsHoldSignOut(store.loads, store.headers.jobTracking), writesBusy: false, otherTabOpen: otherTab(), visible: true, online: true,
      parked: gate().state === 'parked', motionAllowed: gate().allowed,
    }),
    refreshFacts: new Function('driverStore', 'driverPos', `return ${refreshFactsText}`)(store, pos),
    signOut: () => { signOuts++ },
    place: () => 'loads',
    showStep: () => {},
    restorePlace: () => {},
    toast: () => {},
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
  })
  await release.check()
  globalThis.fetch = realFetch
  return { signOuts, loads: store.loads.length, state: gate().state }
}
const PARKED = truck()
eq('(control) his loads all delivered, the truck parked: signed out', (await realCheck({ loads: payload('Delivered'), reading: PARKED })).signOuts, 1)
eq('In Transit, and the reply about his loads comes whole: held', (await realCheck({ loads: payload('In Transit'), reading: PARKED })).signOuts, 0)
for (const [label, reply] of [['whose body drops part way', droppedBody()], ['cut short', cutShort()], ['with no body at all', noBody()]]) {
  const r = await realCheck({ loads: reply, reading: PARKED })
  eq(`In Transit, on a weak signal: a 2xx ${label} empties the store's list and he is not signed out`, [r.loads, r.signOuts], [0, 0])
}
eq("a good answer with an empty list, as a moved column or a name that stopped matching gives: held", (await realCheck({ loads: payload(''), reading: PARKED })).signOuts, 0)
for (const [label, reading, state] of [
  ['no reading from the server', noReading(), 'unknown'],
  ['a reading over three minutes old', truck({ age: 4 * 60 * 1000 }), 'unknown'],
  ['moving when last read, over three minutes ago', truck({ speed: 25, age: 4 * 60 * 1000 }), 'unknown'],
  ['moving', truck({ speed: 25 }), 'moving'],
  ['stopped under two minutes', truck({ stopped: 30 * 1000 }), 'stopping'],
  ["moving on a feed that sends no speed, so the server sends no stopped time", truck({ stopped: null }), 'stopping'],
]) {
  const r = await realCheck({ loads: payload('Delivered'), reading })
  eq(`his loads delivered, the truck ${label}: held`, [r.state, r.signOuts], [state, 0])
}
{
  const r = await realCheck({ loads: payload('Delivered'), reading: truck({ stopped: null }), before: PARKED })
  eq('a truck that read parked and then moves with no speed: held, the earlier stop is not carried', [r.state, r.signOuts], ['stopping', 0])
}
for (const [label, reading] of [['refused (503)', refusedRead()], ['with no signal', noSignal()]]) {
  const r = await realCheck({ loads: payload('Delivered'), reading, before: PARKED })
  eq(`a truck read ${label}, with an earlier reading still saying parked: held, since that's no reading of now`, [r.state, r.signOuts], ['parked', 0])
}

// ── §16 ───────────────────────────────────────────────────────────────────
section('16 lib/appTabs.js')
const appTabs = await load('lib/appTabs.js').catch(() => null)
ok('the module is there', !!appTabs)
if (appTabs) {
  const { openAppTabs, thisPageTabs, RECORD_MAX_AGE_MS, RECORD_REWRITE_MS } = appTabs
  const NOW = 1_800_000_000_000
  const HOUR = 60 * 60 * 1000
  const PREFIX = 'logisx.appPage.v1.'
  // One browser's storage and clock; each page opened on it has its own window and document events.
  function browser(init = {}) {
    const clock = { ms: NOW }
    const storage = fakeStorage(init)
    // A listener's throw reaches the test here, where a real EventTarget would report it elsewhere.
    const events = () => {
      const on = new Map()
      return { addEventListener: (type, fn) => on.set(type, [...(on.get(type) || []), fn]), fire: (type, event = {}) => (on.get(type) || []).forEach((fn) => fn(event)) }
    }
    const open = (over = storage) => {
      const page = events()
      const doc = Object.assign(events(), { visibilityState: 'visible' })
      const beats = []
      const tabs = openAppTabs(over, { now: () => clock.ms, page, doc, every: (fn) => beats.push(fn) })
      return {
        tabs, page, doc,
        // Its timer coming round, for a page that's running. A frozen or dead one never gets this.
        beat: () => beats.forEach((fn) => fn()),
        leave: () => page.fire('pagehide'),
        comeBackFromCache: () => page.fire('pageshow', { persisted: true }),
        show: () => { doc.visibilityState = 'visible'; doc.fire('visibilitychange') },
        hide: () => { doc.visibilityState = 'hidden'; doc.fire('visibilitychange') },
      }
    }
    const records = () => storage.keys().filter((k) => k.startsWith(PREFIX))
    return { clock, storage, open, records }
  }
  {
    const b = browser()
    const a = b.open()
    eq('alone: no other page', a.tabs.otherPageOpen(), false)
    const other = b.open()
    eq('another page: open', a.tabs.otherPageOpen(), true)
    eq('...and the other way round', other.tabs.otherPageOpen(), true)
    eq('two pages, two records', b.records().length, 2)
    other.leave()
    eq('it leaves: none again, with no one asked', a.tabs.otherPageOpen(), false)
    eq('...and its record is gone', b.records().length, 1)
    a.leave()
    eq('the last page leaves: no records', b.records().length, 0)
  }
  {
    const b = browser()
    const a = b.open()
    const frozen = b.open()
    // A frozen or busy page runs nothing at all: no handler, no timer. Its record does the holding.
    b.clock.ms += 3 * HOUR
    eq('another page that has run nothing for hours (frozen, or too busy to answer): still open', a.tabs.otherPageOpen(), true)
    frozen.comeBackFromCache()
    eq('it comes back: still open', a.tabs.otherPageOpen(), true)
  }
  {
    const b = browser()
    const a = b.open()
    const other = b.open()
    other.leave()
    eq('a page gone into the page cache has left', a.tabs.otherPageOpen(), false)
    other.comeBackFromCache()
    eq('...and writes itself again on the way back', a.tabs.otherPageOpen(), true)
    eq('...under the same one record', b.records().length, 2)
  }
  {
    const b = browser({ [`${PREFIX}deadtab`]: String(NOW - (RECORD_MAX_AGE_MS - 1000)) })
    const a = b.open()
    eq('a tab that died without saying so holds, up to a day', a.tabs.otherPageOpen(), true)
    eq("...and starting a page leaves a record that hasn't expired", b.records().includes(`${PREFIX}deadtab`), true)
    b.clock.ms += 1000
    eq('...and no longer once it has been a day: exactly a day does not count', a.tabs.otherPageOpen(), false)
    eq('...and an expired record is only ignored until a page starts', b.records().includes(`${PREFIX}deadtab`), true)
    b.open()
    eq('...when it goes', b.records().includes(`${PREFIX}deadtab`), false)
  }
  {
    const expired = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${PREFIX}dead${i}`, String(NOW - RECORD_MAX_AGE_MS - i)]))
    const b = browser({ ...expired, [`${PREFIX}young`]: String(NOW - HOUR), [`${PREFIX}garbled`]: 'not a time', 'logisx.other': String(NOW - 9 * RECORD_MAX_AGE_MS), [lib.LOGIN_NOTE_KEY]: '1' })
    b.open()
    eq("records can't pile up: every expired or garbled one goes when a page starts, past any that came before it", b.records().length, 2)
    eq("...the young one stays", b.records().includes(`${PREFIX}young`), true)
    eq("...and nothing else in the browser's storage is touched", [b.storage.getItem('logisx.other'), b.storage.getItem(lib.LOGIN_NOTE_KEY)], [String(NOW - 9 * RECORD_MAX_AGE_MS), '1'])
    const garbled = browser({ [`${PREFIX}garbled`]: 'not a time' })
    const a = garbled.open()
    garbled.storage.setItem(`${PREFIX}garbled`, 'not a time')
    eq("a record that isn't a time doesn't count", a.tabs.otherPageOpen(), false)
    const ahead = browser({ [`${PREFIX}ahead`]: String(NOW + 2 * RECORD_MAX_AGE_MS) })
    eq('a record stamped ahead of this clock counts: a clock put back holds, and costs only the next sign-in', ahead.open().tabs.otherPageOpen(), true)
  }
  {
    const b = browser({ 'logisx.other': String(NOW) })
    const a = b.open()
    eq('a key of something else is no other page', a.tabs.otherPageOpen(), false)
    const key = b.records()[0]
    ok("a record is a random page id and a time: no name, no account", /^logisx\.appPage\.v1\.[a-z0-9]+$/.test(key) && /^\d+$/.test(b.storage.getItem(key)), key)
    eq('...the time this page wrote it', Number(b.storage.getItem(key)), NOW)
    ok('...and two pages never share an id', b.open() && new Set(b.records()).size === 2)
  }
  {
    const b = browser()
    const a = b.open()
    const key = b.records()[0]
    b.clock.ms += 25 * HOUR
    a.hide()
    eq('going hidden writes nothing', Number(b.storage.getItem(key)), NOW)
    a.show()
    eq('a tab in use again is counted again past a day: coming back writes the time', Number(b.storage.getItem(key)), b.clock.ms)
    const other = b.open()
    eq('...so another page sees it', other.tabs.otherPageOpen(), true)
    b.clock.ms += RECORD_MAX_AGE_MS
    other.comeBackFromCache()
    eq('...and a record left to expire no longer holds', other.tabs.otherPageOpen(), false)
  }
  {
    const b = browser()
    const a = b.open()
    const running = b.open()
    for (let h = 0; h < 30; h++) {
      b.clock.ms += RECORD_REWRITE_MS
      running.beat()
      a.beat()
    }
    eq('a tab that keeps running stays counted however long it is left, hidden or not, as long as it would have answered', a.tabs.otherPageOpen(), true)
    const b2 = browser()
    const c = b2.open()
    b2.open()
    b2.clock.ms += RECORD_MAX_AGE_MS
    c.beat()
    eq('...and one that runs nothing, frozen or dead, ages out at a day, where it would never have answered at all', c.tabs.otherPageOpen(), false)
    ok('its timer comes round well inside the age of a record', RECORD_REWRITE_MS * 2 < RECORD_MAX_AGE_MS)
    const quiet = openAppTabs(fakeStorage(), { page: null, doc: null })
    eq('the real timer starts without a window or a document, and holds nothing up', quiet.otherPageOpen(), false)
  }
  {
    const b = browser()
    const a = b.open()
    const other = b.open()
    b.storage.removeItem(b.records().find((k) => k !== b.records()[0]))
    b.storage.removeItem(b.records()[0])
    eq("its own record gone: the storage was cleared, so it can't tell this time, and holds", a.tabs.otherPageOpen(), null)
    eq('...and has written itself again for next time', b.records().length, 1)
    eq('...and can tell then', a.tabs.otherPageOpen(), false)
    other.leave()
    eq("...another page's leaving doesn't change that", a.tabs.otherPageOpen(), false)
  }
  const refusesWrites = () => ({ ...fakeStorage(), length: 0, key: () => null, setItem() { throw new Error('over quota') } })
  const throwsOnRead = () => {
    const s = fakeStorage()
    return { setItem: s.setItem, removeItem: s.removeItem, length: 0, key: () => null, getItem() { throw new Error('denied') } }
  }
  const throwsOnList = () => {
    const s = fakeStorage()
    return { getItem: s.getItem, setItem: s.setItem, removeItem: s.removeItem, get length() { throw new Error('denied') }, key: s.key }
  }
  const dropsWrites = () => ({ ...fakeStorage(), length: 0, key: () => null, setItem() {} })
  for (const [label, storage] of [
    ['a record that can\'t be written', refusesWrites()],
    ['a record written and not kept', dropsWrites()],
    ['a record that can\'t be read', throwsOnRead()],
    ['records that can\'t be listed', throwsOnList()],
    ['no storage at all', null],
    ['a broken storage', brokenStorage()],
  ]) {
    const b = browser()
    let page = null
    let threw = false
    try { page = b.open(storage) } catch { threw = true }
    ok(`${label}: starting a page never throws`, !threw)
    eq(`${label}: can't tell, which holds`, page ? page.tabs.otherPageOpen() : 'threw', null)
    let threwLeaving = false
    try { page?.leave(); page?.show(); page?.comeBackFromCache() } catch { threwLeaving = true }
    ok(`${label}: nor does leaving or coming back`, !threwLeaving)
  }
  ok('one record to a page', thisPageTabs() === thisPageTabs())
  eq('with no window to read storage from, it says it cannot tell', thisPageTabs().otherPageOpen(), null)
  ok('every page starts it', /thisPageTabs\(\)/.test(read('main.js')))
  ok('nothing about a channel or a wait is left', !/BroadcastChannel|setTimeout/.test(read('lib/appTabs.js')))

  // The real records in the real last check: a tab that holds has nothing to do with it but be open.
  const OPEN = { loads: payload('Delivered'), reading: PARKED }
  {
    const b = browser()
    const a = b.open()
    eq('(control) this page alone, through the whole check: signed out', (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 1)
    const frozen = b.open()
    eq('another page frozen, or too busy to answer: held', (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 0)
    frozen.leave()
    eq('...and once it has left, the next check goes on', (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 1)
  }
  {
    const b = browser({ [`${PREFIX}deadtab`]: String(NOW - HOUR) })
    const a = b.open()
    eq('a tab that died without saying so: held, so that driver gets the update at their next sign-in', (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 0)
    b.clock.ms += RECORD_MAX_AGE_MS
    eq('...and a day on it no longer holds', (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 1)
  }
  {
    const b = browser()
    const a = b.open(refusesWrites())
    eq("a browser that can't keep a record: held", (await realCheck({ ...OPEN, otherTab: () => a.tabs.otherPageOpen() })).signOuts, 0)
  }
}

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} of ${pass + failures.length}`)
  process.exit(1)
}
console.log(`\nok: ${pass} checks`)
process.exit(0)
