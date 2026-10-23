"use strict";
// The rows of GET /api/admin/deleted-loads: the Super Admin "Deleted loads"
// page, and (with RESTORE_DELETED_LOADS_ENABLED on) its "Restored loads"
// history. Nothing here restores a load.
//
// One row per deleted_loads row, in the order given (the route reads them newest
// first). Each row carries:
//   id           deleted_loads.id: the row's one unique key (a load deleted twice in
//                the same second has two rows alike in every other field)
//   loadId       deleted_loads.load_id as stored (the delete stores normalizeLoadId())
//   rowIndex     deleted_loads.row_index as stored (0 when the delete matched no row)
//   deletedAt    deleted_at (SQLite CURRENT_TIMESTAMP, UTC) as ISO-8601 "Z", or ""
//   deletedDay   that instant's business day in `timeZone` (APP_TIMEZONE), or ""
//   deletedBy    deleted_loads.deleted_by as stored
//   pickup, dropoff, driver
//                from the load's Job Tracking row ("" with no row): the row at the
//                stored row index when it carries the load, else the first match
//   months       [{ month: "YYYY-MM", closed }], sorted; `closed` is isLocked()
//   monthsFrom   "sheet": loadRowPeriods() over the matched rows, when every one resolves
//                "audit": no row, or a row that doesn't resolve, so the months named
//                         in the load's delete_load audit entry nearest the deletion
//                "none":  neither names a month
//
// Rows match the delete route's way (DELETE /api/loads/:loadId): every Job
// Tracking row whose Load ID gives the same normalizeLoadId() key.
//
// Pure: no database, sheet or network. The caller passes the reads and the
// server's own helpers, so the months and the lock answer are the guard's.

const appTime = require("./app-time");

// deleted_at as SQLite writes it ("YYYY-MM-DD HH:MM:SS", UTC). The "T" and "Z"
// forms are accepted too, in case a row was written by hand.
const SQLITE_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z?$/;

// The epoch ms of a stored UTC stamp, or NaN.
function sqliteUtcMs(v) {
	const m = SQLITE_UTC_RE.exec(String(v == null ? "" : v).trim());
	if (!m) return NaN;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	// Date.UTC rolls an impossible date over ("2026-02-30" -> Mar 2): refuse it.
	return new Date(ms).toISOString().slice(0, 19) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` ? ms : NaN;
}

// The months a delete_load audit entry names: "... — settlement month 2026-05"
// or "... — settlement months 2026-05, 2026-06" (DELETE /api/loads/:loadId
// writes it). [] when it names none ("no matching Job Tracking row"). The text
// is capped before the match, and the pattern is bounded.
const AUDIT_TEXT_MAX = 4000;
const AUDIT_MONTHS_RE = /settlement months? (\d{4}-\d{2}(?:, \d{4}-\d{2}){0,119})/;
function auditMonths(details) {
	const m = AUDIT_MONTHS_RE.exec(String(details == null ? "" : details).slice(0, AUDIT_TEXT_MAX));
	return m ? [...new Set(m[1].split(", "))].sort() : [];
}

// Of a load's delete_load audit entries ({ timestamp, details }), the one
// written nearest `deletedMs` (the delete writes it just after its insert).
// With no usable time on either side, the latest entry. null with none.
function nearestAudit(entries, deletedMs) {
	const list = Array.isArray(entries) ? entries : [];
	if (!list.length) return null;
	if (Number.isNaN(deletedMs)) return list[list.length - 1];
	let best = null;
	let bestGap = Infinity;
	for (const e of list) {
		const t = Date.parse(String((e && e.timestamp) || ""));
		const gap = Number.isNaN(t) ? Infinity : Math.abs(t - deletedMs);
		if (best === null || gap < bestGap) { best = e; bestGap = gap; }
	}
	return best;
}

function cell(row, col) {
	if (!row || !col) return "";
	const v = row[col];
	return v == null ? "" : String(v).trim();
}

//   deleted          deleted_loads rows { load_id, row_index, deleted_at, deleted_by }
//   rows, cols       Job Tracking's rows and jobTrackingMonthCols() (with tripCover
//                    when the caller sets it, as the delete route does)
//   auditsFor(id)    the delete_load audit entries for a stored load id
//   laneOf(row)      { pickup, dropoff } for one row (the dashboard's city lines)
//   normalizeLoadId, loadRowPeriods, isLocked   the server's own
//   timeZone         APP_TIMEZONE
function deletedLoadRows({ deleted, rows, cols, auditsFor, laneOf, normalizeLoadId, loadRowPeriods, isLocked, timeZone }) {
	const zone = timeZone || appTime.appTimeZone();
	const byKey = new Map();
	if (cols && cols.loadIdCol) {
		for (const r of rows || []) {
			const key = normalizeLoadId(r[cols.loadIdCol]);
			if (!key) continue;
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(r);
		}
	}
	return (deleted || []).map((d) => {
		const stored = d.load_id == null ? "" : String(d.load_id);
		const rowIndex = Number(d.row_index) || 0;
		const matches = byKey.get(normalizeLoadId(stored)) || [];
		const shown = (rowIndex && matches.find((r) => r._rowIndex === rowIndex)) || matches[0] || null;

		// The sheet answers only when EVERY matched row resolves: a row whose dates
		// can't be read could book the load into any month, a closed one included,
		// so the readable rows alone would be a partial answer shown as a whole one.
		const sheetMonths = new Set();
		let allResolved = matches.length > 0;
		for (const r of matches) {
			const p = loadRowPeriods(r, cols);
			if (p && p.resolved) for (const m of p.periods) sheetMonths.add(m);
			else allResolved = false;
		}
		const ms = sqliteUtcMs(d.deleted_at);
		let months = allResolved ? [...sheetMonths].sort() : [];
		let monthsFrom = "sheet";
		if (!months.length) {
			const entry = nearestAudit(auditsFor(stored), ms);
			months = entry ? auditMonths(entry.details) : [];
			monthsFrom = months.length ? "audit" : "none";
		}

		const lane = shown ? laneOf(shown) || {} : {};
		return {
			id: Number.isInteger(d.id) ? d.id : null,
			loadId: stored,
			rowIndex,
			deletedAt: Number.isNaN(ms) ? "" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
			deletedDay: Number.isNaN(ms) ? "" : appTime.dayInZone(new Date(ms), zone),
			deletedBy: d.deleted_by == null ? "" : String(d.deleted_by),
			pickup: lane.pickup || "",
			dropoff: lane.dropoff || "",
			driver: cell(shown, cols && cols.driverCol),
			months: months.map((month) => ({ month, closed: !!isLocked(month) })),
			monthsFrom,
		};
	});
}

// The page's "Restored loads" history (the restore plan, section 4): one row per
// restore_load audit row ({ id, timestamp, username, entity_id, details }), in the
// order given (the route reads the last 90 days, newest first, at most 100):
//   id, loadId (the normalized key, as the delete keys it), restoredBy,
//   restoredAt (ISO-8601 "Z", or ""), restoredDay (its business day in
//   `timeZone`), reason (the text after the first ". Reason: "), months (the
//   "settlement month(s)" the row names). Super Admins only: the reason is never
//   in a notice.
const REASON_MARK = ". Reason: ";
function restoredLoadRows(audits, { timeZone } = {}) {
	const zone = timeZone || appTime.appTimeZone();
	return (Array.isArray(audits) ? audits : []).map((a) => {
		const details = String(a.details == null ? "" : a.details).slice(0, AUDIT_TEXT_MAX);
		const ms = Date.parse(String(a.timestamp || ""));
		const cut = details.indexOf(REASON_MARK);
		return {
			id: Number.isInteger(a.id) ? a.id : null,
			loadId: a.entity_id == null ? "" : String(a.entity_id),
			restoredBy: a.username == null ? "" : String(a.username),
			restoredAt: Number.isNaN(ms) ? "" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
			restoredDay: Number.isNaN(ms) ? "" : appTime.dayInZone(new Date(ms), zone),
			reason: cut === -1 ? "" : details.slice(cut + REASON_MARK.length),
			months: auditMonths(cut === -1 ? details : details.slice(0, cut)),
		};
	});
}

// Each deleted row with `restoredBefore`: the latest earlier restore of its key
// ({ at, day, by }) from `restored` (newest first), or null.
function withRestoredBefore(loads, restored, normalizeLoadId) {
	const latest = new Map();
	for (const h of restored || []) {
		const key = normalizeLoadId(h.loadId);
		if (key && !latest.has(key)) latest.set(key, { at: h.restoredAt, day: h.restoredDay, by: h.restoredBy });
	}
	return (loads || []).map((l) => ({ ...l, restoredBefore: latest.get(normalizeLoadId(l.loadId)) || null }));
}

module.exports = { deletedLoadRows, auditMonths, nearestAudit, sqliteUtcMs, restoredLoadRows, withRestoredBefore };
