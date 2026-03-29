import { ref } from 'vue'
import { io } from 'socket.io-client'

let socket = null
let registeredName = null

const isConnected = ref(false)

export function useSocket() {
  function connect() {
    if (socket) return
    socket = io({ transports: ['polling'] })
    socket.on('connect', () => {
      isConnected.value = true
      if (registeredName) socket.emit('register', registeredName)
    })
    socket.on('disconnect', () => (isConnected.value = false))
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

  function disconnect() {
    socket?.disconnect()
    socket = null
    isConnected.value = false
  }

  return { isConnected, connect, register, emit, on, off, disconnect }
}
