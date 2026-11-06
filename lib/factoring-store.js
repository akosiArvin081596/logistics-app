// Factored loads (Triumph, per load): the marker, and the checks every path that
// hands a broker invoice to Gmail runs (D5: a factored load is never emailed).
//
// Three tables, made at boot whatever the switches (additive; empty until a
// person or the lead's script writes a row):
//   load_factoring          one row per load (the auto job's load key). No row,
//                           or factored 0, means not factored. Set only by
//                           listed accounts or scripts/factoring-mark.js; never a
//                           sheet column. `locked_at` makes the row final.
//   invoice_draft_inflight  the Draft Invoice button's draft while it is being
//                           handed to Gmail (in_flight), or after an answer that
//                           never came (maybe_drafted), so a second press, a mark
//                           or a Triumph submission can't cross it.
//   triumph_submissions     the Triumph submit job's claims. Nothing here writes a
//                           claim; this module only reads them and closes one when
//                           a load is handled in Triumph's process outside the app.
//
// isFactored() is the one check. It throws when the marker can't be read, and
// every sender treats a throw as factored: no number, no render, no send. A
// database without the table (an old copy) reads as no rows.
//
// Every write that checks something runs its checks and its write in one
// immediate transaction, so it can't interleave with the auto job's number or
// another press. Audit rows go through the caller's `audit(action, details)`,
// inside the same transaction. Times are ISO-8601 "Z" strings.

"use strict";

const rules = require("./auto-invoice-rules");

const FACTORING = "load_factoring";
const INFLIGHT = "invoice_draft_inflight";
const TRIUMPH = "triumph_submissions";
const AUTO_CLAIMS = "auto_invoice_claims";

const SOURCES = Object.freeze(["person", "script", "broker_rule"]);
const LOCK_VIAS = Object.freeze(["", "upload", "outside"]);
const TRIUMPH_STATES = Object.freeze(["waiting", "queued", "working", "staged", "submitted", "needs_attention", "skipped", "closed_outside"]);
const TRIUMPH_STAGES = Object.freeze(["", "reserved", "rendered", "built", "pdf_uploading", "pdf_uploaded", "csv_uploading", "csv_uploaded", "recorded"]);
// No byte has reached Triumph before pdf_uploading, so a number held here can be
// given up.
const STAGES_BEFORE_UPLOAD = new Set(["", "reserved", "rendered", "built"]);
const INFLIGHT_PATHS = Object.freeze(["imap", "n8n"]);
const INFLIGHT_STATES = Object.freeze(["in_flight", "maybe_drafted"]);
// A press still in flight after this (a crash or a restart mid hand-off; the
// auto job's lease length) may have reached Gmail.
const INFLIGHT_STALE_MS = 15 * 60 * 1000;
// Draft rows the automatic job sent to the broker (PR S2), not only drafted.
const SENT_VIAS = Object.freeze([rules.VIA_SEND]);
const REASON_MAX = 200;

const quoteList = (xs) => xs.map((x) => `'${x}'`).join(", ");

function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${FACTORING} (
			load_key TEXT PRIMARY KEY,
			load_id TEXT NOT NULL DEFAULT '',
			factored INTEGER NOT NULL CHECK (factored IN (0, 1)),
			source TEXT NOT NULL CHECK (source IN (${quoteList(SOURCES)})),
			reason TEXT NOT NULL DEFAULT '',
			set_at TEXT NOT NULL,
			set_by TEXT NOT NULL DEFAULT '',
			set_by_id INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT NOT NULL DEFAULT '',
			locked_via TEXT NOT NULL DEFAULT '' CHECK (locked_via IN (${quoteList(LOCK_VIAS)})),
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${INFLIGHT} (
			load_key TEXT NOT NULL,
			load_id TEXT NOT NULL DEFAULT '',
			invoice_id TEXT NOT NULL,
			message_id TEXT NOT NULL DEFAULT '',
			path TEXT NOT NULL CHECK (path IN (${quoteList(INFLIGHT_PATHS)})),
			state TEXT NOT NULL CHECK (state IN (${quoteList(INFLIGHT_STATES)})),
			reason TEXT NOT NULL DEFAULT '',
			actor_id INTEGER NOT NULL DEFAULT 0,
			recipient TEXT NOT NULL DEFAULT '',
			total TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (load_key, invoice_id)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${TRIUMPH} (
			load_key TEXT PRIMARY KEY,
			load_id TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL CHECK (state IN (${quoteList(TRIUMPH_STATES)})),
			reason_code TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL DEFAULT '',
			lease_owner TEXT NOT NULL DEFAULT '',
			lease_until TEXT NOT NULL DEFAULT '',
			stage TEXT NOT NULL DEFAULT '' CHECK (stage IN (${quoteList(TRIUMPH_STAGES)})),
			invoice_id TEXT NOT NULL DEFAULT '',
			invoice_date TEXT NOT NULL DEFAULT '',
			reserved_at TEXT NOT NULL DEFAULT '',
			number_voided_at TEXT NOT NULL DEFAULT '',
			pdf_name TEXT NOT NULL DEFAULT '',
			csv_name TEXT NOT NULL DEFAULT '',
			batch_bytes INTEGER NOT NULL DEFAULT 0,
			compacted INTEGER NOT NULL DEFAULT 0,
			files_json TEXT NOT NULL DEFAULT '',
			fingerprint_json TEXT NOT NULL DEFAULT '',
			draft_row_id INTEGER,
			submitted_at TEXT NOT NULL DEFAULT '',
			via TEXT NOT NULL DEFAULT '' CHECK (via IN ('', 'triumph')),
			updated_at TEXT NOT NULL
		)
	`);
}

// A view of that name counts too, so one that can't be read throws (fail closed)
// rather than reading as no marker.
function hasTable(db, name) {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name));
}

const keyOf = (v) => rules.loadKey(v);

// A reason as stored: one line, no control or format characters, at most 200.
function cleanReason(v) {
	const s = String(v == null ? "" : v).slice(0, REASON_MAX * 10).normalize("NFC")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\p{Cf}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(s).slice(0, REASON_MAX).join("");
}

// ── the marker ───────────────────────────────────────────────────────────────

function markerFor(db, key) {
	const k = keyOf(key);
	if (!k || !hasTable(db, FACTORING)) return null;
	return db.prepare(`SELECT * FROM ${FACTORING} WHERE load_key = ?`).get(k) || null;
}

// Fail closed: any stored value but 0 counts as factored.
const rowFactored = (row) => Boolean(row) && Number(row.factored) !== 0;
const rowLocked = (row) => Boolean(row && row.locked_at);

// Is the load factored? true or false; throws when the marker can't be read.
function isFactored(db, key) {
	return rowFactored(markerFor(db, key));
}

// Every factored load's key, read once per sweep.
function factoredKeys(db) {
	if (!hasTable(db, FACTORING)) return new Set();
	return new Set(db.prepare(`SELECT load_key FROM ${FACTORING} WHERE factored <> 0`).all().map((r) => r.load_key));
}

// ── what else holds the load ─────────────────────────────────────────────────

function triumphClaim(db, key) {
	if (!hasTable(db, TRIUMPH)) return null;
	return db.prepare(`SELECT * FROM ${TRIUMPH} WHERE load_key = ?`).get(keyOf(key)) || null;
}

// A submit is working on the claim only while its lease is live: a claim left
// `working` by a restart (no worker holds it) doesn't block a person.
function triumphWorkingLive(claim, nowIso) {
	return Boolean(claim) && claim.state === "working" && String(claim.lease_until || "") >= nowIso;
}

// The claim holds a number that may still be used: reserved or staged, not
// voided, and the claim neither submitted nor closed outside.
function triumphHoldsNumber(claim) {
	return Boolean(claim && claim.invoice_id) && !claim.number_voided_at && claim.state !== "submitted" && claim.state !== "closed_outside";
}

function autoClaimWorking(db, key) {
	if (!hasTable(db, AUTO_CLAIMS)) return false;
	const c = db.prepare(`SELECT state FROM ${AUTO_CLAIMS} WHERE load_key = ?`).get(keyOf(key));
	return Boolean(c && c.state === "working");
}

// The auto job started sending the load's invoice: it went, or may have (its
// answer lost, so no draft row says so yet).
function autoClaimSent(db, key) {
	if (!hasTable(db, AUTO_CLAIMS)) return false;
	const c = db.prepare(`SELECT * FROM ${AUTO_CLAIMS} WHERE load_key = ?`).get(keyOf(key));
	return Boolean(c && c.delivery === "send" && ["appending", "appended", "recorded"].includes(c.stage));
}

// The job's message may be in Gmail with no draft row yet: an append with no answer, or one it
// couldn't record. A person may have sent it from there, so a mark asks first.
function autoClaimMayBeInGmail(db, key) {
	if (!hasTable(db, AUTO_CLAIMS)) return false;
	const c = db.prepare(`SELECT delivery, stage FROM ${AUTO_CLAIMS} WHERE load_key = ?`).get(keyOf(key));
	return Boolean(c && c.delivery !== "send" && ["appending", "appended"].includes(c.stage));
}

// The load_invoice_drafts rows for a load, either spelling of its id.
function draftRows(db, key) {
	if (!hasTable(db, "load_invoice_drafts")) return [];
	const k = keyOf(key);
	return db.prepare("SELECT id, load_id, invoice_id, via FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(k, `#${k}`);
}

// ── the button's in-flight drafts ────────────────────────────────────────────

// One row as the checks read it: `effective` is maybe_drafted for an in_flight
// row older than INFLIGHT_STALE_MS.
function withEffective(row, nowIso) {
	if (!row) return null;
	const started = Date.parse(row.started_at);
	const stale = row.state === "in_flight" && (!Number.isFinite(started) || Date.parse(nowIso) - started >= INFLIGHT_STALE_MS);
	return { ...row, effective: stale ? "maybe_drafted" : row.state };
}

function inflightRows(db, key, nowIso) {
	if (!hasTable(db, INFLIGHT)) return [];
	return db.prepare(`SELECT * FROM ${INFLIGHT} WHERE load_key = ? ORDER BY started_at, invoice_id`).all(keyOf(key)).map((r) => withEffective(r, nowIso));
}

function inflightRow(db, key, invoiceId, nowIso) {
	if (!hasTable(db, INFLIGHT)) return null;
	return withEffective(db.prepare(`SELECT * FROM ${INFLIGHT} WHERE load_key = ? AND invoice_id = ?`).get(keyOf(key), String(invoiceId || "")) || null, nowIso);
}

// ── refusals ─────────────────────────────────────────────────────────────────

const WORDS = Object.freeze({
	FACTORING_LOCKED: "This load was handed to Triumph, so its invoice is final there. Nothing can change it in the app.",
	LOAD_FACTORED: "This load is factored: its invoice goes through Triumph, not by email.",
	LOAD_FACTORED_DRAFT_OUT: "This load is factored, so no invoice can be drafted here. One may already be in Gmail, so check Gmail Drafts and Sent Mail.",
	FACTORING_UNREADABLE: "The factoring marker couldn't be read, so nothing was done. Try again in a minute.",
	TRIUMPH_IN_FLIGHT: "A submit to Triumph is working on this load, or holds an invoice number for it. Try again in a few minutes.",
	AUTO_INVOICE_IN_FLIGHT: "The automatic invoice draft is being made for this load now. Try again in a few minutes.",
	INVOICE_ALREADY_SENT: "This load's invoice was already sent to the broker, so it can't be factored in the app.",
	INVOICE_SENT_MEANWHILE: "The automatic invoice job sent this load's invoice to the broker while this draft was being made, so no draft was made and its number is void.",
	INVOICE_ALREADY_DRAFTED: "An invoice draft already exists for this load. If it was not sent, confirm that with a reason, then delete the draft in Gmail.",
	INVOICE_MAYBE_IN_GMAIL: "An invoice draft for this load may be in Gmail, or may already have been sent from there. If it was not sent, confirm that with a reason, then delete any draft in Gmail.",
	INVOICE_DRAFT_IN_FLIGHT: "An invoice draft for this load is being saved now. Wait a minute, then reload the load.",
	NOT_FACTORED: "This load is not marked factored.",
	FACTORING_NOT_LISTED: "Only the accounts listed for factoring may do this.",
	FACTORING_REASON_REQUIRED: "Give a reason (at most 200 characters).",
	NOA_UNCONFIGURED: "This load is factored, and the app can't put Triumph's assignment on an invoice yet, so no draft was made. Its invoice goes through Triumph's own process.",
	TRIUMPH_NOT_LIVE: "This load is factored, and Triumph hasn't confirmed it is live yet, so no draft was made: the invoice would tell the broker to pay Triumph, which holds nothing for it. To invoice the load another way, clear the mark, then draft it as usual.",
	FACTORING_CHANGED: "This load's factoring mark changed while its invoice was being made, so no draft was made and its number is void. Draft it again.",
	LOAD_ID_FACTORED: "This load is marked factored, so its Load ID can't be changed: whoever manages factored loads can clear the mark, change the ID, then mark the load again.",
	LOAD_ID_CHANGING: "This load's ID is being changed right now, so nothing was changed here. Reload the page and open the load again.",
	LOAD_NOT_ON_SHEET: "No row on Job Tracking holds this Load ID now, so nothing was changed. Reload the page and open the load again.",
	FACTORING_SHEET_UNREADABLE: "Job Tracking couldn't be read to check this load, so nothing was changed. Try again in a minute.",
});

const HTTP = Object.freeze({ FACTORING_UNREADABLE: 503, FACTORING_SHEET_UNREADABLE: 503, FACTORING_NOT_LISTED: 403, FACTORING_REASON_REQUIRED: 400 });

function maybeDraftedWords(invoiceId) {
	return `An invoice draft for this load may already be in Gmail (invoice #${invoiceId}). Use 'Check Gmail' on the load before drafting again.`;
}

function refusal(code, extra = {}) {
	return { ok: false, http: HTTP[code] || 409, code, error: WORDS[code] || code, ...extra };
}

// The first in-flight row of the load (other than `own`) as a refusal, or null.
function inflightRefusal(rows, own = null) {
	const other = rows.find((r) => !own || r.invoice_id !== own);
	if (!other) return null;
	if (other.effective === "maybe_drafted") return { ok: false, http: 409, code: "INVOICE_MAYBE_DRAFTED", error: maybeDraftedWords(other.invoice_id), invoiceId: other.invoice_id };
	return refusal("INVOICE_DRAFT_IN_FLIGHT");
}

// ── marking and clearing ─────────────────────────────────────────────────────

// A check-then-write: immediate, or, for a dry run, a read that writes nothing
// (a read-only handle can run it).
const run = (db, fn, dryRun) => (dryRun ? db.transaction(fn).deferred() : db.transaction(fn).immediate());

// Mark a load factored. `actor` { id, username }; `source` 'person' or 'script';
// `confirmNotSent` true when the caller says its existing draft was never sent
// (with the reason); `dryRun` answers what would happen and writes nothing.
// { ok: true, changed } or a refusal.
function mark(db, { key, loadId = "", reason = "", source = "person", actor = {}, confirmNotSent = false, nowIso, audit = () => {}, dryRun = false }) {
	const k = keyOf(key);
	const why = cleanReason(reason);
	return run(db, () => {
		const row = markerFor(db, k);
		if (rowLocked(row)) return refusal("FACTORING_LOCKED");
		const inflight = inflightRefusal(inflightRows(db, k, nowIso));
		if (inflight) return inflight;
		if (autoClaimWorking(db, k)) return refusal("AUTO_INVOICE_IN_FLIGHT");
		const drafts = draftRows(db, k);
		if (drafts.some((d) => SENT_VIAS.includes(d.via))) return refusal("INVOICE_ALREADY_SENT");
		if (autoClaimSent(db, k)) return refusal("INVOICE_ALREADY_SENT");
		const mayBeInGmail = autoClaimMayBeInGmail(db, k);
		if (mayBeInGmail && !(confirmNotSent === true && why)) return refusal("INVOICE_MAYBE_IN_GMAIL");
		if (drafts.length && !(confirmNotSent === true && why)) return refusal("INVOICE_ALREADY_DRAFTED", { drafts: drafts.map((d) => d.invoice_id) });
		if (rowFactored(row)) return { ok: true, changed: false };
		if (dryRun) return { ok: true, changed: true };
		db.prepare(`INSERT INTO ${FACTORING} (load_key, load_id, factored, source, reason, set_at, set_by, set_by_id, updated_at)
			VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(load_key) DO UPDATE SET load_id = excluded.load_id, factored = 1, source = excluded.source, reason = excluded.reason,
				set_at = excluded.set_at, set_by = excluded.set_by, set_by_id = excluded.set_by_id, updated_at = excluded.updated_at`)
			.run(k, String(loadId || (row && row.load_id) || ""), source, why, nowIso, String(actor.username || ""), Number(actor.id) || 0, nowIso);
		const confirmed = `${drafts.length ? `; existing draft${drafts.length === 1 ? "" : "s"} ${drafts.map((d) => d.invoice_id).join(", ")} confirmed not sent (delete in Gmail)` : ""}${mayBeInGmail ? "; a draft that may be in Gmail, confirmed not sent (delete in Gmail)" : ""}`;
		audit("factoring_marked", `factored (${source})${why ? `: ${why}` : ""}${confirmed}`);
		return { ok: true, changed: true };
	}, dryRun);
}

// Clear a mark (factored 0, a person's explicit "not factored"). A number a
// Triumph claim reserved, with no byte sent, is given up. `dryRun` as mark().
function clear(db, { key, loadId = "", reason = "", source = "person", actor = {}, nowIso, audit = () => {}, dryRun = false }) {
	const k = keyOf(key);
	const why = cleanReason(reason);
	return run(db, () => {
		const row = markerFor(db, k);
		if (rowLocked(row)) return refusal("FACTORING_LOCKED");
		const claim = triumphClaim(db, k);
		if (claim && claim.state === "working") return refusal("TRIUMPH_IN_FLIGHT");
		const inflight = inflightRefusal(inflightRows(db, k, nowIso));
		if (inflight) return inflight;
		if (row && !rowFactored(row)) return { ok: true, changed: false };
		if (dryRun) return { ok: true, changed: true, voided: claim && triumphHoldsNumber(claim) && STAGES_BEFORE_UPLOAD.has(claim.stage) ? claim.invoice_id : "" };
		db.prepare(`INSERT INTO ${FACTORING} (load_key, load_id, factored, source, reason, set_at, set_by, set_by_id, updated_at)
			VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(load_key) DO UPDATE SET factored = 0, source = excluded.source, reason = excluded.reason,
				set_at = excluded.set_at, set_by = excluded.set_by, set_by_id = excluded.set_by_id, updated_at = excluded.updated_at`)
			.run(k, String(loadId || (row && row.load_id) || ""), source, why, nowIso, String(actor.username || ""), Number(actor.id) || 0, nowIso);
		const voided = voidHeldNumber(db, claim, nowIso, audit, "the mark was cleared");
		audit("factoring_cleared", `not factored (${source})${why ? `: ${why}` : ""}${voided ? `; Triumph number ${voided} voided` : ""}`);
		return { ok: true, changed: true, voided };
	}, dryRun);
}

// A number the claim holds, before any byte reached Triumph, given up on the
// claim row and in the audit log. The number, or "".
function voidHeldNumber(db, claim, nowIso, audit, why) {
	if (!claim || !triumphHoldsNumber(claim) || !STAGES_BEFORE_UPLOAD.has(claim.stage)) return "";
	db.prepare(`UPDATE ${TRIUMPH} SET number_voided_at = ?, updated_at = ? WHERE load_key = ?`).run(nowIso, nowIso, claim.load_key);
	audit("triumph_number_void", `${claim.invoice_id} was reserved for this load and never sent (${why})`);
	return claim.invoice_id;
}

// "Handled in Triumph's process": a person handled the factored load outside the
// app. The marker locks for good ('outside'); a claim, if any, closes and gives
// up a number no byte used. No switch: it must work during a rollback.
function handledOutside(db, { key, reason = "", actor = {}, nowIso, audit = () => {} }) {
	const k = keyOf(key);
	const why = cleanReason(reason);
	if (!why) return refusal("FACTORING_REASON_REQUIRED");
	return db.transaction(() => {
		const row = markerFor(db, k);
		if (!rowFactored(row)) return refusal("NOT_FACTORED");
		if (rowLocked(row)) return refusal("FACTORING_LOCKED");
		const claim = triumphClaim(db, k);
		if (triumphWorkingLive(claim, nowIso)) return refusal("TRIUMPH_IN_FLIGHT");
		const inflight = inflightRefusal(inflightRows(db, k, nowIso));
		if (inflight) return inflight;
		db.prepare(`UPDATE ${FACTORING} SET locked_at = ?, locked_via = 'outside', updated_at = ? WHERE load_key = ?`).run(nowIso, nowIso, k);
		let voided = "";
		if (claim) {
			voided = voidHeldNumber(db, claim, nowIso, audit, "handled in Triumph's process");
			db.prepare(`UPDATE ${TRIUMPH} SET state = 'closed_outside', lease_owner = '', lease_until = '', updated_at = ? WHERE load_key = ?`).run(nowIso, k);
		}
		audit("triumph_handled_outside", `handled in Triumph's process: ${why}; claim ${claim ? claim.state : "none"}${voided ? `; number ${voided} voided` : ""}`);
		return { ok: true, claimBefore: claim ? claim.state : "", voided };
	}).immediate();
}

// ── a mark and the row it goes by ────────────────────────────────────────────

// A change to a row's Load ID text. The marker goes by that text, so a new ID would read as not
// factored and its invoice could go out, and the sheet can store a respelling as another key: a
// load keeps its ID while marked. A refusal, or null; a marker that can't be read refuses.
function loadIdChangeCheck(db, { from }) {
	let row;
	try {
		row = markerFor(db, from);
	} catch {
		return refusal("FACTORING_UNREADABLE");
	}
	if (rowLocked(row)) return refusal("FACTORING_LOCKED");
	return rowFactored(row) ? refusal("LOAD_ID_FACTORED") : null;
}

// Every load whose mark was cleared, with when: a row at 0 that isn't final. No row means it was
// never marked. Throws when the marker can't be read.
function clearedMarks(db) {
	if (!hasTable(db, FACTORING)) return new Map();
	return new Map(db.prepare(`SELECT load_key, set_at FROM ${FACTORING} WHERE factored = 0 AND locked_at = ''`).all().map((r) => [r.load_key, r.set_at]));
}

// ── the Draft Invoice button ─────────────────────────────────────────────────

// A factored load's refusal. Where an invoice may already be out, it doesn't say the invoice
// goes through Triumph.
function factoredRefusal(db, k) {
	if (draftRows(db, k).length || autoClaimMayBeInGmail(db, k)) return refusal("LOAD_FACTORED", { error: WORDS.LOAD_FACTORED_DRAFT_OUT });
	return refusal("LOAD_FACTORED");
}

// The marker's half of the checks before prepare(). `confirm`: { confirmFactored,
// reason } from the request; `mayConfirm`: the caller is a listed account (never the
// shared login); `hasAssignmentLines`: an invoice can print the factor's assignment
// lines; `live`: the submit mode reads live (lib/triumph-rules.js submitMode()). A
// refusal, or { ok: true, factored, confirmed, reason }. A marker that can't be read refuses.
function factoredCheck(db, k, { confirm = {}, mayConfirm = false, hasAssignmentLines = false, live = false }) {
	let row;
	try {
		row = markerFor(db, k);
	} catch {
		return refusal("FACTORING_UNREADABLE");
	}
	if (rowLocked(row)) return refusal("FACTORING_LOCKED");
	const factored = rowFactored(row);
	let confirmed = false;
	let reason = "";
	if (factored) {
		if (!confirm || confirm.confirmFactored !== true) return factoredRefusal(db, k);
		// Without the lines the invoice prints the carrier's own bank block, so the
		// broker would be told to pay the wrong party: no account may confirm it.
		if (hasAssignmentLines !== true) return refusal("NOA_UNCONFIGURED");
		// Before Triumph is live the lines send the broker to a party holding nothing.
		if (live !== true) return refusal("TRIUMPH_NOT_LIVE");
		if (!mayConfirm) return refusal("FACTORING_NOT_LISTED");
		reason = cleanReason(confirm.reason);
		if (!reason) return refusal("FACTORING_REASON_REQUIRED");
		const claim = triumphClaim(db, k);
		if (claim && (claim.state === "working" || triumphHoldsNumber(claim))) return refusal("TRIUMPH_IN_FLIGHT");
		confirmed = true;
	}
	return { ok: true, factored, confirmed, reason };
}

// Before prepare(): nothing is read, minted or drafted for a refused load. The marker's
// checks, then a draft of the load in flight or maybe in Gmail.
function draftEarlyCheck(db, { key, nowIso, ...gates }) {
	const k = keyOf(key);
	const checked = factoredCheck(db, k, gates);
	if (!checked.ok) return checked;
	const inflight = inflightRefusal(inflightRows(db, k, nowIso));
	if (inflight) return inflight;
	return checked;
}

// The live preview: the marker's checks alone. It sends nothing, so a draft in flight is
// no reason to refuse it, as it never has been.
function previewCheck(db, { key, ...gates }) {
	return factoredCheck(db, keyOf(key), gates);
}

// The marker's checks again, against what the database says now. `own`: the
// invoice number of the row this press already holds, which is not "another".
// `reissue`: the press confirmed a re-issue of an invoice the auto job sent;
// without it, a send the job began since the press started refuses the press
// (the job's beginSend() refuses while this press's row exists: one side wins).
// `printedAssignment`: the invoice just rendered carries the factor's lines, which has
// to match the marker now, or the broker is told to pay the wrong party.
function lateChecks(db, k, { confirmed, nowIso, own = null, reissue = false, printedAssignment = false }) {
	let row;
	try {
		row = markerFor(db, k);
	} catch {
		return refusal("FACTORING_UNREADABLE");
	}
	if (rowLocked(row)) return refusal("FACTORING_LOCKED");
	if (rowFactored(row)) {
		if (!confirmed) return factoredRefusal(db, k);
		const claim = triumphClaim(db, k);
		if (claim && (claim.state === "working" || triumphHoldsNumber(claim))) return refusal("TRIUMPH_IN_FLIGHT");
		if (printedAssignment !== true) return refusal("FACTORING_CHANGED");
	} else if (printedAssignment === true) {
		return refusal("FACTORING_CHANGED");
	}
	if (reissue !== true && autoClaimSent(db, k)) return refusal("INVOICE_SENT_MEANWHILE");
	return inflightRefusal(inflightRows(db, k, nowIso), own);
}

// After the render (the last await) and before the hand-off: the checks again,
// then the in-flight row, in one immediate transaction. A refusal, or { ok: true }.
function draftBegin(db, { key, loadId = "", invoiceId, messageId = "", path, confirmed = false, reissue = false, printedAssignment = false, actorId = 0, recipient = "", total = "", nowIso }) {
	const k = keyOf(key);
	return db.transaction(() => {
		const r = lateChecks(db, k, { confirmed, reissue, printedAssignment, nowIso });
		if (r) return r;
		db.prepare(`INSERT INTO ${INFLIGHT} (load_key, load_id, invoice_id, message_id, path, state, actor_id, recipient, total, started_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'in_flight', ?, ?, ?, ?, ?)`)
			.run(k, String(loadId || ""), String(invoiceId), String(messageId || ""), path, Number(actorId) || 0, String(recipient || ""), String(total ?? ""), nowIso, nowIso);
		return { ok: true };
	}).immediate();
}

// Before the n8n POST: the same checks against the row this press holds. Passing
// sets its path to n8n. A refusal leaves a maybe_drafted row as it is (the IMAP
// draft may exist) and says so in `keep`; an in_flight row is the caller's to
// drop.
function draftBeforeN8n(db, { key, invoiceId, confirmed = false, reissue = false, printedAssignment = false, nowIso }) {
	const k = keyOf(key);
	return db.transaction(() => {
		const own = inflightRow(db, k, invoiceId, nowIso);
		const r = lateChecks(db, k, { confirmed, reissue, printedAssignment, nowIso, own: String(invoiceId) });
		if (r) return { ...r, keep: Boolean(own && own.state === "maybe_drafted") };
		if (own) db.prepare(`UPDATE ${INFLIGHT} SET path = 'n8n', updated_at = ? WHERE load_key = ? AND invoice_id = ?`).run(nowIso, k, String(invoiceId));
		return { ok: true };
	}).immediate();
}

// The hand-off got no answer: the draft may exist.
function draftMaybe(db, { key, invoiceId, path = null, reason = "unanswered", nowIso }) {
	const sets = ["state = 'maybe_drafted'", "reason = ?", "updated_at = ?"];
	const vals = [String(reason || ""), nowIso];
	if (path) {
		sets.push("path = ?");
		vals.push(path);
	}
	return db.prepare(`UPDATE ${INFLIGHT} SET ${sets.join(", ")} WHERE load_key = ? AND invoice_id = ?`).run(...vals, keyOf(key), String(invoiceId)).changes;
}

// No draft exists (a definite refusal, or nothing was handed off): the row goes.
function draftDrop(db, { key, invoiceId }) {
	return db.prepare(`DELETE FROM ${INFLIGHT} WHERE load_key = ? AND invoice_id = ?`).run(keyOf(key), String(invoiceId)).changes;
}

// The delete record() runs inside its own draft-row transaction (settleInflight),
// so the two commit or roll back together.
function settleSql() {
	return `DELETE FROM ${INFLIGHT} WHERE load_key = ? AND invoice_id = ?`;
}

// ── "Check Gmail" on a maybe-drafted row ─────────────────────────────────────

// The resolve route's write, in one transaction: `found` true writes the
// load_invoice_drafts row (via the row's path) and deletes the in-flight row;
// false only deletes it. Refuses a row that is still in flight.
function resolveInflight(db, { key, invoiceId, found, actor = {}, nowIso, audit = () => {} }) {
	const k = keyOf(key);
	return db.transaction(() => {
		const row = inflightRow(db, k, invoiceId, nowIso);
		if (!row) return { ok: false, http: 404, code: "INFLIGHT_NOT_FOUND", error: "There is no invoice draft waiting to be checked for this load." };
		if (row.effective !== "maybe_drafted") return refusal("INVOICE_DRAFT_IN_FLIGHT");
		let draftRowId = null;
		if (found) {
			draftRowId = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, via, created_by) VALUES (?, ?, ?, ?, ?, ?)")
				.run(row.load_id || k, row.invoice_id, row.recipient, row.total, row.path, String(actor.username || "")).lastInsertRowid;
		}
		db.prepare(`DELETE FROM ${INFLIGHT} WHERE load_key = ? AND invoice_id = ?`).run(k, row.invoice_id);
		return { ok: true, row, draftRowId };
	}).immediate();
}

// ── what Super Admins see ────────────────────────────────────────────────────

// `_factoring` on rows that have a marker (or every row, when `all`), and
// `_draftInflight` on rows with a button draft in flight or maybe drafted.
// Codes and flags only. Never throws; call it on request-local rows.
function annotateRows(db, { rows, idCol, all = false, canMark = false, canRecordOutside = false, inflight = false, nowIso }) {
	if (!Array.isArray(rows) || !rows.length || !idCol) return rows;
	try {
		const markers = hasTable(db, FACTORING) ? new Map(db.prepare(`SELECT * FROM ${FACTORING}`).all().map((r) => [r.load_key, r])) : new Map();
		const claims = hasTable(db, TRIUMPH) ? new Map(db.prepare(`SELECT load_key, state FROM ${TRIUMPH}`).all().map((r) => [r.load_key, r.state])) : new Map();
		const flights = new Map();
		if (inflight && hasTable(db, INFLIGHT)) {
			for (const r of db.prepare(`SELECT * FROM ${INFLIGHT} ORDER BY started_at`).all()) {
				if (!flights.has(r.load_key)) flights.set(r.load_key, withEffective(r, nowIso));
			}
		}
		for (const row of rows) {
			const k = keyOf(row[idCol]);
			if (!k) continue;
			const m = markers.get(k);
			if (m || all) {
				row._factoring = {
					factored: rowFactored(m),
					locked: rowLocked(m),
					lockedVia: m ? m.locked_via : "",
					triumphState: claims.get(k) || "",
					canMark: canMark === true && !rowLocked(m),
					canRecordOutside: canRecordOutside === true && rowFactored(m) && !rowLocked(m),
				};
			}
			const f = flights.get(k);
			if (f) row._draftInflight = { state: f.effective, invoiceId: f.invoice_id, path: f.path };
		}
	} catch {
		// A marker that can't be read shows nothing here; the senders refuse.
	}
	return rows;
}

module.exports = {
	FACTORING,
	INFLIGHT,
	TRIUMPH,
	SOURCES,
	TRIUMPH_STATES,
	TRIUMPH_STAGES,
	INFLIGHT_STALE_MS,
	SENT_VIAS,
	REASON_MAX,
	WORDS,
	refusal,
	ensureSchema,
	hasTable,
	cleanReason,
	markerFor,
	isFactored,
	factoredKeys,
	triumphClaim,
	triumphWorkingLive,
	triumphHoldsNumber,
	inflightRows,
	inflightRow,
	maybeDraftedWords,
	mark,
	clear,
	handledOutside,
	loadIdChangeCheck,
	clearedMarks,
	draftEarlyCheck,
	previewCheck,
	draftBegin,
	draftBeforeN8n,
	draftMaybe,
	draftDrop,
	settleSql,
	resolveInflight,
	annotateRows,
};
