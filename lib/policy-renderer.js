// Main policy renderer. Loads an HTML template, lets its own scripts execute
// (important for service-invoice.html which generates 7 day rows dynamically),
// then fills all <input> values and checkbox states via DOM manipulation inside
// the Puppeteer page context, then exports to PDF.
//
// Unified path for all 5 driver docs — no cheerio, no static substitution,
// one code path that handles both static and JS-generated DOM trees.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { openPageWithContent } = require("./pdf-browser");
const POLICY_FIELD_MAPS = require("./policy-field-maps");
const { SIGNATURE_DATA_URI_MAX_LENGTH } = require("./image-size");
const { safeReceiptImage, isReceiptAnchor, RECEIPT_SHEETS_MAX, RECEIPT_PDF_SHEET_PAGES_MAX } = require("./invoice-receipts");
const { applyPaymentTermsToHtml, renderFieldsFor } = require("./investor-payment-terms");

const TEMPLATE_DIR = path.join(__dirname, "..", "onboarding-templates", "policy");

// Brand logo embedded as a data URI so the rendered PDF is self-contained
// (Puppeteer setContent has no base URL, and we want dev/prod parity).
// Source of truth: <repo-root>/logo.png — the canonical invoice logo
// supplied by the client.
const LOGO_PATH = path.join(__dirname, "..", "logo.png");
const LOGO_DATA_URI = fs.existsSync(LOGO_PATH)
	? `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`
	: "";

const DOC_FILES = {
	contractor_agreement: "contractor-agreement.html",
	equipment_policy: "equipment-policy.html",
	mobile_policy: "mobile-policy.html",
	substance_policy: "substance-policy.html",
	service_invoice: "service-invoice.html",
	service_invoice_owner_op: "service-invoice-owner-op.html",
	service_invoice_manual: "service-invoice-manual.html",
	// Investor docs — HTML templates will land when user finishes drafting
	master_agreement: "master-agreement.html",
	vehicle_lease: "vehicle-lease.html",
	// Optional, filed by a driver for a rider; not one of the onboarding documents.
	passenger_authorization: "passenger-authorization.html",
};

// Signatures in this app are ALWAYS captured client-side as canvas.toDataURL(),
// i.e. an inline base64 data: URI. Anything else -- above all an http(s):// URL --
// becomes a URL that the RENDER HOST fetches when it is assigned to img.src below,
// which is a blind SSRF: whoever controls this value can make the server request
// internal addresses (cloud metadata, the other pm2 apps on the same VPS) and can
// port-scan by timing. It is reachable from an UNAUTHENTICATED route
// (POST /api/public/investor-preview-pdf/:docKey), so it is sanitized here -- at the
// single sink every render path shares -- rather than at any one call site.
//
// This is an allowlist ON PURPOSE, not a blocklist of internal IPs: a blocklist
// loses to DNS rebinding, redirects, IPv6 and decimal-encoded addresses. Raster
// types only -- SVG is excluded because its parser can reach for external
// resources, and no legitimate caller ever sends one.
const SIGNATURE_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/\s]+={0,2}$/i;

function safeSignatureImage(value) {
	if (typeof value !== "string") return null;
	// Bounded before anything else reads it. The routes that accept a signature
	// already refuse one this large (lib/image-size.js), so no real signature is
	// lost here; this keeps every render path to the same ceiling.
	if (value.length > SIGNATURE_DATA_URI_MAX_LENGTH) return null;
	const v = value.trim();
	if (!v) return null;
	return SIGNATURE_DATA_URI_RE.test(v) ? v : null;
}

// Per-label signature images (fields.signatureImagesByLabel), for a document
// several parties sign by hand. Each is checked like the single image above and
// bound to a label the document fills, so it can only land on that label's own
// slots; no document has more than three signers.
const SIGNATURE_IMAGES_MAX = 3;

function safeSignatureImages(map, text, docKey = "") {
	const out = Object.create(null);
	if (!map || typeof map !== "object") return out;
	const proto = Object.getPrototypeOf(map);
	if (proto !== Object.prototype && proto !== null) return out;
	const labels = text && typeof text === "object" ? text : {};
	let kept = 0;
	for (const label of Object.keys(map)) {
		// The label only, bounded: the value is what is being refused.
		const named = JSON.stringify(String(label).slice(0, 80));
		if (kept >= SIGNATURE_IMAGES_MAX) {
			console.warn(`renderPolicy: dropped the signature image for ${named} on "${docKey}" (more than ${SIGNATURE_IMAGES_MAX})`);
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(labels, label)) {
			console.warn(`renderPolicy: dropped the signature image for ${named} on "${docKey}" (not a field of this document)`);
			continue;
		}
		const value = map[label];
		const safe = safeSignatureImage(value);
		if (!safe) {
			if (value) console.warn(`renderPolicy: refused a non-data: signature image for ${named} on "${docKey}" (possible SSRF attempt)`);
			continue;
		}
		out[label] = safe;
		kept++;
	}
	return out;
}

// Receipt sheets (weekly invoices), checked here at the sink as well as in the
// field map: each under a "receipt-N" anchor (the target of the line's link),
// at most RECEIPT_SHEETS_MAX. An image sheet's img.src is only a re-encoded
// JPEG data URI within its cap (lib/invoice-receipts.js safeReceiptImage()); a
// PDF receipt's sheet has no image, only the whole number of its pages that
// the server inserts after it and the note saying so.
function safeReceiptPages(pages) {
	return (Array.isArray(pages) ? pages : [])
		.map((p) => {
			if (!p || !isReceiptAnchor(p.anchor)) return null;
			const header = String(p.header || "").slice(0, 300);
			if (safeReceiptImage(p.image)) return { anchor: p.anchor, header, image: p.image };
			const n = p.pdfPages;
			if (p.image || !Number.isInteger(n) || n < 1 || n > RECEIPT_PDF_SHEET_PAGES_MAX) return null;
			return { anchor: p.anchor, header, image: null, pdfPages: n, note: String(p.note || "").slice(0, 120) };
		})
		.filter(Boolean)
		.slice(0, RECEIPT_SHEETS_MAX);
}

// A value worth asserting on. An empty string is a legitimate "nothing to say"
// — every preview render passes signatureText: "" — so only non-empty asks are
// ever held against the template.
function isAsked(value) {
	return value != null && String(value).trim() !== "";
}

// Refuse a PDF that does not contain what it claims to.
//
// Two independent rules, because they fail in different ways:
//
//  1. DECLARED REQUIRED LABELS (fields.requiredText, see policy-field-maps.js).
//     Catches the realistic case: one label renamed in the template, or one key
//     renamed in the field map, silently voiding the signature line while the
//     other 17 fields still fill. A count-based rule cannot see this — 17 of 18
//     looks healthy.
//
//  2. ZERO-FILL BACKSTOP. Catches wholesale drift (a template replaced, a
//     markup rewrite that dropped every aria-label) for the docs that declare no
//     required set — today the three invoice templates.
//
// ⚠️ This asserts the value reached the DOM, NOT that it is visible in the
// rasterised page. A field hidden by CSS still verifies. That is a deliberate
// boundary: it covers the named failure mode (renamed/removed labels) cheaply
// and with no false positives, where a visibility test would depend on print-vs
// -screen media emulation and start refusing valid documents.
//
// ⚠️ The message names LABELS, never values — it is stored in
// onboarding_documents.signing_error and emailed by alertOnboardingDocFailure(),
// and these documents carry SSNs, EINs and bank account numbers.
function assertDocumentFilled(docKey, fields, report) {
	const asked = fields.text ? Object.entries(fields.text) : [];
	const askedNonEmpty = asked.filter(([, v]) => isAsked(v));
	if (!askedNonEmpty.length) return; // nothing was asked for; nothing to prove

	const verified = new Set(report && report.verified ? report.verified : []);

	const required = Array.isArray(fields.requiredText) ? fields.requiredText : [];
	const text = fields.text || {};
	// Drift has two directions and both void the document, so both are refused:
	//   (a) the TEMPLATE renamed the aria-label   -> asked, non-empty, not verified
	//   (b) the FIELD MAP renamed its key         -> the label is not asked at all
	// (b) is not hypothetical bookkeeping: `requiredText` sits a few lines from
	// `text` in the same mapper, so renaming one and not the other is the easiest
	// mistake to make here — and it would silently disarm this very check.
	// A label that IS asked but with an empty value is skipped: every preview
	// render passes signatureText: "", which is a legitimate "nothing to say".
	const unfilled = required.filter(
		(label) => !Object.prototype.hasOwnProperty.call(text, label) || (isAsked(text[label]) && !verified.has(label)),
	);
	if (unfilled.length) {
		const e = new Error(
			`"${docKey}" rendered without its required field(s): ${unfilled.join(", ")}. ` +
			`The template and the field map no longer agree, so the document would be blank where it matters.`,
		);
		e.code = "DOCUMENT_FIELDS_UNFILLED";
		throw e;
	}

	if (!verified.size) {
		const e = new Error(
			`"${docKey}" rendered with none of its ${askedNonEmpty.length} field(s) filled — the template and the field map no longer agree.`,
		);
		e.code = "DOCUMENT_FIELDS_UNFILLED";
		throw e;
	}
}

// The template's HTML as it is rendered. `data.paymentTerms` selects the
// payment-terms slot variants of the two investor contracts
// (lib/investor-payment-terms.js); without it every slot keeps its default
// lines and the result is the template file's own bytes, as before.
function prepareTemplateHtml(docKey, data = {}) {
	const fileName = DOC_FILES[docKey];
	if (!fileName) throw new Error(`Unknown onboarding doc: ${docKey}`);
	const filePath = path.join(TEMPLATE_DIR, fileName);
	if (!fs.existsSync(filePath)) throw new Error(`Template missing: ${filePath}`);

	let html = fs.readFileSync(filePath, "utf-8");
	html = applyPaymentTermsToHtml(html, docKey, data.paymentTerms ?? null);
	return html.replace(/\{\{LOGO_SRC\}\}/g, LOGO_DATA_URI);
}

// The field descriptor the fill step below consumes. The payment-terms labels
// are merged in only when `data.paymentTerms` is set, and they join
// `requiredText`: a contract whose agreed terms did not reach the page is
// refused like one without its signer's name.
function buildRenderFields(docKey, data = {}) {
	const mapper = POLICY_FIELD_MAPS[docKey];
	if (!mapper) throw new Error(`No field map registered for: ${docKey}`);
	const fields = mapper(data);
	if (data.paymentTerms != null) {
		const termsText = renderFieldsFor(docKey, data.paymentTerms);
		fields.text = { ...(fields.text || {}), ...termsText };
		fields.requiredText = [...(Array.isArray(fields.requiredText) ? fields.requiredText : []), ...Object.keys(termsText)];
	}
	return fields;
}

async function renderPolicy(docKey, data = {}) {
	const html = prepareTemplateHtml(docKey, data);
	const fields = buildRenderFields(docKey, data);

	// Harden the fields that become a URL the render host fetches (img.src): the
	// single signature image and the per-label ones. Dropped rather than thrown so
	// a malformed signature can never take down a legal-document render; callers
	// that accept one from a request body should reject it with a 400 first (see
	// the public preview route in server.js).
	const safeSig = safeSignatureImage(fields.signatureImage);
	if (fields.signatureImage && !safeSig) {
		console.warn(`renderPolicy: refused non-data: signatureImage for "${docKey}" (possible SSRF attempt)`);
	}
	fields.signatureImage = safeSig;
	fields.signatureImagesByLabel = safeSignatureImages(fields.signatureImagesByLabel, fields.text, docKey);

	fields.receiptPages = safeReceiptPages(fields.receiptPages);

	// setContent (so we need no HTTP server to serve the template) + the
	// document.fonts.ready wait, via the SHARED helper in pdf-browser.js.
	//
	// ⚠️ This used to be a local copy of those two lines. That copy is exactly
	// why the cold-start navigation timeout hit onboarding and policy documents
	// too — see the long note in lib/pdf-browser.js. The fix has to live in one
	// place or the next person fixes renderHtmlToPdf() and leaves this path
	// broken all over again. The page comes back loaded and is ours to close.
	const page = await openPageWithContent(html);
	try {

		// Let any template scripts run their work (service-invoice.html generates 7 rows)
		// then populate every field. All DOM work happens inside the browser context.
		//
		// The evaluate now RETURNS a fill report. Every unmatched aria-label used to
		// be dropped on the floor by `if (!el) continue`, so a template edit that
		// renamed a label produced a perfectly well-formed PDF with the signer's name
		// missing from it — and the artifact checks in writeSignedArtifact() (%PDF
		// magic, >= 1000 bytes, re-stat) all passed, because they prove a FILE exists,
		// not that it says anything. Measured: renaming two labels on the equipment
		// policy moved the output from 132,898 to 131,916 bytes and dropped the
		// signer's name from 2 occurrences to 0, and both PDFs were accepted.
		const fillReport = await page.evaluate((fields) => {
			const {
				text,
				checkboxesById,
				checkboxesByLabel,
				dayCompletedByIndex,
				signatureImage,
				signatureLabelForImage,
				signatureImagesByLabel,
			} = fields;

			// Fill outcome per asked label, so the caller can assert on it. `verified`
			// means the value is demonstrably in the DOM afterwards, not merely that
			// an element with that label was found — an element we cannot write to
			// looks identical to a successful fill from the outside.
			const verified = [];
			const mismatched = [];
			const missed = [];

			// --- 1. Fill text inputs by aria-label ---
			// Signature image replacement is EXPLICIT — only the label matching
			// `signatureLabelForImage` gets the drawn image. Every other signature
			// slot (counter-signer name, recipient, manager, lessor) stays as typed
			// text so the drawn signature doesn't end up on both sides of a contract.
			// A document several parties sign by hand names each image by its own
			// label instead (`signatureImagesByLabel`, checked at the sink above).
			//
			// ⚠️ querySelectorAll, NOT querySelector. A label repeated in a template
			// used to fill ONLY its first occurrence and leave every later one blank —
			// on a document that was then signed and stored. Measured on the shipped
			// templates: the vehicle lease's VEHICLE DELIVERY & CONDITION RECEIPT
			// acceptance lines and its entire INVESTOR/PARTICIPANT APPLICATION page
			// rendered empty, and 2 of the master agreement's 3 participant signature
			// slots did too — while the UNIQUE labels beside them (DBA, Entity Type,
			// the acknowledgment DATE) filled normally. A dated-but-unsigned
			// acknowledgment is the tell: that was never a design, it was this bug.
			//
			// ⚠️ Filling every match is only safe because NO duplicated label spans two
			// different parties — every repeat is the SAME party signing or identifying
			// itself in several places of one bundled document (lease + delivery receipt
			// + application; agreement + Exhibit A + Schedule A). Cross-party bleed is
			// prevented by a SEPARATE mechanism — each party owns a distinct label
			// ("Lessor signature" vs "Lessee signature", "Manager signature" vs
			// "Participant signature") — which this loop does not touch. If you ever add
			// a label shared by two parties, that invariant breaks and this loop would
			// put one party's signature over the other's line: give the second slot its
			// own label instead.
			if (text) {
				for (const [label, value] of Object.entries(text)) {
					const els = document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`);
					if (!els.length) { missed.push(label); continue; }

					// The label's own image when the map has one (own property only),
					// else the single-label rule.
					const labelImage =
						signatureImagesByLabel && Object.prototype.hasOwnProperty.call(signatureImagesByLabel, label)
							? signatureImagesByLabel[label]
							: signatureImage && signatureLabelForImage && label === signatureLabelForImage
								? signatureImage
								: null;
					const shouldEmbedImage = typeof labelImage === "string" && labelImage !== "";

					const want = value == null ? "" : String(value);
					// A label counts as verified only when EVERY one of its slots ends up
					// carrying the value. Crediting the first match would re-hide exactly
					// the partial fill this change exists to stop.
					let allOk = true;
					for (const el of els) {
						if (shouldEmbedImage) {
							// Replace input with an <img> so the drawn signature renders in-place.
							// Built fresh per slot — one DOM node cannot live in two places.
							const img = document.createElement("img");
							img.src = labelImage;
							img.alt = "Signature";
							// max-width is as load-bearing as max-height: the height cap alone
							// lets a wide capture canvas (e.g. 2000x50) scale to ~1600px and run
							// off a 624px content box. Harmless-looking until now, because this
							// filled ONE slot per document; it now fills 2-3, so the same bad
							// signature would overflow every one of them.
							img.style.cssText =
								"max-height:40px; max-width:100%; display:inline-block; vertical-align:middle; padding:0 4px; border-bottom:1px solid #000;";
							el.replaceWith(img);
							// The drawn signature replaced the typed one; the slot is filled
							// iff the image actually carries a source.
							if (!img.getAttribute("src")) allOk = false;
						} else if (el.tagName === "INPUT") {
							// Set both the attribute AND the value property so the rendered PDF
							// shows the value regardless of how Chromium decides to paint it.
							el.setAttribute("value", want);
							el.value = want;
							if (el.value !== want) allOk = false;
						} else {
							el.textContent = want;
							if (el.textContent !== want) allOk = false;
						}
					}
					(allOk ? verified : mismatched).push(label);
				}
			}

			// --- 2. Checkboxes by element id (contractor agreement payment method) ---
			if (checkboxesById) {
				for (const [id, checked] of Object.entries(checkboxesById)) {
					const el = document.getElementById(id);
					if (!el) continue;
					if (checked) {
						el.setAttribute("checked", "checked");
						el.checked = true;
					} else {
						el.removeAttribute("checked");
						el.checked = false;
					}
				}
			}

			// --- 3. Checkboxes by aria-label (service invoice compliance + account type) ---
			// Still querySelector (singular), and that is a MEASURED no-op rather than an
			// oversight: across all 9 registered templates there are 32 distinct checkbox
			// aria-labels and NOT ONE is duplicated, so every ask matches exactly one box.
			// It shares the shape the text loop above was just fixed for, though — so if
			// you ever repeat a checkbox label (easy to do: the condition checklist pattern
			// already appears in both the lease's delivery receipt and the master
			// agreement's Exhibit A), this silently ticks only the first and leaves the
			// rest unchecked on an inspection attestation. Make it querySelectorAll then.
			if (checkboxesByLabel) {
				for (const [label, checked] of Object.entries(checkboxesByLabel)) {
					const el = document.querySelector(`input[type="checkbox"][aria-label="${CSS.escape(label)}"]`);
					if (!el) continue;
					if (checked) {
						el.setAttribute("checked", "checked");
						el.checked = true;
					} else {
						el.removeAttribute("checked");
						el.checked = false;
					}
				}
			}

			// --- 4. Per-day completed/N-A checkboxes (service invoice only) ---
			// The template script creates them with data-row="0"..."6".
			if (dayCompletedByIndex && Array.isArray(dayCompletedByIndex)) {
				dayCompletedByIndex.forEach((row, i) => {
					const completed = document.querySelector(`input.completed[data-row="${i}"]`);
					if (completed) {
						if (row.completed) {
							completed.setAttribute("checked", "checked");
							completed.checked = true;
						} else {
							completed.removeAttribute("checked");
							completed.checked = false;
						}
					}
					const na = document.querySelector(`input.na[data-row="${i}"]`);
					if (na) {
						if (row.na) {
							na.setAttribute("checked", "checked");
							na.checked = true;
						} else {
							na.removeAttribute("checked");
							na.checked = false;
						}
					}
				});
			}

			// --- 4b. Hide adjustment row when there's no adjustment ---
			// Templates include a [data-show-when-adjusted] row that holds the
			// "ADMIN ADJUSTMENT: +$X" line. The text-fill loop above leaves the
			// inner amount cell empty when adjustment is 0; without this step the
			// label row would render with blank cells.
			document.querySelectorAll('[data-show-when-adjusted]').forEach((row) => {
				const amt = row.querySelector('[aria-label="Adjustment amount"]');
				const amtText = (amt && amt.textContent || '').trim();
				if (!amtText) row.style.display = 'none';
			});

			// --- 4c. Personal lines (weekly invoices) ---
			// Each [data-personal-line-template] row (hidden) is cloned once per line,
			// in order, just before itself: "Personal expense, Pilot #123, Oct 12, 2026"
			// beside "-$200.00". textContent only. The template row is then removed,
			// so an invoice with no Personal line prints exactly as before.
			const personalLines = Array.isArray(fields.personalLines) ? fields.personalLines : [];
			document.querySelectorAll('[data-personal-line-template]').forEach((tpl) => {
				for (const line of personalLines) {
					const row = tpl.cloneNode(true);
					row.removeAttribute('data-personal-line-template');
					row.style.display = '';
					const labelCell = row.querySelector('[data-cell="label"]');
					const amountCell = row.querySelector('[data-cell="amount"]');
					const noteCell = row.querySelector('[data-cell="note"]');
					if (labelCell) labelCell.textContent = String(line.label || '');
					if (amountCell) amountCell.textContent = String(line.amount || '');
					// Where the line's receipt is: a link to its page after the invoice
					// ("#receipt-N" only), or plain text; removed when there is none.
					if (noteCell) {
						const note = String(line.note || '');
						const href = String(line.href || '');
						if (!note) {
							noteCell.remove();
						} else if (/^#receipt-[1-9][0-9]{0,2}$/.test(href)) {
							const a = document.createElement('a');
							a.setAttribute('href', href);
							a.textContent = note;
							noteCell.appendChild(a);
						} else {
							noteCell.textContent = note;
						}
					}
					tpl.parentNode.insertBefore(row, tpl);
				}
				tpl.remove();
			});
			// --- 4d. Correction lines (weekly invoices) ---
			// Each [data-correction-line-template] row is cloned once per line, in
			// order, before itself, then removed: no line prints nothing.
			const correctionLines = Array.isArray(fields.correctionLines) ? fields.correctionLines : [];
			document.querySelectorAll('[data-correction-line-template]').forEach((tpl) => {
				for (const line of correctionLines) {
					const row = tpl.cloneNode(true);
					row.removeAttribute('data-correction-line-template');
					row.style.display = '';
					const labelCell = row.querySelector('[data-cell="label"]');
					const amountCell = row.querySelector('[data-cell="amount"]');
					if (labelCell) labelCell.textContent = String(line.label || '');
					if (amountCell) amountCell.textContent = String(line.amount || '');
					tpl.parentNode.insertBefore(row, tpl);
				}
				tpl.remove();
			});
			// A Personal correction that leaves the driver owing says so on its own
			// row; hidden otherwise, like the adjustment row.
			document.querySelectorAll('[data-show-when-owed]').forEach((row) => {
				const amt = row.querySelector('[aria-label="Amount owed"]');
				if (!(amt && (amt.textContent || '').trim())) row.style.display = 'none';
			});

			return { verified, mismatched, missed };
		}, fields);

		assertDocumentFilled(docKey, fields, fillReport);

		// --- 5a. Clone table rows (owner-op loads/expenses, manual line items) ---
		// Each target tbody ships with a single template <tr>; we replace it with
		// one row per item in the data array. Empty arrays render a placeholder
		// row so the table doesn't look broken. Legacy loadsRows/expensesRows
		// keys map to the owner-op template's fixed tbody ids; mappers can also
		// pass a generic fields.tableRows = [{ tbodyId, rows, cellCount, emptyText }]
		// (used by service_invoice_manual for its line-item + deduction tables).
		const tableFills = [];
		if (fields.loadsRows !== undefined) {
			tableFills.push({ tbodyId: "loads-rows", rows: fields.loadsRows, cellCount: 3, emptyText: "(no completed loads this week)" });
		}
		if (fields.expensesRows !== undefined) {
			tableFills.push({ tbodyId: "expenses-rows", rows: fields.expensesRows, cellCount: 4, emptyText: "(no fuel or maintenance expenses this week)" });
		}
		if (Array.isArray(fields.tableRows)) tableFills.push(...fields.tableRows);
		if (tableFills.length) {
			await page.evaluate((tables) => {
				function fillTbody(tbodyId, rows, cellCount, emptyText) {
					const tbody = document.getElementById(tbodyId);
					if (!tbody) return;
					const template = tbody.querySelector("tr");
					if (!template) return;
					tbody.innerHTML = "";
					if (!rows || rows.length === 0) {
						const tr = document.createElement("tr");
						tr.className = "empty-row";
						const td = document.createElement("td");
						td.setAttribute("colspan", String(cellCount));
						td.textContent = emptyText;
						tr.appendChild(td);
						tbody.appendChild(tr);
						return;
					}
					rows.forEach((row) => {
						const tr = template.cloneNode(true);
						const cells = tr.querySelectorAll("td .cell-text");
						cells.forEach((span, j) => {
							span.textContent = row[j] == null ? "" : String(row[j]);
						});
						tbody.appendChild(tr);
					});
				}
				for (const t of tables) {
					fillTbody(t.tbodyId, t.rows, t.cellCount, t.emptyText);
				}
			}, tableFills);
		}

		// --- 5c. Receipt sheets after a weekly invoice (Personal lines) ---
		// The hidden [data-receipt-page-template] is cloned once per sheet, in
		// order, each on a new page with its anchor ("receipt-N", the line's link
		// target) and header, then either the re-encoded JPEG or, for a PDF
		// receipt, the note that its pages follow (the server inserts them after
		// this sheet: lib/receipt-pdf.js merge()); then removed. No sheet: the
		// section stays hidden and the invoice prints exactly as before. Waits for
		// every image to decode before the PDF is taken.
		if (fields.receiptPages.length) {
			await page.evaluate(async (pages) => {
				const holder = document.querySelector('[data-receipt-pages]');
				const tpl = holder && holder.querySelector('[data-receipt-page-template]');
				if (!tpl) return;
				const decoding = [];
				for (const p of pages) {
					const sheet = tpl.cloneNode(true);
					sheet.removeAttribute('data-receipt-page-template');
					sheet.style.display = '';
					sheet.id = p.anchor;
					const header = sheet.querySelector('[data-cell="header"]');
					const img = sheet.querySelector('img[data-cell="image"]');
					const note = sheet.querySelector('[data-cell="pdf-note"]');
					if (header) header.textContent = p.header;
					if (p.image) {
						if (note) note.remove();
						if (img) {
							img.setAttribute('src', p.image);
							decoding.push(img.decode().catch(() => {}));
						}
					} else {
						if (img) img.remove();
						if (note) note.textContent = String(p.note || '');
					}
					holder.insertBefore(sheet, tpl);
				}
				tpl.remove();
				holder.style.display = '';
				await Promise.all(decoding);
			}, fields.receiptPages);
		}

		// --- 5b. Clone vehicle rows for Exhibit A (master_agreement with 2+ trucks) ---
		if (fields.vehicles && fields.vehicles.length > 1) {
			await page.evaluate((vehicles) => {
				// Find the Exhibit A vehicle table — it's the table with a <th> containing "Year"
				const tables = document.querySelectorAll("table");
				let vehicleTable = null;
				for (const t of tables) {
					const th = t.querySelector("th");
					if (th && /year/i.test(th.textContent)) { vehicleTable = t; break; }
				}
				if (!vehicleTable) return;
				const tbody = vehicleTable.querySelector("tbody");
				if (!tbody) return;
				const templateRow = tbody.querySelector("tr");
				if (!templateRow) return;

				// Vehicles[0] is already filled by the text field mapper.
				// Clone a new row for each additional vehicle.
				for (let i = 1; i < vehicles.length; i++) {
					const v = vehicles[i];
					const row = templateRow.cloneNode(true);
					const cells = row.querySelectorAll("td");
					// Order matches template: Year, Make, Model, VIN
					const vals = [v.year, v.make, v.model, v.vin];
					cells.forEach((td, j) => {
						const input = td.querySelector("input");
						if (input && vals[j] != null) {
							input.setAttribute("value", String(vals[j]));
							input.value = String(vals[j]);
							// Remove aria-label to avoid duplicate slot matching
							input.removeAttribute("aria-label");
						}
					});
					tbody.appendChild(row);
				}
			}, fields.vehicles);
		}

		const pdf = await page.pdf({
			format: "Letter",
			printBackground: true,
			// HTML uses @page { margin: 1in } so Puppeteer's own margin is 0.
			margin: { top: 0, bottom: 0, left: 0, right: 0 },
			preferCSSPageSize: true,
		});
		// Puppeteer >=22 returns a Uint8Array, not a Buffer. Express's res.send()
		// JSON-serializes Uint8Arrays (checks Buffer.isBuffer() which returns false).
		// Always wrap so both res.send and fs.writeFileSync receive a proper Buffer.
		return Buffer.from(pdf);
	} finally {
		await page.close().catch(() => {});
	}
}

module.exports = { renderPolicy, safeSignatureImage, safeSignatureImages, safeReceiptPages, assertDocumentFilled, prepareTemplateHtml, buildRenderFields };
