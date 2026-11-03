#!/usr/bin/env node
/**
 * The C.H. Robinson integration as server.js wires it (R5 PR 1b): the
 * <chr-wiring> block, lifted from server.js's text and run with lib/chr-*.js as
 * shipped over an in-memory database. server.js's own requireRole,
 * liveJobTrackingView, resolveGeofencePoints, logAudit, noticeTypeScope and the
 * dispatch-notice routes are lifted too (scripts/lib/server-lift.js); the routes
 * run on a real Express app on 127.0.0.1 with the SPA catch-all registered after
 * the block, as in server.js. Made up: Job Tracking, the truck and device
 * resolvers and the clock. No CHR transport exists in PR 1b: the block's own
 * `fetch` and the global one are a transport spy that throws if called, and
 * https is refused and counted.
 *
 *   §1 server.js around the block: one block, after the rate-con PDF mount, above
 *      the KPI block and the SPA catch-all; the three switches read in the
 *      default-off shape (only true/1/yes/on is on); no Sheets, Drive, mail or
 *      network dependency named
 *   §2 what the block hands the lib: chrConfig() exactly its six inputs (the
 *      geofence's own radius, the replica flag, the deny list), create() exactly
 *      its listed dependencies, the server's own resolvers and logAudit;
 *      readSheet() answers projections only (their seven keys, a domain, no
 *      Payment, no cancelled or soft-deleted load, the shared cache unchanged);
 *      stopPointsFor() reads the geofence's way, under the Load ID as written;
 *      instructionStopsFor() answers stop counts only
 *   §3 the switch off: no table, no recorder, no timer; GET /status answers
 *      { enabled: false }; every other path 404 FEATURE_OFF, never the app page;
 *      signed out 401, every other role 403, a write without X-Requested-With 403
 *   §4 tables, the switch off: the prune only (at boot, then daily), never the
 *      recorder (review-2 NL5)
 *   §5 the switch on: GET /status with the switches and modes; a JSON 404 for an
 *      unknown path; the recorder's timer and the prune's; the timer's tick makes
 *      the tables, baselines with the system's audit row and tells the
 *      super-admin room only
 *   §6 a replica: every switch set and every switch off; replica:start refuses
 *      all three (lib/replica-rules.js ENABLE_REFUSED)
 *   §7 a Dry run through the wiring end to end: a dry_run row with exactly the
 *      allowlisted payload, its stop point found under the raw Load ID; the
 *      transport spy never called and nothing reached the network
 *   §8 NL1: the deny list set to a canary, which reaches no GET /status answer,
 *      chr_* row, setting, state, audit row, notice, socket message or log line;
 *      neither do a driver's name, an emergency contact, the agent's address or
 *      money planted beside it
 *   §9 a Dispatcher's GET /api/dispatch-notifications never lists a CHR notice,
 *      nor can PUT .../read mark one; a Super Admin's lists it
 *   §10 the refresh step (scripts/refresh-env.js) on a made-up copy agrees with
 *      lib/chr-store.js resetForRefresh(); a copy without the tables gets none
 *   §11 mutants: a wiring or lib that breaks each rule above fails its check
 *
 * Made-up data only (load 123456789, truck T-101). Temp folders only; no
 * network beyond the loopback listener. Fails on a tree without the block.
 * Run: node scripts/test-chr-wiring.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const START = "// <chr-wiring>";
const END = "// </chr-wiring>";
if (SRC.split(START).length !== 2 || SRC.split(END).length !== 2 || SRC.indexOf(END) < SRC.indexOf(START)) {
	console.log("FAIL  server.js has no single <chr-wiring> block");
	process.exit(1);
}
const BLOCK = SRC.slice(SRC.indexOf(START), SRC.indexOf(END) + END.length);

const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const express = require(path.join(ROOT, "node_modules", "express"));
const { closure, liftRoute } = require(path.join(__dirname, "lib", "server-lift.js"));
const { withheldLoadKeyHelpers } = require(path.join(__dirname, "lib", "withheld-load-key-lift.js"));
const realChr = require(path.join(ROOT, "lib", "chr-integration.js"));
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const replicaRules = require(path.join(ROOT, "lib", "replica-rules.js"));
const serverRequire = createRequire(path.join(ROOT, "server.js"));
const REFRESH_SCRIPT = path.join(__dirname, "refresh-env.js");

// ------------------------------------------------------------------ checks
function collector() {
	const c = { pass: 0, failures: [] };
	c.eq = (actual, expected, label) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a === e) { c.pass++; return true; }
		c.failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
		return false;
	};
	c.ok = (cond, label, detail) => {
		if (cond) { c.pass++; return true; }
		c.failures.push(`${label}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
		return false;
	};
	return c;
}
const T = collector();
const section = (t) => console.log(`\n${t}`);

// ------------------------------------------------------------------ the network
// The test's own client keeps the real fetch; everything else meets the spy.
const realFetch = globalThis.fetch;
const outbound = { transport: 0, https: 0 };
function transportSpy() {
	outbound.transport++;
	throw new Error("transport spy: no request to CHR may start in PR 1b");
}
globalThis.fetch = transportSpy;
const refuseHttps = () => { outbound.https++; throw new Error("network refused in test-chr-wiring"); };
https.request = refuseHttps;
https.get = refuseHttps;

const realNow = Date.now;
// Runs fn with Date.now() reading `ms`: the lib's clock when the server hands it none.
async function at(ms, fn) {
	Date.now = () => ms;
	try { return await fn(); } finally { Date.now = realNow; }
}
const MIN = 60 * 1000;
const T0 = Date.parse("2026-11-02T15:00:00Z");
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ------------------------------------------------------------------ made-up data
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Broker Contact Name", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment"];
const SA = Object.freeze({ id: 1, username: "made_up_admin", role: "Super Admin" });
const DISP = Object.freeze({ id: 2, username: "made_up_dispatcher", role: "Dispatcher" });
const DRIVER = Object.freeze({ id: 3, username: "made_up_driver", role: "Driver" });
const INVESTOR = Object.freeze({ id: 4, username: "made_up_investor", role: "Investor" });
const DRIVER_NAME = "Canary Testdriver";
const AGENT = "made-up.agent@chrobinson.com";
const MONEY = "$1,234.56";
// A made-up protected number, deliberately not shaped like a real carrier number.
const DENY_CANARY = "77700011122233";
const EMERGENCY = Object.freeze({ name: "Canary Emergencycontact", phone: "(555) 555-0199" });
const PICKUP = Object.freeze({ lat: 42.0347, lng: -93.62 });
const DROP = Object.freeze({ lat: 41.525, lng: -88.0817 });
const AT_PICKUP = Object.freeze({ lat: 42.035, lng: -93.6195 });
const OUTSIDE = Object.freeze({ lat: 42.08, lng: -93.62 });
const row = (loadId, over = {}) => ({
	"Load ID": loadId, Status: "Dispatched", Driver: DRIVER_NAME, Email: AGENT, "Broker Contact Name": "Made Up Agent", "Trailer Number": "53001",
	"Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: MONEY, ...over,
});

// ------------------------------------------------------------------ server.js, lifted
const PROVIDED = ["db", "console", "process", "require"];
const LIFT = closure(SRC, {
	roots: ["requireRole", "liveJobTrackingView", "resolveGeofencePoints", "logAudit", "noticeTypeScope", "GEOFENCE_RADIUS"],
	provided: PROVIDED,
	denied: ["app", "server", "io", "getJobTrackingCached", "REPLICA", "chr", "chrIntegration", "chrSheetView"],
});
const NOTICE_GET = 'app.get("/api/dispatch-notifications", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const NOTICE_PUT = 'app.put("/api/dispatch-notifications/read", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const NOTICE_ROUTES = [liftRoute(SRC, NOTICE_GET), liftRoute(SRC, NOTICE_PUT)].join("\n");
const createSql = (name) => {
	const at0 = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	if (at0 < 0) throw new Error(`server.js creates no ${name} table`);
	return SRC.slice(at0, SRC.indexOf("`", at0));
};
const altersOf = (name) => [...SRC.matchAll(new RegExp(`db\\.exec\\((["\`])(ALTER TABLE ${name} ADD COLUMN [^"\`]+)\\1\\)`, "g"))].map((m) => m[2]);
const TABLES = ["app_settings", "server_state", "audit_trail", "load_status_history", "routemate_telemetry", "load_coordinates", "deleted_loads", "dispatch_notifications", "driver_emergency_contacts"];
// The runner's own inputs; every other table is output the canary checks read.
const INPUT_TABLES = ["load_status_history", "routemate_telemetry", "load_coordinates", "deleted_loads", "driver_emergency_contacts", "load_driver_instructions"];
function makeDb() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = OFF");
	for (const t of TABLES) {
		db.exec(createSql(t));
		for (const a of altersOf(t)) db.exec(a);
	}
	// lib/driver-instructions-runtime.js's table, as far as the reader goes.
	db.exec("CREATE TABLE load_driver_instructions (load_key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '')");
	return db;
}
function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
const chrTables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chr\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);

// ------------------------------------------------------------------ a world
const openWorlds = [];
// `blockText`, `liftText`: server.js's text unless a mutant replaces it. `libWrap`
// wraps lib/chr-integration.js as the block requires it. `listen: false` skips
// the HTTP server for a case that reads the config only.
async function world({ env = {}, replica = null, startsJobAnswer = true, blockText = BLOCK, liftText = LIFT.text, libWrap = null, before = null, sheetRows = [], listen = true } = {}) {
	const w = { env: { ...env }, startsJob: [], intervals: [], sockets: [], logs: [], sheetRows, seen: {}, resolverCalls: { truck: 0, device: 0 }, cacheCalls: 0 };
	const db = makeDb();
	w.db = db;
	if (before) before(db);
	const quiet = {
		log: (...a) => w.logs.push(a.join(" ")), info: (...a) => w.logs.push(a.join(" ")),
		warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")),
	};
	const proc = { env: w.env };
	const H = new Function(...PROVIDED, `${liftText}\nreturn { ${LIFT.names.join(", ")} };`)(db, quiet, proc, serverRequire);
	w.H = H;

	const realApp = express();
	realApp.use(express.json());
	realApp.use((req, res, next) => {
		const u = req.headers["x-test-user"];
		req.session = u ? { user: JSON.parse(u) } : {};
		next();
	});
	w.registered = [];
	const app = {};
	for (const verb of ["get", "put", "post", "delete", "patch", "use", "all"]) {
		app[verb] = (p, ...handlers) => { w.registered.push({ verb, path: p, handlers }); return realApp[verb](p, ...handlers); };
	}
	const lib = libWrap ? libWrap(realChr, w) : realChr;
	const spied = {
		...lib,
		chrConfig: (input) => { w.seen.configInput = input; return lib.chrConfig(input); },
		create: (deps) => { w.seen.deps = deps; return lib.create(deps); },
	};
	w.cache = deepFreeze({ headers: HEADERS.slice(), data: sheetRows.map((r) => ({ ...r })) });
	const scope = {
		require: (p) => (p === "./lib/chr-integration" ? spied : serverRequire(p)),
		db,
		process: proc,
		console: quiet,
		GEOFENCE_RADIUS: H.GEOFENCE_RADIUS,
		REPLICA: replica,
		liveJobTrackingView: H.liveJobTrackingView,
		getJobTrackingCached: async () => { w.cacheCalls++; return w.cache; },
		resolveGeofencePoints: H.resolveGeofencePoints,
		// The made-up driver holds truck 1 (T-101), which carries device RM-TEST-1.
		buildHaulTruckResolver: () => {
			w.resolverCalls.truck++;
			return { forDriverAt: (name, ms) => (Number.isFinite(ms) && String(name).trim().toLowerCase() === DRIVER_NAME.toLowerCase() ? { truck_id: 1, unit: "T-101" } : null) };
		},
		buildEldDeviceResolver: () => {
			w.resolverCalls.device++;
			return { vehicleForTruckAt: (id) => (id === 1 ? "RM-TEST-1" : "") };
		},
		logAudit: H.logAudit,
		io: { to: (room) => ({ emit: (event, payload) => w.sockets.push({ room, event, payload }) }) },
		app,
		requireRole: H.requireRole,
		startsJob: (name) => { w.startsJob.push(name); return startsJobAnswer; },
		setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); return 0; },
		fetch: transportSpy,
	};
	w.scope = scope;
	const names = Object.keys(scope);
	w.out = new Function(...names, `${blockText}\nreturn { chr, CHR_NOTICE_TYPE, view: () => chrSheetView };`)(...names.map((n) => scope[n]));
	w.chr = w.out.chr;
	// The dispatch-notice routes as server.js serves them (broker-contact handling
	// stubbed: its own runner covers it), then the SPA catch-all, last.
	new Function("app", "db", "requireRole", "noticeTypeScope", "BROKER_CONTACT_VALUE_REDACTION_ENABLED", "staffDispatchNotice", "brokerContact",
		"currentShownLoadIdIndex", "withNoticeLoadKey", NOTICE_ROUTES)(
		realApp, db, H.requireRole, H.noticeTypeScope, true, (n) => n, { fullDispatchNotice: (n) => n }, () => null, withheldLoadKeyHelpers(SRC).withNoticeLoadKey);
	realApp.get("*", (req, res) => res.status(200).type("html").send("<!doctype html><title>made-up app page</title>"));

	w.history = (loadKey, status, ms, source = "manual") => db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, reason) VALUES (?, '', ?, ?, ?, ?, ?)")
		.run(loadKey, status, source, `${DRIVER_NAME} ${EMERGENCY.phone}`, stamp(ms), `made-up note ${DENY_CANARY}`).lastInsertRowid;
	w.ping = (ms, p, { speed = 0, device = "RM-TEST-1" } = {}) => db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source, geocoded_location)
		VALUES (?, ?, ?, ?, ?, '', 'routemate', ?)`).run(device, p.lat, p.lng, speed, ms, `${EMERGENCY.name}, 742 Evergreen Terrace, Ames, IA`);
	w.events = () => db.prepare("SELECT load_id, event, status, hold_reason, skip_reason, verify, mode, payload_json FROM chr_events ORDER BY id").all();

	if (listen) {
		w.server = await new Promise((resolve) => { const s = realApp.listen(0, "127.0.0.1", () => resolve(s)); });
		const base = `http://127.0.0.1:${w.server.address().port}`;
		w.call = async (method, url, user, { body, xrw = true } = {}) => {
			const headers = { "content-type": "application/json" };
			if (xrw) headers["x-requested-with"] = "XMLHttpRequest";
			if (user) headers["x-test-user"] = JSON.stringify(user);
			const resp = await realFetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
			const text = await resp.text();
			let json = null;
			try { json = JSON.parse(text); } catch { json = null; }
			return { status: resp.status, json, text, type: resp.headers.get("content-type") || "" };
		};
		openWorlds.push(w);
	}
	w.close = async () => {
		if (!w.server) return;
		w.server.closeAllConnections();
		await new Promise((r) => w.server.close(() => r()));
		w.server = null;
	};
	return w;
}
async function closeAll() {
	for (const w of openWorlds.splice(0)) await w.close();
}

const OTHER_PATHS = [
	["GET", "/api/integrations/chr"], ["GET", "/api/integrations/chr/events"], ["GET", "/api/integrations/chr/loads/123456789"],
	["PUT", "/api/integrations/chr/settings"], ["POST", "/api/integrations/chr/stop"], ["POST", "/api/integrations/chr/status"],
	["GET", "/api/integrations/chr/status/extra"],
];

// ------------------------------------------------------------------ the checks, each run on the shipped code and on mutants
async function checkSource(t, blockText = BLOCK, src = SRC) {
	const mount = src.indexOf('require("./lib/ratecon-pdf-route").mount(app,');
	const block = src.indexOf(START);
	const kpi = src.indexOf("// KPI BOT —");
	const catchAll = src.indexOf('\napp.get("*"');
	t.ok(mount > 0 && block > mount, "§1 the block comes after the rate-con PDF mount");
	t.ok(block > 0 && kpi > block && src.indexOf(END) < kpi, "§1 ...and ends above the KPI block the KPI runners lift");
	t.ok(catchAll > 0 && src.indexOf(END) < catchAll, "§1 ...so above the SPA catch-all app.get(\"*\")");
	const code = blockText.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	for (const name of ["CHR_UPDATES_ENABLED", "CHR_SEND_ENABLED", "CHR_LOCATION_ENABLED"]) {
		const reads = code.split(`process.env.${name}`).length - 1;
		const shaped = code.split(`/^(true|1|yes|on)$/i.test(String(process.env.${name} ?? "").trim())`).length - 1;
		t.eq([reads, shaped], [1, 1], `§1 ${name} is read once, in the default-off shape (true/1/yes/on)`);
	}
	t.eq(code.match(/\b(?:getSheets|getDrive|sendEmail|appendGmailDraft|nodemailer|transporter|imap|fetch|google)\b/g) || [], [], "§1 the block names no Sheets, Drive, mail or network dependency");
}

async function checkHandover(t, opts = {}) {
	const w = await world({
		...opts,
		listen: false,
		env: { CHR_UPDATES_ENABLED: "true", CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: `${DENY_CANARY}, 66600022233344` },
		sheetRows: [row("#123456789"), row("223456789", { Status: "Cancelled" }), row("323456789"), row("423456789", { Email: "made-up.agent@example-broker.test" }), row("")],
		before: (db) => {
			db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('323456789')").run();
			db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES ('#123456789', ?, ?, ?, ?)").run(PICKUP.lat, PICKUP.lng, DROP.lat, DROP.lng);
			db.prepare("INSERT INTO load_driver_instructions (load_key, payload) VALUES ('123456789', ?)")
				.run(JSON.stringify({ stops: [{ kind: "pickup", instructions: [`Ask ${EMERGENCY.name}`] }, { kind: "delivery" }, { kind: "delivery" }] }));
		},
	});
	const input = w.seen.configInput || {};
	t.eq(Object.keys(input).sort(), [...realChr.CONFIG_INPUTS].sort(), "§2 chrConfig() gets exactly its six inputs");
	t.eq([input.updatesEnabled, input.sendEnabled, input.locationEnabled, input.replica, input.geofenceRadiusM === w.H.GEOFENCE_RADIUS, typeof input.denyList],
		[true, false, false, false, true, "string"], "§2 ...the switches as booleans, the replica flag, the geofence's own radius and the deny list");
	t.eq(w.chr.config().denyListCount, 2, "§2 the deny list reaches the redactor (2 values), read through its one spelling");
	const deps = w.seen.deps || {};
	t.eq(Object.keys(deps).sort(), ["config", "db", "deviceResolver", "instructionStopsFor", "log", "logAudit", "onChange", "readSheet", "stopPointsFor", "truckResolver"],
		"§2 create() gets exactly its listed dependencies: no Sheets, Drive, mail or network client");
	t.ok(deps.db === w.db && deps.logAudit === w.H.logAudit && deps.truckResolver === w.scope.buildHaulTruckResolver && deps.deviceResolver === w.scope.buildEldDeviceResolver,
		"§2 ...the server's own database, logAudit and truck and device resolvers");
	const proj = typeof deps.readSheet === "function" ? await deps.readSheet() : new Map();
	t.eq([...proj.keys()], ["123456789", "423456789"], "§2 readSheet(): the live loads by key; a cancelled, a soft-deleted and a blank Load ID are not there");
	t.ok([...proj.values()].every((p) => JSON.stringify(Object.keys(p)) === JSON.stringify(E.PROJECTION_KEYS)), "§2 ...each projection has exactly its seven keys",
		[...proj.values()].map((p) => Object.keys(p)));
	const p1 = proj.get("123456789") || {};
	t.eq([p1.loadId, p1.brokerDomain, p1.driverName], ["123456789", "chrobinson.com", DRIVER_NAME], "§2 ...the Load ID as CHR knows it, the Email cell's domain only, the driver (in memory)");
	t.ok(!JSON.stringify([...proj.values()]).includes(MONEY) && !JSON.stringify([...proj.values()]).includes("@"), "§2 ...and no Payment and no address anywhere in them");
	t.eq(JSON.stringify(w.cache.data.map((r) => r.Payment)), JSON.stringify([MONEY, MONEY, MONEY, MONEY, MONEY]), "§2 the shared Job Tracking cache is left as it was");
	const pts = typeof deps.stopPointsFor === "function" ? deps.stopPointsFor("123456789") : null;
	t.eq(pts, { origin: { latitude: PICKUP.lat, longitude: PICKUP.lng }, dest: { latitude: DROP.lat, longitude: DROP.lng } },
		"§2 stopPointsFor(): the geofence's rule (resolveGeofencePoints()), the stored point found under the Load ID as written (\"#123456789\")");
	t.eq(typeof deps.stopPointsFor === "function" ? deps.stopPointsFor("999999999") : null, { origin: null, dest: null }, "§2 ...and none for a load it has no row or point for");
	t.eq(typeof deps.instructionStopsFor === "function" ? [deps.instructionStopsFor("123456789"), deps.instructionStopsFor("999999999")] : null,
		[{ pickups: 1, deliveries: 2 }, null], "§2 instructionStopsFor(): the driver-instructions stop counts only, null without a row");
	return w;
}

async function checkOff(t, opts = {}) {
	const w = await world({ ...opts });
	t.eq(w.chr.config().updatesEnabled, false, "§3 nothing set: the switch is off");
	t.eq([w.startsJob, w.intervals.length], [[], 0], "§3 no recorder and no prune: startsJob() is never asked and no timer starts (no tables: no timer)");
	const status = await w.call("GET", "/api/integrations/chr/status", SA);
	t.eq([status.status, status.json], [200, { enabled: false }], "§3 GET /status (Super Admin): { enabled: false }");
	for (const [m, u] of OTHER_PATHS) {
		const r = await w.call(m, u, SA, { body: m === "GET" ? undefined : {} });
		t.eq([r.status, r.json && r.json.code, /json/.test(r.type)], [404, "FEATURE_OFF", true], `§3 ${m} ${u.replace("/api/integrations/chr", "") || "/"} (Super Admin): JSON 404 FEATURE_OFF, never the app page`);
	}
	for (const [label, user, code] of [["signed out", null, 401], ["a Dispatcher", DISP, 403], ["a Driver", DRIVER, 403], ["an Investor", INVESTOR, 403]]) {
		const r = await w.call("GET", "/api/integrations/chr/status", user);
		const r2 = await w.call("GET", "/api/integrations/chr/events", user);
		t.eq([r.status, r2.status, r.json && r.json.enabled], [code, code, undefined], `§3 ${label}: ${code} on /status and every other path, before anything is read`);
	}
	const csrf = await w.call("POST", "/api/integrations/chr/stop", SA, { body: {}, xrw: false });
	t.eq([csrf.status, csrf.json && csrf.json.code], [403, "CSRF_HEADER_REQUIRED"], "§3 a Super Admin write without X-Requested-With: refused by the role gate first");
	const tick = await w.chr.sweep();
	t.eq([tick.ran, chrTables(w.db), w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n, w.sockets.length], [false, [], 0, 0],
		"§3 a sweep does not run; no chr_ table, audit row or socket message after all of it");
	return w;
}

async function checkTablesOff(t, opts = {}) {
	const old = new Date(realNow() - 40 * 24 * 60 * MIN).toISOString();
	const w = await world({
		...opts,
		listen: false,
		before: (db) => {
			S.ensureSchema(db);
			S.applyRecording(db, {
				inserts: [{ load_id: "123456789", kind: "milestone", event: "delivered", stop_kind: "delivery", stop_index: 1, source: "manual", history_row_id: 1,
					event_at: old, verify: "confirmed", idem_key: "ms|123456789|delivered|final|h1", payload_json: JSON.stringify({ loadNumber: "123456789", position: { lat: 41.5252, lng: -88.0815 } }),
					mode: "dry_run", status: "dry_run", next_attempt_at: "" }],
				state: S.readState(db), nowIso: old,
			});
		},
	});
	t.eq(w.chr.jobs(), { sweep: false, prune: true }, "§4 tables exist and the switch is off: the prune only");
	t.eq([w.startsJob, w.intervals.map((i) => i.ms)], [["C.H. Robinson prune (at boot, then daily)"], [24 * 60 * MIN]], "§4 ...one daily timer, never the recorder's");
	t.eq(JSON.parse(w.db.prepare("SELECT payload_json FROM chr_events").get().payload_json), { loadNumber: "123456789" }, "§4 ...and it ran at boot: the 40-day-old position is cleared");
	t.eq((await w.chr.sweep()).ran, false, "§4 the recorder still does not run");
	return w;
}

async function checkOn(t, opts = {}) {
	const w = await world({ ...opts, env: { CHR_UPDATES_ENABLED: "true" } });
	t.eq([w.chr.config().updatesEnabled, w.chr.jobs()], [true, { sweep: true, prune: true }], "§5 true: the switch is on; the recorder and the prune");
	t.eq([w.startsJob, w.intervals.map((i) => i.ms)], [["C.H. Robinson recorder", "C.H. Robinson prune (at boot, then daily)"], [MIN, 24 * 60 * MIN]],
		"§5 ...each behind startsJob(): a tick a minute and a daily prune");
	const before = await w.call("GET", "/api/integrations/chr/status", SA);
	t.eq([before.status, before.json], [200, { enabled: true, sendEnabled: false, locationEnabled: false, milestones: "dry_run", location: "off", lastTickAt: "", lastSweepOk: "", lastErrorCode: "" }],
		"§5 GET /status: on, milestones in Dry run (the first-enable default), location off, no tick yet");
	t.eq(chrTables(w.db), [], "§5 ...and reading it made no table (the first tick does)");
	const unknown = await w.call("GET", "/api/integrations/chr/events", SA);
	t.eq([unknown.status, unknown.json && unknown.json.code, /json/.test(unknown.type)], [404, "NOT_FOUND", true], "§5 a path the page has no route for yet: a JSON 404, never the app page");
	t.eq((await w.call("GET", "/api/integrations/chr/status", DISP)).status, 403, "§5 a Dispatcher: 403 with the switch on too");
	await at(T0, async () => {
		const timer = w.intervals.find((i) => i.ms === MIN);
		if (timer) timer.fn();
		for (let i = 0; i < 50 && !chrTables(w.db).length; i++) await new Promise((r) => setImmediate(r));
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	});
	t.eq(chrTables(w.db), ["chr_events", "chr_loads"], "§5 the recorder's timer: its first tick makes the tables");
	t.eq(w.db.prepare("SELECT user_id, username, role, action, entity, entity_id FROM audit_trail").all(),
		[{ user_id: 0, username: "chr-integration", role: "system", action: "chr_baseline", entity: "chr", entity_id: "milestone" }], "§5 ...one system audit row: the first enable's baseline");
	t.eq(w.sockets.map((s) => [s.room, s.event, s.payload]), [["super-admin", "chr:changed", undefined]], "§5 ...and one chr:changed with no payload, to the super-admin room only");
	const after = await w.call("GET", "/api/integrations/chr/status", SA);
	t.eq([after.json && after.json.lastTickAt, after.json && after.json.milestones], [new Date(T0).toISOString(), "dry_run"], "§5 GET /status shows the tick");
	return w;
}

async function checkReplica(t, opts = {}) {
	const w = await world({ ...opts, env: { CHR_UPDATES_ENABLED: "true", CHR_SEND_ENABLED: "true", CHR_LOCATION_ENABLED: "true" }, replica: { fetch: transportSpy }, startsJobAnswer: false });
	const c = w.chr.config();
	t.eq([c.updatesEnabled, c.sendEnabled, c.locationEnabled, w.chr.jobs()], [false, false, false, { sweep: false, prune: false }], "§6 a replica: all three set to true, all three off");
	t.eq(w.startsJob, [], "§6 ...no timer is asked for");
	t.eq((await w.call("GET", "/api/integrations/chr/status", SA)).json, { enabled: false }, "§6 ...GET /status { enabled: false }");
	t.eq((await w.call("GET", "/api/integrations/chr/events", SA)).json, { error: "Not found", code: "FEATURE_OFF" }, "§6 ...every other path 404 FEATURE_OFF");
	t.eq([(await w.chr.sweep()).ran, chrTables(w.db)], [false, []], "§6 ...no sweep, no table");
	return w;
}

async function dryRunWorld(opts = {}, env = { CHR_UPDATES_ENABLED: "true" }) {
	const w = await world({
		...opts,
		env,
		sheetRows: [row("#123456789", { Status: "In Transit" })],
		before: (db) => {
			db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES ('#123456789', ?, ?, ?, ?)").run(PICKUP.lat, PICKUP.lng, DROP.lat, DROP.lng);
			db.prepare("INSERT INTO driver_emergency_contacts (user_id, position, contact_name, relationship, contact_phone, created_at, updated_at) VALUES (3, 1, ?, 'Sibling', ?, '2026-10-01', '2026-10-01')")
				.run(EMERGENCY.name, EMERGENCY.phone);
		},
	});
	await at(T0, () => w.chr.sweep());
	w.ping(T0 - 4 * MIN, AT_PICKUP);
	w.history("123456789", "In Transit", T0 + MIN);
	w.ping(T0 + 11 * MIN, OUTSIDE, { speed: 20 });
	await at(T0 + 2 * MIN, () => w.chr.sweep());
	await at(T0 + 14 * MIN, () => w.chr.sweep());
	return w;
}

async function checkDryRun(t, opts = {}) {
	const spyBefore = outbound.transport;
	const httpsBefore = outbound.https;
	const w = await dryRunWorld(opts);
	const ev = w.events();
	t.eq(ev.map((e) => [e.load_id, e.event, e.status, e.verify, e.mode]), [["123456789", "departed_pickup", "dry_run", "confirmed", "dry_run"]],
		"§7 an In Transit tap confirmed by the truck's pings: one dry_run row (\"would have been sent\")");
	t.eq(ev.length ? JSON.parse(ev[0].payload_json || "{}") : null, {
		loadNumber: "123456789", event: "departed_pickup", stop: { kind: "pickup", index: 1 }, eventAt: "2026-11-02T15:01:00Z",
		eventLocal: { time: "2026-11-02T09:01:00", zone: "America/Chicago" }, place: { city: "Ames", state: "IA" }, truck: "T-101", trailer: "53001",
	}, "§7 ...holding exactly the allowlisted payload: no position (positions are off), no name, no money");
	t.eq([outbound.transport - spyBefore, outbound.https - httpsBefore], [0, 0], "§7 the transport spy was never called and nothing reached the network");
	t.ok(w.resolverCalls.truck >= 1 && w.resolverCalls.device >= 1 && w.cacheCalls >= 1, "§7 (check) the pipeline read the sheet and used both resolvers", w.resolverCalls);
	return w;
}

async function checkCanary(t, opts = {}) {
	const w = await dryRunWorld(opts, { CHR_UPDATES_ENABLED: "true", CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: DENY_CANARY });
	// The canaries also sit in cells the allowlist reads: the trailer and both addresses.
	w.cache = deepFreeze({
		headers: HEADERS.slice(),
		data: [row("#223456789", { Status: "In Transit", "Trailer Number": `53001 ${DENY_CANARY}`, "Broker Contact Name": `${EMERGENCY.name} ${DENY_CANARY}`,
			"Pickup Address": `Attn ${EMERGENCY.name} ${EMERGENCY.phone}, 100 Test Rd, Ames, IA 50010`, "Drop-off Address": `${DENY_CANARY} Dock, 200 Sample Ave, Joliet, IL 60431` })],
	});
	w.db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES ('#223456789', ?, ?, ?, ?)").run(PICKUP.lat, PICKUP.lng, DROP.lat, DROP.lng);
	w.ping(T0 + 16 * MIN, AT_PICKUP);
	w.history("223456789", "In Transit", T0 + 20 * MIN);
	w.ping(T0 + 30 * MIN, OUTSIDE, { speed: 20 });
	await at(T0 + 21 * MIN, () => w.chr.sweep());
	await at(T0 + 33 * MIN, () => w.chr.sweep());
	const status = await w.call("GET", "/api/integrations/chr/status", SA);
	const dump = [
		...w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).filter((n) => !INPUT_TABLES.includes(n))
			.flatMap((n) => w.db.prepare(`SELECT * FROM "${n}"`).all().map((r) => JSON.stringify(r))),
		...w.sockets.map((s) => JSON.stringify(s)), ...w.logs, status.text, JSON.stringify(w.chr.config()), JSON.stringify(w.chr.status()),
	].join("\n").toLowerCase();
	const planted = { deny: DENY_CANARY, driver: DRIVER_NAME, emergencyName: EMERGENCY.name, emergencyPhone: EMERGENCY.phone, agent: AGENT, money: MONEY };
	t.eq(Object.entries(planted).filter(([, v]) => dump.includes(v.toLowerCase())).map(([k]) => k), [],
		"§8 NL1: no canary in GET /status, any chr_* row, a setting, the state, an audit row, a notice, a socket message, a log line or the config view");
	t.eq(w.events().map((e) => `${e.load_id}:${e.status}`), ["123456789:dry_run", "223456789:dry_run"], "§8 ...while the pipeline ran on both loads");
	t.ok(w.db.prepare("SELECT SUM(fields_dropped) AS n FROM chr_events").get().n >= 1, "§8 ...and dropped the planted trailer, counted");
	const inputs = INPUT_TABLES.flatMap((n) => w.db.prepare(`SELECT * FROM "${n}"`).all().map((r) => JSON.stringify(r))).join("\n").toLowerCase();
	t.ok(inputs.includes(DENY_CANARY) && inputs.includes(EMERGENCY.name.toLowerCase()), "§8 (check) the same read finds the canaries in the runner's own inputs, so the check above would catch them");
	return w;
}

async function checkNotices(t, opts = {}) {
	const w = await world({ ...opts });
	t.eq([w.out.CHR_NOTICE_TYPE, realChr.NOTICE_TYPE], ["chr-attention", "chr-attention"], "§9 server.js's CHR notice type is the lib's");
	const add = (type, title) => w.db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, 'made-up body', '{}')").run(type, title).lastInsertRowid;
	add("new-load", "New Load 123456780");
	const chrId = add(realChr.NOTICE_TYPE, "C.H. Robinson: made-up notice");
	const types = (r) => ((r.json && r.json.notifications) || []).map((n) => n.type);
	const sa = await w.call("GET", "/api/dispatch-notifications", SA);
	const disp = await w.call("GET", "/api/dispatch-notifications", DISP);
	t.eq([sa.status, types(sa), sa.json && sa.json.unreadCount], [200, ["chr-attention", "new-load"], 2], "§9 a Super Admin's GET /api/dispatch-notifications lists the CHR notice");
	t.eq([disp.status, types(disp), disp.json && disp.json.unreadCount], [200, ["new-load"], 1], "§9 a Dispatcher's never lists it, nor counts it");
	await w.call("PUT", "/api/dispatch-notifications/read", DISP, { body: { ids: [chrId] } });
	await w.call("PUT", "/api/dispatch-notifications/read", DISP, { body: {} });
	t.eq(w.db.prepare("SELECT read FROM dispatch_notifications WHERE id = ?").get(chrId).read, 0, "§9 a Dispatcher's mark-read (by id, or all) leaves it unread");
	return w;
}

// ------------------------------------------------------------------ §10: the refresh step
function seedCopy(file, { chr = true } = {}) {
	const db = new Database(file);
	db.pragma("journal_mode = DELETE");
	for (const n of ["app_settings", "server_state", "load_status_history"]) db.exec(createSql(n));
	if (chr) {
		S.ensureSchema(db);
		const at0 = "2026-10-20T15:00:00.000Z";
		const statuses = [["pending", "dry_run"], ["held", "dry_run"], ["sending", "live"], ["failed", "live"], ["gave_up", "live"], ["outcome_unknown", "live"], ["sent", "live"],
			["dry_run", "dry_run"], ["superseded", "live"], ["skipped_off", "dry_run"], ["skipped_not_chr", "dry_run"]];
		S.applyRecording(db, {
			inserts: statuses.map(([status, mode], i) => ({
				load_id: `12345678${i}`, kind: i === 8 ? "location" : "milestone", event: i === 8 ? "location" : "departed_pickup", stop_kind: "pickup", stop_index: 1, source: "manual",
				history_row_id: i + 1, event_at: at0, verify: "confirmed", idem_key: `ms|12345678${i}|departed_pickup|p1|h${i + 1}`, mode, status,
				hold_reason: status === "held" ? "tap_unverified" : "", skip_reason: status.startsWith("skipped_") ? (status === "skipped_off" ? "baseline" : "load_missing") : "",
				payload_json: JSON.stringify({ loadNumber: `12345678${i}`, position: { lat: 41.5, lng: -88.1 } }), next_attempt_at: status === "pending" ? at0 : "",
			})),
			loads: [{ load_id: "123456780", multi_stop: true, multi_stop_why: "history", last_event: "departed_pickup", last_event_at: at0 }],
			state: { ...S.readState(db), cursor: 41, baselineId: 7, lastMode: "dry_run", lastTickAt: at0, firstEnabledAt: "2026-10-01T00:00:00.000Z", withheldRows: 3 },
			nowIso: at0,
		});
		S.setHold(db, { loadId: "123456780", hold: true, reason: "made-up hold", by: "made_up_admin", nowIso: at0, redactor: E.createRedactor({}) });
		S.writeSettings(db, { ...S.DEFAULT_SETTINGS, milestones: "live", location: "dry_run", arrivedPickup: true, settleMin: 7 }, { by: "made_up_admin", nowIso: at0 });
	}
	db.close();
}
function runRefresh(script, from, emit) {
	const r = spawnSync(process.execPath, [script, "--sanitize-only", "--from", from, "--emit", emit], { encoding: "utf8", timeout: 50000, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.tmpdir() } });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const rowsOf = (db, table) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
	? db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all().map(({ updated_at: _u, ...rest }) => rest) : null);
const viewOf = (db) => ({
	events: rowsOf(db, "chr_events"), loads: rowsOf(db, "chr_loads"), settings: S.readSettings(db), state: S.readState(db),
	settingsBy: (db.prepare("SELECT updated_by FROM app_settings WHERE key = ?").get(S.SETTINGS_KEY) || {}).updated_by || "",
});

async function checkRefresh(t, script = REFRESH_SCRIPT) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chr-wiring-refresh-"));
	try {
		if (path.dirname(script) !== __dirname) fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(path.dirname(script), "node_modules"), "dir");
		const seed = path.join(dir, "seed.db");
		seedCopy(seed);
		const expected = path.join(dir, "expected.db");
		fs.copyFileSync(seed, expected);
		const ex = new Database(expected);
		const counts = S.resetForRefresh(ex, "2026-11-02T15:00:00.000Z");
		const want = viewOf(ex);
		ex.close();
		const emit = path.join(dir, "out.db.gz");
		const r = runRefresh(script, seed, emit);
		t.eq(r.code, 0, "§10 refresh-env.js --sanitize-only runs on a made-up copy", r.out.split("\n").slice(-6).join(" | "));
		let got = null;
		if (fs.existsSync(emit)) {
			const outDb = path.join(dir, "out.db");
			fs.writeFileSync(outDb, zlib.gunzipSync(fs.readFileSync(emit)));
			const od = new Database(outDb, { readonly: true });
			got = viewOf(od);
			od.close();
		}
		t.eq(got, want, "§10 ...and leaves the CHR tables, settings and state exactly as resetForRefresh() does (updated_at aside)");
		t.eq(want.events ? want.events.map((e) => [e.status, e.payload_json]) : null, [
			["skipped_refresh", ""], ["skipped_refresh", ""], ["skipped_refresh", ""], ["skipped_refresh", ""], ["skipped_refresh", ""], ["skipped_refresh", ""],
			["sent", ""], ["dry_run", ""], ["superseded", ""], ["skipped_off", ""], ["skipped_not_chr", ""],
		], "§10 (check) what that is: every row not sent, dry-run or skipped becomes skipped_refresh, and every payload is emptied");
		t.eq([want.settings.milestones, want.settings.location, want.settings.settleMin, want.state.cursor, want.state.lastTickAt, want.state.withheldRows, want.loads && want.loads[0].hold],
			["off", "off", 7, 0, "", 3, 0], "§10 (check) ...both modes Off, the cursor and heartbeat cleared, holds cleared, the rest kept");
		t.ok(new RegExp(`chr_events: ${counts.rowsSkipped} unsent row\\(s\\) skipped, ${counts.payloadsCleared} payload\\(s\\) cleared`).test(r.out), "§10 ...and the summary says how much it reset");
		const bare = path.join(dir, "bare.db");
		seedCopy(bare, { chr: false });
		const emit2 = path.join(dir, "bare.db.gz");
		const r2 = runRefresh(script, bare, emit2);
		let bareView = null;
		if (fs.existsSync(emit2)) {
			const outDb = path.join(dir, "bare-out.db");
			fs.writeFileSync(outDb, zlib.gunzipSync(fs.readFileSync(emit2)));
			const od = new Database(outDb, { readonly: true });
			bareView = { tables: chrTables(od), keys: od.prepare("SELECT key FROM app_settings UNION ALL SELECT key FROM server_state").all().map((x) => x.key) };
			od.close();
		}
		t.eq([r2.code, bareView], [0, { tables: [], keys: [] }], "§10 a copy without the CHR tables: none made, no CHR setting or state written");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------------------------------ mutants
const mutateBlock = (from, to) => {
	if (!BLOCK.includes(from)) throw new Error(`mutant: the block has no ${JSON.stringify(from)}`);
	return BLOCK.replace(from, to);
};
// The lib as the block requires it, with one method of the instance changed.
const wrapInstance = (change) => (lib) => ({ ...lib, create: (deps) => change(lib.create(deps), deps) });

// A mutant is caught when its check fails, or throws with `throwRe`'s message
// (a refusal the code makes on purpose). Any other throw is a broken mutant, not
// a catch. Mutated texts are built before this runs, so a mutant whose edit no
// longer applies stops the runner instead of passing as caught.
async function mutantFails(label, check, { throwRe = null } = {}) {
	const t = collector();
	let threw = null;
	try {
		await check(t);
	} catch (err) {
		threw = err;
	}
	await closeAll();
	const by = threw ? `throw: ${String(threw.message).slice(0, 90)}` : t.failures.length ? `check: ${t.failures[0].split("\n")[0]}` : "";
	const caught = threw ? Boolean(throwRe && throwRe.test(String(threw.message))) : t.failures.length > 0;
	T.ok(caught, `§11 caught: ${label}`, caught ? undefined : threw ? `it threw something else: ${threw.message}` : `its check passed (${t.pass} assertions)`);
	if (caught) console.log(`  ${label}: ${by}`);
}

async function main() {
	section("§1  server.js around the block");
	await checkSource(T);
	const ON_VALUES = ["true", "1", "yes", "on", "TRUE", " On "];
	const OFF_VALUES = ["false", "0", "no", "off", "", "enabled", "truthy", undefined];
	const read = async (v) => (await world({ env: v === undefined ? {} : { CHR_UPDATES_ENABLED: v }, listen: false })).chr.config().updatesEnabled;
	T.eq(await Promise.all(ON_VALUES.map(read)), ON_VALUES.map(() => true), `§1 on: ${ON_VALUES.map((v) => JSON.stringify(v)).join(", ")}`);
	T.eq(await Promise.all(OFF_VALUES.map(read)), OFF_VALUES.map(() => false), `§1 off: ${OFF_VALUES.map((v) => JSON.stringify(v)).join(", ")}`);

	section("§2  what the block hands the lib");
	await checkHandover(T);

	section("§3  the switch off");
	await checkOff(T);
	await closeAll();

	section("§4  tables exist, the switch off: the prune only");
	await checkTablesOff(T);

	section("§5  the switch on");
	await checkOn(T);
	await closeAll();

	section("§6  a replica");
	await checkReplica(T);
	await closeAll();
	for (const name of ["CHR_UPDATES_ENABLED", "CHR_SEND_ENABLED", "CHR_LOCATION_ENABLED"]) {
		const why = replicaRules.enableRefusal(name);
		T.ok(typeof why === "string" && /C\.H\. Robinson/.test(why) && !replicaRules.ENABLE_ALLOWED.includes(name), `§6 replica:start --enable ${name} is refused, naming C.H. Robinson`, why);
	}

	section("§7  a Dry run through the wiring");
	await checkDryRun(T);
	await closeAll();

	section("§8  NL1: the canaries");
	await checkCanary(T);
	await closeAll();

	section("§9  the CHR notice type");
	await checkNotices(T);
	await closeAll();

	section("§10 the refresh step");
	await checkRefresh(T);

	section("§11 mutants");
	// Every edited text is built here, first: an edit that no longer applies stops the runner.
	const M = {
		shape: mutateBlock('/^(true|1|yes|on)$/i.test(String(process.env.CHR_UPDATES_ENABLED ?? "").trim())', 'String(process.env.CHR_UPDATES_ENABLED ?? "").trim() !== "false"'),
		fetchDep: mutateBlock("\tlogAudit,\n", "\tlogAudit,\n\tfetch,\n"),
		recorderOff: mutateBlock("if (chr.jobs().sweep && startsJob(", "if (startsJob("),
		pruneNoTables: mutateBlock("if (chr.jobs().prune && startsJob(", "if (startsJob("),
		pruneDropped: mutateBlock("if (chr.jobs().prune && startsJob(", "if (chr.jobs().sweep && startsJob("),
		replica: mutateBlock("replica: Boolean(REPLICA),", "replica: false,"),
		normalizedKey: mutateBlock("r ? r.loadIdCell || key : key", "key"),
		noLiveView: mutateBlock("projectView(liveJobTrackingView(await getJobTrackingCached()))", "projectView(await getJobTrackingCached())"),
		noDeny: mutateBlock('|| "",\n\t\treplica', '&& "",\n\t\treplica'),
		noticeScope: (() => {
			const from = ", AUTO_INVOICE_NOTICE_TYPE, CHR_NOTICE_TYPE]";
			if (!LIFT.text.includes(from)) throw new Error("mutant: noticeTypeScope() names no CHR_NOTICE_TYPE");
			return LIFT.text.replace(from, ", AUTO_INVOICE_NOTICE_TYPE]");
		})(),
		refresh: (() => {
			const src = fs.readFileSync(REFRESH_SCRIPT, "utf8");
			const a = src.indexOf("\t// The C.H. Robinson outbox, so a refreshed copy");
			const b = a < 0 ? -1 : src.indexOf("\n\t}\n", src.indexOf("summary.push(`chr_events:", a));
			if (a < 0 || b < 0) throw new Error("mutant: refresh-env.js has no CHR step to remove");
			return src.slice(0, a) + src.slice(b + 3);
		})(),
	};
	await mutantFails("the switch read as anything but the default-off shape", (t) => checkSource(t, M.shape));
	await mutantFails("a block handing the lib a transport (fetch)", (t) => checkDryRun(t, { blockText: M.fetchDep }), { throwRe: /fetch is not a dependency of this module/ });
	// A transport call whose failure the sweep swallows: only the spy's count sees it.
	await mutantFails("a Dry run that calls a transport", (t) => checkDryRun(t, {
		libWrap: wrapInstance((inst) => ({ ...inst, sweep: async () => { try { globalThis.fetch("https://chr.example.test/made-up"); } catch { /* swallowed */ } return inst.sweep(); } })),
	}));
	const offAnswer = (res) => res.status(404).json({ error: "Not found", code: "FEATURE_OFF" });
	await mutantFails("a status read that makes the tables with the switch off", (t) => checkOff(t, {
		libWrap: wrapInstance((inst, deps) => ({ ...inst, mount: (app, g) => app.use(realChr.MOUNT_PATH, g.requireRole("Super Admin"), (req, res) => {
			S.ensureSchema(deps.db);
			return req.method === "GET" && req.path === "/status" ? res.json(inst.status()) : offAnswer(res);
		}) })),
	}));
	await mutantFails("a recorder started with the switch off", (t) => checkOff(t, { blockText: M.recorderOff }));
	await mutantFails("GET /status answering more than { enabled: false } while off", (t) => checkOff(t, {
		libWrap: wrapInstance((inst) => ({ ...inst, mount: (app, g) => app.use(realChr.MOUNT_PATH, g.requireRole("Super Admin"), (req, res) => (
			req.method === "GET" && req.path === "/status" ? res.json({ ...inst.status(), ...inst.config() }) : offAnswer(res))) })),
	}));
	await mutantFails("another path falling through to the app page while off", (t) => checkOff(t, {
		libWrap: wrapInstance((inst) => ({ ...inst, mount: (app, g) => app.use(realChr.MOUNT_PATH, g.requireRole("Super Admin"), (req, res, next) => (req.path === "/status" ? res.json(inst.status()) : next())) })),
	}));
	await mutantFails("routes mounted without the Super Admin gate", (t) => checkOff(t, {
		libWrap: wrapInstance((inst) => ({ ...inst, mount: (app) => inst.mount(app, { requireRole: () => (req, res, next) => next() }) })),
	}));
	await mutantFails("a prune timer with no tables (NL5)", (t) => checkOff(t, { blockText: M.pruneNoTables }));
	await mutantFails("the prune left out once the tables exist (NL5)", (t) => checkTablesOff(t, { blockText: M.pruneDropped }));
	await mutantFails("a replica flag not handed in", (t) => checkReplica(t, { blockText: M.replica }));
	await mutantFails("a stop point looked up under the normalized key", (t) => checkDryRun(t, { blockText: M.normalizedKey }));
	await mutantFails("a sheet reader without the live view (cancelled and deleted loads kept)", (t) => checkHandover(t, { blockText: M.noLiveView }));
	await mutantFails("a projection carrying the Payment", (t) => checkHandover(t, {
		libWrap: (lib) => ({ ...lib, projectView: (v) => { const out = lib.projectView(v); for (const [k, p] of out.projections) out.projections.set(k, { ...p, payment: MONEY }); return out; } }),
	}));
	await mutantFails("the deny list not handed to the lib", (t) => checkHandover(t, { blockText: M.noDeny }));
	await mutantFails("GET /status showing the deny list (NL1)", (t) => checkCanary(t, {
		libWrap: (lib, w) => ({ ...lib, create: (deps) => {
			const inst = lib.create(deps);
			const leaky = () => ({ ...inst.status(), deny: String(w.env.CARRIER_ACCOUNT_NUMBERS_DENY_SECRET) });
			return { ...inst, status: leaky, mount: (app, g) => app.use(realChr.MOUNT_PATH, g.requireRole("Super Admin"), (req, res) => res.json(leaky())) };
		} }),
	}));
	await mutantFails("noticeTypeScope() without the CHR notice type", (t) => checkNotices(t, { liftText: M.noticeScope }));
	await mutantFails("a refresh-env.js without the CHR step", async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chr-wiring-mutant-"));
		try {
			const copy = path.join(dir, "refresh-env.js");
			fs.writeFileSync(copy, M.refresh);
			await checkRefresh(t, copy);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}

main().then(async () => {
	await closeAll();
	console.log(`\n${"=".repeat(64)}`);
	if (T.failures.length) {
		console.log(`FAILURES (${T.failures.length}):`);
		T.failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${T.pass} passed, ${T.failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${T.pass} assertions passed`);
	process.exit(0);
}).catch(async (err) => {
	console.error(err);
	await closeAll();
	process.exit(1);
});
