#!/usr/bin/env node
// "Shared login" labels, and the Users page's account fields (named Super Admin
// logins). `super_admin` is a login more than one person used: a row it wrote
// names the login, never the person, and the screens say so.
//
//   §1 the two lists: lib/sign-in.js SHARED_LOGIN_USERNAMES and
//      client/src/utils/sharedLogin.js hold the same names, and both helpers
//      fold case and edge spaces the same way
//   §2 GET /api/admin/audit-trail (lifted): sharedLogin true on "super_admin",
//      " Super_Admin " and a user_id 0 row with that name (an old session
//      without an id); false on every other row; the rows otherwise unchanged
//   §3 GET /api/users (lifted): MustChangePassword, EmailShared (the same email
//      on another account, compared as the sign-in lookup compares it; a blank
//      email never), SharedLogin, and newStaffMustChangePassword following
//      NAMED_LOGINS_ENABLED
//   §4 the client label: "super_admin · shared login, person not recorded",
//      any other name as given; the Data Issues "Account" cell, the invoice
//      "Manual by" line and the payout-basis panel render through it; the
//      Users table shows the three chips
//   §5 ChatBubble's side: in a driver's thread a named staff member's message
//      is sent and the driver's is not; with no party only the desk names are
//      sent; MessagingPanel hands ChatBubble the thread's party
//
// Pure: no server, no network, no app.db (in-memory SQLite). Made-up accounts.
//   node scripts/test-shared-login-labels.mjs
//   SERVER_JS=/tmp/base.js node scripts/test-shared-login-labels.mjs   # a base commit: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, 'server.js'), 'utf8')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const Database = require('better-sqlite3')

// Absent before this change: each section then reports what is missing.
let signInLib = null
try { signInLib = require(path.join(ROOT, 'lib', 'sign-in.js')) } catch { signInLib = null }
let client = null
try { client = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'utils', 'sharedLogin.js')).href) } catch { client = null }

// A route from its exact head to the `});` that closes it in column 0, or null.
function liftRoute(head) {
  if (SRC.split(head).length - 1 !== 1) return null
  const a = SRC.indexOf(head)
  return SRC.slice(a, SRC.indexOf('\n});', a) + '\n});'.length)
}
function tableDdl(name) {
  const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`))
  if (!m) throw new Error(`could not locate CREATE TABLE ${name}`)
  return `CREATE TABLE ${name} (${m[1]}\n)`
}
function alterDdl(col) {
  const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`))
  if (!m) throw new Error(`could not locate the users.${col} migration`)
  return m[0]
}
// A GET route's handler, called once with `query`; its JSON answer.
function callGet(routeSrc, env, query = {}) {
  let handler = null
  const app = { get: (p, ...fns) => { handler = fns[fns.length - 1] } }
  const names = ['app', 'requireRole', ...Object.keys(env)]
  new Function(...names, routeSrc)(app, () => (req, res, next) => next(), ...Object.values(env))
  const out = { status: 200, body: null }
  const res = { status(c) { out.status = c; return this }, json(b) { out.body = b; return this }, setHeader() {} }
  handler({ query, session: { user: { id: 7, username: 'owner_named', role: 'Super Admin' } } }, res)
  return out
}

// ─────────────────────────────── §1 the two lists
console.log('§1 the server and client lists')
ok('§1 lib/sign-in.js exists and lists the shared logins', !!signInLib && Array.isArray(signInLib.SHARED_LOGIN_USERNAMES))
ok('§1 client/src/utils/sharedLogin.js exists and lists the shared logins', !!client && Array.isArray(client.SHARED_LOGIN_USERNAMES))
if (signInLib && client) {
  ok(`§1 the two lists are identical (server ${JSON.stringify(signInLib.SHARED_LOGIN_USERNAMES)}, client ${JSON.stringify(client.SHARED_LOGIN_USERNAMES)})`,
    JSON.stringify(signInLib.SHARED_LOGIN_USERNAMES) === JSON.stringify(client.SHARED_LOGIN_USERNAMES))
  ok('§1 ...and name super_admin', signInLib.SHARED_LOGIN_USERNAMES.includes('super_admin'))
  for (const name of ['super_admin', ' Super_Admin ', 'SUPER_ADMIN', 'super_admin2', 'owner_named', '', null, undefined, 'super admin']) {
    ok(`§1 both helpers agree on ${JSON.stringify(name)}`, signInLib.isSharedLoginName(name) === client.isSharedLogin(name))
  }
  ok('§1 ...folding case and edge spaces, nothing else', client.isSharedLogin(' Super_Admin ') && !client.isSharedLogin('super admin') && !client.isSharedLogin('super_admin2'))
}

// ─────────────────────────────── §2 GET /api/admin/audit-trail
console.log('§2 GET /api/admin/audit-trail')
{
  const route = liftRoute('app.get("/api/admin/audit-trail", requireRole("Super Admin"), (req, res) => {')
  ok('§2 GET /api/admin/audit-trail is registered once', !!route)
  if (route) {
    const db = new Database(':memory:')
    db.exec(tableDdl('audit_trail'))
    const ins = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, 'user', '', '')")
    ins.run('2026-10-01T10:00:00.000Z', 1, 'super_admin', 'Super Admin', 'create_user')
    ins.run('2026-10-01T10:01:00.000Z', 1, ' Super_Admin ', 'Super Admin', 'update_user')
    ins.run('2026-10-01T10:02:00.000Z', 0, 'super_admin', 'Super Admin', 'old_session_row')
    ins.run('2026-10-01T10:03:00.000Z', 7, 'owner_named', 'Super Admin', 'create_user')
    ins.run('2026-10-01T10:04:00.000Z', 0, 'system', 'system', 'reset_password_script')
    ins.run('2026-10-01T10:05:00.000Z', 9, 'super_admin2', 'Dispatcher', 'update_user')
    let out = null
    try { out = callGet(route, { db, signInLib }) } catch (e) { ok(`§2 the route answers (${e.message})`, false) }
    const logs = (out && out.body && out.body.logs) || []
    const by = (action, username) => logs.find((r) => r.action === action && r.username === username) || {}
    ok('§2 "super_admin" is labelled a shared login', by('create_user', 'super_admin').sharedLogin === true)
    ok('§2 " Super_Admin " too (trimmed, case-folded)', by('update_user', ' Super_Admin ').sharedLogin === true)
    ok('§2 a user_id 0 row under that name too (an old session without an id)', by('old_session_row', 'super_admin').sharedLogin === true)
    ok('§2 a named account is not', by('create_user', 'owner_named').sharedLogin === false)
    ok('§2 nor a system row, nor a name that only starts the same', by('reset_password_script', 'system').sharedLogin === false && by('update_user', 'super_admin2').sharedLogin === false)
    ok('§2 every row keeps its columns', logs.length === 6 && logs.every((r) => typeof r.id === 'number' && typeof r.details === 'string' && 'created_at' in r))
  }
}

// ─────────────────────────────── §3 GET /api/users
console.log('§3 GET /api/users')
{
  const route = liftRoute('app.get("/api/users", requireRole("Super Admin"), (req, res) => {')
  ok('§3 GET /api/users is registered once', !!route)
  if (route) {
    const db = new Database(':memory:')
    db.exec(tableDdl('users'))
    for (const col of ['full_name', 'company_name', 'rating', 'must_change_password', 'last_login_at']) db.exec(alterDdl(col))
    db.exec(tableDdl('driver_onboarding'))
    const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, email, must_change_password) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run(1, 'super_admin', 'x', 'Super Admin', 'boss@example.test', 0)
    ins.run(7, 'owner_named', 'x', 'Super Admin', 'Boss@Example.test', 1)
    ins.run(8, 'arvin_named', 'x', 'Super Admin', 'arvin@example.test', 0)
    ins.run(20, 'disp.one', 'x', 'Dispatcher', '', 0)
    ins.run(21, 'disp.two', 'x', 'Dispatcher', '', 0)
    const run = (flag) => callGet(route, { db, signInLib, NAMED_LOGINS_ENABLED: flag }).body || {}
    const off = run(false)
    const users = off.users || []
    const u = (id) => users.find((x) => x.id === id) || {}
    ok('§3 MustChangePassword is the account\'s flag', u(7).MustChangePassword === true && u(8).MustChangePassword === false)
    ok('§3 EmailShared marks both accounts sharing an email, in any case', u(1).EmailShared === true && u(7).EmailShared === true)
    ok('§3 ...and not an email on one account, nor two blank ones', u(8).EmailShared === false && u(20).EmailShared === false && u(21).EmailShared === false)
    ok('§3 SharedLogin marks the shared login only', u(1).SharedLogin === true && [7, 8, 20, 21].every((id) => u(id).SharedLogin === false))
    ok('§3 the existing fields are unchanged', u(8).Username === 'arvin_named' && u(8).Role === 'Super Admin' && u(8).Email === 'arvin@example.test' && u(8).LastLoginAt === null)
    ok('§3 newStaffMustChangePassword follows NAMED_LOGINS_ENABLED', off.newStaffMustChangePassword === false && run(true).newStaffMustChangePassword === true)
  }
}

// ─────────────────────────────── §4 the client label
console.log('§4 the client label and the screens')
if (client) {
  ok(`§4 the label (got ${JSON.stringify(client.actorLabel('super_admin'))})`, client.actorLabel('super_admin') === 'super_admin · shared login, person not recorded')
  ok('§4 ...as typed, trimmed', client.actorLabel(' Super_Admin ') === 'Super_Admin · shared login, person not recorded')
  ok('§4 any other name as given', client.actorLabel('owner_named') === 'owner_named' && client.actorLabel('') === '' && client.actorLabel(null) === '')
} else {
  ok('§4 client/src/utils/sharedLogin.js actorLabel() exists', false)
}
const readClient = (rel) => fs.readFileSync(path.join(ROOT, 'client', 'src', rel), 'utf8')
{
  const dataIssues = readClient('views/DataIssuesView.vue')
  ok('§4 Data Issues: the refusals\' "Account" cell renders through actorLabel()', /\{\{\s*actorLabel\(r\.account\)/.test(dataIssues) && /import \{ actorLabel \} from '\.\.\/utils\/sharedLogin'/.test(dataIssues))
  const invoices = readClient('views/InvoicesView.vue')
  ok('§4 Invoices: "Manual by" renders through actorLabel()', /' by ' \+ actorLabel\(selectedInvoice\.created_by\)/.test(invoices) && /import \{ actorLabel \} from '\.\.\/utils\/sharedLogin'/.test(invoices))
  const basis = readClient('components/investors/PayoutBasisPanel.vue')
  ok('§4 Payout basis: the schedule\'s "updated by" and the history\'s actor render through actorLabel()',
    /actorLabel\(row\.updatedBy \|\| row\.createdBy\)/.test(basis) && /actorLabel\(h\.actor\)/.test(basis))
  const table = readClient('components/users/UserTable.vue')
  ok('§4 the Users table shows the three chips',
    /v-if="user\.SharedLogin"[^>]*>Shared login</.test(table) && /v-if="user\.MustChangePassword"[^>]*>Password not changed yet</.test(table) && /v-if="user\.EmailShared"[^>]*>Shared email</.test(table))
}

// ─────────────────────────────── §5 ChatBubble's side
console.log('§5 ChatBubble')
if (client && typeof client.isStaffMessage === 'function') {
  const side = client.isStaffMessage
  ok('§5 a named Super Admin\'s message in a driver\'s thread is sent', side('arvin_named', 'Dan Driver') === true)
  ok('§5 the driver\'s own message is not, in any case or spacing', side('Dan Driver', 'Dan Driver') === false && side(' dan  DRIVER ', 'Dan Driver') === false)
  ok('§5 the desk names are sent too', side('Dispatch', 'Dan Driver') === true && side('super_admin', 'Dan Driver') === true)
  ok('§5 in an investor\'s thread the investor\'s message is not', side('inv.one', 'inv.one') === false && side('admin', 'inv.one') === true)
  ok('§5 with no party, only the desk names count, as before', side('dispatch') && side('Admin') && side('super_admin') && !side('arvin_named') && !side('Dan Driver'))
  ok('§5 a message with no sender is never sent', side('', 'Dan Driver') === false && side(null) === false)
} else {
  ok('§5 client/src/utils/sharedLogin.js isStaffMessage() exists', false)
}
{
  const bubble = readClient('components/dashboard/ChatBubble.vue')
  ok('§5 ChatBubble takes a party and sides through isStaffMessage()',
    /party:\s*\{\s*type: String/.test(bubble) && /isStaffMessage\(props\.msg\.from, props\.party\)/.test(bubble))
  ok('§5 ...with no literal list of its own', !/from === 'dispatch'/.test(bubble))
  const panel = readClient('components/dashboard/MessagingPanel.vue')
  ok('§5 MessagingPanel hands it the thread\'s party', /<ChatBubble [^>]*:party="store\.selectedDriver"/.test(panel))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
