#!/usr/bin/env node
/**
 * Boundary checks on the unauthenticated public form routes:
 *
 *     POST /api/public/apply
 *     POST /api/public/investor-apply
 *     POST /api/public/investor-preview-pdf/:docKey
 *     POST /api/public/investor-onboarding/:id/sign/:docKey
 *     POST /api/public/investor-onboarding/:id/vehicles
 *     POST /api/public/investor-onboarding/:id/banking
 *
 * All of them take their input from anyone on the internet. The checks live
 * ONCE, in lib/public-form-input.js, and every route calls them.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 checkPublicEmail(): exactly one well-formed, printable-ASCII address.
 *      Recipient lists, CR/LF, mail syntax, non-ASCII and non-strings refused.
 *   §2 the length cap runs BEFORE any pattern (source order), and an oversized
 *      value is refused quickly (coarse timing guard)
 *   §3 the email pattern itself stays fast on long adversarial input, including
 *      long INTERNAL whitespace runs (pattern called directly, cap bypassed)
 *   §4 checkPublicVehicles(): malformed entries and fields are refused; the
 *      /invest wizard's real payload passes through unchanged
 *   §5 checkPublicScalars(): every field a route binds is ONE scalar
 *   §6 wiring: every route runs the checks before its first write, render or
 *      email, and each route's field list matches what the route destructures
 *   §7 the two application routes respond at most once — each route's real
 *      error handler executed against a real Express response on a bare
 *      http.ServerResponse; any public route that sends mail after
 *      responding must guard its catch
 *   §8 DISCRIMINATION — defang each guard, require the assertion to flip
 *
 * TIMING. Every timed call runs in a CHILD process with a hard kill, so a
 * regression fails in seconds instead of hanging the runner, and the budget is
 * deliberately generous: the linear code takes a few milliseconds, and the
 * check exists to catch growth with input length, not to benchmark.
 *
 * Pure: no server, no app.db, no network, no fixtures.
 *
 * Run: node scripts/test-public-form-input.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB_PATH = path.join(ROOT, "lib", "public-form-input.js");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const pfi = require(LIB_PATH);

const TIMING_BUDGET_MS = 200;
const BIG = 1 << 20; // characters per adversarial input

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}
const ch = (code) => String.fromCharCode(code);

// --- source helpers --------------------------------------------------------
// Paren-count a route registration out of server.js (same approach as
// test-invoice-owner-guard.js). Route bodies close over db/res/fs, so they are
// asserted as TEXT; the parts that matter are extracted and executed below.
function routeSource(verb, routePath, src = SRC) {
	const needle = `app.${verb}("${routePath}"`;
	const at = src.indexOf(needle);
	if (at < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	let depth = 0;
	for (let j = src.indexOf("(", at); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}
// Drop full-line `//` comments. Several of these routes mention renderPolicy()
// or buildInvestorDocRender() in prose ABOVE the check, and a source-order
// assertion must read the code, not the commentary.
function codeOnly(src) {
	return src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}
// Body of a `function name(...) { ... }`, skipping the parameter list first.
function fnSource(name, src) {
	const a = src.indexOf(`function ${name}(`);
	if (a < 0) throw new Error(`function ${name} not found`);
	let depth = 0, j = src.indexOf("(", a);
	for (; j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")" && --depth === 0) break;
	}
	depth = 0;
	for (let k = src.indexOf("{", j); k < src.length; k++) {
		if (src[k] === "{") depth++;
		else if (src[k] === "}" && --depth === 0) return src.slice(a, k + 1);
	}
	throw new Error(`unbalanced braces in ${name}`);
}
// The string list assigned to `const NAME = [ ... ];` in server.js, or null
// when there is no such constant (reported as a failure, not a crash).
function constList(name, src = SRC) {
	const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
	if (!m) return null;
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
// The names a route destructures from req.body.
function bodyFields(routeSrc) {
	const m = routeSrc.match(/const \{([^}]*)\} = req\.body;/);
	if (!m) throw new Error("no req.body destructuring");
	return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}
const sameSet = (a, b) => !!a && !!b && a.length === b.length && [...a].sort().join() === [...b].sort().join();
// Load a (possibly mutated) copy of the lib without touching the real module.
function loadLib(src) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, require);
	return mod.exports;
}
// Run a timing probe in a child process. `mode` picks what is timed:
//   "checker" -> checkPublicEmail(s).reason        (the full boundary check)
//   "pattern" -> new RegExp(patternSource).test(s)  (a pattern alone)
// Returns { killed, results: [{ label, ms, result }] }.
const PROBE = `
const [libPath, mode, patternSource, big] = process.argv.slice(1);
const m = require(libPath);
const N = Number(big);
const re = mode === "pattern" ? new RegExp(patternSource) : null;
const ch = (c) => String.fromCharCode(c);
const shapes = {
	"adversarial input 1": "a@" + ".".repeat(N) + " ",
	"adversarial input 2": "a@" + "a.".repeat(N / 2) + " ",
	"adversarial input 3": "a@" + "a.".repeat(N / 2),
	"adversarial input 4": "@".repeat(N),
	"adversarial input 5": "a".repeat(N) + "@",
	"adversarial input 6": "a@" + "b".repeat(N),
	"INTERNAL whitespace run, domain": "a@b" + " ".repeat(N) + ".com",
	"INTERNAL whitespace run, local part": "a" + " ".repeat(N) + "b@example.com",
	"INTERNAL whitespace run, non-ASCII": "a@b" + ch(0xa0).repeat(N) + ".com",
	"INTERNAL whitespace run, line separators": "a@b" + ch(0x2028).repeat(N) + ".com",
};
const out = [];
for (const [label, s] of Object.entries(shapes)) {
	let best = Infinity, result;
	for (let k = 0; k < 3; k++) {
		const t = process.hrtime.bigint();
		result = mode === "pattern" ? re.test(s) : m.checkPublicEmail(s).reason;
		best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
	}
	out.push({ label, ms: best, result });
}
process.stdout.write(JSON.stringify(out));
`;
const SHAPES = 10;
// The hard kill sits well inside run-unit-tests.js's per-runner timeout, so a
// regression reports here, by name, instead of as an anonymous runner timeout.
function probe(mode, patternSource, { timeoutMs = 20000 } = {}) {
	const r = spawnSync(process.execPath, ["-e", PROBE, LIB_PATH, mode, patternSource || "", String(BIG)], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 1 << 20,
	});
	if (r.signal || r.status !== 0) return { killed: true, signal: r.signal, stderr: (r.stderr || "").slice(0, 300), results: [] };
	return { killed: false, results: JSON.parse(r.stdout) };
}

// ===========================================================================
console.log("\n§1  checkPublicEmail() — one well-formed address");
// ===========================================================================
const accept = [
	"jane@example.com",
	"jane.doe+loads@sub.example.co.uk",
	"o'brien@example.com",
	"first_last-1@ex-ample.com",
	"UPPER@EXAMPLE.COM",
	"user=tag@example.com",
	"a@xn--bcher-kva.de", // an internationalized domain, in its ASCII (punycode) form
	// exactly EMAIL_MAX_LENGTH characters
	"a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(57) + ".com",
];
ok("the longest fixture is exactly EMAIL_MAX_LENGTH long", accept[accept.length - 1].length === pfi.EMAIL_MAX_LENGTH);
for (const e of accept) {
	const r = pfi.checkPublicEmail(e);
	ok(`accepts ${JSON.stringify(e.length > 40 ? e.slice(0, 20) + "…" : e)} and returns it unchanged`, r.ok === true && r.value === e);
}

const refuse = [
	// recipient lists — the reason they get their own message
	["comma list", "a@example.com,b@example.org", "multiple"],
	["comma list with space", "a@example.com, b@example.org", "multiple"],
	["semicolon list", "a@example.com;b@example.org", "multiple"],
	["space-separated pair", "a@example.com b@example.org", "multiple"],
	["group syntax", "grp: a@example.com, b@example.org;", "multiple"],
	["trailing comma", "a@example.com,", "multiple"],
	["two @", "a@b@example.com", "multiple"],
	// CR/LF and header injection
	["CRLF + Bcc header", "a@example.com\r\nBcc: b@example.org", "multiple"],
	["CRLF + extra header, single @", "a@example.com\r\nX-Extra: 1", "invalid"],
	["trailing LF", "a@example.com\n", "invalid"],
	["trailing CR", "a@example.com\r", "invalid"],
	["leading CRLF", "\r\na@example.com", "invalid"],
	["LF inside", "a@exa\nmple.com", "invalid"],
	["Unicode line separator", "a@example.com" + ch(0x2028), "invalid"],
	// mail syntax that names a different or additional recipient
	["display name + angle address", "Name <a@example.com>", "invalid"],
	["bare angle address", "<a@example.com>", "invalid"],
	["angle bracket in local part", "Name<a@example.com", "invalid"],
	["comment", "a@example.com(comment)", "invalid"],
	["quoted local part", "\"a b\"@example.com", "invalid"],
	["domain literal", "a@[127.0.0.1]", "invalid"],
	["backslash", "a\\b@example.com", "invalid"],
	["colon", "a:b@example.com", "invalid"],
	// characters that change the meaning of a mailto: link
	["query in the local part", "a?bcc=b@example.org", "invalid"],
	["query in the domain", "a@example.com?subject=x", "invalid"],
	["fragment", "a#b@example.com", "invalid"],
	["percent-encoding", "a%3Fb@example.com", "invalid"],
	// control characters
	["NUL", "a\x00b@example.com", "invalid"],
	["BEL in domain", "a@exa\x07mple.com", "invalid"],
	["DEL", "a@example.com\x7f", "invalid"],
	["C1 NEL", "a@example.com\x85", "invalid"],
	// non-ASCII: a mail library may rewrite it, or it may display as something else
	["non-ASCII local part", "jos" + ch(0xe9) + "@example.com", "invalid"],
	["non-ASCII domain", "a@b" + ch(0xfc) + "cher.de", "invalid"],
	["ideographic full stop", "a@example" + ch(0x3002) + "com", "invalid"],
	["fullwidth full stop", "a@example" + ch(0xff0e) + "com", "invalid"],
	["halfwidth ideographic full stop", "a@example" + ch(0xff61) + "com", "invalid"],
	["zero-width space", "a" + ch(0x200b) + "b@example.com", "invalid"],
	["bidirectional override", "a" + ch(0x202e) + "b@example.com", "invalid"],
	["byte-order mark", ch(0xfeff) + "a@example.com", "invalid"],
	// whitespace
	["leading space", " a@example.com", "invalid"],
	["trailing space", "a@example.com ", "invalid"],
	["space before @", "a @example.com", "invalid"],
	["tab", "a@example.com\t", "invalid"],
	["non-breaking space", "a\xa0b@example.com", "invalid"],
	// structure
	["empty", "", "invalid"],
	["no @", "plain", "invalid"],
	["empty local part", "@example.com", "invalid"],
	["empty domain", "a@", "invalid"],
	["no dot in domain", "a@example", "invalid"],
	["leading dot in domain", "a@.example.com", "invalid"],
	["double dot in domain", "a@example..com", "invalid"],
	["trailing dot in domain", "a@example.com.", "invalid"],
	["underscore in domain", "a@exa_mple.com", "invalid"],
	// length
	["one character over the cap", "a".repeat(65) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(57) + ".com", "too_long"],
];
for (const [label, value, reason] of refuse) {
	const r = pfi.checkPublicEmail(value);
	ok(`refuses ${label} (${reason})`, r.ok === false && r.reason === reason && typeof r.message === "string" && r.message.length > 0);
}
for (const [label, value] of [["null", null], ["undefined", undefined], ["number", 42], ["array", ["a@example.com"]],
	["object with toString", { toString() { return "a@example.com"; } }], ["boolean", true]]) {
	const r = pfi.checkPublicEmail(value);
	ok(`refuses a non-string (${label}) without throwing`, r.ok === false && r.reason === "invalid");
}
ok("a list gets a message that says to enter ONE address",
	/single/i.test(pfi.checkPublicEmail("a@example.com, b@example.org").message));

// ===========================================================================
console.log("\n§2  the length cap runs before any pattern");
// ===========================================================================
const REGEX_CALL = /\.(?:test|match|matchAll|exec|replace|replaceAll|search|split)\(/;
function capPrecedesPattern(libSrc) {
	const body = fnSource("checkPublicEmail", libSrc);
	const cap = body.indexOf("raw.length > EMAIL_MAX_LENGTH");
	const type = body.indexOf('typeof raw !== "string"');
	const firstRegex = body.search(REGEX_CALL);
	return type >= 0 && cap > type && firstRegex > cap;
}
ok("checkPublicEmail(): type test, then the length cap, then the first pattern call", capPrecedesPattern(LIB_SRC));
ok("EMAIL_MAX_LENGTH is the RFC 5321 figure (254)", pfi.EMAIL_MAX_LENGTH === 254);

const capRun = probe("checker");
ok("the timing probe ran to completion", !capRun.killed);
ok("the timing probe covered every input", capRun.results.length === SHAPES);
for (const { label, ms, result } of capRun.results) {
	ok(`oversized ${label} is refused as too_long in < ${TIMING_BUDGET_MS} ms [${ms.toFixed(2)} ms]`,
		result === "too_long" && ms < TIMING_BUDGET_MS);
}

// ===========================================================================
console.log("\n§3  the pattern itself stays fast — called directly, cap bypassed");
// ===========================================================================
const patRun = probe("pattern", pfi.EMAIL_RE.source);
ok("the pattern probe ran to completion", !patRun.killed);
ok("the pattern probe covered every input", patRun.results.length === SHAPES);
for (const { label, ms, result } of patRun.results) {
	ok(`EMAIL_RE on ${label}: no match, < ${TIMING_BUDGET_MS} ms [${ms.toFixed(2)} ms]`, result === false && ms < TIMING_BUDGET_MS);
}
ok("EMAIL_RE is anchored at both ends", pfi.EMAIL_RE.source.startsWith("^") && pfi.EMAIL_RE.source.endsWith("$"));
// With the `m` flag, ^ and $ would anchor at line breaks, and a value with a
// CR/LF tail could match its first line.
ok("EMAIL_RE carries no flags (no `m`, so ^ and $ anchor the whole value)", pfi.EMAIL_RE.flags === "");

// ===========================================================================
console.log("\n§4  checkPublicVehicles() — shape of every entry");
// ===========================================================================
// Exactly what InvestorApplyView.vue posts (emptyVehicle() minus the stripped
// photo fields), with realistic values: text everywhere, numbers for year and
// purchase price.
const wizardVehicle = () => ({
	make: "Volvo", model: "VNL 760", year: 2022, vin: "4V4NC9EH5NN000001",
	licensePlate: "", status: "Active", mileage: "120,000", titleState: "Texas",
	liens: "", registeredOwner: "", notes: "", purchasePrice: 0, titleStatus: "Clean",
});
const fleet = [wizardVehicle(), wizardVehicle()];
const pass = pfi.checkPublicVehicles(fleet);
ok("the wizard's real payload passes, returned unchanged (same array)", pass.ok === true && pass.value === fleet);
ok("undefined means no vehicles", pfi.checkPublicVehicles(undefined).ok === true && pfi.checkPublicVehicles(undefined).value.length === 0);
ok("null means no vehicles", pfi.checkPublicVehicles(null).ok === true && pfi.checkPublicVehicles(null).value.length === 0);
ok("an empty list passes", pfi.checkPublicVehicles([]).ok === true);
ok("a null field is allowed (every consumer reads it as blank)",
	pfi.checkPublicVehicles([{ ...wizardVehicle(), liens: null }]).ok === true);
ok("year and purchase price may be text as well as numbers",
	pfi.checkPublicVehicles([{ ...wizardVehicle(), year: "2019", purchasePrice: "85000" }]).ok === true);
ok(`a field of exactly VEHICLE_FIELD_MAX_LENGTH (${pfi.VEHICLE_FIELD_MAX_LENGTH}) characters passes`,
	pfi.checkPublicVehicles([{ ...wizardVehicle(), liens: "x".repeat(pfi.VEHICLE_FIELD_MAX_LENGTH) }]).ok === true);
ok(`exactly VEHICLES_MAX (${pfi.VEHICLES_MAX}) vehicles pass`,
	pfi.checkPublicVehicles(Array.from({ length: pfi.VEHICLES_MAX }, wizardVehicle)).ok === true);

const badVehicles = [
	["a null entry", [null], "entry", 0],
	["a null entry later in the list", [wizardVehicle(), null], "entry", 1],
	["a string entry", [wizardVehicle(), "abc"], "entry", 1],
	["a number entry", [42], "entry", 0],
	["a boolean entry", [true], "entry", 0],
	["an array entry", [[]], "entry", 0],
	["a nested object field", [{ ...wizardVehicle(), make: { toString: 1 } }], "field", 0],
	["an array field", [{ ...wizardVehicle(), vin: ["x"] }], "field", 0],
	["a number in a text field", [{ ...wizardVehicle(), vin: 12345 }], "field", 0],
	["a boolean field", [{ ...wizardVehicle(), liens: true }], "field", 0],
	["an over-long text field", [{ ...wizardVehicle(), make: "x".repeat(pfi.VEHICLE_FIELD_MAX_LENGTH + 1) }], "field", 0],
	["an object as the list", { 0: wizardVehicle() }, "not_a_list", undefined],
	["a string as the list", "Volvo", "not_a_list", undefined],
	["one over VEHICLES_MAX", Array.from({ length: pfi.VEHICLES_MAX + 1 }, wizardVehicle), "too_many", undefined],
];
for (const [label, value, reason, index] of badVehicles) {
	let r, threw = false;
	try { r = pfi.checkPublicVehicles(value); } catch { threw = true; }
	ok(`refuses ${label} (${reason})`, !threw && r.ok === false && r.reason === reason &&
		r.index === index && typeof r.message === "string" && r.message.length > 0);
}

// ===========================================================================
console.log("\n§5  checkPublicScalars() — every bound field is ONE scalar");
// ===========================================================================
const scalarOk = [["a string", "x"], ["an empty string", ""], ["a number", 7], ["zero", 0], ["null", null], ["absent", undefined]];
for (const [label, v] of scalarOk) {
	ok(`allows ${label}`, pfi.checkPublicScalars({ f: v }, ["f"]).ok === true);
}
const scalarBad = [["an array", ["x"]], ["an empty array", []], ["an object", { a: 1 }], ["an empty object", {}],
	["a boolean", true], ["NaN", NaN], ["Infinity", Infinity], ["a function", () => 1]];
for (const [label, v] of scalarBad) {
	const r = pfi.checkPublicScalars({ other: "x", f: v }, ["other", "f"]);
	ok(`refuses ${label}, naming the field`, r.ok === false && r.reason === "not_scalar" && r.field === "f" && r.message.length > 0);
}
ok("only the listed fields are checked", pfi.checkPublicScalars({ unlisted: [1] }, ["f"]).ok === true);
ok("a missing or non-object source has no fields to refuse",
	pfi.checkPublicScalars(undefined, ["f"]).ok === true && pfi.checkPublicScalars("str", ["f"]).ok === true);

// ===========================================================================
console.log("\n§6  wiring — every public route runs the checks before using the input");
// ===========================================================================
// true when `call` appears, and appears before every `later` needle present.
function callsFirst(src, call, later) {
	const at = src.indexOf(call);
	if (at < 0) return false;
	return later.every((n) => { const i = src.indexOf(n); return i < 0 || i > at; });
}
const refusesWith400 = (src, v) =>
	new RegExp(`if \\(!${v}\\.ok\\) \\{\\s*return res\\.status\\(400\\)\\.json\\(\\{ error: ${v}\\.message`).test(src);

const INVEST_RAW = routeSource("post", "/api/public/investor-apply");
const APPLY = codeOnly(routeSource("post", "/api/public/apply"));
const INVEST = codeOnly(INVEST_RAW);
const PREVIEW = codeOnly(routeSource("post", "/api/public/investor-preview-pdf/:docKey"));
const SIGN = codeOnly(routeSource("post", "/api/public/investor-onboarding/:id/sign/:docKey"));
const VEHICLES = codeOnly(routeSource("post", "/api/public/investor-onboarding/:id/vehicles"));
const BANKING = codeOnly(routeSource("post", "/api/public/investor-onboarding/:id/banking"));

function applyWired(src) {
	const later = ["db.prepare(", "sendEmail(", "logAudit("];
	return callsFirst(src, "publicFormInput.checkPublicScalars(req.body, PUBLIC_APPLY_SCALAR_FIELDS)", later) &&
		callsFirst(src, "publicFormInput.checkPublicEmail(email)", later) &&
		refusesWith400(src, "shape") && refusesWith400(src, "emailCheck");
}
function investWired(src) {
	const later = ["db.transaction(", "applyTx()", "buildInvestorDocRender(", "sendEmail(", "vehiclesArr.map("];
	return callsFirst(src, "publicFormInput.checkPublicScalars(req.body, PUBLIC_INVESTOR_SCALAR_FIELDS)", later) &&
		callsFirst(src, "publicFormInput.checkPublicScalars(banking, PUBLIC_BANKING_SCALAR_FIELDS)", later) &&
		callsFirst(src, 'publicFormInput.checkPublicScalars(sig, ["image"])', later) &&
		callsFirst(src, 'typeof sig.text !== "string"', later) &&
		callsFirst(src, "publicFormInput.checkPublicEmail(email)", later) &&
		callsFirst(src, "publicFormInput.checkPublicVehicles(vehicles)", later) &&
		refusesWith400(src, "shape") && refusesWith400(src, "bankingShape") && refusesWith400(src, "sigShape") &&
		refusesWith400(src, "emailCheck") && refusesWith400(src, "vehicleCheck") &&
		src.includes("const vehiclesArr = vehicleCheck.value;");
}
ok("POST /api/public/apply: fields and email checked before the first query, audit row or email; 400 on refusal",
	applyWired(APPLY));
ok("POST /api/public/investor-apply: fields, banking, signatures, email and vehicles checked before the transaction, renders and emails; 400 on refusal",
	investWired(INVEST));
ok("POST /api/public/investor-preview-pdf: vehicles checked before either renderer; 400 on refusal",
	callsFirst(PREVIEW, "publicFormInput.checkPublicVehicles(vehicles)", ["renderPolicy(", "fillW9Form("]) &&
	refusesWith400(PREVIEW, "vehicleCheck") && PREVIEW.includes("const vehiclesArr = vehicleCheck.value;"));
ok("POST /api/public/investor-onboarding/:id/sign: signature and vehicles checked before the first query and the render; 400 on refusal",
	callsFirst(SIGN, 'typeof signatureText !== "string"', ["db.prepare(", "buildInvestorDocRender("]) &&
	callsFirst(SIGN, 'publicFormInput.checkPublicScalars(req.body, ["signatureImage"])', ["db.prepare(", "buildInvestorDocRender("]) &&
	callsFirst(SIGN, "publicFormInput.checkPublicVehicles(", ["UPDATE investor_applications SET", "buildInvestorDocRender("]) &&
	refusesWith400(SIGN, "sigShape") && refusesWith400(SIGN, "vehicleCheck") &&
	SIGN.includes("const vehiclesArr = vehicleCheck.value;"));
ok("POST /api/public/investor-onboarding/:id/vehicles: vehicles checked before the first write; 400 on refusal",
	callsFirst(VEHICLES, "publicFormInput.checkPublicVehicles(vehicles)", ["db.prepare("]) &&
	refusesWith400(VEHICLES, "vehicleCheck") && VEHICLES.includes("const vehiclesArr = vehicleCheck.value;"));
ok("POST /api/public/investor-onboarding/:id/banking: fields checked before the first query; 400 on refusal",
	callsFirst(BANKING, "publicFormInput.checkPublicScalars(req.body, PUBLIC_BANKING_SCALAR_FIELDS)", ["db.prepare("]) &&
	refusesWith400(BANKING, "bankingShape"));

// Each field list must be exactly what its route binds, or the check quietly
// stops covering a new field.
const applyList = constList("PUBLIC_APPLY_SCALAR_FIELDS");
const investorList = constList("PUBLIC_INVESTOR_SCALAR_FIELDS");
const bankingList = constList("PUBLIC_BANKING_SCALAR_FIELDS");
const APPLY_SERIALIZED = ["availability", "reference_info"];
ok("PUBLIC_APPLY_SCALAR_FIELDS = every field /api/public/apply destructures, less the two it serializes",
	sameSet(applyList, bodyFields(APPLY).filter((f) => !APPLY_SERIALIZED.includes(f))));
ok("…and the route really does serialize those two before binding",
	/JSON\.stringify\(availability \|\| \[\]\)/.test(APPLY) &&
	/typeof reference_info === 'string' \? reference_info : JSON\.stringify\(reference_info/.test(APPLY));
ok("PUBLIC_INVESTOR_SCALAR_FIELDS = every field /api/public/investor-apply destructures, less vehicles/banking/signatures",
	sameSet(investorList, bodyFields(INVEST).filter((f) => !["vehicles", "banking", "signatures"].includes(f))));
ok("PUBLIC_BANKING_SCALAR_FIELDS = every field the onboarding banking route destructures",
	sameSet(bankingList, bodyFields(BANKING)));
ok("…and every banking field investor-apply binds is in PUBLIC_BANKING_SCALAR_FIELDS",
	!!bankingList && [...INVEST.matchAll(/banking\.([a-z_]+)/g)].every(([, f]) => bankingList.includes(f)));

// The general rules, so a NEW public route cannot quietly skip them.
const PUBLIC_ROUTES = [...SRC.matchAll(/app\.(get|post|put|patch|delete)\("(\/api\/public\/[^"]+)"/g)]
	.map(([, verb, p]) => ({ label: `${verb.toUpperCase()} ${p}`, src: codeOnly(routeSource(verb, p)) }));
ok("found the public routes to sweep", PUBLIC_ROUTES.length >= 9);
ok("the previous inline email pattern is gone from server.js", !SRC.includes("/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/"));
ok("no public route runs its own pattern on `email`",
	!PUBLIC_ROUTES.some(({ src }) => /\.(?:test|match|exec)\((?:String\()?email\b/.test(src)));
for (const { label, src } of PUBLIC_ROUTES) {
	if (/sendEmail\(\s*email\b/.test(src)) {
		ok(`${label} mails the request's \`email\` only after checkPublicEmail()`,
			callsFirst(src, "publicFormInput.checkPublicEmail(email)", ["sendEmail("]));
	}
	if (/\{[^}]*\b(?:vehicles|vehicleInfo)\b[^}]*\}\s*=\s*req\.body/.test(src)) {
		ok(`${label} reads vehicles from the body only through checkPublicVehicles()`,
			src.includes("publicFormInput.checkPublicVehicles(") && src.includes("const vehiclesArr = vehicleCheck.value;"));
	}
	if (/= req\.body/.test(src) && /\.run\(/.test(src)) {
		ok(`${label} binds request fields only after a shared check`,
			callsFirst(src, "publicFormInput.check", [".run("]));
	}
}

// ===========================================================================
console.log("\n§7  the application routes respond at most once (real Express response, no socket)");
// ===========================================================================
const express = require(path.join(ROOT, "node_modules", "express"));
const app = express();
function reqRes() {
	const req = new http.IncomingMessage(null);
	req.method = "POST";
	req.url = "/";
	req.headers = {};
	const res = new http.ServerResponse(req);
	Object.setPrototypeOf(req, app.request);
	Object.setPrototypeOf(res, app.response);
	req.res = res; res.req = req; req.app = app; res.app = app;
	return { req, res };
}
function finalCatchBody(routeSrc) {
	const at = routeSrc.lastIndexOf("} catch (err) {");
	if (at < 0) throw new Error("no final catch in route");
	const open = routeSrc.indexOf("{", at + 1);
	let depth = 0;
	for (let k = open; k < routeSrc.length; k++) {
		if (routeSrc[k] === "{") depth++;
		else if (routeSrc[k] === "}" && --depth === 0) return routeSrc.slice(open + 1, k);
	}
	throw new Error("unbalanced catch");
}
const isAsyncRoute = (routeSrc) => /,\s*async \(req, res\) =>/.test(routeSrc);
// Wrap a route's REAL catch body in a handler of the same kind as the route
// (async or not) that fails either after or before it has answered, as the
// route body can.
function harness(catchBody, afterResponse, isAsync) {
	const logs = [];
	const quietConsole = { error: (...a) => logs.push(a.join(" ")), log() {}, warn() {} };
	const handler = new Function("console", `return ${isAsync ? "async " : ""}(req, res) => {
		try {
			${afterResponse ? 'res.json({ success: true });' : ""}
			throw new Error("step failed");
		} catch (err) {${catchBody}}
	};`)(quietConsole);
	return { handler, logs };
}
// `escaped` is whatever left the handler: a synchronous throw or a rejection.
async function runCase(catchBody, afterResponse, isAsync) {
	const { req, res } = reqRes();
	const { handler, logs } = harness(catchBody, afterResponse, isAsync);
	let escaped = null;
	try {
		const out = handler(req, res);
		if (out && typeof out.then === "function") await out.catch((e) => { escaped = e; });
	} catch (e) {
		escaped = e;
	}
	return { res, logs, escaped };
}
// The two routes that send mail after their success response.
const APPLY_RAW = routeSource("post", "/api/public/apply");
const RESPOND_THEN_MAIL = [
	{ label: "POST /api/public/apply", raw: APPLY_RAW },
	{ label: "POST /api/public/investor-apply", raw: INVEST_RAW },
];
const UNGUARDED_CATCH = "\n\t\tres.status(500).json({ error: err.message });\n\t";

// A public route that keeps working after its success response must not
// answer again from its catch. A NEW route of that shape is held to the same
// rule.
let mailsAfterResponding = 0;
for (const { label, src } of PUBLIC_ROUTES) {
	const answered = src.indexOf("res.json(");
	if (answered >= 0 && src.indexOf("sendEmail(", answered) > answered) {
		mailsAfterResponding++;
		ok(`${label} sends mail after responding, so its catch checks res.headersSent`,
			finalCatchBody(src).includes("res.headersSent"));
	}
}
ok("the sweep found the routes that send mail after responding", mailsAfterResponding >= RESPOND_THEN_MAIL.length);
ok("the harness mirrors each route: /apply is synchronous, investor-apply is async",
	!isAsyncRoute(APPLY_RAW) && isAsyncRoute(INVEST_RAW));

(async () => {
	for (const { label, raw } of RESPOND_THEN_MAIL) {
		const catchBody = finalCatchBody(raw);
		const after = await runCase(catchBody, true, isAsyncRoute(raw));
		ok(`${label}: an error after the response does not escape the handler`, after.escaped === null);
		ok(`${label}: …the response already sent stands`, after.res.statusCode === 200 && after.res.headersSent === true);
		ok(`${label}: …and the error is logged, not swallowed`, after.logs.some((l) => /step failed/.test(l)));
		const before = await runCase(catchBody, false, isAsyncRoute(raw));
		ok(`${label}: an error before any response still answers 500`, before.escaped === null && before.res.statusCode === 500);
	}

	// =========================================================================
	console.log("\n§8  DISCRIMINATION — defang each guard, require the assertion to flip");
	// =========================================================================
	const unguarded = await runCase(UNGUARDED_CATCH, true, true);
	ok("MUTANT: an async error handler that always responds is caught by §7",
		!!unguarded.escaped && unguarded.escaped.code === "ERR_HTTP_HEADERS_SENT");
	const applyCatch = finalCatchBody(APPLY_RAW);
	const applyUnguarded = applyCatch.replace("if (res.headersSent) return;", "");
	const applyMutant = await runCase(applyUnguarded, true, false);
	ok("MUTANT: /apply's catch without its guard lets the error escape",
		applyUnguarded !== applyCatch && !!applyMutant.escaped && applyMutant.escaped.code === "ERR_HTTP_HEADERS_SENT");

	const noCap = LIB_SRC.replace('if (raw.length > EMAIL_MAX_LENGTH) return emailRefusal("too_long");', "");
	ok("MUTANT: removing the length cap is caught by the source-order check",
		noCap !== LIB_SRC && !capPrecedesPattern(noCap));
	const capAfter = noCap.replace('if (!EMAIL_RE.test(raw)) return emailRefusal("invalid");',
		'if (!EMAIL_RE.test(raw)) return emailRefusal("invalid");\n\tif (raw.length > EMAIL_MAX_LENGTH) return emailRefusal("too_long");');
	ok("MUTANT: moving the cap after the pattern is caught too", capAfter !== noCap && !capPrecedesPattern(capAfter));

	// The shape the lib's own comment forbids: two adjacent quantifiers that
	// accept the same character. The §3 budget must not be passable by it.
	const antiPattern = "^[^@]*[^@]*!$";
	const antiRun = probe("pattern", antiPattern, { timeoutMs: 1500 });
	ok("MUTANT: a pattern with two adjacent quantifiers over one class cannot pass the §3 budget",
		antiRun.killed || antiRun.results.some((r) => r.ms >= TIMING_BUDGET_MS));

	const noEntryCheck = loadLib(LIB_SRC.replace('if (!isPlainObject(v)) return vehicleRefusal("entry", i);', ""));
	let mutantThrew = false;
	try { noEntryCheck.checkPublicVehicles([wizardVehicle(), null]); } catch { mutantThrew = true; }
	ok("MUTANT: without the entry check a null vehicle throws instead of being refused", mutantThrew);
	const anyNumber = loadLib(LIB_SRC.replace("VEHICLE_NUMBER_FIELDS.has(key)", "true"));
	ok("MUTANT: allowing numbers in every vehicle field lets a numeric VIN through",
		anyNumber.checkPublicVehicles([{ vin: 12345 }]).ok === true);
	const arraysAllowed = loadLib(LIB_SRC.replace("function isScalar(v) {\n\treturn ", "function isScalar(v) {\n\treturn Array.isArray(v) || "));
	ok("MUTANT: a scalar check that lets arrays through is caught by §5",
		arraysAllowed.checkPublicScalars({ f: ["x"] }, ["f"]).ok === true);

	ok("MUTANT: dropping the email check from /api/public/apply is caught",
		!applyWired(APPLY.replace("publicFormInput.checkPublicEmail(email)", "({ ok: true })")));
	ok("MUTANT: dropping the field check from /api/public/apply is caught",
		!applyWired(APPLY.replace("publicFormInput.checkPublicScalars(req.body, PUBLIC_APPLY_SCALAR_FIELDS)", "({ ok: true })")));
	const lateCheck = INVEST.replace("const vehicleCheck = publicFormInput.checkPublicVehicles(vehicles);", "")
		.replace("const appId = applyTx();", "const appId = applyTx();\n\t\tconst vehicleCheck = publicFormInput.checkPublicVehicles(vehicles);");
	ok("MUTANT: checking vehicles only AFTER the transaction has run is caught",
		lateCheck !== INVEST && !investWired(lateCheck));
	ok("MUTANT: dropping the banking field check from investor-apply is caught",
		!investWired(INVEST.replace("publicFormInput.checkPublicScalars(banking, PUBLIC_BANKING_SCALAR_FIELDS)", "({ ok: true })")));
	const shortList = (applyList || []).filter((f) => f !== "phone");
	ok("MUTANT: a field list missing one bound field is caught by the pin",
		!!applyList && !sameSet(shortList, bodyFields(APPLY).filter((f) => !APPLY_SERIALIZED.includes(f))));

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
