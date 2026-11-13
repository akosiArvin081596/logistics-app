// Factored loads sent to Triumph by SFTP: the rules. Which mode the submit runs in and
// whether the made-up sample may go, the connection's settings, the caps, the assignment
// lines' setting, one batch's CSV and names, the size rule, the checks on the rate con,
// and the free checks with their codes.
//
// Pure: no network, database or files. lib/triumph-batch.js builds the batch from
// these; the page, the job and the reports read the same codes.

"use strict";

const { moneyCents } = require("./cell-compare");
const autoRules = require("./auto-invoice-rules");

// ── the mode ─────────────────────────────────────────────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDay(s) {
	const m = DAY_RE.exec(String(s == null ? "" : s));
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// "off" | "dry" | "live", and the one reader of these settings. Live needs all three:
// the app can't see Triumph go live, so TRIUMPH_LIVE_CONFIRMED_ON holds the date of
// Triumph's go-live email, and a load sent before that would be locked here and lost there.
function submitMode(env = {}, { replica = false } = {}) {
	if (replica) return "off";
	if (String((env && env.TRIUMPH_SUBMIT_ENABLED) ?? "").trim() !== "true") return "off";
	if (String((env && env.TRIUMPH_SUBMIT_DRY_RUN) ?? "").trim() !== "false") return "dry";
	return isRealDay(String((env && env.TRIUMPH_LIVE_CONFIRMED_ON) ?? "").trim()) ? "live" : "dry";
}

// Why the made-up sample may not go now, or null when it may. Any value at all in the go-live
// date shuts it, a mistyped one too: once Triumph is live, a sample would be a real upload.
function sampleShut(env = {}, { replica = false } = {}) {
	if (replica) return "SAMPLE_REPLICA";
	if (submitMode(env) === "live") return "SAMPLE_AFTER_LIVE";
	return String((env && env.TRIUMPH_LIVE_CONFIRMED_ON) ?? "").trim() !== "" ? "SAMPLE_AFTER_LIVE" : null;
}

// ── the connection's settings ────────────────────────────────────────────────

// Production's settings only: no default for any of them, so a copy of the code reaches
// nothing. The port alone has the protocol's own default. Answers names, never values.
const TRANSPORT_REQUIRED = Object.freeze(["TRIUMPH_HOST", "TRIUMPH_USER", "TRIUMPH_KEY_FILE", "TRIUMPH_HOST_FINGERPRINT", "TRIUMPH_HOST_KEY_TYPE", "TRIUMPH_SUBMIT_DIR"]);
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._-]{1,100}$/;
// ssh-keygen -l's SHA-256 form: 32 bytes in base64, its padding dropped.
const FINGERPRINT_RE = /^SHA256:([A-Za-z0-9+/]{43})=?$/;
// The one host-key type the cross-check shows for that fingerprint, so the handshake can't
// settle on another key of the same host and fail a match that was right.
const HOST_KEY_ALGORITHMS = Object.freeze({
	ED25519: Object.freeze(["ssh-ed25519"]),
	ECDSA: Object.freeze(["ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"]),
	RSA: Object.freeze(["rsa-sha2-512", "rsa-sha2-256"]),
});
const FOLDER_RE = /^\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;

function folderUsable(s) {
	return s.length <= 200 && FOLDER_RE.test(s) && !s.split("/").some((part) => part === "." || part === "..");
}

// { ok, missing, invalid, settings }. `settings` only when every required one is set and
// usable. TRIUMPH_REPORTS_DIR is optional here: only the status reader and the connection
// check list it.
function transportSettings(env = {}, { replica = false } = {}) {
	if (replica) return { ok: false, replica: true, missing: [], invalid: [], settings: null };
	const get = (name) => String((env && env[name]) ?? "").trim();
	const missing = TRANSPORT_REQUIRED.filter((name) => !get(name));
	const invalid = [];
	const host = get("TRIUMPH_HOST");
	if (host && !HOST_RE.test(host)) invalid.push("TRIUMPH_HOST");
	const portText = get("TRIUMPH_PORT");
	const port = portText ? Number(portText) : 22;
	if (portText && !(/^\d{1,5}$/.test(portText) && port >= 1 && port <= 65535)) invalid.push("TRIUMPH_PORT");
	const user = get("TRIUMPH_USER");
	if (user && !USER_RE.test(user)) invalid.push("TRIUMPH_USER");
	const keyFile = get("TRIUMPH_KEY_FILE");
	if (keyFile && !(keyFile.startsWith("/") && keyFile.length <= 4096 && !keyFile.includes("\0"))) invalid.push("TRIUMPH_KEY_FILE");
	const fp = FINGERPRINT_RE.exec(get("TRIUMPH_HOST_FINGERPRINT"));
	if (get("TRIUMPH_HOST_FINGERPRINT") && !fp) invalid.push("TRIUMPH_HOST_FINGERPRINT");
	const keyType = get("TRIUMPH_HOST_KEY_TYPE").toUpperCase();
	if (keyType && !Object.hasOwn(HOST_KEY_ALGORITHMS, keyType)) invalid.push("TRIUMPH_HOST_KEY_TYPE");
	const submitDir = get("TRIUMPH_SUBMIT_DIR");
	if (submitDir && !folderUsable(submitDir)) invalid.push("TRIUMPH_SUBMIT_DIR");
	const reportsDir = get("TRIUMPH_REPORTS_DIR");
	if (reportsDir && !folderUsable(reportsDir)) invalid.push("TRIUMPH_REPORTS_DIR");
	const ok = !missing.length && !invalid.length;
	return {
		ok,
		missing,
		invalid,
		settings: ok ? Object.freeze({ host, port, user, keyFile, fingerprint: fp[1], hostKeyAlgorithms: HOST_KEY_ALGORITHMS[keyType], submitDir, reportsDir }) : null,
	};
}

// ── the caps ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_PER_HOUR = 12;
const DEFAULT_MAX_PER_DAY = 60;
const MAX_PER_SWEEP = 2;

function capSetting(v, fallback, max) {
	const s = String(v ?? "").trim();
	if (!/^\d{1,6}$/.test(s)) return fallback;
	const n = Number(s);
	return n >= 1 && n <= max ? n : fallback;
}

// New batches an hour and a day, so a burst of deliveries drains over hours.
function readCaps(env = {}) {
	return {
		maxPerHour: capSetting(env && env.TRIUMPH_MAX_PER_HOUR, DEFAULT_MAX_PER_HOUR, 1000),
		maxPerDay: capSetting(env && env.TRIUMPH_MAX_PER_DAY, DEFAULT_MAX_PER_DAY, 10000),
		perSweep: MAX_PER_SWEEP,
	};
}

// ── the assignment lines ─────────────────────────────────────────────────────

const NOA_LINE_COUNT = 4;
const NOA_LINE_MAX = 200;

// TRIUMPH_NOA_LINES, word for word: a remit address is a payment instruction, so a
// setting cut short is refused rather than printed. Only each line's ends are trimmed;
// a run of spaces inside one stays. A line break is a real one or, for a value dotenv
// hands over unexpanded, a written \n. The answer never carries the setting's words
// when it refuses.
function parseNoaLines(raw) {
	const lines = String(raw == null ? "" : raw).split(/\r\n|\n|\r|\\n/).map((l) => l.trim()).filter(Boolean);
	const usable = lines.length === NOA_LINE_COUNT && lines.every((l) => Array.from(l).length <= NOA_LINE_MAX && !/[\p{Cc}\p{Cf}]/u.test(l));
	return usable ? { ok: true, lines } : { ok: false, code: "NOA_UNCONFIGURED" };
}

// ── the CSV ──────────────────────────────────────────────────────────────────

const CSV_HEADERS = Object.freeze(["DTR_NAME", "INVOICE#", "INV_DATE", "PO", "INVAMT"]);
const CSV_HEADER = CSV_HEADERS.join(",");
const CSV_EOL = "\r\n";
const DTR_NAME_MAX = 100;
const INVOICE_MAX = 100;
const INVAMT_MAX_CENTS = 100000000;
// The invoice number is also the PDF's name and part of the CSV's.
const FILE_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const MDY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

const fieldRefusal = (field, code = "FIELD_UNUSABLE") => ({ ok: false, code, field });

// Triumph's CSV takes no quotes in any column, so a value that would need one (a comma,
// a double quote, a line break) is refused.
function debtorNameUsable(name) {
	return Boolean(name) && name.length <= DTR_NAME_MAX && name === name.trim() && /^[\x20-\x7e]+$/.test(name) && !name.includes('"') && !name.includes(",") && !/^[=+\-@]/.test(name);
}

const DEBTOR_NAME_COMMA_WORDS = "The debtor's name holds a comma, so nothing was sent. Triumph's file takes no quotes, and without them a comma would split the name across columns.";

function mdyUsable(s) {
	const m = MDY_RE.exec(s);
	return Boolean(m) && isRealDay(`${m[3]}-${m[1]}-${m[2]}`);
}

const centsText = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

// One invoice's row, each value as the PDF prints it: { ok: true, row } or a refusal
// naming the field. `billedTotal` is the printed total ("$2,150.00"), read in whole
// cents, so INVAMT is never a float's rounding.
function csvRow({ debtorName, invoiceId, invoiceDate, po, billedTotal } = {}) {
	const name = String(debtorName == null ? "" : debtorName);
	const invoice = String(invoiceId == null ? "" : invoiceId);
	const date = String(invoiceDate == null ? "" : invoiceDate);
	const ref = String(po == null ? "" : po);
	// A legal name can hold a comma, so that stop has its own code. It comes first because
	// debtorNameUsable() refuses a comma too.
	if (name.includes(",")) return { ...fieldRefusal("DTR_NAME", "DEBTOR_NAME_COMMA"), error: DEBTOR_NAME_COMMA_WORDS };
	if (!debtorNameUsable(name)) return fieldRefusal("DTR_NAME");
	if (invoice.length > INVOICE_MAX || !FILE_SAFE_RE.test(invoice)) return fieldRefusal("INVOICE#");
	if (!mdyUsable(date)) return fieldRefusal("INV_DATE");
	if (!PO_RE.test(ref)) return fieldRefusal("PO", "PO_UNUSABLE");
	const cents = moneyCents(billedTotal);
	if (!Number.isInteger(cents) || cents <= 0 || cents > INVAMT_MAX_CENTS) return fieldRefusal("INVAMT");
	return { ok: true, row: Object.freeze({ DTR_NAME: name, "INVOICE#": invoice, INV_DATE: date, PO: ref, INVAMT: centsText(cents) }) };
}

// The file, exactly: the header, one row, CRLF, ASCII (so no BOM), and never a quote. A
// value that would need quoting throws, so a row that didn't come from csvRow() can't
// shift the columns.
function csvText(row) {
	const values = CSV_HEADERS.map((h) => row[h]);
	const unsafe = CSV_HEADERS.find((h, i) => /[",\r\n]/.test(String(values[i])));
	if (unsafe) throw new Error(`csvText: ${unsafe} would need quotes, and Triumph's CSV takes none`);
	return `${CSV_HEADER}${CSV_EOL}${values.join(",")}${CSV_EOL}`;
}

// ── the names ────────────────────────────────────────────────────────────────

const pdfName = (invoiceId) => `${invoiceId}.pdf`;

// Unique by its second and the invoice number, so a second batch never overwrites one.
function csvName(invoiceId, at) {
	const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
	return `logisx_${stamp}_${invoiceId}.csv`;
}

// ── the size rule ────────────────────────────────────────────────────────────

// "Must total less than 921600 bytes": the PDF and the CSV together.
const BATCH_MAX_BYTES = 921599;

// TRIUMPH_BATCH_MAX_BYTES can only lower it: anything else leaves the limit as it is.
function batchMaxBytes(env = {}) {
	const s = String((env && env.TRIUMPH_BATCH_MAX_BYTES) ?? "").trim();
	if (!/^\d{1,7}$/.test(s)) return BATCH_MAX_BYTES;
	const n = Number(s);
	return n >= 1 && n < BATCH_MAX_BYTES ? n : BATCH_MAX_BYTES;
}

function sizeRefusal(pdfBytes, csvBytes, maxBytes = BATCH_MAX_BYTES) {
	const limit = Math.min(Number(maxBytes) || BATCH_MAX_BYTES, BATCH_MAX_BYTES);
	return pdfBytes + csvBytes <= limit ? null : { ok: false, code: "BATCH_TOO_LARGE", pdfBytes, csvBytes, maxBytes: limit };
}

// ── rule 7 ───────────────────────────────────────────────────────────────────

// Every value the app composes, each read on its own by the deny list's hits()
// (lib/chr-events.js createRedactor()). No reader means nothing was checked, so it refuses.
function protectedValueRefusal({ row, names = [], denyHits }) {
	if (typeof denyHits !== "function") return { ok: false, code: "PROTECTED_VALUE" };
	const values = [...CSV_HEADERS.map((h) => row[h]), ...names];
	return values.some((v) => denyHits(v)) ? { ok: false, code: "PROTECTED_VALUE" } : null;
}

// ── the debtor ───────────────────────────────────────────────────────────────

// The name set for the broker's own email domain, by a person: a read never chooses it,
// and the printed "Invoice To" is no fallback.
function debtorFor(brokerDomain, debtorNames) {
	const domain = String(brokerDomain == null ? "" : brokerDomain).toLowerCase();
	const map = debtorNames && typeof debtorNames === "object" ? debtorNames : {};
	const name = domain && Object.hasOwn(map, domain) ? String(map[domain] == null ? "" : map[domain]).trim() : "";
	return name ? { ok: true, name } : { ok: false, code: "DEBTOR_UNMAPPED" };
}

const squeeze = (s) => String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, "");
const digits = (a, b) => /\p{N}/u.test(a) && /\p{N}/u.test(b);
const wordRunsIn = (before, first) => Boolean(before) && ((/\p{Ll}/u.test(first) && /\p{L}/u.test(before)) || digits(before, first));
const wordRunsOn = (last, after) => Boolean(after) && ((/\p{Ll}/u.test(last) && /\p{Ll}/u.test(after)) || digits(last, after));

// Does the rate con print this name? Exactly, case included, apart from whitespace: the
// reader joins what a PDF positions as separate words, so a capital after the name can
// start the next word. Inside a longer word it isn't the name ("Example Broker" in
// "Example Brokerage").
function printsDebtorName(name, shown) {
	const want = squeeze(name);
	const text = squeeze(shown);
	if (!want) return false;
	for (let i = text.indexOf(want); i !== -1; i = text.indexOf(want, i + 1)) {
		if (!wordRunsIn(text[i - 1], want[0]) && !wordRunsOn(want[want.length - 1], text[i + want.length])) return true;
	}
	return false;
}

// An empty read says nothing about the name: the file may print it where the reader can't
// see (object streams, a scan), so that stop gives its own reason.
function debtorNameRefusal(name, shown) {
	if (!String(shown == null ? "" : shown).trim()) return { ok: false, code: "DEBTOR_NAME_UNREADABLE", error: "The rate con's text couldn't be read, so the debtor's name couldn't be checked on it." };
	return printsDebtorName(name, shown) ? null : { ok: false, code: "DEBTOR_NAME_NOT_ON_DOC", error: "The debtor's name wasn't found in the text the app can read on this rate con." };
}

// ── the rate con ─────────────────────────────────────────────────────────────

// The automatic job's test of the whole number, for the same fault: another load's rate
// con in the batch. `primary` is the engine's first candidate; `rateConNumber` its read's
// Load Number; `rateConText()` its text. The two rules are the job's own.
// The text can't tell a number the reader ran into the next word from another number, so
// the number's stop names both causes and claims neither.
const NUMBER_UNREAD_WORDS = "The rate con couldn't be read for this load's whole number, so nothing was sent. It may print the number in a way the app can't read, or give another one.";
function rateConRefusal({ primary, loadId, rateConNumber, rateConText } = {}) {
	if (!autoRules.rateConNamedForLoad(primary, loadId)) return { ok: false, code: "RATECON_NAME_MISMATCH" };
	if (!autoRules.rateConSaysLoad(rateConNumber, rateConText, loadId)) return { ok: false, code: "RATECON_NUMBER_MISMATCH", error: NUMBER_UNREAD_WORDS };
	return null;
}

// ── what goes in a batch ─────────────────────────────────────────────────────

// The guide's list after the invoice and the rate con: BOLs, then PODs, then lumper,
// scale and pallet documents when one is on file. A document table's type decides.
const DOCUMENT_KINDS = Object.freeze({
	BOL: "bol",
	POD: "pod",
	LUMPER: "other", "LUMPER RECEIPT": "other",
	SCALE: "other", "SCALE TICKET": "other",
	PALLET: "other", "PALLET EXCHANGE": "other",
});
const DOCUMENT_ORDER = Object.freeze(["bol", "pod", "other"]);

const documentKind = (type) => (Object.hasOwn(DOCUMENT_KINDS, String(type == null ? "" : type).trim().toUpperCase())
	? DOCUMENT_KINDS[String(type).trim().toUpperCase()] : null);

// Every document of a load in its batch order; upload order within a kind, as the
// invoice engine orders PODs. Other types (receipts, "Other") never go.
function batchDocuments(rows) {
	const byUpload = (a, b) => String(a.uploaded_at || "").localeCompare(String(b.uploaded_at || "")) || Number(a.id || 0) - Number(b.id || 0);
	const kept = (Array.isArray(rows) ? rows : []).map((d) => ({ doc: d, kind: documentKind(d.type) })).filter((x) => x.kind);
	return DOCUMENT_ORDER.flatMap((kind) => kept.filter((x) => x.kind === kind).map((x) => x.doc).sort(byUpload).map((doc) => ({ kind, doc })));
}

// The kinds a batch can't go without: the invoice, the rate con, a BOL or POD. A list of
// what's missing, empty when nothing is.
function missingKinds({ invoice, rateCon, documents = [] } = {}) {
	const missing = [];
	if (!invoice) missing.push("invoice");
	if (!rateCon) missing.push("ratecon");
	if (!documents.some((d) => d.kind === "bol" || d.kind === "pod")) missing.push("pod");
	return missing;
}

// ── the free checks ──────────────────────────────────────────────────────────

const REASON_CODES = Object.freeze([
	// waiting
	"LOAD_DROPPED", "NOT_COMPLETED", "WAITING_POD", "INVOICE_DRAFT_IN_FLIGHT",
	// needs attention: the free checks
	"ALREADY_INVOICED", "INVOICE_MAYBE_DRAFTED", "CLOSED_MONTH", "MONTH_UNKNOWN", "NO_DELIVERY_DATE", "ADVANCE_LINES",
	"POD_UNREADABLE", "NO_BROKER_EMAIL", "BROKER_EMAIL_FREEMAIL", "BROKER_DOMAIN_UNCONFIRMED", "DEBTOR_UNMAPPED", "NOA_UNCONFIGURED",
	"SETTINGS_UNREADABLE", "DENY_LIST_UNSET",
	// needs attention: building the batch
	"FIELD_UNUSABLE", "PO_UNUSABLE", "PROTECTED_VALUE", "DOCUMENT_MISSING", "DOCUMENT_UNREADABLE", "MERGE_FAILED", "BATCH_TOO_LARGE",
	"DEBTOR_NAME_COMMA", "DEBTOR_NAME_NOT_ON_DOC", "DEBTOR_NAME_UNREADABLE", "RATECON_NAME_MISMATCH", "RATECON_NUMBER_MISMATCH",
	"FIELD_NOT_PRINTED",
	// skipped: the load is no longer the job's (a mark cleared, or handled in Triumph's process)
	"NOT_FACTORED", "FACTORING_LOCKED",
	// needs attention: the invoice engine's own refusals (lib/auto-invoice-rules.js classifyRefusal())
	"RATECON_MISSING", "RATECON_BY_CONTENT", "RATECON_TOTAL_UNREAD", "NO_BILLING_EMAIL", "RECIPIENT_DOMAIN_MISMATCH",
	"RECIPIENT_UNCONFIGURED", "TOTAL_MISMATCH", "POD_PAGE_UNREADABLE", "INVOICE_REFS_REQUIRED", "INVOICE_TOTAL_UNKNOWN",
	"TRAILER_MISMATCH", "DRAFT_REFUSED", "FACTORING_UNREADABLE", "ASSIGNMENT_NOT_PRINTABLE", "FACTORING_CHANGED",
	// queued again: a wait that costs no try, or a try that failed and comes back
	"RETRY_LATER", "GEMINI_DOWN", "RENDERER_BUSY", "QUIET_WINDOW", "HOST_KEY_MISMATCH", "LOGIN_REFUSED",
	// needs attention: sending, and a staged batch's last checks before "Submit now"
	"SUBMIT_FAILED", "MAYBE_SUBMITTED", "BATCH_FILES_CHANGED", "LOAD_CHANGED",
	// the lock point's own refusals (lib/triumph-ledger.js lockForUpload()), and a "Submit now" run
	"NOT_LIVE", "NUMBER_VOIDED", "STAGE_INVALID", "LOCK_MISSING", "SUBMIT_NOW",
]);

const verdict = (state, code = "") => ({ state, code });

// csvRow()'s own rules for DTR_NAME, as a free check, so a name the file can't take stops
// the load before an invoice number is reserved. A code, or null.
function debtorNameProblem(name) {
	const n = String(name == null ? "" : name);
	if (n.includes(",")) return "DEBTOR_NAME_COMMA";
	return debtorNameUsable(n) ? null : "FIELD_UNUSABLE";
}

// The checks that cost nothing, in order, on lib/auto-invoice-rules.js loadFacts()'s
// facts. `ownDrafts`: draft rows that are this submission's own. `inflight`: the state of
// a button draft in flight on the load (lib/factoring-store.js). `checkMonth: false`: a
// report over past loads, whose month has closed since.
// The submit job also passes what only it reads, each checked only when given:
// `lockedOutside` (the marker was locked by "Handled in Triumph's process"), `factored`
// (false once the mark is cleared), `mailboxInvoice` (saved mailbox evidence shows an
// invoice), `settingsReadable` (the debtor map) and `denyListSet` (rule 7's list).
function freeVerdict(facts, { debtorName = "", hasLines = false, ownDrafts = 0, inflight = "", checkMonth = true,
	lockedOutside = false, factored = undefined, mailboxInvoice = false, settingsReadable = true, denyListSet = undefined } = {}) {
	const f = facts || {};
	if (lockedOutside === true) return verdict("skipped", "FACTORING_LOCKED");
	if (factored === false) return verdict("skipped", "NOT_FACTORED");
	if (!f.live) return verdict("waiting", "LOAD_DROPPED");
	if (!f.completed) return verdict("waiting", "NOT_COMPLETED");
	if (f.drafts - ownDrafts > 0) return verdict("needs_attention", "ALREADY_INVOICED");
	if (mailboxInvoice === true) return verdict("needs_attention", "ALREADY_INVOICED");
	if (inflight === "in_flight") return verdict("waiting", "INVOICE_DRAFT_IN_FLIGHT");
	if (inflight) return verdict("needs_attention", "INVOICE_MAYBE_DRAFTED");
	if (checkMonth) {
		if (!Array.isArray(f.closedMonths)) return verdict("needs_attention", "MONTH_UNKNOWN");
		if (f.closedMonths.length) return verdict("needs_attention", "CLOSED_MONTH");
	}
	if (!f.hasDeliveryDate) return verdict("needs_attention", "NO_DELIVERY_DATE");
	if (f.activeAdvanceLines > 0) return verdict("needs_attention", "ADVANCE_LINES");
	if (!f.pods) return verdict("waiting", "WAITING_POD");
	if (f.podsUnreadable > 0) return verdict("needs_attention", "POD_UNREADABLE");
	if (!f.brokerDomain) return verdict("needs_attention", "NO_BROKER_EMAIL");
	if (!f.isBison) {
		if (f.brokerEmailFreemail) return verdict("needs_attention", "BROKER_EMAIL_FREEMAIL");
		if (!f.brokerDomainConfirmed) return verdict("needs_attention", "BROKER_DOMAIN_UNCONFIRMED");
	}
	if (settingsReadable === false) return verdict("needs_attention", "SETTINGS_UNREADABLE");
	if (!debtorName) return verdict("needs_attention", "DEBTOR_UNMAPPED");
	const nameProblem = debtorNameProblem(debtorName);
	if (nameProblem) return verdict("needs_attention", nameProblem);
	if (hasLines !== true) return verdict("needs_attention", "NOA_UNCONFIGURED");
	if (denyListSet === false) return verdict("needs_attention", "DENY_LIST_UNSET");
	return verdict("queued");
}

module.exports = {
	submitMode,
	sampleShut,
	TRANSPORT_REQUIRED,
	HOST_KEY_ALGORITHMS,
	transportSettings,
	readCaps,
	debtorNameProblem,
	isRealDay,
	NOA_LINE_COUNT,
	NOA_LINE_MAX,
	parseNoaLines,
	CSV_HEADERS,
	CSV_HEADER,
	CSV_EOL,
	DTR_NAME_MAX,
	INVOICE_MAX,
	INVAMT_MAX_CENTS,
	debtorNameUsable,
	csvRow,
	csvText,
	pdfName,
	csvName,
	BATCH_MAX_BYTES,
	batchMaxBytes,
	sizeRefusal,
	protectedValueRefusal,
	debtorFor,
	printsDebtorName,
	debtorNameRefusal,
	rateConRefusal,
	DOCUMENT_KINDS,
	documentKind,
	batchDocuments,
	missingKinds,
	REASON_CODES,
	freeVerdict,
};
