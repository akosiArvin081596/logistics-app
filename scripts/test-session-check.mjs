#!/usr/bin/env node
// Deterministic check on client/src/lib/sessionCheck.js (the rules that decide
// whether a failed session check signs a user out), on the store that applies them
// (client/src/stores/auth.js, driven for real in section 4), and a tripwire on the
// files that wire them in (the store, client/src/router/index.js, ChangePasswordView).
//
// WHY THIS EXISTS. The session check ended in a bare `catch { user = null;
// isAuthenticated = false }`, so a dropped packet, a timeout or a 502 during a
// deploy restart all read as "signed out" and the router guard sent the driver to
// /login mid-task. Production: one driver signed in 17 times in 5 days, once 13 s
// after a successful save, mostly with no 401 and no logout.
//
// Only two answers may end a session: a 401, or a 2xx saying `authenticated:
// false`. Everything else is "no answer": retry briefly, then keep a known user in
// the app (reconnecting), or show the login page if nobody is known.
//
// A suite that only proved "a real 401 signs out" would pass on the old code, so
// every rule is paired with the shape that must NOT trigger it, and the whole set
// is then run against MUTANTS, each one a plausible regression. A mutant the suite
// fails to reject is itself a failure: it means the tables lost their teeth.
//
//   M1  the pre-fix store, modelled exactly (any error → signed out, one attempt,
//       a failed logout counts as done)
//   M2  an unreadable 2xx body (useApi's `{}`) read as "signed out"
//   M3  any 4xx treated as definitive (403/404 sign you out)
//   M4  never sign out, even on a real 401
//   M5  "stay in the app" with nobody known — a fabricated session
//   M6  a known-user hint trusted past its 24 h TTL
//   M7  a hint read back with whatever fields it carries
//   M8  a background loop that gives up and signs out
//   M9  a pending logout dropped when its marker is unreadable
//   M10 the guard not re-run when only the role changed
//   M11 a different person on screen patched in place instead of reloaded
//   M12 a hint from before another tab's login/logout still trusted
//   M13 identity by username instead of the user id (names can be edited)
//   M14 a signed-out note trusted past its TTL
//   M15 a signed-out note from before another tab's sign-in still trusted
//   M16 a signed-in answer outranking another tab's pending logout (the race)
//   M17 no answer, after another tab's change, keeping the page
//   M18 leaving with no answer onto a fresh page (the browser's error page)
// The tripwire rejects the verbatim pre-fix checkSession() and a catch that signs
// out through _applySignedOut() or _clearUser() (T1), a logout() that writes its
// pending marker only after the request (T3), and the old local edit in
// ChangePasswordView (T5).
//
// Sections 1–3 prove the RULES. Section 4 proves the STORE follows them: it imports
// the committed stores/auth.js with the real Pinia and useApi and drives it through
// page loads, and its own mutants must each fail a scenario. SM1/SM2 (first review)
// and SM6/SM7 (second review) are mutations that got through an earlier version of
// this file.
//
// Section 4 also pins the fresh page. A logout() the server confirms ends on
// exactly one location.replace('/login'), after its request, and leaves a note so
// that page asks nothing (SM21, SM22); an unconfirmed one ends on the app's own
// login screen with NO replace, which would load the browser's error page (SM17).
// login() and setup() end on one at the new user's home only when the page showed
// someone else (SM8–SM16). "Showed" includes a user restored from the tab's saved
// copy and then signed out by the background check: that restore does not go
// through _applyAuthenticated(), and the sign-out clears this.user before anyone
// signs in (SM11, SM13–SM16, SM24, and T8: every real user goes through _showUser()).
// Other tabs: a sign-in or sign-out there reaches this tab as `storage` events,
// and it keeps, reloads or leaves the page (SM18–SM20; the rules are M16–M18).
// T6 checks that the router opens no signed-in screen while the fresh page loads
// and sends a signed-out page to /login, T7 that every logout caller then REPLACES
// /login (a push would add a history entry, and the fresh page would take that
// one's place instead of the signed-in page's), and T9 that LoginView keeps Sign In
// disabled while a fresh page loads.
//
// No network, no DOM. Section 4 loads Pinia/Vue from client/node_modules, which
// `npm ci` at the repo root installs (postinstall) and CI installs before this runs.
//
//   node scripts/test-session-check.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = path.join(__dirname, '..', 'client', 'src')
const real = await import(pathToFileURL(path.join(CLIENT_SRC, 'lib', 'sessionCheck.js')).href)

// ── Fixtures: exactly what the client sees ────────────────────────────────────
// useApi.js throws an Error carrying `status`/`code`/`data` for a non-2xx, turns
// its own timeout into code TIMEOUT with status 0, and lets fetch's TypeError
// through for a network failure (the message differs per browser).
const httpError = (status, body = {}) =>
  Object.assign(new Error(body.error || `Request failed (${status})`), { status, code: body.code || '', data: body })
const timeoutError = () =>
  Object.assign(new Error('The request timed out. Please check your connection and try again.'), { code: 'TIMEOUT', status: 0 })
const abortError = () => Object.assign(new Error('Request cancelled.'), { code: 'ABORT', status: 0 })
const chromeOffline = () => new TypeError('Failed to fetch')
const safariOffline = () => new TypeError('Load failed')
const firefoxOffline = () => new TypeError('NetworkError when attempting to fetch resource.')

const DRIVER = {
  id: 7,
  username: 'd.jones',
  role: 'Driver',
  driverName: 'Dwayne Jones',
  email: 'dj@example.invalid',
  fullName: 'Dwayne Jones',
  companyName: '',
  mustChangePassword: false,
}
// DRIVER as the hint must store it: the fixed field list, in order, no email.
const DRIVER_HINT = {
  id: 7,
  username: 'd.jones',
  role: 'Driver',
  driverName: 'Dwayne Jones',
  fullName: 'Dwayne Jones',
  companyName: '',
  mustChangePassword: false,
}
// Someone else on the same browser (another tab's login).
const OTHER = {
  id: 9,
  username: 'amir',
  role: 'Dispatcher',
  driverName: '',
  email: 'amir@example.invalid',
  fullName: 'Amir S',
  companyName: '',
  mustChangePassword: false,
}
// The server's only two answers (server.js, GET /api/auth/session). It never
// sends a 401 itself; a 401 is still honoured as definitive.
const SIGNED_IN = { authenticated: true, user: DRIVER }
const SIGNED_OUT = { authenticated: false }

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 20, 14, 0, 0)

// ── Suites. Each takes an implementation so mutants run through the same tables.
function suiteClassify(impl, eq) {
  const cases = [
    // The two definitive answers.
    ['2xx authenticated:true with a user', { data: SIGNED_IN }, 'authenticated'],
    ['2xx authenticated:false', { data: SIGNED_OUT }, 'signed-out'],
    ['401 Not authenticated', { error: httpError(401, { error: 'Not authenticated' }) }, 'signed-out'],
    // No answer: the network.
    ['Chrome offline (TypeError: Failed to fetch)', { error: chromeOffline() }, 'unreachable'],
    ['Safari offline (TypeError: Load failed)', { error: safariOffline() }, 'unreachable'],
    ['Firefox offline (TypeError: NetworkError…)', { error: firefoxOffline() }, 'unreachable'],
    ['useApi timeout (code TIMEOUT, status 0)', { error: timeoutError() }, 'unreachable'],
    ['cancelled (code ABORT, status 0)', { error: abortError() }, 'unreachable'],
    // No answer: the server or the proxy in front of it.
    ['500', { error: httpError(500) }, 'unreachable'],
    ['502 while pm2 restarts the app', { error: httpError(502) }, 'unreachable'],
    ['503', { error: httpError(503) }, 'unreachable'],
    ['504 from nginx', { error: httpError(504) }, 'unreachable'],
    ['429 rate limited', { error: httpError(429) }, 'unreachable'],
    ['408 request timeout', { error: httpError(408) }, 'unreachable'],
    // Answers to a different question.
    ['403 Forbidden', { error: httpError(403, { error: 'Forbidden' }) }, 'unreachable'],
    ['404', { error: httpError(404) }, 'unreachable'],
    // A 2xx that says nothing readable.
    ['2xx {} (useApi fallback for a non-JSON body)', { data: {} }, 'unreachable'],
    ['2xx null body', { data: null }, 'unreachable'],
    ['2xx authenticated:"false" (a string, not the server shape)', { data: { authenticated: 'false' } }, 'unreachable'],
    ['2xx authenticated:true with no user', { data: { authenticated: true } }, 'unreachable'],
    ['2xx authenticated:true, user with no role', { data: { authenticated: true, user: { id: 7 } } }, 'unreachable'],
    ['no data and no error', {}, 'unreachable'],
  ]
  for (const [label, attempt, expected] of cases) {
    eq(`classify: ${label}`, impl.classifySessionAttempt(attempt), expected)
  }
}

function suiteForegroundDecision(impl, eq) {
  const d = (outcome, attempt, hasKnownUser) => impl.decideForegroundStep({ outcome, attempt, hasKnownUser })
  // Definitive answers act at once, whoever is known.
  eq('decide: signed-out on attempt 1 (known user) signs out, no retry', d('signed-out', 1, true), { action: 'sign-out' })
  eq('decide: signed-out on attempt 1 (nobody known) signs out', d('signed-out', 1, false), { action: 'sign-out' })
  eq('decide: authenticated accepts', d('authenticated', 1, true), { action: 'accept' })
  // No answer, known user: one short retry, then stay in the app.
  eq('decide: known user, no answer, attempt 1 → retry in 1 s', d('unreachable', 1, true), { action: 'retry', delayMs: 1000 })
  eq('decide: known user, no answer, attempt 2 → stay, reconnecting', d('unreachable', 2, true), { action: 'stay-reconnecting' })
  // No answer, nobody known: two retries, then the login page.
  eq('decide: nobody known, attempt 1 → retry in 1 s', d('unreachable', 1, false), { action: 'retry', delayMs: 1000 })
  eq('decide: nobody known, attempt 2 → retry in 2 s', d('unreachable', 2, false), { action: 'retry', delayMs: 2000 })
  eq('decide: nobody known, attempt 3 → login page, reconnecting', d('unreachable', 3, false), { action: 'login-reconnecting' })
  // An outcome nobody planned for is "no answer": never sign-out, never accept.
  eq('decide: unknown outcome, known user → stay', d('???', 2, true), { action: 'stay-reconnecting' })
  eq('decide: undefined outcome, nobody known → login', d(undefined, 3, false), { action: 'login-reconnecting' })
}

// Drives impl.runForegroundCheck with a scripted server. An Error in the script
// is thrown by the probe (as a probe that rejects would); anything else is
// resolved as-is.
async function scenario(impl, { script, hasKnownUser }) {
  const timeouts = []
  const sleeps = []
  let i = 0
  const result = await impl.runForegroundCheck({
    probe: async (timeoutMs) => {
      timeouts.push(timeoutMs)
      const step = script[Math.min(i++, script.length - 1)]
      if (step instanceof Error) throw step
      return step
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    hasKnownUser,
  })
  return { action: result.action, attempts: result.attempts, sleeps, user: result.user, timeouts }
}

async function suiteForegroundScenarios(impl, eq) {
  // The production bounce: a known driver reloads mid-task, the network drops.
  let r = await scenario(impl, { script: [{ error: httpError(504) }, { error: chromeOffline() }], hasKnownUser: true })
  eq('scenario: known driver, 504 then offline → stays in the app', r.action, 'stay-reconnecting')
  eq('scenario: …after exactly 2 attempts, 1 s apart', [r.attempts, r.sleeps], [2, [1000]])
  eq('scenario: …and STAY never produces a user of its own', r.user, null)

  // A deploy restart: nginx 502s for a few seconds, then the app is back.
  r = await scenario(impl, {
    script: [{ error: httpError(502) }, { error: httpError(502) }, { data: SIGNED_IN }],
    hasKnownUser: false,
  })
  eq('scenario: 502, 502, then signed in → accepted, not the login page', r.action, 'accept')
  eq('scenario: …on attempt 3, after 1 s and 2 s', [r.attempts, r.sleeps], [3, [1000, 2000]])
  eq("scenario: …with the SERVER's user object, not a copy", r.user === DRIVER, true)

  // A real sign-out is never argued with, however it arrives.
  r = await scenario(impl, { script: [{ error: timeoutError() }, { error: httpError(401) }], hasKnownUser: true })
  eq('scenario: timeout, then a real 401 → signed out on attempt 2', [r.action, r.attempts], ['sign-out', 2])
  r = await scenario(impl, { script: [{ data: SIGNED_OUT }, { data: SIGNED_IN }], hasKnownUser: true })
  eq('scenario: authenticated:false first → signed out at once, never retried', [r.action, r.attempts, r.sleeps], ['sign-out', 1, []])

  // Offline with nobody known: the login page, after the short retries.
  r = await scenario(impl, { script: [{ error: safariOffline() }], hasKnownUser: false })
  eq('scenario: offline, nobody known → login page after 3 attempts', [r.action, r.attempts, r.sleeps], ['login-reconnecting', 3, [1000, 2000]])

  // A probe that throws is a failed attempt, not a crash and not a sign-out.
  r = await scenario(impl, { script: [chromeOffline(), { data: SIGNED_IN }], hasKnownUser: false })
  eq('scenario: a probe that throws, then signed in → accepted on attempt 2', [r.action, r.attempts], ['accept', 2])

  // An unreadable 2xx (a proxy page) is retried, not read as "signed out".
  r = await scenario(impl, { script: [{ data: {} }, { data: SIGNED_IN }], hasKnownUser: true })
  eq('scenario: unreadable 2xx, then signed in → accepted', [r.action, r.attempts], ['accept', 2])

  // The foreground never waits on useApi's 20 s default.
  eq('scenario: every foreground attempt uses the short timeout', r.timeouts.every((t) => t === real.FOREGROUND.timeoutMs && t < 20000), true)
}

function suiteBackground(impl, eq) {
  eq('background: no answer on tick 0 → retry in 2 s', impl.decideBackgroundStep('unreachable', 0), { action: 'retry', delayMs: 2000 })
  eq('background: no answer on tick 999 → still retry, every 30 s', impl.decideBackgroundStep('unreachable', 999), { action: 'retry', delayMs: 30000 })
  eq('background: signed-out → sign out', impl.decideBackgroundStep('signed-out', 3), { action: 'sign-out' })
  eq('background: authenticated → accept', impl.decideBackgroundStep('authenticated', 3), { action: 'accept' })
  // Silence never concludes anything, however long it lasts.
  let gaveUp = null
  for (let tick = 0; tick < 500 && gaveUp === null; tick++) {
    if (impl.decideBackgroundStep('unreachable', tick).action !== 'retry') gaveUp = tick
  }
  eq('background: 500 silent ticks in a row never give up', gaveUp, null)
  const delays = Array.from({ length: 12 }, (_, t) => impl.backgroundDelayMs(t))
  eq('background: delays never shrink, and cap at 30 s', delays.every((v, t) => t === 0 || v >= delays[t - 1]) && Math.max(...delays) === 30000, true)
  eq('background: a nonsense tick falls back to the first delay', [impl.backgroundDelayMs(-1), impl.backgroundDelayMs(NaN)], [2000, 2000])
}

function suiteHint(impl, eq) {
  const stored = impl.serializeSessionHint(DRIVER, T0)
  eq('hint: round-trips within the TTL as the fixed field list', impl.parseSessionHint(stored, T0 + HOUR), DRIVER_HINT)
  eq('hint: email is never written', typeof stored === 'string' && !stored.includes('dj@example.invalid'), true)
  eq('hint: still valid at exactly 24 h', impl.parseSessionHint(stored, T0 + 24 * HOUR) !== null, true)
  eq('hint: gone 1 ms past 24 h (the cookie certainly is)', impl.parseSessionHint(stored, T0 + 24 * HOUR + 1), null)
  eq('hint: a clock that moved backwards gives no hint', impl.parseSessionHint(stored, T0 - 1), null)
  eq('hint: absent', impl.parseSessionHint(null, T0), null)
  eq('hint: garbage', impl.parseSessionHint('{not json', T0), null)
  eq('hint: another version', impl.parseSessionHint(JSON.stringify({ v: 2, confirmedAt: T0, user: DRIVER }), T0), null)
  eq('hint: no confirmedAt', impl.parseSessionHint(JSON.stringify({ v: 1, user: DRIVER }), T0), null)
  eq('hint: a stored user with no role is no user', impl.parseSessionHint(JSON.stringify({ v: 1, confirmedAt: T0, user: { ...DRIVER, role: '' } }), T0), null)
  // Read-side whitelist: a hint written elsewhere cannot smuggle fields in.
  const tampered = JSON.stringify({ v: 1, confirmedAt: T0, user: { ...DRIVER, isSuperAdmin: true, token: 'x' } })
  eq('hint: extra fields in a stored hint are dropped on read', impl.parseSessionHint(tampered, T0), DRIVER_HINT)
  // Only a real user can become a hint.
  eq('hint: nothing is written for a role-less user', impl.serializeSessionHint({ id: 7, username: 'x' }, T0), null)
  eq('hint: nothing is written for null / an array / a string', [null, [], 'Driver'].map((u) => impl.serializeSessionHint(u, T0)), [null, null, null])
  // The epoch: another tab's login or logout makes every older hint stale.
  const at = (notBeforeMs) => impl.parseSessionHint(stored, T0 + HOUR, { notBeforeMs })
  eq('hint: confirmed after the latest login/logout → kept', at(T0 - 1) !== null, true)
  eq('hint: confirmed in the same ms as the epoch → kept (login stamps, then saves)', at(T0) !== null, true)
  eq('hint: confirmed BEFORE another tab logged out or signed in → ignored', at(T0 + 1), null)
  eq('hint: an unreadable epoch (Infinity) → ignored', at(Infinity), null)
}

function suiteEpoch(impl, eq) {
  eq('epoch: never stamped → 0, so no hint is older than it', [impl.parseSessionEpoch(null), impl.parseSessionEpoch('')], [0, 0])
  eq('epoch: round-trips', impl.parseSessionEpoch(impl.serializeSessionEpoch(T0)), T0)
  // Infinity does not survive JSON, so compare it explicitly.
  eq('epoch: unreadable → Infinity (distrust every hint)', ['soon', '-5', '{}'].map((raw) => impl.parseSessionEpoch(raw) === Infinity), [true, true, true])
}

function suitePendingLogout(impl, eq) {
  const marker = impl.serializePendingLogout(T0)
  eq('pending logout: none recorded', [impl.parsePendingLogout(null, T0), impl.parsePendingLogout('', T0)], [false, false])
  eq('pending logout: just recorded', impl.parsePendingLogout(marker, T0 + 1000), true)
  eq('pending logout: still pending at 24 h', impl.parsePendingLogout(marker, T0 + 24 * HOUR), true)
  eq('pending logout: past 24 h the cookie is dead, nothing to finish', impl.parsePendingLogout(marker, T0 + 24 * HOUR + 1), false)
  eq('pending logout: unreadable marker is honoured (fail-closed)', impl.parsePendingLogout('{oops', T0), true)
  eq('pending logout: marker with no time is honoured', impl.parsePendingLogout(JSON.stringify({ v: 1 }), T0), true)
  eq('pending logout: a future-dated marker is honoured', impl.parsePendingLogout(impl.serializePendingLogout(T0 + HOUR), T0), true)
  // The old logout(): `catch { /* ignore */ }`, i.e. every failure counted as done.
  eq('logout: a 2xx confirms it', impl.logoutConfirmed({}), true)
  eq('logout: a 401 means there was no session to end', impl.logoutConfirmed({ error: httpError(401) }), true)
  eq('logout: offline does NOT confirm it', impl.logoutConfirmed({ error: chromeOffline() }), false)
  eq('logout: a timeout does NOT confirm it', impl.logoutConfirmed({ error: timeoutError() }), false)
  eq('logout: a 502 does NOT confirm it', impl.logoutConfirmed({ error: httpError(502) }), false)
}

function suiteGuardInputs(impl, eq) {
  const g = (a, b) => impl.guardInputsChanged(a, b)
  eq('reroute: same user → no', g(DRIVER_HINT, DRIVER), false)
  eq('reroute: a username change alone is not a guard input', g(DRIVER_HINT, { ...DRIVER, username: 'dj2' }), false)
  eq('reroute: role changed → yes', g(DRIVER_HINT, { ...DRIVER, role: 'Dispatcher' }), true)
  eq('reroute: a different user → yes', g(DRIVER_HINT, { ...DRIVER, id: 8 }), true)
  eq('reroute: forced password change switched on → yes', g(DRIVER_HINT, { ...DRIVER, mustChangePassword: true }), true)
  eq('reroute: signed out → yes', g(DRIVER_HINT, null), true)
  eq('reroute: signed in from the login page → yes', g(null, DRIVER), true)
  eq('reroute: still nobody → no', g(null, null), false)
  eq('reroute: a role-less object counts as nobody', g(null, { id: 7 }), false)
}

// Identity is the user id, the one field nobody edits: PUT /api/users/:id renames
// drivers across tables (DRIVER_RENAME_TARGETS in server.js). Called directly, not
// only through pageEffect(), so a mutant of this function alone is caught too.
function suiteIdentity(impl, eq) {
  const d = (a, b) => impl.isDifferentUser(a, b)
  eq('identity: same id, same names → the same person', d(DRIVER_HINT, DRIVER), false)
  eq('identity: same id, NEW username → still the same person', d(DRIVER_HINT, { ...DRIVER, username: 'dwayne.jones' }), false)
  eq('identity: same id, renamed driver → still the same person', d(DRIVER_HINT, { ...DRIVER, driverName: 'Dwayne A. Jones' }), false)
  eq('identity: a DIFFERENT id under the same username → a different person', d(DRIVER_HINT, { ...DRIVER, id: 70 }), true)
  eq('identity: a different id and username → a different person', d(DRIVER_HINT, OTHER), true)
  eq('identity: nobody shown (the login page) is never "different"', d(null, DRIVER), false)
  eq('identity: signed out is not "different" (that is a reroute)', d(DRIVER_HINT, null), false)
}

function suitePageEffect(impl, eq) {
  const e = (a, b) => impl.pageEffect(a, b)
  eq('page: same person, nothing changed → nothing', e(DRIVER_HINT, DRIVER), 'none')
  eq('page: same id under a new username → nothing, NOT a reload', e(DRIVER_HINT, { ...DRIVER, username: 'dwayne.jones' }), 'none')
  eq('page: a different id under the same username → full reload', e(DRIVER_HINT, { ...DRIVER, id: 70 }), 'reload')
  eq('page: same person, new role → re-run the guard', e(DRIVER_HINT, { ...DRIVER, role: 'Dispatcher' }), 'reroute')
  eq('page: signed out → re-run the guard (to /login), not a reload', e(DRIVER_HINT, null), 'reroute')
  eq('page: nobody shown (login page), now signed in → re-run the guard, not a reload', e(null, DRIVER), 'reroute')
  eq('page: a DIFFERENT person from the one shown → full reload', e(DRIVER_HINT, OTHER), 'reload')
  eq('page: the same id as a string and as a number is the same person', e({ ...DRIVER_HINT, id: '7' }, DRIVER), 'none')
  eq('page: no ids on either side → compared by username', e({ ...DRIVER_HINT, id: undefined }, { ...DRIVER, id: undefined, username: 'someone.else' }), 'reload')
}

// The note a confirmed sign-out leaves for the fresh /login page it loads, so that
// page skips its session check. It speaks for ONE page load, so it expires fast,
// and never outlives a sign-in made after it.
function suiteSignedOutNote(impl, eq) {
  const TTL = real.SIGNED_OUT_NOTE_TTL_MS
  const note = impl.serializeSignedOutNote(T0)
  eq('note: holds a timestamp and nothing else', JSON.parse(note), { v: 1, at: T0 })
  eq('note: read back just after it was written', impl.parseSignedOutNote(note, T0 + 1500), true)
  eq('note: still good at exactly the TTL', impl.parseSignedOutNote(note, T0 + TTL), true)
  eq('note: gone 1 ms past the TTL (the page that read it was not the one logout() asked for)', impl.parseSignedOutNote(note, T0 + TTL + 1), false)
  eq('note: the TTL is short: one page load, not a session', TTL > 21000 && TTL <= 5 * 60 * 1000, true)
  eq('note: a clock that moved backwards gives no note', impl.parseSignedOutNote(note, T0 - 1), false)
  eq('note: absent / empty', [impl.parseSignedOutNote(null, T0), impl.parseSignedOutNote('', T0)], [false, false])
  // Unlike the pending-logout record, an unreadable note is NO note: ignoring it costs one check.
  eq('note: unreadable → no note (fails toward the ordinary check)', impl.parseSignedOutNote('{oops', T0), false)
  eq('note: another version, or no time → no note', [
    impl.parseSignedOutNote(JSON.stringify({ v: 2, at: T0 }), T0),
    impl.parseSignedOutNote(JSON.stringify({ v: 1 }), T0),
  ], [false, false])
  eq('note: nothing is written for a nonsense time', impl.serializeSignedOutNote(NaN), null)
  const at = (notBeforeMs) => impl.parseSignedOutNote(note, T0 + 1000, { notBeforeMs })
  eq('note: written after the latest sign-in/sign-out (logout() stamps, then writes it) → good', [at(T0 - 1), at(T0)], [true, true])
  eq('note: written BEFORE another tab signed someone in → no note', at(T0 + 1), false)
  eq('note: an unreadable epoch (Infinity) → no note', at(Infinity), false)
}

// Another tab changed who owns the cookie; this tab still shows `shown`.
function suiteTabChange(impl, eq) {
  const d = (outcome, pendingLogout, next = null) => impl.decideTabChange({ outcome, pendingLogout, shown: DRIVER_HINT, next })
  const LEAVE_FRESH = { action: 'leave', freshPage: true }
  const LEAVE_IN_APP = { action: 'leave', freshPage: false }
  // The race: a logout is recorded BEFORE its request, so the server can still say "signed in".
  eq('tab change: a pending logout, and the server still says signed in (the race) → leave, fresh /login', d('authenticated', true, DRIVER), LEAVE_FRESH)
  eq('tab change: a pending logout, and the server names someone else → leave, fresh /login', d('authenticated', true, OTHER), LEAVE_FRESH)
  eq('tab change: a pending logout, the server confirms → leave, fresh /login', d('signed-out', true), LEAVE_FRESH)
  eq('tab change: a pending logout and no answer → leave for the app\'s own /login (no fresh page to load)', d('unreachable', true), LEAVE_IN_APP)
  eq('tab change: signed out (no pending record) → leave, fresh /login', d('signed-out', false), LEAVE_FRESH)
  eq('tab change: the same person → keep the page', d('authenticated', false, DRIVER), { action: 'keep', freshPage: false })
  eq('tab change: the same id under a new username → still keep the page', d('authenticated', false, { ...DRIVER, username: 'dwayne.jones' }), { action: 'keep', freshPage: false })
  eq('tab change: someone else → reload from them', d('authenticated', false, OTHER), { action: 'reload', freshPage: false })
  // No answer and nothing recorded: the owner changed and nothing proves it is still this person.
  eq('tab change: no answer, nothing pending → leave for the app\'s own /login (the safe side)', d('unreachable', false), LEAVE_IN_APP)
  eq('tab change: an outcome nobody planned for → leave in-app, never keep', d('???', false), LEAVE_IN_APP)
}

const SUITES = [
  suiteClassify,
  suiteForegroundDecision,
  suiteForegroundScenarios,
  suiteBackground,
  suiteHint,
  suiteEpoch,
  suitePendingLogout,
  suiteGuardInputs,
  suiteIdentity,
  suitePageEffect,
  suiteSignedOutNote,
  suiteTabChange,
]

async function runSuites(impl) {
  const results = []
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    results.push({ label, ok: a === e, actual: a, expected: e })
  }
  for (const suite of SUITES) {
    try {
      await suite(impl, eq)
    } catch (err) {
      results.push({ label: `${suite.name} threw`, ok: false, actual: String(err && err.stack), expected: 'no throw' })
    }
  }
  return results
}

let pass = 0
let fail = 0
const report = (ok, message) => {
  if (ok) pass++
  else {
    fail++
    console.error(message)
  }
}

// ── 1. The real rules ─────────────────────────────────────────────────────────
for (const r of await runSuites(real)) {
  report(r.ok, `FAIL  ${r.label}\n        expected ${r.expected}\n        actual   ${r.actual}`)
}

// ── 2. Mutants: each must be rejected by at least one check above ─────────────
// M1 is the pre-fix store, modelled exactly (client/src/stores/auth.js at 9e3cc53):
//   try { const data = await api.get('/api/auth/session')
//         if (data.authenticated) accept else sign-out }
//   catch { sign-out }                 // ← every failure
// and logout(): try { await api.post('/api/auth/logout') } catch { /* ignore */ }
const PRE_FIX = {
  classifySessionAttempt: ({ data, error } = {}) =>
    error != null ? 'signed-out' : data && data.authenticated ? 'authenticated' : 'signed-out',
  decideForegroundStep: ({ outcome } = {}) => (outcome === 'authenticated' ? { action: 'accept' } : { action: 'sign-out' }),
  runForegroundCheck: async ({ probe }) => {
    let r
    try {
      r = await probe(20000)
    } catch (error) {
      r = { error }
    }
    if (r && r.error == null && r.data && r.data.authenticated) return { action: 'accept', user: r.data.user, attempts: 1 }
    return { action: 'sign-out', user: null, attempts: 1 }
  },
  logoutConfirmed: () => true,
}

const MUTANTS = [
  ['M1 the pre-fix store (any failure means signed out)', PRE_FIX],
  ['M2 an unreadable 2xx read as "signed out"', {
    classifySessionAttempt: (a = {}) =>
      a.error == null && !(a.data && a.data.authenticated === true) ? 'signed-out' : real.classifySessionAttempt(a),
  }],
  ['M3 any 4xx treated as definitive', {
    classifySessionAttempt: (a = {}) => {
      const s = Number(a.error && a.error.status)
      return s >= 400 && s < 500 ? 'signed-out' : real.classifySessionAttempt(a)
    },
  }],
  ['M4 never sign out, even on a real 401', {
    classifySessionAttempt: (a = {}) => {
      const o = real.classifySessionAttempt(a)
      return o === 'signed-out' ? 'unreachable' : o
    },
  }],
  ['M5 stay in the app with nobody known', {
    decideForegroundStep: (o) => {
      const step = real.decideForegroundStep(o)
      return step.action === 'login-reconnecting' ? { action: 'stay-reconnecting' } : step
    },
  }],
  ['M6 a hint trusted past its TTL', {
    parseSessionHint: (raw, now, opts = {}) => real.parseSessionHint(raw, now, { ...opts, ttlMs: Infinity }),
  }],
  ['M7 a hint read back with every field it carries', {
    parseSessionHint: (raw, now, opts) => {
      if (real.parseSessionHint(raw, now, opts) === null) return null
      return JSON.parse(raw).user
    },
  }],
  ['M8 a background loop that gives up after 5 tries', {
    decideBackgroundStep: (outcome, tick) => (tick >= 5 ? { action: 'sign-out' } : real.decideBackgroundStep(outcome, tick)),
  }],
  ['M9 an unreadable pending-logout marker ignored', {
    parsePendingLogout: (raw, now) => {
      try {
        JSON.parse(raw)
      } catch {
        return false
      }
      return real.parsePendingLogout(raw, now)
    },
  }],
  ['M10 the guard not re-run when only the role changed', {
    guardInputsChanged: (a, b) => !real.isSessionUser(a) !== !real.isSessionUser(b),
  }],
  ['M11 a different person on screen patched in place, not reloaded', {
    pageEffect: (a, b) => (real.guardInputsChanged(a, b) ? 'reroute' : 'none'),
  }],
  ['M12 a hint from before another tab\'s login/logout still trusted', {
    parseSessionHint: (raw, now, opts = {}) => real.parseSessionHint(raw, now, { ...opts, notBeforeMs: 0 }),
  }],
  ['M13 identity by username instead of the user id', {
    isDifferentUser: (a, b) => real.isSessionUser(a) && real.isSessionUser(b) && a.username !== b.username,
  }],
  ['M14 a signed-out note trusted past its TTL', {
    parseSignedOutNote: (raw, now, opts = {}) => real.parseSignedOutNote(raw, now, { ...opts, ttlMs: Infinity }),
  }],
  ['M15 a signed-out note from before another tab\'s sign-in still trusted', {
    parseSignedOutNote: (raw, now, opts = {}) => real.parseSignedOutNote(raw, now, { ...opts, notBeforeMs: 0 }),
  }],
  ['M16 a signed-in answer outranks a pending logout (the race)', {
    decideTabChange: (o = {}) => real.decideTabChange(o.outcome === 'authenticated' ? { ...o, pendingLogout: false } : o),
  }],
  ['M17 no answer keeps the page', {
    decideTabChange: (o = {}) => (!o.pendingLogout && o.outcome === 'unreachable' ? { action: 'keep', freshPage: false } : real.decideTabChange(o)),
  }],
  ['M18 leaving with no answer loads a fresh page anyway (the browser\'s error page)', {
    decideTabChange: (o = {}) => {
      const step = real.decideTabChange(o)
      return step.action === 'leave' ? { ...step, freshPage: true } : step
    },
  }],
]

for (const [name, overrides] of MUTANTS) {
  const results = await runSuites({ ...real, ...overrides })
  const caught = results.filter((r) => !r.ok).length
  report(caught > 0, `FAIL  mutant survived: ${name}\n        no check noticed it; the tables above have lost their teeth`)
}

// ── 3. Tripwire on the wiring ─────────────────────────────────────────────────
// Cheap static checks for the shapes that bypass the rules. Section 4 is what
// proves the store actually behaves; these catch the obvious regressions by name.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}
// The body between the `{` at openIdx and its matching `}`.
function blockFrom(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(openIdx + 1, i)
  }
  return src.slice(openIdx + 1)
}
function catchBodies(src) {
  const bodies = []
  const patterns = [
    /\bcatch\s*(?:\([^)]*\))?\s*\{/g, // try { … } catch (e) { … }
    /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g, // p.catch((e) => { … })
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(src))) bodies.push(blockFrom(src, re.lastIndex - 1))
  }
  return bodies
}
// T1: turning a FAILURE into a sign-out is exactly the bug, whether it is spelled
// out inline or goes through the store's own helper. Signing out happens only
// through the decision above, never in a catch.
const SIGNS_OUT = /this\.user\s*=\s*null|this\.isAuthenticated\s*=\s*false|\b_applySignedOut\s*\(|\b_clearUser\s*\(|\$reset\s*\(/
function catchSignsOut(src) {
  return catchBodies(stripComments(src)).some((b) => SIGNS_OUT.test(b))
}
function methodBody(src, name) {
  const at = src.search(new RegExp(`async\\s+${name}\\s*\\(`))
  if (at < 0) return null
  return blockFrom(src, src.indexOf('{', at))
}
// T3: the pending-logout marker is written BEFORE the request goes out, so a tab
// closed mid-request still has it; and "done" is decided by logoutConfirmed().
function logoutIsFailClosed(src) {
  const s = stripComments(src)
  const body = methodBody(s, 'logout')
  const send = methodBody(s, '_sendLogout')
  if (body === null || send === null) return false
  const mark = body.indexOf('serializePendingLogout(')
  const req = body.indexOf('_sendLogout(')
  return mark !== -1 && req !== -1 && mark < req && send.includes('logoutConfirmed(')
}
// T5: after a password change the view refreshes through the store; editing
// auth.user in the view reaches memory but not this tab's saved copy.
const editsAuthUserLocally = (src) => /\bauth\.user\s*=(?!=)/.test(src)

const AUTH_PATH = path.join(CLIENT_SRC, 'stores', 'auth.js')
const authSrc = fs.readFileSync(AUTH_PATH, 'utf8')
const routerSrc = fs.readFileSync(path.join(CLIENT_SRC, 'router', 'index.js'), 'utf8')
const changePasswordSrc = stripComments(fs.readFileSync(path.join(CLIENT_SRC, 'views', 'ChangePasswordView.vue'), 'utf8'))

report(!catchSignsOut(authSrc), 'FAIL  T1 stores/auth.js signs the user out inside a catch: a failure is not a sign-out (lib/sessionCheck.js, rule 1)')
report(
  /from\s+['"]\.\.\/lib\/sessionCheck(?:\.js)?['"]/.test(authSrc) &&
    /\brunForegroundCheck\(/.test(stripComments(authSrc)) &&
    /\bclassifySessionAttempt\(/.test(stripComments(authSrc)),
  'FAIL  T2 stores/auth.js no longer routes the session check through lib/sessionCheck.js',
)
report(logoutIsFailClosed(authSrc), 'FAIL  T3 logout() must record the pending logout BEFORE the request and clear it only via logoutConfirmed()')
report(
  /\bonSessionResolved\(/.test(stripComments(routerSrc)) && /force:\s*true/.test(stripComments(routerSrc)),
  'FAIL  T4 router/index.js does not re-run its guard when a background session check resolves',
)
report(
  !editsAuthUserLocally(changePasswordSrc) && /\bauth\.afterPasswordChange\(/.test(changePasswordSrc),
  'FAIL  T5 ChangePasswordView.vue must refresh the user through auth.afterPasswordChange(), not edit auth.user (the saved copy would keep mustChangePassword: true)',
)

// The tripwire must reject the code it replaced. Verbatim pre-fix checkSession():
const PRE_FIX_CHECK_SESSION = `
    async checkSession() {
      if (this._sessionPromise) return this._sessionPromise
      this._sessionPromise = (async () => {
        try {
          const data = await api.get('/api/auth/session')
          if (data.authenticated) {
            this.user = data.user
            this.isAuthenticated = true
          } else {
            this.user = null
            this.isAuthenticated = false
          }
        } catch {
          this.user = null
          this.isAuthenticated = false
        } finally {
          this.isLoading = false
          this._sessionPromise = null
        }
      })()
      return this._sessionPromise
    },`
report(catchSignsOut(PRE_FIX_CHECK_SESSION), 'FAIL  T1 does not flag the pre-fix checkSession(); the tripwire is blind')
report(
  catchSignsOut('p.catch((err) => { this.isAuthenticated = false })'),
  'FAIL  T1 does not flag a promise .catch() that signs out; the tripwire is blind',
)
report(
  catchSignsOut('try { await probe() } catch { this._applySignedOut() }'),
  'FAIL  T1 does not flag a catch that signs out through _applySignedOut(); the tripwire is blind',
)
report(
  catchSignsOut('try { await probe() } catch { this._clearUser() }'),
  'FAIL  T1 does not flag a catch that signs out through _clearUser(); the tripwire is blind',
)
report(
  editsAuthUserLocally('if (auth.user) auth.user = { ...auth.user, mustChangePassword: false }'),
  'FAIL  T5 does not flag the pre-fix local edit; the tripwire is blind',
)

// …and a logout() that only writes its marker after the request. Built from the
// real source by moving the marker line to the end of the method, so this keeps
// working when logout() is reformatted.
{
  const s = stripComments(authSrc)
  const body = methodBody(s, 'logout')
  const lines = body === null ? [] : body.split('\n')
  const idx = lines.findIndex((l) => l.includes('serializePendingLogout('))
  if (idx === -1) {
    report(false, 'FAIL  T3 mutant could not be built: logout() writes no pending-logout marker at all')
  } else {
    const [markLine] = lines.splice(idx, 1)
    lines.push(markLine)
    const mutated = s.replace(body, lines.join('\n'))
    report(!logoutIsFailClosed(mutated), 'FAIL  T3 does not flag a logout() that records its marker after the request; the tripwire is blind')
  }
}

// T6: while stores/auth.js loads a fresh page (sign-out, a sign-in as a different
// person), the router opens no signed-in screen: its guard asks isLeavingPage().
// Section 4 cannot drive the router, so this is checked by name.
function guardWaitsForFreshPage(src) {
  const s = stripComments(src)
  const at = s.search(/router\.beforeEach\(/)
  if (at < 0) return false
  const guard = blockFrom(s, s.indexOf('{', at))
  return (
    /import\s*\{[^}]*\bisLeavingPage\b[^}]*\}\s*from\s*['"]\.\.\/stores\/auth(?:\.js)?['"]/.test(s) &&
    /\bisLeavingPage\(\)/.test(guard)
  )
}
report(guardWaitsForFreshPage(routerSrc), 'FAIL  T6 router/index.js must refuse signed-in routes while stores/auth.js loads a fresh page (isLeavingPage() in beforeEach)')
report(
  !guardWaitsForFreshPage(routerSrc.replace(/^.*\bisLeavingPage\(\).*$/m, '')),
  'FAIL  T6 does not flag a guard without the isLeavingPage() check; the tripwire is blind',
)
// …and a page that is leaving with nobody signed in (an unconfirmed sign-out, or
// another tab's sign-out) goes to the app's own /login when the guard re-runs
// (onSessionResolved), instead of refusing and leaving the signed-out person's
// screen up.
function leavingSignedOutGoesToLogin(src) {
  const s = stripComments(src)
  const at = s.search(/router\.beforeEach\(/)
  if (at < 0) return false
  const guard = blockFrom(s, s.indexOf('{', at))
  const line = guard.split('\n').find((l) => /\bisLeavingPage\(\)/.test(l)) || ''
  return /\bisAuthenticated\b/.test(line) && /\{\s*name:\s*['"]login['"]\s*\}|['"]\/login['"]/.test(line)
}
report(leavingSignedOutGoesToLogin(routerSrc), "FAIL  T6 router/index.js must send a leaving page with nobody signed in to /login (a bare `return false` leaves the signed-out person's screen up)")
report(
  !leavingSignedOutGoesToLogin(routerSrc.replace(/^.*\bisLeavingPage\(\).*$/m, '  if (isLeavingPage() && !to.meta.public) return false')),
  'FAIL  T6 does not flag the #395 guard line that only refuses; the tripwire is blind',
)

// T7: every caller of auth.logout() follows it with router.replace('/login'). The
// fresh page takes the history entry that is current when it arrives, so a push
// here would leave the signed-in page's entry in place for Back.
function logoutCallersReplace(files) {
  const bad = []
  for (const [name, src] of files) {
    const s = stripComments(src)
    const re = /\bauth\.logout\(\)/g
    let m
    while ((m = re.exec(s))) {
      const after = s.slice(m.index, m.index + 200)
      if (!/^auth\.logout\(\)\s*;?\s*router\.replace\(\s*['"]\/login['"]\s*\)/.test(after)) bad.push(name)
    }
  }
  return bad
}
{
  const files = fs
    .readdirSync(CLIENT_SRC, { recursive: true })
    .filter((f) => /\.(vue|js)$/.test(f) && !f.split(path.sep).includes('node_modules'))
    .map((f) => [f, fs.readFileSync(path.join(CLIENT_SRC, f), 'utf8')])
    .filter(([, src]) => /\bauth\.logout\(\)/.test(src))
  const bad = logoutCallersReplace(files)
  report(files.length >= 3 && bad.length === 0, `FAIL  T7 every auth.logout() caller must follow it with router.replace('/login') (found ${files.length} callers; not replacing: ${bad.join(', ') || 'none'})`)
  report(
    logoutCallersReplace([['pre-fix AppSidebar', "async function handleLogout() {\n  await auth.logout()\n  router.push('/login')\n}"]]).length === 1,
    'FAIL  T7 does not flag a caller that pushes /login after logout; the tripwire is blind',
  )
}

// T8: every real user put on screen goes through _showUser() (stores/auth.js), the
// ONE place that notes who the page showed (noteShown), tells the live-update socket
// whom it may reconnect for (setSocketOwner), and starts following other tabs. The
// page-load restore from the saved copy used to assign this.user directly, and a
// sign-out clears this.user before anyone signs in, so a record kept anywhere else
// misses exactly the case it exists for. Outside _showUser(), this.user may only be
// cleared. Section 4 proves the sites that exist today; this catches a new one.
function methodNamed(src, name) {
  const at = src.search(new RegExp(`\\n[ \\t]*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`))
  if (at < 0) return null
  const open = src.indexOf('{', at)
  return { open, body: blockFrom(src, open) }
}
function directUserAssignments(src) {
  const s = stripComments(src)
  const show = methodNamed(s, '_showUser')
  const outside = show ? s.slice(0, show.open + 1) + s.slice(show.open + 1 + show.body.length) : s
  const bad = []
  const re = /\bthis\.user\s*=(?![=>])\s*/g
  let m
  while ((m = re.exec(outside))) {
    const rest = outside.slice(re.lastIndex)
    if (/^null\b/.test(rest)) continue // clearing it: nobody is put on screen
    bad.push(`this.user = ${rest.slice(0, rest.indexOf('\n')).trim()}`)
  }
  return { showUser: show ? show.body : null, bad }
}
{
  const { showUser, bad } = directUserAssignments(authSrc)
  report(bad.length === 0, `FAIL  T8 stores/auth.js must put every real user in this.user through _showUser() (assigned directly: ${bad.join(' | ') || 'none'})`)
  report(
    showUser !== null && /\bthis\.user\s*=\s*user\b/.test(showUser) && /\bnoteShown\(user\)/.test(showUser) && /\bsetSocketOwner\(/.test(showUser),
    'FAIL  T8 _showUser() must assign the user, note it (noteShown) and tell the socket who is on screen (setSocketOwner)',
  )
  const calls = (stripComments(authSrc).match(/\bthis\._showUser\(/g) || []).length
  report(calls >= 3, `FAIL  T8 the saved-copy restore, _applyAuthenticated() and afterPasswordChange() must each go through _showUser() (found ${calls} calls)`)
  const stripped = stripComments(authSrc)
  const restoredDirectly = stripped.replace(/this\._showUser\(known\)/, 'this.user = known')
  if (restoredDirectly === stripped) {
    report(false, 'FAIL  T8 control could not be built: the saved-copy restore has no this._showUser(known) to replace')
  } else {
    const flagged = directUserAssignments(restoredDirectly).bad
    report(flagged.length === 1 && flagged[0] === 'this.user = known', 'FAIL  T8 does not flag the saved-copy restore assigning this.user directly; the tripwire is blind')
  }
  const flagged = directUserAssignments(
    '\n_showUser(user) {\n  this.user = user\n}\ncase ACTION.STAY:\n  this.user = known\n  this.isAuthenticated = true\n',
  ).bad
  report(flagged.length === 1 && flagged[0] === 'this.user = known', 'FAIL  T8 does not flag a direct real-user assignment next to _showUser(); the tripwire is blind')
}

// T9: LoginView keeps Sign In (and Create Account) disabled while the fresh page a
// successful sign-in asked for is loading, so a second tap cannot send a second
// sign-in; and hands it back after a refused one. So the page is asked whether it
// is leaving only once the call has SUCCEEDED (between the call and the catch), and
// the `finally` resets the flag only conditionally. Asking in `finally` alone would
// lock the button for good after a refused sign-in on a page an unconfirmed
// sign-out has already marked as leaving.
function signInHoldsButton(src, fn, call, flag) {
  const s = stripComments(src)
  const at = s.search(new RegExp(`async\\s+function\\s+${fn}\\s*\\(`))
  if (at < 0) return false
  const body = blockFrom(s, s.indexOf('{', at))
  const callAt = body.indexOf(`await auth.${call}(`)
  const catchAt = body.search(/\}\s*catch\b/)
  const finAt = body.search(/\bfinally\s*\{/)
  if (callAt < 0 || catchAt < 0 || finAt < 0) return false
  const leavingAt = body.indexOf('isLeavingPage()')
  const fin = blockFrom(body, body.indexOf('{', finAt))
  const unconditional = new RegExp(`(^|[;{}\\n])\\s*${flag}\\.value\\s*=\\s*false`)
  return leavingAt > callAt && leavingAt < catchAt && new RegExp(`${flag}\\.value\\s*=\\s*false`).test(fin) && !unconditional.test(fin)
}
{
  const loginViewSrc = fs.readFileSync(path.join(CLIENT_SRC, 'views', 'LoginView.vue'), 'utf8')
  report(
    /import\s*\{[^}]*\bisLeavingPage\b[^}]*\}\s*from\s*['"]\.\.\/stores\/auth(?:\.js)?['"]/.test(loginViewSrc) &&
      signInHoldsButton(loginViewSrc, 'doLogin', 'login', 'loginLoading') &&
      signInHoldsButton(loginViewSrc, 'doSetup', 'setup', 'setupLoading'),
    'FAIL  T9 LoginView must keep Sign In / Create Account disabled while a successful sign-in loads a fresh page (isLeavingPage() after the call), and re-enable it after a refused one',
  )
  const PRE_FIX_DO_LOGIN = `async function doLogin() {
  loginLoading.value = true
  try {
    await auth.login(loginForm.username, loginForm.password)
    router.push(auth.roleHome)
  } catch (err) {
    loginError.value = err.message || 'Connection failed.'
  } finally {
    loginLoading.value = false
  }
}`
  report(!signInHoldsButton(PRE_FIX_DO_LOGIN, 'doLogin', 'login', 'loginLoading'), 'FAIL  T9 does not flag the #395 doLogin(), which re-enabled the button while the fresh page loaded; the tripwire is blind')
  const ASKS_IN_FINALLY = PRE_FIX_DO_LOGIN.replace('    loginLoading.value = false', '    if (!isLeavingPage()) loginLoading.value = false')
  report(!signInHoldsButton(ASKS_IN_FINALLY, 'doLogin', 'login', 'loginLoading'), 'FAIL  T9 does not flag a doLogin() that asks only in `finally` (a refused sign-in would lock the button); the tripwire is blind')
}

// ── 4. The real store, end to end ─────────────────────────────────────────────
// Sections 1–3 cannot prove the store FOLLOWS the rules. In review, replacing the
// store's own "stay" branch and its background retry with `this._applySignedOut()`
// brought the original bounce straight back while sections 1–3 still passed. So
// client/src/stores/auth.js is imported exactly as committed, with the real Pinia
// and the real useApi, and driven through page loads against a scripted server:
//   fetch            a script of answers: JSON, an HTML error page, no network, a hang
//   setTimeout       a virtual clock the test advances: nothing waits for real, so
//                    nothing here is timing-sensitive on a loaded CI runner
//   Date.now         the same clock (the saved user's age, the epoch)
//   window/document  one sessionStorage per tab, one shared localStorage, listeners,
//                    and location.reload() / location.replace() recorded rather
//                    than performed
// Each load is a fresh module instance and a fresh Pinia with its timers and
// listeners dropped, like a browser reload; storage persists the way a tab's does.
const CLIENT_DIR = path.join(__dirname, '..', 'client')
const AUTH_URL = pathToFileURL(AUTH_PATH).href
// The file Node resolves the store's bare `import 'pinia'` to (its exports map,
// node + import + default), so the test and the store share one instance.
const PINIA_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href
// Must match the keys in stores/auth.js; a rename there fails the scenarios loudly.
const HINT_KEY = 'logisx.session.lastUser.v1'
const PENDING_KEY = 'logisx.session.pendingLogout.v1'
const EPOCH_KEY = 'logisx.session.epoch.v1'
const NOTE_KEY = 'logisx.session.signedOut.v1'

class MemStorage {
  constructor() {
    this.m = new Map()
    this.full = false // a browser store at its quota: setItem throws, removeItem still works
    this.writes = [] // every key setItem stored, in order: a value can repeat within one ms
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null
  }
  setItem(k, v) {
    if (this.full) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    this.m.set(k, String(v))
    this.writes.push(k)
  }
  removeItem(k) {
    this.m.delete(k)
  }
}

const world = {
  local: new MemStorage(),
  tabs: new Map(),
  active: null,
  listeners: { window: {}, document: {} },
  server: [],
  sent: [],
  reloads: 0,
  errors: [],
  // Requests, location.replace() and reload() calls, in the order they happened.
  log: [],
  // Each location.replace(), with the state of the page at that moment.
  replaces: [],
  store: null, // the current page's auth store
}
const tabStorage = (name) => {
  if (!world.tabs.has(name)) world.tabs.set(name, new MemStorage())
  return world.tabs.get(name)
}

const clock = { now: 0, seq: 0, timers: new Map(), requested: [] }
const T_BASE = Date.UTC(2026, 8, 23, 12, 0, 0)

// Real setImmediate is never patched: one turn flushes every pending microtask.
const drain = async () => {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve))
}
function nextTimer(limit = Infinity) {
  let best = null
  for (const t of clock.timers.values()) {
    if (t.due <= limit && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t
  }
  return best
}
async function fire(t) {
  clock.now = Math.max(clock.now, t.due)
  clock.timers.delete(t.id)
  t.fn(...t.args)
  await drain()
}
// Run the clock forward, firing everything that falls due on the way.
async function advance(ms) {
  const target = clock.now + ms
  await drain()
  for (let t = nextTimer(target); t; t = nextTimer(target)) await fire(t)
  clock.now = target
  await drain()
}
// Fire timers in order until `promise` settles: how a scenario waits on a check
// that sleeps between attempts. Bounded, so a hang fails instead of spinning.
async function settle(promise) {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true),
  )
  await drain()
  for (let i = 0; !done && i < 100; i++) {
    const t = nextTimer()
    if (!t) break
    await fire(t)
  }
  if (!done) throw new Error('never settled')
  return promise
}

function asResponse(a) {
  const status = a.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (a.text !== undefined) throw new SyntaxError(`Unexpected token '<', "${a.text.slice(0, 9)}"... is not valid JSON`)
      return a.json
    },
  }
}
const OFFLINE = Object.freeze({ offline: true })
const HANG = Object.freeze({ hang: true })
const json = (body, status = 200) => ({ status, json: body })
const html = (status) => ({ status, text: '<html><body>Bad Gateway</body></html>' })

function installShims() {
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++clock.seq
    const delay = Math.max(0, Number(ms) || 0)
    clock.requested.push(delay)
    clock.timers.set(id, { id, due: clock.now + delay, fn, args })
    return id
  }
  globalThis.clearTimeout = (id) => {
    clock.timers.delete(id)
  }
  Date.now = () => T_BASE + clock.now
  globalThis.window = {
    get localStorage() {
      return world.local
    },
    get sessionStorage() {
      return world.active
    },
    addEventListener: (type, fn) => (world.listeners.window[type] ||= []).push(fn),
    location: {
      reload: () => {
        world.reloads++
        world.log.push('reload')
      },
      // A full page load in this page's place: recorded with how the page stood
      // at that moment, never performed.
      replace: (url) => {
        world.log.push(`replace ${url}`)
        world.replaces.push({
          url: String(url),
          signedIn: !!world.store?.isAuthenticated,
          pendingLogout: world.local.getItem(PENDING_KEY) !== null,
        })
      },
    },
  }
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => (world.listeners.document[type] ||= []).push(fn),
  }
  // An answer nobody scripted is "no signal", never a made-up success.
  globalThis.fetch = (url, opts = {}) => {
    world.sent.push(`${opts.method || 'GET'} ${url}`)
    world.log.push(`${opts.method || 'GET'} ${url}`)
    const a = world.server.length ? world.server.shift() : OFFLINE
    if (a.offline) return Promise.reject(new TypeError('Failed to fetch'))
    if (a.hang) {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
      })
    }
    if (a.defer) {
      return new Promise((resolve) => {
        a.release = (answer) => resolve(asResponse(answer))
      })
    }
    return Promise.resolve(asResponse(a))
  }
  process.on('unhandledRejection', (err) => world.errors.push(err))
}

function resetWorld() {
  world.local = new MemStorage()
  world.tabs = new Map()
  world.active = null
  world.listeners = { window: {}, document: {} }
  world.server = []
  world.sent = []
  world.reloads = 0
  world.errors = []
  world.log = []
  world.replaces = []
  world.store = null
  clock.timers.clear()
  clock.requested = []
  clock.now += HOUR // keeps Date.now moving forward across scenarios
}

let loadSeq = 0
let piniaModule = null
async function pageLoad(source, tabName) {
  world.active = tabStorage(tabName)
  clock.timers.clear() // a reload ends every timer (scenarios keep one live tab at a time)
  world.listeners = { window: {}, document: {} }
  const mod = await import(source(++loadSeq))
  const store = mod.useAuthStore(piniaModule.createPinia())
  world.store = store
  let rerouted = 0
  mod.onSessionResolved(() => rerouted++)
  // leaving(): what the router's guard reads (isLeavingPage) on this page.
  return { store, rerouted: () => rerouted, leaving: () => mod.isLeavingPage() }
}

function makeCtx(source, expect) {
  return {
    expect,
    load: (tabName) => pageLoad(source, tabName),
    answer: (...answers) => world.server.push(...answers),
    dropAnswers: () => {
      world.server = []
    },
    fillStorage: (tabName) => {
      tabStorage(tabName).full = true
    },
    sent: () => {
      const s = world.sent
      world.sent = []
      return s
    },
    requested: () => {
      const r = clock.requested
      clock.requested = []
      return r
    },
    saved: (tabName) => {
      const raw = tabStorage(tabName).getItem(HINT_KEY)
      return raw ? JSON.parse(raw).user : null
    },
    // The saved copy exactly as stored: unchanged means nothing rewrote it.
    savedRaw: (tabName) => tabStorage(tabName).getItem(HINT_KEY),
    local: (key) => world.local.getItem(key),
    reloads: () => world.reloads,
    // Everything since the last call, in order: requests, location.replace(), reload().
    log: () => {
      const l = world.log
      world.log = []
      return l
    },
    replaces: () => {
      const r = world.replaces
      world.replaces = []
      return r
    },
    fireOnline: async () => {
      for (const fn of world.listeners.window.online || []) fn()
      await drain()
    },
    // `persisted: true` is a page the browser restored from its back/forward cache.
    firePageshow: async (persisted) => {
      for (const fn of world.listeners.window.pageshow || []) fn({ type: 'pageshow', persisted })
      await drain()
    },
    listeners: (type) => (world.listeners.window[type] || []).length,
    // What ANOTHER tab of this browser writes to the shared localStorage, as
    // [key, value] pairs (null removes). The browser tells this tab with one
    // `storage` event per write, never the tab that wrote; they arrive here back
    // to back, before any request the first one starts is answered, as they would.
    otherTab: async (...writes) => {
      const events = []
      for (const [key, value] of writes) {
        if (value == null) world.local.removeItem(key)
        else world.local.setItem(key, value)
        events.push({ key, newValue: value == null ? null : String(value), storageArea: world.local })
      }
      for (const event of events) for (const fn of world.listeners.window.storage || []) fn(event)
      await drain()
    },
    // This tab's signed-out note (the fresh /login page skips its check on it).
    note: (tabName) => tabStorage(tabName).getItem(NOTE_KEY),
    // How many times the epoch has been stamped in this scenario, by any tab.
    epochStamps: () => world.local.writes.filter((k) => k === EPOCH_KEY).length,
    advance,
    settle,
  }
}
// What another tab's logout() writes before its request goes out, and what its
// sign-in writes (the pending record, if any, is removed after the stamp).
const pendingRecord = () => JSON.stringify({ v: 1, at: Date.now() })
const epochStamp = () => String(Date.now())

async function signedIn(c, tabName, user = DRIVER) {
  c.answer(json({ authenticated: true, user }))
  const p = await c.load(tabName)
  await c.settle(p.store.checkSession())
  return p
}
const lastOf = (list) => list[list.length - 1]

// What POST /api/auth/logout answers: [label, answer, did the server confirm it?]
const SIGN_OUT_ANSWERS = [
  ['the server confirms it', json({ success: true }), true],
  ['no signal', OFFLINE, false],
  ['a 502 page', html(502), false],
]

// The path a record kept in one place would miss. A page load puts user A on
// screen from this tab's saved copy: the offline "stay" branch assigns this.user
// DIRECTLY, not through _applyAuthenticated(). Then the background check gets a
// definitive answer (`endAnswer`) and _applySignedOut() clears this.user before
// anyone signs in, so a sign-in that compared against this.user, or a record kept
// only in _applyAuthenticated(), would see nobody. Returns that page on the login
// screen, log cleared.
async function restoredFromSavedCopyThenSignedOut(c, endAnswer) {
  await signedIn(c, 'A')
  const savedBefore = c.savedRaw('A')
  await c.advance(60_000)
  c.sent()
  c.answer(OFFLINE, OFFLINE)
  const p = await c.load('A')
  await c.settle(p.store.checkSession())
  c.expect(
    '(before) A is on screen from the saved copy: both session checks on this page failed, reconnecting',
    p.store.user?.id === DRIVER.id && p.store.isReconnecting && c.sent().join() === 'GET /api/auth/session,GET /api/auth/session',
  )
  c.expect(
    '(before) …and not through _applyAuthenticated(): the saved copy is byte-for-byte unchanged (only a server answer may refresh it)',
    savedBefore !== null && c.savedRaw('A') === savedBefore,
  )
  c.answer(endAnswer)
  await c.advance(2000)
  c.expect(
    '(before) the background check ends the session: _applySignedOut() cleared this.user, the guard goes to /login',
    !p.store.isAuthenticated && p.store.user === null && !p.store.isReconnecting && p.rerouted() === 1,
  )
  c.log()
  return p
}

// Both definitive answers reach _applySignedOut().
const SESSION_END_ANSWERS = [
  ['authenticated:false', json(SIGNED_OUT)],
  ['a 401', json({ error: 'Not authenticated' }, 401)],
]

const STORE_SCENARIOS = [
  ['online, signed in', async (c) => {
    const p = await signedIn(c, 'A')
    c.expect('signed in, not reconnecting, not loading', p.store.isAuthenticated && !p.store.isReconnecting && !p.store.isLoading)
    c.expect("the user in memory is the server's, email and all", p.store.user?.email === DRIVER.email)
    c.expect('saved for this tab, without the email', c.saved('A')?.driverName === 'Dwayne Jones' && !('email' in (c.saved('A') || {})))
    c.expect('one request, with the short foreground timeout', c.sent().length === 1 && c.requested().includes(real.FOREGROUND.timeoutMs))
  }],
  ['the production bounce: a known driver reloads with no signal', async (c) => {
    await signedIn(c, 'A')
    await c.advance(60_000)
    c.sent()
    c.requested()
    c.answer(OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('STILL SIGNED IN, not sent to /login', p.store.isAuthenticated)
    c.expect('marked reconnecting', p.store.isReconnecting)
    c.expect('the saved driver is the one shown, and home is /driver', p.store.user?.driverName === 'Dwayne Jones' && p.store.roleHome === '/driver')
    c.expect('two attempts, 1 s apart', c.sent().length === 2 && c.requested().filter((ms) => ms === 1000).length === 1)
  }],
  ['background silence backs off and never signs out', async (c) => {
    await signedIn(c, 'A')
    await c.advance(60_000)
    c.answer(OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.requested()
    c.answer(OFFLINE)
    await c.advance(2000)
    c.expect('after 1 silent background check: still signed in, reconnecting', p.store.isAuthenticated && p.store.isReconnecting)
    c.expect('…the next check is 4 s out', lastOf(c.requested()) === 4000)
    c.answer(OFFLINE)
    await c.advance(4000)
    c.expect('after 2: still signed in, reconnecting', p.store.isAuthenticated && p.store.isReconnecting)
    c.expect('…the next check is 8 s out', lastOf(c.requested()) === 8000)
    c.answer(json(SIGNED_IN))
    await c.advance(8000)
    c.expect('an answer settles it: signed in, no longer reconnecting', p.store.isAuthenticated && !p.store.isReconnecting)
    c.expect('the same person: no reroute, no reload', p.rerouted() === 0 && c.reloads() === 0)
  }],
  ['a deploy restart (502 pages), then the session turns out to be gone', async (c) => {
    await signedIn(c, 'A')
    await c.advance(60_000)
    c.answer(html(502), html(502))
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('502s are not a sign-out: still in the app, reconnecting', p.store.isAuthenticated && p.store.isReconnecting)
    c.answer(json(SIGNED_OUT))
    await c.advance(2000)
    c.expect('authenticated:false is: signed out, no longer reconnecting', !p.store.isAuthenticated && p.store.user === null && !p.store.isReconnecting)
    c.expect('the guard re-runs once (to /login)', p.rerouted() === 1 && c.reloads() === 0)
    c.expect('the saved user is gone and the epoch is stamped', c.saved('A') === null && c.local(EPOCH_KEY) !== null)
  }],
  ['nobody known and no signal: the login page, then the valid cookie signs them in', async (c) => {
    c.answer(OFFLINE, OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('login page (not signed in), still checking', !p.store.isAuthenticated && p.store.isReconnecting)
    const requested = c.requested()
    c.expect('three attempts, after 1 s and 2 s', c.sent().length === 3 && requested.includes(1000) && requested.includes(2000))
    c.answer(json(SIGNED_IN))
    await c.advance(2000)
    c.expect('signed in with no password typed, guard re-run once, no reload', p.store.isAuthenticated && p.rerouted() === 1 && c.reloads() === 0)
  }],
  ['a real 401 still signs out at once', async (c) => {
    await signedIn(c, 'A')
    c.sent()
    c.answer(json({ error: 'Not authenticated' }, 401))
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('signed out after ONE request: no retry, no reconnect', !p.store.isAuthenticated && !p.store.isReconnecting && c.sent().length === 1)
    c.expect('the saved user is gone', c.saved('A') === null)
  }],
  ['an unreadable 200 (a proxy page) is not a sign-out', async (c) => {
    await signedIn(c, 'A')
    c.answer(html(200), html(200))
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('still in the app, reconnecting', p.store.isAuthenticated && p.store.isReconnecting)
  }],
  ['a hung request times out at 6 s and the retry answers', async (c) => {
    c.answer(HANG, json(SIGNED_IN))
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('signed in on attempt 2', p.store.isAuthenticated && !p.store.isReconnecting && c.sent().length === 2)
  }],
  ['a logout with no signal is finished on a later load', async (c) => {
    const first = await signedIn(c, 'A')
    c.sent()
    c.answer(OFFLINE)
    await c.settle(first.store.logout())
    c.expect('signed out locally anyway', !first.store.isAuthenticated && first.store.user === null)
    c.expect('pending record kept, saved user gone, epoch stamped', c.local(PENDING_KEY) !== null && c.saved('A') === null && c.local(EPOCH_KEY) !== null)
    c.sent()
    c.answer(OFFLINE)
    let p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('reload, still no signal: signed out, no reconnect loop', !p.store.isAuthenticated && !p.store.isReconnecting)
    c.expect('…it tried the logout and kept the record', c.sent().join() === 'POST /api/auth/logout' && c.local(PENDING_KEY) !== null)
    c.answer(json({ success: true }), json(SIGNED_IN))
    p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('reload online: the logout goes first and the cookie is never trusted', c.sent().join() === 'POST /api/auth/logout' && !p.store.isAuthenticated)
    c.expect('…and the record is cleared', c.local(PENDING_KEY) === null)
  }],
  ['a logout online leaves no pending record', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    c.expect('no record, signed out', c.local(PENDING_KEY) === null && !p.store.isAuthenticated)
  }],
  ['a fresh login supersedes an unfinished logout', async (c) => {
    world.local.setItem(PENDING_KEY, JSON.stringify({ v: 1, at: Date.now() }))
    c.answer(json({ success: true, user: DRIVER }))
    const p = await c.load('A')
    await c.settle(p.store.login('d.jones', 'x'))
    c.expect('record cleared, user saved, signed in', c.local(PENDING_KEY) === null && c.saved('A') !== null && p.store.isAuthenticated)
  }],
  ['the browser "online" event re-checks at once', async (c) => {
    await signedIn(c, 'A')
    c.answer(OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.sent()
    c.answer(json(SIGNED_IN))
    await c.fireOnline()
    c.expect('one request on "online", and it settled', c.sent().length === 1 && !p.store.isReconnecting)
  }],
  ['a late background answer never overrides a fresh login', async (c) => {
    c.answer(OFFLINE, OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    const late = { defer: true }
    c.answer(late)
    await c.fireOnline()
    c.answer(json({ success: true, user: OTHER }))
    await c.settle(p.store.login('amir', 'x'))
    late.release(json(SIGNED_OUT))
    await c.advance(0)
    c.expect('still signed in as the NEW user', p.store.isAuthenticated && p.store.user?.id === OTHER.id)
    c.expect('…no reroute, no reload', p.rerouted() === 0 && c.reloads() === 0)
  }],
  ['setup(): the client-built fallback user is never saved', async (c) => {
    c.answer(json({ success: true, role: 'Super Admin' }))
    const p = await c.load('A')
    await c.settle(p.store.setup('admin', 'pw', 'a@b.c'))
    c.expect('signed in as before, nothing saved', p.store.isAuthenticated && p.store.user?.role === 'Super Admin' && c.saved('A') === null)
  }],
  // Review finding 2: the saved copy after a password change.
  ['a new driver changes the temporary password, then reloads with no signal', async (c) => {
    const p = await signedIn(c, 'A', { ...DRIVER, mustChangePassword: true })
    c.expect('(before) the saved copy says mustChangePassword', c.saved('A')?.mustChangePassword === true)
    // ChangePasswordView: POST /api/auth/change-password answered 200, then:
    c.answer(json(SIGNED_IN))
    await c.settle(p.store.afterPasswordChange())
    c.expect("memory and the saved copy both come from the server's answer", p.store.user?.mustChangePassword === false && c.saved('A')?.mustChangePassword === false)
    await c.advance(60_000)
    c.answer(OFFLINE, OFFLINE)
    const r = await c.load('A')
    await c.settle(r.store.checkSession())
    c.expect('reload with no signal: in the app, NOT pinned to /account/change-password', r.store.isAuthenticated && r.store.user?.mustChangePassword === false)
  }],
  ['…and when re-reading the user after the change gets no answer', async (c) => {
    const p = await signedIn(c, 'A', { ...DRIVER, mustChangePassword: true })
    c.answer(OFFLINE)
    await c.settle(p.store.afterPasswordChange())
    c.expect('memory follows the 200, so they can leave the page', p.store.isAuthenticated && p.store.user?.mustChangePassword === false)
    c.expect('the stale saved copy is dropped, not edited', c.saved('A') === null)
    c.expect('…and a background check is running', p.store.isReconnecting)
    c.answer(json(SIGNED_IN))
    await c.advance(2000)
    c.expect("the background check saves the server's answer", c.saved('A')?.mustChangePassword === false && !p.store.isReconnecting)
  }],
  ['…and when re-reading the user after the change says the session is gone', async (c) => {
    const p = await signedIn(c, 'A', { ...DRIVER, mustChangePassword: true })
    c.answer(json(SIGNED_OUT))
    await c.settle(p.store.afterPasswordChange())
    c.expect('authenticated:false signs them out: no user, not signed in', !p.store.isAuthenticated && p.store.user === null)
    c.expect('…with no background check left running', !p.store.isReconnecting)
    c.expect('…the saved user gone and the epoch stamped', c.saved('A') === null && c.local(EPOCH_KEY) !== null)
  }],
  // Review finding 3: the saved user versus other tabs and the cookie's owner.
  ['another tab logs out: this tab never restores that user', async (c) => {
    await signedIn(c, 'A')
    await c.advance(1000)
    const b = await signedIn(c, 'B')
    c.answer(json({ success: true }))
    await c.settle(b.store.logout())
    await c.advance(1000)
    c.answer(OFFLINE, OFFLINE, OFFLINE)
    const a = await c.load('A')
    await c.settle(a.store.checkSession())
    c.expect("tab A's offline reload shows the login page, not the logged-out user", !a.store.isAuthenticated && a.store.user === null)
  }],
  ['another tab signs someone else in: a 502 here does not show the old user', async (c) => {
    await signedIn(c, 'A')
    await c.advance(1000)
    const b = await c.load('B')
    c.answer(json({ success: true, user: OTHER }))
    await c.settle(b.store.login('amir', 'x'))
    await c.advance(1000)
    c.answer(html(502), html(502), html(502))
    const a = await c.load('A')
    await c.settle(a.store.checkSession())
    c.expect('the login page, not the previous user', !a.store.isAuthenticated && a.store.user === null)
    c.answer(json({ authenticated: true, user: OTHER }))
    await c.advance(2000)
    c.expect("the background check brings in the cookie's owner (a reroute, not a reload)", a.store.user?.id === OTHER.id && a.rerouted() === 1 && c.reloads() === 0)
  }],
  ['a background answer naming someone else reloads the page', async (c) => {
    await signedIn(c, 'A')
    await c.advance(60_000)
    c.answer(OFFLINE, OFFLINE)
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.expect('(before) showing the saved driver, reconnecting', p.store.user?.id === DRIVER.id && p.store.isReconnecting)
    c.answer(json({ authenticated: true, user: OTHER }))
    await c.advance(2000)
    c.expect('a full reload, not an in-place patch', c.reloads() === 1 && p.rerouted() === 0)
    c.expect("the reload starts from the server's user", c.saved('A')?.id === OTHER.id)
  }],
  // Second review: when saving the new user fails, the old one must not stay saved,
  // or every reload restores them and the background answer reloads the page again.
  ['a full sessionStorage cannot turn a new user into a reload loop', async (c) => {
    await signedIn(c, 'A')
    await c.advance(60_000)
    c.fillStorage('A')
    let p = null
    for (let cycle = 0; cycle < 5; cycle++) {
      const before = c.reloads()
      c.answer(HANG, HANG, HANG) // the first check keeps timing out at 6 s…
      p = await c.load('A')
      await c.settle(p.store.checkSession())
      c.dropAnswers()
      c.answer(json({ authenticated: true, user: OTHER })) // …and the background one answers
      await c.advance(2000)
      if (c.reloads() === before) break // no reload this time: the page has settled
    }
    c.expect('at most one reload, not one per cycle', c.reloads() <= 1)
    c.expect("…and the tab settles on the server's user", p.store.isAuthenticated && p.store.user?.id === OTHER.id)
  }],
  // A fresh page: sign-out always loads one; a sign-in loads one when the page has
  // shown someone else. The router reads leaving() to open no signed-in screen.
  // Confirmed: a fresh /login. Not confirmed: that load would be the browser's
  // own "no connection" page or the proxy's error page, so the app's own login
  // screen instead (the callers' router.replace('/login')), in this page.
  ...SIGN_OUT_ANSWERS.map(([label, answer, confirmed]) => [`sign-out: ${label}`, async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(answer)
    await c.settle(p.store.logout())
    if (confirmed) {
      c.expect("the POST, then exactly one location.replace('/login'), and no reload", c.log().join() === 'POST /api/auth/logout,replace /login')
      const [r] = c.replaces()
      c.expect('signed out here before the page is replaced', r?.signedIn === false && p.store.user === null)
      c.expect('…with the pending-logout record already cleared', r?.pendingLogout === false)
      c.expect('…and a signed-out note left for the fresh page', c.note('A') !== null)
    } else {
      c.expect("the POST alone: NO location.replace (it would load the browser's error page), no reload", c.log().join() === 'POST /api/auth/logout')
      c.expect('signed out here all the same: no user, not signed in, nothing running', p.store.user === null && !p.store.isAuthenticated && !p.store.isReconnecting)
      c.expect('…the pending-logout record kept for the next load, and no note (nothing was confirmed)', c.local(PENDING_KEY) !== null && c.note('A') === null)
    }
    c.expect('…and the page reports it is leaving', p.leaving() === true)
  }]),
  ['an unconfirmed sign-out: the next sign-in on the app\'s own login screen loads a fresh page', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(OFFLINE)
    await c.settle(p.store.logout())
    c.log()
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.login('d.jones', 'x'))
    c.expect('even the same person: the POST, then one location.replace of their home', c.log().join() === 'POST /api/auth/login,replace /driver')
    c.expect('…and that sign-in supersedes the unfinished logout', c.local(PENDING_KEY) === null && p.store.isAuthenticated)
  }],
  ['a signed-out page restored from the back/forward cache reloads', async (c) => {
    const p = await signedIn(c, 'A')
    await c.firePageshow(true)
    c.expect('(before) a page that has not asked to leave ignores a restore', c.reloads() === 0 && p.leaving() === false)
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    await c.firePageshow(false)
    c.expect('an ordinary page show does nothing', c.reloads() === 0)
    await c.firePageshow(true)
    c.expect('restored from the cache: reloaded, once', c.reloads() === 1)
  }],
  ['a page that asks for a fresh page twice listens for a cache restore once', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    // Its load was stopped, so it is still here, and a sign-in asks again.
    c.answer(json({ success: true, user: OTHER }))
    await c.settle(p.store.login('amir', 'x'))
    c.expect('(before) two fresh pages were asked for', c.replaces().length === 2)
    c.expect('one pageshow listener, not one per request', c.listeners('pageshow') === 1)
    await c.firePageshow(true)
    c.expect('restored from the cache: reloaded once, not twice', c.reloads() === 1)
  }],
  // The fresh /login a confirmed sign-out loads does not ask the server again.
  ['a confirmed sign-out: the fresh /login page asks nothing', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    const stamps = c.epochStamps()
    c.sent()
    c.answer(json(SIGNED_IN)) // it would be accepted, were it asked for
    const q = await c.load('A')
    await c.settle(q.store.checkSession())
    c.expect('the login page at once: not one request', c.sent().length === 0 && !q.store.isAuthenticated && q.store.user === null)
    c.expect('…no background loop', !q.store.isReconnecting)
    c.expect('…the note is gone, and the epoch is not stamped again', c.note('A') === null && c.epochStamps() === stamps)
    c.dropAnswers()
    c.answer(OFFLINE, OFFLINE, OFFLINE)
    const r = await c.load('A')
    await c.settle(r.store.checkSession())
    c.expect('the next load (the note spent) asks as usual', c.sent().length === 3)
  }],
  ['the signed-out note never outranks a pending logout', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    world.local.setItem(PENDING_KEY, pendingRecord()) // another tab's logout, never sent
    c.sent()
    c.answer(json({ success: true }))
    const q = await c.load('A')
    await c.settle(q.store.checkSession())
    c.expect('the unfinished logout is sent first', c.sent().join() === 'POST /api/auth/logout' && c.local(PENDING_KEY) === null)
    c.expect('…signed out, and the note spent all the same', !q.store.isAuthenticated && c.note('A') === null)
  }],
  ['a signed-out note past its TTL gets the ordinary check', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    await c.advance(real.SIGNED_OUT_NOTE_TTL_MS + 1)
    c.sent()
    c.answer(json(SIGNED_OUT))
    const q = await c.load('A')
    await c.settle(q.store.checkSession())
    c.expect('the session is asked', c.sent().join() === 'GET /api/auth/session' && !q.store.isAuthenticated)
  }],
  ['a signed-out note from before another tab\'s sign-in gets the ordinary check', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    await c.advance(1000)
    world.local.setItem(EPOCH_KEY, epochStamp()) // another tab signs someone in
    c.sent()
    c.answer(json({ authenticated: true, user: OTHER }))
    const q = await c.load('A')
    await c.settle(q.store.checkSession())
    c.expect("the session is asked, and the cookie's new owner is found", c.sent().join() === 'GET /api/auth/session' && q.store.user?.id === OTHER.id)
  }],
  ['the page showed a driver: a sign-in as someone else loads a fresh page at their home', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(json({ success: true, user: OTHER }))
    const returned = await c.settle(p.store.login('amir', 'x'))
    c.expect("the POST, then one location.replace of the Dispatcher's home", c.log().join() === 'POST /api/auth/login,replace /dashboard')
    c.expect("login() still returns the server's user, and the store holds it", returned?.id === OTHER.id && p.store.user?.id === OTHER.id && p.store.isAuthenticated)
    c.expect('…and the page reports it is leaving', p.leaving() === true)
  }],
  ['the page showed a driver: the same driver signing in again navigates in-app', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(json({ success: true, user: DRIVER }))
    const returned = await c.settle(p.store.login('d.jones', 'x'))
    c.expect('the POST alone: no location.replace, no reload', c.log().join() === 'POST /api/auth/login' && p.leaving() === false)
    c.expect("login() returns the server's user", returned?.id === DRIVER.id)
  }],
  ['a first sign-in on a fresh page navigates in-app', async (c) => {
    c.answer(json(SIGNED_OUT))
    const p = await c.load('A')
    await c.settle(p.store.checkSession())
    c.log()
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.login('d.jones', 'x'))
    c.expect('signed in; the POST alone, no location.replace', p.store.isAuthenticated && c.log().join() === 'POST /api/auth/login' && p.leaving() === false)
  }],
  // A restored from the saved copy, then _applySignedOut(): the record still knows A.
  ...SESSION_END_ANSWERS.flatMap(([how, endAnswer]) => [
    [`A restored from the saved copy, signed out by ${how}: B signing in loads B's home`, async (c) => {
      const p = await restoredFromSavedCopyThenSignedOut(c, endAnswer)
      c.answer(json({ success: true, user: OTHER }))
      const returned = await c.settle(p.store.login('amir', 'x'))
      c.expect("the POST, then one location.replace of B's home (/dashboard, not A's /driver)", c.log().join() === 'POST /api/auth/login,replace /dashboard')
      c.expect('login() still returns B, and the store holds B', returned?.id === OTHER.id && p.store.user?.id === OTHER.id && p.store.isAuthenticated)
    }],
    [`A restored from the saved copy, signed out by ${how}: A signing back in stays in-app (control)`, async (c) => {
      const p = await restoredFromSavedCopyThenSignedOut(c, endAnswer)
      c.answer(json({ success: true, user: DRIVER }))
      await c.settle(p.store.login('d.jones', 'x'))
      c.expect('the POST alone: no location.replace, not leaving', c.log().join() === 'POST /api/auth/login' && p.leaving() === false)
    }],
  ]),
  ['A restored from the saved copy, then signed out: setup() decides like login()', async (c) => {
    let p = await restoredFromSavedCopyThenSignedOut(c, json(SIGNED_OUT))
    c.answer(json({ success: true, role: 'Super Admin' }))
    await c.settle(p.store.setup('admin', 'pw', 'a@b.c'))
    c.expect("someone else: the POST, then one location.replace of the new admin's home", c.log().join() === 'POST /api/auth/setup,replace /dashboard')
    p = await restoredFromSavedCopyThenSignedOut(c, json(SIGNED_OUT))
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.setup('d.jones', 'pw', ''))
    c.expect('A again (control): the POST alone, no location.replace', c.log().join() === 'POST /api/auth/setup' && p.leaving() === false)
  }],
  ['a page still here after asking for a fresh one (its load was stopped): any sign-in loads one', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ success: true }))
    await c.settle(p.store.logout())
    c.log()
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.login('d.jones', 'x'))
    c.expect('even the same person: the POST, then a fresh page at their home', c.log().join() === 'POST /api/auth/login,replace /driver')
  }],
  ['setup() decides like login()', async (c) => {
    let p = await c.load('A')
    c.answer(json({ success: true, role: 'Super Admin' }))
    await c.settle(p.store.setup('admin', 'pw', 'a@b.c'))
    c.expect('a first sign-in on a fresh page: no location.replace', p.store.isAuthenticated && c.replaces().length === 0)
    p = await signedIn(c, 'A')
    c.answer(json({ success: true, role: 'Super Admin' }))
    const returned = await c.settle(p.store.setup('admin', 'pw', 'a@b.c'))
    c.expect("after the driver, the new admin: one location.replace of their home", c.replaces().map((r) => r.url).join() === '/dashboard')
    c.expect('setup() still returns the signed-in user', returned?.username === 'admin' && returned?.role === 'Super Admin')
    p = await signedIn(c, 'A')
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.setup('d.jones', 'pw', ''))
    c.expect('the same person again: no location.replace', c.replaces().length === 0 && p.leaving() === false)
  }],
  // Other tabs. This tab shows the driver; another tab of the same browser (the
  // same cookie) signs someone in or out, and this one hears it as `storage` events.
  ...[
    ['the server has already ended it', json(SIGNED_OUT)],
    // The race: the record and the epoch are written BEFORE the other tab's
    // request, so the session can still be alive when this tab asks.
    ['the server still says signed in (the race)', json(SIGNED_IN)],
  ].map(([how, answer]) => [`another tab starts a logout, ${how}: this tab signs out, onto a fresh /login`, async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(answer, answer)
    const stamps = c.epochStamps()
    await c.otherTab([PENDING_KEY, pendingRecord()], [EPOCH_KEY, epochStamp()])
    c.expect('signed out here: nobody shown, not signed in, nothing running', p.store.user === null && !p.store.isAuthenticated && !p.store.isReconnecting)
    c.expect("one question per event, then one location.replace('/login') (the app answered)", c.log().join() === 'GET /api/auth/session,GET /api/auth/session,replace /login')
    c.expect("…and the app's own login screen meanwhile: the guard re-runs once", p.rerouted() === 1 && p.leaving() === true)
    c.expect('the epoch is stamped once, by the other tab: a second stamp here would send every other tab round again', c.epochStamps() === stamps + 1)
    c.expect("the other tab's logout record is left to that tab", c.local(PENDING_KEY) !== null)
    c.expect('the saved user is gone, and nothing reloads', c.saved('A') === null && c.reloads() === 0)
  }]),
  ['another tab\'s logout is confirmed before this tab\'s answer arrives: it still signs out', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    const held = { defer: true }
    c.answer(json(SIGNED_IN), held) // the second question reached the server before the logout did
    await c.otherTab([PENDING_KEY, pendingRecord()], [EPOCH_KEY, epochStamp()])
    await c.otherTab([PENDING_KEY, null]) // that tab's logout is confirmed; its record goes
    c.expect('(before) still showing the driver while the answer is out', p.store.user?.id === DRIVER.id)
    held.release(json(SIGNED_IN))
    await c.advance(0)
    c.expect('signed out: the record was there when the change was heard', p.store.user === null && !p.store.isAuthenticated)
    c.expect("…onto a fresh /login", c.replaces().map((r) => r.url).join() === '/login')
  }],
  ['another tab signs out with no signal, and this tab has none either: the app\'s own login screen', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(OFFLINE, OFFLINE)
    await c.otherTab([PENDING_KEY, pendingRecord()], [EPOCH_KEY, epochStamp()])
    c.expect('signed out here', p.store.user === null && !p.store.isAuthenticated)
    c.expect("NO location.replace (it would load the browser's error page)", c.replaces().length === 0 && c.reloads() === 0)
    c.expect('…the guard re-runs to /login instead, and the page is leaving (the next sign-in loads a fresh one)', p.rerouted() === 1 && p.leaving() === true)
  }],
  ['another tab signs someone in and this tab gets no answer: the safe side, the app\'s own login screen', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(OFFLINE)
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('one question, no answer', c.log().join() === 'GET /api/auth/session')
    c.expect('the driver is no longer shown: nothing proves the cookie is still theirs', p.store.user === null && !p.store.isAuthenticated)
    c.expect('in-app: no location.replace, the guard re-runs, the page is leaving', c.replaces().length === 0 && p.rerouted() === 1 && p.leaving() === true)
    c.log()
    c.answer(json({ success: true, user: DRIVER }))
    await c.settle(p.store.login('d.jones', 'x'))
    c.expect('the next sign-in, the same person included, loads a fresh page', c.log().join() === 'POST /api/auth/login,replace /driver')
  }],
  ['another tab signs someone else in: this tab reloads, from them', async (c) => {
    const p = await signedIn(c, 'A')
    c.log()
    c.answer(json({ authenticated: true, user: OTHER }))
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('one question, then one reload', c.log().join() === 'GET /api/auth/session,reload' && c.reloads() === 1)
    c.expect('the reload starts from the new person', c.saved('A')?.id === OTHER.id && p.store.user?.id === OTHER.id)
    c.expect('not a replace, not a reroute', c.replaces().length === 0 && p.rerouted() === 0)
  }],
  ['another tab signs the same person in again: this page stays', async (c) => {
    const p = await signedIn(c, 'A')
    await c.advance(1000)
    c.log()
    c.answer(json(SIGNED_IN))
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('one question, and nothing else: no reload, no replace, no reroute', c.log().join() === 'GET /api/auth/session' && p.rerouted() === 0 && p.leaving() === false)
    c.expect('the driver is still shown, signed in', p.store.user?.id === DRIVER.id && p.store.isAuthenticated)
    await c.advance(60_000)
    c.answer(OFFLINE, OFFLINE)
    const r = await c.load('A')
    await c.settle(r.store.checkSession())
    c.expect('saved again after the epoch: a reload with no signal still restores the driver', r.store.isAuthenticated && r.store.user?.id === DRIVER.id)
  }],
  ['another tab signs in the same person with a new role: this page re-runs its guard', async (c) => {
    const p = await signedIn(c, 'A')
    c.answer(json({ authenticated: true, user: { ...DRIVER, role: 'Dispatcher' } }))
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('kept, with the new role, and the guard re-run once', p.store.user?.role === 'Dispatcher' && p.rerouted() === 1 && c.reloads() === 0)
  }],
  ['a page with nobody on screen, or one signing out itself, leaves other tabs\' changes alone', async (c) => {
    let p = await restoredFromSavedCopyThenSignedOut(c, json(SIGNED_OUT))
    c.sent()
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('the login page (nobody shown): nothing is asked', c.sent().length === 0)
    p = await signedIn(c, 'A')
    c.sent()
    const held = { defer: true }
    c.answer(held)
    const leaving = p.store.logout()
    await c.otherTab([EPOCH_KEY, epochStamp()])
    c.expect('mid-logout: only the logout is sent', c.sent().join() === 'POST /api/auth/logout')
    held.release(json({ success: true }))
    await c.settle(leaving)
    c.expect("…and it alone decides the page: one location.replace('/login')", c.replaces().map((r) => r.url).join() === '/login')
  }],
  ['a logout record being removed, or an unrelated key, is not a change of owner', async (c) => {
    await signedIn(c, 'A')
    world.local.setItem(PENDING_KEY, pendingRecord())
    c.sent()
    await c.otherTab([PENDING_KEY, null])
    await c.otherTab(['logisx.formDraft.v1', '{}'])
    c.expect('nothing is asked', c.sent().length === 0)
  }],
]

async function runStoreScenarios(source) {
  const results = []
  for (const [name, run] of STORE_SCENARIOS) {
    resetWorld()
    const expect = (label, ok) => results.push({ label: `store: ${name}: ${label}`, ok: !!ok })
    try {
      await run(makeCtx(source, expect))
    } catch (err) {
      results.push({ label: `store: ${name}: threw ${err && err.stack}`, ok: false })
    }
    await drain()
    for (const err of world.errors) results.push({ label: `store: ${name}: unhandled rejection ${err && err.stack}`, ok: false })
  }
  return results
}

// Store mutants: the text of stores/auth.js with one change, loaded from a data:
// URL. Each must fail at least one scenario. A mutation whose target text is gone
// fails too ("could not be built"), so a refactor has to carry these along.
function asDataModule(src) {
  let unresolved = null
  const out = src.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    if (spec === 'pinia') return pre + q + PINIA_URL + q
    if (spec.startsWith('./') || spec.startsWith('../')) return pre + q + new URL(spec, AUTH_URL).href + q
    unresolved = spec
    return m
  })
  if (unresolved) return null
  return (n) => 'data:text/javascript;base64,' + Buffer.from(`${out}\n// load ${n}\n`, 'utf8').toString('base64')
}
function replaceOnce(src, pattern, replacement) {
  const all = src.match(new RegExp(pattern.source, 'g'))
  if (!all || all.length !== 1) return null
  return src.replace(pattern, () => replacement)
}
function replaceMethodBody(src, name, body) {
  const at = src.search(new RegExp(`async\\s+${name}\\s*\\(`))
  if (at < 0) return null
  const open = src.indexOf('{', at)
  const inner = blockFrom(src, open)
  return src.slice(0, open + 1) + body + src.slice(open + 1 + inner.length)
}
// replaceOnce, inside the body of async method `name` only (login() and setup()
// share lines, so a file-wide replaceOnce could not target either one).
function replaceInMethod(src, name, pattern, replacement) {
  const at = src.search(new RegExp(`async\\s+${name}\\s*\\(`))
  if (at < 0) return null
  const open = src.indexOf('{', at)
  const inner = blockFrom(src, open)
  const changed = replaceOnce(inner, pattern, replacement)
  if (changed === null) return null
  return src.slice(0, open + 1) + changed + src.slice(open + 1 + inner.length)
}
const STORE_MUTANTS = [
  ['SM1 (review) the known-user "stay" branch signs out instead',
    (s) => replaceOnce(s, /case ACTION\.STAY:[\s\S]*?\n\s*break\n/, 'case ACTION.STAY:\n          this._applySignedOut()\n          break\n')],
  ['SM2 (review) a silent background check signs out instead of retrying',
    (s) => replaceOnce(s, /this\._scheduleReconnect\(step\.delayMs\)/, 'this._applySignedOut()')],
  ['SM3 the saved user read without the epoch',
    (s) => replaceOnce(s, /notBeforeMs: parseSessionEpoch\(readKey\('local', EPOCH_KEY\)\)/, 'notBeforeMs: 0')],
  ['SM4 a different person on screen patched in place, not reloaded',
    (s) => replaceOnce(s, /if \(effect === EFFECT\.RELOAD\) reloadPage\(\)/, 'if (effect === EFFECT.RELOAD) notifyResolved()')],
  ['SM5 afterPasswordChange() back to the old local edit',
    (s) => replaceMethodBody(s, 'afterPasswordChange', '\n      if (this.user) this.user = { ...this.user, mustChangePassword: false }\n    ')],
  ['SM6 (second review) a failed save leaves the previous user saved',
    (s) => replaceOnce(
      s,
      /if \(persist && !writeKey\('session', HINT_KEY, serializeSessionHint\(user, Date\.now\(\)\)\)\) \{\s*removeKey\('session', HINT_KEY\)\s*\}/,
      "if (persist) writeKey('session', HINT_KEY, serializeSessionHint(user, Date.now()))",
    )],
  ['SM7 (second review) afterPasswordChange() ignores an authenticated:false answer',
    (s) => replaceOnce(s, /if \(outcome === OUTCOME\.SIGNED_OUT\) \{\s*this\._applySignedOut\(\)\s*return\s*\}/, '')],
  ['SM8 a confirmed logout() ends without loading a fresh page',
    (s) => replaceInMethod(s, 'logout', /replacePage\('\/login'\)/, '')],
  ['SM9 a sign-in never loads a fresh page, whoever the page showed',
    (s) => replaceOnce(s, /return leavingPage \|\| isDifferentUser\(shown, user\)/, 'return false')],
  ['SM10 every sign-in loads a fresh page, the same person too',
    (s) => replaceOnce(s, /return leavingPage \|\| isDifferentUser\(shown, user\)/, 'return true')],
  ['SM11 the "stay" branch assigns its user directly, so nothing records it',
    (s) => replaceOnce(s, /this\._showUser\(known\)/, 'this.user = known')],
  ['SM12 a page restored from the back/forward cache is shown, not reloaded',
    (s) => replaceOnce(s, /if \(event\.persisted\) reloadPage\(\)/, '')],
  // After _applySignedOut() there is nobody in this.user to compare against.
  ['SM13 login() compares the new user with this.user, which a sign-out has cleared',
    (s) => replaceInMethod(s, 'login', /const shown = shownUser/, 'const shown = this.user')],
  ['SM14 setup() compares the new user with this.user, which a sign-out has cleared',
    (s) => replaceInMethod(s, 'setup', /const shown = shownUser/, 'const shown = this.user')],
  ['SM15 _applyAuthenticated() assigns its user directly, so nothing records it',
    (s) => replaceOnce(s, /this\._showUser\(user\)/, 'this.user = user')],
  ['SM16 a sign-out clears the record of who the page showed',
    (s) => replaceOnce(s, /_applySignedOut\(\) \{/, '_applySignedOut() {\n      shownUser = null')],
  // The mutant control for "an unconfirmed sign-out never replaces the page".
  ['SM17 an unconfirmed logout() replaces the page anyway (onto the browser\'s error page)',
    (s) => replaceInMethod(s, 'logout', /if \(!confirmed\) \{\s*return\s*\}/, "if (!confirmed) {\n        replacePage('/login')\n        return\n      }")],
  // The mutant control for "another tab's pending logout wins over a signed-in answer".
  ['SM18 another tab\'s pending logout ignored when this tab\'s check says signed in',
    (s) => replaceInMethod(s, '_followOtherTab', /pendingLogout: pendingBefore \|\| pendingLogoutRecorded\(\)/, 'pendingLogout: false')],
  ['SM19 the pending logout only looked for when the answer arrives (its confirmation has removed it by then)',
    (s) => replaceInMethod(s, '_followOtherTab', /pendingLogout: pendingBefore \|\| pendingLogoutRecorded\(\)/, 'pendingLogout: pendingLogoutRecorded()')],
  ['SM20 following another tab\'s sign-out stamps the epoch again (tabs set each other off)',
    (s) => replaceInMethod(s, '_followOtherTab', /this\._clearUser\(\)/, 'this._applySignedOut()')],
  ['SM21 the signed-out note ignored: the fresh /login runs the whole check',
    (s) => replaceOnce(s, /if \(loadedBySignOut\) \{\s*this\._clearUser\(\)\s*return\s*\}/, '')],
  ['SM22 the signed-out note read before the pending logout is finished',
    (s) => replaceOnce(s, /const loadedBySignOut = takeSignedOutNote\(\)/, 'const loadedBySignOut = takeSignedOutNote()\n      if (loadedBySignOut) {\n        this._clearUser()\n        return\n      }')],
  ['SM23 a pageshow listener added on every request for a fresh page',
    (s) => replaceOnce(s, /if \(!pageshowListenerInstalled\) \{/, 'if (true) {')],
  ['SM24 _showUser() does not record the user it shows',
    (s) => replaceOnce(s, /\n\s*noteShown\(user\)\n/, '\n')],
]

try {
  piniaModule = await import(PINIA_URL)
} catch (err) {
  report(false, `FAIL  section 4 cannot load Pinia from client/node_modules (${err.code || err.message}).\n        Install the client dependencies (\`npm ci\` at the repo root runs \`cd client && npm install\`).`)
}

if (piniaModule) {
  // Pinia and Vue are already evaluated, so the browser shims cannot change how
  // they initialise (no devtools); only the store sees them.
  installShims()

  for (const r of await runStoreScenarios((n) => `${AUTH_URL}?load=${n}`)) {
    report(r.ok, `FAIL  ${r.label}`)
  }

  const base = stripComments(authSrc)
  // Control: the unmutated text, loaded the mutant way, must pass everything, or a
  // "caught" mutant below would only prove the loader is broken.
  const control = asDataModule(base)
  const controlResults = control ? await runStoreScenarios(control) : [{ ok: false }]
  report(
    controlResults.every((r) => r.ok),
    'FAIL  store mutants: the UNMUTATED store fails when loaded the mutant way, so mutant results would mean nothing',
  )
  for (const [name, mutate] of STORE_MUTANTS) {
    const mutated = mutate(base)
    const source = mutated && mutated !== base ? asDataModule(mutated) : null
    if (!source) {
      report(false, `FAIL  store mutant could not be built: ${name}\n        its target text is gone from stores/auth.js; update the mutant with the store`)
      continue
    }
    const results = await runStoreScenarios(source)
    report(results.some((r) => !r.ok), `FAIL  store mutant survived: ${name}\n        no store scenario noticed it`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
