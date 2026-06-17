// ============================================================
// Bison Draft-Invoice builder
// ============================================================
// Pure helpers for the "Draft Invoice Email" feature on completed Bison
// loads. Kept out of server.js so the data-shaping + HTML layout can be
// unit-reasoned about and tested in isolation. server.js wires these into
// the POST /api/loads/:loadId/draft-bison-invoice route.
//
// Nothing here touches the network or the DB — callers pass in already-
// fetched bytes/rows. The two exceptions are clearly-scoped: a deterministic
// rate-con text scan (pure, over a Buffer) and an optional Gemini fallback
// (network) that is only reached when the deterministic scan comes up empty.
//
// Exports:
//   buildInvoiceHtml(fields)         -> HTML string for renderHtmlToPdf()
//   isBisonLoad(load)                -> bool (broker email ends @bisontransport.com)
//   extractRateConFields(pdfBuffer, opts) -> Promise<{orderNumber,...}>
//   formatMoney(n) / formatDate(d)   -> presentation helpers (exported for the route)

"use strict";

// ------------------------------------------------------------
// Static company / payment constants (never vary per invoice)
// ------------------------------------------------------------
const SELLER = {
	companyName: "Logistics Exchange Inc.",
	email: "info@logisx.com",
	phone: "+1(321)-848-3437",
};

const INVOICE_TO = {
	name: "Bison Transport",
	email: "QPinvoicesUSA@bisontransport.com",
};

const PAYMENT_METHOD = {
	name: "LogisX Inc.",
	address: "1619 N Frazier St. Unit #441, Conroe, TX 77301",
	email: "info@logisx.com",
	bankName: "COASTAL COMMUNITY BANK",
	bankRouting: "125109019",
	bankAccount: "875105081223",
};

// LogisX logo is served from the production app; SandHub has no asset in
// client/public, so it renders as a clean text lockup next to the logo.
const LOGISX_LOGO_URL = "https://app.logisx.com/logo.avif";

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
// extractRateConFields
// ------------------------------------------------------------
// Returns { orderNumber, poNumber, moveNumber, trailerNumber, totalRate }
// from a Bison rate-con PDF.
//
// Strategy:
//   1. Deterministic text scan. The Bison rate-con carries a real text
//      layer with a "Billing Information" block:
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

	let fields = { orderNumber: "", poNumber: "", moveNumber: "", trailerNumber: "", totalRate: "" };

	if (Buffer.isBuffer(pdfBuffer) && pdfBuffer.length) {
		const text = extractPdfText(pdfBuffer);
		fields = scanBillingBlock(text);
	}

	const haveCore = fields.orderNumber || (!requireOrderNumber && (fields.poNumber || fields.moveNumber || fields.trailerNumber));
	if (haveCore) return fields;

	// Deterministic scan came up empty — try Gemini if the route wired it.
	if (typeof geminiExtract === "function") {
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
	const pick = (...keys) => {
		for (const k of keys) {
			const v = out[k];
			if (v != null && String(v).trim()) return digits(String(v));
		}
		return "";
	};
	return {
		orderNumber: base.orderNumber || pick("Order Number", "Order #", "Load Number"),
		poNumber: base.poNumber || pick("PO Number", "PO #"),
		moveNumber: base.moveNumber || pick("Move Number", "Move #"),
		trailerNumber: base.trailerNumber || pick("Trailer Number", "Trailer"),
		totalRate:
			base.totalRate ||
			(out["Total Rate"] || out["Rate"]
				? formatMoney(out["Total Rate"] || out["Rate"])
				: ""),
	};
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
	const orderNumber = grab(/\bOrder\s*#?\s*:?\s*(\d{4,})/i);
	const poNumber = grab(/\bPO\s*#?\s*:?\s*(\d{4,})/i);
	const moveNumber = grab(/\bMove\s*#?\s*:?\s*(\d{4,})/i);
	const trailerNumber = grab(/\bTrailer\s*#?\s*:?\s*(\w{2,})/i);
	let totalRate = grab(/\bTotal\s*Rate\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
	if (totalRate) totalRate = formatMoney(totalRate);
	return { orderNumber, poNumber, moveNumber, trailerNumber, totalRate };
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
// buildInvoiceHtml — reproduces the real LogisX | SandHub invoice layout.
// Dynamic fields: invoiceId, invoiceDate, orderNumber, poNumber,
// deliveryDate, total. Everything else is static (constants above).
// ------------------------------------------------------------
function buildInvoiceHtml(fields = {}) {
	const invoiceId = esc(fields.invoiceId || "");
	const invoiceDate = esc(formatDate(fields.invoiceDate) || fields.invoiceDate || "");
	const orderNumber = esc(fields.orderNumber || "");
	const poNumber = esc(fields.poNumber || "");
	const deliveryDate = esc(formatDate(fields.deliveryDate) || fields.deliveryDate || "");
	const totalStr = formatMoney(fields.total);

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
.brand .divider { width: 1px; height: 34px; background: #cbd5e1; }
.brand .sandhub { display: flex; flex-direction: column; line-height: 1; }
.brand .sandhub .sh-name { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; color: #0f2847; }
.brand .sandhub .sh-name .hub { color: #f59e0b; }
.brand .sandhub .sh-tag { font-size: 8px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #94a3b8; margin-top: 3px; }
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
			<div class="divider"></div>
			<div class="sandhub">
				<div class="sh-name">Sand<span class="hub">Hub</span></div>
				<div class="sh-tag">Logistics</div>
			</div>
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
			<div class="name">${esc(INVOICE_TO.name)}</div>
			<div class="line">${esc(INVOICE_TO.email)}</div>
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
					<div class="item-title">Bison Transport Order: #${orderNumber}</div>
					<div class="item-sub">PO #: ${poNumber}</div>
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

// Standard Bison invoice email body + LogisX signature footer, used when the
// Draft Invoice Email endpoint creates the Gmail draft. Dynamic: orderNumber,
// moveNumber, poNumber.
function buildBisonEmailHtml(fields = {}) {
	const orderNumber = esc(fields.orderNumber || "");
	const moveNumber = esc(fields.moveNumber || "");
	const poNumber = esc(fields.poNumber || "");
	return (
		`<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000">` +
		`<p>Hello,</p>` +
		`<p>Please find the attached invoice and supporting documentation for Bison Transport Order # ${orderNumber}. The driver ID number for pickup is ${moveNumber} &amp; PO #${poNumber}</p>` +
		`<p>Best regards,</p>` +
		`<p>--<br>LogisX Inc.<br>321*848*3437<br><a href="https://www.LogisX.com">www.LogisX.com</a></p>` +
		`<p><img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:32px"></p>` +
		`<p style="font-size:10px;color:#8a8a8a;line-height:1.5">CONFIDENTIALITY/PRIVILEGE: This communication is intended only for the named recipient(s). It may contain legally privileged or otherwise protectible information. The sender accepts no liability, including, without limitation, liability for negligence, in respect of any information in this communication. If you receive this e-mail in error, please notify the sender and delete it. Thank you for your cooperation.</p>` +
		`</div>`
	);
}

module.exports = {
	buildInvoiceHtml,
	buildBisonEmailHtml,
	isBisonLoad,
	extractRateConFields,
	// presentation + internals exported for the route and for tests
	formatMoney,
	formatDate,
	scanBillingBlock,
	extractPdfText,
	SELLER,
	INVOICE_TO,
	PAYMENT_METHOD,
};
