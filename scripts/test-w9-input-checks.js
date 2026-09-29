#!/usr/bin/env node
/**
 * What the investor W-9 prints is checked before it is stored or rendered.
 *
 * TIN. /invest took an EIN/SSN of any length. Ten or more digits made the W-9
 * preview answer 500, and the submitted W-9 was never produced; fewer than
 * nine printed a short number on a tax form. POST /api/public/investor-apply
 * and the W-9 preview now refuse a TIN that is not nine digits once hyphens and
 * spaces are removed, or that has any other character: 400
 * { code: "INVALID_TIN", field: "ein_ssn", error: "Enter a 9-digit SSN or EIN." }.
 * A TIN that passes is stored and printed as before.
 *
 * THE CAUSE. fillW9Form() reported every field that did not take its value as
 * "its AcroForm field names no longer match", which is what ops read in the
 * alert. A value longer than its boxes now says so; a real template mismatch
 * keeps the old message.
 *
 * WHAT IS ASSERTED.
 *   §1 checkW9Tin() (lib/w9-input.js): the accepted and refused shapes, and the
 *      length cap before a bounded pattern.
 *   §2 the client's copy (client/src/lib/taxId.js) gives the same verdict and
 *      message on every row of §1's table.
 *   §3 wiring: both routes run the check before anything is stored or
 *      rendered, and answer the 400 above; the preview checks only on the W-9.
 *   §4 the cause, from the shipped fillW9Form() run with pdf-lib on the real
 *      template: a too-long TIN, and a template field that is missing.
 *   §5 MUTANTS, one per guard, each caught.
 *
 * Test TINs only. Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-w9-input-checks.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "w9-input.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const CLIENT_PATH = path.join(ROOT, "client", "src", "lib", "taxId.js");
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }
const cp = (...points) => String.fromCodePoint(...points);

let pdfLib;
try {
	pdfLib = require("pdf-lib");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const imageLimits = require(path.join(ROOT, "lib", "image-size"));

// A (possibly mutated) copy of the lib, loaded without touching the real module.
function loadLib(src) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, require);
	return mod.exports;
}
// A (possibly mutated) copy of the client file: its exports become returns.
function loadClient(src) {
	const body = src.replace(/^export (const|function) /gm, "$1 ");
	const names = [...src.matchAll(/^export (?:const|function) ([A-Za-z_]\w*)/gm)].map((m) => m[1]);
	return new Function(`"use strict";\n${body}\nreturn { ${names.join(", ")} };`)();
}
const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// ===========================================================================
// §1 / §2 the TIN rule
// ===========================================================================
const MESSAGE = "Enter a 9-digit SSN or EIN.";
const TIN_TABLE = [
	// [label, value, accepted]
	["SSN 123-45-6789", "123-45-6789", true],
	["EIN 12-3456789", "12-3456789", true],
	["nine bare digits", "123456789", true],
	["spaces around", " 123-45-6789 ", true],
	["spaces between", "123 45 6789", true],
	["EIN with a space", "12 3456789", true],
	["other hyphen places", "1234-56789", true],
	["test TIN with zeros", "00-0000001", true],
	["ten digits (the 500)", "12-34567890", false],
	["ten bare digits", "1234567890", false],
	["eight digits (a short number)", "12-345678", false],
	["one digit", "1", false],
	["separators only", "- - -", false],
	["a letter after nine digits", "12-3456789a", false],
	["a letter in place of a digit", "12-345678x", false],
	["nine characters, one a letter", "12345678a", false],
	["a slash", "12/3456789", false],
	["a full stop", "12.3456789", false],
	["a tab", "12\t3456789", false],
	["a newline", "12-3456789\n", false],
	["a non-ASCII hyphen", `12${cp(0x2010)}3456789`, false],
	["an en dash", `12${cp(0x2013)}3456789`, false],
	["full-width digits", cp(0xff11, 0xff12, 0x2d, 0xff13, 0xff14, 0xff15, 0xff16, 0xff17, 0xff18, 0xff19), false],
	["Arabic-Indic digits", cp(0x661, 0x662, 0x663, 0x664, 0x665, 0x666, 0x667, 0x668, 0x669), false],
	["over the length cap", `${"-".repeat(24)}123456789`, false],
	["a very long value", "1".repeat(1 << 20), false],
	["a number", 123456789, false],
	["a list", ["123456789"], false],
	["an object", { tin: "123456789" }, false],
	["true", true, false],
];

function tinRows(check, verdictOf) {
	const r = [];
	for (const [label, value, accepted] of TIN_TABLE) {
		let v;
		try { v = verdictOf(check(value)); } catch (e) { v = { threw: e.message }; }
		const right = accepted ? v.ok === true : v.ok === false && v.message === MESSAGE;
		r.push({ ok: right, name: `${label}: ${accepted ? "accepted" : "refused with the message"} (got ${JSON.stringify(v)})` });
	}
	return r;
}
const serverVerdict = (x) => ({ ok: x.ok, message: x.message, code: x.code });
const clientVerdict = (x) => ({ ok: x.ok, message: x.message });

function libSection(lib = loadLib(LIB_SRC)) {
	const r = tinRows(lib.checkW9Tin, serverVerdict);
	const t = (cond, name) => r.push({ ok: !!cond, name });
	for (const [label, value, accepted] of TIN_TABLE) {
		if (accepted) {
			const v = lib.checkW9Tin(value);
			t(v.value === value, `${label}: passed through unchanged, so it is stored and printed as before`);
		} else {
			let v;
			try { v = lib.checkW9Tin(value); } catch { v = {}; }
			t(v.code === "INVALID_TIN", `${label}: code INVALID_TIN`);
		}
	}
	for (const absent of [undefined, null, ""]) {
		const v = lib.checkW9Tin(absent);
		t(v.ok === true && v.absent === true, `absent (${JSON.stringify(absent)}) passes as absent; required-ness is the caller's`);
	}
	return r;
}

function libSourceSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fn = codeOnly(LIB_SRC.slice(LIB_SRC.indexOf("function checkW9Tin("), LIB_SRC.indexOf("\n}\n", LIB_SRC.indexOf("function checkW9Tin("))));
	t(/raw\.length > TIN_MAX_LENGTH \|\| !TIN_CHARS_RE\.test\(raw\)/.test(fn), "the length cap is tested before the pattern (short-circuit order)");
	t(/^\/\^\[0-9 -\]\{1,32\}\$\/$/.test(String(loadLib(LIB_SRC).TIN_CHARS_RE)), "the pattern is one character class with a bounded quantifier");
	return r;
}

async function clientSection(src = CLIENT_SRC) {
	const r = tinRows(loadClient(src).checkTin, clientVerdict);
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const client = loadClient(src);
	const lib = loadLib(LIB_SRC);
	t(client.INVALID_TIN_MESSAGE === lib.INVALID_TIN_MESSAGE, "the client and the server say the same words");
	t(client.TIN_MAX_LENGTH === lib.TIN_MAX_LENGTH && String(client.TIN_CHARS_RE) === String(lib.TIN_CHARS_RE),
		"the client and the server use the same length cap and pattern");
	t(client.checkTin("").ok === true && client.checkTin(undefined).ok === true, "the client lets an empty field be (required-ness is the form's)");
	if (src === CLIENT_SRC) {
		const real = await import(pathToFileURL(CLIENT_PATH).href);
		t(real.checkTin("12-34567890").ok === false && real.checkTin("12-3456789").ok === true,
			"the shipped ES module loads and agrees (the copy above is not a different file)");
	}
	return r;
}

// ===========================================================================
// §3 wiring
// ===========================================================================
function routeSource(verb, routePath, src = SRC) {
	const needle = `app.${verb}("${routePath}"`;
	const at = src.indexOf(needle);
	if (at < 0) die(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = src.indexOf("(", at); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(at, j + 1); }
	}
	return die(`unbalanced parens extracting ${routePath}`);
}
function callsFirst(src, call, later) {
	const at = src.indexOf(call);
	if (at < 0) return false;
	return later.every((n) => { const i = src.indexOf(n); return i < 0 || i > at; });
}
const TIN_REFUSAL = 'return res.status(400).json({ error: tinCheck.message, code: tinCheck.code, field: "ein_ssn" });';

function applyWired(src) {
	const route = codeOnly(routeSource("post", "/api/public/investor-apply", src));
	const shape = route.indexOf("publicFormInput.checkPublicScalars(req.body, PUBLIC_INVESTOR_SCALAR_FIELDS)");
	const tin = route.indexOf("const tinCheck = w9Input.checkW9Tin(ein_ssn);");
	return shape >= 0 && tin > shape &&
		callsFirst(route, "const tinCheck = w9Input.checkW9Tin(ein_ssn);",
			["resolveInviteToken(", "db.transaction(", "applyTx()", "buildInvestorDocRender(", "sendEmail("]) &&
		route.includes(`if (!tinCheck.ok) {\n\t\t\t${TIN_REFUSAL}`);
}
function previewWired(src) {
	const route = codeOnly(routeSource("post", "/api/public/investor-preview-pdf/:docKey", src));
	const w9 = route.indexOf('if (docKey === "w9") {');
	const tin = route.indexOf("const tinCheck = w9Input.checkW9Tin(ein_ssn);");
	return w9 >= 0 && tin > w9 && tin < route.indexOf("fillW9Form(") &&
		route.indexOf("w9Input.") > route.indexOf("renderPolicy(") &&
		route.includes(`if (!tinCheck.ok) {\n\t\t\t\t${TIN_REFUSAL}`);
}
function wiringSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	t(/\nconst w9Input = require\("\.\/lib\/w9-input"\);\n/.test(SRC), "server.js loads lib/w9-input.js");
	t(applyWired(SRC), "POST /api/public/investor-apply: the TIN is checked after the scalar check and before the invite lookup, the transaction, the renders and the emails; 400 INVALID_TIN on field ein_ssn");
	t(previewWired(SRC), "POST /api/public/investor-preview-pdf/w9: the TIN is checked before fillW9Form(), in the W-9 branch only (the Master Agreement and Lease renders are not restricted); 400 INVALID_TIN on field ein_ssn");
	return r;
}

// ===========================================================================
// §4 the cause, from the shipped fillW9Form()
// ===========================================================================
function liftFunction(head, src = SRC) {
	const needle = `\n${head}`;
	if (src.split(needle).length - 1 !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return src.slice(a, end + 2);
}
const FILL_SRC = liftFunction("async function fillW9Form(");
const MISMATCH = "its AcroForm field names no longer match";

// The real pdf-lib; `missingField` makes the template lack one text field, the
// way an IRS revision that renames it would.
function build(src = FILL_SRC, { missingField } = {}) {
	const PdfLibDocument = {
		load: async (bytes) => {
			const doc = await pdfLib.PDFDocument.load(bytes);
			if (missingField) {
				const form = doc.getForm();
				const real = form.getTextField.bind(form);
				form.getTextField = (name) => { if (name === missingField) throw new Error(`no field ${name}`); return real(name); };
			}
			return doc;
		},
	};
	return new Function("path", "fs", "__dirname", "PdfLibDocument", "StandardFonts", "rgb", "imageLimits", "console",
		`"use strict";\n${src}\nreturn fillW9Form;`)(path, fs, ROOT, PdfLibDocument, pdfLib.StandardFonts, pdfLib.rgb, imageLimits,
		{ ...console, warn: () => {} });
}
const APPLICANT = { legalName: "QA-TEST Holdings LLC", entityType: "LLC", taxClassification: "C-Corp", address: "1 QA Test Way, Testville, TX 77001", einSsn: "12-3456789", effectiveDate: "September 30, 2026" };

async function outcome(fillW9Form, over) {
	const warn = console.warn;
	console.warn = () => {};
	try {
		const bytes = await fillW9Form({ ...APPLICANT, ...over });
		return { bytes: bytes ? bytes.length : 0 };
	} catch (e) {
		return { code: e.code, message: e.message };
	} finally { console.warn = warn; }
}

async function causeSection(src = FILL_SRC, { stopEarly = false } = {}) {
	const r = [];
	const t = (cond, name) => { r.push({ ok: !!cond, name }); return !!cond || !stopEarly; };
	const fill = build(src);
	const good = await outcome(fill, {});
	if (!t(good.bytes > 1000, `a nine-digit EIN renders (got ${JSON.stringify(good)})`)) return r;
	for (const [label, einSsn, entityType] of [["EIN, ten digits", "12-34567890", "LLC"], ["SSN, ten digits", "123-45-67890", "Sole Prop"], ["eleven bare digits", "12345678901", "LLC"]]) {
		const o = await outcome(fill, { einSsn, entityType });
		const right = o.code === "DOCUMENT_VALUE_TOO_LONG" && o.message.includes("Part I (TIN)") &&
			o.message.includes("longer than its boxes") && !o.message.includes(MISMATCH);
		if (!t(right, `${label}: recorded as too long for Part I, not as a template mismatch (got ${JSON.stringify(o)})`)) return r;
		t(!o.message || !o.message.includes(einSsn.replace(/\D/g, "").slice(2)), `${label}: the message carries no digits of the TIN`);
	}
	const renamed = await outcome(build(src, { missingField: "topmostSubform[0].Page1[0].f1_01[0]" }), {});
	t(renamed.code === "DOCUMENT_FIELDS_UNFILLED" && renamed.message.includes(`Line 1 (name) — ${MISMATCH}`) &&
		renamed.message.includes("rejected: topmostSubform[0].Page1[0].f1_01[0]"),
	`a real template mismatch keeps its message (got ${JSON.stringify(renamed)})`);
	const renamedTin = await outcome(build(src, { missingField: "topmostSubform[0].Page1[0].f1_15[0]" }), {});
	t(renamedTin.code === "DOCUMENT_FIELDS_UNFILLED" && renamedTin.message.includes(`Part I (TIN) — ${MISMATCH}`),
		`a missing TIN field is still a template mismatch (got ${JSON.stringify(renamedTin)})`);
	return r;
}

// ===========================================================================
// §5 mutants
// ===========================================================================
async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (rows) => rows.some((x) => !x.ok);
	t(failed(libSection(loadLib(swap(LIB_SRC, 'if (raw.replace(/[ -]/g, "").length !== TIN_DIGITS) return tinRefusal();', "")))),
		"MUTANT the nine-digit count dropped (any length accepted, the old form): caught by §1");
	t(failed(libSection(loadLib(swap(LIB_SRC, " || !TIN_CHARS_RE.test(raw)", "")))),
		"MUTANT the character check dropped (letters and other separators accepted): caught by §1");
	t(failed(libSection(loadLib(swap(LIB_SRC, 'typeof raw !== "string" || ', "")))),
		"MUTANT the string check dropped (a number or list reaches the pattern): caught by §1");
	t(failed(await clientSection(swap(CLIENT_SRC, "const TIN_DIGITS = 9", "const TIN_DIGITS = 10"))),
		"MUTANT the client's copy drifts to ten digits: caught by §2");
	t(!applyWired(swap(SRC, "const tinCheck = w9Input.checkW9Tin(ein_ssn);\n\t\tif (!tinCheck.ok) {", "const tinCheck = { ok: true };\n\t\tif (!tinCheck.ok) {")),
		"MUTANT the apply route's TIN check removed: caught by §3");
	t(!previewWired(swap(SRC, "const tinCheck = w9Input.checkW9Tin(ein_ssn);\n\t\t\tif (!tinCheck.ok) {", "const tinCheck = { ok: true };\n\t\t\tif (!tinCheck.ok) {")),
		"MUTANT the preview's TIN check removed: caught by §3");
	t(failed(await causeSection(swap(FILL_SRC, "if (max !== undefined && want.length > max) { overlongLines.push(line); return false; }", ""), { stopEarly: true })),
		"MUTANT a too-long value recorded as a template mismatch (the old cause): caught by §4");
	return r;
}

function record(rows) {
	for (const x of rows) ok(x.ok, x.name);
	console.log(`  ${rows.filter((x) => x.ok).length}/${rows.length} checks`);
}

(async () => {
	section("§1 checkW9Tin(): nine digits, hyphens and spaces only");
	record(libSection());
	record(libSourceSection());
	section("§2 the client's copy says the same");
	record(await clientSection());
	section("§3 wiring: apply and the W-9 preview refuse before storing or rendering");
	record(wiringSection());
	section("§4 fillW9Form() records the cause");
	record(await causeSection());
	section("§5 mutants");
	record(await mutantSection());
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
