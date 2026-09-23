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
 *      started with a clean environment, heard from ('error') before anything
 *      else touches it, and killed at the deadline; the pixel limit is checked
 *      when a receipt is queued; the model location is pinned
 *   §2 imageSize() (lib/image-size.js, formerly receiptImageSize() in
 *      server.js): PNG and JPEG headers, malformed input, bounded work
 *   §3 end to end in a stand-in server process: an OCR job that crashes, hangs,
 *      fails cleanly, cannot load its model or answers; a child that cannot be
 *      started at all; images over the limit or unreadable. The server
 *      survives, the queue drains, only the right rows get text, a hung job is
 *      killed, a job that fails loading its model clears the cached model, one
 *      that fails on its image keeps it, and a crash is logged by its error line.
 *      Version-agnostic on purpose: code that runs the engine IN-PROCESS meets a
 *      fake engine transport whose worker fails the way a worker thread does;
 *      code that uses the child meets a stand-in child. Either way, the question
 *      is only whether the server process lives.
 *   §4 the real lib/tesseract-ocr-child.js over a fake engine transport: it
 *      answers, reports a failed job instead of crashing, answers AT ONCE when
 *      its model cannot be loaded, uses the model location it is given, and
 *      exits when the server goes away
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
const STATE_RE = /^(?:const|let) (?:RECEIPT_OCR_(?:TIMEOUT_MS|BACKOFF_MS|MAX_PIXELS|CHILD|CACHE_DIR|LANG_PATH|MAX_PENDING|MAX_QUEUED_BYTES)|receiptOcr(?:Chain|Pending|PausedUntil|QueuedBytes)) = [^\n;]+;[^\n]*$/gm;
const STATE_SRC = (SRC.match(STATE_RE) || []).join("\n");
// The header parser lives in lib/image-size.js. The stand-in server gets the
// same binding server.js uses — the require line itself, lifted — so the queue
// runs against the shipped parser, not a copy of it.
const IMAGE_LIB_PATH = path.join(REPO, "lib", "image-size.js");
const IMAGE_LIB_SRC = fs.existsSync(IMAGE_LIB_PATH) ? fs.readFileSync(IMAGE_LIB_PATH, "utf8") : "";
const SIZE_SRC = IMAGE_LIB_SRC ? liftFn("imageSize", IMAGE_LIB_SRC) : "";
const SIZE_BINDING_SRC = (SRC.match(/^const imageLimits = require\("\.\/lib\/image-size"\);$/m) || [""])[0];
const SKIP_SRC = liftFn("receiptOcrSkipReason");
const CLEAR_SRC = liftFn("clearReceiptOcrModel");
const EXTRACT_SRC = liftFn("extractReceiptText");
const RUN_SRC = liftFn("runReceiptOcrChild");
const QUEUE_SRC = liftFn("queueReceiptOcr");
const DEADLINE_SRC = liftFn("receiptOcrDeadline");   // older in-process design, if present
if (!EXTRACT_SRC || !QUEUE_SRC) {
	console.error("FAIL  could not locate extractReceiptText / queueReceiptOcr in server.js");
	process.exit(1);
}
const OCR_SRC = [STATE_SRC, SIZE_BINDING_SRC, SKIP_SRC, CLEAR_SRC, DEADLINE_SRC, RUN_SRC, EXTRACT_SRC, QUEUE_SRC].filter(Boolean).join("\n\n");

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
		let status = "resolve", data = {};
		if (action === "loadLanguage") {
			seen.cachePath = payload.options.cachePath; seen.langPath = payload.options.langPath;
			// The model cannot be fetched: the engine rejects this step, and createWorker()
			// itself never settles — it swallows the rejection.
			if (String(seen.langPath).includes("MODELFAIL")) { status = "reject"; data = "Error: the model could not be fetched"; }
		}
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
	if (img.includes("MODELFAIL")) { process.send({ error: "could not load the model" }, () => process.exit(0)); return; }
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
// What fork() hands back when the child cannot be started for lack of file
// descriptors: no pid, no stdio streams, no IPC channel — then 'error' and
// 'close' on the next tick. kill() on it is counted: it must never be called.
const cp = require("child_process"), realFork = cp.fork;
let kills = 0;
function failedSpawn(code) {
	const { EventEmitter } = require("events");
	const child = Object.assign(new EventEmitter(), {
		pid: undefined, stdin: null, stdout: null, stderr: null, stdio: [null, null, null, null],
		connected: false, exitCode: null, signalCode: null, killed: false,
		kill() { kills++; return false; },
	});
	process.nextTick(() => {
		child.exitCode = -24;
		child.emit("error", Object.assign(new Error("spawn " + process.execPath + " " + code), { code, errno: -24, syscall: "spawn" }));
		child.emit("close", -24, null);
	});
	return child;
}
(async () => {
	const steps = [];
	for (const s of cfg.steps) {
		if (s.seedCache) { fs.mkdirSync(cfg.cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, "model"); }
		if (s.spawnFails) cp.fork = () => failedSpawn(s.spawnFails);
		kills = 0;
		const before = spawned();
		const queued = api.queueReceiptOcr(s.doc, Buffer.from(s.image, "base64"));
		const pendingAfterQueue = api.pending();
		let drained = false;
		for (const end = Date.now() + s.drain; Date.now() < end; await sleep(5)) if (api.pending() === 0) { drained = true; break; }
		cp.fork = realFork;
		const mine = spawned().filter((p) => !before.includes(p));
		let stillAlive = false;
		for (const pid of mine) {
			for (let t = 0; t < 100 && alive(pid); t++) await sleep(10);   // reaping is asynchronous
			if (alive(pid)) { stillAlive = true; try { process.kill(pid, "SIGKILL"); } catch {} }
		}
		steps.push({ doc: s.doc, queued, pendingAfterQueue, drained, kills, childrenStarted: mine.length, childAlive: stillAlive,
			cacheExists: fs.existsSync(cacheFile) });
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
		{ doc: 9, image: b64(png(800, 600, "MODELFAIL")), drain: 10000, seedCache: true },   // reports it cannot load its model
	] },
	hang: { timeoutMs: 1500, steps: [
		{ doc: 4, image: b64(png(800, 600, "HANG")), drain: 8000, seedCache: true },    // never answers
	] },
	spawn: { timeoutMs: 8000, steps: [
		{ doc: 10, image: b64(png(800, 600, "GOOD")), drain: 5000, seedCache: true, spawnFails: "EMFILE" },   // cannot start
		{ doc: 11, image: b64(png(800, 600, "GOOD")), drain: 10000 },                                       // the next one can
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
function childRun(childPath, job, { disconnectAfterMs = null, killAfterMs = 10_000 } = {}) {
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
		const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
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
// A mutated copy of the child, written to TMP — never into the repo. It loads the
// engine by absolute path, so it gets the same module (and the fake transport)
// the real child gets from its place in lib/.
const TESSERACT_REQUIRE = 'require("tesseract.js")';
const TESSERACT_ENTRY = require.resolve("tesseract.js", { paths: [REPO] });
function childVariant(src) {
	const p = path.join(TMP, `child-variant-${++caseNo}.js`);
	fs.writeFileSync(p, src.replace(TESSERACT_REQUIRE, `require(${JSON.stringify(TESSERACT_ENTRY)})`));
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
const RUN_CODE = codeOnly(RUN_SRC);
const errorAt = RUN_CODE.indexOf('child.on("error"');
ok("...and 'error' is heard FIRST, before anything else touches the child " +
	"(a child that could not start reports it on the next tick)",
	errorAt > RUN_CODE.indexOf("child = fork(") &&
	["child.stderr", 'child.on("message"', 'child.on("close"', "child.send(", "setTimeout("]
		.every((s) => RUN_CODE.indexOf(s) > errorAt));
ok("...and its stdio is null-checked: one that never started has no streams",
	!/child\.std(?:in|out)\b/.test(RUN_CODE) && RUN_CODE.indexOf("if (child.stderr) {") > -1 &&
	RUN_CODE.indexOf("child.stderr.") > RUN_CODE.indexOf("if (child.stderr) {"));
ok("...under a deadline, and the child is SIGKILLed whenever the job settles — only if it ever started (has a pid)",
	/setTimeout\(\(\) => finish\(new Error\(`receipt OCR timed out/.test(RUN_SRC) &&
	/typeof child\.pid === "number" && child\.exitCode === null && child\.signalCode === null\) \{\s*try \{ child\.kill\("SIGKILL"\);/.test(RUN_SRC));
const closeAt = RUN_SRC.indexOf('child.on("close"');
ok("a silent exit deletes the cached model SYNCHRONOUSLY and BEFORE the job settles " +
	"(the queue starts the next job the moment this one settles)",
	/function clearReceiptOcrModel\(\) \{\s*try \{ fs\.rmSync\(/.test(CLEAR_SRC) &&
	closeAt > -1 && RUN_SRC.indexOf("clearReceiptOcrModel()", closeAt) > closeAt &&
	RUN_SRC.indexOf("clearReceiptOcrModel()", closeAt) < RUN_SRC.indexOf("finish(new Error(`receipt OCR process exited", closeAt));
ok("...but only when the job failed BEFORE its model loaded — failing on an image keeps the model",
	(RUN_SRC.match(/if \(!modelLoaded\) clearReceiptOcrModel\(\);/g) || []).length === 2 &&
	/if \(msg && msg\.ready === true\) \{ modelLoaded = true; return; \}/.test(RUN_SRC));
const maxPx = Number(((SRC.match(/const RECEIPT_OCR_MAX_PIXELS = ([\d_]+);/) || [])[1] || "").replace(/_/g, ""));
ok("RECEIPT_OCR_MAX_PIXELS is a real bound (0 < limit <= 50 MP)", maxPx > 0 && maxPx <= 50_000_000);
ok("the pixel limit is checked when a receipt is QUEUED — an image that would be skipped never waits in memory",
	SKIP_SRC.indexOf("imageLimits.imageSize(") > -1 && SKIP_SRC.indexOf("RECEIPT_OCR_MAX_PIXELS") > -1 &&
	QUEUE_SRC.indexOf("receiptOcrSkipReason(") > -1 &&
	QUEUE_SRC.indexOf("receiptOcrSkipReason(") < QUEUE_SRC.indexOf("receiptOcrChain = "));
ok("...and again before any child starts, for any other caller",
	EXTRACT_SRC.indexOf("receiptOcrSkipReason(") > -1 &&
	EXTRACT_SRC.indexOf("receiptOcrSkipReason(") < EXTRACT_SRC.indexOf("runReceiptOcrChild("));
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
console.log("\n§2  imageSize() (lib/image-size.js) — dimensions from the header alone");
// ===========================================================================
// The name below is kept from when this parser lived in server.js as
// receiptImageSize(); every assertion runs against the module's own export.
const receiptImageSize = IMAGE_LIB_SRC ? require(IMAGE_LIB_PATH).imageSize : null;
ok("imageSize() is exported by lib/image-size.js", typeof receiptImageSize === "function");
ok("server.js binds that module and keeps no parser of its own",
	!!SIZE_BINDING_SRC && !/\nfunction receiptImageSize\(/.test(SRC) && !/getJpegDimensions|getPngDimensions/.test(SRC));
ok("the source the mutants below edit IS the exported function",
	!!receiptImageSize && !!SIZE_SRC && receiptImageSize.toString() === SIZE_SRC);
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
	const HEAL_ON_EARLY_ERROR = "\t\t\tif (!modelLoaded) clearReceiptOcrModel();\n\t\t\tfinish(new Error(`receipt OCR failed:";
	const MUTANT = {
		noLimit: OCR_SRC.replace(/\tif \(size\.width \* size\.height > RECEIPT_OCR_MAX_PIXELS\) \{\n[^\n]*\n\t\}\n/, ""),
		noQueueCheck: OCR_SRC.replace(/\tconst skip = receiptOcrSkipReason\(imageBuffer\);\n\tif \(skip\) \{\n\t\tconsole\.warn\([^\n]*\n\t\treturn false;\n\t\}\n/, ""),
		noKill: OCR_SRC.replace('try { child.kill("SIGKILL"); } catch { /* already gone */ }', ""),
		noHeal: OCR_SRC.replace(/(function clearReceiptOcrModel\(\) \{\n)\ttry \{ fs\.rmSync\([^\n]*\n/, "$1"),
		noEarlyHeal: OCR_SRC.replace(HEAL_ON_EARLY_ERROR, "\t\t\tfinish(new Error(`receipt OCR failed:"),
		healAlways: OCR_SRC.replace(/if \(!modelLoaded\) clearReceiptOcrModel\(\);/g, "clearReceiptOcrModel();"),
		noErrorListener: OCR_SRC.replace('\t\tchild.on("error", (err) => finish(err));\n', ""),
		noStdioGuard: OCR_SRC.replace("\t\tif (child.stderr) {\n", "\t\tif (true) {\n"),
		lastLine: OCR_SRC.replace(/\.find\(\(l\) => \/[^\n]*?\/\.test\(l\)\)/, ".filter(Boolean).pop()"),
	};
	const CHILD_NO_HANDLER = CHILD_SRC.replace(/\t\t\terrorHandler: [^\n]*\n/, "");
	const CHILD_SILENT_HANDLER = CHILD_SRC.replace(/(\t\t\terrorHandler: )[^\n]*\n/, "$1() => {},\n");
	const MODELFAIL_JOB = { image: png(800, 600, "GOOD"), cachePath: path.join(TMP, "child-cache-mf"), langPath: "https://example.invalid/MODELFAIL" };
	const runs = {
		failures: serverRun(OCR_SRC, "failures"),
		hang: serverRun(OCR_SRC, "hang"),
		limits: serverRun(OCR_SRC, "limits"),
		spawn: serverRun(OCR_SRC, "spawn"),
		good: childRun(CHILD_PATH, { image: png(800, 600, "GOOD"), cachePath: path.join(TMP, "child-cache"), langPath: "https://example.invalid/pinned" }),
		fail: childRun(CHILD_PATH, { image: png(800, 600, "FAIL"), cachePath: path.join(TMP, "child-cache") }),
		modelFail: childRun(CHILD_PATH, MODELFAIL_JOB, { killAfterMs: 5000 }),
		empty: childRun(CHILD_PATH, {}),
		gone: childRun(CHILD_PATH, { image: png(800, 600, "HANG") }, { disconnectAfterMs: 400 }),
		mNoLimit: MUTANT.noLimit !== OCR_SRC ? serverRun(MUTANT.noLimit, "limits") : null,
		mNoQueueCheck: MUTANT.noQueueCheck !== OCR_SRC ? serverRun(MUTANT.noQueueCheck, "limits") : null,
		mNoKill: MUTANT.noKill !== OCR_SRC ? serverRun(MUTANT.noKill, "hang") : null,
		mNoHeal: MUTANT.noHeal !== OCR_SRC ? serverRun(MUTANT.noHeal, "failures") : null,
		mNoEarlyHeal: MUTANT.noEarlyHeal !== OCR_SRC ? serverRun(MUTANT.noEarlyHeal, "failures") : null,
		mHealAlways: MUTANT.healAlways !== OCR_SRC ? serverRun(MUTANT.healAlways, "failures") : null,
		mNoErrorListener: MUTANT.noErrorListener !== OCR_SRC ? serverRun(MUTANT.noErrorListener, "spawn") : null,
		mNoStdioGuard: MUTANT.noStdioGuard !== OCR_SRC ? serverRun(MUTANT.noStdioGuard, "spawn") : null,
		mLastLine: MUTANT.lastLine !== OCR_SRC ? serverRun(MUTANT.lastLine, "failures") : null,
		mChildNoHandler: CHILD_SRC && CHILD_NO_HANDLER !== CHILD_SRC
			? childRun(childVariant(CHILD_NO_HANDLER), { image: png(800, 600, "FAIL") }) : null,
		mChildSilentHandler: CHILD_SRC && CHILD_SILENT_HANDLER !== CHILD_SRC
			? childRun(childVariant(CHILD_SILENT_HANDLER), MODELFAIL_JOB, { killAfterMs: 2500 }) : null,
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
		F.o.steps.length === 5 && F.o.steps.every((x) => x.drained) && F.o.pending === 0);
	ok("an engine that dies loading its model is logged as a failed job, BY ITS ERROR LINE",
		F.logged(/document 1 \(non-critical\): receipt OCR process exited \(code \d+\): Error: OCR engine failed to start$/));
	ok("...and it clears the cached model, so a damaged copy is fetched again", F.step(1).cacheExists === false);
	ok("the NEXT receipt is still read, and its text lands on ITS row", JSON.stringify(F.text(2)) === JSON.stringify(["SHELL #4.29"]));
	ok("an engine that dies on its IMAGE is logged, and the model is KEPT (no re-download per bad image)",
		F.text(8).length === 0 && F.logged(/document 8 \(non-critical\)/) && F.step(8).cacheExists === true);
	ok("...a crash is logged by the line that names it, not the runtime's closing version banner",
		F.logged(/document 8 \(non-critical\): receipt OCR process exited \(code \d+\): Error: OCR engine failed$/) &&
		!F.logged(/Node\.js v\d/));
	ok("a job that fails cleanly is logged, and the cache is kept",
		F.text(5).length === 0 && F.step(5).cacheExists === true && F.logged(/document 5 .*could not read image/));
	ok("a job that REPORTS it cannot load its model is logged, and that clears the cached model too",
		F.text(9).length === 0 && F.logged(/document 9 .*could not load the model/) && F.step(9).cacheExists === false);

	survived(R.hang, "an OCR job that never answers");
	const H = view(R.hang);
	ok("a job that never answers is ended at the deadline, and its process is KILLED",
		H.step(4).drained === true && H.step(4).childrenStarted === 1 && H.step(4).childAlive === false && H.text(4).length === 0);
	ok("...and says so", H.logged(/document 4 .*timed out/));
	ok("...a timeout is not a damaged model: the cache is kept", H.step(4).cacheExists === true);

	survived(R.spawn, "an OCR process that cannot be started (no file descriptors left)");
	const S = view(R.spawn);
	ok("...the job settles as failed, with the start error, and nothing is written",
		S.step(10).drained === true && S.text(10).length === 0 && S.logged(/document 10 \(non-critical\): spawn .* EMFILE$/));
	ok("...the never-started child is not signalled (it has no pid), and the model is kept",
		S.step(10).kills === 0 && S.step(10).cacheExists === true);
	ok("...and the next receipt is still read", JSON.stringify(S.text(11)) === JSON.stringify(["SHELL #4.29"]) && S.o.pending === 0);

	survived(R.limits, "the size checks");
	const L = view(R.limits);
	ok("over the pixel limit: refused when QUEUED — never held in memory, no job starts, the row gets no text",
		L.step(3).queued === false && L.step(3).pendingAfterQueue === 0 && L.step(3).childrenStarted === 0 && L.text(3).length === 0);
	ok("...and the skip is logged with the size",
		L.logged(/receipt OCR skipped for document 3: 6000x5000 image is over the 25 MP limit/));
	ok("an unreadable header: refused when queued, and logged",
		L.step(6).queued === false && L.step(6).pendingAfterQueue === 0 && L.step(6).childrenStarted === 0 &&
		L.text(6).length === 0 && L.logged(/receipt OCR skipped for document 6: image dimensions could not be read/));
	ok("an ordinary app-sized photo is queued and read",
		L.step(7).queued === true && JSON.stringify(L.text(7)) === JSON.stringify(["SHELL #4.29"]));

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
	const mf = R.modelFail;
	ok(`a model that cannot be loaded is reported AT ONCE, without waiting out the deadline (${mf.ms} ms)`,
		!mf.missing && mf.code === 0 && mf.signal === null && !!(mf.reply && /model could not be fetched/.test(mf.reply.error || "")));
	ok("...and before any { ready: true } — so the server knows it was the model that failed", mf.ready === false);
	ok("a job without an image is refused cleanly", !R.empty.missing && R.empty.code === 0 && !!(R.empty.reply && /no image/.test(R.empty.reply.error || "")));
	ok(`it exits by itself when the server goes away mid-job (exit ${R.gone.code}, ${R.gone.ms} ms) — no orphan left running`,
		!R.gone.missing && R.gone.code === 0 && R.gone.signal === null && R.gone.reply === null && R.gone.ms < 5000);

	// =========================================================================
	console.log("\n§5  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	ok("(mutant anchors present)", Object.values(MUTANT).every((m) => m !== OCR_SRC) &&
		CHILD_NO_HANDLER !== CHILD_SRC && CHILD_SILENT_HANDLER !== CHILD_SRC && CHILD_SRC.includes(TESSERACT_REQUIRE));
	const stepOf = (r, doc) => ((r && r.out && r.out.steps) || []).find((x) => x.doc === doc) || {};
	const logsOf = (r) => (r && r.out && r.out.logs) || [];
	if (R.mNoLimit) {
		ok("MUTANT without the pixel limit: an over-limit image starts an OCR job — §3 flips",
			stepOf(R.mNoLimit, 3).childrenStarted === 1);
	}
	if (R.mNoQueueCheck) {
		ok("MUTANT checking size only when the job runs: an over-limit image is queued and held — §3 flips",
			stepOf(R.mNoQueueCheck, 3).queued === true && stepOf(R.mNoQueueCheck, 3).pendingAfterQueue === 1);
	}
	if (R.mNoKill) {
		ok("MUTANT without the SIGKILL: the hung job's process outlives its deadline — §3 flips",
			stepOf(R.mNoKill, 4).childAlive === true);
	}
	if (R.mNoHeal) {
		ok("MUTANT without clearing the model: the damaged cache stays, on a crash and on a report — §3 flips",
			stepOf(R.mNoHeal, 1).cacheExists === true && stepOf(R.mNoHeal, 9).cacheExists === true);
	}
	if (R.mNoEarlyHeal) {
		ok("MUTANT clearing the model only on a crash: a REPORTED model failure keeps the damaged cache — §3 flips",
			stepOf(R.mNoEarlyHeal, 9).cacheExists === true);
	}
	if (R.mHealAlways) {
		ok("MUTANT clearing the model on EVERY failure: a bad image forces a re-download — §3 flips",
			stepOf(R.mHealAlways, 8).cacheExists === false && stepOf(R.mHealAlways, 5).cacheExists === false);
	}
	if (R.mNoErrorListener) {
		ok(`MUTANT without the 'error' listener: a child that cannot start takes the SERVER down (exit ${R.mNoErrorListener.code}) — §3 flips`,
			R.mNoErrorListener.code !== 0 && !R.mNoErrorListener.out);
	}
	if (R.mNoStdioGuard) {
		ok("MUTANT reading stderr without the null check: the start error is lost behind a TypeError — §3 flips",
			R.mNoStdioGuard.code === 0 &&
			logsOf(R.mNoStdioGuard).some((l) => /document 10 \(non-critical\): Cannot read properties of null/.test(l)) &&
			!logsOf(R.mNoStdioGuard).some((l) => /document 10 \(non-critical\): spawn .* EMFILE$/.test(l)));
	}
	if (R.mLastLine) {
		ok("MUTANT logging the LAST stderr line: a crash is reported as the runtime's version banner — §3 flips",
			logsOf(R.mLastLine).some((l) => /document 8 .*: Node\.js v\d/.test(l)));
	}
	if (R.mChildNoHandler) {
		ok(`MUTANT child without errorHandler: a failed job CRASHES the child (exit ${R.mChildNoHandler.code}), no reply — §4 flips`,
			R.mChildNoHandler.code !== 0 && R.mChildNoHandler.reply === null);
	}
	if (R.mChildSilentHandler) {
		ok(`MUTANT child whose errorHandler stays silent: a model that cannot load leaves the job waiting until it is killed (${R.mChildSilentHandler.signal}) — §4 flips`,
			R.mChildSilentHandler.reply === null && R.mChildSilentHandler.signal === "SIGKILL");
	}
	ok("no mutated copy of the child was written into the repo",
		!fs.readdirSync(path.join(REPO, "lib")).some((n) => /variant/.test(n)));
	if (receiptImageSize && SIZE_SRC.includes("marker !== 0xc4 && ")) {
		const loose = new Function(`"use strict";\n${SIZE_SRC.replace("marker !== 0xc4 && ", "")}\nreturn imageSize;`)();
		const got = loose(jpeg(APP0, DHT, sof(0xc0, 1024, 768)));
		ok("MUTANT reading DHT as a frame header: wrong dimensions — §2 flips", !(got && got.width === 1024 && got.height === 768));
	} else ok("(DHT anchor present)", false);

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", (err && err.stack) || err);
	process.exit(1);
});
