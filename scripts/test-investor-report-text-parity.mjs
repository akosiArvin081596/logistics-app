#!/usr/bin/env node
// The report range hint in the investor portal is the server's own sentence.
//
// lib/investor-report-options.js holds RANGE_HINT, the one place the owner or
// client edits it, and RANGE_MODE, which GET /api/investor sends as
// `reportRangeMode`. client/src/lib/investorReportText.js keeps a copy of the
// hint and decides when to show it (rangeHintFor()). Two copies of one
// sentence drift: the portal would then explain the range one way while the
// report's own note says another.
//
// Part 1 checks the client module on its own: the hint shows for
// 'whole-months' only, and for nothing else, a missing field included.
// Part 2 compares it with the lib: the same RANGE_HINT, character for
// character, and a RANGE_MODE the client knows. Each part has sabotage
// controls, altered copies that must be reported, which prove its comparison
// can fail.
//
// Until lib/investor-report-options.js exists on the branch (the server half
// of the same change), part 2 SKIPs with a message and the runner exits on
// part 1 alone.
//
// No network, no DB, no server — safe anywhere.
//   node scripts/test-investor-report-text-parity.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const LIB_PATH = path.join(__dirname, '..', 'lib', 'investor-report-options.js')
const CLIENT_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'investorReportText.js')
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, 'utf8')
const client = await import(pathToFileURL(CLIENT_PATH).href)

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}

const MODES = ['whole-months', 'exact-dates']
const NOT_MODES = [undefined, null, '', 'Whole-Months', 'whole_months', ' whole-months']
const j = (v) => (v === undefined ? 'undefined' : JSON.stringify(v))
const list = (items) => (items.length ? `:\n        ${items.join('\n        ')}` : '')

// A copy of the client module with one edit. Anchored on the code's shape, not
// the sentence, so rewording the hint in both files never breaks a control.
async function sabotagedClient(from, to) {
  const found = from instanceof RegExp ? from.test(CLIENT_SRC) : CLIENT_SRC.includes(from)
  if (!found) throw new Error(`sabotage anchor not found: ${from}`)
  return import(`data:text/javascript,${encodeURIComponent(CLIENT_SRC.replace(from, to))}`)
}

// ══ Part 1: the client module on its own ═════════════════════════════════════
function clientProblems(c) {
  const out = []
  if (typeof c.RANGE_HINT !== 'string' || !c.RANGE_HINT.trim()) out.push(`RANGE_HINT is not a sentence: ${j(c.RANGE_HINT)}`)
  if (c.rangeHintFor('whole-months') !== c.RANGE_HINT) out.push(`rangeHintFor('whole-months') is ${j(c.rangeHintFor('whole-months'))}, not RANGE_HINT`)
  for (const mode of ['exact-dates', ...NOT_MODES]) {
    if (c.rangeHintFor(mode) !== '') out.push(`rangeHintFor(${j(mode)}) shows ${j(c.rangeHintFor(mode))}`)
  }
  return out
}

const own = clientProblems(client)
ok(`the client shows the hint for 'whole-months' only (${own.length} problem(s))${list(own)}`, own.length === 0)
ok('the client module is pure (no imports)', !/^\s*import\s/m.test(CLIENT_SRC))
ok('the client copy names its canonical source', CLIENT_SRC.includes('lib/investor-report-options.js'))

const CLIENT_ONLY_CONTROLS = [
  ["the client testing a misspelled 'whole-months'", "mode === 'whole-months'", "mode === 'whole_months'"],
  ['the client showing the hint in every mode', "mode === 'whole-months' ? RANGE_HINT : ''", 'RANGE_HINT'],
  ['an empty client hint', /^export const RANGE_HINT = '.*'$/m, "export const RANGE_HINT = ''"],
]
for (const [label, from, to] of CLIENT_ONLY_CONTROLS) {
  ok(`SABOTAGE: ${label} is reported`, clientProblems(await sabotagedClient(from, to)).length > 0)
}

// ══ Part 2: the client against the lib ═══════════════════════════════════════
function differences(c, l) {
  const out = []
  if (c.RANGE_HINT !== l.RANGE_HINT) out.push(`RANGE_HINT: client ${j(c.RANGE_HINT)}, server ${j(l.RANGE_HINT)}`)
  if (!MODES.includes(l.RANGE_MODE)) out.push(`RANGE_MODE: the server's ${j(l.RANGE_MODE)} is not one the client knows (${MODES.join(', ')})`)
  for (const mode of MODES) {
    const want = mode === 'whole-months' ? l.RANGE_HINT : ''
    const got = c.rangeHintFor(mode)
    if (got !== want) out.push(`rangeHintFor(${j(mode)}): client ${j(got)}, expected ${j(want)}`)
  }
  return out
}

if (!fs.existsSync(LIB_PATH)) {
  ok('lib/investor-report-options.js exists (the canonical copy of the hint and the switches)', false)
} else {
  const lib = require(LIB_PATH)
  const real = differences(client, lib)
  ok(`the client copy agrees with the server (${real.length} difference(s))${list(real)}`, real.length === 0)

  // These run only while the real pair agrees. A pair that already differs has
  // shown the comparison can fail, and a sabotage can then undo the drift by
  // chance (a trailing space added to one side when the other already has one)
  // and read as a second failure.
  const CLIENT_CONTROLS = [
    ['a word added to the client hint', "export const RANGE_HINT = '", "export const RANGE_HINT = 'Note: "],
    ['a trailing space on the client hint', /^(export const RANGE_HINT = '.*)'$/m, "$1 '"],
    ["the client testing a misspelled 'whole-months'", "mode === 'whole-months'", "mode === 'whole_months'"],
  ]
  const LIB_CONTROLS = [
    ["the server hint's last character dropped", { ...lib, RANGE_HINT: String(lib.RANGE_HINT).slice(0, -1) }],
    ['an unknown server mode', { ...lib, RANGE_MODE: 'whole_months' }],
  ]
  if (real.length) {
    console.log('SKIP  part 2 sabotage controls: the real pair already differs (reported above).')
  } else {
    for (const [label, from, to] of CLIENT_CONTROLS) {
      ok(`SABOTAGE: ${label} is reported`, differences(await sabotagedClient(from, to), lib).length > 0)
    }
    for (const [label, sabotagedLib] of LIB_CONTROLS) {
      ok(`SABOTAGE: ${label} is reported`, differences(client, sabotagedLib).length > 0)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
