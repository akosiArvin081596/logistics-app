#!/usr/bin/env node
/**
 * scripts/lib/kpi-viewer-world.js: the import half of scripts/test-kpi-viewer.js (its header says what is
 * asserted). Not a runner: only that runner starts it, with a scrubbed environment and the export's
 * folder as its working folder.
 *
 *   node scripts/lib/kpi-viewer-world.js <setup.json>
 *
 * mode "prepare": imports the export's server.js once, which builds the schema; widens the users CHECK
 *   to admit "KPI Viewer" when asked (lib/users-role-migration.js, or a plain rebuild of the scratch table
 *   when that module is missing); seeds the made-up accounts and KPI rows; and writes a clean copy of the
 *   database (VACUUM INTO) that each world starts from.
 * mode "world": imports server.js on its own copy of that database, listens on 127.0.0.1 port 0, runs one
 *   scenario and writes what it saw (statuses, bodies, rows, rooms, log lines) to `out`. It asserts
 *   nothing; the runner does.
 *
 * Google answers with an empty sheet and records every call, mail goes nowhere, every connection that
 * isn't loopback is refused, and the browser is a stand-in that exits. Made-up data only.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("dns");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const setup = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const result = { mode: setup.mode, scenario: setup.scenario || null, lines: [], notes: [] };
const finish = (code) => {
	fs.writeFileSync(setup.out, JSON.stringify(result));
	process.exit(code);
};
process.on("uncaughtException", (e) => { result.error = String((e && e.stack) || e); finish(1); });
process.on("unhandledRejection", (e) => { result.error = String((e && e.stack) || e); finish(1); });

// ── the log: kept, never printed ─────────────────────────────────────────────────────────────────────
for (const level of ["log", "warn", "error", "info"]) {
	console[level] = (...a) => { result.lines.push([level, a.map(String).join(" ")]); };
}

// ── no outside world ─────────────────────────────────────────────────────────────────────────────────
const sheetCalls = [];
const rows = [["Load ID", "Driver", "Status", "Truck"]];
const sheetOp = (name) => async (args) => {
	sheetCalls.push(name);
	return { data: { values: rows, sheets: [], valueRanges: [], files: [], replies: [] }, args: undefined };
};
const google = {
	options() {},
	auth: { GoogleAuth: class { async getClient() { return {}; } }, JWT: class { async authorize() { return {}; } } },
	sheets: () => ({ spreadsheets: {
		get: sheetOp("get"), batchUpdate: sheetOp("batchUpdate"),
		values: { get: sheetOp("values.get"), batchGet: sheetOp("values.batchGet"), update: sheetOp("values.update"), batchUpdate: sheetOp("values.batchUpdate"), append: sheetOp("values.append"), clear: sheetOp("values.clear") },
	} }),
	drive: () => ({ files: { list: sheetOp("drive.list"), get: sheetOp("drive.get"), create: sheetOp("drive.create"), update: sheetOp("drive.update"), delete: sheetOp("drive.delete") } }),
};
const mails = [];
const nodemailer = { createTransport: () => ({ sendMail: async (m) => { mails.push(String((m && m.subject) || "")); return { messageId: "made-up" }; }, verify: async () => true }) };
const realLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "googleapis") return { google };
	if (request === "nodemailer") return nodemailer;
	return realLoad.call(this, request, ...rest);
};
globalThis.fetch = async () => { throw new Error("test: no network (fetch)"); };
const loopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const a = Array.isArray(args[0]) ? args[0] : args;
	const o = a[0] && typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
	if (o.path || loopback(o.host || "localhost")) return connect.apply(this, args);
	throw new Error("test: no network (connect)");
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
	if (loopback(host)) return lookup.call(dns, host, ...rest);
	throw new Error("test: no network (dns)");
};

const EXPORT = setup.exportDir;
const fromExport = (m) => require(path.join(EXPORT, "node_modules", m));
const Database = fromExport("better-sqlite3");
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── prepare ──────────────────────────────────────────────────────────────────────────────────────────
// Widens the scratch users CHECK without 2a-1's module (a base from before it): the documented order,
// foreign keys off, on made-up rows only.
function widenCheckByHand(db) {
	const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
	if (sql.includes("'KPI Viewer'")) return "already";
	const wider = sql.replace("'Investor')", "'Investor', 'KPI Viewer')").replace(/^CREATE TABLE "?users"?/, "CREATE TABLE users_new");
	db.pragma("foreign_keys = OFF");
	db.exec("BEGIN");
	db.exec(wider);
	db.exec("INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;");
	db.exec("COMMIT");
	db.pragma("foreign_keys = ON");
	return "by hand";
}

function seedKpi(db, kpi) {
	const catalog = require(path.join(EXPORT, "lib", "kpi-catalog.js"));
	const day = kpi.day;
	const sentinel = (what) => `SENTINEL-${what}`;
	const payloadFor = (key) => JSON.stringify({
		current: { from: "2026-09-01", to: "2026-09-30", value: 12, display: "12", label: "September 2026", coverage: { num: 1, den: 2 }, extra: sentinel("CURRENT-EXTRA") },
		totals: [
			{ label: "All time", from: "2025-04-01", to: day, value: 120, display: "120", note: sentinel("TOTAL-EXTRA") },
			{ label: "Month to date", from: "2026-10-01", to: day, value: 7, display: "7" },
		],
		comparisons: [{ kind: "mom", label: "vs August 2026", basePeriod: "2026-08", value: 12, baseValue: 10, deltaPct: 20, display: "+20.0%", status: "ok", hint: sentinel("COMPARISON-EXTRA") }],
		beforeAfter: [{ event: sentinel("BEFORE-AFTER"), date: "2026-04-09", status: "ok", display: "+5%" }],
		coverage: { num: 7, den: 9, ratio: 0.7778, what: sentinel("COVERAGE"), from: null, to: null },
		warnings: [`a made-up warning for ${key}`],
		assumptions: [`a made-up assumption for ${key}`],
		breakdown: [{ label: sentinel("BREAKDOWN"), value: 3, display: "3" }],
		missingReason: null,
	});
	const snap = db.prepare("INSERT OR REPLACE INTO kpi_snapshots (day, metric_key, value, display, status, confidence, definition_version, payload, computed_at) VALUES (?, ?, ?, ?, 'ok', 'high', ?, ?, ?)");
	const series = db.prepare("INSERT OR REPLACE INTO kpi_series (metric_key, period, value, display, coverage, computed_at) VALUES (?, ?, ?, ?, ?, ?)");
	for (const m of catalog.METRICS) {
		snap.run(day, m.key, 12, "12", m.definitionVersion, payloadFor(m.key), `${day}T08:00:00.000Z`);
		for (const period of ["2026-08", "2026-09"]) series.run(m.key, period, 10, "10", 0.875, `${day}T08:00:00.000Z`);
	}
	const weekly = db.prepare("INSERT OR REPLACE INTO kpi_series_weekly (metric_key, week_start, week_end, to_day, partial, label, value, display, coverage, vs_label, vs_display, vs_status, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	for (const key of kpi.weeklyKeys) {
		weekly.run(key, "2026-10-10", "2026-10-16", "2026-10-16", 0, "Oct 10-16, 2026", 4, "4", 0.9, "vs Oct 3-9", "+33.3%", "ok", `${day}T08:00:00.000Z`);
		weekly.run(key, "2026-10-17", "2026-10-23", day, 1, "Oct 17-20, 2026 (to date)", 2, "2", 0.9, null, null, null, `${day}T08:00:00.000Z`);
	}
	db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('kpi.settings', ?, ?, 'made-up')")
		.run(JSON.stringify(kpi.settings), `${day}T08:00:00.000Z`);
	db.prepare("INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES ('kpi.weekly_since', ?, CURRENT_TIMESTAMP)").run(kpi.weeklySince);
	const approve = db.prepare("INSERT OR REPLACE INTO kpi_metric_approvals (metric_key, approved, definition_version, settings_hash, approved_by, approved_at) VALUES (?, ?, ?, ?, 'owner_sample', ?)");
	for (const a of kpi.approvals) {
		const def = catalog.metricByKey(a.key);
		const settings = { ...kpi.settings, ...(a.hashSettings || {}) };
		approve.run(a.key, a.approved, a.definitionVersion === "current" ? def.definitionVersion : a.definitionVersion, catalog.settingsHashFor(a.key, settings), a.at);
	}
}

async function prepare() {
	require(path.join(EXPORT, "server.js"));
	const db = new Database(setup.dbFile);
	db.pragma("busy_timeout = 5000");
	if (setup.migrate) {
		const lib = path.join(EXPORT, "lib", "users-role-migration.js");
		if (fs.existsSync(lib)) {
			const L = require(lib);
			const d = L.dryRunReport(db);
			const r = L.applyRebuild(db, { expect: d.fingerprint, expectFk: d.baseline });
			result.migration = { exit: r.exit, state: r.state, reasons: r.reasons };
		} else {
			result.migration = { exit: 0, state: widenCheckByHand(db) };
		}
	}
	const bcrypt = fromExport("bcryptjs");
	const insert = db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	result.ids = {};
	for (const a of setup.accounts) {
		result.ids[a.key] = Number(insert.run(a.username, bcrypt.hashSync(a.password, 4), a.role, a.driverName || "", a.email || "", a.fullName || "", a.companyName || "", a.mustChange ? 1 : 0).lastInsertRowid);
	}
	if (setup.kpi) seedKpi(db, setup.kpi);
	db.prepare("VACUUM INTO ?").run(setup.templateOut);
	db.close();
	finish(0);
}

// ── a world ──────────────────────────────────────────────────────────────────────────────────────────
let base = "";
function request(method, url, { client = null, body, headers = {}, timeoutMs = 15000 } = {}) {
	return new Promise((resolve) => {
		const data = body === undefined ? (method === "GET" || method === "HEAD" ? null : "{}") : JSON.stringify(body);
		const h = { "X-Requested-With": "XMLHttpRequest", ...headers };
		if (data !== null) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
		if (client && client.cookie) h.Cookie = client.cookie;
		const req = http.request(base + url, { method, headers: h }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const set = res.headers["set-cookie"];
				if (client && set) {
					const sid = set.map((c) => c.split(";")[0]).find((c) => c.startsWith("connect.sid="));
					if (sid) client.cookie = sid;
				}
				const buf = Buffer.concat(chunks);
				const type = String(res.headers["content-type"] || "");
				let json;
				if (/json/.test(type)) { try { json = JSON.parse(buf.toString("utf8")); } catch { json = undefined; } }
				resolve({ status: res.statusCode, type, json, text: json === undefined ? sha(buf).slice(0, 16) + `:${buf.length}` : null });
			});
		});
		req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
		req.on("error", (e) => resolve({ status: "error", error: e.message }));
		if (data !== null) req.write(data);
		req.end();
	});
}
const answer = (r) => ({ status: r.status, json: r.json, text: r.text, error: r.error });

async function signIn(account) {
	const client = { cookie: "", account: account.key };
	const r = await request("POST", "/api/auth/login", { client, body: { username: account.username, password: account.password } });
	client.login = answer(r);
	return client;
}

// The app's routes, read off its Express stack: methods, paths, the guard each mounts and how many
// handlers run in front of that guard.
function guardOf(fn) {
	if (typeof fn !== "function") return null;
	if (fn.name === "requireAuth") return "auth";
	if (Function.prototype.toString.call(fn) === setup.roleArrow) return "role";
	return null;
}
function readStack(app) {
	const routes = [];
	const mounts = [];
	for (const layer of app._router.stack) {
		if (layer.route) {
			const handles = layer.route.stack.map((l) => l.handle);
			const at = handles.findIndex((h) => guardOf(h));
			// Express 4's app.all() registers every method on the route; it is shown as one "_all".
			const verbs = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
			const methods = verbs.includes("_all") || verbs.length >= 20 ? ["_all"] : verbs;
			const paths = Array.isArray(layer.route.path) ? layer.route.path.flat(Infinity) : [layer.route.path];
			routes.push({ methods, paths, guard: at < 0 ? "none" : guardOf(handles[at]), gates: at < 0 ? 0 : at, handlers: handles.length });
		} else if (layer.regexp && !layer.regexp.fast_slash && layer.name !== "query" && layer.name !== "expressInit") {
			mounts.push({ source: layer.regexp.source, name: layer.handle && layer.handle.name, guard: guardOf(layer.handle) });
		}
	}
	return { routes, mounts };
}
const concrete = (p) => String(p).replace(/:([A-Za-z0-9_]+)/g, "made-up-1");
const SESSION_CHANGING = new Set(["POST /api/auth/setup", "POST /api/auth/login", "POST /api/auth/logout", "POST /api/auth/change-password"]);

// Every registered route once per method and path, the session-changing four left out.
function targets(routes) {
	const out = [];
	for (const r of routes) {
		for (const m of r.methods) {
			const method = m === "_all" ? "GET" : m.toUpperCase();
			for (const p of r.paths) {
				if (typeof p !== "string" || p === "*") continue;
				const id = `${m === "_all" ? "ALL" : method} ${p}`;
				if (SESSION_CHANGING.has(id)) continue;
				out.push({ id, method, url: concrete(p), guard: r.guard, gates: r.gates });
			}
		}
	}
	return out;
}
async function sweep(list, client) {
	const out = {};
	for (const t of list) out[t.id] = answer(await request(t.method, t.url, { client }));
	return out;
}

function tableNames(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
}
// The business tables by content: the named ones, every kpi_* and payout table, audit_trail but its
// sign-in rows (a sign-in writes them by design).
function fingerprints(db) {
	const named = ["users", "invoices", "expenses", "drivers_directory", "trucks", "documents", "messages", "notifications", "dispatch_notifications", "audit_trail"];
	const names = tableNames(db).filter((n) => named.includes(n) || /^kpi_/.test(n) || /payout/.test(n));
	const out = {};
	for (const n of names) {
		const where = n === "audit_trail" ? " WHERE action NOT IN ('login', 'logout', 'login_refused')" : "";
		out[n] = sha(JSON.stringify(db.prepare(`SELECT * FROM "${n}"${where} ORDER BY rowid`).raw().all()));
	}
	return out;
}
const sheetWrites = () => sheetCalls.filter((c) => !/get$|list$|batchGet$/.test(c)).length;

// Each [key, name, client] opens a live-update socket on its session's cookie and registers with `name`;
// then every room is sent a probe, and what each socket received is kept with the rooms it is in.
async function sockets(io, clients, roomsToProbe) {
	const ioClient = require(require.resolve("socket.io-client", { paths: [path.join(setup.repoRoot, "client")] }));
	const out = {};
	const opened = [];
	for (const [key, name, client] of clients) {
		const s = ioClient(base, { transports: ["websocket"], extraHeaders: { Cookie: client.cookie }, reconnection: false, forceNew: true });
		const got = [];
		s.onAny((event, payload) => got.push([event, payload]));
		await new Promise((resolve) => { s.on("connect", resolve); s.on("connect_error", resolve); setTimeout(resolve, 3000); });
		s.emit("register", name);
		opened.push([key, s, got]);
	}
	// Settled once the control's register has joined it to "dispatch" (or after 3 s), and a beat more.
	const until = async (pred) => { for (let i = 0; i < 60 && !(await pred()); i++) await sleep(50); };
	await until(async () => (await io.in("dispatch").fetchSockets()).length > 0);
	await sleep(100);
	const live = await io.fetchSockets();
	for (const [key, s] of opened) {
		const mine = live.find((x) => x.id === s.id);
		out[key] = { connected: s.connected, rooms: mine ? [...mine.rooms].filter((r) => r !== s.id).sort() : null };
	}
	const probe = new Set(roomsToProbe);
	for (const room of io.of("/").adapter.rooms.keys()) if (!live.some((x) => x.id === room)) probe.add(room);
	for (const room of probe) io.to(room).emit("kpi-viewer-probe", room);
	await until(async () => opened.some(([, , got]) => got.some(([e, p]) => e === "kpi-viewer-probe" && p === "dispatch")));
	await sleep(100);
	for (const [key, s, got] of opened) {
		out[key].received = got.filter(([e]) => e === "kpi-viewer-probe").map(([, p]) => p).sort();
		s.close();
	}
	out.probed = [...probe].sort();
	return out;
}

async function world() {
	const { app, server, io } = require(path.join(EXPORT, "server.js"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	const db = new Database(setup.dbFile);
	db.pragma("busy_timeout = 5000");
	const ids = Object.fromEntries(setup.accounts.map((a) => [a.key, db.prepare("SELECT id FROM users WHERE username = ?").get(a.username)?.id ?? null]));
	result.ids = ids;
	const account = (key) => setup.accounts.find((a) => a.key === key);
	const stack = readStack(app);
	result.routes = stack.routes;
	result.mounts = stack.mounts;
	const scenarios = { main, off, unmigrated, list, sweepOnly, usersOff, viewerOnly };
	await scenarios[setup.scenario]({ app, io, db, ids, account, stack });
	result.sheetCalls = sheetCalls.slice();
	result.mails = mails.length;
	server.close();
	db.close();
	finish(0);
}

// One KPI Viewer session against every route; the signed-out answers beside it.
async function passOne(stack, kv) {
	const list = targets(stack.routes);
	const anon = await sweep(list, null);
	const mine = await sweep(list, kv);
	return { list, anon, kv: mine };
}

async function uploads(clients) {
	const out = {};
	for (const [key, client] of clients) {
		out[key] = {
			file: answer(await request("GET", "/uploads/kpi-sweep/made-up-file.txt", { client })),
			missing: answer(await request("GET", "/uploads/kpi-sweep/no-such-file.txt", { client })),
			rateCon: answer(await request("GET", "/uploads/rate-cons/made-up-ratecon.pdf", { client })),
		};
	}
	return out;
}

async function viewerReads(clients) {
	const out = {};
	for (const [key, client] of clients) out[key] = answer(await request("GET", "/api/kpis/viewer", { client }));
	return out;
}

const countRuns = (db) => db.prepare("SELECT COUNT(*) AS n FROM kpi_runs").get().n;
const auditOf = (db, actions, sinceId) => db.prepare(`SELECT id, user_id, username, role, action, entity, entity_id, details FROM audit_trail WHERE id > ? AND action IN (${actions.map(() => "?").join(", ")}) ORDER BY id`).all(sinceId, ...actions);
const maxAudit = (db) => db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id;
const userRow = (db, id) => db.prepare("SELECT id, username, role, driver_name, email, company_name, must_change_password, password_hash, last_login_at, disabled_at FROM users WHERE id = ?").get(id) || null;

async function main({ io, db, ids, account, stack }) {
	const sa = await signIn(account("sa"));
	const disp = await signIn(account("disp"));
	const drv = await signIn(account("drv"));
	const inv = await signIn(account("inv"));
	const kv = await signIn(account("kv"));
	const kvu = await signIn(account("kvu"));
	const kvf = await signIn(account("kvf"));
	result.logins = Object.fromEntries([sa, disp, drv, inv, kv, kvu, kvf].map((c) => [c.account, c.login.status]));

	// §1 pass 1, with the business tables and the sheet watched.
	const before = fingerprints(db);
	const writesBefore = sheetWrites();
	const mailsBefore = mails.length;
	result.pass1 = await passOne(stack, kv);
	result.uploads = await uploads([["kv", kv], ["anon", null]]);
	result.tables = { before, after: fingerprints(db), sheetWrites: sheetWrites() - writesBefore, mails: mails.length - mailsBefore };
	result.viewerOtherMethods = {};
	for (const m of ["POST", "PUT", "PATCH", "DELETE"]) result.viewerOtherMethods[m] = answer(await request(m, "/api/kpis/viewer", { client: kv }));
	// The control: a Dispatcher through the same harness, on reads that pass its guards.
	result.control = {};
	for (const url of setup.controlReads) result.control[url] = answer(await request("GET", url, { client: disp }));

	// §2 sockets: each client registers with its own name.
	result.sockets = await sockets(io, [["kv", account("kv").username, kv], ["disp", "dispatch", disp]],
		["dispatch", "super-admin", "investor", `user:${account("kv").username.toLowerCase()}`, `driver:${account("drv").driverName.toLowerCase()}`]);

	// §3 the page's read.
	const runsBefore = countRuns(db);
	const callsBefore = sheetCalls.length;
	result.viewer = await viewerReads([["kv", kv], ["sa", sa], ["kvu", kvu], ["kvf", kvf], ["disp", disp], ["drv", drv], ["inv", inv], ["anon", null]]);
	result.viewerRead = { runsAdded: countRuns(db) - runsBefore, sheetCalls: sheetCalls.length - callsBefore };
	const keep = db.prepare("SELECT * FROM kpi_metric_approvals").all();
	db.prepare("UPDATE kpi_metric_approvals SET approved = 0").run();
	result.viewerNone = answer(await request("GET", "/api/kpis/viewer", { client: kv }));
	db.prepare("DELETE FROM kpi_metric_approvals").run();
	const put = db.prepare("INSERT INTO kpi_metric_approvals (metric_key, approved, definition_version, settings_hash, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?)");
	for (const r of keep) put.run(r.metric_key, r.approved, r.definition_version, r.settings_hash, r.approved_by, r.approved_at);

	// §1 pass 2: the four session-changing routes, each on its own fresh KPI Viewer session.
	const pass2Before = { tables: fingerprints(db), audit: maxAudit(db), kvf: userRow(db, ids.kvf), kv: userRow(db, ids.kv) };
	const setupKv = await signIn(account("kv"));
	const setupBody = { username: "setup_sample", password: "Made-Up-Setup-2026!" };
	result.pass2 = {
		setupKv: answer(await request("POST", "/api/auth/setup", { client: setupKv, body: setupBody })),
		setupAnon: answer(await request("POST", "/api/auth/setup", { body: setupBody })),
	};
	const relog = await signIn(account("kv"));
	result.pass2.login = answer(await request("POST", "/api/auth/login", { client: relog, body: { username: account("kv").username, password: account("kv").password } }));
	result.pass2.sessionAfterLogin = answer(await request("GET", "/api/auth/session", { client: relog }));
	result.pass2.forcedBefore = answer(await request("GET", "/api/kpis/viewer", { client: kvf }));
	result.pass2.change = answer(await request("POST", "/api/auth/change-password", { client: kvf, body: { currentPassword: account("kvf").password, newPassword: setup.kvfNewPassword } }));
	result.pass2.forcedAfter = answer(await request("GET", "/api/kpis/viewer", { client: kvf }));
	const out = await signIn(account("kv"));
	result.pass2.logout = answer(await request("POST", "/api/auth/logout", { client: out }));
	result.pass2.sessionAfterLogout = answer(await request("GET", "/api/auth/session", { client: out }));
	result.pass2.tablesBefore = pass2Before.tables;
	result.pass2.tablesAfter = fingerprints(db);
	result.pass2.audit = auditOf(db, ["login", "logout", "login_refused", "change_password", "create_user", "update_user", "create_user_blocked", "update_user_blocked"], pass2Before.audit)
		.map((r) => ({ user_id: r.user_id, role: r.role, action: r.action }));
	result.pass2.kvfBefore = pass2Before.kvf;
	result.pass2.kvfAfter = userRow(db, ids.kvf);
	result.pass2.kvBefore = pass2Before.kv;
	result.pass2.kvAfter = userRow(db, ids.kv);
	result.pass2.signInNetwork = db.prepare("SELECT user_id, COUNT(*) AS n FROM sign_in_network GROUP BY user_id ORDER BY user_id").all();

	// §4 Add User and Edit User, as two Super Admins (the password budget is per acting admin).
	const sa2 = await signIn(account("sa2"));
	const mark = maxAudit(db);
	const count = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	const users = {};
	users.list = answer(await request("GET", "/api/users", { client: sa }));
	const create = (body) => request("POST", "/api/users", { client: sa, body });
	const n0 = count();
	users.withDriver = answer(await create({ ...setup.newKv, driverName: "Made Up Driver" }));
	users.withCompany = answer(await create({ ...setup.newKv, companyName: "Made-Up Carrier LLC" }));
	users.weak = answer(await create({ ...setup.newKv, password: "short" }));
	users.own = answer(await create({ ...setup.newKv, password: account("sa").password }));
	users.countAfterRefusals = count() - n0;
	users.created = answer(await create(setup.newKv));
	const newRow = db.prepare("SELECT id, username, role, driver_name, company_name, email, must_change_password FROM users WHERE username = ?").get(setup.newKv.username) || null;
	users.newRow = newRow;
	users.newDirectoryRows = tableNames(db).includes("drivers_directory")
		? db.prepare("SELECT COUNT(*) AS n FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?) OR LOWER(driver_name) = LOWER(?)").get(setup.newKv.username, setup.newKv.fullName || "").n : null;
	users.newLogin = newRow ? (await signIn({ key: "new", username: setup.newKv.username, password: setup.newKv.password })).login : null;
	const edit = (id, body, client = sa2) => request("PUT", `/api/users/${id}`, { client, body });
	users.editEmail = answer(await edit(ids.kvu, { role: "KPI Viewer", email: "kay.changed@example.test", fullName: "Kay Changed" }));
	users.kvuAfterEmail = userRow(db, ids.kvu);
	users.editPassword = answer(await edit(ids.kvu, { role: "KPI Viewer", password: setup.kvuNewPassword }));
	users.kvuAfterPassword = userRow(db, ids.kvu);
	users.kvuSessionAfterPassword = answer(await request("GET", "/api/auth/session", { client: kvu }));
	const kvuBefore = userRow(db, ids.kvu);
	// One refusal of each kind per acting admin: a second within a minute folds into the first's audit row.
	users.toDispatcher = answer(await edit(ids.kvu, { role: "Dispatcher" }));
	users.fromDispatcher = answer(await edit(ids.disp2, { role: "KPI Viewer" }, sa));
	users.driverName = answer(await edit(ids.kvu, { driverName: "Made Up Driver" }));
	users.companyName = answer(await edit(ids.kvu, { companyName: "Made-Up Carrier LLC" }, sa));
	users.blankNames = answer(await edit(ids.kvu, { driverName: "", companyName: "", email: "kay.changed@example.test" }));
	users.kvuAfterRefusals = userRow(db, ids.kvu);
	users.kvuBeforeRefusals = kvuBefore;
	users.disp2After = userRow(db, ids.disp2);
	users.listAfter = answer(await request("GET", "/api/users", { client: sa }));
	if (newRow) {
		const newClient = await signIn({ key: "new2", username: setup.newKv.username, password: setup.newKv.password });
		users.disable = answer(await request("POST", `/api/users/${newRow.id}/disable`, { client: sa, body: { reason: "made-up reason" } }));
		users.disabledSession = answer(await request("GET", "/api/auth/session", { client: newClient }));
		users.disabledRow = userRow(db, newRow.id);
		users.remove = answer(await request("DELETE", `/api/users/${newRow.id}`, { client: sa }));
		users.removedRow = userRow(db, newRow.id);
	}
	users.audit = auditOf(db, ["create_user", "create_user_blocked", "update_user", "update_user_blocked", "disable_user", "delete_user"], mark)
		.map((r) => ({ action: r.action, entity_id: r.entity_id, details: r.details }));
	result.users = users;
}

// Flag off, with KPI Viewer accounts already in the table (off again).
async function off({ io, db, ids, account, stack }) {
	const sa = await signIn(account("sa"));
	const kv = await signIn(account("kv"));
	const disp = await signIn(account("disp"));
	result.logins = { sa: sa.login.status, kv: kv.login.status };
	result.pass1 = await passOne(stack, kv);
	result.viewer = await viewerReads([["kv", kv], ["sa", sa]]);
	result.sockets = await sockets(io, [["kv", account("kv").username, kv], ["disp", "dispatch", disp]], ["dispatch", "super-admin", "investor", `user:${account("kv").username.toLowerCase()}`]);
	const mark = maxAudit(db);
	const n0 = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	result.create = answer(await request("POST", "/api/users", { client: sa, body: setup.newKv }));
	result.createdRows = db.prepare("SELECT COUNT(*) AS n FROM users").get().n - n0;
	result.list = answer(await request("GET", "/api/users", { client: sa }));
	result.createDispatcher = answer(await request("POST", "/api/users", { client: sa, body: setup.newDispatcher }));
	result.dispatcherRow = db.prepare("SELECT role, must_change_password FROM users WHERE username = ?").get(setup.newDispatcher.username) || null;
	result.audit = auditOf(db, ["create_user", "create_user_blocked"], mark).map((r) => ({ action: r.action, entity_id: r.entity_id, details: r.details }));
}

// Flag on, the CHECK not widened.
async function unmigrated({ db, account }) {
	const sa = await signIn(account("sa"));
	result.viewer = await viewerReads([["sa", sa]]);
	const mark = maxAudit(db);
	const n0 = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	result.create = answer(await request("POST", "/api/users", { client: sa, body: setup.newKv }));
	result.createdRows = db.prepare("SELECT COUNT(*) AS n FROM users").get().n - n0;
	result.list = answer(await request("GET", "/api/users", { client: sa }));
	result.audit = auditOf(db, ["create_user", "create_user_blocked"], mark).map((r) => ({ action: r.action, entity_id: r.entity_id, details: r.details }));
	try {
		db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kay_direct_sample', 'made-up-hash', 'KPI Viewer')").run();
		result.directInsert = "ok";
	} catch (e) {
		result.directInsert = e.message;
	}
}

// Flag on and migrated; KPI_VIEWER_IDS as the runner set it.
async function list({ account }) {
	const sa = await signIn(account("sa"));
	const kv = await signIn(account("kv"));
	result.viewer = await viewerReads([["kv", kv], ["sa", sa]]);
}

async function sweepOnly({ account, stack }) {
	const kv = await signIn(account("kv"));
	result.pass1 = await passOne(stack, kv);
}

async function usersOff({ db, account }) {
	const sa = await signIn(account("sa"));
	const n0 = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	result.create = answer(await request("POST", "/api/users", { client: sa, body: setup.newKv }));
	result.createdRows = db.prepare("SELECT COUNT(*) AS n FROM users").get().n - n0;
}

async function viewerOnly({ account }) {
	const sa = await signIn(account("sa"));
	const kv = await signIn(account("kv"));
	result.viewer = await viewerReads([["kv", kv], ["sa", sa]]);
	result.viewerOtherMethods = {};
	for (const m of ["POST", "PUT", "PATCH", "DELETE"]) result.viewerOtherMethods[m] = answer(await request(m, "/api/kpis/viewer", { client: kv }));
}

(setup.mode === "prepare" ? prepare() : world()).catch((e) => { result.error = String((e && e.stack) || e); finish(1); });
