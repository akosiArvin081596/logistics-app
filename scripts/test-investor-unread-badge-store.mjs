// scripts/test-investor-unread-badge-store.mjs — opening a conversation in the
// Dispatch inbox marks its unread messages to either staff desk read.
//
// An investor writes to the "admin" desk (#589); a driver to "Dispatch". The
// inbox (stores/messages.js selectConversation()) sends PUT /api/messages/read
// for the unread messages addressed to a desk, so the badge GET /api/messages
// counts (scripts/test-investor-unread-badge.js) clears once staff open it.
//
//   §1 an investor's conversation: its unread messages to "admin" (any letter
//      case) are marked; one already read, staff's own reply to the investor
//      and a look-alike name ("admin2") are not. The list reloads after.
//   §2 a driver's conversation: unread messages to "Dispatch" are marked, as
//      before; nothing unread sends no PUT.
//
// The store runs as shipped, its imports stubbed (pinia's defineStore, useApi,
// the voice-note helpers; the load-reference helper is the real one). Made-up
// names only.
//   node scripts/test-investor-unread-badge-store.mjs
//   MESSAGES_STORE_JS=/path/to/base/messages.js node scripts/test-investor-unread-badge-store.mjs   # the base: fails §1
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE = process.env.MESSAGES_STORE_JS || path.join(__dirname, '..', 'client', 'src', 'stores', 'messages.js')
// The load-reference helper (withheld-load keys) is pure: the store uses it as shipped.
const loadRef = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib', 'loadRef.js')).href)

let failed = 0
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`)
  else { failed++; console.log(`FAIL  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`) }
}
const eq = (name, got, want) => ok(`${name} (want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want), got)

// A minimal defineStore: state, getters as live properties, actions bound.
function defineStore(id, def) {
  return () => {
    const s = def.state()
    for (const [k, fn] of Object.entries(def.getters || {})) Object.defineProperty(s, k, { get: () => fn(s), enumerable: true })
    for (const [k, fn] of Object.entries(def.actions || {})) s[k] = fn.bind(s)
    return s
  }
}

// The API: GET answers from `threads` and `conversations`; every call is kept.
const calls = []
let threads = {}
let conversations = []
const api = {
  async get(url) {
    calls.push({ method: 'GET', url })
    if (url === '/api/messages') return { conversations }
    const name = decodeURIComponent(url.replace(/^\/api\/messages\//, '').replace(/\?.*$/, ''))
    return { messages: threads[name] || [] }
  },
  async put(url, body) { calls.push({ method: 'PUT', url, body }); return { success: true } },
  async post(url, body) { calls.push({ method: 'POST', url, body }); return { success: true } },
  request: async () => ({}),
}

function loadStore() {
  let body = fs.readFileSync(STORE, 'utf8')
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export const (\w+)\s*=/m, (_, name) => `const ${name} = __exports.${name} =`)
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('stores/messages.js: an import/export this harness cannot map')
  const deps = {
    pinia: { defineStore },
    '../composables/useApi': { useApi: () => api },
    '../lib/voiceNoteText': { voiceNoteLabel: () => 'Voice note' },
    '../lib/voiceNoteUpload': { uploadVoiceNote: async () => ({}) },
    '../lib/loadRef': loadRef,
  }
  for (const spec of specs) if (!(spec in deps)) throw new Error(`stores/messages.js imports ${spec}, which this runner does not stub`)
  const exportsObj = {}
  new Function('__deps', '__exports', body)(deps, exportsObj)
  return exportsObj.useMessagesStore
}

let useMessagesStore
try { useMessagesStore = loadStore() } catch (err) { ok(`stores/messages.js loads (${err.message})`, false) }

const INVESTOR = 'inv_t'
const DRIVER = 'Tamsin Vale'
const markCalls = () => calls.filter((c) => c.method === 'PUT' && c.url === '/api/messages/read')

if (useMessagesStore) {
  console.log('§1 an investor\'s conversation')
  {
    calls.length = 0
    threads = {
      [INVESTOR]: [
        { id: 31, from: INVESTOR, to: 'admin', message: 'Question about my statement', read: 0 },
        { id: 32, from: INVESTOR, to: 'admin', message: 'And one more', read: 0 },
        { id: 33, from: INVESTOR, to: 'admin', message: 'Read earlier', read: 1 },
        { id: 34, from: INVESTOR, to: 'Admin', message: 'Older spelling', read: 0 },
        { id: 35, from: 'Dispatch', to: INVESTOR, message: 'Statement attached', read: 0 },
        { id: 36, from: INVESTOR, to: 'admin2', message: 'not a desk', read: 0 },
      ],
    }
    const store = useMessagesStore()
    await store.selectConversation(INVESTOR, '')
    const puts = markCalls()
    eq('§1 one PUT /api/messages/read', puts.length, 1)
    eq('§1 ...for the unread messages to "admin" (any case) only', puts[0] && [...puts[0].body.messageIds].sort((a, b) => a - b), [31, 32, 34])
    ok('§1 the conversation list reloads after', calls.some((c, i) => c.method === 'GET' && c.url === '/api/messages' && i > calls.indexOf(puts[0])))
  }

  console.log('§2 a driver\'s conversation, as before')
  {
    calls.length = 0
    threads = {
      [DRIVER]: [
        { id: 41, from: DRIVER, to: 'Dispatch', message: 'At the shipper', read: 0 },
        { id: 42, from: 'Dispatch', to: DRIVER, message: 'Call when loaded', read: 0 },
      ],
    }
    const store = useMessagesStore()
    await store.selectConversation(DRIVER, 'L-100')
    const puts = markCalls()
    eq('§2 the unread message to "Dispatch" is marked', puts.map((p) => p.body.messageIds), [[41]])
    ok('§2 the thread is asked for with its load', calls.some((c) => c.method === 'GET' && c.url === `/api/messages/${encodeURIComponent(DRIVER)}?loadId=L-100`))

    calls.length = 0
    threads = { [DRIVER]: [{ id: 43, from: DRIVER, to: 'Dispatch', message: 'Read earlier', read: 1 }] }
    await store.selectConversation(DRIVER, '')
    eq('§2 nothing unread: no PUT', markCalls().length, 0)
  }
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
