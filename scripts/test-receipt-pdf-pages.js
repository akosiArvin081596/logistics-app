#!/usr/bin/env node
/**
 * PDF receipt pages (Personal receipts, R3 v2, PR1): the child that turns a
 * stored PDF receipt into clean Letter pages (lib/receipt-pdf-child.js) and the
 * service that runs it, limits it, caches it and self-tests it (lib/receipt-pdf.js).
 * Every PDF and image here is made up and built by this runner; no real receipt
 * or replica file is read.
 *
 *   T2-T5   actions, links, attached files and forms are not carried over
 *   T6-T13  refusals and limits: the note ("on_file") with a reason code
 *   T16     the post-scan refuses what the walk would have missed
 *   T18-T30 images, inline images, external data, resources, object and decode caps
 *   T31-T35 the child process: heap cap, uid drop, decode-cap self-test, permissions
 *   T39-T40 the self-test line; oom_score_adj before the first IPC message
 *   R2      the exact pdf-lib pin (R2-L2), metadata never copied (MD0-MD5, R2-L3),
 *           the image pixel cap (R2-L4), the page-size refusal (R2-L6)
 *   plus the cache (hit, damaged file, never under uploads)
 *
 * Pure apart from child processes and a temp folder; no server, no network.
 * Run: node scripts/test-receipt-pdf-pages.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`  ok    ${label}`); return; }
	fail++;
	console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
function finish() {
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}

const ROOT = path.join(__dirname, "..");
const rp = require(path.join(ROOT, "lib", "receipt-pdf.js"));
const childLib = require(path.join(ROOT, "lib", "receipt-pdf-child.js"));
const { stripImageMetadata } = require(path.join(ROOT, "lib", "image-metadata.js"));
const pdfLib = require("pdf-lib");
const { PDFDocument, PDFDict, PDFArray, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } = pdfLib;
const { rawPdf, streamObject, fixtureJpeg, fixtureTiff } = rp;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-pdf-pages-"));
const RECEIPTS = path.join(TMP, "data", "uploads", "expense-receipts");
const CACHE = path.join(TMP, "data", "storage", "receipt-pdfs");
fs.mkdirSync(RECEIPTS, { recursive: true });
const PROBE_ENV = path.join(TMP, "probe", ".env");
const PROBE_DB = path.join(TMP, "probe", "app.db");
fs.mkdirSync(path.dirname(PROBE_ENV), { recursive: true });
fs.writeFileSync(PROBE_ENV, "MADE_UP=1\n");
fs.writeFileSync(PROBE_DB, "made up\n");
const BASE = Object.freeze({ receiptsDir: RECEIPTS, cacheDir: CACHE, probes: { env: PROBE_ENV, db: PROBE_DB } });

let nextId = 1000;
function put(bytes, ext = "pdf") {
	const id = ++nextId;
	const name = `r${id}.${ext}`;
	fs.writeFileSync(path.join(RECEIPTS, name), bytes);
	return { expenseId: id, photoData: `/uploads/expense-receipts/${name}` };
}

function scratchChild(name, source) {
	const file = path.join(TMP, name);
	fs.writeFileSync(file, source);
	return file;
}

// A one-page PDF: 1 catalog, 2 pages, 3 page, 4 content; extras from 5.
function onePage({ catalog = "", page = "", content = "0 0 1 rg 10 10 50 50 re f", resources = "", extra = [], trailer = "" } = {}) {
	return rawPdf([
		`<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << ${resources} >> ${page} >>`,
		Buffer.isBuffer(content) ? content : streamObject("", content),
		...extra,
	], trailer);
}

function manyPages(n) {
	const kids = Array.from({ length: n }, (_, i) => `${i + 4} 0 R`).join(" ");
	return rawPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
		streamObject("", "0 0 1 rg 10 10 50 50 re f"),
		...Array.from({ length: n }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 3 0 R >>"),
	]);
}

// A made-up EXIF block: one GPS IFD (latitude 0/1, 0/1, 0/1 N).
function gpsTiff() {
	const t = Buffer.alloc(80);
	t.write("MM", 0, "latin1"); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
	t.writeUInt16BE(1, 8);
	t.writeUInt16BE(0x8825, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(26, 18);
	t.writeUInt32BE(0, 22);
	t.writeUInt16BE(2, 26);
	t.writeUInt16BE(1, 28); t.writeUInt16BE(2, 30); t.writeUInt32BE(2, 32); t.write("N\0", 36, "latin1");
	t.writeUInt16BE(2, 40); t.writeUInt16BE(5, 42); t.writeUInt32BE(3, 44); t.writeUInt32BE(56, 48);
	t.writeUInt32BE(0, 52);
	for (let i = 0; i < 3; i++) { t.writeUInt32BE(0, 56 + i * 8); t.writeUInt32BE(1, 60 + i * 8); }
	return t;
}

const IMAGE_DICT = "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8";
const DRAW_IM0 = "q 100 0 0 100 10 10 cm /Im0 Do Q";

// What an output PDF holds: page count, every key and name value (decoded),
// every JPEG stream, and the decoded text of every other stream.
async function inspect(pdf) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	const names = new Set();
	const jpegs = [];
	const texts = [];
	const streams = [];
	for (const [, top] of doc.context.enumerateIndirectObjects()) {
		const stack = [top];
		while (stack.length) {
			const o = stack.pop();
			if (o instanceof PDFRawStream) {
				streams.push(o);
				const f = o.dict.lookup(PDFName.of("Filter"));
				if (f === PDFName.of("DCTDecode")) jpegs.push(Buffer.from(o.contents));
				else if (f === PDFName.of("FlateDecode")) texts.push(Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"));
				else if (f === undefined) texts.push(Buffer.from(o.contents).toString("latin1"));
				stack.push(o.dict);
			} else if (o instanceof PDFDict) {
				for (const [k, v] of o.entries()) { names.add(childLib.plainName(k)); stack.push(v); }
			} else if (o instanceof PDFArray) {
				for (const v of o.asArray()) stack.push(v);
			} else if (o instanceof PDFName) {
				names.add(childLib.plainName(o));
			}
		}
	}
	const page = doc.getPage(0);
	return { pages: doc.getPageCount(), size: [page.getWidth(), page.getHeight()], names, jpegs, text: texts.join("\n"), raw: Buffer.from(pdf).toString("latin1"), streams, doc };
}
const hasAny = (set, list) => list.filter((n) => set.has(n));
const jpegClean = (buf) => {
	const r = stripImageMetadata(buf);
	return r.ok && r.removed.length === 0 && r.orientation === 1 && !buf.includes("Exif", 0, "latin1");
};

(async () => {
	const logs = [];
	const svc = rp.createReceiptPdfService({
		receiptsDir: RECEIPTS,
		cacheDir: CACHE,
		probes: { env: PROBE_ENV, db: PROBE_DB },
		log: (line) => logs.push(line),
	});
	const prep = (bytes) => svc.prepare(put(bytes));
	let plainOut = null;           // a clean output, for the fake self-test children below

	// ---- self-test (T39) ----------------------------------------------------
	console.log("T39 the self-test line");
	{
		const r = await svc.selfTest();
		const line = logs.find((l) => l.startsWith("receipt pdf self-test:")) || "";
		check("T39 the self-test passes on this machine", [r.passed, r.problems, svc.state()], [true, [], "passed"]);
		check("T39 the line reports uid, gid, groups and the probes as not readable (the files exist and this process can read them)",
			[/ uid=\d+ gid=\d+ groups=[\d,]+ /.test(` ${line.slice(22)}`), /env_readable=no db_readable=no/.test(line), fs.readFileSync(PROBE_ENV, "utf8").length > 0],
			[true, true, true]);
		check("T39 the line says permission=on, decode_hook=yes, fixture=clean, decode_cap=refused, pass",
			/permission=on decode_hook=yes fixture=clean decode_cap=refused -> pass$/.test(line), true);
		check("T39 the line holds no path and no file content", [line.includes(TMP), line.includes("MADE_UP")], [false, false]);
	}

	// ---- a plain receipt ------------------------------------------------------
	console.log("a plain one-page receipt");
	{
		const r = await prep(onePage());
		if (r.status === "pages") plainOut = r.pdf;
		const o = r.status === "pages" ? await inspect(r.pdf) : null;
		check("a plain receipt comes back as one Letter page", [r.status, r.pages, o && o.pages, o && o.size], ["pages", 1, 1, [612, 792]]);
		check("its page is drawn from a Form XObject", o && o.names.has("Form"), true);

		const infoSrc = onePage({
			trailer: "/Info 5 0 R /ID [<1D0C0FFEE1D0C0FFEE1D0C0FFEE1D0C0> <1D0C0FFEE1D0C0FFEE1D0C0FFEE1D0C0>] ",
			extra: ["<< /Title (info-title-4417) /Author (info-author-4417) /Subject (info-subject-4417) /Keywords (info-keywords-4417) /Creator (info-creator-4417) /Producer (info-producer-4417) /CreationDate (D:19990909090909Z) /ModDate (D:19990910101010Z) >>"],
		});
		const infoDoc = await PDFDocument.load(infoSrc, { updateMetadata: false });
		const withInfo = await prep(infoSrc);
		const oInfo = withInfo.status === "pages" ? await inspect(withInfo.pdf) : null;
		check("a source with an Info dictionary and a file ID: pages, no Info or ID in the output, none of their values anywhere",
			[infoDoc.getTitle(), infoDoc.getAuthor(), infoDoc.getProducer(), withInfo.status,
				oInfo && oInfo.doc.context.trailerInfo.Info === undefined, oInfo && oInfo.doc.context.trailerInfo.ID === undefined,
				oInfo && /-4417|19990909|19990910|1D0C0FFEE/i.test(oInfo.raw + oInfo.text),
				oInfo && hasAny(oInfo.names, ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Info", "ID"])],
			["info-title-4417", "info-author-4417", "info-producer-4417", "pages", true, true, false, []]);

		const inherited = await prep(rawPdf([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 400] /Rotate 90 >>",
			"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
			streamObject("", "0 0 1 rg 10 10 50 50 re f"),
		]));
		const oi = inherited.status === "pages" ? await inspect(inherited.pdf) : null;
		const cm = oi && /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/RcptPage Do/.exec(oi.text);
		check("a MediaBox and a quarter turn inherited from the page tree: drawn turned clockwise",
			[inherited.status, cm && Number(cm[1]), cm && Number(cm[2]) < 0, cm && Number(cm[3]) > 0, cm && Number(cm[4])], ["pages", 0, true, true, 0]);

		const made = await PDFDocument.create();
		const font = await made.embedFont(pdfLib.StandardFonts.Helvetica);
		const jpg = await made.embedJpg(new Uint8Array(fixtureJpeg()));
		for (let i = 0; i < 2; i++) {
			const p = made.addPage([300, 500]);
			p.drawText(`Made-up receipt page ${i + 1}`, { x: 20, y: 450, size: 12, font });
			p.drawImage(jpg, { x: 20, y: 20, width: 100, height: 100 });
		}
		const madeBytes = Buffer.from(await made.save());
		const multi = await prep(madeBytes);
		const om = multi.status === "pages" ? await inspect(multi.pdf) : null;
		check("a two-page receipt written with object streams, a font and an image: two pages, the image kept as it was",
			[madeBytes.includes("/ObjStm", 0, "latin1"), multi.status, multi.pages, om && om.jpegs.length, om && om.jpegs.every((j) => j.equals(fixtureJpeg()))], [true, "pages", 2, 1, true]);
	}

	// ---- T2-T5 ----------------------------------------------------------------
	console.log("T2-T5 nothing that can run, link or attach is carried over");
	{
		const js = await prep(onePage({
			catalog: "/OpenAction 5 0 R /Names << /JavaScript << /Names [(a) 5 0 R] >> >>",
			page: "/AA << /O 5 0 R /C 5 0 R >>",
			extra: ["<< /S /JavaScript /JS (void 0) >>"],
		}));
		const o2 = js.status === "pages" ? await inspect(js.pdf) : null;
		check("T2 script actions (OpenAction, page AA, Names JavaScript): pages, none of them left",
			[js.status, o2 && hasAny(o2.names, ["JavaScript", "JS", "OpenAction", "AA", "Names"])], ["pages", []]);

		const link = await prep(onePage({
			page: "/Annots [5 0 R]",
			extra: ["<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (https://example.invalid/) >> >>"],
		}));
		const o3 = link.status === "pages" ? await inspect(link.pdf) : null;
		check("T3 a link annotation: pages, no Annots, Link or URI", [link.status, o3 && hasAny(o3.names, ["Annots", "Annot", "Link", "URI", "A"]), o3 && o3.raw.includes("example.invalid")], ["pages", [], false]);

		const att = await prep(onePage({
			catalog: "/Names << /EmbeddedFiles << /Names [(note.txt) 6 0 R] >> >>",
			page: "/Annots [5 0 R]",
			extra: [
				"<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 20 20] /FS 6 0 R >>",
				"<< /Type /Filespec /F (note.txt) /EF << /F 7 0 R >> >>",
				streamObject("/Type /EmbeddedFile", "attached-marker-7731"),
			],
		}));
		const o4 = att.status === "pages" ? await inspect(att.pdf) : null;
		check("T4 an attached file (EmbeddedFiles and a FileAttachment annotation): pages, nothing of it left",
			[att.status, o4 && hasAny(o4.names, ["EmbeddedFiles", "EmbeddedFile", "FileAttachment", "Filespec", "EF", "Annots"]), o4 && (o4.raw + o4.text).includes("attached-marker-7731")],
			["pages", [], false]);

		const form = await prep(onePage({
			catalog: "/AcroForm << /Fields [5 0 R] /XFA 7 0 R >>",
			page: "/Annots [5 0 R]",
			extra: [
				"<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /V (form-marker-5521) /Rect [0 0 100 20] /AP << /N 6 0 R >> >>",
				streamObject("/Type /XObject /Subtype /Form /BBox [0 0 100 20]", "BT /Helv 10 Tf 2 5 Td (form-marker-5521) Tj ET"),
				streamObject("", "<xdp/>"),
			],
		}));
		const o5 = form.status === "pages" ? await inspect(form.pdf) : null;
		check("T5 a form with a widget: pages, no AcroForm, XFA, Widget or field value",
			[form.status, o5 && hasAny(o5.names, ["AcroForm", "XFA", "Widget", "Annots", "FT"]), o5 && (o5.raw + o5.text).includes("form-marker-5521")],
			["pages", [], false]);
	}

	// ---- T6-T13 ---------------------------------------------------------------
	console.log("T6-T13 refusals and limits");
	{
		const enc = await prep(onePage({ trailer: "/Encrypt 5 0 R ", extra: ["<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >>"] }));
		check("T6 an encrypted PDF: the note (encrypted)", [enc.status, enc.reason], ["on_file", "encrypted"]);

		const forksBefore = svc.stats().forks;
		const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(rp.RECEIPT_PDF_SOURCE_MAX_BYTES, 0x20)]);
		const tooBig = await prep(big);
		const dataUri = await svc.prepare({ expenseId: ++nextId, photoData: `data:application/pdf;base64,${big.toString("base64")}` });
		check("T7 over 5 MB, on disk or inline: the note (too_large) and no child started",
			[tooBig.status, tooBig.reason, dataUri.status, dataUri.reason, svc.stats().forks - forksBefore], ["on_file", "too_large", "on_file", "too_large", 0]);
		const notPdf = await prep(Buffer.from("plain text, not a PDF at all"));
		check("T7 no %PDF- in the first 1 KB: the note (not_pdf) and no child started", [notPdf.status, notPdf.reason, svc.stats().forks - forksBefore], ["on_file", "not_pdf", 0]);

		const seven = await prep(manyPages(7));
		const six = await prep(manyPages(6));
		const sixty = await prep(manyPages(60));
		check("T8 6 pages copied; 7 pages over the per-receipt cap; 60 over the 50-page load limit",
			[six.status, six.pages, seven.status, seven.reason, sixty.status, sixty.reason],
			["pages", 6, "on_file", "too_many_pages", "on_file", "too_many_source_pages"]);

		const junk = await prep(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 251))]));
		const brokenTree = await prep(rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [9 0 R] /Count 1 >>"]));
		check("T9 malformed bytes and a page tree pointing nowhere: the note", [junk.status, brokenTree.status], ["on_file", "on_file"]);

		const bomb = await prep(onePage({ content: streamObject("/Filter /FlateDecode", zlib.deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x20))) }));
		check("T10 a content stream inflating to 20 MB: the note (decode_cap)", [bomb.status, bomb.reason], ["on_file", "decode_cap"]);

		const t11 = Date.now();
		const deep = await prep(onePage({ resources: "/Properties << /P0 5 0 R >>", extra: ["[".repeat(100_000) + "]".repeat(100_000)] }));
		// pdf-lib reports an object it cannot parse as invalid (unparseable); the
		// trailer is parsed outside that, so nesting there surfaces as a RangeError.
		const deepTrailer = await prep(onePage({ trailer: `/X ${"[".repeat(100_000)}${"]".repeat(100_000)} ` }));
		check("T11 100,000 nested arrays in an object (unparseable) and in the trailer (nesting): the note, well inside the deadline",
			[deep.status, deep.reason, deepTrailer.status, deepTrailer.reason, Date.now() - t11 < 2 * rp.RECEIPT_PDF_PREPARE_TIMEOUT_MS], ["on_file", "unparseable", "on_file", "nesting", true]);

		const gpsJpeg = fixtureJpeg({ exif: gpsTiff() });
		const xmp = await prep(onePage({
			catalog: "/Metadata 5 0 R",
			content: DRAW_IM0,
			resources: "/XObject << /Im0 6 0 R >>",
			extra: [
				streamObject("/Type /Metadata /Subtype /XML", "<x:xmpmeta>xmp-marker-9046</x:xmpmeta>"),
				streamObject(`${IMAGE_DICT} /Filter /DCTDecode /Metadata 5 0 R`, gpsJpeg),
			],
		}));
		const o13 = xmp.status === "pages" ? await inspect(xmp.pdf) : null;
		check("T13 XMP on the catalog and the image, and a JPEG with an EXIF GPS block: pages, no Metadata, no XMP text, a JPEG with no APP1",
			[xmp.status, o13 && hasAny(o13.names, ["Metadata"]), o13 && (o13.raw + o13.text).includes("xmp-marker-9046"), o13 && o13.jpegs.length, o13 && o13.jpegs.every(jpegClean)],
			["pages", [], false, 1, true]);
	}

	console.log("T12 a child that never answers");
	{
		const HANG = scratchChild("hang-child.js", "process.once('message', () => { setInterval(() => {}, 1000); });\n");
		// The self-test runs under the same 600 ms deadline; a made-up child that
		// passes it at once keeps this check about the job's deadline alone, even
		// on a loaded machine.
		const PASSING = plainOut && scratchChild("passing-selftest-child.js", [
			`const pdf = Buffer.from(${JSON.stringify(Buffer.from(plainOut).toString("base64"))}, "base64");`,
			"process.once('message', (m) => process.send(m.kind === 'selftest'",
			"  ? { ok: true, identity: { uid: 501, gid: 20, groups: [20], env: 'no', db: 'no', permission: 'on' }, hook: true, result: { ok: true, pdf, pages: 1 } }",
			"  : { ok: false, reason: 'decode_cap' }, () => process.exit(0)));",
		].join("\n"));
		const pids = [];
		const hang = rp.createReceiptPdfService({ ...BASE, childPath: HANG, ...(PASSING ? { selfTestChildPath: PASSING } : {}), timeoutMs: 600, trace: (e, i) => { if (e === "fork") pids.push(i.pid); } });
		const r = await hang.prepare(put(onePage()));
		const jobPid = pids[pids.length - 1];
		await new Promise((res) => setTimeout(res, 200));
		let alive = true;
		try { process.kill(jobPid, 0); } catch (err) { alive = err.code !== "ESRCH"; }
		check("T12 killed at the deadline (SIGKILL): the note (timeout), the child is gone", [r.status, r.reason, alive], ["on_file", "timeout", false]);
	}

	// ---- T16 ------------------------------------------------------------------
	console.log("T16 the post-scan");
	{
		const doc = await PDFDocument.create({ updateMetadata: false });
		doc.addPage([100, 100]);
		doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", JS: "void 0" }));
		const withJs = await PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
		const orphanPdf = (body) => rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>", body]);
		const escaped = await PDFDocument.load(orphanPdf("<< /Open#41ction 1 0 R >>"), { updateMetadata: false });
		const action = await PDFDocument.load(orphanPdf("<< /Next << /S /JavaScript >> >>"), { updateMetadata: false });
		const cleanDoc = await PDFDocument.create({ updateMetadata: false });
		cleanDoc.addPage([100, 100]).node.delete(PDFName.of("Annots"));
		const clean = await PDFDocument.load(await cleanDoc.save({ useObjectStreams: false }), { updateMetadata: false });
		const scan = (d) => childLib.postScan(pdfLib, stripImageMetadata, d, childLib.DEFAULT_LIMITS);
		check("T16 refused: a /JS key in an unreferenced object, a key spelt with a #xx escape, an action type as a value; a clean file passes",
			[scan(withJs), scan(escaped), scan(action), scan(clean)], ["key:JS", "key:OpenAction", "value:JavaScript", null]);
		const lower = PDFName.of("OpenActio#6e");
		check("T16 a lower-case escape stays literal in pdf-lib and is written with '#' as #23 (a viewer reads the same literal name)",
			[childLib.plainName(lower), lower.asString()], ["OpenActio#6e", "/OpenActio#236e"]);
	}

	// ---- T18-T30 --------------------------------------------------------------
	console.log("T18-T30 images, inline images, external data, resources, caps");
	{
		const plainJpeg = fixtureJpeg();
		const t18 = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /DCTDecode`, plainJpeg)] }));
		const o18 = t18.status === "pages" ? await inspect(t18.pdf) : null;
		check("T18 a JPEG with no metadata is copied byte for byte", [t18.status, o18 && o18.jpegs.length, o18 && o18.jpegs[0] && o18.jpegs[0].equals(plainJpeg)], ["pages", 1, true]);

		const gpsJpeg = fixtureJpeg({ exif: gpsTiff() });
		const t19 = await prep(onePage({
			content: DRAW_IM0,
			resources: "/XObject << /Im0 5 0 R >>",
			extra: [streamObject(`${IMAGE_DICT} /Filter [/FlateDecode /DCTDecode] /DecodeParms [null << /ColorTransform 0 >>]`, zlib.deflateSync(gpsJpeg))],
		}));
		const o19 = t19.status === "pages" ? await inspect(t19.pdf) : null;
		const img19 = o19 && o19.streams.find((s) => s.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image"));
		const parms19 = img19 && img19.dict.lookup(PDFName.of("DecodeParms"));
		check("T19 [/FlateDecode /DCTDecode] with EXIF GPS: stored as plain /DCTDecode, its DecodeParms kept, no APP1",
			[t19.status, img19 && img19.dict.lookup(PDFName.of("Filter")) === PDFName.of("DCTDecode"), parms19 instanceof PDFDict && String(parms19.lookup(PDFName.of("ColorTransform"))), o19 && o19.jpegs.every(jpegClean), o19 && o19.jpegs.length],
			["pages", true, "0", true, 1]);
		const badChain = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter [/FlateDecode /DCTDecode]`, Buffer.from("not deflate data at all"))] }));
		const dctFirst = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter [/DCTDecode /FlateDecode]`, zlib.deflateSync(gpsJpeg))] }));
		const predictor = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter [/FlateDecode /DCTDecode] /DecodeParms [<< /Predictor 12 /Columns 8 >> null]`, zlib.deflateSync(gpsJpeg))] }));
		check("T19 a chain that cannot be decoded, DCT not last, or a predictor ahead of DCT: refused",
			[badChain.reason, dctFirst.reason, predictor.reason], ["image_filter_chain", "image_filter_chain", "image_filter_chain"]);

		const inlineDct = Buffer.concat([Buffer.from("q BI /W 8 /H 8 /CS /G /BPC 8 /F /DCT ID "), plainJpeg, Buffer.from(" EI Q")]);
		const t20a = await prep(onePage({ content: streamObject("", inlineDct) }));
		const t20b = await prep(onePage({
			content: "/Fm0 Do",
			resources: "/XObject << /Fm0 5 0 R >>",
			extra: [streamObject("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Filter /FlateDecode", zlib.deflateSync(inlineDct))],
		}));
		const t20c = await prep(onePage({ content: streamObject("", Buffer.concat([Buffer.from("q BI /W 8 /H 8 /CS /G /BPC 8 /F /DC#54 ID "), plainJpeg, Buffer.from(" EI Q")])) }));
		const t20d = await prep(onePage({ content: streamObject("", Buffer.concat([Buffer.from("q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /Fl ID "), zlib.deflateSync(Buffer.from([0x80])), Buffer.from(" EI Q")])) }));
		check("T20 an inline JPEG in the page, in a Form XObject, or with an escaped filter name: refused; an inline Flate image stays",
			[t20a.reason, t20b.reason, t20c.reason, t20d.status], ["inline_image", "inline_image", "inline_image", "pages"]);

		const rotated = fixtureJpeg({ exif: fixtureTiff() });
		const t21 = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /DCTDecode`, rotated)] }));
		const o21 = t21.status === "pages" ? await inspect(t21.pdf) : null;
		check("T21 a JPEG with orientation 6: attached, no APP1 left (orientation included)", [t21.status, o21 && o21.jpegs.every(jpegClean), o21 && o21.jpegs.length], ["pages", true, 1]);

		const t22 = await prep(onePage({
			catalog: "/OpenAction << /S /Launch /F (example.invalid) >>",
			page: "/Annots [5 0 R]",
			extra: ["<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /Launch /F (example.invalid) >> >>"],
		}));
		const o22 = t22.status === "pages" ? await inspect(t22.pdf) : null;
		check("T22 /Launch in OpenAction and in an annotation: none survives", [t22.status, o22 && hasAny(o22.names, ["Launch", "OpenAction", "Annots"]), o22 && o22.raw.includes("example.invalid")], ["pages", [], false]);

		const jpx = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /JPXDecode`, "jpx")] }));
		const jbig2 = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /JBIG2Decode`, "jb2")] }));
		const jpxEsc = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /JPXDecod#65`, "jpx")] }));
		const unknown = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /Crypt`, "x")] }));
		check("T23 JPX, JBIG2 (also spelt with an escape) refused; an unknown filter refused",
			[jpx.reason, jbig2.reason, jpxEsc.reason, unknown.reason], ["image_codec", "image_codec", "image_codec", "filter"]);

		const extF = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /F (example.jpg)`, "")] }));
		const extFF = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /FFilter /DCTDecode`, "")] }));
		const extContent = await prep(onePage({ content: streamObject("/F (example.txt)", "") }));
		check("T24 /F and /FFilter (external data), on an image or on the page content: refused",
			[extF.reason, extFF.reason, extContent.reason], ["external_stream", "external_stream", "external_stream"]);

		const t25 = await prep(onePage({
			content: "/P1 Do /R1 Do",
			resources: "/XObject << /P1 5 0 R /R1 6 0 R >>",
			extra: [
				streamObject("/Type /XObject /Subtype /PS", "%!PS made-up"),
				streamObject("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Ref << /F (example.pdf) /Page 0 >>", "0 0 5 5 re f"),
			],
		}));
		const o25 = t25.status === "pages" ? await inspect(t25.pdf) : null;
		check("T25 /PS and /Ref XObjects: dropped", [t25.status, o25 && hasAny(o25.names, ["PS", "Ref"]), o25 && o25.raw.includes("example.pdf")], ["pages", [], false]);

		const t26 = await prep(onePage({
			content: "/GS0 gs 0 0 1 rg 10 10 50 50 re f",
			resources: "/ExtGState << /GS0 5 0 R >>",
			extra: ["<< /Type /ExtGState /CA 1 /A << /S /URI /URI (https://example.invalid/) >> /AA << /O << /S /JavaScript /JS (void 0) >> >> >>"],
		}));
		const o26 = t26.status === "pages" ? await inspect(t26.pdf) : null;
		check("T26 /A and /AA inside a resource: stripped", [t26.status, o26 && hasAny(o26.names, ["A", "AA", "URI", "JS", "JavaScript"])], ["pages", []]);

		const t27 = await prep(onePage({ extra: Array.from({ length: 10_001 }, () => "null") }));
		check("T27 10,001 extra objects: refused (too_many_objects)", [t27.status, t27.reason], ["on_file", "too_many_objects"]);

		const seven = zlib.deflateSync(Buffer.alloc(7 * 1024 * 1024, 0x20));
		const t28 = await prep(rawPdf([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents [4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] >>",
			...Array.from({ length: 5 }, () => streamObject("/Filter /FlateDecode", seven)),
		]));
		check("T28 five 7 MB streams (35 MB > 32): refused by the total cap", [t28.status, t28.reason], ["on_file", "decode_total_cap"]);

		const t29s = Date.now();
		const objStm = streamObject("/Type /ObjStm /N 10000000 /First 4 /Filter /FlateDecode", zlib.deflateSync(Buffer.from("6 0 null")));
		const t29a = await prep(onePage({ extra: [objStm] }));
		const header = Array.from({ length: 20_000 }, (_, i) => `${i + 100} 0`).join(" ") + " ";
		const objStm2 = streamObject(`/Type /ObjStm /N 20000 /First ${header.length} /Filter /FlateDecode`, zlib.deflateSync(Buffer.from(`${header}null`)));
		const t29b = await prep(onePage({ extra: [objStm2] }));
		check("T29 an object stream naming 10,000,000 objects, and one naming 20,000: refused within the deadline",
			[t29a.status, t29b.status, t29b.reason, Date.now() - t29s < 2 * rp.RECEIPT_PDF_PREPARE_TIMEOUT_MS], ["on_file", "on_file", "too_many_objects", true]);

		const t30s = Date.now();
		const t30 = await prep(onePage({
			content: "/X1 Do",
			resources: "/XObject << /X1 5 0 R >>",
			extra: [streamObject("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X1 5 0 R >> >>", "0 0 5 5 re f")],
		}));
		check("T30 a Form XObject whose resources name itself: completes, no hang", [t30.status, Date.now() - t30s < rp.RECEIPT_PDF_PREPARE_TIMEOUT_MS], ["pages", true]);

		const t32 = await prep(onePage({
			catalog: "/OpenAction << /S /JavaScript /JS (void 0) >>",
			content: "BT /F1 12 Tf 10 10 Td (x) Tj ET",
			resources: "/Font << /F1 5 0 R >>",
			extra: ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Extra 1 0 R >>"],
		}));
		const orphanDoc = await PDFDocument.create({ updateMetadata: false });
		orphanDoc.addPage([100, 100]).node.delete(PDFName.of("Annots"));
		orphanDoc.context.register(orphanDoc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Extra: orphanDoc.context.obj({ OpenAction: orphanDoc.context.obj({ S: "JavaScript" }) }) }));
		const orphan = await PDFDocument.load(await orphanDoc.save({ useObjectStreams: false }), { updateMetadata: false });
		check("T32 a font dict reaching the source catalog: refused; an orphan holding an OpenAction fails the post-scan",
			[t32.status, t32.reason, childLib.postScan(pdfLib, stripImageMetadata, orphan, childLib.DEFAULT_LIMITS)], ["on_file", "resource_graph", "key:OpenAction"]);
	}

	// ---- review round 1 ---------------------------------------------------------
	console.log("R1 review round 1: page content, references, content totals, probes, input");
	{
		const exifJpeg = fixtureJpeg({ exif: gpsTiff() });
		const inlineTail = Buffer.concat([Buffer.from("/W 8 /H 8 /CS /G /BPC 8 /F /DCT ID "), exifJpeg, Buffer.from(" EI Q")]);
		const pageWith = (contents, objects) => rawPdf([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents [${contents}] >>`,
			...objects,
		]);

		const split = await prep(pageWith("4 0 R 5 0 R", [streamObject("", "q 10 0 0 10 0 0 cm BI"), streamObject("", inlineTail)]));
		const twoStreams = await prep(pageWith("4 0 R 5 0 R", [streamObject("", "q 0 0 1 rg"), streamObject("", "10 10 50 50 re f Q")]));
		check("M1 an inline image split across two of the page's content streams: refused; two ordinary streams still copy",
			[split.status, split.reason, twoStreams.status], ["on_file", "inline_image", "pages"]);

		const doubleForm = await prep(onePage({
			content: "/Fm0 Do",
			resources: "/XObject << /Fm0 5 0 R >>",
			extra: ["6 0 R", streamObject("/Type /XObject /Subtype /Form /BBox [0 0 100 100]", Buffer.concat([Buffer.from("q BI "), inlineTail]))],
		}));
		const doubleCatalog = await prep(onePage({ content: "BT /F1 12 Tf 10 10 Td (x) Tj ET", resources: "/Font << /F1 5 0 R >>", extra: ["1 0 R"] }));
		check("M2 an object that is only a reference to a form, or to the catalog: refused (resource_graph)",
			[doubleForm.status, doubleForm.reason, doubleCatalog.status, doubleCatalog.reason], ["on_file", "resource_graph", "on_file", "resource_graph"]);
		const refOnly = await PDFDocument.load(rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>", "1 0 R"]), { updateMetadata: false });
		check("M2 the post-scan refuses an object that is only a reference", childLib.postScan(pdfLib, stripImageMetadata, refOnly, childLib.DEFAULT_LIMITS), "indirect_reference");

		const forty = await prep(pageWith(Array(40).fill("4 0 R").join(" "), [streamObject("", Buffer.alloc(1024 * 1024, 0x20))]));
		const many = await prep(pageWith(Array(257).fill("4 0 R").join(" "), [streamObject("", "0 0 1 rg")]));
		check("M3 one 1 MB uncompressed stream listed 40 times: refused by the job total; more than 256 content streams on a page: refused",
			[forty.status, forty.reason, many.status, many.reason], ["on_file", "decode_total_cap", "on_file", "page_contents"]);

		const noProbes = rp.createReceiptPdfService({ receiptsDir: RECEIPTS, cacheDir: CACHE });
		const np = await noProbes.selfTest();
		const wrongLogs = [];
		const wrongProbes = rp.createReceiptPdfService({ ...BASE, probes: { env: path.join(TMP, "probe", "absent.env"), db: PROBE_DB }, log: (l) => wrongLogs.push(l) });
		const wp = await wrongProbes.selfTest();
		check("L1 the self-test fails with no probe paths, or with a probe path that does not exist (probe_missing)",
			[np.passed, np.problems, wp.passed, wp.problems, /env_readable=missing db_readable=no/.test(wrongLogs[0] || "")], [false, ["probe_missing"], false, ["probe_missing"], true]);

		let threw = null;
		let results = null;
		try {
			results = await Promise.all([svc.prepare(null), svc.prepare(undefined), svc.prepare(null, null), svc.prepare({ expenseId: 1, photoData: "" }, null)]);
		} catch (err) {
			threw = err && err.name;
		}
		check("L2 prepare(null), prepare(undefined) and a null options object give a result, never a throw",
			[threw, results && results.map((x) => `${x.status}:${x.reason}`)], [null, ["unavailable:no receipt", "unavailable:no receipt", "unavailable:no receipt", "unavailable:no receipt"]]);
	}

	// ---- L6: more limits and strips ------------------------------------------------
	console.log("L6 the queue, more limits and strips, the self-test's identity checks");
	{
		const SLOW = scratchChild("slow-child.js", "process.once('message', () => setTimeout(() => process.send({ ok: false, reason: 'probe' }, () => process.exit(0)), 300));\n");
		const slow = rp.createReceiptPdfService({ ...BASE, childPath: SLOW, queueCap: 1 });
		await slow.selfTest();
		const three = await Promise.all([1, 2, 3].map((n) => slow.prepare(put(onePage({ content: `0 0 1 rg ${n} ${n} 5 5 re f` })))));
		check("L6 one child at a time and a capped queue: past the cap a receipt is refused (busy)",
			[three.map((x) => x.reason).sort(), slow.stats().maxRunning], [["busy", "probe", "probe"], 1]);

		const objStmBig = streamObject("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", zlib.deflateSync(Buffer.concat([Buffer.from("6 0 "), Buffer.alloc(9 * 1024 * 1024, 0x20)])));
		const loadCap = await prep(onePage({ extra: [objStmBig] }));
		check("L6 an object stream inflating past 8 MB while the file loads: refused (decode_cap)", [loadCap.status, loadCap.reason], ["on_file", "decode_cap"]);

		const plainJpeg = fixtureJpeg();
		const strips = await prep(onePage({
			content: `${DRAW_IM0} /Fm0 Do`,
			resources: "/XObject << /Im0 5 0 R /Fm0 6 0 R >>",
			extra: [
				streamObject(`${IMAGE_DICT} /Filter /DCTDecode /OC << /Type /OCG /Name (layer) >> /Alternates [<< /Image 7 0 R /DefaultForPrinting true >>]`, plainJpeg),
				streamObject("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /PieceInfo << /Example << /LastModified (D:20260101000000Z) /Private (x) >> >>", "0 0 5 5 re f"),
				streamObject(`${IMAGE_DICT} /Filter /DCTDecode`, plainJpeg),
			],
		}));
		const os6 = strips.status === "pages" ? await inspect(strips.pdf) : null;
		check("L6 /OC, /Alternates and /PieceInfo are stripped", [strips.status, os6 && hasAny(os6.names, ["OC", "OCG", "Alternates", "DefaultForPrinting", "PieceInfo", "LastModified"])], ["pages", []]);

		const capped = rp.createReceiptPdfService({ ...BASE, limits: { outputMax: 4000 } });
		const noisy = require("crypto").randomBytes(8192);
		const tooBigOut = await capped.prepare(put(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject("/Type /XObject /Subtype /Image /Width 64 /Height 128 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", noisy)] })));
		check("L6 an output over the output cap: refused (output_too_large)", [capped.state(), tooBigOut.status, tooBigOut.reason], ["passed", "on_file", "output_too_large"]);

		const direct = await prep(onePage({ content: "/Fm0 Do", resources: "/XObject << /Fm0 << /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 12 >>\nstream\n0 0 5 5 re f\nendstream >>" }));
		check("L6 a stream written inside a dictionary: refused (direct_stream)", [direct.status, direct.reason], ["on_file", "direct_stream"]);

		const walker = rp.createReceiptPdfService({ ...BASE, limits: { maxWalk: 5000 } });
		const wide = await walker.prepare(put(onePage({ resources: `/Extra [${Array.from({ length: 10_000 }, (_, i) => i).join(" ")}]` })));
		check("L6 resources wider than the walk limit: refused (resource_graph)", [walker.state(), wide.status, wide.reason], ["passed", "on_file", "resource_graph"]);
		const smallDoc = await PDFDocument.load(rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"]), { updateMetadata: false });
		check("L6 the post-scan stops at the walk limit (post_scan_size)", childLib.postScan(pdfLib, stripImageMetadata, smallDoc, { ...childLib.DEFAULT_LIMITS, maxWalk: 3 }), "post_scan_size");

		const pred = await prep(onePage({ content: streamObject("/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>", zlib.deflateSync(Buffer.from("0 0 1 rg"))) }));
		const badJpeg = await prep(onePage({ content: DRAW_IM0, resources: "/XObject << /Im0 5 0 R >>", extra: [streamObject(`${IMAGE_DICT} /Filter /DCTDecode`, "not a jpeg at all")] }));
		check("L6 page content with a predictor: refused (predictor); a JPEG that cannot be walked: refused (image_metadata)",
			[pred.reason, badJpeg.reason], ["predictor", "image_metadata"]);

		if (!plainOut) {
			check("L6 a clean output is available for the fake self-test children", false, true);
		} else {
			const fake = (name, identity) => scratchChild(name, [
				`const pdf = Buffer.from(${JSON.stringify(Buffer.from(plainOut).toString("base64"))}, "base64");`,
				`process.once('message', () => process.send({ ok: true, identity: ${JSON.stringify(identity)}, hook: true, result: { ok: true, pdf, pages: 1 } }, () => process.exit(0)));`,
			].join("\n"));
			const ok = { gid: 20, groups: [20], env: "no", db: "no", permission: "on" };
			const root = await rp.createReceiptPdfService({ ...BASE, selfTestChildPath: fake("fake-uid0.js", { ...ok, uid: 0 }) }).selfTest();
			const wheel = await rp.createReceiptPdfService({ ...BASE, selfTestChildPath: fake("fake-group0.js", { ...ok, uid: 501, groups: [20, 0] }) }).selfTest();
			const gid0 = await rp.createReceiptPdfService({ ...BASE, selfTestChildPath: fake("fake-gid0.js", { ...ok, uid: 501, gid: 0 }) }).selfTest();
			check("L6 the self-test fails on uid 0, on group 0 and on gid 0 (identity), and on nothing else",
				[root.problems, wheel.problems, gid0.problems], [["identity"], ["identity"], ["identity"]]);
		}
	}

	// ---- review round 2 ---------------------------------------------------------
	console.log("R2 review round 2: the pdf-lib pin, metadata, image and page sizes");
	{
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
		const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
		check("R2-L2 package.json pins pdf-lib to exactly 1.17.1, the lock agrees, and so does the library's own check",
			[pkg.dependencies["pdf-lib"], lock.packages[""].dependencies["pdf-lib"], lock.packages["node_modules/pdf-lib"].version, rp.RECEIPT_PDF_PDF_LIB_VERSION],
			["1.17.1", "1.17.1", "1.17.1", "1.17.1"]);

		// A made-up pdf-lib of another version, resolved instead of the installed one.
		const OTHER = path.join(TMP, "other-pdf-lib");
		const otherLib = path.join(OTHER, "node_modules", "pdf-lib");
		fs.mkdirSync(path.join(otherLib, "cjs", "core", "streams"), { recursive: true });
		fs.writeFileSync(path.join(otherLib, "package.json"), JSON.stringify({ name: "pdf-lib", version: "1.17.2", main: "cjs/index.js" }));
		fs.writeFileSync(path.join(otherLib, "cjs", "index.js"), "module.exports = {};\n");
		fs.writeFileSync(path.join(otherLib, "cjs", "core", "streams", "DecodeStream.js"), "module.exports = {};\n");
		const childPath = path.join(ROOT, "lib", "receipt-pdf-child.js");
		let otherErr = null;
		try { rp.childModules(childPath, OTHER); } catch (err) { otherErr = err.code || "no_code"; }
		let installedErr = null;
		try { rp.childModules(childPath); } catch (err) { installedErr = err.code || "no_code"; }
		check("R2-L2 the child's setup refuses a pdf-lib of any other version (1.17.2 here) and accepts the installed 1.17.1",
			[otherErr, installedErr], ["PDF_LIB_VERSION", null]);
		const otherLogs = [];
		const otherSvc = rp.createReceiptPdfService({ ...BASE, pdfLibFrom: OTHER, log: (l) => otherLogs.push(l) });
		const ost = await otherSvc.selfTest();
		const or = await otherSvc.prepare(put(onePage()));
		check("R2-L2 with another pdf-lib version the self-test fails (child:pdf_lib_version), pages stay off, no child is started",
			[ost.passed, ost.problems[0], otherSvc.state(), or.status, or.reason, otherSvc.stats().forks, otherLogs.some((l) => /FAIL \(child:pdf_lib_version /.test(l))],
			[false, "child:pdf_lib_version", "failed", "on_file", "disabled", 0, true]);

		// Metadata: one made-up PDF carrying every kind, on the document, the
		// catalog, the page, an image and a form, and a JPEG carrying every kind of
		// metadata segment after its JFIF APP0.
		const seg = (marker, payload) => {
			const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
			const h = Buffer.from([0xFF, marker, 0, 0]);
			h.writeUInt16BE(p.length + 2, 2);
			return Buffer.concat([h, p]);
		};
		const baseJpeg = fixtureJpeg();
		const app0End = 4 + baseJpeg.readUInt16BE(4);
		const iccSeg = seg(0xE2, "ICC_PROFILE\0\x01\x01made-up-icc-profile");
		const adobeSeg = seg(0xEE, "Adobe\0\x64\0\0\0\0\x01");
		const srcJpeg = Buffer.concat([
			baseJpeg.subarray(0, app0End),
			seg(0xE1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), gpsTiff()])),
			seg(0xE1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>jpeg-xmp-6203</x:xmpmeta>"),
			iccSeg,
			seg(0xED, "Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x0ejpeg-iptc-6203"),
			seg(0xE3, "jpeg-app3-6203"),
			seg(0xEC, "Ducky\0jpeg-app12-6203"),
			adobeSeg,
			seg(0xFE, "jpeg-comment-6203"),
			baseJpeg.subarray(app0End),
			Buffer.from("jpeg-trailing-6203", "latin1"),
		]);
		const wantJpeg = Buffer.concat([baseJpeg.subarray(0, app0End), iccSeg, adobeSeg, baseJpeg.subarray(app0End)]);
		const metaSrc = rawPdf([
			"<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /XObject << /Im0 7 0 R /Fm0 8 0 R >> >> /Metadata 6 0 R /PieceInfo << /MadeUp << /LastModified (D:19990911111111Z) /Private (page-piece-6203) >> >> /LastModified (D:19990912121212Z) >>",
			streamObject("", `${DRAW_IM0} /Fm0 Do`),
			streamObject("/Type /Metadata /Subtype /XML", "<x:xmpmeta>catalog-xmp-6203</x:xmpmeta>"),
			streamObject("/Type /Metadata /Subtype /XML", "<x:xmpmeta>page-xmp-6203</x:xmpmeta>"),
			streamObject(`${IMAGE_DICT} /Filter /DCTDecode /Metadata 9 0 R /PieceInfo << /MadeUp << /Private (image-piece-6203) >> >> /LastModified (D:19990913131313Z)`, srcJpeg),
			streamObject("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Metadata 10 0 R /PieceInfo << /MadeUp << /Private (form-piece-6203) >> >> /LastModified (D:19990914141414Z)", "0 0 5 5 re f"),
			streamObject("/Type /Metadata /Subtype /XML", "<x:xmpmeta>image-xmp-6203</x:xmpmeta>"),
			streamObject("/Type /Metadata /Subtype /XML", "<x:xmpmeta>form-xmp-6203</x:xmpmeta>"),
			"<< /Title (doc-title-6203) /Author (doc-author-6203) /Producer (doc-producer-6203) /CreationDate (D:19990915151515Z) >>",
		], "/Info 11 0 R ");
		const srcDoc = await PDFDocument.load(metaSrc, { updateMetadata: false });
		const keysOf = (d) => (d ? d.keys().map((k) => childLib.plainName(k)) : []);
		const srcPage = srcDoc.getPage(0).node;
		const srcImage = srcDoc.context.lookup(PDFRef.of(7));
		const srcForm = srcDoc.context.lookup(PDFRef.of(8));
		const has3 = (keys) => ["Metadata", "PieceInfo", "LastModified"].every((k) => keys.includes(k));
		check("MD0 the made-up source holds every kind (Info, catalog XMP, page/image/form metadata, seven JPEG segments to drop)",
			[srcDoc.getTitle(), keysOf(srcDoc.catalog).includes("Metadata"), has3(keysOf(srcPage)), has3(keysOf(srcImage.dict)), has3(keysOf(srcForm.dict)), stripImageMetadata(srcJpeg).removed.slice().sort()],
			["doc-title-6203", true, true, true, true, ["comment", "exif", "marker_e1", "marker_e3", "marker_ec", "marker_ed", "trailing"]]);
		const meta = await prep(metaSrc);
		const om = meta.status === "pages" ? await inspect(meta.pdf) : null;
		const all = om ? om.raw + om.text : "";
		const absent = (...markers) => om !== null && markers.every((m) => !all.includes(m));
		const outPageKeys = om ? new Set(keysOf(om.doc.getPage(0).node)) : null;
		const xobjects = om ? om.streams.filter((s) => s.dict.lookup(PDFName.of("Type")) === PDFName.of("XObject")) : [];
		const xKeys = new Set(xobjects.flatMap((s) => keysOf(s.dict)));
		check("MD1 document Info: not copied (no Info in the output, no title, author, producer or date)",
			[meta.status, om && om.doc.context.trailerInfo.Info === undefined, absent("doc-title-6203", "doc-author-6203", "doc-producer-6203", "19990915")], ["pages", true, true]);
		check("MD2 catalog XMP: not copied", [om && keysOf(om.doc.catalog).includes("Metadata"), absent("catalog-xmp-6203")], [false, true]);
		check("MD3 the page's /Metadata, /PieceInfo and /LastModified: gone (output page and the form drawn from it)",
			[outPageKeys && hasAny(outPageKeys, ["Metadata", "PieceInfo", "LastModified"]), absent("page-xmp-6203", "page-piece-6203", "19990911", "19990912")], [[], true]);
		check("MD4 an image's and a form's /Metadata and /PieceInfo: gone",
			[xobjects.length >= 3, hasAny(xKeys, ["Metadata", "PieceInfo"]), absent("image-xmp-6203", "form-xmp-6203", "image-piece-6203", "form-piece-6203")], [true, [], true]);
		check("R2-L3 an image's and a form's own /LastModified: gone",
			[hasAny(xKeys, ["LastModified"]), om && om.names.has("LastModified"), absent("19990913", "19990914")], [[], false, true]);
		check("MD5 the JPEG: EXIF (GPS), XMP, IPTC, APP3, APP12, the comment and trailing bytes removed; JFIF APP0, ICC APP2 and Adobe APP14 kept byte for byte",
			[om && om.jpegs.length, om && om.jpegs[0] && om.jpegs[0].equals(wantJpeg), om && om.jpegs[0] && om.jpegs[0].includes(gpsTiff()), absent("-6203", "Exif", "Photoshop", "Ducky")],
			[1, true, false, true]);

		const scanDoc = await PDFDocument.load(rawPdf([
			"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
			"<< /PieceInfo << /MadeUp << /Private (x) >> >> >>",
		]), { updateMetadata: false });
		check("R2-L3 the post-scan refuses a /PieceInfo anywhere in the output", childLib.postScan(pdfLib, stripImageMetadata, scanDoc, childLib.DEFAULT_LIMITS), "key:PieceInfo");

		// L4: an image's declared size.
		const sizedImage = (dims, extra = []) => prep(onePage({
			content: DRAW_IM0,
			resources: "/XObject << /Im0 5 0 R >>",
			extra: [streamObject(`/Type /XObject /Subtype /Image ${dims} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode`, fixtureJpeg()), ...extra],
		}));
		const over = await sizedImage("/Width 8000 /Height 5001");
		const atCap = await sizedImage("/Width 8000 /Height 5000");
		const noWidth = await sizedImage("/Width (wide) /Height 8");
		const bigMask = await sizedImage("/Width 8 /Height 8 /SMask 6 0 R", [streamObject("/Type /XObject /Subtype /Image /Width 10000 /Height 10000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", zlib.deflateSync(Buffer.alloc(64)))]);
		check("R2-L4 an image declaring over 40 megapixels (8000 x 5001), a size that is not a number, or a soft mask over the cap: refused (image_size); 8000 x 5000 copies",
			[over.reason, noWidth.reason, bigMask.reason, atCap.status, rp.RECEIPT_PDF_MAX_IMAGE_PIXELS],
			["image_size", "image_size", "image_size", "pages", 40_000_000]);

		// L6: the page-size refusal.
		const sizedPage = (box) => prep(rawPdf([
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			`<< /Type /Page /Parent 2 0 R ${box} /Contents 4 0 R >>`,
			streamObject("", "0 0 1 rg 10 10 50 50 re f"),
		]));
		const wide = await sizedPage("/MediaBox [0 0 14401 400]");
		const thin = await sizedPage("/MediaBox [0 0 300 0.5]");
		const apart = await sizedPage("/MediaBox [0 0 300 400] /CropBox [500 500 600 600]");
		const noBox = await sizedPage("");
		const largest = await sizedPage("/MediaBox [0 0 14400 14400]");
		check("R2-L6 a page over 14,400 points, under 1 point, a CropBox outside the MediaBox, or no MediaBox: refused (page_box); 14,400 x 14,400 copies",
			[wide.reason, thin.reason, apart.reason, noBox.reason, largest.status], ["page_box", "page_box", "page_box", "page_box", "pages"]);
	}

	// ---- the cache ------------------------------------------------------------
	console.log("the cache");
	{
		const receipt = put(onePage({ content: "1 0 0 rg 20 20 80 80 re f" }));
		const first = await svc.prepare(receipt);
		const forks = svc.stats().forks;
		const second = await svc.prepare(receipt);
		check("a second prepare reads the cache (no new child) and returns the same bytes",
			[first.status, first.cached, second.status, second.cached, svc.stats().forks - forks, Buffer.compare(first.pdf, second.pdf)], ["pages", false, "pages", true, 0, 0]);
		const base = path.join(CACHE, rp.receiptPdfCacheName(receipt.expenseId, require("crypto").createHash("sha256").update(fs.readFileSync(path.join(RECEIPTS, path.basename(receipt.photoData)))).digest("hex")));
		fs.writeFileSync(`${base}.pdf`, Buffer.concat([fs.readFileSync(`${base}.pdf`), Buffer.from("x")]));
		const third = await svc.prepare(receipt);
		check("a damaged cache file is dropped and the receipt prepared again", [third.status, third.cached, svc.stats().forks - forks], ["pages", false, 1]);
		let threw = false;
		try { rp.createReceiptPdfService({ receiptsDir: RECEIPTS, cacheDir: path.join(TMP, "uploads", "cache") }); } catch { threw = true; }
		check("the cache never sits under an uploads folder", threw, true);
		const missing = await svc.prepare({ expenseId: ++nextId, photoData: "/uploads/expense-receipts/none.pdf" });
		const outside = await svc.prepare({ expenseId: ++nextId, photoData: "/etc/hosts" });
		check("a missing file or a path outside the receipts folder: unavailable", [missing.status, outside.status], ["unavailable", "unavailable"]);
	}

	// ---- T31-T35, T40 ---------------------------------------------------------
	console.log("T31 the heap cap and an empty environment");
	{
		const savedNodeOptions = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = "--max-old-space-size=4096";
		const HEAP = scratchChild("heap-child.js", "process.once('message', () => process.send({ ok: false, reason: 'probe', heap: require('v8').getHeapStatistics().heap_size_limit, nodeOptions: process.env.NODE_OPTIONS || null, envKeys: Object.keys(process.env).filter((k) => !k.startsWith('__CF_')) }, () => process.exit(0)));\n");
		const BLOW = scratchChild("blow-child.js", "process.once('message', () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(1.5)); });\n");
		let probe = null;
		const heapSvc = rp.createReceiptPdfService({ ...BASE, childPath: HEAP, trace: (e, i) => { if (e === "message" && i.message && i.message.reason === "probe") probe = i.message; } });
		await heapSvc.prepare(put(onePage()));
		const blowSvc = rp.createReceiptPdfService({ ...BASE, childPath: BLOW, timeoutMs: 20_000 });
		const t31s = Date.now();
		const blown = await blowSvc.prepare(put(onePage()));
		if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedNodeOptions;
		check("T31 the child's heap is capped near 256 MB even with NODE_OPTIONS set here, and it gets no environment",
			[probe && probe.heap <= 320 * 1024 * 1024, probe && probe.nodeOptions, probe && probe.envKeys], [true, null, []]);
		check("T31 a child that exhausts its heap dies; the note (crashed); this process carries on",
			[blown.status, blown.reason, Date.now() - t31s < 20_000, typeof process.memoryUsage().rss], ["on_file", "crashed", true, "number"]);
	}

	console.log("T33 a failed uid drop is never retried as root");
	{
		const otherUid = typeof process.getuid === "function" && process.getuid() !== 65534 ? 65534 : 65533;
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			console.log("  skip  T33 (this runner is root; it never runs anything as root on purpose)");
		} else {
			const dropSvc = rp.createReceiptPdfService({ ...BASE, runAs: { uid: otherUid, gid: otherUid } });
			const st = await dropSvc.selfTest();
			const r = await dropSvc.prepare(put(onePage()));
			check("T33 the uid option fails (EPERM): self-test fails, the receipt keeps the note, one fork in all",
				[st.passed, st.problems[0], r.status, r.reason, dropSvc.stats().forks], [false, "child:spawn_eperm", "on_file", "disabled", 1]);
		}
		check("T33 nobody's ids come from /etc/passwd, and never 0",
			[rp.unprivilegedIds(() => "root:x:0:0::/root:/bin/sh\nnobody:x:65534:65534::/:/usr/sbin/nologin\n"), rp.unprivilegedIds(() => "nobody:x:0:0::/:/bin/sh\n"), rp.unprivilegedIds(() => { throw new Error("no file"); })],
			[{ uid: 65534, gid: 65534 }, null, { uid: 65534, gid: 65534 }]);
		const opts = rp.forkOptions({ childPath: "/x/child.js", read: ["/x/child.js"], runAs: { uid: 65534, gid: 65534 } });
		check("T33 the fork options carry the uid and gid", [opts.uid, opts.gid], [65534, 65534]);
	}

	console.log("T34 the self-test fails when the decode cap is missing");
	{
		class FakeStream {
			constructor() { this.buffer = new Uint8Array(0); this.minBufferLength = 512; }
			ensureBuffer(n) { if (n > this.buffer.byteLength) this.buffer = new Uint8Array(n); return this.buffer; }
		}
		const before = childLib.hookInstalled(FakeStream);
		const installed = childLib.installDecodeCap(FakeStream);
		check("T34 the child's own check: no wrapper -> false; wrapped -> true", [before, installed, childLib.hookInstalled(FakeStream)], [false, true, true]);
		const NOHOOK = scratchChild("nohook-child.js", [
			"process.once('message', () => {",
			"  const id = { uid: process.getuid(), gid: process.getgid(), groups: [], env: 'no', db: 'no', permission: 'on' };",
			"  process.send({ ok: true, identity: id, hook: false, result: { ok: false, reason: 'decode_hook' } }, () => process.exit(0));",
			"});",
		].join("\n"));
		const noHookLogs = [];
		const noHook = rp.createReceiptPdfService({ ...BASE, selfTestChildPath: NOHOOK, log: (l) => noHookLogs.push(l) });
		const st = await noHook.selfTest();
		const r = await noHook.prepare(put(onePage()));
		check("T34 the self-test fails on the missing hook alone, pages stay off: the note (disabled), no job child started",
			[st.passed, st.problems, noHook.state(), r.status, r.reason, noHook.stats().forks], [false, ["decode_hook", "fixture"], "failed", "on_file", "disabled", 1]);
		check("T34 the failure is logged once with the reason", noHookLogs.filter((l) => /self-test: .*FAIL \(.*decode_hook.*\); PDF receipt pages off until restart/.test(l)).length, 1);
	}

	console.log("T35 the permission model");
	{
		const OUTSIDE = path.join(TMP, "outside.txt");
		fs.writeFileSync(OUTSIDE, "made up");
		const PROBE = scratchChild("perm-child.js", [
			"process.once('message', (m) => {",
			"  const fs = require('fs'); const out = {};",
			`  try { fs.readFileSync(${JSON.stringify(OUTSIDE)}); out.read = 'yes'; } catch (e) { out.read = e.code; }`,
			"  try { const r = require('child_process').spawnSync(process.execPath, ['-e', '0']); out.spawn = r.error ? r.error.code : 'yes'; } catch (e) { out.spawn = e.code; }",
			"  try { new (require('worker_threads').Worker)('0', { eval: true }); out.worker = 'yes'; } catch (e) { out.worker = e.code; }",
			`  try { fs.writeFileSync(${JSON.stringify(path.join(TMP, "written.txt"))}, 'x'); out.write = 'yes'; } catch (e) { out.write = e.code; }`,
			"  try { require(m.modules.pdfLib); out.pdfLib = 'yes'; } catch (e) { out.pdfLib = e.code; }",
			"  process.send({ ok: false, reason: 'probe', probe: out }, () => process.exit(0));",
			"});",
		].join("\n"));
		let probe = null;
		const permSvc = rp.createReceiptPdfService({ ...BASE, childPath: PROBE, trace: (e, i) => { if (e === "message" && i.message && i.message.probe) probe = i.message.probe; } });
		const r = await permSvc.prepare(put(onePage()));
		check("T35 the child cannot read outside its list, spawn, start a worker or write; it loads pdf-lib; IPC works",
			[probe, r.status, fs.existsSync(path.join(TMP, "written.txt"))],
			[{ read: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", pdfLib: "yes" }, "on_file", false]);
		const { read } = rp.childModules(path.join(ROOT, "lib", "receipt-pdf-child.js"));
		const opts = rp.forkOptions({ childPath: path.join(ROOT, "lib", "receipt-pdf-child.js"), read, runAs: null });
		check("T35 the fork options: --permission, reads only, a heap cap, an empty environment, no uid when not root",
			[opts.execArgv[0], opts.execArgv.some((a) => /allow-(child-process|worker|fs-write|addons|wasi)/.test(a)), opts.execArgv.filter((a) => a.startsWith("--allow-fs-read=")).length === read.length, opts.execArgv.includes(`--max-old-space-size=${rp.RECEIPT_PDF_HEAP_MB}`), opts.env, "uid" in opts],
			["--permission", false, true, true, {}, false]);
		check("T35 the read list is the child, lib/image-metadata.js and package folders only (no repo root, no data folder)",
			read.every((p) => p.endsWith(".js") || /node_modules/.test(p)) && !read.includes(ROOT), true);
	}

	console.log("T40 oom_score_adj before the first IPC message");
	{
		const events = [];
		const linuxSvc = rp.createReceiptPdfService({
			...BASE, platform: "linux",
			writeOomScoreAdj: (pid) => {
				events.push(["oom-write", pid]);
				if (process.platform === "linux") fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(rp.RECEIPT_PDF_OOM_SCORE_ADJ));
			},
			trace: (e, i) => {
				if (e === "oom" && process.platform === "linux") events.push(["read-back", fs.readFileSync(`/proc/${i.pid}/oom_score_adj`, "utf8").trim()]);
				if (e !== "message") events.push([e, i.pid]);
			},
		});
		const r = await linuxSvc.prepare(put(onePage()));
		const pids = [...new Set(events.filter((e) => e[0] === "fork").map((e) => e[1]))];
		const ordered = pids.every((pid) => {
			const at = (name) => events.findIndex((e) => e[0] === name && e[1] === pid);
			return at("fork") < at("oom-write") && at("oom-write") < at("send");
		});
		check("T40 on Linux every child is forked, given oom_score_adj, then sent its bytes (self-test and job)", [r.status, pids.length >= 2, ordered], ["pages", true, true]);
		if (process.platform === "linux") {
			check("T40 (Linux) the value read back is 1000", events.filter((e) => e[0] === "read-back").every((e) => e[1] === "1000"), true);
		} else {
			console.log("  skip  T40 read-back of /proc/<pid>/oom_score_adj (Linux only)");
		}
		let writes = 0;
		const macSvc = rp.createReceiptPdfService({ ...BASE, platform: "darwin", writeOomScoreAdj: () => { writes++; } });
		const rm = await macSvc.prepare(put(onePage()));
		check("T40 elsewhere nothing is written", [rm.status, writes], ["pages", 0]);
		const failSvc = rp.createReceiptPdfService({ ...BASE, platform: "linux", writeOomScoreAdj: () => { throw new Error("EACCES"); } });
		const rf = await failSvc.prepare(put(onePage()));
		check("T40 a failed write sends nothing: the self-test fails and the receipt keeps the note", [failSvc.state(), rf.status, rf.reason], ["failed", "on_file", "disabled"]);
	}

	fs.rmSync(TMP, { recursive: true, force: true });
	finish();
})().catch((e) => { console.error(e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); });
