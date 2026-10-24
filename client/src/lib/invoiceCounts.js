// What an invoice's counts hold, as the Invoices panel, its table and the
// driver's invoice card say it (B23, 2026-10-23). loads_count and
// rate_per_load hold different things by the invoice's pay basis, which the
// server sends as pay_basis (server.js invoicePayBasis(); GET /api/invoices also
// sends load_count, the loads the row bills):
//   daily       loads_count = days paid, rate_per_load = the daily rate
//   percentage  loads_count = loads, rate_per_load = the pay %
//   manual      loads_count = line items, no rate
// server.js invoiceCountRows() labels the submit email's rows the same way;
// scripts/test-invoice-day-rows-client.mjs pins the two equal.
//
// Pure: no network, no DOM, no Vue. Labels only: every figure is the server's.

const BASES = ['daily', 'percentage', 'manual']

// The server's pay_basis; a row without one (a create or adjust answer) is
// manual by is_manual, else daily.
export function invoicePayBasisOf(inv) {
  if (!inv) return 'daily'
  if (BASES.includes(inv.pay_basis)) return inv.pay_basis
  return Number(inv.is_manual) ? 'manual' : 'daily'
}

function countText(n) {
  return String(Number(n || 0))
}
function moneyText(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function loadCountText(inv) {
  return typeof inv.load_count === 'number' ? String(inv.load_count) : '—'
}

// The Invoices panel's count rows: [{ label, value }].
export function invoiceCountRows(inv) {
  const basis = invoicePayBasisOf(inv)
  if (basis === 'manual') return [{ label: 'Line items', value: countText(inv.loads_count) }]
  if (basis === 'percentage') {
    return [
      { label: 'Loads', value: countText(inv.loads_count) },
      { label: 'Pay %', value: `${Number(inv.rate_per_load || 0)}%` },
    ]
  }
  return [
    { label: 'Days paid', value: countText(inv.loads_count) },
    { label: 'Daily rate', value: moneyText(inv.rate_per_load) },
    { label: 'Loads', value: loadCountText(inv) },
  ]
}

// The driver's invoice card: "7 days", "3 loads", "2 line items".
export function invoiceCardCount(inv) {
  const n = Number((inv && inv.loads_count) || 0)
  const unit = { daily: 'day', percentage: 'load', manual: 'line item' }[invoicePayBasisOf(inv)]
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

// The Invoices table's Loads column: a daily-rate row's loads (load_count), any
// other row's loads_count as before.
export function invoiceLoadsCell(inv) {
  return invoicePayBasisOf(inv) === 'daily' ? loadCountText(inv) : countText(inv.loads_count)
}
