import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'
import {
  ACTION,
  BACKGROUND,
  FOREGROUND,
  backgroundDelayMs,
  classifySessionAttempt,
  decideBackgroundStep,
  guardInputsChanged,
  isSessionUser,
  logoutConfirmed,
  parsePendingLogout,
  parseSessionHint,
  runForegroundCheck,
  serializePendingLogout,
  serializeSessionHint,
} from '../lib/sessionCheck'

const api = useApi()

// ── Browser storage, best-effort everywhere ──────────────────────────────────
// Private mode or disabled storage throws on access. Every failure degrades to
// "no hint" / "no marker", i.e. to how this store behaved before either existed.
// What each key holds, and why it lives where it does: lib/sessionCheck.js.
const HINT_KEY = 'logisx.session.lastUser.v1' // sessionStorage: tab-scoped, expires
const PENDING_LOGOUT_KEY = 'logisx.session.pendingLogout.v1' // localStorage: outlives the tab, like the cookie

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
function writeKey(kind, key, value) {
  try {
    if (value == null) storageFor(kind)?.removeItem(key)
    else storageFor(kind)?.setItem(key, value)
  } catch {
    /* quota or disabled: see above */
  }
}
function removeKey(kind, key) {
  writeKey(kind, key, null)
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
 * signed out, a different user or role, a forced password change. router/index.js
 * registers here to re-run its guard on the current page. A module-level hook, not
 * Pinia state, because the router registers at import time, before Pinia exists.
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

      // Known = this tab's hint (survives the reload that got us here) or, should
      // this ever run again later in a page's life, the user already in memory.
      const known =
        parseSessionHint(readKey('session', HINT_KEY), Date.now()) ||
        (isSessionUser(this.user) ? this.user : null)
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
          // them in the app; the background check settles it either way.
          this.user = known
          this.isAuthenticated = true
          this._startReconnect()
          break
        default:
          // ACTION.LOGIN: nobody known, so the login page. It keeps asking, so a
          // still-valid cookie signs them in without retyping a password.
          this._startReconnect()
      }
    },

    _applyAuthenticated(user, { persist = true } = {}) {
      this.user = user
      this.isAuthenticated = true
      this._stopReconnect()
      if (persist) writeKey('session', HINT_KEY, serializeSessionHint(user, Date.now()))
    },

    // Reached only on a DEFINITIVE answer (lib/sessionCheck.js, rule 1), or when
    // the person on this browser asked to log out. Never on a mere failure.
    _applySignedOut() {
      this.user = null
      this.isAuthenticated = false
      this._stopReconnect()
      removeKey('session', HINT_KEY)
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
      const before = this.user
      if (step.action === ACTION.ACCEPT) this._applyAuthenticated(result.data.user)
      else this._applySignedOut()
      if (guardInputsChanged(before, this.user)) notifyResolved()
    },

    async login(username, password) {
      const data = await api.post('/api/auth/login', { username, password })
      sessionGen++
      // A fresh sign-in supersedes a logout that never reached the server: this
      // login just replaced whatever that cookie's session held.
      removeKey('local', PENDING_LOGOUT_KEY)
      this._applyAuthenticated(data.user)
      return data.user
    },

    async setup(username, password, email) {
      const data = await api.post('/api/auth/setup', { username, password, email })
      sessionGen++
      removeKey('local', PENDING_LOGOUT_KEY)
      // The route answers { success, role } with no user object, so the fallback
      // below is built HERE, which is exactly why it is not stored as this tab's
      // known user (rule 4). The next page load confirms it with the server.
      const serverUser = data.user
      this._applyAuthenticated(serverUser || { username, role: 'Super Admin' }, { persist: !!serverUser })
      return this.user
    },

    async logout() {
      sessionGen++
      this._stopReconnect()
      // Recorded BEFORE the request, so a tab closed mid-request still finishes the
      // logout on its next load. Cleared only once the server confirms it.
      writeKey('local', PENDING_LOGOUT_KEY, serializePendingLogout(Date.now()))
      removeKey('session', HINT_KEY)
      if (await this._sendLogout()) removeKey('local', PENDING_LOGOUT_KEY)
      // Locally the person asked to leave, so they leave either way.
      this.user = null
      this.isAuthenticated = false
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
