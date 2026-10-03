#!/usr/bin/env node
// The investor's Fleet Breakdown says how each truck's Driver Pay was reached
// (2026-10-03).
//
// WHY THIS EXISTS. Beside Driver Pay, a truck's breakdown printed
// "(N days x $R)", with R falling back to $250. A percentage-paid driver is paid
// a share of revenue after deductible trip expenses, and the server sends them a
// daily rate of 0, so an investor read "(N days x $250)" for a rate that driver
// is not paid. The Driver Pay figure itself (the server's totalPay) was already
// their percentage pay.
//
//   §1 driverPayBasis() (client/src/lib/driverPay.js): the share for a
//      percentage-paid driver, the day count and rate for anyone else, exactly
//      as before
//   §2 GET /api/investor sends each driver's payType and payPercentage with
//      their totalPay (read from server.js)
//   §3 FleetBreakdownSection.vue prints the hint through driverPayBasis()
//
// No DOM, no server.
//   node scripts/test-fleet-driver-pay-basis.mjs
//   LOGISX_ROOT=/tmp/base node scripts/test-fleet-driver-pay-basis.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const { driverPayBasis } = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'driverPay.js')).href)
const basis = typeof driverPayBasis === 'function' ? driverPayBasis : () => '(no driverPayBasis)'

console.log('§1 driverPayBasis()')
for (const [label, details, want] of [
  ['a percentage-paid driver (dailyRate 0)', { activeDays: 21, dailyRate: 0, totalPay: 4120.5, payType: 'percentage', payPercentage: 20 },
    '20% of revenue after deductible trip expenses'],
  ['a fractional share', { activeDays: 9, dailyRate: 0, totalPay: 812, payType: 'percentage', payPercentage: 22.5 },
    '22.5% of revenue after deductible trip expenses'],
  ['a day-rate driver', { activeDays: 18, dailyRate: 300, totalPay: 5400, payType: 'fixed', payPercentage: 0 }, '18 days x $300'],
  ['a day-rate driver from a server that sends no pay type', { activeDays: 18, dailyRate: 275, totalPay: 4950 }, '18 days x $275'],
  ['a truck whose driver has no pay entry', undefined, '0 days x $250'],
]) {
  const got = basis(details)
  ok(`§1 ${label}: "${want}" (got "${got}")`, got === want)
}
ok('§1 a percentage-paid driver never reads as a day rate',
  !/days x \$/.test(basis({ activeDays: 21, dailyRate: 0, payType: 'percentage', payPercentage: 20 })))

console.log('§2 GET /api/investor sends the pay type with each driver\'s pay')
{
  const server = read('server.js')
  const at = server.indexOf('driverPayDetails: Object.fromEntries(Object.entries(driverPayDetails).map(')
  const entry = at < 0 ? '' : server.slice(at, server.indexOf('}]))', at))
  ok('§2 the production.driverPayDetails map is found', at > 0)
  for (const field of ['activeDays: v.activeDays', 'dailyRate: v.dailyRate', 'totalPay: v.totalPay', 'payType: v.payType', 'payPercentage: v.payPercentage']) {
    ok(`§2 each entry carries ${field.split(':')[0]}`, entry.includes(field))
  }
}

console.log('§3 the Fleet Breakdown prints it')
{
  const vue = read('client', 'src', 'components', 'investor', 'FleetBreakdownSection.vue')
  ok('§3 FleetBreakdownSection.vue imports driverPayBasis from lib/driverPay',
    /^import \{ driverPayBasis \} from '\.\.\/\.\.\/lib\/driverPay'$/m.test(vue))
  ok('§3 the Driver Pay hint is driverBasis(t)', vue.includes('<span class="bd-hint"> ({{ driverBasis(t) }})</span>'))
  ok('§3 ...which hands the driver\'s pay entry to driverPayBasis()',
    vue.includes('return driverPayBasis((props.production?.driverPayDetails || {})[driver])'))
  ok('§3 no template prints "days x $" itself', !/days x \$\{\{/.test(vue))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
