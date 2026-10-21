// The shared world for the trip-work-days and ledger day-once runners (B12:
// section 4 and 4b of the plan). It runs the three pay paths and the invoice
// routes exactly as the server runs them: lifted out of server.js with
// scripts/lib/server-lift.js, on one in-memory SQLite built from every
// CREATE TABLE in server.js, with one Job Tracking sheet the test can change
// between calls and a clock it can move.
//
//   weekly invoice   generateInvoiceHandler() (POST /api/invoices/generate)
//   investor view    GET /api/investor
//   payout ledger    computeInvestorMonthlyEarnings() (payouts and Financials)
//   invoice routes   PUT adjust, PUT revert, DELETE, PUT restore, POST manual
//   dry run          GET /api/admin/work-days/dry-run, when server.js has it
//   boot checks      every column-0 `warn...FromClosedMonth();` call in server.js,
//                    run once at start as the server runs it
//
// Every fixture is made up: invented drivers, loads, trucks, places and times.
// Pure: no server, no app.db, no network. Temporary files live under
// os.tmpdir() and are removed by cleanup().
//
// The runners that use it were written before their fixes, against the plan;
// scripts/run-unit-tests.js runs every scripts/test-*.js (top level only), so
// each joins `npm run check` when its fix lands beside it.
// scripts/test-ledger-day-once.js (the ledger day-once rule) is the first.
// findRoot() finds the repo from wherever this file sits.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

// The repo root, found from here, so the runners work from any folder under it.
function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift"));

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }
let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }

// ── the per-case harness ──────────────────────────────────────────────────────
// One line per case: "ok" or "FAIL", then the failing checks. A case that throws
// (a module the fix adds is missing, a route answers 500) fails alone; the runner
// goes on to the next case and ends with one summary line.
function createRunner(title) {
	let passed = 0;
	let failed = 0;
	console.log(title);
	async function test(name, fn) {
		const checks = [];
		const eq = (label, actual, expected) => {
			const a = JSON.stringify(actual);
			const e = JSON.stringify(expected);
			checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}` });
		};
		const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail });
		try {
			await fn({ eq, ok });
		} catch (err) {
			checks.push({ ok: false, label: "threw", detail: String((err && err.message) || err).split("\n")[0] });
		}
		const good = checks.length > 0 && checks.every((c) => c.ok);
		if (good) passed++; else failed++;
		console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
		if (!good) {
			for (const c of checks.filter((x) => !x.ok).slice(0, 4)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
			if (!checks.length) console.log("        - no check ran");
		}
	}
	function finish() {
		cleanup();
		console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
		process.exit(failed ? 1 : 0);
	}
	return { test, finish };
}

// A module the fix adds to lib/, or a clear error naming it.
function requireLib(name) {
	const file = path.join(ROOT, "lib", `${name}.js`);
	if (!fs.existsSync(file)) throw new Error(`lib/${name}.js does not exist yet (the fix adds it)`);
	return require(file);
}

// ── days and stamps ───────────────────────────────────────────────────────────
const DAY_MS = 24 * 3600 * 1000;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
// A sheet date: "2026-09-30" -> "9/30/2026", with an optional time "8:00".
const md = (day, time = "") => {
	if (!day) return "";
	const [y, m, d] = day.split("-").map(Number);
	return `${m}/${d}/${y}${time ? ` ${time}` : ""}`;
};
// US Eastern wall time "YYYY-MM-DD HH:MM" as load_status_history stores it: UTC,
// "YYYY-MM-DD HH:MM:SS", no Z. EDT (UTC-4) until 2026-11-01 02:00, then EST.
function et(wall) {
	const [day, hm] = wall.split(" ");
	const [h, m] = hm.split(":").map(Number);
	const dstEnd = Date.parse("2026-11-01T06:00:00Z");
	let ms = Date.parse(`${day}T00:00:00Z`) + (h + 4) * 3600000 + m * 60000;
	if (ms >= dstEnd) ms += 3600000;
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
const stampMs = (s) => Date.parse(String(s).trim().replace(" ", "T") + "Z");
// An Eastern wall time as epoch ms.
const etMs = (wall) => stampMs(et(wall));

// ── the schema: every CREATE TABLE in server.js ────────────────────────────────
function closeParen(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "'") { i = src.indexOf("'", i + 1); if (i === -1) return -1; continue; }
		if (c === "-" && src[i + 1] === "-") { i = src.indexOf("\n", i); if (i === -1) return -1; continue; }
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return -1;
}
function schemaStatements() {
	const out = [];
	const trucks = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!trucks) die("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	out.push(`CREATE TABLE trucks (${trucks[1]}\n)`);
	out.push("CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))");
	const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
	let m;
	while ((m = re.exec(SRC))) {
		const open = m.index + m[0].length - 1;
		const close = closeParen(SRC, open);
		if (close === -1) continue;
		const body = SRC.slice(open, close);
		if (body.includes("${")) continue;
		out.push(`CREATE TABLE IF NOT EXISTS ${m[1]} ${body}`);
	}
	for (const a of SRC.match(/ALTER TABLE \w+ ADD COLUMN [^"`]*/g) || []) out.push(a.trim());
	// The days-billed table's own indexes, when the fix declares them apart from
	// the table.
	for (const ix of SRC.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON invoice_paid_days[^"`]*/g) || []) out.push(ix.trim());
	return out;
}
const SCHEMA = schemaStatements();
function buildSchema(db) {
	for (const sql of SCHEMA) {
		try { db.exec(sql); } catch { /* a table this world does not use, or a column already added */ }
	}
	for (const t of ["users", "investors", "trucks", "drivers_directory", "invoices", "load_status_history", "period_locks", "excluded_driver_days", "app_settings", "pay_rate_history", "financials_ledger_items"]) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) die(`table ${t} did not build from server.js's DDL`);
	}
}
// A fresh in-memory database holding that schema. Running the ~200 statements
// costs ~100 ms and runners start dozens of worlds, so they run once, into a
// template, and every world opens its own copy of the template's bytes (~0.1 ms).
let SCHEMA_IMAGE = null;
function schemaDb() {
	if (!SCHEMA_IMAGE) {
		const template = new Database(":memory:");
		buildSchema(template);
		SCHEMA_IMAGE = template.serialize();
		template.close();
	}
	return new Database(SCHEMA_IMAGE);
}
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// ── the lifted server ─────────────────────────────────────────────────────────
const LINES = SRC.split("\n");
function routeHead(method, p, optional = false) {
	const heads = LINES.filter((l) => l.startsWith(`app.${method}(${JSON.stringify(p)},`));
	if (heads.length > 1 || (!heads.length && !optional)) die(`expected one registration of ${method.toUpperCase()} ${p} in server.js, found ${heads.length}`);
	return heads[0] || null;
}
const ROUTES = [
	["get", "/api/investor"],
	["put", "/api/invoices/:id/adjust"],
	["put", "/api/invoices/:id/revert"],
	["delete", "/api/invoices/:id"],
	["put", "/api/invoices/:id/restore"],
	["post", "/api/invoices/manual"],
];
const DRY_RUN_ROUTE = ["get", "/api/admin/work-days/dry-run"];
const BOOT_CHECKS = [...SRC.matchAll(/^(warn\w*FromClosedMonth)\(\);$/gm)].map((x) => x[1]);
// Lifted by name: server-lift's closure walk misses a call that starts the line
// after a `//` comment ending in "." (it reads the call as a property access), as
// rerenderInvoicePdfFromStoredData()'s call to assertInvoiceFileStillOwn() is.
const NAMED_ROOTS = ["assertInvoiceFileStillOwn"].filter((n) => SRC.includes(`\nfunction ${n}(`));
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "logAudit", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs",
	"DATA_DIR", "fetch", "io", "sendEmail"];
let LIFTED = null;
function lifted() {
	if (LIFTED) return LIFTED;
	const dry = routeHead(...DRY_RUN_ROUTE, true);
	const heads = [...ROUTES.map(([m, p]) => routeHead(m, p)), ...(dry ? [dry] : [])];
	const roots = ["generateInvoiceHandler", "computeInvestorMonthlyEarnings", "getCarrierDBFromSQLite", "getInvestorDriverSet", "parseSheet",
		"deduplicateLoads", "findCol", "normalizeDriverName", ...NAMED_ROOTS, ...BOOT_CHECKS];
	LIFTED = closure(SRC, { roots, routes: heads, provided: PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] });
	LIFTED.hasDryRunRoute = !!dry;
	return LIFTED;
}

// ── the fixture ───────────────────────────────────────────────────────────────
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
// One Job Tracking row. Days are "YYYY-MM-DD" (blank for an empty cell);
// `pickup` / `dropoff` take an optional "H:MM" after a space.
function loadRow({ id, driver, pickup = "", dropoff = "", assigned = "", done = "", status = "Delivered", truck = "", owner = "5", payment = "$2,000.00" }) {
	const cell = (v) => { if (!v) return ""; const [d, t] = v.split(" "); return md(d, t || ""); };
	const r = Object.fromEntries(HEADERS.map((h) => [h, ""]));
	Object.assign(r, {
		"Load ID": id, Driver: driver, "Pickup Appointment": cell(pickup), "Drop-off Appointment": cell(dropoff), "Job Status": status,
		"  Payment  ": payment, "Assigned Date": md(assigned), "Status Update Date": md(done), "Completion Date": md(done), Truck: truck, "Owner ID": owner,
	});
	return r;
}
const sheetValues = (rows) => [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] ?? ""))];

// Places: every load's pickup and a city, both in the Central band.
const PICKUP = { lat: 34.0004549, lng: -95.109078 };
const DALLAS = { lat: 32.7767, lng: -96.797 };
// One truck's ELD feed, its odometer running on from day to day: `drive` adds a
// fix every 15 minutes from `from` to `to` local (Central daylight) hours,
// `miles` in total; `visit` puts the noon fix at that point.
function feed(startOdo) {
	let odo = startOdo;
	const pings = [];
	const cdt = (day, h) => Date.parse(`${day}T00:00:00Z`) + (h + 5) * 3600000;
	const api = {
		pings,
		drive(day, { miles = 0, from = 8, to = 18, at = DALLAS, visit = null } = {}) {
			const steps = (to - from) * 4;
			for (let i = 0; i <= steps; i++) {
				const ms = cdt(day, from) + i * 15 * 60000;
				const here = visit && ms === cdt(day, 12) ? visit : { lat: at.lat, lng: at.lng + i * 0.0005 };
				pings.push({ ms, ...here, odo: odo + (miles * i) / steps, speed: miles ? 10 : 0 });
			}
			odo += miles;
			return api;
		},
		park(day) { return api.drive(day, { from: 12, to: 13 }); },
	};
	return api;
}

const DEFAULT_NOW = Date.parse("2026-10-09T17:00:00Z");
const tempDirs = [];
function tempDir() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "b12-work-days-"));
	tempDirs.push(d);
	return d;
}
function cleanup() {
	for (const d of tempDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
}
// Also on an exit that never reaches finish() (a crash outside every case).
process.on("exit", cleanup);

// One server start. Options:
//   env        what the server reads at boot (flags)
//   rows       Job Tracking rows (loadRow()); world.rows stays live and editable
//   drivers    [{ name, payDaily = 260, payType = "fixed", payPct = 0, carrier = "Acme Carrier" }]
//   trucks     [{ unit, driver, owner = 5, vid = null, payDaily = 0 }]
//   status     [[loadId, status, source, changedAt (stored UTC text), actor]]
//   pings      { vid: [{ ms, lat, lng, odo, speed }] }
//   coords     { loadId: { lat, lng } } pickup coordinates
//   overrides  [{ driver, day, action }]
//   locks      ["YYYY-MM"] closed months
//   payRates   [{ subject, key, rate, from }] pay_rate_history rows
//   now        epoch ms (world.clock.ms moves it)
function startWorld(opts = {}) {
	const { env = {}, rows = [], drivers = [], trucks = null, status = [], pings = {}, coords = {}, overrides = [], locks = [], payRates = [], now = DEFAULT_NOW } = opts;
	const L = lifted();
	const db = schemaDb();
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily, pay_percentage) VALUES (?, ?, ?, ?, ?)");
	for (const d of drivers) dir.run(d.name, d.carrier ?? "Acme Carrier", d.payType || "fixed", d.payDaily ?? 260, d.payPct || 0);
	const truckRows = trucks || drivers.map((d, i) => ({ unit: `T${i + 1}`, driver: d.name, vid: null }));
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, routemate_vehicle_id, driver_pay_daily)
		VALUES (?, ?, ?, 'Active', '2026-08-01', '2026-08-01 00:00:00', ?, ?, ?)`);
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-08-01T17:00:00.000Z')");
	truckRows.forEach((t, i) => {
		truck.run(i + 1, t.unit, t.owner ?? 5, t.driver, t.vid || null, t.payDaily || 0);
		assign.run(i + 1, t.driver);
	});
	const co = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, 29.4, -98.4)");
	for (const [lid, p] of Object.entries(coords)) co.run(lid, p.lat, p.lng);
	const tl = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, ?, ?, '')");
	for (const [vid, list] of Object.entries(pings)) for (const p of list) tl.run(vid, p.lat, p.lng, p.speed, p.odo, p.ms);
	const world = {
		db, L, rows: rows.map((r) => ({ ...r })), clock: { ms: now }, routes: {}, warnings: [], rendered: [],
		renderHook: null, fsFail: { rename: false },
	};
	world.addStatus = (list) => {
		const st = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, '', ?, ?, ?, ?)");
		for (const [lid, s, source, at, actor] of list) st.run(String(lid).toLowerCase().replace(/^#/, ""), s, source || "manual", actor || "", at);
	};
	world.addOverrides = (list) => {
		const ins = db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by, action) VALUES (?, ?, 'test', 'super_admin', ?)");
		for (const o of list) ins.run(String(o.driver).trim().toLowerCase().replace(/\s+/g, " "), o.day, o.action || "remove");
	};
	world.lock = (periods) => {
		const ins = db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-08T05:00:00.000Z', 'test')");
		for (const p of periods) ins.run(p);
	};
	world.setRow = (id, patch) => {
		const r = world.rows.find((x) => x["Load ID"] === id);
		if (!r) throw new Error(`no row ${id}`);
		Object.assign(r, patch);
	};
	world.addStatus(status);
	world.addOverrides(overrides);
	world.lock(locks);
	const rate = db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES (?, ?, ?, ?, 'change')");
	for (const r of payRates) rate.run(r.subject, r.key, r.rate, r.from);

	const clock = world.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const quiet = { log() {}, info() {}, error() {}, warn: (...a) => world.warnings.push(a.join(" ")) };
	const register = (method) => (p, ...h) => { world.routes[`${method} ${p}`] = h[h.length - 1]; };
	const fsStub = {
		existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "",
		writeFileSync: () => {},
		renameSync: () => { if (world.fsFail.rename) throw new Error("rename failed (test)"); },
		unlinkSync: () => {},
	};
	const deps = {
		db,
		require: createRequire(path.join(ROOT, "server.js")),
		console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => ROOT, pid: 4242 },
		__dirname: ROOT,
		Date: FixedDate,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass,
		requireAuth: pass(),
		refuseCrossOrigin: pass(),
		notifyChange: () => {},
		logAudit: () => {},
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheetValues(world.rows) } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: async (templateName, data) => {
			if (world.renderHook) await world.renderHook(templateName, data);
			world.rendered.push({ templateName, data: JSON.parse(JSON.stringify(data)) });
			return Buffer.from("%PDF-stub");
		},
		fs: fsStub,
		DATA_DIR: "/nonexistent-b12",
		fetch: () => { throw new Error("no network in a test"); },
		io: null,
		sendEmail: async () => undefined,
	};
	const body = [
		'"use strict";',
		L.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		...BOOT_CHECKS.map((f) => `${f}();`),
		"return { generateInvoiceHandler, computeInvestorMonthlyEarnings, getCarrierDBFromSQLite, getInvestorDriverSet, findCol, normalizeDriverName };",
	].join("\n");
	world.api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => sheetValues(world.rows));
	return world;
}

// ── calling the paths ─────────────────────────────────────────────────────────
async function call(handler, req) {
	const out = { status: 200, body: null };
	const res = {
		status(c) { out.status = c; return res; },
		json(b) { out.body = b; return res; },
		send(b) { out.body = b; return res; },
		set() { return res; }, setHeader() {}, type() { return res; },
	};
	await handler(req, res);
	return out;
}
const ADMIN = { session: { user: { id: 1, role: "Super Admin", username: "super_admin" } }, headers: {}, query: {}, params: {} };
async function route(world, key, { params = {}, query = {}, body = {} } = {}) {
	const h = world.routes[key];
	if (!h) throw new Error(`${key} is not registered in server.js`);
	return call(h, { ...ADMIN, params, query, body });
}

// The weekly invoice for `driver`, week ending `weekEnd` (a Friday). Returns the
// response and the render data the PDF was drawn from (null when nothing rendered).
async function generate(world, driver, weekEnd) {
	const before = world.rendered.length;
	const r = await call(world.api.generateInvoiceHandler, { ...ADMIN, body: { driver, weekEnd } });
	const render = world.rendered.length > before ? world.rendered[world.rendered.length - 1].data : null;
	return { status: r.status, body: r.body, invoice: r.body && r.body.invoice, data: render, warnings: (r.body && r.body.warnings) || [] };
}
const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
// The Sat-Fri grid's paid days: [{ day, loads, total }].
function gridDays(data, weekEnd) {
	if (!data || !data.days) return [];
	const start = addDays(weekEnd, -6);
	return GRID.map((n, i) => ({ n, day: addDays(start, i), e: data.days[n] || {} }))
		.filter((x) => x.e.completed)
		.map((x) => ({ day: x.day, loads: String(x.e.loadBol || "").split(", ").filter(Boolean), total: x.e.total }));
}
// The "Earlier days" section: [{ day, loads, total }] ([] when absent).
function earlierDays(data) {
	const list = (data && Array.isArray(data.earlierDays)) ? data.earlierDays : [];
	return list.map((e) => ({ day: e.day, loads: String(e.loadBol || "").split(", ").filter(Boolean), total: e.total }));
}
const dayList = (entries) => entries.map((e) => e.day).sort();

// The investor view (as investor 5): [{ month, day, loads, driver }]. A month's
// paid days are its dayBreakdown (days a load pays) and its addedDays (admin
// add rows, which name no load): together the days activeDays counts.
async function investorDays(world, ownerId = 5) {
	const r = await call(world.routes["GET /api/investor"], { session: { user: { id: ownerId, role: "Investor", username: `inv${ownerId}` } }, query: {}, params: {}, headers: {} });
	if (r.status !== 200) throw new Error(`GET /api/investor: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
	const seen = new Set();
	const find = (o) => {
		if (!o || typeof o !== "object" || seen.has(o)) return null;
		seen.add(o);
		if (Array.isArray(o.monthlyEarnings)) return o.monthlyEarnings;
		for (const v of Object.values(o)) { const hit = find(v); if (hit) return hit; }
		return null;
	};
	const months = find(r.body) || [];
	const out = [];
	for (const m of months) {
		for (const [driver, det] of Object.entries(m.driverDetails || {})) {
			const listed = new Set();
			for (const d of det.dayBreakdown || []) { listed.add(d.date); out.push({ month: m.month, day: d.date, loads: d.loadIds, driver, source: det.source }); }
			for (const a of det.addedDays || []) if (!listed.has(a.date)) out.push({ month: m.month, day: a.date, loads: [], driver, source: det.source, added: true });
		}
	}
	return { days: out, body: r.body, months };
}
// The payout ledger (investor 5's scope): { items, months }.
async function ledger(world, ownerId = 5) {
	const { api, db } = world;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, ?) ORDER BY owner_id").all(ownerId).forEach((r) => { config[r.key] = r.value; });
	const out = await api.computeInvestorMonthlyEarnings({
		user: { id: ownerId, role: "Investor", username: `inv${ownerId}` }, isSuperAdmin: false,
		investorDriverSet: api.getInvestorDriverSet(ownerId, carrierDB.data, driverCol, carrierCol), investorOwnerId: ownerId, config,
	});
	const pay = out.items.filter((i) => i.kind === "driver_pay");
	return { ...out, pay };
}
// "month day" pairs a driver is paid (ledger items or investor-view rows), sorted.
const monthDays = (list, driverNorm) => [...new Set(list.filter((x) => !driverNorm || String(x.driver).toLowerCase() === driverNorm).map((x) => `${x.month} ${x.day}`))].sort();
const onlyDays = (list, days) => list.filter((x) => days.includes(x.split(" ").pop()));

// ── scripts ───────────────────────────────────────────────────────────────────
// A copy of the world's database in a fresh temporary folder (the copy rule of
// scripts/lib/ledger-world.js dbScope()), with the sheet as a saved values.get
// and the flags as an env file. Returns the paths.
function saveCopy(world, env = {}) {
	const d = tempDir();
	const dbPath = path.join(d, "app.db");
	fs.writeFileSync(dbPath, world.db.serialize());
	const values = path.join(d, "job-tracking.json");
	fs.writeFileSync(values, JSON.stringify({ values: sheetValues(world.rows) }));
	const envFile = path.join(d, "flags.env");
	fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
	return { dir: d, db: dbPath, values, envFile };
}
function runScript(rel, args) {
	const file = path.join(ROOT, rel);
	if (!fs.existsSync(file)) return { code: null, stdout: "", stderr: `${rel} does not exist yet (the fix adds it)`, json: null, missing: true };
	const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "UTC" }, timeout: 45000 });
	let json = null;
	try { json = JSON.parse(r.stdout); } catch { json = null; }
	return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", json };
}
// Every table's rows, hashed: a read-only run leaves each hash as it was.
function tableHashes(db) {
	const out = {};
	for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
		out[name] = crypto.createHash("sha256").update(JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())).digest("hex").slice(0, 16);
	}
	return out;
}
const fileHash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// Every object nested anywhere in a JSON value.
function objects(v, out = []) {
	if (Array.isArray(v)) { for (const x of v) objects(x, out); return out; }
	if (v && typeof v === "object") { out.push(v); for (const x of Object.values(v)) objects(x, out); }
	return out;
}
// The scalar values of an object (one level), as strings.
const scalars = (o) => Object.values(o).filter((x) => x === null || typeof x !== "object").map((x) => String(x));
// True when `x` names the same instant as the stored stamp `stored`: epoch ms,
// an ISO string, or the stored text itself.
function sameInstant(x, stored) {
	const want = stampMs(stored);
	if (typeof x === "number") return x === want;
	if (x instanceof Date) return x.getTime() === want;
	if (typeof x === "string") return x.trim() === stored || Date.parse(x) === want || stampMs(x) === want;
	return false;
}
// True when a flags value (array, Set or object of booleans) carries `name`.
function hasFlag(flags, name) {
	if (!flags) return false;
	if (Array.isArray(flags)) return flags.includes(name);
	if (flags instanceof Set) return flags.has(name);
	if (typeof flags === "object") return !!flags[name];
	return false;
}
function anyFlag(flags) {
	if (!flags) return false;
	if (Array.isArray(flags)) return flags.length > 0;
	if (flags instanceof Set) return flags.size > 0;
	return Object.values(flags).some(Boolean);
}

module.exports = {
	ROOT, SRC, Database, createRunner, requireLib, addDays, daysFrom, md, et, etMs, stampMs, buildSchema, schemaDb, hasTable,
	startWorld, loadRow, sheetValues, HEADERS, feed, PICKUP, DALLAS, DEFAULT_NOW, call, route, generate,
	gridDays, earlierDays, dayList, investorDays, ledger, monthDays, onlyDays, saveCopy, runScript, tableHashes, fileHash,
	objects, scalars, sameInstant, hasFlag, anyFlag, tempDir, cleanup, lifted,
};
