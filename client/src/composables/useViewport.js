import { ref, onMounted, onUnmounted } from 'vue'

// Module-level singleton. Every component that calls useViewport() reads the
// same reactive `isMobile` ref, and we maintain a single matchMedia listener
// regardless of how many views mount. The 768 px threshold matches Tailwind's
// `md` breakpoint so responsive classes elsewhere stay in sync.
const BREAKPOINT = 768
const isMobile = ref(false)
let listenerCount = 0
let mq = null

function refresh(ev) {
  isMobile.value = ev ? ev.matches : window.innerWidth < BREAKPOINT
}

export function useViewport() {
  onMounted(() => {
    if (listenerCount === 0) {
      isMobile.value = window.innerWidth < BREAKPOINT
      mq = window.matchMedia(`(max-width: ${BREAKPOINT - 1}px)`)
      mq.addEventListener('change', refresh)
    }
    listenerCount++
  })
  onUnmounted(() => {
    listenerCount--
    if (listenerCount === 0 && mq) {
      mq.removeEventListener('change', refresh)
      mq = null
    }
  })
  return { isMobile }
}
