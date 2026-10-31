#!/usr/bin/env node
// lib/chr-store.js: the C.H. Robinson outbox (which is also the send log), the
// per-load status, the page's settings and the recorder's state (R5 PR 1a: plan
// 4.7, 4.8, 4.19). Nothing calls the module yet; it is run here over in-memory
// SQLite.
//
//   §1  the schema: the two tables, their columns, checks and indexes; built only
//       when asked; tablesExist()
//   §2  the settings: defaults, normalize, the patch (own listed keys only),
//       read and write
//   §3  the recorder's state: defaults, normalize, round trip
//   §4  recording: the inserts and the cursor move commit together; replays add
//       nothing; a failure inside the batch leaves both unchanged
//   §5  voids (a revert) and reverted flags on sent or dry-run rows
//   §6  the baseline; skipping a kind's pending rows
//   §7  holds: a reason is required, kept redacted and short
//   §8  due rows; finishing a row only from pending
//   §9  the prune: positions after 30 days (dry-run rows too), location rows
//       after 90; never creates a table
//   §10 resetForRefresh(): off, terminal or skipped_refresh, payloads cleared,
//       holds, cursor and heartbeat cleared
//   §11 the module's SQL: named columns, no actor or reason, no SELECT *, no
//       interpolation
//
// Made-up data only. In-memory SQLite, no network, no files written.
//   node scripts/test-chr-store.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const E = require(path.join(ROOT, "lib", "chr-events.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function throws(fn, re, label) {
	try { fn(); failures.push(`${label}\n      did not throw`); } catch (err) { ok(re.test(err.message), `${label} (${err.message})`); }
}
function section(t) { console.log(`\n${t}`); }

const NOW = "2026-11-02T16:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
// The tables server.js owns that the store reads or writes (same columns).
function freshDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
	`);
	return db;
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
function ev(over = {}) {
	return {
		load_id: "123456789", kind: "milestone", event: "arrived_pickup", stop_kind: "pickup", stop_index: 1, source: "manual",
		history_row_id: 4, event_at: "2026-11-02T15:20:00.000Z", verify: "waiting", idem_key: "ms|123456789|arrived_pickup|p1|h4",
		payload_json: "", mode: "dry_run", status: "pending", hold_reason: "", skip_reason: "", fields_dropped: 0,
		next_attempt_at: "2026-11-02T15:25:00.000Z", ...over,
	};
}
const rows = (db) => db.prepare("SELECT id, idem_key, status, hold_reason, skip_reason, verify, mode, reverted_at, payload_json FROM chr_events ORDER BY id").all();

// ------------------------------------------------------------------ §1
section("§1  the schema");
let db = freshDb();
eq(S.tablesExist(db), false, "§1 no table before ensureSchema()");
S.ensureSchema(db);
S.ensureSchema(db);
eq(S.tablesExist(db), true, "§1 tablesExist() after it (and a second run changes nothing)");
eq(tables(db).filter((t) => t.startsWith("chr_")), ["chr_events", "chr_loads"], "§1 exactly chr_events and chr_loads");
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
eq(cols("chr_events"), ["id", "load_id", "kind", "event", "stop_kind", "stop_index", "source", "history_row_id", "event_at", "verify", "idem_key",
	"payload_json", "mode", "status", "hold_reason", "skip_reason", "attempts", "last_try", "next_attempt_at", "claimed_at", "http_status", "result_code",
	"chr_code", "retry_after_s", "remote_ref", "fields_dropped", "reverted_at", "created_at", "sent_at", "updated_at", "acted_by"], "§1 chr_events' columns (4.7, plus skip_reason and reverted_at)");
eq(cols("chr_loads"), ["load_id", "multi_stop", "multi_stop_why", "hold", "hold_reason", "hold_by", "hold_at", "last_event", "last_event_at", "updated_at"], "§1 chr_loads' columns");
const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chr_events' AND sql IS NOT NULL ORDER BY name").all();
eq(idx.map((i) => i.sql.replace(/\s+/g, " ").replace(/IF NOT EXISTS /i, "")), ["CREATE INDEX idx_chr_events_due ON chr_events(status, next_attempt_at)", "CREATE INDEX idx_chr_events_load ON chr_events(load_id, id)"], "§1 the load and due indexes");
ok(db.prepare("PRAGMA index_list(chr_events)").all().some((i) => i.unique === 1 && db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join() === "idem_key"), "§1 idem_key is unique");
eq(S.STATUSES, ["pending", "sending", "sent", "failed", "gave_up", "outcome_unknown", "dry_run", "held", "superseded", "skipped_off", "skipped_not_chr", "skipped_backwards", "skipped_refresh"], "§1 the statuses (4.7)");
eq(S.HOLD_REASONS, ["tap_away_from_stop", "tap_unverified", "stop_not_mapped", "multi_stop", "load_hold", "person", "stop_skipped"], "§1 the hold reasons (4.7, and NL2's stop_skipped)");
eq(S.VERIFY_VALUES, ["waiting", "confirmed", "away", "unverified", "not_mapped", "n/a"], "§1 verify values (4.5, and NL3's waiting)");
const insertOne = (over) => () => S.applyRecording(db, { inserts: [ev({ idem_key: `k-${Math.random()}`, ...over })], state: S.readState(db), nowIso: NOW });
for (const [label, over] of [["a status", { status: "maybe" }], ["a mode", { mode: "test" }], ["a kind", { kind: "doc" }], ["a hold reason", { hold_reason: "because" }], ["a skip reason", { skip_reason: "whim" }], ["a verify value", { verify: "probably" }]]) {
	throws(insertOne(over), /CHECK constraint failed/, `§1 ${label} off its list is refused by the table`);
}
// Every value on each list is one the table takes (the CHECKs and the lists agree).
const accepted = [];
for (const [field, list] of [["status", S.STATUSES], ["hold_reason", S.HOLD_REASONS], ["skip_reason", S.SKIP_REASONS], ["verify", S.VERIFY_VALUES], ["mode", ["dry_run", "live"]], ["kind", ["milestone", "location"]]]) {
	for (const v of list) {
		try { insertOne({ [field]: v })(); accepted.push(`${field}=${v}`); } catch (err) { accepted.push(`${field}=${v} REFUSED`); }
	}
}
eq(accepted.filter((a) => a.endsWith("REFUSED")), [], "§1 every listed status, hold reason, skip reason, verify value, mode and kind is accepted by the table");
eq(S.SKIP_REASONS, ["load_missing", "email_blank", "load_id_not_9_digits", "other_broker", "withheld", "reverted", "baseline", "mode_off", "live_dropped", "arrival_off", "refresh"], "§1 the skip reasons");
db.close();

// ------------------------------------------------------------------ §2
section("§2  settings");
db = freshDb();
eq(S.SETTINGS_KEY, "chr.settings", "§2 app_settings key chr.settings");
eq(S.DEFAULT_SETTINGS, { milestones: "dry_run", location: "off", positionsInMilestones: false, arrivedPickup: false, settleMin: 5, locationIntervalMin: 15 }, "§2 defaults: milestones in Dry run on the first enable, location off, positions and arrivals off, 5-minute settle (A7)");
eq(S.readSettings(db), S.DEFAULT_SETTINGS, "§2 no row: the defaults");
eq(S.normalizeSettings({ milestones: "live", location: "sideways", positionsInMilestones: "yes", arrivedPickup: true, settleMin: 99, locationIntervalMin: 30, extra: 1 }),
	{ milestones: "live", location: "off", positionsInMilestones: false, arrivedPickup: true, settleMin: 5, locationIntervalMin: 30 }, "§2 normalize: each bad value falls back to its default, unknown keys dropped");
eq(S.normalizeSettings("garbage"), S.DEFAULT_SETTINGS, "§2 normalize: not an object, the defaults");
eq(S.settingsPatch({ milestones: "off", settleMin: 0 }), { patch: { milestones: "off", settleMin: 0 } }, "§2 patch: listed keys with good values");
eq(S.settingsPatch({ settleMin: 16 }).field, "settleMin", "§2 patch: settleMin above 15 refused, naming the field");
eq(S.settingsPatch({ settleMin: 2.5 }).field, "settleMin", "§2 patch: settleMin must be a whole number");
eq(S.settingsPatch({ locationIntervalMin: 14 }).field, "locationIntervalMin", "§2 patch: location interval below 15 refused");
eq(S.settingsPatch({ milestones: "on" }).field, "milestones", "§2 patch: a mode off the list refused");
eq(S.settingsPatch({ arrivedPickup: "true" }).field, "arrivedPickup", "§2 patch: a switch must be a boolean");
eq(S.settingsPatch({ nope: 1 }).field, "nope", "§2 patch: an unknown key is refused, never ignored");
eq(S.settingsPatch(JSON.parse('{"__proto__": {"milestones": "live"}}')).field, "__proto__", "§2 patch: an own __proto__ key is refused");
eq(S.settingsPatch({ constructor: "x" }).field, "constructor", "§2 patch: constructor is refused");
ok(S.settingsPatch([]).error && S.settingsPatch(null).error, "§2 patch: not an object, refused");
S.writeSettings(db, { ...S.DEFAULT_SETTINGS, milestones: "off" }, { by: "admin.one", nowIso: NOW });
eq(S.readSettings(db).milestones, "off", "§2 write then read");
eq(db.prepare("SELECT updated_at, updated_by FROM app_settings WHERE key = 'chr.settings'").get(), { updated_at: NOW, updated_by: "admin.one" }, "§2 the write records when and by whom");
db.prepare("UPDATE app_settings SET value = '{bad json' WHERE key = 'chr.settings'").run();
eq(S.readSettings(db), S.DEFAULT_SETTINGS, "§2 an unreadable row reads as the defaults");
db.close();

// ------------------------------------------------------------------ §3
section("§3  the recorder's state");
db = freshDb();
eq(S.STATE_KEY, "chr.state", "§3 server_state key chr.state");
eq(S.readState(db), S.DEFAULT_STATE, "§3 no row: the defaults");
eq(Object.keys(S.DEFAULT_STATE), ["cursor", "baselineId", "lastMode", "lastTickAt", "firstEnabledAt", "lastBaselineAt", "lastSweepOk", "lastErrorCode", "withheldRows"], "§3 the state's fields (never a token)");
S.writeState(db, { ...S.DEFAULT_STATE, cursor: 12, baselineId: 9, lastMode: "dry_run", lastTickAt: NOW, junk: "x" }, NOW);
eq(S.readState(db), { ...S.DEFAULT_STATE, cursor: 12, baselineId: 9, lastMode: "dry_run", lastTickAt: NOW }, "§3 round trip; an unknown field is not stored");
eq(S.normalizeState({ cursor: -4, baselineId: "x", lastMode: "warp", withheldRows: 2.7 }), S.DEFAULT_STATE, "§3 normalize: bad values fall back");
db.close();

// ------------------------------------------------------------------ §4
section("§4  recording");
db = freshDb();
S.ensureSchema(db);
let st = S.readState(db);
S.applyRecording(db, {
	inserts: [ev(), ev({ idem_key: "ms|123456789|departed_pickup|p1|h6", event: "departed_pickup", history_row_id: 6 })],
	loads: [{ load_id: "123456789", multi_stop: 0, multi_stop_why: "", last_event: "departed_pickup", last_event_at: "2026-11-02T15:30:00.000Z" }],
	state: { ...st, cursor: 6 }, nowIso: NOW,
});
eq(rows(db).map((r) => [r.idem_key, r.status]), [["ms|123456789|arrived_pickup|p1|h4", "pending"], ["ms|123456789|departed_pickup|p1|h6", "pending"]], "§4 two events recorded");
eq(S.readState(db).cursor, 6, "§4 ...and the cursor moved with them");
const row1 = db.prepare("SELECT created_at, updated_at, attempts, sent_at FROM chr_events WHERE id = 1").get();
eq(row1, { created_at: NOW, updated_at: NOW, attempts: 0, sent_at: "" }, "§4 created and updated now, no attempt, not sent");
eq(S.loadRow(db, "123456789"), { load_id: "123456789", multi_stop: 0, multi_stop_why: "", hold: 0, hold_reason: "", hold_by: "", hold_at: "", last_event: "departed_pickup", last_event_at: "2026-11-02T15:30:00.000Z", updated_at: NOW }, "§4 the load's row");
S.applyRecording(db, { inserts: [ev({ status: "held", hold_reason: "multi_stop" })], state: { ...S.readState(db), cursor: 7 }, nowIso: NOW });
eq(rows(db).length, 2, "§4 a replay of the same key adds nothing (INSERT OR IGNORE)");
eq(rows(db)[0].status, "pending", "§4 ...and changes nothing on the stored row");
const before = JSON.stringify([rows(db), S.readState(db)]);
throws(() => S.applyRecording(db, {
	inserts: [ev({ idem_key: "ms|123456789|arrived_delivery|d1|h8", event: "arrived_delivery", history_row_id: 8 }), ev({ idem_key: "bad", status: "nonsense" })],
	state: { ...S.readState(db), cursor: 9 }, nowIso: NOW,
}), /CHECK constraint failed/, "§4 a failure inside the batch throws");
eq(JSON.stringify([rows(db), S.readState(db)]), before, "§4 ...and leaves the rows and the cursor as they were");
db.close();

// ------------------------------------------------------------------ §5
section("§5  voids and reverted flags");
db = freshDb();
S.ensureSchema(db);
S.applyRecording(db, {
	inserts: [ev({ idem_key: "a" }), ev({ idem_key: "b", status: "held", hold_reason: "multi_stop" }), ev({ idem_key: "c", status: "dry_run" }), ev({ idem_key: "d", status: "skipped_not_chr", skip_reason: "load_missing" }), ev({ idem_key: "e", load_id: "987654321" })],
	state: S.readState(db), nowIso: NOW,
});
eq(S.eventsForLoad(db, "123456789").map((r) => r.idem_key), ["a", "b", "c", "d"], "§5 a load's recorded events");
S.applyRecording(db, { voids: ["a", "b", "c", "d"], state: S.readState(db), nowIso: "2026-11-02T17:00:00.000Z" });
eq(rows(db).map((r) => [r.idem_key, r.status, r.skip_reason, r.reverted_at]), [
	["a", "skipped_backwards", "reverted", ""], ["b", "skipped_backwards", "reverted", ""], ["c", "dry_run", "", "2026-11-02T17:00:00.000Z"],
	["d", "skipped_not_chr", "load_missing", ""], ["e", "pending", "", ""],
], "§5 pending and held become skipped_backwards; a dry-run (or sent) row is flagged reverted; skipped rows stay; other loads untouched");
S.applyRecording(db, { voids: ["c"], state: S.readState(db), nowIso: "2026-11-02T18:00:00.000Z" });
eq(rows(db)[2].reverted_at, "2026-11-02T17:00:00.000Z", "§5 a second void keeps the first reverted time");
db.close();

// ------------------------------------------------------------------ §6
section("§6  the baseline");
db = freshDb();
S.ensureSchema(db);
for (let i = 0; i < 5; i++) db.prepare("INSERT INTO load_status_history (load_id, new_status, source) VALUES ('123456789', 'At Shipper', 'manual')").run();
S.applyRecording(db, { inserts: [ev({ idem_key: "p1" }), ev({ idem_key: "p2", mode: "live" }), ev({ idem_key: "h1", status: "held", hold_reason: "tap_unverified" }), ev({ idem_key: "x1", status: "dry_run" })], state: S.readState(db), nowIso: NOW });
const bl = S.baseline(db, { kind: "milestone", nowIso: NOW });
eq(bl, { skipped: 2, cursor: 5 }, "§6 the cursor jumps to the newest history row; the kind's pending rows are skipped");
eq(rows(db).map((r) => [r.idem_key, r.status, r.skip_reason]), [["p1", "skipped_off", "baseline"], ["p2", "skipped_off", "baseline"], ["h1", "held", ""], ["x1", "dry_run", ""]], "§6 ...pending (dry-run or live) become skipped_off; held rows wait for a person; terminal rows stay");
eq([S.readState(db).cursor, S.readState(db).baselineId, S.readState(db).lastBaselineAt], [5, 5, NOW], "§6 the state records the cursor, the baseline row and when");
eq(S.baseline(freshDbWithSchema(), { kind: "milestone", nowIso: NOW }), { skipped: 0, cursor: 0 }, "§6 an empty history: cursor 0");
S.applyRecording(db, { inserts: [ev({ idem_key: "q1" }), ev({ idem_key: "q2", mode: "live" })], state: S.readState(db), nowIso: NOW });
eq(S.skipPending(db, { kind: "milestone", mode: "live", reason: "live_dropped", nowIso: NOW }), 1, "§6 skipPending(live): only the live rows");
eq(rows(db).filter((r) => r.idem_key.startsWith("q")).map((r) => [r.idem_key, r.status, r.skip_reason]), [["q1", "pending", ""], ["q2", "skipped_off", "live_dropped"]], "§6 ...the dry-run row keeps going");
eq(S.skipPending(db, { kind: "milestone", reason: "mode_off", nowIso: NOW }), 1, "§6 skipPending(any mode): the rest");
db.close();
function freshDbWithSchema() { const d = freshDb(); S.ensureSchema(d); return d; }

// ------------------------------------------------------------------ §7
section("§7  holds");
db = freshDbWithSchema();
const RD = E.createRedactor({ denyList: "77700011122233" });
eq(S.setHold(db, { loadId: "123456789", hold: true, reason: "", by: "admin.one", nowIso: NOW, redactor: RD }), { ok: false, error: "A hold needs a reason." }, "§7 a hold needs a reason");
eq(S.setHold(db, { loadId: "123456789", hold: true, reason: `waiting on the owner, ref 77700011122233 ${"x".repeat(400)}`, by: "admin.one", nowIso: NOW, redactor: RD }), { ok: true }, "§7 a hold with a reason");
const held = S.loadRow(db, "123456789");
eq([held.hold, held.hold_by, held.hold_at], [1, "admin.one", NOW], "§7 held, by whom and when");
ok(held.hold_reason.startsWith("waiting on the owner, ref [withheld]") && held.hold_reason.length <= 200 && !held.hold_reason.includes("77700011122233"), "§7 the reason is kept redacted and at most 200 characters");
eq(S.setHold(db, { loadId: "123456789", hold: false, reason: "owner posted it", by: "admin.two", nowIso: NOW, redactor: RD }), { ok: true }, "§7 a release");
eq([S.loadRow(db, "123456789").hold, S.loadRow(db, "123456789").hold_reason, S.loadRow(db, "123456789").hold_by], [0, "", ""], "§7 ...clears the hold");
db.close();

// ------------------------------------------------------------------ §8
section("§8  due rows and finishing a row");
db = freshDbWithSchema();
S.applyRecording(db, {
	inserts: [ev({ idem_key: "due1", next_attempt_at: "2026-11-02T15:00:00.000Z" }), ev({ idem_key: "later", next_attempt_at: "2026-11-02T17:00:00.000Z" }), ev({ idem_key: "heldX", status: "held", hold_reason: "multi_stop", next_attempt_at: "2026-11-02T15:00:00.000Z" })],
	state: S.readState(db), nowIso: NOW,
});
eq(S.dueRows(db, { nowIso: NOW, limit: 10 }).map((r) => r.idem_key), ["due1"], "§8 due: pending rows whose next attempt has come, oldest first");
const due1 = S.dueRows(db, { nowIso: NOW, limit: 10 })[0];
eq(Object.keys(due1).sort(), ["event", "event_at", "history_row_id", "id", "idem_key", "load_id", "mode", "next_attempt_at", "source", "status", "stop_index", "stop_kind", "verify"], "§8 a due row carries what the decision needs and nothing else");
eq(S.finishRow(db, due1.id, { status: "dry_run", verify: "confirmed", payloadJson: "{\"loadNumber\":\"123456789\"}", fieldsDropped: 1, sentAt: NOW, nowIso: NOW }), true, "§8 finish from pending: done");
eq(S.finishRow(db, due1.id, { status: "held", holdReason: "person", nowIso: NOW }), false, "§8 a second finish finds no pending row: nothing changes");
eq(db.prepare("SELECT status, verify, payload_json, fields_dropped, sent_at FROM chr_events WHERE id = ?").get(due1.id), { status: "dry_run", verify: "confirmed", payload_json: "{\"loadNumber\":\"123456789\"}", fields_dropped: 1, sent_at: NOW }, "§8 the finished row");
eq(S.setVerify(db, S.dueRows(db, { nowIso: "2026-11-02T18:00:00.000Z", limit: 10 })[0].id, "waiting", NOW), true, "§8 a still-open window keeps the row pending, verify waiting");
db.close();

// ------------------------------------------------------------------ §9
section("§9  the prune");
db = freshDb();
eq(S.prune(db, { nowMs: Date.parse(NOW) }), { positionsCleared: 0, locationDeleted: 0 }, "§9 no tables: nothing to do");
eq(tables(db).some((t) => t.startsWith("chr_")), false, "§9 ...and the prune creates no table");
S.ensureSchema(db);
const at = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
const withPos = JSON.stringify({ loadNumber: "123456789", event: "delivered", position: { lat: 41.5252, lng: -88.0815 }, truck: "T-101" });
S.applyRecording(db, {
	inserts: [
		ev({ idem_key: "old-dry", status: "dry_run", payload_json: withPos, event_at: at(31) }),
		ev({ idem_key: "old-sent", status: "sent", mode: "live", payload_json: withPos, event_at: at(45) }),
		ev({ idem_key: "new-dry", status: "dry_run", payload_json: withPos, event_at: at(29) }),
		ev({ idem_key: "loc-old", kind: "location", event: "location", stop_kind: "", stop_index: 0, status: "dry_run", payload_json: withPos, event_at: at(91) }),
		ev({ idem_key: "loc-new", kind: "location", event: "location", stop_kind: "", stop_index: 0, status: "dry_run", payload_json: withPos, event_at: at(89) }),
		ev({ idem_key: "ms-old", status: "dry_run", payload_json: JSON.stringify({ loadNumber: "123456789" }), event_at: at(400) }),
	],
	state: S.readState(db), nowIso: NOW,
});
eq(S.prune(db, { nowMs: Date.parse(NOW) }), { positionsCleared: 3, locationDeleted: 1 }, "§9 positions cleared from three rows past 30 days, one location row past 90 deleted");
const pj = (k) => JSON.parse(db.prepare("SELECT payload_json FROM chr_events WHERE idem_key = ?").get(k).payload_json);
eq([pj("old-dry").position, pj("old-dry").truck, pj("old-sent").position, pj("new-dry").position], [undefined, "T-101", undefined, { lat: 41.5252, lng: -88.0815 }], "§9 a dry-run row's position goes too; the rest of the payload stays; a 29-day row keeps it");
eq(db.prepare("SELECT idem_key FROM chr_events WHERE kind = 'location' ORDER BY idem_key").all().map((r) => r.idem_key), ["loc-new"], "§9 the location row past 90 days is deleted");
ok(db.prepare("SELECT 1 FROM chr_events WHERE idem_key = 'ms-old'").get(), "§9 milestone rows are kept (their retention is the owner's O2)");
eq(S.prune(db, { nowMs: Date.parse(NOW) }), { positionsCleared: 0, locationDeleted: 0 }, "§9 a second prune finds nothing");
eq(S.RETENTION, { positionDays: 30, locationDays: 90 }, "§9 the retention days");
db.close();

// ------------------------------------------------------------------ §10
section("§10 resetForRefresh()");
db = freshDb();
eq(S.resetForRefresh(db, NOW), { rowsSkipped: 0, payloadsCleared: 0 }, "§10 no tables: nothing, and no table created");
eq(tables(db).some((t) => t.startsWith("chr_")), false, "§10 ...none");
S.ensureSchema(db);
S.writeSettings(db, { ...S.DEFAULT_SETTINGS, milestones: "live", location: "dry_run" }, { by: "admin.one", nowIso: NOW });
S.writeState(db, { ...S.DEFAULT_STATE, cursor: 40, baselineId: 30, lastMode: "live", lastTickAt: NOW }, NOW);
S.applyRecording(db, {
	inserts: [
		ev({ idem_key: "r-pending", payload_json: "{\"x\":1}" }), ev({ idem_key: "r-held", status: "held", hold_reason: "person", payload_json: "{\"x\":1}" }),
		ev({ idem_key: "r-failed", status: "failed", mode: "live" }), ev({ idem_key: "r-sent", status: "sent", mode: "live", payload_json: "{\"x\":1}" }),
		ev({ idem_key: "r-dry", status: "dry_run", payload_json: "{\"x\":1}" }), ev({ idem_key: "r-skip", status: "skipped_off", skip_reason: "baseline" }),
	],
	state: S.readState(db), nowIso: NOW,
});
S.setHold(db, { loadId: "123456789", hold: true, reason: "made-up hold", by: "admin.one", nowIso: NOW, redactor: E.createRedactor({}) });
eq(S.resetForRefresh(db, NOW), { rowsSkipped: 3, payloadsCleared: 4 }, "§10 three rows not sent, dry-run or skipped become skipped_refresh; four payloads cleared");
eq(rows(db).map((r) => [r.idem_key, r.status, r.payload_json]), [["r-pending", "skipped_refresh", ""], ["r-held", "skipped_refresh", ""], ["r-failed", "skipped_refresh", ""], ["r-sent", "sent", ""], ["r-dry", "dry_run", ""], ["r-skip", "skipped_off", ""]], "§10 ...every payload cleared");
eq([S.readSettings(db).milestones, S.readSettings(db).location], ["off", "off"], "§10 every kind set to Off");
eq([S.readState(db).cursor, S.readState(db).baselineId, S.readState(db).lastTickAt, S.readState(db).lastMode], [0, 0, "", ""], "§10 cursor and heartbeat cleared (the next start baselines)");
eq(S.loadRow(db, "123456789").hold, 0, "§10 holds cleared");
db.close();

// ------------------------------------------------------------------ §11
section("§11 the module's SQL");
const MOD = fs.readFileSync(path.join(ROOT, "lib", "chr-store.js"), "utf8");
// Every string literal that holds SQL.
const sqlOf = (text) => (text.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) || []).filter((s) => /\b(?:SELECT|UPDATE|INSERT|DELETE|CREATE)\b/.test(s));
const SQL = sqlOf(MOD);
ok(SQL.length >= 10, `§11 the module's SQL is found (${SQL.length} statements)`);
eq(SQL.filter((s) => /\bactor\b|(?<![a-z_])reason\b/.test(s)), [], "§11 no SQL names load_status_history's actor or reason");
ok(!/SELECT \*/i.test(MOD), "§11 no SELECT *");
ok(!/\$\{/.test(MOD), "§11 no interpolation: every value is a bound parameter");
ok(!/\bprocess\b|\bfetch\(|require\(["']fs["']\)/.test(MOD), "§11 no environment, network or files");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
