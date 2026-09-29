// The Data Manager's inline row edit (components/data-manager/DataTable.vue and
// views/DataManagerView.vue): what an edit opens with, what its Save sends, and
// what the page does when the server answers that the row changed while the
// edit was open.
//
// WHY A BASELINE. The edit stays open through the table's live reloads, and it
// is addressed by row NUMBER, which is a position: sorting the sheet, or
// deleting a row above, points that number at another row. So Save sends
// `baseline`, the row's values as the edit opened them, beside `values`, and
// PUT /api/data/:rowIndex writes only the cells that were edited (a cell sent
// equal to its baseline is left as the sheet holds it) and, on Job Tracking,
// refuses a row that no longer holds the load the edit opened (409 ROW_MOVED).
// The baseline is taken when the edit OPENS and is never rebuilt from the
// table: after a reload that would compare the new row with itself.
//
// ONE CELL PER COLUMN, BY POSITION. `values` and `baseline` line up with the
// headers the edit opened with, index for index, which is how the server reads
// both. A tab can repeat a header name (blank headers included), and a row of
// GET /api/data is keyed by header text, so it carries only the last of those
// columns' values. Kept by position, each such column has its own input, and
// an edit to one is not sent as an edit to the others.
//
// Pure, apart from saveRowEdit(), which drives the store it is given. No Vue,
// no DOM, so it runs under plain Node. Runner:
// scripts/test-data-manager-row-edit.mjs.

const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key)

// A cell of a GET /api/data row as its input shows it: the row's own value as
// text, '' for none. Own properties only: a row object also answers inherited
// names such as `__proto__` and `constructor`, which are not cells.
function cellText(row, header) {
  if (!hasOwn(row, header)) return ''
  const v = row[header]
  return v == null ? '' : String(v)
}

// An edit opening on `row`, a row of GET /api/data: its row number, the headers
// as the table has them, and `baseline`, one cell per header in that order, as
// the inputs open with them.
export function openRowEdit(headers, row) {
  const hs = Array.isArray(headers) ? headers.map((h) => (h == null ? '' : String(h))) : []
  return Object.freeze({
    rowIndex: row ? row._rowIndex : undefined,
    headers: Object.freeze(hs),
    baseline: Object.freeze(hs.map((h) => cellText(row, h))),
  })
}

// What Save sends for `edit` on row `rowIndex`: { values, baseline }, one cell
// per column the edit opened with, in that order. `values` are the inputs'
// values by position, a missing one sent as ''. null when `edit` is not open on
// `rowIndex`: its inputs were never filled from that row.
export function rowEditBody(edit, rowIndex, values) {
  if (!edit || rowIndex == null || edit.rowIndex !== rowIndex) return null
  const v = Array.isArray(values) ? values : []
  return {
    values: edit.baseline.map((_, i) => (v[i] == null ? '' : String(v[i]))),
    baseline: edit.baseline.slice(),
  }
}

// Whether two header rows name the same columns in the same order. Not an
// array on either side: not the same.
export function sameColumns(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((h, i) => String(h == null ? '' : h) === String(b[i] == null ? '' : b[i]))
}

// Whether a refused save means the row changed while its edit was open:
// 409 ROW_MOVED (the row number no longer holds the load the edit opened, or
// the row cannot be confirmed as the one it opened) or 409 SHEET_CHANGED (the
// row changed between the server's check and its write).
export function rowChangedWhileOpen(err) {
  const code = err ? err.code : ''
  return code === 'ROW_MOVED' || code === 'SHEET_CHANGED'
}

// Why the page closed an edit without saving it, and what the person can do.
const WHY = Object.freeze({
  row: 'This row changed while it was open (now a different load, or the sheet was edited or re-sorted).',
  columns: "The sheet's columns changed while this row was open.",
  // 409 ROW_MOVED with an empty `expectedLoadId`: the edit opened a row with no
  // Load ID, and the server refuses any such save, because a row without one
  // cannot be told from another. Opening it again cannot help.
  noLoadId: 'This row has no Load ID, so it cannot be confirmed as the row this edit opened.',
})
const NEXT = Object.freeze({
  row: 'Open the row again to redo the edit.',
  columns: 'Open the row again to redo the edit.',
  noLoadId: 'Give it a Load ID in the spreadsheet itself; after that it can be edited here.',
})

// The page's own message for an edit closed unsaved (`reason`: 'row',
// 'columns' or 'noLoadId'). The server's ROW_MOVED text points at the
// dashboard, so it is not shown here.
export function rowChangedMessage(reason, reloaded) {
  const why = WHY[reason] || WHY.row
  const next = NEXT[reason] || NEXT.row
  return reloaded
    ? `${why} Nothing was saved; the table was reloaded. ${next}`
    : `${why} Nothing was saved, and the table could not be reloaded: reload the page. ${next}`
}

function refusalReason(err) {
  const data = (err && err.data) || {}
  return err.code === 'ROW_MOVED' && data.expectedLoadId === '' ? 'noLoadId' : 'row'
}

// The edit closed, and the table reloaded: the open edit sits on a row number
// that no longer holds what it opened. The message says whether the reload
// worked; a failed one is not thrown (loadData() has logged it).
async function closeAndReload(store, reason) {
  store.editingRow = null
  let reloaded = true
  try {
    await store.loadData()
  } catch {
    reloaded = false
  }
  return rowChangedMessage(reason, reloaded)
}

// The Data Manager's Save, on the sheets store `store`, for an edit on row
// `rowIndex` whose cells line up with `headers`, the columns it opened with.
// Resolves { saved: true } once the row is written (store.saveRow() closes the
// edit and reloads the table), or { saved: false, message } when the row
// changed while the edit was open, so nothing was written:
//   • the table's columns are no longer `headers` (a reload showed a column
//     added, removed or renamed), so cells sent by position would land in other
//     columns: nothing is sent;
//   • the server refused it, 409 ROW_MOVED or SHEET_CHANGED.
// Either way the edit is closed and the table reloaded, and `message` says so.
// Any other refusal rejects as store.saveRow() does, and the edit stays open.
export async function saveRowEdit(store, { rowIndex, values, baseline, headers }) {
  if (!sameColumns(headers, store.headers)) {
    return { saved: false, message: await closeAndReload(store, 'columns') }
  }
  try {
    await store.saveRow(rowIndex, values, baseline)
  } catch (err) {
    if (!rowChangedWhileOpen(err)) throw err
    return { saved: false, message: await closeAndReload(store, refusalReason(err)) }
  }
  return { saved: true }
}
