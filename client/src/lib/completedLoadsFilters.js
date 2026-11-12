// Completed Loads' two quick filters, Needs Review and Needs attention: one on at
// a time, and the line the list shows when no row is left. The tab takes both
// counts over the rows its driver and date filters leave, the same rows a toggle
// narrows, so with no search typed a toggle's count is the rows it shows.
//
// Pure: no Vue, no imports. scripts/test-completed-loads-filters.mjs runs it and
// the tab mounted.

export const QUICK_REVIEW = 'review'
export const QUICK_ATTENTION = 'attention'

// The two toggles after a press, as { review, attention }: the pressed one
// flips and the other goes off.
export function pressQuickFilter(on, pressed) {
  const review = Boolean(on && on.review)
  const attention = Boolean(on && on.attention)
  if (pressed === QUICK_REVIEW) return { review: !review, attention: false }
  if (pressed === QUICK_ATTENTION) return { review: false, attention: !attention }
  return { review, attention }
}

// Where the driver and date filters narrowed the list, as the end of the line.
function pickedText(driver, dates) {
  if (driver && dates) return ' for the driver and dates you picked'
  if (driver) return ' for the driver you picked'
  if (dates) return ' for the dates you picked'
  return ''
}

// The empty list's line, naming what is on: the quick filter (review wins if
// both were ever on), a typed search, the driver filter and the date filter.
export function completedEmptyText({ review = false, attention = false, search = false, driver = false, dates = false } = {}) {
  let head
  if (review) head = search ? 'No loads that need review match your search' : 'No loads need review'
  else if (attention) head = search ? 'No loads whose automatic invoice draft needs attention match your search' : 'No automatic invoice draft needs attention'
  else head = search ? 'No loads match your search' : 'No completed loads'
  return `${head}${pickedText(driver, dates)}.`
}
