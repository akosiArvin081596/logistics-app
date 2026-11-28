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
// The last section, P, is the upload card's POD and BOL pages under its two
// switches (lib/podScanRouting.js): what ScanKit is asked, which pictures go
// through the scan, "Use the original photo", the page sources and the wait.
//
// Each section below pins one of them. Where a check guards a regression, the
// OLD code runs against the same fixture first and must reproduce the bug —
// a fixture that would not have caught the original defect proves nothing.
//
// Two checks LIFT production code (submitExpense, scanDocument) into a bare
// `new Function` with its dependencies injected, as test-db-export-guard.js
// does with requireRole, so they exercise the shipped source rather than a copy.
// The last section goes further: it compiles ExpenseForm.vue's own
// <script setup> with the client's vue/compiler-sfc and drives its setup() on
// Vue's real reactivity, so the form's guards are tested where they live.
//
// No network, no DOM, no database, no browser — safe to run anywhere. It needs
// client/node_modules (vue), which CI installs before the unit runners.
//
//   node scripts/test-driver-receipt-flow.mjs      # exits 1 on any failure

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

import { loadIdKey, sameLoadId, expenseLoadId, expensesForLoad } from '../client/src/lib/loadId.js'
import { RECEIPT_MAX_EDGE, RECEIPT_SCAN_WIDTH, createPhotoJobs } from '../client/src/lib/receiptPhoto.js'
import { replyLost } from '../client/src/lib/saveOutcome.js'

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

  // POD/BOL: DocumentUpload's call, through the routing lib (lib/podScanRouting.js scanOptions()), as a
  // pair. POD_UPLOAD_NORMALIZE_ENABLED off: the body is what it always was (the server's 1536 default).
  // On: the photo's long edge, at most 1280 (N4 of the POD upload-normalize plan).
  const podLib = await import('../client/src/lib/podScanRouting.js').catch(() => null)
  const offOptions = podLib ? podLib.scanOptions({ normalize: false, longEdge: 1000 }) : { filter: 'white' }
  await scanDocument('data:image/jpeg;base64,QUJD', offOptions)
  const pod = calls.pop()
  check('C: switch off, a POD scan sends the same three keys as before (no outputWidth)', Object.keys(pod.body).sort(), ['filter', 'photoData', 'returnPdf'])
  check('C: switch off, a POD scan keeps its 30 s timeout and no signal', [pod.opts.timeout, pod.opts.signal], [30000, undefined])
  check('C: switch off, the routing lib asks exactly what DocumentUpload asked before', offOptions, { filter: 'white' })
  check('C: FAILS ON THE OLD CODE: switch on, ScanKit is asked for the photo long edge, at most 1280 (unknown: 1280)',
    podLib ? [1000, 1280, 2000, null].map((e) => podLib.scanOptions({ normalize: true, longEdge: e }).outputWidth) : null, [1000, 1280, 1280, 1280])
  if (podLib) await scanDocument('data:image/jpeg;base64,QUJD', podLib.scanOptions({ normalize: true, longEdge: 1000 }))
  const podOn = podLib ? calls.pop() : { body: {}, opts: {} }
  check('C: FAILS ON THE OLD CODE: switch on, the POD scan body adds outputWidth to the same keys, with the same 30 s timeout',
    [Object.keys(podOn.body).sort(), podOn.body.outputWidth, podOn.opts.timeout], [['filter', 'outputWidth', 'photoData', 'returnPdf'], 1000, 30000])
  const duSrc = read('client/src/components/driver/DocumentUpload.vue')
  check('C: FAILS ON THE OLD CODE: DocumentUpload asks ScanKit through the routing lib, with the switch and the photo long edge, and names no width itself',
    [/scanDocument\(raw, scanOptions\(\{ normalize: podSwitches\.normalize\.value, longEdge: jpegLongEdge\(raw\) \}\)\)/.test(duSrc), /outputWidth/.test(duSrc)], [true, false])

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
  // replyLost is injected as the REAL helper, so the store is tested against
  // the same definition the form uses (see the replyLost block below).
  check('C: the store imports replyLost from lib/saveOutcome', /import \{ replyLost \} from '\.\.\/lib\/saveOutcome'/.test(store), true)
  const makeStore = new Function('api', 'EXPENSE_SAVE_TIMEOUT_MS', 'replyLost', `return { async submitExpense(data) ${method} }`)

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
      ...makeStore(api, timeoutMs, replyLost),
      loadData: () => { reads++; return loadDataOutcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('refresh failed')) },
    }
    let result
    let thrown = null
    try { result = await self.submitExpense({ amount: '10', allowDuplicate: 'yes' }) } catch (e) { thrown = e }
    await new Promise((r) => setTimeout(r, 0))
    return { posts, reads, result, thrown }
  }
  // The shape useApi throws: status, code ('' when the body had none), data.
  const httpErr = (status, code = '', data = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code, data })

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

  // Gateway answers: nginx's HTML error page parses to nothing, so the row may
  // have saved behind it (a deploy restart, or the 120 s read timeout).
  const gw502 = await run(httpErr(502))
  check('C: gateway 502 → one POST, one re-read, error rethrown', [gw502.posts.length, gw502.reads, gw502.thrown && gw502.thrown.status], [1, 1, 502])
  const gw504 = await run(httpErr(504))
  check('C: gateway 504 → one POST, one re-read', [gw504.posts.length, gw504.reads], [1, 1])
  const app500 = await run(httpErr(500, '', { error: 'Failed to log expense' }))
  check('C: an application 500 is a real answer → no re-read', app500.reads, 0)

  const bothFail = await run(httpErr(0, 'TIMEOUT'), 'fail')
  check('C: a failing background re-read stays silent (no unhandled rejection)', [bothFail.thrown && bothFail.thrown.code, unhandled], ['TIMEOUT', 0])

  process.off('unhandledRejection', onUnhandled)
}

// ══ C — "no answer" is ONE rule, shared by the store and the form ════════════
{
  const e = (status, code = '', data = {}) => ({ status, code, data })
  check('C: our own timeout (status 0) is a lost reply', replyLost(e(0, 'TIMEOUT')), true)
  check('C: a dropped connection (TypeError, no status) is a lost reply', replyLost(new TypeError('Failed to fetch')), true)
  check('C: a gateway 502 (no app body) is a lost reply', replyLost(e(502)), true)
  check('C: a gateway 504 (no app body) is a lost reply', replyLost(e(504)), true)
  check('C: an app 502 with its own JSON error is a real answer', replyLost(e(502, '', { error: 'scan_failed' })), false)
  check('C: a 502 carrying an app code is a real answer', replyLost(e(502, 'SOME_CODE')), false)
  check('C: 500 / 503 / 400 / 409 are real answers', [500, 503, 400, 409].map((s) => replyLost(e(s))), [false, false, false, false])
  check('C: no error is not a lost reply', replyLost(null), false)
}

// ══ The form itself — ExpenseForm.vue's real <script setup>, run in node ═════
// Everything above checks what the form USES. This checks the form's own
// guards: the lines that decide what a submit sends, and what a late answer
// may still touch. The SFC's <script setup> is compiled with the client's own
// vue/compiler-sfc, and its setup() runs on Vue's real reactivity. Only its I/O
// is swapped for stubs this file settles one call at a time (the decoder,
// ScanKit, the OCR fetch, the toast, the drop zone), so every race replays in a
// fixed order. A late answer is delivered even AFTER its request was aborted:
// on a phone the response can win that race, so the form's own gate — not the
// abort — must be what drops it. Each M-check is a mutant that once survived
// this runner: delete the guard it names and the run goes red.
{
  const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
  const Vue = clientRequire('vue')
  const { parse, compileScript } = clientRequire('vue/compiler-sfc')
  const FORM = 'client/src/components/driver/ExpenseForm.vue'
  const FORM_DIR = path.join(ROOT, 'client', 'src', 'components', 'driver')
  const SRC_DIR = path.join(ROOT, 'client', 'src')
  const { descriptor } = parse(read(FORM), { filename: 'ExpenseForm.vue' })
  let body = compileScript(descriptor, { id: 'expense-form', inlineTemplate: false }).content

  // ESM → a function body over injected modules. Anything but a one-line named
  // import stops the run here, loudly, rather than being guessed at.
  const specifiers = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (_, names, spec) => {
    specifiers.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${FORM}: an import/export this harness cannot map`)
  const buildComponent = new Function('__deps', body)

  // Browser-bound modules are stubbed; every other import loads for real.
  const moduleKey = (spec) => path.relative(SRC_DIR, path.join(FORM_DIR, spec)).split(path.sep).join('/')
  const STUBBED = new Set(['composables/useToast', 'composables/useDocumentScan', 'composables/useFileDrop', 'lib/imageUtils'])
  const realModules = {}
  for (const spec of specifiers) {
    if (spec === 'vue' || spec === 'vant' || STUBBED.has(moduleKey(spec))) continue
    if (!spec.startsWith('.')) throw new Error(`${FORM}: unexpected import '${spec}'`)
    realModules[spec] = await import(pathToFileURL(path.join(FORM_DIR, `${spec}.js`)).href)
  }
  const imageUtils = await import(pathToFileURL(path.join(SRC_DIR, 'lib', 'imageUtils.js')).href)
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }

  const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  // Let every continuation the form chained after a settled call run to the end.
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
  const photoFile = (name) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' })
  const jpeg = (tag) => `data:image/jpeg;base64,${Buffer.from(tag).toString('base64')}`

  function mountForm({ presetLoadId = 'A-100', submitHandler = null } = {}) {
    const io = { compress: [], scan: [], ocr: [], toasts: [], submits: [] }
    const unmountHooks = []
    let dropOptions = null
    const deps = {
      vue: { ...Vue, onMounted() {}, onBeforeUnmount: (fn) => unmountHooks.push(fn) },
      vant: new Proxy({}, { get: () => ({}) }),
      ...realModules,
    }
    for (const spec of specifiers) {
      const key = spec.startsWith('.') ? moduleKey(spec) : ''
      if (key === 'composables/useToast') {
        deps[spec] = { useToast: () => ({ show: (message, type) => io.toasts.push({ message, type }) }) }
      } else if (key === 'composables/useDocumentScan') {
        deps[spec] = { useDocumentScan: () => ({ scanDocument: (dataUrl, opts) => { const d = deferred(); io.scan.push({ dataUrl, opts, ...d }); return d.promise } }) }
      } else if (key === 'composables/useFileDrop') {
        deps[spec] = { useFileDrop: (opts) => { dropOptions = opts; return { dropzoneProps: Vue.ref({}), dragActive: Vue.ref(false), error: Vue.ref(''), clearMessages() {} } } }
      } else if (key === 'lib/imageUtils') {
        deps[spec] = { ...imageUtils, compressImage: (blob, maxEdge) => { const d = deferred(); io.compress.push({ blob, maxEdge, ...d }); return d.promise } }
      }
    }
    // The OCR fetch. Deliberately deaf to its abort signal: see the header.
    globalThis.fetch = (url, opts = {}) => {
      const d = deferred()
      io.ocr.push({
        url,
        body: JSON.parse(opts.body),
        signal: opts.signal,
        answer: (status, json) => d.resolve({ ok: status >= 200 && status < 300, status, json: async () => json }),
        fail: d.reject,
      })
      return d.promise
    }
    const props = Vue.shallowReactive({
      loads: [{ 'Load ID': presetLoadId, Status: 'In Transit' }],
      driverName: 'Test Driver',
      headers: ['Load ID', 'Status'],
      presetLoadId,
      submitHandler: (payload) => {
        io.submits.push(JSON.parse(JSON.stringify(payload)))
        return submitHandler ? submitHandler(payload) : Promise.resolve({ id: io.submits.length })
      },
    })
    const scope = Vue.effectScope()
    const f = scope.run(() => buildComponent(deps).setup(props, { expose() {}, emit() {}, attrs: {}, slots: {} }))
    return {
      f,
      io,
      props,
      pick: (name) => f.onPhotoPicked({ target: { files: [photoFile(name)], value: name } }),
      drop: (name) => dropOptions.onFiles([photoFile(name)]),
      // Vant's ×: it empties v-model first, then emits `delete`.
      remove: () => { f.fileList.value = []; f.onPhotoDelete() },
      unmount: () => { unmountHooks.forEach((fn) => fn()); scope.stop() },
    }
  }
  // Pick a photo and let decode → scan → read all answer.
  async function readThrough(m, name, tag, ocrJson) {
    m.pick(name); await settle()
    m.io.compress[m.io.compress.length - 1].resolve(jpeg(tag)); await settle()
    m.io.scan[m.io.scan.length - 1].resolve({ data: jpeg(`${tag}+`) }); await settle()
    m.io.ocr[m.io.ocr.length - 1].answer(200, ocrJson); await settle()
  }

  // The ordinary path, end to end — the baseline every race below departs from.
  {
    const m = mountForm()
    const { f, io } = m
    check('F: the Load field starts on the page’s load', f.form.loadId, 'A-100')
    m.pick('a.jpg'); await settle()
    check('F: a picked photo is decoded at the receipt edge and holds Submit', [io.compress.length, io.compress[0].maxEdge, f.photoStage.value], [1, 1024, 'preparing'])
    io.compress[0].resolve(jpeg('A')); await settle()
    check('F: decoded → scanned at the receipt width, with the job’s signal', [f.photoStage.value, io.scan[0].opts.outputWidth, !!io.scan[0].opts.signal], ['reading', RECEIPT_SCAN_WIDTH, true])
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    check('F: the read is sent the enhanced photo', io.ocr[0].body.photoData, jpeg('A+'))
    io.ocr[0].answer(200, { amount: 45.5, vendor: 'Pilot', details: [{ label: 'Product', value: 'Diesel' }], confidence: 'high' }); await settle()
    check('F: the read fills the form and releases Submit', [f.form.amount, f.form.vendor, f.ocrApplied.value, f.photoBusy.value], ['45.5', 'Pilot', true, false])
    await f.handleSubmit(); await settle()
    const sent = io.submits[0] || {}
    check('F: submit sends the enhanced photo, its details and the load', [sent.photoData, sent.receiptDetails, sent.loadId], [jpeg('A+'), [{ label: 'Product', value: 'Diesel' }], 'A-100'])
    check('F: a saved entry clears the form and keeps the page’s load', [f.form.amount, f.photoBase64.value, f.fileList.value.length, f.form.loadId], ['', '', 0, 'A-100'])
    m.unmount()
  }

  // M1 — the × takes the photo out of the payload (onPhotoDelete).
  {
    const m = mountForm()
    await readThrough(m, 'a.jpg', 'A', { amount: 30 })
    m.remove()
    await m.f.handleSubmit(); await settle()
    check('M1: a photo deleted with × is NOT sent', (m.io.submits[0] || {}).photoData, '')
    m.unmount()
  }
  {
    const m = mountForm()
    const { f, io } = m
    f.form.amount = '12'
    m.pick('b.jpg'); await settle()
    io.compress[0].resolve(jpeg('B')); await settle()
    m.remove()
    check('F: × aborts the scan in flight', io.scan[0].opts.signal.aborted, true)
    io.scan[0].resolve({ data: jpeg('B+') }); await settle() // it answers anyway
    check('F: a scan answering after × does not bring the photo back', [f.photoBase64.value, io.ocr.length], ['', 0])
    await f.handleSubmit(); await settle()
    check('F: …and that submit carries no photo', (io.submits[0] || {}).photoData, '')
    m.unmount()
  }

  // M2 — a reset retires whatever is still in flight (resetAfterSubmit's own
  // contract; a backstop behind the Submit hold, so it is driven directly).
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    io.compress[0].resolve(jpeg('A')); await settle()
    f.resetAfterSubmit(true)
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    check('M2: after a reset, the old photo’s scan cannot re-attach it', f.photoBase64.value, '')
    check('M2: …nor start a read on the emptied form', io.ocr.length, 0)
    m.unmount()
  }
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    io.compress[0].resolve(jpeg('A')); await settle()
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    f.resetAfterSubmit(true)
    io.ocr[0].answer(200, { amount: 999, vendor: 'LATE' }); await settle()
    check('M2: a read landing after a reset leaves the form empty', [f.form.amount, f.form.vendor, f.ocrApplied.value], ['', '', false])
    m.unmount()
  }

  // M3 — late answers for a photo that is no longer the current one.
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    m.pick('b.jpg'); await settle()
    io.compress[1].resolve(jpeg('B')); await settle()
    io.compress[0].resolve(jpeg('A')); await settle() // photo A's decode, late
    check('M3: a replaced photo’s late decode does not overwrite the new one', f.photoBase64.value, jpeg('B'))
    check('M3: …nor release Submit while the new one is still being read', f.photoStage.value, 'reading')
    m.unmount()
  }
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    io.compress[0].resolve(jpeg('A')); await settle()
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    f.form.amount = '20'
    f.skipReceiptRead()
    check('F: Skip releases Submit and aborts the read', [f.photoBusy.value, io.ocr[0].signal.aborted], [false, true])
    io.ocr[0].answer(200, { amount: 999, vendor: 'LATE', details: [{ label: 'Product', value: 'DEF' }] }); await settle()
    check('M3: a read answering after Skip changes nothing', [f.form.amount, f.form.vendor, f.ocrApplied.value, f.ocrDetails.value], ['20', '', false, []])
    check('M3: …and the photo Skip kept is still the one attached', f.photoBase64.value, jpeg('A+'))
    m.unmount()
  }
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    io.compress[0].resolve(jpeg('A')); await settle()
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    f.skipReceiptRead()
    io.ocr[0].fail(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); await settle()
    check('F: a read cut off by Skip is silent (no "Couldn’t read receipt")', io.toasts.length, 0)
    m.unmount()
  }
  {
    const m = mountForm()
    const { f, io } = m
    m.pick('a.jpg'); await settle()
    io.compress[0].resolve(jpeg('A')); await settle()
    m.unmount()
    io.scan[0].resolve({ data: jpeg('A+') }); await settle()
    check('F: after unmount, a late scan writes nothing and starts no read', [f.photoBase64.value, io.ocr.length], [jpeg('A'), 0])
  }

  // M4 — no submit while the photo is being prepared or read (Enter in a field
  // reaches handleSubmit even with the button disabled).
  {
    const m = mountForm()
    const { f, io } = m
    f.form.amount = '10'
    m.pick('a.jpg'); await settle()
    await f.handleSubmit(); await settle()
    check('M4: no submit while the photo is being prepared', io.submits.length, 0)
    io.compress[0].resolve(jpeg('A')); await settle()
    await f.handleSubmit(); await settle()
    check('M4: no submit while the photo is being read', io.submits.length, 0)
    check('M4: …and the driver is told why', io.toasts.some((t) => /Still reading/.test(t.message)), true)
    m.unmount()
  }

  // Fix 1 — a new photo drops everything the previous photo's read left behind.
  {
    const m = mountForm()
    const { f, io } = m
    await readThrough(m, 'a.jpg', 'A', { amount: 30, details: [{ label: 'Product', value: 'DEF' }], confidence: 'high' })
    check('Fix1: (photo A was read as DEF)', [f.ocrApplied.value, f.ocrDetails.value.length], [true, 1])
    m.remove()
    m.pick('b.jpg'); await settle()
    check('Fix1: attaching photo B drops A’s read at once', [f.ocrApplied.value, f.ocrDetails.value, f.preOcrSnapshot.value], [false, [], null])
    io.compress[1].resolve(jpeg('B')); await settle()
    f.skipReceiptRead()
    await f.handleSubmit(); await settle()
    const sent = io.submits[0] || {}
    check('Fix1: B skipped → filed with photo B and none of A’s details', [sent.photoData, sent.receiptDetails], [jpeg('B'), []])
    m.unmount()
  }
  {
    const m = mountForm()
    await readThrough(m, 'a.jpg', 'A', { amount: 30, details: [{ label: 'Product', value: 'DEF' }] })
    m.drop('b.jpg'); await settle() // a desktop drop replaces the photo too
    check('Fix1: a dropped photo drops the previous read as well', [m.f.ocrApplied.value, m.f.ocrDetails.value], [false, []])
    m.unmount()
  }

  // Fix 2 — the page's load is followed only while the entry is pristine.
  {
    const m = mountForm({ presetLoadId: 'A-100' })
    const { f, props } = m
    f.form.amount = '25'
    props.presetLoadId = 'B-200'; await settle()
    check('Fix2: mid-entry, the page switching loads does NOT move the entry', f.form.loadId, 'A-100')
    await f.handleSubmit(); await settle()
    check('Fix2: …so it is filed under the load it showed', (m.io.submits[0] || {}).loadId, 'A-100')
    check('Fix2: after that save, the form returns to the page’s load', f.form.loadId, 'B-200')
    props.presetLoadId = 'C-300'; await settle()
    check('Fix2: a pristine form follows the page', f.form.loadId, 'C-300')
    f.onLoadPick({ selectedOptions: [{ value: 'X-9' }] })
    props.presetLoadId = 'D-400'; await settle()
    check('Fix2: a load the driver picked is never overridden', f.form.loadId, 'X-9')
    m.unmount()
  }
  {
    const m = mountForm({ presetLoadId: 'A-100' })
    m.pick('a.jpg'); await settle()
    m.props.presetLoadId = 'B-200'; await settle()
    check('Fix2: a photo alone makes the entry non-pristine', m.f.form.loadId, 'A-100')
    m.unmount()
  }

  // Fix 3 — the form's wording follows the same replyLost() as the store.
  const failures = [
    [{ status: 0, code: 'TIMEOUT', data: {}, message: 'The request timed out.' }, true],
    [{ status: 504, code: '', data: {}, message: 'Request failed (504)' }, true],
    [{ status: 502, code: '', data: {}, message: 'Request failed (502)' }, true],
    [{ status: 502, code: '', data: { error: 'scan_failed' }, message: 'scan_failed' }, false],
    [{ status: 500, code: '', data: { error: 'Failed to log expense' }, message: 'Failed to log expense' }, false],
  ]
  for (const [shape, lost] of failures) {
    const m = mountForm({ submitHandler: () => Promise.reject(Object.assign(new Error(shape.message), shape)) })
    m.f.form.amount = '15'
    await m.f.handleSubmit(); await settle()
    const label = `${shape.status}${shape.data.error ? ' with an app error' : ''}`
    check(`Fix3: ${label} → ${lost ? '"Not confirmed", may already be saved' : '"Not submitted"'}`, [m.f.submitUnconfirmed.value, /may already be saved/.test(m.f.submitError.value)], [lost, lost])
    check(`Fix3: ${label} → the entry is kept`, m.f.form.amount, '15')
    m.unmount()
  }

  // Fix 5 — nothing about the photo changes while the entry is being sent.
  const uploaderTag = tagsOf(templateOf(read(FORM)), 'van-uploader')[0] || ''
  check('Fix5: the thumbnail × is off while a save is in flight', /:deletable="!submitting"/.test(uploaderTag), true)
  {
    let release
    const m = mountForm({ submitHandler: () => new Promise((r) => { release = r }) })
    m.f.form.amount = '15'
    const sending = m.f.handleSubmit(); await settle()
    m.drop('late.jpg'); await settle()
    check('F: nothing can be attached while the entry is being sent', [m.f.fileList.value.length, m.io.compress.length], [0, 0])
    release({ id: 1 }); await sending; await settle()
    m.unmount()
  }
}

// ══ P — the upload card's POD and BOL pages under its two switches ═══════════
// lib/podScanRouting.js (pure), the card's wiring in DocumentUpload.vue, and the two composables it
// reads (usePodUploadFeatures, useUpload), lifted as scanDocument is above. Every new rule is labelled
// FAILS ON THE OLD CODE; each "(guard)" passes on the base by design; each rule's mutant (an edited copy
// of the lib, compiled in a temporary folder, or an edited copy of the card's text) must flip it.
{
  const LIB = 'client/src/lib/podScanRouting.js'
  const lib = await import('../client/src/lib/podScanRouting.js').catch(() => null)
  const du = read('client/src/components/driver/DocumentUpload.vue')
  const tmpDirs = []
  async function libWith(from, to) {
    try {
      const src = read(LIB)
      if (src.split(from).length - 1 !== 1) return null
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-routing-'))
      tmpDirs.push(dir)
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
      fs.writeFileSync(path.join(dir, 'imageUtils.js'), read('client/src/lib/imageUtils.js'))
      fs.writeFileSync(path.join(dir, 'podScanRouting.js'), src.replace(from, to))
      return await import(pathToFileURL(path.join(dir, 'podScanRouting.js')).href)
    } catch {
      return null
    }
  }
  const holds = async (fn, arg) => { try { return (await fn(arg)) === true } catch { return false } }
  const libRules = []
  // Each rule: its check against the real lib (the control) and against one mutant.
  async function rule(label, fn, from, to) {
    const control = lib ? await holds(fn, lib) : false
    check(label, control, true)
    libRules.push({ label, fn, from, to, control })
  }
  const textRules = []
  function textRule(label, fn, from, to) {
    const control = fn(du) === true
    check(label, control, true)
    textRules.push({ label, fn, from, to, control })
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const { jpeg } = require('./lib/made-up-jpeg.js')
  const uri = (b) => `data:image/jpeg;base64,${b.toString('base64')}`

  // Section C's switch-on checks and the card's call, each with its own mutant here.
  const onWidths = (L) => same([1000, 1280, 2000, null].map((e) => L.scanOptions({ normalize: true, longEdge: e }).outputWidth), [1000, 1280, 1280, 1280])
  libRules.push({ label: 'switch on, ScanKit is asked for the photo long edge, at most 1280', fn: onWidths,
    from: "return { filter: 'white', outputWidth: edge }", to: "return { filter: 'white' }", control: lib ? onWidths(lib) : false })
  const asksThroughLib = (t) => /scanDocument\(raw, scanOptions\(\{ normalize: podSwitches\.normalize\.value, longEdge: jpegLongEdge\(raw\) \}\)\)/.test(t) && !/outputWidth/.test(t)
  textRules.push({ label: 'P: FAILS ON THE OLD CODE: DocumentUpload asks ScanKit through the routing lib', fn: asksThroughLib,
    from: 'scanDocument(raw, scanOptions({ normalize: podSwitches.normalize.value, longEdge: jpegLongEdge(raw) }))', to: "scanDocument(raw, { filter: 'white', outputWidth: 1280 })", control: asksThroughLib(du) })

  // The card's copies of the server's words and numbers (a client can't import lib/), pinned equal.
  const server = (() => { try { return require('../lib/pod-upload-shape.js') } catch { return null } })()
  await rule('P: FAILS ON THE OLD CODE: the card\'s page sources and the steps\' time are the server\'s (lib/pod-upload-shape.js PAGE_SOURCES, UPLOAD_BUDGET_MS)',
    (L) => same(L.PAGE_SOURCES, server.PAGE_SOURCES) && L.SHAPE_BUDGET_MS === server.UPLOAD_BUDGET_MS,
    'export const SHAPE_BUDGET_MS = 20000', 'export const SHAPE_BUDGET_MS = 15000')

  await rule('P: FAILS ON THE OLD CODE: the two switches come from the session features, each on only when exactly true',
    (L) => same([L.podFeatures({ features: { podUploadNormalize: true, podUploadScanAll: 'true' } }), L.podFeatures({ authenticated: true }), L.podFeatures(null)],
      [{ normalize: true, scanAll: false }, { normalize: false, scanAll: false }, { normalize: false, scanAll: false }]),
    'scanAll: f.podUploadScanAll === true', 'scanAll: Boolean(f.podUploadScanAll)')
  await rule('P: FAILS ON THE OLD CODE: with scan-all on, an Upload File, "+" or drop picture for a POD or a BOL goes through the scan',
    (L) => same([L.routesToScan({ scanAll: true, docType: 'POD', isImage: true }), L.routesToScan({ scanAll: true, docType: 'BOL', isImage: true })], [true, true]),
    "export const POD_SCAN_TYPES = Object.freeze(['POD', 'BOL'])", "export const POD_SCAN_TYPES = Object.freeze(['POD'])")
  const notRouted = (L) => same([L.routesToScan({ scanAll: false, docType: 'POD', isImage: true }), L.routesToScan({ scanAll: true, docType: 'Receipt', isImage: true }),
    L.routesToScan({ scanAll: true, docType: 'Other', isImage: true }), L.routesToScan({ scanAll: true, docType: 'POD', isImage: false })], [false, false, false, false])
  check('P: (guard) with scan-all off an Upload File POD picture is not scanned, and a Receipt, an Other or a file never is', lib ? notRouted(lib) : true, true)
  libRules.push({ label: 'the routing guard', fn: notRouted, from: 'return scanAll === true && isImage === true && isPodScanType(docType)', to: 'return isImage === true', control: lib ? notRouted(lib) : false })
  await rule('P: FAILS ON THE OLD CODE: "Use the original photo" sends the photo as it was, its source then "original"; and back to the scan',
    (L) => {
      const page = { routed: true, original: 'data:image/jpeg;base64,T1JJRw==', scanned: 'data:image/jpeg;base64,U0NBTg==', data: 'data:image/jpeg;base64,U0NBTg==', source: 'scanned' }
      const o = L.chooseOriginal(page, true)
      const back = L.chooseOriginal({ ...page, ...o }, false)
      return same([o, L.pageSourcesFor([{ ...page, ...o }]), back], [{ data: page.original, source: 'original' }, ['original'], { data: page.scanned, source: 'scanned' }])
    },
    "useOriginal ? { data: entry.original, source: 'original' }", "useOriginal ? { data: entry.scanned, source: 'original' }")
  await rule('P: FAILS ON THE OLD CODE: the choice is offered on a page the scan routed only: never on a camera scan, a fallback or a file',
    (L) => {
      const page = { routed: true, original: 'a', scanned: 'b', source: 'scanned' }
      return same([L.originalChoiceWords(page), L.originalChoiceWords({ ...page, source: 'original' }), L.originalChoiceWords({ ...page, routed: false }),
        L.originalChoiceWords({ routed: true, original: 'a', scanned: '', source: 'fallback' }), L.originalChoiceWords(null)],
      ['Use the original photo', 'Use the scanned page', '', '', ''])
    },
    "if (!entry || entry.routed !== true || !entry.original || !entry.scanned) return null", "if (!entry || !entry.original || !entry.scanned) return null")
  await rule('P: FAILS ON THE OLD CODE: each page carries its source: scanned, fallback, original, or not routed (anything else)',
    (L) => same(L.pageSourcesFor([{ source: 'scanned' }, { source: 'fallback' }, { source: 'original' }, { source: '' }, {}, { source: 'made-up' }]),
      ['scanned', 'fallback', 'original', 'not_routed', 'not_routed', 'not_routed']),
    "return PAGE_SOURCES.includes(s) && s !== 'not_routed' ? s : 'not_routed'", "return s || 'not_routed'")
  await rule('P: FAILS ON THE OLD CODE: the long edge is read from the photo frame header (landscape, portrait, after an EXIF block; not a JPEG: null)',
    (L) => same([jpeg({ width: 300, height: 200, quality: 50 }), jpeg({ width: 200, height: 320, quality: 50 }), jpeg({ width: 260, height: 180, quality: 50, orientation: 6 })]
      .map((b) => L.jpegLongEdge(uri(b))).concat([L.jpegLongEdge('data:image/png;base64,iVBORw0KGgo='), L.jpegLongEdge('')]), [300, 320, 260, null, null]),
    'return w > 0 && h > 0 ? Math.max(w, h) : null', 'return w > 0 && h > 0 ? w : null')
  await rule('P: FAILS ON THE OLD CODE (N4): the scan width never passes the photo it is sent (1280 at most)',
    (L) => same([2000, 1280, 900].map((e) => L.scanOptions({ normalize: true, longEdge: e }).outputWidth), [1280, 1280, 900]),
    'Math.min(longEdge, SCAN_MAX_EDGE)', 'longEdge')
  const offAsked = (L) => same([L.scanOptions({ normalize: false, longEdge: 900 }), L.scanOptions({})], [{ filter: 'white' }, { filter: 'white' }])
  check('P: (guard) switch off, the card asks ScanKit exactly what it asked before', lib ? offAsked(lib) : true, true)
  libRules.push({ label: 'the switch-off scan guard', fn: offAsked, from: "if (normalize !== true) return { filter: 'white' }", to: "if (normalize !== true) return { filter: 'white', outputWidth: SCAN_MAX_EDGE }", control: lib ? offAsked(lib) : false })
  await rule('P: FAILS ON THE OLD CODE (N7): switch on, a POD or BOL photo upload waits 90 s plus the server steps 20 s, so the phone does not send it again meanwhile',
    (L) => same([L.uploadTimeoutFor({ normalize: true, docType: 'POD' }), L.uploadTimeoutFor({ normalize: true, docType: 'BOL' })], [110000, 110000]),
    'UPLOAD_ATTEMPT_MS + SHAPE_BUDGET_MS', 'UPLOAD_ATTEMPT_MS')
  const ownWait = (L) => same([L.uploadTimeoutFor({ normalize: false, docType: 'POD' }), L.uploadTimeoutFor({ normalize: true, docType: 'Receipt' })], [undefined, undefined])
  check('P: (guard) switch off, and any other type, the upload keeps its own 90 s wait', lib ? ownWait(lib) : true, true)
  libRules.push({ label: 'the own-wait guard', fn: ownWait, from: 'return normalize === true && isPodScanType(docType) ?', to: 'return isPodScanType(docType) ?', control: lib ? ownWait(lib) : false })
  const big = (over = {}) => ({ isImage: false, type: 'application/pdf', name: 'made-up.pdf', size: 700 * 1024, ...over })
  await rule('P: FAILS ON THE OLD CODE (L8): an office user sees the note on a POD or BOL PDF over 600 KB (the PDF still goes as it is)',
    (L) => same([L.largePdfWarning({ normalize: true, role: 'Super Admin', docType: 'POD', files: [big()] }), L.largePdfWarning({ normalize: true, role: 'Dispatcher', docType: 'BOL', files: [big({ type: '', name: 'm.PDF' })] })],
      [L.LARGE_PDF_WORDS, L.LARGE_PDF_WORDS]) && L.LARGE_PDF_WORDS === 'This file is large: Triumph takes at most 921,600 bytes per load, all documents together.',
    'Number(f.size) > LARGE_PDF_BYTES', 'Number(f.size) > 10 * LARGE_PDF_BYTES')
  const noNote = (L) => same([L.largePdfWarning({ normalize: true, role: 'Driver', docType: 'POD', files: [big()] }), L.largePdfWarning({ normalize: false, role: 'Super Admin', docType: 'POD', files: [big()] }),
    L.largePdfWarning({ normalize: true, role: 'Super Admin', docType: 'POD', files: [big({ size: 500 * 1024 })] }), L.largePdfWarning({ normalize: true, role: 'Super Admin', docType: 'POD', files: [big({ isImage: true })] }),
    L.largePdfWarning({ normalize: true, role: 'Super Admin', docType: 'Receipt', files: [big()] })], ['', '', '', '', ''])
  check('P: (guard) a driver never sees the note; nor anyone with the switch off, or on a small PDF, a photo or a Receipt', lib ? noNote(lib) : true, true)
  libRules.push({ label: 'the no-note guard', fn: noNote, from: "if (normalize !== true || !OFFICE_ROLES.includes(role) || !isPodScanType(docType)) return ''", to: "if (normalize !== true || !isPodScanType(docType)) return ''", control: lib ? noNote(lib) : false })

  // N5: one decode in flight; only the scans side by side.
  const tick = (ms) => new Promise((r) => setTimeout(r, ms))
  async function decodeProbe(run) {
    let decoding = 0; let maxDecoding = 0; let scanning = 0; let maxScanning = 0
    const done = []
    await run([1, 2, 3, 4, 5, 6], {
      decode: async (n) => { decoding++; maxDecoding = Math.max(maxDecoding, decoding); await tick(4); decoding--; return `d${n}` },
      scan: async (n, d) => { scanning++; maxScanning = Math.max(maxScanning, scanning); await tick(25); scanning--; done.push([n, d]) },
      concurrency: 3,
    })
    return { maxDecoding, maxScanning, all: done.length === 6 && done.every(([n, d]) => d === `d${n}`) }
  }
  const n5 = lib ? await decodeProbe(lib.decodeThenScan) : null
  check('P: FAILS ON THE OLD CODE (N5): one decode in flight at a time; only the scans run side by side, 3 at most; each page scanned with its own decode', n5, { maxDecoding: 1, maxScanning: 3, all: true })
  const { runPool } = await import('../client/src/lib/asyncPool.js')
  const pooled = await decodeProbe((items, o) => runPool(items, async (it) => o.scan(it, await o.decode(it)), o.concurrency))
  check('P: MUTANT (each decode inside the pool, as the camera path runs) caught: decodes in flight reach 3', [n5 && n5.maxDecoding === 1, pooled.maxDecoding], [true, 3])

  // The composables, lifted with their imports injected.
  const box = (v) => ({ value: v })
  async function featuresRead(srcFix = (s) => s) {
    try {
      const src = srcFix(read('client/src/composables/usePodUploadFeatures.js').replace(/^import .*$/gm, '').replace('export function usePodUploadFeatures', 'function usePodUploadFeatures'))
      const use = new Function('ref', 'podFeatures', `${src}\nreturn usePodUploadFeatures`)(box, lib.podFeatures)
      let gets = 0
      const f = use({ get: async (url) => { gets++; return url === '/api/auth/session' ? { authenticated: true, features: { voiceNotes: false, podUploadNormalize: false, podUploadScanAll: true } } : null } })
      await tick(5)
      use({ get: async () => { gets++; return {} } })
      return [f.normalize.value, f.scanAll.value, gets]
    } catch { return null }
  }
  check('P: FAILS ON THE OLD CODE: the card reads both switches from GET /api/auth/session once a page', await featuresRead(), [false, true, 1])
  check('P: MUTANT (scan-all read from the other switch) caught', [same(await featuresRead(), [false, true, 1]), await featuresRead((s) => s.replace('scanAll.value = f.scanAll', 'scanAll.value = f.normalize'))], [true, [false, false, 1]])
  async function uploadWaits(srcFix = (s) => s) {
    try {
      const timeouts = []
      const src = srcFix(read('client/src/composables/useUpload.js').replace(/^import .*$/gm, '').replace('export function useUpload', 'function useUpload'))
      const useUpload = new Function('ref', 'useApi', `${src}\nreturn useUpload`)(box, () => ({ post: async (url, body, opts) => { timeouts.push(opts.timeout); return { success: true } } }))
      const { uploadDocuments } = useUpload()
      await uploadDocuments([{ label: 'POD (2 pages)', body: {}, timeoutMs: 110000 }, { label: 'made-up.pdf', body: {} }])
      return timeouts
    } catch { return null }
  }
  check('P: FAILS ON THE OLD CODE (N7): useUpload gives a task its own wait when it names one, and 90 s otherwise', await uploadWaits(), [110000, 90000])
  check('P: MUTANT (the task wait ignored) caught', [same(await uploadWaits(), [110000, 90000]), await uploadWaits((s) => s.replace('timeout: timeoutMs > 0 ? timeoutMs : 90000', 'timeout: 90000'))], [true, [90000, 90000]])

  // The card's wiring, read from its source (each rule's mutant: the line edited out of a copy).
  textRule('P: FAILS ON THE OLD CODE: the card routes Upload File, "+" and drop pictures with the scan-all switch, and decodes them one at a time',
    (t) => /routesToScan\(\{ scanAll: podSwitches\.scanAll\.value, docType: selectedType\.value, isImage: file\.type\.startsWith\('image\/'\) \}\)/.test(t)
      && /await decodeThenScan\(routed, \{ decode: decodeForScan, scan: finishScan, concurrency: SCAN_CONCURRENCY \}\)/.test(t),
    'await decodeThenScan(routed, { decode: decodeForScan, scan: finishScan, concurrency: SCAN_CONCURRENCY })', 'await runPool(routed, scanOne, SCAN_CONCURRENCY)')
  textRule('P: FAILS ON THE OLD CODE: the card offers the choice in the page preview, and applies it to that page',
    (t) => /<button v-if="originalChoice" type="button" class="dup-preview-choice" @click\.stop="toggleOriginal">/.test(t)
      && /const originalChoice = computed\(\(\) => originalChoiceWords\(previewEntry\.value\)\)/.test(t) && /const next = chooseOriginal\(f, f && f\.source !== 'original'\)/.test(t),
    '<button v-if="originalChoice"', '<button v-if="false"')
  textRule('P: FAILS ON THE OLD CODE: the card sends each page source and the longer wait only with the normalize switch on, and tags each scan step',
    (t) => /\.\.\.\(normalize \? \{ pageSources: pageSourcesFor\(images\) \} : \{\}\)/.test(t) && /timeoutMs: uploadTimeoutFor\(\{ normalize, docType: selectedType\.value \}\)/.test(t)
      && /entry\.source = 'scanned'/.test(t) && /entry\.source = 'fallback'/.test(t),
    '...(normalize ? { pageSources: pageSourcesFor(images) } : {}),', 'pageSources: pageSourcesFor(images),')
  textRule('P: FAILS ON THE OLD CODE: the card shows the office note with the user role and the switch',
    (t) => /<p v-if="largePdfNote" class="doc-warn">\{\{ largePdfNote \}\}<\/p>/.test(t) && /role: auth\.user\?\.role,/.test(t) && /normalize: podSwitches\.normalize\.value,\n\s*role:/.test(t),
    'role: auth.user?.role,', "role: 'Super Admin',")

  for (const r of libRules) {
    const m = await libWith(r.from, r.to)
    check(`P: MUTANT for "${r.label.replace(/^P: (FAILS ON THE OLD CODE(?: \([A-Z0-9]+\))?: |\(guard\) )/, '').slice(0, 70)}…" caught`, [r.control, m !== null, m ? await holds(r.fn, m) : null], [true, true, false])
  }
  for (const r of textRules) {
    const edited = du.split(r.from).length - 1 === 1 ? du.replace(r.from, r.to) : null
    check(`P: MUTANT for "${r.label.replace(/^P: FAILS ON THE OLD CODE: /, '').slice(0, 70)}…" caught`, [r.control, edited !== null, edited ? r.fn(edited) === true : null], [true, true, false])
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
}

console.log(`\ndriver-receipt-flow: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
