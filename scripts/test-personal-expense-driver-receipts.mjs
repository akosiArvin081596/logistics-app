#!/usr/bin/env node
// Personal receipts (R3): the driver app lists EVERY receipt of the driver's,
// including one filed with no load.
//
// WHY THIS EXISTS. The driver app showed a receipt only on its load's page
// (expensesForLoad() in client/src/lib/loadId.js). A receipt filed with no load
// (an admin logs one from the Expenses screen) was on no screen at all, and a
// Personal one with no load was the case the 2026-10-15 flag-on check found: the
// driver saw "-$X Personal" on his invoice and could not find the receipt behind
// it. The same held for a receipt filed against a load his lists no longer hold.
//
// What this pins:
//   §1 expensesOffLoads() (client/src/lib/loadId.js): the receipts filed against
//      none of the given loads (no load, or a load not in the list), in their
//      order, compared as expensesForLoad() compares, so every receipt is under
//      its load's page or in this list, never both and never neither; it only
//      filters the receipts it is given.
//   §2 the driver store's receiptsOffLoads getter, lifted from
//      client/src/stores/driver.js and run: the payload's receipts that no load
//      in the driver's lists (Active, Pending, History) shows.
//   §3 the Invoices tab lists them with the receipt card (which prints the
//      server's Personal text) and a receipt preview, from that getter only.
//   §4 the payload's receipts are the driver's own and only his: the driver
//      route's expenses query, lifted from server.js and run on an in-memory
//      SQLite, returns his no-load Personal receipt and never another driver's.
//
// No network, no DOM, no browser. §4 needs node_modules (better-sqlite3), which
// CI installs before the unit runners.
//   node scripts/test-personal-expense-driver-receipts.mjs   # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(path.join(ROOT, 'server.js'))
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${label}`); return }
  fail++
  console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
}
const section = (t) => console.log(`\n${t}`)

// The balanced {...} block starting at the first "{" at/after `from`, skipping
// strings and comments.
function balancedBlock(src, from) {
  const start = src.indexOf('{', from)
  if (from < 0 || start < 0) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) return null; continue }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return null; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return null
}
// The template's text without its <!-- ... --> comments, scanned left to right
// (an unterminated comment is kept as written).
const stripHtmlComments = (s) => {
  let out = ''
  let i = 0
  for (;;) {
    const open = s.indexOf('<!--', i)
    if (open === -1) return out + s.slice(i)
    const close = s.indexOf('-->', open + 4)
    if (close === -1) return out + s.slice(i)
    out += s.slice(i, open)
    i = close + 3
  }
}

const loadIdLib = await import(pathToFileURL(path.join(ROOT, 'client/src/lib/loadId.js')).href)
const { expensesOffLoads } = loadIdLib
const haveHelper = typeof expensesOffLoads === 'function'
const off = (...args) => (haveHelper ? expensesOffLoads(...args) : null)
const ids = (list) => (Array.isArray(list) ? list.map((e) => e.id) : list)

// The driver payload's shape: `loadId` (the server aliases load_id), and a
// Personal summary on a receipt that carries a line.
const PERSONAL = { line_id: 7, state: 'invoiced', amount_text: '$45.00', week_label: 'Oct 10-16', invoice_number: '', can_undo: false }
const RECEIPTS = [
  { id: 1, loadId: 'L1', type: 'Fuel', amount: 200, personal: null },
  { id: 2, loadId: '', type: 'Other', amount: 45, personal: PERSONAL },
  { id: 3, loadId: '#L2', type: 'Fuel', amount: 300, personal: null },
  { id: 4, loadId: 'L9', type: 'Toll', amount: 12, personal: null },
  { id: 5, loadId: null, type: 'Food', amount: 30, personal: null },
  { id: 6, load_id: 'L3', type: 'Fuel', amount: 80, personal: null },
]

section('§1 expensesOffLoads(): the receipts no listed load shows')
{
  check('the helper exists in client/src/lib/loadId.js', haveHelper, true)
  check('no load (blank or null) and a load not in the list are listed; listed loads are not', ids(off(RECEIPTS, ['L1', 'L2', 'L3'])), [2, 4, 5])
  check('the Personal receipt with no load is among them, as sent', (off(RECEIPTS, ['L1', 'L2', 'L3']) || []).find((e) => e.id === 2) || null, RECEIPTS[1])
  check('compared like expensesForLoad(): "#L2" is load L2, case and spaces ignored', ids(off(RECEIPTS, [' l1 ', 'l2', '#L3'])), [2, 4, 5])
  check('a blank load id in the list never claims a no-load receipt', ids(off(RECEIPTS, ['', null, 'L1', 'L2', 'L3'])), [2, 4, 5])
  check('no loads at all: every receipt', ids(off(RECEIPTS, [])), [1, 2, 3, 4, 5, 6])
  check('loads not an array: every receipt', ids(off(RECEIPTS, undefined)), [1, 2, 3, 4, 5, 6])
  check('receipts not an array: none', ids(off(null, ['L1'])), [])
  if (haveHelper) {
    const list = ['L1', 'L2', 'L3']
    const under = new Set(list.flatMap((l) => loadIdLib.expensesForLoad(RECEIPTS, l).map((e) => e.id)))
    const offIds = new Set(ids(off(RECEIPTS, list)))
    check('every receipt is under exactly one of: its load\'s page, this list',
      RECEIPTS.map((e) => Number(under.has(e.id)) + Number(offIds.has(e.id))), [1, 1, 1, 1, 1, 1])
    const out = off(RECEIPTS, list)
    check('it only filters what it is given (the same objects, nothing added)', out.every((e) => RECEIPTS.includes(e)), true)
  }
}

section('§2 the driver store\'s receiptsOffLoads getter')
{
  const store = read('client/src/stores/driver.js')
  const at = store.search(/\n\s{4}receiptsOffLoads\(state\)\s*\{/)
  const block = at >= 0 ? balancedBlock(store, at) : null
  check('the getter exists', !!block, true)
  check('the store imports the helper from lib/loadId', /import\s*\{[^}]*\bexpensesOffLoads\b[^}]*\}\s*from\s*'\.\.\/lib\/loadId'/.test(store), true)
  if (block && haveHelper) {
    const findCol = (headers, regex) => (headers || []).find((h) => regex.test(h)) || null
    const getter = new Function('state', 'findCol', 'expensesOffLoads', block.slice(1, -1))
    const load = (id, status) => ({ 'Load ID': id, 'Job Status': status })
    const lists = {
      workingLoads: [load('L1', 'In Transit')],
      pendingLoads: [load('L2', 'Dispatched')],
      historicalLoads: [load('L3', 'Delivered')],
    }
    const state = {
      headers: { jobTracking: ['Load ID', 'Driver', 'Job Status'] },
      // L9 is in the payload but in no list the app shows (an unlisted status).
      loads: [...lists.workingLoads, ...lists.pendingLoads, ...lists.historicalLoads, load('L9', 'Odd Status')],
      expenses: RECEIPTS,
    }
    check('the no-load receipts, and one on a load no list shows', ids(getter.call(lists, state, findCol, expensesOffLoads)), [2, 4, 5])
    check('no load id column: every receipt (no load page lists any)',
      ids(getter.call(lists, { ...state, headers: { jobTracking: ['Driver', 'Job Status'] } }, findCol, expensesOffLoads)), [1, 2, 3, 4, 5, 6])
    check('no receipts: none', ids(getter.call(lists, { ...state, expenses: [] }, findCol, expensesOffLoads)), [])
  }
  check('it reads the receipts from state.expenses only (the payload\'s, the driver\'s own)',
    block ? [/state\.expenses/.test(block), /api\./.test(block)] : null, [true, false])
}

section('§3 the Invoices tab lists them')
{
  const sfc = read('client/src/components/driver/InvoiceTab.vue')
  const tpl = stripHtmlComments(sfc.slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>')))
  const script = sfc.slice(sfc.indexOf('<script setup>'), sfc.indexOf('</script>'))
  check('the list comes from the store getter', /driverStore\.receiptsOffLoads\b/.test(script), true)
  check('each receipt shows on the receipt card, which prints the server\'s Personal text',
    [/<ExpenseCard\b[^>]*v-for="\w+ in otherReceipts"/.test(tpl), /import ExpenseCard from '\.\/ExpenseCard\.vue'/.test(script),
      /personalDriverText\(props\.expense\.personal\)/.test(read('client/src/components/driver/ExpenseCard.vue'))], [true, true, true])
  check('a tap on a receipt opens it (the preview the load page uses)',
    [/@preview="receiptPreview = \$event"/.test(tpl), /<ZoomableImage :src="receiptPreview"/.test(tpl)], [true, true])
  check('the section names what it holds and how many', [/Other Receipts/.test(tpl), /otherReceipts\.length/.test(tpl)], [true, true])
}

section('§4 the payload\'s receipts are the driver\'s own, with or without a load')
{
  const src = read('server.js')
  const m = src.match(/const driverExpenses = db\s*\.prepare\(\s*`([\s\S]*?)`,?\s*\)\s*\.all\(nameLower\);/)
  check('the driver route\'s expenses query is found', !!m, true)
  if (m) {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY, timestamp TEXT, driver TEXT, load_id TEXT DEFAULT '', type TEXT, amount REAL,
      description TEXT DEFAULT '', date TEXT, photo_data TEXT DEFAULT '', status TEXT DEFAULT 'Pending', location_city TEXT DEFAULT '', location_state TEXT DEFAULT '')`)
    const put = db.prepare('INSERT INTO expenses (id, timestamp, driver, load_id, type, amount, date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    put.run(1, 't', 'Test Driver A', 'L1', 'Fuel', 200, '2026-10-12', 'Approved')
    put.run(2, 't', 'Test Driver A', '', 'Other', 45, '2026-10-13', 'Approved')
    put.run(3, 't', 'Test Driver B', '', 'Food', 30, '2026-10-13', 'Approved')
    put.run(4, 't', 'Test Driver B', 'L1', 'Fuel', 99, '2026-10-12', 'Approved')
    const rows = db.prepare(m[1]).all('test driver a')
    check('his receipts, the no-load one included; never another driver\'s', rows.map((r) => [r.id, r.loadId]).sort((a, b) => a[0] - b[0]), [[1, 'L1'], [2, '']])
    db.close()
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
