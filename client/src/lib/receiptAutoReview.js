// Receipts auto-approve on the admin Expenses screen: words for the list's `auto_review` (on mode
// only) and `status_by` (the recorder). The server decides every state and value; this only words
// them. scripts/test-expense-finalized-status-client.mjs pins the codes and names to the server's.
import { expenseStatusChangeable } from './expenseStatus.js'
import { fmtYmd } from '../utils/datetime.js'

// The pass's account in the "who set it" record, and the status filter's value.
export const AUTO_APPROVE_ACCOUNT = 'receipt-auto-approve'
export const AUTO_APPROVED_FILTER = 'Approved automatically'

// Each rule's words after "Needs a person: ", without values (the report's counts).
export const AUTO_REVIEW_REASONS = Object.freeze({
  NO_ELD_FILL: 'no ELD fill matched',
  ADJACENT_DAY: 'the ELD fill was on another day',
  PLACE_FAR: "the fill was over 50 km away, or the place came from the truck's GPS",
  TRUCK_UNSET: 'no truck on the receipt',
  TRUCK_NOT_HELD: "the driver didn't hold this truck that day",
  TRUCK_CHANGE_DAY: 'a truck change within a day of it',
  OWNER_MISMATCH: "the receipt's owner isn't the truck's owner",
  DUPLICATE: 'it may be a duplicate',
  OVERRIDDEN: 'a person marked it a separate purchase',
  PRICE: "the price per gallon is outside the fleet's range",
  NO_PHOTO: 'no receipt file to read',
  OCR_TOTAL: "the receipt's total differs or couldn't be read",
  OCR_DATE: "the receipt's date differs or couldn't be read",
  OCR_GALLONS: "the receipt's gallons differ or couldn't be read",
  OCR_PLACE: "the receipt's state differs or couldn't be read",
  OCR_BRAND: 'the brand on the receipt differs from the vendor',
  OCR_LOW: 'the receipt was hard to read',
  SAME_PAPER: 'it has the same printed transaction as another receipt',
  OCR_MIXED: "the ticket isn't fuel only, or its total isn't gallons times price",
  OCR_UNREAD: "the receipt couldn't be read after several tries",
  NOT_FUEL: 'not a fuel receipt',
})

// Why the pass didn't write an approval it reached (the report's counts).
export const AUTO_NOT_APPLIED = Object.freeze({
  taken_by_person: 'a person set it first',
  person_decided: 'a person had decided it',
  month_closed: 'its month closed or came due for close',
  personal_line: 'it was marked Personal',
  gone: 'the receipt was deleted',
})

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const money = (v) => `$${v.toFixed(2)}`
const entered = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function reasonShort(code) {
  return typeof code === 'string' && Object.hasOwn(AUTO_REVIEW_REASONS, code) ? AUTO_REVIEW_REASONS[code] : String(code || '')
}

// A held receipt's reason, with the values the server sent where they say more.
export function reasonText(code, ar, e) {
  const read = ar && ar.read && typeof ar.read === 'object' ? ar.read : null
  switch (code) {
    case 'PLACE_FAR':
      if (String((e && e.location_source) || '').toLowerCase() === 'eld') return "the receipt's place came from the truck's GPS"
      return ar && isNum(ar.km) ? `the fill was ${ar.km} km away` : 'no distance to the fill'
    case 'OCR_TOTAL': {
      if (!read || !isNum(read.amount)) return "the receipt's total couldn't be read"
      const own = entered(e && e.amount)
      return own == null ? `the receipt reads ${money(read.amount)}` : `the receipt reads ${money(read.amount)}, the entry says ${money(own)}`
    }
    case 'OCR_DATE':
      return read && read.date ? `the receipt is dated ${fmtYmd(read.date)}` : "the receipt's date couldn't be read"
    case 'OCR_GALLONS':
      return read && isNum(read.gallons) ? `the receipt reads ${read.gallons} gal` : "the receipt's gallons couldn't be read"
    case 'OCR_PLACE':
      return read && read.state ? `the receipt reads ${read.state}` : "the receipt's state couldn't be read"
    default:
      return reasonShort(code)
  }
}

// "ELD fill #12 the same day, 4.2 km away; the receipt reads $412.00, Oct 3, 2026, 98.5 gal, TX"
export function autoEvidenceText(ar) {
  if (!ar || typeof ar !== 'object') return ''
  const parts = []
  if (ar.fill) parts.push(`ELD fill #${ar.fill} the same day${isNum(ar.km) ? `, ${ar.km} km away` : ''}`)
  const r = ar.read && typeof ar.read === 'object' ? ar.read : null
  if (r) {
    const seen = [
      isNum(r.amount) ? money(r.amount) : '',
      r.date ? fmtYmd(r.date) : '',
      isNum(r.gallons) ? `${r.gallons} gal` : '',
      r.state || '',
    ].filter(Boolean)
    if (seen.length) parts.push(`the receipt reads ${seen.join(', ')}`)
  }
  return parts.join('; ')
}

// The list's `autoApprove.mode`: 'on', 'shadow', or 'off' when the server sent none.
export function autoApproveModeOf(data) {
  const mode = data && data.autoApprove && data.autoApprove.mode
  return mode === 'on' || mode === 'shadow' ? mode : 'off'
}

// The line under a receipt's status (kind checking, held, auto or by), or null. A verdict shows
// only in on mode, on a status a person can still change; an empty record names nobody, so an
// Approved receipt without one gets no "Approved by".
export function autoReviewLine(e, mode = 'off') {
  if (!e || typeof e !== 'object') return null
  const status = e.status || 'Pending'
  const ar = mode === 'on' && e.auto_review && typeof e.auto_review === 'object' ? e.auto_review : null
  if (status === 'Pending') {
    if (!ar || !expenseStatusChangeable(e)) return null
    if (ar.state === 'checking') {
      return { kind: 'checking', label: 'Checking automatically', detail: 'The automatic check is waiting for the ELD fill or for its read of the receipt. A person can still approve or reject it.', reasons: [] }
    }
    if (ar.state === 'held') {
      const reasons = (Array.isArray(ar.reasons) ? ar.reasons : []).map((c) => reasonText(c, ar, e)).filter(Boolean)
      const list = reasons.length ? reasons : ['the rules held it']
      return { kind: 'held', label: `Needs a person: ${list.join('; ')}`, detail: `The automatic check left this receipt for a person: ${list.join('; ')}.`, reasons: list }
    }
    return null
  }
  if (status !== 'Approved') return null
  if (ar && ar.state === 'auto') {
    const evidence = autoEvidenceText(ar)
    return { kind: 'auto', label: 'Approved automatically', detail: evidence ? `Approved automatically: ${evidence}.` : 'Approved automatically.', reasons: [] }
  }
  const by = e.status_by && typeof e.status_by === 'object' ? e.status_by : null
  const name = by && typeof by.name === 'string' ? by.name : ''
  if (!name) return null
  if (by.role === 'system' && name === AUTO_APPROVE_ACCOUNT) {
    return { kind: 'auto', label: 'Approved automatically', detail: 'Approved automatically.', reasons: [] }
  }
  const role = typeof by.role === 'string' && by.role ? `the ${by.role} account ` : 'the account '
  return { kind: 'by', label: `Approved by ${name}`, detail: `Approved by ${role}${name}. A shared login names an account, not a person.`, reasons: [], at: typeof by.at === 'string' ? by.at : '' }
}

// A person's status change made here: the row takes the new status at once, and
// its old record and verdict go until the server's reload, so neither is shown
// against a status it no longer describes. Fields the server never sent stay absent.
export function localStatusChange(e, status) {
  const out = { status }
  if (e && 'status_by' in e) out.status_by = null
  if (e && 'auto_review' in e) out.auto_review = null
  return out
}
