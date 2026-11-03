#!/usr/bin/env node
/**
 * The C.H. Robinson page's routes (R5 PR 2: plan 4.17), lib/chr-routes.js, as
 * lib/chr-integration.js mounts them: server.js's own requireRole and
 * refuseCrossOrigin (lifted, scripts/lib/server-lift.js) in front, on a real
 * Express app on 127.0.0.1, over an in-memory database with server.js's own
 * tables. The recorder runs for real (lib/chr-sweep.js) with a made-up sheet,
 * made-up resolvers and a made-up clock.
 *
 *   §1  registrations: one app.use at /api/integrations/chr, the role gate first;
 *       mount() refuses to run without the role gate or the same-origin guard;
 *       the router's routes, each write with refuseCrossOrigin before its limiter
 *   §2  the gates over HTTP: signed out 401 and every other role 403 on every
 *       route, with nothing read or written; a write without X-Requested-With and
 *       a cross-origin write refused, the latter before the limiter; a malformed
 *       :loadId 400 before any lookup
 *   §3  GET /status: the switches, each kind's mode, the settings, today's counts
 *       and whether this account may choose Live
 *   §4  GET /events: the allowlisted fields only (the stored payload filtered
 *       again), newest first, 50 a page, the filters, 400 on a bad filter
 *   §5  GET /loads and GET /loads/:loadId: counts, the rows, the POD count and
 *       whether the newest draft went to CHR (never its address); a JSON 404 for
 *       a load with no CHR updates
 *   §6  PUT /settings: validated, partial; one audit row per mode change and one
 *       for the rest; nothing written or audited without a change; Live refused
 *       (409 SEND_NOT_PERMITTED) for an unlisted account or the shared login, with
 *       sending off, and with no connection
 *   §7  POST /stop: every kind Off at once, audited, always allowed
 *   §8  POST /loads/:loadId/hold: a reason needed; hold and release audited; a
 *       release sends the load's held updates back through the CHR-load test and
 *       the proximity test; 30 a quarter hour per account
 *   §9  the switch off: GET /status { enabled: false }, every other route a JSON
 *       404 FEATURE_OFF, no table made, nothing audited
 *   §10 canaries: no driver name or phone, agent address, money or deny value in
 *       any answer or audit row
 *   §11 every write tells the page (onChange); no read does
 *   §12 an unknown path: a JSON 404, never the app page
 *   §13 mutants: a router that breaks each rule above fails its check
 *
 * Made-up data only (loads 123456789 and 223456789, truck T-101). In-memory
 * SQLite; no network beyond the loopback listener.
 * Run: node scripts/test-chr-routes.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const express = require(path.join(ROOT, "node_modules", "express"));
const { closure } = require(path.join(__dirname, "lib", "server-lift.js"));
const I = require(path.join(ROOT, "lib", "chr-integration.js"));
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const listed = require(path.join(ROOT, "lib", "listed-accounts.js"));
const ROUTES_FILE = path.join(ROOT, "lib", "chr-routes.js");
const ROUTES_SRC = fs.existsSync(ROUTES_FILE) ? fs.readFileSync(ROUTES_FILE, "utf8") : "";
const serverRequire = createRequire(path.join(ROOT, "server.js"));
const libRequire = createRequire(ROUTES_FILE);

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

// ------------------------------------------------------------------ made-up data
const MIN = 60 * 1000;
const T0 = Date.parse("2026-11-02T15:00:00Z");
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const SA = Object.freeze({ id: 1, username: "made_up_admin", role: "Super Admin" });
const SA2 = Object.freeze({ id: 7, username: "made_up_admin_two", role: "Super Admin" });
const SHARED = Object.freeze({ id: 9, username: "super_admin", role: "Super Admin" });
const DISP = Object.freeze({ id: 2, username: "made_up_dispatcher", role: "Dispatcher" });
const DRIVER = Object.freeze({ id: 3, username: "made_up_driver", role: "Driver" });
const INVESTOR = Object.freeze({ id: 4, username: "made_up_investor", role: "Investor" });
const DRIVER_NAME = "Canary Testdriver";
const DRIVER_PHONE = "(555) 555-0142";
const AGENT = "made-up.agent@chrobinson.com";
const MONEY = "$1,234.56";
const DENY_CANARY = "77700011122233";
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment"];
const PICKUP = Object.freeze({ lat: 42.0347, lng: -93.62 });
const DROP = Object.freeze({ lat: 41.525, lng: -88.0817 });
const AT_PICKUP = Object.freeze({ lat: 42.035, lng: -93.6195 });
const OUTSIDE = Object.freeze({ lat: 42.08, lng: -93.62 });
const sheetRow = (loadId, over = {}) => ({
	"Load ID": loadId, Status: "In Transit", Driver: DRIVER_NAME, Email: AGENT, "Trailer Number": "53001",
	"Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: MONEY, ...over,
});

// ------------------------------------------------------------------ server.js, lifted
const PROVIDED = ["db", "console", "process", "require"];
const LIFT = closure(SRC, { roots: ["requireRole", "refuseCrossOrigin"], provided: PROVIDED, denied: ["app", "server", "io"] });
const createSql = (name) => {
	const at0 = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	if (at0 < 0) throw new Error(`server.js creates no ${name} table`);
	return SRC.slice(at0, SRC.indexOf("`", at0));
};
const altersOf = (name) => [...SRC.matchAll(new RegExp(`db\\.exec\\((["\`])(ALTER TABLE ${name} ADD COLUMN [^"\`]+)\\1\\)`, "g"))].map((m) => m[2]);
const TABLES = ["app_settings", "server_state", "load_status_history", "routemate_telemetry", "documents", "load_invoice_drafts"];
function makeDb() {
	const db = new Database(":memory:");
	for (const t of TABLES) {
		db.exec(createSql(t));
		for (const a of altersOf(t)) db.exec(a);
	}
	return db;
}
const chrTables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chr\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);

// A routes module from text: the shipped file, or a mutant of it.
function loadRoutes(text) {
	const mod = { exports: {} };
	new Function("require", "module", "exports", text)(libRequire, mod, mod.exports);
	return mod.exports;
}
const REAL = ROUTES_SRC ? loadRoutes(ROUTES_SRC) : null;

// ------------------------------------------------------------------ a world
const open = [];
async function world({ on = true, sendEnabled = false, listIds = "1,7,9", routes = REAL, viaMount = true, sheet = null } = {}) {
	const w = { audits: [], changes: 0, reads: 0, clock: T0, logs: [] };
	const db = makeDb();
	w.db = db;
	const quiet = { log: (...a) => w.logs.push(a.join(" ")), info: (...a) => w.logs.push(a.join(" ")), warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) };
	const H = new Function(...PROVIDED, `${LIFT.text}\nreturn { ${LIFT.names.join(", ")} };`)(db, quiet, { env: {} }, serverRequire);
	w.H = H;
	w.sheetRows = sheet || [sheetRow("#123456789"), sheetRow("223456789")];
	const config = I.chrConfig({ updatesEnabled: on, sendEnabled, denyList: DENY_CANARY });
	const deps = {
		db,
		config,
		readSheet: async () => {
			const m = new Map();
			for (const r of w.sheetRows) { const p = E.projectRow(r, HEADERS); if (p.loadKey && !m.has(p.loadKey)) m.set(p.loadKey, p); }
			return m;
		},
		stopPointsFor: () => ({ origin: { latitude: PICKUP.lat, longitude: PICKUP.lng }, dest: { latitude: DROP.lat, longitude: DROP.lng } }),
		truckResolver: () => ({ forDriverAt: (name) => (String(name).toLowerCase() === DRIVER_NAME.toLowerCase() ? { truck_id: 1, unit: "T-101" } : null) }),
		deviceResolver: () => ({ vehicleForTruckAt: (id) => (id === 1 ? "RM-TEST-1" : "") }),
		logAudit: (req, action, entity, entityId, details) => w.audits.push({ by: (req && req.session && req.session.user && req.session.user.username) || "", action, entity, entityId, details }),
		onChange: () => { w.changes++; },
		now: () => w.clock,
		log: quiet,
	};
	// Handed in only where the integration takes it, so a tree without it still runs the routes it has.
	const list = listed.parseListedAccountIds(listIds === null ? undefined : listIds);
	if (I.DEP_NAMES.includes("listedAccounts")) deps.listedAccounts = list;
	w.inst = I.create(deps);
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		const u = req.headers["x-test-user"];
		req.session = u ? { user: JSON.parse(u) } : {};
		next();
	});
	w.registered = [];
	w.gates = [];
	const recorder = {};
	for (const verb of ["get", "put", "post", "use"]) recorder[verb] = (...a) => { w.registered.push([verb, ...a]); return app[verb](...a); };
	const guards = { requireRole: (...roles) => { const g = H.requireRole(...roles); w.gates.push({ roles, g }); return g; }, refuseCrossOrigin: H.refuseCrossOrigin };
	if (viaMount) {
		w.inst.mount(recorder, guards);
	} else {
		routes.mount(recorder, {
			db, config, on, status: w.inst.status, logAudit: deps.logAudit, onChange: deps.onChange, now: deps.now, log: quiet, listedAccounts: list,
		}, guards);
	}
	app.get("*", (req, res) => res.status(200).type("html").send("<!doctype html><title>made-up app page</title>"));
	w.server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
	const base = `http://127.0.0.1:${w.server.address().port}`;
	w.call = async (method, url, user, { body, xrw = true, headers = {} } = {}) => {
		const h = { "content-type": "application/json", ...headers };
		if (xrw) h["x-requested-with"] = "XMLHttpRequest";
		if (user) h["x-test-user"] = JSON.stringify(user);
		const resp = await fetch(`${base}${I.MOUNT_PATH}${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await resp.text();
		let json = null;
		try { json = JSON.parse(text); } catch { json = null; }
		return { status: resp.status, json, text, type: resp.headers.get("content-type") || "" };
	};
	w.tick = async (ms) => { w.clock = ms; return w.inst.sweep(); };
	w.history = (key, status, ms) => db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, reason) VALUES (?, '', ?, 'manual', ?, ?, ?)")
		.run(key, status, `${DRIVER_NAME} ${DRIVER_PHONE}`, stamp(ms), `made-up note ${DENY_CANARY}`).lastInsertRowid;
	w.ping = (ms, p, speed = 0) => db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source, geocoded_location)
		VALUES ('RM-TEST-1', ?, ?, ?, ?, '', 'routemate', ?)`).run(p.lat, p.lng, speed, ms, `${DRIVER_NAME}, 742 Evergreen Terrace, Ames, IA`);
	w.rows = () => db.prepare("SELECT load_id, event, status, hold_reason, skip_reason, verify, mode FROM chr_events ORDER BY id").all();
	w.settings = () => S.readSettings(db);
	w.close = async () => {
		if (!w.server) return;
		w.server.closeAllConnections();
		await new Promise((r) => w.server.close(() => r()));
		w.server = null;
	};
	open.push(w);
	return w;
}
async function closeAll() {
	for (const w of open.splice(0)) await w.close();
}

// A recorded In Transit tap on 123456789, confirmed by the truck's pings, and
// one on 223456789 with no ping after it (it waits); both decided by T0+14.
async function recordedWorld(opts = {}) {
	const w = await world(opts);
	await w.tick(T0);
	w.ping(T0 - 4 * MIN, AT_PICKUP);
	w.history("123456789", "In Transit", T0 + MIN);
	w.ping(T0 + 11 * MIN, OUTSIDE, 20);
	w.history("223456789", "In Transit", T0 + 13 * MIN);
	await w.tick(T0 + 2 * MIN);
	await w.tick(T0 + 14 * MIN);
	w.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at) VALUES ('123456789', ?, 'POD', 'made-up-pod.pdf', '2026-11-02 16:00:00')").run(DRIVER_NAME);
	w.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at, deleted_at) VALUES ('123456789', ?, 'POD', 'made-up-old.pdf', '2026-11-02 15:30:00', '2026-11-02 15:40:00')").run(DRIVER_NAME);
	w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, created_at) VALUES ('#123456789', 'INV-MADE-UP-1', ?, ?, '2026-11-02T17:00:00Z')").run(AGENT, MONEY);
	return w;
}

const ROUTES = [
	["GET", "/status"], ["GET", "/events"], ["GET", "/loads"], ["GET", "/loads/123456789"],
	["PUT", "/settings"], ["POST", "/stop"], ["POST", "/loads/123456789/hold"],
];
const WRITES = ROUTES.filter(([m]) => m !== "GET");
const EVENT_KEYS = ["id", "loadId", "kind", "event", "stop", "source", "eventAt", "verify", "mode", "status", "holdReason", "skipReason", "attempts", "httpStatus",
	"resultCode", "fieldsDropped", "reverted", "createdAt", "sentAt", "payload"];

// ------------------------------------------------------------------ the checks
async function checkRegistrations(t, opts = {}) {
	const w = await world(opts);
	const gate = w.gates.length === 1 && JSON.stringify(w.gates[0].roles) === JSON.stringify(["Super Admin"]) ? w.gates[0].g : null;
	t.ok(gate, "§1 one gate, requireRole(\"Super Admin\")", w.gates.map((g) => g.roles));
	const name = (fn) => (fn === gate ? "requireRole" : typeof fn.resetKey === "function" ? "rateLimit" : fn === w.H.refuseCrossOrigin ? "refuseCrossOrigin" : "handler");
	t.eq(w.registered.map(([verb, p, ...fns]) => `${verb.toUpperCase()} ${p.replace(I.MOUNT_PATH, "") || "/"} · ${fns.map(name).join(" · ")}`), [
		"GET /status · requireRole · handler",
		"GET /events · requireRole · handler",
		"GET /loads · requireRole · handler",
		"GET /loads/:loadId · requireRole · handler",
		"PUT /settings · requireRole · refuseCrossOrigin · handler",
		"POST /stop · requireRole · refuseCrossOrigin · handler",
		"POST /loads/:loadId/hold · requireRole · refuseCrossOrigin · rateLimit · handler",
		"USE / · requireRole · handler",
	], "§1 the routes (plan 4.17, PR 2's part): the role gate first everywhere, each write's same-origin guard next and the hold's limiter after it, and a catch-all of the mount's own last");
	let noGuard = "";
	try { w.inst.mount({ get() {}, put() {}, post() {}, use() {} }, { requireRole: w.H.requireRole }); } catch (err) { noGuard = err.message; }
	t.ok(/refuseCrossOrigin/.test(noGuard), "§1 mount() without refuseCrossOrigin throws: no CHR write is ever served unguarded", noGuard);
	let noRole = "";
	try { w.inst.mount({ get() {}, put() {}, post() {}, use() {} }, { refuseCrossOrigin: w.H.refuseCrossOrigin }); } catch (err) { noRole = err.message; }
	t.ok(/requireRole/.test(noRole), "§1 ...nor without requireRole", noRole);
	return w;
}

async function checkGates(t, opts = {}) {
	const w = await recordedWorld(opts);
	const before = { audits: w.audits.length, settings: JSON.stringify(w.settings()), events: JSON.stringify(w.rows()) };
	let reads = 0;
	const realPrepare = w.db.prepare.bind(w.db);
	w.db.prepare = (sql) => { reads++; return realPrepare(sql); };
	for (const [label, user, code] of [["signed out", null, 401], ["a Dispatcher", DISP, 403], ["a Driver", DRIVER, 403], ["an Investor", INVESTOR, 403]]) {
		const got = [];
		for (const [m, u] of ROUTES) got.push((await w.call(m, u, user, { body: m === "GET" ? undefined : { hold: true, reason: "made-up", milestones: "off" } })).status);
		t.eq(got, ROUTES.map(() => code), `§2 ${label}: ${code} on every route`);
	}
	t.eq(reads, 0, "§2 ...and nothing was read for any of them");
	w.db.prepare = realPrepare;
	t.eq([w.audits.length, JSON.stringify(w.settings()), JSON.stringify(w.rows())], [before.audits, before.settings, before.events], "§2 ...nor written");
	for (const [m, u] of WRITES) {
		const r = await w.call(m, u, SA, { body: { hold: true, reason: "made-up" }, xrw: false });
		t.eq([r.status, r.json && r.json.code], [403, "CSRF_HEADER_REQUIRED"], `§2 ${m} ${u} without X-Requested-With: 403 from the role gate`);
		const x = await w.call(m, u, SA, { body: { hold: true, reason: "made-up" }, headers: { "sec-fetch-site": "cross-site" } });
		t.eq([x.status, x.json && x.json.code], [403, "CROSS_SITE_REFUSED"], `§2 ${m} ${u} from another site: 403 CROSS_SITE_REFUSED`);
	}
	// 31 refused cross-site holds spend none of the 30-a-quarter-hour budget.
	for (let i = 0; i < 31; i++) await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: true, reason: "made-up" }, headers: { "sec-fetch-site": "cross-site" } });
	const after = await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: true, reason: "made-up" } });
	t.eq(after.status, 200, "§2 the same-origin guard runs before the limiter: 31 refused cross-site holds leave the budget whole");
	t.eq([w.audits.length, w.changes > 0], [before.audits + 1, true], "§2 ...and only the real hold was audited");
	let lookups = 0;
	w.db.prepare = (sql) => { if (/chr_loads|chr_events|documents|load_invoice_drafts/.test(sql)) lookups++; return realPrepare(sql); };
	for (const [m, u] of [["GET", "/loads/bad%20id"], ["GET", `/loads/${"9".repeat(41)}`], ["POST", "/loads/bad%20id/hold"], ["GET", "/loads/a%3Cb"]]) {
		const r = await w.call(m, u, SA, { body: m === "GET" ? undefined : { hold: true, reason: "made-up" } });
		t.eq([r.status, r.json && r.json.code], [400, "INVALID_LOAD_ID"], `§2 ${m} ${decodeURIComponent(u)}: 400 INVALID_LOAD_ID`);
	}
	t.eq(lookups, 0, "§2 ...before any lookup");
	w.db.prepare = realPrepare;
	return w;
}

async function checkStatus(t, opts = {}) {
	const w = await recordedWorld(opts);
	const r = await w.call("GET", "/status", SA);
	const s = r.json || {};
	t.eq([r.status, s.enabled, s.sendEnabled, s.locationEnabled, s.milestones, s.location], [200, true, false, false, "dry_run", "off"], "§3 GET /status: on, sending off, milestones in Dry run, location off");
	t.eq(s.settings, { ...S.DEFAULT_SETTINGS }, "§3 ...the page's settings, normalized");
	t.eq(s.today, { dry_run: 1, pending: 1 }, "§3 ...today's rows by status (one decided, one waiting on its pings)");
	t.eq(s.live, { allowed: false, reason: "send_off" }, "§3 ...and for a listed account: Live is not allowed while sending is off");
	t.eq((await w.call("GET", "/status", SA2)).json.live, { allowed: false, reason: "send_off" }, "§3 a second listed account: the same");
	t.eq((await w.call("GET", "/status", SHARED)).json.live, { allowed: false, reason: "not_listed" }, "§3 the shared super_admin login is never listed, whatever the setting holds");
	t.eq((await w.call("GET", "/status", { id: 5, username: "made_up_admin_five", role: "Super Admin" })).json.live, { allowed: false, reason: "not_listed" }, "§3 an account not on the list: not_listed");
	return w;
}

async function checkEvents(t, opts = {}) {
	const w = await recordedWorld(opts);
	// A stored payload with a key beyond the allowlist is filtered again on the way out.
	w.db.prepare("UPDATE chr_events SET payload_json = ? WHERE load_id = '123456789'").run(JSON.stringify({ loadNumber: "123456789", event: "departed_pickup", driver: DRIVER_NAME, phone: DRIVER_PHONE }));
	const r = await w.call("GET", "/events", SA);
	const ev = (r.json && r.json.events) || [];
	t.eq([r.status, ev.map((e) => [e.loadId, e.event, e.status]), r.json && r.json.next], [200, [["223456789", "departed_pickup", "pending"], ["123456789", "departed_pickup", "dry_run"]], null],
		"§4 GET /events: newest first, no next page");
	t.ok(ev.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(EVENT_KEYS)), "§4 ...each row exactly the allowlisted fields", ev.map((e) => Object.keys(e)));
	t.eq((ev.find((e) => e.loadId === "123456789") || {}).payload, { loadNumber: "123456789", event: "departed_pickup" }, "§4 ...a stored payload filtered to the payload keys again");
	t.eq(((await w.call("GET", "/events?status=dry_run", SA)).json.events || []).map((e) => e.loadId), ["123456789"], "§4 ?status=dry_run");
	t.eq(((await w.call("GET", "/events?loadId=%23223456789", SA)).json.events || []).map((e) => e.loadId), ["223456789"], "§4 ?loadId=#223456789 (normalized as the recorder keys it)");
	const firstId = ev.length ? ev[0].id : 0;
	t.eq(((await w.call("GET", `/events?before=${firstId}`, SA)).json.events || []).map((e) => e.loadId), ["123456789"], "§4 ?before=<id>: the older page");
	for (const q of ["status=sent%27%20OR%201", "loadId=a%20b", "before=0", "before=-3", "before=abc"]) {
		const b = await w.call("GET", `/events?${q}`, SA);
		t.eq([b.status, b.json && b.json.code], [400, "INVALID_CHR_FILTER"], `§4 ?${decodeURIComponent(q)}: 400 INVALID_CHR_FILTER`);
	}
	for (let i = 0; i < 60; i++) {
		w.db.prepare(`INSERT INTO chr_events (load_id, kind, event, event_at, idem_key, mode, status, created_at, updated_at)
			VALUES ('323456789', 'milestone', 'delivered', ?, ?, 'dry_run', 'dry_run', ?, ?)`).run(new Date(T0).toISOString(), `ms|323456789|delivered|final|h${1000 + i}`, new Date(T0).toISOString(), new Date(T0).toISOString());
	}
	const p1 = (await w.call("GET", "/events", SA)).json;
	const p2 = (await w.call("GET", `/events?before=${p1.next}`, SA)).json;
	t.eq([p1.events.length, typeof p1.next, p2.events.length, p2.next], [50, "number", 12, null], "§4 50 a page; the next page from `next`");
	return w;
}

async function checkLoads(t, opts = {}) {
	const w = await recordedWorld(opts);
	const list = await w.call("GET", "/loads", SA);
	t.eq(((list.json && list.json.loads) || []).map((l) => [l.loadId, l.lastEvent, l.counts]).sort(),
		[["123456789", "departed_pickup", { dry_run: 1 }], ["223456789", "departed_pickup", { pending: 1 }]], "§5 GET /loads: the CHR loads the recorder touched, with their counts");
	const one = await w.call("GET", "/loads/%23123456789", SA);
	const j = one.json || {};
	t.eq([one.status, j.load && j.load.loadId, j.load && j.load.hold, j.counts, (j.events || []).map((e) => e.event)], [200, "123456789", false, { dry_run: 1 }, ["departed_pickup"]],
		"§5 GET /loads/#123456789: the load, its counts and its rows");
	t.eq([j.pod, j.draft], [{ count: 1 }, { at: "2026-11-02T17:00:00Z", toChr: true }], "§5 ...one live POD (a deleted one not counted); the newest draft's time, and that it went to CHR");
	t.ok(!one.text.includes("made-up.agent") && !one.text.includes("INV-MADE-UP") && !one.text.includes("1,234"), "§5 ...never the draft's address, number or total");
	const none = await w.call("GET", "/loads/923456789", SA);
	t.eq([none.status, none.json && none.json.code, /json/.test(none.type)], [404, "NOT_A_CHR_LOAD", true], "§5 a load with no CHR updates: a JSON 404");
	return w;
}

async function checkSettings(t, opts = {}) {
	const w = await world({ ...opts, sendEnabled: true });
	const bad = [
		[{ milestones: "pilot" }, "milestones"], [{ milestones: "LIVE" }, "milestones"], [{ settleMin: 16 }, "settleMin"], [{ settleMin: "5" }, "settleMin"],
		[{ arrivedPickup: "true" }, "arrivedPickup"], [{ locationIntervalMin: 10 }, "locationIntervalMin"], [{ madeUp: 1 }, "madeUp"], [[], null],
	];
	for (const [body, field] of bad) {
		const r = await w.call("PUT", "/settings", SA, { body });
		t.eq([r.status, r.json && r.json.code, r.json && r.json.field], [400, "INVALID_CHR_SETTINGS", field], `§6 ${JSON.stringify(body)}: 400 INVALID_CHR_SETTINGS (${field})`);
	}
	const proto = await w.call("PUT", "/settings", SA, { body: JSON.parse('{"__proto__": {"milestones": "live"}, "settleMin": 3}') });
	t.eq([proto.status, proto.json && proto.json.code], [400, "INVALID_CHR_SETTINGS"], "§6 a __proto__ key is refused, not ignored");
	t.eq([w.audits.length, w.changes, w.settings()], [0, 0, { ...S.DEFAULT_SETTINGS }], "§6 ...nothing refused was written, audited or announced");
	const ok1 = await w.call("PUT", "/settings", SA, { body: { settleMin: 7, arrivedPickup: true, milestones: "off" } });
	t.eq([ok1.status, ok1.json && ok1.json.changed, w.settings().settleMin, w.settings().arrivedPickup, w.settings().milestones], [200, ["milestones", "arrivedPickup", "settleMin"], 7, true, "off"],
		"§6 a partial save: the fields sent change, the rest stay");
	t.eq(w.audits.map((a) => [a.by, a.action, a.entityId, a.details]), [
		["made_up_admin", "chr_mode_change", "milestones", "milestones: dry_run → off"],
		["made_up_admin", "chr_settings_update", "settings", "arrivedPickup: false → true; settleMin: 5 → 7"],
	], "§6 ...one audit row for the mode change and one for the rest, naming before and after");
	const same = await w.call("PUT", "/settings", SA, { body: { settleMin: 7 } });
	t.eq([same.status, same.json && same.json.changed, w.audits.length, w.changes], [200, [], 2, 1], "§6 the same value again: nothing written, audited or announced");
	for (const [user, reason] of [[SHARED, "not_listed"], [{ id: 5, username: "made_up_admin_five", role: "Super Admin" }, "not_listed"], [SA, "not_connected"]]) {
		const r = await w.call("PUT", "/settings", user, { body: { milestones: "live" } });
		t.eq([r.status, r.json && r.json.code, r.json && r.json.reason], [409, "SEND_NOT_PERMITTED", reason], `§6 Live by ${user.username}: 409 SEND_NOT_PERMITTED (${reason})`);
	}
	t.eq((await w.call("PUT", "/settings", SA, { body: { location: "live" } })).json.code, "SEND_NOT_PERMITTED", "§6 ...Location's Live the same");
	t.eq([w.settings().milestones, w.audits.length], ["off", 2], "§6 ...and a refused Live changes nothing");
	t.eq((await w.call("PUT", "/settings", { id: 5, username: "made_up_admin_five", role: "Super Admin" }, { body: { milestones: "dry_run" } })).status, 200,
		"§6 any Super Admin may choose Dry run");
	return w;
}

async function checkSettingsSendOff(t, opts = {}) {
	const w = await world({ ...opts, sendEnabled: false });
	const r = await w.call("PUT", "/settings", SA, { body: { milestones: "live" } });
	t.eq([r.status, r.json && r.json.reason], [409, "send_off"], "§6 Live by a listed account with sending off: send_off");
	const unset = await world({ ...opts, sendEnabled: true, listIds: null });
	t.eq((await unset.call("PUT", "/settings", SA, { body: { milestones: "live" } })).json.reason, "not_listed", "§6 the listed-accounts setting unset: nobody may choose Live (fail closed)");
	const invalid = await world({ ...opts, sendEnabled: true, listIds: "1,x" });
	t.eq((await invalid.call("PUT", "/settings", SA, { body: { milestones: "live" } })).json.reason, "not_listed", "§6 ...set but invalid: nobody");
	return w;
}

async function checkStop(t, opts = {}) {
	const w = await world(opts);
	S.writeSettings(w.db, { ...S.DEFAULT_SETTINGS, milestones: "dry_run", location: "dry_run" }, { by: "made_up_admin", nowIso: new Date(T0).toISOString() });
	const r = await w.call("POST", "/stop", { id: 5, username: "made_up_admin_five", role: "Super Admin" }, { body: {} });
	t.eq([r.status, w.settings().milestones, w.settings().location, r.json && r.json.milestones], [200, "off", "off", "off"], "§7 POST /stop by any Super Admin: every kind Off at once");
	t.eq(w.audits.map((a) => [a.action, a.entityId, a.details]), [["chr_mode_change", "all", "Stop everything: milestones: dry_run → off; location: dry_run → off"]], "§7 ...one audit row naming each kind");
	const again = await w.call("POST", "/stop", SA, { body: {} });
	t.eq([again.status, w.audits.length], [200, 2], "§7 ...and always allowed, already off included");
	return w;
}

async function checkHold(t, opts = {}) {
	const w = await world(opts);
	await w.tick(T0);
	w.ping(T0 - 4 * MIN, AT_PICKUP);
	w.history("123456789", "In Transit", T0 + MIN);
	w.ping(T0 + 11 * MIN, OUTSIDE, 20);
	w.history("223456789", "In Transit", T0 + MIN);
	await w.tick(T0 + 2 * MIN);
	for (const body of [{ hold: true }, { hold: true, reason: "   " }, { hold: "yes", reason: "made-up" }, { reason: "made-up" }, { hold: true, reason: "x".repeat(201) }]) {
		const r = await w.call("POST", "/loads/123456789/hold", SA, { body });
		t.eq([r.status, r.json && r.json.code], [400, "INVALID_CHR_HOLD"], `§8 ${JSON.stringify(body).slice(0, 60)}: 400 INVALID_CHR_HOLD`);
	}
	const unknown = await w.call("POST", "/loads/923456789/hold", SA, { body: { hold: true, reason: "made-up" } });
	t.eq([unknown.status, unknown.json && unknown.json.code], [404, "NOT_A_CHR_LOAD"], "§8 a load the recorder never saw: 404 NOT_A_CHR_LOAD");
	w.clock = T0 + 3 * MIN;
	const held = await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: true, reason: `check the reference ${DENY_CANARY}` } });
	t.eq([held.status, held.json && held.json.load && held.json.load.hold, held.json && held.json.load && held.json.load.holdReason], [200, true, "check the reference [withheld]"],
		"§8 a hold: kept with its reason (redacted)");
	await w.call("POST", "/loads/223456789/hold", SA, { body: { hold: true, reason: "made-up second hold" } });
	await w.tick(T0 + 8 * MIN);
	t.eq(w.rows().map((r) => [r.load_id, r.status, r.hold_reason]), [["123456789", "held", "load_hold"], ["223456789", "held", "load_hold"]], "§8 ...the next decision holds the loads' updates");
	// Released after 223456789 has moved to another broker: the checks run again.
	w.sheetRows = [sheetRow("#123456789"), sheetRow("223456789", { Email: "made-up.agent@example-broker.test" })];
	w.clock = T0 + 9 * MIN;
	const rel = await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: false, reason: "made-up: checked" } });
	await w.call("POST", "/loads/223456789/hold", SA, { body: { hold: false, reason: "made-up: checked" } });
	t.eq([rel.status, rel.json && rel.json.released, rel.json && rel.json.load && rel.json.load.hold], [200, 1, false], "§8 a release: one held update goes back to the checks");
	t.eq(w.rows().map((r) => r.status), ["pending", "pending"], "§8 ...pending again");
	await w.tick(T0 + 14 * MIN);
	t.eq(w.rows().map((r) => [r.load_id, r.status, r.verify, r.skip_reason]), [["123456789", "dry_run", "confirmed", ""], ["223456789", "skipped_not_chr", "waiting", "other_broker"]],
		"§8 ...and the next tick runs the proximity test (confirmed: dry run) and the CHR-load test (another broker now: skipped)");
	const people = w.audits.filter((a) => a.by !== "chr-integration");
	t.eq(people.map((a) => [a.action, a.entityId]), [["chr_load_hold", "123456789"], ["chr_load_hold", "223456789"], ["chr_load_release", "123456789"], ["chr_load_release", "223456789"]],
		"§8 each hold and release audited");
	t.eq((people[2] || {}).details, "Released (1 held update(s) go back to the checks): made-up: checked", "§8 ...a release names how many go back and why");
	t.ok(!JSON.stringify(w.audits).includes(DENY_CANARY), "§8 ...and a deny value typed into a reason is withheld there too");
	return w;
}

async function checkHoldLimit(t, opts = {}) {
	const w = await world(opts);
	await w.tick(T0);
	w.history("123456789", "At Shipper", T0 + MIN);
	await w.tick(T0 + 2 * MIN);
	const codes = [];
	for (let i = 0; i < 31; i++) codes.push((await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: i % 2 === 0, reason: "made-up" } })).status);
	t.eq([codes.slice(0, 30).every((c) => c === 200), codes[30]], [true, 429], "§8 30 holds and releases a quarter hour per account; the 31st 429");
	t.eq((await w.call("POST", "/loads/123456789/hold", SA2, { body: { hold: true, reason: "made-up" } })).status, 200, "§8 ...counted per account");
	return w;
}

async function checkOff(t, opts = {}) {
	const w = await world({ ...opts, on: false });
	const r = await w.call("GET", "/status", SA);
	t.eq([r.status, r.json], [200, { enabled: false }], "§9 off: GET /status { enabled: false }");
	for (const [m, u] of [...ROUTES.slice(1), ["GET", "/nothing"]]) {
		const x = await w.call(m, u, SA, { body: m === "GET" ? undefined : { hold: true, reason: "made-up", milestones: "off" } });
		t.eq([x.status, x.json && x.json.code, /json/.test(x.type)], [404, "FEATURE_OFF", true], `§9 off: ${m} ${u}: JSON 404 FEATURE_OFF`);
	}
	t.eq([chrTables(w.db), w.audits.length, w.changes, w.db.prepare("SELECT COUNT(*) AS n FROM app_settings").get().n], [[], 0, 0, 0], "§9 ...no table, audit row, announcement or setting");
	return w;
}

async function checkCanaries(t, opts = {}) {
	const w = await recordedWorld(opts);
	await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: true, reason: `made-up ${DENY_CANARY}` } });
	const answers = [];
	for (const [m, u] of [["GET", "/status"], ["GET", "/events"], ["GET", "/loads"], ["GET", "/loads/123456789"], ["GET", "/loads/223456789"]]) answers.push((await w.call(m, u, SA)).text);
	const dump = [...answers, JSON.stringify(w.audits)].join("\n").toLowerCase();
	const planted = { deny: DENY_CANARY, driver: DRIVER_NAME, phone: DRIVER_PHONE, agent: AGENT, money: MONEY, home: "evergreen" };
	t.eq(Object.entries(planted).filter(([, v]) => dump.includes(v.toLowerCase())).map(([k]) => k), [], "§10 no canary in any answer or audit row");
	t.ok(w.db.prepare("SELECT COUNT(*) AS n FROM load_status_history WHERE actor LIKE ?").get(`%${DRIVER_NAME}%`).n >= 1, "§10 (check) the driver's name sat in the history the whole time");
	return w;
}

async function checkAnnounce(t, opts = {}) {
	const w = await recordedWorld(opts);
	const base = w.changes;
	for (const [m, u] of [["GET", "/status"], ["GET", "/events"], ["GET", "/loads"], ["GET", "/loads/123456789"]]) await w.call(m, u, SA);
	t.eq(w.changes, base, "§11 a read tells nobody");
	await w.call("PUT", "/settings", SA, { body: { settleMin: 9 } });
	await w.call("POST", "/stop", SA, { body: {} });
	await w.call("POST", "/loads/123456789/hold", SA, { body: { hold: true, reason: "made-up" } });
	t.eq(w.changes - base, 3, "§11 each write tells the page once (chr:changed, to the super-admin room: scripts/test-chr-wiring.js)");
	return w;
}

async function checkUnknown(t, opts = {}) {
	const w = await world(opts);
	for (const [m, u] of [["GET", ""], ["GET", "/status/extra"], ["POST", "/status"], ["DELETE", "/loads/123456789"], ["GET", "/loads/123456789/hold"], ["POST", "/events/1/retry"]]) {
		const r = await w.call(m, u, SA, { body: m === "GET" || m === "DELETE" ? undefined : {} });
		t.eq([r.status, r.json && r.json.code, /json/.test(r.type)], [404, "NOT_FOUND", true], `§12 ${m} ${u || "/"}: a JSON 404, never the app page`);
	}
	return w;
}

// ------------------------------------------------------------------ mutants
const mutate = (from, to) => {
	if (!ROUTES_SRC.includes(from)) throw new Error(`mutant: lib/chr-routes.js has no ${JSON.stringify(from)}`);
	return loadRoutes(ROUTES_SRC.replace(from, to));
};
async function mutantFails(label, check) {
	const t = collector();
	let threw = null;
	try { await check(t); } catch (err) { threw = err; }
	await closeAll();
	const caught = !threw && t.failures.length > 0;
	T.ok(caught, `§13 caught: ${label}`, caught ? undefined : threw ? `it threw: ${threw.message}` : `its check passed (${t.pass} assertions)`);
	if (caught) console.log(`  ${label}: ${t.failures[0].split("\n")[0]}`);
}

async function main() {
	// Without the module, §1-§12 still run against whatever lib/chr-integration.js
	// mounts, so a tree without the routes fails on what it answers.
	T.ok(REAL, "lib/chr-routes.js exists: the page's routes are built");
	// A check that throws (an answer missing what it reads) is one failure; the rest still run.
	const run = async (label, ...checks) => {
		section(label);
		for (const c of checks) {
			try { await c(T); } catch (err) { T.failures.push(`${label}: threw ${String(err && err.message).slice(0, 160)}`); }
		}
		await closeAll();
	};
	await run("§1  registrations", checkRegistrations);
	await run("§2  the gates", checkGates);
	await run("§3  GET /status", checkStatus);
	await run("§4  GET /events", checkEvents);
	await run("§5  GET /loads, GET /loads/:loadId", checkLoads);
	await run("§6  PUT /settings", checkSettings, checkSettingsSendOff);
	await run("§7  POST /stop", checkStop);
	await run("§8  holds", checkHold, checkHoldLimit);
	await run("§9  the switch off", checkOff);
	await run("§10 canaries", checkCanaries);
	await run("§11 the page is told", checkAnnounce);
	await run("§12 unknown paths", checkUnknown);

	section("§13 mutants");
	if (!REAL) return;
	const direct = (m) => ({ viaMount: false, routes: m });
	const M = {
		noWriteGuard: mutate("app.put(at(\"/settings\"), gate, write, ", "app.put(at(\"/settings\"), gate, "),
		limiterFirst: mutate("app.post(at(\"/loads/:loadId/hold\"), gate, write, holdLimiter, ", "app.post(at(\"/loads/:loadId/hold\"), gate, holdLimiter, write, "),
		noLimiter: mutate("app.post(at(\"/loads/:loadId/hold\"), gate, write, holdLimiter, ", "app.post(at(\"/loads/:loadId/hold\"), gate, write, "),
		noIdCheck: mutate("return LOAD_ID_RE.test(raw) ? E.loadKey(raw) : null;", "return E.loadKey(raw);"),
		allColumns: mutate("return {\n\t\tid: r.id, loadId: r.load_id,", "return {\n\t\t...r, id: r.id, loadId: r.load_id,"),
		rawPayload: mutate("for (const k of E.PAYLOAD_KEYS) if (p[k] !== undefined) payload[k] = p[k];", "Object.assign(payload, p);"),
		sharedListed: mutate("Boolean(user) && !isSharedLoginName(user.username) && Boolean(list)", "Boolean(user) && Boolean(list)"),
		unsetListed: mutate("list.state === \"valid\" && list.verdict(user) === \"listed\"", "(list.state === \"unset\" || list.verdict(user) === \"listed\")"),
		noLiveCheck: mutate("if (parsed.patch[kind] !== \"live\") continue;", "continue;"),
		noAudit: mutate("for (const k of changed.filter((f) => MODE_KINDS.includes(f))) audit(", "for (const k of [].filter((f) => MODE_KINDS.includes(f))) audit("),
		noRelease: mutate("return body.hold ? 0 : S.releaseHeld(db, key, nowIso);", "return 0;"),
		noReason: mutate("if (typeof body.hold !== \"boolean\" || !reason || reason.length > REASON_MAX)", "if (typeof body.hold !== \"boolean\" || reason.length > REASON_MAX)"),
		draftAddress: mutate("draft = d ? { at: String(d.created_at || \"\"),", "draft = d ? { to: d.recipient, at: String(d.created_at || \"\"),"),
		stopMilestonesOnly: mutate("Object.fromEntries(MODE_KINDS.map((k) => [k, \"off\"]))", "{ milestones: \"off\" }"),
		offRoutes: mutate("app.use(MOUNT_PATH, gate, (req, res) => notFound(res, \"FEATURE_OFF\"));", ""),
		noNotFound: mutate("app.use(MOUNT_PATH, gate, (req, res) => notFound(res, \"NOT_FOUND\"));", ""),
		announceReads: mutate("(req, res) => res.json(statusFor(req))));", "(req, res) => { onChange(); return res.json(statusFor(req)); }));"),
		holdUngated: mutate("app.post(at(\"/loads/:loadId/hold\"), gate, ", "app.post(at(\"/loads/:loadId/hold\"), "),
	};
	await mutantFails("a settings save without the same-origin guard", (t) => checkGates(t, direct(M.noWriteGuard)));
	await mutantFails("the hold's limiter before the same-origin guard", (t) => checkGates(t, direct(M.limiterFirst)));
	await mutantFails("holds with no limiter", (t) => checkHoldLimit(t, direct(M.noLimiter)));
	await mutantFails("a :loadId looked up without its check", (t) => checkGates(t, direct(M.noIdCheck)));
	await mutantFails("a send-log row with every column", (t) => checkEvents(t, direct(M.allColumns)));
	await mutantFails("a stored payload passed on as stored", (t) => checkEvents(t, direct(M.rawPayload)));
	await mutantFails("the shared login counted as listed", (t) => checkStatus(t, direct(M.sharedListed)));
	await mutantFails("an unset listed-accounts setting letting everyone choose Live", (t) => checkSettingsSendOff(t, direct(M.unsetListed)));
	await mutantFails("Live saved without its checks", (t) => checkSettings(t, direct(M.noLiveCheck)));
	await mutantFails("a mode change with no audit row", (t) => checkSettings(t, direct(M.noAudit)));
	await mutantFails("a release that leaves the held updates held", (t) => checkHold(t, direct(M.noRelease)));
	await mutantFails("a hold with no reason", (t) => checkHold(t, direct(M.noReason)));
	await mutantFails("the draft's address in the load's answer", (t) => checkLoads(t, direct(M.draftAddress)));
	await mutantFails("Stop everything leaving Location on", (t) => checkStop(t, direct(M.stopMilestonesOnly)));
	await mutantFails("a path falling through to the app page while off", (t) => checkOff(t, direct(M.offRoutes)));
	await mutantFails("an unknown path falling through to the app page", (t) => checkUnknown(t, direct(M.noNotFound)));
	await mutantFails("a read that tells the page", (t) => checkAnnounce(t, direct(M.announceReads)));
	await mutantFails("a hold route registered without the role gate", (t) => checkGates(t, direct(M.holdUngated)));
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
