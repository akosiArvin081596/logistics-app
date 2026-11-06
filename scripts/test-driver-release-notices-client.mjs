#!/usr/bin/env node
// New-feature notices for drivers, the app's side: the rules in client/src/lib/driverReleaseNotices.js,
// composables/useDriverRelease.js driven for real on Vue's own reactivity, and how DriverView.vue and
// the two components use them. The server's side is scripts/test-driver-release-notices.js;
// scripts/e2e/driver-release-notices.mjs covers the page.
//   §1  the words, exact, and plain: no figure, no name, no word a driver wouldn't use; none that's
//       false for a driver who can read it, and none about being signed out
//   §2  noteMoment(): each input holds the note, and a working load doesn't
//   §3  releaseFromAnswer(): what an answer may and may not say; an unreadable body says nothing
//   §4  notesForScreen(), tourStepsFor(), tourCardView(): only what this driver's app has
//   §5  no forced sign-out: an answer that says one is due, at an app opening, with a way to sign out
//       in reach, signs nobody out; this feature has no road to handleLogout; the code for it is gone
//   §6  a read through useDriverRelease: a failed read changes nothing; only a Driver, off the lock screen
//   §7  the note, the offer and the tour through useDriverRelease: once, what each writes, skip, motion;
//       the note waits for the Performance answer
//   §8  DriverView.vue: a read starts by their own moves and no others: a cancel, a refetch or a tab
//       taken away closing a page starts none, run on the view's own statements; no timer, no socket;
//       the tour marks nothing read
//   §9  the components, and a login page that knows nothing of this
//   §10 only the driver app reads any of it
//   §11 the real truck read, over a stubbed fetch: a moving truck holds the note and closes the tour,
//       one on a feed that sends no speed included; a truck not reporting doesn't hold them
//
// No DOM, no server, no build.
//   node scripts/test-driver-release-notices-client.mjs      # exits 1 on any failure
import fs from 'fs'
import { registerHooks } from 'module'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client', 'src')
// The truck read imports without an extension, as Vite allows; plain Node needs a hand.
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

let lib, composable, vue, useApiModule
try {
  lib = await load('lib/driverReleaseNotices.js')
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
const FREE = Object.freeze({ role: 'Driver', settled: true, partsKnown: true, onboarding: false, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false, tourOpen: false, motionAllowed: true })
eq('on the list, not moving: the note may show', lib.noteMoment(FREE), true)
eq('a working load does not hold it: they can read at a shipper', lib.noteMoment({ ...FREE, loadsHold: true }), true)
for (const [label, change] of [
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
for (const key of Object.keys(FREE)) {
  const missing = { ...FREE }
  delete missing[key]
  eq(`held: ${key} not known`, lib.noteMoment(missing), false)
}
eq('held: no inputs', lib.noteMoment(null), false)

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
function world(start = {}) {
  const s = reactive({
    role: 'Driver', onboarding: false, mounted: true, performance: true, partsKnown: true, motionAllowed: true, settled: true, tab: 'loads', loadOpen: false,
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
    onboarding: () => s.onboarding,
    mounted: () => s.mounted,
    has: () => ({ performance: s.performance }),
    motionAllowed: () => s.motionAllowed,
    noteInputs: () => ({ onboarding: s.onboarding, settled: s.settled, partsKnown: s.partsKnown, tab: s.tab, loadOpen: s.loadOpen, welcomeOpen: s.welcomeOpen, dialogOpen: s.dialogOpen, motionAllowed: s.motionAllowed }),
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
  // Everything the sign-out ever read, all saying yes, and a way to sign out in reach. An older
  // server's answer says a sign-in is due, so nothing here is held back by the answer.
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
  release.noteShowMe()
  release.tourNext()
  release.tourSkip()
  release.startAppTour()
  release.tourSkip()
  release.offerSkip()
  await tick()
  eq('what it takes from the view is these and no others, none of them a way out', [...touched].sort(), ['api', 'has', 'motionAllowed', 'mounted', 'noteInputs', 'onboarding', 'place', 'restorePlace', 'role', 'showStep'])
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
  const leftovers = /signInDue|signOutMoment|SIGN_OUT_PARKED_MS|parkedLongEnough|loadsHoldSignOut|rememberSignOut|signedOutFor|leaveLoginNote|takeLoginNote|LOGIN_NOTE_KEY|updatedNote|login-updated-note|The app was updated|isFirstScreen|noteScreenShown|thisPageTabs|otherPageOpen|writesBusy|writeStarted|logisx\.driverRelease|logisx\.appPage/
  eq('nothing in the app still names any part of it', walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && leftovers.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(CLIENT, f)), [])
  ok('the truck read goes back to reporting nothing: no caller decides by it', !/await driverPos\.refreshEld\(\)/.test(viewScript) && !/return (true|false)/.test(read('composables/useDriverPosition.js').slice(read('composables/useDriverPosition.js').indexOf('async function refreshEld()'), read('composables/useDriverPosition.js').indexOf('// ─── Lifecycle'))))
}

// ── §6 ────────────────────────────────────────────────────────────────────
section('6 a read')
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
  eq(`a failed read (${label}) shows nothing`, [w.release.noteView.value, w.release.featureOn.value], [null, false])
}
{
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: false })
  await w.release.check()
  eq('a good answer turns it on', [w.release.featureOn.value, w.release.noteView.value?.mode], [true, 'notes'])
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 503 }) }
  await w.release.check()
  eq('a failed read later changes nothing', [w.release.featureOn.value, w.release.noteView.value?.mode], [true, 'notes'])
  w.box.answer = () => ({})
  await w.release.check()
  eq('nor does an unreadable body', w.release.noteView.value?.mode, 'notes')
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 404, code: 'FEATURE_OFF' }) }
  await w.release.check()
  eq('the kill switch: nothing shows, the Kit button goes', [w.release.featureOn.value, w.release.noteView.value], [false, null])
}
for (const role of ['Super Admin', 'Dispatcher', 'Investor', 'KPI Viewer', undefined]) {
  const w = world({ role })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq(`${role || 'nobody'} never even asks`, w.calls.gets, 0)
}
{
  const w = world({ onboarding: true })
  await w.release.check()
  eq('the lock screen never asks', w.calls.gets, 0)
}
{
  const w = world({ onboarding: undefined })
  await w.release.check()
  eq('before they are known to be off it, neither', w.calls.gets, 0)
}
{
  const w = world()
  w.box.answer = () => { w.s.mounted = false; return { notes: [ENTRY], tourOffered: false } }
  await w.release.check()
  eq('a view left while it read keeps nothing', w.release.featureOn.value, false)
}
{
  // Two moments at once: the newer one decides.
  const w = world()
  let n = 0
  w.box.answer = () => (++n === 1 ? { notes: [ENTRY], tourOffered: false } : NOTHING())
  await Promise.all([w.release.check(), w.release.check()])
  eq('two moments at once: the newer answer stands', w.release.noteView.value, null)
}

// ── §7 ────────────────────────────────────────────────────────────────────
section('7 the note, the offer and the tour')
const NOTE_ANSWER = () => ({ notes: [{ ...ENTRY, tour: ['loads', 'performance', 'fuel-range'] }], tourOffered: false })
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
  w.box.answer = () => ({ notes: [], tourOffered: true })
  await w.release.check()
  eq("a first-time driver's offer waits for it too: the whole tour depends on it", w.release.noteView.value, null)
}
{
  const w = world({ settled: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq("before things settle, it's held", w.release.noteView.value, null)
  w.s.settled = true
  eq('settled, it shows, with no new read', [w.release.noteView.value.mode, w.calls.gets], ['notes', 1])
  w.s.motionAllowed = false
  eq('the truck starts moving: held', w.release.noteView.value, null)
  w.s.motionAllowed = true
  eq('parked again: it waited', w.release.noteView.value.mode, 'notes')
  w.s.loadOpen = true
  eq("a load's page: held", w.release.noteView.value, null)
  w.s.loadOpen = false
  eq('...and back', w.release.noteView.value.mode, 'notes')
  w.box.answer = NOTHING
  await w.release.check()
  eq('an answer with no notes, as a session from before the entry gets, shows nothing', w.release.noteView.value, null)
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
  eq('...closed and back where they were', [w.release.tourView.value, w.release.tourOpen.value, w.calls.restored], [null, false, ['loads']])
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
  const w = world({ tab: 'kit' })
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
  w.box.answer = () => ({ notes: [], tourOffered: true })
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
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('notes first', w.release.noteView.value.mode, 'notes')
  w.release.noteGotIt()
  eq('then the offer', w.release.noteView.value.mode, 'offer')
}

// ── §8 ────────────────────────────────────────────────────────────────────
section('8 DriverView.vue')
const VIEW = read('views/DriverView.vue')
const script = VIEW.slice(VIEW.indexOf('<script setup>'), VIEW.indexOf('</script>'))
function fn(head) {
  const a = script.indexOf(head)
  if (a < 0) return ''
  return script.slice(a, script.indexOf('\n}\n', a) + 2)
}
const checks = [...script.matchAll(/release\.check\(([^)]*)\)/g)].map((m) => m[1])
eq('it reads at four places and no others, each handing in nothing', checks, ['', '', '', ''])
ok('when the app opens', /checkPerformanceTab\(\)\n\s+release\.check\(\)\n\s+\} catch/.test(fn('async function attemptInitialLoad()')))
ok('when they come back to the app', /visibilityState === 'visible' && isMounted\) \{\n\s+scheduleDriverRefetch\(\)\n\s+release\.check\(\)/.test(fn('function onVisibilityChange()')))
ok("when they leave a load's page themselves", /@back="handleLoadBack"/.test(VIEW))
ok('when they tap a tab themselves', /@switch="handleNavTap"/.test(VIEW))

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
  eq('(the scene) their load page is open', !!open.detailLoad.value, true)
  open.onLoadCancelled({ loadId: 'QA-1', reason: 'cancelled' })
  await flush()
  eq('a socket push cancelling their load closes the page and starts no read', [!!open.detailLoad.value, open.checks], [false, 0])

  const refetched = await placeScene()
  refetched.driverStore.loads = []
  await flush()
  eq('a refetch where their open load has left the list closes the page and starts no read', [!!refetched.detailLoad.value, refetched.checks], [false, 0])

  const taken = await placeScene({ tab: 'performance', rowOpen: null, performance: true })
  taken.performanceTab.value = false
  await flush()
  eq('a Performance tab taken away goes back to the list and starts no read', [taken.currentTab.value, taken.checks], ['loads', 0])

  const back = await placeScene()
  ok('(the scene) the load page has its back handler', typeof back.handleLoadBack === 'function')
  back.handleLoadBack?.()
  await flush()
  eq("their own back from a load's page closes it and starts one read", [!!back.detailLoad.value, back.checks], [false, 1])

  const nav = await placeScene({ tab: 'kit', rowOpen: null })
  ok('(the scene) the tab bar has its tap handler', typeof nav.handleNavTap === 'function')
  nav.handleNavTap?.('messages')
  await flush()
  eq('tapping another tab starts no read', nav.checks, 0)
  nav.handleNavTap?.('loads')
  await flush()
  eq('tapping Loads, back to the list, starts one', [nav.currentTab.value, nav.checks], ['loads', 1])

  const toLoad = await placeScene({ tab: 'kit' })
  toLoad.handleNavTap?.('loads')
  await flush()
  eq("tapping Loads with a load's page still open there starts none", [!!toLoad.detailLoad.value, toLoad.checks], [true, 0])
} catch (e) {
  ok(`the scenes of who starts a read ran: ${e.message}`, false)
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
eq('a yes from the server: known, and they have the tab', await probeScene(async () => ({ weeks: [] })), [true, true])
eq('a no (the switch off, or no week to show): known, and they have none', await probeScene(refusal(404)), [true, false])
eq('a failed probe (503): not known, so the note keeps holding', await probeScene(refusal(503)), [false, false])
eq('no signal: not known', await probeScene(async () => { throw new TypeError('Failed to fetch') }), [false, false])
ok('it starts unknown', /const performanceKnown = ref\(false\)/.test(script))
ok('the note reads it', /partsKnown: performanceKnown\.value/.test(script))
{
  const detailLoad = vue.ref(null)
  const loadPageOpen = new Function('detailLoad', `${between('const loadPageOpen = ', '\n')}\nreturn loadPageOpen`)(detailLoad)
  eq('with no load open, nothing holds the note', loadPageOpen(), false)
  detailLoad.value = { _rowIndex: 7 }
  eq("a load's page on screen holds it", loadPageOpen(), true)
  ok('...and the note is told', /loadOpen: loadPageOpen\(\)/.test(script))
}

for (const head of ['function scheduleDriverRefetch()', 'function onLoadAssigned(payload)', 'function onInstructionsChanged(payload)', 'function onResignRequested()', 'function onTimeOffUpdated()', 'function onLoadCancelled(payload)', 'function onGeofenceTrigger(payload)', 'function onLocationUpdate(payload)', 'function onNewMessage(msg)']) {
  const body = fn(head)
  ok(`no socket push or refetch asks: ${head}`, body !== '' && !/release\.check/.test(body))
}
ok('no timer asks', ![...script.matchAll(/set(?:Timeout|Interval)\([\s\S]{0,200}?\)/g)].some((m) => /release\.check/.test(m[0])))
ok('a socket reconnect does not ask', !/isConnected\.value[\s\S]{0,200}release\.check/.test(script))
ok('the note and the tour, by the same gate as the contacts prompt', /motionAllowed: \(\) => voiceGate\.value\.allowed/.test(script) && /settled: contactsPromptReady\.value[\s\S]{0,300}motionAllowed: voiceGate\.value\.allowed/.test(script))
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

// ── §9 ────────────────────────────────────────────────────────────────────
section('9 the components and the login page')
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

// ── §11 ───────────────────────────────────────────────────────────────────
section('11 the real truck read')
const { useDriverPosition } = await load('composables/useDriverPosition.js')
const { recordGate } = await load('lib/voiceNoteGate.js')
const jsonReply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const truck = ({ speed = 0, age = 5000, stopped = 10 * 60 * 1000 } = {}) => () => jsonReply({
  ok: true,
  position: { latitude: 29.7, longitude: -95.3, speed, source: 'routemate', lastPingAge: age, timestamp: new Date(Date.now() - age).toISOString(), ...(speed === 0 ? { stoppedSinceMs: stopped === null ? null : Date.now() - stopped } : {}) },
})
const noReading = () => () => jsonReply({ ok: true, position: null, reason: 'no_recent_fix' })

// What the view hands the composable about motion, on the real read and the real gate.
async function realTruck({ reading, before = null }) {
  const pos = useDriverPosition()
  const realFetch = globalThis.fetch
  let readingNow = before || reading
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === RELEASE_URL) return jsonReply(NOTE_ANSWER())
    if (u === '/api/driver/position') return readingNow()
    throw new TypeError(`unexpected ${u}`)
  }
  await pos.refreshEld()
  readingNow = reading
  await pos.refreshEld()
  const gate = () => {
    const m = pos.eldMotion.value
    return recordGate({ fix: m ? m.fix : null, stoppedSince: m ? m.stoppedSince : null, nowMs: Date.now() })
  }
  const release = useDriverRelease({
    api: useApiModule.useApi(),
    role: () => 'Driver',
    onboarding: () => false,
    mounted: () => true,
    has: () => ({ performance: true }),
    motionAllowed: () => gate().allowed,
    noteInputs: () => ({ onboarding: false, settled: true, partsKnown: true, tab: 'loads', loadOpen: false, welcomeOpen: false, dialogOpen: false, motionAllowed: gate().allowed }),
    place: () => 'loads',
    showStep: () => {},
    restorePlace: () => {},
    toast: () => {},
  })
  await release.check()
  const result = { state: gate().state, note: release.noteView.value?.mode ?? null }
  globalThis.fetch = realFetch
  return { ...result, release, pos, turn: async (next) => {
    globalThis.fetch = async () => next()
    await pos.refreshEld()
    await tick()
    globalThis.fetch = realFetch
  } }
}
const PARKED = truck()
for (const [label, reading, state, note] of [
  ['parked', PARKED, 'parked', 'notes'],
  ['moving', truck({ speed: 25 }), 'moving', null],
  ['stopped under two minutes', truck({ stopped: 30 * 1000 }), 'stopping', null],
  ['on a feed that sends no speed, its fixes showing no stop', truck({ stopped: null }), 'stopping', null],
  ['not reporting, no reading from the server', noReading(), 'unknown', 'notes'],
  ['not reporting, a reading over three minutes old', truck({ age: 4 * 60 * 1000 }), 'unknown', 'notes'],
]) {
  const r = await realTruck({ reading })
  eq(`a truck ${label}: the note ${note ? 'shows' : 'is held'}`, [r.state, r.note], [state, note])
}
{
  const r = await realTruck({ reading: truck({ stopped: null }), before: PARKED })
  eq('a truck that read parked and then moves with no speed: the note is held, the earlier stop not carried', [r.state, r.note], ['stopping', null])
}
{
  const r = await realTruck({ reading: PARKED })
  r.release.noteShowMe()
  await tick()
  eq('(the scene) the tour is open with the truck parked', r.release.tourOpen.value, true)
  await r.turn(truck({ stopped: null }))
  eq('the truck rolls off on a feed with no speed: the tour closes by itself', r.release.tourOpen.value, false)
}

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} of ${pass + failures.length}`)
  process.exit(1)
}
console.log(`\nok: ${pass} checks`)
process.exit(0)
