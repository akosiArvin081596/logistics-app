#!/usr/bin/env node
/**
 * Every Chromium this repo starts through Puppeteer is controlled over a pipe
 * (`pipe: true`, which makes Puppeteer pass --remote-debugging-pipe), never
 * over a local debugging port (Puppeteer's default, --remote-debugging-port=0).
 *
 *   §1  lib/pdf-browser.js — the long-lived PDF renderer. A stubbed
 *       puppeteer.launch() captures the options getBrowser() really passes,
 *       in a normal process and in replica mode (which adds its own args).
 *   §2  every puppeteer.launch(...) call in server.js, lib/ and scripts/ —
 *       a static sweep of the option object at each call site, so a launch
 *       added later is held to the same rule.
 *   §3  no file passes a debugging-port or debugging-address argument to a
 *       browser it starts (Playwright's chromium.launch() uses a pipe by
 *       default, so this is the only way one of those could stop doing so).
 *
 * Hermetic: no Chromium is launched. The real-process check (the spawned
 * Chromium's own arguments) is in scripts/test-pdf-cold-start.js §0, which
 * starts a real browser and so runs locally only.
 *
 *   node scripts/test-pdf-browser-pipe.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const SRC_PATH = path.join(ROOT, "lib", "pdf-browser.js");
const SELF = path.resolve(__filename);

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// Built from parts so this file's own text never matches the §3 sweep.
const PORT_ARG_RE = new RegExp("--remote-debugging-" + "(port|address)", "i");

// ── §1 helpers: load lib/pdf-browser.js against a fake puppeteer ────────────
// The require hook stays installed while getBrowser() runs, because the module
// requires ./replica-mode lazily, inside the launch call.
function withFakeRequires(fakes, fn) {
	const orig = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (Object.prototype.hasOwnProperty.call(fakes, id)) return fakes[id];
		return orig.apply(this, arguments);
	};
	delete require.cache[require.resolve(SRC_PATH)];
	const restore = () => {
		Module.prototype.require = orig;
		delete require.cache[require.resolve(SRC_PATH)];
	};
	return Promise.resolve()
		.then(() => fn(require(SRC_PATH)))
		.finally(restore);
}

function fakeBrowser() {
	return {
		connected: true,
		// No process: shutdownBrowser() must have no pid to signal in a test.
		process: () => null,
		on: () => {},
		close: () => Promise.resolve(),
	};
}

async function captureLaunchOptions({ replica }) {
	const calls = [];
	const fakePuppeteer = { launch: async (opts) => { calls.push(opts); return fakeBrowser(); } };
	const fakeReplicaMode = { active: () => replica };
	await withFakeRequires({ puppeteer: fakePuppeteer, "./replica-mode": fakeReplicaMode }, async (m) => {
		await m.getBrowser();
		await m.shutdownBrowser();
	});
	return calls;
}

function checkLaunchOptions(label, calls) {
	ok(calls.length === 1, `${label}: getBrowser() should launch exactly once (got ${calls.length})`);
	const opts = calls[0] || {};
	ok(opts.pipe === true, `${label}: launch options must set pipe: true (got ${JSON.stringify(opts.pipe)})`);
	ok(opts.debuggingPort === undefined, `${label}: launch options must not set debuggingPort`);
	const args = Array.isArray(opts.args) ? opts.args : [];
	ok(args.length > 0, `${label}: launch options should carry the renderer's args`);
	const portArgs = args.filter((a) => PORT_ARG_RE.test(String(a)));
	ok(portArgs.length === 0, `${label}: no debugging port/address argument may be passed (got ${portArgs.join(", ")})`);
}

// ── §2 helpers: static sweep of puppeteer.launch(...) call sites ────────────
function listSourceFiles() {
	const out = [path.join(ROOT, "server.js")];
	const walk = (dir) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (/\.(js|mjs|cjs)$/.test(ent.name)) out.push(p);
		}
	};
	walk(path.join(ROOT, "lib"));
	walk(path.join(ROOT, "scripts"));
	return out.filter((p) => path.resolve(p) !== SELF && fs.existsSync(p));
}

// The code of the balanced (...) that starts at `open` (an index of "("), with
// comments left out. Comments are skipped before quotes are looked at, so an
// apostrophe in a comment ("Puppeteer's") cannot open a phantom string, and
// parentheses inside strings or comments do not count. Enough for an options
// object literal, which holds no regex literals.
function balancedParensCode(src, open) {
	let depth = 0;
	let out = "";
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			if (nl < 0) return null;
			i = nl - 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return null;
			i = end + 1;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
			if (j >= src.length) return null;
			out += src.slice(i, j + 1);
			i = j;
			continue;
		}
		out += c;
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return out;
	}
	return null;
}

// Lines that are wholly a comment are left out of the §3 sweep: a comment may
// name an argument without passing it.
const codeLines = (src) =>
	src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

(async () => {
	// ─────────────────────────── §1 lib/pdf-browser.js, real options captured
	checkLaunchOptions("§1 pdf-browser (normal)", await captureLaunchOptions({ replica: false }));
	const replicaCalls = await captureLaunchOptions({ replica: true });
	checkLaunchOptions("§1 pdf-browser (replica mode)", replicaCalls);
	// Proves the replica-mode stub reached the launch, so the case above is not
	// the normal case twice.
	const offline = require("../lib/replica-rules").CHROMIUM_OFFLINE_ARGS;
	const replicaArgs = (replicaCalls[0] && replicaCalls[0].args) || [];
	ok(offline.every((a) => replicaArgs.includes(a)), "§1 pdf-browser (replica mode): the replica's offline args should be passed");

	// ─────────────────────────── §2 every puppeteer.launch(...) call site
	const LAUNCH_RE = /\bpuppeteer\s*\.\s*launch\s*\(/g;
	const sites = [];
	for (const file of listSourceFiles()) {
		const src = fs.readFileSync(file, "utf8");
		let m;
		LAUNCH_RE.lastIndex = 0;
		while ((m = LAUNCH_RE.exec(src))) {
			const open = m.index + m[0].length - 1;
			const line = src.slice(0, m.index).split("\n").length;
			sites.push({ where: `${path.relative(ROOT, file)}:${line}`, code: balancedParensCode(src, open) });
		}
	}
	const where = sites.map((s) => s.where);
	ok(where.some((w) => w.startsWith("lib/pdf-browser.js:")), `§2 the sweep should find the launch in lib/pdf-browser.js (found ${where.join(", ") || "none"})`);
	ok(where.some((w) => w.startsWith("scripts/docs/capture-driver-video.js:")), `§2 the sweep should find the launch in scripts/docs/capture-driver-video.js (found ${where.join(", ") || "none"})`);
	for (const s of sites) {
		ok(s.code !== null, `§2 ${s.where}: could not read the launch call's arguments`);
		if (s.code === null) continue;
		ok(/\bpipe\s*:\s*true\b/.test(s.code), `§2 ${s.where}: puppeteer.launch() must pass pipe: true`);
		ok(!/\bdebuggingPort\s*:/.test(s.code), `§2 ${s.where}: puppeteer.launch() must not pass debuggingPort`);
	}

	// ─────────────────────────── §3 no debugging port/address argument anywhere
	for (const file of listSourceFiles()) {
		const code = codeLines(fs.readFileSync(file, "utf8"));
		ok(!PORT_ARG_RE.test(code), `§3 ${path.relative(ROOT, file)}: passes a remote debugging port/address argument`);
	}

	if (failures.length) {
		console.error(`test-pdf-browser-pipe: ${failures.length} failure(s), ${pass} passed`);
		for (const f of failures) console.error("  FAIL " + f);
		process.exit(1);
	}
	console.log(`test-pdf-browser-pipe: all ${pass} checks passed (${sites.length} puppeteer launch site(s))`);
})().catch((err) => {
	console.error("test-pdf-browser-pipe: crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
