#!/usr/bin/env node
// Loadboard paging (R8, owner request).
//
// Active Loads shows every active load on one page and pages only above 50, with
// no size choice. Job Board and Completed default to 25 a page with a
// 10/25/50/100 choice, remembered per user and per tab in localStorage; every
// storage read and write is wrapped, so the page works without storage. Search
// (lib/loadSearch.js) still runs on every row, and a new search goes back to
// page 1.
//
//   §1 client/src/lib/loadboardPaging.js: sizes, the storage key, read and save
//      (valid, invalid, missing, throwing storage).
//   §2 client/src/composables/useLoadboardPaging.js under plain Node with the
//      client's Vue: the saved size, saving a choice, the reset to page 1, a
//      shrinking list, Active Loads' fixed 50, and no storage at all.
//   §3 the three tabs use the composable (and nothing slices before the search).
//   §4 PaginationBar: the sizes it offers, a size choice that stays on one page,
//      and controls that wrap at phone width.
//
// No network, no DOM, no build.
//   node scripts/test-loadboard-paging.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..', 'client')
const SRC = path.join(CLIENT_DIR, 'src')
const LIB_PATH = path.join(SRC, 'lib', 'loadboardPaging.js')
const COMPOSABLE_PATH = path.join(SRC, 'composables', 'useLoadboardPaging.js')
const VUE_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'vue', 'index.mjs')).href

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
function finish() {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// In-memory Storage; `calls` records every getItem/setItem.
function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed))
  const calls = []
  return {
    calls,
    data,
    getItem(k) { calls.push(['get', k]); return data.has(k) ? data.get(k) : null },
    setItem(k, v) { calls.push(['set', k, v]); data.set(k, String(v)) },
  }
}
function throwingStorage() {
  return {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('QuotaExceededError') },
  }
}
function setGlobalStorage(value) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
}
function setThrowingGlobalStorage() {
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError') }, configurable: true })
}
function clearGlobalStorage() {
  delete globalThis.localStorage
}

let lib
try {
  lib = await import(pathToFileURL(LIB_PATH).href)
} catch (err) {
  check('client/src/lib/loadboardPaging.js loads', String(err.message).split('\n')[0], 'loaded')
}

// ---------------------------------------------------------------------------
console.log('§1 lib/loadboardPaging.js')
// ---------------------------------------------------------------------------
if (lib) {
  const { LOADBOARD_PAGE_SIZES, LOADBOARD_DEFAULT_PAGE_SIZE, ACTIVE_LOADS_PAGE_SIZE, pageSizeKey, readPageSize, savePageSize, browserStorage } = lib
  check('the choice is 10/25/50/100', LOADBOARD_PAGE_SIZES, [10, 25, 50, 100])
  check('the default is 25', LOADBOARD_DEFAULT_PAGE_SIZE, 25)
  check('Active Loads pages only above 50', ACTIVE_LOADS_PAGE_SIZE, 50)
  check('the sizes cannot be changed by a caller', Object.isFrozen(LOADBOARD_PAGE_SIZES), true)

  check('the key names the tab and the user',
    [pageSizeKey('jobBoard', 7), pageSizeKey('completed', '12')],
    ['logisx.loadboard.pageSize.jobBoard.u7', 'logisx.loadboard.pageSize.completed.u12'])
  check('no user or no tab: no key (the choice lasts until the page reloads)',
    [pageSizeKey('jobBoard', null), pageSizeKey('jobBoard', undefined), pageSizeKey('jobBoard', ''), pageSizeKey('', 7)],
    [null, null, null, null])

  const key = pageSizeKey('jobBoard', 7)
  check('a saved size in the choice is read back',
    [10, 25, 50, 100].map((n) => readPageSize(memoryStorage({ [key]: String(n) }), key)), [10, 25, 50, 100])
  check('anything else reads as 25',
    ['5', '7', '1000', 'abc', '', '-25', '25px'].map((v) => readPageSize(memoryStorage({ [key]: v }), key)),
    [25, 25, 25, 25, 25, 25, 25])
  check('nothing saved, no storage, no key: 25',
    [readPageSize(memoryStorage(), key), readPageSize(null, key), readPageSize(memoryStorage({ [key]: '50' }), null)], [25, 25, 25])
  let threw = false
  let read
  try { read = readPageSize(throwingStorage(), key) } catch { threw = true }
  check('a storage read that throws reads as 25, no throw', [read, threw], [25, false])

  const s = memoryStorage()
  check('saving a size in the choice writes it', [savePageSize(s, key, 50), s.data.get(key)], [true, '50'])
  const s2 = memoryStorage()
  check('a size outside the choice is not written',
    [savePageSize(s2, key, 5), savePageSize(s2, key, '50'), savePageSize(s2, key, NaN), s2.calls.length], [false, false, false, 0])
  check('no storage or no key: nothing written', [savePageSize(null, key, 50), savePageSize(memoryStorage(), null, 50)], [false, false])
  threw = false
  let saved
  try { saved = savePageSize(throwingStorage(), key, 50) } catch { threw = true }
  check('a storage write that throws answers false, no throw', [saved, threw], [false, false])

  clearGlobalStorage()
  check('browserStorage: none in this runtime gives null', browserStorage(), null)
  setThrowingGlobalStorage()
  threw = false
  let got
  try { got = browserStorage() } catch { threw = true }
  check('browserStorage: reaching localStorage throws gives null, no throw', [got, threw], [null, false])
  const mem = memoryStorage()
  setGlobalStorage(mem)
  check('browserStorage: the page\'s localStorage', browserStorage() === mem, true)
  clearGlobalStorage()
}

// ---------------------------------------------------------------------------
console.log('§2 composables/useLoadboardPaging.js')
// ---------------------------------------------------------------------------
let vue
let useLoadboardPaging
try {
  vue = await import(VUE_URL)
  ;({ useLoadboardPaging } = await import(pathToFileURL(COMPOSABLE_PATH).href))
} catch (err) {
  check('the composable and the client\'s Vue load', String(err.message).split('\n')[0], 'loaded')
}
if (vue && useLoadboardPaging) {
  const { ref, nextTick } = vue
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
  const KEY7 = 'logisx.loadboard.pageSize.jobBoard.u7'

  {
    const store = memoryStorage({ [KEY7]: '50' })
    setGlobalStorage(store)
    const items = ref(rows(120))
    const mine = useLoadboardPaging(items, { tab: 'jobBoard', userId: 7 })
    const other = useLoadboardPaging(items, { tab: 'jobBoard', userId: 8 })
    const otherTab = useLoadboardPaging(items, { tab: 'completed', userId: 7 })
    check('the saved size is the starting size, per user and per tab',
      [mine.pageSize.value, other.pageSize.value, otherTab.pageSize.value], [50, 25, 25])
    check('a tab with a choice offers 10/25/50/100', mine.sizes, [10, 25, 50, 100])
    mine.setSize(100)
    check('choosing a size shows it from page 1 and saves it',
      [mine.pageSize.value, mine.page.value, mine.totalPages.value, store.data.get(KEY7)], [100, 1, 2, '100'])
    mine.setSize(7)
    check('a size outside the choice is ignored', [mine.pageSize.value, store.data.get(KEY7)], [100, '100'])
  }

  {
    setGlobalStorage(memoryStorage())
    const items = ref(rows(120))
    const q = ref('')
    const p = useLoadboardPaging(items, { tab: 'completed', userId: 7, resetOn: [q] })
    p.goTo(4)
    q.value = '5400'
    await nextTick()
    check('a new search goes back to page 1', p.page.value, 1)
    p.goTo(5)
    check('page 5 of 5 shows the last 20 rows', p.paginatedItems.value.length, 20)
    items.value = rows(30)
    await nextTick()
    check('a list that shrinks under the page moves to its last page', [p.totalPages.value, p.page.value, p.paginatedItems.value.length], [2, 2, 5])
  }

  {
    const store = memoryStorage({ 'logisx.loadboard.pageSize.activeLoads.u7': '10' })
    setGlobalStorage(store)
    const items = ref(rows(50))
    const q = ref('')
    const a = useLoadboardPaging(items, { fixedSize: 50, resetOn: [q] })
    check('Active Loads: 50 loads are one page', [a.totalPages.value, a.paginatedItems.value.length, a.pageSize.value], [1, 50, 50])
    items.value = rows(51)
    await nextTick()
    check('Active Loads: 51 loads page at 50', [a.totalPages.value, a.paginatedItems.value.length], [2, 50])
    a.setSize(10)
    check('Active Loads: no size choice, and nothing read or saved', [a.pageSize.value, a.sizes, store.calls.length], [50, [], 0])
    a.goTo(2)
    q.value = 'x'
    await nextTick()
    check('Active Loads: a new search goes back to page 1', a.page.value, 1)
  }

  {
    setGlobalStorage(throwingStorage())
    const p = useLoadboardPaging(ref(rows(120)), { tab: 'jobBoard', userId: 7 })
    let threw = false
    try { p.setSize(50) } catch { threw = true }
    check('storage that throws: 25 to start, a choice still applies, no throw', [p.pageSize.value, threw], [50, false])
    clearGlobalStorage()
    const q = useLoadboardPaging(ref(rows(120)), { tab: 'jobBoard', userId: 7 })
    q.setSize(10)
    check('no storage at all: 25 to start, a choice still applies', q.pageSize.value, 10)
    setThrowingGlobalStorage()
    threw = false
    let r
    try { r = useLoadboardPaging(ref(rows(120)), { tab: 'jobBoard', userId: 7 }) } catch { threw = true }
    check('localStorage itself throws: 25, no throw', [r ? r.pageSize.value : null, threw], [25, false])
    clearGlobalStorage()
  }
}

// ---------------------------------------------------------------------------
console.log('§3 the three tabs')
// ---------------------------------------------------------------------------
const DASH = path.join(SRC, 'components', 'dashboard')
const IMPORT = "import { useLoadboardPaging } from '../../composables/useLoadboardPaging'"
const TABS = {
  'JobBoardTab.vue': {
    call: "useLoadboardPaging(filteredJobs, { tab: 'jobBoard', userId: auth.user?.id, resetOn: [searchQuery, needsReviewOnly] })",
    bar: true,
  },
  'CompletedLoadsTab.vue': {
    call: "useLoadboardPaging(sortedJobs, { tab: 'completed', userId: auth.user?.id, resetOn: [searchQuery, needsReviewOnly, driverFilter, fromDate, toDate] })",
    bar: true,
  },
  'ActiveLoadsTab.vue': {
    call: 'useLoadboardPaging(filteredJobs, { fixedSize: ACTIVE_LOADS_PAGE_SIZE, resetOn: [searchQuery, needsReviewOnly] })',
    bar: false,
  },
}
for (const [file, t] of Object.entries(TABS)) {
  const src = fs.readFileSync(path.join(DASH, file), 'utf8')
  const script = src.slice(src.indexOf('<script setup>'))
  check(`${file}: imports the loadboard paging`, script.includes(IMPORT), true)
  check(`${file}: pages through the composable`,
    script.includes(`const { page, pageSize, totalPages, paginatedItems, goTo, setSize, sizes } = ${t.call}`), true)
  check(`${file}: no direct usePagination call`, /\busePagination\(/.test(script), false)
  check(`${file}: the search runs on every row, not on a page`, /searchLoads\(\s*paginatedItems/.test(script), false)
  const bar = (src.match(/<PaginationBar [^>]*\/>/) || [''])[0]
  check(`${file}: the bar offers the tab's sizes`, bar.includes(':sizes="sizes"'), true)
  check(`${file}: ${t.bar ? 'the size choice stays when one page holds every row' : 'no size choice to keep'}`,
    bar.includes('keep-size-choice'), t.bar)
}
{
  const active = fs.readFileSync(path.join(DASH, 'ActiveLoadsTab.vue'), 'utf8')
  check('ActiveLoadsTab.vue: imports the 50-load page size',
    active.includes("import { ACTIVE_LOADS_PAGE_SIZE } from '../../lib/loadboardPaging'"), true)
}

// ---------------------------------------------------------------------------
console.log('§4 PaginationBar')
// ---------------------------------------------------------------------------
{
  const bar = fs.readFileSync(path.join(SRC, 'components', 'shared', 'PaginationBar.vue'), 'utf8')
  check('other pages keep 5/10/25/50', /sizes: \{ type: Array, default: \(\) => \[5, 10, 25, 50\] \}/.test(bar), true)
  check('keepSizeChoice is a prop, off by default', /keepSizeChoice: \{ type: Boolean, default: false \}/.test(bar), true)
  check('the bar shows on one page when a smaller size would page',
    bar.includes('props.totalPages > 1 || (props.keepSizeChoice && props.sizes.length > 0 && props.total > Math.min(...props.sizes))'), true)
  check('the root shows by that rule', bar.includes('<div v-if="visible" class="pagination">'), true)
  check('page buttons only when there is more than one page', bar.includes('<template v-if="totalPages > 1">'), true)
  check('the size select only when sizes are offered, with a label',
    /<select v-if="sizes\.length" class="page-size-select" aria-label="Rows per page"/.test(bar), true)
  check('the options are the sizes prop', bar.includes('<option v-for="s in sizes" :key="s" :value="s">{{ s }}/page</option>'), true)
  check('the controls wrap at phone width', /<style scoped>[\s\S]*\.pagination-controls \{[^}]*flex-wrap: wrap;/.test(bar), true)
  check('the arrows keep their characters (scripts/e2e finds ›)', ['&laquo;', '&lsaquo;', '&rsaquo;', '&raquo;'].every((c) => bar.includes(c)), true)
}

finish()
