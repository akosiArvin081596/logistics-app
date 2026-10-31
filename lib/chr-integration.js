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
	return {
		// The switches, the radius and how many deny values are set: never a value.
		config: () => ({
			updatesEnabled: d.config.updatesEnabled,
			sendEnabled: d.config.sendEnabled,
			locationEnabled: d.config.locationEnabled,
			geofenceRadiusM: d.config.geofenceRadiusM,
			denyListCount: d.config.denyListCount,
		}),
		// Registers no route yet: the page's routes come with PR 2.
		mount() {},
		sweep: () => sweeper.tick(),
		sweepIntervalMs: chrSweep.SWEEP_INTERVAL_MS,
		prune: () => chrStore.prune(d.db, { nowMs: now() }),
	};
}

module.exports = {
	CONFIG_INPUTS,
	DEP_NAMES,
	REQUIRED_DEPS,
	SYSTEM_ACTOR: chrSweep.SYSTEM_ACTOR,
	chrConfig,
	create,
};
