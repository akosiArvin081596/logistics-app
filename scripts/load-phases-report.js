#!/usr/bin/env node
// scripts/load-phases-report.js — the load phases report (plan F, PR 1): the
// evidence the POD trigger's switch-on rests on, and the counts its later steps
// wait for. Read-only. It prints, for the window of --days before --now:
//   1. phase writers by source; a manual row's session role from its own
//      actor_role, else from the update_status audit row of the same load and
//      status within 5 s
//   2. the POD-trigger backtest: each POD upload, whether it would complete its
//      load (a Driver's upload while the load's latest status row is the
//      geofence's At Receiver; one per arrival) or why not; the stamp against the
//      actual Delivered (minutes, Eastern day, Sat-Fri billing week, Fridays);
//      false completions; multi-stop shapes; withdrawn uploads; more POD files
//      after the upload that would fire; loads whose only POD came before the
//      arrival; and, for comparison, a manual arrival with a clean fix inside the
//      drop-off fence in the 15 minutes before the upload
//   3. the pay effect: for each would-fire load whose Eastern day differs from
//      the actual Delivered's and whose Drop-off Appointment is blank (or whose
//      billing week differs), the weekly invoice's paid days and amount per
//      driver and week with the tap's stamp and with the upload's, computed by
//      the invoice code lifted from server.js
//   4. the shadow claims: not read here (their table and its reader come with
//      the trigger itself)
//   5. the receiver exit against the first POD and the tap
//   6. Heading and Loading tap shapes
//   7. coordinates: loads without a usable point, the geofence's distances,
//      delivered loads with ELD data and no geofence row, unusable-address alerts
//   8. driver taps on the geofenced phases on loads with ELD data
// Then each switch-on criterion: PASS, FAIL or NOT CHECKED.
//
// The truck at a moment is the driver's truck by the dated assignments and the
// device the truck held then by the dated device links (lib/eld-miles.js).
//
// Read-only: one read-only SQLite handle (checked), which the lifted server code
// runs on too, so any write throws; Job Tracking only from a saved values.get
// (--values-json; without it the sheet checks and the pay effect read "not
// checked"); the lift reaches no sender and its fetch() refuses. Drivers print as "driver 1",
// ...; load IDs only with --ids (on the local copy only: keep that output
// outside the repo).
//
// Usage (from the app directory, with the Node pm2 runs it with):
//   node scripts/load-phases-report.js --db=app.db [--values-json=<file>] [--days=N] [--now=<instant>] [--ids] [--json] [--gate]
//   --values-json=<file>  a saved values.get of the Job Tracking tab
//   --days=N              the window, 1-120 days back from --now (default 28)
//   --now=<instant>       an ISO instant with its zone (default: now)
//   --env-file=<file>     with a copy of the database under the temp directory only
//   --ids                 print load IDs (default: "load 1", ...)
//   --json                the whole result as JSON (default: a text report)
//   --gate                exit 1 unless every switch-on criterion passes; one
//                         not checked fails it
// Exit codes: 0 done, 1 error or a failed gate, 2 refused (a missing or
// unreadable input).

"use strict";

const fs = require("fs");
const path = require("path");
const geolib = require("geolib");
const { buildLedgerWorld, parseArgs, envFor, openDb } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const appTime = require("../lib/app-time");
const eldMiles = require("../lib/eld-miles");
const tripWorkDays = require("../lib/trip-work-days");
const loadPayDays = require("../lib/load-pay-days");
const arrivalPickup = require("../lib/arrival-pickup");
const { normalizeLoadId } = require("../lib/ratecon-load");

const ROOT = path.join(__dirname, "..");
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COMPLETED_RE = /^(delivered|completed|pod received)$/i;
const CANCELLED_RE = /^(cancel|canceled|cancelled)$/i;
// The phases before the receiver: a POD then is no trigger (not_at_receiver).
const BEFORE_RECEIVER = new Set(["unassigned", "assigned", "dispatched", "heading to shipper", "at shipper", "loading", "in transit"]);
const GEOFENCED_PHASES = ["At Shipper", "In Transit", "At Receiver"];
const PHASES = ["Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver", "Delivered"];
const STAFF_ROLES = new Set(["Super Admin", "Dispatcher"]);
const STAFF_SOURCES = new Set(["dispatch", "cancel", "override"]);
const DRIVER_SOURCES = new Set(["accept", "decline", "manual", "geofence"]);
const AUDIT_MATCH_MS = 5000;
// The invoice job's sweep, and the quiet period after a load's newest POD file.
const TICK_MS = 5 * MIN_MS;
const QUIET_MS = 15 * MIN_MS;
const STAFF_CORRECTION_MS = HOUR_MS;
const WITHDRAWN_MS = HOUR_MS;
const VARIANT_B_FIX_MS = 15 * MIN_MS;
const EXIT_AFTER_DELIVERED_MS = 36 * HOUR_MS;
// The Friday batch, 19:00 on the business clock.
const BATCH_HOUR = 19;
const TABLES = ["load_status_history", "documents", "audit_trail", "trucks", "truck_assignments", "routemate_telemetry", "load_coordinates", "period_locks"];

// What the report lifts from server.js, and what it must never reach.
const LIFT_ROOTS = ["normalizeDriverName"];
const SHEET_ROOTS = [
	"normalizeDriverName", "appStamp", "jobTrackingRowsOf", "dispatchWriteBlocker", "tripDayLockCover",
	"invoiceWeekColumns", "invoiceCompletionDay", "selectInvoiceWeekLoads", "getWeekRange", "invoiceWeekPaidDays", "invoiceDayPricing",
	"liveWeeklyInvoicesForDriverWeek", "getDriverPayStructures", "truckDailyRateCandidates", "resolveDailyRate", "loadKeySet",
	"getDeletedLoadIds", "tripDayResolver", "invoiceExtraRuleLoads", "jobTrackingMonthCols", "moneySheetDate",
];
const LIFT_DENIED = ["app", "io", "server", "sheets", "getSheets", "sendEmail", "transporter", "getDrive", "KEY_FILE", "jtCacheInvalidate",
	"logAudit", "recordStatusChange", "insertDispatchNotification", "emitDispatchNotice", "emitLoadEventToDispatch", "notifyChange"];

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

const refuseFetch = () => { throw new Error("lifted code called fetch(); this report makes no network calls"); };

// A read-only handle on `dbFile`, checked to be one: every write through it throws.
function openReadOnly(dbFile) {
	return openDb({ root: ROOT, dbFile, readonly: true });
}

// normalizeDriverName() as the server has it, lifted alone (no database, no sheet).
function liftNames() {
	const lifted = closure(serverSource({ root: ROOT }), { roots: LIFT_ROOTS, provided: [], denied: LIFT_DENIED });
	return new Function("fetch", `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(refuseFetch);
}

// ── reading ──────────────────────────────────────────────────────────────────
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
// A stored time as epoch ms: SQLite's "YYYY-MM-DD HH:MM:SS" is UTC; an ISO
// instant carries its zone. NaN for anything else.
function instantMs(text) {
	const s = String(text ?? "").trim();
	if (!s) return NaN;
	if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.parse(s);
	return tripWorkDays.stampMs(s);
}
const loadKey = (id) => normalizeLoadId(id);

function readHistory(db) {
	const cols = columnsOf(db, "load_status_history");
	const opt = (c) => (cols.has(c) ? c : `'' AS ${c}`);
	const rows = db.prepare(`SELECT id, load_id, new_status, source, actor, ${opt("reason")}, ${opt("actor_role")}, changed_at
		FROM load_status_history ORDER BY changed_at, id`).all();
	const byLoad = new Map();
	for (const r of rows) {
		const key = loadKey(r.load_id);
		const ms = instantMs(r.changed_at);
		if (!key || !Number.isFinite(ms)) continue;
		const row = {
			id: r.id, key, status: String(r.new_status || "").trim(), source: String(r.source || "").trim().toLowerCase(),
			actor: String(r.actor || "").trim(), reason: String(r.reason || ""), actorRole: String(r.actor_role || "").trim(), ms,
		};
		row.lc = row.status.toLowerCase();
		if (!byLoad.has(key)) byLoad.set(key, []);
		byLoad.get(key).push(row);
	}
	for (const list of byLoad.values()) list.sort((a, b) => a.ms - b.ms || a.id - b.id);
	return byLoad;
}

function readPods(db) {
	const cols = columnsOf(db, "documents");
	const opt = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
	const rows = db.prepare(`SELECT id, load_id, driver, uploaded_at, ${opt("deleted_at")}, ${opt("uploaded_by_role")}
		FROM documents WHERE UPPER(TRIM(type)) = 'POD' ORDER BY uploaded_at, id`).all();
	const byLoad = new Map();
	const all = [];
	for (const r of rows) {
		const key = loadKey(r.load_id);
		const ms = instantMs(r.uploaded_at);
		if (!key || !Number.isFinite(ms)) continue;
		const doc = {
			id: r.id, key, driver: String(r.driver || "").trim(), ms,
			deletedMs: r.deleted_at ? instantMs(r.deleted_at) : NaN,
			role: r.uploaded_by_role ? String(r.uploaded_by_role).trim() : null,
		};
		all.push(doc);
		if (!byLoad.has(key)) byLoad.set(key, []);
		byLoad.get(key).push(doc);
	}
	all.sort((a, b) => a.ms - b.ms || a.id - b.id);
	for (const list of byLoad.values()) list.sort((a, b) => a.ms - b.ms || a.id - b.id);
	return { all, byLoad };
}

// The tap route's audit rows, by load: { ms, role, status }.
function readAudit(db) {
	const byLoad = new Map();
	for (const r of db.prepare("SELECT id, timestamp, role, entity_id, details FROM audit_trail WHERE action = 'update_status' AND entity = 'load' ORDER BY id").all()) {
		const key = loadKey(r.entity_id);
		const ms = instantMs(r.timestamp);
		if (!key || !Number.isFinite(ms)) continue;
		const m = /Status changed to "([^"]*)"/.exec(String(r.details || ""));
		if (!byLoad.has(key)) byLoad.set(key, []);
		byLoad.get(key).push({ id: r.id, ms, role: String(r.role || "").trim(), status: m ? m[1].trim().toLowerCase() : null, used: false });
	}
	return byLoad;
}

// Each manual row's session role: its own actor_role (the arrival recorder),
// else the nearest unused audit row of the same load and status within 5 s.
function attachRoles(history, audit) {
	for (const [key, rows] of history) {
		const candidates = audit.get(key) || [];
		for (const r of rows) {
			if (r.source !== "manual") continue;
			if (r.actorRole) { r.role = r.actorRole; r.roleFrom = "actor_role"; continue; }
			let best = null;
			for (const a of candidates) {
				if (a.used || Math.abs(a.ms - r.ms) > AUDIT_MATCH_MS || (a.status !== null && a.status !== r.lc)) continue;
				if (!best || Math.abs(a.ms - r.ms) < Math.abs(best.ms - r.ms)) best = a;
			}
			if (best) { best.used = true; r.role = best.role; r.roleFrom = "audit"; } else { r.role = "unmatched"; r.roleFrom = "none"; }
		}
	}
}

// Who wrote a row: "geofence", the session role of a manual row, or the source.
const writerOf = (r) => (r.source === "geofence" ? "geofence" : r.source === "manual" ? r.role : r.source);
const isStaffRow = (r) => STAFF_SOURCES.has(r.source) || (r.source === "manual" && STAFF_ROLES.has(r.role));

function readCoordinates(db) {
	const out = new Map();
	const point = (lat, lng) => {
		if (lat === null || lng === null) return null;
		const la = Number(lat);
		const ln = Number(lng);
		return !Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0) ? null : { latitude: la, longitude: ln };
	};
	for (const r of db.prepare("SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates").all()) {
		const key = loadKey(r.load_id);
		if (key) out.set(key, { origin: point(r.origin_lat, r.origin_lng), dest: point(r.dest_lat, r.dest_lng) });
	}
	return out;
}

// The truck a driver held at an instant (dated truck assignments), the device
// that truck held then (dated device links), and that device's clean fixes
// taken while it was on that truck.
function buildTrucks(db, normalize) {
	const trucks = db.prepare("SELECT id, unit_number, routemate_vehicle_id FROM trucks").all();
	const driverAt = eldMiles.buildDriverAtResolver(db.prepare("SELECT truck_id, driver_name, start_date, end_date FROM truck_assignments").all());
	const links = hasTable(db, "eld_device_assignments")
		? db.prepare("SELECT truck_id, routemate_vehicle_id, assigned_from, assigned_until FROM eld_device_assignments").all() : [];
	let startMs = null;
	if (hasTable(db, "server_state")) {
		try {
			const row = db.prepare("SELECT value FROM server_state WHERE key = 'eld_device_history_started'").get();
			startMs = row ? JSON.parse(row.value).atMs : null;
		} catch { startMs = null; }
	}
	const device = eldMiles.buildDeviceTruckResolver(links, { startMs, currentLinks: trucks.filter((t) => String(t.routemate_vehicle_id || "").trim()) });
	const unitOf = new Map(trucks.map((t) => [t.id, String(t.unit_number || "").trim()]));
	const fixStmt = db.prepare(`SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, speed FROM routemate_telemetry
		WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms >= ? AND location_date_ms <= ? ORDER BY location_date_ms`);
	const truckAt = (driverNorm, ms) => {
		if (!driverNorm || !Number.isFinite(ms)) return null;
		for (const t of trucks) if (normalize(driverAt.atInstant(t.id, ms)) === driverNorm) return t.id;
		return null;
	};
	const vehicleAt = (driverNorm, ms) => {
		const truckId = truckAt(driverNorm, ms);
		const vid = truckId === null ? "" : device.vehicleForTruckAt(truckId, ms);
		return { truckId, unit: truckId === null ? "" : unitOf.get(truckId) || "", vid };
	};
	const fixes = (v, fromMs, toMs) => (v && v.vid
		? fixStmt.all(v.vid, Math.floor(fromMs), Math.ceil(toMs)).filter((f) => device.truckForVehicleAt(v.vid, f.ms) === v.truckId)
		: []);
	return { vehicleAt, fixes };
}

// ── days, weeks and labels ───────────────────────────────────────────────────
const weekEndOf = (day) => {
	const ms = Date.parse(`${day}T12:00:00Z`);
	const back = (new Date(ms).getUTCDay() + 1) % 7;
	return new Date(ms + (6 - back) * DAY_MS).toISOString().slice(0, 10);
};
const isFriday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const inc = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const minutes = (ms) => Math.round(ms / 6000) / 10;
// The label of the first edge `x` is at or under, else the last label.
function bucket(x, edges) {
	for (const [label, max] of edges) if (x <= max) return label;
	return edges[edges.length - 1][0];
}
const TAP_EDGES = [["<=5 min", 5 * MIN_MS], ["5-60 min", HOUR_MS], ["1-6 h", 6 * HOUR_MS], ["6-24 h", DAY_MS], [">24 h", Infinity]];
const FILE_EDGES = [["<=1 min", MIN_MS], ["1-5 min", 5 * MIN_MS], ["5-15 min", QUIET_MS], [">15 min", Infinity]];
const DISTANCE_EDGES = [["<=250 m", 250], ["250-1000 m", 1000], ["1-2 km", 2000], [">2 km", Infinity]];
const NEXT_ROW_EDGES = [["<=1 h", HOUR_MS], ["1-6 h", 6 * HOUR_MS], ["6-24 h", DAY_MS], [">24 h", Infinity]];

// "load 1", "driver 1", ... in order of first mention; `shown` prints the key
// itself (--ids).
function labeller(prefix, shown = false) {
	const seen = new Map();
	return (key) => {
		if (!key) return "";
		if (shown) return key;
		if (!seen.has(key)) seen.set(key, `${prefix} ${seen.size + 1}`);
		return seen.get(key);
	};
}
const hourIn = (ms, zone) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)));
// Every count map (an object of numbers) with its keys in order, so two runs on
// the same data print the same bytes.
function tidy(x) {
	if (Array.isArray(x)) return x.map(tidy);
	if (!x || typeof x !== "object") return x;
	const entries = Object.entries(x);
	if (entries.length && entries.every(([, v]) => typeof v === "number")) return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return Object.fromEntries(entries.map(([k, v]) => [k, tidy(v)]));
}

// ── the report ───────────────────────────────────────────────────────────────
function buildReport(db, { env, zone, nowMs, days, labels, sheet, names }) {
	const normalize = names.normalizeDriverName;
	const fromMs = nowMs - days * DAY_MS;
	const inWindow = (ms) => ms >= fromMs && ms <= nowMs;
	const dayOf = (ms) => tripWorkDays.dayInZone(ms, zone && appTime.businessZoneAt(ms, zone));
	const radiusM = tripWorkDays.geofenceRadiusFromEnv(env);
	const history = readHistory(db);
	const pods = readPods(db);
	attachRoles(history, readAudit(db));
	const coords = readCoordinates(db);
	const trucks = buildTrucks(db, normalize);
	const labelOf = labels.load;
	const rowsOf = (key) => history.get(key) || [];
	const driverOf = (key) => {
		const rows = rowsOf(key);
		for (let i = rows.length - 1; i >= 0; i--) if (DRIVER_SOURCES.has(rows[i].source) && rows[i].actor) return normalize(rows[i].actor);
		const docs = pods.byLoad.get(key) || [];
		return docs.length ? normalize(docs[docs.length - 1].driver) : "";
	};
	const firstCompleted = (key) => rowsOf(key).find((r) => COMPLETED_RE.test(r.status)) || null;

	// 1. Phase writers.
	const writers = { byPhase: {}, manualRows: 0, roleFrom: { actor_role: 0, audit: 0, none: 0 } };
	for (const rows of history.values()) {
		for (const r of rows) {
			if (!inWindow(r.ms)) continue;
			writers.byPhase[r.status] = writers.byPhase[r.status] || {};
			inc(writers.byPhase[r.status], writerOf(r));
			if (r.source === "manual") { writers.manualRows += 1; inc(writers.roleFrom, r.roleFrom); }
		}
	}

	// 2. The backtest, one decision per POD upload in the window.
	const firedRuns = new Map();
	const decisions = [];
	const sheetOutcomes = {};
	let closedSince = 0;
	let cancelledSince = 0;
	for (const doc of pods.all) {
		if (!inWindow(doc.ms)) continue;
		const rows = rowsOf(doc.key);
		let idx = -1;
		for (let i = 0; i < rows.length; i++) if (rows[i].ms <= doc.ms) idx = i;
		const latest = idx >= 0 ? rows[idx] : null;
		let outcome;
		if (doc.role && doc.role !== "Driver") outcome = "staff_upload";
		else if (!latest || BEFORE_RECEIVER.has(latest.lc)) outcome = "not_at_receiver";
		else if (COMPLETED_RE.test(latest.status)) outcome = "already_completed";
		else if (latest.lc === "at receiver" && latest.source === "geofence") outcome = firedRuns.has(latest.id) ? "already_fired" : "candidate";
		else outcome = "receiver_not_gps";
		if (outcome === "candidate") {
			const cancelledAfter = rows.slice(idx + 1).some((r) => r.source === "cancel" || CANCELLED_RE.test(r.status));
			const verdict = sheet ? sheet.half(doc, { cancelledAfter }) : { outcome: "would_fire" };
			outcome = verdict.outcome;
			if (verdict.closedSince) closedSince += 1;
			if (verdict.cancelledSince) cancelledSince += 1;
			if (outcome !== "would_fire") inc(sheetOutcomes, outcome);
		}
		const d = { doc, latest, idx, outcome };
		if (outcome === "would_fire") firedRuns.set(latest.id, d);
		decisions.push(d);
	}
	const outcomes = {};
	for (const d of decisions) inc(outcomes, d.outcome);

	// What happened after an upload: the next completed row, and how it was reached.
	const followOf = (d) => {
		const after = rowsOf(d.doc.key).slice(d.idx + 1);
		const dIdx = after.findIndex((r) => COMPLETED_RE.test(r.status));
		const delivered = dIdx >= 0 ? after[dIdx] : null;
		const between = dIdx >= 0 ? after.slice(0, dIdx) : after;
		let follow;
		if (!delivered) follow = "never_delivered";
		else if (between.some((r) => r.lc === "at receiver")) follow = "later_arrival";
		else if (!between.length) follow = "delivered";
		else if (between.every(isStaffRow) && delivered.ms - between[0].ms <= STAFF_CORRECTION_MS) follow = "staff_correction";
		else follow = "other_status_between";
		return { after, delivered, follow };
	};

	// The would-fire runs against what happened next.
	const fires = [];
	for (const d of decisions) {
		if (d.outcome !== "would_fire") continue;
		const { after, delivered, follow } = followOf(d);
		const docs = pods.byLoad.get(d.doc.key) || [];
		// The proof's files end at the Delivered, or at a later arrival (another stop's proof).
		const nextArrival = after.find((r) => r.lc === "at receiver");
		const endMs = Math.min(delivered ? delivered.ms : nowMs, nextArrival ? nextArrival.ms : Infinity);
		const later = docs.filter((x) => x.id !== d.doc.id && x.ms >= d.doc.ms && x.ms < endMs);
		const chain = [d.doc.ms, ...later.map((x) => x.ms)];
		let maxStep = 0;
		for (let i = 1; i < chain.length; i++) maxStep = Math.max(maxStep, chain[i] - chain[i - 1]);
		const afterTap = delivered ? docs.filter((x) => x.ms > delivered.ms && x.ms <= delivered.ms + DAY_MS).length : 0;
		const deleted = Number.isFinite(d.doc.deletedMs);
		const withdrawn = deleted && (d.doc.deletedMs <= d.doc.ms + WITHDRAWN_MS || (!!delivered && d.doc.deletedMs < delivered.ms));
		const uDay = dayOf(d.doc.ms);
		const f = {
			key: d.doc.key, uploadMs: d.doc.ms, uploadDay: uDay, role: d.doc.role, follow,
			deliveredMs: delivered ? delivered.ms : null, deliveredDay: delivered ? dayOf(delivered.ms) : null,
			gapMs: delivered ? delivered.ms - d.doc.ms : null,
			sameDay: delivered ? dayOf(delivered.ms) === uDay : null,
			sameWeek: delivered ? weekEndOf(dayOf(delivered.ms)) === weekEndOf(uDay) : null,
			friday: isFriday(uDay),
			afterBatch: isFriday(uDay) && hourIn(d.doc.ms, zone) >= BATCH_HOUR,
			laterFiles: later.map((x) => x.ms - d.doc.ms), maxStepMs: maxStep, podsAfterTap: afterTap,
			deleted, withdrawn,
		};
		fires.push(f);
	}
	for (const f of fires) labelOf(f.key);
	const delivered = fires.filter((f) => f.deliveredMs !== null);
	const falseCompletions = fires.filter((f) => f.follow === "never_delivered" || f.follow === "later_arrival" || f.follow === "other_status_between");
	// Refusals the sheet as it reads now may not have made at the upload (a row
	// removed since, a duplicate completed since): shown beside criterion 1.
	const notJudged = decisions.filter((d) => d.outcome === "not_on_sheet" || d.outcome === "ambiguous")
		.map((d) => ({ load: labelOf(d.doc.key), upload: appDayTime(d.doc.ms, zone), outcome: d.outcome, follow: followOf(d).follow }));
	const tapBuckets = {};
	for (const f of delivered) inc(tapBuckets, bucket(f.gapMs, TAP_EDGES));
	const fileBuckets = {};
	for (const f of fires) for (const g of f.laterFiles) inc(fileBuckets, bucket(g, FILE_EDGES));
	const multiFile = fires.filter((f) => f.laterFiles.length);

	// Loads delivered in the window, and the share the trigger would complete.
	const deliveredLoads = [...history.keys()].filter((k) => { const c = firstCompleted(k); return c && inWindow(c.ms); });
	const firedKeys = new Set(fires.map((f) => f.key));

	// Multi-stop shapes: an At Receiver followed by an earlier phase.
	const multiStop = { loads: 0, podDuring: 0, podDuringWouldFire: 0, list: [] };
	for (const [key, rows] of history) {
		let hit = false;
		for (let i = 0; i + 1 < rows.length; i++) {
			const r = rows[i];
			if (r.lc !== "at receiver" || !inWindow(r.ms) || !BEFORE_RECEIVER.has(rows[i + 1].lc)) continue;
			hit = true;
			const during = decisions.filter((d) => d.doc.key === key && d.doc.ms >= r.ms && d.doc.ms < rows[i + 1].ms);
			if (during.length) multiStop.podDuring += 1;
			if (during.some((d) => d.outcome === "would_fire")) multiStop.podDuringWouldFire += 1;
		}
		if (hit) { multiStop.loads += 1; multiStop.list.push(labelOf(key)); }
	}

	// L7: a delivered load whose only live POD came before its geofence arrival.
	const onlyBefore = { loads: 0, of: 0 };
	for (const key of deliveredLoads) {
		const rows = rowsOf(key);
		const dIdx = rows.findIndex((r) => COMPLETED_RE.test(r.status));
		let ar = null;
		for (let i = dIdx - 1; i >= 0; i--) if (rows[i].lc === "at receiver") { ar = rows[i]; break; }
		if (!ar || ar.source !== "geofence") continue;
		onlyBefore.of += 1;
		const live = (pods.byLoad.get(key) || []).filter((x) => !Number.isFinite(x.deletedMs));
		if (live.some((x) => x.ms < ar.ms) && !live.some((x) => x.ms >= ar.ms && x.ms <= rows[dIdx].ms)) onlyBefore.loads += 1;
	}

	// F7 (b), for comparison: a manual arrival and a clean fix inside the drop-off
	// fence in the 15 minutes before the upload.
	const variantB = { uploads: 0, loads: 0, sameDay: 0, sameWeek: 0, within60: 0, notChecked: 0 };
	const bRuns = new Set();
	const bLoads = new Set();
	for (const d of decisions) {
		if (d.outcome !== "receiver_not_gps" || !d.latest || d.latest.lc !== "at receiver" || d.latest.source !== "manual" || bRuns.has(d.latest.id)) continue;
		const dest = (coords.get(d.doc.key) || {}).dest;
		const v = trucks.vehicleAt(normalize(d.doc.driver) || driverOf(d.doc.key), d.doc.ms);
		if (!dest || !v.vid) { variantB.notChecked += 1; continue; }
		const inside = trucks.fixes(v, d.doc.ms - VARIANT_B_FIX_MS, d.doc.ms).some((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
			&& geolib.isPointWithinRadius({ latitude: Number(p.lat), longitude: Number(p.lng) }, dest, radiusM));
		if (!inside) continue;
		bRuns.add(d.latest.id);
		bLoads.add(d.doc.key);
		variantB.uploads += 1;
		const next = rowsOf(d.doc.key).slice(d.idx + 1).find((r) => COMPLETED_RE.test(r.status));
		if (next) {
			if (dayOf(next.ms) === dayOf(d.doc.ms)) variantB.sameDay += 1;
			if (weekEndOf(dayOf(next.ms)) === weekEndOf(dayOf(d.doc.ms))) variantB.sameWeek += 1;
			if (next.ms - d.doc.ms <= HOUR_MS) variantB.within60 += 1;
		}
	}
	variantB.loads = bLoads.size;

	// 5. The receiver exit: the first fix moving outside the drop-off fence after
	// the geofence's arrival (the trip rule's reading).
	const exit = { loads: 0, notChecked: 0, seen: 0, beforeFirstPod: 0, withinHourOfPod: 0, laterThanHour: 0, beforeTap: 0, dayDiffers: 0, weekDiffers: 0 };
	for (const key of deliveredLoads) {
		const rows = rowsOf(key);
		const dIdx = rows.findIndex((r) => COMPLETED_RE.test(r.status));
		let ar = null;
		for (let i = dIdx - 1; i >= 0; i--) if (rows[i].lc === "at receiver") { ar = rows[i]; break; }
		if (!ar || ar.source !== "geofence") continue;
		exit.loads += 1;
		const dest = (coords.get(key) || {}).dest;
		const v = trucks.vehicleAt(driverOf(key), ar.ms);
		const tap = rows[dIdx];
		const list = dest && v.vid ? trucks.fixes(v, ar.ms + 1, tap.ms + EXIT_AFTER_DELIVERED_MS) : [];
		if (!list.length) { exit.notChecked += 1; continue; }
		const leave = list.find((p) => (Number(p.speed) || 0) > tripWorkDays.DRIVING_MPS && !geolib.isPointWithinRadius({ latitude: Number(p.lat), longitude: Number(p.lng) }, dest, radiusM));
		if (!leave) continue;
		exit.seen += 1;
		const pod = (pods.byLoad.get(key) || []).find((x) => x.ms >= ar.ms);
		if (pod && leave.ms < pod.ms) exit.beforeFirstPod += 1;
		else if (pod && leave.ms - pod.ms <= HOUR_MS) exit.withinHourOfPod += 1;
		else if (pod) exit.laterThanHour += 1;
		if (leave.ms < tap.ms) exit.beforeTap += 1;
		if (dayOf(leave.ms) !== dayOf(tap.ms)) exit.dayDiffers += 1;
		if (weekEndOf(dayOf(leave.ms)) !== weekEndOf(dayOf(tap.ms))) exit.weekDiffers += 1;
	}

	// 6. Heading and Loading taps.
	const heading = { loads: 0, sameDay: 0, nextDay: 0, later: 0, none: 0, withinHour: 0, writers: {} };
	const loading = { rows: 0, toNext: {}, daysSpanned: {}, writers: {} };
	for (const rows of history.values()) {
		const h = rows.find((r) => r.lc === "heading to shipper" && inWindow(r.ms));
		if (h) {
			heading.loads += 1;
			inc(heading.writers, writerOf(h));
			const arrival = rows.find((r) => r.ms >= h.ms && r.id !== h.id && ["at shipper", "loading", "in transit"].includes(r.lc));
			if (!arrival) heading.none += 1;
			else {
				const gap = Math.round((Date.parse(`${dayOf(arrival.ms)}T12:00:00Z`) - Date.parse(`${dayOf(h.ms)}T12:00:00Z`)) / DAY_MS);
				if (gap <= 0) heading.sameDay += 1; else if (gap === 1) heading.nextDay += 1; else heading.later += 1;
				if (arrival.ms - h.ms <= HOUR_MS) heading.withinHour += 1;
			}
		}
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			if (r.lc !== "loading" || !inWindow(r.ms)) continue;
			loading.rows += 1;
			inc(loading.writers, writerOf(r));
			const next = rows[i + 1];
			if (!next) { inc(loading.toNext, "no next row"); continue; }
			inc(loading.toNext, bucket(next.ms - r.ms, NEXT_ROW_EDGES));
			const span = Math.round((Date.parse(`${dayOf(next.ms)}T12:00:00Z`) - Date.parse(`${dayOf(r.ms)}T12:00:00Z`)) / DAY_MS);
			inc(loading.daysSpanned, span >= 2 ? "2+" : String(span));
		}
	}

	// ELD data on a load: a clean fix from the driver's truck between its first
	// and last status rows.
	const eldMemo = new Map();
	const hasEld = (key) => {
		if (!eldMemo.has(key)) {
			const rows = rowsOf(key);
			const v = rows.length ? trucks.vehicleAt(driverOf(key), rows[rows.length - 1].ms) : { vid: "" };
			eldMemo.set(key, !!v.vid && trucks.fixes(v, rows[0].ms, rows[rows.length - 1].ms).length > 0);
		}
		return eldMemo.get(key);
	};

	// 7. Coordinates.
	const active = [...history.keys()].filter((k) => rowsOf(k).some((r) => inWindow(r.ms)));
	const coordinates = { activeLoads: active.length, bothPoints: 0, noOrigin: 0, noDestination: 0, noRow: 0, withoutPointByMonth: {}, distances: { "At Shipper": {}, "At Receiver": {} }, maxM: { "At Shipper": 0, "At Receiver": 0 } };
	for (const key of active) {
		const c = coords.get(key);
		if (!c) coordinates.noRow += 1;
		else if (c.origin && c.dest) coordinates.bothPoints += 1;
		else { if (!c.origin) coordinates.noOrigin += 1; if (!c.dest) coordinates.noDestination += 1; }
		if (!c || !c.origin || !c.dest) inc(coordinates.withoutPointByMonth, dayOf(rowsOf(key).find((r) => inWindow(r.ms)).ms).slice(0, 7));
	}
	for (const rows of history.values()) {
		for (const r of rows) {
			if (r.source !== "geofence" || !inWindow(r.ms) || !coordinates.distances[r.status]) continue;
			const m = /(\d+(?:\.\d+)?) m from the mapped/.exec(r.reason);
			if (!m) { inc(coordinates.distances[r.status], "not stated"); continue; }
			const meters = Number(m[1]);
			inc(coordinates.distances[r.status], bucket(meters, DISTANCE_EDGES));
			coordinates.maxM[r.status] = Math.max(coordinates.maxM[r.status], meters);
		}
	}
	const noGeofence = deliveredLoads.filter((k) => !rowsOf(k).some((r) => r.source === "geofence"));
	coordinates.deliveredNoGeofence = { loads: noGeofence.length, withEld: noGeofence.filter(hasEld).length };
	const alerts = { inWindow: 0, becameLoads: 0, delivered: 0, withBothPoints: 0, geofenceAtShipper: 0, geofenceAtReceiver: 0 };
	if (hasTable(db, "ratecon_extract_alerts")) {
		for (const a of db.prepare("SELECT load_id, first_seen FROM ratecon_extract_alerts").all()) {
			if (!inWindow(instantMs(a.first_seen))) continue;
			alerts.inWindow += 1;
			const key = loadKey(a.load_id);
			const rows = rowsOf(key);
			if (!rows.length) continue;
			alerts.becameLoads += 1;
			if (rows.some((r) => COMPLETED_RE.test(r.status))) alerts.delivered += 1;
			const c = coords.get(key);
			if (c && c.origin && c.dest) alerts.withBothPoints += 1;
			if (rows.some((r) => r.source === "geofence" && r.lc === "at shipper")) alerts.geofenceAtShipper += 1;
			if (rows.some((r) => r.source === "geofence" && r.lc === "at receiver")) alerts.geofenceAtReceiver += 1;
		}
	}
	coordinates.alerts = alerts;

	// 8. Driver taps on loads with ELD data.
	const taps = {};
	for (const [key, rows] of history) {
		for (const r of rows) {
			if (r.source !== "manual" || r.role !== "Driver" || !inWindow(r.ms) || !PHASES.includes(r.status)) continue;
			taps[r.status] = taps[r.status] || { taps: 0, onEldLoads: 0 };
			taps[r.status].taps += 1;
			if (hasEld(key)) taps[r.status].onEldLoads += 1;
		}
	}
	const geofencedTaps = GEOFENCED_PHASES.reduce((n, p) => n + ((taps[p] && taps[p].onEldLoads) || 0), 0);

	// The Truck cell against the truck the dated histories give, per active load.
	let truckCells = null;
	if (sheet) {
		truckCells = { agree: 0, disagree: 0, noCell: 0, noTruck: 0 };
		for (const key of active) {
			const rows = rowsOf(key);
			const v = trucks.vehicleAt(driverOf(key), rows[rows.length - 1].ms);
			const cell = sheet.truckCell(key);
			if (!v.unit) truckCells.noTruck += 1;
			else if (!cell) truckCells.noCell += 1;
			else if (cell.toLowerCase() === v.unit.toLowerCase()) truckCells.agree += 1;
			else truckCells.disagree += 1;
		}
	}

	// 3. The pay effect: the loads whose stamp would move to another day.
	const payLoads = fires.filter((f) => f.deliveredMs !== null && !f.sameDay);
	const pay = sheet ? sheet.payEffect(payLoads) : null;

	// The switch-on criteria (plan §3.4) on the backtest.
	const n = delivered.length;
	const sameWeek = delivered.filter((f) => f.sameWeek).length;
	const sameDay = delivered.filter((f) => f.sameDay).length;
	const within60 = delivered.filter((f) => f.gapMs <= HOUR_MS).length;
	const withdrawn = fires.filter((f) => f.withdrawn);
	const unrecordedRole = fires.filter((f) => !f.role).length;
	const overQuiet = fires.filter((f) => f.laterFiles.some((g) => g > QUIET_MS));
	const verdict = (ok, checked = true) => (!checked ? "NOT CHECKED" : ok ? "PASS" : "FAIL");
	const criteria = [
		{ n: 1, what: "no false completion (a staff correction ending in Delivered within 1 h is listed, not failed)", verdict: verdict(!falseCompletions.length),
			detail: `${falseCompletions.length} false, ${fires.filter((f) => f.follow === "staff_correction").length} staff correction(s), of ${fires.length}`
				+ (notJudged.length ? `; not judged: ${notJudged.length} upload(s) the sheet half refused as not on the sheet or ambiguous (as it reads now), whose follow-up reads ${notJudged.map((x) => `${x.load} ${x.follow}`).join(", ")}` : "") },
		{ n: 2, what: "the same billing week as the actual Delivered on 100%", verdict: verdict(sameWeek === n, n > 0), detail: `${sameWeek} of ${n}` },
		{ n: 3, what: "the same Eastern day on at least 95%", verdict: verdict(n > 0 && sameDay / n >= 0.95, n > 0), detail: `${sameDay} of ${n} (${pct(sameDay, n)}%)` },
		{ n: 4, what: "the actual Delivered within 60 minutes on at least 90%", verdict: verdict(n > 0 && within60 / n >= 0.9, n > 0), detail: `${within60} of ${n} (${pct(within60, n)}%)` },
		{ n: 5, what: "none on a staff upload, a closed month, an ambiguous row or a withdrawn upload",
			verdict: withdrawn.length ? "FAIL" : verdict(true, !!sheet && !unrecordedRole),
			detail: `${withdrawn.length} withdrawn; uploader role not recorded on ${unrecordedRole}; the sheet half ${sheet ? "checked as the sheet reads now" : "not checked (no --values-json)"}` },
		{ n: 6, what: "the live claims agree with this replay on at least 95%, errors at most 2%", verdict: "NOT CHECKED", detail: "no claims are read here: the trigger's PR adds the claims table and its reader" },
		{ n: 7, what: "no further POD file more than 15 minutes after the upload that would fire, before the actual Delivered", verdict: verdict(!overQuiet.length), detail: `${overQuiet.length} load(s) over; largest gap between consecutive files ${minutes(Math.max(0, ...fires.map((f) => f.maxStepMs)))} min` },
	];
	if (!sheet) criteria.push({ n: "pay", what: "the pay effect (M2) is computed", verdict: "NOT CHECKED", detail: "needs --values-json" });
	else if (pay.planA.notModelled.length) {
		criteria.push({ n: "pay", what: "the pay effect (M2) is computed", verdict: "NOT CHECKED", detail: `plan A's arrival rule is on and ${pay.planA.notModelled.length} load(s) are not modelled` });
	}
	const fridays = [];
	for (let d = dayOf(fromMs); d <= dayOf(nowMs); d = new Date(Date.parse(`${d}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
		const [y, m, dd] = d.split("-").map(Number);
		const batch = appTime.wallClockToMs(zone, y, m, dd, BATCH_HOUR, 0, 0);
		if (isFriday(d) && batch >= fromMs && batch <= nowMs) fridays.push(d);
	}
	const preconditions = [
		{ what: "at least 14 days", verdict: verdict(days >= 14), detail: `${days} days` },
		{ what: "at least 2 Friday batches", verdict: verdict(fridays.length >= 2), detail: `${fridays.length}` },
		{ what: "at least 30 would-fire loads", verdict: verdict(firedKeys.size >= 30), detail: `${firedKeys.size}` },
	];
	const s2 = criteria.filter((c) => c.n >= 1 && c.n <= 4).every((c) => c.verdict === "PASS") ? "PASS" : "FAIL";

	const fireRow = (f) => ({
		load: labelOf(f.key), upload: appDayTime(f.uploadMs, zone), follow: f.follow,
		minutesToDelivered: f.gapMs === null ? null : minutes(f.gapMs), sameDay: f.sameDay, sameWeek: f.sameWeek,
		friday: f.friday, afterBatch: f.afterBatch, laterFilesMin: f.laterFiles.map(minutes), withdrawn: f.withdrawn,
	});
	return {
		generatedAt: new Date().toISOString(),
		window: { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), days, zone, radiusM },
		sheet: sheet ? "read from --values-json (as it reads now, not at each upload)" : "not checked (no --values-json)",
		writers,
		backtest: {
			podUploads: decisions.length, outcomes, sheetOutcomes, closedSinceUpload: closedSince, cancelledSinceUpload: cancelledSince, notJudged,
			loadsDelivered: deliveredLoads.length, loadsWouldFire: deliveredLoads.filter((k) => firedKeys.has(k)).length,
			wouldFire: fires.length, uploaderRoleNotRecorded: unrecordedRole,
			tap: tapBuckets, sameDay, sameWeek, delivered: n,
			fridays: { fired: fires.filter((f) => f.friday).length, afterBatch: fires.filter((f) => f.afterBatch).length, weekChanges: delivered.filter((f) => !f.sameWeek).length },
			falseCompletions: falseCompletions.map(fireRow), staffCorrections: fires.filter((f) => f.follow === "staff_correction").map(fireRow),
			multiStop, withdrawn: withdrawn.map(fireRow), deletedLater: fires.filter((f) => f.deleted && !f.withdrawn).length,
			laterFiles: { loads: multiFile.length, files: multiFile.reduce((c, f) => c + f.laterFiles.length, 0), byGap: fileBuckets, overQuiet: overQuiet.map(fireRow), maxConsecutiveMin: minutes(Math.max(0, ...fires.map((f) => f.maxStepMs))), podsAfterTapIn24h: fires.filter((f) => f.podsAfterTap).length },
			onlyPodBeforeArrival: onlyBefore,
			variantB,
			loads: fires.map(fireRow),
		},
		pay,
		claims: "not read: the trigger's PR adds the claims table and its reader",
		receiverExit: exit,
		heading, loading,
		coordinates,
		taps: { byPhase: taps, geofencedOnEldLoads: geofencedTaps },
		truckCells,
		criteria, preconditions, s2, fridays,
		gate: [...criteria, ...preconditions].every((c) => c.verdict === "PASS") ? "PASS" : "FAIL",
	};
}

// "YYYY-MM-DD HH:MM" on the business clock.
function appDayTime(ms, zone) {
	const p = {};
	for (const x of new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) p[x.type] = x.value;
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// ── the sheet half and the pay effect (--values-json) ────────────────────────
// The server's own code, lifted over the read-only handle: the period guard the
// tap passes, the stamp it writes, and the weekly invoice's days and pricing.
function sheetSide({ api, db, env, values, driverLabel, loadLabel }) {
	const { headers, data } = api.jobTrackingRowsOf(values);
	const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h)) || null;
	const driverCol = headers.find((h) => /driver/i.test(h)) || null;
	const statusCol = headers.find((h) => /status/i.test(h)) || null;
	const dateCol = headers.find((h) => /status.*update.*date|update.*date/i.test(h)) || null;
	const completionCol = headers.find((h) => /completion.*date/i.test(h)) || null;
	const truckCol = headers.find((h) => /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i.test(h)) || null;
	const rowsByKey = new Map();
	for (const row of data) {
		const key = loadIdCol ? normalizeLoadId(row[loadIdCol]) : "";
		if (!key) continue;
		if (!rowsByKey.has(key)) rowsByKey.set(key, []);
		rowsByKey.get(key).push(row);
	}
	const liveRows = (key) => (rowsByKey.get(key) || []).filter((r) => !CANCELLED_RE.test(String(statusCol ? r[statusCol] : "").trim()));
	const lockedAt = new Map(db.prepare("SELECT period, finalized_at FROM period_locks WHERE status = 'locked'").all().map((r) => [r.period, instantMs(r.finalized_at)]));
	const stampEdits = (stamp) => {
		const e = {};
		if (dateCol) e[dateCol] = stamp;
		if (completionCol) e[completionCol] = stamp;
		return e;
	};

	// Condition 3 and the period guard, as the sheet and the locks read now. A
	// month locked after the upload was open then, and so was a row the history
	// cancels after it (`cancelledAfter`).
	function half(doc, { cancelledAfter = false } = {}) {
		const all = rowsByKey.get(doc.key) || [];
		if (!all.length) return { outcome: "not_on_sheet" };
		let live = liveRows(doc.key);
		let cancelledSince = false;
		if (!live.length && cancelledAfter) {
			const mine = all.filter((r) => api.normalizeDriverName(driverCol ? r[driverCol] : "") === api.normalizeDriverName(doc.driver));
			live = mine.length ? mine : all;
			cancelledSince = true;
		}
		if (!live.length) return { outcome: "load_cancelled" };
		if (live.length > 1) return { outcome: "ambiguous" };
		const row = live[0];
		const onRow = api.normalizeDriverName(driverCol ? row[driverCol] : "");
		if (!onRow || onRow !== api.normalizeDriverName(doc.driver)) return { outcome: "not_his_row" };
		const before = { ...row, ...(statusCol ? { [statusCol]: "At Receiver" } : {}), ...(completionCol ? { [completionCol]: "" } : {}) };
		const edits = { ...(statusCol ? { [statusCol]: "Delivered" } : {}), ...stampEdits(api.appStamp(new Date(doc.ms))) };
		const blocked = api.dispatchWriteBlocker(headers, before, edits, api.tripDayLockCover(headers));
		if (!blocked) return { outcome: "would_fire", cancelledSince };
		if (blocked.code === "PERIOD_FINALIZED") {
			const since = blocked.periods.every((p) => lockedAt.get(p) > doc.ms);
			return since ? { outcome: "would_fire", closedSince: true, cancelledSince } : { outcome: "month_closed" };
		}
		if (blocked.code === "PERIOD_UNRESOLVED") return { outcome: "period_unresolved" };
		if (blocked.code === "PERIOD_LOCK_UNREADABLE") return { outcome: "lock_unreadable" };
		return { outcome: String(blocked.code || "refused").toLowerCase() };
	}

	const truckCell = (key) => {
		const live = liveRows(key);
		return live.length && truckCol ? String(live[live.length - 1][truckCol] || "").trim() : "";
	};

	// One driver-week's paid days and amount on `rows`, as generate computes them.
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	const payStructs = api.getDriverPayStructures();
	const tripRule = api.tripDayResolver();
	function weekPay(rows, display, weekStart, weekEnd) {
		const nameNorm = api.normalizeDriverName(display);
		const week = api.selectInvoiceWeekLoads(rows, headers, display, weekStart, weekEnd, deletedKeys);
		const payStruct = payStructs[nameNorm] || { payType: "fixed", payPercentage: 0 };
		const percentage = payStruct.payType === "percentage";
		const weekRule = tripRule && !percentage ? tripRule : null;
		const extraRuleLoads = weekRule
			? api.invoiceExtraRuleLoads({ data: rows, headers, driverName: display, billed: week.loads, weekStart, weekEnd, resolver: weekRule, deletedKeys })
			: [];
		const paid = api.invoiceWeekPaidDays({ headers, cols: week.cols, loads: week.loads, extraRuleLoads, weekRule, weekStart, weekEnd, nameNorm });
		const truckRate = api.truckDailyRateCandidates(display).slice(-1)[0];
		const dailyRate = api.resolveDailyRate(payStruct.payDaily, truckRate, weekEnd.slice(0, 7));
		const amount = percentage ? null
			: api.invoiceDayPricing({ dailyRate, nameNorm, payDaily: payStruct.payDaily, truckRate, weekRule, dayPayMonth: paid.dayPayMonth }).totalOf(paid.activeDaySet);
		return { days: [...paid.activeDaySet].sort(), amount, percentage };
	}

	// Plan A's arrival rule (ARRIVAL_PICKUP_DATE, as the app's .env sets it) ends an
	// in-scope load's window at the status history's first Delivered row, which a
	// sheet re-stamp doesn't move: such a load is not modelled here.
	const arrivalFrom = arrivalPickup.ruleFromEnv(env);
	const arrivalRule = arrivalFrom ? arrivalPickup.createArrivalResolver({ db, fromDay: arrivalFrom }) : null;
	const monthCols = api.jobTrackingMonthCols(headers);
	const historyWindow = (row, display) => {
		if (!arrivalRule || (payStructs[api.normalizeDriverName(display)] || {}).payType === "percentage") return false;
		const assigned = monthCols.dateCol && row[monthCols.dateCol] ? api.moneySheetDate(row[monthCols.dateCol]) : null;
		const answer = arrivalRule.forLoad({ loadId: loadIdCol ? row[loadIdCol] : "", assigned, completed: true });
		return !!answer && !answer.none;
	};

	// The listed loads (Eastern day differs, and a blank Drop-off Appointment or
	// another billing week) re-stamped together with their uploads' stamps, and
	// each driver-week they bill in, paid as the sheet reads now and as re-stamped.
	function payEffect(fires) {
		const cols = api.invoiceWeekColumns(headers);
		const out = { loads: [], weeks: [], notListed: {}, planA: { rule: arrivalFrom ? "on" : "off", from: arrivalFrom || null, notModelled: [] } };
		const restamped = new Map();
		const weeks = new Map();
		const week = (display, day) => {
			const { weekStart, weekEnd } = api.getWeekRange(day);
			const wk = `${api.normalizeDriverName(display)}\t${weekStart}`;
			if (!weeks.has(wk)) weeks.set(wk, { display, weekStart, weekEnd, loads: new Set(), gainers: [], modelled: true });
			return weeks.get(wk);
		};
		for (const f of fires) {
			const done = liveRows(f.key).filter((r) => COMPLETED_RE.test(String(statusCol ? r[statusCol] : "").trim()));
			if (done.length !== 1) { inc(out.notListed, done.length ? "several completed rows" : "no completed row"); continue; }
			const row = done[0];
			const stamp = api.appStamp(new Date(f.uploadMs));
			const tapDay = api.invoiceCompletionDay(row, cols);
			const uploadDay = api.invoiceCompletionDay({ ...row, ...stampEdits(stamp) }, cols);
			const otherWeek = !!tapDay && !!uploadDay && api.getWeekRange(tapDay).weekStart !== api.getWeekRange(uploadDay).weekStart;
			const display = driverCol ? String(row[driverCol] || "").trim() : "";
			if (!display) { inc(out.notListed, "no driver"); continue; }
			if (historyWindow(row, display)) {
				out.planA.notModelled.push(loadLabel(f.key));
				for (const day of [tapDay, uploadDay]) if (day) Object.assign(week(display, day), { modelled: false }).loads.add(loadLabel(f.key));
				continue;
			}
			if (!otherWeek && cols.dropoffCol && String(row[cols.dropoffCol] || "").trim()) { inc(out.notListed, "Drop-off Appointment set, same week"); continue; }
			restamped.set(row, stamp);
			const driver = driverLabel(api.normalizeDriverName(display));
			out.loads.push({ load: loadLabel(f.key), driver, tapDay, uploadDay, otherWeek });
			for (const day of [tapDay, uploadDay]) if (day) week(display, day).loads.add(loadLabel(f.key));
			if (otherWeek) week(display, uploadDay).gainers.push(f);
		}
		const uploadRows = data.map((r) => (restamped.has(r) ? { ...r, ...stampEdits(restamped.get(r)) } : r));
		for (const w of weeks.values()) {
			const driver = driverLabel(api.normalizeDriverName(w.display));
			const head = { driver, weekStart: w.weekStart, weekEnd: w.weekEnd, loads: [...w.loads].sort(), modelled: w.modelled };
			if (!w.modelled) {
				out.weeks.push({ ...head, daysTap: null, daysUpload: null, amountTap: null, amountUpload: null, delta: null, invoice: null, once: "not modelled (plan A's window)" });
				continue;
			}
			const tap = weekPay(data, w.display, w.weekStart, w.weekEnd);
			const upload = weekPay(uploadRows, w.display, w.weekStart, w.weekEnd);
			const live = api.liveWeeklyInvoicesForDriverWeek(w.display, w.weekStart);
			const inv = live.length === 1 ? live[0] : null;
			out.weeks.push({
				...head, daysTap: tap.days, daysUpload: upload.days, amountTap: tap.amount, amountUpload: upload.amount,
				delta: tap.amount === null ? null : Math.round((upload.amount - tap.amount) * 100) / 100,
				invoice: inv ? inv.status : null, once: onceOn({ tap, upload, live, inv, gainers: w.gainers }),
			});
		}
		out.weeks.sort((a, b) => a.driver.localeCompare(b.driver) || a.weekStart.localeCompare(b.weekStart));
		return out;
	}

	// What happens to the week once the trigger is on, by direction. A load moved
	// into the week is billed by its Friday batch unless the upload came after that
	// batch; a day the week loses is paid by nothing (nothing is backfilled).
	function onceOn({ tap, upload, live, inv, gainers }) {
		const gained = upload.days.filter((d) => !tap.days.includes(d));
		const lost = tap.days.filter((d) => !upload.days.includes(d));
		if (!gained.length && !lost.length) return tap.amount === upload.amount ? "nothing changes" : "the same days at another amount: a person checks the week";
		const parts = [];
		if (gained.length) {
			const head = `gains ${gained.join(", ")}: `;
			if (live.length > 1) parts.push(`${head}${live.length} live invoices for this week: a person decides`);
			else if (!inv) parts.push(`${head}generate pays them`);
			else if (inv.status === "Draft") parts.push(`${head}a person regenerates the Draft`);
			else if (gainers.some((f) => f.afterBatch)) parts.push(`${head}issued (${inv.status}) by the Friday batch before the upload, so a person adds them with scripts/create-correction-invoice-draft.js`);
			else parts.push(`${head}the Friday batch runs after the upload and bills them`);
		}
		if (lost.length) parts.push(`loses ${lost.join(", ")}: the week is billed on the upload's day, so these days go unpaid; no correction applies`);
		return parts.join("; ");
	}

	return { half, truckCell, payEffect };
}

// ── output ───────────────────────────────────────────────────────────────────
function printText(r, { env }) {
	const L = [];
	const pairs = (obj) => Object.entries(obj || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
	const b = r.backtest;
	L.push(`Load phases report, ${r.window.from} to ${r.window.to} (${r.window.days} days, business clock ${r.window.zone}). Read-only; nothing was written.`);
	L.push(`Sheet: ${r.sheet}.`);
	L.push("1. Phase writers (geofence; a manual row by its session role; other sources by name):");
	for (const phase of Object.keys(r.writers.byPhase).sort()) L.push(`   ${phase}: ${pairs(r.writers.byPhase[phase])}`);
	L.push(`   Manual rows ${r.writers.manualRows}; role from actor_role ${r.writers.roleFrom.actor_role}, from the audit row ${r.writers.roleFrom.audit}, unmatched ${r.writers.roleFrom.none}.`);
	L.push(`2. The POD trigger, backtest: ${b.podUploads} POD upload(s): ${pairs(b.outcomes)}.`);
	if (Object.keys(b.sheetOutcomes).length || b.closedSinceUpload || b.cancelledSinceUpload) L.push(`   Refused by the sheet half (as the sheet reads now): ${pairs(b.sheetOutcomes)}; counted as open at the upload: months locked after it ${b.closedSinceUpload}, loads the history cancels after it ${b.cancelledSinceUpload}.`);
	L.push(`   Loads delivered in the window ${b.loadsDelivered}; the trigger would complete ${b.loadsWouldFire} of them. Would fire ${b.wouldFire} (uploader role not recorded on ${b.uploaderRoleNotRecorded}).`);
	L.push(`   The actual Delivered after the upload: ${pairs(b.tap)}; same Eastern day ${b.sameDay} of ${b.delivered}; same billing week ${b.sameWeek} of ${b.delivered}.`);
	L.push(`   Fridays: fired ${b.fridays.fired}, after the 19:00 batch ${b.fridays.afterBatch}; week changes ${b.fridays.weekChanges}.`);
	L.push(`   False completions ${b.falseCompletions.length}${b.falseCompletions.map((x) => `; ${x.load} ${x.follow}`).join("")}. Staff corrections ending in Delivered within 1 h: ${b.staffCorrections.length}${b.staffCorrections.map((x) => `; ${x.load}`).join("")}.`);
	L.push(`   Multi-stop shapes (an At Receiver followed by an earlier phase): ${b.multiStop.loads} load(s); a POD during that arrival on ${b.multiStop.podDuring}, would fire on ${b.multiStop.podDuringWouldFire}.`);
	L.push(`   Withdrawn uploads (deleted before the actual Delivered or within 1 h): ${b.withdrawn.length}${b.withdrawn.map((x) => `; ${x.load}`).join("")}; deleted later ${b.deletedLater}.`);
	L.push(`   More POD files after the upload that would fire, before the actual Delivered: ${b.laterFiles.files} on ${b.laterFiles.loads} load(s), from that upload ${pairs(b.laterFiles.byGap)} (the invoice job's tick is ${TICK_MS / MIN_MS} min, the quiet period ${QUIET_MS / MIN_MS} min); over 15 min ${b.laterFiles.overQuiet.length}${b.laterFiles.overQuiet.map((x) => `; ${x.load} ${x.laterFilesMin.join(", ")} min`).join("")}; largest gap between consecutive files ${b.laterFiles.maxConsecutiveMin} min; loads with a POD within 24 h after the tap ${b.laterFiles.podsAfterTapIn24h}.`);
	L.push(`   Delivered loads whose only POD came before the geofence's arrival (they keep the Delivered button): ${b.onlyPodBeforeArrival.loads} of ${b.onlyPodBeforeArrival.of}.`);
	const v = b.variantB;
	L.push(`   F7 (b), for comparison (a manual arrival and a clean fix inside the drop-off fence within 15 min): adds ${v.loads} load(s); same day ${v.sameDay}, same week ${v.sameWeek}, Delivered within 60 min ${v.within60}; not checkable (no point or no device) ${v.notChecked}.`);
	for (const x of b.loads) L.push(`   ${x.load} ${x.upload} ${x.follow}${x.minutesToDelivered === null ? "" : ` +${x.minutesToDelivered} min`}${x.sameDay === false ? " day differs" : ""}${x.sameWeek === false ? " WEEK DIFFERS" : ""}${x.laterFilesMin.length ? ` later files ${x.laterFilesMin.join(", ")} min` : ""}`);
	if (r.pay) {
		L.push(`3. The pay effect (would-fire loads whose Eastern day differs and whose Drop-off Appointment is blank or billing week differs; the weekly invoice's code, lifted): ${r.pay.loads.length} load(s)${Object.keys(r.pay.notListed).length ? `; not listed: ${pairs(r.pay.notListed)}` : ""}.`);
		for (const w of r.pay.weeks) {
			const usd = (x) => (x === null ? "n/a (percentage pay)" : `$${x.toFixed(2)}`);
			if (!w.modelled) { L.push(`   ${w.driver} ${w.weekStart}..${w.weekEnd} (${w.loads.join(", ")}): ${w.once}.`); continue; }
			L.push(`   ${w.driver} ${w.weekStart}..${w.weekEnd} (${w.loads.join(", ")}): tap's stamp ${w.daysTap.length} day(s) [${w.daysTap.join(", ")}] ${usd(w.amountTap)}; upload's stamp ${w.daysUpload.length} day(s) [${w.daysUpload.join(", ")}] ${usd(w.amountUpload)}; invoice ${w.invoice || "none"}; once on: ${w.once}.`);
		}
		const ledgerFrom = loadPayDays.blankFallbackFromEnv(env, "dropoff");
		const a = r.pay.planA;
		L.push(`   The ledger and the investor view: ${ledgerFrom ? `not checked: LEDGER_BLANK_DROPOFF_FALLBACK_FROM is ${ledgerFrom}, so they read the completion day on a blank drop-off` : "unchanged (LEDGER_BLANK_DROPOFF_FALLBACK_FROM is not set, so a blank drop-off doesn't end at the completion day there)"}.`);
		L.push(a.rule === "on"
			? `   Plan A's arrival rule: on from ${a.from}. Its window ends at the status history's first Delivered row, which this report does not re-time: ${a.notModelled.length} load(s) not modelled${a.notModelled.length ? ` (${a.notModelled.join(", ")}), their weeks printed as not modelled and the pay line not checked` : ""}.`
			: "   Plan A's arrival rule: off in the app's .env, so every window above is today's.");
	} else {
		L.push("3. The pay effect: not checked (needs --values-json).");
	}
	L.push(`4. The shadow claims: ${r.claims}.`);
	const e = r.receiverExit;
	L.push(`5. The receiver exit (delivered loads with a geofence At Receiver: ${e.loads}; no fix or point to read ${e.notChecked}): exit seen ${e.seen}; left before the first POD ${e.beforeFirstPod}, within 1 h after it ${e.withinHourOfPod}, later ${e.laterThanHour}; before the tap ${e.beforeTap}; Eastern day differs from the tap's ${e.dayDiffers}; billing week differs ${e.weekDiffers}.`);
	L.push(`6. Heading taps: ${r.heading.loads} load(s) (${pairs(r.heading.writers)}): the arrival the same Eastern day ${r.heading.sameDay}, the next ${r.heading.nextDay}, later ${r.heading.later}, none ${r.heading.none}; within 1 h ${r.heading.withinHour}. Loading rows ${r.loading.rows} (${pairs(r.loading.writers)}): to the next row ${pairs(r.loading.toNext)}; Eastern days spanned ${pairs(r.loading.daysSpanned)}.`);
	const c = r.coordinates;
	L.push(`7. Coordinates: ${c.activeLoads} active load(s): both points ${c.bothPoints}, no origin ${c.noOrigin}, no destination ${c.noDestination}, no row ${c.noRow}; without a usable point by month ${pairs(c.withoutPointByMonth)}.`);
	L.push(`   The geofence's distance to the mapped point: At Shipper ${pairs(c.distances["At Shipper"])} (max ${c.maxM["At Shipper"]} m); At Receiver ${pairs(c.distances["At Receiver"])} (max ${c.maxM["At Receiver"]} m).`);
	L.push(`   Delivered loads with no geofence row ${c.deliveredNoGeofence.loads}, of them with ELD data ${c.deliveredNoGeofence.withEld}. Unusable-address alerts ${c.alerts.inWindow}: became loads ${c.alerts.becameLoads}, delivered ${c.alerts.delivered}, with both points ${c.alerts.withBothPoints}, geofence At Shipper ${c.alerts.geofenceAtShipper}, At Receiver ${c.alerts.geofenceAtReceiver}.`);
	L.push(`8. Driver taps (on loads with ELD data / all): ${PHASES.filter((p) => r.taps.byPhase[p]).map((p) => `${p} ${r.taps.byPhase[p].onEldLoads}/${r.taps.byPhase[p].taps}`).join("; ") || "none"}; on the geofenced phases ${r.taps.geofencedOnEldLoads}.`);
	if (r.truckCells) L.push(`   The Truck cell against the dated histories: agree ${r.truckCells.agree}, disagree ${r.truckCells.disagree}, no cell ${r.truckCells.noCell}, no truck resolved ${r.truckCells.noTruck}.`);
	L.push(`Switch-on criteria (S2 reads 1-4 on production: ${r.s2}):`);
	for (const x of r.criteria) L.push(`   ${x.n}. ${x.verdict}: ${x.what} (${x.detail})`);
	L.push(`Shadow-run minimums: ${r.preconditions.map((p) => `${p.what} ${p.verdict} (${p.detail})`).join("; ")}.`);
	L.push(`Gate: ${r.gate}.`);
	console.log(L.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db.trim()) refuse("--db=<app.db> is required: the database to read (opened read-only)");
	const days = args.days === undefined ? 28 : Number(args.days);
	if (!Number.isInteger(days) || days < 1 || days > 120) refuse("--days must be a whole number of days from 1 to 120");
	let nowMs = Date.now();
	if (args.now !== undefined) {
		if (typeof args.now !== "string" || !INSTANT_RE.test(args.now) || !Number.isFinite(Date.parse(args.now))) refuse("--now must be an ISO instant with its zone, e.g. 2026-10-30T16:00:00Z");
		nowMs = Date.parse(args.now);
	}
	if (args["sheet-id"] !== undefined) refuse("--sheet-id is not taken: this report reads no sheet over the network; pass a saved values.get with --values-json");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	let env;
	try {
		({ file: dbFile, env } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	if (!fs.existsSync(dbFile) || !fs.statSync(dbFile).isFile()) refuse(`--db=${args.db}: there is no such database file`);
	let values = null;
	if (args["values-json"] !== undefined) {
		if (typeof args["values-json"] !== "string") refuse("--values-json needs a file: a saved values.get of the Job Tracking tab");
		try { values = JSON.parse(fs.readFileSync(path.resolve(args["values-json"]), "utf8")).values; } catch (err) { refuse(`--values-json: ${err.message}`); }
		if (!Array.isArray(values) || !values.length) refuse("--values-json holds no values: save the whole values.get answer of the Job Tracking tab");
	}
	// The lifted code and this report read one business clock: the app's, with its
	// switch moment (a zone alone is refused).
	const zone = appTime.resolveAppTimeZone(env.APP_TIMEZONE || process.env.APP_TIMEZONE);
	process.env.APP_TIMEZONE = zone;
	const zoneFrom = env.APP_TIMEZONE_FROM || process.env.APP_TIMEZONE_FROM;
	if (zoneFrom) process.env.APP_TIMEZONE_FROM = zoneFrom;
	const db = openReadOnly(dbFile);
	try {
		const missing = TABLES.filter((t) => !hasTable(db, t));
		if (missing.length) refuse(`the database has no ${missing.join(", ")} table: it is older than this report, or not this app's`);
		const names = liftNames();
		const labels = { load: labeller("load", args.ids === true), driver: labeller("driver") };
		let sheet = null;
		if (values) {
			const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData: { values }, envFile, extraRoots: SHEET_ROOTS, db });
			sheet = sheetSide({ api: world.api, db, env, values, driverLabel: labels.driver, loadLabel: labels.load });
		}
		const result = tidy(buildReport(db, { env, zone, nowMs, days, labels, sheet, names }));
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result, { env });
		if (args.gate === true && result.gate !== "PASS") process.exitCode = 1;
	} finally {
		db.close();
	}
}

module.exports = { LIFT_ROOTS, SHEET_ROOTS, LIFT_DENIED, openReadOnly };

if (require.main === module) {
	main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
}
