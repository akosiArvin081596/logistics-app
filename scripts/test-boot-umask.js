#!/usr/bin/env node
// Pins the process umask set at the top of server.js.
//
// WHY THIS EXISTS. Node creates files as `0666 & ~umask` and directories as
// `0777 & ~umask`. pm2 inherits root's default `umask 022`, so every expense
// receipt, POD, chat attachment, invoice PDF, signed W-9 and app.db itself
// landed 0644 — world-readable on a box with four non-root login accounts.
// PR #271 chmodded the existing tree to 0640/0750, but that is POINT-IN-TIME:
// the next upload re-published PII because nothing changed how new files are
// CREATED. `process.umask(0o027)` is the create-time half, and the two halves
// must agree exactly — 027 yields 0640 files and 0750 dirs.
//
// THE TWO PROPERTIES THAT CAN SILENTLY BREAK, and why each is tested:
//
//   1. THE VALUE. 022 (the default) and 027 differ by one octal digit and by
//      "world can read every SSN on disk". A test that only asserted "a umask
//      is set" would pass on the bug. So the behavioural half actually creates
//      a file and a directory in a child process and asserts 0640 / 0750, and
//      a mutant re-runs it at 022 and requires the battery to REJECT it.
//
//   2. THE ORDER. umask applies only to files created AFTER it is set, so a
//      refactor that moves the call below the requires — or below
//      `new Database(...)`, which creates app.db + -wal + -shm — leaves exactly
//      the highest-value file at 0644 while the log line still says 027.
//      "Late" is identical to "absent". The structural half therefore asserts
//      the call precedes dotenv, every require, and the SQLite open, and a
//      mutant moves it below the Database open and requires a rejection.
//
// No network and no database. The behavioural half writes only into a fresh
// mkdtemp under os.tmpdir(), in a CHILD process, so this process's own umask is
// never mutated and nothing in the repo is touched.
//
//   node scripts/test-boot-umask.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "server.js");
const EXPECTED_UMASK = 0o027;
const EXPECTED_FILE_MODE = 0o640;
const EXPECTED_DIR_MODE = 0o750;

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}

// ---------------------------------------------------------------------------
// STRUCTURAL — the umask call must precede everything that can create a file.
//
// Returns a list of failure strings so the mutants below can reuse it verbatim.
// Testing the mutants against a DIFFERENT implementation of the rule would
// prove nothing about the rule that actually runs.
// ---------------------------------------------------------------------------
function structuralFailures(src) {
	const bad = [];

	const umaskIdx = src.search(/process\.umask\(\s*BOOT_UMASK\s*\)/);
	if (umaskIdx < 0) { bad.push("no `process.umask(BOOT_UMASK)` call found"); return bad; }

	// The constant must be 027 specifically, written as an octal literal so it
	// reads the same as the chmod that produced the existing tree.
	const constMatch = src.match(/const\s+BOOT_UMASK\s*=\s*(0o[0-7]+)\s*;/);
	if (!constMatch) bad.push("BOOT_UMASK is not declared as an octal literal");
	else if (parseInt(constMatch[1].slice(2), 8) !== EXPECTED_UMASK) {
		bad.push(`BOOT_UMASK is ${constMatch[1]}, expected 0o${EXPECTED_UMASK.toString(8)}`);
	}

	// Everything below creates or can create a file. Each must come AFTER the
	// umask call. `require(` covers dotenv and every module that might write a
	// cache on load; `new Database(` is app.db itself.
	//
	// ⚠️ Each pattern is anchored to an ASSIGNMENT or a statement start, never a
	// bare mention — server.js's own comment block names `new Database(...)` and
	// a comment-matching regex would report the file as broken forever.
	const mustFollow = [
		["dotenv config", /^require\("dotenv"\)\.config\(\)/m],
		["first require", /^const\s+\w+\s*=\s*require\(/m],
		["SQLite open", /^const\s+\w+\s*=\s*new\s+Database\(/m],
		["first mkdirSync", /^\s*(?:if\s*\(.*\)\s*)?fs\.mkdirSync\(/m],
		["first writeFileSync", /^\s*fs\.writeFileSync\(/m],
	];
	for (const [label, re] of mustFollow) {
		const idx = src.search(re);
		if (idx < 0) { bad.push(`could not locate ${label} in server.js`); continue; }
		if (idx < umaskIdx) bad.push(`${label} runs BEFORE the umask is set (files it creates keep the inherited mask)`);
	}

	// The umask must not sit inside a function/handler — it has to run at module
	// load, unconditionally. Anything before it must be comments or blank lines.
	// Cut at the start of the call's own LINE, so the `x = ` half of the
	// assignment that captures the previous mask isn't read as prior code.
	const lineStart = src.lastIndexOf("\n", umaskIdx) + 1;
	const callLine = src.slice(lineStart, src.indexOf("\n", umaskIdx)).trim();

	// ⚠️ "Before the requires" is not sufficient on its own: a call parked inside
	// a `function applyUmask() { … }` declared at line 1 satisfies every ordering
	// test above and still never runs. The umask has to be an UNCONDITIONAL
	// top-level statement, so its own line may not open a function or a branch.
	const nested = callLine.match(/\bfunction\b|=>|\bif\b|\bfor\b|\bwhile\b|\bcase\b|\bcatch\b/);
	if (nested) bad.push(`the umask call is nested inside \`${nested[0]}\` — it may never run: ${JSON.stringify(callLine)}`);

	const codeBefore = src.slice(0, lineStart)
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"))
		// The declaration + the try that wraps the call are the only permitted
		// statements ahead of it.
		.filter(l => !/^const\s+BOOT_UMASK\s*=/.test(l))
		.filter(l => !/^let\s+bootUmaskPrevious\s*=/.test(l))
		.filter(l => l !== "try {");
	if (codeBefore.length) bad.push(`executable code runs before the umask: ${JSON.stringify(codeBefore.slice(0, 3))}`);

	return bad;
}

const src = fs.readFileSync(SERVER_PATH, "utf8");
check("server.js: umask precedes every file-creating call", structuralFailures(src), []);

// ---------------------------------------------------------------------------
// BEHAVIOURAL — 027 really does yield 0640 / 0750 on this platform.
//
// Runs in a CHILD process: process.umask() is per-process global state, and
// mutating it here would leak into anything else the harness later touches.
// ---------------------------------------------------------------------------
function modesUnderUmask(mask) {
	const script = `
		const fs = require("fs"), os = require("os"), path = require("path");
		process.umask(${mask});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umask-probe-"));
		const sub = path.join(dir, "sub");
		const file = path.join(dir, "f.txt");
		fs.mkdirSync(sub);
		fs.writeFileSync(file, "x");
		const out = {
			file: fs.statSync(file).mode & 0o777,
			dir: fs.statSync(sub).mode & 0o777,
		};
		fs.rmSync(dir, { recursive: true, force: true });
		process.stdout.write(JSON.stringify(out));
	`;
	return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

if (process.platform === "win32") {
	// Explicit and self-describing rather than a silent pass: POSIX mode bits
	// are not meaningful on Windows, and production is Linux.
	console.log("  SKIP  behavioural umask probe — POSIX mode bits are not meaningful on win32");
} else {
	const got = modesUnderUmask("0o027");
	check("umask 027 creates files 0640", got.file.toString(8), EXPECTED_FILE_MODE.toString(8));
	check("umask 027 creates dirs 0750", got.dir.toString(8), EXPECTED_DIR_MODE.toString(8));

	// The inherited default, for contrast. If this ever equals the 027 result the
	// probe is measuring nothing.
	const dflt = modesUnderUmask("0o022");
	check("umask 022 creates files 0644 (the bug being fixed)", dflt.file.toString(8), "644");
	check("027 and 022 are distinguishable by this probe", got.file !== dflt.file, true);
	check("0640 denies other entirely", (got.file & 0o007) === 0, true);
	check("0644 grants other read — the exposure", (dflt.file & 0o004) !== 0, true);
}

// ---------------------------------------------------------------------------
// MUTANTS — proof this suite fails against the pre-fix code.
//
// Each rewrites server.js's source in memory into a plausible regression and
// requires structuralFailures() to reject it. A mutant that passes means the
// corresponding property is not actually being tested.
// ---------------------------------------------------------------------------
const mutants = [
	["M1 no umask at all (origin/main)", s => s.replace(/process\.umask\(\s*BOOT_UMASK\s*\)/, "void 0")],
	["M2 umask 022 — the inherited default", s => s.replace(/const\s+BOOT_UMASK\s*=\s*0o027\s*;/, "const BOOT_UMASK = 0o022;")],
	["M3 umask set AFTER the SQLite open", s => {
		// Move the call to the end of the file: the log line still reports 027,
		// but app.db + -wal + -shm and every boot-time mkdir kept mode 0644.
		const call = s.match(/process\.umask\(\s*BOOT_UMASK\s*\)/)[0];
		return s.replace(call, "void 0") + `\n${call};\n`;
	}],
	["M4 umask set inside a function instead of at module load", s => {
		const call = s.match(/process\.umask\(\s*BOOT_UMASK\s*\)/)[0];
		return s.replace(call, "void 0").replace(/^const BOOT_UMASK/m, `function applyUmask() { return ${call}; }\nconst BOOT_UMASK`);
	}],
	["M5 decimal 27 instead of octal 027", s => s.replace(/const\s+BOOT_UMASK\s*=\s*0o027\s*;/, "const BOOT_UMASK = 27;")],
];
for (const [name, mutate] of mutants) {
	const rejected = structuralFailures(mutate(src)).length > 0;
	check(`mutant rejected — ${name}`, rejected, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
