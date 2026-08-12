/**
 * useScreenWakeLock — keep the screen awake while Drive Mode is open.
 *
 * Nothing in this repo used the Screen Wake Lock API before, so the phone slept
 * mid-drive: a driver mounts the phone, taps Navigate, and 30 seconds later the
 * display is off and the turn-by-turn banner is invisible. That makes the whole
 * feature unusable in the one place it exists to be used.
 *
 * ⚠️ THE RE-ACQUISITION IS THE WHOLE JOB. A wake lock sentinel is released by
 * the platform whenever the document stops being visible — a notification
 * shade, an incoming call, the driver flicking to the messages tab, an app
 * switch. It is NOT restored when the page comes back, and `sentinel.released`
 * just quietly turns true. So a request-once implementation works for exactly
 * the first interruption and never again. We re-request on every
 * `visibilitychange` back to visible, for as long as the caller still wants it.
 *
 * Rolled rather than taken from @vueuse/core so the re-acquire path is explicit
 * and reviewable here — this is a behaviour we depend on, not a convenience.
 * Every failure is swallowed: an unsupported browser, a denied lock, or a
 * low-battery refusal must cost the screen timeout, never the navigation.
 */
import { ref, onBeforeUnmount } from 'vue'

export function useScreenWakeLock() {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const active = ref(false)

  let sentinel = null
  let wanted = false
  let listening = false

  async function acquire() {
    if (!supported || !wanted) return
    if (sentinel && !sentinel.released) return
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    try {
      sentinel = await navigator.wakeLock.request('screen')
      active.value = true
      sentinel.addEventListener('release', () => {
        active.value = false
      })
    } catch {
      // NotAllowedError (battery saver, no user activation, unsupported type).
      active.value = false
    }
  }

  function onVisibilityChange() {
    if (wanted && typeof document !== 'undefined' && document.visibilityState === 'visible') {
      acquire()
    }
  }

  function request() {
    wanted = true
    if (!listening && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
      listening = true
    }
    acquire()
  }

  async function release() {
    wanted = false
    if (listening && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      listening = false
    }
    try {
      if (sentinel && !sentinel.released) await sentinel.release()
    } catch { /* already gone */ }
    sentinel = null
    active.value = false
  }

  onBeforeUnmount(() => { release() })

  return { supported, active, request, release }
}
