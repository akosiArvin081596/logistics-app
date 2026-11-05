"use strict";

// Daily ELD activity (driving, engine-on and idle minutes, speeding episodes) per
// device, truck-local day, business week and driver, estimated from the GPS pings
// and stored because the 90-day telemetry purge deletes them. Nothing reads it yet.

const appTime = require("./app-time");
const eldMiles = require("./eld-miles");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MPH_TO_MPS = 0.44704;

// The driver performance plan's hours estimate. 2.235 m/s is the travel-day speed
// pay uses; the engine tolerances are the time-off check's reading-break ones.
const ELD_ACTIVITY_RULE = Object.freeze({
	maxStepMs: 5 * MINUTE_MS,
	movingMps: 2.235,
	shortStopMs: 5 * MINUTE_MS,
	speedingMps: 75 * MPH_TO_MPS,
	speedingHoldMs: 60 * 1000,
	engineDownToleranceHours: 0.1,
	engineUpToleranceHours: 0.5,
});

const BASIS_ESTIMATE = "gps-estimate";
const BASIS_NO_HOURS = "no-hours-data";

// The measures are NULL when unmeasured, never 0: a 0 would read as a truck that
// stood still. driver_id 0 is "no driver", never NULL, so the UNIQUE key holds.
const ELD_ACTIVITY_SCHEMA_SQL = [
	`CREATE TABLE IF NOT EXISTS eld_activity_daily (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		routemate_vehicle_id TEXT NOT NULL,
		truck_id INTEGER NOT NULL DEFAULT 0,
		local_day TEXT NOT NULL,
		week_start TEXT NOT NULL,
		driver_id INTEGER NOT NULL DEFAULT 0,
		samples INTEGER NOT NULL DEFAULT 0,
		observed_min REAL NOT NULL DEFAULT 0,
		coverage REAL NOT NULL DEFAULT 0,
		driving_min REAL,
		engine_on_min REAL,
		idle_min REAL,
		speeding_episodes INTEGER,
		basis TEXT NOT NULL DEFAULT 'no-hours-data',
		first_ms INTEGER NOT NULL DEFAULT 0,
		last_ms INTEGER NOT NULL DEFAULT 0,
		computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE (routemate_vehicle_id, local_day, week_start, driver_id)
	)`,
	"CREATE INDEX IF NOT EXISTS idx_eld_activity_driver_week ON eld_activity_daily(driver_id, week_start)",
	"CREATE INDEX IF NOT EXISTS idx_eld_activity_truck_day ON eld_activity_daily(truck_id, local_day)",
	"CREATE INDEX IF NOT EXISTS idx_eld_activity_week ON eld_activity_daily(week_start)",
];

const ELD_ACTIVITY_BACKFILL_KEY = "eld_activity_daily_backfill_v1";
const ELD_ACTIVITY_LAST_RUN_KEY = "eld_activity_daily_last_run";
// The first run's backfill, and the furthest a catch-up goes back: 90 days, what the
// purge always leaves, so the rollup never reads the few older days it may still hold.
const ELD_ACTIVITY_MAX_DAYS = 90;
// The still-forming day plus enough overlap for a late push to be re-derived.
const ELD_ACTIVITY_MIN_DAYS = 3;
// The business week turns at a local midnight, and every zone's offset is a
// multiple of 15 minutes, so one week lookup per quarter hour is exact.
const WEEK_SLOT_MS = 15 * MINUTE_MS;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

// Only a RouteMate reading carries engine hours; a Linxup row's 0 is "not sent".
const engineReading = (p) => p.eh > 0 && p.source !== "linxup";

// One ping per instant, in time order. A duplicate keeps the larger speed and
// engine-hours reading, as the SQL GROUP BY does.
function normalizePings(raw) {
	const byMs = new Map();
	for (const r of raw || []) {
		const ms = Number(r && r.ms);
		if (!Number.isFinite(ms)) continue;
		const lng = r.lng === null || r.lng === undefined || r.lng === "" ? NaN : Number(r.lng);
		const ping = { ms, speed: num(r.speed), eh: num(r.eh), lng, source: String(r.source || "") };
		const prev = byMs.get(ms);
		if (!prev) { byMs.set(ms, ping); continue; }
		prev.speed = Math.max(prev.speed, ping.speed);
		prev.eh = Math.max(prev.eh, ping.eh);
		if (!Number.isFinite(prev.lng)) prev.lng = ping.lng;
		if (!prev.source) prev.source = ping.source;
	}
	return [...byMs.values()].sort((a, b) => a.ms - b.ms);
}

// Each step (ping i-1 to ping i) as "gap", "drive", "stop" or "long-stop". A stop
// under 5 minutes with driving on both sides is driving, as an ELD counts it.
function classifySteps(pings) {
	const R = ELD_ACTIVITY_RULE;
	const steps = [];
	for (let i = 1; i < pings.length; i++) {
		const dt = pings[i].ms - pings[i - 1].ms;
		const observed = dt > 0 && dt <= R.maxStepMs;
		steps.push({ i, dt, observed, kind: !observed ? "gap" : pings[i].speed > R.movingMps ? "drive" : "stop" });
	}
	for (let a = 0; a < steps.length;) {
		if (steps[a].kind !== "stop") { a++; continue; }
		let b = a;
		let ms = 0;
		while (b < steps.length && steps[b].kind === "stop") { ms += steps[b].dt; b++; }
		const inside = a > 0 && steps[a - 1].kind === "drive" && b < steps.length && steps[b].kind === "drive";
		const kind = inside && ms < R.shortStopMs ? "drive" : ms >= R.shortStopMs ? "long-stop" : "stop";
		for (let k = a; k < b; k++) steps[k].kind = kind;
		a = b;
	}
	return steps;
}

// Minutes in a calendar day of `zone` (1380 or 1500 on a daylight-saving change).
const dayLengthCache = new Map();
function dayLengthMs(day, zone) {
	const key = `${zone}|${day}`;
	if (dayLengthCache.has(key)) return dayLengthCache.get(key);
	const [y, m, d] = String(day).split("-").map(Number);
	const next = new Date(Date.UTC(y, m - 1, d + 1));
	const len = appTime.wallClockToMs(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0)
		- appTime.wallClockToMs(zone, y, m, d, 0, 0, 0);
	const out = Number.isFinite(len) && len > 0 ? len : DAY_MS;
	dayLengthCache.set(key, out);
	return out;
}

// One device's pings { ms, speed (m/s), eh, lng, source } -> a row per truck-local day,
// business week (opts.weekOf(ms), its Saturday) and driver (opts.driverAt(ms), a
// drivers_directory id, 0 for none), so a handover or the Friday week line splits exactly.
function activityRows(rawPings, opts) {
	const R = ELD_ACTIVITY_RULE;
	const weekOf = (opts && opts.weekOf) || (() => "");
	const driverAt = (opts && opts.driverAt) || (() => 0);
	const pings = normalizePings(rawPings);
	const buckets = new Map();
	const bucketOf = pings.map((p) => {
		const zone = eldMiles.usTzForLongitude(p.lng);
		const localDay = eldMiles.localDayInTz(p.ms, zone);
		const weekStart = String(weekOf(p.ms) || "");
		const id = Number(driverAt(p.ms));
		const driverId = Number.isInteger(id) && id > 0 ? id : 0;
		const key = `${localDay}|${weekStart}|${driverId}`;
		let b = buckets.get(key);
		if (!b) {
			b = {
				localDay, weekStart, driverId, zone, samples: 0, engineReadings: 0,
				observedMs: 0, drivingMs: 0, engineMs: 0, idleMs: 0, engineMeasured: false,
				speeding: 0, firstMs: p.ms, lastMs: p.ms,
			};
			buckets.set(key, b);
		}
		b.samples += 1;
		if (engineReading(p)) b.engineReadings += 1;
		if (p.ms < b.firstMs) b.firstMs = p.ms;
		if (p.ms > b.lastMs) b.lastMs = p.ms;
		return b;
	});

	// Each step lands in its later ping's bucket, as the miles walk does.
	const steps = classifySteps(pings);
	for (const s of steps) {
		if (!s.observed) continue;
		const b = bucketOf[s.i];
		b.observedMs += s.dt;
		if (s.kind === "drive") b.drivingMs += s.dt;
	}

	// Engine-on is the engine-hours rise over an unbroken stretch, capped by how long
	// the stretch lasted, so a coarse or jittery meter can't add time that wasn't there.
	let seg = null;
	const closeSegment = () => {
		if (!seg) return;
		const credited = Math.min(Math.max(0, seg.ehEnd - seg.ehStart) * HOUR_MS, seg.ms);
		seg.bucket.engineMs += credited;
		if (seg.longStop) seg.bucket.idleMs += credited;
		seg = null;
	};
	for (const s of steps) {
		const prev = pings[s.i - 1];
		const cur = pings[s.i];
		const rise = cur.eh - prev.eh;
		const usable = s.observed && engineReading(prev) && engineReading(cur)
			&& rise >= -R.engineDownToleranceHours && rise <= s.dt / HOUR_MS + R.engineUpToleranceHours;
		if (!usable) { closeSegment(); continue; }
		const b = bucketOf[s.i];
		const longStop = s.kind === "long-stop";
		b.engineMeasured = true;
		if (seg && (seg.bucket !== b || seg.longStop !== longStop)) closeSegment();
		if (!seg) seg = { bucket: b, longStop, ehStart: prev.eh, ehEnd: cur.eh, ms: 0 };
		seg.ehEnd = cur.eh;
		seg.ms += s.dt;
	}
	closeSegment();

	// An episode is consecutive pings at or above the speed with no gap, held for
	// the minimum time; it counts once, on the bucket of its first ping.
	let run = null;
	const closeRun = () => {
		if (run && run.lastMs - run.firstMs >= R.speedingHoldMs) run.bucket.speeding += 1;
		run = null;
	};
	for (let i = 0; i < pings.length; i++) {
		const fast = pings[i].speed >= R.speedingMps;
		if (run && fast && pings[i].ms - pings[i - 1].ms <= R.maxStepMs) { run.lastMs = pings[i].ms; continue; }
		closeRun();
		if (fast) run = { bucket: bucketOf[i], firstMs: pings[i].ms, lastMs: pings[i].ms };
	}
	closeRun();

	const rows = [];
	for (const b of buckets.values()) {
		const hoursData = b.engineReadings > 0;
		const observed = hoursData && b.observedMs > 0;
		rows.push({
			local_day: b.localDay,
			week_start: b.weekStart,
			driver_id: b.driverId,
			samples: b.samples,
			observed_min: round(b.observedMs / MINUTE_MS, 2),
			coverage: round(Math.min(1, b.observedMs / dayLengthMs(b.localDay, b.zone)), 4),
			driving_min: observed ? round(b.drivingMs / MINUTE_MS, 2) : null,
			engine_on_min: hoursData && b.engineMeasured ? round(b.engineMs / MINUTE_MS, 2) : null,
			idle_min: hoursData && b.engineMeasured ? round(b.idleMs / MINUTE_MS, 2) : null,
			speeding_episodes: observed ? b.speeding : null,
			basis: hoursData ? BASIS_ESTIMATE : BASIS_NO_HOURS,
			first_ms: b.firstMs,
			last_ms: b.lastMs,
		});
	}
	rows.sort((x, y) => (x.local_day < y.local_day ? -1 : x.local_day > y.local_day ? 1 : 0)
		|| (x.week_start < y.week_start ? -1 : x.week_start > y.week_start ? 1 : 0)
		|| x.driver_id - y.driver_id);
	return rows;
}

function ensureEldActivitySchema(db) {
	for (const sql of ELD_ACTIVITY_SCHEMA_SQL) db.exec(sql);
}

// server.js injects its own answers (device -> truck, truck -> driver, the business
// week, name -> drivers_directory id, the purge boundary), so no rule is copied here.
// run() never rejects and never runs twice at once.
function createEldActivityRollup(deps) {
	const { db, deviceResolver, driverResolver, weekStartOf, driverIdFor, boundaryMs } = deps;
	const log = deps.log || console;
	ensureEldActivitySchema(db);
	let running = false;

	async function rollupRange(fromMs, toMs, nowMs) {
		const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
		const dayOf = (ms, lng) => eldMiles.localDayInTz(ms, eldMiles.usTzForLongitude(lng === null ? NaN : lng));
		const devices = deviceResolver();
		const vids = [...devices.vehiclesBetween(fromMs - DAY_MS, toMs)].sort();
		const holders = driverResolver(db.prepare("SELECT id FROM trucks").all().map((t) => t.id));
		const selectRange = db.prepare(`
			SELECT location_date_ms AS ms, MAX(speed) AS speed, MAX(engine_hours) AS eh,
			       MAX(longitude) AS lng, MAX(source) AS source
			FROM routemate_telemetry
			WHERE routemate_vehicle_id = ?
			  AND location_date_ms >= ? AND location_date_ms < ?
			  AND dropped_reason = ''
			GROUP BY location_date_ms ORDER BY ms ASC
		`);
		const selectOldest = db.prepare(`
			SELECT location_date_ms AS ms, longitude AS lng FROM routemate_telemetry
			WHERE routemate_vehicle_id = ? AND dropped_reason = ''
			ORDER BY location_date_ms ASC LIMIT 1
		`);
		const storedSamples = db.prepare(
			"SELECT COALESCE(SUM(samples), 0) AS n FROM eld_activity_daily WHERE routemate_vehicle_id = ? AND local_day = ?"
		);
		const deleteDay = db.prepare("DELETE FROM eld_activity_daily WHERE routemate_vehicle_id = ? AND local_day = ?");
		const insert = db.prepare(`
			INSERT INTO eld_activity_daily
				(routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, observed_min, coverage,
				 driving_min, engine_on_min, idle_min, speeding_episodes, basis, first_ms, last_ms, computed_at)
			VALUES (@vid, @truck_id, @local_day, @week_start, @driver_id, @samples, @observed_min, @coverage,
				 @driving_min, @engine_on_min, @idle_min, @speeding_episodes, @basis, @first_ms, @last_ms, CURRENT_TIMESTAMP)
		`);

		const idByName = new Map();
		const idFor = (name) => {
			const key = String(name || "").trim();
			if (!key) return 0;
			if (!idByName.has(key)) {
				const id = Number(driverIdFor(key));
				idByName.set(key, Number.isInteger(id) && id > 0 ? id : 0);
			}
			return idByName.get(key);
		};
		const weekBySlot = new Map();
		const weekOf = (ms) => {
			const slot = Math.floor(ms / WEEK_SLOT_MS);
			if (!weekBySlot.has(slot)) weekBySlot.set(slot, String(weekStartOf(slot * WEEK_SLOT_MS) || ""));
			return weekBySlot.get(slot);
		};

		const fromDay = isoDay(fromMs);
		const toDay = isoDay(toMs);
		const deviceDays = new Set();
		let rowsWritten = 0;
		let daysKept = 0;
		for (const vid of vids) {
			const oldest = selectOldest.get(vid);
			if (!oldest) continue;
			// The purge-boundary day is already partly deleted: a first row for it would
			// be an undercount nothing could correct later.
			const boundaryDay = oldest.ms < nowMs - boundaryMs ? dayOf(oldest.ms, oldest.lng) : "";
			const driverAt = (ms) => {
				const truckId = devices.truckForVehicleAt(vid, ms);
				return truckId ? idFor(holders.atInstant(truckId, ms)) : 0;
			};
			// 7-day chunks with a day of lead-in each side, so a stop or a speeding run
			// across midnight is judged whole; only the chunk's own days are written.
			for (let chunk = Date.parse(`${fromDay}T00:00:00Z`); isoDay(chunk) <= toDay; chunk += 7 * DAY_MS) {
				const keepFrom = isoDay(chunk) < fromDay ? fromDay : isoDay(chunk);
				const keepTo = isoDay(chunk + 6 * DAY_MS) > toDay ? toDay : isoDay(chunk + 6 * DAY_MS);
				const pings = selectRange.all(vid, chunk - DAY_MS, chunk + 8 * DAY_MS);
				if (pings.length) {
					const byDay = new Map();
					for (const r of activityRows(pings, { weekOf, driverAt })) {
						if (r.local_day < keepFrom || r.local_day > keepTo) continue;
						if (boundaryDay && r.local_day <= boundaryDay) continue;
						if (!byDay.has(r.local_day)) byDay.set(r.local_day, []);
						byDay.get(r.local_day).push(r);
					}
					db.transaction(() => {
						for (const [day, rows] of byDay) {
							const truckId = devices.truckForVehicleOnDay(vid, day);
							if (!truckId) continue;
							// A day is replaced whole, or kept whole when this read sees fewer pings
							// than the stored rows did (a partly purged window).
							const fresh = rows.reduce((n, r) => n + r.samples, 0);
							if (fresh < storedSamples.get(vid, day).n) { daysKept += 1; continue; }
							deleteDay.run(vid, day);
							for (const r of rows) insert.run({ ...r, vid, truck_id: truckId });
							rowsWritten += rows.length;
							deviceDays.add(`${vid}|${day}`);
						}
					})();
				}
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		const days = [...deviceDays].map((k) => k.split("|")[1]).sort();
		return { rows: rowsWritten, deviceDays: deviceDays.size, daysKept, firstDay: days[0] || "", lastDay: days[days.length - 1] || "" };
	}

	async function run(nowArg) {
		if (running) return { skipped: "busy" };
		running = true;
		try {
			const getState = (key) => {
				const row = db.prepare("SELECT value FROM server_state WHERE key = ?").get(key);
				if (!row) return null;
				try { return JSON.parse(row.value); } catch { return {}; }
			};
			const setState = (key, value) =>
				db.prepare("INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
					.run(key, JSON.stringify(value));
			const nowMs = Number.isFinite(nowArg) ? nowArg : Date.now();
			const backfilled = getState(ELD_ACTIVITY_BACKFILL_KEY);
			const last = getState(ELD_ACTIVITY_LAST_RUN_KEY);
			let daysBack = ELD_ACTIVITY_MAX_DAYS;
			if (backfilled && last && Number.isFinite(last.atMs)) {
				const sinceLast = Math.ceil((nowMs - last.atMs) / DAY_MS) + 1;
				daysBack = Math.min(ELD_ACTIVITY_MAX_DAYS, Math.max(ELD_ACTIVITY_MIN_DAYS, sinceLast));
			}
			const result = await rollupRange(nowMs - daysBack * DAY_MS, nowMs + DAY_MS, nowMs);
			setState(ELD_ACTIVITY_LAST_RUN_KEY, { at: new Date(nowMs).toISOString(), atMs: nowMs, daysBack, ...result });
			if (!backfilled) {
				setState(ELD_ACTIVITY_BACKFILL_KEY, { at: new Date(nowMs).toISOString(), ...result });
				log.log(`[eld-activity] backfill: ${result.deviceDays} device-days, ${result.firstDay}..${result.lastDay}`);
			}
			return { daysBack, ...result };
		} catch (err) {
			log.error("[eld-activity] daily rollup failed:", err.message);
			return { error: err.message };
		} finally {
			running = false;
		}
	}

	return { run, rollupRange };
}

module.exports = {
	ELD_ACTIVITY_RULE,
	ELD_ACTIVITY_SCHEMA_SQL,
	ELD_ACTIVITY_BACKFILL_KEY,
	ELD_ACTIVITY_LAST_RUN_KEY,
	ELD_ACTIVITY_MAX_DAYS,
	ELD_ACTIVITY_MIN_DAYS,
	BASIS_ESTIMATE,
	BASIS_NO_HOURS,
	classifySteps,
	activityRows,
	ensureEldActivitySchema,
	createEldActivityRollup,
};
