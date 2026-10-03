#!/usr/bin/env node
/**
 * Unit assertions for check (6) of truckEditLockBlockers(), and check (2) of
 * truckCreateLockBlockers() and truckDeleteLockBlockers(): a truck's daily
 * driver rate is guarded across finalized months only when the driver it prices
 * is paid by the day.
 *
 * A percentage-paid driver's pay is a share of net revenue (financials-calc.js,
 * /api/financials, the invoice's owner-operator template); no figure reads the
 * truck's daily rate for them. The check compared the resolved daily rate before
 * and after without looking at the pay type, so changing (or clearing) the rate
 * on a percentage-paid driver's truck was refused over every month they worked,
 * for a number none of those months used.
 *
 * Switching that driver back to a day rate is guarded on its own, by the
 * directory edit's pay-structure check, so skipping them here opens nothing.
 *
 * ⚠️ THE CODE UNDER TEST IS EXTRACTED FROM server.js SOURCE, not copied here.
 * Only database reads are stubbed.
 *
 * Run: node scripts/test-truck-rate-lock-pay-type.js
 * Against a base commit: SERVER_JS=/tmp/base.js node scripts/test-truck-rate-lock-pay-type.js
 */

const fs = require("fs");
const path = require("path");

const SERVER = process.env.SERVER_JS || path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  failures.push(label);
  console.error(`  FAIL: ${label}`);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label} (got ${a}, want ${e})`);
}

function extractFunction(name) {
  const re = new RegExp(`^function ${name}\\s*\\(`, "gm");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) throw new Error(`expected exactly 1 definition of function ${name}(), found ${hits.length}`);
  const start = hits[0].index;
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`could not find the end of ${name}()`);
  return src.slice(start, end + 3);
}

const harness = [
  extractFunction("resolveDailyRate"),
  extractFunction("truckEditLockBlockers"),
].join("\n") + "\nreturn { truckEditLockBlockers };";

const LOCKED = ["2026-06", "2026-07", "2026-08"];
const S = {
  structures: {},
  workedMonths: {},  // normalized driver → the finalized months they worked
  everAssigned: 0,
};
const norm = (s) => String(s || "").trim().toLowerCase();
const stubs = {
  periodLocksReadable: () => true,
  lockedPeriodsDesc: () => LOCKED.slice().reverse(),
  truckFixedCostLockedMonths: () => [],
  truckMonthlyFixed: () => ({ total: 0 }),
  truckFeeLockedRows: () => ({ maintenance: [], compliance: [] }),
  driverPayLockedMonths: (name, locked) => (S.workedMonths[norm(name)] || []).filter((m) => locked.includes(m)),
  normalizeDriverName: norm,
  getDriverPayStructures: () => S.structures,
  TRUCK_AMOUNT_FIELDS: [],
  investorPayoutBasis: require("../lib/investor-payout-basis"),
  db: {
    prepare: (sql) => ({
      get: () => {
        if (/COUNT\(\*\) n FROM truck_assignments/.test(sql)) return { n: S.everAssigned };
        throw new Error(`unstubbed query: ${sql}`);
      },
    }),
  },
};
const names = Object.keys(stubs);
const G = new Function(...names, harness)(...names.map((n) => stubs[n]));

const truck = (driver, rate) => ({ id: 4, unit_number: "LogisX-#302", status: "Active", assigned_driver: driver, driver_pay_daily: rate });
const rateBlock = (t, changed) => G.truckEditLockBlockers(t, changed).blockers.filter((b) => b.field === "driver_pay_daily");

S.structures = {
  "pat percent": { payType: "percentage", payPercentage: 20, payDaily: 0 },
  "fay fixed": { payType: "fixed", payPercentage: 0, payDaily: 0 },
  "owen own-rate": { payType: "fixed", payPercentage: 0, payDaily: 275 },
};
S.workedMonths = { "pat percent": LOCKED, "fay fixed": LOCKED, "owen own-rate": LOCKED, "nora no-row": LOCKED };

console.log("Check (6) — the daily rate against the driver's pay type");

// The reported case: a percentage-paid driver's truck rate, cleared or changed.
eq(rateBlock(truck("Pat Percent", 20), { driver_pay_daily: 0 }), [], "clearing the rate on a percentage-paid driver's truck is allowed");
eq(rateBlock(truck("Pat Percent", 20), { driver_pay_daily: 300 }), [], "changing it is allowed too");

// Day-rate drivers are guarded exactly as before.
const fixed = rateBlock(truck("Fay Fixed", 250), { driver_pay_daily: 300 });
eq(fixed.map((b) => b.periods), [LOCKED], "a fixed-pay driver's rate change still blocks every finalized month they worked");
ok(fixed[0] && /daily pay \$250\.00 → \$300\.00 reprices Fay Fixed's active days/.test(fixed[0].detail), "and the message is unchanged");
eq(rateBlock(truck("Nora No-Row", 250), { driver_pay_daily: 300 }).map((b) => b.periods), [LOCKED], "a driver with no directory row is paid by the day, so still guarded");
eq(rateBlock(truck("Owen Own-Rate", 250), { driver_pay_daily: 300 }), [], "a driver whose own rate overrides the truck's is still let through");

// The driver the edit LEAVES on the truck decides, in both directions.
eq(rateBlock(truck("Fay Fixed", 250), { driver_pay_daily: 300, assigned_driver: "Pat Percent" }), [],
  "rate change that leaves a percentage-paid driver on the truck is allowed");
eq(rateBlock(truck("Pat Percent", 20), { driver_pay_daily: 300, assigned_driver: "Fay Fixed" }).map((b) => b.periods), [LOCKED],
  "rate change that leaves a fixed-pay driver on the truck is guarded, whoever was on it before");

// The driverless fallback (the clear-driver-then-change-rate sequence) is untouched.
S.everAssigned = 1;
eq(rateBlock(truck("", 250), { driver_pay_daily: 900 }).map((b) => b.periods), [LOCKED], "a driverless truck that has carried a driver is still guarded");
eq(rateBlock(truck("Pat Percent", 20), { driver_pay_daily: 900, assigned_driver: "" }).map((b) => b.periods), [LOCKED],
  "clearing a percentage-paid driver and changing the rate in one edit is still guarded");

// ---------------------------------------------------------------------------
// Truck create, check (2), and truck delete, check (2): the same rule
// ---------------------------------------------------------------------------
// A new truck's rate replaces the rate of the truck the driver held, and a
// deleted truck's rate falls back to the driver's own, else $250. Both compared
// the daily rates without looking at the pay type, as check (6) did.
console.log("Truck create and truck delete — the daily rate against the driver's pay type");
const cdHarness = [
  extractFunction("resolveDailyRate"),
  extractFunction("truckCreateLockBlockers"),
  extractFunction("truckDeleteLockBlockers"),
].join("\n") + "\nreturn { truckCreateLockBlockers, truckDeleteLockBlockers };";
S.truckRates = {};  // normalized driver → the daily rates of the trucks naming them
const cdStubs = {
  ...stubs,
  truckChargeFromMonth: () => "",
  truckDailyRateCandidates: (name) => S.truckRates[norm(name)] || [undefined],
  // No investor owns these trucks, so the driver-set checks find nothing to move.
  investorsHoldingDriver: () => new Set(),
  db: { prepare: () => ({ all: () => [] }) },
};
const cdNames = Object.keys(cdStubs);
const CD = new Function(...cdNames, cdHarness)(...cdNames.map((n) => cdStubs[n]));
S.truckRates = { "pat percent": [20], "fay fixed": [250], "owen own-rate": [250] };
const NO_HISTORY_BOUND = undefined;
const created = (driver, rate) => CD.truckCreateLockBlockers({
  id: 0, unit_number: "LogisX-#400", status: "Active", owner_id: 0, assigned_driver: driver,
  driver_pay_daily: rate, in_service_date: "", created_at: "2026-10-03 09:00:00",
}, NO_HISTORY_BOUND).blockers.filter((b) => b.field === "driver_pay_daily");
const deleted = (driver, rate) => CD.truckDeleteLockBlockers({ ...truck(driver, rate), owner_id: 0 })
  .blockers.filter((b) => b.table === "trucks.driver_pay_daily");

eq(created("Pat Percent", 300), [], "create: a new truck at $300/day for a percentage-paid driver is allowed");
const createdFixed = created("Fay Fixed", 300);
eq(createdFixed.map((b) => b.periods), [LOCKED], "create: the same truck for a fixed-pay driver is still refused over every finalized month they worked");
ok(createdFixed[0] && /assigning Fay Fixed to a new truck at \$300\.00\/day replaces the \$250\.00\/day/.test(createdFixed[0].detail), "create: and its message is unchanged");
eq(created("Owen Own-Rate", 300), [], "create: a driver whose own rate overrides the truck's is still let through");
eq(deleted("Pat Percent", 20), [], "delete: deleting a percentage-paid driver's truck is allowed (its rate reached none of their pay)");
const deletedFixed = deleted("Fay Fixed", 300);
eq(deletedFixed.map((b) => b.periods), [LOCKED], "delete: deleting a fixed-pay driver's $300 truck is still refused (their pay reverts to $250)");
ok(deletedFixed[0] && /Fay Fixed's pay reverts \$300\.00 → \$250\.00\/day/.test(deletedFixed[0].detail), "delete: and its message is unchanged");
eq(deleted("Nora No-Row", 300).map((b) => b.periods), [LOCKED], "delete: a driver with no directory row is paid by the day, so still guarded");

// ---------------------------------------------------------------------------
// The two facts the skip rests on
// ---------------------------------------------------------------------------
console.log("Premise 1 — percentage pay never reads a daily rate (lib/financials-calc.js)");
const { computeLedgerScope } = require("../lib/financials-calc");
const ledgerPay = (rateFor, rateForDay) => computeLedgerScope({
  rows: [{
    loadId: "L1", driver: "pat percent", truckUnit: "logisx-#302", truckLabel: "LogisX-#302",
    assignedDate: new Date(2026, 6, 6, 12), pickupDate: new Date(2026, 6, 6, 12), dropoffDate: new Date(2026, 6, 8, 12),
    completed: true, amount: 3000, ownerId: 7, ownerCell: "7", rowIndex: 2,
  }],
  unitToVid: {}, eldByVid: {}, driverDayOverrides: {}, addDaysFor: () => false,
  payStructures: { "pat percent": { payType: "percentage", payPercentage: 20, payDaily: 0 } },
  expensesByDriverMonth: { "pat percent": { "2026-07": 500 } },
  rateFor, rateForDay,
  tripByMonth: {}, maintByMonth: {}, complianceByMonth: {}, receipts: [], maintRows: [], complianceRows: [],
  fixedTrucks: [], truckChargedInMonth: () => false, truckMonthlyFixed: () => ({ total: 0 }),
  isZeroActivityMonth: () => false, startMonthFor: (m) => m || "2026-07",
  currentMonthKey: "2026-08", endDate: new Date(2026, 7, 1), ownerId: 7,
}).items.filter((i) => i.kind === "driver_pay");
const pay20 = ledgerPay(() => 20, null);
eq(pay20.map((i) => [i.month, i.cents, i.payType]), [["2026-07", 50000, "percentage"]], "a percentage driver is paid 20% of net revenue ($3,000 − $500)");
eq(ledgerPay(() => 900, null), pay20, "a different daily rate pays them exactly the same");
eq(ledgerPay(() => 900, () => 900), pay20, "so does a different rate for each day (the dated-rates rule)");

console.log("Premise 2 — switching them to a day rate is still guarded (directoryEditLockBlockers)");
const dirHarness = [extractFunction("directoryPayStruct"), extractFunction("resolveDailyRate"), extractFunction("directoryEditLockBlockers")].join("\n") +
  "\nreturn { directoryEditLockBlockers };";
const dirStubs = {
  periodLocksReadable: () => true,
  lockedPeriodsDesc: () => LOCKED.slice().reverse(),
  driverPayLockedMonths: stubs.driverPayLockedMonths,
  normalizeDriverName: norm,
  truckDailyRateCandidates: () => [250],
  investorsHoldingDriver: () => [],
  syncCarrierDriverHistory: () => {},
};
const dirNames = Object.keys(dirStubs);
const D = new Function(...dirNames, dirHarness)(...dirNames.map((n) => dirStubs[n]));
const patRow = { id: 1, driver_name: "Pat Percent", pay_type: "percentage", pay_percentage: 20, pay_daily: 0 };
const toFixed = D.directoryEditLockBlockers(patRow, { pay_type: "fixed" }).blockers.filter((b) => b.field === "pay_type");
eq(toFixed.map((b) => [b.from, b.to, b.periods]), [["percentage", "fixed", LOCKED]], "percentage → fixed is refused over every finalized month they worked");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
