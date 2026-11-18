"use strict";
// An ELD device link, unlink or re-point counts from its instant forward (ELD_LINK_FORWARD_ONLY_ENABLED with
// ELD_LINK_FORWARD_ONLY_FROM). While the rule is in force (decide()), the pay paths read each instant's ELD through the
// device the truck held then, from the device history (lib/eld-miles.js buildDeviceTruckResolver(), frozenBefore: FROM).
// Before FROM every instant reads the links in force at FROM, which is what the readers read then, so the switch-on moves
// nothing. The window rule decides coverage per run of one device, and reads the days a link changed by instant.

const appTime = require("./app-time");
const eldMiles = require("./eld-miles");
const eldPosition = require("./eld-position");
const loadPayDays = require("./load-pay-days");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// The zones a truck's local day can be in: lib/eld-miles.js usTzForLongitude()'s four bands, one longitude in each.
const US_ZONES = Object.freeze([-80, -90, -105, -120].map((lng) => eldMiles.usTzForLongitude(lng)));
// The window rule's travel test (server.js getEldTravelDaysByVehicle()).
const TRAVEL_MPS = 2.235;
// The server_state key of the FROM recorded at the first start the rule was in force.
const RECORD_KEY = "eld_link_forward_from";
// SQLite bounds for an open-ended run.
const LOW_MS = -8.64e15;
const HIGH_MS = 8.64e15;
const sqlLo = (ms) => (Number.isFinite(ms) ? ms : LOW_MS);
const sqlHi = (ms) => (Number.isFinite(ms) ? ms : HIGH_MS);

// The two settings: the switch (on only when exactly "true") and FROM, an ISO instant in UTC read as APP_TIMEZONE_FROM is.
function settingFromEnv(env) {
	const enabled = !!env && env.ELD_LINK_FORWARD_ONLY_ENABLED === "true";
	const fromText = String((env && env.ELD_LINK_FORWARD_ONLY_FROM) ?? "").trim();
	return { enabled, fromText, fromMs: fromText ? appTime.switchFromMs(fromText) : null };
}

const iso = (ms) => new Date(ms).toISOString();

// Whether the rule is in force in this process, decided once at its start:
//   setting         settingFromEnv()
//   recordedFromMs  the FROM recorded at the first start the rule was in force, or null
//   historyStartMs  when the device history began, or null
//   startMs         when this process started
//   rowsBetween(a, b)  the history rows opened or closed in [a, b): [{ id, truckId, at }]
//   changedAfter(ms)   how many history rows were opened or closed after ms
// Returns { inForce, fromMs, record, lines: [{ level, text }] }: record says to write FROM now.
function decide({ setting, recordedFromMs = null, historyStartMs = null, startMs, rowsBetween, changedAfter }) {
	const lines = [];
	const off = (level, text) => {
		lines.push({ level, text });
		return { inForce: false, fromMs: null, record: false, lines };
	};
	if (!setting || !setting.enabled) {
		const after = recordedFromMs !== null ? changedAfter(recordedFromMs) : 0;
		if (after) {
			return off("warn", `ELD_LINK_FORWARD_ONLY_ENABLED is off, but ${after} ELD link history row${after === 1 ? " was" : "s were"} opened or closed after the recorded FROM ${iso(recordedFromMs)}: `
				+ "today's readers re-read those trucks' past days through today's link, closed months included. Switching off is a rule F step through the two-way report.");
		}
		// Off and never used: nothing to say, as for any switch left off.
		return { inForce: false, fromMs: null, record: false, lines };
	}
	if (recordedFromMs !== null) {
		if (!setting.fromText) lines.push({ level: "error", text: `ELD_LINK_FORWARD_ONLY_FROM is not set; the rule runs on the recorded FROM ${iso(recordedFromMs)}.` });
		else if (setting.fromMs !== recordedFromMs) lines.push({ level: "error", text: `ELD_LINK_FORWARD_ONLY_FROM differs from the recorded FROM ${iso(recordedFromMs)}; it is ignored and the recorded FROM wins.` });
		if (startMs < recordedFromMs) return off("error", `this process started before the recorded FROM ${iso(recordedFromMs)}: today's ELD readers and check (5b) run.`);
		lines.push({ level: "log", text: `in force from ${iso(recordedFromMs)}: a link, unlink or re-point counts from its instant forward.` });
		return { inForce: true, fromMs: recordedFromMs, record: false, lines };
	}
	if (setting.fromMs === null) {
		return off("warn", "ELD_LINK_FORWARD_ONLY_FROM is not an ISO instant in UTC (\"2026-11-20T15:00:00Z\"); the rule stays off: today's ELD readers and check (5b).");
	}
	const fromMs = setting.fromMs;
	if (historyStartMs === null || fromMs < historyStartMs) {
		return off("warn", `ELD_LINK_FORWARD_ONLY_FROM ${iso(fromMs)} is before the ELD device history began (${historyStartMs === null ? "not recorded" : iso(historyStartMs)}); the rule stays off: today's ELD readers and check (5b).`);
	}
	if (startMs < fromMs) {
		return off("warn", `ELD_LINK_FORWARD_ONLY_FROM ${iso(fromMs)} is after this process started: today's ELD readers and check (5b) run until a restart at or after it.`);
	}
	const between = rowsBetween(fromMs, startMs);
	if (between.length) {
		const named = between.slice(0, 5).map((r) => `row ${r.id} (truck ${r.truckId}, ${r.at})`).join(", ");
		return off("warn", `${between.length} ELD link history row${between.length === 1 ? " was" : "s were"} opened or closed between ELD_LINK_FORWARD_ONLY_FROM ${iso(fromMs)} and this start `
			+ `(${named}${between.length > 5 ? ", ..." : ""}): the rule stays off and nothing is recorded. Set a new FROM.`);
	}
	lines.push({ level: "log", text: `in force from ${iso(fromMs)} (recorded now): a link, unlink or re-point counts from its instant forward.` });
	return { inForce: true, fromMs, record: true, lines };
}

// Every local day an instant falls on, in the US zones and the business zone. A link change on any of them makes the day
// one the window rule reads by instant: its day sets are truck-local, and the instant decides each fix.
function localDaysOf(ms) {
	const at = new Date(ms);
	const out = new Set(US_ZONES.map((z) => appTime.dayInZone(at, z)));
	out.add(appTime.businessDayOf(at));
	return out;
}

// The switch day the narrowed stop compares a load's last day with: the earliest of those days.
function earliestLocalDay(ms) {
	return [...localDaysOf(ms)].sort()[0];
}

// One request's link context while the rule is in force (server.js eldPayLink()). `resolver` is
// buildDeviceTruckResolver() with frozenBefore: fromMs.
function createPayLink({ db, resolver, fromMs }) {
	const stmts = {};
	const prep = (name, sql) => stmts[name] || (stmts[name] = db.prepare(sql));
	const clean = "routemate_vehicle_id = ? AND dropped_reason = ''";
	const runsMemo = new Map();
	const runsOf = (truckId, aMs, bMs) => {
		const key = `${truckId}|${aMs}|${bMs}`;
		if (!runsMemo.has(key)) runsMemo.set(key, resolver.truckRuns(truckId, aMs, bMs));
		return runsMemo.get(key);
	};
	const seen = { trucks: new Set(), devices: new Set(), multiRunLoads: 0, changeDays: new Set() };
	// One telemetry read per truck and change day, whatever the number of loads covering it.
	const changeDayFixes = new Map();

	// The fixes of the devices truck `truckId` held, each only while it was on the truck, in [aMs, bMs).
	const fixesOnTruck = (truckId, aMs, bMs, cols, order = "") => {
		const out = [];
		for (const r of runsOf(truckId, aMs, bMs)) {
			if (!r.vid) continue;
			const lo = Math.max(r.fromMs, aMs);
			const hi = Math.min(r.toMs, bMs);
			if (!(hi > lo)) continue;
			for (const p of prep(`fix:${cols}:${order}`, `SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND location_date_ms >= ? AND location_date_ms < ?${order}`).all(r.vid, sqlLo(lo), sqlHi(hi))) {
				out.push({ ...p, vid: r.vid, run: r });
			}
		}
		return out;
	};

	const trucks = new Map();
	// What the trip rule (lib/trip-work-days.js) and the pre-dispatch filter (lib/load-pay-days.js) read for one truck.
	function truck(truckId) {
		const id = Number(truckId);
		if (!Number.isFinite(id)) return null;
		if (trucks.has(id)) return trucks.get(id);
		seen.trucks.add(id);
		const changeDayMemo = new Map();
		const ctx = {
			key: `t${id}`,
			id,
			runs: (aMs, bMs) => runsOf(id, aMs, bMs),
			// The trip rule's fixes, sorted: before FROM, a person-made link's fixes from before its link time are left out,
			// as the trip rule left them out at FROM; from FROM on, a fix counts only inside its own history row.
			fixes(aMs, bMs) {
				const out = [];
				for (const p of fixesOnTruck(id, aMs, bMs, "location_date_ms AS ms, latitude AS lat, longitude AS lng, speed", " ORDER BY location_date_ms")) {
					const since = p.run.row ? eldPosition.linkedSinceMs({ assigned_from: p.run.row.from, assigned_by: p.run.row.by }) : null;
					const ms = Number(p.ms);
					if (Number.isFinite(ms) && (since === null || ms >= since)) out.push({ ms: p.ms, lat: p.lat, lng: p.lng, speed: p.speed });
				}
				return out.sort((x, y) => x.ms - y.ms);
			},
			// The pre-dispatch filter's readings for [startMs, endMs), and the truck's last reading before it and first after
			// it, from whichever device it held then.
			readings(startMs, endMs) {
				const cols = "location_date_ms AS ms, latitude AS lat, longitude AS lng, odometer AS odo";
				const pings = fixesOnTruck(id, startMs, endMs, cols).map((p) => ({ ms: p.ms, lat: p.lat, lng: p.lng, odo: p.odo }));
				const reading = "odometer > 0 AND longitude IS NOT NULL";
				let before = null;
				for (const r of [...runsOf(id, -Infinity, startMs)].reverse()) {
					if (!r.vid) continue;
					before = prep("before", `SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND ${reading} AND location_date_ms >= ? AND location_date_ms < ? ORDER BY location_date_ms DESC LIMIT 1`)
						.get(r.vid, sqlLo(r.fromMs), sqlHi(Math.min(r.toMs, startMs))) || null;
					if (before) break;
				}
				let after = null;
				for (const r of runsOf(id, endMs, Infinity)) {
					if (!r.vid) continue;
					after = prep("after", `SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND ${reading} AND location_date_ms >= ? AND location_date_ms < ? ORDER BY location_date_ms ASC LIMIT 1`)
						.get(r.vid, sqlLo(Math.max(r.fromMs, endMs)), sqlHi(r.toMs)) || null;
					if (after) break;
				}
				return { pings, before, after };
			},
			// Whether the truck's link changed on this local day, in any US zone.
			changeDay(day) {
				if (!changeDayMemo.has(day)) {
					const lo = Date.parse(`${day}T00:00:00Z`);
					const runs = runsOf(id, lo, lo + 36 * HOUR_MS);
					changeDayMemo.set(day, runs.slice(1).some((r) => localDaysOf(r.fromMs).has(day)));
				}
				return changeDayMemo.get(day);
			},
		};
		trucks.set(id, ctx);
		return ctx;
	}

	// The devices the trucks held in [aMs, bMs): the travel-day sets the readers fetch.
	function devices(truckIds, aMs, bMs) {
		const out = new Set();
		for (const id of truckIds || []) for (const r of runsOf(Number(id), aMs, bMs)) if (r.vid) out.add(r.vid);
		for (const v of out) seen.devices.add(v);
		return [...out].sort();
	}

	// The window rule's days for a load on truck `truckId` (lib/load-pay-days.js payDaysForLoad(), run by run). `windowDays`
	// are the path's window days in order; `load` is { loadId, settleMonth, windowStart, windowEnd } (the whole window's
	// ends; they default to windowDays' ends). With one device over the window this is payDaysForLoad()'s own call.
	function windowPaidDays({ windowDays, truckId, eldByVid, load, preDispatch = null }) {
		const id = Number(truckId);
		const days = windowDays || [];
		if (truckId === null || truckId === undefined || !Number.isFinite(id) || !days.length) return loadPayDays.payDaysForLoad(days, null, { ...load, vid: null }, preDispatch);
		const ctx = truck(id);
		const spanLo = Date.parse(`${days[0]}T00:00:00Z`);
		const runs = runsOf(id, spanLo, Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 36 * HOUR_MS);
		const whole = { windowStart: (load && load.windowStart) || days[0], windowEnd: (load && load.windowEnd) || days[days.length - 1] };
		const loadOf = (run) => ({ ...load, ...whole, vid: run.vid || null, truck: ctx });
		if (runs.length <= 1) {
			const run = runs[0] || { vid: "" };
			return loadPayDays.payDaysForLoad(days, run.vid ? eldByVid[run.vid] || null : null, { ...loadOf(run), windowStart: load && load.windowStart, windowEnd: load && load.windowEnd }, preDispatch);
		}
		seen.multiRunLoads++;
		const changeDays = new Set();
		for (const r of runs.slice(1)) for (const d of localDaysOf(r.fromMs)) changeDays.add(d);
		const indexAt = (ms) => runs.findIndex((r) => ms >= r.fromMs && ms < r.toMs);
		const per = runs.map((run) => ({ run, days: [], coverage: new Set(), travel: new Set() }));
		for (const d of days) {
			if (!changeDays.has(d)) {
				const p = per[indexAt(Date.parse(`${d}T12:00:00Z`))];
				p.days.push(d);
				const e = p.run.vid ? eldByVid[p.run.vid] : null;
				if (e && e.coverage.has(d)) p.coverage.add(d);
				if (e && e.travel.has(d)) p.travel.add(d);
				continue;
			}
			seen.changeDays.add(`${id}|${d}`);
			// A change day by instant: each fix counts for the run of its instant, only while its device was on the truck.
			const lo = Date.parse(`${d}T00:00:00Z`);
			const hi = lo + 36 * HOUR_MS;
			const touched = new Set();
			const key = `${id}|${d}`;
			if (!changeDayFixes.has(key)) changeDayFixes.set(key, fixesOnTruck(id, lo, hi, "location_date_ms AS ms, speed, longitude AS lng"));
			for (const f of changeDayFixes.get(key)) {
				const ms = Number(f.ms);
				if (eldMiles.localDayInTz(ms, eldMiles.usTzForLongitude(f.lng, ms)) !== d) continue;
				const i = indexAt(ms);
				if (i < 0) continue;
				touched.add(i);
				per[i].coverage.add(d);
				if ((Number(f.speed) || 0) > TRAVEL_MPS) per[i].travel.add(d);
			}
			// The runs whose time touches the day on the business clock, fix or none.
			runs.forEach((r, i) => {
				const a = Math.max(r.fromMs, lo - DAY_MS);
				const b = Math.min(r.toMs, hi + DAY_MS);
				if (b > a && appTime.businessDayOf(new Date(a)) <= d && d <= appTime.businessDayOf(new Date(b - 1))) touched.add(i);
			});
			for (const i of touched) per[i].days.push(d);
		}
		const paid = new Set();
		let covered = false;
		for (const p of per) {
			if (!p.days.length) continue;
			const res = loadPayDays.payDaysForLoad(p.days, p.run.vid ? { coverage: p.coverage, travel: p.travel } : null, loadOf(p.run), preDispatch);
			if (res.covered) covered = true;
			for (const d of res.days) paid.add(d);
		}
		return { covered, days: days.filter((d) => paid.has(d)) };
	}

	return {
		fromMs,
		resolver,
		truck,
		devices,
		windowPaidDays,
		// What the dated readers read, for the switch-on's two-way report (server.js setEldLinkForwardReportFrom()).
		stats: () => ({ trucks: seen.trucks.size, devices: seen.devices.size, multiRunLoads: seen.multiRunLoads, changeDays: seen.changeDays.size }),
	};
}

// One reader's view of the link context: `unitToTruck` maps a lower-case unit to a truck id, every truck in the reader's
// scope, linked now or not (an investor's scope holds only that investor's trucks).
function scope(link, unitToTruck) {
	const truckIdOf = (unit) => {
		const key = String(unit || "").trim().toLowerCase();
		return key && Object.prototype.hasOwnProperty.call(unitToTruck, key) ? unitToTruck[key] : null;
	};
	return {
		link,
		truckIdOf,
		truckFor: (unit) => {
			const id = truckIdOf(unit);
			return id === null ? null : link.truck(id);
		},
		devices: (aMs, bMs) => link.devices(Object.values(unitToTruck), aMs, bMs),
		// lib/load-pay-days.js paidDaysForLoad() with the window rule run by run.
		paidDaysForLoad({ windowDays, unit, eldByVid, load, preDispatch = null, tripDays = null }) {
			if (Array.isArray(tripDays)) return { covered: false, days: tripDays, basis: "trip" };
			return { ...link.windowPaidDays({ windowDays: windowDays || [], truckId: truckIdOf(unit), eldByVid, load, preDispatch }), basis: "window" };
		},
	};
}

// The Trucks page's line after a link or an unlink while the rule is in force: { effectiveAt, effectiveDay, zone, message }.
function linkAnswer({ kind, atMs, unit, device }) {
	const at = new Date(atMs);
	const zone = appTime.businessZoneAt(at);
	const parts = {};
	for (const p of new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)) parts[p.type] = p.value;
	const when = `${parts.weekday} ${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
	const words = appTime.zoneWords(zone);
	const zoneName = words ? words.word : zone;
	const message = kind === "unlink"
		? `Unlinked. From ${when} (${zoneName}), ${unit} has no ELD device. Before that keeps what it had.`
		: `Linked. From ${when} (${zoneName}), ${unit}'s ELD readings come from ${device}. Before that keeps what it had.`;
	return { effectiveAt: at.toISOString(), effectiveDay: appTime.businessDayOf(at), zone, message };
}

// A day key as the stop's words name it: "Wed Nov 18".
function dayLabel(day) {
	const parts = {};
	for (const p of new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).formatToParts(new Date(`${day}T12:00:00Z`))) parts[p.type] = p.value;
	return `${parts.weekday} ${parts.month} ${parts.day}`;
}

module.exports = {
	RECORD_KEY,
	US_ZONES,
	settingFromEnv,
	decide,
	localDaysOf,
	earliestLocalDay,
	createPayLink,
	scope,
	linkAnswer,
	dayLabel,
};
