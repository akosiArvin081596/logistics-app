// C.H. Robinson's advance, read from its revised rate con (server.js, RATECON_ADVANCE_READ_ENABLED).
// CHR's revised "Booked Load #" rate con prints a Total, an "Advanced Total" (money CHR already
// paid on the load) and a "New Total". On a found CHR load this fills the load's advance line on
// the broker invoice (B20, invoice-only) only when the three figures each sit beside their label
// and Advanced Total + New Total = Total to the cent; anything else adds nothing and a person
// decides. It never writes Payment, a sheet cell, an invoice or a send.
//
//   enabled(env), linesOn(env), writesOn({ enabled, env, holdOn, warn })
//   readAdvanceFigures(text)  -> { state: "labels" | "no_labels" | "unreadable", ... }
//   createReadingStore({ ttlMs, max })
//   decide({ reading, paymentCents, dvir, invoiced, lines }) -> { verdict, reason, cents... }
//   run(db, { loadId, reading, paymentCents, dvir, on, closedMonths, at }, { audit, notify })
//   recordedVerdict(verdict, on), lineValues(decision), noticeFor(decision, label), purge(db, now)
//
// The reader and decide() are pure. run() takes the database it works on and does every read and
// write in one synchronous transaction, so nothing else can add a line between its checks and its
// insert. The advance lines are reached through lib/broker-invoice.js's re-export, as the
// automatic invoice's ledger reaches them.
"use strict";

const { invoiceLines } = require("./broker-invoice");

const ACTOR = "ratecon-advance-read";
// On the automatic invoice's closed list (lib/auto-invoice-rules.js AUTO_LINE_LABELS). The rate
// con says what was advanced, not what for, so not "Fuel advance".
const LINE_LABEL = "Advance";
const TABLE = "ratecon_advance_reads";
const KEEP_DAYS = 400;
const MAX_ROWS = 50000;
// More occurrences of one label than this is not a rate block the reader can trust.
const MAX_LABEL_HITS = 20;
const LOOK_AFTER = 40;
const LOOK_BEFORE = 12;
const VERDICTS = Object.freeze(["filled", "would_fill", "person", "would_person", "same", "unread"]);
const REASONS = Object.freeze(["sum_checks", "figure_missing", "sum_off", "advance_over_half", "not_chr_text", "unreadable", "own_line", "line_agrees",
	"after_invoice", "lines_differ", "payment_not_total", "write_failed"]);

// ── the switch ───────────────────────────────────────────────────────────────
// On only when exactly "true". Named in full so the flag checks that scan for
// `env.<NAME>_ENABLED` (scripts/test-replica-enable-flag.js) see this read.
function enabled(env) {
	return String((env && env.RATECON_ADVANCE_READ_ENABLED) ?? "").trim() === "true";
}

// The advance lines' own switch, through their one reader.
function linesOn(env) {
	return invoiceLines.linesEnabled(env || {});
}

// Whether the read may write: its switch, the advance lines (their table exists only while
// they are on) and the re-issue hold (without it no open load can be told). Otherwise each
// decision is recorded as if the switch were off, and `warn` says why, once per call.
function writesOn({ enabled: on = false, env = {}, holdOn = false, warn = null } = {}) {
	if (!on) return false;
	const why = [];
	if (!linesOn(env)) why.push("RATECON_ADVANCE_READ_ENABLED is on but BROKER_INVOICE_LINES_ENABLED is off, so no advance line is written");
	if (!holdOn) why.push("RATECON_ADVANCE_READ_ENABLED is on but RATECON_REISSUE_HOLD_ENABLED is off, so no revised rate con is read");
	if (why.length && typeof warn === "function") for (const w of why) warn(`[ratecon-advance] ${w}`);
	return why.length === 0;
}

// ── the reader ───────────────────────────────────────────────────────────────
// Every quantifier is bounded: the text is a PDF anyone can email in.
const ADVANCE_LABEL_RE = /advanced\s{0,3}total/gi;
const NEW_LABEL_RE = /new\s{0,3}total/gi;
const TOTAL_LABEL_RE = /total\s{0,3}:/gi;
// A figure right after its label: spaces and a colon between, then "$", digits (grouped by
// commas in threes, or not at all) and two decimals, positive. What follows the decimals isn't
// read: the shown text joins a PDF's strings with nothing between, so the next item's digits
// can sit right after them.
const FIGURE_RE = /^\s{0,3}:?\s{0,3}\$\s{0,3}(\d{1,3}(?:,\d{3}){1,2}|\d{1,7})\.(\d{2})/;
// A "$" right after a "Total:" label: the rate Total's figure, however malformed. A minus first
// (a deduction line's total) is never the rate Total.
const DOLLAR_AFTER_RE = /^\s{0,3}:?\s{0,3}\$/;
const SUB_OR_ADVANCE_BEFORE_RE = /(?:advanced|new)\s{0,3}$/i;
const ANY_ADVANCE_LABEL_RE = /advanced\s{0,3}total|new\s{0,3}total/i;
const NAMES_CHR_RE = /robinson/i;

function figureCents(after) {
	const m = FIGURE_RE.exec(after);
	if (!m) return null;
	const cents = Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]);
	return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// One label's figures: { values: [cents...], bad: true when an occurrence has no figure beside
// it (or one that isn't a positive amount with two decimals), or there are too many }.
function labelFigures(text, re, { plainTotal = false } = {}) {
	const values = [];
	let bad = false;
	let hits = 0;
	re.lastIndex = 0;
	let m;
	while ((m = re.exec(text)) !== null) {
		const at = m.index;
		if (plainTotal) {
			const prev = at > 0 ? text.charCodeAt(at - 1) : 0;
			// "Subtotal:", "NewTotal:", "AdvancedTotal:" and "New Total:" are not the rate Total.
			if ((prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122)) continue;
			if (SUB_OR_ADVANCE_BEFORE_RE.test(text.slice(Math.max(0, at - LOOK_BEFORE), at))) continue;
		}
		if (++hits > MAX_LABEL_HITS) return { values, bad: true };
		const after = text.slice(at + m[0].length, at + m[0].length + LOOK_AFTER);
		const cents = figureCents(after);
		if (cents !== null) { values.push(cents); continue; }
		// A commodity "Total:" (a weight, a count) or a deduction's names no positive dollar
		// figure and is not the rate Total; any other label without its figure beside it can't
		// be read.
		if (plainTotal && !DOLLAR_AFTER_RE.test(after)) continue;
		bad = true;
	}
	return { values, bad };
}

// What a rate con's shown text (lib/pdf-shown-text.js shownText()) says about an advance.
//   unreadable: no text at all;
//   no_labels: neither "Advanced Total" nor "New Total" (an ordinary rate con);
//   labels: the three figures in cents (0 where none was read), and `problem` "figure_missing"
//     when any of them isn't exactly one figure right beside its label, else null.
function readAdvanceFigures(text) {
	const s = typeof text === "string" ? text : "";
	if (!s.trim()) return { state: "unreadable" };
	const namesChr = NAMES_CHR_RE.test(s);
	if (!ANY_ADVANCE_LABEL_RE.test(s)) return { state: "no_labels", namesChr };
	const adv = labelFigures(s, ADVANCE_LABEL_RE);
	const newT = labelFigures(s, NEW_LABEL_RE);
	const total = labelFigures(s, TOTAL_LABEL_RE, { plainTotal: true });
	const one = (f) => (!f.bad && f.values.length > 0 && f.values.every((v) => v === f.values[0]) ? f.values[0] : null);
	const totalCents = one(total);
	const advanceCents = one(adv);
	const newTotalCents = one(newT);
	const problem = totalCents === null || advanceCents === null || newTotalCents === null ? "figure_missing" : null;
	return { state: "labels", namesChr, totalCents: totalCents || 0, advanceCents: advanceCents || 0, newTotalCents: newTotalCents || 0, problem };
}

// ── the reading store ────────────────────────────────────────────────────────
// Readings kept in memory by load key, `ttlMs` each, at most `max` loads, the oldest dropped
// first. A reading with no advance label never replaces a fresh one that has one: an email's
// other PDF (a BOL) is read under the same load number.
function createReadingStore({ ttlMs = 10 * 60 * 1000, max = 200 } = {}) {
	const map = new Map();
	const fresh = (hit, now) => Boolean(hit) && now - hit.at < ttlMs;
	return {
		note(key, reading, now = Date.now()) {
			if (!key || !reading || typeof reading !== "object") return;
			for (const [k, v] of map) {
				if (fresh(v, now)) break;
				map.delete(k);
			}
			const had = map.get(key);
			if (fresh(had, now) && had.reading.state === "labels" && reading.state !== "labels") return;
			map.delete(key);
			map.set(key, { reading, at: now });
			while (map.size > max) map.delete(map.keys().next().value);
		},
		get(key, now = Date.now()) {
			const hit = key ? map.get(key) : undefined;
			return fresh(hit, now) ? hit.reading : null;
		},
		size() { return map.size; },
	};
}

// ── the decision ─────────────────────────────────────────────────────────────
const wholeCents = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

// Payment after this email (the answer's value, else the stored cell; null when it isn't one
// amount) must be the rate con's Total, or the stored figure the DVIR keep kept for this same
// email (its decision, lib/ratecon-dvir-keep.js decide(), sent the Total). Anything else could
// take the advance off twice (a Payment that is already the New Total) or bill a figure the
// rate con doesn't show.
function paymentIsTotal(paymentCents, totalCents, dvir) {
	if (!Number.isSafeInteger(paymentCents)) return false;
	if (paymentCents === totalCents) return true;
	return Boolean(dvir) && (dvir.verdict === "kept" || dvir.verdict === "held") && dvir.sentCents === totalCents && dvir.storedCents === paymentCents;
}

// The verdict on one email's revised rate con for a found CHR load:
//   fill    the line can be added (reason sum_checks);
//   person  a person decides (figure_missing, sum_off, advance_over_half, not_chr_text,
//           after_invoice, lines_differ, payment_not_total);
//   same    the load's active lines already hold this advance (own_line, line_agrees);
//   unread  the PDF shows no text;
//   none    nothing to decide (no reading, or an ordinary rate con).
// `invoiced` true, false or null (can't tell: as invoiced); `lines` { activeCount, activeCents,
// voidedCount, ownOnly } or null (can't tell).
function decide({ reading = null, paymentCents = null, dvir = null, invoiced = null, lines = null } = {}) {
	const r = reading && typeof reading === "object" ? reading : null;
	const t = wholeCents(r && r.totalCents);
	const a = wholeCents(r && r.advanceCents);
	const n = wholeCents(r && r.newTotalCents);
	const out = (verdict, reason) => ({ verdict, reason, totalCents: t, advanceCents: a, newTotalCents: n, paymentCents: Number.isSafeInteger(paymentCents) ? paymentCents : null });
	if (!r || r.state === "no_labels") return out("none", "");
	if (r.state === "unreadable") return out("unread", "unreadable");
	if (r.state !== "labels") return out("none", "");
	if (r.problem || !(t > 0 && a > 0 && n > 0)) return out("person", "figure_missing");
	if (a + n !== t) return out("person", "sum_off");
	// The sum can't tell the advance from the New Total if the two were read the wrong way
	// round; an advance larger than the New Total (over half the Total) goes to a person.
	if (a > n) return out("person", "advance_over_half");
	if (r.namesChr !== true) return out("person", "not_chr_text");
	if (lines && lines.activeCount > 0 && lines.activeCents === a) return out("same", lines.ownOnly ? "own_line" : "line_agrees");
	if (invoiced !== false) return out("person", "after_invoice");
	if (!lines || lines.activeCount > 0 || lines.voidedCount > 0) return out("person", "lines_differ");
	if (!paymentIsTotal(paymentCents, t, dvir)) return out("person", "payment_not_total");
	return out("fill", "sum_checks");
}

// What the decision table records: the verdict with the switch on, would_* with it off.
function recordedVerdict(verdict, on) {
	if (verdict === "fill") return on ? "filled" : "would_fill";
	if (verdict === "person") return on ? "person" : "would_person";
	if (verdict === "same") return "same";
	if (verdict === "unread") return "unread";
	return null;
}

const money = (cents) => invoiceLines.formatCents(cents);
function figuresText(d) {
	return `Total ${money(d.totalCents)}, Advanced Total ${money(d.advanceCents)}, New Total ${money(d.newTotalCents)}`;
}

// The line's values, in the shape lib/broker-invoice.js's invoiceLines.parseNewLine() answers.
// No received date and no reference (the automatic invoice prints neither); the note, which no
// invoice prints, says where the figure came from.
function lineValues(d) {
	return {
		kind: "advance",
		label: LINE_LABEL,
		amountCents: d.advanceCents,
		receivedOn: "",
		reference: "",
		note: `Read by the app from C.H. Robinson's revised rate con: ${figuresText(d)}.`,
	};
}

// The Super Admin notice for a case handed to a person, or null. Load number and figures only.
function noticeFor(d, label) {
	if (!d || d.verdict !== "person") return null;
	const load = String(label == null ? "" : label).trim().slice(0, 80);
	const adv = money(d.advanceCents);
	const byHand = "If the load has an advance, add it on the invoice by hand.";
	switch (d.reason) {
		case "figure_missing":
			return { title: `Load ${load}: advance not read`, body: `C.H. Robinson's revised rate con shows an advance, but its Total, Advanced Total and New Total couldn't each be read beside its label. No advance line was added. ${byHand}` };
		case "sum_off":
			return { title: `Load ${load}: advance not added`, body: `C.H. Robinson's revised rate con reads Advanced Total ${adv} and New Total ${money(d.newTotalCents)}, which don't add up to its Total ${money(d.totalCents)}. No advance line was added. Check the rate con. ${byHand}` };
		case "advance_over_half":
			return { title: `Load ${load}: advance not added`, body: `C.H. Robinson's revised rate con reads Advanced Total ${adv}, more than its New Total ${money(d.newTotalCents)}. The app adds an advance only when it is the smaller of the two, so a person checks this one. No advance line was added. ${byHand}` };
		case "not_chr_text":
			return { title: `Load ${load}: advance not added`, body: `The revised rate con for this C.H. Robinson load doesn't name C.H. Robinson. No advance line was added. Check the rate con. ${byHand}` };
		case "after_invoice":
			return { title: `Load ${load}: advance after the invoice`, body: `C.H. Robinson's revised rate con shows an advance of ${adv} (New Total ${money(d.newTotalCents)}), and an invoice was already made for this load. No advance line was added and nothing was re-sent. If the invoice billed the full amount, send a corrected invoice by hand.` };
		case "lines_differ":
			return { title: `Load ${load}: advance lines don't match`, body: `C.H. Robinson's revised rate con shows an advance of ${adv}, and this load's advance lines don't match it (or one was voided). Nothing was changed. Check the load's advance lines.` };
		case "payment_not_total":
			return { title: `Load ${load}: advance not added`, body: `C.H. Robinson's revised rate con shows an advance of ${adv} (${figuresText(d)}), but the load's Payment ${d.paymentCents === null ? "isn't one amount" : `is ${money(d.paymentCents)}`}, not that Total. No advance line was added. Check Payment. ${byHand}` };
		case "write_failed":
			return { title: `Load ${load}: advance not added`, body: `C.H. Robinson's revised rate con shows an advance of ${adv}, and the advance line couldn't be saved. ${byHand}` };
		default:
			return null;
	}
}

// ── the record ───────────────────────────────────────────────────────────────
function ensureTable(db) {
	const list = (xs) => xs.map((x) => `'${x}'`).join(", ");
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			load_key TEXT NOT NULL,
			at TEXT NOT NULL,
			verdict TEXT NOT NULL CHECK (verdict IN (${list(VERDICTS)})),
			reason TEXT NOT NULL CHECK (reason IN (${list(REASONS)})),
			total_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total_cents) = 'integer'),
			advance_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(advance_cents) = 'integer'),
			new_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(new_total_cents) = 'integer'),
			payment_cents INTEGER CHECK (payment_cents IS NULL OR typeof(payment_cents) = 'integer'),
			line_id INTEGER,
			switch_on INTEGER NOT NULL CHECK (switch_on IN (0, 1)),
			notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1))
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_load ON ${TABLE}(load_key, id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_at ON ${TABLE}(at)`);
}

// Rows older than KEEP_DAYS, and past MAX_ROWS the oldest. Decision rows only, never a line.
function purge(db, now = new Date()) {
	const before = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString();
	const aged = db.prepare(`DELETE FROM ${TABLE} WHERE at < ?`).run(before).changes;
	const capped = db.prepare(`DELETE FROM ${TABLE} WHERE id <= (SELECT id FROM ${TABLE} ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(MAX_ROWS).changes;
	return aged + capped;
}

// Whether an invoice was made for the load (any draft row, under any spelling of its id), or
// null when the drafts can't be read.
function invoicedState(db, key) {
	try {
		return db.prepare("SELECT load_id FROM load_invoice_drafts").all().some((r) => invoiceLines.loadKey(r.load_id) === key);
	} catch {
		return null;
	}
}

// The load's advance lines, or null when they can't be read. No table (the lines switched
// off): none.
function linesState(db, key) {
	try {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(invoiceLines.TABLE)) {
			return { activeCount: 0, activeCents: 0, voidedCount: 0, ownOnly: true };
		}
		const rows = db.prepare(`SELECT amount_cents, voided_at, created_by FROM ${invoiceLines.TABLE} WHERE load_key = ? ORDER BY id`).all(key);
		const active = rows.filter((r) => r.voided_at === null || r.voided_at === undefined);
		return {
			activeCount: active.length,
			activeCents: active.reduce((sum, r) => sum + Number(r.amount_cents), 0),
			voidedCount: rows.length - active.length,
			ownOnly: active.every((r) => r.created_by === ACTOR),
		};
	} catch {
		return null;
	}
}

// One email's decision for a found CHR load, recorded; with `on`, the line written (its audit
// row by `audit`, inside the same transaction) and a person told once per load, reason and
// amount (`notify({ title, body })`, after the transaction). Answers { decision, verdict,
// recorded, lineId, notified }, or null for a load with no key. Throws on a database error:
// nothing is then written (the caller logs it).
function run(db, { loadId, reading = null, paymentCents = null, dvir = null, on = false, closedMonths = [], at = new Date().toISOString() } = {}, { audit = null, notify = null } = {}) {
	const key = invoiceLines.loadKey(loadId).slice(0, 80);
	if (!key) return null;
	// Nothing to decide (no reading, or an ordinary rate con): no table, no row.
	const first = decide({ reading, paymentCents, dvir, invoiced: false, lines: null });
	if (first.verdict === "none") return { decision: first, verdict: null, recorded: false, lineId: null, notified: false };
	const nowDate = Number.isFinite(Date.parse(at)) ? new Date(at) : new Date();
	ensureTable(db);
	const result = db.transaction(() => {
		let d = decide({ reading, paymentCents, dvir, invoiced: invoicedState(db, key), lines: linesState(db, key) });
		let lineId = null;
		if (on && d.verdict === "fill") {
			const added = invoiceLines.addLine(db, { loadId: String(loadId).trim(), values: lineValues(d), actor: ACTOR, closedMonths },
				{ audit: (action, detail, line) => { if (typeof audit === "function") audit(action, `${detail} — read from C.H. Robinson's revised rate con (${figuresText(d)})`, line); } });
			if (added.ok) lineId = added.line.id;
			else d = { ...d, verdict: "person", reason: "write_failed" };
		}
		const verdict = recordedVerdict(d.verdict, on);
		const told = on && d.verdict === "person"
			&& !db.prepare(`SELECT 1 FROM ${TABLE} WHERE load_key = ? AND reason = ? AND advance_cents = ? AND notified = 1 LIMIT 1`).get(key, d.reason, d.advanceCents);
		db.prepare(`INSERT INTO ${TABLE} (load_key, at, verdict, reason, total_cents, advance_cents, new_total_cents, payment_cents, line_id, switch_on, notified)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, nowDate.toISOString(), verdict, d.reason, d.totalCents, d.advanceCents, d.newTotalCents, d.paymentCents, lineId, on ? 1 : 0, told ? 1 : 0);
		purge(db, nowDate);
		return { decision: d, verdict, recorded: true, lineId, notified: Boolean(told) };
	}).immediate();
	if (result.notified && typeof notify === "function") {
		const notice = noticeFor(result.decision, String(loadId).trim());
		if (notice) notify(notice);
	}
	return result;
}

module.exports = {
	ACTOR, LINE_LABEL, TABLE, KEEP_DAYS, MAX_ROWS, VERDICTS, REASONS,
	enabled, linesOn, writesOn, readAdvanceFigures, createReadingStore, decide, recordedVerdict,
	lineValues, noticeFor, ensureTable, purge, invoicedState, linesState, run,
};
