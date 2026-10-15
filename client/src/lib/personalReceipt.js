// Personal receipts (R3 v1) on the screens: what each one shows, decided from
// the server's fields alone. The browser computes no money: every amount is the
// server's own text (personal.amount_text, a line's amount) and every state and
// action the server's (personal.state, personal.can_undo).
//
// personal (GET /api/expenses/all rows, the driver payload's expenses):
//   { line_id, state, amount_text, week_label, invoice_number, can_undo }
//   state: pending | needs_correction | invoiced | correction | reversed
// An invoice's personal_lines (GET /api/invoices, the driver payload):
//   { line_id, label, amount, receipt: { kind: image | pdf | none, url, expense_id } }

const LIVE_STATES = new Set(['pending', 'needs_correction', 'invoiced', 'correction'])
const RECEIPT_URL_RE = /^\/api\/invoices\/\d{1,12}\/personal-receipts\/\d{1,12}$/

export const PERSONAL_PDF_TEXT = 'PDF receipt on file'
export const PERSONAL_NO_IMAGE_TEXT = 'Receipt image not available'

// A live Personal line (not reversed) is on the receipt.
export function personalLive(expense) {
  const p = expense && expense.personal
  return !!p && LIVE_STATES.has(p.state)
}

// The Personal button: Super Admin only, the server accepting new marks, the
// receipt not Rejected, and no live line on it (a reversed one can be marked again).
export function canMarkPersonal(expense, { isSuperAdmin = false, enabled = false } = {}) {
  if (!isSuperAdmin || !enabled || !expense) return false
  if (String(expense.status || '') === 'Rejected') return false
  return !personalLive(expense)
}

// Undo while the server says the line can still be undone; Reverse once it
// cannot. Both stay available with new marks switched off.
export function canUndoPersonal(expense, { isSuperAdmin = false } = {}) {
  return !!isSuperAdmin && personalLive(expense) && expense.personal.can_undo === true
}
export function canReversePersonal(expense, { isSuperAdmin = false } = {}) {
  return !!isSuperAdmin && personalLive(expense) && expense.personal.can_undo === false
}

// The server refuses Rejected and Pending on a receipt with a live line, so the
// status buttons step aside while it has one.
export function personalBlocksStatus(expense) {
  return personalLive(expense)
}

function weekWords(p) {
  return p.week_label ? `the week of ${p.week_label}` : 'its week'
}

// The Expenses screen's pill. A Dispatcher's summary carries no invoice number.
export function personalPillText(personal) {
  if (!personal) return ''
  const amount = personal.amount_text ? `Personal -${personal.amount_text}` : 'Personal'
  const number = personal.invoice_number || ''
  switch (personal.state) {
    case 'pending': return `${amount} · waiting for ${weekWords(personal)}'s invoice`
    case 'invoiced': return number ? `${amount} · on ${number}` : `${amount} · on ${weekWords(personal)}'s invoice`
    case 'correction': return number ? `${amount} · on correction ${number}, ${weekWords(personal)}` : `${amount} · on a correction invoice, ${weekWords(personal)}`
    case 'needs_correction': return `${amount} · needs a correction invoice for ${weekWords(personal)}`
    case 'reversed': return `${amount} · reversed`
    default: return ''
  }
}

// The driver's receipt card.
export function personalDriverText(personal) {
  if (!personal || !personal.amount_text) return ''
  const amount = `Personal: -${personal.amount_text}`
  switch (personal.state) {
    case 'pending':
    case 'invoiced': return personal.week_label ? `${amount} on your ${personal.week_label} invoice` : `${amount} on your weekly invoice`
    case 'correction': return `${amount} on correction ${personal.invoice_number}`
    case 'needs_correction': return `${amount} on a correction invoice for ${weekWords(personal)}`
    case 'reversed': return `${amount}, reversed`
    default: return ''
  }
}

// Where an invoice's Personal line points for its receipt:
//   an image   "Receipt", linked to the receipt route (the sanitized JPEG)
//   a PDF      "PDF receipt on file"; a Super Admin gets a link to it on the
//              Expenses screen, a driver the text only
//   otherwise  "Receipt image not available"
// `internal` marks an in-app route (the Expenses screen), `href` otherwise opens
// the receipt route in a new tab.
export function personalLineReceipt(line, { isSuperAdmin = false } = {}) {
  const r = (line && line.receipt) || {}
  if (r.kind === 'image' && RECEIPT_URL_RE.test(String(r.url || ''))) return { text: 'Receipt', href: r.url, internal: false }
  if (r.kind === 'pdf') {
    const id = Number(r.expense_id)
    const linked = isSuperAdmin && Number.isInteger(id) && id > 0
    return { text: PERSONAL_PDF_TEXT, href: linked ? `/expenses?expense=${id}` : '', internal: linked }
  }
  return { text: PERSONAL_NO_IMAGE_TEXT, href: '', internal: false }
}

// The amount dialog opens on the whole receipt, as the server sent it.
export function personalDefaultAmount(expense) {
  const n = Number(expense && expense.amount)
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : ''
}
