// What an answer — or the lack of one — from GET /api/auth/session means.
// Pure: no network, no storage, no Vue. stores/auth.js does the I/O and owns the
// timers; every DECISION lives here so scripts/test-session-check.mjs can pin it.
//
// WHY THIS EXISTS
// The session check used to end in a bare `catch { user = null; isAuthenticated =
// false }`, so ANY failure read as "signed out": a dropped cellular packet,
// useApi's 20 s timeout, a 502 while pm2 restarts the app during a deploy. The
// router guard then sent the driver to /login, and whatever he was doing went
// with it. Production, before this fix: one driver signed in 17 times in 5 days —
// once 13 s after a successful save — mostly with no 401 and no logout at all.
//
// The check runs ONCE PER PAGE LOAD (the router guard's first navigation), so
// every one of those bounces was a fresh load: a pull-to-refresh, or the phone
// evicting the tab while the camera was open for a receipt photo. At that moment
// the in-memory store is empty by definition, which is why "a user this tab
// already knew" has to survive the reload (the hint below). Without it, rule 3
// could never fire.
//
// THE RULES
//   1. Only the server can end a session. A 401, or a 2xx whose body says
//      `authenticated: false`, is definitive. Nothing else is: not a network
//      error, a timeout, a 5xx, 429 or 408; not a 403/404 (they answer a
//      different question); and not a 2xx body this code cannot read — useApi
//      turns a proxy's HTML error page into `{}`, which the old code read as
//      "signed out".
//   2. No answer → retry with a short backoff before deciding anything.
//   3. Still no answer and this tab has a server-confirmed user → keep them in the
//      app, marked reconnecting, and keep asking in the background. Nobody known
//      → the login page, and keep asking there too, so a cookie that was valid all
//      along signs them straight back in when the signal returns instead of
//      costing another password entry.
//   4. Never invent a user. Every identity this module hands back is one the
//      server returned: ACCEPT carries the server's user object, and the hint is
//      only ever written from one.
//
// None of this is authorization. Every request still carries the httpOnly session
// cookie and the server decides; a "reconnecting" tab whose session really is gone
// gets a 401 on its first call. This decides only when the CLIENT gives up on a
// session it has no evidence has ended.

export const OUTCOME = Object.freeze({
  AUTHENTICATED: 'authenticated',
  SIGNED_OUT: 'signed-out',
  UNREACHABLE: 'unreachable',
})

export const ACTION = Object.freeze({
  ACCEPT: 'accept', // the server confirmed a session: use ITS user
  SIGN_OUT: 'sign-out', // the server said there is none: clear everything
  RETRY: 'retry', // no answer yet: wait `delayMs`, ask again
  STAY: 'stay-reconnecting', // no answer: keep the known user in the app, keep asking
  LOGIN: 'login-reconnecting', // no answer, nobody known: login page, keep asking
})

/**
 * A user this client can route on. `role` drives every guard decision and
 * `roleHome`; a role-less "authenticated" answer would bounce /login →
 * roleHome ('/login') forever, so it is not treated as an answer at all.
 */
export function isSessionUser(user) {
  return (
    !!user &&
    typeof user === 'object' &&
    !Array.isArray(user) &&
    typeof user.role === 'string' &&
    user.role.trim() !== ''
  )
}

/**
 * Classify ONE attempt. Pass `{ data }` for a resolved request (useApi's parsed
 * body) or `{ error }` for a rejected one. useApi's Error carries `status` for an
 * HTTP error and `code: 'TIMEOUT'` with status 0 for its own timeout; a raw network
 * failure is a TypeError with no status at all.
 */
export function classifySessionAttempt({ data, error } = {}) {
  if (error != null) {
    return Number(error.status) === 401 ? OUTCOME.SIGNED_OUT : OUTCOME.UNREACHABLE
  }
  // Boolean false only. `{}` from an unreadable body, or a string "false", is not
  // the server saying anything.
  if (data && data.authenticated === false) return OUTCOME.SIGNED_OUT
  if (data && data.authenticated === true && isSessionUser(data.user)) return OUTCOME.AUTHENTICATED
  return OUTCOME.UNREACHABLE
}

// ── Foreground: the check the first navigation waits on ──────────────────────
// The screen is blank while this runs, so it is short — and shorter still with a
// known user, because giving up then costs nothing: the app renders either way
// and the background loop finishes the job.
//
// Worst case, every attempt hanging to its timeout: 6+1+6 = 13 s with a known
// user, 6+1+6+2+6 = 21 s with nobody known. The single attempt this replaced
// waited up to useApi's 20 s default and then showed /login. A phone with no
// signal fails instantly, so there it is ~1 s / ~3 s. The delays span the few
// seconds of 502s a deploy restart produces.
//
// 6 s per attempt because the answer is ~200 bytes: a network that cannot
// deliver it in 6 s will not deliver the page after it either, and a
// slow-but-working one still gets answered in the background (10 s there,
// because nobody is waiting on it).
export const FOREGROUND = Object.freeze({
  timeoutMs: 6000,
  knownUserDelaysMs: Object.freeze([1000]), // 2 attempts
  noUserDelaysMs: Object.freeze([1000, 2000]), // 3 attempts
})

/** What the foreground does after attempt number `attempt` (1-based). */
export function decideForegroundStep({ outcome, attempt, hasKnownUser } = {}) {
  if (outcome === OUTCOME.AUTHENTICATED) return { action: ACTION.ACCEPT }
  if (outcome === OUTCOME.SIGNED_OUT) return { action: ACTION.SIGN_OUT }
  // Anything else, including an outcome this file does not know, is "no answer".
  // Failing toward retry/stay is safe; toward sign-out is the bug this file
  // exists for, and toward accept would invent a session.
  const delays = hasKnownUser ? FOREGROUND.knownUserDelaysMs : FOREGROUND.noUserDelaysMs
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 1
  if (n <= delays.length) return { action: ACTION.RETRY, delayMs: delays[n - 1] }
  return { action: hasKnownUser ? ACTION.STAY : ACTION.LOGIN }
}

/**
 * The foreground check end to end: ask, classify, retry, decide. I/O is injected
 * so the whole sequence runs under test with no network and no timers.
 *
 * @param {object} o
 * @param {(timeoutMs: number) => Promise<{data?: any, error?: any}>} o.probe
 *   one GET /api/auth/session; resolving `{ error }` and throwing both mean the
 *   attempt failed
 * @param {(ms: number) => Promise<void>} o.sleep
 * @param {boolean} o.hasKnownUser  this tab had a server-confirmed user before the reload
 * @returns {Promise<{action: string, user: object|null, attempts: number}>}
 *   `user` is the SERVER's user on ACCEPT and null otherwise. On STAY the caller
 *   restores its own known user; this function never produces one.
 */
export async function runForegroundCheck({ probe, sleep, hasKnownUser }) {
  for (let attempt = 1; ; attempt++) {
    let result
    try {
      result = await probe(FOREGROUND.timeoutMs)
    } catch (error) {
      result = { error: error ?? new Error('Request failed') }
    }
    const step = decideForegroundStep({
      outcome: classifySessionAttempt(result || {}),
      attempt,
      hasKnownUser: !!hasKnownUser,
    })
    if (step.action === ACTION.RETRY) {
      await sleep(step.delayMs)
      continue
    }
    return {
      action: step.action,
      user: step.action === ACTION.ACCEPT ? result.data.user : null,
      attempts: attempt,
    }
  }
}

// ── Background: after the foreground gives up ────────────────────────────────
// The store keeps asking on this schedule, and immediately on the browser's
// `online` event or when the tab becomes visible again. It never gives up and
// never concludes anything from silence.
export const BACKGROUND = Object.freeze({
  timeoutMs: 10000,
  delaysMs: Object.freeze([2000, 4000, 8000, 15000, 30000]), // then every 30 s
})

export function backgroundDelayMs(tick) {
  const d = BACKGROUND.delaysMs
  const i = Number.isInteger(tick) && tick > 0 ? tick : 0
  return d[Math.min(i, d.length - 1)]
}

/** One background answer. Silence is a retry, however long it lasts. */
export function decideBackgroundStep(outcome, tick) {
  if (outcome === OUTCOME.AUTHENTICATED) return { action: ACTION.ACCEPT }
  if (outcome === OUTCOME.SIGNED_OUT) return { action: ACTION.SIGN_OUT }
  return { action: ACTION.RETRY, delayMs: backgroundDelayMs(tick) }
}

/**
 * Did a background answer change anything the router guard decides on? If so the
 * guard is re-run on the current page (router/index.js), rather than waiting for a
 * navigation that, in the single-page driver app, may never come.
 */
export function guardInputsChanged(prev, next) {
  const a = isSessionUser(prev) ? prev : null
  const b = isSessionUser(next) ? next : null
  if (!a || !b) return !a !== !b
  return a.id !== b.id || a.role !== b.role || !!a.mustChangePassword !== !!b.mustChangePassword
}

// ── The tab's last server-confirmed user (the "hint") ────────────────────────
// Kept in sessionStorage by the store: the house rule from lib/formDraft.js,
// "convenience data is tab-scoped and expires". It survives a reload and a tab the
// phone evicted and restored, dies with the tab, and adds nothing to what the
// session cookie already grants: that cookie persists for 24 h and is the only
// thing the server looks at.
//   - WRITTEN only from a user the server returned. Never from the fallback
//     setup() builds for itself, and never from an in-app edit.
//   - FIELDS: what routing and the views read. Not `email`, which nothing in the
//     client uses.
//   - TTL = the session cookie's maxAge (24 h, server.js). The cookie is not
//     `rolling`, so it dies 24 h after LOGIN, and `confirmedAt` is at or after
//     login, so an older hint describes a cookie that is certainly gone. A younger
//     one can still outlive its cookie; the background check then gets a
//     definitive "signed out" and the guard sends them to /login.
export const HINT_TTL_MS = 24 * 60 * 60 * 1000
const HINT_VERSION = 1
const HINT_FIELDS = Object.freeze([
  'id',
  'username',
  'role',
  'driverName',
  'fullName',
  'companyName',
  'mustChangePassword',
])

function pickHintFields(user) {
  const out = {}
  for (const k of HINT_FIELDS) if (user[k] !== undefined) out[k] = user[k]
  return out
}

export function serializeSessionHint(user, nowMs) {
  if (!isSessionUser(user) || !Number.isFinite(nowMs)) return null
  return JSON.stringify({ v: HINT_VERSION, confirmedAt: nowMs, user: pickHintFields(user) })
}

/** The stored hint's user, or null when absent, malformed, expired or future-dated. */
export function parseSessionHint(raw, nowMs, ttlMs = HINT_TTL_MS) {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || parsed.v !== HINT_VERSION || !Number.isFinite(parsed.confirmedAt)) return null
  // A negative age means the clock moved backwards (or the hint was edited): its
  // real age is unknowable, so it is no hint at all.
  const age = nowMs - parsed.confirmedAt
  if (!(age >= 0 && age <= ttlMs)) return null
  if (!isSessionUser(parsed.user)) return null
  // Re-pick on READ as well as on write (same reason as formDraft.js): a hint
  // written by another build must not smuggle extra fields in.
  return pickHintFields(parsed.user)
}

// ── A logout that has not reached the server yet ─────────────────────────────
// The old logout() had the same flaw from the other side: `catch { /* ignore */ }`,
// then clear the user. A logout that never reached the server looked finished,
// but the httpOnly cookie, which JS cannot delete, was still a live session, so
// the next ONLINE page load signed the same person straight back in. On a shared
// phone or a dispatch-office PC, "I logged out" was false.
//
// The store records the intent BEFORE sending the request (fail-closed: a tab
// closed mid-request still has it) and clears it only once the server confirms.
// The next page load finishes it before anything may trust the cookie. The
// marker lives in localStorage, not sessionStorage, because it must outlive the
// tab exactly as long as the cookie does. It holds a timestamp and nothing else.
export function serializePendingLogout(nowMs) {
  return JSON.stringify({ v: 1, at: nowMs })
}

export function parsePendingLogout(raw, nowMs, ttlMs = HINT_TTL_MS) {
  if (raw == null || raw === '') return false
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true // present but unreadable: logout() is the only writer, so honour it
  }
  if (!parsed || !Number.isFinite(parsed.at)) return true
  // Past the cookie's own lifetime there is no session left to end.
  return nowMs - parsed.at <= ttlMs
}

/** Did the server end the session? A 2xx did; a 401 means there was none to end. */
export function logoutConfirmed({ error } = {}) {
  if (error == null) return true
  return Number(error.status) === 401
}
