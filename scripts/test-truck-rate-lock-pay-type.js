#!/usr/bin/env node
/**
 * Unit assertions for check (6) of truckEditLockBlockers(): a truck's daily
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

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
