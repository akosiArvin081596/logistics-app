#!/usr/bin/env node
// lib/chr-sweep.js: the recorder that reads load_status_history above its cursor,
// the effective-mode rule, and the Dry-run pipeline with no transport (R5 PR 1a:
// plan 4.2, 4.8, 4.10). Run here over in-memory SQLite with a made-up Job
// Tracking reader; nothing in the app calls the module yet.
//
//   §1  the master switch off (or a replica): no table, no row, no sheet read
//   §2  the effective mode and its changes
//   §3  the first enable: a baseline, so no old row is ever recorded
//   §4  recording after the baseline; an idle tick reads no sheet
//   §5  a quick restart loses nothing; a long stop (heartbeat over 15 minutes)
//       baselines again, with one audit row
//   §6  the page's mode: Off skips pending rows; back on, a baseline
//   §7  the cursor and the inserts commit together; replays add nothing
//   §8  a failed sheet read keeps the cursor and records nothing
//   §9  the Dry-run pipeline: settle, the CHR-load test again, holds,
//       multi-stop, the arrival switch, the proximity test, the payload; each
//       row ends dry_run, held or skipped, and nothing reaches the network
//   §10 reverts: pending rows become skipped_backwards; a dry-run row is flagged
//   §11 the canary: made-up person data and a protected number planted in the
//       history, the sheet and the settings reach no row, state, audit or log
//   §12 the source: lib/chr-*.js has no Sheets write, Drive, mail or n8n; its
//       SQL names neither actor nor reason; no SELECT *
//   §13 a protected number inside a load key is withheld on all four paths (a
//       9-digit Load ID, one that is not, a blank or unreadable Email, a load
//       missing from Job Tracking): no table, audit, log or result holds it
//
// Made-up data only. In-memory SQLite; every network call is refused and counted.
//   node scripts/test-chr-sweep.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const W = require(path.join(ROOT, "lib", "chr-sweep.js"));
const I = require(path.join(ROOT, "lib", "chr-integration.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

// Every way out of this machine is refused and counted while the runner runs.
let networkCalls = 0;
const refuse = () => { networkCalls++; throw new Error("network refused in test-chr-sweep"); };
globalThis.fetch = refuse;
http.request = refuse; http.get = refuse; https.request = refuse; https.get = refuse;
net.connect = refuse; net.createConnection = refuse; tls.connect = refuse;

const MIN = 60 * 1000;
const CANARY = Object.freeze({
	name: "Canary Testdriver", phone: "(555) 555-0147", email: "canary.agent@example.test", ssn: "000-12-3456",
	cdl: "CDL D0000001", dob: "01/02/1970", street: "742 Evergreen Terrace", money: "$1,234.56", carrier: "77700011122233",
	note: "canary internal note",
});
const PICKUP = { latitude: 42.0347, longitude: -93.62 };
const DROP = { latitude: 41.525, longitude: -88.0817 };
const AT_PICKUP = { lat: 42.035, lng: -93.6195 };
const OUTSIDE = { lat: 42.08, lng: -93.62 };
const AT_DROP = { lat: 41.5252, lng: -88.0815 };
const FAR_285 = { lat: 37.9, lng: -93.62 };
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Broker Contact Name", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment"];

// A made-up world: the server's tables, a Job Tracking reader, resolvers and a clock.
// Each made-up driver holds one truck, and each truck carries device RM-TEST-<truck id>.
const TRUCKS = Object.freeze({
	[CANARY.name.toLowerCase()]: { truck_id: 1, unit: "T-101", vid: "" },
	"driver two": { truck_id: 2, unit: "T-102", vid: "" },
	"driver three": { truck_id: 3, unit: "T-103", vid: "" },
});
function world({ config = { updatesEnabled: true }, settings = null, sheetRows = [], points = {}, instructions = {}, trucks = TRUCKS } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, bearing TEXT DEFAULT '', odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0, fuel_pct INTEGER,
			geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
	`);
	if (settings) S.writeSettings(db, { ...S.DEFAULT_SETTINGS, ...settings }, { by: "admin.one", nowIso: "2026-11-02T14:00:00.000Z" });
	const w = {
		db, clock: Date.parse("2026-11-02T15:00:00Z"), sheetReads: 0, sheetFails: false, audits: [], logs: [], changes: 0, sheetRows,
	};
	const cfg = I.chrConfig(config);
	const deps = {
		db,
		config: cfg,
		readSheet: async () => {
			w.sheetReads++;
			if (w.sheetFails) throw new Error(`sheet read failed for ${CANARY.email}`);
			return new Map(w.sheetRows.map((r) => { const p = E.projectRow(r, HEADERS); return [p.loadKey, p]; }));
		},
		stopPointsFor: (key) => points[key] || null,
		truckResolver: () => ({ forDriverAt: (name, ms) => (Number.isFinite(ms) ? trucks[String(name || "").trim().toLowerCase()] || null : null) }),
		deviceResolver: () => ({ vehicleForTruckAt: (id) => ([1, 2, 3].includes(id) ? `RM-TEST-${id}` : "") }),
		instructionStopsFor: (key) => instructions[key] || null,
		logAudit: (actor, action, entity, entityId, details) => w.audits.push({ user: actor.session.user, action, entity, entityId, details }),
		onChange: () => { w.changes++; },
		now: () => w.clock,
		log: { info: (...a) => w.logs.push(a.join(" ")), warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) },
	};
	w.integration = I.create(deps);
	w.tick = () => w.integration.sweep();
	w.at = (iso) => { w.clock = Date.parse(iso); };
	w.advance = (min) => { w.clock += min * MIN; };
	// The timer ticks every minute; a jump of more than 15 minutes with no tick is a long stop.
	w.runFor = async (min) => { for (let i = 0; i < min; i++) { w.advance(1); await w.tick(); } };
	w.stamp = () => new Date(w.clock).toISOString().slice(0, 19).replace("T", " ");
	w.history = (loadId, status, source = "manual") => db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, reason) VALUES (?, '', ?, ?, ?, ?, ?)")
		.run(String(loadId).toLowerCase().replace(/^#/, ""), status, source, `${CANARY.name} ${CANARY.phone}`, w.stamp(), `${CANARY.note} ${CANARY.ssn}`).lastInsertRowid;
	w.ping = (offsetMin, at, over = {}) => db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source, geocoded_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(over.device || "RM-TEST-1", at.lat, at.lng, over.speed || 0, w.clock + offsetMin * MIN, over.dropped || "", over.source === undefined ? "routemate" : over.source, `${CANARY.street}, Ames, IA`);
	w.events = () => db.prepare("SELECT load_id, event, stop_kind, stop_index, status, hold_reason, skip_reason, verify, mode, reverted_at FROM chr_events ORDER BY id").all();
	w.state = () => S.readState(db);
	return w;
}
const sheetRow = (loadId, over = {}) => ({
	"Load ID": loadId, Status: "In Transit", Driver: CANARY.name, Email: "made-up.agent@chrobinson.com", "Broker Contact Name": CANARY.name,
	"Trailer Number": "53001", "Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: CANARY.money, ...over,
});
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chr_%' ORDER BY name").all().map((r) => r.name);
const brief = (w) => w.events().map((e) => `${e.load_id}:${e.event}:${e.status}${e.hold_reason ? `:${e.hold_reason}` : ""}${e.skip_reason ? `:${e.skip_reason}` : ""}`);

async function main() {
	// ---------------------------------------------------------------- §1
	section("§1  the master switch off");
	for (const [label, config] of [["off", {}], ["off (a string is not a switch)", { updatesEnabled: "true" }], ["a replica", { updatesEnabled: true, sendEnabled: true, replica: true }]]) {
		const w = world({ config, sheetRows: [sheetRow("123456789")] });
		w.history("123456789", "At Shipper");
		const res = await w.tick();
		eq(res.ran, false, `§1 ${label}: the sweep does not run`);
		eq([tables(w.db), w.sheetReads, w.audits.length, w.db.prepare("SELECT COUNT(*) AS n FROM server_state").get().n], [[], 0, 0, 0], `§1 ${label}: no chr_ table, no sheet read, no audit, no state`);
	}

	// ---------------------------------------------------------------- §2
	section("§2  the effective mode");
	const cfgOn = I.chrConfig({ updatesEnabled: true });
	const cfgSend = I.chrConfig({ updatesEnabled: true, sendEnabled: true, locationEnabled: true });
	const set = (over) => ({ ...S.DEFAULT_SETTINGS, ...over });
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: I.chrConfig({}) }), "off", "§2 master switch off: off, whatever the page says");
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "off" }), config: cfgSend }), "off", "§2 the page's Off: off");
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "dry_run" }), config: cfgSend, transportReady: true }), "dry_run", "§2 the page's Dry run: dry run");
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: cfgOn, transportReady: true }), "dry_run", "§2 Live without the send switch: dry run");
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: cfgSend }), "dry_run", "§2 Live with no transport (none exists in PR 1a): dry run");
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: cfgSend, transportReady: true }), "live", "§2 Live, the send switch and a transport: live");
	eq(W.effectiveMode("location", { settings: set({ location: "dry_run" }), config: cfgOn }), "off", "§2 location without its server switch: off");
	eq(W.effectiveMode("location", { settings: set({ location: "dry_run" }), config: cfgSend }), "dry_run", "§2 location with it: the page's mode");
	eq([W.modeChange("", "dry_run"), W.modeChange("off", "live"), W.modeChange("dry_run", "off"), W.modeChange("live", "dry_run"), W.modeChange("live", "off"), W.modeChange("dry_run", "live"), W.modeChange("dry_run", "dry_run")],
		["start", "start", "stop", "live_dropped", "stop", null, null], "§2 the changes: start, stop, a drop out of Live; a rise to Live is no change (it sends nothing old)");
	eq([W.SWEEP_INTERVAL_MS, W.HEARTBEAT_GAP_MS, W.HISTORY_BATCH], [60 * 1000, 15 * MIN, 500], "§2 a tick a minute, a 15-minute heartbeat gap (A14), 500 history rows a tick");

	// ---------------------------------------------------------------- §3
	section("§3  the first enable");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		w.history("123456789", "Dispatched", "dispatch");
		w.history("123456789", "At Shipper");
		w.history("123456789", "In Transit");
		const res = await w.tick();
		eq([res.ran, res.mode, res.baseline], [true, "dry_run", "first_enable"], "§3 the first tick runs in Dry run and baselines");
		eq(tables(w.db), ["chr_events", "chr_loads"], "§3 the tables exist once the switch is on");
		eq([w.state().cursor, w.state().baselineId, w.events().length], [3, 3, 0], "§3 the cursor jumps past the old rows; none is recorded");
		eq(w.audits.map((a) => [a.action, a.entity, a.entityId, a.user.role, a.user.id]), [["chr_baseline", "chr", "milestone", "system", 0]], "§3 one system audit row");
		const firstAudit = String((w.audits[0] || {}).details || "");
		ok(/first enable/.test(firstAudit) && /0 pending/.test(firstAudit), "§3 ...naming why and how many pending rows it skipped");
		eq(w.sheetReads, 0, "§3 nothing to record: no sheet read");
		ok(w.state().firstEnabledAt && w.state().lastTickAt && w.state().lastMode === "dry_run", "§3 the state: first enabled, heartbeat, mode");
	}

	// ---------------------------------------------------------------- §4
	section("§4  recording after the baseline");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(1);
		const h = w.history("#123456789", "At Shipper");
		w.advance(1);
		const res = await w.tick();
		eq([res.recorded, w.sheetReads, w.state().cursor], [1, 1, Number(h)], "§4 one new row: one event, one sheet read, the cursor moved");
		const row = w.db.prepare("SELECT event, stop_kind, stop_index, status, verify, mode, source, history_row_id, event_at, next_attempt_at, created_at, payload_json FROM chr_events").get();
		eq(row, {
			event: "arrived_pickup", stop_kind: "pickup", stop_index: 1, status: "pending", verify: "waiting", mode: "dry_run", source: "manual",
			history_row_id: Number(h), event_at: "2026-11-02T15:01:00.000Z", next_attempt_at: "2026-11-02T15:07:00.000Z", created_at: "2026-11-02T15:02:00.000Z", payload_json: "",
		}, "§4 pending, waiting on its check, due after the 5-minute settle, no payload yet");
		eq(w.changes > 0, true, "§4 the page is told something changed");
		w.advance(1);
		await w.tick();
		eq(w.sheetReads, 1, "§4 an idle tick (nothing new, nothing due) reads no sheet");
	}

	// ---------------------------------------------------------------- §5
	section("§5  restarts");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(5);
		w.history("123456789", "At Shipper");
		w.advance(4);
		const quick = await w.tick();
		eq([quick.baseline, quick.recorded, w.audits.length], [null, 1, 1], "§5 a quick restart (heartbeat 9 minutes old): no baseline, the row made meanwhile is recorded");
		w.advance(20);
		w.history("123456789", "In Transit");
		w.advance(1);
		const long = await w.tick();
		eq([long.baseline, long.recorded], ["heartbeat_gap", 0], "§5 a long stop (21 minutes): a baseline; the row made during the gap is never recorded");
		eq(brief(w), ["123456789:arrived_pickup:skipped_off:baseline"], "§5 ...and the pending row from before the gap is skipped, never sent later");
		eq(w.audits.map((a) => a.action), ["chr_baseline", "chr_baseline"], "§5 one more audit row");
		const gapAudit = String((w.audits[1] || {}).details || "");
		ok(/heartbeat/.test(gapAudit) && /1 pending/.test(gapAudit), "§5 ...naming the gap and the row it skipped");
	}

	// ---------------------------------------------------------------- §6
	section("§6  the page's mode");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(1);
		w.history("123456789", "At Shipper");
		await w.tick();
		S.writeSettings(w.db, { ...S.DEFAULT_SETTINGS, milestones: "off" }, { by: "admin.one", nowIso: new Date(w.clock).toISOString() });
		w.advance(1);
		const off = await w.tick();
		eq([off.mode, brief(w)], ["off", ["123456789:arrived_pickup:skipped_off:mode_off"]], "§6 Off: pending rows become skipped_off at once");
		w.advance(1);
		w.history("123456789", "In Transit");
		w.advance(1);
		await w.tick();
		eq(w.events().length, 1, "§6 while Off nothing is recorded");
		S.writeSettings(w.db, { ...S.DEFAULT_SETTINGS }, { by: "admin.one", nowIso: new Date(w.clock).toISOString() });
		w.advance(1);
		const back = await w.tick();
		eq([back.mode, back.baseline, w.events().length], ["dry_run", "mode", 1], "§6 back to Dry run: a baseline; the row made while Off is not recorded");
	}

	// ---------------------------------------------------------------- §7
	section("§7  one transaction; replays");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(1);
		w.history("123456789", "At Shipper");
		w.history("123456789", "In Transit");
		w.db.exec("CREATE TRIGGER fail_second AFTER INSERT ON chr_events WHEN NEW.event = 'departed_pickup' BEGIN SELECT RAISE(ABORT, 'made-up failure'); END;");
		const before = w.state().cursor;
		w.advance(1);
		const res = await w.tick();
		eq([res.error, w.events().length, w.state().cursor], ["RECORD_FAILED", 0, before], "§7 a failure inside the batch: no event recorded and the cursor unchanged");
		ok(w.logs.some((l) => /RECORD_FAILED/.test(l)) && !w.logs.some((l) => /made-up failure/.test(l)), "§7 ...logged by its code, never its text");
		w.db.exec("DROP TRIGGER fail_second");
		w.advance(1);
		await w.tick();
		eq(brief(w), ["123456789:arrived_pickup:pending", "123456789:departed_pickup:pending"], "§7 the next tick records both");
		S.writeState(w.db, { ...w.state(), cursor: 0 }, new Date(w.clock).toISOString());
		w.advance(1);
		await w.tick();
		eq(w.events().length, 2, "§7 the same rows replayed: one event each (idempotency keys)");
	}

	// ---------------------------------------------------------------- §8
	section("§8  a failed sheet read");
	{
		const w = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(1);
		w.history("123456789", "At Shipper");
		w.sheetFails = true;
		const before = w.state().cursor;
		w.advance(1);
		const res = await w.tick();
		eq([res.error, w.events().length, w.state().cursor, w.state().lastErrorCode], ["SHEET_READ_FAILED", 0, before, "SHEET_READ_FAILED"], "§8 nothing recorded, the cursor kept, the code stored");
		ok(!w.logs.join("\n").includes(CANARY.email), "§8 the error's own text is never logged");
		w.sheetFails = false;
		w.advance(1);
		await w.tick();
		eq([w.events().length, w.state().lastErrorCode], [1, ""], "§8 the next good read records it and clears the code");
	}

	// ---------------------------------------------------------------- §9
	section("§9  the Dry-run pipeline");
	{
		const P2 = { origin: PICKUP, dest: DROP };
		const w = world({
			settings: { arrivedPickup: true },
			sheetRows: [
				sheetRow("123456789"), sheetRow("223456789", { Driver: "Driver Two" }), sheetRow("323456789", { Email: "made-up.agent@tql.com" }), sheetRow("42345678"),
				sheetRow("523456789", { Email: "" }), sheetRow("723456789"), sheetRow("823456789"), sheetRow("923456789"),
				sheetRow("133456789"), sheetRow("143456789", { Driver: "Made Up Nobody" }), sheetRow("153456789", { Driver: "Driver Three" }),
			],
			points: { 123456789: P2, 223456789: P2, 723456789: P2, 823456789: P2, 923456789: P2, 143456789: P2, 153456789: P2, 42345678: P2, 523456789: P2 },
			instructions: { 823456789: { pickups: 1, deliveries: 2 } },
		});
		await w.tick();
		S.setHold(w.db, { loadId: "723456789", hold: true, reason: "made-up hold", by: "admin.one", nowIso: new Date(w.clock).toISOString(), redactor: E.createRedactor({}) });
		w.advance(1); // 15:01
		w.history("123456789", "At Shipper");
		w.ping(2, AT_PICKUP);
		w.history("223456789", "At Shipper"); // tapped about 285 miles away
		w.ping(3, FAR_285, { device: "RM-TEST-2" });
		for (const id of ["323456789", "42345678", "523456789", "623456789", "723456789", "823456789", "133456789", "143456789"]) w.history(id, "At Shipper");
		w.history("923456789", "Dispatched", "dispatch");
		w.history("923456789", "At Receiver");
		w.history("153456789", "At Shipper");
		w.history("153456789", "In Transit");
		w.advance(1); // 15:02
		await w.tick();
		ok(!w.events().some((e) => e.load_id === "323456789"), "§9 another broker's load: nothing recorded at all");
		eq(w.events().filter((e) => ["42345678", "523456789", "623456789"].includes(e.load_id)).map((e) => `${e.load_id}:${e.status}:${e.skip_reason}`),
			["42345678:skipped_not_chr:load_id_not_9_digits", "523456789:skipped_not_chr:email_blank", "623456789:skipped_not_chr:load_missing"], "§9 a chrobinson.com load without 9 digits, a blank Email, a load missing from Job Tracking: skipped_not_chr, with the reason");
		eq(w.events().filter((e) => e.load_id === "923456789").map((e) => `${e.event}:${e.status}:${e.hold_reason}`), ["arrived_delivery:held:stop_skipped"], "§9 NL2: a jump past a stop is held at once (stop_skipped)");
		w.advance(4); // 15:06: not yet settled
		await w.tick();
		ok(w.events().filter((e) => e.load_id === "123456789").every((e) => e.status === "pending"), "§9 before the 5-minute settle nothing is decided");
		w.advance(1); // 15:07: settled
		w.ping(-1, AT_PICKUP);
		await w.tick();
		const at = (id) => w.events().filter((e) => e.load_id === id).map((e) => `${e.event}:${e.status}:${e.hold_reason || e.skip_reason}:${e.verify}`);
		eq(at("123456789"), ["arrived_pickup:dry_run::confirmed"], "§9 a tap at the stop, confirmed by a clean ping: dry_run ('would have been sent')");
		eq(at("723456789"), ["arrived_pickup:held:load_hold:waiting"], "§9 a load on hold: held (load_hold)");
		eq(at("823456789"), ["arrived_pickup:held:multi_stop:waiting"], "§9 two deliveries in the driver instructions: held (multi_stop)");
		eq(at("133456789"), ["arrived_pickup:held:stop_not_mapped:not_mapped"], "§9 no mapped stop point: held (stop_not_mapped)");
		eq(at("143456789"), ["arrived_pickup:held:tap_unverified:unverified"], "§9 no truck for the driver at that time: held (tap_unverified)");
		eq(at("223456789"), ["arrived_pickup:pending::waiting"], "§9 the far tap waits while its window is open (NL3)");
		const dry = w.db.prepare("SELECT payload_json, sent_at, fields_dropped FROM chr_events WHERE load_id = '123456789'").get();
		eq(JSON.parse(dry.payload_json), {
			loadNumber: "123456789", event: "arrived_pickup", stop: { kind: "pickup", index: 1 }, eventAt: "2026-11-02T15:01:00Z",
			eventLocal: { time: "2026-11-02T09:01:00", zone: "America/Chicago" }, place: { city: "Ames", state: "IA" }, truck: "T-101", trailer: "53001",
		}, "§9 the dry-run row holds the allowlisted payload; no position (positions are off by default)");
		eq([dry.sent_at, dry.fields_dropped], ["2026-11-02T15:07:00.000Z", 0], "§9 sent_at reads 'would have been sent at'");
		await w.runFor(20); // to 15:27: the far tap's window and its grace are over
		eq(at("223456789"), ["arrived_pickup:held:tap_away_from_stop:away"], "§9 the 285-mile tap: held as away from the stop");
		eq(w.db.prepare("SELECT payload_json FROM chr_events WHERE load_id = '223456789'").get().payload_json, "", "§9 ...with no payload and no position");
		eq(at("153456789"), ["arrived_pickup:held:tap_unverified:unverified", "departed_pickup:pending::waiting"], "§9 no ping at all: the arrival is held once its window and grace pass; the departure's 30 minutes after are not over yet");
		await w.runFor(20); // to 15:47
		eq(at("153456789"), ["arrived_pickup:held:tap_unverified:unverified", "departed_pickup:held:tap_unverified:unverified"], "§9 ...then the departure too (tap_unverified)");
		// The arrival switch off (the default, O8).
		const w2 = world({ sheetRows: [sheetRow("123456789")], points: { 123456789: P2 } });
		await w2.tick();
		w2.advance(1);
		w2.history("123456789", "At Shipper");
		w2.ping(1, AT_PICKUP);
		w2.advance(1);
		await w2.tick();
		w2.advance(6);
		await w2.tick();
		eq(brief(w2), ["123456789:arrived_pickup:skipped_off:arrival_off"], "§9 \"Arrived at pickup\" off (the default, O8): the arrival is never sent");
		// A load that changes broker after it was recorded.
		const w3 = world({ settings: { arrivedPickup: true }, sheetRows: [sheetRow("123456789")], points: { 123456789: P2 } });
		await w3.tick();
		w3.advance(1);
		w3.history("123456789", "At Shipper");
		w3.ping(1, AT_PICKUP);
		w3.advance(1);
		await w3.tick();
		w3.sheetRows = [sheetRow("123456789", { Email: "made-up.agent@tql.com" })];
		w3.advance(6);
		await w3.tick();
		eq(brief(w3), ["123456789:arrived_pickup:skipped_not_chr:other_broker"], "§9 a load moved to another broker since it was recorded: the test runs again at send time");
		w3.sheetRows = [];
		w3.advance(1);
		w3.history("123456789", "In Transit");
		w3.advance(1);
		await w3.tick();
		w3.advance(6);
		await w3.tick();
		eq(brief(w3).slice(-1), ["123456789:departed_pickup:skipped_not_chr:load_missing"], "§9 ...and one cancelled or deleted since (gone from the live view) is not sent");
		// The history's load key is read as its writer stored it (one '#' dropped), never normalized again.
		const w6 = world({ sheetRows: [sheetRow("##555555555")] });
		await w6.tick();
		w6.advance(1);
		w6.history("##555555555", "At Shipper");
		w6.advance(1);
		await w6.tick();
		eq(brief(w6), ["#555555555:arrived_pickup:skipped_not_chr:load_id_not_9_digits"], "§9 a Load ID with two '#': matched to its sheet row under the stored key, and recorded (not 9 digits)");
		// A departure confirmed end to end, with positions allowed.
		const w4 = world({ config: { updatesEnabled: true, locationEnabled: true }, settings: { positionsInMilestones: true }, sheetRows: [sheetRow("123456789")], points: { 123456789: P2 } });
		await w4.tick();
		w4.advance(1);
		w4.ping(-5, AT_PICKUP);
		w4.history("123456789", "In Transit");
		w4.ping(10, OUTSIDE, { speed: 20 });
		w4.advance(1);
		await w4.tick();
		w4.advance(12);
		await w4.tick();
		const dep = w4.db.prepare("SELECT status, verify, payload_json FROM chr_events").get();
		eq([dep.status, dep.verify, JSON.parse(dep.payload_json).position], ["dry_run", "confirmed", { lat: 42.035, lng: -93.6195 }], "§9 a confirmed departure with positions allowed (location switch and page switch): the confirming ping at the pickup");
		const w5 = world({ config: { updatesEnabled: true }, settings: { positionsInMilestones: true }, sheetRows: [sheetRow("123456789")], points: { 123456789: P2 } });
		await w5.tick();
		w5.advance(1);
		w5.ping(-5, AT_PICKUP);
		w5.history("123456789", "In Transit");
		w5.ping(10, OUTSIDE, { speed: 20 });
		w5.advance(1);
		await w5.tick();
		w5.advance(12);
		await w5.tick();
		eq(JSON.parse(w5.db.prepare("SELECT payload_json FROM chr_events").get().payload_json).position, undefined, "§9 the page switch alone (no location server switch): no position");
		eq(networkCalls, 0, "§9 nothing reached the network: the Dry run has no transport");
	}

	// ---------------------------------------------------------------- §10
	section("§10 reverts");
	{
		const w = world({ settings: { arrivedPickup: true }, sheetRows: [sheetRow("123456789")], points: { 123456789: { origin: PICKUP, dest: DROP } } });
		await w.tick();
		w.advance(1);
		w.history("123456789", "At Shipper");
		w.ping(1, AT_PICKUP);
		w.advance(1);
		w.history("123456789", "In Transit");
		w.advance(1);
		await w.tick();
		w.history("123456789", "At Shipper", "override");
		w.advance(1);
		await w.tick();
		eq(brief(w), ["123456789:arrived_pickup:pending", "123456789:departed_pickup:skipped_backwards:reverted"], "§10 an override back to At Shipper: the pending departure becomes skipped_backwards");
		w.advance(10);
		await w.tick();
		eq(brief(w)[0], "123456789:arrived_pickup:dry_run", "§10 the arrival goes on to dry_run");
		w.history("123456789", "Heading to Shipper", "override");
		w.advance(1);
		await w.tick();
		const arr = w.events()[0];
		eq([arr.status, arr.reverted_at !== ""], ["dry_run", true], "§10 a dry-run row reverted later keeps its status and is flagged (the page: \"check it in Navisphere\")");
	}

	// ---------------------------------------------------------------- §11
	section("§11 the canary");
	{
		const P2 = { origin: PICKUP, dest: DROP };
		const w = world({
			config: { updatesEnabled: true, locationEnabled: true, denyList: CANARY.carrier },
			settings: { arrivedPickup: true, positionsInMilestones: true },
			sheetRows: [sheetRow("123456789", {
				"Trailer Number": `53001 call ${CANARY.name} ${CANARY.phone}`, "Pickup Address": `Attn ${CANARY.name} ${CANARY.phone}, ${CANARY.street}, Ames, IA 50010`,
				"Drop-off Address": `${CANARY.email} ${CANARY.ssn}, ${CANARY.cdl} ${CANARY.dob}, ${CANARY.name}, IL 60431`, Email: "made-up.agent@chrobinson.com",
				"Broker Contact Name": `${CANARY.name} ${CANARY.carrier}`,
			}), sheetRow("223456789", { "Trailer Number": CANARY.carrier.slice(0, 12), Email: "" })],
			points: { 123456789: P2, 223456789: P2 },
		});
		await w.tick();
		w.advance(1);
		for (const s of ["At Shipper", "In Transit", "At Receiver", "Delivered"]) { w.history("123456789", s); w.ping(1, AT_PICKUP); }
		w.history("223456789", "At Shipper");
		w.ping(-5, AT_PICKUP);
		w.ping(10, OUTSIDE, { speed: 20 });
		w.ping(2, AT_DROP);
		w.advance(1);
		await w.tick();
		await w.runFor(40);
		S.setHold(w.db, { loadId: "123456789", hold: true, reason: `check reference ${CANARY.carrier}`, by: "admin.one", nowIso: new Date(w.clock).toISOString(), redactor: E.createRedactor({ denyList: CANARY.carrier }) });
		const dump = [
			...w.db.prepare("SELECT * FROM chr_events").all().map((r) => JSON.stringify(r)),
			...w.db.prepare("SELECT * FROM chr_loads").all().map((r) => JSON.stringify(r)),
			...w.db.prepare("SELECT value FROM server_state").all().map((r) => r.value),
			...w.db.prepare("SELECT value FROM app_settings").all().map((r) => r.value),
			...w.audits.map((a) => JSON.stringify(a)), ...w.logs,
			JSON.stringify(w.integration.config()),
		].join("\n").toLowerCase();
		eq(Object.entries(CANARY).filter(([, v]) => dump.includes(v.toLowerCase())).map(([k]) => k), [], "§11 no canary in any chr_ row, the state, the settings, an audit row, a log line or the config view");
		ok(w.db.prepare("SELECT COUNT(*) AS n FROM chr_events WHERE status = 'dry_run'").get().n >= 1, "§11 ...while the pipeline ran (dry-run rows exist)");
		ok(w.db.prepare("SELECT SUM(fields_dropped) AS n FROM chr_events").get().n >= 1, "§11 ...and dropped the planted fields, counted");
		eq(networkCalls, 0, "§11 nothing reached the network");
	}

	// ---------------------------------------------------------------- §12
	section("§12 the source");
	const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /^chr-.*\.js$/.test(f)).sort();
	eq(libFiles, ["chr-events.js", "chr-integration.js", "chr-store.js", "chr-sweep.js", "chr-verify.js"], "§12 the five lib/chr-*.js files");
	const sqlOf = (text) => (text.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) || []).filter((s) => /\b(?:SELECT|UPDATE|INSERT|DELETE|CREATE)\b/.test(s));
	for (const f of libFiles) {
		const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
		const code = src.replace(/^\s*\/\/.*$/gm, "");
		ok(!/spreadsheets\.values\.(?:update|append|batchUpdate)|spreadsheets\.batchUpdate|getSheets\(|google\.sheets|google\.drive|getDrive\(|drive\.files/.test(code), `§12 ${f}: no Sheets or Drive call`);
		ok(!/sendEmail|appendGmailDraft|nodemailer|imap|n8n|webhook/i.test(code), `§12 ${f}: no mail, draft, n8n or webhook`);
		ok(!/\bfetch\s*\(|require\(["'](?:https?|net|tls)["']\)/.test(code), `§12 ${f}: no network call`);
		ok(!/\bprocess\b/.test(src), `§12 ${f}: no environment read (the flags arrive as booleans through chrConfig())`);
		eq(sqlOf(src).filter((s) => /\bactor\b|(?<![a-z_])reason\b/.test(s)), [], `§12 ${f}: its SQL names neither actor nor reason`);
		ok(!/SELECT \*/i.test(src), `§12 ${f}: no SELECT *`);
	}

	// ---------------------------------------------------------------- §13
	section("§13 a protected number inside a load key");
	{
		// Made-up deny values: a 9-digit one, which a 9-digit Load ID can hold, and
		// the 14-digit stand-in, which none can.
		const KEY_CANARY = "900000001";
		const DENY = [KEY_CANARY, CANARY.carrier];
		const w = world({
			config: { updatesEnabled: true, denyList: DENY.join(", ") },
			settings: { arrivedPickup: true },
			sheetRows: [
				sheetRow(KEY_CANARY), // (1) a 9-digit chrobinson.com Load ID
				sheetRow(`LD${KEY_CANARY}`), sheetRow(CANARY.carrier), // (2) chrobinson.com, not 9 digits
				sheetRow(`${KEY_CANARY}-2`, { Email: "" }), sheetRow(`${KEY_CANARY}-3`, { Email: "Made Up <made-up.agent@chrobinson.com>" }), // (3) Email blank, unreadable
				sheetRow("123456789"), sheetRow("42345678"), sheetRow("523456789", { Email: "" }), // the same paths with clean keys
			],
			points: { 123456789: { origin: PICKUP, dest: DROP } },
		});
		const results = [await w.tick()];
		w.advance(1);
		w.history(KEY_CANARY, "At Shipper");
		w.history(KEY_CANARY, "In Transit");
		// (4) KEY_CANARY-4 and 623456789 are in the history only: missing from Job Tracking.
		for (const id of [`LD${KEY_CANARY}`, CANARY.carrier, `${KEY_CANARY}-2`, `${KEY_CANARY}-3`, `${KEY_CANARY}-4`, "123456789", "42345678", "523456789", "623456789"]) w.history(id, "At Shipper");
		w.ping(1, AT_PICKUP);
		w.advance(1);
		results.push(await w.tick());
		w.advance(6);
		results.push(await w.tick());
		eq(brief(w), ["123456789:arrived_pickup:dry_run", "42345678:arrived_pickup:skipped_not_chr:load_id_not_9_digits", "523456789:arrived_pickup:skipped_not_chr:email_blank", "623456789:arrived_pickup:skipped_not_chr:load_missing"],
			"§13 only the clean keys are recorded, each on its path as before (the pipeline ran)");
		eq(w.state().withheldRows, 7, "§13 withheldRows counts the 7 history rows under the protected keys, from all four paths");
		const INPUTS = ["load_status_history", "routemate_telemetry"];
		const dumpOf = (names) => names.flatMap((t) => w.db.prepare(`SELECT * FROM "${t}"`).all().map((r) => JSON.stringify(r))).join("\n").toLowerCase();
		const stored = w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((t) => !INPUTS.includes(t));
		ok(["app_settings", "chr_events", "chr_loads", "server_state"].every((t) => stored.includes(t)), "§13 (check) every table but the runner's two inputs is read, the chr_ tables and both state tables included");
		const dump = [dumpOf(stored), ...w.audits.map((a) => JSON.stringify(a)), ...w.logs, ...results.map((r) => JSON.stringify(r)), JSON.stringify(w.integration.config())].join("\n").toLowerCase();
		eq(DENY.filter((v) => dump.includes(v)), [], "§13 neither protected number is in any stored column of any table, an audit row, a log line, a tick's result or the config view");
		eq(DENY.filter((v) => dumpOf(["load_status_history"]).includes(v)), DENY, "§13 (check) the same read finds both in the runner's own history table, so the check above would catch them");
		// A row recorded before its number was protected (planted here) is decided
		// as withheld, never built into a payload.
		const w2 = world({ config: { updatesEnabled: true, denyList: KEY_CANARY }, settings: { arrivedPickup: true } });
		await w2.tick();
		const at = new Date(w2.clock).toISOString();
		S.applyRecording(w2.db, {
			inserts: [{
				load_id: `${KEY_CANARY}-5`, kind: "milestone", event: "arrived_pickup", stop_kind: "pickup", stop_index: 1, source: "manual", history_row_id: 1,
				event_at: at, verify: "waiting", idem_key: `ms|${KEY_CANARY}-5|arrived_pickup|p1|h1`, mode: "dry_run", status: "pending", next_attempt_at: at,
			}],
			state: w2.state(), nowIso: at,
		});
		w2.advance(1);
		await w2.tick();
		eq(w2.db.prepare("SELECT status, skip_reason, payload_json FROM chr_events").all(), [{ status: "skipped_not_chr", skip_reason: "withheld", payload_json: "" }],
			"§13 a due row whose key holds a protected number is decided as withheld (with no sheet row, not load_missing), with no payload");
		eq(networkCalls, 0, "§13 nothing reached the network");
	}
}

main().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
