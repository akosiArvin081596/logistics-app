"use strict";
// Image dimensions read from the file header, without decoding the image, and
// the limits every in-process image decode in server.js is held to.
//
// What an image costs to decode is set by its pixel count, not its file size,
// and only the header says what that count is. So every place that decodes an
// image, or stores one that something decodes later, calls checkImage() first:
// a type it is prepared to handle, dimensions it can read, and a pixel ceiling.
// Anything else is refused before a decoder sees it. An image whose dimensions
// cannot be read is refused too: unknown is not the same as small.
//
// servedType() answers the other question a stored file raises: what it may be
// served as. That is read from its magic bytes too, never from a stored label.
//
// Pure: no I/O and no dependencies. scripts/test-image-limits.js covers it.

const JPEG = "jpeg";
const PNG = "png";
const WEBP = "webp";

const IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE";
const UNSUPPORTED_IMAGE_TYPE = "UNSUPPORTED_IMAGE_TYPE";

// Ceiling for photos and scans. The app downscales every photo to a few
// megapixels before upload, so only an image that did not come through the app
// can reach it.
const MAX_IMAGE_PIXELS = 100_000_000;

// A drawn signature is a small canvas. Both limits sit far above anything the
// signing pad produces.
const SIGNATURE_MAX_PIXELS = 4_000_000;
const SIGNATURE_MAX_BYTES = 256 * 1024;
// The longest base64 data URI that can decode to SIGNATURE_MAX_BYTES, with room
// for its prefix. Anything longer is refused before it is decoded at all.
const SIGNATURE_DATA_URI_MAX_LENGTH = Math.ceil(SIGNATURE_MAX_BYTES / 3) * 4 + 64;
const SIGNATURE_PNG_PREFIX = "data:image/png;base64,";

// A truck photo arrives as a base64 data URI. The Trucks forms take a file of
// at most 10 MiB and re-encode it far smaller, so only a client other than the
// app can come near this. The longest data URI that can decode to
// TRUCK_PHOTO_MAX_BYTES, with room for its prefix: anything longer is refused
// before it is decoded at all.
const TRUCK_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TRUCK_PHOTO_DATA_URI_MAX_LENGTH = Math.ceil(TRUCK_PHOTO_MAX_BYTES / 3) * 4 + 64;

const freezeLimits = (types, maxPixels, maxBytes) =>
	Object.freeze(maxBytes === undefined
		? { types: Object.freeze(types), maxPixels }
		: { types: Object.freeze(types), maxPixels, maxBytes });

// One entry per kind of image the server handles. `types` is what the consumer
// can take without decoding it (or decodes safely within `maxPixels`).
const LIMITS = Object.freeze({
	// POST /api/documents/upload photos. pdfkit embeds a JPEG as it is, without
	// decoding it, so JPEG is the only type the converter accepts.
	DOCUMENT_PHOTO: freezeLimits([JPEG], MAX_IMAGE_PIXELS),
	// Driver application attachments (a PDF is checked separately). The
	// application PDF embeds them the same way as the document converter.
	APPLICANT_IMAGE: freezeLimits([JPEG], MAX_IMAGE_PIXELS),
	// Expense receipts, stored and served back as the three receipt types.
	RECEIPT_IMAGE: freezeLimits([JPEG, PNG, WEBP], MAX_IMAGE_PIXELS),
	// Signature images. pdf-lib decodes a PNG to pixels in order to embed it.
	SIGNATURE: freezeLimits([PNG], SIGNATURE_MAX_PIXELS, SIGNATURE_MAX_BYTES),
	// Truck photos, stored by the Trucks forms and served to the truck's driver
	// as what their bytes are (servedType()), so only a type that is served.
	TRUCK_PHOTO: freezeLimits([JPEG, PNG, WEBP], MAX_IMAGE_PIXELS),
});

const MESSAGES = Object.freeze({
	photo: Object.freeze({
		413: "This photo is too large to process. Retake it with the app camera.",
		415: "This photo could not be read. Retake it with the app camera.",
	}),
	signature: Object.freeze({
		413: "This signature is too large to process. Clear it and sign again.",
		415: "This signature could not be read. Clear it and sign again.",
	}),
	attachment: Object.freeze({
		413: "This photo is too large to process. Retake it with the app camera.",
		415: "This file could not be read. Attach a JPEG photo or a PDF.",
	}),
	truckPhoto: Object.freeze({
		413: "This photo is too large. Use a smaller JPEG, PNG or WebP image.",
		415: "This photo could not be read. Use a JPEG, PNG or WebP image.",
	}),
});

// The container type from its magic bytes, or null. Only the types this module
// can read dimensions for.
function imageType(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
	if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return PNG;
	if (buf[0] === 0xff && buf[1] === 0xd8) return JPEG;
	if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return WEBP;
	return null;
}

// The media type stored bytes are served under, decided by their magic bytes
// alone: "image/jpeg", "image/png" or "image/webp" (imageType()), and
// "application/pdf" only when `pdf` is set and the bytes open with "%PDF-".
// Anything else is null, i.e. not served. A media type stored beside the bytes
// is never an input. Never throws, whatever `buf` is.
const SERVED_IMAGE_TYPES = Object.freeze({ [JPEG]: "image/jpeg", [PNG]: "image/png", [WEBP]: "image/webp" });
function servedType(buf, { pdf = false } = {}) {
	const type = imageType(buf);
	if (type) return SERVED_IMAGE_TYPES[type];
	if (pdf && Buffer.isBuffer(buf) && buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
	return null;
}

// An image's pixel dimensions, read from its header without decoding it. PNG
// (IHDR) and JPEG (the first frame header) only — the two formats receipt OCR
// accepts. null when the header cannot be read. Bounded: every step of the JPEG
// walk moves forward. (Formerly receiptImageSize() in server.js.)
function imageSize(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
	if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
		if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
		const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
		return width > 0 && height > 0 ? { width, height } : null;
	}
	if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) return null;                       // not at a marker: malformed
		const marker = buf[i + 1];
		if (marker === 0xff) { i += 1; continue; }              // fill byte
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }   // no length
		if (marker === 0xd9 || marker === 0xda) return null;    // image data before any frame header
		const length = buf.readUInt16BE(i + 2);
		if (length < 2) return null;
		// SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = buf.readUInt16BE(i + 5), width = buf.readUInt16BE(i + 7);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		i += 2 + length;
	}
	return null;
}

// A WebP's canvas size. The lossy (VP8), lossless (VP8L) and extended (VP8X)
// headers each carry it at a fixed offset. null when none of them reads cleanly.
function webpSize(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 30) return null;
	if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
	const chunk = buf.toString("latin1", 12, 16);
	let width = 0, height = 0;
	if (chunk === "VP8X") {
		width = 1 + buf.readUIntLE(24, 3);
		height = 1 + buf.readUIntLE(27, 3);
	} else if (chunk === "VP8L") {
		if (buf[20] !== 0x2f) return null;
		const bits = buf.readUInt32LE(21);
		width = 1 + (bits & 0x3fff);
		height = 1 + ((bits >>> 14) & 0x3fff);
	} else if (chunk === "VP8 ") {
		if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
		width = buf.readUInt16LE(26) & 0x3fff;
		height = buf.readUInt16LE(28) & 0x3fff;
	} else {
		return null;
	}
	return width > 0 && height > 0 ? { width, height } : null;
}

function refuse(status, reason) {
	return { ok: false, status, code: status === 413 ? IMAGE_TOO_LARGE : UNSUPPORTED_IMAGE_TYPE, reason };
}

// May this image be handled under `limits` (one of LIMITS, or the same shape)?
//   { ok: true, type, width, height }
//   { ok: false, status: 413 | 415, code, reason }
// 413 = within an accepted type but too large; 415 = a type that is not
// accepted, or a header that cannot be read.
function checkImage(buf, limits) {
	if (!limits || !Array.isArray(limits.types) || !(limits.maxPixels > 0)) {
		throw new TypeError("checkImage: limits must list types and a positive maxPixels");
	}
	if (!Buffer.isBuffer(buf) || buf.length === 0) return refuse(415, "unreadable");
	if (limits.maxBytes !== undefined && buf.length > limits.maxBytes) return refuse(413, "bytes");
	const type = imageType(buf);
	if (!type || !limits.types.includes(type)) return refuse(415, "type");
	const size = type === WEBP ? webpSize(buf) : imageSize(buf);
	if (!size) return refuse(415, "dimensions");
	if (size.width * size.height > limits.maxPixels) return refuse(413, "pixels");
	return { ok: true, type, width: size.width, height: size.height };
}

// A signature image as it arrives: absent, or a base64 PNG data URI within the
// signature limits. Checked on the string before it is decoded, then on the
// decoded bytes. On success `buffer` holds the checked bytes, so a caller embeds
// exactly what was checked.
//   { ok: true, absent: true }                      no signature image
//   { ok: true, type, width, height, buffer }
//   { ok: false, status, code, reason }
function checkSignatureImage(value) {
	if (value === undefined || value === null || value === "") return { ok: true, absent: true };
	if (typeof value !== "string") return refuse(415, "type");
	if (value.length > SIGNATURE_DATA_URI_MAX_LENGTH) return refuse(413, "bytes");
	if (!value.startsWith(SIGNATURE_PNG_PREFIX)) return refuse(415, "type");
	const buffer = Buffer.from(value.slice(SIGNATURE_PNG_PREFIX.length), "base64");
	const verdict = checkImage(buffer, LIMITS.SIGNATURE);
	return verdict.ok ? { ...verdict, buffer } : verdict;
}

// The JSON body for a refusal: { error, code }. `kind` picks the wording.
function refusalBody(verdict, kind = "photo") {
	const words = MESSAGES[kind] || MESSAGES.photo;
	return { error: words[verdict.status] || words[415], code: verdict.code };
}

// The same refusal as an Error, for code that rejects rather than answers.
function refusalError(verdict, kind = "photo") {
	const body = refusalBody(verdict, kind);
	const err = new Error(body.error);
	err.status = verdict.status;
	err.code = body.code;
	err.reason = verdict.reason;
	return err;
}

module.exports = {
	JPEG,
	PNG,
	WEBP,
	IMAGE_TOO_LARGE,
	UNSUPPORTED_IMAGE_TYPE,
	MAX_IMAGE_PIXELS,
	SIGNATURE_MAX_PIXELS,
	SIGNATURE_MAX_BYTES,
	SIGNATURE_DATA_URI_MAX_LENGTH,
	TRUCK_PHOTO_MAX_BYTES,
	TRUCK_PHOTO_DATA_URI_MAX_LENGTH,
	LIMITS,
	MESSAGES,
	imageType,
	servedType,
	imageSize,
	webpSize,
	checkImage,
	checkSignatureImage,
	refusalBody,
	refusalError,
};
