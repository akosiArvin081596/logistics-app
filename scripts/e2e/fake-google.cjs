// The Google stand-in for the browser harness's server: boot-server.sh preloads this
// file into `node server.js` alone (NODE_OPTIONS --require), so the e2e server never
// reads a Google key or a .env file and never opens a connection to Google.
//
//   - require("googleapis") answers a stand-in; the real googleapis is never loaded.
//       google.sheets()   lib/replica-sheets.js (the local replica's Sheets stub) over
//                         E2E_FAKE_SHEETS_FILE: the work dir's copy of the made-up
//                         fixture (scripts/e2e/fixtures/e2e-sheets.json) that
//                         boot-server.sh makes. Every read comes from that file and
//                         every write is saved to it.
//       google.drive()    refuses every call with a 403, as a folder the account
//                         cannot reach would.
//       GoogleAuth        never reads its keyFile; getClient() answers a stand-in.
//       google.options()  keeps nothing.
//   - dotenv's config() loads nothing, so a .env in the worktree is never read.
//     boot-server.sh puts its made-up settings on the server's command line instead.
//   - lib/replica-mode.js's file guard refuses any read of a .env file or a Google
//     service-account key, and logs each attempt to the server log.
//
// It installs only when E2E_FAKE_SHEETS_FILE is set (boot-server.sh sets it), and
// says so in one log line, which boot-server.sh waits for. Required without it, the
// file only defines createFakeGoogle(), for scripts/test-e2e-no-real-keys.js.
// Built-in modules and this checkout's lib/ only: it loads before the app.
'use strict'
const fs = require('fs')
const path = require('path')
const Module = require('module')

const LIB = path.resolve(__dirname, '..', '..', 'lib')
const { createFakeSheets } = require(path.join(LIB, 'replica-sheets.js'))

const READY_LINE = 'fake-google: googleapis is a stand-in (Sheets from the made-up fixture copy, Drive refused); dotenv loads nothing; .env and key reads refused'

// Shaped like a gaxios error, as lib/replica-sheets.js shapes its own.
function googleError(status, message) {
  const err = new Error(message)
  err.code = status
  err.status = status
  err.response = { status, data: { error: { code: status, message } } }
  return err
}

// Any drive.<resource>.<method>() rejects. `then` answers undefined so an
// `await getDrive()` resolves to the client instead of treating it as a promise.
function fakeDrive() {
  const named = (key) => typeof key === 'string' && key !== 'then'
  const resource = (name) => new Proxy({}, {
    get: (_t, method) => (named(method)
      ? async () => { throw googleError(403, `e2e: Google Drive is not available to the e2e server (${name}.${method})`) }
      : undefined),
  })
  return new Proxy({}, { get: (_t, name) => (named(name) ? resource(name) : undefined) })
}

function createFakeGoogle({ sheetsFile }) {
  let sheets = null
  const authClient = Object.freeze({ e2eFakeGoogle: true })
  class GoogleAuth {
    // The options (keyFile, scopes, clientOptions) are accepted and never used.
    async getClient() { return authClient }
  }
  const google = {
    options() {},
    auth: { GoogleAuth },
    sheets() {
      if (!sheets) sheets = createFakeSheets({ file: sheetsFile })
      return sheets
    },
    drive() { return fakeDrive() },
  }
  return { google }
}

function install(env) {
  const sheetsFile = String(env.E2E_FAKE_SHEETS_FILE || '')
  let st = null
  try { st = fs.lstatSync(sheetsFile) } catch { /* reported below */ }
  if (!path.isAbsolute(sheetsFile) || !st || !st.isFile()) {
    throw new Error(`fake-google: E2E_FAKE_SHEETS_FILE must name the work dir's sheet copy as a real file (got "${sheetsFile}")`)
  }
  const fake = createFakeGoogle({ sheetsFile })
  const load = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'googleapis') return fake
    return load.call(this, request, ...rest)
  }
  try {
    const dotenv = require(require.resolve('dotenv', { paths: [process.cwd()] }))
    const skipped = () => ({ parsed: {} })
    dotenv.config = skipped
    dotenv.configDotenv = skipped
  } catch { /* no dotenv installed here: nothing that could read a .env */ }
  require(path.join(LIB, 'replica-mode.js')).installFileGuard({
    record: (e) => console.error(`[fake-google] REFUSED ${e.via} ${e.target} (from ${e.caller})`),
  }, env)
  console.log(READY_LINE)
}

if (process.env.E2E_FAKE_SHEETS_FILE) install(process.env)

module.exports = { createFakeGoogle, fakeDrive, READY_LINE }
