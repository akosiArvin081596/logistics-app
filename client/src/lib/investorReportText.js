// The note under the investor portal's report date inputs.
//
// The canonical copy is RANGE_HINT in lib/investor-report-options.js, the one
// place the owner or client edits the downloadable report's choices; this is
// the client's copy of that sentence. Edit it there first, then here:
// scripts/test-investor-report-text-parity.mjs fails while the two differ.

export const RANGE_HINT = 'Reports cover whole months: a date range that starts or ends mid-month includes that whole month, because payouts are settled by month.'

// The hint for GET /api/investor's `reportRangeMode`: shown only in
// 'whole-months' mode. 'exact-dates', and a response without the field (a
// server that predates it), show nothing.
export function rangeHintFor(mode) {
  return mode === 'whole-months' ? RANGE_HINT : ''
}
