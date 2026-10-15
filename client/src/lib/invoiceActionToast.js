// The toast after a Super Admin moves a driver invoice through review on the
// Invoices screen (PUT /api/invoices/:id/approve). A payment on a week that
// touches a closed month (MARK_PAID_CLOSED_MONTH_ENABLED) is recorded only: the
// server names those months in `closedMonths`, and the toast says their figures
// don't change. Everything else toasts as it always did.
// scripts/test-closed-month-mark-paid-copy.mjs pins the wording.
import { monthLabel } from './monthLabel.js'

function joinMonths(labels) {
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

export function invoiceActionToast(action, result) {
  if (action !== 'paid') return 'Invoice approved'
  const labels = (Array.isArray(result?.closedMonths) ? result.closedMonths : []).map(monthLabel).filter(Boolean)
  if (!labels.length) return 'Invoice marked as paid'
  const one = labels.length === 1
  return `Invoice marked as paid. ${joinMonths(labels)} ${one ? 'is' : 'are'} closed; ${one ? 'its' : 'their'} figures don't change.`
}
