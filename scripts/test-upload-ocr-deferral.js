#!/usr/bin/env node
/**
 * Receipt OCR is OFF the critical path of POST /api/documents/upload.
 *
 * WHY THIS EXISTS. The route used to `await extractReceiptText()` — a fresh
 * Tesseract worker per upload, and a CDN fetch of eng.traineddata when it was
 * not cached — BEFORE responding, to fill an `ocrText` field that no client
 * read. On a slow cellular uplink that is time spent inside nginx's window
 * after the body has already crawled in, and a client that gives up re-POSTs
 * the whole document, minting a second `documents` row. The only consumer of
 * the text is documents.ocr_text, which GET /api/documents/:loadId serves to
 * DocumentList later. So the route now responds first and queueReceiptOcr()
 * fills the column afterwards — the same respond-then-setImmediate shape the
 * POD Sheets write already had.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 the route, as source: no OCR before the response, the enqueue inside a
 *      setImmediate after res.json(), the row id captured from the INSERT, the
 *      response without `ocrText`, Receipt-only — and the orderings that were
 *      already load-bearing (ownership before the disk write, the POD sheet
 *      write deferred) still hold
 *   §2 queueReceiptOcr() executed for real with its I/O injected: one at a
 *      time, written by PRIMARY KEY, failures swallowed, backlog bounded in
 *      jobs AND in image bytes, and an image OCR would skip refused at the door
 *   §3 DISCRIMINATION — mutants of the route and of the queue
 *
 * Pure: no server, no app.db, no network, no Tesseract, no fixtures.
 *
 * Run: node scripts/test-upload-ocr-deferral.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
function liftFn(name) {
	let a = SRC.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	if (SRC.slice(a - 6, a) === "async ") a -= 6;
	let depth = 0, seen = false;
	for (let i = SRC.indexOf("{", a); i < SRC.length; i++) {
		if (SRC[i] === "{") { depth++; seen = true; }
		else if (SRC[i] === "}") { depth--; if (seen && depth === 0) return SRC.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
// Anchored at a line start: comments quote route registrations.
function routeSource(verb, routePath) {
	const nl = SRC.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	const at = nl + 1;
	let depth = 0;
	for (let j = SRC.indexOf("(", at); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}
function liftLine(re, label) {
	const m = SRC.match(re);
	if (!m) { console.error(`FAIL  could not locate ${label} in server.js`); process.exit(1); }
	return m[0];
}

const ROUTE = routeSource("post", "/api/documents/upload");
const QUEUE_SRC = liftFn("queueReceiptOcr");
const MAX_SRC = liftLine(/const RECEIPT_OCR_MAX_PENDING = \d+;/, "RECEIPT_OCR_MAX_PENDING");
const BYTES_SRC = liftLine(/const RECEIPT_OCR_MAX_QUEUED_BYTES = [^;\n]+;/, "RECEIPT_OCR_MAX_QUEUED_BYTES");
const CHAIN_SRC = liftLine(/let receiptOcrChain = Promise\.resolve\(\);/, "receiptOcrChain");
const PENDING_SRC = liftLine(/let receiptOcrPending = 0;/, "receiptOcrPending");
const QUEUED_BYTES_SRC = liftLine(/let receiptOcrQueuedBytes = 0;/, "receiptOcrQueuedBytes");

// ⚠️ Comments are stripped first: the route's own comments NAME
// queueReceiptOcr() above res.json(), and an ordering check that reads them
// would fail the real code and pass a route that never queues at all.
const stripComments = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// Every way the route could put OCR back on the critical path. Shared with §3.
function criticalPathViolations(rawRoute) {
	const route = stripComments(rawRoute);
	const v = [];
	const respond = route.indexOf("res.json({ success: true");
	const queued = route.indexOf("queueReceiptOcr(");
	if (/extractReceiptText\(/.test(route)) v.push("the route calls extractReceiptText() itself");
	if (/await\s+queueReceiptOcr\(/.test(route)) v.push("the route awaits the OCR queue");
	if (respond < 0) v.push("no success response found");
	if (queued < 0) v.push("receipt OCR is never queued (the text would never be stored)");
	if (queued >= 0 && respond >= 0 && queued < respond) v.push("OCR is queued BEFORE the response is sent");
	if (!/setImmediate\(\(\) => queueReceiptOcr\(documentId, ocrSource\)\)/.test(route)) v.push("the enqueue is not deferred through setImmediate");
	if (/res\.json\(\{ success: true[^}]*ocrText/.test(route)) v.push("the response still carries ocrText (it cannot exist yet)");
	return v;
}

// ===========================================================================
console.log("\n§1  POST /api/documents/upload — the critical path");
// ===========================================================================
const live = criticalPathViolations(ROUTE);
for (const v of live) console.log(`      ${v}`);
ok("OCR is not on the critical path (no call, no await, queued only after res.json)", live.length === 0);
ok("the enqueue only happens for a stored row with bytes to read",
	/if \(ocrSource && documentId != null\) \{\s*setImmediate\(\(\) => queueReceiptOcr\(documentId, ocrSource\)\);/.test(ROUTE));
ok("OCR bytes are taken ONLY for an image Receipt (POD / BOL / Other never ran OCR)",
	/let ocrSource = null;\s*if \(docType === "Receipt" && fileType !== 'document'\) \{[^}]*ocrSource = Buffer\.from\(/.test(ROUTE) &&
	(stripComments(ROUTE).match(/\bocrSource = /g) || []).length === 2);
ok("the INSERT stores an empty ocr_text and keeps the new row's id (lastInsertRowid)",
	/documentId = db\.prepare\([\s\S]*?INSERT INTO documents[\s\S]*?\.run\([\s\S]*?driveUrl,\s*"",\s*\)\.lastInsertRowid;/.test(ROUTE));
ok("the success response is exactly { success, driveUrl }", /res\.json\(\{ success: true, driveUrl \}\);/.test(ROUTE));
ok("the ownership check still runs before anything touches disk",
	ROUTE.indexOf("loadBelongsToDriver(") > -1 && ROUTE.indexOf("loadBelongsToDriver(") < ROUTE.indexOf("fs.writeFileSync("));
ok("the POD sheet write is still deferred too (and its triage log line is intact)",
	ROUTE.indexOf("res.json({ success: true") < ROUTE.indexOf('if (docType === "POD") {\n\t\t\tsetImmediate(async') &&
	ROUTE.includes("deferring POD sheet update"));
ok("the backlog cap is 20 (a bound, not a queue that grows with the backlog)",
	/const RECEIPT_OCR_MAX_PENDING = 20;/.test(MAX_SRC));
const maxQueuedBytes = new Function(`"use strict";\n${BYTES_SRC}\nreturn RECEIPT_OCR_MAX_QUEUED_BYTES;`)();
ok(`the queued-image byte cap is a real bound (${maxQueuedBytes} bytes: at least one maximum-size upload, at most 256 MB)`,
	Number.isInteger(maxQueuedBytes) && maxQueuedBytes >= 40 * 1024 * 1024 && maxQueuedBytes <= 256 * 1024 * 1024);

// ===========================================================================
// §2 harness
// ===========================================================================
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); } // eslint-disable-line no-await-in-loop

// `skipReason` stands in for receiptOcrSkipReason() (the image-header check,
// covered by scripts/test-receipt-ocr-crash.js): by default every buffer passes,
// so these cases exercise the queue itself.
function buildQueue({ queueSrc = QUEUE_SRC, maxSrc = MAX_SRC, bytesSrc = BYTES_SRC, ocr, runThrows = null, skipReason = () => null } = {}) {
	const logs = [], updates = [];
	const db = {
		prepare(sql) {
			return { run(...args) { if (runThrows) throw runThrows; updates.push({ sql, args }); return { changes: 1 }; } };
		},
	};
	const fakeConsole = { warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), log() {} };
	const api = new Function("extractReceiptText", "receiptOcrSkipReason", "db", "console",
		`"use strict";\n${maxSrc}\n${bytesSrc}\n${CHAIN_SRC}\n${PENDING_SRC}\n${QUEUED_BYTES_SRC}\n${queueSrc}\n` +
		"return { queueReceiptOcr, pending: () => receiptOcrPending, queuedBytes: () => receiptOcrQueuedBytes, chain: () => receiptOcrChain };")(
		ocr, skipReason, db, fakeConsole);
	return { ...api, logs, updates };
}

// A controllable OCR: each call waits for its own release(); tracks overlap.
function gatedOcr() {
	const gates = [];
	let inFlight = 0, maxInFlight = 0, calls = 0;
	const fn = (buf) => {
		calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
		return new Promise((resolve, reject) => {
			gates.push({
				buf,
				release: (text) => { inFlight--; resolve(text); },
				fail: (err) => { inFlight--; reject(err); },
			});
		});
	};
	return { fn, gates, stats: () => ({ inFlight, maxInFlight, calls }) };
}

const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(r));

async function serialRun(queueSrc) {
	const g = gatedOcr();
	const q = buildQueue({ queueSrc, ocr: g.fn });
	q.queueReceiptOcr(11, Buffer.from("a"));
	q.queueReceiptOcr(12, Buffer.from("b"));
	q.queueReceiptOcr(13, Buffer.from("c"));
	await settle();
	const startedBeforeFirstFinished = g.stats().calls;
	for (let i = 0; i < 3; i++) {
		if (g.gates[i]) g.gates[i].release(`text-${i + 1}`);
		await settle(); // eslint-disable-line no-await-in-loop
	}
	return { g, q, startedBeforeFirstFinished };
}

async function capRun(queueSrc) {
	const g = gatedOcr();
	const q = buildQueue({ queueSrc, maxSrc: "const RECEIPT_OCR_MAX_PENDING = 3;", ocr: g.fn });
	const accepted = [1, 2, 3, 4, 5].map((id) => q.queueReceiptOcr(id, Buffer.from("x")));
	return { g, q, accepted };
}

// Three 4-byte images against a 10-byte cap: the third would make 12.
async function bytesRun(queueSrc) {
	const g = gatedOcr();
	const q = buildQueue({ queueSrc, bytesSrc: "const RECEIPT_OCR_MAX_QUEUED_BYTES = 10;", ocr: g.fn });
	const accepted = [71, 72, 73].map((id) => q.queueReceiptOcr(id, Buffer.alloc(4)));
	return { g, q, accepted };
}

async function failureRun(queueSrc) {
	const q = buildQueue({
		queueSrc,
		ocr: async (buf) => { if (String(buf) === "boom") throw new Error("tesseract exploded"); return "SHELL 4.29"; },
	});
	q.queueReceiptOcr(21, Buffer.from("boom"));
	q.queueReceiptOcr(22, Buffer.from("fine"));
	await settle();
	return q;
}

(async () => {
	// =========================================================================
	console.log("\n§2  queueReceiptOcr() — executed with its I/O injected");
	// =========================================================================
	{
		const { g, q, startedBeforeFirstFinished } = await serialRun(QUEUE_SRC);
		ok("ONE AT A TIME: three queued, only the first started before it finished",
			startedBeforeFirstFinished === 1 && g.stats().maxInFlight === 1);
		ok("all three ran, in order", g.stats().calls === 3 && g.gates.map((x) => String(x.buf)).join() === "a,b,c");
		ok("each result is written to ITS row, by primary key",
			q.updates.map((u) => u.args.join(":")).join() === "text-1:11,text-2:12,text-3:13");
		ok("...with `WHERE id = ?` — documents.file_name has no unique index",
			q.updates.every((u) => u.sql === "UPDATE documents SET ocr_text = ? WHERE id = ?"));
		ok("the pending count drains back to zero", q.pending() === 0);
	}
	{
		const q = buildQueue({ ocr: async () => "" });
		q.queueReceiptOcr(31, Buffer.from("blank"));
		await settle();
		ok("an empty OCR result writes nothing (the column is already '')", q.updates.length === 0 && q.pending() === 0);
	}
	{
		const q = await failureRun(QUEUE_SRC);
		ok("an OCR failure is logged as non-critical and swallowed",
			q.logs.some((l) => /deferred receipt OCR failed for document 21 \(non-critical\).*tesseract exploded/.test(l)));
		ok("...and the NEXT receipt is still read (a failure must not wedge the chain)",
			q.updates.length === 1 && q.updates[0].args.join(":") === "SHELL 4.29:22" && q.pending() === 0);
		ok("...and every held byte is given back, failure or not", q.queuedBytes() === 0);
	}
	{
		const g = gatedOcr();
		const q = buildQueue({ ocr: g.fn, skipReason: (buf) => (String(buf) === "huge" ? "9000x9000 image is over the 25 MP limit" : null) });
		const accepted = q.queueReceiptOcr(61, Buffer.from("huge"));
		await settle();
		ok("an image OCR would skip is refused when QUEUED — nothing held, no OCR started",
			accepted === false && q.pending() === 0 && q.queuedBytes() === 0 && g.stats().calls === 0);
		ok("...and the reason is logged",
			q.logs.some((l) => /receipt OCR skipped for document 61: 9000x9000 image is over the 25 MP limit/.test(l)));
	}
	{
		const { g, q, accepted } = await bytesRun(QUEUE_SRC);
		ok("BOUNDED IN BYTES: past the byte cap a receipt is refused, however few jobs are queued",
			accepted.join() === "true,true,false" && q.pending() === 2 && q.queuedBytes() === 8);
		ok("...and the refusal says so", q.logs.some((l) => /receipt OCR skipped for document 73: the OCR queue is full \(2 queued/.test(l)));
		for (let i = 0; i < 2; i++) {
			await settle(); // eslint-disable-line no-await-in-loop
			if (g.gates[i]) g.gates[i].release("t");
		}
		await settle();
		ok("...and the bytes are given back as jobs finish", q.pending() === 0 && q.queuedBytes() === 0);
	}
	{
		const q = buildQueue({ ocr: async () => "text", runThrows: new Error("SQLITE_BUSY") });
		q.queueReceiptOcr(41, Buffer.from("x"));
		await settle();
		ok("a failed UPDATE is logged and swallowed too", q.logs.some((l) => /document 41.*SQLITE_BUSY/.test(l)) && q.pending() === 0);
	}
	{
		const q = buildQueue({ ocr: undefined });
		let threw = null;
		try { q.queueReceiptOcr(51, Buffer.from("x")); } catch (e) { threw = e; }
		await settle();
		ok("queueReceiptOcr() never throws into the route, even with OCR unavailable", threw === null && q.pending() === 0);
	}
	{
		const { g, q, accepted } = await capRun(QUEUE_SRC);
		ok("BOUNDED: past the cap a receipt is refused rather than queued",
			accepted.join() === "true,true,true,false,false" && q.pending() === 3);
		ok("...and each refusal says so in the log",
			q.logs.filter((l) => /receipt OCR skipped for document [45]: the OCR queue is full \(3 queued/.test(l)).length === 2);
		for (let i = 0; i < 3; i++) {
			await settle(); // eslint-disable-line no-await-in-loop
			if (g.gates[i]) g.gates[i].release("t");
		}
		await settle();
		ok("once the backlog drains, receipts are accepted again",
			q.pending() === 0 && q.queueReceiptOcr(6, Buffer.from("x")) === true);
		await settle();
		if (g.gates[3]) g.gates[3].release("t");
		await settle();
	}
	ok("no unhandled promise rejection escaped the queue", unhandled.length === 0);

	// =========================================================================
	console.log("\n§3  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	const OLD_BLOCK = '\t\tlet ocrSource = null;\n\t\tif (docType === "Receipt" && fileType !== \'document\') {\n\t\t\tconst photoArray = Array.isArray(photoData) ? photoData : [photoData];\n\t\t\tocrSource = Buffer.from(photoArray[0].replace(/^data:image\\/\\w+;base64,/, ""), "base64");\n\t\t}';
	ok("(mutation anchor present)", ROUTE.includes(OLD_BLOCK));
	const awaited = ROUTE.replace(OLD_BLOCK,
		OLD_BLOCK + "\n\t\tlet ocrText = \"\";\n\t\tif (ocrSource) ocrText = await extractReceiptText(ocrSource);");
	ok("MUTANT the pre-fix `await extractReceiptText()` before the INSERT: flagged",
		criticalPathViolations(awaited).some((v) => /calls extractReceiptText/.test(v)));
	const early = ROUTE.replace("setImmediate(() => queueReceiptOcr(documentId, ocrSource));", "")
		.replace("res.json({ success: true, driveUrl });", "queueReceiptOcr(documentId, ocrSource);\n\t\tres.json({ success: true, driveUrl });");
	ok("MUTANT queued before the response and without setImmediate: flagged",
		criticalPathViolations(early).some((v) => /BEFORE the response/.test(v)) &&
		criticalPathViolations(early).some((v) => /not deferred/.test(v)));
	ok("MUTANT the response putting ocrText back: flagged",
		criticalPathViolations(ROUTE.replace("res.json({ success: true, driveUrl });", "res.json({ success: true, driveUrl, ocrText: \"\" });"))
			.some((v) => /ocrText/.test(v)));
	ok("MUTANT OCR dropped entirely (never queued): flagged",
		criticalPathViolations(ROUTE.replace("setImmediate(() => queueReceiptOcr(documentId, ocrSource));", ""))
			.some((v) => /never queued/.test(v)));

	const SERIAL = "receiptOcrChain = receiptOcrChain.then(async () => {";
	const CAP = "if (receiptOcrPending >= RECEIPT_OCR_MAX_PENDING || receiptOcrQueuedBytes + bytes > RECEIPT_OCR_MAX_QUEUED_BYTES) {";
	const BYTE_CAP = " || receiptOcrQueuedBytes + bytes > RECEIPT_OCR_MAX_QUEUED_BYTES";
	const SKIP_BLOCK = /\tconst skip = receiptOcrSkipReason\(imageBuffer\);\n\tif \(skip\) \{\n\t\tconsole\.warn\([^\n]*\n\t\treturn false;\n\t\}\n/;
	ok("(queue anchors present)", QUEUE_SRC.includes(SERIAL) && QUEUE_SRC.includes(CAP) && SKIP_BLOCK.test(QUEUE_SRC) &&
		QUEUE_SRC.includes("receiptOcrQueuedBytes -= bytes;"));
	const parallel = await serialRun(QUEUE_SRC.replace(SERIAL, "receiptOcrChain = Promise.resolve().then(async () => {"));
	ok("MUTANT parallel OCR (no chaining): the one-at-a-time assertion flips",
		parallel.startedBeforeFirstFinished === 3 && parallel.g.stats().maxInFlight === 3);
	const uncapped = await capRun(QUEUE_SRC.replace(CAP, "if (false) {"));
	ok("MUTANT cap removed: the bound assertion flips", uncapped.accepted.every(Boolean));
	uncapped.g.gates.forEach((x) => x.release("t"));
	const noByteCap = await bytesRun(QUEUE_SRC.replace(BYTE_CAP, ""));
	ok("MUTANT byte cap removed: the bytes bound flips", noByteCap.accepted.every(Boolean));
	noByteCap.g.gates.forEach((x) => x.release("t"));
	const leaky = await bytesRun(QUEUE_SRC.replace("receiptOcrQueuedBytes -= bytes;", ""));
	leaky.g.gates.forEach((x) => x.release("t"));
	await settle();
	ok("MUTANT bytes never given back: the queue stays 'full' after it drains — flips", leaky.q.queuedBytes() === 8);
	{
		const g = gatedOcr();
		const q = buildQueue({ queueSrc: QUEUE_SRC.replace(SKIP_BLOCK, ""), ocr: g.fn, skipReason: () => "over the limit" });
		const accepted = q.queueReceiptOcr(81, Buffer.from("huge"));
		await settle();
		ok("MUTANT size checked only when the job runs: the image is queued and held — flips", accepted === true && g.stats().calls === 1);
		g.gates.forEach((x) => x.release("t"));
		await settle();
	}
	const byName = await serialRun(QUEUE_SRC.replace("WHERE id = ?", "WHERE file_name = ?"));
	ok("MUTANT UPDATE by file_name: the primary-key assertion flips",
		byName.q.updates.every((u) => u.sql !== "UPDATE documents SET ocr_text = ? WHERE id = ?"));
	const wedged = await failureRun(QUEUE_SRC.replace(/\} catch \(err\) \{\n\t\t\tconsole\.error\([^\n]+\n\t\t\}/, "}"));
	ok("MUTANT no catch: the failure wedges the chain — the next receipt is never read",
		wedged.updates.length === 0);
	await settle();
	ok("...and it escapes as an unhandled rejection", unhandled.length > 0);

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack || err);
	process.exit(1);
});
