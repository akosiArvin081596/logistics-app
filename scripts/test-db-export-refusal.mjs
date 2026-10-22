#!/usr/bin/env node
/**
 * scripts/test-db-export-refusal.mjs — what the Admin Tools "Download database
 * backup" button says when the server refuses the export (decision D9,
 * 2026-10-22).
 *
 * The server limits the export to the accounts in RATECON_PDF_VIEWER_IDS and
 * answers everyone else 403 DB_DOWNLOAD_RESTRICTED with its own sentence. The
 * button stays visible; on that refusal it shows "Not available for this
 * account." and the server's sentence, and drops the cross-site hint ("open
 * LogisX directly"), which is wrong for this refusal. Any other 403 keeps
 * today's wording and hint.
 *
 * client/src/lib/dbExportRefusal.js decides the text; AdminToolsView.vue's
 * describeDbExportFailure() must use it for a 403.
 *
 * Run: node scripts/test-db-export-refusal.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
function ok(name, cond) {
  if (cond) { passed++; console.log(`ok    ${name}`) }
  else { failed++; console.log(`FAIL  ${name}`) }
}

let lib = null
try {
  lib = await import(path.join(ROOT, 'client', 'src', 'lib', 'dbExportRefusal.js'))
} catch (e) {
  ok(`client/src/lib/dbExportRefusal.js loads (${e.code || e.message})`, false)
}

const RESTRICTED = 'Downloading the database is limited to the owner.'
const SIGN_IN = 'Your session is out of date. Sign in again to download the database.'
const CROSS_SITE_HINT = 'Open LogisX directly rather than through a link from another site, then try again.'

if (lib) {
  const t = lib.dbExportRefusalText
  ok('exports dbExportRefusalText()', typeof t === 'function')
  if (typeof t === 'function') {
    const a = t(403, { code: 'DB_DOWNLOAD_RESTRICTED', error: RESTRICTED })
    ok(`403 DB_DOWNLOAD_RESTRICTED: "Not available for this account." and the server's sentence, no hint (${JSON.stringify(a)})`,
      !!a && a.title === 'Not available for this account.' && a.error === RESTRICTED && a.hint === '')
    const b = t(403, { code: 'DB_DOWNLOAD_RESTRICTED', error: SIGN_IN })
    ok(`...the sign-in-again sentence is shown as sent (${JSON.stringify(b)})`, !!b && b.error === SIGN_IN && b.hint === '')
    const c = t(403, { code: 'DB_DOWNLOAD_RESTRICTED' })
    ok(`...with no sentence from the server, its own (${JSON.stringify(c)})`, !!c && c.error === RESTRICTED && c.hint === '')
    const d = t(403, { code: 'DB_DOWNLOAD_RESTRICTED', error: { not: 'text' } })
    ok(`...a sentence that isn't text is never shown (${JSON.stringify(d)})`, !!d && d.error === RESTRICTED)
    const e = t(403, { error: 'Forbidden' })
    ok(`any other 403 keeps today's wording and hint (${JSON.stringify(e)})`, !!e && e.title === 'Refused.' && e.error === 'Forbidden' && e.hint === CROSS_SITE_HINT)
    const f = t(403, {})
    ok(`...and today's fallback sentence (${JSON.stringify(f)})`, !!f && f.error === 'The export is available to Super Admins, from this site only.' && f.hint === CROSS_SITE_HINT)
    ok('not a 403: no answer here (the view handles 401, 405, 429 and the rest)', t(401, {}) === null && t(429, {}) === null && t(500, { code: 'DB_DOWNLOAD_RESTRICTED' }) === null)
  }
}

const view = fs.readFileSync(path.join(ROOT, 'client', 'src', 'views', 'AdminToolsView.vue'), 'utf8')
ok('AdminToolsView.vue imports dbExportRefusalText', /import \{[^}]*\bdbExportRefusalText\b[^}]*\} from '\.\.\/lib\/dbExportRefusal'/.test(view))
const fnAt = view.indexOf('async function describeDbExportFailure(')
const fnBody = fnAt < 0 ? '' : view.slice(fnAt, view.indexOf('\n}\n', fnAt))
ok('...and describeDbExportFailure() uses it', /dbExportRefusalText\(/.test(fnBody))
ok('...and no longer hard-codes the cross-site hint', !fnBody.includes(CROSS_SITE_HINT))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
