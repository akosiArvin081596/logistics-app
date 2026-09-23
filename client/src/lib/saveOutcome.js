// Did a write get NO answer from the application? If so it may well have been
// saved — only the reply was lost — so the caller must say "not confirmed" and
// go and look, never "not submitted", which invites a resend that the duplicate
// guard then refuses.
//
// ONE definition, used by stores/driver.js (which re-reads the driver's data)
// and ExpenseForm (which chooses the wording). With two copies, the form would
// tell a driver one thing while the store did another.
//
// Three shapes count:
//   - useApi's own timeout: status 0, code 'TIMEOUT';
//   - a connection that dropped mid-request: fetch's TypeError, no status;
//   - a GATEWAY 502/504: nginx lost or gave up on the upstream (a restart during
//     a deploy, or its read timeout — 120 s on /api/expenses). The server may
//     have committed the row before either happened.
// A gateway answer is told apart from an APPLICATION 502/504 (other routes send
// them, e.g. POST /api/documents/scan) by the body: the app answers in JSON with
// an `error`, nginx with an HTML page that useApi parses to nothing (code '',
// data {}). An application error is a real answer, so it is not counted here.
const GATEWAY_STATUSES = new Set([502, 504])

export function replyLost(err) {
  if (!err) return false
  if (!err.status) return true
  if (!GATEWAY_STATUSES.has(err.status)) return false
  const data = err.data || {}
  return !err.code && !data.code && !data.error
}
