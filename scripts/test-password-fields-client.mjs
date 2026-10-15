#!/usr/bin/env node
// Users › Edit User's password fields (B21). A browser's saved-login autofill
// once put the signed-in admin's own password into another account's "New
// password" field, and Save reset that account to it.
//
//   §1 src/lib/passwordFields.js: both blank keeps the current password (no
//      password sent); one filled, or two that differ, cannot be saved; two
//      that match send that password; the hint under the pair
//   §2 the form, MOUNTED: both password fields are new-password fields that
//      open empty and hidden; Full Name and Email are autocomplete="off"; the
//      edited account's username sits read-only in an autocomplete="username"
//      field, so no saved login can be dropped into it; it is one <form>
//   §3 Save: enabled with both blank (and the update carries no password);
//      disabled while only one is filled (what autofill does) or the two
//      differ, with the hint; enabled once they match (and the update carries
//      that password); submitting with Enter while they differ sends nothing;
//      both fields are cleared when the dialog closes and on the next open
//   §4 the eye buttons: each shows and hides its own field, says which it
//      will do, and is a type="button" (it never submits)
//   §5 the Linked Driver help line, tied to its select
//   §6 the login page keeps autocomplete="username" / "current-password"
//
// No DOM, no server: the component is compiled from its .vue file and mounted
// on an in-memory renderer. Vue comes from client/node_modules; the component
// from LOGISX_ROOT (default: this checkout).
//   node scripts/test-password-fields-client.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-password-fields-client.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const CLIENT_DIR = path.join(HERE, 'client')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
// vModelText asks whether a mounted input has focus when the model changes
// under it (el.getRootNode(), then instanceof Document / ShadowRoot); there is
// no DOM here, so nothing ever has focus.
globalThis.document = globalThis.document || { activeElement: null }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

// Compile a committed SFC's <script setup> + <template> into a component.
// Imports come from `overrides` first; a .vue import becomes an empty stub; a
// relative .js import is loaded from ROOT.
async function compileComponent(rel, overrides = {}) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// An in-memory renderer: elements are plain objects holding their props and
// listeners, a Teleport to "body" lands in `body`, and v-model works through
// the listeners it registers.
function mountInMemory(Comp, props) {
  const node = (type, tag) => Vue.markRaw({
    type, tag, children: [], parent: null, props: {}, text: '', value: '', listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn) },
    getRootNode() { return {} },
    get options() { return this.children.filter((c) => c.tag === 'option') },
  })
  const ops = {
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child)
      child.parent = parent
    },
    remove(child) {
      const p = child.parent
      if (!p) return
      const i = p.children.indexOf(child)
      if (i >= 0) p.children.splice(i, 1)
      child.parent = null
    },
    createElement: (tag) => node('el', tag),
    createText: (t) => Object.assign(node('text'), { text: t }),
    createComment: (t) => Object.assign(node('comment'), { text: t }),
    setText(n, t) { n.text = t },
    setElementText(el, t) { el.children = []; if (t) ops.insert(Object.assign(node('text'), { text: t }), el) },
    parentNode: (n) => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; return p.children[p.children.indexOf(n) + 1] || null },
    querySelector: (sel) => (sel === 'body' ? body : null),
    setScopeId() {},
    patchProp(el, key, prev, next) {
      el.props[key] = next
      if (key === 'value') { el._value = next; el.value = next == null ? '' : next }
    },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  const body = node('el', 'body')
  const app = createApp(Comp, props)
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
  return {
    root, body,
    text: () => `${textOf(root)} ${textOf(body)}`.replace(/\s+/g, ' ').trim(),
    findAll: (pred) => [...all(root, pred), ...all(body, pred)],
    find: (pred) => [...all(root, pred), ...all(body, pred)][0] || null,
    textOf: (n) => textOf(n).replace(/\s+/g, ' ').trim(),
    unmount: () => app.unmount(),
  }
}
const evt = () => ({ preventDefault() {}, stopPropagation() {}, target: null })
// Type into a mounted input the way a person (or autofill) does: set its value
// and fire its input event, which reaches both the listener v-model registered
// and any @input handler the template put on the element.
async function type(el, value) {
  el.value = value
  for (const fn of el.listeners.input || []) fn({ target: el })
  if (typeof el.props.onInput === 'function') el.props.onInput({ target: el })
  await drain()
}
async function click(el) {
  if (typeof el.props.onClick === 'function') el.props.onClick(evt())
  await drain()
}

// ══ §1 the pair's rule ════════════════════════════════════════════════════════
const libPath = path.join(ROOT, 'client', 'src', 'lib', 'passwordFields.js')
let lib = null
try { lib = await import(pathToFileURL(libPath).href) } catch { lib = null }
ok('§1 src/lib/passwordFields.js exists', !!lib)
if (lib) {
  const { passwordChange, passwordChangeHint } = lib
  const blank = passwordChange('', '')
  ok('§1 both blank: can save, keeps the current password, sends none', blank.canSave && blank.keepCurrent && blank.password === null)
  ok('§1 undefined counts as blank', passwordChange(undefined, null).keepCurrent)
  const onlyNew = passwordChange('Owner-Pass-1!', '')
  ok('§1 only the new field filled (what autofill does): cannot save', !onlyNew.canSave && onlyNew.mismatch && onlyNew.password === null)
  ok('§1 only the confirm field filled: cannot save', !passwordChange('', 'Owner-Pass-1!').canSave)
  ok('§1 two that differ: cannot save', !passwordChange('Abc-1234!', 'Abc-1234?').canSave)
  ok('§1 two that differ only in case: cannot save', !passwordChange('Abc-1234!', 'abc-1234!').canSave)
  const same = passwordChange('Abc-1234!', 'Abc-1234!')
  ok('§1 two that match: can save, and that password is sent', same.canSave && !same.keepCurrent && same.password === 'Abc-1234!')
  ok('§1 hint: none while both blank or matching', passwordChangeHint('', '') === '' && passwordChangeHint('Abc-1234!', 'Abc-1234!') === '')
  ok('§1 hint: asks for the confirmation while it is empty', passwordChangeHint('Abc-1234!', '') === 'Type the new password again to confirm it.')
  ok('§1 hint: says they differ', passwordChangeHint('Abc-1234!', 'Abc') === "The passwords don't match.")
}

// ══ §2-§5 the form, mounted ═══════════════════════════════════════════════════
const iconStub = (name) => Vue.defineComponent({ name, render: () => Vue.h('svg', { 'data-icon': name }) })
const OVERRIDES = {
  '@/utils/datetime': { fmtAppDate: (v) => String(v), fmtTimestamp: (v) => String(v) },
  'lucide-vue-next': { Eye: iconStub('Eye'), EyeOff: iconStub('EyeOff') },
}
let UserTable = null
try { UserTable = await compileComponent('client/src/components/users/UserTable.vue', OVERRIDES) } catch (err) { ok(`§2 UserTable compiles in this harness (${err.message})`, false) }
if (UserTable) {
  // The page hands the table a saveUser(payload) that resolves once the server
  // accepted the edit (UsersView.vue). Each scenario decides how it answers.
  const updates = []
  let answer = () => Promise.resolve()
  const saveUser = (p) => { updates.push(p); return answer(p) }
  const USERS = [{ id: 7, Username: 'second.admin', Role: 'Super Admin', DriverName: '', Email: 'second@example.test', FullName: 'Second Admin' }]
  const m = mountInMemory(UserTable, { users: USERS, driverNames: ['Driver A'], saveUser })
  await drain()
  const edit = m.find((n) => n.tag === 'button' && n.props.class === 'btn-edit')
  ok('§2 setup: the Edit button renders', !!edit)
  if (edit) await click(edit)
  const byId = (id) => m.find((n) => n.tag === 'input' && n.props.id === id)
  const currentForm = () => m.find((n) => n.tag === 'form')
  const submit = async () => { const f = currentForm(); if (f) f.props.onSubmit(evt()); await drain() }
  const form = currentForm()
  const newPw = byId('edit-user-new-password')
  const confirmPw = byId('edit-user-confirm-password')
  const email = m.find((n) => n.tag === 'input' && n.props.type === 'email')
  const fullName = m.find((n) => n.tag === 'input' && n.props.placeholder === 'e.g. John Smith')
  const username = m.find((n) => n.tag === 'input' && n.props.autocomplete === 'username')
  const save = () => m.find((n) => n.tag === 'button' && m.textOf(n) === 'Save')
  const toggles = () => m.findAll((n) => n.tag === 'button' && /^(Show|Hide) password$/.test(String(n.props['aria-label'] || '')))
  const hint = () => { const p = m.find((n) => n.tag === 'p' && n.props.id === 'edit-user-password-hint'); return p ? m.textOf(p) : null }

  // §2 the fields
  ok('§2 the dialog is one <form> that submits through the guarded save', !!form && typeof form.props.onSubmit === 'function' && form.props.autocomplete === 'off')
  ok('§2 "New password" is a new-password field', !!newPw && newPw.props.autocomplete === 'new-password')
  ok('§2 "Confirm new password" exists and is a new-password field', !!confirmPw && confirmPw.props.autocomplete === 'new-password')
  ok('§2 both open empty and hidden', !!newPw && !!confirmPw && newPw.value === '' && confirmPw.value === '' && newPw.props.type === 'password' && confirmPw.props.type === 'password')
  ok('§2 Full Name does not take autofill', !!fullName && fullName.props.autocomplete === 'off')
  ok('§2 Email does not take autofill', !!email && email.props.autocomplete === 'off')
  ok('§2 the edited account\'s username is a read-only autocomplete="username" field (no saved login can be dropped in)',
    !!username && username.props.readonly !== undefined && username.props.readonly !== false && username.props.value === 'second.admin' && username.props.tabindex === '-1')
  ok('§2 no existing password is ever put in a field', !m.findAll((n) => n.tag === 'input' && /password/.test(String(n.props.autocomplete))).some((n) => n.value))

  if (newPw && confirmPw && save()) {
    // §3 Save
    ok('§3 both blank: Save is enabled, and it is the form\'s submit button', !save().props.disabled && save().props.type === 'submit')
    await submit()
    ok('§3 both blank: the update carries no password (the current one is kept)', updates.length === 1 && !('password' in updates[0].data) && updates[0].id === 7)
    if (edit) await click(edit)
    const n2 = byId('edit-user-new-password')
    const c2 = byId('edit-user-confirm-password')
    await type(n2, 'Owner-Pass-1!')
    ok('§3 only "New password" filled (what autofill does): Save is disabled', save().props.disabled === true)
    ok('§3 ...and the form asks for the confirmation', hint() === 'Type the new password again to confirm it.')
    const before = updates.length
    await submit()
    ok('§3 ...and submitting anyway (Enter) sends nothing', updates.length === before)
    await type(c2, 'Owner-Pass-1?')
    ok('§3 two that differ: Save is disabled, and the form says so', save().props.disabled === true && hint() === "The passwords don't match.")
    ok('§3 ...and the confirm field is marked invalid', c2.props['aria-invalid'] === true)
    await type(c2, 'Owner-Pass-1!')
    ok('§3 two that match: Save is enabled, no hint', !save().props.disabled && hint() === '')
    await submit()
    ok('§3 ...and the update carries that password', updates.length === before + 1 && updates[updates.length - 1].data.password === 'Owner-Pass-1!')
    ok('§3 ...and the dialog closes', !byId('edit-user-new-password'))
    if (edit) await click(edit)
    ok('§3 the next open starts empty again', byId('edit-user-new-password').value === '' && byId('edit-user-confirm-password').value === '')
    await type(byId('edit-user-new-password'), 'Typed-Then-Cancelled-1!')
    const cancel = m.find((n) => n.tag === 'button' && m.textOf(n) === 'Cancel')
    ok('§3 Cancel is a type="button"', !!cancel && cancel.props.type === 'button')
    if (cancel) await click(cancel)
    if (edit) await click(edit)
    ok('§3 a cancelled password is gone on the next open', byId('edit-user-new-password').value === '' && !save().props.disabled)

    // §3b the dialog waits for the server: it closes only on success, and a
    // refusal is shown inline, under the password fields, with what was typed
    // kept (so the admin fixes it instead of reopening and retyping).
    const saveError = () => { const p = m.find((n) => n.tag === 'p' && n.props.id === 'edit-user-save-error'); return p ? m.textOf(p) : '' }
    const refuse = (status, code, message) => () => Promise.reject(Object.assign(new Error(message), { status, code, data: { code, error: message } }))
    const fill = async (pw) => {
      if (!byId('edit-user-new-password') && edit) await click(edit)
      await type(byId('edit-user-new-password'), pw)
      await type(byId('edit-user-confirm-password'), pw)
    }
    const valueOf = (id) => (byId(id) ? byId(id).value : null)
    let release = null
    answer = () => new Promise((resolve, reject) => { release = { resolve, reject } })
    await fill('Pending-Pass-1!')
    const sentBefore = updates.length
    await submit()
    ok('§3b while the save is in flight: the dialog stays open', !!byId('edit-user-new-password') && updates.length === sentBefore + 1)
    const busy = m.find((n) => n.tag === 'button' && n.props.type === 'submit')
    ok('§3b ...and its submit button is disabled and says so', !!busy && busy.props.disabled === true && m.textOf(busy) === 'Saving...')
    await submit()
    ok('§3b ...and a second submit sends nothing more', updates.length === sentBefore + 1)
    if (release) release.reject(Object.assign(new Error('Password must include an uppercase letter.'), { status: 400, code: 'PASSWORD_WEAK' }))
    await drain()
    ok('§3b a 400 PASSWORD_WEAK: the dialog stays open', !!byId('edit-user-new-password'))
    ok(`§3b ...the server's message is shown inline (${saveError()})`, saveError() === 'Password must include an uppercase letter.')
    const errAt = m.findAll((n) => n.tag === 'p').map((n) => n.props.id)
    ok('§3b ...under the password fields, before the buttons', errAt.indexOf('edit-user-password-hint') >= 0 && errAt.indexOf('edit-user-save-error') > errAt.indexOf('edit-user-password-hint'))
    const errP = m.find((n) => n.tag === 'p' && n.props.id === 'edit-user-save-error')
    ok('§3b ...announced as an alert', !!errP && errP.props.role === 'alert')
    ok('§3b ...what was typed is kept, and Save works again', valueOf('edit-user-new-password') === 'Pending-Pass-1!' && valueOf('edit-user-confirm-password') === 'Pending-Pass-1!' && !!save() && !save().props.disabled)
    answer = refuse(400, 'PASSWORD_IS_YOURS', 'This is your own password. Enter a new password for this user.')
    await submit()
    ok('§3b a 400 PASSWORD_IS_YOURS: the dialog stays open with that message', !!byId('edit-user-new-password') && saveError() === 'This is your own password. Enter a new password for this user.')
    ok('§3b ...and both password fields are emptied (they held the admin\'s own password)', valueOf('edit-user-new-password') === '' && valueOf('edit-user-confirm-password') === '')
    answer = refuse(409, 'CONCURRENT_MODIFICATION', 'This account was modified by another request while this one was in progress.')
    await submit()
    ok('§3b any other refusal also stays open and shows the server\'s message', !!byId('edit-user-new-password') && saveError().startsWith('This account was modified'))
    answer = () => Promise.reject(new Error(''))
    await submit()
    ok('§3b a failure with no message says the user was not saved', !!byId('edit-user-new-password') && saveError() === 'This user could not be saved. Try again.')
    answer = () => Promise.resolve()
    await fill('Accepted-Pass-1!')
    await submit()
    const last = updates[updates.length - 1]
    ok('§3b a success closes the dialog', !byId('edit-user-new-password') && !!last && last.data.password === 'Accepted-Pass-1!')
    if (edit) await click(edit)
    ok('§3b the next open shows no old error', saveError() === '')

    // A refusal's message goes as soon as either password field changes: it
    // speaks about what was typed, and stops being true once that changes.
    for (const [field, value] of [['edit-user-new-password', 'Retyped-1!'], ['edit-user-confirm-password', 'Retyped-1!'], ['edit-user-new-password', '']]) {
      answer = refuse(400, 'PASSWORD_WEAK', 'New password must be at least 8 characters')
      await fill('Short-1!')
      await submit()
      const shown = saveError()
      await type(byId(field), value)
      ok(`§3b after a refusal, changing ${field === 'edit-user-new-password' ? '"New password"' : '"Confirm new password"'}${value ? '' : ' to blank'} clears the server's message (${shown} -> ${saveError() || 'none'})`,
        shown === 'New password must be at least 8 characters' && saveError() === '' && !!byId('edit-user-new-password'))
    }
    answer = refuse(400, 'PASSWORD_WEAK', 'New password must be at least 8 characters')
    await fill('Short-1!')
    await submit()
    await type(byId('edit-user-new-password'), '')
    await type(byId('edit-user-confirm-password'), '')
    ok('§3b clearing both password fields after a refusal leaves no message, and Save keeps the current password', saveError() === '' && !save().props.disabled)
    await type(m.find((n) => n.tag === 'input' && n.props.placeholder === 'e.g. John Smith'), 'Second Admin B')
    answer = refuse(409, 'PERIOD_FINALIZED', 'That month is closed.')
    await submit()
    await type(m.find((n) => n.tag === 'input' && n.props.placeholder === 'e.g. John Smith'), 'Second Admin C')
    ok('§3b ...while editing another field leaves a refusal\'s message in place', saveError() === 'That month is closed.')
    answer = refuse(400, 'PASSWORD_IS_YOURS', 'This is your own password. Enter a new password for this user.')
    await fill('Own-Pass-1!')
    await submit()
    ok('§3b PASSWORD_IS_YOURS keeps its message although it empties the fields itself', saveError() === 'This is your own password. Enter a new password for this user.')
    answer = () => Promise.resolve()

    // §4 the eye buttons
    const t = toggles()
    ok(`§4 one eye button per password field (${t.length})`, t.length === 2)
    ok('§4 each is a type="button" that names the field it controls',
      t.length === 2 && t.every((b) => b.props.type === 'button') &&
      t[0].props['aria-controls'] === 'edit-user-new-password' && t[1].props['aria-controls'] === 'edit-user-confirm-password')
    ok('§4 each starts as "Show password", not pressed', t.length === 2 && t.every((b) => b.props['aria-label'] === 'Show password' && b.props['aria-pressed'] === false))
    if (t.length === 2) {
      await click(t[0])
      const after = toggles()
      ok('§4 the first shows "New password" only', byId('edit-user-new-password').props.type === 'text' && byId('edit-user-confirm-password').props.type === 'password')
      ok('§4 ...and now says "Hide password", pressed', after[0].props['aria-label'] === 'Hide password' && after[0].props['aria-pressed'] === true)
      await click(after[1])
      ok('§4 the second shows "Confirm new password"', byId('edit-user-confirm-password').props.type === 'text')
      await click(toggles()[0])
      ok('§4 clicking again hides it', byId('edit-user-new-password').props.type === 'password')
      const closer = m.find((n) => n.tag === 'button' && m.textOf(n) === 'Cancel')
      if (closer) await click(closer)
      if (edit) await click(edit)
      ok('§4 the next open starts hidden', byId('edit-user-new-password').props.type === 'password' && byId('edit-user-confirm-password').props.type === 'password')
    }
  }

  // §5 Linked Driver help
  const help = m.find((n) => n.tag === 'p' && n.props.id === 'edit-user-driver-help')
  const driverSelect = m.find((n) => n.tag === 'select' && n.props.id === 'edit-user-driver')
  ok('§5 the Linked Driver help line', !!help && m.textOf(help) === "Connects this login to a driver profile, so the user sees that driver's loads and pay.")
  ok('§5 ...tied to its select', !!driverSelect && driverSelect.props['aria-describedby'] === 'edit-user-driver-help')
  ok('§5 the Linked Driver field shows for a Super Admin account too (it stays for every role)', !!driverSelect && USERS[0].Role === 'Super Admin' && m.text().includes('Linked Driver'))
  m.unmount()
}

// ══ §3c the page's side of the wait ══════════════════════════════════════════
{
  const view = fs.readFileSync(path.join(ROOT, 'client', 'src', 'views', 'UsersView.vue'), 'utf8')
  const store = fs.readFileSync(path.join(ROOT, 'client', 'src', 'stores', 'users.js'), 'utf8')
  const fnAt = view.indexOf('async function saveUser({ id, data }) {')
  const fn = fnAt >= 0 ? view.slice(fnAt, view.indexOf('\n}\n', fnAt)) : ''
  ok('§3c UsersView hands the table its save as saveUser', /<UserTable\b[^>]*:save-user="saveUser"/.test(view) && !/@update="/.test(view))
  ok('§3c ...which awaits the save and lets a refusal reach the dialog (no catch around it)', fn.includes('await store.updateUser(id, data)') && !/\bcatch\s*\(/.test(fn.slice(0, fn.indexOf('toast('))))
  ok('§3c ...and reloads the list after a success without turning a failed reload into a failed save',
    /store\.loadUsers\(\)\.catch\(/.test(fn) && !/await store\.loadUsers\(\)/.test(fn))
  const upd = store.slice(store.indexOf('async updateUser(id, data) {'), store.indexOf('},', store.indexOf('async updateUser(id, data) {')))
  ok('§3c the store\'s updateUser is the save alone', upd.includes('await api.put(`/api/users/${id}`, data)') && !upd.includes('loadUsers'))
}

// ══ §6 the login page's autofill hints ═══════════════════════════════════════
const login = fs.readFileSync(path.join(ROOT, 'client', 'src', 'views', 'LoginView.vue'), 'utf8')
const loginForm = login.slice(login.indexOf('<!-- LOGIN FORM -->'), login.indexOf('</form>', login.indexOf('<!-- LOGIN FORM -->')))
ok('§6 login: the username field is autocomplete="username"', /v-model="loginForm\.username"[^>]*autocomplete="username"/.test(loginForm))
ok('§6 login: the password field is autocomplete="current-password"', /v-model="loginForm\.password"[^>]*autocomplete="current-password"/.test(loginForm))

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
