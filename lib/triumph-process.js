// Process with Triumph (TRIUMPH_PROCESS_BUTTON_ENABLED): one press on a delivered C.H. Robinson
// load whose automatic invoice already went to the broker hands that same invoice to Triumph:
// its number, date, lines and total, with no second number and no second draft row. The
// Triumph job (lib/triumph-job.js) then builds and sends it.
//
// processWithTriumph() runs every check and the writes in one immediate transaction, so a refusal
// writes nothing and nothing can land between a check and the mark:
//   1. delivered;
//   2. a C.H. Robinson load (lib/ratecon-dvir-keep.js isChrLoad(), lib/chr-events.js chrLoadTest());
//   3. nothing of Triumph's on it yet: no claim in any state, no mark;
//   4. an open month: a closed one, or one that can't be told, refuses;
//   5. no advance, and no doubt about one: an active advance line, any row the rate con's
//      advance reader recorded (whatever its verdict; it records only an advance or a rate con
//      it couldn't settle), or anything there that can't be read refuses;
//   6. no re-issue for less: any DVIR decision row refuses;
//   7. no payment date on the Payments Table (the saved flag alone);
//   8. the automatic invoice went to the broker no more than MAX_AGE_DAYS ago;
//   9. its records agree: the claim sent and recorded, its number not voided and nothing
//      changed since, one draft row (the claim's own, via auto-smtp, with that number) and the
//      sent total equal to that row's; no Draft Invoice press in flight.
// Then the mark (source person, the fixed reason, the broker's invoice number and date on it),
// the claim (armClaim(), by "button", carrying the invoice), and two audit rows.
// `dryRun` runs the same checks in a deferred transaction that answers before any write, so a
// read-only handle can run it (the switch-on report and the practice run).
//
// The rest of the button lives in lib/factoring-routes.js (who may press, the switch, the
// sheet's row) and lib/triumph-job.js (the job's second look at the rate con, and the invoice).

"use strict";

const factoring = require("./factoring-store");
const ledger = require("./triumph-ledger");
const autoRules = require("./auto-invoice-rules");
const autoLedger = require("./auto-invoice-ledger");
const invoiceEvidence = require("./invoice-evidence");
const rateconAdvanceRead = require("./ratecon-advance-read");
const rateconDvirKeep = require("./ratecon-dvir-keep");
const { invoiceLines } = require("./broker-invoice");

const DAY_MS = 24 * 60 * 60 * 1000;
// The oldest automatic invoice the button takes (decision P11): Triumph would advance on an
// invoice C.H. Robinson may already have paid without the Payments Table saying so.
const MAX_AGE_DAYS = 30;
const REASON = "Process with Triumph";
// server.js rateConDvirDecisionsTable(): made on first use, so a missing table is no rows.
const DVIR_TABLE = "ratecon_dvir_decisions";

const WORDS = Object.freeze({
	FEATURE_OFF: "Process with Triumph is off.",
	NOT_DELIVERED: "This load isn't delivered yet.",
	NOT_CHR: "Only C.H. Robinson loads can go to Triumph from this button for now. Invoice this one the usual way.",
	TRIUMPH_ALREADY: "This load is already with Triumph.",
	MONTH_CLOSED: "This load's month is closed, so it can't go to Triumph.",
	ADVANCE_ON_RATECON: "This load's rate con shows an advance, or the app couldn't rule one out: it stays with its invoice to the broker.",
	DVIR_LINES: "This load's rate con was re-issued for less: it stays with its invoice to the broker.",
	PAID_ALREADY: "The Payments Table shows a payment date for this load, so it can't go to Triumph.",
	INVOICE_TOO_OLD: `This load's invoice went to the broker more than ${MAX_AGE_DAYS} days ago, so it can't go to Triumph from the app.`,
	NO_AUTO_INVOICE: "This load's automatic invoice hasn't gone to the broker, so the button can't take it. Invoice it the usual way.",
	AUTO_INVOICE_IN_FLIGHT: factoring.WORDS.AUTO_INVOICE_IN_FLIGHT,
	AUTO_INVOICE_NEEDS_PERSON: "This load's automatic invoice needs a person's look first.",
	INVOICE_MAYBE_IN_GMAIL: "This load's invoice draft may be in Gmail, or may already have been sent from there, so the button can't take it. Invoice it the usual way.",
	INVOICE_ALREADY_DRAFTED: "This load's invoice was drafted in Gmail, not sent by the app, so the button can't take it. Invoice it the usual way.",
	HAND_DRAFTED: "An invoice for this load was drafted by hand, so it can't go to Triumph from the app.",
	INVOICE_RECORD_MISMATCH: "This load's invoice records don't agree, or the load changed since its invoice went, so a person checks it first.",
	INVOICE_DRAFT_IN_FLIGHT: factoring.WORDS.INVOICE_DRAFT_IN_FLIGHT,
	INVOICE_MAYBE_DRAFTED: "An invoice draft for this load may be in Gmail. Use 'Check Gmail' on the load first.",
	SUBMIT_PAUSED: "Sending to Triumph is paused right now, so nothing was marked. Try again once it resumes.",
	TRANSPORT_UNCONFIGURED: "The app's connection to Triumph isn't set up, so nothing was marked.",
	FACTORING_LOCKED: factoring.WORDS.FACTORING_LOCKED,
	FACTORING_UNREADABLE: factoring.WORDS.FACTORING_UNREADABLE,
	RECORDS_UNREADABLE: "This load's records couldn't be read, so nothing was marked. Try again in a minute.",
	NOT_RETRYABLE: "Try again can't change why this load stopped.",
	NOT_FACTORED: "This load's mark was cleared, so Try again can't send it: its invoice to the broker stands.",
});
const HTTP = Object.freeze({ FEATURE_OFF: 404, SUBMIT_PAUSED: 503, TRANSPORT_UNCONFIGURED: 503, FACTORING_UNREADABLE: 503, RECORDS_UNREADABLE: 503 });
// Try again's words for the same two stops: it marks nothing either way.
const RETRY_BLOCKED_WORDS = Object.freeze({
	SUBMIT_PAUSED: "Sending to Triumph is paused right now, so nothing was changed. Try again once it resumes.",
	TRANSPORT_UNCONFIGURED: "The app's connection to Triumph isn't set up, so nothing was changed.",
});

function refusal(code) {
	return { ok: false, http: HTTP[code] || 409, code, error: WORDS[code] || code };
}

// TRIUMPH_ALREADY's words, true for where the load stands: a second press must never read as "not
// sent" while the load is on its way, nor as "with Triumph" once it stopped or its mark was cleared.
const ALREADY_WORDS = Object.freeze({
	onItsWay: "This load is already on its way to Triumph.",
	there: WORDS.TRIUMPH_ALREADY,
	marked: "This load is already marked factored: its invoice goes through Triumph.",
	stopped: "This load was already taken for Triumph once and didn't go: its invoice to the broker stands. Its Triumph line says why.",
});
const STOPPED_STATES = new Set(["waiting", "needs_attention", "skipped"]);
function alreadyWords(claim, marker) {
	if (!claim) return ALREADY_WORDS.marked;
	const factored = Boolean(marker) && Number(marker.factored) !== 0;
	if (!factored || STOPPED_STATES.has(claim.state)) return ALREADY_WORDS.stopped;
	if (claim.state === "queued" || claim.state === "working") return ALREADY_WORDS.onItsWay;
	return ALREADY_WORDS.there;
}

// ── the schema (only while the switch is on) ────────────────────────────────

function addColumn(db, table, column, type = "TEXT NOT NULL DEFAULT ''") {
	if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// The marker's copy of the broker's invoice number and date, and a claim's: where its number
// came from, the broker's draft row and the total that went. Additive; server.js calls it only
// with the switch on, so a deploy with it off changes no table.
function ensureSchema(db) {
	ledger.ensureSchema(db);
	addColumn(db, factoring.FACTORING, "broker_invoice_id");
	addColumn(db, factoring.FACTORING, "broker_invoice_date");
	addColumn(db, ledger.CLAIMS, "number_source");
	addColumn(db, ledger.CLAIMS, "reused_draft_id", "INTEGER");
	addColumn(db, ledger.CLAIMS, "expected_total");
}

// ── what the press reads ─────────────────────────────────────────────────────

// The key the rate con's readers record a load by (lib/ratecon-advance-read.js run(), server.js
// recordRateConDvirDecision()).
const recordKey = (key) => invoiceLines.loadKey(key).slice(0, 80);

// An advance, or any doubt about one: an active advance line, any recorded advance read, or
// anything here that can't be read.
function advanceDoubt(db, key) {
	try {
		const lines = rateconAdvanceRead.linesState(db, autoRules.loadKey(key));
		if (!lines || lines.activeCount > 0) return true;
		if (!factoring.hasTable(db, rateconAdvanceRead.TABLE)) return false;
		return Boolean(db.prepare(`SELECT 1 FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));
	} catch {
		return true;
	}
}

// Any DVIR decision recorded for the load (each one a lower Payment on a re-issue), or a record
// that can't be read.
function dvirDoubt(db, key) {
	try {
		if (!factoring.hasTable(db, DVIR_TABLE)) return false;
		return Boolean(db.prepare(`SELECT 1 FROM ${DVIR_TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));
	} catch {
		return true;
	}
}

// The saved Payments Table flag for a payment date, never the status column (lib/invoice-evidence.js
// savedRow(): savedInvoice() answers false once the automatic claim is past "rendered").
function paidFlag(db, key) {
	const saved = invoiceEvidence.savedRow(db, autoRules.loadKey(key));
	return Boolean(saved) && Number(saved.payments_payment_date) > 0;
}

// The automatic invoice's age and the payment date, read again by the job right before its lock
// point: a code that stops the claim, or "". A sent time that can't be read is past the limit;
// a database that can't be read throws, and the job's run puts the claim back in line.
function lateStop(db, key, { nowIso, maxAgeDays = MAX_AGE_DAYS } = {}) {
	const claim = factoring.hasTable(db, autoLedger.CLAIMS) ? autoLedger.getClaim(db, autoRules.loadKey(key)) : null;
	const sentMs = Date.parse((claim && claim.sent_at) || "");
	if (!Number.isFinite(sentMs) || Date.parse(nowIso) - sentMs > maxAgeDays * DAY_MS) return "INVOICE_TOO_OLD";
	return paidFlag(db, key) ? "PAID_ALREADY" : "";
}

function draftRows(db, key) {
	if (!factoring.hasTable(db, "load_invoice_drafts")) return [];
	return db.prepare("SELECT id, load_id, invoice_id, via, total, order_number FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(key, `#${key}`);
}

// Steps 8 and 9: the invoice the automatic job sent, as one the button may take, or a refusal.
function brokerInvoice(db, key, { nowIso, maxAgeDays }) {
	let claim;
	let rows;
	let flights;
	try {
		claim = factoring.hasTable(db, autoLedger.CLAIMS) ? autoLedger.getClaim(db, key) : null;
		rows = draftRows(db, key);
		flights = factoring.inflightRows(db, key, nowIso);
	} catch {
		return refusal("RECORDS_UNREADABLE");
	}
	if (!claim) return refusal("NO_AUTO_INVOICE");
	const sending = claim.delivery === "send";
	if (claim.state === "needs_attention" && (claim.reason_code === "MAYBE_SENT" || claim.reason_code === "IN_GMAIL_UNRECORDED" || (sending && claim.stage === "appending"))) {
		return refusal("AUTO_INVOICE_NEEDS_PERSON");
	}
	if (claim.state === "working" || (sending && (claim.stage === "appending" || claim.stage === "appended"))) return refusal("AUTO_INVOICE_IN_FLIGHT");
	if (!sending) {
		if (claim.stage === "appending" || claim.stage === "appended") return refusal("INVOICE_MAYBE_IN_GMAIL");
		return refusal(claim.state === "drafted" ? "INVOICE_ALREADY_DRAFTED" : "NO_AUTO_INVOICE");
	}
	if (claim.state !== "drafted" || claim.stage !== "recorded") return refusal("NO_AUTO_INVOICE");
	const sentMs = Date.parse(claim.sent_at || "");
	if (!Number.isFinite(sentMs)) return refusal("INVOICE_RECORD_MISMATCH");
	if (Date.parse(nowIso) - sentMs > maxAgeDays * DAY_MS) return refusal("INVOICE_TOO_OLD");
	if (!claim.invoice_id || claim.number_voided_at || !claim.invoice_date || claim.changed_fields) return refusal("INVOICE_RECORD_MISMATCH");
	if (rows.length > 1 || rows.some((r) => r.via !== autoRules.VIA_SEND)) return refusal("HAND_DRAFTED");
	const row = rows[0];
	if (!row || Number(row.id) !== Number(claim.draft_row_id) || String(row.invoice_id || "") !== String(claim.invoice_id)) return refusal("INVOICE_RECORD_MISMATCH");
	let sent = null;
	try {
		sent = JSON.parse(claim.sent_json || "");
	} catch {
		sent = null;
	}
	const total = sent && typeof sent.total === "string" ? sent.total : "";
	if (!total || String(row.total ?? "") !== total) return refusal("INVOICE_RECORD_MISMATCH");
	if (flights.some((f) => f.effective === "maybe_drafted")) return refusal("INVOICE_MAYBE_DRAFTED");
	if (flights.length) return refusal("INVOICE_DRAFT_IN_FLIGHT");
	return { ok: true, reuse: { invoiceId: String(claim.invoice_id), invoiceDate: String(claim.invoice_date), draftRowId: Number(row.id), total } };
}

// Every check, in order, against what the database says now: { ok: true, reuse } or a refusal.
function checks(db, { key, row, headers, closedMonths, nowIso, maxAgeDays }) {
	let pause;
	try {
		pause = ledger.getPause(db, nowIso);
	} catch {
		return refusal("RECORDS_UNREADABLE");
	}
	if (pause) return refusal("SUBMIT_PAUSED");
	const cols = autoRules.jobColumns(headers);
	const status = row && cols.statusCol ? String(row[cols.statusCol] ?? "").trim() : "";
	if (!autoRules.isCompletedStatus(status)) return refusal("NOT_DELIVERED");
	if (!rateconDvirKeep.isChrLoad(row, headers)) return refusal("NOT_CHR");
	let marker;
	let claim;
	try {
		marker = factoring.markerFor(db, key);
		claim = factoring.triumphClaim(db, key);
	} catch {
		return refusal("FACTORING_UNREADABLE");
	}
	if (marker && marker.locked_at) return refusal("FACTORING_LOCKED");
	if (claim || (marker && Number(marker.factored) !== 0)) return { ...refusal("TRIUMPH_ALREADY"), error: alreadyWords(claim, marker) };
	if (!Array.isArray(closedMonths) || closedMonths.length) return refusal("MONTH_CLOSED");
	if (advanceDoubt(db, key)) return refusal("ADVANCE_ON_RATECON");
	if (dvirDoubt(db, key)) return refusal("DVIR_LINES");
	try {
		if (paidFlag(db, key)) return refusal("PAID_ALREADY");
	} catch {
		return refusal("RECORDS_UNREADABLE");
	}
	return brokerInvoice(db, key, { nowIso, maxAgeDays });
}

// ── the press ────────────────────────────────────────────────────────────────

// `row` and `headers`: the load's Job Tracking row as the route read it; `closedMonths`:
// integrityClosedMonthsOf() on it (null when it can't be told); `actor` { id, username };
// `audit(action, details)` writes inside this transaction. { ok: true, reuse } (with
// `wouldWrite` on a dry run) or a refusal { ok: false, http, code, error }.
function processWithTriumph(db, { key, loadId = "", row = null, headers = [], closedMonths = null, nowIso, actor = {}, audit = () => {}, dryRun = false, maxAgeDays = MAX_AGE_DAYS } = {}) {
	const k = autoRules.loadKey(key || loadId);
	if (!k) return refusal("NOT_DELIVERED");
	const id = String(loadId || k);
	const work = () => {
		const checked = checks(db, { key: k, row, headers, closedMonths, nowIso, maxAgeDays });
		if (!checked.ok) return checked;
		const { reuse } = checked;
		if (dryRun) return { ok: true, reuse, wouldWrite: ["the factoring mark", "a Triumph claim carrying the broker's invoice", "audit: factoring_marked", "audit: triumph_started"] };
		db.prepare(`INSERT INTO ${factoring.FACTORING} (load_key, load_id, factored, source, reason, set_at, set_by, set_by_id, updated_at, broker_invoice_id, broker_invoice_date)
			VALUES (?, ?, 1, 'person', ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(load_key) DO UPDATE SET load_id = excluded.load_id, factored = 1, source = 'person', reason = excluded.reason, set_at = excluded.set_at,
				set_by = excluded.set_by, set_by_id = excluded.set_by_id, updated_at = excluded.updated_at,
				broker_invoice_id = excluded.broker_invoice_id, broker_invoice_date = excluded.broker_invoice_date`)
			.run(k, id, REASON, nowIso, String(actor.username || ""), Number(actor.id) || 0, nowIso, reuse.invoiceId, reuse.invoiceDate);
		const armed = ledger.armClaim(db, { key: k, loadId: id, by: "button", nowIso, reuse });
		// armClaim() answers a refusal as a value: thrown here, the mark above rolls back with it.
		if (!armed.ok) throw Object.assign(new Error(`the claim wasn't armed: ${armed.code}`), { armRefused: armed.code });
		audit("factoring_marked", `factored (person): ${REASON}; invoice ${reuse.invoiceId} of ${reuse.invoiceDate}, the one the app sent the broker`);
		audit("triumph_started", `${REASON}: invoice ${reuse.invoiceId} of ${reuse.invoiceDate}, the one the app sent the broker`);
		return { ok: true, reuse };
	};
	try {
		return dryRun ? db.transaction(work).deferred() : db.transaction(work).immediate();
	} catch (e) {
		if (e && e.armRefused) return refusal(e.armRefused === "FACTORING_UNREADABLE" ? "FACTORING_UNREADABLE" : "TRIUMPH_ALREADY");
		return refusal("RECORDS_UNREADABLE");
	}
}

// ── the dashboard ────────────────────────────────────────────────────────────

// The loads whose automatic invoice went to the broker within the age limit: the only ones the
// press could take, so a long list of completed loads costs one read and a few dry runs.
function recentSends(db, { nowIso, maxAgeDays = MAX_AGE_DAYS }) {
	if (!factoring.hasTable(db, autoLedger.CLAIMS)) return new Set();
	const since = new Date(Date.parse(nowIso) - maxAgeDays * DAY_MS).toISOString();
	return new Set(db.prepare(`SELECT load_key FROM ${autoLedger.CLAIMS} WHERE delivery = 'send' AND stage = 'recorded' AND sent_at >= ?`).all(since).map((r) => r.load_key));
}

// `_factoring.canProcess` on each completed row the press would take now, by its own checks in a
// dry run. Rows already annotated (lib/factoring-store.js annotateRows() with the switch on).
function markPressable(db, { rows, headers, idCol, closedMonthsOf, nowIso, maxAgeDays = MAX_AGE_DAYS }) {
	let recent;
	try {
		recent = recentSends(db, { nowIso, maxAgeDays });
	} catch {
		return;
	}
	for (const row of rows || []) {
		const f = row && row._factoring;
		if (!f || f.triumphState || f.factored || f.locked) continue;
		const key = autoRules.loadKey(row[idCol]);
		if (!recent.has(key)) continue;
		let closedMonths = null;
		try {
			closedMonths = closedMonthsOf(headers, row);
		} catch {
			closedMonths = null;
		}
		f.canProcess = processWithTriumph(db, { key, loadId: row[idCol], row, headers, closedMonths, nowIso, dryRun: true, maxAgeDays }).ok === true;
	}
}

module.exports = {
	MAX_AGE_DAYS,
	REASON,
	DVIR_TABLE,
	WORDS,
	RETRY_BLOCKED_WORDS,
	refusal,
	ensureSchema,
	recordKey,
	advanceDoubt,
	dvirDoubt,
	lateStop,
	processWithTriumph,
	recentSends,
	markPressable,
};
