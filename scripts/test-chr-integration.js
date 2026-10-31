#!/usr/bin/env node
// lib/chr-integration.js: the one object server.js will build for the C.H.
// Robinson integration (R5 PR 1a: plan 4.1, 4.2, 4.14; review-2 NL1). PR 1a ships
// it unwired: nothing in the app creates it, and mount() registers no route.
//
//   §1  chrConfig(): the three server switches as strict booleans, off unless
//       true, all off in a replica; the geofence radius
//   §2  NL1: the carrier deny-list values live only inside the redactor's
//       closure, never in a readable or enumerable field
//   §3  create(): only the listed dependencies (no Sheets, Drive, mail or
//       network client can be handed in); a config from chrConfig() only
//   §4  the instance: the config view, mount() registers nothing, the sweep's
//       interval, sweep() with the switch off, prune() whatever the switch
//   §5  the system actor its audit rows use
//   §6  the lib reads no environment and names no setting, so the switches are
//       read where PR 1b wires it
//
// Made-up data only. In-memory SQLite, no network, no files written.
//   node scripts/test-chr-integration.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const I = require(path.join(ROOT, "lib", "chr-integration.js"));
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const tripWorkDays = require(path.join(ROOT, "lib", "trip-work-days.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function throws(fn, re, label) {
	try { fn(); failures.push(`${label}\n      did not throw`); } catch (err) { ok(re.test(err.message), `${label} (${err.message})`); }
}
function section(t) { console.log(`\n${t}`); }

// A made-up protected number, deliberately not shaped like a real carrier number.
const DENY_CANARY = "77700011122233";
const SECOND = "66600022233344";

// ------------------------------------------------------------------ §1
section("§1  chrConfig()");
const off = I.chrConfig();
eq(Object.keys(off), ["updatesEnabled", "sendEnabled", "locationEnabled", "geofenceRadiusM", "denyListCount", "redactor"], "§1 exactly these fields");
eq([off.updatesEnabled, off.sendEnabled, off.locationEnabled], [false, false, false], "§1 nothing given: every switch off");
eq(off.geofenceRadiusM, tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M, "§1 the default radius is the geofence's (3218.69 m)");
ok(Object.isFrozen(off) && Object.isFrozen(off.redactor), "§1 frozen, its redactor too");
for (const v of ["true", 1, "1", "yes", {}, [true], null]) {
	eq(I.chrConfig({ updatesEnabled: v, sendEnabled: v, locationEnabled: v }).updatesEnabled, false, `§1 ${JSON.stringify(v)} is not true: off (the wiring hands booleans)`);
}
const on = I.chrConfig({ updatesEnabled: true, sendEnabled: true, locationEnabled: true, geofenceRadiusM: 500 });
eq([on.updatesEnabled, on.sendEnabled, on.locationEnabled, on.geofenceRadiusM], [true, true, true, 500], "§1 true is on; a positive radius is kept");
const rep = I.chrConfig({ updatesEnabled: true, sendEnabled: true, locationEnabled: true, replica: true });
eq([rep.updatesEnabled, rep.sendEnabled, rep.locationEnabled], [false, false, false], "§1 a replica: every switch off, whatever it is handed");
for (const bad of [0, -5, "500", NaN, Infinity, null]) {
	eq(I.chrConfig({ geofenceRadiusM: bad }).geofenceRadiusM, tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M, `§1 radius ${String(bad)}: the default`);
}
eq(I.chrConfig({ geofenceRadiusM: tripWorkDays.geofenceRadiusFromEnv({ GEOFENCE_RADIUS_M: "1609.34" }) }).geofenceRadiusM, 1609.34, "§1 the wiring passes geofenceRadiusFromEnv()'s answer through");
throws(() => I.chrConfig({ updatesEnabled: true, clientSecret: "made-up" }), /unknown/i, "§1 an unknown field is refused (the config is CHR-only)");

// ------------------------------------------------------------------ §2
section("§2  NL1: the deny list stays inside the redactor");
const cfg = I.chrConfig({ updatesEnabled: true, denyList: `${DENY_CANARY}, ${SECOND}; 12` });
eq(cfg.denyListCount, 2, "§2 the count of usable values (one under 5 digits set aside), never a value");
ok(cfg.redactor.hits(`ref ${DENY_CANARY}`) && cfg.redactor.hits(SECOND), "§2 the redactor knows both values");
const seen = [];
(function walk(v, depth) {
	if (depth > 6 || v === null || v === undefined) return;
	if (typeof v === "string" || typeof v === "number") { seen.push(String(v)); return; }
	if (typeof v === "function" || typeof v === "object") {
		for (const k of [...Object.getOwnPropertyNames(v), ...Object.getOwnPropertySymbols(v)]) {
			const d = Object.getOwnPropertyDescriptor(v, k);
			seen.push(String(k));
			if (d && "value" in d) walk(d.value, depth + 1);
		}
	}
}(cfg, 0));
eq(seen.filter((s) => s.includes(DENY_CANARY) || s.includes(SECOND)), [], "§2 no own property, enumerable or not, holds a value (walked to depth 6)");
ok(!JSON.stringify(cfg).includes(DENY_CANARY), "§2 JSON shows none");
ok(!util.inspect(cfg, { showHidden: true, depth: Infinity, getters: true }).includes(DENY_CANARY), "§2 inspect, hidden fields and getters included, shows none");
ok(!String(cfg.redactor.hits).includes(DENY_CANARY) && !String(cfg.redactor.redact).includes(DENY_CANARY), "§2 no function's text holds one");
eq(cfg.redactor.redact(`see ${DENY_CANARY}`), "see [withheld]", "§2 redact() withholds it");

// ------------------------------------------------------------------ §3
section("§3  create(): the dependencies");
function freshDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
	`);
	return db;
}
let sheetReads = 0;
const audits = [];
function deps(over = {}) {
	return {
		db: freshDb(),
		config: I.chrConfig(),
		readSheet: async () => { sheetReads++; return new Map(); },
		stopPointsFor: () => null,
		truckResolver: () => ({ forDriverAt: () => null }),
		deviceResolver: () => ({ vehicleForTruckAt: () => "" }),
		logAudit: (...a) => audits.push(a),
		...over,
	};
}
eq(I.DEP_NAMES, ["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "now", "log"], "§3 the dependency list (plan 4.1)");
for (const name of ["sheets", "getSheets", "drive", "getDrive", "sendEmail", "appendGmailDraft", "transporter", "fetch", "env", "transport", "io"]) {
	throws(() => I.create(deps({ [name]: () => {} })), /not a dependency/, `§3 ${name} is refused: the lib can never be handed it`);
}
for (const name of ["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "logAudit"]) {
	const d = deps();
	delete d[name];
	throws(() => I.create(d), /needs/, `§3 ${name} is required`);
}
throws(() => I.create(deps({ config: { updatesEnabled: true, sendEnabled: false, locationEnabled: false, geofenceRadiusM: 3218.69, denyListCount: 0, redactor: { hits: () => false, redact: (s) => s } } })), /chrConfig/, "§3 a config not built by chrConfig() is refused");
throws(() => I.create(deps({ readSheet: "not a function" })), /function/, "§3 a dependency of the wrong type is refused");

// ------------------------------------------------------------------ §4
section("§4  the instance");
const d0 = deps({ config: I.chrConfig({ updatesEnabled: false, denyList: DENY_CANARY }) });
const inst = I.create(d0);
eq(Object.keys(inst).sort(), ["config", "mount", "prune", "sweep", "sweepIntervalMs"], "§4 config(), mount(), sweep(), sweepIntervalMs, prune()");
eq(inst.config(), { updatesEnabled: false, sendEnabled: false, locationEnabled: false, geofenceRadiusM: tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M, denyListCount: 1 }, "§4 config(): the switches, the radius and a count; no redactor, no value");
ok(!JSON.stringify(inst.config()).includes(DENY_CANARY), "§4 ...and so no deny value");
eq(inst.sweepIntervalMs, 60 * 1000, "§4 one sweep a minute");
let registered = 0;
const spyApp = new Proxy({}, { get: () => () => { registered++; throw new Error("mount() registered a route"); } });
inst.mount(spyApp, { requireRole: () => {}, refuseCrossOrigin: () => {} });
eq(registered, 0, "§4 mount() registers no route yet (PR 2 adds them)");

async function asyncChecks() {
	sheetReads = 0;
	const res = await inst.sweep();
	eq(res.ran, false, "§4 sweep() with the switch off: does not run");
	eq([sheetReads, audits.length, d0.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'chr_%'").get().n], [0, 0, 0], "§4 ...no sheet read, no audit, no table");
	eq(inst.prune(), { positionsCleared: 0, locationDeleted: 0 }, "§4 prune() with the switch off and no tables: nothing, and no table made");
	eq(d0.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'chr_%'").get().n, 0, "§4 ...still no chr_ table");
	const d1 = deps({ config: I.chrConfig({ updatesEnabled: false }), now: () => Date.parse("2026-12-15T12:00:00Z") });
	S.ensureSchema(d1.db);
	S.applyRecording(d1.db, {
		inserts: [{ load_id: "123456789", kind: "milestone", event: "delivered", stop_kind: "delivery", stop_index: 1, source: "manual", history_row_id: 1,
			event_at: "2026-11-02T15:00:00.000Z", verify: "confirmed", idem_key: "ms|123456789|delivered|final|h1",
			payload_json: JSON.stringify({ loadNumber: "123456789", position: { lat: 41.5252, lng: -88.0815 } }), mode: "dry_run", status: "dry_run",
			hold_reason: "", skip_reason: "", fields_dropped: 0, next_attempt_at: "" }],
		state: S.readState(d1.db), nowIso: "2026-11-02T15:00:00.000Z",
	});
	eq(I.create(d1).prune(), { positionsCleared: 1, locationDeleted: 0 }, "§4 prune() runs whenever the tables exist, the switch off included (it only clears and deletes)");
	const d2 = deps({ config: I.chrConfig({ updatesEnabled: true }), now: () => Date.parse("2026-11-02T15:00:00Z"), log: { info: () => {}, warn: () => {}, error: () => {} } });
	const r2 = await I.create(d2).sweep();
	eq([r2.ran, r2.baseline], [true, "first_enable"], "§4 sweep() with the switch on runs (the sweep runner covers the rest)");
}

// ------------------------------------------------------------------ §5
section("§5  the system actor");
eq(I.SYSTEM_ACTOR, { session: { user: { id: 0, username: "chr-integration", role: "system" } } }, "§5 id 0, role system, like the period-close actor");
ok(Object.isFrozen(I.SYSTEM_ACTOR) && Object.isFrozen(I.SYSTEM_ACTOR.session) && Object.isFrozen(I.SYSTEM_ACTOR.session.user), "§5 frozen through");

// ------------------------------------------------------------------ §6
section("§6  no environment, no setting names in lib/chr-*.js");
const replicaRules = require(path.join(ROOT, "lib", "replica-rules.js"));
for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => /^chr-.*\.js$/.test(x)).sort()) {
	const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
	eq([...replicaRules.namesReadBy([src])], [], `§6 ${f}: namesReadBy() finds no setting it reads`);
	ok(!/\benv\??\.[A-Z]|\benv\[/.test(src), `§6 ${f}: no env.NAME read`);
	ok(!/\bprocess\b/.test(src), `§6 ${f}: no process object at all`);
}

asyncChecks().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
