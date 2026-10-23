#!/usr/bin/env node
// client/src/lib/loadRef.js and its call sites: a Dispatcher opens, edits,
// assigns and tracks a load whose Load ID is withheld from him by the opaque key
// the server serves beside it (the Dispatcher raw Load ID plan, PR 2), and the
// screen shows the ID only as served.
//
// Written before the change: on main the module is missing and every call site
// sends the served Load ID text.
//
//   §1 the helper: loadRef() (a row's key, else its ID exactly as served),
//      loadIdRef() (a { loadId, loadKey } pair), loadIdWithheld(), loadIdShown()
//      (decision 8: "[contact withheld]" for an ID served blank), the Fleet chip
//      list key, loadMatches() (a notification's ?load=).
//   §2 the call sites, read from source: every per-load call and list key in
//      Active Loads, the Job Board, the Fleet, the tracking map, the notification
//      tap and the dashboard store goes through the helper; a withheld load has
//      no tracking link to copy (decision 7: "Ask a Super Admin for this link").
//
// Pure: no server, no DOM, no network. Made-up IDs and keys.
//   node scripts/test-load-ref.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLIENT = path.join(ROOT, 'client', 'src')

let pass = 0
let fail = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  failures.push(name)
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}

const WITHHELD = '[contact withheld]'
const KEY = 'wk-AbCdEfGhIjKlMnOpQrStUvWxYz0'
const KEY2 = 'wk-0zYxWvUtSrQpOnMlKjIhGfEdCbA'

let lib = null
try {
  lib = await import(pathToFileURL(path.join(CLIENT, 'lib', 'loadRef.js')).href)
} catch (e) {
  console.log(`  (client/src/lib/loadRef.js not loadable: ${e.message})`)
}

function section(name, fn) {
  try { fn() } catch (e) { fail++; failures.push(name); console.log(`  FAIL  ${name}: ${e && e.message}`) }
}

section('§1 the helper', () => {
  const { loadRef, loadIdRef, loadIdWithheld, loadIdShown, queuedLoadListKey, loadMatches, WITHHELD_TEXT } = lib
  check('§1 the withheld text is the server\'s', WITHHELD_TEXT, WITHHELD)
  const keyed = { 'Load ID': `QA-${WITHHELD}`, _loadKey: KEY, _withheldCells: ['Load ID'] }
  const blank = { 'Load ID': '', _loadKey: KEY2, _withheldCells: ['Load ID', 'Details'] }
  const normal = { 'Load ID': ' 80000031 ', Details: 'Dry van' }
  const old = { 'Load ID': `QA-${WITHHELD}`, _withheldCells: ['Load ID'] }
  check('§1 loadRef(): the key when there is one, else the ID exactly as served (the column found or named)',
    [loadRef(keyed), loadRef(blank, 'Load ID'), loadRef(normal), loadRef(normal, 'Load ID'), loadRef(old), loadRef(null), loadRef({})],
    [KEY, KEY2, ' 80000031 ', ' 80000031 ', `QA-${WITHHELD}`, '', ''])
  check('§1 loadIdRef(): a { loadId, loadKey } pair by its key, else its loadId (or load_id), trimmed',
    [loadIdRef({ loadId: `QA-${WITHHELD}`, loadKey: KEY }), loadIdRef({ loadId: ' 80000031 ' }), loadIdRef({ load_id: '80000032' }),
      loadIdRef({ loadId: '', load_id: '80000033' }), loadIdRef({ loadId: 'X', loadKey: '' }), loadIdRef(null)],
    [KEY, '80000031', '80000032', '80000033', 'X', ''])
  check('§1 loadIdWithheld(): a key, or the Load ID among the withheld cells; never a normal row',
    [loadIdWithheld(keyed), loadIdWithheld(blank), loadIdWithheld(old), loadIdWithheld(normal), loadIdWithheld({ 'Load ID': '1', _withheldCells: ['Details'] })],
    [true, true, true, false, false])
  check('§1 loadIdShown(): as served; an ID served blank reads "[contact withheld]" (decision 8); a blank normal cell stays blank',
    [loadIdShown(keyed), loadIdShown(blank), loadIdShown(normal), loadIdShown({ 'Load ID': '' })],
    [`QA-${WITHHELD}`, WITHHELD, '80000031', ''])
  const entry = { QueuedLoadIds: [`QA-${WITHHELD}`, `QA-${WITHHELD}`, '80000031'], QueuedLoadKeys: [KEY, KEY2, ''] }
  const oldEntry = { QueuedLoadIds: [WITHHELD, WITHHELD] }
  check('§1 the Fleet chip list key: the load\'s key, else position and text, so two chips that read alike never share one',
    [[0, 1, 2].map((i) => queuedLoadListKey(entry, i)), [0, 1].map((i) => queuedLoadListKey(oldEntry, i))],
    [[KEY, KEY2, '2:80000031'], [`0:${WITHHELD}`, `1:${WITHHELD}`]])
  check('§1 loadMatches(): a key exactly (a key is case-sensitive), an ID in any letter case, nothing for a blank',
    [loadMatches(keyed, KEY), loadMatches(keyed, KEY.toLowerCase()), loadMatches(normal, '80000031'), loadMatches({ 'Load ID': 'ab-1' }, 'AB-1'),
      loadMatches(blank, ''), loadMatches(blank, WITHHELD)],
    [true, false, true, true, false, false])
})

const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8')

section('§2 Active Loads', () => {
  const src = read('components/dashboard/ActiveLoadsTab.vue')
  check('§2 Active Loads: imports the helper', /import \{[^}]*\bloadRef\b[^}]*\} from '\.\.\/\.\.\/lib\/loadRef'/.test(src), true)
  check('§2 Active Loads: no API call names the load by the served Load ID text',
    (src.match(/api\.(get|put|post|del)\([^)\n]*encodeURIComponent\(loadIdValue\.value\)/g) || []), [])
  check('§2 Active Loads: the detail\'s reads (documents, rating, geocode) go by loadRef()',
    /const lid = loadRef\(job, lc\)\.trim\(\)/.test(src), true)
  // The driver instructions section keeps the served ID until its routes
  // (lib/driver-instructions-runtime.js) read keys: a follow-up.
  check('§2 Active Loads: the override, the status timeline, the haul, the POD upload and the documents refresh go by the load\'s reference',
    [/status-override`/.test(src) && /encodeURIComponent\(loadRefValue\.value\)\}\/status-override/.test(src),
      /<StatusTimeline v-if="loadRefValue" :load-id="loadRefValue"/.test(src), /<LoadHaulSection :load-id="loadRefValue"/.test(src),
      /<DocumentUpload\s+:load-id="loadRefValue"\s+:load-label="loadIdShownValue"/.test(src),
      /api\.get\(`\/api\/documents\/\$\{encodeURIComponent\(loadRefValue\.value\)\}`\)/.test(src)],
    [true, true, true, true, true])
  check('§2 Active Loads: a row save of a withheld load sends its key (it confirms the row)',
    /selectedJob\.value\._loadKey \? \{ values, baseline, loadId: selectedJob\.value\._loadKey \}/.test(src), true)
  check('§2 Active Loads: a notification\'s ?load= opens the load by its key or its ID (loadMatches())',
    /jobs\.find\(j => loadMatches\(j, focus, lc\)\)/.test(src), true)
  check('§2 Active Loads: a withheld load shows "Ask a Super Admin for this link" instead of the copy button, and the copy refuses one',
    [/<span v-if="selectedLoadIdWithheld"[^>]*>Ask a Super Admin for this link<\/span>\s*<button\s+v-else-if="loadIdValue"/.test(src),
      /if \(!loadIdValue\.value \|\| selectedLoadIdWithheld\.value\) return/.test(src)], [true, true])
  check('§2 Active Loads: the title and the lists show the ID as served ("[contact withheld]" when served blank)',
    [/<DialogTitle>\{\{ loadIdShownValue \|\| 'Load Details' \}\}<\/DialogTitle>/.test(src), (src.match(/loadIdShown\(job, /g) || []).length >= 2],
    [true, true])
  check('§2 Active Loads: a withheld load\'s documents are listed by type and time with the server\'s note, no links',
    /v-else-if="docsWithheldNote"/.test(src) && /r\.documentsWithheld \?/.test(src), true)
})

section('§2 Job Board', () => {
  const src = read('components/dashboard/JobBoardTab.vue')
  check('§2 Job Board: the geocode read goes by the load\'s reference',
    /const lid = lc \? loadRef\(j, lc\)\.trim\(\) : ''/.test(src), true)
  check('§2 Job Board: a withheld load shows "Ask a Super Admin for this link" instead of the copy button, and the copy refuses one',
    [/<span v-if="selectedLoadIdWithheld"[^>]*>Ask a Super Admin for this link<\/span>\s*<button\s+v-else-if="loadIdValue"/.test(src),
      /if \(!loadIdValue\.value \|\| selectedLoadIdWithheld\.value\) return/.test(src)], [true, true])
  check('§2 Job Board: the title shows the ID as served', /<DialogTitle>\{\{ loadIdShownValue \|\| 'Load Details' \}\}<\/DialogTitle>/.test(src), true)
})

section('§2 the dashboard store (assign, reassign, status)', () => {
  const src = read('stores/dashboard.js')
  check('§2 store: assign and reassign name the load by loadRef(job, ...)',
    (src.match(/const loadId = loadRef\(job, loadIdCol\)/g) || []).length, 2)
  check('§2 store: a status update names a keyed row by its key',
    /const ref = rowData && typeof rowData\._loadKey === 'string' && rowData\._loadKey \? rowData\._loadKey : loadId/.test(src)
      && /loadId: ref,/.test(src), true)
})

section('§2 Fleet, tracking map, notifications', () => {
  const fleet = read('components/dashboard/FleetTab.vue')
  check('§2 Fleet: each queued chip is keyed by queuedLoadListKey() (two that read alike no longer collide)',
    [/:key="queuedLoadListKey\(selected, i\)"/.test(fleet), /v-for="\(lid, i\) in selected\.QueuedLoadIds" :key="lid"/.test(fleet)], [true, false])
  const map = read('components/dashboard/TrackingMap.vue')
  check('§2 tracking map: each load is keyed and opened by loadIdRef(), never by its served text',
    [/:key="loadIdRef\(al\)"/.test(map), /:key="al\.loadId"/.test(map), /expandedLoadId\.value = loadIdRef\(al\)/.test(map),
      (map.match(/\bl\.loadId === expandedLoadId\.value/g) || []).length, (map.match(/loadIdRef\(l\) === expandedLoadId\.value/g) || []).length >= 5],
    [true, false, true, 0, true])
  check('§2 tracking map: the planned lane and the trails are read by the load\'s reference; a live update keeps its key',
    [/fetchPlannedLane\(loadIdRef\(al\)\)/.test(map), /&loadId=\$\{encodeURIComponent\(loadIdRef\(loc\)\)\}/.test(map),
      /locations\.value\[idx\]\.loadKey = payload\.loadKey \|\| ''/.test(map), /loadIdRef\(payload\) === trailLoadId\.value/.test(map)],
    [true, true, true, true])
  const notes = read('views/NotificationsView.vue')
  check('§2 notifications: the tap opens a load by metadata.loadKey, else its loadId', /loadId = loadIdRef\(meta\)/.test(notes), true)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log(`Failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
