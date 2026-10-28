// Personal receipts (R3 v1) on the screens: what each one shows, decided from
// the server's fields alone. The browser computes no money: every amount is the
// server's own text (personal.amount_text, a line's amount) and every state and
// action the server's (personal.state, personal.can_undo).
//
// personal (GET /api/expenses/all rows, the driver payload's expenses):
//   { line_id, state, amount_text, week_label, invoice_number, can_undo }
//   state: pending | needs_correction | invoiced | correction | reversed
// With the receipt's week on (the list's personalReceiptWeek) the server also
// sends: state carried (off its week's invoice, waiting for the next one) with
// wait_text (why, in its words), final (on an approved invoice), can_reverse,
// and for a driver invoice_week_label (the week of the invoice carrying it).
// An invoice's personal_lines (GET /api/invoices, the driver payload):
//   { line_id, label, amount, receipt: { kind: image | pdf | none, url, expense_id } }

const LIVE_STATES = new Set(['pending', 'needs_correction', 'carried', 'invoiced', 'correction'])
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
// cannot, or exactly as the server's can_reverse says when it sends one (a line
// on an approved invoice is final). Both stay available with new marks
// switched off.
export function canUndoPersonal(expense, { isSuperAdmin = false } = {}) {
  return !!isSuperAdmin && personalLive(expense) && expense.personal.can_undo === true
}
export function canReversePersonal(expense, { isSuperAdmin = false } = {}) {
  if (!isSuperAdmin || !personalLive(expense)) return false
  const p = expense.personal
  return typeof p.can_reverse === 'boolean' ? p.can_reverse : p.can_undo === false
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
    case 'invoiced':
      if (!number) return `${amount} · on ${weekWords(personal)}'s invoice`
      return personal.final === true ? `${amount} · on ${number} (approved, final)` : `${amount} · on ${number}`
    case 'correction': return number ? `${amount} · on correction ${number}, ${weekWords(personal)}` : `${amount} · on a correction invoice, ${weekWords(personal)}`
    case 'needs_correction': return `${amount} · needs a correction invoice for ${weekWords(personal)}`
    case 'carried': return personal.wait_text ? `${amount} · waiting: ${personal.wait_text}` : `${amount} · waiting for the next weekly invoice`
    // A reversed line can still be on its way to an invoice (wait_text says so).
    case 'reversed': return personal.wait_text ? `${amount} · reversed; ${personal.wait_text}` : `${amount} · reversed`
    default: return ''
  }
}

// The driver's receipt card: the week of the invoice that carries the line when
// the server names it (a line carried to a later week's invoice).
export function personalDriverText(personal) {
  if (!personal || !personal.amount_text) return ''
  const amount = `Personal: -${personal.amount_text}`
  const week = personal.invoice_week_label || personal.week_label
  switch (personal.state) {
    case 'pending':
    case 'invoiced': return week ? `${amount} on your ${week} invoice` : `${amount} on your weekly invoice`
    case 'correction': return `${amount} on correction ${personal.invoice_number}`
    case 'needs_correction': return `${amount} on a correction invoice for ${weekWords(personal)}`
    case 'carried': return `${amount}, coming off your next weekly invoice`
    case 'reversed': return `${amount}, reversed`
    default: return ''
  }
}

// The Mark dialog's sentence: the receipt's week with personalReceiptWeek on,
// else the week it is marked in.
export function personalMarkDialogText(receiptWeek) {
  return receiptWeek === true
    ? "The driver repays this amount on the invoice for the week of the receipt date. If that invoice is approved, in a closed month or too small, it goes on the driver's next weekly invoice. It leaves the company's costs now; any rest of the receipt stays a company cost."
    : "The driver repays this amount on the weekly invoice for the week it is marked in, and it leaves the company's costs. Any rest of the receipt stays a company cost."
}

// The Reverse dialog's sentence. With personalReceiptWeek on, Reverse is only for
// a line its closed month (or another invoice's pay) keeps from being undone.
export function personalReverseDialogText(receiptWeek) {
  return receiptWeek === true
    ? "This line can no longer be undone. A reversing line credits the amount back in the open month. A line no invoice has taken stays off every invoice with its credit, unless the driver's percentage pay was already raised for it: then the line still goes on his next weekly invoice, and its credit follows it there."
    : "The line is on an approved invoice, so it stays there. A reversing line credits the amount back on this week's invoice, or on its correction invoice."
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
