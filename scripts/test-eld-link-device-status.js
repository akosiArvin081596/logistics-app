#!/usr/bin/env node
/**
 * Unit assertions for the ELD device status the Trucks page, the ELD picker,
 * the link route and the feed alert serve — and the LogisX-#356 incident they
 * exist for: on 2026-09-28 the truck was linked to a Linxup device silent since
 * 2026-09-15 (a bare mirror row, no vehicle number), while its real ELD —
 * Routemate vehicle "356" — reported, unlinked, beside it.
 *
 *   §1 eldLatestCleanFixByVehicle(): the newest clean row's provider fields and
 *      the newest fix, dropped rows ignored, and per-id index seeks only.
 *   §2 eldDeviceStatus() / eldLastFixPhrase().
 *   §3 GET /api/routemate/vehicles/unlinked: reporting devices first, each
 *      (and `suggested`) carrying provider / last_fix_ms / silent.
 *   §4 POST /api/trucks/:truckId/link-routemate: 409 ELD_DEVICE_SILENT unless
 *      confirmSilent === true, on both paths, ahead of the period guard.
 *   §5 GET /api/trucks: EldLastFixMs / EldProvider / EldSilent from ONE lookup.
 *   §6 The feed alert names the device and joins the two halves of a wrong link.
 *   §7 /api/locations/latest: one Load ID normalization; the real provider.
 *   §8 GET /api/dashboard: the Fleet card's truck is the assigned one.
 *   §9 GET /api/driver/position: the real provider, by the same rule as §7.
 *
 * ⚠️ THE CODE UNDER TEST IS EXTRACTED FROM server.js SOURCE, not copied here;
 * every extraction asserts its definition is found EXACTLY ONCE. Only I/O
 * outside SQLite (sheet, mail, sockets, audit), the period guard and §9's
 * driver-to-truck lookup are stubbed.
 * The tables are in memory, with the shipped indexes lifted from server.js.
 *
 * Run: node scripts/test-eld-link-device-status.js
 * Against another copy: SERVER_JS=/tmp/mutant.js node scripts/test-eld-link-device-status.js
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const eldFeedHealth = require("../lib/eld-feed-health");

const src = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  FAIL: ${label}`);
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${label} (got ${a}, want ${e})`);
}

function extractFunction(name, prefix = "function") {
	const hits = [...src.matchAll(new RegExp(`^${prefix} ${name}\\s*\\(`, "gm"))];
	if (hits.length !== 1) throw new Error(`expected exactly 1 definition of ${prefix} ${name}(), found ${hits.length}`);
	const end = src.indexOf("\n}\n", hits[0].index);
	return src.slice(hits[0].index, end + 3);
}
function extractConst(name) {
	const hits = [...src.matchAll(new RegExp(`^const ${name} = .*$`, "gm"))];
	if (hits.length !== 1) throw new Error(`expected exactly 1 const ${name}, found ${hits.length}`);
	return hits[0][0];
}
// `route` is a path, or the array of paths a route is mounted on.
function routeBody(verb, route) {
	const paths = Array.isArray(route) ? `[${route.map((r) => `"${r}"`).join(", ")}]` : `"${route}"`;
	const needle = `app.${verb}(${paths}`;
	const start = src.indexOf(needle);
	if (start === -1 || src.indexOf(needle, start + 1) !== -1) throw new Error(`expected exactly 1 ${needle}`);
	return src.slice(start, src.indexOf("\n});\n", start) + 5);
}
function shippedSql(re, label) {
	const m = src.match(re);
	if (!m || m.length !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${m ? m.length : 0}`);
	return m[0];
}

// ---------------------------------------------------------------- clock + data
const NOW = Date.UTC(2026, 9, 1, 17, 0, 0);
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW])); }
	static now() { return NOW; }
}
const HOUR = 60 * 60 * 1000;
const DEAD_LINXUP = "18000507597";
const DEAD_LINXUP_FIX = Date.UTC(2026, 8, 15, 22, 30, 0);
const RM_356 = "_PxLRDo4PKkgRsvudsnJTw";
const RM_33 = "2Y_aT-AYiR1Yek5krywLVQ";
const NEVER = "never-reported-device";

const IDX = [
	/CREATE INDEX IF NOT EXISTS idx_rm_tel_vid_date ON routemate_telemetry\([^)]*\)/g,
	/CREATE INDEX IF NOT EXISTS idx_rm_tel_clean ON routemate_telemetry\([^)]*\)/g,
	/CREATE INDEX IF NOT EXISTS idx_rm_tel_odo_walk\s+ON routemate_telemetry\([^)]*\)\s+WHERE dropped_reason = ''/g,
].map((re, i) => shippedSql(re, `routemate_telemetry index #${i + 1}`));
const LEDGER_DDL = shippedSql(/CREATE TABLE IF NOT EXISTS eld_feed_alerts \([\s\S]*?\n\t\)/g, "eld_feed_alerts DDL");
const SERVER_STATE_DDL = shippedSql(/CREATE TABLE IF NOT EXISTS server_state \([\s\S]*?\n\t\)/g, "server_state DDL");

// The incident, as of 2026-10-01. `link356` is the device LogisX-#356 holds.
function freshDb({ link356 = "", unit356 = "LogisX-#356", rm356FixMs = NOW - 10 * 60 * 1000, extraTrucks = [] } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE routemate_vehicles (
			id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL UNIQUE,
			vehicle_id TEXT DEFAULT '', vin TEXT DEFAULT '', make TEXT DEFAULT '', model TEXT DEFAULT '',
			year INTEGER DEFAULT 0, fuel_type TEXT DEFAULT '', license_num TEXT DEFAULT '', eld_id TEXT DEFAULT '',
			gps_ids TEXT DEFAULT '[]', state TEXT DEFAULT '', active INTEGER DEFAULT 1, raw_json TEXT DEFAULT '',
			last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE routemate_telemetry (
			id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL,
			latitude REAL, longitude REAL, speed REAL DEFAULT 0, bearing TEXT DEFAULT '',
			odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0, fuel_pct INTEGER,
			geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0,
			fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP, dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
		CREATE TABLE trucks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, vin TEXT DEFAULT '',
			status TEXT DEFAULT 'Active', routemate_vehicle_id TEXT DEFAULT '', retired_at TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	`);
	for (const sql of [...IDX, LEDGER_DDL, SERVER_STATE_DDL]) db.exec(sql);
	// Inserted dark-first, so neither row order nor the old ORDER BY vin can
	// pass for the picker's order by accident.
	const rv = db.prepare("INSERT INTO routemate_vehicles (routemate_vehicle_id, vehicle_id, vin, make, model, year) VALUES (?,?,?,?,?,?)");
	rv.run(NEVER, "", "VIN-NEVER", "", "", 0);
	rv.run(DEAD_LINXUP, "", "", "", "", 0);
	rv.run(RM_33, "33", "1HSDJAPR0NH000033", "FREIGHTLINER", "CASCADIA", 2021);
	rv.run(RM_356, "356", "1HSDJAPR0NH000356", "INTERNATIONAL", "LT625", 2022);
	const tel = db.prepare(`INSERT INTO routemate_telemetry
		(routemate_vehicle_id, latitude, longitude, engine_hours, geocoded_location, location_date_ms, dropped_reason, source)
		VALUES (?,?,?,?,?,?,?,?)`);
	// Linxup fingerprint: no engine hours, no place name, written before `source`.
	for (let h = 3; h >= 0; h--) tel.run(DEAD_LINXUP, 29.7, -95.3, 0, "", DEAD_LINXUP_FIX - h * HOUR, "", "");
	for (let h = 3; h >= 0; h--) tel.run(RM_356, 29.8, -95.4, 5000 + h, "Houston, TX", rm356FixMs - h * HOUR, "", "routemate");
	for (let h = 3; h >= 0; h--) tel.run(RM_33, 30.1, -94.1, 7000 + h, "Beaumont, TX", NOW - 30 * 60 * 1000 - h * HOUR, "", "routemate");
	const t = db.prepare("INSERT INTO trucks (id, unit_number, vin, routemate_vehicle_id, retired_at) VALUES (?,?,?,?,?)");
	t.run(13, unit356, "VIN-NEVER", link356, "");
	t.run(2, "LogisX-#33", "1HSDJAPR0NH000033", RM_33, "");
	t.run(5, "INV-24-A", "", "", "");
	for (const x of extraTrucks) t.run(x.id, x.unit, "", x.vid || "", x.retiredAt || "");
	return db;
}

// One Function scope per world: the lifted code closes over these names only.
function build(db, pieces, extra = {}) {
	const deps = {
		db, eldFeedHealth, Date: FixedDate,
		ELD_STALE_HOURS: 24, ELD_STALE_ALERT_ENABLED: true, ELD_STALE_ALERT_MAX_PER_DAY: 25,
		console: { log: () => {}, warn: () => {}, error: (...a) => (extra.errors || []).push(a.join(" ")) },
		...extra.deps,
	};
	const body = `${pieces.join("\n")}\nreturn { ${(extra.expose || []).join(", ")} };`;
	return new Function(...Object.keys(deps), body)(...Object.values(deps));
}
const FIX_FNS = ["eldLatestCleanFixByVehicle", "eldDeviceStatus", "eldLastFixPhrase"].map((n) => extractFunction(n));

function mockRes() {
	return {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
}
function routeWorld(db, verb, route, deps = {}) {
	const routes = {};
	const app = { [verb]: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	build(db, [...FIX_FNS, extractFunction("unitNumberToken"), extractFunction("suggestRoutemateVehicleForTruck"), routeBody(verb, route)], {
		deps: { app, requireRole: () => null, ...deps },
	});
	return async (req) => { const res = mockRes(); await routes[route]({ query: {}, params: {}, body: {}, ...req }, res); return res; };
}

(async () => {
	// ------------------------------------------------------------------ §1
	console.log("§1 eldLatestCleanFixByVehicle()");
	{
		const db = freshDb();
		// An out-of-order delivery: the newest ROW carries an older fix.
		db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, engine_hours, geocoded_location, location_date_ms, source) VALUES (?,?,?,?,?,?,?)")
			.run(RM_33, 1, 1, 0, "", NOW - 48 * HOUR, "linxup");
		// A dropped row with the newest timestamp of all must not count.
		db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?)")
			.run(DEAD_LINXUP, 0, 0, NOW, "invalid_coords", "linxup");
		const { eldLatestCleanFixByVehicle } = build(db, FIX_FNS, { expose: ["eldLatestCleanFixByVehicle"] });
		const out = eldLatestCleanFixByVehicle([RM_33, DEAD_LINXUP, RM_33, "", "no-such-device"]);
		eq(Object.keys(out).sort(), [DEAD_LINXUP, RM_33].sort(), "§1.1 one entry per known id; blanks and unknown ids absent");
		eq(out[RM_33].last_fix_ms, NOW - 30 * 60 * 1000, "§1.2 last_fix_ms is the NEWEST fix, not the newest row's");
		eq([out[RM_33].source, out[RM_33].location_date_ms], ["linxup", NOW - 48 * HOUR], "§1.3 provider fields come from the newest ROW");
		eq(out[DEAD_LINXUP].last_fix_ms, DEAD_LINXUP_FIX, "§1.4 a dropped row is not a fix");
		const untouched = build({ prepare: () => { throw new Error("touched"); } }, FIX_FNS, { expose: ["eldLatestCleanFixByVehicle"] });
		eq(untouched.eldLatestCleanFixByVehicle([]), {}, "§1.5 empty input answers {} without a query");
		// Index seeks only: no access to routemate_telemetry is a table SCAN.
		let sql = "";
		build({ prepare: (s) => { sql = s; return { all: () => [] }; } }, FIX_FNS, { expose: ["eldLatestCleanFixByVehicle"] })
			.eldLatestCleanFixByVehicle([RM_33, DEAD_LINXUP]);
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(RM_33, DEAD_LINXUP).map((r) => r.detail);
		ok(plan.some((d) => /idx_rm_tel_odo_walk/.test(d)) && plan.some((d) => /idx_rm_tel_clean/.test(d)),
			`§1.6 both MAXes seek a clean-row index (${plan.join(" | ")})`);
		ok(!plan.some((d) => /^SCAN routemate_telemetry/.test(d)), "§1.7 routemate_telemetry is never scanned");
		ok(!/GROUP BY/i.test(sql), "§1.8 no GROUP BY walk over every clean row");
	}

	// ------------------------------------------------------------------ §2
	console.log("§2 eldDeviceStatus() / eldLastFixPhrase()");
	{
		const { eldDeviceStatus, eldLastFixPhrase } = build(null, FIX_FNS, { expose: ["eldDeviceStatus", "eldLastFixPhrase"] });
		eq(eldDeviceStatus(undefined, NOW), { provider: "", last_fix_ms: null, silent: true }, "§2.1 no telemetry: never reported, silent");
		eq(eldDeviceStatus({ source: "", engine_hours: 0, geocoded_location: "", last_fix_ms: DEAD_LINXUP_FIX }, NOW),
			{ provider: "linxup", last_fix_ms: DEAD_LINXUP_FIX, silent: true }, "§2.2 a Linxup fingerprint row, 16 days dark");
		eq(eldDeviceStatus({ source: "routemate", last_fix_ms: NOW - 23 * HOUR }, NOW).silent, false, "§2.3 23 h: live");
		eq(eldDeviceStatus({ source: "routemate", last_fix_ms: NOW - 24 * HOUR }, NOW).silent, true, "§2.4 24 h: silent (the sweep's boundary)");
		eq(eldLastFixPhrase(DEAD_LINXUP_FIX, NOW), "last reported a GPS fix on 2026-09-15 UTC, 15 days ago", "§2.5 days");
		eq(eldLastFixPhrase(NOW - 25 * HOUR, NOW), "last reported a GPS fix on 2026-09-30 UTC, 1 day ago", "§2.6 one day");
		eq(eldLastFixPhrase(NOW - 5 * HOUR, NOW), "last reported a GPS fix on 2026-10-01 UTC, 5 h ago", "§2.7 hours");
		eq(eldLastFixPhrase(NOW - 60 * 1000, NOW), "last reported a GPS fix on 2026-10-01 UTC, less than an hour ago", "§2.8 minutes");
		eq(eldLastFixPhrase(null, NOW), "has never reported a GPS fix", "§2.9 never");
	}

	// ------------------------------------------------------------------ §3
	console.log("§3 GET /api/routemate/vehicles/unlinked");
	{
		const get = routeWorld(freshDb(), "get", "/api/routemate/vehicles/unlinked");
		const res = await get({ query: { truckId: "13" } });
		const ids = res.body.vehicles.map((v) => v.routemate_vehicle_id);
		eq(ids, [RM_356, DEAD_LINXUP, NEVER], "§3.1 the reporting device first; the dark ones after it");
		const byId = Object.fromEntries(res.body.vehicles.map((v) => [v.routemate_vehicle_id, v]));
		eq([byId[RM_356].provider, byId[RM_356].silent, byId[RM_356].last_fix_ms], ["routemate", false, NOW - 10 * 60 * 1000], "§3.2 vehicle 356: routemate, live");
		eq([byId[DEAD_LINXUP].provider, byId[DEAD_LINXUP].silent, byId[DEAD_LINXUP].last_fix_ms], ["linxup", true, DEAD_LINXUP_FIX], "§3.3 the dead device: linxup, silent");
		eq([byId[NEVER].provider, byId[NEVER].silent, byId[NEVER].last_fix_ms], ["", true, null], "§3.4 never reported");
		eq([res.body.suggested.routemate_vehicle_id, res.body.suggested.provider, res.body.suggested.silent, res.body.suggested.last_fix_ms],
			[RM_356, "routemate", false, NOW - 10 * 60 * 1000], "§3.5 `suggested` carries the same status");
		eq(Object.keys(await get({}).then((r) => r.body)), ["vehicles"], "§3.6 no truckId, no `suggested`");
	}

	// ------------------------------------------------------------------ §4
	console.log("§4 POST /api/trucks/:truckId/link-routemate");
	async function link(body, { link356 = "", blockers = [] } = {}) {
		const db = freshDb({ link356 });
		const audits = [];
		let guardCalls = 0;
		const post = routeWorld(db, "post", "/api/trucks/:truckId/link-routemate", {
			eldLinkPreflight: async (id) => ({ truck: db.prepare("SELECT * FROM trucks WHERE id = ?").get(id), eldLinkMonths: [] }),
			truckEditLockBlockers: () => { guardCalls++; return { blockers, unreadable: false }; },
			periodBlockedResponse: (req, res, msg) => res.status(409).json({ code: "PERIOD_LOCKED", error: msg }),
			periodLockUnreadableResponse: (req, res) => res.status(503).json({ code: "PERIOD_LOCK_UNREADABLE" }),
			auditText: (s) => String(s || ""),
			logAudit: (req, action, entity, id, subject) => audits.push({ action, subject }),
		});
		const res = await post({ params: { truckId: "13" }, body });
		return { res, audits, guardCalls, linked: db.prepare("SELECT routemate_vehicle_id FROM trucks WHERE id = 13").get().routemate_vehicle_id };
	}
	{
		const a = await link({ routemateVehicleId: DEAD_LINXUP });
		eq(a.res.statusCode, 409, "§4.1 a silent device is refused without confirmSilent");
		eq([a.res.body.code, a.res.body.routemateVehicleId, a.res.body.provider, a.res.body.lastFixMs],
			["ELD_DEVICE_SILENT", DEAD_LINXUP, "linxup", DEAD_LINXUP_FIX], "§4.2 the 409 body");
		eq(a.res.body.error, "ELD device 18000507597 last reported a GPS fix on 2026-09-15 UTC, 15 days ago."
			+ " Linking it leaves LogisX-#356 with no live position. Confirm to link it anyway.", "§4.3 the message names the device and its last fix");
		eq([a.linked, a.guardCalls, a.audits.length], ["", 0, 0], "§4.4 nothing written, the period guard not reached");

		const b = await link({ routemateVehicleId: DEAD_LINXUP, confirmSilent: true });
		eq([b.res.statusCode, b.linked, b.guardCalls], [200, DEAD_LINXUP, 1], "§4.5 confirmSilent: true links it, through the period guard");
		ok(/confirmed silent device: last reported a GPS fix on 2026-09-15 UTC/.test(b.audits[0] && b.audits[0].subject), "§4.6 the audit line records the confirmation");

		const c = await link({ routemateVehicleId: DEAD_LINXUP, confirmSilent: "true" });
		eq([c.res.statusCode, c.linked], [409, ""], "§4.7 only the boolean true confirms");

		const d = await link({ routemateVehicleId: RM_356 });
		eq([d.res.statusCode, d.linked], [200, RM_356], "§4.8 a reporting device links with no question");
		ok(!/confirmed silent/.test(d.audits[0].subject), "§4.9 ...and its audit line says nothing of silence");

		const e = await link({ routemateVehicleId: DEAD_LINXUP }, { link356: DEAD_LINXUP });
		eq(e.res.statusCode, 200, "§4.10 re-saving the device the truck already holds is not asked about");

		const f = await link({ auto: true });
		eq([f.res.statusCode, f.res.body.code, f.res.body.lastFixMs, f.res.body.provider], [409, "ELD_DEVICE_SILENT", null, ""], "§4.11 the VIN auto-match is asked about too");
		ok(/^ELD device never-reported-device has never reported a GPS fix\./.test(f.res.body.error), "§4.12 ...in never-reported words");

		const g = await link({ routemateVehicleId: DEAD_LINXUP }, { blockers: [{ month: "2026-08" }] });
		eq([g.res.statusCode, g.res.body.code], [409, "ELD_DEVICE_SILENT"], "§4.13 the silence question comes before a period refusal");
		const h = await link({ routemateVehicleId: DEAD_LINXUP, confirmSilent: true }, { blockers: [{ month: "2026-08" }] });
		eq([h.res.statusCode, h.res.body.code, h.linked], [409, "PERIOD_LOCKED", ""], "§4.14 a confirmed link still meets the period guard");

		const body = routeBody("post", "/api/trucks/:truckId/link-routemate").replace(/^\s*\/\/.*$/gm, "");
		eq((body.match(/\bawait\b/g) || []).length, 1, "§4.15 still exactly one await, above every check");
		ok(body.indexOf("ELD_DEVICE_SILENT") < body.indexOf("truckEditLockBlockers(")
			&& body.indexOf("truckEditLockBlockers(") < body.indexOf("UPDATE trucks SET routemate_vehicle_id"),
		"§4.16 silence check, then period guard, then write");
	}

	// ------------------------------------------------------------------ §5
	console.log("§5 GET /api/trucks");
	{
		async function trucksWith(db, errors = []) {
			const lookups = { fix: 0, number: 0 };
			const counting = {
				prepare: (s) => {
					if (/WITH ids\(vid\)/.test(s)) lookups.fix++;
					if (/FROM routemate_vehicles/.test(s)) lookups.number++;
					return db.prepare(s);
				},
			};
			const routes = {};
			const app = { get: (p, ...h) => { routes[p] = h[h.length - 1]; } };
			build(counting, [...FIX_FNS, routeBody("get", "/api/trucks")], {
				errors,
				deps: {
					app, requireRole: () => null,
					resolvePreviewUser: () => ({ isPreview: false }),
					getJobTrackingCached: async () => ({ headers: [], data: [] }),
					findCol: () => null, excludeDroppedLoads: () => [],
					normalizeDriverName: (s) => String(s || "").trim().toLowerCase(), driverNameForTotals: (s) => s,
				},
			});
			const res = mockRes();
			await routes["/api/trucks"]({ session: { user: { id: 1, role: "Super Admin" } }, query: {} }, res);
			return { trucks: Object.fromEntries(res.body.trucks.map((t) => [t.UnitNumber, t])), lookups };
		}
		const { trucks, lookups } = await trucksWith(freshDb({ link356: DEAD_LINXUP }));
		const eld = (t) => [t.EldLastFixMs, t.EldProvider, t.EldSilent, t.EldVehicleNumber];
		eq(eld(trucks["LogisX-#356"]), [DEAD_LINXUP_FIX, "linxup", true, ""], "§5.1 #356 on the dead device: silent, linxup, no vehicle number");
		eq(eld(trucks["LogisX-#33"]), [NOW - 30 * 60 * 1000, "routemate", false, "33"], "§5.2 #33: live, routemate, vehicle 33");
		eq(eld(trucks["INV-24-A"]), [null, "", false, ""], "§5.3 no ELD link: null, '', false, ''");
		eq(lookups, { fix: 1, number: 1 }, "§5.4 one last-fix lookup and one vehicle-number lookup for the whole fleet");

		const repointed = await trucksWith(freshDb({ link356: RM_356 }));
		eq(eld(repointed.trucks["LogisX-#356"]), [NOW - 10 * 60 * 1000, "routemate", false, "356"], "§5.5 #356 re-pointed to its real ELD: live, vehicle 356");
		const nothingLinked = freshDb();
		nothingLinked.exec("UPDATE trucks SET routemate_vehicle_id = ''");
		eq((await trucksWith(nothingLinked)).lookups, { fix: 0, number: 0 }, "§5.6 nothing linked: no lookup at all");

		const db = freshDb({ link356: DEAD_LINXUP });
		db.exec("ALTER TABLE routemate_telemetry DROP COLUMN source");
		const errors = [];
		const broken = await trucksWith(db, errors);
		eq(eld(broken.trucks["LogisX-#356"]), [null, "", false, ""], "§5.7 a failed read leaves the status unknown, not silent");
		ok(errors.some((e) => /ELD last-fix read failed/.test(e)), "§5.8 ...and says so in the log");
	}

	// ------------------------------------------------------------------ §6
	console.log("§6 the feed alert");
	const { escHtml } = build(null, [extractFunction("escHtml")], { expose: ["escHtml"] });
	async function alert(verdict, { failMirror = false, ...opts } = {}) {
		const real = freshDb({ link356: DEAD_LINXUP, ...opts });
		const db = failMirror
			? { prepare: (s) => { if (/FROM routemate_vehicles/.test(s)) throw new Error("mirror unreadable"); return real.prepare(s); } }
			: real;
		const rec = { emails: [], notes: [] };
		const errors = [];
		const { alertEldFeedSilence } = build(db, [
			...FIX_FNS,
			extractConst("ELD_ALERT_SEND_LOG_KEY"), extractConst("ELD_STALE_REOPEN_COOLDOWN_MS"),
			...["unitNumberToken", "suggestRoutemateVehicleForTruck", "eldFeedAlertContext",
				"eldAlertSendsInWindow", "recordEldAlertSend", "escHtml"].map((n) => extractFunction(n)),
			extractFunction("alertEldFeedSilence", "async function"),
		], {
			errors,
			expose: ["alertEldFeedSilence"],
			deps: {
				todayKeyCT: () => "2026-10-01",
				process: { env: { GMAIL_USER: "ops@example.invalid" } },
				sendEmail: async (to, subject, html) => { rec.emails.push({ subject, html }); return true; },
				insertDispatchNotification: { run: (type, title, body) => rec.notes.push({ title, body }) },
				io: { to: () => ({ emit: () => {} }) },
			},
		});
		const r = await alertEldFeedSilence({ silentHours: 1, fixes24h: 1, reason: "test", ...verdict });
		return { r, errors, email: rec.emails[0] || {}, note: rec.notes[0] || {} };
	}
	const orphan = { kind: "orphan", state: "orphan", vehicleId: RM_356, unitNumber: "", lastFixMs: NOW - 10 * 60 * 1000 };
	const stale = { kind: "truck", state: "stale", truckId: 13, unitNumber: "LogisX-#356", vehicleId: DEAD_LINXUP, lastFixMs: DEAD_LINXUP_FIX };
	{
		const a = await alert(orphan);
		eq(a.r.alerted, true, "§6.1 the orphan alert is delivered");
		eq(a.email.subject, "⚠️ ELD vehicle 356 (2022 INTERNATIONAL LT625) is reporting to no truck", "§6.2 the subject names vehicle 356");
		eq(a.note.title, "ELD vehicle 356 (2022 INTERNATIONAL LT625) is linked to no truck", "§6.3 so does the notification");
		const line = "Truck LogisX-#356 has the matching unit number and is linked to device 18000507597, which last reported a GPS fix on 2026-09-15 UTC, 15 days ago. If this is its ELD, re-point it under Trucks → Change.";
		ok(a.email.html.includes(escHtml(line)), "§6.4 the email names the truck, its current device and that device's last fix");
		ok(a.note.body.endsWith(` · ${line}`), "§6.5 ...and so does the notification body");

		const unlinked = await alert(orphan, { link356: "" });
		ok(unlinked.email.html.includes("is linked to no device. If this is its ELD"), "§6.6 a matching truck with no device says so");
		const twins = await alert(orphan, { extraTrucks: [{ id: 30, unit: "LogisX-356" }] });
		ok(!twins.email.html.includes("matching unit number"), "§6.7 two matching trucks: no guess");
		const retiredTwin = await alert(orphan, { extraTrucks: [{ id: 30, unit: "LogisX-356", retiredAt: "2026-01-31" }] });
		ok(retiredTwin.email.html.includes("Truck LogisX-#356 has the matching unit number"), "§6.8 a retired truck is not a candidate");

		const b = await alert(stale);
		const hint = "vehicle 356 (2022 INTERNATIONAL LT625) is reporting live, is linked to no truck, and matches this truck's unit number — it may be this truck's ELD; re-point under Trucks → Change.";
		ok(b.email.html.includes(escHtml(hint)), "§6.9 the stale alert names the live unlinked device matching the unit");
		ok(b.note.body.endsWith(` · ${hint}`), "§6.10 ...in the notification body too");
		eq(b.email.subject, "⚠️ ELD feed silent — LogisX-#356 (0d 1h)", "§6.11 the stale subject is unchanged");
		const quiet = await alert(stale, { rm356FixMs: NOW - 72 * HOUR });
		ok(!quiet.email.html.includes("is reporting live") && !quiet.note.body.includes("re-point"), "§6.12 a SILENT matching device is not offered");
		const never = await alert({ ...stale, state: "never_reported", lastFixMs: null, silentHours: null });
		ok(never.email.html.includes(escHtml(hint)), "§6.13 never_reported gets the hint as well");

		// The unit number is free text: the hint carries it escaped, like every other value.
		const markup = await alert(orphan, { unit356: "LogisX-<i>#356" });
		ok(markup.email.html.includes("Truck LogisX-&lt;i&gt;#356 has the matching unit number") && !markup.email.html.includes("<i>#356"),
			"§6.14 the unit number is escaped in the hint");

		// A context read that fails leaves the alert worded as before, and delivered.
		const failed = await alert(orphan, { failMirror: true });
		eq([failed.r.alerted, failed.email.subject], [true, `⚠️ ELD device ${RM_356} is reporting to no truck`], "§6.15 context unreadable: delivered, worded as before");
		ok(failed.errors.some((e) => /alert context unavailable/.test(e)), "§6.16 ...and the failure is logged");
	}

	// ------------------------------------------------------------------ §7
	console.log("§7 /api/locations/latest");
	{
		const body = routeBody("get", "/api/locations/latest");
		const code = body.replace(/^\s*\/\/.*$/gm, "");
		ok(/const loadById = \(id\) => loadMap\[normalizeLoadId\(id\)\];/.test(code), "§7.1 one lookup helper over normalizeLoadId()");
		ok(/const key = normalizeLoadId\(obj\[loadIdCol\]\);\s*if \(key\) loadMap\[key\] = obj;/.test(code), "§7.2 the map is filed through the same normalizer");
		eq((code.match(/loadMap\[/g) || []).length, 2, "§7.3 no other read or write of loadMap");
		ok(/loc\.source = eldFeedHealth\.deviceProvider\(rm\) \|\| "eld";/.test(code), "§7.4 the overlay reports the provider that wrote the fix");
		ok(!/loc\.source = "routemate"/.test(code), "§7.5 ...never a blanket 'routemate'");
		ok(/rt\.source, rt\.engine_hours, rt\.geocoded_location/.test(code), "§7.6 the overlay reads the provider fields");
	}

	// ------------------------------------------------------------------ §8
	// Same truck-assignment incident family: the dashboard Fleet card read only
	// the directory's denormalized `trucks` copy, which is refreshed only when
	// the directory row is synced, and showed "No truck assigned" for a driver
	// assigned since.
	console.log("§8 GET /api/dashboard fleet truck");
	{
		const code = routeBody("get", "/api/dashboard").replace(/^\s*\/\/.*$/gm, "");
		const fleet = code.slice(code.indexOf("const fleet = carrierDB.data.map("));
		ok(/const assignedTruck = findTruckForDriver\(name\);/.test(fleet), "§8.1 one findTruckForDriver() call per directory row");
		ok(/Truck: assignedTruck \? assignedTruck\.unit_number : truckCol \? r\[truckCol\] \|\| "" : "",/.test(fleet),
			"§8.2 the assigned truck first, the stored copy only without one");
		ok(!/drivers_directory/.test(fleet.slice(0, fleet.indexOf("});"))), "§8.3 the read path writes nothing back");
	}

	// ------------------------------------------------------------------ §9
	// §7's blanket label on the driver's own map: every ELD fix was served as
	// 'routemate', a Linxup truck's included.
	console.log("§9 GET /api/driver/position");
	{
		const LINXUP_LIVE = "18000507600";
		const ODD_SOURCE = "unknown-provider-device";
		const db = freshDb();
		const tel = db.prepare(`INSERT INTO routemate_telemetry
			(routemate_vehicle_id, latitude, longitude, engine_hours, geocoded_location, location_date_ms, source)
			VALUES (?,?,?,?,?,?,?)`);
		tel.run(LINXUP_LIVE, 29.9, -95.5, 0, "", NOW - 5 * 60 * 1000, "linxup");
		tel.run(ODD_SOURCE, 29.6, -95.2, 0, "", NOW - 5 * 60 * 1000, "samsara");
		const lifted = build(null, [
			extractConst("MOVEMENT_MOVING_MPS"), extractConst("MOVEMENT_ACTIVE_MS"),
			extractFunction("classifyMovement"), extractFunction("parseRoutemateBearing"),
		], { expose: ["classifyMovement", "parseRoutemateBearing"] });
		const route = ["/api/driver/position", "/api/driver/me/position"];
		const sourceFor = async (vid) => {
			const get = routeWorld(db, "get", route, {
				...lifted, geolib: require("geolib"), driverPositionLimiter: null,
				resolveTruckForDriverName: () => ({ unit: "LogisX-#21", routemate_vehicle_id: vid }),
			});
			const res = await get({ session: { user: { role: "Driver", driverName: "Test Driver" } } });
			return res.body.position && res.body.position.source;
		};
		eq(await sourceFor(LINXUP_LIVE), "linxup", "§9.1 a Linxup device's fix is served as 'linxup'");
		eq(await sourceFor(RM_356), "routemate", "§9.2 a Routemate device's fix stays 'routemate'");
		eq(await sourceFor(ODD_SOURCE), "eld", "§9.3 a provider the label does not know is served as 'eld', never guessed");
		const code = routeBody("get", route).replace(/^\s*\/\/.*$/gm, "");
		ok(/source: eldFeedHealth\.deviceProvider\(rm\) \|\| "eld",/.test(code), "§9.4 the same rule as §7.4, not a copy");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
