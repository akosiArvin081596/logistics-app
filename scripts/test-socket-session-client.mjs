#!/usr/bin/env node
// The client half of "a live-update connection ends with its session":
// client/src/composables/useSocket.js and the three auth-store actions that
// change who is signed in on this browser.
//
// WHY THIS EXISTS. useSocket() keeps ONE socket for the whole app, and
// connect() is a no-op while it exists. Nothing used to drop it: logout left it
// connected, the next person to sign in on the same tab inherited it (and the
// room name it had registered), and a socket the server had closed stayed in
// place, so connect() could never open another. scripts/test-session-sockets.js
// holds the server to closing the socket; this holds the client to letting go.
//
// What is asserted, against the committed files:
//   U1 connect() opens one socket; a second call opens nothing
//   U2 a registered name is sent on 'connect'
//   U3 disconnect(): the socket is closed and the state reset (not connected, not
//      once-connected, no name); the next connect() opens a NEW socket, which
//      registers nothing until asked, and registers when asked
//   U4 a server disconnect ('io server disconnect'): the socket is dropped with
//      its name; the next connect() opens a NEW socket; the page still reads as
//      once-connected, so the driver's "Offline" chip shows
//   U5 a transport drop (any other reason) KEEPS the socket, which socket.io
//      reconnects by itself, and it re-registers when it does
//   U6 a replaced socket's late events change nothing about its successor
//   A1 auth.login(): a successful POST ends the socket and resets the state; a
//      refused sign-in leaves it alone
//   A2 auth.setup(): the same
//   A3 auth.logout(): the socket ends whether or not the request gets through
//   T  every logout button reaches auth.logout(), the one caller of the route
// Then MUTANTS of both files, each of which must flip the property it names.
//
// Loads useSocket.js with socket.io-client replaced by a scripted fake, and
// stores/auth.js with the real Pinia and useApi (fetch scripted) sharing that
// one useSocket instance. Each scenario gets fresh module instances. No
// network, no DOM; Vue and Pinia come from client/node_modules, which `npm ci`
// at the repo root installs.
//
//   node scripts/test-socket-session-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..', 'client')
const SRC_DIR = path.join(CLIENT_DIR, 'src')
const read = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
const USE_SOCKET_SRC = read('composables/useSocket.js')
const AUTH_SRC = read('stores/auth.js')

let pass = 0
const failures = []
const ok = (cond, msg) => {
  if (cond) pass++
  else failures.push(msg)
}
function finish() {
  console.log(`\n${'='.repeat(64)}`)
  if (failures.length) {
    console.log(`FAILURES (${failures.length}):`)
    for (const f of failures) console.log(`  ✗ ${f}`)
    console.log(`\n${pass} passed, ${failures.length} failed`)
    process.exit(1)
  }
  console.log(`✓ ${pass} assertions passed`)
  process.exit(0)
}

// The files Node resolves the bare `vue` and `pinia` imports to (node + import
// conditions), so this runner, the store and Pinia share one instance of each.
const VUE_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'vue', 'index.mjs')).href
const PINIA_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href
let pinia
try {
  pinia = await import(PINIA_URL)
  await import(VUE_URL)
} catch (err) {
  ok(false, `cannot load Vue/Pinia from client/node_modules (${err.code || err.message}); \`npm ci\` at the repo root installs them`)
  finish()
}

// ── the fake socket.io-client ─────────────────────────────────────────────────
// Shaped like the real one where useSocket touches it. disconnect() on a
// connected socket fires 'disconnect' synchronously with "io client disconnect",
// as socket.io-client does; the server-side events are driven by the test.
class FakeSocket {
  constructor(args) {
    this.args = args
    this.handlers = new Map()
    this.emitted = []
    this.disconnectCalls = 0
    this.connected = false
  }
  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event).push(cb)
    return this
  }
  off(event, cb) {
    const list = this.handlers.get(event) || []
    const i = list.indexOf(cb)
    if (i >= 0) list.splice(i, 1)
    return this
  }
  emit(event, ...args) {
    this.emitted.push([event, ...args])
    return this
  }
  disconnect() {
    this.disconnectCalls++
    if (this.connected) {
      this.connected = false
      this.fire('disconnect', 'io client disconnect')
    }
    return this
  }
  fire(event, ...args) {
    for (const cb of [...(this.handlers.get(event) || [])]) cb(...args)
  }
  serverConnect() {
    this.connected = true
    this.fire('connect')
  }
  serverDisconnect(reason) {
    this.connected = false
    this.fire('disconnect', reason)
  }
  registered() {
    return this.emitted.filter((e) => e[0] === 'register').map((e) => e[1])
  }
}
const world = { created: [] }
globalThis.__t3SocketFake = { create: (args) => { const s = new FakeSocket(args); world.created.push(s); return s } }
const FAKE_IO_URL = 'data:text/javascript;base64,' +
  Buffer.from('export function io(...args) { return globalThis.__t3SocketFake.create(args) }\n', 'utf8').toString('base64')

// fetch, scripted: an answer nobody scripted is "no network".
const OFFLINE = Object.freeze({ offline: true })
const answers = []
globalThis.fetch = () => {
  const a = answers.length ? answers.shift() : OFFLINE
  if (a.offline) return Promise.reject(new TypeError('Failed to fetch'))
  return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json })
}

// ── loading the committed files (or a mutant of one) ─────────────────────────
function rewriteImports(src, map) {
  let missing = null
  const out = src.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    if (!(spec in map)) {
      missing = spec
      return m
    }
    return pre + q + map[spec] + q
  })
  if (missing) throw new Error(`an import this runner does not provide: ${missing}`)
  return out
}
let loadSeq = 0
const asDataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(`${text}\n// load ${++loadSeq}\n`, 'utf8').toString('base64')

// A fresh useSocket module (fresh module-level socket state), and optionally a
// fresh auth store bound to that same instance.
async function freshWorld({ socketSrc = USE_SOCKET_SRC, authSrc = AUTH_SRC, withStore = false } = {}) {
  world.created = []
  answers.length = 0
  const socketUrl = asDataUrl(rewriteImports(socketSrc, { vue: VUE_URL, 'socket.io-client': FAKE_IO_URL }))
  const { useSocket } = await import(socketUrl)
  let store = null
  if (withStore) {
    const authUrl = asDataUrl(rewriteImports(authSrc, {
      pinia: PINIA_URL,
      '../composables/useApi.js': pathToFileURL(path.join(SRC_DIR, 'composables', 'useApi.js')).href,
      '../composables/useSocket.js': socketUrl,
      '../lib/sessionCheck.js': pathToFileURL(path.join(SRC_DIR, 'lib', 'sessionCheck.js')).href,
    }))
    const mod = await import(authUrl)
    store = mod.useAuthStore(pinia.createPinia())
  }
  return { useSocket, store, created: world.created }
}

// A signed-in tab: socket open, connected, registered.
function liveTab(useSocket, created, name = 'dispatch') {
  const s = useSocket()
  s.connect()
  s.register(name)
  const sock = created[created.length - 1]
  sock.serverConnect()
  return { s, sock }
}
const USER = { id: 2, username: 'bob', role: 'Driver', driverName: 'Bob Driver', companyName: '', fullName: 'Bob Driver', mustChangePassword: false }

// ── scenarios: each sets named properties, all true on the committed code ────
const SCENARIOS = {
  async u1(src, p) {
    const { useSocket, created } = await freshWorld(src)
    useSocket().connect()
    useSocket().connect()
    p.oneSocketForTheApp = created.length === 1
  },

  async u2(src, p) {
    const { useSocket, created } = await freshWorld(src)
    const s = useSocket()
    s.register('dispatch')
    s.connect()
    created[0].serverConnect()
    p.registersOnConnect = created[0].registered().includes('dispatch') && s.isConnected.value === true && s.hasEverConnected.value === true
  },

  async u3(src, p) {
    const { useSocket, created } = await freshWorld(src)
    const { s, sock } = liveTab(useSocket, created)
    s.disconnect()
    p.disconnectClosesSocket = sock.disconnectCalls === 1 && s.isConnected.value === false
    p.disconnectResetsOnceConnected = s.hasEverConnected.value === false
    s.connect()
    const next = created[1]
    p.disconnectLetsConnectOpenANewSocket = created.length === 2 && !!next
    if (next) next.serverConnect()
    p.disconnectForgetsTheName = !!next && next.registered().length === 0
    s.register('bob driver')
    p.newSocketRegistersWhenAsked = !!next && next.registered().join() === 'bob driver'
  },

  async u4(src, p) {
    const { useSocket, created } = await freshWorld(src)
    const { s, sock } = liveTab(useSocket, created)
    sock.serverDisconnect('io server disconnect')
    p.serverDisconnectReadsOffline = s.isConnected.value === false && s.hasEverConnected.value === true
    s.connect()
    const next = created[1]
    p.serverDisconnectLetsConnectOpenANewSocket = created.length === 2 && !!next
    if (next) next.serverConnect()
    p.serverDisconnectForgetsTheName = !!next && next.registered().length === 0
  },

  async u5(src, p) {
    const { useSocket, created } = await freshWorld(src)
    const { s, sock } = liveTab(useSocket, created)
    let kept = true
    for (const reason of ['transport close', 'ping timeout', 'transport error']) {
      sock.emitted.length = 0
      sock.serverDisconnect(reason)
      const offline = s.isConnected.value === false
      s.connect() // socket.io is reconnecting this one itself: nothing new may open
      sock.serverConnect() // ...and here it is back
      kept = kept && offline && created.length === 1 && sock.registered().join() === 'dispatch' && s.isConnected.value === true
    }
    p.transportDropKeepsAndReRegisters = kept
  },

  async u6(src, p) {
    const { useSocket, created } = await freshWorld(src)
    const { s, sock: old } = liveTab(useSocket, created)
    s.disconnect()
    s.connect()
    const next = created[1]
    s.register('bob driver') // the next person's name, for the next socket only
    const sentBefore = old.registered().length
    old.fire('connect') // late, from the replaced socket
    p.lateConnectFromReplacedIgnored = s.isConnected.value === false && old.registered().length === sentBefore
    next.serverConnect()
    old.fire('disconnect', 'io server disconnect') // late, from the replaced socket
    s.connect()
    p.lateDisconnectFromReplacedIgnored = s.isConnected.value === true && created.length === 2
  },

  async a1(src, p) {
    const { useSocket, created, store } = await freshWorld({ ...src, withStore: true })
    const { s, sock } = liveTab(useSocket, created)
    answers.push({ status: 401, json: { error: 'Invalid credentials' } })
    let refused = false
    try { await store.login('bob', 'not-the-password') } catch { refused = true }
    s.connect()
    p.refusedLoginKeepsSocket = refused && sock.disconnectCalls === 0 && created.length === 1 && s.isConnected.value === true
    answers.push({ status: 200, json: { success: true, user: USER } })
    await store.login('bob', 'Bob-Pass-2!')
    p.loginEndsSocket = sock.disconnectCalls === 1 && s.isConnected.value === false && s.hasEverConnected.value === false
    s.connect()
    const next = created[1]
    if (next) next.serverConnect()
    p.loginNextSocketIsFresh = created.length === 2 && !!next && next.registered().length === 0
  },

  async a2(src, p) {
    const { useSocket, created, store } = await freshWorld({ ...src, withStore: true })
    const { s, sock } = liveTab(useSocket, created)
    answers.push({ status: 400, json: { error: 'Setup already completed' } })
    let refused = false
    try { await store.setup('first_admin', 'First-Admin-1!', 'fa@example.test') } catch { refused = true }
    p.refusedSetupKeepsSocket = refused && sock.disconnectCalls === 0 && s.isConnected.value === true
    answers.push({ status: 200, json: { success: true, role: 'Super Admin' } })
    await store.setup('first_admin', 'First-Admin-1!', 'fa@example.test')
    s.connect()
    const next = created[1]
    if (next) next.serverConnect()
    p.setupEndsSocket = sock.disconnectCalls === 1 && created.length === 2 && !!next && next.registered().length === 0
  },

  async a3(src, p) {
    {
      const { useSocket, created, store } = await freshWorld({ ...src, withStore: true })
      const { s, sock } = liveTab(useSocket, created)
      answers.push({ status: 200, json: { success: true } })
      await store.logout()
      s.connect()
      p.logoutEndsSocket = sock.disconnectCalls === 1 && created.length === 2 && created[1].registered().length === 0
    }
    {
      const { useSocket, created, store } = await freshWorld({ ...src, withStore: true })
      const { sock } = liveTab(useSocket, created)
      answers.push(OFFLINE) // the request never gets through
      await store.logout()
      p.unconfirmedLogoutStillEndsSocket = sock.disconnectCalls === 1 && store.isAuthenticated === false
    }
  },
}

const PROPS = {
  oneSocketForTheApp: 'U1 connect() must open one socket for the whole app',
  registersOnConnect: "U2 a registered name must be sent on 'connect'",
  disconnectClosesSocket: 'U3 disconnect() must close the socket',
  disconnectResetsOnceConnected: 'U3 ...and reset "once connected", so the next person does not start on an Offline chip',
  disconnectLetsConnectOpenANewSocket: 'U3 ...so the next connect() opens a NEW socket',
  disconnectForgetsTheName: 'U3 ...which registers nothing until asked (the room name went with the old socket)',
  newSocketRegistersWhenAsked: 'U3 ...and registers the new name when asked',
  serverDisconnectReadsOffline: 'U4 a server disconnect must read as offline, and as once-connected (the Offline chip shows)',
  serverDisconnectLetsConnectOpenANewSocket: 'U4 ...and drop the socket: socket.io never reconnects it, so the next connect() must open a new one',
  serverDisconnectForgetsTheName: 'U4 ...with the name it registered',
  transportDropKeepsAndReRegisters: 'U5 a transport drop must KEEP the socket (socket.io reconnects it) and re-register on reconnect',
  lateConnectFromReplacedIgnored: "U6 a replaced socket's late 'connect' must not mark its successor connected",
  lateDisconnectFromReplacedIgnored: "U6 a replaced socket's late server disconnect must not drop its successor",
  refusedLoginKeepsSocket: 'A1 a refused sign-in changed no session, so the socket must stay',
  loginEndsSocket: 'A1 a successful sign-in must end the socket and reset its state',
  loginNextSocketIsFresh: "A1 ...so the next page's socket is fresh, with no inherited room name",
  refusedSetupKeepsSocket: 'A2 a refused setup must leave the socket alone',
  setupEndsSocket: 'A2 a successful setup must end the socket, and the next one must be fresh',
  logoutEndsSocket: 'A3 logout must end the socket, and the next one must be fresh',
  unconfirmedLogoutStillEndsSocket: 'A3 ...even when the logout request never gets through (the person asked to leave)',
}

async function probe(src = {}) {
  const p = {}
  const errors = []
  for (const [name, run] of Object.entries(SCENARIOS)) {
    try {
      await run(src, p)
    } catch (err) {
      errors.push(`${name}: ${err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err}`)
    }
  }
  return { p, errors }
}

// ── T: every logout button reaches auth.logout(), the one caller of the route ─
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}
{
  for (const rel of ['components/layout/AppSidebar.vue', 'views/ChangePasswordView.vue', 'views/DriverView.vue']) {
    ok(/\bauth\.logout\(\)/.test(stripComments(read(rel))), `T ${rel} must log out through auth.logout(), which ends the socket`)
  }
  const callers = walk(SRC_DIR)
    .filter((f) => /\.(js|vue)$/.test(f))
    .filter((f) => /['"`]\/api\/auth\/logout['"`]/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC_DIR, f))
  ok(callers.length === 1 && callers[0] === path.join('stores', 'auth.js'),
    `T only stores/auth.js may call POST /api/auth/logout, or a logout could skip the socket (found: ${callers.join(', ') || 'none'})`)
}

// ── mutants ──────────────────────────────────────────────────────────────────
// The body of the block opened by `head`, edited in place.
function editBlock(src, head, edit) {
  const at = src.indexOf(head)
  if (at < 0) return null
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) {
      const body = src.slice(open, i + 1)
      const next = edit(body)
      return next === body ? null : src.slice(0, open) + next + src.slice(i + 1)
    }
  }
  return null
}
const DISCONNECT_LINE = /\n\s*useSocket\(\)\.disconnect\(\)[^\n]*/
const MUTANTS = [
  ['disconnect() keeps the registered name', { socketSrc: (s) => editBlock(s, 'function disconnect() {', (b) => b.replace('\n    registeredName = null', '')) },
    ['disconnectForgetsTheName', 'loginNextSocketIsFresh']],
  ['disconnect() leaves the page reading as once-connected', { socketSrc: (s) => editBlock(s, 'function disconnect() {', (b) => b.replace('\n    hasEverConnected.value = false', '')) },
    ['disconnectResetsOnceConnected']],
  ['a server disconnect keeps the dead socket', { socketSrc: (s) => s.replace(/\n\s*if \(reason === 'io server disconnect'\) \{\n\s*socket = null\n\s*registeredName = null\n\s*\}/, '') },
    ['serverDisconnectLetsConnectOpenANewSocket']],
  ['a server disconnect keeps the registered name', { socketSrc: (s) => s.replace(/(if \(reason === 'io server disconnect'\) \{\n\s*socket = null)\n\s*registeredName = null/, '$1') },
    ['serverDisconnectForgetsTheName']],
  ['every disconnect drops the socket, even a transport drop socket.io would reconnect', { socketSrc: (s) => s.replace("if (reason === 'io server disconnect') {", 'if (true) {') },
    ['transportDropKeepsAndReRegisters']],
  ["the handlers act for a socket that was replaced", { socketSrc: (s) => s.split('\n      if (socket !== s) return').join('') },
    ['lateConnectFromReplacedIgnored', 'lateDisconnectFromReplacedIgnored']],
  ['login() does not end the socket', { authSrc: (s) => editBlock(s, 'async login(username, password) {', (b) => b.replace(DISCONNECT_LINE, '')) },
    ['loginEndsSocket', 'loginNextSocketIsFresh']],
  ['login() ends the socket before the POST, so a refused sign-in drops it', {
    authSrc: (s) => editBlock(s, 'async login(username, password) {', (b) => b
      .replace(DISCONNECT_LINE, '')
      .replace("const data = await api.post('/api/auth/login'", "useSocket().disconnect()\n      const data = await api.post('/api/auth/login'")),
  }, ['refusedLoginKeepsSocket']],
  ['setup() does not end the socket', { authSrc: (s) => editBlock(s, 'async setup(username, password, email) {', (b) => b.replace(DISCONNECT_LINE, '')) },
    ['setupEndsSocket']],
  ['logout() does not end the socket', { authSrc: (s) => editBlock(s, 'async logout() {', (b) => b.replace(DISCONNECT_LINE, '')) },
    ['logoutEndsSocket', 'unconfirmedLogoutStillEndsSocket']],
  ['logout() ends the socket only once the server confirms', {
    authSrc: (s) => editBlock(s, 'async logout() {', (b) => b
      .replace(DISCONNECT_LINE, '')
      .replace("if (await this._sendLogout()) removeKey('local', PENDING_LOGOUT_KEY)",
        "if (await this._sendLogout()) {\n        removeKey('local', PENDING_LOGOUT_KEY)\n        useSocket().disconnect()\n      }")),
  }, ['unconfirmedLogoutStillEndsSocket']],
]

const shipped = await probe()
ok(shipped.errors.length === 0, `the committed files crashed a scenario: ${shipped.errors.join(' || ')}`)
for (const [prop, message] of Object.entries(PROPS)) ok(shipped.p[prop] === true, `${message} [${prop} = ${shipped.p[prop]}]`)
const unlisted = Object.keys(shipped.p).filter((k) => !PROPS[k])
ok(unlisted.length === 0, `every probed property must be described in PROPS: ${unlisted.join(', ')}`)

for (const [name, edits, caughtBy] of MUTANTS) {
  const src = {}
  let built = true
  if (edits.socketSrc) {
    src.socketSrc = edits.socketSrc(USE_SOCKET_SRC)
    built = built && typeof src.socketSrc === 'string' && src.socketSrc !== USE_SOCKET_SRC
  }
  if (edits.authSrc) {
    src.authSrc = edits.authSrc(AUTH_SRC)
    built = built && typeof src.authSrc === 'string' && src.authSrc !== AUTH_SRC
  }
  ok(built, `mutant could not be built: "${name}" (its target text moved; update the mutant with the file)`)
  if (!built) continue
  const got = await probe(src)
  ok(got.errors.length === 0, `mutant "${name}" crashed a scenario instead of failing an assertion: ${got.errors.join(' || ')}`)
  for (const prop of caughtBy) {
    ok(shipped.p[prop] === true && got.p[prop] === false, `MUTANT NOT CAUGHT — "${name}" must flip ${prop} (committed ${shipped.p[prop]}, mutant ${got.p[prop]})`)
  }
}

finish()
