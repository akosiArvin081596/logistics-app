// Made-up receipt images carrying metadata, for the receipt-image runners.
//
// Each fixture holds marker strings in every metadata block a phone or editor
// writes (EXIF with a GPS position, XMP, IPTC, a comment, trailing data), so a
// runner can tell exactly which block survived. Nothing here is real data: the
// GPS position and every string are invented.

"use strict";
const zlib = require("zlib");

const MARKERS = Object.freeze({
	exif: "EXIF-TEST-MARKER",
	xmp: "XMP-TEST-MARKER",
	iptc: "IPTC-TEST-MARKER",
	comment: "COM-TEST-MARKER",
	trailing: "TRAIL-TEST-MARKER",
	pngText: "PNG-TEXT-TEST-MARKER",
});

// A TIFF block: ImageDescription (the EXIF marker), Orientation, and a GPS IFD
// with a latitude. `le` writes it little-endian ("II"), else big-endian ("MM").
function gpsTiff({ orientation = 6, le = false } = {}) {
	const t = Buffer.alloc(124);
	const w16 = (v, at) => (le ? t.writeUInt16LE(v, at) : t.writeUInt16BE(v, at));
	const w32 = (v, at) => (le ? t.writeUInt32LE(v, at) : t.writeUInt32BE(v, at));
	t.write(le ? "II" : "MM", 0, "latin1");
	w16(42, 2);
	w32(8, 4);
	w16(3, 8);                                   // IFD0: three entries
	const entry = (n, tag, type, count, value) => {
		const at = 10 + n * 12;
		w16(tag, at); w16(type, at + 2); w32(count, at + 4);
		if (type === 3 && count === 1) w16(value, at + 8);
		else w32(value, at + 8);
	};
	const desc = `${MARKERS.exif}\0`;            // 17 bytes
	entry(0, 0x010E, 2, desc.length, 50);        // ImageDescription -> offset 50
	entry(1, 0x0112, 3, 1, orientation);         // Orientation
	entry(2, 0x8825, 4, 1, 68);                  // GPSInfo -> offset 68
	w32(0, 46);                                  // no next IFD
	t.write(desc, 50, "latin1");
	w16(2, 68);                                  // GPS IFD: two entries
	w16(0x0001, 70); w16(2, 72); w32(2, 74); t.write("N\0", 78, "latin1");   // GPSLatitudeRef
	w16(0x0002, 82); w16(5, 84); w32(3, 86); w32(100, 90);                   // GPSLatitude -> 100
	w32(0, 94);
	[[12, 1], [34, 1], [0, 1]].forEach(([n, d], k) => { w32(n, 100 + k * 8); w32(d, 104 + k * 8); });
	return t;
}

function jpegSegment(marker, payload) {
	const head = Buffer.alloc(4);
	head[0] = 0xFF; head[1] = marker;
	head.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([head, payload]);
}

// A real, decodable JPEG with every metadata block a phone or editor adds.
function jpegWithMetadata(cleanJpeg, { orientation = 6, le = false } = {}) {
	const soi = cleanJpeg.subarray(0, 2);
	const rest = cleanJpeg.subarray(2);
	return Buffer.concat([
		soi,
		jpegSegment(0xE1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), gpsTiff({ orientation, le })])),
		jpegSegment(0xE1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${MARKERS.xmp}</x:xmpmeta>`, "latin1")),
		jpegSegment(0xED, Buffer.from(`Photoshop 3.0\0${MARKERS.iptc}`, "latin1")),
		jpegSegment(0xFE, Buffer.from(MARKERS.comment, "latin1")),
		rest,
		Buffer.from(MARKERS.trailing, "latin1"),
	]);
}

// The header of a JPEG (through its frame header) with a GPS block, then bytes
// no decoder can read: its size is readable, its picture is not.
function undecodableJpegWithMetadata(cleanJpeg) {
	const withMeta = jpegWithMetadata(cleanJpeg);
	const sos = withMeta.indexOf(Buffer.from([0xFF, 0xDA]));
	return Buffer.concat([withMeta.subarray(0, sos), Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]), Buffer.alloc(64, 0x5A)]);
}

function pngChunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

// A real PNG with an eXIf (GPS) chunk, a tEXt chunk and trailing bytes.
function pngWithMetadata(cleanPng, { orientation = 6 } = {}) {
	const idat = cleanPng.indexOf(Buffer.from("IDAT", "latin1")) - 4;
	return Buffer.concat([
		cleanPng.subarray(0, idat),
		pngChunk("eXIf", gpsTiff({ orientation })),
		pngChunk("tEXt", Buffer.from(`Comment\0${MARKERS.pngText}`, "latin1")),
		cleanPng.subarray(idat),
		Buffer.from(MARKERS.trailing, "latin1"),
	]);
}

// A WebP container (VP8X + an odd-length VP8L payload + EXIF + XMP, then any
// `extraChunks` as [fourcc, text]). Not decodable: it exercises the container
// walk only.
function webpWithMetadata({ orientation = 6, extraChunks = [] } = {}) {
	const chunk = (fourcc, data) => {
		const head = Buffer.alloc(8);
		head.write(fourcc, 0, "latin1");
		head.writeUInt32LE(data.length, 4);
		return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
	};
	const vp8x = Buffer.alloc(10);
	vp8x[0] = 0x08 | 0x04;                       // EXIF + XMP flags
	const body = Buffer.concat([
		chunk("VP8X", vp8x),
		chunk("VP8L", Buffer.from("VP8L-PAYLOAD-ODD", "latin1").subarray(0, 15)),
		chunk("EXIF", gpsTiff({ orientation, le: true })),
		chunk("XMP ", Buffer.from(`<x:xmpmeta>${MARKERS.xmp}</x:xmpmeta>`, "latin1")),
		...extraChunks.map(([fourcc, text]) => chunk(fourcc, Buffer.from(text, "latin1"))),
	]);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(body.length + 4, 4);
	head.write("WEBP", 8, "latin1");
	return Buffer.concat([head, body, Buffer.from(MARKERS.trailing, "latin1")]);
}

// Which markers survive in `buf`.
function surviving(buf) {
	const text = Buffer.from(buf).toString("latin1");
	return Object.entries(MARKERS).filter(([, m]) => text.includes(m)).map(([k]) => k);
}

// True when any TIFF block in the bytes (an EXIF block, wherever it sits) has a
// GPS IFD pointer (tag 0x8825) in its first IFD. Read independently of
// lib/image-metadata.js.
function hasGpsTag(buf) {
	for (const [sig, le] of [[Buffer.from("MM\0*", "latin1"), false], [Buffer.from("II*\0", "latin1"), true]]) {
		for (let at = buf.indexOf(sig); at >= 0; at = buf.indexOf(sig, at + 1)) {
			const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
			const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
			if (at + 8 > buf.length) continue;
			const ifd = at + r32(at + 4);
			if (ifd + 2 > buf.length) continue;
			const n = Math.min(r16(ifd), 500);
			for (let k = 0; k < n && ifd + 2 + k * 12 + 2 <= buf.length; k++) {
				if (r16(ifd + 2 + k * 12) === 0x8825) return true;
			}
		}
	}
	return false;
}

// The orientation in the first TIFF block found, read independently, or 0.
function orientationOf(buf) {
	for (const [sig, le] of [[Buffer.from("MM\0*", "latin1"), false], [Buffer.from("II*\0", "latin1"), true]]) {
		const at = buf.indexOf(sig);
		if (at < 0 || at + 8 > buf.length) continue;
		const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
		const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
		const ifd = at + r32(at + 4);
		const n = ifd + 2 <= buf.length ? Math.min(r16(ifd), 500) : 0;
		for (let k = 0; k < n && ifd + 2 + k * 12 + 10 <= buf.length; k++) {
			if (r16(ifd + 2 + k * 12) === 0x0112) return r16(ifd + 2 + k * 12 + 8);
		}
	}
	return 0;
}

async function cleanImages() {
	const { Jimp } = require("jimp");
	const img = new Jimp({ width: 24, height: 12, color: 0x3366ccff });
	for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) img.setPixelColor(0xffffffff, x, y);
	return { jpeg: await img.getBuffer("image/jpeg", { quality: 90 }), png: await img.getBuffer("image/png") };
}

module.exports = {
	MARKERS, gpsTiff, jpegWithMetadata, undecodableJpegWithMetadata, pngWithMetadata, webpWithMetadata, pngChunk,
	surviving, hasGpsTag, orientationOf, cleanImages,
};
