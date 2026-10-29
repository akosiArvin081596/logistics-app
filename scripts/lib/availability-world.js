// The world the driver-availability runners (R11) share. It runs the shipped
// routes exactly as the server runs them: lifted out of server.js with
// scripts/lib/server-lift.js (every top-level declaration they reach comes
// along), registered on a real Express app with the server's own requireRole
// and requireAuth, on one in-memory SQLite built from every CREATE TABLE in
// server.js, and driven over HTTP on 127.0.0.1.
//
//   availability   the six availability routes (listed in ROUTES)
//   directory      GET /api/drivers-directory, DELETE /api/drivers-directory/:id
//   responses      GET /api/dashboard, GET /api/trucks
//   assign         POST /api/dispatch, POST /api/dispatch/reassign,
//                  PUT /api/data/:rowIndex, PUT /api/load/:loadId, POST /api/data
//   driver app     GET /api/driver/:driverName (the driver app's payload)
//   sweep          sweepEldFeedSilence() and eldFeedHealthReport()
//
// What stands in for the server's process: a header-driven session
// (x-test-user), a fake Google Sheet holding one Job Tracking tab (reads and
// writes in A1 notation, as the API answers them), a clock the test moves
// (world.clock.ms; "today" is the business day of that instant), and recording
// stubs for mail, sockets and notifyChange. The flag DRIVER_AVAILABILITY_ENABLED
// is read from the world's own process.env, as the server reads it at boot, and
// so are DRIVER_TIME_OFF_SCREEN_ENABLED (pass it in `env`) and
// DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED (R11b; `loadsWarning: true`).
// The cached Job Tracking read (getJobTrackingCached()) is the world's own:
// world.jt.reads counts the reads, world.jt.fail makes each read throw (the
// sheet unreadable), and world.jt.during, a function, runs once inside the next
// read (a change another session makes while a route awaits the sheet).
// A route server.js does not have yet is simply not registered, so a request to
// it answers like any unknown path.
//
// Every fixture is made up: invented drivers, trucks, loads and devices.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createRequire } = require("module");
const express = require("express");
const { closure } = require("./server-lift");
const { schemaDb, Database } = require("./work-days-world");

const ROOT = path.join(__dirname, "..", "..");
const SRC = require("./server-source").serverSource();
const LINES = SRC.split("\n");

const ROUTES = {
	availabilityList: ["get", "/api/drivers-directory/:id/availability"],
	availabilityCreate: ["post", "/api/drivers-directory/:id/availability"],
	availabilityEdit: ["put", "/api/driver-availability/:id"],
	availabilityCancel: ["post", "/api/driver-availability/:id/cancel"],
	availabilityMine: ["get", "/api/driver/me/availability"],
	availabilityAll: ["get", "/api/driver-availability"],
	directory: ["get", "/api/drivers-directory"],
	directoryDelete: ["delete", "/api/drivers-directory/:id"],
	dashboard: ["get", "/api/dashboard"],
	trucks: ["get", "/api/trucks"],
	dispatch: ["post", "/api/dispatch"],
	reassign: ["post", "/api/dispatch/reassign"],
	dataPut: ["put", "/api/data/:rowIndex"],
	loadPut: ["put", "/api/load/:loadId"],
	dataPost: ["post", "/api/data"],
	driverPage: ["get", "/api/driver/:driverName"],
};
const AVAILABILITY_ROUTES = ["availabilityList", "availabilityCreate", "availabilityEdit", "availabilityCancel", "availabilityMine", "availabilityAll"];
const ASSIGN_ROUTES = ["dispatch", "reassign", "dataPut", "loadPut", "dataPost"];

// The registration line of METHOD PATH in server.js, or null when it has none.
function routeHead(method, p) {
	const heads = LINES.filter((l) => l.startsWith(`app.${method}(${JSON.stringify(p)},`));
	if (heads.length > 1) throw new Error(`expected at most one registration of ${method.toUpperCase()} ${p} in server.js, found ${heads.length}`);
	return heads[0] || null;
}

const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "notifyChange", "getJobTrackingCached", "getSheets",
	"SPREADSHEET_ID", "io", "sendEmail", "fs", "DATA_DIR", "fetch", "REPLICA", "driverInstructions", "autoInvoice"];
const DENIED = ["server", "transporter", "getDrive", "KEY_FILE", "auth", "sheetsClient"];
const ROOTS = ["sweepEldFeedSilence", "eldFeedHealthReport", "appTodayKey", "normalizeDriverName"];
// Lifted by name: server-lift's closure walk misses a statement that starts the
// line after a `//` comment ending in "." (it reads it as a property access),
// as jtCacheInvalidate()'s `_jtInflight = null;` and PUT /api/data/:rowIndex's
// `restoreUntouchedCells(...)` do.
const NAMED_ROOTS = ["_jtInflight", "restoreUntouchedCells"].filter((n) => SRC.includes(`\nlet ${n} =`) || SRC.includes(`\nfunction ${n}(`));

const LIFT_CACHE = new Map();
function lifted(keys) {
	const id = keys.slice().sort().join(",");
	if (!LIFT_CACHE.has(id)) {
		const heads = keys.map((k) => routeHead(...ROUTES[k])).filter(Boolean);
		const found = keys.filter((k) => routeHead(...ROUTES[k]));
		LIFT_CACHE.set(id, { ...closure(SRC, { roots: [...ROOTS, ...NAMED_ROOTS], routes: heads, provided: PROVIDED, denied: DENIED }), found });
	}
	return LIFT_CACHE.get(id);
}

// The production Job Tracking header row (26 columns).
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h.trim(), i]));
// One Job Tracking row as the sheet stores it.
function jtRow({ id, driver = "", pickup = "", dropoff = "", status = "Unassigned", truck = "", owner = "", assigned = "" }) {
	const r = HEADERS.map(() => "");
	r[COL["Contract ID"]] = `C-${id}`;
	r[COL["Load ID"]] = String(id);
	r[COL["Details"]] = "Dry van";
	r[COL["Driver"]] = driver;
	r[COL["Pickup Appointment"]] = pickup;
	r[COL["Drop-off Appointment"]] = dropoff;
	r[COL["Job Status"]] = status;
	r[COL["Payment"]] = "$1,500.00";
	r[COL["Assigned Date"]] = assigned;
	r[COL["Truck"]] = truck;
	r[COL["Owner ID"]] = owner;
	return r;
}

const USERS = {
	sa: { id: 1, role: "Super Admin", username: "super_admin", driverName: "" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t", driverName: "" },
	driver: { id: 10, role: "Driver", username: "drv_hollis", driverName: "Hollis Renner" },
	otherDriver: { id: 11, role: "Driver", username: "drv_soren", driverName: "Soren King" },
	inv: { id: 5, role: "Investor", username: "inv5", driverName: "" },
};
// Directory ids of the seeded drivers.
const DIR = { hollis: 1, soren: 2, tamsin: 3 };
const TRUCK = { t91: 11, t33: 12 };
const VID = { t91: "vid-91-dark", t33: "vid-33-live" };

// 2026-10-15 12:00 PM EDT: "today" is 2026-10-15 on the business clock.
const DEFAULT_NOW = Date.parse("2026-10-15T16:00:00Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;

// A fake Sheets client over one Job Tracking tab. Reads serve displayed values
// with trailing empty cells dropped; writes land as sent, or every write throws
// while control.failWrites is set (a Sheets write that failed).
function fakeSheet(initialRows) {
	const tabs = { "Job Tracking": initialRows.map((r) => r.slice()) };
	const log = { reads: [], writes: [] };
	const control = { failWrites: false };
	const refuseWrite = () => { if (control.failWrites) throw new Error("fake sheet: write failed"); };
	const parse = (range) => {
		const s = String(range);
		const bang = s.lastIndexOf("!");
		let tab = bang < 0 ? s : s.slice(0, bang);
		const a1 = bang < 0 ? "" : s.slice(bang + 1);
		if (/^'.*'$/.test(tab)) tab = tab.slice(1, -1).replace(/''/g, "'");
		if (!tabs[tab]) throw new Error(`fake sheet: no tab ${tab}`);
		return { tab, a1 };
	};
	const colIdx = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const shown = (r) => {
		const o = (r || []).map((v) => (v == null ? "" : String(v)));
		while (o.length && o[o.length - 1] === "") o.pop();
		return o;
	};
	const read = (range) => {
		const { tab, a1 } = parse(range);
		const rows = tabs[tab];
		if (!a1) return rows.map(shown);
		let m = /^(\d+):(\d+)$/.exec(a1);
		if (m) return rows.slice(Number(m[1]) - 1, Number(m[2])).map(shown);
		m = /^([A-Z]+):([A-Z]+)$/.exec(a1);
		if (m) {
			const i = colIdx(m[1]);
			const out = rows.map((r) => { const v = (r || [])[i]; return v == null || v === "" ? [] : [String(v)]; });
			while (out.length && !out[out.length - 1].length) out.pop();
			return out;
		}
		m = /^([A-Z]+)(\d+)$/.exec(a1);
		if (m) { const v = (rows[Number(m[2]) - 1] || [])[colIdx(m[1])]; return v == null || v === "" ? [] : [[String(v)]]; }
		throw new Error(`fake sheet: unreadable range ${range}`);
	};
	const write = (range, values) => {
		const { tab, a1 } = parse(range);
		const m = /^([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/.exec(a1);
		if (!m) throw new Error(`fake sheet: unwritable range ${range}`);
		const r0 = Number(m[2]) - 1;
		const c0 = colIdx(m[1]);
		values.forEach((vals, dr) => {
			const row = tabs[tab][r0 + dr] || (tabs[tab][r0 + dr] = []);
			vals.forEach((v, dc) => {
				while (row.length <= c0 + dc) row.push("");
				row[c0 + dc] = v == null ? "" : String(v);
			});
		});
		log.writes.push({ range, values });
	};
	const api = {
		spreadsheets: {
			get: async () => ({ data: { sheets: Object.keys(tabs).map((title, i) => ({ properties: { title, sheetId: i } })) } }),
			values: {
				get: async ({ range }) => { log.reads.push(range); return { data: { values: read(range) } }; },
				batchGet: async ({ ranges }) => { log.reads.push(...ranges); return { data: { valueRanges: ranges.map((r) => ({ range: r, values: read(r) })) } }; },
				batchUpdate: async ({ requestBody }) => {
					refuseWrite();
					let cells = 0;
					for (const d of requestBody.data) { write(d.range, d.values); cells += d.values.flat().length; }
					return { data: { totalUpdatedCells: cells } };
				},
				update: async ({ range, requestBody }) => { refuseWrite(); write(range, requestBody.values); return { data: {} }; },
				append: async ({ range, requestBody }) => {
					refuseWrite();
					const { tab } = parse(range);
					for (const r of requestBody.values) tabs[tab].push(r.map((v) => (v == null ? "" : String(v))));
					const n = tabs[tab].length;
					log.writes.push({ range, values: requestBody.values, append: true });
					return { data: { updates: { updatedRange: `'${tab}'!A${n}:Z${n}` } } };
				},
			},
		},
	};
	return { api, tabs, log, control };
}

function seed(db, clockMs) {
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, company_name) VALUES (?, ?, 'x', ?, ?, ?)");
	for (const u of Object.values(USERS)) user.run(u.id, u.username, u.role, u.driverName, u.role === "Investor" ? "Acme Carrier" : "");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, carrier_name, status, pay_daily) VALUES (?, ?, 'Acme Carrier', 'active', 300)");
	dir.run(DIR.hollis, "Hollis Renner");
	dir.run(DIR.soren, "Soren King");
	dir.run(DIR.tamsin, "Tamsin Vale");
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, routemate_vehicle_id)
		VALUES (?, ?, 5, 'Active', '2026-08-01', '2026-08-01 00:00:00', ?, ?)`);
	truck.run(TRUCK.t91, "LogisX-#91", "Hollis Renner", VID.t91);
	truck.run(TRUCK.t33, "LogisX-#33", "Soren King", VID.t33);
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-08-12T23:17:00.000Z')");
	assign.run(TRUCK.t91, "Hollis Renner");
	assign.run(TRUCK.t33, "Soren King");
	// #91 parked and dark for three days; #33 reporting every half hour.
	const tel = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason, source) VALUES (?, 29.7, -95.4, 0, 1000, ?, '', 'routemate')");
	for (let i = 0; i < 20; i++) tel.run(VID.t91, clockMs - 3 * DAY - i * 30 * 60000);
	for (let i = 0; i < 40; i++) tel.run(VID.t33, clockMs - 5 * 60000 - i * 30 * 60000);
}

// The fixture sheet: a future load for Hollis (Oct 20-22), one for Soren, an
// unassigned one, and a delivered past load.
function defaultRows() {
	return [
		HEADERS.slice(),
		jtRow({ id: "7001", driver: "Hollis Renner", pickup: "10/20/2026 08:00", dropoff: "10/22/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" }),
		jtRow({ id: "7002", driver: "Soren King", pickup: "10/16/2026 09:00", dropoff: "10/17/2026 15:00", status: "Dispatched", truck: "LogisX-#33", owner: "5" }),
		jtRow({ id: "7003", pickup: "10/18/2026 10:00", dropoff: "10/19/2026 12:00", status: "Unassigned" }),
		jtRow({ id: "7004", driver: "Hollis Renner", pickup: "10/1/2026", dropoff: "10/3/2026", status: "Delivered", truck: "LogisX-#91", owner: "5" }),
	];
}

// R11b's fixture: defaultRows() plus more of Hollis's loads, each a case the
// time-off warning decides ("today" 2026-10-15):
//   7501  Oct 26-27, Dispatched, #91        warns when a save covers it
//   7502  Oct 28, Cancelled                 never warns
//   7503  Oct 29, Dispatched                the runner soft-deletes it (deleted_loads): never warns
//   7504  "TBD" / "TBD"                     no readable day: skipped
//   7505  Nov 3-4, "  hollis   RENNER "     his name in other spacing and case: warns
//   7506  Oct 12-14, Delivered              ended yesterday: never warns
function hisLoadsRows() {
	return [
		...defaultRows(),
		jtRow({ id: "7501", driver: "Hollis Renner", pickup: "10/26/2026 08:00", dropoff: "10/27/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" }),
		jtRow({ id: "7502", driver: "Hollis Renner", pickup: "10/28/2026 08:00", dropoff: "10/28/2026 17:00", status: "Cancelled", truck: "LogisX-#91", owner: "5" }),
		jtRow({ id: "7503", driver: "Hollis Renner", pickup: "10/29/2026 08:00", dropoff: "10/29/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" }),
		jtRow({ id: "7504", driver: "Hollis Renner", pickup: "TBD", dropoff: "TBD", status: "Dispatched" }),
		jtRow({ id: "7505", driver: "  hollis   RENNER ", pickup: "11/3/2026 08:00", dropoff: "11/4/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" }),
		jtRow({ id: "7506", driver: "Hollis Renner", pickup: "10/12/2026 08:00", dropoff: "10/14/2026 17:00", status: "Delivered", truck: "LogisX-#91", owner: "5" }),
	];
}

const servers = new Set();
const agent = new http.Agent({ keepAlive: false });

// Options:
//   flag          true: DRIVER_AVAILABILITY_ENABLED=true in the world's env; false: unset
//   loadsWarning  true: DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED=true (R11b); false: unset
//   routes        ROUTES keys to lift (default all)
//   rows          the Job Tracking tab, header row first (default defaultRows())
//   now           epoch ms of the world's clock
//   env           anything else the server reads at boot
async function startWorld({ flag = true, loadsWarning = false, routes = Object.keys(ROUTES), rows = defaultRows(), now = DEFAULT_NOW, env = {} } = {}) {
	const L = lifted(routes);
	const db = schemaDb();
	const clock = { ms: now };
	seed(db, now);
	const sheet = fakeSheet(rows);
	const jt = { reads: 0, fail: false, during: null };
	const world = { db, clock, sheet, jt, emails: [], changes: [], logs: [], mailFails: false, found: L.found };

	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const quiet = { log() {}, info() {}, warn: (...a) => world.logs.push(a.join(" ")), error: (...a) => world.logs.push(a.join(" ")) };
	const procEnv = {
		...(flag ? { DRIVER_AVAILABILITY_ENABLED: "true" } : {}),
		...(loadsWarning ? { DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED: "true" } : {}),
		GMAIL_USER: "ops@example.invalid", GMAIL_APP_PASSWORD: "app-password-under-test", ADMIN_NOTIFY_EMAIL: "ops@example.invalid",
		...env,
	};
	const deps = {
		db,
		require: createRequire(path.join(ROOT, "server.js")),
		console: quiet,
		process: { env: procEnv, argv: [], cwd: () => ROOT, pid: 4242, on() {}, nextTick: process.nextTick, hrtime: process.hrtime, memoryUsage: process.memoryUsage },
		__dirname: ROOT,
		Date: FixedDate,
		app,
		notifyChange: (d) => world.changes.push(d),
		// The rate-con driver-instructions runtime (its own runner covers it): inert here.
		driverInstructions: { annotateDashboardRows() {}, annotateDriverLoads() {}, afterDropzone() { return null; } },
		// The automatic invoice drafts (scripts/test-auto-invoice-wiring.js covers them): off here.
		autoInvoice: { mode: "off", annotateCompletedRows: ({ rows }) => rows },
		getJobTrackingCached: async () => {
			jt.reads++;
			if (typeof jt.during === "function") {
				const change = jt.during;
				jt.during = null;
				change();
			}
			if (jt.fail) throw new Error("fake sheet: Job Tracking unreadable");
			const all = sheet.tabs["Job Tracking"];
			const headers = all[0].slice();
			return { headers, data: all.slice(1).map((r, i) => ({ _rowIndex: i + 2, ...Object.fromEntries(headers.map((h, j) => [h, r[j] == null ? "" : r[j]])) })) };
		},
		getSheets: async () => sheet.api,
		SPREADSHEET_ID: "availability-test-sheet",
		io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }), emit() {} },
		sendEmail: async (to, subject, html) => { world.emails.push({ to, subject, html }); return !world.mailFails; },
		fs,
		DATA_DIR: path.join(os.tmpdir(), "r11-availability-no-uploads"),
		fetch: () => { throw new Error("no network in a test"); },
		REPLICA: null,
	};
	const body = ['"use strict";', L.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	world.api = new Function(...Object.keys(deps), body)(...Object.values(deps));

	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.add(server);
	const port = server.address().port;
	// One request. `user` is a USERS entry (or null, signed out); `csrf: false`
	// leaves out X-Requested-With.
	world.call = (method, url, { user = USERS.sa, body: payload, csrf = true } = {}) => new Promise((resolve, reject) => {
		const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
		const req = http.request({
			host: "127.0.0.1", port, method, path: url, agent,
			headers: {
				...(user ? { "x-test-user": JSON.stringify(user) } : {}),
				...(csrf ? { "X-Requested-With": "XMLHttpRequest" } : {}),
				...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
			},
		}, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let json = null;
				try { json = JSON.parse(text); } catch { json = null; }
				resolve({ status: res.statusCode, body: json, text });
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
	world.sweep = () => world.api.sweepEldFeedSilence();
	world.today = () => world.api.appTodayKey();
	world.audits = (action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
	world.close = () => new Promise((r) => { servers.delete(server); server.close(() => r()); });
	return world;
}

async function closeAll() {
	await Promise.all([...servers].map((s) => new Promise((r) => s.close(() => r()))));
	servers.clear();
}

// A small reporter: ok / eq, sections, and a summary that exits 1 on any failure.
function createRunner(title) {
	let passed = 0;
	const failures = [];
	const ok = (name, cond, detail) => {
		if (cond) { passed++; return true; }
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
		return false;
	};
	const eq = (name, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		return ok(name, a === e, `expected ${e}, got ${a}`);
	};
	const section = (t) => console.log(`\n── ${t}`);
	const finish = async () => {
		await closeAll();
		console.log(`\n${title}: ${passed} passed, ${failures.length} failed`);
		if (failures.length) {
			for (const f of failures) console.log(`  ✗ ${f}`);
			process.exit(1);
		}
	};
	const guard = async (name, fn) => {
		try { await fn(); } catch (err) { ok(name, false, `threw: ${err && err.message}`); }
	};
	return { ok, eq, section, finish, guard };
}

module.exports = {
	ROOT, SRC, ROUTES, AVAILABILITY_ROUTES, ASSIGN_ROUTES, HEADERS, COL, USERS, DIR, TRUCK, VID, DEFAULT_NOW, HOUR, DAY,
	routeHead, jtRow, defaultRows, hisLoadsRows, startWorld, closeAll, createRunner, fakeSheet,
};
