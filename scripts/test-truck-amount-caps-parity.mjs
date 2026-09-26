#!/usr/bin/env node
// Every ceiling the truck forms enforce is the server's own.
//
// client/src/lib/truckAmounts.js (AMOUNT_FIELDS) refuses an amount in the Add
// Truck form and the Edit Truck dialog before the save is sent, and server.js
// refuses it again at the boundary: TRUCK_AMOUNT_FIELDS (each row's `max`, else
// TRUCK_AMOUNT_MAX), DRIVER_PAY_DAILY_MAX and ADMIN_FEE_PCT_MAX. Two copies of
// one rule drift, and each direction costs something: a client ceiling above
// the server's lets a form send a value the server then refuses after the form
// has cleared; one below refuses a value the server would store.
//
// This reads the server's ceilings from server.js SOURCE — the statements
// lifted and evaluated, not a number matched by a pattern — imports the client
// module, maps every client key to the server column or constant that governs
// it, and fails on any difference, or on a field either side has that the
// other does not. The sabotage controls prove the comparison can fail: a copy
// of the server source with one ceiling changed, and client tables with a
// ceiling changed or a field dropped, must each be reported.
//
// (a) The same two sides must also READ an amount alike: the server's parsers
// (parsePlainDecimal() under each) and amountError() accept and refuse the
// same inputs, "0x10", "0b1" and "0o7" included. (b) No amount box in the
// Trucks forms may carry a literal `max` in place of AMOUNT_CAPS.
//
// No network, no DB, no server — safe anywhere.
//   node scripts/test-truck-amount-caps-parity.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
const { AMOUNT_MAX, AMOUNT_FIELDS } = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib', 'truckAmounts.js')).href)

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`) }
}

// A one-line `const NAME = …;`, or a block from its head to `close`. Anchored on
// a newline and counted, so a mention in a comment cannot be taken for the
// definition and a second copy fails the run instead of lifting either.
function liftConst(src, head, close = null) {
  const needle = `\n${head}`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 statement starting ${JSON.stringify(head)} in server.js, found ${hits}`)
  const a = src.indexOf(needle) + 1
  const end = close ? src.indexOf(close, a) : src.indexOf(';\n', a)
  if (end < 0) throw new Error(`no end found after ${head}`)
  return src.slice(a, end + (close ? close.length : 1))
}

// The server's ceilings, evaluated from `src` (server.js, or a sabotaged copy).
function serverCaps(src) {
  const code = [
    liftConst(src, 'const TRUCK_AMOUNT_MAX = '),
    liftConst(src, 'const TRUCK_AMOUNT_FIELDS = [', '\n];'),
    liftConst(src, 'const DRIVER_PAY_DAILY_MAX = '),
    liftConst(src, 'const ADMIN_FEE_PCT_MAX = '),
  ].join('\n')
  return new Function(`"use strict";\n${code}\nreturn { TRUCK_AMOUNT_MAX, TRUCK_AMOUNT_FIELDS, DRIVER_PAY_DAILY_MAX, ADMIN_FEE_PCT_MAX };`)()
}

// Client key → what governs it on the server: a TRUCK_AMOUNT_FIELDS column, or
// one of the two ceilings kept outside that table.
const COLUMN_OF = Object.freeze({
  fuelTankGallons: 'fuel_tank_gallons',
  avgMpg: 'avg_mpg',
  purchasePrice: 'purchase_price',
  maintenanceFundMonthly: 'maintenance_fund_monthly',
  insuranceMonthly: 'insurance_monthly',
  eldMonthly: 'eld_monthly',
  hvutAnnual: 'hvut_annual',
  irpAnnual: 'irp_annual',
  truckPaymentMonthly: 'truck_payment_monthly',
})
const CONSTANT_OF = Object.freeze({ driverPayDaily: 'DRIVER_PAY_DAILY_MAX', adminFeePct: 'ADMIN_FEE_PCT_MAX' })

// Every difference between a client table and the server's ceilings, one
// sentence each; [] when the two are in step.
function capDifferences(clientFields, server) {
  const out = []
  const rows = new Map(server.TRUCK_AMOUNT_FIELDS.map((row) => [row.col, row]))
  const covered = new Set()
  for (const f of clientFields) {
    if (Object.prototype.hasOwnProperty.call(CONSTANT_OF, f.key)) {
      const name = CONSTANT_OF[f.key]
      if (server[name] !== f.max) out.push(`${f.key}: the form allows up to ${f.max}, the server ${name} is ${server[name]}`)
      continue
    }
    const col = Object.prototype.hasOwnProperty.call(COLUMN_OF, f.key) ? COLUMN_OF[f.key] : null
    const row = col ? rows.get(col) : null
    if (!row) { out.push(`${f.key}: no server column governs it`); continue }
    covered.add(col)
    if (!row.keys.includes(f.key)) out.push(`${f.key}: the server's ${col} row does not read that key`)
    const cap = row.max ?? server.TRUCK_AMOUNT_MAX
    if (cap !== f.max) out.push(`${f.key} (${col}): the form allows up to ${f.max}, the server up to ${cap}`)
  }
  for (const col of rows.keys()) if (!covered.has(col)) out.push(`${col}: no form field carries it`)
  return out
}

// ══ The real pair ═════════════════════════════════════════════════════════════
const server = serverCaps(SRC)
eq('the server ceilings, read from server.js',
  {
    amount: server.TRUCK_AMOUNT_MAX, pay: server.DRIVER_PAY_DAILY_MAX, fee: server.ADMIN_FEE_PCT_MAX,
    rows: Object.fromEntries(server.TRUCK_AMOUNT_FIELDS.map((row) => [row.col, row.max ?? server.TRUCK_AMOUNT_MAX])),
  },
  {
    amount: 1000000, pay: 10000, fee: 100,
    rows: {
      insurance_monthly: 1000000, eld_monthly: 1000000, truck_payment_monthly: 1000000, hvut_annual: 1000000, irp_annual: 1000000,
      purchase_price: 1000000, maintenance_fund_monthly: 1000000, fuel_tank_gallons: 500, avg_mpg: 20,
    },
  })
eq('AMOUNT_MAX is the server\'s TRUCK_AMOUNT_MAX', AMOUNT_MAX, server.TRUCK_AMOUNT_MAX)
eq('every form ceiling is the server\'s, and every server amount has a form field', capDifferences(AMOUNT_FIELDS, server), [])
eq('the map covers exactly the form\'s fields', [...Object.keys(COLUMN_OF), ...Object.keys(CONSTANT_OF)].sort(),
  AMOUNT_FIELDS.map((f) => f.key).sort())

// ══ Sabotage controls: the comparison must be able to fail ════════════════════
const sabotage = (label, from, to) => {
  const mutated = SRC.replace(from, to)
  ok(`(control) the ${label} sabotage changed the source`, mutated !== SRC && SRC.split(from).length === 2)
  return capDifferences(AMOUNT_FIELDS, serverCaps(mutated))
}
eq('a server fuel tank ceiling of 600 is reported',
  sabotage('fuel tank', 'staffOnly: true, max: 500 }', 'staffOnly: true, max: 600 }'),
  ['fuelTankGallons (fuel_tank_gallons): the form allows up to 500, the server up to 600'])
eq('a server MPG row that loses its ceiling is reported',
  sabotage('MPG', 'staffOnly: true, max: 20 }', 'staffOnly: true }'),
  ['avgMpg (avg_mpg): the form allows up to 20, the server up to 1000000'])
eq('a server admin fee ceiling of 90 is reported',
  sabotage('admin fee', 'const ADMIN_FEE_PCT_MAX = 100;', 'const ADMIN_FEE_PCT_MAX = 90;'),
  ['adminFeePct: the form allows up to 100, the server ADMIN_FEE_PCT_MAX is 90'])
eq('a form driver pay ceiling of 5,000 is reported',
  capDifferences(AMOUNT_FIELDS.map((f) => (f.key === 'driverPayDaily' ? { ...f, max: 5000 } : f)), server),
  ['driverPayDaily: the form allows up to 5000, the server DRIVER_PAY_DAILY_MAX is 10000'])
eq('a form that drops Avg MPG is reported',
  capDifferences(AMOUNT_FIELDS.filter((f) => f.key !== 'avgMpg'), server),
  ['avg_mpg: no form field carries it'])
eq('a form field no server column governs is reported',
  capDifferences([...AMOUNT_FIELDS, { key: 'tireBudget', label: 'Tires', max: 1000000 }], server),
  ['tireBudget: no server column governs it'])

// ══ (a) The two readers answer every input alike ═════════════════════════════
// server.js reads a sent amount through parsePlainDecimal() (parseTruckAmount,
// parseDriverPayDaily, parseAdminFeePct); the forms through plainDecimal()
// (amountError). Each server parser, lifted verbatim, and amountError on the
// field it governs must accept and refuse the same inputs — "0x10" above all,
// which a bare Number() reads as 16.
const { amountError, plainDecimal } = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib', 'truckAmounts.js')).href)
function liftFunction(src, name) {
  const needle = `\nfunction ${name}(`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`)
  const a = src.indexOf(needle) + 1
  const end = src.indexOf('\n}\n', a)
  return src.slice(a, end + 2)
}
const PARSERS = new Function(`"use strict";\n${[
  liftFunction(SRC, 'parsePlainDecimal'),
  liftConst(SRC, 'const TRUCK_AMOUNT_MAX = '), liftFunction(SRC, 'parseTruckAmount'),
  liftConst(SRC, 'const DRIVER_PAY_DAILY_MAX = '), liftFunction(SRC, 'parseDriverPayDaily'),
  liftConst(SRC, 'const ADMIN_FEE_PCT_MAX = '), liftFunction(SRC, 'parseAdminFeePct'),
].join('\n')}\nreturn { parsePlainDecimal, parseTruckAmount, parseDriverPayDaily, parseAdminFeePct };`)()

const INPUTS = ['0x10', '0b1', '0o7', '1e3', '12.5', ' 12 ', '', '1,000', 'Infinity', '-5', '.5', '5.', '1e999',
  '0X1F', '+5', '1e1000', '   ', '12abc', '1'.repeat(32), '1'.repeat(33), 12.5, 500, 500.01, -0, Infinity, NaN]
// Each form field and the server reader that governs it.
const PAIRS = [
  ['purchasePrice', (v) => PARSERS.parseTruckAmount(v, 'Purchase price'), {}],
  ['fuelTankGallons', (v) => PARSERS.parseTruckAmount(v, 'Fuel tank', 500), {}],
  ['driverPayDaily', (v) => PARSERS.parseDriverPayDaily(v), { canEditPay: true }],
  ['adminFeePct', (v) => PARSERS.parseAdminFeePct(v), {}],
]
function readerDisagreements(clientError) {
  const out = []
  for (const [key, serverRead, opts] of PAIRS) {
    for (const v of INPUTS) {
      const serverOk = !serverRead(v).error
      const clientOk = clientError({ [key]: v }, opts) === null
      if (serverOk !== clientOk) out.push(`${key} ${JSON.stringify(v)}: the server ${serverOk ? 'accepts' : 'refuses'} it, the form ${clientOk ? 'accepts' : 'refuses'} it`)
    }
  }
  return out
}
eq('(a) the form and the server accept and refuse the same inputs, field by field', readerDisagreements(amountError), [])
for (const v of ['0x10', '0b1', '0o7']) {
  ok(`(a) ${JSON.stringify(v)} is refused by the server and the form alike`,
    PARSERS.parseTruckAmount(v).error && amountError({ purchasePrice: v }) !== null)
}
eq('(a) parsePlainDecimal() and plainDecimal() read every input to the same number',
  INPUTS.filter((v) => !Object.is(PARSERS.parsePlainDecimal(v), plainDecimal(v))).map((v) => JSON.stringify(v)), [])
// Control: a form that reads text with a bare Number() is reported.
const laxError = (values, opts) => {
  const [[key, v]] = Object.entries(values)
  const field = AMOUNT_FIELDS.find((f) => f.key === key)
  if (field.pay && !opts.canEditPay) return null
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= field.max ? null : 'refused'
}
ok('(a, control) a form reading text with a bare Number() is reported on "0x10"',
  readerDisagreements(laxError).some((d) => d.startsWith('purchasePrice "0x10"')))

// ══ (b) Every amount box's `max` is AMOUNT_CAPS ═══════════════════════════════
// The number boxes in the Trucks forms take their range hint from AMOUNT_CAPS;
// a literal `max="…"` or `:max="<number>"` on one would be a second copy of a
// ceiling that nothing keeps in step.
const FORM_FILES = [
  path.join(__dirname, '..', 'client', 'src', 'views', 'TrucksView.vue'),
  ...fs.readdirSync(path.join(__dirname, '..', 'client', 'src', 'components', 'trucks'))
    .filter((f) => f.endsWith('.vue')).map((f) => path.join(__dirname, '..', 'client', 'src', 'components', 'trucks', f)),
]
const AMOUNT_KEYS = new Set(AMOUNT_FIELDS.map((f) => f.key))
// Each <input …> tag, read to the first `>` outside quotes.
function inputTags(text) {
  const tags = []
  let at = text.indexOf('<input')
  while (at >= 0) {
    let quote = ''
    let i = at + 6
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    tags.push(text.slice(at, i + 1))
    at = text.indexOf('<input', i)
  }
  return tags
}
// One sentence per amount box whose `max` is not AMOUNT_CAPS.<its own key>.
function maxBypasses(label, text) {
  const out = []
  for (const tag of inputTags(text)) {
    const model = tag.match(/\bv-model(?:\.[a-z]+)*="[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)"/)
    if (!model || !AMOUNT_KEYS.has(model[1])) continue
    for (const m of tag.matchAll(/(?:^|\s)((?:v-bind)?:?max)="([^"]*)"/g)) {
      if (m[1] === 'max' || m[2].trim() !== `AMOUNT_CAPS.${model[1]}`) out.push(`${label}: ${model[1]} has ${m[1]}="${m[2]}"`)
    }
  }
  return out
}
const forms = FORM_FILES.map((f) => [path.relative(path.join(__dirname, '..'), f), fs.readFileSync(f, 'utf8')])
const boxes = forms.flatMap(([, text]) => inputTags(text).filter((t) => /:max="AMOUNT_CAPS\./.test(t)))
ok(`(b) the amount boxes' :max bindings are found (${boxes.length})`, boxes.length >= 8)
eq('(b) no amount box in the Trucks forms carries a max that bypasses AMOUNT_CAPS', forms.flatMap(([label, text]) => maxBypasses(label, text)), [])
const addForm = forms.find(([label]) => label.endsWith('AddTruckForm.vue'))
const bound = ':max="AMOUNT_CAPS.fuelTankGallons"'
ok('(b, control) the fuel tank box binds AMOUNT_CAPS in AddTruckForm.vue', !!addForm && addForm[1].split(bound).length === 2)
for (const [what, to] of [['a literal max="600"', 'max="600"'], ['a bound number :max="600"', ':max="600"'], ["another field's cap", ':max="AMOUNT_CAPS.avgMpg"']]) {
  ok(`(b, control) ${what} on the fuel tank box is reported`,
    maxBypasses('AddTruckForm.vue', addForm[1].replace(bound, to)).some((d) => d.includes('fuelTankGallons')))
}

console.log(`\ntruck-amount-caps-parity: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
