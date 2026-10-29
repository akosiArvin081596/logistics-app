#!/usr/bin/env node
// T-pin: the payout statement's template hash stays the one the stored
// statements were filed under.
//
// WHY THIS EXISTS. Every stored investor statement is keyed on the template
// hash (statementFingerprint() in server.js). A byte change to one of the five
// template files moves it, and every stored statement then re-renders and
// re-issues on its next download. lib/statement-template-hash.js computes the
// hash, and PINS maps a reviewed new value back to the stored one. A change
// that moves the effective value fails here, so it either adds a reviewed PINS
// entry (the new bytes render the same) or re-records RECORDED below, accepting
// that every stored statement re-issues (HIGH: money).
//
//   §1 the module loads; it lists the five files, and is not one of them
//   §2 the effective hash is RECORDED
//   §3 a one-byte change to each file (in a temp copy) moves the hash; a PINS
//      entry for the new value brings it back, for those exact bytes only
//   §4 a changed specifier list moves the hash: a file added, a file dropped,
//      the same file under other text; reordering the list does not
//   §5 the same value from another working directory; the module reads no
//      environment and resolves nothing through the caller
//   §6 PINS and the list are frozen; each entry is 12 hex to 12 hex, none
//      maps to itself and none chains
//   §7 server.js takes its hash from the module, keeps the cache-off rule when
//      the hash can't be computed, and has no second copy of the list or the
//      algorithm
//
// No network, database or server. Temp copies live in a fresh mkdtemp folder,
// removed at the end.
//
//   node scripts/test-statement-template-pin.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { serverSource } = require("./lib/server-source");

// The hash every stored statement is filed under. Change it only in a PR that
// accepts that every stored statement re-issues; an edit that renders the same
// adds a PINS entry instead.
const RECORDED = "cba159821377";

const FIVE = [
	"./lib/payout-statement.js",
	"./lib/broker-invoice.js",
	"./lib/pdf-browser.js",
	"./lib/lease-payout-text.js",
	"./lib/driver-pay-text.js",
];

const ROOT = path.join(__dirname, "..");
const MODULE_REL = "lib/statement-template-hash.js";
const MODULE_FILE = path.join(ROOT, MODULE_REL);
const HEX12 = /^[0-9a-f]{12}$/;
const PINS_ANCHOR = "const PINS = Object.freeze({";
const LIST_RE = /const STATEMENT_TEMPLATE_FILES = Object\.freeze\(\[[^\]]*\]\);/;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
	if (cond) { pass++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function eq(name, got, want) {
	ok(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-template-pin-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

let mod = null;
let moduleSrc = "";
try {
	mod = require(MODULE_FILE);
	moduleSrc = fs.readFileSync(MODULE_FILE, "utf8");
} catch (err) {
	mod = null;
	console.log(`  (module not loaded: ${err.code || err.message})`);
}

// A temp app root holding copies of the files and of the module, so the copy
// hashes its own folder. Every edit is made to the copy's files, never through
// a hook in the module.
let treeCount = 0;
function makeTree({ moduleText = moduleSrc, files = FIVE, edit } = {}) {
	const dir = path.join(TMP, `tree-${++treeCount}`);
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	for (const spec of files) fs.copyFileSync(path.join(ROOT, spec), path.join(dir, spec));
	fs.writeFileSync(path.join(dir, MODULE_REL), moduleText);
	if (edit) edit(dir);
	return dir;
}
function loadFrom(dir) {
	const file = path.join(dir, MODULE_REL);
	delete require.cache[file];
	return require(file);
}
function flipByte(file, at) {
	const buf = fs.readFileSync(file);
	const i = Math.floor(buf.length * at);
	buf[i] ^= 0x01;
	fs.writeFileSync(file, buf);
}
function withPin(text, from, to) {
	return text.replace(PINS_ANCHOR, `${PINS_ANCHOR}\n\t${JSON.stringify(from)}: ${JSON.stringify(to)},\n`);
}
function withList(text, list) {
	return text.replace(LIST_RE, `const STATEMENT_TEMPLATE_FILES = Object.freeze(${JSON.stringify(list)});`);
}

console.log("§1 the module");
ok("§1 lib/statement-template-hash.js loads", !!mod);
if (mod) {
	eq("§1 it lists exactly the five template files", JSON.stringify([...mod.STATEMENT_TEMPLATE_FILES].sort()), JSON.stringify([...FIVE].sort()));
	ok("§1 the module is not one of the hashed files (a PINS entry can't move the value it pins)",
		!mod.STATEMENT_TEMPLATE_FILES.some((s) => path.join(ROOT, s) === MODULE_FILE));
	ok("§1 it exports computeStatementTemplateHash and effectiveStatementTemplateHash",
		typeof mod.computeStatementTemplateHash === "function" && typeof mod.effectiveStatementTemplateHash === "function");
}

const sections = ["§2", "§3", "§4", "§5", "§6"];
if (!mod) {
	for (const s of sections) ok(`${s} not run: the module is missing`, false);
} else {
	const computed = mod.computeStatementTemplateHash();
	const effective = mod.effectiveStatementTemplateHash();

	console.log("§2 the recorded hash");
	eq("§2 the effective hash is the one the stored statements were filed under", effective, RECORDED);
	ok("§2 the computed hash is RECORDED, or PINS maps it there",
		computed === RECORDED || (Object.hasOwn(mod.PINS, computed) && mod.PINS[computed] === RECORDED), computed);

	console.log("§3 a one-byte change to each file");
	ok("§3 the copy-edit hooks are real: PINS's literal appears once in the module",
		moduleSrc.split(PINS_ANCHOR).length === 2);
	const same = loadFrom(makeTree());
	eq("§3 an unchanged copy hashes the same as the app", same.computeStatementTemplateHash(), computed);
	FIVE.forEach((spec) => {
		const name = path.basename(spec);
		const changed = loadFrom(makeTree({ edit: (d) => flipByte(path.join(d, spec), 0.5) }));
		const moved = changed.computeStatementTemplateHash();
		ok(`§3 ${name}: one byte changed moves the computed hash`, HEX12.test(moved) && moved !== computed, moved);
		ok(`§3 ${name}: ...and the effective hash, with no PINS entry`, changed.effectiveStatementTemplateHash() !== effective);

		const pinned = loadFrom(makeTree({ moduleText: withPin(moduleSrc, moved, effective), edit: (d) => flipByte(path.join(d, spec), 0.5) }));
		eq(`§3 ${name}: a PINS entry for the new value gives the stored hash back`, pinned.effectiveStatementTemplateHash(), effective);
		eq(`§3 ${name}: ...while the computed hash still shows the change`, pinned.computeStatementTemplateHash(), moved);

		const again = loadFrom(makeTree({
			moduleText: withPin(moduleSrc, moved, effective),
			edit: (d) => { flipByte(path.join(d, spec), 0.5); flipByte(path.join(d, spec), 0.25); },
		}));
		ok(`§3 ${name}: the entry covers those bytes only; a second change moves it again`,
			again.effectiveStatementTemplateHash() !== effective);
	});

	console.log("§4 the specifier list");
	ok("§4 the copy-edit hooks are real: the list's literal appears once in the module", (moduleSrc.match(new RegExp(LIST_RE.source, "g")) || []).length === 1);
	const listCase = (label, list, wantSame) => {
		const extra = list.filter((s) => !FIVE.includes(s) && fs.existsSync(path.join(ROOT, s)));
		const copy = loadFrom(makeTree({ moduleText: withList(moduleSrc, list), files: [...FIVE, ...extra] }));
		const got = copy.computeStatementTemplateHash();
		if (wantSame) eq(`§4 ${label}`, got, computed);
		else ok(`§4 ${label}`, HEX12.test(got) && got !== computed && copy.effectiveStatementTemplateHash() !== effective, got);
	};
	listCase("a file added moves the hash", [...FIVE, "./lib/app-time.js"], false);
	listCase("a file dropped moves the hash", FIVE.filter((s) => s !== "./lib/driver-pay-text.js"), false);
	listCase("the same file under other text moves the hash (the specifier is part of the digest)",
		FIVE.map((s) => (s === "./lib/pdf-browser.js" ? "lib/pdf-browser.js" : s)), false);
	listCase("the same five in another order give the same hash (the list is sorted)", [...FIVE].reverse(), true);

	console.log("§5 working directory and environment");
	const away = path.join(TMP, "elsewhere");
	fs.mkdirSync(away);
	let child = "";
	try {
		child = execFileSync(process.execPath, ["-e",
			"const m = require(process.argv[1]); process.stdout.write(m.computeStatementTemplateHash() + ' ' + m.effectiveStatementTemplateHash());",
			MODULE_FILE], { cwd: away, env: { PATH: process.env.PATH || "" }, encoding: "utf8" });
	} catch (err) {
		child = `error: ${err.message}`;
	}
	eq("§5 from another working directory, with an empty environment, the same values", child, `${computed} ${effective}`);
	ok("§5 the module reads no environment and no working directory", !/process\.env|process\.cwd/.test(moduleSrc));
	ok("§5 it resolves the files against its own folder, not through the caller's require", !/require\.resolve/.test(moduleSrc) && /path\.join\(__dirname, "\.\."\)/.test(moduleSrc));

	console.log("§6 PINS");
	ok("§6 PINS is frozen", Object.isFrozen(mod.PINS));
	ok("§6 the file list is frozen", Object.isFrozen(mod.STATEMENT_TEMPLATE_FILES));
	const entries = Object.entries(mod.PINS);
	ok("§6 every entry maps 12 hex characters to 12 hex characters", entries.every(([k, v]) => HEX12.test(k) && typeof v === "string" && HEX12.test(v)), JSON.stringify(entries));
	ok("§6 no entry maps a value to itself", entries.every(([k, v]) => k !== v));
	ok("§6 no entry chains (each value is a stored hash, never another entry's key)", entries.every(([, v]) => !Object.hasOwn(mod.PINS, v)));
}

console.log("§7 server.js");
{
	const src = serverSource();
	ok("§7 server.js loads lib/statement-template-hash.js", src.includes('require("./lib/statement-template-hash")'));
	ok("§7 no second copy of the file list in server.js", !/STATEMENT_TEMPLATE_FILES\s*=\s*\[/.test(src));
	ok("§7 no second copy of the algorithm in server.js", !/function computeStatementTemplateHash\s*\(/.test(src) && !/require\.resolve\(spec\)/.test(src));

	// The boot block, lifted and run with a stub module: a hash that can't be
	// computed turns the cache off, and never stops the boot.
	const a = src.indexOf("const statementTemplate = require(");
	const endText = "const STATEMENT_CACHE_ENABLED = !!STATEMENT_TEMPLATE_HASH;";
	const b = src.indexOf(endText, a);
	ok("§7 the boot block is found", a >= 0 && b > a);
	if (a >= 0 && b > a) {
		const block = src.slice(a, b + endText.length);
		const run = (stub) => {
			const logged = [];
			const fn = new Function("require", "console", `${block}\nreturn { STATEMENT_TEMPLATE_HASH, STATEMENT_CACHE_ENABLED };`);
			const out = fn((spec) => {
				if (spec !== "./lib/statement-template-hash") throw new Error(`unexpected require ${spec}`);
				return stub;
			}, { error: (...args) => logged.push(args.join(" ")) });
			return { ...out, logged };
		};
		const good = run({ effectiveStatementTemplateHash: () => "abcdef012345", computeStatementTemplateHash: () => "999999999999" });
		eq("§7 the cache key takes the module's effective hash, not the computed one", good.STATEMENT_TEMPLATE_HASH, "abcdef012345");
		eq("§7 ...and the cache is on", good.STATEMENT_CACHE_ENABLED, true);
		let bad = null;
		try {
			bad = run({ effectiveStatementTemplateHash: () => { throw new Error("EACCES: made-up read failure"); } });
		} catch (err) {
			bad = { threw: err.message };
		}
		ok("§7 a hash that can't be computed never stops the boot", bad && !bad.threw, bad && bad.threw);
		ok("§7 ...it turns the cache off", bad && bad.STATEMENT_CACHE_ENABLED === false && bad.STATEMENT_TEMPLATE_HASH === null);
		ok("§7 ...and says so once", bad && Array.isArray(bad.logged) && bad.logged.length === 1 && /CACHE DISABLED/.test(bad.logged[0]));
	}

	const f = src.indexOf("function statementFingerprint(");
	const body = f >= 0 ? src.slice(f, src.indexOf("\n}\n", f)) : "";
	ok("§7 the statement fingerprint still carries the template hash", /\bSTATEMENT_TEMPLATE_HASH,/.test(body));
	ok("§7 the cache read and write still test STATEMENT_CACHE_ENABLED",
		/if \(STATEMENT_CACHE_ENABLED && cachedName/.test(src) && /if \(!STATEMENT_CACHE_ENABLED\) throw/.test(src));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
