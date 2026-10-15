// "Assign anyway?" for a driver recorded off (R11). The five routes that put a
// driver on a load answer 409 DRIVER_OFF_DUTY, naming his off dates, when the
// load's days overlap his time off; the same request with the confirmation goes
// through and is audited. withOffDutyConfirm() runs a send, asks on that answer
// (one dialog for the whole app, OffDutyConfirmHost.vue in App.vue) and re-sends
// confirmed. A module singleton, like useToast().
import { reactive } from 'vue'
import { isOffDutyWarning } from '../lib/availabilityText'

const state = reactive({ open: false, message: '' })
let pending = null

function settle(yes) {
  const resolve = pending
  pending = null
  state.open = false
  if (resolve) resolve(!!yes)
}

// Opens the dialog with the server's own words; resolves true on "Assign
// anyway", false on "Keep as is". A second question answers the first "no".
function ask(warning) {
  if (pending) settle(false)
  state.message = (warning && warning.error) || 'This driver is recorded off on these dates. Assign anyway?'
  state.open = true
  return new Promise((resolve) => { pending = resolve })
}

// send(confirmOffDuty) performs the request. Resolves with its result, or with
// { offDutyDeclined: true } when the person keeps things as they were; any
// other error is thrown as before.
async function withOffDutyConfirm(send) {
  try {
    return await send(false)
  } catch (err) {
    if (!isOffDutyWarning(err)) throw err
    const yes = await ask(err.data || { error: err.message })
    if (!yes) return { offDutyDeclined: true }
    return send(true)
  }
}

export function useOffDutyConfirm() {
  return { state, ask, answer: settle, withOffDutyConfirm }
}
