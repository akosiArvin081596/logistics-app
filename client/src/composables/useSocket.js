import { ref } from 'vue'
import { io } from 'socket.io-client'
// Explicit .js: stores/auth.js imports this module, and scripts/test-session-check.mjs
// loads that store under plain Node, which (unlike Vite) will not guess an extension.
import { useApi } from './useApi.js'
import { OUTCOME, classifySessionAttempt } from '../lib/sessionCheck.js'

// One socket for the whole app, opened by the first component that calls
// connect(). scripts/test-socket-session-client.mjs drives this module.
let socket = null
let registeredName = null
// The last name a page registered. A session check can answer "signed out"
// just before a password change's new cookie lands, and that drops
// registeredName; resume() restores it from here. Only disconnect() forgets it.
let lastRegisteredName = null
// Every listener a component has added with on() and not yet removed with
// off(), in order. A socket opened by a reconnect is a new object: the pages
// still mounted added theirs to the old one, so each is attached to every
// socket opened here. Otherwise the new socket would join its rooms and
// deliver to nobody. Components pair on() with off() on unmount, and must
// subscribe before their first await (an on() landing after the page's
// off() would never be removed); disconnect() empties the list regardless, so
// nothing a page left behind reaches whoever signs in next.
const listeners = []

const isConnected = ref(false)
const hasEverConnected = ref(false)

// When the server closes the socket it has ended the session the socket was
// opened on, and socket.io never reconnects after that by itself. But this
// browser may still be signed in on a NEW session: this tab changed its
// password, or another tab signed in again. So ask, and reconnect only on a yes.
// Bounded: three checks, then stop, so a server that keeps closing the socket
// is never answered with a reconnect loop.
const RECONNECT_DELAYS_MS = [1000, 3000, 10000]
// A socket that stays up this long has proved its session good: a later close
// starts again from the first delay.
const STABLE_AFTER_MS = 30000
let reconnectAttempt = 0
let reconnectTimer = null
let stableTimer = null
// Bumped by disconnect() and pause(). A check scheduled before it answers for a
// socket life that has ended, and must do nothing.
let lifeGen = 0
// A page has called connect() and nothing has called disconnect() since: live
// updates are wanted. unpause() brings a socket back only then.
let wanted = false

// The person this page shows, as the auth store last reported it (setSocketOwner).
// A reconnect opens a socket only for them: the session the server closed this
// socket with may have been replaced by ANOTHER person's sign-in in another tab,
// and a socket opened on that session would deliver their updates to a page still
// showing the first person's data, under the first person's room name.
let owner = null

/**
 * Called by stores/auth.js whenever the person on screen changes: their user id,
 * or null for nobody. That store imports this module, so this one never imports it
 * back; the owner is pushed in instead.
 */
export function setSocketOwner(id) {
  owner = id == null || id === '' ? null : String(id)
}

// Is `user` the person on screen? Ids compared as strings (the server sends
// numbers; a saved copy could hold either). With no owner, nobody is.
function isOwner(user) {
  return owner !== null && user != null && user.id != null && String(user.id) === owner
}

const api = useApi()

// One GET /api/auth/session, classified by the same rules the auth store's own
// session check uses (only a 401 or `authenticated: false` means signed out).
// `user` is the server's user on a signed-in answer, and null otherwise.
async function checkSession() {
  let attempt
  try {
    attempt = { data: await api.get('/api/auth/session', { timeout: 10000 }) }
  } catch (error) {
    attempt = { error }
  }
  const outcome = classifySessionAttempt(attempt)
  return { outcome, user: outcome === OUTCOME.AUTHENTICATED ? attempt.data.user : null }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
    registeredName = null // given up: nothing will re-register it
    return
  }
  const gen = lifeGen
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (gen !== lifeGen || socket) return // ended, or a page has opened one since
    const { outcome, user } = await checkSession()
    if (gen !== lifeGen || socket) return
    if (outcome === OUTCOME.AUTHENTICATED && isOwner(user)) openSocket() // re-registers on 'connect'
    else if (outcome === OUTCOME.UNREACHABLE) scheduleReconnect() // no answer: ask again, within the same budget
    else registeredName = null // signed out, or not the person on screen: stay down
  }, RECONNECT_DELAYS_MS[reconnectAttempt++])
}

function openSocket() {
  const s = io({ transports: ['websocket', 'polling'] })
  socket = s
  // Every handler checks it still belongs to the CURRENT socket: a socket that
  // was replaced can still deliver a late event, and it must not mark the new
  // one connected or disconnected, or drop it.
  s.on('connect', () => {
    if (socket !== s) return
    isConnected.value = true
    hasEverConnected.value = true
    if (registeredName) s.emit('register', registeredName)
    clearTimeout(stableTimer)
    stableTimer = setTimeout(() => {
      if (socket === s && s.connected) reconnectAttempt = 0
    }, STABLE_AFTER_MS)
  })
  s.on('disconnect', (reason) => {
    if (socket !== s) return
    isConnected.value = false
    clearTimeout(stableTimer)
    stableTimer = null
    // The server ended this socket together with its session: a logout, a new
    // sign-in on this browser, a password change or role change, or expiry.
    // Drop it (keeping connect() a no-op would strand the page) and ask whether
    // this browser is still signed in. Any other reason (network, a server
    // restart) is a transport drop, which socket.io reconnects by itself,
    // re-registering on 'connect' above.
    if (reason === 'io server disconnect') {
      socket = null
      scheduleReconnect()
    }
  })
  for (const [event, callback] of listeners) s.on(event, callback)
}

export function useSocket() {
  function connect() {
    wanted = true
    if (socket) return
    openSocket()
  }

  function register(name) {
    registeredName = name
    lastRegisteredName = name
    socket?.emit('register', name)
  }

  // This tab's session was just renewed (a password change answered 2xx), so
  // come back now instead of depending on the timed checks: one that went out
  // before the browser stored the new cookie can have answered "signed out" and
  // stopped them. For a page that stays mounted, since nothing else would call
  // connect() for it.
  function resume() {
    wanted = true
    reconnectAttempt = 0
    if (!registeredName) registeredName = lastRegisteredName
    if (!socket) openSocket() // registers on 'connect'
  }

  // Another tab has signed someone in or out, and the auth store is asking the
  // server whose session this browser now holds. Until it knows, nothing live
  // reaches this page: the socket goes down and so does any pending reconnect.
  // Unlike disconnect(), what the mounted page registered (its listeners, the room
  // name) is kept, so that unpause() can bring its updates back.
  function pause() {
    const s = socket
    socket = null
    isConnected.value = false
    lifeGen++
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearTimeout(stableTimer)
    stableTimer = null
    s?.disconnect()
  }

  // ...and the answer named the same person: the page carries on where pause()
  // left it, if it wanted live updates at all.
  function unpause() {
    if (wanted) resume()
  }

  function emit(event, data) {
    socket?.emit(event, data)
  }

  function on(event, callback) {
    listeners.push([event, callback])
    socket?.on(event, callback)
  }

  // Removes one registration, as socket.io's own off() does.
  function off(event, callback) {
    const i = listeners.findIndex(([e, cb]) => e === event && cb === callback)
    if (i >= 0) listeners.splice(i, 1)
    socket?.off(event, callback)
  }

  // Ends this socket's life: logout, a new sign-in, or a view leaving. The room
  // name goes with it, or the next connect() would register it again for
  // whoever signs in next; so do the listeners (the pages that added them are
  // leaving: the router unmounts the old page before mounting the next) and any
  // pending reconnect. Cleared before the socket is closed, so its own
  // disconnect event finds it already replaced.
  function disconnect() {
    const s = socket
    socket = null
    wanted = false
    registeredName = null
    lastRegisteredName = null
    listeners.length = 0
    isConnected.value = false
    hasEverConnected.value = false
    lifeGen++
    reconnectAttempt = 0
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearTimeout(stableTimer)
    stableTimer = null
    s?.disconnect()
  }

  return { isConnected, hasEverConnected, connect, register, resume, pause, unpause, emit, on, off, disconnect }
}
