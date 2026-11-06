#!/usr/bin/env node
// New-feature notices for drivers, the app's side: the rules in client/src/lib/driverReleaseNotices.js,
// composables/useDriverRelease.js driven for real on Vue's own reactivity, and how DriverView.vue and
// the two components use them. The server's side is scripts/test-driver-release-notices.js;
// scripts/e2e/driver-release-notices.mjs covers the page.
//   §1  the words, exact, and plain: no figure, no name, no word a driver wouldn't use; none that's
//       false for a driver who can read it, and none about being signed out
//   §2  noteMoment(): each input stops the note, and neither a working load nor the truck does
//   §3  releaseFromAnswer(): what an answer may and may not say; an unreadable body says nothing
//   §4  notesForScreen(), tourStepsFor(), tourCardView(): only what this driver's app has
//   §5  no forced sign-out: an answer that says one is due, at an app opening, with a way to sign out
//       in reach, signs nobody out; this feature has no road to handleLogout; the code for it is gone
//   §6  only right after a sign-in: a load with no sign-in shows nothing, however much the server has;
//       the sign-in is spent by the one read, whatever comes of it, so nothing shows later on that page;
//       only a Driver asks
//   §7  the note, the offer and the tour through useDriverRelease: once, what each writes, skip; a no
//       doesn't wait; a moving truck's open page never changes; the tour starts only on their own tap
//   §8  DriverView.vue: one read, as the view opens, and no other; the login form notes the sign-in, in
//       memory; the tour marks nothing read
//   §9  the components, and the app's other files, which know nothing of this
//   §10 only the driver app reads any of it
//
// No DOM, no server, no build.
//   node scripts/test-driver-release-notices-client.mjs      # exits 1 on any failure
import fs from 'fs'
import { registerHooks } from 'module'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client', 'src')
// The view's own imports go without an extension, as Vite allows; plain Node needs a hand.
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

let lib, composable, vue, signInMoment
try {
  lib = await load('lib/driverReleaseNotices.js')
  composable = await load('composables/useDriverRelease.js')
  vue = await import(pathToFileURL(path.join(ROOT, 'client', 'node_modules', 'vue', 'index.mjs')).href)
} catch (e) {
  console.log(`  FAIL  the app's side must load: ${e.message}`)
  console.log('\nFAILED: 1 of 1')
  process.exit(1)
}
try {
  signInMoment = await load('lib/signInMoment.js')
} catch (e) {
  ok(`the sign-in's one-shot must load: ${e.message}`, false)
  signInMoment = null
}
const { WORDS, TOUR_STEPS, APP_TOUR_STEP_IDS, APP_TOUR_ROW, RELEASE_URL, SEEN_URL, TOUR_DONE_URL } = lib
const { useDriverRelease } = composable
const { reactive, nextTick } = vue

const tick = async () => { await new Promise((r) => setImmediate(r)); await nextTick() }
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

// ── §1 ────────────────────────────────────────────────────────────────────
section('1 the words')
eq('the routes', [RELEASE_URL, SEEN_URL, TOUR_DONE_URL], ['/api/driver/me/release', '/api/driver/me/release/seen', '/api/driver/me/release/tour-done'])
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
  ok(`no word they wouldn't use: "${line}"`, !/\b(session|deploy|release|server|api|bug|flag|sheet|database|endpoint|cache|token)\b/i.test(line))
  ok(`nothing about being signed out: "${line}"`, !/\b(sign(ed|s)?[ -]?(in|out)|log(ged|s)?[ -]?(in|out)|logout|login)\b/i.test(line))
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
section('2 noteMoment()')
const FREE = Object.freeze({ partsKnown: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false })
eq('on the list: the note may show', lib.noteMoment(FREE), true)
eq('a working load does not stop it: they can read at a shipper', lib.noteMoment({ ...FREE, loadsHold: true }), true)
eq('the truck does not come into it: it follows a password they have just typed, and it is one tap', lib.noteMoment({ ...FREE, motionAllowed: false, settled: false }), true)
for (const [label, change] of [
  ['before the Performance answer is known', { partsKnown: false }],
  ['with no Performance answer at all', { partsKnown: undefined }],
  ['the lock screen', { onboarding: true }],
  ['another tab', { tab: 'kit' }],
  ['a load open', { loadOpen: true }],
  ['the welcome window', { welcomeOpen: true }],
  ['a dialog', { dialogOpen: true }],
]) eq(`no: ${label}`, lib.noteMoment({ ...FREE, ...change }), false)
for (const key of Object.keys(FREE)) {
  const missing = { ...FREE }
  delete missing[key]
  eq(`no: ${key} not known`, lib.noteMoment(missing), false)
}

// ── §3 ────────────────────────────────────────────────────────────────────
section('3 releaseFromAnswer()')
const ID = '2026-11-06-my-week'
const ENTRY = { id: ID, title: 'A title', notes: [{ text: 'A line.' }, { text: 'A tab line.', needs: 'performance' }], tour: ['loads'] }
const NOTHING = () => ({ notes: [], tourOffered: false })
eq('no answer', lib.releaseFromAnswer(null), null)
eq("useApi's unreadable body says nothing", lib.releaseFromAnswer({}), null)
eq('a list says nothing', lib.releaseFromAnswer([]), null)
eq('notes that are no list say nothing', lib.releaseFromAnswer({ notes: 'x', tourOffered: false }), null)
eq('a word for no says nothing', lib.releaseFromAnswer({ notes: [], tourOffered: 'false' }), null)
eq('nothing to read', lib.releaseFromAnswer(NOTHING()), NOTHING())
eq('the notes as sent', lib.releaseFromAnswer({ notes: [ENTRY], tourOffered: false })?.notes[0], { id: ID, title: 'A title', notes: [{ text: 'A line.', needs: '' }, { text: 'A tab line.', needs: 'performance' }], tour: ['loads'] })
eq('the offer as sent', lib.releaseFromAnswer({ notes: [], tourOffered: true })?.tourOffered, true)
const decoyEntry = { ...ENTRY, driverName: 'Decoy Name', notes: [{ text: 'A line.', pay: 987 }] }
const copied = JSON.stringify(lib.releaseFromAnswer({ notes: [decoyEntry], tourOffered: false, name: 'Decoy Name', signInDue: true, releaseId: ID }))
ok('nothing else on an answer gets through', !/Decoy|987|driverName|pay|signInDue|releaseId/.test(copied), copied)
eq('a broken note is dropped', lib.releaseFromAnswer({ notes: [{ id: ID }, 'text', null], tourOffered: false })?.notes, [])

// ── §4 ────────────────────────────────────────────────────────────────────
section('4 only what their app has')
const OLD_ID = '2026-01-01-older'
const answered = lib.releaseFromAnswer({ notes: [ENTRY, { id: OLD_ID, title: 'Older', notes: [{ text: 'Only with the tab.', needs: 'performance' }], tour: ['performance'] }], tourOffered: false })?.notes
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

// ── the world for §5 to §7 ─────────────────────────────────────────────────
// `signedIn`: the view opens right after a sign-in. The world's server answers what's unread every time,
// as the real one does, so anything that stays off screen here stays off by the app's own doing.
function world(start = {}) {
  const s = reactive({
    role: 'Driver', signedIn: true, onboarding: false, performance: true, partsKnown: true, motionAllowed: true, tab: 'loads', loadOpen: false,
    welcomeOpen: false, dialogOpen: false, ...start,
  })
  const calls = { gets: 0, posts: [], steps: [], restored: [], toasts: [] }
  const box = { answer: NOTHING }
  const options = {
    api: {
      get: async (url) => { calls.gets++; eq('it reads the release route', url, RELEASE_URL); return box.answer() },
      post: async (url, body) => { calls.posts.push([url, body]); return { success: true } },
    },
    role: () => s.role,
    takeSignIn: () => { const taken = s.signedIn; s.signedIn = false; return taken },
    has: () => ({ performance: s.performance }),
    motionAllowed: () => s.motionAllowed,
    noteInputs: () => ({ onboarding: s.onboarding, partsKnown: s.partsKnown, tab: s.tab, loadOpen: s.loadOpen, welcomeOpen: s.welcomeOpen, dialogOpen: s.dialogOpen }),
    place: () => s.tab,
    showStep: (step) => { calls.steps.push(step.id); s.tab = step.tab },
    restorePlace: (tab) => { calls.restored.push(tab); s.tab = tab },
    toast: (text) => calls.toasts.push(text),
  }
  return { s, calls, box, options, release: useDriverRelease(options) }
}

// ── §5 ────────────────────────────────────────────────────────────────────
section('5 no forced sign-out')
{
  // Everything a sign-out could read, all saying yes, and a way to sign out in reach. An answer says a
  // sign-in is due, so nothing here is held back by the answer.
  const w = world()
  const SAFE_INPUTS = { loaded: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false, loadsHold: false, writesBusy: false, otherTabOpen: false, visible: true, online: true, parked: true }
  let signOuts = 0
  let facts = 0
  const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
  const within = { ...w.options, userId: () => 2, signOutInputs: () => SAFE_INPUTS, refreshFacts: async () => { facts++ }, signOut: () => { signOuts++ }, localStorage: storage(), sessionStorage: storage(), now: () => 1_800_000_000_000 }
  w.box.answer = () => ({ signInDue: true, releaseId: ID, notes: [], tourOffered: false })
  const release = useDriverRelease(within)
  for (const how of [undefined, {}, { appOpening: true }, { appOpening: 'yes' }]) await release.check(how)
  eq('an answer saying a sign-in is due, as the app opens, every old input saying yes: nobody is signed out', signOuts, 0)
  eq('...and nothing is read for one', facts, 0)
  eq('...and nothing is kept in the browser for one', [within.localStorage.getItem('logisx.driverRelease.signedOut.v1.2'), within.sessionStorage.getItem('logisx.driverRelease.loginNote.v1')], [null, null])
}
{
  // Whatever the driver does here, the composable reaches only for what it's handed to read and show.
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  const touched = new Set()
  const watched = new Proxy(w.options, { get(target, key) { touched.add(String(key)); return target[key] } })
  const release = useDriverRelease(watched)
  await release.check()
  void release.noteView.value
  release.noteGotIt()
  release.offerSkip()
  release.startAppTour()
  release.tourNext()
  release.tourSkip()
  await tick()
  eq('what it takes from the view is these and no others, none of them a way out', [...touched].sort(), ['api', 'has', 'motionAllowed', 'noteInputs', 'place', 'restorePlace', 'role', 'showStep', 'takeSignIn'])
}
{
  const VIEW_TEXT = read('views/DriverView.vue')
  const viewScript = VIEW_TEXT.slice(VIEW_TEXT.indexOf('<script setup>'), VIEW_TEXT.indexOf('</script>'))
  eq('in the view\'s script, handleLogout is defined and never called or handed on', [...viewScript.replace(/^\s*\/\/.*$/gm, '').matchAll(/handleLogout/g)].length, 1)
  const inTemplate = [...VIEW_TEXT.slice(0, VIEW_TEXT.indexOf('<script setup>')).matchAll(/([@\w:-]+)="handleLogout"/g)].map((m) => m[1])
  ok('in its template, only the Logout buttons reach it', inTemplate.length > 0 && inTemplate.every((attr) => attr === '@logout' || attr === '@click'), inTemplate)
  const block = viewScript.slice(viewScript.indexOf('const release = useDriverRelease({'), viewScript.indexOf('const releaseFeatureOn'))
  ok('the view hands the composable no way out', block.length > 0 && !/signOut|logout|auth\.|refreshFacts/i.test(block.replace(/role: \(\) => auth\.user\?\.role,/, '')), block)
  const code = read('composables/useDriverRelease.js')
  ok('the composable has no road to a sign-out of its own: no store, no logout, no page change', !/signOut|logout|useAuthStore|location\b|\/login|router|localStorage|sessionStorage/i.test(code.replace(/^\/\/.*$/gm, '')))
  for (const gone of ['lib/appOpening.js', 'lib/appTabs.js', 'lib/writesInFlight.js']) ok(`${gone} is gone`, !fs.existsSync(path.join(CLIENT, gone)))
  const leftovers = /signInDue|signOutMoment|SIGN_OUT_PARKED_MS|parkedLongEnough|loadsHoldSignOut|rememberSignOut|signedOutFor|leaveLoginNote|takeLoginNote|LOGIN_NOTE_KEY|updatedNote|login-updated-note|The app was updated|isFirstScreen|noteScreenShown|thisPageTabs|otherPageOpen|writesBusy|writeStarted|logisx\.driverRelease|logisx\.appPage|handleLoadBack|handleNavTap|releaseDialogOpen|loadPageOpen/
  eq('nothing in the app still names any part of it', walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && leftovers.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(CLIENT, f)), [])
  ok('the truck read reports nothing: no caller decides by it', !/await driverPos\.refreshEld\(\)/.test(viewScript) && !/return (true|false)/.test(read('composables/useDriverPosition.js').slice(read('composables/useDriverPosition.js').indexOf('async function refreshEld()'), read('composables/useDriverPosition.js').indexOf('// ─── Lifecycle'))))
}

// ── §6 ────────────────────────────────────────────────────────────────────
section('6 only right after a sign-in')
{
  const w = world({ signedIn: false })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('a load with no sign-in shows nothing, though the server has a note and an offer', w.release.noteView.value, null)
  eq('...and marks nothing', w.calls.posts, [])
  eq('...and the good answer still tells the Kit it is on', w.release.featureOn.value, true)
}
{
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: false })
  await w.release.check()
  eq('right after a sign-in it shows', w.release.noteView.value?.mode, 'notes')
  eq('...and the sign-in is spent', w.s.signedIn, false)
  const reloaded = useDriverRelease(w.options)
  await reloaded.check()
  eq('the view opening again in that session shows nothing new', reloaded.noteView.value, null)
}
{
  const w = world({ signedIn: false })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  w.s.partsKnown = true
  w.s.motionAllowed = false
  await tick()
  w.s.motionAllowed = true
  await tick()
  eq("nothing on an open page brings it up: the page's inputs changing shows nothing", [w.release.noteView.value, w.calls.gets], [null, 1])
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
  w.box.answer = () => { throw fail }
  await w.release.check()
  eq(`a failed read (${label}) shows nothing, with no Kit button`, [w.release.noteView.value, w.release.featureOn.value], [null, false])
  eq(`...and spends the sign-in, so it isn't retried on this page (${label})`, w.s.signedIn, false)
}
{
  const w = world()
  w.box.answer = () => ({})
  await w.release.check()
  eq("useApi's unreadable body shows nothing, with no Kit button", [w.release.noteView.value, w.release.featureOn.value], [null, false])
}
{
  const w = world()
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 404, code: 'FEATURE_OFF' }) }
  await w.release.check()
  eq('the kill switch: nothing shows, and no Kit button', [w.release.featureOn.value, w.release.noteView.value], [false, null])
  eq('...and nothing is marked', w.calls.posts, [])
}
for (const role of ['Super Admin', 'Dispatcher', 'Investor', 'KPI Viewer', undefined]) {
  const w = world({ role })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq(`${role || 'nobody'} never even asks`, [w.calls.gets, w.release.noteView.value], [0, null])
}
{
  // The lock screen: it asks, so the Kit knows once the lock lifts, and shows nothing.
  const w = world({ onboarding: true })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('a sign-in that lands on the lock screen shows nothing', w.release.noteView.value, null)
  eq('...and marks nothing, so it comes at their next sign-in', w.calls.posts, [])
  w.s.onboarding = false
  await tick()
  eq('...and the lock lifting on this page brings up nothing', w.release.noteView.value, null)
}

// ── §7 ────────────────────────────────────────────────────────────────────
section('7 the note, the offer and the tour')
const NOTE_ANSWER = () => ({ notes: [{ ...ENTRY, tour: ['loads', 'performance', 'fuel-range'] }], tourOffered: false })
for (const [label, start, clear] of [
  ["the Performance answer isn't known", { partsKnown: false, performance: false }, (s) => { s.partsKnown = true; s.performance = true }],
  ['another tab', { tab: 'kit' }, (s) => { s.tab = 'loads' }],
  ["a load's page", { loadOpen: true }, (s) => { s.loadOpen = false }],
  ['the welcome window', { welcomeOpen: true }, (s) => { s.welcomeOpen = false }],
  ['another window', { dialogOpen: true }, (s) => { s.dialogOpen = false }],
]) {
  const w = world(start)
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq(`${label}: a no shows nothing`, w.release.noteView.value, null)
  eq(`...marks nothing, so it comes at their next sign-in (${label})`, w.calls.posts, [])
  clear(w.s)
  await tick()
  eq(`...and doesn't wait: it stays off this page once that clears (${label})`, w.release.noteView.value, null)
  eq(`...the feature is still on for the Kit (${label})`, w.release.featureOn.value, true)
}
{
  const w = world({ partsKnown: false })
  w.box.answer = () => ({ notes: [], tourOffered: true })
  await w.release.check()
  eq("a first-time driver's offer needs the Performance answer too: the whole tour depends on it", w.release.noteView.value, null)
}
{
  // The truck isn't read for the note, and nothing moves on a page because the truck did.
  const w = world({ motionAllowed: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq('a sign-in on a truck read as moving still shows the note', w.release.noteView.value?.mode, 'notes')
  w.s.motionAllowed = true
  await tick()
  eq('the truck stopping leaves it as it is', w.release.noteView.value?.mode, 'notes')
  w.s.motionAllowed = false
  await tick()
  eq('the truck moving leaves it as it is', w.release.noteView.value?.mode, 'notes')
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  const view = w.release.noteView.value
  eq('what it says', [view.mode, view.canShowMe, view.entries[0].title, view.entries[0].lines], ['notes', true, 'A title', ['A line.', 'A tab line.']])
  eq('it counts as on screen', w.release.onScreen?.value, true)
  w.release.noteGotIt()
  await tick()
  eq('Got it: marked seen', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  eq('...closed', [w.release.noteView.value, w.release.onScreen?.value], [null, false])
  await w.release.check()
  eq('...and not back in this view, whatever the next answer says', w.release.noteView.value, null)
  eq('Got it starts no tour', w.calls.steps, [])
}
{
  const w = world({ performance: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq('with no Performance tab they read only their lines', w.release.noteView.value.entries[0].lines, ['A line.'])
  w.release.noteShowMe()
  await tick()
  eq('...and the tour skips that tab', w.calls.steps, ['loads'])
}
{
  const w = world({ performance: false })
  w.box.answer = () => ({ notes: [{ id: ID, title: 'Tab only', notes: [{ text: 'Only with the tab.', needs: 'performance' }], tour: ['performance'] }], tourOffered: false })
  await w.release.check()
  eq("a release that's all about a tab they haven't got shows nothing", w.release.noteView.value, null)
  eq('...and writes nothing', w.calls.posts, [])
}
{
  const w = world()
  w.box.answer = () => ({ notes: [{ id: ID, title: 'No tour', notes: [{ text: 'Just a line.' }], tour: [] }], tourOffered: false })
  await w.release.check()
  eq('nothing to show them: no Show me', w.release.noteView.value.canShowMe, false)
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
  eq('the tour counts as on screen', w.release.onScreen?.value, true)
  w.release.tourNext()
  eq('Next: the Performance tab', [w.calls.steps, w.s.tab, w.release.tourView.value.label], [['loads', 'performance'], 'performance', 'Step 2 of 3'])
  w.release.tourNext()
  eq('Next: the fuel range', [w.s.tab, w.release.tourView.value.last], ['loads', true])
  eq('nothing written along the way', w.calls.posts.length, 1)
  w.release.tourNext()
  await tick()
  eq('Done: only tour_done_at', w.calls.posts.slice(1), [[TOUR_DONE_URL, { ids: [ID] }]])
  eq('...closed and back where they were', [w.release.tourView.value, w.release.tourOpen.value, w.release.onScreen?.value, w.calls.restored], [null, false, false, ['loads']])
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
  eq('...back where they were', [w.release.tourOpen.value, w.calls.restored, w.s.tab], [false, ['loads'], 'loads'])
  await w.release.check()
  eq('...and no nagging', [w.release.noteView.value, w.release.tourOpen.value], [null, false])
}
{
  // A moving truck's open page never changes: not the tour either.
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.s.motionAllowed = false
  await tick()
  eq('the truck starts moving: the tour stays up until they end it', [w.release.tourOpen.value, w.calls.restored], [true, []])
  eq('...and writes nothing', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
  w.release.tourNext()
  eq('...and Next still works', w.release.tourView.value?.label, 'Step 2 of 3')
  w.release.tourSkip()
  eq('...and so does Skip', w.release.tourOpen.value, false)
}
{
  const w = world()
  w.box.answer = () => ({ notes: [], tourOffered: true })
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
  w.box.answer = () => ({ notes: [], tourOffered: true })
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
  const w = world({ tab: 'kit', signedIn: false })
  await w.release.check()
  w.release.startAppTour()
  await tick()
  eq('the Kit runs the whole tour any time, writing nothing to start', [w.release.tourView.value.label, w.calls.posts], ['Step 1 of 8', []])
  w.release.tourSkip()
  eq('...and goes back to the Kit', w.s.tab, 'kit')
  w.s.motionAllowed = false
  await tick()
  w.release.startAppTour()
  eq('with the truck read as moving it says when, and starts nothing', [w.calls.toasts, w.release.tourOpen.value], [[WORDS.whenParked], false])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.s.motionAllowed = false
  await tick()
  w.release.noteShowMe()
  await tick()
  eq('Show me on a truck read as moving: the note is answered, it says when, and no tour starts', [w.calls.posts, w.calls.toasts, w.release.tourOpen.value, w.release.noteView.value], [[[SEEN_URL, { ids: [ID] }]], [WORDS.whenParked], false, null])
}
{
  const w = world()
  w.box.answer = () => ({ notes: [], tourOffered: true })
  await w.release.check()
  w.s.motionAllowed = false
  await tick()
  w.release.offerTake()
  await tick()
  eq('Take the tour on a truck read as moving: the same, and the Kit still has it', [w.calls.posts, w.calls.toasts, w.release.tourOpen.value, w.release.noteView.value], [[[SEEN_URL, { ids: [APP_TOUR_ROW] }]], [WORDS.whenParked], false, null])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  w.options.api.post = async () => { throw new Error('no signal') }
  const release = useDriverRelease(w.options)
  await release.check()
  release.noteGotIt()
  await tick()
  eq('a mark that fails holds nothing up, and the note stays gone from this page', release.noteView.value, null)
  await release.check()
  eq('...not twice in this session: unmarked, it comes at their next sign-in', release.noteView.value, null)
}
{
  // The tour's row and the notes in one answer: the notes first, then the offer.
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('notes first', w.release.noteView.value.mode, 'notes')
  w.release.noteGotIt()
  eq('then the offer', w.release.noteView.value.mode, 'offer')
}
{
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq('Show me leaves the offer for their next sign-in: it opens neither over the tour', w.release.noteView.value, null)
  w.release.tourSkip()
  await tick()
  eq('...nor after it', w.release.noteView.value, null)
  eq('...and marks only the note', w.calls.posts, [[SEEN_URL, { ids: [ID] }]])
}

// ── §8 ────────────────────────────────────────────────────────────────────
section('8 DriverView.vue and the login form')
const VIEW = read('views/DriverView.vue')
const script = VIEW.slice(VIEW.indexOf('<script setup>'), VIEW.indexOf('</script>'))
function fn(head) {
  const a = script.indexOf(head)
  if (a < 0) return ''
  return script.slice(a, script.indexOf('\n}\n', a) + 2)
}
const checks = [...script.matchAll(/release\.check\(([^)]*)\)/g)].map((m) => m[1])
eq('it reads at one place and no other: nothing on an open page asks, no socket, timer, tap or coming back', checks, [''])
ok('as the view opens, after the Performance answer', /checkPerformanceTab\(\)\.then\(\(\) => release\.check\(\)\)\n\s+\} catch/.test(fn('async function attemptInitialLoad()')))
ok('coming back to the app reads the loads, as it did, and asks nothing of this', /visibilityState === 'visible' && isMounted\) \{\n\s+scheduleDriverRefetch\(\)\n\s+\}/.test(fn('function onVisibilityChange()')))
ok("a load's page goes back as it did", /@back="detailRowIndex = null"/.test(VIEW))
ok('the tab bar switches as it did', /@switch="handleTabSwitch"/.test(VIEW))

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
eq('a yes from the server: known, and they have the tab', await probeScene(async () => ({ weeks: [] })), [true, true])
eq('a no (the switch off, or no week to show): known, and they have none', await probeScene(refusal(404)), [true, false])
eq('a failed probe (503): not known, so the note stays off this page', await probeScene(refusal(503)), [false, false])
eq('no signal: not known', await probeScene(async () => { throw new TypeError('Failed to fetch') }), [false, false])
eq('a failed probe still settles, so the read after it goes ahead and the Kit learns it is on', await probeScene(refusal(503)).then(() => 'settled'), 'settled')
ok('it starts unknown', /const performanceKnown = ref\(false\)/.test(script))
const inputs = script.slice(script.indexOf('noteInputs: () => ({'), script.indexOf('place: () => currentTab.value'))
ok('the note reads the Performance answer', /partsKnown: performanceKnown\.value/.test(inputs))
ok("...the tab and a load's page", /tab: currentTab\.value/.test(inputs) && /loadOpen: detailLoad\.value != null/.test(inputs))
ok('...the lock screen', /onboarding: isOnboarding\.value/.test(inputs))
ok('...the welcome window', /welcomeOpen: showWelcomeModal\.value/.test(inputs))
ok('...and the windows it could land on', /dialogOpen: showSignModal\.value \|\| showDeclineConfirm\.value \|\| showContactsForm\.value \|\| showContactsPrompt\.value/.test(inputs))
ok('...and not the truck: the gate goes to the tour alone', !/voiceGate|motion|contactsPromptReady/i.test(inputs) && /motionAllowed: \(\) => voiceGate\.value\.allowed/.test(script))
ok('the view hands in the one-shot', /import \{ takeSignIn \} from '\.\.\/lib\/signInMoment'/.test(script) && /\n  takeSignIn,\n/.test(script))
const LOGIN = read('views/LoginView.vue')
const doLogin = LOGIN.slice(LOGIN.indexOf('async function doLogin()'), LOGIN.indexOf('</script>'))
ok('the login form notes the sign-in, after it succeeded and before the app opens', /await auth\.login\(loginForm\.username, loginForm\.password\)\n\s+noteSignIn\(\)\n\s+freshPageComing = isLeavingPage\(\)\n\s+router\.push\(auth\.roleHome\)/.test(doLogin))
const doSetup = LOGIN.slice(LOGIN.indexOf('async function doSetup()'), LOGIN.indexOf('async function doLogin()'))
ok('the first admin setup notes nothing', !/noteSignIn/.test(doSetup))
eq('a refused sign-in notes nothing: it comes after the call, inside its try', /noteSignIn\(\)[\s\S]*catch \(err\)/.test(doLogin), true)
if (signInMoment) {
  eq('with no sign-in there is nothing to take', signInMoment.takeSignIn(), false)
  signInMoment.noteSignIn()
  eq('a sign-in is taken', signInMoment.takeSignIn(), true)
  eq('...once', signInMoment.takeSignIn(), false)
}
ok('it lives in memory alone, so a reload is no sign-in', !/localStorage|sessionStorage|location|history|cookie/.test(read('lib/signInMoment.js').replace(/^\/\/.*$/gm, '')))
const stepFn = fn('function showTourStep(step)')
ok('a step shows the real tab', /currentTab\.value = step\.tab/.test(stepFn))
ok('a step marks nothing read: no handleTabSwitch', stepFn !== '' && !/handleTabSwitch|markMessagesRead|markNotificationsRead/.test(stepFn))
ok('a step leaves the store alone, so a message arriving stays unread', !/driverStore\.currentTab/.test(stepFn))
ok('the Messages tab opening in the tour marks nothing read', /function handleMarkRead\(ids\) \{[\s\S]{0,120}if \(release\.tourOpen\.value\) return\n\s+driverStore\.markMessagesRead\(ids\)/.test(script))
ok('the contacts prompt waits for the note and the tour', /dialogOpen: showSignModal\.value \|\| showDeclineConfirm\.value \|\| showContactsForm\.value \|\| release\.onScreen\.value/.test(script))
ok('a new load tapped during the tour ends it', /release\.closeTour\(\)\n\s+currentTab\.value = 'loads'/.test(fn('function viewAssignedLoad()')))
ok('the note and the tour sit in the normal app only', VIEW.indexOf('<DriverReleaseNote') > VIEW.indexOf('NORMAL DRIVER UI') && VIEW.indexOf('<DriverAppTour') > VIEW.indexOf('NORMAL DRIVER UI'))
ok("the Kit's button only with a good answer", /<section v-if="releaseFeatureOn" class="card tour-kit"/.test(VIEW))
ok("the Kit's button runs the tour", /@click="release\.startAppTour"/.test(VIEW))
ok('the training videos only when the Kit has them', /:videos="driverStore\.trainingVideos === 'kit'"/.test(VIEW))
ok('the tour ends on them: finished, then the Kit', /release\.tourFinish\(\)\n\s+handleTabSwitch\('kit'\)/.test(fn('function tourToVideos()')))

// ── §9 ────────────────────────────────────────────────────────────────────
section('9 the components and the rest of the app')
const NOTE = read('components/driver/DriverReleaseNote.vue')
const TOUR = read('components/driver/DriverAppTour.vue')
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
for (const [label, rel] of [['the login page', 'views/LoginView.vue'], ['the session store', 'stores/auth.js'], ['the router', 'router/index.js'], ['the app\'s start', 'main.js'], ['useApi', 'composables/useApi.js']]) {
  ok(`${label} knows nothing of this feature`, !/driverRelease|DriverRelease|appTabs|appOpening|writesInFlight/.test(read(rel)))
}

// ── §10 ───────────────────────────────────────────────────────────────────
section('10 only the driver app reads any of it')
const importers = walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && /driverReleaseNotices|useDriverRelease|driver\/me\/release/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(CLIENT, f).replaceAll(path.sep, '/')).sort()
eq('these files and no others', importers, ['components/driver/DriverAppTour.vue', 'components/driver/DriverReleaseNote.vue', 'composables/useDriverRelease.js', 'lib/driverReleaseNotices.js', 'views/DriverView.vue'])
const oneShot = walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && /signInMoment/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(CLIENT, f).replaceAll(path.sep, '/')).sort()
eq('the one-shot: the login form notes it and the driver app takes it, and nothing else knows it', oneShot, ['views/DriverView.vue', 'views/LoginView.vue'])

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} of ${pass + failures.length}`)
  process.exit(1)
}
console.log(`\nok: ${pass} checks`)
process.exit(0)
