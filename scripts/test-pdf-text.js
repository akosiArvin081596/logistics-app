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
//   §5 fonts are compared by what they draw: a glyph whose lengths move by
//      less than 0.001 em holds (the noise Chromium writes for a variable web
//      font's in-between weights); a weight swap, a system-font fallback, a
//      glyph moved past the tolerance, a changed operator or FontMatrix, a
//      different glyph set, a changed font file and a font with nothing to
//      compare each fail
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
// procedure for "A", `extra` (when given) as a third glyph "C", the
// FontMatrix given, and the descriptor given (or none).
function type3(ctx, { descriptor = null, glyph = "500 0 0 0 500 700 d1 0 0 m 500 700 l S", extra = null, matrix = [0.001, 0, 0, 0.001, 0, 0] } = {}) {
	const procs = {
		gA: ctx.register(ctx.flateStream(glyph)),
		gB: ctx.register(ctx.flateStream("500 0 0 0 500 700 d1 0 0 m 0 700 l S")),
		...(extra ? { gC: ctx.register(ctx.flateStream(extra)) } : {}),
	};
	const glyphs = Object.keys(procs);
	return ctx.register(ctx.obj({
		Type: "Font", Subtype: "Type3",
		FontBBox: [0, 0, 1000, 1000], FontMatrix: matrix,
		CharProcs: procs,
		Encoding: { Type: "Encoding", Differences: [65, ...glyphs] },
		FirstChar: 65, LastChar: 64 + glyphs.length, Widths: glyphs.map(() => 500),
		...(descriptor ? { FontDescriptor: ctx.register(ctx.obj(descriptor)) } : {}),
		ToUnicode: ctx.register(ctx.flateStream(CMAP([["41", "0041"], ["42", "0042"], ["43", "0043"]].slice(0, glyphs.length)))),
	}));
}
// A font with no font file and no glyph procedures: nothing to compare.
const bareFont = (ctx) => ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "MadeUpStandardSans" }));
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

	console.log("§5 fonts compared by what they draw");
	if (!compareRenders) {
		ok("§5 not run: compareRenders() is missing", false);
	} else {
		const holds = (r) => Object.values(r).every((v) => v === null);
		const render = (make) => makePdf({ fonts: { F1: make }, content: "BT /F1 12 Tf 10 10 Td <4142> Tj ET" }).then(pdfReport);
		const bold = (opts = {}) => render((c) => type3(c, { descriptor: BOLD, ...opts }));
		const base = await bold();
		const fontsVs = async (opts) => compareRenders(base, await bold(opts)).fonts;
		// The default glyph "A" ends at (500, 700); its FontMatrix is 1/1000 em.
		const moved = (x) => ({ glyph: `500 0 0 0 500 700 d1 0 0 m ${x} 700 l S` });

		const noise = compareRenders(base, await bold(moved("500.3")));
		ok("§5 one length moved by 0.3 units (0.0003 em) holds: the noise Chromium writes for an in-between weight of a variable web font", holds(noise), JSON.stringify(noise));
		const near = compareRenders(base, await bold(moved("500.9")));
		ok("§5 ...and 0.9 units (0.0009 em) holds", holds(near), JSON.stringify(near));
		const past = await fontsVs(moved("501.1"));
		ok("§5 1.1 units (0.0011 em) fails, naming the glyph and the difference", /^Type3 Made-Up-Sans-Bold\|gA differs by 0\.0011 em/.test(past || ""), String(past));

		// Control points on thirds against 1/192 steps, up to 0.27 units apart,
		// under a 1/2048 FontMatrix: the shape of Chromium's noise.
		const em2048 = [1 / 2048, 0, 0, -1 / 2048, 0, 0];
		const thirds = "1100 0 80 -1500 520 0 d1 300 -1400 m 341.66667 -1400 375.33333 -1390.5 428.66667 -1371.66667 c 442 -1352 442 -1320 442 -1274 c h f";
		const steps = "1100 0 80 -1500 520 0 d1 300 -1400 m 341.92708 -1400 375.59896 -1390.5 428.93229 -1371.40104 c 442 -1352 442 -1320 442 -1274 c h f";
		const onThirds = await bold({ matrix: em2048, glyph: thirds });
		const onSteps = await bold({ matrix: em2048, glyph: steps });
		ok("§5 a glyph modelled on the noise holds (thirds against 1/192 steps, 1/2048 FontMatrix), though its per-object digests differ",
			holds(compareRenders(onThirds, onSteps)) && onThirds.fonts[0] !== onSteps.fonts[0], `${JSON.stringify(compareRenders(onThirds, onSteps))} ${onThirds.fonts[0]} / ${onSteps.fonts[0]}`);

		const swap = await fontsVs({ glyph: "528 0 0 0 528 700 d1 0 0 m 528 700 l S" });
		ok("§5 a weight swap under the same name fails (a heavier glyph, 0.028 em off)", /differs by 0\.028 em/.test(swap || ""), String(swap));
		const heavier = await fontsVs({ descriptor: { ...BOLD, FontName: "ABCDEF+Made-Up-Sans-ExtraBold" } });
		ok("§5 ...and a heavier weight's name in place of the named one fails on the names", /^font names differ: Type3 Made-Up-Sans-Bold against Type3 Made-Up-Sans-ExtraBold$/.test(heavier || ""), String(heavier));
		const system = await fontsVs({ descriptor: { ...BOLD, FontName: "ABCDEF+.Made-Up-System-UI-Bold" } });
		ok("§5 a system-font fallback fails on the names, even with the same glyphs", /^font names differ: Type3 Made-Up-Sans-Bold against Type3 \.Made-Up-System-UI-Bold$/.test(system || ""), String(system));
		const staticCopy = compareRenders(base, await render((c) => trueType(c, { base: "GHIJKL+Made-Up-Sans-Bold", file: "made-up static font file" }))).fonts;
		ok("§5 ...and so does a static copy of the font embedded as TrueType under the same name", /^font names differ: Type3 Made-Up-Sans-Bold against TrueType Made-Up-Sans-Bold$/.test(staticCopy || ""), String(staticCopy));

		const extraOp = await fontsVs({ glyph: "500 0 0 0 500 700 d1 0 0 m 500 700 l h S" });
		ok("§5 an extra operator fails, with every number the same", /gA differs in its drawing operators$/.test(extraOp || ""), String(extraOp));
		const trailingOp = await fontsVs({ glyph: "500 0 0 0 500 700 d1 0 0 m 500 700 l S h" });
		ok("§5 ...and so does one added at the end", /gA differs in its drawing operators$/.test(trailingOp || ""), String(trailingOp));
		const otherOp = await fontsVs({ glyph: "500 0 0 0 500 700 d1 0 0 m 500 700 l f" });
		ok("§5 ...and a fill in place of a stroke", /gA differs in its drawing operators$/.test(otherOp || ""), String(otherOp));
		const marked = (id) => bold({ glyph: `500 0 0 0 500 700 d1 /P <</MCID ${id}>> BDC 0 0 m 500 700 l S EMC` });
		const dict = compareRenders(await marked(0), await marked(1)).fonts;
		ok("§5 a dictionary in a glyph program is compared as written", /gA differs in an operand of BDC$/.test(dict || ""), String(dict));
		const withCm = (e) => bold({ glyph: `500 0 0 0 500 700 d1 q 1 0 0 1 ${e} 0 cm 0 0 m 500 700 l S Q` });
		const cm = compareRenders(await withCm("0"), await withCm("0.3")).fonts;
		ok("§5 an operand that isn't a path length or metric must match exactly", /gA differs in an operand of cm$/.test(cm || ""), String(cm));
		const withImage = (data) => bold({ glyph: `500 0 d0 q 500 0 0 700 0 0 cm BI /W 3 /H 1 /BPC 8 /CS /G ID ${data} EI Q` });
		const image = compareRenders(await withImage("a b"), await withImage("a\tb")).fonts;
		ok("§5 a glyph's inline image is compared byte for byte", /gA draws an inline image that differs$/.test(image || ""), String(image));
		const matrix = await fontsVs({ matrix: [0.002, 0, 0, 0.002, 0, 0] });
		ok("§5 a different FontMatrix fails, with the same glyph programs", /gA differs in its FontMatrix$/.test(matrix || ""), String(matrix));
		const extraGlyph = await fontsVs({ extra: "500 0 0 0 500 700 d1 0 0 m 250 700 l S" });
		ok("§5 a glyph drawn in only one of them fails", /^Type3 Made-Up-Sans-Bold\|gC is drawn only in the second render$/.test(extraGlyph || ""), String(extraGlyph));
		// Two objects of one name; the second draws "A" with `glyph`.
		const twoObjects = (glyph) => makePdf({
			fonts: { F1: (c) => type3(c, { descriptor: BOLD }), F2: (c) => type3(c, { descriptor: BOLD, glyph }) },
			content: "BT /F1 12 Tf 10 10 Td <4142> Tj ET BT /F2 12 Tf 10 30 Td <4142> Tj ET",
		}).then(pdfReport);
		const sameTwice = await twoObjects(undefined);
		const oneHeavier = await twoObjects("528 0 0 0 528 700 d1 0 0 m 528 700 l S");
		ok("§5 a second object of the same name drawing a glyph differently fails, whichever side it is on",
			/gA differs by 0\.028 em/.test(compareRenders(sameTwice, oneHeavier).fonts || "") && /gA differs by 0\.028 em/.test(compareRenders(oneHeavier, sameTwice).fonts || ""),
			`${compareRenders(sameTwice, oneHeavier).fonts} / ${compareRenders(oneHeavier, sameTwice).fonts}`);

		const ttTwin = await pdfReport(await makePdf({ fonts: { F1: (c) => trueType(c, { base: "GHIJKL+MadeUpSerif", file: "made-up font file 1" }) }, content: "BT /F1 12 Tf <41> Tj ET" }));
		ok("§5 two copies of an embedded TrueType font hold", holds(compareRenders(tt, ttTwin)), JSON.stringify(compareRenders(tt, ttTwin)));
		ok("§5 ...and a TrueType font whose file differs fails, compared byte for byte", /^TrueType MadeUpSerif: its embedded font file differs$/.test(compareRenders(tt, ttOther).fonts || ""), String(compareRenders(tt, ttOther).fonts));
		const bareA = await render(bareFont);
		const bareB = await render(bareFont);
		const bare = compareRenders(bareA, bareB).fonts;
		ok("§5 a font with neither glyph procedures nor a font file fails, even against an identical copy", /no glyph program or embedded font file/.test(bare || ""), String(bare));
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("test-pdf-text: crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
