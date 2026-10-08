#!/usr/bin/env node
/**
 * Tests for the EDITABLE INVOICE EMAIL MESSAGE — the `emailBody` override that
 * POST /api/loads/:loadId/draft-invoice (?dryRun=1 and the approve) and
 * POST /api/loads/:loadId/invoice-preview accept, and the email builders in
 * lib/broker-invoice.js. (Notes, the Subject and the invoice PDF are
 * scripts/test-invoice-notes.js; the other overrides are
 * scripts/test-invoice-overrides.js.)
 *
 *   §1 PARSING. parseInvoiceOverrides(): an omitted or null emailBody means "the
 *      generated message"; anything but a string is 400
 *      INVOICE_EMAIL_BODY_INVALID; a raw body over 10,000 UTF-16 units is 400
 *      INVOICE_EMAIL_BODY_TOO_LONG before any clean-up; the clean-up is the one
 *      sanitizeInvoiceNotes() (CRLF/CR → \n, control/BIDI → space, format
 *      characters deleted, NFC, trim); over 5,000 code points is TOO_LONG, and
 *      nothing left is 400 INVOICE_EMAIL_BODY_EMPTY.
 *   §2 THE GENERATED TEXT. buildInvoiceEmailBodyText() is exactly the visible
 *      text of the default email, for every sentence shape.
 *   §3 THE DEFAULT EMAIL IS UNCHANGED — golden sha256 captured before the
 *      message was editable, for no bodyText, a null or non-string one, and one
 *      identical to the generated text.
 *   §4 THE EDITED EMAIL. Exact HTML: one <br> per line break, &nbsp; wherever
 *      HTML would collapse or drop a typed space, esc() on every character, the
 *      signature byte-identical after it; then a seeded corpus, checked for a
 *      lossless round trip and for spaces a browser would collapse.
 *   §5 THE ROUTES, RUN. Both registrations are lifted from server.js and run
 *      with stubbed Sheets, Drive, Chromium and Gmail over an in-memory SQLite:
 *      the dryRun and the preview answer emailBodyDefault + emailSignatureHtml,
 *      and a Bison dryRun with no readable Order # builds the message with
 *      that Order # blank; the approve hands the edited HTML to
 *      appendGmailDraft, audits "emailBody: edited (N chars)" and never the
 *      text, and keeps the text out of overrides_json; the n8n fallback, whose
 *      draft carries the generated message, warns and audits an edit as not
 *      applied; each 400 answers before any spend.
 *   §6 MUTANTS. Each guard above is broken in turn, and an assertion must flip.
 *
 * WHY server.js IS READ AS TEXT: it opens SQLite, reads a service-account key
 * and starts listening on import — the reason given in
 * test-invoice-overrides.js. Every extraction asserts its needle is found
 * exactly once, so a rename fails loudly instead of testing nothing.
 *
 * Plain node, no server, no network, no Gmail, never touches app.db.
 * Run: node scripts/test-invoice-email-body.js
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "broker-invoice.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const brokerInvoice = require(LIB_PATH);

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// Characters that must never be typed literally into this file — built from
// their code points so no editor or tool can drop or mangle them.
const cp = (...codes) => String.fromCodePoint(...codes);
const TAB = cp(0x09);
const NBSP = cp(0xa0); // NO-BREAK SPACE: printable, kept as typed
const SHY = cp(0xad); // SOFT HYPHEN (Cf, deleted)
const ZWSP = cp(0x200b); // ZERO WIDTH SPACE (EVIDENCE_TEXT_STRIP → space)
const RLO = cp(0x202e); // RIGHT-TO-LEFT OVERRIDE (BIDI → space)
const LS = cp(0x2028); // LINE SEPARATOR (→ space: not a line break here)
const WJ = cp(0x2060); // WORD JOINER (Cf, deleted)
const E_ACUTE = cp(0xe9);
const E_ACUTE_DECOMPOSED = "e" + cp(0x301); // one character after NFC
const QA = cp(0x958); // DEVANAGARI QA: NFC turns it into TWO code points
const TRUCK = cp(0x1f69a); // astral: two UTF-16 units, one code point

// ---------------------------------------------------------------- extraction
function countOf(hay, needle) { return hay.split(needle).length - 1; }
function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	let depth = 0;
	for (let j = src.indexOf("{", start); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 declaration of ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	return src.slice(start, src.indexOf("\n", start));
}
// A route registration by line range: its `app.post(` line to the `);` that
// closes it at column 0.
function extractRouteByLines(src, needle) {
	const lines = src.split("\n");
	const hits = lines.filter((l) => l.includes(needle)).length;
	if (hits !== 1) throw new Error(`expected exactly 1 line containing ${needle}, found ${hits}`);
	let s = lines.findIndex((l) => l.includes(needle));
	while (s > 0 && !/^app\.(post|get|put|delete)\(/.test(lines[s])) s--;
	let e = s;
	while (e < lines.length && lines[e] !== ");") e++;
	if (e >= lines.length) throw new Error(`unterminated route registration for ${needle}`);
	return lines.slice(s, e + 1).join("\n");
}
function mutate(src, from, to, label) {
	if (countOf(src, from) !== 1) throw new Error(`mutant ${label}: expected exactly one site to mutate`);
	return src.replace(from, to);
}
function loadLib(text) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", "__dirname", "__filename", text)(mod, mod.exports, require, path.dirname(LIB_PATH), LIB_PATH);
	return mod.exports;
}

// parseInvoiceOverrides() and everything it reaches, lifted — never retyped.
const CONSTS = [
	"EVIDENCE_TEXT_STRIP", "INVOICE_TOTAL_FORMAT_RE", "INVOICE_TOTAL_MAX", "INVOICE_TOTAL_MIN", "INVOICE_ID_RE",
	"INVOICE_REF_RE", "INVOICE_ORDER_RE", "INVOICE_FIELD_SCAN_MAX", "INVOICE_NOTES_MAX", "INVOICE_NOTES_SCAN_MAX",
	"INVOICE_EMAIL_BODY_MAX", "INVOICE_EMAIL_BODY_SCAN_MAX", "INVOICE_YEAR_MIN", "INVOICE_YEAR_MAX",
];
const FNS = ["sanitizeEvidenceText", "sanitizeInvoiceNotes", "isoToMdy", "mdyToIso", "isRealCalendarDate", "safeAttachmentName", "parseInvoiceOverrides"];
function loadShipped(src) {
	const body =
		CONSTS.map((c) => extractConst(src, c)).join("\n") + "\n" +
		FNS.map((f) => extractFn(src, f)).join("\n") +
		`\nreturn { ${FNS.join(", ")}, ${CONSTS.join(", ")} };`;
	return new Function("brokerInvoice", body)(brokerInvoice);
}
const M = loadShipped(SRC);

// ------------------------------------------------------------------ fixtures
// One per sentence shape of the generated message, two carrying every
// character esc() changes, and {}. The golden hashes in §3 were captured from
// exactly these objects.
const FIXTURES = Object.freeze({
	nonBison: { isBison: false, brokerName: "Acme Freight", loadNumber: "563367203", orderNumber: "563367203", moveNumber: "", poNumber: "" },
	bisonMovePo: { isBison: true, brokerName: "Bison Transport", loadNumber: "30080873", orderNumber: "7101850-$700 ADV", moveNumber: "88231", poNumber: "4471" },
	bisonMoveOnly: { isBison: true, brokerName: "Bison Transport", loadNumber: "30080873", orderNumber: "7101850", moveNumber: "88231", poNumber: "" },
	bisonPoOnly: { isBison: true, brokerName: "Bison Transport", loadNumber: "30080873", orderNumber: "7101850", moveNumber: "", poNumber: "4471" },
	bisonNeither: { isBison: true, brokerName: "", loadNumber: "30080873", orderNumber: "7101850", moveNumber: "", poNumber: "" },
	nonBisonEscapes: { isBison: false, brokerName: "O'Neil & <Sons>", loadNumber: "", orderNumber: "A&B \"q\" <x> 'y'", moveNumber: "", poNumber: "" },
	bisonEscapes: { isBison: true, brokerName: "O'Neil & <Sons>", loadNumber: "L1", orderNumber: "7101850 & 'fee'", moveNumber: "M<1>", poNumber: "P\"2\"" },
	empty: {},
});
const NON_BISON_TEXT =
	"Hello,\n\nPlease see the attached documents for load number 563367203: the rate confirmation, the signed POD, and the invoice." +
	"\n\nPlease contact us if there is any issue.\n\nThank you,";
const BISON_MOVE_PO_TEXT =
	"Hello,\n\nPlease find the attached invoice and supporting documentation for Bison Transport Order # 7101850-$700 ADV." +
	" The driver ID number for pickup is 88231 & PO #4471\n\nBest regards,";

// The email around the message: fixed bytes before it, the signature after it.
const OPEN = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000">';
const SIG = brokerInvoice.buildInvoiceEmailSignatureHtml();
const CLOSE = SIG + "</div>";
function messageOf(html) {
	if (typeof html !== "string" || !html.startsWith(OPEN) || !html.endsWith(CLOSE)) return null;
	return html.slice(OPEN.length, html.length - CLOSE.length);
}
// What a reader sees in a message: each <p> a paragraph (a blank line between
// two), each <br> a line break, every entity decoded ONCE. &nbsp; stands for a
// typed space; a typed U+00A0 stays U+00A0. A raw line break or tab in HTML
// source is only whitespace, so it reads as a space — never as a line break.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, n) => ENTITIES[n]);
function visibleText(message) {
	return message.slice(3, -4).replace(/[\r\n\t]/g, " ").split("</p><p>").map((p) => decode(p.split("<br>").join("\n"))).join("\n\n");
}

// ================================================================ §1 PARSING
function parsingSection() {
	section("1. parseInvoiceOverrides — the emailBody override");
	const TOO_LONG_MSG = "The email message must be 5,000 characters or fewer.";
	const EMPTY_MSG = "The email message can't be empty.";
	const refusal = (code, error) => ({ ok: false, code, field: "emailBody", error });
	const verdict = (body) => {
		const r = M.parseInvoiceOverrides(body);
		return r.ok ? { ok: true, value: r.values.emailBody } : { ok: false, code: r.code, field: r.field, error: r.error };
	};

	eq([M.INVOICE_EMAIL_BODY_MAX, M.INVOICE_EMAIL_BODY_SCAN_MAX], [5000, 10000], "§1 the limits: 5,000 code points stored, 10,000 raw");
	for (const [label, body] of [["omitted", {}], ["undefined", { emailBody: undefined }], ["null", { emailBody: null }]]) {
		const r = M.parseInvoiceOverrides(body);
		eq([r.ok, r.has.emailBody, r.values.emailBody], [true, undefined, undefined], `§1 ${label} → no override (the generated message is sent)`);
	}
	for (const v of [12345, 0, false, true, ["Hello"], { text: "Hello" }]) {
		eq(verdict({ emailBody: v }), refusal("INVOICE_EMAIL_BODY_INVALID", "The email message must be text."),
			`§1 ${JSON.stringify(v)} → 400 INVOICE_EMAIL_BODY_INVALID (refused, never coerced)`);
	}

	// The raw bound is judged BEFORE the clean-up: 10,001 spaces would clean to
	// nothing, and still answer TOO_LONG, not EMPTY.
	eq(verdict({ emailBody: " ".repeat(10001) }), refusal("INVOICE_EMAIL_BODY_TOO_LONG", TOO_LONG_MSG),
		"§1 10,001 raw spaces → TOO_LONG, judged before the clean-up");
	eq(verdict({ emailBody: " ".repeat(10000) }).code, "INVOICE_EMAIL_BODY_EMPTY", "§1 …while 10,000 pass that gate and are EMPTY after it");
	eq(verdict({ emailBody: "a".repeat(10001) }), refusal("INVOICE_EMAIL_BODY_TOO_LONG", TOO_LONG_MSG), "§1 10,001 raw characters → TOO_LONG");
	eq(verdict({ emailBody: "a".repeat(5000) }), { ok: true, value: "a".repeat(5000) }, "§1 exactly 5,000 characters are accepted");
	eq(verdict({ emailBody: "a".repeat(5001) }), refusal("INVOICE_EMAIL_BODY_TOO_LONG", TOO_LONG_MSG), "§1 5,001 → TOO_LONG, never cut to 5,000");
	eq(verdict({ emailBody: TRUCK.repeat(5000) }).ok, true,
		"§1 5,000 astral characters — 10,000 UTF-16 units, exactly the raw bound — are 5,000 code points → accepted");
	eq(verdict({ emailBody: TRUCK.repeat(5001) }).code, "INVOICE_EMAIL_BODY_TOO_LONG", "§1 …5,001 of them (10,002 units) → TOO_LONG");
	eq(verdict({ emailBody: E_ACUTE_DECOMPOSED.repeat(5000) }), { ok: true, value: E_ACUTE.repeat(5000) },
		"§1 NFC first: 10,000 raw units of decomposed accents (the raw bound) are 5,000 characters → accepted, stored composed");
	eq(verdict({ emailBody: "abc\r\n".repeat(1250) }).ok, true,
		"§1 a message typed with CRLFs — 6,250 raw units, 4,999 characters once cleaned — is accepted: the raw bound leaves room for the clean-up");
	eq(verdict({ emailBody: QA.repeat(2500) }).ok, true, "§1 2,500 × U+0958 (5,000 after NFC) → accepted");
	eq(verdict({ emailBody: QA.repeat(2501) }).code, "INVOICE_EMAIL_BODY_TOO_LONG", "§1 2,501 × U+0958 (5,002 after NFC) → TOO_LONG — counted as stored");

	for (const [label, v] of [
		['""', ""], ["spaces", "   "], ["blank lines", "\n\n\r\n"], ["a tab", TAB], ["a zero-width space", ZWSP],
		["a soft hyphen + a word joiner", SHY + WJ], ["a BIDI override", RLO],
	]) {
		eq(verdict({ emailBody: v }), refusal("INVOICE_EMAIL_BODY_EMPTY", EMPTY_MSG), `§1 ${label} → 400 INVOICE_EMAIL_BODY_EMPTY`);
	}

	const clean = (v) => verdict({ emailBody: v }).value;
	eq(clean("Hello,\r\n\r\nLine one\rLine two"), "Hello,\n\nLine one\nLine two", "§1 CRLF and a lone CR become \\n");
	eq(clean("a" + RLO + "b"), "a b", "§1 a BIDI override becomes a space");
	eq(clean("in" + WJ + "voice" + SHY + "d"), "invoiced", "§1 format characters (word joiner, soft hyphen) are deleted, not spaced");
	eq(clean("a" + TAB + "b"), "a b", "§1 a tab becomes a space");
	eq(clean("a" + LS + "b"), "a b", "§1 U+2028 is a space, not a line break — only \\n breaks a line");
	eq(clean("Caf" + E_ACUTE_DECOMPOSED), "Caf" + E_ACUTE, "§1 NFC");
	eq(clean("\n\n  Hello,\n\n    indented\n  "), "Hello,\n\n    indented", "§1 the message is trimmed; inner blank lines and indentation stay");
	eq(clean("<b>x</b> & \"y\""), "<b>x</b> & \"y\"", "§1 markup is stored as typed — escaping is the renderer's job");
	eq(clean("a" + NBSP + "b"), "a" + NBSP + "b", "§1 a no-break space is printable and kept");

	const refused = M.parseInvoiceOverrides({ emailBody: 5 });
	ok(Object.getPrototypeOf(refused.has) === null && Object.getPrototypeOf(refused.values) === null &&
		!Object.keys(refused.has).length && !Object.keys(refused.values).length,
	"§1 a refusal carries empty null-prototype has/values");
	try {
		Object.prototype.emailBody = "POLLUTED";
		const p = M.parseInvoiceOverrides({});
		eq([p.ok, p.has.emailBody, p.values.emailBody], [true, undefined, undefined], "§1 a polluted Object.prototype.emailBody is not an override");
	} finally {
		delete Object.prototype.emailBody;
	}
	const both = M.parseInvoiceOverrides({ emailBody: "Hi", notes: "n", total: "10" });
	eq([both.ok, both.values.emailBody, both.values.notes, both.values.total], [true, "Hi", "n", 10],
		"§1 emailBody sits beside the other overrides without disturbing them");

	eq(countOf(SRC, "\nfunction sanitizeInvoiceNotes("), 1, "§1 one sanitizeInvoiceNotes() in server.js — no second copy for the email");
	eq(countOf(extractFn(SRC, "parseInvoiceOverrides"), "sanitizeInvoiceNotes(src.emailBody, INVOICE_EMAIL_BODY_SCAN_MAX)"), 1,
		"§1 …and the emailBody branch cleans with it");
}

// ======================================================= §2 GENERATED TEXT
function generatedTextSection() {
	section("2. buildInvoiceEmailBodyText — the generated message as plain text");
	const text = brokerInvoice.buildInvoiceEmailBodyText;
	eq(text(FIXTURES.nonBison), NON_BISON_TEXT, "§2 non-Bison: the exact text");
	eq(text(FIXTURES.bisonMovePo), BISON_MOVE_PO_TEXT, "§2 Bison with Move # + PO #: the exact text (& decoded, no full stop, as ever)");
	ok(text(FIXTURES.bisonEscapes).includes("O'Neil & <Sons> Order # 7101850 & 'fee'. The driver ID number for pickup is M<1> & PO #P\"2\""),
		"§2 raw values — nothing escaped in the text");
	eq(typeof text(), "string", "§2 no fields → still a string");
	for (const [name, fields] of Object.entries(FIXTURES)) {
		const message = messageOf(brokerInvoice.buildInvoiceEmailHtml(fields));
		ok(message !== null && /^<p>[\s\S]*<\/p>$/.test(message), `§2 ${name}: the default email is OPEN + <p> paragraphs + signature`);
		if (message === null) continue;
		ok(!/<(?!\/?p>)/.test(message), `§2 ${name}: the default message is plain <p> paragraphs, no other markup`);
		eq(text(fields), visibleText(message), `§2 ${name}: the text is exactly what the default email shows`);
	}
}

// =================================================== §3 THE DEFAULT EMAIL
function defaultEmailSection() {
	section("3. buildInvoiceEmailHtml — the default email is byte-identical to before");
	// ⚠️ THE GOLDEN HASHES, captured from lib/broker-invoice.js at 61406a1 — the
	// builder BEFORE the message was editable — from FIXTURES above. The refactor
	// moved the wording into invoiceEmailParagraphs() and esc()s whole
	// paragraphs, which is byte-identical only because esc() maps one character
	// at a time; these hashes are what prove it, for every sentence shape.
	//
	// TO UPDATE when the email wording changes ON PURPOSE: confirm it is meant
	// to reach every invoice email from then on, run this file, paste the
	// "actual" hash each GOLDEN failure prints, and say why in the commit.
	const GOLDEN = {
		nonBison: "cb46b760986798f0eea2d23cc0d0f1a99bce1d5c0af4f4c09dd13f32a14c7979",
		bisonMovePo: "abcf17d397a9e0430630cdbf182ddf55bdaec5565aa7be9e3dd8734f0f9d42be",
		bisonMoveOnly: "a0c84195a8bc8f57ce2cedfe10d0dd83458c827ccd9d47b3fd7b862d84c6a5ab",
		bisonPoOnly: "0827a1507c7aa6f298f4889d988c9336368590b769336186cb658ae75086e5c0",
		bisonNeither: "83d0314ea2a44a09c4e759185c40f41e1d0ddc3f115f7318d5e417af06ac9595",
		nonBisonEscapes: "8c154bf69725eb22363bf007c9bc5eb338ac6bacafe0ce58548c961acdfc4417",
		bisonEscapes: "c0b89b47e523e367c9da2384a01e46e7a9fc1b006133987d58927c18d85b4c03",
		empty: "694c9f5cfdbd71300fc7d7d7bc243795be31ce7a2b2719a88b50c202189f69ec",
	};
	eq(Object.keys(GOLDEN), Object.keys(FIXTURES), "§3 (control) every fixture has a golden hash");
	for (const [name, fields] of Object.entries(FIXTURES)) {
		const build = (extra) => sha256(brokerInvoice.buildInvoiceEmailHtml({ ...fields, ...extra }));
		eq(build({}), GOLDEN[name], `§3 GOLDEN ${name}: no bodyText`);
		for (const [label, bodyText] of [["undefined", undefined], ["null", null], ["a number", 42], ["an array", ["x"]]]) {
			eq(build({ bodyText }), GOLDEN[name], `§3 GOLDEN ${name}: bodyText ${label} is ignored`);
		}
		// An unchanged message is not an edit: the generated text sent back
		// renders the generated email, so an editor that always sends its box
		// changes nothing until somebody types.
		eq(build({ bodyText: brokerInvoice.buildInvoiceEmailBodyText(fields) }), GOLDEN[name],
			`§3 GOLDEN ${name}: bodyText identical to the generated text renders the same bytes`);
		ok(brokerInvoice.buildInvoiceEmailHtml(fields).endsWith(CLOSE), `§3 ${name}: the email ends with emailSignatureHtml + </div>`);
	}
}

// ==================================================== §4 THE EDITED EMAIL
function mulberry32(seed) {
	return () => {
		seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
// The properties a message's HTML must have to read exactly as typed: it
// decodes back to the text; its line breaks are <br>, not raw whitespace; no
// typed space sits where a browser collapses or drops one (line start, line
// end, beside another ordinary space); and its only markup is <p> + <br>,
// every other < > & escaped. Empty array = all hold.
function editedProblems(lib, text) {
	const message = messageOf(lib.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: text }));
	if (message === null || !message.startsWith("<p>") || !message.endsWith("</p>")) return ["not OPEN + <p>…</p> + signature"];
	const out = [];
	if (visibleText(message) !== text) out.push("round trip");
	const inner = message.slice(3, -4);
	if (/[\r\n\t]/.test(inner)) out.push("raw whitespace");
	if (inner.split("<br>").some((line) => line.startsWith(" ") || line.endsWith(" ") || line.includes("  "))) out.push("collapsible space");
	const bare = inner.split("<br>").join("");
	if (/[<>]/.test(bare) || /&(?!(amp|lt|gt|quot|#39|nbsp);)/.test(bare)) out.push("unescaped markup");
	return out;
}

function editedEmailSection() {
	section("4. buildInvoiceEmailHtml — an edited message, exactly as typed");
	const TYPED = [
		"Hi team,",
		"",
		"Invoice for load 563367203 attached.",
		"  Indented line",
		"Two  spaces and   three.",
		"",
		"",
		"Thanks & regards,",
		"<script>alert('x')</script> \"q\"",
	].join("\n");
	const EXPECTED_MESSAGE = "<p>" + [
		"Hi team,",
		"",
		"Invoice for load 563367203 attached.",
		"&nbsp;&nbsp;Indented line",
		"Two&nbsp; spaces and&nbsp;&nbsp; three.",
		"",
		"",
		"Thanks &amp; regards,",
		"&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &quot;q&quot;",
	].join("<br>") + "</p>";
	const html = brokerInvoice.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: TYPED });
	eq(html, OPEN + EXPECTED_MESSAGE + CLOSE, "§4 the whole email, byte for byte: OPEN + the typed message + the unchanged signature");
	ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), "§4 a typed <script> is escaped");
	ok(html.includes("Thanks &amp; regards,"), "§4 a typed & is escaped");
	eq(countOf(html, "<br>") - countOf(SIG, "<br>"), countOf(TYPED, "\n"), "§4 one <br> per typed line break");
	ok(html.includes("<br><br><br>Thanks"), "§4 two blank lines stay two empty lines");
	ok(!html.includes("Please see the attached documents"), "§4 the generated message is replaced, not appended to");
	eq([countOf(html, SIG), countOf(html, 'src="https://app.logisx.com/logo.avif"'), countOf(html, "CONFIDENTIALITY/PRIVILEGE")], [1, 1, 1],
		"§4 the signature, the logo and the confidentiality notice appear once each, after the message");
	ok(!/white-space/i.test(html), "§4 no white-space CSS — <br> and &nbsp; carry the layout");
	eq(visibleText(messageOf(html)), TYPED, "§4 the email reads back as exactly the typed text");

	const messageFor = (t) => messageOf(brokerInvoice.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: t }));
	eq(messageFor(" x"), "<p>&nbsp;x</p>", "§4 a leading space is kept");
	eq(messageFor("x  "), "<p>x&nbsp;&nbsp;</p>", "§4 trailing spaces are kept");
	eq(messageFor("a\n   \nb"), "<p>a<br>&nbsp;&nbsp;&nbsp;<br>b</p>", "§4 a line of spaces keeps its width");
	eq(messageFor("a b"), "<p>a b</p>", "§4 a single inner space stays an ordinary space (the line can wrap there)");
	eq(messageFor("a" + NBSP + "b"), "<p>a" + NBSP + "b</p>", "§4 a typed no-break space is kept as the character");
	eq(messageFor(TRUCK + " load"), "<p>" + TRUCK + " load</p>", "§4 an astral character passes through");
	eq(messageFor("&nbsp; literal"), "<p>&amp;nbsp; literal</p>", "§4 typed entity text is escaped, not interpreted");
	eq(messageFor("x\n"), "<p>x<br></p>", "§4 every \\n is a <br>, a trailing one included (the route trims first)");

	const ALPHABET = ["a", "Z", "7", " ", " ", " ", "\n", "&", "<", ">", '"', "'", NBSP, TRUCK, E_ACUTE, "&nbsp;", "&amp;", "--"];
	const rand = mulberry32(20260930);
	const bad = [];
	let n = 0;
	for (; n < 3000; n++) {
		let t = "";
		const len = 1 + Math.floor(rand() * 40);
		for (let i = 0; i < len; i++) t += ALPHABET[Math.floor(rand() * ALPHABET.length)];
		const problems = editedProblems(brokerInvoice, t);
		if (problems.length) bad.push(`${JSON.stringify(t)}: ${problems.join(", ")}`);
	}
	eq(bad.slice(0, 3), [], `§4 ${n} seeded messages: lossless, no collapsible space, only <p>/<br> markup`);
}

// ================================================================ §5 ROUTES
const APPROVE_NEEDLE = '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],';
const PREVIEW_NEEDLE = '"/api/loads/:loadId/invoice-preview",';
const SHEET = [
	["Load ID", "Status", "Email", "Broker Contact Name", "Driver", "Trailer", "Delivery Date", "  Payment  "],
	["563367203", "Delivered", "dispatch@acmefreight.com", "Jane Agent", "Driver A", "", "09/28/2026", "3000"],
	["30080873", "Delivered", "dispatch@bisontransport.com", "Bob Agent", "Driver B", "", "09/27/2026", "2500"],
];
const INVOICE_ID = "09302026-1";
const GMAIL_ENV = Object.freeze({ GMAIL_USER: "invoices@example.com", GMAIL_APP_PASSWORD: "app-password" });
const N8N_ENV = Object.freeze({ N8N_INVOICE_WEBHOOK_URL: "https://n8n.example.invalid/webhook/invoice", N8N_WEBHOOK_SECRET: "test-secret" });

// Everything a route needs from server.js, lifted once per source text.
function liftRoutes(src) {
	const createAt = src.indexOf("CREATE TABLE IF NOT EXISTS load_invoice_drafts (");
	if (createAt < 0) throw new Error("no CREATE TABLE for load_invoice_drafts");
	return {
		approve: extractRouteByLines(src, APPROVE_NEEDLE),
		preview: extractRouteByLines(src, PREVIEW_NEEDLE),
		fns: Object.fromEntries(["parseSheet", "deduplicateLoads", "findCol", "latestDraftNotes", "invoiceIdAlreadyUsed"].map((n) => [n, extractFn(src, n)])),
		createSql: src.slice(createAt, src.indexOf("`", createAt)),
		alters: [...src.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]),
		shipped: loadShipped(src),
	};
}

// Both handlers over a fresh in-memory database. Sheets, Drive, Gemini,
// Chromium, Gmail and n8n are stubs that record what they were handed; the
// validator, the sheet parsing, the draft record and the email builders are
// the shipped code. `imapFails` makes the Gmail APPEND throw, so a configured
// n8n fallback takes over.
function harness(L, env = {}, { imapFails = false } = {}) {
	const db = new Database(":memory:");
	db.exec(L.createSql);
	for (const a of L.alters) db.exec(a);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, file_name TEXT, uploaded_at TEXT, deleted_at TEXT)");
	const addPod = db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, 'POD', ?, '2026-09-28T15:00:00Z')");
	for (const row of SHEET.slice(1)) addPod.run(row[0], `${row[0]}_POD.pdf`);

	const seen = { sheetReads: 0, renders: 0, drafts: [], posts: [], audits: [], errors: [] };
	const fn = (name, deps = {}) => new Function(...Object.keys(deps), `${L.fns[name]}\nreturn ${name};`)(...Object.values(deps));
	const S = L.shipped;
	const scope = {
		requireRole: () => () => {},
		refuseCrossSite: () => {},
		draftInvoiceLimiter: () => {},
		invoicePreviewLimiter: () => {},
		parseInvoiceOverrides: S.parseInvoiceOverrides,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => { seen.sheetReads++; return { data: { values: SHEET } }; } } } }),
		SPREADSHEET_ID: "sheet-under-test",
		parseSheet: fn("parseSheet"),
		deduplicateLoads: fn("deduplicateLoads"),
		findCol: fn("findCol"),
		brokerInvoice,
		db,
		fetchDocumentBytes: async () => Buffer.from("%PDF-1.4 pod"),
		buildRateConLoadCtx: () => ({}),
		getRateConBytes: async () => ({ buffer: null, candidates: [] }),
		GEMINI_API_KEY: "",
		runRateConGemini: async () => null,
		peekInvoiceNumber: () => INVOICE_ID,
		nextInvoiceNumber: () => INVOICE_ID,
		mdyToIso: S.mdyToIso,
		latestDraftNotes: fn("latestDraftNotes", { db }),
		invoiceIdAlreadyUsed: fn("invoiceIdAlreadyUsed", { db }),
		renderHtmlToPdf: async () => { seen.renders++; return Buffer.from("%PDF-1.4 invoice"); },
		safeAttachmentName: S.safeAttachmentName,
		logAudit: (req, action, entity, id, detail) => seen.audits.push({ action, detail }),
		sanitizeEvidenceText: S.sanitizeEvidenceText,
		appendGmailDraft: async (msg) => {
			if (imapFails) throw new Error("IMAP APPEND refused");
			seen.drafts.push(msg);
		},
		sentIfRendererBusy: () => false,
		REPLICA: null,
		process: { env: { ...env } },
		fetch: async (url, init) => {
			seen.posts.push({ url, payload: JSON.parse(init.body) });
			return { ok: true, status: 200, text: async () => '{"draftId":"n8n-1"}' };
		},
		console: { log() {}, warn() {}, error: (...a) => seen.errors.push(a.join(" ")) },
		INVOICE_PREVIEW_MAX_INFLIGHT: 2,
		invoicePreviewInflight: 0,
	};
	const handlerOf = (text) => {
		const registered = [];
		new Function("app", ...Object.keys(scope), text)({ post: (...args) => registered.push(args) }, ...Object.values(scope));
		if (registered.length !== 1) throw new Error(`expected 1 registration, got ${registered.length}`);
		return registered[0][registered[0].length - 1];
	};
	const call = async (handler, { loadId, query = {}, body = {} }) => {
		let out = null;
		const req = { params: { loadId }, query, body, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } }, ip: "127.0.0.1" };
		const res = {
			statusCode: 200,
			status(c) { this.statusCode = c; return this; },
			json(b) { out = { status: this.statusCode, body: b }; return this; },
		};
		await handler(req, res);
		// A 500 names its cause in the captured console.error — carried here so a
		// failure label says why, e.g. a stub this harness does not provide.
		return out ? { ...out, errors: seen.errors.slice() } : { status: 0, body: null, errors: seen.errors.slice() };
	};
	const approve = handlerOf(L.approve);
	const preview = handlerOf(L.preview);
	return {
		seen,
		db,
		approve: (opts) => call(approve, opts),
		dryRun: (opts) => call(approve, { ...opts, query: { dryRun: "1" } }),
		preview: (opts) => call(preview, opts),
		row: () => db.prepare("SELECT edited, edited_fields, overrides_json FROM load_invoice_drafts ORDER BY id DESC LIMIT 1").get(),
	};
}

// A message typed with Windows line endings, an inner run of spaces and an
// indented list — and what the server stores and mails for it.
const TYPED_ROUTE =
	"Hello Acme team,\r\n\r\nThe invoice for load 563367203 is attached  (two spaces kept).\r\n" +
	"  - rate con\r\n  - signed POD\r\n\r\nThank you,\r\nLogisX billing";
const TYPED_ROUTE_CLEAN = TYPED_ROUTE.split("\r\n").join("\n");
const TYPED_ROUTE_CHARS = Array.from(TYPED_ROUTE_CLEAN).length;
// The Bison load with no readable rate-con, as its dryRun builds the email:
// the Order # blank, no Move # or PO #.
const FIXTURES_BISON_NO_REFS = Object.freeze({ isBison: true, brokerName: "Bison Transport", loadNumber: "30080873", orderNumber: "", moveNumber: "", poNumber: "" });
const BISON_NO_REFS_TEXT = "Hello,\n\nPlease find the attached invoice and supporting documentation for Bison Transport Order # .\n\nBest regards,";
const NOT_APPLIED_WARNING =
	"Your edited email message was not applied: the draft was created by the fallback service, which uses the generated message.";
const editedNonBison = () => brokerInvoice.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: TYPED_ROUTE_CLEAN });
const defaultNonBison = () => brokerInvoice.buildInvoiceEmailHtml(FIXTURES.nonBison);

async function routesSection() {
	section("5. The routes, run — preview, dryRun, approve (IMAP and n8n)");
	const L = liftRoutes(SRC);
	const withErrors = (label, r) => (r && r.errors && r.errors.length ? `${label}  [server errors: ${r.errors.join(" | ")}]` : label);
	const EDITED = editedNonBison();
	const DEFAULT = defaultNonBison();
	ok(EDITED !== DEFAULT && EDITED.includes("&nbsp;&nbsp;- rate con") && EDITED.includes("attached&nbsp; (two"),
		"§5 (control) the edited email differs from the default and keeps the indentation and the inner run");

	// ── invoice-preview ──────────────────────────────────────────────────────
	const PREVIEW_BASE = { total: "3000", brokerName: "Acme Freight", orderNumber: "563367203", isBison: false };
	{
		const h = harness(L);
		const r = await h.preview({ loadId: "563367203", body: PREVIEW_BASE });
		eq(r.status, 200, withErrors("§5 preview, no emailBody → 200", r));
		const b = r.body || {};
		eq(b.emailBodyDefault, NON_BISON_TEXT, "§5 preview answers emailBodyDefault: the generated text for these fields");
		eq(b.emailSignatureHtml, SIG, "§5 preview answers emailSignatureHtml: the fixed signature");
		eq(b.emailHtml, DEFAULT, "§5 preview emailHtml with no emailBody is the default email, byte for byte");

		const e = await harness(L).preview({ loadId: "563367203", body: { ...PREVIEW_BASE, emailBody: TYPED_ROUTE } });
		eq((e.body || {}).emailHtml, EDITED, withErrors("§5 preview emailHtml is the edited email (CRLF cleaned, spaces kept)", e));
		eq((e.body || {}).emailBodyDefault, NON_BISON_TEXT, "§5 …while emailBodyDefault stays the generated text — it never echoes the edit");

		const same = await harness(L).preview({ loadId: "563367203", body: { ...PREVIEW_BASE, emailBody: NON_BISON_TEXT } });
		eq((same.body || {}).emailHtml, DEFAULT, "§5 preview: the generated text sent back unchanged renders the default email");

		const noted = await harness(L).preview({ loadId: "563367203", body: { ...PREVIEW_BASE, notes: "Advance $700" } });
		eq((noted.body || {}).emailHtml, DEFAULT, "§5 preview: a note never reaches the email (PDF only)");

		const bison = await harness(L).preview({
			loadId: "30080873",
			body: { total: "2500", brokerName: "Bison Transport", orderNumber: "7101850-$700 ADV", poNumber: "4471", moveNumber: "88231", isBison: true },
		});
		eq([(bison.body || {}).emailBodyDefault, (bison.body || {}).emailHtml],
			[BISON_MOVE_PO_TEXT, brokerInvoice.buildInvoiceEmailHtml(FIXTURES.bisonMovePo)],
			withErrors("§5 preview: emailBodyDefault and emailHtml follow the CURRENT fields (Bison, Move # + PO #)", bison));
	}

	// ── draft-invoice ?dryRun=1 ──────────────────────────────────────────────
	{
		const h = harness(L, GMAIL_ENV);
		const r = await h.dryRun({ loadId: "563367203" });
		eq(r.status, 200, withErrors("§5 dryRun, no emailBody → 200", r));
		const b = r.body || {};
		eq([b.dryRun, b.emailBodyDefault, b.emailSignatureHtml], [true, NON_BISON_TEXT, SIG],
			"§5 dryRun answers emailBodyDefault and emailSignatureHtml");
		eq(b.emailHtml, DEFAULT, "§5 dryRun emailHtml with no emailBody is the default email, byte for byte");

		const e = harness(L, GMAIL_ENV);
		const er = await e.dryRun({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
		eq([(er.body || {}).emailHtml, (er.body || {}).emailBodyDefault], [EDITED, NON_BISON_TEXT],
			withErrors("§5 dryRun: emailHtml is the edited email, emailBodyDefault the generated text", er));
		eq([e.seen.drafts.length, e.seen.audits.length, e.db.prepare("SELECT COUNT(*) AS n FROM load_invoice_drafts").get().n], [0, 0, 0],
			"§5 …and a dryRun still creates no draft, no audit row and no draft record");

		const bison = await harness(L, GMAIL_ENV).dryRun({
			loadId: "30080873", body: { orderNumber: "7101850-$700 ADV", poNumber: "4471", moveNumber: "88231" },
		});
		eq([(bison.body || {}).emailBodyDefault, (bison.body || {}).emailHtml],
			[BISON_MOVE_PO_TEXT, brokerInvoice.buildInvoiceEmailHtml(FIXTURES.bisonMovePo)],
			withErrors("§5 dryRun, Bison: the generated text and the default Bison email", bison));

		// A Bison load whose Order # could not be read: the message the editor
		// starts from carries the Order # BLANK, as the orderNumber seed does —
		// never our load id offered as Bison's Order #.
		const noRefs = await harness(L, GMAIL_ENV).dryRun({ loadId: "30080873" });
		const nb = noRefs.body || {};
		eq([noRefs.status, nb.needsOrderNumber, nb.orderNumber], [200, true, ""],
			withErrors("§5 dryRun, Bison with no readable Order #: needsOrderNumber, and the orderNumber seed is blank", noRefs));
		eq(nb.emailBodyDefault, BISON_NO_REFS_TEXT, "§5 …emailBodyDefault carries the Order # blank");
		eq(nb.emailHtml, brokerInvoice.buildInvoiceEmailHtml(FIXTURES_BISON_NO_REFS), "§5 …and so does emailHtml");
		ok(!String(nb.emailBodyDefault).includes("30080873") && !String(nb.emailHtml).includes("30080873"),
			"§5 …neither offers our load id as Bison's Order #");
		eq(nb.subject, "Bison Transport Order #30080873", "§5 …while the Subject still shows the fallback the banner warns about (unchanged)");
		const noRefsEdited = await harness(L, GMAIL_ENV).dryRun({ loadId: "30080873", body: { emailBody: TYPED_ROUTE } });
		eq((noRefsEdited.body || {}).emailHtml, brokerInvoice.buildInvoiceEmailHtml({ ...FIXTURES_BISON_NO_REFS, bodyText: TYPED_ROUTE_CLEAN }),
			"§5 …an edited message there is printed as typed");
		const refused = harness(L, GMAIL_ENV);
		const rr = await refused.approve({ loadId: "30080873" });
		eq([rr.status, (rr.body || {}).code, refused.seen.drafts.length], [422, "INVOICE_REFS_REQUIRED", 0],
			"§5 …and the approve still refuses until the refs are typed (unchanged)");
	}

	// ── the approve, IMAP ────────────────────────────────────────────────────
	const plain = harness(L, GMAIL_ENV);
	const pr = await plain.approve({ loadId: "563367203" });
	const d0 = plain.seen.drafts[0] || {};
	eq([pr.status, (pr.body || {}).via, plain.seen.drafts.length], [200, "imap", 1], withErrors("§5 approve, no emailBody → one IMAP draft", pr));
	eq(d0.html, DEFAULT, "§5 …carrying the default email, byte for byte");
	eq(plain.seen.audits.map((a) => a.action), ["invoice_draft_created"], "§5 …and no invoice_draft_edited row");
	eq(plain.row(), { edited: 0, edited_fields: "", overrides_json: "" }, "§5 …and an unedited draft record");

	const edited = harness(L, GMAIL_ENV);
	const er = await edited.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
	const d1 = edited.seen.drafts[0] || {};
	eq([er.status, (er.body || {}).via, edited.seen.drafts.length], [200, "imap", 1], withErrors("§5 approve with an edited message → one IMAP draft", er));
	eq(d1.html, EDITED, "§5 appendGmailDraft gets the edited email: the typed text, then the unchanged signature");
	eq((er.body || {}).warnings, [], "§5 …and the answer carries no warning: the edit was applied");
	eq(Object.keys(d1).sort(), Object.keys(d0).sort(), "§5 …the same draft fields as an unedited approve");
	eq([d1.from, d1.to, d1.subject], [d0.from, d0.to, d0.subject], "§5 …the same From, To and Subject");
	eq((d1.attachments || []).map((a) => [a.filename, a.contentType, a.content.length]),
		(d0.attachments || []).map((a) => [a.filename, a.contentType, a.content.length]), "§5 …and the same attachments");
	const editAudit = edited.seen.audits.find((a) => a.action === "invoice_draft_edited") || {};
	eq(editAudit.detail, `${INVOICE_ID} load 563367203 — emailBody: edited (${TYPED_ROUTE_CHARS} chars)`,
		"§5 the audit line says the message was edited, and its length");
	ok(!/Acme team|rate con|LogisX billing/.test(JSON.stringify(edited.seen.audits)), "§5 …and never carries the text");
	const row1 = edited.row() || {};
	eq([row1.edited, row1.edited_fields, row1.overrides_json], [1, "emailBody", "{}"],
		"§5 the draft record: edited, edited_fields names emailBody, overrides_json does not keep the text");

	const unchanged = harness(L, GMAIL_ENV);
	await unchanged.approve({ loadId: "563367203", body: { emailBody: NON_BISON_TEXT.split("\n").join("\r\n") } });
	eq([(unchanged.seen.drafts[0] || {}).html, unchanged.seen.audits.map((a) => a.action), (unchanged.row() || {}).edited],
		[DEFAULT, ["invoice_draft_created"], 0],
		"§5 approve: the generated text sent back (CRLF and all) is NOT an edit — default email, no edit audit, edited 0");

	const both = harness(L, GMAIL_ENV);
	await both.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE, total: "3100" } });
	eq((both.seen.audits.find((a) => a.action === "invoice_draft_edited") || {}).detail,
		`${INVOICE_ID} load 563367203 — total: sheet $3,000.00 / ratecon $0.00 → invoiced $3,100.00 (INVOICE ONLY — Job Tracking Payment unchanged); ` +
		`emailBody: edited (${TYPED_ROUTE_CHARS} chars)`,
		"§5 approve: an edited message beside an edited total — both named, the message by length only");
	eq((both.row() || {}).overrides_json, '{"total":3100}', "§5 …and overrides_json keeps the total, not the message");

	// ── the approve, n8n fallback ────────────────────────────────────────────
	// The workflow does not use emailHtml, so that path's draft carries the
	// GENERATED message: an edit is warned about and audited as not applied.
	const n8n = harness(L, N8N_ENV);
	const nr = await n8n.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
	eq([nr.status, (nr.body || {}).via, n8n.seen.posts.length], [200, "n8n", 1], withErrors("§5 approve with no IMAP → the n8n fallback", nr));
	eq(((n8n.seen.posts[0] || {}).payload || {}).emailHtml, EDITED, "§5 the n8n payload carries the edited email as emailHtml");
	eq((nr.body || {}).warnings, [NOT_APPLIED_WARNING], "§5 n8n + an edited message: the answer warns that the edit was not applied");
	eq((n8n.seen.audits.find((a) => a.action === "invoice_draft_edited") || {}).detail,
		`${INVOICE_ID} load 563367203 — emailBody: edited (${TYPED_ROUTE_CHARS} chars), NOT APPLIED (the fallback service used the generated message)`,
		"§5 …and the audit line records the edit as not applied");
	eq([(n8n.row() || {}).edited_fields, (n8n.row() || {}).overrides_json], ["emailBody", "{}"],
		"§5 …the draft record still names the edit, without its text");
	const n8nPlain = harness(L, N8N_ENV);
	const np = await n8nPlain.approve({ loadId: "563367203" });
	eq(((n8nPlain.seen.posts[0] || {}).payload || {}).emailHtml, DEFAULT, "§5 …and the default email when nothing was edited");
	eq([(np.body || {}).warnings, n8nPlain.seen.audits.map((a) => a.action)], [[], ["invoice_draft_created"]],
		"§5 …with no warning and no edit audit");
	const fellBack = harness(L, { ...GMAIL_ENV, ...N8N_ENV }, { imapFails: true });
	const fb = await fellBack.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
	eq([fb.status, (fb.body || {}).via, (fb.body || {}).warnings], [200, "n8n", [NOT_APPLIED_WARNING]],
		withErrors("§5 an IMAP failure that falls over to n8n with an edited message: the same warning", fb));

	// One email builder, three surfaces: what the preview shows is what the
	// dryRun shows is what reaches Gmail.
	const pv = await harness(L).preview({ loadId: "563367203", body: { ...PREVIEW_BASE, emailBody: TYPED_ROUTE } });
	const dr = await harness(L, GMAIL_ENV).dryRun({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
	eq([(pv.body || {}).emailHtml === d1.html, (dr.body || {}).emailHtml === d1.html], [true, true],
		"§5 the preview's and the dryRun's emailHtml are the approved draft's HTML");

	// ── refusals: every code, on every door, before any spend ─────────────────
	const TOO_LONG_MSG = "The email message must be 5,000 characters or fewer.";
	const BAD = [
		[42, "INVOICE_EMAIL_BODY_INVALID", "The email message must be text."],
		["x".repeat(10001), "INVOICE_EMAIL_BODY_TOO_LONG", TOO_LONG_MSG],
		["x".repeat(5001), "INVOICE_EMAIL_BODY_TOO_LONG", TOO_LONG_MSG],
		[" \r\n ", "INVOICE_EMAIL_BODY_EMPTY", "The email message can't be empty."],
	];
	for (const [value, code, error] of BAD) {
		for (const door of ["preview", "dryRun", "approve"]) {
			const h = harness(L, GMAIL_ENV);
			const r = await h[door]({ loadId: "563367203", body: { emailBody: value } });
			eq({ status: r.status, body: r.body }, { status: 400, body: { error, code, field: "emailBody" } },
				`§5 ${door}: ${code} (${typeof value === "string" ? value.length + " chars" : typeof value}) → 400 with the same shape as every override error`);
			eq([h.seen.sheetReads, h.seen.renders, h.seen.drafts.length, h.seen.posts.length], [0, 0, 0, 0],
				`§5 ${door}: …refused before any sheet read, render or draft`);
		}
	}

	// The email's fields never include the notes (PDF only), on either route.
	for (const [name, text] of [["approve", L.approve], ["preview", L.preview]]) {
		const decl = /const emailFields = \{[^}]*\};/.exec(text);
		ok(decl && !/\bnotes\b/.test(decl[0]), `§5 the ${name}'s emailFields carries no notes`);
		eq(countOf(text, "buildInvoiceEmailBodyText(emailFields)") + countOf(text, "buildInvoiceEmailHtml({ ...emailFields, bodyText: emailBody })"), 2,
			`§5 the ${name} builds the text and the HTML from the same emailFields`);
	}
}

// =============================================================== §6 MUTANTS
async function mutantsSection() {
	section("6. Mutants — each broken guard must flip an assertion");
	const EDITED_CHECK = "<script>x</script> & a  b\nline two";
	const libMutants = [
		{
			name: "LM1 the edited message is not HTML-escaped",
			from: "return esc(line).replace(/ +/g,", to: "return String(line).replace(/ +/g,",
			caught: (lib) => lib.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: EDITED_CHECK }).includes("<script>"),
		},
		{
			name: "LM2 spaces are left for HTML to collapse",
			from: ".replace(/ +/g, (run, at, s) =>", to: ".replace(/(?!)/g, (run, at, s) =>",
			caught: (lib) => editedProblems(lib, EDITED_CHECK).includes("collapsible space"),
		},
		{
			name: "LM3 line breaks are not <br>",
			from: '.map(editedLineHtml).join("<br>")', to: '.map(editedLineHtml).join("\\n")',
			caught: (lib) => editedProblems(lib, EDITED_CHECK).includes("raw whitespace"),
		},
		{
			name: "LM4 the generated text sent back unchanged is treated as an edit",
			from: "fields.bodyText !== buildInvoiceEmailBodyText(fields)", to: "true",
			caught: (lib) => lib.buildInvoiceEmailHtml({ ...FIXTURES.nonBison, bodyText: lib.buildInvoiceEmailBodyText(FIXTURES.nonBison) }) !== defaultNonBison(),
		},
		{
			name: "LM5 the text drifts from the email (one line break between paragraphs)",
			from: 'return invoiceEmailParagraphs(fields).join("\\n\\n");', to: 'return invoiceEmailParagraphs(fields).join("\\n");',
			caught: (lib) => lib.buildInvoiceEmailBodyText(FIXTURES.nonBison) !== visibleText(messageOf(lib.buildInvoiceEmailHtml(FIXTURES.nonBison))),
		},
	];
	for (const m of libMutants) {
		let caught = false;
		try { caught = !!m.caught(loadLib(mutate(LIB_SRC, m.from, m.to, m.name))); } catch (e) { failures.push(`${m.name}: ${e.message}`); continue; }
		ok(caught, `§6 caught: ${m.name}`);
	}

	const parseMutants = [
		{
			name: "SM1 the raw length is not checked before the clean-up",
			from: "if (src.emailBody.length > INVOICE_EMAIL_BODY_SCAN_MAX) {", to: "if (false) {",
			caught: (S) => S.parseInvoiceOverrides({ emailBody: " ".repeat(10001) }).code === "INVOICE_EMAIL_BODY_EMPTY",
		},
		{
			name: "SM2 a non-string is coerced instead of refused",
			from: 'if (typeof src.emailBody !== "string") {', to: "if (false) {",
			caught: (S) => S.parseInvoiceOverrides({ emailBody: 12345 }).ok === true,
		},
	];
	for (const m of parseMutants) {
		let caught = false;
		try { caught = !!m.caught(loadShipped(mutate(SRC, m.from, m.to, m.name))); } catch (e) { failures.push(`${m.name}: ${e.message}`); continue; }
		ok(caught, `§6 caught: ${m.name}`);
	}

	// The route mutants lift both routes from the mutated server.js and replay
	// the one scenario each guard is about. Every predicate asks for the WRONG
	// output itself, so a harness that failed outright cannot pass as a catch.
	const editedImap = async (L) => {
		const h = harness(L, GMAIL_ENV);
		await h.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
		return h;
	};
	const routeMutants = [
		{
			name: "SM3 the audit line logs the message text",
			from: "? `emailBody: edited (${Array.from(to).length} chars)`", to: '? `emailBody: "${from}" → "${to}"`',
			caught: async (L) => /Acme team/.test(JSON.stringify((await editedImap(L)).seen.audits)),
		},
		{
			name: "SM4 overrides_json keeps the message text",
			from: "JSON.stringify({ ...ov.values, emailBody: undefined })", to: "JSON.stringify(ov.values)",
			caught: async (L) => /Acme team/.test(((await editedImap(L)).row() || {}).overrides_json || ""),
		},
		{
			name: "SM5 the approve mails the generated message instead of the edit",
			from: "const draftHtml = brokerInvoice.buildInvoiceEmailHtml({ ...emailFields, bodyText: emailBody });",
			to: "const draftHtml = brokerInvoice.buildInvoiceEmailHtml({ ...emailFields, bodyText: emailBodyDefault });",
			caught: async (L) => ((await editedImap(L)).seen.drafts[0] || {}).html === defaultNonBison(),
		},
		{
			name: "SM6 the preview ignores the edit",
			from: "const emailHtml = brokerInvoice.buildInvoiceEmailHtml({ ...emailFields, bodyText: emailBody });",
			to: "const emailHtml = brokerInvoice.buildInvoiceEmailHtml(emailFields);",
			caught: async (L) => {
				const pv = await harness(L).preview({
					loadId: "563367203", body: { total: "3000", brokerName: "Acme Freight", isBison: false, emailBody: TYPED_ROUTE },
				});
				return (pv.body || {}).emailHtml === defaultNonBison();
			},
		},
		{
			name: "SM7 the dryRun seeds a Bison message with our load id as the Order #",
			from: 'loadNumber: loadRef,\n\t\t\t\torderNumber: needsOrderNumber ? "" : orderNumber,', to: "loadNumber: loadRef,\n\t\t\t\torderNumber,",
			caught: async (L) => String(((await harness(L, GMAIL_ENV).dryRun({ loadId: "30080873" })).body || {}).emailBodyDefault).includes("Order # 30080873."),
		},
		{
			name: "SM8 the n8n fallback drops an edited message silently",
			from: 'if (editedFields.includes("emailBody")) {', to: "if (false) {",
			caught: async (L) => {
				const h = harness(L, N8N_ENV);
				const r = await h.approve({ loadId: "563367203", body: { emailBody: TYPED_ROUTE } });
				const detail = (h.seen.audits.find((a) => a.action === "invoice_draft_edited") || {}).detail || "";
				return (r.body || {}).via === "n8n" && !((r.body || {}).warnings || []).length && !/NOT APPLIED/.test(detail);
			},
		},
	];
	for (const m of routeMutants) {
		let caught = false;
		try { caught = !!(await m.caught(liftRoutes(mutate(SRC, m.from, m.to, m.name)))); } catch (e) { failures.push(`${m.name}: ${e.message}`); continue; }
		ok(caught, `§6 caught: ${m.name}`);
	}
}

// -------------------------------------------------------------------- report
(async () => {
	// A throw inside a section is a failure, not a crash that hides the rest.
	for (const [name, run] of [
		["§1", parsingSection], ["§2", generatedTextSection], ["§3", defaultEmailSection],
		["§4", editedEmailSection], ["§5", routesSection], ["§6", mutantsSection],
	]) {
		try { await run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
	}
})().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
});
