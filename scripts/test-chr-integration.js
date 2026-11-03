#!/usr/bin/env node
// lib/chr-integration.js: the one object server.js builds for the C.H.
// Robinson integration (R5 PR 1a: plan 4.1, 4.2, 4.14; review-2 NL1; PR 1b
// wires it: scripts/test-chr-wiring.js runs server.js's block).
//
//   §1  chrConfig(): the three server switches as strict booleans, off unless
//       true, all off in a replica; the geofence radius
//   §2  NL1: the carrier deny-list values live only inside the redactor's
//       closure, never in a readable or enumerable field
//   §3  create(): only the listed dependencies (no Sheets, Drive, mail or
//       network client can be handed in); a config from chrConfig() only
//   §4  the instance: the config view; mount(): one app.use behind
//       requireRole("Super Admin") (none without it or the same-origin guard),
//       the page's router (scripts/test-chr-routes.js runs it over HTTP): GET
//       /status and a JSON 404 FEATURE_OFF while off; status() { enabled: false } read from
//       nothing while off; jobs(): the recorder while on, the prune whenever
//       the tables exist (NL5); the two intervals; sweep() with the switch
//       off; prune() whatever the switch
//   §5  the system actor its audit rows use
//   §6  the lib reads no environment and names no setting, so the switches are
//       read where PR 1b wires it
//   §7  projectView(): each live load's projection by key (its seven keys, a
//       domain, no Payment), the first row of a key winning, and the row with
//       its Load ID cell handed back to the caller
//   §8  instructionStopsReader(): stop counts only; null for no row, no table
//       or an unreadable payload
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
// A group of checks that would throw on a lib without what it checks (a tree
// before PR 1b): the throw is reported as a failure, and the runner goes on.
function guarded(label, fn) {
	try { fn(); } catch (err) { failures.push(`${label}\n      threw ${err.message}`); }
}

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
eq(I.DEP_NAMES, ["db", "config", "readSheet", "stopPointsFor", "truckResolver", "deviceResolver", "instructionStopsFor", "logAudit", "onChange", "listedAccounts", "now", "log"],
	"§3 the dependency list (plan 4.1; the listed accounts for who may choose Live, A3)");
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
eq(Object.keys(inst).sort(), ["config", "jobs", "mount", "prune", "pruneIntervalMs", "status", "sweep", "sweepIntervalMs"],
	"§4 config(), status(), mount(), jobs(), sweep(), prune() and the two intervals");
eq(inst.config(), { updatesEnabled: false, sendEnabled: false, locationEnabled: false, geofenceRadiusM: tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M, denyListCount: 1 }, "§4 config(): the switches, the radius and a count; no redactor, no value");
ok(!JSON.stringify(inst.config()).includes(DENY_CANARY), "§4 ...and so no deny value");
eq([inst.sweepIntervalMs, inst.pruneIntervalMs], [60 * 1000, 24 * 60 * 60 * 1000], "§4 one sweep a minute, one prune a day");
eq([I.MOUNT_PATH, I.NOTICE_TYPE], ["/api/integrations/chr", "chr-attention"], "§4 the mount path and the notice type server.js hides from every role but Super Admin");
// mount(): app.get, put, post and use only, each with the role gate first. Any
// other app call throws.
function mountOn(instance, guards) {
	const regs = [];
	const app = new Proxy({}, { get: (_t, k) => (["get", "put", "post", "use"].includes(k) ? (...a) => regs.push([k, ...a]) : () => { throw new Error(`mount() called app.${String(k)}`); }) });
	instance.mount(app, guards);
	return regs;
}
guarded("§4 mount(), the routes, status() and jobs()", () => {
	const gateCalls = [];
	const gate = () => {};
	const sameOrigin = (req, res, next) => next();
	const regs = mountOn(inst, { requireRole: (...roles) => { gateCalls.push(roles); return gate; }, refuseCrossOrigin: sameOrigin });
	eq([regs.map((r) => [r[0], r[1], r[2] === gate, r.length]), gateCalls], [[["get", "/api/integrations/chr/status", true, 4], ["use", "/api/integrations/chr", true, 4]], [["Super Admin"]]],
		"§4 mount() while off: GET /status and a catch-all at /api/integrations/chr, requireRole(\"Super Admin\") first on each");
	throws(() => mountOn(inst), /requireRole/, "§4 mount() without requireRole throws: no CHR path is ever served ungated");
	throws(() => mountOn(inst, { requireRole: "Super Admin", refuseCrossOrigin: sameOrigin }), /requireRole/, "§4 ...nor with anything else in its place");
	throws(() => mountOn(inst, { requireRole: () => gate }), /refuseCrossOrigin/, "§4 mount() without refuseCrossOrigin throws: no CHR write is ever served unguarded");
	// Each handler as Express calls it past the gate.
	const answer = (handler, method, p) => {
		const out = { code: 200, body: undefined, next: false };
		const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; } };
		handler({ method, url: p, path: p, query: {} }, res, () => { out.next = true; });
		return out;
	};
	const handlerOf = (rs, verb, p) => { const r = rs.find((x) => x[0] === verb && x[1] === p); return r ? r[r.length - 1] : () => {}; };
	eq(answer(handlerOf(regs, "get", "/api/integrations/chr/status"), "GET", "/status"), { code: 200, body: { enabled: false }, next: false }, "§4 off: GET /status answers { enabled: false }");
	const offAll = handlerOf(regs, "use", "/api/integrations/chr");
	for (const [m, p] of [["GET", "/"], ["GET", "/events"], ["POST", "/status"], ["PUT", "/settings"], ["GET", "/loads/123456789"], ["GET", "/status/x"]]) {
		eq(answer(offAll, m, p), { code: 404, body: { error: "Not found", code: "FEATURE_OFF" }, next: false }, `§4 off: ${m} ${p} answers 404 FEATURE_OFF and never falls through`);
	}
	const unreadable = { prepare: () => { throw new Error("made-up: nothing may be read"); } };
	eq(I.create(deps({ db: unreadable, config: I.chrConfig({}) })).status(), { enabled: false }, "§4 off: status() reads nothing (a database that refuses every read)");
	eq([inst.status(), inst.jobs()], [{ enabled: false }, { sweep: false, prune: false }], "§4 off with no tables: no recorder and no prune (NL5: no tables, no timer)");
	const dTables = deps({ config: I.chrConfig({}) });
	S.ensureSchema(dTables.db);
	eq(I.create(dTables).jobs(), { sweep: false, prune: true }, "§4 off with the tables: the prune only (NL5)");
	const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
	const dOn = deps({ config: I.chrConfig({ updatesEnabled: true, denyList: DENY_CANARY }), now: () => Date.parse("2026-11-02T15:00:00Z"), log: quietLog });
	const onInst = I.create(dOn);
	eq(onInst.jobs(), { sweep: true, prune: true }, "§4 on: the recorder and the prune");
	eq(onInst.status(), { enabled: true, sendEnabled: false, locationEnabled: false, milestones: "dry_run", location: "off", settings: { ...S.DEFAULT_SETTINGS }, lastTickAt: "", lastSweepOk: "", lastErrorCode: "" },
		"§4 on: status() gives the switches, each kind's effective mode, the page's settings and the recorder's last tick");
	ok(!JSON.stringify(onInst.status()).includes(DENY_CANARY), "§4 ...and no deny value (NL1)");
	eq(dOn.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'chr_%'").get().n, 0, "§4 ...read from the settings and state, with no table made");
	const onRegs = mountOn(onInst, { requireRole: () => gate, refuseCrossOrigin: sameOrigin });
	eq([onRegs.every((r) => r[2] === gate), onRegs[onRegs.length - 1].slice(0, 2)], [true, ["use", "/api/integrations/chr"]], "§4 on: every route behind the gate; the catch-all last");
	eq([answer(handlerOf(onRegs, "get", "/api/integrations/chr/status"), "GET", "/status").body.enabled, answer(handlerOf(onRegs, "get", "/api/integrations/chr/events"), "GET", "/events"),
		answer(handlerOf(onRegs, "use", "/api/integrations/chr"), "GET", "/nothing")],
		[true, { code: 200, body: { events: [], next: null }, next: false }, { code: 404, body: { error: "Not found", code: "NOT_FOUND" }, next: false }],
		"§4 on: GET /status is the status; GET /events the (empty) send log; any other path a JSON 404 (scripts/test-chr-routes.js runs every route over HTTP)");
	eq(dOn.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'chr_%'").get().n, 0, "§4 ...and reading them made no table");
});

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

// ------------------------------------------------------------------ §7
section("§7  projectView(): what the recorder may hold of Job Tracking");
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment"];
const jt = (loadId, over = {}) => ({
	"Load ID": loadId, Status: "In Transit", Driver: "Made Up Driver", Email: "made-up.agent@chrobinson.com", "Trailer Number": "53001",
	"Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: "$1,234.56", ...over,
});
const view = Object.freeze({ headers: Object.freeze(HEADERS.slice()), data: Object.freeze([
	Object.freeze(jt(" #123456789 ")), Object.freeze(jt("123456789", { Driver: "Second Row" })), Object.freeze(jt("")),
	Object.freeze(jt("LD-TEST-2", { Email: "Made Up <made-up.agent@example-broker.test>" })),
]) });
guarded("§7 projectView()", () => {
	const pv = I.projectView(view);
	eq([...pv.projections.keys()], ["123456789", "ld-test-2"], "§7 each load by its key; a blank Load ID is left out");
	eq(pv.projections.get("123456789").driverName, "Made Up Driver", "§7 the first row of a key wins");
	ok([...pv.projections.values()].every((p) => JSON.stringify(Object.keys(p)) === JSON.stringify(E.PROJECTION_KEYS)), "§7 every projection has exactly its seven keys");
	ok(!JSON.stringify([...pv.projections.values()]).includes("1,234.56") && !JSON.stringify([...pv.projections.values()]).includes("@"), "§7 ...with no Payment and no address: the Email cell's domain only");
	eq([pv.rowOf.get("123456789").row === view.data[0], pv.rowOf.get("123456789").loadIdCell, pv.headers === view.headers], [true, "#123456789", true],
		"§7 rowOf hands back the row itself and its Load ID cell as written (trimmed), for the caller's stop-point reader");
	const empty = I.projectView(null);
	eq([empty.headers, empty.projections.size, empty.rowOf.size], [[], 0, 0], "§7 no view: nothing");
});

// ------------------------------------------------------------------ §8
section("§8  instructionStopsReader(): stop counts only");
eq(I.INSTRUCTION_STOPS_SQL, "SELECT payload FROM load_driver_instructions WHERE load_key = ?", "§8 one named column, by key");
guarded("§8 instructionStopsReader()", () => {
	const idb = new Database(":memory:");
	const readStops = I.instructionStopsReader(idb);
	eq(readStops("123456789"), null, "§8 no table yet: null (no signal), never a throw");
	idb.exec("CREATE TABLE load_driver_instructions (load_key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '')");
	idb.prepare("INSERT INTO load_driver_instructions (load_key, payload) VALUES (?, ?)")
		.run("123456789", JSON.stringify({ stops: [{ kind: "pickup", instructions: ["Ask for Made Up Person"] }, { kind: "delivery" }, { kind: "Delivery" }] }));
	idb.prepare("INSERT INTO load_driver_instructions (load_key, payload) VALUES (?, ?)").run("223456789", "not json");
	eq([readStops("123456789"), readStops("223456789"), readStops("999999999")], [{ pickups: 1, deliveries: 2 }, null, null],
		"§8 the counts once the table exists; null for an unreadable payload or no row");
	ok(!JSON.stringify(readStops("123456789")).includes("Made Up"), "§8 ...and nothing of the payload but the counts");
});

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
