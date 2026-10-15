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

	// §6 Only what draws the image survives (an allowlist, not a list of known
	// metadata): unknown and provenance blocks go too.
	{
		const seg = (marker, text) => {
			const payload = Buffer.from(text, "latin1");
			const head = Buffer.from([0xFF, marker, 0, 0]);
			head.writeUInt16BE(payload.length + 2, 2);
			return Buffer.concat([head, payload]);
		};
		const j = clean.jpeg;
		const jpeg = Buffer.concat([j.subarray(0, 2),
			seg(0xEE, "Adobe\0\x64\0\0\0\0\x01"),                 // APP14 Adobe: kept
			seg(0xEE, "NOTADOBE-JPEG-APP14-MARKER"),                // APP14 that is not Adobe
			seg(0xE0, "XTRA\0JPEG-APP0-MARKER"),                    // APP0 that is not JFIF
			seg(0xF1, "JPEG-F1-MARKER"),                            // JPG1 extension segment
			seg(0xFD, "JPEG-FD-MARKER"),                            // JPG13 extension segment
			j.subarray(2)]);
		const jo = stripImageMetadata(jpeg);
		ok("JPEG allowlist: a non-JFIF APP0, a non-Adobe APP14 and 0xF0-0xFD segments are dropped",
			jo.ok && !/JPEG-(APP0|APP14|F1|FD)-MARKER/.test(jo.buf.toString("latin1")));
		ok("JPEG allowlist: the Adobe APP14 colour block is kept", jo.ok && jo.buf.includes(Buffer.from("Adobe\0", "latin1")));
		const jimg = jo.ok ? await Jimp.read(jo.buf).catch(() => null) : null;
		ok("JPEG allowlist: still decodes", !!jimg && jimg.bitmap.width === 24);

		const chunk = (type, text) => fx.pngChunk(type, Buffer.from(text, "latin1"));
		const idat = clean.png.indexOf(Buffer.from("IDAT", "latin1")) - 4;
		const png = Buffer.concat([clean.png.subarray(0, idat),
			chunk("caBX", "PNG-CABX-MARKER"), chunk("zxIf", "PNG-ZXIF-MARKER"), chunk("exIf", "PNG-EXIF-LOWER-MARKER"),
			fx.pngChunk("gAMA", Buffer.from([0, 0, 0xB1, 0x8F])), fx.pngChunk("pHYs", Buffer.from([0, 0, 0x0B, 0x13, 0, 0, 0x0B, 0x13, 1])),
			clean.png.subarray(idat)]);
		const po = stripImageMetadata(png);
		ok("PNG allowlist: caBX (provenance), zxIf, exIf and other unknown chunks are dropped",
			po.ok && !/PNG-(CABX|ZXIF|EXIF-LOWER)-MARKER/.test(po.buf.toString("latin1")));
		ok("PNG allowlist: gAMA and pHYs (needed to draw it) are kept", po.ok && po.buf.includes(Buffer.from("gAMA", "latin1")) && po.buf.includes(Buffer.from("pHYs", "latin1")));
		const pimg = po.ok ? await Jimp.read(po.buf).catch(() => null) : null;
		ok("PNG allowlist: still decodes", !!pimg && pimg.bitmap.width === 24);

		const webp = fx.webpWithMetadata({ orientation: 1, extraChunks: [["C2PA", "WEBP-C2PA-MARKER"], ["ICCP", "WEBP-ICCP-KEPT"]] });
		const wo = stripImageMetadata(webp);
		ok("WebP allowlist: an unknown (C2PA) chunk is dropped", wo.ok && !wo.buf.includes(Buffer.from("WEBP-C2PA-MARKER", "latin1")));
		ok("WebP allowlist: the ICC profile chunk is kept, RIFF size consistent", wo.ok && wo.buf.includes(Buffer.from("WEBP-ICCP-KEPT", "latin1")) && wo.buf.readUInt32LE(4) + 8 === wo.buf.length);
	}

	// §7 The receipt file guard's limits: a few reads at a time server-wide (the
	// rest wait in a bounded queue, then 503), a per-user cap (429), PDFs streamed
	// from disk, a size cap, and no cache may keep a copy.
	{
		const express = require("express");
		const http = require("http");
		const Database = require("better-sqlite3");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-guard-limits-"));
		const img = fx.jpegWithMetadata(clean.jpeg);
		const pdf = Buffer.from("%PDF-1.4\n% made-up receipt for the limits runner\n%%EOF\n", "latin1");
		fs.writeFileSync(path.join(dir, "1-aa.jpg"), img);
		fs.writeFileSync(path.join(dir, "2-bb.pdf"), pdf);
		const db = new Database(":memory:");
		db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT, photo_data TEXT)");
		db.prepare("INSERT INTO expenses (id, driver, photo_data) VALUES (1, 'Tamsin Vale', '/uploads/expense-receipts/1-aa.jpg'), (2, 'Tamsin Vale', '/uploads/expense-receipts/2-bb.pdf')").run();
		const SA = { id: 1, role: "Super Admin" };
		const DRV = { id: 10, role: "Driver", driverName: "Tamsin Vale" };
		const DISP = { id: 2, role: "Dispatcher" };
		const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
		const servers = [];
		async function serve(opts) {
			const guard = receiptFiles.createExpenseReceiptGuard({ db, receiptsDir: dir, normalizeDriverName: norm, ...opts });
			const app = express();
			app.use((req, res, next) => { req.session = { user: JSON.parse(req.headers["x-test-user"]) }; next(); });
			app.use("/r/:file", (req, res, next) => guard(req, res, next, `/uploads/expense-receipts/${req.params.file}`, req.params.file));
			const server = http.createServer(app);
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			servers.push(server);
			const port = server.address().port;
			return (file, user, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port, method, path: `/r/${file}`, agent: false, headers: { "x-test-user": JSON.stringify(user), ...headers } }, (res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
				});
				req.on("error", reject);
				req.end();
			});
		}
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const counter = { now: 0, max: 0, calls: 0 };
		const slowRead = async (p) => {
			counter.calls++; counter.now++; counter.max = Math.max(counter.max, counter.now);
			try { await sleep(60); return await fs.promises.readFile(p); } finally { counter.now--; }
		};

		const get1 = await serve({ maxConcurrentReads: 2, maxQueuedReads: 2, readFile: slowRead });
		const burst = await Promise.all(Array.from({ length: 6 }, () => get1("1-aa.jpg", SA)));
		const statuses = burst.map((r) => r.status).sort().join(",");
		ok(`§7 six reads at once with a cap of 2 running and 2 waiting: never more than 2 read at once (saw ${counter.max})`, counter.max === 2);
		ok(`§7 ... four are served and two answer 503 (got ${statuses})`, statuses === "200,200,200,200,503,503");
		const busy = burst.find((r) => r.status === 503);
		ok("§7 ... the 503 says when to retry and is not cached", !!busy && Number(busy.headers["retry-after"]) > 0 && /RECEIPT_SERVER_BUSY/.test(busy.body.toString("utf8")));

		const get2 = await serve({ maxConcurrentReads: 1, maxQueuedReads: 5, queueWaitMs: 30, readFile: async (p) => { await sleep(250); return fs.promises.readFile(p); } });
		const waited = await Promise.all([get2("1-aa.jpg", SA), get2("1-aa.jpg", SA)]);
		ok("§7 a read that waits longer than the queue allows answers 503 instead of waiting on", waited.map((r) => r.status).sort().join(",") === "200,503");

		const get3 = await serve({ perUserWindowMs: 60_000, perUserMax: 3 });
		const seq = [];
		for (let k = 0; k < 4; k++) seq.push(await get3("1-aa.jpg", DRV));
		ok("§7 per user: the reads past the cap answer 429 with Retry-After", seq.slice(0, 3).every((r) => r.status === 200) && seq[3].status === 429 && Number(seq[3].headers["retry-after"]) > 0);
		ok("§7 per user: another user is not held back", (await get3("1-aa.jpg", DISP)).status === 200);

		counter.calls = 0;
		const get4 = await serve({ readFile: slowRead });
		const ranged = await get4("2-bb.pdf", DRV, { headers: { range: "bytes=0-3" } });
		ok("§7 a PDF receipt streams from disk (a range request answers 206 with those bytes)", ranged.status === 206 && ranged.body.toString("latin1") === "%PDF");
		const whole = await get4("2-bb.pdf", DRV);
		ok("§7 ... and is never read whole into memory", whole.status === 200 && whole.body.equals(pdf) && counter.calls === 0 && /application\/pdf/.test(whole.headers["content-type"]));
		ok("§7 ... and is not cached either", /no-store/.test(String(whole.headers["cache-control"])));
		const image = await get4("1-aa.jpg", DRV);
		ok("§7 an image is sent private, no-store, with no ETag", image.status === 200 && image.headers["cache-control"] === "private, no-store" && !image.headers.etag);
		const head = await get4("1-aa.jpg", DRV, { method: "HEAD" });
		ok("§7 HEAD: the length, no body", head.status === 200 && head.body.length === 0 && Number(head.headers["content-length"]) === image.body.length);
		ok(`§7 the serve cap is no larger than the largest receipt upload (20 MB; is ${receiptFiles.RECEIPT_SERVE_MAX_BYTES})`, receiptFiles.RECEIPT_SERVE_MAX_BYTES <= 20 * 1024 * 1024);

		// One user's waiting requests are capped, so a busy user cannot fill the
		// shared queue for everyone.
		const get5 = await serve({ maxConcurrentReads: 1, maxQueuedReads: 100, maxQueuedPerUser: 2, readFile: async (p) => { await sleep(120); return fs.promises.readFile(p); } });
		const mine = Array.from({ length: 5 }, () => get5("1-aa.jpg", DRV));
		await sleep(20);
		const theirs = get5("1-aa.jpg", DISP);
		const mineDone = await Promise.all(mine);
		const mineStatuses = mineDone.map((r) => r.status).sort().join(",");
		ok(`§7 per user: one user's requests past 1 running + 2 waiting answer 503 (got ${mineStatuses})`, mineStatuses === "200,200,200,503,503");
		ok("§7 ... with Retry-After", mineDone.filter((r) => r.status === 503).every((r) => Number(r.headers["retry-after"]) > 0));
		ok("§7 ... while another user's request still waits its turn and is served", (await theirs).status === 200);

		// The shipped caps fit an investor's receipt list: over HTTP/2 the browser
		// asks for every photo at once (one user, ~250 at a time), and none of them
		// may be refused.
		ok(`§7 shipped caps: 300 waiting per user, 1000 server-wide (are ${receiptFiles.RECEIPT_SERVE_LIMITS.maxQueuedPerUser} and ${receiptFiles.RECEIPT_SERVE_LIMITS.maxQueuedReads})`,
			receiptFiles.RECEIPT_SERVE_LIMITS.maxQueuedPerUser === 300 && receiptFiles.RECEIPT_SERVE_LIMITS.maxQueuedReads === 1000);
		const getPage = await serve({ readFile: async (p) => { await sleep(5); return fs.promises.readFile(p); } });
		const page = await Promise.all(Array.from({ length: 250 }, () => getPage("1-aa.jpg", SA)));
		const pageTally = page.reduce((t, r) => ((t[r.status] = (t[r.status] || 0) + 1), t), {});
		ok(`§7 shipped caps: one user's burst of 250 photos is served in full, no 503 (got ${JSON.stringify(pageTally)})`, pageTally[200] === 250);

		// Past the per-user cap the shipped guard still refuses: reads are held
		// until every request has arrived, so 4 run, 300 wait and the rest answer
		// 503 with Retry-After.
		let open;
		const gate = new Promise((r) => { open = r; });
		const getCap = await serve({ readFile: async (p) => { await gate; return fs.promises.readFile(p); } });
		const capped = Array.from({ length: 309 }, () => getCap("1-aa.jpg", DISP));
		const early = [];
		capped.forEach((p) => p.then((r) => early.push(r)));
		for (let waited = 0; early.length < 5 && waited < 5000; waited += 25) await sleep(25);
		open();
		const cappedDone = await Promise.all(capped);
		const refusedNow = cappedDone.filter((r) => r.status === 503);
		ok(`§7 shipped caps: past 4 running + 300 waiting, one user's extra requests answer 503 (got ${refusedNow.length} of 309)`, refusedNow.length === 5 && cappedDone.filter((r) => r.status === 200).length === 304);
		ok("§7 ... each with Retry-After", refusedNow.length > 0 && refusedNow.every((r) => Number(r.headers["retry-after"]) > 0));

		// A client that stops reading cannot hold a read slot: the response is
		// ended after sendTimeoutMs and the slot goes to the next request.
		const big = Buffer.concat([clean.jpeg.subarray(0, clean.jpeg.indexOf(Buffer.from([0xFF, 0xDA])) + 2 + clean.jpeg.readUInt16BE(clean.jpeg.indexOf(Buffer.from([0xFF, 0xDA])) + 2)),
			Buffer.alloc(16 * 1024 * 1024, 0x11), Buffer.from([0xFF, 0xD9])]);
		fs.writeFileSync(path.join(dir, "3-cc.jpg"), big);
		db.prepare("INSERT INTO expenses (id, driver, photo_data) VALUES (3, 'Tamsin Vale', '/uploads/expense-receipts/3-cc.jpg')").run();
		const guard6 = receiptFiles.createExpenseReceiptGuard({ db, receiptsDir: dir, normalizeDriverName: norm, maxConcurrentReads: 1, queueWaitMs: 3000, sendTimeoutMs: 300 });
		const app6 = express();
		app6.use((req, res, next) => { req.session = { user: JSON.parse(req.headers["x-test-user"]) }; next(); });
		app6.use("/r/:file", (req, res, next) => guard6(req, res, next, `/uploads/expense-receipts/${req.params.file}`, req.params.file));
		const server6 = http.createServer(app6);
		await new Promise((r) => server6.listen(0, "127.0.0.1", r));
		servers.push(server6);
		const port6 = server6.address().port;
		const stalled = http.request({ host: "127.0.0.1", port: port6, path: "/r/3-cc.jpg", agent: false, headers: { "x-test-user": JSON.stringify(SA) } });
		stalled.on("response", (res) => { res.pause(); res.on("error", () => {}); res.on("aborted", () => {}); });
		stalled.on("error", () => {});
		stalled.end();
		await sleep(150);
		const started = Date.now();
		const next = await new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: port6, path: "/r/1-aa.jpg", agent: false, headers: { "x-test-user": JSON.stringify(DISP) } }, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - started }));
			});
			req.on("error", reject);
			req.end();
		});
		ok(`§7 a client that stops reading loses its read slot: the next request is served (status ${next.status}, after ${next.ms} ms)`, next.status === 200 && next.ms < 2500);
		stalled.destroy();

		for (const s of servers) s.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}

	console.log(failed ? `\n${failed} FAILED` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
