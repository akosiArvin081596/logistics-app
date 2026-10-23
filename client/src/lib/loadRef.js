// The reference a page opens a load by (the Dispatcher raw Load ID plan, PR 2).
//
// Every role but Super Admin is served a Load ID that holds broker contact as
// its shown text ("QA-[contact withheld]", or a blank cell when the ID is only
// contact). With WITHHELD_LOAD_REFS_ENABLED on, a Dispatcher also gets an opaque
// key beside it: `_loadKey` on a load row, `loadKey` beside a `loadId` (the
// tracking map, live events, a notice's metadata), `CurrentLoadKey` and
// `QueuedLoadKeys` on a Fleet entry, `loadKey` on a Messages conversation. The
// server reads the key back as the load.
// So every per-load call and every list key goes through loadRef(); the screen
// shows the shown text (loadIdShown()). Without a key, the reference is the
// Load ID as served, as before.
//
// Pure: no DOM, no network. Runner: scripts/test-load-ref.mjs.

export const WITHHELD_TEXT = '[contact withheld]'
const LOAD_ID_COL_RE = /load.?id|job.?id/i

function loadIdColumn(row, loadIdCol) {
  if (loadIdCol) return loadIdCol
  return Object.keys(row).find((k) => LOAD_ID_COL_RE.test(k)) || ''
}

function text(v) {
  return v == null ? '' : String(v).trim()
}

// A load row (GET /api/dashboard, GET /api/load/:loadId): its key, else its
// Load ID exactly as served (callers that trimmed it still do).
export function loadRef(row, loadIdCol = '') {
  if (!row || typeof row !== 'object') return ''
  if (typeof row._loadKey === 'string' && row._loadKey) return row._loadKey
  const col = loadIdColumn(row, loadIdCol)
  const v = col ? row[col] : ''
  return v == null ? '' : String(v)
}

// A { loadId, loadKey } pair (the tracking map's loads, live events, a
// notice's metadata): its key, else its loadId (or load_id).
export function loadIdRef(item) {
  if (!item || typeof item !== 'object') return ''
  if (typeof item.loadKey === 'string' && item.loadKey) return item.loadKey
  return text(item.loadId) || text(item.load_id)
}

// Whether this user is served the row's Load ID withheld: a key stands for it,
// or the server lists the Load ID among the row's withheld cells. Such a load
// has no tracking link to copy (decision 7: the public page is keyed on the ID
// itself; "Ask a Super Admin for this link").
export function loadIdWithheld(row, loadIdCol = '') {
  if (!row || typeof row !== 'object') return false
  if (typeof row._loadKey === 'string' && row._loadKey) return true
  const col = loadIdColumn(row, loadIdCol)
  return !!col && Array.isArray(row._withheldCells) && row._withheldCells.map(String).includes(col)
}

// The Load ID as the screen shows it (decision 8): the served text, and
// "[contact withheld]" for an ID that is only contact (served blank, listed in
// `_withheldCells`). Display only: the edit form keeps the served value, so the
// stored ID is kept on save.
export function loadIdShown(row, loadIdCol = '') {
  if (!row || typeof row !== 'object') return ''
  const col = loadIdColumn(row, loadIdCol)
  const v = col ? text(row[col]) : ''
  if (v) return v
  return loadIdWithheld(row, col) ? WITHHELD_TEXT : ''
}

// The key a Vue list renders a Fleet entry's queued load under: its key when it
// has one, else its position and text, so two queued loads that read alike
// never share a key.
export function queuedLoadListKey(entry, i) {
  const keys = entry && Array.isArray(entry.QueuedLoadKeys) ? entry.QueuedLoadKeys : []
  const ids = entry && Array.isArray(entry.QueuedLoadIds) ? entry.QueuedLoadIds : []
  return keys[i] ? keys[i] : `${i}:${text(ids[i])}`
}

// Whether a route's ?load= value (a notification tap) names this row: its key
// exactly, or its Load ID as served, letter case aside.
export function loadMatches(row, ref, loadIdCol = '') {
  const want = text(ref)
  if (!want || !row || typeof row !== 'object') return false
  if (typeof row._loadKey === 'string' && row._loadKey && row._loadKey === want) return true
  const col = loadIdColumn(row, loadIdCol)
  const v = col ? text(row[col]).toLowerCase() : ''
  return !!v && v === want.toLowerCase()
}

// A Messages conversation (GET /api/messages): its key, else its loadId exactly
// as served ("" for a general one). The thread is read and replied to by it.
export function conversationRef(c) {
  if (!c || typeof c !== 'object') return ''
  if (typeof c.loadKey === 'string' && c.loadKey) return c.loadKey
  return c.loadId == null ? '' : String(c.loadId)
}

// The key a Vue list renders a conversation under: its position, driver and
// reference, so two that read alike (two spellings of one load share a key;
// two withheld loads can read the same) never share one.
export function conversationListKey(c, i) {
  return `${i}:${c && c.driver != null ? c.driver : ''}:${conversationRef(c)}`
}

// Whether a request failed on a stale key (404 LOAD_KEY_UNKNOWN: the server
// restarted since the page read its rows). The page then reads them again, once.
export function loadKeyStale(err) {
  return !!err && err.status === 404 && err.code === 'LOAD_KEY_UNKNOWN'
}
