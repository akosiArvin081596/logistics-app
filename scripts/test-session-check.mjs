#!/usr/bin/env node
// Deterministic check on client/src/lib/sessionCheck.js — the rules that decide
// whether a failed session check signs a user out — plus a tripwire on the two
// files that wire them in (client/src/stores/auth.js, client/src/router/index.js).
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
// and the tripwire rejects the verbatim pre-fix checkSession() (T1) and a logout()
// that writes its pending marker only after the request (T3).
//
// No network, no DOM, no Vue: pure input/output plus a read of two source files.
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
  eq('scenario: …with the SERVER\'s user object, not a copy', r.user === DRIVER, true)

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

const SUITES = [
  suiteClassify,
  suiteForegroundDecision,
  suiteForegroundScenarios,
  suiteBackground,
  suiteHint,
  suitePendingLogout,
  suiteGuardInputs,
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
    parseSessionHint: (raw, now) => real.parseSessionHint(raw, now, Infinity),
  }],
  ['M7 a hint read back with every field it carries', {
    parseSessionHint: (raw, now) => {
      if (real.parseSessionHint(raw, now) === null) return null
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
]

for (const [name, overrides] of MUTANTS) {
  const results = await runSuites({ ...real, ...overrides })
  const caught = results.filter((r) => !r.ok).length
  report(caught > 0, `FAIL  mutant survived: ${name}\n        no check noticed it; the tables above have lost their teeth`)
}

// ── 3. Tripwire on the wiring ─────────────────────────────────────────────────
// The rules above are only worth anything if the store routes failures through
// them. This reads the store and router and rejects the shapes that bypass them.
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
// T1: turning a FAILURE into a sign-out inline is exactly the bug. Signing out
// happens only through the decision above, never in a catch.
function catchSignsOut(src) {
  return catchBodies(stripComments(src)).some((b) => /this\.user\s*=\s*null|this\.isAuthenticated\s*=\s*false/.test(b))
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

const authSrc = fs.readFileSync(path.join(CLIENT_SRC, 'stores', 'auth.js'), 'utf8')
const routerSrc = fs.readFileSync(path.join(CLIENT_SRC, 'router', 'index.js'), 'utf8')

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
