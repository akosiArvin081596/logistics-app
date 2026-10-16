// ============================================================
// Advance lines on a broker invoice (B20 Phase 1)
// ============================================================
// A Super Admin records an advance the broker already paid on a load (a fuel
// advance, by default "Fuel advance"), and the broker invoice for that load
// prints it: the line haul, the advance as a deduction, the balance due, and an
// editable footnote ("*$650 for fuel advance"). The owner's answers of
// 2026-10-16 (product-decisions.md, "B20 broker invoice lines").
//
// ⚠️ INVOICE-ONLY, like an edited invoice Total. A line lives in its own table
// and on the invoice draft that printed it, and nothing that settles money
// reads either: Job Tracking's Payment, revenue, driver pay, investor payouts,
// the P&L, Financials, the payout ledger, KPI and the integrity check keep the
// line haul. A line is a record of money the broker paid early, not a cost and
// not a change of what the load earned. That is also why a load in a closed
// month may take one: no settled figure moves.
//
// BROKER_INVOICE_LINES_ENABLED, off unless set to true/1/yes/on. With it off
// the server builds no table, the draft routes print and record exactly what
// they do without this module, and the invoice-lines routes hand every request
// on. linesEnabled() is the one reader of the flag.
//
// Money is integer cents throughout. The amount a person types is judged by
// shape first (the same gate as the invoice Total) and then read by string
// surgery, never through a float; the balance is computed here, on the server,
// and the editor only shows the strings it is given. Amounts are never taken
// from a draft request: a draft names line ids, and the stored amounts print.
//
// Rows are never deleted and their figures never change: a line is voided
// instead, once, with a reason. The database enforces it (TEMP triggers on the
// server's own connection, the pattern of installPeriodLockTriggers() in
// server.js), so a hand-run script on another connection, such as the
// environment refresh's text scrub, is not blocked by them.
//
// Pure: every function takes the database it works on; no network, no files,
// no require.

"use strict";

const FLAG = "BROKER_INVOICE_LINES_ENABLED";
const TABLE = "broker_invoice_lines";
const LINE_KINDS = Object.freeze(["advance"]);
const DEFAULT_ADVANCE_LABEL = "Fuel advance";
const LINE_LABEL_MAX = 80;
const LINE_REFERENCE_MAX = 40;
const LINE_NOTE_MAX = 500;
const FOOTNOTE_MAX = 500;
const VOID_REASON_MAX = 200;
// $1,000,000.00, the invoice Total's ceiling.
const LINE_AMOUNT_MAX_CENTS = 100000000;
const MAX_ACTIVE_LINES = 20;
// A single-line field is cleaned within this many characters and then judged
// whole by its anchored pattern, so an over-long value is REFUSED, never cut to
// fit (the INVOICE_FIELD_SCAN_MAX discipline in server.js).
const FIELD_SCAN_MAX = 200;
// A multi-line field longer than this, raw, is refused before any clean-up.
const TEXT_SCAN_MAX = 2000;

// The invoice Total's money shape (INVOICE_TOTAL_FORMAT_RE in server.js).
const LINE_AMOUNT_RE = /^\$?\s*(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;
// The Order # rule (INVOICE_ORDER_RE), 80: starts with a letter or number, then
// any printable character but < and >.
const LINE_LABEL_RE = /^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$/u;
// The PO # rule (INVOICE_REF_RE), 40.
const LINE_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\/#-]{0,39}$/;
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
// EVIDENCE_TEXT_STRIP in server.js: control, zero-width, bidi and BOM runs.
const TEXT_STRIP = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g;

// Every sentence a refusal carries. client/src/lib/invoiceLines.js shows the
// same words before a request is sent; scripts/test-invoice-lines-client.mjs
// pins the two equal.
const LINE_MESSAGES = Object.freeze({
	BODY_INVALID: "Send the line as a JSON object.",
	KIND_INVALID: "Only advance lines can be added.",
	LABEL_INVALID: "The label must be 1–80 characters, start with a letter or number, and contain no line breaks, control characters, < or >.",
	AMOUNT_INVALID: "Enter the advance amount, e.g. 650 or 650.00.",
	AMOUNT_OUT_OF_RANGE: "The amount must be between $0.01 and $1,000,000.00.",
	DATE_INVALID: "The received date must be a real date in YYYY-MM-DD form.",
	REFERENCE_INVALID: "The reference must start with a letter or number and use only letters, numbers, spaces or . _ / # - (40 at most).",
	NOTE_INVALID: "The note must be text.",
	NOTE_TOO_LONG: "The note must be 500 characters or fewer.",
	FOOTNOTE_INVALID: "The footnote must be text.",
	FOOTNOTE_TOO_LONG: "The footnote must be 500 characters or fewer.",
	VOID_REASON_REQUIRED: "Say why the line is voided.",
	VOID_REASON_INVALID: "The reason must be text.",
	VOID_REASON_TOO_LONG: "The reason must be 200 characters or fewer.",
	IDS_INVALID: "lineIds must be a list of at most 20 line numbers.",
});

// ── the flag ─────────────────────────────────────────────────────────────────
// Off unless the value is true/1/yes/on. The routes pass their own process.env,
// so the reading follows the server's environment and nothing else. Named in
// full (not env[FLAG]) so the flag checks that scan for `env.<NAME>_ENABLED`
// (scripts/test-replica-enable-flag.js) see this read and its default-off shape.
function linesEnabled(env = process.env) {
	if (!env) return false;
	return /^(true|1|yes|on)$/i.test(String(env.BROKER_INVOICE_LINES_ENABLED ?? "").trim());
}

// ── text ─────────────────────────────────────────────────────────────────────
// One line of typed text: sanitizeEvidenceText() in server.js, the same cut
// (4 × max before normalizing, never half a surrogate pair), the same strip
// and the same codepoint cap.
function cleanLine(v, max) {
	let raw = String(v == null ? "" : v);
	if (raw.length > max * 4) {
		raw = raw.slice(0, max * 4);
		const last = raw.charCodeAt(raw.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) raw = raw.slice(0, -1);
	}
	const s = raw.normalize("NFC").replace(TEXT_STRIP, " ").trim();
	return Array.from(s).slice(0, max).join("");
}
// Text that may run over several lines: sanitizeInvoiceNotes() in server.js.
// Line endings become \n, each line gets the strip, every remaining format
// character (\p{Cf}) is deleted, the whole is trimmed.
function cleanText(v, max) {
	const s = String(v == null ? "" : v)
		.normalize("NFC")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(TEXT_STRIP, " ").replace(/\p{Cf}+/gu, ""))
		.join("\n")
		.trim();
	return Array.from(s).slice(0, max).join("");
}

// ── money ────────────────────────────────────────────────────────────────────
// Integer cents from a typed amount, or null. The shape is judged FIRST, then
// the digits are read as text: "0.29" is 29, where 0.29 * 100 is
// 28.999999999999996. A number is read through its own decimal spelling, so a
// value with more than two decimals, a negative or an exponent is refused.
function toCents(value) {
	let raw;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		raw = String(value);
	} else if (typeof value === "string") {
		raw = value.trim();
	} else {
		return null;
	}
	if (!LINE_AMOUNT_RE.test(raw)) return null;
	const digits = raw.replace(/[$,\s]/g, "");
	const [whole, frac = ""] = digits.split(".");
	const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
	return Number.isSafeInteger(cents) ? cents : null;
}
// "$1,750.00" from 175000, "-$650.00" from -65000. Integer arithmetic only.
function formatCents(cents) {
	const n = Math.trunc(Number(cents) || 0);
	const abs = Math.abs(n);
	const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${n < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
// The footnote's short form: "$650" for whole dollars, "$650.50" otherwise.
function footnoteAmount(cents) {
	const s = formatCents(cents);
	return s.endsWith(".00") ? s.slice(0, -3) : s;
}
// Dollars as the draft route holds them (parseMoney() of a sheet or rate-con
// figure, a validated typed total) to cents. Those values carry at most two
// decimals, so rounding only removes the float's binary noise.
function dollarsToCents(dollars) {
	const n = Number(dollars);
	return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function isRealDay(y, mo, d) {
	if (!(y >= YEAR_MIN && y <= YEAR_MAX) || !(mo >= 1 && mo <= 12) || !(d >= 1)) return false;
	const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}
// "MM/DD/YYYY" from "YYYY-MM-DD" by string surgery (a day has no zone).
function isoToMdy(iso) {
	const m = ISO_DAY_RE.exec(String(iso || ""));
	return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

// A label inside a sentence: "Fuel advance" reads "fuel advance"; an acronym
// ("EFS advance") or anything not in sentence case is left as typed.
function labelInSentence(label) {
	const s = String(label || "");
	return /^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// The load's key: what the draft route compares a Load ID by (trimmed, lower
// case, one leading "#" dropped), so "#41000017" and "41000017" are one load.
function loadKey(v) {
	return String(v == null ? "" : v).trim().toLowerCase().replace(/^#/, "");
}

// ── the schema ───────────────────────────────────────────────────────────────
// Idempotent. Called at boot only while the flag is on. Adds two columns to
// load_invoice_drafts (the copy of the lines a draft printed, and its line
// haul); a missing drafts table is skipped, never an error.
function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			load_id TEXT NOT NULL,
			load_key TEXT NOT NULL,
			invoice_id TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL CHECK (kind IN ('advance')),
			label TEXT NOT NULL,
			amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0 AND amount_cents <= ${LINE_AMOUNT_MAX_CENTS}),
			received_on TEXT NOT NULL DEFAULT '',
			reference TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
			voided_at TEXT,
			voided_by TEXT NOT NULL DEFAULT '',
			void_reason TEXT NOT NULL DEFAULT ''
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_load ON ${TABLE}(load_key, id)`);
	for (const col of ["lines_json", "gross_total"]) {
		try { db.exec(`ALTER TABLE load_invoice_drafts ADD COLUMN ${col} TEXT DEFAULT ''`); } catch { /* already there, or no drafts table */ }
	}
	installTriggers(db);
}

// Append-only, at the database. An UPDATE may only (a) stamp invoice_id once,
// from '' to the first invoice that printed the line, and (b) void an active
// line once (voided_at, voided_by and void_reason together). Every other
// change, and every DELETE, aborts.
function installTriggers(db) {
	const refuse = "SELECT RAISE(ABORT, 'INVOICE_LINE_APPEND_ONLY: an invoice line is never deleted or changed; void it instead');";
	const frozen = ["load_id", "load_key", "kind", "label", "amount_cents", "received_on", "reference", "note", "created_by", "created_at"]
		.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");
	db.transaction(() => {
		for (const t of [`${TABLE}_append_only`, `${TABLE}_no_delete`]) {
			db.exec(`DROP TRIGGER IF EXISTS main.${t}`);
			db.exec(`DROP TRIGGER IF EXISTS temp.${t}`);
		}
		db.exec(`CREATE TEMP TRIGGER ${TABLE}_no_delete BEFORE DELETE ON main.${TABLE} BEGIN ${refuse} END`);
		db.exec(`CREATE TEMP TRIGGER ${TABLE}_append_only BEFORE UPDATE ON main.${TABLE}
			WHEN ${frozen}
				OR (OLD.invoice_id <> '' AND NEW.invoice_id IS NOT OLD.invoice_id)
				OR (OLD.voided_at IS NOT NULL AND (NEW.voided_at IS NOT OLD.voided_at OR NEW.voided_by IS NOT OLD.voided_by OR NEW.void_reason IS NOT OLD.void_reason))
				OR (OLD.voided_at IS NULL AND NEW.voided_at IS NULL AND (NEW.voided_by IS NOT OLD.voided_by OR NEW.void_reason IS NOT OLD.void_reason))
			BEGIN ${refuse} END`);
	})();
}

// ── input ────────────────────────────────────────────────────────────────────
const refusal = (code, field, message) => ({ ok: false, status: 400, code, field, error: message });
// Own keys only, and never null/undefined: a key that is absent, null or
// undefined was not supplied (the parseInvoiceOverrides() rule).
function suppliedIn(src) {
	return (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== null;
}

// A new line, from POST /api/loads/:loadId/invoice-lines. Reads kind, label,
// amount, receivedOn, reference and note, and nothing else (an amountCents, an
// id or a creator in the body is ignored). Returns { ok, values } or
// { ok: false, status: 400, code, field, error }.
function parseNewLine(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return refusal("INVOICE_LINE_BODY_INVALID", "", LINE_MESSAGES.BODY_INVALID);
	const supplied = suppliedIn(body);
	const values = Object.create(null);

	values.kind = "advance";
	if (supplied("kind") && body.kind !== "advance") return refusal("INVOICE_LINE_KIND_INVALID", "kind", LINE_MESSAGES.KIND_INVALID);

	values.label = DEFAULT_ADVANCE_LABEL;
	if (supplied("label")) {
		if (typeof body.label !== "string") return refusal("INVOICE_LINE_LABEL_INVALID", "label", LINE_MESSAGES.LABEL_INVALID);
		const v = cleanLine(body.label, FIELD_SCAN_MAX);
		if (v) {
			if (!LINE_LABEL_RE.test(v)) return refusal("INVOICE_LINE_LABEL_INVALID", "label", LINE_MESSAGES.LABEL_INVALID);
			values.label = v;
		}
	}

	if (!supplied("amount") || (typeof body.amount !== "string" && typeof body.amount !== "number")) {
		return refusal("INVOICE_LINE_AMOUNT_INVALID", "amount", LINE_MESSAGES.AMOUNT_INVALID);
	}
	const cents = toCents(typeof body.amount === "string" ? cleanLine(body.amount, 40) : body.amount);
	if (cents === null) return refusal("INVOICE_LINE_AMOUNT_INVALID", "amount", LINE_MESSAGES.AMOUNT_INVALID);
	if (cents < 1 || cents > LINE_AMOUNT_MAX_CENTS) return refusal("INVOICE_LINE_AMOUNT_OUT_OF_RANGE", "amount", LINE_MESSAGES.AMOUNT_OUT_OF_RANGE);
	values.amountCents = cents;

	values.receivedOn = "";
	if (supplied("receivedOn")) {
		if (typeof body.receivedOn !== "string") return refusal("INVOICE_LINE_DATE_INVALID", "receivedOn", LINE_MESSAGES.DATE_INVALID);
		const v = cleanLine(body.receivedOn, 40);
		if (v) {
			const m = ISO_DAY_RE.exec(v);
			if (!m || !isRealDay(+m[1], +m[2], +m[3])) return refusal("INVOICE_LINE_DATE_INVALID", "receivedOn", LINE_MESSAGES.DATE_INVALID);
			values.receivedOn = v;
		}
	}

	values.reference = "";
	if (supplied("reference")) {
		if (typeof body.reference !== "string") return refusal("INVOICE_LINE_REFERENCE_INVALID", "reference", LINE_MESSAGES.REFERENCE_INVALID);
		const v = cleanLine(body.reference, FIELD_SCAN_MAX);
		if (v && !LINE_REFERENCE_RE.test(v)) return refusal("INVOICE_LINE_REFERENCE_INVALID", "reference", LINE_MESSAGES.REFERENCE_INVALID);
		values.reference = v;
	}

	values.note = "";
	if (supplied("note")) {
		if (typeof body.note !== "string") return refusal("INVOICE_LINE_NOTE_INVALID", "note", LINE_MESSAGES.NOTE_INVALID);
		if (body.note.length > TEXT_SCAN_MAX) return refusal("INVOICE_LINE_NOTE_TOO_LONG", "note", LINE_MESSAGES.NOTE_TOO_LONG);
		const v = cleanText(body.note, TEXT_SCAN_MAX);
		if (Array.from(v).length > LINE_NOTE_MAX) return refusal("INVOICE_LINE_NOTE_TOO_LONG", "note", LINE_MESSAGES.NOTE_TOO_LONG);
		values.note = v;
	}
	return { ok: true, values };
}

// The reason a line is voided: required, one line, 200 at most.
function parseVoid(body) {
	const src = body && typeof body === "object" ? body : {};
	if (!suppliedIn(src)("reason")) return refusal("INVOICE_LINE_VOID_REASON_REQUIRED", "reason", LINE_MESSAGES.VOID_REASON_REQUIRED);
	if (typeof src.reason !== "string") return refusal("INVOICE_LINE_VOID_REASON_INVALID", "reason", LINE_MESSAGES.VOID_REASON_INVALID);
	// Cleaned within twice the limit, so an over-long reason is refused, not cut.
	const v = cleanLine(src.reason, VOID_REASON_MAX * 2);
	if (!v) return refusal("INVOICE_LINE_VOID_REASON_REQUIRED", "reason", LINE_MESSAGES.VOID_REASON_REQUIRED);
	if (Array.from(v).length > VOID_REASON_MAX) return refusal("INVOICE_LINE_VOID_REASON_TOO_LONG", "reason", LINE_MESSAGES.VOID_REASON_TOO_LONG);
	return { ok: true, reason: v };
}

// A line id from the URL: a positive whole number written plainly, or null.
function parseLineId(v) {
	const s = String(v == null ? "" : v);
	if (!/^[1-9]\d{0,14}$/.test(s)) return null;
	const n = Number(s);
	return Number.isSafeInteger(n) ? n : null;
}

// What a draft request (draft-invoice, invoice-preview) says about lines:
// `lineIds` — omitted or null means every active line of the load, [] means
// none, else exactly those (positive whole numbers, at most 20, de-duplicated
// in order) — and `footnote` — omitted or null means the default for the
// printed lines, "" means none, else the typed text. Never an amount.
function parseLineSelection(body) {
	const src = body && typeof body === "object" ? body : {};
	const supplied = suppliedIn(src);
	const has = Object.create(null);
	const values = Object.create(null);
	has.lineIds = false;
	values.lineIds = [];
	has.footnote = false;
	values.footnote = "";
	if (supplied("lineIds")) {
		const ids = src.lineIds;
		const bad = refusal("INVOICE_LINE_IDS_INVALID", "lineIds", LINE_MESSAGES.IDS_INVALID);
		if (!Array.isArray(ids) || ids.length > MAX_ACTIVE_LINES) return bad;
		const seen = new Set();
		for (const id of ids) {
			if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return bad;
			if (!seen.has(id)) { seen.add(id); values.lineIds.push(id); }
		}
		has.lineIds = true;
	}
	if (supplied("footnote")) {
		if (typeof src.footnote !== "string") return refusal("INVOICE_FOOTNOTE_INVALID", "footnote", LINE_MESSAGES.FOOTNOTE_INVALID);
		if (src.footnote.length > TEXT_SCAN_MAX) return refusal("INVOICE_FOOTNOTE_TOO_LONG", "footnote", LINE_MESSAGES.FOOTNOTE_TOO_LONG);
		const v = cleanText(src.footnote, TEXT_SCAN_MAX);
		if (Array.from(v).length > FOOTNOTE_MAX) return refusal("INVOICE_FOOTNOTE_TOO_LONG", "footnote", LINE_MESSAGES.FOOTNOTE_TOO_LONG);
		has.footnote = true;
		values.footnote = v;
	}
	return { ok: true, has, values };
}

// ── reads ────────────────────────────────────────────────────────────────────
function wireLine(r) {
	return {
		id: r.id,
		loadId: r.load_id,
		kind: r.kind,
		label: r.label,
		amountCents: r.amount_cents,
		amount: formatCents(r.amount_cents),
		receivedOn: r.received_on || "",
		reference: r.reference || "",
		note: r.note || "",
		invoiceId: r.invoice_id || "",
		createdBy: r.created_by || "",
		createdAt: r.created_at || "",
		voided: r.voided_at != null,
		voidedAt: r.voided_at || "",
		voidedBy: r.voided_by || "",
		voidReason: r.void_reason || "",
	};
}
function rowsOf(db, loadId, { activeOnly = false } = {}) {
	return db.prepare(`SELECT * FROM ${TABLE} WHERE load_key = ?${activeOnly ? " AND voided_at IS NULL" : ""} ORDER BY id`).all(loadKey(loadId));
}
// This load's lines, oldest first, voided ones included and marked.
function listLines(db, loadId) {
	return rowsOf(db, loadId).map(wireLine);
}

// ── writes (audited after they succeed) ──────────────────────────────────────
function closedMonthsNote(closedMonths) {
	if (closedMonths === null || closedMonths === undefined) return "the load's month could not be told, invoice-only, no settlement change";
	if (closedMonths.length === 1) return `load in closed month ${closedMonths[0]}, invoice-only, no settlement change`;
	if (closedMonths.length > 1) return `load in closed months ${closedMonths.join(", ")}, invoice-only, no settlement change`;
	return "invoice-only, no settlement change";
}
function describeLine(line) {
	return `#${line.id} ${line.kind} ${formatCents(line.amountCents)} "${line.label}"`;
}

// Records one line (values from parseNewLine()) under the load `loadId` (the
// sheet's Load ID as written). `closedMonths` is the closed months the load
// books into ([] none, null when that can't be told); a closed month is noted
// in the audit, never refused. `audit(action, detail, line)` runs once, after the
// insert has succeeded. Returns { ok, line } or { ok: false, status, code, error }.
function addLine(db, { loadId, values, actor, closedMonths }, { audit } = {}) {
	let id;
	try {
		id = db.transaction(() => {
			const active = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE load_key = ? AND voided_at IS NULL`).get(loadKey(loadId)).n;
			if (active >= MAX_ACTIVE_LINES) return null;
			return db.prepare(`INSERT INTO ${TABLE} (load_id, load_key, kind, label, amount_cents, received_on, reference, note, created_by)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(String(loadId).trim(), loadKey(loadId), values.kind, values.label, values.amountCents, values.receivedOn, values.reference, values.note, String(actor || ""))
				.lastInsertRowid;
		})();
	} catch {
		return { ok: false, status: 500, code: "INVOICE_LINE_WRITE_FAILED", error: "The line could not be saved." };
	}
	if (id === null) return { ok: false, status: 409, code: "INVOICE_LINE_LIMIT", error: `This load already has ${MAX_ACTIVE_LINES} active advance lines.` };
	const line = wireLine(db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id));
	if (audit) {
		const when = line.receivedOn ? ` received ${line.receivedOn}` : "";
		const ref = line.reference ? ` ref ${line.reference}` : "";
		audit("invoice_line_added", `${describeLine(line)}${when}${ref} — ${closedMonthsNote(closedMonths)}`, line);
	}
	return { ok: true, line };
}

// Voids one active line of this load, once. `audit(action, detail, line)` runs once,
// after the write. Returns { ok, line } or { ok: false, status, code, error }.
function voidLine(db, { loadId, lineId, reason, actor }, { audit } = {}) {
	const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(lineId);
	if (!row || row.load_key !== loadKey(loadId)) return { ok: false, status: 404, code: "INVOICE_LINE_NOT_FOUND", error: "No such advance line on this load." };
	if (row.voided_at != null) return { ok: false, status: 409, code: "INVOICE_LINE_ALREADY_VOIDED", error: "That line is already voided." };
	const changed = db.prepare(`UPDATE ${TABLE} SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL`)
		.run(String(actor || ""), String(reason || ""), lineId).changes;
	if (changed !== 1) return { ok: false, status: 409, code: "INVOICE_LINE_ALREADY_VOIDED", error: "That line is already voided." };
	const line = wireLine(db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(lineId));
	if (audit) {
		const printed = line.invoiceId ? ` (printed on ${line.invoiceId}; that draft keeps its copy)` : "";
		audit("invoice_line_voided", `${describeLine(line)} voided: ${line.voidReason}${printed}`, line);
	}
	return { ok: true, line };
}

// ── the balance ──────────────────────────────────────────────────────────────
function defaultFootnote(items) {
	return items.map((i) => `*${footnoteAmount(i.amountCents)} for ${labelInSentence(i.label)}`).join("\n");
}

// Which lines a draft prints, and the figures. `selection` is
// parseLineSelection()'s answer. The line haul is the route's own base: on the
// approve, the rate con's Total Rate, else Job Tracking's Payment
// (`derivedLineHaul`, dollars; 0 when neither has one), and `typedTotal` is the
// Total the request carried (null when none); on the preview, which reads no
// sheet, the Total the editor sends is the base and typedTotal is null.
//
// Answers { ok: true, summary: null, selectedIds: [] } when nothing prints (no
// active line, or lineIds []), so the invoice is exactly today's; else
// { ok: true, summary, selectedIds } or a 422 { ok: false, status, code, error,
// selectedIds, lineId? }:
//   INVOICE_LINE_INVALID       a named line is voided, another load's, or unknown
//   INVOICE_LINE_HAUL_CONFLICT a typed total that is not the line haul (it would
//                              take the advance off twice), or no line haul
//   INVOICE_BALANCE_INVALID    the advances are not less than the line haul
function resolveInvoiceLines(db, { loadId, selection, derivedLineHaul, lineHaulSource, typedTotal }) {
	const active = rowsOf(db, loadId, { activeOnly: true });
	const sel = selection && selection.ok ? selection : parseLineSelection({});
	const selectedIds = sel.has.lineIds ? sel.values.lineIds.slice() : active.map((r) => r.id);
	const fail = (code, error, extra = {}) => ({ ok: false, status: 422, code, error, selectedIds, ...extra });
	const byId = new Map(active.map((r) => [r.id, r]));
	const picked = [];
	for (const id of selectedIds) {
		const r = byId.get(id);
		if (!r) {
			return fail("INVOICE_LINE_INVALID", `Advance line #${id} can't be printed: it was voided or belongs to another load. Close the editor and open it again.`, { lineId: id });
		}
		picked.push(r);
	}
	if (!picked.length) return { ok: true, summary: null, selectedIds };

	const lineHaulCents = dollarsToCents(derivedLineHaul);
	if (!(lineHaulCents > 0)) {
		return fail("INVOICE_LINE_HAUL_CONFLICT",
			"This load has no line haul from the rate con or Job Tracking's Payment, and a typed total can't carry advance lines. Add the rate to the load, or remove the advance lines.");
	}
	if (typedTotal !== null && typedTotal !== undefined && dollarsToCents(typedTotal) !== lineHaulCents) {
		const lh = formatCents(lineHaulCents);
		return fail("INVOICE_LINE_HAUL_CONFLICT",
			`With advance lines on the invoice, the line haul comes from the rate con or Job Tracking's Payment (${lh}). Put the total back to ${lh}, or remove the advance lines.`);
	}
	const items = picked.map((r) => ({ id: r.id, kind: r.kind, label: r.label, amountCents: r.amount_cents, receivedOn: r.received_on || "", reference: r.reference || "" }));
	let advancesCents = 0;
	for (const i of items) advancesCents += i.amountCents;
	const balanceCents = lineHaulCents - advancesCents;
	if (balanceCents < 1) {
		return fail("INVOICE_BALANCE_INVALID",
			`The advances (${formatCents(advancesCents)}) must be less than the line haul (${formatCents(lineHaulCents)}): the balance due has to stay above $0.00.`);
	}
	const footnoteDefault = defaultFootnote(items);
	return {
		ok: true,
		selectedIds,
		summary: {
			lineHaulCents, advancesCents, balanceCents, lineHaulSource: String(lineHaulSource || ""),
			items, footnote: sel.has.footnote ? sel.values.footnote : footnoteDefault, footnoteDefault,
		},
	};
}

// The cover email's sentence for a summary.
function emailBalanceLine(summary) {
	const balance = formatCents(summary.balanceCents);
	if (summary.items.length === 1) {
		return `Balance due ${balance} after the ${formatCents(summary.items[0].amountCents)} ${labelInSentence(summary.items[0].label)}.`;
	}
	return `Balance due ${balance} after ${formatCents(summary.advancesCents)} in advances.`;
}

// ── the receipt cross-check ──────────────────────────────────────────────────
// A receipt on the load (any status but Rejected, the figures' own filter) with
// an active line's exact amount: probably the advance filed as a receipt, which
// then counts as a trip cost while revenue stays at the line haul. A warning in
// the editor only; nothing is blocked or changed.
function sameAmountReceipts(db, loadId) {
	const lines = rowsOf(db, loadId, { activeOnly: true });
	if (!lines.length) return [];
	let receipts;
	try {
		const key = loadKey(loadId);
		receipts = db.prepare(`SELECT id, type, amount, status FROM expenses
			WHERE LOWER(TRIM(load_id)) IN (?, ?) AND COALESCE(status,'') != 'Rejected' ORDER BY id`).all(key, `#${key}`);
	} catch {
		return [];
	}
	const out = [];
	for (const line of lines) {
		for (const e of receipts) {
			if (Math.round(Number(e.amount) * 100) === line.amount_cents) {
				out.push({ lineId: line.id, expenseId: e.id, type: e.type, amount: formatCents(line.amount_cents), status: e.status || "" });
			}
		}
	}
	return out;
}

// ── the draft record and the answers ─────────────────────────────────────────
// After an approved draft's row is written (the route runs both in one
// transaction): the printed lines and the line haul on that row (its `total` is
// already the balance due), and each line stamped with the first invoice # that
// printed it. A line voided after the draft resolved its lines (while the PDF
// rendered and the Gmail draft was written) was printed but is not stamped; its
// id is returned in `voidedIds` for the route to report. The copy in lines_json
// stays what was printed.
function recordDraftLines(db, { draftId, summary, invoiceId }) {
	return db.transaction(() => {
		const linesJson = JSON.stringify({
			lineHaulCents: summary.lineHaulCents, advancesCents: summary.advancesCents, balanceCents: summary.balanceCents,
			lineHaulSource: summary.lineHaulSource, footnote: summary.footnote, lines: summary.items,
		});
		db.prepare("UPDATE load_invoice_drafts SET lines_json = ?, gross_total = ? WHERE id = ?").run(linesJson, formatCents(summary.lineHaulCents), draftId);
		const stamp = db.prepare(`UPDATE ${TABLE} SET invoice_id = ? WHERE id = ? AND invoice_id = '' AND voided_at IS NULL`);
		const voided = db.prepare(`SELECT 1 FROM ${TABLE} WHERE id = ? AND voided_at IS NOT NULL`);
		let marked = 0;
		const voidedIds = [];
		for (const i of summary.items) {
			marked += stamp.run(String(invoiceId || ""), i.id).changes;
			if (voided.get(i.id)) voidedIds.push(i.id);
		}
		return { marked, voidedIds };
	})();
}

// The invoice_draft_edited audit text for the lines: the figures FIRST, then
// the lines, then an edited footnote. The route caps the whole audit line at
// 1000 characters and the cap trims the end, so it may shorten the list of
// lines, never the balance due.
function auditDraftDetail(summary) {
	const list = summary.items.map((i) => `#${i.id} ${i.label} ${formatCents(i.amountCents)}`).join(", ");
	const foot = summary.footnote !== summary.footnoteDefault ? `; footnote: "${summary.footnote}"` : "";
	return `lines: line haul ${formatCents(summary.lineHaulCents)}, less advances ${formatCents(summary.advancesCents)}, ` +
		`balance due ${formatCents(summary.balanceCents)} (INVOICE ONLY — Job Tracking Payment unchanged); items: ${list}${foot}`;
}

// What the optional n8n fallback is sent beside the PDF: the reviewed lines and
// figures, as printed. Each amount is the advance as a plain figure (its kind
// says it is deducted), so no value starts with = + - or @ should the workflow
// ever write one to a sheet. No footnote: the workflow never read one, and the
// PDF it attaches already prints it.
function n8nFields(summary) {
	return {
		lines: summary.items.map((i) => ({ kind: i.kind, label: i.label, amount: formatCents(i.amountCents), receivedOn: i.receivedOn, reference: i.reference })),
		lineHaul: formatCents(summary.lineHaulCents),
		balanceDue: formatCents(summary.balanceCents),
	};
}

// The figures the editor shows, formatted here: it never computes one.
function summaryWire(summary) {
	if (!summary) return null;
	return {
		lineHaul: formatCents(summary.lineHaulCents),
		advances: formatCents(-summary.advancesCents),
		balanceDue: formatCents(summary.balanceCents),
		lineHaulCents: summary.lineHaulCents,
		advancesCents: summary.advancesCents,
		balanceCents: summary.balanceCents,
		lineHaulSource: summary.lineHaulSource,
		lines: summary.items.map((i) => ({
			id: i.id, kind: i.kind, label: i.label, amountCents: i.amountCents, amount: formatCents(-i.amountCents), receivedOn: i.receivedOn, reference: i.reference,
		})),
		footnote: summary.footnote,
		footnoteDefault: summary.footnoteDefault,
	};
}
// The draft-invoice ?dryRun=1 answer's `invoiceLines`: the load's lines, what
// is selected, the figures or the refusal (the editor still opens on one), and
// the same-amount receipt warnings.
function dryRunEcho(db, { loadId, resolved }) {
	const r = resolved || { ok: true, summary: null, selectedIds: [] };
	return {
		enabled: true,
		available: listLines(db, loadId),
		selectedIds: (r.selectedIds || []).slice(),
		summary: r.ok ? summaryWire(r.summary) : null,
		error: r.ok ? null : { code: r.code, message: r.error, ...(r.lineId ? { lineId: r.lineId } : {}) },
		receiptWarnings: sameAmountReceipts(db, loadId),
	};
}
// The invoice-preview answer's `invoiceLines`.
function previewEcho(summary) {
	return { summary: summaryWire(summary) };
}

module.exports = {
	FLAG,
	TABLE,
	LINE_KINDS,
	DEFAULT_ADVANCE_LABEL,
	LINE_LABEL_MAX,
	LINE_REFERENCE_MAX,
	LINE_NOTE_MAX,
	FOOTNOTE_MAX,
	VOID_REASON_MAX,
	LINE_AMOUNT_MAX_CENTS,
	MAX_ACTIVE_LINES,
	LINE_AMOUNT_RE,
	LINE_LABEL_RE,
	LINE_REFERENCE_RE,
	LINE_MESSAGES,
	linesEnabled,
	cleanLine,
	cleanText,
	toCents,
	formatCents,
	labelInSentence,
	isoToMdy,
	loadKey,
	ensureSchema,
	parseNewLine,
	parseVoid,
	parseLineId,
	parseLineSelection,
	listLines,
	addLine,
	voidLine,
	resolveInvoiceLines,
	emailBalanceLine,
	sameAmountReceipts,
	recordDraftLines,
	auditDraftDetail,
	n8nFields,
	summaryWire,
	dryRunEcho,
	previewEcho,
};
