#!/usr/bin/env node
// Recompute routemate_fuel_daily.miles with the corrected sum-of-positive-deltas
// algorithm, over the days telemetry still covers.
//
// WHY. rollupOneDay() used to compute miles as MAX(odometer) - MIN(odometer).
// On 2026-08-11 LogisX-#2372's ELD reset and its odometer fell 219,818 miles in
// 0.17 h; the span billed that reset as DISTANCE. The resulting 219,818-mile DAY
// is still in production, and it alone makes that truck's all-time total read
// 244,562 miles instead of ~24,744 — on Fleet Health and on the INVESTOR
// MyTrucks panel. The rolling 7-day rollup will never reach back and fix it.
//
// ⚠️ WHY THIS IS CHUNKED AND YIELDS. better-sqlite3 is SYNCHRONOUS: there is no
// yielding inside a .all(). routemate_telemetry is ~1,000,000 rows, and a single
// scan of it blocks the event loop for seconds. This repo has already paid for
// that lesson once — see the fuel_events boot catch-up note in server.js, which
// records ~900 ms of fully blocked event loop on 125k samples and an
// "unconditional 95-day scan [that] froze every HTTP request and every Socket.IO
// frame for about a second on each deploy". So this walks ONE vehicle-day at a
// time (a few thousand rows, served by the vehicle+date index) and hands the
// loop back between each. Wall time goes up; p99 latency does not move.
//
// ⚠️ RUN IT OFF-PEAK ANYWAY. The production VPS is shared with ~23 other
// clients' pm2 processes. Nothing here writes outside this one table, but the
// read pressure is real.
//
// ⚠️ NEVER AT BOOT. The boot path runs only the rolling window. This is a
// deliberate, human-initiated, one-shot correction.
//
// DRY RUN IS THE DEFAULT. Nothing is written without --apply.
//
//   node scripts/backfill-eld-miles.js                    # dry run, 95 days
//   node scripts/backfill-eld-miles.js --days=30          # dry run, narrower
//   node scripts/backfill-eld-miles.js --apply            # write
//   node scripts/backfill-eld-miles.js --db=/path/app.db  # target a copy

const path = require("path");
const Database = require("better-sqlite3");
const eldMiles = require("../lib/eld-miles");

const args = process.argv.slice(2);
const has = (f) => args.some((a) => a === f || a.startsWith(f + "="));
const val = (f, d) => {
	const hit = args.find((a) => a.startsWith(f + "="));
	return hit ? hit.slice(f.length + 1) : d;
};

const APPLY = has("--apply");
const DB_PATH = path.resolve(val("--db", path.join(__dirname, "..", "app.db")));

// ⚠️ CLAMPED AT 95 AND THAT IS A HARD ERROR, NOT A SILENT MIN().
// purgeOldRoutemateTelemetry() deletes telemetry older than 90 days. Beyond
// that horizon there are no pings to recompute FROM, so a wider window cannot
// produce a better number — it can only overwrite a complete historical figure
// with a partial one derived from whatever survived. 95 gives a few days of
// margin to catch the oldest surviving rows in full and stops there.
const MAX_DAYS = 95;
const rawDays = parseInt(val("--days", "95"), 10);
if (!Number.isFinite(rawDays) || rawDays < 1) {
	console.error("--days must be a positive integer");
	process.exit(1);
}
if (rawDays > MAX_DAYS) {
	console.error(`--days=${rawDays} exceeds the ${MAX_DAYS}-day telemetry retention horizon.`);
	console.error("Beyond it there is no telemetry to recompute from, so a wider window can only");
	console.error("overwrite good historical numbers with partial ones. Refusing.");
	process.exit(1);
}
const DAYS = rawDays;

const db = new Database(DB_PATH);
try { db.exec(`ALTER TABLE routemate_fuel_daily ADD COLUMN miles_basis TEXT DEFAULT ''`); } catch {}
// Idempotent, and identical to the DDL in server.js. Present so this script can
// run against a database whose server has not booted the new schema yet.
db.exec(`
	CREATE TABLE IF NOT EXISTS eld_miles_daily (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		routemate_vehicle_id TEXT NOT NULL,
		local_day TEXT NOT NULL,
		driver_key TEXT NOT NULL DEFAULT '',
		driver_name TEXT NOT NULL DEFAULT '',
		truck_id INTEGER DEFAULT 0,
		miles REAL DEFAULT 0,
		dropped_miles REAL DEFAULT 0,
		samples INTEGER DEFAULT 0,
		rejected_deltas INTEGER DEFAULT 0,
		max_gap_ms INTEGER DEFAULT 0,
		basis TEXT DEFAULT 'eld',
		first_ms INTEGER DEFAULT 0,
		last_ms INTEGER DEFAULT 0,
		computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE (routemate_vehicle_id, local_day, driver_key)
	)
`);

const selectDay = db.prepare(`
	SELECT location_date_ms AS ms, MAX(odometer) AS odo
	FROM routemate_telemetry
	WHERE routemate_vehicle_id = ?
	  AND location_date_ms >= ? AND location_date_ms < ?
	  AND dropped_reason = ''
	  AND odometer > 0
	GROUP BY location_date_ms
	ORDER BY ms ASC
`);
const selectStored = db.prepare(
	`SELECT miles, miles_basis FROM routemate_fuel_daily WHERE routemate_vehicle_id = ? AND date = ?`
);
const updateMiles = db.prepare(
	`UPDATE routemate_fuel_daily SET miles = ?, miles_basis = 'odo_delta' WHERE routemate_vehicle_id = ? AND date = ?`
);

const vehicles = db
	.prepare(`SELECT DISTINCT routemate_vehicle_id AS vid FROM routemate_fuel_daily WHERE COALESCE(routemate_vehicle_id,'') <> ''`)
	.all()
	.map((r) => r.vid);

const nowUtc = new Date();
const dayKeys = [];
for (let d = 0; d < DAYS; d++) {
	const day = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() - d));
	dayKeys.push({ date: day.toISOString().slice(0, 10), startMs: day.getTime() });
}

console.log(`db        ${DB_PATH}`);
console.log(`mode      ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
console.log(`window    ${DAYS} days · ${dayKeys[dayKeys.length - 1].date} → ${dayKeys[0].date}`);
console.log(`vehicles  ${vehicles.length}`);
console.log("");

(async () => {
	const movers = [];
	let examined = 0, changed = 0, skippedNoTelemetry = 0, unchanged = 0;

	for (const vid of vehicles) {
		for (const { date, startMs } of dayKeys) {
			const stored = selectStored.get(vid, date);
			if (!stored) continue;            // only correct rows that exist
			examined += 1;

			const rows = selectDay.all(vid, startMs, startMs + 86400000);
			// No surviving telemetry for this day — it is past the purge horizon.
			// LEAVE THE STORED VALUE ALONE. Recomputing to 0 here would destroy a
			// complete historical figure, which is worse than an imperfect one.
			if (rows.length < 2) { skippedNoTelemetry += 1; continue; }

			const walk = eldMiles.sumOdoDeltas(rows);
			const before = Number(stored.miles) || 0;
			const after = walk.miles;
			const delta = after - before;

			if (Math.abs(delta) < 0.05) { unchanged += 1; }
			else {
				changed += 1;
				if (Math.abs(delta) > 100) movers.push({ vid, date, before, after, delta, walk });
			}
			if (APPLY) updateMiles.run(after, vid, date);

			// Hand the event loop back between vehicle-days.
			await new Promise((r) => setImmediate(r));
		}
	}

	console.log(`examined  ${examined} stored day(s)`);
	console.log(`unchanged ${unchanged}`);
	console.log(`changed   ${changed}`);
	console.log(`skipped   ${skippedNoTelemetry} (no surviving telemetry — left untouched)`);
	console.log("");

	if (movers.length) {
		console.log(`⚠️  ${movers.length} row(s) move by more than 100 miles — review before --apply:`);
		movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
		for (const m of movers) {
			const reasons = Object.keys(m.walk.reasons).length ? ` reasons=${JSON.stringify(m.walk.reasons)}` : "";
			console.log(
				`   ${m.vid.padEnd(24)} ${m.date}  ${String(m.before).padStart(10)} → ${String(m.after).padStart(9)}` +
				`  (${m.delta > 0 ? "+" : ""}${Math.round(m.delta)})  dropped=${m.walk.droppedMiles}${reasons}`
			);
		}
		console.log("");
	} else {
		console.log("No row moves by more than 100 miles.");
		console.log("");
	}

	// -----------------------------------------------------------------------
	// PHASE 2 — eld_miles_daily, the analytics rollup.
	//
	// The live rollup only walks 3 days back, so without this the /analytics
	// page has no history to show. Same chunking discipline: one vehicle-day at
	// a time, yielding between each.
	// -----------------------------------------------------------------------
	console.log("");
	console.log("--- phase 2: eld_miles_daily ---");

	const fleet = db.prepare(
		`SELECT id, unit_number, routemate_vehicle_id FROM trucks
		 WHERE COALESCE(routemate_vehicle_id,'') <> ''`
	).all();
	const assignments = db.prepare(
		`SELECT truck_id, driver_name, start_date, end_date FROM truck_assignments`
	).all();
	const resolver = eldMiles.buildDriverAtResolver(assignments);
	if (resolver.unresolvedRows) {
		console.log(`⚠️  ${resolver.unresolvedRows} truck_assignments row(s) have an unparseable date and were skipped.`);
	}

	const upsertDay = db.prepare(`
		INSERT INTO eld_miles_daily
			(routemate_vehicle_id, local_day, driver_key, driver_name, truck_id,
			 miles, dropped_miles, samples, rejected_deltas, max_gap_ms, basis,
			 first_ms, last_ms, computed_at)
		VALUES (@vid, @local_day, @driver_key, @driver_name, @truck_id,
			 @miles, @dropped_miles, @samples, @rejected_deltas, @max_gap_ms, @basis,
			 @first_ms, @last_ms, CURRENT_TIMESTAMP)
		ON CONFLICT(routemate_vehicle_id, local_day, driver_key) DO UPDATE SET
			driver_name = excluded.driver_name, truck_id = excluded.truck_id,
			miles = excluded.miles, dropped_miles = excluded.dropped_miles,
			samples = excluded.samples, rejected_deltas = excluded.rejected_deltas,
			max_gap_ms = excluded.max_gap_ms, basis = excluded.basis,
			first_ms = excluded.first_ms, last_ms = excluded.last_ms,
			computed_at = CURRENT_TIMESTAMP
		WHERE excluded.samples >= eld_miles_daily.samples
	`);

	let dayRows = 0, milesTotal = 0;
	const perTruck = new Map();
	for (const t of fleet) {
		for (const { date: targetDay, startMs } of dayKeys) {
			// One day of lead-in so a delta spanning midnight is judged against
			// its true neighbour rather than against nothing.
			const withLng = db.prepare(`
				SELECT location_date_ms AS ms, MAX(odometer) AS odo, MAX(longitude) AS lng
				FROM routemate_telemetry
				WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms < ?
				  AND dropped_reason = '' AND odometer > 0
				GROUP BY location_date_ms ORDER BY ms ASC
			`).all(t.routemate_vehicle_id, startMs - 86400000, startMs + 2 * 86400000);
			if (withLng.length < 2) { await new Promise((r) => setImmediate(r)); continue; }

			const buckets = eldMiles.splitDeltasByDayAndDriver(withLng, {
				dayOf: (ms, lng) => eldMiles.localDayInTz(ms, eldMiles.usTzForLongitude(lng)),
				driverAt: (ms) => resolver.atInstant(t.id, ms),
			});
			for (const b of buckets.values()) {
				// ⚠️ ONLY WRITE THE TARGET DAY. The window deliberately reaches one
				// day either side so a delta spanning midnight is judged against its
				// real neighbour — but the neighbouring days it also produces are
				// PARTIAL (they are missing their own far half). Writing them would
				// count the same miles up to three times in this run's totals, and
				// would rely on the upsert's sample guard to undo it.
				if (b.localDay !== targetDay) continue;
				if (!b.localDay) continue;
				dayRows += 1;
				milesTotal += b.miles;
				perTruck.set(t.unit_number, (perTruck.get(t.unit_number) || 0) + b.miles);
				if (APPLY) {
					upsertDay.run({
						vid: t.routemate_vehicle_id, local_day: b.localDay,
						driver_key: b.driverKey, driver_name: b.driverName, truck_id: t.id,
						miles: b.miles, dropped_miles: b.droppedMiles, samples: b.samples,
						rejected_deltas: b.rejected, max_gap_ms: b.maxGapMs, basis: b.basis,
						first_ms: b.firstMs, last_ms: b.lastMs,
					});
				}
			}
			await new Promise((r) => setImmediate(r));
		}
	}
	console.log(`trucks    ${fleet.length} ELD-linked`);
	console.log(`day rows  ${dayRows}`);
	console.log(`miles     ${Math.round(milesTotal)} total across the window`);
	for (const [unit, mi] of [...perTruck.entries()].sort()) {
		console.log(`   ${unit.padEnd(16)} ${Math.round(mi)}`);
	}
	console.log("");

	console.log(APPLY ? "APPLIED." : "Dry run only — nothing written. Re-run with --apply to write.");
	db.close();
})().catch((err) => {
	console.error("backfill failed:", err.message);
	db.close();
	process.exit(1);
});
