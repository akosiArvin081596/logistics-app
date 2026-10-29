#!/usr/bin/env node
// A month paid at two daily rates says each rate (money review M1 of #547,
// 2026-10-21).
//
// WHY THIS EXISTS. Under the daily-rate rule (DRIVER_RATE_ONLY, off by default)
// a driver can be paid at more than one rate in a month: his rate changed on a
// date. The pay is the exact sum of each day's rate, but the "N days x $X/day"
// basis an investor reads beside it showed one rate, their average: 1 day at
// $280 and 18 at $320 read "19 days x $317.89/day". The server now sends the
// month's segments ({ days, rate }, in day order) with the figure, and each
// place that prints the basis prints them: "1 day x $280 + 18 days x $320".
// A month paid at one rate prints exactly what it printed before.
//
//   §1 driverPayBasis() (client/src/lib/driverPay.js): one segment per rate, a
//      single day as "1 day"; one rate as before
//   §2 lib/driver-pay-text.js, the statement's copy of that wording, says the
//      same, character for character; the statement prints it and its file is
//      part of the statement template (STATEMENT_TEMPLATE_FILES)
//   §3 the Payouts drill-down (PayoutsSection.vue) prints the segments for a
//      row that has them, and its one-rate line is unchanged
//   §4 the Earnings drill-down (EarningsSection.vue) the same, and the Driver
//      Pay formula line never quotes one rate for a month paid at two
//      (monthDayRates())
//
// No DOM, no server.
//   node scripts/test-driver-pay-two-rates.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const require = createRequire(import.meta.url)

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}

const lib = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'driverPay.js')).href)
const TWO = [{ days: 1, rate: 280 }, { days: 18, rate: 320 }]

console.log('§1 driverPayBasis()')
{
  const got = lib.driverPayBasis({ payType: 'fixed', activeDays: 19, dailyRate: 317.89, totalPay: 6040, rates: TWO })
  ok('§1 two rates: "1 day x $280 + 18 days x $320"', got === '1 day x $280 + 18 days x $320', got)
  const three = lib.driverPayBasis({ payType: 'fixed', activeDays: 4, rates: [{ days: 2, rate: 280 }, { days: 1, rate: 320 }, { days: 1, rate: 280 }] })
  ok('§1 three segments', three === '2 days x $280 + 1 day x $320 + 1 day x $280', three)
  ok('§1 one rate, as before', lib.driverPayBasis({ payType: 'fixed', activeDays: 18, dailyRate: 300, totalPay: 5400 }) === '18 days x $300')
  ok('§1 one segment reads as one rate', lib.driverPayBasis({ payType: 'fixed', activeDays: 18, dailyRate: 300, rates: [{ days: 18, rate: 300 }] }) === '18 days x $300')
}

console.log('§2 the statement says the same')
{
  const file = path.join(ROOT, 'lib', 'driver-pay-text.js')
  ok('§2 lib/driver-pay-text.js exists', fs.existsSync(file))
  if (fs.existsSync(file)) {
    const { rateSegmentsText } = require(file)
    for (const segs of [TWO, [{ days: 2, rate: 150 }, { days: 3, rate: 250 }], [{ days: 1, rate: 247.5 }, { days: 1, rate: 300 }]]) {
      const want = lib.driverPayBasis({ payType: 'fixed', rates: segs })
      ok(`§2 "${want}" on both sides`, typeof rateSegmentsText === 'function' && rateSegmentsText(segs) === want, typeof rateSegmentsText === 'function' ? rateSegmentsText(segs) : 'no rateSegmentsText')
    }
  }
  const statement = read('lib', 'payout-statement.js')
  ok('§2 the statement takes the wording from lib/driver-pay-text.js', /require\("\.\/driver-pay-text"\)/.test(statement))
  ok('§2 ...for a row with more than one segment', statement.includes('Array.isArray(r.rates) && r.rates.length > 1'))
  ok('§2 its one-rate basis is unchanged',
    statement.includes(': `${esc(String(num(r.activeDays)))} day${num(r.activeDays) === 1 ? "" : "s"} &times; ${esc(money(r.dailyRate))}/day`'))
  let list = []
  try { list = require(path.join(ROOT, 'lib', 'statement-template-hash.js')).STATEMENT_TEMPLATE_FILES } catch {}
  ok('§2 lib/driver-pay-text.js is part of the statement template (a change to it re-renders statements)', list.includes('./lib/driver-pay-text.js'))
}

console.log('§3 the Payouts drill-down')
{
  const vue = read('client', 'src', 'components', 'investor', 'PayoutsSection.vue')
  ok('§3 imports driverPayBasis from lib/driverPay', /import \{[^}]*\bdriverPayBasis\b[^}]*\} from '\.\.\/\.\.\/lib\/driverPay'/.test(vue))
  ok('§3 a row with segments prints them',
    vue.includes(`<template v-else-if="Array.isArray(r.rates) && r.rates.length > 1">{{ driverPayBasis(r) }}</template>`))
  ok('§3 the one-rate line is unchanged',
    vue.includes(`<template v-else>{{ r.activeDays }} day{{ Number(r.activeDays) === 1 ? '' : 's' }} × {{ fmtCents(r.dailyRate) }}/day</template>`))
}

console.log('§4 the Earnings drill-down and its formula line')
{
  const vue = read('client', 'src', 'components', 'investor', 'EarningsSection.vue')
  ok('§4 imports driverPayBasis and monthDayRates from lib/driverPay',
    /import \{[^}]*\bdriverPayBasis\b[^}]*\} from '\.\.\/\.\.\/lib\/driverPay'/.test(vue) && /import \{[^}]*\bmonthDayRates\b[^}]*\} from '\.\.\/\.\.\/lib\/driverPay'/.test(vue))
  ok('§4 a driver with segments: his days, then each rate',
    vue.includes(`<template v-if="Array.isArray(d.rates) && d.rates.length > 1">: {{ driverPayBasis(d) }}</template><template v-else-if="d.dailyRate > 0"> × \${{ d.dailyRate }}/day</template>`))
  ok('§4 the formula line reads the rates through monthDayRates()', vue.includes('const rates = monthDayRates(drivers)'))
  const rates = typeof lib.monthDayRates === 'function' ? lib.monthDayRates : () => null
  const json = (x) => JSON.stringify(x)
  ok('§4 monthDayRates(): one driver paid at two rates gives both', json(rates([{ payType: 'fixed', dailyRate: 317.89, rates: TWO }])) === json([280, 320]), json(rates([{ payType: 'fixed', dailyRate: 317.89, rates: TWO }])))
  ok('§4 ...one rate gives it', json(rates([{ payType: 'fixed', dailyRate: 350 }, { payType: 'fixed', dailyRate: 350 }])) === json([350]))
  ok('§4 ...a missing or zero rate is dropped', json(rates([{ payType: 'fixed', dailyRate: 0 }, { payType: 'fixed' }])) === json([]))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
