// A PDF receipt's pages on the Expenses screen (driver privacy): the words for
// the server's codes and counts. Everything shown comes from
// GET /api/expenses/:id/receipt-pages; the browser decides nothing about a
// page, it only names what the server says.
//
// The view: { readable, reason, file: { pages }, pages: [{ page, code, reasons,
// mark, mark_reason, lapsed, released_anyway, released }], counts: { pages,
// released, office }, released_anyway: [page], invoices: [{ id, invoice_number,
// status, pages_in_pdf, can_update }] }. A mark answers the view and
// withdrawal: { withdrawn: [id], refused: [{ id, invoice_number, code }] }.

export const RECEIPT_PAGE_CODE_TEXT = Object.freeze({
  OTHER_PERSON: 'names another person',
  OTHER_TRUCK: 'shows another truck',
  OTHER_CARD: "shows another driver's card",
  UNREADABLE: "can't be read as this receipt",
  STATEMENT: 'statement page',
  AUTO_RELEASED: 'a clean one-page receipt',
})

// The server's reason codes for a mark, in the order the dialog lists them.
export const RECEIPT_PAGE_MARK_REASONS = Object.freeze([
  { code: 'only_his_lines', text: 'Only his own lines' },
  { code: 'checked_receipt', text: 'Checked: his receipt' },
  { code: 'other_driver', text: "Another driver's lines" },
  { code: 'other_truck', text: 'Another truck' },
  { code: 'other_card', text: 'Another card' },
  { code: 'not_readable', text: "Can't be read" },
  { code: 'other', text: 'Other (say why in the note)' },
])

export function receiptPageCodeText(code) {
  return RECEIPT_PAGE_CODE_TEXT[code] || 'not checked yet'
}

// "4 of 6 pages kept by the office" (DP8), or every page reaching the driver.
export function receiptPagesCountsText(view) {
  const c = (view && view.counts) || {}
  const pages = Number(c.pages) || 0
  const office = Number(c.office) || 0
  if (!view || view.readable === false) return 'The pages could not be read; they stay with the office.'
  if (!pages) return ''
  if (!office) return pages === 1 ? 'The page reaches the driver' : `All ${pages} pages reach the driver`
  return `${office} of ${pages} ${pages === 1 ? 'page' : 'pages'} kept by the office`
}

// One page's line: "Page 2 · names another person · Kept by the office (released anyway)".
export function receiptPageLine(page) {
  if (!page) return ''
  const parts = [`Page ${page.page}`, receiptPageCodeText(page.code)]
  let status = page.released ? 'Reaches the driver' : 'Kept by the office'
  if (page.mark === 'office') status = 'Office only (marked)'
  else if (page.lapsed) status = 'Kept by the office (its release lapsed: mark it again)'
  else if (page.released && page.released_anyway) status = 'Reaches the driver (released anyway)'
  else if (page.released && page.mark === 'released') status = 'Reaches the driver (released)'
  parts.push(status)
  return parts.join(' · ')
}

// The "Release anyway" question, naming the server's codes.
export function releaseAnywayText(codes) {
  const list = (Array.isArray(codes) ? codes : []).map(receiptPageCodeText)
  const what = list.length ? list.join(', ') : 'another driver, truck or card'
  return `The check found that this page ${what}. Release it to the driver only after reading the page.`
}

// An invoice holding some of the receipt's pages.
export function receiptPagesInvoiceLine(inv) {
  if (!inv) return ''
  const held = Array.isArray(inv.pages_in_pdf) && inv.pages_in_pdf.length
    ? `page${inv.pages_in_pdf.length === 1 ? '' : 's'} ${inv.pages_in_pdf.join(', ')} in its PDF`
    : 'none of its pages in its PDF'
  return `${inv.invoice_number || `Invoice #${inv.id}`} (${inv.status || 'unknown'}): ${held}`
}

// The toast after a mark, from the server's withdrawal outcome (never the
// view's `invoices`): an invoice PDF that refused to drop the page is named
// with its code, so a failed "office only" never reads as done.
export function receiptPageMarkToast(res) {
  const refused = res && res.withdrawal && Array.isArray(res.withdrawal.refused) ? res.withdrawal.refused.filter(Boolean) : []
  if (!refused.length) return { text: 'Page marked', kind: 'success' }
  const names = refused.map((r) => r.invoice_number || `Invoice #${r.id}`)
  const codes = [...new Set(refused.map((r) => r.code).filter(Boolean))]
  const pdfs = names.length === 1 ? 'PDF' : 'PDFs'
  return { text: `Marked, but the ${pdfs} of ${names.join(', ')} could not be updated${codes.length ? ` (${codes.join(', ')})` : ''}`, kind: 'error' }
}
