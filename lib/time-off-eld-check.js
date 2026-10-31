// Time off checked against the ELD (rule version 1): each finished day of a
// recorded time-off row is judged from the ELD of every truck the driver held
// that day and from his own app activity, with no one approving it. It never
// cancels a row, never touches pay and never re-attributes a ping.
//
// Per day d (each fix on its truck-local day, as pay buckets travel days; a
// silence takes the zone of its first fix):
//   1. a status update from his own Driver account on d: Not confirmed;
//   2. per truck he held and device linked to it then (a segment): a device
//      whose readings break (engine hours that can't happen, an odometer reset
//      or rate) from 7 days before the row through d may be in another vehicle;
//      normal steps (30 minutes or less) add accepted odometer miles, over 5 on d
//      is movement; a longer silence is judged by its two ends on every day it
//      touches: an odometer or position step beyond the 5 mi floor is movement,
//      else engine hours (read over 0 at both ends) up over 1 h mean it ran;
//   3. movement: Not confirmed; else ELD data that conflicts (another vehicle,
//      an engine that ran, a truck that changed hands): Requested; else a silence
//      still open: Checking; else Confirmed, "Confirmed (no ELD data)" when the
//      day has none at all (no truck held, no device, a device that never
//      reported, no reading before or after its silence).
// Pure: no database, network or file.

"use strict";

const eldMiles = require("./eld-miles");
const appTime = require("./app-time");
const driverAvailability = require("./driver-availability");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const METERS_PER_MILE = 1609.344;

const TIME_OFF_ELD_RULE = Object.freeze({
	version: 1,
	// Any longer silence is judged by its ends: a device unpowered for a short
	// drive keeps a device-kept odometer still, so its ends must be compared.
	darkStretchMs: 30 * MINUTE_MS,
	moveFloorMi: eldMiles.ELD_DELTA_FLOOR_MI,
	moveFloorMeters: eldMiles.ELD_DELTA_FLOOR_MI * METERS_PER_MILE,
	engineRanHours: 1,
	movingSpeedMps: 2.235,
	speedOnlyPings: 3,
	speedOnlySpanMs: 5 * MINUTE_MS,
	continuityDays: 7,
	engineDownToleranceHours: 0.1,
	engineUpToleranceHours: 0.5,
	finalAfterDays: 3,
	resultKeepDays: 90,
	runHour: 6,
	// Telemetry is trimmed weekly at 90 days, so up to about 97 days stay.
	lookbackDays: 100,
});

const TIME_OFF_ELD_LABELS = Object.freeze({
	confirmed: "Confirmed",
	no_eld_data: "Confirmed (no ELD data)",
	not_confirmed: "Not confirmed",
	no_data: "Requested",
	pending: "Checking",
	upcoming: "Requested",
	not_checked: "Not checked (month closed)",
	purged: "ELD results are kept 90 days",
});

// A day with no ELD data at all is a day off: no driving and no status shows.
// Each keeps its own reason, so the shapes are counted apart.
const TIME_OFF_NO_ELD_DATA = Object.freeze(["no_truck", "no_device", "device_never_reported", "no_fix_before", "no_fix_after"]);

const REASON_TEXT = Object.freeze({
	app_activity: "his account updated a load's status",
	truck_moved: "the truck moved",
	moved_while_dark: "the truck moved while its ELD was dark",
	no_truck: "no truck on record",
	no_device: "his truck has no ELD linked",
	device_never_reported: "his truck's ELD has never reported",
	device_changed_vehicle: "the ELD may be in another vehicle (a reading changed)",
	engine_ran_while_dark: "the engine ran while the ELD was dark",
	no_fix_before: "the ELD has no reading from before its silence",
	no_fix_after: "the ELD left the truck before it reported again",
	shared_truck: "the truck changed hands while its ELD was dark",
	dark_waiting: "waiting for the ELD to report again",
	parked: "the truck was parked",
	dark_parked: "the ELD was dark and the truck had not moved",
});

// The ELD data that conflicts with a day off and keeps it Requested, the first
// present deciding the stored reason.
const CONFLICT_ORDER = ["device_changed_vehicle", "shared_truck", "engine_ran_while_dark"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isDay = driverAvailability.isAvailabilityDay;
const shiftDay = driverAvailability.shiftAvailabilityDay;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const zoneOfFix = (f) => eldMiles.usTzForLongitude(f.lng === null ? NaN : f.lng);
const dayOfFix = (f) => eldMiles.localDayInTz(f.ms, zoneOfFix(f));
const monthDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const words = (code) => String(code || "").replace(/_/g, " ");

// One fix per instant (the largest odometer kept), numbers cleaned, in time order.
function normalizeSeries(raw) {
	const byMs = new Map();
	for (const f of raw || []) {
		const ms = Number(f && f.ms);
		if (!Number.isFinite(ms)) continue;
		const fix = { ms, odo: num(f.odo), eh: num(f.eh), lat: numOrNull(f.lat), lng: numOrNull(f.lng), speed: num(f.speed), source: String(f.source || "") };
		const prev = byMs.get(ms);
		if (!prev || fix.odo > prev.odo) byMs.set(ms, fix);
	}
	return [...byMs.values()].sort((a, b) => a.ms - b.ms);
}

function distanceMeters(a, b) {
	if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLng = (b.lng - a.lng) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// valueAt over [fromMs, toMs) as [{ value, fromMs, toMs }], constant between
// breakpoints. Each piece is read at its middle, so a bound's own instant never
// decides it; equal neighbours are joined.
function effectiveIntervals(valueAt, breakpoints, fromMs, toMs) {
	const inner = (breakpoints || []).filter((b) => Number.isFinite(b) && b > fromMs && b < toMs);
	const pts = [...new Set([fromMs, ...inner, toMs])].sort((a, b) => a - b);
	const out = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const value = valueAt(Number.isFinite(b) ? a + Math.floor((b - a) / 2) : a + 1);
		const last = out[out.length - 1];
		if (last && last.value === value) last.toMs = b;
		else out.push({ value, fromMs: a, toMs: b });
	}
	return out;
}

// The driver's segments from fromMs on: each stretch of time he held a truck
// (lib/eld-miles.js's resolver, newest row winning) split by the device linked to
// it (vid "" while none), with the whole link it falls in (for continuity).
function timeOffDriverContexts({ driverKey, normalize, assignments, deviceRows = [], deviceStartMs = null, currentLinks = [], fromMs }) {
	const rows = Array.isArray(assignments) ? assignments : [];
	const holders = eldMiles.buildDriverAtResolver(rows);
	const devices = eldMiles.buildDeviceTruckResolver(deviceRows || [], { startMs: deviceStartMs, currentLinks });
	const trucks = [...new Set(rows.filter((r) => driverKey && normalize(r.driver_name) === driverKey).map((r) => Number(r.truck_id)).filter(Number.isFinite))]
		.sort((a, b) => a - b);
	const contexts = [];
	for (const truckId of trucks) {
		const holdBreaks = rows.filter((r) => Number(r.truck_id) === truckId).flatMap((r) => [Date.parse(r.start_date), r.end_date ? Date.parse(r.end_date) : NaN]);
		const holds = effectiveIntervals((ms) => normalize(holders.atInstant(truckId, ms)) === driverKey, holdBreaks, fromMs, Infinity).filter((h) => h.value);
		if (!holds.length) continue;
		const linkBreaks = [deviceStartMs, ...(deviceRows || []).filter((r) => Number(r.truck_id) === truckId)
			.flatMap((r) => [Date.parse(r.assigned_from), r.assigned_until ? Date.parse(r.assigned_until) : NaN])].map(Number).filter(Number.isFinite);
		const links = effectiveIntervals((ms) => devices.vehicleForTruckAt(truckId, ms) || "", linkBreaks, fromMs, Infinity);
		for (const h of holds) {
			for (const l of links) {
				const a = Math.max(h.fromMs, l.fromMs);
				const b = Math.min(h.toMs, l.toMs);
				if (b > a) contexts.push({ truckId, vid: l.value, fromMs: a, toMs: b, linkFromMs: l.fromMs, linkToMs: l.toMs });
			}
		}
	}
	contexts.sort((x, y) => x.fromMs - y.fromMs || x.truckId - y.truckId);
	return { contexts, devices };
}

// Readings of one link that say the device may be in another vehicle: an
// engine-hours step that can't happen (RouteMate readings over 0 only), or an
// odometer step the miles walk refuses as a reset or an impossible rate.
function continuityBreaks(fixes) {
	const R = TIME_OFF_ELD_RULE;
	const out = [];
	let prevEh = null;
	let prevOdo = null;
	for (const f of fixes || []) {
		if (f.eh > 0 && f.source !== "linxup") {
			if (prevEh) {
				const dh = f.eh - prevEh.eh;
				const elapsedH = (f.ms - prevEh.ms) / HOUR_MS;
				if (dh < -R.engineDownToleranceHours || dh > elapsedH + R.engineUpToleranceHours) {
					out.push({ kind: "engine_hours", ms: f.ms, prevMs: prevEh.ms, day: dayOfFix(f), prevDay: dayOfFix(prevEh) });
				}
			}
			prevEh = f;
		}
		if (f.odo > 0) {
			if (prevOdo) {
				const v = eldMiles.acceptOdoDelta(prevOdo.odo, f.odo, prevOdo.ms, f.ms);
				if (!v.ok && (v.reason === "reset" || v.reason === "rate")) {
					out.push({ kind: `odometer_${v.reason}`, ms: f.ms, prevMs: prevOdo.ms, day: dayOfFix(f), prevDay: dayOfFix(prevOdo) });
				}
			}
			prevOdo = f;
		}
	}
	return out;
}

// A silence judged by its two ends.
function judgeDarkStretch(a, b) {
	const R = TIME_OFF_ELD_RULE;
	const odoStepMi = a.odo > 0 && b.odo > 0 ? b.odo - a.odo : null;
	const distanceM = distanceMeters(a, b);
	const engineAdvanceH = a.eh > 0 && b.eh > 0 ? b.eh - a.eh : null;
	const moved = (odoStepMi !== null && odoStepMi > R.moveFloorMi) || (distanceM !== null && distanceM > R.moveFloorMeters);
	const engineRan = !moved && engineAdvanceH !== null && engineAdvanceH > R.engineRanHours;
	return { fromMs: a.ms, toMs: b.ms, odoStepMi, distanceM, engineAdvanceH, moved, engineRan, afterMoving: b.speed > R.movingSpeedMps };
}

const lastBefore = (series, ms) => { let hit = null; for (const f of series) { if (f.ms < ms) hit = f; else break; } return hit; };
const firstFrom = (series, ms) => series.find((f) => f.ms >= ms) || null;

// One segment's walk over its device's readings (`series`, in time order): its
// fixes, normal steps and dark stretches, and the silences at its two ends. A
// silence crossing the start can't be judged with no reading before it, or with
// the device then on another truck (no_fix_before), and can't be put on him
// when someone else held the truck then (shared_truck); likewise at the end.
function walkSeries({ context, series, devices, nowMs }) {
	const R = TIME_OFF_ELD_RULE;
	const { truckId, vid, fromMs: cs, toMs: ce } = context;
	if (!vid) return [{ kind: "edge", reason: "no_device", fromMs: cs, toMs: ce, zone: null }];
	if (!series.length) return [{ kind: "edge", reason: "device_never_reported", fromMs: cs, toMs: ce, zone: null }];
	const dark = (fromMs, toMs) => toMs - fromMs > R.darkStretchMs;
	const startReason = (b) => (b && devices.truckForVehicleAt(vid, b.ms) === truckId ? "shared_truck" : "no_fix_before");
	const endReason = (a) => {
		if (a) return devices.truckForVehicleAt(vid, a.ms) === truckId ? "shared_truck" : "no_fix_after";
		return devices.vehicleForTruckAt(truckId, ce + 1) === vid ? "shared_truck" : "no_fix_after";
	};
	const inside = series.filter((f) => f.ms >= cs && f.ms < ce);
	if (!inside.length) {
		const b = lastBefore(series, cs);
		const a = firstFrom(series, ce);
		const zone = b ? zoneOfFix(b) : a ? zoneOfFix(a) : null;
		if (b && a && !dark(b.ms, a.ms)) return [{ kind: "covered", fromMs: cs, toMs: ce, zone }];
		const reasons = [b ? startReason(b) : "no_fix_before", !a && ce > nowMs ? "dark_waiting" : endReason(a)];
		// With no reading before, nothing the ELD sends later can be compared, so
		// there is nothing to wait for.
		const reason = ["shared_truck", "no_fix_before", "dark_waiting", "no_fix_after"].find((r) => reasons.includes(r));
		return [{ kind: "edge", reason, fromMs: cs, toMs: ce, zone }];
	}
	const pieces = [];
	const first = inside[0];
	const b = lastBefore(series, first.ms);
	if (b ? dark(b.ms, first.ms) : dark(cs, first.ms)) {
		pieces.push({ kind: "edge", reason: b ? startReason(b) : "no_fix_before", fromMs: cs, toMs: first.ms, zone: zoneOfFix(b || first) });
	} else {
		pieces.push({ kind: "covered", fromMs: cs, toMs: first.ms, zone: zoneOfFix(b || first) });
	}
	for (let i = 0; i < inside.length; i++) {
		const f = inside[i];
		pieces.push({ kind: "fix", ms: f.ms, day: dayOfFix(f), zone: zoneOfFix(f), moving: f.speed > R.movingSpeedMps });
		if (i === 0) continue;
		const p = inside[i - 1];
		if (dark(p.ms, f.ms)) {
			pieces.push({ kind: "stretch", zone: zoneOfFix(p), ...judgeDarkStretch(p, f) });
		} else {
			const measured = p.odo > 0 && f.odo > 0;
			const v = measured ? eldMiles.acceptOdoDelta(p.odo, f.odo, p.ms, f.ms) : null;
			pieces.push({ kind: "step", day: dayOfFix(f), fromMs: p.ms, toMs: f.ms, measured, miles: v && v.ok ? v.miles : 0 });
		}
	}
	const last = inside[inside.length - 1];
	const a = firstFrom(series, last.ms + 1);
	if (!a && ce > nowMs) {
		const kind = dark(last.ms, nowMs) ? "edge" : "covered";
		pieces.push({ kind, reason: "dark_waiting", fromMs: last.ms, toMs: ce, zone: zoneOfFix(last) });
	} else if (a ? dark(last.ms, a.ms) : true) {
		pieces.push({ kind: "edge", reason: endReason(a), fromMs: last.ms, toMs: ce, zone: zoneOfFix(last) });
	} else {
		pieces.push({ kind: "covered", fromMs: last.ms, toMs: ce, zone: zoneOfFix(last) });
	}
	return pieces;
}

// One segment's result on a day, `brk` the first continuity break in its window.
// A day with any reading or judged silence is judged on them; one with neither
// has no ELD data.
function segmentResult(s, brk) {
	const R = TIME_OFF_ELD_RULE;
	if (!s.vid) return "no_device";
	if (s.edges.has("device_never_reported")) return "device_never_reported";
	if (brk) return "device_changed_vehicle";
	const speedOnly = !s.measured && s.movingMs.length >= R.speedOnlyPings && Math.max(...s.movingMs) - Math.min(...s.movingMs) >= R.speedOnlySpanMs;
	// Rounded as the miles are shown, so a day reading "5.0 mi" never counts as moved.
	if (Math.round(s.miles * 10) / 10 > R.moveFloorMi || speedOnly) return "truck_moved";
	if (s.moved) return "moved_while_dark";
	if (s.edges.has("shared_truck")) return "shared_truck";
	if (s.engineRan) return "engine_ran_while_dark";
	if (s.edges.has("dark_waiting")) return "dark_waiting";
	if (s.fixes > 0) return "parked";
	if (s.stretches.length || s.covered) return "dark_parked";
	return ["no_fix_before", "no_fix_after"].find((r) => s.edges.has(r)) || "dark_parked";
}

// One day's verdict from its segments (each with its `result`) and his own
// status updates on it (`taps`, epoch ms; null when the check was skipped).
function timeOffDayVerdict({ day, segments, taps, activityNote = "" }) {
	const segs = Array.isArray(segments) ? segments : [];
	const tapList = Array.isArray(taps) ? taps.slice().sort((a, b) => a - b) : [];
	const results = segs.map((s) => s.result);
	let state;
	let reason;
	if (tapList.length) [state, reason] = ["not_confirmed", "app_activity"];
	else if (!segs.length) [state, reason] = ["confirmed", "no_truck"];
	else if (results.includes("truck_moved")) [state, reason] = ["not_confirmed", "truck_moved"];
	else if (results.includes("moved_while_dark")) [state, reason] = ["not_confirmed", "moved_while_dark"];
	else {
		const conflict = CONFLICT_ORDER.find((r) => results.includes(r));
		if (conflict) [state, reason] = ["no_data", conflict];
		else if (results.includes("dark_waiting")) [state, reason] = ["pending", "dark_waiting"];
		else if (results.includes("parked")) [state, reason] = ["confirmed", "parked"];
		else if (results.includes("dark_parked")) [state, reason] = ["confirmed", "dark_parked"];
		else [state, reason] = ["confirmed", TIME_OFF_NO_ELD_DATA.find((r) => results.includes(r)) || "no_truck"];
	}
	const moving = segs.flatMap((s) => (s.movingMs.length ? s.movingMs : s.stepMoveMs));
	const changes = segs.map((s) => s.changeMs).filter(Number.isFinite);
	const samples = segs.reduce((n, s) => n + s.fixes, 0);
	const stretches = [];
	for (const s of segs) for (const st of s.stretches) if (!stretches.includes(st)) stretches.push(st);
	return {
		day, state, reason, ruleVersion: TIME_OFF_ELD_RULE.version,
		noEldData: state === "confirmed" && TIME_OFF_NO_ELD_DATA.includes(reason),
		dayZone: (segs.find((s) => s.zone) || {}).zone || "",
		truckIds: [...new Set(segs.map((s) => s.truckId))].sort((a, b) => a - b),
		vehicleIds: [...new Set(segs.map((s) => s.vid).filter(Boolean))].sort(),
		miles: Math.round(segs.reduce((n, s) => n + s.miles, 0) * 10) / 10,
		movingPings: segs.reduce((n, s) => n + s.movingMs.length, 0),
		samples,
		firstMoveMs: moving.length ? Math.min(...moving) : null,
		lastMoveMs: moving.length ? Math.max(...moving) : null,
		activityFirstMs: tapList.length ? tapList[0] : null,
		activityLastMs: tapList.length ? tapList[tapList.length - 1] : null,
		changeMs: changes.length ? Math.min(...changes) : null,
		activityNote: Array.isArray(taps) ? "" : String(activityNote || ""),
		darkSpell: segs.length > 0 && samples === 0,
		stretches,
		segments: segs.map((s) => ({ truckId: s.truckId, vid: s.vid, result: s.result, miles: Math.round(s.miles * 10) / 10, samples: s.fixes })),
	};
}

// Every day in `days` judged from `evidence` (server.js timeOffDayEvidence()):
// Map(day -> verdict). anchorOf(day) is the first day of the row the day belongs
// to, which starts its 7-day continuity window.
function judgeTimeOffDays({ days, anchorOf = null, driverKey, normalize, evidence, nowMs }) {
	const R = TIME_OFF_ELD_RULE;
	const ev = evidence || {};
	const wanted = [...new Set((days || []).filter(isDay))].sort();
	const out = new Map();
	if (!wanted.length) return out;
	const want = new Set(wanted);
	const minDay = wanted[0];
	const maxDay = wanted[wanted.length - 1];
	const anchor = typeof anchorOf === "function" ? anchorOf : () => minDay;
	const lookFromMs = Number.isFinite(ev.lookFromMs) ? ev.lookFromMs : nowMs - R.lookbackDays * DAY_MS;
	const appZone = appTime.appTimeZone();
	const { contexts, devices } = timeOffDriverContexts({
		driverKey, normalize, assignments: ev.assignments, deviceRows: ev.deviceRows, deviceStartMs: ev.deviceStartMs, currentLinks: ev.currentLinks, fromMs: lookFromMs,
	});
	const seriesCache = new Map();
	const seriesOf = (vid) => {
		if (!seriesCache.has(vid)) {
			const s = (ev.series && ev.series[vid]) || {};
			seriesCache.set(vid, normalizeSeries([s.before, ...(s.fixes || []), s.after].filter(Boolean)));
		}
		return seriesCache.get(vid);
	};
	// The wanted days an interval touches, in `zone` (the app zone when none).
	const touched = (fromMs, toMs, zone) => {
		const z = zone || appZone;
		const a = appTime.dayInZone(new Date(Math.max(fromMs, lookFromMs)), z);
		const b = appTime.dayInZone(new Date(Math.min(toMs, nowMs)), z);
		const hit = [];
		for (let d = a < minDay ? minDay : a; d && d <= b && d <= maxDay; d = shiftDay(d, 1)) if (want.has(d)) hit.push(d);
		return hit;
	};
	const segs = new Map();
	const segFor = (ci, day) => {
		const key = `${ci}|${day}`;
		let s = segs.get(key);
		if (!s) {
			const c = contexts[ci];
			s = { ci, day, truckId: c.truckId, vid: c.vid, fixes: 0, movingMs: [], stepMoveMs: [], miles: 0, measured: false, moved: false, engineRan: false, covered: false, edges: new Set(), stretches: [], zone: "" };
			segs.set(key, s);
		}
		return s;
	};
	const zoneFixes = [];
	contexts.forEach((c, ci) => {
		const pieces = walkSeries({ context: c, series: c.vid ? seriesOf(c.vid) : [], devices, nowMs });
		for (const p of pieces) {
			if (p.kind === "fix") {
				zoneFixes.push({ ms: p.ms, zone: p.zone });
				if (!want.has(p.day)) continue;
				const s = segFor(ci, p.day);
				s.fixes += 1;
				if (p.moving) s.movingMs.push(p.ms);
				if (!s.zone) s.zone = p.zone;
			} else if (p.kind === "step") {
				if (!want.has(p.day)) continue;
				const s = segFor(ci, p.day);
				s.miles += p.miles;
				if (p.measured) s.measured = true;
				if (p.miles > 0) s.stepMoveMs.push(p.toMs);
			} else if (p.kind === "stretch") {
				for (const d of touched(p.fromMs, p.toMs, p.zone)) {
					const s = segFor(ci, d);
					s.stretches.push(p);
					if (p.moved) s.moved = true;
					if (p.engineRan) s.engineRan = true;
					if (!s.zone) s.zone = p.zone;
				}
			} else {
				for (const d of touched(p.fromMs, p.toMs - 1, p.zone)) {
					const s = segFor(ci, d);
					if (p.kind === "edge") s.edges.add(p.reason);
					else s.covered = true;
					if (!s.zone && p.zone) s.zone = p.zone;
				}
			}
		}
	});
	const breaksCache = new Map();
	const breaksOf = (c) => {
		const key = `${c.vid}|${c.truckId}|${c.linkFromMs}`;
		if (!breaksCache.has(key)) breaksCache.set(key, c.vid ? continuityBreaks(seriesOf(c.vid).filter((f) => f.ms >= c.linkFromMs && f.ms < c.linkToMs)) : []);
		return breaksCache.get(key);
	};
	zoneFixes.sort((a, b) => a.ms - b.ms);
	const zoneAt = (t) => {
		let z = null;
		for (const f of zoneFixes) { if (f.ms <= t) z = f.zone; else { if (!z) z = f.zone; break; } }
		return z || appZone;
	};
	const tapsByDay = new Map();
	if (Array.isArray(ev.taps)) {
		for (const t of ev.taps) {
			if (!Number.isFinite(t)) continue;
			const d = appTime.dayInZone(new Date(t), zoneAt(t));
			if (!tapsByDay.has(d)) tapsByDay.set(d, []);
			tapsByDay.get(d).push(t);
		}
	}
	for (const day of wanted) {
		const from = shiftDay(anchor(day) || day, -R.continuityDays);
		const daySegs = [...segs.values()].filter((s) => s.day === day).sort((a, b) => a.ci - b.ci);
		for (const s of daySegs) {
			const brk = breaksOf(contexts[s.ci]).find((x) => x.day >= from && x.prevDay <= day) || null;
			s.changeMs = brk ? brk.ms : null;
			s.result = segmentResult(s, brk);
		}
		out.set(day, timeOffDayVerdict({ day, segments: daySegs, taps: Array.isArray(ev.taps) ? tapsByDay.get(day) || [] : null, activityNote: ev.activityNote }));
	}
	return out;
}

// The account whose status updates are his own: exactly one Driver account among
// `accounts` (those his name matches, server.js driverAccountsNamed()), else the
// reason the check is skipped: "no_driver_account" or "ambiguous".
function timeOffDriverAccount(accounts) {
	const drivers = (Array.isArray(accounts) ? accounts : []).filter((u) => u && u.role === "Driver" && Number.isSafeInteger(Number(u.id)) && Number(u.id) > 0);
	if (drivers.length === 1) return { account: drivers[0] };
	return { reason: drivers.length ? "ambiguous" : "no_driver_account" };
}

// Why a Not-confirmed day may be expected: a standing "Assign anyway" or "Save
// anyway" for him covering it (confirmed_load), else a live load of his covering
// it (own_load), else no_load; "" when Job Tracking could not be read.
function timeOffExplanation({ day, driverKey, normalize, loadKey, confirmations, loads }) {
	const list = Array.isArray(confirmations) ? confirmations : [];
	const loadOf = new Map(list.map((c) => [c.id, String(c.load_id || "").trim()]));
	const standing = driverAvailability.standingConfirmations({ confirmations: list, loads: loads || null, todayKey: day, normalize, loadKey })
		.filter((s) => s.driverKey === driverKey);
	if (standing.length) return { explanation: "confirmed_load", loadIds: [...new Set(standing.map((s) => loadOf.get(s.id)).filter(Boolean))].sort() };
	if (!loads) return { explanation: "", loadIds: [] };
	const own = [];
	for (const [key, l] of loads) {
		if (!l || l.cancelled || normalize(l.driver) !== driverKey) continue;
		if (!isDay(l.pickupKey) && !isDay(l.dropoffKey)) continue;
		const w = driverAvailability.offDutyLoadWindow(l.pickupKey, l.dropoffKey, day);
		if (w.start <= day && day <= w.end) own.push(String(l.loadId || key));
	}
	return own.length ? { explanation: "own_load", loadIds: [...new Set(own)].sort().slice(0, 10) } : { explanation: "no_load", loadIds: [] };
}

// A day is final at the first run on or after d + 3, unless it still waits for
// the ELD to report again.
function isFinalTimeOffDay({ day, state, todayKey }) {
	return state !== "pending" && isDay(day) && isDay(todayKey) && todayKey >= shiftDay(day, TIME_OFF_ELD_RULE.finalAfterDays);
}

// Whether the daily run is due: at or after 06:00 on the business clock, once
// per business day; a server that was down runs at its first tick after.
function timeOffCheckDue({ nowMs, timeZone, lastDay }) {
	const tz = timeZone || appTime.appTimeZone();
	const day = appTime.dayInZone(new Date(nowMs), tz);
	const [y, m, d] = day.split("-").map(Number);
	const runAt = appTime.wallClockToMs(tz, y, m, d, TIME_OFF_ELD_RULE.runHour, 0, 0);
	return { day, due: nowMs >= runAt && (!isDay(lastDay) || lastDay < day) };
}

// Staff are told once when a day newly reads Not confirmed (not for a load they
// confirmed) or Requested because its device may be in another vehicle, and
// once more if a told day's state changes before it is final.
function timeOffNoticeDecision({ old, next }) {
	const qualifies = (v) => (v.state === "not_confirmed" && v.explanation !== "confirmed_load") || (v.state === "no_data" && v.reason === "device_changed_vehicle");
	if (!old || !old.notified_at) return { first: qualifies(next), followup: false };
	if (old.followup_at) return { first: false, followup: false };
	return { first: false, followup: next.state !== old.notified_state };
}

// Whether a stored day changed in a way its audit row records.
function timeOffDayChanged(old, next) {
	if (!old) return true;
	const same = (a, b) => (a == null ? null : a) === (b == null ? null : b);
	return ["state", "reason", "explanation", "notified_at", "notified_state", "followup_at"].some((k) => !same(old[k], next[k])) || !!old.final_at !== !!next.final_at;
}

// The label staff see for a stored state and reason.
function timeOffDayLabel(state, reason) {
	if (state === "confirmed" && TIME_OFF_NO_ELD_DATA.includes(reason)) return TIME_OFF_ELD_LABELS.no_eld_data;
	return TIME_OFF_ELD_LABELS[state] || String(state || "");
}

const timeText = (ms, timeZone, withZone) => new Intl.DateTimeFormat("en-US", {
	timeZone, hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" } : {}),
}).format(new Date(ms)).replace(/[  ]/g, " ");
const unitsText = (units) => (units && units.length ? units.join(", ") : "his truck");

// One day's line in a staff notice. Never a load ID: the notice reaches every
// staff role, and the panel shows loads under each viewer's own rule.
function timeOffNoticeLine({ verdict, followup = false, units = [], timeZone }) {
	const tz = timeZone || appTime.appTimeZone();
	const v = verdict;
	const md = monthDay(v.day);
	if (followup) return `Update: ${md} now reads ${timeOffDayLabel(v.state, v.reason)}${REASON_TEXT[v.reason] ? `: ${REASON_TEXT[v.reason]}` : ""}.`;
	if (v.reason === "app_activity") return `${md}: his account updated a load's status${Number.isFinite(v.activityFirstMs) ? ` at ${timeText(v.activityFirstMs, tz, true)}` : ""}.`;
	if (v.reason === "truck_moved") {
		const when = Number.isFinite(v.firstMoveMs) && Number.isFinite(v.lastMoveMs) ? ` (first at ${timeText(v.firstMoveMs, tz, false)}, last at ${timeText(v.lastMoveMs, tz, true)})` : "";
		return `${md}: ${unitsText(units)} moved ${Number(v.miles || 0).toFixed(1)} mi${when}.`;
	}
	if (v.reason === "moved_while_dark") return `${md}: ${unitsText(units)} moved while its ELD was dark.`;
	if (v.reason === "device_changed_vehicle") {
		const since = Number.isFinite(v.changeMs) ? ` since ${monthDay(appTime.dayInZone(new Date(v.changeMs), tz))}` : "";
		return `${md}: the ELD on ${unitsText(units)} may be in another vehicle${since} (a reading changed), so its days can't be checked from it.`;
	}
	return `${md}: ${timeOffDayLabel(v.state, v.reason)}${REASON_TEXT[v.reason] ? `, ${REASON_TEXT[v.reason]}` : ""}.`;
}

// One notice per time-off row per run, { title, body }: `lines` [{ kind:
// "first" | "followup", state, text }].
function timeOffNoticeText({ driverName, from, to, lines }) {
	const list = Array.isArray(lines) ? lines : [];
	const days = driverAvailability.availabilityRangeText(from, to);
	const who = `${String(driverName || "").trim() || "A driver"} (${days})`;
	const firsts = list.filter((l) => l.kind === "first");
	const title = firsts.some((l) => l.state === "not_confirmed") ? `Time off not confirmed: ${who}`
		: firsts.length ? `Time off can't be checked: ${who}` : `Time off update: ${who}`;
	return { title, body: list.map((l) => l.text).join(" ") };
}

const NOTE_TEXT = Object.freeze({ no_driver_account: "no driver account", ambiguous: "more than one driver account" });
const STATE_WORDS = Object.freeze({ confirmed: "confirmed", not_confirmed: "not confirmed", no_data: "requested", pending: "checking" });

// The audit line of one run's changes to one row: each changed day's verdict.
// No miles, times or positions, and never the time off's own reason.
function timeOffAuditText({ from, to, days }) {
	const parts = (Array.isArray(days) ? days : []).map((d) => {
		const note = d.activityNote ? `; app activity not checked: ${NOTE_TEXT[d.activityNote] || words(d.activityNote)}` : "";
		const why = `${words(d.reason)}${d.explanation ? `, ${words(d.explanation)}` : ""}${note}`;
		const state = d.state === "confirmed" && TIME_OFF_NO_ELD_DATA.includes(d.reason) ? "confirmed with no ELD data" : STATE_WORDS[d.state] || words(d.state);
		return `${d.day} ${state} (${why})${d.final ? ", final" : ""}${d.notified ? ", notified" : ""}${d.followup ? ", follow-up sent" : ""}`;
	});
	return `off ${from}..${to}: ${parts.join("; ")}`;
}

const parseIds = (text) => { try { const v = JSON.parse(text || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

// A time-off row's days as staff see them, with a summary. `stored` maps day ->
// stored result; `monthClosed(day)` reads the month lock; `units` maps truck id
// -> unit; `showLoadId(id)` gives a load ID as the viewer may see it. A cancelled
// row shows only the days it has results for.
function timeOffEldDaysView({ from, to, cancelled = false, todayKey, stored, monthClosed, units, showLoadId }) {
	const rows = stored instanceof Map ? stored : new Map();
	const closed = typeof monthClosed === "function" ? monthClosed : () => false;
	const show = typeof showLoadId === "function" ? showLoadId : (id) => id;
	const unitOf = (id) => (units instanceof Map ? units.get(Number(id)) : null) || "";
	const eldDays = [];
	if (isDay(from) && isDay(to) && from <= to) {
		for (let day = from; day && day <= to; day = shiftDay(day, 1)) {
			const r = rows.get(day);
			if (cancelled && !r) continue;
			const short = (state) => eldDays.push({ day, state, label: TIME_OFF_ELD_LABELS[state] });
			if (r && r.purged_at) short("purged");
			else if (r && !r.final_at && r.state === "pending" && closed(day)) short("not_checked");
			else if (r) {
				eldDays.push({
					day, state: r.state, label: timeOffDayLabel(r.state, r.reason), reason: r.reason, reasonText: REASON_TEXT[r.reason] || "",
					noEldData: r.state === "confirmed" && TIME_OFF_NO_ELD_DATA.includes(r.reason),
					explanation: r.explanation || "", final: !!r.final_at, units: parseIds(r.truck_ids).map(unitOf).filter(Boolean),
					miles: num(r.miles), movingPings: num(r.moving_pings), samples: num(r.samples),
					firstMoveMs: numOrNull(r.first_move_ms), lastMoveMs: numOrNull(r.last_move_ms),
					activityFirstMs: numOrNull(r.activity_first_ms), activityLastMs: numOrNull(r.activity_last_ms), changeMs: numOrNull(r.change_ms),
					appActivityChecked: !r.activity_note, loadIds: parseIds(r.load_ids).map((id) => show(String(id))), ruleVersion: num(r.rule_version),
				});
			} else if (isDay(todayKey) && day >= todayKey) short("upcoming");
			else if (closed(day)) short("not_checked");
			else short("pending");
		}
	}
	const count = (s) => eldDays.filter((d) => d.state === s).length;
	const summary = {
		days: eldDays.length, confirmed: count("confirmed"), confirmedNoEldData: eldDays.filter((d) => d.noEldData).length,
		notConfirmed: count("not_confirmed"), requested: count("no_data"), checking: count("pending"),
		notChecked: count("not_checked"), kept: count("purged"), upcoming: count("upcoming"),
	};
	const extra = [[summary.notConfirmed, "not confirmed"], [summary.requested, "requested"], [summary.checking, "checking"], [summary.notChecked, "not checked"], [summary.kept, "kept 90 days"]]
		.filter(([n]) => n > 0).map(([n, t]) => ` · ${n} ${t}`).join("");
	const noData = summary.confirmedNoEldData ? ` (${summary.confirmedNoEldData} with no ELD data)` : "";
	summary.text = `ELD: ${summary.confirmed} of ${summary.days} day${summary.days === 1 ? "" : "s"} confirmed${noData}${extra}`;
	return { eldDays, eldSummary: summary };
}

module.exports = {
	TIME_OFF_ELD_RULE,
	TIME_OFF_ELD_LABELS,
	TIME_OFF_NO_ELD_DATA,
	timeOffDayLabel,
	effectiveIntervals,
	timeOffDriverContexts,
	continuityBreaks,
	judgeDarkStretch,
	walkSeries,
	timeOffDayVerdict,
	judgeTimeOffDays,
	timeOffDriverAccount,
	timeOffExplanation,
	isFinalTimeOffDay,
	timeOffCheckDue,
	timeOffNoticeDecision,
	timeOffDayChanged,
	timeOffNoticeLine,
	timeOffNoticeText,
	timeOffAuditText,
	timeOffEldDaysView,
};
