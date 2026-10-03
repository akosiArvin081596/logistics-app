// Is a receipt's date plausible for one being filed now? One rule for every
// entry form: the driver's ExpenseForm, the admin Log Expense form and the
// bulk scan.
//
// A date far from the day it is filed is nearly always a typo or a misread
// year, and it files the money in the wrong month: two scale tickets bought on
// 2026-09-28 were filed the next day as 2023-09-28 and 2025-09-28, and a fuel
// receipt from 2026-07-15 was filed as 2017-07-15. Each form already showed a
// warning beside the date and saved anyway, so the forms now ask once before
// saving such a date. They ask, never block: a genuinely old receipt can still
// be filed.
//
// Asymmetric on purpose: a receipt cannot be from next week (one day of slack
// covers a timezone edge), but it can be four months old. A late-December
// receipt filed in early January is a different year and is not asked about.
//
// scripts/test-expense-finalized-status-client.mjs
import { fmtYmd } from '../utils/datetime.js'

export const RECEIPT_DATE_STALE_DAYS = 120

// '' (nothing to ask), 'future', 'old' (over 4 months, this year) or 'year'
// (over 4 months, another year). Blank and malformed dates are '' here: the
// forms require a date on their own.
export function receiptDateVerdict(ymd, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(d.getTime())) return ''
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days < -1) return 'future'
  if (days <= RECEIPT_DATE_STALE_DAYS) return ''
  return Number(m[1]) === now.getFullYear() ? 'old' : 'year'
}

// The question a form asks before saving, or '' when there is none. Plain
// text with line breaks (ConfirmModal renders it pre-line).
export function receiptDateQuestion(ymd, now = new Date()) {
  const verdict = receiptDateVerdict(ymd, now)
  if (!verdict) return ''
  const entered = `Date entered: ${fmtYmd(ymd)}.`
  if (verdict === 'future') return `${entered}\nThat is after today. Receipts can't be from the future.`
  if (verdict === 'old') return `${entered}\nThat is over 4 months old.`
  return `${entered}\nThat is in ${ymd.slice(0, 4)}, and today is in ${now.getFullYear()}. A wrong year puts the expense in the wrong month.`
}
