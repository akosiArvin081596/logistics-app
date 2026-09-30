#!/usr/bin/env node
// LogisX — truck-fixes end-to-end QA run, driven through the REAL UI with Playwright.
//
// Covers three fixes:
//   1. Truck photos (and drivers' CDL / medical-card files) are stored and served
//      only as what their bytes prove they are.
//   2. Truck cost fields refuse non-finite amounts ("Infinity", 1e999, negatives,
//      > 1,000,000) with 400 INVALID_AMOUNT.
//   3. Cost edits write an `update_truck_costs` audit line.
// Round 2 (steps R1-R9, the #393 follow-ups; every step above stays as a regression check):
//   R1 Edit Truck survives a list refresh  · R2 a refused save keeps the input
//   R3 CDL/medical PDFs are served as attachment; images stay inline (planted)
//   R4 stored photos are normalized to what their bytes are · R5 photo limits 16 MP / 2 MiB
//   R6 admin fee 0-100 (blank = 50) · R7 fuel tank <= 500 gal, avg MPG <= 20 (API + Edit form)
//   R8 an Investor's add ignores the fuel pair · R9 the create_truck audit names tank + MPG
// Round 3 (R12-R16): the unused driver-files route answers no files · hexadecimal
//   amounts are refused · unit numbers with control characters are refused · the
//   driver's "has a photo" follows the stored bytes (planted) · two renames to case
//   variants of one unit number at the same moment leave one truck with it (local only)
// Sign-out / sign-in section (S1-S7; runnable alone with ONLY=signout):
//   S1 sign-out (the sidebar's, the driver app's) ends with a full page load of /login
//   S2 a DIFFERENT person signing in after an expired session gets a full page load
//      of their home; the SAME person again keeps in-app navigation (the control)
//   S3 the visible residue: the Dispatcher's dashboard while its own fetch is in flight
//   S4 sign-out with no network, and while the server is down, ends on the app's own
//      login form · S5 another tab follows a sign-out (S5a), leaves for a clean /login
//      when the session ends without one (S5b), and reloads as the different person
//      another tab signed in (S5c)
//   S6 /login after a confirmed sign-out renders without a session round-trip
//   S7 a second tap on Sign In sends no second sign-in
// Dispatcher data section (D1-D3; ONLY=dispatcher): the Dispatcher's copies of the
//   dashboard and of one load carry no broker/contact values; the sheet reader
//   (GET /api/data) is Super Admin only
// Maintenance notice section (M1; ONLY=maintenance, local, server booted with the
//   notice on): a dismissal in one tab belongs to the person who dismissed it
// Money-path section (P1, E1, N1, N1b, F1, E2, B1, RC1; ONLY=moneypath):
//   P1 clearing a fixed-pay driver's daily rate (emptied, or typed 0) in the Drivers
//      Database stores 0, and leaves the inactive pay type's value alone
//   E1 a driver's new expense carries the unit and owner of the truck whose
//      assigned_driver holds a spacing variant of their name (planted, local)
//   N1 a rename on the Users page also moves the rows stored under a spacing
//      variant of the old name (planted, local)
//   N1b re-spelling an account onto its own directory row's spacing (the space
//      doubled) on the Users page saves; it is not refused as a merge (planted, local)
//   F1 an Active Loads edit writes only the changed cell, so formula cells survive
//      (local only: it edits the local non-production sheet, then restores it)
//   E2 a Fuel expense stored under a percentage-paid driver's name with its space
//      doubled is deducted from their pay on the Financials page (planted, local)
//   B1 the startup expense backfill stamps the truck onto an expense whose driver
//      is a spacing variant of the name its truck assignment carries (planted
//      BEFORE boot with plant-before-boot.cjs, local)
//   RC1 a rate-con import onto a load whose Payments Table row already exists
//      writes only the cells that change: text cells stay text (local only: it
//      writes the local non-production sheet, then restores it)
// Names section (K1, K2, K3; ONLY=names, local only):
//   K1 a driver name that reads as a built-in property name is refused at
//      dispatch (400 DRIVER_NAME_RESERVED), and nothing is written to the load
//   K2 the same name stored on a completed load leaves the dashboard and
//      Financials working (200) and other drivers' figures unchanged; totals
//      stay intact
//   K3 for a non-Super-Admin, a changed cell the sheet would store as a formula
//      is refused (400 FORMULA_NOT_ALLOWED), while a plain signed number is kept
//
// ELD-link section (L1, L2, L3; ONLY=eldlink):
//   L1 a truck added this month, with no load in any finalized month, links to an
//      ELD device from the Trucks page (it used to be refused over every
//      finalized month — LogisX-#23, 2026-09-28)
//   L2 the same truck unlinks from the Trucks page
//   L3 local only (DB_PATH): a linked truck whose own Job Tracking loads reach a
//      finalized month is still refused (409 PERIOD_FINALIZED), naming only the
//      finalized months those loads reach
//
// Invoice editor section (I1-I9; ONLY=invoice): the draft invoice editor
// (Dashboard → Completed → a delivered load → Draft Invoice Email)
//   I1 the editor opens; the load's Job Tracking row is read before any edit
//   I2-I3 ORDER # takes any printable character but < and >, 80 max, and the
//      server-built SUBJECT carries it as typed (a literal &, never &amp;)
//   I4-I6 an optional NOTES box prints in a labelled "Notes" box beside the totals on
//      the invoice PDF only when it is non-empty; clearing it or Reset leaves no box
//   I7 Approve sends the note and the Order #; Job Tracking is unchanged; I7r when
//      the server has no mail target (preview:true) the load dialog does not say
//      "Draft ready in Gmail" and says no Gmail draft was created
//   I8 local only (DB_PATH): a note saved on the approved draft record pre-fills the
//      next editor and its dryRun PDF, and a preview sent with no notes key prints it
//      (I8b); the pre-filled note is labelled "carried over" until it is typed into
//      (I8h) · I9 the server refuses a bad note or Order #
//
// Investor terms section (T0-T11; ONLY=terms, STEPS picks steps):
//   T0 (no sign-in, no creds file needed): two test investors (QA-TEST Investor
//   A / B) fill /invest in fresh anonymous contexts, open the Master Participation
//   & Management Agreement and the Commercial Vehicle Lease on the signature page,
//   sign all three documents, and open both again from the review modal ("Signed —
//   View Document"). Every preview PDF is read: the default 50/50 terms, no
//   AMENDMENT, and the same §3.3 / §2.01 wording for A and B. The application is
//   NEVER submitted (every write but the preview route is blocked in the page; the
//   read-only POST /api/public/investor-w9-check passes and is listed as a non-write).
//   T1-T11 (per-investor payment terms; the Super Admin and one throwaway test
//   Investor sign in): T1/T2 the Super Admin creates a split and a lease invite on
//   /investors · T3-T5 an anonymous applicant opens each link: read-only terms,
//   the amendment in the preview PDFs, the page never sends terms · T6 plain
//   /invest is today's contract · T7 terms cannot be changed through the API ·
//   T8 the lease application is submitted and the invite is used (local, or
//   E2E_TERMS_SUBMIT=1) · T9 a revoke stops a tab mid-flow · T10 the investor
//   detail modal survives a list refresh · T11 an edit mid-flow clears the
//   signatures · Tc revokes, deletes and hard-deletes what the run made
// Investor-fixes section (F1-F14; ONLY=investorfixes, local only, DB_PATH): every
//   actor is a QA-TEST investor, application or record this run creates and deletes
//   again; no real investor is signed in as, edited or uploaded for
//   F1 an Investor's config write names only their own account (403 when it names any);
//      an admin write without an ownerId is refused (400 OWNER_ID_REQUIRED); an admin
//      split change writes an audit row · F2 a legal document is deleted, and uploaded
//      against an investor or truck, only by its owner · F3 the admin fund and fuel
//      targets read the global config, not an investor's own row (planted)
//   F4 the investor detail modal survives an investors:changed refresh · F5 a record
//      with no application says so · F6 an acceptance that would take another
//      record's company name is refused with a code and the application is not left
//      Accepted; one whose email is already an Investor account's is Accepted and
//      creates nothing (200 accountCreated:false, audited); one whose email is another
//      role's account (a throwaway QA-TEST Driver) is refused 409 USER_ALREADY_EXISTS
//      and writes nothing · F7 "Accepted" asks first; a
//      refused acceptance puts the select back and shows the server's reason; a
//      removed application's status change is refused; an acceptance over an
//      existing account shows the server's message on the page · F8 a duplicate investor record
//      answers 409 with a code · F9 a preview of a user id that is no investor
//      renders a "not found" card, no portal (the API answers 404)
//   F10 Admin Tools shows the stored global split; the investor's "Your share" note
//      shows the split the server uses (planted) · F11 the applicant help text makes no
//      "encrypted at rest" / "update any time from your dashboard" claim · F12 the
//      account-number eye does not pretend to reveal; "Docs x/N" counts the real
//      documents (planted); a refused delete shows the server's reason · F13 the
//      /invest thank-you keeps the name after a reload · F14 the public onboarding
//      banking route is gone (404 whatever token is sent) and an accepted
//      application's bank row unchanged · FXc every failing resource, marked as the
//      run's own probe or the app's
//
// Env:
//   BASE_URL    required — e.g. http://127.0.0.1:3181 (never production)
//   PHASE       before | after            (default: before) — names the output
//   HEADED=1    visible browser, slowMo 350 ms, ~1400x900 window, captions pause
//   DB_PATH     the server's database copy (inside the work dir), ONLY used to plant
//               stored values for the serve-side cases (steps 10, 11b-f, R3, R15),
//               to stage and clean up R16, to plant and read back E1, N1, N1b, E2
//               and B1 (and P1's own driver), to delete the rows RC1's import
//               writes, to plant (and delete) I8's saved invoice note, and to let T8
//               submit a test application and hard-delete it by id. Unset -> those
//               cases are SKIPPED (P1 then uses a real driver, as on staging).
//   CREDS_FILE  logins JSON (default: <work dir>/creds.json, written by setup-db.cjs)
//   E2E_WORK_DIR  where every output goes (default: $TMPDIR/logisx-e2e; see paths.cjs)
//   APP_DIR     checkout whose node_modules provides better-sqlite3 and puppeteer
//               (default: this checkout once it has installs, else the main checkout)
//   CHROME_PATH Chrome binary (default: the Chrome for Testing the app's puppeteer downloaded)
//   EXTRA=1     also run X1 (pre-existing Edit-modal bug, outside the three fixes)
//   MASK_PII=0  do not mask identity documents in SAVED screenshots (default: masked)
//   SLOWMO, CAPTION_PAUSE_MS   pacing overrides (headed defaults 350 / 1600)
//   OUT_TAG     output name instead of PHASE (rehearsals must not overwrite a baseline)
//   DRIVER_VIEWPORT            driver window size, default 430x900
//   ONLY        a comma-separated list of sections: trucks (1-12, R1-R16), signout
//               (S1-S7), dispatcher (D1-D3), maintenance (M1), moneypath (P1, E1,
//               N1, N1b, F1, E2, B1, RC1), names (K1, K2, K3), eldlink (L1-L3),
//               invoice (I1-I9), terms (T0-T11),
//               investorfixes (F1-F14). Unset = all, in that
//               order. ⚠️ The sections together sign in more often than the login
//               limiter allows one server process (see README), so split a full run.
//   STEPS       only these cases of the sign-out, money-path, invoice and terms
//               sections, e.g. STEPS=S5a,S7 or STEPS=P1,F1 or STEPS=E2,B1,RC1 (P1
//               selects P1a and P1b; N1 selects N1 and N1b) or STEPS=I8,I9 (I1 opens
//               the editor whenever any of I1-I7 is picked) or STEPS=T0 then
//               STEPS=T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11 (a terms step also runs the
//               steps it builds on; T0 and T1-T11 together render more previews
//               than the preview limiter allows one IP in 15 minutes)
//   E2E_TERMS_SUBMIT=1  let T8 submit the lease application on a server that is
//               not local (it writes an application; locally DB_PATH enables it)
//   E2E_INVOICE_APPROVE=1  let I7 press Approve on a server that is not local (it
//               would create a real Gmail draft wherever the server has a mail target)
//   S3_LATENCY_MS, S3_KBPS     the CDP throttle of S3, S6 and S7 (default +2500 ms per
//               request, 24 KB/s)
//
// Output, in the work dir (outside every checkout — the screenshots show real data):
// shots/<OUT_TAG|PHASE>/NN-name.png and results-<OUT_TAG|PHASE>.md.
// See README.md beside this script for setup, boot and teardown.
// Every "Expected" column states the behaviour AFTER the fixes; a BEFORE run is
// expected to FAIL the fix rows — that is the baseline.
import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import paths from './paths.cjs'

const BASE_URL = String(process.env.BASE_URL || '').replace(/\/+$/, '')
const PHASE = String(process.env.PHASE || 'before').toLowerCase()
const HEADED = process.env.HEADED === '1'
// OUT_TAG renames the output (shots/<tag>/, results-<tag>.md) without changing
// the phase semantics — e.g. a timing rehearsal that must not overwrite a baseline.
const OUT_TAG = String(process.env.OUT_TAG || PHASE).replace(/[^\w.-]/g, '')
const PAUSE = Number(process.env.CAPTION_PAUSE_MS ?? (HEADED ? 1600 : 0))
const SLOWMO = Number(process.env.SLOWMO ?? (HEADED ? 350 : 0))
const [DVW, DVH] = String(process.env.DRIVER_VIEWPORT || '430x900').split('x').map(Number)
// ONLY picks sections, e.g. ONLY=signout or ONLY=trucks,dispatcher. Unset = all.
const ONLY = String(process.env.ONLY || '').toLowerCase()
const ALL_SECTIONS = ['trucks', 'signout', 'dispatcher', 'maintenance', 'moneypath', 'names', 'eldlink', 'invoice', 'terms', 'investorfixes']
// Sign-ins (POST /api/auth/login) each section makes; the limiter allows 20 per 15
// minutes per server process. The sign-out section's figure is its worst case: S4a's
// second half runs, and the build sends S7's second sign-in (one fewer for each
// that does not happen). The money path signs the Super Admin in once (P1, N1, F1,
// E2, B1 and RC1 share the page) and the driver once (E1), plus the Super Admin once
// more when E1 has to file on the driver's behalf.
// The names section signs the Dispatcher in once (K1 and K3 share the page) and
// the Super Admin once (K2 reads the dashboard and Financials). The invoice section
// signs the Super Admin in once; every step shares that page. The investor-fixes
// section signs in the Super Admin and its own two QA-TEST investors, once each. The terms section's T0
// signs nobody in (/invest is public, and it redirects a signed-in user); T1-T11
// sign the Super Admin in once and T7's throwaway test Investor once.
const SIGN_INS = { trucks: 3, signout: 20, dispatcher: 2, maintenance: 3, moneypath: 3, names: 2, eldlink: 1, invoice: 1, terms: 2, investorfixes: 3 }
// Sections that need no login at all, so they run without a creds file (e.g. on
// staging, where no staging logins need to exist for them). The terms section is
// one only while STEPS picks T0 alone (see TERMS_NEEDS_LOGIN).
const NO_LOGIN_SECTIONS = new Set(['terms'])

function die(msg) { console.error(`e2e: ${msg}`); process.exit(2) }
if (!BASE_URL) die('BASE_URL is required')
if (!['before', 'after'].includes(PHASE)) die('PHASE must be before or after')
const SECTIONS = new Set(ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : ALL_SECTIONS)
for (const s of SECTIONS) if (!ALL_SECTIONS.includes(s)) die(`ONLY takes a comma-separated list of ${ALL_SECTIONS.join(', ')}; got "${s}"`)
const runs = (s) => SECTIONS.has(s)
// STEPS: only these cases of the sign-out section (e.g. STEPS=S5a,S7), to rerun a
// timing-sensitive case without spending the login limiter on the rest. Each of
// those cases has its own browser context, so any subset runs on its own. The
// money-path section takes it too (e.g. STEPS=P1,F1), and so does the invoice section
// (e.g. STEPS=I8,I9), and the terms section (TERMS_PLAN below); the other sections
// ignore it.
const STEPS = process.env.STEPS ? new Set(String(process.env.STEPS).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null
const wantStep = (id) => !STEPS || STEPS.has(id.toUpperCase())
// The terms section's steps. A step picked with STEPS also runs the steps it builds
// on (their rows are recorded too): T3 and T9 use T1's split invite, T4 and T7 T2's
// lease invite, T5 continues T4's tab and T8 submits T5's application.
const TERMS_STEP_IDS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11']
const TERMS_DEPS = { T3: ['T1'], T9: ['T1'], T4: ['T2'], T5: ['T4'], T7: ['T2'], T8: ['T5'] }
// Renders of POST /api/public/investor-preview-pdf each step makes; the route allows
// 30 per 15 minutes per IP. T0: two investors × (3 opens + 3 re-renders after
// signing + 2 from the review). T4: master and lease, open + sign. T5: the W-9 open +
// sign, the master from the review. T6: master open + sign, lease open. T11: master
// open + sign, the lease open, and the re-render the page may send once it has
// reloaded the edited terms.
const TERMS_PREVIEWS = { T0: 16, T3: 1, T4: 4, T5: 3, T6: 3, T7: 1, T9: 1, T11: 4 }
const TERMS_PLAN = (() => {
  const plan = new Set(TERMS_STEP_IDS.filter((id) => !STEPS || STEPS.has(id)))
  for (let grew = true; grew;) {
    grew = false
    for (const id of [...plan]) for (const dep of TERMS_DEPS[id] || []) if (!plan.has(dep)) { plan.add(dep); grew = true }
  }
  return runs('terms') ? plan : new Set()
})()
const TERMS_NEEDS_LOGIN = [...TERMS_PLAN].some((id) => id !== 'T0')
let baseHost = ''
try { baseHost = new URL(BASE_URL).hostname.replace(/\.+$/, '') } catch { die(`BASE_URL is not a URL: ${BASE_URL}`) }
if (/(^|\.)app\.logisx\.com$/i.test(baseHost)) die('refusing to run against production')
// A server on this machine (M1 runs only here: the notice is off on staging).
const LOCAL = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(baseHost)
{
  const renders = [...TERMS_PLAN].reduce((n, id) => n + (TERMS_PREVIEWS[id] || 0), 0)
  if (renders > 30) {
    console.warn(`e2e: WARNING: the terms steps picked render about ${renders} previews, and POST /api/public/investor-preview-pdf ` +
      'allows 30 per 15 minutes per IP. Expect 429s late in the run: run STEPS=T0, then STEPS=T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11 ' +
      'on a fresh server process (on staging, 15 minutes later).')
  }
}
{
  const planned = [...SECTIONS].reduce((n, s) => n + (s === 'terms' && !TERMS_NEEDS_LOGIN ? 0 : SIGN_INS[s]), 0)
  if (planned > 20) {
    console.warn(`e2e: WARNING: these sections sign in up to ${planned} times, and POST /api/auth/login allows 20 per 15 minutes ` +
      'per server process. Expect 429s late in the run: split it with ONLY and restart the server between the parts.')
  }
}

let WORK, DB_PATH, CHROME
try {
  WORK = paths.workDir()
  DB_PATH = process.env.DB_PATH ? paths.workFile(process.env.DB_PATH) : ''
  CHROME = await paths.chromePath()
} catch (e) { die(e.message) }
if (DB_PATH) paths.warnNodeVersion('e2e')
const CREDS_FILE = process.env.CREDS_FILE || path.join(WORK, 'creds.json')
const SHOTS = path.join(WORK, 'shots', OUT_TAG)
const RESULTS = path.join(WORK, `results-${OUT_TAG}.md`)
const JOURNAL = path.join(WORK, 'plant-journal.json')
if (fs.existsSync(JOURNAL)) {
  die(`${JOURNAL} exists: a previous run died while a planted value was in the DB. ` +
    'Recreate the scratch DB (node scripts/e2e/setup-db.cjs <db> --force), then delete the journal.')
}
const NEEDS_CREDS = [...SECTIONS].some((s) => !NO_LOGIN_SECTIONS.has(s)) || TERMS_NEEDS_LOGIN
if (NEEDS_CREDS && !fs.existsSync(CREDS_FILE)) die(`no creds file at ${CREDS_FILE} (make one with scripts/e2e/setup-db.cjs, or set CREDS_FILE)`)
// Only the login-free sections (terms with STEPS=T0) may run without one; they never read it.
const CREDS = fs.existsSync(CREDS_FILE) ? JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) : {}
fs.mkdirSync(SHOTS, { recursive: true })
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f))

// ---------------------------------------------------------------- results
const rows = []
const meta = { startedAt: new Date().toISOString(), baseUrl: BASE_URL, phase: PHASE, headed: HEADED, ids: {} }
// Control and bidirectional-override characters (R14 sends some) are written as
// \uXXXX, so no observed text can reorder or hide a line of the results.
const visible = (s) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
  (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
const cell = (s) => visible(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
function writeResults(final = false) {
  const counts = rows.reduce((a, r) => { const k = r.verdict.split(' ')[0]; a[k] = (a[k] || 0) + 1; return a }, {})
  const title = 'LogisX E2E — ' + [
    runs('trucks') && 'trucks (steps 1-12, R1-R16)',
    runs('signout') && 'sign-out / sign-in (S1-S7)',
    runs('dispatcher') && 'Dispatcher data (D1-D3)',
    runs('maintenance') && 'maintenance notice (M1)',
    runs('moneypath') && 'money path (P1, E1, N1, N1b, F1, E2, B1, RC1)',
    runs('names') && 'names (K1, K2, K3)',
    runs('eldlink') && 'ELD link (L1-L3)',
    runs('invoice') && 'invoice editor (I1-I9)',
    runs('terms') && `investor terms (${[...TERMS_PLAN].join(', ') || 'no step picked'})`,
    runs('investorfixes') && 'investor fixes (F1-F14)',
  ].filter(Boolean).join(' + ')
  const lines = [
    `# ${title} — ${PHASE.toUpperCase()}`,
    '',
    `- Base URL: \`${BASE_URL}\``,
    `- Started: ${meta.startedAt}${final ? ` · finished ${new Date().toISOString()}` : ' · (in progress)'}`,
    `- Browser: Chrome for Testing via playwright-core, ${HEADED ? 'headed' : 'headless'}, slowMo ${SLOWMO} ms, caption pause ${PAUSE} ms`,
    `- Discovered ids: ${Object.entries(meta.ids).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    `- Verdicts are judged against the AFTER-the-fix expectation. Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    '',
    '| Step | What | Expected (after the fix) | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${cell(r.verdict)} | ${r.shot ? `[${cell(path.basename(r.shot))}](${cell(r.shot)})` : ''} |`),
    '',
  ]
  fs.writeFileSync(RESULTS, lines.join('\n'))
}
function record(r) {
  rows.push(r)
  console.log(`[${r.verdict.padEnd(4)}] ${r.step} ${r.title} — ${visible(r.observed).replace(/\n/g, ' ')}`)
  writeResults()
}
const verdict = (ok) => (ok ? 'PASS' : 'FAIL')

// ---------------------------------------------------------------- fixtures
const b64 = (s) => Buffer.from(s).toString('base64')
const HTML_DOC = '<h1>not an image</h1>'
const SVG_DOC = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="38" font-size="24">not a photo</text></svg>'

function makePdf() {
  // Minimal, valid one-page PDF (correct xref offsets), inert text only.
  const content = 'BT /F1 18 Tf 20 45 Td (QA PDF) Tj ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
const PDF_BYTES = makePdf()

// PNG chunk CRC (IEEE), so the fixtures below are well-formed PNGs.
function crc32(buf) {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// R5b: a minimal PNG (signature + IHDR + IEND, no pixel data) whose IHDR
// declares w×h. Its header is all a size check reads.
function makePngHeader(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit truecolour; compression/filter/interlace 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IEND', Buffer.alloc(0))])
}
// R5a: a JPEG with a valid header walk (SOI, APP0 JFIF, SOF0 w×h) padded with
// COM segments to at least `targetBytes`, then EOI. Small in pixels, large in bytes.
function makePaddedJpeg(targetBytes, w = 640, h = 480) {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  ]
  let size = parts.reduce((a, b) => a + b.length, 0)
  while (size < targetBytes) {
    const n = Math.min(65533, Math.max(1, targetBytes - size))
    const seg = Buffer.alloc(4 + n, 0x20)
    seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(n + 2, 2)
    parts.push(seg); size += seg.length
  }
  parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

async function makeImages(ctx) {
  // Genuine JPEG / PNG bytes, encoded by the browser's own canvas.
  const p = await ctx.newPage()
  const out = await p.evaluate(() => {
    const draw = (label, a, b) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200
      const g = c.getContext('2d')
      const grd = g.createLinearGradient(0, 0, 320, 200); grd.addColorStop(0, a); grd.addColorStop(1, b)
      g.fillStyle = grd; g.fillRect(0, 0, 320, 200)
      g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.fillText(label, 34, 112)
      return c
    }
    return {
      jpeg: draw('QA TRUCK JPG', '#7c3aed', '#06b6d4').toDataURL('image/jpeg', 0.9),
      png: draw('QA TRUCK PNG', '#0f766e', '#a21caf').toDataURL('image/png'),
    }
  })
  await p.close()
  return { jpeg: Buffer.from(out.jpeg.split(',')[1], 'base64'), png: Buffer.from(out.png.split(',')[1], 'base64') }
}

// ---------------------------------------------------------------- page helpers
// `pause` false: for a timing-critical moment (S3), where the headed pause would
// let the evidence finish before the screenshot.
async function caption(page, text, pause = true) {
  try {
    await page.evaluate((t) => {
      const id = '__qa_caption__'
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        // CSSOM, not a style attribute, so a strict style-src CSP cannot strip it.
        Object.assign(el.style, {
          position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647',
          background: 'rgba(12,12,20,0.93)', color: '#fff', padding: '8px 14px',
          font: '600 15px/1.4 -apple-system, system-ui, sans-serif',
          borderBottom: '3px solid #8b5cf6', pointerEvents: 'none', boxShadow: '0 2px 10px rgba(0,0,0,.35)',
        })
        ;(document.body || document.documentElement).appendChild(el)
      }
      el.textContent = t
      // A raw document (JSON viewer, an image, served HTML) has no SPA shell:
      // push its content below the bar so the evidence is not hidden under it.
      if (!document.getElementById('app') && document.body) document.body.style.paddingTop = `${el.offsetHeight + 6}px`
    }, `[${PHASE.toUpperCase()}] ${text}`)
  } catch { /* mid-navigation — best effort */ }
  if (PAUSE && pause) await page.waitForTimeout(PAUSE)
}

// MASK_PII (default on): identity documents are masked in the SAVED screenshot
// only — the live (headed) page still shows them, and the verdict comes from
// the network response + an in-page decode, not from pixels.
const MASK_PII = process.env.MASK_PII !== '0'
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`)
  const mask = MASK_PII && opts.mask ? opts.mask : undefined
  try { await page.screenshot({ path: file, fullPage: !!opts.fullPage, mask, maskColor: '#6b21a8' }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return path.relative(WORK, file)
}
async function centerOn(scope, selectors) {
  await scope.evaluate((root, sels) => {
    for (const s of sels) { const el = root.querySelector(s); if (el) { el.scrollIntoView({ block: 'center' }); return } }
  }, selectors).catch(() => {})
}

// fetch() from INSIDE the signed-in page (its cookies, its origin), with the
// header the CSRF rule requires on writes.
//
// While `apiProbeTag` is set (only the investor-fixes section sets it: the id of
// the step, or FX0/FX1/FXz), every such fetch also carries `X-QA-Probe: <tag>`.
// The server ignores it; the section's response listener reads it, so a failing
// response the run sent on purpose is told apart from one the app itself sent.
let apiProbeTag = null
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body, tag }) => {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(tag ? { 'X-QA-Probe': tag } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, contentType: res.headers.get('content-type') || '', json, text: json ? '' : text.slice(0, 200) }
  }, { method, url, body, tag: apiProbeTag })
}

// Navigate the tab itself to a URL and report what the browser received.
async function navigate(page, url) {
  let resp
  try {
    resp = await page.goto(`${BASE_URL}${url}`, { waitUntil: 'load' })
  } catch (e) {
    // Headless Chrome hands a PDF (or any attachment) to the download manager,
    // and goto() throws. Read what the server said with an in-page fetch instead.
    if (!/download is starting|ERR_ABORTED/i.test(e.message)) throw e
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'same-origin' })
      return { status: res.status, ct: res.headers.get('content-type') || '' }
    }, url)
    return { status: r.status, contentType: r.ct, isJson: /json/i.test(r.ct), bodyHead: '', download: true }
  }
  let bodyHead = ''
  try { bodyHead = (await resp.text()).slice(0, 120) } catch { /* binary / unavailable */ }
  const ct = resp.headers()['content-type'] || ''
  return { status: resp.status(), contentType: ct, isJson: /json/i.test(ct), bodyHead }
}

// Click something that should start a download and return the Download (or
// null). A target=_blank link may start it from a new tab, so downloads from
// any page this context opens meanwhile count too; such tabs are closed again.
async function clickForDownload(ctx, page, locator, timeoutMs = 15000) {
  let resolveDl
  const got = new Promise((r) => { resolveDl = r })
  const popups = []
  const onDl = (d) => resolveDl(d)
  const onPage = (p) => { popups.push(p); p.on('download', onDl) }
  page.on('download', onDl)
  ctx.on('page', onPage)
  try {
    await locator.click()
    return await Promise.race([got, new Promise((r) => setTimeout(() => r(null), timeoutMs))])
  } finally {
    page.off('download', onDl)
    ctx.off('page', onPage)
    for (const p of popups) await p.close().catch(() => {})
  }
}

async function toastText(page, ms = 2500) {
  try {
    const t = page.locator('.toast-container .toast.show')
    await t.waitFor({ state: 'visible', timeout: ms })
    return (await t.innerText()).trim()
  } catch { return '' }
}

// Label → its input, in both the Add form (.form-group) and the Edit modal (.edit-field).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exactText = (s) => new RegExp(`^\\s*${escRe(s)}\\s*$`)
function field(scope, labelText) {
  return scope.locator('.form-group, .edit-field').filter({ has: scope.page().locator('label', { hasText: exactText(labelText) }) }).locator('input, select, textarea').first()
}
// A Trucks-table row by its EXACT unit number. `hasText` alone is a substring
// match, and the round-2 trucks (<UNIT>-B, <UNIT>-R9) contain the test unit.
function rowOf(page, unit) {
  return page.locator('table.truck-table tbody tr', { has: page.locator('td.unit-number', { hasText: exactText(unit) }) })
}

async function login(page, who, username, password, homePath) {
  await page.goto(`${BASE_URL}/login`)
  const form = page.locator('form.login-form')
  await form.waitFor({ state: 'visible', timeout: 30000 })
  await caption(page, `${who} signs in`)
  await form.locator('input[autocomplete="username"]').fill(username)
  await form.locator('input[autocomplete="current-password"]').fill(password)
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST', { timeout: 30000 }),
    form.locator('button[type="submit"]').click(),
  ])
  if (resp.status() !== 200) throw new Error(`${who} login answered ${resp.status()}`)
  await page.waitForURL((u) => u.pathname.startsWith(homePath), { timeout: 45000 })
}

async function getTruck(page, id) {
  const r = await api(page, 'GET', '/api/trucks')
  return (r.json?.trucks || []).find((t) => String(t.id) === String(id)) || null
}

const costsOf = (t) => t ? `ins=${t.InsuranceMonthly} eld=${t.EldMonthly} pay=${t.TruckPaymentMonthly} hvut=${t.HvutAnnual} irp=${t.IrpAnnual}` : '(truck missing)'
const photoHead = (t) => (t && typeof t.Photo === 'string' ? (t.Photo.slice(0, 30) + (t.Photo.length > 30 ? '…' : '')) : String(t?.Photo))

// ---------------------------------------------------------------- DB planting (scratch only)
let db = null
const skipWhy = () => (DB_PATH
  ? 'SKIPPED — DB_PATH is not the server\'s database (see 10*); nothing was planted'
  : 'SKIPPED — no DB_PATH (stored values cannot be planted against this server)')
// E1 plants trucks.assigned_driver (a spacing variant of the driver's own name); E2
// switches a fixed-pay driver's directory row to percentage pay for its step.
// L3 only ever writes routemate_vehicle_id back to the value it read, and only if
// the refusal under test failed to happen.
const PLANT_COLUMNS = { trucks: ['photo', 'assigned_driver', 'routemate_vehicle_id'], job_applications: ['cdl_front'], drivers_directory: ['pay_type', 'pay_percentage'] }
function openDb() {
  if (!DB_PATH) return null
  const Database = paths.appRequire('better-sqlite3')
  const d = new Database(DB_PATH, { fileMustExist: true })
  d.pragma('busy_timeout = 5000')
  return d
}
function readCol(table, col, id) {
  if (!PLANT_COLUMNS[table]?.includes(col)) throw new Error('column not allowed')
  return db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id)?.v
}
function writeCol(table, col, id, value) {
  if (!PLANT_COLUMNS[table]?.includes(col)) throw new Error('column not allowed')
  const r = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(value, id)
  if (r.changes !== 1) throw new Error(`plant ${table}.${col}#${id}: ${r.changes} rows`)
}
// Originals live in memory only (no PII on disk); the journal holds ids, not values.
const originals = new Map()
// Rows the money-path section INSERTs (or has the app create) and deletes again,
// by table and id; F1's planted sheet cell and RC1's sheet rows by address. Ids and
// addresses only.
const createdRows = []
const sheetPlants = []
// The investor-fixes section's own rows (QA-TEST users, investor records, trucks,
// applications and their children, legal documents, planted investor_config rows),
// by table and id (investor_config by owner and key). Ids only, never values.
const ifxRows = []
const ifxUserIds = new Set() // every QA-TEST account id the section recorded, kept after its row is gone
function writeJournal() {
  if (!originals.size && !createdRows.length && !sheetPlants.length && !ifxRows.length) {
    if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL)
    return
  }
  fs.writeFileSync(JOURNAL, JSON.stringify([
    ...[...originals.values()].map(({ table, col, id }) => ({ table, col, id })),
    ...createdRows.map(({ table, id }) => ({ table, id, created: true })),
    ...sheetPlants.map(({ range, what }) => ({ sheet: range, planted: what || 'formula (clear this cell by hand if the run died)' })),
    ...ifxRows.map(({ table, id, owner, key }) => ({ table, ...(id != null ? { id } : { owner, key }), created: true, section: 'investorfixes' })),
  ], null, 2))
}
function plant(table, col, id, value) {
  const key = `${table}.${col}#${id}`
  if (!originals.has(key)) {
    originals.set(key, { table, col, id, value: readCol(table, col, id) })
    writeJournal()
  }
  writeCol(table, col, id, value)
}
function restoreAll() {
  const out = []
  for (const [key, o] of originals) {
    writeCol(o.table, o.col, o.id, o.value)
    out.push(`${key} ${readCol(o.table, o.col, o.id) === o.value ? 'restored' : 'RESTORE MISMATCH'}`)
    originals.delete(key)
  }
  writeJournal()
  return out
}
// The tables a money-path row (or I8's saved invoice note) may be created in; names
// are literals, never input.
const CREATED_TABLES = new Set(['drivers_directory', 'expenses', 'truck_assignments', 'invoices', 'users', 'load_invoice_drafts'])
function noteCreated(table, id) {
  if (!CREATED_TABLES.has(table)) throw new Error('table not allowed')
  createdRows.push({ table, id: Number(id) })
  writeJournal()
}
// Deletes, by id, exactly the rows noteCreated() recorded (newest first).
function removeCreated() {
  const out = []
  const failed = []
  while (createdRows.length) {
    const r = createdRows.pop()
    try {
      const n = db.prepare(`DELETE FROM ${r.table} WHERE id = ?`).run(r.id).changes
      out.push(`${r.table}#${r.id} ${n === 1 ? 'deleted' : 'already gone'}`)
    } catch (e) {
      failed.push(r)
      out.push(`${r.table}#${r.id} delete error: ${e.message}`)
    }
  }
  createdRows.push(...failed) // kept in the journal
  writeJournal()
  return out
}
function forgetCreated(table, id) {
  const i = createdRows.findIndex((r) => r.table === table && r.id === Number(id))
  if (i >= 0) createdRows.splice(i, 1)
  writeJournal()
}
// R16 assigns two throwaway drivers (QA-TEST-DRV-<stamp>-A / -B) to two of its own
// test trucks, which writes truck_assignments and drivers_directory rows. They are
// deleted by exact name, and only names with this prefix: no real driver's rows are
// touched. A truck with an assignment row cannot be deleted (409 TRUCK_REFERENCED),
// so this runs before those trucks are deleted. Local only (DB_PATH).
const QA_DRIVER_PREFIX = 'QA-TEST-DRV-'
function removeQaDriverRows(names) {
  const out = { truck_assignments: 0, drivers_directory: 0 }
  for (const n of names) {
    if (!String(n).startsWith(QA_DRIVER_PREFIX)) throw new Error('refusing to delete rows of a driver name without the QA prefix')
    out.truck_assignments += db.prepare('DELETE FROM truck_assignments WHERE driver_name = ?').run(n).changes
    out.drivers_directory += db.prepare('DELETE FROM drivers_directory WHERE driver_name = ?').run(n).changes
  }
  return out
}
// Rows an earlier aborted run left behind (the same prefix, any stamp).
function removeLeftoverQaDriverRows() {
  const like = `${QA_DRIVER_PREFIX}%`
  return {
    truck_assignments: db.prepare('DELETE FROM truck_assignments WHERE driver_name LIKE ?').run(like).changes,
    drivers_directory: db.prepare('DELETE FROM drivers_directory WHERE driver_name LIKE ?').run(like).changes,
  }
}
process.on('SIGINT', () => {
  try { if (db) restoreAll() } catch { /* ignore */ }
  try { if (db) removeCreated() } catch { /* ignore */ }
  try { if (db && ifxRows.length) ifxRemoveRowsSync() } catch { /* ignore */ }
  // A planted sheet cell cannot be put back synchronously: the journal keeps its address.
  process.exit(130)
})

// ---------------------------------------------------------------- the run
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const UNIT = `QA-TEST-${stamp}`
const INV_UNIT = `QA-TEST-INV-${stamp}` // R8: the truck the Investor adds
const created = new Set() // every truck id this run created
let browser, adminCtx, driverCtx, investorCtx, admin, driver
let truckId = null
let settleTrucks = async () => {}

async function main() {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADED,
    slowMo: SLOWMO,
    args: HEADED ? ['--window-size=1400,900'] : [],
  })
  // Independent blocks: a failure in one is recorded and the others still run.
  if (runs('trucks')) {
    try { await truckSteps() } catch (e) {
      exitCode = 1
      record({ step: '!', title: 'Run aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('signout')) {
    try { await signoutSection() } catch (e) {
      exitCode = 1
      record({ step: 'S!', title: 'Sign-out section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('dispatcher')) {
    try { await dispatcherSection() } catch (e) {
      exitCode = 1
      record({ step: 'D!', title: 'Dispatcher data section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('maintenance')) {
    try { await maintenanceSection() } catch (e) {
      exitCode = 1
      record({ step: 'M!', title: 'Maintenance notice section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('moneypath')) {
    try { await moneyPathSection() } catch (e) {
      exitCode = 1
      record({ step: 'MP!', title: 'Money-path section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('names')) {
    try { await namesSection() } catch (e) {
      exitCode = 1
      record({ step: 'K!', title: 'Names section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('eldlink')) {
    try { await eldLinkSection() } catch (e) {
      exitCode = 1
      record({ step: 'L!', title: 'ELD-link section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('invoice')) {
    try { await invoiceSection() } catch (e) {
      exitCode = 1
      record({ step: 'I!', title: 'Invoice editor section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('terms')) {
    try { await termsSection() } catch (e) {
      exitCode = 1
      record({ step: 'T!', title: 'Investor terms section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (runs('investorfixes')) {
    try { await investorFixesSection() } catch (e) {
      exitCode = 1
      record({ step: 'F!', title: 'Investor-fixes section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
}

// Steps 1-12 and R1-R10, unchanged (they used to be the body of main()).
async function truckSteps() {
  db = openDb()
  adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  adminCtx.setDefaultTimeout(20000)
  const IMG = await makeImages(adminCtx)
  const JPEG_DATA = `data:image/jpeg;base64,${IMG.jpeg.toString('base64')}`
  const PNG_DATA = `data:image/png;base64,${IMG.png.toString('base64')}`
  const PLANTS = {
    html: { label: 'data:text/html + <h1>not an image</h1>', value: `data:text/html;base64,${b64(HTML_DOC)}` },
    svg: { label: 'data:image/svg+xml + <svg><text>', value: `data:image/svg+xml;base64,${b64(SVG_DOC)}` },
    htmlAsJpeg: { label: 'HTML bytes under a data:image/jpeg label', value: `data:image/jpeg;base64,${b64(HTML_DOC)}` },
    pngAsJpeg: { label: 'real PNG bytes under a data:image/jpeg label', value: `data:image/jpeg;base64,${IMG.png.toString('base64')}` },
    malformed: { label: 'malformed value, no comma', value: `data:image/jpeg;base64${IMG.png.toString('base64').slice(0, 48)}` },
    pdf: { label: 'real PDF bytes under data:application/pdf', value: `data:application/pdf;base64,${PDF_BYTES.toString('base64')}` },
  }

  admin = await adminCtx.newPage()
  // Track the Trucks page's own GET /api/trucks reloads. TrucksView swaps the
  // whole TruckTable for a skeleton while the store loads, which UNMOUNTS the
  // teleported Edit modal — and a reload fires after every truck write (the
  // store's own, plus the debounced `trucks:changed` socket refresh). So before
  // opening the modal we wait until that traffic has been quiet for a while.
  let trucksInflight = 0
  let trucksLastActivity = 0
  const isTrucksGet = (r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/trucks'
  admin.on('request', (r) => { if (isTrucksGet(r)) { trucksInflight++; trucksLastActivity = Date.now() } })
  const done = (r) => { if (isTrucksGet(r)) { trucksInflight = Math.max(0, trucksInflight - 1); trucksLastActivity = Date.now() } }
  admin.on('requestfinished', done)
  admin.on('requestfailed', done)
  settleTrucks = async (quietMs = 1500, timeoutMs = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (trucksInflight === 0 && Date.now() - trucksLastActivity >= quietMs) return
      await admin.waitForTimeout(100)
    }
  }

  // ============ Step 1 — Super Admin logs in
  {
    let observed; let ok = false; let s
    try {
      await login(admin, 'Step 1 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      await admin.locator('a[href="/trucks"]').first().waitFor({ state: 'visible', timeout: 30000 })
      await admin.waitForTimeout(2500) // let the dashboard's first data land for the screenshot
      await caption(admin, 'Step 1 — Super Admin signed in → the dashboard loads')
      ok = new URL(admin.url()).pathname.startsWith('/dashboard')
      observed = `landed on ${new URL(admin.url()).pathname}`
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, '01-superadmin-dashboard')
    record({ step: '1', title: 'Super Admin logs in', expected: 'Dashboard renders', observed, verdict: verdict(ok), shot: s })
    if (!ok) throw new Error('cannot continue without the Super Admin session')
  }

  // Clean leftovers from an earlier aborted run (our own naming only). R16's
  // throwaway-driver rows go first: a truck that still has one cannot be deleted.
  {
    if (db) {
      const n = removeLeftoverQaDriverRows()
      if (n.truck_assignments || n.drivers_directory) console.log(`  pre-clean: leftover QA driver rows: ${JSON.stringify(n)}`)
    }
    const r = await api(admin, 'GET', '/api/trucks')
    for (const t of (r.json?.trucks || []).filter((t) => /^QA-TEST-/.test(t.UnitNumber || ''))) {
      const d = await api(admin, 'DELETE', `/api/trucks/${t.id}`)
      console.log(`  pre-clean: leftover ${t.UnitNumber} (#${t.id}) -> ${d.status}`)
    }
  }

  async function openTrucks() {
    const link = admin.locator('a[href="/trucks"]').first()
    if (await link.isVisible().catch(() => false)) await link.click()
    else await admin.goto(`${BASE_URL}/trucks`)
    await admin.waitForURL((u) => u.pathname === '/trucks')
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
  }
  async function openAddForm() {
    const det = admin.locator('details.form-accordion')
    await det.waitFor({ state: 'visible' })
    if (!(await det.evaluate((d) => d.open))) await det.locator('summary.form-toggle').click()
    await det.locator('input.fdz-file').waitFor({ state: 'attached' })
    return det
  }
  async function waitPhotoSettled(scope) {
    await admin.waitForTimeout(300)
    await admin.waitForFunction((root) => !root.querySelector('.fdz-zone.is-busy'), await scope.elementHandle(), { timeout: 20000 })
    await admin.waitForTimeout(500)
    return scope.evaluate(async (root) => {
      const img = root.querySelector('img[alt*="preview" i]')
      if (img && !img.complete) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000) })
      const text = root.innerText || ''
      const msgs = [...root.querySelectorAll('.error-msg, .fdz-msg, [role="alert"], .field-hint')]
        .map((e) => (e.innerText || '').trim().replace(/\s*Dismiss$/, ''))
        .filter((t) => t && /(couldn|could not|can.?t|isn.?t|not a|unsupported|use a|refus|invalid)/i.test(t))
      return {
        messages: [...new Set(msgs)],
        expectedMsg: /couldn.?t read that photo/i.test(text) && /jpeg,?\s*png,?\s*or\s*webp/i.test(text),
        preview: img ? { srcHead: (img.getAttribute('src') || '').slice(0, 26), naturalWidth: img.naturalWidth } : null,
      }
    })
  }

  // ============ Step 2 — Add Truck: a non-image as the photo
  await openTrucks()
  const nonImages = [
    { id: '2a', name: 'not-a-photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG_DOC), what: 'an SVG document (<text> only), type image/svg+xml' },
    { id: '2b', name: 'scan.jpg', mimeType: 'image/jpeg', buffer: PDF_BYTES, what: 'PDF bytes named scan.jpg (browser labels it image/jpeg)' },
    { id: '2c', name: 'document.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES, what: 'a plain PDF, type application/pdf' },
  ]
  for (const f of nonImages) {
    let observed; let ok = false; let s
    try {
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const det = await openAddForm()
      await caption(admin, `Step ${f.id} — Add Truck: attach ${f.what} as the photo → expect "Couldn't read that photo — use a JPEG, PNG or WebP image." and no preview`)
      await det.locator('input.fdz-file').setInputFiles({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })
      const o = await waitPhotoSettled(det)
      const previewTxt = o.preview ? `preview KEPT (src ${o.preview.srcHead}…, naturalWidth ${o.preview.naturalWidth}${o.preview.naturalWidth === 0 ? ' = broken image' : ''})` : 'no preview'
      observed = `${o.messages.length ? `message: "${o.messages.join('" / "')}"` : 'no message shown'}; ${previewTxt}`
      ok = f.id === '2c'
        ? (!o.preview && o.messages.length > 0) // the drop zone's own type filter may be the one that refuses it
        : (o.expectedMsg && !o.preview)
      if (f.id === '2c') observed += ' (a .pdf never reaches the photo reader: the drop zone type filter answers first)'
      await centerOn(det, ['img[alt*="preview" i]', '.fdz-msg', '.fdz'])
      await caption(admin, `Step ${f.id} — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, `${f.id.padStart(3, '0').slice(-3)}-add-truck-${f.name.replace(/\W+/g, '-')}`)
    record({
      step: f.id,
      title: `Add Truck: attach ${f.what}`,
      expected: f.id === '2c' ? 'Refused inline (drop-zone type filter or the photo check); no preview' : 'Inline "Couldn\'t read that photo — use a JPEG, PNG or WebP image."; no broken preview kept',
      observed, verdict: verdict(ok), shot: s,
    })
  }

  // ============ Step 3 — Add the fresh test truck with a real JPEG + costs
  {
    let observed; let ok = false; let s
    const today = await admin.evaluate(() => new Date().toLocaleDateString('en-CA'))
    try {
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const det = await openAddForm()
      await caption(admin, `Step 3 — Add Truck ${UNIT}: real JPEG photo, Active, in service ${today}, no driver, insurance $1000/mo, ELD $40/mo, HVUT $600/yr, IRP $1200/yr → expect it saves`)
      await field(det, 'Unit Number').fill(UNIT)
      await field(det, 'Status').selectOption('Active')
      await det.locator('#add-truck-in-service-date').fill(today)
      await field(det, 'Insurance ($/mo)').fill('1000')
      await field(det, 'ELD ($/mo)').fill('40')
      await field(det, 'HVUT ($/yr)').fill('600')
      await field(det, 'IRP ($/yr)').fill('1200')
      await det.locator('input.fdz-file').setInputFiles({ name: 'qa-truck.jpg', mimeType: 'image/jpeg', buffer: IMG.jpeg })
      const o = await waitPhotoSettled(det)
      if (!o.preview || !o.preview.naturalWidth) throw new Error(`JPEG preview did not render (${JSON.stringify(o)})`)
      await centerOn(det, ['img[alt*="preview" i]'])
      await shot(admin, '03a-add-truck-filled-photo')
      await field(det, 'Insurance ($/mo)').scrollIntoViewIfNeeded()
      await centerOn(det, ['#add-truck-in-service-date'])
      await shot(admin, '03a-add-truck-filled-costs')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === '/api/trucks' && r.request().method() === 'POST', { timeout: 30000 }),
        det.locator('button.btn-add').click(),
      ])
      const body = await resp.json().catch(() => ({}))
      const toast = await toastText(admin)
      if (resp.status() === 200 && body.id) {
        truckId = body.id
        created.add(truckId)
        meta.ids.testTruck = truckId
        await rowOf(admin, UNIT).waitFor({ state: 'visible', timeout: 20000 })
        const t = await getTruck(admin, truckId)
        const photoOk = /^data:image\/jpeg;base64,/.test(t?.Photo || '')
        const costsOk = t && t.InsuranceMonthly === 1000 && t.EldMonthly === 40 && t.HvutAnnual === 600 && t.IrpAnnual === 1200
        ok = photoOk && costsOk
        observed = `POST 200 id=${truckId}; toast "${toast}"; stored photo ${photoHead(t)}; ${costsOf(t)}`
      } else {
        observed = `POST ${resp.status()} ${JSON.stringify(body).slice(0, 200)}; toast "${toast}"`
      }
      await caption(admin, `Step 3 — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, '03b-add-truck-saved')
    record({ step: '3', title: 'Add fresh test truck with a real JPEG photo and costs', expected: 'Saves (200); row listed; photo stored as JPEG; costs stored', observed, verdict: verdict(ok), shot: s })
    if (!truckId) {
      // Keep the rest of the run meaningful: create the test truck over the API.
      const r = await api(admin, 'POST', '/api/trucks', {
        unitNumber: UNIT, status: 'Active', in_service_date: today, inServiceDate: today, assignedDriver: '',
        insuranceMonthly: 1000, eldMonthly: 40, hvutAnnual: 600, irpAnnual: 1200, photo: JPEG_DATA,
      })
      if (r.status === 200 && r.json?.id) { truckId = r.json.id; created.add(truckId); meta.ids.testTruck = truckId }
      record({ step: '3*', title: 'Fallback: create the test truck over the API', expected: 'n/a', observed: `POST ${r.status} id=${truckId}`, verdict: 'INFO', shot: '' })
      if (!truckId) throw new Error('no test truck — cannot continue')
      await admin.reload()
    }
  }

  const row = () => rowOf(admin, UNIT)
  async function openEdit() {
    if (new URL(admin.url()).pathname !== '/trucks') await openTrucks()
    await settleTrucks()
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
    await row().locator('button.btn-edit').click()
    const dlg = admin.locator('.confirm-overlay .edit-dialog')
    await dlg.waitFor({ state: 'visible' })
    await dlg.locator('h3', { hasText: UNIT }).waitFor()
    return dlg
  }
  const putPath = () => `/api/trucks/${truckId}`
  const ensureInsurance = async (v) => {
    const t = await getTruck(admin, truckId)
    if (t && t.InsuranceMonthly !== v) await api(admin, 'PUT', putPath(), { insuranceMonthly: v })
  }

  // ============ Step 4 — Edit: type 1e999 into Insurance, Save
  {
    let observed; let ok = false; let s
    const puts = []
    const onReq = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts.push(req.postData() || '') }
    try {
      const before = await getTruck(admin, truckId)
      const dlg = await openEdit()
      await caption(admin, 'Step 4 — Edit the test truck: type 1e999 into Insurance and press Save → expect an inline error naming Insurance, nothing sent')
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('1e999', { delay: HEADED ? 140 : 20 })
      const state = await ins.evaluate((el) => ({ value: el.value, badInput: el.validity.badInput, ariaInvalid: el.getAttribute('aria-invalid') }))
      await shot(admin, '04a-edit-insurance-1e999-typed')
      admin.on('request', onReq)
      const saveBtn = dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ })
      // A fix may disable Save instead of refusing on click — that also sends nothing.
      const saveDisabled = !(await saveBtn.isEnabled().catch(() => true))
      if (!saveDisabled) await saveBtn.click()
      await admin.waitForTimeout(2500)
      admin.off('request', onReq)
      if (saveDisabled) state.saveDisabled = true
      const toast = await toastText(admin, 1000)
      const stillOpen = await dlg.isVisible().catch(() => false)
      let errInfo = { texts: [], errLines: [] }
      if (stillOpen) {
        errInfo = await dlg.evaluate((root) => {
          const sel = '[role="alert"], [aria-live], .error, .error-msg, .field-error, .input-error, [class*="error" i], [class*="invalid" i], [style*="danger"]'
          const texts = [...root.querySelectorAll(sel)].map((e) => (e.innerText || '').trim()).filter(Boolean)
          const lines = (root.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean)
          const errLines = lines.filter((l) => /insurance/i.test(l) && !/^insurance \(\$\/mo\)$/i.test(l) &&
            /(invalid|must|finite|number|amount|too (large|big|high)|not a|enter|between|at most|less than|up to|can.?t|cannot|exceed|limit|1,000,000)/i.test(l))
          return { texts: [...new Set(texts)], errLines: [...new Set(errLines)] }
        })
      }
      await shot(admin, '04b-edit-insurance-1e999-after-save')
      const after = await getTruck(admin, truckId)
      const sentIns = puts.map((p) => { try { return JSON.stringify(JSON.parse(p).insuranceMonthly) } catch { return '?' } })
      const namedError = errInfo.errLines.length > 0 || errInfo.texts.some((t) => /insurance/i.test(t))
      ok = puts.length === 0 && stillOpen && namedError && after?.InsuranceMonthly === before?.InsuranceMonthly
      observed = `input shows value="${state.value}" (badInput=${state.badInput}${state.ariaInvalid ? `, aria-invalid=${state.ariaInvalid}` : ''}); ` +
        `${state.saveDisabled ? 'Save button disabled; ' : ''}` +
        `${puts.length ? `PUT SENT (insuranceMonthly=${sentIns.join(',')})` : 'no PUT sent'}; ` +
        `modal ${stillOpen ? 'stayed open' : 'closed'}; ` +
        `${namedError ? `inline error: "${[...errInfo.errLines, ...errInfo.texts.filter((t) => /insurance/i.test(t))].join(' / ')}"` : 'no inline error naming Insurance'}; ` +
        `toast "${toast}"; stored insurance ${before?.InsuranceMonthly} → ${after?.InsuranceMonthly}`
      await caption(admin, `Step 4 — result: ${observed}`)
      if (stillOpen) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
    } catch (e) { admin.off('request', onReq); observed = `error: ${e.message}` }
    s = await shot(admin, '04c-edit-insurance-1e999-result')
    record({ step: '4', title: 'Edit truck: type 1e999 in Insurance, Save', expected: 'Inline error naming Insurance; no request sent; stored value unchanged', observed, verdict: verdict(ok), shot: s })
    // Whatever state the modal was left in, start the next step from a clean page.
    await admin.reload().catch(() => {})
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  }

  // ============ Step 5 — API: bad amounts refused with 400 INVALID_AMOUNT
  {
    await ensureInsurance(1000)
    await caption(admin, 'Step 5 — API: PUT /api/trucks/:id with bad amounts ("Infinity", -5, "abc", "1e999", 1000001, IRP "Infinity") and POST with "Infinity" → expect 400 INVALID_AMOUNT, row unchanged')
    const cases = [
      { id: '5a', body: { insuranceMonthly: 'Infinity' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5b', body: { insuranceMonthly: -5 }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5c', body: { insuranceMonthly: 'abc' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5d', body: { insuranceMonthly: '1e999' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5e', body: { insuranceMonthly: 1000001 }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5f', body: { irpAnnual: 'Infinity' }, field: 'irp_annual', col: 'IrpAnnual' },
    ]
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), c.body)
      const after = await getTruck(admin, truckId)
      const unchanged = after && after[c.col] === before[c.col]
      const ok = r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === c.field && unchanged
      const observed = `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; stored ${c.col} ${before?.[c.col]} → ${JSON.stringify(after?.[c.col])}${unchanged ? ' (unchanged)' : ' (CHANGED)'}`
      logs.push(`${c.id} ${JSON.stringify(c.body)} → ${r.status} ${r.json?.code || ''}`)
      // put the row back so the next case starts from the known state
      if (!unchanged) await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000, irpAnnual: 1200 })
      record({ step: c.id, title: `API PUT ${JSON.stringify(c.body)}`, expected: `400 INVALID_AMOUNT, field "${c.field}"; row unchanged`, observed, verdict: verdict(ok), shot: '' })
    }
    // boundary: exactly 1,000,000 is allowed by the rule (> 1,000,000 is refused)
    {
      const r = await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000000 })
      const t = await getTruck(admin, truckId)
      const ok = r.status === 200 && t?.InsuranceMonthly === 1000000
      logs.push(`5g {"insuranceMonthly":1000000} → ${r.status}`)
      await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000 })
      record({ step: '5g', title: 'API PUT insuranceMonthly 1000000 (boundary)', expected: '200 — accepted (only > 1,000,000 is refused); then reset to 1000', observed: `${r.status}; stored ${t?.InsuranceMonthly}`, verdict: verdict(ok), shot: '' })
    }
    // create verb
    {
      const unit = `${UNIT}-BADAMT`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', insuranceMonthly: 'Infinity' })
      const list = await api(admin, 'GET', '/api/trucks')
      const made = (list.json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      const ok = r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && !made
      logs.push(`5h POST insurance "Infinity" → ${r.status} ${r.json?.code || ''}`)
      record({
        step: '5h', title: 'API POST /api/trucks with insuranceMonthly "Infinity"', expected: '400 INVALID_AMOUNT; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 160)}; truck ${made ? `CREATED (#${made.id}, insurance stored as ${JSON.stringify(made.InsuranceMonthly)}) — deleted again` : 'not created'}`,
        verdict: verdict(ok), shot: '',
      })
    }
    // Evidence in the browser: the JSON of the stored row after the bad-amount calls.
    await caption(admin, `Step 5 — ${logs.join(' · ')}`)
    const s = await shot(admin, '05-api-bad-amounts')
    rows.filter((r) => /^5[a-h]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ Step 6 — Edit Insurance + IRP (valid) → one update_truck_costs audit row
  let costRowsStep6 = 0
  let auditBaseline = 0
  {
    let observed; let ok = false; let s
    try {
      await ensureInsurance(1000)
      const pre = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')
      auditBaseline = pre.json?.logs?.[0]?.id || 0
      if (new URL(admin.url()).pathname !== '/trucks') await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Step 6 — Edit the test truck: Insurance 1000 → 1150, IRP 1200 → 1800, Save → expect ONE update_truck_costs audit row naming both, with "fixed costs $1,190.00/mo → $1,390.00/mo"')
      await field(dlg, 'Insurance ($/mo)').fill('1150')
      await field(dlg, 'IRP ($/yr)').fill('1800')
      await shot(admin, '06a-edit-costs-valid')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 20000 }),
        dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click(),
      ])
      const toast = await toastText(admin)
      const t = await getTruck(admin, truckId)
      const nav = await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=10')
      await caption(admin, 'Step 6 — the audit trail (entity=truck, newest first) straight after the save')
      s = await shot(admin, '06b-audit-trail-after-cost-edit', { fullPage: true })
      const full = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')
      const mine = (full.json?.logs || []).filter((l) => l.id > auditBaseline && String(l.entity_id) === String(truckId))
      const cost = mine.filter((l) => l.action === 'update_truck_costs')
      costRowsStep6 = cost.length
      const d = cost[0]?.details || ''
      const namesBoth = /insurance/i.test(d) && /irp/i.test(d)
      const hasTotal = /fixed costs:?\s*\$[\d,.]+\/mo\s*(→|->|to)\s*\$[\d,.]+\/mo/i.test(d)
      const exactTotals = /1,190\.00/.test(d) && /1,390\.00/.test(d)
      ok = resp.status() === 200 && cost.length === 1 && namesBoth && hasTotal
      observed = `PUT ${resp.status()}, toast "${toast}", stored ${costsOf(t)}; audit page ${nav.status} ${nav.contentType.split(';')[0]}; ` +
        `new rows for this truck: ${mine.length ? mine.map((l) => l.action).join(', ') : 'none'}; update_truck_costs rows: ${cost.length}` +
        (cost.length ? `; details: "${d}"; names insurance+irp: ${namesBoth}; "fixed costs $X/mo → $Y/mo": ${hasTotal}; totals 1,190.00→1,390.00: ${exactTotals}` : '')
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, '06b-audit-trail-after-cost-edit', { fullPage: true })
    record({ step: '6', title: 'Edit Insurance + IRP (valid values), then view the audit trail', expected: 'Exactly one update_truck_costs row naming insurance and IRP, with "fixed costs $1,190.00/mo → $1,390.00/mo"', observed, verdict: verdict(ok), shot: s })
  }

  // ============ Step 7 — Save again with no changes → no new cost row
  {
    let observed; let ok = false; let s
    try {
      const pre = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')
      const base = pre.json?.logs?.[0]?.id || 0
      await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Step 7 — Open Edit and press Save without changing anything → expect NO new update_truck_costs row (a build that sends only changed fields sends nothing and just closes)')
      // A build that sends only changed fields sends NO request for an untouched
      // form and simply closes the dialog; an older build PUTs every field. Both
      // are fine as long as no cost row appears.
      const puts7 = []
      const onReq7 = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts7.push(req) }
      admin.on('request', onReq7)
      const respP = admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 4000 }).catch(() => null)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      const resp = await respP
      admin.off('request', onReq7)
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      const closed = !(await dlg.isVisible().catch(() => false))
      const toast = await toastText(admin, 1500)
      await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=10')
      await caption(admin, 'Step 7 — the audit trail after a no-change save')
      s = await shot(admin, '07-audit-trail-after-no-change-save', { fullPage: true })
      const full = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')
      const mine = (full.json?.logs || []).filter((l) => l.id > base && String(l.entity_id) === String(truckId))
      const cost = mine.filter((l) => l.action === 'update_truck_costs')
      ok = cost.length === 0 && closed && (resp ? resp.status() === 200 : puts7.length === 0)
      observed = `${resp ? `PUT ${resp.status()}` : (puts7.length ? `PUT sent (${puts7.length}) with no response` : 'no PUT sent (nothing changed)')}; dialog ${closed ? 'closed' : 'STILL OPEN'}; toast "${toast}"; new rows for this truck: ${mine.length ? mine.map((l) => l.action).join(', ') : 'none'}; new update_truck_costs rows: ${cost.length}`
      if (ok && costRowsStep6 === 0) observed += ' — vacuous: this build writes no cost audit row at all (see step 6)'
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, '07-audit-trail-after-no-change-save', { fullPage: true })
    record({ step: '7', title: 'Save the same truck again with no changes', expected: 'No new update_truck_costs row', observed, verdict: ok ? (costRowsStep6 === 0 ? 'PASS (vacuous)' : 'PASS') : 'FAIL', shot: s })
  }

  // ============ Extra X1 (opt-in, EXTRA=1) — pre-existing, OUTSIDE the three fixes:
  // an open Edit modal is destroyed by any trucks:changed refresh.
  if (process.env.EXTRA === '1') {
    let observed; let s
    try {
      await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Extra X1 (pre-existing, not one of the three fixes) — Edit modal open with an unsaved Notes edit; another truck save lands → does the modal survive?')
      await field(dlg, 'Notes').fill('unsaved QA note')
      await shot(admin, 'x1a-edit-modal-unsaved-note')
      // What another admin's save does: the server emits trucks:changed to every open Trucks page.
      await api(admin, 'PUT', putPath(), { notes: `changed elsewhere ${stamp}` })
      await admin.waitForTimeout(3000)
      const alive = await dlg.isVisible().catch(() => false)
      observed = alive ? 'modal still open; the typed note is kept' : 'modal VANISHED with the unsaved note — TrucksView swaps TruckTable for a skeleton during the socket-driven reload, unmounting the teleported modal'
      await caption(admin, `Extra X1 — result: ${observed}`)
      s = await shot(admin, 'x1b-edit-modal-after-other-save')
      if (alive) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
    } catch (e) { observed = `error: ${e.message}` }
    record({ step: 'X1', title: '(pre-existing, out of scope) Edit modal vs. a trucks:changed refresh from another save', expected: 'Modal stays open; unsaved input kept', observed, verdict: 'INFO', shot: s })
  }

  // ============ Step 8 — API: a non-image photo is refused (415), a real one is not
  {
    await openTrucks()
    await caption(admin, 'Step 8 — API: PUT the test truck\'s photo as non-image data URIs → expect 415 UNSUPPORTED_IMAGE_TYPE, stored photo unchanged; real PNG / empty photo still accepted')
    const cases = [
      { id: '8a', p: PLANTS.html, expect: 415 },
      { id: '8b', p: PLANTS.svg, expect: 415 },
      { id: '8c', p: PLANTS.htmlAsJpeg, expect: 415 },
      { id: '8d', p: PLANTS.malformed, expect: '4xx' },
    ]
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), { photo: c.p.value })
      const after = await getTruck(admin, truckId)
      const unchanged = after?.Photo === before?.Photo
      const ok = (c.expect === 415 ? (r.status === 415 && r.json?.code === 'UNSUPPORTED_IMAGE_TYPE') : (r.status >= 400 && r.status < 500)) && unchanged
      logs.push(`${c.id} → ${r.status} ${r.json?.code || ''}`)
      if (!unchanged) await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      record({
        step: c.id, title: `API PUT photo = ${c.p.label}`,
        expected: c.expect === 415 ? '415 UNSUPPORTED_IMAGE_TYPE; stored photo unchanged' : 'Refused with a 4xx (415 expected); stored photo unchanged',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 140)}; stored photo ${unchanged ? 'unchanged' : `CHANGED to ${photoHead(after)} (reset)`}`,
        verdict: verdict(ok), shot: '',
      })
    }
    {
      const unit = `${UNIT}-BADPHOTO`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', photo: PLANTS.html.value })
      const list = await api(admin, 'GET', '/api/trucks')
      const made = (list.json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      logs.push(`8e POST → ${r.status} ${r.json?.code || ''}`)
      record({
        step: '8e', title: 'API POST /api/trucks with photo = data:text/html', expected: '415 UNSUPPORTED_IMAGE_TYPE; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 140)}; truck ${made ? `CREATED (#${made.id}, photo ${photoHead(made)}) — deleted again` : 'not created'}`,
        verdict: verdict(r.status === 415 && r.json?.code === 'UNSUPPORTED_IMAGE_TYPE' && !made), shot: '',
      })
    }
    {
      const r = await api(admin, 'PUT', putPath(), { photo: PNG_DATA })
      const t = await getTruck(admin, truckId)
      logs.push(`8f real PNG → ${r.status}`)
      record({ step: '8f', title: 'API PUT photo = a real PNG (regression)', expected: '200 — accepted, stored as an image', observed: `${r.status}; stored ${photoHead(t)}`, verdict: verdict(r.status === 200 && /^data:image\//.test(t?.Photo || '')), shot: '' })
      const r2 = await api(admin, 'PUT', putPath(), { photo: '' })
      const t2 = await getTruck(admin, truckId)
      logs.push(`8g empty photo → ${r2.status}`)
      record({ step: '8g', title: 'API PUT photo = "" — a truck with no photo (regression; the Edit form sends this for photo-less trucks)', expected: '200 — accepted, photo cleared', observed: `${r2.status}; stored ${JSON.stringify(t2?.Photo)}`, verdict: verdict(r2.status === 200 && !t2?.Photo), shot: '' })
      const r3 = await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      logs.push(`8h real JPEG → ${r3.status}`)
      record({ step: '8h', title: 'API PUT photo = a real JPEG (regression)', expected: '200', observed: `${r3.status}`, verdict: verdict(r3.status === 200), shot: '' })
    }
    await caption(admin, `Step 8 — ${logs.join(' · ')}`)
    const s = await shot(admin, '08-api-photo-type')
    rows.filter((r) => /^8[a-h]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // =====================================================================
  // ROUND 2 — R1-R9. "Truck A" is this run's test truck (truckId); every
  // "Expected" is the AFTER-the-fix behaviour. Truck A is deleted at the end,
  // so its fields are only put back where a later step reads them.
  // =====================================================================
  const todayR = await admin.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const reloadTrucksPage = async () => {
    await admin.goto(`${BASE_URL}/trucks`)
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
  }
  const cancelEdit = async () => {
    const dlg = admin.locator('.confirm-overlay .edit-dialog')
    if (await dlg.isVisible().catch(() => false)) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
  }
  // Truck B: a second fresh test truck, the one R1's "other save" lands on.
  const UNIT_B = `${UNIT}-B`
  let truckB = null
  {
    const r = await api(admin, 'POST', '/api/trucks', { unitNumber: UNIT_B, status: 'Active', in_service_date: todayR, inServiceDate: todayR, assignedDriver: '' })
    if (r.status === 200 && r.json?.id) { truckB = r.json.id; created.add(truckB); meta.ids.testTruckB = truckB }
    console.log(`  truck B: POST ${r.status} id=${truckB}`)
  }
  // An existing unit for R2, discovered through the API: the lowest-id truck
  // that is not one of ours. Only its id is ever written to the results.
  const existingTruck = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || [])
    .filter((t) => (t.UnitNumber || '').trim() && !/^QA-TEST-/i.test(t.UnitNumber))
    .sort((a, b) => a.id - b.id)[0] || null
  if (existingTruck) meta.ids.existingUnitTruck = existingTruck.id

  // ============ R1 — an unsaved Edit survives a list reload caused by another save
  {
    let observed; let ok = false; let s
    const note = `QA R1 change on truck B ${stamp}`
    try {
      if (!truckB) throw new Error('truck B could not be created')
      await reloadTrucksPage()
      const dlg = await openEdit()
      const insBefore = (await getTruck(admin, truckId))?.InsuranceMonthly
      await caption(admin, `Step R1 — Edit truck A (${UNIT}): type Insurance 2468 WITHOUT saving; then a save lands on truck B → expect the modal to stay open with 2468 still typed`)
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('2468', { delay: HEADED ? 140 : 20 })
      await shot(admin, 'r1a-edit-a-typed-unsaved')
      // Nothing else on this page issues GET /api/trucks now, so the first one
      // after B's save is the trucks:changed reload.
      const reloadP = admin.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      const put = await api(admin, 'PUT', `/api/trucks/${truckB}`, { notes: note })
      const reloadResp = await reloadP
      let reloadSawB = false
      if (reloadResp) { try { reloadSawB = ((await reloadResp.json()).trucks || []).some((t) => String(t.id) === String(truckB) && t.Notes === note) } catch { /* body unavailable */ } }
      await settleTrucks(1000, 15000)
      await admin.waitForTimeout(400)
      const alive = await dlg.isVisible().catch(() => false)
      const title = alive ? (await dlg.locator('h3').innerText().catch(() => '')).trim() : ''
      const typed = alive ? await ins.inputValue().catch(() => null) : null
      const insAfter = (await getTruck(admin, truckId))?.InsuranceMonthly
      ok = put.status === 200 && !!reloadResp && alive && typed === '2468' && title.includes(UNIT)
      observed = `PUT truck B (#${truckB}) notes → ${put.status}; list reload ${reloadResp ? `GET /api/trucks ${reloadResp.status()}${reloadSawB ? ', carrying B\'s new notes' : ''}` : 'NOT seen within 15 s (inconclusive)'}; ` +
        (alive ? `Edit modal still open ("${title}"), Insurance box shows "${typed}"` : 'Edit modal VANISHED with the typed 2468') +
        `; stored insurance ${insBefore} → ${insAfter} (nothing saved)`
      await caption(admin, `Step R1 — result: ${observed}`)
      s = await shot(admin, 'r1b-after-list-reload')
      await cancelEdit()
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r1b-after-list-reload')
    record({ step: 'R1', title: 'Edit truck A, type Insurance (unsaved); a save on truck B reloads the list', expected: 'Modal stays open; the typed Insurance (2468) is intact', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R11 — two people, one truck: an Edit dialog that stayed open does not
  // revert someone else's save to the same truck (only the fields this person changed are sent).
  {
    let observed; let ok = false; let s
    const otherNote = `QA R11 notes saved elsewhere ${stamp}`
    let insPrev = null
    try {
      await reloadTrucksPage()
      const dlg = await openEdit()
      insPrev = (await getTruck(admin, truckId))?.InsuranceMonthly
      await caption(admin, 'Step R11 — Edit truck A: change Insurance to 1357; meanwhile someone else saves new Notes on the SAME truck → Save → expect BOTH changes to survive')
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('1357', { delay: HEADED ? 140 : 20 })
      // Someone else's save on the same truck (notes only), as another admin would make it.
      const reloadP = admin.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      const other = await api(admin, 'PUT', putPath(), { notes: otherNote })
      await reloadP
      await settleTrucks(1000, 15000)
      await admin.waitForTimeout(400)
      const stillOpen = await dlg.isVisible().catch(() => false)
      await shot(admin, 'r11a-edit-open-after-other-save')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 20000 }),
        dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click(),
      ])
      let sentKeys = []
      try { sentKeys = Object.keys(JSON.parse(resp.request().postData() || '{}')) } catch { /* not JSON */ }
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      const after = await getTruck(admin, truckId)
      const notesKept = after?.Notes === otherNote
      ok = other.status === 200 && stillOpen && resp.status() === 200 && Number(after?.InsuranceMonthly) === 1357 && notesKept
      observed = `other person's notes save → ${other.status}; my Edit ${stillOpen ? 'still open' : 'CLOSED'}; my Save → PUT ${resp.status()} sending [${sentKeys.join(', ')}]; ` +
        `stored insurance ${insPrev} → ${after?.InsuranceMonthly}; stored notes ${notesKept ? 'KEPT the other person\'s save' : `REVERTED to "${after?.Notes ?? ''}"`}`
      await caption(admin, `Step R11 — result: ${observed}`)
      s = await shot(admin, 'r11b-after-save')
    } catch (e) { observed = `error: ${e.message}` }
    try { if (insPrev !== null) await ensureInsurance(insPrev) } catch { /* best effort */ }
    if (!s) s = await shot(admin, 'r11b-after-save')
    record({ step: 'R11', title: 'Edit truck A (Insurance 1357) while someone else saves new Notes on the same truck, then Save', expected: 'Both survive: insurance 1357 AND the other person\'s notes (the Save sends only the changed fields)', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R2a — Edit: a refused save (duplicate unit) keeps the modal and the input
  {
    let observed; let ok = false; let s
    try {
      if (!existingTruck) throw new Error('no non-QA truck in /api/trucks to borrow a unit number from')
      await reloadTrucksPage()
      const dlg = await openEdit()
      await caption(admin, `Step R2a — Edit truck A: set Unit # to an existing unit (truck #${existingTruck.id}'s) and Save → expect "Unit number already exists" inline, the modal open, the typed unit kept`)
      const unitIn = field(dlg, 'Unit Number')
      await unitIn.fill(existingTruck.UnitNumber)
      await shot(admin, 'r2a-edit-existing-unit-typed')
      const respP = admin.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === putPath(), { timeout: 15000 }).catch(() => null)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      const resp = await respP
      const body = resp ? await resp.json().catch(() => null) : null
      await admin.waitForTimeout(1200)
      const toast = await toastText(admin, 1500)
      const stillOpen = await dlg.isVisible().catch(() => false)
      const unitNow = stillOpen ? await unitIn.inputValue().catch(() => null) : null
      const inline = stillOpen && /unit number already exists/i.test(await dlg.innerText().catch(() => ''))
      const t = await getTruck(admin, truckId)
      ok = resp?.status() === 400 && stillOpen && unitNow === existingTruck.UnitNumber && inline && t?.UnitNumber === UNIT
      observed = `PUT ${resp ? `${resp.status()} ${JSON.stringify(body).slice(0, 80)}` : 'not sent'}; modal ${stillOpen ? 'stayed open' : 'CLOSED'}` +
        (stillOpen ? `; Unit # box ${unitNow === existingTruck.UnitNumber ? 'still holds the typed unit' : `reads "${unitNow}"`}; inline error ${inline ? 'shown' : 'NOT shown'}` : ' (the typed unit is gone)') +
        `; toast "${toast}"; stored unit ${t?.UnitNumber === UNIT ? 'unchanged' : 'CHANGED'}`
      await caption(admin, `Step R2a — result: ${observed}`)
      s = await shot(admin, 'r2a-edit-existing-unit-result')
      await cancelEdit()
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r2a-edit-existing-unit-result')
    record({ step: 'R2a', title: 'Edit truck A: Unit # set to an existing unit, Save', expected: '400 "Unit number already exists" shown inline; modal stays open; the typed unit is still there', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R2b — Add Truck: a refused add (duplicate unit) keeps what was typed
  {
    let observed; let ok = false; let s
    const note = `QA R2b keep me ${stamp}`
    try {
      if (!existingTruck) throw new Error('no non-QA truck in /api/trucks to borrow a unit number from')
      await reloadTrucksPage()
      const det = await openAddForm()
      await caption(admin, `Step R2b — Add Truck with an existing unit (truck #${existingTruck.id}'s), a note and Insurance 777 → expect the fields kept and "Unit number already exists" shown`)
      await field(det, 'Unit Number').fill(existingTruck.UnitNumber)
      await field(det, 'Notes (optional)').fill(note)
      await field(det, 'Insurance ($/mo)').fill('777')
      await centerOn(det, ['button.btn-add'])
      await shot(admin, 'r2b-add-existing-unit-filled')
      const respP = admin.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      await det.locator('button.btn-add').click()
      const resp = await respP
      const body = resp ? await resp.json().catch(() => null) : null
      await admin.waitForTimeout(1200)
      const toast = await toastText(admin, 1500)
      const unitNow = await field(det, 'Unit Number').inputValue().catch(() => null)
      const notesNow = await field(det, 'Notes (optional)').inputValue().catch(() => null)
      const insNow = await field(det, 'Insurance ($/mo)').inputValue().catch(() => null)
      const inlineErr = (await det.locator('.error-msg').innerText().catch(() => '')).trim()
      const shownInline = /unit number already exists/i.test(inlineErr)
      const shownToast = /unit number already exists/i.test(toast)
      const kept = unitNow === existingTruck.UnitNumber && notesNow === note && insNow === '777'
      const dupes = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || []).filter((t) => (t.UnitNumber || '').toLowerCase() === existingTruck.UnitNumber.toLowerCase()).length
      ok = resp?.status() === 400 && kept && (shownInline || shownToast) && dupes === 1
      observed = `POST ${resp ? `${resp.status()} ${JSON.stringify(body).slice(0, 80)}` : 'not sent'}; fields ${kept ? 'kept (unit, note, Insurance 777)' : `CLEARED (unit ${unitNow === existingTruck.UnitNumber ? 'kept' : `"${unitNow}"`}, note ${notesNow === note ? 'kept' : `"${notesNow}"`}, Insurance "${insNow}")`}; ` +
        `error ${shownInline ? `inline "${inlineErr}"` : 'not inline'}${shownToast ? `, toast "${toast}"` : toast ? `; toast "${toast}"` : ''}; trucks with that unit: ${dupes}`
      await centerOn(det, ['.error-msg', 'button.btn-add'])
      await caption(admin, `Step R2b — result: ${observed}`)
      s = await shot(admin, 'r2b-add-existing-unit-result')
      // Leave nothing typed behind for the next step.
      for (const l of ['Unit Number', 'Notes (optional)']) await field(det, l).fill('').catch(() => {})
      await field(det, 'Insurance ($/mo)').fill('0').catch(() => {})
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r2b-add-existing-unit-result')
    record({ step: 'R2b', title: 'Add Truck with an existing unit, press Add Truck', expected: '400 "Unit number already exists" shown; every typed field kept; no truck created', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R4 — a stored photo is normalized to what its bytes are
  {
    let observed; let ok = false; let s
    try {
      await reloadTrucksPage()
      await caption(admin, 'Step R4 — API: PUT truck A photo = real PNG bytes under a data:image/jpeg label, then GET /api/trucks → expect Photo returned as data:image/png;base64,…')
      const r = await api(admin, 'PUT', putPath(), { photo: PLANTS.pngAsJpeg.value })
      const t = await getTruck(admin, truckId)
      const stored = t?.Photo || ''
      const sameBytes = stored.slice(stored.indexOf(',') + 1) === IMG.png.toString('base64')
      // The same value through the UI: the Edit dialog's preview is the stored photo.
      let uiHead = '(not read)'
      try {
        await reloadTrucksPage()
        const dlg = await openEdit()
        const img = dlg.locator('img[alt="Truck photo preview"]')
        await img.scrollIntoViewIfNeeded()
        uiHead = ((await img.getAttribute('src')) || '').slice(0, 22)
        await caption(admin, `Step R4 — PUT ${r.status}; GET /api/trucks Photo starts "${stored.slice(0, 22)}…"; the Edit dialog's preview src starts "${uiHead}…"`)
        s = await shot(admin, 'r4-png-bytes-under-jpeg-label')
        await cancelEdit()
      } catch (e) { uiHead = `(UI read failed: ${e.message.split('\n')[0]})` }
      ok = r.status === 200 && /^data:image\/png;base64,/.test(stored)
      observed = `PUT ${r.status}; GET /api/trucks Photo starts "${stored.slice(0, 22)}…"; payload ${sameBytes ? 'identical to the PNG bytes sent' : 'differs from the PNG bytes sent'}; Edit preview src "${uiHead}…"`
    } catch (e) { observed = `error: ${e.message}` }
    await api(admin, 'PUT', putPath(), { photo: JPEG_DATA }).catch(() => {})
    if (!s) s = await shot(admin, 'r4-png-bytes-under-jpeg-label')
    record({ step: 'R4', title: 'API PUT truck A photo = real PNG bytes under a data:image/jpeg label; GET /api/trucks', expected: '200; A\'s Photo is returned as data:image/png;base64,…', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R5 — photo limits: 2 MiB of bytes, 16 MP of pixels
  {
    const bigJpeg = makePaddedJpeg(Math.round(2.5 * 1024 * 1024))
    const hugePng = makePngHeader(5000, 4000)
    const cases = [
      { id: 'R5a', what: `a valid JPEG header (640×480) padded to ${(bigJpeg.length / 1048576).toFixed(2)} MiB`, value: `data:image/jpeg;base64,${bigJpeg.toString('base64')}` },
      { id: 'R5b', what: `a minimal ${hugePng.length}-byte PNG whose IHDR declares 5000×4000 (20 MP)`, value: `data:image/png;base64,${hugePng.toString('base64')}` },
    ]
    await caption(admin, 'Step R5 — API: PUT truck A photo over the new limits (2.5 MiB JPEG; a 20 MP PNG header) → expect 413 IMAGE_TOO_LARGE, stored photo unchanged')
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), { photo: c.value })
      const after = await getTruck(admin, truckId)
      const unchanged = after?.Photo === before?.Photo
      if (!unchanged) await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      logs.push(`${c.id} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: c.id, title: `API PUT truck A photo = ${c.what}`, expected: '413 IMAGE_TOO_LARGE; stored photo unchanged',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 150)}; stored photo ${unchanged ? 'unchanged' : `CHANGED to ${photoHead(after)} (reset)`}`,
        verdict: verdict(r.status === 413 && r.json?.code === 'IMAGE_TOO_LARGE' && unchanged), shot: '',
      })
    }
    await caption(admin, `Step R5 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r5-api-photo-limits')
    rows.filter((r) => /^R5[ab]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R6 — admin fee must be 0-100; blank means 50
  {
    await caption(admin, 'Step R6 — API: PUT truck A adminFeePct 150, -5, "abc" → expect 400 INVALID_AMOUNT (field admin_fee_pct); then "" → 200, stored 50')
    const setFee = (v) => api(admin, 'PUT', putPath(), { adminFeePct: v })
    const logs = []
    for (const [id, v] of [['R6a', 150], ['R6b', -5], ['R6c', 'abc']]) {
      if ((await getTruck(admin, truckId))?.AdminFeePct !== 50) await setFee(50)
      const before = await getTruck(admin, truckId)
      const r = await setFee(v)
      const after = await getTruck(admin, truckId)
      const unchanged = after?.AdminFeePct === before?.AdminFeePct
      if (!unchanged) await setFee(50)
      logs.push(`${id} ${JSON.stringify(v)} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: id, title: `API PUT adminFeePct ${JSON.stringify(v)}`, expected: '400 INVALID_AMOUNT, field "admin_fee_pct"; stored fee unchanged',
        observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 150) : r.text}; stored AdminFeePct ${before?.AdminFeePct} → ${after?.AdminFeePct}${unchanged ? ' (unchanged)' : ' (CHANGED, reset)'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === 'admin_fee_pct' && unchanged), shot: '',
      })
    }
    {
      // Set a valid 40 first, so a stored 50 afterwards proves "blank = 50" rather than "unchanged".
      const r0 = await setFee(40)
      const mid = await getTruck(admin, truckId)
      const r = await setFee('')
      const t = await getTruck(admin, truckId)
      logs.push(`R6d "" → ${r.status}, stored ${t?.AdminFeePct}`)
      record({
        step: 'R6d', title: 'API PUT adminFeePct "" (after setting 40)', expected: '200; stored 50',
        observed: `set 40 → ${r0.status} (stored ${mid?.AdminFeePct}); "" → ${r.status}; stored AdminFeePct ${t?.AdminFeePct}`,
        verdict: verdict(r0.status === 200 && mid?.AdminFeePct === 40 && r.status === 200 && t?.AdminFeePct === 50), shot: '',
      })
    }
    await caption(admin, `Step R6 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r6-api-admin-fee')
    rows.filter((r) => /^R6[a-d]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R7 — fuel tank <= 500 gal, avg MPG <= 20 (API, create verb, Edit form)
  {
    await caption(admin, 'Step R7 — API: PUT truck A fuel tank 600 and avg MPG 25 → expect 400 INVALID_AMOUNT each; 500 and 20 → 200')
    await api(admin, 'PUT', putPath(), { fuel_tank_gallons: 0, avg_mpg: 0 })
    const logs = []
    const cases = [
      { id: 'R7a', body: { fuel_tank_gallons: 600 }, field: 'fuel_tank_gallons', col: 'FuelTankGallons', msg: (m) => /fuel tank/i.test(m) && /\b500\b/.test(m), msgText: '"Fuel tank must be a number between 0 and 500"' },
      { id: 'R7b', body: { avg_mpg: 25 }, field: 'avg_mpg', col: 'AvgMpg', msg: (m) => /average mpg/i.test(m) && /\b20\b/.test(m), msgText: '"Average MPG … 20"' },
    ]
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), c.body)
      const after = await getTruck(admin, truckId)
      const unchanged = after?.[c.col] === before?.[c.col]
      if (!unchanged) await api(admin, 'PUT', putPath(), { [c.field]: before?.[c.col] ?? 0 })
      logs.push(`${c.id} ${JSON.stringify(c.body)} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: c.id, title: `API PUT ${JSON.stringify(c.body)}`, expected: `400 INVALID_AMOUNT, field "${c.field}", message ${c.msgText}; row unchanged`,
        observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; stored ${c.col} ${before?.[c.col]} → ${after?.[c.col]}${unchanged ? ' (unchanged)' : ' (CHANGED, reset)'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === c.field && c.msg(r.json?.error || '') && unchanged), shot: '',
      })
    }
    for (const [id, body, col, v] of [['R7c', { fuel_tank_gallons: 500 }, 'FuelTankGallons', 500], ['R7d', { avg_mpg: 20 }, 'AvgMpg', 20]]) {
      const r = await api(admin, 'PUT', putPath(), body)
      const t = await getTruck(admin, truckId)
      logs.push(`${id} ${JSON.stringify(body)} → ${r.status}`)
      record({ step: id, title: `API PUT ${JSON.stringify(body)} (boundary)`, expected: `200; stored ${v}`, observed: `${r.status}; stored ${col} ${t?.[col]}`, verdict: verdict(r.status === 200 && t?.[col] === v), shot: '' })
    }
    {
      // The create verb reads the same table.
      const unit = `${UNIT}-BADFUEL`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', fuel_tank_gallons: 600 })
      const made = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      logs.push(`R7e POST fuel 600 → ${r.status} ${r.json?.code || ''}`)
      record({
        step: 'R7e', title: 'API POST /api/trucks with fuel_tank_gallons 600 (Super Admin)', expected: '400 INVALID_AMOUNT, field "fuel_tank_gallons"; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 150)}; truck ${made ? `CREATED (#${made.id}, tank ${made.FuelTankGallons}) — deleted again` : 'not created'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === 'fuel_tank_gallons' && !made), shot: '',
      })
    }
    await caption(admin, `Step R7 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r7-api-fuel-limits')
    rows.filter((r) => /^R7[a-e]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }
  // R7f — the Edit form refuses the same inline, before sending anything.
  {
    let observed; let ok = false; let s
    const puts = []
    const onReq = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts.push(req.postData() || '') }
    try {
      await reloadTrucksPage()
      const before = await getTruck(admin, truckId)
      const dlg = await openEdit()
      await caption(admin, 'Step R7f — Edit truck A: type 600 into Fuel Tank (gallons) and Save → expect an inline error naming the fuel tank, nothing sent, modal open')
      const tank = field(dlg, 'Fuel Tank (gallons)')
      await tank.scrollIntoViewIfNeeded()
      await tank.fill('')
      await tank.pressSequentially('600', { delay: HEADED ? 140 : 20 })
      await shot(admin, 'r7f-edit-fuel-600-typed')
      admin.on('request', onReq)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      await admin.waitForTimeout(2500)
      admin.off('request', onReq)
      const toast = await toastText(admin, 1000)
      const stillOpen = await dlg.isVisible().catch(() => false)
      const err = stillOpen ? (await dlg.locator('.edit-error, [role="alert"]').allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean).join(' / ') : ''
      const namesTank = /fuel tank/i.test(err) && /\b500\b/.test(err)
      const after = await getTruck(admin, truckId)
      const sent = puts.map((p) => { try { return JSON.parse(p).fuel_tank_gallons } catch { return '?' } })
      ok = puts.length === 0 && stillOpen && namesTank && after?.FuelTankGallons === before?.FuelTankGallons
      observed = `${puts.length ? `PUT SENT (fuel_tank_gallons=${sent.join(',')})` : 'no PUT sent'}; modal ${stillOpen ? 'stayed open' : 'closed'}; ` +
        `${err ? `inline error "${err}"` : 'no inline error'}; toast "${toast}"; stored FuelTankGallons ${before?.FuelTankGallons} → ${after?.FuelTankGallons}`
      await caption(admin, `Step R7f — result: ${observed}`)
      s = await shot(admin, 'r7f-edit-fuel-600-result')
      await cancelEdit()
    } catch (e) { admin.off('request', onReq); observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r7f-edit-fuel-600-result')
    record({ step: 'R7f', title: 'Edit truck A: type 600 in Fuel Tank (gallons), Save', expected: 'Inline error naming the fuel tank (0-500); no request sent; stored value unchanged', observed, verdict: verdict(ok), shot: s })
    await api(admin, 'PUT', putPath(), { fuel_tank_gallons: 0, avg_mpg: 0 }).catch(() => {})
  }

  // ============ R9 — the create_truck audit line names the fuel tank and MPG
  {
    let observed; let ok = false; let s
    const unit = `${UNIT}-R9`
    try {
      await reloadTrucksPage()
      const det = await openAddForm()
      await caption(admin, `Step R9 — Add Truck ${unit} with Fuel Tank 180 gal and Avg MPG 6.8 → expect the create_truck audit line to name both`)
      await field(det, 'Unit Number').fill(unit)
      await field(det, 'Status').selectOption('Active')
      await field(det, 'Fuel Tank (gallons)').fill('180')
      await field(det, 'Avg MPG (optional)').fill('6.8')
      await centerOn(det, ['button.btn-add'])
      await shot(admin, 'r9a-add-truck-fuel-mpg')
      const base = (await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')).json?.logs?.[0]?.id || 0
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === '/api/trucks' && r.request().method() === 'POST', { timeout: 30000 }),
        det.locator('button.btn-add').click(),
      ])
      const body = await resp.json().catch(() => ({}))
      if (body?.id) { created.add(body.id); meta.ids.r9Truck = body.id }
      const t = body?.id ? await getTruck(admin, body.id) : null
      const logs = (await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')).json?.logs || []
      const line = logs.find((l) => l.id > base && l.action === 'create_truck' && String(l.entity_id) === String(body?.id))
      const d = line?.details || ''
      const namesTank = /fuel tank/i.test(d) && /\b180\b/.test(d)
      const namesMpg = /mpg/i.test(d) && /\b6\.8\b/.test(d)
      await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=5')
      await caption(admin, 'Step R9 — the audit trail (entity=truck, newest first) straight after the add')
      s = await shot(admin, 'r9b-audit-create-truck', { fullPage: true })
      ok = resp.status() === 200 && t?.FuelTankGallons === 180 && t?.AvgMpg === 6.8 && namesTank && namesMpg
      observed = `POST ${resp.status()} id=${body?.id}; stored tank ${t?.FuelTankGallons}, MPG ${t?.AvgMpg}; create_truck line: ${line ? `"${d}"` : 'NOT FOUND'}; names tank 180: ${namesTank}; names MPG 6.8: ${namesMpg}`
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r9b-audit-create-truck', { fullPage: true })
    record({ step: 'R9', title: 'Super Admin adds a truck with Fuel Tank 180 and Avg MPG 6.8 (UI), then the audit trail', expected: 'The create_truck audit line names the fuel tank (180 gal) and the MPG (6.8)', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R13 — hexadecimal amounts are refused, not read as numbers
  {
    await reloadTrucksPage().catch(() => {})
    await caption(admin, 'Step R13 — API: PUT truck A insuranceMonthly "0x10", then driverPayDaily "0x10" → expect 400 each (insurance: INVALID_AMOUNT); stored values unchanged')
    const cases = [
      { id: 'R13a', key: 'insuranceMonthly', col: 'InsuranceMonthly', code: 'INVALID_AMOUNT', field: 'insurance_monthly' },
      { id: 'R13b', key: 'driverPayDaily', col: 'DriverPayDaily' },
    ]
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), { [c.key]: '0x10' })
      const after = await getTruck(admin, truckId)
      const unchanged = after?.[c.col] === before?.[c.col]
      if (!unchanged) await api(admin, 'PUT', putPath(), { [c.key]: before?.[c.col] ?? 0 })
      const reset = unchanged ? null : (await getTruck(admin, truckId))?.[c.col]
      logs.push(`${c.id} → ${r.status} ${r.json?.code || ''}`)
      const ok = r.status === 400 && (!c.code || r.json?.code === c.code) && unchanged
      record({
        step: c.id, title: `API PUT ${c.key} "0x10" (hexadecimal)`,
        expected: `400${c.code ? ` ${c.code}, field "${c.field}"` : ''}; stored value unchanged (a hexadecimal string is not an amount)`,
        observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; ` +
          `stored ${c.col} ${before?.[c.col]} → ${after?.[c.col]}${unchanged ? ' (unchanged)' : ` (CHANGED; reset to ${reset})`}`,
        verdict: verdict(ok), shot: '',
      })
    }
    await caption(admin, `Step R13 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r13-api-hex-amounts')
    rows.filter((r) => /^R13[ab]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R14 — unit numbers with control characters are refused (create and edit)
  {
    const R14_UNIT = `${UNIT}-R14`
    let target = null
    const logs = []
    try {
      await caption(admin, 'Step R14 — API: POST and PUT a unit number containing U+0007 (BEL) and one containing U+202E (right-to-left override) → expect 400 INVALID_UNIT_NUMBER, field "unitNumber", nothing created or renamed')
      // The truck the PUT cases rename (its own, so truck A keeps its unit number).
      const mk = await api(admin, 'POST', '/api/trucks', { unitNumber: R14_UNIT, status: 'Active', in_service_date: todayR, inServiceDate: todayR, assignedDriver: '' })
      if (mk.status === 200 && mk.json?.id) { target = mk.json.id; created.add(target); meta.ids.r14Truck = target }
      const cases = [
        { id: 'R14a', verb: 'POST', unit: `${R14_UNIT}\u0007A`, label: 'U+0007 (BEL)' },
        { id: 'R14b', verb: 'POST', unit: `${R14_UNIT}\u202EB`, label: 'U+202E (right-to-left override)' },
        { id: 'R14c', verb: 'PUT', unit: `${R14_UNIT}\u0007C`, label: 'U+0007 (BEL)' },
        { id: 'R14d', verb: 'PUT', unit: `${R14_UNIT}\u202ED`, label: 'U+202E (right-to-left override)' },
      ]
      for (const c of cases) {
        let r; let effect
        if (c.verb === 'POST') {
          r = await api(admin, 'POST', '/api/trucks', { unitNumber: c.unit, status: 'Active' })
          const made = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || []).find((t) => t.UnitNumber === c.unit)
          if (made) { created.add(made.id); const d = await api(admin, 'DELETE', `/api/trucks/${made.id}`); if (d.status === 200) created.delete(made.id) }
          effect = { changed: !!made, text: made ? `truck CREATED (#${made.id}) with the character in its unit number — deleted again` : 'no truck created' }
        } else if (!target) {
          r = { status: 0, json: null, text: 'no target truck (its POST failed)' }
          effect = { changed: false, text: 'not run' }
        } else {
          r = await api(admin, 'PUT', `/api/trucks/${target}`, { unitNumber: c.unit })
          const now = (await getTruck(admin, target))?.UnitNumber
          const renamed = now !== R14_UNIT
          if (renamed) await api(admin, 'PUT', `/api/trucks/${target}`, { unitNumber: R14_UNIT })
          effect = { changed: renamed, text: renamed ? 'truck RENAMED to a unit number carrying the character — renamed back' : 'unit number unchanged' }
        }
        logs.push(`${c.id} ${c.verb} → ${r.status} ${r.json?.code || ''}`)
        const ok = r.status === 400 && r.json?.code === 'INVALID_UNIT_NUMBER' && r.json?.field === 'unitNumber' && !effect.changed
        record({
          step: c.id, title: `API ${c.verb} a unit number containing ${c.label}`,
          expected: `400 INVALID_UNIT_NUMBER, field "unitNumber"; ${c.verb === 'POST' ? 'no truck created' : 'the unit number unchanged'}`,
          observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; ${effect.text}`,
          verdict: verdict(ok), shot: '',
        })
      }
    } catch (e) {
      record({ step: 'R14', title: 'Unit numbers with control characters', expected: '400 INVALID_UNIT_NUMBER', observed: `error: ${e.message}`, verdict: 'FAIL', shot: '' })
    } finally {
      if (target) { const d = await api(admin, 'DELETE', `/api/trucks/${target}`).catch(() => null); if (d?.status === 200) created.delete(target) }
    }
    await caption(admin, `Step R14 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r14-api-unit-control-chars')
    rows.filter((r) => /^R14[a-d]?$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R8 — an Investor's add ignores the fuel pair (third browser context)
  if (!CREDS.investor) {
    record({ step: 'R8', title: 'Investor POST /api/trucks with fuel_tank_gallons 400', expected: 'Created with FuelTankGallons 0', observed: 'SKIPPED — no investor login in the creds file', verdict: 'SKIP', shot: '' })
  } else {
    let observed; let ok = false; let s
    let inv = null
    try {
      investorCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      investorCtx.setDefaultTimeout(20000)
      inv = await investorCtx.newPage()
      await login(inv, 'Step R8 — Investor', CREDS.investor.username, CREDS.investor.password, '/investor')
      const sess = (await api(inv, 'GET', '/api/auth/session')).json?.user || null
      meta.ids.investorUser = sess?.id
      await caption(inv, `Step R8 — Investor: POST /api/trucks {unitNumber:"${INV_UNIT}", fuel_tank_gallons:400} from the investor's own page → expect it created with FuelTankGallons 0`)
      const r = await api(inv, 'POST', '/api/trucks', { unitNumber: INV_UNIT, fuel_tank_gallons: 400 })
      if (r.json?.id) { created.add(r.json.id); meta.ids.investorTruck = r.json.id }
      const mine = ((await api(inv, 'GET', '/api/trucks')).json?.trucks || []).find((t) => t.UnitNumber === INV_UNIT)
      // The investor's own Trucks page: the Tank column of the new row.
      await inv.goto(`${BASE_URL}/trucks`)
      await inv.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const irow = rowOf(inv, INV_UNIT)
      await irow.waitFor({ state: 'visible', timeout: 20000 })
      await irow.scrollIntoViewIfNeeded()
      const tankIdx = await inv.locator('table.truck-table thead th').evaluateAll((ths) => ths.findIndex((th) => th.textContent.trim() === 'Tank'))
      const tankCell = tankIdx >= 0 ? (await irow.locator('td').nth(tankIdx).innerText()).trim() : '(no Tank column)'
      ok = r.status === 200 && !!mine && mine.FuelTankGallons === 0
      observed = `POST ${r.status} id=${r.json?.id ?? '-'}; stored FuelTankGallons ${mine ? mine.FuelTankGallons : '(truck not listed)'}` +
        `${mine ? `, owner ${mine.OwnerId === CREDS.investor.userId ? 'is the investor' : `#${mine.OwnerId}`}` : ''}; the investor's Trucks page shows Tank "${tankCell}"`
      await caption(inv, `Step R8 — result: ${observed}`)
      s = await shot(inv, 'r8-investor-add-ignores-fuel')
    } catch (e) { observed = `error: ${e.message}` }
    if (!s && inv) s = await shot(inv, 'r8-investor-add-ignores-fuel')
    record({ step: 'R8', title: `Investor (third context) POST /api/trucks {unitNumber:"QA-TEST-INV-…", fuel_tank_gallons:400}`, expected: 'Created (200) with FuelTankGallons 0 — an Investor\'s add ignores the fuel pair; Trucks page shows "200 gal (default)"', observed, verdict: verdict(ok), shot: s })
    await investorCtx?.close().catch(() => {})
    investorCtx = null
  }

  // ============ Step 9 — Driver logs in; truck photo visible
  driverCtx = await browser.newContext({ viewport: { width: DVW, height: DVH }, isMobile: false })
  driverCtx.setDefaultTimeout(20000)
  driver = await driverCtx.newPage()
  const photoResponses = []
  const idResponses = []
  driver.on('response', (r) => {
    const p = new URL(r.url()).pathname
    if (p === '/api/driver/me/truck-photo') photoResponses.push({ status: r.status(), ct: r.headers()['content-type'] || '' })
    if (p.startsWith('/api/driver/me/identity-file/')) idResponses.push({ path: p, status: r.status(), ct: r.headers()['content-type'] || '' })
  })
  let session = null
  let driverTruckIds = []
  let appId = null
  {
    let observed; let ok = false; let s
    try {
      await login(driver, 'Step 9 — Driver', CREDS.driver.username, CREDS.driver.password, '/driver')
      session = (await api(driver, 'GET', '/api/auth/session')).json?.user || null
      meta.ids.driverUser = session?.id
      if (db && session?.driverName) {
        driverTruckIds = db.prepare('SELECT id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)').all(session.driverName).map((r) => r.id)
        appId = db.prepare('SELECT application_id FROM driver_onboarding WHERE user_id = ?').get(session.id)?.application_id || null
        meta.ids.driverTruck = driverTruckIds.join('+')
        meta.ids.application = appId
      }
      await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
      await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
      await driver.locator('.loading-skeletons').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {})
      await caption(driver, 'Step 9 — Driver signed in → open a load, expand "Truck Details" → expect the truck photo (image/jpeg)')
      // Find a sub-tab that has loads.
      let opened = false
      for (const tab of await driver.locator('.load-sub-tabs .sub-tab').all()) {
        const n = Number((await tab.locator('.sub-tab-count').innerText().catch(() => '0')).trim()) || 0
        if (n > 0) {
          await tab.click()
          const card = driver.locator('.load-card').first()
          await card.waitFor({ state: 'visible', timeout: 15000 })
          await card.click()
          opened = true
          break
        }
      }
      if (opened) {
        const item = driver.locator('.van-collapse-item').filter({ hasText: 'Truck Details' }).first()
        await item.waitFor({ state: 'visible', timeout: 20000 })
        const title = item.locator('.van-collapse-item__title').first()
        await title.scrollIntoViewIfNeeded()
        if ((await title.getAttribute('aria-expanded')) !== 'true') await title.click()
        const img = item.locator('img.truck-photo')
        await img.waitFor({ state: 'visible', timeout: 20000 })
        await img.scrollIntoViewIfNeeded()
        const nat = await img.evaluate(async (el) => { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; setTimeout(r, 8000) }); return { w: el.naturalWidth, h: el.naturalHeight, src: el.getAttribute('src').slice(0, 40) } })
        await driver.waitForTimeout(300)
        const last = photoResponses[photoResponses.length - 1]
        ok = nat.w > 0 && !!last && last.status === 200 && /^image\/jpeg/i.test(last.ct)
        observed = `via the UI (load detail → Truck Details): <img src="${nat.src}"> rendered ${nat.w}×${nat.h}; response ${last ? `${last.status} ${last.ct}` : 'not seen'}`
        await caption(driver, `Step 9 — result: ${observed}`)
      } else {
        const nav = await navigate(driver, `/api/driver/me/truck-photo?qa=9-${stamp}`)
        const nat = await driver.evaluate(() => { const i = document.querySelector('img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null })
        ok = nav.status === 200 && /^image\/jpeg/i.test(nav.contentType) && nat?.w > 0
        observed = `no load in any sub-tab, so navigated to /api/driver/me/truck-photo: ${nav.status} ${nav.contentType}, rendered ${nat ? `${nat.w}×${nat.h}` : 'nothing'}`
        await caption(driver, `Step 9 — (no loads) ${observed}`)
      }
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(driver, '09-driver-truck-photo')
    record({ step: '9', title: 'Driver logs in; the truck photo is visible', expected: 'Image renders; served as image/jpeg (both phases)', observed, verdict: verdict(ok), shot: s })
  }

  // Guard for steps 10-11: DB_PATH must be the database THIS server reads, or
  // every planted case would silently test nothing. Write a sentinel into the
  // test truck's notes (our own row) and read it back through the API.
  if (db && truckId) {
    const sentinel = `qa-sentinel-${stamp}-${Math.random().toString(36).slice(2, 8)}`
    let reason = ''
    try {
      // Only ever touches THIS run's test truck (matched by id AND unit number).
      const mine = db.prepare('SELECT notes FROM trucks WHERE id = ? AND unit_number = ?').get(truckId, UNIT)
      if (!mine) throw new Error(`this run's test truck (#${truckId}) is not in DB_PATH`)
      db.prepare('UPDATE trucks SET notes = ? WHERE id = ? AND unit_number = ?').run(sentinel, truckId, UNIT)
      const seen = (await getTruck(admin, truckId))?.Notes
      db.prepare('UPDATE trucks SET notes = ? WHERE id = ? AND unit_number = ?').run(mine.notes, truckId, UNIT)
      if (seen !== sentinel) reason = `a value written to DB_PATH did not appear through the API (saw ${JSON.stringify(seen)})`
    } catch (e) { reason = e.message }
    if (reason) {
      record({ step: '10*', title: 'DB_PATH sanity check', expected: 'The server reads DB_PATH', observed: `${reason} — DB_PATH is not this server's DATABASE_PATH; planted cases skipped`, verdict: 'FAIL', shot: '' })
      try { db.close() } catch { /* ignore */ }
      db = null
    }
  }

  // ============ R16 — two renames to case variants of one unit number, at the same moment.
  // Local only: each save also assigns a throwaway driver (QA-TEST-DRV-…), so the
  // route's active-load check (a live read of the sheet) runs inside each save, and
  // the rows that assignment writes are deleted again through DB_PATH.
  {
    const title = 'Two test trucks renamed at the same moment to case variants of one new unit number, each save also assigning a throwaway driver'
    const expected = 'Exactly one 200 and one 400 "Unit number already exists"; never two trucks sharing the unit number case-insensitively'
    if (!db) {
      record({ step: 'R16', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      let observed = ''; let v = 'FAIL'; let s = ''
      const ids = []
      const drivers = [`${QA_DRIVER_PREFIX}${stamp}-A`, `${QA_DRIVER_PREFIX}${stamp}-B`]
      const target = `${UNIT}-R16-DUP`
      const variants = [target, `${UNIT}-r16-dup`] // the same unit, case-insensitively
      try {
        for (const suffix of ['R16A', 'R16B']) {
          const r = await api(admin, 'POST', '/api/trucks', { unitNumber: `${UNIT}-${suffix}`, status: 'Active', in_service_date: todayR, inServiceDate: todayR, assignedDriver: '' })
          if (r.status !== 200 || !r.json?.id) throw new Error(`could not create ${suffix}: ${r.status}`)
          ids.push(r.json.id); created.add(r.json.id)
        }
        meta.ids.r16Trucks = ids.join('+')
        await reloadTrucksPage().catch(() => {})
        await caption(admin, `Step R16 — two page fetches at the same moment: truck #${ids[0]} → "${variants[0]}", truck #${ids[1]} → "${variants[1]}", each also assigning a throwaway driver → expect one 200 and one 400 "Unit number already exists"`)
        // Both requests leave the page in the same tick; each one's timing is its own.
        const res = await admin.evaluate(async (jobs) => {
          const put = async ({ id, body }) => {
            const t0 = performance.now()
            const r = await fetch(`/api/trucks/${id}`, {
              method: 'PUT', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              body: JSON.stringify(body),
            })
            const text = await r.text()
            let json = null
            try { json = JSON.parse(text) } catch { /* not json */ }
            return { status: r.status, error: json?.error || '', ms: Math.round(performance.now() - t0) }
          }
          return Promise.all(jobs.map(put))
        }, ids.map((id, i) => ({ id, body: { unitNumber: variants[i], assignedDriver: drivers[i] } })))
        const list = (await api(admin, 'GET', '/api/trucks')).json?.trucks || []
        const sharing = list.filter((t) => (t.UnitNumber || '').toLowerCase() === target.toLowerCase())
        const ok200 = res.filter((r) => r.status === 200)
        const dup400 = res.filter((r) => r.status === 400 && /unit number already exists/i.test(r.error))
        const outcome = res.map((r, i) => `#${ids[i]} → ${r.status}${r.error ? ` "${r.error.slice(0, 70)}"` : ''} in ${r.ms} ms`).join('; ')
        observed = `${outcome}; trucks now carrying the unit number (case-insensitively): ${sharing.length}${sharing.length ? ` (${sharing.map((t) => `#${t.id}`).join(', ')})` : ''}`
        if (sharing.length >= 2 || ok200.length === 2) {
          v = 'FAIL'
        } else if (ok200.length === 1 && dup400.length === 1 && sharing.length === 1) {
          // Did the two saves overlap inside the server? The refused one waited out
          // the sheet read like the other (it was refused after it) — or it answered
          // before the sheet could have (it was refused up front, after the other's
          // write had landed, so they never overlapped and the race was not staged).
          const overlapped = dup400[0].ms >= 0.5 * ok200[0].ms
          v = overlapped ? 'PASS' : 'PASS (vacuous)'
          if (!overlapped) observed += ' — vacuous: the refused save answered long before the other, so the two did not overlap in the server'
        } else if (res.some((r) => r.status >= 500)) {
          v = 'INFO'
          observed += ' — not scored: a save failed (e.g. the active-load check could not read the sheet), so the race was not staged'
        } else {
          v = 'FAIL'
        }
        await reloadTrucksPage().catch(() => {})
        await caption(admin, `Step R16 — result: ${observed}`)
        s = await shot(admin, 'r16-concurrent-case-variant-renames')
      } catch (e) {
        observed = `${observed ? `${observed}; ` : ''}error: ${e.message}`
        v = 'FAIL'
      } finally {
        // The throwaway drivers' rows first (a truck with an assignment row cannot be
        // deleted), then the two trucks.
        const n = (() => { try { return removeQaDriverRows(drivers) } catch (e) { return { error: e.message } } })()
        const del = []
        for (const id of ids) {
          const d = await api(admin, 'DELETE', `/api/trucks/${id}`).catch(() => ({ status: 0 }))
          del.push(`#${id} → ${d.status}`)
          if (d.status === 200) created.delete(id)
        }
        observed += `. Clean-up: throwaway-driver rows deleted ${JSON.stringify(n)}; DELETE ${del.join(', ')}`
      }
      if (!s) s = await shot(admin, 'r16-concurrent-case-variant-renames')
      record({ step: 'R16', title, expected, observed, verdict: v, shot: s })
    }
  }

  // ============ Step 10 — Planted non-image truck photos, served to the driver
  {
    const expectFor = (k) => (k === 'pngAsJpeg' ? '200, Content-Type image/png — the image renders' : '404 JSON (application/json)')
    const order = ['html', 'svg', 'htmlAsJpeg', 'pngAsJpeg', 'malformed']
    if (!db || !driverTruckIds.length) {
      for (const [i, k] of order.entries()) {
        record({ step: `10${'abcde'[i]}`, title: `Truck photo planted as ${PLANTS[k].label}`, expected: expectFor(k), observed: db ? 'no truck is assigned to this driver' : skipWhy(), verdict: 'SKIP', shot: '' })
      }
    } else {
      try {
        for (const [i, k] of order.entries()) {
          const id = `10${'abcde'[i]}`
          for (const tid of driverTruckIds) plant('trucks', 'photo', tid, PLANTS[k].value)
          const nav = await navigate(driver, `/api/driver/me/truck-photo?qa=${id}-${stamp}`)
          const rendered = await driver.evaluate(() => { const i = document.querySelector('body > img, img'); return i ? i.naturalWidth : null }).catch(() => null)
          const ok = k === 'pngAsJpeg'
            ? nav.status === 200 && /^image\/png/i.test(nav.contentType) && rendered > 0
            : nav.status === 404 && nav.isJson
          const observed = `${nav.status} ${nav.contentType || '(no content-type)'}${rendered !== null ? `; <img> naturalWidth ${rendered}` : ''}${nav.isJson ? `; body ${nav.bodyHead}` : /html/i.test(nav.contentType) ? '; the planted HTML was rendered as a page' : ''}`
          await caption(driver, `Step ${id} — truck photo planted as ${PLANTS[k].label} → GET /api/driver/me/truck-photo answered ${nav.status} ${nav.contentType}; expected ${expectFor(k)}`)
          const s = await shot(driver, `${id}-truck-photo-${k}`)
          record({ step: id, title: `Truck photo planted as ${PLANTS[k].label}; driver opens /api/driver/me/truck-photo`, expected: expectFor(k), observed, verdict: verdict(ok), shot: s })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
      }
    }
  }

  // ============ Step 11 — Driver Kit: CDL renders; planted non-image CDL is refused
  {
    let observed; let ok = false; let s
    try {
      await driver.goto(`${BASE_URL}/driver`)
      await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
      await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
      const kit = driver.locator('.van-tabbar-item', { hasText: 'Kit' })
      idResponses.length = 0
      await kit.click()
      await caption(driver, 'Step 11a — Driver Kit tab → expect the CDL (My Identity Documents) to render')
      const card = driver.locator('.kit-files-card', { hasText: 'My Identity Documents' })
      await card.waitFor({ state: 'visible', timeout: 30000 })
      await card.scrollIntoViewIfNeeded()
      const t0 = Date.now()
      while (!idResponses.some((r) => r.path.endsWith('/cdl-front')) && Date.now() - t0 < 10000) await driver.waitForTimeout(200)
      const net = idResponses.find((r) => r.path.endsWith('/cdl-front'))
      const dec = await driver.evaluate(async () => {
        const img = new Image()
        img.src = '/api/driver/me/identity-file/cdl-front'
        try { await img.decode(); return { ok: true, w: img.naturalWidth, h: img.naturalHeight } } catch { return { ok: false } }
      })
      ok = !!net && net.status === 200 && /^image\//i.test(net.ct) && dec.ok && dec.w > 0
      observed = `CDL Front thumbnail request ${net ? `${net.status} ${net.ct}` : 'not seen'}; decodes as an image: ${dec.ok ? `${dec.w}×${dec.h}` : 'no'}`
      await caption(driver, `Step 11a — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(driver, '11a-driver-kit-cdl', { mask: [driver.locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
    record({ step: '11a', title: 'Driver Kit tab: CDL Front renders', expected: 'Renders; served as image/* (both phases)', observed, verdict: verdict(ok), shot: s })

    const cdlCases = [
      { id: '11b', k: 'html', expect: '404', note: 'required case' },
      { id: '11c', k: 'htmlAsJpeg', expect: '404' },
      { id: '11d', k: 'malformed', expect: '404' },
      { id: '11e', k: 'pngAsJpeg', expect: 'png' },
      { id: '11f', k: 'pdf', expect: 'pdf' },
    ]
    const expText = (e) => (e === '404' ? '404 JSON' : e === 'png' ? '200 image/png (bytes are a PNG)' : '200 application/pdf (regression — a real PDF CDL still serves)')
    if (!db || !appId) {
      for (const c of cdlCases) record({ step: c.id, title: `CDL front planted as ${PLANTS[c.k].label}`, expected: expText(c.expect), observed: db ? 'driver has no application' : skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      try {
        for (const c of cdlCases) {
          plant('job_applications', 'cdl_front', appId, PLANTS[c.k].value)
          const nav = await navigate(driver, `/api/driver/me/identity-file/cdl-front?qa=${c.id}-${stamp}`)
          const ok = c.expect === '404' ? nav.status === 404 && nav.isJson
            : c.expect === 'png' ? nav.status === 200 && /^image\/png/i.test(nav.contentType)
              : nav.status === 200 && /^application\/pdf/i.test(nav.contentType)
          const observed = `${nav.status} ${nav.contentType || '(no content-type)'}${nav.isJson ? `; body ${nav.bodyHead}` : /html/i.test(nav.contentType) ? '; the planted HTML was rendered as a page' : ''}${nav.download ? ' (the browser handled it as a download; status read with an in-page fetch)' : ''}`
          await caption(driver, `Step ${c.id} — CDL front planted as ${PLANTS[c.k].label} → GET /api/driver/me/identity-file/cdl-front answered ${nav.status} ${nav.contentType}; expected ${expText(c.expect)}`)
          const shotName = `${c.id}-cdl-front-${c.k}`
          const sh = await shot(driver, shotName)
          record({ step: c.id, title: `CDL front planted as ${PLANTS[c.k].label}; driver opens /api/driver/me/identity-file/cdl-front`, expected: expText(c.expect), observed, verdict: verdict(ok), shot: sh })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
      }
    }
  }

  // ============ R3 — identity PDFs are served as attachments; images stay inline (planted, local only)
  {
    const JPEG_DATA_R3 = `data:image/jpeg;base64,${IMG.jpeg.toString('base64')}`
    const cases = [
      { id: 'R3a', k: 'pdf', label: 'a real PDF (data:application/pdf)', value: PLANTS.pdf.value, expected: '200 application/pdf with Content-Disposition: attachment; filename="CDL-Front.pdf" (the Kit\'s own name; tapping the Kit card downloads CDL-Front.pdf)' },
      { id: 'R3b', k: 'jpeg', label: 'a real JPEG (data:image/jpeg)', value: JPEG_DATA_R3, expected: '200 image/jpeg with no attachment header — served inline; the Kit thumbnail renders' },
    ]
    if (!db || !appId) {
      for (const c of cases) record({ step: c.id, title: `CDL front planted as ${c.label}; the driver requests /api/driver/me/identity-file/cdl-front`, expected: c.expected, observed: db ? 'driver has no application' : skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      // The route answers Cache-Control: private, max-age=3600, and the Kit
      // tab's own URL has no cache-buster: keep every earlier response of it
      // (the real CDL, step 11a) from answering for a planted value.
      const cdp = await driverCtx.newCDPSession(driver)
      await cdp.send('Network.enable').catch(() => {})
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
      let pdfAttachment = false
      try {
        for (const c of cases) {
          let observed; let ok = false; let s
          try {
            plant('job_applications', 'cdl_front', appId, c.value)
            await cdp.send('Network.clearBrowserCache').catch(() => {})
            // A fresh driver payload, so the Kit card shows the planted type.
            await driver.goto(`${BASE_URL}/driver`)
            await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
            await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
            await driver.locator('.van-tabbar-item', { hasText: 'Kit' }).click()
            const card = driver.locator('.kit-files-card', { hasText: 'My Identity Documents' }).locator('.kit-file-card', { hasText: 'CDL Front' })
            await card.waitFor({ state: 'visible', timeout: 30000 })
            await card.scrollIntoViewIfNeeded()
            const cardType = (await card.locator('.kit-file-type').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
            // What the server sends (no cache), read in the signed-in page.
            const h = await driver.evaluate(async () => {
              const r = await fetch('/api/driver/me/identity-file/cdl-front', { cache: 'no-store', credentials: 'same-origin' })
              await r.arrayBuffer()
              return { status: r.status, ct: r.headers.get('content-type') || '', cd: r.headers.get('content-disposition') }
            })
            let ui = ''
            if (c.k === 'pdf') {
              await caption(driver, `Step ${c.id} — CDL Front planted as ${c.label}; the Kit card reads "${cardType}" → tap it`)
              const dl = await clickForDownload(driverCtx, driver, card)
              if (dl) {
                const p = await dl.path().catch(() => null)
                const head = p ? fs.readFileSync(p).subarray(0, 5).toString('latin1') : ''
                ui = `tapping the card downloaded "${dl.suggestedFilename()}"${head ? ` (${head === '%PDF-' ? 'the planted PDF' : `bytes "${head}"`})` : ''}`
                await dl.delete().catch(() => {})
              } else ui = 'tapping the card started no download within 15 s'
              pdfAttachment = /attachment/i.test(h.cd || '')
              ok = h.status === 200 && /^application\/pdf/i.test(h.ct) && /^attachment\s*;\s*filename="cdl-front\.pdf"(\s*;.*)?$/i.test(h.cd || '')
            } else {
              const dec = await driver.evaluate(async () => {
                const img = new Image()
                img.src = '/api/driver/me/identity-file/cdl-front'
                try { await img.decode(); return { ok: true, w: img.naturalWidth, h: img.naturalHeight } } catch { return { ok: false } }
              })
              ui = `the Kit card reads "${cardType}" and its image ${dec.ok ? `decodes ${dec.w}×${dec.h}` : 'does NOT decode'}`
              ok = h.status === 200 && /^image\/jpeg/i.test(h.ct) && !/attachment/i.test(h.cd || '') && dec.ok
            }
            observed = `${h.status} ${h.ct}; Content-Disposition: ${h.cd === null ? '(none)' : `"${h.cd}"`}; ${ui}`
            await caption(driver, `Step ${c.id} — result: ${observed}`)
            // Mask the driver's real documents and avatar; the planted CDL Front card is a test fixture.
            s = await shot(driver, `${c.id.toLowerCase()}-cdl-front-${c.k}`, { mask: [driver.locator('.kit-file-card').filter({ hasNotText: 'CDL Front' }).locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
          } catch (e) { observed = `error: ${e.message}` }
          const v = c.k === 'jpeg' && ok && !pdfAttachment ? 'PASS (vacuous)' : verdict(ok)
          if (v === 'PASS (vacuous)') observed += ' — vacuous: this build sends no attachment header even for the PDF (see R3a)'
          record({ step: c.id, title: `CDL front planted as ${c.label}; the driver requests /api/driver/me/identity-file/cdl-front`, expected: c.expected, observed, verdict: v, shot: s })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {})
        await cdp.detach().catch(() => {})
      }
    }
  }

  // ============ R10 — driver file routes: the CDL is never kept by the browser;
  // the truck photo is revalidated with the server (and so the session) on every use.
  {
    let observed; let ok = false; let s = ''
    try {
      const h = await driver.evaluate(async () => {
        const out = {}
        const r1 = await fetch('/api/driver/me/identity-file/cdl-front', { cache: 'no-store', credentials: 'same-origin' })
        await r1.arrayBuffer()
        out.id = { status: r1.status, cc: r1.headers.get('cache-control') }
        const r2 = await fetch('/api/driver/me/truck-photo', { cache: 'no-store', credentials: 'same-origin' })
        await r2.arrayBuffer()
        out.photo = { status: r2.status, cc: r2.headers.get('cache-control'), etag: r2.headers.get('etag') }
        if (out.photo.etag) {
          const r3 = await fetch('/api/driver/me/truck-photo', { cache: 'no-store', credentials: 'same-origin', headers: { 'If-None-Match': out.photo.etag } })
          const b = await r3.arrayBuffer()
          out.reval = { status: r3.status, bytes: b.byteLength }
        }
        return out
      })
      // No identity file on this server's data (staging's refresh strips them) → not scored.
      const idOk = h.id.status === 404 ? null : /^private,\s*no-store$/i.test(h.id.cc || '')
      const photoOk = h.photo.status === 200 && /^private,\s*no-cache$/i.test(h.photo.cc || '') && !!h.photo.etag &&
        !!h.reval && h.reval.status === 304 && h.reval.bytes === 0
      ok = photoOk && idOk !== false
      observed = `identity-file ${h.id.status} Cache-Control: ${h.id.cc === null ? '(none)' : `"${h.id.cc}"`}` +
        `${idOk === null ? ' (no identity file on this server — not scored)' : ''}; ` +
        `truck-photo ${h.photo.status} Cache-Control: ${h.photo.cc === null ? '(none)' : `"${h.photo.cc}"`}, ETag ${h.photo.etag ? 'present' : '(none)'}` +
        `${h.reval ? `; revalidation with If-None-Match → ${h.reval.status} (${h.reval.bytes} bytes)` : ''}`
      await caption(driver, `Step R10 — cache headers: ${observed}`)
      s = await shot(driver, 'r10-cache-headers', { mask: [driver.locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
    } catch (e) { observed = `error: ${e.message}` }
    record({
      step: 'R10',
      title: 'Driver file routes: the CDL is never kept by the browser; the truck photo is revalidated on every use',
      expected: 'identity-file Cache-Control "private, no-store"; truck-photo "private, no-cache" with an ETag, and a matching If-None-Match answers 304 with no body',
      observed, verdict: verdict(ok), shot: s,
    })
  }

  // ============ R15 — the driver's "has a photo" follows the stored bytes (planted, local only)
  {
    const title = 'Truck photo planted as HTML bytes under a data:image/jpeg label; the driver reads GET /api/driver/<name> truck.has_photo, then opens Truck Details'
    const expected = 'truck.has_photo 0 (the stored value is not an image, so the app offers no photo)'
    if (!db || !driverTruckIds.length || !session?.driverName) {
      record({ step: 'R15', title, expected, observed: db ? 'no truck is assigned to this driver' : skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      let observed; let ok = false; let s = ''
      try {
        for (const tid of driverTruckIds) plant('trucks', 'photo', tid, PLANTS.htmlAsJpeg.value)
        const r = await api(driver, 'GET', `/api/driver/${encodeURIComponent(session.driverName)}`)
        const hp = r.json?.truck ? r.json.truck.has_photo : '(no truck in the payload)'
        // The same payload through the UI: a fresh driver app, a load's Truck Details.
        let ui = '(not read)'
        try {
          await driver.goto(`${BASE_URL}/driver`)
          await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
          await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
          await driver.locator('.loading-skeletons').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {})
          let opened = false
          for (const tab of await driver.locator('.load-sub-tabs .sub-tab').all()) {
            const n = Number((await tab.locator('.sub-tab-count').innerText().catch(() => '0')).trim()) || 0
            if (n > 0) { await tab.click(); const card = driver.locator('.load-card').first(); await card.waitFor({ state: 'visible', timeout: 15000 }); await card.click(); opened = true; break }
          }
          if (opened) {
            const item = driver.locator('.van-collapse-item').filter({ hasText: 'Truck Details' }).first()
            await item.waitFor({ state: 'visible', timeout: 20000 })
            const head = item.locator('.van-collapse-item__title').first()
            await head.scrollIntoViewIfNeeded()
            if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
            await driver.waitForTimeout(1500)
            const img = item.locator('img.truck-photo')
            if (await img.count()) {
              const w = await img.first().evaluate(async (el) => { if (!el.complete) await new Promise((res) => { el.onload = el.onerror = res; setTimeout(res, 8000) }); return el.naturalWidth })
              ui = `Truck Details shows a photo element${w > 0 ? ` that renders (${w} px wide)` : ' that does NOT render (a broken image)'}`
            } else ui = 'Truck Details shows no photo element'
            await item.scrollIntoViewIfNeeded()
          } else ui = 'no load in any sub-tab, so Truck Details could not be opened'
        } catch (e) { ui = `(UI read failed: ${e.message.split('\n')[0]})` }
        ok = r.status === 200 && Number(hp) === 0
        observed = `GET /api/driver/<the driver's name> → ${r.status}; truck.has_photo ${JSON.stringify(hp)}; ${ui}`
        await caption(driver, `Step R15 — photo planted as ${PLANTS.htmlAsJpeg.label}: ${observed}`)
        s = await shot(driver, 'r15-has-photo-follows-bytes')
      } catch (e) { observed = `error: ${e.message}` } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
      }
      if (!s) s = await shot(driver, 'r15-has-photo-follows-bytes')
      record({ step: 'R15', title, expected, observed, verdict: verdict(ok), shot: s })
    }
  }

  // ============ R12 — the unused driver-files route is gone: it answers no files
  {
    const title = 'Super Admin page fetch of GET /api/trucks/<the driver\'s truck>/driver-files'
    const expected = 'No files come back (404, or any answer that is not the driver-files payload); the exact answer is recorded'
    let observed; let v = 'FAIL'; let s = ''
    try {
      const list = (await api(admin, 'GET', '/api/trucks')).json?.trucks || []
      const name = String(session?.driverName || '').trim().toLowerCase()
      const t = (name && list.find((x) => String(x.AssignedDriver || '').trim().toLowerCase() === name)) ||
        list.find((x) => String(x.id) === String(CREDS.driver.truckId)) || null
      if (!t) throw new Error('no truck is assigned to the harness driver')
      meta.ids.driverFilesTruck = t.id
      // Summarized in the page: the documents themselves never leave it.
      const r = await admin.evaluate(async (id) => {
        const res = await fetch(`/api/trucks/${id}/driver-files`, { credentials: 'same-origin', cache: 'no-store' })
        const ct = res.headers.get('content-type') || ''
        const text = await res.text()
        let j = null
        try { j = JSON.parse(text) } catch { /* not json */ }
        const files = Array.isArray(j?.files) ? j.files.map((f) => ({ label: f.label, type: f.type, chars: String(f.data || '').length })) : null
        return {
          status: res.status, ct, bytes: text.length, isJson: !!j,
          keys: j && typeof j === 'object' ? Object.keys(j) : [],
          files, onboardingDocs: Array.isArray(j?.onboardingDocs) ? j.onboardingDocs.length : null,
          drugTest: j?.drugTest ? 'present' : (j && 'drugTest' in j ? 'none' : null),
          error: typeof j?.error === 'string' ? j.error.slice(0, 80) : '',
          htmlTitle: !j && /html/i.test(ct) ? ((text.match(/<title>([^<]{0,60})/i) || [])[1] || '(untitled)') : '',
        }
      }, t.id)
      const isPayload = r.isJson && Array.isArray(r.files)
      const anyFiles = isPayload && (r.files.length > 0 || r.onboardingDocs > 0 || r.drugTest === 'present')
      if (isPayload && anyFiles) v = 'FAIL'
      else if (isPayload) v = 'PASS (vacuous)'
      else v = 'PASS'
      observed = `truck #${t.id}: ${r.status} ${r.ct.split(';')[0] || '(no content-type)'} (${r.bytes} bytes)` +
        (isPayload
          ? `; the driver-files payload [${r.keys.join(', ')}]: ${r.files.length} file(s)${r.files.length ? ` (${r.files.map((f) => `${f.label} ${f.type || '?'} ${f.chars} chars`).join(', ')})` : ''}, ${r.onboardingDocs} onboarding doc(s), drug test ${r.drugTest}`
          : r.isJson ? `; JSON [${r.keys.join(', ')}]${r.error ? ` error "${r.error}"` : ''}` : r.htmlTitle ? `; an HTML page titled "${r.htmlTitle}" (the SPA's catch-all), no JSON` : '; not JSON')
      if (v === 'PASS (vacuous)') observed += ' — vacuous: the route still answers, but this driver has no files on this server'
      await reloadTrucksPage().catch(() => {})
      await caption(admin, `Step R12 — GET /api/trucks/${t.id}/driver-files → ${observed}`)
      s = await shot(admin, 'r12-driver-files-route')
    } catch (e) { observed = `error: ${e.message}`; v = 'FAIL' }
    if (!s) s = await shot(admin, 'r12-driver-files-route')
    record({ step: 'R12', title, expected, observed, verdict: v, shot: s })
  }
}

// ================================================================ sign-out / sign-in section (S1-S7)
// Run alone with ONLY=signout. The fix under test (the AFTER behaviour):
//   (a) sign-out finishes with a full page load of /login (location.replace);
//   (b) signing in as a DIFFERENT person than the page last showed (e.g. after a
//       session expired without a sign-out) finishes with a full page load of that
//       person's home page;
//   (c) the same person again, or a first sign-in on a fresh page, keeps today's
//       in-app navigation.
// The evidence is a JS global planted on the page, window.__qaMarker: a full page
// load discards it; an in-app route change (router.push) keeps it.
// Each case gets its own browser context, so no case inherits another's cookie.
const MARK = 'page-1'
const NO_MARK = 'undefined'
const THROTTLE = { latencyMs: Number(process.env.S3_LATENCY_MS || 2500), kbps: Number(process.env.S3_KBPS || 24) }
// ⚠️ Mirror of server.js BROKER_WITHHELD_RE: the columns /api/dashboard blanks for
// every role but Super Admin — the one thing in that payload only a Super Admin gets.
const BROKER_WITHHELD_RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i

// page.evaluate that survives the moment a navigation replaces the document.
async function evalSafe(page, fn, arg) {
  for (let i = 0; ; i++) {
    try { return await page.evaluate(fn, arg) } catch (e) {
      if (i >= 20 || !/context was destroyed|navigat|Cannot find context|frame was detached/i.test(e.message)) throw e
      await page.waitForTimeout(250)
    }
  }
}
const plantMarker = (page) => evalSafe(page, (m) => { window.__qaMarker = m }, MARK)
const readMarker = (page) => evalSafe(page, () => (window.__qaMarker === undefined ? 'undefined' : String(window.__qaMarker)))
const markerText = (m) => (m === NO_MARK ? 'undefined (a fresh page: it was loaded again)' : `'${m}' (the same page: an in-app route change, no reload)`)

// Main-frame document requests from now on: a full page load makes one, an in-app route change none.
// `times` holds when each was sent (Date.now()), for the timings S5b and S5c report.
function trackDocuments(page) {
  const docs = []
  const times = []
  const on = (r) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) { docs.push(new URL(r.url()).pathname); times.push(Date.now()) }
  }
  page.on('request', on)
  return { docs, times, stop: () => page.off('request', on) }
}
const docsText = (d) => (d.length ? `${d.length} (${d.join(', ')})` : 'none')

// Who the server says this browser is (ids and roles only).
async function whoAmI(page) {
  const r = await api(page, 'GET', '/api/auth/session')
  return r.json?.authenticated
    ? { id: r.json.user?.id ?? null, text: `${r.json.user?.role} #${r.json.user?.id}` }
    : { id: null, text: `signed out (${r.status})` }
}
// The auth store's own view, read through the app's Pinia instance (read-only).
function authState(page) {
  return evalSafe(page, () => {
    const a = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value?.auth
    return a ? { isAuthenticated: a.isAuthenticated, isReconnecting: a.isReconnecting, id: a.user?.id ?? null, role: a.user?.role ?? null } : null
  })
}

// Sign in through the form ALREADY on screen. Never page.goto('/login') here: that
// is itself a fresh page, and would hide exactly what is being measured.
async function signInHere(page, who, username, password) {
  const form = page.locator('form.login-form')
  await form.waitFor({ state: 'visible', timeout: 60000 })
  await caption(page, `${who} signs in through the form on this same page`)
  await form.locator('input[autocomplete="username"]').fill(username)
  await form.locator('input[autocomplete="current-password"]').fill(password)
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST', { timeout: 60000 }),
    form.locator('button[type="submit"]').click(),
  ])
  if (resp.status() !== 200) throw new Error(`${who} login answered ${resp.status()}`)
}

// Land on `pathname`, see `ready`, then leave time for a late reload to happen.
async function settleOn(page, pathname, ready, settleMs = 1500) {
  await page.waitForURL((u) => u.pathname === pathname, { timeout: 60000 })
  await ready.waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForLoadState('load')
  await page.waitForTimeout(settleMs)
}

const ADMIN_VP = { width: 1400, height: 900 }
async function freshPage(viewport) {
  const ctx = await browser.newContext({ viewport })
  ctx.setDefaultTimeout(20000)
  return { ctx, page: await ctx.newPage() }
}

// ---- S1: a sign-out button ends on a FRESH /login page
async function signOutCase({ step, who, creds, home, viewport, ready, button, buttonLabel, prefix }) {
  let observed; let ok = false
  const { ctx, page } = await freshPage(viewport)
  try {
    await login(page, `Step ${step} — ${who}`, creds.username, creds.password, home)
    await ready(page).waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(2500) // the page's first data lands
    await plantMarker(page)
    const histBefore = await evalSafe(page, () => history.length)
    await caption(page, `Step ${step} — ${who} on ${home}; window.__qaMarker = '${MARK}' planted. Press ${buttonLabel} → expect a FRESH /login page (the marker gone)`)
    await shot(page, `${prefix}-1-signed-in-marker`)
    const t = trackDocuments(page)
    await button(page).click()
    await settleOn(page, '/login', page.locator('form.login-form'))
    t.stop()
    const marker = await readMarker(page)
    const histAfter = await evalSafe(page, () => history.length)
    const me = await whoAmI(page)
    ok = marker === NO_MARK
    observed = `on /login: window.__qaMarker = ${markerText(marker)}; document loads: ${docsText(t.docs)}; ` +
      `history entries ${histBefore} → ${histAfter}${histAfter > histBefore ? ' (one added: Back returns to the signed-in URL)' : ' (replaced in place)'}; server session after: ${me.text}`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` }
  const s = await shot(page, `${prefix}-2-after-signout`)
  await ctx.close().catch(() => {})
  record({ step, title: `${who} signs out with ${buttonLabel}`, expected: 'A full page load of /login (location.replace): window.__qaMarker undefined', observed, verdict: verdict(ok), shot: s })
}

// ---- S2: the session expires with no sign-out, and the app routes ITSELF to /login.
// How: /trucks is loaded while its session check gets no answer (a weak signal), so
// the auth store keeps the tab's saved user and keeps re-checking in the background.
// The cookie is then cleared, and the browser goes offline → online: the store's wake
// listener re-checks at once, the server answers "signed out", and the router's own
// guard sends the page to /login in-app (auth._reconnectNow → onSessionResolved →
// router.replace). This build has no other in-app route to /login without a sign-out:
// API 401s do not redirect, and a pushState+popstate to /login only changes the URL
// bar (the router stays on the page and no login form renders).
// The expiry path itself, shared by S2 and S7: ends on /login, reached in-app.
// Returns the marker read there. `wake`: 'offline' (S2) toggles the context
// offline and back, the browser's own 'online' event; 'event' (S7) dispatches an
// 'online' event in the page instead, so the CDP throttle S7 applies next is the
// only network emulation set on the page.
async function expireToLoginInApp({ ctx, page, step, prefix, notes, nextWho, wake = 'offline' }) {
  const noAnswer = (route) => route.abort('internetdisconnected')
  await login(page, `Step ${step} — Super Admin`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
  await page.route('**/api/auth/session', noAnswer)
  await page.goto(`${BASE_URL}/trucks`)
  await page.locator('table.truck-table').waitFor({ state: 'visible', timeout: 45000 })
  await page.waitForTimeout(1000)
  const st = await authState(page)
  notes.push(`/trucks loaded with its session check unanswered → ${st ? `the store shows ${st.role} #${st.id}, reconnecting=${st.isReconnecting}` : 'store not readable'}`)
  await plantMarker(page)
  await caption(page, `Step ${step} — Super Admin on /trucks (data loaded; this tab's session check retries in the background). window.__qaMarker = '${MARK}'. Next: the session cookie disappears (it "expires") — nobody signs out`)
  await shot(page, `${prefix}-1-trucks-marker`)
  await ctx.clearCookies()
  await page.unroute('**/api/auth/session', noAnswer)
  const t0 = Date.now()
  if (wake === 'event') {
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
  } else {
    await ctx.setOffline(true)
    await page.waitForTimeout(300)
    await ctx.setOffline(false) // the browser's own 'online' event
  }
  await page.waitForURL((u) => u.pathname === '/login', { timeout: 60000 })
  const routedMs = Date.now() - t0
  await settleOn(page, '/login', page.locator('form.login-form'), 1000)
  const atLogin = await readMarker(page)
  notes.push(`${wake === 'event' ? 'an \'online\' event' : 'offline → online'}: the app's background check answered "signed out" and the app routed itself to /login ${routedMs} ms later; marker there ${atLogin === MARK ? `'${MARK}' (in-app, no reload)` : `${atLogin} (the page had already been loaded again)`}`)
  await caption(page, `Step ${step} — the app routed itself to /login (marker ${atLogin === MARK ? `still '${MARK}'` : 'gone'}). Now ${nextWho} signs in on this page`)
  await shot(page, `${prefix}-2-login-in-app`)
  return atLogin
}

async function expiredSessionCase({ step, signer, signerWho, sameUser, prefix }) {
  let observed; let ok = false
  const notes = []
  const { ctx, page } = await freshPage(ADMIN_VP)
  try {
    await expireToLoginInApp({ ctx, page, step, prefix, notes, nextWho: signerWho })
    const t = trackDocuments(page)
    await signInHere(page, `Step ${step} — ${signerWho}`, signer.username, signer.password)
    await settleOn(page, '/dashboard', page.locator('h2', { hasText: 'Operations Dashboard' }))
    t.stop()
    const marker = await readMarker(page)
    const me = await whoAmI(page)
    const isSigner = String(me.id) === String(signer.userId)
    ok = isSigner && (sameUser ? marker === MARK : marker === NO_MARK)
    observed = `${notes.join('; ')}; after ${signerWho} signed in: on ${new URL(page.url()).pathname}, window.__qaMarker = ${markerText(marker)}; ` +
      `document loads: ${docsText(t.docs)}; server session: ${me.text}${isSigner ? '' : ' (NOT who signed in)'}`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `${notes.length ? `${notes.join('; ')}; ` : ''}error: ${e.message}` }
  const s = await shot(page, `${prefix}-3-after-signin`)
  await ctx.close().catch(() => {})
  record({
    step,
    title: sameUser
      ? 'Control: session expired (no sign-out) on the Super Admin\'s /trucks; the SAME Super Admin signs back in on that page'
      : 'Session expired (no sign-out) on the Super Admin\'s /trucks; the Dispatcher signs in on that page',
    expected: sameUser
      ? `In-app navigation to /dashboard, as today: window.__qaMarker still '${MARK}'; the session is the Super Admin's`
      : 'A full page load of the Dispatcher\'s home (/dashboard): window.__qaMarker undefined; the session is the Dispatcher\'s',
    observed, verdict: verdict(ok), shot: s,
  })
}

// The Super-Admin-only part of an /api/dashboard payload: its broker/contact cells.
// Values stay in memory (they are PII); only counts are ever written out.
function withheldOf(p) {
  const hs = (p?.jobTrackingHeaders || []).filter((h) => BROKER_WITHHELD_RE.test(String(h ?? '')))
  const byCell = new Map() // `${list}|${_rowIndex}|${header}` -> non-empty value
  const values = new Set()
  for (const k of ['unassignedJobs', 'activeJobs', 'completedJobs']) {
    for (const row of p?.[k] || []) for (const h of hs) {
      const v = String(row?.[h] ?? '').trim()
      if (v) { byCell.set(`${k}|${row?._rowIndex}|${h}`, v); if (v.length >= 4) values.add(v) }
    }
  }
  return { headers: hs.length, cells: byCell.size, byCell, values: [...values].slice(0, 500) }
}
// Cells the Super Admin's copy carries and the Dispatcher's does not (blanked, or a
// JSON contact reduced to its name): exactly what "only a Super Admin gets".
function superAdminOnlyCells(sa, disp) {
  let n = 0
  for (const [key, v] of sa.byCell) if (disp.byCell.get(key) !== v) n++
  return n
}
// In-page: what the dashboard shows, and what its store holds. Self-contained (serialized).
function dashboardProbe({ saTs, saValues }) {
  const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
  const data = pinia?.state?.value?.dashboard?.data ?? null
  const RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i
  let withheldCells = 0
  if (data) {
    const hs = (data.jobTrackingHeaders || []).filter((h) => RE.test(String(h ?? '')))
    for (const k of ['unassignedJobs', 'activeJobs', 'completedJobs']) {
      for (const row of data[k] || []) for (const h of hs) if (String(row?.[h] ?? '').trim()) withheldCells++
    }
  }
  const vis = (el) => !!el && el.getClientRects().length > 0
  const text = document.body?.innerText || ''
  return {
    path: location.pathname,
    piniaReadable: !!pinia,
    storeTs: data?.timestamp ?? null,
    storeIsSA: !!data && data.timestamp === saTs,
    withheldCells,
    kpiValues: [...document.querySelectorAll('.kpi-grid:not(.revenue-grid) .kpi-value')].filter(vis).map((e) => e.textContent.trim()),
    skeletons: [...document.querySelectorAll('.kpi-grid .animate-pulse')].filter(vis).length,
    rows: [...document.querySelectorAll('table tbody tr')].filter((tr) => vis(tr) && tr.querySelectorAll('td').length > 1).length,
    revenueShown: [...document.querySelectorAll('.revenue-grid')].some(vis),
    updated: [...document.querySelectorAll('.dash-header span')].map((e) => e.textContent.trim()).find(Boolean) || '',
    saValuesOnScreen: saValues.filter((v) => text.includes(v)).length,
  }
}
const kpiText = (p) => (p.kpiValues.length ? `KPI cards RENDERED [${p.kpiValues.join(' | ')}]` : p.skeletons ? `KPI skeleton (${p.skeletons} placeholders)` : 'no KPI cards')

// ---- S3: what the Dispatcher sees on the dashboard while their own fetch is in flight
async function residueCase() {
  const step = 'S3'
  let observed = ''; let v = 'FAIL'
  const { ctx, page } = await freshPage(ADMIN_VP)
  let cdp = null
  try {
    // 1. The Super Admin's dashboard with full data. Keep its payload's identity
    //    (its timestamp) and its Super-Admin-only values (memory only).
    let saPayload = null
    const onSaResp = async (r) => {
      if (saPayload || new URL(r.url()).pathname !== '/api/dashboard' || r.request().method() !== 'GET' || r.status() !== 200) return
      try { saPayload = await r.json() } catch { /* ignore */ }
    }
    page.on('response', onSaResp)
    await login(page, 'Step S3 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.locator('.kpi-grid:not(.revenue-grid) .kpi-value').first().waitFor({ state: 'visible', timeout: 45000 })
    for (let i = 0; i < 100 && !saPayload; i++) await page.waitForTimeout(100)
    page.off('response', onSaResp)
    if (!saPayload?.timestamp) throw new Error('did not capture the Super Admin\'s /api/dashboard payload')
    const sa = withheldOf(saPayload)
    await page.waitForTimeout(1000)
    await caption(page, `Step S3 — the Super Admin's dashboard, full data (its payload carries ${sa.cells} broker/contact cells; a Dispatcher's copy blanks them or reduces them to a name). Next: sign out, throttle the network, and the Dispatcher signs in on this tab`)
    await shot(page, 's3-1-superadmin-dashboard')

    // 2. Sign out with the sidebar, whatever this build does (in-app, or a fresh page).
    const tOut = trackDocuments(page)
    await page.locator('a.nav-item', { hasText: 'Logout' }).first().click()
    await settleOn(page, '/login', page.locator('form.login-form'))
    tOut.stop()

    // 3. Throttle from here on (after the sign-out, so a build that reloads /login is not slowed).
    cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: THROTTLE.latencyMs,
      downloadThroughput: THROTTLE.kbps * 1024, uploadThroughput: THROTTLE.kbps * 1024,
    })

    // 4. The Dispatcher signs in on the same tab. Catch the moment their dashboard
    //    requests its own data; screenshot SHOT_DELAY_MS later, inside the throttle's
    //    latency floor (the route transition has settled by then, the fetch cannot
    //    have). `respAt` is the response HEADERS: while they are missing, the body —
    //    and so the store update — certainly is too.
    const SHOT_DELAY_MS = 700
    let reqAt = 0; let respAt = 0; let doneAt = 0; let dashReq = null
    let resolveReq
    const reqSeen = new Promise((r) => { resolveReq = r })
    const onReq = (r) => { if (!reqAt && new URL(r.url()).pathname === '/api/dashboard' && r.method() === 'GET') { reqAt = Date.now(); dashReq = r; resolveReq() } }
    const onResp = (r) => { if (dashReq && !respAt && r.request() === dashReq) respAt = Date.now() }
    const onDone = (r) => { if (dashReq && !doneAt && r === dashReq) doneAt = Date.now() }
    page.on('request', onReq)
    page.on('response', onResp)
    page.on('requestfinished', onDone)
    page.on('requestfailed', onDone)
    const tIn = trackDocuments(page)
    await signInHere(page, 'Step S3 — Dispatcher', CREDS.dispatcher.username, CREDS.dispatcher.password)
    await Promise.race([reqSeen, new Promise((r) => setTimeout(r, 90000))])
    if (!reqAt) throw new Error('the Dispatcher\'s dashboard never requested /api/dashboard within 90 s')
    await page.waitForTimeout(SHOT_DELAY_MS)
    await caption(page, `Step S3 — the Dispatcher's dashboard, ${SHOT_DELAY_MS} ms after it requested /api/dashboard (its own data is still in flight)`, false)
    const s2 = await shot(page, 's3-2-dispatcher-dashboard-fetch-in-flight')
    const shotAt = Date.now()
    const inFlightAtShot = !respAt
    const now = await evalSafe(page, dashboardProbe, { saTs: saPayload.timestamp, saValues: sa.values })
    const inFlightAfterProbe = !respAt

    // 5. Let the Dispatcher's own payload land (body complete, store updated), for comparison.
    for (let i = 0; i < 900 && !doneAt; i++) await page.waitForTimeout(100)
    let later = null
    for (let i = 0; i < 40; i++) {
      later = await evalSafe(page, dashboardProbe, { saTs: saPayload.timestamp, saValues: sa.values })
      if (!later.storeIsSA && later.storeTs) break
      await page.waitForTimeout(250)
    }
    tIn.stop()
    const me = await whoAmI(page)
    // The Dispatcher's own copy, to count what in the Super Admin's copy they never get.
    let saOnly = null; let dispCells = null
    try {
      const disp = withheldOf(await (await dashReq.response())?.json())
      saOnly = superAdminOnlyCells(sa, disp)
      dispCells = disp.cells
    } catch { /* body unavailable: reported as '?' */ }
    page.off('request', onReq)
    page.off('response', onResp)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)

    const dataOnScreen = now.kpiValues.length > 0 || now.rows > 0 || /^Updated/i.test(now.updated)
    const fresh = !dataOnScreen && !now.storeTs
    if (!inFlightAtShot) v = 'INFO'
    else if (dataOnScreen) v = 'FAIL'
    else v = fresh ? 'PASS' : 'FAIL'
    observed =
      `sign-out: document loads ${docsText(tOut.docs)}; sign-in as the Dispatcher: document loads ${docsText(tIn.docs)}. ` +
      `Dispatcher's /api/dashboard: response headers after ${respAt ? respAt - reqAt : '?'} ms, body complete after ${doneAt ? doneAt - reqAt : '?'} ms; screenshot taken ${shotAt - reqAt} ms after it was requested, ` +
      `${inFlightAtShot ? 'BEFORE its response' : 'AFTER its response (window missed — not scored)'}${inFlightAfterProbe ? '' : ' (the response landed during the DOM probe)'}. ` +
      `On screen then: ${kpiText(now)}; ${now.rows} load rows listed; header "${now.updated}"; Revenue grid (Super Admin only, gated by role on the client) ${now.revenueShown ? 'SHOWN' : 'not shown'}. ` +
      `The page's dashboard store held ${now.storeTs ? (now.storeIsSA ? 'the SUPER ADMIN\'S payload (its timestamp)' : 'a payload with another timestamp') : 'nothing'}` +
      `${now.piniaReadable ? '' : ' (store not readable)'}: ${now.withheldCells} non-empty broker/contact cells` +
      `${now.storeIsSA ? `, ${saOnly ?? '?'} of them Super-Admin-only (the Dispatcher's own copy has ${dispCells ?? '?'} non-empty, the rest blanked or reduced to a name)` : ''}; ` +
      `${now.saValuesOnScreen} of the Super Admin's broker/contact values appeared as text (the tabs hide those columns for every role). ` +
      `After the Dispatcher's own response: ${kpiText(later)}; store ${later.storeIsSA ? 'STILL the Super Admin\'s' : 'the Dispatcher\'s own payload'}; server session ${me.text}. ` +
      `Throttle: CDP Network.emulateNetworkConditions +${THROTTLE.latencyMs} ms per request, ${THROTTLE.kbps} KB/s each way, applied after the sign-out.`
    await caption(page, `Step S3 — result: ${v}. ${kpiText(now)} while the Dispatcher's own fetch was in flight; store held ${now.storeIsSA ? 'the Super Admin\'s payload' : (now.storeTs ? 'another payload' : 'nothing')}`)
    await shot(page, 's3-3-dispatcher-dashboard-loaded')
    record({
      step,
      title: 'Visible residue: Super Admin dashboard → sign out → the Dispatcher signs in on the same tab (network throttled); screenshot while the Dispatcher\'s /api/dashboard is in flight',
      expected: 'A fresh page (skeleton / "Loading..."): nothing from the previous account on screen or in the page\'s store',
      observed, verdict: v, shot: s2,
    })
  } catch (e) {
    const s = await shot(page, 's3-error')
    record({ step, title: 'Visible residue after sign-out → Dispatcher sign-in (network throttled)', expected: 'A fresh page (skeleton / empty)', observed: `${observed}error: ${e.message}`, verdict: 'FAIL', shot: s })
  } finally {
    if (cdp) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
      await cdp.detach().catch(() => {})
    }
    await ctx.close().catch(() => {})
  }
}

// ================================================================ S4-S7
const KPI = '.kpi-grid:not(.revenue-grid) .kpi-value'
const sidebarLogout = (p) => p.locator('a.nav-item', { hasText: 'Logout' }).first()
const pathOf = (u) => { try { return new URL(u).pathname } catch { return String(u) } }
// A tab nobody touched: its marker says whether it was loaded again.
const tabMarkerText = (m) => (m === NO_MARK ? 'undefined (a fresh page: it was loaded again)' : `'${m}' (the same page, never loaded again)`)
async function throttle(ctx, page) {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: THROTTLE.latencyMs,
    downloadThroughput: THROTTLE.kbps * 1024, uploadThroughput: THROTTLE.kbps * 1024,
  })
  return cdp
}
async function unthrottle(cdp) {
  if (!cdp) return
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
  await cdp.detach().catch(() => {})
}
const THROTTLE_TEXT = () => `CDP Network.emulateNetworkConditions +${THROTTLE.latencyMs} ms per request, ${THROTTLE.kbps} KB/s each way`
const S7_KEY = 'qa.e2e.s7' // sessionStorage: S7's in-page record (a timestamp, counts, the button's state)

// Is this tab showing the browser's own error page (a page load that failed)?
async function onBrowserErrorPage(page) {
  if (/^chrome-error:/i.test(page.url())) return true
  return page.evaluate(() => !!document.querySelector('#main-frame-error, body.neterror')).catch(() => false)
}

// ---- S4a: sign-out with no network ends on the app's own login form
async function offlineSignOutCase() {
  const step = 'S4a'
  let observed = ''; let ok = false
  const notes = []
  const { ctx, page } = await freshPage(ADMIN_VP)
  try {
    await login(page, `Step ${step} — Super Admin`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(1500)
    await plantMarker(page)
    await caption(page, `Step ${step} — Super Admin on /dashboard; window.__qaMarker = '${MARK}'. The browser goes OFFLINE, then the sidebar's Logout → expect the app's own login form at /login (not the browser's error page), the marker still there`)
    await shot(page, 's4a-1-dashboard-marker')
    await ctx.setOffline(true)
    const t = trackDocuments(page)
    await sidebarLogout(page).click()
    await page.waitForTimeout(3000) // either outcome has landed by now: the in-app form, or the browser's error page
    t.stop()
    const errorPage = await onBrowserErrorPage(page)
    const formVisible = !errorPage && await page.locator('form.login-form').isVisible().catch(() => false)
    const marker = errorPage ? NO_MARK : await readMarker(page).catch(() => '?')
    const first = !errorPage && formVisible && pathOf(page.url()) === '/login' && marker === MARK
    notes.push(`offline sign-out: ${errorPage ? `the BROWSER'S ERROR PAGE (${page.url().slice(0, 40)})` : `${formVisible ? 'the app\'s login form' : 'NO login form'} at ${pathOf(page.url())}`}; ` +
      `window.__qaMarker ${errorPage ? 'gone with the page' : `= ${markerText(marker)}`}; document loads: ${docsText(t.docs)}`)
    await caption(page, `Step ${step} — ${notes[0]}`)
    await shot(page, 's4a-2-offline-signout')
    await ctx.setOffline(false)
    let second = false
    if (!first) {
      notes.push('the Dispatcher sign-in was not run: there is no in-app login form on this page to sign in on')
    } else if (!CREDS.dispatcher) {
      notes.push('the Dispatcher sign-in was not run: the creds file has no dispatcher login')
      second = true
    } else {
      await page.waitForTimeout(500)
      const t2 = trackDocuments(page)
      await signInHere(page, `Step ${step} — back online, the Dispatcher`, CREDS.dispatcher.username, CREDS.dispatcher.password)
      await settleOn(page, '/dashboard', page.locator('h2', { hasText: 'Operations Dashboard' }))
      t2.stop()
      const m2 = await readMarker(page)
      const me = await whoAmI(page)
      second = m2 === NO_MARK && String(me.id) === String(CREDS.dispatcher.userId)
      notes.push(`back online, the Dispatcher signed in on that form: on ${pathOf(page.url())}, window.__qaMarker = ${markerText(m2)}; document loads: ${docsText(t2.docs)}; server session: ${me.text}`)
    }
    ok = first && second
    observed = notes.join('; ')
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `${notes.length ? `${notes.join('; ')}; ` : ''}error: ${e.message}` }
  await ctx.setOffline(false).catch(() => {})
  const s = await shot(page, 's4a-3-result')
  await ctx.close().catch(() => {})
  record({
    step, title: 'Sign-out with no network (the sidebar\'s Logout while offline); back online, the Dispatcher signs in on that page',
    expected: 'The app\'s own login form at /login, not the browser\'s error page, reached in-app (marker still set). Then a full page load of /dashboard (marker undefined) with the Dispatcher\'s session',
    observed, verdict: verdict(ok), shot: s,
  })
}

// ---- S4b: sign-out while the server is down (as during a deploy's restart)
async function serverDownSignOutCase() {
  const step = 'S4b'
  let observed = ''; let ok = false
  const { ctx, page } = await freshPage(ADMIN_VP)
  const STAND_IN = 'QA stand-in: the server is restarting'
  const BODY = `<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>${STAND_IN}</p></body></html>`
  const down = (route) => route.fulfill({ status: 502, contentType: 'text/html', body: BODY })
  const isLogout = (u) => u.pathname === '/api/auth/logout'
  const isLogin = (u) => u.pathname === '/login'
  const loginDocDown = (route) => (route.request().resourceType() === 'document' ? down(route) : route.continue())
  let routed = false
  try {
    await login(page, `Step ${step} — Super Admin`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(1500)
    await plantMarker(page)
    await page.route(isLogout, down)
    await page.route(isLogin, loginDocDown)
    routed = true
    await caption(page, `Step ${step} — Super Admin on /dashboard; window.__qaMarker = '${MARK}'. The server is DOWN: POST /api/auth/logout and a page load of /login both answer 502. Press the sidebar's Logout → expect the app's own login form (in-app)`)
    await shot(page, 's4b-1-dashboard-marker')
    const t = trackDocuments(page)
    await sidebarLogout(page).click()
    await page.waitForTimeout(3000)
    t.stop()
    const shows502 = await page.evaluate((txt) => (document.body?.innerText || '').includes(txt), STAND_IN).catch(() => false)
    const formVisible = await page.locator('form.login-form').isVisible().catch(() => false)
    const marker = await readMarker(page).catch(() => '?')
    ok = !shows502 && formVisible && pathOf(page.url()) === '/login' && marker === MARK
    observed = `after Logout: ${shows502 ? 'the 502 BODY is shown (the page was replaced by the failed load of /login)' : formVisible ? 'the app\'s own login form' : 'NO login form'} at ${pathOf(page.url())}; ` +
      `window.__qaMarker = ${markerText(marker)}; document loads: ${docsText(t.docs)}`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` }
  const s = await shot(page, 's4b-2-result')
  if (routed) {
    await page.unroute(isLogout, down).catch(() => {})
    await page.unroute(isLogin, loginDocDown).catch(() => {})
  }
  await ctx.close().catch(() => {})
  record({
    step, title: 'Sign-out while the server is down: POST /api/auth/logout and the page load of /login both answer 502',
    expected: 'The app\'s own login form at /login, reached in-app (marker still set); never the 502 body',
    observed, verdict: verdict(ok), shot: s,
  })
}

// Truck data in a tab, plus who its auth store holds. Counts and ids only.
// Self-contained: it runs in the page.
function tabProbe(units) {
  const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
  const st = pinia?.state?.value
  const text = document.body?.innerText || ''
  const a = st?.auth
  return {
    path: location.pathname,
    marker: window.__qaMarker === undefined ? 'undefined' : String(window.__qaMarker),
    rows: document.querySelectorAll('table.truck-table tbody tr').length,
    storeTrucks: Array.isArray(st?.trucks?.trucks) ? st.trucks.trucks.length : 0,
    unitsOnScreen: (units || []).filter((u) => u && text.includes(u)).length,
    form: !!document.querySelector('form.login-form'),
    auth: a ? { id: a.user?.id ?? null, role: a.user?.role ?? null } : null,
  }
}
const unitsOfTab = (page) => evalSafe(page, () => {
  const p = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
  return (p?.state?.value?.trucks?.trucks || []).map((t) => String(t.UnitNumber || '')).filter((u) => u.length >= 3)
})
const authText = (a) => (a?.id != null ? `${a.role} #${a.id}` : 'nobody')

// Two tabs of the Super Admin: A on /dashboard, B on /trucks with its marker.
async function twoTabs(step) {
  const { ctx, page: a } = await freshPage(ADMIN_VP)
  await login(a, `Step ${step} — Super Admin (tab A)`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
  await a.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 })
  const b = await ctx.newPage()
  await b.goto(`${BASE_URL}/trucks`)
  await b.locator('table.truck-table tbody tr').first().waitFor({ state: 'visible', timeout: 45000 })
  await b.waitForTimeout(1500)
  await plantMarker(b)
  const units = await unitsOfTab(b)
  return { ctx, a, b, units, before: await evalSafe(b, tabProbe, units) }
}

// ---- S5a: another tab follows a sign-out
async function otherTabSignOutCase() {
  const step = 'S5a'
  let observed = ''; let ok = false
  let ctx = null; let b = null
  try {
    const t2 = await twoTabs(step)
    ctx = t2.ctx; b = t2.b
    const { a, units, before } = t2
    await caption(b, `Step ${step} — tab B: the Super Admin's /trucks (${before.rows} rows, ${before.storeTrucks} trucks in its store); window.__qaMarker = '${MARK}'. Next: tab A signs out; nothing is done on this tab`)
    await shot(b, 's5a-1-tab-b-trucks')
    await caption(a, `Step ${step} — tab A: the Super Admin's dashboard. Press the sidebar's Logout → expect tab B to follow by itself within ~5 s`)
    const tb = trackDocuments(b)
    await sidebarLogout(a).click()
    const t0 = Date.now()
    let st = null; let followedMs = null
    while (Date.now() - t0 < 6000) {
      st = await evalSafe(b, tabProbe, units).catch(() => st)
      if (st && st.path === '/login' && st.marker === NO_MARK) { followedMs = Date.now() - t0; break }
      await b.waitForTimeout(250)
    }
    if (followedMs !== null) { await b.waitForTimeout(1000); st = await evalSafe(b, tabProbe, units) }
    tb.stop()
    const aPath = pathOf(a.url())
    ok = followedMs !== null && st.rows === 0 && st.storeTrucks === 0 && st.unitsOnScreen === 0
    observed = `tab A signed out (now on ${aPath}). Tab B, untouched: ${followedMs !== null ? `followed ${followedMs} ms later` : 'did NOT follow within 6 s'}; ` +
      `on ${st?.path}, window.__qaMarker = ${tabMarkerText(st?.marker)}, document loads ${docsText(tb.docs)}; ` +
      `truck data there: ${st?.rows} table rows, ${st?.storeTrucks} trucks in its store, ${st?.unitsOnScreen} of the ${units.length} unit numbers it listed still in its text; its auth store holds ${authText(st?.auth)}`
    await caption(b, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` }
  const s = b ? await shot(b, 's5a-2-tab-b-after') : ''
  await ctx?.close().catch(() => {})
  record({
    step, title: 'Two tabs of the Super Admin (A on /dashboard, B on /trucks); A signs out with the sidebar\'s Logout, B is not touched',
    expected: 'Within ~5 s, by itself: B is on /login as a fresh page (marker undefined), with no truck data on screen or in its stores',
    observed, verdict: verdict(ok), shot: s,
  })
}

// A time relative to `t0`: signed on a timeline ('+38 ms'), or in words ('9 ms after').
const relMs = (t, t0) => (t && t0 ? `${t >= t0 ? '+' : ''}${t - t0} ms` : 'not seen')
const offsetText = (t, t0) => (!t || !t0 ? 'at a moment not seen' : t >= t0 ? `${t - t0} ms after` : `${t0 - t} ms before`)
// The moments S5b and S5c time, taken from the page's own network events: headed, slowMo
// delays when a Playwright action RETURNS, not when the page sent or got something.
//   docAt    the tab's next main-frame document request (the page it loads next)
//   checkAt  its first GET /api/auth/session answer after that, with the answer
//   signAt   its first POST /api/auth/login answer
function tabTimeline(page) {
  const tl = { docAt: 0, check: null, signAt: 0 }
  const onReq = (r) => { if (!tl.docAt && r.resourceType() === 'document' && r.frame() === page.mainFrame()) tl.docAt = Date.now() }
  const onResp = async (r) => {
    const p = pathOf(r.url()); const m = r.request().method()
    if (!tl.signAt && p === '/api/auth/login' && m === 'POST') { tl.signAt = Date.now(); return }
    if (tl.check || !tl.docAt || p !== '/api/auth/session' || m !== 'GET') return
    tl.check = { at: Date.now(), status: r.status(), authenticated: null }
    try { tl.check.authenticated = (await r.json())?.authenticated ?? null } catch { /* unreadable */ }
  }
  page.on('request', onReq)
  page.on('response', onResp)
  tl.stop = () => { page.off('request', onReq); page.off('response', onResp) }
  return tl
}

// ---- S5b: the session ends without a sign-out, and tab A then signs a different person in
// Tab A's /login asks the server, which answers "signed out". That definitive answer stamps
// the cookie-owner epoch, and tab B (still showing the Super Admin) follows the stamp to a
// fresh /login within ~50 ms, before anyone signs in. Showing nobody, B then has nothing to
// follow when the Dispatcher signs in on A. That is the design (no tab keeps showing the
// signed-out person), so B is not expected to follow the later sign-in; S5c scores a tab
// that follows a different person.
async function otherTabNewPersonCase() {
  const step = 'S5b'
  let observed = ''; let v = 'FAIL'
  let ctx = null; let a = null; let b = null
  let ta = null // tab A's timeline: its /login request, its own session answer (what B follows), the sign-in answer
  try {
    const t2 = await twoTabs(step)
    ctx = t2.ctx; a = t2.a; b = t2.b
    const { units, before } = t2
    await caption(b, `Step ${step} — tab B: the Super Admin's /trucks (${before.rows} rows); window.__qaMarker = '${MARK}'. Next: the session cookie disappears (it "expires"), nobody signs out, tab A loads /login and the Dispatcher signs in there; nothing is done on this tab. Expected: B leaves by itself for a fresh /login`)
    await shot(b, 's5b-1-tab-b-trucks')
    const tb = trackDocuments(b)
    await ctx.clearCookies()
    ta = tabTimeline(a)
    await a.goto(`${BASE_URL}/login`)
    await signInHere(a, `Step ${step} — tab A: the Dispatcher`, CREDS.dispatcher.username, CREDS.dispatcher.password)
    ta.stop()
    await settleOn(a, '/dashboard', a.locator('h2', { hasText: 'Operations Dashboard' }), 300)
    const aWho = await whoAmI(a)
    // B has settled once it was loaded again and shows its login form, or someone.
    const t0 = Date.now()
    let st = null; let settled = false
    while (Date.now() - t0 < 10000) {
      st = await evalSafe(b, tabProbe, units).catch(() => st)
      if (st && st.marker === NO_MARK && (st.path === '/login' ? st.form : st.auth?.id != null)) { settled = true; break }
      await b.waitForTimeout(250)
    }
    if (settled) { await b.waitForTimeout(1000); st = await evalSafe(b, tabProbe, units) }
    tb.stop()
    const clean = !!st && st.marker === NO_MARK && st.path === '/login' && st.auth?.id == null && st.rows === 0 && st.storeTrucks === 0 && st.unitsOnScreen === 0
    const followed = !!st && st.marker === NO_MARK && String(st.auth?.id) === String(CREDS.dispatcher.userId)
    v = clean ? 'PASS' : followed ? 'INFO' : 'FAIL'
    const leftAt = tb.times[0] || 0
    const t0A = ta.docAt
    const aCheckText = ta.check
      ? `answered ${ta.check.status} ${ta.check.authenticated === false ? 'authenticated:false ("signed out")' : `authenticated:${ta.check.authenticated}`} at ${relMs(ta.check.at, t0A)}`
      : 'was not seen'
    observed = `timings from tab A's request for /login (0 ms), taken from the pages' network events: A's own session check ${aCheckText}; the Dispatcher's sign-in on A answered at ${relMs(ta.signAt, t0A)} (server session ${aWho.text}). ` +
      `Tab B, untouched: ${leftAt ? `requested a fresh page at ${relMs(leftAt, t0A)}, ${offsetText(leftAt, ta.signAt)} the Dispatcher's sign-in answered` : 'was NOT loaded again within 10 s of the sign-in'}; ` +
      `on ${st?.path}, window.__qaMarker = ${tabMarkerText(st?.marker)}, document loads ${docsText(tb.docs)}; its auth store holds ${authText(st?.auth)}; ` +
      `${st?.rows} truck rows on screen, ${st?.storeTrucks} trucks in its store, ${st?.unitsOnScreen} of the ${units.length} unit numbers it listed still in its text` +
      (followed ? '. B followed the later sign-in on a fresh page instead of staying on /login: not wrong, and not what this row describes (S5c scores that branch), so not scored' : '')
    await caption(b, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` } finally { ta?.stop() }
  const s = b ? await shot(b, 's5b-2-tab-b-after') : ''
  await ctx?.close().catch(() => {})
  record({
    step, title: 'Two tabs of the Super Admin; the session ends without a sign-out, tab A loads /login and the Dispatcher signs in there through the form; B is not touched',
    expected: 'B leaves by itself for a fresh /login (marker undefined), holding nobody and none of the Super Admin\'s rows or unit numbers; it does not have to follow the later sign-in',
    observed, verdict: v, shot: s,
  })
}

// What a tab shows that `role` never gets (S5c). Self-contained: it runs in the page.
// Sidebar links to pages the app's own router closes to `role` (their meta.roles), and
// the Trucks table's Owner column (TrucksView shows it to the Super Admin only). The
// truck list itself cannot tell the views apart: a Dispatcher loads the same one.
function viewProbe(role) {
  const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router
  const links = [...document.querySelectorAll('aside a.nav-item[href^="/"]')].map((el) => el.getAttribute('href'))
  const closed = router
    ? links.filter((h) => { const roles = router.resolve(h).meta?.roles; return Array.isArray(roles) && !roles.includes(role) })
    : []
  return {
    routerReadable: !!router,
    links: links.length,
    closed,
    ownerColumn: [...document.querySelectorAll('table.truck-table thead th')].some((th) => th.textContent.trim() === 'Owner'),
  }
}
const viewText = (v, role, listClosed) => `${v.links} sidebar links, ${v.closed.length} of them to pages a ${role} may not open` +
  `${listClosed && v.closed.length ? ` (${v.closed.join(', ')})` : ''}${v.routerReadable ? '' : ' (the router was not readable)'}; ` +
  `the Trucks table's Owner column (Super Admin only) ${v.ownerColumn ? 'SHOWN' : 'not shown'}`

// ---- S5c: another tab signs a DIFFERENT person in while this tab still shows the old one
// The store's "different person → reload" branch (auth._followOtherTab, TAB_CHANGE.RELOAD).
// B follows every change of cookie owner another tab stamps, so the first stamp B sees must
// be the Dispatcher's sign-in:
//   - A must not decide "signed out" first: that answer stamps too, and B would leave for
//     /login (S5b). So A's own GET /api/auth/session gets no answer (page.route on A only;
//     B's requests are untouched), and A shows its sign-in form while it keeps re-checking.
//   - A must be a NEW tab. A tab keeps its saved user in sessionStorage, and one that still
//     has it restores the Super Admin while its check gets no answer, then routes itself
//     from /login to /dashboard: no form to sign in on. A new tab starts with an empty
//     sessionStorage. So the tab that signed the Super Admin in is closed, and the app is
//     opened again in a new tab A.
async function otherTabDifferentPersonCase() {
  const step = 'S5c'
  let observed = ''; let ok = false
  let ctx = null; let a = null; let b = null
  const notes = []
  let aborted = 0
  const noAnswer = (route) => { aborted++; return route.abort('internetdisconnected') }
  const isDispatcher = (id) => id != null && String(id) === String(CREDS.dispatcher.userId)
  const VIEWS = ['/trucks', '/dashboard'] // the page B was on, or the Dispatcher's home
  let ta = null // tab A's timeline: its /login request and the sign-in answer
  let bLoadAt = 0 // tab B's next 'load' event: its fresh page finished loading
  const onBLoad = () => { if (!bLoadAt) bLoadAt = Date.now() }
  try {
    const t2 = await twoTabs(step)
    ctx = t2.ctx; b = t2.b
    const { units, before } = t2
    const view0 = await evalSafe(b, viewProbe, 'Dispatcher')
    notes.push(`before: tab B on the Super Admin's /trucks, ${before.rows} rows, holding ${authText(before.auth)}; ${viewText(view0, 'Dispatcher', false)}`)
    await caption(b, `Step ${step} — tab B: the Super Admin's /trucks (${before.rows} rows; ${viewText(view0, 'Dispatcher', false)}); window.__qaMarker = '${MARK}'. Next: the session cookie disappears, the app is opened in a new tab A, and the Dispatcher signs in there; nothing is done on this tab. Expected: B reloads by itself as the Dispatcher`)
    await shot(b, 's5c-1-tab-b-trucks')
    await ctx.clearCookies()
    await t2.a.close()
    a = await ctx.newPage()
    await a.route('**/api/auth/session', noAnswer)
    const tb = trackDocuments(b)
    ta = tabTimeline(a)
    await a.goto(`${BASE_URL}/login`)
    await a.locator('form.login-form').waitFor({ state: 'visible', timeout: 60000 })
    const formSeenAt = Date.now()
    const aSt = await authState(a)
    const bMid = await evalSafe(b, tabProbe, units)
    notes.push(`tab A (a new tab) showed its sign-in form (the harness saw it ${offsetText(formSeenAt, ta.docAt)} its request for /login), holding ${aSt?.id != null ? `${aSt.role} #${aSt.id}` : 'nobody'}` +
      `${aSt?.isReconnecting ? ' and still re-checking in the background' : ''} (${aborted} of its GET /api/auth/session given no answer so far); ` +
      `tab B meanwhile: on ${bMid.path}, window.__qaMarker ${bMid.marker === MARK ? `still '${MARK}'` : bMid.marker}, holding ${authText(bMid.auth)}`)
    await caption(a, `Step ${step} — tab A, a new tab: the sign-in form, shown while its own session check gets no answer (nobody decided "signed out", so no other tab was told). The Dispatcher signs in here → expect tab B to reload by itself as the Dispatcher`)
    await shot(a, 's5c-2-tab-a-login-form')
    b.on('load', onBLoad)
    await signInHere(a, `Step ${step} — tab A: the Dispatcher`, CREDS.dispatcher.username, CREDS.dispatcher.password)
    ta.stop()
    const signAt = ta.signAt || Date.now()
    const pollFrom = Date.now()
    let st = null; let doneMs = null
    while (Date.now() - pollFrom < 10000) {
      st = await evalSafe(b, tabProbe, units).catch(() => st)
      if (st && st.marker === NO_MARK && isDispatcher(st.auth?.id) && VIEWS.includes(st.path)) { doneMs = Date.now() - signAt; break }
      await b.waitForTimeout(250)
    }
    b.off('load', onBLoad)
    if (doneMs !== null) {
      // Its own view drawn: on /trucks the table (so a missing Owner column is not vacuous).
      if (st.path === '/trucks') await b.locator('table.truck-table tbody tr').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
      await b.waitForTimeout(1000)
    }
    st = await evalSafe(b, tabProbe, units)
    const view = await evalSafe(b, viewProbe, 'Dispatcher')
    tb.stop()
    const bWho = await whoAmI(b)
    await a.unroute('**/api/auth/session', noAnswer)
    const aWho = await whoAmI(a)
    ok = doneMs !== null && st.marker === NO_MARK && isDispatcher(st.auth?.id) && isDispatcher(bWho.id) && VIEWS.includes(st.path) &&
      view.routerReadable && view.closed.length === 0 && !view.ownerColumn
    const reqAt = tb.times[0] || 0
    const bText = reqAt
      ? `requested a fresh page at ${relMs(reqAt, signAt)}${bLoadAt ? ` and finished loading it at ${relMs(bLoadAt, signAt)}` : ''}`
      : 'requested no fresh page'
    observed = `${notes.join('; ')}. The Dispatcher signed in on A (A now on ${pathOf(a.url())}, server session ${aWho.text}). ` +
      `Timings from the sign-in's answer (0 ms), taken from the pages' network and load events: tab B, untouched, ${bText}; ` +
      `${doneMs !== null ? `it was showing the Dispatcher when checked at +${doneMs} ms` : 'it did NOT show the Dispatcher within 10 s'}; ` +
      `then on ${st.path}, window.__qaMarker = ${tabMarkerText(st.marker)}, document loads ${docsText(tb.docs)}; its auth store holds ${authText(st.auth)}, its server session is ${bWho.text}; ` +
      `${viewText(view, 'Dispatcher', true)}; ${st.rows} truck rows on screen (a Dispatcher loads the same truck list)`
    await caption(b, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `${notes.length ? `${notes.join('; ')}; ` : ''}error: ${e.message}` } finally {
    ta?.stop()
    b?.off('load', onBLoad)
  }
  const s = b ? await shot(b, 's5c-3-tab-b-after') : ''
  await ctx?.close().catch(() => {})
  record({
    step, title: 'Two tabs of the Super Admin; the session ends without a sign-out, and a new tab A, whose own session check gets no answer, signs the Dispatcher in through its form; B is not touched',
    expected: 'Within ~10 s, by itself: B is loaded again (marker undefined) as the Dispatcher: its auth store and its server session are the Dispatcher\'s, it shows their view of /trucks or their home, and nothing only the Super Admin gets is left (no Owner column, no sidebar link to a page a Dispatcher may not open)',
    observed, verdict: verdict(ok), shot: s,
  })
}

// S6: installed in every document of its context before the app's own scripts.
// Records, on the document's own clock, when the app booted (its Vue instance
// exists, or its first /api/ request, whichever comes first), when the login form
// became visible, and each /api/ request it sent. Self-contained (serialized).
function bootProbe() {
  if (window.__qaBoot) return
  const P = (window.__qaBoot = { appAt: null, formAt: null, calls: [] })
  const orig = window.fetch
  window.fetch = function (input) {
    try {
      const u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href)
      if (u.pathname.startsWith('/api/')) P.calls.push({ path: u.pathname, at: performance.now() })
    } catch { /* not a URL */ }
    return orig.apply(this, arguments)
  }
  const check = () => {
    if (P.appAt === null && document.querySelector('#app')?.__vue_app__) P.appAt = performance.now()
    if (P.formAt === null) {
      const f = document.querySelector('form.login-form')
      if (f && f.getClientRects().length) P.formAt = performance.now()
    }
    return P.appAt !== null && P.formAt !== null
  }
  const mo = new MutationObserver(() => { if (check()) mo.disconnect() })
  mo.observe(document, { childList: true, subtree: true })
  const tick = () => { if (!check()) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}

// ---- S6: /login renders at once after a confirmed sign-out, on a slow network
async function slowSignOutCase() {
  const step = 'S6'
  let observed = ''; let v = 'FAIL'
  const { ctx, page } = await freshPage(ADMIN_VP)
  await ctx.addInitScript(bootProbe)
  let cdp = null
  try {
    await login(page, `Step ${step} — Super Admin`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(1500)
    await plantMarker(page)
    cdp = await throttle(ctx, page)
    await caption(page, `Step ${step} — Super Admin on /dashboard; the network is now slow (+${THROTTLE.latencyMs} ms per request). Press the sidebar's Logout → on the fresh /login page, expect the form without a session round-trip (no GET /api/auth/session before it)`)
    await shot(page, 's6-1-dashboard-throttled')
    const t = trackDocuments(page)
    const t0 = Date.now()
    await sidebarLogout(page).click()
    await page.waitForURL((u) => u.pathname === '/login', { timeout: 90000 })
    await page.locator('form.login-form').waitFor({ state: 'visible', timeout: 90000 })
    const wallMs = Date.now() - t0
    await page.waitForTimeout(800)
    t.stop()
    const marker = await readMarker(page)
    const P = await evalSafe(page, () => window.__qaBoot || null)
    if (marker !== NO_MARK || !P || P.formAt === null) {
      v = 'INFO'
      observed = `no fresh /login page to time (window.__qaMarker = ${markerText(marker)}, document loads ${docsText(t.docs)}${P ? '' : ', probe missing'}) — not scored`
    } else {
      const firstApi = P.calls.length ? P.calls[0].at : Infinity
      const boot = Math.min(P.appAt ?? Infinity, firstApi)
      const before = P.calls.filter((c) => c.at <= P.formAt)
      const sessions = before.filter((c) => c.path === '/api/auth/session').length
      v = sessions === 0 ? 'PASS' : 'FAIL'
      observed = `Logout → a fresh /login page (document loads ${docsText(t.docs)}; marker ${markerText(marker)}); ` +
        `the login form was visible ${Math.round(P.formAt - boot)} ms after the app booted (${wallMs} ms after the click); ` +
        `requests before the form: ${before.length ? before.map((c) => `${c.path} at +${Math.round(c.at - boot)} ms`).join(', ') : 'none'}; ` +
        `GET /api/auth/session before the form: ${sessions}. Throttle: ${THROTTLE_TEXT()}, applied before the Logout`
    }
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` } finally { await unthrottle(cdp) }
  const s = await shot(page, 's6-2-login-after-slow-signout')
  await ctx.close().catch(() => {})
  record({
    step, title: 'Sign-out on a slow network (throttled before the Logout); the fresh /login page is timed from app boot to a visible login form',
    expected: 'No GET /api/auth/session before the login form is visible: the form appears without a session round-trip',
    observed, verdict: v, shot: s,
  })
}

// ---- S7: a second tap on Sign In, after the first sign-in answered, sends nothing
async function doubleTapSignInCase() {
  const step = 'S7'
  let observed = ''; let v = 'FAIL'
  const notes = []
  const { ctx, page } = await freshPage(ADMIN_VP)
  let cdp = null
  const posts = []
  // The fresh page's own timeline: its document request, and the moment it committed.
  const tl = { docReqAt: 0, commitAt: 0 }
  const onReq = (r) => {
    if (r.method() === 'POST' && pathOf(r.url()) === '/api/auth/login') posts.push(Date.now())
    if (!tl.docReqAt && r.resourceType() === 'document' && r.frame() === page.mainFrame() && pathOf(r.url()) === '/dashboard') tl.docReqAt = Date.now()
  }
  const onNav = (f) => { if (f === page.mainFrame() && !tl.commitAt && pathOf(f.url()) === '/dashboard') tl.commitAt = Date.now() }
  try {
    const atLogin = await expireToLoginInApp({ ctx, page, step, prefix: 's7', notes, nextWho: 'the Dispatcher (a different person, so signing in loads a fresh page)', wake: 'event' })
    if (atLogin !== MARK) throw new Error('the page was loaded again on its way to /login, so a sign-in here would not load a fresh page')
    cdp = await throttle(ctx, page)
    const form = page.locator('form.login-form')
    await form.locator('input[autocomplete="username"]').fill(CREDS.dispatcher.username)
    await form.locator('input[autocomplete="current-password"]').fill(CREDS.dispatcher.password)
    await caption(page, `Step ${step} — network slowed (+${THROTTLE.latencyMs} ms per request). The Dispatcher presses Sign In, then presses it AGAIN once the first sign-in has answered, before the fresh page arrives → expect exactly one POST /api/auth/login`, false)
    page.on('request', onReq)
    page.on('framenavigated', onNav)
    const btn = form.locator('button[type="submit"]')
    // The first press is a real click. The second tap is made by the page itself,
    // 400 ms after the first sign-in answered: while the fresh page loads, DevTools
    // holds every command to this page until the fresh one has committed, so no
    // Playwright action or CDP call can reach it in that window, but the page's own
    // script still runs, as a person's tap still lands. It clicks Sign In (a
    // disabled button ignores click(), as it ignores a tap) and records what it saw,
    // and every sign-in POST it sent, in sessionStorage, which the fresh page in
    // the same tab can still read.
    await page.evaluate(({ delay, key }) => {
      sessionStorage.removeItem(key)
      const log = { posts: 0, answeredAt: null, tap: null }
      const save = () => { try { sessionStorage.setItem(key, JSON.stringify(log)) } catch { /* storage full */ } }
      const orig = window.fetch
      window.fetch = function (input, init) {
        let isLogin = false
        try {
          isLogin = String(init?.method || 'GET').toUpperCase() === 'POST' &&
            new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/api/auth/login'
        } catch { /* not a URL */ }
        const p = orig.apply(this, arguments)
        if (isLogin) {
          log.posts++
          save()
          if (log.posts === 1) {
            p.then(() => {
              log.answeredAt = Math.round(performance.now())
              save()
              setTimeout(() => {
                const b = document.querySelector('form.login-form button[type="submit"]')
                log.tap = {
                  afterMs: Math.round(performance.now()) - log.answeredAt,
                  disabled: b ? b.disabled : null, text: b ? b.textContent.trim() : '',
                  marker: window.__qaMarker === undefined ? 'undefined' : String(window.__qaMarker),
                }
                save()
                if (b) b.click()
              }, delay)
            }, () => {})
          }
        }
        return p
      }
    }, { delay: 400, key: S7_KEY })
    const firstResp = page.waitForResponse((r) => pathOf(r.url()) === '/api/auth/login' && r.request().method() === 'POST', { timeout: 90000 })
    const clickAt = Date.now()
    await btn.click()
    const resp = await firstResp
    const answeredAt = Date.now()
    await page.waitForURL((u) => u.pathname === '/dashboard', { timeout: 90000 })
    for (let i = 0; i < 160 && (await readMarker(page).catch(() => '?')) !== NO_MARK; i++) await page.waitForTimeout(250)
    await page.waitForTimeout(1500)
    page.off('request', onReq)
    page.off('framenavigated', onNav)
    const markerEnd = await readMarker(page)
    // What the old page recorded, read on the fresh one (same tab), then removed.
    const log = await evalSafe(page, (key) => { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v ? JSON.parse(v) : null }, S7_KEY).catch(() => null)
    await unthrottle(cdp); cdp = null
    const me = await whoAmI(page)
    const rel = (t) => (t ? `${t >= answeredAt ? '+' : ''}${t - answeredAt} ms` : 'not seen')
    const timeline = `timeline (0 = the first answer): Sign In pressed ${rel(clickAt)}; the fresh page's document requested ${rel(tl.docReqAt)}, committed ${rel(tl.commitAt)}`
    const tap = log?.tap || null
    const tapOnOldPage = !!tap && tap.marker === MARK
    const tapText = !log ? 'the page\'s own record was not found (not scored)'
      : !tap ? 'no second tap: the fresh page replaced this one first (window missed — not scored)'
        : `second tap ${tap.afterMs} ms after the first answer, on ${tapOnOldPage ? `this page (marker '${MARK}')` : 'ANOTHER page (not scored)'}: Sign In was ${tap.disabled ? 'DISABLED' : tap.disabled === false ? 'ENABLED' : 'not found'} ("${tap.text}")`
    v = tapOnOldPage ? (posts.length === 1 && log.posts === 1 ? 'PASS' : 'FAIL') : 'INFO'
    observed = `${notes.join('; ')}; first POST /api/auth/login → ${resp.status()}; ${timeline}; ${tapText}; ` +
      `POST /api/auth/login requests: ${posts.length} seen on the network, ${log ? log.posts : '?'} sent by the page; ` +
      `then on ${pathOf(page.url())}, window.__qaMarker = ${markerText(markerEnd)}; server session ${me.text}. Throttle: ${THROTTLE_TEXT()}, applied before the sign-in`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `${notes.length ? `${notes.join('; ')}; ` : ''}error: ${e.message}; POST /api/auth/login requests seen: ${posts.length}` } finally {
    page.off('request', onReq)
    page.off('framenavigated', onNav)
    await unthrottle(cdp)
  }
  const s = await shot(page, 's7-3-after')
  await ctx.close().catch(() => {})
  record({
    step, title: 'The S2 expiry path, then the Dispatcher signs in (a different person: a fresh page) on a slow network, pressing Sign In a second time after the first answered',
    expected: 'Exactly one POST /api/auth/login: the button stays disabled until the fresh page replaces this one',
    observed, verdict: v, shot: s,
  })
}

async function signoutSection() {
  meta.ids.superAdminUser = CREDS.superAdmin.userId
  meta.ids.driverUser = CREDS.driver.userId
  if (CREDS.dispatcher) meta.ids.dispatcherUser = CREDS.dispatcher.userId
  const skip = (step, title) => record({ step, title, expected: '—', observed: 'SKIPPED — creds.json has no dispatcher login (run setup-db.cjs)', verdict: 'SKIP', shot: '' })

  if (wantStep('S1a')) {
    await signOutCase({
      step: 'S1a', who: 'Super Admin', creds: CREDS.superAdmin, home: '/dashboard', viewport: ADMIN_VP,
      ready: (p) => p.locator('.kpi-grid:not(.revenue-grid) .kpi-value').first(),
      button: (p) => p.locator('a.nav-item', { hasText: 'Logout' }).first(),
      buttonLabel: 'the sidebar\'s Logout', prefix: 's1a',
    })
  }
  if (wantStep('S1b')) {
    await signOutCase({
      step: 'S1b', who: 'Driver', creds: CREDS.driver, home: '/driver', viewport: { width: DVW, height: DVH },
      ready: (p) => p.locator('button.header-btn.danger', { hasText: 'Logout' }).first(),
      button: (p) => p.locator('button.header-btn.danger', { hasText: 'Logout' }).first(),
      buttonLabel: 'the driver app\'s Logout button', prefix: 's1b',
    })
  }
  if (wantStep('S2a')) {
    if (CREDS.dispatcher) {
      await expiredSessionCase({ step: 'S2a', signer: CREDS.dispatcher, signerWho: 'the Dispatcher', sameUser: false, prefix: 's2a' })
    } else skip('S2a', 'Session expired; the Dispatcher signs in on that page')
  }
  if (wantStep('S2b')) await expiredSessionCase({ step: 'S2b', signer: CREDS.superAdmin, signerWho: 'the same Super Admin', sameUser: true, prefix: 's2b' })
  if (wantStep('S3')) {
    if (CREDS.dispatcher) await residueCase()
    else skip('S3', 'Visible residue after sign-out → Dispatcher sign-in')
  }
  // S4-S7: each case in its own browser context, like S1-S3.
  if (wantStep('S4a')) await offlineSignOutCase()
  if (wantStep('S4b')) await serverDownSignOutCase()
  if (wantStep('S5a')) await otherTabSignOutCase()
  if (wantStep('S5b')) {
    if (CREDS.dispatcher) await otherTabNewPersonCase()
    else skip('S5b', 'The session ends without a sign-out; another tab leaves for a clean /login')
  }
  if (wantStep('S5c')) {
    if (CREDS.dispatcher) await otherTabDifferentPersonCase()
    else skip('S5c', 'Another tab signs a different person in; this tab reloads as them')
  }
  if (wantStep('S6')) await slowSignOutCase()
  if (wantStep('S7')) {
    if (CREDS.dispatcher) await doubleTapSignInCase()
    else skip('S7', 'One sign-in POST on a double tap')
  }
}

// ================================================================ Dispatcher data section (D1-D3)
// What a Dispatcher's copies of the loads carry in the broker/contact columns
// (BROKER_WITHHELD_RE, the mirror of server.js). Counts only: values stay in memory.
// A Super Admin context reads the same things for comparison, so a 0 cannot come
// from data that has nothing to withhold.
const withheldHeadersOf = (obj) => Object.keys(obj || {}).filter((h) => BROKER_WITHHELD_RE.test(h))
async function dispatcherSection() {
  if (!CREDS.dispatcher) {
    for (const [step, title] of [['D1', 'The Dispatcher\'s GET /api/dashboard: broker/contact cells'], ['D2', 'The Dispatcher\'s GET /api/load/<id>: broker/contact fields'],
      ['D3a', 'The Dispatcher\'s GET /api/data?sheet=Job Tracking'], ['D3b', 'The Dispatcher\'s GET /api/data?sheet=Job Tracking!A2:ZZ'], ['D3c', 'The Dispatcher\'s GET /api/data?sheet=Payments Table']]) {
      record({ step, title, expected: '—', observed: 'SKIPPED — the creds file has no dispatcher login (run setup-db.cjs)', verdict: 'SKIP', shot: '' })
    }
    return
  }
  meta.ids.dispatcherUser = CREDS.dispatcher.userId
  const { ctx: dctx, page: dp } = await freshPage(ADMIN_VP)
  let sctx = null
  try {
    // ---- D1: the payload the Dispatcher's own dashboard receives
    let dPayload = null
    const onResp = async (r) => {
      if (dPayload || pathOf(r.url()) !== '/api/dashboard' || r.request().method() !== 'GET' || r.status() !== 200) return
      try { dPayload = await r.json() } catch { /* ignore */ }
    }
    dp.on('response', onResp)
    await login(dp, 'Step D1 — Dispatcher', CREDS.dispatcher.username, CREDS.dispatcher.password, '/dashboard')
    await dp.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 })
    for (let i = 0; i < 100 && !dPayload; i++) await dp.waitForTimeout(100)
    dp.off('response', onResp)
    const dVia = dPayload ? 'the dashboard\'s own request' : 'a page fetch (the dashboard\'s own response was not captured)'
    if (!dPayload) dPayload = (await api(dp, 'GET', '/api/dashboard')).json
    const disp = withheldOf(dPayload)
    // The Super Admin's copy, for comparison.
    const sa0 = await freshPage(ADMIN_VP)
    sctx = sa0.ctx
    const sp = sa0.page
    await login(sp, 'Step D1 — Super Admin (the copy to compare with)', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    const saPayload = (await api(sp, 'GET', '/api/dashboard')).json
    const sa = withheldOf(saPayload)
    const saOnly = superAdminOnlyCells(sa, disp)
    {
      const ok = disp.cells === 0
      const observed = `the Dispatcher's payload (${dVia}): ${disp.headers} broker/contact column(s), ${disp.cells} non-empty cell(s)` +
        `${disp.cells ? `, ${sa.cells - saOnly} of them identical to the Super Admin's copy (the rest reduced to a name)` : ''}; ` +
        `the Super Admin's copy: ${sa.cells} non-empty (${saOnly} of them withheld from the Dispatcher's copy or reduced)`
      await caption(dp, `Step D1 — the Dispatcher's dashboard: ${observed}`)
      const s = await shot(dp, 'd1-dispatcher-dashboard')
      record({
        step: 'D1', title: 'The Dispatcher signs in; the payload of their dashboard\'s GET /api/dashboard (broker/contact columns: headers matching BROKER_WITHHELD_RE)',
        expected: '0 non-empty cells in any broker/contact column (not even a name)',
        observed: sa.cells === 0 && ok ? `${observed} — vacuous: this data has no broker/contact values to withhold` : observed,
        verdict: ok ? (sa.cells === 0 ? 'PASS (vacuous)' : 'PASS') : 'FAIL', shot: s,
      })
    }

    // ---- D2: one real load, read with GET /api/load/<id>
    {
      let observed; let v = 'FAIL'; let s = ''
      try {
        const hs = saPayload?.jobTrackingHeaders || []
        const idCol = hs.find((h) => /load.?id|job.?id/i.test(String(h ?? '')))
        const wh = hs.filter((h) => BROKER_WITHHELD_RE.test(String(h ?? '')))
        const rowsSA = ['activeJobs', 'unassignedJobs', 'completedJobs'].flatMap((k) => saPayload?.[k] || [])
        const candidates = rowsSA
          .map((r) => ({ id: String(r?.[idCol] ?? ''), n: wh.filter((h) => String(r?.[h] ?? '').trim()).length }))
          .filter((c) => c.id.trim() && c.n > 0)
          .sort((x, y) => y.n - x.n)
          .slice(0, 5)
        if (!idCol) throw new Error('no load id column in the dashboard payload')
        if (!candidates.length) throw new Error('no load in the Super Admin\'s dashboard carries a broker/contact value')
        let pick = null; let dl = null; let sl = null
        for (const c of candidates) {
          dl = await api(dp, 'GET', `/api/load/${encodeURIComponent(c.id)}`)
          if (dl.status === 404) continue
          sl = await api(sp, 'GET', `/api/load/${encodeURIComponent(c.id)}`)
          pick = c
          break
        }
        if (!pick) throw new Error(`none of ${candidates.length} candidate loads was found by GET /api/load/<id>`)
        meta.ids.d2Load = pick.id
        const dLoad = dl.json?.load || null
        const sLoad = sl?.json?.load || null
        const dFields = withheldHeadersOf(dLoad)
        const dNonEmpty = dFields.filter((h) => String(dLoad[h] ?? '').trim())
        const sNonEmpty = withheldHeadersOf(sLoad).filter((h) => String(sLoad[h] ?? '').trim())
        const same = dNonEmpty.filter((h) => sLoad && String(sLoad[h] ?? '') === String(dLoad[h] ?? '')).length
        if (dl.status !== 200 || !dLoad) v = 'FAIL'
        else if (dNonEmpty.length) v = 'FAIL'
        else v = sNonEmpty.length ? 'PASS' : 'PASS (vacuous)'
        observed = `load ${pick.id}: the Dispatcher's GET /api/load → ${dl.status}; ${dFields.length} broker/contact field(s), ${dNonEmpty.length} non-empty` +
          `${dNonEmpty.length ? ` (${same} identical to the Super Admin's copy)` : ''}; the Super Admin's GET /api/load → ${sl?.status}, ${sNonEmpty.length} non-empty`
        if (v === 'PASS (vacuous)') observed += ' — vacuous: the Super Admin\'s copy has none either'
        await caption(dp, `Step D2 — ${observed}`)
        s = await shot(dp, 'd2-dispatcher-load')
      } catch (e) { observed = `error: ${e.message}` }
      if (!s) s = await shot(dp, 'd2-dispatcher-load')
      record({
        step: 'D2', title: 'The Dispatcher\'s GET /api/load/<a real load id> (the load with the most broker/contact values in the Super Admin\'s dashboard)',
        expected: 'The load answers 200 with every broker/contact field blank (the Super Admin\'s copy still has them)',
        observed, verdict: v, shot: s,
      })
    }

    // ---- D3: the sheet reader, GET /api/data, with the Dispatcher's session. Read-only.
    // Summarized in the page: counts leave it, values never do.
    {
      const cases = [
        { id: 'D3a', q: 'Job%20Tracking', label: 'Job Tracking' },
        { id: 'D3b', q: 'Job%20Tracking!A2:ZZ', label: 'Job Tracking!A2:ZZ (a range of the tab)' },
        { id: 'D3c', q: 'Payments%20Table', label: 'Payments Table' },
      ]
      const logs = []
      for (const c of cases) {
        let observed; let ok = false
        try {
          const r = await dp.evaluate(async (url) => {
            const RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i
            const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i
            const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            const text = await res.text()
            let j = null
            try { j = JSON.parse(text) } catch { /* not json */ }
            const out = { status: res.status, isJson: !!j, error: typeof j?.error === 'string' ? j.error.slice(0, 80) : '' }
            if (!j || !Array.isArray(j.data)) return out
            const headers = (j.headers || []).map((h) => String(h ?? ''))
            const wh = headers.filter((h) => RE.test(h))
            const count = (rows) => {
              let cells = 0; let emails = 0; let phones = 0
              for (const row of rows || []) {
                for (const h of wh) if (String(row?.[h] ?? '').trim()) cells++
                for (const [k, v] of Object.entries(row || {})) {
                  if (k === '_rowIndex') continue
                  const s = String(v ?? '')
                  if (EMAIL.test(s)) emails++
                  else if (PHONE.test(s)) phones++
                }
              }
              return { cells, emails, phones }
            }
            const d = count(j.data)
            const dup = count(j.duplicates)
            // The headers row it returned is counted too.
            const hEmails = headers.filter((h) => EMAIL.test(h)).length
            const hPhones = headers.filter((h) => !EMAIL.test(h) && PHONE.test(h)).length
            return {
              ...out, rows: j.data.length, total: j.total, headerCount: headers.length, contactColumns: wh.length,
              data: d, duplicates: Array.isArray(j.duplicates) ? { rows: j.duplicates.length, ...dup } : null, hEmails, hPhones,
            }
          }, `/api/data?sheet=${c.q}`)
          ok = r.status === 403
          const contact = r.isJson && r.data
            ? r.data.emails + r.data.phones + (r.duplicates ? r.duplicates.emails + r.duplicates.phones : 0) + r.hEmails + r.hPhones
            : 0
          observed = `${r.status}${r.error ? ` "${r.error}"` : ''}` + (r.isJson && r.data
            ? `; ${r.rows} row(s) of ${r.total}; ${r.contactColumns} broker/contact column(s) by header, ${r.data.cells} non-empty cell(s) in them` +
              `${r.duplicates ? `; "duplicates": ${r.duplicates.rows} row(s), ${r.duplicates.cells} non-empty broker/contact cell(s)` : ''}` +
              `; email-looking values ${r.data.emails + (r.duplicates?.emails || 0) + r.hEmails}, phone-looking values ${r.data.phones + (r.duplicates?.phones || 0) + r.hPhones}` +
              ` (${r.hEmails + r.hPhones} of them in the returned headers row) → contact data ${contact ? 'PRESENT' : 'absent'}`
            : '')
          logs.push(`${c.id} → ${r.status}`)
        } catch (e) { observed = `error: ${e.message}` }
        record({
          step: c.id, title: `The Dispatcher's page fetch of GET /api/data?sheet=${c.label}`,
          expected: '403: the sheet reader is Super Admin only (no Dispatcher screen uses it)',
          observed, verdict: verdict(ok), shot: '',
        })
      }
      await caption(dp, `Step D3 — the Dispatcher's GET /api/data (counts only): ${logs.join(' · ')}`)
      const s = await shot(dp, 'd3-dispatcher-sheet-reader')
      rows.filter((r) => /^D3[a-c]$/.test(r.step)).forEach((r) => { r.shot = s })
      writeResults()
    }
  } finally {
    await sctx?.close().catch(() => {})
    await dctx.close().catch(() => {})
  }
}

// ================================================================ maintenance notice section (M1)
// Local only, with the server booted with the notice on (boot-server.sh with
// E2E_MAINTENANCE_NOTICE=1). Two Investors take turns in ONE tab.
async function maintenanceSection() {
  const title = 'Investor A dismisses the maintenance popup and signs out; Investor B signs in on the same tab'
  const expected = 'B sees the popup (a dismissal belongs to the person who dismissed it)'
  const titleB = 'Then B signs out and Investor A signs back in on that tab'
  const expectedB = 'A does NOT see the popup again (their own dismissal still holds)'
  const skipBoth = (why) => {
    record({ step: 'M1a', title, expected, observed: `SKIPPED — ${why}`, verdict: 'SKIP', shot: '' })
    record({ step: 'M1b', title: titleB, expected: expectedB, observed: `SKIPPED — ${why}`, verdict: 'SKIP', shot: '' })
  }
  if (!LOCAL) return skipBoth('local only (the notice is off on staging)')
  if (!CREDS.investor || !CREDS.investor2) return skipBoth('the creds file needs two investor logins (investor, investor2): run setup-db.cjs')
  meta.ids.investorUser = CREDS.investor.userId
  meta.ids.investor2User = CREDS.investor2.userId
  const { ctx, page } = await freshPage(ADMIN_VP)
  const popup = page.locator('.maintenance-overlay .maintenance-dialog')
  const popupShows = (ms) => popup.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false)
  const dismiss = async () => {
    await popup.locator('.maintenance-actions button').first().click()
    await popup.waitFor({ state: 'hidden', timeout: 10000 })
  }
  const signOut = async () => {
    await sidebarLogout(page).click()
    await settleOn(page, '/login', page.locator('form.login-form'), 800)
  }
  const investorHome = async () => {
    await page.waitForURL((u) => u.pathname.startsWith('/investor'), { timeout: 45000 })
    await page.waitForLoadState('load')
  }
  try {
    await page.goto(`${BASE_URL}/login`)
    const cfg = (await api(page, 'GET', '/api/config/maintenance')).json || {}
    if (!cfg.enabled) { await ctx.close().catch(() => {}); return skipBoth('the notice is off on this server (boot it with E2E_MAINTENANCE_NOTICE=1)') }
    if (!['investor', 'all'].includes(cfg.audience)) { await ctx.close().catch(() => {}); return skipBoth(`the notice's audience is "${cfg.audience}", which has no investors`) }
    // A: sees the popup, dismisses it, signs out.
    await login(page, 'Step M1 — Investor A', CREDS.investor.username, CREDS.investor.password, '/investor')
    await investorHome()
    const aSaw = await popupShows(20000)
    await caption(page, `Step M1 — Investor A (#${CREDS.investor.userId}) signed in: the maintenance popup ${aSaw ? 'shows' : 'does NOT show'}. A dismisses it and signs out; then Investor B signs in on this same tab`)
    await shot(page, 'm1-1-investor-a-popup')
    if (!aSaw) throw new Error('Investor A never saw the popup, so there was no dismissal to carry over')
    await dismiss()
    await signOut()
    // B: same tab.
    await signInHere(page, 'Step M1 — Investor B, same tab', CREDS.investor2.username, CREDS.investor2.password)
    await investorHome()
    const bSaw = await popupShows(12000)
    const bWho = await whoAmI(page)
    const obsA = `A (#${CREDS.investor.userId}) saw the popup and dismissed it, then signed out; B signed in on the same tab (session ${bWho.text}): the popup ${bSaw ? 'SHOWS' : 'does NOT show'} for B within 12 s`
    await caption(page, `Step M1a — result: ${obsA}`)
    const sA = await shot(page, 'm1-2-investor-b-same-tab')
    record({ step: 'M1a', title, expected, observed: obsA, verdict: verdict(bSaw), shot: sA })
    // B signs out; A again, same tab.
    if (bSaw) await dismiss()
    await signOut()
    await signInHere(page, 'Step M1 — Investor A again, same tab', CREDS.investor.username, CREDS.investor.password)
    await investorHome()
    const aAgain = await popupShows(8000)
    const aWho = await whoAmI(page)
    let obsB = `A signed back in on that tab (session ${aWho.text}): the popup ${aAgain ? 'SHOWS again' : 'does not show'} within 8 s`
    const vB = aAgain ? 'FAIL' : (bSaw ? 'PASS' : 'PASS (vacuous)')
    if (vB === 'PASS (vacuous)') obsB += ' — vacuous: on this build the tab\'s one dismissal hides the popup from everyone (see M1a)'
    await caption(page, `Step M1b — result: ${obsB}`)
    const sB = await shot(page, 'm1-3-investor-a-again')
    record({ step: 'M1b', title: titleB, expected: expectedB, observed: obsB, verdict: vB, shot: sB })
  } catch (e) {
    const s = await shot(page, 'm1-error')
    if (!rows.some((r) => r.step === 'M1a')) record({ step: 'M1a', title, expected, observed: `error: ${e.message}`, verdict: 'FAIL', shot: s })
    else record({ step: 'M1b', title: titleB, expected: expectedB, observed: `error: ${e.message}`, verdict: 'FAIL', shot: s })
  } finally {
    await ctx.close().catch(() => {})
  }
}

// ================================================================ money-path section (P1, E1, N1, N1b, F1, E2, B1, RC1)
// ONLY=moneypath. Every "Expected" column is the behaviour AFTER the money-path
// follow-ups (E2, B1 and RC1 are described at their own code, below F1):
//   P1 (UI, local and staging) the Drivers Database's Edit dialog stores a daily rate
//      that was emptied, or typed as 0, as 0, and leaves the percentage alone.
//   E1 (planted, local) a driver's new expense carries the unit and owner of the truck
//      whose assigned_driver is a spacing variant of the driver's name.
//   N1 (planted, local) a rename on the Users page also moves the rows stored under a
//      spacing variant of the old name.
//   N1b (planted, local) re-spelling an account onto its own directory row's spacing
//      saves (no 409 DRIVER_RENAME_IS_MERGE), and moves its rows onto that spelling.
//   F1 (local only) an Active Loads edit writes only the cell that changed.
// Real names stay in memory: the results name rows by id, and a spacing variant is
// described, never printed.
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
// The name with its first internal whitespace run doubled; a one-word name gets a
// trailing space. Either folds back to the same name through normalizeDriverName().
const spacingVariant = (s) => (/\s/.test(String(s).trim()) ? String(s).trim().replace(/\s+/, '  ') : `${String(s).trim()} `)
const variantText = (s) => (/\s/.test(String(s).trim()) ? 'the name with its space doubled' : 'the name with a trailing space')
// A day in the server's business zone (US Central), as YYYY-MM-DD.
const dayCT = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
// STEPS=P1 selects P1a and P1b.
const wantMp = (id) => !STEPS || [...STEPS].some((s) => id.toUpperCase().startsWith(s))
const mpNotes = [] // what each case restored or deleted, for the MPc row

// DB_PATH must be the database THIS server reads, or E1 and N1 would test nothing.
// A throwaway directory row (QA-TEST-DRV-<stamp>-DBCHECK) is inserted, looked for
// through GET /api/drivers-directory, and deleted again.
async function proveMoneyPathDb(page) {
  const name = `${QA_DRIVER_PREFIX}${stamp}-DBCHECK`
  let reason = ''
  try {
    const id = db.prepare("INSERT INTO drivers_directory (driver_name, status) VALUES (?, 'active')").run(name).lastInsertRowid
    try {
      const r = await api(page, 'GET', '/api/drivers-directory')
      if (!(r.json?.data || []).some((d) => String(d._id) === String(id) && d.Driver === name)) {
        reason = `a row written to DB_PATH (#${id}) did not appear through GET /api/drivers-directory (${r.status})`
      }
    } finally {
      db.prepare('DELETE FROM drivers_directory WHERE id = ? AND driver_name = ?').run(id, name)
    }
  } catch (e) { reason = e.message }
  if (!reason) return true
  record({ step: 'MP*', title: 'DB_PATH sanity check', expected: 'The server reads DB_PATH', observed: `${reason} — DB_PATH is not this server's DATABASE_PATH; E1, N1, N1b, E2, B1 and RC1 are skipped, P1 uses a real driver`, verdict: 'FAIL', shot: '' })
  try { db.close() } catch { /* ignore */ }
  db = null
  return false
}

// ---- P1: clear a fixed-pay driver's daily rate in the Drivers Database
// The rate is first SET, through the same dialog, to the driver's current resolved
// rate R (their own rate, else their truck's, else the $250 default), so neither save
// moves a figure the pay math reads and the month-end lock has nothing to refuse.
// Local (DB_PATH): a planted directory row, QA-TEST-DRV-<stamp>-P1, fixed, rate 0,
// owner-operator share 37 % (the inactive pay type's value, which must survive).
// Staging: a real fixed-pay driver whose resolved rate a clear cannot move; its row
// is put back as it was read (a page fetch of the same PUT the dialog sends).
const payText = (d) => (d ? `PayType ${d.PayType}, PayDaily ${d.PayDaily}, PayPercentage ${d.PayPercentage}` : '(row missing)')
async function openDriverEdit(page, name) {
  const row = page.locator('table.drv-table tbody tr', { has: page.locator('td.name-cell', { hasText: exactText(name) }) }).first()
  await row.waitFor({ state: 'visible', timeout: 30000 })
  await row.scrollIntoViewIfNeeded()
  await row.locator('button.btn-edit').click()
  const modal = page.locator('.confirm-dialog.edit-dialog')
  await modal.waitFor({ state: 'visible', timeout: 15000 })
  return modal
}
async function saveDailyRate(page, name, id, text) {
  const modal = await openDriverEdit(page, name)
  if (!(await modal.locator('input[type="radio"][value="fixed"]').isChecked())) throw new Error('the Edit dialog does not show the fixed pay type')
  await field(modal, 'Daily Rate ($/day)').fill(text)
  // The page reloads the list after a save that succeeded (none after a refusal).
  const reload = page.waitForResponse((r) => pathOf(r.url()) === '/api/drivers-directory' && r.request().method() === 'GET', { timeout: 15000 }).catch(() => null)
  const [resp] = await Promise.all([
    page.waitForResponse((r) => pathOf(r.url()) === `/api/drivers-directory/${id}` && r.request().method() === 'PUT', { timeout: 30000 }),
    modal.locator('.confirm-actions button.btn-primary').click(),
  ])
  let body = null
  try { body = await resp.json() } catch { /* not json */ }
  if (resp.status() === 200) await reload
  await page.waitForTimeout(400)
  return { status: resp.status(), code: body?.code || '', error: String(body?.error || '').slice(0, 300) }
}
// Reopen the dialog, read what it shows, screenshot it, Cancel.
async function showDailyRate(page, name, shotName, text) {
  const modal = await openDriverEdit(page, name)
  const shown = await field(modal, 'Daily Rate ($/day)').inputValue()
  await caption(page, `${text} — the Edit dialog, reopened, shows Daily Rate "${shown}"`)
  const s = await shot(page, shotName)
  await modal.locator('.confirm-actions button.btn-secondary').click()
  await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
  return s
}
async function payRateCase(page) {
  const cases = [
    { step: 'P1a', how: 'emptied', text: '', title: 'Drivers Database → Edit a fixed-pay driver: Daily Rate set to their current rate and saved, then EMPTIED and saved' },
    { step: 'P1b', how: 'typed as 0', text: '0', title: 'The same driver: Daily Rate set again and saved, then TYPED AS 0 and saved' },
  ].filter((c) => wantMp(c.step))
  if (!cases.length) return
  const expected = 'Stored PayDaily 0 (read back through GET /api/drivers-directory); PayPercentage and PayType as they were'
  const skipAll = (why) => cases.forEach((c) => record({ step: c.step, title: c.title, expected, observed: why, verdict: 'SKIP', shot: '' }))
  let id; let name; let R; let mode; let original
  await page.goto(`${BASE_URL}/drivers`)
  await page.locator('table.drv-table').waitFor({ state: 'visible', timeout: 30000 })
  const readRow = async () => (await api(page, 'GET', '/api/drivers-directory')).json?.data?.find((d) => String(d._id) === String(id)) || null
  if (db) {
    mode = 'planted'
    name = `${QA_DRIVER_PREFIX}${stamp}-P1`
    id = db.prepare("INSERT INTO drivers_directory (driver_name, status, pay_type, pay_percentage, pay_daily) VALUES (?, 'active', 'fixed', 37, 0)").run(name).lastInsertRowid
    noteCreated('drivers_directory', id)
    R = 250 // no truck: the $250 default is what a rate of 0 resolves to
    await page.reload()
    await page.locator('table.drv-table').waitFor({ state: 'visible', timeout: 30000 })
  } else {
    mode = 'real'
    const dir = (await api(page, 'GET', '/api/drivers-directory')).json?.data || []
    const trucks = (await api(page, 'GET', '/api/trucks')).json?.trucks || []
    const cands = []
    for (const d of dir) {
      if (String(d.PayType || 'fixed').toLowerCase() === 'percentage' || !String(d.Driver || '').trim()) continue
      const rates = [...new Set(trucks.filter((t) => normName(t.AssignedDriver) === normName(d.Driver)).map((t) => Number(t.DriverPayDaily) || 250))]
      if (rates.length > 1) continue
      const truckRate = rates[0] || 250
      const own = Number(d.PayDaily) || 0
      if (own && own !== truckRate) continue // a clear would move their resolved rate
      cands.push({ d, R: own || truckRate, own })
    }
    cands.sort((a, b) => (a.own ? 1 : 0) - (b.own ? 1 : 0) || Number(a.d._id) - Number(b.d._id))
    if (!cands.length) return skipAll('SKIPPED — no fixed-pay driver whose resolved rate a clear leaves unchanged (the month-end lock would refuse every other one)')
    id = cands[0].d._id
    name = cands[0].d.Driver
    R = cands[0].R
  }
  meta.ids.p1DirectoryRow = id
  original = await readRow()
  if (!original) return skipAll(`SKIPPED — directory row #${id} is not listed by GET /api/drivers-directory`)
  const who = mode === 'planted' ? `planted row #${id} (fixed, rate 0, share 37 %)` : `driver row #${id} (fixed)`
  try {
    for (const c of cases) {
      let observed = ''; let v = 'FAIL'; let s = ''
      try {
        await caption(page, `Step ${c.step} — ${who}: set Daily Rate ${R} and Save, then ${c.how} and Save`)
        const set = await saveDailyRate(page, name, id, String(R))
        const afterSet = await readRow()
        if (set.status !== 200) {
          v = 'INFO'
          observed = `setting the rate to ${R} first answered ${set.status}${set.code ? ` ${set.code}` : ''}` +
            `${set.status === 409 ? ' — the month-end lock refused it' : ''}: ${set.error}`
        } else if (Number(afterSet?.PayDaily) !== R) {
          v = 'INFO'
          observed = `setting the rate to ${R} did not store it (${payText(afterSet)}), so there was nothing to clear`
        } else {
          const clr = await saveDailyRate(page, name, id, c.text)
          const after = await readRow()
          if (clr.status === 409) {
            v = 'INFO'
            observed = `set ${R} → stored ${afterSet.PayDaily}; then ${c.how} → 409 ${clr.code}: the month-end lock refused the clear (${clr.error})`
          } else {
            const kept = Number(after?.PayDaily) === R
            const ok = clr.status === 200 && Number(after?.PayDaily) === 0 &&
              Number(after?.PayPercentage) === Number(original.PayPercentage) && String(after?.PayType) === String(original.PayType)
            v = verdict(ok)
            observed = `${who}: set ${R} → ${set.status}, stored ${afterSet.PayDaily}; then ${c.how} → ${clr.status}${clr.code ? ` ${clr.code}` : ''}; ` +
              `stored now: ${payText(after)} (PayPercentage before: ${original.PayPercentage})${kept ? ' — the old rate was KEPT' : ''}`
          }
        }
        s = await showDailyRate(page, name, `${c.step.toLowerCase()}-daily-rate`, `Step ${c.step} — ${v}`)
      } catch (e) {
        observed = `error: ${e.message}`
        s = await shot(page, `${c.step.toLowerCase()}-error`)
      }
      record({ step: c.step, title: c.title, expected, observed, verdict: v, shot: s })
    }
  } finally {
    if (mode === 'planted') {
      const n = db.prepare('DELETE FROM drivers_directory WHERE id = ? AND driver_name = ?').run(id, name).changes
      forgetCreated('drivers_directory', id)
      mpNotes.push(`P1 planted directory row #${id} ${n === 1 ? 'deleted' : 'NOT FOUND to delete (LEFT BEHIND?)'}`)
    }
    if (mode === 'real') {
      // Put the row back exactly as it was read: the same PUT the dialog sends, every
      // column as stored (a string "0" is a value to the route; a number 0 is not).
      const cur = await readRow()
      const heads = (await api(page, 'GET', '/api/drivers-directory')).json?.headers || []
      const same = cur && heads.every((h) => String(cur[h] ?? '') === String(original[h] ?? ''))
      if (same) mpNotes.push(`P1 driver row #${id} unchanged`)
      else {
        const put = await api(page, 'PUT', `/api/drivers-directory/${id}`, { headers: heads, values: heads.map((h) => String(original[h] ?? '')) })
        const back = await readRow()
        const ok = back && heads.every((h) => String(back[h] ?? '') === String(original[h] ?? ''))
        mpNotes.push(`P1 driver row #${id} put back (${put.status}): ${ok ? 'restored' : `RESTORE MISMATCH (${payText(back)})`}`)
      }
    }
  }
}

// ---- E1: a new expense is stamped with the truck whose assigned_driver is a
// spacing variant of the driver's name. Local, planted: the harness driver's own
// truck (creds.json's truckId) gets the variant; the driver files the expense from
// their own page, the smallest body the route takes (no receipt).
async function expenseStampCase() {
  const title = 'The driver\'s truck has assigned_driver = a spacing variant of their name (planted); the driver files an expense for one of their own loads (a page fetch of POST /api/expenses, as the app does)'
  const expected = 'The stored expense carries that truck\'s unit (truck_unit) and owner (owner_id)'
  if (!db) return record({ step: 'E1', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  const truck = db.prepare('SELECT id, unit_number, owner_id, assigned_driver FROM trucks WHERE id = ?').get(CREDS.driver.truckId)
  const user = db.prepare('SELECT driver_name FROM users WHERE id = ?').get(CREDS.driver.userId)
  if (!truck || !user || normName(truck.assigned_driver) !== normName(user.driver_name)) {
    return record({ step: 'E1', title, expected, observed: `SKIPPED — truck #${CREDS.driver.truckId} is not assigned to the harness driver (re-run setup-db.cjs)`, verdict: 'SKIP', shot: '' })
  }
  meta.ids.e1Truck = truck.id
  const { ctx, page } = await freshPage({ width: DVW, height: DVH })
  let expenseId = null
  let observed = ''; let v = 'FAIL'; let s = ''
  try {
    await login(page, 'Step E1 — Driver', CREDS.driver.username, CREDS.driver.password, '/driver')
    // The driver's loads, as the app reads them: each carries _expenseWindow.
    const me = await whoAmI(page)
    const dr = await api(page, 'GET', `/api/driver/${encodeURIComponent(user.driver_name)}`)
    const heads = Array.isArray(dr.json?.headers) ? dr.json.headers : (dr.json?.headers?.jobTracking || [])
    const idCol = heads.find((h) => /load.?id|job.?id/i.test(String(h || '')))
    const loads = (Array.isArray(dr.json?.loads) ? dr.json.loads : []).filter((r) => r && typeof r === 'object' && r._expenseWindow)
    const open = loads.filter((r) => r._expenseWindow.eligible && String(r[idCol] ?? '').trim())
    let filer = page
    let loadId = open.length ? String(open[0][idCol]).trim() : ''
    let via = `the driver (${me.text}), for load ${loadId} (its receipt window is open)`
    let adminCtx2 = null
    if (!loadId) {
      // No load of theirs takes a receipt today: the Super Admin files it on the
      // driver's behalf instead. The route stamps the truck by the same lookup.
      const any = loads.find((r) => String(r[idCol] ?? '').trim())
      if (!any) throw new Error(`the driver's page lists no load (GET /api/driver → ${dr.status})`)
      loadId = String(any[idCol]).trim()
      const a = await freshPage(ADMIN_VP)
      adminCtx2 = a.ctx
      filer = a.page
      await login(filer, 'Step E1 — Super Admin (files on the driver\'s behalf)', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      via = `the Super Admin on the driver's behalf (no load of the driver takes a receipt today: ${loads.length} load(s), windows ${[...new Set(loads.map((r) => r._expenseWindow.state))].join('/')}), for load ${loadId}`
    }
    plant('trucks', 'assigned_driver', truck.id, spacingVariant(user.driver_name))
    const amount = Number((1 + (Date.now() % 89) / 100).toFixed(2))
    const body = { loadId, type: 'Other', amount, date: dayCT(), description: `QA-TEST-E1-${stamp}` }
    if (filer !== page) body.driver = user.driver_name
    const res = await api(filer, 'POST', '/api/expenses', body)
    if (res.status === 200 && res.json?.id) {
      expenseId = res.json.id
      noteCreated('expenses', expenseId)
      meta.ids.e1Expense = expenseId
    }
    await adminCtx2?.close().catch(() => {})
    if (!expenseId) {
      v = 'INFO'
      observed = `filed by ${via}: POST /api/expenses → ${res.status}${res.json?.code ? ` ${res.json.code}` : ''} ${String(res.json?.error || res.text || '').slice(0, 200)} — no expense to read back`
    } else {
      const row = db.prepare('SELECT truck_unit, owner_id FROM expenses WHERE id = ?').get(expenseId)
      const ok = row.truck_unit === truck.unit_number && Number(row.owner_id) === Number(truck.owner_id)
      v = verdict(ok)
      observed = `truck #${truck.id} (unit ${truck.unit_number}, owner #${truck.owner_id}) planted with ${variantText(user.driver_name)}; filed by ${via}: 200, expense #${expenseId}; ` +
        `stored truck_unit ${JSON.stringify(row.truck_unit)}, owner_id ${row.owner_id}${ok ? '' : ' — the truck was NOT found'}`
    }
    await caption(page, `Step E1 — ${v}: ${observed}`)
    s = await shot(page, 'e1-expense-truck-stamp')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'e1-error')
  } finally {
    await ctx.close().catch(() => {})
    try {
      if (expenseId) {
        const n = db.prepare('DELETE FROM expenses WHERE id = ? AND description = ?').run(expenseId, `QA-TEST-E1-${stamp}`).changes
        forgetCreated('expenses', expenseId)
        mpNotes.push(`E1 expense #${expenseId} ${n === 1 ? 'deleted' : 'NOT FOUND to delete (LEFT BEHIND?)'}`)
      }
      mpNotes.push(...restoreAll().map((n) => `E1 ${n}`))
    } catch (e) { mpNotes.push(`E1 clean-up error: ${e.message}`) }
  }
  record({ step: 'E1', title, expected, observed, verdict: v, shot: s })
}

// ---- N1: a rename on the Users page moves the rows under a spacing variant of the
// old name. Local, planted. The Users page's Linked Driver list offers only names in
// the drivers directory, and a rename onto a name the directory already holds is
// refused as a merge, so the one rename this page can make is a re-spelling of the
// account's own directory name: the account is created as "qa-test-n1-<stamp>
// driver" beside a directory row "QA-TEST-N1-<stamp> Driver", and renamed onto it.
async function renameSpacingCase(page) {
  const title = 'Users page → Edit a throwaway Driver account → Linked Driver = its directory spelling → Save, with its rows in expenses, truck_assignments and invoices stored under the old name with its space doubled (planted)'
  const expected = 'Every planted row carries the new name (expenses and truck_assignments as spelled; invoices lowercase, that column\'s own convention)'
  if (!db) return record({ step: 'N1', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  const base = `QA-TEST-N1-${stamp}`
  const NEW = `${base} Driver`
  const OLD = NEW.toLowerCase()
  const VARIANT = spacingVariant(OLD)
  const username = base.toLowerCase()
  let observed = ''; let v = 'FAIL'; let s = ''
  const planted = {}
  try {
    // The directory row the Linked Driver list offers, and the account (the same
    // calls the Drivers Database and Users pages make).
    const dAdd = await api(page, 'POST', '/api/drivers-directory', { headers: ['Driver'], values: [NEW] })
    const dirRow = db.prepare('SELECT id FROM drivers_directory WHERE driver_name = ?').get(NEW)
    if (dirRow) noteCreated('drivers_directory', dirRow.id)
    const uAdd = await api(page, 'POST', '/api/users', { username, password: `qa-${Math.random().toString(36).slice(2)}-${Date.now()}`, role: 'Driver', driverName: OLD })
    const acct = db.prepare('SELECT id, driver_name FROM users WHERE username = ?').get(username)
    if (acct) noteCreated('users', acct.id)
    if (dAdd.status !== 200 || !dirRow || uAdd.status !== 200 || !acct) {
      throw new Error(`could not create the throwaway driver: directory POST → ${dAdd.status}, users POST → ${uAdd.status} ${String(uAdd.json?.error || '').slice(0, 120)}`)
    }
    meta.ids.n1User = acct.id
    // Job Tracking must hold no row for it: the route refuses a rename otherwise.
    const sheet = await page.evaluate(async (names) => {
      const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
      const res = await fetch('/api/data?sheet=Job%20Tracking', { credentials: 'same-origin', cache: 'no-store' })
      const j = await res.json().catch(() => null)
      const col = (j?.headers || []).find((h) => /^driver$/i.test(String(h || '').trim())) || (j?.headers || []).find((h) => /driver/i.test(String(h || '')))
      return { status: res.status, rows: (j?.data || []).length, mine: (j?.data || []).filter((r) => names.includes(norm(r?.[col]))).length }
    }, [OLD, NEW, VARIANT].map(normName))
    if (sheet.status !== 200) throw new Error(`Job Tracking could not be read to confirm it holds no row for the driver (${sheet.status})`)
    if (sheet.mine) throw new Error(`Job Tracking holds ${sheet.mine} row(s) for the throwaway driver`)
    // Plant rows under the variant (ids recorded; deleted at the end).
    const nowIso = new Date().toISOString()
    planted.expenses = db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date) VALUES (?, ?, 'QA-TEST-N1', 'Other', 0.01, ?, ?)")
      .run(nowIso, VARIANT, base, dayCT()).lastInsertRowid
    noteCreated('expenses', planted.expenses)
    const tId = db.prepare('SELECT MIN(id) AS id FROM trucks').get().id
    planted.truck_assignments = db.prepare('INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, ?)')
      .run(tId, VARIANT, nowIso, nowIso).lastInsertRowid
    noteCreated('truck_assignments', planted.truck_assignments)
    // This week's Saturday to Friday: both months open, nothing paid, so the rename's
    // month-end check has nothing to refuse.
    const sat = new Date(`${dayCT()}T12:00:00Z`)
    sat.setUTCDate(sat.getUTCDate() - ((sat.getUTCDay() + 1) % 7))
    const fri = new Date(sat.getTime() + 6 * 86400000)
    planted.invoices = db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, status) VALUES (?, ?, ?, ?, 'Draft')")
      .run(base, VARIANT.toLowerCase(), sat.toISOString().slice(0, 10), fri.toISOString().slice(0, 10)).lastInsertRowid
    noteCreated('invoices', planted.invoices)
    meta.ids.n1Rows = Object.entries(planted).map(([t, i]) => `${t}#${i}`).join('/')
    // The rename, through the Users page.
    await page.goto(`${BASE_URL}/users`)
    await page.locator('table.user-table').waitFor({ state: 'visible', timeout: 30000 })
    const sizes = page.locator('select.page-size-select')
    if (await sizes.count()) {
      const opts = await sizes.first().locator('option').evaluateAll((os) => os.map((o) => Number(o.value)).filter(Number.isFinite))
      if (opts.length) await sizes.first().selectOption(String(Math.max(...opts)))
    }
    const row = page.locator('table.user-table tbody tr', { has: page.locator('td.mono', { hasText: exactText(username) }) }).first()
    for (let i = 0; i < 20 && !(await row.isVisible()); i++) {
      const next = page.locator('button', { hasText: '›' }).first()
      if (!(await next.count()) || await next.isDisabled()) break
      await next.click()
      await page.waitForTimeout(200)
    }
    await row.scrollIntoViewIfNeeded()
    await row.locator('button.btn-edit').click()
    const modal = page.locator('.confirm-dialog.edit-dialog')
    await modal.waitFor({ state: 'visible', timeout: 15000 })
    await field(modal, 'Linked Driver').selectOption(NEW)
    await caption(page, `Step N1 — the throwaway driver (user #${acct.id}): Linked Driver set to its directory spelling; rows planted under the old name with its space doubled (${meta.ids.n1Rows})`)
    const [resp] = await Promise.all([
      page.waitForResponse((r) => pathOf(r.url()) === `/api/users/${acct.id}` && r.request().method() === 'PUT', { timeout: 60000 }),
      modal.locator('.confirm-actions button.btn-primary').click(),
    ])
    let rb = null
    try { rb = await resp.json() } catch { /* not json */ }
    await page.waitForTimeout(800)
    const now = {
      account: db.prepare('SELECT driver_name FROM users WHERE id = ?').get(acct.id)?.driver_name,
      expenses: db.prepare('SELECT driver FROM expenses WHERE id = ?').get(planted.expenses)?.driver,
      truck_assignments: db.prepare('SELECT driver_name FROM truck_assignments WHERE id = ?').get(planted.truck_assignments)?.driver_name,
      invoices: db.prepare('SELECT driver FROM invoices WHERE id = ?').get(planted.invoices)?.driver,
    }
    const want = { expenses: NEW, truck_assignments: NEW, invoices: NEW.toLowerCase() }
    const moved = Object.keys(want).filter((k) => now[k] === want[k])
    const left = Object.keys(want).filter((k) => now[k] !== want[k])
    if (resp.status() !== 200) {
      v = resp.status() === 409 ? 'INFO' : 'FAIL'
      observed = `PUT /api/users/${acct.id} → ${resp.status()} ${rb?.code || ''}: ${String(rb?.error || '').slice(0, 300)}`
    } else {
      v = verdict(!left.length)
      observed = `sheet check: ${sheet.rows} Job Tracking rows, 0 for this driver; the save → 200; the account now carries the new name: ${now.account === NEW}; ` +
        `moved to the new name: ${moved.join(', ') || 'none'}; LEFT under the variant: ${left.map((k) => `${k} (${now[k] === VARIANT || now[k] === VARIANT.toLowerCase() ? 'still the variant' : 'another value'})`).join(', ') || 'none'}`
    }
    await row.scrollIntoViewIfNeeded().catch(() => {}) // the renamed account's row, after the list reloads
    await caption(page, `Step N1 — ${v}: ${observed}`)
    s = await shot(page, 'n1-users-rename')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'n1-error')
  } finally {
    try { mpNotes.push(...removeCreated().map((n) => `N1 ${n}`)) } catch (e) { mpNotes.push(`N1 clean-up error: ${e.message}`) }
    // Nothing else may keep the throwaway names (e.g. rows the app wrote for them).
    const left = ['drivers_directory:driver_name', 'expenses:driver', 'truck_assignments:driver_name', 'invoices:driver', 'users:driver_name', 'users:username']
      .map((tc) => { const [t, c] = tc.split(':'); return [tc, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE LOWER(${c}) LIKE ?`).get(`${base.toLowerCase()}%`).n] })
      .filter(([, n]) => n)
    mpNotes.push(left.length ? `N1 LEFT BEHIND: ${left.map(([tc, n]) => `${tc}=${n}`).join(', ')}` : 'N1 no throwaway row left')
  }
  record({ step: 'N1', title, expected, observed, verdict: v, shot: s })
}

// ---- N1b: re-spelling an account onto its OWN directory row's spacing is a rename, not
// a merge. Local, planted. The Users page offers the directory's names trimmed at the
// edges only, so a directory row stored with its internal space doubled is offered as
// stored. The throwaway account "QA-TEST-N1B-<stamp> Driver" is created beside a
// directory row planted as the same name with its space doubled (the app adds no second
// directory row for a name that differs only in spacing), with one expense planted
// under each spelling (this month, so no month-end lock applies). Linking the account
// to the directory spelling must save, not answer 409 DRIVER_RENAME_IS_MERGE: that
// directory row, and the expense under its spelling, are the driver's own rows.
async function renameOntoOwnDirectorySpelling(page) {
  const title = 'Users page → Edit a throwaway Driver account → Linked Driver = its OWN directory row, stored with the space doubled (planted) → Save, with an expense planted under each spelling'
  const expected = 'Saved (not 409 DRIVER_RENAME_IS_MERGE): the account carries the directory spelling; that directory row is still the only one for the name, unchanged; both expenses carry the directory spelling'
  if (!db) return record({ step: 'N1b', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  const base = `QA-TEST-N1B-${stamp}`
  const OLD = `${base} Driver`
  const DIR = spacingVariant(OLD)
  const username = base.toLowerCase()
  const dirRows = () => db.prepare('SELECT id, driver_name FROM drivers_directory WHERE LOWER(driver_name) LIKE ?').all(`${base.toLowerCase()}%`)
  const spelling = (x) => (x === DIR ? 'the directory spelling' : x === OLD ? 'the account\'s old spelling' : x == null ? '(row missing)' : 'another value')
  let observed = ''; let v = 'FAIL'; let s = ''
  const planted = {}
  try {
    const dirId = db.prepare("INSERT INTO drivers_directory (driver_name, status) VALUES (?, 'active')").run(DIR).lastInsertRowid
    noteCreated('drivers_directory', dirId)
    const uAdd = await api(page, 'POST', '/api/users', { username, password: `qa-${Math.random().toString(36).slice(2)}-${Date.now()}`, role: 'Driver', driverName: OLD })
    const acct = db.prepare('SELECT id, driver_name FROM users WHERE username = ?').get(username)
    if (acct) noteCreated('users', acct.id)
    const extra = dirRows().filter((r) => r.id !== Number(dirId))
    for (const r of extra) noteCreated('drivers_directory', r.id)
    if (uAdd.status !== 200 || !acct) throw new Error(`could not create the throwaway driver: users POST → ${uAdd.status} ${String(uAdd.json?.error || '').slice(0, 120)}`)
    if (acct.driver_name !== OLD) throw new Error('the account was not stored under the spelling it was created with')
    if (extra.length) throw new Error(`creating the account added ${extra.length} directory row(s) beside the planted one`)
    meta.ids.n1bUser = acct.id
    // Job Tracking must hold no row for it: the route refuses a rename otherwise.
    const sheet = await page.evaluate(async (names) => {
      const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
      const res = await fetch('/api/data?sheet=Job%20Tracking', { credentials: 'same-origin', cache: 'no-store' })
      const j = await res.json().catch(() => null)
      const col = (j?.headers || []).find((h) => /^driver$/i.test(String(h || '').trim())) || (j?.headers || []).find((h) => /driver/i.test(String(h || '')))
      return { status: res.status, rows: (j?.data || []).length, mine: (j?.data || []).filter((r) => names.includes(norm(r?.[col]))).length }
    }, [normName(OLD)])
    if (sheet.status !== 200) throw new Error(`Job Tracking could not be read to confirm it holds no row for the driver (${sheet.status})`)
    if (sheet.mine) throw new Error(`Job Tracking holds ${sheet.mine} row(s) for the throwaway driver`)
    const nowIso = new Date().toISOString()
    const addExpense = (name) => db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date) VALUES (?, ?, 'QA-TEST-N1B', 'Other', 0.01, ?, ?)")
      .run(nowIso, name, base, dayCT()).lastInsertRowid
    planted.expenseOld = addExpense(OLD)
    noteCreated('expenses', planted.expenseOld)
    planted.expenseDir = addExpense(DIR)
    noteCreated('expenses', planted.expenseDir)
    meta.ids.n1bRows = `drivers_directory#${dirId}/expenses#${planted.expenseOld}+${planted.expenseDir}`
    // The re-spelling, through the Users page.
    await page.goto(`${BASE_URL}/users`)
    await page.locator('table.user-table').waitFor({ state: 'visible', timeout: 30000 })
    const sizes = page.locator('select.page-size-select')
    if (await sizes.count()) {
      const opts = await sizes.first().locator('option').evaluateAll((os) => os.map((o) => Number(o.value)).filter(Number.isFinite))
      if (opts.length) await sizes.first().selectOption(String(Math.max(...opts)))
    }
    const row = page.locator('table.user-table tbody tr', { has: page.locator('td.mono', { hasText: exactText(username) }) }).first()
    for (let i = 0; i < 20 && !(await row.isVisible()); i++) {
      const next = page.locator('button', { hasText: '›' }).first()
      if (!(await next.count()) || await next.isDisabled()) break
      await next.click()
      await page.waitForTimeout(200)
    }
    await row.scrollIntoViewIfNeeded()
    await row.locator('button.btn-edit').click()
    const modal = page.locator('.confirm-dialog.edit-dialog')
    await modal.waitFor({ state: 'visible', timeout: 15000 })
    const select = field(modal, 'Linked Driver')
    const offered = await select.locator('option').evaluateAll((os, want) => os.filter((o) => o.value === want).length, DIR)
    if (offered !== 1) throw new Error(`the Linked Driver list offers the directory spelling ${offered} time(s)`)
    await select.selectOption({ value: DIR })
    await caption(page, `Step N1b — the throwaway driver (user #${acct.id}): Linked Driver set to its own directory row, whose name has the space doubled (${meta.ids.n1bRows})`)
    const [resp] = await Promise.all([
      page.waitForResponse((r) => pathOf(r.url()) === `/api/users/${acct.id}` && r.request().method() === 'PUT', { timeout: 60000 }),
      modal.locator('.confirm-actions button.btn-primary').click(),
    ])
    let rb = null
    try { rb = await resp.json() } catch { /* not json */ }
    const toast = await toastText(page, 4000)
    await page.waitForTimeout(800)
    const now = {
      account: db.prepare('SELECT driver_name FROM users WHERE id = ?').get(acct.id)?.driver_name,
      expenseOld: db.prepare('SELECT driver FROM expenses WHERE id = ?').get(planted.expenseOld)?.driver,
      expenseDir: db.prepare('SELECT driver FROM expenses WHERE id = ?').get(planted.expenseDir)?.driver,
      dir: dirRows(),
    }
    const dirOk = now.dir.length === 1 && now.dir[0].id === Number(dirId) && now.dir[0].driver_name === DIR
    const state = `the account: ${spelling(now.account)}; expense #${planted.expenseOld} (was the old spelling): ${spelling(now.expenseOld)}; expense #${planted.expenseDir} (was the directory spelling): ${spelling(now.expenseDir)}; ` +
      `directory rows for the name: ${now.dir.length}${dirOk ? ` (#${dirId}, spelling unchanged)` : ` (${now.dir.map((r) => `#${r.id} ${spelling(r.driver_name)}`).join(', ')})`}`
    if (resp.status() !== 200) {
      // The refusal this case pins is the merge; another 409 is the environment's.
      v = resp.status() === 409 && rb?.code !== 'DRIVER_RENAME_IS_MERGE' ? 'INFO' : 'FAIL'
      observed = `PUT /api/users/${acct.id} → ${resp.status()} ${rb?.code || ''}${rb?.mergeTargets ? ` (mergeTargets ${JSON.stringify(rb.mergeTargets)})` : ''}; toast "${toast.slice(0, 160)}"; ${state}`
    } else {
      v = verdict(now.account === DIR && now.expenseOld === DIR && now.expenseDir === DIR && dirOk)
      observed = `sheet check: ${sheet.rows} Job Tracking rows, 0 for this driver; the save → 200; toast "${toast.slice(0, 80)}"; ${state}`
    }
    await row.scrollIntoViewIfNeeded().catch(() => {}) // the re-spelled account's row, after the list reloads
    await caption(page, `Step N1b — ${v}: ${observed}`)
    s = await shot(page, 'n1b-users-respell-own-directory-row')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'n1b-error')
  } finally {
    try { mpNotes.push(...removeCreated().map((n) => `N1b ${n}`)) } catch (e) { mpNotes.push(`N1b clean-up error: ${e.message}`) }
    const left = ['drivers_directory:driver_name', 'expenses:driver', 'truck_assignments:driver_name', 'invoices:driver', 'users:driver_name', 'users:username']
      .map((tc) => { const [t, c] = tc.split(':'); return [tc, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE LOWER(${c}) LIKE ?`).get(`${base.toLowerCase()}%`).n] })
      .filter(([, n]) => n)
    mpNotes.push(left.length ? `N1b LEFT BEHIND: ${left.map(([tc, n]) => `${tc}=${n}`).join(', ')}` : 'N1b no throwaway row left')
  }
  record({ step: 'N1b', title, expected, observed, verdict: v, shot: s })
}

// ---- F1: an Active Loads edit writes only the changed cell. Local only: it edits a
// row of the LOCAL non-production sheet, read and restored with the service
// account (valueRenderOption FORMULA). A row with no formula cell gets one, =1+1,
// in an empty column no feature reads, and loses it again at the end.
const PROD_SHEET = '1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo'
function localSheetId() {
  let id = process.env.SPREADSHEET_ID
  let from = 'the environment'
  if (id === undefined) {
    const envFile = [path.join(paths.REPO, '.env'), path.join(paths.mainCheckout(), '.env')].find((f) => fs.existsSync(f))
    if (!envFile) throw new Error('no .env to read SPREADSHEET_ID from')
    id = paths.appRequire('dotenv').parse(fs.readFileSync(envFile)).SPREADSHEET_ID
    from = envFile
  }
  id = String(id ?? '').trim()
  if (!id) throw new Error(`SPREADSHEET_ID is unset or empty in ${from}`)
  if (id === PROD_SHEET) throw new Error(`SPREADSHEET_ID in ${from} is PRODUCTION's sheet`)
  return id
}
const colLetter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s }
// Columns a planted =1+1 must never land in: anything a feature reads. Among the
// rest, a column that reads like progress or holds a link is used only when no
// other one is empty.
const F1_NOT_HARMLESS = /load.?id|job.?id|driver|status|truck|trailer|pay|rate|amount|revenue|charge|price|cost|mile|dist|date|time|appoint|lat|lng|lon|pick|drop|deliver|dest|origin|broker|phone|e-?mail|contact|fax|mobile|cell|details|contract|owner|invoice|pod|document|output|weight|hazmat|temp|note|info|address|city|state|zip/i
const F1_LAST_RESORT = /phase|progress|link/i
async function cellOnlySaveCase(page) {
  const title = 'Active Loads → a load → Edit → change Details only → Save changes; the row read back from the sheet (valueRenderOption FORMULA)'
  const expected = 'Only the edited cell changed; every formula cell of the row is still a formula'
  if (!LOCAL) return record({ step: 'F1', title, expected, observed: 'SKIPPED — local only (it edits the local non-production sheet)', verdict: 'SKIP', shot: '' })
  let observed = ''; let v = 'FAIL'; let s = ''
  let sheets; let spreadsheetId; let range; let rowIndex; let width; let before = null; let plantedIdx = -1
  const TAB = "'Job Tracking'"
  const readRow = async () => ((await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMULA' })).data.values || [[]])[0] || []
  try {
    spreadsheetId = localSheetId()
    const { google } = paths.appRequire('googleapis')
    const auth = new google.auth.GoogleAuth({ keyFile: path.join(paths.mainCheckout(), 'service-account-key.json'), scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    sheets = google.sheets({ version: 'v4', auth })
    const dash = (await api(page, 'GET', '/api/dashboard')).json || {}
    const heads = dash.jobTrackingHeaders || []
    width = heads.length
    const idCol = heads.find((h) => /load.?id|job.?id/i.test(String(h || '')))
    const detailsIdx = heads.findIndex((h) => String(h || '').trim().toLowerCase() === 'details')
    if (!idCol || detailsIdx < 0) throw new Error('the dashboard\'s Job Tracking headers have no load id or no Details column')
    const idIdx = heads.indexOf(idCol)
    const active = (dash.activeJobs || []).filter((r) => Number(r._rowIndex) >= 2 && String(r[idCol] ?? '').trim()).slice(0, 12)
    if (!active.length) throw new Error('the dashboard lists no active load')
    const got = await sheets.spreadsheets.values.batchGet({
      spreadsheetId, valueRenderOption: 'FORMULA',
      ranges: active.map((r) => `${TAB}!A${r._rowIndex}:${colLetter(width)}${r._rowIndex}`),
    })
    const rowsF = (got.data.valueRanges || []).map((vr) => (vr.values || [[]])[0] || [])
    // Same sheet as the server? The load id cell must match the server's copy.
    const matchIdx = active.map((r, i) => String(rowsF[i]?.[idIdx] ?? '').trim() === String(r[idCol]).trim())
    if (!matchIdx.some(Boolean)) throw new Error('no candidate row\'s load id matches the server\'s copy: this sheet is not the server\'s')
    const withFormula = active.findIndex((r, i) => matchIdx[i] && rowsF[i].some((c, j) => j < width && j !== detailsIdx && typeof c === 'string' && c.startsWith('=')))
    const pick = withFormula >= 0 ? withFormula : matchIdx.indexOf(true)
    const job = active[pick]
    rowIndex = Number(job._rowIndex)
    range = `${TAB}!A${rowIndex}:${colLetter(width)}${rowIndex}`
    const loadId = String(job[idCol]).trim()
    meta.ids.f1Row = `${rowIndex} (load ${loadId})`
    before = await readRow()
    let formulas = before.map((c, j) => (j < width && typeof c === 'string' && c.startsWith('=') ? j : -1)).filter((j) => j >= 0)
    if (!formulas.length) {
      const emptyAt = (h, j) => String(h || '').trim() && !F1_NOT_HARMLESS.test(String(h)) && (before[j] === undefined || before[j] === '')
      plantedIdx = heads.findIndex((h, j) => emptyAt(h, j) && !F1_LAST_RESORT.test(String(h)))
      if (plantedIdx < 0) plantedIdx = heads.findIndex(emptyAt)
      if (plantedIdx < 0) throw new Error('the row has no formula cell and no empty column that no feature reads')
      const cell = `${TAB}!${colLetter(plantedIdx + 1)}${rowIndex}`
      sheetPlants.push({ range: cell })
      writeJournal()
      await sheets.spreadsheets.values.update({ spreadsheetId, range: cell, valueInputOption: 'USER_ENTERED', requestBody: { values: [['=1+1']] } })
      before = await readRow()
      formulas = [plantedIdx]
      // Wait (up to ~75 s) for the server's cached copy to show the computed value,
      // as a person opening the load would see it.
      const col = heads[plantedIdx]
      for (let i = 0; i < 16; i++) {
        const d = (await api(page, 'GET', '/api/dashboard')).json || {}
        const r = (d.activeJobs || []).find((x) => Number(x._rowIndex) === rowIndex)
        if (String(r?.[col] ?? '') === '2') break
        await page.waitForTimeout(5000)
      }
    }
    const formulaText = formulas.map((j) => `${String(heads[j] || '').trim() || colLetter(j + 1)} ${JSON.stringify(before[j])}`).join(', ')
    // The UI: open the load from the dashboard, Edit, change Details only, Save.
    await page.goto(`${BASE_URL}/dashboard?load=${encodeURIComponent(loadId)}`)
    const editBtn = page.locator('button[title^="Manually edit load fields"]').first()
    await editBtn.waitFor({ state: 'visible', timeout: 45000 })
    await editBtn.click()
    const box = page.locator('#edit-details')
    await box.waitFor({ state: 'visible', timeout: 15000 })
    const typed = `${(await box.inputValue()).trim()} QA-F1-${stamp}`.trim()
    await box.fill(typed)
    await caption(page, `Step F1 — load ${loadId} (sheet row ${rowIndex}): Details edited; formula cell(s): ${formulaText}${plantedIdx >= 0 ? ' (planted)' : ''}`)
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() !== 'GET' && /^\/api\/(data\/\d+|load\/)/.test(pathOf(r.url())), { timeout: 60000 }),
      page.getByRole('button', { name: 'Save changes' }).click(),
    ])
    let rb = null
    try { rb = await resp.json() } catch { /* not json */ }
    const after = await readRow()
    const n = Math.max(width, before.length, after.length)
    const changed = []
    for (let j = 0; j < n; j++) if (JSON.stringify(before[j] ?? '') !== JSON.stringify(after[j] ?? '')) changed.push(j)
    const still = formulas.filter((j) => typeof after[j] === 'string' && after[j].startsWith('='))
    const onlyDetails = changed.length === 1 && changed[0] === detailsIdx && after[detailsIdx] === typed
    if (resp.status() !== 200) {
      v = resp.status() === 409 ? 'INFO' : 'FAIL'
      observed = `the save (${resp.request().method()} ${pathOf(resp.url())}) → ${resp.status()} ${rb?.code || ''}: ${String(rb?.error || '').slice(0, 200)}`
    } else {
      v = verdict(onlyDetails && still.length === formulas.length)
      observed = `load ${loadId}, sheet row ${rowIndex}: the save → ${resp.status()} (${pathOf(resp.url())}); ${changed.length} cell(s) changed: ` +
        `${changed.map((j) => String(heads[j] || '').trim() || colLetter(j + 1)).join(', ') || 'none'}; Details as typed: ${after[detailsIdx] === typed}; ` +
        `formula cells still formulas: ${still.length} of ${formulas.length} (${formulas.map((j) => `${String(heads[j] || '').trim() || colLetter(j + 1)} now ${JSON.stringify(after[j] ?? '')}`).join(', ')})`
    }
    await page.waitForTimeout(600)
    await caption(page, `Step F1 — ${v}: ${observed}`)
    s = await shot(page, 'f1-active-loads-edit')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'f1-error')
  } finally {
    // Put every cell that differs from the first read back (formulas and numbers as
    // entered, text as raw text), and clear the planted formula.
    if (sheets && before) {
      try {
        const now = await readRow()
        const orig = before.slice()
        if (plantedIdx >= 0) orig[plantedIdx] = ''
        const raw = []; const entered = []
        for (let j = 0; j < Math.max(width, orig.length, now.length); j++) {
          if (JSON.stringify(orig[j] ?? '') === JSON.stringify(now[j] ?? '')) continue
          const val = orig[j] ?? ''
          const d = { range: `${TAB}!${colLetter(j + 1)}${rowIndex}`, values: [[val]] }
          if (typeof val === 'number' || typeof val === 'boolean' || (typeof val === 'string' && val.startsWith('='))) entered.push(d)
          else raw.push(d)
        }
        if (raw.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: raw } })
        if (entered.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: entered } })
        const back = await readRow()
        const ok = Array.from({ length: Math.max(width, orig.length, back.length) }, (_, j) => JSON.stringify(orig[j] ?? '') === JSON.stringify(back[j] ?? '')).every(Boolean)
        mpNotes.push(`F1 sheet row ${rowIndex}: ${raw.length + entered.length} cell(s) written back${plantedIdx >= 0 ? ' (incl. the planted formula cleared)' : ''} — ${ok ? 'restored' : 'RESTORE MISMATCH'}`)
        if (ok) { sheetPlants.length = 0; writeJournal() }
      } catch (e) { mpNotes.push(`F1 sheet restore error: ${e.message}`) }
    }
  }
  record({ step: 'F1', title, expected, observed, verdict: v, shot: s })
}

// ---- E2: a Fuel expense stored under a percentage-paid driver's name with its space
// doubled counts against their pay. Local, planted. The deduction has to find the
// expense by the name normalization the P&L looks a driver up by (normalizeDriverName():
// trim, lowercase, one space); a build that keys it by LOWER(driver) alone does not.
// The surface: Financials → the current month (MTD) → Driver Pay, where a percentage
// driver's Pay is max(0, month revenue − month Fuel & Maintenance) × their
// percentage. The run reads that row, plants the receipt (this month; $250, or half
// the driver's month net when that is smaller) and reads the row again. When no
// percentage-paid driver earns revenue this month, the fixed-pay driver with the most
// revenue is switched to percentage (40 %) in the copy for the step and put back
// after. The month's Fuel Spend is the control: every build counts the receipt there,
// so a Pay that does not move means the receipt was in the month and was not
// deducted. No pay figure is written out: the move is a share of the expected
// deduction (in dollars only when the percentage is the 40 % the step set and the
// receipt is the default $250).
const E2_SWITCH_PCT = 40
const E2_AMOUNT = 250
const parseMoney = (s) => { const t = String(s ?? ''); const n = Number(t.replace(/[^0-9.]/g, '')); return /-/.test(t) ? -n : n }
// "2026-09" → "September 2026" (client/src/lib/monthLabel.js). The Financials table
// names a month by the short form, "Sep 2026" (FinancialsView's monthLabel()), in each
// row's title; the row is found by either.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (mk) => `${MONTH_NAMES[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`
const monthRowSelector = (mk) => [monthName(mk), `${monthName(mk).slice(0, 3)} ${mk.slice(0, 4)}`]
  .map((label) => `table.monthly-table tbody tr[title="Open ${label} breakdown"]`).join(', ')
const prevMonthKey = (mk) => { const d = new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 2, 1)); return d.toISOString().slice(0, 7) }
const lastDayOf = (mk) => new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)).toISOString().slice(0, 10)
// Open a month's drill-down from the Monthly Performance table (closing an open one
// first), and read its Driver Pay rows and Fuel Spend as the page shows them.
async function openMonth(page, month) {
  const modal = page.locator('.modal[role="dialog"]')
  if (await modal.isVisible().catch(() => false)) {
    await modal.locator('.modal-close').click()
    await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
  }
  const row = page.locator(monthRowSelector(month)).first()
  await row.waitFor({ state: 'visible', timeout: 60000 })
  await row.scrollIntoViewIfNeeded()
  const [resp] = await Promise.all([
    page.waitForResponse((r) => pathOf(r.url()) === '/api/financials' && new URL(r.url()).searchParams.get('month') === month && r.request().method() === 'GET', { timeout: 90000 }),
    row.click(),
  ])
  let json = null
  try { json = await resp.json() } catch { /* not json */ }
  await modal.waitFor({ state: 'visible', timeout: 15000 })
  const section = modal.locator('.detail-section', { has: page.locator('.detail-title', { hasText: 'Driver Pay' }) })
  await section.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 30000 })
  const shown = await section.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => {
    const tds = [...tr.querySelectorAll('td')]
    const name = tds[0] ? [...tds[0].childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : ''
    return { name, pay: (tds[3]?.textContent || '').trim() }
  }))
  const fuelText = await modal.locator('.mini-kpi', { has: page.locator('.mini-label', { hasText: exactText('Fuel Spend') }) }).locator('.mini-value').first().innerText().catch(() => '')
  return { status: resp.status(), detail: json?.monthDetail || null, shown, fuelText: fuelText.trim(), section }
}
async function payDeductionSpacingCase(page) {
  const title = 'Financials → the current month (else the previous one, while open) → Driver Pay: a percentage-paid driver\'s Pay, before and after a Fuel expense is planted under their name with its space doubled'
  const expected = 'Their Pay drops by the planted amount × their percentage (±$1: the page shows whole dollars); the month\'s Fuel Spend rises by the planted amount (the control: the receipt counts in the month)'
  if (!db) return record({ step: 'E2', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  // The current month, and the previous one while it is not finalized (early in a
  // month, no driver may have revenue in it yet).
  const isOpen = (mk) => String(db.prepare('SELECT status FROM period_locks WHERE period = ?').get(mk)?.status || '') !== 'locked'
  const months = [dayCT().slice(0, 7), prevMonthKey(dayCT().slice(0, 7))].filter(isOpen)
  if (!months.length) return record({ step: 'E2', title, expected, observed: 'SKIPPED — this month and the last are finalized, and the step needs an open month', verdict: 'SKIP', shot: '' })
  const desc = `QA-TEST-E2-${stamp}`
  let observed = ''; let v = 'FAIL'; let s = ''
  let expenseId = null
  try {
    await page.goto(`${BASE_URL}/admin/financials`)
    // Each row resolves to the FIRST directory row (by id) for its name, as getDriverPayStructures() does.
    const byKey = new Map()
    for (const d of db.prepare('SELECT id, driver_name, pay_type, pay_percentage FROM drivers_directory ORDER BY id').all()) {
      if (!byKey.has(normName(d.driver_name))) byKey.set(normName(d.driver_name), d)
    }
    const heldBy = (sp) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE LOWER(driver_name) = LOWER(?)').get(sp).n +
      db.prepare('SELECT COUNT(*) AS n FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)').get(sp).n
    let month = ''; let first = null; let usable = []
    for (const mk of months) {
      const opened = await openMonth(page, mk)
      if (opened.status !== 200 || !opened.detail) throw new Error(`GET /api/financials?month=${mk} → ${opened.status}`)
      usable = (opened.detail.drivers || []).map((r) => ({ r, d: byKey.get(normName(r.name)) })).filter(({ r, d }) => {
        if (!d || !(r.revenue > 0)) return false
        const name = String(d.driver_name).trim()
        return /\S\s+\S/.test(name) && spacingVariant(name) !== name && !heldBy(spacingVariant(name))
      })
      if (usable.length) { month = mk; first = opened; break }
    }
    if (!month) {
      record({ step: 'E2', title, expected, observed: `SKIPPED — no driver earns revenue in ${months.join(' or ')} under a name with a space to double`, verdict: 'SKIP', shot: '' })
      return
    }
    // The receipt's date: today in the current month, else the month's last day.
    const receiptDate = month === dayCT().slice(0, 7) ? dayCT() : lastDayOf(month)
    let pick = usable.find(({ r }) => r.payType === 'percentage' && r.pay > 0)
    const switched = !pick
    if (switched) {
      pick = usable.filter(({ r }) => r.payType !== 'percentage').sort((a, b) => b.r.revenue - a.r.revenue)[0]
      if (!pick) {
        record({ step: 'E2', title, expected, observed: `SKIPPED — every driver with revenue in ${month} is paid a percentage with no pay to deduct from`, verdict: 'SKIP', shot: '' })
        return
      }
      plant('drivers_directory', 'pay_type', pick.d.id, 'percentage')
      plant('drivers_directory', 'pay_percentage', pick.d.id, E2_SWITCH_PCT)
    }
    const pct = switched ? E2_SWITCH_PCT : Math.max(0, Math.min(100, Number(pick.d.pay_percentage) || 0))
    const key = normName(pick.d.driver_name)
    const rowIn = (detail) => (detail?.drivers || []).find((r) => normName(r.name) === key) || null
    const before = switched ? await openMonth(page, month) : first
    const rowB = rowIn(before.detail)
    if (!rowB || rowB.payType !== 'percentage' || !(rowB.pay > 0)) throw new Error(`the driver's row does not show a percentage Pay above $0 (${rowB ? rowB.payType : 'no row'})`)
    let amount = E2_AMOUNT
    if (amount * pct / 100 > rowB.pay - 2) amount = Math.floor((rowB.pay * 100 / pct / 2) * 100) / 100
    if (!(amount >= 1)) {
      record({ step: 'E2', title, expected, observed: 'SKIPPED — the driver\'s pay this month is too small to show a deduction', verdict: 'SKIP', shot: '' })
      return
    }
    const dollars = switched && amount === E2_AMOUNT // the only case whose figures reveal no real pay term
    const amountText = amount === E2_AMOUNT ? `$${amount.toFixed(2)}` : 'half the driver\'s month net (amount kept in memory)'
    const expectedDrop = amount * pct / 100
    meta.ids.e2DirectoryRow = pick.d.id
    expenseId = db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, status) VALUES (?, ?, 'QA-TEST-E2', 'Fuel', ?, ?, ?, 'Pending')")
      .run(new Date().toISOString(), spacingVariant(pick.d.driver_name), amount, desc, receiptDate).lastInsertRowid
    noteCreated('expenses', expenseId)
    meta.ids.e2Expense = expenseId
    await caption(page, `Step E2 — a Fuel receipt of ${amountText} planted (#${expenseId}) for directory row #${pick.d.id} under ${variantText(pick.d.driver_name)}, dated ${receiptDate}; reopening ${monthName(month)}`)
    const after = await openMonth(page, month)
    const rowA = rowIn(after.detail)
    if (!rowA) throw new Error('the driver\'s row is gone after the plant')
    const drop = rowB.pay - rowA.pay
    const fuelRise = Number(after.detail.fuel?.spend) - Number(before.detail.fuel?.spend)
    const counted = Math.abs(fuelRise - amount) <= 1
    const uiB = before.shown.find((x) => normName(x.name) === key)
    const uiA = after.shown.find((x) => normName(x.name) === key)
    const uiAgrees = !!uiB && !!uiA && parseMoney(uiB.pay) === rowB.pay && parseMoney(uiA.pay) === rowA.pay
    const share = Math.round((drop / expectedDrop) * 100)
    v = counted ? verdict(Math.abs(drop - expectedDrop) <= 1) : 'INFO'
    observed = `${monthName(month)}${month === dayCT().slice(0, 7) ? ' (the current month)' : ' (the previous month, still open)'}, directory row #${pick.d.id}: ` +
      `${switched ? `fixed pay with revenue in the month, switched to percentage ${pct} % in the copy for this step` : 'percentage pay, as stored'}; ` +
      `a Fuel receipt of ${amountText} planted under ${variantText(pick.d.driver_name)}, dated ${receiptDate} (#${expenseId}); ` +
      `the month's Fuel Spend rose by ${amount === E2_AMOUNT ? `$${fuelRise}` : 'the planted amount'}${counted ? ' (the receipt counts in the month)' : ' — NOT by the planted amount, so the receipt is not in the month and there is nothing to judge'}; ` +
      `the driver's Pay moved by ${share} % of the expected deduction${dollars ? ` (expected −$${expectedDrop.toFixed(2)}, moved −$${drop})` : ''}${drop === 0 ? ' — the receipt was NOT deducted' : ''}; ` +
      `the page's Pay cell matches the response before and after: ${uiAgrees}`
    const idx = after.shown.findIndex((x) => normName(x.name) === key)
    if (idx >= 0) await after.section.locator('table tbody tr').nth(idx).scrollIntoViewIfNeeded().catch(() => {})
    await caption(page, `Step E2 — ${v}: ${observed}`)
    s = await shot(page, 'e2-financials-driver-pay')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'e2-error')
  } finally {
    try {
      if (expenseId) {
        const n = db.prepare('DELETE FROM expenses WHERE id = ? AND description = ?').run(expenseId, desc).changes
        forgetCreated('expenses', expenseId)
        mpNotes.push(`E2 expense #${expenseId} ${n === 1 ? 'deleted' : 'NOT FOUND to delete (LEFT BEHIND?)'}`)
      }
      mpNotes.push(...restoreAll().map((n) => `E2 ${n}`))
    } catch (e) { mpNotes.push(`E2 clean-up error: ${e.message}`) }
  }
  record({ step: 'E2', title, expected, observed, verdict: v, shot: s })
}

// ---- B1: the startup expense backfill across spacing. Local, planted BEFORE boot
// with plant-before-boot.cjs. On every boot, server.js stamps truck_unit/owner_id onto
// the expenses whose truck_unit is empty, from the truck assignment covering the
// expense's date. The planted expense carries the driver's OWN account spelling, and
// the assignment covering its date is re-spelled in the copy with the space doubled
// (plant-before-boot.cjs records only ids, in b1-plant.json); a build that matches
// the two names by case only leaves the truck blank. What the row stores says what
// the boot did with it: a unit = stamped; NULL = an older build processed it and
// found no truck; '' = no truck found by a build that writes only matched rows, or no
// boot has processed it yet (told apart by the pid file's time). The step puts the
// assignment's spelling back from the account's own name.
const B1_LOAD = 'QA-TEST-B1'
const B1_PLANT = path.join(WORK, 'b1-plant.json')
// plant-before-boot.cjs's record of what it planted: ids only.
function readB1Plant() {
  try { return JSON.parse(fs.readFileSync(B1_PLANT, 'utf8')) } catch { return null }
}
// Puts the planted assignment's spelling back from the account's own name (while it
// still holds a spacing variant of it), then deletes b1-plant.json.
function restoreB1Assignment() {
  const rec = readB1Plant()
  if (!rec) return 'no b1-plant.json (no assignment to restore)'
  const u = db.prepare('SELECT driver_name FROM users WHERE id = ?').get(rec.userId)
  const a = db.prepare('SELECT driver_name FROM truck_assignments WHERE id = ?').get(rec.assignmentId)
  let note
  if (!u || !a) note = `assignment #${rec.assignmentId} or account #${rec.userId} not found; nothing restored`
  else if (a.driver_name === u.driver_name) note = `assignment #${rec.assignmentId} already holds the account's spelling`
  else if (normName(a.driver_name) !== normName(u.driver_name)) note = `assignment #${rec.assignmentId} holds another name; left alone`
  else {
    const n = db.prepare('UPDATE truck_assignments SET driver_name = ? WHERE id = ?').run(u.driver_name, rec.assignmentId).changes
    const back = db.prepare('SELECT driver_name FROM truck_assignments WHERE id = ?').get(rec.assignmentId)?.driver_name === u.driver_name
    note = `assignment #${rec.assignmentId} ${n === 1 && back ? 'restored to the account\'s spelling' : 'NOT restored'}`
  }
  fs.unlinkSync(B1_PLANT)
  return note
}
async function bootBackfillSpacingCase(page) {
  const title = 'Expenses → All → search the expense planted before boot (the driver\'s own account spelling, dated today, truck blank; the truck assignment covering that day stores the name with its space doubled): its Truck column after the startup backfill'
  const expected = 'Stamped at boot: the Truck column shows the assignment\'s truck (#unit), and the row stores that truck\'s unit and owner'
  if (!db) return record({ step: 'B1', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  const planted = db.prepare('SELECT id, driver, truck_unit, owner_id, date, description, timestamp FROM expenses WHERE load_id = ? AND description LIKE ? ORDER BY id DESC').all(B1_LOAD, `${B1_LOAD}-%`)
  if (!planted.length) {
    return record({ step: 'B1', title, expected, observed: 'SKIPPED — not planted. B1 is planted BEFORE boot: node scripts/e2e/plant-before-boot.cjs <db>, then boot-server.sh on that DB', verdict: 'SKIP', shot: '' })
  }
  for (const r of planted) noteCreated('expenses', r.id)
  const row = planted[0]
  let observed = ''; let v = 'FAIL'; let s = ''
  try {
    meta.ids.b1Expense = row.id
    // boot-server.sh writes the pid file as it starts the server.
    const pidFile = path.join(WORK, `server-${new URL(BASE_URL).port}.pid`)
    const bootedAt = fs.existsSync(pidFile) ? fs.statSync(pidFile).mtimeMs : null
    const plantedAt = Date.parse(row.timestamp)
    const plantedLate = bootedAt != null && plantedAt >= bootedAt
    const order = bootedAt == null ? 'boot time unknown (no pid file for this port)' : plantedLate ? 'planted AFTER this server booted' : 'planted before this server booted'
    const users = db.prepare("SELECT id, driver_name FROM users WHERE role = 'Driver'").all().filter((u) => normName(u.driver_name) === normName(row.driver))
    if (users.length !== 1) throw new Error(`the planted driver resolves to ${users.length} Driver account(s)`)
    const user = users[0]
    const plantRec = readB1Plant()
    const coveringSql = `SELECT ta.id, ta.truck_id, ta.driver_name, t.unit_number, t.owner_id FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id
      WHERE substr(ta.start_date, 1, 10) <= ? AND (ta.end_date = '' OR substr(ta.end_date, 1, 10) >= ?)`
    const a = plantRec && plantRec.userId === user.id
      ? db.prepare(`${coveringSql} AND ta.id = ?`).get(row.date, row.date, plantRec.assignmentId)
      : db.prepare(`${coveringSql} ORDER BY ta.start_date DESC`).all(row.date, row.date).find((x) => normName(x.driver_name) === normName(user.driver_name)) || null
    if (!a) throw new Error(`no assignment of user #${user.id} covers ${row.date}`)
    const spelling = (row.driver === user.driver_name ? 'the account\'s own spelling' : normName(row.driver) === normName(user.driver_name) ? variantText(user.driver_name) : 'another name') +
      (a.driver_name === user.driver_name ? '; the assignment holds the same spelling (NOT the planted case)' : normName(a.driver_name) === normName(user.driver_name) ? `; the assignment holds ${variantText(user.driver_name)}` : '; the assignment holds another name')
    await page.goto(`${BASE_URL}/expenses`)
    const search = page.locator('input.filter-search[aria-label="Search expenses"]')
    await search.waitFor({ state: 'visible', timeout: 60000 })
    await caption(page, `Step B1 — Expenses → All: searching the expense planted before boot (#${row.id})`)
    const [resp] = await Promise.all([
      page.waitForResponse((r) => pathOf(r.url()) === '/api/expenses/all' && new URL(r.url()).searchParams.get('q') === row.description, { timeout: 30000 }),
      search.fill(row.description),
    ])
    let listed = null
    try { listed = ((await resp.json())?.expenses || []).find((e) => Number(e.id) === Number(row.id)) || null } catch { /* not json */ }
    const tr = page.locator('tr.expense-row', { hasText: row.description }).first()
    await tr.waitFor({ state: 'visible', timeout: 20000 })
    // textContent, not innerText: the headers are upper-cased by CSS.
    const heads = await tr.locator('xpath=ancestor::table[1]').locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim().toLowerCase()))
    const ti = heads.indexOf('truck')
    const cellText = ti >= 0 ? (await tr.locator('td').nth(ti).evaluate((td) => td.textContent)).trim() : '(no Truck column)'
    await tr.scrollIntoViewIfNeeded().catch(() => {})
    const stamped = row.truck_unit === a.unit_number && Number(row.owner_id) === Number(a.owner_id)
    v = plantedLate || bootedAt == null ? 'INFO' : verdict(stamped && cellText === `#${a.unit_number}`)
    observed = `expense #${row.id}: driver = user #${user.id}'s name as ${spelling}, dated ${row.date}, truck blank when planted; ${order}; ` +
      `the assignment covering that date: #${a.id} → truck #${a.truck_id} (unit ${a.unit_number}, owner #${a.owner_id}); ` +
      `stored after the boot: truck_unit ${JSON.stringify(row.truck_unit)}, owner_id ${JSON.stringify(row.owner_id)}` +
      `${row.truck_unit === '' ? (plantedLate || bootedAt == null ? ' — no boot has processed it (plant, then boot)' : ' — the backfill left it blank: NO truck found') : row.truck_unit == null ? ' — the backfill found NO truck' : ''}; ` +
      `the Expenses page's Truck cell: "${cellText}" (the list's truck_unit ${JSON.stringify(listed ? listed.truck_unit : '(row not listed)')})`
    await caption(page, `Step B1 — ${v}: ${observed}`)
    s = await shot(page, 'b1-expenses-truck')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'b1-error')
  } finally {
    for (const r of planted) {
      try {
        const n = db.prepare('DELETE FROM expenses WHERE id = ? AND load_id = ? AND description = ?').run(r.id, B1_LOAD, r.description).changes
        forgetCreated('expenses', r.id)
        mpNotes.push(`B1 expense #${r.id} ${n === 1 ? 'deleted' : 'NOT FOUND to delete (LEFT BEHIND?)'}`)
      } catch (e) { mpNotes.push(`B1 clean-up error: ${e.message}`) }
    }
    try { mpNotes.push(`B1 ${restoreB1Assignment()}`) } catch (e) { mpNotes.push(`B1 assignment restore error: ${e.message}`) }
  }
  record({ step: 'B1', title, expected, observed, verdict: v, shot: s })
}

// ---- RC1: a rate-con import onto a load whose Payments Table row already exists
// writes only the cells that change. POST /api/loads/from-ratecon appends the load to
// Job Tracking, then upserts the Payments Table (key " Job ID") and Job Details. The
// planted row holds two texts and a formula in columns the import does not map, and
// they must come back exactly as stored (a build that writes the whole row back as
// entered returns the texts as a number and a formula). Local only: the load is
// synthetic (QA-RC1-<timestamp>), and every sheet row the step or the import writes
// is snapshotted first (values and formats) and put back from the snapshot, then
// re-read. The route is called with the reviewed fields only: no PDF (it archives a
// rate-con to disk and mirrors it to Drive only for an attached PDF), and no addresses
// (no geocode, no Distance Matrix). Gemini (POST /api/loads/ratecon/extract) is never
// called.
const RC1_RATE = '$1,234.00'
const RC1_RATE_NUM = 1234
// Stable JSON (sorted keys), so a snapshot and its read-back compare by content.
const stableJson = (x) => JSON.stringify(x, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]])) : val))
const enteredText = (c) => {
  const u = c?.userEnteredValue
  if (!u) return 'blank'
  if ('stringValue' in u) return `the text ${u.stringValue}`
  if ('formulaValue' in u) return `the formula ${u.formulaValue}`
  if ('numberValue' in u) return `the number ${u.numberValue}`
  if ('boolValue' in u) return `the boolean ${u.boolValue}`
  return stableJson(u)
}
// The Data Manager (/data), one tab, filtered by its search box to `needle`: the
// row's cells as the page shows them, by header. A fresh page load each time, so the
// page reads the sheet again.
async function showSheetRow(page, tabTitle, needle) {
  // The page first loads its default tab; switching before that answer lands would
  // let it overwrite the tab asked for.
  const first = page.waitForResponse((r) => pathOf(r.url()) === '/api/data' && r.request().method() === 'GET', { timeout: 60000 }).catch(() => null)
  await page.goto(`${BASE_URL}/data`)
  await first
  const tabBtn = page.locator('button.nav-item', { hasText: tabTitle }).first()
  await tabBtn.waitFor({ state: 'visible', timeout: 30000 })
  const isData = (r, withSearch) => pathOf(r.url()) === '/api/data' && new URL(r.url()).searchParams.get('sheet') === tabTitle &&
    (!withSearch || new URL(r.url()).searchParams.get('search') === needle)
  await Promise.all([page.waitForResponse((r) => isData(r, false), { timeout: 30000 }), tabBtn.click()])
  const box = page.locator('.page-header input.search-input')
  await Promise.all([page.waitForResponse((r) => isData(r, true), { timeout: 30000 }), box.fill(needle)])
  const table = page.locator('.table-wrapper table')
  const tr = table.locator('tbody tr', { hasText: needle }).first()
  await tr.waitFor({ state: 'visible', timeout: 15000 })
  // textContent, not innerText: the headers are upper-cased by CSS. Keyed by the
  // trimmed header, lower-cased.
  const heads = await table.locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim().toLowerCase()))
  const cells = await tr.locator('td').evaluateAll((tds) => tds.map((td) => td.textContent.trim()))
  return Object.fromEntries(heads.map((h, j) => [h, cells[j]]))
}
async function rateconUpsertCase(page) {
  const title = 'A rate-con import (POST /api/loads/from-ratecon from the Super Admin page: the reviewed fields, no PDF) for a load whose Payments Table row already exists (planted in the local sheet); the row read back (FORMULA render and each cell\'s entered type) and shown on the Data Manager'
  const expected = 'Only the blank Payment Amount changes (filled with the rate): the text 00123 and the text =QA stay text, the formula stays the same formula'
  if (!LOCAL) return record({ step: 'RC1', title, expected, observed: 'SKIPPED — local only (it writes the local non-production sheet)', verdict: 'SKIP', shot: '' })
  if (!db) return record({ step: 'RC1', title, expected, observed: skipWhy(), verdict: 'SKIP', shot: '' })
  const loadId = `QA-RC1-${stamp}`
  let observed = ''; let v = 'FAIL'; let s = ''
  let sheets; let spreadsheetId
  const tabs = {}
  const snaps = [] // { key, tab, row, cells }: the rows as they were before the step
  let jtRow = null
  let notifMax = 0
  let idIdx = -1; let jtIdIdx = -1; let jdDetailsIdx = -1; let jdPaymentIdx = -1
  const q = (t) => `'${String(t).replace(/'/g, "''")}'`
  const rowRange = (t, r) => `${q(t.title)}!A${r}:${colLetter(t.colCount)}${r}`
  const cellsOf = async (t, r) => {
    const g = await sheets.spreadsheets.get({ spreadsheetId, ranges: [rowRange(t, r)], includeGridData: true, fields: 'sheets(data(rowData(values(userEnteredValue,userEnteredFormat))))' })
    const vals = g.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
    return Array.from({ length: t.colCount }, (_, j) => {
      const c = vals[j] || {}
      return { ...(c.userEnteredValue ? { userEnteredValue: c.userEnteredValue } : {}), ...(c.userEnteredFormat ? { userEnteredFormat: c.userEnteredFormat } : {}) }
    })
  }
  const formulaRow = async (t, r) => ((await sheets.spreadsheets.values.get({ spreadsheetId, range: rowRange(t, r), valueRenderOption: 'FORMULA' })).data.values || [[]])[0] || []
  const dataRows = async (t) => ((await sheets.spreadsheets.values.get({ spreadsheetId, range: q(t.title), valueRenderOption: 'FORMULA' })).data.values || []).length
  try {
    spreadsheetId = localSheetId() // refuses production's sheet, as F1 does
    const { google } = paths.appRequire('googleapis')
    const auth = new google.auth.GoogleAuth({ keyFile: path.join(paths.mainCheckout(), 'service-account-key.json'), scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    sheets = google.sheets({ version: 'v4', auth })
    const props = (await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))' })).data.sheets || []
    for (const [k, title] of [['jt', 'Job Tracking'], ['pt', 'Payments Table'], ['jd', 'Job Details']]) {
      const p = props.find((x) => x.properties?.title === title)?.properties
      if (!p) throw new Error(`the local sheet has no "${title}" tab`)
      const vals = (await sheets.spreadsheets.values.get({ spreadsheetId, range: q(title), valueRenderOption: 'FORMULA' })).data.values || []
      tabs[k] = { title, sheetId: p.sheetId, colCount: p.gridProperties.columnCount, rows: vals.length, headers: vals[0] || [] }
      if (vals.length + 1 > p.gridProperties.rowCount) throw new Error(`"${title}" has no empty row below its data (the step does not grow a tab)`)
    }
    jtIdIdx = tabs.jt.headers.findIndex((h) => /load.?id|job.?id/i.test(String(h || '')))
    const ph = tabs.pt.headers.map((h) => String(h ?? '').trim().toLowerCase())
    idIdx = ph.indexOf('job id')
    const amtIdx = ph.indexOf('payment amount')
    const contractIdx = ph.indexOf('contract id')
    if (jtIdIdx < 0 || idIdx < 0 || amtIdx < 0) throw new Error('Job Tracking has no load id column, or the Payments Table no " Job ID" or "Payment Amount" column')
    jdDetailsIdx = tabs.jd.headers.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'details')
    jdPaymentIdx = tabs.jd.headers.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'payment')
    // Three unmapped Payments Table columns (the route maps " Job ID", Contract ID and
    // Payment Amount): the text 00123, the text =QA and a formula.
    const free = ph.map((h, j) => j).filter((j) => ph[j] && ![idIdx, amtIdx, contractIdx].includes(j))
    const used = []
    const take = (re) => { const j = free.find((x) => re.test(ph[x]) && !used.includes(x)) ?? free.find((x) => !used.includes(x)); if (j !== undefined) used.push(j); return j }
    const textIdx = take(/invoice/)
    const eqIdx = take(/status/)
    const fIdx = take(/due|carrier/)
    if ([textIdx, eqIdx, fIdx].some((j) => j === undefined)) throw new Error('the Payments Table has fewer than three columns the import does not map')
    const P = tabs.pt.rows + 1
    const feeIdx = ph.indexOf('tender fee')
    const formula = feeIdx >= 0 && !used.includes(feeIdx) ? `=${colLetter(amtIdx + 1)}${P}-${colLetter(feeIdx + 1)}${P}` : `=${colLetter(amtIdx + 1)}${P}*1`
    const label = (j) => String(tabs.pt.headers[j] || '').trim() || colLetter(j + 1)
    // Snapshot every row the step or the import writes, BEFORE the first write: the
    // planted Payments Table row, and the next free row of Job Tracking and of Job
    // Details (where the import appends).
    for (const [key, t, r] of [['pt', tabs.pt, P], ['jt', tabs.jt, tabs.jt.rows + 1], ['jd', tabs.jd, tabs.jd.rows + 1]]) {
      const cells = await cellsOf(t, r)
      if (cells.some((c) => c.userEnteredValue)) throw new Error(`row ${r} of "${t.title}" is not empty`)
      snaps.push({ key, tab: t, row: r, cells })
      sheetPlants.push({ range: rowRange(t, r), what: `RC1 ${key === 'pt' ? 'planted Payments Table row' : 'row the import appends'} (clear it by hand if the run died)` })
    }
    writeJournal()
    meta.ids.rc1 = `${loadId} (Payments Table row ${P})`
    // Plant the Payments Table row: the key and the two texts RAW (stored as text), the formula as entered.
    const cellAt = (j) => `${q(tabs.pt.title)}!${colLetter(j + 1)}${P}`
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: [{ range: cellAt(idIdx), values: [[loadId]] }, { range: cellAt(textIdx), values: [['00123']] }, { range: cellAt(eqIdx), values: [['=QA']] }] },
    })
    await sheets.spreadsheets.values.update({ spreadsheetId, range: cellAt(fIdx), valueInputOption: 'USER_ENTERED', requestBody: { values: [[formula]] } })
    const plantedCells = await cellsOf(tabs.pt, P)
    const want = [[idIdx, 'stringValue', loadId], [textIdx, 'stringValue', '00123'], [eqIdx, 'stringValue', '=QA'], [fIdx, 'formulaValue', formula]]
    for (const [j, kind, val] of want) if (plantedCells[j]?.userEnteredValue?.[kind] !== val) throw new Error(`the planted row did not store ${label(j)} as intended`)
    if (plantedCells[amtIdx]?.userEnteredValue) throw new Error('the planted row\'s Payment Amount is not blank')
    // The server reads this sheet: its sheet reader lists the planted row.
    const seen = await api(page, 'GET', `/api/data?sheet=${encodeURIComponent(tabs.pt.title)}&search=${encodeURIComponent(loadId)}`)
    if (seen.status !== 200 || !(seen.json?.data || []).some((r) => String(r[tabs.pt.headers[idIdx]] ?? '').trim() === loadId)) {
      throw new Error(`the server does not list the planted row (GET /api/data → ${seen.status}): it does not read this sheet`)
    }
    // What the Data Manager shows for the planted cells and Payment Amount.
    const shownText = (shown) => [textIdx, eqIdx, fIdx, amtIdx].map((j) => `${label(j)} "${shown[label(j).toLowerCase()] ?? '(column not shown)'}"`).join(', ')
    const shownBefore = await showSheetRow(page, tabs.pt.title, loadId)
    await caption(page, `Step RC1 — before the import: Payments Table row ${P} for ${loadId} shows ${shownText(shownBefore)}`)
    // The import, from this signed-in page, as the review modal sends it (no PDF).
    notifMax = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM dispatch_notifications').get().m
    await caption(page, `Step RC1 — POST /api/loads/from-ratecon for ${loadId}: Rate ${RC1_RATE}, no PDF, no addresses`)
    const res = await api(page, 'POST', '/api/loads/from-ratecon', { fields: { 'Load Number': loadId, Rate: RC1_RATE, Details: 'QA-TEST RC1 synthetic load (the E2E harness deletes it)' } })
    jtRow = Number(res.json?.rowIndex) || null
    // The row read back: each cell's entered type, and the FORMULA render.
    const afterCells = await cellsOf(tabs.pt, P)
    const afterF = await formulaRow(tabs.pt, P)
    const changed = []
    for (let j = 0; j < tabs.pt.colCount; j++) {
      if (j !== amtIdx && stableJson(afterCells[j].userEnteredValue ?? null) !== stableJson(plantedCells[j].userEnteredValue ?? null)) changed.push(j)
    }
    const filled = Number(afterF[amtIdx]) === RC1_RATE_NUM
    const shownAfter = await showSheetRow(page, tabs.pt.title, loadId)
    if (res.status !== 200) {
      v = res.status === 409 ? 'INFO' : 'FAIL'
      observed = `POST /api/loads/from-ratecon → ${res.status}${res.json?.code ? ` ${res.json.code}` : ''}: ${String(res.json?.error || res.text || '').slice(0, 200)}`
    } else {
      v = verdict(!changed.length && filled)
      observed = `${loadId}: Payments Table row ${P} planted with ${label(textIdx)} = the text 00123, ${label(eqIdx)} = the text =QA, ${label(fIdx)} = the formula ${formula}, Payment Amount blank; ` +
        `the server lists it; the import → 200 (Job Tracking row ${jtRow ?? '?'}, ${(res.json?.warnings || []).length} warning(s)); read back: ` +
        `${[textIdx, eqIdx, fIdx].map((j) => `${label(j)} ${enteredText(afterCells[j])}${changed.includes(j) ? ' (CHANGED)' : ' (unchanged)'}`).join('; ')}; ` +
        `Payment Amount ${filled ? 'filled' : 'NOT filled with the number'} (${enteredText(afterCells[amtIdx])}); ` +
        `other cells changed: ${changed.filter((j) => ![textIdx, eqIdx, fIdx].includes(j)).map(label).join(', ') || 'none'}; ` +
        `the Data Manager showed ${shownText(shownBefore)} before, and shows ${shownText(shownAfter)} after`
    }
    // A short caption, so the tab's header row stays in the screenshot; the results table has the rest.
    await caption(page, `Step RC1 — ${v}: Payments Table row ${P} (${loadId}) after the import: ${shownText(shownAfter)}. Before it: ${shownText(shownBefore)}`)
    s = await shot(page, 'rc1-payments-table-row')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(page, 'rc1-error')
  } finally {
    // Put back every snapshotted row that differs, only when it holds this step's
    // load (Job Details has no load id column: the row the import appended below its
    // data, recognized by the Payment it wrote), then read it back.
    if (sheets && snaps.length) {
      let allOk = true
      for (const sn of snaps) {
        try {
          if (stableJson(await cellsOf(sn.tab, sn.row)) === stableJson(sn.cells)) { mpNotes.push(`RC1 ${sn.tab.title} row ${sn.row} unchanged`); continue }
          const f = await formulaRow(sn.tab, sn.row)
          const ours = sn.key === 'pt' ? String(f[idIdx] ?? '').trim() === loadId
            : sn.key === 'jt' ? String(f[jtIdIdx] ?? '').trim() === loadId
              : jdPaymentIdx < 0 || Number(f[jdPaymentIdx]) === RC1_RATE_NUM
          if (!ours) { allOk = false; mpNotes.push(`RC1 ${sn.tab.title} row ${sn.row} holds another row now: NOT restored (LEFT BEHIND?)`); continue }
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ updateCells: { range: { sheetId: sn.tab.sheetId, startRowIndex: sn.row - 1, endRowIndex: sn.row, startColumnIndex: 0, endColumnIndex: sn.tab.colCount }, rows: [{ values: sn.cells }], fields: 'userEnteredValue,userEnteredFormat' } }] },
          })
          const ok = stableJson(await cellsOf(sn.tab, sn.row)) === stableJson(sn.cells)
          if (!ok) allOk = false
          mpNotes.push(`RC1 ${sn.tab.title} row ${sn.row} ${ok ? 'put back (values and formats), re-read: as before' : 'RESTORE MISMATCH'}`)
        } catch (e) { allOk = false; mpNotes.push(`RC1 ${sn.tab.title} row ${sn.row} restore error: ${e.message}`) }
      }
      // A Job Tracking row the import appended where no snapshot was taken.
      if (jtRow && !snaps.some((sn) => sn.key === 'jt' && sn.row === jtRow)) {
        try {
          const t = tabs.jt
          if (String((await formulaRow(t, jtRow))[jtIdIdx] ?? '').trim() === loadId) {
            await sheets.spreadsheets.values.clear({ spreadsheetId, range: rowRange(t, jtRow) })
            mpNotes.push(`RC1 Job Tracking row ${jtRow} (outside the snapshot) cleared of values; its formats were not snapshotted`)
          }
        } catch (e) { allOk = false; mpNotes.push(`RC1 Job Tracking row ${jtRow} clear error: ${e.message}`) }
      }
      for (const t of Object.values(tabs)) {
        try {
          const n = await dataRows(t)
          if (n !== t.rows) allOk = false
          mpNotes.push(`RC1 ${t.title} data ${n === t.rows ? `ends at row ${n}, as before` : `now ends at row ${n}, was ${t.rows} (MISMATCH)`}`)
        } catch (e) { allOk = false; mpNotes.push(`RC1 ${t.title} row count error: ${e.message}`) }
      }
      if (allOk) {
        for (let i = sheetPlants.length - 1; i >= 0; i--) if (String(sheetPlants[i].what || '').startsWith('RC1')) sheetPlants.splice(i, 1)
        writeJournal()
      }
    }
    // The private-DB rows the import wrote. Its create_load_ratecon audit line stays,
    // as the harness's other audit lines do.
    try {
      const nNotif = db.prepare("DELETE FROM dispatch_notifications WHERE id > ? AND type = 'new-load' AND title = ?").run(notifMax, `New Load ${loadId}`).changes
      const nDocs = db.prepare('DELETE FROM documents WHERE load_id = ?').run(loadId).changes
      const nCoords = db.prepare('DELETE FROM load_coordinates WHERE load_id = ? OR load_id = ?').run(loadId, loadId.toLowerCase()).changes
      const nAudit = db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'create_load_ratecon' AND entity_id = ?").get(loadId).n
      mpNotes.push(`RC1 DB: ${nNotif} dispatch notification(s) deleted, ${nDocs} document row(s), ${nCoords} load_coordinates row(s); ${nAudit} create_load_ratecon audit line(s) kept`)
    } catch (e) { mpNotes.push(`RC1 DB clean-up error: ${e.message}`) }
  }
  record({ step: 'RC1', title, expected, observed, verdict: v, shot: s })
}

// ================================================================ names section (K1, K2, K3)
// ONLY=names, local only (it writes the local non-production sheet, like F1 and
// RC1, and restores every row it touches from a snapshot taken first). Every
// "Expected" column is the behaviour AFTER the fix; a BEFORE run fails the fix rows.
//   K1 a driver name that reads as a built-in property name, dispatched to a real
//      load, is refused 400 DRIVER_NAME_RESERVED and nothing is written.
//   K2 the same name stored on a completed load in the current open month leaves
//      GET /api/dashboard and GET /api/financials answering 200, with an unrelated
//      driver's figure and the fleet revenue unchanged (the load counts unassigned).
//   K3 for a non-Super-Admin, saving a changed cell the sheet would store as a
//      formula is refused 400 FORMULA_NOT_ALLOWED; a plain signed number is kept.
// The name under test is test data; real driver names are never printed (rows are
// named by id, drivers by role). The screenshots show the real pages, as the rest
// of this harness does, and live only in the work dir.
const NAMES_KEY = '__proto__' // reads as a built-in property name; test data only
const namesNotes = []
// A loose month bucket for choosing candidate rows (not the server's own parser):
// enough to prefer a load dated in the current Central month.
const jtMonthKey = (s) => {
  if (!s) return ''
  const iso = String(s).match(/(\d{4})-(\d{2})-\d{2}/)
  if (iso) return `${iso[1]}-${iso[2]}`
  const d = new Date(String(s).replace(/^Date:\s*/i, ''))
  return isNaN(d) ? '' : dayCT(d).slice(0, 7)
}
// The local Job Tracking sheet, opened with the service account (formulas as
// formulas), exactly as F1 and RC1 do. Refuses production's sheet.
async function openNamesSheet() {
  const spreadsheetId = localSheetId()
  const { google } = paths.appRequire('googleapis')
  const auth = new google.auth.GoogleAuth({ keyFile: path.join(paths.mainCheckout(), 'service-account-key.json'), scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  const sheets = google.sheets({ version: 'v4', auth })
  const props = (await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))' })).data.sheets || []
  const jt = props.find((p) => p.properties?.title === 'Job Tracking')?.properties
  if (!jt) throw new Error('the local sheet has no "Job Tracking" tab')
  const S = { sheets, spreadsheetId, sheetId: jt.sheetId, colCount: jt.gridProperties.columnCount }
  const values = (await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Job Tracking'", valueRenderOption: 'FORMATTED_VALUE' })).data.values || []
  S.headers = values[0] || []
  S.rows = values.slice(1)
  return S
}
const jtRange = (S, r) => `'Job Tracking'!A${r}:${colLetter(S.colCount)}${r}`
// A whole-row snapshot (values and formats), and its restore — the RC1 pattern,
// so a row put back is byte-identical to how it was read.
async function jtSnapshotRow(S, r) {
  const g = await S.sheets.spreadsheets.get({ spreadsheetId: S.spreadsheetId, ranges: [jtRange(S, r)], includeGridData: true, fields: 'sheets(data(rowData(values(userEnteredValue,userEnteredFormat))))' })
  const vals = g.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
  return Array.from({ length: S.colCount }, (_, j) => { const c = vals[j] || {}; return { ...(c.userEnteredValue ? { userEnteredValue: c.userEnteredValue } : {}), ...(c.userEnteredFormat ? { userEnteredFormat: c.userEnteredFormat } : {}) } })
}
async function jtRestoreRow(S, r, cells) {
  await S.sheets.spreadsheets.batchUpdate({ spreadsheetId: S.spreadsheetId, requestBody: { requests: [{ updateCells: { range: { sheetId: S.sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: 0, endColumnIndex: S.colCount }, rows: [{ values: cells }], fields: 'userEnteredValue,userEnteredFormat' } }] } })
}
const jtFormulaRow = async (S, r) => ((await S.sheets.spreadsheets.values.get({ spreadsheetId: S.spreadsheetId, range: jtRange(S, r), valueRenderOption: 'FORMULA' })).data.values || [[]])[0] || []
const jtFormattedRow = async (S, r) => ((await S.sheets.spreadsheets.values.get({ spreadsheetId: S.spreadsheetId, range: jtRange(S, r), valueRenderOption: 'FORMATTED_VALUE' })).data.values || [[]])[0] || []
// The kind of value a cell holds as it was entered: 'formulaValue' (the sheet
// stored it as a formula, e.g. "+1+1" or "+7"), 'numberValue', 'stringValue',
// 'boolValue', or 'blank'. USER_ENTERED turns any "+...": or "=..." into a formula.
const uevKind = (cell) => { const u = cell && cell.userEnteredValue; return u ? (Object.keys(u)[0] || 'blank') : 'blank' }
const uevJson = (cell) => stableJson((cell && cell.userEnteredValue) ?? null)
// Clear a step's own live sheet-plant markers from the journal once its row is
// verified back (mirrors RC1's own clean-up).
function clearNamesPlants(prefix) {
  for (let i = sheetPlants.length - 1; i >= 0; i--) if (String(sheetPlants[i].what || '').startsWith(prefix)) sheetPlants.splice(i, 1)
  writeJournal()
}

// ---- K1: dispatch to a reserved driver name is refused; nothing is written.
async function reservedDispatchCase(dp, S, cols, active) {
  const title = 'Dispatcher dispatches a real load to a reserved driver name (POST /api/dispatch, the same call the Job Board Assign makes; its dropdown only offers real drivers)'
  const expected = '400 DRIVER_NAME_RESERVED (field "driver"); the refusal is shown on the page; the load\'s Driver cell is unchanged (nothing written)'
  if (!active.length) return record({ step: 'K1', title, expected, observed: 'SKIPPED — the local sheet has no non-completed, unique-id load to dispatch', verdict: 'SKIP', shot: '' })
  const load = active[0]
  let observed = ''; let v = 'FAIL'; let s = ''
  let snap = null; let notifMax = 0; let dispMax = 0
  try {
    meta.ids.k1 = `${load.lid} (Job Tracking row ${load.rowIndex})`
    snap = await jtSnapshotRow(S, load.rowIndex)
    sheetPlants.push({ range: jtRange(S, load.rowIndex), what: 'K1 dispatch target (restore this row by hand if the run died)' }); writeJournal()
    if (db) {
      try { notifMax = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM notifications').get().m } catch { /* table shape may differ */ }
      try { dispMax = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM dispatch_notifications').get().m } catch { /* ignore */ }
    }
    await dp.goto(`${BASE_URL}/dashboard`)
    await dp.locator(KPI).first().waitFor({ state: 'visible', timeout: 45000 }).catch(() => {})
    await caption(dp, `Step K1 — dispatching load ${load.lid} (row ${load.rowIndex}) to the reserved name ${JSON.stringify(NAMES_KEY)} (page fetch, as the app posts)`)
    const res = await api(dp, 'POST', '/api/dispatch', { rowIndex: load.rowIndex, driver: NAMES_KEY, loadId: load.lid, origin: '', destination: '' })
    const after = await jtFormulaRow(S, load.rowIndex)
    const drvAfter = String(after[cols.driver] ?? '')
    const stAfter = cols.status >= 0 ? String(after[cols.status] ?? '') : ''
    const unchanged = drvAfter === load.drv && (cols.status < 0 || stAfter === load.st)
    const code = res.json?.code || ''
    const field = res.json?.field || ''
    if (res.status === 400 && code === 'DRIVER_NAME_RESERVED') {
      v = verdict(unchanged && field === 'driver')
      observed = `POST /api/dispatch -> 400 ${code} (field ${JSON.stringify(field)}); the load's Driver cell is ${unchanged ? 'unchanged' : 'CHANGED'} (stored driver kept, status ${JSON.stringify(stAfter)})`
    } else if (res.status === 200) {
      v = 'FAIL'
      observed = `POST /api/dispatch -> 200 (accepted): the Driver cell was written to ${JSON.stringify(drvAfter)} (status ${JSON.stringify(stAfter)}) — the reserved name was NOT refused. Restored below.`
    } else {
      v = 'INFO'
      observed = `POST /api/dispatch -> ${res.status}${code ? ` ${code}` : ''}: ${String(res.json?.error || res.text || '').slice(0, 200)}`
    }
    await caption(dp, `Step K1 — ${v}: ${observed}`)
    s = await shot(dp, 'k1-dispatch-reserved-name')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(dp, 'k1-error')
  } finally {
    if (snap) {
      try {
        await jtRestoreRow(S, load.rowIndex, snap)
        const back = await jtSnapshotRow(S, load.rowIndex)
        const ok = stableJson(back) === stableJson(snap)
        namesNotes.push(`K1 Job Tracking row ${load.rowIndex} ${ok ? 'restored, re-read: as before' : 'RESTORE MISMATCH'}`)
        if (ok) clearNamesPlants('K1')
      } catch (e) { namesNotes.push(`K1 restore error: ${e.message}`) }
    }
    if (db) {
      try {
        const n1 = db.prepare('DELETE FROM notifications WHERE id > ? AND LOWER(driver_name) = LOWER(?)').run(notifMax, NAMES_KEY).changes
        const n2 = db.prepare('DELETE FROM dispatch_notifications WHERE id > ?').run(dispMax).changes
        if (n1 || n2) namesNotes.push(`K1 DB: ${n1} notification(s), ${n2} dispatch notification(s) deleted (throwaway copy)`)
      } catch (e) { namesNotes.push(`K1 DB clean-up error: ${e.message}`) }
    }
  }
  record({ step: 'K1', title, expected, observed, verdict: v, shot: s })
}

// ---- K2: a reserved name stored on a completed load keeps the totals working.
async function reservedTotalsCase(sp, S, cols, completedThisMonth) {
  const title = 'A reserved driver name is planted on a completed load in the current open month; the Super Admin opens the Dashboard and Financials'
  const expected = 'Dashboard and Financials both 200; an unrelated driver\'s figure and the fleet revenue match the baseline read taken before planting (the planted load counts as unassigned)'
  if (!completedThisMonth.length) return record({ step: 'K2', title, expected, observed: 'SKIPPED — no completed load with a payment dated in the current month', verdict: 'SKIP', shot: '' })
  const load = completedThisMonth[0]
  let observed = ''; let v = 'FAIL'; let s = ''
  let snap = null; let planted = false
  try {
    meta.ids.k2 = `${load.lid} (Job Tracking row ${load.rowIndex})`
    const baseFinRes = await api(sp, 'GET', '/api/financials')
    const baseDashRes = await api(sp, 'GET', '/api/dashboard')
    if (baseFinRes.status !== 200) throw new Error(`baseline GET /api/financials -> ${baseFinRes.status}`)
    const baseFin = baseFinRes.json || {}
    const baseBoard = baseFin.drivers || []
    const perturbedKey = normName(load.drv)
    const other = baseBoard.find((d) => !d.isUnassigned && normName(d.name) !== perturbedKey && Number(d.grossRevenue) > 0)
    if (!other) throw new Error('the Financials leaderboard has no second driver to compare against')
    const otherKey = normName(other.name)
    const baseTotalRevenue = Number(baseFin.summary?.totalRevenue)
    const baseUnassigned = Number(baseFin.summary?.unassignedRevenue)
    const perturbedEntry = baseBoard.find((d) => !d.isUnassigned && normName(d.name) === perturbedKey) || {}
    const basePerturbedGross = Number(perturbedEntry.grossRevenue)
    const baseOtherGross = Number(other.grossRevenue)
    const baseOtherPay = Number(other.totalEarnings)
    await caption(sp, `Step K2 — baseline read (dashboard ${baseDashRes.status}, financials 200); planting ${JSON.stringify(NAMES_KEY)} on completed load ${load.lid} (row ${load.rowIndex})`)
    snap = await jtSnapshotRow(S, load.rowIndex)
    sheetPlants.push({ range: jtRange(S, load.rowIndex), what: 'K2 planted Driver cell (restore this row by hand if the run died)' }); writeJournal()
    const drvCells = snap.map((c, j) => (j === cols.driver ? { ...(c.userEnteredFormat ? { userEnteredFormat: c.userEnteredFormat } : {}), userEnteredValue: { stringValue: NAMES_KEY } } : c))
    await jtRestoreRow(S, load.rowIndex, drvCells)
    planted = true
    const check = await jtFormulaRow(S, load.rowIndex)
    if (String(check[cols.driver] ?? '') !== NAMES_KEY) throw new Error('the planted Driver cell did not store the reserved name')
    // Wait for the server's 60 s Job Tracking cache to pick the row up (F1's pattern):
    // refreshed when Financials errors (the corruption) or the figures move.
    let refreshed = false; let lastFin = null; let waited = 0
    for (let i = 0; i < 24; i++) {
      lastFin = await api(sp, 'GET', '/api/financials')
      if (lastFin.status !== 200) { refreshed = true; break }
      const j = lastFin.json || {}
      const board = j.drivers || []
      const curPerturbed = Number((board.find((d) => !d.isUnassigned && normName(d.name) === perturbedKey) || {}).grossRevenue)
      const curUnassigned = Number(j.summary?.unassignedRevenue)
      if (curUnassigned !== baseUnassigned || curPerturbed !== basePerturbedGross) { refreshed = true; break }
      await sp.waitForTimeout(5000); waited += 5
    }
    const dash2 = await api(sp, 'GET', '/api/dashboard')
    const fin2 = lastFin && lastFin.status ? lastFin : await api(sp, 'GET', '/api/financials')
    const j2 = fin2.status === 200 ? (fin2.json || {}) : {}
    const board2 = j2.drivers || []
    const other2 = board2.find((d) => !d.isUnassigned && normName(d.name) === otherKey) || null
    const otherHeld = !!other2 && Number(other2.grossRevenue) === baseOtherGross && Number(other2.totalEarnings) === baseOtherPay
    const revHeld = Number(j2.summary?.totalRevenue) === baseTotalRevenue
    const movedToUnassigned = fin2.status === 200 && Number(j2.summary?.unassignedRevenue) > baseUnassigned
    if (!refreshed) {
      v = 'INFO'
      observed = `the server's 60 s Job Tracking cache did not pick up the planted row within ${waited}s (dashboard ${dash2.status}, financials ${fin2.status}) — nothing to judge`
    } else {
      v = verdict(dash2.status === 200 && fin2.status === 200 && otherHeld && revHeld)
      observed = `planted ${JSON.stringify(NAMES_KEY)} on completed load ${load.lid} (row ${load.rowIndex}); after the cache refreshed (~${waited}s): ` +
        `GET /api/dashboard -> ${dash2.status}, GET /api/financials -> ${fin2.status}${fin2.status !== 200 ? ` ${fin2.json?.code || ''} ${String(fin2.json?.error || '').slice(0, 120)}`.trimEnd() : ''}; ` +
        `an unrelated driver's figure ${otherHeld ? 'matches the baseline' : (other2 ? 'CHANGED' : 'could not be read')}; fleet totalRevenue ${revHeld ? 'unchanged' : 'CHANGED / unreadable'}; ` +
        `the planted load ${movedToUnassigned ? 'moved into the unassigned bucket (its revenue still counted)' : (fin2.status === 200 ? 'did not move to unassigned' : 'could not be read: Financials errored (totals corrupted process-wide)')}`
    }
    await caption(sp, `Step K2 — ${v}: dashboard ${dash2.status}, financials ${fin2.status}`)
    try {
      await sp.goto(`${BASE_URL}/admin/financials`)
      await sp.locator('table.monthly-table, .kpi-value, .toast-container .toast').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    } catch { /* best effort */ }
    await caption(sp, `Step K2 — ${v}: ${observed}`)
    s = await shot(sp, 'k2-financials-after-plant', { fullPage: true })
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(sp, 'k2-error')
  } finally {
    if (planted && snap) {
      try {
        await jtRestoreRow(S, load.rowIndex, snap)
        const back = await jtSnapshotRow(S, load.rowIndex)
        const ok = stableJson(back) === stableJson(snap)
        namesNotes.push(`K2 Job Tracking row ${load.rowIndex} Driver cell ${ok ? 'restored, re-read: as before' : 'RESTORE MISMATCH'}`)
        if (ok) clearNamesPlants('K2')
      } catch (e) { namesNotes.push(`K2 restore error: ${e.message}`) }
    }
  }
  record({ step: 'K2', title, expected, observed, verdict: v, shot: s })
}

// ---- K3: a changed cell the sheet would store as a formula is refused for a
// non-Super-Admin; a plain signed number is kept. The edited column is a harmless
// non-driver, non-broker one (Trailer Number), and the row is restored from a snapshot.
async function formulaCellSaveCase(dp, S, cols, active) {
  const col = cols.trailer >= 0 ? String(S.headers[cols.trailer] || 'Trailer Number') : ''
  const title = `Dispatcher edits a load (Active Loads -> Edit) and saves ${col ? `the "${col}" cell` : 'a harmless cell'} as "+1+1" (a computing formula), then as "+7" (a plain signed number)`
  const expected = '"+1+1" -> 400 FORMULA_NOT_ALLOWED shown, nothing written (the cell keeps its stored value); "+7" -> 200 accepted (the sheet shows 7)'
  if (cols.trailer < 0) return record({ step: 'K3', title, expected, observed: 'SKIPPED — the sheet has no Trailer Number column to edit', verdict: 'SKIP', shot: '' })
  const load = active.length > 1 ? active[1] : active[0]
  if (!load) return record({ step: 'K3', title, expected, observed: 'SKIPPED — the local sheet has no active load to open in Active Loads', verdict: 'SKIP', shot: '' })
  let observed = ''; let v = 'FAIL'; let s = ''
  let snap = null
  const fieldId = 'edit-' + col.trim().replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
  const openEdit = async () => {
    await dp.goto(`${BASE_URL}/dashboard?load=${encodeURIComponent(load.lid)}`)
    const editBtn = dp.locator('button[title^="Manually edit load fields"]').first()
    await editBtn.waitFor({ state: 'visible', timeout: 45000 })
    await editBtn.click()
    const box = dp.locator(`#${fieldId}`)
    await box.waitFor({ state: 'visible', timeout: 15000 })
    return box
  }
  // A 409 ROW_READ_FAILED is a transient Sheets read failure (the row could not be
  // read), NOT the fix's refusal; the modal stays open, so retry it a couple of times.
  const saveAndCapture = async () => {
    for (let attempt = 0; ; attempt++) {
      const [resp] = await Promise.all([
        dp.waitForResponse((r) => r.request().method() === 'PUT' && /^\/api\/data\/\d+/.test(pathOf(r.url())), { timeout: 60000 }),
        dp.getByRole('button', { name: 'Save changes' }).click(),
      ])
      let body = null; try { body = await resp.json() } catch { /* not json */ }
      const out = { status: resp.status(), code: body?.code || '', error: String(body?.error || '').slice(0, 200) }
      if (out.code !== 'ROW_READ_FAILED' || attempt >= 2) return out
      await dp.waitForTimeout(4000)
    }
  }
  try {
    meta.ids.k3 = `${load.lid} (Job Tracking row ${load.rowIndex})`
    snap = await jtSnapshotRow(S, load.rowIndex)
    sheetPlants.push({ range: jtRange(S, load.rowIndex), what: 'K3 edit target (restore this row by hand if the run died)' }); writeJournal()
    const origUevJson = uevJson(snap[cols.trailer])
    // Sub-step A: "+1+1" — the sheet stores a leading "+" or "=" as a formula (here
    // one that computes 2). The fix refuses it for a non-Super-Admin.
    let box = await openEdit()
    await box.fill('+1+1')
    await caption(dp, `Step K3 — load ${load.lid}, ${col} set to "+1+1"; Save changes (expect a refusal)`)
    const a = await saveAndCapture()
    await dp.waitForTimeout(500)
    const errShown = await dp.locator('[role="dialog"]').getByText(/formula|not allowed|remove the leading/i).first().isVisible().catch(() => false)
    const cellA = (await jtSnapshotRow(S, load.rowIndex))[cols.trailer]
    const dispA = String((await jtFormattedRow(S, load.rowIndex))[cols.trailer] ?? '')
    const unchangedA = uevJson(cellA) === origUevJson
    const kindA = uevKind(cellA)
    const refusedA = a.status === 400 && a.code === 'FORMULA_NOT_ALLOWED'
    s = await shot(dp, 'k3-formula-cell-refused')
    // Sub-step B: "+7" — a plain signed number the fix keeps (the sheet shows 7).
    box = await openEdit()
    await box.fill('+7')
    await caption(dp, `Step K3 — load ${load.lid}, ${col} set to "+7"; Save changes (expect it accepted)`)
    const b = await saveAndCapture()
    await dp.waitForTimeout(500)
    const dispB = String((await jtFormattedRow(S, load.rowIndex))[cols.trailer] ?? '')
    const kindB = uevKind((await jtSnapshotRow(S, load.rowIndex))[cols.trailer])
    const bAccepted = b.status === 200
    v = verdict(refusedA && unchangedA && bAccepted)
    observed = `${col} = "+1+1" -> ${a.status}${a.code ? ` ${a.code}` : ''}${a.status === 200 ? ' (SAVED)' : ''}; the cell ${unchangedA ? 'kept its stored value (nothing written)' : `is now a ${kindA} showing ${JSON.stringify(dispA)} (the sheet stored the formula)`}; the page ${errShown ? 'shows the refusal' : 'shows no refusal'}. ` +
      `Then "+7" -> ${b.status}${b.code ? ` ${b.code}` : ''}${bAccepted ? ' (accepted)' : ''}; the sheet shows ${JSON.stringify(dispB)} (stored as ${kindB})`
    await caption(dp, `Step K3 — ${v}: ${observed}`)
    s = await shot(dp, 'k3-formula-cell-save')
  } catch (e) {
    observed = `error: ${e.message}`
    s = await shot(dp, 'k3-error')
  } finally {
    if (snap) {
      try {
        await jtRestoreRow(S, load.rowIndex, snap)
        const back = await jtSnapshotRow(S, load.rowIndex)
        const ok = stableJson(back) === stableJson(snap)
        namesNotes.push(`K3 Job Tracking row ${load.rowIndex} ${ok ? 'restored, re-read: as before' : 'RESTORE MISMATCH'}`)
        if (ok) clearNamesPlants('K3')
      } catch (e) { namesNotes.push(`K3 restore error: ${e.message}`) }
    }
  }
  record({ step: 'K3', title, expected, observed, verdict: v, shot: s })
}

async function namesSection() {
  if (!LOCAL) {
    for (const [step, t] of [['K1', 'reserved name refused at dispatch'], ['K2', 'reserved name on a completed load keeps totals working'], ['K3', 'a formula-looking cell is refused for a non-Super-Admin']]) {
      record({ step, title: t, expected: '—', observed: 'SKIPPED — local only (it writes the local non-production sheet)', verdict: 'SKIP', shot: '' })
    }
    return
  }
  const ownDb = !db
  if (!db) db = openDb()
  const dispCtx = await freshPage(ADMIN_VP)
  const saCtx = await freshPage(ADMIN_VP)
  try {
    const S = await openNamesSheet()
    const idx = (re) => S.headers.findIndex((h) => re.test(String(h ?? '')))
    const idxExact = (re, loose) => { const i = S.headers.findIndex((h) => re.test(String(h ?? ''))); return i >= 0 ? i : idx(loose) }
    const cols = {
      id: idx(/load.?id|job.?id/i),
      driver: idxExact(/^\s*driver\s*$/i, /driver/i),
      status: idxExact(/^\s*(job[\s._-]?)?status\s*$/i, /status/i),
      date: idxExact(/status.*update.*date|completion.*date|assigned.*date/i, /date/i),
      pay: S.headers.findIndex((h) => /^\s*payment\s*$/i.test(String(h ?? ''))),
      trailer: idx(/trailer/i),
    }
    if (cols.id < 0 || cols.driver < 0) throw new Error('the local Job Tracking has no load id or driver column')
    const completedRe = /^(delivered|completed|pod received)$/i
    const activeRe = /^(heading to shipper|in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading)$/i
    const num = (x) => parseFloat(String(x).replace(/[$,]/g, '')) || 0
    const curMonth = dayCT().slice(0, 7)
    const recOf = (r, i) => ({
      rowIndex: i + 2, lid: String(r[cols.id] ?? '').trim(),
      st: cols.status >= 0 ? String(r[cols.status] ?? '').trim() : '',
      drv: String(r[cols.driver] ?? '').trim(),
      pay: cols.pay >= 0 ? String(r[cols.pay] ?? '').trim() : '',
      date: cols.date >= 0 ? String(r[cols.date] ?? '').trim() : '',
    })
    const all = S.rows.map(recOf).filter((x) => x.lid)
    const idCount = new Map(); all.forEach((x) => idCount.set(x.lid, (idCount.get(x.lid) || 0) + 1))
    // K1 dispatches through the load-binding guard, so it needs a load whose id is
    // on exactly one row; K3 edits by row index, so it does not.
    const active = all.filter((x) => activeRe.test(x.st) && idCount.get(x.lid) === 1)
    const completedThisMonth = all
      .filter((x) => completedRe.test(x.st) && num(x.pay) > 0 && jtMonthKey(x.date) === curMonth)
      .sort((a, b) => num(b.pay) - num(a.pay))
    let monthOpen = true
    try { monthOpen = String(db.prepare('SELECT status FROM period_locks WHERE period = ?').get(curMonth)?.status || '') !== 'locked' } catch { /* no lock table: treat open */ }
    meta.ids.namesMonth = `${curMonth} (${monthOpen ? 'open' : 'locked'})`
    if (!db) namesNotes.push('no DB_PATH: the month-open check and the K1 notification clean-up were skipped')

    // ⚠️ K2 runs LAST, and this is load-bearing. On a build without the fix, planting
    // the reserved name on a completed load and reading it back writes a month key
    // onto Object.prototype (a per-driver monthly map keyed by the reserved name),
    // which pollutes the whole process: that key then leaks into later Google API
    // requests and every subsequent Sheets read/write fails. The task's "corrupted in
    // memory, must not be reused" is exactly this. So the two Dispatcher steps run
    // FIRST, on a clean server; K2 runs after them, and nothing runs after K2.
    // K1's dispatch is different: it only leaves a "Dispatched" row under the reserved
    // name in the sheet + 60 s cache, which makes GET /api/dashboard throw (the queue
    // builder — a read, not a write, so no pollution) until the row is restored and
    // the cache refreshes. K3 opens a load from the dashboard, so it waits for a 200.
    const waitDashboardHealthy = async (page, tag, maxMs = 80000) => {
      const start = Date.now(); let last = 0
      while (Date.now() - start < maxMs) {
        const r = await api(page, 'GET', '/api/dashboard'); last = r.status
        if (r.status === 200) return true
        await page.waitForTimeout(5000)
      }
      namesNotes.push(`${tag}: GET /api/dashboard did not return 200 within ${Math.round(maxMs / 1000)}s (last ${last})`)
      return false
    }
    const hasDispatcher = !!(CREDS.dispatcher && CREDS.dispatcher.username)
    if (hasDispatcher) {
      meta.ids.namesDispatcher = CREDS.dispatcher.userId
      await login(dispCtx.page, 'Names — Dispatcher', CREDS.dispatcher.username, CREDS.dispatcher.password, '/dashboard')
      await reservedDispatchCase(dispCtx.page, S, cols, active)
      await waitDashboardHealthy(dispCtx.page, 'before K3') // clear K1's dispatch poison; K3 opens a load from the dashboard
      await formulaCellSaveCase(dispCtx.page, S, cols, active)
    } else {
      record({ step: 'K1', title: 'Dispatcher dispatches a real load to a reserved driver name', expected: '—', observed: 'SKIPPED — the creds file has no dispatcher login (run setup-db.cjs)', verdict: 'SKIP', shot: '' })
      record({ step: 'K3', title: 'Dispatcher edits a load and saves a formula-looking cell', expected: '—', observed: 'SKIPPED — the creds file has no dispatcher login (run setup-db.cjs)', verdict: 'SKIP', shot: '' })
    }

    if (!monthOpen) {
      record({ step: 'K2', title: 'A reserved driver name is planted on a completed load in the current open month', expected: '—', observed: `SKIPPED — the current month ${curMonth} is finalized (K2 needs an open month)`, verdict: 'SKIP', shot: '' })
    } else {
      await login(saCtx.page, 'Names — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      await reservedTotalsCase(saCtx.page, S, cols, completedThisMonth)
    }

    // The steps ran K1, K3, K2 (see above); show them K1, K2, K3 in the table.
    const kOrder = { K1: 0, K2: 1, K3: 2 }
    const kSlots = rows.map((r, i) => (/^K[123]$/.test(r.step) ? i : -1)).filter((i) => i >= 0)
    const kSorted = kSlots.map((i) => rows[i]).sort((a, b) => kOrder[a.step] - kOrder[b.step])
    kSlots.forEach((slot, n) => { rows[slot] = kSorted[n] })
    writeResults()
  } finally {
    const left = fs.existsSync(JOURNAL)
    if (namesNotes.length || left) {
      record({
        step: 'Kc', title: 'Names: restore every sheet row the section wrote', expected: 'Every touched row restored; no plant journal left',
        observed: [...namesNotes, left ? 'plant journal still present!' : 'no plant journal left'].join('; '),
        verdict: verdict(!left && !namesNotes.some((n) => /MISMATCH|error|LEFT BEHIND/.test(n))), shot: '',
      })
    }
    await dispCtx.ctx.close().catch(() => {})
    await saCtx.ctx.close().catch(() => {})
    if (ownDb && db) { try { db.close() } catch { /* ignore */ } db = null }
  }
}

async function moneyPathSection() {
  const ownDb = !db
  if (!db) db = openDb()
  const { ctx, page } = await freshPage(ADMIN_VP)
  try {
    const want = ['P1a', 'E1', 'N1', 'N1b', 'F1', 'E2', 'B1', 'RC1'].filter((x) => wantMp(x) || (x === 'P1a' && wantMp('P1b'))).map((x) => x.replace('P1a', 'P1'))
    const adminNeeded = want.some((x) => x !== 'E1')
    if (adminNeeded || db) {
      await login(page, 'Money path — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      if (db) await proveMoneyPathDb(page)
    }
    // B1 first: it reads its expense as the boot left it, before any other step runs.
    if (want.includes('B1')) await bootBackfillSpacingCase(page)
    if (want.includes('P1')) {
      try { await payRateCase(page) } catch (e) { record({ step: 'P1', title: 'Drivers Database: clear a daily rate', expected: '', observed: `error: ${e.message}`, verdict: 'FAIL', shot: await shot(page, 'p1-error') }) }
    }
    if (want.includes('E1')) await expenseStampCase()
    if (want.includes('N1')) await renameSpacingCase(page)
    if (want.includes('N1b')) await renameOntoOwnDirectorySpelling(page)
    if (want.includes('F1')) await cellOnlySaveCase(page)
    if (want.includes('E2')) await payDeductionSpacingCase(page)
    if (want.includes('RC1')) await rateconUpsertCase(page)
  } finally {
    try { if (db) mpNotes.push(...restoreAll().map((n) => `MP ${n}`)) } catch (e) { mpNotes.push(`restore error: ${e.message}`) }
    try { if (db) mpNotes.push(...removeCreated().map((n) => `MP ${n}`)) } catch (e) { mpNotes.push(`delete error: ${e.message}`) }
    const left = fs.existsSync(JOURNAL)
    record({
      step: 'MPc', title: 'Money path: restore every planted value, delete every row the section created, put the sheet rows back',
      expected: 'Everything restored or deleted; no plant journal left',
      observed: [...mpNotes, left ? 'plant journal still present!' : 'no plant journal left'].join('; ') || 'nothing to restore',
      verdict: verdict(!left && !mpNotes.some((n) => /MISMATCH|error|LEFT BEHIND/.test(n))), shot: '',
    })
    await ctx.close().catch(() => {})
    if (ownDb && db) { try { db.close() } catch { /* ignore */ } db = null }
  }
}

async function cleanup() {
  if (!runs('trucks')) {
    // Nothing planted, no trucks made: the other sections close their own contexts.
    try { await browser?.close() } catch { /* ignore */ }
    return
  }
  // ============ Step 12 — restore planted values, delete the test truck(s)
  const notes = []
  try { if (db && originals.size) notes.push(...restoreAll()) } catch (e) { notes.push(`restore error: ${e.message}`) }
  if (db) notes.push(fs.existsSync(JOURNAL) ? 'plant journal still present!' : 'all planted values restored')
  let ok = true
  if (admin) {
    try {
      await admin.goto(`${BASE_URL}/trucks`)
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      await caption(admin, `Step 12 — clean-up: restore planted values, delete the test trucks (${UNIT}, -B, -R9, ${INV_UNIT})`)
      const all = await api(admin, 'GET', '/api/trucks')
      for (const t of (all.json?.trucks || []).filter((t) => (t.UnitNumber || '').startsWith(UNIT) || t.UnitNumber === INV_UNIT)) created.add(t.id)
      for (const id of created) {
        const d = await api(admin, 'DELETE', `/api/trucks/${id}`)
        notes.push(`DELETE /api/trucks/${id} → ${d.status}${d.json?.code ? ` ${d.json.code}` : ''}`)
        if (d.status !== 200) ok = false
      }
      const after = await api(admin, 'GET', '/api/trucks')
      const left = (after.json?.trucks || []).filter((t) => (t.UnitNumber || '').startsWith('QA-TEST-'))
      if (left.length) { ok = false; notes.push(`still listed: ${left.map((t) => `#${t.id}`).join(', ')}`) } else notes.push('no QA-TEST truck left')
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      await caption(admin, `Step 12 — clean-up done: ${notes.join(' · ')}`)
    } catch (e) { ok = false; notes.push(`error: ${e.message}`) }
  }
  const s = admin ? await shot(admin, '12-cleanup') : ''
  record({ step: '12', title: 'Restore planted values; delete every test truck this run made (A, B, R9, the investor\'s)', expected: 'Originals restored; DELETE 200 each; no QA-TEST truck left', observed: notes.join('; '), verdict: verdict(ok), shot: s })
  try { await browser?.close() } catch { /* ignore */ }
  try { db?.close() } catch { /* ignore */ }
}

// ---------------------------------------------------------------- ELD link (L1-L3)
// The ELD-link period guard (check (5b) of truckEditLockBlockers()) refused every
// link, unlink and re-point while any month was finalized, so a truck added this
// month could not be linked at all. It now blocks only the finalized months that
// Job Tracking rows carrying the truck's own unit reach.
const ELD_TRUCK_COL_RE = /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i
async function eldLinkSection() {
  const { ctx, page } = await freshPage(ADMIN_VP)
  const stamp = Date.now().toString(36).toUpperCase()
  const UNIT = `QA-TEST-ELD-${stamp}`
  let truckId = null
  const isLinkCall = (r) => /^\/api\/trucks\/\d+\/link-routemate$/.test(pathOf(r.url()))
  try {
    await login(page, 'Step L1 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    const per = await api(page, 'GET', '/api/periods')
    const locked = (per.json?.periods || []).filter((p) => p.phase === 'finalized').map((p) => p.period).sort()
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))

    // ---- L1: a new truck (no loads anywhere) links from the Trucks page
    {
      let observed = ''; let ok = false; let s = ''
      try {
        const mk = await api(page, 'POST', '/api/trucks', { unitNumber: UNIT, status: 'Active', in_service_date: today, inServiceDate: today, assignedDriver: '' })
        truckId = mk.json?.id ?? mk.json?.truck?.id ?? null
        if (!truckId) {
          const all = await api(page, 'GET', '/api/trucks')
          truckId = (all.json?.trucks || []).find((t) => t.UnitNumber === UNIT)?.id ?? null
        }
        if (!truckId) throw new Error(`POST /api/trucks answered ${mk.status}${mk.json?.code ? ` ${mk.json.code}` : ''}; no truck made`)
        await page.goto(`${BASE_URL}/trucks`)
        const row = rowOf(page, UNIT)
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        await caption(page, `Step L1 — new truck ${UNIT} (${locked.length} finalized month(s) on this server, no loads on this truck): open Link`)
        await row.locator('button.btn-link-rm').click()
        const modal = page.locator('.confirm-dialog', { hasText: `Link Truck ${UNIT}` })
        await modal.waitFor({ state: 'visible', timeout: 15000 })
        const item = modal.locator('.rm-pick-item').first()
        await item.waitFor({ state: 'visible', timeout: 20000 })
        const device = (await item.locator('.rm-pick-id').innerText()).trim()
        await item.click()
        await caption(page, `Step L1 — pick device ${device}, then Link Selected`)
        const [resp] = await Promise.all([
          page.waitForResponse((r) => isLinkCall(r) && r.request().method() === 'POST', { timeout: 30000 }),
          modal.getByRole('button', { name: 'Link Selected' }).click(),
        ])
        let body = null; try { body = await resp.json() } catch { /* ignore */ }
        await row.locator('.rm-linked').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
        const t = await getTruck(page, truckId)
        const linked = !!(t && t.RoutemateVehicleId)
        ok = resp.status() === 200 && linked && locked.length > 0
        observed = `POST link-routemate → ${resp.status()}${body?.code ? ` ${body.code}` : ''}` +
          `${resp.status() !== 200 && body?.error ? ` "${String(body.error).slice(0, 220)}"` : ''}; ` +
          `truck ${linked ? 'now linked' : 'NOT linked'}; ${locked.length} finalized month(s) on this server` +
          (locked.length ? '' : ' — nothing to refuse over, so this proves nothing')
        await caption(page, `Step L1 — ${observed}`)
        s = await shot(page, 'l1-link-new-truck')
      } catch (e) { observed = `error: ${e.message}` }
      record({
        step: 'L1', title: 'Super Admin links a truck added today (no load in any finalized month) to an ELD device from the Trucks page',
        expected: '200; the row shows Linked (it used to be refused over every finalized month)', observed, verdict: verdict(ok), shot: s,
      })
    }

    // ---- L2: the same truck unlinks from the Trucks page
    {
      let observed = ''; let ok = false; let s = ''
      try {
        if (!truckId) throw new Error('no L1 truck')
        const row = rowOf(page, UNIT)
        await caption(page, `Step L2 — unlink ${UNIT} with the × in the Routemate column`)
        const [resp] = await Promise.all([
          page.waitForResponse((r) => isLinkCall(r) && r.request().method() === 'DELETE', { timeout: 30000 }),
          row.locator('button.btn-unlink-rm').click(),
        ])
        await row.locator('button.btn-link-rm').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
        const t = await getTruck(page, truckId)
        ok = resp.status() === 200 && !!t && !t.RoutemateVehicleId
        observed = `DELETE link-routemate → ${resp.status()}; truck ${t && !t.RoutemateVehicleId ? 'unlinked' : 'STILL linked'}`
        await caption(page, `Step L2 — ${observed}`)
        s = await shot(page, 'l2-unlink-new-truck')
      } catch (e) { observed = `error: ${e.message}` }
      record({ step: 'L2', title: 'The same truck unlinks from the Trucks page', expected: '200; the row shows Link again', observed, verdict: verdict(ok), shot: s })
    }

    // ---- L3: a linked truck whose own loads reach a finalized month is still refused
    {
      let observed = ''; let v = 'FAIL'; let s = ''
      try {
        if (!DB_PATH) throw Object.assign(new Error('SKIPPED — no DB_PATH (L3 restores the link it would break, so it runs locally only)'), { skip: true })
        if (!db) db = openDb()
        // /api/data pages at 200 rows; read every page.
        let hs = []; const rows = []
        for (let pg = 1, pages = 1; pg <= pages && pg <= 50; pg++) {
          const jt = await api(page, 'GET', `/api/data?sheet=${encodeURIComponent('Job Tracking')}&limit=200&page=${pg}`)
          if (jt.status !== 200) throw new Error(`GET /api/data page ${pg} → ${jt.status}`)
          hs = jt.json?.headers || hs
          rows.push(...(jt.json?.data || []))
          pages = jt.json?.totalPages || 1
        }
        const cols = hs.filter((h) => ELD_TRUCK_COL_RE.test(String(h ?? '')))
        const key = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
        const carried = new Map()
        for (const r of rows) for (const c of cols) { const k = key(r[c]); if (k) carried.set(k, (carried.get(k) || 0) + 1) }
        const trucks = (await api(page, 'GET', '/api/trucks')).json?.trucks || []
        const cand = trucks.filter((t) => t.RoutemateVehicleId && carried.has(key(t.UnitNumber)))
          .sort((a, b) => carried.get(key(b.UnitNumber)) - carried.get(key(a.UnitNumber)))
        if (!locked.length) throw Object.assign(new Error('SKIPPED — no finalized month on this server'), { skip: true })
        if (!cand.length) throw Object.assign(new Error(`SKIPPED — no linked truck's unit appears in Job Tracking's Truck column (${cols.length} Truck column(s), ${carried.size} distinct unit value(s))`), { skip: true })
        // Every linked truck the sheet carries: each must be refused, over finalized
        // months only. A truck with an unreadable date on one of its rows is refused
        // over all of them (fail closed); the rest over the months their loads reach.
        const parts = []; let ok = true; let scopedSeen = 0
        for (const t of cand) {
          const before = readCol('trucks', 'routemate_vehicle_id', t.id)
          await caption(page, `Step L3 — ${t.UnitNumber} is linked and carried by ${carried.get(key(t.UnitNumber))} Job Tracking row(s): try to unlink it`, false)
          const r = await api(page, 'DELETE', `/api/trucks/${t.id}/link-routemate`)
          const after = readCol('trucks', 'routemate_vehicle_id', t.id)
          if (after !== before) writeCol('trucks', 'routemate_vehicle_id', t.id, before)
          const ps = r.json?.periods || []
          const good = r.status === 409 && r.json?.code === 'PERIOD_FINALIZED' && ps.length > 0 && ps.every((p) => locked.includes(p)) && after === before
          if (!good) ok = false
          if (good && ps.length < locked.length) scopedSeen++
          parts.push(`${t.UnitNumber} → ${r.status}${r.json?.code ? ` ${r.json.code}` : ''} over ${ps.length}/${locked.length}` +
            `${ps.length && ps.length < locked.length ? ` (${ps.join(', ')})` : ''}${after === before ? '' : ' — LINK WAS CLEARED (restored from the copy)'}`)
        }
        v = ok ? 'PASS' : 'FAIL'
        observed = `${parts.join('; ')}; ${scopedSeen} of ${cand.length} refused over fewer than every finalized month`
        await caption(page, `Step L3 — ${observed}`)
        s = await shot(page, 'l3-refused-with-loads')
      } catch (e) { observed = e.skip ? e.message : `error: ${e.message}`; v = e.skip ? 'SKIP' : 'FAIL' }
      record({
        step: 'L3', title: 'A linked truck whose own Job Tracking loads reach a finalized month: unlink it',
        expected: '409 PERIOD_FINALIZED naming only finalized months (those its loads reach); the link unchanged', observed, verdict: v, shot: s,
      })
    }
  } finally {
    if (truckId) {
      try {
        const t = await getTruck(page, truckId)
        if (t?.RoutemateVehicleId) await api(page, 'DELETE', `/api/trucks/${truckId}/link-routemate`)
        const d = await api(page, 'DELETE', `/api/trucks/${truckId}`)
        if (d.status !== 200) console.log(`  (L clean-up: DELETE /api/trucks/${truckId} → ${d.status}${d.json?.code ? ` ${d.json.code}` : ''})`)
      } catch (e) { console.log(`  (L clean-up failed: ${e.message})`) }
    }
    try { await ctx.close() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- invoice editor (I1-I9)
// ONLY=invoice. The draft invoice editor (InvoiceDraftPreviewModal.vue), opened from
// Dashboard → Completed → a delivered load → Draft Invoice Email with
// POST /api/loads/:loadId/draft-invoice?dryRun=1, and re-rendered as you type by
// POST /api/loads/:loadId/invoice-preview. The AFTER behaviour:
//   - ORDER # takes any printable character but < and >, 80 max, starting with a
//     letter or number; the read-only SUBJECT the server builds carries it as typed.
//   - An optional NOTES box (500 max, line breaks kept) prints in a labelled "Notes"
//     box beside the totals on the invoice PDF only, and only when it is non-empty.
//     It is saved on the approved draft record, and the next dryRun pre-fills it,
//     labelled as carried over until the dispatcher types into it.
//   - An approve on a server with no mail target says so in the load dialog, never
//     "Draft ready in Gmail".
//   - Nothing writes Job Tracking.
// Evidence: the page's own requests and responses (page.on), the PDF the server
// rendered (its text, read with the app's pdfjs-dist in Node), and the form.
//
// Spend per server process: one sign-in; POST …/draft-invoice (25 per 15 min per
// user, the ?dryRun=1 opens included) three times (I1, I7's approve, I8's reopen)
// plus one per candidate load whose dryRun failed; POST …/invoice-preview (120 per
// 15 min) about seventeen times.
//
// ⚠️ The approve (I7) creates a real Gmail draft wherever the server has a mail
// target. boot-server.sh blanks Gmail and the n8n invoice webhook, so locally the
// route answers preview:true and records nothing. On any other server it is SKIPPED
// unless E2E_INVOICE_APPROVE=1.
//
// ⚠️ The draft route reads a load's POD from <checkout>/uploads on disk, which a
// worktree lacks: prep it with E2E_LINK_PODS=1 scripts/e2e/prep-worktree.sh.
const EM_DASH = String.fromCodePoint(0x2014)
const INV_ORDER = '7101850-$700 ADV'
const INV_ORDER_WIDE = "A (ADV): 50% + fee & 'tax' @ dock"
const INV_ORDER_BAD = '7101850<b>'
const INV_ORDER_81 = `A${'1234567890'.repeat(8)}` // 81 characters, valid in every other way
const INV_ORDER_HINT = `Must start with a letter or number ${EM_DASH} any characters except < and >, 80 max.`
const INV_ORDER_EDITED = `Invoice only ${EM_DASH} Job Tracking is not changed.`
const INV_NOTE3 = ['Advance $700 paid at pickup.', `Detention 2h ${EM_DASH} see POD.`, 'Ref <ADV-7101850> & thanks']
const INV_NOTES_MAX = 500
const wantInv = (id) => !STEPS || STEPS.has(id)
const invPath = (id, tail) => `/api/loads/${encodeURIComponent(id)}/${tail}`
const isPostTo = (r, p) => r.request().method() === 'POST' && pathOf(r.url()) === p
function bodyOf(req) { try { return req.postDataJSON() } catch { return null } }
const invSkip = (why) => Object.assign(new Error(`SKIPPED — ${why}`), { skip: true })
// The subject names the broker; the results show only what follows it.
const subjectTail = (s) => {
  const t = String(s ?? ''); const i = t.indexOf('Order #')
  return i < 0 ? `(no "Order #" in a ${t.length}-character subject)` : `${i > 0 ? '<broker> ' : ''}${t.slice(i)}`
}

// PDF → text with the app's own pdfjs-dist (client/node_modules, the legacy build
// runs in Node). Lines come from pdfjs's end-of-line marks, whitespace-collapsed;
// items keep each run's position (PDF points, and relative to its page).
let pdfjsLib = null
async function pdfText(b64) {
  if (!b64) return null
  if (!pdfjsLib) {
    const p = path.join(paths.appDir(), 'client', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
    if (!fs.existsSync(p)) throw new Error(`pdfjs-dist is not installed at ${p} (the client install)`)
    pdfjsLib = await import(pathToFileURL(p).href)
  }
  const task = pdfjsLib.getDocument({ data: new Uint8Array(Buffer.from(b64, 'base64')), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  let text = ''
  const items = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i)
      const [x0, y0, x1, y1] = pg.view
      const tc = await pg.getTextContent()
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue
        text += it.str
        if (it.hasEOL) text += '\n'
        if (it.str.trim()) {
          items.push({ page: i, str: it.str, x: Math.round(it.transform[4] * 10) / 10, y: Math.round(it.transform[5] * 10) / 10,
            rx: (it.transform[4] - x0) / (x1 - x0), ry: 1 - (it.transform[5] - y0) / (y1 - y0) })
        }
      }
      text += '\n'
    }
  } finally { await task.destroy().catch(() => {}) }
  return { text, lines: text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean), items, pages: doc.numPages }
}
// The labelled Notes box: its label prints letter-spaced ("N O T E S"), then the note.
const isNotesLabel = (l) => l.replace(/\s+/g, '').toUpperCase() === 'NOTES'
function notesAfterLabel(pt, n) {
  const i = pt.lines.findIndex(isNotesLabel)
  return { label: i >= 0, after: i >= 0 ? pt.lines.slice(i + 1, i + 1 + n) : [] }
}
const layoutOf = (pt) => JSON.stringify(pt.items.map(({ page, str, x, y }) => [page, str, x, y]))
// The totals row, as a point on the page to centre the viewer on.
function totalsRow(pt) {
  const it = pt?.items.find((x) => /^SUB-?TOTAL/i.test(x.str.replace(/\s+/g, '')))
  return it ? { page: it.page, rx: 0.5, ry: it.ry } : null
}

const orderInput = (page) => page.locator('#idp-order')
const orderField = (page) => page.locator('.idp-field', { has: page.locator('#idp-order') })
const orderErrors = (page) => orderField(page).locator('p.idp-hint-warn')
const approveButton = (page) => page.locator('.idp-footer button.idp-btn-primary')
const notesBox = (page) => page.locator('#idp-notes')
// "Carried over from this load's last approved invoice …", under NOTES (I8h).
const carriedHint = (page) => page.locator('#idp-notes-carried')
// The message under the load's title in the load dialog, after an approve (I7r).
const draftResultMsg = (page) => page.locator('.draft-result')
const orderInvalid = (page) => orderInput(page).evaluate((el) => el.classList.contains('is-invalid')).catch(() => false)
// Bring the field under test (and its hint) to the middle of the form's pane.
async function showField(page, sel) {
  if (await page.locator(sel).count()) await page.locator(sel).evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {})
}

// Resolves with the first invoice-preview response whose REQUEST body matches, or
// null (timeout, or the page went away). Registered before the edit that sends it.
function expectPreview(page, id, match, timeout = 60000) {
  const p = invPath(id, 'invoice-preview')
  return page.waitForResponse((r) => { if (!isPostTo(r, p)) return false; const b = bodyOf(r.request()); return !!b && match(b) }, { timeout })
    .then(async (r) => ({ status: r.status(), json: await r.json().catch(() => null), body: bodyOf(r.request()) }))
    .catch(() => null)
}
// The modal has adopted the render: no "updating…" badge, the viewer finished.
async function previewSettled(page) {
  await page.locator('label[for="idp-subject"] .idp-badge-amber').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.locator('.idp-stage .pz-status').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(300)
}
// Type an Order #. Waits for the render it triggers unless the field refuses it.
async function typeOrder(page, id, value, also = () => true) {
  const pv = expectPreview(page, id, (b) => b.orderNumber === value && also(b))
  await orderInput(page).fill(value)
  await page.waitForTimeout(1200) // past the 600 ms debounce
  if (await orderInvalid(page)) return { refused: true, preview: null }
  const preview = await pv
  await previewSettled(page)
  return { refused: false, preview }
}
// The form renders nothing while the Order # is empty or refused.
const orderBlocks = async (page) => !(await orderInput(page).inputValue()).trim() || await orderInvalid(page)
// Type into NOTES (fill: real line breaks land) and wait for its render.
async function typeNotes(page, id, value, also = () => true) {
  const pv = expectPreview(page, id, (b) => b.notes === value && also(b))
  await notesBox(page).fill(value)
  await page.waitForTimeout(1000)
  if (await orderBlocks(page)) return null
  const preview = await pv
  await previewSettled(page)
  return preview
}

// Centre the invoice viewer on a point of the rendered page and zoom in a little,
// the way a person would: a drag to pan, then the wheel over the point.
async function zoomInvoiceOn(page, target) {
  if (!target) return false
  const geo = () => page.evaluate((n) => {
    const v = document.querySelector('.idp-stage .pz-viewport')?.getBoundingClientRect()
    const c = document.querySelectorAll('.idp-stage .pz-content canvas')[n]?.getBoundingClientRect()
    return v && c ? { v: { x: v.x, y: v.y, w: v.width, h: v.height }, c: { x: c.x, y: c.y, w: c.width, h: c.height } } : null
  }, target.page - 1)
  let g = await geo()
  if (!g) return false
  const cx = g.v.x + g.v.w / 2
  const cy = g.v.y + g.v.h / 2
  const ty = g.c.y + target.ry * g.c.h
  if (Math.abs(ty - cy) > 30) {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy - (ty - cy), { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    g = await geo()
    if (!g) return false
  }
  await page.mouse.move(g.c.x + target.rx * g.c.w, g.c.y + target.ry * g.c.h)
  await page.mouse.wheel(0, -110)
  await page.waitForTimeout(400)
  return true
}

// Delivered/completed loads with a POD, from the Super Admin's own dashboard and
// documents reads (no draft-invoice budget spent). Non-Bison loads first (a Bison
// load needs its Order # and PO # typed before anything renders), then loads with a
// Payment (so the dryRun renders a PDF), then loads with no draft yet (no second
// confirm on approve). Values stay in memory: ids and booleans only.
async function invoiceCandidates(page) {
  const d = (await api(page, 'GET', '/api/dashboard')).json || {}
  const jobs = d.completedJobs || []
  const hs = d.completedHeaders || d.jobTrackingHeaders || Object.keys(jobs[0] || {})
  const pick = (exact, loose) => hs.find((h) => exact.test(String(h ?? '').trim())) || hs.find((h) => loose.test(String(h ?? '')))
  const idCol = hs.find((h) => /load.?id|job.?id/i.test(String(h ?? '')))
  const stCol = pick(/^status$/i, /status/i)
  const emCol = pick(/^email$/i, /broker.*email|email/i)
  const payCol = pick(/^payment$/i, /payment/i)
  if (!idCol || !stCol) return { list: [], why: 'the dashboard payload has no load-id or status column' }
  const all = jobs
    .map((j) => ({
      id: String(j[idCol] ?? '').trim(), raw: String(j[idCol] ?? ''),
      delivered: /delivered|completed|pod received/i.test(String(j[stCol] ?? '')),
      bison: /bisontransport\.com$/i.test(String(emCol ? j[emCol] ?? '' : '').trim().toLowerCase()),
      paid: payCol ? parseMoney(j[payCol]) > 0 : false,
    }))
    .filter((c) => c.id && c.delivered)
  const rank = (c) => (c.bison ? 4 : 0) + (c.paid ? 0 : 2) + (c.drafted ? 1 : 0)
  const order = all.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c)
  const out = []
  let checked = 0
  for (const c of order) {
    if (out.length >= 4 || checked >= 60) break
    checked++
    const docs = await api(page, 'GET', `/api/documents/${encodeURIComponent(c.id)}`)
    if (!(docs.json?.documents || []).some((x) => String(x.type || '').toUpperCase() === 'POD')) continue
    const dr = await api(page, 'GET', invPath(c.id, 'invoice-draft'))
    c.drafted = !!dr.json?.draft
    out.push(c)
  }
  out.sort((a, b) => rank(a) - rank(b))
  return { list: out, why: `${all.length} delivered/completed load(s) listed, ${checked} checked for a POD` }
}

// Completed Loads → search the load → open it → Draft Invoice Email. `nav` is how the
// dashboard is reached first: 'goto', 'reload' (I8: a fresh page), or 'none' (already
// on it, after a candidate whose dryRun failed).
async function openInvoiceEditor(page, cand, label, nav = 'goto') {
  if (nav === 'goto') await page.goto(`${BASE_URL}/dashboard`)
  else if (nav === 'reload') await page.reload({ waitUntil: 'load' })
  const tab = page.getByRole('tab', { name: /Completed/ })
  await tab.waitFor({ state: 'visible', timeout: 45000 })
  await tab.click()
  const panel = page.locator('[role="tabpanel"][data-state="active"]')
  const search = panel.getByPlaceholder('Search load number...')
  await search.waitFor({ state: 'visible', timeout: 30000 })
  await search.fill(cand.id)
  const row = panel.locator('tbody tr', { hasText: cand.id }).first()
  await row.waitFor({ state: 'visible', timeout: 30000 })
  await caption(page, `${label} — Completed Loads: load ${cand.id}; open it`)
  await row.click()
  const btn = page.getByRole('button', { name: /Draft Invoice Email/ })
  await btn.waitFor({ state: 'visible', timeout: 30000 })
  await caption(page, `${label} — load ${cand.id}: Draft Invoice Email (the editor opens with ?dryRun=1)`)
  const dp = invPath(cand.id, 'draft-invoice')
  const [resp] = await Promise.all([
    page.waitForResponse((r) => isPostTo(r, dp) && new URL(r.url()).searchParams.get('dryRun') === '1', { timeout: 120000 }),
    btn.click(),
  ])
  const json = await resp.json().catch(() => null)
  if (resp.status() !== 200) {
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(500)
    return { ok: false, err: `${resp.status()}${json?.code ? ` ${json.code}` : ''} "${String(json?.error || '').slice(0, 140)}"`, json }
  }
  await orderInput(page).waitFor({ state: 'visible', timeout: 30000 })
  if (json?.invoicePdfBase64) await page.locator('.idp-stage .pz-content canvas').first().waitFor({ state: 'visible', timeout: 45000 }).catch(() => {})
  await previewSettled(page)
  return { ok: true, json }
}

async function invoiceSection() {
  const ownDb = !db
  if (!db && DB_PATH) db = openDb()
  const { ctx, page } = await freshPage(ADMIN_VP)
  ctx.setDefaultTimeout(30000)
  const cleanNotes = []
  // Approve may ask twice: a second draft for a load that has one, an edited total.
  const dialogs = []
  page.on('dialog', (d) => {
    const m = d.message()
    dialogs.push(/already exists/i.test(m) ? 'duplicate-draft confirm' : /will bill/i.test(m) ? 'edited-total confirm' : `a ${d.type()}`)
    d.accept().catch(() => {})
  })
  const S = { cand: null, open: false, dry: null, jtBefore: null, pdfI2: null, list: [] }
  const editorWanted = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7'].some(wantInv)
  const id = () => S.cand?.id
  const needEditor = () => { if (!S.open) throw invSkip('the editor did not open (see I1)') }
  const needNotesBox = async () => {
    if (!(await notesBox(page).count())) throw Object.assign(new Error('this build\'s editor has no NOTES box'), { noNotes: true })
  }
  // One step: its own try/catch, an error screenshot, one results row.
  const step = async (stepId, title, expected, shotName, fn) => {
    let observed = ''; let v = 'FAIL'; let s = ''
    try {
      const r = await fn()
      observed = r.observed; v = r.verdict; s = r.shot ?? await shot(page, shotName)
    } catch (e) {
      observed = e.skip ? e.message : e.noNotes ? `${e.message}; nothing to type into` : `error: ${e.message}`
      v = e.skip ? 'SKIP' : 'FAIL'
      if (!e.skip) s = await shot(page, `${shotName}-error`)
    }
    record({ step: stepId, title, expected, observed, verdict: v, shot: s })
  }

  try {
    await login(page, 'Step I1 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')

    // ---- I1: the editor opens on a delivered load with a POD
    let discovery = ''
    if (editorWanted || wantInv('I8')) {
      const found = await invoiceCandidates(page)
      S.list = found.list
      discovery = found.why
    }
    if (editorWanted) {
      await step('I1', 'Super Admin: Completed Loads → a delivered load with a POD → Draft Invoice Email; the draft editor opens',
        'The editor opens (the ?dryRun=1 answers 200); the load\'s Job Tracking row is read before any edit (kept in memory)', 'i1-editor-open', async () => {
          if (!S.list.length) throw invSkip(`no delivered/completed load with a POD (${discovery})`)
          const failed = []
          for (const c of S.list) {
            const o = await openInvoiceEditor(page, c, 'Step I1', failed.length ? 'none' : 'goto')
            if (o.ok) { S.cand = c; S.dry = o.json; S.open = true; break }
            failed.push(`${c.id} → ${o.err}`)
          }
          if (!S.open) throw new Error(`no candidate's dryRun answered 200: ${failed.join('; ')}`)
          meta.ids.invoiceLoad = id()
          const jt = await api(page, 'GET', `/api/load/${encodeURIComponent(S.cand.raw)}`)
          S.jtBefore = jt.status === 200 && jt.json?.load ? jt.json.load : null
          const dry = S.dry
          const extra = []
          if (dry.needsPoNumber) {
            await page.locator('.idp-field', { has: page.locator('#idp-po') }).locator('input[type="checkbox"]').check()
            extra.push('PO # required: "This rate confirmation has no PO #" ticked')
          }
          if (dry.needsTotal) {
            const pv = expectPreview(page, id(), (b) => b.total === '1234.00')
            await page.locator('#idp-total').fill('1234.00')
            await page.waitForTimeout(1200)
            if (!(await orderBlocks(page))) { await pv; await previewSettled(page) }
            extra.push('no total could be derived, so 1234.00 was typed (the approve confirms it)')
          }
          const hasNotesBox = (await notesBox(page).count()) > 0
          await caption(page, `Step I1 — the editor is open for load ${id()} (Bison: ${!!dry.isBison}; NOTES box: ${hasNotesBox})`)
          return {
            verdict: verdict(!!S.jtBefore),
            observed: `load ${id()}${failed.length ? ` (after ${failed.length} candidate(s) whose dryRun did not answer 200: ${failed.join('; ')})` : ''}; ` +
              `Bison ${!!dry.isBison}; dryRun 200; total from ${dry.totalSource || '?'}; Order # seeded from ${dry.orderNumberSource || '?'}; ` +
              `the dryRun echoes notes: ${Object.prototype.hasOwnProperty.call(dry, 'notes') ? JSON.stringify(dry.notes) : 'no such key'}; NOTES box on the form: ${hasNotesBox}; ` +
              `Job Tracking row read: ${S.jtBefore ? `${Object.keys(S.jtBefore).length} fields` : `NO (GET /api/load → ${jt.status})`}` +
              `${extra.length ? `; ${extra.join('; ')}` : ''}; ${discovery}`,
          }
        })
    }

    // ---- I2: "7101850-$700 ADV" is accepted and reaches the subject as typed
    if (wantInv('I2')) {
      await step('I2', `ORDER #: type "${INV_ORDER}"`,
        `No error under the field; the hint "${INV_ORDER_EDITED}" shows; the re-rendered SUBJECT (the invoice-preview response and the form) ends "Order #${INV_ORDER}"`, 'i2-order-dollar', async () => {
          needEditor()
          await caption(page, `Step I2 — type "${INV_ORDER}" into ORDER #`)
          const t = await typeOrder(page, id(), INV_ORDER)
          const errs = (await orderErrors(page).allInnerTexts()).map((x) => x.trim()).filter(Boolean)
          const hint = await orderField(page).locator('p.idp-hint', { hasText: INV_ORDER_EDITED }).isVisible().catch(() => false)
          const uiSubject = await page.locator('#idp-subject').inputValue()
          const want = `Order #${INV_ORDER}`
          const pt = t.preview?.json?.invoicePdfBase64 ? await pdfText(t.preview.json.invoicePdfBase64) : null
          if (pt) S.pdfI2 = pt
          const pdfOrder = !!pt && pt.lines.some((l) => l.includes(`Order: #${INV_ORDER}`))
          const respSubject = t.preview?.json?.subject
          const ok = !t.refused && !errs.length && hint && t.preview?.status === 200 && String(respSubject).endsWith(want) && uiSubject.endsWith(want) && pdfOrder
          const observed = t.refused
            ? `REFUSED by the form: ${errs.map((x) => `"${x}"`).join(' ') || 'the field is marked invalid'}; no preview was sent`
            : `error under the field: ${errs.length ? errs.map((x) => `"${x}"`).join(' ') : 'none'}; hint shown: ${hint}; invoice-preview → ${t.preview?.status ?? 'no response'}, ` +
              `subject "${subjectTail(respSubject)}"; the form's SUBJECT "${subjectTail(uiSubject)}"; the invoice PDF prints "Order: #${INV_ORDER}": ${pdfOrder}`
          await showField(page, '#idp-order')
          await caption(page, `Step I2 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
    }

    // ---- I3: the wider set, then < refused, then the 80 cap
    if (wantInv('I3')) {
      await step('I3a', `ORDER #: type "${INV_ORDER_WIDE}"`,
        'Accepted (no error); the SUBJECT ends with it, with a literal & (never &amp;); the PDF prints it too', 'i3a-order-wide', async () => {
          needEditor()
          await caption(page, `Step I3 — type "${INV_ORDER_WIDE}" into ORDER #`)
          const t = await typeOrder(page, id(), INV_ORDER_WIDE)
          const errs = (await orderErrors(page).allInnerTexts()).map((x) => x.trim()).filter(Boolean)
          const respSubject = String(t.preview?.json?.subject ?? '')
          const uiSubject = await page.locator('#idp-subject').inputValue()
          const want = `Order #${INV_ORDER_WIDE}`
          const pt = t.preview?.json?.invoicePdfBase64 ? await pdfText(t.preview.json.invoicePdfBase64) : null
          const pdfOrder = !!pt && pt.lines.some((l) => l.includes(`Order: #${INV_ORDER_WIDE}`)) && !pt.text.includes('&amp;')
          const ok = !t.refused && !errs.length && respSubject.endsWith(want) && !respSubject.includes('&amp;') && uiSubject.endsWith(want) && pdfOrder
          const observed = t.refused
            ? `REFUSED by the form: ${errs.map((x) => `"${x}"`).join(' ') || 'the field is marked invalid'}; no preview was sent`
            : `error: ${errs.length ? errs.join(' ') : 'none'}; invoice-preview → ${t.preview?.status ?? 'no response'}, subject "${subjectTail(respSubject)}" ` +
              `(&amp; in it: ${respSubject.includes('&amp;')}); the form's SUBJECT "${subjectTail(uiSubject)}"; the PDF prints it with a literal &: ${pdfOrder}`
          await showField(page, '#idp-order')
          await caption(page, `Step I3 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
      await step('I3b', `ORDER #: type "${INV_ORDER_BAD}"`,
        `The error "${INV_ORDER_HINT}" shows under the field, no preview is sent, and Approve is disabled`, 'i3b-order-angle', async () => {
          needEditor()
          let sent = 0
          const pp = invPath(id(), 'invoice-preview')
          const onReq = (r) => { if (r.method() === 'POST' && pathOf(r.url()) === pp && bodyOf(r)?.orderNumber === INV_ORDER_BAD) sent++ }
          page.on('request', onReq)
          try {
            await caption(page, `Step I3 — type "${INV_ORDER_BAD}" into ORDER #`)
            await orderInput(page).fill(INV_ORDER_BAD)
            await page.waitForTimeout(1500)
          } finally { page.off('request', onReq) }
          const errs = (await orderErrors(page).allInnerTexts()).map((x) => x.trim()).filter(Boolean)
          const disabled = await approveButton(page).isDisabled()
          const foot = (await page.locator('.idp-foot-note').innerText().catch(() => '')).trim()
          const ok = errs.includes(INV_ORDER_HINT) && sent === 0 && disabled
          const observed = `error under the field: ${errs.length ? errs.map((x) => `"${x}"`).join(' ') : 'none'}; previews sent with it: ${sent}; Approve disabled: ${disabled} (footer: "${foot}")`
          await showField(page, '#idp-order')
          await caption(page, `Step I3 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
      await step('I3c', 'ORDER #: paste an 81-character value, then put back the Order # of I2',
        'The field keeps 80 characters (maxlength); the I2 value then renders again', 'i3c-order-81', async () => {
          needEditor()
          await caption(page, 'Step I3 — paste an 81-character Order # (the field\'s maxlength cuts it)')
          await orderInput(page).click()
          await page.keyboard.press('ControlOrMeta+A')
          await page.keyboard.insertText(INV_ORDER_81)
          await page.waitForTimeout(700)
          const val = await orderInput(page).inputValue()
          const max = await orderInput(page).getAttribute('maxlength')
          await showField(page, '#idp-order')
          const s = await shot(page, 'i3c-order-81')
          await caption(page, `Step I3 — put back "${INV_ORDER}"`)
          const t = await typeOrder(page, id(), INV_ORDER)
          const ok = val.length === 80 && val === INV_ORDER_81.slice(0, 80) && !t.refused && t.preview?.status === 200
          const observed = `81 characters pasted → the field holds ${val.length} (maxlength="${max}"; the first ${val.length} kept: ${val === INV_ORDER_81.slice(0, val.length)}); ` +
            `"${INV_ORDER}" put back: ${t.refused ? 'REFUSED by the form' : `invoice-preview → ${t.preview?.status ?? 'no response'}`}`
          await caption(page, `Step I3 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed, shot: s }
        })
    }

    // ---- I4: a three-line note prints in a labelled Notes box on the PDF
    const note3 = INV_NOTE3.join('\n')
    if (wantInv('I4')) {
      await step('I4', 'NOTES: type a three-line note (with <…> and &)',
        `The counter reads "${note3.length} / ${INV_NOTES_MAX}"; the re-rendered invoice PDF has a "Notes" label followed by the three lines, in order, exactly as typed ` +
        '(<ADV-7101850> and & as literal text); the email body does not carry it', 'i4-notes-on-pdf', async () => {
          needEditor(); await needNotesBox()
          await caption(page, 'Step I4 — type a three-line note into NOTES')
          const pv = await typeNotes(page, id(), note3)
          const counter = (await page.locator('#idp-notes-count').innerText().catch(() => '')).trim()
          const pt = pv?.json?.invoicePdfBase64 ? await pdfText(pv.json.invoicePdfBase64) : null
          const nl = pt ? notesAfterLabel(pt, INV_NOTE3.length) : null
          const linesOk = !!nl && nl.label && JSON.stringify(nl.after) === JSON.stringify(INV_NOTE3)
          const inEmail = String(pv?.json?.emailHtml ?? '').includes('Detention 2h')
          const ok = counter === `${note3.length} / ${INV_NOTES_MAX}` && pv?.status === 200 && linesOk && !pt.text.includes('&amp;') && !inEmail
          const observed = `counter "${counter}"; invoice-preview → ${pv?.status ?? 'no response'}; PDF: "Notes" label ${nl?.label ?? false}, the lines after it ${JSON.stringify(nl?.after ?? [])} ` +
            `(as typed: ${linesOk}); &amp; in the PDF: ${pt ? pt.text.includes('&amp;') : '?'}; the note in the email body: ${inEmail}`
          await zoomInvoiceOn(page, totalsRow(pt))
          await showField(page, '#idp-notes')
          await caption(page, `Step I4 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
    }

    // ---- I5: clearing the note leaves no box and no gap
    if (wantInv('I5')) {
      await step('I5', 'NOTES: clear it',
        'The re-rendered PDF has no "Notes" label and none of the note\'s text, and lays out exactly as the I2 render (same fields, no note): the totals box alone on the right, no gap or blank box', 'i5-notes-cleared', async () => {
          needEditor(); await needNotesBox()
          if (!(await notesBox(page).inputValue())) await typeNotes(page, id(), note3) // I4 did not run
          await caption(page, 'Step I5 — clear NOTES')
          const pv = await typeNotes(page, id(), '')
          const pt = pv?.json?.invoicePdfBase64 ? await pdfText(pv.json.invoicePdfBase64) : null
          const label = !!pt && pt.lines.some(isNotesLabel)
          const leftover = !!pt && INV_NOTE3.some((l) => pt.text.includes(l.slice(0, 12)))
          const same = pt && S.pdfI2 ? layoutOf(pt) === layoutOf(S.pdfI2) : null
          const ok = pv?.status === 200 && !!pt && !label && !leftover && same !== false
          const observed = `invoice-preview → ${pv?.status ?? 'no response'}; PDF: "Notes" label ${label}, leftover note text ${leftover}; ` +
            `text and positions identical to the I2 render: ${same === null ? 'not compared (no I2 render)' : same}`
          await zoomInvoiceOn(page, totalsRow(pt))
          await showField(page, '#idp-notes')
          await caption(page, `Step I5 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
    }

    // ---- I6: Reset empties the note
    if (wantInv('I6')) {
      await step('I6', 'NOTES: type a note, then "Reset to extracted values"',
        'NOTES is empty with no "edited" badge, and the next preview has no Notes section', 'i6-notes-reset', async () => {
          needEditor(); await needNotesBox()
          await caption(page, 'Step I6 — type a note, then Reset to extracted values')
          await typeNotes(page, id(), 'QA-I6 note, to be reset')
          const badgeBefore = await page.locator('label[for="idp-notes"] .idp-badge').count()
          const pv = expectPreview(page, id(), (b) => b.notes === '')
          await page.getByRole('button', { name: 'Reset to extracted values' }).click()
          await page.waitForTimeout(1200)
          // A load whose Order # is not seeded (Bison) renders nothing after a Reset
          // until one is typed: type I2's, which is what the next preview then carries.
          if (await orderBlocks(page)) await orderInput(page).fill(INV_ORDER)
          const p = await pv
          await previewSettled(page)
          const val = await notesBox(page).inputValue()
          const badge = await page.locator('label[for="idp-notes"] .idp-badge').count()
          const resetDisabled = await page.getByRole('button', { name: 'Reset to extracted values' }).isDisabled()
          const pt = p?.json?.invoicePdfBase64 ? await pdfText(p.json.invoicePdfBase64) : null
          const label = !!pt && pt.lines.some(isNotesLabel)
          const ok = val === '' && badge === 0 && p?.status === 200 && !!pt && !label
          const observed = `"edited" badge before the Reset: ${badgeBefore > 0}; after: NOTES ${JSON.stringify(val)}, "edited" badge ${badge > 0}; ` +
            `next invoice-preview (notes "") → ${p?.status ?? 'no response'}, "Notes" label in its PDF ${label}; Reset now disabled: ${resetDisabled}`
          await showField(page, '#idp-notes')
          await caption(page, `Step I6 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
    }

    // ---- I7: approve carries the note and the Order #; Job Tracking is unchanged
    if (wantInv('I7')) {
      const note7 = `QA-I7 note ${stamp}`
      let info = null
      let approved = null // { status, preview } of the approve's response
      await step('I7', `Type a note and the Order # "${INV_ORDER}", then Approve & Create Draft (confirms accepted)`,
        `The approve request body carries notes exactly as typed and orderNumber "${INV_ORDER}"`, 'i7-approve', async () => {
          needEditor()
          const hasNotes = (await notesBox(page).count()) > 0
          await caption(page, `Step I7 — type a note and the Order # "${INV_ORDER}"`)
          if (hasNotes) await typeNotes(page, id(), note7)
          if (await orderInput(page).inputValue() !== INV_ORDER) await typeOrder(page, id(), INV_ORDER, (b) => !hasNotes || b.notes === note7)
          const refused = await orderInvalid(page)
          const btn = approveButton(page)
          let enabled = false
          for (let i = 0; i < 30 && !(enabled = await btn.isEnabled().catch(() => false)); i++) await page.waitForTimeout(500)
          if (!enabled) {
            const foot = (await page.locator('.idp-foot-note').innerText().catch(() => '')).trim()
            const observed = `NOTES box: ${hasNotes}; Order # ${refused ? 'REFUSED by the form' : 'accepted'}; Approve is DISABLED ("${foot}"), so no approve request was sent`
            await caption(page, `Step I7 — FAIL: ${observed}`)
            return { verdict: 'FAIL', observed }
          }
          if (!LOCAL && process.env.E2E_INVOICE_APPROVE !== '1') {
            throw invSkip('not a local server: Approve would create a real Gmail draft wherever the server has a mail target (E2E_INVOICE_APPROVE=1 allows it)')
          }
          const dp = invPath(id(), 'draft-invoice')
          const isApprove = (u) => pathOf(u) === dp && !new URL(u).searchParams.has('dryRun')
          const reqP = page.waitForRequest((r) => r.method() === 'POST' && isApprove(r.url()), { timeout: 30000 })
          const respP = page.waitForResponse((r) => r.request().method() === 'POST' && isApprove(r.url()), { timeout: 150000 })
          await caption(page, 'Step I7 — Approve & Create Draft (locally the server has no mail target: it answers preview only and records nothing)')
          await btn.click()
          const body = bodyOf(await reqP) || {}
          const resp = await respP
          const rj = await resp.json().catch(() => null)
          const hasKey = Object.prototype.hasOwnProperty.call(body, 'notes')
          const ok = hasKey && body.notes === note7 && body.orderNumber === INV_ORDER
          const pt = rj?.invoicePdfBase64 ? await pdfText(rj.invoicePdfBase64) : null
          approved = { status: resp.status(), preview: rj?.preview === true }
          info = `POST draft-invoice → ${resp.status()}${rj?.code ? ` ${rj.code}` : ''}; response keys: ${Object.keys(rj || {}).sort().join(', ') || '—'}; preview ${rj?.preview === true}` +
            `${rj?.note ? `; note "${String(rj.note).slice(0, 100)}"` : ''}${rj?.error ? `; error "${String(rj.error).slice(0, 140)}"` : ''}; ` +
            `the approve's own PDF prints the note: ${pt ? notesAfterLabel(pt, 1).after[0] === note7 : 'no PDF in the response'}`
          const observed = `approve request body: notes ${hasKey ? (body.notes === note7 ? 'present, exactly as typed' : `present but ${JSON.stringify(String(body.notes).slice(0, 60))}`) : 'ABSENT'}; ` +
            `orderNumber ${JSON.stringify(body.orderNumber)}; confirms accepted: ${dialogs.join(', ') || 'none'}`
          await page.waitForTimeout(1500)
          await caption(page, `Step I7 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
      // I7r: what the load dialog SAYS about that approve. A server with no mail
      // target (every local run: boot-server.sh blanks Gmail and the n8n webhook)
      // answers 200 with preview:true and creates no draft, so the message must not
      // send anyone to Gmail for one. Scored only then; a real draft is INFO.
      if (info) {
        await step('I7r', 'After the approve: its response, and the message under the load\'s title in the load dialog',
          'When the response is preview:true (no mail target; locally always): the message does NOT say "Draft ready in Gmail" and says no Gmail draft was created. ' +
          'Any other response: INFO', 'i7r-approve-message', async () => {
            await draftResultMsg(page).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
            // A build from before the class existed: the innermost element carrying
            // the old wording, so a BEFORE baseline reports what it said.
            const msg = (await draftResultMsg(page).count())
              ? draftResultMsg(page).first()
              : page.locator('[role="dialog"] div', { hasText: /Draft ready in Gmail|Gmail draft/ }).last()
            const text = (await msg.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
            if (text) await msg.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {})
            const saysReady = /Draft ready in Gmail/i.test(text)
            const saysNone = /no Gmail draft was created/i.test(text)
            const observed = `${info}; the dialog's message: ${text ? `"${text.slice(0, 220)}"` : 'NONE shown'}` +
              `${text ? `; says "Draft ready in Gmail": ${saysReady}; says no Gmail draft was created: ${saysNone}` : ''}`
            if (!approved?.preview) {
              await caption(page, `Step I7r — INFO: the approve made a real draft (or failed), so there is nothing to score: ${text ? `"${text.slice(0, 120)}"` : 'no message'}`)
              return { verdict: 'INFO', observed }
            }
            const ok = !!text && !saysReady && saysNone
            await caption(page, `Step I7r — ${verdict(ok)}: preview:true, and the dialog says ${text ? `"${text.slice(0, 140)}"` : 'nothing'}`)
            return { verdict: verdict(ok), observed }
          })
      }
      await step('I7j', 'Job Tracking row after the edits and the approve, read again with GET /api/load/<id>',
        'Identical to I1\'s read: the editor wrote nothing to Job Tracking', 'i7j-job-tracking', async () => {
          if (!S.jtBefore) throw invSkip('no Job Tracking row was read in I1')
          const jt = await api(page, 'GET', `/api/load/${encodeURIComponent(S.cand.raw)}`)
          const after = jt.json?.load || null
          const keys = [...new Set([...Object.keys(S.jtBefore), ...Object.keys(after || {})])]
          const changed = keys.filter((k) => JSON.stringify(S.jtBefore[k] ?? null) !== JSON.stringify(after?.[k] ?? null))
          const ok = jt.status === 200 && !!after && changed.length === 0
          const observed = `GET /api/load/${id()} → ${jt.status}; ${keys.length} field(s) compared with I1's read: ${changed.length ? `CHANGED ${changed.join(', ')}` : 'identical'}`
          await caption(page, `Step I7 — ${verdict(ok)}: ${observed}`)
          return { verdict: verdict(ok), observed }
        })
    }

    // ---- I8: a note saved on the approved draft record pre-fills the next editor
    if (wantInv('I8')) {
      const note8 = `QA-I8 saved note ${stamp} & <kept>\nSecond line ${EM_DASH} after a reload`
      let i8b = null
      let i8h = null
      await step('I8', 'Planted, local only: a saved note on this load\'s newest draft record; reload the page and open the editor again',
        'NOTES is pre-filled with the saved note exactly, and the dryRun\'s own PDF already prints it under "Notes"', 'i8-notes-prefilled', async () => {
          if (!DB_PATH) throw invSkip('no DB_PATH (the saved note is planted in the copy, so I8 runs locally only)')
          const cand = S.cand || S.list[0]
          if (!cand) throw invSkip('no delivered/completed load with a POD to open')
          const cols = db.prepare('PRAGMA table_info(load_invoice_drafts)').all().map((c) => c.name)
          const hasCol = cols.includes('notes')
          let plantedId = null
          if (hasCol) {
            const inv = `QA-I8-${stamp}`
            plantedId = Number(db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, via, created_by, notes) VALUES (?, ?, '', 'qa-e2e', 'qa-e2e', ?)").run(cand.id, inv, note8).lastInsertRowid)
            noteCreated('load_invoice_drafts', plantedId)
            // The server must read this file: its newest-draft read returns the planted row.
            const g = await api(page, 'GET', invPath(cand.id, 'invoice-draft'))
            if (g.json?.draft?.invoice_id !== inv) {
              cleanNotes.push(...removeCreated().map((n) => `I8 ${n}`))
              throw invSkip('DB_PATH is not the server\'s database (GET …/invoice-draft does not return the planted row); nothing is left planted')
            }
          }
          await caption(page, hasCol ? `Step I8 — draft record #${plantedId} planted with a two-line note; reload the page` : 'Step I8 — this build\'s draft records have no notes column; reload the page anyway')
          const o = await openInvoiceEditor(page, cand, 'Step I8', 'reload')
          if (!o.ok) throw new Error(`the dryRun answered ${o.err}`)
          S.open = true; S.cand = S.cand || cand
          const box = (await notesBox(page).count()) ? await notesBox(page).inputValue() : null
          // Read now, with the pre-filled note untouched; I8h then types into the box.
          const hintShown = await carriedHint(page).isVisible().catch(() => false)
          const echoed = o.json?.notes
          const pt = o.json?.invoicePdfBase64 ? await pdfText(o.json.invoicePdfBase64) : null
          const want = note8.split('\n')
          const nl = pt ? notesAfterLabel(pt, want.length) : null
          const pdfOk = !!nl && nl.label && JSON.stringify(nl.after) === JSON.stringify(want)
          const ok = hasCol && box === note8 && echoed === note8 && pdfOk
          const observed = hasCol
            ? `planted load_invoice_drafts #${plantedId} (the server returns it as the newest draft); after the reload: NOTES pre-filled exactly: ${box === note8}` +
              `${box !== null && box !== note8 ? ` (holds ${JSON.stringify(box.slice(0, 60))})` : box === null ? ' (no NOTES box)' : ''}; the dryRun echoes it: ${echoed === note8}; ` +
              `the dryRun PDF: ${pt ? `"Notes" label ${nl.label}, then ${JSON.stringify(nl.after)} (as saved: ${pdfOk})` : 'no PDF (no total derived)'}; ` +
              `the "carried over" hint under NOTES: ${hintShown ? 'shown' : 'not shown'} (scored in I8h)`
            : `load_invoice_drafts has no notes column on this build (nothing to plant); after the reload the editor has ${box === null ? 'no NOTES box' : `a NOTES box holding ${JSON.stringify(box)}`}; ` +
              `the dryRun ${echoed === undefined ? 'has no notes key' : `echoes ${JSON.stringify(echoed)}`}`
          if (pt && nl?.label) await zoomInvoiceOn(page, totalsRow(pt))
          await showField(page, '#idp-notes')
          await caption(page, `Step I8 — ${verdict(ok)}: ${observed}`)
          const s = await shot(page, 'i8-notes-prefilled')
          // I8b, while the saved note is still there: the preview's rule for a body
          // with NO notes key (a tab on a bundle from before Notes sends none) is the
          // approve's rule, the last approved note.
          try {
            const r = await api(page, 'POST', invPath(cand.id, 'invoice-preview'),
              { invoiceId: `QA-I8-${stamp.slice(-6)}`, invoiceDate: dayCT(), total: '100.00', recipientEmail: 'qa-e2e@example.com', orderNumber: '7101850' })
            const p8 = r.json?.invoicePdfBase64 ? await pdfText(r.json.invoicePdfBase64) : null
            const n8 = p8 ? notesAfterLabel(p8, want.length) : null
            const good = r.status === 200 && !!n8 && n8.label && JSON.stringify(n8.after) === JSON.stringify(want)
            i8b = {
              verdict: verdict(good),
              observed: `POST invoice-preview with no notes key → ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}; its PDF: ` +
                `${p8 ? `"Notes" label ${n8.label}${n8.label ? `, then ${JSON.stringify(n8.after)} (the saved note: ${good})` : ''}` : 'none'}` +
                `${hasCol ? '' : ' (this build stores no note to fall back to)'}`,
            }
          } catch (e) { i8b = { verdict: 'FAIL', observed: `error: ${e.message}` } }
          if (db && plantedId) cleanNotes.push(...removeCreated().map((n) => `I8 ${n}`))
          // I8h: the note came from the last approved draft, and the form says so
          // until the dispatcher touches it. Typed at the END of the note, as a
          // person adding a line would; the render it triggers is waited for.
          if (!hasCol || box !== note8) {
            i8h = { verdict: 'SKIP', observed: `SKIPPED — ${hasCol ? 'NOTES was not pre-filled with the saved note (see I8), so nothing was carried over' : 'this build stores no note, so nothing is carried over'}; the hint shows: ${hintShown}`, shot: '' }
          } else {
            try {
              const tail = ' (edited)'
              const pv = expectPreview(page, cand.id, (b) => b.notes === note8 + tail)
              await showField(page, '#idp-notes')
              await caption(page, `Step I8h — the "carried over" hint under NOTES is ${hintShown ? 'shown' : 'NOT shown'}; now type "${tail.trim()}" at the end of the note`)
              await notesBox(page).click()
              await notesBox(page).evaluate((el) => el.setSelectionRange(el.value.length, el.value.length))
              await page.keyboard.type(tail)
              await page.waitForTimeout(1000)
              const goneAfter = !(await carriedHint(page).isVisible().catch(() => false))
              const typedOk = (await notesBox(page).inputValue()) === note8 + tail
              if (!(await orderBlocks(page))) { await pv; await previewSettled(page) }
              const good = hintShown && goneAfter && typedOk
              const obs = `with the pre-filled note untouched the hint ${hintShown ? 'shows' : 'does NOT show'}; after typing at its end ` +
                `(the box now holds the note + "${tail}": ${typedOk}) the hint is ${goneAfter ? 'gone' : 'STILL shown'}`
              await caption(page, `Step I8h — ${verdict(good)}: ${obs}`)
              i8h = { verdict: verdict(good), observed: obs, shot: await shot(page, 'i8h-carried-hint') }
            } catch (e) { i8h = { verdict: 'FAIL', observed: `error: ${e.message}`, shot: await shot(page, 'i8h-carried-hint-error') } }
          }
          return { verdict: verdict(ok), observed, shot: s }
        })
      if (i8b) {
        record({
          step: 'I8b', title: 'Planted, local only: POST invoice-preview with the notes key left out (as a tab on an older bundle sends it), while the saved note is there',
          expected: 'Its PDF prints the saved note under "Notes": the approve\'s rule, the last approved note', observed: i8b.observed, verdict: i8b.verdict, shot: '',
        })
      }
      if (i8h) {
        record({
          step: 'I8h', title: 'Planted, local only: the pre-filled note of I8 is labelled as carried over; then type at its end',
          expected: 'Under NOTES, "Carried over from this load\'s last approved invoice — clear it or use Reset if it no longer applies." shows while the note is untouched, and is gone once you type in the box',
          observed: i8h.observed, verdict: i8h.verdict, shot: i8h.shot,
        })
      }
    }

    // ---- I9: the server's own refusals (the same session, as the page's fetch sends them)
    if (wantInv('I9')) {
      const lid = id() || S.list[0]?.id || 'QA-I9'
      // An Order # every build accepts, so each refusal below is the one field under test.
      const base = { invoiceId: `QA-I9-${stamp.slice(-6)}`, invoiceDate: dayCT(), total: '100.00', recipientEmail: 'qa-e2e@example.com', orderNumber: '7101850', notes: '' }
      const cases = [
        { step: 'I9', title: 'POST invoice-preview, a valid body (the control)', body: base, want: { status: 200 } },
        { step: 'I9a', title: `POST invoice-preview with notes of ${INV_NOTES_MAX + 1} characters`, body: { ...base, notes: 'n'.repeat(INV_NOTES_MAX + 1) }, want: { status: 400, code: 'INVOICE_NOTES_TOO_LONG' } },
        { step: 'I9b', title: 'POST invoice-preview with notes: ["x"] (not text)', body: { ...base, notes: ['x'] }, want: { status: 400, code: 'INVOICE_NOTES_INVALID' } },
        { step: 'I9c', title: 'POST invoice-preview with orderNumber "a<b"', body: { ...base, orderNumber: 'a<b' }, want: { status: 400, code: 'ORDER_NUMBER_INVALID' } },
      ]
      const summary = []
      for (const c of cases) {
        let observed = ''; let v = 'FAIL'
        try {
          const r = await api(page, 'POST', invPath(lid, 'invoice-preview'), c.body)
          v = verdict(r.status === c.want.status && (!c.want.code || r.json?.code === c.want.code))
          observed = `→ ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}${r.json?.field ? ` (field ${r.json.field})` : ''}` +
            `${r.status !== 200 && r.json?.error ? ` "${String(r.json.error).slice(0, 160)}"` : ''}${r.status === 200 ? `; PDF rendered: ${!!r.json?.invoicePdfBase64}` : ''}`
        } catch (e) { observed = `error: ${e.message}` }
        summary.push(`${c.step} ${observed.split(';')[0]}`)
        record({ step: c.step, title: c.title, expected: c.want.code ? `${c.want.status} ${c.want.code}` : `${c.want.status} (so each refusal below is its one field)`, observed: `load ${lid}: ${observed}`, verdict: v, shot: '' })
      }
      await caption(page, `Step I9 — the server's refusals (page fetch, X-Requested-With): ${summary.join(' · ')}`)
      rows[rows.length - 1].shot = await shot(page, 'i9-api-refusals')
      writeResults()
    }
  } finally {
    try { if (db) cleanNotes.push(...removeCreated().map((n) => `I ${n}`)) } catch (e) { cleanNotes.push(`delete error: ${e.message}`) }
    if (DB_PATH) {
      const left = fs.existsSync(JOURNAL)
      record({
        step: 'Ic', title: 'Invoice editor: delete the planted draft record',
        expected: 'Deleted; no plant journal left',
        observed: [...cleanNotes, left ? 'plant journal still present!' : 'no plant journal left'].join('; '),
        verdict: verdict(!left && !cleanNotes.some((n) => /error|LEFT BEHIND/.test(n))), shot: '',
      })
    }
    await ctx.close().catch(() => {})
    if (ownDb && db) { try { db.close() } catch { /* ignore */ } db = null }
  }
}

// ---------------------------------------------------------------- investor terms (T0)
// T0 records what a prospective investor is shown on /invest TODAY, before any
// change to the payment terms: the Master Participation & Management Agreement and
// the Commercial Vehicle Lease, both on the signature page (InvestorSignModal.vue)
// and from the review modal ("Signed — View Document"), for two different test
// investors. Every document is the stateless preview PDF of
// POST /api/public/investor-preview-pdf/<docKey>, read with the app's own pdfjs-dist.
//
// No sign-in (the page is public and redirects a signed-in user), so each investor
// gets a FRESH anonymous context. Identities are fake: "QA-TEST Investor A|B <stamp>",
// a QA-TEST address, an example.com email, all-zero EIN and bank numbers.
// ⚠️ The application is never submitted. Besides not pressing the button, every
// request from these pages that is not a GET, the preview route or the read-only
// W-9 check (TERMS_READ_ONLY_POSTS) is aborted in the browser (T0l records any that
// was attempted, and lists the read-only checks apart as non-writes).
//
// How the PDF is read: the page reads each preview with `res.blob()`, and Chromium
// keeps no copy of a body read that way, so `Response.body()` answers empty. The
// preview request is therefore passed through a route: `route.fetch()` sends the
// page's own request (method, headers, body, cookies) to the server, the harness
// keeps the bytes, and `route.fulfill()` hands the page that exact response.
//
// Budget: the preview route allows 30 renders per 15 minutes per IP. Each investor
// makes 8 (open ×3, the re-render after each signature ×3, the review ×2), so one
// run makes 16: a second run against the same server within 15 minutes runs out.
const TERMS_DOCS = {
  master_agreement: 'Master Participation & Management Agreement',
  vehicle_lease: 'Commercial Vehicle Lease Agreement',
  w9: 'W-9 Tax Form',
}
const TERMS_EXPECTED = 'default 50/50 terms, no AMENDMENT, identical for A and B'
const TERMS_PREVIEW = '/api/public/investor-preview-pdf/'
// The POSTs /invest sends that write nothing, so the anonymous pages let them through
// and list them apart from the writes they abort. POST /api/public/investor-w9-check:
// step 1's Continue and each W-9 signature ask whether the W-9 can print the typed
// text (the application's own lib/w9-input.js check); it stores, renders and sends
// nothing, and answers 200 { ok: true } or the 400 the application would get.
const TERMS_READ_ONLY_POSTS = new Set(['/api/public/investor-w9-check'])
const isReadOnlyPost = (req, p) => req.method() === 'POST' && TERMS_READ_ONLY_POSTS.has(p)
// Records the answer to each read-only POST a page sends, into `into`
// ({ what, status }), for T0l and Tm.
function watchReadOnlyPosts(page, into) {
  page.on('response', (r) => {
    const p = pathOf(r.url())
    if (isReadOnlyPost(r.request(), p)) into.push({ what: `${r.request().method()} ${p}`, status: String(r.status()) })
  })
  page.on('requestfailed', (r) => {
    const p = pathOf(r.url())
    if (isReadOnlyPost(r, p)) into.push({ what: `${r.method()} ${p}`, status: `no answer (${r.failure()?.errorText || 'failed'})` })
  })
}
// "POST /api/public/investor-w9-check → 200 ×2", per page tag.
function readOnlyTally(entries) {
  const m = new Map()
  for (const { who, what, status } of entries) {
    const k = `${who} ${what} → ${status}`
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m].map(([k, n]) => `${k} ×${n}`).join(', ')
}
const flatText = (pt) => String(pt?.text || '').replace(/\s+/g, ' ').trim()
// The text between two anchors (the second searched after the first), whitespace
// collapsed; '' when either is missing.
function between(flat, from, to) {
  const i = flat.indexOf(from)
  if (i < 0) return ''
  const j = flat.indexOf(to, i + from.length)
  return j < 0 ? '' : flat.slice(i, j).trim()
}
const countOf = (hay, needle) => {
  if (!needle) return 0
  let n = 0; let i = hay.indexOf(needle)
  while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length) }
  return n
}
// Images painted in a PDF, with the same pdfjs-dist as pdfText (loaded by it). The
// renderer REPLACES the signer's signature slot with the drawn image, so the typed
// name is never printed there: a signed copy shows its signature as extra images.
async function pdfImageCount(b64) {
  if (!b64 || !pdfjsLib) return null
  const { OPS } = pdfjsLib
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter((x) => x != null))
  const task = pdfjsLib.getDocument({ data: new Uint8Array(Buffer.from(b64, 'base64')), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  let n = 0
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const ops = await (await doc.getPage(i)).getOperatorList()
      for (const fn of ops.fnArray) if (paint.has(fn)) n++
    }
  } finally { await task.destroy().catch(() => {}) }
  return n
}
// What T0 reads off one preview PDF.
function termsFacts(pt, typedName) {
  const flat = flatText(pt)
  const squeezed = flat.replace(/\s+/g, '')
  return {
    split5050: flat.includes('distributed according to a 50/50 split'),
    participant50: flat.includes('Participant Distribution (50%)'),
    lease5050: flat.includes('50/50 profit participation model'),
    amendment: flat.includes('AMENDMENT'), // case-sensitive: the boilerplate "amendment(s)" is not it
    s33: between(flat, '3.3 Revenue Participation', '3.4 Settlement Cycle'),
    s201: between(flat, '2.01 Lease Payments', '2.02'),
    nameCount: countOf(squeezed, String(typedName || '').replace(/\s+/g, '')),
    pages: pt?.pages ?? 0,
  }
}

// The /invest walk-through a person makes (InvestorApplyView.vue), shared by T0 and
// T3-T11. All data is fake: a QA-TEST name, address and example.com email, all-zero
// EIN and bank numbers.
const investTgt = (page, name) => page.locator(`[data-wizard-target="${name}"]`)
const investField = (page, label) => page.locator('.step-panel .field', { has: page.locator('label', { hasText: exactText(label) }) }).locator('input, select').first()
const investPauseBlur = async (page) => { await page.keyboard.press('Tab'); await page.waitForTimeout(350) }
// The guided wizard opens itself ~1.2 s after load; close it as a person would.
async function closeInvestGuide(page) {
  try {
    const closeGuide = page.locator('.wizard-panel button[aria-label="Close guide"]')
    await closeGuide.waitFor({ state: 'visible', timeout: 5000 })
    await closeGuide.click()
  } catch { /* it did not open: nothing to close */ }
}
// Step 1 of 3: the application. The name is both the legal name and the contact. A
// field an invite link pre-filled and locked is left as it is. Returns the legal name
// the form holds.
async function fillInvestApplication(page, { name, letter, idx, email }) {
  const tgt = (n) => investTgt(page, n)
  const field = (l) => investField(page, l)
  const put = async (loc, v) => { if (await loc.isEditable()) await loc.fill(v) }
  const pick = async (loc, v) => { if (await loc.isEnabled()) await loc.selectOption(v) }
  await put(tgt('legal-name'), name)
  await put(tgt('dba'), `QA-TEST DBA ${letter}`)
  await pick(tgt('entity-type'), 'LLC')
  await put(tgt('address'), `${100 + idx} QA-TEST Street, Testville, TX 75001`)
  await put(field('Primary Contact Person'), name)
  await pick(field('Title'), 'Owner')
  await put(tgt('phone'), `(555) 010-01${String(idx).padStart(2, '0')}`)
  await put(tgt('email'), email)
  await put(field('Years in Operation'), '3')
  await pick(field('Industry Experience'), 'Yes')
  await pick(field('Preferred Communication'), 'Email')
  await pick(field('Tax Classification'), 'Individual/LLC')
  await put(tgt('ein-ssn'), `00-000000${idx % 10}`)
  await pick(field('Monthly Reporting Delivery'), 'Digital Portal')
  await investPauseBlur(page)
  return tgt('legal-name').inputValue()
}
// Step 2 of 3: one fake vehicle (the documents are signed separately).
async function fillInvestFleet(page, letter) {
  const tgt = (n) => investTgt(page, n)
  await tgt('fleet-size').waitFor({ state: 'visible' })
  await tgt('fleet-size').fill('1')
  await tgt('vehicle-make').selectOption('Freightliner')
  await tgt('vehicle-model').selectOption('Cascadia')
  await tgt('vehicle-year').fill('2020')
  await tgt('vehicle-vin').fill(`QATEST0000000000${letter}`)
  await investField(page, 'License Plate').fill(`QA-${letter}01`)
  await investField(page, 'Current Mileage').fill('100000')
  await investPauseBlur(page)
}
// In the open signature page: consent, the typed name and a drawn signature, as a
// person signs. Returns the Sign Document button, which must then be enabled.
async function drawInvestSignature(page, docKey, name) {
  await page.locator('.modal-overlay .sign-checkbox input[type="checkbox"]').check()
  await page.locator('.modal-overlay .sign-input').fill(name)
  await investPauseBlur(page) // closes the suggested-names list, which sits over the canvas
  const canvas = page.locator('.modal-overlay .sig-canvas')
  await canvas.scrollIntoViewIfNeeded().catch(() => {})
  const box = await canvas.boundingBox()
  if (!box) throw new Error(`${docKey}: no signature canvas`)
  const pts = [[0.12, 0.62], [0.2, 0.3], [0.28, 0.7], [0.36, 0.35], [0.46, 0.66], [0.56, 0.32], [0.66, 0.6], [0.78, 0.4], [0.88, 0.55]]
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1])
  await page.mouse.down()
  for (const [px, py] of pts.slice(1)) await page.mouse.move(box.x + box.width * px, box.y + box.height * py, { steps: 4 })
  await page.mouse.up()
  const signBtn = page.locator('.modal-overlay .sign-btn')
  if (!(await signBtn.isEnabled())) throw new Error(`${docKey}: Sign Document stayed disabled after consent, name and drawing`)
  return signBtn
}
// Step 3 of 3: fake banking (all zeros).
async function fillInvestBanking(page, name, idx) {
  const tgt = (n) => investTgt(page, n)
  await tgt('bank-name').waitFor({ state: 'visible' })
  await tgt('bank-name').fill('QA-TEST Bank')
  await investPauseBlur(page)
  await page.locator('.step-panel .field', { has: page.locator('label', { hasText: exactText('Account Type') }) }).locator('select').selectOption('Business Checking')
  await page.locator('.step-panel .field', { has: page.locator('label', { hasText: exactText('Name on Account') }) }).locator('input').fill(name)
  await investPauseBlur(page)
  await tgt('routing-number').fill('000000000')
  await tgt('account-number').fill(`0000000000${String(idx).padStart(2, '0')}`)
  await investPauseBlur(page)
}

async function termsInvestor(letter, idx) {
  const out = { letter, name: `QA-TEST Investor ${letter} ${stamp}`, sign: {}, review: {}, keys: [], blocked: [], checks: [], consoleErrors: [], previews: 0, ok: false, error: '' }
  const S = (n) => `t0-${letter.toLowerCase()}-${n}`
  const ctx = await browser.newContext({ viewport: ADMIN_VP })
  ctx.setDefaultTimeout(30000)
  const page = await ctx.newPage()
  // Callers waiting for the next preview of a document (see previewOf below).
  const waiters = []
  const settle = (docKey, value) => {
    const i = waiters.findIndex((w) => w.docKey === docKey)
    if (i >= 0) waiters.splice(i, 1)[0].resolve(value)
  }
  // The safety net: nothing but GETs, the stateless preview route and the read-only
  // W-9 check leaves this page. A preview is passed through, and its bytes kept (see
  // the note at the top of this section).
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = pathOf(req.url())
    if (req.method() === 'POST' && p.startsWith(TERMS_PREVIEW)) {
      const docKey = p.slice(TERMS_PREVIEW.length)
      let resp; let body
      try {
        resp = await route.fetch({ timeout: 90000 })
        body = await resp.body()
      } catch (e) {
        settle(docKey, { status: 0, body: null, why: `the request failed: ${e.message.split('\n')[0]}` })
        return route.abort('failed').catch(() => {})
      }
      settle(docKey, { status: resp.status(), body })
      return route.fulfill({ response: resp, body }).catch(() => {})
    }
    if (req.method() === 'GET' || isReadOnlyPost(req, p)) return route.continue()
    out.blocked.push(`${req.method()} ${p}`)
    return route.abort('blockedbyclient')
  })
  watchReadOnlyPosts(page, out.checks)
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(`console: ${m.text().slice(0, 240)}`) })
  page.on('pageerror', (e) => out.consoleErrors.push(`pageerror: ${String(e.message || e).slice(0, 240)}`))
  page.on('requestfailed', (r) => {
    const p = pathOf(r.url())
    if (p.startsWith('/api/') && !out.blocked.some((b) => b.endsWith(p))) out.consoleErrors.push(`requestfailed: ${r.method()} ${p} (${r.failure()?.errorText || '?'})`)
  })
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !pathOf(r.url()).startsWith(TERMS_PREVIEW)) return
    out.previews++
    let body = null
    try { body = r.postDataJSON() } catch { /* not JSON */ }
    const docKey = pathOf(r.url()).slice(TERMS_PREVIEW.length)
    out.keys.push({
      docKey,
      signed: !!(body && body.signatureText),
      keys: body ? Object.keys(body).sort() : [],
      banking: body?.banking && typeof body.banking === 'object' ? Object.keys(body.banking).sort() : [],
      vehicle: Array.isArray(body?.vehicles) && body.vehicles[0] ? Object.keys(body.vehicles[0]).sort() : [],
    })
  })
  // Resolves with { status, body } of the next preview of `docKey` the page sends.
  // Call it BEFORE the click that sends it.
  const previewOf = (docKey) => new Promise((resolve, reject) => {
    const w = { docKey, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) { waiters.splice(i, 1); reject(new Error(`no ${docKey} preview answered within 90 s`)) }
    }, 95000)
  })
  const readPreview = async (r) => {
    if (r.status !== 200 || !r.body?.length) {
      return { status: r.status, pt: null, why: r.why || (r.body ? r.body.toString('utf8').slice(0, 160) : '(no body)') }
    }
    const b64 = r.body.toString('base64')
    const pt = await pdfText(b64)
    return { status: r.status, pt, images: await pdfImageCount(b64), bytes: r.body.length }
  }
  const tgt = (name) => investTgt(page, name)
  // For the screenshot only: point the page's own PDF viewer (the iframe showing the
  // blob the page made) at the page that carries the clause, with the viewer's
  // #page= open parameter. The document is not touched.
  const CLAUSE = { master_agreement: '3.3 Revenue Participation', vehicle_lease: '2.01 Lease Payments' }
  const showClause = async (frameSel, pt, docKey) => {
    const n = pt?.items.find((it) => it.str.includes(CLAUSE[docKey]))?.page
    if (!n) return 0
    await page.locator(frameSel).evaluate((el, pg) => {
      const base = el.src.split('#')[0]
      el.src = 'about:blank'
      setTimeout(() => { el.src = `${base}#page=${pg}` }, 50)
    }, n)
    await page.waitForTimeout(2500)
    return n
  }

  try {
    // ---- the application (step 1 of 3)
    await page.goto(`${BASE_URL}/invest`)
    await tgt('legal-name').waitFor({ state: 'visible', timeout: 45000 })
    await caption(page, `Step T0 — test investor ${letter}: a fresh anonymous browser opens /invest (not signed in)`)
    await closeInvestGuide(page)
    await fillInvestApplication(page, { name: out.name, letter, idx, email: `qa-test+${stamp.replace(/\D/g, '')}${letter.toLowerCase()}@example.com` })
    await caption(page, `Step T0 — ${letter}: the application filled with fake QA-TEST data; Continue`)
    await shot(page, S('01-application'))
    await tgt('continue-step0').click()

    // ---- fleet & documents (step 2 of 3)
    await fillInvestFleet(page, letter)
    await caption(page, `Step T0 — ${letter}: one fake vehicle; now the documents (step 2 of 3)`)
    await shot(page, S('02-fleet'))

    const signDoc = async (docKey, n) => {
      const docName = TERMS_DOCS[docKey]
      const card = page.locator(`.doc-card[data-wizard-target="doc-${docKey}"]`)
      const [resp] = await Promise.all([previewOf(docKey), card.click()])
      const pv = await readPreview(resp)
      await page.locator('.modal-overlay .pdf-frame').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1200) // let the viewer paint the PDF for the screenshot
      if (docKey !== 'w9') {
        const f = pv.pt ? termsFacts(pv.pt, out.name) : null
        out.sign[docKey] = { ...pv, facts: f && { ...f, images: pv.images } }
        await caption(page, `Step T0 — ${letter}: ${docName}, the SIGNATURE page preview (${pv.status}) — ` +
          (f ? (docKey === 'master_agreement'
            ? `"50/50 split": ${f.split5050}, "Participant Distribution (50%)": ${f.participant50}, AMENDMENT: ${f.amendment}`
            : `"50/50 profit participation model": ${f.lease5050}, AMENDMENT: ${f.amendment}`) : `no PDF: ${pv.why}`))
        out.sign[docKey].shot = await shot(page, S(`${n}-sign-${docKey}`))
        const at = await showClause('.modal-overlay .pdf-frame', pv.pt, docKey)
        if (at) {
          await caption(page, `Step T0 — ${letter}: ${docName}, signature page — the viewer on page ${at}, where "${CLAUSE[docKey]}" is`)
          await shot(page, S(`${n}a-sign-${docKey}-clause`))
        }
      } else {
        await caption(page, `Step T0 — ${letter}: ${docName}, the signature page (${pv.status})`)
        await shot(page, S(`${n}-sign-${docKey}`))
      }
      // Sign it as a person does: consent, typed name, a drawn signature.
      const signBtn = await drawInvestSignature(page, docKey, out.name)
      await caption(page, `Step T0 — ${letter}: ${docName} — consent ticked, name typed, signature drawn; Sign Document`)
      await shot(page, S(`${n}b-signing-${docKey}`))
      const [resp2] = await Promise.all([previewOf(docKey), signBtn.click()])
      await page.locator('.modal-overlay .sign-done').waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(1200)
      await caption(page, `Step T0 — ${letter}: ${docName} signed (the page re-rendered its preview: ${resp2.status})`)
      await shot(page, S(`${n}c-signed-${docKey}`))
      await page.locator('.modal-overlay .modal-close').click()
      await page.locator('.modal-overlay').waitFor({ state: 'hidden', timeout: 10000 })
    }
    await signDoc('master_agreement', '03')
    await signDoc('vehicle_lease', '04')
    await signDoc('w9', '05')
    await caption(page, `Step T0 — ${letter}: all three documents signed; Continue to banking`)
    await shot(page, S('06-all-signed'))
    await tgt('continue-step1').click()

    // ---- banking (step 3 of 3), then the review modal
    await fillInvestBanking(page, out.name, idx)
    await caption(page, `Step T0 — ${letter}: fake banking (all zeros); Review & Complete opens the review — it does not submit`)
    await shot(page, S('07-banking'))
    await tgt('review-open').click()
    await page.locator('.review-modal').waitFor({ state: 'visible' })
    await page.locator('.review-modal .doc-view-link').first().scrollIntoViewIfNeeded().catch(() => {})
    await caption(page, `Step T0 — ${letter}: the REVIEW modal (Documents 3/3 signed). "Confirm & Complete Onboarding" will NOT be pressed`)
    await shot(page, S('08-review'))

    const reviewDoc = async (docKey, n) => {
      const docName = TERMS_DOCS[docKey]
      const link = page.locator('.review-modal .review-item', { has: page.locator('.review-label', { hasText: exactText(docName) }) }).locator('.doc-view-link')
      const [resp] = await Promise.all([previewOf(docKey), link.click()])
      const pv = await readPreview(resp)
      await page.locator('.pdf-viewer-overlay .pdf-viewer-frame').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1200)
      const f = pv.pt ? termsFacts(pv.pt, out.name) : null
      out.review[docKey] = { ...pv, facts: f && { ...f, images: pv.images } }
      await caption(page, `Step T0 — ${letter}: review → "Signed — View Document": ${docName} (${pv.status}) — ` +
        (f ? (docKey === 'master_agreement'
          ? `"50/50 split": ${f.split5050}, "Participant Distribution (50%)": ${f.participant50}, AMENDMENT: ${f.amendment}`
          : `"50/50 profit participation model": ${f.lease5050}, AMENDMENT: ${f.amendment}`) : `no PDF: ${pv.why}`))
      out.review[docKey].shot = await shot(page, S(`${n}-review-${docKey}`))
      const at = await showClause('.pdf-viewer-overlay .pdf-viewer-frame', pv.pt, docKey)
      if (at) {
        await caption(page, `Step T0 — ${letter}: ${docName}, review copy — the viewer on page ${at}, where "${CLAUSE[docKey]}" is`)
        await shot(page, S(`${n}a-review-${docKey}-clause`))
      }
      await page.locator('.pdf-viewer-overlay .review-close').click()
      await page.locator('.pdf-viewer-overlay').waitFor({ state: 'hidden', timeout: 10000 })
    }
    await reviewDoc('master_agreement', '09')
    await reviewDoc('vehicle_lease', '10')
    await caption(page, `Step T0 — ${letter}: done. The application was NOT submitted (the Confirm button was never pressed); closing this browser`)
    await shot(page, S('11-not-submitted'))
    out.ok = true
  } catch (e) {
    out.error = e.message.split('\n')[0]
    await shot(page, S('error'))
  } finally {
    await ctx.close().catch(() => {})
  }
  return out
}

// T0: returns both walk-throughs, whose clauses and body keys T6 compares plain /invest with.
async function termsT0() {
  const facts = (inv, where, docKey) => inv[where][docKey]?.facts || null
  const docRow = (inv, where, docKey, stepId) => {
    const d = inv[where][docKey]
    const f = d?.facts
    const whereText = where === 'sign' ? 'the signature page (InvestorSignModal) preview' : 'the review modal, "Signed — View Document"'
    const title = `Test investor ${inv.letter}: ${TERMS_DOCS[docKey]}, ${whereText}`
    if (!d) {
      return record({ step: stepId, title, expected: TERMS_EXPECTED, observed: `not reached${inv.error ? `: ${inv.error}` : ''}`, verdict: 'FAIL', shot: '' })
    }
    if (!f) {
      return record({ step: stepId, title, expected: TERMS_EXPECTED, observed: `POST ${TERMS_PREVIEW}${docKey} → ${d.status}${d.why ? ` ${d.why}` : ''}; no PDF to read`, verdict: 'FAIL', shot: d.shot || '' })
    }
    const terms = docKey === 'master_agreement' ? (f.split5050 && f.participant50) : f.lease5050
    let nameOk = true; let nameText = ''
    if (where === 'review') {
      // The typed name is the one the investor also gave as legal name and contact,
      // which is where it prints; the signature slot itself carries the drawn image.
      const unsigned = facts(inv, 'sign', docKey)
      const drawn = unsigned?.images != null && f.images != null ? f.images - unsigned.images : null
      nameOk = f.nameCount > 0 && (drawn == null || drawn > 0)
      nameText = `; the signer's typed name "${inv.name}" appears ${f.nameCount}× (as the legal name / contact it was also typed as; ` +
        `the renderer puts the drawn signature, not the typed name, on the signature line: images ${unsigned?.images ?? '?'} unsigned → ${f.images ?? '?'} signed` +
        `${drawn == null ? '' : `, ${drawn > 0 ? `+${drawn}, the drawn signature is embedded` : 'the drawn signature is NOT embedded'}`})`
    }
    const obs = `POST ${TERMS_PREVIEW}${docKey} → 200, ${f.pages} pages; ` +
      (docKey === 'master_agreement'
        ? `"distributed according to a 50/50 split": ${f.split5050}; "Participant Distribution (50%)": ${f.participant50}`
        : `"50/50 profit participation model": ${f.lease5050}`) +
      `; contains AMENDMENT: ${f.amendment}${nameText}`
    return record({ step: stepId, title, expected: TERMS_EXPECTED, observed: obs, verdict: verdict(terms && !f.amendment && nameOk), shot: d.shot || '' })
  }

  const A = await termsInvestor('A', 1)
  docRow(A, 'sign', 'master_agreement', 'T0a')
  docRow(A, 'sign', 'vehicle_lease', 'T0b')
  docRow(A, 'review', 'master_agreement', 'T0c')
  docRow(A, 'review', 'vehicle_lease', 'T0d')
  const B = await termsInvestor('B', 2)
  docRow(B, 'sign', 'master_agreement', 'T0e')
  docRow(B, 'sign', 'vehicle_lease', 'T0f')
  docRow(B, 'review', 'master_agreement', 'T0g')
  docRow(B, 'review', 'vehicle_lease', 'T0h')

  // ---- A vs B: the clause each was shown, on both pages
  const clauseRow = (stepId, title, key, docKey) => {
    const seen = []
    for (const inv of [A, B]) for (const where of ['sign', 'review']) seen.push({ who: `${inv.letter} ${where === 'sign' ? 'signature page' : 'review'}`, text: facts(inv, where, docKey)?.[key] || '' })
    const found = seen.filter((x) => x.text)
    const same = found.length === seen.length && found.every((x) => x.text === found[0].text)
    const obs = `${found.length}/${seen.length} PDFs carry the clause; ${same ? 'all identical' : `DIFFER: ${seen.map((x) => `${x.who} ${x.text.length} chars`).join(', ')}`}` +
      `${found[0] ? `. Wording (${found[0].who}): "${found[0].text}"` : ''}`
    record({ step: stepId, title, expected: TERMS_EXPECTED, observed: obs, verdict: verdict(same), shot: A.review[docKey]?.shot || '' })
  }
  clauseRow('T0i', 'Master §3.3 ("3.3 Revenue Participation" up to "3.4 Settlement Cycle"), whitespace-normalized: A vs B, signature page and review', 's33', 'master_agreement')
  clauseRow('T0j', 'Lease §2.01 ("2.01 Lease Payments" up to "2.02"), whitespace-normalized: A vs B, signature page and review', 's201', 'vehicle_lease')

  // ---- the request body the page sends to the preview route (a later regression check needs it)
  {
    const shapes = new Map()
    for (const inv of [A, B]) {
      for (const k of inv.keys) {
        const sig = `${k.signed ? 'signed' : 'unsigned'}: [${k.keys.join(', ')}]`
        if (!shapes.has(sig)) shapes.set(sig, { docs: new Set(), banking: k.banking.join(', '), vehicle: k.vehicle.join(', ') })
        shapes.get(sig).docs.add(k.docKey)
      }
    }
    const obs = [...shapes.entries()].map(([sig, v]) => `${sig} (docs: ${[...v.docs].join(', ')})`).join(' · ') +
      (shapes.size ? ` · banking: [${[...shapes.values()][0].banking}] · vehicles[0]: [${[...shapes.values()][0].vehicle}]` : '') +
      ` · preview POSTs: A ${A.previews}, B ${B.previews}`
    record({ step: 'T0k', title: 'The JSON body keys /invest sends to POST /api/public/investor-preview-pdf/<docKey> (sorted)', expected: 'Recorded for the later regression check (INFO)', observed: obs || 'no preview request seen', verdict: 'INFO', shot: '' })
  }
  // ---- nothing was submitted; what the browser console said
  // The read-only W-9 check (TERMS_READ_ONLY_POSTS) is let through and listed on its
  // own: it writes nothing, so it is not an attempted write.
  {
    const blocked = [...A.blocked.map((b) => `A ${b}`), ...B.blocked.map((b) => `B ${b}`)]
    const checks = readOnlyTally([...A.checks.map((c) => ({ who: 'A', ...c })), ...B.checks.map((c) => ({ who: 'B', ...c }))])
    record({
      step: 'T0l', title: 'Neither test investor submitted anything: no write left the page but the preview route (the read-only POST /api/public/investor-w9-check is let through and listed as a non-write; anything else is aborted in the browser and listed)',
      expected: 'No attempted write; both walk-throughs completed up to the review without pressing Confirm',
      observed: `A completed: ${A.ok}${A.error ? ` (${A.error})` : ''}; B completed: ${B.ok}${B.error ? ` (${B.error})` : ''}; attempted writes: ${blocked.length ? blocked.join(', ') : 'none'}; ` +
        `read-only checks let through (not writes): ${checks || 'none'}`,
      verdict: verdict(!blocked.length && A.ok && B.ok), shot: '',
    })
    const errs = [...A.consoleErrors.map((e) => `A ${e}`), ...B.consoleErrors.map((e) => `B ${e}`)]
    record({ step: 'T0m', title: 'Browser console errors, page errors and failed API requests on /invest during both walk-throughs', expected: 'None (INFO)', observed: errs.length ? errs.join(' | ') : 'none', verdict: 'INFO', shot: '' })
  }
  return { A, B }
}

// ---------------------------------------------------------------- per-investor payment terms (T1-T11)
// The feature under test (the shared contract): a Super Admin creates a personal
// invite link on /investors carrying custom payment terms, a 50/50 split with extra
// details or a fixed monthly lease. The prospective investor who opens it sees the
// terms read-only and signs contracts carrying them as "AMENDMENT NO. 1". Plain
// /invest keeps today's contract.
//
// Sign-ins: the Super Admin once (every admin step shares that page) and T7's
// throwaway test Investor once. Applicants are anonymous contexts, like T0's: every
// write from those pages but the preview route (and T8's one submit) is aborted in
// the browser, and a successful submit is kept from leaving for logisx.com.
//
// What it writes: the invites T1, T2 and T11 create (revoked at the end unless used),
// T7's throwaway user QA-TEST-INV-<stamp> (deleted), T10's test investor record
// QA-TEST-INV-<stamp>-REC (deleted), and T8's application, only with DB_PATH (local)
// or E2E_TERMS_SUBMIT=1: soft-deleted at the end and, locally, hard-deleted by id.
// An invite token is a credential: the results never print one.
const TD = (name) => `[data-test="${name}"]`
const TDV = (name) => `${TD(name)}:visible`
const INVITES_API = '/api/admin/investor-invites'
const INVITE_LINK_RE = /\/invest\?invite=([A-Za-z0-9_-]{43})$/
const TERMS_DIGITS = stamp.replace(/\D/g, '')
const SPLIT_DETAILS = 'Quarterly review call with owner.'
// T2's details: two lines, the second typed with a right-to-left override (U+202E)
// inside it, which the server drops as a format character before saving.
const LEASE_LINES = ['Fuel card provided by the owner.', 'QA-TEST lease note']
const LEASE_DETAILS_TYPED = `${LEASE_LINES[0]}\n${LEASE_LINES[1].slice(0, 8)}${String.fromCodePoint(0x202E)}${LEASE_LINES[1].slice(8)}`
const BIDI_RE = /\p{Bidi_Control}/u
const TERMS_REVISED_NOTICE = 'LogisX updated the payment terms in your invitation. Please review and sign the agreements again.'
// What T0 recorded on 3b61d14, before the feature (T0k, T0i, T0j). T6 holds plain
// /invest to T0's own record when T0 ran in the same run, and to these otherwise.
const T0_PREVIEW_KEYS = ['address', 'banking', 'bankruptcy_liens', 'contact_person', 'contact_title', 'dba', 'ein_ssn', 'email', 'entity_type',
  'fleet_size', 'industry_experience', 'legal_name', 'phone', 'preferred_communication', 'reporting_preference', 'tax_classification',
  'vehicles', 'years_in_operation']
const T0_PREVIEW_KEYS_SIGNED = [...T0_PREVIEW_KEYS, 'signatureImage', 'signatureText'].sort()
const T0_S33 = '3.3 Revenue Participation and Method of Payment. Upon the final determination of the monthly NOI, the remaining funds ' +
  'shall be distributed according to a 50/50 split: Participant Distribution (50%): Remitted to the Participant as a professional ' +
  'return on the contributed Asset. Managerial Distribution (50%): Retained by the Manager as compensation for comprehensive fleet ' +
  'administration, scaling, and logistics management. Payment Execution (Schedule A): All disbursements shall be issued to the ' +
  'Participant via the electronic payment method and banking instructions designated in the attached Schedule A (Payment & Banking ' +
  'Election Form). The Participant is responsible for maintaining the accuracy of the information in Schedule A to avoid processing delays.'
const T0_S201 = '2.01 Lease Payments and Remittance Structure. The Lessee agrees to pay the Lessor "Rent" as a derivative of the Net ' +
  'Operating Income (NOI) generated by the Vehicle, as defined and governed by the Master Participation & Management Agreement. ' +
  'Variable-Yield Settlement: Disbursements shall be calculated based on the 50/50 profit participation model after all Priority ' +
  'Expenses (Labor, Fuel, Insurance, and Reserves) have been satisfied. Settlement Cycle (Net-60): In alignment with industry ' +
  'receivable aging, all lease payments shall be settled and remitted on the last Friday of the calendar month following the month ' +
  'of production. Method of Payment: Remittance shall be executed via ACH Direct Deposit using the banking coordinates provided by ' +
  'the Lessor in Schedule A (Payment & Banking Election Form).'
// Body keys that would carry payment terms. The preview takes the terms from the
// invite row only, so the page sends the token and none of these.
const TERMS_BODY_KEY_RE = /pay|lease|amount|detail|term|split|amend|revision/i
const TERMS_SUBMIT_OK = !!DB_PATH || process.env.E2E_TERMS_SUBMIT === '1'
// An application this harness made: the applicant's QA-TEST name, or the invitee's
// when an invite pre-filled and locked the legal name.
const QA_APPLICATION_RE = /^QA-TEST Investor [A-Z] \d{8}-\d{6}$|^QA-TEST Invite (Split|Lease|T11) \d{8}-\d{6}$/
const notReached = (why) => Object.assign(new Error(`not reached: ${why}`), { notReached: true })
const squash = (s, n = 240) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// ---- admin side (/investors, the invites panel)
async function gotoInvestorsPage(page) {
  await page.goto(`${BASE_URL}/investors`)
  await page.getByRole('heading', { name: /Investor Database/i }).first().waitFor({ state: 'visible', timeout: 30000 })
}
// The invites panel, or null when the page has none. A closed <details> around it is
// opened by its summary, as a person would.
async function invitesPanel(page, ms = 15000) {
  const panel = page.locator(TD('invites-panel')).first()
  try { await panel.waitFor({ state: 'attached', timeout: ms }) } catch { return null }
  if (!(await panel.isVisible())) {
    const summary = panel.locator('xpath=ancestor::details[1]/summary')
    if (await summary.count()) await summary.first().click().catch(() => {})
    await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  }
  await panel.scrollIntoViewIfNeeded().catch(() => {})
  return panel
}
// The create form (InviteTermsForm). It may sit behind a closed <details> or a
// "New invite" button; both are tried before the name box is waited for.
async function openInviteForm(page, panel) {
  const nameBox = page.locator(TDV('invite-name')).first()
  if (await nameBox.count()) return
  const summary = panel.locator('summary').first()
  if (await summary.count() && await summary.evaluate((s) => s.parentElement?.tagName === 'DETAILS' && !s.parentElement.open)) await summary.click()
  if (await nameBox.count()) return
  let opener = panel.getByRole('button', { name: /(new|create|add)\b.*invit|^\s*\+\s*invit/i }).first()
  if (!(await opener.count())) opener = panel.getByRole('button', { name: /invit/i }).filter({ hasNotText: /revoke|reissue|copy|preview|save/i }).first()
  if (await opener.count()) await opener.click()
  try { await nameBox.waitFor({ state: 'visible', timeout: 8000 }) } catch {
    throw new Error('the invite form did not show: no visible [data-test="invite-name"] after opening the panel (its <details>, then a "New invite"-like button)')
  }
}
// A radio (or checkbox) may be visually hidden behind a styled label: check it as
// the label would. Anything else is clicked.
async function chooseControl(loc) {
  const kind = await loc.evaluate((el) => (el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()))
  if (kind === 'radio' || kind === 'checkbox') return loc.check({ force: true })
  return loc.click()
}
async function fillInviteForm(page, panel, { name, email, type, amount, details }) {
  await openInviteForm(page, panel)
  await page.locator(TDV('invite-name')).first().fill(name)
  await page.locator(TDV('invite-email')).first().fill(email)
  await chooseControl(page.locator(TD(`invite-type-${type}`)).first())
  if (type === 'lease') {
    const amt = page.locator(TD('invite-amount')).first()
    await amt.waitFor({ state: 'visible', timeout: 5000 })
    await amt.fill(amount)
  }
  await page.locator(TDV('invite-details')).first().fill(details)
  await investPauseBlur(page)
}
// Presses Create and waits for the POST; then reads the link dialog. The token is
// kept in memory only.
async function createInviteThroughForm(page) {
  const create = page.locator(TDV('invite-create')).first()
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && pathOf(r.url()) === INVITES_API, { timeout: 20000 }),
    create.click(),
  ])
  let json = null
  try { json = await resp.json() } catch { /* not json */ }
  const out = { status: resp.status(), code: json?.code || '', id: json?.invite?.id ?? null, revision: json?.invite?.termsRevision ?? null, linkValue: '', path: '', token: '', readOnly: false, dialogText: '' }
  const link = page.locator(TDV('invite-link')).first()
  try { await link.waitFor({ state: 'visible', timeout: 10000 }) } catch { return out }
  out.linkValue = await link.inputValue().catch(async () => (await link.textContent()) || '')
  const m = out.linkValue.trim().match(INVITE_LINK_RE)
  if (m) { out.token = m[1]; out.path = `/invest?invite=${m[1]}` }
  out.readOnly = await link.evaluate((el) => el.readOnly === true || el.getAttribute('aria-readonly') === 'true')
  out.dialogText = await link.evaluate((el) => {
    const box = el.closest('[role="dialog"], .modal, .dialog, [class*="dialog"], [class*="modal"]') || el.parentElement
    return (box?.innerText || '').replace(/\s+/g, ' ').trim()
  })
  return out
}
// Closes the link dialog (a Close / Done button, else Escape). True once no link shows.
async function closeInviteDialog(page) {
  const link = page.locator(TDV('invite-link')).first()
  if (!(await link.count())) return true
  const scope = link.locator('xpath=ancestor::*[@role="dialog" or contains(@class,"modal") or contains(@class,"dialog")][1]')
  const within = (await scope.count()) ? scope.first() : page
  const times = String.fromCodePoint(0xD7)
  const btn = within.getByRole('button', { name: new RegExp(`^\\s*(close|done|got it|ok|${times})\\s*$`, 'i') }).first()
  if (await btn.count()) await btn.click().catch(() => {})
  else await page.keyboard.press('Escape')
  await link.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  if (await page.locator(TDV('invite-link')).count()) await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return !(await page.locator(TDV('invite-link')).count())
}
// The panel's row for an invite: the smallest element that holds the needle (its
// name) and a status word, whatever the markup (a table row or a card).
function inviteRowText(panel, needle) {
  return panel.evaluate((root, n) => {
    const STATUS = /\b(Active|Used|Revoked|Expired)\b/i
    let best = null
    for (const el of root.querySelectorAll('*')) {
      const t = el.innerText || ''
      if (!t.includes(n) || !STATUS.test(t)) continue
      if (best === null || t.length < best.length) best = t
    }
    return best
  }, needle).catch(() => null)
}
// The row's text once it matches `re` (the list refreshes after a save, over the
// socket), or its last text after `ms`.
async function waitInviteRow(panel, needle, re, ms = 6000) {
  let text = await inviteRowText(panel, needle)
  for (let waited = 0; !(text && re.test(text)) && waited < ms; waited += 300) {
    await panel.page().waitForTimeout(300)
    text = await inviteRowText(panel, needle)
  }
  return text
}
// GET /api/admin/investor-invites?status=all from the Super Admin's page; null when
// the build has no such list.
async function invitesList(page) {
  const r = await api(page, 'GET', `${INVITES_API}?status=all`)
  return r.status === 200 && Array.isArray(r.json?.invites) ? r.json.invites : null
}
const inviteByEmail = (list, email) => (list || []).find((i) => String(i.inviteeEmail || '').toLowerCase() === email.toLowerCase()) || null
// The inline errors around the invite form: role="alert", error/invalid classes and
// aria-invalid on the amount box; visible, non-empty, and never the lease warning.
async function inviteFormErrors(page) {
  const amount = page.locator(TD('invite-amount')).first()
  if (!(await amount.count())) return { texts: [], ariaInvalid: false }
  return amount.evaluate((el) => {
    let root = el
    while (root.parentElement && !root.querySelector('[data-test="invite-create"], [data-test="invite-save"]')) root = root.parentElement
    const seen = new Set()
    const texts = []
    // Red text counts too (an error styled only by a colour class).
    const red = (n) => {
      const m = getComputedStyle(n).color.match(/\d+(\.\d+)?/g)
      return !!m && Number(m[0]) >= 150 && Number(m[1]) <= 110 && Number(m[2]) <= 110
    }
    const candidates = new Set(root.querySelectorAll('[role="alert"], .error, .invalid, [class*="error"], [class*="invalid"], [class*="danger"], [class*="destructive"], [data-test$="-error"]'))
    for (const n of root.querySelectorAll('p, span, div, small, li')) if (!n.children.length && red(n)) candidates.add(n)
    for (const n of candidates) {
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim()
      if (!t || seen.has(t) || !n.getClientRects().length) continue
      if (/Payouts are still calculated/i.test(t) || /^\*$/.test(t)) continue
      seen.add(t)
      texts.push(t.slice(0, 160))
    }
    return { texts, ariaInvalid: el.getAttribute('aria-invalid') === 'true' }
  })
}
// Marks the button matching `label` in the row that holds `needle` (the closest
// ancestor of a matching button that contains the needle) and clicks it.
async function clickRowButton(page, panel, needle, label) {
  const marked = await panel.evaluate((root, { n, src }) => {
    const re = new RegExp(src, 'i')
    let best = null
    for (const b of root.querySelectorAll('button, [role="button"], a')) {
      if (!re.test(b.innerText || b.getAttribute('aria-label') || '')) continue
      let a = b
      while (a && a !== root && !(a.innerText || '').includes(n)) a = a.parentElement
      if (!a || !(a.innerText || '').includes(n)) continue
      const size = (a.innerText || '').length
      if (!best || size < best.size) best = { b, size }
    }
    if (!best) return false
    best.b.setAttribute('data-qa-e2e-target', '1')
    return true
  }, { n: needle, src: label.source })
  if (!marked) return false
  const btn = page.locator('[data-qa-e2e-target="1"]').first()
  await btn.click()
  await btn.evaluate((el) => el.removeAttribute('data-qa-e2e-target')).catch(() => {})
  return true
}
// Revokes an invite from its row: the Revoke button, then whatever confirmation the
// panel asks for (a native confirm is accepted by the page's dialog handler; an
// in-page one is confirmed, with a reason when it asks for one).
async function revokeThroughPanel(page, panel, needle) {
  let settled = null
  const waiting = page.waitForResponse((r) => r.request().method() === 'POST' && /^\/api\/admin\/investor-invites\/\d+\/revoke$/.test(pathOf(r.url())), { timeout: 20000 })
    .then((r) => { settled = r; return r }, () => null)
  if (!(await clickRowButton(page, panel, needle, /\brevoke\b/))) return { clicked: false, status: 0, code: '' }
  for (let i = 0; i < 12 && !settled; i++) {
    await page.waitForTimeout(250)
    const confirmBox = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, .confirm-dialog:visible, .modal:visible').last()
    if (!(await confirmBox.count())) continue
    const reason = confirmBox.locator('textarea:visible, input[type="text"]:visible').first()
    if (await reason.count()) await reason.fill('QA-TEST e2e').catch(() => {})
    const ok = confirmBox.getByRole('button', { name: /^\s*(revoke|confirm|yes)/i }).last()
    if (await ok.count()) { await ok.click().catch(() => {}); break }
  }
  const resp = await waiting
  let json = null
  try { json = resp ? await resp.json() : null } catch { /* not json */ }
  return { clicked: true, status: resp ? resp.status() : 0, code: json?.code || '', invite: json?.invite || null }
}

// ---- the anonymous applicant's page
// A fresh context on `urlPath` (/invest, or an invite link) with T0's safety net:
// GETs and the read-only W-9 check pass (the check listed apart, as a non-write), a
// preview is passed through with its bytes kept, T8's submit passes only once
// allowSubmit is set, and every other write is aborted and listed.
async function openInvestPortal(tag, urlPath, token = '') {
  const P = { tag, token, keys: [], blocked: [], checks: [], errors: [], inviteGets: [], previewLog: [], allowSubmit: false }
  const ctx = await browser.newContext({ viewport: ADMIN_VP })
  ctx.setDefaultTimeout(30000)
  // After a successful submit the page sends itself to logisx.com (the marketing site) 5 s later.
  await ctx.route((u) => /^(www\.)?logisx\.com$/i.test(u.hostname), (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>e2e</title><p>The e2e harness kept this tab off logisx.com.</p>',
  }))
  const page = await ctx.newPage()
  Object.assign(P, { ctx, page })
  const waiters = []
  const settle = (docKey, value) => {
    const i = waiters.findIndex((w) => w.docKey === docKey)
    if (i >= 0) waiters.splice(i, 1)[0].resolve(value)
  }
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = pathOf(req.url())
    if (req.method() === 'POST' && p.startsWith(TERMS_PREVIEW)) {
      const docKey = p.slice(TERMS_PREVIEW.length)
      let resp; let body
      try {
        resp = await route.fetch({ timeout: 90000 })
        body = await resp.body()
      } catch (e) {
        settle(docKey, { status: 0, body: null, headers: {}, why: `the request failed: ${e.message.split('\n')[0]}` })
        return route.abort('failed').catch(() => {})
      }
      const headers = resp.headers()
      P.previewLog.push({ docKey, status: resp.status(), revision: headers['x-payment-terms-revision'] ?? null })
      settle(docKey, { status: resp.status(), body, headers })
      return route.fulfill({ response: resp, body }).catch(() => {})
    }
    if (req.method() === 'GET' || isReadOnlyPost(req, p)) return route.continue()
    if (P.allowSubmit && req.method() === 'POST' && p === '/api/public/investor-apply') return route.continue()
    P.blocked.push(`${req.method()} ${p}`)
    return route.abort('blockedbyclient')
  })
  watchReadOnlyPosts(page, P.checks)
  page.on('console', (m) => { if (m.type() === 'error') P.errors.push(`console: ${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => P.errors.push(`pageerror: ${String(e.message || e).slice(0, 200)}`))
  page.on('request', (r) => {
    const p = pathOf(r.url())
    if (r.method() === 'GET' && p === '/api/public/investor-invite') {
      P.inviteGets.push({ header: !!token && r.headers()['x-invite-token'] === token, inUrl: !!token && r.url().includes(token) })
      return
    }
    if (r.method() !== 'POST' || !p.startsWith(TERMS_PREVIEW)) return
    let body = null
    try { body = r.postDataJSON() } catch { /* not JSON */ }
    P.keys.push({
      docKey: p.slice(TERMS_PREVIEW.length),
      signed: !!(body && body.signatureText),
      keys: body ? Object.keys(body).sort() : [],
      tokenMatches: !!token && body?.invite_token === token,
    })
  })
  // The next preview of `docKey`; call it BEFORE the click that sends it.
  P.previewOf = (docKey, ms = 90000) => new Promise((resolve, reject) => {
    const w = { docKey, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) { waiters.splice(i, 1); reject(new Error(`no ${docKey} preview answered within ${ms / 1000} s`)) }
    }, ms)
  })
  P.read = async (r) => {
    const revision = r.headers?.['x-payment-terms-revision'] ?? null
    if (r.status !== 200 || !r.body?.length) {
      return { status: r.status, pt: null, flat: '', revision, why: r.why || (r.body ? squash(r.body.toString('utf8'), 160) : '(no body)') }
    }
    const b64 = r.body.toString('base64')
    const pt = await pdfText(b64)
    return { status: r.status, pt, flat: flatText(pt), images: await pdfImageCount(b64), revision, bytes: r.body.length }
  }
  // Opens the page; 'form' when step 1 shows, 'error' when the invite error shows.
  P.start = async () => {
    await page.goto(`${BASE_URL}${urlPath}`)
    const form = investTgt(page, 'legal-name')
    const err = page.locator(TD('invite-error')).first()
    const which = await Promise.race([
      form.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'form', () => ''),
      err.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'error', () => ''),
    ])
    if (which === 'form') await closeInvestGuide(page)
    return which
  }
  // Step 1, then Continue to step 2 (the vehicle is filled separately). Returns the
  // legal name the form holds (an invite may have pre-filled and locked it).
  P.fillToDocuments = async (letter, idx, name) => {
    const held = await fillInvestApplication(page, { name, letter, idx, email: `qa-test+${TERMS_DIGITS}${letter.toLowerCase()}@example.com` })
    await investTgt(page, 'continue-step0').click()
    await investTgt(page, 'fleet-size').waitFor({ state: 'visible' })
    return held
  }
  // A document card: opens the signature page and reads the preview it fetches.
  P.openDoc = async (docKey) => {
    const card = page.locator(`.doc-card[data-wizard-target="doc-${docKey}"]`)
    const [resp] = await Promise.all([P.previewOf(docKey), card.click()])
    const pv = await P.read(resp)
    await page.locator('.modal-overlay .pdf-frame').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)
    return pv
  }
  P.signOpenDoc = async (docKey, name) => {
    const signBtn = await drawInvestSignature(page, docKey, name)
    const [resp] = await Promise.all([P.previewOf(docKey), signBtn.click()])
    await page.locator('.modal-overlay .sign-done').waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(800)
    return P.read(resp)
  }
  P.closeDoc = async () => {
    const close = page.locator('.modal-overlay .modal-close')
    if (await close.count()) await close.click()
    await page.locator('.modal-overlay').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
  }
  P.docSigned = (docKey) => page.locator(`.doc-card[data-wizard-target="doc-${docKey}"]`).evaluate((el) => el.classList.contains('signed')).catch(() => null)
  // Step 3 and the review modal (Review & Complete only opens it).
  P.toReview = async (name, idx) => {
    await investTgt(page, 'continue-step1').click()
    await fillInvestBanking(page, name, idx)
    await investTgt(page, 'review-open').click()
    await page.locator('.review-modal').waitFor({ state: 'visible' })
  }
  // "Signed — View Document" in the review modal; the viewer is closed again after.
  P.reviewDoc = async (docKey) => {
    const link = page.locator('.review-modal .review-item', { has: page.locator('.review-label', { hasText: exactText(TERMS_DOCS[docKey]) }) }).locator('.doc-view-link')
    const [resp] = await Promise.all([P.previewOf(docKey), link.click()])
    const pv = await P.read(resp)
    await page.locator('.pdf-viewer-overlay .pdf-viewer-frame').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)
    return pv
  }
  P.closeReviewDoc = async () => {
    await page.locator('.pdf-viewer-overlay .review-close').click().catch(() => {})
    await page.locator('.pdf-viewer-overlay').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
  }
  P.close = () => ctx.close().catch(() => {})
  return P
}
// A read-only terms card (invite-terms-card, sign-terms, review-terms): whether it
// shows, its text, and how many editable controls it holds.
async function termsBoxFacts(page, name, ms) {
  const loc = page.locator(TDV(name)).first()
  try { await loc.waitFor({ state: 'visible', timeout: ms }) } catch {
    return { visible: false, present: (await page.locator(TD(name)).count()) > 0, text: '', raw: '', editable: 0 }
  }
  return loc.evaluate((el) => ({
    visible: true,
    present: true,
    raw: el.innerText || '',
    text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
    editable: el.querySelectorAll('input, select, textarea, [contenteditable]:not([contenteditable="false"])').length + (el.isContentEditable ? 1 : 0),
  }))
}
const boxText = (f) => (f.visible ? `shown, ${f.editable} editable control(s), text "${squash(f.text, 160)}"` : f.present ? 'present but not visible' : 'absent')
// The keys a preview body carried beyond T0's record, and those that read as terms.
function bodyKeyFacts(k) {
  const base = new Set(T0_PREVIEW_KEYS_SIGNED)
  const extra = (k?.keys || []).filter((x) => !base.has(x))
  return { extra, termsKeys: extra.filter((x) => x !== 'invite_token' && TERMS_BODY_KEY_RE.test(x)), hasToken: extra.includes('invite_token'), tokenMatches: !!k?.tokenMatches }
}

// The detail modal on /investors (Teleported to <body>, position fixed) holding
// `name`, and the read-only terms section inside it.
function investorDetailProbe(page, name) {
  return page.evaluate((n) => {
    const cap = document.getElementById('__qa_caption__')
    let open = false
    for (const el of document.body.children) {
      if (el === cap) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue
      if ((el.innerText || '').includes(n) && el.getBoundingClientRect().height > 0) { open = true; break }
    }
    const t = document.querySelector('[data-test="investor-terms-section"]')
    const termsVisible = !!t && t.getClientRects().length > 0 && getComputedStyle(t).visibility !== 'hidden'
    return {
      open,
      termsVisible,
      termsText: t ? (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      skeleton: !!document.querySelector('.skeleton, [class*="skeleton"]'),
    }
  }, name).catch(() => ({ open: false, termsVisible: false, termsText: '', skeleton: false }))
}
// The Investor Directory row of `name`, paging through when the list is long.
async function findInvestorRow(page, name) {
  const row = page.locator('tr.clickable-row', { has: page.locator('td.name-cell', { hasText: exactText(name) }) }).first()
  if (await row.count()) return row
  const size = page.locator('.pagination .page-size-select').first()
  if (await size.count()) { await size.selectOption('50').catch(() => {}); await page.waitForTimeout(400) }
  for (let i = 0; i < 20 && !(await row.count()); i++) {
    const next = page.locator('.pagination-controls button', { hasText: String.fromCodePoint(0x203A) }).first()
    if (!(await next.count()) || !(await next.isEnabled())) break
    await next.click()
    await page.waitForTimeout(300)
  }
  return (await row.count()) ? row : null
}
// Local only: removes one application this run submitted (and soft-deleted), with its
// three child rows, by exact id; and the signed PDFs the server wrote for it, each
// only when the file on disk is the artifact its row recorded (same sha256).
function hardDeleteTermsApplication(id) {
  const app = db.prepare('SELECT legal_name, deleted_at FROM investor_applications WHERE id = ?').get(id)
  if (!app) return `application #${id}: no row in DB_PATH`
  if (!QA_APPLICATION_RE.test(String(app.legal_name || ''))) return `application #${id}: REFUSED to hard-delete (not a QA-TEST application)`
  if (!app.deleted_at) return `application #${id}: REFUSED to hard-delete (not soft-deleted first)`
  const docs = db.prepare('SELECT doc_key, artifact_sha256 FROM investor_onboarding_documents WHERE application_id = ?').all(id)
  const files = []
  for (const d of docs) {
    const f = path.join(paths.REPO, 'uploads', 'investor-onboarding-signed', `${d.doc_key}-inv-${id}-signed.pdf`)
    if (!d.artifact_sha256 || !fs.existsSync(f) || fs.lstatSync(f).isSymbolicLink()) continue
    if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === d.artifact_sha256) { fs.unlinkSync(f); files.push(d.doc_key) }
  }
  const n = db.transaction(() => ({
    documents: db.prepare('DELETE FROM investor_onboarding_documents WHERE application_id = ?').run(id).changes,
    onboarding: db.prepare('DELETE FROM investor_onboarding WHERE application_id = ?').run(id).changes,
    banking: db.prepare('DELETE FROM investor_payment_info WHERE application_id = ?').run(id).changes,
    application: db.prepare('DELETE FROM investor_applications WHERE id = ?').run(id).changes,
  }))()
  return `application #${id} hard-deleted from DB_PATH (rows: application ${n.application}, documents ${n.documents}, onboarding ${n.onboarding}, banking ${n.banking}; ` +
    `signed PDFs removed from this checkout's uploads/: ${files.length ? files.join(', ') : 'none found here'})`
}

async function termsSection() {
  const t0 = TERMS_PLAN.has('T0') ? await termsT0() : null
  if (TERMS_NEEDS_LOGIN) await termsFeature(t0)
}

async function termsFeature(t0) {
  const want = (id) => TERMS_PLAN.has(id)
  const ownDb = !db
  if (!db && DB_PATH) db = openDb()
  const S = {
    admin: null, adminCtx: null, adminErr: '', panelMissing: false,
    split: null, lease: null, t11: null, // { id, name, email, path, token, revision }
    splitPortal: null, leasePortal: null, leaseReady: false, leaseMasterImages: null, portals: [],
    leaseName: `QA-TEST Investor L ${stamp}`,
    appIds: [], user: null, record: null,
  }
  const adminPage = () => S.admin
  const needAdmin = () => { if (!S.admin) throw notReached(`the Super Admin is not signed in (${S.adminErr})`) }
  // One row per call: its own try/catch, an error screenshot, and a watchdog.
  const step = async (id, title, expected, pageOf, shotName, fn, limitMs = 180000) => {
    let observed = ''; let v = 'FAIL'; let s = ''
    let timer
    try {
      const r = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the step did not finish within ${limitMs / 1000} s`)), limitMs) })])
      observed = r.observed; v = r.verdict
      s = r.shot ?? (pageOf() ? await shot(pageOf(), shotName) : '')
    } catch (e) {
      observed = e.skip || e.notReached ? e.message : `error: ${e.message.split('\n')[0]}`
      v = e.skip ? 'SKIP' : 'FAIL'
      if (!e.skip && !e.notReached && pageOf()) s = await shot(pageOf(), `${shotName}-error`)
    } finally { clearTimeout(timer) }
    record({ step: id, title, expected, observed, verdict: v, shot: s })
  }
  // A walk that feeds several rows: it runs once (with a watchdog), then each row is
  // judged from what it gathered. A walk that never started records ONE row.
  const walk = async (R, pageOf, shotName, fn, limitMs = 300000) => {
    if (R.notStarted) return
    let timer
    try {
      await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the walk-through did not finish within ${limitMs / 1000} s`)), limitMs) })])
    } catch (e) {
      R.err = e.notReached ? e.message : `error: ${e.message.split('\n')[0]}`
      if (!e.notReached && pageOf()) R.errShot = await shot(pageOf(), `${shotName}-error`)
    } finally { clearTimeout(timer) }
  }
  const walkRow = (R, id, title, expected, key, judge) => {
    const x = R[key]
    if (x === undefined) {
      return record({ step: id, title, expected, observed: R.err ? `${R.err.startsWith('not reached') ? '' : 'not reached — '}${R.err}` : 'not reached', verdict: 'FAIL', shot: R.errShot || '' })
    }
    const { ok, observed, info } = judge(x)
    record({ step: id, title, expected, observed, verdict: info ? 'INFO' : verdict(ok), shot: x?.shot || '' })
  }
  const notStartedRow = (id, title, expected, why) => record({ step: id, title, expected, observed: `not reached: ${why}`, verdict: 'FAIL', shot: '' })
  const pdfSays = (pv, list) => list.map(([label, s, want]) => `${want ? '' : 'no '}"${label || s}": ${pv.flat.includes(s) === want ? 'yes' : 'NO'}`).join('; ')
  const pdfOk = (pv, list) => pv.status === 200 && list.every(([, s, want]) => pv.flat.includes(s) === want)
  const pvHead = (pv, docKey) => `POST ${TERMS_PREVIEW}${docKey} → ${pv.status}${pv.why ? ` ${pv.why}` : ''}${pv.revision != null ? `, X-Payment-Terms-Revision ${pv.revision}` : ''}${pv.pt ? `, ${pv.pt.pages} pages` : ''}`

  if (!CREDS.superAdmin) {
    S.adminErr = 'the creds file has no superAdmin login'
  } else {
    try {
      const fp = await freshPage(ADMIN_VP)
      S.adminCtx = fp.ctx
      fp.ctx.setDefaultTimeout(30000)
      fp.page.on('dialog', (d) => { (d.type() === 'prompt' ? d.accept('QA-TEST e2e') : d.accept()).catch(() => {}) })
      await login(fp.page, 'Step T1 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      S.admin = fp.page
    } catch (e) { S.adminErr = `sign-in failed: ${e.message.split('\n')[0]}` }
  }

  try {
    // ================= T1: the split invite
    if (want('T1')) {
      await step('T1', 'Super Admin, /investors: a SPLIT invite through the invites panel (name, email, split, details "Quarterly review call with owner."), Create',
        'POST 201; a dialog whose invite-link value ends /invest?invite=<43 base64url characters>; the panel lists it as Active with a 50/50 summary',
        adminPage, 't1-split-invite', async () => {
          needAdmin()
          await gotoInvestorsPage(S.admin)
          const panel = await invitesPanel(S.admin)
          if (!panel) { S.panelMissing = true; throw new Error('/investors has no invites panel ([data-test="invites-panel"] never appeared in 15 s)') }
          const name = `QA-TEST Invite Split ${stamp}`
          const email = `qa-test+${TERMS_DIGITS}@example.com`
          await caption(S.admin, 'Step T1 — Super Admin: a SPLIT invite with details, through the invites panel')
          await fillInviteForm(S.admin, panel, { name, email, type: 'split', details: SPLIT_DETAILS })
          await shot(S.admin, 't1-a-form')
          const c = await createInviteThroughForm(S.admin)
          S.split = { id: c.id, name, email, path: c.path, token: c.token, revision: c.revision }
          await caption(S.admin, `Step T1 — POST → ${c.status}; the link dialog ${c.linkValue ? 'shows the link (the token is not printed in the results)' : 'did NOT show'}`)
          const dialogShot = await shot(S.admin, 't1-b-link-dialog')
          const closed = await closeInviteDialog(S.admin)
          const apiRow = inviteByEmail(await invitesList(S.admin), email)
          if (apiRow) { S.split.id = S.split.id ?? apiRow.id; S.split.revision = S.split.revision ?? apiRow.termsRevision }
          const row = await waitInviteRow(panel, name, /\bActive\b/i)
          await caption(S.admin, `Step T1 — the panel's row: ${squash(row || '(none)', 140)}`)
          await shot(S.admin, 't1-c-row')
          const linkOk = INVITE_LINK_RE.test(c.linkValue.trim())
          return {
            verdict: verdict(c.status === 201 && linkOk && !!row && /\bActive\b/i.test(row) && /50\/50/.test(row)),
            shot: dialogShot,
            observed: `POST ${INVITES_API} → ${c.status}${c.code ? ` ${c.code}` : ''}, invite #${S.split.id ?? '?'}; the link dialog: ` +
              (c.linkValue ? `its value ${linkOk ? 'ends' : 'does NOT end'} /invest?invite=<43 base64url characters> (token not printed), read-only ${c.readOnly}, says "once": ${/\bonce\b/i.test(c.dialogText)}` : 'no invite-link shown') +
              `; closed: ${closed}; the panel's row: ${row ? `"${squash(row, 160)}"` : 'none holds the name and a status'}; API status ${apiRow?.status ?? '?'}, summary "${apiRow?.display?.summary ?? '?'}"`,
          }
        })
    }

    // ================= T2: the lease invite ("2,000" refused, then 2000)
    if (want('T2')) {
      await step('T2', 'Super Admin: a LEASE invite. "2,000" first; then 2000, with two-line details whose second line carries U+202E',
        '"2,000": an inline error and nothing saved. Then 201, the link, a row showing Active and $2,000.00; the details saved and shown without any bidirectional control character, both lines kept',
        adminPage, 't2-lease-invite', async () => {
          needAdmin()
          if (S.panelMissing) throw new Error('/investors has no invites panel (see T1)')
          await gotoInvestorsPage(S.admin)
          const panel = await invitesPanel(S.admin)
          if (!panel) { S.panelMissing = true; throw new Error('/investors has no invites panel ([data-test="invites-panel"] never appeared in 15 s)') }
          const name = `QA-TEST Invite Lease ${stamp}`
          const email = `qa-test+${TERMS_DIGITS}-lease@example.com`
          await fillInviteForm(S.admin, panel, { name, email, type: 'lease', amount: '2,000', details: LEASE_DETAILS_TYPED })
          const posts = []
          const onReq = (r) => { if (r.method() === 'POST' && pathOf(r.url()) === INVITES_API) posts.push(r) }
          S.admin.on('request', onReq)
          const create = S.admin.locator(TDV('invite-create')).first()
          const enabled = await create.isEnabled().catch(() => false)
          if (enabled) await create.click()
          await S.admin.waitForTimeout(2000)
          S.admin.off('request', onReq)
          const errs = await inviteFormErrors(S.admin)
          const firstResp = posts.length ? await posts[0].response().catch(() => null) : null
          const warning = await S.admin.getByText('Payouts are still calculated from the Split % column', { exact: false }).first().isVisible().catch(() => false)
          const saved = inviteByEmail(await invitesList(S.admin), email)
          if (saved) S.lease = { id: saved.id, name, email } // the clean-up revokes it
          await caption(S.admin, `Step T2 — "2,000": Create ${enabled ? 'pressed' : 'disabled'}; ${posts.length} POST(s); inline error: ${errs.texts.length ? `"${errs.texts[0]}"` : errs.ariaInvalid ? 'aria-invalid' : 'NONE'}`)
          await shot(S.admin, 't2-a-comma-refused')
          if (await S.admin.locator(TDV('invite-link')).count()) await closeInviteDialog(S.admin)
          await fillInviteForm(S.admin, panel, { name, email, type: 'lease', amount: '2000', details: LEASE_DETAILS_TYPED })
          // What still shows with a valid amount is decoration, not the refusal.
          const calm = await inviteFormErrors(S.admin)
          errs.texts = errs.texts.filter((t) => !calm.texts.includes(t))
          errs.ariaInvalid = errs.ariaInvalid && !calm.ariaInvalid
          const refusedOk = !saved && (errs.texts.length > 0 || errs.ariaInvalid)
          const c = await createInviteThroughForm(S.admin)
          S.lease = { id: c.id ?? S.lease?.id ?? null, name, email, path: c.path, token: c.token, revision: c.revision }
          await caption(S.admin, `Step T2 — 2000: POST → ${c.status}; the link dialog ${c.linkValue ? 'shows the link' : 'did NOT show'}`)
          await shot(S.admin, 't2-b-link-dialog')
          await closeInviteDialog(S.admin)
          const apiRow = inviteByEmail(await invitesList(S.admin), email)
          if (apiRow) { S.lease.id = S.lease.id ?? apiRow.id; S.lease.revision = S.lease.revision ?? apiRow.termsRevision }
          const row = await waitInviteRow(panel, name, /\$2,000\.00/)
          const panelText = await panel.innerText().catch(() => '')
          const details = String(apiRow?.paymentTerms?.details ?? '')
          const detailsOk = !!apiRow && !BIDI_RE.test(details) && details === LEASE_LINES.join('\n')
          await caption(S.admin, `Step T2 — the panel's row: ${squash(row || '(none)', 140)}`)
          const s = await shot(S.admin, 't2-c-row')
          const linkOk = INVITE_LINK_RE.test(c.linkValue.trim())
          return {
            verdict: verdict(refusedOk && c.status === 201 && linkOk && !!row && /\bActive\b/i.test(row) && row.includes('$2,000.00') && detailsOk && !BIDI_RE.test(panelText)),
            shot: s,
            observed: `"2,000": Create ${enabled ? 'enabled and pressed' : 'disabled'}, ${posts.length} POST${firstResp ? ` → ${firstResp.status()}` : ''}; inline error: ${errs.texts.length ? errs.texts.map((t) => `"${t}"`).join(', ') : 'none'}${errs.ariaInvalid ? ' (amount aria-invalid)' : ''}; saved: ${saved ? `YES, invite #${saved.id}` : 'no'}. ` +
              `2000: POST → ${c.status}${c.code ? ` ${c.code}` : ''}, invite #${S.lease.id ?? '?'}, link ${linkOk ? 'shown and matching' : 'NOT shown or not matching'}; the lease warning shown: ${warning}; ` +
              `the panel's row: ${row ? `"${squash(row, 160)}"` : 'none'}; saved details ${apiRow ? `${JSON.stringify(details)} (bidirectional control: ${BIDI_RE.test(details)}; both lines, in order: ${details === LEASE_LINES.join('\n')})` : 'unread (no API row)'}; ` +
              `the panel's text: bidirectional control ${BIDI_RE.test(panelText)}, second line shown ${panelText.includes(LEASE_LINES[1])}`,
          }
        })
    }

    // ================= T3: the split link, anonymous
    if (want('T3')) {
      const R = {}
      if (!S.split?.path) R.notStarted = 'T1 made no split invite link'
      await walk(R, () => S.splitPortal?.page, 't3', async () => {
        const P = await openInvestPortal('t3', S.split.path, S.split.token)
        S.splitPortal = P
        S.portals.push(P)
        const opened = await P.start()
        if (opened !== 'form') throw new Error(`the split link did not show the application (${opened === 'error' ? `invite-error ${await P.page.locator(TD('invite-error')).first().getAttribute('data-code')}` : 'nothing within 45 s'})`)
        await caption(P.page, 'Step T3 — anonymous: the SPLIT invite link, in a fresh browser')
        await P.fillToDocuments('S', 11, `QA-TEST Investor S ${stamp}`)
        R.card = await termsBoxFacts(P.page, 'invite-terms-card', 8000)
        R.card.url = new URL(P.page.url()).searchParams.has('invite')
        R.card.gets = [...P.inviteGets]
        await P.page.locator(TD('invite-terms-card')).first().scrollIntoViewIfNeeded().catch(() => {})
        await caption(P.page, `Step T3 — step 2: the terms card is ${boxText(R.card)}`)
        R.card.shot = await shot(P.page, 't3-a-card')
        await fillInvestFleet(P.page, 'S')
        const pv = await P.openDoc('master_agreement')
        await caption(P.page, `Step T3 — the master agreement preview (${pv.status}): "AMENDMENT NO. 1" ${pv.flat.includes('AMENDMENT NO. 1')}, "50/50 profit split" ${pv.flat.includes('50/50 profit split')}`)
        R.master = { ...pv, shot: await shot(P.page, 't3-b-master') }
        R.body = { k: P.keys.find((k) => k.docKey === 'master_agreement') || null, shot: R.master.shot }
        await P.closeDoc()
      })
      if (R.notStarted) notStartedRow('T3', 'Anonymous: the split invite link', 'The terms card, the amendment in the master PDF, a body with the token only', R.notStarted)
      else {
        walkRow(R, 'T3a', 'Anonymous, the split link, step 2: the read-only terms card (invite-terms-card)',
          'Shows "50/50" and the details; no input, select, textarea or contenteditable inside it', 'card', (c) => ({
            ok: c.visible && c.editable === 0 && c.text.includes('50/50') && c.text.includes(SPLIT_DETAILS),
            observed: `invite-terms-card ${boxText(c)}; "50/50" ${c.text.includes('50/50')}, the details ${c.text.includes(SPLIT_DETAILS)}; the URL keeps ?invite=: ${c.url}; ` +
              `GET /api/public/investor-invite ×${c.gets.length}${c.gets.length ? ` (token in X-Invite-Token: ${c.gets.every((g) => g.header)}, in the URL: ${c.gets.some((g) => g.inUrl)})` : ''}`,
          }))
        const SPLIT_PDF = [['', 'AMENDMENT NO. 1', true], ['the details', SPLIT_DETAILS, true], ['', '50/50 profit split', true], ['', 'Fixed monthly lease payment', false]]
        walkRow(R, 'T3b', 'Anonymous, the split link: the master agreement preview on the signature page',
          'Contains "AMENDMENT NO. 1", the details and "50/50 profit split"; not "Fixed monthly lease payment"', 'master', (pv) => ({
            ok: pdfOk(pv, SPLIT_PDF),
            observed: `${pvHead(pv, 'master_agreement')}; ${pv.pt ? pdfSays(pv, SPLIT_PDF) : 'no PDF to read'}`,
          }))
        walkRow(R, 'T3c', 'Anonymous, the split link: the body the page sends to the preview route',
          'Carries invite_token (the link\'s own) and no terms keys (payment type, amount, details, revision)', 'body', ({ k }) => {
            const f = bodyKeyFacts(k)
            return {
              ok: !!k && f.hasToken && f.tokenMatches && !f.termsKeys.length,
              observed: k ? `keys beyond T0's record: [${f.extra.join(', ')}]; invite_token is the link's: ${f.tokenMatches}; terms keys: ${f.termsKeys.length ? `[${f.termsKeys.join(', ')}]` : 'none'}` : 'no master_agreement preview request seen',
            }
          })
      }
    }

    // ================= T4 + T5: the lease link, anonymous, signed and reviewed
    if (want('T4')) {
      const R = {}
      if (!S.lease?.path) R.notStarted = 'T2 made no lease invite link'
      await walk(R, () => S.leasePortal?.page, 't4', async () => {
        const P = await openInvestPortal('t4', S.lease.path, S.lease.token)
        S.leasePortal = P
        S.portals.push(P)
        const opened = await P.start()
        if (opened !== 'form') throw new Error(`the lease link did not show the application (${opened === 'error' ? `invite-error ${await P.page.locator(TD('invite-error')).first().getAttribute('data-code')}` : 'nothing within 45 s'})`)
        await caption(P.page, 'Step T4 — anonymous: the LEASE invite link, in a fresh browser')
        S.leaseName = (await P.fillToDocuments('L', 12, S.leaseName)) || S.leaseName
        const card = await termsBoxFacts(P.page, 'invite-terms-card', 8000)
        await caption(P.page, `Step T4 — step 2: the terms card is ${boxText(card)}`)
        await shot(P.page, 't4-a-card')
        await fillInvestFleet(P.page, 'L')
        const master = await P.openDoc('master_agreement')
        const signMaster = await termsBoxFacts(P.page, 'sign-terms', 5000)
        await caption(P.page, `Step T4 — master agreement, signature page (${master.status}): "$2,000.00" ${master.flat.includes('$2,000.00')}; sign-terms ${boxText(signMaster)}`)
        R.master = { ...master, shot: await shot(P.page, 't4-b-master') }
        S.leaseMasterImages = master.images ?? null
        await P.signOpenDoc('master_agreement', S.leaseName)
        await P.closeDoc()
        const lease = await P.openDoc('vehicle_lease')
        const signLease = await termsBoxFacts(P.page, 'sign-terms', 5000)
        await caption(P.page, `Step T4 — vehicle lease, signature page (${lease.status}): "Fixed Monthly Lease Payment" ${lease.flat.includes('Fixed Monthly Lease Payment')}; sign-terms ${boxText(signLease)}`)
        R.lease = { ...lease, shot: await shot(P.page, 't4-c-lease') }
        await P.signOpenDoc('vehicle_lease', S.leaseName)
        await P.closeDoc()
        await P.openDoc('w9')
        const signW9 = await termsBoxFacts(P.page, 'sign-terms', 1500)
        await P.signOpenDoc('w9', S.leaseName)
        await P.closeDoc()
        R.cards = { card, signMaster, signLease, signW9, shot: R.master.shot }
        if (!want('T5')) return
        R.signed = { master: await P.docSigned('master_agreement'), lease: await P.docSigned('vehicle_lease'), w9: await P.docSigned('w9') }
        await P.toReview(S.leaseName, 12)
        const reviewTerms = await termsBoxFacts(P.page, 'review-terms', 5000)
        await P.page.locator(TD('review-terms')).first().scrollIntoViewIfNeeded().catch(() => {})
        await caption(P.page, `Step T5 — the review modal: review-terms ${boxText(reviewTerms)}`)
        R.review = { ...reviewTerms, signed: R.signed, shot: await shot(P.page, 't5-a-review') }
        const rm = await P.reviewDoc('master_agreement')
        await caption(P.page, `Step T5 — review → the signed master agreement (${rm.status}): "$2,000.00" ${rm.flat.includes('$2,000.00')}, images ${rm.images ?? '?'} (unsigned ${S.leaseMasterImages ?? '?'})`)
        R.reviewMaster = { ...rm, shot: await shot(P.page, 't5-b-review-master') }
        await P.closeReviewDoc()
        S.leaseReady = await P.page.locator('.review-modal').isVisible().catch(() => false)
      })
      if (R.notStarted) {
        notStartedRow('T4', 'Anonymous: the lease invite link', 'Read-only terms; $2,000.00 in the master and the lease', R.notStarted)
        if (want('T5')) notStartedRow('T5', 'Anonymous: the lease application signed and reviewed', 'review-terms read-only; the signed master shows $2,000.00', R.notStarted)
      } else {
        walkRow(R, 'T4a', 'Anonymous, the lease link: the terms card on step 2 and sign-terms on the master and lease signature pages',
          'All read-only (no input, select, textarea or contenteditable) and showing $2,000.00; the card\'s details carry no bidirectional control character; no sign-terms on the W-9', 'cards', (x) => {
            const ro = (f) => f.visible && f.editable === 0 && f.text.includes('$2,000.00')
            return {
              ok: ro(x.card) && !BIDI_RE.test(x.card.raw) && ro(x.signMaster) && ro(x.signLease) && !x.signW9.visible,
              observed: `invite-terms-card ${boxText(x.card)} (bidirectional control: ${BIDI_RE.test(x.card.raw)}, second details line ${x.card.text.includes(LEASE_LINES[1])}); ` +
                `sign-terms on the master: ${boxText(x.signMaster)}; on the lease: ${boxText(x.signLease)}; on the W-9: ${boxText(x.signW9)}`,
            }
          })
        const MASTER_LEASE = [['', '$2,000.00', true], ['', 'fixed monthly lease payment', true], ['', 'distributed according to a 50/50 split', false]]
        walkRow(R, 'T4b', 'Anonymous, the lease link: the master agreement preview on the signature page',
          'Contains "$2,000.00" and "fixed monthly lease payment"; not "distributed according to a 50/50 split"', 'master', (pv) => ({
            ok: pdfOk(pv, MASTER_LEASE),
            observed: `${pvHead(pv, 'master_agreement')}; ${pv.pt ? `${pdfSays(pv, MASTER_LEASE)}; "AMENDMENT NO. 1": ${pv.flat.includes('AMENDMENT NO. 1')}; both details lines: ${LEASE_LINES.every((l) => pv.flat.includes(l))}; bidirectional control: ${BIDI_RE.test(pv.pt.text)}` : 'no PDF to read'}`,
          }))
        const LEASE_LEASE = [['', '$2,000.00', true], ['', 'Fixed Monthly Lease Payment', true], ['', 'Disbursements shall be calculated based on the 50/50 profit participation model', false]]
        walkRow(R, 'T4c', 'Anonymous, the lease link: the vehicle lease preview on the signature page',
          'Contains "$2,000.00" and "Fixed Monthly Lease Payment"; not "Disbursements shall be calculated based on the 50/50 profit participation model"', 'lease', (pv) => ({
            ok: pdfOk(pv, LEASE_LEASE),
            observed: `${pvHead(pv, 'vehicle_lease')}; ${pv.pt ? `${pdfSays(pv, LEASE_LEASE)}; "AMENDMENT NO. 1": ${pv.flat.includes('AMENDMENT NO. 1')}` : 'no PDF to read'}`,
          }))
        if (want('T5')) {
          walkRow(R, 'T5a', 'Anonymous, the lease link: all three documents signed; the review modal\'s terms (review-terms)',
            '3/3 signed; review-terms shown, read-only, with $2,000.00', 'review', (x) => ({
              ok: x.signed.master && x.signed.lease && x.signed.w9 && x.visible && x.editable === 0 && x.text.includes('$2,000.00'),
              observed: `signed: master ${x.signed.master}, lease ${x.signed.lease}, W-9 ${x.signed.w9}; review-terms ${boxText(x)}`,
            }))
          walkRow(R, 'T5b', 'Anonymous, the lease link: review → "Signed — View Document", the master agreement',
            'Contains "$2,000.00" and the drawn signature is embedded (more images than the unsigned copy)', 'reviewMaster', (pv) => {
              const drawn = pv.images != null && S.leaseMasterImages != null ? pv.images - S.leaseMasterImages : null
              return {
                ok: pv.status === 200 && pv.flat.includes('$2,000.00') && drawn != null && drawn > 0,
                observed: `${pvHead(pv, 'master_agreement')}; "$2,000.00": ${pv.flat.includes('$2,000.00')}; images ${S.leaseMasterImages ?? '?'} unsigned → ${pv.images ?? '?'} signed${drawn == null ? '' : drawn > 0 ? ` (+${drawn}: the drawn signature is embedded)` : ' (the drawn signature is NOT embedded)'}`,
              }
            })
        }
      }
    }

    // ================= T6: plain /invest is today's contract
    if (want('T6')) {
      const R = {}
      const ref = {
        from: t0?.A?.sign?.master_agreement?.facts ? 'T0 in this run' : 'T0 on 3b61d14 (its recorded T0i, T0j, T0k)',
        s33: t0?.A?.sign?.master_agreement?.facts?.s33 || T0_S33,
        s201: t0?.A?.sign?.vehicle_lease?.facts?.s201 || T0_S201,
        unsigned: t0?.A?.keys?.find((k) => !k.signed)?.keys || T0_PREVIEW_KEYS,
        signed: t0?.A?.keys?.find((k) => k.signed)?.keys || T0_PREVIEW_KEYS_SIGNED,
      }
      let P6 = null
      await walk(R, () => P6?.page, 't6', async () => {
        P6 = await openInvestPortal('t6', '/invest')
        S.portals.push(P6)
        if (await P6.start() !== 'form') throw new Error('/invest did not show the application within 45 s')
        const name = `QA-TEST Investor N ${stamp}`
        await caption(P6.page, 'Step T6 — anonymous: plain /invest, no invite')
        await P6.fillToDocuments('N', 14, name)
        await fillInvestFleet(P6.page, 'N')
        await P6.page.waitForTimeout(1500)
        R.plain = {
          card: await termsBoxFacts(P6.page, 'invite-terms-card', 300),
          errors: await P6.page.locator(TD('invite-error')).count(),
          gets: P6.inviteGets.length,
        }
        await caption(P6.page, `Step T6 — step 2 of plain /invest: invite-terms-card ${boxText(R.plain.card)}; GET /api/public/investor-invite ×${R.plain.gets}`)
        R.plain.shot = await shot(P6.page, 't6-a-plain')
        const m = await P6.openDoc('master_agreement')
        await caption(P6.page, `Step T6 — plain /invest, the master agreement (${m.status}): "50/50 split" ${m.flat.includes('distributed according to a 50/50 split')}, AMENDMENT ${m.flat.includes('AMENDMENT')}`)
        R.master = { ...m, shot: await shot(P6.page, 't6-b-master') }
        await P6.signOpenDoc('master_agreement', name)
        await P6.closeDoc()
        const l = await P6.openDoc('vehicle_lease')
        await caption(P6.page, `Step T6 — plain /invest, the vehicle lease (${l.status}): "50/50 profit participation model" ${l.flat.includes('50/50 profit participation model')}, AMENDMENT ${l.flat.includes('AMENDMENT')}`)
        R.lease = { ...l, shot: await shot(P6.page, 't6-c-lease') }
        await P6.closeDoc()
        R.keys = { list: [...P6.keys] }
      })
      walkRow(R, 'T6a', 'Plain /invest (no invite), step 2: no invite UI and no invite request',
        'No invite-terms-card, no invite-error, no GET /api/public/investor-invite', 'plain', (x) => ({
          ok: !x.card.present && !x.errors && !x.gets,
          observed: `invite-terms-card ${boxText(x.card)}; invite-error elements: ${x.errors}; GET /api/public/investor-invite ×${x.gets}`,
        }))
      const PLAIN_MASTER = [['', 'distributed according to a 50/50 split', true], ['', 'Participant Distribution (50%)', true], ['', 'AMENDMENT', false]]
      walkRow(R, 'T6b', 'Plain /invest: the master agreement preview; §3.3 as T0 recorded it',
        `Contains "distributed according to a 50/50 split" and "Participant Distribution (50%)"; no "AMENDMENT"; §3.3 ("3.3 Revenue Participation" up to "3.4 Settlement Cycle") equal to ${ref.from}`, 'master', (pv) => {
          const s33 = between(pv.flat, '3.3 Revenue Participation', '3.4 Settlement Cycle')
          return {
            ok: pdfOk(pv, PLAIN_MASTER) && s33 === ref.s33,
            observed: `${pvHead(pv, 'master_agreement')}; ${pv.pt ? `${pdfSays(pv, PLAIN_MASTER)}; §3.3 ${s33 === ref.s33 ? `equal to ${ref.from} (${s33.length} characters)` : `DIFFERS from ${ref.from}: "${squash(s33, 400)}"`}` : 'no PDF to read'}`,
          }
        })
      const PLAIN_LEASE = [['', '50/50 profit participation model', true], ['', 'AMENDMENT', false]]
      walkRow(R, 'T6c', 'Plain /invest: the vehicle lease preview; §2.01 as T0 recorded it',
        `Contains "50/50 profit participation model"; no "AMENDMENT"; §2.01 ("2.01 Lease Payments" up to "2.02") equal to ${ref.from}`, 'lease', (pv) => {
          const s201 = between(pv.flat, '2.01 Lease Payments', '2.02')
          return {
            ok: pdfOk(pv, PLAIN_LEASE) && s201 === ref.s201,
            observed: `${pvHead(pv, 'vehicle_lease')}; ${pv.pt ? `${pdfSays(pv, PLAIN_LEASE)}; §2.01 ${s201 === ref.s201 ? `equal to ${ref.from} (${s201.length} characters)` : `DIFFERS from ${ref.from}: "${squash(s201, 400)}"`}` : 'no PDF to read'}`,
          }
        })
      walkRow(R, 'T6d', 'Plain /invest: the JSON body keys sent to the preview route (sorted), unsigned and signed',
        `Exactly ${ref.from}: unsigned [${T0_PREVIEW_KEYS.join(', ')}]; signed the same plus signatureImage, signatureText`, 'keys', ({ list }) => {
          const unsigned = list.filter((k) => !k.signed)
          const signed = list.filter((k) => k.signed)
          const uOk = unsigned.length > 0 && unsigned.every((k) => sameList(k.keys, ref.unsigned))
          const sOk = signed.length > 0 && signed.every((k) => sameList(k.keys, ref.signed))
          const diff = (k, want) => {
            const extra = k.keys.filter((x) => !want.includes(x))
            const missing = want.filter((x) => !k.keys.includes(x))
            return `${k.docKey}${k.signed ? ' signed' : ''}: ${extra.length ? `extra [${extra.join(', ')}]` : ''}${missing.length ? ` missing [${missing.join(', ')}]` : ''}`
          }
          const bad = [...unsigned.filter((k) => !sameList(k.keys, ref.unsigned)).map((k) => diff(k, ref.unsigned)), ...signed.filter((k) => !sameList(k.keys, ref.signed)).map((k) => diff(k, ref.signed))]
          return {
            ok: uOk && sOk,
            observed: `${unsigned.length} unsigned and ${signed.length} signed preview bodies; ${bad.length ? `DIFFER — ${bad.join('; ')}` : `all equal to ${ref.from}`}`,
          }
        })
      if (P6) await P6.close()
    }

    // ================= T7: terms cannot be changed through the API
    if (want('T7')) {
      const R = {}
      let invPage = null; let invCtx = null
      await walk(R, () => invPage, 't7', async () => {
        needAdmin()
        const username = `QA-TEST-INV-${stamp}`
        const password = crypto.randomBytes(18).toString('base64url') // in memory only
        const cr = await api(S.admin, 'POST', '/api/users', { username, password, role: 'Investor', fullName: username, email: `qa-test+${TERMS_DIGITS}-inv@example.com` })
        const u = ((await api(S.admin, 'GET', '/api/users')).json?.users || []).find((x) => x.Username === username)
        if (u) { S.user = { id: u.id, username }; meta.ids.termsUser = u.id }
        if (cr.status !== 200 || !u) throw new Error(`POST /api/users (a test Investor) → ${cr.status}${u ? '' : '; the account is not listed'}`)
        const fp = await freshPage(ADMIN_VP)
        invCtx = fp.ctx
        invPage = fp.page
        await login(invPage, 'Step T7 — the throwaway test Investor', username, password, '/investor')
        await caption(invPage, `Step T7 — signed in as the throwaway test Investor (user #${u.id}); every check below is a page fetch from this session`)
        const cfg = `/api/investor/config?ownerId=${u.id}`
        const before = await api(invPage, 'GET', cfg)
        const put = await api(invPage, 'PUT', cfg, { investor_split_pct: '99' })
        const after = await api(invPage, 'GET', cfg)
        R.config = { before, put, after, shot: await shot(invPage, 't7-a-investor') }
        R.post = await api(invPage, 'POST', INVITES_API, { inviteeName: `QA-TEST Invite T7 ${stamp}`, inviteeEmail: `qa-test+${TERMS_DIGITS}-t7@example.com`, paymentType: 'lease', leaseAmount: '1', details: '' })
        const target = S.lease?.id ?? S.split?.id ?? null
        R.put = { target, r: await api(invPage, 'PUT', `${INVITES_API}/${target ?? 1}`, { inviteeName: 'QA-TEST Invite T7', inviteeEmail: `qa-test+${TERMS_DIGITS}-t7@example.com`, paymentType: 'lease', leaseAmount: '1', details: '', expectedRevision: S.lease?.revision ?? 1 }) }
        if (R.post.status === 201 && R.post.json?.invite?.id) S.t7Stray = R.post.json.invite.id
        await invCtx.close().catch(() => {})
        invPage = null
        // The anonymous preview with terms in its body (a fresh, cookie-less context).
        if (S.lease?.token) {
          const anon = await browser.newContext()
          try {
            const body = {
              legal_name: `QA-TEST Investor T ${stamp}`, dba: 'QA-TEST DBA T', entity_type: 'LLC', address: '107 QA-TEST Street, Testville, TX 75001',
              contact_person: `QA-TEST Investor T ${stamp}`, contact_title: 'Owner', phone: '(555) 010-0107', email: `qa-test+${TERMS_DIGITS}t@example.com`,
              ein_ssn: '00-0000007', years_in_operation: '3', fleet_size: '1',
              vehicles: [{ year: '2020', make: 'Freightliner', model: 'Cascadia', vin: 'QATEST0000000000T' }],
              banking: { bank_name: 'QA-TEST Bank', account_type: 'Business Checking', routing_number: '000000000', account_number: '000000000007', account_name: 'QA-TEST' },
              invite_token: S.lease.token,
              payment_type: 'split', lease_amount: '1',
              paymentType: 'split', leaseAmount: '1', details: 'QA-TEST injected terms', amendment_details: 'QA-TEST injected terms',
            }
            const resp = await anon.request.post(`${BASE_URL}${TERMS_PREVIEW}master_agreement`, { data: body, timeout: 90000 })
            const buf = await resp.body()
            const headers = resp.headers()
            const status = resp.status()
            let pt = null
            if (status === 200 && /pdf/i.test(headers['content-type'] || '')) pt = await pdfText(buf.toString('base64'))
            R.anon = { status, revision: headers['x-payment-terms-revision'] ?? null, flat: flatText(pt), pt, why: pt ? '' : squash(buf.toString('utf8'), 160), sent: Object.keys(body).filter((k) => TERMS_BODY_KEY_RE.test(k)) }
          } finally { await anon.close().catch(() => {}) }
        }
        const globals = await api(S.admin, 'GET', '/api/investor/config')
        // A body that writes nothing new even where the route still accepts it: the
        // global value as read.
        const saBody = globals.json && globals.json.investor_split_pct != null ? { investor_split_pct: String(globals.json.investor_split_pct) } : {}
        R.sa = { r: await api(S.admin, 'PUT', '/api/investor/config', saBody), sent: Object.keys(saBody) }
        await caption(S.admin, `Step T7 — Super Admin: PUT /api/investor/config with no ownerId → ${R.sa.r.status} ${R.sa.r.json?.code || ''}`)
        R.sa.shot = await shot(S.admin, 't7-e-super-admin')
        const del = await api(S.admin, 'DELETE', `/api/users/${u.id}`)
        if (del.status === 200) S.user.deleted = true
        R.del = del
      })
      if (!R.config && R.err) notStartedRow('T7', 'Terms cannot be changed through the API', 'Refused (403 / 400) and nothing changes', R.err.replace(/^not reached: /, ''))
      else {
        walkRow(R, 'T7a', 'A test Investor: PUT /api/investor/config?ownerId=<own id> {"investor_split_pct":"99"}, then GET',
          '403; the GET before and after agree', 'config', ({ before, put, after }) => ({
            ok: put.status === 403 && before.status === 200 && after.status === 200 && before.json?.investor_split_pct === after.json?.investor_split_pct,
            observed: `GET → ${before.status} (investor_split_pct ${JSON.stringify(before.json?.investor_split_pct)}); PUT → ${put.status}${put.json?.code ? ` ${put.json.code}` : ''}; GET → ${after.status} (investor_split_pct ${JSON.stringify(after.json?.investor_split_pct)})`,
          }))
        walkRow(R, 'T7b', `A test Investor: POST ${INVITES_API}`, '403', 'post', (r) => ({
          ok: r.status === 403,
          observed: `→ ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}${r.status === 201 ? ` (an invite was CREATED: #${r.json?.invite?.id}, revoked at clean-up)` : ''}`,
        }))
        walkRow(R, 'T7c', `A test Investor: PUT ${INVITES_API}/<the lease invite>`, '403', 'put', ({ target, r }) => ({
          ok: r.status === 403,
          observed: `PUT ${INVITES_API}/${target ?? '1 (no invite was made: T2 FAILed)'} → ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}`,
        }))
        if (!S.lease?.token) notStartedRow('T7d', 'Anonymous preview with the lease token and terms in the body', 'The PDF still shows $2,000.00', 'T2 made no lease invite link')
        else {
          walkRow(R, 'T7d', 'Anonymous (no cookies): POST the master preview with the lease token plus payment_type "split", lease_amount "1" (and the camelCase spellings, and details)',
            'The PDF still shows $2,000.00 (the invite\'s terms); nothing of the body\'s terms', 'anon', (x) => ({
              ok: x.status === 200 && x.flat.includes('$2,000.00') && !x.flat.includes('$1.00') && !x.flat.includes('QA-TEST injected terms') && !x.flat.includes('distributed according to a 50/50 split'),
              observed: `→ ${x.status}${x.revision != null ? `, X-Payment-Terms-Revision ${x.revision}` : ''}${x.pt ? `; "$2,000.00": ${x.flat.includes('$2,000.00')}; "$1.00": ${x.flat.includes('$1.00')}; the injected details: ${x.flat.includes('QA-TEST injected terms')}; the 50/50 §3.3: ${x.flat.includes('distributed according to a 50/50 split')}` : `; ${x.why || 'no PDF'}`}; terms keys sent: [${x.sent.join(', ')}]`,
            }))
        }
        walkRow(R, 'T7e', 'Super Admin: PUT /api/investor/config with no ownerId', '400 OWNER_ID_REQUIRED', 'sa', ({ r, sent }) => ({
          ok: r.status === 400 && r.json?.code === 'OWNER_ID_REQUIRED',
          observed: `→ ${r.status}${r.json?.code ? ` ${r.json.code}` : ''} (body: ${sent.length ? `${sent.join(', ')} at its current global value` : 'empty'})`,
        }))
        walkRow(R, 'T7f', 'Super Admin: DELETE /api/users/<the throwaway test Investor>', '200', 'del', (r) => ({
          ok: r.status === 200,
          observed: `DELETE /api/users/${S.user?.id} → ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}${r.json?.removed ? `; investor_config rows removed: ${r.json.removed.investor_config ?? 0}` : ''}`,
        }))
      }
      if (invCtx) await invCtx.close().catch(() => {})
    }

    // ================= T8: the lease application is submitted; the invite is used
    if (want('T8')) {
      if (!TERMS_SUBMIT_OK) {
        record({ step: 'T8', title: 'Submit the lease application; the invite is used', expected: 'Local (DB_PATH) or E2E_TERMS_SUBMIT=1', observed: 'SKIPPED — T8 writes an application: it runs locally with DB_PATH, or with E2E_TERMS_SUBMIT=1', verdict: 'SKIP', shot: '' })
      } else {
        const R = {}
        if (!S.leaseReady || !S.leasePortal) R.notStarted = 'needs T5\'s lease application, all three documents signed, on its review modal'
        await walk(R, () => S.admin, 't8', async () => {
          needAdmin()
          const P = S.leasePortal
          P.allowSubmit = true
          let sentBody = null
          P.page.on('request', (r) => { if (r.method() === 'POST' && pathOf(r.url()) === '/api/public/investor-apply') { try { sentBody = r.postDataJSON() } catch { /* not JSON */ } } })
          await caption(P.page, 'Step T8 — Confirm & Complete Onboarding (the lease application is submitted)')
          const [resp] = await Promise.all([
            P.page.waitForResponse((r) => r.request().method() === 'POST' && pathOf(r.url()) === '/api/public/investor-apply', { timeout: 120000 }),
            P.page.locator('.review-modal [data-wizard-target="submit-confirm"]').click(),
          ])
          let json = null
          try { json = await resp.json() } catch { /* not json */ }
          const appId = json?.applicationId ?? null
          if (appId) { S.appIds.push(Number(appId)); meta.ids.termsApplication = appId }
          await P.page.locator('.success-wrap').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
          await caption(P.page, `Step T8 — POST /api/public/investor-apply → ${resp.status()}; application #${appId ?? '?'}`)
          const portalShot = await shot(P.page, 't8-a-submitted')
          await P.close()
          await gotoInvestorsPage(S.admin)
          const panel = await invitesPanel(S.admin)
          const row = panel ? await waitInviteRow(panel, S.lease.name, /\bUsed\b/i) : null
          const apiRow = inviteByEmail(await invitesList(S.admin), S.lease.email)
          await caption(S.admin, `Step T8 — the invites panel: ${squash(row || '(no row)', 140)}`)
          R.submit = {
            status: resp.status(), code: json?.code || '', appId, row, apiRow, portalShot,
            tokenSent: sentBody?.invite_token === S.lease.token, revisionSent: sentBody?.invite_terms_revision,
            shot: await shot(S.admin, 't8-b-panel-used'),
          }
          const P2 = await openInvestPortal('t8', S.lease.path, S.lease.token)
          S.portals.push(P2)
          await P2.page.goto(`${BASE_URL}${S.lease.path}`)
          const err = P2.page.locator(TD('invite-error')).first()
          const shown = await err.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
          R.reopen = { shown, code: shown ? await err.getAttribute('data-code') : null, form: await investTgt(P2.page, 'legal-name').isVisible().catch(() => false) }
          await caption(P2.page, `Step T8 — the used lease link opened again: invite-error ${shown ? R.reopen.code : 'NOT shown'}`)
          R.reopen.shot = await shot(P2.page, 't8-c-reopen')
          await P2.close()
          // /investor-applications: the terms chip under the lease applicant's name, the
          // row's Actions inside the table's visible box, and the detail's Payment Terms.
          await S.admin.goto(`${BASE_URL}/investor-applications`)
          await S.admin.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 30000 })
          const tr = S.admin.locator('table tbody tr', { has: S.admin.locator('[data-test="application-name"]', { hasText: exactText(S.leaseName) }) }).first()
          const tbl = { heads: (await S.admin.locator('table thead th').allInnerTexts()).map((h) => squash(h)), found: await tr.count() > 0, chips: 0, chip: null, title: null, actionsVisible: false }
          let detail = ''
          if (tbl.found) {
            await tr.scrollIntoViewIfNeeded().catch(() => {})
            const chip = tr.locator('[data-test="application-terms"]')
            tbl.chips = await chip.count()
            if (tbl.chips) {
              tbl.chip = squash(await chip.first().innerText())
              tbl.title = await chip.first().getAttribute('title')
            }
            // View and the status select, both inside the table's scroll box (1400×900).
            tbl.actionsVisible = await tr.evaluate((row) => {
              const box = row.closest('table').parentElement.getBoundingClientRect()
              const select = row.querySelector('[data-test="application-status"]')
              const view = [...row.querySelectorAll('button')].find((b) => /^view$/i.test(b.innerText.trim()))
              if (!select || !view) return false
              return view.getBoundingClientRect().left >= box.left && select.getBoundingClientRect().right <= box.right + 0.5
            })
            await caption(S.admin, `Step T8 — /investor-applications: the chip under the name reads ${tbl.chip == null ? '(no chip)' : `"${tbl.chip}"`}; Actions visible: ${tbl.actionsVisible}`)
            await shot(S.admin, 't8-d-applications')
            await tr.click()
            const dlg = S.admin.locator('[role="dialog"]').filter({ hasText: S.leaseName }).first()
            await dlg.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
            await S.admin.waitForTimeout(1500)
            detail = await dlg.innerText().catch(() => '')
            await dlg.getByText('Payment Terms', { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {})
          }
          const listed = ((await api(S.admin, 'GET', '/api/investor-applications')).json || []).find?.((a) => Number(a.id) === Number(appId))
          const det = appId ? await api(S.admin, 'GET', `/api/investor-applications/${appId}`) : null
          // innerText follows CSS text-transform, and the section titles are upper-cased.
          await caption(S.admin, `Step T8 — the application's detail: "Payment Terms" ${/payment terms/i.test(detail)}, "$2,000.00" ${detail.includes('$2,000.00')}`)
          R.apps = {
            ...tbl, detailSection: /payment terms/i.test(detail), detailAmount: detail.includes('$2,000.00'),
            listSummary: listed?.payment_terms_summary, listTerms: listed?.payment_terms, view: det?.json?.paymentTerms || null,
            shot: await shot(S.admin, 't8-e-application-detail'),
          }
          await S.admin.keyboard.press('Escape').catch(() => {})
          R.locked = await api(S.admin, 'PUT', `${INVITES_API}/${S.lease.id}`, { inviteeName: S.lease.name, inviteeEmail: S.lease.email, paymentType: 'lease', leaseAmount: '2500', details: LEASE_LINES.join('\n'), expectedRevision: S.lease.revision ?? 1 })
        })
        if (R.notStarted) notStartedRow('T8', 'Submit the lease application; the invite is used', 'Submitted; Used; INVITE_USED; the terms on /investor-applications; INVITE_LOCKED', R.notStarted)
        else {
          walkRow(R, 'T8a', 'Anonymous: Confirm & Complete Onboarding on the signed lease application; then the admin invites panel',
            '200 with an application id; the request carries the token and the terms revision; the panel shows the lease invite as Used', 'submit', (x) => ({
              ok: x.status === 200 && !!x.appId && x.tokenSent && x.revisionSent != null && !!x.row && /\bUsed\b/i.test(x.row),
              observed: `POST /api/public/investor-apply → ${x.status}${x.code ? ` ${x.code}` : ''}, application #${x.appId ?? '?'} (recorded for the clean-up); the body's invite_token is the link's: ${x.tokenSent}, invite_terms_revision ${JSON.stringify(x.revisionSent)}; ` +
                `the panel's row: ${x.row ? `"${squash(x.row, 160)}"` : 'none'}; API status ${x.apiRow?.status ?? '?'}, applicationId ${x.apiRow?.applicationId ?? '?'}`,
            }))
          walkRow(R, 'T8b', 'Anonymous: the used lease link opened again', 'invite-error with data-code INVITE_USED; no application form', 'reopen', (x) => ({
            ok: x.shown && x.code === 'INVITE_USED' && !x.form,
            observed: `invite-error ${x.shown ? `shown, data-code ${x.code}` : 'NOT shown'}; the application form shown: ${x.form}`,
          }))
          walkRow(R, 'T8c', 'Super Admin, /investor-applications: the terms chip under the lease applicant\'s name, the row\'s Actions, and the detail\'s Payment Terms',
            'The chip reads "Lease · $2,000.00/mo"; View and the status select are fully visible; the detail shows the lease at $2,000.00', 'apps', (x) => ({
              ok: x.chips === 1 && x.chip === 'Lease · $2,000.00/mo' && x.actionsVisible && x.detailSection && x.detailAmount,
              observed: `columns [${x.heads.join(' | ')}]; the row ${x.found ? `found, ${x.chips} chip(s), "${x.chip ?? '(no chip)'}" (tooltip ${JSON.stringify(x.title)}), Actions visible ${x.actionsVisible}` : 'NOT found'}; the detail: "Payment Terms" ${x.detailSection}, "$2,000.00" ${x.detailAmount}; ` +
                `API: payment_terms_summary ${JSON.stringify(x.listSummary ?? null)}, payment_terms ${JSON.stringify(x.listTerms ?? null)}, paymentTerms ${x.view ? `state ${x.view.state}, type ${x.view.paymentTerms?.type}, leaseAmountCents ${x.view.paymentTerms?.leaseAmountCents}, consistent ${x.view.consistent}` : 'absent'}`,
            }))
          walkRow(R, 'T8d', `Super Admin: PUT ${INVITES_API}/<the used lease invite> (amount 2500)`, '409 INVITE_LOCKED', 'locked', (r) => ({
            ok: r.status === 409 && r.json?.code === 'INVITE_LOCKED',
            observed: `→ ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}`,
          }))
        }
      }
    }

    // ================= T9: a revoke stops the tab mid-flow
    if (want('T9')) {
      let P9 = S.splitPortal
      await step('T9', 'Super Admin revokes the split invite in the panel while an anonymous tab is on step 2 of it; the tab then opens a document',
        'The revoke answers 200; the tab shows invite-error with data-code INVITE_REVOKED', () => P9?.page, 't9-revoked', async () => {
          needAdmin()
          if (!S.split?.path) throw notReached('T1 made no split invite link')
          if (!P9 || P9.page.isClosed()) {
            P9 = await openInvestPortal('t9', S.split.path, S.split.token)
            S.portals.push(P9)
            if (await P9.start() !== 'form') throw new Error('the split link did not show the application')
            await P9.fillToDocuments('S', 11, `QA-TEST Investor S ${stamp}`)
          }
          await caption(P9.page, 'Step T9 — this tab waits on step 2 of the split link while the Super Admin revokes it')
          await gotoInvestorsPage(S.admin)
          const panel = await invitesPanel(S.admin)
          if (!panel) throw new Error('/investors has no invites panel')
          await caption(S.admin, 'Step T9 — Super Admin: Revoke on the split invite\'s row')
          const rv = await revokeThroughPanel(S.admin, panel, S.split.name)
          if (rv.status === 200) S.split.revoked = true
          const row = await waitInviteRow(panel, S.split.name, /\bRevoked\b/i)
          await caption(S.admin, `Step T9 — revoke → ${rv.status || 'no request'}; the row: ${squash(row || '(none)', 120)}`)
          await shot(S.admin, 't9-a-revoked')
          const err = P9.page.locator(TD('invite-error')).first()
          // A page that learns of the revoke by itself may already show the error.
          const early = await err.isVisible().catch(() => false)
          let pv = null
          if (!early) {
            const card = P9.page.locator('.doc-card[data-wizard-target="doc-master_agreement"]')
            const [resp] = await Promise.all([P9.previewOf('master_agreement', 20000).catch(() => null), card.click({ timeout: 5000 }).catch(() => null)])
            pv = resp ? await P9.read(resp) : null
          }
          const shown = await err.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)
          const code = shown ? await err.getAttribute('data-code') : null
          await caption(P9.page, `Step T9 — the next document open: preview ${pv ? pv.status : 'not sent'}; invite-error ${shown ? code : 'NOT shown'}`)
          const s = await shot(P9.page, 't9-b-tab')
          return {
            verdict: verdict(rv.status === 200 && shown && code === 'INVITE_REVOKED'),
            shot: s,
            observed: `the Revoke button ${rv.clicked ? 'found' : 'NOT found'} in the row; POST …/revoke → ${rv.status || 'not sent'}${rv.code ? ` ${rv.code}` : ''}; the row now: ${row ? `"${squash(row, 140)}"` : 'none'}; ` +
              `the tab's next preview: ${early ? 'not needed (the error showed before any document open)' : pv ? `${pv.status}${pv.why ? ` ${pv.why}` : ''}` : 'not sent'}; invite-error ${shown ? `shown, data-code ${code}` : 'NOT shown'}`,
          }
        })
    }

    // ================= T10: the investor detail modal survives a list refresh
    if (want('T10')) {
      await step('T10', 'Super Admin, /investors: a test investor record\'s detail modal while that record is saved elsewhere (PUT /api/investors/<id>, a notes change)',
        'After the save and 2 s: the detail modal and its investor-terms-section still visible', adminPage, 't10-detail-modal', async () => {
          needAdmin()
          await gotoInvestorsPage(S.admin)
          const name = `QA-TEST-INV-${stamp}-REC`
          const acc = S.admin.locator('details.form-accordion').filter({ has: S.admin.locator('summary', { hasText: /Add Investor/i }) }).first()
          const summary = acc.locator('summary').first()
          await summary.waitFor({ state: 'visible', timeout: 15000 })
          if (!(await acc.evaluate((d) => d.open))) await summary.click()
          await field(acc, 'Investor Name *').fill(name)
          await caption(S.admin, 'Step T10 — Add Investor: a test record')
          const [resp] = await Promise.all([
            S.admin.waitForResponse((r) => r.request().method() === 'POST' && pathOf(r.url()) === '/api/investors', { timeout: 15000 }),
            acc.getByRole('button', { name: /^\s*Add Investor\s*$/i }).click(),
          ])
          let id = null
          try { id = (await resp.json())?.id ?? null } catch { /* not json */ }
          if (id == null) id = ((await api(S.admin, 'GET', '/api/investors')).json?.investors || []).find((i) => i.fullName === name)?.id ?? null
          if (id == null) throw new Error(`POST /api/investors → ${resp.status()}, and no record named as the test's is listed`)
          S.record = { id, name }
          meta.ids.termsRecord = id
          await S.admin.waitForTimeout(800)
          const row = await findInvestorRow(S.admin, name)
          if (!row) throw new Error(`record #${id} is not in the Investor Directory`)
          // The name, as a person clicks it: the row's centre is the Split % cell, which
          // keeps its clicks to itself.
          await row.locator('td.name-cell').click()
          await S.admin.waitForTimeout(1200)
          const before = await investorDetailProbe(S.admin, name)
          await caption(S.admin, `Step T10 — the detail modal of record #${id}: open ${before.open}, investor-terms-section ${before.termsVisible ? 'shown' : 'absent'}`)
          await shot(S.admin, 't10-a-open')
          const put = await api(S.admin, 'PUT', `/api/investors/${id}`, { notes: `QA-TEST T10 notes ${stamp}` })
          await S.admin.waitForTimeout(2000)
          const after = await investorDetailProbe(S.admin, name)
          await caption(S.admin, `Step T10 — 2 s after PUT /api/investors/${id} (${put.status}): modal open ${after.open}, investor-terms-section ${after.termsVisible ? 'shown' : 'NOT shown'}`)
          const s = await shot(S.admin, 't10-b-after-refresh')
          await S.admin.keyboard.press('Escape').catch(() => {})
          const del = await api(S.admin, 'DELETE', `/api/investors/${id}`)
          if (del.status === 200) S.record.deleted = true
          return {
            verdict: verdict(put.status === 200 && before.open && after.open && after.termsVisible),
            shot: s,
            observed: `record #${id} added (POST → ${resp.status()}); modal open ${before.open}, terms section ${before.termsVisible ? `"${before.termsText}"` : 'absent'}; ` +
              `PUT /api/investors/${id} → ${put.status}; 2 s later: modal open ${after.open}, terms section ${after.termsVisible ? 'still shown' : 'NOT shown'}, a skeleton on the page ${after.skeleton}; ` +
              `DELETE /api/investors/${id} → ${del.status}`,
          }
        })
    }

    // ================= T11: an edit mid-flow clears the signatures
    if (want('T11')) {
      let P11 = null
      await step('T11', 'Super Admin edits a lease invite\'s amount (1500 → 1750) while an anonymous tab has signed its master agreement; the tab opens the lease',
        'The next preview carries the new revision; the page shows "LogisX updated the payment terms in your invitation. Please review and sign the agreements again." and the master is no longer signed',
        () => P11?.page, 't11-terms-changed', async () => {
          needAdmin()
          const name = `QA-TEST Invite T11 ${stamp}`
          const email = `qa-test+${TERMS_DIGITS}-t11@example.com`
          const details = 'QA-TEST T11 terms.'
          const cr = await api(S.admin, 'POST', INVITES_API, { inviteeName: name, inviteeEmail: email, paymentType: 'lease', leaseAmount: '1500', details })
          const m = String(cr.json?.invitePath || '').match(INVITE_LINK_RE)
          if (cr.json?.invite?.id) S.t11 = { id: cr.json.invite.id, name, email }
          if (cr.status !== 201 || !m) throw new Error(`POST ${INVITES_API} (as the Super Admin) → ${cr.status}${cr.json?.code ? ` ${cr.json.code}` : ''}: no invite to edit mid-flow`)
          Object.assign(S.t11, { path: `/invest?invite=${m[1]}`, token: m[1], revision: cr.json.invite?.termsRevision ?? 1 })
          P11 = await openInvestPortal('t11', S.t11.path, S.t11.token)
          S.portals.push(P11)
          if (await P11.start() !== 'form') throw new Error('the T11 link did not show the application')
          const who = `QA-TEST Investor R ${stamp}`
          await P11.fillToDocuments('R', 13, who)
          await fillInvestFleet(P11.page, 'R')
          const first = await P11.openDoc('master_agreement')
          await P11.signOpenDoc('master_agreement', who)
          await P11.closeDoc()
          const signedBefore = await P11.docSigned('master_agreement')
          await caption(P11.page, `Step T11 — the master agreement signed (preview revision ${first.revision ?? '?'}); now the Super Admin edits the amount`)
          await shot(P11.page, 't11-a-master-signed')
          const put = await api(S.admin, 'PUT', `${INVITES_API}/${S.t11.id}`, { inviteeName: name, inviteeEmail: email, paymentType: 'lease', leaseAmount: '1750', details, expectedRevision: S.t11.revision })
          const newRev = put.json?.invite?.termsRevision ?? null
          const pv = await P11.openDoc('vehicle_lease')
          const notice = P11.page.getByText(TERMS_REVISED_NOTICE, { exact: false }).first()
          const noticeShown = await notice.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)
          const signedAfter = await P11.docSigned('master_agreement')
          await caption(P11.page, `Step T11 — after the edit: the notice ${noticeShown ? 'shown' : 'NOT shown'}; master signed ${signedAfter}`)
          const s = await shot(P11.page, 't11-b-notice')
          return {
            verdict: verdict(put.status === 200 && newRev != null && String(pv.revision) === String(newRev) && noticeShown && signedBefore === true && signedAfter === false),
            shot: s,
            observed: `invite #${S.t11.id} (revision ${S.t11.revision}); master signed ${signedBefore}; PUT (1750, expectedRevision ${S.t11.revision}) → ${put.status}${put.json?.code ? ` ${put.json.code}` : ''}, revision ${newRev ?? '?'}; ` +
              `the lease preview → ${pv.status}, X-Payment-Terms-Revision ${pv.revision ?? 'none'}, "$1,750.00" ${pv.flat.includes('$1,750.00')}; the notice ${noticeShown ? 'shown' : 'NOT shown'}; master signed afterwards ${signedAfter}`,
          }
        })
    }

    // ================= Tm: what the anonymous pages attempted and logged
    // The read-only W-9 check is let through and listed apart: it is not a write.
    if (S.portals.length) {
      const blocked = S.portals.flatMap((P) => P.blocked.map((b) => `${P.tag} ${b}`))
      const checks = readOnlyTally(S.portals.flatMap((P) => P.checks.map((c) => ({ who: P.tag, ...c }))))
      const errs = S.portals.flatMap((P) => P.errors.map((e) => `${P.tag} ${e}`))
      const counts = S.portals.map((P) => `${P.tag} ${P.previewLog.length}`).join(', ')
      record({
        step: 'Tm', title: 'The anonymous pages of T3-T11: writes aborted in the browser (anything but the preview, the read-only W-9 check and T8\'s submit), read-only checks let through, console errors, preview renders',
        expected: 'INFO', verdict: 'INFO', shot: '',
        observed: `aborted writes: ${blocked.length ? blocked.join(', ') : 'none'}; read-only checks let through (not writes): ${checks || 'none'}; ` +
          `console/page errors: ${errs.length ? squash(errs.join(' | '), 900) : 'none'}; preview renders per page: ${counts}`,
      })
    }
  } finally {
    await termsCleanup(S)
    for (const P of S.portals) await P.close()
    await S.adminCtx?.close().catch(() => {})
    if (ownDb) { try { db?.close() } catch { /* ignore */ } db = null }
  }
}

// Tc — always runs: revoke every invite the run made that is still active (and any
// earlier run's QA-TEST invite left active), soft-delete every application it made
// (then hard-delete it by id when local), delete the throwaway user and the test
// investor record. Ids only.
async function termsCleanup(S) {
  const notes = []
  let ok = true
  if (!S.admin) {
    record({ step: 'Tc', title: 'Clean-up: revoke the run\'s invites, delete its application, user and record', expected: 'Everything revoked or deleted', observed: `no Super Admin page (${S.adminErr}): nothing to clean up through the API, and nothing was made`, verdict: S.adminErr.startsWith('sign-in failed') ? 'FAIL' : 'SKIP', shot: '' })
    return
  }
  try {
    const mine = [S.split, S.lease, S.t11].filter(Boolean)
    const list = await invitesList(S.admin)
    if (list) {
      for (const inv of list) {
        const ours = mine.some((m) => (m.id != null && m.id === inv.id) || String(inv.inviteeEmail || '').toLowerCase() === m.email.toLowerCase()) || inv.id === S.t7Stray
        const leftover = !ours && /^QA-TEST Invite /.test(String(inv.inviteeName || '')) && /@example\.com$/i.test(String(inv.inviteeEmail || ''))
        if (!ours && !leftover) continue
        if (inv.status !== 'active') { notes.push(`invite #${inv.id} ${inv.status}`); continue }
        const r = await api(S.admin, 'POST', `${INVITES_API}/${inv.id}/revoke`, { reason: 'QA-TEST e2e clean-up' })
        notes.push(`invite #${inv.id}${leftover ? ' (an earlier run\'s)' : ''} revoked → ${r.status}`)
        if (r.status !== 200) ok = false
      }
    } else if (mine.some((m) => m.id != null)) {
      ok = false
      notes.push('invites were made but the invites list could not be read')
    } else notes.push('no invites list on this build, and no invite was made')
    // Applications: this run's, and any QA-TEST application an earlier run left.
    const apps = await api(S.admin, 'GET', '/api/investor-applications')
    const leftovers = (Array.isArray(apps.json) ? apps.json : [])
      .filter((a) => QA_APPLICATION_RE.test(String(a.legal_name || '')) && !S.appIds.includes(Number(a.id)))
      .map((a) => Number(a.id))
    for (const id of [...S.appIds, ...leftovers]) {
      const d = await api(S.admin, 'DELETE', `/api/investor-applications/${id}`)
      notes.push(`application #${id}${leftovers.includes(id) ? ' (an earlier run\'s)' : ''} soft-deleted → ${d.status}`)
      if (d.status !== 200) ok = false
      if (db) {
        try { notes.push(hardDeleteTermsApplication(id)) } catch (e) { ok = false; notes.push(`application #${id} hard delete error: ${e.message}`) }
      }
    }
    if (S.user && !S.user.deleted) {
      const d = await api(S.admin, 'DELETE', `/api/users/${S.user.id}`)
      notes.push(`user #${S.user.id} deleted → ${d.status}`)
      if (d.status === 200) S.user.deleted = true
      else ok = false
    } else if (S.user) notes.push(`user #${S.user.id} already deleted (T7)`)
    if (S.record && !S.record.deleted) {
      const d = await api(S.admin, 'DELETE', `/api/investors/${S.record.id}`)
      notes.push(`investor record #${S.record.id} deleted → ${d.status}`)
      if (d.status === 200) S.record.deleted = true
      else ok = false
    } else if (S.record) notes.push(`investor record #${S.record.id} already deleted (T10)`)
  } catch (e) {
    ok = false
    notes.push(`error: ${e.message.split('\n')[0]}`)
  }
  record({
    step: 'Tc', title: 'Clean-up (always runs): revoke the run\'s active invites, soft-delete (and locally hard-delete) its applications, delete its user and investor record',
    expected: 'Every step 200; nothing of the run left active', observed: notes.join('; ') || 'nothing to clean up', verdict: verdict(ok), shot: '',
  })
}

// ---------------------------------------------------------------- investor fixes (F1-F14)
// ONLY=investorfixes, LOCAL ONLY (DB_PATH): it plants rows (F3, F10b, F12b), reads what
// an acceptance created (F6), reads an application's bank row (F14), and removes the
// applications again, which the API can only soft-delete.
//
// ⚠️ TEST ACTORS ONLY. The copy holds real investors. Every investor account, investor
// record, truck and application this section touches is one it created, named
// QA-TEST-INV-<stamp>-… (emails qa-test+<stamp>-…@example.com). No real investor is
// signed in as, edited, uploaded for or accepted; the creds file's investor logins are
// not used. Passwords live in memory only; an acceptance's temporary password is never
// written out and is masked in the saved screenshot.
//
// Every "Expected" is the behaviour AFTER the fix: on a build without it the fix rows
// FAIL, which is the recreation. Evidence: the page, the page's own requests (a page
// fetch where a step has no UI), and reads of the copy (ids, statuses and counts only).
//
// Spend per server process: three sign-ins (the Super Admin, QA-TEST investors A and B);
// five public applications (publicFormLimiter allows 10 per 15 minutes); six PDF
// previews on /invest (30 per 15 minutes).
const IFX_TABLES = new Set(['users', 'investors', 'trucks', 'legal_documents', 'investor_applications', 'investor_onboarding_documents', 'investor_config'])
const IFX_ORDER = ['investor_config', 'legal_documents', 'investor_onboarding_documents', 'trucks', 'investors', 'users', 'investor_applications']
function ifxNote(entry) {
  if (!IFX_TABLES.has(entry.table)) throw new Error('table not allowed')
  if (entry.id != null) entry.id = Number(entry.id)
  if (entry.table === 'users') ifxUserIds.add(entry.id)
  if (ifxRows.some((r) => r.table === entry.table && (entry.id != null ? r.id === entry.id : r.owner === entry.owner && r.key === entry.key))) return
  ifxRows.push(entry)
  writeJournal()
}
function ifxForget(table, id) {
  const i = ifxRows.findIndex((r) => r.table === table && r.id === Number(id))
  if (i >= 0) ifxRows.splice(i, 1)
  writeJournal()
}
// Deletes, by exact id (investor_config by owner and key), the rows the section
// recorded, children before parents, and the files those rows name under this
// checkout's uploads/. `pick` narrows it to some of them.
function ifxRemoveRowsSync(pick = () => true) {
  const out = []
  const rank = (t) => IFX_ORDER.indexOf(t)
  const unlinkUpload = (url, dir) => {
    if (!new RegExp(`^/uploads/${dir}/[\\w.-]+$`).test(String(url || ''))) return
    try { fs.unlinkSync(path.join(paths.REPO, url)) } catch { /* already gone */ }
  }
  for (const r of ifxRows.filter(pick).sort((a, b) => rank(a.table) - rank(b.table))) {
    const label = r.table === 'investor_config' ? `investor_config(owner ${r.owner}, ${r.key})` : `${r.table}#${r.id}`
    try {
      let n = 0
      if (r.table === 'investor_config') {
        n = db.prepare('DELETE FROM investor_config WHERE owner_id = ? AND key = ?').run(r.owner, r.key).changes
      } else if (r.table === 'investor_applications') {
        for (const d of db.prepare('SELECT signed_pdf_url FROM investor_onboarding_documents WHERE application_id = ?').all(r.id)) unlinkUpload(d.signed_pdf_url, 'investor-onboarding-signed')
        for (const child of ['investor_onboarding_documents', 'investor_onboarding', 'investor_payment_info']) {
          db.prepare(`DELETE FROM ${child} WHERE application_id = ?`).run(r.id)
        }
        n = db.prepare('DELETE FROM investor_applications WHERE id = ?').run(r.id).changes
      } else if (r.table === 'users') {
        for (const t of ['investor_config', 'investor_payouts', 'investor_payout_history']) db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(r.id)
        n = db.prepare('DELETE FROM users WHERE id = ?').run(r.id).changes
      } else if (r.table === 'legal_documents') {
        const url = db.prepare('SELECT file_url FROM legal_documents WHERE id = ?').get(r.id)?.file_url
        n = db.prepare('DELETE FROM legal_documents WHERE id = ?').run(r.id).changes
        if (n) unlinkUpload(url, 'legal')
      } else {
        n = db.prepare(`DELETE FROM ${r.table} WHERE id = ?`).run(r.id).changes
      }
      out.push(`${label} ${n ? 'deleted in the copy' : 'already gone'}`)
      ifxRows.splice(ifxRows.indexOf(r), 1)
    } catch (e) { out.push(`${label} delete error: ${e.message}`) }
  }
  writeJournal()
  return out
}
// Highest rowid of every table: what this section adds is whatever lies above it.
// Table names come from the schema, never from input.
function ifxMaxRowids() {
  const out = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    try { out[name] = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM "${String(name).replace(/"/g, '""')}"`).get().m } catch { /* WITHOUT ROWID */ }
  }
  return out
}
// A multi-line evidence box, bottom right, for the steps whose proof is a request.
async function evidence(page, lines) {
  try {
    await page.evaluate((ls) => {
      const id = '__qa_evidence__'
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        Object.assign(el.style, {
          position: 'fixed', right: '12px', bottom: '12px', maxWidth: '700px', zIndex: '2147483646',
          background: 'rgba(12,12,20,0.94)', color: '#e5e7eb', padding: '10px 14px', whiteSpace: 'pre-wrap',
          font: '500 13px/1.45 ui-monospace, Menlo, monospace', border: '2px solid #8b5cf6', borderRadius: '8px', pointerEvents: 'none',
        })
        ;(document.body || document.documentElement).appendChild(el)
      }
      el.textContent = ls.join('\n')
    }, lines.map((l) => visible(l)))
  } catch { /* mid-navigation — best effort */ }
}
async function clearEvidence(page) { try { await page.evaluate(() => document.getElementById('__qa_evidence__')?.remove()) } catch { /* ignore */ } }

async function investorFixesSection() {
  if (!LOCAL || !DB_PATH) {
    record({ step: 'F*', title: 'Investor-fixes section', expected: 'Runs on a local server with DB_PATH', observed: 'SKIPPED — local only: it plants rows, reads what acceptances create, and removes applications (their API delete is soft)', verdict: 'SKIP', shot: '' })
    return
  }
  const ownDb = !db
  if (!db) db = openDb()
  const T = Date.now().toString(36)
  const TU = T.toUpperCase()
  const NAME = (k) => `QA-TEST-INV-${TU}-${k}`
  const EMAIL = (k) => `qa-test+${T}-${k.toLowerCase()}@example.com`
  const UNAME = (k) => `qa-test-inv-${T}-${k.toLowerCase()}`
  const BULLET = String.fromCodePoint(0x2022)
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const q1 = (sql, ...a) => db.prepare(sql).get(...a)
  const qa = (sql, ...a) => db.prepare(sql).all(...a)
  const codeOf = (r) => `${r.status}${r.json?.code ? ` ${r.json.code}` : ''}`
  const errOf = (r) => (r.json?.error ? ` "${String(r.json.error).slice(0, 160)}"` : '')
  const skip = (m) => Object.assign(new Error(`SKIPPED — ${m}`), { skip: true })
  const globalOf = (key) => q1('SELECT value FROM investor_config WHERE owner_id = 0 AND key = ?', key)?.value
  // The Investor Directory's table. The Personal Invite Links panel above it reuses the
  // inv-table class whenever it lists an invite (a revoked one an earlier terms run left
  // is enough), so the class alone matches two tables: the directory is the one whose
  // header has "Investor Name".
  const invDirectory = (page) => page.locator('table.inv-table', { has: page.locator('thead th', { hasText: exactText('Investor Name') }) })
  const invRow = (page, name) => invDirectory(page).locator('tbody tr', { has: page.locator('td.name-cell', { hasText: exactText(name) }) })
  const detailModal = (page) => page.locator('.inv-avatar-wrap').locator('xpath=ancestor::div[contains(@style,"z-index")][1]')
  const appRow = (page, email) => page.locator('tbody tr', { hasText: email })
  const start = ifxMaxRowids()
  const splitAtStart = q1("SELECT value FROM investor_config WHERE owner_id = 0 AND key = 'investor_split_pct'")?.value
  const st = { users: {}, inv: {}, apps: {}, truckTA: null, recId: null }
  // C carries QA-TEST investor account A's email; D the throwaway QA-TEST Driver's (F6c).
  const emailOf = { P: EMAIL('P'), Q: EMAIL('Q'), C: EMAIL('A'), E: EMAIL('E'), D: EMAIL('DRV') }
  const consoleErrs = []
  const failed = []
  const contexts = []
  // A failing request the UI sends because a step makes it on purpose (a pick the
  // server refuses, a delete of a removed record): its method and path, for the
  // step's duration. The response listener marks it "probe <step>" rather than "app".
  let uiProbes = []
  const uiProbe = (stepId, method, re) => uiProbes.push({ step: stepId, method, re })
  // A resource as it may be printed: this server's path (numeric segments as :id, an
  // uploads path cut to its folder, since file names can carry a person's name), or
  // another origin's host and path. Never a query string, which is where a token goes.
  const resPath = (u) => {
    const s = String(u || '')
    if (!s) return '(no url)'
    if (/^(data|blob):/i.test(s)) return `(${s.slice(0, s.indexOf(':'))} URL)`
    if (s.startsWith(BASE_URL)) {
      let p = pathOf(s).replace(/\/\d+(?=\/|$)/g, '/:id')
      if (p.startsWith('/uploads/')) p = `${p.split('/').slice(0, 3).join('/')}/…`
      return p
    }
    try { const x = new URL(s); return `${x.host}${x.pathname}` } catch { return '(other origin)' }
  }
  // Saved screenshots blur every table row that is not QA-TEST data (real applicants,
  // investors, expenses, trucks) for the moment of the shot. A blur, not a mask: a mask
  // box is drawn over a row even where an open dialog covers it, and would hide the dialog.
  const ifxShot = async (page, name, mask = []) => {
    if (!MASK_PII) return shot(page, name, { mask })
    await page.evaluate(() => {
      for (const tr of document.querySelectorAll('table tbody tr')) {
        if (/qa-test/i.test(tr.textContent || '')) continue
        tr.dataset.qaBlur = tr.style.filter || '-'
        tr.style.filter = 'blur(6px)'
      }
    }).catch(() => {})
    try { return await shot(page, name, { mask }) } finally {
      await page.evaluate(() => {
        for (const tr of document.querySelectorAll('tr[data-qa-blur]')) { tr.style.filter = tr.dataset.qaBlur === '-' ? '' : tr.dataset.qaBlur; delete tr.dataset.qaBlur }
      }).catch(() => {})
    }
  }
  // External logisx.com (the Wix site /invest sends applicants to after submitting) is
  // never reached: a navigation there gets a local placeholder, anything else aborts.
  const open = async (who) => {
    const { ctx, page } = await freshPage(ADMIN_VP)
    ctx.setDefaultTimeout(30000)
    contexts.push(ctx)
    await ctx.route(/^https?:\/\/([^/]*\.)?logisx\.com(\/|$)/i, (route) => (route.request().isNavigationRequest()
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>QA: navigation to logisx.com blocked by the harness</h1>' })
      : route.abort()))
    // A console error names the resource it is about (location().url) when it is a
    // "Failed to load resource" line: kept as a path, like the failures below.
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      let res = ''
      if (/^Failed to load resource/.test(m.text())) { try { res = resPath(m.location()?.url || '') } catch { /* no location */ } }
      consoleErrs.push({ who, where: pathOf(page.url()), text: m.text(), res })
    })
    page.on('pageerror', (e) => consoleErrs.push({ who, where: pathOf(page.url()), text: `uncaught: ${e.message}`, res: '' }))
    // Every failing resource: an HTTP 4xx/5xx, or a request that never got an answer.
    // The request's method and path only (resPath: never a query string, which is
    // where a token would be), the page it came from, and its source: the run's own
    // fetch (X-QA-Probe), a request the UI sent because a step made it on purpose
    // (uiProbe), the harness's logisx.com block, or else the app.
    const sourceOf = (req, p, blocked = false) => {
      const tag = req.headers()['x-qa-probe']
      if (tag) return `probe ${tag} (the run's own fetch)`
      const hit = uiProbes.find((x) => x.method === req.method() && x.re.test(p))
      if (hit) return `probe ${hit.step} (sent by the UI on purpose)`
      if (blocked) return 'harness (logisx.com blocked)'
      return 'app'
    }
    page.on('response', (r) => {
      if (r.status() < 400) return
      const p = resPath(r.url())
      failed.push({ who, where: pathOf(page.url()), method: r.request().method(), path: p, status: String(r.status()), source: sourceOf(r.request(), pathOf(r.url())) })
    })
    page.on('requestfailed', (req) => {
      const p = resPath(req.url())
      const blocked = /^https?:\/\/([^/]*\.)?logisx\.com(\/|$)/i.test(req.url())
      failed.push({ who, where: pathOf(page.url()), method: req.method(), path: p, status: `no answer (${req.failure()?.errorText || 'failed'})`, source: sourceOf(req, pathOf(req.url()), blocked) })
    })
    return page
  }
  // One step: its own try/catch, a screenshot, one results row.
  // Its page fetches carry X-QA-Probe: <id> (see api()); the UI probes it registers
  // last until it ends.
  const step = async (id, title, expected, page, shotName, fn) => {
    let observed = ''; let v = 'FAIL'; let s = ''
    apiProbeTag = id
    try {
      await clearEvidence(page)
      const r = await fn()
      observed = r.observed; v = r.verdict
      s = r.shot ?? await ifxShot(page, shotName)
    } catch (e) {
      observed = e.skip ? e.message : `error: ${e.message}`
      v = e.skip ? 'SKIP' : 'FAIL'
      s = await ifxShot(page, `${shotName}-error`)
    } finally {
      apiProbeTag = null
      uiProbes = uiProbes.filter((x) => x.step !== id)
    }
    record({ step: id, title, expected, observed, verdict: v, shot: s })
  }
  // What an acceptance of application k created, recorded for the clean-up.
  const trackApp = (k) => {
    const appId = st.apps[k]
    const known = new Set(Object.values(st.users).map((u) => u.id))
    if (!appId) return { users: [], investors: [], trucks: [] }
    const users = qa('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id > ?', emailOf[k], start.users || 0).map((r) => r.id).filter((id) => !known.has(id))
    const investors = qa('SELECT id FROM investors WHERE application_id = ?', appId).map((r) => r.id)
    const trucks = qa('SELECT id, owner_id FROM trucks WHERE unit_number LIKE ?', `INV-${appId}-%`)
    for (const id of users) ifxNote({ table: 'users', id })
    for (const id of investors) ifxNote({ table: 'investors', id })
    for (const t of trucks) ifxNote({ table: 'trucks', id: t.id })
    return { users, investors, trucks }
  }
  let sa = null; let ia = null; let ib = null; let pub1 = null; let pub2 = null
  // The body of a QA-TEST application for POST /api/public/investor-apply (FX1, F6c):
  // fake data throughout, and one canvas-drawn signature made once on the public page.
  let appSig = null
  const appBody = async (k, legal, email) => {
    if (!appSig) {
      appSig = await pub2.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 300; c.height = 80
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 80)
        g.strokeStyle = '#111'; g.lineWidth = 3; g.beginPath(); g.moveTo(12, 60); g.bezierCurveTo(80, 0, 160, 90, 288, 18); g.stroke()
        return c.toDataURL('image/png')
      })
    }
    const consent = { agreed: true, text: 'I have read and agree to the terms of this document' }
    return {
      legal_name: legal, dba: '', entity_type: 'LLC', address: '1 QA Test Way, Testville, TX 77001', contact_person: 'QA Tester', contact_title: 'Owner',
      phone: '555-010-0100', email, years_in_operation: '1', industry_experience: 'No', fleet_size: '1', preferred_communication: 'Email',
      tax_classification: 'Individual/LLC', ein_ssn: '00-0000001', bankruptcy_liens: '', reporting_preference: 'Digital Portal',
      vehicles: [{ year: '2020', make: 'Freightliner', model: 'Cascadia', vin: `QATESTVIN${k}${TU}`.slice(0, 17), licensePlate: '', mileage: '', titleState: '' }],
      banking: { bank_name: 'QA Test Bank', account_type: 'Business Checking', routing_number: '000000000', account_number: `000111222${k.charCodeAt(0)}`, account_name: legal },
      signatures: Object.fromEntries(['master_agreement', 'vehicle_lease', 'w9'].map((d) => [d, { text: 'QA Tester', image: appSig, consent }])),
    }
  }
  try {
    sa = await open('Super Admin')
    await login(sa, 'FX0 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')

    // ---- FX0: the QA-TEST actors (Super Admin API)
    apiProbeTag = 'FX0'
    {
      const notes = []
      for (const k of ['A', 'B']) {
        const password = randomBytes(18).toString('base64url')
        const r = await api(sa, 'POST', '/api/users', { username: UNAME(k), password, role: 'Investor', email: EMAIL(k), fullName: NAME(k), companyName: NAME(k) })
        const row = q1('SELECT id FROM users WHERE username = ?', UNAME(k))
        if (row) ifxNote({ table: 'users', id: row.id })
        if (r.status !== 200) throw new Error(`POST /api/users (${k}) → ${codeOf(r)}${errOf(r)}`)
        const listed = ((await api(sa, 'GET', '/api/users')).json?.users || []).find((u) => u.Username === UNAME(k))
        if (!row || !listed || Number(listed.id) !== row.id) throw new Error('DB_PATH is not the database this server runs on: the new account is not in it under the id the API lists')
        st.users[k] = { id: row.id, password }
        const inv = await api(sa, 'POST', '/api/investors', { userId: row.id, fullName: NAME(k), carrierName: NAME(k), status: 'Active', notes: 'QA-TEST record' })
        if (inv.json?.id) { st.inv[k] = Number(inv.json.id); ifxNote({ table: 'investors', id: st.inv[k] }) }
        if (inv.status !== 200 || !st.inv[k]) throw new Error(`POST /api/investors (${k}) → ${codeOf(inv)}`)
        notes.push(`${k}: account #${row.id}, investor record #${st.inv[k]}`)
      }
      const today = await sa.evaluate(() => new Date().toLocaleDateString('en-CA'))
      const tr = await api(sa, 'POST', '/api/trucks', { unitNumber: NAME('TA'), status: 'Active', ownerId: st.users.A.id, in_service_date: today, inServiceDate: today, assignedDriver: '' })
      const trow = q1('SELECT id, owner_id FROM trucks WHERE unit_number = ?', NAME('TA'))
      if (trow) { st.truckTA = trow.id; ifxNote({ table: 'trucks', id: trow.id }) }
      notes.push(`truck ${NAME('TA')} → ${codeOf(tr)}${trow ? ` #${trow.id}, owned by ${trow.owner_id === st.users.A.id ? 'A' : `user ${trow.owner_id}`}` : ' (not created)'}`)
      meta.ids.ifxInvestorA = st.users.A.id
      meta.ids.ifxInvestorB = st.users.B.id
      record({ step: 'FX0', title: 'Set-up (Super Admin API): QA-TEST investor accounts A and B, an investor record for each, a truck owned by A', expected: 'Created; DB_PATH is the server\'s database', observed: notes.join('; '), verdict: 'INFO', shot: '' })
    }
    apiProbeTag = null
    ia = await open('QA-TEST investor A')
    await login(ia, 'FX0 — QA-TEST investor A', UNAME('A'), st.users.A.password, '/investor')
    ib = await open('QA-TEST investor B')
    await login(ib, 'FX0 — QA-TEST investor B', UNAME('B'), st.users.B.password, '/investor')

    // ---- F1: who may write investor config, and whether an admin split change is audited
    await step('F1a', 'QA-TEST investor A sends PUT /api/investor/config?ownerId=<A\'s own user id> {"investor_split_pct":"99"} (page fetch from A\'s portal, X-Requested-With)',
      '403; GET /api/investor/config unchanged; no per-investor row written', ia, 'f1a-investor-config-write', async () => {
        const before = await api(ia, 'GET', '/api/investor/config')
        const put = await api(ia, 'PUT', `/api/investor/config?ownerId=${st.users.A.id}`, { investor_split_pct: '99' })
        const after = await api(ia, 'GET', '/api/investor/config')
        const row = q1("SELECT value FROM investor_config WHERE owner_id = ? AND key = 'investor_split_pct'", st.users.A.id)
        if (row) ifxNote({ table: 'investor_config', owner: st.users.A.id, key: 'investor_split_pct' })
        const unchanged = String(after.json?.investor_split_pct) === String(before.json?.investor_split_pct)
        const observed = `PUT → ${codeOf(put)}${errOf(put)}; GET split ${before.json?.investor_split_pct} before → ${after.json?.investor_split_pct} after; per-investor row stored: ${row ? `yes ("${row.value}")` : 'none'}`
        await caption(ia, `Step F1a — ${observed}`)
        await evidence(ia, ['F1a — QA-TEST investor A, page fetch', `GET  /api/investor/config → split ${before.json?.investor_split_pct}`,
          `PUT  /api/investor/config?ownerId=${st.users.A.id} {"investor_split_pct":"99"} → ${codeOf(put)}`, `GET  /api/investor/config → split ${after.json?.investor_split_pct}`])
        const s = await ifxShot(ia, 'f1a-investor-config-write')
        ifxRemoveRowsSync((r) => r.table === 'investor_config' && r.owner === st.users.A.id)
        return { observed, verdict: verdict(put.status === 403 && unchanged && !row), shot: s }
      })
    await step('F1b', 'Super Admin sends PUT /api/investor/config with no ownerId and {"investor_split_pct":"<the global value, 50>"} (page fetch)',
      '400 OWNER_ID_REQUIRED (nothing written)', sa, 'f1b-admin-config-no-owner', async () => {
        const g = globalOf('investor_split_pct')
        if (g == null) throw skip('the copy has no global investor_split_pct row')
        const put = await api(sa, 'PUT', '/api/investor/config', { investor_split_pct: String(g) })
        const g2 = globalOf('investor_split_pct')
        if (g2 !== g) db.prepare("UPDATE investor_config SET value = ? WHERE owner_id = 0 AND key = 'investor_split_pct'").run(g)
        const observed = `PUT → ${codeOf(put)}${errOf(put)}; the global split "${g}" → "${g2}"${g2 !== g ? ' (put back)' : ' (the same value: nothing changed)'}`
        await caption(sa, `Step F1b — ${observed}`)
        await evidence(sa, ['F1b — Super Admin, page fetch', `PUT /api/investor/config (no ownerId) {"investor_split_pct":"${g}"} → ${codeOf(put)}`])
        return { observed, verdict: verdict(put.status === 400 && put.json?.code === 'OWNER_ID_REQUIRED') }
      })
    await step('F1c', 'Super Admin changes QA-TEST investor B\'s split on /investors (Split % cell: 45, Save); the audit trail is read in the copy',
      'Saved (200), and an audit_trail row records the split change', sa, 'f1c-split-audit', async () => {
        const auditMax = q1('SELECT COALESCE(MAX(id), 0) AS m FROM audit_trail').m
        await sa.goto(`${BASE_URL}/investors`)
        const row = invRow(sa, NAME('B'))
        await row.waitFor({ state: 'visible', timeout: 60000 })
        await row.scrollIntoViewIfNeeded()
        const input = row.locator('input.split-input')
        await sa.waitForFunction((el) => el && !el.disabled, await input.elementHandle(), { timeout: 20000 })
        await caption(sa, 'Step F1c — set QA-TEST investor B\'s Split % to 45 and press Save')
        await input.fill('45')
        const [resp] = await Promise.all([
          sa.waitForResponse((r) => pathOf(r.url()) === '/api/investor/config' && r.request().method() === 'PUT', { timeout: 30000 }),
          row.locator('button.split-save').click(),
        ])
        const stored = q1("SELECT value FROM investor_config WHERE owner_id = ? AND key = 'investor_split_pct'", st.users.B.id)
        if (stored) ifxNote({ table: 'investor_config', owner: st.users.B.id, key: 'investor_split_pct' })
        await sa.waitForTimeout(500)
        const audits = qa('SELECT action, entity FROM audit_trail WHERE id > ? ORDER BY id', auditMax)
        const splitAudits = audits.filter((a) => /split|config/i.test(`${a.action} ${a.entity}`))
        const observed = `PUT ${pathOf(resp.url())}?ownerId=… → ${resp.status()}; B's stored split: ${stored ? `"${stored.value}"` : 'none'}; audit_trail rows written since: ${audits.length}` +
          `${audits.length ? ` (${audits.map((a) => `${a.action}/${a.entity}`).join(', ')})` : ''}; of them about the split/config: ${splitAudits.length}`
        await caption(sa, `Step F1c — ${observed}`)
        const s = await ifxShot(sa, 'f1c-split-audit')
        ifxRemoveRowsSync((r) => r.table === 'investor_config' && r.owner === st.users.B.id)
        return { observed, verdict: verdict(resp.status() === 200 && stored?.value === '45' && splitAudits.length > 0), shot: s }
      })

    // ---- F2: legal documents across two investors
    const legalPanel = (page) => page.locator('div.section-title', { hasText: 'Legal Documents' }).locator('xpath=..')
    const pdfDataUrl = `data:application/pdf;base64,${PDF_BYTES.toString('base64')}`
    let docA = null
    await step('F2a', 'QA-TEST investor A uploads a legal document from their portal (Legal Documents panel); QA-TEST investor B sends DELETE /api/legal-documents/<A\'s document id> (page fetch)',
      'B\'s delete is refused (4xx); the document is still listed for A', ia, 'f2a-cross-investor-delete', async () => {
        await ia.goto(`${BASE_URL}/investor`)
        const panel = legalPanel(ia)
        await panel.waitFor({ state: 'visible', timeout: 120000 })
        await panel.scrollIntoViewIfNeeded()
        await caption(ia, 'Step F2a — QA-TEST investor A uploads a document (type Other) from their Legal Documents panel')
        await panel.locator('.upload-row select.doc-select').last().selectOption('Other')
        await panel.locator('input.fdz-file').setInputFiles({ name: `qa-test-legal-${T}-a.pdf`, mimeType: 'application/pdf', buffer: PDF_BYTES })
        const [up] = await Promise.all([
          ia.waitForResponse((r) => pathOf(r.url()) === '/api/legal-documents/upload', { timeout: 30000 }),
          panel.locator('button.btn-upload').click(),
        ])
        const upJson = await up.json().catch(() => null)
        docA = Number(upJson?.id) || null
        if (docA) ifxNote({ table: 'legal_documents', id: docA })
        if (up.status() !== 200 || !docA) throw new Error(`A's upload answered ${up.status()}`)
        await panel.locator('td.file-name', { hasText: `qa-test-legal-${T}-a.pdf` }).waitFor({ state: 'visible', timeout: 20000 })
        await caption(ib, `Step F2a — QA-TEST investor B sends DELETE /api/legal-documents/${docA} (A's document)`)
        const del = await api(ib, 'DELETE', `/api/legal-documents/${docA}`)
        await evidence(ib, ['F2a — QA-TEST investor B, page fetch', `DELETE /api/legal-documents/${docA} (investor A's document) → ${codeOf(del)}${errOf(del)}`])
        const sB = await ifxShot(ib, 'f2a-b-sends-delete')
        const still = !!q1('SELECT id FROM legal_documents WHERE id = ?', docA)
        if (!still) ifxForget('legal_documents', docA)
        const listA = await api(ia, 'GET', '/api/legal-documents')
        const listed = (listA.json?.documents || []).some((d) => Number(d.id) === docA)
        await ia.reload()
        await panel.waitFor({ state: 'visible', timeout: 120000 })
        await panel.scrollIntoViewIfNeeded()
        await ia.waitForTimeout(1000)
        const onScreen = await panel.locator('td.file-name', { hasText: `qa-test-legal-${T}-a.pdf` }).count()
        const observed = `A's upload → 200 (#${docA}); B's DELETE → ${codeOf(del)}${errOf(del)}; afterwards the row ${still ? 'exists' : 'is GONE'} in the copy, A's list ${listed ? 'still has' : 'no longer has'} it, A's panel shows it: ${onScreen > 0} (B's side: ${path.basename(sB)})`
        await caption(ia, `Step F2a — A's portal after B's DELETE: ${listed ? 'the document is still there' : 'the document is GONE'}`)
        return { observed, verdict: verdict(del.status >= 400 && del.status < 500 && listed) }
      })
    const bUpload = async (label, extra) => {
      const r = await api(ib, 'POST', '/api/legal-documents/upload', { fileData: pdfDataUrl, fileName: `qa-test-legal-${T}-b-${label}.pdf`, docType: 'Other', notes: 'QA-TEST', ...extra })
      const id = Number(r.json?.id) || null
      if (id) ifxNote({ table: 'legal_documents', id })
      const row = id ? q1('SELECT investor_id, truck_id FROM legal_documents WHERE id = ?', id) : null
      const listA = await api(ia, 'GET', '/api/legal-documents')
      const inAList = !!id && (listA.json?.documents || []).some((d) => Number(d.id) === id)
      return { r, id, row, inAList }
    }
    const showAPanel = async (stepId, text) => {
      await ia.reload()
      const panel = legalPanel(ia)
      await panel.waitFor({ state: 'visible', timeout: 120000 })
      await panel.scrollIntoViewIfNeeded()
      await ia.waitForTimeout(1000)
      await caption(ia, `Step ${stepId} — ${text}`)
    }
    await step('F2b', 'QA-TEST investor B uploads a legal document with investorId = QA-TEST investor A\'s investor record id (page fetch)',
      'Refused (4xx), or stored without A\'s investor id (not in A\'s list)', ia, 'f2b-upload-as-other-investor', async () => {
        const { r, id, row, inAList } = await bUpload('inv', { investorId: st.inv.A })
        const againstA = !!row && Number(row.investor_id) === st.inv.A
        const observed = `POST /api/legal-documents/upload {investorId: ${st.inv.A}} as B → ${codeOf(r)}${errOf(r)}${id ? `; stored #${id} with investor_id ${row?.investor_id === st.inv.A ? 'A\'s' : row?.investor_id}` : ''}; listed for A: ${inAList}`
        await showAPanel('F2b', `A's own portal: B's upload "qa-test-legal-${T}-b-inv.pdf" is ${inAList ? 'LISTED here' : 'not here'}`)
        await evidence(ia, ['F2b — QA-TEST investor B, page fetch', `POST /api/legal-documents/upload {investorId: ${st.inv.A}} → ${codeOf(r)}`, `stored against A: ${againstA}; in A's list: ${inAList}`])
        return { observed, verdict: verdict((r.status >= 400 && r.status < 500 && !id) || (!againstA && !inAList)) }
      })
    await step('F2c', `QA-TEST investor B uploads a legal document with truckId = A's truck ${NAME('TA')} (page fetch). driverId is not tried: every driver on the copy is real`,
      'Refused (4xx), or not stored against A\'s truck (not in A\'s list)', ia, 'f2c-upload-to-other-truck', async () => {
        if (!st.truckTA) throw skip('A\'s test truck was not created')
        const { r, id, row, inAList } = await bUpload('truck', { truckId: st.truckTA, unitNumber: NAME('TA') })
        const againstA = !!row && Number(row.truck_id) === st.truckTA
        const observed = `POST /api/legal-documents/upload {truckId: ${st.truckTA}} as B → ${codeOf(r)}${errOf(r)}${id ? `; stored #${id} on truck ${againstA ? `${NAME('TA')} (A's)` : row?.truck_id}` : ''}; listed for A: ${inAList}`
        await showAPanel('F2c', `A's own portal: B's upload "qa-test-legal-${T}-b-truck.pdf" is ${inAList ? 'LISTED here' : 'not here'}`)
        await evidence(ia, ['F2c — QA-TEST investor B, page fetch', `POST /api/legal-documents/upload {truckId: ${st.truckTA}} → ${codeOf(r)}`, `stored on A's truck: ${againstA}; in A's list: ${inAList}`])
        return { observed, verdict: verdict((r.status >= 400 && r.status < 500 && !id) || (!againstA && !inAList)) }
      })

    // ---- F3: the admin fund and fuel targets read the GLOBAL config
    await step('F3', 'Planted: QA-TEST investor A\'s own investor_config rows maintenance_fund_monthly = 98765 and fuel_savings_target_pct = 87; the Super Admin opens Expenses → Maintenance Fund and Fuel Logs',
      'The admin figures use the global values (GET /api/maintenance-fund monthlyTarget and GET /api/expenses/fuel-analytics savingsTarget), not the planted ones', sa, 'f3-admin-targets', async () => {
        const gM = globalOf('maintenance_fund_monthly')
        const gF = globalOf('fuel_savings_target_pct')
        const put = db.prepare('INSERT OR REPLACE INTO investor_config (owner_id, key, value) VALUES (?, ?, ?)')
        ifxNote({ table: 'investor_config', owner: st.users.A.id, key: 'maintenance_fund_monthly' })
        ifxNote({ table: 'investor_config', owner: st.users.A.id, key: 'fuel_savings_target_pct' })
        put.run(st.users.A.id, 'maintenance_fund_monthly', '98765')
        put.run(st.users.A.id, 'fuel_savings_target_pct', '87')
        try {
          const mf = await api(sa, 'GET', '/api/maintenance-fund')
          const fa = await api(sa, 'GET', '/api/expenses/fuel-analytics')
          await sa.goto(`${BASE_URL}/expenses`)
          const tab = (label) => sa.locator('.sub-tabs button.sub-tab', { hasText: label })
          await tab('Maintenance Fund').waitFor({ state: 'visible', timeout: 60000 })
          await tab('Maintenance Fund').click()
          const target = sa.locator('.metric-label', { hasText: 'Monthly Target' }).locator('xpath=..').locator('.metric-value')
          await target.waitFor({ state: 'visible', timeout: 30000 })
          await sa.waitForTimeout(1000)
          const shownFund = norm(await target.innerText())
          await caption(sa, `Step F3 — Maintenance Fund, Monthly Target: ${shownFund} (global ${gM}; planted for investor A: 98765)`)
          const s = await ifxShot(sa, 'f3a-maintenance-target')
          await tab('Fuel Logs').click()
          let shownFuel = '(not rendered)'
          try {
            const line = sa.locator('.compliance-detail', { hasText: 'Target:' }).first()
            await line.waitFor({ state: 'visible', timeout: 20000 })
            await line.scrollIntoViewIfNeeded()
            shownFuel = (norm(await line.innerText()).match(/Target:\s*[\d.]+%/) || ['(no target)'])[0]
          } catch { /* the fuel panel may have nothing to show */ }
          await caption(sa, `Step F3 — Fuel Logs: "${shownFuel}" (global ${gF}%; planted for investor A: 87%)`)
          const s2 = await ifxShot(sa, 'f3b-fuel-target')
          const okM = Number(mf.json?.monthlyTarget) === Number(gM)
          const okF = Number(fa.json?.savingsTarget) === Number(gF)
          const observed = `GET /api/maintenance-fund → ${mf.status}, monthlyTarget ${mf.json?.monthlyTarget} (global ${gM}); screen "${shownFund}"; ` +
            `GET /api/expenses/fuel-analytics → ${fa.status}, savingsTarget ${fa.json?.savingsTarget} (global ${gF}); screen "${shownFuel}" (fuel shot: ${path.basename(s2)})`
          return { observed, verdict: verdict(okM && okF), shot: s }
        } finally {
          ifxRemoveRowsSync((r) => r.table === 'investor_config' && r.owner === st.users.A.id)
        }
      })

    // ---- F10: Admin Tools' Owner Take %, and the investor's "Your share" note
    await step('F10a', 'The global split set to 55 (PUT /api/investor/config, the route the admin UI saves config through); Super Admin reloads Admin Tools (Fleet Configuration)',
      '"Owner Take %" shows 55, the stored value; then the global is put back to 50', sa, 'f10a-owner-take', async () => {
        const g = globalOf('investor_split_pct')
        if (g == null) throw skip('the copy has no global investor_split_pct row')
        let how = 'PUT /api/investor/config?ownerId=global → '
        const put = await api(sa, 'PUT', '/api/investor/config?ownerId=global', { investor_split_pct: '55' })
        how += codeOf(put)
        let planted = false
        if (globalOf('investor_split_pct') !== '55') {
          db.prepare("UPDATE investor_config SET value = '55' WHERE owner_id = 0 AND key = 'investor_split_pct'").run()
          planted = true
          how += '; set in the copy instead'
        }
        let shown = '(not found)'; let cfg = null; let s = ''
        try {
          cfg = await api(sa, 'GET', '/api/investor/config')
          await sa.goto(`${BASE_URL}/admin/tools`)
          const box = sa.locator('label', { hasText: 'Owner Take %' }).locator('xpath=..').locator('input')
          await box.waitFor({ state: 'visible', timeout: 60000 })
          await box.scrollIntoViewIfNeeded()
          await sa.waitForTimeout(2000)
          shown = await box.inputValue()
          await caption(sa, `Step F10a — the stored global split is 55; Admin Tools "Owner Take %" shows ${shown}`)
          s = await ifxShot(sa, 'f10a-owner-take')
        } finally {
          let back = ''
          if (!planted) { const r = await api(sa, 'PUT', '/api/investor/config?ownerId=global', { investor_split_pct: g }); back = `PUT back → ${r.status}` }
          if (globalOf('investor_split_pct') !== g) { db.prepare("UPDATE investor_config SET value = ? WHERE owner_id = 0 AND key = 'investor_split_pct'").run(g); back += '; restored in the copy' }
          st.f10Restore = `${back}; global split now "${globalOf('investor_split_pct')}"`
        }
        const observed = `${how}; GET /api/investor/config → split ${cfg?.json?.investor_split_pct}; "Owner Take %" shows ${shown}; ${st.f10Restore}`
        return { observed, verdict: verdict(shown === '55' && globalOf('investor_split_pct') === g), shot: s }
      })
    await step('F10b', 'Planted: QA-TEST investor A\'s own split stored as "150"; A opens their portal and expands My Loads',
      'The "Your Share" note states the split the server applies (150 clamps to 100: "gross × 100%")', ia, 'f10b-myloads-split', async () => {
        ifxNote({ table: 'investor_config', owner: st.users.A.id, key: 'investor_split_pct' })
        db.prepare('INSERT OR REPLACE INTO investor_config (owner_id, key, value) VALUES (?, ?, ?)').run(st.users.A.id, 'investor_split_pct', '150')
        try {
          await ia.goto(`${BASE_URL}/investor`)
          const title = ia.locator('h3.section-title', { hasText: 'My Loads' })
          await title.waitFor({ state: 'visible', timeout: 120000 })
          const sec = title.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " section-card ")][1]')
          await sec.scrollIntoViewIfNeeded()
          const toggle = sec.locator('button.section-toggle')
          if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
          const note = sec.locator('p.footnote')
          await note.waitFor({ state: 'visible', timeout: 15000 })
          const text = norm(await note.innerText())
          const loads = await sec.locator('li.load-row').count()
          const pct = (text.match(/(\d+(?:\.\d+)?)%/) || [])[1] || '(none)'
          await note.scrollIntoViewIfNeeded()
          await caption(ia, `Step F10b — stored split "150"; the My Loads note reads "gross × ${pct}%" (the server applies 100)`)
          const observed = `stored split "150"; My Loads (${loads} load row(s)) note: "${text}"; the percentage shown: ${pct}`
          return { observed, verdict: verdict(pct === '100') }
        } finally {
          ifxRemoveRowsSync((r) => r.table === 'investor_config' && r.owner === st.users.A.id)
        }
      })

    // ---- F9: preview of a user id that is no investor
    // The page checks the id against GET /api/users before it mounts anything, and for
    // an id that is no Investor renders an "Investor not found" card: no "Previewing"
    // banner, no portal (so no fleet numbers), and no request for the portal's data.
    // The API is asked directly as well.
    await step('F9', 'Super Admin opens /investor-portals, then /investor-portals/99999999 (no such user), and a page fetch of GET /api/investor?as_user_id=99999999',
      '404 INVESTOR_NOT_FOUND; the page renders an "Investor not found" card and no portal: no "Previewing" banner, no portal section, no fleet numbers', sa, 'f9-preview-missing-user', async () => {
        if (q1('SELECT id FROM users WHERE id = 99999999')) throw skip('a user 99999999 exists on this copy')
        await sa.goto(`${BASE_URL}/investor-portals`)
        await sa.waitForLoadState('load')
        await sa.waitForTimeout(2000)
        // The portal's own data requests (anything under /api/investor that is not
        // this step's fetch), while the preview page is open.
        const portalReqs = []
        const onReq = (r) => {
          const p = pathOf(r.url())
          if (!r.headers()['x-qa-probe'] && /^\/api\/investor(\/|$)/.test(p)) portalReqs.push(`${r.method()} ${resPath(r.url())}`)
        }
        sa.on('request', onReq)
        let missingTitle = ''; let missingText = ''; let backLink = 0; let banner = 0; let previewing = 0; let portal = 0; let sections = 0
        try {
          await sa.goto(`${BASE_URL}/investor-portals/99999999`)
          const heading = sa.getByRole('heading', { name: /Investor not found|Could not open this preview/ })
          // Whichever the page settles on: the not-found card, or (the old build) the banner.
          await heading.or(sa.locator('.preview-banner')).first().waitFor({ state: 'visible', timeout: 30000 })
          await sa.waitForFunction(() => !document.querySelector('.skeleton-block'), null, { timeout: 120000 }).catch(() => {})
          await sa.waitForTimeout(2000)
          missingTitle = norm(await heading.first().innerText().catch(() => ''))
          missingText = norm(await sa.getByText(/No investor account has the id/).first().innerText().catch(() => ''))
          backLink = await sa.getByRole('link', { name: /Back to Investor Portals/ }).count()
          banner = await sa.locator('.preview-banner').count()
          previewing = await sa.getByText(/Previewing/).count()
          portal = await sa.locator('.investor-dashboard').count()
          sections = await sa.locator('.section-card, .section').count()
        } finally { sa.off('request', onReq) }
        const r = await api(sa, 'GET', '/api/investor?as_user_id=99999999')
        const own = await api(sa, 'GET', '/api/investor')
        const block = (j) => JSON.stringify(j?.production ?? null)
        const same = r.status === 200 && own.status === 200 && r.json?.production != null && block(r.json) === block(own.json)
        const notFound = missingTitle === 'Investor not found' && /\b99999999\b/.test(missingText)
        const noPortal = !banner && !previewing && !portal && !sections && !portalReqs.length
        const observed = `page: "${missingTitle || '(no not-found heading)'}"${missingText ? ` — "${missingText}"` : ''}; "Back to Investor Portals" link: ${backLink > 0}; ` +
          `"Previewing" banner: ${banner || previewing ? 'SHOWN' : 'none'}; portal rendered (fleet numbers): ${portal ? 'YES' : 'no'}, ${sections} portal section(s); ` +
          `the page's own /api/investor requests: ${portalReqs.length ? [...new Set(portalReqs)].join(', ') : 'none'}; ` +
          `GET /api/investor?as_user_id=99999999 → ${codeOf(r)}${errOf(r)}${same ? ' — its production block IS IDENTICAL to the Super Admin\'s own fleet-wide GET /api/investor' : ''}`
        await caption(sa, `Step F9 — /investor-portals/99999999: ${notFound ? '"Investor not found" card' : 'no not-found card'}, ${noPortal ? 'no banner or portal' : 'a portal under "Previewing"'}; API → ${codeOf(r)}`)
        await evidence(sa, ['F9 — Super Admin, page fetch', `GET /api/investor?as_user_id=99999999 → ${codeOf(r)}${errOf(r)}`])
        return { observed, verdict: verdict(notFound && noPortal && r.status === 404 && r.json?.code === 'INVESTOR_NOT_FOUND') }
      })

    // ---- F8: a duplicate investor record
    await step('F8', `Super Admin POST /api/investors twice with the same name and carrier name (${NAME('DUP')}) (page fetch)`,
      'The second answers 409 with a code; one record exists', sa, 'f8-duplicate-investor', async () => {
        const body = { fullName: NAME('DUP'), carrierName: NAME('DUP'), status: 'Active', notes: 'QA-TEST' }
        const r1 = await api(sa, 'POST', '/api/investors', body)
        if (r1.json?.id) ifxNote({ table: 'investors', id: r1.json.id })
        const r2 = await api(sa, 'POST', '/api/investors', body)
        if (r2.json?.id) ifxNote({ table: 'investors', id: r2.json.id })
        const n = q1('SELECT COUNT(*) AS n FROM investors WHERE carrier_name = ?', NAME('DUP')).n
        const observed = `first → ${codeOf(r1)}; second → ${codeOf(r2)}${errOf(r2)}${r2.text ? ` (body "${norm(r2.text).slice(0, 80)}")` : ''}; records under that name: ${n}`
        await caption(sa, `Step F8 — ${observed}`)
        await evidence(sa, ['F8 — Super Admin, page fetch', `POST /api/investors {${NAME('DUP')}} → ${codeOf(r1)}`, `POST /api/investors {${NAME('DUP')}} again → ${codeOf(r2)}${errOf(r2)}`])
        for (const id of [r1.json?.id, r2.json?.id].filter(Boolean)) {
          const d = await api(sa, 'DELETE', `/api/investors/${id}`)
          if (d.status === 200) ifxForget('investors', id)
        }
        return { observed, verdict: verdict(r1.status === 200 && r2.status === 409 && !!r2.json?.code && n === 1) }
      })

    // ---- F5 + F4: a hand-added record's detail modal
    await step('F5', `Super Admin adds a record on /investors (+ Add Investor: ${NAME('REC')}, no application) and opens its detail modal`,
      'The modal says "No application data linked" (not an empty application body)', sa, 'f5-no-application', async () => {
        await sa.goto(`${BASE_URL}/investors`)
        await invDirectory(sa).waitFor({ state: 'visible', timeout: 60000 })
        await sa.locator('summary.form-toggle').click()
        const form = sa.locator('details.form-accordion')
        await field(form, 'Investor Name *').fill(NAME('REC'))
        await field(form, 'Notes (optional)').fill('QA-TEST record (F4, F5)')
        await caption(sa, `Step F5 — + Add Investor: ${NAME('REC')} (hand-added, no application)`)
        const [resp] = await Promise.all([
          sa.waitForResponse((r) => pathOf(r.url()) === '/api/investors' && r.request().method() === 'POST', { timeout: 30000 }),
          sa.locator('button.btn-add').click(),
        ])
        const j = await resp.json().catch(() => null)
        st.recId = Number(j?.id) || null
        if (st.recId) ifxNote({ table: 'investors', id: st.recId })
        // The add reloads the list, and so does the investors:changed event it emits:
        // let both land first, or the second reload closes the modal (that is F4).
        await sa.waitForTimeout(3500)
        await invDirectory(sa).waitFor({ state: 'visible', timeout: 30000 })
        const row = invRow(sa, NAME('REC'))
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        await row.locator('td.name-cell').click()
        await sa.locator('.inv-avatar-wrap').waitFor({ state: 'visible', timeout: 15000 })
        await sa.waitForTimeout(800)
        const text = norm(await detailModal(sa).innerText())
        const says = /no application data linked/i.test(text)
        const instead = /company & business/i.test(text) ? 'a "Company & Business" section holding only the record name (Legal Name) and an empty Address' : 'no application section'
        await caption(sa, `Step F5 — detail modal of a hand-added record: "No application data linked" ${says ? 'shown' : 'NOT shown'}`)
        return { observed: `POST /api/investors → ${resp.status()} (#${st.recId}); modal open; "No application data linked" shown: ${says}; it shows ${instead}`, verdict: verdict(says) }
      })
    await step('F4', 'With that detail modal open, a page fetch PUT /api/investors/<id> changes its notes (the server emits investors:changed); then 2 s',
      'The detail modal is still open', sa, 'f4-modal-after-refresh', async () => {
        if (!st.recId) throw skip('F5 made no record')
        if (!(await sa.locator('.inv-avatar-wrap').isVisible())) throw new Error('the detail modal is not open')
        const reload = sa.waitForResponse((r) => pathOf(r.url()) === '/api/investors' && r.request().method() === 'GET', { timeout: 10000 }).catch(() => null)
        const put = await api(sa, 'PUT', `/api/investors/${st.recId}`, { notes: `QA-TEST F4 ${T}` })
        const got = await reload
        await sa.waitForTimeout(2000)
        const stillOpen = await sa.locator('.inv-avatar-wrap').isVisible()
        const observed = `PUT → ${codeOf(put)}; the list reloaded (GET /api/investors): ${!!got}; 2 s later the modal is ${stillOpen ? 'still open' : 'CLOSED'}`
        await caption(sa, `Step F4 — ${observed}`)
        return { observed, verdict: verdict(put.status === 200 && stillOpen) }
      })

    // ---- F11: the /invest help text
    pub1 = await open('Public /invest (help)')
    await step('F11', '/invest: the guided tour\'s banking card and its FAQ "Is my banking info secure?" (client/src/wizard/data/knowledge-base.json)',
      'No claim that bank details are encrypted at rest, and none that they can be updated any time from the investor dashboard', pub1, 'f11-invest-help', async () => {
        await pub1.goto(`${BASE_URL}/invest`)
        const legal = pub1.locator('input[data-wizard-target="legal-name"]')
        await legal.waitFor({ state: 'visible', timeout: 30000 })
        // The tour resumes at its banking card, as it would for an applicant who reached it.
        await pub1.evaluate(() => localStorage.setItem('logisx_wizard_state', JSON.stringify({ currentStepId: 'BANKING_INTRO', history: ['WELCOME'], completed: false, dismissed: false, lastSavedAt: new Date().toISOString() })))
        await pub1.reload()
        await legal.waitFor({ state: 'visible', timeout: 30000 })
        await pub1.locator('button.wizard-fab').click()
        const panel = pub1.locator('aside.wizard-panel')
        await panel.waitFor({ state: 'visible', timeout: 15000 })
        const card = norm(await panel.innerText())
        await caption(pub1, 'Step F11 — the guided tour\'s banking card; open its FAQ link "Is my banking info secure?"')
        await panel.locator('.faq-link', { hasText: 'Is my banking info secure?' }).click()
        const drawer = pub1.locator('.faq-drawer')
        await drawer.waitFor({ state: 'visible', timeout: 10000 })
        const answer = norm(await drawer.locator('.single-a').innerText())
        const atRest = /at rest/i.test(answer)
        const anyTime = /any time from your investor dashboard/i.test(answer)
        await caption(pub1, `Step F11 — FAQ answer: "encrypted … at rest": ${atRest}; "update it any time from your investor dashboard": ${anyTime}`, false)
        await drawer.locator('.single-a').waitFor({ state: 'visible', timeout: 5000 })
        const s = await ifxShot(pub1, 'f11-invest-help')
        const cardClaim = (card.match(/[^.]*encrypted[^.]*\./i) || [''])[0].trim()
        return { observed: `FAQ answer shown: "${answer}"; banking card: "${cardClaim || '(no encryption claim)'}"`, verdict: verdict(!atRest && !anyTime), shot: s }
      })

    // ---- F13: the /invest flow, then a reload of the thank-you page (application E)
    pub2 = await open('Public /invest (apply)')
    await step('F13', `A QA-TEST applicant (${NAME('E')}) completes /invest in the UI — three documents signed on the canvas — then reloads the thank-you page`,
      `After the reload the page still reads "Thank you, ${NAME('E')}."`, pub2, 'f13b-thank-you-after-reload', async () => {
        const p = pub2
        await p.goto(`${BASE_URL}/invest`)
        await p.locator('input[data-wizard-target="legal-name"]').waitFor({ state: 'visible', timeout: 30000 })
        await caption(p, `Step F13 — step 1 of 3: ${NAME('E')}, fake QA-TEST details`)
        await p.locator('input[data-wizard-target="legal-name"]').fill(NAME('E'))
        await p.locator('select[data-wizard-target="entity-type"]').selectOption('LLC')
        await p.locator('input[data-wizard-target="address"]').fill('1 QA Test Way, Testville, TX 77001')
        await p.locator('input[data-wizard-target="phone"]').fill('555-010-0100')
        await p.locator('input[data-wizard-target="email"]').fill(EMAIL('E'))
        await p.locator('input[data-wizard-target="ein-ssn"]').fill('00-0000001')
        await p.locator('[data-wizard-target="continue-step0"]').click()
        await p.locator('input[data-wizard-target="fleet-size"]').waitFor({ state: 'visible', timeout: 15000 })
        await caption(p, 'Step F13 — step 2 of 3: one vehicle, then sign the three documents')
        await p.locator('input[data-wizard-target="fleet-size"]').fill('1')
        await p.locator('select[data-wizard-target="vehicle-make"]').selectOption('Freightliner')
        await p.locator('select[data-wizard-target="vehicle-model"]').selectOption('Cascadia')
        await p.locator('input[data-wizard-target="vehicle-year"]').fill('2020')
        await p.locator('input[data-wizard-target="vehicle-vin"]').fill(`QATESTVINE${TU}`.slice(0, 17))
        const cards = p.locator('.doc-card')
        const nDocs = await cards.count()
        // The guided tour opens by itself 1.2 s after a first visit and minimizes when the
        // page is used. Before each close, a trial click checks what the × is under.
        const closeSignDialog = async (modal, i) => {
          const btn = modal.locator('button.modal-close')
          try { await btn.click({ trial: true, timeout: 2500 }) } catch (e) {
            const m = String(e.message)
            if (!st.tourNote) {
              const by = /minimized-tab/.test(m) ? 'the minimized guide tab ("Restore guide")' : /wizard/.test(m) ? 'the guided tour panel' : /intercepts pointer events/.test(m) ? 'another element' : 'nothing clickable'
              st.tourNote = `document ${i + 1} of ${nDocs}: a trial click on the sign dialog's × found it covered by ${by}; a real click there would hit the tour, and the dialog has no other close control. Escape closed the tour, then the × worked`
              await caption(p, `Step F13 — new: the sign dialog's × is covered by ${by}`, false)
              // The caption bar would sit over the dialog's header (and its ×): hide it for this shot.
              await evidence(p, ['F13n — the sign dialog\'s × (top right) is covered by', `${by} (the tab at the right edge)`])
              await p.evaluate(() => { const c = document.getElementById('__qa_caption__'); if (c) c.style.display = 'none' }).catch(() => {})
              st.tourShot = await shot(p, 'f13n-tour-covers-close')
              await p.evaluate(() => { const c = document.getElementById('__qa_caption__'); if (c) c.style.display = '' }).catch(() => {})
              await clearEvidence(p)
            }
            await p.keyboard.press('Escape')
            await p.waitForTimeout(500)
          }
          await btn.click()
        }
        for (let i = 0; i < nDocs; i++) {
          await cards.nth(i).click()
          const modal = p.locator('.modal-overlay').filter({ has: p.locator('.sign-panel') })
          await modal.waitFor({ state: 'visible', timeout: 15000 })
          const agree = modal.locator('.sign-checkbox input[type="checkbox"]')
          await agree.check().catch(async () => { await modal.locator('label.sign-checkbox').click() })
          if (!(await agree.isChecked())) throw new Error('the consent box did not tick')
          await modal.locator('input.sign-input').fill('QA Tester')
          const canvas = modal.locator('canvas.sig-canvas')
          await canvas.scrollIntoViewIfNeeded()
          const box = await canvas.boundingBox()
          await p.mouse.move(box.x + 20, box.y + box.height * 0.65)
          await p.mouse.down()
          for (let j = 1; j <= 10; j++) await p.mouse.move(box.x + 20 + (j * (box.width - 40)) / 10, box.y + box.height * (j % 2 ? 0.3 : 0.7), { steps: 3 })
          await p.mouse.up()
          await modal.locator('button.sign-btn').click()
          await modal.locator('.sign-done').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
          if (await modal.isVisible()) await closeSignDialog(modal, i)
          await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
        }
        if (await p.locator('aside.wizard-panel').isVisible().catch(() => false)) { await p.keyboard.press('Escape'); await p.waitForTimeout(400) }
        await p.locator('[data-wizard-target="continue-step1"]').click()
        await p.locator('input[data-wizard-target="bank-name"]').waitFor({ state: 'visible', timeout: 15000 })
        await caption(p, 'Step F13 — step 3 of 3: fake QA-TEST bank details, then Review & Complete')
        await p.locator('input[data-wizard-target="bank-name"]').fill('QA Test Bank')
        await p.keyboard.press('Tab')
        await p.locator('input[data-wizard-target="routing-number"]').fill('000000000')
        await p.locator('input[data-wizard-target="account-number"]').fill('000111222069')
        await p.locator('[data-wizard-target="review-open"]').click()
        const [resp] = await Promise.all([
          p.waitForResponse((r) => pathOf(r.url()) === '/api/public/investor-apply' && r.request().method() === 'POST', { timeout: 180000 }),
          p.locator('[data-wizard-target="submit-confirm"]').click(),
        ])
        const j = await resp.json().catch(() => null)
        st.apps.E = Number(j?.applicationId) || null
        if (st.apps.E) ifxNote({ table: 'investor_applications', id: st.apps.E })
        if (resp.status() !== 200 || !st.apps.E) throw new Error(`POST /api/public/investor-apply → ${resp.status()}${j?.error ? ` "${j.error}"` : ''}`)
        const success = p.locator('.success-wrap')
        await success.waitFor({ state: 'visible', timeout: 30000 })
        const first = norm(await success.locator('p').first().innerText())
        await caption(p, `Step F13 — submitted (application #${st.apps.E}): "${first.slice(0, 80)}" — now reload`, false)
        const s1 = await shot(p, 'f13a-thank-you')
        // The page sends the applicant to logisx.com 5 s after submitting (the harness serves a
        // placeholder there): come back to the same /invest URL if that already happened.
        if (pathOf(p.url()) === '/invest') await p.reload()
        else await p.goto(`${BASE_URL}/invest`)
        await success.waitFor({ state: 'visible', timeout: 30000 })
        const after = norm(await success.locator('p').first().innerText())
        await caption(p, `Step F13 — after the reload: "${after.slice(0, 90)}"`)
        const observed = `POST /api/public/investor-apply → 200 (application #${st.apps.E}, ${j.documentsSigned}/${j.documentsTotal} documents signed); before the reload: "${first.slice(0, 70)}"; after: "${after.slice(0, 70)}" (first shot: ${path.basename(s1)})`
        return { observed, verdict: verdict(after.includes(`Thank you, ${NAME('E')}`)) }
      })

    record({
      step: 'F13n', title: 'NEW (not in the fix list): on /invest the guided tour, which opens by itself on a first visit, and the sign dialog\'s × (1400×900 window)',
      expected: '(an observation, not scored)', observed: st.tourNote || 'not seen in this run: the × was clickable each time', verdict: 'INFO', shot: st.tourShot || '',
    })

    // ---- FX1: the applications F6, F7, F12 and F14 act on (public API, QA-TEST data)
    // (F6c submits its own application D the same way.)
    apiProbeTag = 'FX1'
    {
      const notes = []
      try {
        if (!pub2.url().startsWith(BASE_URL)) await pub2.goto(`${BASE_URL}/invest`)
        for (const [k, legal] of [['P', NAME('SAME')], ['Q', NAME('SAME')], ['C', NAME('C')]]) {
          const r = await api(pub2, 'POST', '/api/public/investor-apply', await appBody(k, legal, emailOf[k]))
          const id = Number(r.json?.applicationId) || null
          if (id) { st.apps[k] = id; ifxNote({ table: 'investor_applications', id }) }
          notes.push(`${k} (${legal}${k === 'C' ? ', email = QA-TEST account A\'s' : ''}) → ${codeOf(r)}${id ? ` #${id}, ${r.json?.documentsSigned}/${r.json?.documentsTotal} documents signed` : errOf(r)}`)
        }
      } catch (e) { notes.push(`error: ${e.message}`) }
      record({ step: 'FX1', title: 'Set-up (public API, fake data): QA-TEST applications P and Q with the same company name, and C whose email is QA-TEST account A\'s', expected: '200 each', observed: notes.join('; '), verdict: 'INFO', shot: '' })
    }
    apiProbeTag = null

    // ---- F7a: "Accepted" asks first
    await step('F7a', 'Super Admin on /investor-applications picks "Accepted" in QA-TEST application P\'s status select',
      'A confirmation dialog appears before any request is sent', sa, 'f7a-accept-select', async () => {
        if (!st.apps.P) throw skip('application P was not created')
        await sa.goto(`${BASE_URL}/investor-applications`)
        const row = appRow(sa, EMAIL('P'))
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        const seen = { native: [], puts: [] }
        const onDialog = (d) => { seen.native.push({ t: Date.now(), type: d.type() }); d.accept().catch(() => {}) }
        const onReq = (r) => { if (r.method() === 'PUT' && /^\/api\/investor-applications\/\d+\/status$/.test(pathOf(r.url()))) seen.puts.push({ t: Date.now() }) }
        sa.on('dialog', onDialog)
        sa.on('request', onReq)
        try {
          await caption(sa, 'Step F7a — pick "Accepted" in application P\'s status select (the PUT is watched)', false)
          const respP = sa.waitForResponse((r) => pathOf(r.url()) === `/api/investor-applications/${st.apps.P}/status`, { timeout: 30000 }).catch(() => null)
          const t0 = Date.now()
          await row.locator('select').selectOption('Accepted')
          await sa.waitForTimeout(1500)
          let asked = false; let how = 'none'; let confirmShot = ''
          if (seen.native.length && (!seen.puts.length || seen.native[0].t <= seen.puts[0].t)) { asked = true; how = `a native ${seen.native[0].type}` }
          if (!seen.puts.length && !asked) {
            const dlg = sa.locator('[role="dialog"], [role="alertdialog"], .confirm-dialog').filter({ hasText: /accept/i }).first()
            if (await dlg.isVisible().catch(() => false)) {
              asked = true; how = 'an in-page dialog'
              confirmShot = await ifxShot(sa, 'f7a-confirm-dialog')
              await dlg.getByRole('button', { name: /accept|confirm|yes/i }).last().click().catch(() => {})
            }
          }
          const resp = await respP
          await sa.waitForTimeout(800)
          const credsDialog = sa.locator('[role="dialog"]', { hasText: 'Investor Account Created' })
          const credsShown = await credsDialog.isVisible().catch(() => false)
          const sentMs = seen.puts.length ? seen.puts[0].t - t0 : null
          let status = q1('SELECT status FROM investor_applications WHERE id = ?', st.apps.P)?.status
          const observed0 = `confirmation: ${how}; PUT …/${st.apps.P}/status ${sentMs == null ? 'not sent' : `sent ${sentMs} ms after the pick${asked ? '' : ' with nothing asked'}`}${resp ? ` → ${resp.status()}` : ''}; the credentials dialog (username + temporary password, masked in the shot) shown: ${credsShown}`
          await caption(sa, `Step F7a — ${observed0.slice(0, 180)}`)
          const s = await ifxShot(sa, 'f7a-accept-select', [sa.locator('[role="dialog"] .font-mono')])
          if (credsShown) await sa.keyboard.press('Escape').catch(() => {})
          let apiNote = ''
          if (status !== 'Accepted') {
            const r = await api(sa, 'PUT', `/api/investor-applications/${st.apps.P}/status`, { status: 'Accepted' })
            apiNote = `; P then accepted through the API for the steps that need it → ${codeOf(r)}`
            status = q1('SELECT status FROM investor_applications WHERE id = ?', st.apps.P)?.status
          }
          const made = trackApp('P')
          return { observed: `${observed0}; P now ${status}; created: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s)${apiNote}${confirmShot ? ` (dialog shot: ${path.basename(confirmShot)})` : ''}`, verdict: verdict(asked), shot: s }
        } finally {
          sa.off('dialog', onDialog)
          sa.off('request', onReq)
        }
      })

    // ---- F6: acceptances that collide
    const statusOf = (k) => q1('SELECT status FROM investor_applications WHERE id = ?', st.apps[k])?.status
    const acceptCase = async (k, what) => {
      if (!st.apps[k]) throw skip(`application ${k} was not created`)
      const r = await api(sa, 'PUT', `/api/investor-applications/${st.apps[k]}/status`, { status: 'Accepted' })
      const made = trackApp(k)
      const status = q1('SELECT status FROM investor_applications WHERE id = ?', st.apps[k])?.status
      const sameName = q1('SELECT COUNT(*) AS n FROM investors WHERE carrier_name = ?', NAME('SAME')).n
      const observed = `→ ${codeOf(r)}${r.json?.message ? ` "${r.json.message}"` : ''}${r.status !== 200 ? errOf(r) : ''}; accountCreated: ${!!r.json?.accountCreated}; application ${k} now ${status}; ` +
        `created for it: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s)` +
        `${made.trucks.length ? ` (owned by its new account: ${made.trucks.every((t) => made.users.includes(t.owner_id))})` : ''}; investor records named ${NAME('SAME')}: ${sameName}`
      await caption(sa, `Step F6 — accept application ${k} (${what}): ${codeOf(r)}; ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s)`)
      await evidence(sa, [`F6 — Super Admin, page fetch: PUT /api/investor-applications/${st.apps[k]}/status {"status":"Accepted"}`, `→ ${codeOf(r)}${r.json?.message ? ` "${r.json.message}"` : ''}`,
        `application ${k} now ${status}`, `created: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s)`])
      return { observed, verdict: verdict(r.status === 409 && !!r.json?.code && status !== 'Accepted' && !made.users.length && !made.trucks.length) }
    }
    await step('F6a', 'Super Admin accepts QA-TEST application Q, whose company name is the same as the already accepted P (PUT …/status, page fetch)',
      '409 with a code; Q not left Accepted; no account, investor record or truck made for it', sa, 'f6a-accept-same-name', () => acceptCase('Q', 'same company name as P'))
    // What an acceptance may create, counted whole-table in the copy (this private server
    // has no other writer), and the audit rows written for application k since a mark.
    const madeCounts = () => ({
      users: q1('SELECT COUNT(*) AS n FROM users').n,
      investors: q1('SELECT COUNT(*) AS n FROM investors').n,
      trucks: q1('SELECT COUNT(*) AS n FROM trucks').n,
    })
    const countsText = (c) => `${c.users} users, ${c.investors} investors rows, ${c.trucks} trucks`
    const sameCounts = (a, b) => a.users === b.users && a.investors === b.investors && a.trucks === b.trucks
    const auditMark = () => q1('SELECT COALESCE(MAX(id), 0) AS m FROM audit_trail').m
    const auditRowsFor = (k, since, action) => qa('SELECT id FROM audit_trail WHERE id > ? AND action = ? AND entity = ? AND entity_id = ?', since, action, 'investor_application', String(st.apps[k]))
    // The server's own words, exactly, for an acceptance whose email is already an
    // account's: an Investor account is accepted over (200, nothing created); any
    // other role is refused (409 USER_ALREADY_EXISTS, nothing written).
    const existingInvestorMsg = (userId) => `Accepted. This application's email matches Investor account #${userId}, so no new account, investor record or trucks were created. Confirm it is the same person before acting on its banking or vehicle details.`
    const otherRoleAccountErr = (role, userId) => `An account with this email already exists (${role} #${userId}) and it is not an investor account, so this application can't be accepted with that email.`
    // F6b / F7d: C is the application whose email is QA-TEST account A's. Its
    // acceptance answers 200 accountCreated:false and creates nothing; F7d puts C back
    // at the status it had before F6b so the UI can pick "Accepted" again.
    await step('F6b', 'Super Admin accepts QA-TEST application C, whose applicant email is QA-TEST account A\'s (PUT …/status, page fetch)',
      `200 { success: true, accountCreated: false, existingUserId: A's id } with the message "${existingInvestorMsg('<A\'s id>')}"; C Accepted; no user, investors row or truck created (whole-table counts in the copy unchanged); one accept_investor_existing_account audit row for C`, sa, 'f6b-accept-email-taken', async () => {
        if (!st.apps.C) throw skip('application C was not created')
        st.cStatus0 = statusOf('C')
        const before = madeCounts()
        const mark = auditMark()
        const r = await api(sa, 'PUT', `/api/investor-applications/${st.apps.C}/status`, { status: 'Accepted' })
        const after = madeCounts()
        const made = trackApp('C')
        const status = statusOf('C')
        const audits = auditRowsFor('C', mark, 'accept_investor_existing_account')
        const aId = st.users.A?.id
        const msg = String(r.json?.message || '')
        const msgOk = msg === existingInvestorMsg(aId)
        await caption(sa, `Step F6 — accept application C (its email is QA-TEST account A's): ${codeOf(r)}; accountCreated ${r.json?.accountCreated}; C now ${status}; counts ${sameCounts(before, after) ? 'unchanged' : 'CHANGED'}`)
        await sa.goto(`${BASE_URL}/investor-applications`)
        await appRow(sa, EMAIL('P')).waitFor({ state: 'visible', timeout: 30000 })
        await caption(sa, 'Step F6 — /investor-applications after the three acceptances (P, Q, C)')
        await evidence(sa, [`F6b — Super Admin, page fetch: PUT /api/investor-applications/${st.apps.C}/status {"status":"Accepted"}`,
          `→ ${codeOf(r)} accountCreated: ${r.json?.accountCreated}; existingUserId: ${r.json?.existingUserId} (A is #${aId})`,
          `message: "${msg}"`, `copy: ${countsText(before)} → ${countsText(after)}`, `accept_investor_existing_account rows for C: ${audits.length}`,
          'application statuses in the copy', ...['P', 'Q', 'C'].map((k) => `${k}: ${statusOf(k)}`)])
        return {
          observed: `→ ${codeOf(r)}${r.status !== 200 ? errOf(r) : ''}; success: ${r.json?.success}; accountCreated: ${r.json?.accountCreated}; existingUserId: ${r.json?.existingUserId} (account A is #${aId}); message: "${msg.slice(0, 320)}" (the expected wording: ${msgOk}); ` +
            `application C "${st.cStatus0}" → "${status}"; the copy: ${countsText(before)} before, ${countsText(after)} after; ` +
            `created for C: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s); accept_investor_existing_account audit rows for C: ${audits.length}. ` +
            '(Mail is blanked on this server, so "no email" is not observable here.)',
          verdict: verdict(r.status === 200 && r.json?.success === true && r.json?.accountCreated === false && Number(r.json?.existingUserId) === aId && msgOk &&
            status === 'Accepted' && sameCounts(before, after) && !made.users.length && !made.investors.length && !made.trucks.length && audits.length === 1),
        }
      })
    // F6c: an application whose email is a NON-investor account's is refused. The
    // account is a throwaway QA-TEST Driver made here through the admin API with no
    // driver name, so nothing is synced to the Carrier Database sheet on its create or
    // its delete, and no finance row matches its cascade name. Application D (public
    // API, fake data) carries its email. The acceptance must answer 409
    // USER_ALREADY_EXISTS with the server's exact error and write nothing: D keeps its
    // status, and no account, investor record or truck is made (whole-table counts in
    // the copy). Audit rows written for D are recorded, not scored. FXz removes the
    // driver account (API delete) and D (soft delete, then by id in the copy).
    await step('F6c', 'A throwaway QA-TEST Driver account (admin API, no driver name) and QA-TEST application D with its email (public API); the Super Admin accepts D (PUT …/status, page fetch)',
      `409 { code: "USER_ALREADY_EXISTS", error: "${otherRoleAccountErr('Driver', '<its id>')}" }; D keeps its status (not Accepted); no user, investors row or truck created (whole-table counts in the copy unchanged)`, sa, 'f6c-accept-other-role', async () => {
        if (!pub2) throw skip('no public page to submit application D from')
        const password = randomBytes(18).toString('base64url')
        const cu = await api(sa, 'POST', '/api/users', { username: UNAME('DRV'), password, role: 'Driver', email: EMAIL('DRV'), fullName: NAME('DRV') })
        const drow = q1('SELECT id, role, driver_name FROM users WHERE username = ?', UNAME('DRV'))
        if (drow) { ifxNote({ table: 'users', id: drow.id }); st.users.DRV = { id: drow.id } }
        if (cu.status !== 200 || !drow) throw new Error(`POST /api/users (a QA-TEST Driver) → ${codeOf(cu)}${errOf(cu)}`)
        if (drow.role !== 'Driver' || String(drow.driver_name || '') !== '') throw new Error(`the QA-TEST account #${drow.id} is stored as role "${drow.role}" with a driver name set: not the throwaway Driver F6c needs`)
        if (!pub2.url().startsWith(BASE_URL)) await pub2.goto(`${BASE_URL}/invest`)
        const ar = await api(pub2, 'POST', '/api/public/investor-apply', await appBody('D', NAME('D'), emailOf.D))
        const appId = Number(ar.json?.applicationId) || null
        if (appId) { st.apps.D = appId; ifxNote({ table: 'investor_applications', id: appId }) }
        if (ar.status !== 200 || !appId) throw new Error(`POST /api/public/investor-apply (D) → ${codeOf(ar)}${errOf(ar)}`)
        const stored0 = statusOf('D')
        const before = madeCounts()
        const mark = auditMark()
        const r = await api(sa, 'PUT', `/api/investor-applications/${appId}/status`, { status: 'Accepted' })
        const after = madeCounts()
        const made = trackApp('D')
        const status = statusOf('D')
        const audits = qa('SELECT action FROM audit_trail WHERE id > ? AND entity = ? AND entity_id = ?', mark, 'investor_application', String(appId)).map((a) => a.action)
        const err = String(r.json?.error || '')
        const want = otherRoleAccountErr('Driver', drow.id)
        const errOk = err === want
        await caption(sa, `Step F6c — accept application D (its email is QA-TEST Driver #${drow.id}'s): ${codeOf(r)}; D "${stored0}" → "${status}"; counts ${sameCounts(before, after) ? 'unchanged' : 'CHANGED'}`)
        await sa.goto(`${BASE_URL}/investor-applications`)
        await appRow(sa, emailOf.D).waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
        await appRow(sa, emailOf.D).scrollIntoViewIfNeeded().catch(() => {})
        await evidence(sa, [`F6c — Super Admin, page fetch: PUT /api/investor-applications/${appId}/status {"status":"Accepted"}`,
          `(application D's email is QA-TEST Driver account #${drow.id}'s)`,
          `→ ${codeOf(r)}`, err ? `error: "${err}"` : `message: "${String(r.json?.message || '')}"`, `D: "${stored0}" → "${status}"`, `copy: ${countsText(before)} → ${countsText(after)}`])
        return {
          observed: `QA-TEST Driver account #${drow.id} (POST /api/users → ${codeOf(cu)}, no driver name); application D #${appId} (POST /api/public/investor-apply → ${codeOf(ar)}); ` +
            `PUT …/status "Accepted" → ${codeOf(r)}; error: "${err.slice(0, 320)}" (the expected wording: ${errOk})${r.json?.message ? `; message: "${String(r.json.message).slice(0, 320)}"` : ''}` +
            `${r.json?.accountCreated !== undefined ? `; accountCreated: ${r.json.accountCreated}` : ''}${r.json?.existingUserId !== undefined ? `; existingUserId: ${r.json.existingUserId}` : ''}; ` +
            `application D "${stored0}" → "${status}"; the copy: ${countsText(before)} before, ${countsText(after)} after; ` +
            `created for D: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s); audit rows for D: ${audits.length ? audits.join(', ') : 'none'} (recorded, not scored)`,
          verdict: verdict(r.status === 409 && r.json?.code === 'USER_ALREADY_EXISTS' && errOk && status === stored0 && status !== 'Accepted' &&
            sameCounts(before, after) && !made.users.length && !made.investors.length && !made.trucks.length),
        }
      })

    // ---- F12b: "Docs x/3"
    await step('F12b', 'Planted: a fourth onboarding-document row on QA-TEST application E; the /investor-applications "Docs" column, then E\'s detail',
      'The Docs column\'s denominator is the application\'s real document count (4 here), as its detail shows', sa, 'f12b-docs-denominator', async () => {
        if (!st.apps.E) throw skip('application E (F13) was not created')
        const ins = db.prepare("INSERT INTO investor_onboarding_documents (application_id, doc_key, doc_name, signed) VALUES (?, 'qa_test_extra', 'QA-TEST extra document', 0)").run(st.apps.E)
        const extraId = Number(ins.lastInsertRowid)
        ifxNote({ table: 'investor_onboarding_documents', id: extraId })
        try {
          const count = q1('SELECT COUNT(*) AS n FROM investor_onboarding_documents WHERE application_id = ?', st.apps.E).n
          await sa.goto(`${BASE_URL}/investor-applications`)
          const row = appRow(sa, EMAIL('E'))
          await row.waitFor({ state: 'visible', timeout: 30000 })
          await row.scrollIntoViewIfNeeded()
          // The Docs cell by its column header, not by position (a Terms column now sits
          // before it). The header cells and the row's cells must line up one to one.
          const heads = (await sa.locator('table', { has: row }).locator('thead th').allTextContents()).map(norm)
          const docsAt = heads.findIndex((h) => h.toLowerCase() === 'docs')
          const cells = await row.locator('td').count()
          if (docsAt < 0) throw new Error(`the list has no "Docs" column (headers: ${heads.join(' | ')})`)
          if (cells !== heads.length) throw new Error(`the row has ${cells} cells for ${heads.length} headers (${heads.join(' | ')}): the Docs cell cannot be located by its header`)
          const cellText = norm(await row.locator('td').nth(docsAt).innerText())
          // The list API's own figures for E: signed_count and docs_total, the
          // denominator the cell renders (the client falls back to 3 without it).
          const list = await api(sa, 'GET', '/api/investor-applications')
          const listRow = Array.isArray(list.json) ? list.json.find((a) => Number(a.id) === st.apps.E) : null
          const docsTotal = listRow && 'docs_total' in listRow ? listRow.docs_total : undefined
          await row.getByRole('button', { name: 'View' }).click()
          const dlg = sa.locator('[role="dialog"]').filter({ hasText: 'Documents (' })
          await dlg.waitFor({ state: 'visible', timeout: 20000 })
          const title = norm(await dlg.getByText(/Documents \(\d+\/\d+ signed\)/).first().innerText())
          await caption(sa, `Step F12b — the row reads "Docs ${cellText}"; the detail reads "${title}" (${count} document rows)`)
          const s = await ifxShot(sa, 'f12b-docs-denominator')
          await sa.keyboard.press('Escape').catch(() => {})
          const real = qa("SELECT c, COUNT(*) AS n FROM (SELECT (SELECT COUNT(*) FROM investor_onboarding_documents d WHERE d.application_id = ia.id) AS c FROM investor_applications ia WHERE ia.id <= ? AND ia.status != 'Draft') GROUP BY c", start.investor_applications || 0)
          const detailOk = new RegExp(`\\(\\d+/${count} signed\\)`, 'i').test(title)
          return {
            observed: `"Docs" is column ${docsAt + 1} of ${heads.length}; E's cell: "${cellText}"; application E has ${count} document rows; ` +
              `GET /api/investor-applications for E: signed_count ${listRow?.signed_count ?? '(none)'}, docs_total ${docsTotal === undefined ? '(field absent)' : docsTotal}; ` +
              `detail: "${title}"; real applications by document-row count: ${real.map((r) => `${r.c} rows × ${r.n}`).join(', ') || 'none'}`,
            verdict: verdict(cellText.endsWith(`/${count}`) && Number(docsTotal) === count && detailOk), shot: s,
          }
        } finally {
          ifxRemoveRowsSync((r) => r.table === 'investor_onboarding_documents' && r.id === extraId)
        }
      })

    // ---- F7b: a refused save puts the select back (on a row that stays listed)
    // Q has P's company name, so once P is accepted Q's acceptance is refused 409
    // INVESTOR_RECORD_CONFLICT (F6a showed it through the API, which changes nothing: Q
    // is still at its stored status here). The refusal re-reads the list, and Q stays in
    // it, so the select can be read back.
    // The list's next GET: a refusal re-reads the list, and while it loads the table is
    // not rendered at all, so a row is read again only after that GET has landed.
    const nextListLoad = (page) => page.waitForResponse((r) => pathOf(r.url()) === '/api/investor-applications' && r.request().method() === 'GET', { timeout: 15000 }).then(() => true, () => false)
    const statusAlert = (page, what) => page.locator('[data-test="application-status-error"], [role="alert"]').filter({ hasText: what }).first()
    await step('F7b', 'Refused save: Super Admin picks "Accepted" in QA-TEST application Q\'s row (its company name is already accepted P\'s) and confirms the dialog',
      'The server refuses it (409 INVESTOR_RECORD_CONFLICT); the select goes back to Q\'s stored status and the page shows the server\'s message; Q\'s row stays listed and nothing is created', sa, 'f7b-refused-reverts', async () => {
        if (!st.apps.Q) throw skip('application Q was not created')
        if (!st.apps.P || !q1('SELECT id FROM investors WHERE application_id = ?', st.apps.P)) throw skip('application P has no investor record, so Q\'s company name is not taken')
        const stored0 = statusOf('Q')
        if (stored0 === 'Accepted') throw skip('application Q is already Accepted (F6a accepted it), so "Accepted" cannot be picked')
        const counts0 = madeCounts()
        await sa.goto(`${BASE_URL}/investor-applications`)
        const row = appRow(sa, emailOf.Q)
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        const select = row.locator('select')
        const before = await select.inputValue()
        const statusPath = `/api/investor-applications/${st.apps.Q}/status`
        uiProbe('F7b', 'PUT', new RegExp(`^${statusPath}$`))
        const respP = sa.waitForResponse((r) => pathOf(r.url()) === statusPath && r.request().method() === 'PUT', { timeout: 30000 })
        respP.catch(() => {})
        await caption(sa, 'Step F7b — pick "Accepted" in application Q\'s row (Q\'s company name is already accepted P\'s)', false)
        await select.selectOption('Accepted')
        const dlg = sa.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /Accept application/i }).first()
        await dlg.waitFor({ state: 'visible', timeout: 10000 })
        const reloaded = nextListLoad(sa)
        await dlg.getByRole('button', { name: 'Accept', exact: true }).click()
        const resp = await respP
        const j = await resp.json().catch(() => null)
        const toast = await toastText(sa, 4000)
        const alert = statusAlert(sa, /was not set to Accepted/)
        await alert.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
        const alertText = norm(await alert.innerText().catch(() => ''))
        const listReloaded = await reloaded
        await sa.waitForTimeout(1000)
        const stays = await row.isVisible().catch(() => false)
        const after = stays ? await select.inputValue() : '(row gone)'
        const stored = statusOf('Q')
        const made = trackApp('Q')
        const counts1 = madeCounts()
        const msgShown = !!j?.error && alertText.includes(norm(j.error))
        await row.scrollIntoViewIfNeeded().catch(() => {})
        await caption(sa, `Step F7b — PUT → ${resp.status()}${j?.code ? ` ${j.code}` : ''}; Q's select shows "${after}", the server holds "${stored}"; the server's message shown: ${msgShown}`)
        const s = await ifxShot(sa, 'f7b-refused-reverts')
        return {
          observed: `picked "Accepted" (the select read "${before}"), confirmed the dialog; PUT …/status → ${resp.status()}${j?.code ? ` ${j.code}` : ''}; alert: "${alertText.slice(0, 220)}"; toast: "${toast.slice(0, 120)}"; ` +
            `the server's message shown: ${msgShown}; the list re-read: ${listReloaded}; Q's row still listed after it: ${stays}; its select shows "${after}"; stored status "${stored0}" → "${stored}"; ` +
            `created for Q: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s); the copy: ${countsText(counts0)} → ${countsText(counts1)}`,
          verdict: verdict(resp.status() === 409 && j?.code === 'INVESTOR_RECORD_CONFLICT' && msgShown && stays && after === stored && stored === stored0 &&
            !made.users.length && !made.investors.length && !made.trucks.length && sameCounts(counts0, counts1)),
          shot: s,
        }
      })

    // ---- F7d: an acceptance over an existing account says so on the page
    // C's email is QA-TEST account A's. F6b accepted C through the API; C is put back at
    // the status it had before F6b (page fetch), so "Accepted" can be picked in its row.
    // The server answers 200 accountCreated:false and creates nothing; the page shows its
    // message in the on-page notice (and a warning toast), and the row reads Accepted.
    await step('F7d', 'Super Admin picks "Accepted" in QA-TEST application C\'s row (its email is already QA-TEST account A\'s) and confirms the dialog',
      `200 accountCreated:false with the message "${existingInvestorMsg('<A\'s id>')}"; the on-page notice (data-test="application-status-notice") shows it; C's row reads Accepted; no credentials dialog; nothing created; an accept_investor_existing_account audit row for C`, sa, 'f7d-accept-existing-account', async () => {
        if (!st.apps.C) throw skip('application C was not created')
        const resetTo = st.cStatus0 && st.cStatus0 !== 'Accepted' ? st.cStatus0 : 'New'
        let resetNote = `C was "${statusOf('C')}"`
        if (statusOf('C') === 'Accepted') {
          const r0 = await api(sa, 'PUT', `/api/investor-applications/${st.apps.C}/status`, { status: resetTo })
          resetNote += `; put back to "${resetTo}" by page fetch → ${codeOf(r0)}`
          if (r0.status !== 200 || statusOf('C') !== resetTo) throw new Error(`${resetNote}${errOf(r0)}: C could not be put back, so "Accepted" cannot be picked`)
        }
        const stored0 = statusOf('C')
        const counts0 = madeCounts()
        const mark = auditMark()
        await sa.goto(`${BASE_URL}/investor-applications`)
        const row = appRow(sa, emailOf.C)
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        const select = row.locator('select')
        const before = await select.inputValue()
        const statusPath = `/api/investor-applications/${st.apps.C}/status`
        const respP = sa.waitForResponse((r) => pathOf(r.url()) === statusPath && r.request().method() === 'PUT', { timeout: 30000 })
        respP.catch(() => {})
        await caption(sa, 'Step F7d — pick "Accepted" in application C\'s row (C\'s email is already on QA-TEST account A)', false)
        await select.selectOption('Accepted')
        const dlg = sa.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /Accept application/i }).first()
        await dlg.waitFor({ state: 'visible', timeout: 10000 })
        const reloaded = nextListLoad(sa)
        await dlg.getByRole('button', { name: 'Accept', exact: true }).click()
        const resp = await respP
        const j = await resp.json().catch(() => null)
        const toastEl = sa.locator('.toast-container .toast.show')
        const toast = await toastText(sa, 4000)
        const toastWarning = toast ? await toastEl.evaluate((el) => el.classList.contains('warning')).catch(() => false) : false
        const listReloaded = await reloaded
        const notice = sa.locator('[data-test="application-status-notice"]')
        await notice.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
        const noticeText = norm(await notice.innerText().catch(() => ''))
        await sa.waitForTimeout(800)
        const stays = await row.isVisible().catch(() => false)
        const after = stays ? await select.inputValue() : '(row gone)'
        const credsShown = await sa.locator('[role="dialog"]', { hasText: 'Investor Account Created' }).isVisible().catch(() => false)
        const stored = statusOf('C')
        const made = trackApp('C')
        const counts1 = madeCounts()
        const audits = auditRowsFor('C', mark, 'accept_investor_existing_account')
        const msg = String(j?.message || '')
        const msgOk = msg === existingInvestorMsg(st.users.A?.id)
        const noticeShows = !!msg && noticeText.includes(norm(msg))
        await notice.scrollIntoViewIfNeeded().catch(() => {})
        await caption(sa, `Step F7d — PUT → ${resp.status()}; accountCreated ${j?.accountCreated}; the notice shows the server's message: ${noticeShows}; C's select "${after}", stored "${stored}"`)
        const s = await ifxShot(sa, 'f7d-accept-existing-account')
        return {
          observed: `${resetNote}; picked "Accepted" (the select read "${before}"), confirmed the dialog; PUT …/status → ${resp.status()}${j?.code ? ` ${j.code}` : ''}; accountCreated: ${j?.accountCreated}; existingUserId: ${j?.existingUserId} (account A is #${st.users.A?.id}); ` +
            `message: "${msg.slice(0, 320)}" (the expected wording: ${msgOk}); notice: "${noticeText.slice(0, 360)}" (shows the server's message: ${noticeShows}); toast${toastWarning ? ' (warning)' : ''}: "${toast.slice(0, 160)}"; ` +
            `the list re-read: ${listReloaded}; C's row listed: ${stays}, its select "${after}"; stored status "${stored0}" → "${stored}"; credentials dialog shown: ${credsShown}; ` +
            `created for C: ${made.users.length} account(s), ${made.investors.length} investor record(s), ${made.trucks.length} truck(s); the copy: ${countsText(counts0)} → ${countsText(counts1)}; accept_investor_existing_account audit rows for C: ${audits.length}`,
          verdict: verdict(resp.status() === 200 && j?.accountCreated === false && msgOk && noticeShows && stays && after === 'Accepted' && stored === 'Accepted' &&
            !credsShown && !made.users.length && !made.investors.length && !made.trucks.length && sameCounts(counts0, counts1) && audits.length === 1),
          shot: s,
        }
      })

    // ---- F7c: a status change on a removed application is refused
    // E is removed (API soft delete) while the open list still shows it. The refusal
    // re-reads the list, which no longer has E: its row going away is the expected end.
    await step('F7c', 'Refused save on a removed application: QA-TEST application E is removed (API soft delete; the open list is not refreshed), then "Reviewed" is picked in its still-listed row',
      'The server refuses it (409 APPLICATION_DELETED) and the page shows the server\'s message; after the list reloads E\'s row is gone (or, if still listed, its select shows the stored status)', sa, 'f7c-removed-refused', async () => {
        if (!st.apps.E) throw skip('application E (F13) was not created')
        await sa.goto(`${BASE_URL}/investor-applications`)
        const row = appRow(sa, EMAIL('E'))
        await row.waitFor({ state: 'visible', timeout: 30000 })
        await row.scrollIntoViewIfNeeded()
        const before = await row.locator('select').inputValue()
        const del = await api(sa, 'DELETE', `/api/investor-applications/${st.apps.E}`)
        await sa.waitForTimeout(1500)
        if (!(await row.isVisible())) throw skip(`the list refreshed after the delete (${codeOf(del)}), so there is no stale row to pick in`)
        const statusPath = `/api/investor-applications/${st.apps.E}/status`
        uiProbe('F7c', 'PUT', new RegExp(`^${statusPath}$`))
        const onDialog = (d) => d.accept().catch(() => {})
        sa.on('dialog', onDialog)
        try {
          await caption(sa, `Step F7c — application E removed (DELETE → ${codeOf(del)}); pick "Reviewed" in its still-listed row`)
          const reloaded = nextListLoad(sa)
          const [resp] = await Promise.all([
            sa.waitForResponse((r) => pathOf(r.url()) === statusPath && r.request().method() === 'PUT', { timeout: 30000 }),
            row.locator('select').selectOption('Reviewed'),
          ])
          const j = await resp.json().catch(() => null)
          const toast = await toastText(sa, 4000)
          const alert = statusAlert(sa, /was not set to Reviewed/)
          await alert.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
          const alertText = norm(await alert.innerText().catch(() => ''))
          const listReloaded = await reloaded
          await sa.waitForTimeout(1000)
          const gone = listReloaded && (await row.count()) === 0
          const after = gone ? '(row gone)' : await row.locator('select').inputValue({ timeout: 5000 }).catch(() => '(unreadable)')
          const stored = statusOf('E')
          const deletedAt = !!q1('SELECT deleted_at FROM investor_applications WHERE id = ?', st.apps.E)?.deleted_at
          const msgShown = !!j?.error && alertText.includes(norm(j.error))
          await caption(sa, `Step F7c — PUT → ${resp.status()}${j?.code ? ` ${j.code}` : ''}; the server's message shown: ${msgShown}; E's row after the reload: ${gone ? 'gone' : `select "${after}"`}`)
          const s = await ifxShot(sa, 'f7c-removed-refused')
          return {
            observed: `DELETE → ${codeOf(del)} (removed: ${deletedAt}); PUT …/status "Reviewed" → ${resp.status()}${j?.code ? ` ${j.code}` : ''}; alert: "${alertText.slice(0, 220)}"; toast: "${toast.slice(0, 120)}"; ` +
              `the server's message shown: ${msgShown}; the list re-read: ${listReloaded}; E's row after it: ${gone ? 'gone (the list no longer has the removed application)' : `still listed, select "${after}" (was "${before}")`}; stored status "${stored}"`,
            verdict: verdict(resp.status() === 409 && j?.code === 'APPLICATION_DELETED' && msgShown && stored === before && (gone || after === stored)),
            shot: s,
          }
        } finally { sa.off('dialog', onDialog) }
      })

    // ---- F12a: the account-number eye
    await step('F12a', 'Super Admin opens accepted QA-TEST application P\'s investor record on /investors; Banking → the eye beside the account number',
      'The eye does not pretend to reveal: it shows the full number (a real reveal) or is not there', sa, 'f12a-account-eye', async () => {
        if (!st.apps.P || !q1('SELECT id FROM investors WHERE application_id = ?', st.apps.P)) throw skip('application P has no investor record')
        await sa.goto(`${BASE_URL}/investors`)
        const row = invRow(sa, NAME('SAME')).first()
        await row.waitFor({ state: 'visible', timeout: 60000 })
        await row.scrollIntoViewIfNeeded()
        await row.locator('td.name-cell').click()
        const modal = detailModal(sa)
        const acct = modal.locator('.detail-label', { hasText: 'Account Number' }).locator('xpath=..')
        await acct.waitFor({ state: 'visible', timeout: 30000 })
        await acct.scrollIntoViewIfNeeded()
        const before = norm(await acct.locator('.detail-value').innerText())
        const eye = acct.locator('svg')
        const hasEye = await eye.count()
        let after = before
        if (hasEye) { await eye.first().click(); await sa.waitForTimeout(700); after = norm(await acct.locator('.detail-value').innerText()) }
        const full = q1('SELECT account_number FROM investor_payment_info WHERE application_id = ?', st.apps.P)?.account_number || ''
        const revealed = !!full && after.includes(full)
        await caption(sa, `Step F12a — account number "${before}" → after the eye "${after}"; the full (QA-TEST) number shown: ${revealed}`)
        return { observed: `before: "${before}"; eye present: ${hasEye > 0}; after clicking it: "${after}"; the full QA-TEST account number shown: ${revealed}; still masked (${BULLET}): ${after.includes(BULLET)}`, verdict: verdict(!hasEye || revealed) }
      })

    // ---- F14: the public onboarding banking route
    // New applications get no access token (the token routes were removed, and so was
    // minting one), so the request carries a well-formed random one, in the shape the
    // removed routes checked (a UUID, in the query and the body): the route must be gone
    // whatever token is sent. Never printed.
    await step('F14', 'A public page (no session) sends POST /api/public/investor-onboarding/<P>/banking for accepted QA-TEST application P, with a well-formed random access token (new applications get none; never printed)',
      '404: the route no longer exists, whatever token is sent; P\'s bank row unchanged', pub2, 'f14-public-banking', async () => {
        if (!st.apps.P) throw skip('application P was not created')
        // The column defaults to '' now that nothing mints a token: '' or NULL is none.
        const stored = q1('SELECT access_token FROM investor_applications WHERE id = ?', st.apps.P)?.access_token || ''
        const tok = crypto.randomUUID()
        const bank = () => q1('SELECT bank_name, account_type, routing_number, account_number FROM investor_payment_info WHERE application_id = ?', st.apps.P)
        const before = bank()
        const stBefore = q1('SELECT status FROM investor_applications WHERE id = ?', st.apps.P)?.status
        await pub2.goto(`${BASE_URL}/invest`)
        await pub2.waitForLoadState('load')
        const r = await pub2.evaluate(async ({ id, tok }) => {
          const res = await fetch(`/api/public/investor-onboarding/${id}/banking?token=${encodeURIComponent(tok)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-QA-Probe': 'F14' },
            body: JSON.stringify({ accessToken: tok, bank_name: 'QA-TEST CHANGED BANK', account_type: 'Savings', routing_number: '999999999', account_number: '000999888777', account_name: 'QA-TEST changed' }),
          })
          let json = null
          try { json = await res.json() } catch { /* not json */ }
          return { status: res.status, json }
        }, { id: st.apps.P, tok })
        const after = bank()
        const changed = JSON.stringify(before) !== JSON.stringify(after)
        const stAfter = q1('SELECT status FROM investor_applications WHERE id = ?', st.apps.P)?.status
        const observed = `P's stored access token: ${stored ? 'present (not used, not printed)' : 'none'}; sent a random UUID token → ${codeOf(r)}${errOf(r)}; P's bank row ${changed ? `CHANGED (bank name now "${after?.bank_name}")` : 'unchanged'}; application status ${stBefore} → ${stAfter}`
        await caption(pub2, `Step F14 — ${observed}`)
        await evidence(pub2, ['F14 — public page, no session, page fetch', `POST /api/public/investor-onboarding/${st.apps.P}/banking?token=<a random UUID>`, `→ ${codeOf(r)}`, `P's bank row changed: ${changed}`])
        return { observed, verdict: verdict(r.status === 404 && !changed) }
      })

    // ---- F12c: a refused delete shows the server's reason
    await step('F12c', `Super Admin removes ${NAME('REC')} on /investors after it was already deleted (removed in the copy; the list not refreshed). DELETE /api/investors/:id has no other refusal: it answers 404 only for an id it cannot find`,
      'The page shows the server\'s reason ("Investor not found"), not a generic failure', sa, 'f12c-delete-refused', async () => {
        if (!st.recId) throw skip('F5 made no record')
        await sa.goto(`${BASE_URL}/investors`)
        const row = invRow(sa, NAME('REC'))
        await row.waitFor({ state: 'visible', timeout: 60000 })
        await row.scrollIntoViewIfNeeded()
        const n = db.prepare('DELETE FROM investors WHERE id = ?').run(st.recId).changes
        ifxForget('investors', st.recId)
        await caption(sa, `Step F12c — ${NAME('REC')} was just removed in the copy; press Remove on its stale row, then Delete`)
        uiProbe('F12c', 'DELETE', new RegExp(`^/api/investors/${st.recId}$`))
        await row.locator('button.btn-remove').click()
        const dlg = sa.locator('.confirm-dialog', { hasText: 'Delete Investor' })
        await dlg.waitFor({ state: 'visible', timeout: 10000 })
        const [resp] = await Promise.all([
          sa.waitForResponse((r) => pathOf(r.url()) === `/api/investors/${st.recId}` && r.request().method() === 'DELETE', { timeout: 30000 }),
          dlg.locator('button.btn-danger').click(),
        ])
        const j = await resp.json().catch(() => null)
        const toast = await toastText(sa, 4000)
        await caption(sa, `Step F12c — DELETE → ${resp.status()} "${j?.error || ''}"; the page says "${toast}"`, false)
        const s = await ifxShot(sa, 'f12c-delete-refused')
        return { observed: `removed in the copy (${n} row); DELETE → ${resp.status()} "${j?.error || ''}"; toast: "${toast}"`, verdict: verdict(resp.status() >= 400 && !!j?.error && toast.includes(j.error)), shot: s }
      })
  } finally {
    // ---- FXc: every failing resource and console error on the screens this section opened
    // Each failing resource with its page, method, path and status, split by source: the
    // run's own probes (its page fetches carry X-QA-Probe; a UI request a step makes on
    // purpose is registered by uiProbe) and the harness's logisx.com block, apart from
    // what the app sent by itself. A "Failed to load resource" console line is matched
    // to its resource by path; any other console error is listed with its text.
    {
      const idOf = (p) => String(p).replace(/\/\d+(?=\/|$)/g, '/:id')
      const tally = (rows) => {
        const m = new Map()
        for (const f of rows) {
          const k = `${f.who} on ${idOf(f.where)}: ${f.method} ${f.path} → ${f.status}${f.source === 'app' ? '' : ` [${f.source}]`}`
          m.set(k, (m.get(k) || 0) + 1)
        }
        return [...m].map(([k, n]) => `${k} ×${n}`).join('; ') || 'none'
      }
      const fromApp = failed.filter((f) => f.source === 'app')
      const fromRun = failed.filter((f) => f.source !== 'app')
      const lines = [`failing resources the app sent by itself: ${tally(fromApp)}`, `failing resources from the run's own probes: ${tally(fromRun)}`]
      const resLines = consoleErrs.filter((e) => e.res)
      const bySource = new Map()
      const unmatched = new Map()
      for (const e of resLines) {
        const hit = failed.find((f) => f.who === e.who && f.path === e.res)
        const k = hit ? (hit.source === 'app' ? 'the app' : 'the run\'s probes') : `${e.who}: ${e.res}`
        const into = hit ? bySource : unmatched
        into.set(k, (into.get(k) || 0) + 1)
      }
      lines.push(`console "Failed to load resource" lines: ${resLines.length}${resLines.length ? ` (${[...bySource].map(([k, n]) => `${n} from ${k}`).join(', ') || 'none matched'}${unmatched.size ? `; not matched to a failing response: ${[...unmatched].map(([k, n]) => `${k} ×${n}`).join('; ')}` : ''})` : ''}`)
      const groups = new Map()
      for (const e of consoleErrs.filter((x) => !x.res)) {
        const k = `${e.who} ${idOf(e.where)}`
        if (!groups.has(k)) groups.set(k, { n: 0, texts: new Set() })
        const gr = groups.get(k); gr.n++
        if (gr.texts.size < 3) gr.texts.add(visible(e.text).replace(/\s+/g, ' ').slice(0, 170))
      }
      lines.push(`other console errors: ${[...groups].map(([k, gr]) => `${k}: ${gr.n} — ${[...gr.texts].map((t) => `"${t}"`).join(' | ')}`).join(' · ') || 'none'}`)
      record({ step: 'FXc', title: 'Failing resources and browser console errors (console.error and uncaught) on /invest, /investors, /investor-applications, /investor-portals, Admin Tools, Expenses and the QA-TEST investors\' portal, each marked as the run\'s own probe or the app\'s', expected: '(recorded, not scored)', observed: lines.join(' · '), verdict: 'INFO', shot: '' })
    }
    // ---- FXz: remove everything this section made (the API first, then the copy by exact id)
    apiProbeTag = 'FXz'
    const notes = []
    for (const c of contexts.slice(1)) await c.close().catch(() => {})
    try {
      if (sa && !sa.isClosed()) {
        for (const r of ifxRows.filter((x) => x.table === 'legal_documents')) {
          const d = await api(sa, 'DELETE', `/api/legal-documents/${r.id}`)
          if (d.status === 200 || d.status === 404) ifxForget('legal_documents', r.id)
          notes.push(`DELETE /api/legal-documents/${r.id} → ${d.status}`)
        }
        for (const r of ifxRows.filter((x) => x.table === 'trucks')) {
          const d = await api(sa, 'DELETE', `/api/trucks/${r.id}`)
          if (d.status === 200) ifxForget('trucks', r.id)
          notes.push(`DELETE /api/trucks/${r.id} → ${codeOf(d)}`)
        }
        for (const r of ifxRows.filter((x) => x.table === 'investors')) {
          const d = await api(sa, 'DELETE', `/api/investors/${r.id}`)
          if (d.status === 200 || d.status === 404) ifxForget('investors', r.id)
          notes.push(`DELETE /api/investors/${r.id} → ${d.status}`)
        }
        for (const r of ifxRows.filter((x) => x.table === 'users')) {
          const d = await api(sa, 'DELETE', `/api/users/${r.id}`)
          if (d.status === 200 || d.status === 404) ifxForget('users', r.id)
          notes.push(`DELETE /api/users/${r.id} → ${codeOf(d)}`)
        }
        for (const r of ifxRows.filter((x) => x.table === 'investor_applications')) {
          const d = await api(sa, 'DELETE', `/api/investor-applications/${r.id}`)
          notes.push(`DELETE /api/investor-applications/${r.id} (soft) → ${d.status}`)
        }
      } else notes.push('no Super Admin page: the API clean-up was skipped')
    } catch (e) { notes.push(`API clean-up error: ${e.message}`) }
    let ok = true
    try {
      // Catch-up by name, in case a step died between a create and its note.
      for (const r of qa('SELECT id FROM investor_applications WHERE id > ? AND legal_name LIKE ?', start.investor_applications || 0, `QA-TEST-INV-${TU}-%`)) ifxNote({ table: 'investor_applications', id: r.id })
      for (const r of qa('SELECT id FROM users WHERE id > ? AND (email LIKE ? OR username LIKE ?)', start.users || 0, `qa-test+${T}-%`, `qa-test-inv-${T}-%`)) ifxNote({ table: 'users', id: r.id })
      for (const r of qa('SELECT id FROM investors WHERE id > ? AND full_name LIKE ?', start.investors || 0, `QA-TEST-INV-${TU}-%`)) ifxNote({ table: 'investors', id: r.id })
      for (const r of qa('SELECT id FROM trucks WHERE id > ? AND unit_number LIKE ?', start.trucks || 0, `QA-TEST-INV-${TU}-%`)) ifxNote({ table: 'trucks', id: r.id })
      for (const a of Object.values(st.apps).filter(Boolean)) for (const r of qa('SELECT id FROM trucks WHERE unit_number LIKE ?', `INV-${a}-%`)) ifxNote({ table: 'trucks', id: r.id })
      for (const r of qa('SELECT id FROM legal_documents WHERE id > ? AND file_name LIKE ?', start.legal_documents || 0, `qa-test-legal-${T}-%`)) ifxNote({ table: 'legal_documents', id: r.id })
      const owners = [...new Set([...ifxUserIds, ...Object.values(st.users).map((u) => u.id)])]
      notes.push(...ifxRemoveRowsSync())
      for (const t of ['investor_config', 'investor_payouts', 'investor_payout_history']) {
        let n = 0
        for (const o of owners) n += db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(o).changes
        if (n) notes.push(`${t}: ${n} row(s) of the QA-TEST accounts deleted in the copy`)
      }
      // Rows the app wrote as a side effect of this section, on this private server only.
      for (const t of ['audit_trail', 'dispatch_notifications']) {
        if (start[t] == null) continue
        const n = db.prepare(`DELETE FROM ${t} WHERE rowid > ?`).run(start[t]).changes
        if (n) notes.push(`${t}: ${n} row(s) written during the section deleted in the copy`)
      }
      if (globalOf('investor_split_pct') !== splitAtStart) {
        db.prepare("UPDATE investor_config SET value = ? WHERE owner_id = 0 AND key = 'investor_split_pct'").run(splitAtStart)
        notes.push(`the global split was not "${splitAtStart}": put back in the copy`)
      }
      // What is still above the start mark, by table (sessions and the like are expected).
      const now = ifxMaxRowids()
      const grew = Object.keys(now).filter((t) => start[t] != null && now[t] > start[t])
        .map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}" WHERE rowid > ?`).get(start[t]).n]).filter(([, n]) => n > 0)
      notes.push(`rows still above the start mark: ${grew.map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`)
      if (start.investor_config != null) {
        const cfg = qa('SELECT owner_id, key FROM investor_config WHERE rowid > ?', start.investor_config)
        if (cfg.length) notes.push(`investor_config above the mark: ${cfg.map((c) => `owner ${c.owner_id} ${c.key}`).join(', ')} (a global row an INSERT OR REPLACE re-wrote with its original value)`)
      }
      const left = {
        users: q1('SELECT COUNT(*) AS n FROM users WHERE email LIKE ? OR username LIKE ?', `qa-test+${T}-%`, `qa-test-inv-${T}-%`).n,
        investors: q1('SELECT COUNT(*) AS n FROM investors WHERE full_name LIKE ?', `QA-TEST-INV-${TU}-%`).n,
        applications: q1('SELECT COUNT(*) AS n FROM investor_applications WHERE legal_name LIKE ?', `QA-TEST-INV-${TU}-%`).n,
        trucks: q1('SELECT COUNT(*) AS n FROM trucks WHERE unit_number LIKE ?', `QA-TEST-INV-${TU}-%`).n,
        legal: q1('SELECT COUNT(*) AS n FROM legal_documents WHERE file_name LIKE ?', `qa-test-legal-${T}-%`).n,
      }
      const leftN = Object.values(left).reduce((a, b) => a + b, 0)
      notes.push(`QA-TEST rows left: ${leftN ? JSON.stringify(left) : 'none'}; the global split: "${globalOf('investor_split_pct')}"`)
      if (leftN || ifxRows.length || globalOf('investor_split_pct') !== splitAtStart) ok = false
    } catch (e) { ok = false; notes.push(`copy clean-up error: ${e.message}`) }
    record({ step: 'FXz', title: 'Clean-up: every QA-TEST account, investor record, truck, legal document and application this section made, its planted rows and side rows', expected: 'All removed; the global split as it was at the start; no plant journal left', observed: `${notes.join('; ')}; plant journal ${fs.existsSync(JOURNAL) ? 'STILL PRESENT' : 'gone'}`, verdict: verdict(ok && !fs.existsSync(JOURNAL)), shot: '' })
    for (const c of contexts) await c.close().catch(() => {})
    apiProbeTag = null
    if (ownDb && db) { try { db.close() } catch { /* ignore */ } db = null }
  }
}

let exitCode = 0
try {
  await main()
} catch (e) {
  exitCode = 1
  record({ step: '!', title: 'Run aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
} finally {
  await cleanup()
  writeResults(true)
  console.log(`\nresults: ${RESULTS}\nscreenshots: ${SHOTS}`)
}
process.exit(exitCode)
