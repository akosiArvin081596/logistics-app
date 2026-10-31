#!/usr/bin/env node
// lib/pdf-shown-text.js: the text a PDF shows, read without a parser package,
// for the automatic invoice digest (lib/auto-invoice-rules.js messageDigest()).
//
//   §1 Chromium's way: two-byte glyph codes through a ToUnicode map, one glyph
//      per operator, resources inherited from the page tree, contents as a list;
//      the text reads back exactly, the same however the codes are numbered
//   §2 the other shapes: literal strings through a standard font, TJ arrays,
//      single-byte codes with ranges, a Form XObject's text, q/Q restoring the
//      font, an unfiltered stream, a contents reference to a list
//   §3 what it can't read: "" for nothing readable, never a throw; an unknown
//      filter and an image stream are not text; the byte budget holds; hostile
//      input stays fast
//   §4 the repo's own Chromium-made PDFs (docs/pdf, client/public/policies): their
//      words read back, no glyph left unmapped, the same on a second read; the
//      built-in extractPdfText() reads none of those words (why this reader exists)
//   §5 mutants: a reader that ignores ToUnicode, or joins glyphs with a space,
//      fails §1
//   §6 the work budget: four small documents that are far more work than their
//      size (a form drawing itself, pages sharing one stream, overlapping
//      ToUnicode ranges, a long run of digits) read as unreadable within 2 s;
//      one document past each limit (bytes inflated, characters and tokens read,
//      form draws and depth, map entries, word length, pages, page-tree depth,
//      text) reads as unreadable, never as a partial text, and a reader with that
//      limit raised reads past it; a ToUnicode code longer than four bytes is no
//      code, and the read finishes
//
// Made-up text only, apart from the committed documentation PDFs. No network;
// §6 runs two reads in a child process it stops itself.
//   node scripts/test-pdf-shown-text.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const READER_FILE = path.join(ROOT, "lib", "pdf-shown-text.js");
const { shownText } = require(READER_FILE);
const { extractPdfText } = require(path.join(ROOT, "lib", "broker-invoice.js"));
const { textPdf } = require("./lib/made-up-pdf");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

// A PDF from objects given as text (streams deflated), with a valid xref.
function pdfOf(objects) {
	const parts = [Buffer.from("%PDF-1.7\n", "latin1")];
	let at = parts[0].length;
	const offsets = [];
	objects.forEach((o, i) => {
		offsets.push(at);
		let b;
		if (o.stream !== undefined) {
			const data = o.raw ? Buffer.from(o.stream, "latin1") : zlib.deflateSync(Buffer.from(o.stream, "latin1"));
			const filter = o.raw ? "" : " /Filter /FlateDecode";
			b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict || ""}${filter} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
		} else {
			b = Buffer.from(`${i + 1} 0 obj\n${o.dict}\nendobj\n`, "latin1");
		}
		parts.push(b);
		at += b.length;
	});
	parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
	return Buffer.concat(parts);
}

const INVOICE_TEXT = "INVOICE Invoice ID # : 10202026-1 Date: 10/20/2026 Made-up Co. Invoice To Example Broker billing@example-broker.test Example Broker Order: #123456789 10/19/2026 $1,500.00 Total $1,500.00 Café — €5";

function checks(read, tag = "") {
	const out = [];
	out.push(read(textPdf(INVOICE_TEXT)) === INVOICE_TEXT);
	out.push(read(textPdf("aab")) === "aab" && read(textPdf("baa")) === "baa");
	return out.every(Boolean);
}

// ------------------------------------------------------------------ §1
section("§1  Chromium's way: two-byte glyph codes and a ToUnicode map");
eq(shownText(textPdf(INVOICE_TEXT)), INVOICE_TEXT, "§1 the text reads back exactly: one glyph per Tj, spaces as glyphs, accents and symbols through the map");
eq(shownText(textPdf(INVOICE_TEXT, { compress: false })), INVOICE_TEXT, "§1 ...and from an unfiltered stream");
eq([shownText(textPdf("10202026-1")), shownText(textPdf("00000000-0"))], ["10202026-1", "00000000-0"], "§1 different characters numbered differently (two font subsets) still read as themselves");
ok(checks(shownText), "§1 (the check the mutants below must fail)");
eq(shownText(textPdf("Order #123 🚚")), "Order #123 🚚", "§1 a character outside the basic plane (a surrogate pair in the map)");

// ------------------------------------------------------------------ §2
section("§2  the other shapes");
eq(shownText(textPdf("Rate (Total) $1,000.00 \\ end", { mode: "literal" })), "Rate (Total) $1,000.00 \\ end", "§2 literal strings through a standard font, with escaped parentheses and backslash");
const cmap1 = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0048> <02> <0069> endbfchar 1 beginbfrange <10> <12> <0041> endbfrange 1 beginbfrange <20> <21> [<0058> <0059>] endbfrange endcmap end end";
const oneByte = pdfOf([
	{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
	{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
	{ dict: "<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 6 0 R >>" },
	{ dict: "<< /Font << /F1 5 0 R >> /XObject << /X1 8 0 R >> >>" },
	{ dict: "<< /Type /Font /Subtype /TrueType /BaseFont /MadeUp /ToUnicode 7 0 R >>" },
	{ stream: "q BT /F1 10 Tf <0102> Tj [<10> -20 <11> 300 <12>] TJ ET Q BT /F1 10 Tf (\\001) ' ET /X1 Do BT /F1 10 Tf 1 2 <2021> \" ET" },
	{ stream: cmap1 },
	{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F2 5 0 R >> >>", stream: "BT /F2 9 Tf <1110> Tj ET" },
]);
eq(shownText(oneByte), "HiABCHBAXY", "§2 one-byte codes: bfchar, bfrange, an array bfrange, TJ arrays (numbers skipped), the ' and \" operators, and a Form XObject's own text in order");
const qq = pdfOf([
	{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
	{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
	{ dict: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /A 4 0 R /B 5 0 R >> >> /Contents 6 0 R >>" },
	{ dict: "<< /Type /Font /Subtype /TrueType /ToUnicode 7 0 R >>" },
	{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
	{ stream: "BT /A 9 Tf q /B 9 Tf (z) Tj Q <01> Tj ET" },
	{ stream: "1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <0051> endbfchar" },
]);
eq(shownText(qq), "zQ", "§2 Q restores the font q saved");
const listRef = pdfOf([
	{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
	{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
	{ dict: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" },
	{ dict: "[6 0 R 7 0 R]" },
	{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
	{ stream: "BT /F1 9 Tf (one ) Tj ET" },
	{ stream: "BT /F1 9 Tf (two) Tj ET", raw: true },
]);
eq(shownText(listRef), "one two", "§2 contents given as a reference to a list, one stream deflated and one not");

// ------------------------------------------------------------------ §3
section("§3  what it can't read");
eq([shownText(Buffer.alloc(0)), shownText(null), shownText("not a buffer"), shownText(Buffer.from("plain text, no PDF")), shownText(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog"))],
	["", "", "", "", ""], "§3 nothing readable: \"\", never a throw");
const image = pdfOf([
	{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
	{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
	{ dict: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /I1 6 0 R >> >> /Contents 4 0 R >>" },
	{ stream: "/I1 Do BT /F1 9 Tf (after) Tj ET" },
	{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
	{ dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode", stream: "(not) Tj (text) Tj", raw: true },
]);
eq(shownText(image), "after", "§3 an image stream (an unknown filter) is not text");
const big = textPdf("x".repeat(20000));
eq(shownText(big, { maxInflatedBytes: 1000 }), "", "§3 a budget smaller than the streams: nothing inflated past it");
eq(shownText(big).length, 20000, "§3 ...the default budget reads it");
const hostile = Buffer.from("%PDF-1.4\n" + "1 0 obj ".repeat(20000) + "(".repeat(100000) + "<".repeat(100000) + "[".repeat(100000), "latin1");
const t0 = Date.now();
eq(shownText(hostile), "", "§3 hostile input (unclosed objects, strings, arrays) reads as nothing");
ok(Date.now() - t0 < 5000, `§3 ...in bounded time (${Date.now() - t0} ms)`);

// ------------------------------------------------------------------ §4
section("§4  the repo's own Chromium-made PDFs");
const COMMITTED = [
	[path.join(ROOT, "docs", "pdf", "LogisX-Dispatcher-Guide.pdf"), ["Dispatcher", "Guide", "the", "and"]],
	[path.join(ROOT, "docs", "pdf", "LogisX-Investor-Guide.pdf"), ["Investor", "Guide", "the", "and"]],
	[path.join(ROOT, "client", "public", "policies", "LogisX-Mobile-Policy.pdf"), ["Policy", "the", "and"]],
];
for (const [file, words] of COMMITTED) {
	const name = path.basename(file);
	if (!fs.existsSync(file)) { failures.push(`§4 ${name} is missing`); continue; }
	const buf = fs.readFileSync(file);
	ok(/Producer \(Skia\/PDF m\d+/.test(buf.toString("latin1")), `§4 ${name} was written by Chromium's PDF backend (Skia)`);
	const text = shownText(buf);
	eq(words.filter((w) => !text.includes(w)), [], `§4 ${name}: its words read back`);
	eq((text.match(/�/g) || []).length, 0, `§4 ${name}: no glyph left unmapped`);
	ok(shownText(buf) === text, `§4 ${name}: the same text on a second read`);
	// Titles and links are literal strings it can see; the body's words are not.
	const builtIn = extractPdfText(buf);
	eq([" the ", " and "].filter((w) => builtIn.includes(w)), [], `§4 ${name}: the built-in extractPdfText() reads none of its body ("the", "and")`);
	eq([" the ", " and "].filter((w) => !text.includes(w)), [], `§4 ${name}: ...which this reader reads`);
}

// ------------------------------------------------------------------ §5
section("§5  mutants");
function mutant(from, to) {
	const src = fs.readFileSync(READER_FILE, "utf8");
	const hits = src.split(from).length - 1;
	if (hits !== 1) return { applied: false, hits };
	const m = new Module(READER_FILE, module);
	m.filename = READER_FILE;
	m.paths = Module._nodeModulePaths(path.dirname(READER_FILE));
	m._compile(src.replace(from, () => to), READER_FILE);
	return { applied: true, read: m.exports.shownText };
}
for (const [label, from, to] of [
	["a reader that ignores ToUnicode", "const cmap = tu && tu.ref !== undefined ? parseCMap(streamText(tu.ref), work) : null;", "const cmap = null;"],
	["a reader that joins glyphs with a space", "return out.parts.join(\"\");", "return out.parts.join(\" \");"],
]) {
	const r = mutant(from, to);
	ok(r.applied, `§5 MUTANT ${label}: applied to the shipped source once`);
	if (r.applied) ok(!checks(r.read), `§5 MUTANT ${label}: is caught by §1`);
}

// ------------------------------------------------------------------ §6
section("§6  the work budget: past any limit the whole document is unreadable");
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const CATALOG = { dict: "<< /Type /Catalog /Pages 2 0 R >>" };
const HOSTILE_MS = 2000;
const timed = (read, buf, opts) => {
	const t0 = Date.now();
	const text = read(buf, opts);
	return { text, ms: Date.now() - t0 };
};
// One Pages node over n pages (objects first to first+n-1), the font inherited;
// pageObjects() makes those pages, each showing one content stream.
const pagesSharing = (n, first, fontRef) => ({ dict: `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${first + i} 0 R`).join(" ")}] /Count ${n} /Resources << /Font << /F1 ${fontRef} 0 R >> >> >>` });
const pageObjects = (n, streamRef) => Array.from({ length: n }, () => ({ dict: `<< /Type /Page /Parent 2 0 R /Contents ${streamRef} 0 R >>` }));
const onePage = (content, resources = "/Font << /F1 5 0 R >>", more = [{ dict: FONT }]) => pdfOf([
	CATALOG,
	{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
	{ dict: `<< /Type /Page /Parent 2 0 R /Resources << ${resources} >> /Contents 4 0 R >>` },
	{ stream: content },
	...more,
]);
const toUnicodePage = (cmap) => onePage("BT /F1 9 Tf <41> Tj ET", "/Font << /F1 5 0 R >>", [{ dict: "<< /Type /Font /Subtype /TrueType /ToUnicode 6 0 R >>" }, { stream: cmap }]);

// Four small documents that are far more work than their size: each reads as
// unreadable, and quickly.
for (const [label, make] of [
	["a form that draws itself eight times at every level", () => onePage("/X Do", "/XObject << /X 5 0 R >>",
		[{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /X 5 0 R >> >>", stream: "/X Do ".repeat(8) }])],
	["800 pages sharing one 256 KB content stream", () => pdfOf([CATALOG, pagesSharing(800, 5, 4), { stream: "q Q ".repeat(65536) }, { dict: FONT }, ...pageObjects(800, 3)])],
	["160 overlapping ToUnicode ranges of 32,768 codes each", () => toUnicodePage(`1 begincodespacerange <00> <FF> endcodespacerange 160 beginbfrange\n${"<0000> <7FFF> <0041>\n".repeat(160)}endbfrange`)],
	["an object holding a run of 128,000 digits", () => Buffer.from(`%PDF-1.7\n1 0 obj\n${"1".repeat(128000)}x\nendobj\n`, "latin1")],
]) {
	const r = timed(shownText, make());
	eq(r.text.length, 0, `§6 ${label}: unreadable (characters read)`);
	ok(r.ms < HOSTILE_MS, `§6 ...within ${HOSTILE_MS} ms (took ${r.ms} ms)`);
}

// One document past each limit: "" from the shipped reader, never the part it
// read before the limit; with the limit raised (a mutant), a reader reads past it.
const nested = () => {
	// Forms 4 to 12 each show a letter and draw the next: nine inside one another.
	const forms = Array.from({ length: 9 }, (_, i) => ({
		dict: `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /Font << /F1 14 0 R >> ${i < 8 ? `/XObject << /X ${i + 5} 0 R >> ` : ""}>>`,
		stream: `BT /F1 9 Tf (${"abcdefghi"[i]}) Tj ET${i < 8 ? " /X Do" : ""}`,
	}));
	return pdfOf([CATALOG, { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" }, { dict: "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /X 4 0 R >> >> /Contents 13 0 R >>" },
		...forms, { stream: "/X Do" }, { dict: FONT }]);
};
const deepTree = () => {
	// Pages nodes 2 to 71 in a chain: page "a" under the first, page "b" under the last.
	const chain = Array.from({ length: 70 }, (_, i) => ({
		dict: `<< /Type /Pages /Kids [${i === 0 ? "72 0 R 3 0 R" : i < 69 ? `${i + 3} 0 R` : "73 0 R"}] /Count 1${i === 0 ? " /Resources << /Font << /F1 76 0 R >> >>" : ""} >>`,
	}));
	return pdfOf([CATALOG, ...chain, { dict: "<< /Type /Page /Contents 74 0 R >>" }, { dict: "<< /Type /Page /Contents 75 0 R >>" },
		{ stream: "BT /F1 9 Tf (a) Tj ET" }, { stream: "BT /F1 9 Tf (b) Tj ET" }, { dict: FONT }]);
};
for (const [label, make, opts, from, to] of [
	["bytes inflated (the second page's stream past the budget)", () => pdfOf([CATALOG,
		{ dict: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> >>" },
		{ dict: "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>" }, { dict: "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>" },
		{ stream: "BT /F1 9 Tf (abc) Tj ET" }, { stream: `BT /F1 9 Tf (${"z".repeat(4000)}) Tj ET` }, { dict: FONT }]),
	{ maxInflatedBytes: 1000 }, "if (tooLarge(e)) throw new LimitReached(\"inflatedBytes\");", "if (tooLarge(e)) return \"\";"],
	["characters read (40 pages sharing one 1 MB stream)", () => pdfOf([CATALOG, pagesSharing(40, 5, 4), { stream: `${" ".repeat(1024 * 1024)}BT /F1 9 Tf (a) Tj ET` }, { dict: FONT }, ...pageObjects(40, 3)]),
		{}, "chars: 32 * 1024 * 1024,", "chars: Infinity,"],
	["tokens read (2.1 million)", () => onePage(`${"q Q ".repeat(1050000)}BT /F1 9 Tf (a) Tj ET`), {}, "tokens: 2000000,", "tokens: Infinity,"],
	["form draws (1,100)", () => onePage("/X Do ".repeat(1100), "/XObject << /X 5 0 R >>",
		[{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /Font << /F1 6 0 R >> >>", stream: "BT /F1 9 Tf (a) Tj ET" }, { dict: FONT }]), {}, "formDraws: 1024,", "formDraws: Infinity,"],
	["form depth (nine forms inside one another)", nested, {}, "formDepth: 8,", "formDepth: 64,"],
	["ToUnicode entries set (nine overlapping ranges of 32,768 codes)", () => toUnicodePage(`1 begincodespacerange <00> <FF> endcodespacerange 9 beginbfrange\n${"<0000> <7FFF> <0041>\n".repeat(9)}endbfrange`),
		{}, "mapSteps: 4 * 65536,", "mapSteps: Infinity,"],
	["word length (a number of 300 digits and a letter)", () => onePage(`BT /F1 9 Tf ${"1".repeat(300)}x (a) Tj ET`), {}, "wordChars: 256,", "wordChars: Infinity,"],
	["pages (2,001)", () => pdfOf([CATALOG, pagesSharing(2001, 5, 4), { stream: "BT /F1 9 Tf (a) Tj ET" }, { dict: FONT }, ...pageObjects(2001, 3)]), {}, "pages: 2000,", "pages: Infinity,"],
	["page-tree depth (70 levels)", deepTree, {}, "treeDepth: 64,", "treeDepth: Infinity,"],
	["text shown (2.2 million characters)", () => onePage(`BT /F1 9 Tf (${"x".repeat(2200000)}) Tj ET`), {}, "textChars: 2 * 1024 * 1024,", "textChars: Infinity,"],
]) {
	const buf = make();
	const r = timed(shownText, buf, opts);
	eq(r.text.length, 0, `§6 ${label}: unreadable, not a partial text (characters read)`);
	ok(r.ms < HOSTILE_MS, `§6 ...within ${HOSTILE_MS} ms (took ${r.ms} ms)`);
	const m = mutant(from, to);
	ok(m.applied, `§6 MUTANT ${label}, the limit raised: applied to the shipped source once`);
	if (m.applied) ok(m.read(buf, opts) !== "", `§6 MUTANT ${label}, the limit raised: reads past it (caught)`);
}

// A ToUnicode range of codes longer than four bytes is skipped (the glyph reads as
// unmapped). Read in a child process, stopped by its own handle if it doesn't
// finish, so this run always ends.
const READER_SRC = fs.readFileSync(READER_FILE, "utf8");
function readInChild(source, pdf, timeoutMs) {
	const script = `const Module = require("module");
const m = new Module(${JSON.stringify(READER_FILE)}, null);
m._compile(${JSON.stringify(source)}, ${JSON.stringify(READER_FILE)});
process.stdout.write(JSON.stringify(m.exports.shownText(Buffer.from(${JSON.stringify(pdf.toString("base64"))}, "base64"))));`;
	const r = spawnSync(process.execPath, ["-"], { input: script, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
	return r.status === 0 ? { finished: true, text: JSON.parse(r.stdout) } : { finished: false };
}
const longCodes = (bytes) => toUnicodePage(`1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange\n<${"FF".repeat(bytes)}> <${"FF".repeat(bytes)}> <0041>\nendbfrange`);
for (const bytes of [7, 200]) {
	eq(readInChild(READER_SRC, longCodes(bytes), 10000), { finished: true, text: "�" }, `§6 a ToUnicode range of ${bytes}-byte codes: skipped (the glyph unmapped), and the read finishes`);
}
const IS_CODE = "const isCode = (b) => Buffer.isBuffer(b) && b.length >= 1 && b.length <= 4;";
const anyLength = READER_SRC.split(IS_CODE).length === 2 ? READER_SRC.replace(IS_CODE, () => "const isCode = (b) => Buffer.isBuffer(b);") : null;
ok(anyLength, "§6 MUTANT codes of any length: applied to the shipped source once");
if (anyLength) eq(readInChild(anyLength, longCodes(7), 2000).finished, false, "§6 MUTANT codes of any length: caught (the read doesn't finish within 2 s; the child is stopped)");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
