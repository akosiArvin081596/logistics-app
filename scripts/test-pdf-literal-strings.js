#!/usr/bin/env node
/**
 * harvestPdfStrings() in lib/broker-invoice.js: the PDF literal strings
 * "( ... )" are read in one pass, and the output is unchanged.
 *
 * The built-in rate-con reader (extractPdfText(): the invoice routes, the KPI
 * weight reader, the Drive rate-con index) hands its text to harvestPdfStrings().
 * That function used to be a regular expression; it is now plain code. The old
 * function is kept below, verbatim, as the reference (referenceHarvest()).
 *
 * §1 hand-picked cases: escapes, line breaks after a backslash, an unescaped
 *    "(" inside a literal, nested and unbalanced parentheses, octal escapes, a
 *    text with no literal at all (returned as it is), values that are not
 *    strings.
 * §2 identical output to the reference on a seeded fuzz of short texts made of
 *    "(", ")", backslashes, letters, digits, octal escapes, line breaks and
 *    Tj/TJ operators.
 * §3 the same through extractPdfText(): small PDFs built here, plain and
 *    deflated, with and without maxInflatedBytes, read the same as with the
 *    module compiled around the reference.
 * §4 size: large inputs (2 MB of mixed text, and each token of the fuzz
 *    alphabet repeated to 1 MB, on its own and after one "(") each finish under
 *    TIMING_BUDGET_MS (in a child process with a time limit, so a slow read fails
 *    instead of stalling the run).
 *
 * Pure: no server, no network, no files.
 *
 * Run: node scripts/test-pdf-literal-strings.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");
const { spawnSync } = require("child_process");

const LIB = path.join(__dirname, "..", "lib");
const LIB_FILE = path.join(LIB, "broker-invoice.js");
const { harvestPdfStrings, extractPdfText } = require(LIB_FILE);

// Generous for a shared 2-core CI runner; one pass over 2 MB takes a few ms.
const TIMING_BUDGET_MS = 1500;
const SIZE_CHILD_LIMIT_MS = 30000;
const FUZZ_CASES = 20000;

// The function as it was before the rewrite, verbatim (comments trimmed).
function referenceDecode(s) {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
		.replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}
function referenceHarvest(blob) {
	const out = [];
	let found = false;
	const re = /\(((?:\\.|[^\\()])*)\)/g;
	let m;
	while ((m = re.exec(blob)) !== null) {
		found = true;
		out.push(referenceDecode(m[1]));
	}
	if (!found) return blob;
	return out.join(" ");
}

let pass = 0;
const failures = [];
function t(cond, name, detail) {
	if (cond) pass++;
	else failures.push(detail === undefined ? name : `${name}: ${detail}`);
}
const show = (s) => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s);
function same(input, name) {
	const want = referenceHarvest(input);
	const got = harvestPdfStrings(input);
	t(got === want, name, `input ${show(input)}: want ${show(want)}, got ${show(got)}`);
}

// Seeded, so a failure is reproducible.
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let x = a;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

const TOKENS = [
	"(", "(", "(", ")", ")", ")", "\\", "\\", "\\(", "\\)", "\\\\",
	"a", "b", "z", "Q", "0", "7", "8", "9", " ", "  ",
	"\\101", "\\7", "\\12", "\\377", "\\9", "\\n", "\\r", "\\t",
	"\n", "\r", "\r\n", "\t", "\u2028", "\u2029", "\u00e9", "\u00ff",
	"Tj", "TJ", "[", "]", "BT", "ET", "-140",
];

// §4 runs in a child: `node test-pdf-literal-strings.js --size` prints JSON.
if (process.argv[2] === "--size") {
	const timed = (input) => {
		const t0 = process.hrtime.bigint();
		const out = harvestPdfStrings(input);
		return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
	};
	const over = [];
	let slowest = { ms: 0, name: "" };
	const note = (res, name) => {
		if (res.ms > slowest.ms) slowest = { ms: res.ms, name };
		if (res.ms >= TIMING_BUDGET_MS) over.push(`${name} ${res.ms.toFixed(0)} ms`);
	};
	const r = rng(99);
	const parts = [];
	let size = 0;
	while (size < 2 * 1024 * 1024) {
		const tok = TOKENS[Math.floor(r() * TOKENS.length)];
		parts.push(tok);
		size += tok.length;
	}
	const mixed = parts.join("");
	const res = timed(mixed);
	note(res, "2 MB of mixed text");
	const unique = [...new Set(TOKENS)];
	for (const tok of unique) {
		const body = tok.repeat(Math.ceil((1024 * 1024) / tok.length));
		note(timed(body), JSON.stringify(tok));
		note(timed(`(${body}`), `"(" + ${JSON.stringify(tok)}`);
	}
	process.stdout.write(JSON.stringify({ count: 1 + unique.length * 2, over, slowest, mixedSame: res.out === referenceHarvest(mixed) }));
	process.exit(0);
}

const started = Date.now();

// §1 hand-picked cases
const CASES = [
	["", "empty text"],
	["plain text, no literal", "no literal: the text comes back as it is"],
	["()", "an empty literal"],
	["(", "a lone ("],
	[")", "a lone )"],
	["\\", "a lone backslash"],
	["(abc", "an unterminated literal"],
	["(abc\\", "an unterminated literal ending in a backslash"],
	["(a\\", "a backslash at the very end"],
	["(Order #:) Tj (7007280) Tj", "two Tj strings"],
	["[(Order # )-2(30080873)-140(1)] TJ", "a TJ array"],
	["(a\\)b) Tj", "an escaped )"],
	["(a\\(b) Tj", "an escaped ("],
	["(a\\\\) Tj (b)", "an escaped backslash before )"],
	["(a\\\\\\)) Tj", "an escaped backslash then an escaped )"],
	["(a(b)c)", "nested parentheses"],
	["((a)", "an unescaped ( inside a literal"],
	["(a)(b)(c)", "adjacent literals"],
	["(a))b(c)", "an extra )"],
	["(a\\\nb) (c)", "a backslash before a line feed"],
	["(a\\\r\nb) (c)", "a backslash before a carriage return"],
	["(a\\\u2028b) (c)", "a backslash before U+2028"],
	["(a\\\u2029b) (c)", "a backslash before U+2029"],
	["(a\nb) (c\rd)", "line breaks inside a literal"],
	["(a\u2028b)", "U+2028 inside a literal"],
	["(\\101\\102\\103) Tj", "octal escapes"],
	["(\\7\\12\\1234) Tj", "short and long octal escapes"],
	["(\\8\\9\\89) Tj", "digits 8 and 9 after a backslash"],
	["(\\n\\r\\t\\b\\f) Tj", "named escapes"],
	["(\\\\n) Tj", "an escaped backslash before n"],
	["(x\\(\\(\\(y", "escaped ( and no )"],
	["(x\\(\\(\\(y)", "escaped ( then )"],
	["(x\\(\\(\\(y\\\n(z)", "escaped ( then a backslash before a line break"],
	["(x\\(\\(\\((z)", "escaped ( then an unescaped ("],
	["\\((a)", "a literal after an escaped ("],
	["BT /F1 12 Tf 72 712 Td (Weight: 42,000 lbs) Tj ET", "a text block"],
];
for (const [input, name] of CASES) same(input, `§1 ${name}`);
t(harvestPdfStrings("plain text, no literal") === "plain text, no literal", "§1 no literal: the input itself is returned");
t(harvestPdfStrings("(a) (b)") === "a b", "§1 literals are space-joined");
for (const [value, name] of [[undefined, "undefined"], [null, "null"], [12345, "a number"], [Buffer.from("(a) (b\\)c)", "latin1"), "a Buffer"], [{ toString: () => "x (y) z" }, "an object"]]) {
	const want = referenceHarvest(value);
	const got = harvestPdfStrings(value);
	t(Object.is(got, want), `§1 ${name} reads as the reference reads it`, `want ${String(want)}, got ${String(got)}`);
}

// §2 seeded fuzz
{
	const r = rng(20261015);
	let mismatches = 0;
	let firstMismatch = null;
	for (let k = 0; k < FUZZ_CASES; k++) {
		const len = Math.floor(r() * 60);
		let s = "";
		for (let q = 0; q < len; q++) s += TOKENS[Math.floor(r() * TOKENS.length)];
		if (harvestPdfStrings(s) !== referenceHarvest(s)) {
			mismatches++;
			if (firstMismatch === null) firstMismatch = s;
		}
	}
	t(mismatches === 0, `§2 ${FUZZ_CASES} fuzzed texts read the same as the reference`, `${mismatches} differ, first ${show(firstMismatch || "")}`);
}

// §3 through extractPdfText()
function pdfOf(contents, deflate) {
	const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
	contents.forEach((c, i) => {
		const data = deflate ? zlib.deflateSync(Buffer.from(c, "latin1")) : Buffer.from(c, "latin1");
		parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${data.length}${deflate ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
	});
	parts.push(Buffer.from("trailer\n<< >>\n%%EOF\n", "latin1"));
	return Buffer.concat(parts);
}
// The module as shipped, with harvestPdfStrings() redeclared last as the
// reference (the last declaration of a name wins), so its extractPdfText() is
// the reader as it was.
function referenceModule() {
	const src = `${fs.readFileSync(LIB_FILE, "utf8")}\nfunction harvestPdfStrings(blob) { return referenceHarvest(blob); }\n`;
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", "referenceHarvest", src)(m, m.exports, Module.createRequire(LIB_FILE), LIB_FILE, LIB, referenceHarvest);
	return m.exports;
}
{
	const ref = referenceModule();
	t(/referenceHarvest\(blob\)/.test(String(ref.harvestPdfStrings)) && ref.extractPdfText !== extractPdfText, "§3 the module compiled around the reference uses it");
	const r = rng(7);
	let mismatches = 0;
	let firstMismatch = null;
	const runs = 400;
	for (let k = 0; k < runs; k++) {
		const deflate = k % 2 === 1;
		const contents = [];
		const streams = 1 + Math.floor(r() * 3);
		for (let p = 0; p < streams; p++) {
			let s = "BT ";
			const len = Math.floor(r() * 40);
			for (let q = 0; q < len; q++) s += TOKENS[Math.floor(r() * TOKENS.length)];
			contents.push(`${s} ET`.replace(/[^\x00-\xff]/g, "?"));
		}
		const pdf = pdfOf(contents, deflate);
		const opts = k % 4 >= 2 ? { maxInflatedBytes: 1 + Math.floor(r() * 400) } : undefined;
		if (extractPdfText(pdf, opts) !== ref.extractPdfText(pdf, opts)) {
			mismatches++;
			if (firstMismatch === null) firstMismatch = contents.join(" | ");
		}
	}
	t(mismatches === 0, `§3 ${runs} built PDFs read the same as the reference`, `${mismatches} differ, first ${show(firstMismatch || "")}`);
	const rc = pdfOf(["BT (Order #:) Tj (7007280) Tj ET", "BT [(Weight: )-20(42,000)] TJ ET"], true);
	t(/Order #: 7007280/.test(extractPdfText(rc)) && /Weight: {2}42,000/.test(extractPdfText(rc)), "§3 a small rate-con reads its labels and numbers");
}

// §4 size, in a child process with a time limit
{
	const child = spawnSync(process.execPath, [__filename, "--size"], { encoding: "utf8", timeout: SIZE_CHILD_LIMIT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
	if (child.status !== 0 || !child.stdout) {
		t(false, `§4 large texts are read within ${SIZE_CHILD_LIMIT_MS / 1000} s in all`, child.error ? child.error.code || child.error.message : `exit ${child.status} ${child.signal || ""} ${(child.stderr || "").slice(0, 200)}`);
	} else {
		const res = JSON.parse(child.stdout);
		t(res.over.length === 0, `§4 ${res.count} large texts each under ${TIMING_BUDGET_MS} ms`, res.over.join(", "));
		t(res.mixedSame, "§4 the 2 MB text reads the same as the reference");
		console.log(`  slowest large text: ${res.slowest.name} ${res.slowest.ms.toFixed(1)} ms`);
	}
}

const ms = Date.now() - started;
if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  x ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed (${ms} ms)`);
	process.exit(1);
}
console.log(`\n${pass} assertions passed (${ms} ms)`);
