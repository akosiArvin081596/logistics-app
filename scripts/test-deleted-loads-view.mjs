#!/usr/bin/env node
// The Super Admin "Deleted loads" page (list only) and its "Deleted loads (N)"
// link on Active Loads: display only. GET /api/admin/deleted-loads sends every
// figure; its role gate is the real control (scripts/test-deleted-loads-route.js).
//
//   §1 client/src/lib/deletedLoadsView.js: who may see the link and page, the
//      link text (N, or no number while unknown), the route line, the month lines
//      with closed Yes/No, the "from the delete record" note, the error line.
//   §2 the link by role, rendered: a Super Admin gets "Deleted loads" pointing at
//      the page and asks the route for N; a Dispatcher, Driver or Investor gets
//      nothing and asks nothing.
//   §3 wiring, from source: the page's route is Super Admin only, Active Loads
//      shows the link only to a Super Admin, the page reads the route, and its
//      only write is the restore POST from its confirm.
//
// RESTORE (DELETED_LOAD_RESTORE_ENABLED; the server decides, these only show):
//   §4 the lib's restore, choice and banner helpers, and withDeletedLoadChoice().
//   §5 the page, mounted: every role but Super Admin gets nothing rendered and
//      asks nothing; a Super Admin without the server's restore switch gets the
//      list as before; with it, a Restore button on each row and card, an in-app
//      confirm naming the load and each month, one POST at a time, the server's
//      words on a refusal, a toast and a fresh list on success.
//   §6 the create choice (DeletedLoadChoiceModal.vue), mounted: who deleted it and
//      when, both choices with the reason one is off, Restore through the route,
//      Create it as new handed back to the form (or, from the banner, through the
//      route), one press at a time, the server's words on a refusal. Restore and
//      Create it as new stay off until a reason of 3+ characters is typed, here
//      and in §5's confirm, and the reason goes with the request (the 10-22
//      Restore decision).
//   §7 the dashboard banner (HiddenLoadsBanner.vue), mounted, and the dashboard
//      (DashboardView.vue) mounted for a Super Admin and a Dispatcher.
//   §8 wiring, from source: the rate-con modal, New Job and the Data Manager ask
//      through withDeletedLoadChoice() and render the choice for a Super Admin
//      only; the notice opens the dashboard; the notice type matches the server's.
//
// Made-up values only. No DOM, no server. Vue comes from this checkout's
// client/node_modules; the files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-deleted-loads-view.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const read = (...p) => (exists(...p) ? fs.readFileSync(path.join(ROOT, ...p), 'utf8') : '')
const CLIENT_DIR = path.join(HERE, 'client')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(`${name}${g === w ? '' : `  (got ${g}, want ${w})`}`, g === w)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')

// Rendered HTML to its visible text: comments dropped, tags as spaces, the two
// entities the renderer emits here decoded, whitespace collapsed. A scan, not a
// regex replace (the same walk as scripts/test-fix-age-tracking.mjs).
function text(html) {
  const s = String(html)
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { out += s.slice(i); break }
    out += s.slice(i, lt)
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end === -1 ? s.length : end + 3
    } else {
      const end = s.indexOf('>', lt + 1)
      out += ' '
      i = end === -1 ? s.length : end + 1
    }
  }
  return out.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

// Compile a committed SFC's <script setup> + <template> into a component.
// Imports resolve from `overrides` first; a relative .js import loads from ROOT.
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
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// ------------------------------------------------------------------ §1 lib
let lib = null
try {
  lib = exists('client', 'src', 'lib', 'deletedLoadsView.js')
    ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'deletedLoadsView.js')).href)
    : null
} catch { lib = null }
ok('§1 client/src/lib/deletedLoadsView.js exists and loads', !!lib)

if (lib) {
  eq('§1 only a Super Admin may see the link and page',
    ['Super Admin', 'Dispatcher', 'Driver', 'Investor', '', undefined, 'super admin'].map(lib.canSeeDeletedLoads),
    [true, false, false, false, false, false, false])
  eq('§1 the link names N, including 0', [3, 0].map(lib.deletedLoadsLinkText), ['Deleted loads (3)', 'Deleted loads (0)'])
  eq('§1 no number while N is unknown or not a count', [null, undefined, -1, 2.5, '3'].map(lib.deletedLoadsLinkText),
    ['Deleted loads', 'Deleted loads', 'Deleted loads', 'Deleted loads', 'Deleted loads'])
  eq('§1 the route line, one side missing, none known', [
    { pickup: 'Springfield, IL 62701', dropoff: 'Riverton, WY 82501' },
    { pickup: 'Springfield, IL 62701', dropoff: '' },
    { pickup: '', dropoff: '' },
    null,
  ].map(lib.deletedLoadRoute), ['Springfield, IL 62701 → Riverton, WY 82501', 'Springfield, IL 62701 → —', '—', '—'])
  eq('§1 one line per month, closed as the server says', lib.deletedLoadMonths({ months: [{ month: '2026-05', closed: true }, { month: '2026-06', closed: false }] }), [
    { key: '2026-05', label: 'May 2026', closed: true, closedText: 'Yes' },
    { key: '2026-06', label: 'June 2026', closed: false, closedText: 'No' },
  ])
  eq('§1 a closed flag that is not exactly true reads No', lib.deletedLoadMonths({ months: [{ month: '2026-05', closed: 'true' }] }).map((m) => m.closedText), ['No'])
  eq('§1 no months, no lines', [lib.deletedLoadMonths({ months: [] }), lib.deletedLoadMonths({})], [[], []])
  eq('§1 the note says when months come from the delete record', ['audit', 'sheet', 'none'].map((f) => lib.deletedLoadMonthsNote({ monthsFrom: f })),
    ['From the delete record', '', ''])
  const sheetErr = Object.assign(new Error('Job Tracking could not be read (made-up).'), { status: 503, code: 'SHEET_UNREADABLE' })
  const lockErr = Object.assign(new Error('The month-end lock table could not be read (made-up).'), { status: 503, code: 'PERIOD_LOCK_UNREADABLE' })
  eq('§1 the error line: the server\'s words for an unreadable sheet or lock table, else a fallback', [
    lib.deletedLoadsErrorText(sheetErr),
    lib.deletedLoadsErrorText(lockErr),
    lib.deletedLoadsErrorText(Object.assign(new Error('Forbidden'), { status: 403 })),
    lib.deletedLoadsErrorText(Object.assign(new Error('boom'), { status: 500 })),
  ], [
    'Job Tracking could not be read (made-up).',
    'The month-end lock table could not be read (made-up).',
    'Only a Super Admin can see deleted loads.',
    'The deleted loads could not be loaded. Try again in a moment.',
  ])
}

// ------------------------------------------------------------- §2 the link
const LINK = 'client/src/components/dashboard/DeletedLoadsLink.vue'
const RouterLinkStub = Vue.defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], default: null } },
  setup(props, { slots }) {
    return () => Vue.h('a', { 'data-to': JSON.stringify(props.to) }, slots.default ? slots.default() : [])
  },
})
async function renderLink(role) {
  const calls = []
  const Comp = await compileComponent(LINK, {
    '../../composables/useApi': { useApi: () => ({ get: async (url) => { calls.push(url); return { loads: [], count: 3 } } }) },
    '../../composables/useSocketRefresh': { useSocketRefresh: () => {} },
    '../../stores/auth': { useAuthStore: () => ({ user: role ? { role } : null, isSuperAdmin: role === 'Super Admin' }) },
  })
  const app = Vue.createSSRApp(Comp)
  app.component('RouterLink', RouterLinkStub)
  const html = await renderToString(app)
  await new Promise((r) => setImmediate(r))
  return { html, txt: text(html), calls }
}
let linkOk = false
try { linkOk = !!(await compileComponent(LINK, {
  '../../composables/useApi': { useApi: () => ({}) },
  '../../composables/useSocketRefresh': { useSocketRefresh: () => {} },
  '../../stores/auth': { useAuthStore: () => ({ user: null }) },
})) } catch { linkOk = false }
ok(`§2 ${LINK} exists and compiles`, linkOk)
if (linkOk) {
  const sa = await renderLink('Super Admin')
  ok('§2 Super Admin: the link renders, reading "Deleted loads" until N arrives', sa.txt === 'Deleted loads')
  ok('§2 Super Admin: the link points at the Deleted loads page', /data-to="[^"]*&quot;admin-deleted-loads&quot;/.test(sa.html))
  eq('§2 Super Admin: N is asked of the route', sa.calls, ['/api/admin/deleted-loads'])
  for (const role of ['Dispatcher', 'Driver', 'Investor', 'KPI Viewer', 'Admin', 'Night Auditor', 'super admin', null]) {
    const r = await renderLink(role)
    ok(`§2 ${role || 'no user'}: no link rendered`, r.txt === '' && !/<a\b/.test(r.html))
    eq(`§2 ${role || 'no user'}: the route is never asked`, r.calls, [])
  }
}

// ------------------------------------------------------------ §3 wiring
const ROUTER = read('client', 'src', 'router', 'index.js')
const routeBlock = (ROUTER.match(/\{\s*(?:\/\/[^\n]*\n\s*)*path: '\/admin\/deleted-loads',[\s\S]*?\n {2}\}/) || [''])[0]
ok('§3 the page has a route, /admin/deleted-loads, named admin-deleted-loads', /name: 'admin-deleted-loads'/.test(routeBlock) && /DeletedLoadsView\.vue/.test(routeBlock))
ok('§3 the page\'s route is Super Admin only', /meta: \{ roles: \['Super Admin'\] \}/.test(routeBlock))

const ACTIVE = read('client', 'src', 'components', 'dashboard', 'ActiveLoadsTab.vue')
const linkTags = ACTIVE.match(/<DeletedLoadsLink\b[^>]*>/g) || []
eq('§3 Active Loads shows the link once, only to a Super Admin', linkTags, ['<DeletedLoadsLink v-if="auth.isSuperAdmin" />'])

const LINK_SRC = read(...LINK.split('/'))
ok('§3 the link renders only when canSeeDeletedLoads() says so, and asks nothing otherwise',
  /<router-link v-if="visible"/.test(LINK_SRC) && /const visible = computed\(\(\) => canSeeDeletedLoads\(auth\.user\?\.role\)\)/.test(LINK_SRC) && /if \(!visible\.value\) return/.test(LINK_SRC))

const VIEW = read('client', 'src', 'views', 'DeletedLoadsView.vue')
ok('§3 the page reads GET /api/admin/deleted-loads', /api\.get\('\/api\/admin\/deleted-loads'\)/.test(VIEW))
ok('§3 the page shows every column: Load ID, Route, Driver, Date deleted, Deleted by, Month, Closed',
  ['Load ID', 'Route', 'Driver', 'Date deleted', 'Deleted by', 'Month', 'Closed'].every((h) => VIEW.includes(`<TableHead>${h}</TableHead>`)))
ok('§3 the link sends nothing but a GET; the page a GET, and one POST, to the restore route, from its confirm, with the reason',
  !/api\.(post|put|patch|del)\(/.test(LINK_SRC) && !/api\.(put|patch|del)\(/.test(VIEW) && !/fetch\(/.test(VIEW + LINK_SRC)
  && (VIEW.match(/api\.post\(/g) || []).length === 1 && VIEW.includes('await api.post(restoreUrl(l.id), { reason: reason.value.trim() })'))
ok('§3 the page has a phone layout (cards below md)', /v-else-if="isMobile"/.test(VIEW) && /useViewport\(\)/.test(VIEW))
// Review L1 (#568): two deletes of one load in the same second share load ID,
// time and row index; only the deleted_loads id the route sends tells them apart.
const rowLoops = VIEW.match(/v-for="l in loads" :key="[^"]*"/g) || []
eq('§3 the table rows and the phone cards are keyed on the deleted_loads id', rowLoops,
  ['v-for="l in loads" :key="l.id"', 'v-for="l in loads" :key="l.id"'])

// =================================================================== RESTORE
const ROLES_NOT_SA = ['Dispatcher', 'Driver', 'Investor', 'KPI Viewer', 'Admin', 'Night Auditor', 'super admin', null]
const has = (name) => !!lib && typeof lib[name] === 'function'

// ------------------------------------------------------------------ §4 lib
ok('§4 the lib has its restore, choice and banner helpers',
  ['canRestoreDeletedLoads', 'restoreIsOn', 'restoreUrl', 'restoreConfirm', 'restoreErrorText', 'restoreDoneText', 'deletedLoadChoiceOf',
    'deletedLoadChoiceView', 'withDeletedLoadChoice', 'hiddenLoadsOf', 'hiddenLoadText', 'hiddenLoadChoice', 'hiddenEvidenceText', 'restoreReasonReady'].every(has))
if (has('withDeletedLoadChoice')) {
  eq('§4 only a Super Admin may restore', ['Super Admin', ...ROLES_NOT_SA, undefined].map(lib.canRestoreDeletedLoads), [true, false, false, false, false, false, false, false, false, false])
  eq('§4 Restore shows only when the server says so', [{ restore: { enabled: true } }, { restore: { enabled: 'true' } }, { restore: {} }, {}, null].map(lib.restoreIsOn), [true, false, false, false, false])
  eq('§4 the restore URL names the delete record', [lib.restoreUrl(12), lib.restoreUrl('7')], ['/api/admin/deleted-loads/12/restore', '/api/admin/deleted-loads/7/restore'])
  const LOAD = { id: 3, loadId: 'lx-1002', deletedBy: 'admin_two', months: [{ month: '2026-10', closed: false }, { month: '2026-05', closed: true }], monthsFrom: 'sheet' }
  eq('§4 the confirm names the load, who deleted it and when, and each month with open or closed',
    lib.restoreConfirm(LOAD, 'Oct 20, 2026'),
    { title: 'Restore load lx-1002?', message: "Deleted Oct 20, 2026 by admin_two.\nOctober 2026: open\nMay 2026: closed\nRestoring puts it back on the dashboard and in its month's figures." })
  eq('§4 ...a month from the delete record says so; no month says so',
    [lib.restoreConfirm({ loadId: 'lx-1003', months: [{ month: '2026-05', closed: true }], monthsFrom: 'audit' }, 'Oct 5, 2026').message,
      lib.restoreConfirm({ loadId: 'lx-1004', months: [] }, 'Oct 21, 2026').message],
    ["Deleted Oct 5, 2026.\nMay 2026: closed (from the delete record)\nRestoring puts it back on the dashboard and in its month's figures.",
      "Deleted Oct 21, 2026.\nMonth: not known\nRestoring puts it back on the dashboard and in its month's figures."])
  const refused = (code, status, message) => Object.assign(new Error(message), { code, status })
  eq('§4 a refusal reads as the server words it; anything else as a plain fallback', [
    lib.restoreErrorText(refused('PERIOD_FINALIZED', 409, 'Load lx-1001 is in a closed month (May 2026). (made-up)')),
    lib.restoreErrorText(refused('NO_SHEET_ROW', 409, 'Load lx-1003 has no row (made-up).')),
    lib.restoreErrorText(refused('NOT_DELETED', 404, "This load isn't deleted any more (made-up).")),
    lib.restoreErrorText(refused('', 403, 'Forbidden')),
    lib.restoreErrorText(refused('TIMEOUT', 0, 'timeout')),
    lib.restoreErrorText(refused('', 500, 'boom')),
  ], [
    'Load lx-1001 is in a closed month (May 2026). (made-up)',
    'Load lx-1003 has no row (made-up).',
    "This load isn't deleted any more (made-up).",
    'Only a Super Admin can restore a deleted load.',
    'No answer from the server. Reload the list to see whether the load was restored.',
    'The load could not be restored. Try again in a moment.',
  ])
  eq('§4 the reason\'s own refusals, and a create as new refused for a row that may be the delete\'s own, read as the server words them', [
    lib.restoreErrorText(refused('RESTORE_REASON_REQUIRED', 400, 'A reason of 3 to 500 characters is required (made-up).')),
    lib.restoreErrorText(refused('CONTACT_NOT_ALLOWED', 400, "The reason can't hold an email address or a phone number (made-up).")),
    lib.restoreErrorText(refused('DELETED_ROWS_PRESENT', 409, 'Row 2 may be load lx-1002\'s row from before its delete (made-up).')),
  ], ['A reason of 3 to 500 characters is required (made-up).', "The reason can't hold an email address or a phone number (made-up).", 'Row 2 may be load lx-1002\'s row from before its delete (made-up).'])
  eq('§4 a reason is ready at 3 to 500 characters once trimmed (the 10-22 Restore decision)',
    has('restoreReasonReady') ? ['', '  ', 'ok', '  ok  ', 'abc', '  Re-booked by the broker  ', 'x'.repeat(500), 'x'.repeat(501), null, undefined, 42].map(lib.restoreReasonReady) : null,
    [false, false, false, false, true, true, true, false, false, false, false])
  eq('§4 ...its limits are the server\'s', [lib.RESTORE_REASON_MIN, lib.RESTORE_REASON_MAX], [3, 500])
  eq('§4 done: restored, cleared, or one delete of two undone', [
    lib.restoreDoneText({ mode: 'restore', restored: { loadId: 'lx-1002' }, remaining: 0 }),
    lib.restoreDoneText({ mode: 'create_new', restored: { loadId: 'lx-1002' }, remaining: 0 }),
    lib.restoreDoneText({ mode: 'restore', restored: { loadId: 'lx-1002' }, remaining: 1 }),
  ], [
    'Load lx-1002 is restored.',
    "Load lx-1002's old delete is cleared; its row counts as a new load.",
    'This delete of load lx-1002 is undone, but another delete of the same load still hides it. Restore that one too.',
  ])
  const CHOICE = { code: 'LOAD_ID_DELETED', loadId: '7101', tombstoneId: 9, deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: null, canRestore: false, canCreateNew: true, deleteCount: 1 }
  const asErr = (data, status = 409) => Object.assign(new Error(data.error || 'refused'), { status, code: data.code || '', data })
  eq('§4 only a Super Admin\'s 409 carries a choice', [
    !!lib.deletedLoadChoiceOf(asErr(CHOICE)),
    lib.deletedLoadChoiceOf(asErr({ code: 'LOAD_ID_DELETED', error: 'Ask a Super Admin (made-up).' })),
    lib.deletedLoadChoiceOf(asErr({ code: 'DUPLICATE_LOAD' })),
    lib.deletedLoadChoiceOf(null),
  ], [true, null, null, null])
  const view = (c, review) => lib.deletedLoadChoiceView(c, 'Oct 1, 2026', { review })
  eq('§4 the choice with no row: who and when; Restore off with its reason; Create it as new on', view(CHOICE), {
    title: 'Load 7101 was deleted',
    message: 'Deleted Oct 1, 2026 by admin_two. Choose what to do with this Load ID.',
    why: '',
    restoreOff: true,
    restoreNote: "Its Job Tracking row is gone, so there's nothing to restore.",
    monthLines: [],
    createOff: false,
    createNote: 'Clears the old delete and creates this load.',
  })
  const ROW = { ...CHOICE, loadId: '7003', sheetRow: 4, canRestore: true, canCreateNew: false, months: [{ month: '2026-10', closed: false }], monthsFrom: 'audit' }
  eq('§4 ...with a row: Restore on (that row, its month from the delete record), Create it as new off with its reason',
    [view(ROW).restoreOff, view(ROW).restoreNote, view(ROW).monthLines, view(ROW).createOff, view(ROW).createNote],
    [false, 'Brings the deleted load back (row 4) and creates nothing new.', ['October 2026: open (from the delete record)'], true, 'Row 4 still holds this load: restore it instead, or remove that row first.'])
  eq('§4 ...a month no one could name says so', view({ ...ROW, months: [], monthsFrom: 'none' }).monthLines, ['Month: not known'])
  eq('§4 ...deleted twice with no row: Create it as new on, clearing both (M5)', [view({ ...CHOICE, deleteCount: 2 }).createOff, view({ ...CHOICE, deleteCount: 2 }).createNote],
    [false, 'Clears all 2 old deletes of this Load ID and creates this load.'])
  const HIDDEN = { tombstoneId: 4, loadId: 'LX-5101', deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 4, rows: [4], newRows: [4], ownRows: [],
    canRestore: true, canCreateNew: true, months: [{ month: '2026-10', closed: false }], evidence: ['deleted_with_no_row', 'created_by_n8n'] }
  eq('§4 the banner line names the row', [lib.hiddenLoadText(HIDDEN, 'Oct 1, 2026'), lib.hiddenLoadText({ ...HIDDEN, sheetRow: null }, 'Oct 1, 2026')],
    ['Load LX-5101, row 4, is hidden by an earlier delete (deleted by admin_two on Oct 1, 2026).', 'Load LX-5101 is hidden by an earlier delete (deleted by admin_two on Oct 1, 2026).'])
  eq('§4 its choice: what the server sent, nothing assumed (M3)', [lib.hiddenLoadChoice(HIDDEN), lib.hiddenLoadChoice({ ...HIDDEN, canCreateNew: false, canRestore: 'yes' })], [
    { loadId: 'LX-5101', tombstoneId: 4, deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 4, canRestore: true, canCreateNew: true, rows: [4], newRows: [4], ownRows: [],
      months: [{ month: '2026-10', closed: false }], evidence: ['deleted_with_no_row', 'created_by_n8n'] },
    { loadId: 'LX-5101', tombstoneId: 4, deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 4, canRestore: false, canCreateNew: false, rows: [4], newRows: [4], ownRows: [],
      months: [{ month: '2026-10', closed: false }], evidence: ['deleted_with_no_row', 'created_by_n8n'] },
  ])
  const reviewed = view(lib.hiddenLoadChoice(HIDDEN), true)
  eq('§4 ...reviewed: why it shows, its row, its month, and what each choice does there', [reviewed.why, reviewed.message, reviewed.restoreNote, reviewed.monthLines, reviewed.createOff, reviewed.createNote], [
    'Why it shows: it was deleted when no row held its Load ID; the email workflow added this Load ID after the delete.',
    "Deleted Oct 1, 2026 by admin_two. Row 4 has this Load ID, but it doesn't count while that delete stands.",
    'Brings the deleted load back: row 4 counts again.',
    ['October 2026: open'],
    false,
    'Clears the old delete, so row 4 counts as a new load.',
  ])
  const OWN = { ...HIDDEN, sheetRow: 6, rows: [2, 6], newRows: [6], ownRows: [2], canCreateNew: false, evidence: ['row_changed'] }
  const own = view(lib.hiddenLoadChoice(OWN), true)
  eq('§4 ...with a row that may be the delete\'s own: Create it as new off, naming that row', [own.message, own.restoreNote, own.createOff, own.createNote], [
    "Deleted Oct 1, 2026 by admin_two. Rows 2 and 6 have this Load ID, but they don't count while that delete stands.",
    'Brings the deleted load back: rows 2 and 6 count again.',
    true,
    "Row 2 may be this load's row from before its delete: restore it instead, or remove that row first.",
  ])
  eq('§4 ...two such rows, named together', view(lib.hiddenLoadChoice({ ...OWN, rows: [2, 3, 6], ownRows: [2, 3] }), true).createNote,
    "Rows 2 and 3 may be this load's rows from before its delete: restore it instead, or remove those rows first.")
  eq('§4 the evidence, each way', ['created_by_rate_con', 'created_in_sheet_row', 'row_changed', 'row_in_other_month', 'nonsense'].map((e) => lib.hiddenEvidenceText([e])), [
    'Why it shows: a rate con created this Load ID after the delete.',
    'Why it shows: New Job or the Data Manager added this Load ID after the delete.',
    'Why it shows: its row changed after the delete.',
    "Why it shows: a row with this Load ID books into a month its delete didn't name.",
    '',
  ])
  eq('§4 hidden loads as the dashboard sent them; anything malformed left out', [
    lib.hiddenLoadsOf({ hiddenLoads: [HIDDEN, { loadId: 'x' }, null] }).map((h) => h.tombstoneId), lib.hiddenLoadsOf({}), lib.hiddenLoadsOf(null)], [[4], [], []])

  // withDeletedLoadChoice(send, ask): the flow every create form shares.
  const flow = async ({ answers, fails }) => {
    const sent = []
    const asked = []
    let i = 0
    const send = async (choice) => {
      sent.push(choice)
      const f = fails[i++]
      if (f) throw f
      return { success: true }
    }
    const ask = async (choice, note) => { asked.push([choice.tombstoneId, note]); return answers.shift() }
    let threw = null
    let out = null
    try { out = await lib.withDeletedLoadChoice(send, ask) } catch (e) { threw = e }
    return { sent, asked, out, threw }
  }
  const choiceErr = () => asErr({ ...CHOICE, error: 'Load 7101 was deleted (made-up).' })
  const a = await flow({ answers: [{ action: 'create_new', reason: 'Booked again (made-up)' }], fails: [choiceErr()] })
  eq('§4 Create it as new: the same create again, carrying the choice, the deletes it saw and the reason', [a.sent, a.asked, a.out],
    [[null, { action: 'create_new', id: 9, count: 1, reason: 'Booked again (made-up)' }], [[9, '']], { success: true }])
  const reasonErr = asErr({ code: 'CONTACT_NOT_ALLOWED', field: 'reason', error: "The reason can't hold an email address or a phone number (made-up)." }, 400)
  const ra = await flow({ answers: [{ action: 'create_new', reason: 'Call 555-010-0150' }, { action: 'create_new', reason: 'Booked again (made-up)' }], fails: [choiceErr(), reasonErr] })
  eq('§4 a reason the server refuses: the same choice asked again with its words, then sent with the new reason', [ra.asked, ra.sent, ra.out], [
    [[9, ''], [9, "The reason can't hold an email address or a phone number (made-up)."]],
    [null, { action: 'create_new', id: 9, count: 1, reason: 'Call 555-010-0150' }, { action: 'create_new', id: 9, count: 1, reason: 'Booked again (made-up)' }],
    { success: true }])
  const plain400 = await flow({ answers: [], fails: [asErr({ code: 'CONTACT_NOT_ALLOWED', field: 'Contract ID', error: 'Contract ID holds an email (made-up).' }, 400)] })
  eq('§4 ...another 400 before any choice is thrown as it came', [plain400.asked.length, plain400.threw && plain400.threw.message], [0, 'Contract ID holds an email (made-up).'])
  const b = await flow({ answers: [{ action: 'restored', answer: { ok: true } }], fails: [choiceErr()] })
  eq('§4 Restore the deleted load: nothing sent again', [b.sent.length, b.out], [1, { deletedLoadRestored: true, answer: { ok: true }, loadId: '7101' }])
  const c = await flow({ answers: [null], fails: [choiceErr()] })
  eq('§4 Cancel: nothing sent again', [c.sent.length, c.out], [1, { deletedLoadDeclined: true }])
  const stale = asErr({ ...CHOICE, tombstoneId: 10, deleteCount: 2, stale: true, error: 'The delete record for load 7101 changed after you chose (made-up).' })
  const d = await flow({ answers: [{ action: 'create_new' }, { action: 'create_new' }], fails: [choiceErr(), stale] })
  eq('§4 a stale choice asks again with the server\'s words and the fresh delete', [d.asked, d.sent],
    [[[9, ''], [10, 'The delete record for load 7101 changed after you chose (made-up).']], [null, { action: 'create_new', id: 9, count: 1 }, { action: 'create_new', id: 10, count: 2 }]])
  const e = await flow({ answers: [], fails: [asErr({ code: 'LOAD_ID_DELETED', error: 'Ask a Super Admin (made-up).' })] })
  eq('§4 a refusal with no choice (a Dispatcher\'s) is thrown as it came', [e.asked.length, e.threw && e.threw.message], [0, 'Ask a Super Admin (made-up).'])
  const f = await (async () => { try { await lib.withDeletedLoadChoice(async () => { throw choiceErr() }, null); return 'no throw' } catch (err) { return err.code } })()
  eq('§4 ...and so is a choice when the form has no one to ask', f, 'LOAD_ID_DELETED')
  const g = await flow({ answers: [{ action: 'create_new' }, { action: 'create_new' }, { action: 'create_new' }], fails: [choiceErr(), choiceErr(), choiceErr(), choiceErr()] })
  eq('§4 it asks at most three times', [g.sent.length, g.threw && g.threw.code], [3, 'LOAD_ID_DELETED'])
}

// ---------------------------------------------------------- in-memory mount
// No DOM: an in-memory renderer (the one scripts/test-passenger-authorization-admin-client.mjs
// uses), with a radio's value kept where v-model reads it.
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}
function mountInMemory(Comp, rootProps) {
  const node = (type, tag) => {
    const n = {
      type, tag, children: [], parent: null, props: {}, text: '', value: '', checked: false, listeners: {},
      addEventListener(ev, fn) { (n.listeners[ev] = n.listeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) { n.listeners[ev] = (n.listeners[ev] || []).filter((x) => x !== fn) },
      getRootNode() { return {} },
      focus() {},
    }
    return Vue.markRaw(n)
  }
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
    querySelector: () => null,
    setScopeId() {},
    patchProp(el, key, prev, next) {
      el.props[key] = next
      if (key === 'value') { el.value = next; el._value = next }
    },
  }
  const warnings = []
  const root = node('el', 'root')
  const app = Vue.createRenderer(ops).createApp(Comp, rootProps)
  app.config.warnHandler = (msg) => warnings.push(String(msg))
  app.mount(root)
  const textOf = (n) => (!n ? '' : n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => {
    if (!n) return out
    if (n.type === 'el' && pred(n)) out.push(n)
    for (const ch of n.children || []) all(ch, pred, out)
    return out
  }
  return {
    root, warnings,
    findAll: (pred, from = root) => all(from, pred),
    find: (pred, from = root) => all(from, pred)[0] || null,
    text: (n = root) => textOf(n).replace(/\s+/g, ' ').trim(),
    unmount: () => app.unmount(),
  }
}
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
// Types into a text box as a person does: its value, then its input event (v-model or an @input handler).
async function typeInto(el, text) {
  if (!el || isDisabled(el)) return
  el.value = text
  for (const fn of el.listeners.input || []) fn({ target: el, currentTarget: el })
  const handlers = Array.isArray(el.props.onInput) ? el.props.onInput : [el.props.onInput]
  for (const fn of handlers) if (typeof fn === 'function') fn({ target: el, currentTarget: el })
  await drain()
}
const evt = (el) => ({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el })
const isDisabled = (el) => !!el && el.props.disabled != null && el.props.disabled !== false
async function press(el) {
  if (!el || isDisabled(el)) return
  const fns = Array.isArray(el.props.onClick) ? el.props.onClick : [el.props.onClick]
  for (const fn of fns) if (typeof fn === 'function') { const r = fn(evt(el)); if (r && r.catch) r.catch(() => {}) }
  await drain()
}
async function pick(el) {
  if (!el || isDisabled(el)) return
  el.checked = true
  for (const fn of el.listeners.change || []) fn(evt(el))
  await drain()
}

// A committed SFC's <script setup> + <template> as a component of its imports;
// every import must be given, a default import as { default }.
function factory(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return null
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import or export this harness cannot map`)
  return (deps) => {
    const missing = specs.filter((s) => s !== 'vue' && !Object.prototype.hasOwnProperty.call(deps, s))
    if (missing.length) throw new Error(`${rel}: no stub for ${missing.join(', ')}`)
    return new Function('__deps', body)({ vue: Vue, ...deps })
  }
}
const stub = (tag) => Vue.defineComponent({ name: tag, inheritAttrs: false, setup: (_, { attrs, slots }) => () => Vue.h(tag, { ...attrs }, slots.default ? slots.default() : []) })
// ConfirmModal as the page meets it: nothing while closed; its title, message,
// slot and two buttons while open; Cancel first.
const ConfirmStub = Vue.defineComponent({
  name: 'ConfirmModal',
  props: { open: Boolean, title: String, message: String, confirmText: String, cancelText: String, danger: Boolean, confirmDisabled: Boolean },
  emits: ['confirm', 'cancel'],
  setup(props, { emit, slots }) {
    return () => (props.open ? Vue.h('x-confirm', {}, [
      Vue.h('x-title', {}, props.title || ''),
      Vue.h('x-message', {}, props.message || ''),
      slots.default ? Vue.h('x-body', {}, slots.default()) : null,
      Vue.h('button', { 'data-role': 'cancel', onClick: () => emit('cancel') }, props.cancelText || 'Cancel'),
      Vue.h('button', { 'data-role': 'confirm', disabled: props.confirmDisabled, onClick: () => emit('confirm') }, props.confirmText || 'Confirm'),
    ]) : null)
  },
})
const DATETIME = { fmtAppInstant: (v) => (v ? `at ${v}` : '—'), appToday: () => '2026-10-15', appDayOf: (v) => String(v || '').slice(0, 10), shiftYmd: (d) => d }
// A post the test answers: each stays out until resolved or rejected.
function fakeApi(list) {
  const api = { gets: [], posts: [] }
  api.get = async (url) => { api.gets.push(url); return typeof list === 'function' ? list() : list }
  api.post = (url, body) => new Promise((resolve, reject) => { api.posts.push({ url, body, resolve, reject }) })
  return api
}
const DELETED = [
  { id: 6, loadId: 'lx-1004', deletedAt: '2026-10-21T09:00:00Z', deletedBy: '', pickup: '', dropoff: '', driver: '', months: [], monthsFrom: 'none' },
  { id: 3, loadId: 'lx-1002', deletedAt: '2026-10-20T12:00:00Z', deletedBy: 'admin_two', pickup: 'Lakeview, OH 43331', dropoff: 'Hilltop, KY 40001', driver: 'Test Driver Two', months: [{ month: '2026-10', closed: false }], monthsFrom: 'sheet' },
  { id: 1, loadId: 'lx-1001', deletedAt: '2026-09-01T02:30:00Z', deletedBy: 'super_admin', pickup: 'Springfield, IL 62701', dropoff: 'Riverton, WY 82501', driver: 'Test Driver One', months: [{ month: '2026-05', closed: true }], monthsFrom: 'sheet' },
]
const listAnswer = (restoreOn) => ({ loads: DELETED.map((l) => ({ ...l })), count: DELETED.length, ...(restoreOn ? { restore: { enabled: true } } : {}) })

// --------------------------------------------------------------- §5 the page
const PAGE = factory('client/src/views/DeletedLoadsView.vue')
async function mountPage({ role, restoreOn = false, mobile = false } = {}) {
  const api = fakeApi(() => listAnswer(restoreOn))
  const toasts = []
  const isMobile = Vue.ref(mobile)
  const Comp = PAGE({
    '../composables/useApi': { useApi: () => api },
    '../composables/useSocketRefresh': { useSocketRefresh: () => {} },
    '../composables/useViewport': { useViewport: () => ({ isMobile }) },
    '../composables/useToast': { useToast: () => ({ show: (m, t) => toasts.push([m, t]) }) },
    '../stores/auth': { useAuthStore: () => ({ user: role ? { role } : null, isSuperAdmin: role === 'Super Admin' }) },
    '../utils/datetime': DATETIME,
    '../lib/deletedLoadsView.js': lib,
    '@/components/ui/table': { Table: stub('x-table'), TableHeader: stub('x-thead'), TableBody: stub('x-tbody'), TableRow: stub('x-tr'), TableHead: stub('x-th'), TableCell: stub('x-td') },
    '../components/shared/SkeletonLoader.vue': { default: stub('x-skeleton') },
    '../components/shared/EmptyState.vue': { default: stub('x-empty') },
    '../components/shared/ConfirmModal.vue': { default: ConfirmStub },
  })
  const m = mountInMemory(Comp)
  await drain()
  const p = {
    m, api, toasts, isMobile,
    restoreButtons: () => m.findAll((n) => n.tag === 'button' && m.text(n) === 'Restore'),
    confirm: () => m.find((n) => n.tag === 'x-confirm'),
    confirmButton: () => m.find((n) => n.tag === 'button' && n.props['data-role'] === 'confirm'),
    cancelButton: () => m.find((n) => n.tag === 'button' && n.props['data-role'] === 'cancel'),
    reasonBox: () => m.find((n) => n.tag === 'textarea'),
  }
  return p
}
let pageOk = false
try { pageOk = !!PAGE && !!lib && !!(await mountPage({ role: 'Super Admin' })) } catch (err) { console.log(`  (the page did not mount: ${err.message})`) }
ok('§5 DeletedLoadsView.vue mounts in this harness', pageOk)
if (pageOk) {
  for (const role of ROLES_NOT_SA) {
    const p = await mountPage({ role, restoreOn: true })
    ok(`§5 ${role || 'no user'}: nothing rendered (no page, list, button or confirm)`, p.m.text() === '' && !p.m.find((n) => n.tag !== 'root'))
    eq(`§5 ${role || 'no user'}: the deleted-loads list is never asked for, nothing posted`, [p.api.gets, p.api.posts.length], [[], 0])
    p.m.unmount()
  }
  {
    const p = await mountPage({ role: 'Super Admin', restoreOn: false })
    eq('§5 Super Admin, restore off: the list is read once', p.api.gets, ['/api/admin/deleted-loads'])
    ok('§5 ...the page reads as before ("a list only")', /This page is a list only\./.test(p.m.text()) && p.m.find((n) => n.tag === 'x-table') !== null)
    eq('§5 ...with no Restore button and no confirm', [p.restoreButtons().length, !!p.confirm()], [0, false])
    p.isMobile.value = true
    await drain()
    eq('§5 ...on a phone too', p.restoreButtons().length, 0)
    p.m.unmount()
  }
  {
    const p = await mountPage({ role: 'Super Admin', restoreOn: true })
    eq('§5 Super Admin, restore on: a Restore button on each row', p.restoreButtons().length, DELETED.length)
    ok('§5 ...and the page says what it does', /Restore brings a load back unless its month is closed\./.test(p.m.text()) && !/This page is a list only\./.test(p.m.text()))
    await press(p.restoreButtons()[1])
    const c = p.confirm()
    eq('§5 the in-app confirm names the load, who deleted it and when, and its month', [
      p.m.text(p.m.find((n) => n.tag === 'x-title', c)), p.m.text(p.m.find((n) => n.tag === 'x-message', c)), p.m.text(p.confirmButton())],
    ['Restore load lx-1002?', "Deleted at 2026-10-20T12:00:00Z by admin_two. October 2026: open Restoring puts it back on the dashboard and in its month's figures.", 'Restore'])
    eq('§5 ...nothing is sent until it is confirmed', p.api.posts.length, 0)
    const box = p.reasonBox()
    eq('§5 a reason box in the confirm; Restore off while it is empty (the 10-22 Restore decision)', [!!box, box && Number(box.props.maxlength), isDisabled(p.confirmButton())], [true, 500, true])
    await typeInto(box, '  ok  ')
    eq('§5 ...and while it has under 3 characters once trimmed', isDisabled(p.confirmButton()), true)
    await press(p.confirmButton())
    eq('§5 ...a press then sends nothing', p.api.posts.length, 0)
    await typeInto(p.reasonBox(), '  Re-booked by the broker (made-up) ')
    eq('§5 ...on once it has 3 or more', isDisabled(p.confirmButton()), false)
    await press(p.confirmButton())
    await press(p.confirmButton())
    eq('§5 confirmed: one POST to its delete record with the reason, a second press blocked while it is out', [p.api.posts.length, p.api.posts[0] && p.api.posts[0].url, p.api.posts[0] && p.api.posts[0].body, isDisabled(p.confirmButton())],
      [1, '/api/admin/deleted-loads/3/restore', { reason: 'Re-booked by the broker (made-up)' }, true])
    await press(p.restoreButtons()[2])
    eq('§5 ...and no other row can start one meanwhile', p.api.posts.length, 1)
    p.api.posts[0]?.resolve({ ok: true, mode: 'restore', restored: { id: 3, loadId: 'lx-1002', months: ['2026-10'] }, remaining: 0 })
    await drain()
    eq('§5 restored: a toast, the confirm closed, the list read again', [p.toasts, !!p.confirm(), p.api.gets.length], [[['Load lx-1002 is restored.', 'success']], false, 2])
    p.m.unmount()
  }
  {
    const p = await mountPage({ role: 'Super Admin', restoreOn: true })
    await press(p.restoreButtons()[2])
    await typeInto(p.reasonBox(), 'Deleted in error (made-up)')
    await press(p.confirmButton())
    p.api.posts[0]?.reject(Object.assign(new Error('Load lx-1001 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.'), { status: 409, code: 'PERIOD_FINALIZED' }))
    await drain()
    const alert = p.m.find((n) => n.props.role === 'alert', p.confirm())
    eq('§5 refused: the server\'s words in the confirm, which stays open; no toast; the list not read again',
      [p.m.text(alert), !!p.confirm(), p.toasts, p.api.gets.length],
      ['Load lx-1001 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.', true, [], 1])
    await press(p.cancelButton())
    eq('§5 ...Cancel closes it', !!p.confirm(), false)
    await press(p.restoreButtons()[1])
    eq('§5 ...and the next confirm starts with an empty reason, Restore off', [p.reasonBox() && p.reasonBox().value, isDisabled(p.confirmButton())], ['', true])
    p.m.unmount()
  }
  {
    const p = await mountPage({ role: 'Super Admin', restoreOn: true, mobile: true })
    eq('§5 on a phone: a Restore button on each card', [p.restoreButtons().length, !!p.m.find((n) => n.tag === 'li')], [DELETED.length, true])
    p.m.unmount()
  }
}

// ------------------------------------------------------- §6 the create choice
const CHOICE_FACTORY = factory('client/src/components/shared/DeletedLoadChoiceModal.vue')
const choiceDeps = (api) => ({
  '../../composables/useApi': { useApi: () => api },
  '../../utils/datetime': DATETIME,
  '../../lib/deletedLoadsView.js': lib,
  './ConfirmModal.vue': { default: ConfirmStub },
})
async function mountChoice({ choice, review = false, note = '' }) {
  const api = fakeApi({})
  const Choice = CHOICE_FACTORY(choiceDeps(api))
  const events = []
  const state = Vue.reactive({ open: true, choice, review, note })
  const Host = Vue.defineComponent({
    setup: () => () => Vue.h(Choice, { ...state, onResolved: (a) => events.push(['resolved', a]), onCreateNew: (...a) => events.push(['create-new', ...a]), onCancel: () => events.push(['cancel']) }),
  })
  const m = mountInMemory(Host)
  await drain()
  return {
    m, api, events, state,
    radio: (value) => m.find((n) => n.tag === 'input' && n.props.value === value),
    confirmButton: () => m.find((n) => n.tag === 'button' && n.props['data-role'] === 'confirm'),
    cancelButton: () => m.find((n) => n.tag === 'button' && n.props['data-role'] === 'cancel'),
    reasonBox: () => m.find((n) => n.tag === 'textarea'),
  }
}
const WHY = 'Booked again by the broker (made-up)'
const NO_ROW = { code: 'LOAD_ID_DELETED', loadId: '7101', tombstoneId: 9, deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: null, canRestore: false, canCreateNew: true, deleteCount: 1 }
const WITH_ROW = { ...NO_ROW, loadId: '7003', tombstoneId: 11, sheetRow: 4, canRestore: true, canCreateNew: false }
let choiceOk = false
try { choiceOk = !!CHOICE_FACTORY && !!lib && has('deletedLoadChoiceView') && !!(await mountChoice({ choice: NO_ROW })) } catch (err) { console.log(`  (the choice did not mount: ${err.message})`) }
ok('§6 DeletedLoadChoiceModal.vue mounts in this harness', choiceOk)
if (choiceOk) {
  {
    const c = await mountChoice({ choice: NO_ROW })
    ok('§6 it names who deleted the load and when, and shows both choices',
      /Load 7101 was deleted/.test(c.m.text()) && /Deleted at 2026-10-01T12:00:00Z by admin_two\./.test(c.m.text())
      && /Restore the deleted load/.test(c.m.text()) && /Create it as new/.test(c.m.text()))
    eq('§6 no row: Restore shown off with its reason; Create it as new picked', [isDisabled(c.radio('restore')), /Its Job Tracking row is gone, so there's nothing to restore\./.test(c.m.text()),
      c.radio('create_new') && c.radio('create_new').checked, c.m.text(c.confirmButton())], [true, true, true, 'Create it as new'])
    eq('§6 ...a reason box, and Create it as new off until it has 3 or more characters (the 10-22 Restore decision)', [!!c.reasonBox(), isDisabled(c.confirmButton())], [true, true])
    await typeInto(c.reasonBox(), ' no ')
    await press(c.confirmButton())
    eq('§6 ...under 3 once trimmed: still off, nothing handed back', [isDisabled(c.confirmButton()), c.events], [true, []])
    await typeInto(c.reasonBox(), WHY)
    await press(c.confirmButton())
    eq('§6 ...confirmed: handed back to the form with the reason, nothing posted', [c.events, c.api.posts.length], [[['create-new', WHY]], 0])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: WITH_ROW })
    eq('§6 a row holds it: Create it as new off with its reason; Restore picked', [isDisabled(c.radio('create_new')),
      /Row 4 still holds this load: restore it instead, or remove that row first\./.test(c.m.text()), c.m.text(c.confirmButton())], [true, true, 'Restore the deleted load'])
    eq('§6 ...Restore off until the reason is filled', isDisabled(c.confirmButton()), true)
    await typeInto(c.reasonBox(), WHY)
    await press(c.confirmButton())
    await press(c.confirmButton())
    await press(c.cancelButton())
    eq('§6 ...confirmed: one POST to that delete record with the reason; a second press and Cancel wait for it', [c.api.posts.length, c.api.posts[0] && c.api.posts[0].url, c.api.posts[0] && c.api.posts[0].body, c.events],
      [1, '/api/admin/deleted-loads/11/restore', { reason: WHY }, []])
    c.api.posts[0]?.reject(Object.assign(new Error('Load 7003 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.'), { status: 409, code: 'PERIOD_FINALIZED' }))
    await drain()
    eq('§6 refused: the server\'s words, still open, nothing handed back', [c.m.text(c.m.find((n) => n.props.role === 'alert')), c.events],
      ['Load 7003 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.', []])
    await press(c.confirmButton())
    c.api.posts[1]?.resolve({ ok: true, mode: 'restore', restored: { id: 11, loadId: '7003', months: ['2026-10'] }, remaining: 0 })
    await drain()
    eq('§6 ...tried again and restored: the answer handed back', c.events, [['resolved', { ok: true, mode: 'restore', restored: { id: 11, loadId: '7003', months: ['2026-10'] }, remaining: 0 }]])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: { ...NO_ROW, deleteCount: 2 } })
    eq('§6 deleted twice with no row: Create it as new on and picked, clearing both (M5)', [isDisabled(c.radio('restore')), isDisabled(c.radio('create_new')), c.radio('create_new') && c.radio('create_new').checked,
      /Clears all 2 old deletes of this Load ID and creates this load\./.test(c.m.text())], [true, false, true, true])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: { ...WITH_ROW, months: [{ month: '2026-10', closed: false }, { month: '2026-05', closed: true }], monthsFrom: 'audit' } })
    eq('§6 a row holds it: its months under Restore, open or closed (L1)', c.m.findAll((n) => (n.props.class || '').split(' ').includes('dlc-option-month')).map((n) => c.m.text(n)),
      ['October 2026: open', 'May 2026: closed (from the delete record)'])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: lib.hiddenLoadChoice({ tombstoneId: 4, loadId: 'LX-5101', deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 7, rows: [7], newRows: [7], ownRows: [],
      canRestore: true, canCreateNew: true, months: [{ month: '2026-10', closed: false }], evidence: ['row_changed'] }), review: true })
    eq('§6 from the banner: both on, neither picked, the evidence, the row and its month shown', [isDisabled(c.radio('restore')), isDisabled(c.radio('create_new')), isDisabled(c.confirmButton()),
      /Why it shows: its row changed after the delete\./.test(c.m.text()), /Row 7 has this Load ID/.test(c.m.text()), /row 7 counts as a new load\./.test(c.m.text()), /October 2026: open/.test(c.m.text())],
    [false, false, true, true, true, true, true])
    await pick(c.radio('create_new'))
    eq('§6 ...picked, Create it as new still off until the reason is filled', isDisabled(c.confirmButton()), true)
    await typeInto(c.reasonBox(), WHY)
    await press(c.confirmButton())
    eq('§6 ...Create it as new goes through the restore route, as a clear, with the reason', [c.api.posts.length, c.api.posts[0] && c.api.posts[0].url, c.api.posts[0] && c.api.posts[0].body],
      [1, '/api/admin/deleted-loads/4/restore', { mode: 'create_new', reason: WHY }])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: lib.hiddenLoadChoice({ tombstoneId: 5, loadId: 'LX-5501', deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 8, rows: [7, 8], newRows: [8], ownRows: [7],
      canRestore: true, canCreateNew: false, months: [{ month: '2026-10', closed: false }], evidence: ['row_changed'] }), review: true })
    eq('§6 from the banner, with a row that may be the delete\'s own: Create it as new off naming it, Restore picked (M3)', [isDisabled(c.radio('create_new')),
      /Row 7 may be this load's row from before its delete: restore it instead, or remove that row first\./.test(c.m.text()), c.m.text(c.confirmButton())], [true, true, 'Restore the deleted load'])
    c.m.unmount()
  }
  {
    const c = await mountChoice({ choice: NO_ROW, note: 'The delete record for load 7101 changed after you chose (made-up).' })
    eq('§6 asked again: the server\'s words lead', c.m.text(c.m.find((n) => n.props.role === 'status')), 'The delete record for load 7101 changed after you chose (made-up).')
    c.m.unmount()
  }
}

// ------------------------------------------------- §7 the banner and the dashboard
const BANNER_FACTORY = factory('client/src/components/dashboard/HiddenLoadsBanner.vue')
const HIDDEN_LIST = [
  { tombstoneId: 4, loadId: 'LX-5101', deletedBy: 'admin_two', deletedAt: '2026-10-01T12:00:00Z', sheetRow: 4, rows: [4], newRows: [4], ownRows: [],
    canRestore: true, canCreateNew: true, months: [{ month: '2026-10', closed: false }], evidence: ['deleted_with_no_row'] },
  { tombstoneId: 7, loadId: 'LX-5401', deletedBy: 'super_admin', deletedAt: '2026-10-02T12:00:00Z', sheetRow: 9, rows: [9], newRows: [], ownRows: [9],
    canRestore: true, canCreateNew: false, months: [{ month: '2026-10', closed: false }], evidence: ['created_by_n8n'] },
]
let bannerOk = false
let banner = null
try {
  if (BANNER_FACTORY && CHOICE_FACTORY && lib && has('hiddenLoadText')) {
    const api = fakeApi({})
    const toasts = []
    const Banner = BANNER_FACTORY({
      '../../composables/useToast': { useToast: () => ({ show: (msg, t) => toasts.push([msg, t]) }) },
      '../../utils/datetime': DATETIME,
      '../../lib/deletedLoadsView.js': lib,
      '../shared/DeletedLoadChoiceModal.vue': { default: CHOICE_FACTORY(choiceDeps(api)) },
    })
    const events = []
    const m = mountInMemory(Vue.defineComponent({ setup: () => () => Vue.h(Banner, { hiddenLoads: HIDDEN_LIST, onResolved: () => events.push('resolved') }) }))
    await drain()
    banner = { m, api, toasts, events }
    bannerOk = true
  }
} catch (err) { console.log(`  (the banner did not mount: ${err.message})`) }
ok('§7 HiddenLoadsBanner.vue mounts in this harness', bannerOk)
if (bannerOk) {
  const { m, api, toasts, events } = banner
  const lines = m.findAll((n) => (n.props.class || '').split(' ').includes('hl-line'))
  eq('§7 one line per hidden load, each naming it, its row, who deleted it and when, with Review', lines.map((l) => m.text(l)), [
    'Load LX-5101, row 4, is hidden by an earlier delete (deleted by admin_two on at 2026-10-01T12:00:00Z). Review',
    'Load LX-5401, row 9, is hidden by an earlier delete (deleted by super_admin on at 2026-10-02T12:00:00Z). Review',
  ])
  await press(m.find((n) => n.tag === 'button' && m.text(n) === 'Review', lines[1]))
  ok('§7 Review opens the shared choice for that load, with why it shows', /Load LX-5401 was deleted/.test(m.text()) && /Why it shows: the email workflow added this Load ID after the delete\./.test(m.text()))
  await pick(m.find((n) => n.tag === 'input' && n.props.value === 'restore'))
  await typeInto(m.find((n) => n.tag === 'textarea'), 'The email workflow re-sent it (made-up)')
  await press(m.find((n) => n.tag === 'button' && n.props['data-role'] === 'confirm'))
  eq('§7 ...Restore posts to that delete record with the reason', [api.posts.length, api.posts[0] && api.posts[0].url, api.posts[0] && api.posts[0].body],
    [1, '/api/admin/deleted-loads/7/restore', { reason: 'The email workflow re-sent it (made-up)' }])
  api.posts[0]?.resolve({ ok: true, mode: 'restore', restored: { id: 7, loadId: 'lx-5401', months: ['2026-10'] }, remaining: 0 })
  await drain()
  eq('§7 ...restored: a toast, the dialog closed, the dashboard asked to read again', [toasts, !!m.find((n) => n.tag === 'x-confirm'), events], [[['Load lx-5401 is restored.', 'success']], false, ['resolved']])
}

const DASH = factory('client/src/views/DashboardView.vue')
async function mountDashboard(role) {
  const BannerStub = Vue.defineComponent({ name: 'HiddenLoadsBanner', props: { hiddenLoads: Array }, setup: (props) => () => Vue.h('x-hidden-banner', { count: (props.hiddenLoads || []).length }) })
  const store = { data: { hiddenLoads: HIDDEN_LIST, kpis: null }, kpis: null, revenue: {}, unassignedJobs: [], activeJobs: [], completedJobs: [], fleet: [], drivers: [], offUntil: null, headers: [], completedHeaders: [], timestamp: null, refresh: async () => {} }
  const Comp = DASH({
    'vue-router': { useRoute: () => ({ query: {}, path: '/dashboard' }), useRouter: () => ({ replace() {}, push() {} }) },
    '../stores/dashboard': { useDashboardStore: () => store },
    '../composables/useSocket': { useSocket: () => ({ connect() {}, register() {}, on() {}, off() {} }) },
    '../composables/useToast': { useToast: () => ({ show() {} }) },
    '../composables/useSocketRefresh': { useSocketRefresh: () => {} },
    '../utils/datetime': DATETIME,
    '@/components/ui/card': { Card: stub('x-card'), CardContent: stub('x-card-content') },
    '@/components/ui/tabs': { Tabs: stub('x-tabs'), TabsList: stub('x-tabs-list'), TabsTrigger: stub('x-tab'), TabsContent: stub('x-tab-content') },
    '@/components/ui/badge': { Badge: stub('x-badge') },
    '../stores/auth': { useAuthStore: () => ({ user: { role }, isSuperAdmin: role === 'Super Admin' }) },
    '../lib/driverName': { normDriver: (n) => String(n || '').toLowerCase() },
    '../lib/loadRef': { loadIdShown: () => '', loadKeyStale: () => false },
    '../lib/availabilityText': { sortDriversForAssign: (d) => d },
    '../composables/useOffDutyConfirm': { useOffDutyConfirm: () => ({ withOffDutyConfirm: (send) => send(false) }) },
    '../lib/deletedLoadsView.js': lib,
    '../components/dashboard/KpiGrid.vue': { default: stub('x-kpi') },
    '../components/dashboard/RevenueGrid.vue': { default: stub('x-revenue') },
    '../components/dashboard/JobBoardTab.vue': { default: stub('x-jobboard') },
    '../components/dashboard/ActiveLoadsTab.vue': { default: stub('x-active') },
    '../components/dashboard/FleetTab.vue': { default: stub('x-fleet') },
    '../components/dashboard/CompletedLoadsTab.vue': { default: stub('x-completed') },
    '../components/dashboard/HiddenLoadsBanner.vue': { default: BannerStub },
  })
  const m = mountInMemory(Comp)
  await drain()
  return m
}
let dashOk = false
try { dashOk = !!DASH && !!lib && !!(await mountDashboard('Super Admin')) } catch (err) { console.log(`  (the dashboard did not mount: ${err.message})`) }
ok('§7 DashboardView.vue mounts in this harness', dashOk)
if (dashOk) {
  const sa = await mountDashboard('Super Admin')
  const bannerEl = sa.find((n) => n.tag === 'x-hidden-banner')
  eq('§7 a Super Admin\'s dashboard: the banner, at the top, with the hidden loads', [!!bannerEl, bannerEl && bannerEl.props.count, sa.root.children[0] && sa.root.children[0].children[0] === bannerEl], [true, 2, true])
  for (const role of ['Dispatcher', 'Driver', 'Investor', 'Admin']) {
    const m = await mountDashboard(role)
    eq(`§7 ${role}: no banner in the page, even with hidden loads in the answer`, !!m.find((n) => n.tag === 'x-hidden-banner'), false)
  }
}

// ------------------------------------------------------------- §8 wiring
const RATECON = read('client', 'src', 'components', 'shared', 'RateConReviewModal.vue')
const NEWJOB = read('client', 'src', 'views', 'NewJobView.vue')
const DATAMGR = read('client', 'src', 'views', 'DataManagerView.vue')
const SHEETS = read('client', 'src', 'stores', 'sheets.js')
const NOTIFS = read('client', 'src', 'views', 'NotificationsView.vue')
for (const [name, src] of [['the rate-con modal', RATECON], ['New Job', NEWJOB], ['the Data Manager', DATAMGR]]) {
  ok(`§8 ${name} asks through withDeletedLoadChoice(), with a Super Admin's ask only`, /withDeletedLoadChoice\(/.test(src) && /auth\.isSuperAdmin \? deletedChoice\.ask : null/.test(src))
  ok(`§8 ${name} hands the reason typed in the choice on to the re-send`, /const onDeletedLoadCreateNew = \(reason\) => deletedChoice\.answer\(\{ action: 'create_new', reason \}\)/.test(src))
  eq(`§8 ${name} renders the choice for a Super Admin only`, (src.match(/<DeletedLoadChoiceModal\b[^>]*>/g) || []).map((t) => /v-if="auth\.isSuperAdmin"/.test(t)), [true])
}
ok('§8 the rate-con modal shows the server\'s words for a Load ID an old delete names, before its duplicate message',
  /if \(err\?\.code === 'LOAD_ID_DELETED'\) return err\.message/.test(RATECON) && RATECON.indexOf("err?.code === 'LOAD_ID_DELETED'") < RATECON.indexOf("err?.code === 'DUPLICATE_LOAD'"))
ok('§8 the rate-con create and New Job send the choice with the create', /\.\.\.\(choice \? \{ deletedLoadChoice: choice \} : \{\}\)/.test(RATECON) && /\.\.\.\(choice \? \{ deletedLoadChoice: choice \} : \{\}\)/.test(NEWJOB))
ok('§8 the Data Manager\'s addRow() sends it too', /\.\.\.\(opts\.deletedLoadChoice \? \{ deletedLoadChoice: opts\.deletedLoadChoice \} : \{\}\)/.test(SHEETS) && /store\.addRow\(values, \{ confirmOffDuty, deletedLoadChoice: choice \}\)/.test(DATAMGR))
ok('§8 tapping the notice opens the dashboard, where its banner is', /if \(n\.type === HIDDEN_LOAD_NOTICE_TYPE\) \{\s*router\.push\(\{ path: '\/dashboard' \}\)\s*return\s*\}/.test(NOTIFS))
{
  let serverType = null
  try { serverType = createRequire(path.join(ROOT, 'package.json'))(path.join(ROOT, 'lib', 'deleted-load-restore.js')).NOTICE_TYPE } catch { serverType = null }
  eq('§8 the client\'s notice type is the server\'s', [lib && lib.HIDDEN_LOAD_NOTICE_TYPE, serverType], ['load-hidden-by-delete', 'load-hidden-by-delete'])
}

if (failures.length) {
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n${pass} passed, 0 failed`)
process.exit(0)
