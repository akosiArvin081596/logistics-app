// The Super Admin "Deleted loads" page and its link on Active Loads: display
// only. GET /api/admin/deleted-loads sends every figure (the months, whether
// each is closed); nothing here works one out. The server's role gate is the
// real control; canSeeDeletedLoads() only keeps the link and page from
// rendering for anyone else.
//
// Pure: no Vue, no network. The '.js' on the import is deliberate, so bare Node
// (scripts/test-deleted-loads-view.mjs) can import this file as well as Vite.

import { monthLabel } from './monthLabel.js'

export const DELETED_LOADS_ROLE = 'Super Admin'

// May this role see the link and the page?
export function canSeeDeletedLoads(role) {
  return role === DELETED_LOADS_ROLE
}

// "Deleted loads (3)"; plain "Deleted loads" while the count is unknown (still
// loading, or the list could not be read).
export function deletedLoadsLinkText(count) {
  return Number.isInteger(count) && count >= 0 ? `Deleted loads (${count})` : 'Deleted loads'
}

// "Springfield, IL 62701 → Riverton, WY 82501"; a missing side reads "—", and
// "—" alone when neither side is known.
export function deletedLoadRoute(load) {
  const pickup = String(load?.pickup || '').trim()
  const dropoff = String(load?.dropoff || '').trim()
  if (!pickup && !dropoff) return '—'
  return `${pickup || '—'} → ${dropoff || '—'}`
}

// One line per settlement month: { key, label: 'May 2026', closed, closedText: 'Yes' | 'No' }.
export function deletedLoadMonths(load) {
  const months = Array.isArray(load?.months) ? load.months : []
  return months.map((m) => ({
    key: String(m?.month || ''),
    label: monthLabel(m?.month) || String(m?.month || '—'),
    closed: m?.closed === true,
    closedText: m?.closed === true ? 'Yes' : 'No',
  }))
}

// Where the months came from, when it isn't the load's Job Tracking row.
export function deletedLoadMonthsNote(load) {
  return load?.monthsFrom === 'audit' ? 'From the delete record' : ''
}

// The page's error line: the server's own words for the two "can't read it"
// answers, otherwise a plain fallback.
export function deletedLoadsErrorText(err) {
  const code = err?.code || ''
  if ((code === 'SHEET_UNREADABLE' || code === 'PERIOD_LOCK_UNREADABLE') && err?.message) return err.message
  if (err?.status === 403) return 'Only a Super Admin can see deleted loads.'
  return 'The deleted loads could not be loaded. Try again in a moment.'
}

// ---------------------------------------------------------------- restoring
// DELETED_LOAD_RESTORE_ENABLED. The server decides every restore and refuses in
// its own words; these only show its answers. The type matches the server's
// (lib/deleted-load-restore.js NOTICE_TYPE).
export const HIDDEN_LOAD_NOTICE_TYPE = 'load-hidden-by-delete'

// May this role restore a deleted load? The server's role gate is the real control.
export function canRestoreDeletedLoads(role) {
  return role === DELETED_LOADS_ROLE
}

// The list answer turns Restore on only while the server's switch is on.
export function restoreIsOn(res) {
  return res?.restore?.enabled === true
}

export function restoreUrl(id) {
  return `/api/admin/deleted-loads/${encodeURIComponent(String(id))}/restore`
}

// The confirm before a restore: the load, who deleted it and when, and each
// month with whether it is closed (the server refuses a closed one).
export function restoreConfirm(load, deletedText) {
  const id = String(load?.loadId || '').trim() || '—'
  const by = String(load?.deletedBy || '').trim()
  const months = deletedLoadMonths(load)
  const lines = [`Deleted ${deletedText || '—'}${by ? ` by ${by}` : ''}.`]
  if (months.length) for (const m of months) lines.push(`${m.label}: ${m.closed ? 'closed' : 'open'}`)
  else lines.push('Month: not known')
  if (months.length && deletedLoadMonthsNote(load)) lines[lines.length - 1] += ' (from the delete record)'
  lines.push("Restoring puts it back on the dashboard and in its month's figures.")
  return { title: `Restore load ${id}?`, message: lines.join('\n') }
}

// The restore route's refusals, which carry their own words.
const RESTORE_CODES = new Set(['NOT_DELETED', 'NO_SHEET_ROW', 'PERIOD_FINALIZED', 'PERIOD_UNRESOLVED', 'PERIOD_LOCK_UNREADABLE',
  'SHEET_UNREADABLE', 'DELETED_LOAD_ID_INVALID', 'RESTORE_MODE_INVALID', 'RESTORE_FAILED'])
export function restoreErrorText(err) {
  if (RESTORE_CODES.has(err?.code || '') && err?.message) return err.message
  if (err?.status === 403) return 'Only a Super Admin can restore a deleted load.'
  if (err?.status === 0) return 'No answer from the server. Reload the list to see whether the load was restored.'
  return 'The load could not be restored. Try again in a moment.'
}

// After a restore: restored, its old delete cleared, or one delete of two undone.
export function restoreDoneText(answer, loadId) {
  const id = answer?.restored?.loadId || loadId || ''
  if (Number.isInteger(answer?.remaining) && answer.remaining > 0) {
    return `This delete of load ${id} is undone, but another delete of the same load still hides it. Restore that one too.`
  }
  return answer?.mode === 'create_new' ? `Load ${id}'s old delete is cleared; its row counts as a new load.` : `Load ${id} is restored.`
}

// A create the server refused because an old delete names its Load ID, with the
// choice it sends a Super Admin; null for anything else (a Dispatcher's carries none).
export function deletedLoadChoiceOf(err) {
  return err && err.code === 'LOAD_ID_DELETED' && err.data && Number.isInteger(err.data.tombstoneId) ? err.data : null
}

const EVIDENCE_TEXT = {
  deleted_with_no_row: 'it was deleted when no row held its Load ID',
  created_by_rate_con: 'a rate con created this Load ID after the delete',
  created_in_sheet_row: 'New Job or the Data Manager added this Load ID after the delete',
  created_by_n8n: 'the email workflow added this Load ID after the delete',
  row_changed: "its row isn't the one that was deleted",
}
export function hiddenEvidenceText(evidence) {
  const parts = (Array.isArray(evidence) ? evidence : []).map((e) => EVIDENCE_TEXT[e]).filter(Boolean)
  return parts.length ? `Why it shows: ${parts.join('; ')}.` : ''
}

// The words of the choice: who deleted the load and when, and what each choice
// does, or why it is off. `review`: from the dashboard banner, where a row exists.
export function deletedLoadChoiceView(choice, deletedText, { review = false } = {}) {
  const c = choice || {}
  const id = String(c.loadId || '').trim() || '—'
  const by = String(c.deletedBy || '').trim()
  const row = Number.isInteger(c.sheetRow) ? c.sheetRow : null
  const restoreOff = c.canRestore !== true
  const createOff = c.canCreateNew !== true
  let restoreNote = "Its Job Tracking row is gone, so there's nothing to restore."
  if (!restoreOff) restoreNote = review ? 'Brings the deleted load back: every row with this Load ID counts again.' : `Brings the deleted load back${row ? ` (row ${row})` : ''} and creates nothing new.`
  let createNote = review ? 'Clears the old delete, so the row counts as a new load.' : 'Clears the old delete and creates this load.'
  if (createOff) createNote = row ? `Row ${row} still holds this load: restore it instead, or remove that row first.` : "This Load ID was deleted more than once, so it can't be created as new here."
  return {
    title: `Load ${id} was deleted`,
    message: `Deleted ${deletedText || '—'}${by ? ` by ${by}` : ''}. ${review ? "Its row is on the sheet, but it doesn't count while that delete stands." : 'Choose what to do with this Load ID.'}`,
    why: hiddenEvidenceText(c.evidence),
    restoreOff,
    restoreNote,
    createOff,
    createNote,
  }
}

// A create sent again as the Super Admin chooses: send(choice) performs it; ask(choice, note) shows the choice and
// resolves { action: 'restored', answer }, { action: 'create_new' } or null. A refusal with no choice, or no one to
// ask, is thrown as it came; at most three sends.
export async function withDeletedLoadChoice(send, ask) {
  let choice = null
  for (let round = 0; ; round++) {
    try {
      return await send(choice)
    } catch (err) {
      const offered = deletedLoadChoiceOf(err)
      if (!offered || typeof ask !== 'function' || round >= 2) throw err
      const answer = await ask(offered, round ? err.message || '' : '')
      if (!answer) return { deletedLoadDeclined: true }
      if (answer.action === 'restored') return { deletedLoadRestored: true, answer: answer.answer, loadId: offered.loadId }
      choice = { action: 'create_new', id: offered.tombstoneId }
    }
  }
}

// ------------------------------------------------- the dashboard banner (add-on 3)
// GET /api/dashboard's hiddenLoads (a Super Admin's only), anything malformed left out.
export function hiddenLoadsOf(data) {
  return (Array.isArray(data?.hiddenLoads) ? data.hiddenLoads : []).filter((h) => h && Number.isInteger(h.tombstoneId))
}

export function hiddenLoadText(h, deletedText) {
  const by = String(h?.deletedBy || '').trim()
  return `Load ${String(h?.loadId || '').trim() || '—'} is hidden by an earlier delete (deleted${by ? ` by ${by}` : ''}${deletedText ? ` on ${deletedText}` : ''}).`
}

// The banner's Review: the same choice, both on, since the row is on the sheet.
export function hiddenLoadChoice(h) {
  return {
    loadId: h.loadId,
    tombstoneId: h.tombstoneId,
    deletedBy: h.deletedBy,
    deletedAt: h.deletedAt,
    sheetRow: Number.isInteger(h.sheetRow) ? h.sheetRow : null,
    canRestore: true,
    canCreateNew: true,
    evidence: Array.isArray(h.evidence) ? h.evidence : [],
  }
}
