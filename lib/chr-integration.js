"use strict";
// The one object the server builds for the C.H. Robinson integration. It takes a
// CHR-only config from chrConfig() and a closed list of dependencies, so it can
// never be handed a Sheets, Drive, mail or network client.
//
// The server switches are read where the server wires this module, never here:
// CHR_UPDATES_ENABLED (recording and the page), CHR_SEND_ENABLED (any request
// to CHR, from PR 3) and CHR_LOCATION_ENABLED (positions, from PR 4). Each is off
// unless set to true, 1, yes or on, and off in a replica; the wiring hands them
// in as booleans.

const chrEvents = require("./chr-events");
const chrStore = require("./chr-store");
const chrSweep = require("./chr-sweep");
const tripWorkDays = require("./trip-work-days");

const CONFIG_INPUTS = Object.freeze(["updatesEnabled", "sendEnabled", "locationEnabled", "geofenceRadiusM", "denyList", "replica"]);
const DEP_NAMES = Object.freeze(["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "now", "log"]);
const REQUIRED_DEPS = Object.freeze(["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "logAudit"]);
const FUNCTION_DEPS = Object.freeze(["readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "now"]);
const BUILT = new WeakSet();
const MOUNT_PATH = "/api/integrations/chr";
// The in-app notice type for Super Admins (pauses and failed sends, from PR 3).
// server.js hides it from every other role; a runner pins the two spellings.
const NOTICE_TYPE = "chr-attention";
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTRUCTION_STOPS_SQL = "SELECT payload FROM load_driver_instructions WHERE load_key = ?";

// NL1: the carrier deny-list values go only into the redactor's closure; the
// config holds their count, never a value.
function chrConfig(input = {}) {
	const i = input && typeof input === "object" ? input : {};
	for (const k of Object.keys(i)) {
		if (!CONFIG_INPUTS.includes(k)) throw new Error("chrConfig(): unknown field (the config is CHR-only)");
	}
	const on = (v) => i.replica !== true && v === true;
	const r = i.geofenceRadiusM;
	const redactor = chrEvents.createRedactor({ denyList: i.denyList || "" });
	const config = Object.freeze({
		updatesEnabled: on(i.updatesEnabled),
		sendEnabled: on(i.sendEnabled),
		locationEnabled: on(i.locationEnabled),
		geofenceRadiusM: typeof r === "number" && Number.isFinite(r) && r > 0 ? r : tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M,
		denyListCount: redactor.count,
		redactor,
	});
	BUILT.add(config);
	return config;
}

// Each live Job Tracking row as a projection by load key (the first row of a key
// wins). rowOf hands the row and its Load ID cell back to the caller's stop-point
// reader, so no row is kept here.
function projectView(view) {
	const headers = view && Array.isArray(view.headers) ? view.headers : [];
	const rows = view && Array.isArray(view.data) ? view.data : [];
	const idCol = headers.find((h) => chrEvents.COLUMN_RULES.loadId.test(h));
	const projections = new Map();
	const rowOf = new Map();
	for (const row of rows) {
		const p = chrEvents.projectRow(row, headers);
		if (!p.loadKey || projections.has(p.loadKey)) continue;
		projections.set(p.loadKey, p);
		rowOf.set(p.loadKey, { row, loadIdCell: idCol ? String((row && row[idCol]) || "").trim() : "" });
	}
	return { headers, projections, rowOf };
}

// A load's driver-instructions stop counts ({ pickups, deliveries }) or null:
// only the counts leave here, never the payload. A missing table or an
// unreadable payload is no signal.
function instructionStopsReader(db) {
	let read = null;
	return (key) => {
		try {
			read = read || db.prepare(INSTRUCTION_STOPS_SQL);
			const r = read.get(String(key == null ? "" : key));
			return r ? chrEvents.instructionStopCounts(JSON.parse(r.payload)) : null;
		} catch {
			return null;
		}
	};
}

function create(deps) {
	const d = deps && typeof deps === "object" ? deps : {};
	for (const k of Object.keys(d)) {
		if (!DEP_NAMES.includes(k)) throw new Error(`chr-integration: ${String(k).slice(0, 40)} is not a dependency of this module`);
	}
	for (const k of REQUIRED_DEPS) {
		if (d[k] === undefined || d[k] === null) throw new Error(`chr-integration: create() needs ${k}`);
	}
	if (!BUILT.has(d.config)) throw new Error("chr-integration: the config must come from chrConfig()");
	for (const k of FUNCTION_DEPS) {
		if (d[k] !== undefined && typeof d[k] !== "function") throw new Error(`chr-integration: ${k} must be a function`);
	}
	if (typeof d.db.prepare !== "function") throw new Error("chr-integration: db must be a database handle");
	const now = typeof d.now === "function" ? d.now : () => Date.now();
	const sweeper = chrSweep.createSweep(d);
	const on = d.config.updatesEnabled === true;

	// { enabled: false } while the master switch is off, read from nothing.
	// Otherwise the switches, each kind's effective mode and the recorder's
	// last tick: codes and times only, never a row or a deny value.
	function status() {
		if (!on) return { enabled: false };
		const settings = chrStore.readSettings(d.db);
		const state = chrStore.readState(d.db);
		return {
			enabled: true,
			sendEnabled: d.config.sendEnabled,
			locationEnabled: d.config.locationEnabled,
			milestones: chrSweep.effectiveMode("milestone", { settings, config: d.config }),
			location: chrSweep.effectiveMode("location", { settings, config: d.config }),
			lastTickAt: state.lastTickAt,
			lastSweepOk: state.lastSweepOk,
			lastErrorCode: state.lastErrorCode,
		};
	}

	// Behind the Super Admin gate. Until the page's routes (PR 2), GET /status
	// and a JSON 404 for every other path, so no path under the mount ever
	// reaches the app page.
	function chrRoutes(req, res) {
		if (req.method === "GET" && req.path === "/status") return res.json(status());
		return res.status(404).json({ error: "Not found", code: on ? "NOT_FOUND" : "FEATURE_OFF" });
	}

	return {
		// The switches, the radius and how many deny values are set: never a value.
		config: () => ({
			updatesEnabled: d.config.updatesEnabled,
			sendEnabled: d.config.sendEnabled,
			locationEnabled: d.config.locationEnabled,
			geofenceRadiusM: d.config.geofenceRadiusM,
			denyListCount: d.config.denyListCount,
		}),
		status,
		// Without the role gate nothing is mounted: a CHR path is never served ungated.
		mount(app, guards) {
			if (!guards || typeof guards.requireRole !== "function") throw new Error("chr-integration: mount() needs requireRole");
			app.use(MOUNT_PATH, guards.requireRole("Super Admin"), chrRoutes);
		},
		// Which timers the server starts: the recorder only while the switch is
		// on; the prune whenever the tables exist, since it only clears and
		// deletes. Off with no tables: none.
		jobs: () => ({ sweep: on, prune: on || chrStore.tablesExist(d.db) }),
		sweep: () => sweeper.tick(),
		sweepIntervalMs: chrSweep.SWEEP_INTERVAL_MS,
		prune: () => chrStore.prune(d.db, { nowMs: now() }),
		pruneIntervalMs: PRUNE_INTERVAL_MS,
	};
}

module.exports = {
	CONFIG_INPUTS,
	DEP_NAMES,
	REQUIRED_DEPS,
	MOUNT_PATH,
	NOTICE_TYPE,
	INSTRUCTION_STOPS_SQL,
	SYSTEM_ACTOR: chrSweep.SYSTEM_ACTOR,
	chrConfig,
	projectView,
	instructionStopsReader,
	create,
};
