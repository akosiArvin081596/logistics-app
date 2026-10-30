"use strict";
// The rows of GET /api/admin/cancelled-loads, the Super Admin "Cancelled loads"
// page: a list only. Nothing here un-cancels a load or writes anything.
//
// Which loads: the rows of the deduplicated Job Tracking view whose status cell
// passes the money filter's own test (the caller's CANCELED_STATUS_RE, on the
// columns excludeDroppedLoads() resolves). A row with no Load ID is listed, with
// no records.
//
// When, who and why live only in the app's records. A load's history rows (any
// source) and its status-writing audit rows are its events; a history row and an
// audit row of the same kind and target within TWIN_WINDOW_MS are one event. The
// latest event decides: no event is "none"; anything but a recorded transition
// to a cancelled status (a re-dispatch, a later status, a later row whose target
// or time can't be read) is "changed-after"; otherwise its kind names it. A blank
// is never filled with a guess.
//
// Each row: loadId (as the caller's shownLoadId() serves it; "" with none),
// hasLoadId, rowIndex, recordedBy, cancelledAt (ISO-8601 "Z", to the second),
// cancelledDay (in `timeZone`), cancelledBy, cancelledByRole,
// cancelledBySharedLogin, reason, driver (recorded with the cancel, else the
// row's Driver cell), pickup and dropoff (the caller's laneOf()), pickupAt (the
// pickup appointment cell as stored) and alsoDeleted. Recorded cancels come
// first, newest first; the rest follow by sheet row, newest first.
//
// Pure: no database, sheet or network. recordQueries() builds the parameterized
// reads the route and scripts/cancelled-loads-report.js both run, so the report
// counts exactly what the page lists.

const appTime = require("./app-time");
const { isSharedLoginName } = require("./sign-in");

// A history row and an audit row closer than this (same load, kind and target)
// are one change: each route writes the two a few lines apart.
const TWIN_WINDOW_MS = 60 * 1000;
// Audit text is cut to this before a pattern runs; every pattern is bounded too.
const AUDIT_TEXT_MAX = 4000;
// The audit actions that set a load's status, and the re-dispatch that revives one.
const AUDIT_ACTIONS = Object.freeze(["cancel_load", "status_override", "update_status", "dispatch_load"]);
const AUDIT_KIND = new Map([["cancel_load", "cancel"], ["status_override", "override"], ["update_status", "manual"], ["dispatch_load", "dispatch"]]);
// The history sources whose transition to a cancelled status the page shows.
const RECORDED_BY = new Map([["cancel", "cancel-button"], ["override", "status-override"], ["manual", "driver-status"]]);
const RECORDED_BY_VALUES = Object.freeze([...RECORDED_BY.values(), "changed-after", "none"]);
// For these the history actor is the session's account; a driver status change
// stores the driver named in the request, who need not be the person.
const ACTOR_IS_ACCOUNT = new Set(["cancel", "override"]);
// excludeDroppedLoads()'s column rules (scripts/test-cancelled-loads-lib.js pins them).
const LOAD_ID_COL_RE = /load.?id|job.?id/i;
const STATUS_COL_RE = /^(job[\s._-]?)?status$/i;
const STATUS_COL_FALLBACK_RE = /status/i;
// Keys per statement, so none passes SQLite's lowest placeholder limit (999).
const HISTORY_CHUNK = 500;
const AUDIT_CHUNK = 250;

// The audit texts server.js writes, with its em dash and arrow characters:
//   cancel_load     Cancelled load <id>[ (driver: <name>)] — reason: <reason>
//   status_override  Override "<old>" → "<new>" by <account>: <reason>
//   update_status    Status changed to "<new>" for load <id> (driver: <name>)
const CANCEL_LOAD_RE = /^Cancelled load [^\n]{1,200}?(?: \(driver: ([^\n]{1,200})\))? — reason: ([\s\S]{1,4000})$/;
const STATUS_OVERRIDE_RE = /^Override "([^"\n]{0,100})" → "([^"\n]{1,100})" by [^\n]{0,200}?: ([\s\S]{1,4000})$/;
const UPDATE_STATUS_RE = /^Status changed to "([^"\n]{1,100})" for load [^\n]{0,200} \(driver: [^\n]{0,200}\)$/;
const ISO_Z_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

const text = (v) => (v == null ? "" : String(v));
const auditText = (details) => text(details).slice(0, AUDIT_TEXT_MAX);

// The driver and reason of a cancel_load row; null when the text doesn't parse.
function parseCancelLoadAudit(details) {
	const m = CANCEL_LOAD_RE.exec(auditText(details));
	return m ? { driver: text(m[1]).trim(), reason: m[2].trim() } : null;
}

// The statuses and reason of a status_override row; null when it doesn't parse.
function parseStatusOverrideAudit(details) {
	const m = STATUS_OVERRIDE_RE.exec(auditText(details));
	return m ? { from: m[1], to: m[2], reason: m[3].trim() } : null;
}

// The status an update_status row set; null when it doesn't parse.
function parseUpdateStatusAudit(details) {
	const m = UPDATE_STATUS_RE.exec(auditText(details));
	return m ? { to: m[1] } : null;
}

// An ISO-8601 "Z" instant as epoch ms; NaN for anything else, so a stamp without
// a zone is never read on this process's clock.
function isoMs(v) {
	const s = text(v).trim();
	const m = ISO_Z_RE.exec(s);
	if (!m) return NaN;
	const ms = Date.parse(s);
	// An impossible date ("02-30") would roll over to another day: refuse it.
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` ? ms : NaN;
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function cell(row, col) {
	if (!row || !col) return "";
	return text(row[col]).trim();
}

function findCol(headers, re) {
	return headers.find((h) => re.test(h)) || null;
}

// The Load ID and status columns, as excludeDroppedLoads() resolves them.
function sheetColumns(headers) {
	const h = Array.isArray(headers) ? headers : [];
	return {
		loadIdCol: findCol(h, LOAD_ID_COL_RE),
		statusCol: findCol(h, STATUS_COL_RE) || findCol(h, STATUS_COL_FALLBACK_RE),
	};
}

// The caller's cancelled-status test, without a g or y flag (test() would keep state).
function statusTest(re) {
	if (!(re instanceof RegExp)) throw new TypeError("cancelledStatusRe must be the server's CANCELED_STATUS_RE");
	const safe = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
	return (v) => safe.test(text(v).trim());
}

function needFunction(fn, message) {
	if (typeof fn !== "function") throw new TypeError(message);
}

// The cancelled rows among `rows`, each { row, key } (key: normalizeLoadId(), "" with none).
function cancelledSheetRows({ rows, headers, cancelledStatusRe, normalizeLoadId }) {
	const isCancelled = statusTest(cancelledStatusRe);
	needFunction(normalizeLoadId, "normalizeLoadId must be the server's own");
	const { loadIdCol, statusCol } = sheetColumns(headers);
	if (!statusCol) return [];
	const out = [];
	for (const row of rows || []) {
		if (!row || !isCancelled(row[statusCol])) continue;
		out.push({ row, key: loadIdCol ? normalizeLoadId(row[loadIdCol]) : "" });
	}
	return out;
}

// The keys the page reads records for: each cancelled load's, once, none blank.
function cancelledKeys(opts) {
	return [...new Set(cancelledSheetRows(opts).map((c) => c.key).filter(Boolean))];
}

// The page's reads as { sql, params } statements, every key in params. The
// route and the report run these same statements.
function recordQueries(keys) {
	const list = [...new Set((keys || []).map(text).filter(Boolean))];
	const marks = (n) => new Array(n).fill("?").join(", ");
	const history = [];
	for (let i = 0; i < list.length; i += HISTORY_CHUNK) {
		const chunk = list.slice(i, i + HISTORY_CHUNK);
		history.push({
			sql: `SELECT id, load_id, new_status, source, actor, reason, strftime('%Y-%m-%dT%H:%M:%SZ', changed_at) AS at FROM load_status_history WHERE load_id IN (${marks(chunk.length)})`,
			params: chunk,
		});
	}
	const audit = [];
	for (let i = 0; i < list.length; i += AUDIT_CHUNK) {
		// An audit row keeps the ID as the client sent it, with or without its "#".
		const ids = list.slice(i, i + AUDIT_CHUNK).flatMap((k) => [k, `#${k}`]);
		audit.push({
			sql: `SELECT id, timestamp, username, role, action, entity_id, details FROM audit_trail WHERE entity = 'load' AND action IN (${marks(AUDIT_ACTIONS.length)}) AND LOWER(TRIM(entity_id)) IN (${marks(ids.length)})`,
			params: [...AUDIT_ACTIONS, ...ids],
		});
	}
	return { history, audit, deleted: { sql: "SELECT load_id FROM deleted_loads", params: [] } };
}

// One event per history row: { at, kind, to, by, role, reason, driver, histId, auditId }.
function historyEvent(h) {
	return {
		at: isoMs(h.at),
		kind: text(h.source).trim().toLowerCase(),
		to: text(h.new_status).trim(),
		by: text(h.actor).trim(),
		role: "",
		reason: text(h.reason).trim(),
		driver: "",
		histId: Number(h.id) || 0,
		auditId: 0,
	};
}

// One event per audit row. A cancel_load's target is its action; the other two
// carry theirs in the text, and `to` is null when that doesn't parse.
function auditEvent(a) {
	const ev = { at: isoMs(a.timestamp), kind: AUDIT_KIND.get(a.action), to: null, by: text(a.username).trim(), role: text(a.role).trim(), reason: "", driver: "", histId: 0, auditId: Number(a.id) || 0 };
	if (a.action === "cancel_load") {
		ev.to = "Cancelled";
		const p = parseCancelLoadAudit(a.details);
		if (p) { ev.reason = p.reason; ev.driver = p.driver; }
	} else if (a.action === "dispatch_load") {
		ev.to = "Dispatched";
	} else if (a.action === "status_override") {
		const p = parseStatusOverrideAudit(a.details);
		if (p) { ev.to = p.to; ev.reason = p.reason; }
	} else {
		const p = parseUpdateStatusAudit(a.details);
		if (p) ev.to = p.to;
	}
	return ev;
}

const sameStatus = (a, b) => a != null && b != null && a.trim().toLowerCase() === b.trim().toLowerCase();

// By time; at the same instant a history-backed event before an audit-only one;
// then by id within its table (the two tables' ids don't compare).
function eventOrder(x, y) {
	return (x.at - y.at) || ((x.histId ? 0 : 1) - (y.histId ? 0 : 1)) || ((x.histId || x.auditId) - (y.histId || y.auditId));
}

// Each audit row takes the nearest unpaired history row of its kind and target
// within the window as its twin. The pair is one event: history's time and
// reason, the audit row's account, role and driver.
function mergeTwins(hist, audits) {
	const used = new Set();
	const out = [];
	for (const a of [...audits].sort(eventOrder)) {
		let twin = null;
		if (a.to != null && Number.isFinite(a.at)) {
			for (const h of hist) {
				if (used.has(h) || h.kind !== a.kind || !Number.isFinite(h.at) || !sameStatus(h.to, a.to)) continue;
				const gap = Math.abs(h.at - a.at);
				if (gap > TWIN_WINDOW_MS) continue;
				const best = twin ? Math.abs(twin.at - a.at) : Infinity;
				if (gap < best || (gap === best && h.histId < twin.histId)) twin = h;
			}
		}
		if (!twin) { out.push(a); continue; }
		used.add(twin);
		out.push({
			...twin,
			by: a.by || (ACTOR_IS_ACCOUNT.has(twin.kind) ? twin.by : ""),
			role: a.role,
			reason: twin.reason || a.reason,
			driver: a.driver,
			auditId: a.auditId,
		});
	}
	for (const h of hist) if (!used.has(h)) out.push({ ...h, by: ACTOR_IS_ACCOUNT.has(h.kind) ? h.by : "" });
	return out;
}

// Each listed key's events. History keeps the key normalized (the read matched it
// exactly); an audit row keeps the ID as sent, so it is normalized here.
function eventsByKey({ keys, history, audits, normalizeLoadId }) {
	const hist = new Map();
	const aud = new Map();
	const push = (m, k, e) => { if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
	for (const h of history || []) {
		const k = text(h && h.load_id);
		if (keys.has(k)) push(hist, k, historyEvent(h));
	}
	for (const a of audits || []) {
		if (!a || !AUDIT_KIND.has(a.action)) continue;
		const k = normalizeLoadId(a.entity_id);
		if (keys.has(k)) push(aud, k, auditEvent(a));
	}
	const out = new Map();
	for (const k of keys) out.set(k, mergeTwins(hist.get(k) || [], aud.get(k) || []));
	return out;
}

// The event shown for one load, or none: { recordedBy, event }.
function decide(events, isCancelled) {
	if (!events || !events.length) return { recordedBy: "none", event: null };
	// An event with no readable time can't be placed, so nothing is shown past it.
	if (events.some((e) => !Number.isFinite(e.at))) return { recordedBy: "changed-after", event: null };
	const last = [...events].sort(eventOrder)[events.length - 1];
	const recordedBy = RECORDED_BY.get(last.kind);
	if (!recordedBy || last.to == null || !isCancelled(last.to)) return { recordedBy: "changed-after", event: null };
	return { recordedBy, event: last };
}

//   rows, headers        the deduplicated Job Tracking view (getJobTrackingCached())
//   cancelledStatusRe    CANCELED_STATUS_RE;  normalizeLoadId: the server's own
//   shownLoadId(raw, row) the Load ID as this session may see it (required)
//   history, audits, deleted   the rows recordQueries() reads
//   cols                 jobTrackingMonthCols() ({ driverCol, pickupDateCol })
//   laneOf(row)          { pickup, dropoff };  timeZone: APP_TIMEZONE
function cancelledLoadRows({ rows, headers, cancelledStatusRe, normalizeLoadId, shownLoadId, history = [], audits = [], deleted = [], cols = {}, laneOf = null, timeZone }) {
	needFunction(shownLoadId, "shownLoadId is required: every Load ID leaves as this session may see it");
	const isCancelled = statusTest(cancelledStatusRe);
	const zone = timeZone || appTime.appTimeZone();
	const listed = cancelledSheetRows({ rows, headers, cancelledStatusRe, normalizeLoadId });
	const keys = new Set(listed.map((c) => c.key).filter(Boolean));
	const deletedKeys = new Set((deleted || []).map((d) => normalizeLoadId(d && d.load_id)).filter(Boolean));
	const events = eventsByKey({ keys, history, audits, normalizeLoadId });
	const { loadIdCol } = sheetColumns(headers);
	const c = cols || {};

	const recorded = [];
	const rest = [];
	for (const { row, key } of listed) {
		const { recordedBy, event: e } = key ? decide(events.get(key), isCancelled) : { recordedBy: "none", event: null };
		const lane = (laneOf && laneOf(row)) || {};
		const out = {
			loadId: key ? shownLoadId(text(row[loadIdCol]), row) : "",
			hasLoadId: Boolean(key),
			rowIndex: Number(row._rowIndex) || 0,
			recordedBy,
			cancelledAt: e ? isoSeconds(e.at) : "",
			cancelledDay: e ? appTime.dayInZone(new Date(e.at), zone) : "",
			cancelledBy: e ? e.by : "",
			cancelledByRole: e ? e.role : "",
			cancelledBySharedLogin: Boolean(e && e.by && isSharedLoginName(e.by)),
			reason: e ? e.reason : "",
			driver: (e && e.driver) || cell(row, c.driverCol),
			pickup: text(lane.pickup),
			dropoff: text(lane.dropoff),
			pickupAt: cell(row, c.pickupDateCol),
			alsoDeleted: Boolean(key) && deletedKeys.has(key),
		};
		if (e) recorded.push({ at: e.at, out });
		else rest.push(out);
	}
	recorded.sort((x, y) => (y.at - x.at) || (y.out.rowIndex - x.out.rowIndex));
	rest.sort((x, y) => y.rowIndex - x.rowIndex);
	return [...recorded.map((r) => r.out), ...rest];
}

module.exports = {
	TWIN_WINDOW_MS,
	AUDIT_ACTIONS,
	RECORDED_BY_VALUES,
	sheetColumns,
	cancelledSheetRows,
	cancelledKeys,
	cancelledLoadRows,
	recordQueries,
	parseCancelLoadAudit,
	parseStatusOverrideAudit,
	parseUpdateStatusAudit,
};
