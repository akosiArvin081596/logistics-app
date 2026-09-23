#!/usr/bin/env node
/**
 * Regression coverage for the image-limit guards; the companion to
 * scripts/test-image-limits.js. It runs a converter without the header check
 * and the shipped imageToPdf() side by side on the same malformed PNG, each in
 * its own child process so the runner is isolated from both, and asserts that
 * the shipped converter refuses the image with a 415 and keeps running.
 *
 * No network, no DB, no server.
 *   node scripts/test-image-limits-regression.js      # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const SERVER_SRC = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const LIB_PATH = path.join(REPO, "lib", "image-size.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "image-limits-regression-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

if (!fs.existsSync(LIB_PATH)) {
	console.log("FAIL  lib/image-size.js does not exist");
	console.log("\n1 test(s) failed");
	process.exit(1);
}

// Lift the shipped imageToPdf so the child runs the real function, not a copy.
function fnBody(name, src = SERVER_SRC) {
	let a = src.indexOf(`\nfunction ${name}(`);
	if (a < 0) a = src.indexOf(`\nasync function ${name}(`);
	if (a < 0) return "";
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
const imageToPdfBody = fnBody("imageToPdf");
ok("imageToPdf lifted from server.js", imageToPdfBody.includes("imageLimits.checkImage"));

// --- the test input: a small RGBA PNG whose image data is malformed ----------
function crc32(buf) {
	let crc = ~0 >>> 0;
	for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1)); }
	return (~crc) >>> 0;
}
function pngChunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const t = Buffer.from(type, "latin1");
	const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
	return Buffer.concat([len, t, data, c]);
}
function unsafeAlphaPng() {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6; // 2x2, RGBA
	const idat = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x00, 0x00, 0xff, 0xff]));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0)),
	]);
}
fs.writeFileSync(path.join(TMP, "unsafe.png"), unsafeAlphaPng());

const OLD_CHILD = `
const PDFDocument = require(${JSON.stringify(path.join(REPO, "node_modules", "pdfkit"))});
const fs = require("fs");
const buf = fs.readFileSync(${JSON.stringify(path.join(TMP, "unsafe.png"))});
function oldImageToPdf(buffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (const b of buffers) { const img = doc.openImage(b); doc.addPage({ size: [img.width, img.height] }); doc.image(img, 0, 0); }
    doc.end();
  });
}
oldImageToPdf([buf]).then(() => { console.log("RESOLVED"); process.exit(0); }).catch(() => { console.log("REJECTED"); process.exit(0); });
setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 2500);
`;
const NEW_CHILD = `
const PDFDocument = require(${JSON.stringify(path.join(REPO, "node_modules", "pdfkit"))});
const imageLimits = require(${JSON.stringify(LIB_PATH)});
const fs = require("fs");
const buf = fs.readFileSync(${JSON.stringify(path.join(TMP, "unsafe.png"))});
${imageToPdfBody}
imageToPdf([buf]).then(() => { console.log("RESOLVED"); process.exit(0); })
  .catch((e) => { console.log("REJECTED " + (e && e.status) + " " + (e && e.code)); process.exit(0); });
setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 2500);
`;
const oldFile = path.join(TMP, "old-child.js");
const newFile = path.join(TMP, "new-child.js");
fs.writeFileSync(oldFile, OLD_CHILD);
fs.writeFileSync(newFile, NEW_CHILD);

const runChild = (file) => spawnSync(process.execPath, [file], { cwd: REPO, encoding: "utf8", timeout: 15000 });
const oldRun = runChild(oldFile);
// A PRECONDITION, not an assertion: it pins the upstream behaviour this input
// was built for. If a pdfkit / png-js release stops ending the process here,
// that is good news upstream and not a regression here, so it is reported and
// skipped. The shipped guard is still checked below, and by test-image-limits.js.
const oldEnded = oldRun.status !== 0 && !/RESOLVED|REJECTED|SURVIVED/.test(oldRun.stdout || "");
if (oldEnded) {
	ok(`the pre-fix converter ends its process on this input (exit ${oldRun.status}, signal ${oldRun.signal})`, true);
} else {
	console.log("SKIP  upstream behaviour changed — precondition not met: the converter without the header check " +
		`no longer ends its process on this input (exit ${oldRun.status}, output ${JSON.stringify((oldRun.stdout || "").trim())}). ` +
		"The guard is still verified by scripts/test-image-limits.js and by the assertion below.");
}
const newRun = runChild(newFile);
ok("the shipped converter REJECTS this input with a 415 and the process survives (exit 0)",
	newRun.status === 0 && /^REJECTED 415 /m.test(newRun.stdout || ""));

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
