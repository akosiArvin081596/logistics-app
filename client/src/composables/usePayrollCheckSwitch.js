import { ref } from 'vue'
import { probeUrl, switchFromProbe } from '../lib/payrollCheck.js'

// Whether this server has the before-payroll check switched on (PAYROLL_CHECK_ENABLED), for the
// link on Invoices. One ask per page, a Super Admin's only (the route is rate-limited per user);
// off until an answer says on, and asked again on the next page when none could tell.
const on = ref(false)
let known = false
let pending = null

export function usePayrollCheckSwitch(api, role) {
  const url = probeUrl(role)
  if (url && !known && !pending && api && typeof api.get === 'function') {
    pending = Promise.resolve()
      .then(() => api.get(url))
      .then(() => switchFromProbe(200, ''), (err) => switchFromProbe(err && err.status, err && err.code))
      .then((answer) => { if (answer !== null) notePayrollCheckSwitch(answer) })
      .finally(() => { pending = null })
  }
  return on
}

// The page's own answers say it too, so Invoices then asks nothing.
export function notePayrollCheckSwitch(value) {
  on.value = value === true
  known = true
}
