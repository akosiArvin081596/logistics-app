"use strict";
// The C.H. Robinson recorder and sender. Each tick reads load_status_history
// above its cursor, replays each changed CHR load (lib/chr-events.js) and
// records its events; then it decides each due event the way Live will: the
// CHR-load test again, holds, multi-stop, the arrival switch, the proximity test
// (lib/chr-verify.js) and the payload. A Dry-run row ends dry_run, "would have
// been sent". A Live row keeps its payload for the sender, which sends it
// through lib/chr-transport.js only while every gate holds; that transport has
// no CHR host or wire format yet, so nothing can leave LogisX.
//
// A sweep, not a hook in the routes: recordStatusChange() is the one writer of
// every status this reads, so a CHR failure can never block a driver's tap.

const crypto = require("crypto");
const E = require("./chr-events");
const S = require("./chr-store");
const V = require("./chr-verify");
const T = require("./chr-transport");
const L = require("./chr-location");
const autoInvoiceRules = require("./auto-invoice-rules");

const SWEEP_INTERVAL_MS = 60 * 1000;
// A heartbeat older than this (or none) counts as recording starting again, so
// a long stop restarts from a fresh baseline with no burst of old updates (A14).
const HEARTBEAT_GAP_MS = 15 * 60 * 1000;
const HISTORY_BATCH = 500;
const DECIDE_BATCH = 200;
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
// One request at a time, at most 30 a minute until CHR's docs give a limit.
const MAX_SENDS_PER_MIN = 30;
// The shared 15/30/60-minute schedule starts too slowly for CHR's 30-minute window.
const BACKOFF_MIN = Object.freeze([2, 5, 15, 30, 60]);
const BACKOFF_LATER_MIN = 120;
// A location not sent within an hour is stale; a newer one supersedes it anyway.
const GIVE_UP_MS = Object.freeze({ milestone: 24 * HOUR_MS, location: HOUR_MS });
// A row still "sending" this long after its claim was cut off mid-request.
const STUCK_MS = 10 * MIN_MS;
// Five retryable failures in a row pause sending for 15 minutes, then it resumes.
const BREAKER_FAILS = 5;
const BREAKER_PAUSE_MS = 15 * MIN_MS;
// The pilot ends 72 hours after sending went on, or when its delivered update is sent.
const PILOT_MS = 72 * HOUR_MS;
const MODE_FIELDS = Object.freeze({ milestone: "milestones", location: "location" });
const SYSTEM_ACTOR = Object.freeze({ session: Object.freeze({ user: Object.freeze({ id: 0, username: "chr-integration", role: "system" }) }) });
const WHY_TEXT = Object.freeze({
	first_enable: "first enable",
	mode: "the page's mode turned recording on",
	heartbeat_gap: "a heartbeat gap over 15 minutes",
});
const NO_TRANSPORT = Object.freeze({ ready: () => false, send: async () => ({ resultCode: "NOT_CONFIGURED" }), dropToken: () => {} });

// A kind's effective mode. With a loadKey, that load's: off, dry_run or live.
// Without one, the kind's as the page shows it: off, dry_run, pilot (one load
// may go Live) or live. Live, for every load, needs the page's Live and
// CHR_LIVE_ALL_ENABLED; for the pilot load alone, the page's Pilot. Either needs
// CHR_SEND_ENABLED and a ready transport (none exists before PR 3-wire).
function effectiveMode(kind, { settings, config, transportReady = false, loadKey = null }) {
	if (!config || config.updatesEnabled !== true) return "off";
	if (kind === "location" && config.locationEnabled !== true) return "off";
	const page = settings && settings[MODE_FIELDS[kind] || "milestones"];
	if (!S.MODES.includes(page) || page === "off") return "off";
	const canSend = config.sendEnabled === true && transportReady === true;
	if (page === "live") return canSend && config.liveAllEnabled === true ? "live" : "dry_run";
	if (page === "pilot") {
		const pilot = settings.pilot;
		if (!canSend || !pilot || !pilot.loadKey) return "dry_run";
		if (loadKey === null) return "pilot";
		return String(loadKey) === pilot.loadKey ? "live" : "dry_run";
	}
	return "dry_run";
}

// start (recording begins: a baseline), stop (pending rows skipped), live_dropped
// (pending live rows skipped). A rise to Live is no change: rows recorded in Dry
// run end dry_run, so it sends nothing old.
function modeChange(prev, next) {
	const on = (m) => m === "dry_run" || m === "pilot" || m === "live";
	if (!on(prev) && on(next)) return "start";
	if (on(prev) && !on(next)) return "stop";
	if ((prev === "live" || prev === "pilot") && next === "dry_run") return "live_dropped";
	return null;
}

// The checks a due row passes before its proximity test, in order. null: go on.
function sendTimeCheck({ ev, verdict, hold, multiStop, arrivedPickup }) {
	if (verdict.verdict === "skip") return { status: "skipped_not_chr", skipReason: verdict.reason };
	if (verdict.verdict === "other") return { status: "skipped_not_chr", skipReason: "other_broker" };
	if (verdict.verdict === "withheld") return { status: "skipped_not_chr", skipReason: "withheld" };
	if (hold) return { status: "held", holdReason: "load_hold" };
	if (multiStop) return { status: "held", holdReason: "multi_stop" };
	if (!E.isSendable(ev)) return { status: "held", holdReason: "stop_not_mapped", verify: "not_mapped" };
	if (ev.event === "arrived_pickup" && arrivedPickup !== true) return { status: "skipped_off", skipReason: "arrival_off" };
	return null;
}

// Minutes to wait after the attempt-th failed attempt.
function backoffMs(attempts) {
	const i = Math.max(1, Number(attempts) || 1) - 1;
	return (i < BACKOFF_MIN.length ? BACKOFF_MIN[i] : BACKOFF_LATER_MIN) * MIN_MS;
}

// An opaque reference derived from the row's key (if CHR's API takes one); it
// carries nothing of the load.
function referenceOf(idemKey) {
	return crypto.createHash("sha256").update(String(idemKey)).digest("hex").slice(0, 32);
}

function createSweep(deps) {
	const { db, config } = deps;
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const log = deps.log || console;
	const transport = deps.transport && typeof deps.transport.ready === "function" ? deps.transport : NO_TRANSPORT;
	const instructionStopsFor = typeof deps.instructionStopsFor === "function" ? deps.instructionStopsFor : () => null;
	const onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
	const notify = typeof deps.notify === "function" ? deps.notify : () => {};
	const audit = (action, details, entityId = "milestone") => {
		try { deps.logAudit(SYSTEM_ACTOR, action, "chr", entityId, details); } catch { log.error(`[chr] audit ${action} failed`); }
	};
	const sentTimes = [];
	const noticeDays = new Map();
	let running = false;

	const ready = () => transport.ready() === true;
	const modeFor = (settings, key, kind = "milestone") => (effectiveMode(kind, { settings, config, transportReady: ready(), loadKey: key }) === "live" ? "live" : "dry_run");
	// One notice per load per day for a failed or given-up update; pauses always.
	function tell(key, title, body, nowIso) {
		const day = nowIso.slice(0, 10);
		if (key) {
			if (noticeDays.get(key) === day) return;
			noticeDays.set(key, day);
		}
		try { notify({ title, body }); } catch { log.error("[chr] notice failed"); }
	}

	function fail(result, code, nowIso) {
		S.writeState(db, { ...S.readState(db), lastErrorCode: code }, nowIso);
		log.error(`[chr] sweep: ${code}`);
		result.error = code;
		return result;
	}

	// Mode changes and the heartbeat; returns the mode recording runs in now.
	function transitions(result, settings, nowMs, nowIso) {
		const mode = effectiveMode("milestone", { settings, config, transportReady: ready() });
		let state = S.readState(db);
		const change = modeChange(state.lastMode, mode);
		if (mode === "off") {
			if (change === "stop" && S.skipPending(db, { kind: "milestone", reason: "mode_off", nowIso }) > 0) result.changed = true;
			S.writeState(db, { ...S.readState(db), lastMode: "off", lastTickAt: nowIso }, nowIso);
			return mode;
		}
		const gap = autoInvoiceRules.isOffGap(state.lastTickAt, nowMs, HEARTBEAT_GAP_MS);
		if (change === "start" || gap) {
			const why = !state.firstEnabledAt ? "first_enable" : change === "start" ? "mode" : "heartbeat_gap";
			const b = S.baseline(db, { kind: "milestone", nowIso });
			audit("chr_baseline", `Recording of milestones started (${WHY_TEXT[why]}): history up to row ${b.cursor} is never recorded; ${b.skipped} pending row(s) skipped.`);
			log.info(`[chr] baseline: milestones (${why}), ${b.skipped} pending row(s) skipped`);
			result.baseline = why;
			result.changed = true;
			state = S.readState(db);
			if (!state.firstEnabledAt) state.firstEnabledAt = nowIso;
		}
		// Any load that is no longer Live (Live, the pilot or the send switch gone):
		// its pending live rows are never sent later. A pause keeps them.
		const dropped = S.dropNotLive(db, { kind: "milestone", stillLive: (key) => modeFor(settings, key) === "live", nowIso });
		if (dropped > 0 || change === "live_dropped") {
			audit("chr_live_dropped", `Milestones dropped out of Live: ${dropped} pending live row(s) skipped.`);
			if (dropped > 0) result.changed = true;
			state = S.readState(db);
		}
		S.writeState(db, { ...state, lastMode: mode, lastTickAt: nowIso }, nowIso);
		return mode;
	}

	// Location's own mode changes. Recording starts from now: nothing before it is
	// ever recorded, and the kind's pending rows are skipped; off skips them too;
	// a load no longer Live has its pending live locations dropped.
	function locationTransitions(result, settings, nowIso) {
		const mode = effectiveMode("location", { settings, config, transportReady: ready() });
		let state = S.readState(db);
		const change = modeChange(state.lastLocationMode, mode);
		if (change === "start") {
			const skipped = S.skipPending(db, { kind: "location", reason: "baseline", nowIso });
			audit("chr_baseline", `Recording of locations started: nothing before now is recorded; ${skipped} pending row(s) skipped.`, "location");
			state = { ...S.readState(db), locationSince: nowIso };
			result.changed = true;
		} else if (change === "stop") {
			if (S.skipPending(db, { kind: "location", reason: "mode_off", nowIso }) > 0) result.changed = true;
			state = S.readState(db);
		}
		if (mode !== "off") {
			const dropped = S.dropNotLive(db, { kind: "location", stillLive: (key) => modeFor(settings, key, "location") === "live", nowIso });
			if (dropped > 0) {
				audit("chr_live_dropped", `Locations dropped out of Live: ${dropped} pending live row(s) skipped.`, "location");
				result.changed = true;
			}
		}
		S.writeState(db, { ...state, lastLocationMode: mode }, nowIso);
		return mode;
	}

	// One row per in-transit load for the bucket that has just closed: the newest
	// clean fix of the load's truck in it, at most 20 minutes old (R3.5).
	function locationTick(result, sheet, settings, nowMs, nowIso) {
		if (effectiveMode("location", { settings, config, transportReady: ready() }) === "off") return 0;
		const state = S.readState(db);
		const sinceMs = Date.parse(state.locationSince);
		const bucket = L.lastClosedBucket(nowMs, settings.locationIntervalMin);
		let trucks = null;
		let devices = null;
		const truckAt = (name, ms) => (trucks || (trucks = deps.truckResolver())).forDriverAt(name, ms);
		const deviceAt = (truckId, ms) => (devices || (devices = deps.deviceResolver())).vehicleForTruckAt(truckId, ms);
		const fixRead = db.prepare(L.FIX_SQL);
		const statusRead = db.prepare(L.STATUS_AFTER_SQL);
		const pingRead = db.prepare(V.PING_SQL);
		// The departure's own check, run again for the load's current driver's truck at
		// the departure's time: it confirms only for the truck that left the pickup, so a
		// load handed to another driver mid-route never reports that driver's truck.
		const sameTruck = (key, driverName, depMs) => {
			const truck = truckAt(driverName, depMs);
			const device = truck ? String(deviceAt(truck.truck_id, depMs) || "") : "";
			const ev = { event: "departed_pickup", stop: { kind: "pickup", index: 1 } };
			const point = V.stopPointFor(ev, deps.stopPointsFor(key));
			const win = V.windowFor(ev.event, depMs);
			if (!device || !point || !win) return false;
			const res = V.verifyMilestone({ event: ev.event, eventMs: depMs, point, radiusM: config.geofenceRadiusM, device, pings: pingRead.all(device, win.fromMs, win.toMs), latestPingMs: null, nowMs });
			return res.verify === "confirmed";
		};
		let made = 0;
		for (const dep of S.confirmedDepartures(db, new Date(nowMs - L.WINDOW_CAP_MS).toISOString())) {
			const key = dep.load_id;
			const idemKey = L.locationKey(key, bucket.startMs);
			if (config.redactor.hits(key) || S.hasKey(db, idemKey)) continue;
			const proj = sheet.get(key) || null;
			const verdict = E.chrLoadTest(proj, { redactor: config.redactor });
			const info = S.loadRow(db, key);
			const multi = Boolean(info && info.multi_stop) || E.multiStopSignal({ instructionStops: instructionStopsFor(key) }).multiStop;
			const after = statusRead.all(key, Number(dep.history_row_id) || 0);
			const depMs = Date.parse(dep.event_at);
			const blocked = verdict.verdict !== "chr" || Boolean(info && info.hold) || multi;
			const win = L.windowFor({
				departure: { atMs: depMs },
				finals: S.finalEventCount(db, key),
				statuses: after.map((r) => r.new_status),
				redispatched: after.some((r) => L.REDISPATCH_SOURCES.includes(String(r.source || "").trim().toLowerCase())),
				blocked,
				sameTruck: blocked ? true : sameTruck(key, proj.driverName, depMs),
			});
			if (!win.open) continue;
			const window = { startMs: Number.isFinite(sinceMs) ? Math.max(win.startMs, sinceMs) : win.startMs, endMs: win.endMs };
			// The device on the truck at either end of the bucket, so a truck change inside it is seen.
			const found = [];
			for (const at of [bucket.endMs - 1, bucket.startMs]) {
				const truck = truckAt(proj.driverName, at);
				const device = truck ? String(deviceAt(truck.truck_id, at) || "") : "";
				if (!device || found.some((f) => f.device === device)) continue;
				const fix = L.pickFix(fixRead.all(device, bucket.startMs, bucket.endMs), {
					bucket, window, nowMs, device, truckAt: (ms) => truckAt(proj.driverName, ms), deviceAt,
				});
				found.push({ device, fix });
			}
			const fix = found.map((f) => f.fix).filter(Boolean).sort((a, b) => b.ms - a.ms)[0] || null;
			if (!fix) continue;
			const payload = L.buildLocationPayload({ loadId: proj.loadId, fix, redactor: config.redactor });
			if (!payload) continue;
			const mode = modeFor(settings, key, "location");
			if (S.insertLocation(db, { loadId: key, eventAt: new Date(fix.ms).toISOString(), idemKey, payloadJson: JSON.stringify(payload), mode, nowIso })) {
				made++;
				if (mode === "live") S.supersedeOlder(db, { loadId: key, keepKey: idemKey, nowIso });
			}
		}
		if (made) result.changed = true;
		return made;
	}

	// When sending went on (for the pilot's 72 hours), and the pilot's end.
	function pilotCheck(result, settings, nowMs, nowIso) {
		let state = S.readState(db);
		const sendOn = config.sendEnabled === true;
		if (sendOn !== Boolean(state.sendOnAt)) {
			state = { ...state, sendOnAt: sendOn ? nowIso : "" };
			S.writeState(db, state, nowIso);
		}
		const kinds = Object.values(MODE_FIELDS).filter((f) => settings[f] === "pilot");
		const pilot = settings.pilot;
		if (!kinds.length || !pilot) return settings;
		let next = settings;
		if (state.sendOnAt && !pilot.until) {
			next = { ...settings, pilot: { ...pilot, until: new Date(Date.parse(state.sendOnAt) + PILOT_MS).toISOString() } };
			S.writeSettings(db, next, { by: "chr-integration", nowIso });
		}
		const delivered = Boolean(db.prepare("SELECT 1 AS x FROM chr_events WHERE load_id = ? AND event = 'delivered' AND mode = 'live' AND status = 'sent' LIMIT 1").get(pilot.loadKey));
		const until = next.pilot.until ? Date.parse(next.pilot.until) : NaN;
		const timedOut = Number.isFinite(until) && nowMs >= until;
		if (!delivered && !timedOut) return next;
		const ended = { ...next, pilot: null };
		for (const f of kinds) ended[f] = "dry_run";
		S.writeSettings(db, ended, { by: "chr-integration", nowIso });
		const why = delivered ? "its delivered update was sent" : "72 hours after sending went on";
		audit("chr_pilot_end", `The pilot ended (${why}): ${kinds.join(" and ")} back to Dry run.`, "pilot");
		tell("", "C.H. Robinson: the pilot ended", `The one-load pilot ended (${why}). Every load is in Dry run again.`, nowIso);
		log.info(`[chr] pilot ended (${delivered ? "delivered" : "72h"})`);
		result.changed = true;
		return ended;
	}

	function record(rows, sheet, settings, nowMs, nowIso) {
		const state = S.readState(db);
		// load_id as recordStatusChange() stored it (lower case, one '#' dropped):
		// normalizing it again would miss a Load ID that began with two.
		const counts = new Map();
		for (const r of rows) {
			const key = String(r.load_id == null ? "" : r.load_id);
			if (key) counts.set(key, (counts.get(key) || 0) + 1);
		}
		const inserts = [];
		const voids = [];
		const loads = [];
		let withheld = 0;
		const nextAttempt = new Date(nowMs + settings.settleMin * MIN_MS).toISOString();
		for (const [key, count] of counts) {
			// A recorded row stores the key (load_id, idem_key), so a key that holds a
			// protected number stops here, before the sheet or any verdict: only counted.
			if (config.redactor.hits(key)) { withheld += count; continue; }
			const proj = sheet.get(key) || null;
			const verdict = E.chrLoadTest(proj, { redactor: config.redactor });
			if (verdict.verdict === "other") continue;
			if (verdict.verdict === "withheld") { withheld += count; continue; }
			const mode = modeFor(settings, key);
			const rep = E.replayLoad(db.prepare(E.HISTORY_SQL.forLoad).all(key), { loadKey: key, baselineId: state.baselineId });
			const live = new Set(rep.liveKeys);
			for (const ev of rep.events) {
				const timed = Number.isFinite(ev.atMs);
				const base = {
					load_id: key, kind: "milestone", event: ev.event, stop_kind: ev.stop.kind, stop_index: ev.stop.index, source: ev.source,
					history_row_id: ev.rowId, event_at: timed ? new Date(ev.atMs).toISOString() : "", idem_key: ev.key, payload_json: "", mode, fields_dropped: 0,
				};
				if (verdict.verdict === "skip") inserts.push({ ...base, verify: "n/a", status: "skipped_not_chr", skip_reason: verdict.reason });
				else if (ev.jump) inserts.push({ ...base, verify: "waiting", status: "held", hold_reason: "stop_skipped" });
				else if (!timed) inserts.push({ ...base, verify: "waiting", status: "held", hold_reason: "person" });
				else inserts.push({ ...base, verify: "waiting", status: "pending", next_attempt_at: nextAttempt });
			}
			for (const r of S.eventsForLoad(db, key)) if (!live.has(r.idem_key)) voids.push(r.idem_key);
			if (verdict.verdict === "chr") {
				const existing = S.loadRow(db, key);
				const ms = E.multiStopSignal({ history: rep.multiStop, instructionStops: instructionStopsFor(key), marked: Boolean(existing && existing.multi_stop_why === "person") });
				const last = rep.events.length ? rep.events[rep.events.length - 1] : null;
				loads.push({
					load_id: key, multi_stop: ms.multiStop, multi_stop_why: ms.why,
					last_event: last ? last.event : (existing ? existing.last_event : ""),
					last_event_at: last && Number.isFinite(last.atMs) ? new Date(last.atMs).toISOString() : (existing ? existing.last_event_at : ""),
				});
			}
		}
		const cursor = Number(rows[rows.length - 1].id);
		S.applyRecording(db, {
			inserts, voids, loads, nowIso,
			state: { ...state, cursor, withheldRows: state.withheldRows + withheld, lastErrorCode: "", lastSweepOk: nowIso },
		});
		return inserts.length;
	}

	// The CHR-load test, holds, multi-stop and the arrival switch, for a row
	// about to be decided or sent. null: go on.
	function preChecks(row, sheet, settings) {
		const key = row.load_id;
		const proj = sheet.get(key) || null;
		// A row recorded before its key's number was protected is never built or sent.
		const verdict = config.redactor.hits(key) ? { verdict: "withheld" } : E.chrLoadTest(proj, { redactor: config.redactor });
		const info = S.loadRow(db, key);
		const multiStop = Boolean(info && info.multi_stop) || E.multiStopSignal({ instructionStops: instructionStopsFor(key) }).multiStop;
		const ev = { event: row.event, stop: { kind: row.stop_kind, index: row.stop_index } };
		return { proj, ev, pre: sendTimeCheck({ ev, verdict, hold: Boolean(info && info.hold), multiStop, arrivedPickup: settings.arrivedPickup }) };
	}

	function decide(sheet, settings, nowMs, nowIso) {
		const due = S.dueRows(db, { nowIso, limit: DECIDE_BATCH });
		if (!due.length) return 0;
		let trucks = null;
		let devices = null;
		const truckAt = (name, ms) => (trucks || (trucks = deps.truckResolver())).forDriverAt(name, ms);
		const deviceAt = (truckId, ms) => (devices || (devices = deps.deviceResolver())).vehicleForTruckAt(truckId, ms);
		const pingRead = db.prepare(V.PING_SQL);
		const latestRead = db.prepare(V.LATEST_PING_SQL);
		const positionsAllowed = config.locationEnabled === true && settings.positionsInMilestones === true;
		let decided = 0;
		const finish = (row, fields) => { if (S.finishRow(db, row.id, { ...fields, nowIso })) decided++; };
		for (const row of due) {
			const { proj, ev, pre } = preChecks(row, sheet, settings);
			if (pre) {
				finish(row, { status: pre.status, holdReason: pre.holdReason || "", skipReason: pre.skipReason || "", verify: pre.verify });
				continue;
			}
			const eventMs = Date.parse(row.event_at);
			const truck = truckAt(proj.driverName, eventMs) || null;
			const device = truck ? String(deviceAt(truck.truck_id, eventMs) || "") : "";
			const point = V.stopPointFor(ev, deps.stopPointsFor(row.load_id));
			const win = V.windowFor(row.event, eventMs);
			const pings = device && win ? pingRead.all(device, win.fromMs, win.toMs) : [];
			const latest = device ? (latestRead.get(device) || {}).ms : null;
			const res = V.verifyMilestone({ event: row.event, eventMs, point, radiusM: config.geofenceRadiusM, device, pings, latestPingMs: latest, nowMs });
			if (res.verify === "waiting") {
				if (row.verify !== "waiting") S.setVerify(db, row.id, "waiting", nowIso);
				continue;
			}
			if (res.verify !== "confirmed") {
				finish(row, { status: "held", holdReason: V.HOLD_FOR[res.verify], verify: res.verify });
				continue;
			}
			const built = E.buildPayload({
				loadId: proj.loadId, event: row.event, stop: ev.stop, eventAtMs: eventMs,
				address: ev.stop.kind === "pickup" ? proj.pickupAddress : proj.dropoffAddress, point, ping: res.ping, positionsAllowed,
				truckUnit: truck.unit, trailer: proj.trailer, personNames: [proj.driverName], redactor: config.redactor,
			});
			if (!built.payload) {
				finish(row, { status: "held", holdReason: "person", verify: "confirmed" });
				continue;
			}
			if (row.mode === "live") {
				if (S.markReady(db, row.id, { payloadJson: JSON.stringify(built.payload), fieldsDropped: built.fieldsDropped, nowIso })) decided++;
				continue;
			}
			finish(row, { status: "dry_run", verify: "confirmed", payloadJson: JSON.stringify(built.payload), fieldsDropped: built.fieldsDropped, sentAt: nowIso });
		}
		return decided;
	}

	function pause(reason, nowMs, nowIso, untilMs = null) {
		S.writeState(db, { ...S.readState(db), pausedReason: reason, pausedAt: nowIso, pausedUntil: untilMs ? new Date(untilMs).toISOString() : "", failStreak: 0 }, nowIso);
		audit("chr_paused", `Sending to C.H. Robinson paused (${reason})${untilMs ? ", for 15 minutes" : ", until a Super Admin resumes it"}.`, "sending");
		tell("", "C.H. Robinson: sending paused", reason === "AUTH_FAILED"
			? "C.H. Robinson refused LogisX's credentials. Updates wait; press Resume once the credentials are fixed."
			: "C.H. Robinson was unavailable five times in a row. Sending pauses for 15 minutes, then resumes by itself.", nowIso);
		log.error(`[chr] sending paused: ${reason}`);
	}

	// Housekeeping that needs no sheet: rows cut off mid-request, live rows too old
	// to send, and the end of a 15-minute pause.
	function housekeep(result, nowMs, nowIso) {
		if (S.recoverStuck(db, { cutoffIso: new Date(nowMs - STUCK_MS).toISOString(), nowIso }) > 0) result.changed = true;
		for (const r of S.giveUpOld(db, { kind: "milestone", cutoffIso: new Date(nowMs - GIVE_UP_MS.milestone).toISOString(), nowIso })) {
			result.changed = true;
			tell(r.load_id, "C.H. Robinson: an update was given up", `An update for load ${r.load_id} was not sent within 24 hours and was given up. Post it in Navisphere if it is still right.`, nowIso);
		}
		// A stale position is no use to anyone: given up quietly, no notice.
		if (S.giveUpOld(db, { kind: "location", cutoffIso: new Date(nowMs - GIVE_UP_MS.location).toISOString(), nowIso }).length) result.changed = true;
		const state = S.readState(db);
		if (state.pausedReason === "CHR_UNAVAILABLE" && state.pausedUntil && Date.parse(state.pausedUntil) <= nowMs) {
			S.writeState(db, { ...state, pausedReason: "", pausedAt: "", pausedUntil: "", failStreak: 0 }, nowIso);
			audit("chr_unpaused", "Sending to C.H. Robinson resumed by itself after its 15-minute pause.", "sending");
			result.changed = true;
		}
	}

	// The ready live rows, one request at a time. The mode and the CHR-load test
	// are read again right before each request, so Off stops at once.
	async function sendDue(result, sheet) {
		if (!ready() || config.sendEnabled !== true) return 0;
		let sent = 0;
		const startMs = now();
		while (sentTimes.length && sentTimes[0] <= startMs - MIN_MS) sentTimes.shift();
		const rows = S.readyRows(db, { nowIso: new Date(startMs).toISOString(), limit: Math.max(0, MAX_SENDS_PER_MIN - sentTimes.length) });
		for (const row of rows) {
			if (S.readState(db).pausedReason) break;
			const nowMs = now();
			const nowIso = new Date(nowMs).toISOString();
			const settings = S.readSettings(db);
			if (modeFor(settings, row.load_id, row.kind) !== "live") {
				S.finishRow(db, row.id, { status: "skipped_off", skipReason: "live_dropped", nowIso });
				result.changed = true;
				continue;
			}
			if (row.kind === "location") {
				// A position for a load no longer CHR's, held or multi-stop is never sent.
				const proj = sheet.get(row.load_id) || null;
				const info = S.loadRow(db, row.load_id);
				const verdict = config.redactor.hits(row.load_id) ? { verdict: "withheld" } : E.chrLoadTest(proj, { redactor: config.redactor });
				if (verdict.verdict !== "chr" || Boolean(info && (info.hold || info.multi_stop))) {
					S.finishRow(db, row.id, { status: "gave_up", nowIso });
					result.changed = true;
					continue;
				}
			} else {
				const { pre } = preChecks(row, sheet, settings);
				if (pre) {
					S.finishRow(db, row.id, { status: pre.status, holdReason: pre.holdReason || "", skipReason: pre.skipReason || "", verify: pre.verify, nowIso });
					result.changed = true;
					continue;
				}
			}
			if (!S.claim(db, row.id, nowIso)) continue;
			sentTimes.push(nowMs);
			let res;
			try {
				res = await transport.send(JSON.parse(row.payload_json), { reference: referenceOf(row.idem_key) });
			} catch {
				res = { resultCode: "NETWORK" };
			}
			const code = res && T.RESULT_CODES.includes(res.resultCode) ? res.resultCode : "BAD_RESPONSE";
			const doneMs = now();
			const doneIso = new Date(doneMs).toISOString();
			const attempts = Number(row.attempts) + 1;
			const state = S.readState(db);
			result.changed = true;
			if (code === "SENT" || code === "DUPLICATE") {
				S.finishSend(db, row.id, { status: "sent", result: res, nowIso: doneIso });
				S.writeState(db, { ...state, failStreak: 0 }, doneIso);
				sent++;
			} else if (code === "AUTH_FAILED") {
				S.finishSend(db, row.id, { status: "pending", result: res, nextAttemptAt: doneIso, nowIso: doneIso });
				transport.dropToken();
				pause("AUTH_FAILED", doneMs, doneIso);
				break;
			} else if (T.RETRYABLE.includes(code) || code === "NOT_CONFIGURED") {
				const wait = Math.max(backoffMs(attempts), Number.isInteger(res.retryAfterS) ? res.retryAfterS * 1000 : 0);
				S.finishSend(db, row.id, { status: "pending", result: res, nextAttemptAt: new Date(doneMs + wait).toISOString(), nowIso: doneIso });
				const streak = code === "NOT_CONFIGURED" ? state.failStreak : state.failStreak + 1;
				S.writeState(db, { ...state, failStreak: streak }, doneIso);
				if (streak >= BREAKER_FAILS) {
					pause("CHR_UNAVAILABLE", doneMs, doneIso, doneMs + BREAKER_PAUSE_MS);
					break;
				}
			} else {
				S.finishSend(db, row.id, { status: "failed", result: res, nowIso: doneIso });
				S.writeState(db, { ...state, failStreak: 0 }, doneIso);
				tell(row.load_id, "C.H. Robinson: an update was refused", `C.H. Robinson did not take an update for load ${row.load_id}. Post it in Navisphere, or retry it on the C.H. Robinson page.`, doneIso);
			}
			log.info(`[chr] row ${row.id}: ${code}${Number.isInteger(res && res.httpStatus) ? ` (${res.httpStatus})` : ""}`);
		}
		return sent;
	}

	async function run() {
		const nowMs = now();
		const nowIso = new Date(nowMs).toISOString();
		S.ensureSchema(db);
		const result = { ran: true, mode: "off", locationMode: "off", baseline: null, recorded: 0, decided: 0, located: 0, sent: 0, error: null, changed: false };
		let settings = S.readSettings(db);
		settings = pilotCheck(result, settings, nowMs, nowIso);
		result.mode = transitions(result, settings, nowMs, nowIso);
		result.locationMode = locationTransitions(result, settings, nowIso);
		if (result.mode === "off" && result.locationMode === "off") return result;
		housekeep(result, nowMs, nowIso);
		const rows = result.mode === "off" ? [] : db.prepare(E.HISTORY_SQL.above).all(S.readState(db).cursor, HISTORY_BATCH);
		const sendable = ready() && config.sendEnabled === true && S.readyRows(db, { nowIso, limit: 1 }).length > 0;
		const locating = result.locationMode !== "off" && S.confirmedDepartures(db, new Date(nowMs - L.WINDOW_CAP_MS).toISOString()).length > 0;
		if (!rows.length && !S.dueCount(db, nowIso) && !sendable && !locating) {
			S.writeState(db, { ...S.readState(db), lastSweepOk: nowIso, lastErrorCode: "" }, nowIso);
			return result;
		}
		let sheet;
		try {
			sheet = await deps.readSheet();
			if (!(sheet instanceof Map)) throw new TypeError("readSheet() must answer a Map");
		} catch {
			return fail(result, "SHEET_READ_FAILED", nowIso);
		}
		// The page may have changed the mode while the sheet was read.
		const fresh = S.readSettings(db);
		if (effectiveMode("milestone", { settings: fresh, config, transportReady: ready() }) !== result.mode) return result;
		try {
			if (rows.length) result.recorded = record(rows, sheet, fresh, nowMs, nowIso);
		} catch {
			return fail(result, "RECORD_FAILED", nowIso);
		}
		try {
			result.decided = decide(sheet, fresh, nowMs, nowIso);
		} catch {
			return fail(result, "DECIDE_FAILED", nowIso);
		}
		try {
			result.located = locationTick(result, sheet, fresh, nowMs, nowIso);
		} catch {
			return fail(result, "LOCATION_FAILED", nowIso);
		}
		try {
			result.sent = await sendDue(result, sheet);
		} catch {
			return fail(result, "SEND_FAILED", new Date(now()).toISOString());
		}
		if (!rows.length) S.writeState(db, { ...S.readState(db), lastSweepOk: nowIso, lastErrorCode: "" }, nowIso);
		return result;
	}

	async function tick() {
		if (!config || config.updatesEnabled !== true) return { ran: false, reason: "off" };
		if (running) return { ran: false, reason: "busy" };
		running = true;
		try {
			const result = await run();
			if (result.changed || result.recorded || result.decided || result.sent) onChange();
			return result;
		} finally {
			running = false;
		}
	}

	return { tick };
}

module.exports = {
	SWEEP_INTERVAL_MS,
	HEARTBEAT_GAP_MS,
	HISTORY_BATCH,
	DECIDE_BATCH,
	MAX_SENDS_PER_MIN,
	BACKOFF_MIN,
	BACKOFF_LATER_MIN,
	GIVE_UP_MS,
	STUCK_MS,
	BREAKER_FAILS,
	BREAKER_PAUSE_MS,
	PILOT_MS,
	SYSTEM_ACTOR,
	effectiveMode,
	modeChange,
	sendTimeCheck,
	backoffMs,
	referenceOf,
	createSweep,
};
