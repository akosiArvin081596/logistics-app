"use strict";
// Restoring a soft-deleted load, the create routes' check for a Load ID an old delete still names, and the Super
// Admins' word of a live row such a delete hides. On only when server.js passes `enabled`; off, nothing here
// touches the database or mounts a route, so the app answers exactly as it did without it.

const crypto = require("crypto");
const appTime = require("./app-time");
const { normalizeLoadId } = require("./ratecon-load");
const { everyJobTrackingRow } = require("./job-tracking-every-row");
const { sqliteUtcMs } = require("./deleted-loads-view");

const ROLE = "Super Admin";
const RESTORE_PATH = "/api/admin/deleted-loads/:id/restore";
// A Super Admin-only dispatch notice (server.js SUPER_ADMIN_ONLY_NOTICE_TYPES lists it).
const NOTICE_TYPE = "load-hidden-by-delete";
// The server's helpers the mount takes; every one is required, so a wiring slip fails at start.
const HELPERS = ["requireRole", "refuseCrossSite", "periodLocksReadable", "getJobTrackingCached", "jobTrackingMonthCols",
	"tripDayLockCover", "loadRowPeriods", "lockedAmong", "periodLabel", "notifyChange", "jtCacheInvalidate",
	"pickAddressColumn", "excludeDroppedLoads", "notifySuperAdmins"];
const AUDIT_SQL = "INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const TOMBSTONE_COLS = "id, load_id, row_index, deleted_at, deleted_by";
// Sheet cells are read only this far before a digest is made of them.
const CELL_MAX = 1000;

const WORDS = Object.freeze({
	BAD_ID: "That deleted load isn't on the list. Reload the page and try again.",
	BAD_MODE: "Choose Restore the deleted load or Create it as new.",
	LOCKS_UNREADABLE: "The month-end lock table could not be read, so closed months can't be checked. Nothing was changed. Try again in a moment.",
	SHEET_UNREADABLE: "Job Tracking could not be read, so the load's row and month can't be checked. Nothing was changed. Try again in a moment.",
	NOT_DELETED: "This load isn't deleted any more; it may have been restored already. Nothing was changed.",
	RESTORE_FAILED: "The load could not be restored. Nothing was changed. Try again in a moment.",
	DELETES_UNREADABLE: "The deleted loads could not be read, so this Load ID can't be checked against them. Nothing was created. Try again in a moment.",
	noSheetRow: (id) => `Load ${id} has no row in Job Tracking any more, so restoring it would bring nothing back. Nothing was changed.`,
	unresolved: (id) => `Load ${id}'s dates in Job Tracking don't give a month, so it can't be told whether restoring it would change a closed month. Correct the dates on its row, then try again. Nothing was changed.`,
	finalized: (id, labels) => (labels.length > 1
		? `Load ${id} is in closed months (${labels.join(", ")}). Restoring it would change settled payouts, which is a payout question. Nothing was changed.`
		: `Load ${id} is in a closed month (${labels.join(", ")}). Restoring it would change a settled payout, which is a payout question. Nothing was changed.`),
	askSuperAdmin: (id) => `Load ${id} can't be created here because an earlier load with this ID was deleted. Ask a Super Admin to restore it or create it as new.`,
	sheetUnreadableForCreate: (id) => `Job Tracking could not be read, so it can't be told whether the deleted load ${id} still has a row there. Nothing was created. Try again in a moment.`,
	choice: (id, who, day) => `Load ${id} was deleted${day ? ` on ${day}` : ""}${who ? ` by ${who}` : ""}. Restore the deleted load, or create it as new.`,
	stale: (id) => `The delete record for load ${id} changed after you chose, so nothing was created. Choose again.`,
	rowPresent: (id, row) => `Row ${row} still holds load ${id}: restore it instead, or remove that row first. Nothing was created.`,
	noticeHiddenTitle: (id) => `Load ${id} is hidden by an earlier delete`,
	noticeHiddenBody: (who, day) => `Deleted${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}. Review it from the banner on the dashboard.`,
	noticeRefusedTitle: (id) => `Load ${id} could not be created: an earlier load with this ID was deleted`,
	noticeRefusedBody: (tried, who, day) => `${tried} tried to create it. The earlier load was deleted${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}. To choose between restoring it and creating it as new, create it yourself from the rate con or New Job.`,
});

// deleted_loads.id as the route's :id carries it: a positive whole number, else 0.
function restoreIdOf(v) {
	const s = String(v == null ? "" : v);
	return /^[1-9][0-9]{0,14}$/.test(s) ? Number(s) : 0;
}

// The "Create it as new" a re-sent create carries, or null. A bad id is kept as
// 0, so the request is refused as stale rather than read as no choice at all.
function choiceOf(body) {
	const c = body && typeof body === "object" ? body.deletedLoadChoice : null;
	if (!c || typeof c !== "object" || Array.isArray(c) || c.action !== "create_new") return null;
	return { action: "create_new", id: Number.isInteger(c.id) && c.id > 0 ? c.id : 0 };
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

// Every live digest within the recorded ones, counting copies: a second copy of
// the deleted row is a new row too.
function withinRecorded(live, recorded) {
	const left = new Map();
	for (const d of recorded) left.set(d, (left.get(d) || 0) + 1);
	for (const d of live) {
		const n = left.get(d) || 0;
		if (!n) return false;
		left.set(d, n - 1);
	}
	return true;
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

function create({ db = null, enabled = false, now = () => new Date(), log = console, timeZone = null } = {}) {
	const on = enabled === true;
	const zone = timeZone || appTime.appTimeZone();
	let h = null;

	const userOf = (req) => (req && req.session && req.session.user) || {};
	const isoOf = (stamp) => {
		const ms = sqliteUtcMs(stamp);
		return Number.isNaN(ms) ? "" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	};
	const dayOf = (stamp) => {
		const ms = sqliteUtcMs(stamp);
		return Number.isNaN(ms) ? "" : appTime.dayInZone(new Date(ms), zone);
	};
	const tombstonesFor = (key) => db.prepare(`SELECT ${TOMBSTONE_COLS} FROM deleted_loads ORDER BY id`).all()
		.filter((r) => normalizeLoadId(r.load_id) === key);
	const insertAudit = (user, action, entityId, details) => db.prepare(AUDIT_SQL).run(
		now().toISOString(), user.id || 0, user.username || "system", user.role || "system", action, "load", String(entityId), details);
	const deleteRecord = (row) => `deleted_loads row ${row.id}, deleted ${isoOf(row.deleted_at) || "at an unknown time"} by ${row.deleted_by || "an unknown user"}`;
	const monthsText = (months) => (months.length ? ` — settlement month${months.length > 1 ? "s" : ""} ${months.join(", ")}` : "");

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

	// "Create it as new" during a create: the one delete record goes, with its
	// audit row, in one transaction, before the route appends the new row.
	function clearForCreate(user, row, via) {
		return db.transaction(() => {
			if (db.prepare("DELETE FROM deleted_loads WHERE id = ?").run(row.id).changes !== 1) return false;
			insertAudit(user, "clear_load_delete", row.load_id,
				`Cleared the delete of load ${row.load_id} (${deleteRecord(row)}) to create it as new through ${via || "a create"}; no Job Tracking row held it.`);
			return true;
		})();
	}

	// After a create route's own duplicate read (rowIndex: the row already holding the ID; read: false if that read
	// failed). Null means go on; otherwise the answer to send, with nothing written for it but, for anyone other
	// than a Super Admin, the Super Admins' notice.
	function onCreate(req, { loadId, rowIndex = null, read = true, via = "" } = {}) {
		if (!on) return null;
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
		const choice = {
			error: WORDS.choice(shown, newest.deleted_by || "", dayOf(newest.deleted_at)),
			code: "LOAD_ID_DELETED",
			loadId: shown,
			tombstoneId: newest.id,
			deletedBy: newest.deleted_by || "",
			deletedAt: isoOf(newest.deleted_at),
			sheetRow: row,
			canRestore: !!row,
			canCreateNew: !row && rows.length === 1,
			deleteCount: rows.length,
		};
		const sent = choiceOf(req && req.body);
		if (!sent) return { status: 409, body: choice };
		if (rows.length !== 1 || sent.id !== newest.id) return { status: 409, body: { ...choice, error: WORDS.stale(shown), stale: true } };
		if (row) return { status: 409, body: { ...choice, error: WORDS.rowPresent(shown, row) } };
		if (!clearForCreate(user, newest, via)) return { status: 409, body: { ...choice, error: WORDS.stale(shown), stale: true } };
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

	// The delete route's record of every row the new delete hides. A failure is
	// logged and left for the first detection read to fill in.
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
	// that row: the delete found no row, app.db records a create of the ID after it, or the row isn't one it
	// recorded. A delete with no record yet gets one here, once. Null for anyone but a Super Admin.
	function hiddenLoads(req, jt) {
		if (!on || !h || userOf(req).role !== ROLE) return null;
		const headers = (jt && jt.headers) || [];
		const cols = digestColumns(headers);
		const tombstones = db.prepare(`SELECT ${TOMBSTONE_COLS}, row_digests FROM deleted_loads ORDER BY id`).all();
		if (!tombstones.length || !cols.loadId) return [];
		const byKey = (rows) => {
			const m = new Map();
			for (const r of rows) {
				const key = normalizeLoadId(r[cols.loadId]);
				if (!key) continue;
				if (!m.has(key)) m.set(key, []);
				m.get(key).push(r);
			}
			return m;
		};
		const every = everyJobTrackingRow(jt);
		const everyByKey = byKey(every);
		// Live: every status but cancelled, by the rule excludeDroppedLoads() keeps.
		const liveByKey = byKey(h.excludeDroppedLoads(every, headers, new Set()));
		const candidates = [];
		for (const t of tombstones) {
			const key = normalizeLoadId(t.load_id);
			if (!key) continue;
			let recorded = parseDigests(t.row_digests);
			const firstSeen = recorded === null;
			if (firstSeen) {
				recorded = (everyByKey.get(key) || []).map((r) => rowDigest(r, cols));
				db.prepare("UPDATE deleted_loads SET row_digests = ? WHERE id = ?").run(JSON.stringify(recorded), t.id);
			}
			const rows = liveByKey.get(key) || [];
			if (!rows.length) continue;
			const changed = !firstSeen && !withinRecorded(rows.map((r) => rowDigest(r, cols)), recorded);
			candidates.push({ t, key, rows, deletedMs: sqliteUtcMs(t.deleted_at), changed });
		}
		if (!candidates.length) return [];
		const known = candidates.map((c) => c.deletedMs).filter((ms) => !Number.isNaN(ms));
		const creates = known.length ? createsSince(Math.min(...known)) : new Map();
		const hidden = [];
		for (const c of candidates) {
			const evidence = [];
			if (!(Number(c.t.row_index) > 0)) evidence.push("deleted_with_no_row");
			const after = Number.isNaN(c.deletedMs) ? [] : (creates.get(c.key) || []).filter((x) => x.ms > c.deletedMs);
			for (const kind of ["created_by_rate_con", "created_in_sheet_row", "created_by_n8n"]) {
				if (after.some((x) => x.evidence === kind)) evidence.push(kind);
			}
			if (c.changed) evidence.push("row_changed");
			if (!evidence.length) continue;
			const first = c.rows[0];
			hidden.push({
				tombstoneId: c.t.id,
				loadId: String(first[cols.loadId] || "").trim() || String(c.t.load_id),
				deletedBy: c.t.deleted_by || "",
				deletedAt: isoOf(c.t.deleted_at),
				sheetRow: Number.isInteger(first._rowIndex) ? first._rowIndex : null,
				evidence,
			});
		}
		if (hidden.length) {
			const told = new Set(storedNotices().filter((m) => m.kind === "hidden").map((m) => m.tombstoneId));
			const deletedAtOf = new Map(candidates.map((c) => [c.t.id, c.t.deleted_at]));
			for (const x of hidden) {
				if (told.has(x.tombstoneId)) continue;
				notify({
					type: NOTICE_TYPE,
					title: WORDS.noticeHiddenTitle(x.loadId),
					body: WORDS.noticeHiddenBody(x.deletedBy, dayOf(deletedAtOf.get(x.tombstoneId))),
					metadata: { kind: "hidden", tombstoneId: x.tombstoneId, deletedLoadId: x.loadId },
				});
			}
		}
		// Newest delete first, as the deleted-loads list orders them.
		return hidden.reverse();
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
	// delete record and its audit row, together.
	function writeRestore(user, row, months, mode) {
		return db.transaction(() => {
			if (db.prepare("DELETE FROM deleted_loads WHERE id = ?").run(row.id).changes !== 1) return false;
			const details = mode === "create_new"
				? `Cleared the delete of load ${row.load_id} (${deleteRecord(row)}) from the dashboard's review: its Job Tracking row counts as a new load${monthsText(months)}.`
				: `Restored load ${row.load_id} (${deleteRecord(row)})${monthsText(months)}.`;
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
			if (!h.periodLocksReadable()) return lockRefusal(res);
			const before = db.prepare(`SELECT ${TOMBSTONE_COLS} FROM deleted_loads WHERE id = ?`).get(id);
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
			const cols = h.jobTrackingMonthCols(headers);
			const tripCover = h.tripDayLockCover(headers);
			if (tripCover) cols.tripCover = tripCover;
			const key = normalizeLoadId(before.load_id);
			const shown = String(before.load_id);
			const matches = key && cols.loadIdCol ? everyJobTrackingRow(jt).filter((r) => normalizeLoadId(r[cols.loadIdCol]) === key) : [];
			if (!matches.length) return res.status(409).json({ error: WORDS.noSheetRow(shown), code: "NO_SHEET_ROW" });
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
			if (!writeRestore(userOf(req), before, sorted, mode)) return res.status(404).json({ error: WORDS.NOT_DELETED, code: "NOT_DELETED" });
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
		// Before the dashboard's own route; no gate of its own (that route's applies).
		app.get("/api/dashboard", (req, res, next) => dashboardStep(req, res, next).catch(next));
		app.post(RESTORE_PATH, h.requireRole(ROLE), h.refuseCrossSite, (req, res, next) => restore(req, res).catch(next));
	}

	return { enabled: on, listFields, onCreate, recordDigests, hiddenLoads, digestColumns, mount };
}

module.exports = { create, ensureSchema, WORDS, ROLE, RESTORE_PATH, NOTICE_TYPE, restoreIdOf, choiceOf, rowDigest };
