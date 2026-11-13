// Factored loads sent to Triumph (lib/triumph-job.js): the SQLite ledger.
//
// One claim per load in triumph_submissions, which lib/factoring-store.js makes at boot
// whatever the settings. This module adds its own columns and triumph_meta, and only once
// the submit mode isn't off. A claim moves only through an UPDATE that names the states it
// may come from and, while it is worked, its lease owner, and that reports the rows it
// changed: 0 means another worker, a person or a restart got there first.
//
// The invoice number is reserved once per claim (reserveNumber()). The lock point
// (lockForUpload()) is the one way a real batch gets the token the transport's put() asks
// for: one immediate transaction re-checks the mode, the claim, the number, the marker, the
// draft rows and a button draft in flight, then locks the marker ('upload'). After that the
// batch never changes: no re-render, no second number, no clearing the mark. put() checks
// the token here again (tokenCheck()) against the file it is about to send.
// Times are ISO-8601 "Z" strings, so they compare as text.

"use strict";

const factoring = require("./factoring-store");

const CLAIMS = factoring.TRIUMPH;
const META = "triumph_meta";
const SETTINGS_KEY = "factoring.settings";
const VIA = "triumph";
// No byte has reached Triumph before pdf_uploading.
const BEFORE_UPLOAD = new Set(["", "reserved", "rendered", "built"]);
// Nothing has triggered at Triumph before the CSV starts, so the batch may go again.
const BEFORE_CSV = new Set([...BEFORE_UPLOAD, "pdf_uploading", "pdf_uploaded"]);
const OWN_LOCK_STAGES = new Set(["pdf_uploading", "pdf_uploaded"]);
// Until a person runs scripts/triumph-submit-resume.js.
const PAUSED_FOR_GOOD = "9999-12-31T00:00:00.000Z";

const quoteList = (xs) => xs.map(() => "?").join(", ");

function hasTable(db, name) {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnsOf(db, table) {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function addColumn(db, table, column, type = "TEXT NOT NULL DEFAULT ''") {
	if (columnsOf(db, table).has(column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function ensureSchema(db) {
	factoring.ensureSchema(db);
	db.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_${CLAIMS}_state ON ${CLAIMS}(state, next_attempt_at)`);
	// When a submitted load changed afterwards, and which of its fields.
	addColumn(db, CLAIMS, "changed_at");
	addColumn(db, CLAIMS, "changed_fields");
}

const hasSchema = (db) => hasTable(db, CLAIMS) && hasTable(db, META);

// `synchronous` can't change inside a transaction, so this wraps one: the lock and the
// CSV's start reach the disk before a byte goes, whatever the connection's own setting.
function withFullSync(db, fn) {
	let before = null;
	try {
		before = db.pragma("synchronous", { simple: true });
		db.pragma("synchronous = FULL");
	} catch {
		before = null;
	}
	try {
		return fn();
	} finally {
		if (before !== null) {
			try {
				db.pragma(`synchronous = ${Number(before)}`);
			} catch {
				// the connection keeps FULL: slower, never less safe
			}
		}
	}
}

// ── meta ─────────────────────────────────────────────────────────────────────

function getMeta(db) {
	if (!hasTable(db, META)) return {};
	return Object.fromEntries(db.prepare(`SELECT key, value FROM ${META}`).all().map((r) => [r.key, r.value]));
}

function setMeta(db, key, value) {
	db.prepare(`INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value ?? ""));
}

// The pause on submitting: { until, reason, ms }, or null. A pause with no end waits for
// the resume script.
function getPause(db, nowIso) {
	const m = getMeta(db);
	return m.paused_until && m.paused_until > nowIso ? { until: m.paused_until, reason: m.pause_reason || "", ms: Number(m.pause_ms) || 0 } : null;
}

function setPause(db, { reason, untilIso = PAUSED_FOR_GOOD, ms = 0 }) {
	db.transaction(() => {
		setMeta(db, "paused_until", untilIso);
		setMeta(db, "pause_reason", reason);
		setMeta(db, "pause_ms", String(ms || ""));
	})();
}

function clearPause(db) {
	return db.prepare(`DELETE FROM ${META} WHERE key IN ('paused_until', 'pause_reason', 'pause_ms')`).run().changes;
}

// ── settings (app_settings, written by the Factoring page's settings route) ──

// The debtor name a person set for each broker email domain (lib/triumph-rules.js
// debtorFor()). { debtorNames, unreadable }. No row, or no map in it: no names, so each
// load waits for its name (DEBTOR_UNMAPPED). A value that can't be read is unreadable.
function readSettings(db) {
	const none = (unreadable) => ({ debtorNames: {}, unreadable });
	if (!hasTable(db, "app_settings")) return none(false);
	const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY);
	if (!row) return none(false);
	let parsed;
	try {
		parsed = JSON.parse(row.value);
	} catch {
		return none(true);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none(true);
	if (parsed.debtorNames === undefined) return none(false);
	const map = parsed.debtorNames;
	if (!map || typeof map !== "object" || Array.isArray(map)) return none(true);
	const debtorNames = {};
	for (const [domain, name] of Object.entries(map)) {
		if (typeof name !== "string") return none(true);
		debtorNames[String(domain).trim().toLowerCase()] = name;
	}
	return { debtorNames, unreadable: false };
}

// ── what the marker says, for the submit job ─────────────────────────────────

// "factored", "not_factored", "locked_upload", "locked_outside" or "unreadable", with the
// row. For this job a marker that can't be read means "stop": nothing is reserved or sent.
// A lock comes first, whatever `factored` says.
function markerState(db, key) {
	let row;
	try {
		row = factoring.markerFor(db, key);
	} catch {
		return { state: "unreadable", row: null };
	}
	if (row && row.locked_at) return { state: row.locked_via === "upload" ? "locked_upload" : "locked_outside", row };
	return { state: row && Number(row.factored) !== 0 ? "factored" : "not_factored", row };
}

// A button draft in flight on the load, as a code, or "".
function inflightCode(db, key, nowIso) {
	const rows = factoring.inflightRows(db, key, nowIso);
	if (!rows.length) return "";
	return rows.some((r) => r.effective === "maybe_drafted") ? "INVOICE_MAYBE_DRAFTED" : "INVOICE_DRAFT_IN_FLIGHT";
}

// ── draft rows ───────────────────────────────────────────────────────────────

function draftRows(db, key) {
	if (!hasTable(db, "load_invoice_drafts")) return [];
	return db.prepare("SELECT id, load_id, invoice_id, via FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(key, `#${key}`);
}

const isOwn = (claim, r) => r.via === VIA && Boolean(claim && claim.invoice_id) && r.invoice_id === claim.invoice_id;
const otherDraftRows = (db, claim) => draftRows(db, claim.load_key).filter((r) => !isOwn(claim, r));
const ownDraftRow = (db, claim) => draftRows(db, claim.load_key).find((r) => isOwn(claim, r)) || null;

// ── claims ───────────────────────────────────────────────────────────────────

function getClaim(db, key) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE load_key = ?`).get(key) || null;
}

function listClaims(db, states = null) {
	if (!states) return db.prepare(`SELECT * FROM ${CLAIMS} ORDER BY first_seen_at, load_key`).all();
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state IN (${quoteList(states)}) ORDER BY first_seen_at, load_key`).all(...states);
}

function insertClaim(db, { key, loadId = "", state, code = "", nowIso }) {
	return db.prepare(`INSERT OR IGNORE INTO ${CLAIMS} (load_key, load_id, state, reason_code, first_seen_at, next_attempt_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key, String(loadId || ""), state, code, nowIso, nowIso, nowIso).changes;
}

const PATCHABLE = new Set(["state", "reason_code", "attempts", "next_attempt_at", "lease_owner", "lease_until", "stage", "invoice_id", "invoice_date",
	"reserved_at", "number_voided_at", "pdf_name", "csv_name", "batch_bytes", "files_json", "fingerprint_json", "draft_row_id", "submitted_at", "via",
	"load_id", "changed_at", "changed_fields"]);

// Move a claim, only from one of the `from` states (and, with `owner`, only while that
// owner holds it). Returns the rows changed: 1, or 0 when it had moved on.
function transition(db, key, { from, owner = null, patch, nowIso }) {
	const sets = [];
	const vals = [];
	for (const [k, v] of Object.entries(patch || {})) {
		if (!PATCHABLE.has(k)) throw new Error(`triumph ledger: ${k} is not a claim column`);
		sets.push(`${k} = ?`);
		vals.push(v);
	}
	sets.push("updated_at = ?");
	vals.push(nowIso);
	const where = ["load_key = ?", `state IN (${quoteList(from)})`];
	const whereVals = [key, ...from];
	if (owner !== null) {
		where.push("lease_owner = ?");
		whereVals.push(owner);
	}
	return db.prepare(`UPDATE ${CLAIMS} SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...vals, ...whereVals).changes;
}

// queued (due) → working for one owner. 1 when this owner has it.
function lease(db, key, owner, { nowIso, untilIso }) {
	return db.prepare(`UPDATE ${CLAIMS} SET state = 'working', lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE load_key = ? AND state = 'queued' AND next_attempt_at <= ?`).run(owner, untilIso, nowIso, key, nowIso).changes;
}

// staged → working, for "Submit now". The run is marked SUBMIT_NOW on the claim, so a stop
// before the lock (a refusal, an exception or a restart) puts it back to staged, and one after
// the lock goes to a person: a staged batch never goes by itself.
const SUBMIT_NOW = "SUBMIT_NOW";
function leaseStaged(db, key, owner, { nowIso, untilIso }) {
	return db.prepare(`UPDATE ${CLAIMS} SET state = 'working', reason_code = ?, lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE load_key = ? AND state = 'staged'`).run(SUBMIT_NOW, owner, untilIso, nowIso, key).changes;
}

// A working claim whose lease ran out (a crash or a restart), taken over by `owner`.
function takeOver(db, key, owner, { nowIso, untilIso }) {
	return db.prepare(`UPDATE ${CLAIMS} SET lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE load_key = ? AND state = 'working' AND lease_until < ?`).run(owner, untilIso, nowIso, key, nowIso).changes;
}

function nextQueued(db, nowIso) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, first_seen_at, load_key LIMIT 1`).get(nowIso) || null;
}

function expiredWorking(db, nowIso) {
	return db.prepare(`SELECT * FROM ${CLAIMS} WHERE state = 'working' AND lease_until < ? ORDER BY lease_until, load_key`).all(nowIso);
}

function inFlight(db, nowIso) {
	return db.prepare(`SELECT COUNT(*) AS n FROM ${CLAIMS} WHERE state = 'working' AND lease_until >= ?`).get(nowIso).n;
}

// New batches since then: each number reserved is one.
function batchesSince(db, sinceIso) {
	return db.prepare(`SELECT COUNT(*) AS n FROM ${CLAIMS} WHERE reserved_at <> '' AND reserved_at >= ?`).get(sinceIso).n;
}

function lastSubmittedAt(db) {
	return db.prepare(`SELECT MAX(submitted_at) AS at FROM ${CLAIMS} WHERE submitted_at <> ''`).get().at || "";
}

function countsByState(db) {
	const out = Object.fromEntries(factoring.TRIUMPH_STATES.map((s) => [s, 0]));
	for (const r of db.prepare(`SELECT state, COUNT(*) AS n FROM ${CLAIMS} GROUP BY state`).all()) out[r.state] = r.n;
	return out;
}

const ours = (claim, owner, nowIso) => Boolean(claim) && claim.state === "working" && claim.lease_owner === owner && String(claim.lease_until || "") >= nowIso;

// ── starting a claim ─────────────────────────────────────────────────────────

// A load goes in line as `by` puts it: "driver" (the driver's own Delivered) or "person"
// (Start, for a marked load nothing has started). Only a factored load the marker hasn't
// locked: one handled in Triumph's process is never claimed. A driver's tap starts a load
// with no claim, one left waiting, or one skipped because its mark had been cleared; Start
// also takes any skipped one. { ok: true, was } or { ok: false, code }.
function armClaim(db, { key, loadId = "", by, nowIso }) {
	return db.transaction(() => {
		const m = markerState(db, key);
		if (m.state === "unreadable") return { ok: false, code: "FACTORING_UNREADABLE" };
		if (m.state === "not_factored") return { ok: false, code: "NOT_FACTORED" };
		if (m.state !== "factored") return { ok: false, code: "FACTORING_LOCKED" };
		const claim = getClaim(db, key);
		if (!claim) {
			insertClaim(db, { key, loadId: loadId || (m.row && m.row.load_id) || "", state: "queued", nowIso });
			return { ok: true, was: "" };
		}
		const rearms = claim.state === "waiting" || (claim.state === "skipped" && (by === "person" || claim.reason_code === "NOT_FACTORED"));
		if (!rearms) return { ok: false, code: "TRIUMPH_ALREADY_STARTED", state: claim.state };
		transition(db, key, { from: [claim.state], nowIso, patch: { state: "queued", reason_code: "", attempts: 0, next_attempt_at: nowIso, lease_owner: "", lease_until: "" } });
		return { ok: true, was: claim.state };
	}).immediate();
}

// Try again, on a claim a person has looked at. Never once the CSV has started: that batch
// may be at Triumph (MAYBE_SUBMITTED), and only a person's look there settles it.
function retryClaim(db, { key, nowIso }) {
	return db.transaction(() => {
		const claim = getClaim(db, key);
		if (!claim || claim.state !== "needs_attention") return { ok: false, code: "NOT_RETRYABLE" };
		if (!BEFORE_CSV.has(claim.stage)) return { ok: false, code: "MAYBE_SUBMITTED" };
		const m = markerState(db, key);
		if (m.state === "unreadable") return { ok: false, code: "FACTORING_UNREADABLE" };
		if (m.state === "not_factored") return { ok: false, code: "NOT_FACTORED" };
		if (m.state === "locked_outside" || (m.state === "locked_upload" && !OWN_LOCK_STAGES.has(claim.stage))) return { ok: false, code: "FACTORING_LOCKED" };
		transition(db, key, { from: ["needs_attention"], nowIso, patch: { state: "queued", reason_code: "", attempts: 0, next_attempt_at: nowIso } });
		return { ok: true };
	}).immediate();
}

// ── the number ───────────────────────────────────────────────────────────────

// The invoice number for a claim this owner holds, reserved once: in one immediate
// transaction, the claim must still be ours with a live lease, the load factored and not
// locked, with no draft row but its own and no button draft in flight. A number reserved
// before and not voided is used again, with its date. `mint(date)` is the server's
// nextInvoiceNumber(), on the same database. { ok: true, invoiceId, invoiceDate, reused }
// or { ok: false, reason }.
function reserveNumber(db, key, owner, { mint, now, dayKey, nowIso }) {
	return db.transaction(() => {
		const claim = getClaim(db, key);
		if (!ours(claim, owner, nowIso)) return { ok: false, reason: "CLAIM_LOST" };
		const m = markerState(db, key);
		if (m.state === "unreadable") return { ok: false, reason: "FACTORING_UNREADABLE" };
		if (m.state === "not_factored") return { ok: false, reason: "NOT_FACTORED" };
		if (m.state !== "factored") return { ok: false, reason: "FACTORING_LOCKED" };
		if (otherDraftRows(db, claim).length) return { ok: false, reason: "ALREADY_INVOICED" };
		const flight = inflightCode(db, key, nowIso);
		if (flight) return { ok: false, reason: flight };
		if (claim.invoice_id && !claim.number_voided_at) {
			if (!claim.stage) transition(db, key, { from: ["working"], owner, nowIso, patch: { stage: "reserved" } });
			return { ok: true, invoiceId: claim.invoice_id, invoiceDate: claim.invoice_date, reused: true };
		}
		const invoiceId = String(mint(now));
		transition(db, key, { from: ["working"], owner, nowIso, patch: {
			invoice_id: invoiceId, invoice_date: dayKey, reserved_at: nowIso, number_voided_at: "", stage: "reserved",
			pdf_name: "", csv_name: "", files_json: "", batch_bytes: 0,
		} });
		return { ok: true, invoiceId, invoiceDate: dayKey, reused: false };
	}).immediate();
}

// The claim's number given up, while no byte of it has reached Triumph. The number, or "".
function voidNumber(db, key, { nowIso }) {
	const claim = getClaim(db, key);
	if (!claim || !claim.invoice_id || claim.number_voided_at || !BEFORE_UPLOAD.has(claim.stage)) return "";
	const n = db.prepare(`UPDATE ${CLAIMS} SET number_voided_at = ?, updated_at = ? WHERE load_key = ? AND number_voided_at = '' AND stage IN ('', 'reserved', 'rendered', 'built')`)
		.run(nowIso, nowIso, key).changes;
	return n ? claim.invoice_id : "";
}

// ── the lock point ───────────────────────────────────────────────────────────

// The one way a real batch gets put()'s token, after the last await before the first byte
// (the render, the merge, the connection). One immediate transaction checks, in turn: the
// submit mode reads live; the claim is this owner's, working, its lease live; it is built
// (or it is its own lock's, resuming an upload); its number is reserved and not voided;
// the marker is factored and locked by nothing but this claim's own upload; no draft row
// but its own; no button draft in flight. Then the stage moves to pdf_uploading and the
// marker locks ('upload'), and the commit reaches the disk before anything is sent.
// { ok: true, token } or { ok: false, code }.
function lockForUpload(db, key, owner, { nowIso, mode }) {
	if (mode !== "live") return { ok: false, code: "NOT_LIVE" };
	return withFullSync(db, () => db.transaction(() => {
		const claim = getClaim(db, key);
		if (!ours(claim, owner, nowIso)) return { ok: false, code: "CLAIM_LOST" };
		const resuming = OWN_LOCK_STAGES.has(claim.stage);
		if (claim.stage !== "built" && !resuming) return { ok: false, code: "STAGE_INVALID" };
		if (!claim.invoice_id || claim.number_voided_at) return { ok: false, code: "NUMBER_VOIDED" };
		const m = markerState(db, key);
		if (m.state === "unreadable") return { ok: false, code: "FACTORING_UNREADABLE" };
		if (m.state === "not_factored") return { ok: false, code: "NOT_FACTORED" };
		if (m.state === "locked_outside") return { ok: false, code: "FACTORING_LOCKED" };
		if (m.state === "locked_upload" && !resuming) return { ok: false, code: "FACTORING_LOCKED" };
		if (m.state === "factored" && resuming) return { ok: false, code: "LOCK_MISSING" };
		if (otherDraftRows(db, claim).length) return { ok: false, code: "ALREADY_INVOICED" };
		const flight = inflightCode(db, key, nowIso);
		if (flight) return { ok: false, code: flight };
		let lockedAt = m.row.locked_at;
		if (!resuming) {
			lockedAt = nowIso;
			db.prepare(`UPDATE ${factoring.FACTORING} SET locked_at = ?, locked_via = 'upload', updated_at = ? WHERE load_key = ? AND locked_at = ''`).run(nowIso, nowIso, key);
			transition(db, key, { from: ["working"], owner, nowIso, patch: { stage: "pdf_uploading" } });
		}
		return { ok: true, token: Object.freeze({ key, owner, invoiceId: claim.invoice_id, lockedAt }) };
	}).immediate());
}

// The batch's own files, as its build recorded them: { pdf: { name, sha256, bytes }, csv }.
function builtFiles(claim) {
	try {
		const f = JSON.parse(String(claim.files_json || ""));
		return f && f.pdf && f.csv ? f : null;
	} catch {
		return null;
	}
}

// put()'s check, against what the database says now: the token's owner still holds the claim
// with a live lease, under the same number; the marker carries the same lock; and the file is
// the part this stage sends (the PDF at pdf_uploading, the CSV at csv_uploading), byte for
// byte as built. { ok: true, part } or { ok: false, code: "UNLOCKED_PUT" }.
function tokenCheck(db, token, { nowIso, name, sha256 }) {
	const refused = { ok: false, code: "UNLOCKED_PUT" };
	if (!token || typeof token !== "object" || !token.key || !token.owner || !token.invoiceId || !token.lockedAt) return refused;
	const claim = getClaim(db, token.key);
	if (!ours(claim, token.owner, nowIso)) return refused;
	if (claim.invoice_id !== token.invoiceId || claim.number_voided_at) return refused;
	let row;
	try {
		row = factoring.markerFor(db, token.key);
	} catch {
		return refused;
	}
	if (!row || row.locked_via !== "upload" || row.locked_at !== token.lockedAt) return refused;
	const files = builtFiles(claim);
	if (!files) return refused;
	const part = claim.stage === "pdf_uploading" ? "pdf" : claim.stage === "csv_uploading" ? "csv" : "";
	if (!part || files[part].name !== name || files[part].sha256 !== sha256) return refused;
	return { ok: true, part };
}

// A stage after the lock, for this owner. The CSV's start reaches the disk before its first
// byte: once it has, the batch is never sent again.
function setStage(db, key, owner, stage, nowIso) {
	const move = () => transition(db, key, { from: ["working"], owner, nowIso, patch: { stage } });
	return stage === "csv_uploading" ? withFullSync(db, move) : move();
}

// ── the record ───────────────────────────────────────────────────────────────

// After the CSV's size was checked: the claim submitted with its draft row, in one
// transaction. `draftRowId` is the engine's record(); when there is none (it couldn't
// record, or a restart came between), the row is written here from what the claim holds
// (`fallback` { total, brokerName, orderNumber }). 1, or 0 when the claim moved on.
function finishSubmitted(db, key, owner, { nowIso, draftRowId = null, fingerprintJson = "", fallback = null }) {
	return db.transaction(() => {
		const claim = getClaim(db, key);
		if (!claim || claim.state !== "working" || claim.lease_owner !== owner || claim.stage !== "csv_uploaded") return 0;
		const own = ownDraftRow(db, claim);
		let rowId = own ? own.id : null;
		if (!rowId && hasTable(db, "load_invoice_drafts")) {
			const f = fallback || {};
			rowId = Number(db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, broker_name, order_number, via, created_by) VALUES (?, ?, '', ?, ?, ?, ?, ?)")
				.run(claim.load_id || key, claim.invoice_id, String(f.total || ""), String(f.brokerName || ""), String(f.orderNumber || ""), VIA, VIA).lastInsertRowid);
		}
		return transition(db, key, { from: ["working"], owner, nowIso, patch: {
			state: "submitted", reason_code: "", stage: "recorded", submitted_at: nowIso, via: VIA, draft_row_id: rowId ?? draftRowId,
			fingerprint_json: fingerprintJson, lease_owner: "", lease_until: "",
		} });
	}).immediate();
}

module.exports = {
	CLAIMS,
	META,
	SETTINGS_KEY,
	VIA,
	BEFORE_UPLOAD,
	BEFORE_CSV,
	PAUSED_FOR_GOOD,
	SUBMIT_NOW,
	ensureSchema,
	hasSchema,
	hasTable,
	getMeta,
	setMeta,
	getPause,
	setPause,
	clearPause,
	readSettings,
	markerState,
	inflightCode,
	draftRows,
	otherDraftRows,
	ownDraftRow,
	getClaim,
	listClaims,
	insertClaim,
	transition,
	lease,
	leaseStaged,
	takeOver,
	nextQueued,
	expiredWorking,
	inFlight,
	batchesSince,
	lastSubmittedAt,
	countsByState,
	armClaim,
	retryClaim,
	reserveNumber,
	voidNumber,
	lockForUpload,
	builtFiles,
	tokenCheck,
	setStage,
	finishSubmitted,
};
