#!/usr/bin/env node
/**
 * collapseAddress() in lib/ratecon-normalize.js — linear, and output-identical
 * to the regex chain it replaced.
 *
 * WHY THIS EXISTS. collapseAddress() cleans the two address fields Gemini
 * extracts from a rate-con PDF, on both the n8n ingestion webhook
 * (POST /api/n8n/extract-pdf-via-gemini) and the dispatcher's drag-and-drop
 * extract. That text is attacker-influenced — anyone can put anything in a
 * PDF — so every step must be linear in the length of the input (CLAUDE.md:
 * "Bound every regex quantifier that runs on attacker-influenced text").
 *
 * Two steps used to be regular expressions -- the comma-spacing replace and the
 * end trim of commas and whitespace. They are now plain code. A rewrite of a
 * load-bearing normalizer must not change a single output, so the OLD chain is
 * kept below, verbatim, as the oracle (OLD_COLLAPSE_SRC).
 *
 * WHAT IS ASSERTED
 *   §1 identical output to the old chain: hand-picked edge cases plus a
 *      seeded fuzz over commas, newlines and every kind of whitespace
 *   §2 the module's own broker-shaped fixtures (selfTest) still pass
 *   §3 linear: long adversarial input, including long INTERNAL whitespace
 *      runs, stays under a generous budget (child process, hard kill)
 *   §4 DISCRIMINATION — the old chain cannot pass §3
 *
 * Pure: no server, no network, no fixtures on disk.
 *
 * Run: node scripts/test-collapse-address-linear.js
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const LIB_PATH = path.join(__dirname, "..", "lib", "ratecon-normalize.js");
const { collapseAddress, normalizeRateConFields, selfTest } = require(LIB_PATH);

const TIMING_BUDGET_MS = 200;
// Characters per adversarial input. Smaller than the email runner's because
// collapseAddress() must touch (and reallocate) every character, so its linear
// cost is real; this size keeps that far under the budget on a slow CI runner
// while a super-linear version still cannot finish anywhere near it.
const BIG = 1 << 18;

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// The previous implementation, verbatim. The oracle for §1 and the mutant for §4.
const OLD_COLLAPSE_SRC = `function oldCollapseAddress(raw) {
	let out = String(raw).replace(/\\r\\n?/g, "\\n");
	out = out.split("\\n").map((l) => l.trim()).filter(Boolean).join(", ");
	out = out.replace(/[ \\t]+/g, " ").replace(/\\s*,\\s*/g, ", ");
	out = out.replace(/(?:,\\s*){2,}/g, ", ");
	out = out.replace(/^[,\\s]+|[,\\s]+$/g, "");
	return out;
}`;
const oldCollapseAddress = new Function(`${OLD_COLLAPSE_SRC}\nreturn oldCollapseAddress;`)();

// ===========================================================================
console.log("\n§1  identical output to the regex chain it replaced");
// ===========================================================================
const NBSP = String.fromCharCode(0xa0);
const LS = String.fromCharCode(0x2028);
const IDSP = String.fromCharCode(0x3000);
const BOM = String.fromCharCode(0xfeff);
const edge = [
	"", ",", ", ,", ",,,", " , , ", "a", " a ", " a , b ", "a, ,b", "a,,b", ",a,", "a ,b", "a, b",
	"4528 W Royal Ln\nIrving, TX 75063",
	"4528 W Royal Ln\r\nIrving, TX 75063\r\n",
	"Jacobson Warehouse\n  1200 Industrial Pkwy  \n\n Joliet ,  IL   60431 ",
	"a\n,\nb", "a,\n\n,b", "\n\n", "  \t ", "a\tb , c",
	`a${NBSP}${NBSP}b`, `a${NBSP},${NBSP}b`, `${NBSP},a,${NBSP}`, `a${LS}b`, `a${LS},${LS}b`, `${LS}${LS}`,
	`a${IDSP}, b${BOM}`, `a\v\f,\f\vb`, "a , , , b", "a ,  ,, ,b",
];
let edgeSame = 0;
for (const s of edge) {
	const same = collapseAddress(s) === oldCollapseAddress(s);
	if (same) edgeSame++;
	else console.log(`      differs on ${JSON.stringify(s)}: new=${JSON.stringify(collapseAddress(s))} old=${JSON.stringify(oldCollapseAddress(s))}`);
}
ok(`all ${edge.length} hand-picked edge cases match the old output`, edgeSame === edge.length);

// Seeded, so a failure reproduces exactly.
function mulberry32(seed) {
	return () => {
		seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const ALPHABET = ["a", "b", "7", ".", "#", ",", ",", " ", " ", "\t", "\n", "\r", "\v", "\f", NBSP, LS, IDSP, BOM];
const rand = mulberry32(20260923);
const FUZZ_CASES = 20000;
let firstDiff = null;
for (let n = 0; n < FUZZ_CASES && !firstDiff; n++) {
	const len = Math.floor(rand() * 41);
	let s = "";
	for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	if (collapseAddress(s) !== oldCollapseAddress(s)) firstDiff = s;
}
if (firstDiff !== null) console.log(`      first difference: ${JSON.stringify(firstDiff)}`);
ok(`${FUZZ_CASES} seeded random inputs match the old output`, firstDiff === null);

// ===========================================================================
console.log("\n§2  the module's own broker-shaped fixtures");
// ===========================================================================
const quiet = console.log;
let st;
console.log = () => {};
try { st = selfTest(); } finally { console.log = quiet; }
ok(`selfTest(): ${st.passed}/${st.total} fixture checks pass`, st.failed === 0 && st.total > 0);

// ===========================================================================
console.log("\n§3  linear — long adversarial input stays under budget");
// ===========================================================================
// mode "new" times the module's collapseAddress and normalizeRateConFields;
// mode "old" times the previous chain (for §4).
const PROBE = `
const [libPath, mode, big, oldSrc] = process.argv.slice(1);
const lib = require(libPath);
const N = Number(big);
const NBSP = String.fromCharCode(0xa0), LS = String.fromCharCode(0x2028), IDSP = String.fromCharCode(0x3000);
const fn = mode === "old" ? new Function(oldSrc + "\\nreturn oldCollapseAddress;")() : lib.collapseAddress;
const shapes = {
	"INTERNAL whitespace run 1": "a" + NBSP.repeat(N) + "b",
	"INTERNAL whitespace run 2": "a" + LS.repeat(N) + "b",
	"INTERNAL whitespace run 3": "a" + IDSP.repeat(N) + "b",
	"INTERNAL whitespace run 4": "a" + "\\v\\f".repeat(N / 2) + "b",
	"INTERNAL whitespace run 5": "a" + (" " + NBSP).repeat(N / 2) + "b",
	"comma, then a whitespace run": "a," + NBSP.repeat(N) + "b",
	"many commas": ",".repeat(N),
	"alternating comma and whitespace": (", " + NBSP).repeat(N / 3),
	"many short lines": "a\\n".repeat(N / 2),
};
const out = [];
for (const [label, s] of Object.entries(shapes)) {
	let best = Infinity;
	for (let k = 0; k < 3; k++) {
		const t = process.hrtime.bigint();
		fn(s);
		best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
	}
	out.push({ label, ms: best });
	if (mode === "new") {
		const t = process.hrtime.bigint();
		lib.normalizeRateConFields({ "Pickup Address": s, "Drop-off Address": s });
		out.push({ label: "normalizeRateConFields: " + label, ms: Number(process.hrtime.bigint() - t) / 1e6 / 2 });
	}
}
process.stdout.write(JSON.stringify(out));
`;
// The hard kill sits well inside run-unit-tests.js's per-runner timeout, so a
// regression reports here, by name, instead of as an anonymous runner timeout.
function probe(mode, { timeoutMs = 20000 } = {}) {
	const r = spawnSync(process.execPath, ["-e", PROBE, LIB_PATH, mode, String(BIG), OLD_COLLAPSE_SRC], {
		encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 20,
	});
	if (r.signal || r.status !== 0) return { killed: true, results: [], stderr: (r.stderr || "").slice(0, 300) };
	return { killed: false, results: JSON.parse(r.stdout) };
}
const run = probe("new");
ok("the timing probe ran to completion", !run.killed);
ok("the probe covered every shape, through both entry points", run.results.length === 18);
for (const { label, ms } of run.results) {
	ok(`${label}: < ${TIMING_BUDGET_MS} ms [${ms.toFixed(2)} ms]`, ms < TIMING_BUDGET_MS);
}

// ===========================================================================
console.log("\n§4  DISCRIMINATION — the old chain cannot pass §3");
// ===========================================================================
const oldRun = probe("old", { timeoutMs: 1500 });
ok("MUTANT: the previous regex chain is killed or over budget on the same inputs",
	oldRun.killed || oldRun.results.some((r) => r.ms >= TIMING_BUDGET_MS));

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
