#!/usr/bin/env node
// The pay cells the Drivers Database forms send (client/src/lib/driverPay.js).
//
// WHY THIS EXISTS. POST /api/drivers-directory and PUT
// /api/drivers-directory/:id read their body with `values[i] || ""`, so a
// NUMBER 0 is "not sent". The Edit dialog sent the active pay type's amount as
// `Number(...) || 0`, so a Super Admin who set a driver's daily rate to 0, or
// blanked it, saved nothing: the stored rate came back. It sent the type not
// in use as a numeric 0 too, which was harmless only because 0 was not sent.
// Both forms now build the three cells with directoryPayCells(): the active
// type's amount as TEXT ("0" allowed, a blank field "0"), the other type's as
// "", and all three "" for anyone who may not edit pay.
//
//   §1 the cells, for each role, each pay type and each kind of amount
//   §1b the pay type the Edit dialog opens with (directoryPayType()): a legacy
//      "Fixed" / "Percentage" lowercased, so its radio and amount show; never
//      trimmed, so the radio it selects is the type the money math pays
//      (directoryPayStruct(), read from server.js)
//   §2 how the server's mapping (read from server.js) receives them
//   §3 both forms build their pay cells with it, and with nothing else; the
//      Edit dialog opens the type through directoryPayType()
//   §4 MUTANTS: the amount sent as a number again; the other type's amount
//      sent as "0"; the type opened as stored (not lowercased); the type
//      trimmed as well. Each must fail §1, §1b or §2.
//
// scripts/test-driver-pay-clear.js runs these cells through the shipped routes.
// No DOM, no server.
//   node scripts/test-driver-pay-cells.mjs     # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'driverPay.js')
const LIB_SRC = fs.readFileSync(LIB, 'utf8')
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')

let pass = 0
let fail = 0
function report(results) {
  for (const r of results) {
    if (r.ok) pass++
    else { fail++; console.error(`FAIL  ${r.name}\n        expected ${r.e}\n        actual   ${r.a}`) }
  }
}
function collector() {
  const results = []
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    results.push({ ok: a === e, name, a, e })
  }
  return { results, eq }
}

// ══ 1. The cells ═════════════════════════════════════════════════════════════
function cellsSection(directoryPayCells) {
  const { results, eq } = collector()
  const sa = (form) => directoryPayCells({ canEditPay: true, ...form })
  const FIXED = { payType: 'fixed', payPercentage: 20, payDaily: 300 }
  const PCT = { payType: 'percentage', payPercentage: 20, payDaily: 275 }

  eq('§1 fixed, $300: the rate as text, the share not sent', sa(FIXED), ['fixed', '', '300'])
  eq('§1 fixed, set to 0: "0", which clears the rate', sa({ ...FIXED, payDaily: 0 }), ['fixed', '', '0'])
  eq('§1 fixed, the field blanked (v-model.number gives ""): "0", as the form says blank means', sa({ ...FIXED, payDaily: '' }), ['fixed', '', '0'])
  eq('§1 fixed, a field that is only spaces: "0"', sa({ ...FIXED, payDaily: '   ' }), ['fixed', '', '0'])
  eq('§1 fixed, no value at all: "0"', sa({ ...FIXED, payDaily: undefined }), ['fixed', '', '0'])
  eq('§1 fixed, $299.50: "299.5"', sa({ ...FIXED, payDaily: 299.5 }), ['fixed', '', '299.5'])
  eq('§1 fixed, a value held as text: trimmed, as typed', sa({ ...FIXED, payDaily: ' 325 ' }), ['fixed', '', '325'])
  // Out-of-range and unreadable amounts go as typed, so the server answers
  // them (400 INVALID_PAY, or its clamp) rather than the form turning them
  // into a clear.
  eq('§1 fixed, 1e21: "1e+21", which the server refuses', sa({ ...FIXED, payDaily: 1e21 }), ['fixed', '', '1e+21'])
  eq('§1 fixed, Infinity: "Infinity", which the server refuses (not a silent clear)', sa({ ...FIXED, payDaily: Infinity }), ['fixed', '', 'Infinity'])
  eq('§1 fixed, -5: "-5", which the server clamps to 0', sa({ ...FIXED, payDaily: -5 }), ['fixed', '', '-5'])
  eq('§1 percentage, 20 %: the share as text, the day rate not sent', sa(PCT), ['percentage', '20', ''])
  eq('§1 percentage, set to 0: "0"', sa({ ...PCT, payPercentage: 0 }), ['percentage', '0', ''])
  eq('§1 percentage, blanked: "0" (the form shows it as 0 %)', sa({ ...PCT, payPercentage: '' }), ['percentage', '0', ''])
  eq('§1 percentage, 12.5 %: "12.5"', sa({ ...PCT, payPercentage: 12.5 }), ['percentage', '12.5', ''])
  // A pay type the radios do not offer (a legacy "Fixed"): neither amount field
  // is on screen, so neither is sent.
  eq('§1 a legacy "Fixed" type: sent as loaded, neither amount sent', sa({ ...FIXED, payType: 'Fixed' }), ['Fixed', '', ''])
  eq('§1 no pay type: neither amount sent', sa({ payPercentage: 20, payDaily: 300 }), ['', '', ''])
  // Anyone who may not edit pay sends none, whatever the form holds.
  for (const form of [FIXED, PCT, { ...FIXED, payDaily: 0 }]) {
    eq(`§1 no pay rights, ${JSON.stringify(form)}: all three blank`, directoryPayCells({ canEditPay: false, ...form }), ['', '', ''])
  }
  // Every cell is text: a NUMBER here is what the server reads as "not sent".
  const shapes = [FIXED, PCT, { ...FIXED, payDaily: 0 }, { ...PCT, payPercentage: 0 }, { ...FIXED, payDaily: '' }]
  eq('§1 every cell is a string, for every shape', shapes.flatMap((f) => sa(f)).every((c) => typeof c === 'string'), true)
  return results
}

// ══ 1b. The pay type the Edit dialog opens with ══════════════════════════════
// directoryPayStruct() as server.js ships it: how the money math reads a stored
// pay type. Self-contained, so it is lifted whole.
function serverFunction(name) {
  const needle = `\nfunction ${name}(`
  if (SERVER_SRC.split(needle).length - 1 !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js`)
  const start = SERVER_SRC.indexOf(needle) + 1
  const end = SERVER_SRC.indexOf('\n}\n', start)
  return new Function(`${SERVER_SRC.slice(start, end + 2)}\nreturn ${name};`)()
}
const directoryPayStruct = serverFunction('directoryPayStruct')
const RADIOS = ['fixed', 'percentage']
function typeSection({ directoryPayType, directoryPayCells }) {
  const { results, eq } = collector()
  eq('§1b legacy "Fixed" and "Percentage" open lowercased, on their radios',
    [directoryPayType('Fixed'), directoryPayType('Percentage'), directoryPayType('FIXED'), directoryPayType('PERCENTAGE')],
    ['fixed', 'percentage', 'fixed', 'percentage'])
  eq('§1b a type already lowercase opens as stored', [directoryPayType('fixed'), directoryPayType('percentage')], ['fixed', 'percentage'])
  eq('§1b no type opens as "fixed", the column default', [directoryPayType(''), directoryPayType(undefined), directoryPayType(null)], ['fixed', 'fixed', 'fixed'])
  eq('§1b a type with spaces or of another name matches no radio, as before (never trimmed)',
    [directoryPayType(' percentage'), directoryPayType('Percentage '), directoryPayType('Daily')], [' percentage', 'percentage ', 'daily'])
  // Saved untouched by a Super Admin, a legacy row now sends its amount as
  // text by directoryPayCells()'s rules, which the server reads as no change
  // (it compares pay as the money math reads it).
  const saved = (stored, payPercentage, payDaily) =>
    directoryPayCells({ canEditPay: true, payType: directoryPayType(stored), payPercentage, payDaily })
  eq('§1b a legacy "Fixed" row at $300, saved untouched: its day rate as text, the share not sent', saved('Fixed', 0, 300), ['fixed', '', '300'])
  eq('§1b a legacy "Percentage" row at 30 %, saved untouched: its share as text, the day rate not sent', saved('Percentage', 30, 0), ['percentage', '30', ''])
  eq('§1b a type no radio offers, saved: as before, neither amount sent', saved('Daily', 0, 300), ['daily', '', ''])
  // The radio the dialog selects is the formula the money math pays with.
  const STORED = ['fixed', 'Fixed', 'FIXED', 'percentage', 'Percentage', 'PERCENTAGE', ' percentage', 'percentage ', 'Percentage\t', 'Daily', '', null, undefined]
  const disagree = STORED.filter((s) => {
    const radio = RADIOS.includes(directoryPayType(s)) ? directoryPayType(s) : null
    return radio !== null && radio !== directoryPayStruct({ pay_type: s }).payType
  })
  eq('§1b for every stored type, a radio the dialog selects is the pay type the money math reads (directoryPayStruct())',
    disagree.map((s) => JSON.stringify(s)), [])
  return results
}

// ══ 2. How the server receives them ══════════════════════════════════════════
// Both directory routes map the body with this one expression; a pay field is
// "sent" when the mapped value is neither undefined nor "".
const MAPPING = 'headers.forEach((h, i) => { obj[h] = values[i] || ""; });'
function serverSection(directoryPayCells) {
  const { results, eq } = collector()
  eq('§2 both directory routes still map the body with `values[i] || ""`', SERVER_SRC.split(`\n\t\t${MAPPING}\n`).length - 1, 2)
  const received = (cells) => cells.map((v) => v || '').map((v) => (v === '' ? 'not sent' : v))
  eq('§2 fixed, set to 0: the rate arrives as "0", the share as not sent',
    received(directoryPayCells({ canEditPay: true, payType: 'fixed', payPercentage: 20, payDaily: 0 })), ['fixed', 'not sent', '0'])
  eq('§2 percentage, set to 0: the share arrives as "0", the day rate as not sent',
    received(directoryPayCells({ canEditPay: true, payType: 'percentage', payPercentage: 0, payDaily: 275 })), ['percentage', '0', 'not sent'])
  eq('§2 no pay rights: nothing arrives',
    received(directoryPayCells({ canEditPay: false, payType: 'fixed', payPercentage: 0, payDaily: 0 })), ['not sent', 'not sent', 'not sent'])
  // The old dialog's cells, verbatim: its "set to 0" never arrived.
  const oldCells = (f) => [f.payType, f.payType === 'percentage' ? (Number(f.payPercentage) || 0) : 0, f.payType === 'fixed' ? (Number(f.payDaily) || 0) : 0]
  eq('§2 ORACLE: the old dialog\'s "set to 0" arrived as not sent (the bug)',
    received(oldCells({ payType: 'fixed', payPercentage: 20, payDaily: 0 })), ['fixed', 'not sent', 'not sent'])
  return results
}

// ══ 3. Both forms use it ═════════════════════════════════════════════════════
function functionBody(src, head) {
  const at = src.indexOf(head)
  if (at < 0) return ''
  const end = src.indexOf('\n}\n', at)
  return end < 0 ? '' : src.slice(at, end + 2)
}
{
  const results = []
  const ok = (name, cond) => results.push({ ok: !!cond, name, a: String(!!cond), e: 'true' })
  for (const [file, head, form] of [
    ['DriverTable.vue', 'function handleSaveEdit() {', 'editForm'],
    ['AddDriverForm.vue', 'function handleSubmit() {', 'form'],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'drivers-db', file), 'utf8')
    const body = functionBody(src, head)
    const imported = (src.match(/^import \{ ([^}]+) \} from '\.\.\/\.\.\/lib\/driverPay'$/m) || [, ''])[1].split(',').map((s) => s.trim())
    ok(`§3 ${file}: imports directoryPayCells from lib/driverPay`, imported.includes('directoryPayCells'))
    ok(`§3 ${file}: ${head.slice(9, -4)} builds the pay cells with it, last`,
      body.includes(`...directoryPayCells({\n`) && /\.\.\.directoryPayCells\(\{[\s\S]*?\}\),\n\s*\]/.test(body))
    ok(`§3 ${file}: ...from the form's own fields and the role's pay rights`,
      ['canEditPay: props.canEditPay', `payType: ${form}.payType`, `payPercentage: ${form}.payPercentage`, `payDaily: ${form}.payDaily`].every((s) => body.includes(s)))
    ok(`§3 ${file}: ...and turns no amount into a number itself`, body.length > 0 && !/Number\(/.test(body))
  }
  // The Edit dialog opens the stored type through directoryPayType(), and sets
  // the type nowhere else.
  const table = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'drivers-db', 'DriverTable.vue'), 'utf8')
  const open = functionBody(table, 'function openEdit(d) {')
  ok('§3 DriverTable.vue: imports directoryPayType from lib/driverPay',
    /^import \{ directoryPayCells, directoryPayType \} from '\.\.\/\.\.\/lib\/driverPay'$/m.test(table))
  ok('§3 DriverTable.vue: openEdit() opens the stored type through directoryPayType(), and assigns it once',
    open.includes('editForm.payType = directoryPayType(d.PayType)') && open.split('editForm.payType =').length - 1 === 1)
  report(results)
}

// ══ 4. Mutants ═══════════════════════════════════════════════════════════════
function mutate(src, from, to) {
  const n = src.split(from).length - 1
  if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`)
  return src.replace(from, () => to)
}
const load = (src) => import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`)
const MUTANTS = [
  ['M1 the amount sent as a number again (a 0 then reads as not sent)',
    mutate(LIB_SRC, "if (typeof value === 'number') return String(value)", "if (typeof value === 'number') return value")],
  ['M2 the type not in use sent as "0" (a save would clear it)',
    mutate(LIB_SRC, "if (payType === 'percentage') return ['percentage', amountCell(payPercentage), '']",
      "if (payType === 'percentage') return ['percentage', amountCell(payPercentage), '0']")],
  ['M3 the type opened as stored (a legacy "Fixed" matches no radio again)',
    mutate(LIB_SRC, "return String(stored || 'fixed').toLowerCase()", "return String(stored || 'fixed')")],
  ['M4 the type trimmed as well (" percentage", paid as fixed, opens on the percentage radio)',
    mutate(LIB_SRC, "return String(stored || 'fixed').toLowerCase()", "return String(stored || 'fixed').trim().toLowerCase()")],
]

const shipped = await import(pathToFileURL(LIB).href)
report(cellsSection(shipped.directoryPayCells))
report(typeSection(shipped))
report(serverSection(shipped.directoryPayCells))
for (const [label, src] of MUTANTS) {
  const m = await load(src)
  const failed = [...cellsSection(m.directoryPayCells), ...typeSection(m), ...serverSection(m.directoryPayCells)].filter((r) => !r.ok)
  if (failed.length) pass++
  else { fail++; console.error(`FAIL  mutant not caught: ${label}`) }
  console.log(`  ${failed.length ? 'caught ' : 'MISSED '} ${label}${failed[0] ? ` — ${failed.length} check(s), e.g. ✗ ${failed[0].name}` : ''}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
