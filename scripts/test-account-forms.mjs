#!/usr/bin/env node
// Users › Add User and the sign-in page's hint (named Super Admin logins):
// client/src/lib/accountForms.js and the two screens that use it.
//
//   §1 newUserRequest(): a username and a password typed twice the same are
//      required (blank, one field, or two that differ: nothing is sent, and
//      the passwordFields.js hint says why); a Driver needs a driver name and
//      only a Driver sends one; text fields are trimmed, the password is not
//   §2 staffPasswordNote(): "Staff accounts change this password at first
//      sign-in." for a Super Admin or Dispatcher, and only while the server
//      says new staff accounts must change it
//   §3 addUserRefusal(): the server's message; PASSWORD_IS_YOURS empties the
//      password pair (it holds the signed-in admin's own password)
//   §4 signInTip(): "Tip: sign in with your username." after a 401 when the
//      typed name holds "@", and never otherwise
//   §5 the screens (source): Add User is a form of its own whose password pair
//      are new-password fields, whose other fields carry tokens a browser
//      does not autofill, that keeps what was typed until the server accepts
//      and shows a refusal in place; the store's create no longer reloads the
//      list itself; the sign-in page shows the tip and keeps its username and
//      current-password fields
//   §6 Add User, the Users page and the sign-in page compile (vue/compiler-sfc)
//
// Pure: no DOM, no server.
//   node scripts/test-account-forms.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const { parse, compileScript } = createRequire(path.join(ROOT, 'client', 'package.json'))('vue/compiler-sfc')
// Whether a component's script and template compile; the error text otherwise.
function compiles(rel) {
  try {
    const file = path.join(ROOT, 'client', 'src', rel)
    const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
    if (errors.length) return String(errors[0].message || errors[0])
    compileScript(descriptor, { id: path.basename(file), inlineTemplate: true })
    return ''
  } catch (err) {
    return err.message
  }
}

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

let forms = null
try { forms = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'accountForms.js')).href) } catch { forms = null }
ok('client/src/lib/accountForms.js exists', !!forms)

if (forms) {
  const { newUserRequest, staffPasswordNote, addUserRefusal, signInTip, STAFF_PASSWORD_NOTE, USERNAME_TIP } = forms
  const base = { username: '  owner_named ', password: 'Made-Up-Pass-7!', confirmPassword: 'Made-Up-Pass-7!', role: 'Super Admin', driverName: '', email: ' boss@example.test ', fullName: ' Owner Person ' }

  console.log('§1 newUserRequest()')
  {
    const r = newUserRequest(base)
    ok('§1 a full form sends the trimmed username, email and full name, and the password as typed',
      !!r.body && r.body.username === 'owner_named' && r.body.email === 'boss@example.test' && r.body.fullName === 'Owner Person' &&
      r.body.password === 'Made-Up-Pass-7!' && r.body.role === 'Super Admin' && r.body.driverName === '')
    ok('§1 ...and nothing else', !!r.body && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['driverName', 'email', 'fullName', 'password', 'role', 'username']))
    ok('§1 no username: refused', newUserRequest({ ...base, username: '   ' }).error === 'Username and password required.')
    ok('§1 no password at all: refused', newUserRequest({ ...base, password: '', confirmPassword: '' }).error === 'Username and password required.')
    ok('§1 one password field only (what autofill does): refused, asking for the second',
      newUserRequest({ ...base, confirmPassword: '' }).error === 'Type the new password again to confirm it.' && !newUserRequest({ ...base, confirmPassword: '' }).body)
    ok('§1 two that differ: refused', newUserRequest({ ...base, confirmPassword: 'Made-Up-Pass-8!' }).error === "The passwords don't match.")
    ok('§1 a Driver without a driver name: refused', newUserRequest({ ...base, role: 'Driver' }).error === 'Select a driver name for Driver role.')
    const d = newUserRequest({ ...base, role: 'Driver', driverName: 'Dan Driver' })
    ok('§1 a Driver sends its driver name', !!d.body && d.body.driverName === 'Dan Driver')
    ok('§1 any other role sends none, whatever the hidden select holds', newUserRequest({ ...base, role: 'Dispatcher', driverName: 'Dan Driver' }).body.driverName === '')
    ok('§1 no form at all: refused, not thrown', newUserRequest(null).error === 'Username and password required.')
  }

  console.log('§2 staffPasswordNote()')
  ok('§2 the note reads as the plan says', STAFF_PASSWORD_NOTE === 'Staff accounts change this password at first sign-in.')
  ok('§2 a Super Admin and a Dispatcher get it while the server requires the change',
    staffPasswordNote('Super Admin', true) === STAFF_PASSWORD_NOTE && staffPasswordNote('Dispatcher', true) === STAFF_PASSWORD_NOTE)
  ok('§2 a Driver and an Investor never', staffPasswordNote('Driver', true) === '' && staffPasswordNote('Investor', true) === '')
  ok('§2 nobody while the server does not require it (NAMED_LOGINS_ENABLED off)', staffPasswordNote('Super Admin', false) === '' && staffPasswordNote('Dispatcher', undefined) === '')

  console.log('§3 addUserRefusal()')
  {
    const own = addUserRefusal({ code: 'PASSWORD_IS_YOURS', message: 'This is your own password. Enter a new password for the new account.' })
    ok('§3 PASSWORD_IS_YOURS: the server\'s message, and the password pair emptied', own.clearPasswords === true && /your own password/.test(own.message))
    const weak = addUserRefusal({ code: 'PASSWORD_WEAK', message: 'Password must include a symbol (!@#$ etc.).' })
    ok('§3 PASSWORD_WEAK: the server\'s message, what was typed kept', weak.clearPasswords === false && /symbol/.test(weak.message))
    ok('§3 a refusal with no message still says something', addUserRefusal({}).message.length > 0 && addUserRefusal(null).clearPasswords === false)
  }

  console.log('§4 signInTip()')
  ok('§4 the tip reads as the plan says', USERNAME_TIP === 'Tip: sign in with your username.')
  ok('§4 a 401 for a name with "@": the tip', signInTip(401, 'boss@example.test') === USERNAME_TIP)
  ok('§4 a 401 for a username: none', signInTip(401, 'owner_named') === '')
  ok('§4 anything but a 401: none (a 429, a 500, no answer)', signInTip(429, 'boss@example.test') === '' && signInTip(500, 'boss@example.test') === '' && signInTip(0, 'boss@example.test') === '')
}

console.log('§5 the screens')
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, 'client', 'src', rel), 'utf8')
  const form = read('components/users/AddUserForm.vue')
  const tpl = form.slice(0, form.indexOf('<script'))
  const inputs = [...tpl.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0])
  const attr = (el, name) => { const m = el.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null }
  ok('§5 Add User is one form of its own that submits through handleSubmit', (tpl.match(/<form\b/g) || []).length === 1 && /<form [^>]*@submit\.prevent="handleSubmit"/.test(tpl))
  const passwords = inputs.filter((el) => attr(el, 'type') === 'password')
  ok('§5 ...with two password fields, both new-password', passwords.length === 2 && passwords.every((el) => attr(el, 'autocomplete') === 'new-password'))
  ok('§5 ...the second one the confirmation', passwords.some((el) => /v-model="form\.confirmPassword"/.test(el)))
  const AUTOFILL = new Set(['on', 'off', 'name', 'username', 'email', 'new-password', 'current-password', 'given-name', 'family-name', 'nickname', 'organization'])
  const others = inputs.filter((el) => attr(el, 'type') !== 'password')
  ok('§5 ...and its username, full name and email carry tokens a browser does not autofill',
    others.length === 3 && others.every((el) => { const t = attr(el, 'autocomplete'); return !!t && !AUTOFILL.has(t) }))
  const script = form.slice(form.indexOf('<script'))
  const awaitAt = script.indexOf('await props.createUser(')
  const clearAt = script.indexOf("form.username = ''")
  ok('§5 the form clears only after the server accepted the account', awaitAt > 0 && clearAt > awaitAt)
  ok('§5 a refusal is shown in the form, and PASSWORD_IS_YOURS empties the pair',
    /errorMsg\.value = refusal\.message/.test(script) && /if \(refusal\.clearPasswords\) clearPasswords\(\)/.test(script))
  ok('§5 the staff note comes from the server\'s setting', /staffPasswordNote\(form\.role, props\.staffMustChangePassword\)/.test(script))

  const view = read('views/UsersView.vue')
  ok('§5 UsersView hands the form its create and the server\'s setting',
    /:create-user="createUser"/.test(view) && /:staff-must-change-password="store\.newStaffMustChangePassword"/.test(view))
  const store = read('stores/users.js')
  const addUser = store.slice(store.indexOf('async addUser('), store.indexOf('async updateUser('))
  ok('§5 the store\'s create posts only; the list reload is the caller\'s', /api\.post\('\/api\/users'/.test(addUser) && !/loadUsers\(/.test(addUser))
  ok('§5 the store keeps newStaffMustChangePassword from GET /api/users', /this\.newStaffMustChangePassword = data\.newStaffMustChangePassword === true/.test(store))

  const login = read('views/LoginView.vue')
  ok('§5 the sign-in page shows the tip from signInTip() after a refusal',
    /loginTip\.value = signInTip\(err && err\.status, loginForm\.username\)/.test(login) && /<p v-if="loginTip"[^>]*>\{\{ loginTip \}\}<\/p>/.test(login))
  ok('§5 ...and keeps its username and current-password fields', /autocomplete="username"/.test(login) && /autocomplete="current-password"/.test(login))
}

console.log('§6 the components compile')
for (const rel of ['components/users/AddUserForm.vue', 'views/UsersView.vue', 'views/LoginView.vue']) {
  const err = compiles(rel)
  ok(`§6 ${rel} compiles${err ? ` (${err})` : ''}`, err === '')
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
