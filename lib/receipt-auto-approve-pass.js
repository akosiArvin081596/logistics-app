"use strict";
// Receipts auto-approve: the pass that judges fuel receipts by rules v1 (lib/receipt-auto-approve.js),
// its two tables, the report's figures and the undo-all tool. server.js hands in its own helpers
// (the matcher and its latch, the month locks, the reader, logAudit), so both judge alike.

const crypto = require("crypto");
const rules = require("./receipt-auto-approve");
const appTime = require("./app-time");

const PASS_NAME = "receipt-auto-approve";
const UNDO_NAME = "receipt-auto-approve-undo";
const actorOf = (username) => Object.freeze({ session: Object.freeze({ user: Object.freeze({ id: 0, username, role: "system" }) }) });
const ACTOR = actorOf(PASS_NAME);
const UNDO_ACTOR = actorOf(UNDO_NAME);

const INTERVAL_MIN = { fallback: 60, lo: 60, hi: 360 };
const READS_PER_PASS = { fallback: 20, lo: 1, hi: 40 };
const READS_PER_DAY = { fallback: 30, lo: 1, hi: 100 };
const PASS_DEADLINE_MS = 5 * 60 * 1000;
// The first pass starts this long after boot, so the hourly timer never comes due
// with the 6-hourly fuel sweep's (which starts at boot).
const FIRST_PASS_DELAY_MS = 7 * 60 * 1000;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS receipt_auto_reviews (
	expense_id INTEGER PRIMARY KEY,
	rules_version TEXT NOT NULL,
	mode TEXT NOT NULL CHECK(mode IN ('shadow', 'on')),
	verdict TEXT NOT NULL CHECK(verdict IN ('approve', 'hold', 'wait')),
	reasons TEXT NOT NULL DEFAULT '[]',
	evidence TEXT NOT NULL DEFAULT '{}',
	fingerprints TEXT NOT NULL DEFAULT '[]',
	photo_ref TEXT NOT NULL DEFAULT '',
	ocr_read_at TEXT NOT NULL DEFAULT '',
	failed_reads INTEGER NOT NULL DEFAULT 0,
	passes INTEGER NOT NULL DEFAULT 0,
	status_seen TEXT NOT NULL DEFAULT '',
	person_first INTEGER NOT NULL DEFAULT 0,
	first_seen_at TEXT NOT NULL,
	decided_at TEXT NOT NULL DEFAULT '',
	applied_at TEXT NOT NULL DEFAULT '',
	applied_row TEXT NOT NULL DEFAULT '',
	not_applied TEXT NOT NULL DEFAULT '',
	undone_at TEXT NOT NULL DEFAULT '',
	undone_by TEXT NOT NULL DEFAULT ''
)`,
	"CREATE TABLE IF NOT EXISTS receipt_auto_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
];

// Created at boot whatever the flags; empty until a pass runs.
function ensureSchema(db) {
	for (const sql of SCHEMA) db.exec(sql);
}

// ── settings ────────────────────────────────────────────────────────────────
function wholeIn(v, { fallback, lo, hi }) {
	const s = String(v ?? "").trim();
	if (!/^\d{1,6}$/.test(s)) return fallback;
	return Math.min(hi, Math.max(lo, Number(s)));
}

// Read once at start. On mode needs the recorder, because its candidate rule and
// its compare-and-set read the "who set it" record; without it the pass runs as shadow.
function readConfig(settings = {}, { recorderOn = false, fuelEventsOn = false, scannerConfigured = false } = {}) {
	const env = settings || {};
	const enabled = env.RECEIPT_AUTO_APPROVE_ENABLED === "true";
	const wantsOn = env.RECEIPT_AUTO_APPROVE_SHADOW === "false";
	const mode = !enabled ? "off" : wantsOn && recorderOn ? "on" : "shadow";
	const refused = enabled && wantsOn && !recorderOn ? "on refused: RECEIPT_STATUS_RECORDER_ENABLED is off" : "";
	const missing = !enabled ? "" : !fuelEventsOn ? "FUEL_EVENTS_ENABLED is off" : !scannerConfigured ? "no Gemini key is set" : "";
	return Object.freeze({
		enabled,
		mode,
		refused,
		missing,
		runs: enabled && !missing,
		intervalMin: wholeIn(env.RECEIPT_AUTO_APPROVE_INTERVAL_MIN, INTERVAL_MIN),
		maxReadsPerPass: wholeIn(env.RECEIPT_AUTO_APPROVE_MAX_READS_PER_PASS, READS_PER_PASS),
		maxReadsPerDay: wholeIn(env.RECEIPT_AUTO_APPROVE_MAX_READS_PER_DAY, READS_PER_DAY),
	});
}

function startLine(c) {
	if (!c.enabled) return "[receipt-auto-approve] RECEIPT_AUTO_APPROVE_ENABLED off";
	if (c.missing) return `[receipt-auto-approve] not started: ${c.missing}`;
	return `[receipt-auto-approve] ${c.mode}, every ${c.intervalMin} min; reads ${c.maxReadsPerPass} a pass, ${c.maxReadsPerDay} a day`
		+ (c.refused ? `; ${c.refused}` : "");
}

// ── small readers ───────────────────────────────────────────────────────────
const str = (v) => (v == null ? "" : String(v)).trim();
const idOf = (v) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// SQLite's CURRENT_TIMESTAMP has no zone and is UTC.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}:\d{2})?$/;
function stampMs(v) {
	const m = STAMP_RE.exec(str(v));
	return m ? Date.parse(`${m[1]}T${m[2]}${m[3] || "Z"}`) : NaN;
}
function parseJson(text, fallback) {
	try {
		const v = JSON.parse(text);
		return v == null ? fallback : v;
	} catch {
		return fallback;
	}
}
const unitKey = (v) => str(v).toLowerCase();
function shiftDay(key, n) {
	const d = new Date(`${key}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
// An assignment stamp as a business day: a bare day as written, an instant on the
// app's clock; anything else is left unreadable, which the rules hold.
function assignmentDay(v, appDay) {
	const s = str(v);
	if (DAY_RE.test(s)) return s;
	const ms = stampMs(s);
	return Number.isFinite(ms) ? appDay(new Date(ms)) : "unreadable";
}
// Only '' is an open assignment (the covering check in server.js); a missing end is no proof of one.
function assignmentEnd(v, appDay) {
	if (v === "") return "";
	return typeof v === "string" ? assignmentDay(v, appDay) : "unreadable";
}
// The stored file the reading used: its path, or a digest of an inline image.
function photoRef(photo) {
	const p = str(photo);
	if (!p) return "";
	return p.startsWith("/uploads/") ? p.slice(0, 300) : `sha256:${crypto.createHash("sha256").update(p).digest("hex")}`;
}

// ── who decided a receipt ───────────────────────────────────────────────────
// A bulk row's id list ends where " — reason:" begins.
const BULK_RE = /^status -> (?:Approved|Rejected|Pending) on \d{1,4} of \d{1,4} expense\(s\): (\d{1,12}(?:,\d{1,12}){0,199})(?: — reason: [\s\S]{0,2000})?$/;
// The ids a bulk status row names; a row that doesn't parse names every number in it.
function bulkIds(details) {
	const text = str(details);
	const m = BULK_RE.exec(text);
	return ((m ? m[1] : text).match(/\d{1,12}/g) || []).map(Number);
}

// Receipts a person's status audit row names: PERSON_DECIDED, which also covers
// decisions made while the recorder was off.
function personDecidedIds(db, onlyId = null) {
	const ids = new Set();
	const single = onlyId == null
		? db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'update_expense_status' AND entity = 'expense' AND role <> 'system'").all()
		: db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'update_expense_status' AND entity = 'expense' AND role <> 'system' AND entity_id = ?").all(String(onlyId));
	for (const r of single) {
		const n = idOf(str(r.entity_id));
		if (n) ids.add(n);
	}
	for (const r of db.prepare("SELECT details FROM audit_trail WHERE action = 'bulk_update_expense_status' AND role <> 'system'").all()) {
		for (const n of bulkIds(r.details)) ids.add(n);
	}
	return ids;
}

// ── the pass ────────────────────────────────────────────────────────────────
// `deps` are server.js's own helpers, named as the <receipt-auto-approve-wiring> block passes them;
// clock and appDay are the tests' to replace.
function create(deps = {}) {
	const { db, config } = deps;
	const clock = deps.clock || (() => new Date());
	const log = deps.log || console;
	const appDay = deps.appDay || ((d) => appTime.appDay(d));
	const health = { lastPassAt: "", lastSkip: "", lastError: "", last: null };
	let running = false;

	const meta = {
		get(key) {
			const r = db.prepare("SELECT value FROM receipt_auto_meta WHERE key = ?").get(key);
			return r ? r.value : "";
		},
		set(key, value) {
			db.prepare("INSERT INTO receipt_auto_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
		},
	};

	const driverKey = (v) => deps.normalizeDriverName(v);

	// A month due for close is never judged: its close may be computing.
	function monthsOpen(row) {
		if (deps.expenseRowPeriodLocked(row)) return false;
		const settlement = deps.expensePostedPeriod(row);
		const operational = str(row.date).slice(0, 7);
		return !deps.monthDue(settlement) && !deps.monthDue(operational);
	}

	// Plan C's owner-operators are skipped. A table that can't be read skips every
	// receipt; a name matching two accounts is skipped; no table finds none.
	function ownerOperatorTest() {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner_operators'").get();
		if (!exists) return () => false;
		let ooUsers;
		let accounts;
		try {
			ooUsers = new Set(db.prepare("SELECT user_id FROM owner_operators").all().map((r) => Number(r.user_id)));
			accounts = db.prepare("SELECT id, driver_name FROM users").all();
		} catch {
			return () => true;
		}
		return (driver) => {
			const key = driverKey(driver);
			if (!key) return false;
			const hits = accounts.filter((a) => driverKey(a.driver_name) === key);
			return hits.length > 1 || (hits.length === 1 && ooUsers.has(Number(hits[0].id)));
		};
	}

	// What every receipt in the pass is judged against, read once.
	function passFacts(now, inMemory) {
		const links = new Map();
		for (const r of db.prepare("SELECT id, expense_id, match_basis, match_distance_km FROM fuel_events WHERE expense_id IS NOT NULL").all()) {
			links.set(Number(r.expense_id), { expense_id: Number(r.expense_id), fuel_event_id: r.id, match_basis: r.match_basis, match_distance_km: r.match_distance_km });
		}
		const memLinks = new Map();
		for (const m of inMemory || []) {
			memLinks.set(Number(m.r.id), {
				expense_id: Number(m.r.id),
				fuel_event_id: m.e.id,
				match_basis: m.dayOff === 0 ? "exact_day" : "adjacent_day",
				match_distance_km: m.distKm == null ? null : Math.round(m.distKm * 10) / 10,
			});
		}
		const assignments = new Map();
		for (const a of db.prepare("SELECT a.driver_name, a.start_date, a.end_date, t.unit_number AS truck_unit FROM truck_assignments a LEFT JOIN trucks t ON t.id = a.truck_id").all()) {
			const k = driverKey(a.driver_name);
			if (!assignments.has(k)) assignments.set(k, []);
			assignments.get(k).push({ truck_unit: a.truck_unit || "", start_date: assignmentDay(a.start_date, appDay), end_date: assignmentEnd(a.end_date, appDay) });
		}
		const owners = new Map();
		for (const t of db.prepare("SELECT unit_number, owner_id FROM trucks").all()) {
			const k = unitKey(t.unit_number);
			owners.set(k, owners.has(k) ? null : t.owner_id);
		}
		const dupRows = db.prepare("SELECT id, date, type, driver, truck_unit, amount, gallons, vendor, vendor_normalized, status FROM expenses").all();
		// The duplicate queue's own suppression; unreadable means none, which holds more.
		let suppressedIds = new Set();
		try {
			suppressedIds = new Set(db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'expense_duplicate_override' AND entity = 'expense'").all()
				.map((r) => Number(r.entity_id)).filter(Number.isFinite));
		} catch { /* none suppressed */ }
		let overriddenIds = null;
		try {
			overriddenIds = rules.overrideNamedIds(db.prepare("SELECT action, entity_id, details FROM audit_trail WHERE action = 'expense_duplicate_override'").all());
		} catch { /* null holds every receipt */ }
		const sinceDay = shiftDay(appDay(now), -((Number(deps.matchDays) || 45) + 1));
		// A copy from before the tables existed has no stored fingerprints (the report reads one).
		const reviewed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'receipt_auto_reviews'").get();
		const others = db.prepare(`SELECT e.id, e.type, e.status, e.truck_unit, e.driver, e.vendor, e.vendor_normalized, e.receipt_details,
			${reviewed ? "COALESCE(r.fingerprints, '[]')" : "'[]'"} AS fps
			FROM expenses e ${reviewed ? "LEFT JOIN receipt_auto_reviews r ON r.expense_id = e.id" : ""}
			WHERE e.type = 'Fuel' AND e.date >= ?`).all(sinceDay)
			.map((o) => ({ ...o, fingerprints: parseJson(o.fps, []) }));
		return {
			links,
			memLinks,
			assignments,
			owners,
			dupRows,
			suppressedIds,
			duplicateIds: rules.duplicateMemberIds(dupRows, { suppressedIds }),
			overriddenIds,
			band: deps.band(),
			others,
			personDecided: personDecidedIds(db),
			isOwnerOperator: ownerOperatorTest(),
		};
	}

	function evidenceFor(c, facts, nowIso, { inMemory }) {
		const rejected = c.status === "Rejected";
		const link = inMemory && rejected ? facts.memLinks.get(c.id) || null : facts.links.get(c.id) || null;
		return {
			now: nowIso,
			link,
			assignments: facts.assignments.get(driverKey(c.driver)) || [],
			truckOwnerId: facts.owners.has(unitKey(c.truck_unit)) ? facts.owners.get(unitKey(c.truck_unit)) : null,
			duplicateIds: rejected ? rules.duplicateMemberIds(facts.dupRows, { suppressedIds: facts.suppressedIds, includeId: c.id }) : facts.duplicateIds,
			overriddenIds: facts.overriddenIds,
			band: facts.band,
			others: facts.others,
			failedReads: c.review_failed_reads || 0,
		};
	}

	// Mode on: a Pending receipt nobody has set. Shadow: any status. Both: filed after
	// the mode's baseline, not future-dated, both months open and not due for close,
	// not an owner-operator's, no live Personal line.
	function candidates(mode, baselineMs, facts) {
		const rows = db.prepare(`SELECT e.id, e.type, e.status, e.amount, e.gallons, e.date, e.truck_unit, e.owner_id, e.driver,
			e.location_state, e.location_source, e.vendor, e.vendor_normalized, e.receipt_details, e.created_at, e.posted_period,
			e.photo_data, COALESCE(e.status_by_role, '') AS status_by_role,
			r.failed_reads AS review_failed_reads
			FROM expenses e LEFT JOIN receipt_auto_reviews r ON r.expense_id = e.id
			WHERE e.type = 'Fuel' AND (r.expense_id IS NULL OR r.verdict = 'wait')
			ORDER BY e.id ASC`).all();
		const kept = rows.filter((c) => {
			const created = stampMs(c.created_at);
			if (!Number.isFinite(created) || !(created > baselineMs)) return false;
			if (!DAY_RE.test(str(c.date)) || str(c.date) > appDay(new Date(created))) return false;
			if (mode === "on" && (c.status !== "Pending" || c.status_by_role !== "" || facts.personDecided.has(c.id))) return false;
			if (!monthsOpen(c)) return false;
			return !facts.isOwnerOperator(c.driver);
		});
		const personal = deps.personalLiveIds(kept.map((c) => c.id));
		return kept.filter((c) => !personal.has(c.id));
	}

	function baselineFor(mode, nowIso) {
		const key = mode === "on" ? "on_baseline_at" : "shadow_baseline_at";
		let at = meta.get(key);
		if (!at) {
			at = nowIso;
			meta.set(key, at);
		}
		return Date.parse(at);
	}

	const upsertStmt = () => db.prepare(`INSERT INTO receipt_auto_reviews
		(expense_id, rules_version, mode, verdict, reasons, evidence, fingerprints, photo_ref, ocr_read_at, failed_reads, passes,
		 status_seen, person_first, first_seen_at, decided_at)
		VALUES (@expense_id, @rules_version, @mode, @verdict, @reasons, @evidence, @fingerprints, @photo_ref, @ocr_read_at, @failed_reads, 1,
		 @status_seen, @person_first, @now, @decided_at)
		ON CONFLICT(expense_id) DO UPDATE SET rules_version = excluded.rules_version, mode = excluded.mode, verdict = excluded.verdict,
		 reasons = excluded.reasons, evidence = excluded.evidence, fingerprints = excluded.fingerprints, photo_ref = excluded.photo_ref,
		 ocr_read_at = excluded.ocr_read_at, failed_reads = excluded.failed_reads, passes = receipt_auto_reviews.passes + 1,
		 status_seen = excluded.status_seen, person_first = excluded.person_first, decided_at = excluded.decided_at
		WHERE receipt_auto_reviews.verdict = 'wait'`);

	// A verdict is final (rules v1, D4): only a waiting row is ever written again.
	function record(mode, c, ev, v, nowIso, facts, read) {
		const evidence = {
			link: ev.link ? { fill: ev.link.fuel_event_id, basis: ev.link.match_basis, km: ev.link.match_distance_km } : null,
			truck: c.truck_unit || "",
			owner: c.owner_id,
			truckOwner: ev.truckOwnerId,
			wait: v.wait || "",
			read: v.read,
			twins: v.twins,
		};
		const personFirst = c.status !== "Pending" || c.status_by_role !== "" || facts.personDecided.has(c.id);
		return upsertStmt().run({
			expense_id: c.id,
			rules_version: rules.RULES_VERSION,
			mode,
			verdict: v.verdict,
			reasons: JSON.stringify(v.reasons || []),
			evidence: JSON.stringify(evidence),
			fingerprints: JSON.stringify(v.fingerprints || []),
			photo_ref: read && read.status === "ok" ? photoRef(c.photo_data) : "",
			ocr_read_at: read && read.status === "ok" ? nowIso : "",
			failed_reads: v.failedReads || 0,
			status_seen: c.status || "",
			person_first: personFirst ? 1 : 0,
			now: nowIso,
			decided_at: v.verdict === "wait" ? "" : nowIso,
		}).changes;
	}

	// The row's own values at approval: the undo tool proves "untouched" against them.
	const SNAPSHOT_COLS = ["amount", "date", "truck_unit", "owner_id", "location_city", "location_state", "location_lat", "location_lng", "vendor", "gallons"];
	function snapshotOf(row) {
		const s = {};
		for (const k of SNAPSHOT_COLS) s[k] = row[k] == null ? null : row[k];
		s.photo = photoRef(row.photo_data);
		return s;
	}

	function auditText(c, ev, v) {
		const r = v.read || {};
		const km = ev.link && ev.link.match_distance_km != null ? ev.link.match_distance_km : "?";
		const money = (n) => (typeof n === "number" ? n.toFixed(2) : "?");
		return `status Pending -> Approved (automatic, rules ${rules.RULES_VERSION}: ELD fill #${ev.link ? ev.link.fuel_event_id : "?"} same day, ${km} km; `
			+ `receipt reads $${money(r.amount)}, ${r.date || "?"}, ${r.gallons == null ? "?" : r.gallons} gal, ${r.state || "?"}; no duplicate; `
			+ `period ${deps.expensePostedPeriod(c) || "unknown"})`;
	}

	// Mode on: one compare-and-set per receipt, its checks re-read inside the transaction.
	function apply(c, ev, v, nowIso) {
		return db.transaction(() => {
			const row = db.prepare(`SELECT id, status, COALESCE(status_by_role, '') AS status_by_role, date, posted_period, created_at,
				amount, truck_unit, owner_id, location_city, location_state, location_lat, location_lng, vendor, gallons, photo_data
				FROM expenses WHERE id = ?`).get(c.id);
			let why = "";
			if (!row) why = "gone";
			else if (!monthsOpen(row)) why = "month_closed";
			else if (personDecidedIds(db, c.id).has(c.id)) why = "person_decided";
			else if (deps.personalLiveIds([c.id]).has(c.id)) why = "personal_line";
			let changed = 0;
			if (!why) {
				changed = db.prepare(`UPDATE expenses SET status = 'Approved', status_by_role = 'system', status_by_id = 0, status_by_name = '${PASS_NAME}', status_at = ?
					WHERE id = ? AND status = 'Pending' AND COALESCE(status_by_role, '') = ''`).run(nowIso, c.id).changes;
				if (!changed) why = "taken_by_person";
			}
			if (changed) {
				db.prepare("UPDATE receipt_auto_reviews SET applied_at = ?, applied_row = ? WHERE expense_id = ?").run(nowIso, JSON.stringify(snapshotOf(row)), c.id);
				deps.logAudit(ACTOR, "update_expense_status", "expense", c.id, auditText(c, ev, v));
			} else {
				db.prepare("UPDATE receipt_auto_reviews SET not_applied = ? WHERE expense_id = ?").run(why, c.id);
			}
			return changed;
		})();
	}

	// A quota or credential refusal (or no key) stops reads for the rest of the business day.
	const scannerDown = (err) => !!err && (err.kind === "unavailable" || err.code === "OCR_NO_KEY");

	async function judgeAll(mode, inMemory) {
		const nowDate = clock();
		const nowIso = nowDate.toISOString();
		const startMs = nowDate.getTime();
		const day = appDay(nowDate);
		const baselineMs = baselineFor(mode, nowIso);
		const facts = passFacts(nowDate, inMemory);
		const list = candidates(mode, baselineMs, facts);
		const counts = { judged: 0, approve: 0, hold: 0, wait: 0, applied: 0, reads: 0, failedReads: 0, deferred: 0 };
		let newVerdicts = 0;
		let readsToday = meta.get("reads_day") === day ? Number(meta.get("reads_count")) || 0 : 0;
		let latched = meta.get("read_latch_day") === day;
		let readsThisPass = 0;

		const finish = (c, ev, v, read) => {
			const at = clock().toISOString();
			const changes = record(mode, c, ev, v, at, facts, read);
			counts.judged++;
			counts[v.verdict]++;
			if (changes && v.verdict !== "wait") newVerdicts++;
			if (changes && mode === "on" && v.verdict === "approve") counts.applied += apply(c, ev, v, at);
		};

		const toRead = [];
		for (const c of list) {
			const ev = evidenceFor(c, facts, nowIso, { inMemory: mode === "shadow" });
			const free = rules.judgeFree(c, ev);
			if (free.verdict === "read") toRead.push({ c, ev });
			else finish(c, ev, rules.judge(c, ev), null);
		}

		// One read at a time, under the caps, the pass deadline and the day latch.
		for (const { c, ev } of toRead) {
			let read;
			const du = deps.receiptUri(c.photo_data);
			if (!du || du.error || !du.uri) read = { status: "no_photo" };
			else if (latched || readsThisPass >= config.maxReadsPerPass || readsToday >= config.maxReadsPerDay
				|| clock().getTime() - startMs > PASS_DEADLINE_MS) {
				read = { status: "deferred" };
				counts.deferred++;
			} else {
				readsThisPass++;
				readsToday++;
				counts.reads++;
				try {
					read = { status: "ok", ocr: await deps.readReceipt(du.uri) };
				} catch (err) {
					read = { status: "failed" };
					counts.failedReads++;
					if (scannerDown(err)) {
						latched = true;
						meta.set("read_latch_day", day);
					}
					log.error(`[receipt-auto-approve] read failed for expense ${c.id}: ${(err && (err.code || err.kind)) || "ERROR"}`);
				}
			}
			finish(c, { ...ev, now: clock().toISOString() }, rules.judge(c, { ...ev, read }), read);
		}

		meta.set("reads_day", day);
		meta.set("reads_count", readsToday);
		meta.set("mode", mode);
		meta.set("interval_min", config.intervalMin);
		meta.set("last_pass_at", clock().toISOString());
		// A quiet pass writes no audit row.
		if (newVerdicts > 0 || counts.applied > 0) {
			deps.logAudit(ACTOR, "receipt_auto_approve_pass", "expense", "",
				`${mode} pass, rules ${rules.RULES_VERSION}: ${counts.judged} judged, ${counts.approve} ${mode === "on" ? "passed" : "would approve"}, `
				+ `${counts.applied} approved, ${counts.hold} held, ${counts.wait} waiting; reads ${counts.reads} (${counts.failedReads} failed, ${counts.deferred} deferred)`);
		}
		return counts;
	}

	// One pass. Detect and match run under the fuel sweep's latch, released before any
	// read, so the 6-hourly sweep is never kept out by a read.
	async function run() {
		if (!config.runs) return { skipped: "off" };
		if (running) return { skipped: "running" };
		if (deps.closeRunning()) {
			health.lastSkip = "close_running";
			return { skipped: "close_running" };
		}
		if (!deps.fuel.take()) {
			health.lastSkip = "sweep_running";
			return { skipped: "sweep_running" };
		}
		running = true;
		try {
			let inMemory = null;
			try {
				deps.fuel.detectAndMatch();
				// Shadow judges a Rejected receipt from a match that includes it; nothing stored.
				if (config.mode === "shadow") inMemory = deps.fuel.matchWithRejected();
			} finally {
				deps.fuel.release();
			}
			const counts = await judgeAll(config.mode, inMemory);
			health.lastPassAt = clock().toISOString();
			health.lastError = "";
			health.last = counts;
			return counts;
		} catch (e) {
			health.lastError = (e && e.code) || "ERROR";
			throw e;
		} finally {
			running = false;
		}
	}

	function status() {
		return {
			mode: config.mode,
			refused: config.refused,
			missing: config.missing,
			lastPassAt: health.lastPassAt,
			lastSkip: health.lastSkip,
			lastError: health.lastError,
			...summary(db, { detail: config.mode === "on" }),
		};
	}

	// GET /api/admin/receipt-auto-approve: Super Admin, read-only. Counts only unless on.
	function mount(app, { requireRole }) {
		app.get("/api/admin/receipt-auto-approve", requireRole("Super Admin"), (req, res) => {
			try {
				res.json(status());
			} catch (e) {
				log.error(`[receipt-auto-approve] report failed: ${(e && e.code) || "ERROR"}`);
				res.status(500).json({ error: "The report could not be read." });
			}
		});
	}

	// The timer: first after a delay, then every interval; one pass at a time.
	function start({ setTimeout: st = setTimeout, setInterval: si = setInterval } = {}) {
		const tick = () => {
			run().catch((e) => log.error(`[receipt-auto-approve] pass failed: ${(e && e.code) || "ERROR"}`));
		};
		st(() => {
			tick();
			si(tick, config.intervalMin * 60 * 1000);
		}, FIRST_PASS_DELAY_MS);
	}

	// The read-only "what would change" report (--free-rules): rules 1-10 for every fuel
	// receipt filed since `since`, whatever its status, with no read and no write.
	// `inMemory` is the matcher's in-memory match that includes Rejected receipts.
	function freeRules({ since = "", inMemory = [] } = {}) {
		const nowDate = clock();
		const facts = passFacts(nowDate, inMemory);
		const rows = db.prepare(`SELECT id, type, status, amount, gallons, date, truck_unit, owner_id, driver, location_state, location_source,
			vendor, vendor_normalized, receipt_details, created_at, posted_period, COALESCE(status_by_role, '') AS status_by_role
			FROM expenses WHERE type = 'Fuel' ORDER BY id`).all();
		const out = { judged: 0, verdicts: { read: 0, hold: 0, wait: 0 }, reasons: {}, notJudged: {}, receipts: [] };
		const personal = deps.personalLiveIds(rows.map((r) => r.id));
		for (const c of rows) {
			const created = stampMs(c.created_at);
			if (!Number.isFinite(created) || appDay(new Date(created)) < since) continue;
			let skip = "";
			if (!DAY_RE.test(str(c.date)) || str(c.date) > appDay(new Date(created))) skip = "future_dated";
			else if (!monthsOpen(c)) skip = "month_closed_or_closing";
			else if (facts.isOwnerOperator(c.driver)) skip = "owner_operator";
			else if (personal.has(c.id)) skip = "personal_line";
			if (skip) {
				out.notJudged[skip] = (out.notJudged[skip] || 0) + 1;
				continue;
			}
			const v = rules.judgeFree(c, evidenceFor(c, facts, nowDate.toISOString(), { inMemory: true }));
			out.judged++;
			out.verdicts[v.verdict] = (out.verdicts[v.verdict] || 0) + 1;
			for (const code of v.reasons) out.reasons[code] = (out.reasons[code] || 0) + 1;
			out.receipts.push({ id: c.id, date: c.date, truckUnit: c.truck_unit || "", status: c.status || "", verdict: v.verdict, reasons: v.reasons });
		}
		return out;
	}

	return { config, run, status, mount, start, health, freeRules, monthsOpen };
}

// A person's Pending or Rejected on a receipt the pass approved marks its review row
// undone (the status routes, with the pass flag on).
function markUndone(db, ids, status, user, nowIso) {
	if (status === "Approved") return 0;
	const list = [...new Set((ids || []).map(idOf).filter(Boolean))];
	if (!list.length) return 0;
	return db.prepare(`UPDATE receipt_auto_reviews SET undone_at = ?, undone_by = ?
		WHERE expense_id IN (${list.map(() => "?").join(",")}) AND applied_at <> '' AND undone_at = ''`)
		.run(nowIso, str(user && user.username) || "unknown", ...list).changes;
}

// ── report figures ──────────────────────────────────────────────────────────
// Counts from the review rows and the receipts' current state; ids only in detail.
// S3 is every would-approve that a person rejected or undid.
function summary(db, { detail = false, since = "" } = {}) {
	const rows = db.prepare(`SELECT r.expense_id, r.mode, r.verdict, r.reasons, r.person_first, r.status_seen, r.applied_at, r.not_applied,
		r.undone_at, r.failed_reads, r.ocr_read_at, r.first_seen_at, r.decided_at, e.status, e.date, e.truck_unit
		FROM receipt_auto_reviews r LEFT JOIN expenses e ON e.id = r.expense_id
		WHERE r.first_seen_at >= ? ORDER BY r.expense_id`).all(since || "");
	const undoneByPerson = new Set();
	for (const a of db.prepare(`SELECT entity_id, details FROM audit_trail WHERE action = 'update_expense_status' AND entity = 'expense' AND role <> 'system'
		AND details LIKE 'status Approved -> Pending%'`).all()) {
		const n = idOf(str(a.entity_id));
		if (n) undoneByPerson.add(n);
	}
	for (const a of db.prepare("SELECT details FROM audit_trail WHERE action = 'bulk_update_expense_status' AND role <> 'system' AND details LIKE 'status -> Pending%'").all()) {
		for (const n of bulkIds(a.details)) undoneByPerson.add(n);
	}
	const c = {
		judged: 0, approve: 0, hold: 0, wait: 0, applied: 0, undone: 0, reads: 0,
		decidedBefore: 0, rejectedJudged: 0, s3: 0,
		notApplied: {}, reasons: {},
		agreement: { approve: { Approved: 0, Rejected: 0, Pending: 0, undone: 0 }, hold: { Approved: 0, Rejected: 0, Pending: 0 } },
	};
	const receipts = [];
	for (const r of rows) {
		c.judged++;
		c[r.verdict] = (c[r.verdict] || 0) + 1;
		if (r.ocr_read_at) c.reads++;
		if (r.applied_at) c.applied++;
		if (r.undone_at) c.undone++;
		if (r.not_applied) c.notApplied[r.not_applied] = (c.notApplied[r.not_applied] || 0) + 1;
		for (const code of parseJson(r.reasons, [])) c.reasons[code] = (c.reasons[code] || 0) + 1;
		if (r.person_first) c.decidedBefore++;
		if (r.status_seen === "Rejected") c.rejectedJudged++;
		const undone = !!r.undone_at || undoneByPerson.has(r.expense_id);
		if (r.verdict === "approve" && (r.status === "Rejected" || undone)) c.s3++;
		if (!r.person_first && (r.verdict === "approve" || r.verdict === "hold")) {
			const bucket = c.agreement[r.verdict];
			const now = r.status || "Pending";
			if (r.verdict === "approve" && undone) bucket.undone++;
			else if (bucket[now] != null) bucket[now]++;
		}
		if (detail) {
			receipts.push({
				id: r.expense_id, date: r.date || "", truckUnit: r.truck_unit || "", verdict: r.verdict, reasons: parseJson(r.reasons, []),
				status: r.status || "", decidedBefore: !!r.person_first, appliedAt: r.applied_at, notApplied: r.not_applied, undoneAt: r.undone_at,
			});
		}
	}
	return detail ? { counts: c, receipts } : { counts: c };
}

// Per owner and open month, the sum of receipts that aren't Rejected: approval moves none of it.
function moneyProof(db, { periodExpr, pnlFilter, openMonth }) {
	return db.prepare(`SELECT owner_id, ${periodExpr} AS period, ROUND(SUM(amount), 2) AS total, COUNT(*) AS n FROM expenses
		WHERE ${pnlFilter} GROUP BY owner_id, period ORDER BY owner_id, period`).all()
		.filter((r) => openMonth(r.period));
}

// Undo all: "untouched" is (1) Approved with the pass's record and stamp, (2) applied, not undone, (3) no
// other actor's audit row since, (4) the row matches its snapshot, (5) no Personal line since and none live,
// (6) both months open and not due for close. Anything else is skipped and listed.
function undoPlan(deps, { since = "" } = {}) {
	const { db } = deps;
	const reviews = db.prepare(`SELECT expense_id, applied_at, applied_row FROM receipt_auto_reviews
		WHERE applied_at <> '' AND undone_at = '' AND applied_at >= ? ORDER BY expense_id`).all(since || "");
	const personalTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expense_personal'").get();
	const bulk = db.prepare("SELECT timestamp, details FROM audit_trail WHERE action = 'bulk_update_expense_status'").all();
	const overrides = db.prepare("SELECT timestamp, entity_id, details FROM audit_trail WHERE action = 'expense_duplicate_override'").all();
	const plan = [];
	for (const rv of reviews) {
		const id = Number(rv.expense_id);
		const skip = (reason) => plan.push({ id, action: "skip", reason });
		const row = db.prepare(`SELECT id, status, status_by_role, status_by_name, status_at, date, posted_period, created_at,
			amount, truck_unit, owner_id, location_city, location_state, location_lat, location_lng, vendor, gallons, photo_data
			FROM expenses WHERE id = ?`).get(id);
		if (!row) { skip("gone"); continue; }
		if (!(row.status === "Approved" && row.status_by_role === "system" && row.status_by_name === PASS_NAME && row.status_at === rv.applied_at)) {
			skip("touched_since"); continue;
		}
		const others = db.prepare(`SELECT 1 FROM audit_trail WHERE entity = 'expense' AND entity_id = ? AND timestamp > ?
			AND NOT (username = ? AND role = 'system') LIMIT 1`).get(String(id), rv.applied_at, PASS_NAME);
		const inBulk = bulk.some((b) => str(b.timestamp) > rv.applied_at && bulkIds(b.details).includes(id));
		const overridden = overrides.some((o) => str(o.timestamp) > rv.applied_at && rules.overrideNamedIds([{ ...o, action: "expense_duplicate_override" }]).has(id));
		if (others || inBulk || overridden) { skip("touched_since"); continue; }
		const snap = parseJson(rv.applied_row, null);
		if (!snap || typeof snap !== "object" || !("amount" in snap)) { skip("uncertain"); continue; }
		const now = {};
		for (const k of Object.keys(snap)) now[k] = k === "photo" ? photoRef(row.photo_data) : row[k] == null ? null : row[k];
		if (JSON.stringify(now) !== JSON.stringify(snap)) { skip("evidence_changed"); continue; }
		if (personalTable) {
			let lines;
			try {
				lines = db.prepare("SELECT created_at, voided_at, kind, reversed_by_id FROM expense_personal WHERE expense_id = ?").all(id);
			} catch {
				skip("uncertain"); continue;
			}
			if (lines.some((l) => l.kind === "deduct" && !l.voided_at && l.reversed_by_id == null)) { skip("personal_line"); continue; }
			if (lines.some((l) => str(l.created_at) >= rv.applied_at)) { skip("personal_line"); continue; }
		}
		if (deps.expenseRowPeriodLocked(row)) { skip("month_closed"); continue; }
		if (deps.monthDue(deps.expensePostedPeriod(row)) || deps.monthDue(str(row.date).slice(0, 7))) { skip("month_closing"); continue; }
		plan.push({ id, action: "undo", appliedAt: rv.applied_at, period: deps.expensePostedPeriod(row) });
	}
	return plan;
}

// Refuse --apply while the pass may still be on: its own setting in this environment,
// or the database showing an on-mode pass within its last interval.
function undoApplyRefusal(db, env, nowMs) {
	if ((env || {}).RECEIPT_AUTO_APPROVE_ENABLED === "true") return "RECEIPT_AUTO_APPROVE_ENABLED is \"true\" here: turn the pass off first";
	const get = (k) => {
		const r = db.prepare("SELECT value FROM receipt_auto_meta WHERE key = ?").get(k);
		return r ? r.value : "";
	};
	const last = Date.parse(get("last_pass_at"));
	const interval = (Number(get("interval_min")) || INTERVAL_MIN.fallback) * 60 * 1000;
	if (get("mode") === "on" && Number.isFinite(last) && nowMs - last < interval + 15 * 60 * 1000) {
		return "the database shows an on-mode pass within its last interval: turn the pass off and wait one interval";
	}
	return "";
}

// The writes, each a compare-and-set that re-checks conditions 1, 5 and 6.
function undoApply(deps, plan, nowIso) {
	const { db } = deps;
	const out = { changed: [], skipped: {} };
	for (const p of plan) {
		if (p.action !== "undo") {
			out.skipped[p.reason] = (out.skipped[p.reason] || 0) + 1;
			continue;
		}
		const done = db.transaction(() => {
			const row = db.prepare("SELECT id, status, status_by_name, status_at, date, posted_period, created_at FROM expenses WHERE id = ?").get(p.id);
			if (!row || deps.expenseRowPeriodLocked(row)) return "month_closed";
			if (deps.monthDue(deps.expensePostedPeriod(row)) || deps.monthDue(str(row.date).slice(0, 7))) return "month_closing";
			if (deps.personalLiveIds([p.id]).has(p.id)) return "personal_line";
			const n = db.prepare(`UPDATE expenses SET status = 'Pending', status_by_role = 'system', status_by_id = 0, status_by_name = '${UNDO_NAME}', status_at = ?
				WHERE id = ? AND status = 'Approved' AND status_by_name = '${PASS_NAME}' AND status_at = ?`).run(nowIso, p.id, p.appliedAt).changes;
			if (!n) return "touched_since";
			db.prepare("UPDATE receipt_auto_reviews SET undone_at = ?, undone_by = ? WHERE expense_id = ?").run(nowIso, UNDO_NAME, p.id);
			deps.logAudit(UNDO_ACTOR, "update_expense_status", "expense", p.id,
				`status Approved -> Pending (undo of an automatic approval, rules ${rules.RULES_VERSION}; period ${p.period || "unknown"})`);
			return "";
		})();
		if (done) out.skipped[done] = (out.skipped[done] || 0) + 1;
		else out.changed.push(p.id);
	}
	const skippedText = Object.entries(out.skipped).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
	deps.logAudit(UNDO_ACTOR, "receipt_auto_approve_undo", "expense", "",
		`undo of automatic approvals: ${out.changed.length} changed; skipped ${skippedText}`);
	return out;
}

module.exports = {
	PASS_NAME,
	UNDO_NAME,
	ACTOR,
	UNDO_ACTOR,
	PASS_DEADLINE_MS,
	FIRST_PASS_DELAY_MS,
	SCHEMA,
	ensureSchema,
	readConfig,
	startLine,
	bulkIds,
	personDecidedIds,
	assignmentDay,
	assignmentEnd,
	photoRef,
	create,
	markUndone,
	summary,
	moneyProof,
	undoPlan,
	undoApplyRefusal,
	undoApply,
};
