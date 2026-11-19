// Made-up JPEG photos, and PDFs that carry them, for the Triumph batch runners (way 1's image
// re-compress). The JPEG is written here byte by byte, so a runner controls each part of the file
// a whitelist reads: baseline or progressive, 1, 3 or 4 components, the component IDs, an Adobe
// segment before or after the frame header, an EXIF orientation. Nothing here is real data: the
// pixels are drawn from a seed (paper, camera noise, dark strokes like print, a blue line like a
// signature), never from a photo.
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

// The JPEG standard's example tables (ITU T.81 Annex K), the ones most encoders start from.
const LUMA_Q = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
	18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
	...Array(32).fill(99),
];
const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const DC_BITS = [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]];
const DC_VALS = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const AC_BITS = [[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]];
const AC_VALS = [
	[0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
		0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
		0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
		0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
		0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
		0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
		0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
	[0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
		0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
		0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
		0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
		0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
		0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
		0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
];

function huffman(bits, vals) {
	const codes = new Map();
	let code = 0;
	let k = 0;
	for (let len = 1; len <= 16; len++) {
		for (let i = 0; i < bits[len - 1]; i++) codes.set(vals[k++], { code: code++, len });
		code <<= 1;
	}
	return codes;
}
const DC_CODES = [huffman(DC_BITS[0], DC_VALS[0]), huffman(DC_BITS[1], DC_VALS[1])];
const AC_CODES = [huffman(AC_BITS[0], AC_VALS[0]), huffman(AC_BITS[1], AC_VALS[1])];

// The quality scaling most encoders use (the IJG library's).
function scaled(table, quality) {
	const q = Math.min(100, Math.max(1, Math.round(quality)));
	const s = q < 50 ? 5000 / q : 200 - 2 * q;
	return table.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (__, x) => (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16)));

// One plane's 8x8 blocks, each quantized, in raster order. Edges repeat the last row and column.
function planeBlocks(plane, width, height, qtable) {
	const bw = Math.ceil(width / 8);
	const bh = Math.ceil(height / 8);
	const out = [];
	const f = new Float64Array(64);
	const t = new Float64Array(64);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			for (let y = 0; y < 8; y++) {
				const py = Math.min(height - 1, by * 8 + y);
				for (let x = 0; x < 8; x++) f[y * 8 + x] = plane[py * width + Math.min(width - 1, bx * 8 + x)] - 128;
			}
			for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
				let s = 0;
				for (let x = 0; x < 8; x++) s += COS[u][x] * f[y * 8 + x];
				t[y * 8 + u] = s;
			}
			const q = new Int16Array(64);
			for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
				let s = 0;
				for (let y = 0; y < 8; y++) s += COS[v][y] * t[y * 8 + u];
				q[v * 8 + u] = Math.round(s / qtable[v * 8 + u]);
			}
			out.push(q);
		}
	}
	return out;
}

function bitWriter() {
	const bytes = [];
	let acc = 0;
	let n = 0;
	const push = (b) => { bytes.push(b); if (b === 0xff) bytes.push(0); };
	return {
		put(code, len) {
			for (let i = len - 1; i >= 0; i--) {
				acc = (acc << 1) | ((code >> i) & 1);
				if (++n === 8) { push(acc); acc = 0; n = 0; }
			}
		},
		end() {
			while (n !== 0) this.put(1, 1);
			return Buffer.from(bytes);
		},
	};
}
const magnitude = (v) => {
	let a = Math.abs(v);
	let s = 0;
	while (a) { s++; a >>= 1; }
	return s;
};
function putValue(w, v, size) {
	if (size) w.put(v >= 0 ? v : v + (1 << size) - 1, size);
}
function putDc(w, diff, table) {
	const s = magnitude(diff);
	const c = DC_CODES[table].get(s);
	w.put(c.code, c.len);
	putValue(w, diff, s);
}
function putAc(w, block, table) {
	let run = 0;
	for (let k = 1; k < 64; k++) {
		const v = block[ZIGZAG[k]];
		if (v === 0) { run++; continue; }
		while (run > 15) { const z = AC_CODES[table].get(0xf0); w.put(z.code, z.len); run -= 16; }
		const s = magnitude(v);
		const c = AC_CODES[table].get((run << 4) | s);
		w.put(c.code, c.len);
		putValue(w, v, s);
		run = 0;
	}
	if (run > 0) { const e = AC_CODES[table].get(0x00); w.put(e.code, e.len); }
}

function segment(marker, payload) {
	const head = Buffer.alloc(4);
	head[0] = 0xff;
	head[1] = marker;
	head.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([head, payload]);
}
const adobeSegment = (transform) => segment(0xee, Buffer.concat([Buffer.from("Adobe", "latin1"), Buffer.from([0, 100, 0, 0, 0, 0, transform])]));
// An EXIF block holding one field: the orientation.
function exifSegment(orientation) {
	const t = Buffer.alloc(26);
	t.write("MM", 0, "latin1");
	t.writeUInt16BE(42, 2);
	t.writeUInt32BE(8, 4);
	t.writeUInt16BE(1, 8);
	t.writeUInt16BE(0x0112, 10);
	t.writeUInt16BE(3, 12);
	t.writeUInt32BE(1, 14);
	t.writeUInt16BE(orientation, 18);
	return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]));
}

function mulberry(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// A made-up photo of a page: off-white paper lit unevenly, camera noise, rows of dark strokes like
// print, a thin blue line like a signature. `smooth` leaves out the noise (a file that is already
// small for its size); `blank` is a page with faint noise and three ruled lines only (a large image
// in few bytes).
function photoPixels(width, height, { seed = 1, smooth = false, blank = false } = {}) {
	const rnd = mulberry(seed);
	const n = width * height;
	const r = new Uint8Array(n);
	const g = new Uint8Array(n);
	const b = new Uint8Array(n);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const dx = x / width - 0.35;
		const dy = y / height - 0.4;
		const ruled = blank && [0.3, 0.5, 0.7].some((f) => Math.abs(y - Math.round(height * f)) < 2);
		const light = ruled ? 150 : 236 - 40 * (dx * dx + dy * dy);
		const i = y * width + x;
		const noise = smooth ? 0 : (rnd() - 0.5) * (blank ? 6 : 26);
		r[i] = Math.max(0, Math.min(255, Math.round(light + noise)));
		g[i] = Math.max(0, Math.min(255, Math.round(light - 3 + noise)));
		b[i] = Math.max(0, Math.min(255, Math.round(light - 10 + noise)));
	}
	const ink = (x, y, rv, gv, bv) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const i = y * width + x;
		const noise = smooth ? 0 : (rnd() - 0.5) * 18;
		r[i] = Math.max(0, Math.min(255, Math.round(rv + noise)));
		g[i] = Math.max(0, Math.min(255, Math.round(gv + noise)));
		b[i] = Math.max(0, Math.min(255, Math.round(bv + noise)));
	};
	if (blank) return { r, g, b };
	for (let row = 40; row < height * 0.75; row += 18) {
		for (let x = 30; x < width - 40;) {
			const word = 14 + Math.floor(rnd() * 48);
			for (let wx = x; wx < Math.min(width - 40, x + word); wx++) for (let wy = row; wy < row + 7; wy++) if (rnd() > 0.25) ink(wx, wy, 40, 40, 45);
			x += word + 8 + Math.floor(rnd() * 8);
		}
	}
	for (let x = Math.floor(width * 0.55); x < width * 0.9; x++) {
		const y = Math.round(height * 0.85 + 9 * Math.sin(x / 11) + 4 * Math.sin(x / 3.7));
		ink(x, y, 60, 95, 205);
		ink(x, y + 1, 60, 95, 205);
	}
	return { r, g, b };
}

// A JPEG of made-up pixels. components: 3 (YCbCr from RGB), 1 (grey) or 4 (CMYK, never decoded
// here). `ids`: the frame's component IDs (and the scans'); `adobe`: { transform, at: "before" |
// "after" } the frame header; `orientation`: an EXIF block right after SOI; `progressive`: a DC scan
// then one AC scan per component (spectral selection only). Every component is sampled 1x1.
function jpeg({ width = 820, height = 620, quality = 95, components = 3, progressive = false, ids = null, adobe = null, orientation = null, seed = 1, smooth = false, blank = false } = {}) {
	const px = photoPixels(width, height, { seed, smooth, blank });
	let planes;
	if (components === 1) {
		planes = [Uint8Array.from(px.r, (v, i) => Math.round(0.299 * v + 0.587 * px.g[i] + 0.114 * px.b[i]))];
	} else if (components === 4) {
		planes = [Uint8Array.from(px.r, (v) => 255 - v), Uint8Array.from(px.g, (v) => 255 - v), Uint8Array.from(px.b, (v) => 255 - v), new Uint8Array(width * height)];
	} else {
		const yy = new Uint8Array(width * height);
		const cb = new Uint8Array(width * height);
		const cr = new Uint8Array(width * height);
		for (let i = 0; i < yy.length; i++) {
			const R = px.r[i]; const G = px.g[i]; const B = px.b[i];
			yy[i] = Math.max(0, Math.min(255, Math.round(0.299 * R + 0.587 * G + 0.114 * B)));
			cb[i] = Math.max(0, Math.min(255, Math.round(-0.168736 * R - 0.331264 * G + 0.5 * B + 128)));
			cr[i] = Math.max(0, Math.min(255, Math.round(0.5 * R - 0.418688 * G - 0.081312 * B + 128)));
		}
		planes = [yy, cb, cr];
	}
	const tableOf = (c) => (c === 0 ? 0 : 1);
	const qt = [scaled(LUMA_Q, quality), scaled(CHROMA_Q, quality)];
	const blocks = planes.map((p, c) => planeBlocks(p, width, height, qt[tableOf(c)]));
	const cid = ids || planes.map((_, c) => c + 1);
	const sof = Buffer.alloc(6 + 3 * planes.length);
	sof[0] = 8;
	sof.writeUInt16BE(height, 1);
	sof.writeUInt16BE(width, 3);
	sof[5] = planes.length;
	planes.forEach((_, c) => { sof[6 + c * 3] = cid[c]; sof[7 + c * 3] = 0x11; sof[8 + c * 3] = tableOf(c); });
	const dqt = Buffer.concat([0, 1].map((t) => Buffer.from([t, ...ZIGZAG.map((z) => qt[t][z])])));
	const dht = Buffer.concat([[0x00, DC_BITS[0], DC_VALS[0]], [0x10, AC_BITS[0], AC_VALS[0]], [0x01, DC_BITS[1], DC_VALS[1]], [0x11, AC_BITS[1], AC_VALS[1]]]
		.map(([tc, bits, vals]) => Buffer.from([tc, ...bits, ...vals])));
	const sos = (comps, ss, se) => segment(0xda, Buffer.from([comps.length, ...comps.flatMap((c) => [cid[c], (tableOf(c) << 4) | tableOf(c)]), ss, se, 0]));
	const all = planes.map((_, c) => c);
	const scans = [];
	if (!progressive) {
		const w = bitWriter();
		const pred = planes.map(() => 0);
		for (let k = 0; k < blocks[0].length; k++) for (const c of all) {
			putDc(w, blocks[c][k][0] - pred[c], tableOf(c));
			pred[c] = blocks[c][k][0];
			putAc(w, blocks[c][k], tableOf(c));
		}
		scans.push(sos(all, 0, 63), w.end());
	} else {
		const w = bitWriter();
		const pred = planes.map(() => 0);
		for (let k = 0; k < blocks[0].length; k++) for (const c of all) {
			putDc(w, blocks[c][k][0] - pred[c], tableOf(c));
			pred[c] = blocks[c][k][0];
		}
		scans.push(sos(all, 0, 0), w.end());
		for (const c of all) {
			const a = bitWriter();
			for (const block of blocks[c]) putAc(a, block, tableOf(c));
			scans.push(sos([c], 1, 63), a.end());
		}
	}
	const jfif = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
	const front = [];
	if (orientation) front.push(exifSegment(orientation));
	else if (!adobe && components !== 4) front.push(jfif);
	if (adobe && adobe.at !== "after") front.push(adobeSegment(adobe.transform));
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]), ...front, segment(0xdb, dqt), segment(progressive ? 0xc2 : 0xc0, sof),
		...(adobe && adobe.at === "after" ? [adobeSegment(adobe.transform)] : []),
		segment(0xc4, dht), ...scans, Buffer.from([0xff, 0xd9]),
	]);
}

// The same JPEG with a zero-length DNL segment after its scan: lib/image-metadata.js can't walk it to
// the end, and a decoder that reads DNL's four bytes as they come decodes it all the same.
function unwalkable(jpegBytes) {
	const end = jpegBytes.length - 2;
	return Buffer.concat([jpegBytes.subarray(0, end), Buffer.from([0xff, 0xdc, 0x00, 0x00, 0x00, 0x00]), jpegBytes.subarray(end)]);
}

// A PDF whose pages draw image XObjects with exactly the dictionaries given. pages: [{ text: [lines],
// images: [{ bytes, width, height, colorSpace?, filter?, dict? (more entries), share? (a key: every
// image with the same key is one object, drawn wherever it is listed) }] }]. `colorSpace` defaults
// to /DeviceRGB, or an array such as ["ICCBased", { n: 1 }] for an ICC profile stream.
async function imagePdf(pages, { save = {} } = {}) {
	const pdfLib = require(path.join(ROOT, "node_modules", "pdf-lib"));
	const { PDFDocument, PDFName, PDFRawStream, StandardFonts } = pdfLib;
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const shared = new Map();
	const colorSpace = (cs) => {
		if (!cs) return PDFName.of("DeviceRGB");
		if (typeof cs === "string") return PDFName.of(cs);
		const profile = doc.context.register(PDFRawStream.of(doc.context.obj({ N: cs[1].n }), Buffer.alloc(128, 0x20)));
		return doc.context.obj([PDFName.of(cs[0]), profile]);
	};
	for (const p of pages) {
		const page = doc.addPage([612, 792]);
		(p.text || []).forEach((line, i) => page.drawText(`${line} `, { x: 54, y: 750 - i * 16, size: 10, font }));
		let ops = "";
		(p.images || []).forEach((im, i) => {
			let ref = im.share ? shared.get(im.share) : null;
			if (!ref) {
				const filter = im.filter || "DCTDecode";
				const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: im.width, Height: im.height, BitsPerComponent: 8, Filter: filter });
				dict.set(PDFName.of("ColorSpace"), colorSpace(im.colorSpace));
				for (const [k, v] of Object.entries(im.dict || {})) dict.set(PDFName.of(k), typeof v === "function" ? v(doc) : doc.context.obj(v));
				ref = doc.context.register(PDFRawStream.of(dict, im.bytes));
				if (im.share) shared.set(im.share, ref);
			}
			const name = page.node.newXObject("Im", ref);
			ops += `q 120 0 0 90 ${40 + (i % 4) * 135} ${80 + Math.floor(i / 4) * 100} cm ${name.toString()} Do Q\n`;
		});
		if (ops) page.node.addContentStream(doc.context.register(doc.context.stream(ops)));
	}
	return Buffer.from(await doc.save({ useObjectStreams: false, ...save }));
}

// A soft mask for an image of this size: an opaque grey stream, deflated, as a PDF object of its own.
const softMask = (width, height) => (doc) => {
	const { PDFRawStream } = require(path.join(ROOT, "node_modules", "pdf-lib"));
	const bytes = require("zlib").deflateSync(Buffer.alloc(width * height, 0xff));
	return doc.context.register(PDFRawStream.of(doc.context.obj({ Type: "XObject", Subtype: "Image", Width: width, Height: height, BitsPerComponent: 8, ColorSpace: "DeviceGray", Filter: "FlateDecode" }), bytes));
};

// Every image XObject the pages of a PDF draw (directly, each once), with its stream's raw bytes and
// what its dictionary says.
async function imagesIn(pdf) {
	const { PDFDocument, PDFName, PDFRef, PDFRawStream, PDFDict, PDFNumber, PDFArray } = require(path.join(ROOT, "node_modules", "pdf-lib"));
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	const out = [];
	const seen = new Map();
	doc.getPages().forEach((page, pageIndex) => {
		const res = page.node.Resources();
		const xo = res instanceof PDFDict ? res.lookup(PDFName.of("XObject")) : null;
		if (!(xo instanceof PDFDict)) return;
		for (const [name, v] of xo.entries()) {
			if (!(v instanceof PDFRef)) continue;
			const s = doc.context.lookup(v);
			if (!(s instanceof PDFRawStream) || s.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
			const key = v.toString();
			if (seen.has(key)) { seen.get(key).pages.push(pageIndex); continue; }
			const num = (k) => { const x = s.dict.lookup(PDFName.of(k)); return x instanceof PDFNumber ? x.asNumber() : null; };
			const cs = s.dict.lookup(PDFName.of("ColorSpace"));
			const one = {
				name: name.decodeText(), ref: key, pages: [pageIndex], width: num("Width"), height: num("Height"),
				colorSpace: cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? "array" : null,
				bytes: Buffer.from(s.getContents()),
			};
			seen.set(key, one);
			out.push(one);
		}
	});
	return out;
}

// What a JPEG's frame header says: its marker, size and component count, or null.
function frameOf(bytes) {
	if (!Buffer.isBuffer(bytes) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	for (let i = 2; i + 4 <= bytes.length;) {
		if (bytes[i] !== 0xff) return null;
		const m = bytes[i + 1];
		const len = bytes.readUInt16BE(i + 2);
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			return { marker: m, height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), components: bytes[i + 9] };
		}
		if (m === 0xda) return null;
		i += 2 + len;
	}
	return null;
}

module.exports = { jpeg, unwalkable, imagePdf, softMask, imagesIn, frameOf, photoPixels };
