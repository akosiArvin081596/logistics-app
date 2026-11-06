// One Triumph batch: one load's PDF and its CSV (lib/triumph-rules.js). The PDF's pages
// in the guide's order: the invoice, the rate con, the BOLs, the PODs, then any lumper,
// scale or pallet document. The source documents' pages go in as issued.
//
// buildBatch() answers { ok: true, ... } or a refusal with its code, and never a partial
// batch. It opens no database, file or connection: every byte is handed to it, so the job
// and the scripts share one builder. buildSampleBatch() is the made-up batch that proves
// the format to Triumph: fixed here, it reads no load and spends no number.

"use strict";

const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const rules = require("./triumph-rules");
const triumphInvoice = require("./triumph-invoice");
const brokerInvoice = require("./broker-invoice");
const { shownText } = require("./pdf-shown-text");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hasBytes = (buf) => Boolean(buf && buf.length);

// lib/pdf-shown-text.js can't see inside object streams, and it is how a batch's own
// text is read back. updateFieldAppearances off: a source document's form fields stay
// as they were filled.
const SAVE_OPTIONS = Object.freeze({ useObjectStreams: false, updateFieldAppearances: false });

// The pages of each part in order, as one PDF, and each part's own count. A part that
// won't load (not a PDF, encrypted, no pages) names its kind: nothing is left out.
async function mergeParts(parts, { stamp = "" } = {}) {
	const merged = await PDFDocument.create();
	const counted = [];
	for (const part of parts) {
		try {
			const source = await PDFDocument.load(part.buffer, { updateMetadata: false });
			const indices = source.getPageIndices();
			if (!indices.length) return { ok: false, code: "MERGE_FAILED", kind: part.kind };
			const pages = await merged.copyPages(source, indices);
			for (const page of pages) merged.addPage(page);
			counted.push({ kind: part.kind, sha256: sha256(part.buffer), bytes: part.buffer.length, pages: pages.length });
		} catch {
			return { ok: false, code: "MERGE_FAILED", kind: part.kind };
		}
	}
	if (stamp) {
		const font = await merged.embedFont(StandardFonts.HelveticaBold);
		for (const page of merged.getPages()) {
			page.drawText(stamp, { x: 36, y: page.getHeight() - 22, size: 10, font, color: rgb(0.7, 0, 0) });
		}
	}
	return { ok: true, pdf: Buffer.from(await merged.save(SAVE_OPTIONS)), parts: counted };
}

// What the whole-number test reads: both of the app's readers, since a rate con may be
// written in either's way. A line between them so neither's end runs into the other's start.
function rateConTextOf(buffer) {
	return `${shownText(buffer)}\n${brokerInvoice.extractPdfText(buffer)}`;
}

// One load's batch, each value as the rendered invoice prints it. `rateCon` is the
// engine's primary candidate ({ buffer, source, driveFileName }), `rateConNumber` its
// read's Load Number; `documents` the load's rows with their bytes in `buffer`.
// `denyHits` is the deny list's hits(); `stamp`, for the sample only, prints on each page.
async function buildBatch({
	invoicePdf, rateCon, rateConNumber, documents = [], loadId,
	debtorName, invoiceId, invoiceDate, po, billedTotal,
	at = new Date(), denyHits, maxBytes = rules.BATCH_MAX_BYTES, stamp = "",
} = {}) {
	const made = rules.csvRow({ debtorName, invoiceId, invoiceDate, po, billedTotal });
	if (!made.ok) return made;
	const { row } = made;
	const pdfName = rules.pdfName(row["INVOICE#"]);
	const csvName = rules.csvName(row["INVOICE#"], at);
	const denied = rules.protectedValueRefusal({ row, names: [pdfName, csvName], denyHits });
	if (denied) return denied;

	const ordered = rules.batchDocuments(documents);
	const missing = rules.missingKinds({ invoice: hasBytes(invoicePdf), rateCon: rateCon && hasBytes(rateCon.buffer), documents: ordered });
	if (missing.length) return { ok: false, code: "DOCUMENT_MISSING", kinds: missing };
	const unreadable = [...new Set(ordered.filter((d) => !hasBytes(d.doc.buffer)).map((d) => d.kind))];
	if (unreadable.length) return { ok: false, code: "DOCUMENT_UNREADABLE", kinds: unreadable };

	const wrongFile = rules.rateConRefusal({ primary: rateCon, loadId, rateConNumber, rateConText: () => rateConTextOf(rateCon.buffer) });
	if (wrongFile) return wrongFile;
	const notPrinted = rules.debtorNameRefusal(row.DTR_NAME, shownText(rateCon.buffer));
	if (notPrinted) return notPrinted;

	const csv = Buffer.from(rules.csvText(row), "utf8");
	const merged = await mergeParts([
		{ kind: "invoice", buffer: invoicePdf },
		{ kind: "ratecon", buffer: rateCon.buffer },
		...ordered.map((d) => ({ kind: d.kind, buffer: d.doc.buffer })),
	], { stamp });
	if (!merged.ok) return merged;
	const tooBig = rules.sizeRefusal(merged.pdf.length, csv.length, maxBytes);
	if (tooBig) return tooBig;
	return {
		ok: true,
		row,
		pdfName,
		pdf: merged.pdf,
		csvName,
		csv,
		parts: merged.parts,
		batchBytes: merged.pdf.length + csv.length,
		pdfSha256: sha256(merged.pdf),
		csvSha256: sha256(csv),
	};
}

// The row's fields a PDF's text doesn't show, by the invoice's own printing. Empty when
// INVOICE#, INV_DATE, PO and INVAMT all appear there.
function unprintedFields(pdf, row) {
	const text = shownText(pdf);
	const printed = { "INVOICE#": row["INVOICE#"], INV_DATE: row.INV_DATE, PO: row.PO, INVAMT: brokerInvoice.formatMoney(row.INVAMT) };
	return Object.keys(printed).filter((field) => !text.includes(printed[field]));
}

// ── the sample ───────────────────────────────────────────────────────────────

// Made up in full. A real broker's name beside the real assignment lines could reach
// that broker if it ever landed live, so nothing here names one.
const SAMPLE = Object.freeze({
	debtorName: "Example Broker LLC (SAMPLE - DO NOT FUND)",
	invoiceId: "SAMPLE-0001",
	po: "LD-TEST-0001",
	billedTotal: "$1.00",
	stamp: "SAMPLE - NOT A REAL INVOICE - DO NOT PAY",
	invoiceToEmail: "billing@example-broker.test",
});
const SAMPLE_RATECON = Object.freeze(["RATE CONFIRMATION (MADE UP)", `Broker: ${SAMPLE.debtorName}`, `Load Number: ${SAMPLE.po}`, `Total Rate: ${SAMPLE.billedTotal}`]);
const SAMPLE_POD = Object.freeze(["PROOF OF DELIVERY (MADE UP)", `Load Number: ${SAMPLE.po}`, "Received by: a made-up receiver"]);
// Its values are the constants above, so there is nothing for the deny list to find.
const sampleHoldsNothing = () => false;

// Each line ends in a space: the text reader joins lines with nothing, and a number run
// into the next word wouldn't read as this load's.
async function madeUpPage(lines) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	lines.forEach((text, i) => page.drawText(`${text} `, { x: 54, y: 720 - i * 20, size: 12, font }));
	return Buffer.from(await doc.save(SAVE_OPTIONS));
}

// Takes only the assignment lines, the run's date (YYYY-MM-DD) and the renderer. Without
// lines it refuses: the block is the point of the sample. The stamp beside the block is
// one more line in the block's lines.
async function buildSampleBatch({ lines, day, render, at = new Date() } = {}) {
	if (!Array.isArray(lines) || lines.length !== rules.NOA_LINE_COUNT) return { ok: false, code: "NOA_UNCONFIGURED" };
	const invoiceDate = brokerInvoice.formatDate(day);
	const html = triumphInvoice.withAssignment(brokerInvoice.buildInvoiceHtml({
		invoiceId: SAMPLE.invoiceId,
		invoiceDate,
		brokerName: SAMPLE.debtorName,
		invoiceTo: { name: SAMPLE.debtorName, email: SAMPLE.invoiceToEmail },
		orderNumber: SAMPLE.po,
		deliveryDate: invoiceDate,
		total: SAMPLE.billedTotal,
	}), { lines: [...lines, SAMPLE.stamp] });
	return buildBatch({
		invoicePdf: await render(html),
		rateCon: { buffer: await madeUpPage(SAMPLE_RATECON), source: "documents" },
		rateConNumber: SAMPLE.po,
		documents: [{ type: "POD", id: 1, buffer: await madeUpPage(SAMPLE_POD) }],
		loadId: SAMPLE.po,
		debtorName: SAMPLE.debtorName,
		invoiceId: SAMPLE.invoiceId,
		invoiceDate,
		po: SAMPLE.po,
		billedTotal: SAMPLE.billedTotal,
		at,
		denyHits: sampleHoldsNothing,
		stamp: SAMPLE.stamp,
	});
}

module.exports = { buildBatch, buildSampleBatch, mergeParts, unprintedFields, rateConTextOf, SAMPLE, SAVE_OPTIONS };
