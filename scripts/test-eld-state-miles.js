#!/usr/bin/env node
// splitDeltasByDayAndState (lib/eld-miles.js): the walk behind eld_state_miles_daily.
//
// WHY THIS EXISTS. The per-state table and eld_miles_daily are two views of ONE
// odometer walk. If they ever disagree about how far a truck went on a day, a
// miles-by-state report and a miles-per-truck report will not reconcile, and
// nobody will be able to tell which is right. So the core assertion here is
// equality: for every day, the state rows sum to exactly the miles
// splitDeltasByDayAndDriver gives the same pings, including across a state
// line, across truck-local midnight, through a rejected odometer reset, and on
// a parked day.
//
// Fixtures run north up I-35 from Texas into Oklahoma across the Red River, at
// a 0.5-mile step so every rounded bucket sums exactly.
//
// Re-runs itself under three machine timezones: the day a mile lands in must
// depend on the truck's longitude, never on the server's zone.
//
// No network, no database, no server.
//
//   node scripts/test-eld-state-miles.js      # exits 1 on any failure

if (!process.env.ELD_TZ_CHILD) {
	const { spawnSync } = require("child_process");
	const zones = ["UTC", "America/Chicago", "Asia/Tokyo"];
	let failed = 0;
	for (const tz of zones) {
		const r = spawnSync(process.execPath, [__filename], {
			env: { ...process.env, TZ: tz, ELD_TZ_CHILD: "1" },
			encoding: "utf8",
		});
		const tail = (r.stdout || "").trim().split("\n").pop();
		console.log(`TZ=${tz.padEnd(16)} ${tail}`);
		if (r.status !== 0) {
			failed = 1;
			process.stderr.write(r.stdout || "");
			process.stderr.write(r.stderr || "");
		}
	}
	console.log(failed ? "\nFAILED under at least one timezone" : "\nidentical under every timezone");
	process.exit(failed);
}

const m = require("../lib/eld-miles");
const { stateAt } = require("../lib/us-states");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

const MIN = 60000;
const dayOf = (ms, lng) => m.localDayInTz(ms, m.usTzForLongitude(lng));
const opts = { dayOf, stateOf: stateAt };

// Per day: { state: miles } from the state walk, and miles from the driver walk.
function byDay(pings) {
	const states = {};
	for (const b of m.splitDeltasByDayAndState(pings, opts).values()) {
		states[b.localDay] = states[b.localDay] || {};
		states[b.localDay][b.state] = b.miles;
	}
	const days = {};
	for (const b of m.splitDeltasByDayAndDriver(pings, { dayOf, driverAt: () => "" }).values()) {
		days[b.localDay] = (days[b.localDay] || 0) + b.miles;
	}
	return { states, days };
}
const sum = (o) => Math.round(Object.values(o).reduce((a, b) => a + b, 0) * 10) / 10;

// A straight run from (lat0, lng) to (lat1, lng), one ping a minute, 0.5 mi each.
function drive(startMs, startOdo, n, lat0, lat1, lng) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({ ms: startMs + i * MIN, odo: startOdo + i * 0.5, lat: lat0 + ((lat1 - lat0) * i) / (n - 1), lng });
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. Across the Red River: TX miles and OK miles, summing to the day.
// ---------------------------------------------------------------------------
// 2026-08-14 17:00Z is midday in Texas. Gainesville TX (33.62) → Ardmore OK (34.17).
const redRiver = drive(Date.parse("2026-08-14T17:00:00Z"), 410000, 61, 33.62, 34.17, -97.14);
const rr = byDay(redRiver);
check("one truck-local day", Object.keys(rr.states), ["2026-08-14"]);
check("both states driven", Object.keys(rr.states["2026-08-14"]).sort(), ["OK", "TX"]);
check("TX and OK each got a share", Object.values(rr.states["2026-08-14"]).every((v) => v > 0), true);
check("state miles sum to the day's miles", sum(rr.states["2026-08-14"]), rr.days["2026-08-14"]);
check("and that is the whole run (60 deltas × 0.5 mi)", rr.days["2026-08-14"], 30);

// ---------------------------------------------------------------------------
// 2. Across truck-local midnight (Central): each day keeps its own miles.
// ---------------------------------------------------------------------------
// 04:40Z is 23:40 CDT; 40 minutes later it is the next local day.
const midnight = drive(Date.parse("2026-08-15T04:40:00Z"), 420000, 41, 33.62, 34.0, -97.14);
const mn = byDay(midnight);
check("two truck-local days", Object.keys(mn.states).sort(), ["2026-08-14", "2026-08-15"]);
for (const d of Object.keys(mn.days)) {
	check(`${d}: state miles sum to the day's miles`, sum(mn.states[d]), mn.days[d]);
}
check("nothing lost at midnight", sum(mn.days), 20);

// ---------------------------------------------------------------------------
// 3. An odometer reset mid-run: dropped, never carried, still equal.
// ---------------------------------------------------------------------------
const reset = drive(Date.parse("2026-08-16T15:00:00Z"), 430000, 31, 33.62, 34.17, -97.14);
for (let i = 16; i < reset.length; i++) reset[i].odo = 1000 + (i - 16) * 0.5; // the ELD swap
const rs = byDay(reset);
const rsBuckets = [...m.splitDeltasByDayAndState(reset, opts).values()];
check("the reset delta is rejected once", rsBuckets.reduce((a, b) => a + b.rejected, 0), 1);
check("reset day: state miles sum to the day's miles", sum(rs.states["2026-08-16"]), rs.days["2026-08-16"]);
check("29 good deltas survive", rs.days["2026-08-16"], 14.5);

// ---------------------------------------------------------------------------
// 4. A parked day still yields a row (samples, zero miles).
// ---------------------------------------------------------------------------
const parked = drive(Date.parse("2026-08-17T15:00:00Z"), 440000, 10, 35.4676, 35.4676, -97.5164)
	.map((p) => ({ ...p, odo: 440000 }));
const pk = [...m.splitDeltasByDayAndState(parked, opts).values()];
check("parked: one row", pk.length, 1);
check("parked: in Oklahoma, zero miles, every sample counted",
	[pk[0].state, pk[0].miles, pk[0].samples], ["OK", 0, 10]);

// ---------------------------------------------------------------------------
// 5. Samples are tallied to the state each ping sits in.
// ---------------------------------------------------------------------------
const rrBuckets = [...m.splitDeltasByDayAndState(redRiver, opts).values()];
check("every ping is counted exactly once", rrBuckets.reduce((a, b) => a + b.samples, 0), 61);

// ---------------------------------------------------------------------------
// 6. Duplicate timestamps are deduped the same way the driver walk dedupes them.
// ---------------------------------------------------------------------------
const dup = [...redRiver, { ...redRiver[30], odo: redRiver[30].odo - 0.2 }];
check("a duplicate ping changes nothing", byDay(dup), rr);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
