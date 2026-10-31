"use strict";

// ============================================================
// Request a fresh signature (ONBOARDING_RESIGN_ENABLED)
// ============================================================
// A Super Admin asks a driver to sign one policy document again. The signed
// original stays live, with its evidence, until the driver's fresh signature is
// stored; then its file stays in the evidence archive and its evidence in the
// row's history (superseded_artifacts). The driver hears of it in the app only.
//
// server.js mounts the routes and hands in its own helpers (the database, the
// signed-artifact functions, the audit writer); the rules and writes are here.
// scripts/test-onboarding-resign.js covers every rule.

const path = require("path");

// v1: the three policy documents. Re-signing the contractor agreement rewrites the
// driver's bank details, and the W-9 carries the SSN, so both are refused for now.
const RESIGN_DOC_KEYS = Object.freeze(["equipment_policy", "mobile_policy", "substance_policy"]);
const NOT_OFFERED = Object.freeze({
	contractor_agreement: "The contractor agreement can't be sent for a fresh signature yet: signing it again rewrites the driver's bank details.",
	w9: "The W-9 can't be sent for a fresh signature yet: it carries the driver's SSN.",
});

const REASON_MIN = 10;
const REASON_MAX = 300;
const ACTOR_MAX = 120;
const ERROR_MAX = 300;
const NOTICE_TYPE = "resign-requested";
const SIGNED_URL_PREFIX = "/uploads/onboarding-signed/";

// Staff-only: server.js strips them from every driver and dispatcher answer.
const STAFF_ONLY_COLUMNS = Object.freeze(["resign_requested_at", "resign_requested_by", "resign_reason", "resign_error", "resign_failed_at"]);
const COLUMN_DDL = Object.freeze([
	"resign_requested_at TEXT DEFAULT ''",
	"resign_requested_by TEXT DEFAULT ''",
	"resign_reason TEXT DEFAULT ''",
	"resign_error TEXT DEFAULT ''",
	"resign_failed_at TEXT DEFAULT ''",
]);

// What the signer is told. None of it names the reason or who asked.
const SIGNER_TEXT = Object.freeze({
	IN_PROGRESS: "Your new signature is still being saved. Wait a moment, then open this document again.",
	ORIGINAL: "We couldn't find your earlier signed copy, so nothing was changed. The office can see this.",
	ARCHIVE: "We couldn't keep a copy of your earlier signed document, so nothing was changed. Please try again later.",
	RENDER: "We couldn't produce your new signed copy, so your earlier signed copy stays on file. Please try again in a moment.",
	CUT_OFF: "We couldn't produce your new signed copy because a value doesn't fit on the form. Your earlier signed copy stays on file, and the office can see this.",
	CHANGED: "This request changed while you were signing, so nothing was changed. Open the document again.",
	SAVE: "We couldn't save your new signature, so your earlier signed copy stays on file. Please try again in a moment.",
});
const STAFF_ORIGINAL_TEXT = Object.freeze({
	ORIGINAL_MISSING: "The signed original isn't on file, so it couldn't be kept as history. Nothing was changed.",
	ORIGINAL_MISMATCH: "The signed original on file doesn't match its recorded fingerprint. Nothing was changed; check the signing evidence first.",
});

// One fresh signature at a time per document: a second tap is refused while the
// first is saving, so one original is never archived and rendered twice.
const inFlight = new Set();

const answer = (status, code, error, extra = {}) => ({ status, body: { error, code, ...extra } });

// Adds the request columns; returns the names it could not add (none on a
// database that already has them). Nothing reads them while the flag is off.
function ensureColumns(db) {
	const have = new Set(db.prepare("PRAGMA table_info(onboarding_documents)").all().map((c) => c.name));
	const failed = [];
	for (const ddl of COLUMN_DDL) {
		const name = ddl.slice(0, ddl.indexOf(" "));
		if (have.has(name)) continue;
		try { db.exec(`ALTER TABLE onboarding_documents ADD COLUMN ${ddl}`); } catch { failed.push(name); }
	}
	return failed;
}

// The signed file's name, as the sign route writes it.
function signedFileName(docKey, userId) {
	return `${docKey}-${userId}-signed.pdf`;
}

function parseUserId(raw) {
	const text = typeof raw === "string" ? raw : "";
	return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
}

function hasOpenRequest(row) {
	return !!row && typeof row.resign_requested_at === "string" && row.resign_requested_at !== "";
}

// A document the driver may sign again right now: signed, in scope, asked for.
function isRequested(row) {
	return !!row && !!row.signed && RESIGN_DOC_KEYS.includes(row.doc_key) && hasOpenRequest(row);
}

// null when a fresh signature is offered for `docKey`, else the refusal.
function scopeRefusal(docKey) {
	if (RESIGN_DOC_KEYS.includes(docKey)) return null;
	if (Object.prototype.hasOwnProperty.call(NOT_OFFERED, docKey)) return answer(409, "RESIGN_NOT_OFFERED", NOT_OFFERED[docKey]);
	return answer(404, "UNKNOWN_DOC_KEY", "Unknown document.");
}

// The original the row points at is on disk, whole, and the file its digest names.
function checkOriginal(deps, row, expectedUrl, file) {
	const missing = { ok: false, code: "ORIGINAL_MISSING" };
	if (row.signed_pdf_url !== expectedUrl) return missing;
	if (!deps.artifactLooksValid(file)) return missing;
	let sha;
	try { sha = deps.sha256File(file); } catch { return missing; }
	if (row.artifact_sha256 && sha !== row.artifact_sha256) return { ok: false, code: "ORIGINAL_MISMATCH" };
	return { ok: true, sha };
}

// The signer's evidence for the original, kept word for word in the history entry.
function evidenceSnapshot(row) {
	return {
		signatureText: row.signature_text || "",
		signedAt: row.signed_at || "",
		signedIp: row.signed_ip || "",
		signedIpSource: row.signed_ip_source || "",
		userAgent: row.signed_user_agent || "",
		consentAgreed: !!row.consent_agreed,
		consentText: row.consent_text || "",
		artifactSha256: row.artifact_sha256 || "",
		artifactBytes: row.artifact_bytes || 0,
		effectiveDate: row.effective_date || "",
		evidenceVersion: row.evidence_version || 0,
		signedPdfUrl: row.signed_pdf_url || "",
	};
}

// One history record: the archived file, why it was replaced, and its evidence.
function historyEntry(archived, row, replacedAt) {
	return {
		kind: "fresh_signature",
		at: archived.at,
		file: archived.file,
		sha256: archived.sha256,
		bytes: archived.bytes,
		reason: row.resign_reason || "",
		by: row.resign_requested_by || "",
		requestedAt: row.resign_requested_at || "",
		replacedAt,
		original: evidenceSnapshot(row),
	};
}

function noticeText(docName) {
	return { title: `Please sign again: ${docName}`, body: "We need a fresh signature on this document. Tap to sign it again." };
}

// The driver's own documents. `strip` is server.js's stripSigningEvidence(), which
// drops the evidence and the staff-only columns; on, each gets a yes/no only.
function driverDocs(rows, { enabled, strip }) {
	return (Array.isArray(rows) ? rows : []).map((r) => {
		const out = strip(r);
		if (enabled) out.resign_requested = isRequested(r);
		return out;
	});
}

// The Drivers page's documents for a Super Admin, with each one's request.
function staffDocs(db, userId, docs) {
	const rows = db.prepare(
		"SELECT doc_key, resign_requested_at, resign_requested_by, resign_reason, resign_error, resign_failed_at FROM onboarding_documents WHERE user_id = ?"
	).all(userId);
	const byKey = new Map(rows.map((r) => [r.doc_key, r]));
	return docs.map((d) => {
		const r = byKey.get(d.doc_key) || {};
		const open = hasOpenRequest(r);
		return {
			...d,
			resignable: !!d.signed && RESIGN_DOC_KEYS.includes(d.doc_key) && !open,
			resign: open
				? { requestedAt: r.resign_requested_at, requestedBy: r.resign_requested_by || "", reason: r.resign_reason || "", error: r.resign_error || "", failedAt: r.resign_failed_at || "" }
				: null,
		};
	});
}

// POST .../request-signature. Writes the request, the driver's notice and an
// audit row, and nothing else: the file, the evidence and `signed` stay as they are.
// deps: { db, signedDir, artifactLooksValid, sha256File, sanitize, now, audit }.
function requestSignature(deps, input) {
	const { db, sanitize } = deps;
	const userId = parseUserId(input.userId);
	if (userId === null) return answer(400, "INVALID_USER_ID", "Invalid driver account id.");
	const docKey = typeof input.docKey === "string" ? input.docKey : "";
	const scope = scopeRefusal(docKey);
	if (scope) return scope;
	const reason = typeof input.reason === "string" ? sanitize(input.reason, REASON_MAX) : "";
	if (Array.from(reason).length < REASON_MIN) {
		return answer(400, "RESIGN_REASON_REQUIRED", `Give a reason of at least ${REASON_MIN} characters. It stays with the request and is never shown to the driver.`);
	}
	const account = db.prepare("SELECT id, role, driver_name FROM users WHERE id = ?").get(userId);
	const driverName = account && typeof account.driver_name === "string" ? account.driver_name.trim() : "";
	if (!account || account.role !== "Driver" || !driverName) {
		return answer(409, "NO_DRIVER_ACCOUNT", "This account isn't a driver account, so it has no documents to sign again.");
	}
	const row = db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? AND doc_key = ?").get(userId, docKey);
	if (!row) return answer(404, "DOCUMENT_NOT_FOUND", "This driver has no such document.");
	if (!row.signed) return answer(409, "NOT_SIGNED", "This document isn't signed yet, so there is nothing to sign again.");
	const already = () => answer(409, "RESIGN_ALREADY_REQUESTED", "A fresh signature is already requested for this document.");
	if (hasOpenRequest(row)) return already();
	const name = signedFileName(docKey, userId);
	const original = checkOriginal(deps, row, `${SIGNED_URL_PREFIX}${name}`, path.join(deps.signedDir, name));
	if (!original.ok) return answer(409, original.code, STAFF_ORIGINAL_TEXT[original.code]);
	const at = deps.now();
	const by = sanitize(input.actor && input.actor.username, ACTOR_MAX);
	const docName = row.doc_name || docKey;
	const notice = noticeText(docName);
	const noticeId = db.transaction(() => {
		const changed = db.prepare(
			"UPDATE onboarding_documents SET resign_requested_at = ?, resign_requested_by = ?, resign_reason = ?, resign_error = '', resign_failed_at = '' WHERE id = ? AND signed = 1 AND COALESCE(resign_requested_at, '') = ''"
		).run(at, by, reason, row.id).changes;
		if (!changed) return null;
		return Number(db.prepare("INSERT INTO notifications (driver_name, type, title, body, metadata) VALUES (?, ?, ?, ?, ?)")
			.run(driverName.toLowerCase(), NOTICE_TYPE, notice.title, notice.body, JSON.stringify({ docKey })).lastInsertRowid);
	})();
	if (noticeId === null) return already();
	deps.audit("request_fresh_signature", row.id,
		`Asked driver user ${userId} (${sanitize(driverName, ACTOR_MAX)}) to sign "${docName}" again; the signed original stays on file. Reason: ${reason}`);
	return { status: 200, body: { success: true, docKey, requestedAt: at }, live: { driverName, docKey, noticeId } };
}

// POST .../cancel-signature-request. Clears an open request; the document is untouched.
// deps: { db, audit }.
function cancelRequest(deps, input) {
	const { db } = deps;
	const userId = parseUserId(input.userId);
	if (userId === null) return answer(400, "INVALID_USER_ID", "Invalid driver account id.");
	const docKey = typeof input.docKey === "string" ? input.docKey : "";
	const row = db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? AND doc_key = ?").get(userId, docKey);
	if (!row) return answer(404, "DOCUMENT_NOT_FOUND", "This driver has no such document.");
	const none = () => answer(409, "NO_OPEN_REQUEST", "There is no open request to withdraw.");
	if (!hasOpenRequest(row)) return none();
	const changed = db.prepare(
		"UPDATE onboarding_documents SET resign_requested_at = '', resign_requested_by = '', resign_reason = '', resign_error = '', resign_failed_at = '' WHERE id = ? AND resign_requested_at = ?"
	).run(row.id, row.resign_requested_at).changes;
	if (!changed) return none();
	deps.audit("cancel_fresh_signature", row.id,
		`Withdrew the request for driver user ${userId} to sign "${row.doc_name || docKey}" again (asked ${row.resign_requested_at} by ${row.resign_requested_by || "unknown"}).`);
	return { status: 200, body: { success: true, docKey } };
}

// The sign route's branch for a requested document: archive the original first,
// replace it only with a stored fresh signature, put it back on any failure. The
// completion step is never called, so nothing is emailed and no sheet is written.
// deps: { db, writeSignedArtifact, archiveSignedArtifact, artifactLooksValid,
//   sha256File, copyFile, archiveDir, appendHistory, sanitize, now, audit }.
async function signAgain(deps, input) {
	const key = `${input.userId}:${input.docKey}`;
	if (inFlight.has(key)) return answer(409, "RESIGN_IN_PROGRESS", SIGNER_TEXT.IN_PROGRESS, { retryable: true });
	inFlight.add(key);
	try {
		return await signAgainHeld(deps, input);
	} finally {
		inFlight.delete(key);
	}
}

async function signAgainHeld(deps, input) {
	const { db } = deps;
	const { userId, docKey, docRow, signedPath, publicUrl, label, render, evidence } = input;
	const requestedAt = docRow.resign_requested_at;
	const docName = docRow.doc_name || docKey;
	const subject = `"${docName}" (driver user ${userId})`;
	// Failure columns only, and only while this request is still the open one.
	const recordFailure = (code, detail) => {
		try {
			db.prepare("UPDATE onboarding_documents SET resign_error = ?, resign_failed_at = ? WHERE id = ? AND signed = 1 AND resign_requested_at = ?")
				.run(deps.sanitize(`${code}: ${detail}`, ERROR_MAX), deps.now(), docRow.id, requestedAt);
		} catch { /* the answer still says what happened */ }
	};

	const original = checkOriginal(deps, docRow, publicUrl, signedPath);
	if (!original.ok) {
		recordFailure(original.code, STAFF_ORIGINAL_TEXT[original.code]);
		deps.audit("fresh_signature_failed", docRow.id, `Fresh signature for ${subject} not stored: ${original.code}. Nothing was changed.`);
		return answer(409, original.code, SIGNER_TEXT.ORIGINAL, { retryable: false });
	}

	let archived = null;
	try { archived = deps.archiveSignedArtifact(signedPath); } catch { archived = null; }
	if (!archived || archived.sha256 !== original.sha) {
		recordFailure("ARCHIVE_FAILED", "the signed original could not be copied into the evidence archive");
		deps.audit("fresh_signature_failed", docRow.id, `Fresh signature for ${subject} not stored: ARCHIVE_FAILED. Nothing was changed.`);
		return answer(503, "ARCHIVE_FAILED", SIGNER_TEXT.ARCHIVE, { retryable: true });
	}

	// Writes only when the live bytes are no longer the original's.
	const restore = () => {
		try {
			if (deps.artifactLooksValid(signedPath) && deps.sha256File(signedPath) === archived.sha256) return "untouched";
			deps.copyFile(path.join(deps.archiveDir, archived.file), signedPath);
			return deps.artifactLooksValid(signedPath) && deps.sha256File(signedPath) === archived.sha256 ? "restored" : "not_restored";
		} catch {
			return "not_restored";
		}
	};
	const restoreNote = (outcome) => (outcome === "restored" ? "; the live file was put back from that copy"
		: outcome === "not_restored" ? "; the live file could NOT be put back from that copy" : "");

	let artifact;
	try {
		artifact = await deps.writeSignedArtifact({ render, signedPath, publicUrl, label });
	} catch (genErr) {
		const outcome = restore();
		const code = genErr.code || "DOCUMENT_RENDER_FAILED";
		recordFailure(code, `${genErr.message}${outcome === "not_restored" ? " (live file not restored)" : ""}`);
		deps.audit("fresh_signature_failed", docRow.id,
			`Fresh signature for ${subject} not stored: ${code}. The signed original stays on file; a copy is in the evidence archive as ${archived.file}${restoreNote(outcome)}.`);
		const cutOff = Array.isArray(genErr.clippedLabels) && genErr.clippedLabels.length > 0;
		return answer(503, code, cutOff ? SIGNER_TEXT.CUT_OFF : SIGNER_TEXT.RENDER, { retryable: !cutOff });
	}

	// From here to the answer there is no await: the row is read again and the
	// evidence swapped in one transaction, so nothing can change in between.
	const replacedAt = deps.now();
	let outcome;
	try {
		outcome = db.transaction(() => {
			const fresh = db.prepare("SELECT * FROM onboarding_documents WHERE id = ?").get(docRow.id);
			if (!fresh || !fresh.signed || fresh.resign_requested_at !== requestedAt
				|| fresh.artifact_sha256 !== docRow.artifact_sha256 || fresh.signed_pdf_url !== docRow.signed_pdf_url) return "changed";
			const history = deps.appendHistory(fresh.superseded_artifacts, historyEntry(archived, fresh, replacedAt));
			db.prepare(
				`UPDATE onboarding_documents SET signature_text = ?, signed_at = ?, signed_pdf_url = ?,
				 signed_ip = ?, signed_ip_source = ?, signed_user_agent = ?, consent_agreed = ?, consent_text = ?, artifact_sha256 = ?, artifact_bytes = ?, effective_date = ?, evidence_version = ?,
				 superseded_artifacts = ?, resign_requested_at = '', resign_requested_by = '', resign_reason = '', resign_error = '', resign_failed_at = ''
				 WHERE id = ?`
			).run(evidence.signatureText, evidence.signedAt, artifact.url,
				evidence.net.ip, evidence.net.ipSource, evidence.net.userAgent, evidence.consent.agreed, evidence.consent.text,
				artifact.sha256, artifact.bytes, evidence.effectiveDate, evidence.evidenceVersion,
				history, docRow.id);
			return { reason: fresh.resign_reason || "", by: fresh.resign_requested_by || "" };
		})();
	} catch {
		outcome = "failed";
	}
	if (outcome === "changed" || outcome === "failed") {
		const back = restore();
		if (outcome === "changed") {
			deps.audit("fresh_signature_failed", docRow.id,
				`Fresh signature for ${subject} not stored: the request changed while it was being signed. The signed original stays on file; a copy is in the evidence archive as ${archived.file}${restoreNote(back)}.`);
			return answer(409, "RESIGN_REQUEST_CHANGED", SIGNER_TEXT.CHANGED, { retryable: false });
		}
		recordFailure("RESIGN_SAVE_FAILED", `the new evidence could not be saved${back === "not_restored" ? " (live file not restored)" : ""}`);
		deps.audit("fresh_signature_failed", docRow.id,
			`Fresh signature for ${subject} not stored: RESIGN_SAVE_FAILED. The signed original stays on file; a copy is in the evidence archive as ${archived.file}${restoreNote(back)}.`);
		return answer(503, "RESIGN_SAVE_FAILED", SIGNER_TEXT.SAVE, { retryable: true });
	}

	deps.audit("fresh_signature", docRow.id,
		`Fresh signature stored for ${subject}: the original is archived as ${archived.file} (sha256 ${archived.sha256.slice(0, 16)}…, ${archived.bytes} bytes) and kept in the document's history; new sha256 ${artifact.sha256.slice(0, 16)}…, effective date ${evidence.effectiveDate}. Requested ${requestedAt} by ${outcome.by || "unknown"}. Reason: ${outcome.reason}`);
	return { status: 200, body: { success: true, resigned: true } };
}

module.exports = {
	RESIGN_DOC_KEYS,
	NOT_OFFERED,
	REASON_MIN,
	REASON_MAX,
	NOTICE_TYPE,
	STAFF_ONLY_COLUMNS,
	SIGNER_TEXT,
	ensureColumns,
	signedFileName,
	hasOpenRequest,
	isRequested,
	scopeRefusal,
	evidenceSnapshot,
	historyEntry,
	noticeText,
	driverDocs,
	staffDocs,
	requestSignature,
	cancelRequest,
	signAgain,
};
