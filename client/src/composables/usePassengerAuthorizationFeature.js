import { ref } from 'vue'
import { FEATURE_URL, featureEnabled } from '../lib/passengerAuthorization'

// Whether this server takes passenger authorizations (PASSENGER_AUTHORIZATION_ENABLED),
// from its own feature route. It decides whether the driver's card shows at all; the
// routes behind the card answer 404 FEATURE_OFF with the flag off whatever this says.
//
// One read per page, shared by every card on it. Off until the answer arrives, and
// off when there is none (the next card that mounts asks again). `api` is the
// caller's useApi().
const enabled = ref(false)
let known = false
let pending = null

export function usePassengerAuthorizationFeature(api) {
  if (!known && !pending && api && typeof api.get === 'function') {
    pending = Promise.resolve()
      .then(() => api.get(FEATURE_URL))
      .then((data) => {
        if (data && typeof data === 'object') {
          enabled.value = featureEnabled(data)
          known = true
        }
      })
      .catch(() => {})
      .finally(() => { pending = null })
  }
  return enabled
}
