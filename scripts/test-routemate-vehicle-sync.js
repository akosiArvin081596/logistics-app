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
 * Now a 5xx from the LIST sets `listUnavailable`: ids come from telemetry, the
 * per-vehicle refresh runs ONCE, lastSync is stamped, no error is counted, and
 * sync-now answers 200 with a hint and an audit row. Everything else is still a
 * failure: 401/403, a network drop, a vehicle the refresh could not fetch. Those
 * count an error, and sync-now answers 502 with a `routemate_sync_failed` row.
 *
 * WHAT IS EXECUTED — the shipping functions, lifted out of server.js (it cannot
 * be required: it opens SQLite, reads a key and listens on import), wired to the
 * REAL lib/routemate-client.js, which talks to a throwaway localhost server that
 * plays Routemate. Every lift asserts exactly one definition.
 *   §1 the known outage (list 500): success, one refresh, stamped, no error
 *   §2 real failures: list 401, network drop, a vehicle that 500s, the key refused
 *      mid-refresh — failed, audited, and never filing real vehicles "not ours"
 *   §3 a healthy list: unchanged
 *   §4 source pins: the lib comment, the admin toast, the named handler
 *   §5 mutants: each must flip an assertion
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
// rows and console. `src` defaults to the shipping server.js; §5 passes mutants.
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
function seedTelemetry(db) {
	const ins = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms) VALUES (?, 29.7, -95.4, ?)");
	for (const id of [RM_A, RM_B, LINXUP]) ins.run(id, Date.now() - 60000);
}
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
	// The list is down AND one vehicle 500s: the refresh did not finish.
	{
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

(async () => {
	section("1. The known outage — a list 500 is a completed sync");
	for (const [l, a, e] of await outageChecks(SRC)) eq(a, e, l);

	section("2. Real failures stay failures — counted, 502, audited");
	for (const [l, a, e] of await failureChecks(SRC)) eq(a, e, l);

	section("3. A healthy list — unchanged");
	for (const [l, a, e] of await healthyChecks(SRC)) eq(a, e, l);

	section("4. Source pins");
	const lib = fs.readFileSync(path.join(ROOT, "lib", "routemate-client.js"), "utf8");
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "AdminToolsView.vue"), "utf8");
	eq([/runs\s*\/\/ routemateHydrateVehicleDetails\(\) on the CATCH path/.test(lib), /a 5xx from here as "list unavailable"/.test(lib)], [false, true],
		"pin: the listVehicles comment describes the list-unavailable path, not the old catch path");
	eq(/except 401\/403 \(our key refused\) and 429/i.test(lib), true, "pin: the getVehicle note no longer files a refused key as 'not a vehicle'");
	eq(/if \(r\.listUnavailable\) \{/.test(view) && /Vehicle list unavailable upstream; per-vehicle refresh done/.test(view), true,
		"pin: the admin toast reports the list-unavailable sync as done, not as an error");
	eq(SRC.includes('app.post("/api/admin/routemate/sync-now", requireRole("Super Admin"), routemateSyncNowHandler);'), true,
		"pin: sync-now is still Super Admin only, through the named handler");

	section("5. DISCRIMINATION — each mutant must flip an assertion");
	const failedLabels = (checks) => checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).map(([l]) => l);
	const mutateOnce = (from, to, id) => {
		const hits = SRC.split(from).length - 1;
		if (hits !== 1) throw new Error(`mutant ${id}: anchor must occur exactly once in server.js, found ${hits}`);
		return SRC.replace(from, () => to);
	};
	const MUTANTS = [
		["MB1", "every list error is 'unavailable'", "if (!(listErr && listErr.status >= 500 && listErr.status < 600)) throw listErr;", "",
			failureChecks, "401: a refused key IS a failed sync — error counted, lastSync not stamped"],
		["MB2", "the list 500 is a failure again", "listUnavailable = listErr;\n\t\t\t\tbreak;", "throw listErr;",
			outageChecks, "outage: a list 500 is NOT a failed sync"],
		["MB3", "the refresh runs twice", "const hydration = await routemateHydrateVehicleDetails(creds);", "await routemateHydrateVehicleDetails(creds);\n\t\tconst hydration = await routemateHydrateVehicleDetails(creds);",
			outageChecks, "outage: the list is asked once, and each vehicle ONCE"],
		["MB4", "the refresh runs on a real failure (the old catch path)", "logRoutemateSyncFailure(\"vehicles\", err);", "logRoutemateSyncFailure(\"vehicles\", err);\n\t\tawait routemateHydrateVehicleDetails(creds);",
			failureChecks, "401: the per-vehicle refresh does NOT run on a refused key"],
		["MB5", "a refused key files vehicles as 'not ours'", "if (status === 401 || status === 403 || status === 429) {", "if (false) {",
			failureChecks, "key refused mid-refresh: ⚠️ no real vehicle is filed as 'not ours'"],
		["MB6", "sync-now passes the upstream 401 through", "res.status(502).json({\n\t\t\terror: err.message || \"Routemate sync failed\",", "res.status(err.status === 401 || err.status === 403 ? err.status : 502).json({\n\t\t\terror: err.message || \"Routemate sync failed\",",
			failureChecks, "401: sync-now answers 502 (never the upstream 401 itself), naming it"],
		["MB7", "a failed sync leaves no audit row", "\t\tlogAudit(req, \"routemate_sync_failed\", \"vehicles\", \"\",", "\t\tvoid (req, \"routemate_sync_failed\", \"vehicles\", \"\",",
			failureChecks, "401: …and is audited as routemate_sync_failed"],
		["MB8", "the list-unavailable sync is not audited", "\t\t\tlogAudit(req, \"routemate_sync\", \"vehicles\", \"\",\n\t\t\t\t`Vehicle list unavailable upstream", "\t\t\tvoid (req, \"routemate_sync\", \"vehicles\", \"\",\n\t\t\t\t`Vehicle list unavailable upstream",
			outageChecks, "outage: …and leaves an audit row saying what happened"],
		["MB9", "the list-unavailable sync is not stamped", "routemateHealth.lastSync.vehicles = new Date().toISOString();", "if (!listUnavailable) routemateHealth.lastSync.vehicles = new Date().toISOString();",
			outageChecks, "outage: lastSync is stamped, and no error is counted"],
		["MB10", "a failed refresh passes as success", "if (hydration.failed > 0) {", "if (false) {",
			failureChecks, "refresh failure: a vehicle the refresh could not fetch fails the sync (502)"],
	];
	for (const [id, what, from, to, suite, mustFail] of MUTANTS) {
		let failedHere;
		try { failedHere = failedLabels(await suite(mutateOnce(from, to, id))); } catch (e) { failedHere = [`(crashed: ${e.message})`]; }		eq(failedHere.includes(mustFail), true, `MUTANT ${id}: ${what} → "${mustFail}" fails`);
	}

	console.log(`\n${"-".repeat(60)}`);
	if (fail) {
		console.log(`FAILED — ${pass} passed, ${fail} failed\n`);
		failures.forEach((f) => console.log(`  ${f}`));
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})().catch((e) => { console.error("FAIL  runner crashed:", (e && e.stack) || e); process.exit(1); });
