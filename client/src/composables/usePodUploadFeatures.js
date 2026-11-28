import { ref } from 'vue'
import { podFeatures } from '../lib/podScanRouting'

// The upload card's two POD and BOL switches (POD_UPLOAD_NORMALIZE_ENABLED and
// POD_UPLOAD_SCAN_ALL_ENABLED), from GET /api/auth/session's `features`
// (lib/podScanRouting.js podFeatures()). One read per page, shared by every card
// on it. Off until the answer arrives, and off when there is none (the next card
// that mounts asks again). `api` is the caller's useApi().
const normalize = ref(false)
const scanAll = ref(false)
let known = false
let pending = null

export function usePodUploadFeatures(api) {
  if (!known && !pending && api && typeof api.get === 'function') {
    pending = Promise.resolve()
      .then(() => api.get('/api/auth/session'))
      .then((data) => {
        if (data && typeof data === 'object' && data.features && typeof data.features === 'object') {
          const f = podFeatures(data)
          normalize.value = f.normalize
          scanAll.value = f.scanAll
          known = true
        }
      })
      .catch(() => {})
      .finally(() => { pending = null })
  }
  return { normalize, scanAll }
}
