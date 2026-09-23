import { ref } from 'vue'
import { io } from 'socket.io-client'

// One socket for the whole app, opened by the first component that calls
// connect(). scripts/test-socket-session-client.mjs drives this module.
let socket = null
let registeredName = null

const isConnected = ref(false)
const hasEverConnected = ref(false)

export function useSocket() {
  function connect() {
    if (socket) return
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
    })
    s.on('disconnect', (reason) => {
      if (socket !== s) return
      isConnected.value = false
      // The server ended this socket together with its session: a logout, a new
      // sign-in on this browser, a password change or role change made
      // elsewhere, or expiry. socket.io never reconnects after this one, so
      // keeping it would make connect() a no-op for the rest of the page. Drop
      // it, and the room name it registered: the next connect() opens a fresh
      // socket on whatever the cookie holds by then. Any other reason (network,
      // a server restart) is a transport drop, which socket.io reconnects by
      // itself, re-registering on 'connect' above.
      if (reason === 'io server disconnect') {
        socket = null
        registeredName = null
      }
    })
  }

  function register(name) {
    registeredName = name
    socket?.emit('register', name)
  }

  function emit(event, data) {
    socket?.emit(event, data)
  }

  function on(event, callback) {
    socket?.on(event, callback)
  }

  function off(event, callback) {
    socket?.off(event, callback)
  }

  // Ends this socket's life: logout, a new sign-in, or a view leaving. The room
  // name goes with it, or the next connect() would register it again for
  // whoever signs in next. Cleared before the socket is closed, so its own
  // disconnect event finds it already replaced.
  function disconnect() {
    const s = socket
    socket = null
    registeredName = null
    isConnected.value = false
    hasEverConnected.value = false
    s?.disconnect()
  }

  return { isConnected, hasEverConnected, connect, register, emit, on, off, disconnect }
}
