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
// "pilot": one load (the pilot record's) may go Live; every other load is Dry run.
const MODES = Object.freeze(["off", "dry_run", "pilot", "live"]);
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
// pickup" stay off until the owner's answers (O6, O8). One pilot record serves
// every kind: { loadKey, setAt, setBy, until } (until: 72 hours after sending
// went on, filled in by the sweep), or null.
const DEFAULT_SETTINGS = Object.freeze({ milestones: "dry_run", location: "off", positionsInMilestones: false, arrivedPickup: false, settleMin: 5, locationIntervalMin: 15, pilot: null });
const DEFAULT_STATE = Object.freeze({
	cursor: 0, baselineId: 0, lastMode: "", lastTickAt: "", firstEnabledAt: "", lastBaselineAt: "", lastSweepOk: "", lastErrorCode: "", withheldRows: 0,
	sendOnAt: "", pausedReason: "", pausedAt: "", pausedUntil: "", lastTokenOkAt: "", failStreak: 0, lastLocationMode: "", locationSince: "",
});
const PILOT_LOAD_RE = /^\d{9}$/;
const PAUSE_REASONS = Object.freeze(["AUTH_FAILED", "CHR_UNAVAILABLE"]);
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

function normalizePilot(p) {
	if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.loadKey !== "string" || !PILOT_LOAD_RE.test(p.loadKey)) return null;
	const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
	return { loadKey: p.loadKey, setAt: text(p.setAt, 40), setBy: text(p.setBy, 80), until: text(p.until, 40) };
}

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
		pilot: normalizePilot(r.pilot),
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
// the list (pilotLoad names the pilot's load); anything else (a __proto__ or
// constructor key included) is refused, never ignored. Who may choose Pilot or
// Live, and when, is the route's question (A3, M6).
function settingsPatch(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the C.H. Robinson settings as an object.", field: null };
	const patch = {};
	for (const k of Object.keys(body)) {
		if (k === "pilotLoad") {
			const v = typeof body[k] === "string" ? body[k].trim().replace(/^#/, "") : "";
			if (!PILOT_LOAD_RE.test(v)) return { error: "The pilot load is a 9-digit Load ID.", field: k };
			patch[k] = v;
			continue;
		}
		if (!SETTING_FIELDS.includes(k)) return { error: "That is not a C.H. Robinson setting.", field: String(k).slice(0, 40) };
		const v = body[k];
		if (k === "milestones" || k === "location") {
			if (!MODES.includes(v)) return { error: "A mode is off, dry_run, pilot or live.", field: k };
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
		sendOnAt: text(r.sendOnAt),
		pausedReason: PAUSE_REASONS.includes(r.pausedReason) ? r.pausedReason : "",
		pausedAt: text(r.pausedAt),
		pausedUntil: text(r.pausedUntil),
		lastTokenOkAt: text(r.lastTokenOkAt),
		failStreak: count(r.failStreak),
		lastLocationMode: MODES.includes(r.lastLocationMode) ? r.lastLocationMode : "",
		locationSince: text(r.locationSince),
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

// Due to be decided: pending, no payload yet. A live row that passed its checks
// keeps its payload and waits for the sender instead (readyRows()).
function dueCount(db, nowIso) {
	return db.prepare(`SELECT COUNT(*) AS n FROM chr_events WHERE status = 'pending' AND kind = 'milestone' AND next_attempt_at <> '' AND next_attempt_at <= ?
		AND payload_json = ''`).get(nowIso).n;
}

function dueRows(db, { nowIso, limit }) {
	return db.prepare(`SELECT id, load_id, event, stop_kind, stop_index, source, history_row_id, event_at, idem_key, mode, status, verify, next_attempt_at
		FROM chr_events
		WHERE status = 'pending' AND kind = 'milestone' AND next_attempt_at <> '' AND next_attempt_at <= ? AND payload_json = ''
		ORDER BY next_attempt_at ASC, id ASC LIMIT ?`).all(nowIso, limit);
}

// ------------------------------------------------------------------ sending (PR 3-shell)

// A live row that passed every check: its payload is kept and it waits, still
// pending, for the sender.
function markReady(db, id, { payloadJson, fieldsDropped = 0, nowIso }) {
	return db.prepare(`UPDATE chr_events SET verify = 'confirmed', payload_json = ?, fields_dropped = ?, next_attempt_at = ?, updated_at = ?
		WHERE id = ? AND status = 'pending' AND mode = 'live'`).run(payloadJson, Number(fieldsDropped) || 0, nowIso, nowIso, id).changes === 1;
}

// Milestones first, oldest due first.
function readyRows(db, { nowIso, limit }) {
	return db.prepare(`SELECT id, load_id, kind, event, stop_kind, stop_index, event_at, idem_key, payload_json, attempts
		FROM chr_events
		WHERE status = 'pending' AND mode = 'live' AND payload_json <> '' AND next_attempt_at <> '' AND next_attempt_at <= ?
		ORDER BY CASE kind WHEN 'milestone' THEN 0 ELSE 1 END, next_attempt_at ASC, id ASC LIMIT ?`).all(nowIso, limit);
}

// The house claim: only the call that moves the row from pending sends it.
function claim(db, id, nowIso) {
	return db.prepare(`UPDATE chr_events SET status = 'sending', claimed_at = ?, attempts = attempts + 1, last_try = ?, updated_at = ?
		WHERE id = ? AND status = 'pending' AND mode = 'live' AND next_attempt_at <= ?`).run(nowIso, nowIso, nowIso, id, nowIso).changes === 1;
}

// A claimed row's outcome: sent, pending again (a retry at nextAttemptAt),
// failed, or pending with no retry time while sending is paused.
function finishSend(db, id, { status, result, nextAttemptAt = "", nowIso }) {
	const r = result || {};
	return db.prepare(`UPDATE chr_events SET status = ?, http_status = ?, result_code = ?, chr_code = ?, retry_after_s = ?, remote_ref = ?,
			next_attempt_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ?
		WHERE id = ? AND status = 'sending'`)
		.run(status, Number.isInteger(r.httpStatus) ? r.httpStatus : null, String(r.resultCode || ""), String(r.chrCode || ""),
			Number.isInteger(r.retryAfterS) ? r.retryAfterS : null, String(r.remoteRef || ""), nextAttemptAt, status, nowIso, nowIso, id).changes === 1;
}

// A row left in sending past the cutoff (a crash between the request and its
// record) becomes outcome_unknown: never sent again by itself.
function recoverStuck(db, { cutoffIso, nowIso }) {
	return db.prepare("UPDATE chr_events SET status = 'outcome_unknown', updated_at = ? WHERE status = 'sending' AND claimed_at <> '' AND claimed_at < ?")
		.run(nowIso, cutoffIso).changes;
}

// Pending live rows of a kind whose event is older than the cutoff are given up,
// except one a person sent back on purpose (acted_by: a confirmed retry).
function giveUpOld(db, { kind, cutoffIso, nowIso }) {
	return db.prepare(`SELECT id, load_id FROM chr_events WHERE status = 'pending' AND mode = 'live' AND kind = ? AND event_at < ? AND acted_by = ''`).all(kind, cutoffIso)
		.filter((r) => db.prepare("UPDATE chr_events SET status = 'gave_up', updated_at = ? WHERE id = ? AND status = 'pending'").run(nowIso, r.id).changes === 1);
}

// Pending live rows of the loads `stillLive` says no, become skipped_off: they
// are never sent later.
function dropNotLive(db, { kind = "milestone", stillLive, nowIso }) {
	const rows = db.prepare("SELECT id, load_id FROM chr_events WHERE status = 'pending' AND mode = 'live' AND kind = ?").all(kind);
	let n = 0;
	for (const r of rows) {
		if (stillLive(r.load_id)) continue;
		n += db.prepare("UPDATE chr_events SET status = 'skipped_off', skip_reason = 'live_dropped', updated_at = ? WHERE id = ? AND status = 'pending'").run(nowIso, r.id).changes;
	}
	return n;
}

// A person's retry: one conditional move from failed, gave_up or
// outcome_unknown back to pending, live rows only.
function retryRow(db, id, { nowIso, by }) {
	return db.prepare(`UPDATE chr_events SET status = 'pending', next_attempt_at = ?, acted_by = ?, updated_at = ?
		WHERE id = ? AND mode = 'live' AND status IN ('failed', 'gave_up', 'outcome_unknown')`).run(nowIso, String(by || "").slice(0, 80), nowIso, id).changes === 1;
}

// ------------------------------------------------------------------ location (PR 4-shell)

// Each load's newest confirmed departure from pickup 1 since `sinceIso`, not
// voided by a status that went back: where a location window can open. With
// MAX(), SQLite takes history_row_id from that same newest row.
function confirmedDepartures(db, sinceIso) {
	return db.prepare(`SELECT load_id, MAX(event_at) AS event_at, history_row_id FROM chr_events
		WHERE kind = 'milestone' AND event = 'departed_pickup' AND stop_kind = 'pickup' AND stop_index = 1 AND verify = 'confirmed' AND reverted_at = ''
		  AND status IN ('dry_run', 'pending', 'sending', 'sent', 'failed', 'gave_up', 'outcome_unknown') AND event_at >= ?
		GROUP BY load_id ORDER BY load_id`).all(String(sinceIso));
}

// How many final events (arrived at delivery, delivered) a load has recorded,
// confirmed or held; a voided one does not count.
function finalEventCount(db, loadId) {
	return db.prepare(`SELECT COUNT(*) AS n FROM chr_events WHERE load_id = ? AND kind = 'milestone' AND event IN ('arrived_delivery', 'delivered')
		AND status <> 'skipped_backwards'`).get(String(loadId)).n;
}

function hasKey(db, idemKey) {
	return Boolean(db.prepare("SELECT 1 AS x FROM chr_events WHERE idem_key = ?").get(String(idemKey)));
}

// One location row, already decided: dry_run ("would have been sent at"), or
// pending for the sender. A key already recorded adds nothing.
function insertLocation(db, { loadId, eventAt, idemKey, payloadJson, mode, nowIso }) {
	const live = mode === "live";
	return db.prepare(`INSERT INTO chr_events (load_id, kind, event, source, event_at, verify, idem_key, payload_json, mode, status, next_attempt_at, sent_at, created_at, updated_at)
		VALUES (?, 'location', 'location', 'routemate', ?, 'n/a', ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(idem_key) DO NOTHING`)
		.run(String(loadId), eventAt, idemKey, payloadJson, live ? "live" : "dry_run", live ? "pending" : "dry_run", live ? nowIso : "", live ? "" : nowIso, nowIso, nowIso).changes === 1;
}

// A newer live location for a load supersedes its older ones still waiting.
function supersedeOlder(db, { loadId, keepKey, nowIso }) {
	return db.prepare(`UPDATE chr_events SET status = 'superseded', updated_at = ?
		WHERE load_id = ? AND kind = 'location' AND status = 'pending' AND idem_key <> ?`).run(nowIso, String(loadId), String(keepKey)).changes;
}

function lastLocationAt(db, loadId) {
	return (db.prepare("SELECT MAX(event_at) AS at FROM chr_events WHERE load_id = ? AND kind = 'location' AND status IN ('dry_run', 'pending', 'sending', 'sent')").get(String(loadId)) || {}).at || "";
}

function eventRow(db, id) {
	return db.prepare("SELECT id, load_id, kind, event, event_at, mode, status FROM chr_events WHERE id = ?").get(id) || null;
}

function pendingLiveOlderThan(db, cutoffIso) {
	return db.prepare("SELECT id FROM chr_events WHERE status = 'pending' AND mode = 'live' AND event_at < ?").all(cutoffIso).map((r) => r.id);
}

function giveUpIds(db, ids, nowIso) {
	const up = db.prepare("UPDATE chr_events SET status = 'gave_up', updated_at = ? WHERE id = ? AND status = 'pending'");
	return db.transaction(() => ids.reduce((n, id) => n + up.run(nowIso, id).changes, 0))();
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

// ------------------------------------------------------------------ the page's reads
// Named columns only, and nothing a person typed beyond codes: the page shows a
// row's codes, times and its allowlisted payload.

const EVENT_PAGE = 50;
// Each filter is off when its value is empty (or 0): one statement, every value bound.
const EVENT_LIST_SQL = `SELECT id, load_id, kind, event, stop_kind, stop_index, source, event_at, verify, payload_json, mode, status,
	hold_reason, skip_reason, attempts, http_status, result_code, fields_dropped, reverted_at, created_at, sent_at, updated_at
	FROM chr_events
	WHERE (? = '' OR status = ?) AND (? = '' OR load_id = ?) AND (? = 0 OR id < ?)
	ORDER BY id DESC LIMIT ?`;

// Newest first, 50 a page; `before` is the last id the page already has.
function listEvents(db, { status = "", loadId = "", before = 0, limit = EVENT_PAGE } = {}) {
	if (!tablesExist(db)) return [];
	const s = String(status || "");
	const l = String(loadId || "");
	const b = Number.isInteger(before) && before > 0 ? before : 0;
	const n = Number.isInteger(limit) && limit > 0 && limit <= EVENT_PAGE ? limit : EVENT_PAGE;
	return db.prepare(EVENT_LIST_SQL).all(s, s, l, l, b, b, n);
}

// { status: count } for one load, or for every row made since `sinceIso`.
function countsByStatus(db, { loadId = "", sinceIso = "" } = {}) {
	if (!tablesExist(db)) return {};
	const rows = loadId
		? db.prepare("SELECT status, COUNT(*) AS n FROM chr_events WHERE load_id = ? GROUP BY status").all(String(loadId))
		: db.prepare("SELECT status, COUNT(*) AS n FROM chr_events WHERE created_at >= ? GROUP BY status").all(String(sinceIso));
	const out = {};
	for (const r of rows) out[r.status] = r.n;
	return out;
}

// The CHR loads the recorder touched since `sinceIso`, newest first.
function recentLoads(db, { sinceIso, limit = 50 }) {
	if (!tablesExist(db)) return [];
	return db.prepare(`SELECT load_id, multi_stop, multi_stop_why, hold, hold_reason, hold_by, hold_at, last_event, last_event_at, updated_at
		FROM chr_loads WHERE updated_at >= ? ORDER BY updated_at DESC, load_id ASC LIMIT ?`).all(String(sinceIso), limit);
}

// A released load's rows held for the hold go back to the decision, so the
// CHR-load test and the proximity test run on them again at the next tick.
function releaseHeld(db, loadId, nowIso) {
	return db.prepare(`UPDATE chr_events SET status = 'pending', hold_reason = '', next_attempt_at = ?, updated_at = ?
		WHERE load_id = ? AND status = 'held' AND hold_reason = 'load_hold'`).run(nowIso, nowIso, String(loadId)).changes;
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
	PILOT_LOAD_RE,
	PAUSE_REASONS,
	normalizePilot,
	markReady,
	readyRows,
	claim,
	finishSend,
	recoverStuck,
	giveUpOld,
	dropNotLive,
	retryRow,
	confirmedDepartures,
	finalEventCount,
	hasKey,
	insertLocation,
	supersedeOlder,
	lastLocationAt,
	eventRow,
	pendingLiveOlderThan,
	giveUpIds,
	finishRow,
	setVerify,
	EVENT_PAGE,
	listEvents,
	countsByStatus,
	recentLoads,
	releaseHeld,
	prune,
	resetForRefresh,
};
