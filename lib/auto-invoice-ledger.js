// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the SQLite ledger.
//
// One claim row per load (load_key is the primary key), so a load is drafted at
// most once however often it is seen, however many sweeps or processes run.
// A claim moves between states only through an UPDATE that names the state it
// expects (and, while a draft is being made, the lease owner), and reports the
// rows it changed: 0 means another sweep or process got there first. The invoice
// number is minted once per claim, inside one transaction with the check that
// the claim is still ours and nobody drafted the load by hand, and every retry
// reuses it.
//
// Tables exist only once ensureSchema() ran, which the job does only when its
// mode isn't off. Every time is an ISO-8601 "Z" string from toISOString(), so
// they compare as text. lib/auto-invoice-job.js is the writer; the reports
// (scripts/auto-invoice-shadow-report.js, scripts/auto-invoice-send-trial-report.js)
// read, and the trial report's --record writes its one decision row in the meta.

"use strict";

const rules = require("./auto-invoice-rules");

const CLAIMS = "auto_invoice_claims";
const SHADOW = "auto_invoice_shadow";
const META = "auto_invoice_meta";
const SETTINGS_KEY = "auto_invoice.settings";

const quoteList = (xs) => xs.map((x) => `'${x}'`).join(", ");

function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${CLAIMS} (
			load_key TEXT PRIMARY KEY,
			load_id TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL CHECK (state IN (${quoteList(rules.STATES)})),
			reason_code TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			ratecon_checks INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL DEFAULT '',
			lease_owner TEXT NOT NULL DEFAULT '',
			lease_until TEXT NOT NULL DEFAULT '',
			stage TEXT NOT NULL DEFAULT '' CHECK (stage IN (${quoteList(rules.STAGES)})),
			invoice_id TEXT NOT NULL DEFAULT '',
			invoice_date TEXT NOT NULL DEFAULT '',
			reserved_at TEXT NOT NULL DEFAULT '',
			message_id TEXT NOT NULL DEFAULT '',
			sent_json TEXT NOT NULL DEFAULT '',
			draft_row_id INTEGER,
			drafted_at TEXT NOT NULL DEFAULT '',
			fingerprint_json TEXT NOT NULL DEFAULT '',
			changed_at TEXT NOT NULL DEFAULT '',
			changed_fields TEXT NOT NULL DEFAULT '',
			checked_at TEXT NOT NULL DEFAULT '',
			checked_by TEXT NOT NULL DEFAULT '',
			number_voided_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_${CLAIMS}_state ON ${CLAIMS}(state, next_attempt_at)`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${SHADOW} (
			load_key TEXT PRIMARY KEY,
			load_id TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			ready_at TEXT NOT NULL DEFAULT '',
			verdict TEXT NOT NULL CHECK (verdict IN (${quoteList(rules.SHADOW_VERDICTS)})),
			reason_code TEXT NOT NULL DEFAULT '',
			facts_json TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
	// Added after the tables first shipped: a table made before them gets them
	// here, once (lib/auto-invoice-rules.js messageDigest()).
	addColumn(db, SHADOW, "render_digest_json");
	addColumn(db, CLAIMS, "draft_digest_json");
}

function addColumn(db, table, column) {
	if (columnsOf(db, table).has(column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}

function hasTable(db, name) {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasSchema(db) {
	return hasTable(db, CLAIMS) && hasTable(db, SHADOW) && hasTable(db, META);
}

// ── meta ─────────────────────────────────────────────────────────────────────

function getMeta(db) {
	return Object.fromEntries(db.prepare(`SELECT key, value FROM ${META}`).all().map((r) => [r.key, r.value]));
}

function setMeta(db, key, value) {
	db.prepare(`INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value ?? ""));
}

// ── settings (app_settings, written by the Super Admin settings route) ───────

// One stored list, entry by entry: what the current rules accept is kept, and
// each entry they refuse (a confirmed domain since listed as free mail, a typo
// from a hand edit) is dropped and reported. A value that isn't a list can't be
// read at all (ok: false).
function readList(value, normalize, list) {
	if (value === undefined || value === null) return { ok: true, domains: [], dropped: [] };
	if (!Array.isArray(value)) return { ok: false, domains: [], dropped: [] };
	const kept = new Set();
	const dropped = [];
	for (const item of value) {
		const one = normalize([item]);
		if (one.ok) one.domains.forEach((d) => kept.add(d));
		else dropped.push({ list, domain: String(item ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 80), code: one.code });
	}
	return { ok: true, domains: [...kept].sort(), dropped };
}

// { optOutDomains, confirmedBrokerDomains, unreadable, dropped }. No row: nothing
// opted out and no broker domain confirmed (so no non-Bison draft). Each list is
// read on its own (readList). A row that isn't JSON, or a list that isn't one,
// fails closed: `unreadable` is true, both lists read as empty and the job moves
// nothing until the settings route saves both lists again.
function readSettings(db) {
	const empty = (unreadable) => ({ optOutDomains: [], confirmedBrokerDomains: [], unreadable, dropped: [] });
	if (!hasTable(db, "app_settings")) return empty(false);
	const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY);
	if (!row) return empty(false);
	let parsed;
	try {
		parsed = JSON.parse(row.value);
	} catch {
		return empty(true);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty(true);
	const optOut = readList(parsed.optOutDomains, rules.normalizeOptOutDomains, "optOutDomains");
	const confirmed = readList(parsed.confirmedBrokerDomains, rules.normalizeConfirmedDomains, "confirmedBrokerDomains");
	if (!optOut.ok || !confirmed.ok) return empty(true);
	return { optOutDomains: optOut.domains, confirmedBrokerDomains: confirmed.domains, unreadable: false, dropped: [...optOut.dropped, ...confirmed.dropped] };
}

function writeSettings(db, { optOutDomains, confirmedBrokerDomains = [] }, { by = "", nowIso }) {
	const value = JSON.stringify({ optOutDomains, confirmedBrokerDomains });
	db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
		.run(SETTINGS_KEY, value, nowIso, String(by || ""));
}

// ── local records: documents, drafts, soft deletes, advance lines ────────────

function columnsOf(db, table) {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

// The rows lib/auto-invoice-rules.js indexRecords() reads, by its queries. A
// table the database doesn't have reads as empty.
function readRecords(db) {
	const sql = rules.RECORD_SQL;
	return {
		documents: hasTable(db, "documents")
			? db.prepare(columnsOf(db, "documents").has("deleted_at") ? sql.documents : sql.documentsNoSoftDelete).all()
			: [],
		drafts: hasTable(db, "load_invoice_drafts") ? db.prepare(sql.drafts).all() : [],
		deletedLoads: hasTable(db, "deleted_loads") ? db.prepare(sql.deletedLoads).all() : [],
	};
}

// A load's advance lines not voided, read through the lines module itself (the
// one path to that table); none while its table doesn't exist.
function activeAdvanceLines(db, key) {
	const { invoiceLines } = require("./broker-invoice");
	if (!hasTable(db, invoiceLines.TABLE)) return 0;
	return invoiceLines.listLines(db, key).filter((l) => !l.voided).length;
}

// The load_invoice_drafts rows for a load, either spelling of its id.
function draftRowsFor(db, key) {
	if (!hasTable(db, "load_invoice_drafts")) return [];
	return db.prepare("SELECT id, load_id, invoice_id, via, created_at FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(key, `#${key}`);
}

// Rows somebody else made: everything but this claim's own automatic draft.
function otherDraftRows(db, claim) {
	return draftRowsFor(db, claim.load_key).filter((r) => !(r.via === "auto-imap" && claim.invoice_id && r.invoice_id === claim.invoice_id));
}

function ownDraftRow(db, claim) {
	if (!claim.invoice_id) return null;
	return draftRowsFor(db, claim.load_key).find((r) => r.via === "auto-imap" && r.invoice_id === claim.invoice_id) || null;
}

// ── claims ───────────────────────────────────────────────────────────────────

function getClaim(db, key) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE load_key = ?`).get(key) || null;
}

function listClaims(db, states = null) {
	if (!states) return db.prepare(`SELECT * FROM ${CLAIMS} ORDER BY first_seen_at, load_key`).all();
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY first_seen_at, load_key`).all(...states);
}

// A new claim, or nothing when the load already has one. Returns 1 or 0.
function insertClaim(db, { key, loadId = "", state, code = "", nowIso, nextAttemptAt = "" }) {
	return db.prepare(`INSERT OR IGNORE INTO ${CLAIMS} (load_key, load_id, state, reason_code, first_seen_at, next_attempt_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key, String(loadId || ""), state, code, nowIso, nextAttemptAt || nowIso, nowIso).changes;
}

const PATCHABLE = new Set(["state", "reason_code", "attempts", "ratecon_checks", "next_attempt_at", "lease_owner", "lease_until", "stage",
	"invoice_id", "invoice_date", "reserved_at", "message_id", "sent_json", "draft_row_id", "drafted_at", "fingerprint_json", "changed_at", "changed_fields",
	"checked_at", "checked_by", "number_voided_at", "load_id", "draft_digest_json"]);

// Move a claim, only from one of the `from` states (and, with `owner`, only while
// that owner holds it). Returns the rows changed: 1, or 0 when it had moved on.
function transition(db, key, { from, owner = null, patch, nowIso }) {
	const sets = [];
	const vals = [];
	for (const [k, v] of Object.entries(patch || {})) {
		if (!PATCHABLE.has(k)) throw new Error(`auto-invoice ledger: ${k} is not a claim column`);
		sets.push(`${k} = ?`);
		vals.push(v);
	}
	sets.push("updated_at = ?");
	vals.push(nowIso);
	const where = [`load_key = ?`, `state IN (${from.map(() => "?").join(", ")})`];
	const whereVals = [key, ...from];
	if (owner !== null) {
		where.push("lease_owner = ?");
		whereVals.push(owner);
	}
	return db.prepare(`UPDATE ${CLAIMS} SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...vals, ...whereVals).changes;
}

// queued → working for one owner, only when it is due. 1 when this owner has it.
function lease(db, key, owner, { nowIso, untilIso }) {
	return db.prepare(`UPDATE ${CLAIMS} SET state = 'working', lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE load_key = ? AND state = 'queued' AND next_attempt_at <= ?`).run(owner, untilIso, nowIso, key, nowIso).changes;
}

// A working claim whose lease ran out (a crash or a restart), taken over by `owner`.
function takeOver(db, key, owner, { nowIso, untilIso }) {
	return db.prepare(`UPDATE ${CLAIMS} SET lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE load_key = ? AND state = 'working' AND lease_until < ?`).run(owner, untilIso, nowIso, key, nowIso).changes;
}

function setStage(db, key, owner, stage, nowIso) {
	return transition(db, key, { from: ["working"], owner, patch: { stage }, nowIso });
}

// The next claim due, oldest first.
function nextQueued(db, nowIso) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, first_seen_at, load_key LIMIT 1`).get(nowIso) || null;
}

function expiredWorking(db, nowIso) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state = 'working' AND lease_until < ? ORDER BY lease_until, load_key`).all(nowIso);
}

function inFlight(db, nowIso) {
	return db.prepare(`SELECT COUNT(*) AS n FROM ${CLAIMS} WHERE state = 'working' AND lease_until >= ?`).get(nowIso).n;
}

function draftedSince(db, sinceIso) {
	return db.prepare(`SELECT COUNT(*) AS n FROM ${CLAIMS} WHERE drafted_at <> '' AND drafted_at >= ?`).get(sinceIso).n;
}

// The invoice number for a claim this owner holds, minted once: in one
// transaction, the claim must still be ours and the load undrafted by anyone
// else; a number already reserved is reused with its date and Message-ID. With
// `staleBeforeIso`, a number reserved before then, and never handed to Gmail, is
// given up (`voided`) and a fresh one minted.
// Returns { ok: true, invoiceId, invoiceDate, messageId, reused, voided } or
// { ok: false, reason: "lost" | "drafted" }. `mint(date)` is the server's
// nextInvoiceNumber(), on the same database handle.
function reserveNumber(db, key, owner, { mint, now, dayKey, messageId, nowIso, staleBeforeIso = "" }) {
	return db.transaction(() => {
		const claim = getClaim(db, key);
		if (!claim || claim.state !== "working" || claim.lease_owner !== owner) return { ok: false, reason: "lost" };
		if (otherDraftRows(db, claim).length) return { ok: false, reason: "drafted" };
		const beforeAppend = claim.stage === "" || claim.stage === "reserved" || claim.stage === "rendered";
		const stale = Boolean(claim.invoice_id && staleBeforeIso && beforeAppend && claim.reserved_at && claim.reserved_at < staleBeforeIso);
		if (claim.invoice_id && !stale) {
			if (!claim.stage) transition(db, key, { from: ["working"], owner, patch: { stage: "reserved" }, nowIso });
			return { ok: true, invoiceId: claim.invoice_id, invoiceDate: claim.invoice_date, messageId: claim.message_id, reused: true, voided: null };
		}
		const invoiceId = String(mint(now));
		transition(db, key, { from: ["working"], owner, nowIso, patch: {
			invoice_id: invoiceId, invoice_date: dayKey, reserved_at: nowIso, message_id: messageId, stage: "reserved", sent_json: "", draft_digest_json: "", number_voided_at: "",
		} });
		const voided = stale ? { invoiceId: claim.invoice_id, invoiceDate: claim.invoice_date } : null;
		return { ok: true, invoiceId, invoiceDate: dayKey, messageId, reused: false, voided };
	}).immediate();
}

function countsByState(db) {
	const out = Object.fromEntries(rules.STATES.map((s) => [s, 0]));
	for (const r of db.prepare(`SELECT state, COUNT(*) AS n FROM ${CLAIMS} GROUP BY state`).all()) out[r.state] = r.n;
	return out;
}

function changedCount(db) {
	return db.prepare(`SELECT COUNT(*) AS n FROM ${CLAIMS} WHERE state = 'drafted' AND changed_at <> ''`).get().n;
}

// ── shadow ───────────────────────────────────────────────────────────────────

function getShadow(db, key) {
	return db.prepare(`SELECT * FROM ${SHADOW} WHERE load_key = ?`).get(key) || null;
}

function listShadow(db) {
	return db.prepare(`SELECT * FROM ${SHADOW} ORDER BY first_seen_at, load_key`).all();
}

// Insert or update a shadow row; first_seen_at is kept from the first write.
function upsertShadow(db, { key, loadId = "", verdict, code = "", factsJson = "", readyAt = "", nowIso }) {
	db.prepare(`INSERT INTO ${SHADOW} (load_key, load_id, first_seen_at, ready_at, verdict, reason_code, facts_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(load_key) DO UPDATE SET load_id = excluded.load_id, ready_at = excluded.ready_at, verdict = excluded.verdict,
			reason_code = excluded.reason_code, facts_json = excluded.facts_json, updated_at = excluded.updated_at`)
		.run(key, String(loadId || ""), nowIso, readyAt, verdict, code, factsJson, nowIso);
}

function shadowCounts(db) {
	const out = Object.fromEntries(rules.SHADOW_VERDICTS.map((v) => [v, 0]));
	for (const r of db.prepare(`SELECT verdict, COUNT(*) AS n FROM ${SHADOW} GROUP BY verdict`).all()) out[r.verdict] = r.n;
	return out;
}

// The render shadow's record for one load (a digest, or a refusal code), written
// only while AUTO_INVOICE_SHADOW_RENDERS_ENABLED is on; "" clears it.
function setRenderDigest(db, key, json, nowIso) {
	return db.prepare(`UPDATE ${SHADOW} SET render_digest_json = ?, updated_at = ? WHERE load_key = ?`).run(String(json || ""), nowIso, key).changes;
}

function hasRenderColumn(db) {
	return hasTable(db, SHADOW) && columnsOf(db, SHADOW).has("render_digest_json");
}

// When the comparison's decision was recorded (epoch ms), or null: the earliest
// 'send_pass:<domain>' or 'draft_week:<domain>' meta row the report's --record
// wrote.
function decisionAtMs(db) {
	let at = null;
	for (const r of db.prepare(`SELECT value FROM ${META} WHERE key LIKE 'send_pass:%' OR key LIKE 'draft_week:%'`).all()) {
		let v = null;
		try {
			v = JSON.parse(r.value);
		} catch {
			v = null;
		}
		const t = Date.parse(String((v && (v.passedAt || v.decidedAt)) || ""));
		if (Number.isFinite(t) && (at === null || t < at)) at = t;
	}
	return at;
}

// Clears each render record past its keeping time (rules.renderRecordExpired()):
// the decision plus 30 days, 45 days after the render at most. Returns how many.
function pruneRenderDigests(db, { nowMs }) {
	if (!hasRenderColumn(db) || !hasTable(db, META)) return 0;
	const decided = decisionAtMs(db);
	const clear = db.prepare(`UPDATE ${SHADOW} SET render_digest_json = '' WHERE load_key = ? AND render_digest_json <> ''`);
	let n = 0;
	db.transaction(() => {
		for (const r of db.prepare(`SELECT load_key, render_digest_json FROM ${SHADOW} WHERE render_digest_json <> ''`).all()) {
			let record = null;
			try {
				record = JSON.parse(r.render_digest_json);
			} catch {
				record = null;
			}
			if (rules.renderRecordExpired(record, { nowMs, decisionAtMs: decided })) n += clear.run(r.load_key).changes;
		}
	})();
	return n;
}

module.exports = {
	CLAIMS,
	SHADOW,
	META,
	SETTINGS_KEY,
	ensureSchema,
	hasSchema,
	hasTable,
	getMeta,
	setMeta,
	readSettings,
	writeSettings,
	readRecords,
	activeAdvanceLines,
	draftRowsFor,
	otherDraftRows,
	ownDraftRow,
	getClaim,
	listClaims,
	insertClaim,
	transition,
	lease,
	takeOver,
	setStage,
	nextQueued,
	expiredWorking,
	inFlight,
	draftedSince,
	reserveNumber,
	countsByState,
	changedCount,
	getShadow,
	listShadow,
	upsertShadow,
	shadowCounts,
	setRenderDigest,
	hasRenderColumn,
	decisionAtMs,
	pruneRenderDigests,
};
