"use strict";
// PDF receipts for the weekly invoice's receipt pages (Personal receipts, R3 v2).
//
// A stored PDF receipt is never put into an invoice as it was uploaded. A child
// process (lib/receipt-pdf-child.js) loads it under limits and writes a new PDF
// that holds only its pages, each drawn as a Form XObject on a Letter page, with
// no actions, links, annotations, forms, attached files, metadata or image EXIF
// (see that file). This process never parses the uploaded bytes itself.
//
// The child, one at a time:
//   - runs under Node's permission model: it may read only its own script and the
//     modules it loads (pdf-lib, its dependencies, lib/image-metadata.js); no child
//     processes, workers or file writes;
//   - gets a 256 MB heap through execArgv and an empty environment, so
//     NODE_OPTIONS cannot change either;
//   - runs as `nobody` when this server runs as root (a failed drop gives the
//     note and is never retried as root);
//   - on Linux, has /proc/<pid>/oom_score_adj set to 1000 before it is sent any
//     bytes, so an out-of-memory kill takes it first;
//   - is killed (SIGKILL) at its deadline.
// The source is checked before any child starts: at most 5 MB, and "%PDF-" in
// its first 1 KB.
//
// selfTest() runs at every start: it forks the child on a built-in fixture and
// logs one line (uid, gid, groups, whether the probe paths are readable: yes/no,
// whether the permission model and the decode cap are in place, and whether the
// fixture came out clean). Both probe paths must be given and exist, or it
// fails (probe_missing); so does an installed pdf-lib other than the pinned
// version (child:pdf_lib_version). Until it passes, and for good once it fails, every
// receipt keeps the note: PDF pages are off until the next restart.
//
// Results are cached under cacheDir, which must not sit under an uploads folder.
// The key is the expense id, a hash of the stored bytes and the sanitizer
// version, so a changed receipt or a new version never reads an old file.
//
// prepare() always resolves, never rejects:
//   { status: "pages", pdf, pages, cached }   a clean PDF of `pages` pages
//   { status: "on_file", reason }             a PDF receipt that keeps the
//                                             "PDF receipt on file" note (refused,
//                                             timed out, crashed, busy, off ...)
//   { status: "unavailable", reason }         no readable PDF receipt (missing,
//                                             not a stored receipt, not a PDF)
//   { status: "on_file", reason: "preparing", ready }  still running past waitMs

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const RECEIPT_PDF_SANITIZER_VERSION = "v1";
const RECEIPT_PDF_PDF_LIB_VERSION = "1.17.1";  // decision 7: the only pdf-lib the child runs with
const RECEIPT_PDF_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
const RECEIPT_PDF_SOURCE_DATA_URI_MAX_LENGTH = Math.ceil(RECEIPT_PDF_SOURCE_MAX_BYTES / 3) * 4 + 64;
const RECEIPT_PDF_HEADER_WINDOW = 1024;
const RECEIPT_PDF_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
const RECEIPT_PDF_MAX_OBJECTS = 10_000;
const RECEIPT_PDF_MAX_SOURCE_PAGES = 50;
const RECEIPT_PDF_MAX_PAGES = 6;              // decision 3: pages copied per receipt
const RECEIPT_PDF_MAX_CONTENT_STREAMS = 256;  // content streams listed on one page
const RECEIPT_PDF_INVOICE_MAX_PAGES = 15;     // decision 3: pages copied per invoice (the merge)
const RECEIPT_PDF_DECODE_STREAM_MAX = 8 * 1024 * 1024;
const RECEIPT_PDF_DECODE_TOTAL_MAX = 32 * 1024 * 1024;
const RECEIPT_PDF_MAX_IMAGE_PIXELS = 40_000_000;  // an image's declared /Width x /Height
const RECEIPT_PDF_PREPARE_TIMEOUT_MS = 10_000;
const RECEIPT_PDF_HEAP_MB = 256;
const RECEIPT_PDF_QUEUE_CAP = 20;
const RECEIPT_PDF_OOM_SCORE_ADJ = 1000;
const RECEIPT_PDF_CHILD = path.join(__dirname, "receipt-pdf-child.js");
const RECEIPTS_URL_PREFIX = "/uploads/expense-receipts/";

const LIMITS = Object.freeze({
	decodeStreamMax: RECEIPT_PDF_DECODE_STREAM_MAX,
	decodeTotalMax: RECEIPT_PDF_DECODE_TOTAL_MAX,
	maxObjects: RECEIPT_PDF_MAX_OBJECTS,
	maxSourcePages: RECEIPT_PDF_MAX_SOURCE_PAGES,
	maxPages: RECEIPT_PDF_MAX_PAGES,
	outputMax: RECEIPT_PDF_OUTPUT_MAX_BYTES,
	maxContentStreams: RECEIPT_PDF_MAX_CONTENT_STREAMS,
	maxImagePixels: RECEIPT_PDF_MAX_IMAGE_PIXELS,
});

const REASON_RE = /^[a-z][a-z0-9_:]{0,48}$/i;
const asBuffer = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);
const onFile = (reason) => ({ status: "on_file", reason });
const unavailable = (reason) => ({ status: "unavailable", reason });
const reasonOf = (r) => (typeof r === "string" && REASON_RE.test(r) ? r : "error");

function receiptPdfCacheName(expenseId, sourceHash, version = RECEIPT_PDF_SANITIZER_VERSION) {
	return `${version}-${Number(expenseId)}-${String(sourceHash).slice(0, 32)}`;
}

function underUploads(dir) {
	return path.resolve(dir).split(path.sep).some((part) => part.toLowerCase() === "uploads");
}

function hasPdfHeader(buf) {
	return Buffer.isBuffer(buf) && buf.subarray(0, RECEIPT_PDF_HEADER_WINDOW).includes("%PDF-", 0, "latin1");
}

// ---------------------------------------------------------------------------
// What the child may read: its script, lib/image-metadata.js, and the package
// folders of pdf-lib and everything it depends on, resolved here.

function packageRootOf(file) {
	const parts = path.resolve(file).split(path.sep);
	const at = parts.lastIndexOf("node_modules");
	if (at < 0 || at + 1 >= parts.length) throw new Error("not inside node_modules");
	const take = parts[at + 1].startsWith("@") ? 3 : 2;
	return parts.slice(0, at + take).join(path.sep) || path.sep;
}

function dependencyClosure(rootDir) {
	const seen = new Set();
	const queue = [rootDir];
	while (queue.length) {
		const dir = queue.shift();
		if (seen.has(dir)) continue;
		if (seen.size >= 32) throw new Error("too many dependencies");
		seen.add(dir);
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		for (const name of Object.keys(pkg.dependencies || {})) {
			const entry = fs.realpathSync(require.resolve(name, { paths: [dir] }));
			queue.push(packageRootOf(entry));
		}
	}
	return [...seen];
}

// Every path is resolved through symlinks: the permission model checks the
// path a file is read at, and the child is started at its real path.
// The child's decode and object caps wrap pdf-lib internals as they are in
// RECEIPT_PDF_PDF_LIB_VERSION (pinned exactly in package.json): any other
// installed version fails the setup, so the self-test fails and pages stay off.
// pdfLibFrom (tests only) is the folder pdf-lib is resolved from.
function childModules(childPath, pdfLibFrom = __dirname) {
	const pdfLibMain = fs.realpathSync(require.resolve("pdf-lib", { paths: [pdfLibFrom] }));
	const pdfLibRoot = packageRootOf(pdfLibMain);
	const pdfLibPkg = JSON.parse(fs.readFileSync(path.join(pdfLibRoot, "package.json"), "utf8"));
	if (pdfLibPkg.name !== "pdf-lib" || pdfLibPkg.version !== RECEIPT_PDF_PDF_LIB_VERSION) {
		throw Object.assign(new Error("receipt pdfs: unexpected pdf-lib version"), { code: "PDF_LIB_VERSION" });
	}
	const decodeStream = fs.realpathSync(path.join(pdfLibRoot, "cjs", "core", "streams", "DecodeStream.js"));
	const imageMetadata = fs.realpathSync(path.join(__dirname, "image-metadata.js"));
	const script = fs.realpathSync(childPath);
	const read = [script, imageMetadata, ...dependencyClosure(pdfLibRoot)];
	return { modules: { pdfLib: pdfLibMain, decodeStream, imageMetadata }, read, script };
}

// The unprivileged account a root server runs the child as: `nobody` from
// /etc/passwd, else 65534. Never uid or gid 0.
function unprivilegedIds(readFile = (p) => fs.readFileSync(p, "utf8")) {
	let uid = 65534;
	let gid = 65534;
	try {
		const line = readFile("/etc/passwd").split("\n").find((l) => l.startsWith("nobody:"));
		const f = line ? line.split(":") : [];
		if (/^\d+$/.test(f[2] || "") && /^\d+$/.test(f[3] || "")) { uid = Number(f[2]); gid = Number(f[3]); }
	} catch { /* keep 65534 */ }
	return uid > 0 && gid > 0 ? { uid, gid } : null;
}

function forkOptions({ childPath, read, runAs }) {
	const opts = {
		cwd: path.dirname(childPath),
		env: {},                                  // nothing from the server's environment, NODE_OPTIONS included
		execArgv: [
			"--permission",
			...read.map((p) => `--allow-fs-read=${p}`),
			`--max-old-space-size=${RECEIPT_PDF_HEAP_MB}`,
		],
		serialization: "advanced",
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	};
	if (runAs) {
		opts.uid = runAs.uid;
		opts.gid = runAs.gid;
	}
	return opts;
}

// ---------------------------------------------------------------------------
// The self-test fixture: a one-page PDF holding a script action, a link, and
// an image whose JPEG carries an EXIF block. Made up; nothing real.

function rawPdf(objects, trailerExtra = "") {
	const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
	let offset = parts[0].length;
	const offsets = [];
	objects.forEach((body, i) => {
		const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
		const tail = Buffer.from("\nendobj\n", "latin1");
		const mid = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
		offsets.push(offset);
		parts.push(head, mid, tail);
		offset += head.length + mid.length + tail.length;
	});
	const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
	parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
	return Buffer.concat(parts);
}

function streamObject(dictBody, data) {
	const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
	return Buffer.concat([Buffer.from(`<< ${dictBody} /Length ${bytes.length} >>\nstream\n`, "latin1"), bytes, Buffer.from("\nendstream", "latin1")]);
}

function jpegSegment(marker, payload) {
	const head = Buffer.alloc(4);
	head[0] = 0xFF; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([head, payload]);
}

// A structurally complete 8x8 greyscale baseline JPEG (marker walk only; the
// pixels are never decoded here), optionally with an EXIF APP1.
function fixtureJpeg({ exif = null } = {}) {
	const app0 = jpegSegment(0xE0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
	const dqt = jpegSegment(0xDB, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
	const sof = jpegSegment(0xC0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]));
	const dht = jpegSegment(0xC4, Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]));
	const dht2 = jpegSegment(0xC4, Buffer.concat([Buffer.from([0x10]), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]));
	const sos = jpegSegment(0xDA, Buffer.from([1, 1, 0, 0, 63, 0]));
	const scan = Buffer.from([0x00, 0x00]);
	const parts = [Buffer.from([0xFF, 0xD8]), app0];
	if (exif) parts.push(jpegSegment(0xE1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exif])));
	parts.push(dqt, sof, dht, dht2, sos, scan, Buffer.from([0xFF, 0xD9]));
	return Buffer.concat(parts);
}

// A TIFF block with one orientation entry (value 6).
function fixtureTiff() {
	const t = Buffer.alloc(26);
	t.write("MM", 0, "latin1"); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8);
	t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(6, 18); t.writeUInt32BE(0, 22);
	return t;
}

function selfTestFixture() {
	const jpeg = fixtureJpeg({ exif: fixtureTiff() });
	return rawPdf([
		"<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject << /Im0 6 0 R >> >> /Annots [7 0 R] /AA << /O 5 0 R >> >>",
		streamObject("", "q 50 0 0 50 10 10 cm /Im0 Do Q 0 0 1 rg 70 10 20 20 re f"),
		"<< /S /JavaScript /JS (void 0) >>",
		streamObject("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", jpeg),
		"<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://example.invalid/) >> >>",
	]);
}

// A one-page PDF whose content inflates past the probe's decode cap.
function selfTestCapProbe(bytes) {
	return rawPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
		streamObject("/Filter /FlateDecode", zlib.deflateSync(Buffer.alloc(bytes, 0x20))),
	]);
}

// The output of the fixture, checked here on its bytes (our own output).
const SELF_TEST_FORBIDDEN = ["/JavaScript", "/JS", "/OpenAction", "/URI", "/Annots", "/AA", "/Link", "Exif\0\0"];
function selfTestOutputClean(pdf) {
	const buf = asBuffer(pdf);
	if (!buf || !hasPdfHeader(buf)) return false;
	return !SELF_TEST_FORBIDDEN.some((s) => buf.includes(s, 0, "latin1"));
}

// ---------------------------------------------------------------------------

function createReceiptPdfService(options = {}) {
	const receiptsDir = path.resolve(String(options.receiptsDir || ""));
	const cacheDir = path.resolve(String(options.cacheDir || ""));
	if (!options.receiptsDir || !options.cacheDir) throw new Error("receipt pdfs: receiptsDir and cacheDir are required");
	if (underUploads(cacheDir)) throw new Error("receipt pdfs: the cache must not sit under an uploads folder");
	const childPath = path.resolve(options.childPath || RECEIPT_PDF_CHILD);
	// The self-test always proves the real child unless a test names another.
	const selfTestChildPath = path.resolve(options.selfTestChildPath || RECEIPT_PDF_CHILD);
	const pdfLibFrom = options.pdfLibFrom ? path.resolve(options.pdfLibFrom) : __dirname;
	const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : RECEIPT_PDF_PREPARE_TIMEOUT_MS;
	const queueCap = Number.isInteger(options.queueCap) && options.queueCap >= 0 ? options.queueCap : RECEIPT_PDF_QUEUE_CAP;
	const version = options.version || RECEIPT_PDF_SANITIZER_VERSION;
	const log = typeof options.log === "function" ? options.log : () => {};
	const trace = typeof options.trace === "function" ? options.trace : null;
	const platform = options.platform || process.platform;
	const isRoot = typeof options.isRoot === "boolean" ? options.isRoot : typeof process.getuid === "function" && process.getuid() === 0;
	const writeOomScoreAdj = typeof options.writeOomScoreAdj === "function"
		? options.writeOomScoreAdj
		: (pid) => fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(RECEIPT_PDF_OOM_SCORE_ADJ));
	const probes = options.probes && typeof options.probes === "object" ? { env: options.probes.env, db: options.probes.db } : {};
	const limits = Object.freeze({ ...LIMITS, ...(options.limits || {}) });

	const waiting = [];
	const inflight = new Map();
	const counters = { forks: 0, running: 0, maxRunning: 0 };
	const resolved = new Map();                   // script -> its modules and read list, resolved once
	let selfTestState = "untested";               // untested | running | passed | failed
	let selfTestRun = null;
	let selfTestReport = null;

	// Who the child runs as: an explicit runAs (tests), else nobody when root.
	function childIdentity() {
		if (options.runAs) return { uid: Number(options.runAs.uid), gid: Number(options.runAs.gid) };
		if (!isRoot) return null;
		return unprivilegedIds() || { invalid: true };
	}

	// One job in its own process. Resolves the child's reply or { ok: false,
	// reason }; settles once, and the child never outlives it.
	function runChild(message, jobTimeoutMs, scriptPath) {
		const { fork } = require("child_process");
		return new Promise((resolve) => {
			let child = null;
			let timer = null;
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (child && typeof child.pid === "number" && child.exitCode === null && child.signalCode === null) {
					try { child.kill("SIGKILL"); } catch { /* already gone */ }
				}
				resolve(result);
			};
			let setup;
			try {
				const runAs = childIdentity();
				if (runAs && runAs.invalid) return finish({ ok: false, reason: "no_unprivileged_user" });
				const { modules, read, script } = resolved.get(scriptPath) || resolved.set(scriptPath, childModules(scriptPath, pdfLibFrom)).get(scriptPath);
				setup = { modules, script, opts: forkOptions({ childPath: script, read, runAs }) };
			} catch (err) {
				return finish({ ok: false, reason: err && err.code === "PDF_LIB_VERSION" ? "pdf_lib_version" : "child_setup" });
			}
			try {
				counters.forks += 1;
				child = fork(setup.script, [], setup.opts);
			} catch (err) {
				// A failed uid drop (EPERM) lands here: the note, never a retry as root.
				return finish({ ok: false, reason: err && err.code === "EPERM" ? "spawn_eperm" : "spawn_failed" });
			}
			// First: a child that could not start reports it here, and an 'error'
			// nobody listens for would end the server.
			child.on("error", () => finish({ ok: false, reason: "spawn_failed" }));
			timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), jobTimeoutMs);
			child.on("message", (msg) => {
				if (trace) trace("message", { pid: child.pid, message: msg });
				finish(msg && typeof msg === "object" ? msg : { ok: false, reason: "no_result" });
			});
			// 'close' follows the last IPC message, so "no answer" is final here.
			child.on("close", () => finish({ ok: false, reason: "crashed" }));
			if (trace) trace("fork", { pid: child.pid });
			if (platform === "linux") {
				try {
					writeOomScoreAdj(child.pid);
				} catch {
					return finish({ ok: false, reason: "oom_adj_failed" });
				}
				if (trace) trace("oom", { pid: child.pid });
			}
			if (typeof child.send !== "function") return finish({ ok: false, reason: "no_ipc" });
			try {
				if (trace) trace("send", { pid: child.pid });
				const jobLimits = message.limitsOverride ? { ...limits, ...message.limitsOverride } : limits;
				child.send({ kind: message.kind, bytes: message.bytes, probes: message.probes, modules: setup.modules, limits: jobLimits }, (err) => {
					if (err) finish({ ok: false, reason: "send_failed" });
				});
			} catch {
				finish({ ok: false, reason: "send_failed" });
			}
		});
	}

	function pump() {
		if (counters.running > 0 || waiting.length === 0) return;
		const job = waiting.shift();
		counters.running += 1;
		counters.maxRunning = Math.max(counters.maxRunning, counters.running);
		runChild(job.message, job.timeoutMs, job.message.kind === "selftest" || job.message.selfTest ? selfTestChildPath : childPath).then((result) => {
			counters.running -= 1;
			job.done(result);
			pump();
		});
	}

	function enqueue(message, jobTimeoutMs = timeoutMs) {
		if (waiting.length >= queueCap && counters.running > 0) return Promise.resolve({ ok: false, reason: "busy" });
		return new Promise((done) => {
			waiting.push({ message, timeoutMs: jobTimeoutMs, done });
			pump();
		});
	}

	// A child's prepare reply, checked: our own bytes, but still bounded.
	function acceptPages(reply) {
		if (!reply || reply.ok !== true) return { error: reasonOf(reply && reply.reason) };
		const pdf = asBuffer(reply.pdf);
		const pages = Number(reply.pages);
		if (!pdf || pdf.length > limits.outputMax || !hasPdfHeader(pdf)) return { error: "bad_output" };
		if (!Number.isInteger(pages) || pages < 1 || pages > limits.maxPages) return { error: "bad_output" };
		return { pdf, pages };
	}

	// ---- self-test ----------------------------------------------------------

	// The child's answer for one probe path. A "no" counts only for a path that
	// exists (checked here, never read): a missing or mistyped path proves nothing.
	async function probeState(answer, probePath) {
		if (answer === "yes") return "yes";
		if (answer === "unset" || typeof probePath !== "string" || !probePath) return "unset";
		if (answer !== "no") return "unknown";
		try {
			await fs.promises.access(probePath, fs.constants.F_OK);
			return "no";
		} catch {
			return "missing";
		}
	}

	async function runSelfTest() {
		const reply = await enqueue({ kind: "selftest", bytes: selfTestFixture(), probes });
		const report = { uid: null, gid: null, groups: [], env: "unknown", db: "unknown", permission: "unknown", hook: "no", fixture: "not_run", cap: "not_run" };
		const problems = [];
		if (reply && reply.ok === true && reply.identity) {
			const id = reply.identity;
			report.uid = Number.isInteger(id.uid) ? id.uid : null;
			report.gid = Number.isInteger(id.gid) ? id.gid : null;
			report.groups = Array.isArray(id.groups) ? id.groups.filter(Number.isInteger).slice(0, 64) : [];
			report.env = await probeState(id.env, probes.env);
			report.db = await probeState(id.db, probes.db);
			report.permission = ["on", "off", "partial"].includes(id.permission) ? id.permission : "unknown";
			report.hook = reply.hook === true ? "yes" : "no";
			const pages = acceptPages(reply.result);
			report.fixture = pages.error ? `refused:${pages.error}` : selfTestOutputClean(pages.pdf) && pages.pages === 1 ? "clean" : "not_clean";
		} else {
			problems.push(`child:${reasonOf(reply && reply.reason)}`);
		}
		if (report.permission !== "on") problems.push("permission");
		for (const [name, state] of [["env", report.env], ["db", report.db]]) {
			if (state === "unset" || state === "missing") {
				if (!problems.includes("probe_missing")) problems.push("probe_missing");
			} else if (state !== "no") {
				problems.push(`${name}_readable`);
			}
		}
		if (report.hook !== "yes") problems.push("decode_hook");
		if (report.fixture !== "clean") problems.push("fixture");
		if (report.uid === null || report.uid === 0 || report.gid === null || report.gid === 0 || report.groups.includes(0)) problems.push("identity");
		// The decode cap, end to end: a page whose content inflates past a small
		// cap must come back refused.
		if (problems.length === 0) {
			const capReply = await enqueue({ kind: "prepare", bytes: selfTestCapProbe(256 * 1024), selfTest: true, limitsOverride: { decodeStreamMax: 64 * 1024, decodeTotalMax: 128 * 1024 } });
			report.cap = capReply && capReply.ok === false && capReply.reason === "decode_cap" ? "refused" : "not_refused";
			if (report.cap !== "refused") problems.push("decode_cap");
		}
		const passed = problems.length === 0;
		const line = `receipt pdf self-test: uid=${report.uid} gid=${report.gid} groups=${report.groups.join(",") || "none"} env_readable=${report.env} db_readable=${report.db} permission=${report.permission} decode_hook=${report.hook} fixture=${report.fixture} decode_cap=${report.cap} -> ${passed ? "pass" : `FAIL (${problems.join(" ")}); PDF receipt pages off until restart`}`;
		log(line);
		selfTestReport = { passed, problems, report, line };
		selfTestState = passed ? "passed" : "failed";
		return selfTestReport;
	}

	function selfTest() {
		if (selfTestState === "passed" || selfTestState === "failed") return Promise.resolve(selfTestReport);
		if (!selfTestRun) {
			selfTestState = "running";
			selfTestRun = runSelfTest().catch(() => {
				selfTestState = "failed";
				selfTestReport = { passed: false, problems: ["error"], report: null, line: "receipt pdf self-test: FAIL (error); PDF receipt pages off until restart" };
				log(selfTestReport.line);
				return selfTestReport;
			});
		}
		return selfTestRun;
	}

	// ---- prepare --------------------------------------------------------------

	// The stored receipt's bytes, or why there are none. photo_data is a path
	// under /uploads/expense-receipts/ or, on old rows, an inline data URI.
	async function readSource(photoData) {
		const p = String(photoData || "");
		if (!p) return unavailable("no receipt");
		let buf;
		if (p.startsWith("data:")) {
			const m = /^data:application\/pdf;base64,/i.exec(p);
			if (!m) return unavailable("not a pdf");
			if (p.length > RECEIPT_PDF_SOURCE_DATA_URI_MAX_LENGTH) return onFile("too_large");
			buf = Buffer.from(p.slice(m[0].length), "base64");
		} else {
			if (!p.startsWith(RECEIPTS_URL_PREFIX)) return unavailable("not a stored receipt");
			const abs = path.join(receiptsDir, path.basename(p));
			if (!abs.startsWith(receiptsDir + path.sep) || !/\.pdf$/i.test(abs)) return unavailable("not a pdf");
			let st;
			try { st = await fs.promises.stat(abs); } catch { return unavailable("missing"); }
			if (!st.isFile()) return unavailable("missing");
			if (st.size > RECEIPT_PDF_SOURCE_MAX_BYTES) return onFile("too_large");
			try { buf = await fs.promises.readFile(abs); } catch { return unavailable("missing"); }
		}
		if (buf.length > RECEIPT_PDF_SOURCE_MAX_BYTES) return onFile("too_large");
		if (!hasPdfHeader(buf)) return onFile("not_pdf");
		return { buf };
	}

	async function readCache(base) {
		let meta;
		let pdf;
		try {
			const raw = await fs.promises.readFile(`${base}.json`, "utf8");
			if (raw.length > 1024) throw new Error("meta");
			meta = JSON.parse(raw);
			pdf = await fs.promises.readFile(`${base}.pdf`);
		} catch {
			return null;
		}
		const ok = meta && Number.isInteger(meta.pages) && meta.pages >= 1 && meta.pages <= limits.maxPages
			&& pdf.length <= limits.outputMax && hasPdfHeader(pdf)
			&& meta.sha256 === crypto.createHash("sha256").update(pdf).digest("hex");
		if (!ok) {
			await Promise.all([fs.promises.rm(`${base}.json`, { force: true }), fs.promises.rm(`${base}.pdf`, { force: true })]).catch(() => {});
			return null;
		}
		return { status: "pages", pdf, pages: meta.pages, cached: true };
	}

	async function writeCache(base, pdf, pages) {
		const tag = `${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
		const meta = JSON.stringify({ pages, sha256: crypto.createHash("sha256").update(pdf).digest("hex") });
		try {
			await fs.promises.mkdir(cacheDir, { recursive: true });
			await fs.promises.writeFile(`${base}.pdf.${tag}`, pdf);
			await fs.promises.rename(`${base}.pdf.${tag}`, `${base}.pdf`);
			await fs.promises.writeFile(`${base}.json.${tag}`, meta);
			await fs.promises.rename(`${base}.json.${tag}`, `${base}.json`);
		} catch {
			await Promise.all([fs.promises.rm(`${base}.pdf.${tag}`, { force: true }), fs.promises.rm(`${base}.json.${tag}`, { force: true })]).catch(() => {});
			log("receipt pdf cache write failed");
		}
	}

	async function produce(id, source) {
		try {
			const base = path.join(cacheDir, receiptPdfCacheName(id, crypto.createHash("sha256").update(source).digest("hex"), version));
			const hit = await readCache(base);
			if (hit) return hit;
			const reply = await enqueue({ kind: "prepare", bytes: source });
			const accepted = acceptPages(reply);
			if (accepted.error) {
				if (accepted.error !== "busy") log(`receipt pdf for expense ${id}: kept on file (${accepted.error})`);
				return onFile(accepted.error);
			}
			await writeCache(base, accepted.pdf, accepted.pages);
			return { status: "pages", pdf: accepted.pdf, pages: accepted.pages, cached: false };
		} catch {
			log(`receipt pdf for expense ${id}: kept on file (error)`);
			return onFile("error");
		}
	}

	async function prepareNow(id, photoData) {
		try {
			const source = await readSource(photoData);
			if (!source.buf) {
				if (source.status === "on_file") log(`receipt pdf for expense ${id}: kept on file (${source.reason})`);
				return source;
			}
			await selfTest();
			if (selfTestState !== "passed") return onFile("disabled");
			const key = `${id}:${crypto.createHash("sha256").update(source.buf).digest("hex")}`;
			let job = inflight.get(key);
			if (!job) {
				job = produce(id, source.buf).finally(() => inflight.delete(key));
				inflight.set(key, job);
			}
			return await job;
		} catch {
			return onFile("error");
		}
	}

	function prepare(input, opts) {
		const { expenseId, photoData } = input || {};
		const { waitMs } = opts || {};
		const id = Number(expenseId);
		if (!Number.isInteger(id) || id <= 0) return Promise.resolve(unavailable("no receipt"));
		const run = prepareNow(id, photoData);
		if (!(waitMs >= 0)) return run;
		let timer = null;
		const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "on_file", reason: "preparing", ready: run }), waitMs); });
		return Promise.race([run.then((r) => { clearTimeout(timer); return r; }), late]);
	}

	return {
		prepare,
		selfTest,
		state: () => selfTestState,
		stats: () => ({ forks: counters.forks, running: counters.running, maxRunning: counters.maxRunning, waiting: waiting.length }),
	};
}

module.exports = {
	RECEIPT_PDF_SANITIZER_VERSION,
	RECEIPT_PDF_PDF_LIB_VERSION,
	RECEIPT_PDF_MAX_IMAGE_PIXELS,
	RECEIPT_PDF_SOURCE_MAX_BYTES,
	RECEIPT_PDF_OUTPUT_MAX_BYTES,
	RECEIPT_PDF_MAX_OBJECTS,
	RECEIPT_PDF_MAX_SOURCE_PAGES,
	RECEIPT_PDF_MAX_PAGES,
	RECEIPT_PDF_MAX_CONTENT_STREAMS,
	RECEIPT_PDF_INVOICE_MAX_PAGES,
	RECEIPT_PDF_DECODE_STREAM_MAX,
	RECEIPT_PDF_DECODE_TOTAL_MAX,
	RECEIPT_PDF_PREPARE_TIMEOUT_MS,
	RECEIPT_PDF_HEAP_MB,
	RECEIPT_PDF_QUEUE_CAP,
	RECEIPT_PDF_OOM_SCORE_ADJ,
	receiptPdfCacheName,
	createReceiptPdfService,
	unprivilegedIds,
	forkOptions,
	childModules,
	// For the runner's made-up fixtures.
	rawPdf,
	streamObject,
	fixtureJpeg,
	fixtureTiff,
	selfTestFixture,
};
