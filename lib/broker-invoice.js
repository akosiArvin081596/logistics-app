// ============================================================
// Broker Draft-Invoice builder
// ============================================================
// Pure helpers for the "Draft Invoice Email" feature on completed loads —
// EVERY broker, not just Bison. Kept out of server.js so the data-shaping +
// HTML layout can be unit-reasoned about and tested in isolation. server.js
// wires these into the POST /api/loads/:loadId/draft-invoice route.
//
// `isBisonLoad()` survives the generalization as a *branch*, not a gate: it
// only selects the invoice recipient (Bison has its own AP inbox; everyone
// else bills the quickpay inbox).
//
// Nothing here touches the network or the DB — callers pass in already-
// fetched bytes/rows. The two exceptions are clearly-scoped: a deterministic
// rate-con text scan (pure, over a Buffer) and an optional Gemini fallback
// (network) that is only reached when the deterministic scan comes up empty.
//
// Exports:
//   buildInvoiceHtml(fields)         -> HTML string for renderHtmlToPdf()
//   buildInvoiceEmailHtml(fields)    -> HTML string for the Gmail draft body
//   isBisonLoad(load)                -> bool (broker email ends @bisontransport.com)
//   resolveBrokerName(ctx)           -> "Bison Transport" | "Acme Freight" | ""
//   resolveInvoiceTo(ctx)            -> { name, email } for the "Invoice To" block
//   findPaymentColumn(headers)       -> the Job Tracking money header, or null
//   parseMoney(v)                    -> Number (0 when unparseable)
//   extractRateConFields(pdfBuffer, opts) -> Promise<{orderNumber,...}>
//   formatMoney(n) / formatDate(d)   -> presentation helpers (exported for the route)

"use strict";

const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------
// Static company / payment constants (never vary per invoice)
// ------------------------------------------------------------
const SELLER = {
	companyName: "Logistics Exchange Inc.",
	email: "info@logisx.com",
	phone: "+1(321)-848-3437",
};

// Where the invoice is billed. Bison keeps the dedicated AP inbox it has
// always used; every other broker bills the quickpay inbox.
const BISON_INVOICE_EMAIL = "QPinvoicesUSA@bisontransport.com";
const DEFAULT_INVOICE_EMAIL = "quickpay@megacorplogistics.com";

const PAYMENT_METHOD = {
	name: "LogisX Inc.",
	address: "1619 N Frazier St. Unit #441, Conroe, TX 77301",
	email: "info@logisx.com",
	bankName: "COASTAL COMMUNITY BANK",
	bankRouting: "125109019",
	bankAccount: "875105081223",
};

// LogisX logo embedded as a base64 data URI so the rendered invoice PDF
// is self-contained (Puppeteer setContent has no base URL — same pattern
// as lib/policy-renderer.js). Source of truth: <repo-root>/logo.png.
// Falls back to the production-served logo.avif if the file is missing.
const LOGO_PATH = path.join(__dirname, "..", "logo.png");
const LOGISX_LOGO_URL = fs.existsSync(LOGO_PATH)
	? `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`
	: "https://app.logisx.com/logo.avif";

// ------------------------------------------------------------
// Presentation helpers
// ------------------------------------------------------------

// "$1,800.00" from 1800, "1800", "1,800", "$1,800.00", etc. Returns the
// formatted string. Non-numeric input falls back to "$0.00".
function formatMoney(value) {
	let n;
	if (typeof value === "number") {
		n = value;
	} else {
		n = parseFloat(String(value == null ? "" : value).replace(/[^0-9.\-]/g, ""));
	}
	if (!isFinite(n)) n = 0;
	return (
		"$" +
		n.toLocaleString("en-US", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})
	);
}

// "MM/DD/YYYY" from a Date, an ISO string, a "MM/DD/YYYY" string, or a
// locale string. Returns "" when nothing parseable is supplied so the
// caller can decide whether a blank date is acceptable.
function formatDate(value) {
	if (!value) return "";
	if (value instanceof Date) {
		if (isNaN(value.getTime())) return "";
		return mdy(value);
	}
	const raw = String(value).replace(/^date:\s*/i, "").trim();
	if (!raw) return "";
	// Already MM/DD/YYYY (or M/D/YY) — normalize zero-padding + 4-digit year.
	const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
	if (m) {
		let yr = parseInt(m[3], 10);
		if (yr < 100) yr += 2000;
		const mo = parseInt(m[1], 10);
		const da = parseInt(m[2], 10);
		if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
			return (
				String(mo).padStart(2, "0") +
				"/" +
				String(da).padStart(2, "0") +
				"/" +
				yr
			);
		}
	}
	const d = new Date(raw);
	if (isNaN(d.getTime())) return "";
	return mdy(d);
}

function mdy(d) {
	return (
		String(d.getMonth() + 1).padStart(2, "0") +
		"/" +
		String(d.getDate()).padStart(2, "0") +
		"/" +
		d.getFullYear()
	);
}

// Minimal HTML escape for the few dynamic strings interpolated into the
// invoice (order/PO numbers come from a PDF and from the DB). Mirrors the
// escHtml in server.js so behavior is consistent across the codebase.
function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// ------------------------------------------------------------
// isBisonLoad — the established LogisX rule (see
// scripts/patch-bison-lane-hardcode.js): broker email ends with
// bisontransport.com. The broker email is the `email` field on a
// sheet_job_tracking row / the broker-email column ("Email") of a Job
// Tracking sheet row. Accepts either a raw email string or a load object
// and probes the common column spellings.
// ------------------------------------------------------------
function isBisonLoad(load) {
	let email = "";
	if (typeof load === "string") {
		email = load;
	} else if (load && typeof load === "object") {
		email =
			load.email ||
			load.broker_email ||
			load.brokerEmail ||
			load.Email ||
			load["Broker Email"] ||
			"";
	}
	return /bisontransport\.com$/i.test(String(email).trim().toLowerCase());
}

// ------------------------------------------------------------
// Broker identity
// ------------------------------------------------------------
// The Job Tracking sheet has NO brokerage-company column: both "Broker
// Contact Name" and "Contract ID" hold the booking *agent's* name (e.g.
// "Danna Garcia"), which must never head an "Invoice To" block. So we
// derive the company from the broker's email domain instead.
//
// 1) BROKER_DOMAIN_NAMES below — the authoritative spellings for the
//    brokerages LogisX actually bills. ADD NEW BROKERS HERE: key on the
//    registrable email domain (lowercase), value is the exact legal-ish
//    name that should print on the invoice. Subdomains match too
//    (mail.chrobinson.com -> chrobinson.com).
// 2) Unknown domain -> humanize it ("acmefreight.com" -> "Acme Freight").
// 3) No usable email -> the sheet's "Broker Contact Name" (better an
//    agent's name than a blank invoice).
// 4) Nothing at all -> "".
const BROKER_DOMAIN_NAMES = {
	"bisontransport.com": "Bison Transport",
	"megacorplogistics.com": "MegaCorp Logistics",
	"chrobinson.com": "C.H. Robinson",
	"tql.com": "TQL",
	"totalqualitylogistics.com": "TQL",
	"coyote.com": "Coyote Logistics",
	"landstar.com": "Landstar",
	"jbhunt.com": "J.B. Hunt",
	"echo.com": "Echo Global Logistics",
	"xpo.com": "XPO",
	"rxo.com": "RXO",
	"uberfreight.com": "Uber Freight",
	"hubgroup.com": "Hub Group",
	"schneider.com": "Schneider",
	"werner.com": "Werner Enterprises",
	"arcbest.com": "ArcBest",
	"nolantransportation.com": "NTG",
	"englandlogistics.com": "England Logistics",
};

// Compound-word tails we know how to split when humanizing a domain, so
// "acmefreight.com" reads "Acme Freight" rather than "Acmefreight".
const DOMAIN_WORD_TAILS = [
	"logistics",
	"transportation",
	"transport",
	"trucking",
	"freight",
	"express",
	"carriers",
	"carrier",
	"shipping",
	"brokerage",
	"dispatch",
	"cargo",
	"lines",
	"group",
];

// "someone@Mail.AcmeFreight.com" -> "mail.acmefreight.com". "" when absent.
function emailDomain(email) {
	const raw = String(email == null ? "" : email).trim().toLowerCase();
	const at = raw.lastIndexOf("@");
	if (at === -1) return "";
	return raw.slice(at + 1).replace(/[>,;\s]+$/, "").replace(/\.+$/, "");
}

// Title-case a single word, uppercasing short tokens (3 chars or fewer are
// almost always acronyms — "abc.com" -> "ABC", not "Abc").
function titleWord(w) {
	if (!w) return "";
	if (w.length <= 3) return w.toUpperCase();
	return w.charAt(0).toUpperCase() + w.slice(1);
}

// "acme-freight.com" / "acmefreight.com" / "mail.acmefreight.co.uk"
// -> "Acme Freight". Returns "" when the domain yields nothing usable.
function humanizeDomain(domain) {
	let labels = String(domain || "")
		.replace(/^www\./, "")
		.split(".")
		.filter(Boolean);
	if (!labels.length) return "";
	// Drop the public suffix: two labels for ccTLD forms ("co.uk", "com.au"),
	// otherwise one.
	if (
		labels.length >= 3 &&
		labels[labels.length - 1].length === 2 &&
		/^(co|com|net|org|gov|edu|ac)$/.test(labels[labels.length - 2])
	) {
		labels = labels.slice(0, -2);
	} else if (labels.length >= 2) {
		labels = labels.slice(0, -1);
	}
	if (!labels.length) return "";
	// The company token is the last remaining label ("mail.acmefreight" -> acmefreight).
	const name = labels[labels.length - 1];
	let words = name.split(/[-_]+/).filter(Boolean);
	if (words.length === 1) {
		const only = words[0];
		for (const tail of DOMAIN_WORD_TAILS) {
			if (only.length > tail.length + 2 && only.endsWith(tail)) {
				words = [only.slice(0, only.length - tail.length), tail];
				break;
			}
		}
	}
	return words.map(titleWord).join(" ").trim();
}

// Resolve the brokerage company name for the invoice. ctx accepts
// { brokerEmail, brokerContactName } (extra keys ignored).
function resolveBrokerName(ctx = {}) {
	const domain = emailDomain(ctx.brokerEmail);
	if (domain) {
		if (BROKER_DOMAIN_NAMES[domain]) return BROKER_DOMAIN_NAMES[domain];
		for (const key of Object.keys(BROKER_DOMAIN_NAMES)) {
			if (domain.endsWith("." + key)) return BROKER_DOMAIN_NAMES[key];
		}
		const humanized = humanizeDomain(domain);
		if (humanized) return humanized;
	}
	return String(ctx.brokerContactName == null ? "" : ctx.brokerContactName).trim();
}

// Validate a candidate recipient so a garbage/partial value can never become
// the address a real invoice is mailed to. Returns "" when it isn't an email.
function normalizeEmail(v) {
	const s = String(v == null ? "" : v).trim().replace(/[.,;>)\]]+$/, "");
	return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? s : "";
}

// The "Invoice To" block + the address the Gmail draft is sent to.
//   • Bison keeps its dedicated AP inbox byte-for-byte — it was always correct
//     (the bug was NON-Bison brokers), so rate-con text NEVER overrides it.
//   • Every other broker: the rate-con's own "email documents to …" address
//     (ctx.documentsEmail) is the real recipient when present, else the quickpay
//     default — byte-identical to the old behavior when documentsEmail is absent.
function resolveInvoiceTo(ctx = {}) {
	if (isBisonLoad({ email: ctx.brokerEmail })) {
		return { name: "Bison Transport", email: BISON_INVOICE_EMAIL };
	}
	const docEmail = normalizeEmail(ctx.documentsEmail);
	// Label the "Invoice To" block by the recipient's own domain when routed to a
	// rate-con address, so the printed name matches where the invoice is going.
	const name = docEmail ? resolveBrokerName({ brokerEmail: docEmail }) || resolveBrokerName(ctx) : resolveBrokerName(ctx);
	return { name, email: docEmail || DEFAULT_INVOICE_EMAIL };
}

// ------------------------------------------------------------
// Money
// ------------------------------------------------------------
// The Job Tracking sheet's money column is literally named "  Payment  "
// (real leading/trailing spaces), so match on the TRIMMED header. Exact
// "payment" first, then a "payment"-containing header ("Payment Amount");
// deliberately no looser fallback — invoicing off a "Rate Per Mile" column
// would silently bill the wrong number, which is worse than failing loudly.
function findPaymentColumn(headers) {
	const list = Array.isArray(headers) ? headers : [];
	const exact = list.find((h) => /^payment$/i.test(String(h == null ? "" : h).trim()));
	if (exact != null) return exact;
	const loose = list.find((h) => /payment/i.test(String(h == null ? "" : h).trim()));
	return loose == null ? null : loose;
}

// "$1,800.00" / "1800" / 1800 -> 1800. Unparseable/blank -> 0. Used by the
// route's "never draft a $0.00 invoice" guard, so it must never throw.
function parseMoney(value) {
	if (typeof value === "number") return isFinite(value) ? value : 0;
	const n = parseFloat(String(value == null ? "" : value).replace(/[^0-9.\-]/g, ""));
	return isFinite(n) ? n : 0;
}

// ------------------------------------------------------------
// extractRateConFields
// ------------------------------------------------------------
// Returns { orderNumber, poNumber, moveNumber, trailerNumber, totalRate }
// from a rate-con PDF.
//
// Strategy:
//   1. Deterministic text scan. ONLY the Bison rate-con carries the
//      "Billing Information" block this scan understands (verified against
//      real C.H. Robinson / Navisphere rate-cons: they yield nothing here
//      and go to Gemini). The Bison block looks like:
//          Order #: 7007280
//          LEG #:
//          PO #: 2759513
//          Move #: 19879427
//          Trailer: 51237
//          Total Rate: $1,800.00
//      We pull printable text out of the PDF bytes (uncompressed text
//      objects + zlib-inflated FlateDecode streams — no extra dependency,
//      the repo ships no pdf-to-text lib) and regex the labels. This is
//      preferred because it's free and deterministic.
//   2. Gemini fallback. When the deterministic scan can't find the order
//      number (scanned/flattened PDF with no usable text layer), and a
//      `geminiExtract` callback is supplied, defer to it. The route passes
//      a thin wrapper over the existing extract-pdf-via-gemini code whose
//      schema is extended to also return Order/PO/Move/Trailer numbers.
//
// `opts.geminiExtract(buffer)` -> Promise<object|null> (Information-Extractor
// shaped { ...fields }). Optional. `opts.requireOrderNumber` (default true)
// controls whether a missing order number triggers the fallback.
async function extractRateConFields(pdfBuffer, opts = {}) {
	const { geminiExtract = null, requireOrderNumber = true } = opts;

	let fields = { orderNumber: "", poNumber: "", moveNumber: "", trailerNumber: "", totalRate: "", documentsEmail: "" };

	if (Buffer.isBuffer(pdfBuffer) && pdfBuffer.length) {
		const text = extractPdfText(pdfBuffer);
		// The "email documents to" address is independent of the Bison billing
		// block, so harvest it from the text whenever we have any (and never the
		// booking agent's own email — opts.brokerEmail).
		const docEmail = extractDocumentsEmail(text, { excludeEmail: opts.brokerEmail });
		const scanned = scanBillingBlock(text);
		// ALL-OR-NOTHING. The scan is only meaningful when it found the
		// "Order #" anchor of a real Billing Information block. Without that
		// anchor we cannot tell a field from prose that merely follows the
		// word "Trailer" — real C.H. Robinson / Navisphere rate-cons produce
		// trailerNumber "are" / "Required" that way, and because
		// mergeGeminiFields() prefers the deterministic value, that garbage
		// would beat Gemini's correct answer and trip the route's
		// trailer-mismatch guard. Discard the whole result instead.
		if (scanned.orderNumber || !requireOrderNumber) fields = { ...scanned, documentsEmail: docEmail };
		else fields.documentsEmail = docEmail;
	}

	const haveCore = fields.orderNumber || (!requireOrderNumber && (fields.poNumber || fields.moveNumber || fields.trailerNumber));
	if (haveCore) return fields;

	// Deterministic scan came up empty — try Gemini if the route wired it, but
	// ONLY when there are actually bytes to send. A load with no rate-con on
	// file at all reaches here with pdfBuffer === null; calling the wrapper with
	// that threw "first argument must be ... Received null", which the route
	// logged as "Gemini fallback failed" — reading like a Gemini outage when the
	// real (and unremarkable) cause is "this load has no rate-con".
	if (typeof geminiExtract === "function" && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length) {
		try {
			const out = await geminiExtract(pdfBuffer);
			if (out && typeof out === "object") {
				const merged = mergeGeminiFields(fields, out);
				return merged;
			}
		} catch (err) {
			// Surface as empty fields; the route decides how to fail.
			if (opts.onGeminiError) opts.onGeminiError(err);
		}
	}

	return fields;
}

// Map the Gemini/Information-Extractor field names onto our shape. The
// extended schema returns "Order Number", "PO Number", "Move Number",
// "Trailer Number"; "Rate"/"Load Number" already exist in the base schema.
function mergeGeminiFields(base, out) {
	const pick = (clean, ...keys) => {
		for (const k of keys) {
			const v = out[k];
			if (v == null || !String(v).trim()) continue;
			const c = clean(v);
			if (c) return c;
		}
		return "";
	};
	// Only accept a Gemini total that is actually a positive amount. A "None"
	// / "$0.00" answer must NOT win, or it would shadow the route's fallback
	// to the sheet's Payment column with a truthy "$0.00".
	const geminiTotal = cleanRef(out["Total Rate"]) || cleanRef(out["Rate"]);
	return {
		orderNumber: base.orderNumber || pick(cleanNumericRef, "Order Number", "Order #", "Load Number"),
		poNumber: base.poNumber || pick(cleanRef, "PO Number", "PO #"),
		moveNumber: base.moveNumber || pick(cleanNumericRef, "Move Number", "Move #"),
		trailerNumber: base.trailerNumber || pick(cleanRef, "Trailer Number", "Trailer"),
		totalRate: base.totalRate || (parseMoney(geminiTotal) > 0 ? formatMoney(geminiTotal) : ""),
		// The deterministic pick is now a HIGH-CONFIDENCE, verified-in-document
		// address (it only returns a billing/docs local-part or a broker-domain
		// inbox), so it wins; Gemini's "Documents Email" fills in when the text
		// scan isn't confident enough or there is no text layer at all (a scanned
		// rate-con — Gemini reads the image where the regex sees nothing).
		documentsEmail: base.documentsEmail || normalizeEmail(out["Documents Email"]),
	};
}

// Normalize one reference number coming back from Gemini. It strips a
// leading "#" and the literal not-found answers ("None", "N/A") the model
// emits for absent fields — everything else is kept VERBATIM. PO and
// trailer ids are routinely alphanumeric (a real C.H. Robinson PO is
// "SHP2607-A3BJ112"); the old digits()-only normalization silently
// truncated that to "2607" and would have cited the wrong PO on the invoice.
function cleanRef(value) {
	const v = String(value == null ? "" : value).trim().replace(/^#+\s*/, "").trim();
	if (!v) return "";
	if (/^(none|n\/?a|null|nil|unknown|not\s+(provided|specified|available)|-+)$/i.test(v)) return "";
	return v;
}

// Order / Move numbers are numeric on every rate-con we've seen (Bison's
// are pure digits), so a purely-numeric value is normalized to its digit
// run — "7,007,280." -> "7007280". A value containing any letter is left
// alone rather than mangled.
function cleanNumericRef(value) {
	const v = cleanRef(value);
	if (!v || /[A-Za-z]/.test(v)) return v;
	// digits() keeps thousands separators ("7,007,280"); an order number is
	// an identifier, not an amount, so drop them.
	return (digits(v) || v).replace(/[,\s]/g, "");
}

function digits(s) {
	const m = String(s || "").match(/\d[\d.,]*/);
	return m ? m[0].replace(/[.,]+$/, "") : "";
}

// Regex the Bison "Billing Information" labels out of a flat text blob.
// Labels are matched case-insensitively and tolerate variable whitespace /
// an optional ":" so minor layout shifts between rate-con revisions still
// parse. Numbers are captured greedily up to the next non-digit.
function scanBillingBlock(text) {
	const t = String(text || "").replace(/ /g, " ");
	const grab = (re) => {
		const m = t.match(re);
		return m ? m[1].trim() : "";
	};
	// Each label is bounded on BOTH sides (\b...\b) so it can't match inside a
	// longer word — "trailers 53' or longer" was matching as Trailer -> "s53".
	const orderNumber = grab(/\bOrder\b\s*#?\s*:?\s*(\d{4,})/i);
	const poNumber = grab(/\bPO\b\s*#?\s*:?\s*(\d{4,})/i);
	const moveNumber = grab(/\bMove\b\s*#?\s*:?\s*(\d{4,})/i);
	// A real trailer id always carries at least one digit ("51237", "118013",
	// "TR-4501"). The old \w{2,} form matched prose — "Trailer are ...",
	// "Trailer Required" on C.H. Robinson / Navisphere rate-cons — and fed
	// that straight into the route's trailer-mismatch guard, which then
	// refused to draft the invoice (409) on a value that was never a trailer.
	const trailerNumber = grab(/\bTrailer\b\s*#?\s*:?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{2,})/i);
	let totalRate = grab(/\bTotal\s*Rate\b\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
	if (totalRate) totalRate = formatMoney(totalRate);
	return { orderNumber, poNumber, moveNumber, trailerNumber, totalRate };
}

// Extract the address the rate-con instructs paperwork/PODs/invoices be emailed
// to — the "email documents to …" note (in the additional-notes / delivery-
// instructions area, and on the BOL). Scores every email in the harvested text
// by proximity (~90 chars) to documents/billing keywords + a local-part
// heuristic; returns "" when nothing clears the bar, so the caller falls back
// rather than mailing to a random or the booking agent's personal address.
const _DOC_KW = /(document|paperwork|\bpod\b|b\.?\s?o\.?\s?l\.?|bill of lading|invoice|billing|accounts payable|accounting|remit|quick.?pay)/i;
const _SEND_KW = /(e-?mail|send|submit|forward|remit)/i;
const _DOC_LOCALPART = /^(billing|ap|accountspayable|accounts|accounting|invoices?|invoicing|documents?|docs|pod|paperwork|remit|bols?|quickpay)@/i;
// An invoice is billing, so a quick-pay / invoicing / billing inbox outranks a
// generic AP or documents address when a rate-con lists several (real case:
// MegaCorp prints quickpay@, ap@, AND the agent's — the invoice goes to quickpay@).
const _INVOICE_LOCALPART = /^(quickpay|billing|invoices?|invoicing|remit)@/i;
function extractDocumentsEmail(text, opts = {}) {
	const src = String(text == null ? "" : text);
	if (!src) return "";
	const exclude = String(opts.excludeEmail == null ? "" : opts.excludeEmail).trim().toLowerCase();
	// The invoice/billing inbox is almost always at the BROKER's own domain (the
	// booking agent's domain). That's what distinguishes it from a receiver's dock
	// / shipper contact that an "email the BOL at delivery" note might also list.
	const brokerDomain = exclude.includes("@") ? exclude.slice(exclude.indexOf("@") + 1) : "";
	const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
	let best = "", bestScore = 0, m;
	while ((m = re.exec(src)) !== null) {
		const email = m[0].replace(/[.,;>)\]]+$/, "");
		const low = email.toLowerCase();
		if (exclude && low === exclude) continue; // never the booking agent's own email
		const domain = low.slice(low.indexOf("@") + 1);
		const window = src.slice(Math.max(0, m.index - 90), m.index + email.length + 12);
		let score = 0;
		if (_DOC_KW.test(window)) score += 2;           // near a documents/billing word
		if (_SEND_KW.test(window)) score += 1;           // near a send/email verb
		if (_DOC_LOCALPART.test(low)) score += 2;        // billing@ / invoices@ / documents@ / pod@ ...
		if (_INVOICE_LOCALPART.test(low)) score += 1;    // quick-pay/invoicing inbox edges out generic AP/docs
		if (brokerDomain && domain === brokerDomain) score += 2; // at the broker's own domain
		// First email at the max score wins (rate-cons list the preferred inbox first).
		if (score > bestScore) { bestScore = score; best = email; }
	}
	// Require STRONG evidence: a billing/documents local-part, OR a broker-domain
	// address sitting next to a documents keyword. A lone "email the signed BOL to
	// <receiver's dock>" scores only 3 and is rejected → the caller falls back to
	// the default (or Gemini) rather than invoicing the broker's own customer.
	return bestScore >= 4 ? best : "";
}

// Best-effort PDF -> text without a third-party parser. Two passes:
//   (a) Inflate every FlateDecode stream (the common case — content
//       streams are zlib-compressed) and harvest text-showing operators.
//   (b) Harvest text from any uncompressed regions too.
// We pull the strings inside Tj / TJ text operators: `( ... ) Tj` and
// `[ (..) -250 (..) ] TJ`. Good enough to recover the Billing Information
// labels + numbers, which is all extractRateConFields needs.
function extractPdfText(buffer) {
	const zlib = require("zlib");
	const chunks = [];

	// (a) Inflate FlateDecode streams.
	const raw = buffer;
	let idx = 0;
	while (true) {
		const sIdx = raw.indexOf("stream", idx);
		if (sIdx === -1) break;
		// Move past "stream" + EOL (\r\n or \n).
		let dataStart = sIdx + 6;
		if (raw[dataStart] === 0x0d) dataStart++;
		if (raw[dataStart] === 0x0a) dataStart++;
		const eIdx = raw.indexOf("endstream", dataStart);
		if (eIdx === -1) break;
		let dataEnd = eIdx;
		// Trim trailing EOL before endstream.
		if (raw[dataEnd - 1] === 0x0a) dataEnd--;
		if (raw[dataEnd - 1] === 0x0d) dataEnd--;
		const slice = raw.slice(dataStart, dataEnd);
		try {
			const inflated = zlib.inflateSync(slice);
			chunks.push(inflated.toString("latin1"));
		} catch {
			try {
				const inflated = zlib.inflateRawSync(slice);
				chunks.push(inflated.toString("latin1"));
			} catch {
				// Not a zlib stream (image/font/uncompressed) — keep raw text.
				chunks.push(slice.toString("latin1"));
			}
		}
		idx = eIdx + 9;
	}

	// (b) Whole-file latin1 view catches any plainly-embedded text.
	chunks.push(raw.toString("latin1"));

	const blob = chunks.join("\n");
	return harvestPdfStrings(blob);
}

// Pull human text out of PDF content-stream operators. Concatenates the
// literal strings shown by Tj/TJ, decoding the handful of PDF string
// escapes we care about. Falls back to returning the blob if no operators
// are found (so a plain-text PDF still scans).
function harvestPdfStrings(blob) {
	const out = [];
	let found = false;

	// `( literal ) Tj`  and the array form `[ (a) (b) ] TJ`.
	// Match any parenthesized string followed (eventually) by Tj/TJ on the
	// operator side. Simpler + robust: collect ALL (..) literals that sit
	// inside a text block (BT..ET) or anywhere, then join. Numbers/labels
	// in the Billing block are individual Tj strings, so order is preserved.
	const re = /\(((?:\\.|[^\\()])*)\)/g;
	let m;
	while ((m = re.exec(blob)) !== null) {
		found = true;
		out.push(decodePdfLiteral(m[1]));
	}

	if (!found) return blob;
	// Space-join so adjacent Tj tokens ("Order #:" , "7007280") stay split
	// into words the regex scanner can match across.
	return out.join(" ");
}

function decodePdfLiteral(s) {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
		.replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// ------------------------------------------------------------
// buildInvoiceHtml — renders the LogisX invoice layout (LogisX branding only).
// Dynamic fields: invoiceId, invoiceDate, brokerName, invoiceTo,
// orderNumber, poNumber, deliveryDate, total. Everything else is static
// (constants above). `invoiceTo` is a { name, email } pair — pass the
// output of resolveInvoiceTo(); it defaults to the non-Bison quickpay
// target so a caller that forgets still produces a sane document.
// ------------------------------------------------------------
function buildInvoiceHtml(fields = {}) {
	const invoiceId = esc(fields.invoiceId || "");
	const invoiceDate = esc(formatDate(fields.invoiceDate) || fields.invoiceDate || "");
	const orderNumber = esc(fields.orderNumber || "");
	const poNumber = esc(fields.poNumber || "");
	const deliveryDate = esc(formatDate(fields.deliveryDate) || fields.deliveryDate || "");
	const totalStr = formatMoney(fields.total);
	const invoiceTo = fields.invoiceTo || resolveInvoiceTo({});
	// "Bison Transport Order: #7007280" for Bison — identical to the old
	// hardcoded line — and "<Broker> Order: #<n>" for everyone else. Falls
	// back to a bare "Order: #<n>" when the broker can't be resolved.
	const orderLine = fields.brokerName
		? `${esc(fields.brokerName)} Order: #${orderNumber}`
		: `Order: #${orderNumber}`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LogisX Invoice ${invoiceId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
<style>
@page { size: letter; margin: 0.6in; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: 'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
	color: #1f2937;
	font-size: 13px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}
.invoice { width: 100%; }

/* --- Masthead --- */
.masthead { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 36px; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand img { height: 40px; width: auto; display: block; }
.masthead .meta { text-align: right; }
.masthead .meta .title { font-size: 40px; font-weight: 800; letter-spacing: 3px; color: #0f2847; line-height: 1; margin-bottom: 10px; }
.masthead .meta .row { font-size: 12px; color: #475569; }
.masthead .meta .row strong { color: #1f2937; font-weight: 700; }

/* --- Parties --- */
.parties { display: flex; justify-content: space-between; margin-bottom: 28px; }
.parties .block { font-size: 12px; }
.parties .label { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
.parties .name { font-weight: 700; font-size: 14px; color: #0f2847; }
.parties .line { color: #475569; }
.parties .to { text-align: left; }

/* --- Line-item table --- */
table.items { width: 100%; border-collapse: collapse; margin-bottom: 22px; }
table.items thead th {
	background: #0f2847; color: #fff; font-size: 10px; font-weight: 700;
	letter-spacing: 1px; text-transform: uppercase; text-align: left;
	padding: 11px 14px;
}
table.items thead th.num { text-align: right; }
table.items tbody td { padding: 14px; border-bottom: 1px solid #e2e8f0; vertical-align: top; font-size: 12px; color: #334155; }
table.items tbody td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.items .item-title { font-weight: 700; color: #0f2847; }
table.items .item-sub { color: #64748b; font-size: 11px; margin-top: 2px; }

/* --- Totals --- */
.totals { display: flex; justify-content: flex-end; margin-bottom: 34px; }
.totals .box { width: 270px; }
.totals .subtotal { display: flex; justify-content: space-between; padding: 6px 14px; font-size: 12px; color: #475569; }
.totals .subtotal .amt { font-variant-numeric: tabular-nums; color: #1f2937; }
.totals .pill {
	display: flex; justify-content: space-between; align-items: center;
	background: #0f2847; color: #fff; border-radius: 8px;
	padding: 12px 16px; margin-top: 6px;
}
.totals .pill .lbl { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; }
.totals .pill .amt { font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; }

/* --- Payment method --- */
.payment { border-top: 2px solid #0f2847; padding-top: 16px; margin-bottom: 40px; }
.payment .label { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #0f2847; margin-bottom: 10px; }
.payment .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 32px; font-size: 12px; }
.payment .grid div { color: #475569; }
.payment .grid strong { color: #1f2937; font-weight: 700; }

/* --- Footer --- */
.thanks { text-align: center; font-size: 16px; font-weight: 700; color: #0f2847; letter-spacing: 0.3px; }
</style>
</head>
<body>
<div class="invoice">

	<div class="masthead">
		<div class="brand">
			<img src="${LOGISX_LOGO_URL}" alt="LogisX">
		</div>
		<div class="meta">
			<div class="title">INVOICE</div>
			<div class="row">Invoice ID # : <strong>${invoiceId}</strong></div>
			<div class="row">Date: <strong>${invoiceDate}</strong></div>
		</div>
	</div>

	<div class="parties">
		<div class="block from">
			<div class="name">${esc(SELLER.companyName)}</div>
			<div class="line">${esc(SELLER.email)}</div>
			<div class="line">${esc(SELLER.phone)}</div>
		</div>
		<div class="block to">
			<div class="label">Invoice To</div>
			<div class="name">${esc(invoiceTo.name)}</div>
			<div class="line">${esc(invoiceTo.email)}</div>
		</div>
	</div>

	<table class="items">
		<thead>
			<tr>
				<th>Load ID#</th>
				<th>Delivery Date</th>
				<th class="num">Total</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td>
					<div class="item-title">${orderLine}</div>
					${poNumber ? `<div class="item-sub">PO #: ${poNumber}</div>` : ""}
				</td>
				<td>${deliveryDate}</td>
				<td class="num">${totalStr}</td>
			</tr>
		</tbody>
	</table>

	<div class="totals">
		<div class="box">
			<div class="subtotal"><span>SUB-TOTAL</span><span class="amt">${totalStr}</span></div>
			<div class="pill"><span class="lbl">Total</span><span class="amt">${totalStr}</span></div>
		</div>
	</div>

	<div class="payment">
		<div class="label">Payment Method</div>
		<div class="grid">
			<div><strong>Name:</strong> ${esc(PAYMENT_METHOD.name)}</div>
			<div><strong>Bank Name:</strong> ${esc(PAYMENT_METHOD.bankName)}</div>
			<div><strong>Address:</strong> ${esc(PAYMENT_METHOD.address)}</div>
			<div><strong>Bank Routing #:</strong> ${esc(PAYMENT_METHOD.bankRouting)}</div>
			<div><strong>E-mail:</strong> ${esc(PAYMENT_METHOD.email)}</div>
			<div><strong>Bank Account #:</strong> ${esc(PAYMENT_METHOD.bankAccount)}</div>
		</div>
	</div>

	<div class="thanks">Thank You For Your Business</div>

</div>
</body>
</html>`;
}

// Standard invoice email body + LogisX signature footer, used when the Draft
// Invoice Email endpoint creates the Gmail draft. Dynamic: brokerName,
// orderNumber, moveNumber, poNumber.
//
// The Move #/PO # sentence is emitted ONLY for the values that exist. Bison
// rate-cons carry both (and render exactly as they always have); most other
// brokers supply one or neither, and "...is  &amp; PO #" reads like a bug to
// the recipient.
function buildInvoiceEmailHtml(fields = {}) {
	const brokerName = esc(fields.brokerName || "");
	const orderNumber = esc(fields.orderNumber || "");
	const moveNumber = esc(fields.moveNumber || "");
	const poNumber = esc(fields.poNumber || "");
	const loadNumber = esc(fields.loadNumber || fields.orderNumber || "");
	const isBison = !!fields.isBison;

	const open = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000">`;
	// Shared LogisX signature + confidentiality footer — identical for every broker.
	const signature =
		`<p>--<br>LogisX Inc.<br>321*848*3437<br><a href="https://www.LogisX.com">www.LogisX.com</a></p>` +
		`<p><img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:32px"></p>` +
		`<p style="font-size:10px;color:#8a8a8a;line-height:1.5">CONFIDENTIALITY/PRIVILEGE: This communication is intended only for the named recipient(s). It may contain legally privileged or otherwise protectible information. The sender accepts no liability, including, without limitation, liability for negligence, in respect of any information in this communication. If you receive this e-mail in error, please notify the sender and delete it. Thank you for your cooperation.</p>`;

	// Non-Bison (client 2026-07-30): the Order #/PO #/driver-ID summary is a
	// Bison-only format. Every other broker gets a plain cover note keyed on the
	// LOAD number, naming the attachments — no "purchase order" language.
	if (!isBison) {
		return (
			open +
			`<p>Hello,</p>` +
			`<p>Please see the attached documents for load number ${loadNumber}: the rate confirmation, the signed POD, and the invoice.</p>` +
			`<p>Please contact us if there is any issue.</p>` +
			`<p>Thank you,</p>` +
			signature +
			`</div>`
		);
	}

	// Bison: byte-identical to the long-standing wording (Order # + Move/PO summary).
	const orderLabel = brokerName ? `${brokerName} Order # ${orderNumber}` : `Order # ${orderNumber}`;
	let refs = "";
	if (moveNumber && poNumber) refs = ` The driver ID number for pickup is ${moveNumber} &amp; PO #${poNumber}`;
	else if (moveNumber) refs = ` The driver ID number for pickup is ${moveNumber}.`;
	else if (poNumber) refs = ` PO #${poNumber}.`;
	return (
		open +
		`<p>Hello,</p>` +
		`<p>Please find the attached invoice and supporting documentation for ${orderLabel}.${refs}</p>` +
		`<p>Best regards,</p>` +
		signature +
		`</div>`
	);
}

module.exports = {
	buildInvoiceHtml,
	buildInvoiceEmailHtml,
	isBisonLoad,
	resolveBrokerName,
	resolveInvoiceTo,
	findPaymentColumn,
	parseMoney,
	extractRateConFields,
	// presentation + internals exported for the route and for tests
	formatMoney,
	formatDate,
	humanizeDomain,
	scanBillingBlock,
	extractPdfText,
	extractDocumentsEmail,
	normalizeEmail,
	SELLER,
	BROKER_DOMAIN_NAMES,
	BISON_INVOICE_EMAIL,
	DEFAULT_INVOICE_EMAIL,
	PAYMENT_METHOD,
};
