#!/usr/bin/env node
/**
 * Receipt OCR must not be able to take the server down, or quietly stop.
 *
 * WHY THIS EXISTS. tesseract.js 7.0.0 rejects a failed job's promise and THEN,
 * unless the worker was created with an `errorHandler`, THROWS from the worker's
 * 'message' listener (node_modules/tesseract.js/src/createWorker.js). A throw in
 * an event listener reaches no caller — it is an uncaught exception and the
 * process exits. A crafted 76-byte JPEG passed the upload's image check and
 * pdfkit, the upload answered 200, and then the server died: any driver with a
 * load could do it, and so could a corrupt photo. Separately, a worker whose
 * language download never completes never settles createWorker() at all, which
 * parks the one-at-a-time OCR queue — and all receipt OCR — until a restart.
 *
 * HOW. The REAL tesseract.js createWorker() runs — its listener is exactly the
 * code under test — over a FAKE transport installed in require.cache in place of
 * tesseract.js/src/worker/node: no worker thread, no wasm, no network, no
 * language data. Each scenario runs in a CHILD process, because the failure
 * being tested is the process dying: an uncaught throw in this runner would take
 * the runner down with it and prove nothing.
 *
 *   §1 static: errorHandler passed; terminate in finally; a deadline on both steps
 *   §2 a job that FAILS through the listener: the process survives, the failure is
 *      logged, the NEXT receipt is still read, and every worker is terminated
 *   §3 a worker start that never settles: the queue drains at the deadline, OCR
 *      pauses rather than start (and leak) a worker per receipt, then resumes
 *   §4 a worker that finishes starting AFTER its deadline is terminated on arrival
 *   §5 DISCRIMINATION — remove each protective clause, require an assertion to flip
 *
 * The lifting is tolerant on purpose, so this runner FAILS on the pre-fix code
 * for the real reason (the child process dies in §2, wedges in §3) instead of
 * merely failing to find a name.
 *
 * Pure: no server, no app.db, no network. Run: node scripts/test-receipt-ocr-crash.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(REPO, "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
// Brace-count a function out of server.js, starting at its BODY (the parameter
// list is paren-matched first). Keeps a leading `async `. Returns "" if absent.
function liftFn(name) {
	const at = SRC.indexOf(`\nfunction ${name}(`) + 1 || SRC.indexOf(`\nasync function ${name}(`) + 1;
	if (!at) return "";
	let a = SRC.indexOf(`function ${name}(`, at - 1);
	if (SRC.slice(a - 6, a) === "async ") a -= 6;
	let p = SRC.indexOf("(", SRC.indexOf(`function ${name}(`, a));
	for (let d = 0; p < SRC.length; p++) {
		if (SRC[p] === "(") d++;
		else if (SRC[p] === ")" && --d === 0) break;
	}
	let depth = 0, seen = false;
	for (let i = SRC.indexOf("{", p); i < SRC.length; i++) {
		if (SRC[i] === "{") { depth++; seen = true; }
		else if (SRC[i] === "}") { depth--; if (seen && depth === 0) return SRC.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
const EXTRACT_SRC = liftFn("extractReceiptText");
const QUEUE_SRC = liftFn("queueReceiptOcr");
const DEADLINE_SRC = liftFn("receiptOcrDeadline");
// Every module-level constant / state line of the OCR queue, whatever exists.
// ⚠️ A declaration may carry a trailing `// comment` after its `;` — anchoring
// on `;$` silently drops those lines, and the lifted code then dies on a
// ReferenceError that looks exactly like the failure being tested.
const STATE_SRC = (SRC.match(/^(?:const|let) (?:RECEIPT_OCR_[A-Z_]+|receiptOcr[A-Za-z]+) = [^\n;]+;[^\n]*$/gm) || []).join("\n");
if (!EXTRACT_SRC || !QUEUE_SRC) {
	console.error("FAIL  could not locate extractReceiptText / queueReceiptOcr in server.js");
	process.exit(1);
}
const OCR_SRC = [STATE_SRC, DEADLINE_SRC, EXTRACT_SRC, QUEUE_SRC].filter(Boolean).join("\n\n");
// Scale the production timings down to test size. The margins are deliberate:
// §3's second receipt must land INSIDE the 800 ms pause (it runs within a few ms
// of the first draining) and the third AFTER it (a 900 ms wait) — a timer never
// fires early, so load on a shared CI runner can only widen the second gap.
const fast = (src) => src
	.replace(/const RECEIPT_OCR_TIMEOUT_MS = [^;]+;/, "const RECEIPT_OCR_TIMEOUT_MS = 150;")
	.replace(/const RECEIPT_OCR_BACKOFF_MS = [^;]+;/, "const RECEIPT_OCR_BACKOFF_MS = 800;");

// --- the child process ------------------------------------------------------
// Runs the lifted OCR code over the real createWorker() and a fake transport.
// `plan` scripts each fake worker by spawn order; a BAD image fails to decode.
const CHILD = String.raw`
"use strict";
const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
const path = require("path");
const Module = require("module");
const repoRequire = Module.createRequire(path.join(cfg.repo, "package.json"));
const nodeDir = path.join(path.dirname(repoRequire.resolve("tesseract.js")), "worker", "node");
const transportPath = path.join(nodeDir, "index.js");
const state = { spawned: 0, terminated: [] };
function respond(w, packet) {
	const { workerId, jobId, action, payload } = packet;
	const plan = cfg.plan[String(w.n)] || {};
	if (plan.hang === action) return;                        // never answers
	const delay = (plan.delay && plan.delay[action]) || 0;
	setTimeout(() => {
		if (w.dead) return;
		let status = "resolve", data = {};
		if (action === "recognize") {
			if (Buffer.from(payload.image).toString() === "BAD") {
				status = "reject"; data = "Error: Error attempting to read image.";
			} else data = { text: "  SHELL #4.29 \n" };
		}
		w.handler({ workerId, jobId, action, status, data });   // tesseract.js's REAL listener
	}, delay);
}
const fake = {
	defaultOptions: require(path.join(nodeDir, "defaultOptions.js")),
	spawnWorker: () => ({ n: ++state.spawned, handler: null, dead: false }),
	onMessage: (w, handler) => { w.handler = handler; },
	send: async (w, packet) => { respond(w, packet); },
	terminateWorker: (w) => { w.dead = true; state.terminated.push(w.n); },
	loadImage: async (image) => image,
};
const m = new Module(transportPath);
m.filename = transportPath; m.loaded = true; m.exports = fake;
require.cache[transportPath] = m;

const logs = [];
const quiet = { log() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
const updates = [];
const db = { prepare: (sql) => ({ run: (...args) => { updates.push({ sql, args }); return { changes: 1 }; } }) };
const api = new Function("require", "db", "console",
	'"use strict";\n' + cfg.src + "\nreturn { queueReceiptOcr, pending: () => receiptOcrPending };")(repoRequire, db, quiet);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drained(ms) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (api.pending() === 0) return true;
	return api.pending() === 0;
}
(async () => {
	const steps = [];
	for (const s of cfg.steps) {
		if (s.wait) { await sleep(s.wait); continue; }
		const spawnedBefore = state.spawned;
		api.queueReceiptOcr(s.doc, Buffer.from(s.image));
		steps.push({ doc: s.doc, drained: await drained(s.drain || 2000), spawnedHere: state.spawned - spawnedBefore });
	}
	process.stdout.write("\n@@RESULT@@" + JSON.stringify({
		steps, pending: api.pending(),
		updates: updates.map((u) => u.args), sqls: [...new Set(updates.map((u) => u.sql))],
		spawned: state.spawned, terminated: state.terminated.slice().sort((a, b) => a - b), logs,
	}) + "\n");
	process.exit(0);
})();
`;

// Each scenario is its own child process, and they run CONCURRENTLY: nothing is
// shared between them, and within a child the steps stay strictly sequential.
function run(src, plan, steps) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", CHILD], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
		child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
		const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("close", (code, signal) => {
			clearTimeout(killer);
			const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
			resolve({
				code,
				signal,
				// Whole stderr: a crash prints the error FIRST and stack frames after it.
				stderr: stderr.trim().split("\n").filter(Boolean).join(" | "),
				out: line ? JSON.parse(line.slice("@@RESULT@@".length)) : null,
			});
		});
		child.stdin.end(JSON.stringify({ repo: REPO, src: fast(src), plan, steps }));
	});
}
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

// Scenario builders — shared by §2-§4 and the §5 mutants.
const listenerFailure = (src) => run(src, {}, [
	{ doc: 1, image: "BAD" },
	{ doc: 2, image: "GOOD" },
]);
// drain: 1000 — ~7x the 150 ms deadline; also bounds how long the no-deadline
// mutant (which really does wedge) holds the run up.
const stuckStart = (src) => run(src, { 1: { hang: "loadLanguage" } }, [
	{ doc: 11, image: "GOOD", drain: 1000 },
	{ doc: 12, image: "GOOD", drain: 1000 },
	{ wait: 900 },
	{ doc: 13, image: "GOOD", drain: 1000 },
]);
const lateStart = (src) => run(src, { 1: { delay: { initialize: 300 } } }, [
	{ doc: 21, image: "GOOD" },
	{ wait: 600 },
]);

// ===========================================================================
console.log("\n§1  static — the three protections the fix is made of");
// ===========================================================================
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const cw = EXTRACT_SRC.indexOf("createWorker(");
ok("extractReceiptText() creates its worker with createWorker(\"eng\", 1, …)",
	/createWorker\("eng", 1, \{/.test(EXTRACT_SRC));
ok("...passing an errorHandler — without one, tesseract.js THROWS from its message listener",
	cw > -1 && /errorHandler\s*:/.test(EXTRACT_SRC.slice(cw, cw + 300)));
ok("nothing calls Tesseract.recognize() any more (it passes no errorHandler)",
	!/\bTesseract\.recognize\(/.test(codeOnly(SRC)));
ok("the worker is terminated in a finally",
	/finally\s*\{[\s\S]*?worker\.terminate\(\)/.test(EXTRACT_SRC));
ok("a worker that finishes starting late is terminated on arrival",
	/starting\.then\(\(late\) => [^\n]*late\.terminate\(\)/.test(EXTRACT_SRC));
const timeoutMs = Number((SRC.match(/const RECEIPT_OCR_TIMEOUT_MS = ([\d_]+);/) || [])[1]?.replace(/_/g, ""));
ok("RECEIPT_OCR_TIMEOUT_MS is a real, bounded number (0 < t <= 5 min)", timeoutMs > 0 && timeoutMs <= 300_000);
ok("the deadline is a real timer, and it is cleared",
	/setTimeout\(/.test(DEADLINE_SRC) && /clearTimeout\(timer\)/.test(DEADLINE_SRC));
ok("BOTH steps run under it — the start AND the recognition",
	/receiptOcrDeadline\(starting, /.test(EXTRACT_SRC) && /receiptOcrDeadline\(worker\.recognize\(/.test(EXTRACT_SRC));
ok("a failed start pauses OCR (RECEIPT_OCR_BACKOFF_MS) instead of retrying every receipt",
	/receiptOcrPausedUntil = Date\.now\(\) \+ RECEIPT_OCR_BACKOFF_MS;/.test(EXTRACT_SRC) &&
	/if \(Date\.now\(\) < receiptOcrPausedUntil\)/.test(EXTRACT_SRC));


// Every scenario and mutant child starts NOW, together; assertions below read
// their results in order, so the output reads exactly as if they ran in series.
function mutant(find, replace) {
	const m = OCR_SRC.replace(find, replace);
	return m === OCR_SRC ? null : m;
}
const MUTANTS = {
	noHandler: mutant(/\t\terrorHandler: [^\n]+\n/, ""),
	noFinally: mutant("try { await worker.terminate(); } catch { /* already gone */ }", ""),
	noDeadline: mutant("await receiptOcrDeadline(starting, \"worker start\")", "await starting"),
	noPause: mutant("receiptOcrPausedUntil = Date.now() + RECEIPT_OCR_BACKOFF_MS;", ""),
	noLate: mutant(/\t\t\tstarting\.then\(\(late\) => [^\n]+\n/, ""),
};
const RUNS = {
	a: listenerFailure(OCR_SRC),
	b: stuckStart(OCR_SRC),
	c: lateStart(OCR_SRC),
	noHandler: MUTANTS.noHandler && listenerFailure(MUTANTS.noHandler),
	noFinally: MUTANTS.noFinally && listenerFailure(MUTANTS.noFinally),
	noDeadline: MUTANTS.noDeadline && stuckStart(MUTANTS.noDeadline),
	noPause: MUTANTS.noPause && stuckStart(MUTANTS.noPause),
	noLate: MUTANTS.noLate && lateStart(MUTANTS.noLate),
};

(async () => {
	const R = {};
	for (const [k, p] of Object.entries(RUNS)) R[k] = p ? await p : null;

	// =========================================================================
	console.log("\n§2  a job that fails through tesseract.js's listener");
	// =========================================================================
	const a = R.a;
	ok(`the process SURVIVES a failed recognition (exit ${a.code}${a.signal ? `, ${a.signal}` : ""}` +
		`${a.code ? ` — ${a.stderr.slice(0, 160)}` : ""})`, a.code === 0 && !!a.out);
	const A = a.out || { steps: [], updates: [], sqls: [], logs: [], terminated: [] };
	ok("the queue drains", A.steps.length === 2 && A.steps.every((s) => s.drained) && A.pending === 0);
	ok("the NEXT receipt is still read — its text written to ITS row, by primary key",
		JSON.stringify(A.updates) === JSON.stringify([["SHELL #4.29", 2]]) &&
		A.sqls.length === 1 && A.sqls[0] === "UPDATE documents SET ocr_text = ? WHERE id = ?");
	ok("the failure is logged, non-critically, with tesseract's own message",
		A.logs.some((l) => /deferred receipt OCR failed for document 1 \(non-critical\).*attempting to read image/.test(l)));
	ok("every worker started was terminated — the failed one included",
		A.spawned === 2 && JSON.stringify(A.terminated) === JSON.stringify(range(A.spawned)));

	// =========================================================================
	console.log("\n§3  a worker start that never settles (a stuck language download)");
	// =========================================================================
	const b = R.b;
	const B = b.out || { steps: [{}, {}, {}], updates: [], logs: [], terminated: [] };
	ok(`the process survives (exit ${b.code}${b.signal ? `, ${b.signal}` : ""})`, b.code === 0 && !!b.out);
	ok("the queue does NOT wedge — the stuck receipt clears at the deadline", B.steps[0] && B.steps[0].drained === true);
	ok("...and says why", B.logs.some((l) => /receipt OCR paused for .*worker start timed out/.test(l)));
	ok("while paused, the next receipt starts NO worker (no thread leaked per receipt)",
		B.steps[1] && B.steps[1].drained === true && B.steps[1].spawnedHere === 0 &&
		B.logs.some((l) => /document 12 .*paused/.test(l)));
	ok("after the backoff, OCR resumes by itself — no restart needed",
		B.steps[2] && B.steps[2].drained === true && JSON.stringify(B.updates) === JSON.stringify([["SHELL #4.29", 13]]));
	ok("the resumed worker is terminated too", B.terminated.includes(2));

	// =========================================================================
	console.log("\n§4  a worker that finishes starting after its deadline");
	// =========================================================================
	const c = R.c;
	const C = c.out || { steps: [{}], updates: [], terminated: [] };
	ok(`the process survives (exit ${c.code})`, c.code === 0 && !!c.out);
	ok("the receipt is given up at the deadline, not read by the late worker",
		C.steps[0] && C.steps[0].drained === true && C.updates.length === 0);
	ok("the late worker is terminated the moment it arrives (no idle thread left behind)",
		JSON.stringify(C.terminated) === JSON.stringify([1]));

	// =========================================================================
	console.log("\n§5  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	ok("(mutant anchors present)", Object.values(MUTANTS).every(Boolean));
	if (R.noHandler) {
		ok(`MUTANT without errorHandler: the child process DIES (exit ${R.noHandler.code}) — tesseract.js's listener throw is live`,
			R.noHandler.code !== 0 && /attempting to read image/.test(R.noHandler.stderr));
	}
	if (R.noFinally) {
		ok("MUTANT without terminate-in-finally: workers are left running — §2 flips",
			!!R.noFinally.out && R.noFinally.out.terminated.length < R.noFinally.out.spawned);
	}
	if (R.noDeadline) {
		ok("MUTANT without the start deadline: the queue WEDGES on a stuck start — §3 flips",
			!!R.noDeadline.out && R.noDeadline.out.steps[0].drained === false);
	}
	if (R.noPause) {
		ok("MUTANT without the pause: the next receipt starts another worker — §3 flips",
			!!R.noPause.out && R.noPause.out.steps[1].spawnedHere === 1);
	}
	if (R.noLate) {
		ok("MUTANT without terminate-on-arrival: the late worker is never terminated — §4 flips",
			!!R.noLate.out && R.noLate.out.terminated.length === 0);
	}

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", (err && err.stack) || err);
	process.exit(1);
});
