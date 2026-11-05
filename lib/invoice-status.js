// One invoice status on every completed load: the rule. The server works the status
// out from the app's own rows and what the mailbox search saved (lib/invoice-evidence.js);
// the browser only words it. The labels here are the CSV's.
//
// INVOICE_STATUS_ENABLED is a kill switch, on unless it says off. It needs no mailbox:
// without one, a load the app holds no record of reads "Couldn't check", NOT_SEARCHED.
//
// "No invoice found" and "in neither Gmail mailbox" are negatives no row of the app can
// prove, so only an answered search with the mailbox pass on may say them (passOn). What
// was found stays found with the pass off: a positive doesn't go stale the same way.
//
// A status never sends anything: Try again and the button search live.
//
// Pure: no network, database or files.

"use strict";

const rules = require("./auto-invoice-rules");
const { claimSent } = require("./auto-invoice-send");

const STATUS = Object.freeze({
	SENT: "sent",
	BY_HAND: "by_hand",
	DRAFT: "draft",
	WAITING: "waiting",
	ATTENTION: "needs_attention",
	FACTORED: "factored",
	NONE_FOUND: "none_found",
	UNKNOWN: "unknown",
});

const STATUS_LABELS = Object.freeze({
	[STATUS.SENT]: "Sent by LogisX",
	[STATUS.BY_HAND]: "Invoiced by hand",
	[STATUS.DRAFT]: "Draft in Gmail",
	[STATUS.WAITING]: "Waiting",
	[STATUS.ATTENTION]: "Needs attention",
	[STATUS.FACTORED]: "Factored (Triumph)",
	[STATUS.NONE_FOUND]: "No invoice found",
	[STATUS.UNKNOWN]: "Couldn't check",
});

// The codes this rule adds to the claims' own (rules.REASON_CODES).
const STATUS_CODES = Object.freeze([
	"DRAFT_NOT_IN_GMAIL", "MENTIONED", "BISON_ORDER_NUMBER", "NOT_SEARCHED", "SEARCH_FAILED",
	"PAYMENTS_NOT_READ", "FACTORING_UNREADABLE", "EVIDENCE_UNREADABLE", "INVOICE_MAYBE_DRAFTED",
]);

// Where an "Invoiced by hand" was seen.
const FOUND = Object.freeze({ SENT_MAIL: "sent_mail", PAYMENTS: "payments_table", DRAFT_ROW: "draft_row" });

const TRIUMPH_VIA = "triumph";

function statusEnabled(env = {}) {
	return !/^(false|0|no|off)$/i.test(String(env?.INVOICE_STATUS_ENABLED ?? "").trim());
}

const viaOf = (row) => String(row?.via ?? "");
const newest = (rows) => rows[rows.length - 1] || {};

// Only the fields a client may show, each only when it holds something.
function answer(status, fields = {}) {
	const out = { status };
	for (const [name, value] of Object.entries(fields)) {
		if (value !== "" && value != null && value !== false && !(Array.isArray(value) && !value.length)) out[name] = value;
	}
	return out;
}

function readSaved(saved, passOn) {
	const s = saved || {};
	const answered = s.result === "answered";
	return {
		sentInvoice: Number(s.sent_invoice) > 0,
		draftsInvoice: Number(s.drafts_invoice) > 0,
		mention: Number(s.sent_mention) > 0 || Number(s.drafts_mention) > 0,
		answered,
		failed: s.result === "failed",
		// May a clean answer be read as "nothing there"?
		negativeHolds: answered && passOn === true,
		searchedAt: String(s.searched_at || ""),
		firstSentAt: String(s.first_sent_at || ""),
		paymentsFilled: Number(s.payments_invoice_number) > 0 || Number(s.payments_payment_date) > 0 || Number(s.payments_status) > 0,
		paymentsChecked: Boolean(s.payments_checked_at),
	};
}

// A closed month's problems aren't raised, and a month that can't be told counts as one.
function isClosed(closedMonth) {
	try {
		return typeof closedMonth !== "function" || closedMonth() !== false;
	} catch {
		return true;
	}
}

// e: {
//   claim        the load's auto_invoice_claims row, or null
//   rows         its load_invoice_drafts rows, oldest first
//   presses      its invoice_draft_inflight rows, each with `effective` (factoring.inflightRows())
//   factored     true or false, or null when the marker can't be read
//   triumphDone  a Triumph submission went, or was closed outside the app
//   saved        its invoice_status_evidence row, or null
//   isBison      its Email cell is Bison's
//   closedMonth  () => false when its month is open, read only if it changes the answer
//   sweepOn      the job's 5-minute sweep is running, so a `waiting` claim can still move
//   passOn       the mailbox pass is on
//   dayOf        (iso) => that instant's day in the app's zone
// }
// Answers { status, code?, invoiceId?, date?, found?, whose?, changed?, searchedAt?,
// sentUnchecked?, mentioned? }. First match wins.
function statusOf(e = {}) {
	const c = e.claim || null;
	const rows = Array.isArray(e.rows) ? e.rows : [];
	const presses = Array.isArray(e.presses) ? e.presses : [];
	const dayOf = typeof e.dayOf === "function" ? e.dayOf : () => "";
	const seen = readSaved(e.saved, e.passOn);
	const sentDate = () => (seen.firstSentAt ? dayOf(seen.firstSentAt) : "");
	const bySentMail = (invoiceId = "") => answer(STATUS.BY_HAND, { invoiceId, date: sentDate(), found: FOUND.SENT_MAIL });
	const byPayments = (invoiceId = "") => answer(STATUS.BY_HAND, { invoiceId, found: FOUND.PAYMENTS });

	// 1 and 2: the marker is read before anything is believed about the load.
	if (e.factored === null) return answer(STATUS.UNKNOWN, { code: "FACTORING_UNREADABLE" });
	if (e.factored === true || e.triumphDone === true || rows.some((r) => viaOf(r) === TRIUMPH_VIA)) return answer(STATUS.FACTORED);

	// 3: the job sent it.
	if (c && c.state === "drafted" && c.delivery === "send" && (c.stage === "appended" || c.stage === "recorded")) {
		return answer(STATUS.SENT, {
			invoiceId: c.invoice_id,
			date: c.invoice_date || (c.sent_at ? dayOf(c.sent_at) : ""),
			changed: c.changed_fields ? String(c.changed_fields).split(",") : [],
		});
	}

	// 4: a send with no answer. A skipped claim is one a person closed: its row decides.
	if (c && c.delivery === "send" && c.stage === "appending") {
		if (c.state === "queued" || c.state === "working") return answer(STATUS.WAITING, { code: "SEND_UNCONFIRMED" });
		if (c.state === "needs_attention") return answer(STATUS.ATTENTION, { code: "MAYBE_SENT" });
	}

	// 5 and 6: something may be in Gmail, or is on its way there.
	if (c && c.state === "needs_attention" && (c.reason_code === "MAYBE_IN_GMAIL" || c.reason_code === "IN_GMAIL_UNRECORDED")) {
		return answer(STATUS.ATTENTION, { code: c.reason_code });
	}
	if (presses.some((p) => p.effective === "maybe_drafted")) return answer(STATUS.ATTENTION, { code: "INVOICE_MAYBE_DRAFTED" });
	if (presses.length) return answer(STATUS.WAITING, { code: "HAND_DRAFT_IN_FLIGHT" });

	// A draft row proves a draft was made, not that it went: "in neither" asks a person,
	// unless the Payments Table says it was billed. A mention can't prove either way.
	const inNeither = (invoiceId) => {
		if (seen.paymentsFilled) return byPayments(invoiceId);
		if (seen.mention) return answer(STATUS.UNKNOWN, { code: "MENTIONED", invoiceId });
		// A Bison invoice carries Bison's Order #, so with none on the row no search can find it.
		if (e.isBison === true && !rows.some((r) => String(r.order_number || "").trim())) return answer(STATUS.UNKNOWN, { code: "BISON_ORDER_NUMBER", invoiceId });
		return answer(isClosed(e.closedMonth) ? STATUS.UNKNOWN : STATUS.ATTENTION, { code: "DRAFT_NOT_IN_GMAIL", invoiceId });
	};

	// 7: the job's own draft. A row saying the job sent it is a sent invoice, whatever
	// became of the claim.
	const jobRows = rows.filter((r) => rules.isJobVia(r.via));
	const sentRow = jobRows.find((r) => viaOf(r) === rules.VIA_SEND);
	if (sentRow) return answer(STATUS.SENT, { invoiceId: sentRow.invoice_id, date: sentRow.created_at ? dayOf(sentRow.created_at) : "" });
	if ((c && c.state === "drafted") || jobRows.length) {
		const invoiceId = (c && c.invoice_id) || newest(jobRows).invoice_id || "";
		if (seen.sentInvoice) return bySentMail(invoiceId);
		if (seen.draftsInvoice) return answer(STATUS.DRAFT, { invoiceId, whose: "job" });
		// With no search behind it, a person may already have sent the draft: it says so.
		if (!seen.negativeHolds) return answer(STATUS.DRAFT, { invoiceId, whose: "job", sentUnchecked: true });
		return inNeither(invoiceId);
	}

	// 8: a draft row by anyone else, a blank or unknown `via` included.
	if (rows.length) {
		const invoiceId = newest(rows).invoice_id || "";
		if (seen.sentInvoice) return bySentMail(invoiceId);
		if (seen.draftsInvoice) return answer(STATUS.DRAFT, { invoiceId, whose: "person" });
		if (!seen.negativeHolds) return answer(STATUS.BY_HAND, { invoiceId, found: FOUND.DRAFT_ROW, sentUnchecked: true });
		return inNeither(invoiceId);
	}

	// 9: the job is on it, or (the sweep on) will be.
	if (c && (c.state === "queued" || c.state === "working")) return answer(STATUS.WAITING, { code: c.reason_code });
	if (c && c.state === "waiting" && (c.reason_code === "DRIVER_PENDING" || e.sweepOn === true)) return answer(STATUS.WAITING, { code: c.reason_code });

	// 11 stands above 10: a load billed on the Payments Table must not keep Try again.
	if (seen.paymentsFilled && !seen.sentInvoice) return byPayments();

	// 10: held for a person, unless the invoice has since turned up. OFF_GAP goes on to the
	// mailbox: it's the case most likely to be owed an invoice.
	if (c && c.state === "needs_attention" && c.reason_code !== "OFF_GAP") {
		if (seen.sentInvoice) return bySentMail();
		// A held load's sentence says "draft it by hand", which with this in Drafts bills it twice.
		if (seen.draftsInvoice) return answer(STATUS.DRAFT);
		return answer(STATUS.ATTENTION, { code: c.reason_code, mentioned: seen.mention });
	}

	// 12: everything else, on the mailbox alone.
	if (seen.sentInvoice) return bySentMail();
	if (seen.draftsInvoice) return answer(STATUS.DRAFT);
	if (claimSent(c)) return answer(STATUS.UNKNOWN, { code: "MAYBE_SENT" });
	if (seen.mention) return answer(STATUS.UNKNOWN, { code: "MENTIONED" });
	if (seen.failed) return answer(STATUS.UNKNOWN, { code: "SEARCH_FAILED" });
	if (!seen.negativeHolds) return answer(STATUS.UNKNOWN, { code: "NOT_SEARCHED" });
	if (e.isBison === true) return answer(STATUS.UNKNOWN, { code: "BISON_ORDER_NUMBER" });
	if (!seen.paymentsChecked) return answer(STATUS.UNKNOWN, { code: "PAYMENTS_NOT_READ" });
	return answer(STATUS.NONE_FOUND, { searchedAt: seen.searchedAt });
}

// The Completed Loads CSV's three cells: Invoice Status, Invoice #, Invoice Date. A draft with no
// search behind it may or may not have gone, so the file keeps the words that say so.
function exportCells(read) {
	const r = read || {};
	const label = STATUS_LABELS[r.status] || STATUS_LABELS[STATUS.UNKNOWN];
	return [r.sentUnchecked === true ? `${label} (Sent Mail not checked yet)` : label, r.invoiceId || "", r.date || ""];
}

module.exports = { STATUS, STATUS_LABELS, STATUS_CODES, FOUND, statusEnabled, statusOf, exportCells };
