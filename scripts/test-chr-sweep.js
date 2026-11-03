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
//       history, the sheet and the settings, and a driver's emergency contact,
//       reach no row, state, audit or log
//   §12 the source: lib/chr-*.js has no Sheets write, Drive, mail or n8n; its
//       SQL names neither actor nor reason; no SELECT *; it never names
//       driver_emergency_contacts or driver_locations, and every routemate_telemetry
//       SQL keeps source = 'routemate' and dropped_reason = '' (with mutants)
//   §13 a protected number inside a load key is withheld on all four paths (a
//       9-digit Load ID, one that is not, a blank or unreadable Email, a load
//       missing from Job Tracking): no table, audit, log or result holds it
//   §14 PR 3-shell, the pilot: two CHR loads and the pilot on one (Live rows
//       only for it); its end at its delivered update or 72 hours after sending
//       went on; Stop everything in the middle; Off saved during a request; the
//       page's Live without CHR_LIVE_ALL_ENABLED is Dry run for every load; the
//       pilot moved or sending switched off drops pending live rows; R3.7's
//       location Pilot
//   §15 the sender, with a made-up transport: SENT and its reference; backoff
//       and Retry-After; AUTH_FAILED pauses; a refusal fails with one notice per
//       load a day; five failures pause 15 minutes; a row cut off mid-request;
//       the 24-hour give-up and a confirmed retry; 30 a minute; the CHR-load test
//       and holds again before each request; no ready transport sends nothing
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
// A config from the inputs this tree's chrConfig() takes, so a run on an older
// tree fails on what it does rather than stopping at an input it lacks.
const chrCfg = (input) => I.chrConfig(Object.fromEntries(Object.entries(input || {}).filter(([k]) => I.CONFIG_INPUTS.includes(k))));

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
	note: "canary internal note", emergencyName: "Canary Emergencycontact", emergencyPhone: "(555) 555-0199",
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
// `transport`: a made-up transport for the sender's cases; the sweep is then built
// directly (lib/chr-integration.js builds its own, which is never ready).
function world({ config = { updatesEnabled: true }, settings = null, sheetRows = [], points = {}, instructions = {}, trucks = TRUCKS, transport = null, db: given = null } = {}) {
	const db = given || new Database(":memory:");
	if (given) return worldOn(db, { config, sheetRows, points, instructions, trucks, transport });
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, bearing TEXT DEFAULT '', odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0, fuel_pct INTEGER,
			geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
		CREATE TABLE driver_emergency_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, position INTEGER NOT NULL,
			contact_name TEXT NOT NULL, relationship TEXT NOT NULL, contact_phone TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
	`);
	if (settings) S.writeSettings(db, { ...S.DEFAULT_SETTINGS, ...settings }, { by: "admin.one", nowIso: "2026-11-02T14:00:00.000Z" });
	return worldOn(db, { config, sheetRows, points, instructions, trucks, transport });
}
// A world on an existing database: a restart with other switches is a new world on the same db.
function worldOn(db, { config, sheetRows, points, instructions, trucks, transport }) {
	const w = {
		db, clock: Date.parse("2026-11-02T15:00:00Z"), sheetReads: 0, sheetFails: false, audits: [], logs: [], changes: 0, sheetRows, notices: [],
	};
	const cfg = chrCfg(config);
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
		// Handed in only where the integration takes it, so an older tree still runs.
		...(I.DEP_NAMES.includes("notify") ? { notify: (n) => w.notices.push(n) } : {}),
		now: () => w.clock,
		log: { info: (...a) => w.logs.push(a.join(" ")), warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) },
	};
	if (transport) {
		const sweep = W.createSweep({ ...deps, transport });
		w.integration = { sweep: () => sweep.tick(), config: () => ({}) };
	} else {
		w.integration = I.create(deps);
	}
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
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: cfgSend, transportReady: true }), "dry_run", "§2 Live, the send switch and a transport, without CHR_LIVE_ALL_ENABLED: dry run");
	const cfgAll = chrCfg({ updatesEnabled: true, sendEnabled: true, liveAllEnabled: true, locationEnabled: true });
	eq(W.effectiveMode("milestone", { settings: set({ milestones: "live" }), config: cfgAll, transportReady: true }), "live", "§2 ...with it: live");
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
				"Trailer Number": `53001 call ${CANARY.name} ${CANARY.phone}`,
				"Pickup Address": `Attn ${CANARY.name} ${CANARY.phone} or ${CANARY.emergencyName} ${CANARY.emergencyPhone}, ${CANARY.street}, Ames, IA 50010`,
				"Drop-off Address": `${CANARY.email} ${CANARY.ssn}, ${CANARY.cdl} ${CANARY.dob}, ${CANARY.name}, IL 60431`, Email: "made-up.agent@chrobinson.com",
				"Broker Contact Name": `${CANARY.name} ${CANARY.carrier}`,
			}), sheetRow("223456789", { "Trailer Number": CANARY.carrier.slice(0, 12), Email: "" })],
			points: { 123456789: P2, 223456789: P2 },
		});
		// A driver's emergency contact (addendum C9): a table lib/chr-*.js never reads.
		w.db.prepare("INSERT INTO driver_emergency_contacts (user_id, position, contact_name, relationship, contact_phone, created_at, updated_at) VALUES (1, 1, ?, 'Sibling', ?, ?, ?)")
			.run(CANARY.emergencyName, CANARY.emergencyPhone, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
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
		ok(w.db.prepare("SELECT COUNT(*) AS n FROM driver_emergency_contacts WHERE contact_name = ? AND contact_phone = ?").get(CANARY.emergencyName, CANARY.emergencyPhone).n === 1,
			"§11 (check) the emergency contact sat in its table the whole time");
		ok(w.db.prepare("SELECT COUNT(*) AS n FROM chr_events WHERE status = 'dry_run'").get().n >= 1, "§11 ...while the pipeline ran (dry-run rows exist)");
		ok(w.db.prepare("SELECT SUM(fields_dropped) AS n FROM chr_events").get().n >= 1, "§11 ...and dropped the planted fields, counted");
		eq(networkCalls, 0, "§11 nothing reached the network");
	}

	// ---------------------------------------------------------------- §12
	section("§12 the source");
	const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /^chr-.*\.js$/.test(f)).sort();
	eq(libFiles, ["chr-events.js", "chr-integration.js", "chr-routes.js", "chr-store.js", "chr-sweep.js", "chr-transport.js", "chr-verify.js"], "§12 the seven lib/chr-*.js files");
	const sqlOf = (text) => (text.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) || []).filter((s) => /\b(?:SELECT|UPDATE|INSERT|DELETE|CREATE)\b/.test(s));
	// Any string naming the table counts, SQL keyword or not, so a split query is still seen.
	const telemetrySql = (text) => (text.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) || []).filter((s) => /routemate_telemetry/i.test(s));
	const locationScan = (text) => [
		...(/driver_locations/i.test(text) ? ["driver_locations"] : []),
		...telemetrySql(text).filter((s) => !/\bsource\s*=\s*'routemate'/i.test(s) || !/\bdropped_reason\s*=\s*''/i.test(s)),
	];
	for (const f of libFiles) {
		const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
		const code = src.replace(/^\s*\/\/.*$/gm, "");
		ok(!/spreadsheets\.values\.(?:update|append|batchUpdate)|spreadsheets\.batchUpdate|getSheets\(|google\.sheets|google\.drive|getDrive\(|drive\.files/.test(code), `§12 ${f}: no Sheets or Drive call`);
		ok(!/sendEmail|appendGmailDraft|nodemailer|imap|n8n|webhook/i.test(code), `§12 ${f}: no mail, draft, n8n or webhook`);
		// The transport is the one file that may call fetch (scripts/test-chr-transport.js §7 pins it to one call).
		if (f === "chr-transport.js") ok(!/require\(["'](?:https?|net|tls)["']\)/.test(code), `§12 ${f}: no network module beyond its one fetch`);
		else ok(!/\bfetch\s*\(|require\(["'](?:https?|net|tls)["']\)/.test(code), `§12 ${f}: no network call`);
		ok(!/\bprocess\b/.test(src), `§12 ${f}: no environment read (the flags arrive as booleans through chrConfig())`);
		eq(sqlOf(src).filter((s) => /\bactor\b|(?<![a-z_])reason\b/.test(s)), [], `§12 ${f}: its SQL names neither actor nor reason`);
		ok(!/SELECT \*/i.test(src), `§12 ${f}: no SELECT *`);
		// Addendum C9: a driver's emergency contacts are no CHR input, in SQL or anywhere else.
		ok(!/driver_emergency_contacts/i.test(src), `§12 ${f}: never names driver_emergency_contacts`);
		eq(locationScan(src), [], `§12 ${f}: never names driver_locations; every routemate_telemetry SQL keeps the clean-RouteMate filter`);
	}
	// Addendum R3.7: a position reaches CHR only from the truck's clean RouteMate
	// fixes, never from drivers' phones (driver_locations) or Linxup/dropped rows.
	ok(telemetrySql(fs.readFileSync(path.join(ROOT, "lib", "chr-verify.js"), "utf8")).length >= 2, "§12 (check) the scan sees chr-verify.js's two telemetry reads, so it is not vacuous");
	eq(locationScan("const Q = `SELECT lat, lng FROM driver_locations WHERE driver_id = ?`;"), ["driver_locations"], "§12 mutant: a made-up driver_locations read is caught");
	eq(locationScan("const Q = `SELECT latitude FROM routemate_telemetry WHERE routemate_vehicle_id = ?`;").length, 1, "§12 mutant: a routemate_telemetry read with no filter is caught");
	eq(locationScan("const Q = `SELECT latitude FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = ''`;").length, 1, "§12 mutant: ...and one with only the dropped_reason half");
	eq(locationScan("const Q = \"SELECT latitude FROM routemate_telemetry WHERE source = 'routemate'\";").length, 1, "§12 mutant: ...and one with only the source half");
	eq(locationScan("const Q = `SELECT latitude FROM routemate_telemetry\n\tWHERE source = 'routemate' AND dropped_reason = ''`;"), [], "§12 (check) a filtered read passes");

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

	await pilotSections();
	await senderSections();
}

// ------------------------------------------------------------------ PR 3-shell: the pilot and the sender
// A made-up transport: ready, answering from a script (SENT by default), recording
// each payload it is handed. It never touches the network.
function fakeTransport(answers = []) {
	const t = { sent: [], queue: answers.slice(), readyNow: true, drops: 0, during: null };
	t.ready = () => t.readyNow;
	t.send = async (payload, { reference } = {}) => {
		t.sent.push({ payload, reference });
		if (typeof t.during === "function") t.during(t.sent.length);
		const a = t.queue.length ? t.queue.shift() : { resultCode: "SENT", httpStatus: 200 };
		return { httpStatus: null, chrCode: "", retryAfterS: null, remoteRef: "", ...a };
	};
	t.dropToken = () => { t.drops++; };
	return t;
}
const PILOT = (loadKey) => ({ loadKey, setAt: "2026-11-02T14:00:00.000Z", setBy: "admin.one", until: "" });
const BOTH = { "123456789": { origin: PICKUP, dest: DROP }, "223456789": { origin: PICKUP, dest: DROP } };
const iso = (ms) => new Date(ms).toISOString();
// A departure from pickup 1 on each load, confirmed by its own truck's pings.
function departBoth(w) {
	w.ping(-5, AT_PICKUP);
	w.ping(-5, AT_PICKUP, { device: "RM-TEST-2" });
	w.history("123456789", "In Transit");
	w.history("223456789", "In Transit");
	w.ping(4, OUTSIDE, { speed: 20 });
	w.ping(4, OUTSIDE, { speed: 20, device: "RM-TEST-2" });
}
const readyRow = (w, load, n, over = {}) => w.db.prepare(`INSERT INTO chr_events (load_id, kind, event, stop_kind, stop_index, event_at, verify, idem_key, payload_json, mode, status,
	next_attempt_at, attempts, claimed_at, created_at, updated_at)
	VALUES (?, 'milestone', 'departed_pickup', 'pickup', 1, ?, 'confirmed', ?, ?, 'live', ?, ?, ?, ?, ?, ?)`)
	.run(load, over.eventAt || iso(w.clock), `ms|${load}|departed_pickup|p1|h${n}`, JSON.stringify({ loadNumber: load, event: "departed_pickup", stop: { kind: "pickup", index: 1 }, eventAt: iso(w.clock).replace(/\.\d{3}Z$/, "Z") }),
		over.status || "pending", over.next || iso(w.clock), over.attempts || 0, over.claimedAt || "", iso(w.clock), iso(w.clock)).lastInsertRowid;
const rowOf = (w, id) => w.db.prepare("SELECT status, mode, attempts, result_code, http_status, next_attempt_at, sent_at, skip_reason FROM chr_events WHERE id = ?").get(id);

async function pilotSections() {
	section("§14 the pilot (one load Live) and CHR_LIVE_ALL_ENABLED");
	const set = (over) => ({ ...S.DEFAULT_SETTINGS, ...over });
	const cfgSend = I.chrConfig({ updatesEnabled: true, sendEnabled: true });
	const pilotOn = set({ milestones: "pilot", pilot: PILOT("123456789") });
	eq([W.effectiveMode("milestone", { settings: pilotOn, config: cfgSend, transportReady: true }),
		W.effectiveMode("milestone", { settings: pilotOn, config: cfgSend, transportReady: true, loadKey: "123456789" }),
		W.effectiveMode("milestone", { settings: pilotOn, config: cfgSend, transportReady: true, loadKey: "223456789" }),
		W.effectiveMode("milestone", { settings: pilotOn, config: I.chrConfig({ updatesEnabled: true }), transportReady: true, loadKey: "123456789" }),
		W.effectiveMode("milestone", { settings: set({ milestones: "pilot" }), config: cfgSend, transportReady: true, loadKey: "123456789" })],
	["pilot", "live", "dry_run", "dry_run", "dry_run"], "§14 Pilot: the pilot load Live, every other load Dry run; Dry run without the send switch or without a pilot record");
	eq(S.normalizeSettings({ milestones: "pilot", location: "pilot", pilot: PILOT("123456789") }).milestones, "pilot", "§14 the settings keep \"pilot\" (it used to be read back as off)");
	// Addendum R3.7: the pilot rule is written per kind, so location reuses it.
	const locPilot = set({ location: "pilot", pilot: PILOT("123456789") });
	eq([W.effectiveMode("location", { settings: locPilot, config: cfgSend, transportReady: true, loadKey: "123456789" }),
		W.effectiveMode("location", { settings: locPilot, config: I.chrConfig({ updatesEnabled: true, locationEnabled: true }), transportReady: true, loadKey: "123456789" }),
		W.effectiveMode("location", { settings: locPilot, config: I.chrConfig({ updatesEnabled: true, sendEnabled: true, locationEnabled: true }), transportReady: true, loadKey: "123456789" })],
	["off", "dry_run", "live"], "§14 R3.7 location's Pilot: off without CHR_LOCATION_ENABLED; with it and sending off, dry run; with both, the pilot load Live");

	// Two CHR loads, the pilot on one.
	const tr = fakeTransport();
	const w = world({ config: { updatesEnabled: true, sendEnabled: true }, settings: pilotOn, sheetRows: [sheetRow("123456789"), sheetRow("223456789", { Driver: "driver two" })], points: BOTH, transport: tr });
	await w.tick();
	departBoth(w);
	await w.runFor(16);
	eq(w.events().map((e) => `${e.load_id}:${e.mode}:${e.status}`), ["123456789:live:sent", "223456789:dry_run:dry_run"], "§14 two CHR loads, the pilot on one: Live rows only for it, Dry run for the other");
	eq(tr.sent.map((s) => s.payload.loadNumber), ["123456789"], "§14 ...one request, for the pilot load");
	eq((S.readSettings(w.db).pilot || {}).until, iso(Date.parse("2026-11-02T15:00:00Z") + 72 * 60 * MIN), "§14 the pilot's end: 72 hours after sending went on (the first tick that saw the switch)");
	// Its delivered update sent: the pilot ends, and every load is Dry run again.
	w.ping(-1, AT_DROP);
	w.history("123456789", "Delivered");
	w.ping(1, AT_DROP);
	await w.runFor(8);
	await w.runFor(2);
	const ended = S.readSettings(w.db);
	eq([ended.milestones, ended.pilot, w.events().filter((e) => e.event === "delivered").map((e) => `${e.mode}:${e.status}`)], ["dry_run", null, ["live:sent"]],
		"§14 the pilot's delivered update sent: the pilot ends, milestones back to Dry run");
	ok(w.audits.some((a) => a.action === "chr_pilot_end" && /delivered update was sent/.test(a.details)) && w.notices.some((n) => /pilot ended/.test(n.title)), "§14 ...one system audit row and one notice say so");

	// The end counts from the send switch's start, not from when the pilot was set.
	const db = new Database(":memory:");
	const w1 = world({ db: null, config: { updatesEnabled: true }, settings: pilotOn, sheetRows: [sheetRow("123456789")], points: BOTH, transport: fakeTransport() });
	await w1.tick();
	eq([S.readSettings(w1.db).milestones, (S.readSettings(w1.db).pilot || {}).until, w1.state().sendOnAt], ["pilot", "", ""], "§14 the pilot set while sending is off: no end time yet");
	db.close();
	const w2 = world({ db: w1.db, config: { updatesEnabled: true, sendEnabled: true }, sheetRows: [sheetRow("123456789")], points: BOTH, transport: fakeTransport() });
	w2.clock = w1.clock + 5 * 24 * 60 * MIN;
	await w2.tick();
	const onAt = w2.clock;
	eq([w2.state().sendOnAt, (S.readSettings(w2.db).pilot || {}).until], [iso(onAt), iso(onAt + 72 * 60 * MIN)], "§14 sending on five days later: the 72 hours start then");
	w2.clock = onAt + 72 * 60 * MIN - MIN;
	await w2.tick();
	eq(S.readSettings(w2.db).milestones, "pilot", "§14 ...a minute before them: still the pilot");
	w2.clock = onAt + 72 * 60 * MIN;
	await w2.tick();
	eq([S.readSettings(w2.db).milestones, w2.audits.filter((a) => a.action === "chr_pilot_end").map((a) => /72 hours/.test(a.details))], ["dry_run", [true]], "§14 ...at 72 hours: back to Dry run, audited");

	// Stop everything in the middle: no request starts after Off is saved.
	const tr3 = fakeTransport([{ resultCode: "CHR_UNAVAILABLE", httpStatus: 503 }]);
	const w3 = world({ config: { updatesEnabled: true, sendEnabled: true }, settings: pilotOn, sheetRows: [sheetRow("123456789")], points: BOTH, transport: tr3 });
	await w3.tick();
	const a = readyRow(w3, "123456789", 1);
	await w3.runFor(1);
	eq([rowOf(w3, a).status, tr3.sent.length], ["pending", 1], "§14 the pilot load's update met a 503: pending, its retry due in 2 minutes");
	S.writeSettings(w3.db, { ...S.readSettings(w3.db), milestones: "off", location: "off" }, { by: "admin.one", nowIso: iso(w3.clock) });
	await w3.runFor(5);
	eq([rowOf(w3, a).status, rowOf(w3, a).skip_reason, tr3.sent.length], ["skipped_off", "mode_off", 1], "§14 Stop everything before the retry: skipped, never sent again");
	// Off saved while a request is under way: the next queued one never starts.
	const tr4 = fakeTransport();
	const w4 = world({ config: { updatesEnabled: true, sendEnabled: true }, settings: pilotOn, sheetRows: [sheetRow("123456789")], points: BOTH, transport: tr4 });
	await w4.tick();
	const b1 = readyRow(w4, "123456789", 1);
	const b2 = readyRow(w4, "123456789", 2);
	tr4.during = (n) => { if (n === 1) S.writeSettings(w4.db, { ...S.readSettings(w4.db), milestones: "off" }, { by: "admin.one", nowIso: iso(w4.clock) }); };
	w4.advance(1);
	await w4.tick();
	eq([rowOf(w4, b1).status, rowOf(w4, b2).status, rowOf(w4, b2).skip_reason, tr4.sent.length], ["sent", "skipped_off", "live_dropped", 1],
		"§14 Off saved during a request: that one finishes, the next queued one is skipped and never starts");

	// The page's Live with CHR_LIVE_ALL_ENABLED off: Dry run for every load.
	const tr5 = fakeTransport();
	const w5 = world({ config: { updatesEnabled: true, sendEnabled: true }, settings: set({ milestones: "live" }), sheetRows: [sheetRow("123456789"), sheetRow("223456789", { Driver: "driver two" })], points: BOTH, transport: tr5 });
	await w5.tick();
	departBoth(w5);
	await w5.runFor(16);
	eq([w5.events().map((e) => `${e.mode}:${e.status}`), tr5.sent.length], [["dry_run:dry_run", "dry_run:dry_run"], 0], "§14 the page's Live without CHR_LIVE_ALL_ENABLED: Dry run for every load, nothing sent");
	// The pilot moved to another load: the old one's pending live rows are dropped.
	const tr6 = fakeTransport([{ resultCode: "TIMEOUT" }]);
	const w6 = world({ config: { updatesEnabled: true, sendEnabled: true }, settings: pilotOn, sheetRows: [sheetRow("123456789"), sheetRow("223456789")], points: BOTH, transport: tr6 });
	await w6.tick();
	const c1 = readyRow(w6, "123456789", 1);
	await w6.runFor(1);
	S.writeSettings(w6.db, { ...S.readSettings(w6.db), pilot: PILOT("223456789") }, { by: "admin.one", nowIso: iso(w6.clock) });
	await w6.runFor(3);
	eq([rowOf(w6, c1).status, rowOf(w6, c1).skip_reason, tr6.sent.length], ["skipped_off", "live_dropped", 1], "§14 the pilot moved: the old load's pending live update is dropped, never sent");
	// Sending switched off (a restart without CHR_SEND_ENABLED): the sender no longer
	// runs, and the pending live rows are skipped at once, never sent later.
	const w7 = world({ db: w6.db, config: { updatesEnabled: true }, sheetRows: [sheetRow("123456789"), sheetRow("223456789")], points: BOTH, transport: fakeTransport() });
	w7.clock = w6.clock + MIN;
	const c2 = readyRow(w7, "223456789", 2);
	await w7.tick();
	eq([rowOf(w7, c2).status, rowOf(w7, c2).skip_reason, w7.audits.filter((x) => x.action === "chr_live_dropped").length], ["skipped_off", "live_dropped", 1],
		"§14 sending switched off: the pending live update is skipped at once (live_dropped), audited");
	eq(networkCalls, 0, "§14 nothing reached the network");
}

async function senderSections() {
	section("§15 the sender (Live for every load, a made-up transport)");
	const liveAll = { updatesEnabled: true, sendEnabled: true, liveAllEnabled: true };
	const live = { ...S.DEFAULT_SETTINGS, milestones: "live" };
	const fresh = async (answers) => {
		const tr = fakeTransport(answers);
		const w = world({ config: liveAll, settings: live, sheetRows: [sheetRow("123456789"), sheetRow("223456789")], points: BOTH, transport: tr });
		await w.tick();
		return { w, tr };
	};
	eq([1, 2, 3, 4, 5, 6, 7].map((n) => W.backoffMs(n) / MIN), [2, 5, 15, 30, 60, 120, 120], "§15 backoff: 2, 5, 15, 30 and 60 minutes, then every 2 hours");
	{
		const { w, tr } = await fresh();
		const id = readyRow(w, "123456789", 1);
		await w.runFor(1);
		const r = rowOf(w, id);
		eq([r.status, r.attempts, r.result_code, r.http_status, r.sent_at === iso(w.clock)], ["sent", 1, "SENT", 200, true], "§15 SENT: sent, one attempt, the result kept");
		eq([tr.sent.length, tr.sent[0].reference, tr.sent[0].payload.loadNumber], [1, W.referenceOf("ms|123456789|departed_pickup|p1|h1"), "123456789"], "§15 ...the stored payload, with an opaque reference from the row's key");
		ok(/^[0-9a-f]{32}$/.test(tr.sent[0].reference) && !tr.sent[0].reference.includes("123456789"), "§15 ...the reference carries nothing of the load");
	}
	{
		const { w } = await fresh([{ resultCode: "CHR_UNAVAILABLE", httpStatus: 503 }, { resultCode: "RATE_LIMITED", httpStatus: 429, retryAfterS: 600 }, { resultCode: "TIMEOUT" }]);
		const id = readyRow(w, "123456789", 1);
		await w.runFor(1);
		eq([rowOf(w, id).status, rowOf(w, id).next_attempt_at], ["pending", iso(w.clock + 2 * MIN)], "§15 a 503: pending, next try in 2 minutes");
		await w.runFor(2);
		eq([rowOf(w, id).attempts, rowOf(w, id).result_code, rowOf(w, id).next_attempt_at], [2, "RATE_LIMITED", iso(w.clock + 10 * MIN)], "§15 a 429 asking for 10 minutes: honoured over the 5-minute backoff");
		await w.runFor(10);
		eq([rowOf(w, id).attempts, rowOf(w, id).next_attempt_at], [3, iso(w.clock + 15 * MIN)], "§15 a timeout on the third try: 15 minutes");
	}
	{
		const { w, tr } = await fresh([{ resultCode: "AUTH_FAILED", httpStatus: 401 }]);
		const id1 = readyRow(w, "123456789", 1);
		const id2 = readyRow(w, "223456789", 2);
		await w.runFor(1);
		eq([w.state().pausedReason, rowOf(w, id1).status, rowOf(w, id2).status, tr.sent.length, tr.drops], ["AUTH_FAILED", "pending", "pending", 1, 1],
			"§15 AUTH_FAILED: sending pauses at once, the token is dropped, both updates wait");
		await w.runFor(20);
		eq([tr.sent.length, w.audits.filter((a) => a.action === "chr_paused").length, w.notices.filter((n) => /paused/.test(n.title)).length], [1, 1, 1], "§15 ...nothing more is sent while paused; one audit row, one notice");
	}
	{
		const { w } = await fresh([{ resultCode: "REJECTED", httpStatus: 400 }, { resultCode: "REJECTED", httpStatus: 422 }]);
		const id1 = readyRow(w, "123456789", 1);
		const id2 = readyRow(w, "123456789", 2);
		await w.runFor(1);
		eq([rowOf(w, id1).status, rowOf(w, id2).status], ["failed", "failed"], "§15 any other 4xx: failed, final until a person retries");
		eq(w.notices.filter((n) => /refused/.test(n.title)).length, 1, "§15 ...one notice for the load that day, not one per update");
		ok(w.notices.every((n) => !n.body.toLowerCase().includes(CANARY.name.toLowerCase())), "§15 ...naming no driver");
	}
	{
		const fives = Array.from({ length: 5 }, () => ({ resultCode: "CHR_UNAVAILABLE", httpStatus: 502 }));
		const { w, tr } = await fresh(fives);
		for (let i = 1; i <= 5; i++) readyRow(w, i % 2 ? "123456789" : "223456789", i);
		await w.runFor(1);
		eq([tr.sent.length, w.state().pausedReason, w.state().pausedUntil], [5, "CHR_UNAVAILABLE", iso(w.clock + 15 * MIN)], "§15 five retryable failures in a row: paused as CHR_UNAVAILABLE for 15 minutes");
		await w.runFor(14);
		eq(tr.sent.length, 5, "§15 ...nothing sent during it");
		await w.runFor(1);
		eq([w.state().pausedReason, w.audits.some((a) => a.action === "chr_unpaused")], ["", true], "§15 ...then it resumes by itself, audited");
	}
	{
		const { w, tr } = await fresh();
		const stuck = readyRow(w, "123456789", 1, { status: "sending", claimedAt: iso(w.clock - 11 * MIN), attempts: 1 });
		const old = readyRow(w, "223456789", 2, { eventAt: iso(w.clock - 25 * 60 * MIN) });
		await w.runFor(1);
		eq([rowOf(w, stuck).status, rowOf(w, old).status, tr.sent.length], ["outcome_unknown", "gave_up", 0], "§15 cut off mid-request: outcome_unknown, never sent again by itself; a milestone 24 hours old: given up");
		ok(w.notices.some((n) => /given up/.test(n.title)), "§15 ...the give-up is told to the Super Admins");
		// A person retried an old update on purpose (confirmOld): it is sent, not given up again.
		const retried = readyRow(w, "223456789", 3, { eventAt: iso(w.clock - 30 * 60 * MIN) });
		w.db.prepare("UPDATE chr_events SET acted_by = 'admin.one' WHERE id = ?").run(retried);
		await w.runFor(1);
		eq([rowOf(w, retried).status, tr.sent.length], ["sent", 1], "§15 an old update a person retried on purpose: sent, not given up again");
	}
	{
		const { w, tr } = await fresh();
		for (let i = 1; i <= 35; i++) readyRow(w, "123456789", i);
		await w.runFor(1);
		eq(tr.sent.length, W.MAX_SENDS_PER_MIN, "§15 at most 30 requests a minute");
		await w.runFor(1);
		eq(tr.sent.length, 35, "§15 ...the rest the next minute");
	}
	{
		const { w, tr } = await fresh();
		const id = readyRow(w, "123456789", 1);
		w.sheetRows = [sheetRow("123456789", { Email: "made-up.agent@example-broker.test" })];
		await w.runFor(1);
		eq([rowOf(w, id).status, tr.sent.length], ["skipped_not_chr", 0], "§15 right before the request the CHR-load test runs again: another broker's load now is never sent");
		const id2 = readyRow(w, "223456789", 2);
		S.setHold(w.db, { loadId: "223456789", hold: true, reason: "made-up", by: "admin.one", nowIso: iso(w.clock), redactor: E.createRedactor({}) });
		w.sheetRows = [sheetRow("223456789")];
		await w.runFor(1);
		eq([rowOf(w, id2).status, tr.sent.length], ["held", 0], "§15 ...and a load put on hold is held, not sent");
	}
	{
		const tr = fakeTransport();
		tr.readyNow = false;
		const w = world({ config: liveAll, settings: live, sheetRows: [sheetRow("123456789"), sheetRow("223456789", { Driver: "driver two" })], points: BOTH, transport: tr });
		await w.tick();
		departBoth(w);
		await w.runFor(16);
		eq([w.events().map((e) => `${e.mode}:${e.status}`), tr.sent.length], [["dry_run:dry_run", "dry_run:dry_run"], 0], "§15 no ready transport (as shipped): Live is Dry run, nothing sent");
	}
	eq(networkCalls, 0, "§15 nothing reached the network");
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
	// What failed before the stop, so a run on an older tree still says what it lacks.
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed, then stopped`);
	process.exit(1);
});
