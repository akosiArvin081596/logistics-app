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
  return !samePerson(a, b) || a.role !== b.role || !!a.mustChangePassword !== !!b.mustChangePassword
}

// One notion of identity for both decisions: the server's user id, the one field
// nobody edits. Names are not identity: PUT /api/users/:id rewrites a driver's name
// across tables (DRIVER_RENAME_TARGETS), so the same id under a new name is the same
// person, and a different id under the same name is not. The username comparison
// only covers a user with no id at all, i.e. the fallback setup() builds itself.
function samePerson(a, b) {
  if (a.id != null && b.id != null) return String(a.id) === String(b.id)
  return a.username === b.username
}

/**
 * Does a background answer name a DIFFERENT PERSON from the one on screen? Then the
 * page is reloaded, not patched: the auth store is not the only one holding that
 * person's data (loads, messages, expenses), and a reload is the one reset that
 * reaches all of them. Nobody on screen (the login page) is never "different":
 * being signed in from there is the normal path.
 */
export function isDifferentUser(shown, next) {
  if (!isSessionUser(shown) || !isSessionUser(next)) return false
  return !samePerson(shown, next)
}

export const EFFECT = Object.freeze({ NONE: 'none', REROUTE: 'reroute', RELOAD: 'reload' })

/** What a settled background check does to the page: reload, re-run the guard, or nothing. */
export function pageEffect(shown, next) {
  if (isDifferentUser(shown, next)) return EFFECT.RELOAD
  return guardInputsChanged(shown, next) ? EFFECT.REROUTE : EFFECT.NONE
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
//   - IGNORED once the cookie changes owner in ANY tab: see the epoch below.
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

/**
 * The stored hint's user, or null when absent, malformed, expired, future-dated, or
 * confirmed before `notBeforeMs`: the epoch, i.e. someone has logged in or out since.
 */
export function parseSessionHint(raw, nowMs, { ttlMs = HINT_TTL_MS, notBeforeMs = 0 } = {}) {
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
  // Same millisecond as the epoch is fine: login stamps the epoch, then saves.
  if (!(parsed.confirmedAt >= notBeforeMs)) return null
  if (!isSessionUser(parsed.user)) return null
  // Re-pick on READ as well as on write (same reason as formDraft.js): a hint
  // written by another build must not smuggle extra fields in.
  return pickHintFields(parsed.user)
}

// ── Who owns the cookie now: the epoch ───────────────────────────────────────
// The hint is per TAB, the cookie per BROWSER. So "this tab last saw A" goes stale
// without this tab doing anything: another tab logs A out, or signs B in on the
// same cookie. Before the epoch, an offline reload then restored the logged-out
// user's screens, or showed A while the cookie belonged to B (no data either way:
// the server still decides every request). Every change of owner (login, setup,
// logout, or a definitive "signed out" answer, in any tab) stamps this epoch into
// localStorage, which every tab shares, and a hint confirmed before it is ignored.
// A plain epoch-ms string.
export function serializeSessionEpoch(nowMs) {
  return String(Math.trunc(nowMs))
}

export function parseSessionEpoch(raw) {
  if (raw == null || raw === '') return 0 // never stamped: nothing to be older than
  const ms = Number(raw)
  // Present but unreadable: distrust every hint rather than guess. The next login,
  // logout or sign-out stamps a clean one.
  return Number.isFinite(ms) && ms >= 0 ? ms : Infinity
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

// ── A sign-out the server has just confirmed: the note ───────────────────────
// A confirmed logout() ends on a fresh /login page. That page's first check found
// nobody known and ran the whole foreground ladder above (3 attempts, up to 21 s on
// a poor signal) to learn what the page that sent it already knew. So logout()
// leaves this note in the tab's sessionStorage just before replacing the page, and
// the fresh page reads it once, removes it, and goes straight to the login screen:
// no request, no background loop, no second epoch stamp.
//   - WRITTEN only on the confirmed path. An unconfirmed logout stays in-app and
//     leaves the pending-logout record instead, which always takes precedence.
//   - A TIMESTAMP and nothing else.
//   - TTL 60 s. It has to cover one page load: logout() writes it immediately
//     before location.replace('/login'), and the new page reads it at its first
//     check. A minute is generous for that on a weak signal (the ladder it skips
//     capped at 21 s). A page that starts later than that was not the fresh page
//     logout() asked for (its load was stopped, or failed and was retried by hand),
//     and the ordinary check is the right answer for it: slower, never wrong.
//   - IGNORED if older than the epoch: someone signed in, in some tab, after it.
//   - Unreadable, expired or future-dated means NO note. Unlike the pending-logout
//     record this fails open, because ignoring it costs one check, nothing more.
export const SIGNED_OUT_NOTE_TTL_MS = 60 * 1000
const SIGNED_OUT_NOTE_VERSION = 1

export function serializeSignedOutNote(nowMs) {
  if (!Number.isFinite(nowMs)) return null
  return JSON.stringify({ v: SIGNED_OUT_NOTE_VERSION, at: nowMs })
}

/** True when `raw` is a note written within the TTL, and not before `notBeforeMs` (the epoch). */
export function parseSignedOutNote(raw, nowMs, { ttlMs = SIGNED_OUT_NOTE_TTL_MS, notBeforeMs = 0 } = {}) {
  if (typeof raw !== 'string' || raw === '') return false
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!parsed || parsed.v !== SIGNED_OUT_NOTE_VERSION || !Number.isFinite(parsed.at)) return false
  const age = nowMs - parsed.at
  if (!(age >= 0 && age <= ttlMs)) return false
  return parsed.at >= notBeforeMs
}

// ── Another tab changed who owns the cookie ──────────────────────────────────
// A tab that signs someone in or out stamps the epoch, and a logout records itself
// before its request goes out. The browser reports both writes to every OTHER tab
// (a `storage` event), and a tab still showing the previous owner asks the server
// once (stores/auth.js) and then does one of three things:
//   KEEP    the same person: the page stays, and so do its live updates.
//   RELOAD  someone else: a full reload from the server's user, as the background
//           check does, because every other store holds the first person's data.
//   LEAVE   stop showing this person. `freshPage` says whether the app answered, so
//           a fresh /login page will load; without an answer that load would be the
//           browser's own error page, so the app's own login screen instead.
// Leave, whatever the server says, when a logout is recorded in this browser: the
// record is written BEFORE its request is sent, so an answer can predate it and
// still say "signed in". And leave when there is no answer at all: the cookie has
// changed owner and nothing proves it is still the person on screen.
export const TAB_CHANGE = Object.freeze({ KEEP: 'keep', RELOAD: 'reload', LEAVE: 'leave' })

export function decideTabChange({ outcome, pendingLogout, shown, next } = {}) {
  const answered = outcome === OUTCOME.AUTHENTICATED || outcome === OUTCOME.SIGNED_OUT
  if (pendingLogout || outcome === OUTCOME.SIGNED_OUT) return { action: TAB_CHANGE.LEAVE, freshPage: answered }
  if (outcome === OUTCOME.AUTHENTICATED) {
    return { action: isDifferentUser(shown, next) ? TAB_CHANGE.RELOAD : TAB_CHANGE.KEEP, freshPage: false }
  }
  return { action: TAB_CHANGE.LEAVE, freshPage: false }
}
