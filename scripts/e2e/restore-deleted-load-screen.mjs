#!/usr/bin/env node
// LogisX — restoring a deleted load (DELETED_LOAD_RESTORE_ENABLED), on made-up data only, at 390 x 844 and 1280 x 800:
//   RL1 the Deleted loads list with Restore     RL2 the in-app confirm         RL3 a closed month refused in the server's words
//   RL4 New Job's choice for a Load ID an old delete names                     RL5 the dashboard banner     RL6 its Review
//   RLx no page errors, and at 390 no sideways scroll on any step
// Like driver-fuel-screen.mjs: no server.js, database, settings file, key or sign-in. The checkout's built client/dist is served
// from 127.0.0.1 (--port, default 3188; 3000, 5173 and 3901 refused), every /api request is answered in the browser with made-up
// fixtures as a signed-in Super Admin, and every other host is aborted. Chromium and the server are closed before it exits.
//   npm --prefix scripts/e2e ci          (once; playwright-core)
//   npm run build:client                 (the build under test)
//   node scripts/e2e/restore-deleted-load-screen.mjs --shots <dir>
// Output: the screenshots in --shots (default <work dir>/shots/restore-deleted-load) and results-restore-deleted-load.md in the
// work dir. Run it outside the Claude Code Bash sandbox (Chrome binds its own sockets). Exit 0 only when every row PASSes.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const PORT = Number(arg('--port') || 3188)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const DIST = path.join(paths.REPO, 'client', 'dist')
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

function die(msg) {
  console.error(`restore-deleted-load-screen: ${msg}`)
  process.exit(2)
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`--port must be a port number from 1024 to 65535; got "${arg('--port')}"`)
if (PORT === 3000 || PORT === 5173 || PORT === 3901) die(`refusing port ${PORT}: 3000 is production's port on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)

const WORK = paths.workDir()
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : path.join(WORK, 'shots', 'restore-deleted-load')
fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
const RESULTS = path.join(WORK, 'results-restore-deleted-load.md')

// ---------------------------------------------------------------- made-up fixtures
const SUPER_ADMIN = { id: 90041, username: 'qa-super-admin', role: 'Super Admin', fullName: 'QA Super Admin', driverName: '', email: '', companyName: '', mustChangePassword: false }
const DELETED = [
  { id: 6, loadId: 'qa-1004', rowIndex: 0, deletedAt: '2026-10-21T13:00:00Z', deletedDay: '2026-10-21', deletedBy: 'qa-admin-two', pickup: '', dropoff: '', driver: '', months: [], monthsFrom: 'none' },
  { id: 3, loadId: 'qa-1002', rowIndex: 3, deletedAt: '2026-10-20T16:00:00Z', deletedDay: '2026-10-20', deletedBy: 'qa-admin-two', pickup: 'Lakeview, OH 43331', dropoff: 'Hilltop, KY 40001', driver: 'Driver QA Two', months: [{ month: '2026-10', closed: false }], monthsFrom: 'sheet' },
  { id: 1, loadId: 'qa-1001', rowIndex: 2, deletedAt: '2026-09-01T02:30:00Z', deletedDay: '2026-08-31', deletedBy: 'qa-super-admin', pickup: 'Springfield, IL 62701', dropoff: 'Riverton, WY 82501', driver: 'Driver QA One', months: [{ month: '2026-05', closed: true }], monthsFrom: 'sheet' },
]
const CLOSED_WORDS = 'Load qa-1001 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.'
const JT_HEADERS = ['Load ID', 'Contract ID', 'Driver', 'Job Status', 'Pickup Address', 'Pickup Appointment', 'Drop-off Address', 'Drop-off Appointment', 'Assigned Date', 'Status Update Date', 'Details']
const NEW_LOAD = 'QA-7101'
const CHOICE = {
  error: `Load ${NEW_LOAD} was deleted on 2026-10-01 by qa-admin-two. Restore the deleted load, or create it as new.`,
  code: 'LOAD_ID_DELETED', loadId: NEW_LOAD, tombstoneId: 9, deletedBy: 'qa-admin-two', deletedAt: '2026-10-01T16:00:00Z',
  sheetRow: null, canRestore: false, canCreateNew: true, deleteCount: 1,
}
const HIDDEN = [
  { tombstoneId: 12, loadId: 'QA-5401', deletedBy: 'qa-admin-two', deletedAt: '2026-10-02T15:00:00Z', sheetRow: 9, evidence: ['created_by_n8n'] },
  { tombstoneId: 11, loadId: 'QA-5101', deletedBy: 'qa-super-admin', deletedAt: '2026-10-01T14:00:00Z', sheetRow: 4, evidence: ['deleted_with_no_row', 'row_changed'] },
]
const DASHBOARD = {
  timestamp: '2026-11-10T15:00:00.000Z',
  hiddenLoads: HIDDEN,
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 0 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: JT_HEADERS, completedHeaders: JT_HEADERS, activeJobs: [], completedJobs: [], fleet: [], drivers: [], driverQueues: {},
}

function answerGet(pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/New_York' })
  if (pathname === '/api/admin/deleted-loads') return ok({ loads: DELETED, count: DELETED.length, restore: { enabled: true } })
  if (pathname === '/api/dashboard') return ok(DASHBOARD)
  if (pathname === '/api/data') return ok({ headers: JT_HEADERS, data: [], sheet: 'Job Tracking', total: 0, page: 1, limit: 1, totalPages: 0, duplicates: [] })
  if (pathname === '/api/drivers-directory') return ok({ headers: ['Driver'], data: [] })
  if (pathname === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  return ok({})
}
function answerWrite(method, pathname) {
  const m = /^\/api\/admin\/deleted-loads\/(\d+)\/restore$/.exec(pathname)
  if (method === 'POST' && m && m[1] === '1') return { status: 409, body: { error: CLOSED_WORDS, code: 'PERIOD_FINALIZED', periods: ['2026-05'] } }
  if (method === 'POST' && m) return { status: 200, body: { ok: true, mode: 'restore', restored: { id: Number(m[1]), loadId: 'qa-1002', months: ['2026-10'] }, remaining: 0 } }
  if (method === 'POST' && pathname === '/api/data') return { status: 409, body: CHOICE }
  return { status: 200, body: {} }
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the restore screens"}')
    return
  }
  const file = path.resolve(DIST, '.' + path.posix.normalize(rel))
  const inside = file === DIST || file.startsWith(DIST + path.sep)
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(target).pipe(res)
}
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------- results
const rows = []
const pageErrors = []
const posts = []
let exitCode = 0
function record(step, title, observed, pass, shot = '') {
  if (!pass) exitCode = 1
  rows.push({ step, title, observed, verdict: pass ? 'PASS' : 'FAIL', shot })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

async function openPage(browser, viewport, url) {
  const phone = viewport.width < 768
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const a = req.method() === 'GET' ? answerGet(u.pathname) : answerWrite(req.method(), u.pathname)
    if (req.method() !== 'GET') posts.push(`${req.method()} ${u.pathname}`)
    return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  await page.goto(`${BASE}${url}`)
  return { ctx, page }
}
const sideways = (page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`)
  try { await page.screenshot({ path: file, fullPage: true }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}
const dialogText = async (page) => (await page.locator('.confirm-dialog').first().innerText()).replace(/\s+/g, ' ').trim()

async function deletedLoads(browser, viewport, tag) {
  const { ctx, page } = await openPage(browser, viewport, '/admin/deleted-loads')
  try {
    const restoreOf = (id) => page.locator('li.dl-card, tr.dl-row').filter({ hasText: id }).locator('button.dl-restore')
    await restoreOf('qa-1002').first().waitFor({ state: 'visible', timeout: 30000 })
    const buttons = await page.locator('button.dl-restore').count()
    const wide = await sideways(page)
    record(`RL1${tag}`, 'the Deleted loads list with Restore', `${buttons} Restore button(s); sideways ${wide} px`, buttons === DELETED.length && wide <= 0, await shot(page, `rl1-list-${viewport.width}`))

    await restoreOf('qa-1002').first().click()
    await page.locator('.confirm-dialog').waitFor({ state: 'visible', timeout: 10000 })
    const c = await dialogText(page)
    record(`RL2${tag}`, 'the in-app confirm names the load, who deleted it and when, and its month', c.slice(0, 220),
      c.includes('Restore load qa-1002?') && c.includes('by qa-admin-two') && c.includes('October 2026: open'), await shot(page, `rl2-confirm-${viewport.width}`))
    await page.locator('.confirm-dialog button', { hasText: 'Cancel' }).click()
    await page.locator('.confirm-dialog').waitFor({ state: 'hidden', timeout: 10000 })

    await restoreOf('qa-1001').first().click()
    await page.locator('.confirm-dialog').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('.confirm-dialog .confirm-actions button', { hasText: 'Restore' }).click()
    await page.locator('.confirm-dialog [role="alert"]').waitFor({ state: 'visible', timeout: 10000 })
    const words = (await page.locator('.confirm-dialog [role="alert"]').innerText()).trim()
    record(`RL3${tag}`, 'a closed month refused in the server\'s words, the confirm kept open', words, words === CLOSED_WORDS, await shot(page, `rl3-refusal-${viewport.width}`))
  } finally {
    await ctx.close()
  }
}

async function newJob(browser, viewport, tag) {
  const { ctx, page } = await openPage(browser, viewport, '/jobs/new')
  try {
    const field = page.getByPlaceholder('e.g. LD-20260402')
    await field.waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForTimeout(500)
    await field.fill(NEW_LOAD)
    await page.locator('button', { hasText: 'Create Job' }).click()
    await page.locator('.confirm-dialog').waitFor({ state: 'visible', timeout: 10000 })
    const c = await dialogText(page)
    const restoreOff = await page.locator('.confirm-dialog input[value="restore"]').isDisabled()
    const createPicked = await page.locator('.confirm-dialog input[value="create_new"]').isChecked()
    record(`RL4${tag}`, 'New Job: the choice names who deleted the load and when; Restore off with its reason, Create it as new picked',
      `${c.slice(0, 200)} | restore off ${restoreOff}, create picked ${createPicked}`,
      c.includes(`Load ${NEW_LOAD} was deleted`) && c.includes('by qa-admin-two') && c.includes("Its Job Tracking row is gone, so there's nothing to restore.") && restoreOff && createPicked,
      await shot(page, `rl4-create-choice-${viewport.width}`))
  } finally {
    await ctx.close()
  }
}

async function dashboard(browser, viewport, tag) {
  const { ctx, page } = await openPage(browser, viewport, '/dashboard')
  try {
    await page.locator('.hidden-loads').waitFor({ state: 'visible', timeout: 30000 })
    const lines = (await page.locator('.hidden-loads .hl-text').allInnerTexts()).map((t) => t.trim())
    const wide = await sideways(page)
    record(`RL5${tag}`, 'the dashboard banner names each hidden load, who deleted it and when', `${lines.join(' | ')}; sideways ${wide} px`,
      lines.length === 2 && lines[0].startsWith('Load QA-5401 is hidden by an earlier delete (deleted by qa-admin-two on') && wide <= 0, await shot(page, `rl5-banner-${viewport.width}`))
    await page.locator('.hidden-loads .hl-review').first().click()
    await page.locator('.confirm-dialog').waitFor({ state: 'visible', timeout: 10000 })
    const c = await dialogText(page)
    const both = !(await page.locator('.confirm-dialog input[value="restore"]').isDisabled()) && !(await page.locator('.confirm-dialog input[value="create_new"]').isDisabled())
    record(`RL6${tag}`, 'Review opens the shared choice, both choices on, with why it shows', `${c.slice(0, 220)} | both on ${both}`,
      c.includes('Load QA-5401 was deleted') && c.includes('Why it shows: the email workflow added this Load ID after the delete.') && both,
      await shot(page, `rl6-review-${viewport.width}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use`)
  const server = http.createServer(serveDist)
  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: true })
    for (const [viewport, tag] of [[PHONE, ''], [DESKTOP, 'd']]) {
      for (const [name, fn] of [['deleted loads', deletedLoads], ['new job', newJob], ['dashboard', dashboard]]) {
        try { await fn(browser, viewport, tag) } catch (e) { record(`RL!${tag}`, `${name} at ${viewport.width}: aborted`, String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
      }
    }
    record('RLx', 'no page errors; writes only the ones the steps make',
      `${pageErrors.length ? pageErrors.join('; ') : 'no page errors'}; ${posts.join(', ') || 'no writes'}`,
      pageErrors.length === 0 && posts.every((p) => /^POST \/api\/(admin\/deleted-loads\/1\/restore|data)$/.test(p)))
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
  }
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `# LogisX — restoring a deleted load (made-up data) — ${new Date().toISOString()}`,
    '',
    '| Step | What | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.observed)} | ${r.verdict} | ${r.shot ? cell(path.basename(r.shot)) : ''} |`),
    '',
  ]
  fs.writeFileSync(RESULTS, lines.join('\n'))
  console.log(`\nresults: ${RESULTS}\nscreenshots: ${SHOTS}`)
}

await main()
process.exit(exitCode)
