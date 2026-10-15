#!/usr/bin/env node
/**
 * scripts/test-image-metadata.js — lib/image-metadata.js and the copy rules of
 * lib/receipt-files.js.
 *
 * A receipt image is stored and served without its metadata: no GPS position,
 * camera, text or trailing data; the orientation is kept so a sideways phone
 * photo still shows upright; the picture's own bytes are unchanged. An image
 * the walk cannot read is refused (ok: false), never passed through.
 *
 * Fixtures are made up (scripts/lib/exif-fixtures.js): marker strings in every
 * metadata block, and an invented GPS position.
 * Run: node scripts/test-image-metadata.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const fx = require("./lib/exif-fixtures");
const { stripImageMetadata, tiffOrientation } = require("../lib/image-metadata");
const receiptFiles = require("../lib/receipt-files");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};

function scanData(jpeg) {
	const sos = jpeg.indexOf(Buffer.from([0xFF, 0xDA]));
	const eoi = jpeg.lastIndexOf(Buffer.from([0xFF, 0xD9]));
	return jpeg.subarray(sos, eoi + 2);
}

(async () => {
	const { Jimp } = require("jimp");
	const clean = await fx.cleanImages();

	// §1 JPEG
	for (const le of [false, true]) {
		const src = fx.jpegWithMetadata(clean.jpeg, { orientation: 6, le });
		const out = stripImageMetadata(src);
		const tag = le ? "little-endian" : "big-endian";
		ok(`JPEG (${tag} EXIF): the fixture carries every block`, fx.surviving(src).length === 5 && fx.hasGpsTag(src));
		ok(`JPEG (${tag}): stripped`, out.ok === true && out.type === "jpeg");
		ok(`JPEG (${tag}): no GPS, EXIF text, XMP, IPTC, comment or trailing bytes`, out.ok && !fx.hasGpsTag(out.buf) && fx.surviving(out.buf).length === 0);
		ok(`JPEG (${tag}): orientation 6 kept`, out.ok && out.orientation === 6 && fx.orientationOf(out.buf) === 6);
		ok(`JPEG (${tag}): picture bytes unchanged`, out.ok && scanData(out.buf).equals(scanData(src)));
		const img = out.ok ? await Jimp.read(out.buf) : null;
		ok(`JPEG (${tag}): still decodes, drawn upright (24x12 rotated by orientation 6)`, !!img && img.bitmap.width === 12 && img.bitmap.height === 24);
	}
	{
		const out = stripImageMetadata(fx.jpegWithMetadata(clean.jpeg, { orientation: 1 }));
		ok("JPEG with orientation 1: no EXIF block written at all", out.ok && out.buf.indexOf(Buffer.from("Exif\0\0", "latin1")) < 0);
		const plain = stripImageMetadata(clean.jpeg);
		ok("JPEG without metadata: unchanged", plain.ok && plain.buf.equals(clean.jpeg));
		const icc = Buffer.concat([clean.jpeg.subarray(0, 2), Buffer.from([0xFF, 0xE2, 0x00, 0x10]), Buffer.from("ICC_PROFILE\0\x01\x01", "latin1"), clean.jpeg.subarray(2)]);
		const iccOut = stripImageMetadata(icc);
		ok("JPEG: an ICC colour profile (APP2 ICC_PROFILE) is kept", iccOut.ok && iccOut.buf.includes(Buffer.from("ICC_PROFILE\0", "latin1")));
	}
	{
		const late = Buffer.concat([clean.jpeg.subarray(0, clean.jpeg.length - 2),
			Buffer.from([0xFF, 0xE1, 0x00, 0x14]), Buffer.from(`Exif\0\0${fx.MARKERS.exif.slice(0, 12)}`, "latin1"), Buffer.from([0xFF, 0xD9])]);
		const out = stripImageMetadata(late);
		ok("JPEG: a metadata segment placed after the scan is dropped too", out.ok && fx.surviving(out.buf).length === 0);
	}
	{
		const cut = fx.undecodableJpegWithMetadata(clean.jpeg);
		const out = stripImageMetadata(cut);
		ok("JPEG cut short inside its scan: metadata gone, the rest kept", out.ok && !fx.hasGpsTag(out.buf) && fx.surviving(out.buf).length === 0);
		const truncatedHeader = fx.jpegWithMetadata(clean.jpeg).subarray(0, 30);
		ok("JPEG cut inside its metadata: refused (ok false), never passed through", stripImageMetadata(truncatedHeader).ok === false);
		const badLen = Buffer.from(clean.jpeg);
		badLen.writeUInt16BE(0xFFFF, 4);
		ok("JPEG with a segment length past the end: refused", stripImageMetadata(badLen).ok === false);
	}

	// §2 PNG
	{
		const src = fx.pngWithMetadata(clean.png, { orientation: 6 });
		const out = stripImageMetadata(src);
		ok("PNG: the fixture carries eXIf (GPS), tEXt and trailing bytes", fx.hasGpsTag(src) && fx.surviving(src).length === 3);
		ok("PNG: stripped, no GPS, text or trailing bytes", out.ok && out.type === "png" && !fx.hasGpsTag(out.buf) && fx.surviving(out.buf).length === 0);
		ok("PNG: orientation 6 kept in a one-field eXIf", out.ok && fx.orientationOf(out.buf) === 6);
		const img = out.ok ? await Jimp.read(out.buf) : null;
		ok("PNG: still decodes (every chunk CRC valid)", !!img && img.bitmap.width * img.bitmap.height === 24 * 12);
		const plain = stripImageMetadata(clean.png);
		ok("PNG without metadata: unchanged", plain.ok && plain.buf.equals(clean.png));
		ok("PNG cut short: refused", stripImageMetadata(clean.png.subarray(0, clean.png.length - 20)).ok === false);
	}

	// §3 WebP
	{
		const src = fx.webpWithMetadata({ orientation: 6 });
		const out = stripImageMetadata(src);
		ok("WebP: the fixture carries EXIF (GPS), XMP and trailing bytes", fx.hasGpsTag(src) && fx.surviving(src).length === 3);
		ok("WebP: stripped, no GPS, XMP or trailing bytes", out.ok && out.type === "webp" && !fx.hasGpsTag(out.buf) && fx.surviving(out.buf).length === 0);
		ok("WebP: RIFF size matches the new length", out.ok && out.buf.readUInt32LE(4) + 8 === out.buf.length);
		ok("WebP: the image chunk is unchanged, padding included", out.ok && out.buf.includes(src.subarray(src.indexOf("VP8L"), src.indexOf("VP8L") + 8 + 16)));
		ok("WebP: VP8X keeps the EXIF flag only for the orientation block, XMP flag cleared",
			out.ok && (out.buf[20] & 0x04) === 0 && (out.buf[20] & 0x08) === 0x08 && fx.orientationOf(out.buf) === 6);
		const upright = stripImageMetadata(fx.webpWithMetadata({ orientation: 1 }));
		ok("WebP with orientation 1: no EXIF chunk and both flags cleared", upright.ok && !upright.buf.includes(Buffer.from("EXIF", "latin1")) && (upright.buf[20] & 0x0C) === 0);
	}

	// §4 Anything else
	ok("a GIF is refused (not a receipt format)", stripImageMetadata(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")).ok === false);
	ok("text is refused", stripImageMetadata(Buffer.from("<svg onload=x>hello world</svg>")).ok === false);
	ok("an empty buffer is refused", stripImageMetadata(Buffer.alloc(0)).ok === false);
	ok("a non-buffer is refused, never throws", stripImageMetadata("nope").ok === false && stripImageMetadata(null).ok === false);
	ok("tiffOrientation: garbage reads as 1", tiffOrientation(Buffer.from("MM\0*\xff\xff\xff\xff", "latin1")) === 1 && tiffOrientation(null) === 1);

	// §5 lib/receipt-files.js copy rules
	{
		const pdf = Buffer.from("%PDF-1.4\n% receipt\n", "latin1");
		const img = fx.jpegWithMetadata(clean.jpeg);
		const s1 = receiptFiles.servableReceipt(img);
		ok("servableReceipt: an image goes out stripped, as image/jpeg", !!s1 && s1.contentType === "image/jpeg" && !fx.hasGpsTag(s1.buf) && fx.surviving(s1.buf).length === 0);
		const s2 = receiptFiles.servableReceipt(pdf);
		ok("servableReceipt: a PDF goes out as it is, as application/pdf", !!s2 && s2.contentType === "application/pdf" && s2.buf.equals(pdf));
		ok("servableReceipt: an unreadable image is refused", receiptFiles.servableReceipt(img.subarray(0, 30)) === null);
		ok("servableReceipt: HTML is refused", receiptFiles.servableReceipt(Buffer.from("<html><script>x</script></html>")) === null);
		ok("strippedImage: bytes without metadata, or null", !fx.hasGpsTag(receiptFiles.strippedImage(img)) && receiptFiles.strippedImage(pdf) === null);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-stream-"));
		fs.writeFileSync(path.join(dir, "a.jpg"), img);
		fs.writeFileSync(path.join(dir, "b.jpg"), img.subarray(0, 30));
		const read = (p, onRefused) => new Promise((resolve, reject) => {
			const chunks = [];
			receiptFiles.receiptFileStream(p, { onRefused }).on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
		});
		const a = await read(path.join(dir, "a.jpg"));
		ok("receiptFileStream: a stored image streams stripped", a.length > 0 && !fx.hasGpsTag(a) && fx.surviving(a).length === 0);
		const refused = [];
		const b = await read(path.join(dir, "b.jpg"), (p) => refused.push(p));
		ok("receiptFileStream: an unreadable image is an empty entry, reported", b.length === 0 && refused.length === 1);
		const missing = [];
		const c = await read(path.join(dir, "none.jpg"), (p) => missing.push(p));
		ok("receiptFileStream: a missing file is an empty entry, reported", c.length === 0 && missing.length === 1);
		fs.rmSync(dir, { recursive: true, force: true });

		ok("resolveReceiptPath: refuses a separator, dots and NUL", ["", ".", "..", "a/b.jpg", "a\\b.jpg", "a\0.jpg"].every((n) => receiptFiles.resolveReceiptPath("/x/r", n) === null));
		ok("resolveReceiptPath: a flat name resolves inside the folder", receiptFiles.resolveReceiptPath("/x/r", "1-ab.jpg") === path.join("/x/r", "1-ab.jpg"));
	}

	console.log(failed ? `\n${failed} FAILED` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
