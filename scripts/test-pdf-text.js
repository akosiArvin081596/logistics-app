#!/usr/bin/env node
// scripts/lib/pdf-text.js, the reader behind test-pdf-cold-start.js's render
// comparison, on made-up PDFs built here with pdf-lib (no browser).
//
//   §1 fonts: every font is named by subtype, name and a digest of its glyph
//      program. Type3 fonts, which carry no BaseFont and are what Chromium
//      writes for web fonts, are named from their descriptor's FontName, else
//      its FontFamily, weight and slant, else "(unnamed)"; TrueType and Type0
//      fonts by BaseFont, without the subset tag. Two fonts of one name with
//      different glyph programs read apart.
//   §2 text through a Type3 font's ToUnicode map, and through a form XObject
//      that uses its parent's font
//   §3 compareRenders(): two copies of a document hold; a changed glyph, a
//      changed glyph program and a changed drawing each fail; and nothing holds
//      by being empty: no page, text with no font read, fonts with no text read
//   §4 a document whose only fonts are Type3 (a broker invoice in web fonts):
//      its fonts are read, and two copies hold
//
//   node scripts/test-pdf-text.js      # exits 1 on any failure

"use strict";

const path = require("path");
const { PDFDocument, PDFName, PDFString } = require("pdf-lib");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
	if (cond) { pass++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function eq(name, got, want) {
	ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

let lib = null;
try { lib = require(path.join(__dirname, "lib", "pdf-text.js")); } catch (e) { console.log(`  (scripts/lib/pdf-text.js not loaded: ${e.message})`); }
const pdfReport = lib && lib.pdfReport;
const compareRenders = lib && typeof lib.compareRenders === "function" ? lib.compareRenders : null;

const CMAP = (pairs) => `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /MadeUp def 1 begincodespacerange <00> <FF> endcodespacerange
${pairs.length} beginbfchar
${pairs.map(([code, uni]) => `<${code}> <${uni}>`).join("\n")}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;

// A Type3 font drawing "A" and "B" (codes 41 and 42), with `glyph` as the
// procedure for "A", and the descriptor given (or none).
function type3(ctx, { descriptor = null, glyph = "500 0 0 0 500 700 d1 0 0 m 500 700 l S" } = {}) {
	const procA = ctx.register(ctx.flateStream(glyph));
	const procB = ctx.register(ctx.flateStream("500 0 0 0 500 700 d1 0 0 m 0 700 l S"));
	return ctx.register(ctx.obj({
		Type: "Font", Subtype: "Type3",
		FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
		CharProcs: { gA: procA, gB: procB },
		Encoding: { Type: "Encoding", Differences: [65, "gA", "gB"] },
		FirstChar: 65, LastChar: 66, Widths: [500, 500],
		...(descriptor ? { FontDescriptor: ctx.register(ctx.obj(descriptor)) } : {}),
		ToUnicode: ctx.register(ctx.flateStream(CMAP([["41", "0041"], ["42", "0042"]]))),
	}));
}
// A TrueType font with a made-up font file.
function trueType(ctx, { base, file }) {
	const fontFile = ctx.register(ctx.flateStream(file));
	const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: base, Flags: 32, FontFile2: fontFile }));
	return ctx.register(ctx.obj({
		Type: "Font", Subtype: "TrueType", BaseFont: base, FirstChar: 65, LastChar: 66, Widths: [600, 600],
		FontDescriptor: descriptor, ToUnicode: ctx.register(ctx.flateStream(CMAP([["41", "0041"], ["42", "0042"]]))),
	}));
}
// A Type0 font whose descriptor sits on its descendant.
function type0(ctx, { base, file }) {
	const fontFile = ctx.register(ctx.flateStream(file));
	const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: base, Flags: 4, FontFile2: fontFile }));
	const descendant = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: base, FontDescriptor: descriptor }));
	return ctx.register(ctx.obj({
		Type: "Font", Subtype: "Type0", BaseFont: base, Encoding: "Identity-H", DescendantFonts: [descendant],
		ToUnicode: ctx.register(ctx.flateStream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar
<0003> <0058>
<0004> <0059>
endbfchar endcmap end end`)),
	}));
}

// One page drawing `content` with the fonts given as { F1: ref, … }, and an
// optional form XObject (drawn with "/X1 Do") that has no fonts of its own.
async function makePdf({ fonts, content, form = null }) {
	const doc = await PDFDocument.create();
	const ctx = doc.context;
	const page = doc.addPage([300, 200]);
	for (const [name, make] of Object.entries(fonts)) page.node.setFontDictionary(PDFName.of(name), make(ctx));
	if (form) {
		const xo = ctx.register(ctx.flateStream(form, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200] }));
		page.node.Resources().set(PDFName.of("XObject"), ctx.obj({ X1: xo }));
	}
	page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const BOLD = { Type: "FontDescriptor", FontName: "ABCDEF+Made-Up-Sans-Bold", Flags: 4, ItalicAngle: 0 };
const FAMILY_ONLY = { Type: "FontDescriptor", FontFamily: PDFString.of("Made Up Sans"), FontWeight: 700, ItalicAngle: -12, Flags: 4 };

(async () => {
	ok("scripts/lib/pdf-text.js loads", !!pdfReport);
	ok("it exports compareRenders()", !!compareRenders);
	if (!pdfReport) {
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}

	console.log("§1 fonts");
	const named = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: BOLD }) }, content: "BT /F1 12 Tf 10 10 Td <4142> Tj ET" }));
	ok("§1 a Type3 font is read, named from its descriptor's FontName without the subset tag",
		named.fonts.length === 1 && /^Type3 Made-Up-Sans-Bold #[0-9a-f]{12}$/.test(named.fonts[0]), JSON.stringify(named.fonts));
	const family = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: FAMILY_ONLY }) }, content: "BT /F1 12 Tf <41> Tj ET" }));
	ok("§1 ...else from its FontFamily, weight and slant", family.fonts.length === 1 && /^Type3 Made Up Sans 700 italic #[0-9a-f]{12}$/.test(family.fonts[0]), JSON.stringify(family.fonts));
	const bare = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c) }, content: "BT /F1 12 Tf <41> Tj ET" }));
	ok("§1 ...else \"(unnamed)\", still with its glyph program's digest", bare.fonts.length === 1 && /^Type3 \(unnamed\) #[0-9a-f]{12}$/.test(bare.fonts[0]), JSON.stringify(bare.fonts));
	const tt = await pdfReport(await makePdf({ fonts: { F1: (c) => trueType(c, { base: "GHIJKL+MadeUpSerif", file: "made-up font file 1" }) }, content: "BT /F1 12 Tf <41> Tj ET" }));
	ok("§1 a TrueType font by its BaseFont, without the subset tag, and its font file's digest", tt.fonts.length === 1 && /^TrueType MadeUpSerif #[0-9a-f]{12}$/.test(tt.fonts[0]), JSON.stringify(tt.fonts));
	const t0 = await pdfReport(await makePdf({ fonts: { F1: (c) => type0(c, { base: "MNOPQR+MadeUpMono", file: "made-up font file 2" }) }, content: "BT /F1 12 Tf <00030004> Tj ET" }));
	ok("§1 a Type0 font by its BaseFont, its font file found on the descendant", t0.fonts.length === 1 && /^Type0 MadeUpMono #[0-9a-f]{12}$/.test(t0.fonts[0]) && !/no-program/.test(t0.fonts[0]), JSON.stringify(t0.fonts));
	const other = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: BOLD, glyph: "500 0 0 0 500 700 d1 0 0 m 250 700 l S" }) }, content: "BT /F1 12 Tf 10 10 Td <4142> Tj ET" }));
	ok("§1 the same name with a different glyph program reads as a different font", other.fonts.length === 1 && other.fonts[0] !== named.fonts[0] && other.fonts[0].startsWith("Type3 Made-Up-Sans-Bold #"), `${named.fonts[0]} / ${other.fonts[0]}`);
	const ttOther = await pdfReport(await makePdf({ fonts: { F1: (c) => trueType(c, { base: "GHIJKL+MadeUpSerif", file: "made-up font file 1, changed" }) }, content: "BT /F1 12 Tf <41> Tj ET" }));
	ok("§1 ...and so does a TrueType font with a different font file", ttOther.fonts[0] !== tt.fonts[0]);

	console.log("§2 text");
	eq("§2 text through a Type3 font's ToUnicode map", named.pages, ["AB"]);
	eq("§2 text through a Type0 font's two-byte codes", t0.pages, ["XY"]);
	const viaForm = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: BOLD }) }, content: "/X1 Do", form: "BT /F1 12 Tf <4241> Tj ET" }));
	eq("§2 text in a form XObject that uses its page's font", viaForm.pages, ["BA"]);

	console.log("§3 compareRenders()");
	if (!compareRenders) {
		ok("§3 not run: compareRenders() is missing", false);
	} else {
		const holds = (r) => Object.values(r).every((v) => v === null);
		const twin = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: BOLD }) }, content: "BT /F1 12 Tf 10 10 Td <4142> Tj ET" }));
		ok("§3 two copies of one document hold", holds(compareRenders(named, twin)), JSON.stringify(compareRenders(named, twin)));
		const changedText = await pdfReport(await makePdf({ fonts: { F1: (c) => type3(c, { descriptor: BOLD }) }, content: "BT /F1 12 Tf 10 10 Td <4141> Tj ET" }));
		ok("§3 a changed glyph fails the text", compareRenders(named, changedText).text !== null);
		ok("§3 a changed glyph program fails the fonts", compareRenders(named, other).fonts !== null);
		const noFont = { pages: ["AB"], fonts: [], drawing: "1" };
		ok("§3 text read with no font read fails, never holds by both lists being empty", compareRenders(noFont, { ...noFont }).fonts !== null);
		const noText = { pages: [""], fonts: ["Type3 Made-Up-Sans-Bold #000000000000"], drawing: "1" };
		ok("§3 fonts read with no text read fails", compareRenders(noText, { ...noText }).text !== null);
		ok("§3 no page fails", compareRenders({ pages: [], fonts: [], drawing: "1" }, { pages: [], fonts: [], drawing: "1" }).pages !== null);
		const shapesOnly = await pdfReport(await makePdf({ fonts: {}, content: "0 0 m 100 100 l S" }));
		const shapesTwin = await pdfReport(await makePdf({ fonts: {}, content: "0 0 m 100 100 l S" }));
		const shapesOther = await pdfReport(await makePdf({ fonts: {}, content: "0 0 m 100 50 l S" }));
		ok("§3 neither text nor fonts: two copies hold by what the page draws", holds(compareRenders(shapesOnly, shapesTwin)), JSON.stringify(compareRenders(shapesOnly, shapesTwin)));
		ok("§3 ...and a different drawing fails", compareRenders(shapesOnly, shapesOther).drawing !== null);
	}

	console.log("§4 a document whose only fonts are Type3");
	{
		const invoice = (glyph) => makePdf({
			fonts: { F1: (c) => type3(c, { descriptor: BOLD, glyph }), F2: (c) => type3(c, { descriptor: FAMILY_ONLY }) },
			content: "BT /F1 14 Tf 10 150 Td <4142> Tj ET BT /F2 10 Tf 10 120 Td <4241> Tj ET",
		});
		const a = await pdfReport(await invoice());
		const b = await pdfReport(await invoice());
		eq("§4 both of its fonts are read", a.fonts.map((f) => f.replace(/ #[0-9a-f]{12}$/, "")), ["Type3 Made Up Sans 700 italic", "Type3 Made-Up-Sans-Bold"]);
		eq("§4 its text is read", a.pages, ["ABBA"]);
		if (compareRenders) {
			ok("§4 two copies hold", Object.values(compareRenders(a, b)).every((v) => v === null), JSON.stringify(compareRenders(a, b)));
			const c = await pdfReport(await invoice("500 0 0 0 500 700 d1 0 0 m 400 600 l S"));
			ok("§4 a copy whose glyph program differs fails the fonts", compareRenders(a, c).fonts !== null);
		}
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("test-pdf-text: crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
