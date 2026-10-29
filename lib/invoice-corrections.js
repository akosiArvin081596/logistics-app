// Correction lines: a mistake found on an approved, processing or paid invoice
// goes on the driver's next open weekly invoice as a dated line naming that
// invoice (the approved-invoice lock, APPROVED_INVOICE_LOCK_ENABLED). These are
// the pure rules; server.js holds the wiring (the CORRECTION LINES section).
// Pure: no database, network or file access.
//
// Kinds:
//   day     a day of the source's week that nothing live pays; it holds that day
//   rate    a day the source's grid pays, at the rate in effect that day less
//           the grid's rate (only where the daily-rate rule prices the day)
//   amount  anything else: signed dollars and a printed description; it holds
//           no day and frees none, and its date only prints
// Only a live day line holds a day (waiting or linked). Every amount is in cents.

"use strict";

const KINDS = Object.freeze(["day", "rate", "amount"]);
// The adjust route's cap.
const MAX_CENTS = 1000000;
const DESCRIPTION_MAX = 80;
const REASON_MAX = 300;
// A negative day line is refused; a typed figure is more than $0 (day kind) or
// signed (amount kind), at most two decimals.
const UNSIGNED_RE = /^\d{1,7}(?:\.\d{1,2})?$/;
const SIGNED_RE = /^[+-]?\d{1,7}(?:\.\d{1,2})?$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The Order # rule (lib/broker-invoice-lines.js LINE_LABEL_RE), 80 characters.
const DESCRIPTION_RE = /^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$/u;
// Control, format (zero-width, bidi, BOM) and line or paragraph separator runs.
const STRIP_RE = /[\p{C}\p{Zl}\p{Zp}]+/gu;

const MESSAGES = Object.freeze({
	KIND_INVALID: "Choose the kind of correction: day, rate or amount.",
	DATE_INVALID: "Enter the date the correction is about, as YYYY-MM-DD.",
	DAY_FIGURE_INVALID: "Enter the day's pay in dollars: more than $0, at most two decimals and at most $10,000.",
	AMOUNT_INVALID: "Enter the amount in dollars, with a minus sign for money off: not $0, at most two decimals and at most $10,000 either way.",
	DESCRIPTION_INVALID: "Describe the amount in 1-80 characters, starting with a letter or number, with no line breaks, < or >.",
	REASON_REQUIRED: "Give a reason for the correction.",
	AMOUNT_PAYS_NO_DAY: "An amount line pays no day. A day worked and not paid goes as a day line on that week's weekly invoice.",
});

function isDay(s) {
	const m = DAY_RE.exec(String(s || ""));
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// "$1,234.56" for 123456 cents (the sign is the caller's).
function money(cents) {
	const abs = Math.abs(Math.round(Number(cents) || 0)) / 100;
	return `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function signedMoney(cents) {
	return `${cents < 0 ? "-" : "+"}${money(cents)}`;
}

// "Thu Oct 15, 2026", read at 12:00 UTC so it is the same day in every zone.
function dayText(day) {
	if (!isDay(day)) return "";
	const d = new Date(`${day}T12:00:00Z`);
	const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d);
	const md = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
	return `${wd} ${md}`;
}

// "Oct 10-16, 2026", "Sep 26 - Oct 2, 2026", "Dec 26, 2026 - Jan 1, 2027".
function periodText(start, end) {
	if (!isDay(start) || !isDay(end)) return `${start} to ${end}`;
	const fmt = (s) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${s}T12:00:00Z`));
	const [am, ad, ay] = fmt(start).replace(",", "").split(" ");
	const [bm, bd, by] = fmt(end).replace(",", "").split(" ");
	if (ay !== by) return `${fmt(start)} - ${fmt(end)}`;
	if (am !== bm) return `${am} ${ad} - ${bm} ${bd}, ${by}`;
	return `${am} ${ad}-${bd}, ${by}`;
}

function refusal(status, code, error) {
	return { status, code, error };
}

// A typed dollar figure in cents: { cents } or a refusal. signed: the amount
// kind (non-zero, either sign); otherwise the day kind (more than $0).
function parseFigure(input, { signed }) {
	const bad = signed ? refusal(400, "CORRECTION_AMOUNT_INVALID", MESSAGES.AMOUNT_INVALID) : refusal(400, "CORRECTION_DAY_FIGURE_INVALID", MESSAGES.DAY_FIGURE_INVALID);
	let text;
	if (typeof input === "number") {
		if (!Number.isFinite(input)) return bad;
		text = String(input);
	} else if (typeof input === "string") {
		text = input.trim();
	} else {
		return bad;
	}
	if (!(signed ? SIGNED_RE : UNSIGNED_RE).test(text)) return bad;
	const negative = text.startsWith("-");
	const [whole, frac = ""] = text.replace(/^[+-]/, "").split(".");
	const abs = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
	if (!(abs > 0) || abs > MAX_CENTS) return bad;
	return { cents: negative ? -abs : abs };
}

// The printed description of an amount line, or a refusal.
function cleanDescription(input) {
	const text = String(typeof input === "string" ? input : "").replace(STRIP_RE, " ").replace(/\s+/g, " ").trim();
	if (!DESCRIPTION_RE.test(text)) return refusal(400, "CORRECTION_DESCRIPTION_INVALID", MESSAGES.DESCRIPTION_INVALID);
	return { description: text };
}

// The audit reason: required, one line, at most REASON_MAX characters.
function cleanReason(input) {
	const text = String(typeof input === "string" ? input : "").replace(STRIP_RE, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
	if (!text) return refusal(400, "CORRECTION_REASON_REQUIRED", MESSAGES.REASON_REQUIRED);
	return { reason: text };
}

// Whether `day` falls in the source's period (a weekly source: its week).
function dateInSource(day, source) {
	return isDay(day) && isDay(source && source.week_start) && isDay(source && source.week_end)
		&& day >= source.week_start && day <= source.week_end;
}

// The printed words of a line (the reason never prints):
//   "Correction to INV-… (Oct 10-16, 2026), Thu Oct 15, 2026: day worked, not paid"
function lineLabel(line) {
	const head = `Correction to ${line.source_invoice_number} (${periodText(line.source_week_start, line.source_week_end)}), ${dayText(line.line_date)}`;
	if (line.kind === "day") return `${head}: day worked, not paid`;
	if (line.kind === "rate") return `${head}: daily rate ${money(line.rate_from_cents)} → ${money(line.rate_to_cents)}`;
	return `${head}: ${line.description || "correction"}`;
}

// The rows a carrying invoice prints, in line order: { lineId, label, amount }
// and their total in dollars. No line: {} (the invoice prints as before).
function printFields(lines) {
	const list = [...(lines || [])].sort((a, b) => a.id - b.id);
	if (!list.length) return {};
	return {
		correctionLines: list.map((l) => ({ lineId: l.id, label: l.label, amount: signedMoney(Number(l.cents) || 0) })),
		correctionLinesTotal: totalCents(list) / 100,
	};
}

function totalCents(lines) {
	return (lines || []).reduce((s, l) => s + (Number(l.cents) || 0), 0);
}

// Which lines one invoice takes (D11): positive lines first (they only add
// room), then negative lines oldest first while the total due stays at $0 or
// more; nothing is split. roomCents is the total due before these lines with
// any Personal lines counted. Returns { fit, unfit }.
function fitLines(roomCents, lines) {
	const sorted = [...(lines || [])].sort((a, b) => a.id - b.id);
	const positive = sorted.filter((l) => Number(l.cents) > 0);
	let running = Math.round(Number(roomCents) || 0) + totalCents(positive);
	const fit = [...positive];
	const unfit = [];
	for (const l of sorted.filter((x) => !(Number(x.cents) > 0))) {
		const c = Number(l.cents) || 0;
		if (running + c >= 0) {
			running += c;
			fit.push(l);
		} else {
			unfit.push(l);
		}
	}
	return { fit: fit.sort((a, b) => a.id - b.id), unfit, totalCents: running };
}

// The refit after a write that lowers an invoice's room: the newest negative
// lines go back to waiting until the total due is $0 or more (or none is left).
// totalDueCents is the total with every line counted.
function refitNegatives(totalDueCents, lines) {
	let total = Math.round(Number(totalDueCents) || 0);
	const negatives = [...(lines || [])].filter((l) => Number(l.cents) < 0).sort((a, b) => b.id - a.id);
	const detach = [];
	for (const l of negatives) {
		if (total >= 0) break;
		total -= Number(l.cents) || 0;
		detach.push(l);
	}
	return { detach, totalCents: total };
}

module.exports = {
	KINDS, MAX_CENTS, DESCRIPTION_MAX, REASON_MAX, MESSAGES,
	isDay, money, signedMoney, dayText, periodText, parseFigure, cleanDescription, cleanReason,
	dateInSource, lineLabel, printFields, totalCents, fitLines, refitNegatives,
};
