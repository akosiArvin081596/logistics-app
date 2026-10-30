"use strict";
// The C.H. Robinson recorder. Each tick reads load_status_history above its
// cursor, replays each changed CHR load (lib/chr-events.js) and records its
// events; then it decides each due event the way Live will: the CHR-load test
// again, holds, multi-stop, the arrival switch, the proximity test
// (lib/chr-verify.js) and the payload. In Dry run the last step has no
// transport at all: the row ends dry_run, "would have been sent". There is no
// sender here, so nothing can leave LogisX.
//
// A sweep, not a hook in the routes: recordStatusChange() is the one writer of
// every status this reads, so a CHR failure can never block a driver's tap.

const E = require("./chr-events");
const S = require("./chr-store");
const V = require("./chr-verify");
const autoInvoiceRules = require("./auto-invoice-rules");

const SWEEP_INTERVAL_MS = 60 * 1000;
// A heartbeat older than this (or none) counts as recording starting again, so
// a long stop restarts from a fresh baseline with no burst of old updates (A14).
const HEARTBEAT_GAP_MS = 15 * 60 * 1000;
const HISTORY_BATCH = 500;
const DECIDE_BATCH = 200;
const MIN_MS = 60 * 1000;
const SYSTEM_ACTOR = Object.freeze({ session: Object.freeze({ user: Object.freeze({ id: 0, username: "chr-integration", role: "system" }) }) });
const WHY_TEXT = Object.freeze({
	first_enable: "first enable",
	mode: "the page's mode turned recording on",
	heartbeat_gap: "a heartbeat gap over 15 minutes",
});

// A kind's effective mode: the page's mode, capped by the server switches and,
// for Live, by a transport being ready (none exists before PR 3).
function effectiveMode(kind, { settings, config, transportReady = false }) {
	if (!config || config.updatesEnabled !== true) return "off";
	if (kind === "location" && config.locationEnabled !== true) return "off";
	const page = kind === "location" ? settings && settings.location : settings && settings.milestones;
	if (!S.MODES.includes(page) || page === "off") return "off";
	if (page === "live" && config.sendEnabled === true && transportReady === true) return "live";
	return "dry_run";
}

// start (recording begins: a baseline), stop (pending rows skipped), live_dropped
// (pending live rows skipped). A rise to Live is no change: rows recorded in Dry
// run end dry_run, so it sends nothing old.
function modeChange(prev, next) {
	const wasOn = prev === "dry_run" || prev === "live";
	const isOn = next === "dry_run" || next === "live";
	if (!wasOn && isOn) return "start";
	if (wasOn && !isOn) return "stop";
	if (prev === "live" && next === "dry_run") return "live_dropped";
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

function createSweep(deps) {
	const { db, config } = deps;
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const log = deps.log || console;
	const instructionStopsFor = typeof deps.instructionStopsFor === "function" ? deps.instructionStopsFor : () => null;
	const onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
	const audit = (action, details) => {
		try { deps.logAudit(SYSTEM_ACTOR, action, "chr", "milestone", details); } catch { log.error(`[chr] audit ${action} failed`); }
	};
	let running = false;

	function fail(result, code, nowIso) {
		S.writeState(db, { ...S.readState(db), lastErrorCode: code }, nowIso);
		log.error(`[chr] sweep: ${code}`);
		result.error = code;
		return result;
	}

	// Mode changes and the heartbeat; returns the mode recording runs in now.
	function transitions(result, settings, nowMs, nowIso) {
		const mode = effectiveMode("milestone", { settings, config });
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
		} else if (change === "live_dropped") {
			const n = S.skipPending(db, { kind: "milestone", mode: "live", reason: "live_dropped", nowIso });
			audit("chr_live_dropped", `Milestones dropped out of Live: ${n} pending live row(s) skipped.`);
			if (n > 0) result.changed = true;
			state = S.readState(db);
		}
		S.writeState(db, { ...state, lastMode: mode, lastTickAt: nowIso }, nowIso);
		return mode;
	}

	function record(rows, sheet, mode, settings, nowMs, nowIso) {
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
			const key = row.load_id;
			const proj = sheet.get(key) || null;
			// A row recorded before its key's number was protected is never built or sent.
			const verdict = config.redactor.hits(key) ? { verdict: "withheld" } : E.chrLoadTest(proj, { redactor: config.redactor });
			const info = S.loadRow(db, key);
			const multiStop = Boolean(info && info.multi_stop) || E.multiStopSignal({ instructionStops: instructionStopsFor(key) }).multiStop;
			const ev = { event: row.event, stop: { kind: row.stop_kind, index: row.stop_index } };
			const pre = sendTimeCheck({ ev, verdict, hold: Boolean(info && info.hold), multiStop, arrivedPickup: settings.arrivedPickup });
			if (pre) {
				finish(row, { status: pre.status, holdReason: pre.holdReason || "", skipReason: pre.skipReason || "", verify: pre.verify });
				continue;
			}
			const eventMs = Date.parse(row.event_at);
			const truck = truckAt(proj.driverName, eventMs) || null;
			const device = truck ? String(deviceAt(truck.truck_id, eventMs) || "") : "";
			const point = V.stopPointFor(ev, deps.stopPointsFor(key));
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
			// A live row waits for the sender (PR 3); Dry run's transport does nothing.
			if (row.mode !== "dry_run") continue;
			finish(row, { status: "dry_run", verify: "confirmed", payloadJson: JSON.stringify(built.payload), fieldsDropped: built.fieldsDropped, sentAt: nowIso });
		}
		return decided;
	}

	async function run() {
		const nowMs = now();
		const nowIso = new Date(nowMs).toISOString();
		S.ensureSchema(db);
		const result = { ran: true, mode: "off", baseline: null, recorded: 0, decided: 0, error: null, changed: false };
		const settings = S.readSettings(db);
		result.mode = transitions(result, settings, nowMs, nowIso);
		if (result.mode === "off") return result;
		const rows = db.prepare(E.HISTORY_SQL.above).all(S.readState(db).cursor, HISTORY_BATCH);
		if (!rows.length && !S.dueCount(db, nowIso)) {
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
		if (effectiveMode("milestone", { settings: fresh, config }) !== result.mode) return result;
		try {
			if (rows.length) result.recorded = record(rows, sheet, result.mode, fresh, nowMs, nowIso);
		} catch {
			return fail(result, "RECORD_FAILED", nowIso);
		}
		try {
			result.decided = decide(sheet, fresh, nowMs, nowIso);
		} catch {
			return fail(result, "DECIDE_FAILED", nowIso);
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
			if (result.changed || result.recorded || result.decided) onChange();
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
	SYSTEM_ACTOR,
	effectiveMode,
	modeChange,
	sendTimeCheck,
	createSweep,
};
