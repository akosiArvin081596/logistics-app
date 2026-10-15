#!/usr/bin/env node
// Load detail times on the loadboard (B14 leftover).
//
// The Job Board, Active Loads and Completed detail panels printed every sheet
// cell as stored, so a stamp read "10/12/2026 0:17:10" while the rest of the page
// says "10/12/2026, 12:17 AM". Each tab carried its own copy of detailValue();
// the one copy now lives in client/src/lib/loadDetail.js and passes a cell
// shaped like a date or time through fmtSheetMoment() (client/src/utils/datetime.js),
// which already decides how each kind shows:
//   - a bare sheet stamp (no zone): its wall clock as written, 12 h, no label,
//     never converted, whatever era it was written in;
//   - a value carrying its zone (ISO ...Z or an offset): US Eastern (APP_TIMEZONE)
//     with EDT/EST;
//   - a date-only value: the same calendar day, never through UTC.
// Anything else (addresses, money, load numbers, free text) prints as before.
//
//   §1 client/src/lib/loadDetail.js on a case table.
//   §2 the three tabs use it and keep no copy of their own.
//
// No network, no DOM, no build.
//   node scripts/test-load-detail-times.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'client', 'src')
const LIB_PATH = path.join(SRC, 'lib', 'loadDetail.js')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}

let lib
try {
  lib = await import(pathToFileURL(LIB_PATH).href)
} catch (err) {
  check('client/src/lib/loadDetail.js loads', String(err.message).split('\n')[0], 'loaded')
}

// ---------------------------------------------------------------------------
console.log('§1 lib/loadDetail.js')
// ---------------------------------------------------------------------------
if (lib) {
  const { detailValue, parseJsonCell } = lib
  const cell = (v) => detailValue({ C: v }, 'C')
  const SHOWN = [
    // A stamp written since 2026-10-09 (Eastern): shown as written, 12 h.
    ['10/12/2026 0:17:10', '10/12/2026, 12:17 AM'],
    ['10/12/2026 13:05', '10/12/2026, 1:05 PM'],
    ['10/14/2026 12:09:59', '10/14/2026, 12:09 PM'],
    ['10/12/2026, 9:51:00 PM', '10/12/2026, 9:51 PM'],
    ['10/12/2026 23:59:59', '10/12/2026, 11:59 PM'],
    ['10/12/2026 0:00', '10/12/2026, 12:00 AM'],
    // Older stamps (saved in Houston time, or UTC before 2026-08-03): the same
    // wall clock as written, no zone label, not converted.
    ['9/15/2026 14:05:00', '9/15/2026, 2:05 PM'],
    ['7/20/2026 23:59:59', '7/20/2026, 11:59 PM'],
    // A value that carries its zone: US Eastern, labelled.
    ['2026-10-12T04:17:10.000Z', 'Oct 12, 2026, 12:17 AM EDT'],
    ['2026-12-01T17:00:00Z', 'Dec 1, 2026, 12:00 PM EST'],
    ['2026-10-12T00:17:10-04:00', 'Oct 12, 2026, 12:17 AM EDT'],
    // Date only: the calendar day as written.
    ['2026-10-12', 'Oct 12, 2026'],
    ['2026-01-01', 'Jan 1, 2026'],
    ['10/12/2026', '10/12/2026'],
    ['09/05/2026', '9/5/2026'],
  ]
  check('date and time cells show like the rest of the page', SHOWN.map(([v]) => cell(v)), SHOWN.map(([, want]) => want))
  const UNCHANGED = [
    '$1,800.00', '540000001', '#540000001', '1 Main St, Dallas, TX 75201', 'Dry Van',
    // isZoned() would call these zoned (a trailing offset, a UTC/GMT word); they
    // aren't dates and print as written.
    'Truck 2-1200', 'Pickup before 10:00 UTC', 'GMT freight',
    // No zone on an ISO time: not a sheet stamp, print as written.
    '2026-10-12T00:17:10',
    '10/14/2026 08:00 - 12:00', '13/45/2026 0:17', 'TBD', '',
    // A clock no stamp can hold: hour 0-23, minute and second 0-59, else as stored.
    '10/12/2026 27:15', '10/12/2026 24:00', '10/12/2026 12:60', '10/12/2026 12:30:61',
  ]
  check('every other cell prints as written', UNCHANGED.map(cell), UNCHANGED)
  check('a number prints as the number', detailValue({ C: 1800 }, 'C'), 1800)
  check('a missing cell is blank', detailValue({}, 'C'), '')
  check('a JSON cell lists its non-blank entries, times shown the same way',
    cell('{"Name":"Acme DC","Appointment":"10/14/2026 8:00","Ref":"","Date":"2026-10-14"}'),
    'Name: Acme DC, Appointment: 10/14/2026, 8:00 AM, Date: Oct 14, 2026')
  check('parseJsonCell: an object cell, else null',
    [parseJsonCell('{"a":1}'), parseJsonCell('{bad'), parseJsonCell('x'), parseJsonCell(''), parseJsonCell(null), parseJsonCell(5)],
    [{ a: 1 }, null, null, null, null, null])
}

// ---------------------------------------------------------------------------
console.log('§2 the tabs')
// ---------------------------------------------------------------------------
const DASH = path.join(SRC, 'components', 'dashboard')
for (const file of ['JobBoardTab.vue', 'ActiveLoadsTab.vue', 'CompletedLoadsTab.vue']) {
  const src = fs.readFileSync(path.join(DASH, file), 'utf8')
  check(`${file}: imports detailValue and parseJsonCell from lib/loadDetail`,
    src.includes("import { parseJsonCell, detailValue } from '../../lib/loadDetail'"), true)
  check(`${file}: no copy of detailValue of its own`, /function detailValue\(/.test(src), false)
  check(`${file}: no copy of parseJsonCell of its own`, /function parseJsonCell\(/.test(src), false)
  check(`${file}: the detail sections read through detailValue`,
    (src.match(/value: detailValue\(selectedJob\.value, c\)/g) || []).length, 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
