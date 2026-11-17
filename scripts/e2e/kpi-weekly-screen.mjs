#!/usr/bin/env node
// LogisX — the KPI page's weekly pieces and the Monday email (R4), on made-up data only, with
// weekly figures on (KPI_WEEKLY_ENABLED) and kpi.weekly_since set:
//   KW1 1280 x 800, Super Admin: a weekly metric's block shows last week and "This week: <dates>
//       (to date)" with the server's figures, and its week rule; a monthly-only metric's block shows
//       its reason and no week rule (L3, L4)
//   KW2 the weekly metric approved before weekly figures began shows "Weekly figures not approved
//       yet" and "Approve weekly figures too"; the covered, monthly-only and unapproved ones do not
//   KW3 the button opens a confirm naming the metric; confirming sends ONE approval PUT for it
//       (approved true, its definition version), and the reloaded card has no button (K30, two clicks)
//   KW4 390 x 844: the same block and button; each weekly figure on one line inside its card, the
//       button wholly on screen, no sideways scroll
//   KW5 the Monday email lib/kpi-digest.js builds from the same kind of answer, written to files in
//       the work dir (never sent) and rendered at 1280 and 390: a first Monday's has the weekly
//       table and the month table, another Monday's the weekly table and the one line in place of
//       the month table; neither scrolls sideways
//   KWx per page: no console error or warning, no page error; KWy: no write but KW3's one PUT
// The answers come from lib/kpi-metrics.js computeKpis() and buildKpiResponse() over made-up loads,
// ELD days and receipts, stored as server.js stores them, so the page shows the server's own strings.
//
// Like personal-tab-screen.mjs: no server.js process, app database, settings file, key or real
// sign-in. The checkout's built client/dist is served from 127.0.0.1, every /api request is
// answered in the browser with made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/kpi-weekly-screen.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// ~/LogisX-replica/reports/cc/work/kpi-weekly-digest/screens). Run it outside the Claude Code Bash
// sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots, the two emails and
// <work dir>/results-kpi-weekly-screen.md. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'
import { weeklyApprovalConfirmText, weeklyView } from '../../client/src/lib/kpiView.js'

const require = createRequire(import.meta.url)
const kpiMetrics = require('../../lib/kpi-metrics.js')
const kpiCatalog = require('../../lib/kpi-catalog.js')
const kpiDigest = require('../../lib/kpi-digest.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'kpi-weekly-digest', 'screens')
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }

function die(msg) {
  console.error(`kpi-weekly-screen: ${msg}`)
  process.exit(2)
}
if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if ([3000, 5173, 3901].includes(ASKED_PORT)) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)
if (process.env.SHOT_DIR && !path.isAbsolute(process.env.SHOT_DIR)) die('SHOT_DIR must be an absolute path')
{
  const rel = path.relative(paths.REPO, SHOT_DIR)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${SHOT_DIR} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- the made-up answer (the server's own code)
const SINCE = '2026-11-19T22:00:00.000Z'
const plus = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const weekend = (d) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())

function inputs(asOfDay) {
  const loads = []
  let n = 0
  for (let d = '2025-04-02'; d < asOfDay; d = plus(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay()
    if (!(d >= '2026-09-01' ? [1, 2, 3, 4, 5] : [2, 4]).includes(dow)) continue
    if (d >= '2025-12-01' && d < '2026-04-01') continue
    n++
    loads.push({ loadId: `QA-KPI-${n}`, status: 'Delivered', day: d, contractIdBlank: n % 3 === 0, driverKey: `qa kpi driver ${n % 4}`, truckKey: 't1',
      detailsText: `Weight: ${38000 + (n % 7) * 500} lbs`, revenue: 1800 + (n % 9) * 150 })
  }
  const eldDaily = []
  for (let d = '2026-05-01'; d < asOfDay; d = plus(d, 1)) {
    eldDaily.push({ day: d, truckId: 'T-1', miles: weekend(d) ? 0.5 : 410 })
    eldDaily.push({ day: d, truckId: 'T-2', miles: weekend(d) ? 0 : 365 })
  }
  const fuelReceipts = []
  for (let d = '2026-05-04'; d < asOfDay; d = plus(d, 7)) fuelReceipts.push({ day: d, amount: 1650, gallons: 410, status: 'Approved' })
  return {
    asOfDay, weekly: true, timeZone: 'America/Chicago', settings: { aiDispatchStart: null, dedicatedStart: null, baselineMpg: 6.5 },
    loads, ratecon: [], eldDaily, fleetHistory: [], fuelReceipts, arrivals: [],
    trucks: [
      { id: 'T-1', status: 'Active', createdDay: '2026-04-01', inServiceDay: '2026-04-01', retiredDay: null, hasEld: true },
      { id: 'T-2', status: 'Active', createdDay: '2026-04-15', inServiceDay: '2026-04-15', retiredDay: null, hasEld: true },
    ],
    activity: { aiReceipts: ['2026-11-03', '2026-11-12', '2026-11-17'], aiExpenseInsights: [], geofenceStatuses: ['2026-11-10', '2026-11-18'], invoiceAutogenRuns: [] },
  }
}
// Approvals: loads delivered after weekly figures began (covered); revenue and fuel economy before
// them (revenue needs the weekly button, fuel economy is monthly only); miles driven not approved.
const approvalRow = (key, at) => ({ metric_key: key, approved: 1, definition_version: kpiCatalog.metricByKey(key).definitionVersion, settings_hash: '', approved_by: 'qa_kpi_admin', approved_at: at })
function answerOn(asOfDay, approvals) {
  const out = kpiMetrics.computeKpis(inputs(asOfDay))
  const snapshots = out.metrics.map((m) => ({
    day: asOfDay, metric_key: m.key, value: Number.isFinite(m.value) ? m.value : null, display: m.display, status: m.status, confidence: m.confidence,
    definition_version: kpiCatalog.metricByKey(m.key).definitionVersion,
    payload: JSON.stringify({ current: m.current, totals: m.totals, comparisons: m.comparisons, beforeAfter: m.beforeAfter, coverage: m.coverage, warnings: m.warnings, assumptions: m.assumptions, breakdown: m.breakdown, missingReason: m.missingReason }),
  }))
  const series = out.metrics.flatMap((m) => m.series.map((x) => ({ metric_key: m.key, period: x.period, value: x.value, display: x.display, coverage: x.coverage })))
  const weeklyRows = out.metrics.flatMap((m) => (m.weekly && m.weekly.mode === 'weekly' ? m.weekly.rows : []).map((x) => ({
    metric_key: m.key, week_start: x.weekStart, week_end: x.weekEnd, to_day: x.to, partial: x.partial ? 1 : 0, label: x.label,
    value: Number.isFinite(x.value) ? x.value : null, display: x.display, coverage: Number.isFinite(x.coverage) ? x.coverage : null,
    vs_label: x.vs ? x.vs.label : null, vs_display: x.vs ? x.vs.display : null, vs_status: x.vs ? x.vs.status : null,
  })))
  return kpiMetrics.buildKpiResponse({
    asOfDay, timeZone: 'America/Chicago', generatedAt: `${asOfDay}T14:00:00.000Z`, settings: { baselineMpg: 6.5, recipients: [] }, defaultRecipientConfigured: true,
    derived: out.derived, snapshots, series, approvals, weekly: true, weeklyRows, weeklySince: SINCE,
  })
}
const PAGE_DAY = '2026-11-23'
// The stub's own clock: a re-save is stamped on the page's made-up day, after SINCE as
// on the server (where the save is always later than the switch-on), whatever day it runs.
const RESAVED_AT = `${PAGE_DAY}T14:00:00.000Z`
const world = {
  approvals: [approvalRow('loads_delivered', '2026-11-20T15:00:00.000Z'), approvalRow('revenue', '2026-11-02T15:00:00.000Z'), approvalRow('fuel_mpg', '2026-11-03T15:00:00.000Z')],
  answer: null,
  kpiGets: 0,
}
world.answer = answerOn(PAGE_DAY, world.approvals)
const metricOf = (key) => world.answer.metrics.find((m) => m.key === key)

// ---------------------------------------------------------------- the browser's answers
const SUPER_ADMIN = { id: 1, username: 'super_admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA KPI Super Admin', companyName: '', mustChangePassword: false }
function fixtureGet(pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/Chicago' })
  if (pathname === '/api/auth/setup-check') return ok({ needsSetup: false })
  if (pathname === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/admin/kpis') {
    world.kpiGets++
    return ok(world.answer)
  }
  return null
}
// The approval route as the server answers it; the next GET carries the new approval.
function fixturePut(pathname, body) {
  const m = pathname.match(/^\/api\/admin\/kpis\/approvals\/([a-z_]+)$/)
  if (!m) return null
  const at = RESAVED_AT
  world.approvals = world.approvals.filter((r) => r.metric_key !== m[1]).concat([{ ...approvalRow(m[1], at), approved: body.approved ? 1 : 0 }])
  world.answer = answerOn(PAGE_DAY, world.approvals)
  return { status: 200, body: { key: m[1], approval: { approved: body.approved, by: 'super_admin', at, stale: false } } }
}

// ---------------------------------------------------------------- the static server
const DIGEST_DIR = path.join(paths.workDir(), 'kpi-weekly-emails')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serve(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  const email = rel.match(/^\/__email\/(first|other)\.html$/)
  if (email) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    fs.createReadStream(path.join(DIGEST_DIR, `${email[1]}.html`)).pipe(res)
    return
  }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the KPI weekly check"}')
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
const writes = []
const unanswered = new Set()
const offHost = new Set()
let exitCode = 0
const ONE_LINE = (s) => String(s).replace(/\r?\n/g, ' ')
function record(step, title, expected, observed, ok, shotFile = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict, shot: shotFile })
  console.log(`${verdict}  ${step}  ${title}: ${ONE_LINE(observed)}`)
}
async function shot(target, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `kpi-weekly-${name}.png`)
  await target.screenshot({ path: file })
  return file
}
const NOISE = /Failed to load resource|net::ERR|socket\.io|WebSocket/i
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()

async function openPage(browser, size, url = '/admin/kpis') {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      let body = {}
      try { body = JSON.parse(req.postData() || '{}') } catch { body = {} }
      writes.push({ method: req.method(), path: u.pathname, body })
      const out = req.method() === 'PUT' ? fixturePut(u.pathname, body) : null
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
    }
    const out = fixtureGet(u.pathname)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  const issues = []
  page.on('pageerror', (e) => issues.push(`pageerror ${String(e.message || e).slice(0, 160)}`))
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    if (NOISE.test(m.text())) return
    issues.push(`${m.type()} ${m.text().slice(0, 160)}`)
  })
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, issues }
}
const card = (page, key) => page.locator(`[role="group"][aria-labelledby="kpi-${key}"]`)
async function pairs(page, key) {
  return card(page, key).locator('.kpi-weekly-pair').evaluateAll((divs) => divs.map((d) => {
    const dd = d.querySelector('dd')
    const r = dd.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(dd).lineHeight) || r.height
    return { dt: d.querySelector('dt').textContent.replace(/\s+/g, ' ').trim(), dd: dd.textContent.trim(), oneLine: r.height <= lh * 1.5, right: r.right }
  }))
}
async function weeklyBits(page, key) {
  const c = card(page, key)
  return {
    rule: await c.locator('.kpi-weekly-rule').count(),
    note: clean(await c.locator('.kpi-weekly-note').first().textContent({ timeout: 2000 }).catch(() => '')),
    pending: clean(await c.locator('.kpi-approval-weekly-note').textContent({ timeout: 1000 }).catch(() => '')),
    button: await c.locator('.kpi-approval-weekly-btn').count(),
  }
}
async function noSidewaysScroll(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement
    return { page: doc.scrollWidth <= window.innerWidth + 1, width: doc.scrollWidth, inner: window.innerWidth }
  })
}
async function judgeConsole(step, issues) {
  record(step, 'The console is clean', 'no console error or warning, no page error', issues.length ? issues.join(' | ') : 'clean', issues.length === 0)
}

// ---------------------------------------------------------------- the runs
async function desktopRun(browser) {
  const { ctx, page, issues } = await openPage(browser, DESKTOP)
  try {
    const ready = await card(page, 'loads_delivered').locator('.kpi-weekly-pair').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    const ld = weeklyView(metricOf('loads_delivered').weekly)
    const seen = ready ? await pairs(page, 'loads_delivered') : []
    const fuel = await weeklyBits(page, 'fuel_mpg')
    await card(page, 'loads_delivered').scrollIntoViewIfNeeded().catch(() => {})
    record('KW1', 'A weekly block: last week and this week to date with the server\'s figures, its week rule; a monthly-only block: its reason, no rule',
      `"Last week (${ld.lastWeek.label})" ${ld.lastWeek.display}; "This week: ${ld.toDate.label}" ${ld.toDate.display}; fuel economy "${metricOf('fuel_mpg').weekly.reason}", no rule`,
      `${JSON.stringify(seen.map((p) => [p.dt, p.dd]))}; loads rule ${(await weeklyBits(page, 'loads_delivered')).rule}; fuel "${fuel.note}", rule ${fuel.rule}`,
      seen.some((p) => p.dt === `Last week (${ld.lastWeek.label})` && p.dd === ld.lastWeek.display)
        && seen.some((p) => p.dt === `This week: ${ld.toDate.label}` && p.dd === ld.toDate.display)
        && (await weeklyBits(page, 'loads_delivered')).rule === 1 && fuel.note === metricOf('fuel_mpg').weekly.reason && fuel.rule === 0,
      await shot(card(page, 'loads_delivered'), '1-weekly-block-1280'))

    const bits = {}
    for (const key of ['revenue', 'loads_delivered', 'fuel_mpg', 'miles_driven']) bits[key] = await weeklyBits(page, key)
    await card(page, 'revenue').scrollIntoViewIfNeeded().catch(() => {})
    record('KW2', 'Only the weekly metric approved before weekly figures began shows the button',
      'revenue: "Weekly figures not approved yet" and one button; loads (covered), fuel economy (monthly only), miles (not approved): none',
      JSON.stringify(bits),
      bits.revenue.pending === 'Weekly figures not approved yet' && bits.revenue.button === 1 && ['loads_delivered', 'fuel_mpg', 'miles_driven'].every((k) => bits[k].button === 0 && !bits[k].pending),
      await shot(card(page, 'revenue'), '2-revenue-button-1280'))

    const before = writes.length
    await card(page, 'revenue').locator('.kpi-approval-weekly-btn').click({ timeout: 5000 })
    const dialog = page.getByRole('dialog')
    const opened = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
    const want = weeklyApprovalConfirmText('Gross load revenue', world.answer.weekly.approvalNote)
    const title = clean(await dialog.getByRole('heading').first().textContent({ timeout: 2000 }).catch(() => ''))
    const dialogShot = await shot(page, '3-confirm-1280')
    const getsAtConfirm = world.kpiGets
    await dialog.getByRole('button', { name: want.action }).click({ timeout: 5000 })
    const gone = await card(page, 'revenue').locator('.kpi-approval-weekly-btn').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false)
    // The PUT's answer alone hides the button; only the reloaded answer names the stored row
    // (qa_kpi_admin, the re-save's day), so the button must stay gone after it too.
    let reloaded = false
    for (let i = 0; i < 80 && !reloaded; i++) {
      reloaded = world.kpiGets > getsAtConfirm
      if (!reloaded) await page.waitForTimeout(100)
    }
    const metaReloaded = await card(page, 'revenue').locator('.kpi-approval-meta', { hasText: 'qa_kpi_admin on Nov 23, 2026' })
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
    const buttonAfter = await card(page, 'revenue').locator('.kpi-approval-weekly-btn').count()
    const meta = clean(await card(page, 'revenue').locator('.kpi-approval-meta').textContent({ timeout: 2000 }).catch(() => ''))
    const sent = writes.slice(before)
    record('KW3', 'Two clicks: the confirm names the metric; confirming sends one approval PUT; after the reload the button stays gone',
      `title "${want.title}"; one PUT /api/admin/kpis/approvals/revenue { approved: true, definitionVersion: 1 }; a GET after it; the meta from the reloaded row; no button`,
      `opened ${opened}; title "${title}"; writes ${JSON.stringify(sent)}; hidden at once ${gone}; reloaded ${reloaded}; meta "${meta}"; buttons after the reload ${buttonAfter}`,
      opened && title === want.title && sent.length === 1 && sent[0].method === 'PUT' && sent[0].path === '/api/admin/kpis/approvals/revenue'
        && sent[0].body.approved === true && sent[0].body.definitionVersion === 1 && gone && reloaded && metaReloaded && buttonAfter === 0,
      dialogShot)
    await shot(card(page, 'revenue'), '3b-revenue-after-1280')
    const scroll = await noSidewaysScroll(page)
    record('KW1b', 'No sideways scroll at 1280', 'the page fits', JSON.stringify(scroll), scroll.page)
  } finally {
    await judgeConsole('KWx-1280', issues)
    await ctx.close()
  }
}

async function phoneRun(browser) {
  world.approvals = world.approvals.filter((r) => r.metric_key !== 'revenue').concat([approvalRow('revenue', '2026-11-02T15:00:00.000Z')])
  world.answer = answerOn(PAGE_DAY, world.approvals)
  const { ctx, page, issues } = await openPage(browser, PHONE)
  try {
    const ready = await card(page, 'revenue').locator('.kpi-weekly-pair').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    await card(page, 'revenue').locator('.kpi-weekly').scrollIntoViewIfNeeded().catch(() => {})
    const seen = ready ? await pairs(page, 'revenue') : []
    const cardBox = await card(page, 'revenue').boundingBox()
    const btn = await card(page, 'revenue').locator('.kpi-approval-weekly-btn').boundingBox()
    const scroll = await noSidewaysScroll(page)
    const blockShot = await shot(card(page, 'revenue').locator('.kpi-weekly'), '4-weekly-block-390')
    await card(page, 'revenue').locator('.kpi-approval-weekly-btn').scrollIntoViewIfNeeded().catch(() => {})
    record('KW4', '390 x 844: each weekly figure on one line inside its card; the button wholly on screen; no sideways scroll',
      'every dd on one line, its right edge inside the card; the button inside the window; the page fits',
      `${JSON.stringify(seen.map((p) => [p.dt, p.dd, p.oneLine]))}; card right ${cardBox && Math.round(cardBox.x + cardBox.width)}; button ${JSON.stringify(btn)}; scroll ${JSON.stringify(scroll)}`,
      seen.length >= 2 && seen.every((p) => p.oneLine && cardBox && p.right <= cardBox.x + cardBox.width + 1)
        && !!btn && btn.x >= 0 && btn.x + btn.width <= PHONE.viewport.width && scroll.page,
      blockShot)
    await shot(page, '4b-button-390')
  } finally {
    await judgeConsole('KWx-390', issues)
    await ctx.close()
  }
}

async function emailRun(browser) {
  fs.mkdirSync(DIGEST_DIR, { recursive: true, mode: 0o700 })
  const approvals = [approvalRow('loads_delivered', '2026-11-20T15:00:00.000Z'), approvalRow('revenue', '2026-11-02T15:00:00.000Z')]
  const mails = {
    other: kpiDigest.buildDigest({ response: answerOn('2026-11-23', approvals), preview: false, asOfDay: '2026-11-23' }),
    first: kpiDigest.buildDigest({ response: answerOn('2026-12-07', approvals), preview: false, asOfDay: '2026-12-07' }),
  }
  for (const [name, m] of Object.entries(mails)) {
    fs.writeFileSync(path.join(DIGEST_DIR, `${name}.html`), m.html, { mode: 0o600 })
    fs.writeFileSync(path.join(DIGEST_DIR, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}\n`, { mode: 0o600 })
  }
  for (const size of [DESKTOP, PHONE]) {
    const { ctx, page, issues } = await openPage(browser, size, '/__email/other.html')
    try {
      // The weekly table's heading and head; the month table's heading, then its sentence or its head
      // (innerText, which keeps table cells apart).
      const weeklyTable = (s) => /Weekly figures (None of these weekly figures|Metric Last week)/.test(s)
      const monthTable = (s) => /Monthly figures (None of these monthly figures|Metric Figure)/.test(s)
      const otherText = clean(await page.locator('body').innerText())
      const otherScroll = await noSidewaysScroll(page)
      const otherShot = await page.screenshot({ path: path.join(SHOT_DIR, `kpi-weekly-5-email-other-${size.tag}.png`), fullPage: true }).then(() => path.join(SHOT_DIR, `kpi-weekly-5-email-other-${size.tag}.png`))
      await page.goto(`${BASE}/__email/first.html`, { waitUntil: 'domcontentloaded' })
      const firstText = clean(await page.locator('body').innerText())
      const firstScroll = await noSidewaysScroll(page)
      await page.screenshot({ path: path.join(SHOT_DIR, `kpi-weekly-6-email-first-${size.tag}.png`), fullPage: true })
      record(`KW5-${size.tag}`, 'The Monday email, built by lib/kpi-digest.js and never sent: the month table on the first Monday only; no sideways scroll',
        `other Monday "${mails.other.subject}": the weekly table, the one line; first Monday "${mails.first.subject}": the weekly and the month tables`,
        `other: weekly ${weeklyTable(otherText)}, the line ${otherText.includes("Monthly figures come in the first Monday's email of each month.")}, month ${monthTable(otherText)}, scroll ${JSON.stringify(otherScroll)}; first: weekly ${weeklyTable(firstText)}, the line ${firstText.includes('Monthly figures come in')}, month ${monthTable(firstText)}, scroll ${JSON.stringify(firstScroll)}`,
        weeklyTable(otherText) && otherText.includes("Monthly figures come in the first Monday's email of each month.") && !monthTable(otherText)
          && weeklyTable(firstText) && monthTable(firstText) && !firstText.includes('Monthly figures come in')
          && otherScroll.page && firstScroll.page,
        otherShot)
    } finally {
      await judgeConsole(`KWx-email-${size.tag}`, issues)
      await ctx.close()
    }
  }
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use: set E2E_PORT to a free one`)
  const server = http.createServer(serve)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if ([3000, 5173, 3901].includes(PORT)) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  fs.mkdirSync(DIGEST_DIR, { recursive: true, mode: 0o700 })
  console.log(`kpi-weekly-screen: serving ${DIST} on ${BASE} (made-up data; no server.js process)`)
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const [name, fn] of [['desktop', () => desktopRun(browser)], ['phone', () => phoneRun(browser)], ['email', () => emailRun(browser)]]) {
      try { await fn() } catch (e) { record(`KW!-${name}`, `${name} run aborted`, 'no abort', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    const others = writes.filter((x) => !(x.method === 'PUT' && x.path === '/api/admin/kpis/approvals/revenue'))
    record('KWy', 'No write but the one approval', 'no other POST, PUT, PATCH or DELETE', JSON.stringify(others), others.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
  }
  const resultsFile = path.join(paths.workDir(), 'results-kpi-weekly-screen.md')
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# KPI weekly check (made-up data, weekly figures on)', '',
    `Build: ${DIST}. ${new Date().toISOString()}. Emails (never sent): ${DIGEST_DIR}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`kpi-weekly-screen: ${passed}/${rows.length} PASS; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`kpi-weekly-screen: aborted: ${e.stack || e}`)
  process.exit(1)
})
