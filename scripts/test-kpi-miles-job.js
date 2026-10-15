#!/usr/bin/env node
/**
 * The KPI job's R10 phases, at the lib level:
 *   lib/kpi-ratecon-pass.js   one rate-con pass for the weight AND the miles
 *   lib/kpi-deadhead-routes.js  the distance-only route calls for deadhead
 *   lib/kpi-miles-data.js     what the metrics read from SQLite
 *
 * 20. the miles pass picks its own loads (no row under the current text rule,
 *     or a not_found / error row older than 30 days), including loads whose
 *     Details already state a weight;
 * 21. one download feeds both parsers; the weight keeps the newest file only;
 *     the miles parser reads the next-newest only after no_text / not_found
 *     (never after ok, none_stated, conflict or no_miles); at most 2 downloads;
 * 22. an 'error' row is written in each table the load is a candidate for
 *     before anything is fetched;
 * 23. the budget: 40 loads per business day across both tables, a load in both
 *     counted once, a second run the same day adds none past 40;
 * 24. a not_found / error answer is tried again after 30 days, not before;
 * 25. the one-off backfill takes its own, higher cap;
 * 26. route calls, with a fake fetch: a distance-only body and field mask, 0
 *     retries, a short timeout; nightly runs only; none with the flag off;
 *     replica mode: no request and no row; the same points twice one call, a
 *     change in the 4th decimal a new one, in the 5th none; equal points 0 mi
 *     with no call; 60 pairs make 50 calls on day 1 and 10 on day 2; a retried
 *     run the same day makes none past 50; a failure counts toward the cap and
 *     is retried after 30 days;
 * plus the gatherer: named columns only, loads keyed the way the sheet keys
 * them, and the route table read back.
 *
 * Hermetic: :memory: SQLite, fake sources, a fake fetch. No network, no files.
 *
 * Run: node scripts/test-kpi-miles-job.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
for (const f of ["kpi-ratecon-pass.js", "kpi-deadhead-routes.js", "kpi-miles-data.js"]) {
	if (!fs.existsSync(path.join(ROOT, "lib", f))) die(`lib/${f} does not exist`);
}
let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const PASS = require(path.join(ROOT, "lib", "kpi-ratecon-pass.js"));
const ROUTES = require(path.join(ROOT, "lib", "kpi-deadhead-routes.js"));
const DATA = require(path.join(ROOT, "lib", "kpi-miles-data.js"));
const DEADHEAD = require(path.join(ROOT, "lib", "kpi-deadhead.js"));
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
function t(cond, name, detail) {
	if (cond) pass++;
	else failures.push(detail === undefined ? name : `${name} (${detail})`);
}

// kpi_load_weights exactly as server.js makes it.
function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"\`]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
function freshDb() {
	const db = new Database(":memory:");
	db.exec(tableDdl("kpi_load_weights"));
	db.exec(alterDdl("kpi_load_weights", "text_rule"));
	PASS.ensureTables(db);
	ROUTES.ensureTables(db);
	return db;
}

const TZ = "America/New_York";
const DAY = 86400000;
const WEIGHT_RULE = 2;
const ROW = "Rate Details Service for Load Amount Rate Extended Line Haul - PER MILE 268 $1.80 $482.40 Fuel Surcharge - PER MILE 268 $0.75 $201.00 Empty Movement - PER MILE 45 $2.55 $114.75 Total: $798.15 Pickup at the shipper, deliver to the consignee, carrier load reference. Weight: 42,000 lbs";
const FLAT = "Rate confirmation for the carrier. Pickup at the shipper; deliver to the consignee. Load reference. Rate Detail Amount Rate Extended Line Haul 1.00 $900.00 $900.00 Total: $900.00 Weight: 41,000 lbs";
const NONE_STATED = "Rate confirmation for the carrier. Pickup at the shipper; deliver to the consignee. Load reference. Amount Rate Extended 333 333 $1.80 $0.75 $599.40 $249.75 Line Haul - PER MILE Fuel Surcharge - PER MILE Total: $849.15";
const CONFLICTED = "Rate confirmation for the carrier. Pickup at the shipper; deliver to the consignee. Load reference. Amount Rate Extended 300 310 $1.80 $1.80 $540.00 $558.00 Line Haul - PER MILE Line Haul - PER MILE Total: $1,098.00";
const GARBAGE = "\u0004t ?\u001c\u000fzó}yY5Ûåe*|÷àýjÕïïnmá1";

function loads(n, start, o) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const day = new Date(Date.UTC(2026, 8, 1 + i, 12)).toISOString().slice(0, 10);
		out.push({ loadId: String(start + i), status: "Delivered", day, detailsText: (o && o.details) || "General freight" });
	}
	return out;
}
// Fake sources: `files[loadId]` is a list of texts, newest first; a text
// becomes a "buffer" the fake reader hands back. Records every call.
function fakeSources(files, log, opts) {
	const o = opts || {};
	return (loadId, counter) => {
		let i = 0;
		const read = async () => {
			if (o.onFetch) o.onFetch(loadId);
			const list = files[loadId] || [];
			const text = list[i++];
			log.push({ loadId, op: "read", i });
			if (text === undefined) return null;
			if (text && typeof text === "object") return text;
			counter.driveFetches++;
			return { buffer: Buffer.from(text, "latin1"), fileId: `f-${loadId}-${i}`, fileSize: 1000 };
		};
		return { first: read, next: read };
	};
}
async function runPass(db, list, files, o) {
	const x = o || {};
	const log = [];
	const clock = { ms: x.nowMs || Date.parse("2026-10-14T08:10:00Z") };
	const out = await PASS.runRateconPass({
		db, loads: list, day: x.day || "2026-10-14", timeZone: TZ,
		deadlineMs: clock.ms + 60000, maxLoads: x.maxLoads || 40, weightTextRule: WEIGHT_RULE,
		openSources: fakeSources(files, log, { onFetch: x.onFetch }),
		readText: (buf) => buf.toString("latin1"),
		within: (p) => p, pause: async () => {}, now: () => clock.ms,
	});
	return { out, log };
}
const rowsOf = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY load_id`).all();
const one = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE load_id = ?`).get(id);

(async () => {
	// 20 / 21: candidates, one download, the second file.
	{
		const db = freshDb();
		const iso = new Date(Date.parse("2026-10-14T08:00:00Z") - 3 * DAY).toISOString();
		const w = db.prepare("INSERT INTO kpi_load_weights (load_id, weight_lb, source, status, file_id, file_size, checked_at, text_rule) VALUES (?, ?, 'ratecon_pdf', ?, '', NULL, ?, ?)");
		const m = db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, loaded_miles, empty_miles, status, file_id, file_size, checked_at, text_rule) VALUES (?, ?, ?, ?, '', NULL, ?, ?)");
		w.run("700001", 42000, "ok", iso, WEIGHT_RULE); // weight known, miles never read
		w.run("700002", 42000, "ok", iso, WEIGHT_RULE); m.run("700002", 268, 45, "ok", iso, PASS.MILES_TEXT_RULE); // both known
		m.run("700003", null, null, "no_text", iso, 0); // miles judged under an older rule
		const list = [
			...loads(1, 700001), ...loads(1, 700002), ...loads(1, 700003),
			...loads(1, 700004, { details: "Weight: 40,000 lbs" }), // Details state a weight: miles only
			...loads(1, 700005),
			{ loadId: "700006", status: "In Transit", day: "2026-09-20", detailsText: "" },
		];
		const files = { 700001: [ROW], 700003: [ROW], 700004: [ROW], 700005: [GARBAGE, NONE_STATED, FLAT] };
		const { log } = await runPass(db, list, files);
		const reads = (id) => log.filter((l) => l.loadId === id).length;
		t(reads("700001") === 1 && one(db, "kpi_load_ratecon_miles", "700001").status === "ok" && one(db, "kpi_load_weights", "700001").checked_at === iso,
			"20 a load whose weight is known but whose miles were never read is a miles candidate only", JSON.stringify(one(db, "kpi_load_ratecon_miles", "700001")));
		t(reads("700002") === 0, "20 a load with both answers on file is not read");
		t(reads("700003") === 1 && one(db, "kpi_load_ratecon_miles", "700003").text_rule === PASS.MILES_TEXT_RULE, "20 a miles row from an older text rule is read again");
		t(reads("700004") === 1 && !one(db, "kpi_load_weights", "700004") && one(db, "kpi_load_ratecon_miles", "700004").status === "ok",
			"20 Details that state a weight skip the weight phase, never the miles");
		t(reads("700006") === 0, "20 a load not yet delivered is not read");
		const r5w = one(db, "kpi_load_weights", "700005");
		const r5m = one(db, "kpi_load_ratecon_miles", "700005");
		t(r5w.status === "no_text" && r5w.file_id === "f-700005-1", "21 the weight keeps the newest file only (its no_text stands)", JSON.stringify(r5w));
		t(r5m.status === "none_stated" && r5m.loaded_miles === 333 && r5m.empty_miles === 0 && r5m.file_id === "f-700005-2",
			"21 the miles parser reads the next-newest file after no_text", JSON.stringify(r5m));
		t(reads("700005") === 2, "21 at most 2 downloads for one load", String(reads("700005")));
		const r1m = one(db, "kpi_load_ratecon_miles", "700001");
		t(r1m.loaded_miles === 268 && r1m.empty_miles === 45 && r1m.file_id === "f-700001-1" && /Z$/.test(r1m.checked_at), "21 the stated miles, the file id and an ISO stamp; no text kept", JSON.stringify(r1m));
		const both = freshDb();
		const shared = await runPass(both, loads(1, 710001), { 710001: [ROW] });
		t(shared.log.length === 1 && one(both, "kpi_load_weights", "710001").weight_lb === 42000 && one(both, "kpi_load_ratecon_miles", "710001").empty_miles === 45,
			"21 one download feeds both parsers", JSON.stringify(shared.log));
		for (const [label, text] of [["ok", ROW], ["none_stated", NONE_STATED], ["conflict", CONFLICTED], ["no_miles", FLAT]]) {
			const d = freshDb();
			const r = await runPass(d, loads(1, 720001), { 720001: [text, ROW] });
			t(r.log.length === 1 && one(d, "kpi_load_ratecon_miles", "720001").status === label, `21 no second file after ${label}`, JSON.stringify(r.log));
		}
		const nf = freshDb();
		const r = await runPass(nf, loads(1, 730001), { 730001: [] });
		t(r.log.length === 2 && one(nf, "kpi_load_ratecon_miles", "730001").status === "not_found" && one(nf, "kpi_load_weights", "730001").status === "not_found",
			"21 nothing found: the next source is tried once, then not_found in both tables", JSON.stringify(r.log));
		const big = freshDb();
		const rb = await runPass(big, loads(1, 740001), { 740001: [{ status: "too_large", fileId: "f-big", fileSize: 5e6 }, ROW] });
		t(rb.log.length === 1 && one(big, "kpi_load_ratecon_miles", "740001").status === "too_large" && one(big, "kpi_load_ratecon_miles", "740001").file_size === 5e6,
			"21 a file over the size cap: too_large, no second file", JSON.stringify(rb.log));
	}

	// 22: the error row before the fetch.
	{
		const db = freshDb();
		const seen = [];
		await runPass(db, loads(2, 750001), { 750001: [ROW], 750002: [ROW] }, {
			onFetch: (id) => seen.push([id, (one(db, "kpi_load_weights", id) || {}).status, (one(db, "kpi_load_ratecon_miles", id) || {}).status]),
		});
		t(seen.length === 2 && seen.every(([, w, m]) => w === "error" && m === "error"), "22 each table the load is a candidate for holds 'error' when its rate con is fetched", JSON.stringify(seen));
		const crash = freshDb();
		const log = [];
		const res = await PASS.runRateconPass({
			db: crash, loads: loads(1, 760001), day: "2026-10-14", timeZone: TZ, deadlineMs: Date.now() + 60000, maxLoads: 40, weightTextRule: WEIGHT_RULE,
			openSources: () => ({ first: async () => { log.push("first"); throw new Error("Drive down near Zed Sentinel"); }, next: async () => null }),
			readText: (b) => b.toString(), within: (p) => p, pause: async () => {}, now: () => Date.now(),
		});
		t(one(crash, "kpi_load_ratecon_miles", "760001").status === "error" && one(crash, "kpi_load_weights", "760001").status === "error" && res.codes.has("RATECON_FETCH_FAILED"),
			"22 a failed fetch leaves 'error' rows and a code", JSON.stringify([...res.codes]));
		t(!JSON.stringify(rowsOf(crash, "kpi_load_ratecon_miles")).includes("Sentinel") && ![...res.codes].some((c) => /Sentinel/.test(c)), "22 the error's text is stored nowhere");
	}

	// 23: the shared budget.
	{
		const db = freshDb();
		const today = "2026-10-14T05:00:00.000Z"; // 1:00 AM Eastern on the 14th
		const yesterday = "2026-10-14T03:30:00.000Z"; // 11:30 PM Eastern on the 13th
		const w = db.prepare("INSERT INTO kpi_load_weights (load_id, weight_lb, source, status, file_id, file_size, checked_at, text_rule) VALUES (?, NULL, 'ratecon_pdf', 'no_weight', '', NULL, ?, 2)");
		const m = db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, loaded_miles, empty_miles, status, file_id, file_size, checked_at, text_rule) VALUES (?, NULL, NULL, 'no_miles', '', NULL, ?, ?)");
		for (let i = 0; i < 10; i++) w.run(String(800001 + i), today);
		for (let i = 0; i < 5; i++) m.run(String(800001 + i), today, PASS.MILES_TEXT_RULE);
		for (let i = 0; i < 5; i++) m.run(String(800101 + i), today, PASS.MILES_TEXT_RULE);
		for (let i = 0; i < 7; i++) w.run(String(800201 + i), yesterday);
		t(PASS.checkedToday(db, "2026-10-14", TZ, Date.parse("2026-10-14T08:10:00Z")) === 15, "23 loads checked today, counted once across both tables (yesterday's not counted)",
			String(PASS.checkedToday(db, "2026-10-14", TZ, Date.parse("2026-10-14T08:10:00Z"))));
		const files = {};
		for (let i = 0; i < 60; i++) files[String(900001 + i)] = [ROW];
		const first = await runPass(db, loads(60, 900001), files);
		t(first.out.checked === 25 && first.log.length === 25, "23 40 a business day: 15 already checked leaves 25", String(first.out.checked));
		const again = await runPass(db, loads(60, 900001), files, { nowMs: Date.parse("2026-10-14T20:00:00Z") });
		t(again.out.checked === 0 && again.log.length === 0, "23 a second run the same business day adds none past 40", String(again.out.checked));
		const tomorrow = await runPass(db, loads(60, 900001), files, { nowMs: Date.parse("2026-10-15T08:10:00Z"), day: "2026-10-15" });
		t(tomorrow.out.checked === 35, "23 the next business day takes the rest", String(tomorrow.out.checked));
		const order = freshDb();
		const o = await runPass(order, loads(45, 910001), Object.fromEntries(loads(45, 910001).map((l) => [l.loadId, [ROW]])));
		const done = rowsOf(order, "kpi_load_ratecon_miles").map((r) => r.load_id);
		t(done.length === 40 && !done.includes("910001") && done.includes("910045"), "23 newest loads first", `${o.out.checked} ${done[0]}..${done[done.length - 1]}`);
	}

	// 24: retry after 30 days.
	{
		const db = freshDb();
		const now = Date.parse("2026-10-14T08:10:00Z");
		const m = db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, loaded_miles, empty_miles, status, file_id, file_size, checked_at, text_rule) VALUES (?, NULL, NULL, ?, '', NULL, ?, ?)");
		m.run("950001", "not_found", new Date(now - 31 * DAY).toISOString(), PASS.MILES_TEXT_RULE);
		m.run("950002", "not_found", new Date(now - 5 * DAY).toISOString(), PASS.MILES_TEXT_RULE);
		m.run("950003", "error", new Date(now - 31 * DAY).toISOString(), PASS.MILES_TEXT_RULE);
		m.run("950004", "error", new Date(now - 29 * DAY).toISOString(), PASS.MILES_TEXT_RULE);
		m.run("950005", "no_text", new Date(now - 90 * DAY).toISOString(), PASS.MILES_TEXT_RULE);
		const w = db.prepare("INSERT INTO kpi_load_weights (load_id, weight_lb, source, status, file_id, file_size, checked_at, text_rule) VALUES (?, 42000, 'ratecon_pdf', 'ok', '', NULL, ?, 2)");
		for (let i = 1; i <= 5; i++) w.run(String(950000 + i), new Date(now - 90 * DAY).toISOString());
		const { log } = await runPass(db, loads(5, 950001), Object.fromEntries(loads(5, 950001).map((l) => [l.loadId, [ROW]])));
		const read = [...new Set(log.map((l) => l.loadId))].sort();
		t(read.join() === "950001,950003", "24 not_found and error are tried again after 30 days, not before; no_text under the current rule is final", read.join());
	}

	// 25: the backfill's own cap.
	{
		const db = freshDb();
		const files = Object.fromEntries(loads(250, 960001).map((l) => [l.loadId, [ROW]]));
		const b = await runPass(db, loads(250, 960001), files, { maxLoads: PASS.BACKFILL_MAX_LOADS });
		t(PASS.BACKFILL_MAX_LOADS === 200 && b.out.checked === 200, "25 the one-off backfill reads up to 200 loads", String(b.out.checked));
		t(PASS.NIGHTLY_MAX_LOADS === 40, "25 ...the nightly runs 40");
	}

	// 26: route calls.
	{
		const p = (lat1, lng1, lat2, lng2) => ({ pairKey: DEADHEAD.pairKey({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }), from: { lat: lat1, lng: lng1 }, to: { lat: lat2, lng: lng2 } });
		const fakeFetch = (log, answer) => async (url, init) => {
			log.push({ url, init });
			if (answer === "hang") return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
			if (answer === "fail") return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
			return { ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 160934.4 }] }) };
		};
		const call = (db, pending, o) => {
			const x = o || {};
			return ROUTES.runRouteCalls({
				db, pending, kind: x.kind || "nightly", enabled: x.enabled !== false, replica: !!x.replica, apiKey: "test-key",
				fetchFn: x.fetch, day: x.day || "2026-10-14", timeZone: TZ, now: () => x.nowMs || Date.parse("2026-10-14T08:10:00Z"), timeoutMs: x.timeoutMs,
			});
		};
		{
			const db = freshDb();
			const log = [];
			const res = await call(db, [p(29.76043, -95.3698, 32.77666, -96.79699)], { fetch: fakeFetch(log) });
			const init = log[0] && log[0].init;
			const body = init ? JSON.parse(init.body) : {};
			t(log.length === 1 && log[0].url === "https://routes.googleapis.com/directions/v2:computeRoutes" && init.method === "POST", "26 one POST to computeRoutes");
			t(init && init.headers["X-Goog-FieldMask"] === "routes.distanceMeters" && init.headers["X-Goog-Api-Key"] === "test-key", "26 the field mask asks for the distance only", JSON.stringify(init && init.headers));
			t(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["destination", "origin", "travelMode"]) && body.travelMode === "DRIVE"
				&& body.origin.location.latLng.latitude === 29.7604 && body.destination.location.latLng.longitude === -96.797,
				"26 a distance-only body: the two rounded points, no alternatives, no traffic, no polyline", init && init.body);
			t(init && init.signal && typeof init.signal.aborted === "boolean", "26 the request carries an abort signal");
			const row = db.prepare("SELECT * FROM kpi_deadhead_routes").get();
			t(row && row.status === "ok" && row.distance_miles === 100 && row.pair_key === "29.7604,-95.3698>32.7767,-96.797" && /Z$/.test(row.checked_at)
				&& JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["checked_at", "distance_miles", "pair_key", "status"]), "26 the cache row: points, miles, status, stamp; no load id", JSON.stringify(row));
			t(res.calls === 1 && res.ok === 1, "26 the result counts the call", JSON.stringify(res));
			t(ROUTES.TIMEOUT_MS <= 10000, "26 a short timeout", String(ROUTES.TIMEOUT_MS));
		}
		{
			const db = freshDb();
			const log = [];
			await call(db, [p(30, -95, 31, -96)], { fetch: fakeFetch(log, "fail") });
			t(log.length === 1 && db.prepare("SELECT status FROM kpi_deadhead_routes").get().status === "failed", "26 a failed answer: one call (0 retries), stored failed");
			const hangLog = [];
			const started = Date.now();
			await call(db, [p(31, -95, 32, -96)], { fetch: fakeFetch(hangLog, "hang"), timeoutMs: 50 });
			t(Date.now() - started < 2000 && db.prepare("SELECT status FROM kpi_deadhead_routes WHERE pair_key = ?").get(DEADHEAD.pairKey({ lat: 31, lng: -95 }, { lat: 32, lng: -96 })).status === "failed",
				"26 a call that hangs is cut off at the timeout and stored failed");
		}
		{
			for (const [label, o] of [["a boot run", { kind: "boot" }], ["a manual run", { kind: "manual" }], ["the flag off", { enabled: false }], ["replica mode", { replica: true }]]) {
				const db = freshDb();
				const log = [];
				const res = await call(db, [p(30, -95, 31, -96)], { ...o, fetch: fakeFetch(log) });
				t(log.length === 0 && db.prepare("SELECT COUNT(*) AS n FROM kpi_deadhead_routes").get().n === 0 && res.calls === 0, `26 ${label}: no request, no row`, JSON.stringify(res));
			}
		}
		{
			const db = freshDb();
			const log = [];
			await call(db, [p(30.12341, -95, 31, -96), p(30.12341, -95, 31, -96)], { fetch: fakeFetch(log) });
			await call(db, [p(30.12344, -95, 31, -96)], { fetch: fakeFetch(log), nowMs: Date.parse("2026-10-14T09:00:00Z") });
			t(log.length === 1, "26 the same points twice, and a change in the 5th decimal: one call", String(log.length));
			await call(db, [p(30.1235, -95, 31, -96)], { fetch: fakeFetch(log) });
			t(log.length === 2, "26 a change in the 4th decimal: a new call", String(log.length));
			const chain = DEADHEAD.computeDeadhead([
				{ key: "zed-a", status: "Delivered", day: "2026-09-01", eldTruckId: "1", pickupArriveMs: Date.parse("2026-09-01T10:00:00Z"), destArriveMs: Date.parse("2026-09-01T15:00:00Z"), originLat: 29, originLng: -94, destLat: 30, destLng: -95 },
				{ key: "zed-b", status: "Delivered", day: "2026-09-02", eldTruckId: "1", pickupArriveMs: Date.parse("2026-09-02T10:00:00Z"), destArriveMs: Date.parse("2026-09-02T15:00:00Z"), originLat: 30.00001, originLng: -95, destLat: 31, destLng: -96 },
			], { timeZone: TZ, routes: new Map() });
			t(chain.pending.length === 0 && chain.byKey.get("zed-b").deadheadMiles === 0, "26 equal points after rounding: 0 mi, no call");
		}
		{
			const db = freshDb();
			const log = [];
			const pairs = [];
			for (let i = 0; i < 60; i++) pairs.push(p(30 + i / 100, -95, 31, -96));
			const d1 = await call(db, pairs, { fetch: fakeFetch(log) });
			t(log.length === 50 && d1.calls === 50, "26 60 pairs: 50 calls on day 1", String(log.length));
			await call(db, pairs, { fetch: fakeFetch(log), nowMs: Date.parse("2026-10-14T21:00:00Z") });
			t(log.length === 50, "26 a retried run the same business day makes none past 50", String(log.length));
			await call(db, pairs, { fetch: fakeFetch(log), day: "2026-10-15", nowMs: Date.parse("2026-10-15T08:10:00Z") });
			t(log.length === 60, "26 day 2 makes the other 10", String(log.length));
		}
		{
			const db = freshDb();
			const log = [];
			const pairs = [];
			for (let i = 0; i < 50; i++) pairs.push(p(40 + i / 100, -95, 31, -96));
			await call(db, pairs, { fetch: fakeFetch(log, "fail") });
			const more = await call(db, [p(45, -95, 31, -96)], { fetch: fakeFetch(log), nowMs: Date.parse("2026-10-14T10:00:00Z") });
			t(log.length === 50 && more.calls === 0, "26 failed calls count toward the cap", String(log.length));
			await call(db, pairs, { fetch: fakeFetch(log), day: "2026-11-10", nowMs: Date.parse("2026-11-10T09:00:00Z") });
			t(log.length === 50, "26 a failed pair is not retried before 30 days", String(log.length));
			await call(db, pairs.slice(0, 3), { fetch: fakeFetch(log), day: "2026-11-14", nowMs: Date.parse("2026-11-14T09:00:00Z") });
			t(log.length === 53 && db.prepare("SELECT COUNT(*) AS n FROM kpi_deadhead_routes WHERE status = 'ok'").get().n === 3, "26 ...and is retried after 30 days", String(log.length));
		}
		t(ROUTES.routesEnabled(undefined) === false && ROUTES.routesEnabled("") === false && ROUTES.routesEnabled("false") === false
			&& ROUTES.routesEnabled("true") === true && ROUTES.routesEnabled(" ON ") === true && ROUTES.routesEnabled("1") === true && ROUTES.routesEnabled("yes") === true,
			"26 KPI_DEADHEAD_ROUTES_ENABLED defaults off; only true/1/yes/on turn it on");
	}

	// Review fixes: the pairs the job asks for (lib/kpi-miles.js pendingRoutePairs()).
	//  - Medium: a failed route stays pending, so the 30-day retry can run (it
	//    was dropped as "cached" and never asked again);
	//  - Low 3: only pairs the mile metrics can use (a delivered load whose truck
	//    has ELD records that day), newest first.
	{
		const MILES = require(path.join(ROOT, "lib", "kpi-miles.js"));
		const at = (iso) => Date.parse(iso);
		const ld = (key, day, status, o) => ({
			key, status, day, driverKey: "", truckKey: "", pickupText: "", dropoffText: "", completionText: "",
			eldTruckId: "1", pickupArriveMs: at(`${day}T10:00:00Z`), destArriveMs: at(`${day}T15:00:00Z`),
			laneMiles: null, rateconStatus: null, statedLoadedMiles: null, statedEmptyMiles: null, ...o,
		});
		const milesLoads = [
			ld("zed-a", "2026-09-01", "Delivered", { originLat: 29, originLng: -94, destLat: 30, destLng: -95 }),
			ld("zed-b", "2026-09-02", "Delivered", { originLat: 30.5, originLng: -95.5, destLat: 31, destLng: -96 }),
			ld("zed-c", "2026-09-03", "Delivered", { originLat: 31.5, originLng: -96.5, destLat: 32, destLng: -97 }),
			ld("zed-d", "2026-09-04", "In Transit", { originLat: 32.5, originLng: -97.5, destLat: 33, destLng: -98 }),
			ld("zed-e", "2026-05-02", "Delivered", { originLat: 20, originLng: -90, destLat: 21, destLng: -91 }),
			ld("zed-f", "2026-05-03", "Delivered", { originLat: 21.5, originLng: -91.5, destLat: 22, destLng: -92 }),
			ld("zed-g", "2025-06-01", "Delivered", { originLat: 10, originLng: -80, destLat: 11, destLng: -81 }),
			ld("zed-h", "2025-06-02", "Delivered", { originLat: 11.5, originLng: -81.5, destLat: 12, destLng: -82 }),
		];
		const eldRows = [];
		for (let d = 1; d <= 30; d++) eldRows.push({ truckId: "1", day: `2026-09-${String(d).padStart(2, "0")}`, miles: 300 });
		const ab = DEADHEAD.pairKey({ lat: 30, lng: -95 }, { lat: 30.5, lng: -95.5 });
		const bc = DEADHEAD.pairKey({ lat: 31, lng: -96 }, { lat: 31.5, lng: -96.5 });
		const nowMs = at("2026-10-14T08:10:00Z");
		const routes = new Map([
			[ab, { status: "failed", distanceMiles: null, checkedAt: new Date(nowMs - 75 * DAY).toISOString() }],
			[bc, { status: "failed", distanceMiles: null, checkedAt: new Date(nowMs - 5 * DAY).toISOString() }],
		]);
		const pending = MILES.pendingRoutePairs({ milesLoads, timeZone: TZ, eldRows, routes, truckIdByUnit: new Map(), truckAt: null });
		t(pending.map((p) => p.pairKey).join("|") === `${bc}|${ab}`,
			"Medium + Low 3: both failed pairs stay pending, only pairs ending at a delivered load on an ELD truck-day, newest first", JSON.stringify(pending.map((p) => p.pairKey)));
		const db = freshDb();
		const ins = db.prepare("INSERT INTO kpi_deadhead_routes (pair_key, distance_miles, status, checked_at) VALUES (?, NULL, 'failed', ?)");
		ins.run(ab, new Date(nowMs - 75 * DAY).toISOString());
		ins.run(bc, new Date(nowMs - 5 * DAY).toISOString());
		const log = [];
		const res = await ROUTES.runRouteCalls({
			db, pending, kind: "nightly", enabled: true, replica: false, apiKey: "test-key", day: "2026-10-14", timeZone: TZ, now: () => nowMs,
			fetchFn: async (url, init) => { log.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ routes: [{ distanceMeters: 16093.44 }] }) }; },
		});
		t(res.calls === 1 && log.length === 1 && log[0].origin.location.latLng.latitude === 30 && db.prepare("SELECT status FROM kpi_deadhead_routes WHERE pair_key = ?").get(ab).status === "ok"
			&& db.prepare("SELECT status FROM kpi_deadhead_routes WHERE pair_key = ?").get(bc).status === "failed",
			"Medium: through the job, a 75-day-old failure is asked again and a 5-day-old one waits", JSON.stringify(res));
		t(MILES.pendingRoutePairs({ milesLoads, timeZone: TZ, routes: new Map() }).length === 0, "Low 3: with no ELD records given, no pair is usable");
	}

	// Review Low 2 (lib half): the route phase has its own time budget; once it
	// is spent no further call starts, and the run is told so.
	{
		const db = freshDb();
		const clock = { ms: Date.parse("2026-10-14T08:10:00Z") };
		const start = clock.ms;
		const pairs = [];
		for (let i = 0; i < 5; i++) pairs.push({ pairKey: DEADHEAD.pairKey({ lat: 40 + i, lng: -95 }, { lat: 31, lng: -96 }), from: { lat: 40 + i, lng: -95 }, to: { lat: 31, lng: -96 } });
		const log = [];
		const res = await ROUTES.runRouteCalls({
			db, pending: pairs, kind: "nightly", enabled: true, replica: false, apiKey: "test-key", day: "2026-10-14", timeZone: TZ,
			now: () => clock.ms, deadlineMs: start + 8000,
			fetchFn: async () => { log.push(clock.ms); clock.ms += 5000; return { ok: true, json: async () => ({ routes: [{ distanceMeters: 1609.344 }] }) }; },
		});
		t(log.length === 2 && res.calls === 2 && res.codes.has("ROUTES_TIME_LIMIT"), `Low 2: an 8 s budget at 5 s a call starts 2 calls, then stops with ROUTES_TIME_LIMIT (${log.length}, ${[...res.codes]})`);
		t(db.prepare("SELECT COUNT(*) AS n FROM kpi_deadhead_routes").get().n === 2, "Low 2: no row is written for a pair that was never called");
	}

	// The gatherer.
	{
		const db = freshDb();
		db.exec(tableDdl("load_eld_miles"));
		db.exec(tableDdl("load_coordinates"));
		db.exec(alterDdl("load_coordinates", "distance_miles"));
		db.exec(tableDdl("load_ratecon_miles"));
		db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT)");
		db.prepare("INSERT INTO load_eld_miles (load_id, truck_id, pickup_arrive_ms, dest_arrive_ms, loaded_miles) VALUES (?, ?, ?, ?, ?)").run("l-1", 7, 1000, 2000, 900);
		db.prepare("INSERT INTO load_eld_miles (load_id, truck_id, pickup_arrive_ms, dest_arrive_ms) VALUES (?, ?, ?, ?)").run("l-2", 0, 0, 0);
		db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, pickup_address) VALUES (?, ?, ?, ?, ?, ?)").run("#L-1", 29.7, -95.3, 32.7, -96.8, "1 Zed Sentinel Way");
		db.prepare("INSERT INTO load_ratecon_miles (load_id, miles, match) VALUES (?, ?, ?)").run("l-1", 486, "lane");
		db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, loaded_miles, empty_miles, status, file_id, file_size, checked_at, text_rule) VALUES ('l-1', 480, 40, 'ok', 'f', 10, 'x', 1)").run();
		db.prepare("INSERT INTO kpi_deadhead_routes (pair_key, distance_miles, status, checked_at) VALUES ('1,2>3,4', 55.5, 'ok', 'x')").run();
		db.prepare("INSERT INTO trucks (id, unit_number, status) VALUES (7, ' 101 ', 'Active')").run();
		const g = DATA.gatherMilesData(db);
		const sheet = [
			{ loadId: "l-1", status: "Delivered", day: "2026-09-10", driverKey: "zed sentinel", truckKey: "101", pickupText: "9/9/2026 08:00", dropoffText: "9/10/2026", completionText: "2026-09-10" },
			{ loadId: "l-2", status: "Delivered", day: "2026-09-11", driverKey: "", truckKey: "", pickupText: "", dropoffText: "", completionText: "" },
			{ loadId: "", status: "Delivered", day: "2026-09-12" },
		];
		const milesLoads = DATA.assembleMilesLoads(sheet, g);
		const a = milesLoads.find((l) => l.key === "l-1");
		t(milesLoads.length === 2 && a.eldTruckId === "7" && a.pickupArriveMs === 1000 && a.destArriveMs === 2000 && a.originLat === 29.7 && a.destLng === -96.8,
			"gather: ELD truck and instants, and the coordinates of a '#'-keyed row", JSON.stringify(a));
		t(a.laneMiles === 486 && a.rateconStatus === "ok" && a.statedLoadedMiles === 480 && a.statedEmptyMiles === 40, "gather: lane miles and the stated miles", JSON.stringify(a));
		const b = milesLoads.find((l) => l.key === "l-2");
		t(b.eldTruckId === "" && b.pickupArriveMs === null && b.destArriveMs === null && b.laneMiles === null && b.rateconStatus === null, "gather: 0 is 'not observed', nothing on file is null", JSON.stringify(b));
		t(g.truckIdByUnit.get("101") === "7" && g.routes.get("1,2>3,4").distanceMiles === 55.5, "gather: the unit map (trimmed, lowercased) and the route cache");
		t(!JSON.stringify([...g.coords.values()]).includes("Sentinel"), "gather: no address is read");
		const dataSrc = fs.readFileSync(path.join(ROOT, "lib", "kpi-miles-data.js"), "utf8");
		t(!/SELECT \*/i.test(dataSrc), "gather: named columns only");
	}

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
