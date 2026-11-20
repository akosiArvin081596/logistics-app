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

const src = require("./lib/server-source").serverSource();

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
// The forward-only link rule's stop (check (5b')), where the build has it: Part 5 runs its new cases only then.
const FORWARD_FNS = ["eldLinkRowReach", "eldLinkForwardStop", "eldLinkForwardBlocker"];
const hasForward = FORWARD_FNS.every((n) => new RegExp(`^function ${n}\\s*\\(`, "m").test(src));
let harness = [
  extractConstLine("ELD_LINK_TRUCK_COL_RE"),
  extractFunction("eldLinkUnitKey"),
  extractFunction("eldLinkRowMonths"),
  extractFunction("eldLinkPreflight", "async function"),
  extractFunction("sheetCellMonths"),
  extractFunction("sheetCellDate"),
  extractFunction("loadRowAccountingMonths"),
  extractFunction("truckEditLockBlockers"),
  ...(hasForward ? FORWARD_FNS.map((n) => extractFunction(n)) : []),
].join("\n");
// sheetCellMonths reads RFC 2822 month names from a const in server.js.
for (const c of ["RFC_MONTHS"]) {
  if (new RegExp(`\\b${c}\\b`).test(harness) && new RegExp(`^const ${c}\\s*=`, "m").test(src)) {
    const s = src.search(new RegExp(`^const ${c}\\s*=`, "m"));
    harness = src.slice(s, src.indexOf(";\n", s) + 2) + harness;
  }
}
harness += `
return { ELD_LINK_TRUCK_COL_RE, eldLinkUnitKey, eldLinkRowMonths, eldLinkPreflight, loadRowAccountingMonths, truckEditLockBlockers${hasForward ? ", " + FORWARD_FNS.join(", ") : ""} };`;

// Stubs — each is a DB or sheet read. Mutable so each case sets its own state.
const S = {
  locked: [],
  readable: true,
  trucks: {},
  sheetMonths: null,       // what eldLinkLoadMonths resolves to
  sheetThrows: false,
  sheetCalls: 0,
  onSheetRead: null,       // runs during the await (simulates a concurrent write)
  forward: false,          // the forward-only link rule in force (eldLinkForwardRule())
  nowMs: Date.parse("2026-11-18T16:00:00Z"),
  taps: {},                // load id (lower case) -> last Delivered changed_at, for the trip rule's 36-hour reach
  tapsThrow: false,
  tripFrom: null,          // TRIP_WORK_DAYS_FROM
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
  eldLinkLoadMonths: async (unit, opts) => {
    S.sheetCalls++;
    await Promise.resolve();
    if (S.onSheetRead) S.onSheetRead();
    if (S.sheetThrows) throw new Error("sheets down");
    return opts && opts.reach ? { months: S.sheetMonths, reach: S.sheetReach } : S.sheetMonths;
  },
  eldLinkForwardRule: () => ({ inForce: S.forward }),
  eldLinkForward: fs.existsSync(path.join(__dirname, "..", "lib", "eld-link-forward.js")) ? require("../lib/eld-link-forward") : null,
  TRIP_WORK_DAYS_FROM: null,
  periodLabel: (p) => new Date(`${p}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(S.nowMs); } static now() { return S.nowMs; } },
  db: {
    prepare: (sql) => ({
      get: (id) => {
        if (/FROM trucks WHERE id = \?/.test(sql)) return S.trucks[id] ? { ...S.trucks[id] } : undefined;
        if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
        if (/FROM load_status_history/.test(sql)) { if (S.tapsThrow) throw new Error("history unreadable"); return { at: S.taps[id] || null }; }
        throw new Error(`unstubbed query: ${sql}`);
      },
    }),
  },
  console: { warn: () => {}, log: console.log, error: console.error },
};
const names = Object.keys(stubs);
const build = (extra = {}) => new Function(...names, harness)(...names.map((n) => (n in extra ? extra[n] : stubs[n])));
const G = build();
// The same code with the trip work-day rule on (TRIP_WORK_DAYS_FROM), for check (5b')'s 36-hour reach.
const GT = build({ TRIP_WORK_DAYS_FROM: "2026-10" });

console.log("Extracted the ELD-link guard, its row scanner and preflight from server.js\n");

// ---------------------------------------------------------------------------
// Part 1 — eldLinkRowMonths(): which months rows carrying THIS unit reach
// ---------------------------------------------------------------------------
console.log("Part 1 — rows carrying the unit");
const H = ["Load ID", "Driver", "Truck", "Assigned Date", "Pickup Appointment", "Drop-off Appointment", "Status"];
const row = (truck, assigned, pu, doff) => ["L1", "Hollis", truck, assigned, pu, doff, "Completed"];
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
    ok(/truckEditLockBlockers\(truck, \{ routemate_vehicle_id: [^}]+\}, \{ eldLinkMonths(?:, eldLinkForward: forwardStop)? \}\)/.test(body), `${label}: the guard is fed the preflight's months`);
    ok(!/SELECT \* FROM trucks WHERE id = \?"\)\.get\(truckId\);\s*\n[^]*?const truck = db/.test(body.slice(pre)), `${label}: nothing re-reads the truck after the preflight but the preflight`);
  }
  const linkBody = routeBody("post", "/api/trucks/:truckId/link-routemate");
  ok(linkBody.indexOf("await eldLinkPreflight(") < linkBody.indexOf("Already linked to truck"),
    "link: the already-linked-elsewhere check runs after the await, on fresh state");

  // -------------------------------------------------------------------------
  // Part 5 — check (5b'), the forward-only link rule's stop (made-up trucks T-101 and T-202)
  // -------------------------------------------------------------------------
  // New cases need the rule's functions and fail without them; the pins (fail-closed, the 36-hour reach) pass on a
  // build without the rule too, whose check (5b) refuses every one of them.
  console.log("Part 5 — the narrowed stop (5b')");
  const OCT = ["2026-10"];
  const T101 = { id: 1, unit_number: "T-101", status: "Active", routemate_vehicle_id: "D-7" };
  const T202 = { id: 2, unit_number: "T-202", status: "Active", routemate_vehicle_id: "D-9" };
  const SWITCH_MS = Date.parse("2026-11-18T16:00:00Z"); // Wed Nov 18, 11:00 Eastern
  // The stop as eldLinkForwardStop() hands it to the guard, built by hand.
  const stopOf = (rows, extra = {}) => ({ atMs: SWITCH_MS, at: new Date(SWITCH_MS).toISOString(), day: "2026-11-18", rows, tripTail: false, unreadable: false, ...extra });
  const guard5 = (truck, changed, stop, months = OCT, g = G) => g.truckEditLockBlockers(truck, changed, { eldLinkMonths: months, eldLinkForward: stop });
  const ended = { months: OCT, lastDay: "2026-10-28", loadId: "L-OCT1" };
  const running = { months: OCT, lastDay: "", loadId: "L-OCT2" };
  const WORDS = "its load assigned in October 2026 runs on or after Wed Nov 18, so this would change pay in a finalized month";
  const newCase = (label, fn) => { if (!hasForward) { ok(false, `${label} (this build has no check (5b'))`); return; } fn(); };
  S.locked = OCT; S.readable = true;

  // The pair (L3): one world, October finalized; T-101's October load ended Oct 28, T-202's is still running.
  eq(guard5(T101, { routemate_vehicle_id: "" }, stopOf([ended])).blockers, [], "L3 / the pair: unlinking T-101, whose finalized-month load ended before the change, passes");
  eq(guard5(T101, { routemate_vehicle_id: "D-11" }, stopOf([ended])).blockers, [], "the pair: re-pointing T-101 passes too");
  eq(guard5(T202, { routemate_vehicle_id: "" }, stopOf([running])).blockers.map((x) => [x.periods, x.detail, x.forward]), [[OCT, WORDS, true]],
    "L3 / the pair: unlinking T-202, whose finalized-month load is still running, refuses over October in the narrowed words");
  eq(guard5(T202, { routemate_vehicle_id: "D-7" }, stopOf([running])).blockers.map((x) => x.detail), [WORDS], "the pair: re-pointing T-202 refuses in the same words");
  eq(guard5(T202, { routemate_vehicle_id: "" }, stopOf([running, { ...running, loadId: "L-OCT9", lastDay: "2026-11-20" }])).blockers.map((x) => x.detail),
    ["its 2 loads assigned in October 2026 run on or after Wed Nov 18, so this would change pay in a finalized month"], "two loads are counted");
  newCase("the row reach (eldLinkRowReach): each row's last date, \"\" with no end date, null for an unreadable date", () => {
    const H = ["Load ID", "Driver", "Truck", "Assigned Date", "Pickup Appointment", "Drop-off Appointment", "Status Update Date", "Status"];
    const rows = [
      ["L-OCT1", "Pat", "T-101", "10/26/2026", "10/26/2026 8:00", "10/28/2026 14:00", "10/28/2026", "Delivered"],
      ["L-OCT2", "Pat", "T-101", "10/30/2026", "10/30/2026 8:00", "", "", "In Transit"],
      ["L-OTHER", "Sam", "T-202", "10/30/2026", "10/30/2026", "", "", "In Transit"],
    ];
    eq(G.eldLinkRowReach(H, rows, "T-101"), [{ months: OCT, lastDay: "2026-10-28", loadId: "L-OCT1" }, { months: OCT, lastDay: "", loadId: "L-OCT2" }], "T-101's two rows");
    eq(G.eldLinkRowReach(H, [["L-X", "Pat", "T-101", "not a date", "", "", "", "Delivered"]], "T-101"), null, "an unreadable date → null");
    eq(G.eldLinkRowReach(H, rows, "T-303"), [], "a unit no row carries → no row");
  });
  if (!hasForward) ok(false, "the preflight hands the guard the stop while the rule is in force (this build has no check (5b'))");
  else {
    S.trucks = { 1: { ...T101 } }; S.sheetMonths = OCT; S.sheetReach = [ended]; S.sheetThrows = false; S.onSheetRead = null; S.forward = true;
    const r5 = await G.eldLinkPreflight(1, S.trucks[1]);
    eq([r5.eldLinkMonths, r5.eldLinkForward && r5.eldLinkForward.rows, r5.eldLinkForward && r5.eldLinkForward.day, r5.eldLinkForward && r5.eldLinkForward.at],
      [OCT, [ended], "2026-11-18", "2026-11-18T16:00:00.000Z"], "in force: the months, the rows, the switch day and its instant");
    S.forward = false;
    const r6 = await G.eldLinkPreflight(1, S.trucks[1]);
    eq(Object.keys(r6).sort(), ["eldLinkMonths", "truck"], "not in force: the preflight's answer is as before");
    S.forward = true; S.tripFrom = null;
    S.taps = { "l-oct1": "2026-11-17 02:00:00" };
    const st = GT.eldLinkForwardStop([ended]);
    eq([st.tripTail, st.rows.map((r) => r.tapMs)], [true, [Date.parse("2026-11-17T02:00:00Z")]], "with the trip rule on, each row carries its last Delivered tap");
    S.tapsThrow = true;
    eq(GT.eldLinkForwardStop([ended]).unreadable, true, "a tap read that fails marks the stop unreadable");
    S.tapsThrow = false; S.taps = {}; S.forward = false;
  }
  const oldTap = { ...ended, lastDay: "2026-11-14", tapMs: Date.parse("2026-11-14T02:00:00Z"), noLoadId: false };
  eq(guard5(T101, { routemate_vehicle_id: "" }, stopOf([oldTap], { tripTail: true, atMs: Date.parse("2026-11-16T13:00:00Z"), day: "2026-11-16" }), OCT, GT).blockers, [],
    "N7's twin: with the trip rule on, a finalized-month load delivered 3 days before the change passes");

  // Pins: each passes on a build without the rule, and names the mutant it catches.
  const S_LOCKED2 = ["2026-09", "2026-10"];
  S.locked = S_LOCKED2;
  eq(guard5(T202, { routemate_vehicle_id: "" }, stopOf([running])).blockers.map((x) => x.periods), [OCT],
    "pin (mutant: the stop failing open): a finalized-month load with no end date refuses");
  eq(guard5(T101, { routemate_vehicle_id: "" }, stopOf(null), null).blockers.map((x) => x.periods), [S_LOCKED2],
    "pin (mutant: the stop failing open): an unreadable date holds every finalized month");
  eq(guard5(T101, { routemate_vehicle_id: "" }, stopOf([ended], { unreadable: true }), null).blockers.map((x) => x.periods), [S_LOCKED2],
    "pin (mutant: the stop failing open): a Delivered tap read that failed holds every finalized month");
  S.readable = false;
  ok(guard5(T101, { routemate_vehicle_id: "" }, stopOf([ended])).unreadable === true, "pin (mutant: the stop failing open): unreadable locks still fail closed");
  S.readable = true;
  S.locked = OCT;
  const lateTap = { ...ended, lastDay: "2026-11-14", tapMs: Date.parse("2026-11-15T02:00:00Z"), noLoadId: false };
  eq(guard5(T101, { routemate_vehicle_id: "" }, stopOf([lateTap], { tripTail: true, atMs: Date.parse("2026-11-16T13:00:00Z"), day: "2026-11-16" }), OCT, GT).blockers.map((x) => x.periods), [OCT],
    "pin N7 (mutant: the 36-hour reach missing): a load tapped Delivered at 21:00 two days before a swap at 08:00 refuses");

  // -------------------------------------------------------------------------
  // Part 6 — Move device's one read for two trucks (made-up T-101 and T-202)
  // -------------------------------------------------------------------------
  // Each case FAILS ON THE OLD CODE: eldLinkLoadReaches(), eldMovePreflight() and eldLinkBadCell() do not exist there.
  console.log("Part 6 — Move device's preflight");
  const moveCase = async (label, fn) => {
    try { await fn(); } catch (e) { ok(false, `${label} (threw: ${String(e.message).split("\n")[0]})`); }
  };
  const MH = ["Load ID", "Driver", "Truck", "Assigned Date", "Pickup Appointment", "Drop-off Appointment", "Status Update Date", "Status"];
  const MROWS = [
    ["L-OCT1", "Pat", "T-101", "10/26/2026", "10/26/2026 8:00", "10/28/2026 14:00", "10/28/2026", "Delivered"],
    ["L-OCT2", "Sam", "T-202", "10/30/2026", "10/30/2026 8:00", "", "", "In Transit"],
    ["", "Sam", "T-202", "10/29/2026", "10/29/2026", "11/02/2026", "11/02/2026", "Delivered"],
  ];
  // The move's functions over the same stubs, with a sheet that counts its reads and a clock that can tick.
  const M = { reads: 0, values: null, throws: false, onRead: null, tick: 0 };
  const moveHarness = () => {
    const pieces = ["eldLinkRowWhere", "eldLinkBadCell"].map((n) => extractFunction(n))
      .concat(["eldLinkLoadReaches", "eldMovePreflight"].map((n) => extractFunction(n, "async function")));
    const src = harness.replace(/\nreturn \{[^}]*\};\s*$/, "\n") + pieces.join("\n") + "\nreturn { eldLinkLoadReaches, eldMovePreflight, eldLinkBadCell, eldLinkRowReach };";
    const extra = {
      getSheets: async () => ({ spreadsheets: { values: { get: async () => {
        M.reads++;
        await Promise.resolve();
        if (M.onRead) M.onRead();
        if (M.throws) throw new Error("sheets down");
        return { data: { values: M.values } };
      } } } }),
      SPREADSHEET_ID: "test-sheet",
      Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(S.nowMs + M.tick); } static now() { M.tick += M.ticking ? 5 : 0; return S.nowMs + M.tick; } },
    };
    const allNames = [...names, ...Object.keys(extra).filter((n) => !names.includes(n))];
    return new Function(...allNames, src)(...allNames.map((n) => (n in extra ? extra[n] : stubs[n])));
  };
  S.locked = OCT; S.readable = true; S.forward = true;
  S.trucks = { 1: { ...T101 }, 2: { ...T202 } };

  await moveCase("Part 6.1", async () => {
    const MV = moveHarness();
    M.reads = 0; M.values = [MH, ...MROWS];
    const [a, b] = await MV.eldLinkLoadReaches(["T-101", "T-202"]);
    eq(M.reads, 1, "6.1 both units' reach comes from ONE Job Tracking read (FAILS ON THE OLD CODE)");
    eq(a.reach, [{ months: OCT, lastDay: "2026-10-28", loadId: "L-OCT1", sheetRow: 2, pickupDay: "2026-10-26" }], "6.1a T-101's row with its sheet row and pickup day (FAILS ON THE OLD CODE)");
    eq(b.reach.map((r) => [r.loadId, r.lastDay, r.sheetRow, r.pickupDay]), [["L-OCT2", "", 3, "2026-10-30"], ["", "2026-11-02", 4, "2026-10-29"]], "6.1b T-202's two rows from the same values (FAILS ON THE OLD CODE)");
    eq([a.cell, b.cell], [null, null], "6.1c every row readable: no cell named (FAILS ON THE OLD CODE)");
  });

  await moveCase("Part 6.2", async () => {
    const MV = moveHarness();
    M.reads = 0; M.values = [MH, ...MROWS]; M.ticking = true; M.tick = 0;
    const pre = await MV.eldMovePreflight(S.trucks[1], S.trucks[2]);
    M.ticking = false;
    eq([M.reads, pre.sides[0].stop.atMs === pre.atMs, pre.sides[1].stop.atMs === pre.atMs, pre.sides[0].stop.day, pre.sides[1].stop.day],
      [1, true, true, "2026-11-18", "2026-11-18"], "6.2 one read, and both stops built from the one instant though the clock ticks (FAILS ON THE OLD CODE)");
    eq([pre.sides.map((s) => s.why), pre.sides[1].stop.rows.length, pre.source.unit_number, pre.target.unit_number], [[null, null], 2, "T-101", "T-202"],
      "6.2a both rows known; the trucks re-read after the await (FAILS ON THE OLD CODE)");
  });

  await moveCase("Part 6.3", async () => {
    const MV = moveHarness();
    M.values = [MH, ...MROWS];
    M.onRead = () => { S.trucks[2].unit_number = "T-202B"; };
    const pre = await MV.eldMovePreflight({ ...T101 }, { ...T202 });
    M.onRead = null; S.trucks[2] = { ...T202 };
    eq([pre.sides[0].why, pre.sides[1].why, pre.sides[1].stop.rows, pre.sides[0].stop.rows.length], [null, "read", null, 1],
      "6.3 a unit renamed during the read: that side unknown (\"read\"), the other kept (FAILS ON THE OLD CODE)");
    M.throws = true;
    const down = await MV.eldMovePreflight({ ...T101 }, { ...T202 });
    M.throws = false;
    eq(down.sides.map((s) => [s.why, s.stop.rows]), [["read", null], ["read", null]], "6.3a a read that fails: both sides \"read\" (FAILS ON THE OLD CODE)");
    S.locked = [];
    M.reads = 0;
    const open = await MV.eldMovePreflight({ ...T101 }, { ...T202 });
    S.locked = OCT;
    eq([M.reads, open.sides.map((s) => s.why)], [0, [null, null]], "6.3b no finalized month: the sheet is not read (FAILS ON THE OLD CODE)");
  });

  await moveCase("Part 6.4", async () => {
    const MV = moveHarness();
    const bad = ["L-1001", "Lee", "T-150", "10/26/2026", "14:00", "10/28/2026", "10/28/2026", "Delivered"];
    M.values = [MH, ...MROWS, bad];
    const [, , c] = await MV.eldLinkLoadReaches(["T-101", "T-202", "T-150"]);
    eq([c.months, c.reach, c.cell], [null, null, { loadId: "L-1001", sheetRow: 5, pickupDay: "", header: "Pickup Appointment", value: "14:00" }],
      "6.4 a cell the server can't read is named as sheetRowUpdateBlocker names it, with the row's Load ID and sheet row (FAILS ON THE OLD CODE)");
    eq(MV.eldLinkBadCell(MH, [["", "Lee", "T-150", "", "", "", "", "Delivered"]], "T-150", 2), { loadId: "", sheetRow: 2, pickupDay: "", header: "", value: "" },
      "6.4a a row of the unit with no date at all: no header (FAILS ON THE OLD CODE)");
  });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
