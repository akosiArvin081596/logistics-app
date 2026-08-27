#!/usr/bin/env node
// Deterministic check on the DRIVER + DAY attribution in lib/eld-miles.js —
// buildDriverAtResolver() and splitDeltasByDayAndDriver().
//
// WHY THIS EXISTS. Miles-per-driver-per-week is put next to that driver's
// invoice. If the two disagree about which days belong to whom, the page is
// worse than useless — it looks authoritative and contradicts the money. Three
// specific ways that happens, each pinned below:
//
//   1. THE DAY BOUNDARY. Days are bucketed in the TRUCK'S LOCAL timezone, not
//      the server's. A Friday-evening run in Texas is already Saturday in UTC,
//      so a UTC-day bucketer drops it into the NEXT billing week while driver
//      pay — which buckets truck-local — kept it in this one. The whole suite is
//      therefore re-run under a different TZ and must produce identical output.
//      The same class of bug is already recorded at centralMidnightMs().
//
//   2. end_date === '' MEANS STILL OPEN. Reading that empty string as an end
//      DATE rather than as UNBOUNDED silently strips every CURRENT driver of
//      every mile they have ever driven — the driver actively working the truck
//      is exactly the one who disappears. CLAUDE.md names this the single most
//      dangerous value in the schema, and it has been inverted twice before.
//
//   3. THE ISO-INSTANT vs BARE-DATE TRAP. truck_assignments.start_date is a full
//      instant ('2026-08-14T11:34:03.958Z') because assignDriverToTruck() writes
//      toISOString(). Comparing that to a bare 'YYYY-MM-DD' fails for every
//      afternoon assignment. The expenses subquery already paid for this once —
//      it over-stated a driver's profit by every first-day receipt in their
//      fleet's history.
//
// Fixtures are the REAL production assignment rows for Logisx-#91, including the
// genuine 2026-08-12 handover from Jayden Morrison to Shorn King.
//
// No network, no sheet, no database, no server — pure input/output.
//
//   node scripts/test-eld-miles-attribution.js      # exits 1 on any failure

const path = require("path");

// --- TZ INDEPENDENCE: re-exec once under a second timezone -------------------
// Bucketing must depend on the TRUCK's longitude, never on the machine running
// the code. If the server's zone leaks in, these two passes disagree.
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

const m = require(path.join(__dirname, "..", "lib", "eld-miles"));

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

// The real Logisx-#91 assignment history.
const ASSIGNMENTS = [
	{ truck_id: 11, driver_name: "Jayden Morrison", start_date: "2026-08-04T13:08:00.316Z", end_date: "2026-08-11T16:53:15.262Z" },
	{ truck_id: 11, driver_name: "Jayden Morrison", start_date: "2026-08-11T16:53:15.262Z", end_date: "2026-08-12T23:16:13.964Z" },
	{ truck_id: 11, driver_name: "Shorn King",      start_date: "2026-08-12T23:17:51.574Z", end_date: "2026-08-14T11:34:03.958Z" },
	{ truck_id: 11, driver_name: "Shorn King",      start_date: "2026-08-14T11:34:03.958Z", end_date: "" },
];
const R = m.buildDriverAtResolver(ASSIGNMENTS);

// --- 1. basic windows --------------------------------------------------------
check("mid-window resolves to the driver in force",
	R.atInstant(11, Date.parse("2026-08-06T12:00:00Z")), "Jayden Morrison");
check("after the handover, the new driver",
	R.atInstant(11, Date.parse("2026-08-13T12:00:00Z")), "Shorn King");
check("before any assignment: nobody, and not a throw",
	R.atInstant(11, Date.parse("2026-01-01T00:00:00Z")), "");
check("an unknown truck resolves to nobody", R.atInstant(999, Date.now()), "");
check("all four fixture rows parsed", R.unresolvedRows, 0);

// --- 2. end_date === '' IS UNBOUNDED ----------------------------------------
check("open assignment still holds a year later",
	R.atInstant(11, Date.parse("2027-06-01T00:00:00Z")), "Shorn King");
check("open assignment holds far into the future",
	R.atInstant(11, Date.parse("2030-01-01T00:00:00Z")), "Shorn King");
// The inverse: an empty end_date must NOT be read as an end date near the epoch,
// which would make the current driver vanish.
check("empty end_date is NOT treated as the epoch",
	R.atInstant(11, Date.parse("2026-08-20T00:00:00Z")) !== "", true);

// --- 3. THE ISO-INSTANT vs BARE-DATE TRAP -----------------------------------
// The 2026-08-14 assignment starts at 11:34 UTC. A day-grain lookup for that
// date must still find it — comparing '2026-08-14' against the full instant
// '2026-08-14T11:34:03.958Z' as strings would put the date FIRST and miss.
check("atDay finds an assignment that starts later that same day",
	R.atDay(11, "2026-08-14"), "Shorn King");
check("atDay on the handover day resolves (both bounds inclusive)",
	R.atDay(11, "2026-08-12") !== "", true);
check("atDay accepts a full instant as input too",
	R.atDay(11, "2026-08-14T23:59:59.999Z"), "Shorn King");
check("atDay before any assignment is nobody", R.atDay(11, "2026-01-01"), "");

// --- 4. OVERLAPPING ROWS: the latest start wins ------------------------------
const OVER = m.buildDriverAtResolver([
	{ truck_id: 1, driver_name: "Older", start_date: "2026-05-01T00:00:00.000Z", end_date: "" },
	{ truck_id: 1, driver_name: "Newer", start_date: "2026-06-01T00:00:00.000Z", end_date: "" },
]);
check("overlapping open assignments resolve to the most recent",
	OVER.atInstant(1, Date.parse("2026-07-01T00:00:00Z")), "Newer");
check("before the newer one starts, the older still holds",
	OVER.atInstant(1, Date.parse("2026-05-15T00:00:00Z")), "Older");

// --- 5. junk rows are skipped and COUNTED, never guessed at ------------------
const JUNK = m.buildDriverAtResolver([
	{ truck_id: 2, driver_name: "Good", start_date: "2026-05-01T00:00:00.000Z", end_date: "" },
	{ truck_id: 2, driver_name: "Bad", start_date: "not a date", end_date: "" },
	{ truck_id: 2, driver_name: "AlsoBad", start_date: "2026-05-01T00:00:00.000Z", end_date: "garbage" },
]);
check("unparseable rows are counted", JUNK.unresolvedRows, 2);
check("an unparseable start is NOT treated as unbounded-past",
	JUNK.atInstant(2, Date.parse("2020-01-01T00:00:00Z")), "");
check("the good row still resolves", JUNK.atInstant(2, Date.parse("2026-06-01T00:00:00Z")), "Good");

// --- 6. THE DAY BOUNDARY, and a mid-day handover -----------------------------
const HOUSTON_LNG = -95.37;
const dayOf = (ms, lng) => m.localDayInTz(ms, m.usTzForLongitude(lng));

// A Friday-evening run in Houston: 22:00 CDT Fri 2026-08-07 == 03:00 UTC Sat.
// It must bucket to FRIDAY, the day the driver actually worked and the day the
// Sat-Fri billing week already counted.
check("Houston Friday 22:00 buckets to Friday, not Saturday (UTC would say Sat)",
	dayOf(Date.parse("2026-08-08T03:00:00Z"), HOUSTON_LNG), "2026-08-07");
check("the same instant IS Saturday in UTC (the control)",
	new Date("2026-08-08T03:00:00Z").toISOString().slice(0, 10), "2026-08-08");
check("longitude picks the zone: same instant on the west coast",
	dayOf(Date.parse("2026-08-08T03:00:00Z"), -122.4), "2026-08-07");
check("missing longitude falls back to Central, never to the server zone",
	dayOf(Date.parse("2026-08-08T03:00:00Z"), null), "2026-08-07");

// Split a run that straddles the 2026-08-12 23:17Z handover.
const samples = [];
let odo = 700000;
for (let i = 0; i < 10; i++) samples.push({ ms: Date.parse("2026-08-12T22:00:00Z") + i * 60000, odo: odo + i, lng: HOUSTON_LNG });
odo += 10;
for (let i = 0; i < 10; i++) samples.push({ ms: Date.parse("2026-08-12T23:30:00Z") + i * 60000, odo: odo + i, lng: HOUSTON_LNG });

const buckets = m.splitDeltasByDayAndDriver(samples, {
	dayOf,
	driverAt: (ms) => R.atInstant(11, ms),
});
const list = [...buckets.values()].map(b => ({ day: b.localDay, driver: b.driverName, miles: b.miles }))
	.sort((a, b) => (a.driver > b.driver ? 1 : -1));
check("a mid-day handover splits into two driver rows on the SAME day",
	list, [
		{ day: "2026-08-12", driver: "Jayden Morrison", miles: 9 },
		{ day: "2026-08-12", driver: "Shorn King", miles: 10 },
	]);
check("both halves land on the same truck-local day",
	new Set(list.map(x => x.day)).size, 1);
// The sum over drivers must equal the truck's own total — no miles invented,
// none lost at the seam.
const truckTotal = m.sumOdoDeltas(samples).miles;
check("driver rows sum to the truck total exactly",
	Math.round(list.reduce((a, x) => a + x.miles, 0) * 10) / 10, truckTotal);

// --- 7. an unattributed stretch is kept for the TRUCK, excluded from drivers --
const orphan = m.splitDeltasByDayAndDriver(
	[
		{ ms: Date.parse("2026-01-05T12:00:00Z"), odo: 500000, lng: HOUSTON_LNG },
		{ ms: Date.parse("2026-01-05T12:30:00Z"), odo: 500020, lng: HOUSTON_LNG },
	],
	{ dayOf, driverAt: (ms) => R.atInstant(11, ms) }   // no assignment covers Jan
);
const o = [...orphan.values()][0];
check("miles with no assignment are still counted", o.miles, 20);
check("...but carry the empty driver sentinel, not a guessed name", o.driverKey, "");
check("...and the sentinel is '' — never null, which UNIQUE treats as distinct",
	o.driverKey === null, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
