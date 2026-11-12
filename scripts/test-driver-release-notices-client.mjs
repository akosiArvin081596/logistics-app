#!/usr/bin/env node
// New-feature notices for drivers, the app's side: the rules in client/src/lib/driverReleaseNotices.js,
// composables/useDriverRelease.js driven for real on Vue's own reactivity, how DriverView.vue and the two
// components use them, and the Drivers page's record (lib/driverNoticeRecord.js). The server's side is
// scripts/test-driver-release-notices.js; scripts/e2e/driver-release-notices.mjs covers the page.
//   §1  the words, exact, and plain: no figure, no name, no word a driver wouldn't use (the Past
//       Performance step alone states the rule's own figures, word for word); none that's false for a
//       driver who can read it, and none about being signed out; the Fuel range step without its last
//       sentence; "Show me", with no "first"
//   §2  noteMoment(): each input stops the note, and neither a working load nor the truck does
//   §3  releaseFromAnswer(): what an answer may and may not say; an unreadable body says nothing
//   §4  notesForScreen(), tourStepsFor(), tourCardView(): only what this driver's app has; the release
//       tour has no Skip and ends in I acknowledge, the app tour keeps Skip, Done and the videos
//   §5  no forced sign-out: an answer that says one is due, at an app opening, with a way to sign out
//       in reach, signs nobody out; this feature has no road to handleLogout; the code for it is gone
//   §6  only right after a sign-in: a load with no sign-in shows nothing, however much the server has;
//       the sign-in is spent by the one read, whatever comes of it; the read starts with the
//       Performance read and the look waits for both; the look ends however it goes, so the contacts
//       prompt can follow; only a Driver asks
//   §7  the note, the offer and the tour: only "I acknowledge" answers a note, on the note or at the
//       release tour's end; it waits for the save and can't be sent twice; not saved, the note closes
//       with a line; "Show me" opens the tour over the note, Next … I acknowledge, with no Skip; a moving
//       truck's open page never changes, and there the note's own I acknowledge still answers; the
//       tour starts only on their own tap
//   §8  DriverView.vue: one read, as the view opens, with the Performance read; the contacts prompt
//       waits for the look; the login form notes the sign-in, in memory; the tour marks nothing read
//   §9  the components: Show me the big blue button and I acknowledge the small one under it; only
//       "I acknowledge" closes the note, and the button shows it's working; the release tour's card has
//       no Skip; on a short phone the note's box scrolls to Show me's line; the app's other files know
//       nothing of this
//   §10 only the driver app and the Drivers page read any of it
//   §11 the Drivers page's record: the words, the three states, times on the app's clock; Super Admin
//       only, and nothing with the switch off
//   §12 the words on the record: each notice's lines, tagged when they need the Performance tab, its
//       tour's steps, and the whole app tour once, are the words drivers read, from where they read them
//       (the server's list, TOUR_STEPS), never a copy: for a driver with the tab and one without, on
//       made-up lines and on the real list
//
// No DOM, no server, no build.
//   node scripts/test-driver-release-notices-client.mjs      # exits 1 on any failure
import fs from 'fs'
import { createRequire, registerHooks } from 'module'
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
const exists = (rel) => fs.existsSync(path.join(CLIENT, rel))
const read = (rel) => (exists(rel) ? fs.readFileSync(path.join(CLIENT, rel), 'utf8') : '')

let pass = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) { pass++; return }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
const section = (title) => console.log(`§ ${title}`)

let lib, composable, vue
try {
  lib = await load('lib/driverReleaseNotices.js')
  composable = await load('composables/useDriverRelease.js')
  vue = await import(pathToFileURL(path.join(ROOT, 'client', 'node_modules', 'vue', 'index.mjs')).href)
} catch (e) {
  console.log(`  FAIL  the app's side must load: ${e.message}`)
  console.log('\nFAILED: 1 of 1')
  process.exit(1)
}
const optional = async (rel) => {
  try {
    return await load(rel)
  } catch (e) {
    ok(`${rel} must load: ${e.message}`, false)
    return null
  }
}
const signInMoment = await optional('lib/signInMoment.js')
const record = await optional('lib/driverNoticeRecord.js')
const datetime = await load('utils/datetime.js')
const { WORDS, TOUR_STEPS, APP_TOUR_STEP_IDS, APP_TOUR_ROW, RELEASE_URL, ACK_URL, SEEN_URL, TOUR_DONE_URL } = lib
const { useDriverRelease } = composable
const { reactive, nextTick } = vue

const tick = async () => { await new Promise((r) => setImmediate(r)); await nextTick() }
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

// ── §1 ────────────────────────────────────────────────────────────────────
section('1 the words')
eq('the routes', [RELEASE_URL, ACK_URL, SEEN_URL, TOUR_DONE_URL], ['/api/driver/me/release', '/api/driver/me/release/acknowledge', '/api/driver/me/release/seen', '/api/driver/me/release/tour-done'])
eq("the note's words", [WORDS.notesHeading, WORDS.acknowledge, WORDS.showMe], ["What's new", 'I acknowledge', 'Show me'])
eq('the line above the buttons, exact, with the owner\'s own "agree"', WORDS.acknowledgeLine, "Tap I acknowledge to confirm you've read and agree to what's new.")
eq("a confirmation that can't be saved, exact", WORDS.notSaved, "We couldn't save that. We'll ask again next time you sign in.")
ok('"Show me", with no "first", and no "Got it": the tour it starts ends in I acknowledge, the only answer', !('gotIt' in WORDS) && !('showMeFirst' in WORDS) && !Object.values(WORDS).some((w) => w === 'Got it' || w === 'Show me first'))
eq("the offer's buttons", [WORDS.takeTour, WORDS.skipOffer], ['Take the tour', 'Skip for now'])
eq("the Kit's button", WORDS.kitButton, 'Take the app tour')
eq("the tour's buttons", [WORDS.tourNext, WORDS.tourSkip, WORDS.tourDone], ['Next', 'Skip', 'Done'])
ok('the offer suggests the tour and says it can wait', /suggest/.test(WORDS.offerText) && /later/.test(WORDS.offerText))
eq('the steps, in order', APP_TOUR_STEP_IDS, ['loads', 'load-page', 'alerts', 'kit', 'messages', 'invoices', 'performance', 'fuel-range'])
eq('each step shows the real tab', TOUR_STEPS.map((s) => s.tab), ['loads', 'loads', 'notifications', 'kit', 'messages', 'invoices', 'performance', 'loads'])
const allWords = [...Object.values(WORDS), ...TOUR_STEPS.flatMap((s) => [s.title, s.text, s.withPerformance].filter(Boolean))]
// "Past" is the first word of the tab's own name, Past Performance.
const APP_WORDS = new Set(['Loads', 'Performance', 'Past', 'Alerts', 'Kit', 'Messages', 'Invoices', 'Active', 'Pending', 'Historical', 'POD', 'LogisX', 'What', 'Fuel', 'A', 'The', 'I'])
// The Past Performance step states the general rule in its own figures, word for word, as asked; a week
// with time off can show a lower one on the tab. It is pinned exactly below, so no other figure creeps in.
const PERFORMANCE_TEXT = "Here's your weekly performance. It shows your target turns and the minimum turns required. Each turn counts as .50, with the weekly requirement of 6 total turns, and a target of 7.5 weekly."
for (const line of allWords) {
  if (line !== PERFORMANCE_TEXT) ok(`no figure: "${line}"`, !/[\d$#%@]/.test(line) && !/\b(half|dollars?|percent)\b/i.test(line))
  ok(`no word they wouldn't use: "${line}"`, !/\b(session|deploy|release|server|api|bug|flag|sheet|database|endpoint|cache|token)\b/i.test(line))
  ok(`nothing about being signed out: "${line}"`, !/\b(sign(ed|s)?[ -]?out|log(ged|s)?[ -]?(in|out)|logout|login|sign in again)\b/i.test(line))
  for (const sentence of line.split(/(?<=[.!?:])\s+/)) {
    for (const word of sentence.split(/\s+/).slice(1)) {
      const bare = word.replace(/[^A-Za-z]/g, '')
      ok(`no name: "${bare}" in "${line}"`, !/^[A-Z]/.test(bare) || APP_WORDS.has(bare))
    }
  }
}
const fuelStep = TOUR_STEPS.find((s) => s.id === 'fuel-range').text
eq("the fuel step, exact: it says when, since no reading or no tank size on file shows no figure, and its last sentence is gone", fuelStep, "The top of the app shows your fuel range when it's known: how many miles you have left until empty.")
ok('...nothing about the tank, the load or the route', !/tank|not your load or route/i.test(fuelStep))
const perfStep = TOUR_STEPS.find((s) => s.id === 'performance')
eq('the Past Performance step: the tab by its name, and the rule in the words asked for, lightly punctuated', [perfStep.title, perfStep.text], ['Past Performance', PERFORMANCE_TEXT])
ok('..."No other driver can see it." is gone from every step', !TOUR_STEPS.some((s) => /no other driver/i.test(`${s.title} ${s.text} ${s.withPerformance || ''}`)))
ok("the Loads step sends a driver with the bar to the tab by its new name", /Tap it to open Past Performance\.$/.test(TOUR_STEPS.find((s) => s.id === 'loads').withPerformance))
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
{
  const buttons = (card) => card && { next: card.next, skip: card.skip, videos: card.videos }
  const whole = lib.tourStepsFor(APP_TOUR_STEP_IDS, { performance: true })
  const release = lib.tourStepsFor(['loads', 'performance', 'fuel-range'], { performance: true })
  eq('the app tour: Next and Skip on a step; Done, Skip and the training videos at its end',
    [buttons(lib.tourCardView(whole, 2)), buttons(lib.tourCardView(whole, 7))], [{ next: 'Next', skip: true, videos: false }, { next: 'Done', skip: true, videos: true }])
  eq("the release tour: Next and no Skip on each step; I acknowledge at its end, with no Skip and no videos",
    [0, 1, 2].map((i) => buttons(lib.tourCardView(release, i, true))), [{ next: 'Next', skip: false, videos: false }, { next: 'Next', skip: false, videos: false }, { next: 'I acknowledge', skip: false, videos: false }])
  eq('a one-step release tour ends at once in I acknowledge', buttons(lib.tourCardView(release.slice(0, 1), 0, true)), { next: 'I acknowledge', skip: false, videos: false })
  eq('only a true flag makes it the release tour', ['true', 1, {}, undefined].map((flag) => lib.tourCardView(release, 2, flag)?.next), ['Done', 'Done', 'Done', 'Done'])
}

// ── the world for §5 to §7 ─────────────────────────────────────────────────
// `signedIn`: the view opens right after a sign-in. The world's server answers what's unread every time,
// as the real one does, so anything that stays off screen here stays off by the app's own doing.
// `box.post` answers each mark; a toast with a type is kept as [text, type].
function world(start = {}) {
  const s = reactive({
    role: 'Driver', signedIn: true, onboarding: false, performance: true, partsKnown: true, motionAllowed: true, tab: 'loads', loadOpen: false,
    welcomeOpen: false, dialogOpen: false, ...start,
  })
  const calls = { gets: 0, posts: [], steps: [], restored: [], toasts: [] }
  const box = { answer: NOTHING, post: async () => ({ success: true }) }
  const options = {
    api: {
      get: async (url) => { calls.gets++; eq('it reads the release route', url, RELEASE_URL); return box.answer() },
      post: async (url, body) => { calls.posts.push([url, body]); return box.post(url, body) },
    },
    role: () => s.role,
    takeSignIn: () => { const taken = s.signedIn; s.signedIn = false; return taken },
    has: () => ({ performance: s.performance }),
    motionAllowed: () => s.motionAllowed,
    noteInputs: () => ({ onboarding: s.onboarding, partsKnown: s.partsKnown, tab: s.tab, loadOpen: s.loadOpen, welcomeOpen: s.welcomeOpen, dialogOpen: s.dialogOpen }),
    place: () => s.tab,
    showStep: (step) => { calls.steps.push(step.id); s.tab = step.tab },
    restorePlace: (tab) => { calls.restored.push(tab); s.tab = tab },
    toast: (text, type) => calls.toasts.push(type ? [text, type] : text),
  }
  return { s, calls, box, options, release: useDriverRelease(options) }
}
const acknowledge = async (release) => { await release.noteAcknowledge?.(); await tick() }

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
  await acknowledge(release)
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
  const leftovers = /signInDue|signOutMoment|SIGN_OUT_PARKED_MS|parkedLongEnough|loadsHoldSignOut|rememberSignOut|signedOutFor|leaveLoginNote|takeLoginNote|LOGIN_NOTE_KEY|updatedNote|login-updated-note|The app was updated|isFirstScreen|noteScreenShown|thisPageTabs|otherPageOpen|writesBusy|writeStarted|logisx\.driverRelease|logisx\.appPage|handleLoadBack|handleNavTap|releaseDialogOpen|loadPageOpen|noteGotIt|release-got-it/
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
{
  // The two reads start together: the release read doesn't wait for the Performance answer, and the
  // one look does, since the note's lines depend on it.
  const w = world({ partsKnown: false })
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: false })
  const parts = deferred()
  const done = w.release.check(parts.promise)
  await tick()
  eq('the release read starts at once, before the Performance answer lands', w.calls.gets, 1)
  eq('...and the look waits for that answer', [w.release.noteView.value, w.release.lookDone?.value], [null, false])
  w.s.partsKnown = true
  parts.resolve()
  await done
  eq('once it lands, the one look is made, and says yes', [w.release.noteView.value?.mode, w.release.lookDone?.value], ['notes', true])
}
{
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: false })
  const failed = Promise.reject(new Error('made-up failure'))
  failed.catch(() => {})
  await w.release.check(failed)
  eq('a Performance read that fails outright still lets the look happen', w.release.noteView.value?.mode, 'notes')
}
{
  const w = world()
  eq("before the look, it isn't over: the contacts prompt waits", w.release.lookDone?.value, false)
  w.box.answer = () => { throw Object.assign(new Error('x'), { status: 503 }) }
  await w.release.check()
  eq('a failed read still ends the look, so the contacts prompt can come', w.release.lookDone?.value, true)
}
for (const [label, start] of [['no sign-in', { signedIn: false }], ['another role', { role: 'Dispatcher' }], ['a no at the look', { tab: 'kit' }], ['the lock screen', { onboarding: true }]]) {
  const w = world(start)
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: false })
  await w.release.check()
  eq(`the look is over with ${label}`, w.release.lookDone?.value, true)
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
  eq('...and marks nothing, so it comes at a later sign-in', w.calls.posts, [])
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
  eq(`...marks nothing, so it comes at a later sign-in (${label})`, w.calls.posts, [])
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
  await acknowledge(w.release)
  eq('...and I acknowledge works there: one tap', [w.release.noteView.value, w.calls.posts], [null, [[ACK_URL, { ids: [ID] }]]])
}
{
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  const view = w.release.noteView.value
  eq('what it says', [view.mode, view.canShowMe, view.saving, view.whenParked, view.entries[0].title, view.entries[0].lines], ['notes', true, false, false, 'A title', ['A line.', 'A tab line.']])
  eq('it counts as on screen', w.release.onScreen?.value, true)
  await acknowledge(w.release)
  eq('I acknowledge: confirmed, for the entries shown', w.calls.posts, [[ACK_URL, { ids: [ID] }]])
  eq('...closed once saved', [w.release.noteView.value, w.release.onScreen?.value], [null, false])
  eq('...with nothing more to say', w.calls.toasts, [])
  await w.release.check()
  eq('...and not back in this view, whatever the next answer says', w.release.noteView.value, null)
  eq('I acknowledge starts no tour', w.calls.steps, [])
}
{
  // The confirmation waits for the save, and can't be sent twice.
  const w = world()
  w.box.answer = NOTE_ANSWER
  const save = deferred()
  w.box.post = () => save.promise
  await w.release.check()
  const pending = w.release.noteAcknowledge?.()
  await tick()
  eq('while it saves, the note stays up and shows it is working', [w.release.noteView.value?.mode, w.release.noteView.value?.saving], ['notes', true])
  w.release.noteAcknowledge?.()
  w.release.noteShowMe()
  await tick()
  eq('...a second tap sends nothing, and Show me starts nothing', [w.calls.posts.length, w.release.tourOpen.value], [1, false])
  save.resolve({ success: true })
  await pending
  await tick()
  eq('saved: the note closes', [w.release.noteView.value, w.calls.toasts], [null, []])
}
for (const [label, failure] of [
  ['no signal', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['a 503', () => Promise.reject(Object.assign(new Error('x'), { status: 503, code: 'RELEASE_UNAVAILABLE' }))],
  ['a timeout', () => Promise.reject(Object.assign(new Error('x'), { status: 0, code: 'TIMEOUT' }))],
  ["an answer that isn't a yes", async () => ({})],
]) {
  // A driver is never kept from their loads.
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  w.box.post = failure
  await w.release.check()
  await acknowledge(w.release)
  eq(`not saved (${label}): the note closes, so they go on to their loads`, [w.release.noteView.value, w.release.onScreen?.value], [null, false])
  eq(`...with the line (${label})`, w.calls.toasts, [[WORDS.notSaved, 'error']])
  eq(`...nothing else is marked, and the offer waits for a later sign-in too (${label})`, w.calls.posts.map(([url]) => url), [ACK_URL])
  await w.release.check()
  eq(`...and it isn't asked again on this page (${label})`, w.release.noteView.value, null)
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
  // "Show me": the release tour runs over the note, Next … I acknowledge, with no Skip.
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq('Show me marks nothing', w.calls.posts, [])
  eq("the release's steps only, on the real tab", [w.calls.steps, w.s.tab], [['loads'], 'loads'])
  const card = () => { const v = w.release.tourView.value; return v && [v.label, v.title, v.last, v.skip, v.next] }
  eq('the card: no Skip, and Next', card(), ['Step 1 of 3', 'Loads', false, false, 'Next'])
  eq('the note waits under the tour', [w.release.noteView.value, w.release.onScreen?.value], [null, true])
  w.release.tourNext()
  eq('Next: the Past Performance tab, still with no Skip', [w.calls.steps, w.s.tab, card()], [['loads', 'performance'], 'performance', ['Step 2 of 3', 'Past Performance', false, false, 'Next']])
  w.release.tourSkip()
  await tick()
  eq('a skip asked of it changes nothing: no Skip mid-tour, nothing written', [w.release.tourOpen.value, w.release.tourView.value?.label, w.calls.restored, w.calls.posts], [true, 'Step 2 of 3', [], []])
  w.release.tourNext()
  eq('Next: the fuel range, the last step, ending in I acknowledge, with no videos', [w.s.tab, card(), w.release.tourView.value?.videos], ['loads', ['Step 3 of 3', 'Fuel range', true, false, 'I acknowledge'], false])
  eq('nothing written along the way', w.calls.posts.length, 0)
  w.release.tourNext()
  await tick()
  await tick()
  eq("I acknowledge at its end: the confirmation, for the entries the note showed, then the tour's own mark", w.calls.posts, [[ACK_URL, { ids: [ID] }], [TOUR_DONE_URL, { ids: [ID] }]])
  eq('...the tour closed and back where they were', [w.release.tourView.value, w.release.tourOpen.value, w.calls.restored], [null, false, ['loads']])
  eq('...and the note answered, so it is gone too, with nothing more to say', [w.release.noteView.value, w.release.onScreen?.value, w.calls.toasts], [null, false, []])
  await w.release.check()
  eq('...and not back in this view', w.release.noteView.value, null)
}
{
  // The last step's I acknowledge waits for the save, shows it's working, and can't be sent twice.
  const w = world()
  w.box.answer = NOTE_ANSWER
  const save = deferred()
  w.box.post = (url) => (url === ACK_URL ? save.promise : Promise.resolve({ success: true }))
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.release.tourNext()
  w.release.tourNext()
  w.release.tourNext()
  await tick()
  eq('while it saves, the last step stays up and shows it is working', [w.release.tourOpen.value, w.release.tourView.value?.saving, w.release.tourView.value?.next, w.release.noteView.value], [true, true, 'I acknowledge', null])
  w.release.tourNext()
  w.release.noteAcknowledge()
  await tick()
  eq('...a second tap sends nothing', w.calls.posts.filter(([url]) => url === ACK_URL).length, 1)
  save.resolve({ success: true })
  await tick()
  await tick()
  eq('saved: the tour and the note close', [w.release.tourOpen.value, w.release.noteView.value, w.calls.toasts], [false, null, []])
}
for (const [label, failure] of [
  ['no signal', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['a 503', () => Promise.reject(Object.assign(new Error('x'), { status: 503, code: 'RELEASE_UNAVAILABLE' }))],
  ["an answer that isn't a yes", async () => ({})],
]) {
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  w.box.post = (url) => (url === ACK_URL ? failure() : Promise.resolve({ success: true }))
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq(`(the scene, ${label}) a one-step release tour ends at once in I acknowledge`, w.release.tourView.value?.next, 'I acknowledge')
  w.release.tourNext()
  await tick()
  await tick()
  eq(`not saved at the tour's end (${label}): the tour and the note close, so they go on to their loads`, [w.release.tourOpen.value, w.release.noteView.value, w.release.onScreen?.value], [false, null, false])
  eq(`...with the same line (${label})`, w.calls.toasts, [[WORDS.notSaved, 'error']])
  eq(`...the confirmation tried once (${label})`, w.calls.posts.filter(([url]) => url === ACK_URL).length, 1)
}
{
  // The note stays behind the tour: a way out that isn't its end (a new load's banner) leaves it unanswered.
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.release.tourNext()
  w.release.closeTour()
  await tick()
  eq('left mid-tour by the banner: nothing written', w.calls.posts, [])
  eq('...back where they were, and the note is there again, unanswered', [w.release.tourOpen.value, w.calls.restored, w.release.noteView.value?.mode], [false, ['loads'], 'notes'])
}
{
  // A moving truck's open page never changes: not the tour either, and not the note under it.
  const w = world()
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  w.s.motionAllowed = false
  await tick()
  eq('the truck starts moving: the tour stays up until they end it', [w.release.tourOpen.value, w.calls.restored], [true, []])
  eq('...and writes nothing', w.calls.posts, [])
  w.release.tourNext()
  eq('...and Next still works', w.release.tourView.value?.label, 'Step 2 of 3')
  w.release.tourSkip()
  eq('...and there is no Skip: the tour stays', [w.release.tourOpen.value, w.release.tourView.value?.label], [true, 'Step 2 of 3'])
  w.release.tourNext()
  w.release.tourNext()
  await tick()
  await tick()
  eq('...and its end still answers the note', [w.release.tourOpen.value, w.release.noteView.value, w.calls.posts.map(([url]) => url)], [false, null, [ACK_URL, TOUR_DONE_URL]])
}
{
  // The app's own short message sits under the note's overlay, so the note says it itself.
  const w = world({ motionAllowed: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  eq('before the tap, the note says nothing about the truck', w.release.noteView.value?.whenParked, false)
  w.release.noteShowMe()
  await tick()
  eq('Show me on a truck read as moving: the note itself says when, nothing goes to the message under it, no tour starts, and the note stays',
    [w.release.noteView.value?.whenParked, w.calls.toasts, w.release.tourOpen.value, w.release.noteView.value?.mode, w.calls.posts], [true, [], false, 'notes', []])
  w.s.motionAllowed = true
  await tick()
  eq('...the line stays as it was when the truck parks: an open page changes only on a tap', w.release.noteView.value?.whenParked, true)
  w.release.noteShowMe()
  await tick()
  eq('...tapped again once parked, the tour starts', [w.release.tourOpen.value, w.calls.steps], [true, ['loads']])
  w.release.closeTour()
  await tick()
  eq('...and the note after it says nothing about the truck', [w.release.noteView.value?.mode, w.release.noteView.value?.whenParked], ['notes', false])
}
{
  // On a truck read as moving the note's own, smaller I acknowledge is the one way to answer, and it saves.
  const w = world({ motionAllowed: false })
  w.box.answer = NOTE_ANSWER
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq('(the scene) Show me on a moving truck starts nothing', [w.release.tourOpen.value, w.release.noteView.value?.whenParked], [false, true])
  await acknowledge(w.release)
  eq('...and I acknowledge on the note saves and closes it', [w.calls.posts, w.release.noteView.value], [[[ACK_URL, { ids: [ID] }]], null])
}
{
  // Only the entries on screen are confirmed: one the driver can't read waits for the app that shows it.
  const w = world({ performance: false })
  const TAB_ONLY = { id: '2026-02-01-tab-only', title: 'Tab only', notes: [{ text: 'Only with the tab.', needs: 'performance' }], tour: ['performance'] }
  w.box.answer = () => ({ notes: [ENTRY, TAB_ONLY], tourOffered: false })
  await w.release.check()
  eq('(the scene) one entry on screen', w.release.noteView.value?.entries.map((e) => e.id), [ID])
  await acknowledge(w.release)
  eq('I acknowledge confirms the entries shown and no others', w.calls.posts, [[ACK_URL, { ids: [ID] }]])
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
  eq('Take the tour: answered, and the whole tour', [w.calls.posts, w.release.tourView.value?.label], [[[SEEN_URL, { ids: [APP_TOUR_ROW] }]], 'Step 1 of 8'])
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
  eq('the Kit runs the whole tour any time, writing nothing to start', [w.release.tourView.value?.label, w.calls.posts], ['Step 1 of 8', []])
  w.release.tourSkip()
  eq('...and goes back to the Kit', w.s.tab, 'kit')
  w.s.motionAllowed = false
  await tick()
  w.release.startAppTour()
  eq('with the truck read as moving it says when, and starts nothing', [w.calls.toasts, w.release.tourOpen.value], [[WORDS.whenParked], false])
}
{
  const w = world()
  w.box.answer = () => ({ notes: [], tourOffered: true })
  await w.release.check()
  w.s.motionAllowed = false
  await tick()
  w.release.offerTake()
  await tick()
  eq('Take the tour on a truck read as moving: answered, it says when, and the Kit still has it', [w.calls.posts, w.calls.toasts, w.release.tourOpen.value, w.release.noteView.value], [[[SEEN_URL, { ids: [APP_TOUR_ROW] }]], [WORDS.whenParked], false, null])
}
{
  // The tour's row and the notes in one answer: the notes first, then the offer.
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  eq('notes first', w.release.noteView.value.mode, 'notes')
  await acknowledge(w.release)
  eq('then, once confirmed, the offer', w.release.noteView.value?.mode, 'offer')
  eq('...with nothing left waiting on the save', w.release.noteView.value?.saving, false)
}
{
  const w = world()
  w.box.answer = () => ({ notes: [ENTRY], tourOffered: true })
  await w.release.check()
  w.release.noteShowMe()
  await tick()
  eq('Show me with the offer due as well: neither opens over the tour', w.release.noteView.value, null)
  w.release.tourNext()
  await tick()
  await tick()
  eq("...I acknowledge at the tour's end answers the note, and then the offer comes", w.release.noteView.value?.mode, 'offer')
  eq("...after only the confirmation and the tour's own mark", w.calls.posts, [[ACK_URL, { ids: [ID] }], [TOUR_DONE_URL, { ids: [ID] }]])
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
eq('it reads at one place in the whole file and no other: nothing on an open page asks, no socket, timer, tap or coming back', [...VIEW.matchAll(/release\.check\(/g)].length, 1)
ok('as the view opens, alongside the Performance read, whose answer the look waits for', /release\.check\(checkPerformanceTab\(\)\)\n\s+\} catch/.test(fn('async function attemptInitialLoad()')))
ok('coming back to the app reads the loads, as it did, and asks nothing of this', /visibilityState === 'visible' && isMounted\) \{\n\s+scheduleDriverRefetch\(\)\n\s+\}/.test(fn('function onVisibilityChange()')))
ok("a load's page goes back as it did", /@back="detailRowIndex = null"/.test(VIEW))
ok('the tab bar switches as it did', /@switch="handleTabSwitch"/.test(VIEW))
ok('the note answers through I acknowledge alone', /@acknowledge="release\.noteAcknowledge"/.test(VIEW) && /@show-me="release\.noteShowMe"/.test(VIEW) && !/@got-it/.test(VIEW))
ok('the not-saved line goes out as an error', /toast: \(text, type\) => toast\.show\(text, type\)/.test(script))

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
eq('a failed probe still settles, so the look goes ahead and the Kit learns it is on', await probeScene(refusal(503)).then(() => 'settled'), 'settled')
ok('it starts unknown', /const performanceKnown = ref\(false\)/.test(script))
const inputs = script.slice(script.indexOf('noteInputs: () => ({'), script.indexOf('place: () => currentTab.value'))
ok('the note reads the Performance answer', /partsKnown: performanceKnown\.value/.test(inputs))
ok("...the tab and a load's page", /tab: currentTab\.value/.test(inputs) && /loadOpen: detailLoad\.value != null/.test(inputs))
ok('...the lock screen', /onboarding: isOnboarding\.value/.test(inputs))
ok('...the welcome window', /welcomeOpen: showWelcomeModal\.value/.test(inputs))
ok('...and the windows it could land on', /dialogOpen: showSignModal\.value \|\| showDeclineConfirm\.value \|\| showContactsForm\.value,\n/.test(inputs))
ok('...not the contacts prompt, which waits for the look instead', !/showContactsPrompt/.test(inputs))
ok('...and not the truck: the gate goes to the tour alone', !/voiceGate|motion|contactsPromptReady/i.test(inputs) && /motionAllowed: \(\) => voiceGate\.value\.allowed/.test(script))
ok("the contacts prompt waits for the note's one look", /loaded: contactsPromptReady\.value && release\.lookDone\.value,/.test(script))
ok('...and for the note and the tour to be off the screen', /dialogOpen: showSignModal\.value \|\| showDeclineConfirm\.value \|\| showContactsForm\.value \|\| release\.onScreen\.value/.test(script))
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
ok('the note is the same kind of window as the contacts prompt', /<van-popup/.test(NOTE))
ok('nothing but I acknowledge closes it: not a tap outside it, not the popup\'s own back-step close, and it has no close mark', /:close-on-click-overlay="false"/.test(NOTE) && /:close-on-popstate="false"/.test(NOTE) && !/closeable|close-icon/.test(NOTE))
for (const id of ['release-acknowledge', 'release-acknowledge-line', 'release-show-me', 'release-take-tour', 'release-skip-offer']) ok(`the note has ${id}`, NOTE.includes(`data-testid="${id}"`))
ok('no Got it button any more', !/release-got-it|got-it/.test(NOTE))
const notesPart = NOTE.slice(NOTE.indexOf("v-if=\"view.mode === 'notes'\""), NOTE.indexOf('<template v-else>'))
const at = (needle) => notesPart.indexOf(needle)
const showMeTag = (notesPart.match(/<van-button[^>]*data-testid="release-show-me"[^>]*>/) || [''])[0]
const ackTags = notesPart.match(/<van-button[^>]*data-testid="release-acknowledge"[^>]*>/g) || []
const stepsPart = notesPart.slice(notesPart.indexOf('<template v-if="view.canShowMe">'), notesPart.indexOf('</template>', notesPart.indexOf('<template v-if="view.canShowMe">')))
ok('the line sits above both buttons: Show me first, I acknowledge right under it', at('release-acknowledge-line') > 0 && at('release-acknowledge-line') < at('data-testid="release-show-me"') && stepsPart.indexOf('data-testid="release-show-me"') >= 0 && stepsPart.indexOf('data-testid="release-show-me"') < stepsPart.indexOf('data-testid="release-acknowledge"'))
ok('Show me is the big blue button: Vant\'s primary, full width', /\bround block type="primary" native-type="button" class="drn-primary drn-big" data-testid="release-show-me"/.test(showMeTag))
ok('I acknowledge under it is the small one: the plain word, no primary', ackTags.length === 2 && stepsPart.includes(ackTags[0]) && /class="drn-second drn-quiet"/.test(ackTags[0]) && !/type="primary"|drn-primary|drn-big/.test(ackTags[0]))
{
  // The size order, from the note's own rules rather than Vant's defaults, so it holds at every size.
  const ruleOf = (selector) => ((NOTE.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)) || [])[1] || '')
  const remOf = (rule, prop) => {
    const m = new RegExp(`(?:^|[\\s;])${prop}: ([\\d.]+)(rem|px);`).exec(rule)
    return m ? (m[2] === 'px' ? Number(m[1]) / 16 : Number(m[1])) : NaN
  }
  const weightOf = (rule) => Number((/font-weight: (\d+);/.exec(rule) || [])[1])
  const big = ruleOf('.drn-big')
  const quiet = ruleOf('.drn-second.drn-quiet')
  const second = ruleOf('.drn-second')
  eq("Show me's words are clearly bigger than I acknowledge's, and bolder", [remOf(big, 'font-size') - remOf(quiet, 'font-size') >= 0.125, weightOf(big) > weightOf(quiet)], [true, true])
  eq('...Show me stands taller, and both are 44 px or more to tap', [remOf(big, 'min-height') > remOf(second, 'min-height'), remOf(big, 'min-height') * 16 >= 44, remOf(second, 'min-height') * 16 >= 44], [true, true, true])
  ok("...and the quiet one's words are its own, set after the plain word's", NOTE.indexOf('.drn-second.drn-quiet {') > NOTE.indexOf('.drn-second {') && !Number.isNaN(remOf(quiet, 'font-size')))
}
ok('Show me only with steps to show; with none, I acknowledge alone is there, as the big button', /<template v-if="view\.canShowMe">/.test(notesPart) && /^<van-button\s+v-else round block type="primary" native-type="button" class="drn-primary" data-testid="release-acknowledge"/.test(ackTags[1] || ''))
ok('while it saves, I acknowledge shows it is working and Show me waits', ackTags.length === 2 && ackTags.every((t) => /:loading-text="WORDS\.acknowledge" :loading="view\.saving" :disabled="view\.saving" @click="emit\('acknowledge'\)"/.test(t)) && /:disabled="view\.saving" @click="showMe"/.test(showMeTag))
ok('on a truck read as moving, the note says when in its own line, by the buttons, after them', /<p v-if="view\.whenParked" ref="parkedLine" class="drn-text drn-when-parked" role="status" data-testid="release-when-parked">\{\{ WORDS\.whenParked \}\}<\/p>/.test(notesPart) && at('release-when-parked') > notesPart.lastIndexOf('data-testid="release-acknowledge"'))
// On a short phone the note fills its box, so the line would land below the box's fold: the box scrolls to
// it. The browser flow's V2 checks it's in sight at 390x844, 375x667 and 320x568.
ok("...and it's the note's last, so the box's end is the line", /^\s*<\/template>\s*$/.test(notesPart.slice(notesPart.indexOf('</p>', at('release-when-parked')) + '</p>'.length)))
ok('the box that scrolls is the note itself', /<div v-if="view" ref="scroller" class="drn" role="dialog"/.test(NOTE) && /\.drn \{[^}]*max-height: 80vh; overflow-y: auto;/.test(NOTE))
ok('Show me tells the view, waits for the line to be drawn, then scrolls the box to its end, only with the line up', /async function showMe\(\) \{\s*emit\('show-me'\)\s*await nextTick\(\)\s*if \(scroller\.value && parkedLine\.value\) scroller\.value\.scrollTop = scroller\.value\.scrollHeight\s*\}/.test(NOTE) && /const scroller = ref\(null\)\s*const parkedLine = ref\(null\)/.test(NOTE))
ok('...on every tap of it, not only the first', (notesPart.match(/@click="showMe"/g) || []).length === 1 && !/watch\(/.test(NOTE))
ok('only the note\'s own box moves: nothing scrolls the page', !/scrollIntoView|scrollTo\(|window\.scroll|document\.(documentElement|body)\.scroll/.test(NOTE))
eq('the note says which answer was tapped, and those only', (NOTE.match(/defineEmits\(\[([^\]]*)\]\)/) || [])[1], "'acknowledge', 'show-me', 'take-tour', 'skip-offer'")
for (const id of ['tour-card', 'tour-label', 'tour-next', 'tour-skip', 'tour-shield']) ok(`the tour has ${id}`, TOUR.includes(`data-testid="${id}"`))
ok('Skip only on a tour that has one: the release tour has none', /<button v-if="view\.skip" type="button" class="tour-skip" data-testid="tour-skip" @click="emit\('skip'\)">/.test(TOUR) && (TOUR.match(/emit\('skip'\)/g) || []).length === 2)
ok('...and Escape skips only there', /@keydown\.esc="view\.skip && emit\('skip'\)"/.test(TOUR))
ok("the main button says the lib's word: Next, Done, or I acknowledge at the release tour's end, and waits while it saves", /data-testid="tour-next" :disabled="view\.saving"[^>]*@click="emit\('next'\)">\{\{ view\.next \}\}<\/button>/.test(TOUR) && !/WORDS\.tourDone|WORDS\.tourNext/.test(TOUR))
ok('the training videos only where the lib offers them, at the app tour\'s end', /<button v-if="view\.videos && videos" type="button" class="tour-videos"/.test(TOUR))
ok("every button is a 44 px tap", /\.tour-skip, \.tour-next, \.tour-videos \{ min-height: 44px/.test(TOUR) && /\.drn-primary \{ min-height: 44px/.test(NOTE) && /\.drn-second \{[\s\S]{0,80}min-height: 44px/.test(NOTE))
ok('the clear layer stops a tap reaching the screen under it', /\.tour-shield \{ position: fixed; inset: 0;/.test(TOUR))
ok('...under the new load banner, which stays tappable', /z-index: 150/.test(TOUR) && /z-index: 160/.test(TOUR))
for (const [label, rel] of [['the login page', 'views/LoginView.vue'], ['the session store', 'stores/auth.js'], ['the router', 'router/index.js'], ['the app\'s start', 'main.js'], ['useApi', 'composables/useApi.js']]) {
  ok(`${label} knows nothing of this feature`, !/driverRelease|DriverRelease|appTabs|appOpening|writesInFlight|driverNoticeRecord/.test(read(rel)))
}

// ── §10 ───────────────────────────────────────────────────────────────────
section('10 only the driver app and the Drivers page read any of it')
const filesNaming = (re) => walk(CLIENT).filter((f) => /\.(vue|js)$/.test(f) && re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(CLIENT, f).replaceAll(path.sep, '/')).sort()
eq("the note: these files and no others, the Drivers page's record taking the tour's words from it", filesNaming(/driverReleaseNotices|useDriverRelease|driver\/me\/release/), ['components/driver/DriverAppTour.vue', 'components/driver/DriverReleaseNote.vue', 'composables/useDriverRelease.js', 'lib/driverNoticeRecord.js', 'lib/driverReleaseNotices.js', 'views/DriverView.vue'])
eq('the one-shot: the login form notes it and the driver app takes it, and nothing else knows it', filesNaming(/signInMoment/), ['views/DriverView.vue', 'views/LoginView.vue'])
eq('the record: the Drivers page alone', filesNaming(/driverNoticeRecord|DriverNoticesSection|driver-release\/acknowledgements/), ['components/drivers-db/DriverNoticesSection.vue', 'lib/driverNoticeRecord.js', 'views/DriversDbView.vue'])

// ── §11 ───────────────────────────────────────────────────────────────────
section("11 the Drivers page's record")
if (record) {
  const { RECORD_URL, RECORD_WORDS, recordView, countLine } = record
  eq('the route', RECORD_URL, '/api/admin/driver-release/acknowledgements')
  eq('the words', [RECORD_WORDS.heading, RECORD_WORDS.acknowledged, RECORD_WORDS.notYet, RECORD_WORDS.startedAfter], ['Driver notices', 'Acknowledged', 'Not yet', 'Started after this notice'])
  eq('...and the count', countLine(8, 10), '8 of 10 acknowledged')
  eq('...a driver with no name on file, and a record that can\'t be read', [RECORD_WORDS.noName, RECORD_WORDS.unreadable], ['No name on file', "Driver notices couldn't be loaded. Try again later."])
  eq('...the words over a notice\'s lines and tour, the whole tour\'s, and the tag, exact', [RECORD_WORDS.lines, RECORD_WORDS.tour, RECORD_WORDS.appTour, RECORD_WORDS.appTourWhen, RECORD_WORDS.performanceOnly], ['What drivers read', 'The tour from Show me', 'The app tour', 'Offered to a first-time driver; any driver can take it from the Kit.', 'Performance drivers only'])
  const ANSWER = {
    notices: [{
      id: '2026-02-01-second', title: 'Second', date: '2026-02-01', acknowledged: 1, asked: 3,
      drivers: [
        { name: '', state: 'not-yet', at: null },
        { name: 'Casey Example', state: 'acknowledged', at: '2026-11-12T20:04:00.000Z' },
        { name: 'Jordan Newhire', state: 'started-after', at: null },
        { name: 'Riley Sample', state: 'not-yet', at: null },
        { name: 'Made Up', state: 'something-else', at: null },
      ],
    }, { id: 'broken', title: 'No drivers' }],
  }
  datetime.setAppTimeZone('America/New_York')
  const view = recordView(ANSWER)
  eq('one block per notice the answer holds whole: its title, date and count', view?.map((n) => [n.id, n.title, n.date, n.count]), [['2026-02-01-second', 'Second', 'Feb 1, 2026', '1 of 3 acknowledged']])
  eq('one row per driver: the three states, a time on the app\'s clock, and a name or that there is none', view?.[0].rows.map((r) => [r.name, r.state, r.text]), [
    ['No name on file', 'not-yet', 'Not yet'],
    ['Casey Example', 'acknowledged', 'Acknowledged Nov 12, 2026, 3:04 PM EST'],
    ['Jordan Newhire', 'started-after', 'Started after this notice'],
    ['Riley Sample', 'not-yet', 'Not yet'],
  ])
  datetime.setAppTimeZone('America/Chicago')
  eq('the time follows the app\'s clock, not the viewer\'s', recordView(ANSWER)?.[0].rows[1].text, 'Acknowledged Nov 12, 2026, 2:04 PM CST')
  datetime.setAppTimeZone('America/New_York')
  for (const [label, raw] of [['nothing', null], ['no list', {}], ['a list on its own', []], ['notices that are no list', { notices: 'x' }]]) eq(`an answer it can't read (${label}) says so`, recordView(raw), null)
  eq('an empty list is a record with no notices', recordView({ notices: [] }), [])
} else {
  ok('the record lib is there to test', false)
}
const SECTION = read('components/drivers-db/DriverNoticesSection.vue')
const PAGE = read('views/DriversDbView.vue')
ok('the Drivers page shows the section to a Super Admin only', /<DriverNoticesSection v-if="auth\.isSuperAdmin" \/>/.test(PAGE) && /import DriverNoticesSection from '\.\.\/components\/drivers-db\/DriverNoticesSection\.vue'/.test(PAGE))
ok('...whose route is Super Admin only too', /path: '\/drivers',\s*name: 'drivers-db',\s*component: \(\) => import\('\.\.\/views\/DriversDbView\.vue'\),\s*meta: \{ roles: \['Super Admin'\] \}/.test(read('router/index.js')))
ok('the section reads the record route and nothing else', /api\.get\(RECORD_URL\)/.test(SECTION) && [...SECTION.matchAll(/api\.(get|post|put|delete)\(/g)].length === 1)
ok('...shows nothing while it loads, and nothing with the switch off or for another role', /v-if="state === 'shown' \|\| state === 'unreadable'"/.test(SECTION) && /err\.status === 404 \|\| err\.status === 403\) \? 'off' : 'unreadable'/.test(SECTION))
ok('...says so when it can\'t be read', /RECORD_WORDS\.unreadable/.test(SECTION) && /if \(!view\) \{\s*state\.value = 'unreadable'/.test(SECTION))
ok('...prints no raw HTML and keeps nothing in the browser', !/v-html|localStorage|sessionStorage/.test(SECTION))
ok('...shows each notice\'s title, date, count and rows', ['driver-notice-title', 'driver-notice-count', 'driver-notice-row'].every((id) => SECTION.includes(`data-testid="${id}"`)))
ok("...each notice's lines, a tag on those some drivers don't read, and its tour's steps, title and words", ['driver-notice-lines', 'driver-notice-line', 'driver-notice-only', 'driver-notice-tour', 'driver-tour-step', 'driver-tour-step-title', 'driver-tour-step-line'].every((id) => SECTION.includes(`data-testid="${id}"`)))
ok('...the tag only where a line has one, in each of its three lists, and never on its own', (SECTION.match(/<span v-if="line\.only" class="dn-only" data-testid="driver-notice-only">\{\{ line\.only \}\}<\/span>/g) || []).length === 3 && (SECTION.match(/class="dn-only"/g) || []).length === 3)
ok('...the words printed as text', (SECTION.match(/<span class="dn-text">\{\{ line\.text \}\}<\/span>/g) || []).length === 3 && (SECTION.match(/\{\{ step\.title \}\}/g) || []).length === 2)
ok('...and the whole app tour once, after the notices, only with the record shown, from the lib with no read of its own',
  (SECTION.match(/data-testid="driver-app-tour"/g) || []).length === 1
  && /<Card v-if="state === 'shown' && appTour\.length" class="dn-notice" data-testid="driver-app-tour">/.test(SECTION)
  && SECTION.indexOf('data-testid="driver-app-tour"') > SECTION.indexOf('data-testid="driver-notice-row"')
  && /const appTour = appTourView\(\)/.test(SECTION))

// ── §12 ───────────────────────────────────────────────────────────────────
section('12 the words on the record: the ones drivers read, from where they read them')
{
  const releases = createRequire(import.meta.url)('../lib/driver-releases.js')
  const recordOf = (raw) => (record ? record.recordView(raw) : null) || []
  const appTour = record && typeof record.appTourView === 'function' ? record.appTourView() : []
  ok('the record lib lists the whole app tour', record && typeof record.appTourView === 'function')
  const stepOf = (id) => TOUR_STEPS.find((s) => s.id === id)
  const TAB = 'Performance drivers only'
  const BASE = { id: '2026-02-01-second', title: 'Second', date: '2026-02-01', acknowledged: 0, asked: 0, drivers: [] }
  // Made-up lines: one for everyone, one for the tab, one for a part no driver's app has, a blank one,
  // one whose needs is no word, and three that are no line at all.
  const MADE_NOTES = [
    { text: 'A made-up line for everyone.' },
    { text: 'A made-up line for the tab.', needs: 'performance' },
    { text: 'A made-up line for a part nobody has.', needs: 'something-new' },
    { text: '   ' },
    { text: 'A made-up line whose needs is no word.', needs: 7 },
    'a bare string', null, ['an', 'array'],
  ]
  const MADE_TOUR = ['fuel-range', 'loads', 'made-up', 'performance', 'loads']
  const [made = {}] = recordOf({ notices: [{ ...BASE, notes: MADE_NOTES, tour: MADE_TOUR }] })
  eq("a notice's lines as the driver's app reads them: for every driver untagged, for the tab tagged, a part nobody has and what's no line left out", made.lines, [
    { text: 'A made-up line for everyone.', only: '' },
    { text: 'A made-up line for the tab.', only: TAB },
    { text: 'A made-up line whose needs is no word.', only: '' },
  ])
  const [driverEntry] = lib.releaseFromAnswer({ notes: [{ ...BASE, notes: MADE_NOTES, tour: MADE_TOUR }], tourOffered: false })?.notes || []
  eq('...every one of them a line a driver with the tab reads, in order', (made.lines || []).map((l) => l.text), lib.notesForScreen([driverEntry], { performance: true })[0]?.lines)
  eq('...and the untagged ones, the lines a driver without it reads', (made.lines || []).filter((l) => !l.only).map((l) => l.text), lib.notesForScreen([driverEntry], { performance: false })[0]?.lines)
  eq("its tour: the steps by its ids, in order, each once, an unknown one left out, as the driver's tour walks them", (made.steps || []).map((s) => s.id), lib.tourStepsFor(MADE_TOUR, { performance: true }).map((s) => s.id))
  eq('each step: its title and its own text, the sentence a driver with the tab reads after it tagged, and a step that needs the tab tagged', (made.steps || []).map((s) => [s.title, s.lines]), [
    [stepOf('fuel-range').title, [{ text: stepOf('fuel-range').text, only: '' }]],
    [stepOf('loads').title, [{ text: stepOf('loads').text, only: '' }, { text: stepOf('loads').withPerformance, only: TAB }]],
    [stepOf('performance').title, [{ text: stepOf('performance').text, only: TAB }]],
  ])
  const [bare = {}] = recordOf({ notices: [{ ...BASE }] })
  eq('a notice with no words on it (an older server) shows its record alone', [bare.lines, bare.steps, bare.count], [[], [], '0 of 0 acknowledged'])
  const [odd = {}] = recordOf({ notices: [{ ...BASE, notes: 'x', tour: 'loads' }] })
  eq('...and words that are no list show none', [odd.lines, odd.steps], [[], []])
  for (const need of releases.NEEDS) {
    const [one = {}] = recordOf({ notices: [{ ...BASE, notes: [{ text: 'A made-up line.', needs: need }] }] })
    ok(`a line that needs "${need}" is tagged, not left out: the record knows every part the list may name`, one.lines?.length === 1 && one.lines[0].only !== '')
  }
  ok('...and every step that needs a part is listed, tagged', TOUR_STEPS.filter((s) => s.needs).every((s) => !!appTour.find((x) => x.id === s.id)?.lines[0].only))

  // The real list, as the route sends it and a driver's note gets it, both over the wire.
  const wire = (x) => JSON.parse(JSON.stringify(x))
  const view = recordOf(wire({ notices: releases.acknowledgementRecord(releases.RELEASES, [], []) }))
  const entries = lib.releaseFromAnswer(wire({ notes: releases.unseenReleases([], releases.RELEASES), tourOffered: false }))?.notes || []
  eq("on the real list: one block per notice, newest first, as a driver's note lists them", view.map((n) => n.id), entries.map((e) => e.id))
  ok('...each with its lines and its tour', view.length === releases.RELEASES.length && view.every((n) => n.lines?.length > 0 && n.steps?.length > 0))
  for (const [who, has] of [['a driver with the tab', { performance: true }], ['a driver without it', { performance: false }]]) {
    const reads = (line) => !line.only || has.performance === true
    const asWalked = (steps) => (steps || []).filter((s) => reads(s.lines[0])).map((s) => [s.title, s.lines.filter(reads).map((l) => l.text).join(' ')])
    for (const n of view) {
      const entry = entries.find((e) => e.id === n.id)
      eq(`${n.id}: the lines ${who} reads are the record's${has.performance ? '' : ' untagged'} lines, word for word`, (n.lines || []).filter(reads).map((l) => l.text), lib.notesForScreen([entry], has)[0]?.lines ?? [])
      eq(`${n.id}: the steps ${who} walks from Show me are the record's, title and words`, asWalked(n.steps), lib.tourStepsFor(entry.tour, has).map((s) => [s.title, s.text]))
    }
    eq(`the app tour ${who} walks is the one listed once under the notices, title and words`, asWalked(appTour), lib.tourStepsFor(APP_TOUR_STEP_IDS, has).map((s) => [s.title, s.text]))
  }
  eq("the app tour: every step, in the tour's own order", appTour.map((s) => s.id), APP_TOUR_STEP_IDS)

  // One home for the words: neither the record's lib nor the section holds a driver's sentence.
  const theirWords = [...TOUR_STEPS.flatMap((s) => [s.text, s.withPerformance].filter(Boolean)), ...releases.RELEASES.flatMap((r) => r.notes.map((n) => (typeof n === 'string' ? n : n.text)))]
  for (const rel of ['lib/driverNoticeRecord.js', 'components/drivers-db/DriverNoticesSection.vue']) {
    ok(`${rel} holds none of the words drivers read: they come from their one home, never a copy`, theirWords.length > 0 && theirWords.every((w) => !read(rel).includes(w)))
  }
  const RECORD_LIB = read('lib/driverNoticeRecord.js')
  ok("the record lib takes the steps from the tour's own lib, and walks them by the driver's own rule", /import \{ APP_TOUR_STEP_IDS, TOUR_STEPS, WORDS, tourStepsFor \} from '\.\/driverReleaseNotices\.js'/.test(RECORD_LIB) && /tourStepsFor\(ids, EVERY_PART\)/.test(RECORD_LIB))
  eq("...and the tour's heading names the note's own button, from the note's words", record?.RECORD_WORDS.tour, `The tour from ${WORDS.showMe}`)
}

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} of ${pass + failures.length}`)
  process.exit(1)
}
console.log(`\nok: ${pass} checks`)
process.exit(0)
