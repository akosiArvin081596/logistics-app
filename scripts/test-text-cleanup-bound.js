#!/usr/bin/env node
/**
 * The raw-length cut in sanitizeEvidenceText() and safeAttachmentName()
 * (server.js): each cuts its raw value to 4 × the kept length BEFORE
 * normalizing it, so the work stays proportional to the kept length.
 *
 *   §1 SAME OUTPUT. Both functions, lifted from server.js, against the
 *      implementations before the cut (reference copies below) on a seeded
 *      corpus: ordinary values, and values around 4 × max for every max the
 *      callers pass — astral characters on both sides of the cut, decomposed
 *      accents, characters NFC lengthens, controls, BIDI and zero-width
 *      characters, lone surrogates. Then the one kind of value that comes out
 *      differently, pinned so it surprises nobody.
 *   §2 THE CUT. Normalization only ever sees 4 × max UTF-16 units; the cut
 *      never leaves half a surrogate pair; an Infinity max cuts nothing, and
 *      its one caller bounds the raw length itself; a 200,000-character run of
 *      combining marks is cleaned in under 250 ms.
 *   §3 ONE CUT, TWO COPIES. Runners lift each function alone, so neither may
 *      call a helper: the cut is written twice, and the copies are pinned
 *      identical here.
 *   §4 MUTANTS. Each piece of the cut is broken in turn, and an assertion must
 *      flip.
 *
 * WHY server.js IS READ AS TEXT: it opens SQLite, reads a service-account key
 * and starts listening on import. Every extraction asserts its needle is found
 * exactly once, so a rename fails loudly instead of testing nothing.
 *
 * Plain node, no server, no network, never touches app.db.
 * Run: node scripts/test-text-cleanup-bound.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// Characters that must never be typed literally into this file — built from
// their code points so no editor or tool can drop or mangle them.
const cp = (...codes) => String.fromCodePoint(...codes);
const TAB = cp(0x09);
const NEL = cp(0x85); // C1 control
const NBSP = cp(0xa0);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e); // BIDI override
const LS = cp(0x2028); // LINE SEPARATOR
const BOM = cp(0xfeff);
const E_ACUTE = cp(0xe9);
const E_ACUTE_DECOMPOSED = "e" + cp(0x301);
const ACUTE = cp(0x301); // combining, class 230
const GRAVE_BELOW = cp(0x316); // combining, class 220
const QA = cp(0x958); // NFC makes it two code points
const SHIN_DAGESH_SHIN_DOT = cp(0xfb2c); // NFC makes it three
const TRUCK = cp(0x1f69a); // astral: one code point, two UTF-16 units
const HIGH = String.fromCharCode(0xd800); // a lone high surrogate
const LOW = String.fromCharCode(0xdc00); // a lone low surrogate

// ---------------------------------------------------------------- extraction
function countOf(hay, needle) { return hay.split(needle).length - 1; }
function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	// From the BODY's brace: readInvestorRecordBody() destructures `{ creating }`
	// in its parameter list, and that `{` would otherwise end the match at once.
	let depth = 0;
	for (let j = src.indexOf(") {", start) + 2; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 declaration of ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	return src.slice(start, src.indexOf("\n", start));
}
// The two functions and the pattern they strip with, from a source text.
function loadShipped(src) {
	const body =
		extractConst(src, "EVIDENCE_TEXT_STRIP") + "\n" +
		extractFn(src, "sanitizeEvidenceText") + "\n" +
		extractFn(src, "safeAttachmentName") +
		"\nreturn { EVIDENCE_TEXT_STRIP, sanitizeEvidenceText, safeAttachmentName };";
	return new Function(body)();
}
// A copy of `src` with one site inside one function changed.
function mutateFn(src, name, from, to, label) {
	const text = extractFn(src, name);
	if (countOf(text, from) !== 1) throw new Error(`mutant ${label}: expected exactly one site to mutate`);
	return src.replace(text, () => text.replace(from, () => to));
}

const S = loadShipped(SRC);
const EVIDENCE_TEXT_STRIP = S.EVIDENCE_TEXT_STRIP;

// The implementations before the cut, verbatim — what §1 compares with.
function referenceSanitizeEvidenceText(v, max) {
	const s = String(v == null ? "" : v).normalize("NFC").replace(EVIDENCE_TEXT_STRIP, " ").trim();
	return Array.from(s).slice(0, max).join("");
}
function referenceSafeAttachmentName(value, max = 80, fallback = "Invoice") {
	let s = String(value == null ? "" : value).normalize("NFC").replace(EVIDENCE_TEXT_STRIP, " ");
	s = s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
	s = s.replace(/^[.\s]+/, "");
	s = Array.from(s).slice(0, max).join("").trim();
	return s || fallback;
}

// The maxes server.js passes today: literal 40, 80 and 1000, and three named.
const MAXES = [40, 80, 1000, ...["INVOICE_FIELD_SCAN_MAX", "CONSENT_TEXT_MAX", "USER_AGENT_MAX"].map((c) =>
	new Function(`${extractConst(SRC, c)}\nreturn ${c};`)())];
const NAME_MAXES = [40, 80]; // safeAttachmentName's callers

// ------------------------------------------------------------------ helpers
function mulberry32(seed) {
	return () => {
		seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const ALPHABET = [
	"a", "Z", "7", " ", " ", ".", "-", "/", ":", "<", "&", '"',
	TAB, "\n", "\r", NEL, ZWSP, RLO, BOM, NBSP, LS,
	E_ACUTE, E_ACUTE_DECOMPOSED, ACUTE, GRAVE_BELOW, QA, SHIN_DAGESH_SHIN_DOT, TRUCK, HIGH, LOW,
];
// A seeded value of about `units` UTF-16 units.
function valueOf(rand, units) {
	let s = "";
	while (s.length < units) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	return s;
}
function hasLoneSurrogate(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
			return true;
		}
		if (c >= 0xdc00 && c <= 0xdfff) return true;
	}
	return false;
}
// Every string String.prototype.normalize is handed while `run` executes.
function normalizeInputs(run) {
	const seen = [];
	const original = String.prototype.normalize;
	String.prototype.normalize = function (...args) {
		seen.push(String(this));
		return original.apply(this, args);
	};
	try { run(); } finally { String.prototype.normalize = original; }
	return seen;
}
const show = (v) => (v.length > 24 ? `${JSON.stringify(v.slice(0, 12))}… (${v.length} units)` : JSON.stringify(v));

// §1's comparison: every value where a function and its reference disagree.
function referenceMismatches(mod) {
	const out = [];
	const check = (v, max) => {
		if (mod.sanitizeEvidenceText(v, max) !== referenceSanitizeEvidenceText(v, max)) out.push(`sanitizeEvidenceText(${show(v)}, ${max})`);
		if (NAME_MAXES.includes(max) && mod.safeAttachmentName(v, max) !== referenceSafeAttachmentName(v, max)) {
			out.push(`safeAttachmentName(${show(v)}, ${max})`);
		}
	};
	const rand = mulberry32(20261001);
	for (let n = 0; n < 2000; n++) check(valueOf(rand, Math.floor(rand() * 60)), NAME_MAXES[n % 2]);
	for (const max of MAXES) {
		for (const units of [4 * max - 2, 4 * max - 1, 4 * max, 4 * max + 1, 4 * max + 2, 5 * max, 8 * max]) {
			for (let n = 0; n < 4; n++) check(valueOf(rand, units), max);
		}
		// Built to put the cut exactly where it is hardest.
		for (const v of [
			TRUCK.repeat(2 * max + 5), // a pair ends exactly at the cut
			"a" + TRUCK.repeat(2 * max + 5), // the cut falls inside a pair
			E_ACUTE_DECOMPOSED.repeat(2 * max + 5),
			"x" + E_ACUTE_DECOMPOSED.repeat(2 * max + 5), // the cut falls between a base and its accent
			QA.repeat(4 * max + 7),
			SHIN_DAGESH_SHIN_DOT.repeat(4 * max + 7),
			" ".repeat(3 * max) + "x".repeat(2 * max), // the kept text ends exactly at the cut
			(TAB + ZWSP + "ab").repeat(max + 3),
		]) check(v, max);
	}
	return out;
}

// §2's cut: every way the cut does not hold.
function cutProblems(mod) {
	const out = [];
	for (const max of MAXES) {
		const seen = normalizeInputs(() => mod.sanitizeEvidenceText("x".repeat(100000), max));
		if (seen.length !== 1 || seen[0].length > 4 * max) out.push(`sanitizeEvidenceText, max ${max}: normalized ${seen.map((s) => s.length).join(",")} units`);
		const odd = normalizeInputs(() => mod.sanitizeEvidenceText("a" + TRUCK.repeat(2 * max + 5), max));
		if (odd.some(hasLoneSurrogate)) out.push(`sanitizeEvidenceText, max ${max}: the cut split a surrogate pair`);
	}
	for (const max of NAME_MAXES) {
		const seen = normalizeInputs(() => mod.safeAttachmentName("x".repeat(100000), max));
		if (seen.length !== 1 || seen[0].length > 4 * max) out.push(`safeAttachmentName, max ${max}: normalized ${seen.map((s) => s.length).join(",")} units`);
		const odd = normalizeInputs(() => mod.safeAttachmentName("a" + TRUCK.repeat(2 * max + 5), max));
		if (odd.some(hasLoneSurrogate)) out.push(`safeAttachmentName, max ${max}: the cut split a surrogate pair`);
	}
	return out;
}

// ============================================================ §1 SAME OUTPUT
function sameOutputSection() {
	section("1. Same output as before the cut");
	eq(referenceMismatches(S).slice(0, 5), [], "§1 both functions agree with their reference on the whole seeded corpus");
	ok(referenceSanitizeEvidenceText("a" + TRUCK.repeat(90), 40) === "a" + TRUCK.repeat(39),
		"§1 (control) the reference keeps 40 characters of an astral run, so the corpus exercises the cut");

	// The one kind of value that cleans differently: padding so heavy that the
	// kept text starts past the cut. Pinned so the difference is on record.
	const padded = " ".repeat(4 * 40) + "abc";
	eq([referenceSanitizeEvidenceText(padded, 40), S.sanitizeEvidenceText(padded, 40)], ["abc", ""],
		"§1 a value whose first 4 × max units are all stripped keeps nothing (before: the text after them)");
	eq([referenceSafeAttachmentName(padded, 40), S.safeAttachmentName(padded, 40)], ["abc", "Invoice"],
		"§1 …and a file name built from it falls back to its default");
}

// ================================================================ §2 THE CUT
function theCutSection() {
	section("2. The cut — what normalization sees");
	eq(cutProblems(S), [], `§2 for every max (${MAXES.join(", ")}), normalization sees at most 4 × max units and never half a pair`);
	for (const max of [40, 1000]) {
		const seen = normalizeInputs(() => S.sanitizeEvidenceText("a" + TRUCK.repeat(2 * max + 5), max));
		eq(seen.map((s) => s.length), [4 * max - 1], `§2 max ${max}: a pair split by the cut loses its dangling half (${4 * max - 1} units, not ${4 * max})`);
	}
	eq(normalizeInputs(() => S.sanitizeEvidenceText("y".repeat(20000), Infinity)).map((s) => s.length), [20000],
		"§2 an Infinity max cuts nothing");
	eq(countOf(extractFn(SRC, "readInvestorRecordBody"), "raw.length > max * 4) return bad;"), 1,
		"§2 …and the one caller passing Infinity refuses a raw value over 4 × its own limit first");
	eq([S.sanitizeEvidenceText("abc", undefined), S.safeAttachmentName("abc")], ["abc", "abc"],
		"§2 an omitted max (undefined, or safeAttachmentName's default 80) keeps the old results");
	for (const max of MAXES) {
		const v = "b".repeat(4 * max) + "tail";
		eq(S.sanitizeEvidenceText(v, max), "b".repeat(max), `§2 max ${max}: a long value keeps exactly its first ${max} characters`);
	}

	// A run normalization has to reorder: one base character, then combining
	// marks of two classes, alternating — 200,001 units.
	const RUN = "a" + (ACUTE + GRAVE_BELOW).repeat(100000);
	const BUDGET_MS = 250;
	const fastestMs = (fn) => {
		let best = Infinity;
		for (let i = 0; i < 3; i++) {
			const t0 = process.hrtime.bigint();
			fn();
			const ms = Number(process.hrtime.bigint() - t0) / 1e6;
			best = Math.min(best, ms);
			if (best < BUDGET_MS || ms > BUDGET_MS * 10) break;
		}
		return best;
	};
	const tE = fastestMs(() => S.sanitizeEvidenceText(RUN, 1000));
	ok(tE < BUDGET_MS, `§2 sanitizeEvidenceText, max 1000: a 200,000-character run of combining marks is cleaned in under ${BUDGET_MS} ms (${tE.toFixed(1)} ms)`);
	const tN = fastestMs(() => S.safeAttachmentName(RUN, 80));
	ok(tN < BUDGET_MS, `§2 safeAttachmentName, max 80: the same run in under ${BUDGET_MS} ms (${tN.toFixed(1)} ms)`);
}

// ======================================================= §3 ONE CUT, TWO COPIES
function twoCopiesSection() {
	section("3. One cut, two copies");
	const CUT_RE = /\n\tif \(raw\.length > max \* 4\) \{\n[^}]*\n\t\}\n/;
	const copies = [["sanitizeEvidenceText", "v"], ["safeAttachmentName", "value"]].map(([name, param]) => {
		const text = extractFn(SRC, name);
		const cut = CUT_RE.exec(text);
		const declared = `\tlet raw = String(${param} == null ? "" : ${param});\n`;
		ok(cut && text.indexOf(declared) >= 0 && text.indexOf(declared) < cut.index,
			`§3 ${name}: raw is taken from its argument, then cut`);
		eq(countOf(text, ".normalize("), 1, `§3 ${name}: normalizes once…`);
		ok(cut && text.indexOf('raw.normalize("NFC")') > cut.index, `§3 ${name}: …and only the cut value`);
		return cut ? cut[0] : null;
	});
	ok(copies[0] !== null && copies[0] === copies[1], "§3 the two cuts are the same text");
}

// ================================================================ §4 MUTANTS
function mutantsSection() {
	section("4. Mutants — each broken piece must flip an assertion");
	const MUTANTS = [
		{
			name: "M1 sanitizeEvidenceText normalizes the whole raw value (no cut)",
			fn: "sanitizeEvidenceText", from: "if (raw.length > max * 4) {", to: "if (false) {",
			caught: (mod) => cutProblems(mod).length > 0,
		},
		{
			name: "M2 the cut leaves half a surrogate pair",
			fn: "sanitizeEvidenceText", from: "if (last >= 0xd800 && last <= 0xdbff) raw = raw.slice(0, -1);", to: "",
			caught: (mod) => cutProblems(mod).some((p) => p.includes("surrogate")),
		},
		{
			name: "M3 the cut keeps max units, not 4 × max",
			fn: "sanitizeEvidenceText", from: "raw = raw.slice(0, max * 4);", to: "raw = raw.slice(0, max);",
			caught: (mod) => referenceMismatches(mod).length > 0,
		},
		{
			name: "M4 safeAttachmentName normalizes the whole raw value (no cut)",
			fn: "safeAttachmentName", from: "if (raw.length > max * 4) {", to: "if (false) {",
			caught: (mod) => cutProblems(mod).length > 0,
		},
	];
	for (const m of MUTANTS) {
		let caught = false;
		try { caught = !!m.caught(loadShipped(mutateFn(SRC, m.fn, m.from, m.to, m.name))); } catch (e) { failures.push(`${m.name}: ${e.message}`); continue; }
		ok(caught, `§4 caught: ${m.name}`);
	}
}

// -------------------------------------------------------------------- report
for (const [name, run] of [["§1", sameOutputSection], ["§2", theCutSection], ["§3", twoCopiesSection], ["§4", mutantsSection]]) {
	// A throw inside a section is a failure, not a crash that hides the rest.
	try { run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
}
console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
