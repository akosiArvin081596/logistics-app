import { onMounted, onUnmounted } from 'vue'
import { useSocket } from './useSocket'

/**
 * Subscribe to a socket domain event and auto-refresh on change.
 * Debounces rapid-fire events (e.g., bulk deletes) into a single reload.
 *
 * @param {string} event  Socket event name, e.g. 'trucks:changed'
 * @param {Function} reload  Function to call when the event fires
 * @param {string} room  Socket room to join — 'dispatch' for admin pages, 'investor' for investor pages
 */
export function useSocketRefresh(event, reload, room = 'dispatch') {
  const socket = useSocket()
  let timer = null

  function handler() {
    clearTimeout(timer)
    timer = setTimeout(reload, 300)
  }

  onMounted(() => {
    socket.connect()
    socket.register(room)
    socket.on(event, handler)
  })

  onUnmounted(() => {
    socket.off(event, handler)
    clearTimeout(timer)
  })
}
