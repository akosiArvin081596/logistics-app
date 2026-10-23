import { ref } from 'vue'

// Whether this server takes voice notes (MESSAGE_VOICE_NOTES_ENABLED), from
// GET /api/auth/session's `features.voiceNotes`. It decides the record button
// only: notes already sent play either way, and the server refuses a send
// with the flag off (404 FEATURE_OFF) whatever this says.
//
// One read per page, shared by every composer on it. Off until the answer
// arrives, and off when there is none (the next composer that mounts asks
// again). `api` is the caller's useApi().
const enabled = ref(false)
let known = false
let pending = null

export function useVoiceNotesFeature(api) {
  if (!known && !pending && api && typeof api.get === 'function') {
    pending = Promise.resolve()
      .then(() => api.get('/api/auth/session'))
      .then((data) => {
        if (data && typeof data === 'object' && data.features && typeof data.features === 'object') {
          enabled.value = data.features.voiceNotes === true
          known = true
        }
      })
      .catch(() => {})
      .finally(() => { pending = null })
  }
  return enabled
}
