#!/usr/bin/env node
/**
 * Unit assertions for the ELD-link period guard — check (5b) of
 * truckEditLockBlockers() and the months it is scoped to.
 *
 * The guard used to refuse ANY link, unlink or re-point while any month was
 * finalized, so a truck added this month could not be linked to its ELD at all
 * (LogisX-#23, 2026-09-28: refused over 16 months it never hauled in). It now
 * blocks only the finalized months that Job Tracking rows carrying THIS unit
 * reach, and falls back to every finalized month whenever that cannot be known.
 *
 * ⚠️ THE CODE UNDER TEST IS EXTRACTED FROM server.js SOURCE, not copied here.
 * Every extraction asserts the definition is found EXACTLY ONCE. Only database
 * and sheet reads are stubbed.
 *
 * Run: node scripts/test-eld-link-lock-scope.js
 * Against a base commit: SERVER_JS=/tmp/base.js node scripts/test-eld-link-lock-scope.js
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

function extractFunction(name, prefix = "function") {
  const re = new RegExp(`^${prefix} ${name}\\s*\\(`, "gm");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 definition of ${prefix} ${name}(), found ${hits.length}`);
  }
  const start = hits[0].index;
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`could not find the end of ${name}()`);
  return src.slice(start, end + 3);
}
function extractConstLine(name) {
  const re = new RegExp(`^const ${name}\\s*=.*$`, "gm");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) throw new Error(`expected exactly 1 definition of const ${name}, found ${hits.length}`);
  return hits[0][0];
}
// The body of an Express handler, from its `app.<verb>("<path>"` line to the
// next top-level route or comment block.
function routeBody(verb, route) {
  const needle = `app.${verb}("${route}"`;
  const start = src.indexOf(needle);
  if (start === -1 || src.indexOf(needle, start + 1) !== -1) throw new Error(`expected exactly 1 ${needle}`);
  const end = src.indexOf("\n});\n", start);
  return src.slice(start, end + 5);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let harness = [
  extractConstLine("ELD_LINK_TRUCK_COL_RE"),
  extractFunction("eldLinkUnitKey"),
  extractFunction("eldLinkRowMonths"),
  extractFunction("eldLinkPreflight", "async function"),
  extractFunction("sheetCellMonths"),
  extractFunction("sheetCellDate"),
  extractFunction("loadRowAccountingMonths"),
  extractFunction("truckEditLockBlockers"),
].join("\n");
// sheetCellMonths reads RFC 2822 month names from a const in server.js.
for (const c of ["RFC_MONTHS"]) {
  if (new RegExp(`\\b${c}\\b`).test(harness) && new RegExp(`^const ${c}\\s*=`, "m").test(src)) {
    const s = src.search(new RegExp(`^const ${c}\\s*=`, "m"));
    harness = src.slice(s, src.indexOf(";\n", s) + 2) + harness;
  }
}
harness += `
return { ELD_LINK_TRUCK_COL_RE, eldLinkUnitKey, eldLinkRowMonths, eldLinkPreflight, loadRowAccountingMonths, truckEditLockBlockers };`;

// Stubs — each is a DB or sheet read. Mutable so each case sets its own state.
const S = {
  locked: [],
  readable: true,
  trucks: {},
  sheetMonths: null,       // what eldLinkLoadMonths resolves to
  sheetThrows: false,
  sheetCalls: 0,
  onSheetRead: null,       // runs during the await (simulates a concurrent write)
};
const stubs = {
  periodLocksReadable: () => S.readable,
  lockedPeriodsDesc: () => S.locked.slice().sort().reverse(),
  truckFixedCostLockedMonths: () => [],
  truckMonthlyFixed: () => ({ total: 0 }),
  truckFeeLockedRows: () => ({ maintenance: [], compliance: [] }),
  driverPayLockedMonths: () => [],
  resolveDailyRate: (a, b) => a || b || 250,
  normalizeDriverName: (s) => String(s || "").trim().toLowerCase(),
  getDriverPayStructures: () => ({}),
  // The amount-field checks never fire here (no amount column in `changed`).
  TRUCK_AMOUNT_FIELDS: [],
  // The fleet rule the guard reads (any status but Inactive), the real module.
  investorPayoutBasis: require("../lib/investor-payout-basis"),
  eldLinkLoadMonths: async () => {
    S.sheetCalls++;
    await Promise.resolve();
    if (S.onSheetRead) S.onSheetRead();
    if (S.sheetThrows) throw new Error("sheets down");
    return S.sheetMonths;
  },
  db: {
    prepare: (sql) => ({
      get: (id) => {
        if (/FROM trucks WHERE id = \?/.test(sql)) return S.trucks[id] ? { ...S.trucks[id] } : undefined;
        if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
        throw new Error(`unstubbed query: ${sql}`);
      },
    }),
  },
  console: { warn: () => {}, log: console.log, error: console.error },
};
const names = Object.keys(stubs);
const G = new Function(...names, harness)(...names.map((n) => stubs[n]));

console.log("Extracted the ELD-link guard, its row scanner and preflight from server.js\n");

// ---------------------------------------------------------------------------
// Part 1 — eldLinkRowMonths(): which months rows carrying THIS unit reach
// ---------------------------------------------------------------------------
console.log("Part 1 — rows carrying the unit");
const H = ["Load ID", "Driver", "Truck", "Assigned Date", "Pickup Appointment", "Drop-off Appointment", "Status"];
const row = (truck, assigned, pu, doff) => ["L1", "Howard", truck, assigned, pu, doff, "Completed"];
const ROWS = [
  row("LogisX-#33", "2026-08-03", "2026-08-03", "2026-08-05"),
  row("LogisX-#2372", "2025-07-10", "2025-07-10", "2025-07-12"),
  row("", "2026-06-01", "2026-06-01", "2026-06-02"),
];

// The reported case: a brand-new truck no row carries → nothing at risk.
eq(G.eldLinkRowMonths(H, ROWS, "LogisX-#23"), [], "a unit no row carries reaches no month (LogisX-#23)");
// A prefix is not a match: "LogisX-#2372" must not count for "LogisX-#23".
eq(G.eldLinkRowMonths(H, [row("LogisX-#2372", "2025-07-10", "", "")], "LogisX-#23"), [], "a unit that is a prefix of another does not match it");
eq(G.eldLinkRowMonths(H, ROWS, "LogisX-#33"), ["2026-08"], "a carried unit reaches its row's months");
eq(G.eldLinkRowMonths(H, [row("  logisx-#33 ", "2026-08-03", "", "")], "LogisX-#33"), ["2026-08"], "case and surrounding space do not hide a row");
eq(G.eldLinkRowMonths(H, [row("LogisX- #33", "2026-08-03", "", "")], "LogisX-  #33"), ["2026-08"], "internal whitespace is collapsed on both sides (only widens)");
// Assigned month + appointment months + the window interior.
eq(G.eldLinkRowMonths(H, [row("LogisX-#33", "2026-05-20", "2026-06-29", "2026-08-05")], "LogisX-#33"),
  ["2026-05", "2026-06", "2026-07", "2026-08"], "assigned month plus every month of the pickup→drop-off window");
// Every Truck-like column is read, not only the first.
const H2 = ["Load ID", "Truck", "Truck Number", "Assigned Date"];
eq(G.eldLinkRowMonths(H2, [["L2", "", "LogisX-#33", "2026-04-02"]], "LogisX-#33"), ["2026-04"], "a second Truck-like column is read too");
// Fail closed on a row of this unit whose month cannot be read.
eq(G.eldLinkRowMonths(H, [row("LogisX-#33", "not a date", "", "")], "LogisX-#33"), null, "an unreadable date on this unit's row → null (guard every month)");
eq(G.eldLinkRowMonths(H, [row("LogisX-#33", "", "", "")], "LogisX-#33"), null, "this unit's row with no date at all → null");
// …but an unreadable row of ANOTHER unit is none of this guard's business.
eq(G.eldLinkRowMonths(H, [row("LogisX-#91", "not a date", "", ""), ...ROWS], "LogisX-#23"), [], "another unit's unreadable row is ignored");
eq(G.eldLinkRowMonths(H, ROWS, ""), [], "a blank unit resolves nothing");
eq(G.eldLinkRowMonths(["Load ID", "Assigned Date"], [["L1", "2026-08-01"]], "LogisX-#33"), [], "no Truck column → no row resolves through the map");
ok(G.ELD_LINK_TRUCK_COL_RE.test("Truck") && G.ELD_LINK_TRUCK_COL_RE.test("Truck #") && G.ELD_LINK_TRUCK_COL_RE.test("Unit Number"),
  "the Truck regex covers the headers the pay paths match");
// The regex must be the pay paths' own, character for character.
const PAY_RE = "/^truck$|truck[._\\s-]?(unit|number|#)|unit[._\\s-]?number/i";
ok(src.includes(`findCol(headers, ${PAY_RE})`) && String(G.ELD_LINK_TRUCK_COL_RE) === PAY_RE,
  "ELD_LINK_TRUCK_COL_RE is the same regex the pay paths use");

// ---------------------------------------------------------------------------
// Part 2 — check (5b) scoped by opts.eldLinkMonths
// ---------------------------------------------------------------------------
console.log("Part 2 — check (5b)");
const SIXTEEN = [];
for (let y = 2025, m = 5; !(y === 2026 && m === 9); m === 12 ? (y++, m = 1) : m++) SIXTEEN.push(`${y}-${String(m).padStart(2, "0")}`);
S.locked = SIXTEEN;
const T23 = { id: 23, unit_number: "LogisX-#23", status: "Active", routemate_vehicle_id: "" };
const link = (truck, opts) => G.truckEditLockBlockers(truck, { routemate_vehicle_id: "dev-new" }, opts);

eq(SIXTEEN.length, 16, "fixture: 16 finalized months, May 2025 – Aug 2026");
eq(link(T23, { eldLinkMonths: [] }).blockers, [], "linking a truck with no load in a finalized month is allowed");
eq(link(T23, { eldLinkMonths: ["2026-09"] }).blockers, [], "loads only in the open month do not block");
const scoped = link(T23, { eldLinkMonths: ["2026-07", "2026-08", "2026-09"] }).blockers;
eq(scoped.map((b) => b.periods), [["2026-07", "2026-08"]], "blocks exactly the finalized months its loads reach");
ok(scoped[0] && /across 2 finalized months that carry its loads/.test(scoped[0].detail), "the message counts only those months");
// Fail closed: anything but an array means "not measured".
eq(link(T23, {}).blockers.map((b) => b.periods.length), [16], "no measurement → every finalized month (fail closed)");
eq(link(T23, { eldLinkMonths: null }).blockers.map((b) => b.periods.length), [16], "null (unreadable row / tab) → every finalized month");
eq(link(T23).blockers.map((b) => b.periods.length), [16], "called without opts (PUT /api/trucks/:id) → unchanged behaviour");
// Unlink and re-point are scoped the same way.
const linked = { ...T23, routemate_vehicle_id: "dev-old" };
eq(G.truckEditLockBlockers(linked, { routemate_vehicle_id: "" }, { eldLinkMonths: [] }).blockers, [], "unlinking a truck with no finalized-month loads is allowed");
eq(G.truckEditLockBlockers(linked, { routemate_vehicle_id: "" }, { eldLinkMonths: ["2025-12"] }).blockers.map((b) => b.periods), [["2025-12"]], "unlinking still blocks the months its loads reach");
eq(link(linked, { eldLinkMonths: ["2026-01"] }).blockers.map((b) => b.periods), [["2026-01"]], "re-pointing is scoped the same way");
S.readable = false;
ok(link(T23, { eldLinkMonths: [] }).unreadable === true, "an unreadable lock table still fails closed");
S.readable = true;

// ---------------------------------------------------------------------------
// Part 3 — eldLinkPreflight(): the await, the re-read, the fallbacks
// ---------------------------------------------------------------------------
console.log("Part 3 — preflight");
(async () => {
  S.trucks = { 23: { ...T23 } };
  S.sheetMonths = ["2026-08"]; S.sheetThrows = false; S.onSheetRead = null; S.sheetCalls = 0;
  let r = await G.eldLinkPreflight(23, S.trucks[23]);
  eq(r.eldLinkMonths, ["2026-08"], "passes the measured months through");
  ok(r.truck && r.truck !== S.trucks[23] && r.truck.unit_number === "LogisX-#23", "returns the row re-read after the await");

  S.sheetThrows = true;
  r = await G.eldLinkPreflight(23, S.trucks[23]);
  eq(r.eldLinkMonths, null, "an unreadable Job Tracking tab → null (every finalized month)");
  S.sheetThrows = false;

  S.onSheetRead = () => { S.trucks[23].unit_number = "LogisX-#24"; };
  r = await G.eldLinkPreflight(23, { ...T23 });
  eq(r.eldLinkMonths, null, "a rename during the await discards the measurement");
  eq(r.truck && r.truck.unit_number, "LogisX-#24", "and the caller guards the renamed row");
  S.onSheetRead = null; S.trucks[23].unit_number = "LogisX-#23";

  S.onSheetRead = () => { S.trucks[23].routemate_vehicle_id = "dev-raced"; };
  r = await G.eldLinkPreflight(23, { ...T23 });
  eq(r.truck && r.truck.routemate_vehicle_id, "dev-raced", "a link written during the await is seen by the checks that follow");
  S.onSheetRead = null;

  S.onSheetRead = () => { delete S.trucks[23]; };
  r = await G.eldLinkPreflight(23, { ...T23 });
  ok(r.truck === undefined, "a truck deleted during the await comes back missing (route answers 404)");
  S.onSheetRead = null; S.trucks[23] = { ...T23 };

  S.sheetCalls = 0; S.locked = [];
  r = await G.eldLinkPreflight(23, S.trucks[23]);
  ok(S.sheetCalls === 0, "no finalized month → the sheet is not read");
  S.locked = SIXTEEN;

  // -------------------------------------------------------------------------
  // Part 4 — the routes: preflight above every check, guard fed its result
  // -------------------------------------------------------------------------
  console.log("Part 4 — route wiring");
  for (const [verb, label] of [["post", "link"], ["delete", "unlink"]]) {
    const body = routeBody(verb, "/api/trucks/:truckId/link-routemate");
    const code = body.replace(/^\s*\/\/.*$/gm, "");   // comments may say "await"
    const awaits = code.match(/\bawait\b/g) || [];
    const pre = body.indexOf("await eldLinkPreflight(");
    const guard = body.indexOf("truckEditLockBlockers(");
    const write = body.indexOf("UPDATE trucks SET routemate_vehicle_id");
    ok(/requireRole\("Super Admin"\), async \(req, res\)/.test(body), `${label}: handler is async`);
    eq(awaits.length, 1, `${label}: exactly one await in the handler`);
    ok(pre > 0 && pre < guard && guard < write, `${label}: preflight → guard → write, in that order`);
    ok(/truckEditLockBlockers\(truck, \{ routemate_vehicle_id: [^}]+\}, \{ eldLinkMonths \}\)/.test(body), `${label}: the guard is fed the preflight's months`);
    ok(!/SELECT \* FROM trucks WHERE id = \?"\)\.get\(truckId\);\s*\n[^]*?const truck = db/.test(body.slice(pre)), `${label}: nothing re-reads the truck after the preflight but the preflight`);
  }
  const linkBody = routeBody("post", "/api/trucks/:truckId/link-routemate");
  ok(linkBody.indexOf("await eldLinkPreflight(") < linkBody.indexOf("Already linked to truck"),
    "link: the already-linked-elsewhere check runs after the await, on fresh state");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
