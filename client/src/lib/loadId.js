// Which expenses belong to which load — the one place the driver app answers it.
//
// WHY THIS EXISTS. A load's detail page listed its expenses by filtering the
// driver payload on `e.load_id`, but GET /api/driver/:name has always returned
// that column ALIASED — `load_id AS loadId`. The filter could never match, so
// from 2026-04-03 (2ad6a86) a driver never saw a single expense on any load:
// they submitted a receipt, got "Expense submitted", then looked at an empty
// history, concluded it had not gone through, and filed it again — which the
// duplicate guard refuses with a 409. That is the "these are not uploading"
// report, told from the phone.
//
// Two rules, both locked by scripts/test-driver-receipt-flow.mjs:
//
//   1. READ BOTH SPELLINGS OF THE FIELD. `loadId` is what the driver endpoint
//      sends; `load_id` is the raw column every other expense route returns.
//      Taking either keeps this correct if the alias is ever dropped.
//
//   2. COMPARE THE SAME WAY THE SERVER DOES. Job Tracking holds both
//      `513987502` and `#513987502`, and an expense stores whichever string its
//      form sent, so an exact match hides real rows. loadIdKey() is the
//      server's own comparison key — loadBelongsToDriver() and deduplicateLoads()
//      in server.js, normalizeLoadId() in lib/ratecon-load.js: trim, lowercase,
//      drop ONE leading "#". Deliberately identical rather than "smarter": this
//      decides what a driver sees filed under a load, and the server decides
//      what the driver is allowed to file there. If the two keys disagreed, a
//      row could be accepted and then not shown, or the reverse.

export function loadIdKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/^#/, '')
}

// True when a and b name the same load. Two blanks are NOT the same load — an
// expense logged without one must never be listed under a load whose id cell
// happens to be empty.
export function sameLoadId(a, b) {
  const key = loadIdKey(a)
  return key !== '' && key === loadIdKey(b)
}

// The load an expense row was filed against, whichever spelling carries it.
export function expenseLoadId(expense) {
  if (!expense) return ''
  if (expense.loadId != null && expense.loadId !== '') return expense.loadId
  return expense.load_id == null ? '' : expense.load_id
}

// The expenses filed against `loadId`, in their original order.
export function expensesForLoad(expenses, loadId) {
  if (!Array.isArray(expenses) || loadIdKey(loadId) === '') return []
  return expenses.filter((e) => sameLoadId(expenseLoadId(e), loadId))
}
