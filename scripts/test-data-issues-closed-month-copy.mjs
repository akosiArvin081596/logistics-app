#!/usr/bin/env node
/**
 * The Data Issues page never tells anyone to reopen a closed month to deal with
 * a duplicate receipt.
 *
 * WHAT IT REPRODUCES: a duplicate receipt in a closed month whose payout has not
 * been sent (the "closed · unpaid" group) was explained as "Reopen the month in
 * Payouts first", "Reopen the month, reject the copy, then close it again" and
 * "It needs the month reopened first", and the owner-questions card said the
 * recoverable ones "only need the month reopened". Closed months are never
 * reopened (standing rule, 2026-10-14).
 *
 * WHAT IS ASSERTED: for that group, voidBlockedReason() in lib/dataIssues.js,
 * remedyTitle() and the remedy key in views/DataIssuesView.vue, and the
 * duplicates card of the owner questions:
 *   - no "reopen" in any case, no "/api/";
 *   - the same correction the receipt status refusal gives: a Super Admin can
 *     correct an investor's payout with an adjustment on an open month in
 *     Payouts, and a company truck's closed month stays as recorded;
 *   - the month is named ("August 2026", not "2026-08") where a sentence names it.
 *
 * remedyTitle() is lifted out of the .vue file and run; the template and card
 * text are read from the source. Made-up data only.
 *
 * Pure: no server, no network.
 * Run: node scripts/test-data-issues-closed-month-copy.mjs    # exits 1 on failure
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { voidBlockedReason } = await import(pathToFileURL(path.join(ROOT, 'client/src/lib/dataIssues.js')).href)
const { monthLabel } = await import(pathToFileURL(path.join(ROOT, 'client/src/lib/monthLabel.js')).href)
const VIEW = fs.readFileSync(path.join(ROOT, 'client/src/views/DataIssuesView.vue'), 'utf8')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const ADJUST = /A Super Admin can correct an investor's payout with an adjustment on an open month in Payouts\./
const COMPANY = /A company truck's closed month stays as recorded\./

function checkCopy(label, text, { namesMonth = true } = {}) {
  const t = String(text || '')
  check(`${label}: no "reopen" in any case`, !/reopen/i.test(t), t)
  check(`${label}: no API path`, !t.includes('/api/'), t)
  check(`${label}: a Super Admin can adjust an investor's payout on an open month`, ADJUST.test(t), t)
  check(`${label}: a company truck's closed month stays as recorded`, COMPANY.test(t), t)
  if (namesMonth) check(`${label}: names the month`, /August 2026/.test(t) && !/2026-08/.test(t), t)
}

// ---- lib/dataIssues.js: why a closed-unpaid group offers no void ----------
{
  const group = { remedy: 'correctable', period: '2026-08', rows: [] }
  checkCopy('voidBlockedReason, closed and unpaid', voidBlockedReason(group))
  for (const remedy of ['settled', 'unknown']) {
    const t = voidBlockedReason({ remedy, period: '2026-08', rows: [] })
    check(`voidBlockedReason, ${remedy}: no "reopen" in any case`, !/reopen/i.test(t), t)
  }
}

// ---- DataIssuesView.vue: the chip's tooltip --------------------------------
{
  const start = VIEW.indexOf('function remedyTitle(g) {')
  const end = VIEW.indexOf('\n}\n', start)
  check('remedyTitle() found in the view', start > 0 && end > start)
  const remedyTitle = new Function('monthLabel', `return ${VIEW.slice(start, end + 2)}`)(monthLabel)
  checkCopy('remedyTitle, closed and unpaid', remedyTitle({ remedy: 'correctable', period: '2026-08' }))
  for (const remedy of ['open', 'settled', 'unknown']) {
    const t = remedyTitle({ remedy, period: '2026-08' })
    check(`remedyTitle, ${remedy}: no "reopen" in any case`, !/reopen/i.test(t), t)
  }
}

// ---- DataIssuesView.vue: the remedy key above the groups -------------------
{
  const line = VIEW.split('\n').find((l) => l.includes('remedy-chip remedy-correctable">closed'))
  check('the closed-unpaid remedy key found in the view', !!line)
  checkCopy('remedy key, closed and unpaid', line, { namesMonth: false })
}

// ---- DataIssuesView.vue: the owner-questions card for closed-month duplicates
{
  const start = VIEW.indexOf('// 4. The duplicates this page cannot settle.')
  const end = VIEW.indexOf("jumpTo: 'duplicates'", start)
  check('the duplicates card found in the view', start > 0 && end > start)
  const card = VIEW.slice(start, end)
  check('duplicates card: no "reopen" in any case', !/reopen/i.test(card), card.match(/.*reopen.*/gi)?.join(' | ') || '')
  check('duplicates card: names the adjustment and company trucks', ADJUST.test(card) && COMPANY.test(card), '')
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
