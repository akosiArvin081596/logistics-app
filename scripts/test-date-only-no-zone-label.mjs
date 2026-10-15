#!/usr/bin/env node
// A date shown without a time carries no zone label (B14). The Invoices list's
// Submitted column read "Oct 9, 2026, EDT", as did the Applications list and the
// Users "Created" column: fmtAppInstant() was asked for a date only, and it
// always adds the zone. A date-only display of an instant is fmtAppDate(): the
// day it falls on in APP_TIMEZONE (US Eastern), with no label, so it is the same
// day for every viewer and reads like every other date in the app.
//
//   §1 the three sites call fmtAppDate() for their date-only column, and still
//      show the Eastern day (an instant late on Friday evening Eastern is
//      Friday, not Saturday as it already is in Manila or UTC)
//   §2 nothing in client/src asks fmtAppInstant() for a date without a time
//      (an options object naming month/day/year/weekday and no hour, minute or
//      second); a call with no options gets the default date-and-time format
//
// No DOM, no server. Files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-date-only-no-zone-label.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-date-only-no-zone-label.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const SRC = path.join(ROOT, 'client', 'src')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const dt = await import(pathToFileURL(path.join(SRC, 'utils', 'datetime.js')).href)

// ══ §1 the three sites ═══════════════════════════════════════════════════════
const SITES = [
  ['client/src/views/InvoicesView.vue', "fmtAppDate(d, { fallback: '' })"],
  ['client/src/views/ApplicationsView.vue', "fmtAppDate(d, { fallback: '' })"],
  ['client/src/components/users/UserTable.vue', 'fmtAppDate(dateStr, { fallback: dateStr })'],
]
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'(?:@\/|(?:\.\.?\/)+)utils\/datetime(?:\.js)?'/
for (const [rel, call] of SITES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const m = IMPORT_RE.exec(src)
  const named = new Set(m ? m[1].split(',').map((s) => s.trim()) : [])
  ok(`§1 ${path.basename(rel)} imports fmtAppDate from utils/datetime`, named.has('fmtAppDate'))
  ok(`§1 ${path.basename(rel)}: formatDate() calls ${call}`, src.includes(call))
}
// The value those sites now show, for made-up instants:
//   2026-10-09T23:00:00Z = Fri Oct 9, 7:00 PM EDT (the weekly invoice batch)
//   2026-10-10T02:30:00Z = Fri Oct 9, 10:30 PM EDT (already Saturday in UTC and Manila)
//   2026-11-07T04:30:00Z = Fri Nov 6, 11:30 PM EST (after the clocks go back)
ok('§1 the Eastern day, no label', [
  dt.fmtAppDate('2026-10-09T23:00:00Z', { fallback: '' }),
  dt.fmtAppDate('2026-10-10T02:30:00Z', { fallback: '' }),
  dt.fmtAppDate('2026-11-07T04:30:00Z', { fallback: '' }),
].join(' | ') === 'Oct 9, 2026 | Oct 9, 2026 | Nov 6, 2026')
ok('§1 nothing, or something unreadable, gives the fallback', [dt.fmtAppDate('', { fallback: '' }), dt.fmtAppDate(null, { fallback: 'x' }), dt.fmtAppDate('garbage', { fallback: 'garbage' })].join('|') === '|x|garbage')

// ══ §2 no date-only fmtAppInstant() anywhere in client/src ═══════════════════
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(vue|js|mjs|ts)$/.test(e.name) ? [p] : []
  })
}
// Each fmtAppInstant( … ) call's argument text, up to its matching ")".
function calls(src) {
  const out = []
  let at = src.indexOf('fmtAppInstant(')
  while (at !== -1) {
    let depth = 0
    let i = at + 'fmtAppInstant'.length
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push({ args: src.slice(at + 'fmtAppInstant('.length, i), line: src.slice(0, at).split('\n').length })
    at = src.indexOf('fmtAppInstant(', i)
  }
  return out
}
const DATE_FIELD = /\b(?:month|day|year|weekday)\s*:/
const TIME_FIELD = /\b(?:hour|minute|second|dayPeriod|timeStyle)\s*:/
const dateOnly = []
let scanned = 0
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  if (rel === 'client/src/utils/datetime.js') continue // the helper's own definition and examples
  for (const c of calls(fs.readFileSync(file, 'utf8'))) {
    scanned++
    if (DATE_FIELD.test(c.args) && !TIME_FIELD.test(c.args)) dateOnly.push(`${rel}:${c.line}`)
  }
}
ok(`§2 the scan found the fmtAppInstant() calls (${scanned})`, scanned > 5)
ok(`§2 no fmtAppInstant() call asks for a date without a time (${dateOnly.join(', ') || 'none'})`, dateOnly.length === 0)

console.log(`\ndate-only-no-zone-label: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
