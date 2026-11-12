"use strict";
// Restoring a soft-deleted load, the create routes' check for a Load ID an old delete still names, and the Super
// Admins' word of a live row such a delete hides. On only when server.js passes `enabled`; off, nothing here
// touches the database or mounts a route, so the app answers exactly as it did without it.

const crypto = require("crypto");
const appTime = require("./app-time");
const { normalizeLoadId } = require("./ratecon-load");
const { everyJobTrackingRow } = require("./job-tracking-every-row");
const { sqliteUtcMs, auditMonths, nearestAudit } = require("./deleted-loads-view");
const { hasContact } = require("./broker-contact");

const ROLE = "Super Admin";
const RESTORE_PATH = "/api/admin/deleted-loads/:id/restore";
// Super Admin-only dispatch notices (server.js SUPER_ADMIN_ONLY_NOTICE_TYPES lists both): a live row an old delete
// hides, and a restore or a cleared delete, with its reason.
const NOTICE_TYPE = "load-hidden-by-delete";
const RESTORED_NOTICE_TYPE = "deleted-load-restored";
// The server's helpers the mount takes; every one is required, so a wiring slip fails at start.
const HELPERS = ["requireRole", "refuseCrossSite", "periodLocksReadable", "getJobTrackingCached", "jobTrackingMonthCols",
	"tripDayLockCover", "loadRowPeriods", "lockedAmong", "periodLabel", "notifyChange", "jtCacheInvalidate",
	"pickAddressColumn", "excludeDroppedLoads", "notifySuperAdmins"];
const AUDIT_SQL = "INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const DELETE_AUDIT_SQL = "SELECT timestamp, details FROM audit_trail WHERE entity = 'load' AND entity_id = ? AND action = 'delete_load' ORDER BY id";
const TOMBSTONE_COLS = "id, load_id, row_index, deleted_at, deleted_by";
// Sheet cells are read only this far before a digest is made of them.
const CELL_MAX = 1000;
// A reason's limits, the sheet-row delete's: 3 to 500 characters once trimmed and cleaned.
const REASON_MIN = 3;
const REASON_MAX = 500;
const NOTHING_CHANGED = "Nothing was changed.";
const NOTHING_CREATED = "Nothing was created.";

// "row 4", "rows 2 and 4", "rows 2, 4 and 6".
function rowsText(rows) {
	const list = (Array.isArray(rows) ? rows : []).map(String);
	if (list.length < 2) return `row ${list[0] || ""}`.trim();
	return `rows ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const WORDS = Object.freeze({
	BAD_ID: "That deleted load isn't on the list. Reload the page and try again.",
	BAD_MODE: "Choose Restore the deleted load or Create it as new.",
	LOCKS_UNREADABLE: "The month-end lock table could not be read, so closed months can't be checked. Nothing was changed. Try again in a moment.",
	SHEET_UNREADABLE: "Job Tracking could not be read, so the load's row and month can't be checked. Nothing was changed. Try again in a moment.",
	NOT_DELETED: "This load isn't deleted any more; it may have been restored already. Nothing was changed.",
	RESTORE_FAILED: "The load could not be restored. Nothing was changed. Try again in a moment.",
	DELETES_UNREADABLE: "The deleted loads could not be read, so this Load ID can't be checked against them. Nothing was created. Try again in a moment.",
	HEADER_UNREADABLE: "Job Tracking's header row could not be read, so this new load can't be checked against deleted loads. Nothing was created. Try again in a moment.",
	CLEAR_FAILED: "The old delete of this Load ID could not be cleared, so nothing was created. Try again in a moment.",
	noSheetRow: (id) => `Load ${id} has no row in Job Tracking any more, so restoring it would bring nothing back. Nothing was changed.`,
	unresolved: (id) => `Load ${id}'s dates in Job Tracking don't give a month, so it can't be told whether restoring it would change a closed month. Correct the dates on its row, then try again. Nothing was changed.`,
	finalized: (id, labels) => (labels.length > 1
		? `Load ${id} is in closed months (${labels.join(", ")}). Restoring it would change settled payouts, which is a payout question. Nothing was changed.`
		: `Load ${id} is in a closed month (${labels.join(", ")}). Restoring it would change a settled payout, which is a payout question. Nothing was changed.`),
	deletedRowsPresent: (id, rows) => (Array.isArray(rows) && rows.length > 1
		? `${capital(rowsText(rows))} may be load ${id}'s rows from before its delete, so creating it as new could bring those rows back too. Restore the deleted load instead, or remove those rows first. Nothing was changed.`
		: `${capital(rowsText(rows))} may be load ${id}'s row from before its delete, so creating it as new could bring that row back too. Restore the deleted load instead, or remove that row first. Nothing was changed.`),
	reasonRequired: (nothing) => `A reason of 3 to 500 characters is required: it is saved in the audit trail and sent to the Super Admins. ${nothing}`,
	reasonTooLong: (nothing) => `The reason is longer than 500 characters. Shorten it, then try again. ${nothing}`,
	reasonContact: (nothing) => `The reason can't hold an email address or a phone number. ${nothing}`,
	askSuperAdmin: (id) => `Load ${id} can't be created here because an earlier load with this ID was deleted. Ask a Super Admin to restore it or create it as new.`,
	sheetUnreadableForCreate: (id) => `Job Tracking could not be read, so it can't be told whether the deleted load ${id} still has a row there. Nothing was created. Try again in a moment.`,
	choice: (id, who, day) => `Load ${id} was deleted${day ? ` on ${day}` : ""}${who ? ` by ${who}` : ""}. Restore the deleted load, or create it as new.`,
	stale: (id) => `The delete record for load ${id} changed after you chose, so nothing was created. Choose again.`,
	rowPresent: (id, row) => `Row ${row} still holds load ${id}: restore it instead, or remove that row first. Nothing was created.`,
	noticeHiddenTitle: (id) => `Load ${id} is hidden by an earlier delete`,
	noticeHiddenBody: (who, day) => `Deleted${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}. Review it from the banner on the dashboard.`,
	noticeHiddenClosedTitle: (id, n) => `Load ${id} is hidden by an earlier delete, in ${n > 1 ? "closed months" : "a closed month"}`,
	noticeHiddenClosedBody: (who, day, labels) => {
		const list = Array.isArray(labels) ? labels : [];
		const months = list.length > 1
			? `Its months (${list.join(", ")}) are closed, so restoring it would change settled payouts`
			: `Its month (${list.join(", ")}) is closed, so restoring it would change a settled payout`;
		return `Deleted${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}. ${months}, which is a payout question.`;
	},
	noticeRefusedTitle: (id) => `Load ${id} could not be created: an earlier load with this ID was deleted`,
	noticeRefusedBody: (tried, who, day) => `${tried} tried to create it. The earlier load was deleted${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}. To choose between restoring it and creating it as new, create it yourself from the rate con or New Job.`,
	noticeRestoredTitle: (id) => `Load ${id} was restored`,
	noticeRestoredBody: (who, reason) => `Restored by ${who}. Reason: ${reason}`,
	noticeClearedTitle: (id, n) => `Load ${id}'s old delete${n > 1 ? "s were" : " was"} cleared`,
	noticeClearedBody: (who, reason) => `Cleared by ${who}, so the load counts as new. Reason: ${reason}`,
});

// deleted_loads.id as the route's :id carries it: a positive whole number, else 0.
function restoreIdOf(v) {
	const s = String(v == null ? "" : v);
	return /^[1-9][0-9]{0,14}$/.test(s) ? Number(s) : 0;
}

// The "Create it as new" a re-sent create carries, or null: the newest delete's id and the number of deletes the
// choice was shown (each 0 when not a positive whole number, so the request is refused as stale rather than read as
// no choice at all), and the reason as sent (checked by onCreate()).
function choiceOf(body) {
	const c = body && typeof body === "object" ? body.deletedLoadChoice : null;
	if (!c || typeof c !== "object" || Array.isArray(c) || c.action !== "create_new") return null;
	const whole = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
	return { action: "create_new", id: whole(c.id), count: whole(c.count), reason: c.reason };
}

function modeOf(body) {
	const m = body && typeof body === "object" && !Array.isArray(body) ? body.mode : undefined;
	if (m === undefined || m === null || m === "" || m === "restore") return "restore";
	return m === "create_new" ? "create_new" : null;
}

// What a row is: its pickup and drop-off addresses and appointments. Its place
// on the sheet is not part of it (sorting moves a row), nor its status.
function rowDigest(row, cols) {
	const cell = (col) => (col && row && row[col] != null
		? String(row[col]).slice(0, CELL_MAX).replace(/\s+/g, " ").trim().toLowerCase() : "");
	const c = cols || {};
	const text = [cell(c.pickupAddress), cell(c.dropoffAddress), cell(c.pickupDate), cell(c.dropoffDate)].join("\u001f");
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function parseDigests(v) {
	if (v == null || v === "") return null;
	try {
		const a = JSON.parse(v);
		return Array.isArray(a) ? a.filter((d) => typeof d === "string") : null;
	} catch {
		return null;
	}
}

// The column the digests live in, added once at start (an additive change).
function ensureSchema(db) {
	const cols = db.prepare("PRAGMA table_info(deleted_loads)").all().map((c) => c.name);
	if (!cols.includes("row_digests")) db.exec("ALTER TABLE deleted_loads ADD COLUMN row_digests TEXT");
}

// `auditText` is server.js's own: a reason is cleaned exactly as the audit trail keeps text. It comes with create(),
// not mount(), because the create routes are lifted without the mount in their runners.
function create({ db = null, enabled = false, now = () => new Date(), log = console, timeZone = null, auditText = null } = {}) {
	const on = enabled === true;
	const zone = timeZone || appTime.appTimeZone();
	let h = null;
	// A create's checked "Create it as new", kept from its duplicate read to its append (clearBeforeAppend()).
	const pending = new WeakMap();

	const userOf = (req) => (req && req.session && req.session.user) || {};
	const whoOf = (user) => user.username || user.full_name || "A Super Admin";
	const isoOf = (stamp) => {
		const ms = sqliteUtcMs(stamp);
		return Number.isNaN(ms) ? "" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	};
	const dayOf = (stamp) => {
		const ms = sqliteUtcMs(stamp);
		return Number.isNaN(ms) ? "" : appTime.businessDayOf(new Date(ms), zone);
	};
	const tombstonesFor = (key) => db.prepare(`SELECT ${TOMBSTONE_COLS} FROM deleted_loads ORDER BY id`).all()
		.filter((r) => normalizeLoadId(r.load_id) === key);
	const insertAudit = (user, action, entityId, details) => db.prepare(AUDIT_SQL).run(
		now().toISOString(), user.id || 0, user.username || "system", user.role || "system", action, "load", String(entityId), details);
	const deleteRecord = (row) => `deleted_loads row ${row.id}, deleted ${isoOf(row.deleted_at) || "at an unknown time"} by ${row.deleted_by || "an unknown user"}`;
	const monthsText = (months) => (months.length ? ` — settlement month${months.length > 1 ? "s" : ""} ${months.join(", ")}` : "");
	// The months a delete's own delete_load audit row names (the one nearest the delete).
	const namedMonths = (t) => {
		const entry = nearestAudit(db.prepare(DELETE_AUDIT_SQL).all(String(t.load_id)), sqliteUtcMs(t.deleted_at));
		return entry ? auditMonths(entry.details) : [];
	};

	// The reason a restore or a "Create it as new" needs: { reason } or { refusal }. Trimmed and refused over the
	// limit, never cut; then cleaned as the audit trail cleans text, and refused when too little is left or when it
	// holds an email or phone, so no broker contact reaches an audit row or a notice.
	function checkReason(raw, nothing) {
		const refuse = (why) => ({ refusal: { status: 400, body: {
			error: why === "too_long" ? WORDS.reasonTooLong(nothing) : WORDS.reasonRequired(nothing), code: "RESTORE_REASON_REQUIRED", field: "reason", reason: why,
		} } });
		if (typeof raw !== "string") return refuse("missing");
		const trimmed = raw.trim();
		if (trimmed.length > REASON_MAX) return refuse("too_long");
		if (typeof auditText !== "function") throw new Error("deleted-load-restore was created without auditText");
		const reason = auditText(trimmed, REASON_MAX);
		if (reason.length < REASON_MIN) return refuse("too_short");
		if (hasContact(reason) || hasContact(trimmed)) {
			return { refusal: { status: 400, body: { error: WORDS.reasonContact(nothing), code: "CONTACT_NOT_ALLOWED", field: "reason" } } };
		}
		return { reason };
	}

	// One notice to Super Admins (stored, and sent live to their room only).
	function notify(notice) {
		if (!h) return;
		try { h.notifySuperAdmins(notice); } catch (e) { log.error(`[deleted-load-restore] notice not sent: ${e && e.message}`); }
	}
	function storedNotices() {
		return db.prepare("SELECT metadata FROM dispatch_notifications WHERE type = ?").all(NOTICE_TYPE).map((r) => {
			try { return JSON.parse(r.metadata || "{}") || {}; } catch { return {}; }
		});
	}
	// A restore, or "Create it as new" (kind "cleared"), done: one notice naming the load, who and the reason.
	function noticeDone(user, { kind, shown, ids, reason }) {
		notify({
			type: RESTORED_NOTICE_TYPE,
			title: kind === "restored" ? WORDS.noticeRestoredTitle(shown) : WORDS.noticeClearedTitle(shown, ids.length),
			body: kind === "restored" ? WORDS.noticeRestoredBody(whoOf(user), reason) : WORDS.noticeClearedBody(whoOf(user), reason),
			metadata: { kind, loadId: shown, deletedLoadIds: ids, userId: user.id || 0 },
		});
	}

	function listFields() {
		return on ? { restore: { enabled: true } } : {};
	}

	// The Super Admins hear of a refused create once per delete, per person, per day.
	function noticeRefused(user, row, shown) {
		try {
			const day = appTime.appDay(now());
			const userId = user.id || 0;
			if (storedNotices().some((m) => m.kind === "refused_create" && m.tombstoneId === row.id && m.userId === userId && m.day === day)) return;
			notify({
				type: NOTICE_TYPE,
				title: WORDS.noticeRefusedTitle(shown),
				body: WORDS.noticeRefusedBody(user.username || user.full_name || "A user", row.deleted_by || "", dayOf(row.deleted_at)),
				metadata: { kind: "refused_create", tombstoneId: row.id, deletedLoadId: shown, userId, day },
			});
		} catch (e) {
			log.error(`[deleted-load-restore] refused-create notice not stored: ${e && e.message}`);
		}
	}

	// The months a delete's audit row names, each open or closed; none before the mount hands over the lock
	// helpers, or while the lock table can't be read (an "open" there could be wrong).
	function choiceMonths(t) {
		if (!h || !h.periodLocksReadable()) return [];
		const named = namedMonths(t);
		const closed = new Set(h.lockedAmong(named));
		return named.map((month) => ({ month, closed: closed.has(month) }));
	}

	// A Super Admin's choice for a Load ID the deletes `rows` name (oldest first); `row`: the sheet row holding it.
	function choiceBody(shown, rows, row) {
		const newest = rows[rows.length - 1];
		const months = choiceMonths(newest);
		return {
			error: WORDS.choice(shown, newest.deleted_by || "", dayOf(newest.deleted_at)),
			code: "LOAD_ID_DELETED",
			loadId: shown,
			tombstoneId: newest.id,
			deletedBy: newest.deleted_by || "",
			deletedAt: isoOf(newest.deleted_at),
			sheetRow: row,
			canRestore: !!row,
			canCreateNew: !row,
			deleteCount: rows.length,
			months,
			monthsFrom: months.length ? "audit" : "none",
		};
	}

	// After a create route's own duplicate read (rowIndex: the row already holding the ID; read: false if that read
	// failed; headerRead: false if POST /api/data couldn't read the header row that finds the ID). Null means go on;
	// otherwise the answer to send, with nothing written for it but, for anyone other than a Super Admin, the Super
	// Admins' notice. A "Create it as new" that passes is only remembered here: clearBeforeAppend() clears it.
	function onCreate(req, { loadId, rowIndex = null, read = true, headerRead = true, via = "" } = {}) {
		if (!on) return null;
		if (headerRead === false) return { status: 503, body: { error: WORDS.HEADER_UNREADABLE, code: "SHEET_UNREADABLE" } };
		const shown = String(loadId == null ? "" : loadId).trim();
		const key = normalizeLoadId(shown);
		if (!key) return null;
		let rows;
		try {
			rows = tombstonesFor(key);
		} catch (e) {
			log.error(`[deleted-load-restore] deleted loads unreadable: ${e && e.message}`);
			return { status: 503, body: { error: WORDS.DELETES_UNREADABLE, code: "DELETED_LOADS_UNREADABLE" } };
		}
		if (!rows.length) return null;
		const user = userOf(req);
		const newest = rows[rows.length - 1];
		if (user.role !== ROLE) {
			noticeRefused(user, newest, shown);
			return { status: 409, body: { error: WORDS.askSuperAdmin(shown), code: "LOAD_ID_DELETED" } };
		}
		if (!read) return { status: 503, body: { error: WORDS.sheetUnreadableForCreate(shown), code: "SHEET_UNREADABLE" } };
		const row = Number.isInteger(rowIndex) && rowIndex > 0 ? rowIndex : null;
		const choice = choiceBody(shown, rows, row);
		const sent = choiceOf(req && req.body);
		if (!sent) return { status: 409, body: choice };
		if (sent.id !== newest.id || sent.count !== rows.length) return { status: 409, body: { ...choice, error: WORDS.stale(shown), stale: true } };
		if (row) return { status: 409, body: { ...choice, error: WORDS.rowPresent(shown, row) } };
		const checked = checkReason(sent.reason, NOTHING_CREATED);
		if (checked.refusal) return checked.refusal;
		pending.set(req, { key, shown, newestId: newest.id, count: rows.length, via, user, reason: checked.reason });
		return null;
	}

	// Just before a create route's append, after every refusal it makes: the "Create it as new" onCreate() checked
	// is done here. Every delete of the ID goes, checked again against the newest id and the count the choice was
	// shown, with one clear_load_delete row naming each, in one transaction; then one notice. Null means append;
	// otherwise the answer to send (a stale choice comes back fresh), with nothing written.
	function clearBeforeAppend(req) {
		if (!on || !req) return null;
		const p = pending.get(req);
		if (!p) return null;
		pending.delete(req);
		let outcome;
		try {
			outcome = db.transaction(() => {
				const rows = tombstonesFor(p.key);
				// Restored meanwhile: nothing hides the new row any more.
				if (!rows.length) return { rows };
				const newest = rows[rows.length - 1];
				if (newest.id !== p.newestId || rows.length !== p.count) return { rows, stale: true };
				const drop = db.prepare("DELETE FROM deleted_loads WHERE id = ?");
				let gone = 0;
				for (const r of rows) gone += drop.run(r.id).changes;
				if (gone !== rows.length) throw new Error(`cleared ${gone} of ${rows.length} delete records`);
				insertAudit(p.user, "clear_load_delete", newest.load_id,
					`Cleared the delete${rows.length > 1 ? "s" : ""} of load ${newest.load_id} (${rows.map(deleteRecord).join("; ")}) to create it as new through ${p.via || "a create"}; no Job Tracking row held it. Reason: ${p.reason}`);
				return { rows, cleared: true };
			})();
		} catch (e) {
			log.error(`[deleted-load-restore] delete not cleared for a create: ${e && e.message}`);
			return { status: 503, body: { error: WORDS.CLEAR_FAILED, code: "DELETE_NOT_CLEARED" } };
		}
		if (outcome.stale) return { status: 409, body: { ...choiceBody(p.shown, outcome.rows, null), error: WORDS.stale(p.shown), stale: true } };
		if (outcome.cleared) noticeDone(p.user, { kind: "cleared", shown: p.shown, ids: outcome.rows.map((r) => r.id), reason: p.reason });
		return null;
	}

	function digestColumns(headers) {
		const monthCols = h.jobTrackingMonthCols(headers || []);
		return {
			loadId: monthCols.loadIdCol,
			pickupAddress: h.pickAddressColumn(headers || [], /origin|pickup|shipper/i),
			dropoffAddress: h.pickAddressColumn(headers || [], /dest|drop|receiver|delivery/i),
			pickupDate: monthCols.pickupDateCol,
			dropoffDate: monthCols.dropoffDateCol,
		};
	}

	// The month columns, with the trip work-day cover when that rule is on, as the restore's month check reads them.
	function coverCols(headers) {
		const cols = h.jobTrackingMonthCols(headers || []);
		const tripCover = h.tripDayLockCover(headers || []);
		if (tripCover) cols.tripCover = tripCover;
		return cols;
	}

	// The delete route's record of every row the new delete hides. A failure is logged; that delete is then judged
	// by its months, as an older one is.
	function recordDigests(tombstoneId, jt, key) {
		if (!on || !h) return;
		try {
			const cols = digestColumns((jt && jt.headers) || []);
			const k = normalizeLoadId(key);
			const rows = cols.loadId && k ? everyJobTrackingRow(jt).filter((r) => normalizeLoadId(r[cols.loadId]) === k) : [];
			db.prepare("UPDATE deleted_loads SET row_digests = ? WHERE id = ?").run(JSON.stringify(rows.map((r) => rowDigest(r, cols))), Number(tombstoneId));
		} catch (e) {
			log.error(`[deleted-load-restore] digests not recorded for delete ${tombstoneId}: ${e && e.message}`);
		}
	}

	// A delete's live rows, split into the ones that may be its own (the rows it was made over) and the rest. Made
	// when no row held the ID: none are its own. With its rows recorded: a row matching one of them (copies counted).
	// Without (an older delete): a row whose every month is one its delete_load audit row names, or whose dates give
	// no month; with no month named, every row. Read only: nothing is written.
	function splitRows(t, live, dcols, monthCols) {
		if (!(Number(t.row_index) > 0)) return { basis: "none", own: [], other: live.slice() };
		const recorded = parseDigests(t.row_digests);
		if (recorded) {
			const left = new Map();
			for (const d of recorded) left.set(d, (left.get(d) || 0) + 1);
			const own = [];
			const other = [];
			for (const r of live) {
				const d = rowDigest(r, dcols);
				const n = left.get(d) || 0;
				if (n) {
					left.set(d, n - 1);
					own.push(r);
				} else other.push(r);
			}
			return { basis: "digests", own, other, recorded: recorded.length };
		}
		const named = namedMonths(t);
		if (!named.length) return { basis: "months", own: live.slice(), other: [] };
		const own = [];
		const other = [];
		for (const r of live) {
			const p = h.loadRowPeriods(r, monthCols);
			(!p || !p.resolved || p.periods.every((m) => named.includes(m)) ? own : other).push(r);
		}
		return { basis: "months", own, other };
	}

	// The months `rows` book into, each open or closed, and whether every row gave a month. None while the lock
	// table can't be read.
	function rowsMonths(rows, cols) {
		const set = new Set();
		let resolved = rows.length > 0;
		for (const r of rows) {
			const p = h.loadRowPeriods(r, cols);
			if (p && p.resolved) for (const m of p.periods) set.add(m);
			else resolved = false;
		}
		if (!h.periodLocksReadable()) return { months: [], resolved: false };
		const sorted = [...set].sort();
		const closed = new Set(h.lockedAmong(sorted));
		return { months: sorted.map((month) => ({ month, closed: closed.has(month) })), resolved };
	}

	// Each Load ID's creates since `sinceMs` as app.db records them (key -> [{ evidence, ms }]): a rate con's audit
	// row, New Job's or the Data Manager's create_sheet_row on Job Tracking, and n8n's new-load notice.
	function createsSince(sinceMs) {
		const out = new Map();
		const add = (raw, evidence, ms) => {
			const key = normalizeLoadId(raw);
			if (!key || Number.isNaN(ms)) return;
			if (!out.has(key)) out.set(key, []);
			out.get(key).push({ evidence, ms });
		};
		const sinceIso = new Date(sinceMs).toISOString();
		const sinceSql = sinceIso.slice(0, 19).replace("T", " ");
		for (const r of db.prepare("SELECT entity_id, timestamp FROM audit_trail WHERE action = 'create_load_ratecon' AND entity = 'load' AND timestamp >= ?").all(sinceIso)) {
			add(r.entity_id, "created_by_rate_con", Date.parse(r.timestamp));
		}
		for (const r of db.prepare("SELECT details, timestamp FROM audit_trail WHERE action = 'create_sheet_row' AND entity = 'sheet_row' AND entity_id LIKE 'Job Tracking!%' AND timestamp >= ?").all(sinceIso)) {
			let changed = [];
			try { changed = (JSON.parse(r.details || "{}").changed) || []; } catch { changed = []; }
			const cell = Array.isArray(changed) ? changed.find((c) => c && /load.?id|job.?id/i.test(String(c.column || ""))) : null;
			if (cell) add(cell.to, "created_in_sheet_row", Date.parse(r.timestamp));
		}
		for (const r of db.prepare("SELECT metadata, created_at FROM dispatch_notifications WHERE type = 'new-load' AND created_at >= ?").all(sinceSql)) {
			let meta = {};
			try { meta = JSON.parse(r.metadata || "{}") || {}; } catch { meta = {}; }
			if (meta.source === "n8n") add(meta.loadId, "created_by_n8n", sqliteUtcMs(r.created_at));
		}
		return out;
	}

	// A deliberate delete keeps its own row on the sheet, so a live row counts as hidden only with evidence it isn't
	// that row: the delete found no row, app.db records a create of the ID after it, the row isn't one the delete
	// recorded, or (an older delete) it books into a month the delete didn't name. One whose months are all closed
	// is a payout question: off the banner, told once. Null for anyone but a Super Admin. Writes only notices.
	function hiddenLoads(req, jt) {
		if (!on || !h || userOf(req).role !== ROLE) return null;
		const headers = (jt && jt.headers) || [];
		const dcols = digestColumns(headers);
		const tombstones = db.prepare(`SELECT ${TOMBSTONE_COLS}, row_digests FROM deleted_loads ORDER BY id`).all();
		if (!tombstones.length || !dcols.loadId) return [];
		const monthCols = h.jobTrackingMonthCols(headers);
		// Live: every status but cancelled, by the rule excludeDroppedLoads() keeps.
		const liveByKey = new Map();
		for (const r of h.excludeDroppedLoads(everyJobTrackingRow(jt), headers, new Set())) {
			const key = normalizeLoadId(r[dcols.loadId]);
			if (!key) continue;
			if (!liveByKey.has(key)) liveByKey.set(key, []);
			liveByKey.get(key).push(r);
		}
		const candidates = [];
		for (const t of tombstones) {
			const key = normalizeLoadId(t.load_id);
			const live = (key && liveByKey.get(key)) || [];
			if (!live.length) continue;
			const split = splitRows(t, live, dcols, monthCols);
			// With its rows recorded, a delete hides nothing new while every live row is one of them.
			if (split.basis === "digests" && !split.other.length) continue;
			candidates.push({ t, key, live, split, deletedMs: sqliteUtcMs(t.deleted_at) });
		}
		if (!candidates.length) return [];
		const known = candidates.map((c) => c.deletedMs).filter((ms) => !Number.isNaN(ms));
		const creates = known.length ? createsSince(Math.min(...known)) : new Map();
		const cover = coverCols(headers);
		const rowNumber = (r) => (Number.isInteger(r._rowIndex) ? r._rowIndex : null);
		const rowNumbers = (rows) => rows.map(rowNumber).filter((n) => n !== null);
		const listed = [];
		const closedOnly = [];
		for (const c of candidates) {
			const evidence = [];
			if (c.split.basis === "none") evidence.push("deleted_with_no_row");
			const after = Number.isNaN(c.deletedMs) ? [] : (creates.get(c.key) || []).filter((x) => x.ms > c.deletedMs);
			for (const kind of ["created_by_rate_con", "created_in_sheet_row", "created_by_n8n"]) {
				if (after.some((x) => x.evidence === kind)) evidence.push(kind);
			}
			if (c.split.basis === "digests" && c.split.recorded > 0) evidence.push("row_changed");
			if (c.split.basis === "months" && c.split.other.length) evidence.push("row_in_other_month");
			if (!evidence.length) continue;
			const shownRow = c.split.other[0] || c.live[0];
			const m = rowsMonths(c.live, cover);
			const item = {
				tombstoneId: c.t.id,
				loadId: String(shownRow[dcols.loadId] || "").trim() || String(c.t.load_id),
				deletedBy: c.t.deleted_by || "",
				deletedAt: isoOf(c.t.deleted_at),
				sheetRow: rowNumber(shownRow),
				rows: rowNumbers(c.live),
				newRows: rowNumbers(c.split.other),
				ownRows: rowNumbers(c.split.own),
				canRestore: true,
				canCreateNew: c.split.own.length === 0,
				months: m.months,
				evidence,
			};
			if (m.resolved && m.months.length && m.months.every((x) => x.closed)) closedOnly.push({ item, t: c.t });
			else listed.push({ item, t: c.t });
		}
		if (listed.length || closedOnly.length) {
			const stored = storedNotices();
			const told = (kind) => new Set(stored.filter((x) => x.kind === kind).map((x) => x.tombstoneId));
			const toldHidden = told("hidden");
			const toldClosed = told("hidden_closed");
			for (const { item, t } of listed) {
				if (toldHidden.has(item.tombstoneId)) continue;
				notify({
					type: NOTICE_TYPE,
					title: WORDS.noticeHiddenTitle(item.loadId),
					body: WORDS.noticeHiddenBody(item.deletedBy, dayOf(t.deleted_at)),
					metadata: { kind: "hidden", tombstoneId: item.tombstoneId, deletedLoadId: item.loadId },
				});
			}
			for (const { item, t } of closedOnly) {
				if (toldClosed.has(item.tombstoneId)) continue;
				notify({
					type: NOTICE_TYPE,
					title: WORDS.noticeHiddenClosedTitle(item.loadId, item.months.length),
					body: WORDS.noticeHiddenClosedBody(item.deletedBy, dayOf(t.deleted_at), item.months.map((x) => h.periodLabel(x.month))),
					metadata: { kind: "hidden_closed", tombstoneId: item.tombstoneId, deletedLoadId: item.loadId },
				});
			}
		}
		// Newest delete first, as the deleted-loads list orders them.
		return listed.map((x) => x.item).reverse();
	}

	// A Super Admin's dashboard answer with hiddenLoads second, after timestamp.
	// A check that fails leaves the answer as the dashboard sends it.
	async function dashboardStep(req, res, next) {
		if (userOf(req).role !== ROLE) return next();
		let list = null;
		try {
			list = hiddenLoads(req, await h.getJobTrackingCached());
		} catch (e) {
			log.error(`[deleted-load-restore] hidden loads not checked: ${e && e.message}`);
		}
		if (Array.isArray(list)) {
			const json = res.json.bind(res);
			res.json = (body) => json(body && typeof body === "object" && !Array.isArray(body) && res.statusCode < 400
				? { timestamp: body.timestamp, hiddenLoads: list, ...body }
				: body);
		}
		return next();
	}

	// The restore, or "Create it as new" from the dashboard's review: the one
	// delete record and its audit row, with the reason, together.
	function writeRestore(user, row, months, mode, reason) {
		return db.transaction(() => {
			if (db.prepare("DELETE FROM deleted_loads WHERE id = ?").run(row.id).changes !== 1) return false;
			const details = mode === "create_new"
				? `Cleared the delete of load ${row.load_id} (${deleteRecord(row)}) from the dashboard's review: its Job Tracking row counts as a new load${monthsText(months)}. Reason: ${reason}`
				: `Restored load ${row.load_id} (${deleteRecord(row)})${monthsText(months)}. Reason: ${reason}`;
			insertAudit(user, mode === "create_new" ? "clear_load_delete" : "restore_load", row.load_id, details);
			return true;
		})();
	}

	const lockRefusal = (res) => res.status(503).json({ error: WORDS.LOCKS_UNREADABLE, code: "PERIOD_LOCK_UNREADABLE" });

	async function restore(req, res) {
		try {
			const id = restoreIdOf(req.params && req.params.id);
			if (!id) return res.status(400).json({ error: WORDS.BAD_ID, code: "DELETED_LOAD_ID_INVALID" });
			const mode = modeOf(req.body);
			if (!mode) return res.status(400).json({ error: WORDS.BAD_MODE, code: "RESTORE_MODE_INVALID" });
			const checked = checkReason(req.body && typeof req.body === "object" ? req.body.reason : undefined, NOTHING_CHANGED);
			if (checked.refusal) return res.status(checked.refusal.status).json(checked.refusal.body);
			if (!h.periodLocksReadable()) return lockRefusal(res);
			const before = db.prepare(`SELECT ${TOMBSTONE_COLS}, row_digests FROM deleted_loads WHERE id = ?`).get(id);
			if (!before) return res.status(404).json({ error: WORDS.NOT_DELETED, code: "NOT_DELETED" });
			let jt;
			try {
				jt = await h.getJobTrackingCached();
			} catch (e) {
				log.error(`[deleted-load-restore] Job Tracking unreadable: ${e && e.message}`);
				return res.status(503).json({ error: WORDS.SHEET_UNREADABLE, code: "SHEET_UNREADABLE" });
			}
			// Nothing awaits from here to the write, so the locks and the delete are
			// read as the write finds them. Every row with the ID, as the weekly
			// invoice reads them, so no month a restored row books into is missed.
			const headers = (jt && jt.headers) || [];
			const cols = coverCols(headers);
			const key = normalizeLoadId(before.load_id);
			const shown = String(before.load_id);
			const matches = key && cols.loadIdCol ? everyJobTrackingRow(jt).filter((r) => normalizeLoadId(r[cols.loadIdCol]) === key) : [];
			if (!matches.length) return res.status(409).json({ error: WORDS.noSheetRow(shown), code: "NO_SHEET_ROW" });
			// "Create it as new" leaves a row that may be the delete's own counting again: refused, naming it.
			if (mode === "create_new") {
				const live = h.excludeDroppedLoads(matches, headers, new Set());
				const own = splitRows(before, live, digestColumns(headers), h.jobTrackingMonthCols(headers)).own;
				const rows = own.map((r) => r._rowIndex).filter((n) => Number.isInteger(n));
				if (own.length) return res.status(409).json({ error: WORDS.deletedRowsPresent(shown, rows), code: "DELETED_ROWS_PRESENT", rows });
			}
			const months = new Set();
			let resolved = true;
			for (const r of matches) {
				const p = h.loadRowPeriods(r, cols);
				if (!p || !p.resolved) resolved = false;
				for (const m of (p && p.periods) || []) months.add(m);
			}
			if (!resolved) return res.status(409).json({ error: WORDS.unresolved(shown), code: "PERIOD_UNRESOLVED" });
			if (!h.periodLocksReadable()) return lockRefusal(res);
			const locked = h.lockedAmong([...months]);
			if (locked.length) {
				return res.status(409).json({ error: WORDS.finalized(shown, locked.map(h.periodLabel)), code: "PERIOD_FINALIZED", periods: locked });
			}
			const sorted = [...months].sort();
			const user = userOf(req);
			if (!writeRestore(user, before, sorted, mode, checked.reason)) return res.status(404).json({ error: WORDS.NOT_DELETED, code: "NOT_DELETED" });
			noticeDone(user, { kind: mode === "create_new" ? "cleared" : "restored", shown, ids: [id], reason: checked.reason });
			h.notifyChange("dashboard");
			h.jtCacheInvalidate();
			return res.json({ ok: true, mode, restored: { id, loadId: shown, months: sorted }, remaining: tombstonesFor(key).length });
		} catch (e) {
			log.error(`[deleted-load-restore] restore failed: ${e && e.message}`);
			return res.status(500).json({ error: WORDS.RESTORE_FAILED, code: "RESTORE_FAILED" });
		}
	}

	function mount(app, helpers = {}) {
		const missing = HELPERS.filter((k) => typeof helpers[k] !== "function");
		if (missing.length) throw new Error(`deleted-load-restore mount needs ${missing.join(", ")}`);
		h = helpers;
		if (!on) return;
		// Behind the dashboard route's own gate, so a session it refuses runs no check and writes nothing.
		app.get("/api/dashboard", h.requireRole(ROLE, "Dispatcher"), (req, res, next) => dashboardStep(req, res, next).catch(next));
		app.post(RESTORE_PATH, h.requireRole(ROLE), h.refuseCrossSite, (req, res, next) => restore(req, res).catch(next));
	}

	return { enabled: on, listFields, onCreate, clearBeforeAppend, recordDigests, hiddenLoads, digestColumns, mount };
}

module.exports = { create, ensureSchema, WORDS, ROLE, RESTORE_PATH, NOTICE_TYPE, RESTORED_NOTICE_TYPE, restoreIdOf, choiceOf, rowDigest };
