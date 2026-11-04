#!/usr/bin/env node
// What the C.H. Robinson recorder would have done over a past window, replayed
// read-only on a copy of production (the replica) before recording goes on in
// production (gate G1). It runs the recorder's own pipeline: the CHR-load test,
// the per-stop state machine, the proximity test and the payload builder.
// Counts only: never a load ID, a name, an address or a truck.
//
//   node scripts/chr-dry-run-report.js --db <app.db> --sheets <sheets.json> --since YYYY-MM-DD
//   node scripts/chr-dry-run-report.js --pilot --db <app.db>
//   node scripts/chr-dry-run-report.js --location --db <app.db>
//
// --db is opened read-only and must exist; --sheets is the replica's Job
// Tracking working copy, read once. Settings are the page's first-enable
// defaults: Dry run, "Arrived at pickup" off, positions off. A bad argument or
// input exits 2 before anything else is read.
// --pilot (the one-load test, addendum §4.2) reads only the recorder's own rows
// in --db: what went Live, its results, whether any other load went Live, the
// payloads' keys and patterns, the time from each event to its send. Counts and
// yes/no only; it never names the pilot load.
// --location (gate G2, addendum R3.5) reads the recorder's location rows and the
// fixes they came from: rows outside their load's window, rows recorded after
// the load's first final event, fixes that were not clean RouteMate or predate
// their device's link, payloads beyond the four keys, milestone positions that
// failed their test, loads with no position. Counts only.
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const V = require(path.join(ROOT, "lib", "chr-verify.js"));
const W = require(path.join(ROOT, "lib", "chr-sweep.js"));
const loadHaul = require(path.join(ROOT, "lib", "load-haul.js"));
const eldMiles = require(path.join(ROOT, "lib", "eld-miles.js"));
const tripWorkDays = require(path.join(ROOT, "lib", "trip-work-days.js"));

const USAGE = "usage: node scripts/chr-dry-run-report.js --db <app.db> --sheets <sheets.json> --since YYYY-MM-DD\n       node scripts/chr-dry-run-report.js --pilot --db <app.db>\n       node scripts/chr-dry-run-report.js --location --db <app.db>";
// Reads copied from server.js (buildHaulTruckResolver(), buildEldDeviceResolver(),
// eldDeviceHistoryStartMs(), getLoadCoordsRow(), getDeletedLoadIds()); a runner
// pins each one to server.js's text.
const SERVER_SQL = Object.freeze({
	haulAssignments: `SELECT ta.driver_name, ta.start_date, ta.end_date,
	        t.id AS truck_id, t.unit_number AS unit, COALESCE(t.routemate_vehicle_id, '') AS vid
	 FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id
	 ORDER BY ta.start_date DESC, ta.id DESC`,
	deviceAssignments: "SELECT truck_id, routemate_vehicle_id, assigned_from, assigned_until FROM eld_device_assignments",
	deviceCurrentLinks: "SELECT id, routemate_vehicle_id FROM trucks WHERE COALESCE(routemate_vehicle_id, '') <> '' ORDER BY id",
	deviceHistoryStart: "SELECT value FROM server_state WHERE key = ?",
	coordinates: "SELECT origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE load_id = ?",
	deletedLoads: "SELECT load_id FROM deleted_loads",
});
const DEVICE_HISTORY_START_KEY = "eld_device_history_started";
const SHEETS_FORMAT = 1;

class UsageError extends Error {}

function isDay(v) {
	if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
	const [y, m, d] = v.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10) === v;
}

function parseArgs(argv) {
	const out = {};
	if (!argv.length) throw new UsageError("no arguments");
	const modes = argv.filter((a) => a === "--pilot" || a === "--location");
	if (modes.length) {
		const rest = argv.filter((a) => a !== "--pilot" && a !== "--location");
		if (modes.length !== 1 || rest.length !== 2 || rest[0] !== "--db" || !rest[1] || rest[1].startsWith("--")) throw new UsageError(`${modes[0]} takes --db <app.db> and nothing else`);
		return { mode: modes[0].slice(2), db: rest[1] };
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a !== "--db" && a !== "--sheets" && a !== "--since") throw new UsageError(`unknown option ${String(a).slice(0, 40)}`);
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
		out[a.slice(2)] = v;
		i++;
	}
	if (!out.db) throw new UsageError("--db <app.db> is required");
	if (!out.sheets) throw new UsageError("--sheets <sheets.json> is required");
	if (!out.since) throw new UsageError("--since YYYY-MM-DD is required");
	if (!isDay(out.since)) throw new UsageError("--since must be a date, YYYY-MM-DD");
	return out;
}

// The main spreadsheet's Job Tracking tab: { exportedAt, headers, rows }.
function readSheets(file) {
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new UsageError("--sheets: not a LogisX replica Sheets working copy");
	}
	const books = doc && doc.format === SHEETS_FORMAT && doc.spreadsheets && typeof doc.spreadsheets === "object" ? Object.values(doc.spreadsheets) : [];
	const main = books.find((b) => b && b.role === "main");
	const tab = main && Array.isArray(main.sheets)
		? main.sheets.find((s) => s && s.properties && String(s.properties.title).toLowerCase() === "job tracking") : null;
	if (!tab || !Array.isArray(tab.values) || !Array.isArray(tab.values[0])) throw new UsageError("--sheets: not a LogisX replica Sheets working copy (no main Job Tracking tab)");
	const headers = tab.values[0].map((h) => String(h == null ? "" : h));
	const rows = tab.values.slice(1)
		.filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? "" : c).trim() !== ""))
		.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] == null ? "" : String(r[i])])));
	return { exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt.slice(0, 40) : "unknown", headers, rows };
}

function openDb(file) {
	try {
		return new Database(file, { readonly: true, fileMustExist: true });
	} catch {
		throw new UsageError("--db: cannot open that database read-only");
	}
}

const tally = (map, key) => { map[key] = (map[key] || 0) + 1; };
const list = (map, order) => {
	const keys = order || Object.keys(map).sort();
	const parts = keys.filter((k) => order || map[k]).map((k) => `${k} ${map[k] || 0}`);
	return parts.length ? parts.join(", ") : "none";
};

function report({ db, sheets, since }) {
	const hasTable = (name) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
	if (!hasTable("load_status_history")) throw new Error("the database has no load_status_history table");
	const nowMs = Date.now();
	const sinceMs = Date.parse(`${since}T00:00:00Z`);
	const { headers, rows } = sheets;

	// The live Job Tracking view, as liveJobTrackingView() keeps it: no cancelled
	// and no soft-deleted load.
	const deleted = new Set(hasTable("deleted_loads") ? db.prepare(SERVER_SQL.deletedLoads).all().map((r) => E.loadKey(r.load_id)) : []);
	const idCol = headers.find((h) => /load.?id|job.?id/i.test(h));
	const statusCol = headers.find((h) => /^(job[\s._-]?)?status$/i.test(h)) || headers.find((h) => /status/i.test(h));
	const emailCol = headers.find((h) => /^email$/i.test(h));
	const contactCol = headers.find((h) => /broker.*contact|contact.*name/i.test(h));
	const live = new Map();
	for (const row of rows) {
		const key = idCol ? E.loadKey(row[idCol]) : "";
		if (!key || deleted.has(key)) continue;
		if (statusCol && E.CANCELLED_RE.test(String(row[statusCol] || "").trim())) continue;
		if (!live.has(key)) live.set(key, row);
	}

	const truckAt = loadHaul.buildTruckAtResolver(hasTable("truck_assignments") && hasTable("trucks") ? db.prepare(SERVER_SQL.haulAssignments).all() : []);
	let startMs = null;
	try {
		const raw = hasTable("server_state") ? db.prepare(SERVER_SQL.deviceHistoryStart).get(DEVICE_HISTORY_START_KEY) : null;
		const v = raw ? JSON.parse(raw.value) : null;
		startMs = v && Number.isFinite(v.atMs) ? v.atMs : null;
	} catch {
		startMs = null;
	}
	const deviceAt = eldMiles.buildDeviceTruckResolver(hasTable("eld_device_assignments") ? db.prepare(SERVER_SQL.deviceAssignments).all() : [],
		{ startMs, currentLinks: hasTable("trucks") ? db.prepare(SERVER_SQL.deviceCurrentLinks).all() : [] });
	const coords = hasTable("load_coordinates") ? db.prepare(SERVER_SQL.coordinates) : null;
	const instructions = hasTable("load_driver_instructions") ? db.prepare("SELECT payload FROM load_driver_instructions WHERE load_key = ?") : null;
	const hasTelemetry = hasTable("routemate_telemetry");
	const pingRead = hasTelemetry ? db.prepare(V.PING_SQL) : null;
	const latestRead = hasTelemetry ? db.prepare(V.LATEST_PING_SQL) : null;
	const radiusM = tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M;

	const instructionStops = (key) => {
		if (!instructions) return null;
		try {
			const r = instructions.get(key);
			return r ? E.instructionStopCounts(JSON.parse(r.payload)) : null;
		} catch {
			return null;
		}
	};
	const verify = (ev, proj, points) => {
		const truck = truckAt.forDriverAt(proj.driverName, ev.atMs);
		const device = truck ? String(deviceAt.vehicleForTruckAt(truck.truck_id, ev.atMs) || "") : "";
		const point = V.stopPointFor(ev, points);
		const win = V.windowFor(ev.event, ev.atMs);
		const pings = device && win && pingRead ? pingRead.all(device, win.fromMs, win.toMs) : [];
		const latest = device && latestRead ? (latestRead.get(device) || {}).ms : null;
		return { ...V.verifyMilestone({ event: ev.event, eventMs: ev.atMs, point, radiusM, device, pings, latestPingMs: latest, nowMs }), truck, point };
	};
	const forbidden = (payload, row, proj) => {
		const shape = { stop: ["kind", "index"], place: ["city", "state"], eventLocal: ["time", "zone"], position: ["lat", "lng"] };
		const keysOk = Object.keys(payload).every((k) => E.PAYLOAD_KEYS.includes(k))
			&& Object.entries(shape).every(([k, allowed]) => !payload[k] || Object.keys(payload[k]).every((x) => allowed.includes(x)));
		const text = JSON.stringify(payload).toLowerCase();
		const person = [proj.driverName, emailCol ? row[emailCol] : "", contactCol ? row[contactCol] : ""]
			.map((s) => String(s || "").trim().toLowerCase()).filter((s) => s.length >= 3);
		return !keysOk || person.some((s) => text.includes(s));
	};

	const baselineId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM load_status_history WHERE changed_at < ?").get(since).id;
	const loadKeys = db.prepare("SELECT DISTINCT load_id FROM load_status_history WHERE id > ? ORDER BY load_id").all(baselineId).map((r) => r.load_id);
	const c = { chrLoads: 0, otherNineDigit: 0, chrNotNine: 0, emailBlank: 0, missing: 0, multiStop: 0, wouldSend: 0, arrivalOff: 0, arrivalOffConfirmed: 0, waiting: 0, fieldsDropped: 0, forbidden: 0 };
	const byType = {};
	const bySource = {};
	const held = {};
	const away = {};
	for (const key of loadKeys) {
		// The history's load_id is already the load key (recordStatusChange()).
		const row = live.get(key) || null;
		const proj = row ? E.projectRow(row, headers) : null;
		const verdict = E.chrLoadTest(proj);
		if (verdict.verdict === "other") {
			if (/^\d{9}$/.test(proj.loadId)) c.otherNineDigit++;
			continue;
		}
		if (verdict.verdict === "skip") {
			if (verdict.reason === "load_missing") c.missing++;
			else if (verdict.reason === "email_blank") c.emailBlank++;
			else c.chrNotNine++;
			continue;
		}
		c.chrLoads++;
		const rep = E.replayLoad(db.prepare(E.HISTORY_SQL.forLoad).all(key), { loadKey: key, baselineId });
		const multi = E.multiStopSignal({ history: rep.multiStop, instructionStops: instructionStops(key) }).multiStop;
		if (multi) c.multiStop++;
		const points = V.stopPoints(row, headers, coords ? coords.get(String(row[idCol] || "").trim()) || coords.get(key) || null : null);
		for (const ev of rep.events) {
			tally(byType, ev.event);
			tally(bySource, ev.source || "unknown");
			const res = E.isSendable(ev) && Number.isFinite(ev.atMs) ? verify(ev, proj, points) : null;
			if (res && res.verify === "away") tally(away, ev.event);
			if (ev.jump) { tally(held, "stop_skipped"); continue; }
			const pre = W.sendTimeCheck({ ev, verdict, hold: false, multiStop: multi, arrivedPickup: false });
			if (pre && pre.status === "held") { tally(held, pre.holdReason); continue; }
			if (pre && pre.skipReason === "arrival_off") {
				c.arrivalOff++;
				if (res && res.verify === "confirmed") c.arrivalOffConfirmed++;
				continue;
			}
			if (pre || !res) { tally(held, "person"); continue; }
			if (res.verify === "waiting") { c.waiting++; continue; }
			if (res.verify !== "confirmed") { tally(held, V.HOLD_FOR[res.verify]); continue; }
			const built = E.buildPayload({
				loadId: proj.loadId, event: ev.event, stop: ev.stop, eventAtMs: ev.atMs,
				address: ev.stop.kind === "pickup" ? proj.pickupAddress : proj.dropoffAddress, point: res.point, ping: res.ping, positionsAllowed: false,
				truckUnit: res.truck ? res.truck.unit : "", trailer: proj.trailer, personNames: [proj.driverName],
			});
			if (!built.payload) { tally(held, "person"); continue; }
			c.wouldSend++;
			c.fieldsDropped += built.fieldsDropped;
			if (forbidden(built.payload, row, proj)) c.forbidden++;
		}
	}

	const tel = hasTelemetry
		? db.prepare("SELECT COUNT(*) AS n, MIN(location_date_ms) AS lo, MAX(location_date_ms) AS hi FROM routemate_telemetry WHERE source = 'routemate' AND dropped_reason = '' AND location_date_ms >= ?").get(sinceMs)
		: { n: 0, lo: null, hi: null };
	const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown");
	return [
		"C.H. Robinson dry-run report: read-only, counts only",
		`  Job Tracking copy pulled at: ${sheets.exportedAt}`,
		`  Clean RouteMate pings since ${since}: ${tel.n ? `${tel.n}, from ${iso(tel.lo)} to ${iso(tel.hi)}` : "0"}`,
		"Loads with status history since then",
		`  CHR loads found: ${c.chrLoads}`,
		`  9-digit Load IDs on other brokers' domains: ${c.otherNineDigit}`,
		`  chrobinson.com loads without a 9-digit Load ID: ${c.chrNotNine}`,
		`  Email blank or unreadable: ${c.emailBlank}`,
		`  Missing from Job Tracking (cancelled, deleted or not on it): ${c.missing}`,
		`  Multi-stop loads: ${c.multiStop}`,
		"Events on CHR loads",
		`  Events by type: ${list(byType, E.MILESTONE_EVENTS)}`,
		`  Events by source: ${list(bySource)}`,
		`  Would have been sent: ${c.wouldSend}`,
		`  Not sent while "Arrived at pickup" is off: ${c.arrivalOff} (confirmed at the stop: ${c.arrivalOffConfirmed})`,
		`  Held, by reason: ${list(held)}`,
		`  Taps away from their stop, by event: ${list(away, E.MILESTONE_EVENTS.filter((e) => away[e]))}`,
		`  Still inside their window: ${c.waiting}`,
		"Payloads that would have been sent",
		`  Fields dropped by their pattern: ${c.fieldsDropped}`,
		`  Forbidden-field scan: ${c.forbidden}`,
	].join("\n");
}

// The payload rules lib/chr-events.js buildPayload() applies, checked again on
// what was stored: only the allowlisted keys, each passing its pattern.
const PAYLOAD_RULES = Object.freeze({
	loadNumber: (v) => typeof v === "string" && /^\d{9}$/.test(v),
	event: (v) => E.MILESTONE_EVENTS.includes(v) || v === "location",
	stop: (v) => Boolean(v) && typeof v === "object" && ["pickup", "delivery"].includes(v.kind),
	eventAt: (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
	eventLocal: (v) => Boolean(v) && typeof v === "object" && typeof v.time === "string" && typeof v.zone === "string",
	place: (v) => Boolean(v) && typeof v === "object" && /^[A-Z]{2}$/.test(String(v.state || "")) && (v.city === undefined || /^[A-Za-z .'-]{1,40}$/.test(v.city)),
	position: (v) => Boolean(v) && Number.isFinite(v.lat) && Number.isFinite(v.lng),
	truck: (v) => typeof v === "string" && /^[A-Za-z0-9-]{1,12}$/.test(v),
	trailer: (v) => typeof v === "string" && /^[A-Za-z0-9-]{1,12}$/.test(v),
});
function payloadFails(json) {
	let p;
	try { p = JSON.parse(json); } catch { return true; }
	if (!p || typeof p !== "object" || Array.isArray(p)) return true;
	return Object.keys(p).some((k) => !E.PAYLOAD_KEYS.includes(k) || !PAYLOAD_RULES[k] || !PAYLOAD_RULES[k](p[k]));
}

function pilotReport({ db }) {
	const hasTable = (name) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
	if (!hasTable("chr_events")) return "C.H. Robinson pilot report: read-only, counts and yes/no only\n  No CHR table: the recorder never ran on this copy.";
	const readJson = (sql, key) => {
		try { return JSON.parse((db.prepare(sql).get(key) || {}).value || "null"); } catch { return null; }
	};
	const settings = readJson("SELECT value FROM app_settings WHERE key = ?", "chr.settings") || {};
	const state = readJson("SELECT value FROM server_state WHERE key = ?", "chr.state") || {};
	const live = db.prepare("SELECT load_id, event, status, result_code, attempts, event_at, sent_at, payload_json FROM chr_events WHERE mode = 'live'").all();
	const byStatus = {};
	const byResult = {};
	for (const r of live) { tally(byStatus, r.status); if (r.result_code) tally(byResult, r.result_code); }
	const loads = new Set(live.map((r) => r.load_id));
	const pilotKey = settings.pilot && typeof settings.pilot.loadKey === "string" ? settings.pilot.loadKey : "";
	const minutes = live.filter((r) => r.status === "sent" && r.sent_at && r.event_at)
		.map((r) => (Date.parse(r.sent_at) - Date.parse(r.event_at)) / 60000).filter(Number.isFinite).sort((a, b) => a - b);
	const median = minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)] : null;
	const held = {};
	for (const r of db.prepare("SELECT hold_reason FROM chr_events WHERE status = 'held'").all()) tally(held, r.hold_reason || "unknown");
	const yes = (b) => (b ? "yes" : "no");
	return [
		"C.H. Robinson pilot report: read-only, counts and yes/no only",
		`  A pilot load is set now: ${yes(Boolean(pilotKey))}; milestones mode now: ${typeof settings.milestones === "string" ? settings.milestones : "unknown"}`,
		`  Sending went on: ${yes(Boolean(state.sendOnAt))}; paused now: ${state.pausedReason || "no"}`,
		"Live rows",
		`  Live rows: ${live.length} (${list(byStatus)}); result codes: ${list(byResult)}; attempts: ${live.reduce((n, r) => n + (Number(r.attempts) || 0), 0)}`,
		`  Loads with live rows: ${loads.size} (a one-load pilot: 1)`,
		`  Live rows on a load other than the pilot load: ${pilotKey ? live.filter((r) => r.load_id !== pilotKey).length : "no pilot set now; see the line above"}`,
		`  Payloads with a key off the allowlist or failing its pattern: ${live.filter((r) => r.payload_json && payloadFails(r.payload_json)).length}`,
		`  Minutes from event to send: ${minutes.length ? `median ${median.toFixed(1)}, longest ${minutes[minutes.length - 1].toFixed(1)} (${minutes.length} sent)` : "none sent"}`,
		`  Held rows, by reason: ${list(held)}`,
	].join("\n");
}

const LOCATION_KEYS = Object.freeze(["loadNumber", "event", "eventAt", "position"]);
const FIX_MATCH_SQL = `SELECT routemate_vehicle_id AS vid, source, dropped_reason FROM routemate_telemetry
	WHERE location_date_ms >= ? AND location_date_ms <= ? AND ROUND(latitude, 4) = ? AND ROUND(longitude, 4) = ?`;

function locationReport({ db }) {
	const hasTable = (name) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
	const head = "C.H. Robinson location report (G2): read-only, counts only";
	if (!hasTable("chr_events")) return `${head}\n  No CHR table: the recorder never ran on this copy.`;
	const rows = db.prepare("SELECT load_id, event_at, created_at, status, payload_json FROM chr_events WHERE kind = 'location'").all();
	const departures = db.prepare(`SELECT load_id, event_at FROM chr_events WHERE kind = 'milestone' AND event = 'departed_pickup' AND stop_index = 1
		AND verify = 'confirmed' AND reverted_at = '' AND status <> 'skipped_backwards'`).all();
	const finals = db.prepare("SELECT load_id, MIN(event_at) AS first_at, MIN(created_at) AS first_made FROM chr_events WHERE kind = 'milestone' AND event IN ('arrived_delivery', 'delivered') AND status <> 'skipped_backwards' GROUP BY load_id").all();
	const finalOf = new Map(finals.map((f) => [f.load_id, f]));
	const depsOf = new Map();
	for (const d of departures) depsOf.set(d.load_id, [...(depsOf.get(d.load_id) || []), Date.parse(d.event_at)]);
	const links = hasTable("eld_device_assignments") ? db.prepare(SERVER_SQL.deviceAssignments).all() : [];
	const linksOf = new Map();
	for (const l of links) linksOf.set(String(l.routemate_vehicle_id || ""), [...(linksOf.get(String(l.routemate_vehicle_id || "")) || []), l]);
	const covered = (vid, ms) => {
		const list = linksOf.get(vid);
		if (!list || !list.length) return true;
		return list.some((l) => Date.parse(l.assigned_from) <= ms && (!l.assigned_until || Date.parse(l.assigned_until) > ms));
	};
	const fixRead = hasTable("routemate_telemetry") ? db.prepare(FIX_MATCH_SQL) : null;
	const c = { outside: 0, afterFinal: 0, nonClean: 0, preLink: 0, unmatched: 0, extraKeys: 0 };
	const byStatus = {};
	const perLoad = new Map();
	for (const r of rows) {
		tally(byStatus, r.status);
		perLoad.set(r.load_id, (perLoad.get(r.load_id) || 0) + 1);
		const at = Date.parse(r.event_at);
		const deps = (depsOf.get(r.load_id) || []).filter((d) => d <= at);
		const dep = deps.length ? Math.max(...deps) : null;
		const fin = finalOf.get(r.load_id);
		if (dep === null || at > dep + 72 * 60 * 60 * 1000 || (fin && Date.parse(fin.first_at) <= at)) c.outside++;
		if (fin && r.created_at > fin.first_made) c.afterFinal++;
		let p = null;
		try { p = JSON.parse(r.payload_json); } catch { p = null; }
		if (p && Object.keys(p).some((k) => !LOCATION_KEYS.includes(k))) c.extraKeys++;
		if (!p || !p.position || !fixRead) { c.unmatched++; continue; }
		const ms = Date.parse(p.eventAt);
		const matches = fixRead.all(ms, ms + 999, p.position.lat, p.position.lng);
		const clean = matches.filter((m) => m.source === "routemate" && m.dropped_reason === "");
		if (!matches.length) c.unmatched++;
		else if (!clean.length) c.nonClean++;
		else if (!clean.some((m) => covered(String(m.vid || ""), ms))) c.preLink++;
	}
	const counts = [...perLoad.values()].sort((a, b) => a - b);
	const failedPositions = db.prepare("SELECT payload_json FROM chr_events WHERE kind = 'milestone' AND verify <> 'confirmed' AND instr(payload_json, '\"position\"') > 0").all().length;
	const noPosition = [...depsOf.keys()].filter((k) => !perLoad.has(k)).length;
	return [
		head,
		`  Location rows: ${rows.length} (${list(byStatus)}); loads with rows: ${perLoad.size}${counts.length ? `; per load: median ${counts[Math.floor((counts.length - 1) / 2)]}, most ${counts[counts.length - 1]}` : ""}`,
		`  Rows outside their load's window (must be 0): ${c.outside}`,
		`  Rows recorded after the load's first final event (must be 0): ${c.afterFinal}`,
		`  Linxup, untagged or dropped fixes used (must be 0): ${c.nonClean}`,
		`  Fixes from before their device's link (must be 0): ${c.preLink}`,
		`  Rows with no matching fix in this copy's telemetry: ${c.unmatched}`,
		`  Payloads with a key beyond the four (must be 0): ${c.extraKeys}`,
		`  Milestone positions that failed their test (must be 0): ${failedPositions}`,
		`  Loads with a confirmed departure and no position: ${noPosition}`,
	].join("\n");
}

function main() {
	let db = null;
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.mode === "pilot" || args.mode === "location") {
			db = openDb(args.db);
			process.stdout.write(`${args.mode === "pilot" ? pilotReport({ db }) : locationReport({ db })}\n`);
			return 0;
		}
		const sheets = readSheets(args.sheets);
		db = openDb(args.db);
		process.stdout.write(`${report({ db, sheets, since: args.since })}\n`);
		return 0;
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`chr-dry-run-report: ${err.message}\n${USAGE}\n`);
			return 2;
		}
		process.stderr.write(`chr-dry-run-report: ${String((err && err.message) || err).slice(0, 200)}\n`);
		return 1;
	} finally {
		if (db) db.close();
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { SERVER_SQL, DEVICE_HISTORY_START_KEY, USAGE, parseArgs, readSheets, report, payloadFails, pilotReport, locationReport };
