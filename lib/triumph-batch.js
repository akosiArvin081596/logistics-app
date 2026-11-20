// One Triumph batch: one load's PDF and its CSV (lib/triumph-rules.js). The PDF's pages
// in the guide's order: the invoice, the rate con, the BOLs, the PODs, then any lumper,
// scale or pallet document. The source documents' pages go in as issued; with the dedupe
// on, a BOL or POD stored twice byte for byte goes in once; with the re-compress on, a batch
// over the limit has the photos on its BOL and POD pages re-compressed at the same size
// (lib/triumph-batch-recompress.js).
//
// buildBatch() answers { ok: true, ... } or a refusal with its code, and never a partial
// batch. It opens no database, file or connection: every byte is handed to it, so the job
// and the scripts share one builder. buildSampleBatch() is the made-up batch that proves
// the format to Triumph: fixed here, it reads no load and spends no number. sampleRefusal()
// is the transport's check that what it is about to send is that batch.

"use strict";

const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const rules = require("./triumph-rules");
const recompressLib = require("./triumph-batch-recompress");
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

// Each identical BOL or POD once, over the rows in the batch's order (every one with bytes):
// a BOL or POD whose bytes are identical (by sha256) to an earlier BOL's or POD's is left out,
// so the first copy stays, and a file filed once as each goes in as the BOL. Lumper, scale and
// pallet rows are never matched. Each copy left out is named in `dropped`.
function sentOnce(ordered) {
	const first = new Map();
	const kept = [];
	const dropped = [];
	for (const d of ordered) {
		const hash = d.kind === "bol" || d.kind === "pod" ? sha256(d.doc.buffer) : "";
		const earlier = hash ? first.get(hash) : undefined;
		if (earlier) {
			dropped.push({ kind: d.kind, sha256: hash, bytes: d.doc.buffer.length, keptAs: earlier.kind });
			continue;
		}
		if (hash) first.set(hash, d);
		kept.push(d);
	}
	return { kept, dropped };
}

// One load's batch, each value as the rendered invoice prints it. `rateCon` is the
// engine's primary candidate ({ buffer, source, driveFileName }), `rateConNumber` its
// read's Load Number; `documents` the load's rows with their bytes in `buffer`.
// `denyHits` is the deny list's hits(); `stamp`, for the sample only, prints on each page.
// `dedupe`, exactly true (lib/triumph-rules.js batchDedupeEnabled()), sends each identical
// BOL or POD once; the answer then names each copy left out in `dropped`, a stop's too.
// `recompress`, exactly true (batchRecompressEnabled()), tries the photo steps on a batch whose
// merge is over the limit: a part re-compressed carries `recompressed`; a stop at the floor has
// `floorReached` and the floor's records in `recompressed`; one whose steps never ran says why in
// `recompressSkipped`. `recompressor` is lib/triumph-batch-recompress.js create()'s answer, for the
// runners and Part A to hand their own.
async function buildBatch({
	invoicePdf, rateCon, rateConNumber, documents = [], loadId,
	debtorName, invoiceId, invoiceDate, po, billedTotal,
	at = new Date(), denyHits, maxBytes = rules.BATCH_MAX_BYTES, stamp = "", dedupe = false,
	recompress = false, recompressor = null,
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
	// After the two checks above, whose answers it can't change: the first copy of each is kept.
	const once = dedupe === true ? sentOnce(ordered) : null;
	const sent = once ? once.kept : ordered;
	// Without the option the answer is the one it always was; with it, what was left out.
	const told = (answer) => (once ? { ...answer, dropped: once.dropped } : answer);

	const wrongFile = rules.rateConRefusal({ primary: rateCon, loadId, rateConNumber, rateConText: () => rateConTextOf(rateCon.buffer) });
	if (wrongFile) return told(wrongFile);
	const notPrinted = rules.debtorNameRefusal(row.DTR_NAME, shownText(rateCon.buffer));
	if (notPrinted) return told(notPrinted);

	const csv = Buffer.from(rules.csvText(row), "utf8");
	const parts = [
		{ kind: "invoice", buffer: invoicePdf },
		{ kind: "ratecon", buffer: rateCon.buffer },
		...sent.map((d) => ({ kind: d.kind, buffer: d.doc.buffer })),
	];
	let merged = await mergeParts(parts, { stamp });
	if (!merged.ok) return told(merged);
	let tooBig = rules.sizeRefusal(merged.pdf.length, csv.length, maxBytes);
	let records = null;
	// Every check above ran on the documents as stored; each step is merged and sized the same way.
	if (tooBig && recompress === true) {
		const tried = await (recompressor || recompressLib.create()).fit(parts, { csvBytes: csv.length, maxBytes, tooBig, merge: (list) => mergeParts(list, { stamp }) });
		if (tried.floor) return told({ ...tried.floor.refusal, floorReached: true, recompressed: tried.floor.recompressed });
		if (!tried.merged) return told({ ...tooBig, recompressSkipped: tried.skipped });
		merged = tried.merged;
		records = tried.records;
		tooBig = null;
	}
	if (tooBig) return told(tooBig);
	return told({
		ok: true,
		row,
		pdfName,
		pdf: merged.pdf,
		csvName,
		csv,
		parts: records ? merged.parts.map((p, i) => (records[i] ? { ...p, recompressed: records[i] } : p)) : merged.parts,
		batchBytes: merged.pdf.length + csv.length,
		pdfSha256: sha256(merged.pdf),
		csvSha256: sha256(csv),
	});
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

// What the transport's putSample() checks before a byte goes: the content, never where it
// came from. One PDF named for the sample's number with the stamp in its text, and one CSV
// named for it whose one row is the sample's constants, byte for byte, but for INV_DATE,
// which must be a real MM/DD/YYYY day. A reason, or null.
const SAMPLE_CSV_NAME_RE = /^logisx_\d{8}T\d{6}Z_([A-Za-z0-9._-]+)\.csv$/;
function sampleRefusal({ pdfName, pdf, csvName, csv } = {}) {
	if (!Buffer.isBuffer(pdf) || !pdf.length || !Buffer.isBuffer(csv) || !csv.length) return "SAMPLE_FILES";
	if (pdfName !== rules.pdfName(SAMPLE.invoiceId)) return "SAMPLE_PDF_NAME";
	const m = SAMPLE_CSV_NAME_RE.exec(String(csvName || ""));
	if (!m || m[1] !== SAMPLE.invoiceId) return "SAMPLE_CSV_NAME";
	const lines = csv.toString("latin1").split(rules.CSV_EOL);
	const cells = lines.length === 3 && lines[2] === "" ? lines[1].split(",") : [];
	const made = cells.length === rules.CSV_HEADERS.length
		? rules.csvRow({ debtorName: SAMPLE.debtorName, invoiceId: SAMPLE.invoiceId, invoiceDate: cells[2], po: SAMPLE.po, billedTotal: SAMPLE.billedTotal })
		: { ok: false };
	if (!made.ok || !Buffer.from(rules.csvText(made.row), "utf8").equals(csv)) return "SAMPLE_CSV_CONTENT";
	if (!shownText(pdf).includes(SAMPLE.stamp)) return "SAMPLE_STAMP_MISSING";
	return null;
}

module.exports = { buildBatch, buildSampleBatch, mergeParts, unprintedFields, rateConTextOf, sampleRefusal, SAMPLE, SAVE_OPTIONS };
