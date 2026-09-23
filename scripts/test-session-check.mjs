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
// The tripwire rejects the verbatim pre-fix checkSession() and a catch that signs
// out through _applySignedOut() (T1), a logout() that writes its pending marker
// only after the request (T3), and the old local edit in ChangePasswordView (T5).
//
// Sections 1–3 prove the RULES. Section 4 proves the STORE follows them: it imports
// the committed stores/auth.js with the real Pinia and useApi and drives it through
// page loads, and its own mutants (SM1, SM2 are the two review mutations that sections
// 1–3 alone let through) must each fail a scenario.
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

function suitePageEffect(impl, eq) {
  const e = (a, b) => impl.pageEffect(a, b)
  eq('page: same person, nothing changed → nothing', e(DRIVER_HINT, DRIVER), 'none')
  eq('page: same person, new role → re-run the guard', e(DRIVER_HINT, { ...DRIVER, role: 'Dispatcher' }), 'reroute')
  eq('page: signed out → re-run the guard (to /login), not a reload', e(DRIVER_HINT, null), 'reroute')
  eq('page: nobody shown (login page), now signed in → re-run the guard, not a reload', e(null, DRIVER), 'reroute')
  eq('page: a DIFFERENT person from the one shown → full reload', e(DRIVER_HINT, OTHER), 'reload')
  eq('page: the same id as a string and as a number is the same person', e({ ...DRIVER_HINT, id: '7' }, DRIVER), 'none')
  eq('page: no ids on either side → compared by username', e({ ...DRIVER_HINT, id: undefined }, { ...DRIVER, id: undefined, username: 'someone.else' }), 'reload')
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
  suitePageEffect,
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
const SIGNS_OUT = /this\.user\s*=\s*null|this\.isAuthenticated\s*=\s*false|\b_applySignedOut\s*\(|\$reset\s*\(/
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
//                    and location.reload() counted rather than performed
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

class MemStorage {
  constructor() {
    this.m = new Map()
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null
  }
  setItem(k, v) {
    this.m.set(k, String(v))
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
  let rerouted = 0
  mod.onSessionResolved(() => rerouted++)
  return { store, rerouted: () => rerouted }
}

function makeCtx(source, expect) {
  return {
    expect,
    load: (tabName) => pageLoad(source, tabName),
    answer: (...answers) => world.server.push(...answers),
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
    local: (key) => world.local.getItem(key),
    reloads: () => world.reloads,
    fireOnline: async () => {
      for (const fn of world.listeners.window.online || []) fn()
      await drain()
    },
    advance,
    settle,
  }
}

async function signedIn(c, tabName, user = DRIVER) {
  c.answer(json({ authenticated: true, user }))
  const p = await c.load(tabName)
  await c.settle(p.store.checkSession())
  return p
}
const lastOf = (list) => list[list.length - 1]

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
