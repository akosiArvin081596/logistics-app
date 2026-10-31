"use strict";
// The C.H. Robinson outbox, which is also the send log (chr_events), the
// per-load status (chr_loads), the page's settings (app_settings chr.settings)
// and the recorder's state (server_state chr.state). Never a token, a response
// body or a person's details: rows hold codes, times, counts and the payload
// lib/chr-events.js built.
//
// ensureSchema() is called only while the master switch is on, so with it off
// no table exists. prune() and resetForRefresh() touch only tables that exist,
// and never create one.

const { HISTORY_SQL } = require("./chr-events");

const SETTINGS_KEY = "chr.settings";
const STATE_KEY = "chr.state";
const DAY_MS = 24 * 60 * 60 * 1000;
const MODES = Object.freeze(["off", "dry_run", "live"]);
const STATUSES = Object.freeze([
	"pending", "sending", "sent", "failed", "gave_up", "outcome_unknown", "dry_run", "held", "superseded",
	"skipped_off", "skipped_not_chr", "skipped_backwards", "skipped_refresh",
]);
const HOLD_REASONS = Object.freeze(["tap_away_from_stop", "tap_unverified", "stop_not_mapped", "multi_stop", "load_hold", "person", "stop_skipped"]);
const SKIP_REASONS = Object.freeze([
	"load_missing", "email_blank", "load_id_not_9_digits", "other_broker", "withheld", "reverted",
	"baseline", "mode_off", "live_dropped", "arrival_off", "refresh",
]);
const VERIFY_VALUES = Object.freeze(["waiting", "confirmed", "away", "unverified", "not_mapped", "n/a"]);
const SETTING_FIELDS = Object.freeze(["milestones", "location", "positionsInMilestones", "arrivedPickup", "settleMin", "locationIntervalMin"]);
// Milestones start in Dry run on the first enable; positions and "Arrived at
// pickup" stay off until the owner's answers (O6, O8).
const DEFAULT_SETTINGS = Object.freeze({ milestones: "dry_run", location: "off", positionsInMilestones: false, arrivedPickup: false, settleMin: 5, locationIntervalMin: 15 });
const DEFAULT_STATE = Object.freeze({
	cursor: 0, baselineId: 0, lastMode: "", lastTickAt: "", firstEnabledAt: "", lastBaselineAt: "", lastSweepOk: "", lastErrorCode: "", withheldRows: 0,
});
// Milestone rows are kept: how long is the owner's answer to O2.
const RETENTION = Object.freeze({ positionDays: 30, locationDays: 90 });

// The CHECK lists repeat the lists above; a runner proves every listed value is
// accepted and anything else refused.
const SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS chr_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		load_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('milestone', 'location')),
		event TEXT NOT NULL,
		stop_kind TEXT NOT NULL DEFAULT '',
		stop_index INTEGER NOT NULL DEFAULT 0,
		source TEXT NOT NULL DEFAULT '',
		history_row_id INTEGER NOT NULL DEFAULT 0,
		event_at TEXT NOT NULL,
		verify TEXT NOT NULL DEFAULT 'waiting' CHECK (verify IN ('waiting', 'confirmed', 'away', 'unverified', 'not_mapped', 'n/a')),
		idem_key TEXT NOT NULL UNIQUE,
		payload_json TEXT NOT NULL DEFAULT '',
		mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
		status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'gave_up', 'outcome_unknown', 'dry_run', 'held',
			'superseded', 'skipped_off', 'skipped_not_chr', 'skipped_backwards', 'skipped_refresh')),
		hold_reason TEXT NOT NULL DEFAULT '' CHECK (hold_reason IN ('', 'tap_away_from_stop', 'tap_unverified', 'stop_not_mapped', 'multi_stop',
			'load_hold', 'person', 'stop_skipped')),
		skip_reason TEXT NOT NULL DEFAULT '' CHECK (skip_reason IN ('', 'load_missing', 'email_blank', 'load_id_not_9_digits', 'other_broker',
			'withheld', 'reverted', 'baseline', 'mode_off', 'live_dropped', 'arrival_off', 'refresh')),
		attempts INTEGER NOT NULL DEFAULT 0,
		last_try TEXT NOT NULL DEFAULT '',
		next_attempt_at TEXT NOT NULL DEFAULT '',
		claimed_at TEXT NOT NULL DEFAULT '',
		http_status INTEGER,
		result_code TEXT NOT NULL DEFAULT '',
		chr_code TEXT NOT NULL DEFAULT '',
		retry_after_s INTEGER,
		remote_ref TEXT NOT NULL DEFAULT '',
		fields_dropped INTEGER NOT NULL DEFAULT 0,
		reverted_at TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		sent_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL,
		acted_by TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS idx_chr_events_load ON chr_events(load_id, id);
	CREATE INDEX IF NOT EXISTS idx_chr_events_due ON chr_events(status, next_attempt_at);
	CREATE TABLE IF NOT EXISTS chr_loads (
		load_id TEXT PRIMARY KEY,
		multi_stop INTEGER NOT NULL DEFAULT 0,
		multi_stop_why TEXT NOT NULL DEFAULT '' CHECK (multi_stop_why IN ('', 'history', 'instructions', 'person')),
		hold INTEGER NOT NULL DEFAULT 0,
		hold_reason TEXT NOT NULL DEFAULT '',
		hold_by TEXT NOT NULL DEFAULT '',
		hold_at TEXT NOT NULL DEFAULT '',
		last_event TEXT NOT NULL DEFAULT '',
		last_event_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	);
`;

function ensureSchema(db) {
	db.exec(SCHEMA_SQL);
}

function tablesExist(db) {
	return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('chr_events', 'chr_loads')").get().n === 2;
}

// ------------------------------------------------------------------ settings

function normalizeSettings(raw) {
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const mode = (v, d) => (MODES.includes(v) ? v : d);
	const bool = (v) => (typeof v === "boolean" ? v : false);
	const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
	return {
		milestones: mode(r.milestones, DEFAULT_SETTINGS.milestones),
		location: mode(r.location, DEFAULT_SETTINGS.location),
		positionsInMilestones: bool(r.positionsInMilestones),
		arrivedPickup: bool(r.arrivedPickup),
		settleMin: int(r.settleMin, 0, 15, DEFAULT_SETTINGS.settleMin),
		locationIntervalMin: int(r.locationIntervalMin, 15, 240, DEFAULT_SETTINGS.locationIntervalMin),
	};
}

function readSettings(db) {
	let raw = null;
	try {
		const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY);
		raw = row ? JSON.parse(row.value) : null;
	} catch {
		raw = null;
	}
	return normalizeSettings(raw);
}

// A settings body -> { patch } or { error, field }. Own keys only, each one on
// the list; anything else (a __proto__ or constructor key included) is
// refused, never ignored. Who may choose Live is the route's question (A3).
function settingsPatch(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the C.H. Robinson settings as an object.", field: null };
	const patch = {};
	for (const k of Object.keys(body)) {
		if (!SETTING_FIELDS.includes(k)) return { error: "That is not a C.H. Robinson setting.", field: String(k).slice(0, 40) };
		const v = body[k];
		if (k === "milestones" || k === "location") {
			if (!MODES.includes(v)) return { error: "A mode is off, dry_run or live.", field: k };
		} else if (k === "positionsInMilestones" || k === "arrivedPickup") {
			if (typeof v !== "boolean") return { error: "A switch is true or false.", field: k };
		} else if (k === "settleMin") {
			if (!(Number.isInteger(v) && v >= 0 && v <= 15)) return { error: "The settle delay is a whole number of minutes from 0 to 15.", field: k };
		} else if (!(Number.isInteger(v) && v >= 15 && v <= 240)) {
			return { error: "The location interval is a whole number of minutes from 15 to 240.", field: k };
		}
		patch[k] = v;
	}
	return { patch };
}

function writeSettings(db, settings, { by = "", nowIso }) {
	db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
		.run(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)), nowIso, String(by).slice(0, 80));
}

// ------------------------------------------------------------------ state

function normalizeState(raw) {
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
	const text = (v) => (typeof v === "string" ? v.slice(0, 40) : "");
	return {
		cursor: count(r.cursor),
		baselineId: count(r.baselineId),
		lastMode: MODES.includes(r.lastMode) ? r.lastMode : "",
		lastTickAt: text(r.lastTickAt),
		firstEnabledAt: text(r.firstEnabledAt),
		lastBaselineAt: text(r.lastBaselineAt),
		lastSweepOk: text(r.lastSweepOk),
		lastErrorCode: typeof r.lastErrorCode === "string" && /^[A-Z_]{1,40}$/.test(r.lastErrorCode) ? r.lastErrorCode : "",
		withheldRows: count(r.withheldRows),
	};
}

function readState(db) {
	let raw = null;
	try {
		const row = db.prepare("SELECT value FROM server_state WHERE key = ?").get(STATE_KEY);
		raw = row ? JSON.parse(row.value) : null;
	} catch {
		raw = null;
	}
	return normalizeState(raw);
}

function writeState(db, state, nowIso) {
	db.prepare(`INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(STATE_KEY, JSON.stringify(normalizeState(state)), nowIso);
}

// ------------------------------------------------------------------ recording

// One transaction: the new events (a key already recorded is skipped, so a
// replay adds nothing), the voided keys, the per-load rows and the state with
// its cursor. A failure anywhere leaves all of them as they were. ON CONFLICT
// names idem_key: INSERT OR IGNORE would also swallow a CHECK failure.
function applyRecording(db, { inserts = [], voids = [], loads = [], state, nowIso }) {
	const insert = db.prepare(`INSERT INTO chr_events
		(load_id, kind, event, stop_kind, stop_index, source, history_row_id, event_at, verify, idem_key, payload_json, mode, status,
		 hold_reason, skip_reason, fields_dropped, next_attempt_at, created_at, updated_at)
		VALUES (@load_id, @kind, @event, @stop_kind, @stop_index, @source, @history_row_id, @event_at, @verify, @idem_key, @payload_json, @mode, @status,
		 @hold_reason, @skip_reason, @fields_dropped, @next_attempt_at, @created_at, @updated_at)
		ON CONFLICT(idem_key) DO NOTHING`);
	const voidOpen = db.prepare("UPDATE chr_events SET status = 'skipped_backwards', skip_reason = 'reverted', updated_at = ? WHERE idem_key = ? AND status IN ('pending', 'held')");
	const flagDone = db.prepare(`UPDATE chr_events SET reverted_at = ?, updated_at = ?
		WHERE idem_key = ? AND reverted_at = '' AND status IN ('sending', 'sent', 'failed', 'gave_up', 'outcome_unknown', 'dry_run')`);
	const upsertLoad = db.prepare(`INSERT INTO chr_loads (load_id, multi_stop, multi_stop_why, last_event, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(load_id) DO UPDATE SET multi_stop = excluded.multi_stop, multi_stop_why = excluded.multi_stop_why,
			last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`);
	db.transaction(() => {
		for (const r of inserts) {
			insert.run({
				load_id: r.load_id, kind: r.kind, event: r.event, stop_kind: r.stop_kind || "", stop_index: Number(r.stop_index) || 0,
				source: r.source || "", history_row_id: Number(r.history_row_id) || 0, event_at: r.event_at, verify: r.verify || "waiting",
				idem_key: r.idem_key, payload_json: r.payload_json || "", mode: r.mode, status: r.status, hold_reason: r.hold_reason || "",
				skip_reason: r.skip_reason || "", fields_dropped: Number(r.fields_dropped) || 0, next_attempt_at: r.next_attempt_at || "",
				created_at: nowIso, updated_at: nowIso,
			});
		}
		for (const key of voids) {
			voidOpen.run(nowIso, key);
			flagDone.run(nowIso, nowIso, key);
		}
		for (const l of loads) upsertLoad.run(l.load_id, l.multi_stop ? 1 : 0, l.multi_stop_why || "", l.last_event || "", l.last_event_at || "", nowIso);
		writeState(db, state, nowIso);
	})();
}

function eventsForLoad(db, loadId, kind = "milestone") {
	return db.prepare("SELECT id, idem_key, status, reverted_at FROM chr_events WHERE load_id = ? AND kind = ? ORDER BY id").all(String(loadId), kind);
}

function loadRow(db, loadId) {
	return db.prepare(`SELECT load_id, multi_stop, multi_stop_why, hold, hold_reason, hold_by, hold_at, last_event, last_event_at, updated_at
		FROM chr_loads WHERE load_id = ?`).get(String(loadId)) || null;
}

// Recording of a kind starts: the cursor jumps to the newest history row, so
// nothing older is ever recorded, and the kind's pending rows are skipped
// (never sent later). Held rows wait for a person.
function baseline(db, { kind = "milestone", nowIso }) {
	return db.transaction(() => {
		const cursor = db.prepare(HISTORY_SQL.maxId).get().id;
		const skipped = db.prepare("UPDATE chr_events SET status = 'skipped_off', skip_reason = 'baseline', updated_at = ? WHERE kind = ? AND status = 'pending'")
			.run(nowIso, kind).changes;
		writeState(db, { ...readState(db), cursor, baselineId: cursor, lastBaselineAt: nowIso }, nowIso);
		return { skipped, cursor };
	})();
}

// A kind's pending rows, or only its live ones (mode "live"), become skipped_off.
function skipPending(db, { kind = "milestone", mode = "", reason, nowIso }) {
	return db.prepare("UPDATE chr_events SET status = 'skipped_off', skip_reason = ?, updated_at = ? WHERE kind = ? AND status = 'pending' AND (? = '' OR mode = ?)")
		.run(reason, nowIso, kind, mode, mode).changes;
}

// A hold needs a reason; it is kept redacted and at most 200 characters (a
// person types it). A release clears it. loadId is the stored load key, as
// recordStatusChange() writes it; it is not normalized again.
function setHold(db, { loadId, hold, reason = "", by = "", nowIso, redactor }) {
	if (!redactor || typeof redactor.redact !== "function") throw new Error("setHold() needs the redactor");
	const text = String(reason == null ? "" : reason).trim();
	if (hold && !text) return { ok: false, error: "A hold needs a reason." };
	const kept = hold ? redactor.redact(text).slice(0, 200) : "";
	db.prepare(`INSERT INTO chr_loads (load_id, hold, hold_reason, hold_by, hold_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(load_id) DO UPDATE SET hold = excluded.hold, hold_reason = excluded.hold_reason, hold_by = excluded.hold_by,
			hold_at = excluded.hold_at, updated_at = excluded.updated_at`)
		.run(String(loadId == null ? "" : loadId), hold ? 1 : 0, kept, hold ? String(by).slice(0, 80) : "", hold ? nowIso : "", nowIso);
	return { ok: true };
}

// ------------------------------------------------------------------ deciding

function dueCount(db, nowIso) {
	return db.prepare("SELECT COUNT(*) AS n FROM chr_events WHERE status = 'pending' AND kind = 'milestone' AND next_attempt_at <> '' AND next_attempt_at <= ?")
		.get(nowIso).n;
}

function dueRows(db, { nowIso, limit }) {
	return db.prepare(`SELECT id, load_id, event, stop_kind, stop_index, source, history_row_id, event_at, idem_key, mode, status, verify, next_attempt_at
		FROM chr_events
		WHERE status = 'pending' AND kind = 'milestone' AND next_attempt_at <> '' AND next_attempt_at <= ?
		ORDER BY next_attempt_at ASC, id ASC LIMIT ?`).all(nowIso, limit);
}

// Only a pending row is finished: true when this call changed it.
function finishRow(db, id, { status, verify, holdReason = "", skipReason = "", payloadJson = "", fieldsDropped = 0, sentAt = "", nowIso }) {
	return db.prepare(`UPDATE chr_events SET status = ?, verify = COALESCE(?, verify), hold_reason = ?, skip_reason = ?, payload_json = ?,
			fields_dropped = ?, sent_at = ?, updated_at = ?
		WHERE id = ? AND status = 'pending'`)
		.run(status, verify === undefined ? null : verify, holdReason, skipReason, payloadJson, Number(fieldsDropped) || 0, sentAt, nowIso, id).changes === 1;
}

function setVerify(db, id, verify, nowIso) {
	return db.prepare("UPDATE chr_events SET verify = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(verify, nowIso, id).changes === 1;
}

// ------------------------------------------------------------------ retention and refresh

// Clears the position from every payload past 30 days (dry-run rows too) and
// deletes location rows past 90. It only clears and deletes, so it runs
// whenever the tables exist, the master switch off included.
function prune(db, { nowMs }) {
	if (!tablesExist(db)) return { positionsCleared: 0, locationDeleted: 0 };
	const positionCut = new Date(nowMs - RETENTION.positionDays * DAY_MS).toISOString();
	const locationCut = new Date(nowMs - RETENTION.locationDays * DAY_MS).toISOString();
	return db.transaction(() => {
		const locationDeleted = db.prepare("DELETE FROM chr_events WHERE kind = 'location' AND event_at < ?").run(locationCut).changes;
		const rows = db.prepare(`SELECT id, payload_json FROM chr_events WHERE event_at < ? AND instr(payload_json, '"position"') > 0`).all(positionCut);
		const update = db.prepare("UPDATE chr_events SET payload_json = ? WHERE id = ?");
		let positionsCleared = 0;
		for (const r of rows) {
			let p = null;
			try { p = JSON.parse(r.payload_json); } catch { p = null; }
			if (p && typeof p === "object" && !Array.isArray(p)) {
				if (!Object.prototype.hasOwnProperty.call(p, "position")) continue;
				delete p.position;
				update.run(JSON.stringify(p), r.id);
			} else {
				update.run("", r.id);
			}
			positionsCleared++;
		}
		return { positionsCleared, locationDeleted };
	})();
}

// A refreshed local or staging copy can never send production's backlog: every
// kind Off, every row not sent, dry-run or skipped becomes skipped_refresh,
// every payload cleared, holds cleared, and the cursor and heartbeat cleared
// so the next start baselines.
function resetForRefresh(db, nowIso) {
	if (!tablesExist(db)) return { rowsSkipped: 0, payloadsCleared: 0 };
	return db.transaction(() => {
		const rowsSkipped = db.prepare(`UPDATE chr_events SET status = 'skipped_refresh', skip_reason = 'refresh', updated_at = ?
			WHERE status NOT IN ('sent', 'dry_run', 'superseded') AND status NOT LIKE 'skipped_%'`).run(nowIso).changes;
		const payloadsCleared = db.prepare("UPDATE chr_events SET payload_json = '' WHERE payload_json <> ''").run().changes;
		db.prepare("UPDATE chr_loads SET hold = 0, hold_reason = '', hold_by = '', hold_at = '', updated_at = ?").run(nowIso);
		writeSettings(db, { ...readSettings(db), milestones: "off", location: "off" }, { by: "refresh", nowIso });
		writeState(db, { ...readState(db), cursor: 0, baselineId: 0, lastMode: "", lastTickAt: "" }, nowIso);
		return { rowsSkipped, payloadsCleared };
	})();
}

module.exports = {
	SETTINGS_KEY,
	STATE_KEY,
	MODES,
	STATUSES,
	HOLD_REASONS,
	SKIP_REASONS,
	VERIFY_VALUES,
	SETTING_FIELDS,
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
	RETENTION,
	ensureSchema,
	tablesExist,
	normalizeSettings,
	readSettings,
	settingsPatch,
	writeSettings,
	normalizeState,
	readState,
	writeState,
	applyRecording,
	eventsForLoad,
	loadRow,
	baseline,
	skipPending,
	setHold,
	dueCount,
	dueRows,
	finishRow,
	setVerify,
	prune,
	resetForRefresh,
};
