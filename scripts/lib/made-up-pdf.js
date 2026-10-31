// Made-up PDFs for the runners: one page that shows a given text, written the
// way Chromium (the app's PDF renderer) writes it, or plainly.
//   mode "skia":    a Type0 font with two-byte glyph codes, a ToUnicode map, and
//                   one glyph per Tj with its own positioning, as Chromium does
//                   for spaced text; the codes are numbered in order of first
//                   use, so two texts with different characters number them
//                   differently (as two font subsets would).
//   mode "literal": "(text) Tj" through a standard font, as rate cons often are.
// The content stream is deflated unless `compress` is false.
"use strict";

const zlib = require("zlib");

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const utf16Hex = (ch) => {
	let out = "";
	for (let i = 0; i < ch.length; i++) out += hex4(ch.charCodeAt(i));
	return out;
};
const escapeLiteral = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function build(objects) {
	let pdf = "%PDF-1.7\n%âãÏÓ\n";
	const offsets = [];
	const parts = [];
	const push = (s) => {
		const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1");
		parts.push(b);
		return b.length;
	};
	let at = push(pdf);
	objects.forEach((o, i) => {
		offsets.push(at);
		at += push(`${i + 1} 0 obj\n`);
		if (o.stream) {
			at += push(`${o.dict.replace(/>>\s*$/, "")} /Length ${o.stream.length} >>\nstream\n`);
			at += push(o.stream);
			at += push("\nendstream\nendobj\n");
		} else {
			at += push(`${o.dict}\nendobj\n`);
		}
	});
	const xref = at;
	pdf = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	push(pdf);
	return Buffer.concat(parts);
}

function textPdf(text, { mode = "skia", compress = true } = {}) {
	const t = String(text == null ? "" : text);
	const stream = (s) => (compress ? zlib.deflateSync(Buffer.from(s, "latin1")) : Buffer.from(s, "latin1"));
	const filter = compress ? " /Filter /FlateDecode" : "";
	if (mode === "literal") {
		const latin = Buffer.from(t, "latin1").toString("latin1");
		return build([
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{ dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
			{ dict: `<<${filter} >>`, stream: stream(`BT\n/F1 12 Tf\n72 720 Td\n(${escapeLiteral(latin)}) Tj\nET\n`) },
		]);
	}
	const chars = [...t];
	const codes = new Map();
	for (const ch of chars) if (!codes.has(ch)) codes.set(ch, codes.size + 1);
	const content = `q\nBT\n/F7 12 Tf\n1 0 0 -1 72 720 Tm\n${chars.map((ch) => `<${hex4(codes.get(ch))}> Tj\n6.25 0 Td\n`).join("")}ET\nQ\n`;
	const entries = [...codes].map(([ch, code]) => `<${hex4(code)}> <${utf16Hex(ch)}>`);
	const blocks = [];
	for (let i = 0; i < entries.length; i += 100) {
		const chunk = entries.slice(i, i + 100);
		blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
	}
	const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
		"/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
		`${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
	return build([
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F7 4 0 R >> >> >>" },
		{ dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [5 0 R] >>" },
		{ dict: "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+MadeUpSans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>" },
		{ dict: `<<${filter} >>`, stream: stream(content) },
		{ dict: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+MadeUpSans /CIDToGIDMap /Identity /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>" },
		{ dict: `<<${filter} >>`, stream: stream(cmap) },
	]);
}

module.exports = { textPdf };
