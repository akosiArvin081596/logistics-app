/**
 * useVoiceGuidance — spoken turn-by-turn callouts for Drive Mode.
 *
 * Client ask (Deshorn): "on the driver's side let's enhance the navigation part
 * so that they can hear the callouts and the directions."
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN @vueuse/core's useSpeechSynthesis: that
 * composable is built around a reactive `text` ref that is spoken when it
 * changes. Two things it does not give us and we cannot do without:
 *   1. an explicit UNLOCK that can be called synchronously inside a user
 *      gesture (see below — without it the feature simply does not exist on
 *      iOS), and
 *   2. cancel-then-speak, so a fresh callout pre-empts a stale one instead of
 *      queueing behind it. A queued "in half a mile" that plays after the turn
 *      is worse than silence.
 *
 * ⚠️ iOS REQUIRES A USER GESTURE. Safari (and Chrome on iOS, which is Safari)
 * refuses `speechSynthesis.speak()` until at least one utterance has been
 * started from inside a real user-gesture handler. There is no error, no
 * exception and no rejected promise — the utterance is accepted and never
 * spoken. So voice must be unlocked from the "Navigate" tap explicitly; without
 * that call every iPhone in the fleet gets a silent, apparently-working feature.
 *
 * Defensive throughout, mirroring LoadAssignedBanner.vue's Web Audio block: a
 * cab with a flaky browser must lose the audio, never the navigation.
 *
 * MODULE-LEVEL SINGLETON, like useApi/useSocket/useToast. This is not a style
 * choice: the gesture that unlocks iOS is the "Navigate" tap in DriverRouteMap,
 * and the component that needs `ready` to be true is DriveModeOverlay, which is
 * not mounted at the moment of that tap. Per-instance refs would leave the
 * overlay permanently believing voice was never unlocked.
 */
import { ref } from 'vue'

const MUTE_KEY = 'logisx_nav_voice_muted'

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false // private mode / storage disabled
  }
}

const supported =
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.SpeechSynthesisUtterance === 'function'

const muted = ref(readMuted())
// False until the gesture unlock has run. Reported to the ladder so the UI can
// say "tap Navigate to enable voice" rather than being silently mute.
const ready = ref(false)
const lastSpoken = ref('')

export function useVoiceGuidance() {
  function persistMuted() {
    try {
      localStorage.setItem(MUTE_KEY, muted.value ? '1' : '0')
    } catch { /* private mode — the toggle still works for this session */ }
  }

  function toggleMute() {
    muted.value = !muted.value
    persistMuted()
    if (muted.value) cancel()
  }

  /**
   * Call this SYNCHRONOUSLY from a click/touch handler. Speaks one inaudible
   * utterance, which is what actually flips Safari's internal "user has
   * permitted speech" bit; everything after it may be spoken from a timer.
   */
  function unlock() {
    if (!supported) return false
    try {
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      u.rate = 1
      // Some Android builds leave a cancelled queue in a wedged state; resuming
      // first is the same defensive shape LoadAssignedBanner uses on AudioContext.
      try { window.speechSynthesis.resume() } catch { /* ignore */ }
      window.speechSynthesis.speak(u)
      ready.value = true
      return true
    } catch {
      return false
    }
  }

  function cancel() {
    if (!supported) return
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  }

  /**
   * @returns true when the utterance was handed to the synthesiser. A false
   * return is a real "this was not spoken", so callers can surface a reason
   * instead of assuming success.
   */
  function speak(text) {
    if (!supported || !text) return false
    if (muted.value) return false
    if (!ready.value) return false
    try {
      // Pre-empt: a callout is only correct for the position that produced it.
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(String(text))
      u.rate = 1.0
      u.pitch = 1.0
      u.volume = 1.0
      u.lang = 'en-US'
      window.speechSynthesis.speak(u)
      lastSpoken.value = text
      return true
    } catch {
      return false
    }
  }

  return { supported, muted, ready, lastSpoken, unlock, speak, cancel, toggleMute }
}
