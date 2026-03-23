import { ref } from 'vue'
import { io } from 'socket.io-client'

let socket = null

const isConnected = ref(false)

export function useSocket() {
  function connect() {
    if (socket) return
    socket = io()
    socket.on('connect', () => (isConnected.value = true))
    socket.on('disconnect', () => (isConnected.value = false))
  }

  function register(name) {
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
