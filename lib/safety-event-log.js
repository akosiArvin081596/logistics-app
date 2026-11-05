"use strict";

// The office's safety-event log: accidents, violations, tickets and cargo claims,
// which no data source records, so the office keeps them by hand. Nothing reads
// this log yet: no board, driver route, invoice, ledger or payout.
//
//   GET  /api/safety-events            Super Admin, Dispatcher: the events, newest
//                                      first; ?month=YYYY-MM, ?driverId=N, ?includeVoided=1
//   POST /api/safety-events            Super Admin: record an event, with a reason
//   PUT  /api/safety-events/:id        Super Admin: change its fields, with a reason
//   POST /api/safety-events/:id/void   Super Admin: void it, with a reason
//
// An event keeps its true date. A write touching a closed month's event is taken and
// marked late; no closed month's lock or figure changes.
//
// SAFETY_EVENT_LOG_ENABLED is on only when exactly "true". Off, every route answers
// 404 FEATURE_OFF before any role check and the table is never created.

const rateLimit = require("express-rate-limit");

const PATHS = Object.freeze({
	list: "/api/safety-events",
	one: "/api/safety-events/:id",
	void: "/api/safety-events/:id/void",
});

// A build default in one place, not the owner's answer: the list is his to accept
// or change before any prize reads the log.
const KINDS = Object.freeze({
	accident: "Accident",
	inspection_violation: "Roadside inspection violation",
	out_of_service: "Out-of-service order",
	moving_violation: "Moving-violation ticket",
	hos_violation: "Hours-of-service violation",
	cargo_claim: "Cargo claim",
});
// A claim counts only when the office marks it preventable, so it must say which.
const KIND_WITH_PREVENTABLE = "cargo_claim";

const MIN_REASON = 3;
const MAX_REASON = 500;
const MAX_DETAILS = 2000;
// Room for the longest edit: old and new details, every character escaped, and its reason.
const AUDIT_MAX = 10000;
const LIST_LIMIT = 500;
// Requests per 15 minutes per account: a person reading and writing a log.
const RATE_LIMIT = 120;
const FIELDS = new Set(["driverId", "eventDate", "kind", "preventable", "details", "reason"]);
const VOID_FIELDS = new Set(["reason"]);
const REQUIRED_DEPS = ["requireRole", "logAudit", "logAuditRefusal", "auditText", "periodWriteLocked", "periodLocksReadable", "appTodayKey"];

// No foreign key on directory_id: the directory's hard delete must keep working and
// this record must outlive the row, so the name is kept beside the id. No CHECK on
// kind: SQLite can't alter one, and the list above may change. recorded_late stays
// 1 once a write touches the event while its month is closed.
const SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS safety_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		directory_id INTEGER NOT NULL,
		name_when_recorded TEXT NOT NULL,
		event_date TEXT NOT NULL,
		recorded_late INTEGER NOT NULL DEFAULT 0 CHECK (recorded_late IN (0, 1)),
		kind TEXT NOT NULL,
		preventable INTEGER CHECK (preventable IS NULL OR preventable IN (0, 1)),
		details TEXT NOT NULL DEFAULT '',
		record_reason TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_by_user_id INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		updated_by TEXT,
		updated_by_user_id INTEGER,
		updated_at TEXT,
		update_reason TEXT,
		voided_by TEXT,
		voided_by_user_id INTEGER,
		voided_at TEXT,
		void_reason TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_safety_events_date ON safety_events(event_date);
	CREATE INDEX IF NOT EXISTS idx_safety_events_driver ON safety_events(directory_id, event_date);
`;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const refusal = (status, code, error) => ({ ok: false, status, code, error });

function bodyRefusal(body, allowed) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return refusal(400, "INVALID_BODY", "Send a JSON object.");
	if (Object.keys(body).some((k) => !allowed.has(k))) return refusal(400, "UNKNOWN_FIELD", `Only these fields are read: ${[...allowed].join(", ")}.`);
	return null;
}

// What changes how a line reads without showing: controls, format characters and code
// points every font draws as nothing. Separators are spaces by then (flatLine below).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Spaces and line breaks of every kind become plain spaces first, so words stay apart.
const flatLine = (s) => s.replace(/\p{White_Space}/gu, " ").replace(INVISIBLE, "");

// One line, so it reads as one audit row. The length is capped before the text is walked.
function reasonOf(raw) {
	if (typeof raw !== "string") return refusal(400, "REASON_REQUIRED", "A reason is required.");
	if (raw.length > MAX_REASON * 2) return refusal(400, "REASON_TOO_LONG", `A reason can be at most ${MAX_REASON} characters.`);
	const text = flatLine(raw).split(" ").filter(Boolean).join(" ");
	// Counted on letters and digits, so text that renders blank isn't a reason.
	if ((text.match(/[\p{L}\p{N}]/gu) || []).length < MIN_REASON) return refusal(400, "REASON_REQUIRED", "A reason is required.");
	if (text.length > MAX_REASON) return refusal(400, "REASON_TOO_LONG", `A reason can be at most ${MAX_REASON} characters.`);
	return { ok: true, value: text };
}

function detailsOf(raw) {
	if (raw === undefined || raw === null) return { ok: true, value: "" };
	if (typeof raw !== "string") return refusal(400, "INVALID_DETAILS", "Details must be text.");
	if (raw.length > MAX_DETAILS) return refusal(400, "DETAILS_TOO_LONG", `Details can be at most ${MAX_DETAILS} characters.`);
	return { ok: true, value: raw.split(/\r\n?|[\n\p{Zl}\p{Zp}]/u).map(flatLine).join("\n").trim() };
}

// A bare calendar day, checked as numbers so it never meets a time zone.
function isRealDay(v) {
	if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
	const [y, m, day] = v.split("-").map(Number);
	return y >= 2000 && m >= 1 && m <= 12 && day >= 1 && day <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fieldsRefusal(f, todayKey) {
	if (!Number.isSafeInteger(f.driverId) || f.driverId <= 0) return refusal(400, "INVALID_DRIVER", "driverId must be a directory driver's id.");
	if (!isRealDay(f.eventDate)) return refusal(400, "INVALID_DATE", "eventDate must be a real date, YYYY-MM-DD.");
	if (f.eventDate > todayKey) return refusal(400, "FUTURE_DATE", "eventDate can't be in the future.");
	if (typeof f.kind !== "string" || !has(KINDS, f.kind)) return refusal(400, "INVALID_KIND", `kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
	if (f.kind === KIND_WITH_PREVENTABLE) {
		if (typeof f.preventable !== "boolean") return refusal(400, "PREVENTABLE_REQUIRED", "A cargo claim must say whether it was preventable.");
	} else if (f.preventable !== undefined && f.preventable !== null) {
		return refusal(400, "PREVENTABLE_NOT_ALLOWED", "Only a cargo claim is marked preventable.");
	}
	return null;
}

function validateCreate(body, { todayKey }) {
	const bad = bodyRefusal(body, FIELDS);
	if (bad) return bad;
	const reason = reasonOf(body.reason);
	if (!reason.ok) return reason;
	const details = detailsOf(body.details);
	if (!details.ok) return details;
	const f = { driverId: body.driverId, eventDate: body.eventDate, kind: body.kind, preventable: body.preventable };
	const wrong = fieldsRefusal(f, todayKey);
	if (wrong) return wrong;
	return { ok: true, value: { ...f, preventable: f.kind === KIND_WITH_PREVENTABLE ? f.preventable : null, details: details.value, reason: reason.value } };
}

// A partial body over the stored row. A kind change drops the stored mark, so a
// new claim must state one and any other kind carries none.
function validateEdit(body, row, { todayKey }) {
	const bad = bodyRefusal(body, FIELDS);
	if (bad) return bad;
	const reason = reasonOf(body.reason);
	if (!reason.ok) return reason;
	const details = has(body, "details") ? detailsOf(body.details) : { ok: true, value: row.details };
	if (!details.ok) return details;
	const kind = has(body, "kind") ? body.kind : row.kind;
	const stored = row.preventable === null ? null : row.preventable === 1;
	const f = {
		driverId: has(body, "driverId") ? body.driverId : row.directory_id,
		eventDate: has(body, "eventDate") ? body.eventDate : row.event_date,
		kind,
		preventable: has(body, "preventable") ? body.preventable : (kind === row.kind ? stored : undefined),
	};
	const wrong = fieldsRefusal(f, todayKey);
	if (wrong) return wrong;
	return { ok: true, value: { ...f, preventable: f.kind === KIND_WITH_PREVENTABLE ? f.preventable : null, details: details.value, reason: reason.value } };
}

function validateVoid(body) {
	const bad = bodyRefusal(body, VOID_FIELDS);
	if (bad) return bad;
	const reason = reasonOf(body.reason);
	return reason.ok ? { ok: true, value: { reason: reason.value } } : reason;
}

function listFilters(query) {
	const q = query || {};
	const out = { month: null, driverId: null, includeVoided: false };
	if (q.month !== undefined) {
		if (typeof q.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) return refusal(400, "INVALID_MONTH", "month must be YYYY-MM.");
		out.month = q.month;
	}
	if (q.driverId !== undefined) {
		if (typeof q.driverId !== "string" || !/^[1-9]\d{0,11}$/.test(q.driverId)) return refusal(400, "INVALID_DRIVER", "driverId must be a directory driver's id.");
		out.driverId = Number(q.driverId);
	}
	if (q.includeVoided !== undefined) {
		if (q.includeVoided !== "1") return refusal(400, "INVALID_FILTER", "includeVoided takes only 1.");
		out.includeVoided = true;
	}
	return { ok: true, value: out };
}

function eventView(r) {
	return {
		id: r.id,
		driverId: r.directory_id,
		driverName: r.directory_name || r.name_when_recorded,
		eventDate: r.event_date,
		late: r.recorded_late === 1,
		kind: r.kind,
		kindLabel: has(KINDS, r.kind) ? KINDS[r.kind] : r.kind,
		preventable: r.preventable === null ? null : r.preventable === 1,
		details: r.details,
		recordReason: r.record_reason,
		createdBy: r.created_by,
		createdAt: r.created_at,
		updatedBy: r.updated_by || null,
		updatedAt: r.updated_at || null,
		updateReason: r.update_reason || null,
		voided: !!r.voided_at,
		voidedBy: r.voided_by || null,
		voidedAt: r.voided_at || null,
		voidReason: r.void_reason || null,
	};
}

const markText = (v) => (v === null ? "none" : v ? "preventable" : "not preventable");
const lateNote = (months) => (months.length ? `, recorded after ${months.join(" and ")} closed` : "");

// What an edit moved, old and new, so the audit row keeps what the row no longer does.
function changeList(row, v) {
	const out = [];
	if (v.driverId !== row.directory_id) out.push(`driver #${row.directory_id} -> #${v.driverId}`);
	if (v.eventDate !== row.event_date) out.push(`date ${row.event_date} -> ${v.eventDate}`);
	if (v.kind !== row.kind) out.push(`kind ${row.kind} -> ${v.kind}`);
	const stored = row.preventable === null ? null : row.preventable === 1;
	if (v.preventable !== stored) out.push(`mark ${markText(stored)} -> ${markText(v.preventable)}`);
	if (v.details !== row.details) out.push(`details ${JSON.stringify(row.details)} -> ${JSON.stringify(v.details)}`);
	return out;
}

function mount(app, deps) {
	const d = deps || {};
	for (const name of REQUIRED_DEPS) {
		if (typeof d[name] !== "function") throw new Error(`safety-event-log: deps.${name} is required`);
	}
	if (!d.db || typeof d.db.prepare !== "function") throw new Error("safety-event-log: deps.db is required");
	const db = d.db;
	const enabled = d.enabled === true;
	if (enabled) db.exec(SCHEMA_SQL);

	function safetyEventFlagGate(req, res, next) {
		if (!enabled) return res.status(404).json({ error: "Not found", code: "FEATURE_OFF" });
		res.set("Cache-Control", "private, no-store");
		return next();
	}

	// After the role gate, so a refused caller spends none of it.
	const limiter = rateLimit({
		windowMs: 15 * 60 * 1000,
		max: RATE_LIMIT,
		keyGenerator: (req) => `u:${req.session.user.id}`,
		message: { error: "Too many requests. Try again in a few minutes.", code: "SAFETY_EVENT_RATE_LIMITED" },
		standardHeaders: true,
	});

	const rowById = (id) => db.prepare(
		`SELECT e.*, dir.driver_name AS directory_name FROM safety_events e
		 LEFT JOIN drivers_directory dir ON dir.id = e.directory_id WHERE e.id = ?`,
	).get(id);
	const driverById = (id) => db.prepare("SELECT id, driver_name FROM drivers_directory WHERE id = ?").get(id);
	const actorOf = (req) => ({ name: String(req.session.user.username || ""), id: Number(req.session.user.id) || 0 });
	const notFound = refusal(404, "SAFETY_EVENT_NOT_FOUND", "Safety event not found.");
	const voidedAlready = refusal(409, "SAFETY_EVENT_VOIDED", "This safety event is voided and can't change.");
	const answer = (res, r) => res.status(r.status).json({ error: r.error, code: r.code });

	const idOf = (req) => (/^[1-9]\d{0,11}$/.test(String(req.params.id)) ? Number(req.params.id) : null);

	// logAudit() swallows its own failure, so the row is looked for: a write with no
	// audit row rolls back instead of standing unrecorded. All this module's audit text
	// passes here, so no caller's words can pose as a system line or a month-end refusal.
	function auditOrThrow(req, action, id, text) {
		const lastId = () => db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id;
		const before = lastId();
		d.logAudit(req, action, "safety_event", String(id), d.auditText(text, AUDIT_MAX));
		if (lastId() <= before) throw new Error("the audit row was not written");
	}

	// Which of these days' months are closed. Nothing settled reads this log, and a later
	// report freezes on its own approved rows, so a true late event is taken and marked.
	// Locks that can't be read leave the mark unknowable, so the write waits.
	function closedMonths(days) {
		if (!d.periodLocksReadable()) return { refusal: { ...refusal(409, "PERIOD_LOCK_UNREADABLE", "The month locks can't be read, so this can't be marked correctly. Nothing was saved."), period: true } };
		return { months: [...new Set(days.map((day) => day.slice(0, 7)))].filter((month) => d.periodWriteLocked(month)) };
	}

	function refused(req, res, id, what, r) {
		if (r.period) d.logAuditRefusal(req, "safety_event_write_blocked", "safety_event", id ? String(id) : "", `${what} [${r.code}]`, r.code);
		return answer(res, r);
	}

	function failed(res, what, err) {
		console.error(`[safety-event-log] ${what} failed:`, (err && err.code) || "ERROR");
		return res.status(500).json({ error: "The safety event could not be saved. Nothing was changed.", code: "SAFETY_EVENT_FAILED" });
	}

	app.get(PATHS.list, safetyEventFlagGate, d.requireRole("Super Admin", "Dispatcher"), limiter, (req, res) => {
		try {
			const f = listFilters(req.query);
			if (!f.ok) return answer(res, f);
			const { month, driverId, includeVoided } = f.value;
			const rows = db.prepare(
				`SELECT e.*, dir.driver_name AS directory_name FROM safety_events e
				 LEFT JOIN drivers_directory dir ON dir.id = e.directory_id
				 WHERE (? = 1 OR e.voided_at IS NULL)
				   AND (? IS NULL OR substr(e.event_date, 1, 7) = ?)
				   AND (? IS NULL OR e.directory_id = ?)
				 ORDER BY e.event_date DESC, e.id DESC LIMIT ?`,
			).all(includeVoided ? 1 : 0, month, month, driverId, driverId, LIST_LIMIT + 1);
			return res.json({ events: rows.slice(0, LIST_LIMIT).map(eventView), truncated: rows.length > LIST_LIMIT });
		} catch (err) {
			console.error("[safety-event-log] list failed:", (err && err.code) || "ERROR");
			return res.status(500).json({ error: "The safety events could not be read.", code: "SAFETY_EVENT_FAILED" });
		}
	});

	app.post(PATHS.list, safetyEventFlagGate, d.requireRole("Super Admin"), limiter, (req, res) => {
		try {
			const v = validateCreate(req.body, { todayKey: d.appTodayKey() });
			if (!v.ok) return answer(res, v);
			const e = v.value;
			const actor = actorOf(req);
			const outcome = db.transaction(() => {
				const driver = driverById(e.driverId);
				if (!driver) return refusal(404, "DRIVER_NOT_FOUND", "Driver not found.");
				const close = closedMonths([e.eventDate]);
				if (close.refusal) return close.refusal;
				const id = Number(db.prepare(
					`INSERT INTO safety_events (directory_id, name_when_recorded, event_date, recorded_late, kind, preventable, details, record_reason, created_by, created_by_user_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(driver.id, driver.driver_name, e.eventDate, close.months.length ? 1 : 0, e.kind, e.preventable === null ? null : Number(e.preventable), e.details, e.reason, actor.name, actor.id, new Date().toISOString()).lastInsertRowid);
				auditOrThrow(req, "safety_event_create", id,
					`${driver.driver_name} (driver #${driver.id}): ${e.kind} on ${e.eventDate}${e.preventable === null ? "" : `, ${markText(e.preventable)}`}${lateNote(close.months)}. Reason: ${e.reason}`);
				return { ok: true, id };
			})();
			if (!outcome.ok) return refused(req, res, 0, `Record ${e.kind} for driver #${e.driverId}`, outcome);
			return res.status(201).json({ success: true, event: eventView(rowById(outcome.id)) });
		} catch (err) {
			return failed(res, "create", err);
		}
	});

	app.put(PATHS.one, safetyEventFlagGate, d.requireRole("Super Admin"), limiter, (req, res) => {
		try {
			const id = idOf(req);
			if (!id) return answer(res, notFound);
			const actor = actorOf(req);
			const outcome = db.transaction(() => {
				const row = rowById(id);
				if (!row) return notFound;
				if (row.voided_at) return voidedAlready;
				const v = validateEdit(req.body, row, { todayKey: d.appTodayKey() });
				if (!v.ok) return v;
				const e = v.value;
				const close = closedMonths([row.event_date, e.eventDate]);
				if (close.refusal) return close.refusal;
				const list = changeList(row, e);
				if (!list.length) return { ok: true, changed: false };
				let name = row.name_when_recorded;
				if (e.driverId !== row.directory_id) {
					const driver = driverById(e.driverId);
					if (!driver) return refusal(404, "DRIVER_NOT_FOUND", "Driver not found.");
					name = driver.driver_name;
				}
				db.prepare(
					`UPDATE safety_events SET directory_id = ?, name_when_recorded = ?, event_date = ?, recorded_late = ?, kind = ?, preventable = ?, details = ?,
					 updated_by = ?, updated_by_user_id = ?, updated_at = ?, update_reason = ? WHERE id = ? AND voided_at IS NULL`,
				).run(e.driverId, name, e.eventDate, row.recorded_late === 1 || close.months.length ? 1 : 0, e.kind, e.preventable === null ? null : Number(e.preventable), e.details, actor.name, actor.id, new Date().toISOString(), e.reason, id);
				auditOrThrow(req, "safety_event_edit", id, `${list.join("; ")}${lateNote(close.months)}. Reason: ${e.reason}`);
				return { ok: true, changed: true };
			})();
			if (!outcome.ok) return refused(req, res, id, `Edit safety event #${id}`, outcome);
			return res.json({ success: true, changed: outcome.changed, event: eventView(rowById(id)) });
		} catch (err) {
			return failed(res, "edit", err);
		}
	});

	app.post(PATHS.void, safetyEventFlagGate, d.requireRole("Super Admin"), limiter, (req, res) => {
		try {
			const id = idOf(req);
			if (!id) return answer(res, notFound);
			const v = validateVoid(req.body);
			if (!v.ok) return answer(res, v);
			const actor = actorOf(req);
			const outcome = db.transaction(() => {
				const row = rowById(id);
				if (!row) return notFound;
				if (row.voided_at) return voidedAlready;
				const close = closedMonths([row.event_date]);
				if (close.refusal) return close.refusal;
				db.prepare("UPDATE safety_events SET recorded_late = ?, voided_by = ?, voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL")
					.run(row.recorded_late === 1 || close.months.length ? 1 : 0, actor.name, actor.id, new Date().toISOString(), v.value.reason, id);
				auditOrThrow(req, "safety_event_void", id,
					`${row.directory_name || row.name_when_recorded} (driver #${row.directory_id}): ${row.kind} on ${row.event_date} voided${lateNote(close.months)}. Reason: ${v.value.reason}`);
				return { ok: true };
			})();
			if (!outcome.ok) return refused(req, res, id, `Void safety event #${id}`, outcome);
			return res.json({ success: true, event: eventView(rowById(id)) });
		} catch (err) {
			return failed(res, "void", err);
		}
	});

	return { PATHS, enabled };
}

module.exports = {
	mount, PATHS, KINDS, KIND_WITH_PREVENTABLE, SCHEMA_SQL, LIST_LIMIT, RATE_LIMIT, MIN_REASON, MAX_REASON, MAX_DETAILS,
	validateCreate, validateEdit, validateVoid, listFilters, isRealDay,
};
