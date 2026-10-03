/**
 * Format a number as USD currency with proper negative handling.
 * -4200 → "-$4,200"  (not "$-4,200")
 *  4200 → "$4,200"
 *     0 → "$0"
 */
export function formatCurrency(n) {
  const v = Number(n || 0)
  const prefix = v < 0 ? '-$' : '$'
  return prefix + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/**
 * The same, to the cent, for rows that must add up to a total exactly.
 * -4200.5 → "-$4,200.50"   0.25 → "$0.25"   -0.001 → "$0.00"
 */
export function formatCurrencyCents(n) {
  const cents = Math.round(Number(n || 0) * 100)
  const prefix = cents < 0 ? '-$' : '$'
  return prefix + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
