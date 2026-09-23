#!/usr/bin/env node
/**
 * Every in-process image decode in this app must be held to a type and a pixel
 * ceiling BEFORE it decodes, and must refuse an image whose dimensions it cannot
 * read. This pins that.
 *
 *   §1  the module — imageSize()/webpSize()/checkImage()/checkSignatureImage():
 *       real headers, malformed input, fuzz (never throws, null on garbage),
 *       and every limit is a real bound.
 *   §2  each server-side decode has its guard BEFORE the decode call, read from
 *       server.js with comments stripped (a comment naming the guard must not be
 *       mistaken for the guard).
 *   §3  mutants — weaken a guard and a check above flips.
 *
 * Fails on origin/main: lib/image-size.js does not exist there, and the §2
 * guards are not in server.js. No network, no DB, no server — safe anywhere.
 *
 *   node scripts/test-image-limits.js      # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const SERVER_SRC = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const LIB_PATH = path.join(REPO, "lib", "image-size.js");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// The module under test must exist — on origin/main it does not, and that is the
// first way this runner is meant to fail there.
if (!fs.existsSync(LIB_PATH)) {
	console.log("FAIL  lib/image-size.js does not exist");
	console.log("\n1 test(s) failed");
	process.exit(1);
}
const IL = require(LIB_PATH);

// --- fixtures: real headers, nothing that decodes to pixels -------------------
function pngHeader(width, height, colorType = 2) {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	b[24] = 8; b[25] = colorType;
	return b;
}
function segment(marker, payload) {
	const s = Buffer.alloc(4 + payload.length);
	s[0] = 0xff; s[1] = marker; s.writeUInt16BE(2 + payload.length, 2);
	payload.copy(s, 4);
	return s;
}
function sof(marker, width, height) {
	const p = Buffer.alloc(15);
	p[0] = 8; p.writeUInt16BE(height, 1); p.writeUInt16BE(width, 3); p[5] = 3;
	return segment(marker, p);
}
function jpeg(...parts) { return Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xd9])]); }
const APP0 = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const jpegOf = (w, h) => jpeg(APP0, sof(0xc0, w, h));
function webpVp8x(width, height) {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
	b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
	b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
	return b;
}
const pngDataUri = (buf) => `data:image/png;base64,${buf.toString("base64")}`;

// ===========================================================================
console.log("\n§1  lib/image-size.js — headers, limits, and fuzz");
// ===========================================================================
const eq = (r, w, h) => !!r && r.width === w && r.height === h;
ok("imageSize: PNG from IHDR", eq(IL.imageSize(pngHeader(800, 600)), 800, 600));
ok("imageSize: an over-limit size is reported as-is (the caller decides)", eq(IL.imageSize(pngHeader(20000, 20000)), 20000, 20000));
ok("imageSize: JPEG baseline frame", eq(IL.imageSize(jpegOf(640, 480)), 640, 480));
ok("imageSize: JPEG progressive (SOF2)", eq(IL.imageSize(jpeg(APP0, sof(0xc2, 1280, 960))), 1280, 960));
ok("imageSize: a DHT (0xC4) before the frame is not read as the frame",
	eq(IL.imageSize(jpeg(APP0, segment(0xc4, Buffer.alloc(20, 2)), sof(0xc0, 1024, 768))), 1024, 768));
ok("imageSize: zero dimension → null", IL.imageSize(pngHeader(0, 600)) === null);
ok("imageSize: WebP is not sized by the JPEG/PNG parser → null", IL.imageSize(webpVp8x(100, 100)) === null);
ok("webpSize: VP8X canvas size", eq(IL.webpSize(webpVp8x(1000, 800)), 1000, 800));
ok("imageType: names the three container types", IL.imageType(jpegOf(2, 2)) === IL.JPEG && IL.imageType(pngHeader(2, 2)) === IL.PNG && IL.imageType(webpVp8x(2, 2)) === IL.WEBP);
ok("imageType: GIF and garbage → null", IL.imageType(Buffer.from("GIF89a............", "latin1")) === null && IL.imageType(Buffer.from("nope", "latin1")) === null);

// checkImage — types, dimensions, pixel ceiling
{
	const r = IL.checkImage(jpegOf(1000, 1000), IL.LIMITS.DOCUMENT_PHOTO);
	ok("checkImage: a normal JPEG passes the document-photo limit", r.ok && r.type === IL.JPEG && r.width === 1000);
}
ok("checkImage: a PNG is 415 under a JPEG-only limit", (() => { const r = IL.checkImage(pngHeader(10, 10), IL.LIMITS.DOCUMENT_PHOTO); return !r.ok && r.status === 415 && r.code === IL.UNSUPPORTED_IMAGE_TYPE; })());
ok("checkImage: an over-100MP JPEG is 413 IMAGE_TOO_LARGE", (() => { const r = IL.checkImage(jpegOf(12000, 12000), IL.LIMITS.DOCUMENT_PHOTO); return !r.ok && r.status === 413 && r.code === IL.IMAGE_TOO_LARGE; })());
ok("checkImage: an unreadable-dimension image of an accepted type is 415, not passed",
	(() => { const truncated = jpeg(APP0).subarray(0, 18); const r = IL.checkImage(truncated, IL.LIMITS.DOCUMENT_PHOTO); return !r.ok && r.status === 415 && r.reason === "dimensions"; })());
ok("checkImage: empty buffer → 415", (() => { const r = IL.checkImage(Buffer.alloc(0), IL.LIMITS.RECEIPT_IMAGE); return !r.ok && r.status === 415; })());
ok("checkImage: receipt limit accepts JPEG, PNG and WebP", ["jpeg", "png", "webp"].every((k) => {
	const buf = k === "jpeg" ? jpegOf(50, 50) : k === "png" ? pngHeader(50, 50) : webpVp8x(50, 50);
	return IL.checkImage(buf, IL.LIMITS.RECEIPT_IMAGE).ok;
}));
ok("checkImage: an image just over its limit fails, just under passes", (() => {
	const lim = { types: [IL.JPEG], maxPixels: 1_000_000 };
	return IL.checkImage(jpegOf(1000, 1000), lim).ok && !IL.checkImage(jpegOf(1001, 1000), lim).ok;
})());

// checkSignatureImage — a small PNG data URI, bounded by pixels AND bytes
ok("checkSignatureImage: absent is allowed", IL.checkSignatureImage(undefined).ok && IL.checkSignatureImage("").absent === true);
ok("checkSignatureImage: a small PNG data URI passes", (() => { const r = IL.checkSignatureImage(pngDataUri(pngHeader(300, 120))); return r.ok && r.type === IL.PNG && Buffer.isBuffer(r.buffer); })());
ok("checkSignatureImage: a JPEG data URI is refused (signatures are PNG)", (() => { const r = IL.checkSignatureImage(`data:image/jpeg;base64,${jpegOf(10, 10).toString("base64")}`); return !r.ok && r.status === 415; })());
ok("checkSignatureImage: an oversized-pixel PNG is 413", (() => { const r = IL.checkSignatureImage(pngDataUri(pngHeader(4000, 4000))); return !r.ok && r.status === 413; })());
ok("checkSignatureImage: too many bytes is 413 without decoding", (() => { const big = "data:image/png;base64," + "A".repeat(IL.SIGNATURE_DATA_URI_MAX_LENGTH + 10); const r = IL.checkSignatureImage(big); return !r.ok && r.status === 413 && r.reason === "bytes"; })());
ok("checkSignatureImage: a non-data string is 415", IL.checkSignatureImage("http://example.com/x.png").status === 415);
ok("checkSignatureImage: a non-string is 415", IL.checkSignatureImage(123).status === 415);

// limits are real bounds
ok("MAX_IMAGE_PIXELS is 100 MP", IL.MAX_IMAGE_PIXELS === 100_000_000);
ok("SIGNATURE_MAX_PIXELS is 4 MP and SIGNATURE_MAX_BYTES is 256 KB", IL.SIGNATURE_MAX_PIXELS === 4_000_000 && IL.SIGNATURE_MAX_BYTES === 256 * 1024);
ok("every LIMITS entry lists at least one type and a positive pixel ceiling",
	Object.values(IL.LIMITS).every((l) => Array.isArray(l.types) && l.types.length > 0 && l.maxPixels > 0));
ok("refusalBody carries the code and a non-empty message; 413 vs 415 differ",
	(() => { const a = IL.refusalBody({ status: 413, code: IL.IMAGE_TOO_LARGE }); const b = IL.refusalBody({ status: 415, code: IL.UNSUPPORTED_IMAGE_TYPE }); return a.code === IL.IMAGE_TOO_LARGE && b.code === IL.UNSUPPORTED_IMAGE_TYPE && a.error && b.error && a.error !== b.error; })());

// fuzz: never throws, never returns a non-null non-{w,h}. Seeds are the valid
// headers above, each mutated at random offsets, plus wholly random buffers.
(function fuzz() {
	let threw = false, badShape = false;
	const seedBufs = [jpegOf(4, 4), pngHeader(4, 4), webpVp8x(4, 4), Buffer.from("GIF89a", "latin1")];
	let seed = 0x1234abcd;
	const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff; };
	for (let i = 0; i < 4000; i++) {
		let buf;
		const pick = Math.floor(rnd() * (seedBufs.length + 1));
		if (pick < seedBufs.length) { buf = Buffer.from(seedBufs[pick]); const n = Math.floor(rnd() * 6); for (let k = 0; k < n; k++) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256); }
		else { buf = Buffer.alloc(Math.floor(rnd() * 40)); for (let k = 0; k < buf.length; k++) buf[k] = Math.floor(rnd() * 256); }
		try {
			for (const fn of [IL.imageSize, IL.webpSize, IL.imageType]) {
				const r = fn(buf);
				if (fn !== IL.imageType && r !== null && !(r && typeof r.width === "number" && typeof r.height === "number")) badShape = true;
			}
			IL.checkImage(buf, IL.LIMITS.RECEIPT_IMAGE);
			IL.checkSignatureImage(buf.toString("latin1"));
		} catch { threw = true; break; }
	}
	ok("fuzz: 4000 malformed inputs — never throws", !threw);
	ok("fuzz: imageSize/webpSize only ever return null or {width,height}", !badShape);
})();
// A JPEG built entirely of empty segments is walked in linear time (bounded).
{
	const many = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4 * 500_000).fill(Buffer.from([0xff, 0xfe, 0x00, 0x02]))]);
	const t0 = Date.now();
	const r = IL.imageSize(many);
	ok(`bounded: 500,000 empty segments walked in linear time (${Date.now() - t0} ms)`, r === null && Date.now() - t0 < 1000);
}

// ===========================================================================
console.log("\n§2  each server-side decode has its guard BEFORE the decode");
// ===========================================================================
// Comments are stripped first: a comment that NAMES a guard must never be
// mistaken for the guard itself.
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function fnBody(name, src = SERVER_SRC) {
	let a = src.indexOf(`\nfunction ${name}(`);
	if (a < 0) a = src.indexOf(`\nasync function ${name}(`);
	if (a < 0) return "";
	// Skip the parameter list first — a destructured object param (fillW9Form)
	// carries its own braces, so the body brace is only the first `{` AFTER the
	// balanced parameter parens close.
	const paramOpen = src.indexOf("(", a);
	let parenDepth = 0, bodyStart = -1;
	for (let i = paramOpen; i < src.length; i++) {
		if (src[i] === "(") parenDepth++;
		else if (src[i] === ")") { if (--parenDepth === 0) { bodyStart = src.indexOf("{", i); break; } }
	}
	if (bodyStart < 0) return "";
	let depth = 0;
	for (let i = bodyStart; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") { if (--depth === 0) return src.slice(a, i + 1); }
	}
	return "";
}
function routeBody(signatureNeedle) {
	const at = SERVER_SRC.indexOf(signatureNeedle);
	if (at < 0) return "";
	const open = SERVER_SRC.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < SERVER_SRC.length; i++) {
		if (SERVER_SRC[i] === "{") depth++;
		else if (SERVER_SRC[i] === "}") { if (--depth === 0) return SERVER_SRC.slice(at, i + 1); }
	}
	return "";
}
// guard-before-decode: `guard` appears, and appears before every decode needle present.
function guardsBefore(src, guard, decodes) {
	const clean = stripComments(src);
	const g = clean.indexOf(guard);
	if (g < 0) return false;
	return decodes.every((d) => { const i = clean.indexOf(d); return i < 0 || i > g; });
}

ok("server.js binds lib/image-size and keeps no header parser of its own",
	/^const imageLimits = require\("\.\/lib\/image-size"\);$/m.test(SERVER_SRC) &&
	!/\nfunction receiptImageSize\(/.test(SERVER_SRC) && !/getJpegDimensions|getPngDimensions/.test(SERVER_SRC));

const imageToPdfBody = fnBody("imageToPdf");
ok("imageToPdf(): checkImage before openImage / doc.image",
	guardsBefore(imageToPdfBody, "imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO)", ["openImage(", "doc.image("]));

const uploadBody = routeBody('app.post("/api/documents/upload"');
ok("POST /api/documents/upload: checkImage before imageToPdf",
	guardsBefore(uploadBody, "imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO)", ["imageToPdf("]));

const applyBody = routeBody('app.post("/api/public/apply"');
ok("POST /api/public/apply: attachment check before the INSERT",
	guardsBefore(applyBody, "applicantAttachmentRefusal(", ["INSERT INTO job_applications"]));

const appPdfBody = routeBody('app.get("/api/applications/:id/pdf"');
ok("GET /api/applications/:id/pdf: checkImage before doc.image (else a placeholder)",
	guardsBefore(appPdfBody, "imageLimits.checkImage(buf, imageLimits.LIMITS.APPLICANT_IMAGE)", ["doc.image("]) &&
	stripComments(appPdfBody).includes("Image omitted"));

const w9Body = fnBody("fillW9Form");
ok("fillW9Form(): checkSignatureImage before embedPng",
	guardsBefore(w9Body, "imageLimits.checkSignatureImage(signatureImage)", ["embedPng("]));

const investApplyBody = routeBody('app.post("/api/public/investor-apply"');
ok("POST /api/public/investor-apply: signature checked before the transaction + render",
	guardsBefore(investApplyBody, "imageLimits.checkSignatureImage(sig.image)", ["db.transaction(", "writeSignedArtifact(", "buildInvestorDocRender("]));

const investSignBody = routeBody('app.post("/api/public/investor-onboarding/:id/sign/:docKey"');
ok("POST investor-onboarding sign: signature checked before the render",
	guardsBefore(investSignBody, "imageLimits.checkSignatureImage(signatureImage)", ["writeSignedArtifact(", "buildInvestorDocRender("]));

const previewBody = routeBody('app.post("/api/public/investor-preview-pdf/:docKey"');
ok("POST investor-preview-pdf: signature checked before either renderer",
	guardsBefore(previewBody, "imageLimits.checkSignatureImage(signatureImage)", ["renderPolicy(", "fillW9Form("]));

const driverSignBody = routeBody('app.post("/api/onboarding/:userId/documents/:docKey/sign"');
ok("POST onboarding sign (driver): signature checked before the render",
	guardsBefore(driverSignBody, "imageLimits.checkSignatureImage(signatureImage)", ["writeSignedArtifact("]));

const saveReceiptBody = fnBody("saveReceiptToDisk");
ok("saveReceiptToDisk(): checkImage before writeFileSync",
	guardsBefore(saveReceiptBody, "imageLimits.checkImage(buf, imageLimits.LIMITS.RECEIPT_IMAGE)", ["fs.writeFileSync("]));

const thumbBody = routeBody('app.get("/api/expenses/:id/receipt-thumbnail"');
ok("GET receipt-thumbnail: checkImage before Jimp.read",
	guardsBefore(thumbBody, "imageLimits.checkImage(source, {", ["Jimp.read("]));

const skipBody = fnBody("receiptOcrSkipReason");
ok("receiptOcrSkipReason(): reads dimensions via imageLimits.imageSize()",
	stripComments(skipBody).includes("imageLimits.imageSize("));

ok("policy-renderer safeSignatureImage caps bytes before the regex",
	guardsBefore(fs.readFileSync(path.join(REPO, "lib", "policy-renderer.js"), "utf8"),
		"if (value.length > SIGNATURE_DATA_URI_MAX_LENGTH) return null;", ["SIGNATURE_DATA_URI_RE.test("]));

// ===========================================================================
console.log("\n§3  mutants — weaken a guard and a check above flips");
// ===========================================================================
// M1: strip the type/size guard out of the lifted imageToPdf body — the §2
// guard-before-decode check must then fail, i.e. that one line is load-bearing.
{
	const mutant = imageToPdfBody.replace(
		/\s*const verdict = imageLimits\.checkImage\(buf, imageLimits\.LIMITS\.DOCUMENT_PHOTO\);\n\s*if \(!verdict\.ok\) return reject\(imageLimits\.refusalError\(verdict, "photo"\)\);/,
		"");
	ok("M1 (imageToPdf guard removed) caught: the §2 check flips to false",
		mutant !== imageToPdfBody &&
		guardsBefore(imageToPdfBody, "imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO)", ["openImage(", "doc.image("]) &&
		!guardsBefore(mutant, "imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO)", ["openImage(", "doc.image("]));
}
// M2: checkImage without the pixel ceiling would pass a 100+MP image.
{
	const noCeiling = (buf, limits) => {
		if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, status: 415 };
		const type = IL.imageType(buf);
		if (!type || !limits.types.includes(type)) return { ok: false, status: 415 };
		const size = type === IL.WEBP ? IL.webpSize(buf) : IL.imageSize(buf);
		if (!size) return { ok: false, status: 415 };
		return { ok: true, type, width: size.width, height: size.height };  // no maxPixels test
	};
	const real = IL.checkImage(jpegOf(12000, 12000), IL.LIMITS.DOCUMENT_PHOTO);
	const mut = noCeiling(jpegOf(12000, 12000), IL.LIMITS.DOCUMENT_PHOTO);
	ok("M2 (no pixel ceiling) caught: real refuses 413, mutant would pass", !real.ok && real.status === 413 && mut.ok);
}
// M3: checkImage that returns ok on unreadable dimensions would feed a decoder junk.
{
	const passUnknown = (buf, limits) => {
		const type = IL.imageType(buf);
		if (!type || !limits.types.includes(type)) return { ok: false, status: 415 };
		const size = type === IL.WEBP ? IL.webpSize(buf) : IL.imageSize(buf);
		if (!size) return { ok: true, type };  // BUG: unknown treated as fine
		return { ok: true, type, width: size.width, height: size.height };
	};
	const truncated = jpeg(APP0).subarray(0, 18);
	ok("M3 (unknown dims pass) caught: real refuses 415, mutant would pass",
		!IL.checkImage(truncated, IL.LIMITS.DOCUMENT_PHOTO).ok && passUnknown(truncated, IL.LIMITS.DOCUMENT_PHOTO).ok);
}
// M4: signature check without the byte cap would let a huge string through to decode.
{
	const big = "data:image/png;base64," + "A".repeat(IL.SIGNATURE_DATA_URI_MAX_LENGTH + 10);
	const real = IL.checkSignatureImage(big);
	ok("M4 (no signature byte cap) caught: real refuses 413 on bytes", !real.ok && real.status === 413 && real.reason === "bytes");
}
// M5: a signature check that accepted any image type would take a JPEG where a PNG is embedded.
{
	const jpegSig = `data:image/jpeg;base64,${jpegOf(10, 10).toString("base64")}`;
	ok("M5 (accept any type) caught: real refuses a JPEG signature 415", IL.checkSignatureImage(jpegSig).status === 415);
}

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
