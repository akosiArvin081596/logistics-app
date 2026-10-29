#!/usr/bin/env node
// A stand-in for macOS's `security`, for a run with no Keychain (CI's Linux runner).
// ci-run.sh points keychain.cjs at it (E2E_SECURITY_BIN) with the Keychain service
// logisx-e2e-ci; nothing else uses it.
//
//   ci-keychain.cjs help
//   ci-keychain.cjs find-generic-password -s <service> [-a <account>] -w
//   ci-keychain.cjs -i      commands on stdin, one per line:
//                           add-generic-password -U -s "<service>" -a "<account>" -w "<password>"
//
// What it keeps: the passwords setup-db.cjs generated for this run's made-up logins
// (randomPassword(), new every run), in E2E_CI_KEYCHAIN_FILE, which must be a file
// inside the private work dir (paths.cjs workFile(): 0700, outside every checkout,
// not a symlink). The file is written 0600 and goes away with the work dir. A
// password is never printed except as find-generic-password -w's answer, which
// keychain.cjs reads into memory, as it reads the real Keychain's.
//
// Only the service logisx-e2e-ci is answered, so this file can never stand in for
// the local Keychain items (logisx-e2e-local) or a staging login (logisx-staging).
'use strict'
const fs = require('fs')
const paths = require('./paths.cjs')

const SERVICE = 'logisx-e2e-ci'
const NOT_FOUND = 44 // what /usr/bin/security answers for an item it does not hold

function fail(msg) {
  console.error(`ci-keychain: ${msg}`)
  return 1
}

function storeFile() {
  const f = process.env.E2E_CI_KEYCHAIN_FILE
  if (!f) throw new Error('E2E_CI_KEYCHAIN_FILE is not set (ci-run.sh sets it inside the work dir)')
  return paths.workFile(f, { mustExist: false })
}

// A parse error is reported without its message: Node quotes the text it could not
// parse, and that text holds passwords.
function load(file) {
  if (!fs.existsSync(file)) return []
  let items
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { items = null }
  if (!Array.isArray(items)) throw new Error(`${file} is not the stand-in's list of items`)
  return items
}

function save(file, items) {
  fs.writeFileSync(file, JSON.stringify(items) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

const opt = (args, flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : (args[i + 1] ?? null)
}

function run(args) {
  const [cmd] = args
  if (cmd === 'help') return 0
  if (cmd !== 'find-generic-password' && cmd !== 'add-generic-password') return fail(`unsupported command "${cmd || ''}"`)
  const service = opt(args, '-s')
  const account = opt(args, '-a')
  if (service !== SERVICE) return fail(`refusing the service "${service || ''}": this stand-in answers ${SERVICE} only`)
  const file = storeFile()
  const items = load(file)
  if (cmd === 'find-generic-password') {
    const it = items.find((x) => x.service === service && (account === null || x.account === account))
    if (!it) return NOT_FOUND
    if (args.includes('-w')) process.stdout.write(`${it.password}\n`)
    return 0
  }
  const password = opt(args, '-w')
  if (!account || !password) return fail('add-generic-password needs -a and -w')
  save(file, [...items.filter((x) => !(x.service === service && x.account === account)), { service, account, password }])
  return 0
}

// keychain.cjs quotes each value of an -i command line ("..."); its values never hold a quote.
const words = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]))

function main(argv) {
  try {
    if (argv[0] === '-i') {
      let code = 0
      for (const line of fs.readFileSync(0, 'utf8').split('\n').filter((l) => l.trim())) code = run(words(line)) || code
      return code
    }
    return run(argv)
  } catch (e) {
    return fail(e.message)
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { SERVICE, main }
