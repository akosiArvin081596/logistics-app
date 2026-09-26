import { defineStore } from 'pinia'
// Explicit .js on the relative imports: scripts/test-session-check.mjs imports this
// store under plain Node, which (unlike Vite) will not guess an extension. Same
// reason lib/payoutPeriod.js imports './monthLabel.js'.
import { useApi } from '../composables/useApi.js'
import { setSocketOwner, useSocket } from '../composables/useSocket.js'
import {
  ACTION,
  BACKGROUND,
  EFFECT,
  FOREGROUND,
  OUTCOME,
  TAB_CHANGE,
  backgroundDelayMs,
  classifySessionAttempt,
  decideBackgroundStep,
  decideTabChange,
  guardInputsChanged,
  isDifferentUser,
  isSessionUser,
  logoutConfirmed,
  pageEffect,
  parsePendingLogout,
  parseSessionEpoch,
  parseSessionHint,
  parseSignedOutNote,
  runForegroundCheck,
  serializePendingLogout,
  serializeSessionEpoch,
  serializeSessionHint,
  serializeSignedOutNote,
} from '../lib/sessionCheck.js'

const api = useApi()

// ── Browser storage, best-effort everywhere ──────────────────────────────────
// Private mode or disabled storage throws on access. Every failure degrades to
// "no hint" / "no marker" / "no note", i.e. to how this store behaved before any
// of them existed. What each key holds, and why it lives where it does:
// lib/sessionCheck.js.
const HINT_KEY = 'logisx.session.lastUser.v1' // sessionStorage: tab-scoped, expires
const PENDING_LOGOUT_KEY = 'logisx.session.pendingLogout.v1' // localStorage: outlives the tab, like the cookie
const EPOCH_KEY = 'logisx.session.epoch.v1' // localStorage: shared by every tab, like the cookie
const SIGNED_OUT_KEY = 'logisx.session.signedOut.v1' // sessionStorage: this tab's next page load only

function storageFor(kind) {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}
function readKey(kind, key) {
  try {
    return storageFor(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}
// false when the storage call threw. A full store (quota) refuses setItem but
// never removeItem, which is what _applyAuthenticated relies on.
function writeKey(kind, key, value) {
  try {
    if (value == null) storageFor(kind)?.removeItem(key)
    else storageFor(kind)?.setItem(key, value)
    return true
  } catch {
    return false
  }
}
function removeKey(kind, key) {
  writeKey(kind, key, null)
}

// This tab's saved user, unless it has expired or predates the latest change of
// cookie owner in ANY tab (login, logout, sign-out; see the epoch in lib/sessionCheck.js).
function readSessionHint() {
  return parseSessionHint(readKey('session', HINT_KEY), Date.now(), {
    notBeforeMs: parseSessionEpoch(readKey('local', EPOCH_KEY)),
  })
}
// The cookie has changed owner, or is about to: every tab's saved user is now stale.
function stampEpoch() {
  writeKey('local', EPOCH_KEY, serializeSessionEpoch(Date.now()))
}
// A logout this browser recorded and the server has not confirmed yet.
function pendingLogoutRecorded() {
  return parsePendingLogout(readKey('local', PENDING_LOGOUT_KEY), Date.now())
}
// Was this page loaded by a sign-out the server had just confirmed? Answered once
// per page load: the note is removed as it is read, whatever it says.
function takeSignedOutNote() {
  const raw = readKey('session', SIGNED_OUT_KEY)
  removeKey('session', SIGNED_OUT_KEY)
  const epoch = parseSessionEpoch(readKey('local', EPOCH_KEY))
  return parseSignedOutNote(raw, Date.now(), { notBeforeMs: epoch })
}
function reloadPage() {
  try {
    window.location.reload()
  } catch {
    /* not in a browser: nothing to reload */
  }
}

// ── A fresh page: sign-out, and a sign-in as a different person ─────────────
// A confirmed logout() ends on a fresh /login; an unconfirmed one stays on the
// app's own login screen (no fresh page would load) and leaves the next sign-in to
// load one. login() and setup() end on a fresh page at the new user's home when
// this page has shown someone else. A full page load is the one reset that reaches
// every store, the same reason a background answer naming a different person
// reloads (lib/sessionCheck.js, isDifferentUser).
//
// The person this page last showed. Every real user assigned to `this.user` goes
// through _showUser(), which notes them here, including the page-load restore from
// this tab's saved copy, which does not go through _applyAuthenticated() (T8 in
// scripts/test-session-check.mjs). Never cleared: a sign-out, or a session that
// ended on its own, clears `this.user` before anyone signs in, which is why login()
// and setup() compare against this record and never against `this.user`. A full
// page load starts it again at null, so a first sign-in on a fresh page stays an
// ordinary in-app navigation.
let shownUser = null
// Set once this page has started a sign-out or asked for a fresh page, and kept for
// the rest of its life: router/index.js opens no signed-in screen on it again, and
// the next sign-in here loads a fresh page (needsFreshPage).
let leavingPage = false
let pageshowListenerInstalled = false
let storageListenerInstalled = false

function noteShown(user) {
  if (isSessionUser(user)) shownUser = user
}

/** True once this page has signed out or asked for a fresh one (read by router/index.js and LoginView). */
export function isLeavingPage() {
  return leavingPage
}

// A full load of `url` that takes this page's place in the history, so Back does
// not return to it.
function replacePage(url) {
  leavingPage = true
  try {
    // A browser that restores this page from its back/forward cache anyway
    // reloads it rather than showing it again. Added once: a page can ask more
    // than once (a sign-in after a sign-out whose load was stopped), and every
    // extra listener would be one more reload of the restored page.
    if (!pageshowListenerInstalled) {
      window.addEventListener('pageshow', (event) => {
        if (event.persisted) reloadPage()
      })
      pageshowListenerInstalled = true
    }
    window.location.replace(url)
  } catch {
    /* not in a browser: there is no page to replace */
  }
}

// Does a sign-in (login, setup) end on a fresh page? Yes for anyone other than the
// person this page showed before it (`shown`). No on a fresh page, or for the same
// person again: LoginView's in-app navigation carries on. And yes on a page that
// already asked for a fresh one and is still here (its load was stopped).
function needsFreshPage(shown, user) {
  return leavingPage || isDifferentUser(shown, user)
}

// ── Background re-check. Module scope, because timers are not state ─────────
let reconnectTimer = null
let reconnectTick = 0
let reconnectInFlight = false
let wakeListenersInstalled = false
// Bumped by login / setup / logout. A probe that started under an older value was
// asking about a session that has since been replaced, so its answer is dropped
// instead of being applied over the new one.
let sessionGen = 0

const resolvedListeners = new Set()

/**
 * Called when a BACKGROUND check changes something the router guard decides on:
 * signed out, a different role, a forced password change. router/index.js registers
 * here to re-run its guard on the current page. (A different PERSON reloads the page
 * instead.) A module-level hook, not Pinia state, because the router registers at
 * import time, before Pinia exists.
 */
export function onSessionResolved(fn) {
  resolvedListeners.add(fn)
  return () => resolvedListeners.delete(fn)
}
function notifyResolved() {
  for (const fn of resolvedListeners) {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// One GET /api/auth/session. Never throws: the answer is data, and so is its absence.
async function probeSession(timeout) {
  try {
    return { data: await api.get('/api/auth/session', { timeout }) }
  } catch (error) {
    return { error }
  }
}

// The two moments a phone most likely has its signal back. Installed once for the
// life of the app; each is a no-op unless a check is pending.
function installWakeListeners(store) {
  if (wakeListenersInstalled || typeof window === 'undefined') return
  wakeListenersInstalled = true
  const wake = () => {
    if (store.isReconnecting) store._reconnectNow()
  }
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake()
  })
}

// ── Other tabs of this browser ───────────────────────────────────────────────
// The cookie belongs to the browser, so a sign-in or sign-out in one tab changes
// the session under every other tab too, and those kept showing the previous
// person's screens and data. The browser fires a `storage` event in every OTHER
// tab (never the one that wrote) when localStorage changes, and two writes mean
// the cookie has changed owner or is about to: the epoch, which every sign-in and
// sign-out stamps, and a pending-logout record being written, which a logout does
// before its request goes out. The record being REMOVED is not one: a confirmed
// logout removes it after both of those, and a sign-in right after its own stamp.
function changesCookieOwner(event) {
  if (!event) return false
  if (event.key === EPOCH_KEY) return true
  return event.key === PENDING_LOGOUT_KEY && event.newValue != null
}

// Installed once, by the first user this page shows (_showUser); a tab with nobody
// on screen has nothing to follow. What a change leads to: _followOtherTab().
function installStorageListener(store) {
  if (storageListenerInstalled || typeof window === 'undefined') return
  storageListenerInstalled = true
  try {
    window.addEventListener('storage', (event) => {
      if (changesCookieOwner(event)) store._followOtherTab()
    })
  } catch {
    /* no window events: nothing to follow */
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    // The last server answer for this tab said "signed in", and no DEFINITIVE answer
    // (a 401, or authenticated:false) has said otherwise since. It grants nothing:
    // every request still carries the httpOnly cookie and the server decides. It is
    // what the router guard routes on.
    isAuthenticated: false,
    isLoading: true,
    // The last session check got no answer (network, timeout, 5xx) and is being
    // retried in the background. With `isAuthenticated`, the app is running on the
    // user this tab's server last confirmed, not re-verified since. Without it, the
    // login page is showing and carries on by itself if the cookie turns out to be
    // valid. This is what an "offline / reconnecting" indicator should read.
    isReconnecting: false,
  }),

  getters: {
    isSuperAdmin: (s) => s.user?.role === 'Super Admin',
    isDispatcher: (s) => s.user?.role === 'Dispatcher',
    isDriver: (s) => s.user?.role === 'Driver',
    isInvestor: (s) => s.user?.role === 'Investor',
    roleHome: (s) => {
      const map = {
        'Super Admin': '/dashboard',
        Dispatcher: '/dashboard',
        Driver: '/driver',
        Investor: '/investor',
      }
      return map[s.user?.role] || '/login'
    },
  },

  actions: {
    async checkSession() {
      if (this._sessionPromise) return this._sessionPromise
      this._sessionPromise = (async () => {
        try {
          await this._resolveSessionOnLoad()
        } finally {
          this.isLoading = false
          this._sessionPromise = null
        }
      })()
      return this._sessionPromise
    },

    // Runs while the first navigation waits. The rules: lib/sessionCheck.js.
    async _resolveSessionOnLoad() {
      const gen = sessionGen
      // Read on every load, and gone after it: it speaks for one page load only.
      const loadedBySignOut = takeSignedOutNote()

      // A logout that never reached the server is finished before anything may
      // trust the cookie; otherwise this load would sign the person who asked to
      // leave straight back in. One attempt: they get the login page either way,
      // and an unfinished logout stays recorded for the next load. Deliberately
      // never retried in the background: a late logout landing after they signed
      // back in would destroy the new session.
      if (parsePendingLogout(readKey('local', PENDING_LOGOUT_KEY), Date.now())) {
        const finished = await this._sendLogout()
        if (gen !== sessionGen) return
        if (finished) removeKey('local', PENDING_LOGOUT_KEY)
        this._applySignedOut()
        return
      }
      removeKey('local', PENDING_LOGOUT_KEY) // absent or expired: tidy either way

      // This is the fresh /login a confirmed sign-out loaded (the note,
      // lib/sessionCheck.js). The server has just said there is no session, so
      // asking again only costs time: with nobody known the check below takes up
      // to 21 s on a poor signal to reach this same login screen. No background
      // loop either, and no second epoch stamp: logout() stamped it.
      if (loadedBySignOut) {
        this._clearUser()
        return
      }

      // Known = this tab's saved user (it survives the reload that got us here) or,
      // should this ever run again later in a page's life, the user already in memory.
      const known = readSessionHint() || (isSessionUser(this.user) ? this.user : null)
      const result = await runForegroundCheck({ probe: probeSession, sleep, hasKnownUser: !!known })
      if (gen !== sessionGen) return

      switch (result.action) {
        case ACTION.ACCEPT:
          this._applyAuthenticated(result.user)
          break
        case ACTION.SIGN_OUT:
          this._applySignedOut()
          break
        case ACTION.STAY:
          // The server has said nothing since it last confirmed this user. Keep
          // them in the app; the background check settles it either way. On screen
          // from the saved copy, not via _applyAuthenticated(): nothing is re-saved.
          this._showUser(known)
          this.isAuthenticated = true
          this._startReconnect()
          break
        default:
          // ACTION.LOGIN: nobody known, so the login page. It keeps asking, so a
          // still-valid cookie signs them in without retyping a password.
          this._startReconnect()
      }
    },

    // The ONE place a real user is put in `this.user` (T8 in
    // scripts/test-session-check.mjs); clearing it to null is done directly. Each
    // person shown is noted for the fresh-page decision (noteShown), becomes the
    // only person the live-update socket may reconnect for (setSocketOwner), and
    // from then on this page follows sign-ins and sign-outs in other tabs.
    _showUser(user) {
      this.user = user
      noteShown(user)
      setSocketOwner(user.id ?? null)
      installStorageListener(this)
    },

    _applyAuthenticated(user, { persist = true } = {}) {
      this._showUser(user)
      this.isAuthenticated = true
      this._stopReconnect()
      // A save that fails must not leave the PREVIOUS user saved. Otherwise a reload
      // restores them, the background check answers with this user again, the page
      // reloads again, and so on for as long as the store stays full.
      if (persist && !writeKey('session', HINT_KEY, serializeSessionHint(user, Date.now()))) {
        removeKey('session', HINT_KEY)
      }
    },

    // Nobody on screen: no user, no socket owner, no background check, no saved
    // copy. The part of a sign-out that stays in this tab: _applySignedOut() adds
    // the epoch; the paths that must not stamp it again call this alone.
    _clearUser() {
      this.user = null
      this.isAuthenticated = false
      setSocketOwner(null)
      this._stopReconnect()
      removeKey('session', HINT_KEY)
    },

    // Reached only on a DEFINITIVE answer (lib/sessionCheck.js, rule 1), or when
    // the person on this browser asked to log out. Never on a mere failure.
    _applySignedOut() {
      this._clearUser()
      stampEpoch() // the cookie has no owner now, so no tab may restore one
    },

    _startReconnect() {
      this.isReconnecting = true
      reconnectTick = 0
      installWakeListeners(this)
      this._scheduleReconnect(backgroundDelayMs(reconnectTick++))
    },

    _scheduleReconnect(delayMs) {
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => this._reconnectNow(), delayMs)
    },

    _stopReconnect() {
      this.isReconnecting = false
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    },

    async _reconnectNow() {
      if (!this.isReconnecting || reconnectInFlight) return
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      reconnectInFlight = true
      const gen = sessionGen
      let result
      try {
        result = await probeSession(BACKGROUND.timeoutMs)
      } finally {
        reconnectInFlight = false
      }
      if (gen !== sessionGen || !this.isReconnecting) return

      const step = decideBackgroundStep(classifySessionAttempt(result), reconnectTick++)
      if (step.action === ACTION.RETRY) {
        this._scheduleReconnect(step.delayMs)
        return
      }
      const shown = this.user
      if (step.action === ACTION.ACCEPT) this._applyAuthenticated(result.data.user)
      else this._applySignedOut()
      const effect = pageEffect(shown, this.user)
      // Someone other than the person on screen (their saved user is already the new
      // one): every other store still holds the first person's data, so reload.
      if (effect === EFFECT.RELOAD) reloadPage()
      else if (effect === EFFECT.REROUTE) notifyResolved()
    },

    async login(username, password) {
      const data = await api.post('/api/auth/login', { username, password })
      // The server has replaced this browser's session and ended the live-update
      // socket opened on it. Drop this tab's socket and the room name it
      // registered too, so the next page opens a fresh one as the person who just
      // signed in (connect() is a no-op while a socket exists). Only after the
      // POST succeeded: a refused sign-in changed no session.
      useSocket().disconnect()
      sessionGen++
      stampEpoch() // a new owner for the cookie: other tabs' saved users are stale
      // A fresh sign-in supersedes a logout that never reached the server: this
      // login just replaced whatever that cookie's session held.
      removeKey('local', PENDING_LOGOUT_KEY)
      const shown = shownUser
      this._applyAuthenticated(data.user)
      if (needsFreshPage(shown, this.user)) replacePage(this.roleHome)
      return data.user
    },

    async setup(username, password, email) {
      const data = await api.post('/api/auth/setup', { username, password, email })
      useSocket().disconnect() // as in login(): setup replaced this browser's session
      sessionGen++
      stampEpoch()
      removeKey('local', PENDING_LOGOUT_KEY)
      // The route answers { success, role } with no user object, so the fallback
      // below is built HERE, which is exactly why it is not stored as this tab's
      // known user (rule 4). The next page load confirms it with the server.
      const serverUser = data.user
      const shown = shownUser
      this._applyAuthenticated(serverUser || { username, role: 'Super Admin' }, { persist: !!serverUser })
      if (needsFreshPage(shown, this.user)) replacePage(this.roleHome) // as in login()
      return this.user
    },

    // Call after POST /api/auth/change-password answered 2xx. That route answers
    // { success: true } and nothing else, but it has cleared must_change_password on
    // the user row AND on the session it just regenerated, so the user is re-read
    // from the server rather than edited here. The old local edit reached memory
    // only: this tab's saved copy kept mustChangePassword: true, and the first
    // reload on a bad signal restored it, pinning a driver who had just changed
    // the temporary password back on /account/change-password.
    async afterPasswordChange() {
      const gen = sessionGen
      const result = await probeSession(FOREGROUND.timeoutMs)
      if (gen !== sessionGen) return
      const outcome = classifySessionAttempt(result)
      if (outcome === OUTCOME.AUTHENTICATED) {
        this._applyAuthenticated(result.data.user)
        return
      }
      if (outcome === OUTCOME.SIGNED_OUT) {
        this._applySignedOut()
        return
      }
      // No answer. The 200 already settled this one field, so memory follows it and
      // they can leave the page. The saved copy is DROPPED, not edited: the
      // background check writes it back from the server's own answer.
      if (isSessionUser(this.user)) this._showUser({ ...this.user, mustChangePassword: false })
      removeKey('session', HINT_KEY)
      this._startReconnect()
    },

    async logout() {
      sessionGen++
      // From here on this page opens no signed-in screen (router/index.js), and a
      // change in another tab is left to this logout to settle (_followOtherTab).
      leavingPage = true
      this._stopReconnect()
      // Live updates stop now, whatever the request below does: locally the
      // person asked to leave. Every logout button (the sidebar, the driver app,
      // the password-change screen) comes through here.
      useSocket().disconnect()
      // Recorded BEFORE the request, so a tab closed mid-request still finishes the
      // logout on its next load. Cleared only once the server confirms it.
      writeKey('local', PENDING_LOGOUT_KEY, serializePendingLogout(Date.now()))
      stampEpoch() // and no other tab restores this user from its saved copy
      removeKey('session', HINT_KEY)
      const confirmed = await this._sendLogout()
      // Locally the person asked to leave, so they are signed out here whatever the
      // request answered. Callers follow with router.replace('/login'), a replace
      // and not a push: a push adds a history entry, and a fresh page would take
      // that one's place instead of the signed-in page's.
      this._clearUser()
      if (!confirmed) {
        // No answer from the app: no signal, a timeout, or a 5xx while a deploy
        // restarts it. A fresh page now would be the browser's own "no connection"
        // page or the proxy's error page, so the callers' router.replace('/login')
        // shows the app's own login screen in this page instead. The pending record
        // stays, so the next page load finishes the logout, and leavingPage makes
        // the next sign-in here load the fresh page this one skipped.
        return
      }
      removeKey('local', PENDING_LOGOUT_KEY)
      // The fresh /login skips its session check: the server has just answered it.
      writeKey('session', SIGNED_OUT_KEY, serializeSignedOutNote(Date.now()))
      replacePage('/login')
    },

    // Another tab has signed someone in or out, or is about to (the storage
    // listener above), while this one still shows the previous owner, whose data
    // every other store still holds. One question to the server, then keep, reload
    // or leave the page: the rules are decideTabChange() in lib/sessionCheck.js.
    async _followOtherTab() {
      if (!isSessionUser(this.user) || leavingPage) return
      sessionGen++ // a check already running here was asking about the previous owner
      const gen = sessionGen
      // A logout is recorded before its request is sent, so the answer below can
      // predate it. Seen now, it counts as much as seen when the answer arrives.
      const pendingBefore = pendingLogoutRecorded()
      this._stopReconnect()
      useSocket().pause() // nothing live until the answer says whose it would be
      const result = await probeSession(FOREGROUND.timeoutMs)
      // A newer change, or this tab's own sign-in or sign-out, settles it instead.
      if (gen !== sessionGen || leavingPage) return
      const shown = this.user
      const step = decideTabChange({
        outcome: classifySessionAttempt(result),
        pendingLogout: pendingBefore || pendingLogoutRecorded(),
        shown,
        next: result.data?.user,
      })

      if (step.action === TAB_CHANGE.KEEP) {
        // The same person. Saved again, now newer than the epoch, so a reload here
        // still restores them; and their live updates come back.
        this._applyAuthenticated(result.data.user)
        useSocket().unpause()
        if (guardInputsChanged(shown, this.user)) notifyResolved() // a new role, or a forced password change
        return
      }
      useSocket().disconnect()
      if (step.action === TAB_CHANGE.RELOAD) {
        // Someone else, as the background check handles it (EFFECT.RELOAD): the new
        // user is saved first, and the reload starts from them.
        this._applyAuthenticated(result.data.user)
        reloadPage()
        return
      }
      // LEAVE. Not _applySignedOut(): the tab that made the change stamped the
      // epoch, and a second stamp from here would be one more change for every
      // other tab to follow, this one included.
      this._clearUser()
      if (step.freshPage) replacePage('/login')
      else leavingPage = true // no answer: a fresh page would be the browser's error page
      notifyResolved() // the app's own login screen meanwhile (router/index.js)
    },

    // true = the server ended the session (or there was none to end).
    async _sendLogout() {
      let result
      try {
        await api.post('/api/auth/logout', undefined, { timeout: FOREGROUND.timeoutMs })
        result = {}
      } catch (error) {
        result = { error }
      }
      return logoutConfirmed(result)
    },

    async checkSetupNeeded() {
      const data = await api.get('/api/auth/setup-check')
      return data.needsSetup
    },
  },
})
