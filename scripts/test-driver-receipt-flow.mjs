#!/usr/bin/env node
// Deterministic check on the driver's fuel-receipt flow — the path behind a
// driver's "these are not uploading" report about three fuel receipts.
//
// WHY THIS EXISTS. That report was five defects stacked, and each one alone was
// enough to make a receipt look lost:
//
//   G  The receipt picker was camera-only (capture="camera"), so a receipt
//      already in the phone's gallery could not be attached at all. For the
//      three receipts in the report, nothing ever left the phone.
//   A  A load's page filtered expenses on `e.load_id`, a key the driver payload
//      has never carried (the server sends `load_id AS loadId`). No driver has
//      seen an expense under a load since 2026-04-03: a receipt that saved
//      looked like one that had not, so it was filed again and refused as a
//      duplicate.
//   B  A late ScanKit/Gemini answer could refill a form that had already been
//      submitted and cleared; the Load field started blank on a load's own page.
//   C  The save gave up after 20 s on cellular while the server was still
//      saving, and the scan quietly upscaled every receipt before its upload.
//
// Each section below pins one of them. Where a check guards a regression, the
// OLD code runs against the same fixture first and must reproduce the bug —
// a fixture that would not have caught the original defect proves nothing.
//
// Two checks LIFT production code (submitExpense, scanDocument) into a bare
// `new Function` with its one dependency injected, as test-db-export-guard.js
// does with requireRole, so they exercise the shipped source rather than a copy.
//
// No network, no DOM, no database — pure input/output, safe to run anywhere.
//
//   node scripts/test-driver-receipt-flow.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

import { loadIdKey, sameLoadId, expenseLoadId, expensesForLoad } from '../client/src/lib/loadId.js'
import { RECEIPT_MAX_EDGE, RECEIPT_SCAN_WIDTH, createPhotoJobs } from '../client/src/lib/receiptPhoto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

// The balanced {...} block starting at the first "{" at/after `from`, skipping
// strings and comments. Enough for the plain method bodies lifted below.
function balancedBlock(src, from) {
  const start = src.indexOf('{', from)
  if (from < 0 || start < 0) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return null
      continue
    }
    if (c === '/' && n === '*') {
      i = src.indexOf('*/', i + 2) + 1
      if (i <= 0) return null
      continue
    }
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

const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
const templateOf = (sfc) => stripHtmlComments(sfc.slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>')))
// Opening tags, quote-aware: attribute values such as `(v) => …` contain ">".
const tagsOf = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g'))].map((m) => m[0])

// ══ G — a receipt can come from the gallery, not only the camera ═════════════
{
  // Every way a file can be picked in a template: a literal file input, or a Vant
  // uploader showing its own upload tile (it renders an input carrying the same
  // accept/capture; Vant's default accept is image/*). An uploader with
  // :show-upload="false" is only a thumbnail, not a door.
  const doorsOf = (tpl) => [
    ...tagsOf(tpl, 'input').filter((t) => /type="file"/.test(t)),
    ...tagsOf(tpl, 'van-uploader')
      .filter((t) => !/:show-upload="false"/.test(t))
      .map((t) => (/\saccept=/.test(t) ? t : t.replace('<van-uploader', '<van-uploader accept="image/*"'))),
  ]
  const acceptsImages = (t) => /\saccept="[^"]*image\/\*/.test(t)
  const hasCapture = (t) => /\scapture(=|\s|>|\/)/.test(t)
  const galleryDoor = (tpl) => doorsOf(tpl).some((t) => acceptsImages(t) && !hasCapture(t))
  const cameraDoor = (tpl) => doorsOf(tpl).some((t) => acceptsImages(t) && hasCapture(t))

  // The shipped single door, verbatim in substance — and the reported defect.
  const OLD = `<template><van-field label="Receipt Photo"><template #input>
    <van-uploader v-model="fileList" :max-count="1" :after-read="handlePhoto"
      accept="image/*" capture="camera" result-type="file" />
  </template></van-field></template>`
  check('G: (the old uploader: a camera door and NO gallery door — the bug)', [cameraDoor(OLD), galleryDoor(OLD)], [true, false])

  const tpl = templateOf(read('client/src/components/driver/ExpenseForm.vue'))
  // ⚠️ BOTH halves. Dropping `capture` from the one door does NOT offer both on
  // Android 14+ Chrome — it opens the system photo picker, which has no camera.
  check('G: a gallery door exists — an image picker with NO capture', galleryDoor(tpl), true)
  check('G: the camera door still exists — an image picker WITH capture', cameraDoor(tpl), true)
  // Same handler for every door, so a gallery picture takes the camera shot's
  // decode path (HEIC → JPEG, 1024 px downscale) and never a lesser one.
  const doors = doorsOf(tpl)
  check(
    'G: every receipt door feeds the one onPhotoPicked handler',
    doors.length >= 2 && doors.every((t) => /@change="onPhotoPicked"/.test(t)),
    true,
  )
}

// ══ A — a load's page shows the expenses filed against it ════════════════════
{
  // Exactly what GET /api/driver/:name returns: `load_id AS loadId`.
  const payload = [
    { id: 11, loadId: '#513987502', type: 'Fuel', amount: 412.5 },
    { id: 12, loadId: '513987502', type: 'Toll', amount: 9 },
    { id: 13, loadId: ' #513987502 ', type: 'Food', amount: 14 },
    { id: 14, loadId: '600000001', type: 'Fuel', amount: 300 },
    { id: 15, loadId: '', type: 'Other', amount: 5 },
    { id: 16, loadId: 'LD-MP4W4LP1', type: 'Fuel', amount: 200 },
  ]

  // The filter DriverView shipped from 2026-04-03 (2ad6a86), verbatim.
  const oldFilter = (expenses, lid) => expenses.filter((e) => (e.load_id || '').toString().trim() === lid)
  check('A: (the old filter found NOTHING on the real payload — the bug)', oldFilter(payload, '#513987502').length, 0)

  const ids = (rows) => rows.map((e) => e.id)
  check('A: a #-prefixed load finds every spelling of itself', ids(expensesForLoad(payload, '#513987502')), [11, 12, 13])
  check('A: a bare load id finds the #-prefixed rows too', ids(expensesForLoad(payload, '513987502')), [11, 12, 13])
  check('A: case-insensitive, as the server compares', ids(expensesForLoad(payload, 'ld-mp4w4lp1')), [16])
  check('A: other loads stay out', ids(expensesForLoad(payload, '600000001')), [14])
  check('A: a blank load id lists nothing (never the unfiled rows)', ids(expensesForLoad(payload, '')), [])
  check('A: whitespace-only is blank too', ids(expensesForLoad(payload, '   ')), [])
  check('A: an unfiled expense never matches a load', sameLoadId('', ''), false)
  check('A: a load that has none is empty, not an error', ids(expensesForLoad(payload, '777')), [])
  check('A: a missing list is empty, not an error', expensesForLoad(undefined, '513987502'), [])

  // The raw column name every OTHER expense route returns is read too, so this
  // survives the alias being dropped; the alias wins when both are present.
  check('A: tolerates the raw load_id column', ids(expensesForLoad([{ id: 21, load_id: '#9' }], '9')), [21])
  check('A: loadId wins over load_id when both exist', expenseLoadId({ loadId: '1', load_id: '2' }), '1')
  check('A: blank loadId falls back to load_id', expenseLoadId({ loadId: '', load_id: '2' }), '2')

  // SAME KEY AS THE SERVER — loadBelongsToDriver()/deduplicateLoads() and
  // lib/ratecon-load.js: trim, lowercase, drop ONE leading "#". If these drift,
  // a row the server accepted for a load could be hidden from that load's page.
  const { normalizeLoadId: serverKey } = require('../lib/ratecon-load.js')
  const samples = ['#513987502', ' 513987502 ', 'LD-MP4W4LP1', '##42', '# 42', '', null, undefined, 42, '#']
  check(
    'A: loadIdKey() is byte-identical to the server key for every sample',
    samples.map((s) => loadIdKey(s)),
    samples.map((s) => serverKey(s)),
  )
  check('A: ONE "#" is dropped, as on the server — "##42" is not "42"', sameLoadId('##42', '42'), false)

  // Wiring: DriverView must use the helper, not re-derive the match inline.
  const dv = read('client/src/views/DriverView.vue')
  const body = balancedBlock(dv, dv.indexOf('const detailLoadExpenses = computed(')) || ''
  check('A: DriverView.detailLoadExpenses matches through expensesForLoad()', /expensesForLoad\(/.test(body), true)
  check('A: DriverView.detailLoadExpenses no longer reads e.load_id itself', /\.load_id\b/.test(body), false)
}

// ══ B(i) — a late read can never touch a photo that is gone ══════════════════
{
  const jobs = createPhotoJobs()
  const a = jobs.start()
  check('B: a new job is current and may read', [jobs.isCurrent(a), jobs.mayRead(a), a.signal.aborted], [true, true, false])

  // A second photo supersedes the first: its answers are dropped, its requests aborted.
  const b = jobs.start()
  check('B: a replaced photo is stale and aborted', [jobs.isCurrent(a), jobs.mayRead(a), a.signal.aborted], [false, false, true])
  check('B: the replacement is current', [jobs.isCurrent(b), jobs.mayRead(b)], [true, true])

  // Skip stops the READ and keeps the PHOTO — a decode still in flight must land.
  jobs.skipRead()
  check('B: Skip keeps the photo current (never loses it)', jobs.isCurrent(b), true)
  check('B: Skip drops the read and aborts its requests', [jobs.mayRead(b), b.signal.aborted], [false, true])

  // Delete / successful submit / unmount: the photo is gone, nothing may write.
  jobs.cancel()
  check('B: a cancelled job writes nothing', [jobs.isCurrent(b), jobs.mayRead(b)], [false, false])
  check('B: no job at all is never current', [jobs.isCurrent(null), jobs.mayRead(undefined)], [false, false])
  jobs.skipRead() // no current job: must be a harmless no-op
  const c = jobs.start()
  check('B: a fresh photo after a cancel starts clean', [jobs.isCurrent(c), jobs.mayRead(c), c.signal.aborted], [true, true, false])

  // The form holds Submit for exactly the photo's busy window.
  const tpl = templateOf(read('client/src/components/driver/ExpenseForm.vue'))
  const submitBtn = tagsOf(tpl, 'van-button').find((t) => /native-type="submit"/.test(t)) || ''
  check('B: Submit is disabled while a photo is being prepared or read', /:disabled="photoBusy"/.test(submitBtn), true)
}

// ══ B(ii) — the Load field starts on the page's load; errors are reachable ═══
{
  const detail = templateOf(read('client/src/components/driver/LoadDetail.vue'))
  const formTag = tagsOf(detail, 'ExpenseForm')[0] || ''
  check('B: LoadDetail hands ExpenseForm its own load (preset-load-id)', /:preset-load-id=/.test(formTag), true)

  const src = read('client/src/components/driver/ExpenseForm.vue')
  check('B: ExpenseForm declares the presetLoadId prop', /presetLoadId:\s*\{\s*type:\s*String/.test(src), true)
  const tpl = templateOf(src)
  // Vant reports — and can only scroll to — a failed field by its `name`.
  const ruled = tagsOf(tpl, 'van-field').filter((t) => /:rules=/.test(t))
  check('B: every validated field has a name, so a failure can be located', ruled.length >= 3 && ruled.every((t) => /\sname="[^"]+"/.test(t)), true)
  check('B: the form takes the driver to the first invalid field (@failed)', /<van-form\b[^>]*@failed=/.test(tpl), true)
}

// ══ C — the save waits like an upload, never retries; scans are not upscaled ═
{
  // Receipt scan width: never wider than the photo's long edge, which is what
  // the server default (1536) upscaled; and not below the server's 512 floor,
  // or the number here would silently not be the number sent.
  check('C: receipt scan width is the photo long edge', RECEIPT_SCAN_WIDTH, RECEIPT_MAX_EDGE)
  check('C: receipt scan width is below the 1536 server default', RECEIPT_SCAN_WIDTH < 1536, true)
  check('C: receipt scan width is inside the server clamp (>= 512)', RECEIPT_SCAN_WIDTH >= 512, true)

  // Lift scanDocument and inject a recording useApi.
  const scanSrc = read('client/src/composables/useDocumentScan.js')
    .replace(/^import .*$/gm, '')
    .replace(/export function useDocumentScan/, 'function useDocumentScan')
  const calls = []
  const stubApi = () => ({
    post: (url, body, opts) => {
      calls.push({ url, body, opts })
      return Promise.resolve({ data: 'data:image/jpeg;base64,AAAA' })
    },
  })
  const { scanDocument } = new Function('useApi', `${scanSrc}\nreturn useDocumentScan`)(stubApi)()

  // POD/BOL: DocumentUpload's call, exactly. The body must be what it always was.
  await scanDocument('data:image/jpeg;base64,QUJD', { filter: 'white' })
  const pod = calls.pop()
  check('C: a POD scan sends the same three keys as before (no outputWidth)', Object.keys(pod.body).sort(), ['filter', 'photoData', 'returnPdf'])
  check('C: a POD scan keeps its 30 s timeout and no signal', [pod.opts.timeout, pod.opts.signal], [30000, undefined])
  check('C: DocumentUpload still asks for no width (server default)', /outputWidth/.test(read('client/src/components/driver/DocumentUpload.vue')), false)

  // Receipt: the ExpenseForm call.
  const ctrl = new AbortController()
  await scanDocument('data:image/jpeg;base64,QUJD', { returnPdf: false, filter: 'flat', outputWidth: RECEIPT_SCAN_WIDTH, signal: ctrl.signal })
  const rc = calls.pop()
  check('C: a receipt scan asks for the receipt width', rc.body.outputWidth, RECEIPT_SCAN_WIDTH)
  check('C: a receipt scan carries its job signal', rc.opts.signal === ctrl.signal, true)
  check('C: ExpenseForm really passes that width', /outputWidth:\s*RECEIPT_SCAN_WIDTH/.test(read('client/src/components/driver/ExpenseForm.vue')), true)

  // Lift submitExpense out of the Pinia store and drive it with stubs.
  const store = read('client/src/stores/driver.js')
  const timeoutMs = Number((/const EXPENSE_SAVE_TIMEOUT_MS = (\d+)/.exec(store) || [])[1])
  check('C: the expense save waits at least as long as an upload (>= 90 s)', timeoutMs >= 90000, true)
  const method = balancedBlock(store, store.indexOf('async submitExpense(data)'))
  const makeStore = new Function('api', 'EXPENSE_SAVE_TIMEOUT_MS', `return { async submitExpense(data) ${method} }`)

  let unhandled = 0
  const onUnhandled = () => { unhandled++ }
  process.on('unhandledRejection', onUnhandled)

  async function run(outcome, loadDataOutcome = 'ok') {
    const posts = []
    const api = {
      post: (url, body, opts) => {
        posts.push({ url, body, opts })
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
      },
    }
    let reads = 0
    const self = {
      ...makeStore(api, timeoutMs),
      loadData: () => { reads++; return loadDataOutcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('refresh failed')) },
    }
    let result
    let thrown = null
    try { result = await self.submitExpense({ amount: '10', allowDuplicate: 'yes' }) } catch (e) { thrown = e }
    await new Promise((r) => setTimeout(r, 0))
    return { posts, reads, result, thrown }
  }
  const httpErr = (status, code) => Object.assign(new Error(`HTTP ${status}`), { status, code })

  const ok = await run({ id: 7, postedPeriod: '' })
  const firstPost = ok.posts[0] || {}
  check('C: success → one POST to /api/expenses', [ok.posts.length, firstPost.url], [1, '/api/expenses'])
  check('C: the POST carries the save timeout (not useApi’s 20 s default)', (firstPost.opts || {}).timeout, timeoutMs)
  check('C: a stray truthy allowDuplicate is NOT consent', (firstPost.body || {}).allowDuplicate, false)
  check('C: success → refresh, and the server body is returned', [ok.reads, ok.result && ok.result.id], [1, 7])

  const okRefreshFails = await run({ id: 8 }, 'fail')
  check('C: a failing refresh never turns a saved expense into a failure', [okRefreshFails.thrown, okRefreshFails.result && okRefreshFails.result.id], [null, 8])

  const timeout = await run(httpErr(0, 'TIMEOUT'))
  check('C: timeout → exactly ONE POST (never retried)', timeout.posts.length, 1)
  check('C: timeout → the original error reaches the form', timeout.thrown && timeout.thrown.code, 'TIMEOUT')
  check('C: timeout → the history is re-read, since the row may have saved', timeout.reads, 1)

  const dropped = await run(new TypeError('Failed to fetch'))
  check('C: dropped connection → one POST, one re-read, error rethrown', [dropped.posts.length, dropped.reads, dropped.thrown instanceof TypeError], [1, 1, true])

  const dup = await run(httpErr(409, 'POSSIBLE_DUPLICATE'))
  check('C: a real answer (409) → no re-read, error rethrown untouched', [dup.posts.length, dup.reads, dup.thrown && dup.thrown.code], [1, 0, 'POSSIBLE_DUPLICATE'])

  const bothFail = await run(httpErr(0, 'TIMEOUT'), 'fail')
  check('C: a failing background re-read stays silent (no unhandled rejection)', [bothFail.thrown && bothFail.thrown.code, unhandled], ['TIMEOUT', 0])

  process.off('unhandledRejection', onUnhandled)
}

console.log(`\ndriver-receipt-flow: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
