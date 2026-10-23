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
//      list key, loadMatches() (a notification's ?load=), conversationRef() and
//      the conversation list key (Messages), loadKeyStale() (404 LOAD_KEY_UNKNOWN).
//   §2 the call sites, read from source: every per-load call and list key in
//      Active Loads, the Job Board, the Fleet, the tracking map, the notification
//      tap, the dashboard store and the Messages panel goes through the helper; a
//      withheld load has no tracking link to copy (decision 7: "Ask a Super Admin
//      for this link"); the dashboard reads its rows again, once, when an action
//      meets a stale key, and its assign toast names the load as shown.
//   §3 the Messages store, run as shipped (its imports stubbed, the helper real):
//      a thread opened by its key is read and replied to by the key and shows the
//      served text; a live message joins it by that text; a stale key empties the
//      thread and reads the list again, once.
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
  const { conversationRef, conversationListKey, loadKeyStale } = lib
  check('§1 conversationRef(): a conversation\'s key, else its loadId exactly as served ("" for a general one)',
    [conversationRef({ driver: 'A', loadId: `QA-${WITHHELD}`, loadKey: KEY }), conversationRef({ loadId: ' 80000031 ' }), conversationRef({ loadId: 'X', loadKey: '' }),
      conversationRef({ loadId: '' }), conversationRef({}), conversationRef(null)],
    [KEY, ' 80000031 ', 'X', '', '', ''])
  const alike = [{ driver: 'A', loadId: `QA-${WITHHELD}`, loadKey: KEY }, { driver: 'A', loadId: `QA-${WITHHELD}`, loadKey: KEY }, { driver: 'A', loadId: `QA-${WITHHELD}` }, { driver: 'A', loadId: `QA-${WITHHELD}` }]
  const listKeys = alike.map((c, i) => conversationListKey(c, i))
  check('§1 the conversation list key: position, driver and reference, so conversations that read alike never share one',
    [listKeys, new Set(listKeys).size], [[`0:A:${KEY}`, `1:A:${KEY}`, `2:A:QA-${WITHHELD}`, `3:A:QA-${WITHHELD}`], 4])
  const apiError = (status, code) => Object.assign(new Error('made-up'), { status, code })
  check('§1 loadKeyStale(): only a 404 LOAD_KEY_UNKNOWN (not the retryable 503, another 404, a timeout or nothing)',
    [loadKeyStale(apiError(404, 'LOAD_KEY_UNKNOWN')), loadKeyStale(apiError(503, 'LOAD_KEY_UNVERIFIED')), loadKeyStale(apiError(404, '')),
      loadKeyStale(apiError(0, 'TIMEOUT')), loadKeyStale(null), loadKeyStale(undefined)],
    [true, false, false, false, false, false])
})

const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8')
// The child components a template hands the served Load ID text (`:load-id="loadIdValue"`),
// by tag name: a per-load panel asks its routes by what it is handed.
const servedIdPanels = (src) => [...src.matchAll(/<([A-Z]\w*)\b[^<>]*?:load-id="loadIdValue"/g)].map((m) => m[1])

section('§2 Active Loads', () => {
  const src = read('components/dashboard/ActiveLoadsTab.vue')
  check('§2 Active Loads: imports the helper', /import \{[^}]*\bloadRef\b[^}]*\} from '\.\.\/\.\.\/lib\/loadRef'/.test(src), true)
  check('§2 Active Loads: no API call names the load by the served Load ID text',
    (src.match(/api\.(get|put|post|del)\([^)\n]*encodeURIComponent\(loadIdValue\.value\)/g) || []), [])
  check('§2 Active Loads: the detail\'s reads (documents, rating, geocode) go by loadRef()',
    /const lid = loadRef\(job, lc\)\.trim\(\)/.test(src), true)
  check('§2 Active Loads: the driver instructions panel is handed the load\'s reference',
    /<DriverInstructionsSection :load-id="loadRefValue"/.test(src), true)
  // The rate-con PDF section is the one exception: it renders for a Super Admin
  // only, who is never served a key (loadRef() is the served ID for him).
  check('§2 Active Loads: no per-load panel but the Super Admin-only rate-con PDF is handed the served Load ID text',
    servedIdPanels(src), ['RateConPdfSection'])
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
  check('§2 Job Board: the driver instructions panel is handed the load\'s reference (loadRef() of the open load)',
    [/const loadRefValue = computed\(\(\) => \(selectedJob\.value \? loadRef\(selectedJob\.value, loadIdCol\.value\) : ''\)\)/.test(src),
      /<DriverInstructionsSection :load-id="loadRefValue"/.test(src)], [true, true])
  check('§2 Job Board: no per-load panel is handed the served Load ID text', servedIdPanels(src), [])
})

section('§2 Completed Loads', () => {
  const src = read('components/dashboard/CompletedLoadsTab.vue')
  check('§2 Completed Loads: imports the helper', /import \{[^}]*\bloadRef\b[^}]*\bloadIdShown\b[^}]*\} from '\.\.\/\.\.\/lib\/loadRef'/.test(src), true)
  check('§2 Completed Loads: the open load\'s reference and shown ID come from loadRef() and loadIdShown()',
    [/const loadRefValue = computed\(\(\) => \(selectedJob\.value \? loadRef\(selectedJob\.value, loadIdCol\.value\) : ''\)\)/.test(src),
      /const loadIdShownValue = computed\(\(\) => \(selectedJob\.value \? loadIdShown\(selectedJob\.value, loadIdCol\.value\) : ''\)\)/.test(src)],
    [true, true])
  // The Super Admin-only invoice draft excepted (POST .../draft-invoice).
  check('§2 Completed Loads: no API call but the Super Admin-only invoice draft names the load by the served Load ID text',
    (src.match(/api\.(get|put|post|del)\([^)\n]*encodeURIComponent\(loadIdValue\.value\)\}[^`\n]*/g) || []).filter((m) => !/\}\/draft-invoice(\?|$)/.test(m)), [])
  check('§2 Completed Loads: the detail\'s reads (documents, rating, geocode) go by loadRef()',
    /const lid = loadRef\(job, lc\)\.trim\(\)/.test(src), true)
  check('§2 Completed Loads: the rating save goes by the load\'s reference',
    /async function submitRating\(r\) \{[^}]*const lid = loadRefValue\.value\.trim\(\)[\s\S]{0,200}?api\.put\(`\/api\/load-ratings\/\$\{encodeURIComponent\(lid\)\}`/.test(src), true)
  check('§2 Completed Loads: the status timeline, the haul, the document upload and the documents refresh go by the load\'s reference',
    [/<StatusTimeline v-if="loadRefValue" :load-id="loadRefValue"/.test(src), /<LoadHaulSection :load-id="loadRefValue"/.test(src),
      /<DocumentUpload\s+:load-id="loadRefValue"\s+:load-label="loadIdShownValue"/.test(src),
      /api\.get\(`\/api\/documents\/\$\{encodeURIComponent\(loadRefValue\.value\)\}`\)/.test(src)],
    [true, true, true, true])
  // The Super Admin-only rate-con PDF section and invoice draft preview stay on the
  // served ID: a Super Admin is never served a key.
  check('§2 Completed Loads: only the Super Admin-only panels are handed the served Load ID text',
    servedIdPanels(src), ['RateConPdfSection', 'InvoiceDraftPreviewModal'])
  check('§2 Completed Loads: a withheld load\'s documents are listed by type and time with the server\'s note, no links',
    [/v-else-if="docsWithheldNote"/.test(src), (src.match(/r\.documentsWithheld \?/g) || []).length], [true, 2])
  check('§2 Completed Loads: the title and the list show the ID as served ("[contact withheld]" when served blank)',
    [/<DialogTitle>\{\{ loadIdShownValue \|\| 'Load Details' \}\}<\/DialogTitle>/.test(src),
      /Details for load \{\{ loadIdShownValue \}\}/.test(src), /\{\{ cellValue\(job, col\) \|\| loadIdShown\(job, col\) \}\}/.test(src)],
    [true, true, true])
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

section('§2 the Messages panel', () => {
  const src = read('components/dashboard/MessagingPanel.vue')
  check('§2 Messages: imports the helper', /import \{[^}]*\bconversationRef\b[^}]*\} from '\.\.\/\.\.\/lib\/loadRef'/.test(src), true)
  check('§2 Messages: each conversation is keyed by conversationListKey() and opened by conversationRef(), its label still the served loadId',
    [/v-for="\(c, i\) in store\.conversations"\s*:key="conversationListKey\(c, i\)"/.test(src), /:key="c\.driver \+ ':' \+ c\.loadId"/.test(src),
      /store\.selectConversation\(c\.driver, conversationRef\(c\), c\.loadId \|\| ''\)/.test(src), /conversationRef\(c\) === store\.selectedLoadId/.test(src),
      /Load \{\{ c\.loadId \}\}/.test(src)],
    [true, false, true, true, true])
  check('§2 Messages: the header shows the conversation\'s shown text, never its reference',
    [/— Load \{\{ store\.selectedLoadShown \}\}/.test(src), /Load \{\{ store\.selectedLoadId \}\}/.test(src)], [true, false])
  check('§2 Messages: the text and voice sends name the load by the open conversation\'s reference',
    [/store\.sendMessage\(store\.selectedDriver, msg, store\.selectedLoadId, attachmentUrl, attachmentType\)/.test(src),
      /store\.sendVoiceNote\(store\.selectedDriver, store\.selectedLoadId, clip\)/.test(src)], [true, true])
  check('§2 Messages: a new conversation picks the driver\'s load by loadRef() and shows it by loadIdShown()',
    [/const ref = idCol \? loadRef\(job, idCol\) : ''/.test(src), /label: loadIdShown\(job, idCol\)/.test(src),
      /<option v-for="l in loadsForDriver" :key="l\.ref" :value="l\.ref">Load \{\{ l\.label \}\}<\/option>/.test(src),
      /store\.selectConversation\(newDriver\.value, newLoadId\.value, picked \? picked\.label : ''\)/.test(src)],
    [true, true, true, true])
})

section('§2 the dashboard page: a stale key, and the assign toast', () => {
  const src = read('views/DashboardView.vue')
  check('§2 dashboard: imports loadKeyStale() and loadIdShown()', /import \{ loadIdShown, loadKeyStale \} from '\.\.\/lib\/loadRef'/.test(src), true)
  const failed = /function actionFailed\(err, fallback\) \{\n\s*toast\(\(err && err\.message\) \|\| fallback, 'error'\)\n\s*if \(loadKeyStale\(err\)\) refresh\(\)\n\}/.test(src)
  const catches = (src.match(/catch \(err\) \{ actionFailed\(err, '[^']+'\) \}/g) || []).length
  check('§2 dashboard: an action that meets a stale key says why and reads the rows again, once (assign, reassign, cancel, status)',
    [failed, catches, /catch \(err\) \{ toast\(\(err && err\.message\)/.test(src)], [true, 4, false])
  check('§2 dashboard: the assign toast names the load as shown ("[contact withheld]" for an ID served blank), never blank',
    [/toast\(`\$\{driver\} assigned to \$\{\(lc && loadIdShown\(job, lc\)\) \|\| 'load'\}`, 'success'\)/.test(src), /assigned to \$\{lc \? job\[lc\] : 'load'\}/.test(src)],
    [true, false])
})

// ══ §3 the Messages store, as shipped ════════════════════════════════════════
// A minimal defineStore: state, getters as live properties, actions bound.
function defineStore(id, def) {
  return () => {
    const s = def.state()
    for (const [k, fn] of Object.entries(def.getters || {})) Object.defineProperty(s, k, { get: () => fn(s), enumerable: true })
    for (const [k, fn] of Object.entries(def.actions || {})) s[k] = fn.bind(s)
    return s
  }
}
function loadMessagesStore(deps) {
  let body = read('stores/messages.js')
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    if (!(spec in deps)) throw new Error(`stores/messages.js imports ${spec}, which this runner does not stub`)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export const (\w+)\s*=/m, (_, name) => `const ${name} = __exports.${name} =`)
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('stores/messages.js: an import/export this runner cannot map')
  const out = {}
  new Function('__deps', '__exports', body)(deps, out)
  return out.useMessagesStore
}
async function sectionAsync(name, fn) {
  try { await fn() } catch (e) { fail++; failures.push(name); console.log(`  FAIL  ${name}: ${e && e.message}`) }
}

await sectionAsync('§3 the Messages store: a thread by its key', async () => {
  const calls = []
  const uploads = []
  let stale = false
  const staleError = () => Object.assign(new Error('This load\'s link is out of date. Reload the page and open the load again.'), { status: 404, code: 'LOAD_KEY_UNKNOWN' })
  const api = {
    async get(url) {
      calls.push(['GET', url])
      if (url === '/api/messages') return { conversations: [] }
      if (stale) throw staleError()
      return { messages: [{ id: 1, from: 'Test Driver', to: 'Dispatch', message: 'At the shipper', loadId: `QA-${WITHHELD}`, read: 1 }] }
    },
    async put(url, body) { calls.push(['PUT', url, body]); return { success: true } },
    async post(url, body) { calls.push(['POST', url, body]); if (stale) throw staleError(); return { success: true } },
    request: async () => ({}),
  }
  const useMessagesStore = loadMessagesStore({
    pinia: { defineStore },
    '../composables/useApi': { useApi: () => api },
    '../lib/voiceNoteText': { voiceNoteLabel: () => 'Voice note (0:04)' },
    '../lib/voiceNoteUpload': { uploadVoiceNote: async (request, o) => { uploads.push(o); if (stale) throw staleError(); return { id: 9, durationMs: 4000 } } },
    '../lib/loadRef': lib,
  })
  const store = useMessagesStore()
  const listReads = () => calls.filter((c) => c[0] === 'GET' && c[1] === '/api/messages').length
  await store.selectConversation('Test Driver', KEY, `QA-${WITHHELD}`)
  check('§3 store: the thread is asked for by the key; the header\'s text is the served one',
    [calls[0], store.selectedLoadId, store.selectedLoadShown, store.currentMessages.length],
    [['GET', `/api/messages/Test%20Driver?loadId=${KEY}`], KEY, `QA-${WITHHELD}`, 1])
  await store.sendMessage('Test Driver', 'Gate code 12', store.selectedLoadId, '', '')
  await store.sendVoiceNote('Test Driver', store.selectedLoadId, { blob: {}, key: 'vn-key-0000000001', durationMs: 4000 })
  const post = calls.find((c) => c[0] === 'POST')
  check('§3 store: a reply and a voice note name the load by its key; their bubbles show the served text, never the key',
    [post && post[2].loadId, uploads[0] && uploads[0].loadId, store.currentMessages.slice(-2).map((m) => m.loadId), JSON.stringify(store.currentMessages).includes(KEY)],
    [KEY, KEY, [`QA-${WITHHELD}`, `QA-${WITHHELD}`], false])
  const before = store.currentMessages.length
  store.addIncomingMessage({ id: 12, from: 'Test Driver', to: 'Dispatch', message: 'Loaded', loadId: `QA-${WITHHELD}`, timestamp: '2030-01-14T10:00:00.000Z' })
  store.addIncomingMessage({ id: 13, from: 'Test Driver', to: 'Dispatch', message: 'Another load', loadId: '80000031', timestamp: '2030-01-14T10:01:00.000Z' })
  check('§3 store: a live message on the thread\'s load (the dispatch room gets it as shown) joins the open thread; another load\'s does not',
    store.currentMessages.slice(before).map((m) => m.id), [12])

  stale = true
  calls.length = 0
  await store.selectConversation('Test Driver', KEY2, `QA-${WITHHELD}`)
  check('§3 store: opening a conversation on a stale key: the thread is emptied (no other conversation\'s under its header) and the list read again, once',
    [store.currentMessages.length, listReads()], [0, 1])
  for (const [what, send] of [
    ['a reply', () => store.sendMessage('Test Driver', 'Hi', KEY2, '', '')],
    ['a voice note', () => store.sendVoiceNote('Test Driver', KEY2, { blob: {}, key: 'vn-key-0000000002', durationMs: 4000 })],
  ]) {
    calls.length = 0
    let thrown = null
    try { await send() } catch (e) { thrown = e }
    check(`§3 store: ${what} on a stale key still fails to the panel, and the list is read again, once`,
      [thrown && thrown.code, listReads()], ['LOAD_KEY_UNKNOWN', 1])
  }

  stale = false
  calls.length = 0
  await store.selectConversation('Test Driver', 'L-100')
  check('§3 store: a conversation with no key, as before: asked for by its loadId, which is also its text',
    [calls[0], store.selectedLoadId, store.selectedLoadShown], [['GET', '/api/messages/Test%20Driver?loadId=L-100'], 'L-100', 'L-100'])
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log(`Failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
