"use strict";
// The one object the server builds for the C.H. Robinson integration. It takes a
// CHR-only config from chrConfig() and a closed list of dependencies, so it can
// never be handed a Sheets, Drive, mail or network client.
//
// The server switches are read where the server wires this module, never here:
// CHR_UPDATES_ENABLED (recording and the page), CHR_SEND_ENABLED (any request
// to CHR), CHR_LIVE_ALL_ENABLED (Live for every load, not just the pilot) and
// CHR_LOCATION_ENABLED (positions, from PR 4). Each is off unless set to true,
// 1, yes or on, and off in a replica; the wiring hands them in as booleans. The
// connection settings (provisional names until CHR's docs) arrive as values and
// are held outside the config, so no field of it can show one.

const chrEvents = require("./chr-events");
const chrStore = require("./chr-store");
const chrSweep = require("./chr-sweep");
const chrRoutes = require("./chr-routes");
const chrTransport = require("./chr-transport");
const tripWorkDays = require("./trip-work-days");

const CONFIG_INPUTS = Object.freeze(["updatesEnabled", "sendEnabled", "liveAllEnabled", "locationEnabled", "geofenceRadiusM", "denyList", "connection", "replica"]);
// listedAccounts: the parsed listed-accounts setting (lib/listed-accounts.js),
// read only to say who may choose Pilot or Live and press Test connection (A3).
// notify: an in-app notice to Super Admins ({ title, body }).
const DEP_NAMES = Object.freeze(["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "notify", "listedAccounts", "now", "log"]);
const REQUIRED_DEPS = Object.freeze(["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "logAudit"]);
const FUNCTION_DEPS = Object.freeze(["readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "notify", "now"]);
const BUILT = new WeakSet();
// The connection's values, reachable only from this module.
const CONNECTIONS = new WeakMap();
const MOUNT_PATH = chrRoutes.MOUNT_PATH;
// The in-app notice type for Super Admins (pauses and failed sends, from PR 3).
// server.js hides it from every other role; a runner pins the two spellings.
const NOTICE_TYPE = "chr-attention";
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTRUCTION_STOPS_SQL = "SELECT payload FROM load_driver_instructions WHERE load_key = ?";

// NL1: the carrier deny-list values go only into the redactor's closure; the
// config holds their count, never a value. The connection's client id, secret
// and carrier code are seeded into the same redactor (exact values) and kept
// in CONNECTIONS; the config says only whether they are set. A replica gets none.
function chrConfig(input = {}) {
	const i = input && typeof input === "object" ? input : {};
	for (const k of Object.keys(i)) {
		if (!CONFIG_INPUTS.includes(k)) throw new Error("chrConfig(): unknown field (the config is CHR-only)");
	}
	const on = (v) => i.replica !== true && v === true;
	const r = i.geofenceRadiusM;
	const given = i.connection && typeof i.connection === "object" && i.replica !== true ? i.connection : {};
	const connection = {};
	for (const k of chrTransport.CONNECTION_FIELDS) connection[k] = typeof given[k] === "string" ? given[k].trim() : "";
	const redactor = chrEvents.createRedactor({ denyList: i.denyList || "", exact: [connection.clientId, connection.clientSecret, connection.carrierCode] });
	const config = Object.freeze({
		updatesEnabled: on(i.updatesEnabled),
		sendEnabled: on(i.sendEnabled),
		liveAllEnabled: on(i.liveAllEnabled),
		locationEnabled: on(i.locationEnabled),
		geofenceRadiusM: typeof r === "number" && Number.isFinite(r) && r > 0 ? r : tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M,
		denyListCount: redactor.count,
		credentialsConfigured: Boolean(connection.baseUrl && connection.tokenUrl && connection.clientId && connection.clientSecret),
		carrierCodeConfigured: Boolean(connection.carrierCode),
		redactor,
	});
	BUILT.add(config);
	CONNECTIONS.set(config, Object.freeze(connection));
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
	// The only transport: built here from the config's connection, never handed in.
	const transport = chrTransport.createTransport({ connection: CONNECTIONS.get(d.config) || {}, now });
	const sweeper = chrSweep.createSweep({ ...d, transport });
	const on = d.config.updatesEnabled === true;

	// { enabled: false } while the master switch is off, read from nothing.
	// Otherwise the switches, each kind's effective mode, the page's settings, the
	// pause, the connection (configured or not) and the recorder's last tick:
	// codes and times only, never a row, a credential or a deny value.
	function status() {
		if (!on) return { enabled: false };
		const settings = chrStore.readSettings(d.db);
		const state = chrStore.readState(d.db);
		const ready = transport.ready();
		return {
			enabled: true,
			sendEnabled: d.config.sendEnabled,
			liveAllEnabled: d.config.liveAllEnabled,
			locationEnabled: d.config.locationEnabled,
			milestones: chrSweep.effectiveMode("milestone", { settings, config: d.config, transportReady: ready }),
			location: chrSweep.effectiveMode("location", { settings, config: d.config, transportReady: ready }),
			settings,
			paused: state.pausedReason ? { reason: state.pausedReason, at: state.pausedAt, until: state.pausedUntil } : null,
			connection: { configured: d.config.credentialsConfigured, carrierCodeConfigured: d.config.carrierCodeConfigured, ready, lastTokenOkAt: state.lastTokenOkAt },
			lastTickAt: state.lastTickAt,
			lastSweepOk: state.lastSweepOk,
			lastErrorCode: state.lastErrorCode,
		};
	}

	return {
		// The switches, the radius, how many deny values are set and whether the
		// connection is: never a value.
		config: () => ({
			updatesEnabled: d.config.updatesEnabled,
			sendEnabled: d.config.sendEnabled,
			liveAllEnabled: d.config.liveAllEnabled,
			locationEnabled: d.config.locationEnabled,
			geofenceRadiusM: d.config.geofenceRadiusM,
			denyListCount: d.config.denyListCount,
			credentialsConfigured: d.config.credentialsConfigured,
			carrierCodeConfigured: d.config.carrierCodeConfigured,
		}),
		status,
		// Without the role gate and the same-origin guard nothing is mounted: a CHR
		// path is never served ungated (lib/chr-routes.js).
		mount(app, guards) {
			chrRoutes.mount(app, {
				db: d.db, config: d.config, on, status, logAudit: d.logAudit, onChange: d.onChange, now, log: d.log, listedAccounts: d.listedAccounts,
				transportReady: () => transport.ready(), testConnection: () => transport.testConnection(),
			}, guards);
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
