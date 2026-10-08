#!/usr/bin/env node
// The client compares driver names by the server's own key.
//
// client/src/lib/driverName.js (normDriver) is the one client copy of
// normalizeDriverName() in server.js: trim, lowercase, every run of whitespace
// read as one space. The tracking map, the Active and Completed Loads tabs and
// the dashboard's busy-driver list all match names through it. If the two rules
// drifted, the client would list one driver twice, or file a ping, a load or an
// HOS clock under nobody, where the server sees one driver.
//
// (a) The server's function is lifted from server.js SOURCE (exactly one
// definition) and both are run on the same inputs. A sabotaged server copy
// without the whitespace collapse must be reported, which proves the
// comparison can fail. (b) No file under client/src keeps a private copy of
// the rule: a local `normDriver` or the inline trim/lowercase/collapse chain
// outside lib/driverName.js fails the run.
//
// No network, no DB, no server — safe anywhere.
//   node scripts/test-driver-name-key-parity.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const HELPER = path.join(CLIENT_SRC, 'lib', 'driverName.js')
const { normDriver } = await import(pathToFileURL(HELPER).href)

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}

// The server's function, evaluated from `src` (server.js, or a sabotaged copy).
function liftServerRule(src) {
  const head = '\nfunction normalizeDriverName(s) {'
  const hits = src.split(head).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of normalizeDriverName in server.js, found ${hits}`)
  const a = src.indexOf(head) + 1
  const end = src.indexOf('\n}', a)
  if (end < 0) throw new Error('no end found for normalizeDriverName')
  const code = src.slice(a, end + 2)
  return new Function(`"use strict";\n${code}\nreturn normalizeDriverName;`)()
}

// Whitespace the sheet, an ELD feed or a copied name can carry, built from code
// points so this file holds no invisible characters of its own.
const NBSP = String.fromCharCode(0xa0)
const EM_SPACE = String.fromCharCode(0x2003)
const BOM = String.fromCharCode(0xfeff)
const INPUTS = [
  undefined, null, '', ' ', '\t\n',
  'Roland Brown', 'roland brown', 'ROLAND BROWN',
  '  Roland   Brown  ', 'Roland\tBrown', 'Roland\nBrown', 'Roland \t \n Brown',
  `Roland${NBSP}Brown`, `${NBSP}Roland${EM_SPACE}${EM_SPACE}Brown${NBSP}`, `${BOM}Roland Brown`,
  'Mary Ann  De La Cruz', 'O\'Neil', 'José  Núñez',
]

function differences(serverRule) {
  return INPUTS.filter((s) => serverRule(s) !== normDriver(s))
}

// (a) parity with the server's rule
const serverRule = liftServerRule(SRC)
const diffs = differences(serverRule)
ok(`normDriver() matches normalizeDriverName() on every input (differs on ${JSON.stringify(diffs)})`, diffs.length === 0)
ok('two spacings of one name share a key', normDriver(' Roland  Brown') === normDriver('roland brown'))
ok('a blank name keys to the empty string', normDriver(null) === '' && normDriver('   ') === '')

// The comparison can fail: a server copy without the whitespace collapse.
const collapse = '.replace(/\\s+/g, " ")'
ok('server.js normalizeDriverName() carries the whitespace collapse', SRC.includes(`return (s || "").trim().toLowerCase()${collapse};`))
const sabotaged = liftServerRule(SRC.replace(`return (s || "").trim().toLowerCase()${collapse};`, 'return (s || "").trim().toLowerCase();'))
ok('sabotage: a server rule without the collapse is reported', differences(sabotaged).length > 0)

// (b) one client copy
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(vue|js|mjs|ts)$/.test(entry.name)) out.push(p)
  }
  return out
}
const LOCAL_DEF = /(?:const|let|var|function)\s+normDriver\b/
const INLINE_RULE = /\.trim\(\)\s*\.toLowerCase\(\)\s*\.replace\(\/\\s\+\/g,\s*['"] ['"]\)/
const copies = walk(CLIENT_SRC)
  .filter((f) => f !== HELPER)
  .filter((f) => {
    const text = fs.readFileSync(f, 'utf8')
    return LOCAL_DEF.test(text) || INLINE_RULE.test(text)
  })
  .map((f) => path.relative(ROOT, f))
ok(`no private copy of the driver-name rule in client/src (found in ${JSON.stringify(copies)})`, copies.length === 0)
ok('the scan recognises an inline copy', INLINE_RULE.test("(d || '').trim().toLowerCase().replace(/\\s+/g, ' ')"))
ok('the scan recognises a local definition', LOCAL_DEF.test('const normDriver = (s) => s'))

console.log(`driver-name key parity: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
