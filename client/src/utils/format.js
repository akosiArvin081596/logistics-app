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
