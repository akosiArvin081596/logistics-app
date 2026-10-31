#!/usr/bin/env node
/**
 * scripts/test-kpi-viewer.js: the KPI Viewer role, server side (lib/kpi-viewer.js). The role opens only
 * GET /api/kpis/viewer and its own sign-in, session check, password change and sign-out; every other
 * route refuses it, whatever KPI_VIEWER_ENABLED and KPI_VIEWER_IDS say.
 *
 *   §1 the sweep, on the real app: server.js imported (LOGISX_IMPORT_ONLY=1, scripts/lib/kpi-viewer-world.js)
 *      from an export of this tree, on a scratch database whose users CHECK lib/users-role-migration.js
 *      widened, with every flag that gates a route in front of its guard on. One KPI Viewer session sends
 *      every registered route but the four that change the session, and each /uploads mount. Each answer
 *      is judged by the guard the running app puts on that route: requireRole 403 Forbidden, requireAuth
 *      403 ROLE_NOT_ALLOWED, no guard the signed-out answer (status and body), the page's read 200. The
 *      business tables, the sheet and the mail are untouched; a Dispatcher through the same harness is
 *      not refused. Then setup, login, change-password (the forced first change) and logout, each on a
 *      fresh session, with only their own writes
 *   §2 sockets: the KPI Viewer's register joins no room, its own user room included, and emits to every
 *      room reach it with nothing, while a Dispatcher joins "dispatch"; the lifted handler too
 *   §3 GET /api/kpis/viewer: flag off 404, CHECK not widened 503; a listed KPI Viewer 200 with only the
 *      metrics approved now (a stale definition, a changed setting, a withdrawn approval and no row are
 *      left out, not even named) and only the allowlisted fields at every depth; weekly only under an
 *      approval given after kpi.weekly_since; none approved [] and the sentence; unlisted, or the list
 *      unset, empty or invalid 403 KPI_VIEWER_NOT_LISTED; a Super Admin the same body; the other roles
 *      403 Forbidden; signed out 401; stored rows only (no run, no sheet read); writes not answered
 *   §4 Add User and Edit User: the role only with the flag on and the CHECK widened (403 / 503, nothing
 *      written, audited), never with a driver or company name (400), the password rules and the
 *      own-password refusal whatever NAMED_LOGINS_ENABLED says, must_change_password 1, no directory row,
 *      the account id in the audit row; GET /api/users carries kpiViewerEnabled only while true; Edit User
 *      keeps the role (409, audited), refuses a driver or company name, lets an email or password edit
 *      through; disable and delete work
 *   §5 flag off is today: requireAuth, requireRole, the register and GET /api/users less this change equal
 *      origin/main's (pinned); the four roles' verdict on every requireAuth route and mount, and the rooms
 *      they join, are the same with and without the change; with the flag off nothing new shows
 *   §6 off again: a KPI Viewer that exists with the flag off still fails closed everywhere, and its page
 *      answers 404
 *   §7 the lib's rules, the start-up line, and mutants of the shipped source (the lifted guard and
 *      handler, lib/kpi-viewer.js, and server.js on the real app), each caught
 *   §8 scripts/kpi-followups-report.js --part=viewer on a copy of the world's database: the table, the
 *      accounts by id, the approvals, the answer's fields, every route's verdict, no name in its output
 *
 * Fails on origin/main (f0fd9954): SERVER_ROOT=<an export of it, node_modules linked> reads server.js and
 * lib/ from there (no role list, no route, no lib/kpi-viewer.js).
 *
 * Hermetic: made-up data in a fresh temp folder; the app runs in children on 127.0.0.1 port 0, and no
 * outside connection is made.
 *   node scripts/test-kpi-viewer.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : ROOT;
const WORLD = path.join(__dirname, "lib", "kpi-viewer-world.js");
const SRC = serverSource();

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (label, actual, expected) => ok(label, same(actual, expected), { actual, expected });
const section = (t) => console.log(t);
// A section that throws (an answer of the wrong shape, on old code) is a failure, and the run goes on.
function guarded(label, fn) {
	try { fn(); } catch (e) { ok(`${label} ran to its end`, false, e && e.message); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-kpi-viewer-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

// ── made-up world ────────────────────────────────────────────────────────────────────────────────────
const KV_ROLE = "KPI Viewer";
const FOUR = ["Super Admin", "Dispatcher", "Driver", "Investor"];
const CP = "/api/auth/change-password";
const ACCOUNTS = [
	{ key: "sa", username: "owner_sample", role: "Super Admin", password: "Made-Up-Owner-2026!", email: "owner@example.test" },
	{ key: "sa2", username: "second_admin_sample", role: "Super Admin", password: "Made-Up-Second-2026!", email: "second@example.test" },
	{ key: "disp", username: "desk_sample", role: "Dispatcher", password: "Made-Up-Desk-2026!" },
	{ key: "disp2", username: "desk_two_sample", role: "Dispatcher", password: "Made-Up-Desk-Two-2026!" },
	{ key: "drv", username: "dana_sample", role: "Driver", password: "Made-Up-Dana-2026!", driverName: "Dana Sample" },
	{ key: "inv", username: "ivan_sample", role: "Investor", password: "Made-Up-Ivan-2026!", companyName: "Made-Up Holdings LLC" },
	{ key: "kv", username: "kay_sample", role: KV_ROLE, password: "Made-Up-Kay-2026!", email: "kay@example.test" },
	{ key: "kvu", username: "kai_sample", role: KV_ROLE, password: "Made-Up-Kai-2026!", email: "kai@example.test" },
	{ key: "kvf", username: "kim_sample", role: KV_ROLE, password: "Made-Up-Kim-2026!", mustChange: true },
];
const PLAIN_ACCOUNTS = ACCOUNTS.filter((a) => a.role !== KV_ROLE);
// Approved now: loads_delivered and co2_tonnes and fuel_mpg after weekly figures began, revenue before.
// Left out: miles_driven (an old definition), fuel_savings (a setting changed since), on_time_rate
// (withdrawn), and every metric with no row.
const KPI = {
	day: "2026-10-20",
	settings: { aiDispatchStart: null, dedicatedStart: null, baselineMpg: 9, recipients: ["sentinel-recipient@example.test"] },
	weeklySince: "2026-10-01T00:00:00.000Z",
	weeklyKeys: ["loads_delivered", "revenue"],
	approvals: [
		{ key: "loads_delivered", approved: 1, definitionVersion: "current", at: "2026-10-15T12:00:00.000Z" },
		{ key: "revenue", approved: 1, definitionVersion: "current", at: "2026-09-15T12:00:00.000Z" },
		{ key: "fuel_mpg", approved: 1, definitionVersion: "current", at: "2026-10-15T12:00:00.000Z" },
		{ key: "co2_tonnes", approved: 1, definitionVersion: "current", at: "2026-10-15T12:00:00.000Z" },
		{ key: "miles_driven", approved: 1, definitionVersion: 99, at: "2026-10-15T12:00:00.000Z" },
		{ key: "fuel_savings", approved: 1, definitionVersion: "current", hashSettings: { baselineMpg: 8 }, at: "2026-10-15T12:00:00.000Z" },
		{ key: "on_time_rate", approved: 0, definitionVersion: "current", at: "2026-10-15T12:00:00.000Z" },
	],
};
const SHOWN = ["loads_delivered", "revenue", "fuel_mpg", "co2_tonnes"];
const LEFT_OUT = ["miles_driven", "fuel_savings", "on_time_rate", "fleet_trucks", "freight_tons_stated"];
const NEW_KV = { username: "kay_new_sample", password: "Made-Up-New-Kay-2026!", role: KV_ROLE, email: "kay.new@example.test", fullName: "Kay New" };
const NEW_DISPATCHER = { username: "desk_new_sample", password: "Made-Up-New-Desk-2026!", role: "Dispatcher" };
// Every flag whose gate stands in front of a route's guard, on, so every guard is reached. The deny
// list value is made up (the driver-instructions routes need one to open).
const FRONT_GATES = {
	ONBOARDING_RESIGN_ENABLED: "true",
	DRIVER_AVAILABILITY_ENABLED: "true",
	EMERGENCY_CONTACTS_ENABLED: "true",
	RATECON_DRIVER_INSTRUCTIONS_ENABLED: "true",
	DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED: "true",
	CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: "T5550100",
	RATECON_PICKUP_CONFIRMATION_REVIEW_ENABLED: "true",
};
const CONTROL_READS = ["/api/tabs", "/api/invoices", "/api/users/investors", "/api/admin/fleet-health"];

// ── lifting ──────────────────────────────────────────────────────────────────────────────────────────
function liftFrom(src, head) {
	const a = src.indexOf(head);
	if (a < 0) return null;
	let depth = 0;
	for (let j = src.indexOf("{", a); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}" && --depth === 0) return src.slice(a, j + 1);
	}
	return null;
}
const REQUIRE_AUTH = liftFrom(SRC, "function requireAuth(req, res, next) {");
const REQUIRE_ROLE = liftFrom(SRC, "function requireRole(...roles) {");
const ROLE_ARROW = REQUIRE_ROLE ? liftFrom(REQUIRE_ROLE, "(req, res, next) => {") : null;
const IO_HANDLER = (() => {
	const a = SRC.indexOf('io.on("connection", (socket) => {');
	return a < 0 ? null : liftFrom(SRC.slice(SRC.indexOf("(socket) => {", a)), "(socket) => {");
})();
const USERS_GET = (() => {
	const head = 'app.get("/api/users", requireRole("Super Admin"), (req, res) => {';
	const a = SRC.indexOf(head);
	return a < 0 ? null : SRC.slice(a, SRC.indexOf("\n});", a) + 4);
})();
const ROOMS = (() => {
	try {
		const heads = ["function identityRoomKey(name) {", "function driverRoom(name) {", "function userRoom(username) {"];
		return new Function(`${heads.map((h) => liftFrom(SRC, h)).join("\n")}\nreturn { identityRoomKey, driverRoom, userRoom };`)();
	} catch { return null; }
})();
const SOCKET_HANDLER = (() => {
	try {
		const heads = ["function socketHandler(event, fn) {", "function logSocketHandlerFault(event, err) {"];
		return new Function(`${heads.map((h) => liftFrom(SRC, h)).join("\n")}\nreturn socketHandler;`)();
	} catch { return null; }
})();

// This change's own lines, found by their code: removed, what is left is what origin/main ran.
const ROLE_IF_RE = /\n\tif \(!\["Super Admin", "Dispatcher", "Driver", "Investor"\]\.includes\(req\.session\.user\.role\) && !\(req\.method === "POST" && req\.route && req\.route\.path === "\/api\/auth\/change-password"\)\)\n\t\treturn res\.status\(403\)\.json\(\{ error: "This account can't open this page\.", code: "ROLE_NOT_ALLOWED" \}\);/;
const REGISTER_IF = '\n\t\tif (!["Super Admin", "Dispatcher", "Driver", "Investor"].includes(role)) return;';
const USERS_SPREAD = ", ...(KPI_VIEWER_SCHEMA_READY ? { kpiViewerEnabled: true } : {})";
// Comments dropped and whitespace collapsed: the code as it runs.
const normalize = (text) => String(text).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\s+/g, " ").trim();
const pinOf = (text) => crypto.createHash("sha256").update(normalize(text)).digest("hex").slice(0, 16);
// origin/main's (f0fd9954) requireAuth, requireRole, connection handler and GET /api/users, normalized.
// A change that means to alter what the four roles get from these updates the pin, knowingly.
const ORIGIN_PINS = { requireAuth: "48ef9533690579bb", requireRole: "096032f3e644bdd3", ioHandler: "016507303c1e062a", usersGet: "81e841b01fe94de3" };

const quiet = (fn) => {
	const saved = [console.warn, console.error, console.log];
	console.warn = () => {}; console.error = () => {}; console.log = () => {};
	try { return fn(); } finally { [console.warn, console.error, console.log] = saved; }
};
const buildAuth = (src) => new Function(`${src}\nreturn requireAuth;`)();
const buildRole = (src) => new Function(`${src}\nreturn requireRole;`)();
const XRW = { "x-requested-with": "XMLHttpRequest" };
function run(guard, { method = "GET", url = "/api/tabs", routePath, headers = XRW, user } = {}) {
	const out = { status: null, body: null, nexted: false };
	const req = { method, url, originalUrl: url, headers, session: user ? { user } : {} };
	if (routePath !== undefined) req.route = { path: routePath };
	const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
	quiet(() => guard(req, res, () => { out.nexted = true; }));
	return out;
}
const KV = (extra = {}) => ({ id: 41, username: "kay_sample", role: KV_ROLE, mustChangePassword: false, ...extra });
const ROLE_NOT_ALLOWED = { error: "This account can't open this page.", code: "ROLE_NOT_ALLOWED" };
const notAllowed = (r) => r.status === 403 && same(r.body, ROLE_NOT_ALLOWED) && !r.nexted;

// The requireAuth registrations, read off the source (column-0 lines), and the /uploads mounts.
const AUTH_ROUTES = [...SRC.matchAll(/^app\.(get|post|put|patch|delete)\(\s*"([^"]+)",\s*requireAuth\b/gm)]
	.map((m) => ({ method: m[1].toUpperCase(), path: m[2], url: m[2].replace(/:([A-Za-z0-9_]+)/g, "made-up-1") }));

function authProbe(src) {
	const p = {};
	let g;
	try { g = buildAuth(src); } catch { return { builds: false }; }
	p.builds = true;
	p.refusesEveryAuthRoute = AUTH_ROUTES.length > 0 && AUTH_ROUTES.filter((r) => !(r.method === "POST" && r.path === CP))
		.every((r) => notAllowed(run(g, { method: r.method, url: r.url, routePath: r.path, user: KV() })));
	p.refusesMount = notAllowed(run(g, { url: "/uploads/kpi-sweep/made-up-file.txt", user: KV() }));
	p.passesChange = run(g, { method: "POST", url: CP, routePath: CP, user: KV() }).nexted;
	p.passesForcedChange = run(g, { method: "POST", url: CP, routePath: CP, user: KV({ mustChangePassword: true }) }).nexted;
	p.passesRoutedVariant = run(g, { method: "POST", url: "/API/auth/change-password/", routePath: CP, user: KV() }).nexted;
	p.refusesGetOfChange = notAllowed(run(g, { method: "GET", url: CP, routePath: CP, user: KV() }));
	p.refusesMentioningUrl = notAllowed(run(g, { method: "POST", url: "/api/expenses?next=/api/auth/change-password", routePath: "/api/expenses", user: KV() }));
	p.refusesBeforeCsrf = notAllowed(run(g, { method: "POST", url: "/api/expenses", routePath: "/api/expenses", headers: {}, user: KV() }));
	p.refusesBeforeForcedChange = notAllowed(run(g, { method: "GET", url: "/api/tabs", routePath: "/api/tabs", user: KV({ mustChangePassword: true }) }));
	p.refusesNoRole = notAllowed(run(g, { routePath: "/api/tabs", user: { id: 5, username: "odd_sample" } }));
	p.fourRolesPass = FOUR.every((role) => run(g, { routePath: "/api/tabs", user: { id: 5, role } }).nexted);
	p.signedOut401 = run(g, { user: null, routePath: "/api/tabs" }).status === 401;
	return p;
}

function fakeSocket(user) {
	const s = { request: { session: user ? { user } : {}, sessionID: user ? `sid-${user.id}` : "sid-anon" }, data: {}, rooms: new Set(), disconnected: false, handlers: {} };
	s.disconnect = () => { s.disconnected = true; };
	s.on = (ev, cb) => { s.handlers[ev] = cb; };
	s.join = (room) => { s.rooms.add(room); };
	s.fromClient = (ev, ...args) => { if (s.handlers[ev]) s.handlers[ev](...args); };
	return s;
}
// The rooms each socket joins on the lifted connection handler, per role and requested name.
const SOCKET_USERS = [
	{ id: 1, username: "owner_sample", role: "Super Admin", driverName: "Owner Sample" },
	{ id: 2, username: "desk_sample", role: "Dispatcher" },
	{ id: 3, username: "dana_sample", role: "Driver", driverName: "Dana Sample" },
	{ id: 4, username: "ivan_sample", role: "Investor" },
	{ id: 41, username: "kay_sample", role: KV_ROLE },
];
function socketRooms(handlerSrc) {
	if (!handlerSrc || !ROOMS || !SOCKET_HANDLER) return null;
	let onConnection;
	try {
		onConnection = new Function("currentMustChangePassword", "liveSessionIds", "identityRoomKey", "driverRoom", "userRoom", "socketHandler", `return (${handlerSrc});`)(
			(u) => !!(u && u.mustChangePassword), (sids) => new Set(sids), ROOMS.identityRoomKey, ROOMS.driverRoom, ROOMS.userRoom, SOCKET_HANDLER);
	} catch { return null; }
	const out = {};
	for (const u of SOCKET_USERS) {
		for (const name of [u.username, u.driverName || "", "dispatch", "investor", "someone_else"]) {
			const s = fakeSocket({ ...u, mustChangePassword: false });
			quiet(() => { onConnection(s); s.fromClient("register", name); });
			out[`${u.role}|${name}`] = { rooms: [...s.rooms].sort(), disconnected: s.disconnected };
		}
	}
	return out;
}
const kvRooms = (rooms) => (rooms ? Object.entries(rooms).filter(([k]) => k.startsWith(`${KV_ROLE}|`)) : null);

// ── the export, the templates, the worlds ────────────────────────────────────────────────────────────
const LAUNCHER = path.join(TMP, "launcher", "chrome");
fs.mkdirSync(path.dirname(LAUNCHER));
fs.writeFileSync(LAUNCHER, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

let exportCount = 0;
function exportTree(edits = []) {
	const dir = path.join(TMP, `export-${++exportCount}`);
	fs.mkdirSync(dir);
	for (const f of ["server.js", "package.json", "logo.png", "logo.avif"]) {
		if (fs.existsSync(path.join(BASE, f))) fs.copyFileSync(path.join(BASE, f), path.join(dir, f));
	}
	for (const d of ["lib", "routes", "onboarding-templates"]) {
		if (fs.existsSync(path.join(BASE, d))) fs.cpSync(path.join(BASE, d), path.join(dir, d), { recursive: true });
	}
	fs.symlinkSync(path.join(BASE, "node_modules"), path.join(dir, "node_modules"));
	for (const d of ["home", "tmp", path.join("uploads", "kpi-sweep"), path.join("uploads", "rate-cons")]) fs.mkdirSync(path.join(dir, d), { recursive: true });
	fs.writeFileSync(path.join(dir, "uploads", "kpi-sweep", "made-up-file.txt"), "a made-up file\n");
	fs.writeFileSync(path.join(dir, "uploads", "rate-cons", "made-up-ratecon.pdf"), "%PDF-1.4\n% made-up\n");
	// A mutant's edits, all to server.js: its text is the helper's (byte for byte while no route module is
	// mounted), edited and written over the copy.
	let text = SRC;
	for (const e of edits) {
		if (!text.includes(e.from)) throw new Error(`mutant anchor not found: ${e.from.slice(0, 80)}`);
		text = text.replace(e.from, e.to);
	}
	if (edits.length) fs.writeFileSync(path.join(dir, "server.js"), text);
	return dir;
}

function child(setup, env) {
	const setupFile = path.join(TMP, `setup-${crypto.randomBytes(4).toString("hex")}.json`);
	fs.writeFileSync(setupFile, JSON.stringify(setup));
	const run = spawnSync(process.execPath, [WORLD, setupFile], {
		cwd: setup.exportDir, encoding: "utf8", timeout: 50000, maxBuffer: 64 * 1024 * 1024,
		env: {
			PATH: process.env.PATH || "/usr/bin:/bin", LOGISX_IMPORT_ONLY: "1", NODE_ENV: "test",
			SPREADSHEET_ID: "made-up-kpi-viewer-sheet", SESSION_SECRET: "made-up-kpi-viewer-session-value-not-a-secret",
			HOME: path.join(setup.exportDir, "home"), TMPDIR: path.join(setup.exportDir, "tmp"), PUPPETEER_EXECUTABLE_PATH: LAUNCHER,
			DATABASE_PATH: setup.dbFile, ...env,
		},
	});
	let out = null;
	try { out = JSON.parse(fs.readFileSync(setup.out, "utf8")); } catch { out = null; }
	if (!out || out.error) {
		const tail = `${run.stdout || ""}${run.stderr || ""}`.split("\n").slice(-12).join("\n");
		return { error: (out && out.error) || `the child wrote nothing (exit ${run.status}${run.signal ? ` ${run.signal}` : ""}): ${tail}` };
	}
	return out;
}

function prepare(exportDir, { migrate, accounts }) {
	const dir = fs.mkdtempSync(path.join(TMP, "prepare-"));
	const setup = {
		mode: "prepare", exportDir, repoRoot: ROOT, dbFile: path.join(dir, "build.db"), templateOut: path.join(dir, "template.db"),
		out: path.join(dir, "out.json"), migrate, accounts, kpi: KPI,
	};
	const out = child(setup, {});
	return { ...out, template: setup.templateOut };
}

function world(exportDir, template, scenario, env, accounts = ACCOUNTS) {
	const dir = fs.mkdtempSync(path.join(TMP, `world-${scenario}-`));
	const dbFile = path.join(dir, "world.db");
	fs.copyFileSync(template, dbFile);
	return child({
		mode: "world", scenario, exportDir, repoRoot: ROOT, dbFile, out: path.join(dir, "out.json"), accounts,
		roleArrow: ROLE_ARROW, controlReads: CONTROL_READS, newKv: NEW_KV, newDispatcher: NEW_DISPATCHER,
		kvfNewPassword: "Made-Up-Kim-Changed-2026!", kvuNewPassword: "Made-Up-Kai-Changed-2026!",
	}, env);
}

// ── judging a sweep ──────────────────────────────────────────────────────────────────────────────────
const FORBIDDEN = { error: "Forbidden" };
const routeRe = (p) => new RegExp(`^${p.split(/(:[A-Za-z0-9_]+)/).map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}/?$`, "i");
// Which registration answers a target: an earlier route of the same method whose path meets its URL
// (Express takes the first), else its own. ALL routes are method guards that pass other methods on.
function judgeOf(routes, t) {
	const method = t.method.toLowerCase();
	for (const r of routes) {
		if (r.methods.includes("_all") || !r.methods.includes(method)) continue;
		if (r.paths.some((p) => typeof p === "string" && p !== "*" && routeRe(p).test(t.url))) return r;
	}
	return null;
}
function targetsOf(routes) {
	const out = [];
	for (const r of routes) {
		for (const m of r.methods) {
			const method = m === "_all" ? "GET" : m.toUpperCase();
			for (const p of r.paths) {
				if (typeof p !== "string" || p === "*") continue;
				out.push({ id: `${m === "_all" ? "ALL" : method} ${p}`, method, path: p, url: p.replace(/:([A-Za-z0-9_]+)/g, "made-up-1"), route: r });
			}
		}
	}
	return out;
}
// Each route's answer to the KPI Viewer against what its guard must say. `viewerOk` judges the page.
function judgeSweep(w, { label, kvId, viewerOk }) {
	const problems = [];
	const counts = { role: 0, auth: 0, none: 0, gated: 0 };
	if (!w || !w.pass1) return { problems: [`${label}: no sweep ran`], counts };
	for (const t of targetsOf(w.routes)) {
		const kv = w.pass1.kv[t.id];
		const anon = w.pass1.anon[t.id];
		if (!kv) continue;
		const judge = (t.route.methods.includes("_all") ? t.route : judgeOf(w.routes, t)) || t.route;
		counts[judge.guard]++;
		if (judge.gates > 0 && judge.guard !== "none") counts.gated++;
		if (judge.guard !== "none" && anon.status !== 401) problems.push(`${t.id}: signed out got ${anon.status}, not 401 (its guard wasn't reached)`);
		if (t.id === "GET /api/kpis/viewer") {
			if (!viewerOk(kv)) problems.push(`${t.id}: ${kv.status} ${JSON.stringify(kv.json).slice(0, 120)}`);
		} else if (judge.guard === "role") {
			if (!(kv.status === 403 && same(kv.json, FORBIDDEN))) problems.push(`${t.id} (requireRole): ${kv.status} ${JSON.stringify(kv.json).slice(0, 120)}`);
		} else if (judge.guard === "auth") {
			if (!(kv.status === 403 && same(kv.json, ROLE_NOT_ALLOWED))) problems.push(`${t.id} (requireAuth): ${kv.status} ${JSON.stringify(kv.json).slice(0, 120)}`);
		} else if (t.id === "GET /api/auth/session") {
			if (!(kv.status === 200 && kv.json && kv.json?.authenticated === true && kv.json.user && kv.json?.user?.id === kvId && kv.json?.user?.role === KV_ROLE)) problems.push(`${t.id}: not its own session`);
		} else if (!(kv.status === anon.status && same(kv.json, anon.json) && kv.text === anon.text)) {
			problems.push(`${t.id} (no guard): ${kv.status} vs signed out ${anon.status}`);
		}
	}
	return { problems, counts };
}
const isViewerAnswer = (r) => r && r.status === 200 && r.json && Array.isArray(r.json.metrics);

// The allowlist at every depth, the plan's own list (never read from the lib).
const ALLOWED = {
	top: ["asOfDay", "timeZone", "generatedAt", "weekRule", "metrics", "note"],
	metric: ["key", "label", "unit", "kind", "group", "definition", "source", "status", "missingReason", "assumptions", "warnings", "value", "display", "current", "totals", "series", "comparisons", "confidence", "computedDay", "weekly"],
	source: ["label", "url"],
	period: ["label", "from", "to", "value", "display"],
	series: ["period", "value", "display"],
	comparison: ["kind", "label", "basePeriod", "value", "baseValue", "deltaPct", "display", "status"],
	weekly: ["mode", "weekRule", "reason", "series", "current", "toDate", "comparison"],
	week: ["weekStart", "weekEnd", "to", "label", "value", "display", "partial"],
	weekComparison: ["kind", "label", "display", "status", "note"],
};
const NEVER = ["job", "settings", "recipients", "approval", "definitionVersion", "breakdown", "coverage", "beforeAfter"];
function allowlistProblems(answer) {
	const bad = [];
	const plainValue = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
	const keys = (o, kind, where) => {
		if (!o || typeof o !== "object" || Array.isArray(o)) { bad.push(`${where} isn't an object`); return false; }
		for (const k of Object.keys(o)) if (!ALLOWED[kind].includes(k)) bad.push(`${where}.${k}`);
		return true;
	};
	const leaf = (o, kind, where) => {
		if (o === null) return;
		if (!keys(o, kind, where)) return;
		for (const [k, v] of Object.entries(o)) if (!plainValue(v)) bad.push(`${where}.${k} isn't a plain value`);
	};
	if (!keys(answer, "top", "answer")) return bad;
	for (const k of ["asOfDay", "timeZone", "generatedAt", "weekRule", "note"]) if (k in answer && !plainValue(answer[k])) bad.push(`answer.${k} isn't a plain value`);
	for (const [i, m] of (answer.metrics || []).entries()) {
		const w = `metrics[${i}]`;
		if (!keys(m, "metric", w)) continue;
		for (const k of ["key", "label", "unit", "kind", "group", "definition", "status", "missingReason", "value", "display", "confidence", "computedDay"]) {
			if (k in m && !plainValue(m[k])) bad.push(`${w}.${k} isn't a plain value`);
		}
		if (m.source !== null && typeof m.source !== "string") leaf(m.source, "source", `${w}.source`);
		for (const k of ["assumptions", "warnings"]) if (!Array.isArray(m[k]) || !m[k].every((x) => typeof x === "string")) bad.push(`${w}.${k}`);
		leaf(m.current, "period", `${w}.current`);
		for (const [j, x] of (m.totals || []).entries()) leaf(x, "period", `${w}.totals[${j}]`);
		for (const [j, x] of (m.series || []).entries()) leaf(x, "series", `${w}.series[${j}]`);
		for (const [j, x] of (m.comparisons || []).entries()) leaf(x, "comparison", `${w}.comparisons[${j}]`);
		if (m.weekly !== undefined) {
			const wk = m.weekly;
			if (keys(wk, "weekly", `${w}.weekly`)) {
				for (const [j, x] of (wk.series || []).entries()) leaf(x, "week", `${w}.weekly.series[${j}]`);
				leaf(wk.current === undefined ? null : wk.current, "week", `${w}.weekly.current`);
				leaf(wk.toDate === undefined ? null : wk.toDate, "week", `${w}.weekly.toDate`);
				leaf(wk.comparison === undefined ? null : wk.comparison, "weekComparison", `${w}.weekly.comparison`);
			}
		}
	}
	const text = JSON.stringify(answer);
	for (const k of NEVER) if (text.includes(`"${k}"`)) bad.push(`"${k}" appears`);
	if (/SENTINEL-|sentinel-recipient/.test(text)) bad.push("a value from a field outside the allowlist appears");
	return bad;
}

// What the shipped lib must do with a made-up admin answer; mutants of the lib are run through it.
function libBattery(L) {
	const misses = [];
	const want = (label, cond) => { if (!cond) misses.push(label); };
	try {
		const parse = require(path.join(BASE, "lib", "listed-accounts.js")).parseListedAccountIds;
		const listed = parse("41,43");
		const kv = (id) => ({ id, username: `kv_${id}`, role: KV_ROLE });
		const refuse = (o) => L.viewerRefusal({ enabled: true, schemaReady: true, list: listed, ...o });
		want("flag off: 404 FEATURE_OFF for a KPI Viewer and a Super Admin", ["Super Admin", KV_ROLE].every((role) => {
			const r = L.viewerRefusal({ enabled: false, schemaReady: true, list: listed, user: { id: 41, role } });
			return r && r.status === 404 && r.body.code === "FEATURE_OFF";
		}));
		want("flag on, CHECK not widened: 503 KPI_VIEWER_SCHEMA", (() => { const r = L.viewerRefusal({ enabled: true, schemaReady: false, list: listed, user: kv(41) }); return r && r.status === 503 && r.body.code === "KPI_VIEWER_SCHEMA"; })());
		want("a listed KPI Viewer reads", refuse({ user: kv(41) }) === null);
		want("a Super Admin reads whatever the list says", [listed, parse(undefined), parse(""), parse("01")].every((list) => refuse({ list, user: { id: 9, role: "Super Admin" } }) === null));
		for (const [label, list, user] of [["unlisted", listed, kv(42)], ["the list unset", parse(undefined), kv(41)], ["the list empty", parse(""), kv(41)], ["the list invalid", parse("01"), kv(41)], ["an id stored as text", listed, { id: "41", role: KV_ROLE }]]) {
			const r = refuse({ list, user });
			want(`${label}: 403 KPI_VIEWER_NOT_LISTED`, !!r && r.status === 403 && r.body.code === "KPI_VIEWER_NOT_LISTED");
		}
		want("another role: 403 Forbidden", ["Dispatcher", "Driver", "Investor"].every((role) => { const r = refuse({ user: { id: 41, role } }); return r && r.status === 403 && same(r.body, FORBIDDEN); }));
		const c = (o) => L.createRefusal({ enabled: true, schemaReady: true, driverName: undefined, companyName: undefined, ...o });
		want("create, flag off: 403 KPI_VIEWER_DISABLED", (() => { const r = c({ enabled: false }); return r && r.status === 403 && r.code === "KPI_VIEWER_DISABLED"; })());
		want("create, CHECK not widened: 503 KPI_VIEWER_SCHEMA", (() => { const r = c({ schemaReady: false }); return r && r.status === 503 && r.code === "KPI_VIEWER_SCHEMA"; })());
		want("create with a driver or company name: 400 KPI_VIEWER_FIELDS", ["Made Up Driver", 123].every((v) => { const r = c({ driverName: v }); return r && r.status === 400 && r.code === "KPI_VIEWER_FIELDS"; }) && c({ companyName: "Made-Up LLC" }).code === "KPI_VIEWER_FIELDS");
		want("create with blank names: allowed", c({ driverName: "  ", companyName: "" }) === null && c({}) === null);
		const e = (o) => L.editRefusal({ currentRole: KV_ROLE, role: undefined, driverName: undefined, companyName: undefined, ...o });
		want("edit, its own role resent or none: allowed", e({ role: KV_ROLE }) === null && e({}) === null && e({ role: "" }) === null && e({ role: null }) === null);
		want("edit, to or from the role: 409 KPI_VIEWER_ROLE_FIXED", ["Super Admin", "Dispatcher", "Driver", "Investor"].every((role) => e({ role }).code === "KPI_VIEWER_ROLE_FIXED" && e({ currentRole: role, role: KV_ROLE }).code === "KPI_VIEWER_ROLE_FIXED"));
		want("edit, a driver or company name on it: 400 KPI_VIEWER_FIELDS", e({ driverName: "Made Up Driver" }).code === "KPI_VIEWER_FIELDS" && e({ companyName: "Made-Up LLC" }).code === "KPI_VIEWER_FIELDS" && e({ driverName: "", companyName: " " }) === null);
		want("edit not involving the role: allowed", L.editRefusal({ currentRole: "Dispatcher", role: "Super Admin", driverName: "Made Up", companyName: "" }) === null);

		const admin = madeUpAdminAnswer();
		const a = L.viewerAnswer(admin, { weeklySince: KPI.weeklySince });
		want("only the metrics approved now, in order", same((a.metrics || []).map((m) => m.key), ["loads_delivered", "revenue", "co2_tonnes"]));
		want("the allowlist at every depth", allowlistProblems(a).length === 0);
		want("no metric left out is named", !/miles_driven|on_time_rate|fleet_trucks/.test(JSON.stringify(a)));
		want("weekly only under an approval given after weekly figures began", !!(a.metrics.find((m) => m.key === "loads_delivered") || {}).weekly && !("weekly" in (a.metrics.find((m) => m.key === "revenue") || {})));
		want("weekly's own allowlist (the week rows' coverage dropped)", !/"coverage"/.test(JSON.stringify(a)));
		want("no weekly at all when weekly figures never began", L.viewerAnswer(admin, { weeklySince: null }).metrics.every((m) => !("weekly" in m)));
		want("the week rule at the top while weekly figures are on", a.weekRule === admin.weekly.weekRule && !("weekRule" in L.viewerAnswer({ ...admin, weekly: undefined })));
		want("the source as its label and link", same((a.metrics.find((m) => m.key === "co2_tonnes") || {}).source, { label: "A made-up source", url: "https://example.test/source" }));
		const none = L.viewerAnswer({ ...admin, metrics: admin.metrics.map((m) => ({ ...m, approval: { ...m.approval, approved: false } })) });
		want("none approved: [] and the sentence", same(none.metrics, []) && none.note === "No KPI has been approved for sharing yet.");
		want("a malformed answer gives [] and the sentence", same(L.viewerAnswer(null).metrics, []) && L.viewerAnswer(undefined).note === "No KPI has been approved for sharing yet.");

		const rows = (...list) => () => list;
		const c1 = L.census(parse("41,43,7"), rows({ id: 41, disabled_at: null }, { id: 42, disabled_at: "" }, { id: 43, disabled_at: "2026-10-01T00:00:00Z" }));
		want("census: the line names the list and the accounts", c1.summary === "KPI_VIEWER_IDS valid (3 ids); 3 KPI Viewer accounts, 1 listed");
		want("census: one error per listed id that isn't an enabled KPI Viewer (ids only)", same(c1.errors, [
			"[kpi-viewer] KPI_VIEWER_IDS lists account #43, which isn't an enabled KPI Viewer account",
			"[kpi-viewer] KPI_VIEWER_IDS lists account #7, which isn't an enabled KPI Viewer account"]));
		want("census: one warning per enabled KPI Viewer that isn't listed", same(c1.warnings, ["[kpi-viewer] KPI Viewer account #42 isn't on KPI_VIEWER_IDS: its KPI page shows no figures"]));
		const c2 = L.census(parse(undefined), rows());
		want("census: unset, no accounts", c2.summary === "KPI_VIEWER_IDS unset; 0 KPI Viewer accounts, 0 listed" && !c2.errors.length && !c2.warnings.length);
		const c3 = L.census(parse("41,made_up_name"), rows({ id: 41 }));
		want("census: invalid, with the problem by position and never the text", /^KPI_VIEWER_IDS invalid; 1 KPI Viewer account, 0 listed$/.test(c3.summary) && c3.errors.length === 1 && /entry 2/.test(c3.errors[0]) && !c3.errors[0].includes("made_up_name"));
		const c4 = L.census(parse("41"), () => { throw new Error("made-up read failure"); });
		want("census: a failed read is reported, never thrown", c4.summary === "KPI_VIEWER_IDS valid (1 id); KPI Viewer accounts unreadable" && c4.errors.length === 1);
		want("FOUR_ROLES and ROLE", same(L.FOUR_ROLES, FOUR) && L.ROLE === KV_ROLE);
	} catch (err) {
		misses.push(`threw: ${err.message}`);
	}
	return misses;
}
function madeUpAdminAnswer() {
	const metric = (key, approved, at, extra = {}) => ({
		key, label: `Label ${key}`, unit: "count", kind: "real", group: "volume", definition: `Definition of ${key}`, definitionVersion: 1,
		source: null, approval: { approved, by: "owner_sample", at, stale: false }, status: "ok", missingReason: null,
		assumptions: ["a made-up assumption"], warnings: [], value: 12, display: "12",
		current: { from: "2026-09-01", to: "2026-09-30", value: 12, display: "12", label: "September 2026", coverage: { num: 1, den: 2 }, extra: "SENTINEL-CURRENT" },
		totals: [{ label: "All time", from: "2025-04-01", to: "2026-10-20", value: 120, display: "120", note: "SENTINEL-TOTAL" }],
		series: [{ period: "2026-09", value: 12, display: "12", coverage: 0.9 }],
		comparisons: [{ kind: "mom", label: "vs August 2026", basePeriod: "2026-08", value: 12, baseValue: 10, deltaPct: 20, display: "+20.0%", status: "ok", nested: { a: 1 } }],
		beforeAfter: [{ event: "SENTINEL-BEFORE-AFTER", date: "2026-04-09" }],
		coverage: { num: 7, den: 9, ratio: 0.78, what: "SENTINEL-COVERAGE" },
		confidence: "high", breakdown: [{ label: "SENTINEL-BREAKDOWN" }], computedDay: "2026-10-20",
		weekly: {
			mode: "weekly", weekRule: "A made-up week rule.",
			series: [{ weekStart: "2026-10-10", weekEnd: "2026-10-16", to: "2026-10-16", label: "Oct 10-16, 2026", value: 4, display: "4", coverage: 0.9, partial: false }],
			current: { weekStart: "2026-10-10", weekEnd: "2026-10-16", to: "2026-10-16", label: "Oct 10-16, 2026", value: 4, display: "4", coverage: 0.9, partial: false },
			toDate: null,
			comparison: { kind: "wow", label: "vs Oct 3-9", display: "+33.3%", status: "ok", note: "", extra: "SENTINEL-WEEK" },
		},
		...extra,
	});
	return {
		asOfDay: "2026-10-20", timeZone: "America/New_York", generatedAt: "2026-10-20T12:00:00.000Z",
		job: { enabled: { snapshot: true } }, settings: { recipients: ["sentinel-recipient@example.test"] },
		weekly: { weekRule: "A made-up week rule.", approvalNote: "SENTINEL-APPROVAL-NOTE" },
		metrics: [
			metric("loads_delivered", true, "2026-10-15T12:00:00.000Z"),
			metric("revenue", true, "2026-09-15T12:00:00.000Z"),
			metric("miles_driven", false, null),
			metric("on_time_rate", false, "2026-10-15T12:00:00.000Z"),
			metric("co2_tonnes", true, "2026-10-15T12:00:00.000Z", { source: { label: "A made-up source", url: "https://example.test/source", extra: "SENTINEL-SOURCE" } }),
			metric("fleet_trucks", false, null),
		],
	};
}
// A copy of lib/ with one edit, loaded fresh, for a mutant of lib/kpi-viewer.js.
let libCopies = 0;
function libWith(from, to) {
	const dir = path.join(TMP, `lib-${++libCopies}`);
	fs.cpSync(path.join(BASE, "lib"), dir, { recursive: true });
	const file = path.join(dir, "kpi-viewer.js");
	const text = fs.readFileSync(file, "utf8");
	if (!text.includes(from)) return { anchorMissing: true };
	fs.writeFileSync(file, text.replace(from, to));
	return require(file);
}

// ══ the runs ═════════════════════════════════════════════════════════════════════════════════════════
const LIB_FILE = path.join(BASE, "lib", "kpi-viewer.js");
let LIB = null;
try { LIB = require(LIB_FILE); } catch { LIB = null; }

section("§7a the lib's rules (lib/kpi-viewer.js)");
ok("§7a lib/kpi-viewer.js loads", !!LIB);
const shippedMisses = LIB ? libBattery(LIB) : ["no lib"];
eq("§7a the shipped lib holds every rule", shippedMisses, []);

const exportDir = exportTree();
const migrated = prepare(exportDir, { migrate: true, accounts: ACCOUNTS });
const plain = prepare(exportDir, { migrate: false, accounts: PLAIN_ACCOUNTS });
ok("(setup) the migrated template was built: the CHECK widened, the accounts seeded", !migrated.error && migrated.migration && migrated.migration.exit === 0, migrated.error || migrated.migration);
ok("(setup) the plain template was built", !plain.error, plain.error);
const IDS = migrated.ids || {};
const LISTED = `${IDS.kv},${IDS.kvf}`;
const ON_ENV = { ...FRONT_GATES, KPI_VIEWER_ENABLED: "true", KPI_VIEWER_IDS: LISTED, KPI_WEEKLY_ENABLED: "true", ACCOUNT_DISABLE_ENABLED: "true", SIGN_IN_AUDIT_ENABLED: "true" };
const OFF_ENV = { ...FRONT_GATES, KPI_VIEWER_IDS: LISTED, KPI_WEEKLY_ENABLED: "true" };
const kvLines = (w) => ((w && w.lines) || []).filter(([, l]) => l.includes("[kpi-viewer]"));

// ── the main world: flag on, CHECK widened, two of three KPI Viewers listed ──────────────────────────
const MAIN = migrated.error ? { error: "no template" } : world(exportDir, migrated.template, "main", ON_ENV);
ok("(setup) the main world ran", !MAIN.error, MAIN.error);

section("§1 the sweep, on the real app");
guarded("§1", () => {
	const viewerOk = (r) => isViewerAnswer(r) && same(r.json.metrics.map((m) => m.key), SHOWN);
	const { problems, counts } = judgeSweep(MAIN, { label: "main", kvId: IDS.kv, viewerOk });
	console.log(`  swept: requireRole ${counts.role}, requireAuth ${counts.auth}, no guard ${counts.none} (behind a flag gate: ${counts.gated})`);
	eq("§1 every route answers the KPI Viewer as its guard must (requireRole 403 Forbidden, requireAuth 403 ROLE_NOT_ALLOWED, no guard as signed out, the page 200)", problems, []);
	ok(`§1 ...across every kind of route (requireRole ${counts.role}, requireAuth ${counts.auth}, no guard ${counts.none}, behind a gate ${counts.gated})`,
		counts.role >= 200 && counts.auth >= 25 && counts.none >= 15 && counts.gated >= 15, counts);
	ok("§1 the sweep sent GET /api/kpis/viewer and it answered", !!(MAIN.pass1 && MAIN.pass1.kv["GET /api/kpis/viewer"]));
	const sessionAndLogout = MAIN.pass1 ? Object.keys(MAIN.pass1.kv).filter((k) => /\/api\/auth\/(session|logout)$/.test(k)) : [];
	eq("§1 session is sent once in the sweep and logout not at all (it is in pass 2, among its own four)", sessionAndLogout, ["GET /api/auth/session"]);
	const u = MAIN.uploads || {};
	ok("§1 /uploads (requireAuth): a planted file and a missing one answer 403 ROLE_NOT_ALLOWED",
		u.kv && same([u.kv.file.status, u.kv.file.json], [403, ROLE_NOT_ALLOWED]) && same([u.kv.missing.status, u.kv.missing.json], [403, ROLE_NOT_ALLOWED]), u.kv);
	ok("§1 /uploads/rate-cons (requireRole): 403 Forbidden", u.kv && u.kv.rateCon.status === 403 && same(u.kv.rateCon.json, FORBIDDEN), u.kv && u.kv.rateCon);
	ok("§1 ...and signed out each is 401", u.anon && [u.anon.file, u.anon.missing, u.anon.rateCon].every((r) => r.status === 401), u.anon);
	const mounts = (MAIN.mounts || []).filter((m) => /uploads/.test(m.source));
	const meets = (p) => mounts.filter((m) => new RegExp(m.source, "i").test(p));
	const forFile = meets("/uploads/kpi-sweep/made-up-file.txt");
	const forRateCon = meets("/uploads/rate-cons/made-up-ratecon.pdf");
	ok("§1 every /uploads mount opens with requireAuth, and /uploads/rate-cons with requireRole, ahead of what it serves",
		forFile.length >= 3 && forFile[0].guard === "auth" && forFile.filter((m) => m.guard === "auth").length >= 3 && forRateCon[0].guard === "role", mounts);
	const t = MAIN.tables || {};
	eq("§1 the business tables are unchanged by the sweep (by content; audit_trail but its sign-in rows)", t.before && Object.keys(t.before).filter((k) => t.before[k] !== t.after[k]), []);
	ok("§1 ...the named ones were all read", t.before && ["users", "invoices", "expenses", "drivers_directory", "trucks", "documents", "messages", "notifications", "dispatch_notifications", "audit_trail", "kpi_metric_approvals", "investor_payouts"].every((k) => k in t.before), t.before && Object.keys(t.before));
	ok("§1 ...no sheet write and no mail", t.sheetWrites === 0 && t.mails === 0, t);
	const other = MAIN.viewerOtherMethods || {};
	ok("§1 the page's route answers reads only: POST, PUT, PATCH and DELETE get no answer from it", ["POST", "PUT", "PATCH", "DELETE"].every((m) => other[m] && other[m].status !== 200 && !isViewerAnswer(other[m])), other);
	const control = MAIN.control || {};
	ok("§1 CONTROL: a Dispatcher through the same harness is refused on none of the reads the KPI Viewer was refused on",
		CONTROL_READS.every((url) => control[url] && control[url].status !== 403 && control[url].status !== 401) &&
		CONTROL_READS.every((url) => MAIN.pass1 && MAIN.pass1.kv[`GET ${url}`] && MAIN.pass1.kv[`GET ${url}`].status === 403), control);
	const codeOf = (text) => text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
	const kvNamed = [...codeOf(SRC).matchAll(/requireRole\(([^)]*)\)/g)].filter((m) => m[1].includes(`"${KV_ROLE}"`));
	const libNamed = fs.readdirSync(path.join(BASE, "lib")).filter((f) => f.endsWith(".js"))
		.filter((f) => /requireRole\([^)]*"KPI Viewer"/.test(codeOf(fs.readFileSync(path.join(BASE, "lib", f), "utf8"))));
	ok("§1 requireRole names the KPI Viewer once, on GET /api/kpis/viewer, and no lib/ mount names it",
		kvNamed.length === 1 && /\napp\.get\("\/api\/kpis\/viewer", requireRole\("Super Admin", "KPI Viewer"\), kpiViewerLimiter,/.test(SRC) && libNamed.length === 0, kvNamed.map((m) => m[0]));

	const p2 = MAIN.pass2 || {};
	ok("§1 pass 2: setup is refused as for a signed-out request", p2.setupKv && p2.setupAnon && p2.setupKv.status === p2.setupAnon.status && same(p2.setupKv.json, p2.setupAnon.json) && p2.setupKv.status >= 400, [p2.setupKv, p2.setupAnon]);
	ok("§1 pass 2: login signs in as itself", p2.login && p2.login.status === 200 && p2.login.json?.user?.role === KV_ROLE && p2.login.json?.user?.id === IDS.kv
		&& p2.sessionAfterLogin.json?.authenticated === true && p2.sessionAfterLogin.json?.user?.id === IDS.kv, p2.login);
	ok("§1 pass 2: the forced first change goes through its exemption (before: 403 PASSWORD_CHANGE_REQUIRED on the page; after: the page)",
		p2.forcedBefore && p2.forcedBefore.status === 403 && p2.forcedBefore.json?.code === "PASSWORD_CHANGE_REQUIRED" && p2.change.status === 200 && p2.change.json?.success === true && isViewerAnswer(p2.forcedAfter), [p2.forcedBefore, p2.change, p2.forcedAfter && p2.forcedAfter.status]);
	ok("§1 pass 2: logout signs out", p2.logout && p2.logout.status === 200 && p2.sessionAfterLogout.json?.authenticated === false, p2.logout);
	const changedTables = p2.tablesBefore ? Object.keys(p2.tablesBefore).filter((k) => p2.tablesBefore[k] !== p2.tablesAfter[k]).sort() : null;
	eq("§1 pass 2 writes only its own rows: users (the password, the flag, the sign-in stamp) and audit_trail", changedTables, ["audit_trail", "users"]);
	eq("§1 ...whose audit rows are its sign-ins and the password change only", [...new Set((p2.audit || []).map((r) => r.action))].sort(), ["change_password", "login", "logout"]);
	const kvf = [p2.kvfBefore, p2.kvfAfter];
	ok("§1 ...the changed account: a new hash and the flag cleared", kvf[0] && kvf[1] && kvf[1].password_hash !== kvf[0].password_hash && kvf[0].must_change_password === 1 && kvf[1].must_change_password === 0);
	const strip = (r) => (r ? { ...r, last_login_at: null } : r);
	ok("§1 ...and the signed-in account only its sign-in stamp", p2.kvBefore && same(strip(p2.kvBefore), strip(p2.kvAfter)) && p2.kvAfter.last_login_at !== p2.kvBefore.last_login_at);
	ok("§1 its sign-ins keep a network record, as staff ones do (SIGN_IN_AUDIT_ENABLED; lib/sign-in.js STAFF_ROLES)", (p2.signInNetwork || []).some((r) => r.user_id === IDS.kv && r.n >= 1), p2.signInNetwork);
});

section("§2 sockets");
guarded("§2", () => {
	const s = MAIN.sockets || {};
	ok("§2 the KPI Viewer's socket connects and stays connected", s.kv && s.kv.connected === true, s.kv);
	eq("§2 ...its register joins no room, its own user room included", s.kv && s.kv.rooms, []);
	eq("§2 ...and the emits to every room (role rooms, its user room, every room open) reach it with nothing", s.kv && s.kv.received, []);
	ok("§2 ...while every role room was probed", s.probed && ["dispatch", "super-admin", "investor", `user:${ACCOUNTS[6].username}`].every((r) => s.probed.includes(r)), s.probed);
	ok("§2 CONTROL: a Dispatcher's register joins \"dispatch\" and the probe reaches it", s.disp && s.disp.rooms.includes("dispatch") && s.disp.received.includes("dispatch"), s.disp);
	const rooms = socketRooms(IO_HANDLER);
	ok("§2 the lifted handler: a KPI Viewer joins no room, whatever name it registers", !!rooms && kvRooms(rooms).every(([, v]) => v.rooms.length === 0 && !v.disconnected), rooms && kvRooms(rooms));
	const line = REGISTER_IF.trim();
	const regAt = IO_HANDLER ? IO_HANDLER.indexOf('socket.on("register"') : -1;
	const reg = regAt >= 0 ? IO_HANDLER.slice(regAt) : "";
	ok("§2 the early return comes right after the forced-change return, before any room is joined", reg.indexOf("if (currentMustChangePassword(sessionUser)) return;") >= 0 &&
		reg.indexOf(line) > reg.indexOf("if (currentMustChangePassword(sessionUser)) return;") && reg.indexOf(line) < reg.indexOf("socket.join("));
});

section("§3 GET /api/kpis/viewer");
guarded("§3", () => {
	const v = MAIN.viewer || {};
	ok("§3 a listed KPI Viewer: 200", isViewerAnswer(v.kv), v.kv && v.kv.status);
	const a = (v.kv && v.kv.json) || {};
	eq("§3 ...only the metrics approved now, in the catalog's order", (a.metrics || []).map((m) => m.key), SHOWN);
	const text = JSON.stringify(a);
	ok("§3 ...a stale definition, a changed setting, a withdrawn approval and no row are left out, not even named", LEFT_OUT.every((k) => !text.includes(k)), LEFT_OUT.filter((k) => text.includes(k)));
	eq("§3 ...exactly the allowlisted fields at every depth (no job, settings, recipients, approval, definitionVersion, breakdown, coverage or before/after)", allowlistProblems(a), []);
	const by = (k) => (a.metrics || []).find((m) => m.key === k) || {};
	ok("§3 ...weekly under an approval given after kpi.weekly_since, with its weeks", by("loads_delivered").weekly && by("loads_delivered").weekly.mode === "weekly" && by("loads_delivered").weekly.series.length === 2, by("loads_delivered").weekly);
	ok("§3 ...and not under one given before", !("weekly" in by("revenue")));
	ok("§3 ...a monthly-only metric's weekly block says why", by("fuel_mpg").weekly && by("fuel_mpg").weekly.mode === "monthly_only" && typeof by("fuel_mpg").weekly.reason === "string");
	ok("§3 ...the week rule at the top, the day of the figures, the source's label and link", typeof a.weekRule === "string" && a.asOfDay === KPI.day && by("co2_tonnes").source && typeof by("co2_tonnes").source.url === "string");
	const strip = (j) => (j ? { ...j, generatedAt: null } : j);
	ok("§3 a Super Admin: 200 and the same body", isViewerAnswer(v.sa) && same(strip(v.sa.json), strip(a)), v.sa && v.sa.status);
	ok("§3 an unlisted KPI Viewer: 403 KPI_VIEWER_NOT_LISTED", v.kvu && v.kvu.status === 403 && v.kvu.json?.code === "KPI_VIEWER_NOT_LISTED" && v.kvu.json?.error === "This account isn't on the KPI viewer list yet.", v.kvu);
	ok("§3 a KPI Viewer that must change its password: 403 PASSWORD_CHANGE_REQUIRED", v.kvf && v.kvf.status === 403 && v.kvf.json?.code === "PASSWORD_CHANGE_REQUIRED", v.kvf);
	ok("§3 the other three roles: 403 Forbidden", ["disp", "drv", "inv"].every((k) => v[k] && v[k].status === 403 && same(v[k].json, FORBIDDEN)), [v.disp, v.drv, v.inv]);
	ok("§3 signed out: 401", v.anon && v.anon.status === 401, v.anon);
	ok("§3 it reads stored rows only: no KPI run and no sheet read", MAIN.viewerRead && MAIN.viewerRead.runsAdded === 0 && MAIN.viewerRead.sheetCalls === 0, MAIN.viewerRead);
	ok("§3 no metric approved: [] and the sentence", isViewerAnswer(MAIN.viewerNone) && MAIN.viewerNone.json.metrics.length === 0 && MAIN.viewerNone.json.note === "No KPI has been approved for sharing yet.", MAIN.viewerNone);
});

section("§4 Add User and Edit User");
guarded("§4", () => {
	const u = MAIN.users || {};
	ok("§4 GET /api/users carries kpiViewerEnabled: true while the role is open", u.list && u.list.json && u.list.json.kpiViewerEnabled === true, u.list && u.list.json && Object.keys(u.list.json));
	const code = (r) => (r ? `${r.status} ${(r.json && r.json?.code) || ""}`.trim() : "none");
	eq("§4 Add User refuses a driver name or a company name with the role (400 KPI_VIEWER_FIELDS)", [code(u.withDriver), code(u.withCompany)], ["400 KPI_VIEWER_FIELDS", "400 KPI_VIEWER_FIELDS"]);
	ok("§4 ...a weak password, whatever NAMED_LOGINS_ENABLED says (off here)", u.weak && u.weak.status === 400, u.weak);
	ok("§4 ...and the acting admin's own password (PASSWORD_IS_YOURS)", u.own && u.own.status === 400 && u.own.json?.code === "PASSWORD_IS_YOURS", u.own);
	eq("§4 ...each writing nothing", u.countAfterRefusals, 0);
	ok("§4 Add User creates a KPI Viewer with the flag on and the CHECK widened", u.created && u.created.status === 200 && u.created.json?.success === true, u.created);
	ok("§4 ...role KPI Viewer, must_change_password 1, no driver or company name", u.newRow && u.newRow.role === KV_ROLE && u.newRow.must_change_password === 1 && u.newRow.driver_name === "" && u.newRow.company_name === "", u.newRow);
	eq("§4 ...and no drivers_directory row", u.newDirectoryRows, 0);
	ok("§4 ...which signs in and must change its password first", u.newLogin && u.newLogin.status === 200 && u.newLogin.json?.user?.mustChangePassword === true, u.newLogin);
	const audits = u.audit || [];
	const created = audits.find((r) => r.action === "create_user" && r.entity_id === NEW_KV.username);
	ok("§4 ...audited with the account id", !!created && u.newRow && created.details === `Created user "${NEW_KV.username}" with role KPI Viewer; account id ${u.newRow.id}; must change password at first sign-in`, created);
	ok("§4 the refusals are audited (create_user_blocked, KPI_VIEWER_FIELDS)", audits.some((r) => r.action === "create_user_blocked" && r.details.includes("[KPI_VIEWER_FIELDS]") && r.details.includes(`create ${NEW_KV.username} as KPI Viewer`)), audits);
	ok("§4 Edit User: the role resent with an email edit goes through", u.editEmail && u.editEmail.status === 200 && u.kvuAfterEmail.email === "kay.changed@example.test" && u.kvuAfterEmail.role === KV_ROLE, [u.editEmail, u.kvuAfterEmail]);
	ok("§4 ...so does a password edit, which ends the account's sessions", u.editPassword && u.editPassword.status === 200 && u.kvuAfterPassword.password_hash !== u.kvuAfterEmail.password_hash && u.kvuSessionAfterPassword.json?.authenticated === false, u.editPassword);
	eq("§4 ...a change from the role, or to it, is 409 KPI_VIEWER_ROLE_FIXED", [code(u.toDispatcher), code(u.fromDispatcher)], ["409 KPI_VIEWER_ROLE_FIXED", "409 KPI_VIEWER_ROLE_FIXED"]);
	eq("§4 ...a driver or company name on it is 400 KPI_VIEWER_FIELDS", [code(u.driverName), code(u.companyName)], ["400 KPI_VIEWER_FIELDS", "400 KPI_VIEWER_FIELDS"]);
	ok("§4 ...blank names, as the Users page sends them, go through", u.blankNames && u.blankNames.status === 200, u.blankNames);
	ok("§4 ...and the refusals wrote nothing", same(u.kvuBeforeRefusals, u.kvuAfterRefusals) && u.disp2After && u.disp2After.role === "Dispatcher", [u.kvuBeforeRefusals, u.kvuAfterRefusals]);
	const blocked = audits.filter((r) => r.action === "update_user_blocked").map((r) => (r.details.match(/\[(KPI_VIEWER_[A-Z_]+)\]/) || [])[1]).sort();
	eq("§4 ...each refusal audited as update_user_blocked", blocked, ["KPI_VIEWER_FIELDS", "KPI_VIEWER_FIELDS", "KPI_VIEWER_ROLE_FIXED", "KPI_VIEWER_ROLE_FIXED"]);
	ok("§4 ...naming the role asked for (a Dispatcher asked to become one)", audits.some((r) => r.action === "update_user_blocked" && r.details.includes('role "Dispatcher" -> "KPI Viewer"')), audits.filter((r) => r.action === "update_user_blocked"));
	ok("§4 disable works with ACCOUNT_DISABLE_ENABLED on and ends its sessions", u.disable && u.disable.status === 200 && u.disabledRow && !!u.disabledRow.disabled_at && u.disabledSession.json?.authenticated === false, [u.disable, u.disabledSession]);
	ok("§4 DELETE works as today", u.remove && u.remove.status === 200 && u.removedRow === null, u.remove);
});

// ── flag off, with KPI Viewers in the table (off again, and today) ───────────────────────────────────
const OFF = migrated.error ? { error: "no template" } : world(exportDir, migrated.template, "off", OFF_ENV);
ok("(setup) the flag-off world ran", !OFF.error, OFF.error);

section("§6 off again");
guarded("§6", () => {
	eq("§6 the start-up line says off and reads nothing more", kvLines(OFF).map(([lv, l]) => [lv, l]), [["log", "[kpi-viewer] off (KPI_VIEWER_ENABLED)"]]);
	ok("§6 an existing KPI Viewer can still sign in", OFF.logins && OFF.logins.kv === 200, OFF.logins);
	const off404 = (r) => r && r.status === 404 && r.json && r.json?.code === "FEATURE_OFF";
	const { problems } = judgeSweep(OFF, { label: "off", kvId: IDS.kv, viewerOk: off404 });
	eq("§6 ...and fails closed everywhere, its page answering 404 FEATURE_OFF", problems, []);
	ok("§6 a Super Admin's preview answers 404 too", off404(OFF.viewer && OFF.viewer.sa), OFF.viewer && OFF.viewer.sa);
	const s = OFF.sockets || {};
	ok("§6 its socket joins no room and receives nothing", s.kv && same(s.kv.rooms, []) && same(s.kv.received, []) && s.disp && s.disp.rooms.includes("dispatch"), s);
});

section("§5 flag off is today");
guarded("§5", () => {
	ok("§5 Add User refuses the role with the flag off: 403 KPI_VIEWER_DISABLED, nothing written", OFF.create && OFF.create.status === 403 && OFF.create.json?.code === "KPI_VIEWER_DISABLED" && OFF.createdRows === 0, OFF.create);
	ok("§5 ...audited as create_user_blocked", (OFF.audit || []).some((r) => r.action === "create_user_blocked" && r.details.includes("[KPI_VIEWER_DISABLED]")), OFF.audit);
	eq("§5 GET /api/users answers as before: no kpiViewerEnabled", OFF.list && OFF.list.json && Object.keys(OFF.list.json), ["users", "newStaffMustChangePassword"]);
	const disp = (OFF.audit || []).find((r) => r.action === "create_user" && r.entity_id === NEW_DISPATCHER.username);
	ok("§5 a Dispatcher is created as before: no forced change, and no account id in the audit row (NAMED_LOGINS_ENABLED off)",
		OFF.createDispatcher && OFF.createDispatcher.status === 200 && OFF.dispatcherRow && OFF.dispatcherRow.must_change_password === 0 && disp && disp.details === `Created user "${NEW_DISPATCHER.username}" with role Dispatcher`, [OFF.createDispatcher, disp]);

	// origin/main's code, as this change leaves it once its own lines are taken out.
	const baseAuth = REQUIRE_AUTH ? REQUIRE_AUTH.replace(ROLE_IF_RE, "") : null;
	const baseIo = IO_HANDLER ? IO_HANDLER.replace(REGISTER_IF, "") : null;
	const baseUsers = USERS_GET ? USERS_GET.replace(USERS_SPREAD, "") : null;
	ok("§5 requireAuth carries the role list once", !!REQUIRE_AUTH && ROLE_IF_RE.test(REQUIRE_AUTH) && baseAuth !== REQUIRE_AUTH);
	eq("§5 requireAuth less it is origin/main's", baseAuth && pinOf(baseAuth), ORIGIN_PINS.requireAuth);
	eq("§5 requireRole is origin/main's", REQUIRE_ROLE && pinOf(REQUIRE_ROLE), ORIGIN_PINS.requireRole);
	eq("§5 the connection handler less the early return is origin/main's", baseIo && baseIo !== IO_HANDLER && pinOf(baseIo), ORIGIN_PINS.ioHandler);
	eq("§5 GET /api/users less kpiViewerEnabled is origin/main's", baseUsers && baseUsers !== USERS_GET && pinOf(baseUsers), ORIGIN_PINS.usersGet);
	// The four roles' verdict on every requireAuth route and mount, with and without this change.
	const diffs = [];
	if (REQUIRE_AUTH && baseAuth) {
		const now = buildAuth(REQUIRE_AUTH);
		const before = buildAuth(baseAuth);
		const cases = [...AUTH_ROUTES.map((r) => ({ method: r.method, url: r.url, routePath: r.path })), { method: "GET", url: "/uploads/kpi-sweep/made-up-file.txt" }, { method: "POST", url: "/api/expenses?next=/api/auth/change-password", routePath: "/api/expenses" }];
		for (const c of cases) {
			for (const role of [...FOUR, null]) {
				for (const mustChangePassword of [false, true]) {
					for (const headers of [XRW, {}]) {
						for (const method of [c.method, "GET", "POST", "DELETE"]) {
							const user = role ? { id: 5, username: "made_up_sample", role, mustChangePassword } : null;
							const a = run(now, { ...c, method, headers, user });
							const b = run(before, { ...c, method, headers, user });
							if (!same(a, b)) diffs.push(`${role} ${method} ${c.url} mcp=${mustChangePassword} xrw=${headers === XRW}`);
						}
					}
				}
			}
		}
	}
	ok(`§5 the four roles (and no session) get the same verdict from requireAuth on all ${AUTH_ROUTES.length} requireAuth routes and the mounts, with and without this change`, AUTH_ROUTES.length >= 25 && diffs.length === 0 && !!baseAuth, diffs.slice(0, 5));
	const nowRooms = socketRooms(IO_HANDLER);
	const beforeRooms = socketRooms(baseIo);
	const fourOnly = (r) => r && Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith(`${KV_ROLE}|`)));
	ok("§5 the register joins the same rooms for the four roles, with and without this change", !!nowRooms && !!beforeRooms && same(fourOnly(nowRooms), fourOnly(beforeRooms)) && Object.keys(fourOnly(nowRooms)).length >= 20);
	ok("§5 ...and without it a KPI Viewer would join its own user room (what the early return closes)", !!beforeRooms && kvRooms(beforeRooms).some(([, v]) => v.rooms.length > 0));
	const literal = (src) => ((src || "").match(/\["Super Admin", "Dispatcher", "Driver", "Investor"\]\.includes\(/g) || []).length;
	ok("§5 requireAuth's and the register's literal lists are lib/kpi-viewer.js's FOUR_ROLES", literal(REQUIRE_AUTH) === 1 && literal(IO_HANDLER) === 1 && !!LIB && same(LIB.FOUR_ROLES, FOUR));
});

section("§3/§4 the CHECK not widened, and the list's states");
guarded("§3/§4", () => {
	const UNM = plain.error ? { error: "no template" } : world(exportDir, plain.template, "unmigrated", { KPI_VIEWER_ENABLED: "true" }, PLAIN_ACCOUNTS);
	ok("(setup) the not-widened world ran", !UNM.error, UNM.error);
	const lines = kvLines(UNM);
	ok("§3 flag on, CHECK not widened: one start-up error naming the script, the list and the accounts in it", lines.length === 1 && lines[0][0] === "error" && lines[0][1].includes("users CHECK admits KPI Viewer: no; KPI_VIEWER_IDS unset; 0 KPI Viewer accounts, 0 listed") && lines[0][1].includes("scripts/migrate-users-kpi-viewer-role.js"), lines);
	ok("§3 ...the page answers 503 KPI_VIEWER_SCHEMA", UNM.viewer && UNM.viewer.sa && UNM.viewer.sa.status === 503 && UNM.viewer.sa.json?.code === "KPI_VIEWER_SCHEMA", UNM.viewer);
	ok("§4 ...Add User refuses the role: 503 KPI_VIEWER_SCHEMA, nothing written, audited", UNM.create && UNM.create.status === 503 && UNM.create.json?.code === "KPI_VIEWER_SCHEMA" && UNM.createdRows === 0 && (UNM.audit || []).some((r) => r.action === "create_user_blocked" && r.details.includes("[KPI_VIEWER_SCHEMA]")), [UNM.create, UNM.audit]);
	ok("§4 ...GET /api/users carries no kpiViewerEnabled", UNM.list && UNM.list.json && !("kpiViewerEnabled" in UNM.list.json));
	ok("§4 ...and the table itself refuses the role (the role stays closed)", /CHECK constraint failed/.test(String(UNM.directInsert)), UNM.directInsert);

	const mainLines = kvLines(MAIN);
	eq("§7b the main world's start-up: one line, then one warning for the unlisted KPI Viewer", mainLines, [
		["log", "[kpi-viewer] on; users CHECK admits KPI Viewer: yes; KPI_VIEWER_IDS valid (2 ids); 3 KPI Viewer accounts, 2 listed"],
		["warn", `[kpi-viewer] KPI Viewer account #${IDS.kvu} isn't on KPI_VIEWER_IDS: its KPI page shows no figures`],
	]);
	for (const [label, value, line] of [
		["unset", undefined, "KPI_VIEWER_IDS unset; 3 KPI Viewer accounts, 0 listed"],
		["empty", "", "KPI_VIEWER_IDS invalid; 3 KPI Viewer accounts, 0 listed"],
		["invalid", `${IDS.kv},made_up_name`, "KPI_VIEWER_IDS invalid; 3 KPI Viewer accounts, 0 listed"],
	]) {
		const env = { KPI_VIEWER_ENABLED: "true" };
		if (value !== undefined) env.KPI_VIEWER_IDS = value;
		const W = migrated.error ? { error: "no template" } : world(exportDir, migrated.template, "list", env);
		ok(`(setup) the list-${label} world ran`, !W.error, W.error);
		const v = W.viewer || {};
		ok(`§3 the list ${label}: a KPI Viewer gets 403 KPI_VIEWER_NOT_LISTED`, v.kv && v.kv.status === 403 && v.kv.json?.code === "KPI_VIEWER_NOT_LISTED", v.kv);
		ok(`§3 ...a Super Admin still previews it (200)`, isViewerAnswer(v.sa), v.sa && v.sa.status);
		const l = kvLines(W);
		ok(`§7b ...the start-up line names the list's state (${label})`, l.length >= 1 && l[0][1] === `[kpi-viewer] on; users CHECK admits KPI Viewer: yes; ${line}`, l);
		ok(`§7b ...an error for a list set but invalid, never its text (${label})`, label === "unset" ? !l.some(([lv]) => lv === "error") : l.some(([lv, t]) => lv === "error" && /set but invalid/.test(t) && !t.includes("made_up_name")), l);
	}
});

section("§8 scripts/kpi-followups-report.js --part=viewer");
guarded("§8", () => {
	// On a copy of the migrated world's database, with a made-up log holding the start-up line.
	const dir = fs.mkdtempSync(path.join(TMP, "report-"));
	const dbFile = path.join(dir, "copy.db");
	fs.copyFileSync(migrated.template, dbFile);
	const log = path.join(dir, "made-up-app.log");
	const line = "[kpi-viewer] on; users CHECK admits KPI Viewer: yes; KPI_VIEWER_IDS valid (2 ids); 3 KPI Viewer accounts, 2 listed";
	fs.writeFileSync(log, `[kpi] weekly figures on (KPI_WEEKLY_ENABLED)\n2026-10-20T08:00:00Z ${line}\nsomething else\n`);
	const run = spawnSync(process.execPath, [path.join(BASE, "scripts", "kpi-followups-report.js"), "--part=viewer", `--db=${dbFile}`, `--startup-log=${log}`, "--json"], {
		encoding: "utf8", timeout: 50000, cwd: dir, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, TMPDIR: os.tmpdir() },
	});
	let r = null;
	try { r = JSON.parse(run.stdout); } catch { r = null; }
	ok("§8 it runs and exits 0", run.status === 0 && !!r, `${run.status} ${(run.stderr || "").slice(-300)}`);
	ok("§8 the users table, its child keys and the rebuild's verdict (nothing to do on a widened CHECK)", !!r && r.users.rows >= 9 && r.users.children.length === 4 && /^nothing to do/.test(r.rebuild.verdict) && /^[0-9a-f]{16}$/.test(r.rebuild.fingerprint), r && r.rebuild);
	eq("§8 the KPI Viewer accounts by id: enabled, must change its password, signed in yet", r && r.kpiViewers, [
		{ id: IDS.kv, enabled: true, mustChangePassword: false, signedIn: false },
		{ id: IDS.kvu, enabled: true, mustChangePassword: false, signedIn: false },
		{ id: IDS.kvf, enabled: true, mustChangePassword: true, signedIn: false },
	]);
	eq("§8 the approvals: valid now, stale, and given after weekly figures began", r && [r.approvals.valid.map((a) => a.key), r.approvals.stale, r.approvals.afterWeeklySince],
		[["co2_tonnes", "fuel_mpg", "loads_delivered", "revenue"], ["fuel_savings", "miles_driven"], ["co2_tonnes", "fuel_mpg", "loads_delivered"]]);
	ok("§8 the shared page's answer on this data: the approved metrics, within the allowlist, weekly off and on", !!r && same(r.answer.weeklyOff.metrics, SHOWN) && same(r.answer.weeklyOn.metrics, SHOWN)
		&& r.answer.weeklyOn.outside.length === 0 && r.answer.weeklyOn.fields.includes("metrics[].weekly.series[].label") && !r.answer.weeklyOff.fields.some((f) => f.includes("weekly")) && r.proofs.answerWithinAllowlist, r && r.answer);
	ok("§8 a KPI Viewer's verdict on every route and mount: only change-password and the page allowed; the rest refused or unguarded",
		!!r && same([...r.routes.allowed].sort(), ["GET /api/kpis/viewer", "POST /api/auth/change-password"]) && r.routes.forbidden >= 200 && r.routes.roleNotAllowed >= 25
		&& r.routes.mountsRefused.length === 4 && r.routes.other.length === 0 && r.proofs.onlyItsOwnRoutes, r && r.routes);
	eq("§8 the flag and the list from the start-up line in the log", r && r.startup, line);
	const out = run.stdout || "";
	ok("§8 no username, email or hash in its output", !ACCOUNTS.some((a) => out.includes(a.username)) && !/@example\.test|\$2[aby]\$/.test(out));
});

section("§7 mutants of the shipped source");
guarded("§7", () => {
	// The lifted guard and handler, each mutant required to flip a property the shipped code holds.
	const shipped = authProbe(REQUIRE_AUTH || "");
	ok("§7 the shipped requireAuth holds every property", Object.values(shipped).every(Boolean), shipped);
	const ROLE_LIST = '["Super Admin", "Dispatcher", "Driver", "Investor"].includes(req.session.user.role)';
	const EXEMPT = 'req.route && req.route.path === "/api/auth/change-password"';
	const authMutants = [
		["requireAuth's role list removed", (s) => s.replace(ROLE_IF_RE, ""), ["refusesEveryAuthRoute", "refusesMount"]],
		["the role list widened to any role", (s) => s.replace(ROLE_LIST, 'typeof req.session.user.role === "string"'), ["refusesEveryAuthRoute", "refusesMount"]],
		["the role list widened to name the KPI Viewer", (s) => s.replace(ROLE_LIST, '["Super Admin", "Dispatcher", "Driver", "Investor", "KPI Viewer"].includes(req.session.user.role)'), ["refusesEveryAuthRoute"]],
		["the exemption keyed on the URL", (s) => s.replace(EXEMPT, 'String(req.originalUrl || "").includes("/api/auth/change-password")'), ["refusesMentioningUrl", "passesRoutedVariant"]],
		["a second route exempted", (s) => s.replace(`${EXEMPT}))`, `${EXEMPT}) && !(req.route && req.route.path === "/api/tabs"))`), ["refusesEveryAuthRoute"]],
		["the role check after the CSRF check", (s) => s.replace(ROLE_IF_RE, "").replace("\n\tnext();\n}", '\n\tif (!["Super Admin", "Dispatcher", "Driver", "Investor"].includes(req.session.user.role)) return res.status(403).json({ error: "This account can\'t open this page.", code: "ROLE_NOT_ALLOWED" });\n\tnext();\n}'), ["refusesBeforeCsrf", "refusesBeforeForcedChange"]],
	];
	for (const [name, edit, props] of authMutants) {
		const src = REQUIRE_AUTH ? edit(REQUIRE_AUTH) : "";
		ok(`§7 mutant "${name}" changes the source (its anchor is there)`, !!REQUIRE_AUTH && src !== REQUIRE_AUTH);
		const got = authProbe(src);
		for (const prop of props) ok(`§7 MUTANT CAUGHT: "${name}" flips ${prop}`, shipped[prop] === true && got[prop] === false, got);
	}
	const shippedRooms = socketRooms(IO_HANDLER);
	const kvJoins = (rooms) => !!rooms && kvRooms(rooms).some(([, v]) => v.rooms.length > 0);
	ok("§7 the shipped handler: no KPI Viewer room", !!shippedRooms && !kvJoins(shippedRooms));
	const ownRoomJoin = "\t\tif (requested && requested === usernameLower) socket.join(userRoom(usernameLower));";
	const ioMutants = [
		["the register's early return removed", (s) => s.replace(REGISTER_IF, "")],
		["the early return placed after the own-user-room join", (s) => s.replace(REGISTER_IF, "").replace(ownRoomJoin, `${ownRoomJoin}${REGISTER_IF}`)],
		["the role treated as staff in the register", (s) => s.replace(REGISTER_IF, "").replace('if (role === "Super Admin" || role === "Dispatcher") {', 'if (role === "Super Admin" || role === "Dispatcher" || role === "KPI Viewer") {')],
	];
	for (const [name, edit] of ioMutants) {
		const src = IO_HANDLER ? edit(IO_HANDLER) : "";
		ok(`§7 mutant "${name}" changes the source`, !!IO_HANDLER && src !== IO_HANDLER);
		ok(`§7 MUTANT CAUGHT: "${name}" joins the KPI Viewer to a room`, kvJoins(socketRooms(src)));
	}

	// Mutants of lib/kpi-viewer.js, each through the battery the shipped lib passes.
	const libMutants = [
		["the list's unset state read as everyone", 'list.verdict(user) === "listed"', '["listed", "unset"].includes(list.verdict(user))'],
		["an unapproved or stale metric sent", ".filter((m) => m && typeof m === \"object\" && m.approval && m.approval.approved === true)", ".filter((m) => m && typeof m === \"object\")"],
		["beforeAfter sent", "\tout.comparisons = pickEach(m.comparisons, COMPARISON_FIELDS);", "\tout.comparisons = pickEach(m.comparisons, COMPARISON_FIELDS);\n\tout.beforeAfter = m.beforeAfter;"],
		["a disallowed field sent (definitionVersion)", '"key", "label", "unit", "kind", "group", "definition", "status"', '"key", "label", "unit", "kind", "group", "definition", "definitionVersion", "status"'],
		["coverage kept on the series", 'const SERIES_FIELDS = Object.freeze(["period", "value", "display"]);', 'const SERIES_FIELDS = Object.freeze(["period", "value", "display", "coverage"]);'],
		["weekly under any approval", "if (m.weekly && m.approval && approvedAfter(m.approval.at, weeklySince))", "if (m.weekly && m.approval)"],
		["the flag ignored on the page", '\tif (enabled !== true) return { status: 404, body: { error: "Not found", code: "FEATURE_OFF" } };\n', ""],
		["the CHECK ignored on the page", "\tif (schemaReady !== true) {\n\t\treturn { status: 503,", "\tif (false) {\n\t\treturn { status: 503,"],
		["Add User accepting the role with the flag off", "function createRefusal({ enabled, schemaReady, driverName, companyName }) {\n\tif (enabled !== true) {", "function createRefusal({ enabled, schemaReady, driverName, companyName }) {\n\tif (false) {"],
		["Edit User letting the role change", "if (asked !== null && (asked === ROLE) !== (currentRole === ROLE)) {", "if (false) {"],
		["the census reading a disabled KPI Viewer as listed", ".filter((r) => r && !isDisabledRow(r))", ".filter((r) => r)"],
	];
	for (const [name, from, to] of libMutants) {
		let misses = ["not run"];
		try {
			const L = LIB ? libWith(from, to) : { anchorMissing: true };
			ok(`§7 lib mutant "${name}" changes the source (its anchor is there)`, !L.anchorMissing);
			misses = L.anchorMissing ? [] : libBattery(L);
		} catch (e) { misses = [`threw: ${e.message}`]; }
		ok(`§7 MUTANT CAUGHT: lib "${name}"`, misses.length > 0, misses);
	}

	// Mutants of server.js, each on the real app.
	const serverMutant = (name, edits, scenario, env, judge, template = migrated.template, accounts = ACCOUNTS) => {
		let dir;
		try { dir = exportTree(edits); } catch (e) { ok(`§7 server mutant "${name}" changes the source`, false, e.message); return; }
		ok(`§7 server mutant "${name}" changes the source`, true);
		const W = world(dir, template, scenario, env, accounts);
		ok(`§7 MUTANT CAUGHT: "${name}"`, !W.error && judge(W), W.error || "");
	};
	const viewer200 = (W, key) => W.viewer && isViewerAnswer(W.viewer[key]);
	serverMutant("the role added to another route's requireRole list",
		[{ from:'app.get("/api/users/investors", requireRole("Super Admin", "Dispatcher")', to: 'app.get("/api/users/investors", requireRole("Super Admin", "Dispatcher", "KPI Viewer")' }],
		"sweepOnly", ON_ENV, (W) => judgeSweep(W, { label: "m", kvId: IDS.kv, viewerOk: isViewerAnswer }).problems.length > 0);
	serverMutant("Add User passing the flag as on",
		[{ from:"kpiViewer.createRefusal({ enabled: KPI_VIEWER_ENABLED,", to: "kpiViewer.createRefusal({ enabled: true," }],
		"usersOff", OFF_ENV, (W) => !(W.create && W.create.status === 403 && W.createdRows === 0));
	serverMutant("the page passing the flag as on",
		[{ from:"kpiViewer.viewerRefusal({ enabled: KPI_VIEWER_ENABLED,", to: "kpiViewer.viewerRefusal({ enabled: true," }],
		"viewerOnly", OFF_ENV, (W) => !(W.viewer && W.viewer.kv && W.viewer.kv.status === 404));
	serverMutant("the page and Add User passing the CHECK as widened",
		[{ from:"schemaReady: KPI_VIEWER_SCHEMA_READY, list: KPI_VIEWERS", to: "schemaReady: true, list: KPI_VIEWERS" },
			{ from:"kpiViewer.createRefusal({ enabled: KPI_VIEWER_ENABLED, schemaReady: KPI_VIEWER_SCHEMA_READY,", to: "kpiViewer.createRefusal({ enabled: KPI_VIEWER_ENABLED, schemaReady: true," }],
		"unmigrated", { KPI_VIEWER_ENABLED: "true" }, (W) => !(W.viewer && W.viewer.sa && W.viewer.sa.status === 503) && !(W.create && W.create.status === 503), plain.template, PLAIN_ACCOUNTS);
	serverMutant("the page's route taking writes (app.all)",
		[{ from:'app.get("/api/kpis/viewer", requireRole("Super Admin", "KPI Viewer")', to: 'app.all("/api/kpis/viewer", requireRole("Super Admin", "KPI Viewer")' }],
		"viewerOnly", ON_ENV, (W) => !!W.viewerOtherMethods && ["POST", "PUT", "PATCH", "DELETE"].some((m) => isViewerAnswer(W.viewerOtherMethods[m])));
	serverMutant("the page's list check skipped (KPI_VIEWERS read as listing everyone)",
		[{ from:"const KPI_VIEWERS = kpiViewer.viewerList(process.env.KPI_VIEWER_IDS);", to: "const KPI_VIEWERS = { ...kpiViewer.viewerList(process.env.KPI_VIEWER_IDS), verdict: () => \"listed\" };" }],
		"list", { KPI_VIEWER_ENABLED: "true" }, (W) => viewer200(W, "kv"));
});

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
