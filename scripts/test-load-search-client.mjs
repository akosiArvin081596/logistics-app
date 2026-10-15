#!/usr/bin/env node
// client/src/lib/loadSearch.js: the one matcher the dashboard's Job Board,
// Active Loads and Completed tabs search with (B19).
//
// The server attaches `_refs: [{ label, value }]` to each row it serves (Order #,
// PO #, Move #, labelled Pickup / Drop-off references, BOL #; built by
// lib/load-search-refs.js). This runner pins the browser half:
//   §1 normalizeRef() is the server's rule, character for character, on one case
//      table (the lib is required here too), with a sabotage control that proves
//      the comparison can fail.
//   §2 Load ID: substring of the normalized Load ID at any query length, so "#X"
//      and "X" find each other.
//   §3 references: only once the normalized query has 4+ characters, from the
//      start of the value, never in the middle; leading zeros optional on either
//      side; the result names the label and the value as written.
//   §4 searchLoads(): the rows a tab shows and the chip for each.
//
// Every number below is made up (public repo). No network, no DB.
//   node scripts/test-load-search-client.mjs      # exits 1 on any failure

import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const CLIENT_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'loadSearch.js')
const LIB_PATH = path.join(__dirname, '..', 'lib', 'load-search-refs.js')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}

let client, lib
try {
  client = await import(pathToFileURL(CLIENT_PATH).href)
  lib = require(LIB_PATH)
} catch (err) {
  console.log(`FAIL  client/src/lib/loadSearch.js and lib/load-search-refs.js load (${String(err.message).split('\n')[0]})`)
  console.log('\n0 passed, 1 failed')
  process.exit(1)
}
const { normalizeRef, matchLoad, searchLoads, refChipText, SEARCH_PLACEHOLDER, SEARCH_PLACEHOLDER_PHONE } = client

// ---------------------------------------------------------------------------
console.log('§1 normalizer parity with the server')
// ---------------------------------------------------------------------------
const CASES = [
  '#540000001', '540000001', ' 004-0123456 ', '004.0123456', 'AB-12.34', 'ab 12\t34', 'Ref#9',
  '7000001  -', '', '   ', '#', '--..##', 'ÄB12', 'PO # 2700011', 'x\ny', 'ＡＢ12', null, undefined, 0, 77,
]
check('normalizeRef: the client and the server agree on every case',
  CASES.filter((c) => normalizeRef(c) !== lib.normalizeRef(c)).map(String), [])
check('normalizeRef: the rule itself (drop #, whitespace, - and .; lowercase)',
  ['#540000001', ' 004-0123456 ', 'AB-12.34', 'ab 12\t34', null].map(normalizeRef),
  ['540000001', '0040123456', 'ab1234', 'ab1234', ''])
{
  // Sabotage control: a normalizer that keeps "-" must be reported.
  const keepsDash = (v) => String(v == null ? '' : v).toLowerCase().replace(/[#\s.]/g, '')
  check('control: a drifted copy is caught by the same comparison',
    CASES.some((c) => keepsDash(c) !== lib.normalizeRef(c)), true)
}

// ---------------------------------------------------------------------------
console.log('§2 Load ID')
// ---------------------------------------------------------------------------
const COL = 'Load ID'
const r = (loadId, refs) => (refs ? { [COL]: loadId, _refs: refs } : { [COL]: loadId })
check("'#540000001' finds '540000001'", matchLoad(r('540000001'), '#540000001', COL), { via: null })
check("'540000001' finds '#540000001'", matchLoad(r('#540000001'), '540000001', COL), { via: null })
check('a substring of the Load ID at any length (1-3 characters too)',
  ['5', '40', '000', '0001'].map((q) => matchLoad(r('#540000001'), q, COL)),
  [{ via: null }, { via: null }, { via: null }, { via: null }])
check('case is ignored', matchLoad(r('LX5400A'), 'x54', COL), { via: null })
check('no match: null', matchLoad(r('540000001'), '541', COL), null)
check('no Load ID column: a reference can still match', matchLoad({ _refs: [{ label: 'PO #', value: '2700011' }] }, '2700011', ''),
  { via: { label: 'PO #', value: '2700011' } })

// ---------------------------------------------------------------------------
console.log('§3 references')
// ---------------------------------------------------------------------------
const DASHED = r('80000001', [{ label: 'XID', value: '004-0123456' }])
check("a value shaped '004-0123456' matches pasted whole",
  matchLoad(DASHED, '004-0123456', COL), { via: { label: 'XID', value: '004-0123456' } })
check('...typed without dashes', matchLoad(DASHED, '0040123456', COL), { via: { label: 'XID', value: '004-0123456' } })
check('...typed without its leading zeros', matchLoad(DASHED, '40123456', COL), { via: { label: 'XID', value: '004-0123456' } })
check('...or a prefix of either form, 4+ characters', [matchLoad(DASHED, '0040', COL), matchLoad(DASHED, '4012', COL)],
  [{ via: { label: 'XID', value: '004-0123456' } }, { via: { label: 'XID', value: '004-0123456' } }])
check('a value stored without zeros matches a query that has them',
  matchLoad(r('80000001', [{ label: 'PO #', value: '40123456' }]), '0040123456', COL), { via: { label: 'PO #', value: '40123456' } })
check('never in the middle', ['0123456', '123456', '3456'].map((q) => matchLoad(DASHED, q, COL)), [null, null, null])
check('1-3 character queries match the Load ID only',
  ['0', '00', '004', '401'].map((q) => matchLoad(r('99999999', [{ label: 'XID', value: '004-0123456' }]), q, COL)), [null, null, null, null])
check('a query of zeros never matches every value', matchLoad(r('99999999', [{ label: 'PO #', value: '1234567' }]), '0000', COL), null)
check("'#' and spaces in the query are ignored for references too",
  matchLoad(r('99999999', [{ label: 'Order #', value: '7000002' }]), '# 7000 002', COL), { via: { label: 'Order #', value: '7000002' } })
check('the Load ID wins over a reference (no chip needed)',
  matchLoad(r('70000021', [{ label: 'Order #', value: '7000002' }]), '7000002', COL), { via: null })
check('the first matching reference is named',
  matchLoad(r('99999999', [{ label: 'PO #', value: '2700011' }, { label: 'DEL #', value: '2700012' }]), '27000', COL),
  { via: { label: 'PO #', value: '2700011' } })
check('missing or malformed _refs never throw and never match',
  [matchLoad({ [COL]: '1', _refs: 'x' }, '12345', COL), matchLoad({ [COL]: '1', _refs: [null, {}, { label: 'PO #' }] }, '12345', COL), matchLoad(null, '12345', COL)],
  [null, null, null])

// ---------------------------------------------------------------------------
console.log('§4 searchLoads() and the chip')
// ---------------------------------------------------------------------------
const ROWS = [
  r('80000001', [{ label: 'Order #', value: '7000002' }]),
  r('#80000002', [{ label: 'XID', value: '004-0123456' }]),
  r('80000003'),
]
{
  const all = searchLoads(ROWS, '   ', COL)
  check('an empty or blank query: every row, no chip', [all.rows.length, all.via.size], [3, 0])
  const byOrder = searchLoads(ROWS, '7000002', COL)
  check('a reference query: the matching row, with its chip',
    [byOrder.rows.map((x) => x[COL]), refChipText(byOrder.via.get(ROWS[0]))], [['80000001'], 'Order # 7000002'])
  const byId = searchLoads(ROWS, '#80000002', COL)
  check('a Load ID query: the row, no chip', [byId.rows.map((x) => x[COL]), byId.via.size], [['#80000002'], 0])
  const none = searchLoads(ROWS, '5555', COL)
  check('no match: no rows', none.rows.length, 0)
  check('rows keep their order and identity', searchLoads(ROWS, '8000', COL).rows.every((x, i) => x === ROWS[i]), true)
  check('not an array: no rows, no throw', searchLoads(undefined, '1', COL).rows, [])
}
check('refChipText: "{label} {value}", blank for no reference',
  [refChipText({ label: 'PO #', value: '2700011' }), refChipText(null), refChipText(undefined)], ['PO # 2700011', '', ''])
check('placeholders', [SEARCH_PLACEHOLDER, SEARCH_PLACEHOLDER_PHONE], ['Search load, order, PO, move or ref #', 'Load or ref #'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
