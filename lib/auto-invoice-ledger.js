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
// they compare as text. lib/auto-invoice-job.js is the only writer; the report
// (scripts/auto-invoice-shadow-report.js) reads.

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
			message_id TEXT NOT NULL DEFAULT '',
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

function readSettings(db) {
	const out = { optOutDomains: [] };
	if (!hasTable(db, "app_settings")) return out;
	const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY);
	if (!row) return out;
	try {
		const parsed = JSON.parse(row.value);
		const domains = rules.normalizeOptOutDomains(parsed && parsed.optOutDomains);
		if (domains.ok) out.optOutDomains = domains.domains;
	} catch {
		/* an unreadable value opts nothing out; the route rewrites it whole */
	}
	return out;
}

function writeSettings(db, { optOutDomains }, { by = "", nowIso }) {
	const value = JSON.stringify({ optOutDomains });
	db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
		.run(SETTINGS_KEY, value, nowIso, String(by || ""));
}

// ── local records: documents, drafts, advance lines, soft deletes ────────────

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
		advanceLines: hasTable(db, "broker_invoice_lines") ? db.prepare(sql.advanceLines).all() : [],
		deletedLoads: hasTable(db, "deleted_loads") ? db.prepare(sql.deletedLoads).all() : [],
	};
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
	"invoice_id", "invoice_date", "message_id", "draft_row_id", "drafted_at", "fingerprint_json", "changed_at", "changed_fields",
	"checked_at", "checked_by", "number_voided_at", "load_id"]);

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
// else; a number already reserved is reused with its date and Message-ID.
// Returns { ok: true, invoiceId, invoiceDate, messageId, reused } or
// { ok: false, reason: "lost" | "drafted" }. `mint(date)` is the server's
// nextInvoiceNumber(), on the same database handle.
function reserveNumber(db, key, owner, { mint, now, dayKey, messageId, nowIso }) {
	return db.transaction(() => {
		const claim = getClaim(db, key);
		if (!claim || claim.state !== "working" || claim.lease_owner !== owner) return { ok: false, reason: "lost" };
		if (otherDraftRows(db, claim).length) return { ok: false, reason: "drafted" };
		if (claim.invoice_id) {
			if (!claim.stage) transition(db, key, { from: ["working"], owner, patch: { stage: "reserved" }, nowIso });
			return { ok: true, invoiceId: claim.invoice_id, invoiceDate: claim.invoice_date, messageId: claim.message_id, reused: true };
		}
		const invoiceId = String(mint(now));
		transition(db, key, { from: ["working"], owner, patch: { invoice_id: invoiceId, invoice_date: dayKey, message_id: messageId, stage: "reserved" }, nowIso });
		return { ok: true, invoiceId, invoiceDate: dayKey, messageId, reused: false };
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
};
