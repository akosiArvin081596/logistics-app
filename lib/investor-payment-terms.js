// Per-investor payment terms: the one definition of what an invitation's
// terms may be, how they are stored, and how they reach the two investor
// contracts (master agreement, vehicle lease).
//
// Pure: `crypto` only — no DB, no network, no filesystem. server.js owns the
// `investor_invites` table, the routes and the snapshot columns; this module
// owns every rule about the VALUES. The client form mirrors the input rules in
// client/src/lib/paymentTerms.js, and scripts/test-payment-terms-parity.mjs
// fails when the two answer any input differently.
//
// ⚠️ CONTRACT WORDING ONLY. Nothing here, and nothing that reads the data it
// describes, may feed a payout, ledger, split or statement. Payouts are still
// computed from the investor's Split % (resolveInvestorSplitPct() and the code
// under it); scripts/test-payment-terms-routes.js pins that none of that code
// references this module or the tables it describes.
//
// Every regular expression below runs on text an admin typed, or on a stored
// copy of it, so each one is a single character class or a fixed-length
// pattern, and each input is length-checked before the first one runs.

"use strict";

const crypto = require("crypto");

const PAYMENT_TYPES = Object.freeze(["split", "lease"]);

const LIMITS = Object.freeze({
	LEASE_MIN_CENTS: 100,
	LEASE_MAX_CENTS: 10000000,
	DETAILS_MAX: 2000,
	DETAILS_MAX_LINES: 30,
	DETAILS_RAW_MAX: 8000,
	NAME_MAX: 120,
	AMOUNT_RAW_MAX: 16,
});

// The two documents that carry payment terms. The W-9 never does.
const TERMS_DOC_KEYS = Object.freeze(["master_agreement", "vehicle_lease"]);

// The aria-labels the templates' terms slots carry. Values reach the PDF only
// through lib/policy-renderer.js's aria-label fill (textContent / value),
// never by string insertion into the HTML.
const FIELD_LABELS = Object.freeze({
	type: "Payment terms type",
	amount: "Payment terms monthly amount",
	details: "Payment terms details",
});

const TYPE_LABELS = Object.freeze({
	split: "50/50 profit split",
	lease: "Fixed monthly lease payment",
});

const STANDARD_SUMMARY = "50/50 profit split — standard contract terms";

// Each document's slots, and the variants a slot must carry. A slot with no
// variant for the terms being rendered keeps its default lines (the split
// variant of master.3.3 is the standard 50/50 text itself).
const TEMPLATE_SLOTS = Object.freeze({
	master_agreement: Object.freeze({
		"master.3.3": Object.freeze(["lease"]),
		"master.amendment": Object.freeze(["split", "lease"]),
	}),
	vehicle_lease: Object.freeze({
		"lease.2.01": Object.freeze(["lease"]),
		"lease.amendment": Object.freeze(["split", "lease"]),
	}),
});

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ── tokens ──────────────────────────────────────────────────────────────────
// 32 random bytes, base64url: 43 characters. Only the sha256 is ever stored.
function newInviteToken() {
	return crypto.randomBytes(32).toString("base64url");
}

function hashInviteToken(token) {
	return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

// ── input rules ─────────────────────────────────────────────────────────────
const AMOUNT_RE = /^\d{1,9}(?:\.\d{1,2})?$/;

const MESSAGES = Object.freeze({
	invalid_type: "Choose a payment type: a 50/50 profit split or a fixed monthly lease payment.",
	amount_required: "Enter the monthly lease amount.",
	invalid_amount: "Enter the monthly lease amount in dollars and cents, for example 2000 or 2000.50.",
	amount_out_of_range: "The monthly lease amount must be between $1.00 and $100,000.00.",
	amount_not_allowed: "A 50/50 profit split has no monthly amount.",
	details_not_text: "Additional terms must be text.",
	details_too_long: `Additional terms can be at most ${LIMITS.DETAILS_MAX} characters.`,
	details_too_many_lines: `Additional terms can be at most ${LIMITS.DETAILS_MAX_LINES} lines.`,
	unsupported_characters: "Additional terms can use Latin letters, numbers, punctuation and symbols only (no emoji or other scripts).",
});

const isBlank = (v) => v === undefined || v === null || v === "";

// A number, or a string that after trim and at most one leading "$" is plain
// dollars with at most two decimals. Cents come from the digits themselves,
// never from floating-point arithmetic, so "2000.10" is 200010 exactly.
function parseLeaseAmountToCents(value) {
	if (isBlank(value)) return { ok: false, reason: "amount_required" };
	let text;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return { ok: false, reason: "invalid_amount" };
		text = String(value);
	} else if (typeof value === "string") {
		text = value;
	} else {
		return { ok: false, reason: "invalid_amount" };
	}
	if (text.length > LIMITS.AMOUNT_RAW_MAX) return { ok: false, reason: "invalid_amount" };
	text = text.trim();
	if (text === "") return { ok: false, reason: "amount_required" };
	if (text[0] === "$") text = text.slice(1);
	if (!AMOUNT_RE.test(text)) return { ok: false, reason: "invalid_amount" };
	const [whole, frac = ""] = text.split(".");
	const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
	if (cents < LIMITS.LEASE_MIN_CENTS || cents > LIMITS.LEASE_MAX_CENTS) return { ok: false, reason: "amount_out_of_range" };
	return { ok: true, value: cents };
}

const LINE_SEPARATORS_RE = /[\p{Zl}\p{Zp}]/gu;
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const OTHER_SCRIPT_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
// The copyright, registered and trade mark signs are Extended_Pictographic, but
// in running text they are ordinary symbols, so these three (and no other) are
// set aside before the emoji test. Followed by U+FE0F they ask for the emoji,
// which EMOJI_PARTS_RE below refuses. Built from code points.
const TEXT_SYMBOLS_RE = new RegExp(`[${String.fromCodePoint(0xa9, 0xae, 0x2122)}]`, "gu");
// The pieces emoji are assembled from that are not themselves Extended_Pictographic:
// regional indicators (flags), skin-tone modifiers, the combining keycap and the
// emoji presentation selector. Built from code points.
const EMOJI_PARTS_RE = new RegExp(`[\\p{Regional_Indicator}\\p{Emoji_Modifier}${String.fromCodePoint(0x20e3, 0xfe0f)}]`, "u");

// Additional terms, normalized in one fixed order: line breaks to LF, tabs to
// a space, every control / format / private-use / unassigned / surrogate code
// point dropped (LF kept), NFC, line ends trimmed, at most one blank line in a
// row, then the whole trimmed. The result is what is stored, printed and
// snapshotted, and normalizing it again changes nothing. Emoji and other
// scripts are refused; the copyright, registered and trade mark signs are not.
function normalizeDetails(value) {
	if (value === undefined || value === null) return { ok: true, value: "" };
	if (typeof value !== "string") return { ok: false, reason: "details_not_text" };
	if (value.length > LIMITS.DETAILS_RAW_MAX) return { ok: false, reason: "details_too_long" };
	const cleaned = value
		.replace(/\r\n?/g, "\n")
		.replace(LINE_SEPARATORS_RE, "\n")
		.replace(/\t/g, " ")
		.replace(INVISIBLE_RE, (c) => (c === "\n" ? c : ""))
		.normalize("NFC");
	const kept = [];
	for (const line of cleaned.split("\n")) {
		const trimmed = line.trimEnd();
		if (trimmed === "" && kept.length && kept[kept.length - 1] === "") continue;
		kept.push(trimmed);
	}
	const text = kept.join("\n").trim();
	if (text.length > LIMITS.DETAILS_MAX) return { ok: false, reason: "details_too_long" };
	if (text && text.split("\n").length > LIMITS.DETAILS_MAX_LINES) return { ok: false, reason: "details_too_many_lines" };
	if (PICTOGRAPHIC_RE.test(text.replace(TEXT_SYMBOLS_RE, "")) || EMOJI_PARTS_RE.test(text) || OTHER_SCRIPT_RE.test(text)) return { ok: false, reason: "unsupported_characters" };
	return { ok: true, value: text };
}

// An invitee's name: one line of text, whitespace runs collapsed, invisible
// characters dropped. Required-ness is the route's call.
function normalizeName(value) {
	if (value === undefined || value === null) return { ok: true, value: "" };
	if (typeof value !== "string") return { ok: false, reason: "not_text" };
	if (value.length > LIMITS.NAME_MAX * 4) return { ok: false, reason: "too_long" };
	const text = value
		.replace(/[\t\n\v\f\r\p{Zl}\p{Zp}]/gu, " ")
		.replace(INVISIBLE_RE, "")
		.normalize("NFC")
		.split(/\s/)
		.filter(Boolean)
		.join(" ");
	if (text.length > LIMITS.NAME_MAX) return { ok: false, reason: "too_long" };
	return { ok: true, value: text };
}

function termsRefusal(field, reason) {
	return { ok: false, field, reason, message: MESSAGES[reason] };
}

// The admin form's three fields → the stored terms, or the first refusal.
function normalizeTermsInput({ paymentType, leaseAmount, details } = {}) {
	if (!PAYMENT_TYPES.includes(paymentType)) return termsRefusal("paymentType", "invalid_type");
	let leaseAmountCents = null;
	if (paymentType === "lease") {
		const amount = parseLeaseAmountToCents(leaseAmount);
		if (!amount.ok) return termsRefusal("leaseAmount", amount.reason);
		leaseAmountCents = amount.value;
	} else if (!isBlank(leaseAmount)) {
		return termsRefusal("leaseAmount", "amount_not_allowed");
	}
	const d = normalizeDetails(details);
	if (!d.ok) return termsRefusal("details", d.reason);
	return { ok: true, value: { type: paymentType, leaseAmountCents, details: d.value } };
}

// ── stored terms ────────────────────────────────────────────────────────────
function invalidTerms(why) {
	const e = new Error(`Payment terms are invalid: ${why}.`);
	e.code = "PAYMENT_TERMS_INVALID";
	return e;
}

function checkTermsShape(t) {
	if (!t || typeof t !== "object") throw invalidTerms("not an object");
	if (!PAYMENT_TYPES.includes(t.type)) throw invalidTerms("unknown payment type");
	if (t.type === "lease") {
		if (!Number.isSafeInteger(t.leaseAmountCents) || t.leaseAmountCents < LIMITS.LEASE_MIN_CENTS || t.leaseAmountCents > LIMITS.LEASE_MAX_CENTS) {
			throw invalidTerms("the lease amount is missing or out of range");
		}
	} else if (t.leaseAmountCents !== null && t.leaseAmountCents !== undefined) {
		throw invalidTerms("a split carries no lease amount");
	}
	const details = t.details === undefined || t.details === null ? "" : t.details;
	if (typeof details !== "string" || details.length > LIMITS.DETAILS_MAX) throw invalidTerms("the additional terms are not bounded text");
	return details;
}

// The terms a contract is rendered with. A split with no additional terms IS
// the standard contract: null, with no amendment block and no snapshot.
function effectiveTerms(terms) {
	if (terms === null || terms === undefined) return null;
	const details = checkTermsShape(terms);
	if (terms.type === "split" && !details) return null;
	return { type: terms.type, leaseAmountCents: terms.type === "lease" ? terms.leaseAmountCents : null, details };
}

// An investor_invites row's terms, as stored (a standard split included).
function termsFromInviteRow(row) {
	if (!row) return null;
	const terms = {
		type: row.payment_type,
		leaseAmountCents: row.lease_amount_cents === undefined ? null : row.lease_amount_cents,
		details: row.amendment_details || "",
	};
	checkTermsShape(terms);
	return terms;
}

// "$2,000.00" — grouping done by hand so no locale can change it.
function formatMoneyCents(cents) {
	if (!Number.isSafeInteger(cents) || cents < 0) return "";
	const digits = String(Math.floor(cents / 100));
	let grouped = "";
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) grouped += ",";
		grouped += digits[i];
	}
	return `$${grouped}.${String(cents % 100).padStart(2, "0")}`;
}

function describeTerms(terms) {
	const t = effectiveTerms(terms);
	if (!t) return { typeLabel: TYPE_LABELS.split, amountLabel: "", summary: STANDARD_SUMMARY };
	const amountLabel = t.type === "lease" ? `${formatMoneyCents(t.leaseAmountCents)} per month` : "";
	const parts = [TYPE_LABELS[t.type]];
	if (amountLabel) parts.push(amountLabel);
	if (t.details) parts.push("with additional terms");
	return { typeLabel: TYPE_LABELS[t.type], amountLabel, summary: parts.join(" — ") };
}

// ── snapshots ───────────────────────────────────────────────────────────────
// What an investor signed, frozen on the master and lease document rows at
// submission. Regeneration reads this, never the invite row.
const SNAPSHOT_MAX = 16384;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function snapshotJson(terms, { inviteId, termsRevision, capturedAt }) {
	const t = effectiveTerms(terms);
	if (!t) return null;
	return JSON.stringify({
		v: 1, type: t.type, leaseAmountCents: t.leaseAmountCents, details: t.details,
		inviteId, termsRevision, capturedAt,
	});
}

function snapshotInvalid(why) {
	const e = new Error(`The stored payment terms snapshot is invalid: ${why}.`);
	e.code = "PAYMENT_TERMS_SNAPSHOT_INVALID";
	return e;
}

// NULL (or "") → null, the standard contract. Anything else must be a v1
// snapshot this module could have written, or it throws.
function parseSnapshot(raw) {
	if (raw === null || raw === undefined || raw === "") return null;
	if (typeof raw !== "string" || raw.length > SNAPSHOT_MAX) throw snapshotInvalid("not a bounded string");
	let o;
	try { o = JSON.parse(raw); } catch { throw snapshotInvalid("not JSON"); }
	if (!o || typeof o !== "object" || Array.isArray(o)) throw snapshotInvalid("not an object");
	if (o.v !== 1) throw snapshotInvalid("unknown version");
	let terms;
	try {
		terms = effectiveTerms({ type: o.type, leaseAmountCents: o.leaseAmountCents, details: o.details });
	} catch (e) {
		throw snapshotInvalid(e.message);
	}
	if (!terms) throw snapshotInvalid("the standard contract is stored as NULL");
	if (o.type === "split" && o.leaseAmountCents !== null) throw snapshotInvalid("a split carries no lease amount");
	const d = normalizeDetails(o.details);
	if (!d.ok || d.value !== o.details) throw snapshotInvalid("the additional terms are not in stored form");
	if (!Number.isSafeInteger(o.inviteId) || o.inviteId < 1) throw snapshotInvalid("no invitation id");
	if (!Number.isSafeInteger(o.termsRevision) || o.termsRevision < 1) throw snapshotInvalid("no terms revision");
	if (typeof o.capturedAt !== "string" || !ISO_Z_RE.test(o.capturedAt)) throw snapshotInvalid("no capture time");
	return { ...terms, inviteId: o.inviteId, termsRevision: o.termsRevision, capturedAt: o.capturedAt };
}

// ── templates ───────────────────────────────────────────────────────────────
// Markers are whole lines:
//   <!-- payment-terms:slot NAME -->
//     default lines
//   <template data-payment-terms="lease">
//     variant lines
//   </template>
//   <!-- /payment-terms:slot -->
// Every marker line is removed from the output, so the standard render is the
// template's original bytes exactly (scripts/test-payment-terms-template.js
// pins both hashes).
const SLOT_OPEN_RE = /^[ \t]{0,16}<!-- payment-terms:slot ([a-z0-9.]{1,40}) -->$/;
const SLOT_CLOSE_RE = /^[ \t]{0,16}<!-- \/payment-terms:slot -->$/;
const VARIANT_OPEN_RE = /^[ \t]{0,16}<template data-payment-terms="([a-z]{1,16})">$/;
const VARIANT_CLOSE_RE = /^[ \t]{0,16}<\/template>$/;

function templateInvalid(docKey, why) {
	const e = new Error(`The "${docKey}" template's payment terms markers are invalid: ${why}.`);
	e.code = "PAYMENT_TERMS_TEMPLATE_INVALID";
	return e;
}

function applyPaymentTermsToHtml(html, docKey, terms) {
	if (typeof html !== "string") throw templateInvalid(docKey, "the template is not text");
	const t = effectiveTerms(terms);
	const slots = Object.prototype.hasOwnProperty.call(TEMPLATE_SLOTS, docKey) ? TEMPLATE_SLOTS[docKey] : null;
	if (!slots) {
		if (t) throw templateInvalid(docKey, "this document carries no payment terms");
		if (html.includes("payment-terms")) throw templateInvalid(docKey, "a marker in a document that carries no payment terms");
		return html;
	}
	const out = [];
	const seen = new Set();
	let slot = null;
	const lines = html.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const at = `line ${i + 1}`;
		let m = SLOT_OPEN_RE.exec(line);
		if (m) {
			if (slot) throw templateInvalid(docKey, `${at}: slot "${m[1]}" opens inside slot "${slot.name}"`);
			if (!Object.prototype.hasOwnProperty.call(slots, m[1])) throw templateInvalid(docKey, `${at}: unknown slot "${m[1]}"`);
			if (seen.has(m[1])) throw templateInvalid(docKey, `${at}: duplicate slot "${m[1]}"`);
			seen.add(m[1]);
			slot = { name: m[1], defaults: [], variants: new Map(), current: null };
			continue;
		}
		if (SLOT_CLOSE_RE.test(line)) {
			if (!slot) throw templateInvalid(docKey, `${at}: a slot closes that never opened`);
			if (slot.current) throw templateInvalid(docKey, `${at}: variant "${slot.current}" of slot "${slot.name}" is not closed`);
			for (const v of slots[slot.name]) {
				if (!slot.variants.has(v)) throw templateInvalid(docKey, `${at}: slot "${slot.name}" has no "${v}" variant`);
			}
			out.push(...(t && slot.variants.has(t.type) ? slot.variants.get(t.type) : slot.defaults));
			slot = null;
			continue;
		}
		m = VARIANT_OPEN_RE.exec(line);
		if (m) {
			if (!slot) throw templateInvalid(docKey, `${at}: a variant outside any slot`);
			if (slot.current) throw templateInvalid(docKey, `${at}: a variant opens inside variant "${slot.current}"`);
			if (!PAYMENT_TYPES.includes(m[1])) throw templateInvalid(docKey, `${at}: unknown variant "${m[1]}"`);
			if (slot.variants.has(m[1])) throw templateInvalid(docKey, `${at}: duplicate variant "${m[1]}" in slot "${slot.name}"`);
			slot.current = m[1];
			slot.variants.set(m[1], []);
			continue;
		}
		if (slot && slot.current && VARIANT_CLOSE_RE.test(line)) {
			slot.current = null;
			continue;
		}
		if (line.includes("payment-terms")) throw templateInvalid(docKey, `${at}: a stray marker`);
		if (slot && /<\/?template/i.test(line)) throw templateInvalid(docKey, `${at}: a stray template tag inside slot "${slot.name}"`);
		if (!slot) out.push(line);
		else if (slot.current) slot.variants.get(slot.current).push(line);
		else slot.defaults.push(line);
	}
	if (slot) throw templateInvalid(docKey, `slot "${slot.name}" is never closed`);
	for (const name of Object.keys(slots)) {
		if (!seen.has(name)) throw templateInvalid(docKey, `slot "${name}" is missing`);
	}
	return out.join("\n");
}

// The aria-label → value pairs a terms render fills. {} for the standard
// contract, which asks for none of them.
function renderFieldsFor(docKey, terms) {
	const t = effectiveTerms(terms);
	if (!t) return {};
	if (!TERMS_DOC_KEYS.includes(docKey)) throw templateInvalid(docKey, "this document carries no payment terms");
	const text = {
		[FIELD_LABELS.type]: TYPE_LABELS[t.type],
		[FIELD_LABELS.details]: t.details || "None",
	};
	if (t.type === "lease") text[FIELD_LABELS.amount] = formatMoneyCents(t.leaseAmountCents);
	return text;
}

module.exports = {
	PAYMENT_TYPES,
	LIMITS,
	TERMS_DOC_KEYS,
	FIELD_LABELS,
	TYPE_LABELS,
	STANDARD_SUMMARY,
	MESSAGES,
	TEMPLATE_SLOTS,
	INVITE_TOKEN_RE,
	newInviteToken,
	hashInviteToken,
	normalizeTermsInput,
	parseLeaseAmountToCents,
	normalizeDetails,
	normalizeName,
	effectiveTerms,
	formatMoneyCents,
	describeTerms,
	termsFromInviteRow,
	snapshotJson,
	parseSnapshot,
	applyPaymentTermsToHtml,
	renderFieldsFor,
};
