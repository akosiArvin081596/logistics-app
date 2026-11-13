// Whether a revised C.H. Robinson rate con's lower Payment is only its DVIR lines
// (server.js POST /api/n8n/keep-stored-values, RATECON_DVIR_KEEP_ENABLED). CHR pays the
// full amount, so that drop keeps the stored Payment; a drop that only looks like DVIR is
// kept too and goes to a person. It only ever keeps a stored value, never makes one.
//
//   isChrLoad(stored, headers)       -> the stored row passes lib/chr-events.js chrLoadTest()
//   paymentColumn(headers)           -> the first header named like Payment, or null
//   decide({ storedCents, sentCents, reading, otherMoneyChanged })
//                                    -> { verdict: "kept" | "held" | "none", reason, cents... }
//   recordedVerdict(verdict, on)     -> kept | held | would_keep | would_hold, or null
//   keepPayment(answer, column, storedValue, sentValue)
//                                    -> keepStoredSheetValues()'s answer, Payment as stored
//   reasonText(reason), auditDetails(decision)
//
// Pure: no network, DB or fs. Amounts arrive as cents (lib/cell-compare.js moneyCents()).
"use strict";

const chrEvents = require("./chr-events");
const rateconDvir = require("./ratecon-dvir");

const DVIR_UNIT_CENTS = rateconDvir.DVIR_UNIT_CENTS;
// With no readable reading, a drop of at most this many DVIR lines' worth is kept and goes
// to a person; a larger one is not taken for DVIR (today's rule).
const MAX_UNREAD_LINES = 2;
// The column the money math reads as Payment (lib/broker-invoice.js findPaymentColumn()).
const PAYMENT_COLUMN_RE = /payment/i;
const COLUMN_NAME_MAX = 200;
const READINGS = Object.freeze(["readable", "unreadable", "none"]);
const VERDICTS = Object.freeze(["kept", "held", "would_keep", "would_hold"]);
const REASON_TEXT = Object.freeze({
	dvir_lines: "the rate con's Payment is lower only by its DVIR lines",
	disagrees: "the rate con's DVIR lines don't account for all of the Payment drop",
	other_money: "the rate con changes another amount as well as its DVIR lines",
	unread: "the Payment drop is the size of a DVIR deduction, and the rate con's text can't be read to confirm it",
	no_dvir_line: "the Payment drop is the size of a DVIR deduction, and the rate con's text shows no DVIR line",
});
const REASONS = Object.freeze(Object.keys(REASON_TEXT));

function isChrLoad(stored, headers) {
	if (!stored || typeof stored !== "object") return false;
	return chrEvents.chrLoadTest(chrEvents.projectRow(stored, headers)).verdict === "chr";
}

function paymentColumn(headers) {
	const hit = (Array.isArray(headers) ? headers : []).find((h) => PAYMENT_COLUMN_RE.test(String(h == null ? "" : h).slice(0, COLUMN_NAME_MAX)));
	return hit === undefined ? null : hit;
}

// The state of this load's DVIR reading (lib/ratecon-dvir.js readRateConDvir(), or null).
function readingState(reading) {
	if (!reading || typeof reading !== "object") return "none";
	return reading.readable === true ? "readable" : "unreadable";
}

const wholeCents = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

// The verdict on one email's Payment; drop = stored - sent, in cents.
//   kept: the rate con's DVIR lines are exactly the drop and no other amount changed;
//   held: the drop looks like DVIR but nothing proves it (kept, a person decides);
//   none: today's rule (a rise, a drop no DVIR reading or size explains).
function decide({ storedCents, sentCents, reading = null, otherMoneyChanged = false } = {}) {
	const state = readingState(reading);
	const dvirCents = state === "readable" ? wholeCents(reading.cents) : 0;
	const dvirCount = state === "readable" ? wholeCents(reading.count) : 0;
	const valid = Number.isSafeInteger(storedCents) && Number.isSafeInteger(sentCents);
	const drop = valid ? storedCents - sentCents : 0;
	const out = (verdict, reason) => ({ verdict, reason, storedCents, sentCents, dropCents: drop, dvirCents, dvirCount, reading: state });
	if (!(drop > 0)) return out("none", "");
	if (dvirCount > 0 && dvirCents > 0) {
		if (dvirCents !== drop) return out("held", "disagrees");
		return otherMoneyChanged ? out("held", "other_money") : out("kept", "dvir_lines");
	}
	if (drop % DVIR_UNIT_CENTS === 0 && drop <= MAX_UNREAD_LINES * DVIR_UNIT_CENTS) {
		return out("held", state === "readable" ? "no_dvir_line" : "unread");
	}
	return out("none", "");
}

// What the decision table records: the verdict with the switch on, would_* with it off.
function recordedVerdict(verdict, on) {
	if (verdict === "kept") return on ? "kept" : "would_keep";
	if (verdict === "held") return on ? "held" : "would_hold";
	return null;
}

// keepStoredSheetValues()'s answer with `column` back as stored, listed as held (and as
// kept when the text differs), as the person hold lists the dates it keeps.
function keepPayment(answer, column, storedValue, sentValue) {
	const have = storedValue == null ? "" : String(storedValue);
	const sent = sentValue == null ? "" : String(sentValue);
	return {
		...answer,
		values: { ...answer.values, [column]: have },
		kept: sent === have || answer.kept.includes(column) ? answer.kept : [...answer.kept, column],
		held: [...answer.held, { column, stored: have, sent }],
	};
}

function reasonText(reason) {
	return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason] : "";
}

// The ratecon_payment_kept_dvir audit row's details: the two figures, DVIR cents and count.
function auditDetails(d) {
	return `Payment kept as stored (${rateconDvir.money(d.storedCents)}): the revised rate con's ${rateconDvir.money(d.sentCents)}`
		+ ` is lower only by its DVIR lines (${d.dvirCents} cents, ${d.dvirCount} line${d.dvirCount === 1 ? "" : "s"})`;
}

module.exports = {
	DVIR_UNIT_CENTS, MAX_UNREAD_LINES, PAYMENT_COLUMN_RE, READINGS, VERDICTS, REASONS,
	isChrLoad, paymentColumn, readingState, decide, recordedVerdict, keepPayment, reasonText, auditDetails,
};
