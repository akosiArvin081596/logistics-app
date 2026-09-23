#!/usr/bin/env node
/**
 * Receipt OCR must never be able to take the server down, and must never be
 * handed more image than it can safely decode.
 *
 * The OCR engine runs outside the server process: extractReceiptText() checks
 * the image's pixel count from its header, then runs each job in a short-lived
 * child (lib/tesseract-ocr-child.js) that is killed at a deadline. A failure of
 * any kind inside the engine therefore ends a child, not the server.
 *
 * Every scenario runs in a CHILD process of this runner, because the failure
 * being tested is a process dying — a crash inside this runner would take the
 * runner down with it and prove nothing.
 *
 *   §1 static: the engine is never loaded in the server process; the child is
 *      started with a clean environment and killed at the deadline; the pixel
 *      limit is checked before any child starts; the model location is pinned
 *   §2 receiptImageSize(): PNG and JPEG headers, malformed input, bounded work
 *   §3 end to end in a stand-in server process: an OCR job that crashes, hangs,
 *      fails cleanly or answers, and images over the limit or unreadable. The
 *      server survives, the queue drains, only the right rows get text, a hung
 *      job is killed, a job that dies loading its model clears the cached
 *      model, and one that dies on its image keeps it.
 *      Version-agnostic on purpose: code that runs the engine IN-PROCESS meets a
 *      fake engine transport whose worker fails the way a worker thread does;
 *      code that uses the child meets a stand-in child. Either way, the question
 *      is only whether the server process lives.
 *   §4 the real lib/tesseract-ocr-child.js over a fake engine transport: it
 *      answers, reports a failed job instead of crashing, uses the model location
 *      it is given, and exits when the server goes away
 *   §5 DISCRIMINATION — remove each protection, require an assertion to flip
 *
 * No server, no app.db, no network. Temp files only, in a fresh mkdtemp.
 * Run: node scripts/test-receipt-ocr-crash.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, fork } = require("child_process");

const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const CHILD_PATH = path.join(REPO, "lib", "tesseract-ocr-child.js");
const CHILD_SRC = fs.existsSync(CHILD_PATH) ? fs.readFileSync(CHILD_PATH, "utf8") : "";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-isolation-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// --- lifting (tolerant: absent names lift as "") -----------------------------
function liftFn(name, src = SRC) {
	let a = src.indexOf(`\nfunction ${name}(`);
	if (a < 0) a = src.indexOf(`\nasync function ${name}(`);
	if (a < 0) return "";
	a += 1;
	let p = src.indexOf("(", src.indexOf(`function ${name}(`, a));
	for (let d = 0; p < src.length; p++) {
		if (src[p] === "(") d++;
		else if (src[p] === ")" && --d === 0) break;
	}
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", p); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
const STATE_RE = /^(?:const|let) (?:RECEIPT_OCR_(?:TIMEOUT_MS|BACKOFF_MS|MAX_PIXELS|CHILD|CACHE_DIR|LANG_PATH|MAX_PENDING)|receiptOcr(?:Chain|Pending|PausedUntil)) = [^\n;]+;[^\n]*$/gm;
const STATE_SRC = (SRC.match(STATE_RE) || []).join("\n");
const SIZE_SRC = liftFn("receiptImageSize");
const EXTRACT_SRC = liftFn("extractReceiptText");
const RUN_SRC = liftFn("runReceiptOcrChild");
const QUEUE_SRC = liftFn("queueReceiptOcr");
const DEADLINE_SRC = liftFn("receiptOcrDeadline");   // older in-process design, if present
if (!EXTRACT_SRC || !QUEUE_SRC) {
	console.error("FAIL  could not locate extractReceiptText / queueReceiptOcr in server.js");
	process.exit(1);
}
const OCR_SRC = [STATE_SRC, SIZE_SRC, DEADLINE_SRC, RUN_SRC, EXTRACT_SRC, QUEUE_SRC].filter(Boolean).join("\n\n");

// --- fixtures ----------------------------------------------------------------
// Headers only — a real signature and dimensions, then a marker the stand-ins
// act on. Nothing here decodes to pixels.
function png(width, height, marker = "") {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	b[24] = 8; b[25] = 2;
	return Buffer.concat([b, Buffer.from(marker, "latin1")]);
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
function jpeg(...parts) {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xd9])]);
}
const APP0 = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const APP1 = segment(0xe1, Buffer.alloc(40, 0x41));
const DQT = segment(0xdb, Buffer.alloc(65, 1));
const DHT = segment(0xc4, Buffer.alloc(30, 2));   // shares the SOF marker range; is NOT a frame header
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(30, 0x10)]);

// --- the fake engine transport (installed into require.cache) ---------------
// Replaces tesseract.js/src/worker/node: no worker thread, no wasm, no network.
// Its worker is an EventEmitter, so a CRASH image fails it exactly the way a
// worker thread's failure reaches the main thread: as an 'error' event.
const FAKE_ENGINE = String.raw`
function installFakeEngine(repo, echo) {
	const Module = require("module"), path = require("path"), { EventEmitter } = require("events");
	const r = Module.createRequire(path.join(repo, "package.json"));
	const nodeDir = path.join(path.dirname(r.resolve("tesseract.js")), "worker", "node");
	const transportPath = path.join(nodeDir, "index.js");
	const seen = {};
	let n = 0;
	function respond(w, packet) {
		const { workerId, jobId, action, payload } = packet;
		if (w.dead) return;
		if (action === "loadLanguage") { seen.cachePath = payload.options.cachePath; seen.langPath = payload.options.langPath; }
		let status = "resolve", data = {};
		if (action === "recognize") {
			const img = Buffer.from(payload.image).toString("latin1");
			if (img.includes("CRASH") || img.includes("BROKENMODEL")) { w.emit("error", new Error("OCR worker failed")); return; }
			if (img.includes("HANG")) return;
			if (img.includes("FAIL")) { status = "reject"; data = "Error: could not read image"; }
			else data = { text: "  SHELL #4.29" + (echo ? "|cache=" + seen.cachePath + "|lang=" + seen.langPath : "") + " \n" };
		}
		w.emit("message", { workerId, jobId, action, status, data });
	}
	const fake = {
		defaultOptions: require(path.join(nodeDir, "defaultOptions.js")),
		spawnWorker: () => Object.assign(new EventEmitter(), { n: ++n, dead: false }),
		onMessage: (w, handler) => { w.on("message", handler); },
		send: async (w, packet) => { setTimeout(() => respond(w, packet), 0); },
		terminateWorker: (w) => { w.dead = true; },
		loadImage: async (image) => image,
	};
	const m = new Module(transportPath);
	m.filename = transportPath; m.loaded = true; m.exports = fake;
	require.cache[transportPath] = m;
}
`;

// --- the stand-in OCR child (for code that uses a child process) ------------
// Written into a directory PER stand-in server run: the runs execute in
// parallel, and each counts the children it started by the files they drop.
const STANDIN_SRC = String.raw`
const fs = require("fs"), path = require("path");
fs.writeFileSync(path.join(__dirname, "spawned-" + process.pid), "");
process.once("message", (job) => {
	const img = Buffer.from(job.image).toString("latin1");
	if (img.includes("BROKENMODEL")) { setImmediate(() => { throw new Error("OCR engine failed to start"); }); return; }
	if (img.includes("HANG")) { setInterval(() => {}, 1000); return; }
	process.send({ ready: true });                                   // the model has loaded
	if (img.includes("CRASH")) { setImmediate(() => { throw new Error("OCR engine failed"); }); return; }
	if (img.includes("FAIL")) { process.send({ error: "could not read image" }, () => process.exit(0)); return; }
	process.send({ text: "  SHELL #4.29 \n" }, () => process.exit(0));
});
`;

// --- the stand-in server process --------------------------------------------
const HARNESS = String.raw`
"use strict";
const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fs = require("fs"), path = require("path"), Module = require("module");
` + FAKE_ENGINE + String.raw`
installFakeEngine(cfg.repo, false);
const repoRequire = Module.createRequire(path.join(cfg.repo, "package.json"));
const logs = [];
const quiet = { log() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
const updates = [];
const db = { prepare: (sql) => ({ run: (...args) => { updates.push(args); return { changes: 1 }; } }) };
const api = new Function("require", "db", "console", "__dirname", "path", "fs",
	'"use strict";\n' + cfg.src + "\nreturn { queueReceiptOcr, pending: () => receiptOcrPending };")(
	repoRequire, db, quiet, cfg.repo, path, fs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawned = () => fs.readdirSync(cfg.standinDir).filter((f) => f.startsWith("spawned-")).map((f) => Number(f.slice(8)));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cacheFile = path.join(cfg.cacheDir, "eng.traineddata");
(async () => {
	const steps = [];
	for (const s of cfg.steps) {
		if (s.seedCache) { fs.mkdirSync(cfg.cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, "model"); }
		const before = spawned();
		api.queueReceiptOcr(s.doc, Buffer.from(s.image, "base64"));
		let drained = false;
		for (const end = Date.now() + s.drain; Date.now() < end; await sleep(5)) if (api.pending() === 0) { drained = true; break; }
		const mine = spawned().filter((p) => !before.includes(p));
		let stillAlive = false;
		for (const pid of mine) {
			for (let t = 0; t < 100 && alive(pid); t++) await sleep(10);   // reaping is asynchronous
			if (alive(pid)) { stillAlive = true; try { process.kill(pid, "SIGKILL"); } catch {} }
		}
		steps.push({ doc: s.doc, drained, childrenStarted: mine.length, childAlive: stillAlive, cacheExists: fs.existsSync(cacheFile) });
	}
	process.stdout.write("\n@@RESULT@@" + JSON.stringify({ steps, updates, logs, pending: api.pending() }) + "\n");
	process.exit(0);
})();
`;

function runProcess(args, input, opts = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], ...opts });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
		child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
		const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("close", (code, signal) => {
			clearTimeout(killer);
			const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
			resolve({ code, signal, stderr: stderr.trim().split("\n").filter(Boolean).join(" | "),
				out: line ? JSON.parse(line.slice("@@RESULT@@".length)) : null });
		});
		child.stdin.end(input);
	});
}

// Scenario sets, each in its own stand-in server process, so one can never mask
// another. Each carries its own job deadline: only "hang" is MEANT to reach it,
// so it alone gets a short one; the others get a generous one, so a slow process
// start on a loaded CI runner can never pass for a timeout.
const b64 = (buf) => buf.toString("base64");
const SCENARIOS = {
	failures: { timeoutMs: 8000, steps: [
		{ doc: 1, image: b64(png(800, 600, "BROKENMODEL")), drain: 10000, seedCache: true }, // dies loading its model
		{ doc: 2, image: b64(png(800, 600, "GOOD")), drain: 10000 },                        // the next receipt still reads
		{ doc: 8, image: b64(png(800, 600, "CRASH")), drain: 10000, seedCache: true },       // dies on its image
		{ doc: 5, image: b64(png(800, 600, "FAIL")), drain: 10000, seedCache: true },        // fails cleanly
	] },
	hang: { timeoutMs: 1500, steps: [
		{ doc: 4, image: b64(png(800, 600, "HANG")), drain: 8000, seedCache: true },    // never answers
	] },
	limits: { timeoutMs: 8000, steps: [
		{ doc: 3, image: b64(png(6000, 5000, "GOOD")), drain: 1500 },                  // over the pixel limit
		{ doc: 6, image: b64(GIF), drain: 1500 },                                     // unreadable header
		{ doc: 7, image: b64(png(1280, 960, "GOOD")), drain: 10000 },                  // an ordinary app photo
	] },
};
let caseNo = 0;
function serverRun(src, scenario) {
	const n = ++caseNo;
	const cacheDir = path.join(TMP, `cache-${n}`);
	const standinDir = path.join(TMP, `standin-${n}`);
	fs.mkdirSync(standinDir);
	const standin = path.join(standinDir, "ocr-child.js");
	fs.writeFileSync(standin, STANDIN_SRC);
	const prepared = src
		.replace(/const RECEIPT_OCR_TIMEOUT_MS = [^;]+;/, `const RECEIPT_OCR_TIMEOUT_MS = ${SCENARIOS[scenario].timeoutMs};`)
		.replace(/const RECEIPT_OCR_BACKOFF_MS = [^;]+;/, "const RECEIPT_OCR_BACKOFF_MS = 100;")
		.replace(/const RECEIPT_OCR_CHILD = [^;]+;/, `const RECEIPT_OCR_CHILD = ${JSON.stringify(standin)};`)
		.replace(/const RECEIPT_OCR_CACHE_DIR = [^;]+;/, `const RECEIPT_OCR_CACHE_DIR = ${JSON.stringify(cacheDir)};`);
	return runProcess(["-e", HARNESS], JSON.stringify({ repo: REPO, src: prepared, cacheDir, standinDir, steps: SCENARIOS[scenario].steps }));
}

// The real child, over the fake engine, started the way the server starts it.
const INSTALLER = path.join(TMP, "fake-engine.js");
fs.writeFileSync(INSTALLER, FAKE_ENGINE + `\ninstallFakeEngine(${JSON.stringify(REPO)}, true);\n`);
// `disconnectAfterMs` simulates the server going away mid-job (a restart): the
// job is sent, then the channel closes while the engine is still working.
function childRun(childPath, job, { disconnectAfterMs = null } = {}) {
	return new Promise((resolve) => {
		if (!childPath || !fs.existsSync(childPath)) return resolve({ missing: true });
		const started = Date.now();
		const child = fork(childPath, [], {
			cwd: REPO, env: {}, execArgv: ["--require", INSTALLER], serialization: "advanced",
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		// `reply` is the FINAL answer ({ text } / { error }); `ready` the model-loaded
		// signal, and `readyFirst` whether it came before the answer.
		let reply = null, ready = false, readyFirst = false, stderr = "", done = false;
		child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
		child.on("message", (m) => {
			if (m && m.ready === true) { ready = true; readyFirst = reply === null; return; }
			reply = m;
		});
		const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		// 'close' normally; 'exit' as the backstop, so no case can hang this runner.
		const finish = (code, signal) => {
			if (done) return;
			done = true;
			clearTimeout(killer);
			resolve({ code, signal, reply, ready, readyFirst, stderr, ms: Date.now() - started });
		};
		child.on("close", finish);
		child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 500));
		child.send(job);
		if (disconnectAfterMs != null) setTimeout(() => { if (child.connected) child.disconnect(); }, disconnectAfterMs);
	});
}
function childVariant(src) {
	const p = path.join(REPO, "lib", `.tesseract-ocr-child.variant-${process.pid}-${++caseNo}.js`);
	fs.writeFileSync(p, src);
	process.on("exit", () => { try { fs.unlinkSync(p); } catch { /* gone */ } });
	return p;
}

// ===========================================================================
console.log("\n§1  static — the engine stays out of the server process");
// ===========================================================================
ok("server.js never loads the OCR engine in-process (no require of tesseract.js outside comments)",
	!/require\(\s*["']tesseract\.js["']\s*\)/.test(codeOnly(SRC)));
ok("each job runs in a child: runReceiptOcrChild() forks RECEIPT_OCR_CHILD",
	/fork\(RECEIPT_OCR_CHILD, \[\], \{/.test(RUN_SRC));
ok("...with a clean environment and no runtime flags (env: {}, execArgv: [])",
	/env: \{\},/.test(RUN_SRC) && /execArgv: \[\],/.test(RUN_SRC));
ok("...listening for 'error', 'message' and 'close' (an unheard 'error' would itself be fatal)",
	/child\.on\("error"/.test(RUN_SRC) && /child\.on\("message"/.test(RUN_SRC) && /child\.on\("close"/.test(RUN_SRC));
ok("...under a deadline, and the child is SIGKILLed whenever the job settles",
	/setTimeout\(\(\) => finish\(new Error\(`receipt OCR timed out/.test(RUN_SRC) &&
	/if \(child\.exitCode === null && child\.signalCode === null\) child\.kill\("SIGKILL"\);/.test(RUN_SRC));
const closeAt = RUN_SRC.indexOf('child.on("close"');
ok("a silent exit deletes the cached model SYNCHRONOUSLY and BEFORE the job settles " +
	"(the queue starts the next job the moment this one settles)",
	closeAt > -1 && RUN_SRC.indexOf("fs.rmSync(", closeAt) > closeAt &&
	RUN_SRC.indexOf("fs.rmSync(", closeAt) < RUN_SRC.indexOf("finish(new Error(`receipt OCR process exited", closeAt));
ok("...but only when the child died BEFORE its model loaded — dying on an image keeps the model",
	/if \(!modelLoaded\) \{\s*try \{ fs\.rmSync\(/.test(RUN_SRC) &&
	/if \(msg && msg\.ready === true\) \{ modelLoaded = true; return; \}/.test(RUN_SRC));
const maxPx = Number(((SRC.match(/const RECEIPT_OCR_MAX_PIXELS = ([\d_]+);/) || [])[1] || "").replace(/_/g, ""));
ok("RECEIPT_OCR_MAX_PIXELS is a real bound (0 < limit <= 50 MP)", maxPx > 0 && maxPx <= 50_000_000);
ok("the pixel limit is checked BEFORE any child starts",
	EXTRACT_SRC.indexOf("receiptImageSize(") > -1 && EXTRACT_SRC.indexOf("RECEIPT_OCR_MAX_PIXELS") > -1 &&
	EXTRACT_SRC.indexOf("RECEIPT_OCR_MAX_PIXELS") < EXTRACT_SRC.indexOf("runReceiptOcrChild("));
ok("the model is fetched from a VERSION-PINNED location",
	/const RECEIPT_OCR_LANG_PATH = "https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/eng@\d+\.\d+\.\d+\/4\.0\.0_best_int";/.test(SRC));
ok("...and cached in an app-owned directory git ignores",
	/const RECEIPT_OCR_CACHE_DIR = path\.join\(__dirname, "\.cache", "tesseract"\);/.test(SRC) &&
	/^\.cache\/$/m.test(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8")));
ok("the child script exists", !!CHILD_SRC);
ok("...creates its worker with an errorHandler, so a failed job is reported, not thrown",
	/createWorker\("eng", 1, \{[\s\S]*?errorHandler\s*:/.test(CHILD_SRC));
ok("...uses the model location it is given", /langPath: job\.langPath/.test(CHILD_SRC) && /cachePath: job\.cachePath/.test(CHILD_SRC));
ok("...and says { ready: true } once the model has loaded, before it recognizes",
	CHILD_SRC.indexOf("process.send({ ready: true });") > CHILD_SRC.indexOf("await createWorker(") &&
	CHILD_SRC.indexOf("process.send({ ready: true });") < CHILD_SRC.indexOf("worker.recognize("));
ok("...and exits when the server goes away", /process\.on\("disconnect", \(\) => process\.exit\(0\)\)/.test(CHILD_SRC));

// ===========================================================================
console.log("\n§2  receiptImageSize() — dimensions from the header alone");
// ===========================================================================
const receiptImageSize = SIZE_SRC ? new Function(`"use strict";\n${SIZE_SRC}\nreturn receiptImageSize;`)() : null;
ok("receiptImageSize() exists", !!receiptImageSize);
if (receiptImageSize) {
	const eq = (got, w, h) => !!got && got.width === w && got.height === h;
	ok("PNG: read from IHDR", eq(receiptImageSize(png(800, 600)), 800, 600));
	ok("PNG: an over-limit size is reported as-is (the caller decides)", eq(receiptImageSize(png(6000, 5000)), 6000, 5000));
	const noIhdr = png(800, 600); noIhdr.write("XXXX", 12, "latin1");
	ok("PNG: no IHDR where it must be → null", receiptImageSize(noIhdr) === null);
	ok("PNG: zero width → null", receiptImageSize(png(0, 600)) === null);
	ok("JPEG: baseline frame after APP0/APP1/DQT", eq(receiptImageSize(jpeg(APP0, APP1, DQT, sof(0xc0, 800, 600))), 800, 600));
	ok("JPEG: progressive frame (SOF2)", eq(receiptImageSize(jpeg(APP0, sof(0xc2, 1280, 960))), 1280, 960));
	ok("JPEG: a DHT segment before the frame is not mistaken for it",
		eq(receiptImageSize(jpeg(APP0, DHT, sof(0xc0, 1024, 768))), 1024, 768));
	ok("JPEG: fill bytes before a marker are skipped",
		eq(receiptImageSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff]), APP0.subarray(1), sof(0xc0, 640, 480), Buffer.from([0xff, 0xd9])])), 640, 480));
	ok("JPEG: image data before any frame header → null",
		receiptImageSize(jpeg(APP0, segment(0xda, Buffer.alloc(10)), sof(0xc0, 800, 600))) === null);
	ok("JPEG: a truncated frame header → null", receiptImageSize(jpeg(APP0).subarray(0, 20)) === null);
	ok("JPEG: lost sync (no marker where one must be) → null",
		receiptImageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40, 0x41)])) === null);
	ok("GIF / WebP / anything else → null (fail closed: no size, no OCR)",
		receiptImageSize(GIF) === null && receiptImageSize(Buffer.from("RIFF\0\0\0\0WEBPVP8 " + "x".repeat(20), "latin1")) === null);
	ok("non-buffers and short buffers → null",
		receiptImageSize(null) === null && receiptImageSize("abc") === null && receiptImageSize(Buffer.alloc(10)) === null);
	const many = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4 * 500_000).fill(Buffer.from([0xff, 0xfe, 0x00, 0x02]))]);
	const t0 = Date.now();
	const r = receiptImageSize(many);
	ok(`bounded: 500,000 empty segments are walked in linear time (${Date.now() - t0} ms)`, r === null && Date.now() - t0 < 1000);
}

(async () => {
	// Every child process starts now, together; assertions read them in order.
	const MUTANT = {
		noLimit: OCR_SRC.replace(/\tif \(size\.width \* size\.height > RECEIPT_OCR_MAX_PIXELS\) \{\n[^\n]*\n\t\}\n/, ""),
		noKill: OCR_SRC.replace('if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");', ""),
		noHeal: OCR_SRC.replace(/\t\t\t\ttry \{ fs\.rmSync\(path\.join\(RECEIPT_OCR_CACHE_DIR, "eng\.traineddata"\)[^\n]*\n/, ""),
		healAlways: OCR_SRC.replace("\t\t\tif (!modelLoaded) {\n", "\t\t\tif (true) {\n"),
	};
	const CHILD_NO_HANDLER = CHILD_SRC.replace(/\t\t\terrorHandler: [^\n]*\n/, "");
	const runs = {
		failures: serverRun(OCR_SRC, "failures"),
		hang: serverRun(OCR_SRC, "hang"),
		limits: serverRun(OCR_SRC, "limits"),
		good: childRun(CHILD_PATH, { image: png(800, 600, "GOOD"), cachePath: path.join(TMP, "child-cache"), langPath: "https://example.invalid/pinned" }),
		fail: childRun(CHILD_PATH, { image: png(800, 600, "FAIL"), cachePath: path.join(TMP, "child-cache") }),
		empty: childRun(CHILD_PATH, {}),
		gone: childRun(CHILD_PATH, { image: png(800, 600, "HANG") }, { disconnectAfterMs: 400 }),
		mNoLimit: MUTANT.noLimit !== OCR_SRC ? serverRun(MUTANT.noLimit, "limits") : null,
		mNoKill: MUTANT.noKill !== OCR_SRC ? serverRun(MUTANT.noKill, "hang") : null,
		mNoHeal: MUTANT.noHeal !== OCR_SRC ? serverRun(MUTANT.noHeal, "failures") : null,
		mHealAlways: MUTANT.healAlways !== OCR_SRC ? serverRun(MUTANT.healAlways, "failures") : null,
		mChildNoHandler: CHILD_SRC && CHILD_NO_HANDLER !== CHILD_SRC
			? childRun(childVariant(CHILD_NO_HANDLER), { image: png(800, 600, "FAIL") }) : null,
	};
	const R = {};
	for (const [k, p] of Object.entries(runs)) R[k] = p ? await p : null;

	// =========================================================================
	console.log("\n§3  end to end — the server process survives every way OCR can go wrong");
	// =========================================================================
	const view = (r) => {
		const o = (r && r.out) || { steps: [], updates: [], logs: [] };
		return {
			o,
			step: (doc) => o.steps.find((x) => x.doc === doc) || {},
			text: (doc) => o.updates.filter((u) => u[1] === doc).map((u) => u[0]),
			logged: (re) => o.logs.some((l) => re.test(l)),
		};
	};
	const survived = (r, what) => ok(`the server process SURVIVES ${what} (exit ${r.code}${r.signal ? `, ${r.signal}` : ""}` +
		`${r.code ? ` — ${r.stderr.slice(0, 140)}` : ""})`, r.code === 0 && !!r.out);

	survived(R.failures, "an OCR engine that crashes or fails");
	const F = view(R.failures);
	ok("every job settles — the queue drains after each",
		F.o.steps.length === 4 && F.o.steps.every((x) => x.drained) && F.o.pending === 0);
	ok("an engine that dies loading its model is logged as a failed job", F.logged(/document 1 \(non-critical\)/));
	ok("...and it clears the cached model, so a damaged copy is fetched again", F.step(1).cacheExists === false);
	ok("the NEXT receipt is still read, and its text lands on ITS row", JSON.stringify(F.text(2)) === JSON.stringify(["SHELL #4.29"]));
	ok("an engine that dies on its IMAGE is logged, and the model is KEPT (no re-download per bad image)",
		F.text(8).length === 0 && F.logged(/document 8 \(non-critical\)/) && F.step(8).cacheExists === true);
	ok("a job that fails cleanly is logged, and the cache is kept",
		F.text(5).length === 0 && F.step(5).cacheExists === true && F.logged(/document 5 .*could not read image/));

	survived(R.hang, "an OCR job that never answers");
	const H = view(R.hang);
	ok("a job that never answers is ended at the deadline, and its process is KILLED",
		H.step(4).drained === true && H.step(4).childrenStarted === 1 && H.step(4).childAlive === false && H.text(4).length === 0);
	ok("...and says so", H.logged(/document 4 .*timed out/));
	ok("...a timeout is not a damaged model: the cache is kept", H.step(4).cacheExists === true);

	survived(R.limits, "the size checks");
	const L = view(R.limits);
	ok("over the pixel limit: the image is NOT OCR'd — no job starts, the row gets no text",
		L.step(3).drained === true && L.step(3).childrenStarted === 0 && L.text(3).length === 0);
	ok("...and the skip is logged with the size", L.logged(/document 3 .*6000x5000 image is over the 25 MP limit/));
	ok("an unreadable header: not OCR'd, and logged", L.step(6).childrenStarted === 0 && L.text(6).length === 0 &&
		L.logged(/document 6 .*could not be read/));
	ok("an ordinary app-sized photo is still read", JSON.stringify(L.text(7)) === JSON.stringify(["SHELL #4.29"]));

	// =========================================================================
	console.log("\n§4  lib/tesseract-ocr-child.js itself, over a fake engine");
	// =========================================================================
	const g = R.good;
	ok("it exists and runs", !g.missing && g.code === 0);
	ok("it answers with the text", !!(g.reply && typeof g.reply.text === "string" && g.reply.text.startsWith("  SHELL #4.29")));
	ok("...having said { ready: true } first, once its model loaded", g.ready === true && g.readyFirst === true);
	ok("...having used the model location it was given",
		!!(g.reply && g.reply.text && g.reply.text.includes(`|cache=${path.join(TMP, "child-cache")}|lang=https://example.invalid/pinned`)));
	ok("...and created the cache directory for it", fs.existsSync(path.join(TMP, "child-cache")));
	const f = R.fail;
	ok("a failed job is REPORTED ({ error }) and the child exits normally — it does not crash",
		!f.missing && f.code === 0 && !!(f.reply && /could not read image/.test(f.reply.error || "")));
	ok("a job without an image is refused cleanly", !R.empty.missing && R.empty.code === 0 && !!(R.empty.reply && /no image/.test(R.empty.reply.error || "")));
	ok(`it exits by itself when the server goes away mid-job (exit ${R.gone.code}, ${R.gone.ms} ms) — no orphan left running`,
		!R.gone.missing && R.gone.code === 0 && R.gone.signal === null && R.gone.reply === null && R.gone.ms < 5000);

	// =========================================================================
	console.log("\n§5  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	ok("(mutant anchors present)", Object.values(MUTANT).every((m) => m !== OCR_SRC) && CHILD_NO_HANDLER !== CHILD_SRC);
	const stepOf = (r, doc) => ((r && r.out && r.out.steps) || []).find((x) => x.doc === doc) || {};
	if (R.mNoLimit) {
		ok("MUTANT without the pixel limit: an over-limit image starts an OCR job — §3 flips",
			stepOf(R.mNoLimit, 3).childrenStarted === 1);
	}
	if (R.mNoKill) {
		ok("MUTANT without the SIGKILL: the hung job's process outlives its deadline — §3 flips",
			stepOf(R.mNoKill, 4).childAlive === true);
	}
	if (R.mNoHeal) {
		ok("MUTANT without clearing the model on a crash: the damaged cache stays — §3 flips",
			stepOf(R.mNoHeal, 1).cacheExists === true);
	}
	if (R.mHealAlways) {
		ok("MUTANT clearing the model on EVERY crash: a bad image forces a re-download — §3 flips",
			stepOf(R.mHealAlways, 8).cacheExists === false);
	}
	if (R.mChildNoHandler) {
		ok(`MUTANT child without errorHandler: a failed job CRASHES the child (exit ${R.mChildNoHandler.code}), no reply — §4 flips`,
			R.mChildNoHandler.code !== 0 && R.mChildNoHandler.reply === null);
	}
	if (receiptImageSize && SIZE_SRC.includes("marker !== 0xc4 && ")) {
		const loose = new Function(`"use strict";\n${SIZE_SRC.replace("marker !== 0xc4 && ", "")}\nreturn receiptImageSize;`)();
		const got = loose(jpeg(APP0, DHT, sof(0xc0, 1024, 768)));
		ok("MUTANT reading DHT as a frame header: wrong dimensions — §2 flips", !(got && got.width === 1024 && got.height === 768));
	} else ok("(DHT anchor present)", false);

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", (err && err.stack) || err);
	process.exit(1);
});
