#!/usr/bin/env node
/**
 * The Routemate vehicle sync against the list endpoint's KNOWN outage.
 *
 * GET /api/v0/assets/vehicles has answered HTTP 500 for this account since at
 * least 2026-05-06, while the per-vehicle GET /api/v0/assets/vehicle/{id} works.
 * routemateSyncVehicles() counted that 500 as a failed sync — a "vehicles sync
 * failed" line in every boot log, errorsLast24h bumped every day, and
 * POST /api/admin/routemate/sync-now answering 502 with no audit row, although
 * its own per-vehicle fallback had just done the job.
 *
 * Now the KNOWN SHAPE — HTTP 500 from the list, while the company endpoint still
 * answers — sets `listUnavailable`: ids come from telemetry, the per-vehicle
 * refresh runs ONCE, lastSync is stamped, no error is counted, and sync-now
 * answers 200 with a hint and an audit row. Everything else is still a failure:
 * any other list status (401/403, 502/503/504), a 500 on the company endpoint
 * too, a network drop, a vehicle the refresh could not fetch. Those count an
 * error, and sync-now answers 502 with a `routemate_sync_failed` row.
 *
 * In the per-vehicle refresh, ONLY 400 and 404 mean "not a Routemate vehicle"
 * and are remembered. Any other error says nothing about the id; the refresh
 * stops on the ones that will hit every vehicle alike (401/403, 408, 429, no
 * answer at all) and never files a real vehicle as "not ours".
 *
 * WHAT IS EXECUTED — the shipping functions, lifted out of server.js (it cannot
 * be required: it opens SQLite, reads a key and listens on import), wired to the
 * REAL lib/routemate-client.js, which talks to a throwaway localhost server that
 * plays Routemate. Every lift asserts exactly one definition.
 *   §1 the known outage (list 500): success, one refresh, stamped, no error
 *   §2 real failures: list 401, network drop, a vehicle that 500s, the key refused
 *      mid-refresh — failed, audited, and never filing real vehicles "not ours"
 *   §3 a healthy list: unchanged
 *   §4 the per-vehicle answers: 400/404 remembered; 409/422 failed and asked
 *      again; 408 and a dropped connection stop the refresh
 *   §5 only the known shape is "expected": a list 503, and a 500 everywhere
 *   §6 source pins: the lib comment, the admin toast, the named handler
 *   §7 mutants: each must flip an assertion
 *
 * Hermetic: in-memory SQLite, a localhost stub, no credentials, no network.
 * Run: node scripts/test-routemate-vehicle-sync.js
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const routemate = require("../lib/routemate-client");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// ---------------------------------------------------------------- lifting
function matchClose(src, openAt, open, close) {
	for (let i = openAt, depth = 0; i < src.length; i++) {
		if (src[i] === open) depth++;
		else if (src[i] === close) { depth--; if (depth === 0) return i; }
	}
	throw new Error(`unbalanced ${open}${close} at ${openAt}`);
}
function liftFunction(src, name) {
	const hits = ["\nfunction ", "\nasync function "].map((p) => src.split(`${p}${name}(`).length - 1);
	if (hits[0] + hits[1] !== 1) throw new Error(`expected exactly 1 function ${name}() in server.js, found ${hits[0] + hits[1]}`);
	const needle = hits[1] ? `\nasync function ${name}(` : `\nfunction ${name}(`;
	const start = src.indexOf(needle) + 1;
	const params = matchClose(src, src.indexOf("(", start), "(", ")");
	return src.slice(start, matchClose(src, src.indexOf("{", params), "{", "}") + 1);
}
// `const NAME = <expr>;` — a one-liner, an object literal, or a db.prepare(...) call.
function liftConst(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 const ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	const valueAt = start + needle.length - 1;
	if (src[valueAt] === "{") return src.slice(start, matchClose(src, valueAt, "{", "}") + 1) + ";";
	if (src.startsWith("db.prepare(", valueAt)) return src.slice(start, matchClose(src, valueAt + "db.prepare".length, "(", ")") + 1) + ";";
	return src.slice(start, src.indexOf("\n", start));
}
function liftCreateTable(src, table) {
	const needle = `CREATE TABLE IF NOT EXISTS ${table} (`;
	if (src.split(needle).length - 1 !== 1) throw new Error(`expected exactly 1 CREATE TABLE ${table}`);
	const start = src.indexOf(needle);
	return src.slice(start, matchClose(src, start + needle.length - 1, "(", ")") + 1);
}

// Build the lifted world: one in-memory database, the real client, captured audit
// rows and console. `src` defaults to the shipping server.js; §7 passes mutants.
function buildWorld(baseUrl, src = SRC) {
	const db = new Database(":memory:");
	db.exec(liftCreateTable(SRC, "routemate_vehicles"));
	db.exec(liftCreateTable(SRC, "routemate_telemetry"));
	const audits = [];
	const logs = [];
	const body = [
		"const ROUTEMATE_ENABLED = true;",
		"const ROUTEMATE_API_KEY = \"test-key\";",
		"const ROUTEMATE_BASE_URL = __baseUrl;",
		liftFunction(src, "routemateCreds"),
		liftConst(src, "routemateHealth"),
		"const routemateLogState = {};",
		liftFunction(src, "logRoutemateSyncFailure"),
		liftFunction(src, "clearRoutemateLogState"),
		liftConst(src, "routemateUpsertVehicleStmt"),
		liftConst(src, "routemateUpsertVehicleMinimalStmt"),
		liftConst(src, "routemateNonInventoryIds"),
		liftFunction(src, "routemateHydrateVehicleDetails"),
		liftFunction(src, "routemateSeedVehicleIdsFromTelemetry"),
		liftFunction(src, "routemateSyncVehicles"),
		liftFunction(src, "routemateSyncNowHandler"),
		"return { routemateSyncVehicles, routemateSyncNowHandler, routemateHealth, routemateNonInventoryIds };",
	].join("\n");
	const deps = {
		db,
		routemate,
		__baseUrl: baseUrl,
		logAudit: (req, action, entity, entityId, details) => audits.push({ action, entity, details }),
		routemateSyncTelemetry: async () => {},
		console: {
			log: (...a) => logs.push(a.join(" ")),
			warn: (...a) => logs.push(a.join(" ")),
			error: (...a) => logs.push(a.join(" ")),
		},
	};
	const w = new Function(...Object.keys(deps), body)(...Object.values(deps));
	return Object.assign(w, { db, audits, logs });
}

// ---------------------------------------------------------------- Routemate, played
// `routes` answers each path; every hit is counted so "ONCE" is a measurement.
function playRoutemate(routes) {
	const hits = { company: 0, list: 0, vehicle: [] };
	const srv = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname === "/api/v0/company") { hits.company++; return routes.company(req, res); }
		if (url.pathname === "/api/v0/assets/vehicles") { hits.list++; return routes.list(req, res); }
		const m = url.pathname.match(/^\/api\/v0\/assets\/vehicle\/([^/]{1,80})$/);
		if (m) { const id = decodeURIComponent(m[1]); hits.vehicle.push(id); return routes.vehicle(id, req, res); }
		res.writeHead(404); res.end();
	});
	return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
		resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const reply = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const ok200 = (req, res) => reply(res, 200, { id: "company-1" });
const list500 = (req, res) => { res.writeHead(500); res.end("Internal Server Error"); };
const list401 = (req, res) => reply(res, 401, { message: "unauthorized" });
const dropSocket = (req) => req.socket.destroy();
// Two Routemate vehicles and one Linxup device, all reporting GPS. rmB has no VIN
// on file upstream, so it stays a refresh candidate — which is what lets §1 SEE a
// second refresh if one ever runs.
const RM_A = "rmA-2Y_aT-AYiR1Yek5krywLVQ";
const RM_B = "rmB-wL8e55NU0KjcB2ynE2wf1g";
const LINXUP = "18000505841";
const vehicleRecord = (id) => ({ data: { id, vehicleId: id === RM_A ? "#33" : "#91", vin: id === RM_A ? "1FUJGLDR7CLBP8834" : "", make: "Freightliner", year: 2019, active: true } });
const vehiclesOk = (id, req, res) => (id === LINXUP
	? reply(res, 400, { message: "The given id must not be null" })
	: reply(res, 200, vehicleRecord(id)));
function seedTelemetry(db, ids = [RM_A, RM_B, LINXUP]) {
	const ins = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms) VALUES (?, 29.7, -95.4, ?)");
	const at = Date.now() - 60000;   // one clock read for every row, never one per row
	for (const id of ids) ins.run(id, at);
}
// One direct (boot/daily-tick) sync, never throwing: { result, err }.
async function syncOnce(w) {
	try { return { result: await w.routemateSyncVehicles(), err: null }; } catch (e) { return { result: null, err: e }; }
}
const logged = (w, re) => w.logs.some((l) => re.test(l));
async function syncNow(w) {
	let status = 200;
	let body = null;
	const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; } };
	await w.routemateSyncNowHandler({ session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } }, res);
	return { status, body };
}
const count = (arr, v) => arr.filter((x) => x === v).length;
const vinOf = (w, id) => (w.db.prepare("SELECT vin FROM routemate_vehicles WHERE routemate_vehicle_id = ?").get(id) || {}).vin;

// ---------------------------------------------------------------- runner
let pass = 0;
let fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`ok    ${label}`); return true; }
	fail++;
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
	console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
	return false;
}
function section(t) { console.log(`\n${t}`); }

// Each scenario is a function of `src`, so §5 can re-run it on a mutant.
// Returns [label, actual, expected] triples.
async function outageChecks(src) {
	const out = [];
	{
		const R = await playRoutemate({ company: ok200, list: list500, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			let result = null;
			let threw = null;
			try { result = await w.routemateSyncVehicles(); } catch (e) { threw = e.message; }
			out.push(["outage: a list 500 is NOT a failed sync", [threw, result && result.listUnavailable, result && result.upstreamStatus], [null, true, 500]]);
			out.push(["outage: ids come from telemetry, then the per-vehicle refresh", [result && result.fallbackSynced, result && result.hydrated, result && result.hydrationSkipped], [3, 2, 1]]);
			out.push(["outage: the list is asked once, and each vehicle ONCE", [R.hits.list, count(R.hits.vehicle, RM_A), count(R.hits.vehicle, RM_B), count(R.hits.vehicle, LINXUP)], [1, 1, 1, 1]]);
			out.push(["outage: the boot/daily path checks the company endpoint once before calling it expected", R.hits.company, 1]);
			out.push(["outage: the refresh really filled the mirror (VIN for #33)", vinOf(w, RM_A), "1FUJGLDR7CLBP8834"]);
			out.push(["outage: lastSync is stamped, and no error is counted",
				[typeof w.routemateHealth.lastSync.vehicles, w.routemateHealth.errorsLast24h, w.routemateHealth.lastError], ["string", 0, null]]);
			out.push(["outage: the boot log says 'list unavailable (expected)', not 'sync failed'",
				[w.logs.some((l) => /\[routemate\] vehicles list unavailable \(expected, upstream 500\)/.test(l)), w.logs.some((l) => /sync failed/.test(l))], [true, false]]);
			out.push(["outage: a Linxup id's 400 still marks it 'not ours' (unchanged)", w.routemateNonInventoryIds.has(LINXUP), true]);
		} finally { R.srv.close(); }
	}
	{
		const R = await playRoutemate({ company: ok200, list: list500, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			const r = await syncNow(w);
			out.push(["outage: sync-now answers 200 with the hint",
				[r.status, r.body && r.body.success, r.body && r.body.listUnavailable, r.body && r.body.hint, r.body && r.body.vehiclesHydrated],
				[200, true, true, "vehicle list unavailable upstream; per-vehicle refresh done", 2]]);
			out.push(["outage: sync-now's own smoke test counts — the company endpoint is asked once, not twice", R.hits.company, 1]);
			out.push(["outage: …and leaves an audit row saying what happened",
				w.audits.map((a) => [a.action, /unavailable upstream \(HTTP 500\); per-vehicle refresh done: 2 updated, 1 skipped/.test(a.details)]), [["routemate_sync", true]]]);
			// The next daily tick: VINs are in, the Linxup id is remembered — no calls
			// beyond rmB (still VIN-less upstream), and still a success.
			const before = R.hits.vehicle.length;
			let again = null;
			try { again = await w.routemateSyncVehicles(); } catch (e) { again = { threw: e.message }; }
			out.push(["outage: the next sync is a success too, and re-asks only the VIN-less vehicle",
				[again.listUnavailable, R.hits.vehicle.slice(before)], [true, [RM_B]]]);
		} finally { R.srv.close(); }
	}
	return out;
}

async function failureChecks(src) {
	const out = [];
	// A refused key on the list.
	{
		const R = await playRoutemate({ company: ok200, list: list401, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			// A mirror earlier syncs left VIN-less — so a refresh that wrongly ran here
			// would have candidates to call, and the hit count below would show it.
			for (const id of [RM_A, RM_B]) w.db.prepare("INSERT INTO routemate_vehicles (routemate_vehicle_id) VALUES (?)").run(id);
			let threw = null;
			try { await w.routemateSyncVehicles(); } catch (e) { threw = e.status || "no-status"; }
			out.push(["401: a refused key IS a failed sync — error counted, lastSync not stamped",
				[threw, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles, w.routemateHealth.lastError && w.routemateHealth.lastError.status], [401, 1, null, 401]]);
			out.push(["401: the per-vehicle refresh does NOT run on a refused key", R.hits.vehicle, []]);
			const r = await syncNow(buildWorld(R.base, src));
			out.push(["401: sync-now answers 502 (never the upstream 401 itself), naming it",
				[r.status, r.body && r.body.upstreamStatus, r.body && r.body.code, /API key/.test((r.body && r.body.hint) || "")], [502, 401, "ROUTEMATE_SYNC_FAILED", true]]);
		} finally { R.srv.close(); }
	}
	// The failure audit row, on its own world so the count is exact.
	{
		const R = await playRoutemate({ company: ok200, list: list401, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			await syncNow(w);
			out.push(["401: …and is audited as routemate_sync_failed",
				w.audits.map((a) => [a.action, /ROUTEMATE_SYNC_FAILED \(HTTP 401\)/.test(a.details)]), [["routemate_sync_failed", true]]]);
		} finally { R.srv.close(); }
	}
	// The network drops mid-request.
	{
		const R = await playRoutemate({ company: ok200, list: dropSocket, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			let threw = null;
			try { await w.routemateSyncVehicles(); } catch (e) { threw = e.status || "no-status"; }
			out.push(["network: a dropped connection is a failed sync, with no refresh",
				[threw, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles, R.hits.vehicle.length], ["no-status", 1, null, 0]]);
			out.push(["network: …but the local telemetry ids are still seeded", !!w.db.prepare("SELECT 1 FROM routemate_vehicles WHERE routemate_vehicle_id = ?").get(RM_A), true]);
			const w2 = buildWorld(R.base, src);
			const r = await syncNow(w2);
			out.push(["network: sync-now answers 502 and audits routemate_sync_failed",
				[r.status, r.body && r.body.upstreamStatus, /could not be reached/.test((r.body && r.body.hint) || ""), w2.audits.map((a) => a.action)],
				[502, null, true, ["routemate_sync_failed"]]]);
		} finally { R.srv.close(); }
	}
	// The list is down and Routemate refuses the key mid-refresh.
	{
		const R = await playRoutemate({ company: ok200, list: list500, vehicle: (id, req, res) => reply(res, 401, { message: "unauthorized" }) });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			let threw = null;
			try { await w.routemateSyncVehicles(); } catch (e) { threw = [e.status, /refused the API key/.test(e.message)]; }
			out.push(["key refused mid-refresh: a failed sync, stopped at the first refusal", [threw, R.hits.vehicle.length], [[401, true], 1]]);
			out.push(["key refused mid-refresh: ⚠️ no real vehicle is filed as 'not ours'", [...w.routemateNonInventoryIds], []]);
		} finally { R.srv.close(); }
	}
	return out;
}

// The list is down AND one vehicle 500s: the refresh did not finish. On its own
// because the 500 pays the client's retry backoff (~1.5 s), which every mutant
// re-running failureChecks() would otherwise pay again.
async function refreshFailureChecks(src) {
	const out = [];
	const R = await playRoutemate({
		company: ok200, list: list500,
		vehicle: (id, req, res) => (id === RM_B ? reply(res, 500, { message: "boom" }) : vehiclesOk(id, req, res)),
	});
	try {
		const w = buildWorld(R.base, src);
		seedTelemetry(w.db);
		const r = await syncNow(w);
		out.push(["refresh failure: a vehicle the refresh could not fetch fails the sync (502)",
			[r.status, r.body && r.body.code, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles], [502, "ROUTEMATE_REFRESH_FAILED", 1, null]]);
		out.push(["refresh failure: …audited, with what failed", w.audits.map((a) => [a.action, /ROUTEMATE_REFRESH_FAILED: .*failed for 1 vehicle/.test(a.details)]), [["routemate_sync_failed", true]]]);
		// A 5xx on one vehicle says nothing about the others: the refresh carries on.
		out.push(["refresh failure: a 5xx on one vehicle does not stop the others, nor mark it 'not ours'",
			[count(R.hits.vehicle, RM_A), count(R.hits.vehicle, LINXUP), w.routemateNonInventoryIds.has(RM_B)], [1, 1, false]]);
	} finally { R.srv.close(); }
	return out;
}

async function healthyChecks(src) {
	const out = [];
	const R = await playRoutemate({
		company: ok200,
		list: (req, res) => reply(res, 200, { data: [
			{ id: RM_A, vehicleId: "#33", vin: "1FUJGLDR7CLBP8834", active: true },
			{ id: RM_B, vehicleId: "#91", vin: "", active: true },
		] }),
		vehicle: vehiclesOk,
	});
	try {
		const w = buildWorld(R.base, src);
		const r = await syncNow(w);
		out.push(["healthy list: synced from the list, no hint, the ordinary audit row",
			[r.status, r.body && r.body.vehiclesSynced, r.body && r.body.listUnavailable, w.audits.map((a) => [a.action, a.details])],
			[200, 2, undefined, [["routemate_sync", "Synced 2 Routemate vehicles"]]]]);
		out.push(["healthy list: the refresh only asks the vehicle the list left VIN-less", R.hits.vehicle, [RM_B]]);
	} finally { R.srv.close(); }
	return out;
}

// The per-vehicle refresh, with the list in its known outage so the refresh IS the
// sync. None of these pay the client's retry backoff: it fails fast on a 4xx
// other than 429.
async function perVehicleChecks(src) {
	const out = [];
	// Answers that do not stop the loop. 400 (the Linxup id) and 404 mean "not
	// ours"; 409 and 422 are failures that say nothing about the id.
	{
		const X409 = "rm409-conflict";
		const X422 = "rm422-unprocessable";
		const X404 = "rm404-unknown";
		const answer = { [X409]: 409, [X422]: 422, [X404]: 404, [LINXUP]: 400 };
		const R = await playRoutemate({
			company: ok200, list: list500,
			vehicle: (id, req, res) => (answer[id] ? reply(res, answer[id], { message: "no" }) : reply(res, 200, vehicleRecord(id))),
		});
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db, [X409, X422, X404, LINXUP]);
			const { err } = await syncOnce(w);
			out.push(["4xx: only 400 and 404 are remembered as 'not ours' — never 409 or 422",
				[...w.routemateNonInventoryIds].sort(), [LINXUP, X404].sort()]);
			out.push(["4xx: 409 and 422 do not stop the refresh — each vehicle is asked once",
				[X409, X422, X404, LINXUP].map((id) => count(R.hits.vehicle, id)), [1, 1, 1, 1]]);
			out.push(["4xx: …and the two it could not fetch fail the sync",
				[err && err.code, err && /failed for 2 vehicle\(s\)$/.test(err.message), err && err.status, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles],
				["ROUTEMATE_REFRESH_FAILED", true, null, 1, null]]);
			const before = R.hits.vehicle.length;
			await syncOnce(w);
			out.push(["4xx: the next sync asks the 409 and 422 again, and neither remembered id",
				R.hits.vehicle.slice(before).sort(), [X409, X422].sort()]);
		} finally { R.srv.close(); }
	}
	// A 408 on every vehicle: Routemate sends them, and the client gives up at once.
	{
		const routes = { company: ok200, list: list500, vehicle: (id, req, res) => reply(res, 408, { message: "request timeout" }) };
		const R = await playRoutemate(routes);
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			const { err } = await syncOnce(w);
			out.push(["408: a failed sync that stops the refresh at the first vehicle",
				[err && err.code, err && err.status, err && /stopped on HTTP 408/.test(err.message), R.hits.vehicle.length],
				["ROUTEMATE_REFRESH_FAILED", 408, true, 1]]);
			out.push(["408: ⚠️ no real vehicle is remembered as 'not ours'", [...w.routemateNonInventoryIds], []]);
			// Routemate answers again: the same process refreshes the vehicle.
			routes.vehicle = vehiclesOk;
			const { err: again } = await syncOnce(w);
			out.push(["408: once Routemate answers, the next sync refreshes it (VIN for #33)",
				[again && again.message, vinOf(w, RM_A)], [null, "1FUJGLDR7CLBP8834"]]);
		} finally { R.srv.close(); }
	}
	{
		const R = await playRoutemate({ company: ok200, list: list500, vehicle: (id, req, res) => reply(res, 408, { message: "request timeout" }) });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			const r = await syncNow(w);
			out.push(["408: sync-now answers 502 naming the 408, and audits it",
				[r.status, r.body && r.body.code, r.body && r.body.upstreamStatus, w.audits.map((a) => [a.action, /ROUTEMATE_REFRESH_FAILED \(HTTP 408\)/.test(a.details)])],
				[502, "ROUTEMATE_REFRESH_FAILED", 408, [["routemate_sync_failed", true]]]]);
		} finally { R.srv.close(); }
	}
	return out;
}

// A dropped connection mid-refresh. On its own because it pays the client's real
// retry backoff (~1.5 s per vehicle asked).
async function networkRefreshChecks(src) {
	const out = [];
	const R = await playRoutemate({ company: ok200, list: list500, vehicle: (id, req) => dropSocket(req) });
	try {
		const w = buildWorld(R.base, src);
		seedTelemetry(w.db, [RM_A, RM_B]);
		const { err } = await syncOnce(w);
		out.push(["network mid-refresh: the refresh stops after the first vehicle", new Set(R.hits.vehicle).size, 1]);
		out.push(["network mid-refresh: a failed sync that says so, with no status",
			[err && err.code, err && err.status, err && /stopped on a network error or timeout/.test(err.message), w.routemateHealth.errorsLast24h],
			["ROUTEMATE_REFRESH_FAILED", null, true, 1]]);
		out.push(["network mid-refresh: ⚠️ nothing is remembered as 'not ours'", [...w.routemateNonInventoryIds], []]);
	} finally { R.srv.close(); }
	return out;
}

// Only the known shape is "expected".
async function listShapeChecks(src) {
	const out = [];
	const list503 = (req, res) => reply(res, 503, { message: "service unavailable" });
	{
		const R = await playRoutemate({ company: ok200, list: list503, vehicle: vehiclesOk });
		try {
			const w = buildWorld(R.base, src);
			seedTelemetry(w.db);
			const { err } = await syncOnce(w);
			out.push(["list 503: a real failure — counted, not stamped, no refresh",
				[err && err.status, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles, R.hits.vehicle], [503, 1, null, []]]);
			out.push(["list 503: logged as a failed sync, never as the expected outage",
				[logged(w, /list unavailable \(expected/), logged(w, /vehicles sync failed/)], [false, true]]);
			const w2 = buildWorld(R.base, src);
			const r = await syncNow(w2);
			out.push(["list 503: sync-now answers 502 and audits routemate_sync_failed",
				[r.status, r.body && r.body.upstreamStatus, r.body && r.body.listUnavailable, w2.audits.map((a) => [a.action, /ROUTEMATE_SYNC_FAILED \(HTTP 503\)/.test(a.details)])],
				[502, 503, undefined, [["routemate_sync_failed", true]]]]);
		} finally { R.srv.close(); }
	}
	return out;
}

// The list 500s and so does the company endpoint: the whole API is down. With
// every VIN already on file the refresh has nothing to ask, so only the company
// check can tell this from the known outage. On its own because the company call
// pays the client's retry backoff (~1.5 s).
async function companyDownChecks(src) {
	const out = [];
	const down = (req, res) => { res.writeHead(500); res.end("Internal Server Error"); };
	const R = await playRoutemate({ company: down, list: list500, vehicle: down });
	try {
		const w = buildWorld(R.base, src);
		seedTelemetry(w.db, [RM_A, RM_B]);
		const ins = w.db.prepare("INSERT INTO routemate_vehicles (routemate_vehicle_id, vin) VALUES (?, ?)");
		ins.run(RM_A, "1FUJGLDR7CLBP8834");
		ins.run(RM_B, "1FUJGLDR9DLBP1234");
		const { err } = await syncOnce(w);
		out.push(["company down too: a 500 everywhere is a failed sync, not the expected outage",
			[err && err.status, w.routemateHealth.errorsLast24h, w.routemateHealth.lastSync.vehicles, logged(w, /list unavailable \(expected/)],
			[500, 1, null, false]]);
		out.push(["company down too: …and the log names it an outage, so it cannot pass for the known list 500",
			[err && /an outage, not the known list bug/.test(err.message), logged(w, /vehicles sync failed: .*an outage, not the known list bug/)], [true, true]]);
		out.push(["company down too: the company endpoint was asked; the refresh did not run", [R.hits.company > 0, R.hits.vehicle], [true, []]]);
	} finally { R.srv.close(); }
	return out;
}

(async () => {
	section("1. The known outage — a list 500 is a completed sync");
	for (const [l, a, e] of await outageChecks(SRC)) eq(a, e, l);

	section("2. Real failures stay failures — counted, 502, audited");
	for (const [l, a, e] of await failureChecks(SRC)) eq(a, e, l);
	for (const [l, a, e] of await refreshFailureChecks(SRC)) eq(a, e, l);

	section("3. A healthy list — unchanged");
	for (const [l, a, e] of await healthyChecks(SRC)) eq(a, e, l);

	section("4. The per-vehicle answers — only 400/404 mean 'not ours'");
	for (const [l, a, e] of await perVehicleChecks(SRC)) eq(a, e, l);
	for (const [l, a, e] of await networkRefreshChecks(SRC)) eq(a, e, l);

	section("5. Only the known shape is 'expected' — a list 500 while the company endpoint answers");
	for (const [l, a, e] of await listShapeChecks(SRC)) eq(a, e, l);
	for (const [l, a, e] of await companyDownChecks(SRC)) eq(a, e, l);

	section("6. Source pins");
	const lib = fs.readFileSync(path.join(ROOT, "lib", "routemate-client.js"), "utf8");
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "AdminToolsView.vue"), "utf8");
	eq([/runs\s*\/\/ routemateHydrateVehicleDetails\(\) on the CATCH path/.test(lib), /an HTTP 500 from here/.test(lib), /only while the company endpoint/.test(lib)], [false, true, true],
		"pin: the listVehicles comment describes the known shape (a 500, company up), not the old catch path");
	eq(/Callers treat ONLY 400 and 404 as "not a/.test(lib) && /must never be[\s/]+remembered as "not ours"/.test(lib), true,
		"pin: the getVehicle note says only 400/404 mean 'not ours'");
	eq(/if \(r\.listUnavailable\) \{/.test(view) && /Vehicle list unavailable upstream; per-vehicle refresh done/.test(view), true,
		"pin: the admin toast reports the list-unavailable sync as done, not as an error");
	eq(SRC.includes('app.post("/api/admin/routemate/sync-now", requireRole("Super Admin"), routemateSyncNowHandler);'), true,
		"pin: sync-now is still Super Admin only, through the named handler");

	section("7. DISCRIMINATION — each mutant must flip an assertion");
	const failedLabels = (checks) => checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).map(([l]) => l);
	const mutateOnce = (from, to, id) => {
		const hits = SRC.split(from).length - 1;
		if (hits !== 1) throw new Error(`mutant ${id}: anchor must occur exactly once in server.js, found ${hits}`);
		return SRC.replace(from, () => to);
	};
	const MUTANTS = [
		["MB1", "every list error is 'unavailable'", "if (!(listErr && listErr.status === 500)) throw listErr;", "",
			failureChecks, "401: a refused key IS a failed sync — error counted, lastSync not stamped"],
		["MB2", "the list 500 is a failure again", "listUnavailable = listErr;\n\t\t\t\tbreak;", "throw listErr;",
			outageChecks, "outage: a list 500 is NOT a failed sync"],
		["MB3", "the refresh runs twice", "const hydration = await routemateHydrateVehicleDetails(creds);", "await routemateHydrateVehicleDetails(creds);\n\t\tconst hydration = await routemateHydrateVehicleDetails(creds);",
			outageChecks, "outage: the list is asked once, and each vehicle ONCE"],
		["MB4", "the refresh runs on a real failure (the old catch path)", "logRoutemateSyncFailure(\"vehicles\", err);", "logRoutemateSyncFailure(\"vehicles\", err);\n\t\tawait routemateHydrateVehicleDetails(creds);",
			failureChecks, "401: the per-vehicle refresh does NOT run on a refused key"],
		["MB5", "a refused key does not stop the refresh", "if (!status || status === 401 || status === 403 || status === 408 || status === 429) {", "if (!status || status === 408 || status === 429) {",
			failureChecks, "key refused mid-refresh: a failed sync, stopped at the first refusal"],
		["MB6", "sync-now passes the upstream 401 through", "res.status(502).json({\n\t\t\terror: err.message || \"Routemate sync failed\",", "res.status(err.status === 401 || err.status === 403 ? err.status : 502).json({\n\t\t\terror: err.message || \"Routemate sync failed\",",
			failureChecks, "401: sync-now answers 502 (never the upstream 401 itself), naming it"],
		["MB7", "a failed sync leaves no audit row", "\t\tlogAudit(req, \"routemate_sync_failed\", \"vehicles\", \"\",", "\t\tvoid (req, \"routemate_sync_failed\", \"vehicles\", \"\",",
			failureChecks, "401: …and is audited as routemate_sync_failed"],
		["MB8", "the list-unavailable sync is not audited", "\t\t\tlogAudit(req, \"routemate_sync\", \"vehicles\", \"\",\n\t\t\t\t`Vehicle list unavailable upstream", "\t\t\tvoid (req, \"routemate_sync\", \"vehicles\", \"\",\n\t\t\t\t`Vehicle list unavailable upstream",
			outageChecks, "outage: …and leaves an audit row saying what happened"],
		["MB9", "the list-unavailable sync is not stamped", "routemateHealth.lastSync.vehicles = new Date().toISOString();", "if (!listUnavailable) routemateHealth.lastSync.vehicles = new Date().toISOString();",
			outageChecks, "outage: lastSync is stamped, and no error is counted"],
		["MB10", "a failed refresh passes as success", "if (hydration.failed > 0) {", "if (false) {",
			refreshFailureChecks, "refresh failure: a vehicle the refresh could not fetch fails the sync (502)"],
		// The 400/404 rule and the stop list — review round on PR #369.
		["MB11", "a refused key files vehicles as 'not ours'", "if (status === 400 || status === 404) {", "if (status >= 400 && status < 500 && status !== 429) {",
			failureChecks, "key refused mid-refresh: ⚠️ no real vehicle is filed as 'not ours'"],
		["MB12", "the old 4xx rule: a 408 is remembered as 'not ours'", "if (status === 400 || status === 404) {", "if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {",
			perVehicleChecks, "408: ⚠️ no real vehicle is remembered as 'not ours'"],
		["MB13", "the old 4xx rule: a 409/422 is remembered as 'not ours'", "if (status === 400 || status === 404) {", "if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {",
			perVehicleChecks, "4xx: only 400 and 404 are remembered as 'not ours' — never 409 or 422"],
		["MB14", "a 408 does not stop the refresh", "if (!status || status === 401 || status === 403 || status === 408 || status === 429) {", "if (!status || status === 401 || status === 403 || status === 429) {",
			perVehicleChecks, "408: a failed sync that stops the refresh at the first vehicle"],
		["MB15", "a network failure does not stop the refresh", "if (!status || status === 401 || status === 403 || status === 408 || status === 429) {", "if (status === 401 || status === 403 || status === 408 || status === 429) {",
			networkRefreshChecks, "network mid-refresh: the refresh stops after the first vehicle"],
		["MB16", "any 5xx from the list is 'expected'", "if (!(listErr && listErr.status === 500)) throw listErr;", "if (!(listErr && listErr.status >= 500 && listErr.status < 600)) throw listErr;",
			listShapeChecks, "list 503: a real failure — counted, not stamped, no refresh"],
		["MB17", "the boot/daily path skips the company check", "if (!companyVerified) {", "if (false) {",
			companyDownChecks, "company down too: a 500 everywhere is a failed sync, not the expected outage"],
		["MB18", "sync-now asks the company endpoint twice", "const result = await routemateSyncVehicles({ companyVerified: true });", "const result = await routemateSyncVehicles();",
			outageChecks, "outage: sync-now's own smoke test counts — the company endpoint is asked once, not twice"],
	];
	for (const [id, what, from, to, suite, mustFail] of MUTANTS) {
		let failedHere;
		try { failedHere = failedLabels(await suite(mutateOnce(from, to, id))); } catch (e) { failedHere = [`(crashed: ${e.message})`]; }
		eq(failedHere.includes(mustFail), true, `MUTANT ${id}: ${what} → "${mustFail}" fails`);
	}

	console.log(`\n${"-".repeat(60)}`);
	if (fail) {
		console.log(`FAILED — ${pass} passed, ${fail} failed\n`);
		failures.forEach((f) => console.log(`  ${f}`));
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})().catch((e) => { console.error("FAIL  runner crashed:", (e && e.stack) || e); process.exit(1); });
