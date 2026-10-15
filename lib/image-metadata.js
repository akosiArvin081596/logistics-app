"use strict";
// Receipt images without their metadata: no location, no camera, no time, no
// text. A phone photo can carry the GPS position it was taken at in its EXIF
// block, and a receipt is a photo of where a driver was; so a stored receipt is
// written without it and every copy served is sent without it.
//
// stripImageMetadata(buf) works on the bytes as they are, without decoding or
// re-encoding the picture, so it is cheap enough to run on every request and
// the pixels are unchanged. It keeps what a decoder needs to draw the image the
// same way (JPEG tables, colour profile, Adobe colour transform, PNG gamma and
// colour chunks, WebP's VP8/VP8L/ALPH/ANIM data) and drops everything else:
//   JPEG: APP1 (EXIF, XMP), APP2 other than ICC_PROFILE (MPF), APP3-APP13,
//         APP15, comments, and any bytes after the end-of-image marker.
//   PNG:  eXIf, tEXt, zTXt, iTXt, tIME, and any bytes after IEND.
//   WebP: EXIF and XMP chunks (their VP8X flags cleared), and bytes past the
//         RIFF size.
// One EXIF field is kept: the orientation, which phones use instead of
// rotating the pixels. Without it a sideways photo would show sideways, so when
// the original says anything but "upright" a new EXIF block holding only that
// one field takes the old one's place.
//
// Pure: no fs, no network. Always returns, never throws:
//   { ok: true, buf, type, orientation, removed }   removed: what was dropped
//   { ok: false, reason }                           not a JPEG/PNG/WebP, or bytes
//                                                   it cannot walk to the end
// A caller that gets ok:false must not serve or store the original bytes.

const zlib = require("zlib");

const MAX_IFD_ENTRIES = 1000;
const ORIENTATION_TAG = 0x0112;

function u16(buf, at, le) { return le ? buf.readUInt16LE(at) : buf.readUInt16BE(at); }
function u32(buf, at, le) { return le ? buf.readUInt32LE(at) : buf.readUInt32BE(at); }

// Orientation (1-8) from a TIFF block (the bytes after "Exif\0\0"), or 1.
function tiffOrientation(tiff) {
	try {
		if (!Buffer.isBuffer(tiff) || tiff.length < 8) return 1;
		const order = tiff.toString("latin1", 0, 2);
		if (order !== "II" && order !== "MM") return 1;
		const le = order === "II";
		if (u16(tiff, 2, le) !== 42) return 1;
		const ifd = u32(tiff, 4, le);
		if (ifd < 8 || ifd + 2 > tiff.length) return 1;
		const count = Math.min(u16(tiff, ifd, le), MAX_IFD_ENTRIES);
		for (let n = 0; n < count; n++) {
			const e = ifd + 2 + n * 12;
			if (e + 12 > tiff.length) return 1;
			if (u16(tiff, e, le) !== ORIENTATION_TAG) continue;
			if (u16(tiff, e + 2, le) !== 3 || u32(tiff, e + 4, le) !== 1) return 1;
			const v = u16(tiff, e + 8, le);
			return v >= 1 && v <= 8 ? v : 1;
		}
		return 1;
	} catch {
		return 1;
	}
}

// A TIFF block holding exactly one field: the orientation.
function orientationTiff(orientation) {
	const t = Buffer.alloc(26);
	t.write("MM", 0, "latin1");
	t.writeUInt16BE(42, 2);
	t.writeUInt32BE(8, 4);          // IFD0 right after the header
	t.writeUInt16BE(1, 8);          // one entry
	t.writeUInt16BE(ORIENTATION_TAG, 10);
	t.writeUInt16BE(3, 12);         // SHORT
	t.writeUInt32BE(1, 14);         // count 1
	t.writeUInt16BE(orientation, 18);
	t.writeUInt32BE(0, 22);         // no next IFD
	return t;
}

const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");

function jpegSegment(marker, payload) {
	const head = Buffer.alloc(4);
	head[0] = 0xFF;
	head[1] = marker;
	head.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([head, payload]);
}

function startsWith(buf, at, text) {
	return buf.length >= at + text.length && buf.toString("latin1", at, at + text.length) === text;
}

// JPEG: walk every marker to EOI, entropy-coded data included, so a segment
// placed after the first scan is judged like one placed before it.
function stripJpeg(buf) {
	const keep = [];
	const removed = [];
	let orientation = 1;
	let i = 2;
	let app0End = -1;
	let sawScan = false;
	while (i < buf.length) {
		if (buf[i] !== 0xFF) return { ok: false, reason: "jpeg_structure" };
		while (i < buf.length && buf[i] === 0xFF) i++;   // fill bytes
		if (i >= buf.length) return { ok: false, reason: "jpeg_truncated" };
		const marker = buf[i];
		const start = i - 1;
		i++;
		if (marker === 0xD9) {                           // EOI: anything after it is dropped
			keep.push(Buffer.from([0xFF, 0xD9]));
			if (i < buf.length) removed.push("trailing");
			return { ok: true, keep, removed, orientation, app0End };
		}
		if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {   // no length
			keep.push(Buffer.from([0xFF, marker]));
			continue;
		}
		if (marker === 0x00 || marker === 0xD8) return { ok: false, reason: "jpeg_structure" };
		if (i + 2 > buf.length) return { ok: false, reason: "jpeg_truncated" };
		const len = buf.readUInt16BE(i);
		if (len < 2 || i + len > buf.length) return { ok: false, reason: "jpeg_truncated" };
		const end = i + len;
		const payload = buf.subarray(i + 2, end);
		if (marker === 0xE1) {
			if (startsWith(payload, 0, "Exif\0\0")) {
				const o = tiffOrientation(payload.subarray(6));
				if (orientation === 1) orientation = o;
				removed.push("exif");
			} else {
				removed.push("app1");
			}
		} else if (marker === 0xE2 && !startsWith(payload, 0, "ICC_PROFILE\0")) {
			removed.push("app2");
		} else if ((marker >= 0xE3 && marker <= 0xED) || marker === 0xEF) {
			removed.push(`app${marker - 0xE0}`);
		} else if (marker === 0xFE) {
			removed.push("comment");
		} else {
			keep.push(Buffer.from(buf.subarray(start, end)));
			if (marker === 0xE0 && app0End < 0 && keep.length === 1) app0End = 1;
		}
		i = end;
		if (marker === 0xDA) {
			// Entropy-coded data runs to the next marker that is not a stuffed
			// zero, a restart marker or a fill byte.
			let j = i;
			while (j < buf.length) {
				if (buf[j] !== 0xFF) { j++; continue; }
				const n = buf[j + 1];
				if (n === undefined) { j = buf.length; break; }
				if (n === 0x00 || (n >= 0xD0 && n <= 0xD7)) { j += 2; continue; }
				if (n === 0xFF) { j++; continue; }
				break;
			}
			keep.push(Buffer.from(buf.subarray(i, j)));
			sawScan = true;
			i = j;
		}
	}
	// No end-of-image marker: a file cut short inside its scan data. A browser
	// draws what is there, and every metadata segment ahead of it is already
	// gone, so it is kept as it is. Without any scan at all it is not an image.
	return sawScan ? { ok: true, keep, removed, orientation, app0End } : { ok: false, reason: "jpeg_truncated" };
}

function crc32(bytes) {
	return zlib.crc32(bytes) >>> 0;
}

function pngChunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function stripPng(buf) {
	const out = [PNG_SIGNATURE];
	const removed = [];
	let orientation = 1;
	let i = 8;
	let sawIdat = false;
	while (i + 12 <= buf.length) {
		const len = buf.readUInt32BE(i);
		const type = buf.toString("latin1", i + 4, i + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || len > 0x7FFFFFFF || i + 12 + len > buf.length) return { ok: false, reason: "png_structure" };
		const end = i + 12 + len;
		if (type === "eXIf") {
			const data = buf.subarray(i + 8, i + 8 + len);
			const o = tiffOrientation(startsWith(data, 0, "Exif\0\0") ? data.subarray(6) : data);
			if (orientation === 1) orientation = o;
		}
		if (PNG_DROP.has(type)) {
			removed.push(type);
		} else {
			if (type === "IDAT" && !sawIdat) {
				sawIdat = true;
				if (orientation !== 1) out.push(pngChunk("eXIf", orientationTiff(orientation)));
			}
			out.push(Buffer.from(buf.subarray(i, end)));
		}
		i = end;
		if (type === "IEND") {
			if (i < buf.length) removed.push("trailing");
			if (!sawIdat) return { ok: false, reason: "png_structure" };
			return { ok: true, buf: Buffer.concat(out), type: "png", orientation, removed };
		}
	}
	return { ok: false, reason: "png_truncated" };
}

function stripWebp(buf) {
	if (buf.length < 12) return { ok: false, reason: "webp_truncated" };
	const riffEnd = 8 + buf.readUInt32LE(4);
	if (riffEnd > buf.length || riffEnd < 12) return { ok: false, reason: "webp_truncated" };
	const chunks = [];
	const removed = [];
	let orientation = 1;
	let i = 12;
	while (i < riffEnd) {
		if (i + 8 > riffEnd) return { ok: false, reason: "webp_structure" };
		const fourcc = buf.toString("latin1", i, i + 4);
		const size = buf.readUInt32LE(i + 4);
		const padded = size + (size & 1);
		if (i + 8 + size > riffEnd) return { ok: false, reason: "webp_structure" };
		const end = Math.min(i + 8 + padded, riffEnd);
		if (fourcc === "EXIF") {
			const data = buf.subarray(i + 8, i + 8 + size);
			const o = tiffOrientation(startsWith(data, 0, "Exif\0\0") ? data.subarray(6) : data);
			if (orientation === 1) orientation = o;
			removed.push("EXIF");
		} else if (fourcc === "XMP ") {
			removed.push("XMP");
		} else {
			chunks.push({ fourcc, bytes: Buffer.from(buf.subarray(i, end)) });
		}
		i = end;
	}
	if (riffEnd < buf.length) removed.push("trailing");
	const vp8x = chunks.find((c) => c.fourcc === "VP8X");
	if (vp8x && vp8x.bytes.length >= 9) {
		vp8x.bytes[8] &= ~(0x08 | 0x04);                 // EXIF and XMP flags
		if (orientation !== 1) vp8x.bytes[8] |= 0x08;
	}
	const body = chunks.map((c) => c.bytes);
	if (vp8x && orientation !== 1) {
		const tiff = orientationTiff(orientation);
		const head = Buffer.alloc(8);
		head.write("EXIF", 0, "latin1");
		head.writeUInt32LE(tiff.length, 4);
		body.push(head, tiff);                           // 26 bytes: even, no pad
	}
	const payload = Buffer.concat(body);
	const header = Buffer.alloc(12);
	header.write("RIFF", 0, "latin1");
	header.writeUInt32LE(payload.length + 4, 4);
	header.write("WEBP", 8, "latin1");
	return { ok: true, buf: Buffer.concat([header, payload]), type: "webp", orientation: vp8x ? orientation : 1, removed };
}

function imageKind(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
	if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpeg";
	if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
	if (startsWith(buf, 0, "RIFF") && startsWith(buf, 8, "WEBP")) return "webp";
	return null;
}

function stripImageMetadata(buf) {
	try {
		const kind = imageKind(buf);
		if (kind === "png") return stripPng(buf);
		if (kind === "webp") return stripWebp(buf);
		if (kind !== "jpeg") return { ok: false, reason: "unsupported" };
		const r = stripJpeg(buf);
		if (!r.ok) return r;
		const parts = [Buffer.from([0xFF, 0xD8])];
		const exif = r.orientation !== 1 ? jpegSegment(0xE1, Buffer.concat([EXIF_HEADER, orientationTiff(r.orientation)])) : null;
		r.keep.forEach((seg, n) => {
			if (exif && n === (r.app0End > 0 ? 1 : 0)) parts.push(exif);
			parts.push(seg);
		});
		return { ok: true, buf: Buffer.concat(parts), type: "jpeg", orientation: r.orientation, removed: r.removed };
	} catch {
		return { ok: false, reason: "unreadable" };
	}
}

module.exports = { stripImageMetadata, tiffOrientation, imageKind };
