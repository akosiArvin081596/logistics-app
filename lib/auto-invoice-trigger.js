// The driver's Delivered starts the invoice (AUTO_INVOICE_DRIVER_TRIGGER_ENABLED):
// the rules. lib/auto-invoice-job.js applies them.
//
// The setting is a kill switch: on unless it says off, and it counts only while the
// job makes real drafts. Off, the job runs its 5-minute sweep as before.
//
// Pure: no network, database or files.

"use strict";

const rules = require("./auto-invoice-rules");

const HOUR_MS = 60 * 60 * 1000;
// An open record older than this at start-up goes to a person: the box was down, or
// the tap's write was never settled, and somebody may have billed the load since.
const STALE_RECORD_MS = HOUR_MS;
const BUILDING_STAGES = new Set(["", "reserved", "rendered"]);

function enabled(env = {}) {
	return !/^(false|0|no|off)$/i.test(String(env?.AUTO_INVOICE_DRIVER_TRIGGER_ENABLED ?? "").trim());
}

// A Driver's own write into a completed status, on a load crossing into it with no claim,
// or one still `waiting`: a tap whose write failed or landed unanswered can already read
// Delivered. Every other claim is left alone, so a load sent stays sent.
function arms({ role, oldStatus, newStatus, claim } = {}) {
	if (role !== "Driver" || !rules.isCompletedStatus(newStatus)) return false;
	if (claim) return claim.state === "waiting";
	return !rules.isCompletedStatus(oldStatus);
}

const sendCommitted = (c) => c.delivery === "send" && c.stage === "appending";

// The code a claim goes to a person with once its run has ended, by how far it got.
function codeByStage(c, buildingCode = "DRAFT_FAILED") {
	if (sendCommitted(c)) return "MAYBE_SENT";
	if (c.stage === "appending") return "MAYBE_IN_GMAIL";
	if (c.stage === "appended" || c.stage === "recorded") return "IN_GMAIL_UNRECORDED";
	return buildingCode;
}

// A code the sweep left on a claim that still reads true once a person must act.
function ownCode(c) {
	const code = String(c.reason_code || "");
	return code && !["SEND_SETTLING", "SEND_UNCONFIRMED", "DRIVER_PENDING"].includes(code) ? code : "HANDED_OVER";
}

const person = (code) => ({ action: "person", code });
const RECOVER = Object.freeze({ action: "recover" });
const QUEUE = Object.freeze({ action: "queue" });
const NOTHING = Object.freeze({ action: "none" });

// What start-up does with one claim: person (Needs attention with `code`), recover (search
// or record it: a send that started is only ever searched for), queue (run it once), none.
// `first`: the claims are the sweep's, so nothing new is built, appended or sent.
function startUpAction(c, { first = false, nowMs = 0, staleMs = STALE_RECORD_MS } = {}) {
	const updated = Date.parse(String(c.updated_at || ""));
	const stale = !Number.isFinite(updated) || nowMs - updated > staleMs;
	switch (c.state) {
		case "working":
			if (sendCommitted(c) || c.stage === "appended" || c.stage === "recorded") return RECOVER;
			if (c.stage === "appending") return first ? person("MAYBE_IN_GMAIL") : RECOVER;
			if (first) return person("HANDED_OVER");
			return stale ? person("RETRY_LATER") : RECOVER;
		case "queued":
			if (sendCommitted(c) || c.stage === "appended" || c.stage === "recorded") return RECOVER;
			if (c.stage === "appending") return person("MAYBE_IN_GMAIL");
			if (first) return person(ownCode(c));
			return stale ? person("RETRY_LATER") : QUEUE;
		case "waiting":
			if (c.reason_code === "NOT_COMPLETED" || c.reason_code === "LOAD_DROPPED") return NOTHING;
			if (first) return person(ownCode(c));
			if (c.reason_code !== "DRIVER_PENDING") return person(ownCode(c));
			return stale ? person("RETRY_LATER") : QUEUE;
		default:
			return NOTHING;
	}
}

// Over the hourly or daily cap? One at a time is the run line's own rule, so this is
// the part of rules.capsAllow() that a load can't simply wait out.
function overCap({ lastHour = 0, lastDay = 0, caps } = {}) {
	const c = caps || rules.readCaps({});
	return lastHour >= c.maxPerHour || lastDay >= c.maxPerDay;
}

// The chip that keeps a completed load nothing will invoice from being forgotten. Not on a
// load nobody bills by email (factored, opted out) or already drafted, nor one from before
// the baseline or in a closed month.
function showsNotStarted({ live = false, drafts = 0, factored = false, optedOut = false, completionDay = "", baselineDay = "", closedMonths = null } = {}) {
	if (!live || drafts > 0 || factored || optedOut) return false;
	if (completionDay && baselineDay && completionDay < baselineDay) return false;
	return !(Array.isArray(closedMonths) && closedMonths.length > 0);
}

// What a person's Try again does for this claim, by the server's own rules, so the
// confirm can say it: "none" (refused), "search" (it only looks for what already went),
// "send", or "draft". `couldSend`: this load's recipient is one the job sends to.
function retryKind(c, { couldSend = false, stopped = false } = {}) {
	if (c.reason_code === "OFF_GAP") return "none";
	if (!BUILDING_STAGES.has(c.stage)) return "search";
	if (c.button_send_json) return "none";
	return couldSend && !stopped ? "send" : "draft";
}

// Is a person's Try again refused before anything runs? `savedInvoice`: saved evidence
// shows an invoice for this load. { code, error } or null.
function retryRefusal(c, { savedInvoice = false } = {}) {
	if (c.reason_code === "OFF_GAP") {
		return { code: "AUTO_INVOICE_RETRY_REFUSED", error: "This load was delivered while automatic invoices were off, so it may already be invoiced. Check Gmail Sent Mail, then draft it by hand if it still needs one." };
	}
	// A press confirms one message, once, so nothing but a person's next press may build it again.
	// One whose send started only ever gets searched for, and the send stop's resume waits on that.
	if (c.button_send_json && BUILDING_STAGES.has(c.stage)) {
		return { code: "AUTO_INVOICE_RETRY_REFUSED", error: "This invoice was started by the Send to C.H. Robinson button. Press the button again if it still needs one." };
	}
	if (savedInvoice) {
		return { code: "AUTO_INVOICE_RETRY_REFUSED", error: "An invoice for this load was found in the mailbox. Check Gmail, then draft it by hand if it still needs one." };
	}
	return null;
}

// Does this load's Payments Table row hold an invoice number, a payment date or a payment
// status? Only filled or blank is read. `values`: the tab with its header row first. A table
// whose columns can't be found throws: doubt is never read as "nothing there".
const PAYMENTS_FILLED_COLUMNS = Object.freeze(["invoice number", "payment date", "payment status"]);
function paymentsRowFilled(values, key) {
	const [headers, ...rows] = Array.isArray(values) ? values : [];
	const names = (headers || []).map((h) => String(h == null ? "" : h).trim().toLowerCase());
	const idCol = names.indexOf("job id");
	const cols = PAYMENTS_FILLED_COLUMNS.map((n) => names.indexOf(n));
	if (idCol < 0 || cols.some((c) => c < 0)) throw Object.assign(new Error("the Payments Table's columns were not found"), { code: "PAYMENTS_TABLE_SHAPE" });
	return rows.some((r) => rules.loadKey((r || [])[idCol]) === key && cols.some((c) => String((r || [])[c] ?? "").trim() !== ""));
}

// What lib/invoice-mailbox-search.js's answer means for a send: null only when it reads
// clean. An invoice or a mention is doubt, and an answer it can't read isn't "nothing".
function mailboxVerdict(answer) {
	const verdict = answer && answer.verdict;
	if (verdict === "clean") return null;
	return verdict === "invoice" || verdict === "mention" ? "MAILBOX_HIT" : "MAILBOX_UNREAD";
}

module.exports = {
	STALE_RECORD_MS,
	enabled,
	arms,
	codeByStage,
	startUpAction,
	overCap,
	showsNotStarted,
	retryKind,
	retryRefusal,
	paymentsRowFilled,
	mailboxVerdict,
};
